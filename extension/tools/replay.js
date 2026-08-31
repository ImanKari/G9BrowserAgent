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

/** Locator kinds that mean the page still identifies this element well. */
const HEALTHY_MATCH = new Set(['testid', 'role', 'label']);

const TIMING = {
  fast: { budget: 0, floor: 0 },
  adaptive: { budget: 1, floor: 0 },
  recorded: { budget: 1, floor: 1 },
};

export async function replay(tabId, { id, timing = 'adaptive', stopOnFailure = true, dryRun = false } = {}) {
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
  const deadline = Date.now() + Math.max(budgetMs, 1500);
  let last = null;

  for (;;) {
    await ensureLocators(tabId);
    last = await evaluate(
      tabId,
      `(() => {
         const t = ${JSON.stringify(step.target)};
         if (!window.__g9loc) return { ok: false, noEngine: true };
         const r = window.__g9loc.resolve(t);
         if (!r.ok) return { ok: false, tried: r.tried, nearest: r.nearest };
         window.__g9target = r.el;
         const box = r.el.getBoundingClientRect();
         return {
           ok: true,
           matchedBy: r.matchedBy,
           tried: r.tried,
           describe: window.__g9loc.describeBriefly(r.el),
           actionable: box.width > 0 && box.height > 0,
         };
       })()`,
    ).catch(() => null);

    if (last?.ok && last.actionable) return last;
    if (Date.now() >= deadline) break;
    await sleep(120);
  }

  const fp = step.target?.fingerprint ?? {};
  const sought = `${fp.role || fp.tag || 'element'}${fp.name ? ` "${fp.name}"` : ''}`;
  const where = fp.heading ? ` under "${fp.heading}"` : '';

  if (last?.ok && !last.actionable) {
    throw new Error(
      `Found ${sought}${where}, but it is not visible or has zero size, so it cannot be used. ` +
        `Something is probably still loading, or it is inside a collapsed section.`,
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
