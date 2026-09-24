/**
 * The installed product, before anyone installs it: the unpacked build (dist/win-unpacked, written
 * by `npm run build:win`) is driven exactly as a QA machine would drive it — no Node on the path.
 *
 *   1. `G9.exe --smoke --launch`: the packaged main process finds no daemon, starts one as
 *      G9.exe + ELECTRON_RUN_AS_NODE=1 + resources/daemon/g9d.mjs (ARCHITECTURE_V2 §11), connects
 *      as role ui, reads the settings, prints one JSON line. No window.
 *   2. The MCP entry the wizard writes for this build (lib/mcp-register.mjs shimEntry), spawned
 *      verbatim: initialize → tools/list → tools/call browser_status over stdio.
 *   3. The runner under G9.exe (`resources/runner/g9.mjs help`), then `list` against the daemon of
 *      step 1: the runner spawns resources/mcp/shim.mjs with its own execPath (G9.exe) and the
 *      inherited ELECTRON_RUN_AS_NODE, so this is the whole unattended chain with no Node installed.
 *   4. admin shutdown; the port is free again.
 *
 * Not part of `npm test` (it needs a build). Run with `npm run test:packaged`. Temp G9_HOME, a port
 * in 18000-18999, never 8765; every process it starts is stopped (only those).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { suite, freePort, tmpDir, rmrf, until } from './harness.mjs';
import { DaemonClient } from '../lib/daemon-client.mjs';
import { probeHealth, waitForPortFree } from '../lib/daemon-launch.mjs';
import { shimEntry } from '../lib/mcp-register.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNPACKED = path.join(APP_DIR, 'dist', 'win-unpacked');
const EXE = path.join(UNPACKED, 'G9.exe');
const RESOURCES = path.join(UNPACKED, 'resources');
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;

if (!fs.existsSync(EXE)) {
  console.log(`desktop: packaged build — SKIPPED: ${EXE} does not exist (run npm run build:win first)`);
  process.exit(0);
}

const t = suite('desktop: the packaged build (dist/win-unpacked), no Node on the path');
const home = tmpDir('g9-desktop-packaged-');
const port = await freePort();
const baseEnv = { ...process.env, G9_PORT: String(port), G9_HOME: home, G9_IDLE_EXIT_MS: '20000' };
delete baseEnv.ELECTRON_RUN_AS_NODE;
// "No Node on the path" is meant literally: every directory holding a node.exe is dropped from PATH,
// so a script that spawned `node` (instead of its own execPath, G9.exe) fails here as it would on a
// QA machine. Before round 3 this suite inherited the developer's PATH and could not tell.
for (const k of Object.keys(baseEnv)) if (k.toLowerCase() === 'path' && k !== 'PATH') delete baseEnv[k];
baseEnv.PATH = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)
  .filter((d) => d && !['node.exe', 'node'].some((n) => fs.existsSync(path.join(d, n)))).join(path.delimiter);
const ours = new Set();

t.cleanup(async () => {
  for (const pid of ours) {
    try { process.kill(pid); } catch { /* gone */ }
  }
  // A daemon this suite never saw by pid (the shim starts one detached; a test that fails before
  // noting it) still lives on this temp home: stop it by its /health, but only when the home is ours.
  // Round 3: one such daemon outlived a failed run and re-created logs/ after the folder was removed.
  const h = await probeHealth(port).catch(() => ({ status: 'none' }));
  if (h.status === 'g9d' && path.resolve(String(h.body.home ?? '')).toLowerCase() === path.resolve(home).toLowerCase()) {
    try { process.kill(h.body.pid); } catch { /* gone */ }
  }
  await waitForPortFree(port, { timeoutMs: 5000 }).catch(() => {});
  rmrf(home);
});

function run(command, args, { env = baseEnv, input = null, timeoutMs = 60_000, onStdout = null, cwd = undefined } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    ours.add(child.pid);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
      onStdout?.(out, child);
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    if (input !== null) child.stdin.end(input);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      ours.delete(child.pid);
      resolve({ code, out, err });
    });
  });
}

t.test('there is no node on the PATH this suite gives the packaged app', () => {
  const where = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], { env: baseEnv, encoding: 'utf8', windowsHide: true });
  assert.notEqual(where.status, 0, `node is still reachable: ${where.stdout}`);
});

t.test('G9.exe --smoke --launch starts the packaged daemon and reads its settings', async () => {
  const r = await run(EXE, ['--smoke', '--launch']);
  assert.equal(r.code, 0, r.err || r.out);
  const j = JSON.parse(r.out.trim().split('\n').at(-1));
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.equal(j.launched, true, 'nothing listened, so the app started the daemon');
  assert.equal(j.version, VERSION);
  assert.equal(j.welcome.version, VERSION);
  assert.equal(path.resolve(j.welcome.repoRoot).toLowerCase(), path.resolve(RESOURCES).toLowerCase(), 'the daemon runs from resources/');
  assert.equal(typeof j.settings.humanize, 'string');
  const h = await probeHealth(port);
  assert.equal(h.status, 'g9d');
  ours.add(h.body.pid);
});

t.test('the MCP entry the wizard writes for this build speaks MCP (G9.exe + ELECTRON_RUN_AS_NODE + shim.mjs)', async () => {
  const entry = shimEntry({ isPackaged: true, execPath: EXE, resourceRoot: RESOURCES, port, homeOverride: home });
  assert.equal(entry.env.ELECTRON_RUN_AS_NODE, '1');
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'packaged-check', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_status', arguments: {} } },
  ];
  // Answer-driven: send the next request only after the previous one answered, then close stdin.
  const env = { ...baseEnv, ...entry.env };
  const r = await new Promise((resolve) => {
    const child = spawn(entry.command, entry.args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    ours.add(child.pid);
    const replies = [];
    let buf = '';
    let err = '';
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send(messages[0]);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === undefined) continue;
        replies.push(msg);
        if (msg.id === 1) { send(messages[1]); send(messages[2]); }
        if (msg.id === 2) send(messages[3]);
        if (msg.id === 3) child.stdin.end();
      }
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    const timer = setTimeout(() => child.kill(), 45_000);
    child.on('exit', () => {
      clearTimeout(timer);
      ours.delete(child.pid);
      resolve({ replies, err });
    });
  });
  const byId = new Map(r.replies.map((m) => [m.id, m]));
  assert.equal(byId.get(1)?.result?.serverInfo?.version, VERSION, r.err);
  const tools = byId.get(2)?.result?.tools?.map((x) => x.name) ?? [];
  assert.ok(tools.includes('browser_status') && tools.includes('browser_engine'), tools.join(','));
  const status = byId.get(3)?.result;
  assert.ok(status && !status.isError, JSON.stringify(status).slice(0, 400));
  const text = status.content.map((c) => c.text ?? '').join('\n');
  assert.match(text, new RegExp(VERSION.replace(/\./g, '\\.')), 'browser_status came from the packaged daemon');
});

t.test('the runner runs under G9.exe (resources/runner/g9.mjs help)', async () => {
  const r = await run(EXE, [path.join(RESOURCES, 'runner', 'g9.mjs'), 'help'], { env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /--browser/);
});

t.test('the runner lists flows under G9.exe through the packaged shim, against this private daemon', async () => {
  // A project of its own inside the temp home, run from there: the runner looks for g9.project.json
  // upwards from its cwd, and must neither climb into this repository nor need one. (The runner
  // reads only *.flow.json files.)
  const project = path.join(home, 'project');
  fs.mkdirSync(path.join(project, 'QA', 'Flows'), { recursive: true });
  fs.writeFileSync(path.join(project, 'g9.project.json'), JSON.stringify({ flowsDir: 'QA/Flows' }));
  fs.writeFileSync(path.join(project, 'QA', 'Flows', 'packaged-list-check.flow.json'), JSON.stringify({
    format: 'g9/flowspec', schemaVersion: 1, id: 'packaged-list-check', name: 'Packaged list check',
    steps: [{ id: 's1', action: 'navigate', url: 'about:blank' }],
  }));
  const before = await probeHealth(port);
  assert.equal(before.status, 'g9d', 'the daemon of the first test is still up');
  const r = await run(EXE, [path.join(RESOURCES, 'runner', 'g9.mjs'), 'list', '--port', String(port)], {
    env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' }, cwd: project,
  });
  assert.equal(r.code, 0, `exit ${r.code}\n${r.out}\n${r.err}`);
  assert.match(r.out, /Repository \(/, r.out);
  assert.match(r.out, /packaged-list-check\s+·\s+Packaged list check/, r.out);
  assert.doesNotMatch(`${r.out}\n${r.err}`, /not reachable|shim did not start|8765/, 'the runner reached this daemon through the shim');
  // The same daemon answered (the shim did not start a second one on the way).
  const after = await probeHealth(port);
  assert.equal(after.body.pid, before.body.pid);
});

t.test('admin shutdown stops the packaged daemon and frees the port', async () => {
  const c = new DaemonClient({ port, version: VERSION, clientName: 'packaged-check' });
  c.start();
  await c.whenConnected(10_000);
  assert.deepEqual(await c.admin('shutdown'), { stopping: true });
  c.stop();
  assert.equal(await waitForPortFree(port, { timeoutMs: 15_000 }), true);
  await until(() => (probeHealth(port).then((h) => h.status === 'none')), { timeoutMs: 5000, what: 'no listener' });
});

t.test('nothing listening: the packaged shim starts the packaged daemon itself (G9.exe + resources/daemon)', async () => {
  // What an AI client does on a QA machine before the app ever ran: it spawns the entry the wizard
  // wrote, and the shim finds no daemon and starts one with its own execPath (mcp/shim.mjs).
  assert.equal((await probeHealth(port)).status, 'none', 'the previous test left the port free');
  const entry = shimEntry({ isPackaged: true, execPath: EXE, resourceRoot: RESOURCES, port, homeOverride: home });
  const env = { ...baseEnv, ...entry.env };
  const r = await new Promise((resolve) => {
    const child = spawn(entry.command, entry.args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    ours.add(child.pid);
    let buf = '';
    let err = '';
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'packaged-check', version: '1' } } })}\n`);
    child.stdout.on('data', (d) => {
      buf += d;
      if (/"id":\s*1\b/.test(buf)) child.stdin.end();
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    const timer = setTimeout(() => child.kill(), 45_000);
    child.on('exit', () => {
      clearTimeout(timer);
      ours.delete(child.pid);
      resolve({ out: buf, err });
    });
  });
  assert.match(r.out, /"serverInfo"/, `no initialize answer: ${r.err}`);
  // The shim answers initialize itself and starts the daemon detached; this client has already
  // gone, and the daemon may still be booting. It must come up, and stay up, on its own.
  await until(async () => (await probeHealth(port)).status === 'g9d', { timeoutMs: 20_000, intervalMs: 100, what: `the daemon the shim started (${r.err.trim()})` });
  const h = await probeHealth(port);
  assert.equal(h.status, 'g9d', `the shim started no daemon: ${r.err}`);
  ours.add(h.body.pid);
  assert.equal(path.resolve(String(h.body.home)).toLowerCase(), path.resolve(home).toLowerCase(), 'on this temp home');
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(h.body.pid)}") | ForEach-Object { $_.Name + '|' + $_.CommandLine }`], { encoding: 'utf8', windowsHide: true });
    const [name = '', cmd = ''] = ps.stdout.trim().split('|');
    assert.match(name, /^G9\.exe$/i, `the daemon runs as ${name} (${cmd})`);
    assert.match(cmd, /resources[\\/]daemon[\\/]g9d\.mjs/i, cmd);
  }
  const c = new DaemonClient({ port, version: VERSION, clientName: 'packaged-check' });
  c.start();
  await c.whenConnected(10_000);
  await c.admin('shutdown');
  c.stop();
  assert.equal(await waitForPortFree(port, { timeoutMs: 15_000 }), true);
});

t.run();
