/**
 * Pointer planning: where on a target to aim, the path there, and the press.
 *
 * The model (plan §6.1), in the order a hand does it:
 *
 *   idle → curved, bell-velocity move (Fitts-timed, sometimes overshooting)
 *        → dwell on arrival (sometimes a 1–3 px settle) → press → hold → release
 *
 * - A path is a cubic Bézier whose control points sit 30–40 % and 60–70 % of
 *   the way along, pushed perpendicular by 10–25 % of the distance. Straight
 *   lines at constant speed are the single most obvious machine signature.
 * - Duration is Fitts' law, MT = a + b·log2(D/W + 1): far and small is slow,
 *   near and large is quick. Then clamped, scaled by the profile, jittered.
 * - Time along the path follows minimum jerk, s(τ) = 10τ³ − 15τ⁴ + 6τ⁵: the
 *   bell-shaped velocity of human reaching (slow start, fast middle, slow end).
 * - Samples every 8–16 ms on the device-pixel grid (integer CSS px at 100 %
 *   scaling, multiples of 1/dpr otherwise — plan.js gridOf), a little Gaussian
 *   tremor on intermediate samples, and the final sample EXACTLY on the target.
 * - A target outside the viewport is refused (RangeError), never reached by a
 *   jump from the edge: scroll it into view first (plan §6.1, wheel.js).
 * - Press and release land on the same point (≤ 1 px): any more and the
 *   browser starts a drag instead of a click.
 *
 * Coordinates are CSS pixels in the space Input.dispatchMouseEvent expects for
 * the session the plan is dispatched on (top-level viewport, or the frame's
 * own space for an out-of-process iframe session — interact.js decides).
 */

import {
  PlanBuilder, clamp, requireBox, requirePoint, viewportOf, clampToViewport, initialPointer, nudge,
  gridOf, snap, snapPoint, requireReachable,
} from './plan.js';
import { modifierMask, modifierList, pressModifiers, releaseModifiers } from './keys.js';

/** CDP `buttons` bits. */
export const BUTTONS = Object.freeze({ none: 0, left: 1, right: 2, middle: 4, back: 8, forward: 16 });

/** The button a mouseMoved reports for a held-buttons mask ('none' when nothing is held). */
export function buttonName(mask) {
  if (mask & 1) return 'left';
  if (mask & 2) return 'right';
  if (mask & 4) return 'middle';
  if (mask & 8) return 'back';
  if (mask & 16) return 'forward';
  return 'none';
}

function buttonMask(button) {
  // Own properties only: button "toString" is unknown, not Object.prototype's function as a mask.
  const m = Object.prototype.hasOwnProperty.call(BUTTONS, button) ? BUTTONS[button] : undefined;
  if (m === undefined || m === 0) throw new TypeError('Unknown mouse button "' + button + '". Use left, right, middle, back or forward.');
  return m;
}

/** Minimum-jerk position profile: 0 → 1 with zero velocity and acceleration at both ends. */
export function minimumJerk(tau) {
  const t = clamp(tau, 0, 1);
  return t * t * t * (10 - 15 * t + 6 * t * t);
}

/**
 * Fitts' law movement time in ms, clamped to the profile's [minMs, maxMs] —
 * BEFORE the profile's durationScale and the per-move jitter are applied.
 * W is the smaller side of the target; unknown or zero sizes use
 * profile.mouse.defaultTargetPx.
 */
export function fittsDuration(profile, distance, width) {
  const f = profile.mouse.fitts;
  const W = Number.isFinite(width) && width >= 1 ? width : profile.mouse.defaultTargetPx;
  const D = Number.isFinite(distance) && distance > 0 ? distance : 0;
  return clamp(f.a + f.b * Math.log2(D / W + 1), f.minMs, f.maxMs);
}

function bezier(p0, c1, c2, p3, s) {
  const u = 1 - s;
  const a = u * u * u;
  const b = 3 * u * u * s;
  const c = 3 * u * s * s;
  const d = s * s * s;
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p3.x, y: a * p0.y + b * c1.y + c * c2.y + d * p3.y };
}

const same = (a, b) => a && b && a.x === b.x && a.y === b.y;
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

// ------------------------------------------------------------ target point

function intersect(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 >= x0 && y1 >= y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

function shrink(box, keep) {
  const w = box.width * keep;
  const h = box.height * keep;
  return { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h };
}

const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/**
 * The region a click on `box` may land in: the inner 70 % of the box,
 * clipped to the viewport; when that is empty (a box mostly off-screen), the
 * inner 70 % of the visible part; null when nothing of the box is visible.
 */
function aimRegion(profile, box, viewport) {
  const vp = viewportOf(viewport);
  const screen = vp ? { x: 0, y: 0, width: vp.width, height: vp.height } : { x: 0, y: 0, width: Infinity, height: Infinity };
  const visible = intersect(box, screen);
  if (!visible) return null;
  const keep = profile.mouse.target.inner;
  return intersect(shrink(box, keep), visible) ?? shrink(visible, keep);
}

/**
 * pickTargetPoint(rng, profile, box, viewport) → {x, y}
 *
 * Not the centre: a sample from a 2-D Gaussian centred on the box centre with
 * σ = 15 % of its width/height, truncated to the inner 70 % of the box and to
 * the part of it inside the viewport. When the centre itself is off-screen the
 * Gaussian is centred on the visible region instead. The point is on the
 * pointer grid (integers, or multiples of 1/dpr — see gridOf): the grid point
 * inside the region when there is one, else the nearest (a box narrower than
 * one device pixel has no grid point inside it).
 *
 * A box with nothing visible yields its (off-screen) centre, which the
 * planners then refuse: scrolling it into view is the caller's job (plan §6.1 —
 * by wheel, never scrollIntoView in the human levels).
 * Direct (off): the centre, unrounded — v1's pointFor.
 */
export function pickTargetPoint(rng, profile, box, viewport) {
  const b = requireBox(box);
  const centre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  if (profile.direct) return centre;
  const grid = gridOf(viewport);

  const region = aimRegion(profile, b, viewport);
  if (!region) return snapPoint(centre, grid);

  const onCentre = inside(centre, region);
  const mx = onCentre ? centre.x : region.x + region.width / 2;
  const my = onCentre ? centre.y : region.y + region.height / 2;
  const sx = profile.mouse.target.sigma * (onCentre ? b.width : region.width);
  const sy = profile.mouse.target.sigma * (onCentre ? b.height : region.height);

  let p = null;
  for (let i = 0; i < 16 && !p; i++) {
    const q = { x: rng.normal(mx, sx), y: rng.normal(my, sy) };
    if (inside(q, region)) p = q;
  }
  if (!p) p = { x: clamp(rng.normal(mx, sx), region.x, region.x + region.width), y: clamp(rng.normal(my, sy), region.y, region.y + region.height) };

  // A grid point inside the region on each axis when one exists.
  const onGrid = (v, lo, hi) => {
    const r = snap(v, grid);
    if (r >= lo && r <= hi) return r;
    const c = snap(Math.ceil(lo / grid - 1e-9) * grid, grid);
    return c <= hi ? c : r;
  };
  const q = { x: onGrid(p.x, region.x, region.x + region.width), y: onGrid(p.y, region.y, region.y + region.height) };
  // The last addressable position is one grid step inside the viewport edge
  // (a box touching the right edge must not aim at x = width).
  return viewportOf(viewport) ? clampToViewport(q, viewport, grid) : q;
}

// ------------------------------------------------------------------ paths

/**
 * One Bézier segment from p0 to p3 over `duration` ms, appended to the
 * builder starting at its clock. The last sample is exactly p3.
 */
function appendSegment(b, rng, profile, p0, p3, duration, { buttons, modifiers, viewport, minSamples = 0 }) {
  const M = profile.mouse;
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const D = Math.hypot(dx, dy);
  const button = buttonName(buttons);
  const start = b.t;

  const ux = D > 0 ? dx / D : 0;
  const uy = D > 0 ? dy / D : 0;
  const s1 = rng.sign();
  const s2 = rng.chance(M.curvature.sameSideChance) ? s1 : -s1;
  const o1 = D * rng.range(...M.curvature.offset) * s1;
  const o2 = D * rng.range(...M.curvature.offset) * s2;
  const a1 = rng.range(...M.curvature.along1);
  const a2 = rng.range(...M.curvature.along2);
  const c1 = { x: p0.x + dx * a1 - uy * o1, y: p0.y + dy * a1 + ux * o1 };
  const c2 = { x: p0.x + dx * a2 - uy * o2, y: p0.y + dy * a2 + ux * o2 };

  // The movement ends on the first sample at or after the planned time, so
  // every interval — the last one included — is a real 8–16 ms sample
  // interval; the movement is at most one interval longer than planned. A
  // drag that needs more samples than that simply takes a few more real
  // intervals (it used to fall back to evenly spaced samples — a metronome no
  // mouse produces).
  const times = [];
  let clock = 0;
  do {
    clock += rng.int(...M.sampleIntervalMs);
    times.push(clock);
  } while (clock < duration || times.length < minSamples);
  const total = clock;

  const samples = times.map((t, i) => {
    const last = i === times.length - 1;
    if (last) return { t, p: { x: p3.x, y: p3.y } };
    const q = bezier(p0, c1, c2, p3, minimumJerk(t / total));
    if (M.jitterPx > 0) {
      q.x += rng.normal(0, M.jitterPx);
      q.y += rng.normal(0, M.jitterPx);
    }
    return { t, p: clampToViewport(q, viewport, b.grid) };
  });

  // A mouse reports movement, not stillness: drop samples that did not move —
  // unless that would leave fewer than the caller needs (drag).
  let prev = b.pos ? snapPoint(b.pos, b.grid) : null;
  const moving = samples.filter((s, i) => {
    const keep = i === samples.length - 1 || !same(s.p, prev);
    if (keep) prev = s.p;
    return keep;
  });
  const use = moving.length >= minSamples ? moving : samples;
  for (const s of use) b.mouse('mouseMoved', s.p.x, s.p.y, { button, buttons, clickCount: 0, modifiers }, start + s.t);
  b.t = start + total;
  b.pos = { x: p3.x, y: p3.y };
}

/**
 * Move the builder's pointer to `to`. Returns what happened, for plan.meta.
 * Options: targetSize {w,h}, buttons (held mask), modifiers, viewport,
 * preMove (idle first; default true), overshoot (allowed; default true),
 * durationFactor (drag's 1.5), minSamples.
 */
export function appendMove(b, rng, profile, to, {
  targetSize = null, buttons = 0, modifiers = 0, viewport = null,
  preMove = true, overshoot = true, durationFactor = 1, minSamples = 0,
} = {}) {
  const M = profile.mouse;
  const target = viewportOf(viewport) ? clampToViewport(to, viewport, b.grid) : snapPoint(to, b.grid);
  const from = b.pos ?? target;
  const button = buttonName(buttons);
  if (preMove) b.pause(rng.int(...M.preMoveMs), 'pre-move');

  const D = dist(from, target);
  if (D < 0.5) {
    // Already there. One event keeps hover state and the pointer stream honest.
    b.mouse('mouseMoved', target.x, target.y, { button, buttons, clickCount: 0, modifiers });
    return { distance: 0, fittsMs: 0, movementMs: 0, overshoot: false };
  }

  const W = targetSize ? Math.min(targetSize.w ?? targetSize.width, targetSize.h ?? targetSize.height) : NaN;
  const fittsMs = fittsDuration(profile, D, W);
  const MT = Math.max(1, Math.round(fittsMs * M.durationScale * durationFactor * rng.range(...M.durationJitter)));
  const t0 = b.t;
  const opts = { buttons, modifiers, viewport, minSamples };

  let over = null;
  if (overshoot && D > M.overshoot.minDistance && rng.chance(M.overshoot.chance)) {
    const f = rng.range(...M.overshoot.fraction);
    const p = clampToViewport({ x: target.x + (target.x - from.x) * f, y: target.y + (target.y - from.y) * f }, viewport, b.grid);
    if (dist(p, target) >= 1) over = p;
  }
  if (over) {
    appendSegment(b, rng, profile, from, over, MT, opts);
    appendSegment(b, rng, profile, over, target, rng.int(...M.overshoot.correctionMs), { ...opts, minSamples: 0 });
  } else {
    appendSegment(b, rng, profile, from, target, MT, opts);
  }
  return { distance: Math.round(D * 10) / 10, fittsMs: Math.round(fittsMs), movementMs: b.t - t0, overshoot: !!over };
}

/**
 * The start point: `from`, else a fresh pointer in the viewport, else the
 * target. A remembered position outside the viewport (the window shrank since)
 * is brought to the nearest edge: the pointer re-enters the page there.
 */
function startFrom(rng, from, viewport, fallback) {
  if (from) return viewportOf(viewport) ? clampToViewport(requirePoint(from, 'from'), viewport, gridOf(viewport)) : requirePoint(from, 'from');
  return viewportOf(viewport) ? snapPoint(initialPointer(rng, viewport), gridOf(viewport)) : { ...fallback };
}

function sizeOf(box) {
  return { w: box.width, h: box.height };
}

/**
 * Dwell on arrival; sometimes a 1–3 px settle drift that stays inside the
 * aim region. Returns the point the pointer rests on.
 */
function appendDwell(b, rng, profile, point, region, { buttons = 0, modifiers = 0 } = {}) {
  const M = profile.mouse;
  const dwell = rng.int(...M.dwellMs);
  if (dwell >= 2 && M.settle.px[1] >= b.grid && rng.chance(M.settle.chance)) {
    // A few directions before giving up, so a small target still settles at
    // the profile's rate instead of silently less often.
    let q = null;
    for (let i = 0; i < 6 && !q; i++) {
      const c = nudge(rng, point, M.settle.px[0], M.settle.px[1], null, b.grid);
      if (!region || inside(c, region)) q = c;
    }
    if (q) {
      const first = rng.int(1, dwell - 1);
      b.pause(first, 'dwell');
      b.mouse('mouseMoved', q.x, q.y, { button: buttonName(buttons), buttons, clickCount: 0, modifiers });
      b.pause(dwell - first, 'dwell');
      return q;
    }
  }
  b.pause(dwell, 'dwell');
  return point;
}

// ------------------------------------------------------------------ planners

/**
 * planMove(rng, profile, { from, to, targetSize:{w,h}, buttons=0, modifiers=0, viewport? }) → Plan
 *
 * A pre-move idle, then the path. Distance 0 is one mouseMoved at `to`.
 * `viewport` (optional; {width, height, dpr?}) keeps every sample on screen and
 * on the device-pixel grid; a `to` outside it is refused with a RangeError.
 * A `from` outside it (the window shrank) starts at the nearest edge.
 * Direct (off): one mouseMoved at `to`.
 */
export function planMove(rng, profile, { from, to, targetSize = null, buttons = 0, modifiers = 0, viewport = null } = {}) {
  const dest = requirePoint(to, 'to');
  const mods = modifierMask(modifiers);
  if (profile.direct) {
    // v1's mouse() gave every event clickCount 1 (its default), moves included.
    const b = new PlanBuilder('move', profile, rng, { from: from ?? dest });
    b.mouse('mouseMoved', dest.x, dest.y, { button: buttonName(buttons), buttons, clickCount: 1, modifiers: mods });
    return b.finish({ to: dest });
  }
  requireReachable(dest, viewport, 'The move target');
  const b = new PlanBuilder('move', profile, rng, { from: startFrom(rng, from, viewport, dest), grid: gridOf(viewport) });
  const start = { ...b.pos };
  const info = appendMove(b, rng, profile, dest, { targetSize, buttons, modifiers: mods, viewport });
  return b.finish({ from: start, to: { ...b.pos }, ...info });
}

/**
 * planClick(rng, profile, { from, box, viewport, button='left', clickCount=1, modifiers=0 }) → Plan
 *
 * Aim point → move → dwell (± settle) → [modifier keys down] → press → hold
 * 60–140 ms → release at the same point (≤ 1 px) → for a double click the
 * second press 90–180 ms after the first release with clickCount 2 → release
 * → [modifier keys up]. Right and middle clicks use the same timings.
 *
 * plan.meta.press is the point the button actually goes down on (after any
 * settle drift): re-check obstruction THERE, not at the aim point.
 *
 * Direct (off): v1's click exactly — mouseMoved at the centre (button 'none'),
 * then pressed/released with clickCount 1…n, all at time 0.
 */
export function planClick(rng, profile, { from, box, viewport, button = 'left', clickCount = 1, modifiers = 0 } = {}) {
  const bx = requireBox(box);
  const mask = buttonMask(button);
  const mods = modifierMask(modifiers);
  const count = clamp(Math.round(Number.isFinite(clickCount) ? clickCount : 1), 1, 3);
  const target = pickTargetPoint(rng, profile, bx, viewport);

  if (profile.direct) {
    // v1 mouse(): the move said button 'none' with v1's default clickCount 1.
    const b = new PlanBuilder('click', profile, rng, { from: from ?? target });
    b.mouse('mouseMoved', target.x, target.y, { button: 'none', buttons: 0, clickCount: 1, modifiers: mods });
    for (let i = 1; i <= count; i++) {
      b.mouse('mousePressed', target.x, target.y, { button, buttons: mask, clickCount: i, modifiers: mods });
      b.mouse('mouseReleased', target.x, target.y, { button, buttons: 0, clickCount: i, modifiers: mods });
    }
    return b.finish({ target, press: target, button, clickCount: count });
  }

  const M = profile.mouse;
  requireReachable(target, viewport, 'The click target');
  const b = new PlanBuilder('click', profile, rng, { from: startFrom(rng, from, viewport, target), grid: gridOf(viewport) });
  const start = { ...b.pos };
  const names = modifierList(mods);
  if (names.length) {
    // Ctrl+click: the keys go down first, so every mouse event of the plan
    // reports a modifier that really is held (no ctrlKey before a Control keydown).
    b.pause(rng.int(...M.preMoveMs), 'pre-move');
    b.t = pressModifiers(b, rng, profile, names, b.t) + rng.int(...profile.keyboard.chordGapMs);
  }
  const info = appendMove(b, rng, profile, target, { targetSize: sizeOf(bx), modifiers: mods, viewport, preMove: !names.length });
  const region = aimRegion(profile, bx, viewport);
  const press = appendDwell(b, rng, profile, target, region, { modifiers: mods });

  let at = { ...press };
  for (let i = 1; i <= count; i++) {
    if (i > 1) b.pause(rng.int(...M.doubleClickGapMs), 'double-click-gap');
    b.mouse('mousePressed', at.x, at.y, { button, buttons: mask, clickCount: i, modifiers: mods });
    const hold = rng.int(...M.pressHoldMs);
    let release = at;
    if (i === count && M.releaseDrift.px >= b.grid && hold >= 2 && rng.chance(M.releaseDrift.chance)) {
      // The hand moves one device pixel while the button is down — never more.
      const q = rng.chance(0.5) ? { x: snap(at.x + rng.sign() * b.grid, b.grid), y: at.y } : { x: at.x, y: snap(at.y + rng.sign() * b.grid, b.grid) };
      if (!region || inside(q, region)) {
        const first = rng.int(1, hold - 1);
        b.pause(first, 'hold');
        b.mouse('mouseMoved', q.x, q.y, { button, buttons: mask, clickCount: 0, modifiers: mods });
        b.pause(hold - first, 'hold');
        release = q;
      } else {
        b.pause(hold, 'hold');
      }
    } else {
      b.pause(hold, 'hold');
    }
    b.mouse('mouseReleased', release.x, release.y, { button, buttons: 0, clickCount: i, modifiers: mods });
    at = release;
  }
  if (names.length) b.t = releaseModifiers(b, rng, profile, names, b.t + rng.int(...profile.keyboard.chordGapMs));
  return b.finish({ from: start, target, press, button, clickCount: count, ...info });
}

/**
 * planHover(rng, profile, { from, box, viewport }) → Plan
 * Move to an aim point in the box and dwell there (± settle drift).
 * Direct (off): one mouseMoved at the centre, as v1.
 */
export function planHover(rng, profile, { from, box, viewport } = {}) {
  const bx = requireBox(box);
  const target = pickTargetPoint(rng, profile, bx, viewport);
  if (profile.direct) {
    const b = new PlanBuilder('hover', profile, rng, { from: from ?? target });
    b.mouse('mouseMoved', target.x, target.y, { button: 'none', buttons: 0, clickCount: 1, modifiers: 0 });
    return b.finish({ target });
  }
  requireReachable(target, viewport, 'The hover target');
  const b = new PlanBuilder('hover', profile, rng, { from: startFrom(rng, from, viewport, target), grid: gridOf(viewport) });
  const start = { ...b.pos };
  const info = appendMove(b, rng, profile, target, { targetSize: sizeOf(bx), viewport });
  const rest = appendDwell(b, rng, profile, target, aimRegion(profile, bx, viewport));
  return b.finish({ from: start, target, rest, ...info });
}

/**
 * planDrag(rng, profile, { from, fromBox, toBox, viewport }) → Plan
 *
 * Move to the source, dwell, press, hold 80–150 ms, travel to the drop point
 * along a path 1.5× the Fitts time with at least 12 mouseMoved samples (left
 * button held on every one — HTML5 DnD and pointer-capture libraries need the
 * intermediate moves), hold 50–120 ms, release. No overshoot on the carry:
 * sweeping past the drop zone would fire dragenter/dragleave on neighbours.
 *
 * Direct (off): v1's drag exactly — move, press, 12 linear moves 16 ms apart,
 * release.
 */
export function planDrag(rng, profile, { from, fromBox, toBox, viewport } = {}) {
  const src = requireBox(fromBox, 'fromBox');
  const dst = requireBox(toBox, 'toBox');
  const a = pickTargetPoint(rng, profile, src, viewport);
  const z = pickTargetPoint(rng, profile, dst, viewport);

  if (profile.direct) {
    const b = new PlanBuilder('drag', profile, rng, { from: from ?? a });
    b.mouse('mouseMoved', a.x, a.y, { button: 'none', buttons: 0, clickCount: 1, modifiers: 0 });
    b.mouse('mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1, modifiers: 0 });
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      b.mouse('mouseMoved', a.x + (z.x - a.x) * t, a.y + (z.y - a.y) * t, { button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }, (i - 1) * 16);
    }
    b.t = steps * 16;
    b.mouse('mouseReleased', z.x, z.y, { button: 'left', buttons: 0, clickCount: 1, modifiers: 0 });
    return b.finish({ from: a, to: z });
  }

  const G = profile.drag;
  requireReachable(a, viewport, 'The drag source');
  requireReachable(z, viewport, 'The drop target');
  const b = new PlanBuilder('drag', profile, rng, { from: startFrom(rng, from, viewport, a), grid: gridOf(viewport) });
  const start = { ...b.pos };
  const approach = appendMove(b, rng, profile, a, { targetSize: sizeOf(src), viewport });
  const grip = appendDwell(b, rng, profile, a, aimRegion(profile, src, viewport));
  b.mouse('mousePressed', grip.x, grip.y, { button: 'left', buttons: 1, clickCount: 1, modifiers: 0 });
  b.pause(rng.int(...G.pressHoldMs), 'hold');
  const carry = appendMove(b, rng, profile, z, {
    targetSize: sizeOf(dst), buttons: 1, viewport, preMove: false, overshoot: false,
    durationFactor: G.durationFactor, minSamples: G.minSamples,
  });
  b.pause(rng.int(...G.releaseHoldMs), 'hold');
  // Release where the carry actually ended (the drop point on the grid), so
  // the release can never sit apart from the last move.
  const drop = { ...b.pos };
  b.mouse('mouseReleased', drop.x, drop.y, { button: 'left', buttons: 0, clickCount: 1, modifiers: 0 });
  return b.finish({ from: start, grip, drop, approach, carry });
}
