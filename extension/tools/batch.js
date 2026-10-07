/**
 * (3.4) `browser_recording action:"batch"`: a list of steps in ONE call.
 *
 * A long job in a real app is dozens of small steps — open, click, type, wait, read — and as
 * separate tool calls each one costs a round trip and re-sends the conversation. A batch runs them
 * here, in the engine, one after another, and answers once with a compact line per step. It stops
 * at the first failure and returns, with the error, an excerpt of the page around what failed (the
 * same-role elements when a role+name matched nothing), so the agent can fix the step without
 * another snapshot round trip.
 *
 * Steps (every string field may use `{{name}}` for a value an earlier step saved with `saveAs`):
 * - `{ action:"navigate", url, waitUntil?, timeoutMs? }`
 * - `{ action:"click"|"double_click"|"right_click"|"hover"|"type"|"key"|"select"|"scroll", ref | role+name (+nth), …the browser_interact options }`
 * - `{ action:"wait", text | selector | predicate | ref+state | idle, timeoutMs? }` (browser_navigate wait)
 * - `{ action:"evaluate", expression, timeoutMs?, saveAs? }` (the page's main world, like browser_console)
 * - `{ action:"extract", ref | selector | role+name, saveAs? }` → the element's visible text
 * Input is the same trusted, humanized input as browser_interact, with its delivery checks.
 */

import { evaluate as evaluateInPage } from '../lib/cdp.js';
import { inWorld, callInWorld } from '../lib/world.js';
import { resolveRef } from '../lib/refs.js';
import { callSignalFor } from '../lib/humanize.js';
import * as interact from './interact.js';
import * as nav from './navigate.js';
import { snapshot, find } from './snapshot.js';

export const MAX_STEPS = 200;
const INTERACT = new Set(['click', 'double_click', 'right_click', 'hover', 'type', 'key', 'select', 'scroll']);
const ACTIONS = new Set(['navigate', 'wait', 'evaluate', 'extract', ...INTERACT]);
const VALUE_MAX = 2_000;

/** `{{name}}` → the saved value, in every string of a step (unknown names are left as they are). */
export function substitute(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (all, key) => (key in vars ? String(vars[key]) : all));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, vars);
    return out;
  }
  return value;
}

/** Check a step list before anything runs: a typo in step 9 must not surface after steps 1–8 acted. */
export function validateSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('action:"batch" needs steps: a non-empty list.');
  if (steps.length > MAX_STEPS) throw new Error(`action:"batch" takes at most ${MAX_STEPS} steps (got ${steps.length}).`);
  steps.forEach((step, i) => {
    const at = `step ${i + 1}`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`${at} is not an object.`);
    if (!ACTIONS.has(step.action)) throw new Error(`${at}: unknown action ${JSON.stringify(step.action)}. Known: ${[...ACTIONS].join(', ')}.`);
    if (step.action === 'navigate' && !step.url) throw new Error(`${at}: navigate needs a url.`);
    if (step.action === 'evaluate' && !step.expression) throw new Error(`${at}: evaluate needs an expression.`);
    if (step.action === 'type' && step.text == null) throw new Error(`${at}: type needs text.`);
    if (step.action === 'key' && !step.key) throw new Error(`${at}: key needs a key.`);
    if (step.action === 'extract' && !step.ref && !step.selector && !step.role) throw new Error(`${at}: extract needs ref, selector or role (+ name).`);
    if (['click', 'double_click', 'right_click', 'hover', 'type', 'select'].includes(step.action) && !step.ref && !step.role && step.x == null) {
      throw new Error(`${at}: ${step.action} needs a ref, or role (+ name).`);
    }
    if (step.saveAs != null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(step.saveAs))) throw new Error(`${at}: saveAs must be an identifier.`);
  });
}

function bounded(value) {
  if (value === undefined) return '(undefined)';
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  if (text == null) return String(value);
  return text.length <= VALUE_MAX ? value : `${text.slice(0, VALUE_MAX)}… (${text.length} chars)`;
}

const pageUrl = (tabId) => inWorld(tabId, 'location.href').catch(() => null);

/**
 * A role (+ name regex) to ONE ref. Several matches are refused with the list (pass nth, or a
 * stricter name) — guessing the first is how a step clicks the wrong "Delete".
 */
async function refByRole(tabId, step, caller) {
  const found = await find(tabId, { roles: [step.role], name: step.name ?? null, limit: 30 }, caller);
  const lines = found.tree === '(no match)' ? [] : found.tree.split('\n');
  const refs = lines.map((l) => /\[ref=(e\d+)\]/.exec(l)?.[1]).filter(Boolean);
  const label = `role ${JSON.stringify(step.role)}${step.name != null ? ` name /${step.name}/i` : ''}`;
  if (!refs.length) {
    const err = new Error(`No element with ${label} on the page.`);
    err.lookedFor = { role: step.role };
    throw err;
  }
  if (step.nth != null) {
    const n = Number(step.nth);
    if (!(n >= 1 && n <= refs.length)) throw new Error(`${label} matched ${refs.length}; nth ${step.nth} is out of range.`);
    return refs[n - 1];
  }
  if (refs.length > 1) {
    const err = new Error(`${label} matched ${refs.length} elements: ${lines.slice(0, 8).join(' | ')}. Pass nth (1-based) or a stricter name.`);
    err.lookedFor = { role: step.role, name: step.name };
    throw err;
  }
  return refs[0];
}

async function extractText(tabId, step, caller, url) {
  const read = `function () {
      const tag = (this.tagName || '').toLowerCase();
      if ((tag === 'input' || tag === 'textarea' || tag === 'select') && this.value != null) return String(this.value);
      return String(this.innerText || this.textContent || '').replace(/\\s+/g, ' ').trim();
    }`;
  if (step.selector) {
    const text = await inWorld(tabId, `(() => {
        const el = document.querySelector(${JSON.stringify(String(step.selector))});
        if (!el) return { missing: true };
        const tag = (el.tagName || '').toLowerCase();
        if ((tag === 'input' || tag === 'textarea' || tag === 'select') && el.value != null) return { text: String(el.value) };
        return { text: String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() };
      })()`);
    if (text?.missing) throw new Error(`extract: the selector ${JSON.stringify(step.selector)} matched nothing.`);
    return text.text;
  }
  const ref = step.ref ?? (await refByRole(tabId, step, caller));
  const node = await resolveRef(tabId, ref, url);
  return callInWorld(tabId, node.backendNodeId, read, [], node.sessionId ?? null);
}

async function runOne(tabId, step, ctx) {
  const { caller, vars } = ctx;
  const out = {};
  switch (step.action) {
    case 'navigate': {
      const r = await nav.navigate(tabId, { url: step.url, waitUntil: step.waitUntil ?? 'load', timeoutMs: step.timeoutMs ?? 30_000, humanize: step.humanize ?? ctx.humanize });
      out.url = r.url;
      if (r.timedOut) out.timedOut = true;
      return out;
    }
    case 'wait': {
      const r = await nav.waitFor(tabId, { ...step, url: await pageUrl(tabId) });
      out.waitedMs = r.waitedMs ?? r.quietForMs ?? null;
      if (r.value !== undefined) out.value = r.value;
      if (step.saveAs && r.value !== undefined) vars[step.saveAs] = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
      return out;
    }
    case 'evaluate': {
      const value = await evaluateInPage(tabId, String(step.expression), { timeoutMs: Math.max(1_000, Math.min(4 * 60 * 60_000, Number(step.timeoutMs) || 30_000)) });
      out.value = bounded(value);
      if (step.saveAs) vars[step.saveAs] = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      return out;
    }
    case 'extract': {
      const text = await extractText(tabId, step, caller, await pageUrl(tabId));
      out.value = bounded(text);
      if (step.saveAs) vars[step.saveAs] = text;
      return out;
    }
    default: {
      // Input: browser_interact, by ref or by role+name.
      const url = await pageUrl(tabId);
      const ref = step.ref ?? (step.role ? await refByRole(tabId, step, caller) : undefined);
      if (ref) out.ref = ref;
      const a = { ...step, ...(ref ? { ref } : {}), url, humanize: step.humanize ?? ctx.humanize };
      delete a.action; delete a.role; delete a.name; delete a.nth; delete a.saveAs;
      if (Array.isArray(step.modifiers)) a.modifiers = interact.modifierMask(step.modifiers);
      let r;
      switch (step.action) {
        case 'click': r = await interact.click(tabId, a); break;
        case 'double_click': r = await interact.click(tabId, { ...a, clickCount: 2 }); break;
        case 'right_click': r = await interact.click(tabId, { ...a, button: 'right' }); break;
        case 'hover': r = await interact.hover(tabId, a); break;
        case 'type': r = await interact.type(tabId, a); break;
        case 'key': r = await interact.key(tabId, a); break;
        case 'select': r = await interact.select(tabId, a); break;
        case 'scroll': r = await interact.scroll(tabId, a); break;
        default: throw new Error(`Unknown step action ${step.action}.`);
      }
      if (r?.delivery) out.delivery = r.delivery;
      return out;
    }
  }
}

/** An excerpt of the page for a failed step: the same-role elements, the element's area, or the controls. */
async function excerptFor(tabId, step, err, caller) {
  try {
    if (err?.lookedFor?.role) {
      const r = await find(tabId, { roles: [err.lookedFor.role], limit: 25 }, caller);
      return { of: `every ${err.lookedFor.role} on the page`, tree: r.tree };
    }
    if (step.ref) {
      const r = await snapshot(tabId, { scope: step.ref, maxNodes: 40 }, caller).catch(() => null);
      if (r) return { of: `the area of ${step.ref}`, tree: r.tree };
    }
    const r = await snapshot(tabId, { interactiveOnly: true, maxNodes: 40 }, caller);
    return { of: 'the controls on the page', tree: r.tree, truncated: r.truncated };
  } catch (e) {
    return { of: 'nothing', note: `no excerpt: ${e.message}` };
  }
}

/**
 * Run `steps` on `tabId`. → { ok, steps:[{ i, action, ok, ms, … }], completed, total, vars, failedAt?, error?, excerpt? }
 */
export async function runBatch(tabId, { steps, humanize, variables = {}, continueOnError = false } = {}, caller = null) {
  validateSteps(steps);
  const vars = { ...(variables && typeof variables === 'object' ? variables : {}) };
  const ctx = { caller, vars, humanize };
  const results = [];
  const started = Date.now();
  for (let i = 0; i < steps.length; i++) {
    const signal = callSignalFor(tabId);
    if (signal?.aborted) {
      return { ok: false, steps: results, completed: results.filter((r) => r.ok).length, total: steps.length, failedAt: i + 1, error: 'The batch was cancelled (its deadline passed, or the agent was stopped) before this step.', ms: Date.now() - started };
    }
    const step = substitute(steps[i], vars);
    const t0 = Date.now();
    try {
      const out = await runOne(tabId, step, ctx);
      results.push({ i: i + 1, action: step.action, ok: true, ms: Date.now() - t0, ...out });
    } catch (err) {
      const message = String(err?.message ?? err);
      results.push({ i: i + 1, action: step.action, ok: false, ms: Date.now() - t0, error: message.slice(0, 600) });
      if (continueOnError) continue;
      return {
        ok: false, steps: results, completed: i, total: steps.length, failedAt: i + 1, error: message,
        ...(typeof err?.delivery === 'string' ? { delivery: err.delivery } : {}),
        excerpt: await excerptFor(tabId, step, err, caller),
        ...(Object.keys(vars).length ? { vars: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, bounded(v)])) } : {}),
        ms: Date.now() - started,
      };
    }
  }
  return {
    ok: results.every((r) => r.ok), steps: results, completed: results.filter((r) => r.ok).length, total: steps.length,
    ...(Object.keys(vars).length ? { vars: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, bounded(v)])) } : {}),
    ms: Date.now() - started,
  };
}
