/**
 * Wheel scrolling (docs/HUMANIZE.md, Wheel).
 *
 * A person scrolls a notched wheel: whole notches (100 px each in Chrome on
 * Windows at the default 3-line setting), flicked in bursts of 2–5 with
 * 40–120 ms between notches and 150–600 ms between bursts, while the hand on
 * the mouse drifts the pointer a few pixels. Hunting for something, they
 * often scroll one burst too far and come back.
 *
 * One `Input.dispatchMouseEvent {type:'mouseWheel'}` with deltaY: 1400 is the
 * opposite of all of that, and a page that listens to `wheel` sees it.
 *
 * The total is exact: the deltas of a plan add up to the requested deltaX and
 * deltaY. When the request is not a whole number of notches the LAST notch
 * carries the remainder (a real wheel cannot do that — pass `snap: true` to
 * round the request to whole notches when the exact amount does not matter).
 * The overshoot is compensated: its scroll-back is part of the plan.
 *
 * Signs follow CDP: deltaY > 0 scrolls down, deltaX > 0 scrolls right.
 */

import { PlanBuilder, finite, requirePoint, clampToViewport, nudge, gridOf, requireReachable } from './plan.js';
import { modifierMask, modifierList, pressModifiers, releaseModifiers } from './keys.js';

function requireDelta(v, name) {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError('planScroll: ' + name + ' must be a finite number (got ' + v + ').');
  return v;
}

/** |total| split into whole notches plus one partial remainder, signed. */
export function notchesFor(total, notchPx) {
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const whole = Math.floor(abs / notchPx + 1e-9);
  const out = [];
  for (let i = 0; i < whole; i++) out.push(sign * notchPx);
  const rest = abs - whole * notchPx;
  if (rest > 1e-9) out.push(sign * rest);
  return out;
}

/**
 * planScroll(rng, profile, { at:{x,y}, deltaY, deltaX=0, viewport, modifiers=0,
 *                            overshoot?, room?, snap=false }) → Plan
 *
 *   at         the pointer position; the wheel events fire there (and where it drifts)
 *   overshoot  undefined: at the profile's chance; false: never; true: always
 *              (when the scroll is at least one notch and `room` allows)
 *   room       { up, down, left, right } — px the page can still scroll each way.
 *              Give it when you know it: an overshoot into the end of the page
 *              scrolls nothing, and its scroll-back would then move the page
 *              BACK by that much. Without `room` the caller vouches there is space.
 *   snap       round each delta to whole notches first (meta reports what was planned)
 *
 * Vertical notches first, then horizontal. Direct (off): v1's single
 * mouseWheel with both deltas.
 */
export function planScroll(rng, profile, { at, deltaY = 0, deltaX = 0, viewport = null, modifiers = 0, overshoot, room = null, snap = false } = {}) {
  const origin = requirePoint(at, 'at');
  let dy = requireDelta(deltaY, 'deltaY');
  let dx = requireDelta(deltaX, 'deltaX');
  const mods = modifierMask(modifiers);

  if (profile.direct) {
    const b = new PlanBuilder('scroll', profile, rng, { from: origin });
    b.mouse('mouseWheel', origin.x, origin.y, { button: 'none', buttons: 0, clickCount: 0, modifiers: mods, deltaX: dx, deltaY: dy });
    return b.finish({ deltaX: dx, deltaY: dy, notches: 1, overshoot: 0 });
  }

  const W = profile.wheel;
  if (snap) {
    dy = Math.round(dy / W.notchPx) * W.notchPx;
    dx = Math.round(dx / W.notchPx) * W.notchPx;
  }
  const grid = gridOf(viewport);
  requireReachable(origin, viewport, 'The wheel position');
  const start = clampToViewport(origin, viewport, grid);
  const b = new PlanBuilder('scroll', profile, rng, { from: start, grid });
  if (dy === 0 && dx === 0) return b.finish({ deltaX: 0, deltaY: 0, notches: 0, overshoot: 0 });

  const names = modifierList(mods);
  // The latest input event so far; a drift is placed in the idle time after it.
  let lastEventAt = 0;
  b.pause(rng.int(...W.preMs), 'pre-scroll');
  if (names.length) {
    lastEventAt = pressModifiers(b, rng, profile, names, b.t);
    b.t = lastEventAt + rng.int(...profile.keyboard.chordGapMs);
  }

  let pos = { ...start };
  let wheelEvents = 0;

  // The resting hand drifts; the drift is pulled back toward where the
  // scroll started so a long scroll does not walk the pointer away. The drift
  // happens WHILE the finger is between notches, at `at`, inside the idle
  // gap before the next notch — it does not delay the notch. (It used to add
  // a sample interval before it, stretching the cadence past the profile's
  // notchIntervalMs: 40–120 ms became up to 136.)
  const drift = (at) => {
    if (W.drift.px[1] < grid) return;
    const off = { x: pos.x - start.x, y: pos.y - start.y };
    const away = Math.hypot(off.x, off.y);
    const toward = away > W.drift.px[1] ? Math.atan2(-off.y, -off.x) : null;
    const q = clampToViewport(nudge(rng, pos, W.drift.px[0], W.drift.px[1], toward, grid), viewport, grid);
    if (q.x === pos.x && q.y === pos.y) return;
    b.mouse('mouseMoved', q.x, q.y, { button: 'none', buttons: 0, clickCount: 0, modifiers: mods }, at);
    pos = q;
  };

  const notch = (axis, delta) => {
    b.mouse('mouseWheel', pos.x, pos.y, {
      button: 'none', buttons: 0, clickCount: 0, modifiers: mods,
      deltaX: axis === 'x' ? delta : 0, deltaY: axis === 'y' ? delta : 0,
    });
    lastEventAt = b.t;
    wheelEvents++;
  };

  // Notches in bursts; returns nothing, advances the builder clock.
  let first = true;
  const bursts = (axis, notches) => {
    for (let i = 0; i < notches.length;) {
      const size = rng.int(...W.burst);
      const burst = notches.slice(i, i + size);
      i += size;
      if (!first) b.pause(rng.int(...W.burstPauseMs), 'burst-pause');
      first = false;
      const driftBefore = rng.chance(W.drift.chance) ? rng.int(0, burst.length - 1) : -1;
      burst.forEach((delta, k) => {
        if (k > 0) b.wait(rng.int(...W.notchIntervalMs));
        // Somewhere in the idle time since the previous event, never on it.
        if (k === driftBefore && b.t - lastEventAt >= 2) drift(rng.int(lastEventAt + 1, b.t - 1));
        notch(axis, delta);
      });
    }
  };

  let over = 0;
  if (dy !== 0) {
    bursts('y', notchesFor(dy, W.notchPx));
    const want = overshoot === false ? false : overshoot === true ? true : rng.chance(W.overshootChance);
    if (want && Math.abs(dy) >= W.notchPx) {
      const k = rng.int(...W.overshootNotches);
      const px = k * W.notchPx;
      const space = room ? finite(dy > 0 ? room.down : room.up, Infinity) : Infinity;
      if (Math.abs(dy) + px <= space) {
        over = Math.sign(dy) * px;
        bursts('y', notchesFor(over, W.notchPx));
        b.pause(rng.int(...W.burstPauseMs), 'overshoot-return');
        first = true; // the return is its own flick, not a continuation
        bursts('y', notchesFor(-over, W.notchPx));
      }
    }
  }
  if (dx !== 0) bursts('x', notchesFor(dx, W.notchPx));

  if (names.length) b.t = releaseModifiers(b, rng, profile, names, b.t + rng.int(...profile.keyboard.chordGapMs));
  return b.finish({ deltaX: dx, deltaY: dy, notches: wheelEvents, overshoot: over });
}
