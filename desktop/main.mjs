/**
 * G9 desktop — the Electron main process (ARCHITECTURE_V2 §11, V2 plan §P7).
 *
 * The shell, never the engine (D4, R5): Electron's Chromium only ever loads this app's own renderer
 * files, served from the private `g9app://app/` scheme. There is no BrowserView, no <webview>, no
 * loadURL of a page under test. Pages under test run in real Edge/Chrome/CfT that the daemon
 * launches; the Watch view shows their JPEG frames on a <canvas> with the cursor drawn from data.
 *
 * What lives here: the single-instance lock, the tray, the one daemon connection (role 'ui'), the
 * state the renderer shows, the IPC allowlist, the updater, and the first-run wizard's side effects.
 *
 * Flags:
 *   --smoke    no windows: connect to g9d at G9_PORT, hello + admin settings.get, print JSON, exit.
 *              Works under Electron and under plain Node (`node main.mjs --smoke`).
 *   --launch   with --smoke: start the daemon if nothing listens.
 *   --hidden   start in the tray without opening the window.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { g9Home, daemonPort, homeLayout, resourceRoot as resolveResourceRoot, resourcePaths, osUserName } from './lib/paths.mjs';
import { runSmoke } from './lib/smoke.mjs';

const require = createRequire(import.meta.url);
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.join(APP_DIR, 'renderer');
const ARGS = process.argv.slice(1);
const FLAGS = {
  smoke: ARGS.includes('--smoke'),
  launch: ARGS.includes('--launch'),
  hidden: ARGS.includes('--hidden'),
  checkRender: ARGS.includes('--check-render') ? ARGS[ARGS.indexOf('--check-render') + 1] ?? null : null,
};
const CHECKING = !!FLAGS.checkRender;

function readOwnVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

// Under Electron `require('electron')` is the API; under plain Node (or ELECTRON_RUN_AS_NODE) it
// is the npm package, whose export is the path of the Electron binary (a string).
let electron = null;
try {
  electron = require('electron');
} catch {
  electron = null;
}
const IN_ELECTRON = !!(electron && typeof electron === 'object' && electron.app);

function smokeOptions(isPackaged, execPath, resourcesPath) {
  const root = resolveResourceRoot({ isPackaged, resourcesPath, appDir: APP_DIR });
  return {
    port: daemonPort(),
    version: readOwnVersion(),
    launch: FLAGS.launch,
    commandOptions: { isPackaged, execPath, resourceRoot: root, home: process.env.G9_HOME || null },
  };
}

function printAndExit(result, exit) {
  process.stdout.write(`${JSON.stringify(result)}\n`, () => exit(result.ok ? 0 : 1));
}

if (!IN_ELECTRON) {
  if (FLAGS.smoke) {
    runSmoke(smokeOptions(false, process.execPath, null)).then(
      (r) => printAndExit(r, (c) => process.exit(c)),
      (err) => printAndExit({ ok: false, error: String(err?.message ?? err) }, (c) => process.exit(c)),
    );
  } else {
    process.stderr.write(
      'G9 desktop is an Electron app. Start it with `npm start` in desktop/ (or `npx electron .`).\n' +
        'If ELECTRON_RUN_AS_NODE is set in your shell, Electron runs as plain Node; `npm start` clears it.\n' +
        'Plain Node supports only `node main.mjs --smoke [--launch]`.\n',
    );
    process.exit(1);
  }
} else if (FLAGS.smoke) {
  const { app } = electron;
  runSmoke(smokeOptions(app.isPackaged, process.execPath, process.resourcesPath)).then(
    (r) => printAndExit(r, (c) => app.exit(c)),
    (err) => printAndExit({ ok: false, error: String(err?.message ?? err) }, (c) => app.exit(c)),
  );
} else {
  startApp().catch((err) => {
    try {
      electron.dialog.showErrorBox('G9 could not start', String(err?.stack ?? err));
    } finally {
      electron.app.exit(1);
    }
  });
}

// =====================================================================================================
// The app
// =====================================================================================================

async function startApp() {
  const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, ipcMain, dialog, shell, clipboard, protocol, session, Notification, screen } = electron;

  // One G9 per user session. A second start (Start menu, autostart) just shows the first one.
  if (!CHECKING && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // Listened for at once: a second start while this one is still starting (the imports and
  // whenReady below) must still bring the window up, not be lost.
  let showWindowRef = null;
  let showWindowLater = false;
  app.on('second-instance', () => {
    if (showWindowRef) showWindowRef();
    else showWindowLater = true;
  });
  protocol.registerSchemesAsPrivileged([{ scheme: 'g9app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  if (process.platform === 'win32') app.setAppUserModelId('com.g9.browseragent');
  if (CHECKING) {
    // Chromium's own profile (cache, local storage) for the check lives in the check's folder, not in
    // %APPDATA%\G9: a diagnostic must never write into the data of the G9 the person actually uses.
    app.setPath('userData', path.resolve(FLAGS.checkRender, '.electron-user-data'));
    // G9_CHECK_THEME=light|dark renders the check in that scheme regardless of the OS setting.
    if (['light', 'dark'].includes(process.env.G9_CHECK_THEME)) nativeTheme.themeSource = process.env.G9_CHECK_THEME;
    // The check window sits off-screen and transparent; keep Chromium painting it anyway
    // (the same occlusion rules the plan's §2.1 is about, applied to our own window).
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  }

  // Loaded after the lock so a second instance exits before touching anything.
  const { DaemonClient, normalizeHalt } = await import('./lib/daemon-client.mjs');
  const { DaemonLauncher, probeHealth, restartDaemonIfIdle, queryActivity, activityFromHealth, waitForPortFree, mismatchAction } = await import('./lib/daemon-launch.mjs');
  const { DesktopSettings, pickUpdateConfig, detectUpdate } = await import('./lib/settings.mjs');
  const { createLogger, tailLog } = await import('./lib/log.mjs');
  const { UpdateController } = await import('./lib/updater.mjs');
  const { Wizard } = await import('./lib/wizard.mjs');
  const { execReg, elevatedRegBatch } = await import('./lib/policies.mjs');
  const { readRunLocal, readFrame, saveVideo, runDir } = await import('./lib/runs-store.mjs');
  const { iconPng } = await import('./lib/icon.mjs');
  const { readJson } = await import('./lib/jsonfile.mjs');
  const { approvalArgs, normalizeRun } = await import('./renderer/lib/runs.js');
  const { normalizeAgent, normalizeEngine, normalizeTab, pickList } = await import('./renderer/lib/engines.js');
  const { isDuplicateEngineActivity, unwrapEngineActivity, isOwnReadActivity } = await import('./renderer/lib/activity.js');

  const version = app.getVersion();
  const isPackaged = app.isPackaged;
  const port = daemonPort();
  const home = g9Home();
  const layout = homeLayout(home);
  const root = resolveResourceRoot({ isPackaged, resourcesPath: process.resourcesPath, appDir: APP_DIR });
  const resources = resourcePaths(root);
  const log = createLogger(layout.desktopLog);
  const installLog = createLogger(layout.installLog);
  const settings = new DesktopSettings(layout.desktopJson);
  const user = osUserName();
  log.info(`G9 desktop ${version} starting`, { packaged: isPackaged, port, home, resourceRoot: root, pid: process.pid });

  const ctx = {
    win: null,
    tray: null,
    quitting: false,
    watching: new Set(),
    pausedWatches: new Set(),
    daemonHome: home,
    /** `<pid>:<bootId>` of the daemon this app is talking to: handles mean nothing across instances. */
    daemonInstance: null,
    mismatchTried: false,
    mismatchTimer: null,
    store: {
      agents: [],
      engines: [],
      tabs: [],
      activity: [],
      halted: { global: false },
      daemonMismatch: null,
      notices: [],
    },
  };

  // G9_HOME/extension as the daemon sees it (extension.install writes there; welcome.home says where).
  const extensionDir = () => path.join(ctx.daemonHome, 'extension');

  const updateInfo = detectUpdate(settings.get().lastRunVersion, version);
  if (updateInfo.updated) {
    log.info(`Updated from ${updateInfo.from} to ${version}`);
    settings.patch({ pendingExtensionRefresh: true });
  }
  settings.patch({ lastRunVersion: version });

  // ------------------------------------------------------------------ daemon connection

  const launcher = new DaemonLauncher({
    commandOptions: { isPackaged, execPath: process.execPath, resourceRoot: root, home: process.env.G9_HOME || null },
    port,
    log,
    enabled: () => settings.get().startDaemon !== false,
  });
  const client = new DaemonClient({
    port,
    version,
    clientName: 'g9-desktop',
    onRefused: () => launcher.onRefused(),
    onUpgradeRefused: () => launcher.onUpgradeRefused(),
    log,
  });

  // ------------------------------------------------------------------ pushing to the renderer

  // A dialog parented to the window when it is on screen, free-standing when G9 is in the tray.
  const messageBox = (options) => (ctx.win && !ctx.win.isDestroyed() && ctx.win.isVisible() ? dialog.showMessageBox(ctx.win, options) : dialog.showMessageBox(options));


  const push = (topic, data) => {
    const w = ctx.win;
    if (!w || w.isDestroyed()) return;
    w.webContents.send('g9:push', { topic, data });
  };
  let stateTimer = null;
  const snapshot = () => ({
    app: { version, packaged: isPackaged, home: ctx.daemonHome, desktopHome: home, port, user, platform: process.platform, resourceRoot: root },
    connection: client.state,
    halted: ctx.store.halted,
    agents: ctx.store.agents,
    engines: ctx.store.engines,
    tabs: ctx.store.tabs,
    activity: ctx.store.activity.slice(-200),
    daemonMismatch: ctx.store.daemonMismatch,
    notices: ctx.store.notices,
    update: updater.snapshot(),
    wizard: wizard.state(),
    watching: [...ctx.watching],
  });
  const scheduleState = () => {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      push('state', snapshot());
      refreshTray();
    }, 60);
  };

  client.on('state', (s) => {
    if (s.halted) ctx.store.halted = s.halted;
    scheduleState();
  });

  client.on('welcome', (w) => {
    log.info('Connected to the daemon', { id: w.id, version: w.version, pid: w.daemonPid, bootId: w.bootId ?? null });
    // Tab handles belong to ONE daemon instance: a new daemon numbers them from 1 again. Watches
    // kept across a restart were re-sent with the old numbers, and streamed (and spooled) whatever
    // tab the new daemon had numbered 3 — in the person's own browser (desktop review, 2026-09-22).
    const instance = `${w.daemonPid ?? '?'}:${w.bootId ?? w.startedAt ?? '?'}`;
    if (ctx.daemonInstance && ctx.daemonInstance !== instance) {
      const stopped = [...new Set([...ctx.watching, ...ctx.pausedWatches])];
      ctx.watching.clear();
      ctx.pausedWatches.clear();
      if (stopped.length) {
        log.info('The daemon restarted: watches were dropped (tab numbers start again)', { tabs: stopped });
        push('watch', { stopped, reason: 'daemon-restarted' });
      }
    }
    ctx.daemonInstance = instance;
    // The daemon is back (Reconnect, or an agent's shim started it): a hold from an earlier
    // "Shut down daemon" has served its purpose; if this daemon exits later, start it again.
    launcher.release();
    ctx.store.halted = w.halted ?? { global: false };
    onConnected(w).catch((err) => log.warn('Post-connect tasks failed', String(err?.message ?? err)));
    scheduleState();
  });

  client.on('disconnected', () => {
    // Watches die with the socket; the renderer re-requests them after the next welcome.
    push('watch', { reset: true, tabs: [...ctx.watching] });
  });

  client.on('event', ({ topic, data }) => {
    switch (topic) {
      case 'frame':
      case 'pointer':
        // Straight through: frames are the one high-volume stream and must not wait for a state tick.
        if (ctx.win && (ctx.win.isVisible() || CHECKING)) push(topic, data);
        return;
      case 'watchStatus':
        // Whether a watched picture is live (a hidden tab sends no frames): straight to the Watch view.
        push(topic, data);
        return;
      case 'agents':
        ctx.store.agents = pickList(data, 'agents').map(normalizeAgent);
        break;
      case 'engines':
        ctx.store.engines = pickList(data, 'engines').map(normalizeEngine);
        break;
      case 'tabs': {
        // DAEMON_PROTOCOL §5: { engine, tabs } (one engine's complete list) or { gone: tabId, reason }.
        if (data && data.gone != null) {
          ctx.store.tabs = ctx.store.tabs.filter((t) => t.tabId !== Number(data.gone));
          break;
        }
        const rows = pickList(data, 'tabs').map(normalizeTab).filter((t) => Number.isFinite(t.tabId));
        const engineId = data && !Array.isArray(data) ? data.engine ?? data.engineId ?? null : null;
        if (engineId) {
          ctx.store.tabs = [...ctx.store.tabs.filter((t) => t.engineId !== engineId), ...rows.map((t) => ({ ...t, engineId: t.engineId ?? engineId }))];
        } else {
          ctx.store.tabs = rows;
        }
        break;
      }
      case 'activity': {
        // Engine 2's panel broadcasts arrive wrapped (kind 'engine2'): keep only a tool entry.
        const record = unwrapEngineActivity(data);
        // The engine's copy of a call an agent made repeats the daemon's own record of it, and this
        // window's own refresh reads are not agent activity (renderer/lib/activity.js says why).
        if (!record || isDuplicateEngineActivity(record) || isOwnReadActivity(record, client.welcome?.id)) return;
        ctx.store.activity.push({ ...record, receivedAt: Date.now() });
        if (ctx.store.activity.length > 400) ctx.store.activity.splice(0, ctx.store.activity.length - 400);
        break;
      }
      case 'halt':
        // The global part is already folded into the client state; an agent's halt updates its row
        // at once (the 'agents' push that follows says the same).
        if (data?.agentId) {
          ctx.store.agents = ctx.store.agents.map((a) => (a.id === data.agentId ? { ...a, halted: !!data.halted } : a));
        }
        break;
      case 'run':
        notifyRun(data);
        break;
      default:
        break;
    }
    push('event', { topic, data });
    scheduleState();
  });

  function notifyRun(data) {
    // { runId, kind, state:'started'|'finished', scheduleId?, exitCode?, summary? }
    // --check-render: its window is never focused, so every failed run would otherwise raise a real
    // Windows toast on the desktop of whoever runs the check.
    if (CHECKING) return;
    if (data?.state && data.state !== 'finished') return;
    if (data?.kind === 'watch') return;
    const run = normalizeRun({ ...(data?.summary ?? {}), ...(data?.run ?? data ?? {}) });
    if (run.status === 'running' || !run.verdict || run.verdict === 'PASS') return;
    if (ctx.win?.isFocused()) return;
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: `${run.flowName ?? 'A run'}: ${String(run.verdict).replace(/_/g, ' ').toLowerCase()}`,
        body: run.surpriseCount?.total ? `${run.surpriseCount.total} surprise(s) to review.` : 'Open G9 to see the steps.',
        silent: true,
      });
      n.on('click', () => showWindow('runs'));
      n.show();
    } catch {
      /* notifications are a courtesy */
    }
  }

  async function onConnected(welcome) {
    // Where does the daemon keep its data? Runs are read from disk, so this must be the daemon's home
    // (welcome.home; /health for a daemon that does not send it).
    let daemonHome = welcome?.home ?? null;
    if (!daemonHome) {
      const health = await probeHealth(port).catch(() => null);
      if (health?.status === 'g9d') daemonHome = health.body?.home ?? null;
    }
    if (daemonHome) {
      ctx.daemonHome = path.resolve(daemonHome);
      ctx.store.notices = ctx.store.notices.filter((n) => n.id !== 'home');
      if (ctx.daemonHome.toLowerCase() !== path.resolve(home).toLowerCase()) {
        ctx.store.notices.push({ id: 'home', tone: 'warn', text: `The daemon uses G9_HOME ${daemonHome}; this app was started with ${home}. Runs are read from the daemon's folder.` });
      }
    }
    // Watches survive a reconnect only if we ask again.
    if (ctx.win?.isVisible()) for (const tabId of ctx.watching) client.admin('watch', { tabId }).catch(() => ctx.watching.delete(tabId));
    await seedState();
    // The feed URL lives in the daemon's settings: re-read it now, and check at once if this feed
    // was not checked yet (on a first start the local cache is empty until this moment).
    await updater.refresh().catch(() => {});
    // After an app update: refresh G9_HOME/extension so the extension reloads the new code (§8).
    if (settings.get().pendingExtensionRefresh) {
      if (fs.existsSync(path.join(extensionDir(), 'manifest.json'))) {
        try {
          const r = await client.admin('extension.install', {});
          installLog.info('Extension refreshed after the app update', r);
          settings.patch({ pendingExtensionRefresh: false });
        } catch (err) {
          installLog.warn('Extension refresh after the update failed; will retry on the next connect', err.message);
        }
      } else {
        settings.patch({ pendingExtensionRefresh: false }); // never installed: the wizard does it
      }
    }
    await checkDaemonVersion(welcome);
  }

  async function checkDaemonVersion(welcome) {
    const daemonVersion = welcome?.version ?? null;
    if (!daemonVersion || daemonVersion === version) {
      ctx.store.daemonMismatch = null;
      clearTimeout(ctx.mismatchTimer);
      return;
    }
    // Only an older daemon of THIS install is restarted (daemon-launch.mjs mismatchAction).
    const action = mismatchAction({
      daemonVersion,
      appVersion: version,
      daemonRoot: welcome?.repoRoot ?? null,
      appRoot: root,
      startDaemon: settings.get().startDaemon !== false,
    });
    if (action !== 'restart') {
      const why = {
        'notice-newer': `The daemon on port ${port} is v${daemonVersion}, newer than this app (v${version}) — another G9 (a repository checkout) started it. G9 leaves it running.`,
        'notice-other-install': `The daemon on port ${port} (v${daemonVersion}) comes from another G9 install${welcome?.repoRoot ? ` at ${welcome.repoRoot}` : ''}. G9 leaves it running.`,
        'notice-no-autostart': `The daemon on port ${port} is v${daemonVersion} and this app is v${version}, but "Start the daemon" is off, so G9 does not restart it.`,
      }[action];
      ctx.store.daemonMismatch = { daemonVersion, appVersion: version, kind: action, reasons: [why] };
      clearTimeout(ctx.mismatchTimer);
      log.info('Daemon version mismatch left alone', { daemonVersion, appVersion: version, action });
      scheduleState();
      return;
    }
    // An older daemon (from before the update) keeps serving until it is idle — never restarted mid-run.
    if (ctx.mismatchTried) {
      ctx.store.daemonMismatch = { daemonVersion, appVersion: version, reasons: ['a restart was already tried in this session'] };
      scheduleState();
      return;
    }
    const r = await restartDaemonIfIdle(client, launcher, { reason: `daemon ${daemonVersion} ≠ app ${version}`, log, enginesFallback: ctx.store.engines });
    if (r.restarted) {
      ctx.mismatchTried = true;
      ctx.store.daemonMismatch = null;
    } else {
      ctx.store.daemonMismatch = { daemonVersion, appVersion: version, kind: 'restart', reasons: r.activity?.reasons ?? [r.error ?? 'unknown'] };
      clearTimeout(ctx.mismatchTimer);
      ctx.mismatchTimer = setTimeout(() => client.connected && checkDaemonVersion(client.welcome), 60_000);
    }
    scheduleState();
  }

  async function seedState() {
    // The daemon's one-shot first-render state (admin `state`); older daemons: browser_status + tabs list.
    try {
      const st = await client.admin('state', {}, { timeoutMs: 15_000 });
      if (st && typeof st === 'object') {
        if (Array.isArray(st.agents)) ctx.store.agents = st.agents.map(normalizeAgent);
        if (Array.isArray(st.engines)) ctx.store.engines = st.engines.map(normalizeEngine);
        if (Array.isArray(st.tabs)) ctx.store.tabs = st.tabs.map(normalizeTab).filter((t) => Number.isFinite(t.tabId));
        if (st.halted && typeof st.halted === 'object') ctx.store.halted = normalizeHalt({ global: st.halted }, ctx.store.halted);
        if (Array.isArray(st.watching)) for (const h of st.watching) ctx.watching.add(Number(h));
        scheduleState();
        return;
      }
    } catch (err) {
      log.info('admin state unavailable; seeding from browser_status', err.message);
    }
    try {
      const st = await client.call('browser_status', {}, { timeoutMs: 15_000 });
      if (Array.isArray(st?.agents)) ctx.store.agents = st.agents.map(normalizeAgent);
      if (Array.isArray(st?.engines)) ctx.store.engines = st.engines.map(normalizeEngine);
      if (st?.halted && typeof st.halted === 'object') ctx.store.halted = { ...ctx.store.halted, global: !!st.halted.global };
    } catch (err) {
      log.warn('browser_status failed while seeding', err.message);
    }
    try {
      const tl = await client.call('browser_tabs', { action: 'list' }, { timeoutMs: 15_000 });
      const rows = pickList(tl, 'tabs').map(normalizeTab).filter((t) => Number.isFinite(t.tabId));
      if (rows.length || Array.isArray(tl?.tabs)) ctx.store.tabs = rows;
    } catch {
      /* no tab anywhere yet is normal */
    }
    scheduleState();
  }

  // ------------------------------------------------------------------ updater

  const updater = new UpdateController({
    // --check-render never checks, downloads or installs: a feed configured in the daemon it connects
    // to would otherwise download an update and raise the install dialog (focus) over the person's
    // work. The stub keeps the real configure path, so the rail still shows what is configured.
    getAutoUpdater: () => (CHECKING ? checkRenderUpdater() : require('electron-updater').autoUpdater),
    isPackaged,
    currentVersion: version,
    log,
    // The feed this app updates from is the app's OWN setting, not whatever the daemon reports.
    // Every local client of the daemon could write settings.updateUrl, and the app followed it to
    // download and run an installer (desktop review, 2026-09-22). A daemon value that differs from
    // the one this app has is applied only after the person confirms the new host here, in the
    // main process — the Settings view saves through this app, which confirms it as it writes.
    getConfig: async () => {
      const cached = settings.get().update ?? {};
      if (!client.connected) return cached;
      try {
        const s = await client.admin('settings.get', {}, { timeoutMs: 10_000 });
        const cfg = pickUpdateConfig(s, cached);
        if (cfg.source !== 'daemon' || (cfg.url === cached.url && cfg.channel === cached.channel)) return cached.url ? cached : cfg;
        if (!cfg.url) {
          settings.patch({ update: { url: '', channel: cfg.channel } });
          return { ...cfg, url: '' };
        }
        if (await confirmUpdateFeed(cfg.url, cached.url)) {
          settings.patch({ update: { url: cfg.url, channel: cfg.channel } });
          return cfg;
        }
        return cached;
      } catch {
        return cached;
      }
    },
    // electron-updater will not download without app-update.yml, and a build made without a publish
    // feed has none (desktop review, 2026-09-22: every update ended as ENOENT). A minimal one in
    // userData carries the cache folder name the installer itself uses.
    ensureUpdateConfig: () => {
      try {
        const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'app-update.yml') : null;
        if (packaged && fs.existsSync(packaged)) return null;
        const file = path.join(app.getPath('userData'), 'g9-update.yml');
        if (!fs.existsSync(file)) fs.writeFileSync(file, 'updaterCacheDirName: g9-desktop-updater\n', 'utf8');
        return file;
      } catch (err) {
        log.warn('Could not write the update config file', String(err?.message ?? err));
        return null;
      }
    },
    getSkippedVersion: () => settings.get().update?.skipVersion ?? null,
    onSkipVersion: (v) => settings.patch({ update: { ...(settings.get().update ?? {}), skipVersion: v } }),
    queryActivity: async () => {
      if (!client.connected) {
        const h = await probeHealth(port);
        // Our daemon is not running at all → nothing to interrupt. A g9d we are not connected to
        // says in /health what it is running (activeRuns, launched — F6). Anything else → do not guess.
        if (h.status === 'none') return { busy: false, reasons: [] };
        if (h.status === 'g9d') return activityFromHealth(h.body);
        return { busy: true, reasons: ['something other than the G9 daemon answers on its port'] };
      }
      return queryActivity(client, { enginesFallback: ctx.store.engines });
    },
    beforeInstall: async () => {
      if (!client.connected) return;
      try {
        await client.admin('shutdown', {});
      } catch {
        /* the socket closes as it exits */
      }
      client.stop();
      await waitForPortFree(port, { timeoutMs: 15_000 });
    },
    promptInstall: async ({ version: next }) => {
      const r = await messageBox({
        type: 'info',
        title: 'G9 update ready',
        message: `G9 ${next} is downloaded.`,
        detail: 'Installing restarts G9 and the daemon. It waits until no run is in progress and no launched browser is open.',
        // Four answers: closing the dialog means "Not now", and only the first two install.
        buttons: ['Install now', 'Install when I quit G9', 'Not now', 'Skip this version'],
        defaultId: 1,
        cancelId: 2,
      });
      return ['now', 'later', 'no', 'skip'][r.response] ?? 'no';
    },
  });
  updater.on('state', (s) => {
    push('updater', s);
    scheduleState();
  });

  /**
   * A feed URL that arrived from the daemon's settings and is not the one this app has: the person
   * says yes to the new host, in a dialog this process owns, before anything is downloaded from it.
   */
  async function confirmUpdateFeed(next, current) {
    if (CHECKING || !isPackaged) return false;
    let host = next;
    try { host = new URL(next).host; } catch { /* shown as given */ }
    const r = await messageBox({
      type: 'warning',
      title: 'G9 update address changed',
      message: `Download G9 updates from ${host}?`,
      detail: `The G9 daemon's settings now name ${next} as the update address${current ? ` (this app used ${current})` : ''}. ` +
        'An update from there is installed as you, so only accept an address you set yourself.',
      buttons: ['Use this address', 'Keep the current one'],
      defaultId: 1,
      cancelId: 1,
    });
    const ok = r.response === 0;
    log.info(ok ? 'Update feed changed by the person' : 'Update feed change refused', { next, current });
    return ok;
  }

  // ------------------------------------------------------------------ wizard

  const wizard = new Wizard({
    client,
    settings,
    log: installLog,
    layout,
    resources,
    app: { isPackaged, execPath: process.execPath, resourceRoot: root, port, homeOverride: process.env.G9_HOME || null },
    deps: {
      clipboardWrite: (text) => clipboard.writeText(String(text)),
      regRun: (args) => execReg(args),
      regRunElevated: (batch) => elevatedRegBatch(batch),
      user: () => user,
      extensionDir: () => extensionDir(),
    },
  });

  // ------------------------------------------------------------------ IPC

  const ADMIN_ALLOWED = new Set([
    'halt', 'resume', 'haltAgent', 'resumeAgent', 'watch', 'unwatch', 'settings.get', 'settings.set',
    'extension.install', 'extension.reload', 'schedule.list', 'schedule.add', 'schedule.remove', 'schedule.runNow',
    'runs.list', 'runs.get', 'engines.versions', 'engines.installCft', 'profiles.list', 'profiles.warm', 'shutdown',
  ]);
  // Tool calls the renderer may make. Approval is NOT here: it goes through 'approve', where main
  // (not the page) supplies `by`.
  const TOOL_ALLOWED = {
    browser_status: null,
    browser_tabs: new Set(['list']),
    browser_engine: new Set(['launch', 'list', 'stop', 'versions', 'context']),
    browser_recording: new Set(['list', 'get', 'known_world']),
  };

  const runsDir = () => path.join(ctx.daemonHome, 'runs');
  const LOGIN_ARGS = ['--hidden'];
  const loginItem = () => {
    if (!isPackaged) return { supported: false, openAtLogin: false, reason: 'Only an installed G9 can start itself at sign-in; this is a development build.' };
    if (process.platform !== 'win32' && process.platform !== 'darwin') return { supported: false, openAtLogin: false, reason: `Not available on ${process.platform}.` };
    return { supported: true, openAtLogin: !!app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin, reason: null };
  };

  const HANDLERS = {
    state: () => snapshot(),
    reconnect: () => {
      // Reconnect is also how the person asks for the daemon back after "Shut down daemon" — a
      // deliberate press, so the crash-loop cooldown does not apply to it either.
      launcher.release();
      launcher.resetCooldown();
      client.reconnectNow();
      return client.state;
    },
    admin: async ({ op, args }) => {
      if (!ADMIN_ALLOWED.has(op)) throw new Error(`Not an admin operation the app offers: ${op}`);
      // A shutdown the person asked for must not be undone by our own reconnect a second later.
      if (op === 'shutdown') launcher.hold("The daemon was shut down from this app. Press Reconnect to start it again (an agent's next call also starts it).");
      // Recorded BEFORE the call: a pause, a quit or a daemon restart while a watch is still being
      // set up would otherwise not unwatch it, and the tab kept streaming (desktop review).
      if (op === 'watch' && Number.isFinite(Number(args?.tabId))) ctx.watching.add(Number(args.tabId));
      let result;
      try {
        result = await client.admin(op, args ?? {});
      } catch (err) {
        if (op === 'shutdown' && client.connected) launcher.release();
        if (op === 'watch' && Number.isFinite(Number(args?.tabId))) ctx.watching.delete(Number(args.tabId));
        throw err;
      }
      if (op === 'shutdown') log.info('Daemon shut down from the desktop', { by: user });
      if (op === 'unwatch') ctx.watching.delete(Number(args?.tabId));
      if (op === 'settings.set') {
        // Saved through this app: the person chose this feed, so it needs no second confirmation.
        const url = args?.patch?.updateUrl;
        if (typeof url === 'string') settings.patch({ update: { ...(settings.get().update ?? {}), url: url.trim(), skipVersion: null } });
        const channel = args?.patch?.updateChannel;
        if (typeof channel === 'string') settings.patch({ update: { ...(settings.get().update ?? {}), channel } });
        updater.refresh().catch(() => {});
      }
      if (op === 'halt' || op === 'resume') log.info(`Global ${op} from the desktop`, { by: user });
      return result;
    },
    call: async ({ tool, args }) => {
      if (!(tool in TOOL_ALLOWED)) throw new Error(`Not a tool the app calls: ${tool}`);
      const allowed = TOOL_ALLOWED[tool];
      if (allowed && !allowed.has(String(args?.action ?? ''))) throw new Error(`${tool} action "${args?.action}" is not available here.`);
      const result = await client.call(tool, args ?? {});
      // A list the page asked for is also the freshest state: fold it in for every view.
      if (tool === 'browser_tabs' && args?.action === 'list') {
        const rows = pickList(result, 'tabs').map(normalizeTab).filter((t) => Number.isFinite(t.tabId));
        if (rows.length || Array.isArray(result?.tabs) || Array.isArray(result)) ctx.store.tabs = rows;
        scheduleState();
      } else if (tool === 'browser_engine' && args?.action === 'list') {
        const rows = pickList(result, 'engines').map(normalizeEngine);
        // browser_engine lists launched engines; keep the extension engines the events reported.
        const keep = ctx.store.engines.filter((e) => e.kind !== 'launched' && !rows.some((r) => r.engineId === e.engineId));
        if (rows.length || Array.isArray(result?.engines) || Array.isArray(result)) ctx.store.engines = [...keep, ...rows];
        scheduleState();
      }
      return result;
    },
    approve: async ({ flowId, runId, note, engine, expectLastRunAt }) => {
      const args = approvalArgs({ flowId, by: user, note, runId, engine, expectLastRunAt });
      log.info('Approval', { flowId, runId, by: user, expectLastRunAt: args.expectLastRunAt ?? null });
      const result = await client.call('browser_recording', args);
      installLog.info(`Known world approved for ${flowId} by ${user}`, { runId });
      return result;
    },
    // runs.get plus what only the disk has: a scheduled run's runner report (every flow, its steps
    // and surprises). Read from the run's own folder under the daemon's G9_HOME, never a path the
    // page supplies.
    'runs.detail': async ({ runId }) => {
      const got = await client.admin('runs.get', { runId });
      const report = readJson(path.join(runDir(runsDir(), runId), 'report', 'run.json'), null);
      return { ...(got ?? {}), report };
    },
    'runs.local': ({ runId }) => readRunLocal(runsDir(), runId),
    'runs.frame': ({ runId, file }) => readFrame(runsDir(), runId, file),
    'runs.saveVideo': ({ runId, bytes }) => {
      const r = saveVideo(runsDir(), runId, bytes);
      log.info('Video exported', r);
      return r;
    },
    // A scheduled run's runner report (report/report.html, self-contained). Opened by the OS in the
    // person's default browser — never in an Electron window (the shell loads only its own files).
    'runs.openReport': async ({ runId }) => {
      const file = path.join(runDir(runsDir(), runId), 'report', 'report.html');
      if (!fs.existsSync(file)) throw new Error('This run has no report.html: the runner did not get as far as writing one. The run folder has what it left.');
      const err = await shell.openPath(file);
      if (err) throw new Error(err);
      return { path: file };
    },
    'runs.openFolder': async ({ runId }) => {
      const dir = runDir(runsDir(), runId);
      const err = await shell.openPath(dir);
      if (err) throw new Error(err);
      return { path: dir };
    },
    'updater.state': () => updater.snapshot(),
    'updater.check': () => updater.check({ manual: true }),
    'updater.install': () => updater.installWhenIdle(),
    'desktop.get': () => settings.get(),
    // Start at sign-in, in the tray (--hidden). Schedules run only while the daemon runs, and after
    // a reboot nothing else starts it. Installed builds only: a development build would register
    // electron.exe without this app's folder, which starts an empty Electron at every sign-in.
    'desktop.loginItem.get': () => loginItem(),
    'desktop.loginItem.set': ({ enabled }) => {
      if (!loginItem().supported) throw new Error(loginItem().reason);
      app.setLoginItemSettings({ openAtLogin: !!enabled, args: LOGIN_ARGS });
      log.info(`Start at sign-in ${enabled ? 'on' : 'off'}`);
      return loginItem();
    },
    'desktop.patch': (patch) => {
      const allowed = {};
      if (typeof patch?.lastView === 'string') allowed.lastView = patch.lastView.slice(0, 40);
      if (typeof patch?.startDaemon === 'boolean') allowed.startDaemon = patch.startDaemon;
      return settings.patch(allowed);
    },
    open: async ({ what }) => {
      const targets = { logs: layout.logs, home: ctx.daemonHome, extension: extensionDir(), installLog: layout.installLog };
      const target = targets[what];
      if (!target) throw new Error(`Nothing to open called ${what}`);
      if (!fs.existsSync(target)) throw new Error(`${target} does not exist yet.`);
      const err = await shell.openPath(target);
      if (err) throw new Error(err);
      return { path: target };
    },
    'wizard.state': () => wizard.state(),
    'wizard.mark': ({ step, ok, skipped, summary }) => wizard.mark(step, { ok: !!ok, skipped: !!skipped, summary: summary ? String(summary).slice(0, 300) : null }),
    'wizard.log': () => tailLog(layout.installLog, 200),
    'wizard.browsers': () => wizard.browsers(),
    'wizard.installCft': ({ version: v }) => wizard.installCft(v),
    'wizard.profile': () => wizard.profile(),
    'wizard.warm': ({ name, url }) => wizard.warmProfile({ name, url }),
    'wizard.policies': () => wizard.policies(),
    'wizard.applyPolicies': ({ elevate }) => wizard.applyPolicies({ elevate: !!elevate }),
    'wizard.undoPolicies': ({ elevate }) => wizard.undoPolicies({ elevate: !!elevate }),
    'wizard.mcp': () => wizard.mcp(),
    'wizard.registerMcp': ({ client: id, confirmReplace, confirmDropComments }) => wizard.registerMcp(id, { confirmReplace: !!confirmReplace, confirmDropComments: !!confirmDropComments }),
    'wizard.removeMcp': ({ client: id, confirmDropComments }) => wizard.removeMcp(id, { confirmDropComments: !!confirmDropComments }),
    'wizard.extension': () => wizard.extension(),
    'wizard.installExtension': () => wizard.installExtension(),
    'wizard.openExtensionsPage': ({ kind }) => wizard.openExtensionsPage(kind === 'chrome' ? 'chrome' : 'edge'),
  };

  ipcMain.handle('g9', async (event, op, args) => {
    // Only our own page may call. (There is no other page, but the check costs nothing.)
    const from = event.senderFrame?.url ?? '';
    if (!from.startsWith('g9app://app/')) return { ok: false, error: 'Refused: not the G9 window.' };
    const handler = Object.hasOwn(HANDLERS, op) ? HANDLERS[op] : null;
    if (!handler) return { ok: false, error: `Unknown operation ${op}` };
    try {
      return { ok: true, result: await handler(args ?? {}) };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });

  // ------------------------------------------------------------------ window, protocol, tray

  await app.whenReady();

  const CSP = [
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:",
    "font-src 'self'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; ');
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

  protocol.handle('g9app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(RENDERER_DIR, rel));
    if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // No page may ask for anything: camera, notifications, clipboard-read, geolocation, …
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (e, url) => {
      if (!url.startsWith('g9app://app/')) e.preventDefault();
    });
  });

  if (isPackaged) Menu.setApplicationMenu(null);

  const appIcon = nativeImage.createFromBuffer(iconPng(256, 'connected'));
  const trayImages = {};
  const trayImage = (state) => {
    if (!trayImages[state]) {
      const img = nativeImage.createEmpty();
      img.addRepresentation({ scaleFactor: 1, buffer: iconPng(16, state) });
      img.addRepresentation({ scaleFactor: 1.5, buffer: iconPng(24, state) });
      img.addRepresentation({ scaleFactor: 2, buffer: iconPng(32, state) });
      trayImages[state] = img;
    }
    return trayImages[state];
  };

  function createWindow() {
    const saved = settings.get().window ?? {};
    // 1100×720 by default (the layout is made for it), the person's own size after a resize, and
    // never larger than the screen's work area: a 1366×768 laptop at 150 % has ~910×490 DIP, and a
    // window forced to 1100×720 there opens with its controls off-screen.
    const area = (() => {
      try {
        return screen.getPrimaryDisplay().workAreaSize;
      } catch {
        return { width: 1100, height: 720 };
      }
    })();
    const fit = (want, min, max) => Math.max(Math.min(min, max), Math.min(Number.isFinite(want) ? want : min, max));
    const win = new BrowserWindow({
      width: fit(saved.width ?? 1100, 960, area.width),
      height: fit(saved.height ?? 720, 620, area.height),
      minWidth: Math.min(960, area.width),
      minHeight: Math.min(620, area.height),
      show: false,
      title: `G9 ${version}`,
      icon: appIcon,
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#161b24' : '#f3f5f8',
      // --check-render: never on screen, never focused, not in the taskbar.
      ...(CHECKING ? { x: -32000, y: -32000, opacity: 0, skipTaskbar: true, focusable: false } : {}),
      webPreferences: {
        preload: path.join(APP_DIR, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: !isPackaged,
        backgroundThrottling: !CHECKING,
      },
    });
    win.on('page-title-updated', (e) => e.preventDefault());
    // Windows sign-out, restart or shutdown: 'before-quit' is not emitted then, so without this the
    // 'close' handler below would keep refusing to close (hide-to-tray) and hold the sign-out up.
    win.on('query-session-end', () => { ctx.quitting = true; });
    win.on('session-end', () => { ctx.quitting = true; });
    win.on('close', (e) => {
      if (ctx.quitting) return;
      // Closing the window keeps G9 in the tray: the daemon connection, schedule and updater stay up.
      e.preventDefault();
      const [width, height] = win.getSize();
      settings.patch({ window: { width, height } });
      win.hide();
    });
    // Frames nobody can see still cost the browser a screencast: pause watches while the window is
    // hidden or minimized, and ask for them again when it comes back.
    win.on('hide', () => pauseWatches('hidden'));
    win.on('minimize', () => pauseWatches('minimized'));
    win.on('show', () => resumeWatches());
    win.on('restore', () => resumeWatches());
    win.on('closed', () => {
      ctx.win = null;
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error('The window renderer went away; reloading', details);
      if (!win.isDestroyed()) win.reload();
    });
    win.once('ready-to-show', () => {
      if (CHECKING) {
        win.showInactive(); // off-screen and transparent: painting, but nothing a person can see
        return;
      }
      if (!FLAGS.hidden || !settings.get().wizard?.completedAt) win.show();
    });
    win.loadURL('g9app://app/index.html');
    return win;
  }

  function showWindow(view) {
    if (!ctx.win || ctx.win.isDestroyed()) ctx.win = createWindow();
    if (ctx.win.isMinimized()) ctx.win.restore();
    ctx.win.show();
    ctx.win.focus();
    if (view) push('navigate', { view });
  }

  function stopAllWatches(reason) {
    const tabs = [...new Set([...ctx.watching, ...ctx.pausedWatches])];
    ctx.pausedWatches.clear();
    if (!ctx.watching.size) return;
    for (const tabId of ctx.watching) client.admin('unwatch', { tabId }).catch(() => {});
    ctx.watching.clear();
    push('watch', { stopped: tabs, reason });
  }

  function pauseWatches(reason) {
    if (!ctx.watching.size) return;
    for (const tabId of ctx.watching) {
      ctx.pausedWatches.add(tabId);
      client.admin('unwatch', { tabId }).catch(() => {});
    }
    ctx.watching.clear();
    push('watch', { paused: [...ctx.pausedWatches], reason });
    log.info(`Watch paused (${reason})`, { tabs: [...ctx.pausedWatches] });
  }

  function resumeWatches() {
    if (!ctx.pausedWatches.size || !client.connected) return;
    const tabs = [...ctx.pausedWatches];
    ctx.pausedWatches.clear();
    for (const tabId of tabs) {
      client.admin('watch', { tabId }).then(() => ctx.watching.add(tabId)).catch(() => {});
    }
    push('watch', { resumed: tabs });
  }

  function trayState() {
    const s = client.state;
    if (s.status === 'foreign') return 'attention';
    if (s.status !== 'connected') return 'offline';
    return ctx.store.halted?.global ? 'halted' : 'connected';
  }

  function statusText() {
    const s = client.state;
    switch (s.status) {
      case 'connected': return ctx.store.halted?.global ? 'stopped' : `connected, ${ctx.store.agents.length} agent${ctx.store.agents.length === 1 ? '' : 's'}`;
      case 'starting': return 'starting the daemon';
      case 'foreign': return `port ${port} is in use`;
      case 'refused': return 'daemon refused the connection';
      default: return 'daemon not connected';
    }
  }

  let lastTrayKey = '';
  function refreshTray() {
    if (!ctx.tray) return;
    const state = trayState();
    const connected = client.state.status === 'connected';
    const halted = !!ctx.store.halted?.global;
    const key = `${state}|${statusText()}|${connected}|${halted}`;
    if (key === lastTrayKey) return;
    lastTrayKey = key;
    ctx.tray.setImage(trayImage(state));
    ctx.tray.setToolTip(`G9 ${version} — ${statusText()}`);
    ctx.tray.setContextMenu(Menu.buildFromTemplate([
      { label: `G9 ${version} — ${statusText()}`, enabled: false },
      { type: 'separator' },
      { label: 'Open G9', click: () => showWindow() },
      { label: 'Watch a tab', click: () => showWindow('watch') },
      { type: 'separator' },
      { label: 'Stop all agents', enabled: connected && !halted, click: () => client.admin('halt', {}).then(() => log.info('Global halt from the tray', { by: user })).catch((e) => log.warn('halt failed', e.message)) },
      { label: 'Resume', enabled: connected && halted, click: () => client.admin('resume', {}).then(() => log.info('Resume from the tray', { by: user })).catch((e) => log.warn('resume failed', e.message)) },
      { type: 'separator' },
      { label: 'Quit G9', click: () => quitApp() },
    ]));
  }

  async function quitApp() {
    const outcome = await updater.onQuit().catch(() => 'none');
    if (outcome === 'installing') {
      ctx.quitting = true;
      return; // quitAndInstall exits the app
    }
    if (outcome === 'deferred') {
      const reasons = updater.snapshot().reasons ?? [];
      const r = await messageBox({
        type: 'question',
        title: 'G9 update waiting',
        message: 'An update is ready, but the daemon is busy.',
        detail: `${reasons.join('; ')}.\n\nInstalling restarts the daemon, which would stop that work. Quit now and the update installs the next time you quit while nothing runs, or keep G9 in the tray and it installs as soon as the daemon is idle.`,
        buttons: ['Quit without updating', 'Install when idle'],
        defaultId: 1,
        cancelId: 1,
      });
      if (r.response === 1) {
        updater.installWhenIdle().catch(() => {});
        return;
      }
    }
    ctx.quitting = true;
    stopAllWatches('quit');
    updater.stop();
    client.stop();
    log.info('G9 desktop quitting (the daemon keeps serving agents)');
    app.quit();
  }

  showWindowRef = showWindow;
  app.on('before-quit', () => {
    ctx.quitting = true;
  });
  app.on('window-all-closed', () => {
    /* stay in the tray */
  });

  if (!CHECKING) {
    ctx.tray = new Tray(trayImage('offline'));
    ctx.tray.on('click', () => showWindow());
    ctx.tray.on('double-click', () => showWindow());
    refreshTray();
  }

  ctx.win = createWindow();
  if (showWindowLater) showWindow();
  if (!settings.get().wizard?.completedAt && !CHECKING) {
    ctx.win.webContents.once('did-finish-load', () => push('navigate', { view: 'setup', firstRun: true }));
  }

  client.start();
  updater.start();
  if (CHECKING) runRenderCheck(ctx.win, push, FLAGS.checkRender).then((r) => printAndExit(r, (c) => app.exit(c)));
}

/** An autoUpdater for --check-render that never touches the network: the state stays 'idle'. */
function checkRenderUpdater() {
  const { EventEmitter } = require('node:events');
  const u = new EventEmitter();
  u.setFeedURL = () => {};
  u.checkForUpdates = async () => null;
  u.quitAndInstall = () => {};
  return u;
}

/**
 * `--check-render <dir>`: a diagnostic for the integration stage. The window is shown inactive at
 * -32000,-32000, transparent and unfocusable (createWindow), so Chromium paints it while no person
 * can see it or lose the keyboard to it (test/render-check.mjs samples both for the whole run);
 * every view is opened in turn, its console errors are collected and a picture of it is written
 * to <dir>/<view>.png. Prints one JSON line and exits. No tray, no single-instance lock.
 */
async function runRenderCheck(win, push, dir) {
  const fsP = fs.promises;
  await fsP.mkdir(dir, { recursive: true });
  const problems = [];
  win.webContents.on('console-message', (...a) => {
    // Electron ≥ 35 passes one event object; older versions pass (event, level, message, line, source).
    const e = a[0];
    const level = e?.level ?? a[1];
    const message = e?.message ?? a[2];
    const source = e?.sourceId ?? a[4];
    if (level === 'error' || level === 'warning' || level === 3 || level === 2) problems.push({ level, message: String(message), source });
  });
  win.webContents.on('preload-error', (_e, p, err) => problems.push({ level: 'error', message: `preload ${p}: ${err?.message}` }));
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1500);
  const shots = [];
  // The Watch picker's tab options (not the "No tabs to watch" placeholder), counted in the page.
  const PICKER_OPTIONS = "[...document.querySelectorAll('#view-watch select option')].filter((o) => o.value !== '').length";
  const pickerOptions = { first: null, second: null };
  const views = ['agents', 'engines', 'watch', 'runs', 'approvals', 'schedule', 'settings', 'setup'];
  const scripted = {
    // Start watching the first tab, so the picture shows frames and the drawn cursor.
    watch: "document.querySelector('#view-watch .watch-bar .btn.primary')?.click()",
    // Open the newest finished flow run and its replay. Not a watch session: the Watch step above
    // has just recorded one (the newest row), and its replay is a still picture with no cursor.
    runs: "(async () => { const rows = [...document.querySelectorAll('#view-runs tbody tr')]; (rows.find((r) => !/in progress|Watch session/.test(r.textContent)) ?? rows.find((r) => !/in progress/.test(r.textContent)) ?? rows[0])?.click(); await new Promise(r => setTimeout(r, 700)); [...document.querySelectorAll('#view-runs .subtabs button')].at(-1)?.click(); })()",
  };
  const shoot = async (name) => {
    const image = await win.webContents.capturePage();
    const file = path.join(dir, `${name}.png`);
    await fsP.writeFile(file, image.toPNG());
    shots.push({ view: name, file, size: image.getSize() });
  };
  for (const view of views) {
    push('navigate', { view });
    await wait(900);
    if (scripted[view]) {
      await win.webContents.executeJavaScript(scripted[view]).catch((err) => problems.push({ level: 'error', message: `script for ${view}: ${err.message}` }));
      await wait(1800);
    }
    await shoot(view);
    // Sideways overflow is what a person misses most easily in a picture (a sliver of scrollbar):
    // measured instead. Anything wider than the main area, or than the window, is an error.
    const over = await win.webContents.executeJavaScript("(() => { const m = document.getElementById('main'); const d = document.documentElement; return { main: m.scrollWidth - m.clientWidth, page: d.scrollWidth - d.clientWidth }; })()").catch(() => null);
    if (over && (over.main > 1 || over.page > 1)) problems.push({ level: 'error', message: `${view}: content wider than the window (main +${over.main}px, page +${over.page}px)` });
    if (view === 'watch') {
      // How many tabs the picker offered on this first visit (compared with a second visit below).
      pickerOptions.first = await win.webContents.executeJavaScript(PICKER_OPTIONS).catch(() => null);
      // The "not live" banner and the HIDDEN marker, drawn over a real frame: the watched tab is
      // told hidden exactly as the daemon's watchStatus event says it (engine watchdog, P8 matrix
      // B5), then live again. Only the renderer hears it; nothing reaches the daemon or the tab.
      const tabId = Number(await win.webContents.executeJavaScript("document.querySelector('#view-watch select')?.value ?? ''").catch(() => ''));
      if (Number.isFinite(tabId) && tabId > 0) {
        // First the real thing: a static page sends no frames, so after ~2 s the engine's watchdog
        // reports 'idle' (visible). That is pictured as it arrives (HUD: IDLE, no banner), and waiting
        // for it also keeps it from landing on top of the hidden picture below (seen in round 3).
        await wait(2600);
        await shoot('watch-idle');
        push('watchStatus', { tabId, state: 'hidden', reason: 'The tab is hidden (document.visibilityState="hidden").' });
        await wait(300);
        await shoot('watch-hidden');
        push('watchStatus', { tabId, state: 'live' });
        await wait(200);
      }
    }
    // Long views: one more picture per screenful, up to six (Settings and Setup run past three).
    for (let page = 2; page <= 6; page++) {
      const more = await win.webContents.executeJavaScript("(() => { const m = document.getElementById('main'); if (m.scrollTop + m.clientHeight >= m.scrollHeight - 4) return false; m.scrollTop += m.clientHeight - 40; return true; })()");
      if (!more) break;
      await wait(300);
      await shoot(`${view}-${page}`);
    }
    await win.webContents.executeJavaScript("document.getElementById('main').scrollTop = 0");
    if (view === 'runs') {
      // The other two tabs of the same run, then the first scheduled run (a runner report).
      for (const [i, name] of [[0, 'runs-steps'], [1, 'runs-surprises']]) {
        await win.webContents.executeJavaScript(`document.querySelectorAll('#view-runs .subtabs button')[${i}]?.click()`).catch(() => {});
        await wait(700);
        await shoot(name);
      }
      const opened = await win.webContents.executeJavaScript("(() => { const r = [...document.querySelectorAll('#view-runs tbody tr')].find((x) => /Scheduled/.test(x.textContent)); r?.click(); return !!r; })()").catch(() => false);
      if (opened) {
        await wait(1200);
        await shoot('runs-scheduled');
        // Its surprises, as the runner's report lists them.
        await win.webContents.executeJavaScript("document.querySelectorAll('#view-runs .subtabs button')[1]?.click()").catch(() => {});
        await wait(700);
        await shoot('runs-scheduled-surprises');
      }
    }
  }
  // Later visits to Watch with the same tabs must offer the same picker. mount() builds a new
  // <select>, and a module-level key once left it empty when a visit that watched nothing was
  // followed by another one (round 3): so two more visits, the last one pictured.
  for (let visit = 0; visit < 2; visit++) {
    push('navigate', { view: 'agents' });
    await wait(400);
    push('navigate', { view: 'watch' });
    await wait(900);
  }
  pickerOptions.second = await win.webContents.executeJavaScript(PICKER_OPTIONS).catch(() => null);
  await shoot('watch-again');
  if (pickerOptions.first !== pickerOptions.second) {
    problems.push({ level: 'error', message: `Watch picker on a later visit: ${pickerOptions.second} tab option(s), first visit ${pickerOptions.first}` });
  }
  return { ok: problems.filter((p) => p.level === 'error' || p.level === 3).length === 0, problems, shots, pickerOptions };
}
