/**
 * QA test primitives layered over recordings: assertions, metadata, variables,
 * visual baselines, and maintainable Playwright export.
 */

import { send, evaluate, callOnNode } from '../lib/cdp.js';
import { resolveRef } from '../lib/refs.js';
import { LOCATOR_SOURCE } from '../lib/locators.js';
import { getRecording, saveRecording, putAttachment } from '../lib/store.js';
import { screenshot } from './capture.js';
import {
  visualFingerprint, visualDifference, captureVisual, compareVisual, diffImage,
} from '../lib/visual.js';
import { snapshot } from './snapshot.js';
import { ariaLines, ariaDataKey } from '../lib/signature.js';
import { consoleLog, network } from './observe.js';
import { health } from './diagnose.js';

const ELEMENT_ASSERTIONS = new Set(['visible', 'value', 'state']);
const ASSERTIONS = new Set([
  'url', 'text', 'visible', 'value', 'state', 'network', 'console', 'a11y', 'screenshot', 'aria',
]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function addAssertion(tabId, args = {}) {
  const recording = await getRecording(args.id);
  if (!recording) throw new Error('No recording with id "' + args.id + '".');
  const assertion = args.assertion;
  if (!ASSERTIONS.has(assertion)) {
    throw new Error('Unknown assertion "' + assertion + '". Available: ' + [...ASSERTIONS].join(', ') + '.');
  }

  const step = {
    type: 'assert',
    assertion,
    operator: args.operator,
    expected: args.expected,
    contains: args.contains,
    absent: args.absent,
    state: args.state,
    status: args.status,
    method: args.method,
    minCount: args.minCount,
    maxCount: args.maxCount,
    maxViolations: args.maxViolations,
    threshold: args.threshold,
    level: args.level,
    waitMs: 0,
  };

  if (ELEMENT_ASSERTIONS.has(assertion)) {
    step.target = await describeTarget(tabId, args);
  }
  if (assertion === 'screenshot') {
    const shot = await screenshot(tabId, { area: 'viewport', format: 'png' });
    const captured = await captureVisual(shot.dataBase64, 'image/png');
    // The fingerprint stays inline under its historical key so a recording made
    // by an older build still replays, and the structure map rides alongside it.
    step.baseline = captured.fingerprint;
    step.baselineStructure = captured.structure;
    step.visualMode = args.visualMode ?? 'layout';
    step.masks = args.masks ?? undefined;
    step.threshold = args.threshold;
    // The bytes are evidence for a human, so they go to IndexedDB rather than
    // into the step: a recording with ten inline PNGs is deserialised in full
    // on every list, and nothing ever compares them anyway.
    const attachment = await putAttachment({
      owner: recording.id,
      name: `baseline-${(recording.steps?.length ?? 0) + 1}.png`,
      mime: 'image/png',
      kind: 'baseline',
      bytes: base64ToBytes(shot.dataBase64),
      meta: { role: 'expected', createdAt: Date.now() },
    });
    step.baselineImageId = attachment.id;
  }
  if (assertion === 'aria') {
    // A semantic baseline: roles, names and states, with refs stripped. It
    // survives restyling and copy-independent refactors, and fails on a button
    // that became a div or a heading that disappeared — which is the class of
    // regression a screenshot reports as "8% of pixels changed".
    const tree = await snapshot(tabId, { mode: 'a11y', maxNodes: args.maxNodes ?? 400 });
    step.ariaBaseline = ariaLines(tree.tree);
    step.maxNodes = args.maxNodes ?? 400;
    step.threshold = args.threshold;
  }

  // Where the assertion goes.
  //
  // Appending is right for a short flow, where the interesting state IS the
  // final one. It is wrong for a long one: "search, then assert it filtered,
  // then clear, then assert it came back" needs three checks at three different
  // moments, and appending all of them describes the last moment three times.
  // That is not a stricter test, it is a weaker one that looks thorough.
  //
  // `atStep` inserts AFTER that step number, 1-based, matching what the
  // recorder's outline prints. Out of range is refused rather than clamped: a
  // silently relocated assertion checks the wrong thing and still passes.
  const existing = [...(recording.steps ?? [])];
  const at = args.atStep;
  if (at != null) {
    const position = Number(at);
    if (!Number.isInteger(position) || position < 1 || position > existing.length) {
      throw new Error(
        `atStep ${at} is outside this recording, which has ${existing.length} step(s). ` +
          `Use the numbers from the outline, or omit atStep to append at the end.`,
      );
    }
    existing.splice(position, 0, compact(step));
  } else {
    existing.push(compact(step));
  }
  const steps = existing;
  const saved = await saveRecording({ ...recording, steps });
  return {
    id: saved.id,
    step: at != null ? Number(at) + 1 : steps.length,
    assertion,
    summary: summarizeAssertion(step),
  };
}

/**
 * Propose assertions for a recording that has just been stopped.
 *
 * ## Why a wizard rather than "write assertions yourself"
 *
 * A recorded flow with no assertion is a macro: it proves the steps could be performed, never that
 * they did anything. That is the single most common way a recorded suite becomes worthless — it
 * goes green for months while the feature underneath is broken.
 *
 * Asking a QA to hand-write oracles does not fix it either, because the useful oracles are the ones
 * they cannot see: which request fired, what the console said, what the semantic tree looked like
 * afterwards. The tool watched all of that; it should be the one to offer it.
 *
 * ## Proposals, never additions
 *
 * Nothing here writes to the recording. It returns candidates with a `why`, and a human picks. That
 * is deliberate and matches the rule the rest of this system runs on: the research on
 * LLM-generated oracles is blunt about the failure mode — the common defect is not a WRONG
 * assertion but a WEAK one, which passes forever and catches nothing. A weak assertion that a
 * person consciously accepted is a decision; one that a tool added quietly is a blind spot.
 *
 * ## Why the suggestions are what they are
 *
 * - **URL** — the cheapest possible proof that the flow ended where it was supposed to.
 * - **Network** — the operation the flow actually performed. This is the oracle that survives a
 *   complete redesign of the page, because it asserts the business effect rather than the pixels.
 * - **Console absence** — free, and the one assertion that catches damage the flow did not intend.
 * - **Aria snapshot** — structure, so a control that disappears fails even though nothing else
 *   changed. Offered only when the tree is small enough to be a stable baseline rather than a
 *   snapshot of the whole world.
 * - **Text** — offered LAST and marked weak, because copy changes and it is the assertion people
 *   reach for first precisely because it is the easiest to write.
 */
export async function suggestAssertions(tabId, id) {
  const recording = await getRecording(id);
  if (!recording) throw new Error('No recording with id "' + id + '".');

  const existing = new Set((recording.steps ?? []).filter((step) => step.type === 'assert').map((step) => step.assertion));
  const suggestions = [];

  const url = await evaluate(tabId, 'location.href').catch(() => null);
  if (url && !existing.has('url')) {
    let pathOnly = url;
    try { pathOnly = new URL(url).pathname; } catch { /* keep the whole thing */ }
    suggestions.push({
      assertion: 'url',
      operator: 'contains',
      expected: pathOnly,
      strength: 'strong',
      why: 'The flow ends here. If a later build routes somewhere else, every other assertion would still pass.',
    });
  }

  // The operations this flow actually performed. Failed ones are excluded on purpose: asserting
  // that a request 500s locks in the bug.
  const net = await network(tabId, { limit: 200 }).catch(() => null);
  const successful = (net?.requests ?? []).filter(
    (request) => typeof request.status === 'number' && request.status >= 200 && request.status < 400
      && /xhr|fetch/i.test(request.type ?? ''),
  );
  if (successful.length && !existing.has('network')) {
    const chosen = successful[0];
    let operation = chosen.url;
    try { operation = new URL(chosen.url).pathname; } catch { /* keep the whole thing */ }
    suggestions.push({
      assertion: 'network',
      contains: operation,
      method: chosen.method,
      minCount: 1,
      strength: 'strong',
      why: `The flow performed ${chosen.method} ${operation}. This asserts the business effect, so it survives a redesign of the page.`,
    });
  }

  const logs = await consoleLog(tabId, { level: ['error'], limit: 5 }).catch(() => null);
  if (!existing.has('console')) {
    suggestions.push({
      assertion: 'console',
      level: ['error'],
      absent: true,
      strength: (logs?.returned ?? 0) === 0 ? 'strong' : 'blocked',
      why: (logs?.returned ?? 0) === 0
        ? 'The page is currently error-free, so this assertion is safe to add and costs nothing to check.'
        : `The page ALREADY has ${logs.returned} console error(s), so this would fail immediately. Fix or investigate them before adding it.`,
    });
  }

  const tree = await snapshot(tabId, { mode: 'a11y', maxNodes: 400 }).catch(() => null);
  const nodes = tree ? ariaLines(tree.tree).length : 0;
  if (nodes && !existing.has('aria')) {
    suggestions.push({
      assertion: 'aria',
      maxNodes: 400,
      strength: nodes <= 250 ? 'strong' : 'noisy',
      why: nodes <= 250
        ? `${nodes} semantic nodes — small enough to be a stable structural baseline.`
        : `${nodes} semantic nodes is a lot; expect churn. Consider asserting a smaller screen, or accept that this will need re-approval often.`,
    });
  }

  if (!existing.has('text')) {
    suggestions.push({
      assertion: 'text',
      contains: '',
      strength: 'weak',
      why: 'Offered last on purpose: text is the easiest assertion to write and the first to break on a copy edit. Prefer the network or aria suggestions above.',
    });
  }

  return {
    id,
    pageUrl: url,
    existingAssertions: [...existing],
    suggestions,
    note: 'Nothing was added. Pass one of these back through action:"assert" to accept it — a weak assertion somebody chose is a decision; one a tool added quietly is a blind spot.',
  };
}

export async function updateRecording(id, patch = {}) {
  const recording = await getRecording(id);
  if (!recording) throw new Error('No recording with id "' + id + '".');
  const next = { ...recording };
  for (const key of ['name', 'suite', 'folder', 'tags', 'environment', 'parameters']) {
    if (key in patch) next[key] = patch[key];
  }
  return saveRecording(next);
}

async function describeTarget(tabId, { ref, selector }) {
  await send(tabId, 'Runtime.evaluate', { expression: LOCATOR_SOURCE, returnByValue: true });
  let backendNodeId;
  if (ref) {
    backendNodeId = (await resolveRef(tabId, ref)).backendNodeId;
  } else if (selector) {
    const { root } = await send(tabId, 'DOM.getDocument', { depth: 0 });
    const found = await send(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!found.nodeId) throw new Error('No element matches selector "' + selector + '".');
    const { node } = await send(tabId, 'DOM.describeNode', { nodeId: found.nodeId });
    backendNodeId = node.backendNodeId;
  } else {
    throw new Error('This assertion needs ref or selector.');
  }
  const target = await callOnNode(
    tabId,
    backendNodeId,
    `function () { return window.__g9loc && window.__g9loc.describe(this); }`,
  );
  if (!target) throw new Error('Could not build durable locators for the assertion target.');
  return target;
}

export async function executeAssertion(tabId, rawStep, variables = {}) {
  const step = substitute(rawStep, variables);
  switch (step.assertion) {
    case 'url': {
      const actual = await evaluate(tabId, 'location.href');
      compareText(actual, step.expected ?? step.contains, step.operator ?? (step.contains != null ? 'contains' : 'exact'), 'URL');
      return { assertion: 'url', actual };
    }
    case 'text': {
      const actual = await evaluate(tabId, 'document.body ? document.body.innerText : ""');
      const expected = step.expected ?? step.contains ?? '';
      const operator = step.absent ? 'absent' : (step.operator ?? 'contains');
      compareText(actual, expected, operator, 'page text');
      return { assertion: 'text', matched: expected };
    }
    case 'visible':
    case 'value':
    case 'state':
      return executeElementAssertion(tabId, step);
    case 'network': {
      const result = await network(tabId, {
        filter: step.contains,
        status: step.status,
        method: step.method,
        limit: 400,
      });
      assertCount('network requests', result.returned, step.minCount ?? 1, step.maxCount);
      return { assertion: 'network', count: result.returned, failedCount: result.failedCount };
    }
    case 'console': {
      const result = await consoleLog(tabId, {
        level: step.level ?? ['error'],
        contains: step.contains,
        limit: 500,
      });
      const max = step.absent ? 0 : step.maxCount;
      assertCount('console entries', result.returned, step.absent ? 0 : (step.minCount ?? 1), max);
      return { assertion: 'console', count: result.returned };
    }
    case 'a11y': {
      const result = await health(tabId);
      // Findings are context-capped; the summary is the uncapped audit count.
      // Counting the returned slice could let a noisy page pass by omission.
      const count = result.summary?.accessibilityIssues ?? 0;
      const max = step.maxViolations ?? 0;
      if (count > max) throw new Error('Accessibility assertion failed: ' + count + ' actionable findings; maximum is ' + max + '.');
      return { assertion: 'a11y', violations: count, maximum: max };
    }
    case 'screenshot': {
      const shot = await screenshot(tabId, { area: 'viewport', format: 'png' });
      const mode = step.visualMode ?? (step.baselineStructure ? 'layout' : 'strict');
      const current = mode === 'layout'
        ? await captureVisual(shot.dataBase64, 'image/png')
        : { fingerprint: await visualFingerprint(shot.dataBase64, 'image/png') };
      const baseline = { fingerprint: step.baseline, structure: step.baselineStructure };

      const comparison = compareVisual(baseline, current, {
        mode,
        masks: step.masks ?? [],
        threshold: step.threshold,
      });

      if (!comparison.pass) {
        // The diff image is written before the throw, so the evidence exists
        // for the run that failed rather than for a retry that may pass.
        let evidenceId = null;
        try {
          const png = await diffImage(shot.dataBase64, comparison);
          if (png && step.recordingId) {
            const attachment = await putAttachment({
              owner: step.recordingId,
              name: 'visual-diff.png',
              mime: 'image/png',
              kind: 'diff',
              bytes: base64ToBytes(png),
              meta: { role: 'diff', mode, at: Date.now() },
            });
            evidenceId = attachment.id;
          }
        } catch {
          /* evidence is best-effort; the failure below is the finding */
        }
        throw new Error(
          'Visual assertion failed (' + mode + '): difference ' + round(comparison.difference) +
          ' exceeds threshold ' + comparison.threshold +
          (comparison.maskedCells ? ' — ' + comparison.maskedCells + ' cells masked' : '') +
          (evidenceId ? ' — diff image attachment ' + evidenceId : '') + '.',
        );
      }
      return { assertion: 'screenshot', ...comparison };
    }
    case 'aria': {
      const tree = await snapshot(tabId, { mode: 'a11y', maxNodes: step.maxNodes ?? 400 });
      const current = ariaLines(tree.tree);
      const expected = step.ariaBaseline ?? [];
      const currentSet = new Set(current);
      const expectedSet = new Set(expected);
      const { missing, added, dataChanges } = separateDataChurn(
        expected.filter((line) => !currentSet.has(line)),
        current.filter((line) => !expectedSet.has(line)),
      );
      // A tolerance exists because real pages carry a little churn (a live
      // counter in an aria-label, a row count). It defaults to zero: a semantic
      // tree that is allowed to drift is not a baseline.
      const allowed = Math.max(0, Math.round((step.threshold ?? 0) * Math.max(expected.length, 1)));
      if (missing.length + added.length > allowed) {
        throw new Error(
          'Semantic (aria) assertion failed: ' + missing.length + ' node(s) gone, ' + added.length + ' new. ' +
          (missing.length ? 'Gone: ' + missing.slice(0, 4).map(readableNode).join(' | ') + '. ' : '') +
          (added.length ? 'New: ' + added.slice(0, 4).map(readableNode).join(' | ') + '.' : '') +
          (dataChanges.length
            ? ' (' + dataChanges.length + ' further node(s) changed only in their numbers and were not counted.)'
            : ''),
        );
      }
      return {
        assertion: 'aria',
        nodes: current.length,
        missing: missing.length,
        added: added.length,
        allowed,
        // Reported, never hidden: the run passed, and the reader still gets to
        // see that a hundred rows came back with different readings.
        dataChanges: dataChanges.length,
        dataSample: dataChanges.slice(0, 3).map((change) => readableNode(change.now)),
      };
    }
    default:
      throw new Error('Unknown assertion "' + step.assertion + '".');
  }
}

/**
 * Tell "this row now reads 4 degrees instead of 5" apart from "this row is gone".
 *
 * A line that vanished and a line that appeared are paired off as the same node
 * carrying new data only when BOTH hold:
 *
 *   1. they are identical once their numbers are masked out, and
 *   2. that masked shape lost exactly as many lines as it gained.
 *
 * The second condition is the one that matters. On a list of sites called NL1,
 * NL2, NL3 every row masks to the same shape, so rule 1 alone would shrug at a
 * search box that stopped filtering — the very thing the flow exists to catch.
 * Requiring the count to balance means a set that GREW or SHRANK is always a
 * structural change, and only a one-for-one swap can be data.
 *
 * Anything paired off is returned, not discarded, because a passing assertion
 * that quietly ignored a hundred nodes is not a passing assertion.
 */
function separateDataChurn(missing, added) {
  if (!missing.length || !added.length) return { missing, added, dataChanges: [] };

  const group = (lines) => {
    const map = new Map();
    for (const line of lines) {
      const key = ariaDataKey(line);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(line);
    }
    return map;
  };
  const goneBy = group(missing);
  const newBy = group(added);

  const dataChanges = [];
  const paired = new Set();
  for (const [key, gone] of goneBy) {
    const fresh = newBy.get(key);
    if (!fresh || fresh.length !== gone.length) continue;
    paired.add(key);
    for (let i = 0; i < gone.length; i += 1) dataChanges.push({ was: gone[i], now: fresh[i] });
  }
  if (!paired.size) return { missing, added, dataChanges };

  const survives = (line) => !paired.has(ariaDataKey(line));
  return { missing: missing.filter(survives), added: added.filter(survives), dataChanges };
}

async function executeElementAssertion(tabId, step) {
  const deadline = Date.now() + 3000;
  let resolved;
  while (Date.now() < deadline) {
    await send(tabId, 'Runtime.evaluate', { expression: LOCATOR_SOURCE, returnByValue: true }).catch(() => {});
    resolved = await evaluate(
      tabId,
      `(() => {
        const result = window.__g9loc && window.__g9loc.resolve(` + JSON.stringify(step.target) +
          `, { includeHidden: ` + JSON.stringify(step.assertion === 'visible') + ` });
        if (!result || !result.ok) return { ok: false };
        const el = result.el;
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const states = {
          checked: !!el.checked,
          selected: !!el.selected,
          disabled: !!el.disabled,
          enabled: !el.disabled,
          expanded: el.getAttribute('aria-expanded') === 'true',
          pressed: el.getAttribute('aria-pressed') === 'true',
          focused: document.activeElement === el,
          readonly: !!el.readOnly || el.getAttribute('aria-readonly') === 'true',
        };
        return {
          ok: true,
          matchedBy: result.matchedBy,
          visible: box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
          value: el.value != null ? String(el.value) : String(el.textContent || '').trim(),
          states,
        };
      })()`,
    ).catch(() => null);
    if (resolved?.ok) break;
    await sleep(120);
  }
  if (!resolved?.ok) throw new Error('Assertion target could not be resolved from its recorded locators.');

  if (step.assertion === 'visible') {
    const expected = step.expected == null ? true : !!step.expected;
    if (resolved.visible !== expected) throw new Error('Visibility is ' + resolved.visible + '; expected ' + expected + '.');
    return { assertion: 'visible', actual: resolved.visible, matchedBy: resolved.matchedBy };
  }
  if (step.assertion === 'value') {
    compareText(resolved.value, step.expected ?? step.contains ?? '', step.operator ?? (step.contains != null ? 'contains' : 'exact'), 'element value');
    return { assertion: 'value', actual: resolved.value, matchedBy: resolved.matchedBy };
  }
  const state = step.state;
  if (!state || !(state in resolved.states)) throw new Error('Unsupported element state "' + state + '".');
  const expected = step.expected == null ? true : !!step.expected;
  if (resolved.states[state] !== expected) {
    throw new Error('Element state "' + state + '" is ' + resolved.states[state] + '; expected ' + expected + '.');
  }
  return { assertion: 'state', state, actual: resolved.states[state], matchedBy: resolved.matchedBy };
}

function compareText(actualValue, expectedValue, operator, label) {
  const actual = String(actualValue ?? '');
  const expected = String(expectedValue ?? '');
  const pass = operator === 'contains' ? actual.includes(expected)
    : operator === 'absent' ? !actual.includes(expected)
      : operator === 'matches' ? new RegExp(expected).test(actual)
        : actual === expected;
  if (!pass) {
    throw new Error(label + ' assertion failed (' + operator + '): expected ' + JSON.stringify(expected) +
      ', actual ' + JSON.stringify(actual.slice(0, 500)) + '.');
  }
}

function assertCount(label, count, min, max) {
  if (count < min || (max != null && count > max)) {
    throw new Error(label + ' assertion failed: found ' + count + ', expected ' +
      (max == null ? 'at least ' + min : min + '..' + max) + '.');
  }
}

export function substitute(value, variables) {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{([A-Za-z_][A-Za-z0-9_.-]*)\}\}$/);
    if (exact) {
      if (!(exact[1] in variables)) {
        throw new Error('Missing data parameter "' + exact[1] + '" required by ' + JSON.stringify(value) + '.');
      }
      return variables[exact[1]];
    }
    return value.replace(/\{\{([A-Za-z_][A-Za-z0-9_.-]*)\}\}/g, (whole, key) => {
      if (!(key in variables)) throw new Error('Missing data parameter "' + key + '" required by ' + JSON.stringify(value) + '.');
      return String(variables[key]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, variables)]));
  }
  return value;
}

export function summarizeAssertion(step) {
  const target = step.target?.fingerprint?.name;
  return 'assert ' + step.assertion + (target ? ' on "' + target + '"' : '');
}

export async function exportPlaywright(id) {
  const recording = await getRecording(id);
  if (!recording) throw new Error('No recording with id "' + id + '".');
  const lines = [
    `import { test, expect } from '@playwright/test';`,
    '',
    'test(' + JSON.stringify(recording.name ?? 'G9 recording') + ', async ({ page }) => {',
  ];
  for (const step of recording.steps ?? []) {
    const locator = step.target ? playwrightLocator(step.target) : null;
    switch (step.type) {
      case 'navigate': lines.push('  await page.goto(' + JSON.stringify(step.url) + ');'); break;
      case 'click': lines.push('  await ' + locator + '.click();'); break;
      case 'double_click': lines.push('  await ' + locator + '.dblclick();'); break;
      case 'rightclick': lines.push('  await ' + locator + '.click({ button: "right" });'); break;
      case 'type': lines.push('  await ' + locator + '.fill(' + JSON.stringify(String(step.value ?? '')) + ');'); break;
      case 'select': {
        if (step.values?.length) {
          lines.push('  await ' + locator + '.selectOption(' + JSON.stringify(step.values) + ');');
        } else if (step.texts?.length) {
          lines.push('  await ' + locator + '.selectOption(' + JSON.stringify(step.texts.map((label) => ({ label }))) + ');');
        } else {
          lines.push('  await ' + locator + '.selectOption({ label: ' + JSON.stringify(step.text || step.value) + ' });');
        }
        break;
      }
      case 'check': lines.push('  await ' + locator + '.' + (step.checked ? 'check' : 'uncheck') + '();'); break;
      case 'key': lines.push('  await ' + (locator ? locator + '.press' : 'page.keyboard.press') + '(' + JSON.stringify([...step.modifiers ?? [], step.key].join('+')) + ');'); break;
      case 'drag': lines.push('  await ' + locator + '.dragTo(' + playwrightLocator(step.to) + ');'); break;
      case 'scroll': lines.push('  await page.evaluate(() => scrollTo(' + (Number(step.x) || 0) + ', ' + (Number(step.y) || 0) + '));'); break;
      case 'assert': lines.push(...playwrightAssertion(step, locator)); break;
      default: lines.push('  // Unsupported G9 step: ' + JSON.stringify(step.type));
    }
  }
  lines.push('});', '');
  return { id, language: 'javascript', framework: '@playwright/test', code: lines.join('\n') };
}

function playwrightLocator(target) {
  const locators = target?.locators ?? [];
  const testid = locators.find((item) => item.kind === 'testid');
  if (testid?.attr === 'data-testid' || (testid && !testid.attr)) {
    return 'page.getByTestId(' + JSON.stringify(testid.value) + ')';
  }
  if (testid) {
    return 'page.locator(' + JSON.stringify('[' + testid.attr + '=' + JSON.stringify(testid.value) + ']') + ')';
  }
  const role = locators.find((item) => item.kind === 'role');
  if (role) return 'page.getByRole(' + JSON.stringify(role.role) + ', { name: ' + JSON.stringify(role.name) + ' })';
  const label = locators.find((item) => item.kind === 'label');
  if (label) return 'page.getByLabel(' + JSON.stringify(label.label) + ')';
  const text = locators.find((item) => item.kind === 'text');
  if (text) return 'page.getByText(' + JSON.stringify(text.text) + ', { exact: true })';
  const css = locators.find((item) => item.kind === 'css');
  if (css) return 'page.locator(' + JSON.stringify(css.css) + ')';
  const xpath = locators.find((item) => item.kind === 'xpath');
  return 'page.locator(' + JSON.stringify(xpath?.xpath ?? '*') + ')';
}

function playwrightAssertion(step, locator) {
  switch (step.assertion) {
    case 'url': {
      const value = step.expected ?? step.contains;
      const operator = step.operator ?? (step.contains != null ? 'contains' : 'exact');
      return operator === 'exact'
        ? ['  await expect(page).toHaveURL(' + JSON.stringify(value) + ');']
        : ['  await expect(page).toHaveURL(new RegExp(' + JSON.stringify(String(value ?? '')) + '));'];
    }
    case 'text': return ['  await expect(page.locator("body")).' + (step.absent ? 'not.' : '') + 'toContainText(' + JSON.stringify(step.expected ?? step.contains) + ');'];
    case 'visible': return ['  await expect(' + locator + ').' + (step.expected === false ? 'not.' : '') + 'toBeVisible();'];
    case 'value': return ['  await expect(' + locator + ').toHaveValue(' + JSON.stringify(step.expected ?? step.contains) + ');'];
    case 'state':
      if (step.state === 'checked') return ['  await expect(' + locator + ').' + (step.expected === false ? 'not.' : '') + 'toBeChecked();'];
      if (step.state === 'disabled') return ['  await expect(' + locator + ').' + (step.expected === false ? 'not.' : '') + 'toBeDisabled();'];
      return ['  // G9 state assertion: ' + step.state + ' === ' + JSON.stringify(step.expected ?? true)];
    case 'screenshot': return ['  await expect(page).toHaveScreenshot({ maxDiffPixelRatio: ' + (step.threshold ?? 0.08) + ' });'];
    case 'aria': {
      // Playwright's own semantic snapshot. The G9 baseline is a normalised
      // line list rather than Playwright's YAML, so the export writes the
      // assertion and lets Playwright own the snapshot file — round-tripping
      // our normalisation into their format would produce a snapshot that
      // never matches and a test nobody trusts.
      return [
        '  // G9 captured ' + (step.ariaBaseline?.length ?? 0) + ' semantic nodes here.',
        '  // Run once with --update-snapshots to let Playwright write its own baseline.',
        '  await expect(page).toMatchAriaSnapshot();',
      ];
    }
    default: return ['  // G9 ' + step.assertion + ' assertion uses captured browser evidence; translate for your test fixtures.'];
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/** `2|button "ذخیره"` → `button "ذخیره"` — depth is for diffing, not for reading. */
function readableNode(line) {
  return String(line).replace(/^\d+\|/, '');
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const round = (value) => Math.round(value * 10000) / 10000;
