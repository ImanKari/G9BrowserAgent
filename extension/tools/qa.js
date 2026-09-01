/**
 * QA test primitives layered over recordings: assertions, metadata, variables,
 * visual baselines, and maintainable Playwright export.
 */

import { send, evaluate, callOnNode } from '../lib/cdp.js';
import { resolveRef } from '../lib/refs.js';
import { LOCATOR_SOURCE } from '../lib/locators.js';
import { getRecording, saveRecording } from '../lib/store.js';
import { screenshot } from './capture.js';
import { visualFingerprint, visualDifference } from '../lib/visual.js';
import { consoleLog, network } from './observe.js';
import { health } from './diagnose.js';

const ELEMENT_ASSERTIONS = new Set(['visible', 'value', 'state']);
const ASSERTIONS = new Set(['url', 'text', 'visible', 'value', 'state', 'network', 'console', 'a11y', 'screenshot']);
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
    step.baseline = await visualFingerprint(shot.dataBase64, 'image/png');
    step.threshold = args.threshold ?? 0.08;
  }

  const steps = [...(recording.steps ?? []), compact(step)];
  const saved = await saveRecording({ ...recording, steps });
  return {
    id: saved.id,
    step: steps.length,
    assertion,
    summary: summarizeAssertion(step),
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
      const current = await visualFingerprint(shot.dataBase64, 'image/png');
      const diff = visualDifference(step.baseline, current);
      const threshold = step.threshold ?? 0.08;
      if (diff.difference > threshold) {
        throw new Error(
          'Visual assertion failed: difference ' + round(diff.difference) +
          ' exceeds threshold ' + threshold + ' (' + round(diff.changedRatio) + ' of blocks materially changed).',
        );
      }
      return { assertion: 'screenshot', ...diff, threshold };
    }
    default:
      throw new Error('Unknown assertion "' + step.assertion + '".');
  }
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
    default: return ['  // G9 ' + step.assertion + ' assertion uses captured browser evidence; translate for your test fixtures.'];
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

const round = (value) => Math.round(value * 10000) / 10000;
