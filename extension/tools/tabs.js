/**
 * Tab discovery, selection, and the target-resolution rule.
 *
 * Target resolution is a safety boundary, not a convenience. In 'pinned' mode
 * the agent acts on exactly the tab the user consented to, even after the user
 * navigates away to read email — which is the whole point.
 *
 * As of v1.7.0 there are two more ways to name a target, and neither weakens
 * that rule:
 *
 *   - **Workspace mode** consents once, by allowlist, instead of once per tab.
 *     A tab outside the project's domains is refused exactly as a pinned-mode
 *     stranger is. See lib/workspace.js for why an empty allowlist denies
 *     everything rather than allowing it.
 *   - **Named sessions** address one of several attached tabs. chrome.debugger
 *     always allowed several; what was missing was a name to reach them by.
 *     A session may only be opened on a tab the current mode already permits,
 *     so naming a tab never grants access to it.
 */

import { getState, setState } from '../lib/state.js';
import { attach, detach, detachMany } from '../lib/cdp.js';
import { clearRefs } from '../lib/refs.js';
import { clearBuffers } from './observe.js';
import { inWorkspace, refusalFor } from '../lib/workspace.js';

const api = globalThis.browser ?? globalThis.chrome;

/** Pages the debugger can never attach to. Detected early for a clear message. */
const BLOCKED = /^(chrome|edge|about|devtools|chrome-extension|edge-extension|view-source):/i;
const BLOCKED_HOSTS = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com)/i;

export function isAttachable(url = '') {
  return !BLOCKED.test(url) && !BLOCKED_HOSTS.test(url);
}

/** Where the last focused ORDINARY browser window is remembered. */
const LAST_NORMAL_WINDOW = 'g9:lastNormalWindow';

/**
 * Remember which real browser window the user was last in.
 *
 * Called from the service worker's `windows.onFocusChanged`. It has to be
 * persisted rather than held in a variable: the worker is evicted between
 * events, and a target that survives only as long as the worker is not a target.
 */
export async function rememberFocus(windowId) {
  if (windowId == null || windowId === api.windows.WINDOW_ID_NONE) return;
  const win = await api.windows.get(windowId).catch(() => null);
  if (win?.type !== 'normal') return;
  await api.storage.session.set({ [LAST_NORMAL_WINDOW]: windowId });
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
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && isAttachable(tab.url ?? '')) return tab;

  const stored = await api.storage.session.get(LAST_NORMAL_WINDOW).catch(() => ({}));
  const remembered = stored?.[LAST_NORMAL_WINDOW];
  if (remembered != null) {
    const [inRemembered] = await api.tabs.query({ active: true, windowId: remembered }).catch(() => []);
    if (inRemembered) return inRemembered;
  }

  const windows = (await api.windows.getAll({ populate: true }).catch(() => []))
    .filter((w) => w.type === 'normal');
  const pick = windows.find((w) => w.focused) ?? (windows.length === 1 ? windows[0] : null);
  return pick?.tabs?.find((t) => t.active) ?? tab ?? null;
}

/** Is this tab inside the project's workspace allowlist? */
export function isWorkspaceTab(tab, state) {
  return isAttachable(tab?.url ?? '') && inWorkspace(tab?.url ?? '', state.project?.workspaceDomains ?? []);
}

/**
 * Resolve which tab a tool call should act on.
 * Honors mode, and refuses rather than guessing when nothing is pinned.
 *
 * `session` is checked before everything else because a named session is the
 * most specific thing a caller can say. It still has to pass the mode's own
 * rule: a session is a NAME for a tab, never a grant of access to one.
 */
export async function resolveTarget(explicitTabId, sessionName = null) {
  const state = await getState();

  if (state.halted) {
    throw new Error('The user pressed Stop. No browser actions will run until they resume from the side panel.');
  }

  if (sessionName) return resolveSession(state, sessionName);

  if (explicitTabId != null) {
    if (state.mode === 'multi') return requireTab(explicitTabId);

    if (state.mode === 'workspace') {
      const tab = await requireTab(explicitTabId);
      if (!isWorkspaceTab(tab, state)) {
        throw new Error(refusalFor(tab.url, state.project?.workspaceDomains, { projectPath: state.project?.path }));
      }
      return tab;
    }

    if (explicitTabId !== state.pinnedTabId) {
      // Follow mode has no pinned tab, so naming one read as "locks the agent
      // to tab null" — an error message that describes a state that cannot
      // exist tells the agent nothing it can act on.
      throw new Error(
        state.mode === 'follow'
          ? `Mode is "follow", which locks the agent to whichever tab is currently focused — a tabId ` +
            `cannot be chosen. To act on a specific tab, ask the user to switch the side panel to ` +
            `"Multi-tab" mode.`
          : `Mode is "pinned", which locks the agent to tab ${state.pinnedTabId}. ` +
            `To act on other tabs, ask the user to switch the side panel to "Multi-tab" mode.`,
      );
    }
    return requireTab(explicitTabId);
  }

  if (state.mode === 'workspace') return resolveWorkspaceTarget(state);

  if (state.mode === 'follow') {
    const active = await getActiveTab();
    if (!active) throw new Error('No active tab found.');
    if (!isAttachable(active.url)) {
      throw new Error(`The active tab (${active.url}) is a browser-internal page and cannot be controlled.`);
    }
    return active;
  }

  if (state.pinnedTabId == null) {
    throw new Error(
      'No tab is attached yet. The user must open the G9 side panel and press "Attach & Pin" on the tab they want the agent to control.',
    );
  }
  return requireTab(state.pinnedTabId);
}

/**
 * Workspace mode's target: the focused tab if it is ours, else the only one.
 *
 * The fallback matters more than it looks. A QA presses a button, the app opens
 * a payment provider in a new tab, and now the focused tab is outside the
 * workspace. Refusing there would be technically correct and practically
 * useless — the agent is mid-flow on a tab it is fully entitled to drive. So
 * when exactly one workspace tab exists, that is unambiguously the target.
 *
 * With several, we refuse and name them rather than guessing. Guessing between
 * two tabs of the same app is how a flow silently runs against the wrong one.
 */
async function resolveWorkspaceTarget(state) {
  const domains = state.project?.workspaceDomains ?? [];
  if (!domains.length) {
    // Degrade to Pinned, exactly as documented, rather than to "anything".
    if (state.pinnedTabId != null) return requireTab(state.pinnedTabId);
    throw new Error(refusalFor('', domains, { projectPath: state.project?.path }));
  }

  const active = await getActiveTab();
  if (active && isWorkspaceTab(active, state)) return active;

  // A pinned tab is the user saying, in as many words, "this one". It outranks
  // every guess below it — and it is what keeps the agent working when the
  // focused window is the popped-out panel, a second monitor, or another app.
  if (state.pinnedTabId != null) {
    const pinned = await requireTab(state.pinnedTabId).catch(() => null);
    if (pinned && isWorkspaceTab(pinned, state)) return pinned;
  }

  const tabs = (await api.tabs.query({})).filter((t) => isWorkspaceTab(t, state));
  if (tabs.length === 1) return tabs[0];
  if (tabs.length === 0) {
    throw new Error(
      `No tab in this project's workspace is open. Allowed: ${domains.join(', ')}. ` +
        `Open one of those, or ask the user to switch the side panel to Multi-tab mode.`,
    );
  }
  throw new Error(
    `${tabs.length} workspace tabs are open and none is focused, so there is no unambiguous target: ` +
      tabs.map((t) => `tab ${t.id} (${originOf(t.url)})`).join(', ') +
      `. Click the tab you mean, or press "Attach & Pin" on it in the side panel — a pinned tab stays ` +
      `the target even when the focus is somewhere else entirely. An explicit tabId, or named sessions ` +
      `via browser_tabs action:"session", also work.`,
  );
}

/** Look up a named session and confirm the mode still permits it. */
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

  let tab;
  try {
    tab = await requireTab(tabId);
  } catch (err) {
    await closeSession(name).catch(() => {});
    throw new Error(`Session "${name}" pointed at tab ${tabId}, which is gone: ${err.message}`);
  }

  if (state.mode === 'workspace' && !isWorkspaceTab(tab, state)) {
    throw new Error(
      `Session "${name}" has navigated to ${originOf(tab.url)}, which is outside this project's ` +
        `workspace (${(state.project?.workspaceDomains ?? []).join(', ')}). The agent may not act on it. ` +
        `This is normal when a flow leaves the app — bring it back, or use Multi-tab mode.`,
    );
  }
  return tab;
}

/**
 * The second half of the safety boundary.
 *
 * `resolveTarget()` guards actions that happen *inside* a tab. It is reached
 * only by tools that declare `needsTab`, and `browser_tabs` deliberately does
 * not — it has no target to resolve. That left opening, closing, focusing,
 * pinning, and unpinning completely ungoverned: an agent in pinned mode could
 * pin the user's mail tab and then operate on it legitimately, which is exactly
 * the scenario pinned mode exists to prevent.
 *
 * Anything that changes which tabs exist, or which tab the agent controls, goes
 * through here. Only the user changes the mode, and only from the side panel.
 *
 * ## Workspace mode's version of the same rule
 *
 * Workspace mode may open, close and focus tabs — but only ones inside the
 * allowlist, and the URL is checked BEFORE the tab exists. That ordering is the
 * whole guarantee: checking afterwards would mean the tab is already open, and
 * "we opened your bank and then closed it" is not a boundary.
 */
export async function requireTabControl(action, url = null) {
  const state = await getState();
  if (state.mode === 'multi') return;

  if (state.mode === 'workspace') {
    const domains = state.project?.workspaceDomains ?? [];
    if (!domains.length) {
      throw new Error(
        `action:"${action}" needs a workspace allowlist and this project has none, so the mode is ` +
          `behaving as Pinned. Add "workspaceDomains" to g9.project.json, or ask the user to switch ` +
          `the side panel to Multi-tab mode.`,
      );
    }
    if (url == null) return; // acting on an already-resolved workspace tab
    if (!inWorkspace(url, domains)) {
      // The refusal names the ORIGIN, never the full URL.
      //
      // This message is produced for a tab the agent is not allowed to see, and
      // `action:"session"` reaches it with a URL read off the BROWSER — so
      // echoing that URL back would hand over exactly what pinned and workspace
      // mode exist to withhold: the conversation id, the document name, the
      // search query. It leaked a full chatgpt.com/c/<id> on the first live
      // test. An agent that supplied the URL itself already knows it, so
      // redacting costs nothing and closes the case where it did not.
      throw new Error(
        `action:"${action}" targets ${originOf(url)}, which is outside this project's workspace ` +
          `(${domains.join(', ')}). Refused before the tab was touched. Add the host to ` +
          `g9.project.json, or ask the user for Multi-tab mode.`,
      );
    }
    return;
  }

  throw new Error(
    `action:"${action}" changes which tabs exist or which tab you control, and the mode is ` +
      `"${state.mode}". Only the user may do that — ask them to either perform it themselves ` +
      `from the G9 side panel, or switch the panel to "Multi-tab" or "Workspace" mode. You may ` +
      `still use action:"list".`,
  );
}

/** Kept as an alias so nothing that imported the old name breaks silently. */
export const requireMultiMode = requireTabControl;

// ------------------------------------------------------------------ sessions

/**
 * Open (or re-point) a named session.
 *
 * Reuses an existing tab on the same URL rather than piling up duplicates: a
 * flow that runs twice should not leave two "buyer" tabs behind, and the second
 * run would otherwise start on a page the first one already navigated.
 */
export async function openSession(name, url, { active = false } = {}) {
  if (!name || typeof name !== 'string') throw new Error('A session needs a name.');
  await requireTabControl('session', url);

  const state = await getState();
  const existing = state.sessions?.[name];
  let tab = null;

  if (existing != null) {
    tab = await api.tabs.get(existing).catch(() => null);
  }
  if (tab && url) {
    await api.tabs.update(tab.id, { url, active });
    tab = await api.tabs.get(tab.id);
  } else if (!tab) {
    tab = await api.tabs.create({ url, active });
  }

  await attach(tab.id);
  await setState({ sessions: { ...(state.sessions ?? {}), [name]: tab.id } });
  return { session: name, tabId: tab.id, url: tab.url ?? url };
}

/** Name a tab that is already open, without navigating it. */
export async function nameSession(name, tabId) {
  if (!name) throw new Error('A session needs a name.');
  const tab = await requireTab(tabId);
  await requireTabControl('session', tab.url);
  const state = await getState();
  await attach(tab.id);
  await setState({ sessions: { ...(state.sessions ?? {}), [name]: tab.id } });
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
  const state = await getState();
  const tabId = state.sessions?.[name];
  const rest = { ...(state.sessions ?? {}) };
  delete rest[name];
  await setState({ sessions: rest });
  if (tabId != null) {
    await detach(tabId).catch(() => {});
    await clearRefs(tabId).catch(() => {});
  }
  return { session: name, closed: tabId != null };
}

/** Every open session, with the live state of the tab behind it. */
export async function listSessions() {
  const state = await getState();
  const entries = Object.entries(state.sessions ?? {});
  const out = [];
  for (const [name, tabId] of entries) {
    const tab = await api.tabs.get(tabId).catch(() => null);
    out.push({
      session: name,
      tabId,
      alive: !!tab,
      active: tab?.active ?? false,
      inWorkspace: tab ? isWorkspaceTab(tab, state) : false,
      ...(tab ? { title: tab.title, url: tab.url } : {}),
    });
  }
  return out;
}

async function requireTab(tabId) {
  let tab;
  try {
    tab = await api.tabs.get(tabId);
  } catch {
    await setState({ pinnedTabId: null });
    throw new Error(`Tab ${tabId} no longer exists — it was probably closed. Ask the user to attach a new tab.`);
  }
  if (!isAttachable(tab.url)) {
    throw new Error(`Tab ${tabId} is on ${tab.url}, a browser-internal page that cannot be controlled.`);
  }
  return tab;
}

/**
 * Attach and pin a tab.
 *
 * `clearHalt` is the difference between the user pressing "Attach & Pin" and an
 * agent calling browser_tabs. Pinning used to always clear `halted`, which made
 * the Stop button self-defeating: a halted agent could un-halt itself with one
 * pin call. Only a real user gesture from the side panel may lift a stop.
 */
export async function pinTab(tabId, { clearHalt = false } = {}) {
  const tab = await api.tabs.get(tabId);
  if (!isAttachable(tab.url)) {
    // Say whose rule this is, and what to do instead.
    //
    // Hit for real: reloading the extension leaves you ON edge://extensions, so
    // the very next thing anybody does is press Attach on that page. The old
    // message named the page and stopped, which reads like the tool refusing —
    // and the two facts that actually help are that the BROWSER forbids this,
    // and that switching tabs is the whole fix.
    const state = await getState();
    throw new Error(
      // The scheme+host, not originOf(): a browser-internal URL has the opaque
      // origin, so originOf renders "(edge)" — which tells the reader nothing
      // about which page they are on. These pages are the user's own browser
      // UI, not a site, so there is nothing here to withhold.
      `Cannot attach to ${internalName(tab.url)} — the browser itself does not let any debugger attach to ` +
        `its internal pages (${'edge://'}, ${'chrome://'}, about:, devtools:, view-source:) or to the ` +
        `extension gallery. This is not a setting.\n\n` +
        `Switch to the page you want to test and press Attach again.` +
        (state.mode === 'workspace'
          ? ` In Workspace mode you usually do not need to: focus a tab on one of this project's ` +
            `sites and it attaches on its own.`
          : ''),
    );
  }
  const state = await getState();
  if (state.pinnedTabId != null && state.pinnedTabId !== tabId) {
    await detach(state.pinnedTabId).catch(() => {});
    await clearRefs(state.pinnedTabId);
    await clearBuffers(state.pinnedTabId);
  }
  await attach(tabId);
  await setState({ pinnedTabId: tabId, ...(clearHalt ? { halted: false } : {}) });
  return tab;
}

/**
 * Stop debugging — every tab, not just the pinned one.
 *
 * `attachedTabs` accumulates: `send()` attaches whatever tab it is given, so
 * follow mode picks up each tab the user visits and multi mode picks up each
 * one the agent touches. Detaching only `pinnedTabId` left those attached, and
 * the "browser is being debugged" banner is per attached tab — so pressing
 * Detach could leave banners up on tabs the panel no longer mentioned.
 *
 * Returns what actually happened per tab, so the panel can say "still attached"
 * rather than claiming a clean detach it did not verify.
 */
export async function unpinTab() {
  const state = await getState();
  const held = [...new Set(state.attachedTabs)];
  if (state.pinnedTabId != null && !held.includes(state.pinnedTabId)) held.push(state.pinnedTabId);

  // Release first, then tidy. The user is watching the debugger banner; the
  // buffer and ref cleanup behind it can happen at whatever speed it likes.
  const results = await detachMany(held);
  // Sessions go with the detach. A named session whose tab is no longer being
  // debugged is a name that resolves to a dead handle — and the next call would
  // silently re-attach a tab the user just asked us to let go of.
  await setState({ pinnedTabId: null, sessions: {} });

  await Promise.all(
    held.flatMap((id) => [clearRefs(id).catch(() => {}), clearBuffers(id).catch(() => {})]),
  );

  return results;
}

/** Scheme + host only. The redacted form of a tab the agent may not drive. */
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
    return '(unknown)';
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

/**
 * Which tab the agent will actually act on, by mode.
 *
 * Follow mode acts on the ACTIVE tab, not the pinned one — so anything that
 * reports "the attached tab" has to ask the same question `resolveTarget()`
 * asks, or it will orient the agent to a page it is not about to touch.
 */
export async function currentTargetId(state) {
  if (state.mode === 'workspace') {
    // Mirror resolveWorkspaceTarget exactly, including its single-tab fallback.
    // Reporting a different tab from the one the next call will act on is the
    // precise bug this function was extracted to prevent.
    const domains = state.project?.workspaceDomains ?? [];
    if (!domains.length) return state.pinnedTabId;
    const active = await getActiveTab().catch(() => null);
    if (active && isWorkspaceTab(active, state)) return active.id;
    const tabs = (await api.tabs.query({}).catch(() => [])).filter((t) => isWorkspaceTab(t, state));
    return tabs.length === 1 ? tabs[0].id : null;
  }
  if (state.mode !== 'follow') return state.pinnedTabId;
  const active = await getActiveTab().catch(() => null);
  // Follow mode never falls back to the old pin. resolveTarget() refuses an
  // internal active page, so status/listing must report the same absence rather
  // than orienting the agent to a tab its next call will not control.
  return active && isAttachable(active.url) ? active.id : null;
}

/**
 * The one disclosure rule for tab listings.
 *
 * It lives here, and every tool that lists tabs uses it, because it has been
 * written separately three times and drifted every time: `browser_status`
 * redacted (v1.0.7) while `browser_tabs list` handed over every title and URL,
 * and `inspect cookies` had no boundary at all (v1.0.14). Titles and URLs carry
 * subject lines, document names, order numbers, and search queries — the exact
 * things pinned and follow mode exist to keep out of the agent's context.
 *
 * The tab the agent IS allowed to drive is never redacted; it can read that
 * page in full anyway.
 */
export async function listTabs() {
  const tabs = await api.tabs.query({});
  const state = await getState();
  const full = state.mode === 'multi';
  const targetId = await currentTargetId(state);
  const sessionByTab = new Map(Object.entries(state.sessions ?? {}).map(([n, id]) => [id, n]));

  return tabs.map((t) => {
    const workspace = state.mode === 'workspace' && isWorkspaceTab(t, state);
    const base = {
      tabId: t.id,
      active: t.active,
      windowId: t.windowId,
      pinned: t.id === state.pinnedTabId,
      target: t.id === targetId,
      attached: state.attachedTabs.includes(t.id),
      attachable: isAttachable(t.url),
      status: t.status,
      openerTabId: t.openerTabId ?? null,
      ...(sessionByTab.has(t.id) ? { session: sessionByTab.get(t.id) } : {}),
      ...(state.mode === 'workspace' ? { inWorkspace: workspace } : {}),
    };
    // A workspace tab is one the agent may read in full anyway, so redacting it
    // buys nothing and costs a round trip. Everything else stays an origin.
    return full || t.id === targetId || workspace
      ? { ...base, title: t.title, url: t.url }
      : { ...base, origin: originOf(t.url) };
  });
}

export async function openTab(url, { active = false } = {}) {
  const tab = await api.tabs.create({ url, active });
  return { tabId: tab.id, url: tab.url ?? url };
}

export async function closeTab(tabId) {
  const state = await getState();
  if (tabId === state.pinnedTabId) await unpinTab();
  await api.tabs.remove(tabId);
}

export async function focusTab(tabId) {
  await api.tabs.update(tabId, { active: true });
  const tab = await api.tabs.get(tabId);
  await api.windows.update(tab.windowId, { focused: true });
  return tab;
}

/** Wait for a popup/window/tab matching observable browser metadata. */
export async function waitForTab({ url, title, openerTabId, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 15_000);
  while (Date.now() < deadline) {
    const tabs = await api.tabs.query({});
    const match = tabs.find((tab) =>
      (url == null || String(tab.url ?? '').includes(url)) &&
      (title == null || String(tab.title ?? '').includes(title)) &&
      (openerTabId == null || tab.openerTabId === openerTabId)
    );
    if (match) return { tabId: match.id, url: match.url, title: match.title, openerTabId: match.openerTabId ?? null };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for a tab' +
    (url ? ' with URL containing "' + url + '"' : '') +
    (title ? ' titled "' + title + '"' : '') +
    (openerTabId != null ? ' opened by tab ' + openerTabId : '') + '.');
}
