import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { suite } from './harness.mjs';
import { pickInstallProcesses, parsePs, parseCim, stopInstallProcesses, updatingMarkerBody, UPDATING_MARKER_MS } from '../lib/install-stop.mjs';
import { MacSelfUpdate, SWAP_SCRIPT, bundleOf, selfUpdatable, pickMacZip, releaseFileUrl } from '../lib/mac-update.mjs';
import { updatingMarker } from '../../daemon/paths.js';

const t = suite('desktop: (3.6) clearing the way for an install, and the macOS self-update');

t.test('pickInstallProcesses: every other process running this program (MCP servers, a leftover daemon) — never this one or its own helpers', () => {
  const exe = 'C:\\Users\\a\\AppData\\Local\\Programs\\G9BrowserAgent\\G9BrowserAgent.exe';
  const rows = parseCim(JSON.stringify([
    { ProcessId: 100, ParentProcessId: 1, ExecutablePath: exe, CommandLine: `"${exe}"` },
    { ProcessId: 101, ParentProcessId: 100, ExecutablePath: exe, CommandLine: `"${exe}" --type=renderer --lang=en-US` },
    { ProcessId: 200, ParentProcessId: 50, ExecutablePath: exe.toLowerCase(), CommandLine: `"${exe}" "C:\\…\\resources\\mcp\\shim.mjs"` },
    { ProcessId: 201, ParentProcessId: 100, ExecutablePath: exe, CommandLine: `"${exe}" "C:\\…\\resources\\daemon\\g9d.mjs"` },
    { ProcessId: 300, ParentProcessId: 1, ExecutablePath: 'C:\\Other\\G9BrowserAgent.exe', CommandLine: 'other install' },
  ]));
  assert.deepEqual(pickInstallProcesses(rows, { execPath: exe, selfPid: 100, platform: 'win32' }).map((r) => r.pid), [200, 201]);
  assert.deepEqual(parseCim('{"ProcessId":7,"ParentProcessId":1,"ExecutablePath":"x","CommandLine":"x"}').map((r) => r.pid), [7], 'one process is an object, not an array');
  assert.deepEqual(parseCim(''), []);
  const mac = '/Applications/G9BrowserAgent.app/Contents/MacOS/G9BrowserAgent';
  const ps = parsePs([
    `  10     1 ${mac}`,
    `  11    10 ${mac} --type=gpu-process`,
    `  12    40 ${mac} /Applications/G9BrowserAgent.app/Contents/Resources/mcp/shim.mjs`,
    `  13    10 /Applications/G9BrowserAgent.app/Contents/Frameworks/G9BrowserAgent Helper.app/Contents/MacOS/G9BrowserAgent Helper --type=renderer`,
    '  14     1 /usr/bin/node shim.mjs',
  ].join('\n'));
  assert.deepEqual(pickInstallProcesses(ps, { execPath: mac, selfPid: 10, platform: 'darwin' }).map((r) => r.pid), [12]);
  assert.deepEqual(pickInstallProcesses(ps, { execPath: '', selfPid: 10 }), [], 'no executable, nothing to stop');
});

t.test('stopInstallProcesses: stops them and waits until none is left; a gone one is not an error', async () => {
  const exe = '/opt/x/app';
  let alive = [{ pid: 5, ppid: 1, cmd: `${exe} shim` }, { pid: 6, ppid: 1, cmd: `${exe} daemon` }];
  const killed = [];
  const r = await stopInstallProcesses({
    execPath: exe, selfPid: 1, platform: 'linux',
    list: async () => alive,
    kill: (pid) => {
      killed.push(pid);
      if (pid === 6) { const e = new Error('gone'); e.code = 'ESRCH'; throw e; }
      alive = alive.filter((p) => p.pid !== pid);
    },
    sleep: async () => { alive = alive.filter((p) => p.pid !== 6); },
  });
  assert.deepEqual(killed, [5, 6]);
  assert.deepEqual(r, { stopped: [5], left: [] });
  const stuck = await stopInstallProcesses({ execPath: exe, selfPid: 1, platform: 'linux', list: async () => [{ pid: 9, ppid: 1, cmd: exe }], kill: () => {}, sleep: async () => {}, timeoutMs: 0 });
  assert.deepEqual(stuck.left, [9], 'one that will not stop is reported, not waited on for ever');
});

t.test('the updating marker: written by the app, honoured by the MCP link until it expires', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-marker-'));
  try {
    const now = Date.now();
    assert.equal(updatingMarker(dir, now), null);
    fs.writeFileSync(path.join(dir, 'updating.json'), JSON.stringify(updatingMarkerBody({ version: '3.6.0', now })));
    assert.equal(updatingMarker(dir, now + 1000)?.version, '3.6.0');
    assert.equal(updatingMarker(dir, now + UPDATING_MARKER_MS + 1), null, 'a failed install never blocks the daemon for long');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t.test('macOS: the bundle, whether it can replace itself, the zip for this Mac, and where it is downloaded from', () => {
  assert.equal(bundleOf('/Applications/G9BrowserAgent.app/Contents/MacOS/G9BrowserAgent'), '/Applications/G9BrowserAgent.app');
  assert.equal(bundleOf('/usr/bin/node'), null);
  assert.equal(selfUpdatable({ platform: 'darwin', execPath: '/Applications/G9BrowserAgent.app/Contents/MacOS/G9BrowserAgent', writable: () => true }).ok, true);
  assert.match(selfUpdatable({ platform: 'darwin', execPath: '/private/var/folders/x/T/AppTranslocation/ABC/d/G9BrowserAgent.app/Contents/MacOS/G9BrowserAgent', writable: () => true }).reason, /move it to Applications/);
  assert.match(selfUpdatable({ platform: 'darwin', execPath: '/Applications/G9BrowserAgent.app/Contents/MacOS/G9BrowserAgent', writable: () => false }).reason, /cannot write to \/Applications/);
  assert.equal(selfUpdatable({ platform: 'win32', execPath: 'C:\\x.exe' }).ok, false);
  const files = [{ url: 'G9BrowserAgent-3.6.0-mac-x64.zip' }, { url: 'G9BrowserAgent-3.6.0-mac-arm64.zip' }, { url: 'G9BrowserAgent-3.6.0-mac-arm64.dmg' }];
  assert.equal(pickMacZip(files, 'arm64').url, 'G9BrowserAgent-3.6.0-mac-arm64.zip');
  assert.equal(pickMacZip(files, 'x64').url, 'G9BrowserAgent-3.6.0-mac-x64.zip');
  assert.equal(pickMacZip([{ url: 'a.dmg' }], 'x64'), null);
  const file = { url: 'G9BrowserAgent-3.6.0-mac-arm64.zip' };
  assert.equal(releaseFileUrl({ feed: { provider: 'github', owner: 'ImanKari', repo: 'G9BrowserAgent' }, file, version: '3.6.0' }), 'https://github.com/ImanKari/G9BrowserAgent/releases/download/v3.6.0/G9BrowserAgent-3.6.0-mac-arm64.zip');
  assert.equal(releaseFileUrl({ feed: { provider: 'generic', url: 'https://u.example/g9/' }, file }), 'https://u.example/g9/G9BrowserAgent-3.6.0-mac-arm64.zip');
});

/** A release folder served over loopback http, with faults on demand. */
async function feedServer(files) {
  const faults = { corrupt: false, cutAfter: 0 };
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split('/').pop());
    const body = files[name];
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-length': body.length });
    if (faults.cutAfter) { res.write(body.subarray(0, faults.cutAfter)); setTimeout(() => res.destroy(), 20); return; }
    res.end(faults.corrupt ? Buffer.concat([body.subarray(0, -1), Buffer.from([body.at(-1) ^ 1])]) : body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/rel/`, faults, close: () => server.close() };
}

t.test('MacSelfUpdate.prepare: downloads the zip over the feed, checks its SHA-512, stages the bundle; a changed or cut download is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-macself-'));
  const zipBytes = crypto.randomBytes(300_000);
  const name = 'G9BrowserAgent-3.6.0-mac-arm64.zip';
  const sha512 = crypto.createHash('sha512').update(zipBytes).digest('base64');
  const feed = await feedServer({ [name]: zipBytes });
  // `ditto -x -k` stands in: it "unpacks" a bundle whose package.json names the version.
  let unpackedVersion = '3.6.0';
  const exec = async (cmd, args) => {
    if (cmd === 'ditto') {
      assert.equal(fs.readFileSync(args[2]).equals(zipBytes), true, 'only the verified file is unpacked');
      const res = path.join(args[3], 'G9BrowserAgent.app', 'Contents', 'Resources');
      fs.mkdirSync(res, { recursive: true });
      fs.writeFileSync(path.join(res, 'package.json'), JSON.stringify({ version: unpackedVersion }));
    }
    return '';
  };
  const info = { version: '3.6.0', files: [{ url: name, sha512, size: zipBytes.length }] };
  const mk = () => new MacSelfUpdate({ cacheDir: path.join(dir, 'pending'), execPath: '/Applications/G9BrowserAgent.app/Contents/MacOS/G9BrowserAgent', exec, arch: 'arm64' });
  try {
    feed.faults.corrupt = true;
    await assert.rejects(mk().prepare({ info, feed: { provider: 'generic', url: feed.url } }), /sha512 checksum mismatch/);
    assert.equal(fs.existsSync(path.join(dir, 'pending', name)), false, 'a changed download is not kept');
    feed.faults.corrupt = false;
    feed.faults.cutAfter = 100_000;
    await assert.rejects(mk().prepare({ info, feed: { provider: 'generic', url: feed.url } }), /interrupted|stopped at/);
    feed.faults.cutAfter = 0;
    const progress = [];
    const m = mk();
    const staged = await m.prepare({ info, feed: { provider: 'generic', url: feed.url }, onProgress: (p) => progress.push(p.percent) });
    assert.equal(staged.version, '3.6.0');
    assert.equal(fs.existsSync(path.join(staged.app, 'Contents', 'Resources', 'package.json')), true);
    assert.ok(progress.length >= 1 && progress.at(-1) === 100, `progress reported (${progress.join(', ')})`);
    // Already downloaded and verified: not fetched again.
    feed.close();
    const again = await mk().prepare({ info, feed: { provider: 'generic', url: feed.url } });
    assert.equal(again.version, '3.6.0');
    unpackedVersion = '3.5.0';
    await assert.rejects(mk().prepare({ info, feed: { provider: 'generic', url: feed.url } }), /holds G9BrowserAgent 3\.5\.0, not 3\.6\.0/);
    await assert.rejects(mk().prepare({ info: { version: '3.6.0', files: [{ url: name }] }, feed: { provider: 'generic', url: feed.url } }), /no sha512/);
  } finally {
    feed.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

t.test('the swap script: waits for the app to quit, moves the new bundle in (copies across volumes), and puts the old one back when that fails', async () => {
  if (!hasSh) {
    console.log('    (no sh on this machine: the script is not run here)');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-swap-'));
  const shPath = (p) => p.replace(/\\/g, '/');
  try {
    const script = path.join(dir, 'swap.sh');
    fs.writeFileSync(script, SWAP_SCRIPT, { mode: 0o755 });
    const app = path.join(dir, 'Applications', 'G9BrowserAgent.app');
    const staged = path.join(dir, 'staged', 'G9BrowserAgent.app');
    for (const [root, v] of [[app, '3.5.0'], [staged, '3.6.0']]) {
      fs.mkdirSync(path.join(root, 'Contents', 'Resources'), { recursive: true });
      fs.writeFileSync(path.join(root, 'Contents', 'Resources', 'package.json'), JSON.stringify({ version: v }));
    }
    const log = path.join(dir, 'install.log');
    // A process standing in for the app: the script must wait until it has exited.
    const app0 = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], { stdio: 'ignore' });
    const started = Date.now();
    // '1': one volume, so the bundle is moved (macOS refuses writes into an app's place; a rename is allowed).
    // Run without blocking this process: a spawnSync would leave the stand-in an unreaped zombie,
    // which `kill -0` still finds (the pipeline's Linux and macOS runs waited out the timeout).
    const r = await new Promise((resolve) => {
      const p = spawn('sh', [shPath(script), String(app0.pid), shPath(staged), shPath(app), '0', shPath(log), 'G9BrowserAgent', '1'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      p.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => p.kill(), 60_000);
      p.on('exit', (status) => { clearTimeout(timer); resolve({ status, stderr }); });
    });
    assert.equal(r.status, 0, r.stderr);
    if (process.platform !== 'win32') assert.ok(Date.now() - started >= 1000, 'it waited for the app to quit');
    assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'package.json'), 'utf8')).version, '3.6.0');
    assert.equal(fs.existsSync(`${app}.g9-previous`), false, 'the previous version is removed');
    assert.equal(fs.existsSync(staged), false, 'the staged copy is removed');
    assert.match(fs.readFileSync(log, 'utf8'), /installed/);
    // Across volumes ('0'): copied, the staged copy removed after.
    fs.mkdirSync(path.join(staged, 'Contents', 'Resources'), { recursive: true });
    fs.writeFileSync(path.join(staged, 'Contents', 'Resources', 'package.json'), JSON.stringify({ version: '3.6.1' }));
    const rc = spawnSync('sh', [shPath(script), '999999', shPath(staged), shPath(app), '0', shPath(log), 'G9BrowserAgent', '0'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(rc.status, 0, rc.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'package.json'), 'utf8')).version, '3.6.1');
    assert.equal(fs.existsSync(staged), false);
    // An app that exited but was not reaped yet (a zombie) holds nothing: the script does not wait on it.
    const quick = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const until = Date.now() + 1500;
    while (Date.now() < until) { /* block, so this process does not reap it */ }
    const zt = Date.now();
    const rzombie = spawnSync('sh', [shPath(script), String(quick.pid), shPath(path.join(dir, 'missing.app')), shPath(app), '0', shPath(log), 'G9BrowserAgent', '1'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(rzombie.status, 0, rzombie.stderr);
    assert.ok(Date.now() - zt < 20_000, `an exited, unreaped app is not waited on (${Date.now() - zt} ms)`);
    // A move or copy that fails (nothing staged): the old bundle is back in place.
    for (const same of ['1', '0']) {
      const r2 = spawnSync('sh', [shPath(script), '999999', shPath(path.join(dir, 'missing.app')), shPath(app), '0', shPath(log), 'G9BrowserAgent', same], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(r2.status, 0, r2.stderr);
      assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'package.json'), 'utf8')).version, '3.6.1', `still the installed version (${same === '1' ? 'move' : 'copy'})`);
    }
    assert.match(fs.readFileSync(log, 'utf8'), /previous version is back/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t.run();
