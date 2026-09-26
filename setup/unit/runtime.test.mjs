/**
 * lib/runtime.mjs — how one G9 process starts another with the same runtime (node, the installed
 * G9 executable, or a Linux AppImage), and what a launched browser must not inherit from it.
 *
 * The AppImage case is the one that breaks silently: its files live in a FUSE mount that exists only
 * while the process the AppImage runtime started is alive. A daemon or MCP entry naming a path
 * inside it works until G9 quits, then never again.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  scriptCommand, isAppImageRuntime, ensureBootstrap, bootstrapPath, BOOTSTRAP_SOURCE, installId, cleanChildEnv,
} from '../../lib/runtime.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const MOUNT = '/tmp/.mount_G9abc123';
const APPIMAGE_ENV = { APPIMAGE: '/home/qa/Apps/G9-3.1.0.AppImage', APPDIR: MOUNT, PATH: `${MOUNT}/usr/bin:/usr/bin`, LD_LIBRARY_PATH: `${MOUNT}/usr/lib:/opt/x/lib` };

test('an AppImage is recognised only when THIS executable runs inside $APPDIR', () => {
  assert.equal(isAppImageRuntime({ env: APPIMAGE_ENV, execPath: `${MOUNT}/g9`, platform: 'linux' }), true);
  // A repository checkout started from a terminal inside some other AppImage (an editor) inherits
  // APPIMAGE/APPDIR, but its node is not in that mount.
  assert.equal(isAppImageRuntime({ env: APPIMAGE_ENV, execPath: '/usr/bin/node', platform: 'linux' }), false);
  assert.equal(isAppImageRuntime({ env: {}, execPath: `${MOUNT}/g9`, platform: 'linux' }), false);
  assert.equal(isAppImageRuntime({ env: APPIMAGE_ENV, execPath: `${MOUNT}/g9`, platform: 'win32' }), false);
});

test('scriptCommand: node in a checkout, the executable as Node when installed, the .AppImage file + bootstrap from an AppImage', () => {
  const dev = scriptCommand({ script: 'daemon/g9d.mjs', root: '/repo', execPath: '/usr/bin/node', electron: false, env: { ELECTRON_RUN_AS_NODE: '1', X: 'y' }, platform: 'linux' });
  assert.equal(dev.command, '/usr/bin/node');
  assert.deepEqual(dev.args, [path.join('/repo', 'daemon', 'g9d.mjs')]);
  assert.equal(dev.env.ELECTRON_RUN_AS_NODE, undefined, 'a dev shell\'s ELECTRON_RUN_AS_NODE is not passed on');
  assert.equal(dev.env.X, 'y');

  const win = scriptCommand({ script: 'mcp/shim.mjs', root: 'C:\\G9\\resources', execPath: 'C:\\G9\\G9.exe', electron: true, env: {}, platform: 'win32' });
  assert.equal(win.command, 'C:\\G9\\G9.exe');
  assert.deepEqual(win.args, [path.join('C:\\G9\\resources', 'mcp', 'shim.mjs')]);
  assert.equal(win.env.ELECTRON_RUN_AS_NODE, '1');

  const img = scriptCommand({ script: 'daemon/g9d.mjs', root: `${MOUNT}/resources`, execPath: `${MOUNT}/g9`, electron: true, home: '/home/qa/.g9', env: APPIMAGE_ENV, platform: 'linux' });
  assert.equal(img.command, '/home/qa/Apps/G9-3.1.0.AppImage', 'the stable file, not the mount');
  assert.deepEqual(img.args, [bootstrapPath('/home/qa/.g9'), 'daemon/g9d.mjs', '--no-sandbox'], 'the flag after the script, so AppRun does not add it before');
  assert.ok(!img.args.some((a) => a.includes('.mount_')), 'nothing inside the temporary mount');
  assert.equal(img.env.ELECTRON_RUN_AS_NODE, '1');
  assert.throws(() => scriptCommand({ script: 'x.mjs', root: '/r', execPath: `${MOUNT}/g9`, electron: true, env: APPIMAGE_ENV, platform: 'linux' }), /G9 home/);
});

test('installId: the .AppImage file for an AppImage (its root is a new mount every start), else the resource root', () => {
  assert.equal(installId({ root: `${MOUNT}/resources`, env: APPIMAGE_ENV, execPath: `${MOUNT}/g9`, platform: 'linux' }), '/home/qa/Apps/G9-3.1.0.AppImage');
  assert.equal(installId({ root: 'C:\\G9\\resources', env: {}, execPath: 'C:\\G9\\G9.exe', platform: 'win32' }), 'C:/G9/resources');
});

test('cleanChildEnv: a browser never inherits ELECTRON_RUN_AS_NODE or anything that points into the AppImage mount', () => {
  const out = cleanChildEnv({ ...APPIMAGE_ENV, ELECTRON_RUN_AS_NODE: '1', ARGV0: 'x', OWD: '/home/qa', HOME: '/home/qa' });
  assert.equal(out.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(out.APPIMAGE, undefined);
  assert.equal(out.APPDIR, undefined);
  assert.equal(out.PATH, '/usr/bin', 'the mount\'s bin dir is dropped, the rest of PATH kept');
  assert.equal(out.LD_LIBRARY_PATH, '/opt/x/lib');
  assert.equal(out.HOME, '/home/qa');
  const plain = cleanChildEnv({ PATH: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1' });
  assert.deepEqual(plain, { PATH: 'C:\\Windows' }, 'outside an AppImage only ELECTRON_RUN_AS_NODE goes');
});

test('ensureBootstrap writes the bootstrap once, rewrites a changed one, and it runs a script from its runtime\'s resources/', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'g9-runtime-'));
  try {
    const file = ensureBootstrap(home);
    assert.equal(file, bootstrapPath(home));
    assert.equal(readFileSync(file, 'utf8'), BOOTSTRAP_SOURCE);
    writeFileSync(file, '// edited', 'utf8');
    ensureBootstrap(home);
    assert.equal(readFileSync(file, 'utf8'), BOOTSTRAP_SOURCE, 'a stale or edited bootstrap is replaced');

    // Run it for real: APPDIR/resources/<script> is found, and the script sees itself as argv[1].
    const appdir = path.join(home, 'mount');
    mkdirSync(path.join(appdir, 'resources', 'demo'), { recursive: true });
    writeFileSync(path.join(appdir, 'resources', 'demo', 'hello.mjs'), 'console.log(JSON.stringify(process.argv.slice(1)));\n', 'utf8');
    // As AppRun hands it over: '--no-sandbox' after the script (G9 puts it there), dropped by the bootstrap.
    const r = spawnSync(process.execPath, [file, 'demo/hello.mjs', '--flag', '--no-sandbox'], { env: { ...process.env, APPDIR: appdir }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const argv = JSON.parse(r.stdout.trim());
    assert.equal(argv[0], path.join(appdir, 'resources', 'demo', 'hello.mjs'));
    assert.deepEqual(argv.slice(1), ['--flag']);
    const none = spawnSync(process.execPath, [file], { env: { ...process.env, APPDIR: appdir }, encoding: 'utf8' });
    assert.equal(none.status, 2, 'no script named: a usage error, not a crash');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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
