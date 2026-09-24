/**
 * The plan model: a timed list of input events, built by the planners and
 * performed by a dispatcher (extension/lib/humanize.js → Input.dispatch*).
 *
 *   Plan = { steps: Step[], durationMs, end: {x,y} | null, meta: { kind, seed?, profile, … } }
 *
 *   Step = { at, kind:'mouse', type:'mouseMoved'|'mousePressed'|'mouseReleased'|'mouseWheel',
 *            x, y, button, buttons, clickCount, modifiers, deltaX?, deltaY? }
 *        | { at, kind:'key', type:'rawKeyDown'|'keyDown'|'keyUp'|'char', key, code?,
 *            windowsVirtualKeyCode?, nativeVirtualKeyCode?, location?, text?, unmodifiedText?,
 *            modifiers, autoRepeat:false }
 *        | { at, kind:'pause', ms, reason }
 *
 * Time. `at` is integer milliseconds from the start of the plan, and steps are
 * sorted by it (non-decreasing; ties keep their build order, which matters —
 * a rawKeyDown and its char share a millisecond). A dispatcher needs to honour
 * `at` and nothing else. Pause steps are markers for logs and evidence ("why
 * did nothing happen for 400 ms"): their time is already in the `at` of the
 * step that follows them, so a dispatcher may skip them.
 *
 * Fields a key step does not know are OMITTED, never invented: a character
 * with no US-QWERTY key (Persian, emoji) has no `code` and no virtual key
 * code, and a fabricated keyCode is worse than none (see keys.js).
 *
 * `end` is where the pointer rests afterwards (the dispatcher persists it per
 * tab), or null for keyboard plans that never touched the pointer.
 */

export const STEP_KINDS = Object.freeze(['mouse', 'key', 'pause']);
export const MOUSE_TYPES = Object.freeze(['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel']);
export const KEY_TYPES = Object.freeze(['rawKeyDown', 'keyDown', 'keyUp', 'char']);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A finite number, or the fallback. */
export function finite(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Validate a caller-supplied point. Garbage in is an error, never NaN out. */
export function requirePoint(p, what) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new TypeError(what + ' must be a point {x, y} with finite coordinates (got ' + JSON.stringify(p) + ').');
  }
  return { x: p.x, y: p.y };
}

/** Accept {x,y,width,height} (also w/h, or left/top/right/bottom). */
export function requireBox(box, what = 'box') {
  if (!box || typeof box !== 'object') throw new TypeError(what + ' must be {x, y, width, height}.');
  const x = box.x ?? box.left;
  const y = box.y ?? box.top;
  let width = box.width ?? box.w ?? (box.right != null && x != null ? box.right - x : undefined);
  let height = box.height ?? box.h ?? (box.bottom != null && y != null ? box.bottom - y : undefined);
  if (![x, y, width, height].every(Number.isFinite)) {
    throw new TypeError(what + ' must be {x, y, width, height} with finite numbers (got ' + JSON.stringify(box) + ').');
  }
  // A negative size is a caller bug; a zero size is a real (degenerate) element.
  width = Math.max(0, width);
  height = Math.max(0, height);
  return { x, y, width, height };
}

/**
 * The pointer grid in CSS px: 1 / devicePixelRatio (1 when unknown).
 *
 * A real mouse moves in whole DEVICE pixels, so on a 125 % display its CSS
 * coordinates are multiples of 0.8 and never, say, 101.0 (= 126.25 device
 * px). Plans snap every coordinate to this grid; pass the page's ratio as
 * viewport.dpr (aliases: devicePixelRatio, deviceScaleFactor). Without it the
 * grid is 1: integer CSS pixels, exact at 100 % scaling.
 */
export function gridOf(viewport) {
  const dpr = viewport ? (viewport.dpr ?? viewport.devicePixelRatio ?? viewport.deviceScaleFactor) : undefined;
  return Number.isFinite(dpr) && dpr >= 0.25 && dpr <= 8 ? 1 / dpr : 1;
}

/** Snap a coordinate to the grid (plain Math.round for the integer grid). */
export function snap(v, grid = 1) {
  if (grid === 1) return Math.round(v) + 0; // + 0 turns -0 into 0
  return Math.round(Math.round(v / grid) * grid * 1e6) / 1e6 + 0;
}

export const snapPoint = (p, grid = 1) => ({ x: snap(p.x, grid), y: snap(p.y, grid) });

/** The viewport as {width, height}, or null when unknown / degenerate. */
export function viewportOf(viewport) {
  if (!viewport) return null;
  const width = viewport.width ?? viewport.w;
  const height = viewport.height ?? viewport.h;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  return { width, height };
}

/**
 * Refuse a point the pointer cannot reach without leaving the page. A path to
 * it would have to jump from the viewport edge to the target — the teleport
 * the planners exist to avoid — so the honest answer is an error that tells
 * the caller what to do: scroll the target into view first (planScroll).
 */
export function requireReachable(p, viewport, what) {
  const vp = viewportOf(viewport);
  const outside = p.x < 0 || p.y < 0 || (vp && (p.x >= vp.width || p.y >= vp.height));
  if (outside) {
    throw new RangeError(
      what + ' (' + Math.round(p.x) + ', ' + Math.round(p.y) + ') is outside the viewport'
        + (vp ? ' (' + vp.width + '×' + vp.height + ')' : '')
        + '. A pointer cannot get there without leaving the page: scroll it into view first (planScroll), then plan the action.',
    );
  }
}

/**
 * Snap a point to the grid and keep it inside the viewport (or at least
 * non-negative when there is none). The bounds are grid points themselves, so
 * clamping never leaves the grid.
 */
export function clampToViewport(p, viewport, grid = 1) {
  const vp = viewportOf(viewport);
  const q = snapPoint(p, grid);
  const hiX = vp ? Math.max(0, snap(Math.floor((vp.width - grid) / grid + 1e-9) * grid, grid)) : Infinity;
  const hiY = vp ? Math.max(0, snap(Math.floor((vp.height - grid) / grid + 1e-9) * grid, grid)) : Infinity;
  return { x: clamp(q.x, 0, hiX), y: clamp(q.y, 0, hiY) };
}

/**
 * The first pointer position on a tab that has never been touched: a random
 * point in the middle 60 % of the viewport (plan §6.1). The dispatcher calls
 * this once per tab and persists the result; planners use it when a caller
 * passes no `from`.
 */
export function initialPointer(rng, viewport) {
  const vp = viewportOf(viewport) ?? { width: 1280, height: 720 };
  return {
    x: Math.round(rng.range(vp.width * 0.2, vp.width * 0.8)),
    y: Math.round(rng.range(vp.height * 0.2, vp.height * 0.8)),
  };
}

/**
 * A grid point `lo`–`hi` px away from `p` in a random direction. Rounding a
 * 3 px step taken at 30° gives (3, 2), which is 3.6 px — so the length is
 * checked AFTER snapping and the draw repeated; the fallback is one grid step
 * along an axis. `toward` (optional) biases the direction to within ±0.6 rad
 * of that angle.
 */
export function nudge(rng, p, lo, hi, toward = null, grid = 1) {
  const base = snapPoint(p, grid);
  const cap = Math.max(grid, hi);
  for (let i = 0; i < 8; i++) {
    const d = rng.range(lo, hi);
    const a = toward === null ? rng.range(0, 2 * Math.PI) : toward + rng.range(-0.6, 0.6);
    const q = snapPoint({ x: base.x + Math.cos(a) * d, y: base.y + Math.sin(a) * d }, grid);
    const len = Math.hypot(q.x - base.x, q.y - base.y);
    if (len >= grid - 1e-9 && len <= cap + 1e-9) return q;
  }
  return rng.chance(0.5)
    ? { x: snap(base.x + rng.sign() * grid, grid), y: base.y }
    : { x: base.x, y: snap(base.y + rng.sign() * grid, grid) };
}

/**
 * Accumulates steps against a running clock. Planners share one builder when
 * they compose (a click is a move, a dwell and a press), so time flows through
 * the pieces without offsets.
 */
export class PlanBuilder {
  constructor(kind, profile, rng, { from = null, grid = 1 } = {}) {
    this.kind = kind;
    this.profile = profile;
    this.rng = rng;
    this.grid = grid;
    this.t = 0;
    this.steps = [];
    this.pos = from ? { x: from.x, y: from.y } : null;
  }

  /** Advance the clock with no marker. */
  wait(ms) {
    this.t += Math.max(0, Math.round(finite(ms)));
  }

  /** Advance the clock and leave a marker saying why. */
  pause(ms, reason) {
    const d = Math.max(0, Math.round(finite(ms)));
    if (d > 0) {
      this.steps.push({ at: this.t, kind: 'pause', ms: d, reason });
      this.t += d;
    }
  }

  mouse(type, x, y, { button = 'none', buttons = 0, clickCount = 0, modifiers = 0, deltaX, deltaY } = {}, at = this.t) {
    const step = { at: Math.round(at), kind: 'mouse', type, x, y, button, buttons, clickCount, modifiers };
    if (deltaX !== undefined) step.deltaX = deltaX;
    if (deltaY !== undefined) step.deltaY = deltaY;
    this.steps.push(step);
    this.pos = { x, y };
    return step;
  }

  /** `fields` come from keys.js keyStep(); undefined values are dropped. */
  key(fields, at = this.t) {
    const step = { at: Math.round(at), kind: 'key' };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) step[k] = v;
    this.steps.push(step);
    return step;
  }

  finish(meta = {}, { end } = {}) {
    // Stable sort: equal `at` keeps build order (rawKeyDown before its char).
    const steps = this.steps.slice().sort((a, b) => a.at - b.at);
    let durationMs = this.t;
    for (const s of steps) durationMs = Math.max(durationMs, s.at + (s.kind === 'pause' ? s.ms : 0));
    const out = {
      steps,
      durationMs,
      end: end !== undefined ? end : this.pos ? { x: this.pos.x, y: this.pos.y } : null,
      meta: { kind: this.kind, profile: this.profile.name },
    };
    if (this.rng && this.rng.seed !== undefined) out.meta.seed = this.rng.seed;
    Object.assign(out.meta, meta);
    return out;
  }
}

/**
 * The text a keyboard plan leaves in a plain text field: every keyDown/char
 * that carries text appends it (Enter's "\r" reads as "\n"), every Backspace
 * removes the last character (code point). This is the invariant planType
 * guarantees — typos included, the effective text equals the input — and the
 * one the tests check. It does not model the page: a field that filters keys,
 * has a maxlength or moves focus on Tab will hold something else, exactly as
 * it would for a person.
 */
export function effectiveText(plan) {
  const out = [];
  for (const s of plan.steps) {
    if (s.kind !== 'key') continue;
    if ((s.type === 'rawKeyDown' || s.type === 'keyDown') && s.key === 'Backspace') {
      out.pop();
      continue;
    }
    if ((s.type === 'keyDown' || s.type === 'char') && typeof s.text === 'string' && s.text.length) {
      out.push(s.text === '\r' ? '\n' : s.text);
    }
  }
  return out.join('');
}

/**
 * Shift a plan in time and append it to another: sequence(a, b, {gapMs}).
 * Pointer continuity is the caller's business — plan b should have been
 * planned from a.end.
 */
export function sequence(plans, { gapMs = 0 } = {}) {
  const steps = [];
  let t = 0;
  let end = null;
  const kinds = [];
  let profile = null;
  let seed;
  plans.filter(Boolean).forEach((p, i) => {
    if (i > 0) t += Math.max(0, Math.round(finite(gapMs)));
    for (const s of p.steps) steps.push({ ...s, at: s.at + t });
    t += p.durationMs;
    if (p.end) end = p.end;
    kinds.push(p.meta?.kind);
    profile = profile ?? p.meta?.profile ?? null;
    if (seed === undefined) seed = p.meta?.seed;
  });
  const meta = { kind: 'sequence', parts: kinds, profile };
  if (seed !== undefined) meta.seed = seed;
  return { steps, durationMs: t, end, meta };
}

/**
 * A "think time" gap between actions (plan §6.1): 200–900 ms by default,
 * 600–1500 ms after a navigation completed, 80–250 ms between the keys of one
 * form. Returned as a plan holding one pause step, so it can be sequenced.
 */
export function planGap(rng, profile, { after = 'action' } = {}) {
  const b = new PlanBuilder('gap', profile, rng);
  if (!profile.direct) {
    const g = profile.gaps;
    const r = after === 'navigation' ? g.afterNavigationMs : after === 'formKey' ? g.betweenFormKeysMs : g.betweenActionsMs;
    b.pause(rng.int(r[0], r[1]), after === 'navigation' ? 'after-navigation' : after === 'formKey' ? 'between-form-keys' : 'think');
  }
  return b.finish({ after }, { end: null });
}

/**
 * validatePlan(plan) → string[] — structural problems, [] when sound.
 * Used by the tests and available to a dispatcher that wants to refuse a
 * corrupt plan before sending a single event.
 */
export function validatePlan(plan) {
  const problems = [];
  if (!plan || !Array.isArray(plan.steps)) return ['plan.steps must be an array'];
  if (!Number.isFinite(plan.durationMs) || plan.durationMs < 0) problems.push('plan.durationMs must be a finite number ≥ 0');
  if (plan.end !== null && (!plan.end || !Number.isFinite(plan.end.x) || !Number.isFinite(plan.end.y))) {
    problems.push('plan.end must be null or a finite point');
  }
  let last = -Infinity;
  plan.steps.forEach((s, i) => {
    const where = 'step ' + i + ' (' + s.kind + ' ' + (s.type ?? s.reason ?? '') + ')';
    if (!Number.isFinite(s.at) || s.at < 0) problems.push(where + ': at must be a finite number ≥ 0');
    if (s.at < last) problems.push(where + ': at goes backwards (' + s.at + ' < ' + last + ')');
    last = Math.max(last, s.at);
    if (s.at > plan.durationMs) problems.push(where + ': at is after durationMs');
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === 'number' && !Number.isFinite(v)) problems.push(where + ': ' + k + ' is not finite');
      if (v === undefined) problems.push(where + ': ' + k + ' is undefined');
    }
    if (!STEP_KINDS.includes(s.kind)) problems.push(where + ': unknown kind');
    if (s.kind === 'mouse') {
      if (!MOUSE_TYPES.includes(s.type)) problems.push(where + ': unknown mouse type');
      for (const k of ['x', 'y', 'buttons', 'clickCount', 'modifiers']) {
        if (!Number.isFinite(s[k])) problems.push(where + ': ' + k + ' missing');
      }
      if (typeof s.button !== 'string') problems.push(where + ': button missing');
      if (s.type === 'mouseWheel' && !Number.isFinite(s.deltaX) && !Number.isFinite(s.deltaY)) problems.push(where + ': wheel without delta');
    } else if (s.kind === 'key') {
      if (!KEY_TYPES.includes(s.type)) problems.push(where + ': unknown key type');
      if (typeof s.key !== 'string') problems.push(where + ': key missing');
      if (!Number.isFinite(s.modifiers)) problems.push(where + ': modifiers missing');
      if (s.type === 'char' && !s.text) problems.push(where + ': char without text');
    } else if (s.kind === 'pause') {
      if (!Number.isFinite(s.ms) || s.ms < 0) problems.push(where + ': ms must be ≥ 0');
    }
  });
  return problems;
}
