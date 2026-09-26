/**
 * The built-in input profiles: off, human, stealth.
 *
 * Rule R9: every timing and threshold lives here, never in the planners. The
 * numbers are the defaults documented in docs/HUMANIZE.md — defaults, not
 * laws; a calibrated team profile (§6.7, calibrate.js) replaces them with
 * values fitted from real people.
 *
 * They are plain objects rather than JSON files because an MV3 service worker
 * cannot `import … with { type: 'json' }` everywhere we run, and fetching a
 * file would make profile resolution asynchronous and I/O-bound. One module,
 * static, importable by the extension and the daemon alike.
 *
 * Ranges are [min, max] pairs. Unless a comment says otherwise a millisecond
 * range is drawn as an integer, uniformly, both ends inclusive.
 *
 * docs/HUMANIZE.md documents every parameter; keep the two in step.
 */

const HUMAN = {
  format: 1,
  name: 'human',
  level: 'human',
  // true only for `off`: planners then emit v1's direct dispatch (one event
  // per intent, no path, no pauses) and ignore every number below.
  direct: false,
  description: 'Human-like input: Fitts-timed curved paths, dwell before press, log-normal typing with rare corrected typos (docs/HUMANIZE.md defaults).',

  mouse: {
    // The "speed factor": MULTIPLIES the Fitts time (higher = slower).
    durationScale: 1.0,
    // MT = a + b·log2(D/W + 1), clamped to [minMs, maxMs] before scaling.
    fitts: { a: 120, b: 150, minMs: 150, maxMs: 1200 },
    // × uniform(min, max) after the clamp, so two moves of the same length differ.
    durationJitter: [0.85, 1.15],
    // One mouseMoved every 8–16 ms (≈60–125 Hz), jittered per sample.
    sampleIntervalMs: [8, 16],
    // σ of the Gaussian tremor added to intermediate samples (never the last).
    jitterPx: 0.7,
    // Cubic Bézier control points: `along1`/`along2` are fractions of the
    // segment, `offset` a fraction of its length applied perpendicular.
    // sameSideChance 0.5 == "independent random signs".
    curvature: { along1: [0.30, 0.40], along2: [0.60, 0.70], offset: [0.10, 0.25], sameSideChance: 0.5 },
    // Long moves overshoot along the path direction, then correct.
    overshoot: { minDistance: 400, chance: 0.6, fraction: [0.03, 0.08], correctionMs: [80, 200] },
    // Idle before a move starts.
    preMoveMs: [50, 250],
    // Hover dwell on arrival, before any press.
    dwellMs: [60, 200],
    // During the dwell, sometimes a 1–3 px settle drift.
    settle: { chance: 0.3, px: [1, 3] },
    // mousePressed → hold → mouseReleased.
    pressHoldMs: [60, 140],
    // Rarely the hand moves while the button is down: at most 1 px, never
    // more, or the browser starts a drag.
    releaseDrift: { chance: 0.1, px: 1 },
    // Second press of a double click, after the first release.
    doubleClickGapMs: [90, 180],
    // Fitts W when the caller does not know the target size (x/y clicks).
    defaultTargetPx: 24,
    // Target point: 2-D Gaussian around the centre, σ = sigma × size,
    // truncated to the inner `inner` fraction of the box.
    target: { sigma: 0.15, inner: 0.70 },
  },

  drag: {
    pressHoldMs: [80, 150],
    // The drag path takes durationFactor × the Fitts time …
    durationFactor: 1.5,
    // … and never fewer samples than this: HTML5 DnD and pointer-capture
    // libraries ignore a jump from source to target.
    minSamples: 12,
    releaseHoldMs: [50, 120],
  },

  wheel: {
    // Chrome on Windows: 100 px per notch at the default 3-line setting.
    // Confirm on the machine with a real mouse during calibration.
    notchPx: 100,
    preMs: [40, 160],
    notchIntervalMs: [40, 120],
    // Notches per burst (integers).
    burst: [2, 5],
    burstPauseMs: [150, 600],
    // Per burst, sometimes the hand drifts the pointer a few px.
    drift: { chance: 0.5, px: [2, 6] },
    // Scrolling past and coming back (one short burst each way).
    overshootChance: 0.4,
    overshootNotches: [1, 2],
  },

  keyboard: {
    // Inter-key interval (keyDown to keyDown): log-normal, median and σ of ln.
    ikiMedianMs: 140,
    ikiSigma: 0.35,
    // Hard clamp for one sampled interval (the tails of a log-normal are long).
    ikiMs: [35, 1500],
    // Multipliers on the interval.
    afterSpaceOrPunct: 1.6,
    beforeShifted: 2.0,
    // Before the first key of a field.
    thinkMs: [300, 900],
    // rawKeyDown Shift → shiftLeadMs → character … keyUp character → shiftTrailMs → keyUp Shift.
    shiftLeadMs: [30, 90],
    shiftTrailMs: [20, 80],
    // How long a key is held (keyDown → keyUp): log-normal, clamped.
    holdMedianMs: 85,
    holdSigma: 0.3,
    holdMs: [30, 250],
    // Plain keys may overlap (next keyDown before the previous keyUp), as they
    // do for anyone typing at speed. Never around Shift, Enter, Tab or Backspace.
    rollover: true,
    // Typos per typeable character; 0 disables them.
    typoRate: 0.01,
    // Correct characters typed after the typo before it is noticed (integers).
    typoContinue: [1, 2],
    typoNoticeMs: [250, 500],
    // Backspacing is quicker than typing: interval × this.
    backspaceFactor: 0.8,
    // Between the keys of a chord (Control … s) and between modifier release.
    chordGapMs: [30, 90],
    // Only for direct (off) typing: v1's per-character delay.
    directDelayMs: 12,
  },

  gaps: {
    // planGap(): "think time" between actions.
    betweenActionsMs: [200, 900],
    afterNavigationMs: [600, 1500],
    betweenFormKeysMs: [80, 250],
  },
};

/**
 * Set an own, enumerable property. Profiles arrive as stored JSON, and
 * JSON.parse('{"__proto__": …}') yields an OWN "__proto__" key: a plain
 * `out[k] = v` would run the __proto__ setter and swap the object's prototype
 * instead — hiding the key from validation and letting inherited values stand
 * in for parameters. Defined as data, it is reported as an unknown parameter.
 */
function put(obj, k, v) {
  if (k === '__proto__') Object.defineProperty(obj, k, { value: v, writable: true, enumerable: true, configurable: true });
  else obj[k] = v;
}

/** Arrays are values (ranges), so they are replaced, never merged. */
export function deepMerge(base, patch) {
  if (patch === undefined) return clone(base);
  if (!isPlainObject(base) || !isPlainObject(patch)) return clone(patch);
  const out = clone(base);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = Object.prototype.hasOwnProperty.call(out, k) ? out[k] : undefined;
    put(out, k, isPlainObject(v) && isPlainObject(cur) ? deepMerge(cur, v) : clone(v));
  }
  return out;
}

export function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) put(out, k, clone(x));
    return out;
  }
  return v;
}

export function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

const STEALTH = deepMerge(HUMAN, {
  name: 'stealth',
  level: 'stealth',
  description: 'Human input for detector-sensitive runs: slightly slower pointer (×1.1), slower typing (median 160 ms), more corrected typos (1.5%).',
  mouse: { durationScale: 1.1 },
  keyboard: { ikiMedianMs: 160, typoRate: 0.015 },
});

const OFF = deepMerge(HUMAN, {
  name: 'off',
  level: 'off',
  direct: true,
  description: 'v1 direct dispatch: one mouseMoved at the target, press, release; per-character keyDown/keyUp; one wheel event. No path, no pauses, no typos. The other numbers are unused.',
  keyboard: { typoRate: 0 },
});

/** The built-in profiles, frozen. Resolve by name with resolveProfile(). */
export const PROFILES = deepFreeze({ off: OFF, human: HUMAN, stealth: STEALTH });
