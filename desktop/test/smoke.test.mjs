import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { suite, freePort, tmpDir, rmrf } from './harness.mjs';
import { startFakeDaemon } from './fake-daemon.mjs';
import { runSmoke } from '../lib/smoke.mjs';

const t = suite('desktop: --smoke (no windows: hello + settings.get, one JSON line)');
const main = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.mjs');
const APP_VERSION = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
const home = tmpDir();
t.cleanup(() => rmrf(home));

function runMain(port, extra = []) {
  return new Promise((resolve) => {
    const env = { ...process.env, G9_PORT: String(port), G9_HOME: home };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [main, '--smoke', ...extra], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

t.test('against a daemon: exit 0 and JSON with the welcome and the settings', async () => {
  const port = await freePort();
  const d = await startFakeDaemon({ port, admin: { 'settings.get': () => ({ humanize: 'human', idleExitMinutes: 60 }) } });
  t.cleanup(() => d.close());
  const r = await runMain(port);
  assert.equal(r.code, 0, r.err || r.out);
  const lines = r.out.trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one line of JSON');
  const j = JSON.parse(lines[0]);
  assert.equal(j.ok, true);
  assert.equal(j.port, port);
  // The app's own version comes from desktop/package.json and is bumped on every change, so it is
  // read, never pinned. The welcome's version is the FAKE daemon's constant (fake-daemon.mjs).
  assert.equal(j.version, APP_VERSION);
  assert.equal(j.welcome.version, '2.0.0');
  assert.deepEqual(j.settings, { humanize: 'human', idleExitMinutes: 60 });
  const hello = d.received.find((m) => m.type === 'hello');
  assert.equal(hello.role, 'ui');
  assert.equal(hello.client.name, 'g9-desktop-smoke');
  assert.ok(d.received.some((m) => m.type === 'admin' && m.op === 'settings.get'));
});

t.test('nothing listening: exit 1 fast, the reason in the JSON, and no daemon started', async () => {
  const port = await freePort();
  const started = Date.now();
  const r = await runMain(port);
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out.trim());
  assert.equal(j.ok, false);
  assert.match(j.error, /Nothing is listening on 127\.0\.0\.1:\d+/);
  assert.equal(j.launched, false);
  assert.ok(Date.now() - started < 10_000, 'fails fast instead of sitting in backoff');
});

t.test('a v1 bridge on the port is named and left alone', async () => {
  const port = await freePort();
  const d = await startFakeDaemon({ port, refuseUpgrade: 426, health: { ok: true, extensionConnected: true, version: '1.7.21', pid: 999 } });
  t.cleanup(() => d.close());
  const r = await runSmoke({ port, version: '2.0.0' });
  assert.equal(r.ok, false);
  assert.match(r.error, /v1 G9BrowserAgent bridge \(version 1\.7\.21, pid 999\)/);
});

t.test('a refusing daemon (welcome.problem) is reported, not retried', async () => {
  const port = await freePort();
  const d = await startFakeDaemon({ port, welcome: { problem: 'Update G9BrowserAgent: this daemon is 3.0.0.' } });
  t.cleanup(() => d.close());
  const r = await runSmoke({ port, version: '2.0.0' });
  assert.equal(r.ok, false);
  assert.match(r.error, /3\.0\.0/);
});

t.run();
