/**
 * App updates (V2 plan §8, §P7.4): electron-updater, generic provider, URL from settings.
 *
 * What it promises, and nothing more:
 *   - No URL configured → status 'not-configured', shown as "Updates: not configured". It never
 *     checks a built-in address and never says "up to date" when it could not have known.
 *   - A development (unpackaged) build → status 'dev'; electron-updater cannot update it.
 *   - Checks on start and every 6 hours; downloads by itself; then ASKS (install now / on quit).
 *   - Installing restarts the daemon, so it happens only when the daemon reports no active run and
 *     no launched engine (`queryActivity`, injected by main.mjs: connected → `runs.list
 *     {active:true}`, which lists every open run however old, plus the engine list; not connected
 *     → the daemon's `/health` `activeRuns` and `launched` — g9d 2.0.0, F6). Busy → 'deferred',
 *     re-checked every minute; the person can also quit without installing, and the downloaded
 *     update waits for the next quit.
 *   - autoInstallOnAppQuit is OFF: electron-updater would otherwise install on any quit, killing
 *     the daemon (G9.exe) mid-run, because the installer closes every G9.exe it finds.
 *
 * The electron-updater object is injected (`autoUpdater`), so this whole state machine is tested
 * with a fake and plain node.
 */

import { EventEmitter } from 'node:events';

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const BUSY_RECHECK_MS = 60 * 1000;

/** A plain-http feed is only allowed on the loopback address (a local test feed). */
export function isLoopbackHost(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/**
 * electron-updater feed options, or null when not configured. Pure.
 *
 * https only (except a loopback test feed): the installer is unsigned, so nothing but TLS
 * authenticates what is downloaded — anyone able to answer for a plain-http feed host would hand
 * the app an installer it runs as the person (desktop review, 2026-09-22).
 */
export function feedConfig({ url, channel } = {}) {
  const u = String(url ?? '').trim();
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) return null;
  return {
    provider: 'generic',
    url: u.endsWith('/') ? u : `${u}/`,
    // The plan's vocabulary is stable/beta; electron-updater's stable channel is called 'latest'.
    channel: channel === 'beta' ? 'beta' : 'latest',
  };
}

/** The one line the UI shows. Pure. */
export function describeUpdate(s) {
  switch (s?.status) {
    case 'dev': return 'Updates: not available in a development build';
    case 'not-configured': return 'Updates: not configured';
    case 'invalid-url':
      if (/^file:/i.test(s.url ?? '')) return 'Updates: a file:// feed cannot be used; serve that folder over https';
      if (/^http:/i.test(s.url ?? '')) return `Updates: an http:// feed is refused — the download is authenticated by TLS alone; use https (${s.url})`;
      return `Updates: the configured URL is not usable (${s.url})`;
    case 'idle': return 'Updates: waiting for the first check';
    case 'checking': return 'Updates: checking…';
    case 'up-to-date': return `Updates: up to date (${s.currentVersion})`;
    case 'available': return `Updates: ${s.version} found, downloading…`;
    case 'downloading': return `Updates: downloading ${s.version ?? ''} ${Math.round(s.percent ?? 0)}%`.replace(/\s+/g, ' ').trim();
    case 'downloaded': return `Updates: ${s.version} is ready to install`;
    case 'deferred': return `Updates: ${s.version} waits for the daemon to be idle (${(s.reasons ?? []).join('; ')})`;
    case 'installing': return `Updates: installing ${s.version}…`;
    case 'error': return `Updates: the last check failed (${s.error})`;
    default: return 'Updates: unknown';
  }
}

export class UpdateController extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => object} o.getAutoUpdater   lazy: returns electron-updater's autoUpdater
   * @param {boolean} o.isPackaged
   * @param {string} o.currentVersion
   * @param {() => Promise<{url, channel}>} o.getConfig
   * @param {() => Promise<{busy, reasons}>} o.queryActivity
   * @param {() => Promise<void>} o.beforeInstall   stops the daemon (it is idle by then)
   * @param {(info) => Promise<'now'|'later'>} o.promptInstall
   */
  constructor({ getAutoUpdater, isPackaged, currentVersion, getConfig, queryActivity, beforeInstall, promptInstall, ensureUpdateConfig = null, getSkippedVersion = null, onSkipVersion = null, log = null, timers = globalThis, now = () => Date.now() }) {
    super();
    this.ensureUpdateConfig = ensureUpdateConfig;
    this.getSkippedVersion = getSkippedVersion;
    this.onSkipVersion = onSkipVersion;
    this.getAutoUpdater = getAutoUpdater;
    this.isPackaged = isPackaged;
    this.currentVersion = currentVersion;
    this.getConfig = getConfig;
    this.queryActivity = queryActivity;
    this.beforeInstall = beforeInstall;
    this.promptInstall = promptInstall;
    this.log = log;
    this.timers = timers;
    this.now = now;
    this.updater = null;
    this.interval = null;
    this.busyTimer = null;
    this.feed = null;
    this.checkedFeed = null; // the feed the last check ran against (a new URL/channel is checked at once)
    this.installing = null; // the one install attempt in flight (the busy timer and a click may race)
    this.installOnQuit = false;
    this.state = { status: isPackaged ? 'idle' : 'dev', currentVersion, url: null, channel: null, version: null, percent: null, error: null, lastCheckAt: null, nextCheckAt: null, reasons: [] };
  }

  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.state.line = describeUpdate(this.state);
    this.emit('state', { ...this.state });
  }

  snapshot() {
    return { ...this.state, line: describeUpdate(this.state) };
  }

  #wire() {
    if (this.updater) return this.updater;
    const u = this.getAutoUpdater();
    // electron-updater reads app-update.yml (updaterCacheDirName, publisherName) before it
    // downloads ANYTHING: a build made without a publish feed has no such file, and every update
    // ended as "ENOENT … app-update.yml" after the check said one was available (desktop review,
    // 2026-09-22). main.mjs writes a minimal one when the packaged file is missing.
    if (this.ensureUpdateConfig) {
      try {
        const file = this.ensureUpdateConfig();
        if (file) u.updateConfigPath = file;
      } catch (err) {
        this.log?.warn?.('Could not prepare the update config file', String(err?.message ?? err));
      }
    }
    u.autoDownload = true;
    u.autoInstallOnAppQuit = false;
    u.allowDowngrade = false;
    if (this.log) u.logger = { info: (m) => this.log.info(`updater: ${m}`), warn: (m) => this.log.warn(`updater: ${m}`), error: (m) => this.log.error(`updater: ${m}`), debug: () => {} };
    u.on('checking-for-update', () => this.#set({ status: 'checking', error: null }));
    u.on('update-available', (info) => this.#set({ status: 'available', version: info?.version ?? null, releaseNotes: info?.releaseNotes ?? null }));
    u.on('update-not-available', () => this.#set({ status: 'up-to-date', version: null }));
    u.on('download-progress', (p) => this.#set({ status: 'downloading', percent: p?.percent ?? null, bytesPerSecond: p?.bytesPerSecond ?? null }));
    u.on('update-downloaded', (info) => {
      this.#set({ status: 'downloaded', version: info?.version ?? this.state.version, percent: 100 });
      this.#offerInstall(info).catch((err) => this.log?.error?.('Install prompt failed', String(err)));
    });
    u.on('error', (err) => this.#set({ status: 'error', error: String(err?.message ?? err).split('\n')[0] }));
    this.updater = u;
    return u;
  }

  /** Read the configured feed and apply it. Returns true when updates are configured. */
  async configure() {
    if (!this.isPackaged) {
      this.#set({ status: 'dev' });
      return false;
    }
    let cfg = {};
    try {
      cfg = (await this.getConfig()) ?? {};
    } catch (err) {
      this.log?.warn?.('Update settings unreadable', String(err?.message ?? err));
    }
    const feed = feedConfig(cfg);
    if (!feed) {
      this.feed = null;
      const url = String(cfg.url ?? '').trim();
      this.#set({ status: url ? 'invalid-url' : 'not-configured', url: url || null, channel: cfg.channel ?? null });
      return false;
    }
    const u = this.#wire();
    if (!this.feed || this.feed.url !== feed.url || this.feed.channel !== feed.channel) {
      // The channel travels in the feed options (generic reads `<channel>.yml`). Not via
      // `autoUpdater.channel`: that setter also flips allowDowngrade on.
      u.setFeedURL(feed);
      this.feed = feed;
      this.log?.info?.('Update feed configured', feed);
    }
    if (['not-configured', 'invalid-url', 'dev'].includes(this.state.status)) this.#set({ status: 'idle' });
    this.#set({ url: feed.url, channel: feed.channel });
    return true;
  }

  /** Check now (start, timer, or the Settings button). */
  async check({ manual = false } = {}) {
    if (!(await this.configure())) return this.snapshot();
    if (['downloading', 'installing', 'deferred'].includes(this.state.status)) return this.snapshot();
    if (this.state.status === 'downloaded') {
      if (manual) this.#offerInstall({ version: this.state.version }).catch(() => {});
      return this.snapshot();
    }
    this.#set({ lastCheckAt: this.now(), nextCheckAt: this.now() + CHECK_INTERVAL_MS });
    this.checkedFeed = this.feed;
    try {
      const result = await this.updater.checkForUpdates();
      // With autoDownload, electron-updater starts the download and returns its promise with no
      // handler attached: a failed download (network drop, bad hash, full disk) would surface as an
      // unhandled rejection in the main process. Its 'error' event already carries the failure.
      result?.downloadPromise?.catch?.(() => {});
    } catch (err) {
      this.#set({ status: 'error', error: String(err?.message ?? err).split('\n')[0] });
    }
    return this.snapshot();
  }

  /**
   * Re-read the feed (the daemon just connected, or its settings changed) and check now when this
   * feed was never checked. "Check on start" must not depend on the local cache: on a first start
   * the URL is only known once the daemon answers settings.get, and leaving it to the 6-hour
   * interval would mean the start check never happened.
   */
  async refresh() {
    if (!(await this.configure())) return this.snapshot();
    const f = this.feed;
    const c = this.checkedFeed;
    if (!c || c.url !== f.url || c.channel !== f.channel) return this.check();
    return this.snapshot();
  }

  /** Check on start and every 6 hours. */
  start() {
    this.check().catch(() => {});
    this.timers.clearInterval?.(this.interval);
    this.interval = this.timers.setInterval(() => this.check().catch(() => {}), CHECK_INTERVAL_MS);
    this.interval?.unref?.();
  }

  stop() {
    this.timers.clearInterval?.(this.interval);
    this.timers.clearTimeout?.(this.busyTimer);
  }

  /**
   * Ask what to do with a downloaded update. Four answers, because two of the old buttons meant
   * "install" and closing the dialog meant "install on quit" too — there was no way to say no
   * (desktop review, 2026-09-22).
   */
  async #offerInstall(info) {
    const version = info?.version ?? this.state.version;
    if (this.getSkippedVersion && version && this.getSkippedVersion() === version) {
      this.log?.info?.('Update ready but skipped by the person', { version });
      return this.snapshot();
    }
    const choice = await this.promptInstall({ version, currentVersion: this.currentVersion });
    if (choice === 'now') {
      // Chosen: it also installs on quit if the daemon is busy now.
      this.installOnQuit = true;
      return this.installWhenIdle();
    }
    if (choice === 'later') {
      this.installOnQuit = true;
      this.log?.info?.('Update will install on quit');
      return this.snapshot();
    }
    if (choice === 'skip' && version) {
      this.installOnQuit = false;
      try { this.onSkipVersion?.(version); } catch { /* remembering it is a courtesy */ }
      this.log?.info?.('Update skipped by the person', { version });
      return this.snapshot();
    }
    this.installOnQuit = false;
    this.log?.info?.('Update left uninstalled for now', { version });
    return this.snapshot();
  }

  /**
   * Install as soon as the daemon is idle. Returns the state; resolves 'installing' when it went
   * ahead (the app is about to quit), 'deferred' when it is waiting.
   */
  async installWhenIdle({ quitting = false } = {}) {
    if (this.installing) return this.installing;
    this.installing = this.#installWhenIdle({ quitting }).finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  async #installWhenIdle({ quitting }) {
    if (!['downloaded', 'deferred'].includes(this.state.status)) return this.snapshot();
    const activity = await this.queryActivity();
    if (activity.busy) {
      this.#set({ status: 'deferred', reasons: activity.reasons });
      this.log?.info?.('Update install deferred', activity.reasons);
      if (!quitting) {
        this.timers.clearTimeout?.(this.busyTimer);
        this.busyTimer = this.timers.setTimeout(() => this.installWhenIdle().catch(() => {}), BUSY_RECHECK_MS);
      }
      return this.snapshot();
    }
    this.#set({ status: 'installing', reasons: [] });
    try {
      await this.beforeInstall();
    } catch (err) {
      this.log?.warn?.('Stopping the daemon before install failed', String(err?.message ?? err));
    }
    this.log?.info?.('Installing the update', { version: this.state.version });
    // isSilent: the person already chose; isForceRunAfter: reopen G9 unless we are quitting anyway.
    this.updater.quitAndInstall(true, !quitting);
    return this.snapshot();
  }

  /**
   * Called when the person quits G9. With a downloaded update and an idle daemon: install.
   * Busy: do not install (the next quit will), and say why.
   * @returns {Promise<'installing'|'deferred'|'none'>}
   */
  async onQuit() {
    if (!['downloaded', 'deferred'].includes(this.state.status)) return 'none';
    // Only when the person chose to install (now or on quit). "Not now" and "Skip this version"
    // used to install on the next quit anyway, because the flag was never read.
    if (!this.installOnQuit) return 'none';
    const s = await this.installWhenIdle({ quitting: true });
    return s.status === 'installing' ? 'installing' : 'deferred';
  }
}
