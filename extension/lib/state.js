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
 * Serializes every state mutation.
 *
 * getState/set is a read-modify-write against one storage key, and there are
 * ~24 call sites firing from independent async contexts: tool calls, debugger
 * events, connection changes, and the activity log. Two that interleave will
 * both read the same base state and the second write silently discards the
 * first. That surfaced as vanishing activity entries and, worse, a
 * `pinnedTabId` or `attachedTabs` that reverted under load.
 *
 * A promise chain costs nothing here — writes are infrequent and tiny — and it
 * makes every mutation atomic with respect to the others.
 */
let writeQueue = Promise.resolve();

function serialize(fn) {
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
