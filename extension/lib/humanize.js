/**
 * The dispatcher: turns a humanize plan into trusted CDP input.
 *
 * `extension/humanize/` is pure — it decides WHAT a person's hand would do and
 * WHEN, as a list of timestamped steps, from a seed. This file is the only
 * place those steps become `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`
 * calls, and it adds exactly three things the pure library cannot have:
 *
 * 1. **Time.** Each step carries `at`, milliseconds from the start of the
 *    plan. Steps are dispatched against `performance.now()` measured from the
 *    first one, so a slow CDP round trip delays one event without shifting
 *    every event after it (the schedule is absolute, not a chain of sleeps).
 *    Absolute, with one exception that matters more than the total: an
 *    interval that ENDS IN A DECISIVE STEP (a press, a release, a key, a wheel
 *    notch) keeps most of its length whatever the lateness — see perform().
 * 2. **Stop.** The panel's Stop is checked between steps, and during long
 *    pauses, not only at the start: a humanized form fill can take seconds,
 *    and "Stop" that waits for the end of a paragraph is not a stop.
 * 3. **The pointer.** Every dispatched mouse event is recorded into the tab's
 *    cursor track (lib/pointer.js) and the final position is persisted, so the
 *    next action starts where this one ended and every viewer can draw the
 *    cursor.
 *
 * `levelFor` decides which profile an action uses and with which seed. The
 * seed goes into the action's result: a failing run replays with identical
 * motion by passing it back.
 */

import { send } from './cdp.js';
import { getState } from './state.js';
import { platform } from './platform.js';
import * as pointer from './pointer.js';
import { inWorld } from './world.js';
import { status as screencastStatus } from './screencast.js';
import { PROFILES, resolveProfile } from '../humanize/index.js';

export const LEVELS = Object.freeze(['off', 'human', 'stealth']);

/**
 * A wheel notch that has not come back after this long is stuck, not slow
 * (v1.5.1: wheel dispatch wedges while a screencast runs).
 */
export const WHEEL_TIMEOUT_MS = 4000;

/**
 * A pointer event (move, press, release) that has not come back after this
 * long gets a visibility check while it is still pending. A hidden page in a
 * headed window (Engine 1: a background tab, a minimized window) drops input,
 * and a mouse event queued behind a wedged wheel answered only after ~5 s
 * each — a 24-move focus click took 120 s and ended as the daemon's
 * "JavaScript dialog" timeout (P8 matrix, round 2). A visible page's event is
 * simply awaited further: slow is not the same as lost.
 */
export const SLOW_INPUT_MS = 2000;

/**
 * Pressure of a pressed mouse button, as Blink reports it for a real mouse:
 * PointerEvent.pressure is 0.5 while any button is down (the OS gives no force
 * and Blink maps "unknown" to 0.5), 0 otherwise. CDP's `force` defaults to 0,
 * which Blink passes through — so every CDP press read pressure 0, a
 * one-property automation tell on any pointerdown listener (live round 2:
 * 50/50 runs).
 */
export const MOUSE_PRESSURE = 0.5;

/** Longest single sleep between halt checks. */
const HALT_SLICE_MS = 100;
/** Moves are checked against Stop at most this often; presses and keys always. */
const HALT_CHECK_MS = 50;

const STORED_PROFILE = (name) => `humanize:profile:${name}`;

/** tabId → { base, n }: the per-tab seed counter. */
const seeds = new Map();

/**
 * A fresh seed for an action on this tab that did not ask for one. A per-tab
 * counter over a per-worker base: consecutive actions differ, and the value is
 * reported so the exact motion can be replayed with `seed`.
 */
export function nextSeed(tabId) {
  let s = seeds.get(tabId);
  if (!s) {
    s = { base: (Math.imul(Number(tabId) || 1, 2654435761) ^ Date.now()) >>> 0, n: 0 };
    seeds.set(tabId, s);
  }
  s.n += 1;
  return (s.base + s.n) >>> 0;
}

function defaultLevel(tabId) {
  try {
    return platform.settings?.humanizeFor?.(tabId) ?? 'human';
  } catch {
    return 'human';
  }
}

/** 'off' < 'human' < 'stealth'. */
const RANK = { off: 0, human: 1, stealth: 2 };

/**
 * The tab's environment level (platform.settings.stealthFor), or 'off' when
 * it cannot be read. Sync by contract; a throwing implementation must not
 * fail the action, and 'off' then imposes nothing beyond what was asked.
 */
function stealthLevel(tabId) {
  try {
    const s = platform.settings?.stealthFor?.(tabId);
    return Object.hasOwn(RANK, s) ? s : 'off';
  } catch {
    return 'off';
  }
}

/**
 * Which input profile an action runs with, and its seed.
 *
 * `args.humanize` may be a level ('off' | 'human' | 'stealth'), the name of a
 * calibrated profile saved by `saveProfile` (plan §6.7), or a profile object.
 * Absent, the engine's per-tab default applies (the panel's input mode in the
 * extension, the context's setting on a launched engine).
 *
 * OWNER DECISION D-b (2026-09-22, under the owner's requirement that stealth
 * runs must be undetectable): the EFFECTIVE level is the stricter of that
 * humanize level and the tab's stealth level (`platform.settings.stealthFor`,
 * order off < human < stealth). A context launched with stealth:"stealth"
 * always gets stealth's input rules — no DOM.focus shortcut, no programmatic
 * scroll, no Input.insertText unless fast:true — even when a call (or the
 * context's own humanize default) asks for human or off. Before this, a
 * stealth context with humanize:"human" fell back to DOM.focus after a missed
 * focus click and to scrollIntoView: exactly the shortcuts a page can see,
 * in the one environment that promised there would be none.
 *
 * How the raise is made, so that timing stays what was asked where possible:
 * - a built-in level is replaced by the built-in profile of the effective
 *   level (off → human/stealth must stop being direct dispatch at all);
 * - a calibrated profile keeps its fitted numbers and only takes the
 *   effective level (its `level` field is what every rule reads); a direct
 *   (off-shaped) stored profile becomes the built-in effective profile.
 * `raisedFrom` in the result names the level that was asked for, and
 * `stealthLevel` the tab level that raised it; interact.js and replay.js
 * report both. In the extension (platform-extension) the panel's Input
 * setting is the DEFAULT level (humanizeFor), and stealthFor() is 'stealth'
 * only when the panel says Stealth, else 'off': Stealth is a floor an agent's
 * `humanize` can never loosen, while Human and Direct are only defaults, so
 * `humanize:"off"` gives direct input there.
 */
export async function levelFor(tabId, args = {}) {
  // The extension answers humanizeFor()/stealthFor() from a synchronous cache
  // of state.inputMode that getState() refreshes. A service worker that has
  // just restarted holds the built-in default there until something reads
  // state, and an action taken in that window ran at "human" while the panel
  // said "stealth" — DOM.focus and a programmatic scroll where stealth forbids
  // both. Reading state first closes it — for the default AND for the stealth
  // floor below, which applies even when the call names its own level. On a
  // launched engine it is cheap.
  await getState().catch(() => {});
  // An empty string is "not specified" (a form field left blank), not "human".
  const given = typeof args?.humanize === 'string' && !args.humanize.trim() ? null : args?.humanize;
  const requested = given ?? defaultLevel(tabId) ?? 'human';
  let profile;
  let builtIn = false;
  if (requested && typeof requested === 'object') {
    profile = resolveProfile(requested);
  } else {
    const name = String(requested).trim() || 'human';
    const key = name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(PROFILES, key)) {
      profile = resolveProfile(key);
      builtIn = true;
    } else {
      const stored = await loadProfile(name);
      if (!stored) {
        throw new Error(
          `Unknown humanize profile "${name}". Use off, human or stealth, or the name of a profile ` +
            `calibrated from a recording (browser_recording action:"calibrate_humanize").`,
        );
      }
      profile = resolveProfile(stored);
    }
  }
  const asked = LEVELS.includes(profile?.level) ? profile.level : profile?.direct ? 'off' : 'human';
  const floor = stealthLevel(tabId);
  let level = asked;
  let raisedFrom = null;
  if (RANK[floor] > RANK[asked]) {
    level = floor;
    raisedFrom = asked;
    profile = builtIn || profile?.direct
      ? resolveProfile(floor)
      : resolveProfile({ ...profile, level: floor, direct: false });
  }
  const seed = args?.seed != null && args.seed !== '' ? args.seed : nextSeed(tabId);
  return {
    level,
    profile,
    seed,
    name: profile?.name ?? String(requested),
    ...(raisedFrom ? { raisedFrom, stealthLevel: floor } : {}),
  };
}

/** A calibrated profile saved under a name, or null. */
export async function loadProfile(name) {
  try {
    const got = await platform.storage.local.get(STORED_PROFILE(name));
    return got?.[STORED_PROFILE(name)] ?? null;
  } catch {
    return null;
  }
}

/** Save a calibrated profile so actions can use it by name (`humanize: "<name>"`). */
export async function saveProfile(name, profile) {
  const clean = String(name ?? '').trim();
  // Case-insensitively: levelFor resolves "Human" to the built-in before it
  // ever looks in storage, so a profile saved as "Human" could never be used.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(clean) || LEVELS.includes(clean.toLowerCase())) {
    throw new Error(`"${name}" is not a usable profile name: use letters, digits, dot, dash or underscore, and not off/human/stealth.`);
  }
  const resolved = resolveProfile({ ...profile, name: clean });
  await platform.storage.local.set({ [STORED_PROFILE(clean)]: resolved });
  return resolved;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class HaltedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HaltedError';
    this.halted = true;
  }
}

async function isHalted() {
  try {
    return !!(await getState())?.halted;
  } catch {
    return false;
  }
}

/**
 * The cancel signal of the call now driving each tab (tools/index.js runTool binds it for the
 * call's duration). The daemon aborts a call that runs past its deadline, one whose tab a dialog
 * blocked, and an agent's calls when the user stops that agent: perform() checks it between
 * steps and during long pauses, exactly as it checks Stop. Without it a humanized type that hit
 * its deadline kept typing into whatever the NEXT call focused — its spaces pressed the Submit
 * button that call had just clicked (docs review, 2026-09-22: 24 extra activations).
 */
const callSignals = new Map(); // tabId → AbortSignal

/** Bind `signal` to `tabId` while a call runs; returns the unbind function. */
export function bindCallSignal(tabId, signal) {
  if (tabId == null || !signal || typeof signal.aborted !== 'boolean') return () => {};
  callSignals.set(tabId, signal);
  return () => {
    if (callSignals.get(tabId) === signal) callSignals.delete(tabId);
  };
}

/** The signal bound to this tab's running call, or null. */
export function callSignalFor(tabId) {
  return callSignals.get(tabId) ?? null;
}

/** Why a call was cancelled, as the signal says, for the stop message. */
function cancelReason(signal) {
  const why = signal?.reason instanceof Error ? signal.reason.message : typeof signal?.reason === 'string' ? signal.reason : '';
  return why ? `Cancelled: ${why}.` : 'The action was cancelled.';
}

/**
 * How far behind its schedule a pointer move must be before it may be merged
 * into the next one (perform rule 2): more than one sample interval (8–16 ms
 * in the plans) plus timer jitter, so a dispatcher that is merely a tick late
 * sends every sample, and one that is really behind — Chrome for Testing's
 * 35–54 ms per event — catches up.
 */
const MERGE_BEHIND_MS = 24;

/**
 * How much of a planned interval that ends in a decisive step must survive
 * lateness (perform rule 1). Not all of it: a step with a planned gap of 0
 * (a keyDown's char) can only start when the previous dispatch returns, and
 * requiring every later interval IN FULL from that late start carried one
 * dispatch time into every keystroke — typing on a launched Edge slowed from a
 * median 141–156 ms between keys to 173–199 ms (Engine 2 live test, round 3).
 * With 80 %, per-event overhead is absorbed back into the absolute schedule,
 * while a 60–140 ms hold can still never collapse below 48–112 ms (it was
 * 2–8 ms on Chrome for Testing).
 */
const KEEP_GAP = 0.8;

/** A step whose timing relative to the one before it carries meaning. */
const isDecisive = (step) => step.kind === 'key' || (step.kind === 'mouse' && step.type !== 'mouseMoved');

/** The next step after index `i` that is not a pause marker, or null. */
function nextEvent(steps, i) {
  for (let j = i + 1; j < steps.length; j++) if (steps[j].kind !== 'pause') return steps[j];
  return null;
}

/**
 * Dispatch a plan. Resolves `{ dispatched, merged, lateMs, durationMs, end }`.
 *
 * `sessionId` routes the events to a child session (a cross-origin frame) —
 * then the coordinates are in THAT frame's space, and `origin` (the frame's
 * top-left in the top-level viewport) converts them for the cursor track.
 * Humanized actions normally dispatch on the page session in top-level
 * coordinates, where the browser's own hit test routes them into the frame.
 *
 * ## When the dispatcher falls behind
 *
 * The schedule is absolute (`t0 + at`), which keeps a plan's total duration
 * honest when one round trip is slow. But a transport slower than the plan's
 * sampling — Chrome for Testing took 35–54 ms per mouseMoved against the
 * plan's 8–16 ms (live round 2) — put the whole plan seconds behind by the
 * press, every later deadline had already passed, and mousePressed and
 * mouseReleased went out back to back: a 60–140 ms hold reached the page as
 * 1.9–8.1 ms (20/22 CfT runs), the classic scripted-click tell, and a click
 * plan bounded at ~2.1 s took 3.5–5.2 s. Two rules fix it, and only lateness
 * is affected — on time, nothing changes:
 *
 * 1. An interval that ends in a DECISIVE step (press, release, key, wheel
 *    notch) keeps at least KEEP_GAP (80 %) of its planned length: the step
 *    starts no earlier than the previous event's start plus that much of the
 *    planned gap (start to start, which is what the page sees when the
 *    latency is steady). Otherwise the absolute schedule applies, so a small
 *    per-event overhead is absorbed instead of accumulating (`lateMs` reports
 *    the most any decisive step started behind its plan).
 * 2. Pointer MOVES may catch up: a move whose successor is also a move, with
 *    the same buttons held, that is already due is skipped (`merged`), so the
 *    pointer arrives on time with a coarser path instead of late with every
 *    sample. Never a press, a release, a key, a notch, or the last move before
 *    one of them.
 */
export async function perform(tabId, plan, { sessionId = null, signal: explicitSignal = null, origin = null, track = true } = {}) {
  // The call's own signal (bound by runTool) unless the caller passed one: captured once, so a
  // later call's binding on this tab never un-cancels this one.
  const signal = explicitSignal ?? callSignals.get(tabId) ?? null;
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const ox = origin?.x ?? 0;
  const oy = origin?.y ?? 0;
  const t0 = performance.now();
  const wall0 = Date.now();
  let dispatched = 0;
  let pressed = 0;
  let merged = 0;
  let lastMouse = null;
  let heldButtons = 0;
  let lastHaltCheck = -Infinity;
  // The previous event sent, and the most a decisive step started behind plan.
  let prev = null; // { at, start }
  let lateMax = 0;

  const stopMessage = (why) => {
    const held = heldButtons ? ' A mouse button may still be held down in the page.' : '';
    return `${why} ${dispatched} of ${steps.length} input events of this ${plan?.meta?.kind ?? 'action'} were sent; ` +
      `the rest were not.${held}`;
  };

  const checkStop = async (force) => {
    if (signal?.aborted) throw new HaltedError(stopMessage(cancelReason(signal)));
    const now = performance.now();
    if (!force && now - lastHaltCheck < HALT_CHECK_MS) return;
    lastHaltCheck = now;
    if (await isHalted()) {
      throw new HaltedError(stopMessage('Stopped: the user pressed Stop in the G9 panel while this action was running.'));
    }
  };

  // Wait until the absolute moment `when` (performance.now() time), in slices,
  // so a long think pause can be interrupted by Stop instead of finishing first.
  const waitFor = async (when) => {
    for (;;) {
      const wait = when - performance.now();
      if (wait <= 0) break;
      await sleep(Math.min(wait, HALT_SLICE_MS));
      if (wait > HALT_SLICE_MS) await checkStop(false);
    }
  };
  const due = (atMs) => t0 + (Number(atMs) || 0);
  const waitUntil = (atMs) => waitFor(due(atMs));

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.kind === 'pause') {
        await waitUntil(step.at);
        await checkStop(false);
        continue;
      }

      const decisive = isDecisive(step);
      if (decisive && prev) {
        // Rule 1: most of the planned gap from the previous event survives lateness.
        const gap = Math.max(0, (Number(step.at) || 0) - prev.at);
        await waitFor(Math.max(due(step.at), prev.start + gap * KEEP_GAP));
      } else {
        await waitUntil(step.at);
      }
      if (!decisive && step.kind === 'mouse') {
        // Rule 2: an overdue move followed by another overdue move is merged into it.
        const next = nextEvent(steps, i);
        const now = performance.now();
        if (next && next.kind === 'mouse' && next.type === 'mouseMoved' && (next.buttons | 0) === (step.buttons | 0)
          && due(next.at) <= now && now - due(step.at) >= MERGE_BEHIND_MS) {
          merged += 1;
          continue;
        }
      }
      await checkStop(decisive);

      const start = performance.now();
      if (decisive) lateMax = Math.max(lateMax, start - due(step.at));
      prev = { at: Number(step.at) || 0, start };
      if (step.kind === 'mouse') {
        await dispatchMouse(tabId, step, sessionId);
        if (step.type === 'mousePressed') pressed += 1;
        heldButtons = step.buttons | 0;
        lastMouse = { x: step.x, y: step.y };
        if (track) {
          pointer.record(tabId, {
            at: wall0 + (performance.now() - t0),
            x: step.x + ox,
            y: step.y + oy,
            buttons: step.buttons | 0,
            type: step.type,
          });
        }
      } else if (step.kind === 'key') {
        await dispatchKey(tabId, step, sessionId);
      } else {
        continue; // an unknown step kind is skipped, not guessed at
      }
      dispatched += 1;
    }
    // The plan is over at `durationMs`, not at its last step's start: a
    // trailing pause (planGap's think time, the dwell after a release, the
    // hold of a last key) is part of what a person's hand does. Returning
    // at the last step's `at` made a planGap() plan a no-op and let the next
    // action begin while this one was, by its own schedule, still going.
    // (Every caller that waited on its own — navigate.js's post-load idle —
    // now leaves it to this.)
    if (Number.isFinite(Number(plan?.durationMs))) await waitUntil(plan.durationMs);
  } catch (err) {
    if (err instanceof HaltedError) throw err;
    const msg = String(err?.message ?? err);
    if (/halted by the user|Stop was pressed/i.test(msg)) {
      throw new HaltedError(stopMessage('Stopped: the user pressed Stop in the G9 panel while this action was running.'));
    }
    if (err?.hidden) throw hiddenPartway(err, {
      sent: dispatched,
      of: steps.filter((s) => s.kind === 'mouse' || s.kind === 'key').length,
      pressed,
      heldButtons,
      kind: plan?.meta?.kind ?? null,
    });
    throw err;
  } finally {
    if (lastMouse && track) await pointer.setPosition(tabId, lastMouse.x + ox, lastMouse.y + oy);
  }

  const end = plan?.end ?? lastMouse;
  return {
    dispatched,
    ...(merged ? { merged } : {}),
    ...(lateMax >= 1 ? { lateMs: Math.round(lateMax) } : {}),
    durationMs: Math.round(performance.now() - t0),
    end: end ? { x: end.x + ox, y: end.y + oy } : null,
  };
}

/**
 * What to do about a hidden tab, and what still works. One text wherever a hidden page is named.
 *
 * It used to tell agents to "ask the user to bring that tab to the foreground" and to blame "a headed
 * Chromium" — for a HEADLESS background tab too (live round 3, every run) — while the tool
 * description said "focus" it; browser_tabs action:"focus" followed by the same click was delivered
 * exactly once (measured). The agent can fix this itself.
 */
export const HIDDEN_REMEDY =
  'Bring the tab to the front with browser_tabs action:"focus" (the person then sees that tab in their browser), ' +
  'or move it: action:"popout" (a window of its own: keep it un-minimized, and on Windows not completely ' +
  'covered unless the WindowOcclusionEnabled policy is off) or action:"handoff" (a launched ' +
  'engine, which has no window to hide). Reading tools (browser_snapshot, browser_inspect, browser_console, ' +
  'browser_network, browser_screenshot) keep working while it is hidden.';

/**
 * The sentence for input sent to (or about to be sent to) a HIDDEN page. One
 * text for the dispatcher and for interact.js, so the agent reads the same
 * cause and the same fix wherever the check caught it. `dispatched:false`
 * says nothing was sent at all (the check ran first).
 *
 * The physics, as measured (P8 matrix, round 3, Edge and Chrome 153, 10/10 hidden pages): pointer
 * and wheel events do not reach a page that is not visible — mouseMoved was never even answered —
 * but KEY events do (a bare keyDown landed in the focused field every time). So the refusal of
 * typing and keys is G9's policy, not the browser's: a person cannot type into a tab they cannot
 * see, and every G9 input action that needs a pointer (the focus click of a type) would be lost.
 */
export function hiddenInputMessage(action, state = 'hidden', { dispatched = true } = {}) {
  return (
    (dispatched
      ? `The ${action} was dispatched but the page never received it: the attached tab is HIDDEN `
      : `The ${action} was not sent: the attached tab is HIDDEN `) +
    `(document.visibilityState="${state}") — a background tab, or a minimized or covered window. The browser ` +
    `does not deliver pointer or wheel input to a page that is not visible, and G9 does not type into one either ` +
    `(key events would reach it, but nobody can see what they do). ${HIDDEN_REMEDY}`
  );
}

/**
 * A hidden page stopped a plan PART-WAY. The events the browser accepted before it were delivered,
 * or are still queued and land when the tab is shown again (P8 matrix, round 4: 5 notches while
 * visible, the 6th accepted one after the re-show) — the error used to say "the page never
 * received it" regardless: a 2000 px scroll
 * hidden 0.55 s in had delivered 3–6 wheel notches and scrolled the page 300–600 px (P8 matrix,
 * round 3, 9/9 hidemid rows), and an agent that believes "not delivered" scrolls twice.
 *
 * `sent`/`of` count input events; `pressed` how many button presses went out. The state is
 * 'partial' when anything was sent, else the original 'not-delivered'. interact.js words it for
 * the action (a click with no press is a click not made, and it says how far the page scrolled).
 */
function hiddenPartway(err, { sent, of, pressed, heldButtons, kind }) {
  err.sent = sent;
  err.of = of;
  err.pressed = pressed;
  if (!(sent > 0)) return err;
  const what = kind ?? 'action';
  const error = new Error(
    `The ${what} was interrupted: the tab became HIDDEN (document.visibilityState="hidden") after ${sent} of ${of} ` +
      `input events had been sent and accepted by the browser; the rest were not sent.` +
      (heldButtons ? ' A mouse button may still be held down in the page.' : '') +
      ' An accepted event can still be waiting in the browser and arrive when the tab is shown again, so check the page before ' +
      `repeating anything. ${HIDDEN_REMEDY}`,
  );
  Object.assign(error, { delivery: 'partial', hidden: true, sent, of, pressed, cause: err });
  return error;
}

/** Error for input a hidden page cannot receive: delivery 'not-delivered', `hidden: true`. */
export function hiddenInputError(action, state = 'hidden', opts = {}) {
  const error = new Error(hiddenInputMessage(action, state, opts));
  error.delivery = 'not-delivered';
  error.hidden = true;
  return error;
}

/**
 * The page's document.visibilityState, read in G9's world ('visible' |
 * 'hidden' | …), or null when it cannot be read. One round trip.
 */
export async function visibilityOf(tabId, sessionId = null) {
  try {
    const state = await inWorld(tabId, 'document.visibilityState', { sessionId, timeoutMs: 5000 });
    return typeof state === 'string' ? state : null;
  } catch {
    return null;
  }
}

const STEP_ACTION = { mouseMoved: 'pointer move', mousePressed: 'mouse press', mouseReleased: 'mouse release', mouseWheel: 'scroll wheel' };

async function dispatchMouse(tabId, step, sessionId) {
  const params = {
    type: step.type,
    x: step.x,
    y: step.y,
    button: step.button ?? 'none',
    buttons: step.buttons | 0,
    clickCount: step.clickCount ?? 0,
    modifiers: step.modifiers | 0,
    pointerType: 'mouse',
  };
  // A held button presses with a real mouse's pressure; no button, no pressure.
  if (params.buttons !== 0) params.force = MOUSE_PRESSURE;
  if (step.type === 'mouseWheel') {
    params.deltaX = step.deltaX ?? 0;
    params.deltaY = step.deltaY ?? 0;
  }
  try {
    if (step.type === 'mouseWheel') {
      await send(tabId, 'Input.dispatchMouseEvent', params, { sessionId, timeoutMs: WHEEL_TIMEOUT_MS });
      return;
    }
    const pending = send(tabId, 'Input.dispatchMouseEvent', params, { sessionId });
    let timer;
    const slow = await Promise.race([
      pending.then(() => false, () => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(true), SLOW_INPUT_MS); }),
    ]);
    clearTimeout(timer);
    if (slow && (await visibilityOf(tabId)) === 'hidden') {
      pending.catch(() => {}); // it may still settle; nobody is waiting for it now
      throw hiddenInputError(STEP_ACTION[step.type] ?? 'pointer event');
    }
    await pending;
  } catch (err) {
    if (err?.hidden) throw err;
    if (step.type === 'mouseWheel' && /did not return after/.test(String(err?.message ?? err))) {
      // Name the cause that is actually present. A hidden page never answers a
      // wheel (P8 matrix: 130 s), and blaming a screencast that was not running
      // sent people looking for one.
      const state = await visibilityOf(tabId);
      if (state === 'hidden') {
        const hidden = hiddenInputError('scroll wheel', state);
        hidden.cause = err;
        throw hidden;
      }
      let casting = false;
      try { casting = !!screencastStatus(tabId)?.running; } catch { casting = false; }
      const stall = new Error(
        casting
          ? 'The browser stopped answering wheel events — this happens while a screencast is running ' +
            '(a tab video or a live watch), and one is running on this tab. The wheel input was not replaced ' +
            'with a programmatic scroll, because a page that listens for wheel events would then see a scroll ' +
            'no person made. Stop the recording or the watch, or use humanize:"off" for this scroll.'
          : `The browser did not answer a wheel event within ${Math.round(WHEEL_TIMEOUT_MS / 1000)} s, although the page ` +
            `reports it is ${state ?? 'in an unknown state'} and no screencast is running on this tab. The wheel input ` +
            'was not replaced with a programmatic scroll (a page listening for wheel events would see a scroll no ' +
            'person made). Take a browser_screenshot to see the state of the page, then try again.',
      );
      stall.wheelStall = true;
      stall.cause = err;
      throw stall;
    }
    throw err;
  }
}

async function dispatchKey(tabId, step, sessionId) {
  const params = {
    type: step.type,
    key: step.key,
    modifiers: step.modifiers | 0,
    autoRepeat: false,
  };
  if (step.code) params.code = step.code;
  if (step.windowsVirtualKeyCode != null) params.windowsVirtualKeyCode = step.windowsVirtualKeyCode;
  if (step.nativeVirtualKeyCode != null) params.nativeVirtualKeyCode = step.nativeVirtualKeyCode;
  if (step.text != null) params.text = step.text;
  if (step.unmodifiedText != null) params.unmodifiedText = step.unmodifiedText;
  // Left/right Shift, Control… (DOM KeyboardEvent.location): a page can read it.
  if (step.location) params.location = step.location;
  await send(tabId, 'Input.dispatchKeyEvent', params, { sessionId });
}
