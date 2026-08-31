/**
 * Navigation and waiting.
 *
 * Waiting is where naive automation breaks. A fixed sleep is either too short
 * (flaky) or too long (slow). These waits poll a real condition with a deadline
 * and return *why* they finished, so the agent can reason about it.
 */

import { send, evaluate } from '../lib/cdp.js';
import { clearRefs } from '../lib/refs.js';
import { clearBuffers } from './observe.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reset per-page state before leaving a page.
 *
 * Refs were always cleared here; the capture buffers were not, and that made
 * `browser_diagnose` actively misleading. After navigating from a busy site to
 * a fresh page, the health report was still full of the *previous* page's
 * console errors and failed requests, each stamped with the old page's URL and
 * presented as a finding about the new one. An agent reads that and reports a
 * defect that does not exist.
 *
 * Clearing BEFORE `Page.navigate` rather than after is what makes the new
 * page's traffic complete: the main document request is sent by the navigation
 * itself, so anything cleared afterwards would throw that record away.
 */
async function resetPageState(tabId) {
  await clearRefs(tabId);
  await clearBuffers(tabId);
}

export async function navigate(tabId, { url, waitUntil = 'load', timeoutMs = 30_000 } = {}) {
  await resetPageState(tabId);
  const result = await send(tabId, 'Page.navigate', { url });
  if (result.errorText) throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
  const settled = await waitForLoad(tabId, { waitUntil, timeoutMs });
  return { url: await currentUrl(tabId), ...settled };
}

export async function reload(tabId, { hard = false, waitUntil = 'load', timeoutMs = 30_000 } = {}) {
  await resetPageState(tabId);
  await send(tabId, 'Page.reload', { ignoreCache: hard });
  const settled = await waitForLoad(tabId, { waitUntil, timeoutMs });
  return { url: await currentUrl(tabId), hard, ...settled };
}

export async function history(tabId, { delta = -1 } = {}) {
  await resetPageState(tabId);
  const { currentIndex, entries } = await send(tabId, 'Page.getNavigationHistory');
  const target = currentIndex + delta;
  if (target < 0 || target >= entries.length) {
    throw new Error(`Cannot go ${delta > 0 ? 'forward' : 'back'} — no such history entry.`);
  }
  await send(tabId, 'Page.navigateToHistoryEntry', { entryId: entries[target].id });
  await waitForLoad(tabId, { waitUntil: 'load', timeoutMs: 15_000 });
  return { url: await currentUrl(tabId), movedTo: entries[target].url };
}

/**
 * Wait for a condition. Exactly one of text/selector/ref-gone/idle should be
 * given; `idle` means "no network activity and no DOM mutations for a beat",
 * which is the closest thing to "the page finished doing whatever it was doing".
 */
export async function waitFor(tabId, { text, selector, gone = false, idle = false, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  if (idle) return waitForIdle(tabId, timeoutMs);

  if (!text && !selector) throw new Error('waitFor needs text, selector, or idle:true.');

  const expr = selector
    ? `!!document.querySelector(${JSON.stringify(selector)})`
    : `document.body && document.body.innerText.includes(${JSON.stringify(text)})`;

  while (Date.now() < deadline) {
    let present = false;
    try {
      present = await evaluate(tabId, `(() => { try { return ${expr}; } catch { return false; } })()`);
    } catch {
      // Mid-navigation the context is destroyed; retry.
    }
    if (present === !gone) {
      return { satisfied: true, waitedMs: timeoutMs - (deadline - Date.now()) };
    }
    await sleep(120);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${selector ? `selector ${selector}` : `text "${text}"`} to ` +
      `${gone ? 'disappear' : 'appear'}. Take a browser_snapshot to see the current state.`,
  );
}

/** Load-state wait with a hard deadline. */
async function waitForLoad(tabId, { waitUntil, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const wanted = waitUntil === 'domcontentloaded' ? ['interactive', 'complete'] : ['complete'];

  while (Date.now() < deadline) {
    try {
      const state = await evaluate(tabId, 'document.readyState');
      if (wanted.includes(state)) {
        if (waitUntil === 'idle') {
          await waitForIdle(tabId, Math.max(1000, deadline - Date.now()));
        }
        return { readyState: state, timedOut: false };
      }
    } catch {
      /* context swapping during navigation */
    }
    await sleep(100);
  }
  return { readyState: 'unknown', timedOut: true };
}

/** No network requests in flight and no DOM mutations for 500ms. */
async function waitForIdle(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  await evaluate(
    tabId,
    `(() => {
       if (window.__g9Idle) return;
       window.__g9Idle = { mutations: 0, last: Date.now() };
       new MutationObserver(() => { window.__g9Idle.mutations++; window.__g9Idle.last = Date.now(); })
         .observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
     })()`,
  ).catch(() => {});

  while (Date.now() < deadline) {
    const quietFor = await evaluate(
      tabId,
      `(() => { const s = window.__g9Idle; return s ? Date.now() - s.last : 9999; })()`,
    ).catch(() => 0);

    if (quietFor >= 500) {
      return { satisfied: true, idle: true, quietForMs: quietFor };
    }
    await sleep(100);
  }
  return { satisfied: false, idle: false, timedOut: true };
}

async function currentUrl(tabId) {
  return evaluate(tabId, 'location.href').catch(() => null);
}
