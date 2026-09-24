/**
 * Profile resolution and validation.
 *
 * A profile is data that decides how human the input looks. It arrives from
 * three places — the built-ins (profiles.js), a calibrated team profile that a
 * person fitted from their own recordings (calibrate.js), and per-run
 * overrides — and a wrong number in any of them turns into motion the planners
 * would never produce on purpose: a negative hold, a release drift of 5 px
 * (which the browser reads as a drag), a typo rate of 40 %. So every profile
 * is validated against one schema before a planner sees it, and an invalid one
 * throws with every problem named, rather than being "fixed" silently.
 */

import { PROFILES, deepMerge, deepFreeze, isPlainObject } from './profiles.js';

export const LEVELS = Object.freeze(['off', 'human', 'stealth']);

// Schema leaf kinds.
const num = (lo, hi) => ({ t: 'num', lo, hi });
const int = (lo, hi) => ({ t: 'int', lo, hi });
const range = (lo, hi) => ({ t: 'range', lo, hi });
const intRange = (lo, hi) => ({ t: 'range', lo, hi, integer: true });
const prob = { t: 'num', lo: 0, hi: 1 };
const bool = { t: 'bool' };
const str = { t: 'str' };
const optional = (spec) => ({ ...spec, optional: true });

/**
 * The shape of a profile. Bounds are sanity bounds — "a person could plausibly
 * do this" — not the defaults; the defaults are in profiles.js.
 */
export const PROFILE_SCHEMA = {
  format: int(1, 1),
  name: str,
  level: { t: 'enum', values: LEVELS },
  direct: bool,
  description: optional(str),
  base: optional(str),
  calibration: optional({ t: 'any' }),
  mouse: {
    durationScale: num(0.2, 5),
    fitts: { a: num(0, 3000), b: num(0, 3000), minMs: num(0, 10000), maxMs: num(1, 20000) },
    durationJitter: range(0.1, 5),
    sampleIntervalMs: intRange(1, 100),
    jitterPx: num(0, 10),
    curvature: { along1: range(0, 1), along2: range(0, 1), offset: range(0, 1), sameSideChance: prob },
    overshoot: { minDistance: num(0, 100000), chance: prob, fraction: range(0, 0.5), correctionMs: intRange(1, 3000) },
    preMoveMs: intRange(0, 10000),
    dwellMs: intRange(0, 10000),
    settle: { chance: prob, px: range(0, 20) },
    pressHoldMs: intRange(1, 5000),
    releaseDrift: { chance: prob, px: num(0, 1) },
    doubleClickGapMs: intRange(1, 2000),
    defaultTargetPx: num(1, 2000),
    target: { sigma: num(0, 1), inner: num(0.05, 1) },
  },
  drag: {
    pressHoldMs: intRange(0, 5000),
    durationFactor: num(0.2, 10),
    minSamples: int(2, 1000),
    releaseHoldMs: intRange(0, 5000),
  },
  wheel: {
    notchPx: num(1, 2000),
    preMs: intRange(0, 10000),
    notchIntervalMs: intRange(1, 5000),
    burst: intRange(1, 100),
    burstPauseMs: intRange(0, 20000),
    drift: { chance: prob, px: range(0, 50) },
    overshootChance: prob,
    overshootNotches: intRange(1, 20),
  },
  keyboard: {
    ikiMedianMs: num(1, 10000),
    ikiSigma: num(0, 3),
    ikiMs: intRange(1, 30000),
    afterSpaceOrPunct: num(0.1, 20),
    beforeShifted: num(0.1, 20),
    thinkMs: intRange(0, 30000),
    shiftLeadMs: intRange(0, 2000),
    shiftTrailMs: intRange(0, 2000),
    holdMedianMs: num(1, 5000),
    holdSigma: num(0, 3),
    holdMs: intRange(1, 5000),
    rollover: bool,
    typoRate: num(0, 0.5),
    typoContinue: intRange(0, 10),
    typoNoticeMs: intRange(0, 10000),
    backspaceFactor: num(0.1, 10),
    chordGapMs: intRange(0, 2000),
    directDelayMs: num(0, 1000),
  },
  gaps: {
    betweenActionsMs: intRange(0, 60000),
    afterNavigationMs: intRange(0, 60000),
    betweenFormKeysMs: intRange(0, 60000),
  },
};

const isLeaf = (spec) => typeof spec.t === 'string';

function show(x) {
  if (typeof x === 'string') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.join(', ') + ']';
  return String(x);
}

function checkLeaf(path, spec, v, problems) {
  switch (spec.t) {
    case 'any':
      return;
    case 'str':
      if (typeof v !== 'string' || !v.length) problems.push(path + ' must be a non-empty string (got ' + show(v) + ')');
      return;
    case 'bool':
      if (typeof v !== 'boolean') problems.push(path + ' must be true or false (got ' + show(v) + ')');
      return;
    case 'enum':
      if (!spec.values.includes(v)) problems.push(path + ' must be one of ' + spec.values.join(', ') + ' (got ' + show(v) + ')');
      return;
    case 'num':
    case 'int':
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        problems.push(path + ' must be a finite number (got ' + show(v) + ')');
      } else if (v < spec.lo || v > spec.hi) {
        problems.push(path + ' must be between ' + spec.lo + ' and ' + spec.hi + ' (got ' + v + ')');
      } else if (spec.t === 'int' && !Number.isInteger(v)) {
        problems.push(path + ' must be an integer (got ' + v + ')');
      }
      return;
    case 'range': {
      if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
        problems.push(path + ' must be a [min, max] pair of finite numbers (got ' + show(v) + ')');
        return;
      }
      const [a, b] = v;
      if (a > b) problems.push(path + ' has min > max (' + show(v) + ')');
      if (a < spec.lo || b > spec.hi) problems.push(path + ' must lie within [' + spec.lo + ', ' + spec.hi + '] (got ' + show(v) + ')');
      if (spec.integer && (!Number.isInteger(a) || !Number.isInteger(b))) problems.push(path + ' must be a pair of integers (got ' + show(v) + ')');
      return;
    }
    default:
      problems.push(path + ': unknown schema kind ' + spec.t);
  }
}

function walk(path, spec, value, problems) {
  if (!isPlainObject(value)) {
    problems.push((path || 'profile') + ' must be an object');
    return;
  }
  for (const [key, sub] of Object.entries(spec)) {
    const p = path ? path + '.' + key : key;
    const v = value[key];
    if (v === undefined) {
      if (!(isLeaf(sub) && sub.optional)) problems.push(p + ' is missing');
      continue;
    }
    if (isLeaf(sub)) {
      if (sub.optional && v === null) continue;
      checkLeaf(p, sub, v, problems);
    } else {
      walk(p, sub, v, problems);
    }
  }
  for (const key of Object.keys(value)) {
    // Own keys of the schema only: `'__proto__' in spec` is true for any object.
    if (!Object.prototype.hasOwnProperty.call(spec, key)) problems.push((path ? path + '.' : '') + key + ' is not a known parameter');
  }
}

/**
 * validateProfile(obj) → string[] — every problem found, [] when valid.
 * Checks the shape, each value's bounds, and the relations the planners rely on.
 */
export function validateProfile(obj) {
  const problems = [];
  walk('', PROFILE_SCHEMA, obj, problems);
  if (problems.length) return problems;

  const m = obj.mouse;
  if (m.fitts.minMs > m.fitts.maxMs) {
    problems.push('mouse.fitts.minMs (' + m.fitts.minMs + ') is greater than mouse.fitts.maxMs (' + m.fitts.maxMs + ')');
  }
  if (m.curvature.along1[1] > m.curvature.along2[0]) {
    problems.push('mouse.curvature.along1 must end before mouse.curvature.along2 begins, or the path can loop back on itself');
  }
  if (m.durationJitter[0] <= 0) problems.push('mouse.durationJitter must be positive');
  // `direct` decides what the planners emit; `level` decides what the engine
  // allows around them (stealth: no DOM.focus, no programmatic scroll …). A
  // "stealth" profile that is direct would teleport under stealth's banner,
  // and an "off" profile that is not would be dispatched as if it were v1.
  if ((obj.level === 'off') !== obj.direct) {
    problems.push('level "' + obj.level + '" and direct ' + obj.direct + ' disagree: off is the one direct level, human and stealth are never direct');
  }
  return problems;
}

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * resolveProfile(nameOrObject, overrides?, library?) → frozen, validated Profile
 *
 *   'off' | 'human' | 'stealth'   the built-ins
 *   'team-qa'                     looked up in `library` (name → profile object);
 *                                 the caller loads stored team profiles and passes them —
 *                                 this module does no I/O and keeps no registry
 *   { base:'stealth', keyboard:{…} }  a partial profile, merged onto its base
 *                                 (`base`, else `extends`, else a built-in of the same
 *                                 name, else 'human')
 *   null/undefined                'human', the default input level
 *
 * `overrides` is deep-merged last (arrays replace). An unknown name throws; an
 * invalid result throws with every problem listed.
 */
export function resolveProfile(nameOrObject, overrides, library = null) {
  const resolved = resolveInner(nameOrObject ?? 'human', library, 0);
  const merged = overrides ? deepMerge(resolved, overrides) : resolved;
  const problems = validateProfile(merged);
  if (problems.length) {
    throw new Error('Invalid humanize profile "' + (merged?.name ?? '?') + '": ' + problems.join('; ') + '.');
  }
  return deepFreeze(merged);
}

function resolveInner(ref, library, depth) {
  if (depth > 8) throw new Error('Humanize profile bases form a cycle (or are nested more than 8 deep).');
  if (typeof ref === 'string') {
    if (own(PROFILES, ref)) return deepMerge(PROFILES[ref]);
    if (library && own(library, ref)) {
      const entry = library[ref];
      if (typeof entry === 'string' && entry !== ref) return resolveInner(entry, library, depth + 1);
      if (isPlainObject(entry)) return resolveInner({ name: ref, ...entry }, library, depth + 1);
    }
    const known = [...Object.keys(PROFILES), ...(library ? Object.keys(library) : [])];
    throw new Error('Unknown humanize profile "' + ref + '". Known: ' + known.join(', ') + '.');
  }
  if (!isPlainObject(ref)) throw new TypeError('A humanize profile is a name or a plain object.');
  const baseName = ref.base ?? ref.extends
    ?? (typeof ref.name === 'string' && own(PROFILES, ref.name) ? ref.name : 'human');
  if (baseName === ref.name && !own(PROFILES, baseName)) {
    throw new Error('Humanize profile "' + ref.name + '" names itself as its base.');
  }
  const { extends: _ignored, ...rest } = ref;
  const base = resolveInner(baseName, library, depth + 1);
  const merged = deepMerge(base, rest);
  if (!own(rest, 'base') && baseName !== merged.name) merged.base = baseName;
  return merged;
}
