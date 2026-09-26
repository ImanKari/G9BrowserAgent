/**
 * Calibration: fit a profile from recordings of a real person (docs/HUMANIZE.md, Calibration).
 *
 * The defaults in profiles.js are literature numbers. A team's own QA people
 * move, type and scroll in their own way, and a profile fitted from them is
 * both more human and more honest about what "human" means here. So:
 *
 *   fitProfile(rawEvents, base = 'human', { name }?) → { profile, samples, report }
 *
 * The rule that shapes everything below: NEVER FABRICATE. A parameter is
 * fitted only from enough samples of the thing it describes; otherwise it is
 * kept from the base profile and the report says so and why. A biased sample
 * is not a sample — the time between two v1 clicks mixes thinking with moving,
 * so it does not become "think time" just because it is the only number there.
 *
 * ## What it reads
 *
 * The recorder's raw event stream (tools/record.js), one or more recordings.
 * Each event is `{ type, at, … }`, `at` in ms. Understood types:
 *
 *   v1 recorder   click / dblclick / rightclick   { detail?, x?, y? }
 *                 change { value, live:true }      one per keystroke — inter-key intervals, corrections
 *                 key { key }                      notable keys only (Enter, Tab, arrows, Backspace …)
 *                 navigate, select, check, upload, drag, scroll, assert
 *   richer        mousemove / pointermove           { x, y, buttons? }   pointer paths
 *   (if recorded) mousedown / pointerdown           { x, y, button?, width?, height? | w,h | rect }  target size → Fitts W
 *                 mouseup / pointerup                { x, y }
 *                 wheel                              { deltaX, deltaY, deltaMode? }
 *                 keydown / keyup                    { key, code?, repeat? }
 *
 * Pointer events with a pointerType other than 'mouse' (touch, pen) are
 * ignored. Input may be an array of events, an array of recordings (arrays),
 * or objects carrying a `raw` array (the recorder's session shape).
 *
 * ## What it fits (each only with enough samples — MIN_SAMPLES)
 *
 *   keyboard   ikiMedianMs/ikiSigma (log-normal of plain→plain intervals), afterSpaceOrPunct,
 *              beforeShifted, holdMedianMs/holdSigma, shiftLeadMs, shiftTrailMs, thinkMs,
 *              typoRate (correction runs per typed character — an upper bound), betweenFormKeysMs
 *   mouse      fitts.a/b (least squares on log2(D/W+1)), durationJitter (residual spread),
 *              curvature.offset & sameSideChance, overshoot.chance & fraction, sampleIntervalMs,
 *              dwellMs, settle.chance, pressHoldMs, doubleClickGapMs
 *   wheel      notchPx (the dominant pixel delta), notchIntervalMs, burst, burstPauseMs, overshootChance
 *   gaps       betweenActionsMs, afterNavigationMs (only from pointer data: idle before a move starts)
 *
 * Ranges are the 5th–95th percentiles of the samples.
 */

import { PROFILES, deepMerge, clone, isPlainObject } from './profiles.js';
import { resolveProfile, validateProfile } from './profile.js';

/** The fewest samples a parameter is fitted from. Below this it is kept from the base. */
export const MIN_SAMPLES = Object.freeze({
  keyIntervals: 30,
  classIntervals: 10,
  keyHolds: 30,
  shiftTimings: 10,
  thinkGaps: 5,
  typedChars: 200,
  formKeyGaps: 5,
  pressHolds: 10,
  doubleClickGaps: 5,
  movements: 20,
  curvedMovements: 20,
  longMovements: 10,
  overshoots: 5,
  moveIntervals: 50,
  dwells: 10,
  wheelEvents: 10,
  wheelIntervals: 10,
  wheelBursts: 5,
  wheelPauses: 5,
  scrollEpisodes: 10,
  actionGaps: 10,
  navigationGaps: 5,
});

// Shape constants of the analysis (not behaviour: nothing here is emitted as input).
const STILL_MS = 100;        // a pause this long between moves ends one movement
const SETTLE_PX = 3.5;       // a move this small after a stop is a settle drift, not the approach
const STOP_MS = 30;          // a gap this long between moves means the hand had stopped
const TYPING_GAP_MS = 2000;  // longer than this between keys is a pause, not rhythm
const EPISODE_GAP_MS = 3000; // longer than this between wheel notches is a new scroll
const CLICK_SLOP_PX = 2;     // a press that travels further than this before its release was a drag

// ------------------------------------------------------------------- stats

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => sum(xs) / xs.length;
function std(xs) {
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / Math.max(1, xs.length - 1));
}
export function quantile(xs, q) {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
const median = (xs) => quantile(xs, 0.5);
function logNormalFit(xs) {
  const logs = xs.filter((x) => x > 0).map(Math.log);
  return { median: Math.exp(mean(logs)), sigma: std(logs) };
}
const r1 = (x) => Math.round(x);
const r3 = (x) => Math.round(x * 1000) / 1000;
const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** [p5, p95] as integers, clamped, min ≤ max. */
function spread(xs, lo, hi) {
  const a = clampTo(r1(quantile(xs, 0.05)), lo, hi);
  const b = clampTo(r1(quantile(xs, 0.95)), lo, hi);
  return [Math.min(a, b), Math.max(a, b)];
}

// ------------------------------------------------------------ normalising

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

function sizeOf(e) {
  const r = e.rect ?? e.target?.rect ?? e.box ?? null;
  const w = num(e.width ?? e.w ?? r?.width ?? r?.w);
  const h = num(e.height ?? e.h ?? r?.height ?? r?.h);
  return w !== null && h !== null && w > 0 && h > 0 ? { w, h } : null;
}

/** A stable identity for a recorder target descriptor (strongest locator first). */
function targetKey(t) {
  if (!t) return '';
  if (Array.isArray(t.locators)) {
    const byKind = {};
    for (const loc of t.locators) if (loc && loc.kind) byKind[loc.kind] = loc;
    for (const kind of ['testid', 'role', 'label', 'css', 'xpath']) if (byKind[kind]) return kind + ':' + JSON.stringify(byKind[kind]);
  }
  try {
    return JSON.stringify(t).slice(0, 400);
  } catch {
    return '';
  }
}

function normalizeEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const at = num(e.at ?? e.t ?? e.time ?? e.timeStamp);
  if (at === null) return null;
  const type = String(e.type ?? '').toLowerCase();
  if (e.pointerType && e.pointerType !== 'mouse') return null;
  const x = num(e.x ?? e.clientX);
  const y = num(e.y ?? e.clientY);
  switch (type) {
    case 'mousemove':
    case 'pointermove':
    case 'move':
      return x === null || y === null ? null : { kind: 'move', at, x, y };
    case 'mousedown':
    case 'pointerdown':
    case 'down':
      return { kind: 'down', at, x, y, button: e.button ?? 0, size: sizeOf(e), detail: num(e.detail ?? e.clickCount) };
    case 'mouseup':
    case 'pointerup':
    case 'up':
      return { kind: 'up', at, x, y, button: e.button ?? 0 };
    case 'wheel':
    case 'mousewheel':
      return { kind: 'wheel', at, x, y, deltaX: num(e.deltaX) ?? 0, deltaY: num(e.deltaY) ?? 0, deltaMode: num(e.deltaMode) ?? 0 };
    case 'keydown':
      return typeof e.key === 'string' ? { kind: 'keydown', at, key: e.key, code: e.code ?? null, repeat: !!e.repeat } : null;
    case 'keyup':
      return typeof e.key === 'string' ? { kind: 'keyup', at, key: e.key, code: e.code ?? null } : null;
    case 'key':
      // v1: notable keys only (the recorder skips ordinary characters).
      return typeof e.key === 'string' ? { kind: 'notablekey', at, key: e.key } : null;
    case 'click':
    case 'dblclick':
    case 'rightclick':
    case 'contextmenu':
    case 'double_click':
      return { kind: 'click', at, subtype: type, detail: num(e.detail), target: targetKey(e.target) };
    case 'change':
    case 'input':
    case 'type':
      if (e.live || type === 'input') return { kind: 'input', at, value: String(e.value ?? ''), target: targetKey(e.target) };
      return { kind: 'action', at, subtype: 'commit' };
    case 'navigate':
      return { kind: 'navigate', at };
    case 'select':
    case 'check':
    case 'upload':
    case 'drag':
    case 'assert':
      return { kind: 'action', at, subtype: type };
    default:
      return null; // scroll positions (throttled), unknown types: nothing to fit
  }
}

/** → array of recordings, each an array of normalised events sorted by time. */
function toRecordings(input) {
  const list = Array.isArray(input) ? input : input ? [input] : [];
  const isEvent = (x) => isPlainObject(x) && typeof x.type === 'string';
  const groups = [];
  if (list.every(isEvent)) {
    groups.push(list);
  } else {
    for (const item of list) {
      if (Array.isArray(item)) groups.push(item);
      else if (item && Array.isArray(item.raw)) groups.push(item.raw);
      else if (item && Array.isArray(item.events)) groups.push(item.events);
      else if (isEvent(item)) groups.push([item]);
    }
  }
  return groups
    .map((g) => g.map(normalizeEvent).filter(Boolean).sort((a, b) => a.at - b.at))
    .filter((g) => g.length);
}

// --------------------------------------------------------------- analysis

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS']);
const SHIFTED_SYMBOLS = new Set([...'~!@#$%^&*()_+{}|:"<>?']);
const isChar = (k) => typeof k === 'string' && [...k].length === 1;
const isSpaceOrPunct = (ch) => /^[\p{P}\p{S}\p{Z}\s]$/u.test(ch);
const isShiftedChar = (ch) => /^[A-Z]$/.test(ch) || SHIFTED_SYMBOLS.has(ch);
const isTyping = (e) => e.kind === 'keydown' || e.kind === 'input';

function emptySamples() {
  return {
    keyIntervals: [], afterSpace: [], beforeShifted: [], keyHolds: [], shiftLead: [], shiftTrail: [],
    thinkGaps: [], formKeyGaps: [], typedChars: 0, corrections: 0,
    pressHolds: [], doubleClickGaps: [],
    movements: [], moveIntervals: [], dwells: [], settles: 0,
    wheelDeltas: [], wheelIntervals: [], wheelPauses: [], wheelBursts: [], scrollEpisodes: 0, scrollBacks: 0, wheelLineMode: 0,
    actionGaps: [], navigationGaps: [],
  };
}

function analyseKeys(rec, S, hasKeydowns) {
  // --- from keydown/keyup (full key logging)
  if (hasKeydowns) {
    let prev = null;       // previous non-modifier keydown
    let prevShifted = false;
    let shiftDownAt = null;
    let shiftPressedSincePrev = false;
    let lastCharUpAt = null;
    let inCorrection = false;
    let lastNonTypingAt = -Infinity;
    const open = new Map();
    for (const e of rec) {
      if (e.kind === 'click' || e.kind === 'down' || e.kind === 'up' || e.kind === 'navigate' || e.kind === 'action') lastNonTypingAt = e.at;
      if (e.kind === 'keydown' && !e.repeat) {
        if (e.key === 'Shift') {
          shiftDownAt = e.at;
          shiftPressedSincePrev = true;
          continue;
        }
        if (MODIFIER_KEYS.has(e.key)) continue;
        open.set(e.code || e.key, e.at);
        const typedChar = isChar(e.key);
        if (typedChar) S.typedChars++;
        if (e.key === 'Backspace') {
          if (!inCorrection) S.corrections++;
          inCorrection = true;
        } else {
          inCorrection = false;
        }
        if (shiftDownAt !== null && shiftPressedSincePrev && typedChar) {
          const lead = e.at - shiftDownAt;
          if (lead >= 0 && lead <= 500) S.shiftLead.push(lead);
        }
        if (prev && prev.at > lastNonTypingAt) {
          const dt = e.at - prev.at;
          const bothTyping = prev.key !== 'Backspace' && e.key !== 'Backspace' && isChar(prev.key) && typedChar;
          if (dt > 0 && dt <= TYPING_GAP_MS && bothTyping) {
            // One effect per sample: an interval both after a space and before
            // a fresh Shift carries both multipliers and belongs to neither class.
            const afterSpace = isSpaceOrPunct(prev.key);
            const beforeShift = isShiftedChar(e.key) && shiftPressedSincePrev;
            if (afterSpace && !beforeShift) S.afterSpace.push(dt);
            else if (beforeShift && !afterSpace && !prevShifted) S.beforeShifted.push(dt);
            else if (!afterSpace && !beforeShift && !prevShifted && !isShiftedChar(e.key)) S.keyIntervals.push(dt);
          }
        }
        // A keystroke starts when its first key goes down: for a shifted
        // character that is the Shift, not the character 30–90 ms later.
        // (Measured to the character, every run that began with a capital
        // added the Shift lead to the think time the planner puts BEFORE Shift.)
        const strokeAt = shiftPressedSincePrev && shiftDownAt !== null && shiftDownAt > lastNonTypingAt
          && (!prev || shiftDownAt > prev.at) ? shiftDownAt : e.at;
        if (prev && prev.key === 'Tab') {
          const dt = strokeAt - prev.at;
          if (dt > 0 && dt <= 5000) S.formKeyGaps.push(dt);
        }
        if (!prev || prev.at <= lastNonTypingAt) {
          const gap = strokeAt - lastNonTypingAt;
          if (Number.isFinite(gap) && gap > 0 && gap <= 5000 && typedChar) S.thinkGaps.push(gap);
        }
        prev = { key: e.key, at: e.at };
        prevShifted = isShiftedChar(e.key);
        shiftPressedSincePrev = false;
      } else if (e.kind === 'keyup') {
        if (e.key === 'Shift') {
          if (lastCharUpAt !== null && shiftDownAt !== null && lastCharUpAt >= shiftDownAt) {
            const trail = e.at - lastCharUpAt;
            if (trail >= 0 && trail <= 500) S.shiftTrail.push(trail);
          }
          shiftDownAt = null;
          continue;
        }
        if (MODIFIER_KEYS.has(e.key)) continue;
        const k = e.code || e.key;
        if (open.has(k)) {
          const hold = e.at - open.get(k);
          if (hold > 0 && hold <= 2000) S.keyHolds.push(hold);
          open.delete(k);
        }
        if (isChar(e.key)) lastCharUpAt = e.at;
      }
    }
    return;
  }

  // --- from the v1 recorder's per-keystroke `input` values
  let prevInput = null;
  let inCorrection = false;
  let lastClickAt = null;
  let prevTab = null;
  for (const e of rec) {
    // A click (or a navigation) ends a typing run: the next input is the
    // first keystroke of a new one, and the time to it is think time.
    if (e.kind === 'click') {
      lastClickAt = e.at;
      prevInput = null;
    }
    if (e.kind === 'notablekey' && e.key === 'Tab') prevTab = e.at;
    if (e.kind === 'navigate') prevInput = null;
    if (e.kind !== 'input') continue;
    if (prevTab !== null) {
      const gap = e.at - prevTab;
      if (gap > 0 && gap <= 5000) S.formKeyGaps.push(gap);
      prevTab = null;
    }
    if (lastClickAt !== null) {
      const gap = e.at - lastClickAt;
      if (gap > 0 && gap <= 5000) S.thinkGaps.push(gap);
    }
    const same = prevInput && prevInput.target === e.target;
    const before = same ? [...prevInput.value] : null;
    const after = [...e.value];
    if (same && after.length === before.length + 1 && after.slice(0, -1).join('') === before.join('')) {
      S.typedChars++;
      inCorrection = false;
      const dt = e.at - prevInput.at;
      const ch = after[after.length - 1];
      const prevCh = before[before.length - 1];
      if (dt > 0 && dt <= TYPING_GAP_MS && prevCh !== undefined && !prevInput.deleted) {
        const afterSpace = isSpaceOrPunct(prevCh);
        const beforeShift = isShiftedChar(ch) && !isShiftedChar(prevCh);
        if (afterSpace && !beforeShift) S.afterSpace.push(dt);
        else if (beforeShift && !afterSpace) S.beforeShifted.push(dt);
        else if (!afterSpace && !beforeShift && !isShiftedChar(prevCh) && !isShiftedChar(ch)) S.keyIntervals.push(dt);
      }
    } else if (same && after.length === before.length - 1) {
      if (!inCorrection) S.corrections++;
      inCorrection = true;
    } else if (!same && after.length >= 1) {
      S.typedChars++; // the first keystroke of a run
    }
    prevInput = { target: e.target, value: e.value, at: e.at, deleted: same && after.length < before.length };
    lastClickAt = null;
  }
}

function analysePointer(rec, S) {
  const moves = rec.filter((e) => e.kind === 'move');
  if (moves.length < 2) return;
  const dts = [];
  for (let i = 1; i < moves.length; i++) {
    const dt = moves[i].at - moves[i - 1].at;
    if (dt > 0 && dt < 50) dts.push(dt);
  }
  // The first sample of a movement arrives about one report interval after
  // the hand started; movement times are measured from there.
  const typicalDt = dts.length ? clampTo(median(dts), 4, 40) : 12;

  let history = [];   // moves since the last press/release
  let activity = [];  // non-move events since then (release, keys, wheel, navigation …)
  let lastRest = null;
  let lastUp = null;
  let lastDown = null;
  for (const e of rec) {
    if (e.kind === 'move') {
      history.push(e);
      continue;
    }
    if (e.kind === 'down') {
      const target = e.x !== null && e.y !== null ? { x: e.x, y: e.y } : history.length ? history[history.length - 1] : null;
      if (history.length >= 2 && target) analyseApproach(history, activity, lastRest, e, typicalDt, S);
      if (lastUp && e.detail === 2) {
        const gap = e.at - lastUp.at;
        if (gap > 0 && gap <= 1000) S.doubleClickGaps.push(gap);
      }
      lastDown = e;
      history = [];
      activity = [];
      if (target) lastRest = { x: target.x, y: target.y, at: e.at };
      continue;
    }
    if (e.kind === 'up') {
      if (lastDown) {
        // A press whose pointer travelled before the release was a drag — a
        // text selection, a slider, a DnD — and its hold is the carry, not a
        // click's hold. (Counted, one selection drag stretched pressHoldMs
        // toward a second.) A click drifts ≤ 1 px; allow the recorder's rounding.
        const hold = e.at - lastDown.at;
        const origin = lastDown.x !== null && lastDown.y !== null ? lastDown : null;
        const travel = origin
          ? Math.max(0, ...[...history, e].filter((q) => q.x !== null && q.y !== null).map((q) => Math.hypot(q.x - origin.x, q.y - origin.y)))
          : 0;
        if (hold > 0 && hold <= 1000 && travel <= CLICK_SLOP_PX) S.pressHolds.push(hold);
        lastDown = null;
      }
      lastUp = e;
      history = [];
      activity = [];
      if (e.x !== null && e.y !== null) lastRest = { x: e.x, y: e.y, at: e.at };
    }
    activity.push({ at: e.at, kind: e.kind });
  }
}

/**
 * The aimed movement that ended in a press, out of everything the pointer did
 * since the previous press or release.
 *
 * The history is cut into stretches of motion at every stillness (> STILL_MS).
 * Stretches at the end that only shift the pointer a pixel or three are the
 * settle drift of the dwell; the stretch before them is the approach — its
 * start is where the pointer rested before it. (Cutting at the first tiny move
 * after a stillness instead would lose late settles, and stitching tiny moves
 * onto older motion would glue a movement's slow start to a scroll drift from
 * seconds earlier.) Inside the approach, samples after a short stop that move
 * ≤ SETTLE_PX are an early settle, not the approach either. A distance rule —
 * "arrived once within 4 px" — would cut off the slow minimum-jerk tail and
 * under-measure movement time by 10–20 %.
 */
function analyseApproach(history, activity, lastRest, down, typicalDt, S) {
  const segs = [[history[0]]];
  for (let i = 1; i < history.length; i++) {
    if (history[i].at - history[i - 1].at > STILL_MS) segs.push([]);
    segs[segs.length - 1].push(history[i]);
  }
  let k = segs.length - 1;
  let settled = false;
  while (k > 0) {
    const ref = segs[k - 1][segs[k - 1].length - 1];
    if (!segs[k].every((q) => Math.hypot(q.x - ref.x, q.y - ref.y) <= SETTLE_PX)) break;
    k--;
    settled = true;
  }
  const approach = segs[k];
  let end = approach.length - 1;
  while (end > 0 && approach[end].at - approach[end - 1].at >= STOP_MS
    && Math.hypot(approach[end].x - approach[end - 1].x, approach[end].y - approach[end - 1].y) <= SETTLE_PX) {
    end--;
    settled = true;
  }
  const before = k > 0 ? segs[k - 1][segs[k - 1].length - 1] : null;
  const start = before ?? (lastRest && approach[0].at - lastRest.at <= 5000 ? lastRest : approach[0]);
  const arrive = approach[end];
  const D = Math.hypot(arrive.x - start.x, arrive.y - start.y);
  const startAt = approach[0].at - typicalDt;
  const MT = arrive.at - startAt;
  if (D < 20 || !(MT > 0) || MT >= 5000) return;

  S.movements.push({ D, MT, W: down.size ? Math.min(down.size.w, down.size.h) : null, ...shapeOf([start, ...approach.slice(0, end + 1)], D) });
  for (let i = 1; i <= end; i++) {
    const dt = approach[i].at - approach[i - 1].at;
    if (dt > 0 && dt < 50) S.moveIntervals.push(dt);
  }
  const dwell = down.at - arrive.at;
  if (dwell >= 0 && dwell <= 5000) S.dwells.push(dwell);
  if (settled) S.settles++;

  // Think time: from the latest thing the person did (a release, a key, a
  // wheel notch, a navigation, or earlier pointer motion) to the approach.
  const acts = activity.filter((a) => a.at <= startAt);
  const lastAct = acts.length ? acts[acts.length - 1] : null;
  const latest = Math.max(before ? before.at : -Infinity, lastAct ? lastAct.at : -Infinity);
  if (!Number.isFinite(latest)) return;
  const idle = startAt - latest;
  if (idle < 0 || idle > 10000) return;
  if (lastAct && lastAct.at === latest && lastAct.kind === 'navigate') S.navigationGaps.push(idle);
  else S.actionGaps.push(idle);
}

/**
 * Curvature and overshoot of one movement path.
 *
 * The curvature is fitted as the planner draws it: a cubic Bézier whose two
 * control points are pushed perpendicular by o1 and o2. With the control
 * points near ⅓ and ⅔ of the way, the fraction of the distance covered is
 * (almost exactly) the Bézier parameter s, so each sample's perpendicular
 * offset is o1·3(1−s)²s + o2·3(1−s)s² — linear in (o1, o2), solved by least
 * squares. Counting "S-shaped" paths instead undercounts badly: when the two
 * offsets differ in size one lobe of the S hides in the tremor.
 */
function shapeOf(path, D) {
  const a = path[0];
  const z = path[path.length - 1];
  const ux = (z.x - a.x) / D;
  const uy = (z.y - a.y) / D;
  let maxAlong = 0;
  let s11 = 0;
  let s12 = 0;
  let s22 = 0;
  let r1 = 0;
  let r2 = 0;
  for (const p of path) {
    const rx = p.x - a.x;
    const ry = p.y - a.y;
    const perp = -uy * rx + ux * ry;
    const along = ux * rx + uy * ry;
    maxAlong = Math.max(maxAlong, along);
    const s = clampTo(along / D, 0, 1);
    const b1 = 3 * (1 - s) * (1 - s) * s;
    const b2 = 3 * (1 - s) * s * s;
    s11 += b1 * b1;
    s12 += b1 * b2;
    s22 += b2 * b2;
    r1 += b1 * perp;
    r2 += b2 * perp;
  }
  const det = s11 * s22 - s12 * s12;
  const offsets = det > 1e-9 ? [(r1 * s22 - r2 * s12) / det / D, (r2 * s11 - r1 * s12) / det / D] : null;
  return { offsets, overshoot: maxAlong / D - 1 };
}

function analyseWheel(rec, S) {
  const wheels = rec.filter((e) => e.kind === 'wheel' && (e.deltaY !== 0 || e.deltaX !== 0));
  if (!wheels.length) return;
  for (const w of wheels) {
    if (w.deltaMode !== 0) S.wheelLineMode++;
    else S.wheelDeltas.push(Math.abs(w.deltaY !== 0 ? w.deltaY : w.deltaX));
  }
  const dts = [];
  for (let i = 1; i < wheels.length; i++) dts.push(wheels[i].at - wheels[i - 1].at);
  const split = dts.filter((d) => d > 0 && d <= EPISODE_GAP_MS);
  const threshold = burstThreshold(split);
  // Too few intervals to tell a notch interval from a between-burst pause:
  // counting them all as notch intervals would fit the pauses into the cadence.
  const cadenceKnown = threshold !== null || split.length >= BURST_SPLIT_MIN;
  // This recording's bursts, kept only if they were identifiable.
  const bursts = [];

  let burst = 1;
  let episode = [wheels[0]];
  const closeEpisode = () => {
    if (!episode.length) return;
    S.scrollEpisodes++;
    const signs = episode.map((w) => Math.sign(w.deltaY || w.deltaX));
    const flip = signs.findIndex((s, i) => i > 0 && s !== signs[0]);
    if (flip > 0 && signs.slice(flip).every((s) => s === signs[flip]) && signs.length - flip <= 4) S.scrollBacks++;
  };
  for (let i = 1; i < wheels.length; i++) {
    const dt = wheels[i].at - wheels[i - 1].at;
    if (dt > EPISODE_GAP_MS) {
      bursts.push(burst);
      burst = 1;
      closeEpisode();
      episode = [wheels[i]];
      continue;
    }
    episode.push(wheels[i]);
    if (threshold !== null && dt >= threshold) {
      bursts.push(burst);
      burst = 1;
      S.wheelPauses.push(dt);
    } else {
      burst++;
      if (dt > 0 && cadenceKnown) S.wheelIntervals.push(dt);
    }
  }
  bursts.push(burst);
  closeEpisode();
  // Bursts that could not be told apart are not samples — of this recording.
  // (This used to empty S.wheelBursts, discarding every EARLIER recording's
  // bursts too.)
  if (threshold !== null) S.wheelBursts.push(...bursts);
}

/**
 * Split intervals into "within a burst" and "between bursts": two-cluster
 * k-means on log(dt). null when there is no clear second cluster.
 */
const BURST_SPLIT_MIN = 6;
function burstThreshold(dts) {
  if (dts.length < BURST_SPLIT_MIN) return null;
  const logs = dts.map(Math.log);
  let c1 = quantile(logs, 0.25);
  let c2 = quantile(logs, 0.9);
  for (let it = 0; it < 30; it++) {
    const a = [];
    const b = [];
    for (const l of logs) (Math.abs(l - c1) <= Math.abs(l - c2) ? a : b).push(l);
    if (!a.length || !b.length) return null;
    const n1 = mean(a);
    const n2 = mean(b);
    if (n1 === c1 && n2 === c2) break;
    c1 = n1;
    c2 = n2;
  }
  if (c2 - c1 < Math.log(1.8)) return null;
  return Math.exp((c1 + c2) / 2);
}

// ----------------------------------------------------------------- fitting

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isPlainObject(o[keys[i]])) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Does a validation message name this parameter path (whole, not as a prefix of a longer one)? */
function mentions(message, path) {
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\w.])' + esc + '(?!\\w)').test(message);
}

/**
 * fitProfile(rawEvents, base = 'human', { name }?) → { profile, samples, report }
 *
 * `profile` is a complete, validated profile (base + fitted values) carrying a
 * `calibration` record: base, recordings, events, samples, fitted and kept
 * parameter paths. `samples` counts what each fit saw. `report` is plain text
 * for a person: what was fitted, from how many samples, and what was kept and why.
 */
export function fitProfile(rawEvents, base = 'human', { name } = {}) {
  const baseProfile = resolveProfile(base);
  const recordings = toRecordings(rawEvents);
  const S = emptySamples();
  const eventCount = recordings.reduce((n, r) => n + r.length, 0);
  const hasKeydowns = recordings.some((r) => r.some((e) => e.kind === 'keydown'));
  const hasMoves = recordings.some((r) => r.filter((e) => e.kind === 'move').length >= 2);
  const hasWheel = recordings.some((r) => r.some((e) => e.kind === 'wheel'));
  const hasDownUp = recordings.some((r) => r.some((e) => e.kind === 'down'));
  const hasInputs = recordings.some((r) => r.some((e) => e.kind === 'input'));

  for (const rec of recordings) {
    // Per recording: a v1 recording (input values) fitted alongside a v2 one
    // (keydown samples) must still contribute its typing.
    analyseKeys(rec, S, rec.some((e) => e.kind === 'keydown'));
    analysePointer(rec, S);
    analyseWheel(rec, S);
  }

  const patch = {};
  const fitted = [];
  const kept = [];
  const lines = [];
  const fit = (path, value, how) => {
    setPath(patch, path, value);
    fitted.push(path);
    lines.push('  ' + path + ' = ' + JSON.stringify(value) + '  (' + how + ')');
  };
  const keep = (paths, why) => {
    const list = Array.isArray(paths) ? paths : [paths];
    kept.push(...list);
    lines.push('  kept ' + list.join(', ') + ' — ' + why);
  };
  const need = (have, min, what) => (have >= min ? null : have + ' ' + what + ' (need ' + min + ')');

  // ---------------------------------------------------------- keyboard
  lines.push('Keyboard' + (hasKeydowns ? ' (from keydown/keyup events)' : hasInputs ? ' (from per-keystroke input values — v1 recorder)' : ''));
  const base_ = baseProfile.keyboard;
  {
    const why = need(S.keyIntervals.length, MIN_SAMPLES.keyIntervals, 'plain inter-key intervals');
    let medianFit = null;
    if (!why) {
      const f = logNormalFit(S.keyIntervals);
      medianFit = f.median;
      fit('keyboard.ikiMedianMs', r1(clampTo(f.median, 20, 3000)), 'log-normal median of ' + S.keyIntervals.length + ' intervals');
      fit('keyboard.ikiSigma', r3(clampTo(f.sigma, 0.05, 1.5)), 'σ of ln(interval)');
    } else keep(['keyboard.ikiMedianMs', 'keyboard.ikiSigma'], why);
    const ref = medianFit ?? base_.ikiMedianMs;
    const w1 = need(S.afterSpace.length, MIN_SAMPLES.classIntervals, 'intervals after space/punctuation');
    if (!w1 && medianFit) fit('keyboard.afterSpaceOrPunct', r3(clampTo(logNormalFit(S.afterSpace).median / ref, 0.5, 5)), S.afterSpace.length + ' intervals');
    else keep('keyboard.afterSpaceOrPunct', w1 ?? 'needs the base interval fitted first');
    const w2 = need(S.beforeShifted.length, MIN_SAMPLES.classIntervals, 'intervals before a shifted character');
    if (!w2 && medianFit) fit('keyboard.beforeShifted', r3(clampTo(logNormalFit(S.beforeShifted).median / ref, 0.5, 6)), S.beforeShifted.length + ' intervals');
    else keep('keyboard.beforeShifted', w2 ?? 'needs the base interval fitted first');
  }
  {
    const why = hasKeydowns ? need(S.keyHolds.length, MIN_SAMPLES.keyHolds, 'key holds') : 'key-up events were not recorded';
    if (!why) {
      const f = logNormalFit(S.keyHolds);
      fit('keyboard.holdMedianMs', r1(clampTo(f.median, 10, 1000)), 'log-normal median of ' + S.keyHolds.length + ' holds');
      fit('keyboard.holdSigma', r3(clampTo(f.sigma, 0.05, 1.5)), 'σ of ln(hold)');
    } else keep(['keyboard.holdMedianMs', 'keyboard.holdSigma'], why);
    const w1 = hasKeydowns ? need(S.shiftLead.length, MIN_SAMPLES.shiftTimings, 'Shift→character leads') : 'Shift key events were not recorded';
    if (!w1) fit('keyboard.shiftLeadMs', spread(S.shiftLead, 0, 1000), S.shiftLead.length + ' samples, p5–p95');
    else keep('keyboard.shiftLeadMs', w1);
    const w2 = hasKeydowns ? need(S.shiftTrail.length, MIN_SAMPLES.shiftTimings, 'character→Shift-release trails') : 'Shift key events were not recorded';
    if (!w2) fit('keyboard.shiftTrailMs', spread(S.shiftTrail, 0, 1000), S.shiftTrail.length + ' samples, p5–p95');
    else keep('keyboard.shiftTrailMs', w2);
  }
  {
    const why = need(S.thinkGaps.length, MIN_SAMPLES.thinkGaps, 'click→first-key gaps');
    if (!why) fit('keyboard.thinkMs', spread(S.thinkGaps, 0, 10000), S.thinkGaps.length + ' gaps, p5–p95');
    else keep('keyboard.thinkMs', why);
    const w2 = need(S.typedChars, MIN_SAMPLES.typedChars, 'typed characters');
    if (!w2) {
      fit('keyboard.typoRate', r3(clampTo(S.corrections / S.typedChars, 0, 0.1)),
        S.corrections + ' correction runs / ' + S.typedChars + ' characters — an upper bound: deliberate edits count too');
    } else keep('keyboard.typoRate', w2);
    const w3 = need(S.formKeyGaps.length, MIN_SAMPLES.formKeyGaps, 'Tab→next-key gaps');
    if (!w3) fit('gaps.betweenFormKeysMs', spread(S.formKeyGaps, 0, 10000), S.formKeyGaps.length + ' gaps, p5–p95');
    else keep('gaps.betweenFormKeysMs', w3);
  }

  // ---------------------------------------------------------- pointer
  lines.push('Pointer' + (hasMoves ? ' (from pointer paths)' : ''));
  const M = baseProfile.mouse;
  if (!hasMoves) {
    keep(['mouse.fitts', 'mouse.durationJitter', 'mouse.curvature', 'mouse.overshoot', 'mouse.sampleIntervalMs', 'mouse.dwellMs', 'mouse.settle', 'gaps.betweenActionsMs', 'gaps.afterNavigationMs'],
      'pointer paths were not recorded (the v1 recorder keeps clicks, not mouse moves); movement time, curvature and think time between actions cannot be separated from click timestamps alone');
  } else {
    const aimed = S.movements;
    const why = need(aimed.length, MIN_SAMPLES.movements, 'aimed movements ending in a press');
    if (!why) {
      const withW = aimed.filter((m) => m.W);
      const useW = withW.length >= MIN_SAMPLES.movements;
      const rows = (useW ? withW : aimed).map((m) => ({ x: Math.log2(m.D / (useW ? m.W : M.defaultTargetPx) + 1), y: m.MT }));
      const mx = mean(rows.map((r) => r.x));
      const my = mean(rows.map((r) => r.y));
      const vx = mean(rows.map((r) => (r.x - mx) ** 2));
      const b = vx > 1e-6 ? mean(rows.map((r) => (r.x - mx) * (r.y - my))) / vx : NaN;
      const a = my - b * mx;
      if (vx < 0.1) keep(['mouse.fitts.a', 'mouse.fitts.b'], 'the recorded movements barely vary in difficulty (distance/size), so a and b cannot be separated');
      else if (!(b > 0) || !(a >= 0)) keep(['mouse.fitts.a', 'mouse.fitts.b'], 'the least-squares fit came out non-physical (a=' + r1(a) + ', b=' + r1(b) + ')');
      else {
        const how = rows.length + ' movements' + (useW ? '' : '; target sizes were not recorded, so W = ' + M.defaultTargetPx + ' px was assumed');
        fit('mouse.fitts.a', r1(clampTo(a, 0, 3000)), 'least squares, ' + how);
        fit('mouse.fitts.b', r1(clampTo(b, 1, 3000)), 'least squares');
        fit('mouse.durationScale', 1, 'a and b are this person’s own times');
        const ratios = rows.map((r) => r.y / Math.max(1, a + b * r.x));
        const jitter = [r3(clampTo(quantile(ratios, 0.05), 0.3, 1)), r3(clampTo(quantile(ratios, 0.95), 1, 3))];
        fit('mouse.durationJitter', jitter, 'residual ratio p5–p95');
        const mts = rows.map((r) => r.y);
        const lo = Math.min(M.fitts.minMs, r1(quantile(mts, 0.05) / jitter[1]));
        const hi = Math.max(M.fitts.maxMs, r1(quantile(mts, 0.95) / jitter[0]));
        if (lo !== M.fitts.minMs) fit('mouse.fitts.minMs', Math.max(0, lo), 'observed movements are quicker than the base clamp');
        if (hi !== M.fitts.maxMs) fit('mouse.fitts.maxMs', hi, 'observed movements are slower than the base clamp');
      }
    } else keep(['mouse.fitts', 'mouse.durationJitter'], why);

    // Curvature from paths that did not overshoot (the correction hook would
    // read as a bend) and are long enough for a bend to rise above tremor.
    const curved = aimed.filter((m) => m.D >= 100 && m.offsets && m.overshoot <= 0.015);
    const wc = need(curved.length, MIN_SAMPLES.curvedMovements, 'non-overshooting movements of ≥ 100 px');
    if (!wc) {
      const same = curved.filter((m) => Math.sign(m.offsets[0]) === Math.sign(m.offsets[1])).length;
      fit('mouse.curvature.sameSideChance', r3(same / curved.length), same + ' of ' + curved.length + ' paths bend one way (least-squares Bézier fit)');
      const offs = curved.flatMap((m) => m.offsets.map(Math.abs));
      const lo = r3(clampTo(quantile(offs, 0.05), 0, 0.6));
      fit('mouse.curvature.offset', [lo, r3(clampTo(quantile(offs, 0.95), lo, 1))], 'fitted control-point offsets of ' + curved.length + ' paths, p5–p95');
    } else keep('mouse.curvature', wc);

    const long = aimed.filter((m) => m.D > M.overshoot.minDistance);
    const wo = need(long.length, MIN_SAMPLES.longMovements, 'movements longer than ' + M.overshoot.minDistance + ' px');
    if (!wo) {
      const overs = long.filter((m) => m.overshoot > 0.015);
      fit('mouse.overshoot.chance', r3(overs.length / long.length), overs.length + ' of ' + long.length + ' long movements overshot');
      if (overs.length >= MIN_SAMPLES.overshoots) {
        const f = overs.map((m) => m.overshoot);
        const lo = r3(clampTo(quantile(f, 0.05), 0.005, 0.3));
        fit('mouse.overshoot.fraction', [lo, r3(clampTo(quantile(f, 0.95), lo, 0.4))], overs.length + ' overshoots, p5–p95');
      } else keep('mouse.overshoot.fraction', need(overs.length, MIN_SAMPLES.overshoots, 'overshoots'));
    } else keep('mouse.overshoot', wo);

    const wi = need(S.moveIntervals.length, MIN_SAMPLES.moveIntervals, 'move-to-move intervals');
    if (wi) keep('mouse.sampleIntervalMs', wi);
    else if (quantile(S.moveIntervals, 0.02) >= 15) {
      // tools/record.js keeps at most one move per 16 ms: what the recording
      // shows is that throttle, not the person's mouse.
      keep('mouse.sampleIntervalMs', 'no two moves were recorded closer than ~16 ms — the recorder throttles pointer samples, so the mouse’s own report rate is not visible');
    } else fit('mouse.sampleIntervalMs', spread(S.moveIntervals, 1, 100), S.moveIntervals.length + ' intervals, p5–p95 (the recording mouse’s report rate)');

    const wd = need(S.dwells.length, MIN_SAMPLES.dwells, 'arrival→press dwells');
    if (!wd) {
      fit('mouse.dwellMs', spread(S.dwells, 0, 5000), S.dwells.length + ' dwells, p5–p95');
      fit('mouse.settle.chance', r3(S.settles / S.dwells.length), S.settles + ' of ' + S.dwells.length + ' dwells moved');
    } else keep(['mouse.dwellMs', 'mouse.settle.chance'], wd);

    // The idle before a movement is think time PLUS the planner's own pre-move
    // idle; a recording cannot tell the two apart, so the base pre-move mean is
    // taken off and the pre-move range itself is kept.
    const pre = mean(M.preMoveMs);
    const wa = need(S.actionGaps.length, MIN_SAMPLES.actionGaps, 'idle gaps before a movement');
    if (!wa) fit('gaps.betweenActionsMs', spread(S.actionGaps.map((g) => Math.max(0, g - pre)), 0, 60000), S.actionGaps.length + ' idle gaps minus the ' + r1(pre) + ' ms pre-move idle, p5–p95');
    else keep('gaps.betweenActionsMs', wa);
    const wn = need(S.navigationGaps.length, MIN_SAMPLES.navigationGaps, 'navigation→first-movement gaps');
    if (!wn) fit('gaps.afterNavigationMs', spread(S.navigationGaps.map((g) => Math.max(0, g - pre)), 0, 60000), S.navigationGaps.length + ' gaps minus the pre-move idle, p5–p95');
    else keep('gaps.afterNavigationMs', wn);
  }
  {
    const wp = hasDownUp ? need(S.pressHolds.length, MIN_SAMPLES.pressHolds, 'press→release holds') : 'button down/up events were not recorded';
    if (!wp) fit('mouse.pressHoldMs', spread(S.pressHolds, 1, 1000), S.pressHolds.length + ' holds, p5–p95');
    else keep('mouse.pressHoldMs', wp);
    const wg = hasDownUp ? need(S.doubleClickGaps.length, MIN_SAMPLES.doubleClickGaps, 'double-click gaps') : 'button down/up events were not recorded';
    if (!wg) fit('mouse.doubleClickGapMs', spread(S.doubleClickGaps, 1, 1000), S.doubleClickGaps.length + ' gaps, p5–p95');
    else keep('mouse.doubleClickGapMs', wg);
  }

  // ---------------------------------------------------------- wheel
  lines.push('Wheel' + (hasWheel ? ' (from wheel events)' : ''));
  if (!hasWheel) {
    keep('wheel', 'wheel events were not recorded (the v1 recorder keeps throttled scroll positions, not wheel notches)');
  } else {
    const deltas = S.wheelDeltas.map((d) => Math.round(d));
    const wn = need(deltas.length, MIN_SAMPLES.wheelEvents, 'pixel-mode wheel events');
    if (!wn) {
      const counts = new Map();
      for (const d of deltas) counts.set(d, (counts.get(d) ?? 0) + 1);
      const [mode, n] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
      if (n / deltas.length >= 0.6 && mode >= 1) fit('wheel.notchPx', mode, n + ' of ' + deltas.length + ' events were ' + mode + ' px');
      else keep('wheel.notchPx', 'the deltas do not share one notch size (a touchpad or smooth-scrolling mouse?) — the most common was ' + mode + ' px in ' + n + ' of ' + deltas.length);
    } else keep('wheel.notchPx', wn + (S.wheelLineMode ? '; ' + S.wheelLineMode + ' events were in line mode' : ''));
    const wi = need(S.wheelIntervals.length, MIN_SAMPLES.wheelIntervals, 'within-burst notch intervals');
    if (!wi) fit('wheel.notchIntervalMs', spread(S.wheelIntervals, 1, 5000), S.wheelIntervals.length + ' intervals, p5–p95');
    else keep('wheel.notchIntervalMs', wi);
    const wb = need(S.wheelBursts.length, MIN_SAMPLES.wheelBursts, 'identifiable bursts');
    if (!wb) fit('wheel.burst', spread(S.wheelBursts, 1, 100), S.wheelBursts.length + ' bursts, p5–p95 notches');
    else keep('wheel.burst', wb);
    const wp = need(S.wheelPauses.length, MIN_SAMPLES.wheelPauses, 'between-burst pauses');
    if (!wp) fit('wheel.burstPauseMs', spread(S.wheelPauses, 0, 20000), S.wheelPauses.length + ' pauses, p5–p95');
    else keep('wheel.burstPauseMs', wp);
    const we = need(S.scrollEpisodes, MIN_SAMPLES.scrollEpisodes, 'scroll episodes');
    if (!we) fit('wheel.overshootChance', r3(S.scrollBacks / S.scrollEpisodes), S.scrollBacks + ' of ' + S.scrollEpisodes + ' scrolls came back');
    else keep('wheel.overshootChance', we);
  }

  // ---------------------------------------------------------- assemble
  const samples = {
    recordings: recordings.length,
    events: eventCount,
    keyIntervals: S.keyIntervals.length,
    afterSpaceIntervals: S.afterSpace.length,
    beforeShiftedIntervals: S.beforeShifted.length,
    keyHolds: S.keyHolds.length,
    shiftLeads: S.shiftLead.length,
    shiftTrails: S.shiftTrail.length,
    thinkGaps: S.thinkGaps.length,
    typedChars: S.typedChars,
    corrections: S.corrections,
    formKeyGaps: S.formKeyGaps.length,
    movements: S.movements.length,
    moveIntervals: S.moveIntervals.length,
    dwells: S.dwells.length,
    pressHolds: S.pressHolds.length,
    doubleClickGaps: S.doubleClickGaps.length,
    wheelEvents: S.wheelDeltas.length + S.wheelLineMode,
    wheelBursts: S.wheelBursts.length,
    wheelPauses: S.wheelPauses.length,
    scrollEpisodes: S.scrollEpisodes,
    actionGaps: S.actionGaps.length,
    navigationGaps: S.navigationGaps.length,
  };

  const candidate = deepMerge(clone(baseProfile), patch);
  // A fitted value that still breaks a cross-field rule goes back to the base, and says so.
  for (let guard = 0; guard < 8; guard++) {
    const problems = validateProfile({ ...candidate, calibration: null });
    if (!problems.length) break;
    for (const p of problems) {
      const path = fitted.find((f) => mentions(p, f));
      if (!path) continue;
      setPath(candidate, path, clone(getPath(baseProfile, path)));
      fitted.splice(fitted.indexOf(path), 1);
      kept.push(path);
      lines.push('  kept ' + path + ' — the fitted value failed validation: ' + p);
    }
  }

  const baseName = baseProfile.name;
  candidate.name = name || baseName + '-calibrated';
  // The candidate is complete, so its merge base only has to be resolvable
  // without a library: the built-in it descends from.
  const builtIn = (n) => typeof n === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, n);
  candidate.base = builtIn(baseName) ? baseName : builtIn(baseProfile.base) ? baseProfile.base : 'human';
  candidate.description = 'Calibrated from ' + recordings.length + ' recording' + (recordings.length === 1 ? '' : 's')
    + ' (' + eventCount + ' events) on ' + baseName + '; ' + fitted.length + ' parameter' + (fitted.length === 1 ? '' : 's') + ' fitted.';
  candidate.calibration = { base: baseName, recordings: recordings.length, events: eventCount, samples, fitted: fitted.slice(), kept: [...new Set(kept)] };
  const profile = resolveProfile(candidate);

  const head = [
    'Calibration of "' + profile.name + '" from ' + recordings.length + ' recording' + (recordings.length === 1 ? '' : 's') + ', ' + eventCount + ' usable events (base: ' + baseName + ').',
    fitted.length
      ? fitted.length + ' parameter' + (fitted.length === 1 ? '' : 's') + ' fitted; everything else is the base profile’s.'
      : 'Nothing could be fitted: the profile is the base profile unchanged.',
  ];
  return { profile, samples, report: [...head, ...lines].join('\n') };
}
