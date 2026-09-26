/**
 * EngineManager — Engine 2 inside the daemon (ARCHITECTURE §7).
 *
 * Engine 2 is a real Chrome/Edge/Chrome-for-Testing process that the daemon
 * launched (engine/launch.js) and drives over a CDP pipe. The tools that run on
 * it are NOT a second implementation: they are the very `extension/tools/*.js`
 * modules the extension runs, imported here with `platform-cdp` selected
 * (no `chrome` global in Node). One tool layer, two engines (decision D2).
 *
 * This file is the glue that makes that true:
 *   - configures platform-cdp: daemon-wide tab handles (`allocTabId` from the
 *     registry, so a handle means the same tab to every agent), file-backed
 *     storage and blobs (daemon/storage.js), the downloads `fileInfo` hook
 *     (daemon/evidence.js), broadcasts → UI activity;
 *   - wires the CDP event fan-out (extension/tools/events.js) exactly as sw.js
 *     does for the extension;
 *   - owns launch/stop, browser contexts, per-target defaults, the parallelism
 *     limit, evidence runs for replays, and handoff import.
 *
 * Every shared module is imported LAZILY (init()): a daemon whose Engine 2
 * cannot load — a broken build, a missing file mid-upgrade — must still serve
 * the extension and answer browser_status with the reason, not crash at start.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromeCookiesToCdp, seedStorageScript, storageEntries, originOf, NOT_TRANSFERRED } from '../daemon/handoff.js';
import { fallbackIsReadOnly } from '../daemon/router.js';
import { fileInfo as defaultFileInfo } from '../daemon/evidence.js';

const EXT = new URL('../extension/', import.meta.url);
const ENGINE = new URL('./', import.meta.url);

const pick = (mod, name) => mod?.[name] ?? mod?.default?.[name];

/**
 * (3.2) G9_LAUNCH_ARGS, the switches every Engine 2 launch on this machine gets: a JSON array, or
 * switches separated by spaces (none may contain one). Only `--` switches are kept.
 */
export function launchArgsFromEnv(env = process.env) {
  const raw = String(env.G9_LAUNCH_ARGS ?? '').trim();
  if (!raw) return [];
  let list;
  try {
    list = raw.startsWith('[') ? JSON.parse(raw) : raw.split(/\s+/);
  } catch {
    list = raw.split(/\s+/);
  }
  return (Array.isArray(list) ? list : []).map(String).filter((s) => s.startsWith('--'));
}

export class EngineManager {
  /**
   * @param {object} o
   * @param {string} o.home          G9_HOME
   * @param {import('../daemon/registry.js').Registry} o.registry
   * @param {(...a) => void} o.log
   * @param {(event: string, data: object) => void} o.emit   daemon event sink
   * @param {import('../daemon/settings.js').Settings} [o.settings]
   * @param {import('../daemon/evidence.js').Evidence} [o.evidence]
   * @param {{ local, session, blobs }} [o.storage]
   * @param {string} [o.version]
   */
  constructor({ home, registry, log = () => {}, emit = () => {}, settings = null, evidence = null, storage = null, version = '0.0.0', fileInfo = defaultFileInfo }) {
    this.home = home;
    this.registry = registry;
    this.log = log;
    this.emit = emit;
    this.settings = settings;
    this.evidence = evidence;
    this.storage = storage;
    this.version = version;
    this.fileInfo = fileInfo;

    this.engines = new Map(); // engineId → { info, launched, conn, contexts: Map, defaultContextId, initialBlank, closing }
    this.ready = null;
    this.initError = null;
    this.cdp = null;
    this.tools = null;
    this.events = null;
    this.optional = {}; // screencast, pointer, state, store — each may be missing
    this.lastTabId = null;
    this.lastEngineId = null;
    this.active = 0;
    this.waiters = [];
    this.watches = new Map(); // `${tabId}\u0000${consumer}` → { unsubscribePointer }
    this.watchChain = new Map(); // `${tabId}\u0000${consumer}` → Promise: that consumer's watch changes, one at a time (watch())
    this.launching = new Map(); // profile name → Promise<EngineInfo> while a launch is in progress
    this.prepared = new Map(); // tabId → Promise: that tab's defaults applied and tool layer attached (#prepareTab)
    this.localeRetry = new Map(); // tabId → locale refused while the tab shared its opener's renderer
  }

  // ------------------------------------------------------------ loading

  #settings() {
    return this.settings?.get?.() ?? { humanize: 'human', stealth: 'off', headless: true, defaultBrowser: 'auto', maxParallel: 8, evidence: {} };
  }

  /** Load and wire the shared tool runtime. Never throws; failures are recorded. */
  init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      try {
        const [cdp, tools, events] = await Promise.all([
          import(new URL('lib/platform-cdp.js', EXT).href),
          import(new URL('tools/index.js', EXT).href),
          import(new URL('tools/events.js', EXT).href),
        ]);
        this.cdp = cdp;
        this.tools = tools;
        this.events = events;
        for (const [key, rel] of [['screencast', 'lib/screencast.js'], ['pointer', 'lib/pointer.js'], ['state', 'lib/state.js'], ['store', 'lib/store.js'], ['humanize', 'lib/humanize.js'], ['world', 'lib/world.js'], ['cdpLayer', 'lib/cdp.js'], ['tabsTool', 'tools/tabs.js'], ['replay', 'tools/replay.js'], ['flowsync', 'lib/flowsync.js']]) {
          try {
            this.optional[key] = await import(new URL(rel, EXT).href);
          } catch (err) {
            this.log(`[engine2] optional module ${rel} unavailable: ${err.message}`);
          }
        }
        this.#configure();
        this.#wire();
        this.initError = null;
        this.log('[engine2] shared tool runtime loaded (platform-cdp)');
      } catch (err) {
        this.initError = err;
        this.log(`[engine2] UNAVAILABLE: ${err?.stack ?? err}`);
      }
    })();
    return this.ready;
  }

  available() {
    return this.ready !== null && this.initError === null && this.cdp !== null;
  }

  unavailableReason() {
    return this.initError ? `Engine 2 could not load its tool runtime: ${this.initError.message}` : null;
  }

  async #requireReady() {
    await this.init();
    if (this.initError || !this.cdp) {
      throw new Error(
        `Launched browsers (Engine 2) are unavailable in this daemon: ${this.initError?.message ?? 'not initialised'}. ` +
          'The extension (Engine 1) still works. Check the daemon log in the G9 data folder.',
      );
    }
  }

  #configure() {
    const configure = pick(this.cdp, 'configure');
    if (typeof configure !== 'function') throw new Error('extension/lib/platform-cdp.js exports no configure()');
    const s = this.#settings();
    configure({
      allocTabId: () => this.registry.allocHandle(),
      ...(this.storage?.local ? { storageLocal: this.storage.local } : {}),
      ...(this.storage?.session ? { storageSession: this.storage.session } : {}),
      ...(this.storage?.blobs ? { blobs: this.storage.blobs } : {}),
      version: this.version,
      onBroadcast: (message) => this.emit('activity', { kind: 'engine2', message }),
      defaults: { humanize: s.humanize, stealth: s.stealth },
      fileInfo: (file) => this.fileInfo(file),
      // Run while a new target is HELD, before its first script (platform-cdp resumes it after).
      prepareTab: (tabId) => this.#prepareTab(tabId),
      prepareChild: (tabId, child) => this.#prepareChild(tabId, child),
    });
  }

  /** Settings changed (humanize/stealth defaults): push the new defaults into platform-cdp. */
  reconfigure() {
    if (this.available()) {
      try { this.#configure(); } catch (err) { this.log(`[engine2] reconfigure failed: ${err.message}`); }
    }
  }

  #wire() {
    const platform = pick(this.cdp, 'platform');
    // (3.2) An approval in the launched-engine store (an agent's, the runner's) travels with the
    // flow: the daemon writes it beside the flow in the repository (daemon.js).
    pick(this.optional.replay, 'onApproved')?.((id) => (typeof this.onApproved === 'function' ? this.onApproved(id) : null));
    const { onCdpEvent, onDetach, onTabRemoved } = {
      onCdpEvent: pick(this.events, 'onCdpEvent'),
      onDetach: pick(this.events, 'onDetach'),
      onTabRemoved: pick(this.events, 'onTabRemoved'),
    };

    platform.debugger.onEvent((source, method, params) => {
      try {
        onCdpEvent?.(source, method, params);
      } catch (err) {
        this.log(`[engine2] event handler failed for ${method}: ${err.message}`);
      }
      // The daemon must hear about a dialog directly: it fails every pending
      // call on that tab now instead of letting each sit to its timeout.
      if (method === 'Page.javascriptDialogOpening' && source?.tabId != null) {
        this.emit('dialog', { tabId: source.tabId, type: params?.type, message: params?.message });
      }
      // A popup whose locale override was refused while it shared its opener's process (see
      // #prepareTab) gets it again once its own document has committed in a process of its own.
      if (method === 'Page.frameNavigated' && !source?.sessionId && !params?.frame?.parentId && this.localeRetry.has(source?.tabId)) {
        this.#retryLocale(source.tabId);
      }
    });
    platform.debugger.onDetach((source, reason) => {
      Promise.resolve(onDetach?.(source, reason)).catch(() => {});
    });
    platform.tabs.onRemoved((tabId) => {
      Promise.resolve(onTabRemoved?.(tabId)).catch(() => {});
      this.registry.dropHandle(tabId, 'the tab closed');
      this.prepared.delete(tabId);
      this.localeRetry.delete(tabId);
      if (this.lastTabId === tabId) this.lastTabId = null;
    });
    // The handle is bound at once. The tab's defaults are NOT applied from here any more: this ran
    // when the target was announced, raced its page session (an explicit second attach), and for a
    // tab the PAGE opened it landed after the first document had run — the persona's timezone
    // arrived late and the first load's network was never captured (Engine 2 live test, round 3).
    // platform-cdp now holds every new page and calls #prepareTab before it runs.
    platform.tabs.onCreated((tab) => {
      const info = this.#tabInfo(tab?.id);
      if (!info) return;
      this.registry.bindHandle(tab.id, info.engineId);
    });

    const setHooks = pick(this.tools, 'setHooks');
    setHooks?.({
      // status(args) says which tab it reports on (F4): name THAT tab's engine.
      // Without a tab, the most recently used engine, as before — with several
      // launched browsers the daemon's own `engine` field stays authoritative.
      connection: ({ tabId = null } = {}) => {
        const byTab = tabId != null ? this.engines.get(this.engineOfTab(tabId)) : null;
        const engine = byTab ?? this.engines.get(this.lastEngineId) ?? [...this.engines.values()][0];
        return {
          engine: 'launched',
          engineId: engine?.info.engineId ?? null,
          browser: engine ? { kind: engine.info.browser, version: engine.info.version, headless: engine.info.headless } : null,
          daemon: { version: this.version },
        };
      },
      emit: (event, data) => {
        // Dialogs are taken from the raw CDP event above; screencast frames and
        // pointer samples from direct subscriptions — never counted twice.
        if (event === 'dialog' || event === 'frame' || event === 'pointer') return;
        if (event === 'download') {
          for (const run of this.#runsForTab(data?.tabId)) this.evidence?.download(run, data);
        }
        this.emit(event, data ?? {});
      },
    });
  }

  #tabInfo(tabId) {
    if (tabId == null || !this.cdp) return null;
    try {
      return pick(this.cdp, 'tabInfo')(tabId) ?? null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ queries

  owns(tabId) {
    return !!this.#tabInfo(tabId);
  }

  /** Is this URL a page the tools can drive (not edge://downloads-hub, chrome://…)? The tools' own rule (tabs.js isAttachable). */
  #attachableUrl(url) {
    const fn = pick(this.optional.tabsTool, 'isAttachable');
    if (typeof fn === 'function') {
      try { return !!fn(url ?? ''); } catch { /* fall through */ }
    }
    return !/^(edge|chrome|devtools|chrome-extension|chrome-untrusted|edge-untrusted):/i.test(String(url ?? ''));
  }

  /**
   * Can an agent be handed this launched tab by default? Not a browser-internal page: Edge opens
   * edge://downloads-hub/ by itself after a download, and an agent given that tab as its default
   * had every action refused (Engine 2 live test).
   */
  isControllable(tabId) {
    const info = this.#tabInfo(tabId);
    return !!info && this.#attachableUrl(info.url ?? '');
  }

  engineOfTab(tabId) {
    return this.#tabInfo(tabId)?.engineId ?? null;
  }

  isReadOnlyFn() {
    return pick(this.tools, 'isReadOnly') ?? null;
  }

  isReadOnly(tool, args) {
    const fn = this.isReadOnlyFn();
    try {
      return fn ? !!fn(tool, args ?? {}) : fallbackIsReadOnly(tool, args ?? {});
    } catch {
      return fallbackIsReadOnly(tool, args ?? {});
    }
  }

  /** Does this call take a maxParallel slot? (tools/index.js holdsSlot; without it, every mutating call.) */
  holdsSlot(tool, args) {
    const fn = pick(this.tools, 'holdsSlot');
    try {
      if (typeof fn === 'function') return !!fn(tool, args ?? {});
    } catch { /* fall through to the conservative answer */ }
    return !this.isReadOnly(tool, args);
  }

  list() {
    return [...this.engines.values()].map((e) => this.#infoOf(e));
  }

  #infoOf(e) {
    return {
      ...e.info,
      // An engine still being set up, or being stopped, is listed as such: nothing may be handed it.
      ...(e.ready === false ? { starting: true } : {}),
      ...(e.closing ? { stopping: true } : {}),
      contexts: [...e.contexts.values()].map((c) => ({ ...c })),
      tabs: this.registry.handlesOf(e.info.engineId),
    };
  }

  #requireEngine(engineId) {
    const e = this.engines.get(engineId);
    if (!e) {
      const known = [...this.engines.keys()];
      throw new Error(`No launched engine "${engineId}".${known.length ? ` Running: ${known.join(', ')}.` : ' None is running; browser_engine action:"launch" starts one.'}`);
    }
    return e;
  }

  /**
   * An engine a public call may use: its setup has FINISHED (waited for when it is still running)
   * and it is not being stopped. The engine is in `this.engines` from the moment the browser
   * answers, because its own setup looks it up there — but until `ready`, its default context
   * (and so every tab's stealth level) is unknown. A second agent's open that landed in that
   * window got a tab the start-up stray sweep then closed ('No tab with id'), or a stealth
   * engine's tab with Runtime enabled (engine review, 2026-09-22: B's open 725-1043 ms into a
   * 1.1-1.7 s launch, 3/3 runs). A stopping engine was handed out too, and failed with
   * 'Unknown engine'.
   */
  async #usableEngine(engineId) {
    const e = this.#requireEngine(engineId);
    const stopping = () => new Error(`Launched engine "${engineId}" is stopping. Use another engine (browser_engine action:"list"), or open the tab again once it is gone — a new one is launched then.`);
    if (e.closing) throw stopping();
    if (e.ready === false) await e.readyPromise;
    if (e.closing) throw stopping();
    return e;
  }

  /**
   * The engine a call that names none should use: the first launched engine that is ready and not
   * stopping — after any launch in progress has finished — else the default engine, launched
   * (reuse: two agents opening their first tab at once share one browser). The router's default
   * for open/context/replay and the handoff's receiver.
   */
  async defaultEngineId({ launch = true } = {}) {
    await Promise.all([...this.launching.values()].map((p) => Promise.resolve(p).catch(() => {})));
    for (const e of this.engines.values()) if (e.ready !== false && !e.closing) return e.info.engineId;
    const starting = [...this.engines.values()].find((e) => e.ready === false && !e.closing);
    if (starting) {
      await starting.readyPromise?.catch(() => {});
      if (starting.ready !== false && !starting.closing) return starting.info.engineId;
    }
    if (!launch) return null;
    return (await this.launch({ reuse: true })).engineId;
  }

  /** The launched tab an agent without a current tab should act on: the last one opened or focused. */
  currentTab() {
    const usable = (tabId) => {
      const e = this.engines.get(this.engineOfTab(tabId));
      return !!e && e.ready !== false && !e.closing && this.isControllable(tabId);
    };
    if (this.lastTabId != null && usable(this.lastTabId)) return this.lastTabId;
    for (const e of this.engines.values()) {
      if (e.ready === false || e.closing) continue;
      const tabs = this.registry.handlesOf(e.info.engineId);
      for (let i = tabs.length - 1; i >= 0; i--) if (this.isControllable(tabs[i])) return tabs[i];
    }
    return null;
  }

  /** Rows for browser_tabs list, straight from platform-cdp (no tool call, works while halted). */
  async listTabs() {
    if (!this.available()) return [];
    const platform = pick(this.cdp, 'platform');
    const rows = [];
    for (const e of this.engines.values()) {
      for (const tabId of this.registry.handlesOf(e.info.engineId)) {
        const tab = await platform.tabs.get(tabId).catch(() => null);
        if (!tab) continue;
        const info = this.#tabInfo(tabId);
        rows.push({
          tabId,
          title: tab.title ?? '',
          url: tab.url ?? '',
          active: !!tab.active,
          windowId: tab.windowId ?? null,
          status: tab.status ?? null,
          openerTabId: tab.openerTabId ?? null,
          attached: true,
          // The tools refuse browser-internal pages (edge://downloads-hub/ …); the list says so.
          attachable: this.#attachableUrl(tab.url ?? ''),
          engine: e.info.engineId,
          contextId: info?.browserContextId ?? null,
        });
      }
    }
    return rows;
  }

  // ------------------------------------------------------------ engine modules

  async #engineModules() {
    try {
      const [launch, profile, stealth] = await Promise.all([
        import(new URL('launch.js', ENGINE).href),
        import(new URL('profile.js', ENGINE).href),
        import(new URL('stealth.js', ENGINE).href),
      ]);
      return { launch, profile, stealth };
    } catch (err) {
      throw new Error(`The engine launcher could not be loaded (${err.message}).`);
    }
  }

  // ------------------------------------------------------------ launch / stop

  /**
   * Launch a browser on a profile. `reuse:true` returns the engine already on
   * that profile — including one whose launch is still in progress: two agents
   * opening their first tab at the same moment used to start two browsers on
   * one user-data-dir, and the second one handed its command line to the first
   * and died ("did not become ready"). One launch per profile at a time.
   */
  async launch(opts = {}) {
    await this.#requireReady();
    const profileName = String(opts.profile ?? 'automation');
    for (const e of this.engines.values()) {
      if (e.info.profile === profileName) {
        if (e.closing) {
          // Being stopped: the profile is free once it is gone — then this launch goes on.
          await e.gone?.catch(() => {});
          continue;
        }
        if (opts.reuse) {
          // Its launch may still be setting it up: hand it out only when that has finished.
          if (e.ready === false) return this.launching.get(profileName) ?? e.readyPromise.then(() => this.#infoOf(e));
          return this.#infoOf(e);
        }
        throw new Error(
          `Profile "${profileName}" is already in use by ${e.info.engineId} — a browser profile can be open in one browser at a time. ` +
            `Use that engine, stop it, or launch with another profile.`,
        );
      }
    }
    const inProgress = this.launching.get(profileName);
    if (inProgress) {
      if (opts.reuse) return inProgress;
      throw new Error(
        `Profile "${profileName}" is being launched right now by another call — a browser profile can be open in one browser at a time. ` +
          'Wait for it and use that engine (browser_engine action:"list"), or launch with another profile.',
      );
    }
    const launching = this.#launch(profileName, opts);
    this.launching.set(profileName, launching);
    try {
      return await launching;
    } finally {
      this.launching.delete(profileName);
    }
  }

  async #launch(profileName, opts) {
    const s = this.#settings();
    const stealth = opts.stealth ?? s.stealth;
    const humanize = opts.humanize ?? s.humanize;
    const headless = opts.headless ?? s.headless;
    const browser = opts.browser ?? s.defaultBrowser ?? 'auto';
    const { launch, profile, stealth: stealthMod } = await this.#engineModules();

    // A profile is a PERSONA (docs/STEALTH.md: "keep one profile per persona"): a locale or
    // timezone given at launch is saved into its metadata, and a launch that gives none uses the
    // saved ones. It has to be this way round, because the languages below are written into the
    // profile's own Preferences and stay there: a German launch followed by a plain one would
    // otherwise give a browser that speaks German (navigator.languages, Accept-Language) with an
    // English Intl — the very contradiction §6.4 forbids.
    const persona = {};
    if (opts.locale) persona.locale = opts.locale;
    if (opts.timezone) persona.timezone = opts.timezone;
    const prof = await pick(profile, 'ensure')(profileName, { home: this.home, ...persona });
    const locale = opts.locale ?? prof?.meta?.locale ?? null;
    const timezone = opts.timezone ?? prof?.meta?.timezone ?? null;
    let warnings = [];

    // Is a browser ACCOUNT signed in to this profile? (live round 2: Edge signed every new
    // profile into the Windows account and synced it; launch.js now prevents that from a
    // profile's first start, but cannot sign out a profile that already is.)
    const signIn = await Promise.resolve(pick(profile, 'signInState')?.(profileName, { home: this.home })).catch(() => null);
    if (signIn?.signedIn) {
      const why =
        `Profile "${profileName}" is signed in to a browser account (the browser's own Microsoft/Google account — ` +
        'Edge used to sign new profiles into the Windows account by itself). A launched engine on it would pull that ' +
        "account's synced data (passwords, history, open tabs, extensions) into agent runs, and the synced extensions " +
        'inject scripts into every page. Sync stays off in launched engines (--disable-sync), but the account and ' +
        'whatever it already synced are in the profile. Sign out in that profile (browser_engine action:"warm", then ' +
        "the browser's profile menu, Sign out), or use a new profile — new profiles no longer sign in.";
      if (stealth === 'stealth') throw new Error(`${why} Refused at stealth "stealth": a signed-in profile is not a clean environment.`);
      warnings.push(why);
    }

    // The profile's languages follow the persona's locale. Emulation.setLocaleOverride (applied
    // per tab below) changes Intl only; navigator.language(s) and the Accept-Language header come
    // from the profile's intl.accept_languages, and --lang is ignored by a profile that already has
    // one (live round 2: locale de-DE gave Intl de-DE with navigator.languages ['en-US','en'] and
    // Accept-Language "en-US,en;q=0.9", 6/6 runs). intl.selected_languages is written too: Chrome
    // recomputes accept_languages from it when it is set.
    let acceptLanguage = null;
    const current = await Promise.resolve(pick(profile, 'readPreferences')?.(profileName, { home: this.home })).catch(() => null);
    const patch = {};
    if (locale) {
      const wanted = acceptLanguagesFor(locale);
      const have = current?.intl ?? {};
      if (wanted && (have.accept_languages !== wanted || (have.selected_languages != null && have.selected_languages !== wanted))) {
        patch['intl.accept_languages'] = wanted;
        patch['intl.selected_languages'] = wanted;
      }
      acceptLanguage = wanted;
    }
    // Edge opens its own edge://downloads-hub/ tab after a download — a browser-internal page every
    // tool refuses, which then became an agent's default tab. Measured (Engine 2 live test, Edge
    // 153): this preference, written before launch, suppresses it (1 → 1 tabs; the
    // ShowDownloadsHubPopup* features and the "completed" preference did not). Chrome ignores it.
    if (current?.browser?.show_hub_popup_on_download_start !== false) patch['browser.show_hub_popup_on_download_start'] = false;
    // A second barrier behind the per-context Browser.setDownloadBehavior (#configureDownloads):
    // the profile's own download folder is G9's, never the Windows user's Downloads, and no
    // save-as prompt opens. Written only when it differs.
    const profileDownloads = path.join(this.home, 'downloads', `profile-${safeName(profileName)}`);
    if (current?.download?.default_directory !== profileDownloads) patch['download.default_directory'] = profileDownloads;
    if (current?.download?.prompt_for_download !== false) patch['download.prompt_for_download'] = false;
    await fsp.mkdir(profileDownloads, { recursive: true }).catch(() => {});
    if (Object.keys(patch).length) {
      try {
        await pick(profile, 'applyPreferences')(profileName, patch, { home: this.home });
      } catch (err) {
        warnings.push(`The profile's preferences could not be written (${err.message})` +
          (patch['intl.accept_languages'] ? `; navigator.languages and Accept-Language keep the profile's own instead of ${patch['intl.accept_languages']}.` : '.'));
      }
    }
    if (!acceptLanguage) {
      // What the browser will actually send: the profile's own setting, read from the file (the
      // metadata only mirrors what G9 itself wrote there).
      acceptLanguage = current?.intl?.accept_languages ?? prof?.meta?.acceptLanguage ?? prof?.meta?.preferences?.['intl.accept_languages'] ?? null;
    }
    try {
      warnings.push(...(pick(stealthMod, 'checkConsistency')?.({ locale, timezone, acceptLanguage }) ?? []));
    } catch (err) {
      warnings.push(`consistency check failed: ${err.message}`);
    }

    // The previous run's tabs are not reopened (Chrome for Testing restored them on every relaunch).
    await Promise.resolve(pick(profile, 'clearSessionRestore')?.(profileName, { home: this.home }))
      .catch((err) => this.log(`[engine2] could not clear the previous session of profile ${profileName}: ${err.message}`));

    const engineId = this.registry.nextLaunchedId();
    const startedAt = Date.now();
    const launched = await pick(launch, 'launchBrowser')({
      browser,
      headless,
      profileDir: prof.dir,
      windowSize: opts.windowSize,
      proxy: opts.proxy,
      proxyBypass: opts.proxyBypass,
      lang: locale ?? undefined,
      // (3.2) G9_LAUNCH_ARGS: switches every launch on this machine needs, before the caller's —
      // in a container, `--no-sandbox` (the container is the sandbox; Chromium's own needs user
      // namespaces a container does not give). launchBrowser refuses the same switches as always.
      extraArgs: [...launchArgsFromEnv(), ...(Array.isArray(opts.extraArgs) ? opts.extraArgs : [])],
      stealth,
      home: this.home,
      name: opts.name,
    });
    if (Array.isArray(launched.warnings)) warnings = [...launched.warnings, ...warnings];
    const conn = launched.conn;

    let markReady;
    let markFailed;
    const readyPromise = new Promise((resolve, reject) => { markReady = resolve; markFailed = reject; });
    readyPromise.catch(() => {}); // awaited by whoever needs it; an unawaited failure is not unhandled
    let markGone;
    const gone = new Promise((resolve) => { markGone = resolve; });
    const engine = {
      launched,
      conn,
      contexts: new Map(),
      defaultContextId: null,
      initialBlank: null,
      closing: false,
      // Set once the default context (and so every tab's stealth level) is known: #prepareTab
      // leaves the start-up tab alone until then, and no public call is handed this engine
      // (#usableEngine, defaultEngineId) before it.
      ready: false,
      readyPromise,
      gone,
      markGone,
      info: {
        engineId,
        kind: 'launched',
        name: opts.name ?? null,
        browser: launched.browser?.kind ?? browser,
        browserPath: launched.browser?.path ?? null,
        version: launched.browser?.version ?? null,
        headless,
        profile: profileName,
        profileDir: prof.dir,
        pid: launched.pid ?? null,
        argv: launched.argv ?? [],
        stealth,
        humanize,
        locale,
        timezone,
        ...(acceptLanguage ? { acceptLanguage } : {}),
        startedAt,
        ...(warnings.length ? { warnings } : {}),
      },
    };
    this.engines.set(engineId, engine);
    this.registry.addLaunchedEngine(engine.info);
    conn.on?.('close', () => this.#onClosed(engineId));

    try {
      // platform-cdp creates the hidden image context itself, before any
      // target exists, so its utility page can never be mistaken for a tab.
      // headless: a tab behind another in its window is brought to the front before input only when
      // there is no person to see it (platform-cdp tabs.ensureFront).
      await pick(this.cdp, 'registerEngine')(engineId, conn, { headless: !!headless });

      // The default browser context is the PROFILE (its cookies, its history —
      // what "warm profile" means).
      const defaultContextId = await this.#discoverDefaultContext(engineId, conn);
      const downloadPath = path.join(this.home, 'downloads', safeName(defaultContextId ?? `${engineId}-default`));
      if (defaultContextId) pick(this.cdp, 'registerContext')(engineId, defaultContextId, { humanize, stealth, downloadPath });
      pick(this.cdp, 'setDefaultContext')?.(engineId, null);
      engine.defaultContextId = defaultContextId ?? `${engineId}:default`;
      // #prepareTab needs the context registered before it prepares a tab; the engine is only handed
      // out (ready) after the downloads and window below, but tabs it opens itself are prepared now.
      engine.contextsReady = true;
      engine.contexts.set(engine.defaultContextId, {
        contextId: engine.defaultContextId,
        engineId,
        isDefault: true,
        humanize,
        stealth,
        locale,
        timezone,
        proxy: opts.proxy ?? null,
        downloadPath,
      });
      // Unwatched downloads land in G9's own folder, not the owner's (engine review, 2026-09-22:
      // a click on an attachment link with no watch_downloads saved the file into the profile's
      // default directory — the Windows user's Downloads — and G9 had no record of it).
      await this.#configureDownloads(engineId, defaultContextId, downloadPath);
      for (const tabId of this.registry.handlesOf(engineId)) await this.#applyTabDefaults(tabId).catch(() => {});
      if (!headless && !opts.windowSize) {
        const fitted = await this.#fitWindowToWorkArea(engineId).catch((err) => {
          this.log(`[engine2] ${engineId}: could not fit the window to the screen's work area: ${err.message}`);
          return null;
        });
        if (fitted) engine.info.window = fitted;
      }
      engine.ready = true;
      markReady();
    } catch (err) {
      this.log(`[engine2] ${engineId} failed during setup: ${err.message}`);
      const failure = new Error(`The browser started but could not be set up for automation: ${err.message}`);
      markFailed(failure);
      await this.stop(engineId).catch(() => {});
      throw failure;
    }

    await this.#writeEngineLog(engine);
    this.log(`[engine2] ${engineId} launched ${engine.info.browser} ${engine.info.version ?? ''} (pid ${engine.info.pid}, ${headless ? 'headless' : 'headed'}, profile ${profileName}, stealth ${stealth})`);
    this.emit('engines', { engines: this.list() });
    return this.#infoOf(engine);
  }

  /**
   * The default context's id (Chrome 128+ reports it directly), and the
   * browser's start-up about:blank page — reused by the first `open`, so a
   * launch does not leave an orphan blank tab behind every run. The start-up
   * page attaches asynchronously, so give it a moment to arrive.
   */
  async #discoverDefaultContext(engineId, conn) {
    const engine = this.engines.get(engineId);
    let contextId = null;
    try {
      contextId = (await conn.send('Target.getBrowserContexts', {}))?.defaultBrowserContextId ?? null;
    } catch {
      contextId = null;
    }
    const platform = pick(this.cdp, 'platform');
    const deadline = Date.now() + 1_500;
    let tabs = [];
    while (Date.now() < deadline) {
      tabs = pick(this.cdp, 'tabsOf')(engineId) ?? [];
      if (tabs.length) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const strays = [];
    for (const tabId of tabs) {
      this.registry.bindHandle(tabId, engineId);
      const info = this.#tabInfo(tabId);
      contextId ??= info?.browserContextId ?? null;
      // A page G9 itself created (platform-cdp createTab) is never a start-up stray, whoever asked
      // for it: the sweep closed another agent's freshly opened tab (engine review, 2026-09-22).
      if (info?.createdByG9) continue;
      const tab = await platform.tabs.get(tabId).catch(() => null);
      if (engine && engine.initialBlank == null && tab && /^about:blank/.test(tab.url ?? 'about:blank')) engine.initialBlank = tabId;
      else if (tab) strays.push({ tabId, url: tab.url ?? '' });
    }
    // Every page at start-up other than G9's own about:blank is one nobody asked for: a restored
    // session (Chrome for Testing reopened the previous run's tabs on every relaunch, and one of
    // them ended up in front of the agent's — live round 2), a sync or onboarding page. Closed, and
    // named in the launch result, so no agent inherits a tab that loads sites on its own and no
    // stray page sits in front of the agent's. (profile.clearSessionRestore removes the cause; this
    // catches whatever else a browser decides to open.)
    if (engine && strays.length && engine.initialBlank != null) {
      for (const stray of strays) {
        await platform.tabs.remove(stray.tabId).catch(() => {});
        this.registry.dropHandle?.(stray.tabId, 'closed at launch: a page G9 did not open');
      }
      engine.info.closedAtLaunch = strays.map((s) => s.url);
      const note = `Closed ${strays.length} page(s) the browser opened by itself at start-up (${strays.map((s) => s.url || 'about:blank').slice(0, 4).join(', ')}${strays.length > 4 ? ', …' : ''}).`;
      engine.info.warnings = [...(engine.info.warnings ?? []), note];
    }
    if (contextId) return contextId;
    try {
      const tabId = await this.#createTarget(engineId, null, 'about:blank');
      this.registry.bindHandle(tabId, engineId);
      if (engine) engine.initialBlank = tabId;
      return this.#tabInfo(tabId)?.browserContextId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A headed launch without an explicit windowSize: make the window fit the screen's WORK AREA
   * (the screen less the taskbar), as a person's browser does — maximized or not, it never sits
   * under the taskbar. The launch asks for 1920×1080 (launch.js DEFAULT_WINDOW), which on a
   * 1920×1080 monitor with a taskbar is taller than the work area: outerHeight 1080 against
   * screen.availHeight 1032, a consistency tell a detector can compute (stealth suite, round 3:
   * 16/16 headed runs). Only the SIZE changes — never the position (a window launched off-screen
   * stays there) and never the focus. Later windows copy these bounds (platform-cdp createTabIn).
   * The screen is the one the window is on (its centre), else the primary one. An explicit
   * windowSize is the caller's and is left exactly as asked.
   */
  async #fitWindowToWorkArea(engineId) {
    const e = this.engines.get(engineId);
    const platform = pick(this.cdp, 'platform');
    const tabId = e?.initialBlank ?? this.registry.handlesOf(engineId)[0] ?? null;
    if (!e || tabId == null) return null;
    const info = this.#tabInfo(tabId);
    if (!info?.targetId) return null;
    const { windowId, bounds } = await e.conn.send('Browser.getWindowForTarget', { targetId: info.targetId }, null, { timeoutMs: 3_000 });
    if (!bounds || bounds.windowState !== 'normal') return null;
    let screens = [];
    try {
      screens = (await platform.debugger.sendCommand(tabId, 'Emulation.getScreenInfos', {}, null, { timeoutMs: 3_000 }))?.screenInfos ?? [];
    } catch {
      screens = [];
    }
    if (!screens.length) {
      // Older builds: the start-up page (about:blank, G9's isolated world) reads the screen it is on.
      const inWorld = pick(this.optional.world, 'inWorld');
      const s = typeof inWorld === 'function'
        ? await inWorld(tabId, '({ availLeft: screen.availLeft, availTop: screen.availTop, availWidth: screen.availWidth, availHeight: screen.availHeight })', { timeoutMs: 3_000 }).catch(() => null)
        : null;
      if (s) screens = [{ ...s, isPrimary: true }];
    }
    const cx = bounds.left + bounds.width / 2;
    const cy = bounds.top + bounds.height / 2;
    const contains = (s) => cx >= s.left && cx < s.left + s.width && cy >= s.top && cy < s.top + s.height;
    const screen = screens.find((s) => Number.isFinite(s.left) && contains(s)) ?? screens.find((s) => s.isPrimary) ?? screens[0];
    const availWidth = Math.floor(Number(screen?.availWidth));
    const availHeight = Math.floor(Number(screen?.availHeight));
    if (!(availWidth > 0 && availHeight > 0)) return null;
    const width = Math.min(bounds.width, availWidth);
    const height = Math.min(bounds.height, availHeight);
    if (width === bounds.width && height === bounds.height) return { width, height, changed: false };
    await e.conn.send('Browser.setWindowBounds', { windowId, bounds: { width, height } }, null, { timeoutMs: 3_000 });
    this.log(`[engine2] ${engineId}: window ${bounds.width}x${bounds.height} → ${width}x${height} (the screen's work area is ${availWidth}x${availHeight})`);
    return { width, height, changed: true, from: { width: bounds.width, height: bounds.height }, workArea: { width: availWidth, height: availHeight } };
  }

  async #writeEngineLog(engine) {
    const { info } = engine;
    const dir = path.join(this.home, 'engines', 'log');
    const file = path.join(dir, `${info.engineId}.json`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      // engineIds restart at launched-1 with every daemon; keep the earlier file.
      try {
        const old = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (old?.startedAt && old.startedAt !== info.startedAt) await fsp.rename(file, path.join(dir, `${info.engineId}.${old.startedAt}.json`));
      } catch { /* none */ }
      await fsp.writeFile(file, `${JSON.stringify({
        engineId: info.engineId,
        daemonVersion: this.version,
        browser: { kind: info.browser, path: info.browserPath, version: info.version },
        headless: info.headless,
        profile: info.profile,
        stealth: info.stealth,
        humanize: info.humanize,
        pid: info.pid,
        argv: info.argv,
        startedAt: info.startedAt,
        startedAtIso: new Date(info.startedAt).toISOString(),
        stoppedAt: info.stoppedAt ?? null,
      }, null, 2)}\n`);
      if (!info.stoppedAt) {
        // One line format for the whole file: engine/cft.js appendVersionLog writes
        // "ISO<TAB>event<TAB>kind version<TAB>key=value…" for installs, and launches
        // go through the same function rather than a second hand-rolled layout.
        const { appendVersionLog } = await import(new URL('cft.js', ENGINE).href);
        await appendVersionLog({
          home: this.home,
          event: 'launch',
          kind: info.browser,
          version: info.version ?? null,
          engineId: info.engineId,
          path: info.browserPath ?? null,
          daemon: this.version,
          headless: info.headless,
          stealth: info.stealth,
        });
      }
    } catch (err) {
      this.log(`[engine2] could not write the engine log: ${err.message}`);
    }
  }

  async stop(engineId) {
    const e = this.#requireEngine(engineId);
    e.closing = true;
    try {
      pick(this.cdp, 'unregisterEngine')?.(engineId);
    } catch (err) {
      this.log(`[engine2] unregister ${engineId}: ${err.message}`);
    }
    try {
      await e.launched.close?.();
    } catch (err) {
      this.log(`[engine2] close ${engineId}: ${err.message}`);
    }
    await this.#cleanup(engineId, 'the launched engine was stopped');
  }

  #onClosed(engineId) {
    const e = this.engines.get(engineId);
    if (!e || e.closing) return;
    e.closing = true;
    this.log(`[engine2] ${engineId} exited on its own (crash, or its window was closed)`);
    try { pick(this.cdp, 'unregisterEngine')?.(engineId); } catch { /* gone */ }
    this.#cleanup(engineId, 'the launched browser exited').catch(() => {});
  }

  async #cleanup(engineId, reason) {
    const e = this.engines.get(engineId);
    if (!e) return;
    this.engines.delete(engineId);
    e.markGone?.();
    e.info.stoppedAt = Date.now();
    this.emit('engineGone', { engineId, reason });
    this.registry.removeLaunchedEngine(engineId, reason);
    if (this.lastEngineId === engineId) this.lastEngineId = null;
    await this.#writeEngineLog(e);
    this.emit('engines', { engines: this.list() });
  }

  async shutdown() {
    await Promise.all([...this.engines.keys()].map((id) => this.stop(id).catch(() => {})));
  }

  // ------------------------------------------------------------ contexts and tabs

  async createContext(engineId, opts = {}) {
    await this.#requireReady();
    const e = await this.#usableEngine(engineId);
    const stealthLevel = opts.stealth ?? e.info.stealth;
    // A context's locale can change Intl (Emulation.setLocaleOverride) but not the languages the
    // browser reports: navigator.language(s) and Accept-Language come from the PROFILE
    // (intl.accept_languages), which a context shares. A per-tab Emulation.setUserAgentOverride
    // with acceptLanguage was measured (Edge 153, 2026-09-22): the page and its requests said
    // fr-FR, but its dedicated WORKER still said en-US (navigator.languages and the worker's own
    // request header) — a contradiction of its own, exactly what a detector compares. So a context
    // locale whose language differs from the profile's is reported (and refused at stealth); a
    // consistent persona is a profile launched with that locale.
    const warnings = [];
    if (opts.locale) {
      // A profile that never set languages sends the browser's UI language, which is the system's.
      let hostLocale = null;
      try { hostLocale = Intl.DateTimeFormat().resolvedOptions().locale; } catch { hostLocale = null; }
      const profileLanguages = e.info.acceptLanguage ?? (hostLocale ? acceptLanguagesFor(hostLocale) : null);
      const problems = [];
      try {
        const { stealth: stealthMod } = await this.#engineModules();
        problems.push(...(pick(stealthMod, 'checkConsistency')?.({ locale: opts.locale, timezone: opts.timezone ?? null, acceptLanguage: profileLanguages }) ?? []));
      } catch (err) {
        problems.push(`consistency check failed: ${err.message}`);
      }
      // Another LANGUAGE is the contradiction; the same language in another region is a warning.
      const clash = problems.find((p) => /^Accept-Language starts with/.test(p) && !/same language, different region/.test(p));
      if (clash) {
        const why =
          `${clash} In a context only Intl follows the locale: navigator.languages and the Accept-Language header stay the ` +
          `profile's (${profileLanguages}), because they belong to the profile, and a per-tab override does not reach the ` +
          `page's workers. For a consistent persona, launch a profile with this locale (browser_engine action:"launch" ` +
          `profile:"<name>" locale:"${opts.locale}").`;
        if (stealthLevel === 'stealth') throw new Error(`${why} Refused at stealth "stealth": the page would see two languages.`);
        warnings.push(why);
      }
      warnings.push(...problems.filter((p) => p !== clash));
    }
    // The ENVIRONMENT half of stealth belongs to the browser, not to a context: navigator.webdriver
    // is cleared only by a launch switch (the debugging pipe itself turns AutomationControlled on,
    // decision D-a), and Edge/Chrome keep Widevine off below stealth (component updates are off).
    // A stealth context in an engine launched below stealth gets the context half — no Runtime
    // domain, the stealth input floor — and every page in it still reports navigator.webdriver
    // true (docs review, 2026-09-22: the page said webdriver=true while browser_console said
    // "Runtime domain disabled by stealth level"). Said, and recorded on the context
    // (environmentStealth), so an agent never takes it for a stealth browser.
    if (stealthLevel === 'stealth' && e.info.stealth !== 'stealth') {
      warnings.push(
        `${engineId} was launched at stealth "${e.info.stealth ?? 'off'}", so every page in this context still reports ` +
          'navigator.webdriver true (the debugging pipe sets it; only a launch at stealth clears it), and Edge/Chrome have no ' +
          'Widevine there (component updates are off below stealth). This context only gets stealth\'s Runtime and input ' +
          'rules. For a stealth browser, launch one: browser_engine action:"launch" stealth:"stealth" profile:"<another ' +
          'profile>" (a profile can be open in one browser at a time).',
      );
    }
    const params = { disposeOnDetach: false };
    if (opts.proxy) params.proxyServer = opts.proxy;
    if (opts.proxyBypass) params.proxyBypassList = opts.proxyBypass;
    const { browserContextId } = await e.conn.send('Target.createBrowserContext', params);
    const humanize = opts.humanize ?? e.info.humanize;
    const stealth = opts.stealth ?? e.info.stealth;
    const downloadPath = opts.downloadPath ?? path.join(this.home, 'downloads', safeName(browserContextId));
    pick(this.cdp, 'registerContext')(engineId, browserContextId, { humanize, stealth, downloadPath });
    const downloadWarning = await this.#configureDownloads(engineId, browserContextId, downloadPath);
    if (downloadWarning) warnings.push(downloadWarning);
    const ctx = {
      contextId: browserContextId,
      engineId,
      isDefault: false,
      humanize,
      stealth,
      // The browser's own level: navigator.webdriver and Widevine follow it, not the context's.
      environmentStealth: e.info.stealth ?? 'off',
      locale: opts.locale ?? null,
      timezone: opts.timezone ?? null,
      proxy: opts.proxy ?? null,
      downloadPath,
    };
    e.contexts.set(browserContextId, ctx);
    this.emit('engines', { engines: this.list() });
    return { ...ctx, ...(warnings.length ? { warnings } : {}) };
  }

  /**
   * Point a context's downloads at G9's own folder, with events on, from the moment it exists —
   * not only after a watch_downloads: until then the browser used the profile's default directory
   * (the owner's Downloads) and told G9 nothing. `allowAndName` saves each file under its GUID, as
   * watch_downloads always has. Returns a warning when the browser refused; never throws.
   */
  async #configureDownloads(engineId, browserContextId, downloadPath) {
    const configure = pick(this.cdp, 'configureContextDownloads');
    if (typeof configure !== 'function' || !downloadPath) return null;
    try {
      await fsp.mkdir(downloadPath, { recursive: true }).catch(() => {});
      await configure(engineId, browserContextId ?? null, { downloadPath });
      return null;
    } catch (err) {
      const warning = `Downloads could not be pointed at ${downloadPath} (${err.message}); a download started without ` +
        'browser_network action:"watch_downloads" may land in the browser profile\'s default folder.';
      this.log(`[engine2] ${engineId}: ${warning}`);
      const e = this.engines.get(engineId);
      if (e) e.info.warnings = [...(e.info.warnings ?? []), warning];
      return warning;
    }
  }

  #contextOf(tabId) {
    const info = this.#tabInfo(tabId);
    if (!info) return null;
    const e = this.engines.get(info.engineId);
    if (!e) return null;
    return e.contexts.get(info.browserContextId) ?? (info.browserContextId == null ? e.contexts.get(e.defaultContextId) : null) ?? e.contexts.get(e.defaultContextId) ?? null;
  }

  /**
   * Per-target defaults (as Playwright does, AIGuide §2.8.1): focus emulation always — a headless page
   * otherwise reports no focus, and focus-dependent UI behaves unlike a
   * person's browser; locale/timezone only when the context asked for them
   * (setting them "to the default" is itself a fingerprint).
   */
  async #applyTabDefaults(tabId) {
    const platform = pick(this.cdp, 'platform');
    // A tab can be announced a moment before its page session exists;
    // attach is idempotent in platform-cdp and waits for that session.
    await platform.debugger.attach(tabId).catch(() => {});

    const send = (method, params) => platform.debugger.sendCommand(tabId, method, params);
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch((err) => this.log(`[engine2] focus emulation on tab ${tabId}: ${err.message}`));
    const ctx = this.#contextOf(tabId);
    if (ctx?.locale) await send('Emulation.setLocaleOverride', { locale: ctx.locale }).catch(() => {});
    if (ctx?.timezone) await send('Emulation.setTimezoneOverride', { timezoneId: ctx.timezone }).catch(() => {});
  }

  /**
   * The TOOL layer's attach (lib/cdp.js) for a tab about to be navigated: the level's domains
   * (Network, Log, DOM …; never Runtime at stealth) and auto-attach to cross-origin frames, BEFORE
   * the first document loads. It used to happen on the first tool call — after openTab had already
   * navigated — so the first load's requests were missing from browser_network and
   * browser_diagnose, and a cross-origin iframe that loaded with the page was never attached
   * (Engine 2 live test).
   *
   * Only here, where the tab's context is registered — NEVER from #applyTabDefaults: that also runs
   * for the start-up tab while the engine is still being registered, before its context (and so
   * its stealth level) is known, and lib/cdp.js then decides "not stealth" and enables Runtime —
   * which the stealth self-test's console probe caught at once (live round 3, every stealth run).
   */
  async #attachTools(tabId) {
    const attachTools = pick(this.optional.cdpLayer, 'attach');
    if (typeof attachTools !== 'function') return;
    await attachTools(tabId).catch((err) => this.log(`[engine2] tool attach on tab ${tabId}: ${err.message}`));
  }

  /**
   * Prepare a NEW page target while platform-cdp holds it (Target.setAutoAttach
   * waitForDebuggerOnStart): its context defaults (focus, locale, timezone), then the tool layer's
   * attach (Network, Log, DOM …, never Runtime at stealth; auto-attach to its frames). Only then
   * does the page run — so a tab the PAGE opened (window.open, target=_blank) loads with the
   * persona in place and its first load captured, exactly like a tab G9 opened (openTab).
   *
   * The commands are SENT here, synchronously, and their answers are NOT awaited before the page
   * is resumed: a target=_blank tab answers nothing while it is held — and every command sent
   * before the resume is applied, in order, before its first document runs (measured, Edge and
   * Chrome 153: the persona's timezone at its first script, its document and first requests
   * captured). Awaiting each answer held the tab until platform-cdp's budget ran out, 3 s, and then
   * resumed it unprepared (live round 4: first-load network missing, timezone late). So this
   * returns at once; `this.prepared` keeps the promise for the ANSWERS, which openTab waits for
   * before it navigates.
   *
   * Once per tab. The start-up tab attaches while the engine is still being registered, before its
   * context — and so its stealth level — is known; it is left to #launch and openTab (see
   * #attachTools on why the tool attach must never run before that).
   */
  #prepareTab(tabId) {
    const info = this.#tabInfo(tabId);
    if (!info) return undefined;
    const e = this.engines.get(info.engineId);
    if (!(e?.ready || e?.contextsReady) || e.closing) return undefined;
    if (this.prepared.has(tabId)) return undefined;
    this.registry.bindHandle(tabId, info.engineId);
    const platform = pick(this.cdp, 'platform');
    const fire = (method, params) => platform.debugger.sendCommand(tabId, method, params)
      .catch((err) => this.log(`[engine2] preparing tab ${tabId}: ${method}: ${err.message}`));
    const answers = [fire('Emulation.setFocusEmulationEnabled', { enabled: true })];
    const ctx = this.#contextOf(tabId);
    if (ctx?.locale) {
      // A window.open() popup starts in its OPENER's renderer process, and the locale override is
      // per process: "Another locale override is already in effect" (measured, Edge 153). Same-site,
      // it stays there and has the opener's locale; cross-site, its document moves to a new process
      // that has none (Intl said "de" beside the opener's "de-DE", stealth suite round 4) — so it is
      // sent again when that document commits (below). Its FIRST script may still see the browser's
      // own default, which for a --lang=de-DE browser is "de", what a German Edge reports anyway.
      answers.push(platform.debugger.sendCommand(tabId, 'Emulation.setLocaleOverride', { locale: ctx.locale }).catch((err) => {
        if (/Another locale override is already in effect/i.test(String(err?.message ?? err))) this.localeRetry.set(tabId, ctx.locale);
        else this.log(`[engine2] preparing tab ${tabId}: Emulation.setLocaleOverride: ${err.message}`);
      }));
    }
    if (ctx?.timezone) answers.push(fire('Emulation.setTimezoneOverride', { timezoneId: ctx.timezone }));
    // A browser-internal page (edge://downloads-hub …) gets no tool layer: every tool refuses it.
    const attachHeld = pick(this.optional.cdpLayer, 'attachHeld');
    if (this.#attachableUrl(info.url ?? '')) {
      if (typeof attachHeld === 'function') answers.push(attachHeld(tabId));
      else answers.push(this.#attachTools(tabId)); // an older tool runtime: awaited, as before
    }
    this.prepared.set(tabId, Promise.all(answers).catch((err) => this.log(`[engine2] preparing tab ${tabId}: ${err.message}`)));
    return undefined;
  }

  /**
   * Prepare a new CHILD target of a tab while it is held. A cross-site iframe runs in a renderer
   * process of its own, and Emulation's timezone/locale overrides are per process: sent to the page
   * session only, the frame kept the host's time zone while the page said Europe/Berlin (stealth
   * suite, 7/7 de-DE runs — the anti-bot widgets that read it live in exactly such frames). Sent to
   * the frame's own session before it runs, it follows the persona (raw probe, Edge 153). Its own
   * auto-attach is turned on here too, so a frame nested inside it is held and prepared the same
   * way. Workers share their page's process settings and need nothing.
   */
  #retryLocale(tabId) {
    const locale = this.localeRetry.get(tabId);
    if (!locale) return;
    pick(this.cdp, 'platform').debugger.sendCommand(tabId, 'Emulation.setLocaleOverride', { locale })
      .then(() => this.localeRetry.delete(tabId))
      .catch((err) => {
        // Still sharing a process that has the override (a same-site navigation): nothing to do yet.
        if (!/Another locale override is already in effect/i.test(String(err?.message ?? err))) this.localeRetry.delete(tabId);
      });
  }

  #prepareChild(tabId, { sessionId, targetInfo } = {}) {
    if (targetInfo?.type !== 'iframe' || !sessionId) return undefined;
    const platform = pick(this.cdp, 'platform');
    const ctx = this.#contextOf(tabId);
    // Sent, not awaited, before the resume — as #prepareTab explains.
    const fire = (method, params) => platform.debugger.sendCommand(tabId, method, params, sessionId, { timeoutMs: 10_000 })
      .catch((err) => this.log(`[engine2] preparing a frame of tab ${tabId}: ${method}: ${err.message}`));
    if (ctx?.locale) fire('Emulation.setLocaleOverride', { locale: ctx.locale });
    if (ctx?.timezone) fire('Emulation.setTimezoneOverride', { timezoneId: ctx.timezone });
    fire('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    return undefined;
  }

  /**
   * Create a page target and return its handle. Chrome refuses a tab in a
   * browser context that has no window yet ("Failed to open new tab - no
   * browser is open") when asked for newWindow:false. platform-cdp's createTab
   * handles that itself (F1), for every caller: every page G9 opens gets a
   * real window of its own (live round 2: a tab that joined another's window
   * fell behind it and was driven at ~1 frame per 1.5 s), taking an existing
   * window's bounds. The retry that lived here became redundant and was
   * removed; the behaviour (a foreground page in the given context, its handle
   * returned once its session exists) is the same.
   */
  async #createTarget(engineId, contextId, url) {
    return (await pick(this.cdp, 'createTab')(engineId, contextId, url)).id;
  }

  /**
   * Open a tab. It is created on about:blank, given its defaults, THEN sent to
   * the URL — so the first document already sees focus, locale and timezone.
   */
  async openTab(engineId, contextId, url) {
    await this.#requireReady();
    const e = await this.#usableEngine(engineId);
    if (contextId && !e.contexts.has(contextId)) {
      throw new Error(`No context "${contextId}" in ${engineId}. Create one with browser_engine action:"context".`);
    }
    const isDefault = !contextId || contextId === e.defaultContextId;
    const platform = pick(this.cdp, 'platform');

    let tabId = null;
    if (isDefault && e.initialBlank != null && this.#tabInfo(e.initialBlank) && this.registry.ownerOf(e.initialBlank) == null) {
      const tab = await platform.tabs.get(e.initialBlank).catch(() => null);
      if (tab && /^about:blank/.test(tab.url ?? 'about:blank')) tabId = e.initialBlank; // reuse the start-up tab once
    }
    e.initialBlank = null;
    if (tabId == null) tabId = await this.#createTarget(engineId, isDefault ? null : contextId, 'about:blank');
    this.registry.bindHandle(tabId, engineId);
    if (this.prepared.has(tabId)) {
      // A new target: prepared while it was held (#prepareTab). Wait for that, do not repeat it.
      await this.prepared.get(tabId);
    } else {
      // The reused start-up tab (it attached before the engine was ready), or a browser that
      // delivered no held session: prepare it now, before the first navigation.
      await this.#applyTabDefaults(tabId);
      await this.#attachTools(tabId);
    }
    if (url && url !== 'about:blank') await platform.tabs.update(tabId, { url });
    this.lastTabId = tabId;
    this.lastEngineId = engineId;
    return { tabId, engineId, contextId: isDefault ? e.defaultContextId : contextId, url: url || 'about:blank' };
  }

  // ------------------------------------------------------------ running tools

  /**
   * The maxParallel gate for mutating calls. The slot is handed over directly, so the count is exact.
   *
   * A waiter is an object, not a bare resolve, so a caller that gave up (its `signal` aborted —
   * the router's slot-wait bound, a dialog, a Stop) is REMOVED and never runs later. Before, the
   * abandoned waiter stayed parked: when a slot freed up, the click its agent had been told had
   * failed ran anyway, beside that agent's retry on the same tab (daemon review, 2026-09-22).
   * `onQueued({max, active})` says the call is waiting; `precheck()` runs once the slot is held and
   * before anything else (the router re-checks halt, liveness and ownership there); `onStart()`
   * marks the moment the call may drive the page.
   */
  async #withSlot(fn, { signal = null, precheck = null, onStart = null, onQueued = null } = {}) {
    const max = Math.max(1, Number(this.#settings().maxParallel) || 8);
    const gateError = () => {
      const reason = signal?.reason;
      const err = reason instanceof Error ? new Error(reason.message) : new Error(
        `[delivery: not-delivered] waited for one of maxParallel=${max} slots for launched-engine calls, all in use; ` +
          'nothing was sent to the page.',
      );
      if (!/^\[delivery: /.test(err.message)) err.message = `[delivery: not-delivered] ${err.message} Nothing was sent to the page.`;
      err.delivery = 'not-delivered';
      return err;
    };
    if (signal?.aborted) throw gateError();
    if (this.active >= max) {
      onQueued?.({ max, active: this.active });
      await new Promise((resolve, reject) => {
        const waiter = {
          granted: false,
          grant: () => {
            waiter.granted = true;
            signal?.removeEventListener?.('abort', onAbort);
            resolve();
          },
        };
        const onAbort = () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) {
            this.waiters.splice(i, 1);
            reject(gateError());
          }
          // Otherwise the slot was already handed to this waiter: it is released below.
        };
        this.waiters.push(waiter);
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    } else {
      this.active += 1;
    }
    try {
      // Granted, but given up on in the same tick: pass the slot on without running.
      if (signal?.aborted) throw gateError();
      precheck?.();
      onStart?.();
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next.grant();
      else this.active -= 1;
    }
  }

  /**
   * Run one tool call in Engine 2. `ctl` (from the router): `signal` aborts it — while it waits
   * for a slot it is dropped, once running its input stops at the next step (lib/humanize.js
   * perform); `precheck`, `onStart`, `onQueued` as #withSlot documents.
   */
  async runTool(tool, args = {}, caller = {}, ctl = {}) {
    await this.#requireReady();
    const runTool = pick(this.tools, 'runTool');
    const tabId = args?.tabId ?? null;
    const engineId = tabId != null ? this.engineOfTab(tabId) : null;
    if (engineId) this.lastEngineId = engineId;
    if (tool === 'browser_tabs' && args?.action === 'focus' && tabId != null) this.lastTabId = tabId;
    const { signal = null, precheck = null, onStart = null, onQueued = null } = ctl ?? {};
    const toolCaller = signal ? { ...(caller ?? {}), signal } : caller;

    // The maxParallel gate is for calls that drive a page. A wait is mutating (it
    // is someone driving that tab) but holds no slot: tools/index.js holdsSlot.
    const gated = this.holdsSlot(tool, args);
    const wantsEvidence = tool === 'browser_recording' && (args.action === 'replay' || args.action === 'calibrate') && tabId != null;
    let evidenceRun = null;

    try {
      // The evidence run starts when the call does — inside its maxParallel
      // slot — not when it was queued: a replay waiting for a slot must not
      // spool frames of a tab nobody is driving yet, nor date its run early.
      const run = async () => {
        if (!gated) {
          precheck?.();
          onStart?.();
        }
        if (wantsEvidence) {
          evidenceRun = await this.#startEvidence(tabId, args).catch((err) => {
            this.log(`[evidence] could not start a run record: ${err.message}`);
            return null;
          });
        }
        return runTool(tool, args, toolCaller);
      };
      const result = gated ? await this.#withSlot(run, { signal, precheck, onStart, onQueued }) : await run();
      if (evidenceRun) {
        const summary = await this.#finishEvidence(evidenceRun, {
          ok: true,
          verdict: result?.verdict ?? null,
          passed: result?.passed ?? null,
          failed: result?.failed ?? null,
          total: result?.total ?? null,
          humanize: result?.humanize ?? evidenceRun.humanize,
          seed: result?.humanize?.seed ?? result?.seed ?? args.seed ?? null,
          // Why a run PASSED WITH WARNINGS, kept with it: result.json had the verdict and not the
          // warnings, so no viewer could say (desktop render check, round 3, every replay). Capped.
          warnings: Array.isArray(result?.warnings) ? result.warnings.slice(0, 50).map((w) => String(w).slice(0, 2000)) : [],
          ...(Array.isArray(result?.steps) ? { steps: result.steps.slice(0, 200) } : {}),
          ...(result?.surpriseCount ? { surpriseCount: result.surpriseCount } : {}),
        });
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          return { ...result, evidence: { runId: evidenceRun.runId, dir: evidenceRun.dir.replace(/\\/g, '/'), frames: summary?.frames ?? 0 } };
        }
      }
      return result;
    } catch (err) {
      if (evidenceRun) await this.#finishEvidence(evidenceRun, { ok: false, error: String(err?.message ?? err) });
      throw err;
    }
  }

  // ------------------------------------------------------------ evidence and watching

  #runsForTab(tabId) {
    const out = [];
    for (const [key, w] of this.watches) {
      if (w.runId && key.startsWith(`${tabId}\u0000`)) out.push(w.runId);
    }
    return out;
  }

  async #startEvidence(tabId, args) {
    if (!this.evidence) return null;
    const info = this.#tabInfo(tabId);
    const e = info ? this.engines.get(info.engineId) : null;
    const ctx = this.#contextOf(tabId);
    const humanize = { level: args.humanize ?? ctx?.humanize ?? e?.info.humanize ?? null, seed: args.seed ?? null };
    const { runId, dir } = await this.evidence.startRun({
      kind: args.action,
      label: args.id ?? null,
      tabId,
      engine: e ? {
        engineId: e.info.engineId, browser: e.info.browser, version: e.info.version, headless: e.info.headless, profile: e.info.profile, argv: e.info.argv,
        stealth: ctx?.stealth ?? e.info.stealth,
        // navigator.webdriver and Widevine follow the browser's launch level, not the context's.
        ...(ctx?.stealth && ctx.stealth !== e.info.stealth ? { environmentStealth: e.info.stealth } : {}),
      } : null,
      meta: { recordingId: args.id ?? null, humanize, daemonVersion: this.version },
    });
    const consumer = `run:${runId}`;
    await this.watch(tabId, true, consumer, {
      onFrame: (frame) => this.evidence.frame(runId, frame),
      onPointer: (sample) => this.evidence.pointer(runId, sample),
      runId,
    }).catch((err) => this.log(`[evidence] ${runId}: no screencast (${err.message})`));
    return { runId, dir, tabId, consumer, humanize };
  }

  async #finishEvidence(run, result) {
    await this.watch(run.tabId, false, run.consumer).catch(() => {});
    return this.evidence.finishRun(run.runId, result).catch((err) => {
      this.log(`[evidence] ${run.runId}: ${err.message}`);
      return null;
    });
  }

  /**
   * Start/stop streaming a tab's screencast frames and pointer samples to a
   * consumer (a UI watch, or a run's evidence spool). One screencast per tab is
   * shared by every consumer (extension/lib/screencast.js).
   *
   * Changes to ONE tab+consumer run one at a time, in the order they were asked for, so the LAST
   * request wins and the final state is the one its caller asked for. Nothing above serialises
   * them: the daemon's live view answers `watch` and `unwatch` admin messages out of band
   * (daemon.js #watch / #stopWatching), and a replay's evidence spool starts and finishes its own
   * `run:<id>` consumer around a tool call. A viewer that changes its mind while the browser is
   * still answering Page.startScreencast therefore used to have its stop overlap that start: the
   * stop tore down a watch that was only half set up, and — worse — the overtaken start's own
   * failure path ("this watch never started, undo it") then deleted `watches[key]` and stopped the
   * screencast consumer by id, which by then belonged to whatever watch had replaced it.
   *
   * extension/lib/screencast.js keeps a per-tab chain of its own, so at the CDP level a stop cannot
   * overtake the start it follows. That is Engine 1's guarantee and Engine 2 borrows it, but it is
   * not one this file may lean on: the module is OPTIONAL here (init() imports it in a try/catch,
   * and a daemon running an older or partial tool runtime has none), and it knows nothing of the
   * pointer subscription, the watchdog or `watches` — the state this file owns. So the order is
   * kept here, once, for everything a watch consists of. The chain is the same one the per-tab
   * call queue uses (daemon/registry.js enqueue).
   */
  async watch(tabId, on, consumerId, opts = {}) {
    const key = `${tabId}\u0000${consumerId}`;
    const step = (this.watchChain.get(key) ?? Promise.resolve()).then(() => this.#watchStep(key, tabId, on, consumerId, opts));
    // The chain itself never rejects — a failed step is its own caller's to handle, and must not
    // stop the next change from running — and is dropped once nothing else is queued for the key,
    // so it does not grow with every tab ever watched.
    const settled = step.then(() => {}, () => {});
    this.watchChain.set(key, settled);
    settled.then(() => { if (this.watchChain.get(key) === settled) this.watchChain.delete(key); });
    return step;
  }

  async #watchStep(key, tabId, on, consumerId, { onFrame = () => {}, onPointer = () => {}, onStatus = null, runId = null } = {}) {
    const screencast = this.optional.screencast;
    const pointer = this.optional.pointer;
    if (!on) {
      const w = this.watches.get(key);
      this.watches.delete(key);
      w?.unsubscribePointer?.();
      w?.stopWatchdog?.();
      if (screencast) await pick(screencast, 'stop')?.(tabId, consumerId);
      return { watching: false };
    }
    if (this.watches.has(key)) return { watching: true };
    const s = this.#settings().evidence ?? {};
    const entry = { runId, unsubscribePointer: null, stopWatchdog: null };
    this.watches.set(key, entry);
    if (pointer && typeof pick(pointer, 'subscribe') === 'function') {
      entry.unsubscribePointer = pick(pointer, 'subscribe')((tid, sample) => {
        if (tid === tabId) onPointer({ ...sample, tabId });
      });
    }
    // A live viewer is told when the picture stops being live (a hidden or
    // throttled page renders no frames) — lib/screencast.js watchdog.
    const watchdog = screencast ? pick(screencast, 'watchdog') : null;
    if (typeof onStatus === 'function' && typeof watchdog === 'function') {
      try {
        entry.stopWatchdog = watchdog(tabId, { onStatus: (status) => onStatus({ ...status, tabId }) });
      } catch (err) {
        this.log(`[engine2] watch status for tab ${tabId} unavailable: ${err.message}`);
      }
    }
    try {
      if (!screencast) throw new Error('extension/lib/screencast.js is not available, so no frames can be streamed');
      pick(screencast, 'subscribe')(tabId, consumerId, (frame) => onFrame({ ...frame, tabId }));
      const started = await pick(screencast, 'start')(tabId, consumerId, {
        format: 'jpeg',
        quality: s.quality ?? 60,
        maxWidth: s.maxWidth ?? 1280,
        maxHeight: s.maxHeight ?? 800,
        everyNthFrame: 1,
      });
      if (started?.attempts > 1) this.log(`[screencast] tab ${tabId}: started on attempt ${started.attempts} (the page was between two documents)`);
    } catch (err) {
      // A watch that never started must not linger as "watching": the next
      // watch of this tab would be answered from the stale entry and stream
      // nothing, and the pointer subscription would leak. Safe to undo by key
      // and by consumer id because watch() runs these one at a time: no later
      // watch of the same tab+consumer has been set up yet.
      this.watches.delete(key);
      entry.unsubscribePointer?.();
      entry.stopWatchdog?.();
      if (screencast) await Promise.resolve(pick(screencast, 'stop')?.(tabId, consumerId)).catch(() => {});
      throw err;
    }
    return { watching: true };
  }

  /** Mirror the daemon's global halt into Engine 2 state: in-flight Engine 2 work stops at its next CDP command. */
  async setHalted(halted) {
    const setState = pick(this.optional.state, 'setState');
    if (typeof setState === 'function') {
      await setState({ halted: !!halted }).catch((err) => this.log(`[engine2] could not mirror halt: ${err.message}`));
    }
  }

  // ------------------------------------------------------------ recordings store (Engine 2)

  async getRecording(id) {
    await this.#requireReady();
    const get = pick(this.optional.store, 'getRecording');
    if (typeof get !== 'function') return null;
    return (await get(id)) ?? null;
  }

  async saveRecording(recording) {
    await this.#requireReady();
    const save = pick(this.optional.store, 'saveRecording');
    if (typeof save !== 'function') throw new Error('The launched-engine recording store is unavailable.');
    return save(recording);
  }

  /** (3.2) A launched-store recording's approval sidecar with its images, or null (lib/flowsync.js). */
  async approvedBundle(id) {
    await this.#requireReady();
    const bundle = pick(this.optional.flowsync, 'approvedBundle');
    return typeof bundle === 'function' ? bundle(id) : null;
  }

  // ------------------------------------------------------------ versions and profiles

  async versions({ download = false, version = null } = {}) {
    const out = { running: this.list().map((e) => ({ engineId: e.engineId, browser: e.browser, version: e.version, path: e.browserPath })) };
    try {
      const find = await import(new URL('find.js', ENGINE).href);
      out.browsers = await pick(find, 'findBrowsers')({ home: this.home });
    } catch (err) {
      out.browsers = { error: err.message };
    }
    try {
      const cft = await import(new URL('cft.js', ENGINE).href);
      out.cft = { pinned: pick(cft, 'pinned')(), installed: await pick(cft, 'installed')({ home: this.home }) };
      if (download) {
        out.cft.downloaded = await pick(cft, 'ensure')({
          home: this.home,
          trigger: 'daemon',
          ...(version ? { version } : {}),
          onProgress: (p) => this.emit('activity', { kind: 'cft-download', ...p }),
        });
      }
    } catch (err) {
      out.cft = { ...(out.cft ?? {}), error: err.message };
      if (download) throw new Error(`Chrome for Testing could not be installed: ${err.message}`);
    }
    out.log = path.join(this.home, 'engine-versions.log').replace(/\\/g, '/');
    return out;
  }

  /**
   * Once at daemon start: remove what interrupted Chrome for Testing installs left in
   * G9_HOME/engines (engine/cft.js sweepLeftovers — hundreds of MB per interrupted attempt). An
   * install's own sweep runs only when it reaches its lock, which an installed version never does.
   */
  async sweepInstallLeftovers() {
    try {
      const cft = await import(new URL('cft.js', ENGINE).href);
      const { removed } = await pick(cft, 'sweepLeftovers')({ home: this.home });
      if (removed.length) this.log(`[engine2] removed what ${removed.length} interrupted Chrome for Testing install step(s) left: ${removed.join(', ')}`);
      return removed;
    } catch (err) {
      this.log(`[engine2] could not sweep interrupted Chrome for Testing installs: ${err.message}`);
      return [];
    }
  }

  async profiles() {
    const { profile } = await this.#engineModules();
    return pick(profile, 'list')({ home: this.home });
  }

  /**
   * Open a profile HEADED for a one-time sign-in. Returns as soon as the window
   * is up — the person may take minutes — and records the warm-up in the
   * profile's metadata when they close it (engine/profile.js does that).
   */
  async warm({ profile = 'automation', url = null, browser } = {}) {
    for (const e of this.engines.values()) {
      if (e.info.profile === profile) {
        throw new Error(`Profile "${profile}" is open in ${e.info.engineId}. Stop that engine first (browser_engine action:"stop"), then warm it.`);
      }
    }
    const { profile: profileMod } = await this.#engineModules();
    return new Promise((resolve, reject) => {
      let up = false;
      const done = pick(profileMod, 'warm')(profile, url, {
        home: this.home,
        ...(browser ? { browser } : {}),
        onLaunched: (handle) => {
          up = true;
          resolve({
            profile,
            warming: true,
            pid: handle?.pid ?? null,
            browser: handle?.browser ? { kind: handle.browser.kind, version: handle.browser.version } : null,
            url: url ?? 'about:blank',
            note: 'A browser window opened on this profile. Ask the user to sign in and then CLOSE that window; ' +
              'launched engines using this profile start signed in afterwards.',
          });
        },
      });
      done.then(
        (result) => {
          this.log(`[engine2] profile "${profile}" warm-up finished (warmed: ${result?.warmed})`);
          this.emit('activity', { kind: 'profile-warm', profile, warmed: !!result?.warmed, reason: result?.reason ?? null });
          if (!up) resolve({ profile, ...(result ?? {}) });
        },
        (err) => {
          if (!up) reject(err);
          else this.log(`[engine2] profile "${profile}" warm-up failed after launch: ${err.message}`);
        },
      );
    });
  }

  /**
   * Install a calibrated humanize profile into the launched-engine store so
   * `humanize:"<name>"` works on every launched engine (extension/lib/humanize.js
   * resolves names from platform storage).
   */
  async saveHumanizeProfile(name, profile) {
    await this.#requireReady();
    const save = pick(this.optional.humanize, 'saveProfile');
    if (typeof save !== 'function') throw new Error('extension/lib/humanize.js is unavailable, so the profile cannot be saved.');
    return save(name, profile);
  }

  // ------------------------------------------------------------ handoff

  /**
   * Receive a tab from Engine 1 (ARCHITECTURE §7): cookies into a
   * context, one-shot storage seeding in G9's isolated world, navigate, remove
   * the seeding script after load.
   */
  async handoffImport(payload, { engineId = null, contextId = null, launch = true, includeStorage = true, matchViewport = false, caller = {} } = {}) {
    await this.#requireReady();
    if (!payload?.url) throw new Error('Nothing to hand off: the payload has no url.');
    let eid = engineId;
    if (!eid) {
      eid = await this.defaultEngineId({ launch });
      if (!eid) throw new Error('No launched engine is running, and launch:false was given.');
    }
    const e = await this.#usableEngine(eid);
    let ctx = contextId ? e.contexts.get(contextId) : null;
    if (contextId && !ctx) throw new Error(`No context "${contextId}" in ${eid}.`);
    // A fresh context by default: the person's session must not leak into the
    // automation profile, and two handoffs must not share cookies.
    if (!ctx) ctx = await this.createContext(eid, {});
    const isDefault = !!ctx.isDefault;
    const contextParam = isDefault ? {} : { browserContextId: ctx.contextId };

    const { cookies, skipped } = chromeCookiesToCdp(payload.cookies ?? []);
    const notSet = [...skipped];
    let accepted = 0;
    if (cookies.length) {
      try {
        await e.conn.send('Storage.setCookies', { cookies, ...contextParam });
        accepted = cookies.length;
      } catch {
        // One bad cookie fails the whole batch; find which, set the rest.
        for (const c of cookies) {
          try {
            await e.conn.send('Storage.setCookies', { cookies: [c], ...contextParam });
            accepted += 1;
          } catch (err) {
            notSet.push({ name: c.name, domain: c.domain ?? c.url, reason: err.message });
          }
        }
      }
    }

    const platform = pick(this.cdp, 'platform');
    const tabId = await this.#createTarget(eid, isDefault ? null : ctx.contextId, 'about:blank');
    this.registry.bindHandle(tabId, eid);
    await this.#applyTabDefaults(tabId);
    const send = (method, params = {}) => platform.debugger.sendCommand(tabId, method, params);

    const origin = originOf(payload.url);
    const local = includeStorage ? storageEntries(payload.localStorage) : [];
    const session = includeStorage ? storageEntries(payload.sessionStorage) : [];
    let scriptId = null;
    if (origin && (local.length || session.length)) {
      await send('Page.enable').catch(() => {});
      scriptId = (await send('Page.addScriptToEvaluateOnNewDocument', { source: seedStorageScript(origin, local, session), worldName: 'g9' }))?.identifier ?? null;
    }
    if (matchViewport && payload.viewport?.width && payload.viewport?.height) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: Math.round(payload.viewport.width),
        height: Math.round(payload.viewport.height),
        deviceScaleFactor: payload.viewport.dpr ?? 1,
        mobile: false,
      }).catch(() => {});
    }

    let navigation = null;
    let navigationError = null;
    try {
      navigation = await this.runTool('browser_navigate', { action: 'goto', url: payload.url, tabId, waitUntil: 'load' }, caller);
    } catch (err) {
      navigationError = err.message;
      try {
        await platform.tabs.update(tabId, { url: payload.url });
        await waitFor(async () => (await platform.tabs.get(tabId).catch(() => null))?.status === 'complete', 30_000);
        navigationError = null;
      } catch (err2) {
        navigationError = `${navigationError}; fallback navigation: ${err2.message}`;
      }
    } finally {
      if (scriptId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }).catch(() => {});
    }
    this.lastTabId = tabId;
    this.lastEngineId = eid;
    const finalTab = await platform.tabs.get(tabId).catch(() => null);
    const finalUrl = finalTab?.url ?? navigation?.url ?? payload.url;

    // Count what actually arrived rather than report what was sent: the seed
    // only runs on the handed-off origin, so a redirect to a sign-in host (an
    // expired session) leaves the storage behind — and the result must say so.
    const warnings = [];
    if (navigationError) warnings.push(`The page did not finish loading in the launched engine: ${navigationError}`);
    let storageCheck = null;
    if (scriptId) {
      storageCheck = await this.#checkSeededStorage(tabId, origin, local, session);
      if (storageCheck?.sameOrigin === false) {
        warnings.push(
          `The page ended on ${storageCheck.origin} instead of ${origin} (a redirect — often a sign-in page because the session did not carry), ` +
            'so the local/session storage could not be confirmed there.',
        );
      } else if (storageCheck?.sameOrigin) {
        if (storageCheck.localStorage < local.length) {
          warnings.push(`${storageCheck.localStorage} of ${local.length} localStorage entries hold the handed-off value after load (the page may have changed the others).`);
        }
        if (storageCheck.sessionStorage < session.length) {
          warnings.push(`${storageCheck.sessionStorage} of ${session.length} sessionStorage entries hold the handed-off value after load (the page may have changed the others).`);
        }
      }
    }
    return {
      tabId,
      engineId: eid,
      contextId: ctx.contextId,
      url: finalUrl,
      title: finalTab?.title ?? null,
      transferred: { cookies: accepted, localStorage: local.length, sessionStorage: session.length },
      ...(storageCheck ? { storageCheck } : {}),
      notTransferred: [...NOT_TRANSFERRED],
      ...(notSet.length ? { cookiesNotSet: notSet } : {}),
      ...(navigationError ? { navigationError } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  /**
   * After a handoff: which seeded entries hold their value on the final page,
   * read in G9's isolated world (it shares the origin's storage, not the page's
   * globals). Null when the world module is unavailable or the page cannot be read.
   */
  async #checkSeededStorage(tabId, origin, local, session) {
    const inWorld = pick(this.optional.world, 'inWorld');
    if (typeof inWorld !== 'function') return null;
    const seed = JSON.stringify({ origin, local, session });
    const expression = `(() => {
      const seed = ${seed};
      if (location.origin !== seed.origin) return { sameOrigin: false, origin: location.origin };
      let l = 0, s = 0;
      try { for (const [k, v] of seed.local) if (localStorage.getItem(k) === v) l += 1; } catch (e) {}
      try { for (const [k, v] of seed.session) if (sessionStorage.getItem(k) === v) s += 1; } catch (e) {}
      return { sameOrigin: true, origin: location.origin, localStorage: l, sessionStorage: s };
    })()`;
    try {
      const result = await inWorld(tabId, expression);
      return result && typeof result === 'object' ? result : null;
    } catch (err) {
      this.log(`[handoff] could not read back the seeded storage on tab ${tabId}: ${err.message}`);
      return null;
    }
  }
}

function safeName(value) {
  return String(value ?? 'default').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'default';
}

/**
 * The language list a browser whose UI speaks `locale` keeps in intl.accept_languages:
 * 'de-DE' → 'de-DE,de' (Chrome's own shape for a regional locale: the locale, then its bare
 * language, which the header then sends as "de-DE,de;q=0.9"); 'de' → 'de'. Null for a tag that
 * is not one.
 */
export function acceptLanguagesFor(locale) {
  let tag;
  try {
    tag = Intl.getCanonicalLocales(locale)[0];
  } catch {
    return null;
  }
  if (!tag) return null;
  const language = new Intl.Locale(tag).language;
  return language && language !== tag ? `${tag},${language}` : tag;
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
}
