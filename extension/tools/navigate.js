/**
 * Navigation and waiting.
 *
 * Waiting is where naive automation breaks. A fixed sleep is either too short
 * (flaky) or too long (slow). These waits poll a real condition with a deadline
 * and return *why* they finished, so the agent can reason about it.
 */

import { send, COMMAND_TIMEOUT_MS } from '../lib/cdp.js';
import { clearRefs } from '../lib/refs.js';
import { inWorld } from '../lib/world.js';
import { levelFor, perform } from '../lib/humanize.js';
import { createRng, planGap } from '../humanize/index.js';
import { clearBuffers, network } from './observe.js';

/**
 * Every page read here runs in G9's isolated world (lib/world.js). The idle
 * watcher below is the case that made this matter: it used to hang a
 * MutationObserver and a `window.__g9Idle` object off the page's own window,
 * where the page — and anything fingerprinting it — could see both. In the
 * isolated world it observes the same DOM and is invisible to the page.
 */
const evaluate = (tabId, expression) => inWorld(tabId, expression);

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

/**
 * The post-load human idle (docs/HUMANIZE.md, Gaps between actions): a person looks at a page that has just
 * loaded before they act on it, and an action at millisecond 0 after
 * `load` is one of the cheapest automation signals there is. At the `human`
 * and `stealth` levels the navigation returns only after a pause drawn from
 * the profile (`gaps.afterNavigationMs`, seeded like every other humanized
 * decision); at `off` it returns immediately, exactly as v1 did.
 *
 * The pause is a planGap() plan run through lib/humanize.js perform(), which
 * waits until the plan's `durationMs` (trailing pauses included, F3) in
 * slices and checks Stop between them — a pause sends no input. This used to
 * be a second copy of that wait loop here, because perform() returned at the
 * last step's start and a pause-only plan took no time at all. A Stop during
 * the idle ends the idle only — the navigation itself has already happened.
 */
async function humanIdle(tabId, opts) {
  const { level, profile, seed } = await levelFor(tabId, opts);
  if (level === 'off') return null;
  const plan = planGap(createRng(seed), profile, { after: 'navigation' });
  if (!(plan.durationMs > 0)) return null;
  const started = Date.now();
  try {
    await perform(tabId, plan, { track: false });
  } catch (err) {
    if (err?.halted) return { humanIdleMs: Math.min(plan.durationMs, Date.now() - started), humanIdleInterrupted: true, seed };
    throw err;
  }
  return { humanIdleMs: plan.durationMs, seed };
}

/** Idle only after a load that actually settled; after a timeout there is nothing to look at yet. */
async function settleLikeAPerson(tabId, settled, opts) {
  if (settled.timedOut) return {};
  return (await humanIdle(tabId, opts)) ?? {};
}

/**
 * The budget of the navigation COMMAND itself: the call's own deadline, never less than an ordinary
 * command's.
 *
 * `Page.navigate` answers when the navigation commits — once the server's response headers have
 * arrived (measured: an 8 s and a 25 s header delay returned after 8.0 s and 25.0 s). Its duration
 * is the server's time to first byte, not the browser's. It used to get the generic 20 s budget
 * meant for stuck commands: a goto with timeoutMs 45000–90000 to a server that took 25 s failed at
 * 20 s as "stuck rather than slow — the browser never answered" (live round 3: 4/59 public pages,
 * and a cold staging server), while `timeoutMs` only bounded the load wait that came after.
 * `timeoutMs` is now the deadline of the whole goto: the command gets it, the load wait gets what
 * is left.
 */
export function navigationBudget(timeoutMs) {
  return Math.max(Number(timeoutMs) > 0 ? Number(timeoutMs) : 0, COMMAND_TIMEOUT_MS);
}

/** What is left of a `timeoutMs` deadline that started at `started` (at least 1 s, to read the state). */
const remainingOf = (started, timeoutMs) => Math.max(1_000, timeoutMs - (Date.now() - started));

export async function navigate(tabId, opts = {}) {
  const { url, waitUntil = 'load', timeoutMs = 30_000 } = opts;
  await resetPageState(tabId);
  const started = Date.now();
  const result = await send(tabId, 'Page.navigate', { url }, { timeoutMs: navigationBudget(timeoutMs) });
  if (result.errorText) throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
  const settled = await waitForLoad(tabId, { waitUntil, timeoutMs: remainingOf(started, timeoutMs) });
  const idle = await settleLikeAPerson(tabId, settled, opts);
  return { url: await currentUrl(tabId), ...settled, ...idle };
}

export async function reload(tabId, opts = {}) {
  const { hard = false, waitUntil = 'load', timeoutMs = 30_000 } = opts;
  await resetPageState(tabId);
  const started = Date.now();
  await send(tabId, 'Page.reload', { ignoreCache: hard }, { timeoutMs: navigationBudget(timeoutMs) });
  const settled = await waitForLoad(tabId, { waitUntil, timeoutMs: remainingOf(started, timeoutMs) });
  const idle = await settleLikeAPerson(tabId, settled, opts);
  return { url: await currentUrl(tabId), hard, ...settled, ...idle };
}

export async function history(tabId, { delta = -1, ...opts } = {}) {
  const { currentIndex, entries } = await send(tabId, 'Page.getNavigationHistory');
  const target = currentIndex + delta;
  if (target < 0 || target >= entries.length) {
    throw new Error(`Cannot go ${delta > 0 ? 'forward' : 'back'} — no such history entry.`);
  }
  // Only discard refs and evidence once a destination is known to exist.
  await resetPageState(tabId);
  const started = Date.now();
  await send(tabId, 'Page.navigateToHistoryEntry', { entryId: entries[target].id }, { timeoutMs: navigationBudget(15_000) });
  const settled = await waitForLoad(tabId, { waitUntil: 'load', timeoutMs: remainingOf(started, 15_000) });
  const idle = await settleLikeAPerson(tabId, settled, opts);
  return { url: await currentUrl(tabId), movedTo: entries[target].url, ...idle };
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
       if (window.__g9Idle) { window.__g9Idle.last = Date.now(); return; }
       const state = { mutations: 0, last: Date.now() };
       state.observer = new MutationObserver(() => { state.mutations++; state.last = Date.now(); });
       state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
       window.__g9Idle = state;
     })()`,
  ).catch(() => {});

  while (Date.now() < deadline) {
    const [quietFor, pending] = await Promise.all([
      evaluate(
        tabId,
        `(() => { const s = window.__g9Idle; return s ? Date.now() - s.last : 9999; })()`,
      ).catch(() => 0),
      // `total` is the size of the complete capture buffer. `returned` is the
      // number left after the pending filter. Using total here meant that one
      // old, completed request could make every later idle wait time out.
      network(tabId, { status: 'pending', limit: 0 }).then((r) => r.returned).catch(() => 0),
    ]);

    if (quietFor >= 500 && pending === 0) {
      await stopIdleWatch(tabId);
      return { satisfied: true, idle: true, quietForMs: quietFor, pendingRequests: 0 };
    }
    await sleep(100);
  }
  await stopIdleWatch(tabId);
  return { satisfied: false, idle: false, timedOut: true };
}

/**
 * Take the idle observer back off the page.
 *
 * It used to be left running for the life of the document — a MutationObserver
 * on documentElement with subtree, attributes and characterData, firing for
 * every change the page makes forever after. On a page that renders constantly
 * that is real overhead, and it lands on the two tools least able to afford it:
 * `diagnose.performance` measures the page WITH our observer in it, and
 * `diagnose.memory` reports node and listener growth as a leak signal, so the
 * tool was contributing to the very number it was asked to interpret.
 */
function stopIdleWatch(tabId) {
  return evaluate(
    tabId,
    `(() => {
       const s = window.__g9Idle;
       if (!s) return false;
       s.observer && s.observer.disconnect();
       delete window.__g9Idle;
       return true;
     })()`,
  ).catch(() => false);
}

async function currentUrl(tabId) {
  return evaluate(tabId, 'location.href').catch(() => null);
}
