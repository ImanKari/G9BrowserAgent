/**
 * Tab discovery, selection, and the target-resolution rule.
 *
 * Target resolution is a safety boundary, not a convenience. In 'pinned' mode
 * the agent acts on exactly the tab the user consented to, even after the user
 * navigates away to read email — which is the whole point.
 */

import { getState, setState } from '../lib/state.js';
import { attach, detach } from '../lib/cdp.js';
import { clearRefs } from '../lib/refs.js';

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

export async function pinTab(tabId) {
  const tab = await api.tabs.get(tabId);
  if (!isAttachable(tab.url)) {
    throw new Error(`Cannot attach to ${tab.url} — browser-internal pages are off limits.`);
  }
  const state = await getState();
  if (state.pinnedTabId != null && state.pinnedTabId !== tabId) {
    await detach(state.pinnedTabId).catch(() => {});
    await clearRefs(state.pinnedTabId);
  }
  await attach(tabId);
  await setState({ pinnedTabId: tabId, halted: false });
  return tab;
}

export async function unpinTab() {
  const state = await getState();
  if (state.pinnedTabId != null) {
    await detach(state.pinnedTabId).catch(() => {});
    await clearRefs(state.pinnedTabId);
  }
  await setState({ pinnedTabId: null });
}

export async function listTabs() {
  const tabs = await api.tabs.query({});
  const state = await getState();
  return tabs.map((t) => ({
    tabId: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
    windowId: t.windowId,
    pinned: t.id === state.pinnedTabId,
    attached: state.attachedTabs.includes(t.id),
    attachable: isAttachable(t.url),
    status: t.status,
  }));
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
