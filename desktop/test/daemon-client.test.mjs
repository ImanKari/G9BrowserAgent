import assert from 'node:assert/strict';
import { suite, freePort, until, sleep } from './harness.mjs';
import { startFakeDaemon } from './fake-daemon.mjs';
import { DaemonClient, buildAdminMessage, buildCallMessage, backoffDelay, describeConnectError } from '../lib/daemon-client.mjs';

const t = suite('desktop: daemon client (role ui)');
const clients = [];
t.cleanup(() => clients.forEach((c) => c.stop()));

function client(port, opts = {}) {
  const c = new DaemonClient({ port, version: '2.0.0', backoff: { initialMs: 50, maxMs: 200 }, ...opts });
  clients.push(c);
  return c;
}

t.test('admin frames spread their args, keep the request id, and carry `args` + `entryId` for an argument named id', () => {
  const m = buildAdminMessage(7, 'schedule.remove', { id: 'sched-3' });
  assert.equal(m.type, 'admin');
  assert.equal(m.id, 7, 'the request id is never overwritten by the argument');
  assert.equal(m.op, 'schedule.remove');
  assert.equal(m.entryId, 'sched-3');
  assert.deepEqual(m.args, { id: 'sched-3' });
  const w = buildAdminMessage(8, 'watch', { tabId: 5 });
  assert.equal(w.tabId, 5, 'spread at the top level as DAEMON_PROTOCOL §6 shows');
  const s = buildAdminMessage(9, 'settings.set', { patch: { a: 1 } });
  assert.deepEqual(s.patch, { a: 1 });
  const bare = buildAdminMessage(10, 'halt');
  assert.deepEqual(bare, { type: 'admin', id: 10, op: 'halt' });
  assert.deepEqual(buildCallMessage(3, 'browser_status', null), { type: 'call', id: 3, tool: 'browser_status', args: {} });
});

t.test('call timeouts follow DAEMON_PROTOCOL §3 (floor 120 s): an engine launch waits 3 min, a CfT download 30 min', async () => {
  const { callTimeoutMs } = await import('../lib/daemon-client.mjs');
  const F = 120_000;
  assert.equal(callTimeoutMs('browser_status', {}, F), F);
  assert.equal(callTimeoutMs('browser_engine', { action: 'launch' }, F), 180_000);
  assert.equal(callTimeoutMs('browser_engine', { action: 'warm' }, F), 180_000);
  assert.equal(callTimeoutMs('browser_engine', { action: 'versions', download: true }, F), 1_800_000);
  assert.equal(callTimeoutMs('browser_engine', { action: 'list' }, F), F);
  assert.equal(callTimeoutMs('browser_recording', { action: 'replay' }, F), 1_800_000);
  assert.equal(callTimeoutMs('browser_recording', { action: 'approve' }, F), F);
  assert.equal(callTimeoutMs('browser_tabs', { action: 'open' }, F), 180_000);
  assert.equal(callTimeoutMs('browser_tabs', { action: 'wait', timeoutMs: 300_000 }, F), 315_000);
  assert.equal(callTimeoutMs('browser_navigate', { timeoutMs: 200_000 }, F), 215_000);
  assert.equal(callTimeoutMs('browser_diagnose', { what: 'performance', durationMs: 90_000 }, F), 150_000);
  assert.equal(callTimeoutMs('browser_diagnose', { action: 'performance', durationMs: 90_000 }, F), F, 'the tool has no action: what decides, as in the daemon');
  assert.equal(callTimeoutMs('browser_network', { action: 'wait_download', timeoutMs: 600_000 }, F), 615_000);
  assert.equal(callTimeoutMs('browser_engine', { action: 'launch' }, 400_000), 400_000, 'G9_TIMEOUT_MS stays the floor');
});

t.test('backoff doubles from 500 ms and caps at 15 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n)), [500, 1000, 2000, 4000, 8000, 15000, 15000]);
});

t.test('connect: hello as role ui with version and client name; welcome fills the state', async () => {
  const port = await freePort();
  const d = await startFakeDaemon({ port, welcome: { halted: { global: true, by: 'panel' } } });
  t.cleanup(() => d.close());
  const c = client(port);
  c.start();
  const w = await c.whenConnected(5000);
  assert.equal(w.type, 'welcome');
  const hello = d.received.find((m) => m.type === 'hello');
  assert.equal(hello.role, 'ui');
  assert.equal(hello.version, '2.0.0');
  assert.equal(hello.client.name, 'g9-desktop');
  assert.equal(hello.client.pid, process.pid);
  const s = c.state;
  assert.equal(s.status, 'connected');
  assert.equal(s.daemonVersion, '2.0.0');
  assert.equal(s.daemonPid, process.pid);
  assert.deepEqual(s.halted, { global: true, by: 'panel' });
  c.stop();
});

t.test('admin and call resolve with the result; a daemon error rejects with its message', async () => {
  const port = await freePort();
  const d = await startFakeDaemon({
    port,
    admin: {
      'settings.get': () => ({ humanize: 'human', idleExitMinutes: 60 }),
      'schedule.remove': (m) => ({ removed: m.args.id, top: m.entryId }),
      halt: () => { throw new Error('nope'); },
    },
  });
  t.cleanup(() => d.close());
  const c = client(port);
  c.start();
  await c.whenConnected();
  assert.deepEqual(await c.admin('settings.get'), { humanize: 'human', idleExitMinutes: 60 });
  assert.deepEqual(await c.admin('schedule.remove', { id: 's1' }), { removed: 's1', top: 's1' });
  await assert.rejects(c.admin('halt'), /nope/);
  const r = await c.call('browser_tabs', { action: 'list' });
  assert.deepEqual(r, { echo: 'browser_tabs', args: { action: 'list' } });
  c.stop();
});

t.test('events fan out; a halt event updates state.halted; a 2 MiB fragmented frame arrives whole', async () => {
  const port = await freePort();
  const d = await startFakeDaemon({ port });
  t.cleanup(() => d.close());
  const c = client(port);
  const events = [];
  c.on('event', (e) => events.push(e));
  c.start();
  await c.whenConnected();
  d.event('agents', { agents: [{ id: 'agent-1', name: 'claude-code', owned: [3] }] });
  d.event('halt', { halted: true, by: 'desktop' });
  const data = 'A'.repeat(2 * 1024 * 1024);
  d.event('frame', { tabId: 3, data, metadata: { deviceWidth: 1280 } }, { fragments: 5 });
  await until(() => events.length >= 3, { what: 'three events' });
  assert.equal(events[0].topic, 'agents');
  assert.equal(events[1].topic, 'halt');
  assert.equal(c.state.halted.global, true);
  assert.equal(events[2].data.data.length, data.length);
  c.stop();
});

t.test('the daemon pinging the desktop gets a pong', async () => {
  const port = await freePort();
  const d = await startFakeDaemon({ port });
  t.cleanup(() => d.close());
  const c = client(port);
  c.start();
  await c.whenConnected();
  d.sendRaw({ type: 'ping', at: 42 });
  await until(() => d.received.some((m) => m.type === 'pong' && m.at === 42), { what: 'pong' });
  c.stop();
});

t.test('a call that never answers times out with the tool name', async () => {
  const port = await freePort();
  const d = await startFakeDaemon({ port, admin: { 'runs.get': () => '__never__' } });
  t.cleanup(() => d.close());
  const c = client(port);
  c.start();
  await c.whenConnected();
  await assert.rejects(c.admin('runs.get', { runId: 'r1' }, { timeoutMs: 150 }), /admin runs\.get timed out/);
  c.stop();
});

t.test('a dropped connection rejects pending calls and reconnects with backoff', async () => {
  const port = await freePort();
  const d = await startFakeDaemon({ port, admin: { 'runs.get': () => '__never__' } });
  t.cleanup(() => d.close());
  const c = client(port);
  const statuses = [];
  c.on('state', (s) => statuses.push(s.status));
  c.start();
  await c.whenConnected();
  const pending = c.admin('runs.get', { runId: 'r' });
  d.dropAll();
  await assert.rejects(pending, /connection closed/);
  await until(() => c.state.status === 'connected' && d.peers.size === 1, { what: 'reconnect' });
  assert.ok(statuses.includes('waiting'), 'went through the backoff state');
  assert.equal(d.received.filter((m) => m.type === 'hello').length, 2);
  c.stop();
});

t.test('calls while disconnected fail at once with the reason', async () => {
  const port = await freePort();
  const c = client(port);
  await assert.rejects(c.call('browser_status'), /not connected on port/);
});

t.test('nothing listening → onRefused is asked; when it launches, the client waits in "starting" and connects', async () => {
  const port = await freePort();
  let asked = 0;
  let daemon = null;
  const c = client(port, {
    onRefused: async () => {
      asked++;
      // Simulate a daemon that takes a moment to bind its port.
      setTimeout(async () => { daemon = await startFakeDaemon({ port }); }, 300);
      return { launched: true, pid: 999 };
    },
  });
  const statuses = [];
  c.on('state', (s) => statuses.push(s.status));
  c.start();
  await c.whenConnected(8000);
  t.cleanup(() => daemon?.close());
  assert.equal(asked, 1, 'launched once, not once per retry');
  assert.ok(statuses.includes('starting'));
  c.stop();
});

t.test('welcome.problem → "refused", and no reconnect until reconnectNow()', async () => {
  const port = await freePort();
  const d = await startFakeDaemon({ port, welcome: { problem: 'This daemon is 3.0.0; update G9BrowserAgent.' } });
  t.cleanup(() => d.close());
  const c = client(port);
  c.start();
  await until(() => c.state.status === 'refused', { what: 'refused' });
  assert.match(c.state.error, /3\.0\.0/);
  const hellos = () => d.received.filter((m) => m.type === 'hello').length;
  await sleep(400);
  assert.equal(hellos(), 1, 'stays put after a refusal');
  c.reconnectNow();
  await until(() => hellos() === 2, { what: 'second hello' });
  c.stop();
});

t.test('a port that refuses the upgrade and is not g9d → "foreign", never hammered', async () => {
  const port = await freePort();
  const d = await startFakeDaemon({ port, refuseUpgrade: 426 });
  t.cleanup(() => d.close());
  const c = client(port, { onUpgradeRefused: async () => ({ kind: 'v1-bridge', message: 'Port is held by a v1 G9BrowserAgent bridge' }) });
  c.start();
  await until(() => c.state.status === 'foreign', { what: 'foreign' });
  assert.match(c.state.error, /v1 G9BrowserAgent bridge/);
  c.stop();
});

t.test('reconnectNow() while the onRefused hook is still awaiting → one socket, never an orphaned second one', async () => {
  const port = await freePort();
  let release;
  const gate = new Promise((r) => { release = r; });
  let asked = 0;
  const c = client(port, {
    onRefused: async () => {
      asked++;
      if (asked === 1) await gate; // the first probe is slow (a /health that hangs)
      return { launched: false };
    },
  });
  c.start();
  await until(() => asked === 1, { what: 'first onRefused' });
  // Meanwhile a daemon comes up and the person presses Reconnect.
  const d = await startFakeDaemon({ port });
  t.cleanup(() => d.close());
  c.reconnectNow();
  await c.whenConnected(5000);
  // Now the stale hook returns: it must not schedule another connect.
  release();
  await sleep(700);
  assert.equal(d.peers.size, 1, 'exactly one ui socket');
  assert.equal(d.received.filter((m) => m.type === 'hello').length, 1, 'one hello');
  assert.equal(c.state.status, 'connected');
  c.stop();
  // stop() while a hook is awaiting: nothing reconnects afterwards.
  let release2;
  const gate2 = new Promise((r) => { release2 = r; });
  const port2 = await freePort();
  const c2 = client(port2, { onRefused: async () => { await gate2; return { launched: true }; } });
  c2.start();
  await sleep(150);
  c2.stop();
  release2();
  await sleep(500);
  assert.equal(c2.state.status, 'stopped', 'a late hook does not revive a stopped client');
});

t.test('describeConnectError names the port and the cause', () => {
  assert.match(describeConnectError({ code: 'ECONNREFUSED' }, 18001), /Nothing is listening on 127\.0\.0\.1:18001/);
  assert.match(describeConnectError({ code: 'EUPGRADE', status: 403 }, 18001), /HTTP 403/);
});

t.run();
