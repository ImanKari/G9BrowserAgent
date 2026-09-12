/**
 * Persistent state for the service worker.
 *
 * MV3 kills the service worker after ~30s idle. Every global variable dies with
 * it. Anything that must survive a restart lives in chrome.storage.session
 * (in-memory only, cleared when the browser closes — never written to disk).
 */

const api = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = {
  /**
   * 'workspace' | 'pinned' | 'follow' | 'multi'
   *
   * Workspace is the default as of v1.7.0. Pinned's reasoning — never let a
   * glance at your inbox hand the agent your inbox — is preserved by the
   * allowlist instead of by a click. With no allowlist, workspace behaves
   * exactly as pinned, so the weaker configuration is never the more permissive
   * one. See lib/workspace.js.
   */
  mode: 'workspace',
  /** tabId the agent is locked onto */
  pinnedTabId: null,
  /** tabIds we currently hold a chrome.debugger session on */
  attachedTabs: [],
  /**
   * Named tabs: { [name]: tabId }.
   *
   * chrome.debugger has always supported attaching to several tabs at once —
   * `attachedTabs` is an array precisely because follow and multi mode already
   * accumulate them. What was missing was a way to ADDRESS them, so a two-user
   * scenario ("seller lists an item, buyer buys it") could not be expressed.
   * A name is the address.
   */
  sessions: {},
  /**
   * The project adapter, as delivered by the bridge on connect.
   *
   * Not persisted to disk: it is the bridge's truth, re-sent on every connect.
   * Caching it would mean a stale allowlist outliving the file it came from —
   * and a stale ALLOWLIST is the one piece of stale state with a security cost.
   */
  project: {
    found: false,
    path: null,
    workspaceDomains: [],
    environments: {},
    defaultEnvironment: null,
    flowsDir: null,
    problems: [],
  },
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

/**
 * The bridge fields that are actually SETTINGS, as opposed to live status.
 *
 * `connected` and `lastError` change constantly and belong only to this
 * session. Treating any `bridge` patch as a settings change meant that every
 * reconnect attempt rewrote host/port/token to disk — a `storage.local` write
 * per backoff tick, forever, on any machine where the bridge is not running.
 *
 * It also silently reverted externally configured settings. `setup/isolated-livetest.mjs`
 * seeds a private port into `storage.local` and reloads the extension; the
 * failed-connection write that followed put 8765 straight back, so the isolated
 * browser connected to whatever bridge happened to be on the default port —
 * including the user's live session, which it then displaced. The test could
 * never pass, and running it broke real work.
 */
const BRIDGE_SETTING_FIELDS = ['host', 'port', 'token', 'serverPath', 'repoRoot'];

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
    //
    // Only when a durable value actually CHANGED, though — see
    // BRIDGE_SETTING_FIELDS. A patch that carries nothing but `connected` and
    // `lastError` is live status, not a setting, and writing it to disk is both
    // pointless traffic and a way to clobber configuration.
    const modeChanged = 'mode' in patch && patch.mode !== current.mode;
    const bridgeChanged =
      !!patch.bridge && BRIDGE_SETTING_FIELDS.some((k) => k in patch.bridge && patch.bridge[k] !== current.bridge[k]);

    if (modeChanged || bridgeChanged) {
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
 * One-time move of the stored default from Pinned to Workspace.
 *
 * Anyone who used v1.6.0 has `mode: 'pinned'` written to disk, which would beat
 * the new default forever — they would upgrade and see no change, then report
 * that Workspace mode does not work.
 *
 * **This migration cannot widen anyone's exposure**, and that is the only
 * reason it is acceptable to change a stored preference under someone. With no
 * `workspaceDomains` the new mode behaves exactly as Pinned; with domains, it
 * is still narrower than Follow, which was already one click away. A migration
 * that could grant access nobody asked for would have to be a prompt instead.
 *
 * `follow` and `multi` are left alone: those are deliberate choices.
 */
export async function migrateModeDefault() {
  const { settings } = await api.storage.local.get('settings');
  if (!settings || settings.modeDefaultMigrated) return null;

  const shouldMove = !settings.mode || settings.mode === 'pinned';
  await api.storage.local.set({
    settings: { ...settings, modeDefaultMigrated: true, ...(shouldMove ? { mode: 'workspace' } : {}) },
  });
  if (!shouldMove) return null;

  await setState({ mode: 'workspace' });
  return 'Mode moved from Pinned to Workspace (v1.7.0). With no project allowlist it behaves exactly as Pinned.';
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
