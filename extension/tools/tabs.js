/**
 * Tab discovery, selection, and the target-resolution rule.
 *
 * ## v2: no modes (decision D6)
 *
 * v1 made target resolution a safety boundary: Pinned, Follow, Workspace and
 * Multi decided which tabs an agent could reach, titles and URLs were withheld,
 * and cookies were scoped to the attached origin. The owner removed all of it —
 * the deployment is local and trusted (D7), and attaching a tab now gives full
 * access. What remains is the part that was never about permission: a call
 * must act on the tab the person MEANT, and must refuse rather than guess when
 * there is none.
 *
 * `resolveTarget(explicitTabId, sessionName)`, in order (ARCHITECTURE §4.1):
 *   1. an explicit `tabId` — it must exist and be attachable;
 *   2. a named session;
 *   3. `state.currentTabId`, if that tab still exists — set by the panel's
 *      Attach, `browser_tabs attach`, and `open`/`session` with focus or when
 *      nothing is current;
 *   4. the active tab of the last ordinary window the user was in;
 *   5. otherwise a clear error.
 *
 * Nothing here touches `chrome.*`: this module runs in the extension and, for
 * launched engines, inside the daemon (rule R2).
 */

import { platform } from '../lib/platform.js';
import { getState, setState, updateState } from '../lib/state.js';
import { attach, attachedTabIds, detach, detachMany } from '../lib/cdp.js';
import { clearRefs } from '../lib/refs.js';
import { inWorld } from '../lib/world.js';
import { clearBuffers } from './observe.js';

/**
 * Pages the debugger can never attach to. Detected early for a clear message.
 *
 * `about:blank` is the exception: a fresh tab or a popup starts there, it
 * inherits its opener's origin, and the debugger attaches to it like any page.
 */
const BLOCKED = /^(chrome|edge|devtools|chrome-extension|edge-extension|extension|moz-extension|view-source|chrome-search|chrome-untrusted|brave|opera|vivaldi):/i;
const BLOCKED_HOSTS = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com)/i;

export function isAttachable(url = '') {
  const u = String(url ?? '');
  if (/^about:/i.test(u)) return /^about:blank([?#]|$)/i.test(u);
  return !BLOCKED.test(u) && !BLOCKED_HOSTS.test(u);
}

/** Where the last focused ORDINARY browser window is remembered. */
const LAST_NORMAL_WINDOW = 'g9:lastNormalWindow';

const session = () => platform.storage.session;

/**
 * Remember which real browser window the user was last in.
 *
 * Called from the service worker's `windows.onFocusChanged`. It has to be
 * persisted rather than held in a variable: the worker is evicted between
 * events, and a target that survives only as long as the worker is not a target.
 */
export async function rememberFocus(windowId) {
  if (windowId == null || windowId === platform.windows.WINDOW_ID_NONE) return;
  const win = await platform.windows.get(windowId).catch(() => null);
  if (win?.type !== 'normal') return;
  await session().set({ [LAST_NORMAL_WINDOW]: windowId });
}

async function rememberedWindow() {
  const stored = await session().get(LAST_NORMAL_WINDOW).catch(() => ({}));
  return stored?.[LAST_NORMAL_WINDOW] ?? null;
}

/**
 * The tab the user is actually looking at.
 *
 * `lastFocusedWindow: true` means whatever window the OS focused last, and that
 * includes windows which are not a page under test at all: the popped-out panel,
 * devtools, an extension popup. So the moment somebody clicks the agent's OWN
 * interface, the agent loses sight of the tab it was driving — and that is
 * precisely the moment they are about to ask it to do something.
 *
 * Reported from real use: with the panel popped out into its own window, every
 * tool call came back "9 workspace tabs are open and none is focused". Nine tabs
 * were open, one was plainly focused, and the agent could not see it.
 *
 * So a window that is not `type: "normal"` never counts as the user's place.
 * We fall back, in order, to: the last ordinary window they were in, the focused
 * ordinary window, and the only ordinary window if there is just one. Chrome
 * gives no ordering for `windows.getAll`, which is why the first of those is
 * remembered as it happens rather than reconstructed afterwards.
 */
export async function getActiveTab() {
  const [tab] = await platform.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && isAttachable(tab.url ?? '')) return tab;

  const remembered = await rememberedWindow();
  if (remembered != null) {
    const [inRemembered] = await platform.tabs.query({ active: true, windowId: remembered }).catch(() => []);
    if (inRemembered) return inRemembered;
  }

  const windows = (await platform.windows.getAll({ populate: true }).catch(() => []))
    .filter((w) => w.type === 'normal');
  const pick = windows.find((w) => w.focused) ?? (windows.length === 1 ? windows[0] : null);
  return pick?.tabs?.find((t) => t.active) ?? tab ?? null;
}

/**
 * Resolve which tab a tool call should act on. See the header for the order.
 *
 * It refuses rather than guesses. The one thing worse than an error here is a
 * click delivered to a tab the person was not thinking about.
 */
export async function resolveTarget(explicitTabId, sessionName = null) {
  const state = await getState();

  if (state.halted) {
    throw new Error('The user pressed Stop. No browser actions will run until they press Resume.');
  }

  if (explicitTabId != null) return requireTab(explicitTabId, state);
  if (sessionName) return resolveSession(state, sessionName);
  return currentOrActive(state, { strict: true });
}

/**
 * Steps 3–4 of resolution. `strict: false` is the read-only form used by
 * status and listings: it reports the would-be target, or null, and never throws.
 */
async function currentOrActive(state, { strict }) {
  if (state.currentTabId != null) {
    const current = await platform.tabs.get(state.currentTabId).catch(() => null);
    if (current) {
      if (isAttachable(current.url)) return current;
      // The attached tab navigated to a browser page. Falling through to
      // "whatever is active" would silently move the agent to another tab.
      if (!strict) return null;
      throw new Error(
        `The current tab (${state.currentTabId}) is on ${internalName(current.url)}, a browser-internal page ` +
          `that cannot be controlled. Navigate it back to a web page, or attach another tab.`,
      );
    }
    // Closed. Forget it, then fall through to the active tab.
    if (strict) await setState({ currentTabId: null }).catch(() => {});
  }

  const active = await getActiveTab().catch(() => null);
  if (active && isAttachable(active.url)) return active;
  if (!strict) return null;
  if (active) {
    throw new Error(
      `The active tab is ${internalName(active.url)}, a browser-internal page that cannot be controlled. ` +
        `Switch to a web page, open one with browser_tabs action:"open", or attach one.`,
    );
  }
  throw new Error('No tab to act on. Open one with browser_tabs action:"open", or attach one.');
}

/** The tab a call without tabId/session would act on right now, or null. Never throws. */
export async function peekTarget(state = null) {
  const s = state ?? (await getState());
  return currentOrActive(s, { strict: false }).catch(() => null);
}

/** Look up a named session. */
async function resolveSession(state, name) {
  const tabId = state.sessions?.[name];
  if (tabId == null) {
    const known = Object.keys(state.sessions ?? {});
    throw new Error(
      `No session named "${name}". ` +
        (known.length
          ? `Open sessions: ${known.join(', ')}.`
          : `No sessions are open. Create one with browser_tabs action:"session" name:"…" url:"…".`),
    );
  }
  try {
    return await requireTab(tabId, state);
  } catch (err) {
    if (/no longer exists/.test(err.message)) await closeSession(name).catch(() => {});
    throw new Error(`Session "${name}" points at tab ${tabId}: ${err.message}`);
  }
}

async function requireTab(tabId, state = null) {
  let tab;
  try {
    tab = await platform.tabs.get(tabId);
  } catch {
    const s = state ?? (await getState().catch(() => null));
    if (s?.currentTabId === tabId) await setState({ currentTabId: null }).catch(() => {});
    throw new Error(`Tab ${tabId} no longer exists — it was probably closed. Call browser_tabs action:"list".`);
  }
  if (!isAttachable(tab.url)) {
    throw new Error(`Tab ${tabId} is on ${internalName(tab.url)}, a browser-internal page that cannot be controlled.`);
  }
  return tab;
}

// ------------------------------------------------------------------ sessions

async function makeCurrentIf(tabId, condition) {
  const state = await getState();
  const currentAlive = state.currentTabId != null &&
    !!(await platform.tabs.get(state.currentTabId).catch(() => null));
  if (condition || !currentAlive) {
    await setState({ currentTabId: tabId });
    return true;
  }
  return false;
}

/**
 * Open (or re-point) a named session.
 *
 * Reuses an existing tab on the same name rather than piling up duplicates: a
 * flow that runs twice should not leave two "buyer" tabs behind, and the second
 * run would otherwise start on a page the first one already navigated.
 */
export async function openSession(name, url, { active = false } = {}) {
  if (!name || typeof name !== 'string') throw new Error('A session needs a name.');

  const state = await getState();
  const existing = state.sessions?.[name];
  let tab = null;

  if (existing != null) {
    tab = await platform.tabs.get(existing).catch(() => null);
  }
  if (tab && url) {
    await platform.tabs.update(tab.id, { url, ...(active ? { active: true } : {}) });
    tab = await platform.tabs.get(tab.id);
  } else if (!tab) {
    tab = await platform.tabs.create({ url, active });
  }

  await attach(tab.id);
  await updateState((s) => ({ sessions: { ...(s.sessions ?? {}), [name]: tab.id } }));
  const current = await makeCurrentIf(tab.id, active);
  return { session: name, tabId: tab.id, url: tab.url || url, current };
}

/** Name a tab that is already open, without navigating it. */
export async function nameSession(name, tabId) {
  if (!name) throw new Error('A session needs a name.');
  const tab = await requireTab(tabId);
  await attach(tab.id);
  await updateState((s) => ({ sessions: { ...(s.sessions ?? {}), [name]: tab.id } }));
  return { session: name, tabId: tab.id, url: tab.url };
}

/**
 * Forget a session. Detaches, but never closes the tab.
 *
 * Closing would be the tidier-looking choice and the wrong one: the user may be
 * looking at that page, and a tool that closes tabs as a side effect of
 * bookkeeping is a tool people stop trusting with tabs.
 */
export async function closeSession(name) {
  let tabId = null;
  let rest = {};
  const state = await updateState((s) => {
    tabId = s.sessions?.[name] ?? null;
    rest = { ...(s.sessions ?? {}) };
    delete rest[name];
    return { sessions: rest };
  });
  if (tabId != null) {
    // Only let go of the debugger when nothing else still addresses the tab.
    const stillNamed = Object.values(rest).includes(tabId);
    if (!stillNamed && tabId !== state.currentTabId) await detach(tabId).catch(() => {});
    await clearRefs(tabId).catch(() => {});
  }
  return { session: name, closed: tabId != null };
}

/** Every open session, with the live state of the tab behind it. */
export async function listSessions() {
  const state = await getState();
  const out = [];
  for (const [name, tabId] of Object.entries(state.sessions ?? {})) {
    const tab = await platform.tabs.get(tabId).catch(() => null);
    out.push({
      session: name,
      tabId,
      alive: !!tab,
      active: tab?.active ?? false,
      current: tabId === state.currentTabId,
      ...(tab ? { title: tab.title, url: tab.url } : {}),
    });
  }
  return out;
}

// ------------------------------------------------------------------- attach

/**
 * Attach a tab and make it the current one.
 *
 * `clearHalt` is the difference between the user pressing Attach in the side
 * panel and an agent calling browser_tabs. A Stop is a user decision and only a
 * user gesture lifts it: an agent that could un-halt itself with one attach
 * call would make the Stop button self-defeating (the v1 pin bug).
 *
 * `log: false` leaves the activity line to the caller (sw.js recordNow: one gesture, one line).
 */
export async function attachTab(tabId = null, { clearHalt = false, log = true } = {}) {
  const tab = tabId != null ? await platform.tabs.get(tabId).catch(() => null) : await getActiveTab();
  if (!tab) {
    throw new Error(tabId != null ? `Tab ${tabId} does not exist.` : 'No active tab to attach.');
  }
  if (!isAttachable(tab.url)) {
    // Say whose rule this is, and what to do instead.
    //
    // Hit for real: reloading the extension leaves you ON edge://extensions, so
    // the very next thing anybody does is press Attach on that page. The old
    // message named the page and stopped, which reads like the tool refusing —
    // and the two facts that actually help are that the BROWSER forbids this,
    // and that switching tabs is the whole fix.
    throw new Error(
      `Cannot attach to ${internalName(tab.url)} — the browser itself does not let any debugger attach to ` +
        `its internal pages (edge://, chrome://, about: other than about:blank, devtools:, view-source:) or to ` +
        `the extension gallery. This is not a setting.\n\nSwitch to the page you want to test and attach again.`,
    );
  }
  await attach(tab.id, { log });
  const wasHalted = (await getState()).halted;
  await setState({ currentTabId: tab.id, ...(clearHalt ? { halted: false } : {}) });
  return {
    tabId: tab.id,
    title: tab.title,
    url: tab.url,
    ...(clearHalt && wasHalted ? { resumed: true } : {}),
  };
}

/**
 * Stop debugging — every tab we hold.
 *
 * `attachedTabs` accumulates: `send()` attaches whatever tab it is given, so
 * over a session the agent picks up each tab it touches. Detaching only the
 * current one left those attached, and the "browser is being debugged" banner
 * is per attached tab — so pressing Detach could leave banners up on tabs the
 * panel no longer mentioned.
 *
 * Returns what actually happened per tab, so the panel can say "still attached"
 * rather than claiming a clean detach it did not verify.
 */
export async function detachAllTabs() {
  const state = await getState();
  const held = [...new Set(state.attachedTabs)];
  if (state.currentTabId != null && !held.includes(state.currentTabId)) held.push(state.currentTabId);

  // Release first, then tidy. The user is watching the debugger banner; the
  // buffer and ref cleanup behind it can happen at whatever speed it likes.
  const results = await detachMany(held);
  // A tab this extension debugs but lost from attachedTabs (a record kept by an older build, a
  // race) is released too — detach only succeeds on OUR sessions, so a tab that DevTools, another
  // extension or another G9 install debugs fails here and is left out, silently: never reported
  // as "still attached" by us, never detached from them.
  if (platform.name === 'extension') {
    const extras = (await attachedTabIds().catch(() => [])).filter((id) => !held.includes(id));
    for (const id of extras) {
      try {
        await platform.debugger.detach(id);
        results.push({ tabId: id, detached: true, stillAttached: false, error: null, recovered: true });
        held.push(id);
      } catch { /* not ours */ }
    }
  }
  // Sessions go with the detach. A named session whose tab is no longer being
  // debugged is a name that resolves to a dead handle — and the next call would
  // silently re-attach a tab the user just asked us to let go of.
  await setState({ currentTabId: null, sessions: {} });

  await Promise.all(
    held.flatMap((id) => [clearRefs(id).catch(() => {}), clearBuffers(id).catch(() => {})]),
  );

  return results;
}

// ------------------------------------------------------------------ listing

/**
 * Every tab, in full. v1 redacted titles and URLs outside Multi mode; v2 has
 * no modes, and the listing is the same for everyone. Tab identity is always
 * the key `tabId`, never `id` — the daemon rewrites that key between Chrome tab
 * ids and daemon handles, and a second spelling would slip past it.
 */
export async function listTabs() {
  const [tabs, state, windows, debugged] = await Promise.all([
    platform.tabs.query({}),
    getState(),
    platform.windows.getAll({}).catch(() => []),
    attachedTabIds().catch(() => []),
  ]);
  const windowState = new Map(windows.map((w) => [w.id, w.state ?? 'normal']));
  const truth = new Set(debugged);
  const sessionByTab = new Map(Object.entries(state.sessions ?? {}).map(([n, id]) => [id, n]));

  return tabs.map((t) => ({
    tabId: t.id,
    title: t.title ?? '',
    url: t.url || t.pendingUrl || '',
    active: !!t.active,
    windowId: t.windowId ?? null,
    windowState: windowState.get(t.windowId) ?? null,
    current: t.id === state.currentTabId,
    // Held by G9 AND confirmed by the browser. Either alone can drift.
    attached: platform.name === 'extension' ? state.attachedTabs.includes(t.id) && truth.has(t.id) : truth.has(t.id),
    attachable: isAttachable(t.url || t.pendingUrl || ''),
    status: t.status ?? null,
    openerTabId: t.openerTabId ?? null,
    ...(sessionByTab.has(t.id) ? { session: sessionByTab.get(t.id) } : {}),
  }));
}

/**
 * The state of the tab's REAL browser window: 'normal' | 'minimized' | 'maximized' | 'fullscreen',
 * or null when it cannot be read. One helper for browser_status and for a stalled capture's
 * explanation, which used to disagree: platform-cdp's windows are synthetic and never minimized, so
 * a screenshot that stalled 46 s on a minimized launched window was explained as "a compositor
 * stall … visible, its tab in front" while browser_status correctly said "minimized" (P8 matrix,
 * round 3, 2/3). Launched engines: Browser.getWindowForTarget (the browser's own window); the
 * extension: chrome.windows.
 */
export async function realWindowState(tabId) {
  if (platform.name !== 'extension') {
    const win = await platform.debugger.sendCommand(tabId, 'Browser.getWindowForTarget', {}, null, { timeoutMs: 3000 }).catch(() => null);
    return win?.bounds?.windowState ?? null;
  }
  const tab = await platform.tabs.get(tabId).catch(() => null);
  if (tab?.windowId == null) return null;
  const win = await platform.windows.get(tab.windowId).catch(() => null);
  return win?.state ?? null;
}

export async function openTab(url, { active = false } = {}) {
  const tab = await platform.tabs.create({ url, active });
  const current = await makeCurrentIf(tab.id, active);
  return { tabId: tab.id, url: tab.url || tab.pendingUrl || url, current };
}

/** Close a tab. Its refs, buffers and session names are cleaned up by events.onTabRemoved. */
export async function closeTab(tabId) {
  await platform.tabs.get(tabId).catch(() => {
    throw new Error(`Tab ${tabId} does not exist.`);
  });
  await platform.tabs.remove(tabId);
  const state = await getState();
  if (state.currentTabId === tabId) await setState({ currentTabId: null });
  return { closed: tabId };
}

export async function focusTab(tabId) {
  await platform.tabs.update(tabId, { active: true });
  const tab = await platform.tabs.get(tabId);
  if (tab.windowId != null) await platform.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return tab;
}

/** Wait for a popup/window/tab matching observable browser metadata. */
export async function waitForTab({ url, title, openerTabId, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 15_000);
  while (Date.now() < deadline) {
    const tabs = await platform.tabs.query({});
    const match = tabs.find((tab) =>
      (url == null || String(tab.url || tab.pendingUrl || '').includes(url)) &&
      (title == null || String(tab.title ?? '').includes(title)) &&
      (openerTabId == null || tab.openerTabId === openerTabId)
    );
    if (match) {
      return { tabId: match.id, url: match.url || match.pendingUrl || '', title: match.title, openerTabId: match.openerTabId ?? null };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for a tab' +
    (url ? ' with URL containing "' + url + '"' : '') +
    (title ? ' titled "' + title + '"' : '') +
    (openerTabId != null ? ' opened by tab ' + openerTabId : '') + '.');
}

// ------------------------------------------------------------------- popout

/**
 * Move a tab into its own window without reloading it, and give focus back.
 *
 * `windows.create({tabId})` MOVES the tab — the renderer, the page state and
 * the debugger session all survive — which is what makes this safe mid-flow.
 * The point is visibility: a tab that is not the active one in its window is
 * hidden, and Chromium stops rendering it and silently drops CDP input
 * (plan §2.1). In its own window it stays the active tab, and with the
 * WindowOcclusionEnabled policy off it keeps rendering even when covered.
 * The one rule left is the one Chromium enforces for any window: do not
 * minimize it.
 */
export async function popout(tabId = null, { width, height, left, top, focus = false } = {}) {
  const tab = tabId != null ? await requireTab(tabId) : await resolveTarget(null, null);
  const userWindowId = (await rememberedWindow()) ?? tab.windowId ?? null;
  const source = tab.windowId != null ? await platform.windows.get(tab.windowId).catch(() => null) : null;

  const win = await createPopoutWindow(tab.id, !!focus, source, { width, height, left, top });

  // Two callers, two rules.
  //
  // The PERSON pressing Pop out in the panel wants to see the window: `focus` is true and nothing
  // is handed back. The first version always created the window unfocused, the size of the
  // person's (usually maximised) window, 40 px lower, and then raised the person's window again —
  // so the new window landed entirely BEHIND it. Reported from real use: "the tab disappears and
  // no window opens". Worse than confusing: a window that is completely covered is OCCLUDED on
  // Windows, and Chromium stops rendering it unless the WindowOcclusionEnabled policy is off, which
  // is the opposite of what popping out is for.
  //
  // An AGENT popping a tab out must not take the person's keyboard, so its window is created
  // unfocused. Focus is handed back only if the browser moved it anyway: raising the person's
  // window unconditionally is exactly what buried the popout.
  if (!focus && userWindowId != null && userWindowId !== win.id) {
    const userWindow = await platform.windows.get(userWindowId).catch(() => null);
    if (userWindow && !userWindow.focused) {
      await platform.windows.update(userWindowId, { focused: true }).catch(() => {});
    }
  }

  const moved = await settleAfterMove(tab.id, tab.title ?? '');

  // Say what the page itself reports, rather than what the window was asked to be. Occlusion is
  // computed a moment after the window settles, so give it that moment before asking.
  await new Promise((resolve) => setTimeout(resolve, POPOUT_VISIBILITY_SETTLE_MS));
  const visibility = await inWorld(tab.id, 'document.visibilityState', { timeoutMs: 1500 }).catch(() => null);
  const visible = visibility === 'visible' ? true : visibility === 'hidden' ? false : null;

  return {
    tabId: tab.id,
    windowId: win.id,
    focused: !!focus,
    visible,
    ...(moved?.title != null ? { title: moved.title } : {}),
    note: visible === false
      ? 'The tab moved into its own window without reloading, but that window is NOT visible right now ' +
        '(the page reports visibilityState "hidden"): it is covered or minimised, so Chromium is not ' +
        'rendering it and G9 refuses input to it. Bring it to the front (browser_tabs action:"focus"), ' +
        'or turn the WindowOcclusionEnabled policy off so a covered window keeps rendering (docs/INSTALL.md).'
      : 'The tab moved into its own window without reloading. It keeps rendering while that window is on ' +
        'screen. Never minimise it: a minimised window is hidden and Chromium delivers no input to it. A ' +
        'window that another window covers COMPLETELY also stops rendering on Windows, unless the ' +
        'WindowOcclusionEnabled policy is off (docs/INSTALL.md).',
  };
}

/**
 * Create the popped-out window, falling back when the browser refuses the placement.
 *
 * Chromium rejects bounds that are not "at least 50% within visible screen space", and the
 * extension cannot see the screen (that needs the system.display permission). A window larger
 * than its screen — measured in the isolated live test, where headless Edge runs a big window on
 * a small virtual screen — puts the top-right placement off-screen and the create fails outright,
 * leaving the tab where it was. So: the preferred placement, then the same size at the source
 * window's top-left corner, then the browser's own choice of size and place. Explicit geometry
 * from the caller is tried as given and surfaces its own error rather than being second-guessed.
 */
async function createPopoutWindow(tabId, focused, source, requested) {
  const base = { tabId, focused, state: 'normal' };
  const preferred = popoutGeometry(source, requested);
  const size = { width: preferred.width, height: preferred.height };
  // Only an explicit POSITION is the caller's to keep; a size alone still lets G9 find a place
  // the browser accepts (the live test asks for 900x700 and no position).
  const placedByCaller = requested.left != null || requested.top != null;
  const attempts = placedByCaller
    ? [preferred]
    : [
        preferred,
        { ...size, left: Math.round((source?.left ?? 0) + 40), top: Math.round((source?.top ?? 0) + 40) },
        size,
        {},
      ];
  let lastError = null;
  for (const geometry of attempts) {
    try {
      return await platform.windows.create({ ...base, ...geometry });
    } catch (err) {
      lastError = err;
      if (!/bounds|screen/i.test(String(err?.message ?? err))) throw err;
    }
  }
  throw lastError;
}

/** How long popout() lets Windows' occlusion tracker look at the new window before asking the page. */
const POPOUT_VISIBILITY_SETTLE_MS = 600;

/**
 * Where a popped-out window goes when the caller did not say.
 *
 * Half the width and three quarters of the height of the window the tab came from, placed at its
 * top-right, so it is visibly a separate window and does not sit exactly over the person's own.
 * Explicit width/height/left/top always win.
 */
export function popoutGeometry(source, { width, height, left, top } = {}) {
  const sw = Number.isFinite(source?.width) ? source.width : 1280;
  const sh = Number.isFinite(source?.height) ? source.height : 900;
  const sl = Number.isFinite(source?.left) ? source.left : 0;
  const st = Number.isFinite(source?.top) ? source.top : 0;
  const w = Math.round(width ?? Math.min(1280, Math.max(640, sw * 0.5)));
  const h = Math.round(height ?? Math.min(1000, Math.max(480, sh * 0.75)));
  return {
    width: w,
    height: h,
    left: Math.round(left ?? (sl + Math.max(0, sw - w - 24))),
    top: Math.round(top ?? (st + 72)),
  };
}

/**
 * Wait (bounded, POPOUT_SETTLE_MS) until a tab that just moved into another window is itself
 * again: the browser reports it complete with its title, and its renderer answers. On Chrome for
 * Testing (1 in 11 popouts, live round 3) the tab was listed with an empty title right after the
 * move and the first snapshot had no page in it — the agent's next click had no ref. Never fails:
 * after the bound it returns what it has.
 */
const POPOUT_SETTLE_MS = 2_000;

async function settleAfterMove(tabId, titleBefore) {
  const deadline = Date.now() + POPOUT_SETTLE_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await platform.tabs.get(tabId).catch(() => null);
    const listed = !!last && last.status === 'complete' && (!!last.title || !titleBefore);
    const alive = listed && (await inWorld(tabId, 'document.readyState', { timeoutMs: 1000 }).catch(() => null)) === 'complete';
    if (alive) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

// ------------------------------------------------------------------ handoff

/** The host and every parent domain: a.b.example.com → [a.b.example.com, b.example.com, example.com]. */
function hostAndParents(host) {
  const parts = String(host ?? '').toLowerCase().split('.').filter(Boolean);
  const out = [];
  // Stop before the bare TLD: no cookie can be set on "com".
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'));
  if (!out.length && parts.length) out.push(parts.join('.')); // "localhost"
  return out;
}

/**
 * Everything a launched engine needs to carry this tab on (internal: the
 * daemon's `handoff` calls it, never an agent directly).
 *
 * Cookies are every cookie that applies to the tab's host — host-only cookies
 * for exactly that host, and domain cookies set on it or any parent — across
 * ALL paths, because the flow may go anywhere on the site next. Storage is read
 * in G9's isolated world: the page's own globals are never touched, and an
 * overridden `Storage.prototype` on the page cannot lie to the read.
 *
 * In-memory page state does not transfer; the receiving engine reloads the URL.
 */
export async function handoffExport(tabId = null) {
  const tab = tabId != null ? await requireTab(tabId) : await resolveTarget(null, null);
  const url = tab.url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Tab ${tab.id} is on ${url}, which is not a web page that can be handed off.`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`Only http(s) pages can be handed off; tab ${tab.id} is on ${parsed.protocol} .`);
  }

  const candidates = hostAndParents(parsed.hostname);
  const seen = new Map();
  for (const domain of candidates) {
    const list = await platform.cookies.getAll({ domain, tabId: tab.id }).catch(() => []);
    for (const c of list) {
      const cd = String(c.domain ?? '').replace(/^\./, '').toLowerCase();
      const applies = c.hostOnly ? cd === parsed.hostname.toLowerCase() : candidates.includes(cd);
      if (!applies) continue;
      seen.set(`${c.name}|${c.domain}|${c.path}`, c);
    }
  }

  const page = await inWorld(
    tab.id,
    `(() => {
      const dump = (s) => { const out = []; try { for (let i = 0; i < s.length; i++) { const k = s.key(i); out.push([k, s.getItem(k)]); } } catch (e) {} return out; };
      let local = [], sess = [];
      try { local = dump(localStorage); } catch (e) {}
      try { sess = dump(sessionStorage); } catch (e) {}
      return {
        localStorage: local,
        sessionStorage: sess,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        userAgent: navigator.userAgent,
      };
    })()`,
  );

  return {
    url,
    title: tab.title ?? '',
    origin: parsed.origin,
    cookies: [...seen.values()],
    localStorage: page?.localStorage ?? [],
    sessionStorage: page?.sessionStorage ?? [],
    viewport: page?.viewport ?? null,
    userAgent: page?.userAgent ?? null,
    exportedAt: Date.now(),
  };
}

// ------------------------------------------------------------------ helpers

/**
 * A browser-internal page named the way the address bar shows it.
 *
 * Two shapes, because these schemes are not all hierarchical: `edge://` and
 * `chrome://` have a host and read as `edge://extensions`, while `about:` and
 * `view-source:` do not and would come out as `about://blank` if given the
 * slashes. An error message that renders its own subject wrongly is an error
 * message people stop believing.
 */
function internalName(url = '') {
  try {
    const u = new URL(url);
    if (u.host) return `${u.protocol}//${u.host}`;
    return `${u.protocol}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return url ? String(url).slice(0, 60) : '(no URL yet)';
  }
}

export function originOf(url = '') {
  try {
    const origin = new URL(url).origin;
    // about:blank, data: and blob: URLs all have the opaque origin, which
    // stringifies to the literal "null". Showing that in a tab list reads as a
    // bug; say what the tab actually is.
    return origin === 'null' ? `(${new URL(url).protocol.replace(':', '')})` : origin;
  } catch {
    return '(unknown)';
  }
}
