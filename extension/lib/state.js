/**
 * Persistent state for the service worker (and, in the daemon, for a launched
 * engine's tool runtime).
 *
 * MV3 kills the service worker after ~30s idle. Every global variable dies with
 * it. Anything that must survive a restart lives in `platform.storage.session`
 * (chrome.storage.session in the extension: in-memory only, cleared when the
 * browser closes — never written to disk). The few real settings are mirrored
 * to `platform.storage.local`.
 *
 * ## v2: no modes
 *
 * `mode`, `pinnedTabId` and the workspace allowlist are gone (decision D6):
 * attaching a tab gives full access, and `currentTabId` is simply "the tab a
 * call without a tabId acts on" — set by the panel's Attach, `browser_tabs
 * attach`, and `open`/`session` with focus. A v1 `settings.mode` is removed
 * once by `migrateLegacySettings()`.
 */

import { platform } from './platform.js';

const DEFAULTS = {
  /** The tab a call without tabId/session acts on. See tools/tabs.js resolveTarget. */
  currentTabId: null,
  /** tabIds we currently hold a debugger session on */
  attachedTabs: [],
  /**
   * Named tabs: { [name]: tabId }.
   *
   * The debugger has always supported attaching to several tabs at once; what
   * was missing was a way to ADDRESS them, so a two-user scenario ("seller
   * lists an item, buyer buys it") could not be expressed. A name is the address.
   */
  sessions: {},
  /**
   * How input is dispatched: 'off' (v1's direct events), 'human' (planned,
   * human-timed input) or 'stealth' (human input, and the Runtime domain is
   * never enabled). Read synchronously by platform.settings — see noteInputMode.
   */
  inputMode: 'human',
  /** Attach every attachable tab on startup, creation and navigation. */
  autoAttach: false,
  /** The agents list last pushed by the daemon: [{ id, name, owned: [tabId…] }]. */
  agents: [],
  /**
   * The project adapter, as delivered by the daemon on connect.
   *
   * Not persisted: it is the daemon's truth, re-sent on every connect, and a
   * cached copy would outlive the file it came from.
   */
  project: {
    found: false,
    path: null,
    environments: {},
    defaultEnvironment: null,
    flowsDir: null,
    problems: [],
  },
  /** Daemon connection settings + live status. */
  bridge: {
    host: '127.0.0.1',
    port: 8765,
    connected: false,
    lastError: null,
    daemonVersion: null,
    engineId: null,
    repoRoot: null,
  },
  /** rolling activity log shown in the side panel */
  activity: [],
  /** hard stop — when true every tool call except browser_status is rejected */
  halted: false,
  /**
   * Set while a JavaScript dialog is blocking a tab: { tabId, type, message }.
   * A blocked renderer answers no CDP command, so every tool call on that tab
   * would sit until its timeout. Knowing a dialog is open turns that into an
   * instant, actionable error.
   *
   * `dialogOpen` is the newest one (what the panel shows); `dialogs` holds every
   * open one by tab. Several agents on several tabs — or one flow replayed in
   * parallel tabs — can have two alerts up at once, and a single slot forgot
   * the first: calls to that tab then hung to their timeout instead of failing
   * at once. Write both through noteDialog/forgetDialog only.
   */
  dialogOpen: null,
  dialogs: {},
};

const MAX_ACTIVITY = 200;

/** Fields computed on read, never written to session storage. */
const COMPUTED = ['version', 'previousVersion', 'updatedAt'];

/** Fields a v1 build left behind that must not leak back into v2 state. */
const LEGACY = ['mode', 'pinnedTabId', 'modeDefaultMigrated'];

/**
 * The bridge fields that are actually SETTINGS, as opposed to live status.
 *
 * `connected` and `lastError` change constantly and belong only to this
 * session. Treating any `bridge` patch as a settings change meant that every
 * reconnect attempt rewrote host/port to disk — a `storage.local` write per
 * backoff tick, forever, on any machine where the daemon is not running.
 *
 * It also silently reverted externally configured settings. The isolated live
 * test seeds a private port into `storage.local` and reloads the extension; the
 * failed-connection write that followed put 8765 straight back, so the isolated
 * browser connected to whatever was on the default port — including the user's
 * live session, which it then displaced. The test could never pass, and running
 * it broke real work.
 */
const BRIDGE_SETTING_FIELDS = ['host', 'port', 'v1AutoPort'];

/**
 * v1 bridges without G9_PORT took the next free port in 8765-8775, and the v1 panel's bridge
 * picker saved whichever one the person clicked. g9d never uses 8766-8775 by itself.
 */
export const V1_AUTO_PORTS = Object.freeze({ from: 8766, to: 8775 });

const INPUT_MODES = new Set(['off', 'human', 'stealth']);

function durableSettings(settings = {}) {
  const out = {};
  if (settings.bridge) {
    const bridge = {};
    for (const k of BRIDGE_SETTING_FIELDS) if (settings.bridge[k] !== undefined) bridge[k] = settings.bridge[k];
    out.bridge = bridge;
  }
  if (INPUT_MODES.has(settings.inputMode)) out.inputMode = settings.inputMode;
  if (typeof settings.autoAttach === 'boolean') out.autoAttach = settings.autoAttach;
  return out;
}

function strip(state, fields) {
  const out = { ...state };
  for (const k of fields) delete out[k];
  return out;
}

export async function getState() {
  const [session, local] = await Promise.all([
    platform.storage.session.get('state'),
    platform.storage.local.get(['settings', 'about']),
  ]);
  const settings = durableSettings(local.settings ?? {});
  const live = strip(session.state ?? {}, [...LEGACY, ...COMPUTED]);
  const state = {
    ...DEFAULTS,
    ...settings,
    ...live,
    bridge: { ...DEFAULTS.bridge, ...(settings.bridge ?? {}), ...(live.bridge ?? {}) },
    version: platform.runtime.version(),
    previousVersion: local.about?.previousVersion ?? null,
    updatedAt: local.about?.updatedAt ?? null,
  };
  if (!INPUT_MODES.has(state.inputMode)) state.inputMode = DEFAULTS.inputMode;
  // Keep the synchronous cache that platform.settings reads in step with the
  // truth. Every tool call reads state before it acts, so the cache is never
  // older than the call that depends on it.
  platform.settings.noteInputMode?.(state.inputMode);
  return state;
}

/**
 * Serializes every session-storage mutation in the extension.
 *
 * Read-modify-write against one storage key, from independent async contexts,
 * loses updates: two writers that interleave both read the same base state and
 * the second silently discards the first. That surfaced as vanishing activity
 * entries and, worse, an `attachedTabs` that reverted under load.
 *
 * This chain is exported because it must cover EVERY such writer, not just the
 * ones in this file. `tools/observe.js` is the highest-frequency one by a wide
 * margin — a single page load fires dozens of Network events into the same
 * buffer — so it shares this chain rather than running unguarded.
 *
 * A promise chain costs nothing here: the writes are small and the operations
 * are storage calls, not tool work. The only rule is that a serialized function
 * must never itself call another serialized function, or it will deadlock.
 */
let writeQueue = Promise.resolve();

export function serialize(fn) {
  const run = writeQueue.then(fn, fn);
  // Keep the chain alive even if one mutation throws.
  writeQueue = run.catch(() => {});
  return run;
}

export function setState(patch) {
  return serialize(async () => commit(await getState(), patch));
}

/**
 * Read-modify-write as ONE step of the chain: `fn(current)` returns the patch
 * (or null for "nothing to change"). For a patch computed from the current
 * value — a map entry added or removed — where getState() followed by
 * setState() would let a concurrent writer's change be lost in between.
 * `fn` must not call setState/updateState itself (that would deadlock).
 */
export function updateState(fn) {
  return serialize(async () => {
    const current = await getState();
    const patch = await fn(current);
    return patch ? commit(current, patch) : current;
  });
}

/** Record a dialog that blocks `dialog.tabId`. */
export function noteDialog(dialog) {
  const entry = { ...dialog, at: dialog.at ?? Date.now() };
  return updateState((s) => ({
    dialogs: { ...(s.dialogs ?? {}), [entry.tabId]: entry },
    dialogOpen: entry,
  }));
}

/**
 * Forget a tab's dialog. `dialogOpen` then falls back to the newest dialog
 * still open elsewhere, so handling one tab never unblocks another. A legacy
 * dialog with no tabId is cleared by anyone, as before.
 */
export function forgetDialog(tabId) {
  return updateState((s) => {
    const dialogs = { ...(s.dialogs ?? {}) };
    const had = tabId != null && Object.prototype.hasOwnProperty.call(dialogs, String(tabId));
    if (had) delete dialogs[tabId];
    const current = s.dialogOpen;
    const stale = !!current && (current.tabId == null || current.tabId === tabId);
    if (!had && !stale) return null;
    const newest = Object.values(dialogs).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0] ?? null;
    return { dialogs, dialogOpen: stale ? newest : current };
  });
}

/** Apply a patch to the state just read, persist it, mirror durable settings, tell the panel. */
async function commit(current, patch) {
  const next = { ...current, ...patch };
  if (patch.bridge) next.bridge = { ...current.bridge, ...patch.bridge };
  if (!INPUT_MODES.has(next.inputMode)) next.inputMode = current.inputMode;

  await platform.storage.session.set({ state: strip(next, [...LEGACY, ...COMPUTED]) });
  platform.settings.noteInputMode?.(next.inputMode);

  // Mirror durable settings so they survive a browser restart — but only when
  // a durable value actually CHANGED. A patch that carries nothing but
  // `connected` and `lastError` is live status, not a setting, and writing it
  // to disk is both pointless traffic and a way to clobber configuration.
  const bridgeChanged =
    !!patch.bridge && BRIDGE_SETTING_FIELDS.some((k) => k in patch.bridge && patch.bridge[k] !== current.bridge[k]);
  const inputChanged = 'inputMode' in patch && next.inputMode !== current.inputMode;
  const autoChanged = 'autoAttach' in patch && !!next.autoAttach !== !!current.autoAttach;

  if (bridgeChanged || inputChanged || autoChanged) {
    await platform.storage.local.set({
      settings: {
        bridge: { host: next.bridge.host, port: next.bridge.port, ...(next.bridge.v1AutoPort === true ? { v1AutoPort: true } : {}) },
        inputMode: next.inputMode,
        autoAttach: !!next.autoAttach,
      },
    });
  }

  broadcast({ type: 'state', state: next });
  return next;
}

/**
 * One-time removal of what v1 stored on disk.
 *
 * v1 kept `mode` (and a migration marker, a token, and two path hints) in
 * `settings`. None of it means anything in v2 and `mode` in particular must not
 * linger where a future reader could mistake it for a live setting. Host and
 * port are kept — someone who moved the bridge off 8765 did it for a reason.
 * Returns a line for the activity log when something was removed, else null.
 */
export async function migrateLegacySettings() {
  const { settings } = await platform.storage.local.get('settings');
  if (!settings) return null;
  const legacyKeys = ['mode', 'modeDefaultMigrated'].filter((k) => k in settings);
  const legacyBridge = ['token', 'serverPath', 'repoRoot'].filter((k) => settings.bridge && k in settings.bridge);
  if (!legacyKeys.length && !legacyBridge.length) return null;
  const kept = durableSettings(settings);
  // A port in v1's automatic range (8766-8775) is kept — a person may have set G9_PORT there on
  // purpose, and the v2 compatibility entry starts g9d on the same G9_PORT — but FLAGGED: when
  // nothing answers there, the transport tries 8765 once and switches only if g9d answers there.
  // It used to dial the v1 port forever: "Daemon offline" while g9d ran on 8765 (extension
  // review, 2026-09-22).
  const port = Number(kept.bridge?.port);
  const autoPort = Number.isInteger(port) && port >= V1_AUTO_PORTS.from && port <= V1_AUTO_PORTS.to;
  if (autoPort) kept.bridge.v1AutoPort = true;
  await platform.storage.local.set({ settings: kept });
  const note = autoPort ? ` The daemon address keeps port ${port} from v1; if the G9 daemon is not there, G9 switches to 8765 once it finds the daemon there.` : '';
  return (settings.mode
    ? `Removed the v1 control mode ("${settings.mode}") from settings: v2 has no modes — attaching a tab gives full access.`
    : 'Removed obsolete v1 settings.') + note;
}

/**
 * Version bookkeeping shown in the panel's About box and the welcome page.
 * Kept in its own `about` key: it is not a setting and must never be rewritten
 * by a settings change.
 */
export async function getAbout() {
  const { about } = await platform.storage.local.get('about');
  return about ?? {};
}

export async function setAbout(patch) {
  const current = await getAbout();
  const next = { ...current, ...patch };
  await platform.storage.local.set({ about: next });
  return next;
}

/**
 * Append to the activity log. This is the trust surface: the user must be able
 * to see exactly what the agent did, in order, with results. Never silently
 * drop entries — truncate the oldest instead.
 */
export function logActivity(entry) {
  return serialize(async () => {
    const state = await getState();
    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      ...entry,
    };
    const activity = [record, ...state.activity].slice(0, MAX_ACTIVITY);
    await platform.storage.session.set({ state: strip({ ...state, activity }, [...LEGACY, ...COMPUTED]) });
    broadcast({ type: 'activity', entry: record });
    return record;
  });
}

export function clearActivity() {
  return serialize(async () => {
    const state = await getState();
    await platform.storage.session.set({ state: strip({ ...state, activity: [] }, [...LEGACY, ...COMPUTED]) });
    broadcast({ type: 'state', state: { ...state, activity: [] } });
  });
}

/**
 * Push an update to whoever renders state: the side panel in the extension,
 * the daemon's UI hook in Engine 2. The receiver may not exist — a failed
 * delivery is normal and never surfaces.
 */
export function broadcast(message) {
  platform.runtime.broadcast(message);
}
