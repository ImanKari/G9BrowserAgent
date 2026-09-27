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
 *
 * ## v2: the recorder lives in G9BrowserAgent's isolated world
 *
 * v1 injected into the page's MAIN world and left `window.__g9rec`,
 * `window.__g9loc` and the `__g9emit` binding where the page — and any bot
 * detector in it — could see them. Now the script is registered with
 * `worldName: 'g9'` (lib/world.js) and the binding with
 * `executionContextName: 'g9'`, so the page's own globals stay untouched. The
 * listeners still see every trusted event: an isolated world shares the DOM.
 *
 * One thing had to be measured rather than assumed (Edge 153, 2026-09-21): a
 * binding added BY NAME is installed in new contexts only while the Runtime
 * domain is enabled. The stealth level never enables Runtime, so the binding is
 * also added BY CONTEXT ID (which needs no Runtime.enable, and still delivers
 * `Runtime.bindingCalled`) — at start, and again after every navigation. The
 * script buffers events emitted before its binding exists and hands them over
 * when it appears, so the first click on a fresh page is not lost to that gap.
 *
 * ## Raw input samples, for humanize calibration (docs/HUMANIZE.md)
 *
 * Alongside the step events the script samples the person's hand: pointer
 * movement (≈60 Hz), presses and releases with the target's size, wheel
 * notches, and key TIMING. Keys are reduced to their class ('a' for a plain
 * character, 'A' for a shifted letter, '!' for a shifted symbol, ' ', '.',
 * named keys as themselves) with an opaque pairing code — the rhythm, never
 * the text — and nothing at all is sampled inside a password field. Samples
 * travel in batches and are kept apart from the step events, so a long
 * session of mouse movement can never push a recorded click out of the
 * 5,000-event cap. On stop they are stored as the recording's
 * `input-samples.json` attachment, in exactly the event shape
 * `humanize.fitProfile` reads.
 */

import { send, ensureDomain } from '../lib/cdp.js';
import { LOCATOR_SOURCE } from '../lib/locators.js';
import { saveRecording, getRecording, putAttachment, listAttachments, getAttachment } from '../lib/store.js';
import { serialize } from '../lib/state.js';
import { platform } from '../lib/platform.js';
import { WORLD, inWorld, verifiedContextFor, framesOf } from '../lib/world.js';
import * as frameSessions from '../lib/frames.js';
import { saveProfile } from '../lib/humanize.js';
import { fitProfile } from '../humanize/index.js';

/** The page calls this to hand us an event. Must match RECORDER_SOURCE. */
export const BINDING = '__g9emit';

const SESSION_KEY = (tabId) => `g9:recording-session:${tabId}`;
const SAMPLES_KEY = (tabId) => `g9:recording-samples:${tabId}`;
const REPLAY_KEY = (tabId) => `g9:replaying:${tabId}`;
const MAX_RAW_EVENTS = 5000;
const MAX_SAMPLES = 5000;
const SAMPLES_ATTACHMENT = 'input-samples.json';
/** recordingStatus binding sweeps: at most one per tab this often. */
const SWEEP_EVERY_MS = 2000;
const lastSweep = new Map();

const session = () => platform.storage.session;

/**
 * The in-page half. Emits raw events; decides nothing.
 *
 * Escaping: injected as a template literal and parsed twice, so regex escapes
 * are doubled (`\\s`). See the note at the top of lib/locators.js.
 */
const RECORDER_SOURCE = `
(() => {
  if (globalThis.__g9rec) return;
  const BINDING = ${JSON.stringify(BINDING)};
  const listeners = [];
  const on = (type, fn, options) => {
    addEventListener(type, fn, options);
    listeners.push([type, fn, options]);
  };

  // Payloads that could not be handed over yet (the binding arrives by context
  // id after a navigation when Runtime is off). Bounded; oldest first.
  const pending = [];
  const deliver = (payload) => {
    const fn = globalThis[BINDING];
    if (typeof fn !== 'function') return false;
    try { fn(payload); return true; } catch (e) { return false; }
  };
  const flush = () => {
    while (pending.length) {
      if (!deliver(pending[0])) return false;
      pending.shift();
    }
    return true;
  };

  const emit = (event) => {
    // Replay dispatches trusted events too, so without this a replay running
    // while a recording is armed would record itself.
    if (globalThis.__g9replaying) return;
    const payload = JSON.stringify(event);
    if (flush() && deliver(payload)) return;
    if (pending.length < 500) pending.push(payload);
  };

  const describe = (el) => (globalThis.__g9loc ? globalThis.__g9loc.describe(el) : null);

  const at = () => Date.now();

  /** Interactive ancestor, including the real node inside an open shadow root. */
  const actionable = (el) => {
    if (!el || el.nodeType !== 1) return null;
    return el.closest('a, button, input, select, textarea, label, summary, [role], [onclick], [tabindex]') || el;
  };

  const send = (type, el, extra) => {
    const target = describe(actionable(el));
    if (!target) return;
    emit(Object.assign({ type, at: at(), target }, extra || {}));
  };

  const mods = (e) => {
    const out = [];
    if (e.altKey) out.push('Alt');
    if (e.ctrlKey) out.push('Control');
    if (e.metaKey) out.push('Meta');
    if (e.shiftKey) out.push('Shift');
    return out;
  };

  on('click', (e) => {
    if (!e.isTrusted) return;
    send('click', e.composedPath ? e.composedPath()[0] : e.target, { button: 'left', detail: e.detail, modifiers: mods(e) });
  }, true);

  on('dblclick', (e) => {
    if (e.isTrusted) send('dblclick', e.target, { modifiers: mods(e) });
  }, true);

  on('contextmenu', (e) => {
    if (e.isTrusted) send('rightclick', e.target, { modifiers: mods(e) });
  }, true);

  // Value changes are emitted on EVERY input. The extension keeps the last one
  // per element and throws the rest away — it is the only side that can see
  // when the user moved on.
  on('input', (e) => {
    if (!e.isTrusted) return;
    const el = e.target;
    if (!el || !('value' in el)) return;
    if (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio' || el.type === 'file') return;
    send('change', el, { value: String(el.value), inputType: e.inputType || null, live: true });
  }, true);

  on('change', (e) => {
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
        values: Array.prototype.map.call(el.selectedOptions || [], (option) => String(option.value)),
        texts: Array.prototype.map.call(el.selectedOptions || [], (option) => option.textContent.trim()),
      });
      return;
    }
    if ('value' in el) send('change', el, { value: String(el.value), committed: true });
  }, true);

  // Only keys that carry meaning on their own. Ordinary characters arrive as
  // input events and are recorded as one value, which replays far more
  // reliably than a stream of keystrokes.
  const NOTABLE = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'PageUp', 'PageDown', 'Home', 'End'];
  on('keydown', (e) => {
    if (!e.isTrusted) return;
    const chord = e.ctrlKey || e.metaKey || e.altKey;
    if (!chord && NOTABLE.indexOf(e.key) < 0) return;
    if (chord && e.key.length > 1 && NOTABLE.indexOf(e.key) < 0) return;
    send('key', e.target, { key: e.key, modifiers: mods(e) });
  }, true);

  let dragFrom = null;
  on('dragstart', (e) => { if (e.isTrusted) dragFrom = describe(actionable(e.target)); }, true);
  on('drop', (e) => {
    if (!e.isTrusted || !dragFrom) return;
    const to = describe(actionable(e.target));
    if (to) emit({ type: 'drag', at: at(), target: dragFrom, to });
    dragFrom = null;
  }, true);

  // Scroll is throttled hard: it fires continuously and only the resting place
  // is worth replaying.
  let scrollTimer = null;
  on('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      emit({ type: 'scroll', at: at(), x: Math.round(scrollX), y: Math.round(scrollY) });
    }, 250);
  }, true);

  // ---- raw input samples (calibration) ------------------------------------
  // Coordinates are made top-level for a same-origin frame; a frame whose
  // position cannot be known (cross-origin parent) contributes no pointer
  // samples, because mixing coordinate spaces would corrupt every distance.
  const frameShift = () => {
    let x = 0, y = 0;
    let view = window;
    for (let depth = 0; view !== view.parent && depth < 10; depth++) {
      let frame = null;
      try { frame = view.frameElement; } catch (e) { return null; }
      if (!frame) return null;
      const r = frame.getBoundingClientRect();
      x += r.left + frame.clientLeft;
      y += r.top + frame.clientTop;
      view = view.parent;
    }
    return { x, y };
  };
  const stamp = (e) => Math.round((performance.timeOrigin + (e && e.timeStamp ? e.timeStamp : performance.now())) * 10) / 10;
  const samples = [];
  let sampleTimer = null;
  const flushSamples = () => {
    clearTimeout(sampleTimer);
    sampleTimer = null;
    if (samples.length) emit({ type: 'samples', at: at(), items: samples.splice(0, samples.length) });
  };
  const sample = (s) => {
    samples.push(s);
    if (samples.length >= 120) flushSamples();
    else if (!sampleTimer) sampleTimer = setTimeout(flushSamples, 1000);
  };
  const point = (e) => {
    const shift = frameShift();
    return shift ? { x: Math.round((e.clientX + shift.x) * 10) / 10, y: Math.round((e.clientY + shift.y) * 10) / 10 } : null;
  };
  let lastMove = 0;
  on('mousemove', (e) => {
    if (!e.isTrusted) return;
    const t = stamp(e);
    if (t - lastMove < 16) return;
    lastMove = t;
    const p = point(e);
    if (p) sample({ type: 'mousemove', at: t, x: p.x, y: p.y, buttons: e.buttons });
  }, { capture: true, passive: true });
  on('mousedown', (e) => {
    if (!e.isTrusted) return;
    const p = point(e);
    if (!p) return;
    const el = actionable(e.target);
    const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    sample({
      type: 'mousedown', at: stamp(e), x: p.x, y: p.y, button: e.button, detail: e.detail,
      width: r ? Math.round(r.width) : null, height: r ? Math.round(r.height) : null,
    });
  }, { capture: true, passive: true });
  on('mouseup', (e) => {
    if (!e.isTrusted) return;
    const p = point(e);
    if (p) sample({ type: 'mouseup', at: stamp(e), x: p.x, y: p.y, button: e.button });
  }, { capture: true, passive: true });
  on('wheel', (e) => {
    if (!e.isTrusted) return;
    const p = point(e) || { x: null, y: null };
    sample({ type: 'wheel', at: stamp(e), x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode });
  }, { capture: true, passive: true });

  // Key TIMING only. A printable key becomes its class, the physical code an
  // opaque pairing token, and a password field contributes nothing.
  const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';
  const keyClass = (k) => {
    if (typeof k !== 'string' || !k.length) return 'Unidentified';
    if ([...k].length > 1) return k;
    if (k === ' ') return ' ';
    if (/^[A-Z]$/.test(k)) return 'A';
    if (SHIFTED.indexOf(k) >= 0) return '!';
    if (/^[\\p{P}\\p{S}]$/u.test(k)) return '.';
    return 'a';
  };
  const secret = (el) => !!el && (el.type === 'password' || /(current|new)-password/.test(String((el.getAttribute && el.getAttribute('autocomplete')) || '')));
  const pairing = new Map();
  let pairs = 0;
  on('keydown', (e) => {
    if (!e.isTrusted || secret(e.target)) return;
    const id = 'k' + (++pairs);
    pairing.set(e.code || e.key, id);
    sample({ type: 'keydown', at: stamp(e), key: keyClass(e.key), code: id, repeat: !!e.repeat });
  }, { capture: true, passive: true });
  on('keyup', (e) => {
    if (!e.isTrusted || secret(e.target)) return;
    const physical = e.code || e.key;
    const id = pairing.get(physical) || 'k0';
    pairing.delete(physical);
    sample({ type: 'keyup', at: stamp(e), key: keyClass(e.key), code: id });
  }, { capture: true, passive: true });
  on('pagehide', flushSamples, true);

  // ---- control surface for the extension (G9BrowserAgent's world only) -----------------
  globalThis.__g9recFlush = flush;
  /** Everything still undelivered, handed over directly (used at stop). */
  globalThis.__g9recTake = () => {
    clearTimeout(sampleTimer);
    sampleTimer = null;
    const events = pending.splice(0, pending.length).map((p) => { try { return JSON.parse(p); } catch (e) { return null; } }).filter(Boolean);
    return { events, samples: samples.splice(0, samples.length) };
  };
  /** Remove every listener; a later recording injects afresh. */
  globalThis.__g9recStop = () => {
    for (const [type, fn, options] of listeners.splice(0)) removeEventListener(type, fn, options);
    clearTimeout(scrollTimer);
    clearTimeout(sampleTimer);
    globalThis.__g9rec = false;
  };
  globalThis.__g9rec = true;
})();
`;

// ----------------------------------------------------------------- lifecycle

/**
 * Bind and inject into every frame of a session's documents that exist NOW.
 *
 * `addScriptToEvaluateOnNewDocument` covers every future document; this covers
 * the ones already open. Without it recording would silently capture nothing
 * until the user happened to navigate. Idempotent: the script guards itself,
 * and re-adding a binding to a context that has it changes nothing.
 */
async function armFrames(tabId, { sessionId = null, inject = true } = {}) {
  const list = await framesOf(tabId, { sessionId }).catch(() => []);
  let armed = 0;
  for (const frame of list) {
    try {
      // Verified, not merely cached: a stale id can name the page's MAIN world
      // after a cross-process navigation, and a binding added there would sit
      // on the page's window (rule R4). See world.verifiedContextFor.
      const executionContextId = await verifiedContextFor(tabId, { sessionId, frameId: frame.id });
      // By context id: works with the Runtime domain off (stealth).
      await send(tabId, 'Runtime.addBinding', { name: BINDING, executionContextId }, { sessionId }).catch(() => {});
      if (inject) await inWorld(tabId, `${LOCATOR_SOURCE}\n${RECORDER_SOURCE}`, { sessionId, frameId: frame.id, idempotent: false });
      await inWorld(tabId, 'globalThis.__g9recFlush ? globalThis.__g9recFlush() : false', { sessionId, frameId: frame.id });
      armed += 1;
    } catch {
      // A frame that navigated away between the tree read and here is simply
      // armed by the script registered for new documents.
    }
  }
  return armed;
}

/**
 * Arm recording on a tab.
 *
 * The scripts go in twice on purpose: `addScriptToEvaluateOnNewDocument` covers
 * every future document, and armFrames() covers the ones already open.
 */
export async function startRecording(tabId, { name, includeConsole = true } = {}) {
  // A second start used to overwrite the session record, and with it the
  // identifiers of the scripts the first start registered: those were never
  // removed, so the recorder kept being injected into every new document of
  // the tab after Stop — and the first recording's steps were silently lost.
  const running = (await session().get(SESSION_KEY(tabId)))?.[SESSION_KEY(tabId)];
  if (running) {
    throw new Error(
      `This tab is already being recorded ("${running.name}"). Stop that recording first ` +
        '(browser_recording action:"stop"); nothing of it was discarded.',
    );
  }
  await ensureDomain(tabId, 'Page');

  const source = `${LOCATOR_SOURCE}\n${RECORDER_SOURCE}`;

  // By name, for every g9 context the browser creates from now on. Effective
  // while the Runtime domain is enabled (levels off/human); the per-context
  // binding in armFrames() and after each navigation covers stealth.
  await send(tabId, 'Runtime.addBinding', { name: BINDING, executionContextName: WORLD }).catch(() => {});
  const { identifier } = await send(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source, worldName: WORLD });

  // Cross-origin frames already attached get the same, on their own sessions.
  // Best effort: a frame that attaches later is not recorded (AIGuide §8).
  const childScripts = [];
  for (const frame of await frameSessions.list(tabId).catch(() => [])) {
    try {
      const opts = { sessionId: frame.sessionId };
      await send(tabId, 'Runtime.addBinding', { name: BINDING, executionContextName: WORLD }, opts).catch(() => {});
      const child = await send(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source, worldName: WORLD }, opts);
      childScripts.push({ sessionId: frame.sessionId, identifier: child.identifier });
      await armFrames(tabId, { sessionId: frame.sessionId });
    } catch {
      /* that frame went away */
    }
  }

  await armFrames(tabId);

  const url = await currentUrl(tabId);
  const record = {
    tabId,
    name: name || `Recording ${new Date().toLocaleString()}`,
    scriptId: identifier,
    childScripts,
    startUrl: url,
    startedAt: Date.now(),
    includeConsole,
    raw: [{ type: 'navigate', at: Date.now(), url }],
  };
  await session().set({ [SESSION_KEY(tabId)]: record, [SAMPLES_KEY(tabId)]: { items: [], dropped: 0 } });
  return { recording: true, tabId, name: record.name, startUrl: url };
}

/**
 * Every tab recording right now: `[{ tabId, name, startedAt }]`. The panel names
 * a recording in another tab (it only shows the current tab's otherwise).
 */
export async function recordingTabs() {
  const all = (await session().get(null).catch(() => null)) ?? {};
  const out = [];
  for (const [key, value] of Object.entries(all)) {
    const m = /^g9:recording-session:(\d+)$/.exec(key);
    if (!m || !value) continue;
    out.push({ tabId: Number(m[1]), name: value.name ?? null, startedAt: value.startedAt ?? null });
  }
  return out;
}

export async function isRecording(tabId) {
  const stored = await session().get(SESSION_KEY(tabId));
  return !!stored?.[SESSION_KEY(tabId)];
}

export async function recordingStatus(tabId) {
  const key = SESSION_KEY(tabId);
  const stored = await session().get([key, SAMPLES_KEY(tabId)]);
  const current = stored?.[key];
  if (!current) return { recording: false };
  // A frame that loaded after the last navigation has the recorder (the script
  // is registered for every new document) but, with the Runtime domain off, not
  // yet its binding: sweep. Idempotent and never allowed to fail status — and
  // throttled, because the panel polls status and a sweep costs a few CDP
  // round trips per frame.
  if (Date.now() - (lastSweep.get(tabId) ?? 0) >= SWEEP_EVERY_MS) {
    lastSweep.set(tabId, Date.now());
    armFrames(tabId, { inject: false }).catch(() => {});
    // The cross-origin frames being recorded too: a navigation inside one of
    // them is reported on ITS session only, so nothing else re-binds it.
    for (const child of current.childScripts ?? []) {
      armFrames(tabId, { sessionId: child.sessionId, inject: false }).catch(() => {});
    }
  }
  const steps = normalize(current.raw);
  return {
    recording: true,
    name: current.name,
    startUrl: current.startUrl,
    rawEvents: current.raw.length,
    inputSamples: stored?.[SAMPLES_KEY(tabId)]?.items?.length ?? 0,
    steps: steps.length,
    lastStep: steps.length ? summarize(steps[steps.length - 1]) : null,
    elapsedMs: Date.now() - current.startedAt,
  };
}

/**
 * Append a raw event.
 *
 * Called for every `Runtime.bindingCalled` of this binding (tools/events.js),
 * and for navigations, which the page cannot report about itself — by the time
 * a new document exists, the script that would have emitted the event is gone.
 * A navigation also re-binds the new document's world (see the header): done
 * OUTSIDE serialize(), because a CDP call inside it can deadlock the shared
 * chain (the note on issues.js startVideo).
 */
export async function ingestRaw(tabId, event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'samples') return ingestSamples(tabId, event.items);

  const recorded = await serialize(async () => {
    const key = SESSION_KEY(tabId);
    const replayKey = REPLAY_KEY(tabId);
    const stored = await session().get([key, replayKey]);
    const current = stored?.[key];
    if (!current || stored?.[replayKey]) return false;
    current.raw.push(event);
    if (current.raw.length > MAX_RAW_EVENTS) {
      const first = current.raw[0]?.type === 'navigate' ? current.raw[0] : null;
      const keep = current.raw.slice(-(MAX_RAW_EVENTS - (first ? 1 : 0)));
      current.raw = first ? [first, ...keep] : keep;
      current.droppedRawEvents = (current.droppedRawEvents ?? 0) + 1;
    }
    await session().set({ [key]: current });
    return true;
  });

  if (recorded && event.type === 'navigate') {
    armFrames(tabId, { inject: false }).catch(() => {});
  }
}

async function ingestSamples(tabId, items) {
  if (!Array.isArray(items) || !items.length) return;
  await serialize(async () => {
    const key = SAMPLES_KEY(tabId);
    const stored = await session().get([key, SESSION_KEY(tabId), REPLAY_KEY(tabId)]);
    if (!stored?.[SESSION_KEY(tabId)] || stored?.[REPLAY_KEY(tabId)]) return;
    const buffer = stored?.[key] ?? { items: [], dropped: 0 };
    buffer.items.push(...items.filter((s) => s && typeof s.type === 'string'));
    if (buffer.items.length > MAX_SAMPLES) {
      buffer.dropped += buffer.items.length - MAX_SAMPLES;
      buffer.items = buffer.items.slice(-MAX_SAMPLES);
    }
    await session().set({ [key]: buffer });
  });
}

/** Keep an armed recorder from recording its own trusted replay events. */
export async function setReplaying(tabId, replaying) {
  const key = REPLAY_KEY(tabId);
  if (replaying) await session().set({ [key]: true });
  else await session().remove(key);
  await inWorld(tabId, `globalThis.__g9replaying = ${replaying ? 'true' : 'false'}`).catch(() => {});
}

export async function stopRecording(tabId) {
  const key = SESSION_KEY(tabId);
  const stored = await session().get([key, SAMPLES_KEY(tabId)]);
  const current = stored?.[key];
  if (!current) throw new Error('Nothing is being recorded on this tab.');
  lastSweep.delete(tabId);

  // Collect what the page still holds (events buffered before a binding
  // existed, the last batch of samples), then take the recorder down.
  const tail = { events: [], samples: [] };
  const sessions = [null, ...(current.childScripts ?? []).map((c) => c.sessionId)];
  for (const sessionId of sessions) {
    for (const frame of await framesOf(tabId, { sessionId }).catch(() => [])) {
      const got = await inWorld(
        tabId,
        '(() => { const t = globalThis.__g9recTake ? globalThis.__g9recTake() : null; if (globalThis.__g9recStop) globalThis.__g9recStop(); return t; })()',
        { sessionId, frameId: frame.id, idempotent: false },
      ).catch(() => null);
      if (got) {
        tail.events.push(...(got.events ?? []));
        tail.samples.push(...(got.samples ?? []));
      }
    }
  }

  if (current.scriptId) {
    await send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: current.scriptId }).catch(() => {});
  }
  for (const child of current.childScripts ?? []) {
    await send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: child.identifier }, { sessionId: child.sessionId }).catch(() => {});
    await send(tabId, 'Runtime.removeBinding', { name: BINDING }, { sessionId: child.sessionId }).catch(() => {});
  }
  await send(tabId, 'Runtime.removeBinding', { name: BINDING }).catch(() => {});

  // The session record may have grown since it was read: re-read under the lock.
  const { raw, dropped, samples } = await serialize(async () => {
    const latest = await session().get([key, SAMPLES_KEY(tabId)]);
    const rec = latest?.[key] ?? current;
    const buffer = latest?.[SAMPLES_KEY(tabId)] ?? { items: [], dropped: 0 };
    await session().remove([key, SAMPLES_KEY(tabId)]);
    return { raw: rec.raw, dropped: rec.droppedRawEvents ?? 0, samples: buffer };
  });

  const allRaw = [...raw, ...tail.events.filter((e) => e.type !== 'samples')]
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const steps = normalize(allRaw);
  const recording = await saveRecording({
    name: current.name,
    startUrl: current.startUrl,
    createdAt: current.startedAt,
    durationMs: Date.now() - current.startedAt,
    steps,
    recorderWarnings: dropped
      ? [`${dropped} oldest raw events were discarded after the ${MAX_RAW_EVENTS}-event safety cap.`]
      : [],
  });

  const sampleItems = [...(samples.items ?? []), ...tail.samples].slice(-MAX_SAMPLES);
  let inputSamples = null;
  if (sampleItems.length) {
    // The step events that frame the samples (clicks, navigations — for the
    // think-time gaps), stripped of anything typed: calibration needs rhythm,
    // not content.
    const context = allRaw.map(({ value, text, values, texts, files, ...rest }) => rest);
    const payload = JSON.stringify({
      format: 'g9-input-samples/1',
      recordingId: recording.id,
      startedAt: current.startedAt,
      droppedSamples: samples.dropped ?? 0,
      events: [...context, ...sampleItems].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
    });
    try {
      const attachment = await putAttachment({
        owner: recording.id,
        name: SAMPLES_ATTACHMENT,
        mime: 'application/json',
        kind: 'calibration',
        bytes: new TextEncoder().encode(payload),
        meta: { samples: sampleItems.length, dropped: samples.dropped ?? 0 },
      });
      inputSamples = { attachmentId: attachment.id, samples: sampleItems.length };
      await saveRecording({ ...recording, inputSamples });
    } catch {
      inputSamples = null; // calibration data is a bonus; the recording stands
    }
  }

  return {
    id: recording.id,
    name: recording.name,
    steps: steps.length,
    durationMs: recording.durationMs,
    outline: steps.map(summarize),
    ...(inputSamples ? { inputSamples: inputSamples.samples } : {}),
  };
}

async function currentUrl(tabId) {
  return inWorld(tabId, 'location.href').catch(() => null);
}

// --------------------------------------------------------------- calibration

/** The raw input samples stored with a recording, in fitProfile's event shape. */
export async function inputSamplesOf(recordingId) {
  const rows = await listAttachments(recordingId).catch(() => []);
  const row = rows.find((r) => r.name === SAMPLES_ATTACHMENT) ?? null;
  if (!row) return null;
  const full = await getAttachment(row.id);
  if (!full?.dataBase64) return null;
  const bytes = Uint8Array.from(atob(full.dataBase64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Fit a humanize profile from one or more recordings of a real person
 * (docs/HUMANIZE.md, Calibration) and, when `name` is given, save it so actions can use it with
 * `humanize: "<name>"`. Never fabricates: a parameter without enough samples
 * keeps the base profile's value, and the report says which.
 */
export async function calibrateFromRecording(ids, { base = 'human', name = null } = {}) {
  const list = Array.isArray(ids) ? ids : [ids];
  const groups = [];
  const missing = [];
  for (const id of list) {
    if (!(await getRecording(id))) throw new Error(`No recording with id "${id}".`);
    const data = await inputSamplesOf(id);
    if (data?.events?.length) groups.push(data.events);
    else missing.push(id);
  }
  if (!groups.length) {
    throw new Error(
      'None of these recordings carries raw input samples. Record the flow again with this version — the ' +
        'recorder now samples pointer movement, presses, wheel and key timing for calibration.',
    );
  }
  const fitted = fitProfile(groups, base, name ? { name } : {});
  const saved = name ? await saveProfile(name, fitted.profile) : null;
  return {
    ...(saved ? { saved: saved.name, use: `humanize: "${saved.name}"` } : {}),
    base,
    recordings: groups.length,
    ...(missing.length ? { withoutSamples: missing } : {}),
    samples: fitted.samples,
    report: fitted.report,
    profile: fitted.profile,
  };
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
 *
 * Raw input samples (`type: 'samples'`) are calibration data, not steps, and
 * are skipped here if one ever reaches this list.
 */
export function normalize(raw) {
  const steps = [];

  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (!e || e.type === 'samples') continue;

    if (e.type === 'select' || e.type === 'check') {
      // Native select/checkbox use may emit key/click events plus multiple
      // intermediate change events. The observable final state is the test
      // step; replaying the mechanics as well applies the action repeatedly.
      while (steps.length) {
        const last = steps[steps.length - 1];
        if (!sameTarget(last.target, e.target) || e.at - last.at > 1000) break;
        if (!['click', 'key', 'select', 'check'].includes(last.type)) break;
        steps.pop();
      }
      steps.push({ ...e });
      continue;
    }

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
      const next = raw.slice(i + 1).find((n) => n && n.type !== 'scroll' && n.type !== 'samples');
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
    case 'assert': return 'assert ' + step.assertion + (name ? ' on ' + name : '');
    default: return step.type;
  }
}
