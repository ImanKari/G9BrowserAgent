/**
 * Persistent state for the service worker.
 *
 * MV3 kills the service worker after ~30s idle. Every global variable dies with
 * it. Anything that must survive a restart lives in chrome.storage.session
 * (in-memory only, cleared when the browser closes — never written to disk).
 */

const api = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = {
  /** 'pinned' | 'follow' | 'multi' */
  mode: 'pinned',
  /** tabId the agent is locked onto */
  pinnedTabId: null,
  /** tabIds we currently hold a chrome.debugger session on */
  attachedTabs: [],
  /** bridge connection settings + live status */
  bridge: {
    host: '127.0.0.1',
    port: 8765,
    connected: false,
    lastError: null,
    /** optional shared secret; empty means "rely on Origin checking" */
    token: '',
    /** absolute path the bridge reported; persisted so the panel keeps it */
    serverPath: null,
    repoRoot: null,
  },
  /** rolling activity log shown in the side panel */
  activity: [],
  /** hard stop — when true every tool call is rejected */
  halted: false,
  /**
   * Set while a JavaScript dialog is blocking a tab: { tabId, type, message }.
   * A blocked renderer answers no CDP command, so every tool call would sit
   * until its timeout. Knowing a dialog is open turns that into an instant,
   * actionable error.
   */
  dialogOpen: null,
};

const MAX_ACTIVITY = 200;

/** Settings that should outlive the browser session live in local storage. */
const PERSISTED_KEYS = ['mode', 'bridge'];

export async function getState() {
  const [session, local] = await Promise.all([
    api.storage.session.get('state'),
    api.storage.local.get('settings'),
  ]);
  const settings = local.settings ?? {};
  return {
    ...DEFAULTS,
    ...settings,
    ...(session.state ?? {}),
    bridge: { ...DEFAULTS.bridge, ...(settings.bridge ?? {}), ...(session.state?.bridge ?? {}) },
  };
}

/**
 * Serializes every session-storage mutation in the extension.
 *
 * Read-modify-write against one storage key, from independent async contexts,
 * loses updates: two writers that interleave both read the same base state and
 * the second silently discards the first. That surfaced as vanishing activity
 * entries and, worse, a `pinnedTabId` or `attachedTabs` that reverted under
 * load.
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
  return serialize(async () => {
    const current = await getState();
    const next = { ...current, ...patch };
    if (patch.bridge) next.bridge = { ...current.bridge, ...patch.bridge };

    await api.storage.session.set({ state: next });

    // Mirror durable settings so host/port/mode survive a browser restart.
    // serverPath/repoRoot belong here too: the repo does not move between
    // sessions, and keeping them only in session storage meant the side panel
    // fell back to a placeholder path after every extension reload.
    if (PERSISTED_KEYS.some((k) => k in patch)) {
      const { host, port, token, serverPath, repoRoot } = next.bridge;
      await api.storage.local.set({
        settings: { mode: next.mode, bridge: { host, port, token, serverPath, repoRoot } },
      });
    }

    broadcast({ type: 'state', state: next });
    return next;
  });
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
    await api.storage.session.set({ state: { ...state, activity } });
    broadcast({ type: 'activity', entry: record });
    return record;
  });
}

export function clearActivity() {
  return serialize(async () => {
    const state = await getState();
    await api.storage.session.set({ state: { ...state, activity: [] } });
    broadcast({ type: 'state', state: { ...state, activity: [] } });
  });
}

/**
 * Push an update to the side panel. The panel may not be open — a failed
 * sendMessage is normal and must not surface as an unhandled rejection.
 */
export function broadcast(message) {
  try {
    const p = api.runtime.sendMessage({ __g9: true, ...message });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* no receiver */
  }
}
