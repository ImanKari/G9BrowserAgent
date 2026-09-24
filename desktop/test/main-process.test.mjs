/**
 * The Electron main process (main.mjs startApp) run for real, in plain node, against a fake
 * Electron API and a fake g9d. Nothing else executes startApp without a display: this is what
 * catches a runtime error in startup, and what checks the IPC allowlist, the g9app:// protocol,
 * approvals (`by` from main), the tray's Stop/Resume/Quit and the "Shut down daemon" hold end to end.
 *
 * No window, no browser, no real daemon: G9_PORT is a random test port served by fake-daemon.mjs and
 * G9_HOME a temp dir. If a bug made the app start the real daemon anyway, the test fails and kills it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { suite, freePort, tmpDir, rmrf, until, sleep } from './harness.mjs';
import { startFakeDaemon } from './fake-daemon.mjs';
import { probeHealth } from '../lib/daemon-launch.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = suite('desktop: main process (startApp) against a fake Electron and a fake g9d');

const home = tmpDir('g9-desktop-main-');
const port = await freePort();
process.env.G9_HOME = home;
process.env.G9_PORT = String(port);
delete process.env.ELECTRON_RUN_AS_NODE;

// ------------------------------------------------------------------ the fake daemon

const approvals = [];
let daemon = null;
async function startDaemon({ bootId = 'boot-1' } = {}) {
  daemon = await startFakeDaemon({
    port,
    // The daemon INSTANCE this app is talking to: tab handles mean nothing across instances.
    welcome: { bootId, startedAt: Date.now() },
    admin: {
      state: () => ({ halted: { halted: false }, agents: [{ id: 'agent-1', name: 'claude-code', owned: [3] }], engines: [], tabs: [{ tabId: 3, title: 'Shop', url: 'https://shop.example/' }], watching: [] }),
      'settings.get': () => ({ humanize: 'human', updateUrl: '' }),
      halt: () => ({ halted: true }),
      resume: () => ({ halted: false }),
      watch: (m) => ({ watching: true, tabId: m.tabId ?? m.args?.tabId ?? null }),
      unwatch: (m) => ({ watching: false, tabId: m.tabId ?? m.args?.tabId ?? null }),
      shutdown: () => {
        setTimeout(() => daemon.close(), 30);
        return { stopping: true };
      },
    },
    call: async (m) => {
      if (m.tool === 'browser_recording' && m.args.action === 'approve') {
        approvals.push(m.args);
        return { id: m.args.id, runs: 2 };
      }
      if (m.tool === 'browser_tabs') return { tabs: [{ tabId: 3, title: 'Shop', url: 'https://shop.example/' }] };
      return { echo: m.tool };
    },
  });
  return daemon;
}
await startDaemon();

// ------------------------------------------------------------------ the fake Electron

const rec = { errors: [], windows: [], trays: [], menus: [], protocol: null, ipc: null, appEvents: new EventEmitter(), quit: 0, exit: [], permission: null };

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }
  send(channel, msg) { this.sent.push([channel, msg]); }
  isLoading() { return false; }
  reload() {}
  setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
}

class FakeWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.webContents = new FakeWebContents();
    this.visible = false;
    this.destroyed = false;
    this.url = null;
    rec.windows.push(this);
  }
  loadURL(url) {
    this.url = url;
    setImmediate(() => {
      this.webContents.emit('did-finish-load');
      this.emit('ready-to-show');
    });
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return false; }
  isFocused() { return this.visible; }
  show() { this.visible = true; this.emit('show'); }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; this.emit('hide'); }
  focus() {}
  restore() {}
  getSize() { return [this.opts.width, this.opts.height]; }
  /** What a click on the window's X does: 'close' may be prevented. */
  tryClose() {
    let prevented = false;
    this.emit('close', { preventDefault: () => { prevented = true; } });
    return !prevented;
  }
}

class FakeTray extends EventEmitter {
  constructor(image) {
    super();
    this.image = image;
    rec.trays.push(this);
  }
  setImage(i) { this.image = i; }
  setToolTip(s) { this.tooltip = s; }
  setContextMenu(m) { this.menu = m; }
}

const fakeImage = () => ({ reps: [], addRepresentation(r) { this.reps.push(r); } });

const fakeElectron = {
  app: {
    isPackaged: false,
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true,
    setAppUserModelId() {},
    getVersion: () => JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version,
    whenReady: () => Promise.resolve(),
    on: (ev, fn) => rec.appEvents.on(ev, fn),
    quit: () => { rec.quit += 1; rec.appEvents.emit('before-quit'); },
    exit: (c) => rec.exit.push(c),
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings() {},
  },
  BrowserWindow: FakeWindow,
  Tray: FakeTray,
  Menu: { buildFromTemplate: (tpl) => { rec.menus.push(tpl); return tpl; }, setApplicationMenu() {} },
  nativeImage: { createFromBuffer: () => fakeImage(), createEmpty: () => fakeImage() },
  nativeTheme: { shouldUseDarkColors: false },
  ipcMain: { handle: (channel, fn) => { rec.ipc = { channel, fn }; } },
  dialog: {
    showMessageBox: async () => ({ response: 1 }),
    showErrorBox: (title, body) => rec.errors.push(`${title}: ${body}`),
  },
  shell: { openPath: async () => '' },
  clipboard: { writeText() {} },
  protocol: {
    registerSchemesAsPrivileged: (list) => { rec.schemes = list; },
    handle: (scheme, fn) => { rec.protocol = { scheme, fn }; },
  },
  session: { defaultSession: { setPermissionRequestHandler: (fn) => { rec.permission = fn; }, setPermissionCheckHandler: (fn) => { rec.permissionCheck = fn; } } },
  Notification: Object.assign(class { on() {} show() {} }, { isSupported: () => false }),
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1366, height: 728 } }) },
};

// main.mjs does `createRequire(import.meta.url)('electron')`: put the fake where that resolves.
const req = createRequire(path.join(APP_DIR, 'main.mjs'));
const resolved = req.resolve('electron');
req.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: fakeElectron, children: [], paths: [] };

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

t.cleanup(async () => {
  // Quit through the tray, as a person would; then make sure nothing of ours still listens.
  const h = await probeHealth(port).catch(() => ({ status: 'none' }));
  if (h.status === 'g9d' && h.body?.pid && h.body.pid !== process.pid) {
    try { process.kill(h.body.pid); } catch { /* gone */ }
  }
  await daemon?.close().catch(() => {});
  // A real g9d the app started by mistake binds the port only once the fake has let go of it:
  // look again, and stop one that is ours (this test's G9_HOME) rather than leave it running.
  await sleep(1500);
  const after = await probeHealth(port).catch(() => ({ status: 'none' }));
  const ours = (p) => path.resolve(String(p ?? '')).toLowerCase() === path.resolve(home).toLowerCase();
  if (after.status === 'g9d' && after.body?.pid && after.body.pid !== process.pid && ours(after.body.home)) {
    console.log(`  (cleanup: stopped a real g9d, pid ${after.body.pid}, that the app started on the test port)`);
    try { process.kill(after.body.pid); } catch { /* gone */ }
  }
  rmrf(home);
});

await import('../main.mjs');

const ipc = (op, args, url = 'g9app://app/index.html') => rec.ipc.fn({ senderFrame: { url } }, op, args);
const win = () => rec.windows.at(-1);
const trayItem = (label) => rec.trays[0]?.menu?.find((i) => i.label === label);

// ------------------------------------------------------------------ tests

t.test('startApp runs to the end: privileged scheme, one window on g9app://, a tray, connected as ui', async () => {
  await until(() => rec.ipc && rec.protocol && rec.windows.length === 1 && rec.trays.length === 1, { what: 'startup' });
  assert.deepEqual(rec.errors, [], 'no "G9 could not start" dialog');
  assert.equal(rec.schemes[0].scheme, 'g9app');
  assert.equal(win().url, 'g9app://app/index.html');
  const o = win().opts;
  assert.equal(o.webPreferences.contextIsolation, true);
  assert.equal(o.webPreferences.sandbox, true);
  assert.equal(o.webPreferences.nodeIntegration, false);
  assert.equal(o.title, `G9 ${fakeElectron.app.getVersion()}`);
  assert.ok(o.width <= 1366 && o.height <= 728, 'fits the work area');
  assert.equal(o.width, 1100);
  assert.equal(o.height, 720);
  await until(async () => (await ipc('state')).result?.connection?.status === 'connected', { what: 'connected', timeoutMs: 8000 });
  const hello = daemon.received.find((m) => m.type === 'hello');
  assert.equal(hello.role, 'ui');
  const s = (await ipc('state')).result;
  assert.equal(s.app.version, fakeElectron.app.getVersion());
  assert.equal(s.app.port, port);
  await until(async () => (await ipc('state')).result.agents.length === 1, { what: 'seeded state' });
  assert.equal((await ipc('state')).result.tabs[0].tabId, 3);
  assert.match(rec.trays[0].tooltip, /^G9 \d+\.\d+\.\d+/);
});

t.test('a small screen: the window opens inside the work area instead of off it', async () => {
  // Checked through the same code path by a second window (showWindow after the first is destroyed).
  fakeElectron.screen.getPrimaryDisplay = () => ({ workAreaSize: { width: 910, height: 490 } });
  win().destroyed = true;
  rec.appEvents.emit('second-instance');
  const o = win().opts;
  assert.equal(o.width, 910);
  assert.equal(o.height, 490);
  assert.ok(o.minWidth <= 910 && o.minHeight <= 490);
  assert.equal(win().visible, true, 'a second start shows the window');
  fakeElectron.screen.getPrimaryDisplay = () => ({ workAreaSize: { width: 1366, height: 728 } });
});

t.test('IPC: only the G9 page may call; unknown ops, admin ops and tool actions outside the allowlist are refused', async () => {
  assert.equal((await ipc('state', {}, 'https://evil.example/')).ok, false);
  assert.match((await ipc('nope')).error, /Unknown operation/);
  assert.match((await ipc('admin', { op: 'rm -rf' })).error, /Not an admin operation/);
  assert.match((await ipc('call', { tool: 'browser_evaluate', args: {} })).error, /Not a tool the app calls/);
  assert.match((await ipc('call', { tool: 'browser_recording', args: { action: 'approve', id: 'A', by: 'mallory' } })).error, /not available here/);
  assert.equal(approvals.length, 0, 'the page cannot approve with a name of its choosing');
  const listed = await ipc('call', { tool: 'browser_tabs', args: { action: 'list' } });
  assert.equal(listed.ok, true);
});

t.test('approve: main supplies `by` (the OS user), the page only names the flow', async () => {
  const r = await ipc('approve', { flowId: 'checkout', runId: 'r1', note: 'expected banner', engine: 'launched', by: 'mallory' });
  assert.equal(r.ok, true, r.error);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].action, 'approve');
  assert.equal(approvals[0].id, 'checkout');
  assert.equal(approvals[0].by, os.userInfo().username);
  assert.equal(approvals[0].engine, 'launched');
});

t.test('g9app:// serves only renderer files, with the CSP; traversal and other hosts are refused', async () => {
  const get = (url) => rec.protocol.fn({ url });
  const ok = await get('g9app://app/index.html');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/html/);
  assert.match(ok.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.equal((await get('g9app://app/')).status, 200, '/ is index.html');
  assert.equal((await get('g9app://app/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await get('g9app://app/..%2fmain.mjs')).status, 403, 'an encoded ../ never leaves renderer/');
  assert.equal((await get('g9app://app/../main.mjs')).status, 404, 'a literal ../ is resolved inside renderer/');
  assert.equal((await get('g9app://other/index.html')).status, 404);
  let granted = null;
  rec.permission(null, 'media', (v) => { granted = v; });
  assert.equal(granted, false, 'every permission request is denied');
  assert.equal(rec.permissionCheck(), false);
});

t.test('web contents: no <webview>, no new windows, no navigation away from g9app://', () => {
  const wc = new FakeWebContents();
  rec.appEvents.emit('web-contents-created', {}, wc);
  let prevented = 0;
  wc.emit('will-attach-webview', { preventDefault: () => prevented++ });
  wc.emit('will-navigate', { preventDefault: () => prevented++ }, 'https://shop.example/');
  wc.emit('will-navigate', { preventDefault: () => prevented++ }, 'g9app://app/index.html');
  assert.equal(prevented, 2);
  assert.deepEqual(wc.windowOpenHandler(), { action: 'deny' });
});

t.test('desktop.patch keeps only what the shell owns', async () => {
  const r = await ipc('desktop.patch', { lastView: 'runs', startDaemon: true, update: { url: 'https://evil/' } });
  assert.equal(r.result.lastView, 'runs');
  assert.equal(r.result.update.url, '', 'the page cannot redirect the updater through desktop.json');
});

t.test('closing the window hides it (G9 stays in the tray); Windows sign-out lets it close', () => {
  const w = win();
  w.show();
  assert.equal(w.tryClose(), false, 'close is turned into hide');
  assert.equal(w.visible, false);
  w.emit('session-end');
  assert.equal(w.tryClose(), true, 'a sign-out is not held up by hide-to-tray');
});

t.test('tray: Stop all agents → admin halt; the menu then offers Resume', async () => {
  await until(() => trayItem('Stop all agents')?.enabled, { what: 'tray menu' });
  trayItem('Stop all agents').click();
  await until(() => daemon.received.some((m) => m.type === 'admin' && m.op === 'halt'), { what: 'halt sent' });
  daemon.event('halt', { global: { halted: true, by: 'desktop', at: Date.now() } });
  await until(() => trayItem('Resume')?.enabled, { what: 'Resume enabled' });
  trayItem('Resume').click();
  await until(() => daemon.received.some((m) => m.type === 'admin' && m.op === 'resume'), { what: 'resume sent' });
});

t.test('"Shut down daemon" is not undone by our own reconnect; Reconnect brings it back', async () => {
  const r = await ipc('admin', { op: 'shutdown', args: {} });
  assert.equal(r.ok, true, r.error);
  await until(async () => (await ipc('state')).result.connection.status === 'waiting', { what: 'waiting', timeoutMs: 8000 });
  await sleep(1500);
  const s = (await ipc('state')).result.connection;
  assert.match(s.error ?? '', /shut down from this app/);
  assert.equal((await probeHealth(port)).status, 'none', 'nothing was started on the port');
  await startDaemon(); // what Reconnect would start; here the fake answers so no real g9d is spawned
  await ipc('reconnect');
  await until(async () => (await ipc('state')).result.connection.status === 'connected', { what: 'reconnected', timeoutMs: 8000 });
});

t.test('a daemon RESTART drops the watches: tab handles belong to one daemon instance', async () => {
  // Handles restart at 1 in every daemon. The desktop kept watching handle 3 across a restart and
  // streamed — and spooled — whatever tab the NEW daemon had numbered 3, which on an extension
  // engine is a tab in the person's own browser (desktop review, 2026-09-22).
  const watched = await ipc('admin', { op: 'watch', args: { tabId: 3 } });
  assert.equal(watched.ok, true, watched.error);
  await until(() => daemon.received.some((m) => m.type === 'admin' && m.op === 'watch'), { what: 'watch sent' });

  const before = win().webContents.sent.length;
  await ipc('admin', { op: 'shutdown', args: {} });
  await until(async () => (await ipc('state')).result.connection.status === 'waiting', { what: 'waiting', timeoutMs: 8000 });
  await startDaemon({ bootId: 'boot-2' });
  await ipc('reconnect');
  await until(async () => (await ipc('state')).result.connection.status === 'connected', { what: 'reconnected', timeoutMs: 8000 });
  await sleep(300);

  const pushes = win().webContents.sent.slice(before)
    .filter(([channel, msg]) => channel === 'g9:push' && msg?.topic === 'watch')
    .map(([, msg]) => msg.data);
  assert.ok(pushes.some((p) => p.reason === 'daemon-restarted' && (p.stopped ?? []).includes(3)), `the view is told to pick the tab again: ${JSON.stringify(pushes)}`);
  assert.equal(daemon.received.some((m) => m.type === 'admin' && m.op === 'watch'), false, 'and nothing is re-watched by number');
});

t.test('Quit from the tray: the app quits, the daemon keeps serving (no shutdown sent)', async () => {
  const shutdownsBefore = daemon.received.filter((m) => m.op === 'shutdown').length;
  trayItem('Quit G9').click();
  await until(() => rec.quit === 1, { what: 'app.quit' });
  assert.equal(daemon.received.filter((m) => m.op === 'shutdown').length, shutdownsBefore);
  assert.deepEqual(rec.errors, []);
  assert.deepEqual(unhandled.map(String), [], 'no unhandled rejection in the main process');
});

t.run();
