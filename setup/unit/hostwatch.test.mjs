/**
 * Host watch (daemon/hostwatch.js, 3.8.7): the local servers the agents use are found from their URLs,
 * the listening process is read from each platform's own tools, and a process over the limit or growing
 * too fast becomes a warning once — a dev server whose watcher looped once grew to 109 GB of commit.
 */

import assert from 'node:assert/strict';

import { HostWatch, loopbackPort, growthPerHour, parseNetstat, parseTasklist, parseSs, parseLsof } from '../../daemon/hostwatch.js';
import { Settings, validateSettings, DEFAULTS, mergeSettings } from '../../daemon/settings.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('only loopback http(s) URLs name a port', () => {
  assert.equal(loopbackPort('http://localhost:5173/console'), 5173);
  assert.equal(loopbackPort('http://127.0.0.1:8080'), 8080);
  assert.equal(loopbackPort('https://[::1]:4443/x'), 4443);
  assert.equal(loopbackPort('http://localhost/'), 80);
  assert.equal(loopbackPort('https://example.com:5173/'), null);
  assert.equal(loopbackPort('chrome://newtab'), null);
  assert.equal(loopbackPort(undefined), null);
});

test('netstat: listening sockets only, whatever the language of the state column', () => {
  const text = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:5173         0.0.0.0:0              ABHÖREN         54280',
    '  TCP    127.0.0.1:5173         127.0.0.1:61000        ESTABLISHED     54280',
    '  TCP    127.0.0.1:61000        127.0.0.1:5173         ESTABLISHED     999',
    '  TCP    [::]:8080              [::]:0                 LISTENING       42',
    '  UDP    0.0.0.0:5353           *:*                                    7',
  ].join('\r\n');
  const found = parseNetstat(text, new Set([5173, 8080, 61000]));
  assert.deepEqual([...found], [[5173, 54280], [8080, 42]]);
});

test('tasklist: the memory digits in any locale', () => {
  const procs = parseTasklist('"node.exe","54280","Console","1","1,706,123 K"\r\n"x.exe","42","Services","0","12.345 K"\r\n');
  assert.deepEqual(procs.get(54280), { name: 'node.exe', mb: 1666 });
  assert.deepEqual(procs.get(42), { name: 'x.exe', mb: 12 });
});

test('ss and lsof name the listening process', () => {
  const ss = 'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=1234,fd=20))\nLISTEN 0 4096 [::]:22 [::]:* users:(("sshd",pid=9,fd=3))';
  assert.deepEqual(parseSs(ss, new Set([5173])).get(5173), { pid: 1234, name: 'node' });
  const lsof = 'p1234\ncnode\nf20\nn127.0.0.1:5173\np77\ncsshd\nn*:22\n';
  assert.deepEqual(parseLsof(lsof, new Set([5173, 22])).get(5173), { pid: 1234, name: 'node' });
  assert.deepEqual(parseLsof(lsof, new Set([5173, 22])).get(22), { pid: 77, name: 'sshd' });
});

test('growth is judged over ten minutes or more', () => {
  const t0 = 1_000_000;
  assert.equal(growthPerHour([{ at: t0, mb: 1000 }, { at: t0 + 5 * 60_000, mb: 1500 }], t0 + 5 * 60_000), null);
  assert.equal(Math.round(growthPerHour([{ at: t0, mb: 1000 }, { at: t0 + 10 * 60_000, mb: 2000 }], t0 + 10 * 60_000)), 6000);
});

function harness({ limitMb = 4096, growthMbPerHour = 2048, servers = new Map(), self = 200 } = {}) {
  let now = 1_000_000;
  const logs = [];
  const probed = [];
  const watch = new HostWatch({
    settings: () => ({ limitMb, growthMbPerHour }),
    log: (line) => logs.push(line),
    probe: async (ports) => { probed.push([...ports]); return new Map([...servers].filter(([p]) => ports.has(p))); },
    selfMb: () => self,
    now: () => now,
  });
  return { watch, logs, probed, servers, advance: (ms) => { now += ms; } };
}

test('nothing is probed until an agent used a local server', async () => {
  const h = harness();
  h.watch.note('https://example.com/');
  await h.watch.tick();
  assert.deepEqual(h.probed, []);
  assert.deepEqual(h.watch.warnings(), []);
  h.watch.note('http://localhost:5173/');
  await h.watch.tick();
  assert.deepEqual(h.probed, [[5173]]);
});

test('a server growing 6 GB an hour is warned about once, then again only after it recovered', async () => {
  const h = harness();
  h.watch.note('http://127.0.0.1:5173/console');
  const at = (mb) => h.servers.set(5173, { pid: 54280, name: 'node.exe', mb });
  for (let i = 0; i <= 6; i += 1) {
    at(1500 + i * 200); // 200 MB every 2 minutes
    await h.watch.tick();
    h.advance(120_000);
  }
  const [w] = h.watch.warnings();
  assert.equal(w.port, 5173);
  assert.equal(w.level, 'growing');
  assert.equal(w.growthMbPerHour, 6000);
  assert.match(w.note, /node\.exe \(pid 54280\), the server on port 5173 uses 2\.6 GB, growing 5\.9 GB an hour/);
  assert.match(w.note, /server\.watch\.ignored/);
  const gen = h.watch.generation;
  assert.equal(h.logs.length, 1);
  at(2900);
  await h.watch.tick();
  assert.equal(h.watch.generation, gen, 'the same warning is not raised again');
  // Restarted: another pid starts a new history, no warning.
  h.servers.set(5173, { pid: 777, name: 'node.exe', mb: 300 });
  h.advance(120_000);
  await h.watch.tick();
  assert.deepEqual(h.watch.warnings(), []);
});

test('over the limit is warned at once; the daemon watches itself; 0 and 0 turn it off', async () => {
  const h = harness({ servers: new Map([[3000, { pid: 5, name: 'node.exe', mb: 5000 }]]), self: 6000 });
  h.watch.note('http://localhost:3000');
  await h.watch.tick();
  const levels = h.watch.warnings().map((w) => [w.name, w.level]);
  assert.deepEqual(levels.sort(), [['node.exe', 'over'], ['the G9BrowserAgent daemon', 'over']]);
  const off = harness({ limitMb: 0, growthMbPerHour: 0, self: 99_999 });
  off.watch.note('http://localhost:3000');
  await off.watch.tick();
  assert.deepEqual(off.probed, []);
  assert.deepEqual(off.watch.warnings(), []);
});

test('settings: hostWatch defaults, validation and a one-level merge', () => {
  assert.deepEqual({ ...DEFAULTS.hostWatch }, { limitMb: 4096, growthMbPerHour: 2048 });
  const merged = mergeSettings(DEFAULTS, { hostWatch: { limitMb: 0 } });
  assert.deepEqual(merged.hostWatch, { limitMb: 0, growthMbPerHour: 2048 });
  assert.deepEqual(validateSettings(merged), []);
  assert.ok(validateSettings(mergeSettings(DEFAULTS, { hostWatch: { limitMb: -1 } })).some((p) => p.startsWith('hostWatch.limitMb')));
  assert.ok(validateSettings(mergeSettings(DEFAULTS, { hostWatch: 5 })).some((p) => p.startsWith('hostWatch must')));
  assert.equal(typeof Settings, 'function');
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}\n${err?.stack ?? err}`);
    process.exit(1);
  }
}
