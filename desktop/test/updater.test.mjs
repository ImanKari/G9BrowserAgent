import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { suite } from './harness.mjs';
import { UpdateController, feedConfig, describeUpdate, CHECK_INTERVAL_MS, BUSY_RECHECK_MS } from '../lib/updater.mjs';

const t = suite('desktop: app updater (electron-updater, generic feed)');

function fakeUpdater() {
  const u = new EventEmitter();
  u.calls = [];
  u.setFeedURL = (o) => u.calls.push(['setFeedURL', o]);
  u.checkForUpdates = async () => {
    u.calls.push(['check']);
    return null;
  };
  u.quitAndInstall = (silent, runAfter) => u.calls.push(['quitAndInstall', silent, runAfter]);
  return u;
}

function fakeTimers() {
  const t = { intervals: [], timeouts: [] };
  t.setInterval = (fn, ms) => { const h = { fn, ms }; t.intervals.push(h); return h; };
  t.clearInterval = () => {};
  t.setTimeout = (fn, ms) => { const h = { fn, ms }; t.timeouts.push(h); return h; };
  t.clearTimeout = () => {};
  return t;
}

function controller(over = {}) {
  const u = fakeUpdater();
  const timers = fakeTimers();
  const log = { info() {}, warn() {}, error() {} };
  const order = [];
  const c = new UpdateController({
    getAutoUpdater: () => u,
    isPackaged: true,
    currentVersion: '2.0.0',
    getConfig: async () => ({ url: 'https://updates.example.com/g9', channel: 'stable' }),
    queryActivity: async () => ({ busy: false, reasons: [] }),
    beforeInstall: async () => order.push('beforeInstall'),
    promptInstall: async () => 'now',
    log,
    timers,
    ...over,
  });
  return { c, u, timers, order };
}

const tick = () => new Promise((r) => setImmediate(r));

t.test('feedConfig: generic provider, trailing slash, stable → latest; https only (loopback http for a test feed)', () => {
  assert.deepEqual(feedConfig({ url: 'https://h/g9', channel: 'stable' }), { provider: 'generic', url: 'https://h/g9/', channel: 'latest' });
  assert.deepEqual(feedConfig({ url: 'https://h/g9/', channel: 'beta' }), { provider: 'generic', url: 'https://h/g9/', channel: 'beta' });
  // The installer is unsigned, so TLS to the feed host is all that authenticates it: plain http
  // over the network is refused (desktop review, 2026-09-22); a local test feed is not.
  assert.equal(feedConfig({ url: 'http://h/g9/' }), null);
  assert.deepEqual(feedConfig({ url: 'http://127.0.0.1:18080/g9' }), { provider: 'generic', url: 'http://127.0.0.1:18080/g9/', channel: 'latest' });
  assert.deepEqual(feedConfig({ url: 'http://localhost:18080/g9/' }), { provider: 'generic', url: 'http://localhost:18080/g9/', channel: 'latest' });
  assert.equal(feedConfig({ url: '' }), null);
  assert.equal(feedConfig({ url: 'file:///C:/share' }), null);
  assert.equal(feedConfig({ url: 'not a url' }), null);
});

t.test('no URL configured → "Updates: not configured", and nothing is ever checked', async () => {
  const { c, u } = controller({ getConfig: async () => ({ url: '' }) });
  const s = await c.check();
  assert.equal(s.status, 'not-configured');
  assert.equal(s.line, 'Updates: not configured');
  assert.deepEqual(u.calls, [], 'no setFeedURL, no checkForUpdates, no invented default');
});

t.test('a development build says so and does not touch electron-updater', async () => {
  let loaded = false;
  const { c } = controller({ isPackaged: false, getAutoUpdater: () => { loaded = true; return fakeUpdater(); } });
  const s = await c.check();
  assert.equal(s.status, 'dev');
  assert.match(describeUpdate(s), /development build/);
  assert.equal(loaded, false);
});

t.test('configured: feed set from settings, auto-download on, install-on-quit OFF, checked on start and every 6 h', async () => {
  const { c, u, timers } = controller();
  c.start();
  await tick();
  await tick();
  assert.deepEqual(u.calls[0], ['setFeedURL', { provider: 'generic', url: 'https://updates.example.com/g9/', channel: 'latest' }]);
  assert.deepEqual(u.calls[1], ['check']);
  assert.equal(u.autoDownload, true);
  assert.equal(u.autoInstallOnAppQuit, false, 'the installer would kill a busy daemon on a plain quit');
  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0].ms, CHECK_INTERVAL_MS);
  assert.equal(CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
  timers.intervals[0].fn();
  await tick();
  await tick();
  assert.equal(u.calls.filter((x) => x[0] === 'check').length, 2);
  assert.equal(u.calls.filter((x) => x[0] === 'setFeedURL').length, 1, 'the same feed is not re-set');
});

t.test('downloaded → asks; "now" with an idle daemon stops it first, then quitAndInstall(silent, restart)', async () => {
  const { c, u, order } = controller();
  await c.check();
  u.emit('update-available', { version: '2.0.1' });
  assert.equal(c.snapshot().status, 'available');
  u.emit('download-progress', { percent: 50 });
  assert.match(c.snapshot().line, /50%/);
  u.emit('update-downloaded', { version: '2.0.1' });
  await tick();
  await tick();
  assert.deepEqual(order, ['beforeInstall']);
  assert.deepEqual(u.calls.at(-1), ['quitAndInstall', true, true]);
  assert.equal(c.snapshot().status, 'installing');
});

t.test('"now" while a run is active → deferred, re-checked every minute, installs once idle', async () => {
  let busy = true;
  const { c, u, timers, order } = controller({ queryActivity: async () => (busy ? { busy: true, reasons: ['1 run is in progress'] } : { busy: false, reasons: [] }) });
  await c.check();
  u.emit('update-downloaded', { version: '2.0.1' });
  await tick();
  await tick();
  assert.equal(c.snapshot().status, 'deferred');
  assert.match(c.snapshot().line, /1 run is in progress/);
  assert.ok(!u.calls.some((x) => x[0] === 'quitAndInstall'), 'never installs over a run');
  assert.equal(order.length, 0, 'the daemon was not stopped');
  assert.equal(timers.timeouts.at(-1).ms, BUSY_RECHECK_MS);
  busy = false;
  await timers.timeouts.at(-1).fn();
  await tick();
  assert.deepEqual(u.calls.at(-1), ['quitAndInstall', true, true]);
});

t.test('"later" → install happens on quit, but only if the daemon is idle', async () => {
  let busy = true;
  const { c, u } = controller({ promptInstall: async () => 'later', queryActivity: async () => ({ busy, reasons: busy ? ['1 launched engine would be closed'] : [] }) });
  await c.check();
  u.emit('update-downloaded', { version: '2.0.1' });
  await tick();
  assert.equal(c.snapshot().status, 'downloaded');
  assert.equal(await c.onQuit(), 'deferred');
  assert.ok(!u.calls.some((x) => x[0] === 'quitAndInstall'));
  busy = false;
  assert.equal(await c.onQuit(), 'installing');
  assert.deepEqual(u.calls.at(-1), ['quitAndInstall', true, false], 'quitting: do not reopen the app');
});

t.test('the prompt has a real "no": only install-now and install-on-quit install', async () => {
  // Both old buttons installed, and closing the dialog meant "install on quit" too: there was no
  // way to say no (desktop review, 2026-09-22).
  const skipped = [];
  for (const [choice, expected] of [['no', 'none'], ['skip', 'none'], ['later', 'installing'], ['now', 'none']]) {
    const { c, u } = controller({
      promptInstall: async () => choice,
      onSkipVersion: (v) => skipped.push(v),
      queryActivity: async () => ({ busy: choice === 'now', reasons: choice === 'now' ? ['1 run is in progress'] : [] }),
    });
    await c.configure();
    u.emit('update-downloaded', { version: '2.1.0' });
    await tick();
    await tick();
    const onQuit = await c.onQuit();
    if (choice === 'now') {
      // "Install now" with a busy daemon: deferred, and it installs on the next quit.
      assert.equal(c.state.status, 'deferred');
      assert.equal(onQuit, 'deferred');
    } else {
      assert.equal(onQuit, expected, `choice ${choice}`);
    }
    const installs = u.calls.filter((call) => call[0] === 'quitAndInstall').length;
    assert.equal(installs, choice === 'later' ? 1 : 0, `choice ${choice} installs only when asked`);
  }
  assert.deepEqual(skipped, ['2.1.0'], 'a skipped version is remembered');

  // …and a skipped version is not offered again.
  let asked = 0;
  const { c: c2, u: u2 } = controller({ promptInstall: async () => { asked += 1; return 'no'; }, getSkippedVersion: () => '2.1.0' });
  await c2.configure();
  u2.emit('update-downloaded', { version: '2.1.0' });
  await tick();
  assert.equal(asked, 0);
});

t.test('the update config file electron-updater needs is prepared before the feed is set', async () => {
  // electron-updater reads app-update.yml before it downloads anything; a build made without a
  // publish feed has none, and every install ended as ENOENT after the check said an update was
  // available (desktop review, 2026-09-22).
  const { c, u } = controller({ ensureUpdateConfig: () => 'C:/Users/qa/AppData/Roaming/G9/g9-update.yml' });
  await c.configure();
  assert.equal(u.updateConfigPath, 'C:/Users/qa/AppData/Roaming/G9/g9-update.yml');
  const order = u.calls.map((call) => call[0]);
  assert.ok(order.includes('setFeedURL'), 'and the feed is set after it');
});

t.test('onQuit with no update does nothing', async () => {
  const { c } = controller();
  assert.equal(await c.onQuit(), 'none');
});

t.test('an updater error is shown, not swallowed', async () => {
  const { c, u } = controller();
  await c.check();
  u.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED\nstack…'));
  assert.equal(c.snapshot().status, 'error');
  assert.equal(c.snapshot().line, 'Updates: the last check failed (net::ERR_NAME_NOT_RESOLVED)');
});

t.test('first start: the URL is only known once the daemon connects → refresh() checks at once (not in 6 h)', async () => {
  let cfg = { url: '' }; // desktop.json cache empty, daemon not connected yet
  const { c, u } = controller({ getConfig: async () => cfg });
  c.start();
  await tick();
  await tick();
  assert.equal(c.snapshot().status, 'not-configured');
  assert.equal(u.calls.filter((x) => x[0] === 'check').length, 0);
  cfg = { url: 'https://updates.example.com/g9', channel: 'stable' }; // settings.get answered
  await c.refresh();
  assert.equal(u.calls.filter((x) => x[0] === 'check').length, 1, 'the start check happens as soon as the feed is known');
  await c.refresh();
  assert.equal(u.calls.filter((x) => x[0] === 'check').length, 1, 'the same feed is not re-checked on every reconnect');
  cfg = { url: 'https://updates.example.com/g9', channel: 'beta' }; // Settings changed the channel
  await c.refresh();
  assert.equal(u.calls.filter((x) => x[0] === 'check').length, 2, 'a new channel is checked at once');
});

t.test('a failed auto-download never becomes an unhandled rejection; the error event says what failed', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { c, u } = controller();
    // electron-updater returns the download promise without a handler (AppUpdater.doCheckForUpdates).
    u.checkForUpdates = async () => ({ isUpdateAvailable: true, downloadPromise: Promise.reject(new Error('sha512 checksum mismatch')) });
    await c.check();
    u.emit('error', new Error('sha512 checksum mismatch'));
    await tick();
    await tick();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled.length, 0, 'no unhandled rejection in the main process');
    assert.equal(c.snapshot().status, 'error');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

t.test('two install requests at once (the busy timer and a click) → one quitAndInstall', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { c, u, order } = controller({ promptInstall: async () => 'later', queryActivity: async () => { await gate; return { busy: false, reasons: [] }; } });
  await c.check();
  u.emit('update-downloaded', { version: '2.0.1' });
  await tick();
  const a = c.installWhenIdle();
  const b = c.installWhenIdle();
  release();
  await Promise.all([a, b]);
  assert.equal(u.calls.filter((x) => x[0] === 'quitAndInstall').length, 1);
  assert.deepEqual(order, ['beforeInstall']);
});

t.test('an unusable URL is reported as such (the daemon accepts file://; electron-updater cannot use it)', async () => {
  const { c } = controller({ getConfig: async () => ({ url: 'ftp://x/y' }) });
  const s = await c.check();
  assert.equal(s.status, 'invalid-url');
  assert.match(s.line, /not usable/);
  const f = await controller({ getConfig: async () => ({ url: 'file:///C:/share/g9' }) }).c.check();
  assert.equal(f.status, 'invalid-url');
  assert.match(f.line, /file:\/\/ feed cannot be used/);
});

t.run();
