import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { suite } from './harness.mjs';
import { UpdateController, feedConfig, feedKey, describeUpdate, installMode, manualReason, releasePageUrl, OFFICIAL_REPO, CHECK_INTERVAL_MS, BUSY_RECHECK_MS } from '../lib/updater.mjs';

const t = suite('desktop: app updater (electron-updater: official GitHub releases, custom feed, off)');

function fakeUpdater() {
  const u = new EventEmitter();
  u.calls = [];
  u.setFeedURL = (o) => u.calls.push(['setFeedURL', o]);
  u.checkForUpdates = async () => {
    u.calls.push(['check']);
    return null;
  };
  u.quitAndInstall = (silent, runAfter) => u.calls.push(['quitAndInstall', silent, runAfter]);
  u.downloadUpdate = async () => { u.calls.push(['download']); return []; };
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

t.test('feedConfig: official = the GitHub releases; custom = generic, trailing slash, stable → latest; https only (loopback http for a test feed); off = none', () => {
  // Nothing configured is the official feed: a fresh install updates without anyone pasting a URL.
  assert.deepEqual(feedConfig({}), { provider: 'github', owner: OFFICIAL_REPO.owner, repo: OFFICIAL_REPO.repo, channel: 'latest' });
  assert.deepEqual(feedConfig({ mode: 'official', channel: 'beta' }), { provider: 'github', owner: 'ImanKari', repo: 'G9BrowserAgent', channel: 'beta' });
  assert.equal(feedConfig({ mode: 'off', url: 'https://h/g9' }), null);
  assert.deepEqual(feedConfig({ mode: 'custom', url: 'https://h/g9', channel: 'stable' }), { provider: 'generic', url: 'https://h/g9/', channel: 'latest' });
  assert.deepEqual(feedConfig({ mode: 'custom', url: 'https://h/g9/', channel: 'beta' }), { provider: 'generic', url: 'https://h/g9/', channel: 'beta' });
  // The installer is unsigned, so TLS to the feed host is all that authenticates it: plain http
  // over the network is refused (desktop review, 2026-09-22); a local test feed is not.
  assert.equal(feedConfig({ mode: 'custom', url: 'http://h/g9/' }), null);
  assert.deepEqual(feedConfig({ mode: 'custom', url: 'http://127.0.0.1:18080/g9' }), { provider: 'generic', url: 'http://127.0.0.1:18080/g9/', channel: 'latest' });
  assert.deepEqual(feedConfig({ mode: 'custom', url: 'http://localhost:18080/g9/' }), { provider: 'generic', url: 'http://localhost:18080/g9/', channel: 'latest' });
  assert.equal(feedConfig({ mode: 'custom', url: '' }), null);
  assert.equal(feedConfig({ mode: 'custom', url: 'https://u:p@h/g9/' }), null, 'no credentials in a feed URL');
  assert.equal(feedConfig({ mode: 'custom', url: 'file:///C:/share' }), null);
  assert.equal(feedConfig({ mode: 'custom', url: 'not a url' }), null);
  assert.equal(feedKey(feedConfig({})), 'github:ImanKari/G9BrowserAgent:latest');
});

t.test('nothing configured → the official GitHub releases, checked at once; off → never checked, and says so', async () => {
  const { c, u } = controller({ getConfig: async () => ({}) });
  const s = await c.check();
  assert.deepEqual(u.calls[0], ['setFeedURL', { provider: 'github', owner: 'ImanKari', repo: 'G9BrowserAgent', channel: 'latest' }]);
  assert.deepEqual(u.calls[1], ['check']);
  assert.equal(u.allowPrerelease, false, 'the stable channel never takes a prerelease');
  assert.equal(s.source, 'official');
  assert.equal(s.url, 'https://github.com/ImanKari/G9BrowserAgent/releases');

  const off = controller({ getConfig: async () => ({ mode: 'off', url: 'https://updates.example.com/g9' }) });
  const so = await off.c.check();
  assert.equal(so.status, 'off');
  assert.equal(so.line, 'Updates: turned off in Settings');
  assert.deepEqual(off.u.calls, [], 'no setFeedURL, no checkForUpdates');

  const empty = controller({ getConfig: async () => ({ mode: 'custom', url: '' }) });
  const se = await empty.c.check();
  assert.equal(se.status, 'not-configured');
  assert.deepEqual(empty.u.calls, []);
});

t.test('beta on the official feed takes prereleases (allowPrerelease); switching back to stable does not', async () => {
  let channel = 'beta';
  const { c, u } = controller({ getConfig: async () => ({ mode: 'official', channel }) });
  await c.check();
  assert.equal(u.allowPrerelease, true);
  channel = 'stable';
  await c.refresh();
  assert.equal(u.allowPrerelease, false);
  assert.equal(u.calls.filter((x) => x[0] === 'setFeedURL').length, 2, 'a changed channel is a changed feed, checked again');
});

t.test('installMode: Windows and a Linux AppImage install themselves; macOS (unsigned) and a .deb update by hand', () => {
  assert.equal(installMode({ platform: 'win32' }), 'auto');
  assert.equal(installMode({ platform: 'linux', appImage: true }), 'auto');
  assert.equal(installMode({ platform: 'linux', appImage: false }), 'manual');
  assert.equal(installMode({ platform: 'darwin' }), 'manual');
  assert.match(manualReason({ platform: 'darwin' }), /Developer ID/);
  assert.equal(releasePageUrl({ mode: 'official', version: '3.1.0' }), 'https://github.com/ImanKari/G9BrowserAgent/releases/tag/v3.1.0');
  assert.equal(releasePageUrl({ mode: 'official', version: '3.1.0', tag: 'v3.1.0' }), 'https://github.com/ImanKari/G9BrowserAgent/releases/tag/v3.1.0');
  assert.equal(releasePageUrl({ mode: 'custom', url: 'https://h/g9/', version: '3.1.0' }), 'https://h/g9/');
});

t.test('manual mode: checks, never downloads, tells once per version, links the release page, and remembers a skip', async () => {
  const told = [];
  let skipped = null;
  const { c, u } = controller({
    mode: 'manual',
    getConfig: async () => ({ mode: 'official' }),
    notifyManual: (x) => told.push(x),
    getSkippedVersion: () => skipped,
    onSkipVersion: (v) => { skipped = v; },
  });
  await c.check();
  assert.equal(u.autoDownload, false, 'nothing downloaded could be installed by this app');
  u.emit('update-available', { version: '3.1.0', tag: 'v3.1.0' });
  const s = c.snapshot();
  assert.equal(s.status, 'available-manual');
  assert.equal(s.installMode, 'manual');
  assert.equal(s.releaseUrl, 'https://github.com/ImanKari/G9BrowserAgent/releases/tag/v3.1.0');
  assert.match(s.line, /3\.1\.0 is available/);
  u.emit('update-available', { version: '3.1.0', tag: 'v3.1.0' });
  assert.equal(told.length, 1, 'told once, not on every 6-hourly check');
  c.skip();
  assert.equal(skipped, '3.1.0');
  u.emit('update-available', { version: '3.1.1', tag: 'v3.1.1' });
  assert.equal(told.length, 2, 'a newer release is offered again');
  assert.ok(!u.calls.some((x) => x[0] === 'quitAndInstall'));
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
  assert.equal(u.autoDownload, false, 'the controller starts the download itself, so a skipped version is never fetched');
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
  await tick();
  assert.ok(u.calls.some((x) => x[0] === 'download'), 'an available update is downloaded at once in auto mode');
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

t.test('first start: the official feed is checked at once; a feed the daemon names later is checked as soon as it is known (not in 6 h)', async () => {
  let cfg = {}; // desktop.json cache empty, daemon not connected yet
  const { c, u } = controller({ getConfig: async () => cfg });
  c.start();
  await tick();
  await tick();
  assert.equal(u.calls.filter((x) => x[0] === 'check').length, 1, 'a fresh install checks the official releases on its first start');
  assert.equal(c.snapshot().source, 'official');
  cfg = { mode: 'custom', url: 'https://updates.example.com/g9', channel: 'stable' }; // settings.get answered
  await c.refresh();
  assert.equal(u.calls.filter((x) => x[0] === 'check').length, 2, 'a different feed is checked as soon as it is known');
  await c.refresh();
  assert.equal(u.calls.filter((x) => x[0] === 'check').length, 2, 'the same feed is not re-checked on every reconnect');
  cfg = { mode: 'custom', url: 'https://updates.example.com/g9', channel: 'beta' }; // Settings changed the channel
  await c.refresh();
  assert.equal(u.calls.filter((x) => x[0] === 'check').length, 3, 'a new channel is checked at once');
});

t.test('auto mode: a skipped version is not downloaded again; a newer one is; "skip" after a download also cancels install-on-quit', async () => {
  let skipped = null;
  const { c, u } = controller({ promptInstall: async () => 'later', getSkippedVersion: () => skipped, onSkipVersion: (v) => { skipped = v; } });
  await c.check();
  u.emit('update-available', { version: '3.1.0' });
  await tick();
  u.emit('update-downloaded', { version: '3.1.0' });
  await tick();
  assert.equal(c.snapshot().installOnQuit, true, '"Install when I quit"');
  c.skip();
  assert.equal(c.snapshot().status, 'skipped');
  assert.equal(skipped, '3.1.0');
  assert.equal(await c.onQuit(), 'none', 'a skipped update is not installed on quit');
  const downloads = u.calls.filter((x) => x[0] === 'download').length;
  u.emit('update-available', { version: '3.1.0' });
  await tick();
  assert.equal(u.calls.filter((x) => x[0] === 'download').length, downloads, 'the skipped version is not fetched again');
  assert.match(c.snapshot().line, /skipped/);
  u.emit('update-available', { version: '3.1.1' });
  await tick();
  assert.equal(u.calls.filter((x) => x[0] === 'download').length, downloads + 1, 'a newer release is');
});

t.test('"Install when I quit" from Settings: nothing happens until quit; then it installs when idle and does not reopen', async () => {
  const { c, u } = controller({ promptInstall: async () => 'no' });
  await c.check();
  u.emit('update-downloaded', { version: '3.1.0' });
  await tick();
  assert.equal(await c.onQuit(), 'none', '"Not now" alone never installs on quit');
  c.installOnQuitChoice();
  assert.equal(await c.onQuit(), 'installing');
  assert.deepEqual(u.calls.at(-1), ['quitAndInstall', true, false]);
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
