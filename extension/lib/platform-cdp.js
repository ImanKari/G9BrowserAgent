/**
 * The platform seam, Engine 2: the same surface as platform-extension.js,
 * built on raw CDP connections to browsers the daemon launched.
 *
 * Browser-safe by construction — no `node:` imports, no `chrome.*` — because
 * `platform.js` imports it statically inside the extension's service worker
 * too. The daemon injects everything that needs Node (file-backed storage, the
 * blob store, file facts for downloads) through `configure()`.
 *
 * ## One module, several browsers
 *
 * `registerEngine()` may be called for any number of launched browsers. Tab
 * handles are integers from `allocTabId()` (the daemon's global counter), so a
 * tab id alone identifies both the browser and the page — exactly as a Chrome
 * tab id does for the extension, which is what lets every tool module run
 * unchanged on either engine.
 *
 * ## Sessions, and why the registry is updated synchronously
 *
 * Every launched browser is driven with browser-level
 * `Target.setAutoAttach({flatten:true})`, so each page arrives with its own
 * session id. Cross-origin iframes are attached from the PAGE session (cdp.js
 * turns that on) and their `Target.attachedToTarget` arrives on the page — or
 * on another child, for a frame inside a frame. The child → tab map is updated
 * before any listener runs, and nothing on the event path awaits: the next
 * event on the new session may already be in the same read buffer, and an
 * unknown session would drop it on the floor.
 *
 * ## New targets are HELD until they are prepared, then resumed
 *
 * Auto-attach — the browser-level one here, and the page-level one the tool
 * layer turns on for cross-origin frames (lib/cdp.js, lib/frames.js) — runs
 * with `waitForDebuggerOnStart: true`, and every target that attaches is
 * resumed with `Runtime.runIfWaitingForDebugger` once its preparation is done
 * (`prepareTab` / `prepareChild`, configured by the daemon), or after
 * PREPARE_BUDGET_MS, whichever comes first. Nothing is ever left paused. Why:
 *
 * - A page's `window.open()` WEDGED its opener. Under browser-level flat
 *   auto-attach with waitForDebuggerOnStart:false, Chromium held the popup
 *   until somebody sent Runtime.runIfWaitingForDebugger on its session — even
 *   though its attachedToTarget said `waitingForDebugger: false` — so
 *   window.open() never returned, the click's Input.dispatchMouseEvent timed
 *   out after 20 s, and the opener's renderer stayed stuck until the tab was
 *   closed (Engine 2 live test and stealth suite, 18/18 and 7/7, Edge and
 *   Chrome 153; raw probe: 15 s hang → 37–46 ms with the resume).
 *   OAuth/SSO and payment popups all do this. Every page target is therefore
 *   resumed, whatever its flag says.
 * - A tab the PAGE opens was prepared only after its first document had run:
 *   the persona's timezone/locale arrived late (the page saw Asia/Tehran, then
 *   Europe/Berlin) and the tool layer's Network domain missed the whole first
 *   load (browser_diagnose said 0 failed requests on a page with 3).
 * - A cross-site iframe is another renderer PROCESS, and Emulation's timezone
 *   and locale overrides are per process: sent to the page session only, the
 *   frame kept the host's time zone (7/7 de-DE runs). The frame is held until
 *   `prepareChild` has sent them to its own session.
 *
 * A hook SENDS its commands and returns; it must not wait for their answers.
 * A tab the browser opens by itself (target=_blank) answers NOTHING while it
 * is held — Network.enable did not return in 8 s — but applies every command
 * sent before the resume, in order, before its first document runs (measured,
 * Edge and Chrome 153: the persona's timezone at its first script, its first
 * load's requests captured). A hook that awaited answers held such a tab for
 * the whole budget and then let it run unprepared (live round 4).
 *
 * `Runtime.runIfWaitingForDebugger` is a command, not `Runtime.enable`: it
 * adds no Runtime-domain signal at stealth (measured: 0 console-probe hits).
 *
 * ## The hidden image page
 *
 * Node has no image decoder and v2 has no dependencies (D11), so visual
 * baselines are decoded by the browser itself: one `about:blank` page per
 * engine, in its own browser context, created hidden. It is never a tab — its
 * context is excluded from the registry before its first event can arrive.
 */

// ------------------------------------------------------------------ config

const config = {
  allocTabId: null,
  storageLocal: null,
  storageSession: null,
  blobs: null,
  version: null,
  onBroadcast: null,
  defaults: { humanize: 'human', stealth: 'off' },
  fileInfo: null,
  /** string, or (engineId, browserContextId) => string|null. Fallback download folder. */
  downloadPath: null,
  /**
   * (tabId, { targetInfo, waitingForDebugger }) => void|Promise — runs while a new page target is
   * HELD (see the header), before its first document runs; the daemon SENDS the tab's context
   * defaults (focus, locale, timezone) and the tool layer's domains there, without awaiting the
   * answers. Also called, without holding, for a page that becomes a tab later (an activated
   * prerender).
   */
  prepareTab: null,
  /**
   * (tabId, { sessionId, targetInfo, parentSessionId }) => void|Promise — runs while a new CHILD
   * target of a tab (a cross-origin iframe, a worker) is held; per-process overrides are sent there.
   */
  prepareChild: null,
};

/**
 * How long a new target may be held for its preparation. It is resumed after this even if the
 * preparation has not finished — a held popup blocks its opener's window.open(), so a slow or
 * failed hook must cost at most this, never a wedged page. Typical preparation: tens of ms.
 */
export const PREPARE_BUDGET_MS = 3_000;

let localTabCounter = 0;

/**
 * Accepts the contract's options plus `fileInfo` (downloads) and
 * `downloadPath` (fallback folder for contexts registered without one).
 * Later calls merge: the daemon may configure storage first and hooks later.
 */
export function configure(opts = {}) {
  for (const key of Object.keys(config)) {
    if (opts[key] !== undefined) config[key] = opts[key];
  }
  if (opts.defaults) config.defaults = { humanize: 'human', stealth: 'off', ...opts.defaults };
  if (opts.storageLocal) storage.local = opts.storageLocal;
  if (opts.storageSession) storage.session = opts.storageSession;
  if (opts.blobs) blobStore.current = opts.blobs;
}

function allocTabId() {
  return typeof config.allocTabId === 'function' ? config.allocTabId() : ++localTabCounter;
}

// --------------------------------------------------------------- registry

/** engineId → engine record. */
const engines = new Map();
/** tabId → tab record. */
const tabsById = new Map();
/** Monotonic clock for "most recently created/activated". Never wall time: two tabs can share a millisecond. */
let activationClock = 0;
/** `${engineId}|${contextKey}` → synthetic window id, stable for the life of the process. */
const windowIds = new Map();
let windowCounter = 0;

const listeners = {
  event: new Set(),
  detach: new Set(),
  removed: new Set(),
  created: new Set(),
  updated: new Set(),
  focus: new Set(),
  download: new Set(),
};

function emit(set, ...args) {
  for (const fn of set) {
    try {
      const out = fn(...args);
      if (out && typeof out.catch === 'function') out.catch((err) => console.error('[G9] platform-cdp listener failed', err));
    } catch (err) {
      console.error('[G9] platform-cdp listener failed', err);
    }
  }
}

function newEngineRecord(engineId, conn, opts) {
  return {
    engineId,
    conn,
    registeredAt: ++activationClock,
    closed: false,
    /** true/false when the daemon said (registerEngine opts.headless); null when unknown. */
    headless: typeof opts.headless === 'boolean' ? opts.headless : null,
    targets: new Map(),
    /** targetId → tabId, for page targets that are tabs. */
    pageTabs: new Map(),
    /** sessionId → { kind: 'page'|'child'|'image'|'other', tabId?, targetId, parent? } */
    sessions: new Map(),
    /** browserContextId → { humanize, stealth, downloadPath } */
    contexts: new Map(),
    defaultContextId: null,
    defaultBrowserContextId: null,
    imageContextId: opts.imageContextId ?? null,
    ownsImageContext: false,
    image: { targetId: null, sessionId: null, globalObjectId: null, ready: null, error: null },
    /** targetId → [resolve] — callers waiting for a page session to exist. */
    attachWaiters: new Map(),
    /** frameId → tabId, for attributing a download to the page that started it. */
    frames: new Map(),
    downloads: {
      /** contextKey → Set<tabId> */
      watchers: new Map(),
      /** contextKey → folder */
      paths: new Map(),
      /** guid → DownloadEvent */
      byGuid: new Map(),
    },
    unsubscribe: [],
  };
}

const ctxKey = (browserContextId) => browserContextId ?? '';

/**
 * The `browserContextId` parameter for a command, or nothing for the default
 * context. Chrome resolves an omitted id to the default context, and passing
 * the default context's own id is refused by some commands — so it is only
 * sent for a context known to be a created one.
 */
function ctxParam(engine, browserContextId) {
  if (!browserContextId) return {};
  if (engine.defaultBrowserContextId) {
    return browserContextId === engine.defaultBrowserContextId ? {} : { browserContextId };
  }
  return engine.contexts.has(browserContextId) || browserContextId === engine.imageContextId
    ? { browserContextId }
    : {};
}

function isImageTarget(engine, info) {
  return (!!engine.imageContextId && info?.browserContextId === engine.imageContextId) ||
    (!!engine.image.targetId && info?.targetId === engine.image.targetId);
}

/**
 * Page subtypes that are not tabs (yet). A prerendered page (speculation rules
 * — search results pages use them) is a 'page' target the person never sees;
 * reported as a tab it was also the NEWEST one, so "the active tab" became a
 * page nobody had opened. On activation the browser drops the subtype in
 * `Target.targetInfoChanged`, and it becomes a tab then.
 */
const HIDDEN_PAGE_SUBTYPES = new Set(['prerender', 'portal']);

function isTabTarget(engine, info) {
  if (!info || info.type !== 'page') return false;
  if (isImageTarget(engine, info)) return false;
  if (info.subtype && HIDDEN_PAGE_SUBTYPES.has(info.subtype)) return false;
  // A DevTools window on a headed engine is a 'page' target too, and not one anybody tests.
  return !String(info.url ?? '').startsWith('devtools://');
}

/**
 * A target that just became a tab (an activated prerender) may already have a
 * session from browser-level auto-attach, recorded as 'other'. Adopt it as the
 * page session instead of leaving the tab detached behind a live session.
 */
function adoptSession(engine, tab) {
  if (tab.sessionId) return;
  for (const [sid, s] of engine.sessions) {
    if (s.kind !== 'other' || s.targetId !== tab.targetId) continue;
    engine.sessions.set(sid, { kind: 'page', tabId: tab.tabId, targetId: tab.targetId });
    tab.sessionId = sid;
    // Already running (it was resumed as 'other'): prepared now, without holding.
    if (typeof config.prepareTab === 'function') {
      tab.ready = Promise.resolve()
        .then(() => config.prepareTab(tab.tabId, { targetInfo: engine.targets.get(tab.targetId) ?? null, waitingForDebugger: false }))
        .catch((err) => console.error(`[G9] platform-cdp: preparing tab ${tab.tabId} failed`, err));
    }
    resolveAttachWaiters(engine, tab.targetId);
    return;
  }
}

function windowIdFor(engineId, browserContextId) {
  const key = `${engineId}|${ctxKey(browserContextId)}`;
  if (!windowIds.has(key)) windowIds.set(key, ++windowCounter);
  return windowIds.get(key);
}

function windowKeyOf(windowId) {
  for (const [key, id] of windowIds) {
    if (id !== windowId) continue;
    const bar = key.indexOf('|');
    return { engineId: key.slice(0, bar), browserContextId: key.slice(bar + 1) || null };
  }
  return null;
}

function ensureTab(engine, info) {
  const existing = engine.pageTabs.get(info.targetId);
  if (existing != null) return tabsById.get(existing);
  const tab = {
    tabId: allocTabId(),
    engineId: engine.engineId,
    targetId: info.targetId,
    sessionId: null,
    browserContextId: info.browserContextId ?? null,
    url: info.url ?? '',
    title: info.title ?? '',
    openerTabId: info.openerId ? (engine.pageTabs.get(info.openerId) ?? null) : null,
    status: 'complete',
    activatedAt: ++activationClock,
    removed: false,
  };
  tabsById.set(tab.tabId, tab);
  engine.pageTabs.set(info.targetId, tab.tabId);
  // A page target's id is also its main frame's id.
  engine.frames.set(info.targetId, tab.tabId);
  emit(listeners.created, toTab(tab));
  return tab;
}

/** Most recently activated live tab among `list`, or null. */
function mostRecent(list) {
  let best = null;
  for (const tab of list) if (!best || tab.activatedAt > best.activatedAt) best = tab;
  return best;
}

function liveTabs() {
  return [...tabsById.values()].filter((t) => !t.removed);
}

function sameWindow(a, b) {
  return a.engineId === b.engineId && ctxKey(a.browserContextId) === ctxKey(b.browserContextId);
}

/**
 * Is this tab the one in front of its REAL browser window?
 *
 * Windows here are synthetic (one per context), but the browser's are real: every page G9 opens has
 * one of its own (createTabIn), and a page the PAGE opens (target=_blank, window.open) joins its
 * opener's window IN FRONT of it. A tab behind another in its window is driven at a fraction of
 * the frame rate even headless: the opener behind a page-opened tab took 20.9 s per humanized
 * click and 24–46 s per screenshot (P8 matrix, round 3, 4/4), and nothing said so — the tab list
 * reported every G9-opened tab active:false (the synthetic rule: newest of the context) whether or
 * not anything was in front of it. So: the most recently activated live tab of its real window
 * (tab.realWindowId, learned when its session attaches). Unknown window → the synthetic rule.
 */
function isActive(tab) {
  if (tab.realWindowId == null) return mostRecent(liveTabs().filter((t) => sameWindow(t, tab))) === tab;
  return !liveTabs().some((t) => t !== tab && t.engineId === tab.engineId && t.realWindowId === tab.realWindowId && t.activatedAt > tab.activatedAt);
}

/** Learn which real browser window a tab is in (Browser.getWindowForTarget). Never throws. */
async function learnWindow(engine, tab) {
  if (engine.closed || tab.removed) return null;
  try {
    const res = await engine.conn.send('Browser.getWindowForTarget', { targetId: tab.targetId }, null, { timeoutMs: REFRESH_TIMEOUT_MS });
    if (Number.isInteger(res?.windowId)) tab.realWindowId = res.windowId;
    return res ?? null;
  } catch {
    return null;
  }
}

function inDefaultContext(tab) {
  const engine = engines.get(tab.engineId);
  if (!engine) return false;
  if (engine.defaultContextId) return tab.browserContextId === engine.defaultContextId;
  if (engine.defaultBrowserContextId) return tab.browserContextId === engine.defaultBrowserContextId;
  return !engine.contexts.has(tab.browserContextId);
}

/** The tab `{active:true, lastFocusedWindow:true}` means: newest in a default context, else newest anywhere. */
function focusedTab() {
  const live = liveTabs();
  return mostRecent(live.filter(inDefaultContext)) ?? mostRecent(live);
}

function toTab(tab) {
  return {
    id: tab.tabId,
    url: tab.url,
    title: tab.title,
    windowId: windowIdFor(tab.engineId, tab.browserContextId),
    active: !tab.removed && isActive(tab),
    // A page G9 opened got a real window of its own (createTabIn). `active` says whether it is
    // still the one in front of it (a page-opened tab joins it in front — isActive).
    ...(tab.ownWindow ? { ownWindow: true } : {}),
    status: tab.status,
    ...(tab.openerTabId != null ? { openerTabId: tab.openerTabId } : {}),
    engineId: tab.engineId,
    contextId: tab.browserContextId,
  };
}

function requireTabRecord(tabId) {
  const tab = tabsById.get(tabId);
  if (!tab || tab.removed) throw new Error(`No tab with id: ${tabId}.`);
  return tab;
}

function engineOf(tab) {
  const engine = engines.get(tab.engineId);
  if (!engine || engine.closed) throw new Error(`The browser that owned tab ${tab.tabId} has gone away.`);
  return engine;
}

/** The engine a context-less call should use: the focused tab's, else the newest registered. */
function defaultEngine() {
  const tab = focusedTab();
  if (tab && engines.has(tab.engineId)) return engines.get(tab.engineId);
  let best = null;
  for (const engine of engines.values()) if (!engine.closed && (!best || engine.registeredAt > best.registeredAt)) best = engine;
  if (!best) throw new Error('No launched browser is registered with the daemon.');
  return best;
}

function dropChildSessions(engine, tabId) {
  for (const [sid, s] of engine.sessions) {
    if (s.kind === 'child' && s.tabId === tabId) engine.sessions.delete(sid);
  }
}

/** Drop a child session and every session nested beneath it. */
function dropChildTree(engine, sessionId) {
  const doomed = [sessionId];
  while (doomed.length) {
    const sid = doomed.pop();
    engine.sessions.delete(sid);
    for (const [other, s] of engine.sessions) if (s.parent === sid) doomed.push(other);
  }
}

function removeTab(engine, tab, reason = 'target_closed') {
  if (tab.removed) return;
  tab.removed = true;
  const hadSession = !!tab.sessionId;
  if (tab.sessionId) engine.sessions.delete(tab.sessionId);
  tab.sessionId = null;
  dropChildSessions(engine, tab.tabId);
  engine.pageTabs.delete(tab.targetId);
  for (const [frameId, id] of engine.frames) if (id === tab.tabId) engine.frames.delete(frameId);
  for (const set of engine.downloads.watchers.values()) set.delete(tab.tabId);
  tabsById.delete(tab.tabId);
  // Same order as Chrome: the debugger lets go, then the tab is gone.
  if (hadSession) emit(listeners.detach, { tabId: tab.tabId }, reason);
  emit(listeners.removed, tab.tabId);
}

/**
 * Let a held target run. Fire-and-forget: the answer carries nothing, and a target that is already
 * running (attached before auto-attach was on, or resumed twice) simply acknowledges it. Sent to
 * EVERY attached target: a window.open() popup is held even when its attachedToTarget said
 * waitingForDebugger:false (see the header).
 */
function resume(engine, sessionId) {
  if (engine.closed || !sessionId) return;
  try {
    const sent = engine.conn.send('Runtime.runIfWaitingForDebugger', {}, sessionId, { timeoutMs: 10_000 });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch {
    /* the pipe is gone; so is the target */
  }
}

/**
 * Run `work` (a preparation hook) while the target on `sessionId` is held, then resume it — after
 * the work settles or after PREPARE_BUDGET_MS, whichever is first. Never awaited on the event path:
 * the work starts in a microtask, after the registry was updated synchronously. Resolves once the
 * resume has been SENT.
 */
function prepareThenResume(engine, sessionId, work, label) {
  if (typeof work !== 'function') {
    resume(engine, sessionId);
    return Promise.resolve();
  }
  let timer;
  const budget = new Promise((resolve) => { timer = setTimeout(resolve, PREPARE_BUDGET_MS); });
  const prepared = Promise.resolve()
    .then(work)
    .catch((err) => console.error(`[G9] platform-cdp: preparing ${label} failed; resuming it unprepared`, err));
  return Promise.race([prepared, budget]).finally(() => {
    clearTimeout(timer);
    resume(engine, sessionId);
  });
}

function resolveAttachWaiters(engine, targetId) {
  const waiters = engine.attachWaiters.get(targetId);
  if (!waiters) return;
  engine.attachWaiters.delete(targetId);
  for (const resolve of waiters) resolve();
}

// ---------------------------------------------------------- event handling

function handleEvent(engine, method, params = {}, sessionId = null) {
  if (engine.closed) return;
  if (!sessionId) {
    handleBrowserEvent(engine, method, params);
    return;
  }
  const session = engine.sessions.get(sessionId);
  const tab = session && (session.kind === 'page' || session.kind === 'child') ? tabsById.get(session.tabId) : null;
  if (!tab || tab.removed) {
    // A child of something that is not (or no longer) a tab — a worker of a service worker, a frame
    // of a page being torn down. Nobody will prepare it, and a held target never runs: resume it.
    if (method === 'Target.attachedToTarget' && params.sessionId) resume(engine, params.sessionId);
    return;
  }

  // Registry upkeep first, synchronously — see the header.
  if (method === 'Target.attachedToTarget' && params.sessionId) {
    engine.sessions.set(params.sessionId, {
      kind: 'child',
      tabId: tab.tabId,
      targetId: params.targetInfo?.targetId ?? null,
      parent: sessionId,
    });
    if (params.targetInfo?.type === 'iframe') engine.frames.set(params.targetInfo.targetId, tab.tabId);
    // Held (the tool layer's page-level auto-attach waits for the debugger, see sendCommand):
    // prepared, then resumed.
    const child = { sessionId: params.sessionId, targetInfo: params.targetInfo ?? null, parentSessionId: sessionId };
    prepareThenResume(
      engine,
      params.sessionId,
      typeof config.prepareChild === 'function' ? () => config.prepareChild(tab.tabId, child) : null,
      `a ${params.targetInfo?.type ?? 'child'} target of tab ${tab.tabId}`,
    );
  }
  if (method === 'Page.frameAttached' && params.frameId) engine.frames.set(params.frameId, tab.tabId);
  if (method === 'Page.frameNavigated' && params.frame?.id) engine.frames.set(params.frame.id, tab.tabId);

  if (session.kind === 'page') trackLoadState(tab, method, params);

  const source = session.kind === 'page' ? { tabId: tab.tabId } : { tabId: tab.tabId, sessionId };
  emit(listeners.event, source, method, params);

  // After the listeners, so frames.onDetached can still see what it is forgetting.
  if (method === 'Target.detachedFromTarget' && params.sessionId) dropChildTree(engine, params.sessionId);
}

function trackLoadState(tab, method, params) {
  let status = null;
  if (method === 'Page.frameStartedLoading' && params.frameId === tab.targetId) status = 'loading';
  else if ((method === 'Page.frameStoppedLoading' && params.frameId === tab.targetId) || method === 'Page.loadEventFired') status = 'complete';
  if (status && status !== tab.status) {
    tab.status = status;
    emit(listeners.updated, tab.tabId, { status }, toTab(tab));
  }
}

function handleBrowserEvent(engine, method, params) {
  switch (method) {
    case 'Target.targetCreated': {
      const info = params.targetInfo;
      if (!info) return;
      engine.targets.set(info.targetId, info);
      if (isTabTarget(engine, info)) ensureTab(engine, info);
      return;
    }
    case 'Target.targetInfoChanged': {
      const info = params.targetInfo;
      if (!info) return;
      engine.targets.set(info.targetId, info);
      const tabId = engine.pageTabs.get(info.targetId);
      if (tabId == null) {
        if (isTabTarget(engine, info)) adoptSession(engine, ensureTab(engine, info));
        return;
      }
      applyInfo(tabsById.get(tabId), info);
      return;
    }
    case 'Target.targetDestroyed': {
      engine.targets.delete(params.targetId);
      const tabId = engine.pageTabs.get(params.targetId);
      if (tabId != null) removeTab(engine, tabsById.get(tabId), 'target_closed');
      if (params.targetId === engine.image.targetId) {
        engine.image.targetId = null;
        engine.image.sessionId = null;
        engine.image.globalObjectId = null;
      }
      return;
    }
    case 'Target.attachedToTarget': {
      const info = params.targetInfo ?? {};
      if (!params.sessionId) return;
      engine.targets.set(info.targetId, info);
      if (isImageTarget(engine, info)) {
        engine.sessions.set(params.sessionId, { kind: 'image', targetId: info.targetId });
        engine.image.targetId = engine.image.targetId ?? info.targetId;
        engine.image.sessionId = params.sessionId;
        engine.image.globalObjectId = null;
        resume(engine, params.sessionId);
        resolveAttachWaiters(engine, info.targetId);
        return;
      }
      if (isTabTarget(engine, info)) {
        const tab = ensureTab(engine, info);
        tab.sessionId = params.sessionId;
        engine.sessions.set(params.sessionId, { kind: 'page', tabId: tab.tabId, targetId: info.targetId });
        // Which real window it is in (isActive): asked now, answered by the browser while it is held.
        learnWindow(engine, tab);
        // Held until prepared (context defaults, the tool layer's domains), then resumed — see the
        // header. Set before the waiters run, so createTabIn can wait for it.
        tab.ready = prepareThenResume(
          engine,
          params.sessionId,
          typeof config.prepareTab === 'function'
            ? () => config.prepareTab(tab.tabId, { targetInfo: info, waitingForDebugger: params.waitingForDebugger === true })
            : null,
          `tab ${tab.tabId}`,
        );
        resolveAttachWaiters(engine, info.targetId);
        return;
      }
      // Service workers, shared workers, browser-level iframes, prerenders: known, not tabs. Nothing
      // to prepare; resumed at once.
      engine.sessions.set(params.sessionId, { kind: 'other', targetId: info.targetId });
      resume(engine, params.sessionId);
      return;
    }
    case 'Target.detachedFromTarget': {
      const session = engine.sessions.get(params.sessionId);
      if (!session) return;
      engine.sessions.delete(params.sessionId);
      if (session.kind === 'image') {
        engine.image.sessionId = null;
        engine.image.globalObjectId = null;
      }
      if (session.kind === 'page') {
        const tab = tabsById.get(session.tabId);
        if (tab && tab.sessionId === params.sessionId) {
          tab.sessionId = null;
          dropChildSessions(engine, tab.tabId);
          emit(listeners.detach, { tabId: tab.tabId }, 'target_closed');
        }
      }
      return;
    }
    case 'Browser.downloadWillBegin':
      onDownloadWillBegin(engine, params);
      return;
    case 'Browser.downloadProgress':
      onDownloadProgress(engine, params);
      return;
    default:
  }
}

/** Take a target's current url/title; tell onUpdated listeners what changed. */
function applyInfo(tab, info) {
  if (!tab || tab.removed || !info) return;
  const change = {};
  if (info.url != null && info.url !== tab.url) change.url = tab.url = info.url;
  if (info.title != null && info.title !== tab.title) change.title = tab.title = info.title;
  if (Object.keys(change).length) emit(listeners.updated, tab.tabId, change, toTab(tab));
}

/**
 * Re-read url/title from the browser before answering a tab read.
 *
 * `Target.targetInfoChanged` is the push path, and it is not prompt for every
 * change: measured on headless Edge 153, a page's <title> did not arrive as an
 * event within 2.5s of load — it came only after something asked with
 * `Target.getTargets`. A tab list that shows the host name where the title
 * should be, or a stale URL that trips the snapshot staleness check, is worse
 * than one cheap round trip on the pipe. Failures (a busy or closing browser)
 * leave the last known values in place; bounded so a wedged browser cannot hold
 * a tab read hostage.
 */
const REFRESH_TIMEOUT_MS = 3_000;

/** A browser read that may fail (or throw synchronously on a closed pipe) without failing the caller. */
async function tryBrowserSend(engine, method, params) {
  try {
    return await engine.conn.send(method, params, null, { timeoutMs: REFRESH_TIMEOUT_MS });
  } catch {
    return null;
  }
}

async function refreshTab(tab) {
  const engine = engines.get(tab.engineId);
  if (!engine || engine.closed) return;
  const res = await tryBrowserSend(engine, 'Target.getTargetInfo', { targetId: tab.targetId });
  if (res?.targetInfo) applyInfo(tab, res.targetInfo);
}

async function refreshAll() {
  await Promise.all([...engines.values()].filter((e) => !e.closed).map(async (engine) => {
    const res = await tryBrowserSend(engine, 'Target.getTargets', {});
    for (const info of res?.targetInfos ?? []) {
      const tabId = engine.pageTabs.get(info.targetId);
      if (tabId != null) applyInfo(tabsById.get(tabId), info);
    }
  }));
}

// ------------------------------------------------------------- engines API

/**
 * Take ownership of a launched browser's CDP connection.
 *
 * `conn` is engine/pipe-cdp.js's PipeCdp (or anything with the same shape:
 * send(method, params, sessionId, {timeoutMs}), on('event'|'close'), close()).
 */
export async function registerEngine(engineId, conn, opts = {}) {
  if (engines.has(engineId)) throw new Error(`Engine "${engineId}" is already registered.`);
  const engine = newEngineRecord(engineId, conn, opts);
  engines.set(engineId, engine);

  const onEvent = (method, params, sessionId) => handleEvent(engine, method, params, sessionId ?? null);
  const onClose = () => unregisterEngine(engineId);
  conn.on('event', onEvent);
  conn.on('close', onClose);
  engine.unsubscribe.push(() => {
    const off = conn.off ?? conn.removeListener;
    if (typeof off === 'function') {
      off.call(conn, 'event', onEvent);
      off.call(conn, 'close', onClose);
    }
  });

  try {
    // Learn the default context's id when the browser offers it (Chrome 128+):
    // it is how commands tell "the default context" from a created one.
    const contexts = await conn.send('Target.getBrowserContexts', {}).catch(() => null);
    engine.defaultBrowserContextId = contexts?.defaultBrowserContextId ?? null;

    // The image context exists BEFORE any target is created in it, so its page
    // can never be mistaken for a tab — not even for the one event that may
    // arrive ahead of the createTarget response.
    if (!engine.imageContextId) {
      try {
        const { browserContextId } = await conn.send('Target.createBrowserContext', { disposeOnDetach: true });
        engine.imageContextId = browserContextId ?? null;
        engine.ownsImageContext = !!browserContextId;
      } catch (err) {
        engine.image.error = err;
      }
    }

    await conn.send('Target.setDiscoverTargets', { discover: true });
    // Every new target waits for its preparation and is then resumed (see the header). Targets
    // that already exist attach running.
    await conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  } catch (err) {
    unregisterEngine(engineId);
    throw err;
  }

  // Created now, used on the first visual comparison. A failure is remembered
  // and retried on first use rather than failing the whole engine: nothing but
  // visual baselines needs it.
  if (engine.imageContextId) {
    await ensureImagePage(engine).catch((err) => {
      engine.image.error = err;
    });
  }
}

/** Forget a browser: its tabs are gone (onDetach 'target_closed', then onRemoved). */
export function unregisterEngine(engineId) {
  const engine = engines.get(engineId);
  if (!engine) return;
  engine.closed = true;
  engines.delete(engineId);
  for (const off of engine.unsubscribe) {
    try {
      off();
    } catch {
      /* the connection is already gone */
    }
  }
  for (const tabId of [...engine.pageTabs.values()]) {
    const tab = tabsById.get(tabId);
    if (!tab) continue;
    // Force the detach notice even if the page session was already dropped:
    // for every consumer, a vanished browser is a detach AND a close.
    if (!tab.sessionId) tab.sessionId = 'gone';
    removeTab(engine, tab, 'target_closed');
  }
  for (const waiters of engine.attachWaiters.values()) for (const resolve of waiters) resolve();
  engine.attachWaiters.clear();
  for (const key of [...windowIds.keys()]) if (key.startsWith(`${engineId}|`)) windowIds.delete(key);
}

export function registerContext(engineId, browserContextId, { humanize, stealth, downloadPath } = {}) {
  const engine = engines.get(engineId);
  if (!engine) throw new Error(`Unknown engine "${engineId}".`);
  engine.contexts.set(browserContextId, {
    ...(humanize != null ? { humanize } : {}),
    ...(stealth != null ? { stealth } : {}),
    ...(downloadPath != null ? { downloadPath } : {}),
  });
}

export function setDefaultContext(engineId, browserContextId) {
  const engine = engines.get(engineId);
  if (!engine) throw new Error(`Unknown engine "${engineId}".`);
  engine.defaultContextId = browserContextId ?? null;
}

/** Explicit placement (the daemon's `open`): a foreground tab in that context. */
export async function createTab(engineId, browserContextId, url) {
  const engine = engines.get(engineId);
  if (!engine || engine.closed) throw new Error(`Unknown engine "${engineId}".`);
  return createTabIn(engine, browserContextId ?? engine.defaultContextId, url, { active: true });
}

export function tabInfo(tabId) {
  const tab = tabsById.get(tabId);
  if (!tab || tab.removed) return null;
  return {
    engineId: tab.engineId,
    targetId: tab.targetId,
    sessionId: tab.sessionId,
    browserContextId: tab.browserContextId,
    url: tab.url ?? '',
    ...(tab.createdByG9 ? { createdByG9: true } : {}),
  };
}

/**
 * Send a context's downloads to its folder, with events on, as soon as the context exists
 * (EngineManager calls this at launch for the default context and in createContext). Until a
 * watch_downloads ran, the browser otherwise saved every download into the PROFILE's default
 * directory — the Windows user's own Downloads — and emitted nothing (engine review, 2026-09-22).
 * `allowAndName` as downloads.begin: files are saved under their GUID, never renamed "(3)".
 * `browserContextId` null is the default context of a browser that did not name it.
 */
export async function configureContextDownloads(engineId, browserContextId, { downloadPath } = {}) {
  const engine = engines.get(engineId);
  if (!engine || engine.closed) throw new Error(`Unknown engine "${engineId}".`);
  const folder = folderFor(engine, browserContextId, downloadPath);
  if (!folder) throw new Error('no download folder is known for this context');
  await engine.conn.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: folder,
    eventsEnabled: true,
    ...ctxParam(engine, browserContextId),
  });
  engine.downloads.paths.set(ctxKey(browserContextId), folder);
  return { downloadPath: folder };
}

export function tabsOf(engineId) {
  const engine = engines.get(engineId);
  return engine ? [...engine.pageTabs.values()] : [];
}

function waitForSession(engine, targetId, timeoutMs) {
  const tabId = engine.pageTabs.get(targetId);
  if (tabId != null && tabsById.get(tabId)?.sessionId) return Promise.resolve(true);
  if (engine.image.targetId === targetId && engine.image.sessionId) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const set = engine.attachWaiters.get(targetId);
      set?.delete(done);
      // A target that never attached must not leave an empty entry behind per try.
      if (set && !set.size) engine.attachWaiters.delete(targetId);
      resolve(false);
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    if (!engine.attachWaiters.has(targetId)) engine.attachWaiters.set(targetId, new Set());
    engine.attachWaiters.get(targetId).add(done);
  });
}

async function attachTarget(engine, targetId) {
  const { sessionId } = await engine.conn.send('Target.attachToTarget', { targetId, flatten: true });
  return sessionId;
}

/**
 * Is `tab` in the browser context `browserContextId` (null = the default one)?
 * Pages of the default context report its real id where the browser names it
 * (Chrome 128+: Target.getBrowserContexts' defaultBrowserContextId); older
 * builds are read the way inDefaultContext() does: not a created context.
 */
function inBrowserContext(engine, tab, browserContextId) {
  const wantsDefault = !browserContextId || browserContextId === engine.defaultBrowserContextId;
  if (!wantsDefault) return tab.browserContextId === browserContextId;
  if (engine.defaultBrowserContextId) return (tab.browserContextId ?? engine.defaultBrowserContextId) === engine.defaultBrowserContextId;
  return !tab.browserContextId || (!engine.contexts.has(tab.browserContextId) && tab.browserContextId !== engine.imageContextId);
}


/**
 * Where a new page's window goes: the bounds of a window this engine already
 * has (a page of the same context first, else any page), so a headed engine
 * launched off-screen or on a chosen monitor keeps its new windows there, and
 * a headless one gives every window the launch's size. Null when there is no
 * page to copy from or the browser does not say. The window STATE is never
 * copied: a new window is 'normal', because a minimized one renders no frames.
 */
async function windowBoundsFor(engine, browserContextId) {
  let candidate = null;
  for (const tabId of engine.pageTabs.values()) {
    const tab = tabsById.get(tabId);
    if (!tab || tab.removed) continue;
    if (inBrowserContext(engine, tab, browserContextId)) { candidate = tab; break; }
    candidate ??= tab;
  }
  if (!candidate) return null;
  try {
    const { bounds } = await engine.conn.send('Browser.getWindowForTarget', { targetId: candidate.targetId }, null, { timeoutMs: 3000 });
    const out = { left: bounds?.left, top: bounds?.top, width: bounds?.width, height: bounds?.height };
    if (!Object.values(out).every(Number.isFinite) || out.width <= 0 || out.height <= 0) return null;
    return out;
  } catch {
    return null;
  }
}

async function createTabIn(engine, browserContextId, url, { active = false } = {}) {
  // EVERY page gets a window of its own (newWindow:true).
  //
  // It used to be only the first page of a context — Chrome and Edge refuse
  // newWindow:false for the FIRST page of a fresh browser context ("Failed to
  // open new tab - no browser is open", measured on headless Edge 153) — and
  // later pages joined that window as tabs, "as a person's would". But a tab
  // behind another one in its window is not driven at the normal frame rate,
  // headless included, even with --disable-renderer-backgrounding and a
  // visibilityState that still says "visible": after a second foreground tab
  // opened in the same context, the first one rendered ~1 frame per 1.5 s and
  // every mouse event on it took ~1 s — a humanized click (≈80 events) took
  // 85 s, typing 100 s, a screenshot 46 s (P8 matrix, round 2, 3/3 runs; the
  // same tab with the second one created in the background: 2–11 ms per
  // event). Any agent that opens a second tab, or two agents sharing the
  // default context, left the earlier tab in that state. A window per page
  // keeps every page in front of its own window; headless windows cost
  // nothing, and a headed engine's new window takes an existing window's
  // bounds (windowBoundsFor) so it opens where the engine lives.
  // (A page the PAGE opens — window.open, target=_blank — still joins its
  // opener's window, as it would for a person.)
  const bounds = await windowBoundsFor(engine, browserContextId);
  const params = {
    url: url || 'about:blank',
    newWindow: true,
    background: !active,
    // Never take the OS keyboard focus: G9 needs none (pages get focus emulation), and a
    // headed engine's new window must not steal the keyboard from the person at the desk.
    focus: false,
    ...(bounds ?? {}),
    ...ctxParam(engine, browserContextId),
  };
  let created;
  try {
    created = await engine.conn.send('Target.createTarget', params);
  } catch (err) {
    // A browser that does not take the bounds (an older build: "Invalid parameters") still makes
    // the window without them. Any other refusal is the answer.
    if (!bounds || !/invalid param|bounds|\b(left|top|width|height)\b/i.test(String(err?.message ?? err))) throw err;
    const { left, top, width, height, ...plain } = params;
    created = await engine.conn.send('Target.createTarget', plain);
  }
  const { targetId } = created;
  // Auto-attach normally delivers the page session within milliseconds; a
  // browser that does not gets an explicit attach instead of a hang.
  if (!(await waitForSession(engine, targetId, 5_000))) {
    const info = engine.targets.get(targetId) ?? { targetId, type: 'page', url: url ?? '', browserContextId };
    const tab = ensureTab(engine, info);
    const sessionId = await attachTarget(engine, targetId);
    if (!tab.sessionId) {
      tab.sessionId = sessionId;
      engine.sessions.set(sessionId, { kind: 'page', tabId: tab.tabId, targetId });
    }
  }
  const tabId = engine.pageTabs.get(targetId);
  if (tabId == null) throw new Error(`The browser created target ${targetId} but it never became a tab.`);
  const tab = tabsById.get(tabId);
  // G9 asked for this page: the manager's start-up sweep never takes it for a stray.
  tab.createdByG9 = true;
  // Its preparation (context defaults, the tool layer) is done — or the budget ran out — and it
  // has been resumed: a caller that navigates it next gets a prepared first document.
  if (tab.ready) await tab.ready;
  if (tab.realWindowId == null) await learnWindow(engine, tab);
  if (!tab.url && url) tab.url = url;
  tab.ownWindow = true;
  if (active) tab.activatedAt = ++activationClock;
  return toTab(tab);
}

// ----------------------------------------------------------------- debugger

const debuggerApi = {
  async attach(tabId) {
    const tab = requireTabRecord(tabId);
    if (tab.sessionId) return;
    const engine = engineOf(tab);
    const sessionId = await attachTarget(engine, tab.targetId);
    // The attachedToTarget event may have registered it already; either way one session wins.
    if (!tab.sessionId) {
      tab.sessionId = sessionId;
      engine.sessions.set(sessionId, { kind: 'page', tabId: tab.tabId, targetId: tab.targetId });
    }
  },

  /** Launched-engine tabs are always attached; there is no banner to take down. */
  async detach() {},

  async sendCommand(tabId, method, params = {}, sessionId = null, { timeoutMs } = {}) {
    const tab = requireTabRecord(tabId);
    const engine = engineOf(tab);
    const target = sessionId ?? tab.sessionId;
    if (!target) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
    // The tool layer's page-level auto-attach (cross-origin frames, workers) is written for both
    // engines with waitForDebuggerOnStart:false. On a launched engine every attached child is
    // prepared and then resumed here (handleEvent), so it is HELD instead: a cross-site frame's
    // renderer gets the context's timezone and locale before its first script (see the header).
    if (method === 'Target.setAutoAttach' && params?.autoAttach) params = { ...params, waitForDebuggerOnStart: true };
    try {
      // A little longer than cdp.js's own budget, so ITS message — which names
      // the stuck command and explains it — is the one the agent reads.
      return await engine.conn.send(method, params, target, timeoutMs ? { timeoutMs: timeoutMs + 2_000 } : {});
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (!sessionId && /Session with given id not found|No session with given id/i.test(msg)) {
        // The page session died under us (renderer swap, crash). Say it in the
        // words cdp.send retries on, so one re-attach recovers it.
        if (tab.sessionId === target) tab.sessionId = null;
        throw new Error(`Debugger is not attached to the tab with id: ${tabId}. (${msg})`);
      }
      throw err;
    }
  },

  async getTargets() {
    return liveTabs().map((t) => ({ tabId: t.tabId, attached: !!t.sessionId }));
  },

  onEvent(fn) {
    listeners.event.add(fn);
    return () => listeners.event.delete(fn);
  },

  onDetach(fn) {
    listeners.detach.add(fn);
    return () => listeners.detach.delete(fn);
  },
};

// --------------------------------------------------------------------- tabs

const tabs = {
  async get(tabId) {
    const tab = requireTabRecord(tabId);
    await refreshTab(tab);
    if (tab.removed) throw new Error(`No tab with id: ${tabId}.`);
    return toTab(tab);
  },

  /**
   * Supports what the tool code asks: {}, {active}, {windowId},
   * {lastFocusedWindow|currentWindow}, {status}, {url} (a string or list of
   * match patterns with `*`).
   */
  async query(info = {}) {
    await refreshAll();
    let list = liveTabs();
    if (info.windowId != null) list = list.filter((t) => windowIdFor(t.engineId, t.browserContextId) === info.windowId);
    if (info.active === true) {
      if (info.windowId == null && (info.lastFocusedWindow || info.currentWindow)) {
        const focused = focusedTab();
        list = focused && list.includes(focused) ? [focused] : [];
      } else {
        list = list.filter(isActive);
      }
    } else if (info.active === false) {
      list = list.filter((t) => !isActive(t));
    }
    if (info.status) list = list.filter((t) => t.status === info.status);
    if (info.url) {
      const patterns = (Array.isArray(info.url) ? info.url : [info.url]).map(globToRegex);
      list = list.filter((t) => patterns.some((re) => re.test(t.url)));
    }
    return list.map(toTab);
  },

  async create({ url, active = false, windowId } = {}) {
    let engine;
    let browserContextId;
    if (windowId != null) {
      const key = windowKeyOf(windowId);
      if (!key || !engines.has(key.engineId)) throw new Error(`No window with id: ${windowId}.`);
      engine = engines.get(key.engineId);
      browserContextId = key.browserContextId;
    } else {
      engine = defaultEngine();
      browserContextId = engine.defaultContextId;
    }
    return createTabIn(engine, browserContextId, url, { active });
  },

  async update(tabId, { url, active } = {}) {
    const tab = requireTabRecord(tabId);
    const engine = engineOf(tab);
    if (url) {
      if (!tab.sessionId) await debuggerApi.attach(tabId);
      // Page.navigate answers when the server's response headers arrive, so a slow server — not a
      // stuck browser — decides how long it takes (live round 3: a 25 s first byte failed at the
      // 20 s default as "stuck"). An open with a URL waits for that up to NAVIGATE_COMMIT_MS.
      const result = await engine.conn.send('Page.navigate', { url }, tab.sessionId, { timeoutMs: NAVIGATE_COMMIT_MS });
      if (result?.errorText) throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
    }
    if (active) {
      await engine.conn.send('Target.activateTarget', { targetId: tab.targetId }).catch(() => {});
      tab.activatedAt = ++activationClock;
    }
    return toTab(tab);
  },

  async remove(tabId) {
    const tab = requireTabRecord(tabId);
    const engine = engineOf(tab);
    await engine.conn.send('Target.closeTarget', { targetId: tab.targetId });
    removeTab(engine, tab, 'target_closed');
  },

  /**
   * Before input or a capture: is the tab in front of its real window, and if it is not, can it be?
   * (Launched engines only; the extension never moves a person's tabs by itself.)
   *
   * A HEADLESS engine's tab behind a page-opened tab is brought to the front (Target.activateTarget)
   * — there is no person and no OS focus to take, and the tab behind is starved of frames (see
   * isActive: 20.9 s clicks, 24–46 s screenshots; after browser_tabs focus 4.4 s and 53 ms). A
   * HEADED engine's tab is left where the person sees it, and reported.
   * → { front: true } | { front: true, activated: true } | { front: false, behind: true, headless }
   */
  async ensureFront(tabId) {
    const tab = requireTabRecord(tabId);
    const engine = engineOf(tab);
    if (tab.realWindowId == null) await learnWindow(engine, tab);
    if (isActive(tab)) return { front: true };
    if (engine.headless !== true) return { front: false, behind: true, headless: engine.headless };
    await engine.conn.send('Target.activateTarget', { targetId: tab.targetId }, null, { timeoutMs: REFRESH_TIMEOUT_MS }).catch(() => {});
    tab.activatedAt = ++activationClock;
    return { front: true, activated: true };
  },

  onRemoved(fn) {
    listeners.removed.add(fn);
  },
  onCreated(fn) {
    listeners.created.add(fn);
  },
  onUpdated(fn) {
    listeners.updated.add(fn);
  },
};

/** How long tabs.update({url}) waits for the navigation to commit (the server's response headers). */
export const NAVIGATE_COMMIT_MS = 60_000;

function globToRegex(pattern) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

// ------------------------------------------------------------------ windows

function windowObject(windowId, { populate = false } = {}) {
  const key = windowKeyOf(windowId);
  if (!key || !engines.has(key.engineId)) return null;
  const members = liveTabs().filter((t) => t.engineId === key.engineId && ctxKey(t.browserContextId) === ctxKey(key.browserContextId));
  return {
    id: windowId,
    type: 'normal',
    state: 'normal',
    focused: true,
    incognito: false,
    alwaysOnTop: false,
    engineId: key.engineId,
    contextId: key.browserContextId,
    ...(populate ? { tabs: members.map(toTab) } : {}),
  };
}

const windows = {
  WINDOW_ID_NONE: -1,
  async get(windowId, opts = {}) {
    const win = windowObject(windowId, opts);
    if (!win) throw new Error(`No window with id: ${windowId}.`);
    return win;
  },
  async getAll(opts = {}) {
    const ids = new Set();
    for (const tab of liveTabs()) ids.add(windowIdFor(tab.engineId, tab.browserContextId));
    for (const engine of engines.values()) for (const ctx of engine.contexts.keys()) ids.add(windowIdFor(engine.engineId, ctx));
    return [...ids].sort((a, b) => a - b).map((id) => windowObject(id, opts)).filter(Boolean);
  },
  async create() {
    throw new Error('Popping a tab into its own window is an Engine 1 (extension) action; launched engines have no windows.');
  },
  async update(windowId) {
    return windows.get(windowId);
  },
  onFocusChanged(fn) {
    // Synthetic windows never change focus; the listener is kept for symmetry.
    listeners.focus.add(fn);
  },
};

// ------------------------------------------------------------------ cookies

const SAMESITE_TO_CHROME = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' };
const SAMESITE_TO_CDP = { strict: 'Strict', lax: 'Lax', no_restriction: 'None' };

const stripDot = (domain) => String(domain ?? '').replace(/^\./, '').toLowerCase();

/** CDP Network.Cookie → the chrome.cookies.Cookie shape. */
export function toChromeCookie(c) {
  const session = !!c.session || !(Number(c.expires) > 0);
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    hostOnly: !String(c.domain ?? '').startsWith('.'),
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: SAMESITE_TO_CHROME[c.sameSite] ?? 'unspecified',
    session,
    ...(session ? {} : { expirationDate: Number(c.expires) }),
  };
}

/** RFC 6265 §5.1.3 domain-match, honouring host-only cookies. */
export function domainMatches(host, cookie) {
  const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
  const d = stripDot(cookie.domain);
  if (!h || !d) return false;
  if (cookie.hostOnly) return h === d;
  return h === d || h.endsWith(`.${d}`);
}

/** RFC 6265 §5.1.4 path-match. */
export function pathMatches(requestPath, cookiePath) {
  const req = requestPath || '/';
  const cp = cookiePath || '/';
  if (req === cp) return true;
  if (!req.startsWith(cp)) return false;
  return cp.endsWith('/') || req.charAt(cp.length) === '/';
}

function isSecureUrl(u) {
  if (u.protocol === 'https:' || u.protocol === 'wss:') return true;
  // Chrome treats loopback as potentially trustworthy and sends Secure cookies to it.
  return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.hostname.endsWith('.localhost');
}

/** chrome.cookies.getAll's filter semantics: url, domain, name, path, secure, session. */
export function cookieMatches(cookie, filter = {}) {
  if (filter.name != null && cookie.name !== filter.name) return false;
  if (filter.path != null && cookie.path !== filter.path) return false;
  if (filter.secure != null && cookie.secure !== filter.secure) return false;
  if (filter.session != null && cookie.session !== filter.session) return false;
  if (filter.domain != null) {
    const want = stripDot(filter.domain);
    const have = stripDot(cookie.domain);
    if (!(have === want || have.endsWith(`.${want}`))) return false;
  }
  if (filter.url != null) {
    let u;
    try {
      u = new URL(filter.url);
    } catch {
      return false;
    }
    if (!domainMatches(u.hostname, cookie)) return false;
    if (!pathMatches(u.pathname, cookie.path)) return false;
    if (cookie.secure && !isSecureUrl(u)) return false;
  }
  return true;
}

/** Which engine/context a cookie call is about: the tab's when given, else the focused one's. */
function cookieScope(tabId) {
  if (tabId != null) {
    const tab = requireTabRecord(tabId);
    return { engine: engineOf(tab), browserContextId: tab.browserContextId };
  }
  const focused = focusedTab();
  if (focused) return { engine: engineOf(focused), browserContextId: focused.browserContextId };
  const engine = defaultEngine();
  return { engine, browserContextId: engine.defaultContextId };
}

async function readCookies(engine, browserContextId) {
  const { cookies = [] } = await engine.conn.send('Storage.getCookies', ctxParam(engine, browserContextId));
  return cookies.map(toChromeCookie);
}

function cookieUrl(c) {
  return `${c.secure ? 'https' : 'http'}://${stripDot(c.domain)}${c.path || '/'}`;
}

const cookies = {
  /** `tabId` (not in chrome's filter) scopes the read to that tab's browser context. */
  async getAll(filter = {}) {
    const { engine, browserContextId } = cookieScope(filter.tabId);
    return (await readCookies(engine, browserContextId)).filter((c) => cookieMatches(c, filter));
  },

  /** chrome.cookies.set semantics: host-only unless `domain` is given; path defaults to the url's path. */
  async set(details = {}) {
    const { engine, browserContextId } = cookieScope(details.tabId);
    if (!details.url) throw new Error('cookies.set needs a url.');
    const url = new URL(details.url);
    const param = {
      name: details.name ?? '',
      value: details.value ?? '',
      url: details.url,
      path: details.path ?? url.pathname ?? '/',
      ...(details.domain ? { domain: details.domain } : {}),
      ...(details.secure != null ? { secure: !!details.secure } : {}),
      ...(details.httpOnly != null ? { httpOnly: !!details.httpOnly } : {}),
      ...(SAMESITE_TO_CDP[details.sameSite] ? { sameSite: SAMESITE_TO_CDP[details.sameSite] } : {}),
      ...(details.expirationDate != null ? { expires: Number(details.expirationDate) } : {}),
    };
    await engine.conn.send('Storage.setCookies', { cookies: [param], ...ctxParam(engine, browserContextId) });
    const written = (await readCookies(engine, browserContextId)).filter((c) =>
      c.name === param.name &&
      c.path === param.path &&
      (details.domain ? stripDot(c.domain) === stripDot(details.domain) && !c.hostOnly : c.hostOnly && stripDot(c.domain) === url.hostname.toLowerCase()));
    return written[0] ?? null;
  },

  /** Expire every cookie `getAll({url, name})` would return — the same key, a date in the past. */
  async remove({ url, name, tabId } = {}) {
    const { engine, browserContextId } = cookieScope(tabId);
    const doomed = (await readCookies(engine, browserContextId)).filter((c) => cookieMatches(c, { url, name }));
    if (!doomed.length) return;
    await engine.conn.send('Storage.setCookies', {
      cookies: doomed.map((c) => ({
        name: c.name,
        value: '',
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        ...(SAMESITE_TO_CDP[c.sameSite] ? { sameSite: SAMESITE_TO_CDP[c.sameSite] } : {}),
        ...(c.hostOnly ? { url: cookieUrl(c) } : { domain: c.domain }),
        expires: 1,
      })),
      ...ctxParam(engine, browserContextId),
    });
  },
};

// ------------------------------------------------------------------ storage

/**
 * An in-memory `chrome.storage` area. Values are structured-cloned on the way
 * in and out, as chrome.storage copies them: tool code routinely mutates what
 * it read before writing it back, and an aliased object would make a rolled-back
 * change stick.
 */
export function createMemoryStorageArea() {
  const data = new Map();
  const clone = (value) => (value === undefined ? undefined : structuredClone(value));
  return {
    async get(keys) {
      if (keys == null) return Object.fromEntries([...data].map(([k, v]) => [k, clone(v)]));
      if (typeof keys === 'string') return data.has(keys) ? { [keys]: clone(data.get(keys)) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (data.has(k)) out[k] = clone(data.get(k));
        return out;
      }
      if (typeof keys === 'object') {
        const out = {};
        for (const [k, fallback] of Object.entries(keys)) out[k] = data.has(k) ? clone(data.get(k)) : fallback;
        return out;
      }
      return {};
    },
    async set(items) {
      for (const [k, v] of Object.entries(items ?? {})) {
        if (v === undefined) continue;
        data.set(k, clone(v));
      }
    },
    async remove(keys) {
      for (const k of [].concat(keys ?? [])) data.delete(k);
    },
    async getKeys() {
      return [...data.keys()];
    },
    async clear() {
      data.clear();
    },
  };
}

const storage = {
  session: createMemoryStorageArea(),
  local: createMemoryStorageArea(),
};

// -------------------------------------------------------------------- blobs

/** Default in-memory blob store; the daemon injects a file-backed one. */
export function createMemoryBlobStore() {
  const stores = new Map();
  const storeOf = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    async put(name, record) {
      storeOf(name).set(record.id, { ...record });
    },
    async get(name, id) {
      const row = storeOf(name).get(id);
      return row ? { ...row } : null;
    },
    async delete(name, id) {
      storeOf(name).delete(id);
    },
    async byIndex(name, field, value) {
      return [...storeOf(name).values()].filter((r) => r[field] === value).map((r) => ({ ...r }));
    },
    async deleteByIndex(name, field, value) {
      let removed = 0;
      for (const [id, row] of storeOf(name)) {
        if (row[field] !== value) continue;
        storeOf(name).delete(id);
        removed += 1;
      }
      return removed;
    },
    async stats(name) {
      let count = 0;
      let bytes = 0;
      for (const row of storeOf(name).values()) {
        count += 1;
        bytes += row.size || 0;
      }
      return { count, bytes };
    },
  };
}

const blobStore = { current: createMemoryBlobStore() };

/** Delegates, so a later configure({blobs}) takes effect for callers already holding `platform.blobs`. */
const blobs = {
  put: (...a) => blobStore.current.put(...a),
  get: (...a) => blobStore.current.get(...a),
  delete: (...a) => blobStore.current.delete(...a),
  byIndex: (...a) => blobStore.current.byIndex(...a),
  deleteByIndex: (...a) => blobStore.current.deleteByIndex(...a),
  stats: (...a) => (typeof blobStore.current.stats === 'function' ? blobStore.current.stats(...a) : Promise.resolve(null)),
};

// -------------------------------------------------------------------- image

function base64ToBytes(dataBase64) {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

async function ensureImagePage(engine) {
  if (engine.image.sessionId) return engine.image.sessionId;
  if (!engine.image.ready) {
    engine.image.ready = (async () => {
      const { conn } = engine;
      if (!engine.imageContextId) {
        const { browserContextId } = await conn.send('Target.createBrowserContext', { disposeOnDetach: true });
        engine.imageContextId = browserContextId;
        engine.ownsImageContext = true;
      }
      if (!engine.image.targetId) {
        let created;
        try {
          // `hidden` keeps it out of any tab strip on a headed engine (Chrome 129+).
          created = await conn.send('Target.createTarget', {
            url: 'about:blank', browserContextId: engine.imageContextId, hidden: true, background: true,
          });
        } catch {
          created = await conn.send('Target.createTarget', {
            url: 'about:blank', browserContextId: engine.imageContextId, background: true,
          });
        }
        engine.image.targetId = created.targetId;
      }
      if (!(await waitForSession(engine, engine.image.targetId, 1_500)) && !engine.image.sessionId) {
        const sessionId = await attachTarget(engine, engine.image.targetId);
        if (!engine.image.sessionId) {
          engine.image.sessionId = sessionId;
          engine.sessions.set(sessionId, { kind: 'image', targetId: engine.image.targetId });
        }
      }
      engine.image.error = null;
      return engine.image.sessionId;
    })().finally(() => {
      engine.image.ready = null;
    });
  }
  return engine.image.ready;
}

/**
 * Run a function in the engine's utility page and return its value.
 *
 * One rebuild on a transport-level failure (the page was closed, crashed, or
 * its context was replaced): it is a page like any other and can go away. An
 * exception thrown BY the function is a real answer and is never retried.
 */
async function callInImagePage({ functionDeclaration, args = [] }) {
  const engine = defaultEngine();
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const sessionId = await ensureImagePage(engine);
    let res;
    try {
      if (!engine.image.globalObjectId) {
        const { result } = await engine.conn.send('Runtime.evaluate', { expression: 'globalThis', returnByValue: false }, sessionId);
        engine.image.globalObjectId = result?.objectId ?? null;
      }
      res = await engine.conn.send('Runtime.callFunctionOn', {
        objectId: engine.image.globalObjectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        awaitPromise: true,
        returnByValue: true,
      }, sessionId, { timeoutMs: 45_000 });
    } catch (err) {
      lastError = err;
      engine.image.globalObjectId = null;
      if (/session|target/i.test(String(err?.message ?? err))) engine.image.sessionId = null;
      continue;
    }
    if (res?.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`Image processing failed in the browser: ${d.exception?.description ?? d.text ?? 'script threw'}`);
    }
    return res?.result?.value;
  }
  throw new Error(`The image utility page could not be reached: ${lastError?.message ?? lastError}`);
}

const image = {
  async decode(dataBase64, mime = 'image/png', opts = {}) {
    const out = await callInImagePage({
      functionDeclaration: `async function (b64, mime, opts) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
        const sw = bitmap.width, sh = bitmap.height;
        let w = sw, h = sh;
        if (opts.width && opts.height) { w = Math.round(opts.width); h = Math.round(opts.height); }
        else if (opts.fit) {
          const s = Math.min(1, opts.fit / sw, opts.fit / sh);
          w = Math.max(1, Math.round(sw * s)); h = Math.max(1, Math.round(sh * s));
        }
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0, w, h);
        if (bitmap.close) bitmap.close();
        const data = ctx.getImageData(0, 0, w, h).data;
        let s = '';
        for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
        return { width: w, height: h, sourceWidth: sw, sourceHeight: sh, rgba: btoa(s) };
      }`,
      args: [dataBase64, mime, { fit: opts.fit ?? null, width: opts.width ?? null, height: opts.height ?? null }],
    });
    return {
      width: out.width,
      height: out.height,
      rgba: new Uint8ClampedArray(base64ToBytes(out.rgba).buffer),
      sourceWidth: out.sourceWidth,
      sourceHeight: out.sourceHeight,
    };
  },

  async encodePng({ width, height, rgba }) {
    const bytes = rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray
      ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)
      : new Uint8Array(rgba);
    return callInImagePage({
      functionDeclaration: `async function (w, h, b64) {
        const bin = atob(b64);
        const px = new Uint8ClampedArray(bin.length);
        for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
        const canvas = new OffscreenCanvas(w, h);
        canvas.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const out = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
        return btoa(s);
      }`,
      args: [width, height, bytesToBase64(bytes)],
    });
  },
};

// ------------------------------------------------------------------ runtime

const runtime = {
  version: () => config.version ?? 'unknown',
  getURL: () => null,
  reload: () => {},
  broadcast(message) {
    try {
      config.onBroadcast?.(message);
    } catch {
      /* a UI hook must never break a tool call */
    }
  },
};

// ----------------------------------------------------------------- settings

function contextSettings(tabId) {
  const tab = tabsById.get(tabId);
  if (!tab) return null;
  return engines.get(tab.engineId)?.contexts.get(tab.browserContextId) ?? null;
}

const settings = {
  humanizeFor: (tabId) => contextSettings(tabId)?.humanize ?? config.defaults.humanize ?? 'human',
  stealthFor: (tabId) => contextSettings(tabId)?.stealth ?? config.defaults.stealth ?? 'off',
  /** Engine 2 levels come from the context; the extension's panel setting has no meaning here. */
  noteInputMode() {},
};

// ---------------------------------------------------------------- downloads

function joinPath(dir, name) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

function folderFor(engine, browserContextId, explicit) {
  if (explicit) return explicit;
  const registered = engine.contexts.get(browserContextId)?.downloadPath;
  if (registered) return registered;
  const known = engine.downloads.paths.get(ctxKey(browserContextId));
  if (known) return known;
  if (typeof config.downloadPath === 'function') return config.downloadPath(engine.engineId, browserContextId) ?? null;
  return config.downloadPath ?? null;
}

function watchersOf(engine) {
  const all = [];
  for (const set of engine.downloads.watchers.values()) all.push(...set);
  return all;
}

const DOWNLOAD_STATE = { inProgress: 'in_progress', completed: 'complete', canceled: 'canceled' };

/**
 * `frameId` is the frame that started the download. For a page target that id
 * IS the page's target id, so the attribution is exact; a subframe is exact
 * too when its frame was seen on that page's session. A download started by a
 * tab that a WATCHED tab opened (`target=_blank`, `window.open`) belongs to the
 * opener — the opener link is the browser's own fact, so it stays exact, and
 * `viaTabId` names the tab it actually came from. Anything else is reported as
 * unknown, never guessed — except the one honest inference, a single watched
 * tab, which is labelled 'probable'.
 */
function onDownloadWillBegin(engine, params) {
  const origin = engine.pageTabs.get(params.frameId) ?? engine.frames.get(params.frameId) ?? null;
  const watching = [...new Set(watchersOf(engine))];
  let tabId = origin;
  let attribution = origin != null ? 'exact' : 'unknown';
  let viaTabId = null;
  if (origin != null && watching.length && !watching.includes(origin)) {
    const opener = tabsById.get(origin)?.openerTabId ?? null;
    if (opener != null && watching.includes(opener)) {
      tabId = opener;
      viaTabId = origin;
    }
  }
  if (tabId == null && watching.length === 1) {
    tabId = watching[0];
    attribution = 'probable';
  }
  // The folder is the one of the context the file is saved in: the tab that
  // started it, which is not necessarily the one it is attributed to.
  const saver = origin != null ? tabsById.get(origin) : tabId != null ? tabsById.get(tabId) : null;
  const folder = saver
    ? engine.downloads.paths.get(ctxKey(saver.browserContextId)) ?? folderFor(engine, saver.browserContextId)
    : engine.downloads.paths.size === 1 ? [...engine.downloads.paths.values()][0] : null;
  const evt = {
    id: params.guid,
    tabId,
    url: params.url,
    filename: params.suggestedFilename ?? null,
    // allowAndName saves every file under its GUID — which is what keeps a
    // repeated run from being renamed to "report (3).xlsx".
    path: folder ? joinPath(folder, params.guid) : null,
    state: 'in_progress',
    receivedBytes: 0,
    totalBytes: 0,
    startedAt: Date.now(),
    attribution,
    ...(viaTabId != null ? { viaTabId } : {}),
  };
  engine.downloads.byGuid.set(params.guid, evt);
  emit(listeners.download, { ...evt });
}

function onDownloadProgress(engine, params) {
  const evt = engine.downloads.byGuid.get(params.guid);
  if (!evt) return;
  evt.receivedBytes = params.receivedBytes ?? evt.receivedBytes;
  evt.totalBytes = params.totalBytes || evt.totalBytes;
  evt.state = DOWNLOAD_STATE[params.state] ?? evt.state;
  if (params.filePath) evt.path = params.filePath;
  if (evt.state !== 'in_progress') {
    evt.endedAt = Date.now();
    engine.downloads.byGuid.delete(params.guid);
  }
  emit(listeners.download, { ...evt });
}

const downloads = {
  available: true,

  /**
   * `Browser.setDownloadBehavior` lives on the BROWSER session — a page session
   * cannot reach the Browser domain, which is exactly why v1's version of this
   * failed inside the extension. It is per browser context, so several tabs of
   * one context share one call.
   */
  async begin(tabId, { downloadPath } = {}) {
    const tab = requireTabRecord(tabId);
    const engine = engineOf(tab);
    const folder = folderFor(engine, tab.browserContextId, downloadPath);
    if (!folder) {
      throw new Error(
        'No download folder is configured for this browser context. The daemon sets one per context ' +
          '(G9_HOME/downloads/<contextId>); pass downloadPath explicitly otherwise.',
      );
    }
    await engine.conn.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: folder,
      eventsEnabled: true,
      ...ctxParam(engine, tab.browserContextId),
    });
    const key = ctxKey(tab.browserContextId);
    engine.downloads.paths.set(key, folder);
    if (!engine.downloads.watchers.has(key)) engine.downloads.watchers.set(key, new Set());
    engine.downloads.watchers.get(key).add(tabId);
    return { mode: 'cdp', downloadPath: folder };
  },

  /**
   * Stops attributing to this tab. The context's download behaviour is left as
   * it is: the daemon configures every context when it creates it
   * (configureContextDownloads: G9's folder, events on), and resetting it to
   * 'default' here would send later downloads back to the profile's own folder.
   */
  async end(tabId) {
    const tab = tabsById.get(tabId);
    const engine = tab ? engines.get(tab.engineId) : null;
    if (!engine) return;
    engine.downloads.watchers.get(ctxKey(tab.browserContextId))?.delete(tabId);
  },

  onEvent(fn) {
    listeners.download.add(fn);
    return () => listeners.download.delete(fn);
  },

  /**
   * File facts from disk, through the daemon's hook. Null when there is no hook
   * or no path — never a guess. A hook that FAILS rejects: "could not check"
   * and "nothing to check with" are different answers, and downloads.js says which.
   */
  async inspect(evt) {
    if (typeof config.fileInfo !== 'function' || !evt?.path) return null;
    const facts = await config.fileInfo(evt.path);
    return facts ? { ...facts, source: 'disk' } : null;
  },
};

// ------------------------------------------------------------------ export

export const platform = {
  name: 'cdp',
  debugger: debuggerApi,
  tabs,
  windows,
  cookies,
  // Getters, so configure() can swap the areas after tool modules captured `platform`.
  storage: {
    get session() {
      return storage.session;
    },
    get local() {
      return storage.local;
    },
  },
  blobs,
  image,
  runtime,
  settings,
  downloads,
};
