import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { suite, freePort, tmpDir, rmrf } from './harness.mjs';
import { startFakeDaemon } from './fake-daemon.mjs';
import {
  daemonCommand, probeHealth, describeForeign, DaemonLauncher, daemonActivity, isRunActive, runsFrom, restartDaemonIfIdle,
  activityFromHealth, queryActivity, mismatchAction, compareVersions,
} from '../lib/daemon-launch.mjs';

const t = suite('desktop: starting and restarting the daemon');
const root = tmpDir();
t.cleanup(() => rmrf(root));
fs.mkdirSync(path.join(root, 'daemon'), { recursive: true });
fs.writeFileSync(path.join(root, 'daemon', 'g9d.mjs'), '// fake\n');

t.test('packaged: G9BrowserAgent.exe runs the daemon script with ELECTRON_RUN_AS_NODE=1', () => {
  const cmd = daemonCommand({ isPackaged: true, execPath: 'C:\\Users\\qa\\AppData\\Local\\Programs\\G9BrowserAgent\\G9BrowserAgent.exe', resourceRoot: root, env: { PATH: 'x' }, port: 18123, home: 'D:\\g9home' });
  assert.equal(cmd.command, 'C:\\Users\\qa\\AppData\\Local\\Programs\\G9BrowserAgent\\G9BrowserAgent.exe');
  assert.deepEqual(cmd.args, [path.join(root, 'daemon', 'g9d.mjs')]);
  assert.equal(cmd.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(cmd.env.G9_PORT, '18123');
  assert.equal(cmd.env.G9_HOME, 'D:\\g9home');
  assert.equal(cmd.cwd, root);
});

t.test('dev: node + repo daemon, and an inherited ELECTRON_RUN_AS_NODE is dropped', () => {
  const cmd = daemonCommand({ isPackaged: false, execPath: 'electron.exe', resourceRoot: root, env: { ELECTRON_RUN_AS_NODE: '1', KEEP: 'y' } });
  assert.equal(cmd.command, 'node');
  assert.equal(cmd.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(cmd.env.KEEP, 'y');
  assert.equal(cmd.env.G9_PORT, undefined, 'no port override unless given');
});

t.test('probeHealth: none / g9d / foreign (a v1 bridge answers /health without name:"g9d")', async () => {
  const p1 = await freePort();
  assert.equal((await probeHealth(p1)).status, 'none');
  const d = await startFakeDaemon({ port: p1 });
  const h1 = await probeHealth(p1);
  assert.equal(h1.status, 'g9d');
  assert.equal(h1.body.version, '2.0.0');
  await d.close();

  const p2 = await freePort();
  const v1 = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, extensionConnected: true, version: '1.7.21', pid: 4321 }));
  });
  await new Promise((r) => v1.listen(p2, '127.0.0.1', r));
  const h2 = await probeHealth(p2);
  assert.equal(h2.status, 'foreign');
  const f = describeForeign(h2, p2);
  assert.equal(f.kind, 'v1-bridge');
  assert.match(f.message, /v1 G9BrowserAgent bridge \(version 1\.7\.21, pid 4321\)/);
  assert.match(f.message, /G9BrowserAgent will not stop it/);
  await new Promise((r) => v1.close(r));
});

t.test('DaemonLauncher: spawns once when nothing listens, then respects the cooldown', async () => {
  const spawned = [];
  const fakeSpawn = (command, args, opts) => {
    spawned.push({ command, args, opts });
    return { pid: 777, on() {}, unref() {} };
  };
  let now = 1000;
  const l = new DaemonLauncher({
    commandOptions: { isPackaged: true, execPath: 'G9BrowserAgent.exe', resourceRoot: root },
    port: 18555,
    spawn: fakeSpawn,
    probe: async () => ({ status: 'none' }),
    now: () => now,
    cooldownMs: 20_000,
  });
  assert.deepEqual(await l.onRefused(), { launched: true, pid: 777 });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].opts.detached, true, 'the daemon outlives the desktop');
  assert.equal(spawned[0].opts.windowsHide, true);
  assert.equal(spawned[0].opts.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spawned[0].opts.env.G9_PORT, '18555');
  now += 5000;
  assert.deepEqual(await l.onRefused(), { launched: false }, 'no spawn storm');
  now += 20_000;
  assert.equal((await l.onRefused()).launched, true);
  l.resetCooldown();
  assert.equal((await l.onRefused()).launched, true, 'resetCooldown allows an immediate relaunch');
});

t.test('DaemonLauncher: a foreign listener is reported, never spawned over; disabled means no spawn', async () => {
  let spawns = 0;
  const l = new DaemonLauncher({
    commandOptions: { isPackaged: false, execPath: 'x', resourceRoot: root },
    port: 18556,
    spawn: () => { spawns++; return { pid: 1, on() {}, unref() {} }; },
    probe: async () => ({ status: 'foreign', httpStatus: 200, body: { ok: true, extensionConnected: false, version: '1.7.21' } }),
  });
  const r = await l.onRefused();
  assert.equal(r.foreign.kind, 'v1-bridge');
  assert.equal(spawns, 0);
  const off = new DaemonLauncher({ commandOptions: { isPackaged: false, execPath: 'x', resourceRoot: root }, port: 18557, spawn: () => { spawns++; }, probe: async () => ({ status: 'none' }), enabled: () => false });
  assert.deepEqual(await off.onRefused(), { launched: false });
  assert.equal(spawns, 0);
});

t.test('DaemonLauncher: hold() after a deliberate shutdown → no spawn, the reason is returned; release() spawns again', async () => {
  let spawns = 0;
  const l = new DaemonLauncher({
    commandOptions: { isPackaged: false, execPath: 'x', resourceRoot: root },
    port: 18559,
    spawn: () => { spawns++; return { pid: 5, on() {}, unref() {} }; },
    probe: async () => ({ status: 'none' }),
    cooldownMs: 0,
  });
  l.hold('shut down on purpose');
  assert.deepEqual(await l.onRefused(), { launched: false, held: 'shut down on purpose' });
  assert.equal(spawns, 0, '"Shut down" must not mean "restart"');
  l.release();
  assert.equal((await l.onRefused()).launched, true);
  assert.equal(spawns, 1);
});

t.test('DaemonLauncher: a refusal that arrived while held never spawns, even when release() lands during its probe', async () => {
  let spawns = 0;
  let releaseProbe;
  const probeGate = new Promise((r) => { releaseProbe = r; });
  const l = new DaemonLauncher({
    commandOptions: { isPackaged: false, execPath: 'x', resourceRoot: root },
    port: 18560,
    spawn: () => { spawns++; return { pid: 6, on() {}, unref() {} }; },
    probe: async () => { await probeGate; return { status: 'none' }; },
    cooldownMs: 0,
  });
  l.hold('shut down on purpose');
  const stale = l.onRefused();
  l.release(); // the person pressed Reconnect while that refusal was being looked at
  releaseProbe();
  assert.deepEqual(await stale, { launched: false, held: 'shut down on purpose' });
  assert.equal(spawns, 0, 'the stale refusal starts nothing; the reconnect\'s own refusal decides');
  assert.equal((await l.onRefused()).launched, true);
  assert.equal(spawns, 1);
});

t.test('a held launcher: the client keeps looking (waiting) and shows why, instead of starting g9d', async () => {
  const { DaemonClient } = await import('../lib/daemon-client.mjs');
  const port = await freePort();
  const l = new DaemonLauncher({ commandOptions: { isPackaged: false, execPath: 'x', resourceRoot: root }, port, spawn: () => { throw new Error('must not spawn'); } });
  l.hold('The daemon was shut down from this app.');
  const c = new DaemonClient({ port, version: '2.0.0', onRefused: () => l.onRefused(), backoff: { initialMs: 50, maxMs: 100 } });
  c.start();
  const { until } = await import('./harness.mjs');
  await until(() => c.state.status === 'waiting' && /shut down from this app/.test(c.state.error ?? ''), { what: 'held state' });
  c.stop();
});

t.test('DaemonLauncher: a missing daemon script is an error, not a silent no-op', async () => {
  const empty = tmpDir();
  const l = new DaemonLauncher({ commandOptions: { isPackaged: false, execPath: 'x', resourceRoot: empty }, port: 18558, spawn: () => ({}), probe: async () => ({ status: 'none' }) });
  await assert.rejects(l.onRefused(), /daemon script is missing/);
  rmrf(empty);
});

t.test('a version mismatch: only an OLDER daemon of this install is restarted', async () => {
  // It used to restart on any difference: a 2.0.1 daemon from a repository checkout (started by its
  // own shim) was shut down and replaced by this app's older one — and with "Start the daemon" off
  // it was shut down and nothing started (desktop review, 2026-09-22).
  const app = { appVersion: '2.0.0', appRoot: 'C:/Program Files/G9BrowserAgent/resources', platform: 'win32' };
  assert.equal(mismatchAction({ daemonVersion: '2.0.0', ...app }), 'none');
  assert.equal(mismatchAction({ daemonVersion: null, ...app }), 'none');
  assert.equal(mismatchAction({ daemonVersion: '1.9.9', daemonRoot: 'C:/Program Files/G9BrowserAgent/resources', ...app }), 'restart');
  assert.equal(mismatchAction({ daemonVersion: '1.9.9', daemonRoot: 'c:\\Program Files\\G9BrowserAgent\\resources\\', ...app }), 'restart', 'the same root, spelled another way');
  assert.equal(mismatchAction({ daemonVersion: '1.9.9', ...app }), 'restart', 'a daemon that does not say where it lives is ours');
  assert.equal(mismatchAction({ daemonVersion: '2.0.1', daemonRoot: 'C:/Program Files/G9BrowserAgent/resources', ...app }), 'notice-newer');
  assert.equal(mismatchAction({ daemonVersion: '1.9.9', daemonRoot: 'G:/Projects/g9-browser-agent', ...app }), 'notice-other-install');
  assert.equal(mismatchAction({ daemonVersion: '1.9.9', daemonRoot: app.appRoot, startDaemon: false, ...app }), 'notice-no-autostart');
  assert.equal(compareVersions('2.0.1', '2.0.0'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.10'), -1, 'numeric, not string, order');
  assert.equal(compareVersions('2.0.0-beta.1', '2.0.0'), -1, 'a prerelease is older');
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);

  // And a daemon this app will not start again is never shut down.
  const client = { admin: async () => { throw new Error('should not be asked'); }, call: async () => { throw new Error('nope'); } };
  const r = await restartDaemonIfIdle(client, { enabled: () => false, port: 18999 }, { reason: 'test' });
  assert.equal(r.restarted, false);
  assert.match(r.activity.reasons[0], /does not start the daemon/);
});

t.test('run activity: status words, and "started with no end and no verdict" counts as active', () => {
  assert.equal(isRunActive({ status: 'running' }), true);
  assert.equal(isRunActive({ status: 'done' }), false);
  assert.equal(isRunActive({ startedAt: 1 }), true);
  assert.equal(isRunActive({ startedAt: 1, endedAt: 2 }), false);
  assert.equal(isRunActive({ startedAt: 1, verdict: 'PASS' }), false);
  assert.deepEqual(runsFrom({ runs: [1] }), [1]);
  assert.deepEqual(runsFrom([2]), [2]);
  assert.deepEqual(runsFrom(null), []);
});

t.test('run activity: g9d runs.list rows (`active`, `finishedAt`) are read as the daemon states them', () => {
  // Exactly the row daemon/evidence.js list() writes for a finished watch session: no verdict, no
  // endedAt. Before `active` was honoured this read as "in progress" and deferred every update.
  const finishedWatch = { runId: '20260921-101010-watch-ab12', kind: 'watch', label: 'tab 3', startedAt: 1, finishedAt: 2, active: false, ok: true, verdict: null, exitCode: null, frames: 12 };
  assert.equal(isRunActive(finishedWatch), false);
  assert.equal(isRunActive({ ...finishedWatch, kind: 'replay', active: true, finishedAt: null }), true);
  assert.equal(isRunActive({ startedAt: 1, finishedAt: 2 }), false, 'finishedAt ends a run too');
  assert.equal(isRunActive({ active: false, status: 'running' }), false, 'the daemon\'s own flag wins');
});

t.test('daemonActivity: busy with an active run or a launched engine; idle otherwise', () => {
  assert.equal(daemonActivity({ runs: [{ status: 'done' }], engines: [] }).busy, false);
  // An open watch run is this app's own live view: it never blocks an update.
  assert.equal(daemonActivity({ runs: [{ runId: 'w', kind: 'watch', active: true }], engines: [] }).busy, false);
  assert.equal(daemonActivity({ runs: [{ runId: 's', kind: 'schedule', active: true }], engines: [] }).busy, true);
  const a = daemonActivity({ runs: [{ runId: 'r1', status: 'running' }], engines: [] });
  assert.equal(a.busy, true);
  assert.deepEqual(a.activeRuns, ['r1']);
  const b = daemonActivity({ runs: [], engines: [{ kind: 'launched' }, { kind: 'extension' }] });
  assert.equal(b.busy, true);
  assert.match(b.reasons[0], /1 launched engine would be closed/);
});

t.test('F6: a daemon this app is not connected to is judged from /health activeRuns + launched; an older one counts as busy', () => {
  assert.equal(activityFromHealth({ name: 'g9d', activeRuns: [], launched: 0 }).busy, false);
  assert.equal(activityFromHealth({ name: 'g9d', activeRuns: [{ runId: 'w1', kind: 'watch', startedAt: 1 }], launched: 0 }).busy, false, 'a live view never blocks');
  const run = activityFromHealth({ name: 'g9d', activeRuns: [{ runId: 's1', kind: 'schedule', startedAt: 1 }], launched: 0 });
  assert.equal(run.busy, true);
  assert.deepEqual(run.activeRuns, ['s1']);
  const eng = activityFromHealth({ name: 'g9d', activeRuns: [], launched: 2 });
  assert.equal(eng.busy, true);
  assert.match(eng.reasons[0], /2 launched engines would be closed/);
  const old = activityFromHealth({ name: 'g9d', version: '2.0.0' });
  assert.equal(old.busy, true, 'no activeRuns in /health: never guess idle');
  assert.match(old.reasons[0], /does not list its runs/);
});

t.test('F6: queryActivity asks runs.list for {active:true} — every open run, not the newest 50', async () => {
  const asked = [];
  const client = {
    admin: async (op, args) => { asked.push([op, args]); return { runs: [{ runId: 'old-schedule', kind: 'schedule', active: true }] }; },
    call: async () => ({ engines: [] }),
  };
  const a = await queryActivity(client);
  assert.deepEqual(asked, [['runs.list', { active: true }]]);
  assert.equal(a.busy, true);
  assert.deepEqual(a.activeRuns, ['old-schedule']);
});

t.test('restartDaemonIfIdle: busy → deferred and no shutdown; idle → shutdown, wait, relaunch', async () => {
  const calls = [];
  const busyClient = {
    admin: async (op) => { calls.push(op); return op === 'runs.list' ? { runs: [{ status: 'running', runId: 'r9' }] } : {}; },
    call: async () => ({ engines: [] }),
    reconnectNow: () => calls.push('reconnect'),
  };
  const launcher = { port: await freePort(), resetCooldown: () => calls.push('reset') };
  const r1 = await restartDaemonIfIdle(busyClient, launcher);
  assert.equal(r1.restarted, false);
  assert.ok(!calls.includes('shutdown'), 'never shuts down a busy daemon');

  calls.length = 0;
  const idleClient = { ...busyClient, admin: async (op) => { calls.push(op); return op === 'runs.list' ? [] : {}; } };
  const r2 = await restartDaemonIfIdle(idleClient, launcher);
  assert.equal(r2.restarted, true);
  assert.deepEqual(calls, ['runs.list', 'shutdown', 'reset', 'reconnect']);
});

t.test('restartDaemonIfIdle: a daemon that cannot report its runs counts as busy (never guess idle)', async () => {
  const c = { admin: async () => { throw new Error('gone'); }, call: async () => [], reconnectNow() {} };
  const r = await restartDaemonIfIdle(c, { port: 1, resetCooldown() {} });
  assert.equal(r.restarted, false);
  assert.match(r.activity.reasons[0], /did not report its runs/);
});

t.test('Linux AppImage: the daemon is started from the .AppImage file and the stable bootstrap, never from the temporary mount', () => {
  const mount = '/tmp/.mount_G9x1y2';
  const cmd = daemonCommand({
    isPackaged: true, execPath: `${mount}/g9`, resourceRoot: `${mount}/resources`, env: { PATH: '/usr/bin' }, port: 18123, home: '/home/qa/.g9',
    appImage: { file: '/home/qa/Apps/G9BrowserAgent.AppImage', bootstrap: '/home/qa/.g9/bin/g9-run.mjs' },
  });
  assert.equal(cmd.command, '/home/qa/Apps/G9BrowserAgent.AppImage');
  assert.deepEqual(cmd.args, ['/home/qa/.g9/bin/g9-run.mjs', 'daemon/g9d.mjs', '--no-sandbox'], 'the flag AFTER the script: AppRun would put it before, where Node rejects it');
  assert.equal(cmd.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(cmd.env.G9_PORT, '18123');
  assert.ok(![cmd.command, ...cmd.args, cmd.cwd].some((x) => x.includes('.mount_')), 'nothing that disappears when this app quits');
});

t.test('mismatch: a stable install id beats the resource root (an AppImage mounts somewhere new on every start)', () => {
  const base = { daemonVersion: '3.0.9', appVersion: '3.1.0', startDaemon: true, platform: 'linux' };
  // Same .AppImage, two different mounts: this install's old daemon → restart it.
  assert.equal(mismatchAction({ ...base, daemonRoot: '/tmp/.mount_G9aaaa/resources', appRoot: '/tmp/.mount_G9bbbb/resources', daemonInstall: '/home/qa/G9BrowserAgent.AppImage', appInstall: '/home/qa/G9BrowserAgent.AppImage' }), 'restart');
  // Without the ids, the two mounts look like two installs.
  assert.equal(mismatchAction({ ...base, daemonRoot: '/tmp/.mount_G9aaaa/resources', appRoot: '/tmp/.mount_G9bbbb/resources' }), 'notice-other-install');
  // Another install really is another install.
  assert.equal(mismatchAction({ ...base, daemonInstall: '/opt/G9BrowserAgent/resources', appInstall: '/home/qa/G9BrowserAgent.AppImage' }), 'notice-other-install');
});

t.run();
