/**
 * Tab discovery, selection, and the target-resolution rule.
 *
 * Target resolution is a safety boundary, not a convenience. In 'pinned' mode
 * the agent acts on exactly the tab the user consented to, even after the user
 * navigates away to read email — which is the whole point.
 */

import { getState, setState } from '../lib/state.js';
import { attach, detach, detachMany } from '../lib/cdp.js';
import { clearRefs } from '../lib/refs.js';
import { clearBuffers } from './observe.js';

const api = globalThis.browser ?? globalThis.chrome;

/** Pages the debugger can never attach to. Detected early for a clear message. */
const BLOCKED = /^(chrome|edge|about|devtools|chrome-extension|edge-extension|view-source):/i;
const BLOCKED_HOSTS = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com)/i;

export function isAttachable(url = '') {
  return !BLOCKED.test(url) && !BLOCKED_HOSTS.test(url);
}

export async function getActiveTab() {
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

/**
 * Resolve which tab a tool call should act on.
 * Honors mode, and refuses rather than guessing when nothing is pinned.
 */
export async function resolveTarget(explicitTabId) {
  const state = await getState();

  if (state.halted) {
    throw new Error('The user pressed Stop. No browser actions will run until they resume from the side panel.');
  }

  if (explicitTabId != null) {
    if (state.mode !== 'multi' && explicitTabId !== state.pinnedTabId) {
      throw new Error(
        `Mode is "${state.mode}", which locks the agent to tab ${state.pinnedTabId}. ` +
          `To act on other tabs, ask the user to switch the side panel to "Multi-tab" mode.`,
      );
    }
    return requireTab(explicitTabId);
  }

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
 */
export async function requireMultiMode(action) {
  const state = await getState();
  if (state.mode === 'multi') return;
  throw new Error(
    `action:"${action}" changes which tabs exist or which tab you control, and the mode is ` +
      `"${state.mode}". Only the user may do that — ask them to either perform it themselves ` +
      `from the G9 side panel, or switch the panel to "Multi-tab" mode. You may still use ` +
      `action:"list".`,
  );
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
    throw new Error(`Cannot attach to ${tab.url} — browser-internal pages are off limits.`);
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
  await setState({ pinnedTabId: null });

  await Promise.all(
    held.flatMap((id) => [clearRefs(id).catch(() => {}), clearBuffers(id).catch(() => {})]),
  );

  return results;
}

/** Scheme + host only. The redacted form of a tab the agent may not drive. */
export function originOf(url = '') {
  try {
    return new URL(url).origin;
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

  return tabs.map((t) => {
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
    };
    return full || t.id === targetId
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
