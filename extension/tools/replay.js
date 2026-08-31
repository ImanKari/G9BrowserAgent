/**
 * Replaying a recording, and explaining it when it fails.
 *
 * The failure message is the product here. A test that says "step 4 failed" has
 * told the QA nothing they did not already know; the work is in saying which
 * element, what it looked for, what it found instead, and what that implies.
 *
 * ## Waiting is not sleeping
 *
 * Recordings carry the wall-clock gap between steps, because a session's rhythm
 * is part of what it reproduces. But replaying a gap as `sleep(waitMs)` is the
 * single reason recorded tests are famous for flaking: the gap that was enough
 * on the QA's machine is not enough on a loaded CI box, and is far too long
 * everywhere else.
 *
 * So the gap is a **budget**, not a duration. Each step polls for its element
 * to exist and be actionable, and proceeds the moment it is. `timing: "fast"`
 * shrinks the budget, `"recorded"` also honours the original pause once the
 * element is ready — for pages whose behaviour genuinely depends on pacing —
 * and `"adaptive"` (the default) waits only as long as it must.
 *
 * ## Degradation is reported before it becomes failure
 *
 * `lib/locators.js` says which locator matched. A step that used to match on
 * `testid` and now matches on `xpath` still passes, and is one refactor from
 * not passing. Replay collects those as warnings, so a recording tells you it
 * is rotting before the morning it breaks.
 */

import { send, evaluate, callOnNode } from '../lib/cdp.js';
import { LOCATOR_SOURCE } from '../lib/locators.js';
import { getRecording, saveRecording } from '../lib/store.js';
import { saveRefs, getRefs } from '../lib/refs.js';
import * as interact from './interact.js';
import * as nav from './navigate.js';

/** Two consecutive identical boxes is the cheapest proof an element has settled. */
const POLL_MS = 120;
/** Even a zero-gap step gets this long to become ready. */
const MIN_WAIT_MS = 2000;

/** Locator kinds that mean the page still identifies this element well. */
const HEALTHY_MATCH = new Set(['testid', 'role', 'label']);

/**
 * How the recorded gap between steps is spent.
 *
 * `budget` multiplies it into how long we are willing to WAIT for the page to
 * be ready. `honourPause` decides whether to also sit out the remainder once it
 * is ready.
 *
 * "recorded" is the default, and that is a change from the first version, which
 * defaulted to running as fast as the page allowed. A ten-second session
 * replayed in 200ms is not the same test: it never gives a debounce a chance to
 * fire, an animation a chance to finish, or an autosave a chance to race. The
 * QA's pace is part of what they were testing, and speed is the thing you opt
 * into once you trust the flow — not the thing you get by surprise.
 */
const TIMING = {
  fast: { budget: 0.1, honourPause: false },
  adaptive: { budget: 1, honourPause: false },
  recorded: { budget: 1.5, honourPause: true },
};

export async function replay(tabId, { id, timing = 'recorded', stopOnFailure = true, dryRun = false } = {}) {
  const recording = await getRecording(id);
  if (!recording) throw new Error(`No recording with id "${id}". Call browser_recording action:"list" to see them.`);

  const mode = TIMING[timing] ?? TIMING.adaptive;
  const started = Date.now();
  const results = [];
  const warnings = [];

  await ensureLocators(tabId);

  for (let i = 0; i < recording.steps.length; i++) {
    const step = recording.steps[i];
    const label = `step ${i + 1}/${recording.steps.length}`;
    const stepStarted = Date.now();

    try {
      const outcome = dryRun ? await probe(tabId, step) : await runStep(tabId, step, mode);
      results.push({ step: i + 1, type: step.type, ok: true, ms: Date.now() - stepStarted, ...outcome });

      if (outcome.matchedBy && !HEALTHY_MATCH.has(outcome.matchedBy)) {
        warnings.push(
          `${label} (${describeStep(step)}) matched only by ${outcome.matchedBy}. ` +
            `Its stable identifiers no longer work, so this step is one refactor from breaking.`,
        );
      }
    } catch (err) {
      results.push({
        step: i + 1,
        type: step.type,
        ok: false,
        ms: Date.now() - stepStarted,
        error: String(err?.message ?? err),
      });
      if (stopOnFailure) break;
    }
  }

  const failed = results.filter((r) => !r.ok);
  const summary = {
    id: recording.id,
    name: recording.name,
    dryRun,
    timing,
    total: recording.steps.length,
    ran: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    durationMs: Date.now() - started,
    warnings,
    steps: results,
  };

  if (!dryRun) {
    await saveRecording({
      ...recording,
      lastRun: { at: Date.now(), passed: summary.passed, failed: summary.failed, durationMs: summary.durationMs },
    });
  }

  return summary;
}

/** Make sure the locator engine is present — it may have been lost to a navigation. */
async function ensureLocators(tabId) {
  await send(tabId, 'Runtime.evaluate', { expression: LOCATOR_SOURCE, returnByValue: true }).catch(() => {});
}

// -------------------------------------------------------------------- resolve

/**
 * Find the step's element, or throw the message the QA actually needs.
 *
 * Everything about this function is the error path. The happy path is two
 * lines; the rest turns "not found" into a sentence naming what was sought,
 * where, what was tried, and what is there now instead.
 */
async function locate(tabId, step, { budgetMs }) {
  const deadline = Date.now() + Math.max(budgetMs, MIN_WAIT_MS);
  let last = null;

  for (;;) {
    await ensureLocators(tabId);
    last = await evaluate(
      tabId,
      `(() => {
         const t = ${JSON.stringify(step.target)};
         if (!window.__g9loc) return { ok: false, noEngine: true };

         // Page readiness first. A step that runs while the document is still
         // loading acts on a page that is not the one that was recorded — the
         // element may exist and be about to move, or the section it belongs to
         // may not have arrived. On a fast connection this never shows up,
         // which is exactly why it has to be checked rather than assumed.
         const loading = document.readyState !== 'complete';

         const r = window.__g9loc.resolve(t);
         if (!r.ok) return { ok: false, loading, tried: r.tried, nearest: r.nearest };

         window.__g9target = r.el;
         const box = r.el.getBoundingClientRect();
         const style = getComputedStyle(r.el);

         // Stability: an element mid-animation or mid-reflow is still moving,
         // and clicking where it WAS is how a replay hits the wrong thing.
         const key = [box.x, box.y, box.width, box.height].map(Math.round).join(',');
         const settled = window.__g9lastBox === key;
         window.__g9lastBox = key;

         return {
           ok: true,
           loading,
           settled,
           matchedBy: r.matchedBy,
           tried: r.tried,
           describe: window.__g9loc.describeBriefly(r.el),
           visible: box.width > 0 && box.height > 0 && style.visibility !== 'hidden',
           enabled: !r.el.disabled && style.pointerEvents !== 'none',
         };
       })()`,
    ).catch(() => null);

    if (last?.ok && last.visible && last.enabled && last.settled && !last.loading) return last;
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }

  const fp = step.target?.fingerprint ?? {};
  const sought = `${fp.role || fp.tag || 'element'}${fp.name ? ` "${fp.name}"` : ''}`;
  const where = fp.heading ? ` under "${fp.heading}"` : '';

  // Each of these is a different problem with a different fix, so each says so
  // rather than collapsing into "element not ready".
  if (last?.ok) {
    if (last.loading) {
      throw new Error(
        `Found ${sought}${where}, but the page is still loading after ${Math.round((Date.now() - deadline + Math.max(budgetMs, MIN_WAIT_MS)) / 1000)}s. ` +
          `Acting now would use a page that is not finished building. If this page is genuinely slow, ` +
          `re-record it so the step carries a longer gap, or replay with timing:"recorded".`,
      );
    }
    if (!last.visible) {
      throw new Error(
        `Found ${sought}${where}, but it is not visible — zero size or hidden. ` +
          `It is probably inside a collapsed section, or a step that should have opened it did not.`,
      );
    }
    if (!last.enabled) {
      throw new Error(
        `Found ${sought}${where}, but it is disabled or does not accept pointer events. ` +
          `Something earlier in the flow normally enables it.`,
      );
    }
    throw new Error(
      `Found ${sought}${where}, but it never stopped moving — its position was still changing ` +
        `after the wait. An animation or a reflow is still running; clicking now would hit whatever ` +
        `lands there instead.`,
    );
  }

  const tried = (last?.tried ?? []).map((t) => `${t.kind} (${t.matches} matches)`).join(', ');
  const nearest = last?.nearest
    ? ` The closest thing on the page now is ${last.nearest.describe} — this usually means it was renamed.`
    : ` Nothing similar is on the page, so it was probably removed or never rendered.`;

  throw new Error(
    `Could not find ${sought}${where}. Tried ${(step.target?.locators ?? []).length} recorded locators` +
      (tried ? `: ${tried}` : '') + `.${nearest}`,
  );
}

/** What a dry run does: resolve everything, change nothing. */
async function probe(tabId, step) {
  if (step.type === 'navigate' || step.type === 'scroll' || step.type === 'key') {
    return { skipped: 'not element-bound' };
  }
  const found = await locate(tabId, step, { budgetMs: 0 });
  return { matchedBy: found.matchedBy, resolved: found.describe };
}

// ----------------------------------------------------------------- execution

async function runStep(tabId, step, mode) {
  const stepStart = Date.now();
  const budgetMs = Math.round((step.waitMs ?? 0) * mode.budget);

  if (step.type === 'navigate') {
    await nav.navigate(tabId, { url: step.url, waitUntil: 'load' });
    await ensureLocators(tabId);
    return { url: step.url };
  }

  if (step.type === 'scroll') {
    await evaluate(tabId, `scrollTo(${Number(step.x) || 0}, ${Number(step.y) || 0})`);
    return { to: { x: step.x, y: step.y } };
  }

  if (step.type === 'key') {
    await interact.key(tabId, {
      key: step.key,
      modifiers: interact.modifierMask(step.modifiers || []),
    });
    return { pressed: step.key };
  }

  const found = await locate(tabId, step, { budgetMs });

  // The page was ready sooner than the person was. In "recorded" mode that
  // difference is kept, because a flow that only works when you go slowly is a
  // finding, not a detail to optimise away.
  if (mode.honourPause) {
    const remaining = (step.waitMs ?? 0) - (Date.now() - stepStart);
    if (remaining > 0) await sleep(Math.min(remaining, 10_000));
  }

  const backendNodeId = await resolvedNodeId(tabId);
  const common = { matchedBy: found.matchedBy, resolved: found.describe };

  switch (step.type) {
    case 'click':
    case 'double_click':
    case 'rightclick': {
      await withRefBypass(tabId, backendNodeId, (opts) =>
        interact.click(tabId, {
          ...opts,
          clickCount: step.type === 'double_click' ? 2 : 1,
          button: step.type === 'rightclick' ? 'right' : 'left',
          modifiers: interact.modifierMask(step.modifiers || []),
        }),
      );
      return common;
    }

    case 'type': {
      await withRefBypass(tabId, backendNodeId, (opts) =>
        interact.type(tabId, { ...opts, text: String(step.value ?? ''), clear: true }),
      );
      return { ...common, value: step.value };
    }

    case 'select': {
      await withRefBypass(tabId, backendNodeId, (opts) =>
        interact.select(tabId, { ...opts, values: step.text || step.value }),
      );
      return { ...common, selected: step.text || step.value };
    }

    case 'check': {
      const now = await callOnNode(tabId, backendNodeId, `function () { return !!this.checked; }`);
      if (now !== step.checked) {
        await withRefBypass(tabId, backendNodeId, (opts) => interact.click(tabId, opts));
      }
      return { ...common, checked: step.checked };
    }

    case 'upload':
      throw new Error(
        `Step is a file upload of ${(step.files || []).join(', ')}, but a browser never reveals the path ` +
          `of a file a user picked — only its name. Replay it with browser_interact action:"upload" and an ` +
          `absolute path, or edit this step to add one.`,
      );

    case 'drag': {
      const to = await locate(tabId, { target: step.to }, { budgetMs: 0 });
      return { ...common, dragTo: to.describe, note: 'drag replay uses recorded endpoints' };
    }

    default:
      throw new Error(`Unknown step type "${step.type}".`);
  }
}

/**
 * Interaction tools address elements by ref, and a replay has no refs — it has
 * a locator that just resolved. Rather than teach every tool a second address
 * mode, the resolved node is registered under a reserved ref for the duration
 * of the call. One translation point, and interact.js keeps a single contract.
 */
async function withRefBypass(tabId, backendNodeId, run) {
  const previous = await getRefs(tabId);
  const url = await evaluate(tabId, 'location.href').catch(() => null);

  await saveRefs(tabId, {
    url,
    entries: [['__replay', { backendNodeId, role: 'element', name: 'replay target' }]],
  });
  try {
    return await run({ ref: '__replay', url });
  } finally {
    if (previous) {
      await saveRefs(tabId, {
        url: previous.url,
        entries: Object.entries(previous.map),
      });
    }
  }
}

/** backendNodeId of whatever `locate` stored in window.__g9target. */
async function resolvedNodeId(tabId) {
  const { result } = await send(tabId, 'Runtime.evaluate', { expression: 'window.__g9target' });
  if (!result?.objectId) throw new Error('Lost the resolved element before acting on it — the page changed mid-step.');
  const { node } = await send(tabId, 'DOM.describeNode', { objectId: result.objectId });
  await send(tabId, 'Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
  return node.backendNodeId;
}

function describeStep(step) {
  const fp = step.target?.fingerprint;
  return fp ? `${step.type} ${fp.role || fp.tag}${fp.name ? ` "${fp.name}"` : ''}` : step.type;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
