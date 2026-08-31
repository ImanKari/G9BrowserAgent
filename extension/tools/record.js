/**
 * Recording a session.
 *
 * A QA presses Record, works through a flow, presses Stop, and what comes out
 * has to be replayable next month against a page that has been redeployed
 * twice. `lib/locators.js` answers "which element"; this file answers "what
 * happened, and when".
 *
 * ## Two halves, deliberately split
 *
 * The injected script emits RAW events — a descriptor of the element plus a
 * timestamp — and nothing else. All the judgement (which events are one step,
 * how typing collapses, what a double click means) happens here, in the
 * extension.
 *
 * That split is not tidiness. Normalisation is where the interesting mistakes
 * live: a double click arrives as click, click, dblclick, and typing "admin"
 * arrives as five input events. Getting those wrong produces a recording that
 * replays as something the user never did. Keeping the logic out of the page
 * means it is ordinary code that can be tested without a browser — and the
 * injected half stays small enough to be obviously correct.
 *
 * ## Why CDP and not a content script
 *
 * `Page.addScriptToEvaluateOnNewDocument` runs before the page's own scripts
 * and survives every navigation by construction, over the debugger session that
 * is already open. `Runtime.addBinding` gives the injected code a direct
 * channel back. No `scripting` permission, no message plumbing, no re-injection
 * on navigate — and it keeps §6's rule that all browser logic goes through CDP.
 */

import { send, ensureDomain } from '../lib/cdp.js';
import { LOCATOR_SOURCE } from '../lib/locators.js';
import { saveRecording } from '../lib/store.js';

const api = globalThis.browser ?? globalThis.chrome;

/** The page calls this to hand us an event. Must match RECORDER_SOURCE. */
export const BINDING = '__g9emit';

const SESSION_KEY = (tabId) => `g9:recording-session:${tabId}`;

/**
 * The in-page half. Emits raw events; decides nothing.
 *
 * Escaping: injected as a template literal and parsed twice, so regex escapes
 * are doubled (`\\s`). See the note at the top of lib/locators.js.
 */
const RECORDER_SOURCE = `
(() => {
  if (window.__g9rec) return;

  const emit = (event) => {
    try {
      // Replay dispatches trusted events too, so without this a replay running
      // while a recording is armed would record itself.
      if (window.__g9replaying) return;
      window.${BINDING}(JSON.stringify(event));
    } catch (e) { /* binding not installed yet; the event is lost, not fatal */ }
  };

  const describe = (el) => (window.__g9loc ? window.__g9loc.describe(el) : null);

  const at = () => Date.now();

  /** Interactive ancestor, so a click on a <span> inside a button records the button. */
  const actionable = (el) => {
    if (!el || el.nodeType !== 1) return null;
    return el.closest('a, button, input, select, textarea, label, summary, [role], [onclick], [tabindex]') || el;
  };

  const send = (type, el, extra) => {
    const target = describe(actionable(el));
    if (!target) return;
    emit(Object.assign({ type, at: at(), target }, extra || {}));
  };

  addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    send('click', e.target, { button: 'left', detail: e.detail, modifiers: mods(e) });
  }, true);

  addEventListener('dblclick', (e) => {
    if (e.isTrusted) send('dblclick', e.target, { modifiers: mods(e) });
  }, true);

  addEventListener('contextmenu', (e) => {
    if (e.isTrusted) send('rightclick', e.target, { modifiers: mods(e) });
  }, true);

  // Value changes are emitted on EVERY input. The extension keeps the last one
  // per element and throws the rest away — it is the only side that can see
  // when the user moved on.
  addEventListener('input', (e) => {
    if (!e.isTrusted) return;
    const el = e.target;
    if (!el || !('value' in el)) return;
    send('change', el, { value: String(el.value), inputType: e.inputType || null, live: true });
  }, true);

  addEventListener('change', (e) => {
    if (!e.isTrusted) return;
    const el = e.target;
    if (!el) return;
    if (el.type === 'file') {
      send('upload', el, { files: Array.prototype.map.call(el.files || [], (f) => f.name) });
      return;
    }
    if (el.type === 'checkbox' || el.type === 'radio') {
      send('check', el, { checked: !!el.checked });
      return;
    }
    if (el.tagName === 'SELECT') {
      send('select', el, {
        value: String(el.value),
        text: el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent.trim() : '',
      });
      return;
    }
    if ('value' in el) send('change', el, { value: String(el.value), committed: true });
  }, true);

  // Only keys that carry meaning on their own. Ordinary characters arrive as
  // input events and are recorded as one value, which replays far more
  // reliably than a stream of keystrokes.
  const NOTABLE = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'PageUp', 'PageDown', 'Home', 'End'];
  addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    const chord = e.ctrlKey || e.metaKey || e.altKey;
    if (!chord && NOTABLE.indexOf(e.key) < 0) return;
    if (chord && e.key.length > 1 && NOTABLE.indexOf(e.key) < 0) return;
    send('key', e.target, { key: e.key, modifiers: mods(e) });
  }, true);

  let dragFrom = null;
  addEventListener('dragstart', (e) => { if (e.isTrusted) dragFrom = describe(actionable(e.target)); }, true);
  addEventListener('drop', (e) => {
    if (!e.isTrusted || !dragFrom) return;
    const to = describe(actionable(e.target));
    if (to) emit({ type: 'drag', at: at(), target: dragFrom, to });
    dragFrom = null;
  }, true);

  // Scroll is throttled hard: it fires continuously and only the resting place
  // is worth replaying.
  let scrollTimer = null;
  addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      emit({ type: 'scroll', at: at(), x: Math.round(scrollX), y: Math.round(scrollY) });
    }, 250);
  }, true);

  const mods = (e) => {
    const out = [];
    if (e.altKey) out.push('Alt');
    if (e.ctrlKey) out.push('Control');
    if (e.metaKey) out.push('Meta');
    if (e.shiftKey) out.push('Shift');
    return out;
  };

  window.__g9rec = true;
})();
`;

// ----------------------------------------------------------------- lifecycle

/**
 * Arm recording on a tab.
 *
 * The scripts go in twice on purpose: `addScriptToEvaluateOnNewDocument` covers
 * every future document, and a direct `Runtime.evaluate` covers the one already
 * open. Without the second, recording would silently capture nothing until the
 * user happened to navigate.
 */
export async function startRecording(tabId, { name, includeConsole = true } = {}) {
  await ensureDomain(tabId, 'Page');
  await ensureDomain(tabId, 'Runtime');

  await send(tabId, 'Runtime.addBinding', { name: BINDING }).catch(() => {});

  const source = `${LOCATOR_SOURCE}\n${RECORDER_SOURCE}`;
  const { identifier } = await send(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source });
  await send(tabId, 'Runtime.evaluate', { expression: source, returnByValue: true }).catch(() => {});

  const url = await currentUrl(tabId);
  const session = {
    tabId,
    name: name || `Recording ${new Date().toLocaleString()}`,
    scriptId: identifier,
    startUrl: url,
    startedAt: Date.now(),
    includeConsole,
    raw: [{ type: 'navigate', at: Date.now(), url }],
  };
  await api.storage.session.set({ [SESSION_KEY(tabId)]: session });
  return { recording: true, tabId, name: session.name, startUrl: url };
}

export async function isRecording(tabId) {
  const stored = await api.storage.session.get(SESSION_KEY(tabId));
  return !!stored[SESSION_KEY(tabId)];
}

export async function recordingStatus(tabId) {
  const stored = await api.storage.session.get(SESSION_KEY(tabId));
  const session = stored[SESSION_KEY(tabId)];
  if (!session) return { recording: false };
  const steps = normalize(session.raw);
  return {
    recording: true,
    name: session.name,
    startUrl: session.startUrl,
    rawEvents: session.raw.length,
    steps: steps.length,
    lastStep: steps.length ? summarize(steps[steps.length - 1]) : null,
    elapsedMs: Date.now() - session.startedAt,
  };
}

/**
 * Append a raw event.
 *
 * Called from the service worker for every `Runtime.bindingCalled`, and for
 * navigations, which the page cannot report about itself — by the time a new
 * document exists, the script that would have emitted the event is gone.
 */
export async function ingestRaw(tabId, event) {
  const key = SESSION_KEY(tabId);
  const stored = await api.storage.session.get(key);
  const session = stored[key];
  if (!session) return;
  session.raw.push(event);
  await api.storage.session.set({ [key]: session });
}

export async function stopRecording(tabId) {
  const key = SESSION_KEY(tabId);
  const stored = await api.storage.session.get(key);
  const session = stored[key];
  if (!session) throw new Error('Nothing is being recorded on this tab.');

  if (session.scriptId) {
    await send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: session.scriptId }).catch(() => {});
  }
  await send(tabId, 'Runtime.removeBinding', { name: BINDING }).catch(() => {});
  await api.storage.session.remove(key);

  const steps = normalize(session.raw);
  const recording = await saveRecording({
    name: session.name,
    startUrl: session.startUrl,
    createdAt: session.startedAt,
    durationMs: Date.now() - session.startedAt,
    steps,
  });

  return {
    id: recording.id,
    name: recording.name,
    steps: steps.length,
    durationMs: recording.durationMs,
    outline: steps.map(summarize),
  };
}

async function currentUrl(tabId) {
  const res = await send(tabId, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true }).catch(() => null);
  return res?.result?.value ?? null;
}

// --------------------------------------------------------------- normalisation

/**
 * Turn raw events into replayable steps.
 *
 * This is where a recording becomes a test. Three collapses matter:
 *
 * 1. **Typing.** Every keystroke fires an `input` event, so "admin" arrives as
 *    five. Only the last value per element survives, and it replays as one
 *    `type` step. Replaying five partial values would be slower and would fail
 *    on any field that validates as you type.
 *
 * 2. **Double click.** The browser fires click, click, dblclick. Recording all
 *    three replays as four clicks. The two clicks immediately preceding a
 *    dblclick on the same element are dropped.
 *
 * 3. **Click-then-change.** Clicking a checkbox or a <select> emits both. The
 *    change carries the outcome; the click is noise.
 *
 * Gaps between steps are preserved as `waitMs`. Replay uses them as a budget
 * while waiting on a real condition, never as a blind sleep — see replay.js.
 */
export function normalize(raw) {
  const steps = [];

  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];

    if (e.type === 'change' && e.live) {
      // Keep only the final value for a run of live input on the same element.
      const next = raw[i + 1];
      if (next && next.type === 'change' && sameTarget(next.target, e.target)) continue;
      pushOrReplaceValue(steps, e);
      continue;
    }

    if (e.type === 'change') {
      pushOrReplaceValue(steps, e);
      continue;
    }

    if (e.type === 'dblclick') {
      // Drop the click pair the browser emitted on the way here.
      for (let k = 0; k < 2 && steps.length; k++) {
        const last = steps[steps.length - 1];
        if (last.type === 'click' && sameTarget(last.target, e.target)) steps.pop();
        else break;
      }
      steps.push({ type: 'double_click', target: e.target, at: e.at, modifiers: e.modifiers });
      continue;
    }

    if (e.type === 'click') {
      // A click that immediately produced a select/check is not its own step.
      const next = raw[i + 1];
      if (next && (next.type === 'select' || next.type === 'check') && sameTarget(next.target, e.target)) continue;
      steps.push({ type: 'click', target: e.target, at: e.at, modifiers: e.modifiers });
      continue;
    }

    if (e.type === 'navigate') {
      const last = steps[steps.length - 1];
      if (last && last.type === 'navigate' && last.url === e.url) continue;
      steps.push({ type: 'navigate', url: e.url, at: e.at });
      continue;
    }

    if (e.type === 'scroll') {
      // Most recorded scrolls were never a decision. Focusing a field on a page
      // wider than the viewport makes the browser scroll to reveal it, and the
      // recorder sees that as an event — which is how a horizontal scroll the
      // user never performed ends up in the flow.
      //
      // A scroll only earns a step when nothing element-bound follows it,
      // because every element-bound step scrolls its own target into view
      // anyway. What survives is the case that matters: the user scrolled to
      // look at something and stopped there.
      const next = raw.slice(i + 1).find((n) => n.type !== 'scroll');
      if (next && next.target) continue;

      const last = steps[steps.length - 1];
      if (last && last.type === 'scroll') { last.x = e.x; last.y = e.y; last.at = e.at; continue; }
      steps.push({ type: 'scroll', x: e.x, y: e.y, at: e.at });
      continue;
    }

    steps.push({ ...e });
  }

  // Wall-clock gaps, capped: a QA who answered the phone mid-session should not
  // bake a four-minute pause into the test.
  let previous = null;
  for (const step of steps) {
    step.waitMs = previous ? Math.min(Math.max(step.at - previous, 0), 10_000) : 0;
    previous = step.at;
    delete step.live;
    delete step.committed;
  }

  return steps;
}

function pushOrReplaceValue(steps, e) {
  const last = steps[steps.length - 1];
  const step = {
    type: e.type === 'select' ? 'select' : 'type',
    target: e.target,
    value: e.value,
    at: e.at,
  };
  if (last && last.type === step.type && sameTarget(last.target, e.target)) {
    last.value = e.value;
    last.at = e.at;
    return;
  }
  steps.push(step);
}

/**
 * Two descriptors point at the same element when their strongest shared
 * locator agrees. Comparing whole objects would treat a re-described element
 * as different because its CSS path shifted by one sibling.
 */
export function sameTarget(a, b) {
  if (!a || !b) return false;
  const key = (t) => {
    const byKind = {};
    for (const loc of t.locators || []) byKind[loc.kind] = loc;
    for (const kind of ['testid', 'role', 'label', 'css', 'xpath']) {
      if (byKind[kind]) return kind + ':' + JSON.stringify(byKind[kind]);
    }
    return null;
  };
  const ka = key(a);
  return ka !== null && ka === key(b);
}

/** One human line per step, for the panel and for the agent. */
export function summarize(step) {
  const who = step.target?.fingerprint;
  const name = who ? `${who.role || who.tag}${who.name ? ` "${who.name}"` : ''}` : '';
  switch (step.type) {
    case 'navigate': return `go to ${step.url}`;
    case 'click': return `click ${name}`;
    case 'double_click': return `double-click ${name}`;
    case 'rightclick': return `right-click ${name}`;
    case 'type': return `type ${JSON.stringify(String(step.value ?? '').slice(0, 40))} into ${name}`;
    case 'select': return `select ${JSON.stringify(step.text || step.value)} in ${name}`;
    case 'check': return `${step.checked ? 'check' : 'uncheck'} ${name}`;
    case 'upload': return `upload ${(step.files || []).join(', ')} to ${name}`;
    case 'key': return `press ${[...(step.modifiers || []), step.key].join('+')}`;
    case 'drag': return `drag ${name} onto ${step.to?.fingerprint?.name ?? 'target'}`;
    case 'scroll': return `scroll to ${step.x},${step.y}`;
    default: return step.type;
  }
}
