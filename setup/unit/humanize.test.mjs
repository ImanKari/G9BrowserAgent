// Unit tests for the human input library (extension/humanize/).
//
// Standalone (ARCHITECTURE_V2 §12.1): node:assert/strict, prints "  PASS <name>"
// per test, exits non-zero on the first failure. No network, no browser, no
// port — the library is pure, so none is needed.
//
//   node setup/unit/humanize.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, '..', '..', 'extension', 'humanize');
const H = await import(pathToFileURL(join(libDir, 'index.js')).href);
const {
  createRng, PROFILES, resolveProfile, validateProfile,
  planMove, pickTargetPoint, planClick, planHover, planDrag, planScroll, planType, planKeyPress,
  keyDefinition, physicalKey, fitProfile, effectiveText, validatePlan, sequence, planGap,
  fittsDuration, minimumJerk, QWERTY_NEIGHBOURS, MIN_SAMPLES, modifierMask, parseKeySpec,
} = H;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS ' + name);
  } catch (err) {
    console.error('  FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

const human = resolveProfile('human');
const stealth = resolveProfile('stealth');
const off = resolveProfile('off');
const VP = { width: 1280, height: 720 };
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const mouseSteps = (plan) => plan.steps.filter((s) => s.kind === 'mouse');
const keySteps = (plan) => plan.steps.filter((s) => s.kind === 'key');

/** Every number anywhere in the value is finite. */
function assertFiniteDeep(v, path = 'plan') {
  if (typeof v === 'number') assert.ok(Number.isFinite(v), path + ' is ' + v);
  else if (Array.isArray(v)) v.forEach((x, i) => assertFiniteDeep(x, path + '[' + i + ']'));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertFiniteDeep(x, path + '.' + k);
}

/**
 * Pointer speed between consecutive pointer events, starting from `from`.
 * 20 px/ms is a teleport bound, not a style bound: Fitts' law lets a flick
 * across a 2560 px screen onto a very large target peak near 12 px/ms, and a
 * real jump (the bug this guards against) is hundreds of px in 1 ms. Ordinary
 * desktop targets stay under 10 px/ms — see the "peak speed" test.
 */
const MAX_SPEED = 20;
function assertNoTeleport(plan, from, label, maxSpeed = MAX_SPEED) {
  let prev = { x: from.x, y: from.y };
  let prevAt = 0;
  for (const s of mouseSteps(plan)) {
    const d = dist(prev, s);
    const dt = Math.max(1, s.at - prevAt);
    assert.ok(d <= Math.max(1.5, maxSpeed * dt), `${label}: ${d.toFixed(1)} px in ${dt} ms at t=${s.at} (${s.type})`);
    prev = s;
    prevAt = s.at;
  }
}

function assertPressReleasePairs(plan, label) {
  const ms = mouseSteps(plan);
  const isDrag = plan.meta.kind === 'drag';
  let open = null;
  for (const s of ms) {
    if (s.type === 'mousePressed') {
      assert.equal(open, null, label + ': press while a button is down');
      open = s;
    } else if (s.type === 'mouseReleased') {
      assert.ok(open, label + ': release without press');
      if (!isDrag) assert.ok(dist(open, s) <= 1, label + ': release drifted ' + dist(open, s).toFixed(2) + ' px from its press');
      assert.equal(s.clickCount, open.clickCount, label + ': release clickCount differs from its press');
      assert.equal(s.button, open.button);
      assert.equal(s.buttons, 0, label + ': release must report no held buttons');
      open = null;
    }
  }
  assert.equal(open, null, label + ': a press was never released');
}

/** Random text: printable ASCII (shifted symbols included), line breaks, tabs, Persian, emoji. */
const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
const EXTRA = [...'سلامبهجهانپژوهشگرکیفیت', '👋', '😀', '👍🏽', '👨‍👩‍👧', 'é', 'ü', 'ñ', '漢', '字', '\n', '\t', ' ', ' '];
function randomText(r, maxLen = 40) {
  const n = r.int(0, maxLen);
  let s = '';
  for (let i = 0; i < n; i++) s += r.chance(0.8) ? r.pick(ASCII) : r.pick(EXTRA);
  return s;
}

/** Does any of the box lie inside the viewport [0, w] × [0, h]? */
function visibleBox(b, vp) {
  const x0 = Math.max(b.x, 0);
  const y0 = Math.max(b.y, 0);
  const x1 = Math.min(b.x + b.width, vp.width);
  const y1 = Math.min(b.y + b.height, vp.height);
  return x1 >= x0 && y1 >= y0;
}

/** Run a planner; an off-screen target must be refused with the scroll-first message. */
function planOrRefuse(make, shouldRefuse, label) {
  let plan = null;
  let err = null;
  try {
    plan = make();
  } catch (e) {
    err = e;
  }
  if (shouldRefuse) {
    assert.ok(err instanceof RangeError && /outside the viewport.*scroll it into view first/.test(err.message), label + ': expected an off-screen refusal, got ' + (err ? err.message : 'a plan'));
    return null;
  }
  if (err) throw err;
  return plan;
}

function randomBox(r, vp) {
  const kind = r.int(0, 9);
  if (kind === 0) return { x: r.range(-50, vp.width), y: r.range(-50, vp.height), width: 0, height: 0 };
  if (kind === 1) return { x: r.range(0, vp.width), y: r.range(0, vp.height), width: r.range(0.2, 3), height: r.range(0.2, 3) };
  if (kind === 2) return { x: r.range(-400, vp.width), y: r.range(-400, vp.height), width: r.range(100, 900), height: r.range(50, 600) }; // partly off-screen
  if (kind === 3) return { x: vp.width + 50, y: vp.height + 50, width: 80, height: 30 }; // fully off-screen
  return { x: r.range(0, vp.width - 20), y: r.range(0, vp.height - 20), width: r.range(8, 400), height: r.range(8, 200) };
}

// =================================================================== PRNG

await test('createRng: same seed, same sequence; number and string seeds', () => {
  for (const seed of [0, 1, 42, 2 ** 32 - 1, 'run-2026-09-21', '', 1.5, -7, 1e15]) {
    const a = createRng(seed);
    const b = createRng(seed);
    for (let i = 0; i < 1000; i++) assert.equal(a(), b());
  }
});

await test('createRng: different seeds differ; a missing seed is refused', () => {
  const firsts = new Set();
  for (let s = 0; s < 500; s++) firsts.add(createRng(s)());
  assert.equal(firsts.size, 500);
  assert.notEqual(createRng('a')(), createRng('b')());
  assert.throws(() => createRng(), /needs a seed/);
  assert.throws(() => createRng(NaN), /finite/);
});

await test('createRng: helpers stay in range and have the right moments', () => {
  const r = createRng('moments');
  const N = 20000;
  let sum = 0;
  let sumSq = 0;
  const logs = [];
  let chances = 0;
  const picks = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < N; i++) {
    const u = r();
    assert.ok(u >= 0 && u < 1);
    const k = r.int(3, 7);
    assert.ok(Number.isInteger(k) && k >= 3 && k <= 7);
    const x = r.range(-2, 5);
    assert.ok(x >= -2 && x < 5);
    const z = r.normal(10, 2);
    assert.ok(Number.isFinite(z));
    sum += z;
    sumSq += z * z;
    logs.push(r.logNormal(140, 0.35));
    if (r.chance(0.3)) chances++;
    picks[r.pick(['a', 'b', 'c'])]++;
  }
  const mean = sum / N;
  const sd = Math.sqrt(sumSq / N - mean * mean);
  assert.ok(Math.abs(mean - 10) < 0.06, 'normal mean ' + mean);
  assert.ok(Math.abs(sd - 2) < 0.06, 'normal sd ' + sd);
  logs.sort((a, b) => a - b);
  assert.ok(Math.abs(logs[N / 2] - 140) < 4, 'logNormal median ' + logs[N / 2]);
  assert.ok(Math.abs(chances / N - 0.3) < 0.015);
  for (const v of Object.values(picks)) assert.ok(Math.abs(v / N - 1 / 3) < 0.02);
  assert.equal(r.pick([]), undefined);
  // every integer of a range is reachable, both ends included
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(r.int(1, 4));
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4]);
});

await test('createRng: fork is deterministic, independent and does not advance the parent', () => {
  const a = createRng(9);
  const b = createRng(9);
  const fa = a.fork('x');
  assert.equal(a(), b());
  assert.equal(fa(), createRng(9).fork('x')());
  assert.notEqual(createRng(9).fork('x')(), createRng(9).fork('y')());
});

// =============================================================== profiles

await test('profiles: the built-ins are valid, frozen and carry the plan defaults', () => {
  for (const name of ['off', 'human', 'stealth']) {
    assert.deepEqual(validateProfile(PROFILES[name]), [], name);
    assert.ok(Object.isFrozen(PROFILES[name].mouse.fitts));
    assert.equal(resolveProfile(name).name, name);
  }
  assert.equal(human.mouse.fitts.a, 120);
  assert.equal(human.mouse.fitts.b, 150);
  assert.deepEqual([human.mouse.fitts.minMs, human.mouse.fitts.maxMs], [150, 1200]);
  assert.equal(human.mouse.durationScale, 1.0);
  assert.equal(stealth.mouse.durationScale, 1.1);
  assert.equal(human.keyboard.ikiMedianMs, 140);
  assert.equal(stealth.keyboard.ikiMedianMs, 160);
  assert.equal(human.keyboard.typoRate, 0.01);
  assert.equal(stealth.keyboard.typoRate, 0.015);
  assert.equal(off.keyboard.typoRate, 0);
  assert.equal(off.direct, true);
  assert.equal(human.wheel.notchPx, 100);
  assert.deepEqual(human.mouse.pressHoldMs, [60, 140]);
  assert.deepEqual(human.mouse.doubleClickGapMs, [90, 180]);
  assert.equal(human.drag.minSamples, 12);
});

await test('profiles: resolve by name, object, library and overrides; invalid ones throw with every problem', () => {
  assert.equal(resolveProfile(undefined).name, 'human');
  assert.throws(() => resolveProfile('nope'), /Unknown humanize profile "nope"/);
  const team = resolveProfile({ name: 'team-qa', base: 'stealth', keyboard: { ikiMedianMs: 200 } });
  assert.equal(team.name, 'team-qa');
  assert.equal(team.base, 'stealth');
  assert.equal(team.keyboard.ikiMedianMs, 200);
  assert.equal(team.mouse.durationScale, 1.1, 'inherits from its base');
  const fromLib = resolveProfile('team-qa', { keyboard: { typoRate: 0 } }, { 'team-qa': { base: 'human', keyboard: { ikiMedianMs: 180 } } });
  assert.equal(fromLib.name, 'team-qa');
  assert.equal(fromLib.keyboard.ikiMedianMs, 180);
  assert.equal(fromLib.keyboard.typoRate, 0);
  assert.ok(Object.isFrozen(fromLib));

  let msg = '';
  try {
    resolveProfile('human', { keyboard: { typoRate: 0.9, ikiMs: [500, 100] }, mouse: { releaseDrift: { px: 5 }, fitss: 1 } });
  } catch (e) {
    msg = e.message;
  }
  assert.match(msg, /keyboard\.typoRate must be between 0 and 0\.5/);
  assert.match(msg, /keyboard\.ikiMs has min > max/);
  assert.match(msg, /mouse\.releaseDrift\.px must be between 0 and 1/);
  assert.match(msg, /mouse\.fitss is not a known parameter/);
  const empty = validateProfile({});
  for (const k of ['format', 'name', 'level', 'direct', 'mouse', 'drag', 'wheel', 'keyboard', 'gaps']) assert.ok(empty.includes(k + ' is missing'), k);
  assert.ok(validateProfile(null).length === 1);
  assert.throws(() => resolveProfile('a', null, { a: { base: 'b' }, b: { base: 'a' } }), /cycle/);
});

// ============================================================ determinism

const INTENTS = [
  (r, p) => planMove(r, p, { from: { x: 10, y: 20 }, to: { x: 900, y: 500 }, targetSize: { w: 40, h: 20 }, viewport: VP }),
  (r, p) => planClick(r, p, { from: { x: 10, y: 20 }, box: { x: 600, y: 300, width: 120, height: 36 }, viewport: VP, clickCount: 2 }),
  (r, p) => planHover(r, p, { from: { x: 700, y: 20 }, box: { x: 100, y: 600, width: 60, height: 60 }, viewport: VP }),
  (r, p) => planDrag(r, p, { from: { x: 5, y: 5 }, fromBox: { x: 100, y: 100, width: 50, height: 50 }, toBox: { x: 800, y: 400, width: 200, height: 100 }, viewport: VP }),
  (r, p) => planScroll(r, p, { at: { x: 640, y: 360 }, deltaY: 1234, deltaX: -250, viewport: VP }),
  (r, p) => planType(r, p, { text: 'Hello, World! 12:34 سلام 👋', field: {} }),
  (r, p) => planKeyPress(r, p, { key: 'Control+Shift+k', repeat: 2 }),
];

await test('determinism: the same seed gives the identical plan for every planner and profile', () => {
  for (const p of [human, stealth, off]) {
    for (const make of INTENTS) {
      for (const seed of [1, 'abc', 987654321]) {
        assert.deepEqual(make(createRng(seed), p), make(createRng(seed), p));
      }
    }
  }
});

await test('determinism: different seeds give different plans (human and stealth)', () => {
  for (const p of [human, stealth]) {
    for (const make of INTENTS) {
      const plans = new Set();
      for (let seed = 0; seed < 8; seed++) plans.add(JSON.stringify(make(createRng(seed), p).steps));
      assert.ok(plans.size >= 7, 'only ' + plans.size + ' distinct plans of 8 for ' + make.toString().slice(0, 40));
    }
  }
});

// ============================================================ the big sweep

await test('2000 random plans: no NaN/Infinity, sound structure, integer coordinates, no teleport, clean clicks', () => {
  const meta = createRng('sweep');
  const variant = resolveProfile('human', { mouse: { durationScale: 0.6, overshoot: { chance: 1 } }, keyboard: { typoRate: 0.2 } });
  const profiles = [human, stealth, off, variant];
  const counts = {};
  let refused = 0;
  for (let i = 0; i < 2000; i++) {
    const p = profiles[i % profiles.length];
    const vp = { width: meta.int(320, 2560), height: meta.int(240, 1440) };
    const r = createRng('plan-' + i);
    const from = meta.chance(0.9) ? { x: meta.range(-100, vp.width + 100), y: meta.range(-100, vp.height + 100) } : undefined;
    const kind = ['move', 'click', 'hover', 'drag', 'scroll', 'type', 'key'][i % 7];
    counts[kind] = (counts[kind] ?? 0) + 1;
    let plan;
    let start = from;
    switch (kind) {
      case 'move': {
        const to = meta.chance(0.1) && from ? { x: Math.min(Math.max(from.x, 0), vp.width - 1), y: Math.min(Math.max(from.y, 0), vp.height - 1) } : { x: meta.range(0, vp.width - 1), y: meta.range(0, vp.height - 1) };
        const size = meta.chance(0.2) ? null : { w: meta.range(0, 300), h: meta.range(0, 300) };
        plan = planMove(r, p, { from: from ?? to, to, targetSize: size, viewport: vp, buttons: meta.chance(0.2) ? 1 : 0, modifiers: meta.int(0, 15) });
        start = from ?? to;
        if (!p.direct) {
          const last = mouseSteps(plan).at(-1);
          assert.deepEqual({ x: last.x, y: last.y }, { x: Math.round(to.x), y: Math.round(to.y) }, 'final point exact');
          if (plan.meta.distance > 0) {
            const f = p.mouse.fitts;
            assert.ok(plan.meta.fittsMs >= f.minMs && plan.meta.fittsMs <= f.maxMs, 'fitts ' + plan.meta.fittsMs);
            const lo = Math.floor(f.minMs * p.mouse.durationScale * p.mouse.durationJitter[0]) - 1;
            // each segment ends on the first sample at or after its planned time (< one interval later)
            const step = p.mouse.sampleIntervalMs[1];
            const hi = Math.ceil(f.maxMs * p.mouse.durationScale * p.mouse.durationJitter[1]) + step + (plan.meta.overshoot ? p.mouse.overshoot.correctionMs[1] + step : 0) + 1;
            assert.ok(plan.meta.movementMs >= lo && plan.meta.movementMs <= hi, `movement ${plan.meta.movementMs} outside [${lo}, ${hi}]`);
          }
        }
        break;
      }
      case 'click': {
        const box = randomBox(meta, vp);
        const opts = { from, box, viewport: vp, button: meta.pick(['left', 'left', 'right', 'middle']), clickCount: meta.int(1, 3), modifiers: meta.chance(0.2) ? ['Control'] : 0 };
        plan = planOrRefuse(() => planClick(r, p, opts), !p.direct && !visibleBox(box, vp), '#' + i);
        break;
      }
      case 'hover': {
        const box = randomBox(meta, vp);
        plan = planOrRefuse(() => planHover(r, p, { from, box, viewport: vp }), !p.direct && !visibleBox(box, vp), '#' + i);
        break;
      }
      case 'drag': {
        const fromBox = randomBox(meta, vp);
        const toBox = randomBox(meta, vp);
        plan = planOrRefuse(() => planDrag(r, p, { from, fromBox, toBox, viewport: vp }), !p.direct && !(visibleBox(fromBox, vp) && visibleBox(toBox, vp)), '#' + i);
        break;
      }
      case 'scroll': {
        const at = { x: meta.range(0, vp.width - 1), y: meta.range(0, vp.height - 1) };
        start = at;
        const dy = meta.chance(0.1) ? 0 : meta.range(-6000, 6000);
        const dx = meta.chance(0.7) ? 0 : meta.range(-2000, 2000);
        plan = planScroll(r, p, { at, deltaY: dy, deltaX: dx, viewport: vp, snap: meta.chance(0.2) });
        break;
      }
      case 'type':
        plan = planType(r, p, { text: randomText(meta), field: { password: meta.chance(0.2), numericMask: meta.chance(0.1) } });
        break;
      case 'key':
        plan = planKeyPress(r, p, { key: meta.pick(['Enter', 'Tab', 'Escape', 'a', 'Z', '!', 'F5', 'ArrowDown', 'Control+s', 'Shift', 'Backspace', 'PageDown', 'ش', 'Space']), modifiers: meta.chance(0.3) ? ['Alt'] : [], repeat: meta.int(1, 3) });
        break;
    }
    const label = `#${i} ${kind}/${p.name}`;
    if (!plan) {
      refused++;
      continue;
    }
    assertFiniteDeep(plan, label);
    assert.deepEqual(validatePlan(plan), [], label);
    for (const s of plan.steps) for (const v of Object.values(s)) assert.notEqual(v, undefined, label);
    if (!p.direct) {
      for (const s of mouseSteps(plan)) {
        assert.ok(Number.isInteger(s.x) && Number.isInteger(s.y), `${label}: non-integer ${s.x},${s.y}`);
        assert.ok(s.x >= 0 && s.x < vp.width && s.y >= 0 && s.y < vp.height, `${label}: ${s.x},${s.y} is off the page`);
      }
      const origin = plan.meta.from ?? start;
      if (origin && mouseSteps(plan).length) assertNoTeleport(plan, origin, label);
    }
    assertPressReleasePairs(plan, label);
  }
  assert.ok(Object.values(counts).every((n) => n > 250));
  assert.ok(refused > 20 && refused < 400, refused + ' off-screen refusals');
});

await test('off-screen: planners refuse a target outside the viewport instead of teleporting; a stale start is brought in', () => {
  const r = createRng('offscreen');
  const box = { x: 100, y: -300, width: 80, height: 40 };
  for (const make of [
    () => planClick(r, human, { from: { x: 10, y: 10 }, box, viewport: VP }),
    () => planHover(r, stealth, { from: { x: 10, y: 10 }, box, viewport: VP }),
    () => planDrag(r, human, { from: { x: 10, y: 10 }, fromBox: { x: 10, y: 10, width: 20, height: 20 }, toBox: box, viewport: VP }),
    () => planMove(r, human, { from: { x: 10, y: 10 }, to: { x: 1280, y: 5 }, viewport: VP }),
    () => planMove(r, human, { from: { x: 10, y: 10 }, to: { x: -2, y: 5 } }),
    () => planScroll(r, human, { at: { x: 5, y: 900 }, deltaY: 100, viewport: VP }),
  ]) {
    assert.throws(make, (e) => e instanceof RangeError && /scroll it into view first/.test(e.message));
  }
  assert.equal(planClick(r, off, { box, viewport: VP }).steps[0].y, -280, 'off keeps v1: no check, exact centre');
  // a raw point inside the last pixel is reachable; it lands on that pixel
  const edge = planMove(r, human, { from: { x: 10, y: 10 }, to: { x: 1279.6, y: 719.7 }, viewport: VP });
  assert.deepEqual(edge.end, { x: 1279, y: 719 });
  const edgeClick = planClick(r, human, { from: { x: 10, y: 10 }, box: { x: 1279.1, y: 300, width: 1, height: 1 }, viewport: VP });
  assert.equal(edgeClick.meta.press.x, 1279);
  const stale = planClick(r, human, { from: { x: 3000, y: -50 }, box: { x: 600, y: 300, width: 50, height: 20 }, viewport: VP });
  assert.deepEqual(stale.meta.from, { x: 1279, y: 0 });
  assertNoTeleport(stale, stale.meta.from, 'stale start');
});

await test('device pixel grid: with viewport.dpr every coordinate is a multiple of 1/dpr', () => {
  const vp = { width: 1536, height: 864, dpr: 1.25 };
  const onGrid = (v) => Math.abs(v / 0.8 - Math.round(v / 0.8)) < 1e-6;
  for (let s = 0; s < 100; s++) {
    const r = createRng(s);
    const plans = [
      planClick(r, human, { from: { x: 17.3, y: 400.1 }, box: { x: 300.3, y: 200.7, width: 91.1, height: 23.9 }, viewport: vp, clickCount: 2 }),
      planDrag(r, stealth, { from: { x: 1, y: 1 }, fromBox: { x: 50, y: 50, width: 10, height: 10 }, toBox: { x: 1400, y: 800, width: 60, height: 40 }, viewport: vp }),
      planScroll(r, human, { at: { x: 700.5, y: 300.2 }, deltaY: 900, viewport: vp }),
      planHover(r, human, { box: { x: 1530, y: 860, width: 30, height: 30 }, viewport: vp }),
    ];
    for (const plan of plans) {
      for (const m of mouseSteps(plan)) {
        assert.ok(onGrid(m.x) && onGrid(m.y), `${plan.meta.kind}: ${m.x},${m.y} is not on the 0.8 px grid`);
        assert.ok(m.x >= 0 && m.x < vp.width && m.y >= 0 && m.y < vp.height);
      }
      assertPressReleasePairs(plan, plan.meta.kind);
    }
  }
});

// ================================================================= pointer

await test('fitts: formula, clamps, monotonic in distance, W defaults for unknown sizes', () => {
  const f = human.mouse.fitts;
  assert.equal(fittsDuration(human, 300, 50), f.a + f.b * Math.log2(300 / 50 + 1));
  assert.equal(fittsDuration(human, 0, 50), f.minMs);
  assert.equal(fittsDuration(human, 1e6, 1), f.maxMs);
  assert.equal(fittsDuration(human, 300, 0), fittsDuration(human, 300, human.mouse.defaultTargetPx));
  assert.equal(fittsDuration(human, NaN, NaN), f.minMs);
  let prev = 0;
  for (let d = 1; d < 4000; d += 37) {
    const t = fittsDuration(human, d, 20);
    assert.ok(t >= prev);
    prev = t;
  }
  assert.ok(fittsDuration(human, 500, 10) > fittsDuration(human, 500, 200), 'smaller targets take longer');
  assert.equal(minimumJerk(0), 0);
  assert.equal(minimumJerk(1), 1);
  assert.ok(Math.abs(minimumJerk(0.5) - 0.5) < 1e-12);
});

await test('planMove: bell-shaped velocity, samples every 8–16 ms, jitter only in between, distance 0 is one event', () => {
  const r = createRng('bell');
  const p = resolveProfile('human', { mouse: { overshoot: { chance: 0 } } });
  const plan = planMove(r, p, { from: { x: 100, y: 100 }, to: { x: 1100, y: 600 }, targetSize: { w: 30, h: 30 }, viewport: VP });
  const ms = mouseSteps(plan);
  assert.ok(ms.length > 20);
  const speeds = [];
  for (let i = 1; i < ms.length; i++) {
    const dt = ms[i].at - ms[i - 1].at;
    assert.ok(dt >= 8 && dt <= 32, 'interval ' + dt); // a dropped still sample doubles one interval
    speeds.push(dist(ms[i - 1], ms[i]) / dt);
  }
  const third = Math.floor(speeds.length / 3);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const [s1, s2, s3] = [avg(speeds.slice(0, third)), avg(speeds.slice(third, 2 * third)), avg(speeds.slice(2 * third))];
  assert.ok(s2 > s1 * 1.5 && s2 > s3 * 1.5, `velocity is not bell-shaped: ${s1.toFixed(2)} ${s2.toFixed(2)} ${s3.toFixed(2)}`);
  // curved, not a straight line
  const a = { x: 100, y: 100 };
  const z = { x: 1100, y: 600 };
  const len = dist(a, z);
  const maxDev = Math.max(...ms.map((s) => Math.abs(((z.x - a.x) * (a.y - s.y) - (a.x - s.x) * (z.y - a.y)) / len)));
  assert.ok(maxDev > 10, 'path is nearly straight (' + maxDev.toFixed(1) + ' px)');
  assert.equal(plan.steps[0].kind, 'pause');
  assert.equal(plan.steps[0].reason, 'pre-move');
  assert.ok(plan.steps[0].ms >= 50 && plan.steps[0].ms <= 250);

  const zero = planMove(createRng(1), human, { from: { x: 50, y: 60 }, to: { x: 50, y: 60 } });
  assert.deepEqual(validatePlan(zero), []);
  assert.equal(mouseSteps(zero).length, 1);
  assert.deepEqual(zero.end, { x: 50, y: 60 });
  assert.equal(zero.meta.distance, 0);
  const noFrom = planMove(createRng(1), human, { to: { x: 300, y: 200 }, viewport: VP });
  assert.ok(noFrom.meta.from.x >= VP.width * 0.2 && noFrom.meta.from.x <= VP.width * 0.8, 'initial pointer in the middle 60%');
  assert.throws(() => planMove(createRng(1), human, { from: { x: 0, y: 0 }, to: { x: NaN, y: 1 } }), /finite/);
});

await test('peak speed: ordinary targets on a 1920×1080 screen stay under 10 px/ms (human and stealth)', () => {
  const vp = { width: 1920, height: 1080 };
  const meta = createRng('peak');
  let peak = 0;
  for (let s = 0; s < 400; s++) {
    const w = meta.range(12, 200);
    const h = meta.range(12, 120);
    const box = { x: meta.range(0, vp.width - w), y: meta.range(0, vp.height - h), width: w, height: h };
    const from = { x: meta.range(0, vp.width - 1), y: meta.range(0, vp.height - 1) };
    const plan = planClick(createRng(s), s % 2 ? stealth : human, { from, box, viewport: vp });
    assertNoTeleport(plan, plan.meta.from, 'peak #' + s, 10);
    let prev = plan.meta.from;
    let prevAt = 0;
    for (const m of mouseSteps(plan)) {
      peak = Math.max(peak, dist(prev, m) / Math.max(1, m.at - prevAt));
      prev = m;
      prevAt = m.at;
    }
  }
  assert.ok(peak > 2, 'moves are not implausibly slow either (peak ' + peak.toFixed(2) + ' px/ms)');
});

await test('planMove: long moves overshoot then correct; buttons and modifiers ride on every event', () => {
  let overs = 0;
  for (let s = 0; s < 200; s++) {
    const plan = planMove(createRng(s), human, { from: { x: 20, y: 20 }, to: { x: 1200, y: 650 }, viewport: VP, buttons: 1, modifiers: 8 });
    for (const m of mouseSteps(plan)) {
      assert.equal(m.buttons, 1);
      assert.equal(m.button, 'left');
      assert.equal(m.modifiers, 8);
      assert.ok(m.x >= 0 && m.x < VP.width && m.y >= 0 && m.y < VP.height);
    }
    if (plan.meta.overshoot) {
      overs++;
      const ms = mouseSteps(plan);
      const along = (p) => ((p.x - 20) * (1180) + (p.y - 20) * 630) / Math.hypot(1180, 630);
      assert.ok(Math.max(...ms.map(along)) > Math.hypot(1180, 630) + 5, 'an overshoot goes past the target');
    }
  }
  assert.ok(overs > 90 && overs < 150, 'overshoot rate ' + overs + '/200 (expected ≈ 0.6)');
  const short = planMove(createRng(3), resolveProfile('human', { mouse: { overshoot: { chance: 1 } } }), { from: { x: 0, y: 0 }, to: { x: 300, y: 0 } });
  assert.equal(short.meta.overshoot, false, 'moves under 400 px never overshoot');
});

await test('pickTargetPoint: inner 70% of the box, clipped to the viewport, centred, not the exact centre', () => {
  const r = createRng('aim');
  const box = { x: 100, y: 200, width: 200, height: 60 };
  let sx = 0;
  let sy = 0;
  let exact = 0;
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const p = pickTargetPoint(r, human, box, VP);
    assert.ok(p.x >= 130 && p.x <= 270 && p.y >= 209 && p.y <= 251, `outside the inner 70%: ${p.x},${p.y}`);
    assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y));
    sx += p.x;
    sy += p.y;
    if (p.x === 200 && p.y === 230) exact++;
  }
  assert.ok(Math.abs(sx / N - 200) < 2 && Math.abs(sy / N - 230) < 1, 'distribution is centred');
  assert.ok(exact < N * 0.05, 'the centre itself is not special');

  // partly off-screen: only the visible part
  const partial = { x: 1200, y: 600, width: 300, height: 300 };
  for (let i = 0; i < 500; i++) {
    const p = pickTargetPoint(r, human, partial, VP);
    assert.ok(p.x >= 1200 && p.x < 1280 && p.y >= 600 && p.y < 720, `not visible: ${p.x},${p.y}`);
  }
  // nothing visible: the centre (the caller scrolls first)
  assert.deepEqual(pickTargetPoint(r, human, { x: 2000, y: 2000, width: 20, height: 20 }, VP), { x: 2010, y: 2010 });
  // tiny and zero-sized boxes still give a point inside them
  const tiny = { x: 10.3, y: 10.3, width: 0.8, height: 0.8 };
  const pt = pickTargetPoint(r, human, tiny, VP);
  assert.ok(pt.x >= 10.3 && pt.x <= 11.1 && pt.y >= 10.3 && pt.y <= 11.1);
  assert.deepEqual(pickTargetPoint(r, off, box, VP), { x: 200, y: 230 }, 'off aims at the exact centre, as v1');
});

await test('planClick: dwell, press hold, same-point release, double click 1 then 2 with the documented gap', () => {
  const box = { x: 500, y: 300, width: 140, height: 44 };
  let settles = 0;
  let drifts = 0;
  for (let s = 0; s < 400; s++) {
    const plan = planClick(createRng(s), human, { from: { x: 20, y: 700 }, box, viewport: VP, clickCount: 2 });
    const ms = mouseSteps(plan);
    const presses = ms.filter((m) => m.type === 'mousePressed');
    const releases = ms.filter((m) => m.type === 'mouseReleased');
    assert.deepEqual(presses.map((p) => p.clickCount), [1, 2]);
    assert.deepEqual(releases.map((p) => p.clickCount), [1, 2]);
    for (let i = 0; i < 2; i++) {
      const hold = releases[i].at - presses[i].at;
      assert.ok(hold >= 60 && hold <= 140, 'hold ' + hold);
      assert.ok(dist(presses[i], releases[i]) <= 1);
    }
    const gap = presses[1].at - releases[0].at;
    assert.ok(gap >= 90 && gap <= 180, 'double-click gap ' + gap);
    assert.ok(dist(presses[0], presses[1]) <= 1, 'second press on the first');
    assert.deepEqual({ x: presses[0].x, y: presses[0].y }, plan.meta.press);
    // dwell: from arriving on the aim point to the press
    const firstPressIdx = ms.indexOf(presses[0]);
    const arrive = ms.slice(0, firstPressIdx).findLast((m) => m.x === plan.meta.target.x && m.y === plan.meta.target.y);
    const dwell = presses[0].at - arrive.at;
    assert.ok(dwell >= 60 && dwell <= 200, 'dwell ' + dwell);
    const settle = dist(plan.meta.target, plan.meta.press);
    assert.ok(settle <= 3, 'settle ' + settle);
    if (settle > 0) settles++;
    if (dist(presses[1], releases[1]) > 0) drifts++;
    // inside the element
    assert.ok(presses[0].x >= box.x && presses[0].x <= box.x + box.width && presses[0].y >= box.y && presses[0].y <= box.y + box.height);
    assert.deepEqual(plan.end, { x: releases[1].x, y: releases[1].y });
  }
  assert.ok(settles > 80 && settles < 170, 'settle rate ' + settles + '/400 (≈ 0.3)');
  assert.ok(drifts > 15 && drifts < 70, 'release-drift rate ' + drifts + '/400 (≈ 0.1)');

  const right = planClick(createRng(5), human, { from: { x: 0, y: 0 }, box, viewport: VP, button: 'right' });
  const rp = mouseSteps(right).find((m) => m.type === 'mousePressed');
  assert.equal(rp.button, 'right');
  assert.equal(rp.buttons, 2);
  assert.throws(() => planClick(createRng(1), human, { box, button: 'thumb' }), /Unknown mouse button/);
});

await test('planClick: Ctrl+click holds Control around the whole gesture', () => {
  const plan = planClick(createRng(11), human, { from: { x: 0, y: 0 }, box: { x: 300, y: 300, width: 80, height: 30 }, viewport: VP, modifiers: ['Control'] });
  const ks = keySteps(plan);
  assert.equal(ks.length, 2);
  assert.equal(ks[0].type, 'rawKeyDown');
  assert.equal(ks[0].key, 'Control');
  assert.equal(ks[0].modifiers, 2);
  assert.equal(ks[1].type, 'keyUp');
  assert.equal(ks[1].modifiers, 0);
  for (const m of mouseSteps(plan)) {
    assert.equal(m.modifiers, 2);
    assert.ok(m.at > ks[0].at && m.at < ks[1].at, 'every mouse event while Control is down');
  }
});

await test('planHover: arrives inside the box and dwells', () => {
  for (let s = 0; s < 100; s++) {
    const box = { x: 200, y: 100, width: 50, height: 50 };
    const plan = planHover(createRng(s), stealth, { from: { x: 900, y: 600 }, box, viewport: VP });
    const last = plan.steps.at(-1);
    assert.equal(last.kind, 'pause');
    assert.equal(last.reason, 'dwell');
    const ms = mouseSteps(plan);
    assert.ok(ms.every((m) => m.type === 'mouseMoved' && m.buttons === 0));
    const end = ms.at(-1);
    assert.ok(end.x >= 200 && end.x <= 250 && end.y >= 100 && end.y <= 150);
    assert.deepEqual(plan.end, { x: end.x, y: end.y });
  }
});

await test('planDrag: ≥ 12 held moves, press hold 80–150 ms, hold before release 50–120 ms, release at the drop', () => {
  for (let s = 0; s < 200; s++) {
    const short = s % 4 === 0;
    const plan = planDrag(createRng(s), human, {
      from: { x: 10, y: 10 },
      fromBox: { x: 100, y: 100, width: 40, height: 40 },
      toBox: short ? { x: 104, y: 102, width: 40, height: 40 } : { x: 900, y: 500, width: 120, height: 80 },
      viewport: VP,
    });
    const ms = mouseSteps(plan);
    const pi = ms.findIndex((m) => m.type === 'mousePressed');
    const ri = ms.findIndex((m) => m.type === 'mouseReleased');
    const carry = ms.slice(pi + 1, ri);
    assert.ok(carry.length >= 12, 'only ' + carry.length + ' carry samples');
    assert.ok(carry.every((m) => m.type === 'mouseMoved' && m.buttons === 1 && m.button === 'left'));
    const holds = plan.steps.filter((x) => x.kind === 'pause' && x.reason === 'hold');
    assert.equal(holds.length, 2);
    assert.ok(holds[0].ms >= 80 && holds[0].ms <= 150, 'press hold ' + holds[0].ms);
    assert.ok(holds[1].ms >= 50 && holds[1].ms <= 120, 'release hold ' + holds[1].ms);
    assert.equal(ms[ri].at - carry.at(-1).at, holds[1].ms);
    assert.deepEqual({ x: ms[ri].x, y: ms[ri].y }, { x: carry.at(-1).x, y: carry.at(-1).y });
    assert.deepEqual({ x: ms[ri].x, y: ms[ri].y }, plan.meta.drop);
  }
});

// =================================================================== wheel

await test('planScroll: deltas add up to the request exactly, whole notches, bursts and cadence', () => {
  const meta = createRng('wheel');
  for (let i = 0; i < 600; i++) {
    const dy = i % 3 === 0 ? Math.round(meta.range(-5000, 5000)) : meta.range(-5000, 5000);
    const dx = i % 5 === 0 ? meta.range(-800, 800) : 0;
    const p = i % 2 ? human : stealth;
    const plan = planScroll(createRng(i), p, { at: { x: 640, y: 360 }, deltaY: dy, deltaX: dx, viewport: VP });
    const wheels = mouseSteps(plan).filter((m) => m.type === 'mouseWheel');
    const sy = wheels.reduce((a, w) => a + w.deltaY, 0);
    const sx = wheels.reduce((a, w) => a + w.deltaX, 0);
    assert.ok(Math.abs(sy - dy) < 1e-6, `deltaY sum ${sy} != ${dy}`);
    assert.ok(Math.abs(sx - dx) < 1e-6, `deltaX sum ${sx} != ${dx}`);
    let partialY = 0;
    for (const w of wheels) {
      assert.ok(w.deltaX === 0 || w.deltaY === 0, 'one axis per notch');
      const v = Math.abs(w.deltaX || w.deltaY);
      assert.ok(v > 0 && v <= 100 + 1e-9);
      if (v !== 100 && w.deltaY) partialY++;
    }
    assert.ok(partialY <= 1, 'at most one partial notch per axis');
    // the pointer: wheel events fire where the pointer is; drifts stay small
    let pos = { x: 640, y: 360 };
    let lastWheelAt = null;
    for (const m of mouseSteps(plan)) {
      if (m.type === 'mouseMoved') {
        const d = dist(pos, m);
        assert.ok(d >= 1 && d <= 6, 'drift ' + d);
        pos = m;
      } else {
        assert.deepEqual({ x: m.x, y: m.y }, { x: pos.x, y: pos.y });
        if (lastWheelAt !== null) {
          const gap = m.at - lastWheelAt;
          assert.ok((gap >= 40 && gap <= 120) || gap >= 150, "notch gap " + gap + " (the profile cadence is 40–120 ms; a drift must not stretch it)");
        }
        lastWheelAt = m.at;
      }
    }
    assert.ok(dist(pos, { x: 640, y: 360 }) <= 20, 'drift wandered ' + dist(pos, { x: 640, y: 360 }).toFixed(1) + ' px');
  }
});

await test('planScroll: overshoot is compensated, respects room, and can be disabled; snap and off', () => {
  let overs = 0;
  for (let s = 0; s < 300; s++) {
    const plan = planScroll(createRng(s), human, { at: { x: 300, y: 300 }, deltaY: 800 });
    const wheels = mouseSteps(plan).filter((m) => m.type === 'mouseWheel');
    assert.equal(wheels.reduce((a, w) => a + w.deltaY, 0), 800);
    if (plan.meta.overshoot) {
      overs++;
      assert.ok(wheels.some((w) => w.deltaY < 0), 'the overshoot scrolls back');
      assert.ok(plan.steps.some((x) => x.kind === 'pause' && x.reason === 'overshoot-return'));
    }
  }
  assert.ok(overs > 90 && overs < 150, 'overshoot rate ' + overs + '/300 (≈ 0.4)');
  const forced = planScroll(createRng(1), human, { at: { x: 1, y: 1 }, deltaY: -300, overshoot: true });
  assert.ok(forced.meta.overshoot <= -100);
  assert.equal(mouseSteps(forced).filter((m) => m.type === 'mouseWheel').reduce((a, w) => a + w.deltaY, 0), -300);
  const cramped = planScroll(createRng(1), human, { at: { x: 1, y: 1 }, deltaY: 300, overshoot: true, room: { down: 350 } });
  assert.equal(cramped.meta.overshoot, 0, 'no overshoot into the end of the page');
  const never = planScroll(createRng(1), human, { at: { x: 1, y: 1 }, deltaY: 3000, overshoot: false });
  assert.equal(never.meta.overshoot, 0);
  assert.ok(mouseSteps(never).every((m) => m.type !== 'mouseWheel' || m.deltaY > 0));

  const snapped = planScroll(createRng(2), human, { at: { x: 5, y: 5 }, deltaY: 537, snap: true, overshoot: false });
  assert.equal(snapped.meta.deltaY, 500);
  assert.ok(mouseSteps(snapped).every((m) => m.type !== 'mouseWheel' || m.deltaY === 100));

  const zero = planScroll(createRng(2), human, { at: { x: 5, y: 5 }, deltaY: 0 });
  assert.equal(zero.steps.length, 0);
  assert.deepEqual(validatePlan(zero), []);

  const direct = planScroll(createRng(2), off, { at: { x: 400, y: 300 }, deltaY: 400, deltaX: 10 });
  assert.deepEqual(direct.steps, [{ at: 0, kind: 'mouse', type: 'mouseWheel', x: 400, y: 300, button: 'none', buttons: 0, clickCount: 0, modifiers: 0, deltaX: 10, deltaY: 400 }]);
  assert.throws(() => planScroll(createRng(1), human, { at: { x: 0, y: 0 }, deltaY: Infinity }), /finite/);
});

// ================================================================ keyboard

const SHIFTED_ASCII = new Set([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ~!@#$%^&*()_+{}|:"<>?']);
const UNSHIFTED_TWIN = { '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/' };

await test('keyDefinition: every printable ASCII character has its US-QWERTY key, code, keyCode and shift', () => {
  for (const ch of ASCII) {
    const d = keyDefinition(ch);
    assert.equal(d.key, ch);
    assert.equal(d.text, ch);
    assert.ok(d.code && d.code.length > 2, 'code for ' + JSON.stringify(ch));
    assert.ok(d.keyCode > 0, 'keyCode for ' + JSON.stringify(ch));
    assert.equal(d.shift, SHIFTED_ASCII.has(ch), 'shift for ' + ch);
    if (/[a-z]/i.test(ch)) {
      assert.equal(d.code, 'Key' + ch.toUpperCase());
      assert.equal(d.keyCode, ch.toUpperCase().charCodeAt(0));
    }
    if (/[0-9]/.test(ch)) {
      assert.equal(d.code, 'Digit' + ch);
      assert.equal(d.keyCode, ch.charCodeAt(0));
    }
    if (UNSHIFTED_TWIN[ch]) {
      const twin = keyDefinition(UNSHIFTED_TWIN[ch]);
      assert.equal(d.code, twin.code, ch + ' shares its key with ' + UNSHIFTED_TWIN[ch]);
      assert.equal(d.keyCode, twin.keyCode);
    }
  }
  // v1's table, unchanged
  const v1 = { '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192], ' ': ['Space', 32] };
  for (const [ch, [code, kc]] of Object.entries(v1)) assert.deepEqual([keyDefinition(ch).code, keyDefinition(ch).keyCode], [code, kc]);
});

await test('keyDefinition: named keys, F-keys, aliases, case-insensitivity, unknown names and non-ASCII', () => {
  const named = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32, Insert: 45 };
  for (const [name, kc] of Object.entries(named)) {
    const d = keyDefinition(name);
    assert.equal(d.keyCode, kc, name);
    assert.equal(d.shift, false);
  }
  assert.equal(keyDefinition('Enter').text, '\r');
  assert.equal(keyDefinition('Space').key, ' ');
  assert.equal(keyDefinition('Escape').text, undefined);
  for (let n = 1; n <= 24; n++) assert.deepEqual([keyDefinition('F' + n).code, keyDefinition('F' + n).keyCode], ['F' + n, 111 + n]);
  assert.equal(keyDefinition('enter').key, 'Enter');
  assert.equal(keyDefinition('ESC').key, 'Escape');
  assert.equal(keyDefinition('pagedown').key, 'PageDown');
  assert.equal(keyDefinition('Return').key, 'Enter');
  assert.equal(keyDefinition('Ctrl').key, 'Control');
  assert.equal(keyDefinition('\n').key, 'Enter');
  assert.equal(keyDefinition('\t').key, 'Tab');
  assert.deepEqual(keyDefinition('AudioVolumeUp'), { key: 'AudioVolumeUp', code: 'AudioVolumeUp', keyCode: 0, shift: false });
  for (const ch of ['ش', 'ی', '👋', 'é', '漢']) {
    const d = keyDefinition(ch);
    assert.deepEqual(d, { key: ch, code: '', keyCode: 0, text: ch, shift: false });
    assert.deepEqual(physicalKey(d), {});
  }
  assert.deepEqual(physicalKey(keyDefinition('a')), { code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  assert.throws(() => keyDefinition(''), /needs a key/);
  keyDefinition('a').key = 'mutated';
  assert.equal(keyDefinition('a').key, 'a', 'returns fresh objects');
  assert.deepEqual(parseKeySpec('Control+Shift+K'), { key: 'K', mods: ['Control', 'Shift'] });
  assert.deepEqual(parseKeySpec('Control++'), { key: '+', mods: ['Control'] });
  assert.deepEqual(parseKeySpec('+'), { key: '+', mods: [] });
  assert.deepEqual(parseKeySpec('a+b'), { key: 'a+b', mods: [] });
  assert.equal(modifierMask(['Control', 'Shift']), 10);
  assert.equal(modifierMask(['ctrl', 'cmd']), 6);
  assert.equal(modifierMask(3), 3);
});

await test('planType: the effective text equals the input for 500 random strings (typos, shift, non-ASCII, every profile)', () => {
  const meta = createRng('texts');
  const typoHeavy = resolveProfile('human', { keyboard: { typoRate: 0.3 } });
  const profiles = [human, stealth, off, typoHeavy];
  let typos = 0;
  for (let i = 0; i < 500; i++) {
    const text = randomText(meta, 60);
    for (const p of profiles) {
      const plan = planType(createRng(i), p, { text, field: {} });
      assert.equal(effectiveText(plan), text, `profile ${p.name}, text ${JSON.stringify(text)}`);
      assert.deepEqual(validatePlan(plan), []);
      typos += plan.meta.typos;
    }
  }
  assert.ok(typos > 500, 'typos were exercised (' + typos + ')');
});

await test('planType: typos use a QWERTY neighbour, continue 1–2 chars, pause 250–500 ms, then Backspace and retype', () => {
  const p = resolveProfile('human', { keyboard: { typoRate: 0.5 } });
  let checked = 0;
  for (let s = 0; s < 200; s++) {
    const text = 'the quick brown fox jumps over the lazy dog 1234567890';
    const plan = planType(createRng(s), p, { text, field: {} });
    const buf = [];
    let inRun = false;
    for (const k of keySteps(plan)) {
      if ((k.type === 'rawKeyDown' || k.type === 'keyDown') && k.key === 'Backspace') {
        if (!inRun) {
          // first divergence from the intended text is the typo
          let m = 0;
          while (m < buf.length && buf[m] === text[m]) m++;
          assert.ok(m < buf.length, 'a Backspace run with nothing wrong typed');
          const wrong = buf[m];
          const want = text[m];
          assert.ok(QWERTY_NEIGHBOURS[want.toLowerCase()].includes(wrong.toLowerCase()), `${wrong} is not next to ${want}`);
          const extra = buf.length - m - 1;
          assert.ok(extra >= 0 && extra <= 2, 'continued ' + extra + ' chars');
          checked++;
        }
        inRun = true;
        buf.pop();
      } else if ((k.type === 'keyDown' || k.type === 'char') && k.text) {
        inRun = false;
        buf.push(k.text === '\r' ? '\n' : k.text);
      }
    }
    for (const pause of plan.steps.filter((x) => x.kind === 'pause' && x.reason === 'notice-typo')) {
      assert.ok(pause.ms >= 250 && pause.ms <= 500);
    }
    assert.equal(buf.join(''), text);
  }
  assert.ok(checked > 1000, 'checked ' + checked + ' typos');
});

await test('planType: a key that is still held never goes down again (double letters, a typo, A-B-A) — rollover is between DIFFERENT keys', () => {
  // Rollover let the next plain key go down before the previous keyup, and did not exclude the SAME
  // key: 'll', 'ee', '00' and A-B-A runs planned keydown, keydown, keyup, keyup for one physical key
  // with repeat:false — which no keyboard can send, and a keystroke-dynamics script pairs by code
  // (interaction review, 2026-09-22: 36 % of 'committee' plans at human, 24 % at stealth).
  const typoHeavy = resolveProfile('human', { keyboard: { typoRate: 0.5 } });
  const texts = ['committee', 'password1100', 'hello', 'abababababababababab', 'lol lol', 'aabbccdd',
    'the quick brown fox jumps over the lazy dog'];
  let overlaps = 0;
  for (const p of [human, stealth, typoHeavy]) {
    for (const text of texts) {
      for (let s = 0; s < 120; s++) {
        const plan = planType(createRng(`${p.name}:${text}:${s}`), p, { text, field: { password: /password/.test(text) } });
        const held = new Map(); // physical key → the step that pressed it
        const steps = plan.steps.filter((x) => x.kind === 'key').sort((a, b) => a.at - b.at || (a.type === 'keyUp' ? -1 : 1));
        let previousDown = null;
        for (const step of steps) {
          const phys = step.code || step.key;
          if (step.type === 'keyUp') {
            held.delete(phys);
            continue;
          }
          assert.ok(!held.has(phys), `${p.name} ${JSON.stringify(text)} seed ${s}: ${phys} went down while still held (at ${step.at})`);
          if (previousDown && previousDown.up > step.at) overlaps += 1;
          held.set(phys, step);
          const up = plan.steps.find((x) => x.kind === 'key' && x.type === 'keyUp' && (x.code || x.key) === phys && x.at >= step.at);
          previousDown = { phys, up: up?.at ?? step.at };
        }
      }
    }
  }
  assert.ok(overlaps > 0, 'rollover between different keys still happens (' + overlaps + ' overlapping pairs)');
});

await test('planType: a typo never continues over an emoji, Persian or a line break (Backspace removes one grapheme)', () => {
  const p = resolveProfile('human', { keyboard: { typoRate: 0.5, typoContinue: [2, 2] } });
  let backspaces = 0;
  for (let s = 0; s < 300; s++) {
    const text = 'ab👍🏽cd سلام ef\ngh 👨‍👩‍👧 ij';
    const plan = planType(createRng(s), p, { text, field: {} });
    const buf = [];
    for (const k of keySteps(plan)) {
      if (k.key === 'Backspace' && k.type !== 'keyUp') {
        const gone = buf.pop();
        assert.match(gone, /^[\x20-\x7e]$/, 'a Backspace removed ' + JSON.stringify(gone));
        backspaces++;
      } else if ((k.type === 'keyDown' || k.type === 'char') && k.text) {
        buf.push(k.text);
      }
    }
    assert.equal(effectiveText(plan), text);
  }
  assert.ok(backspaces > 300);
});

await test('planType: never a typo in a password field, a masked numeric field, or with typos:false', () => {
  const p = resolveProfile('human', { keyboard: { typoRate: 0.5 } });
  const text = 'Secret-Password-123 abcdefghijklmnopqrstuvwxyz 9876543210';
  for (let s = 0; s < 200; s++) {
    for (const opts of [{ field: { password: true } }, { field: { numericMask: true } }, { field: {}, typos: false }, { field: { password: true, numericMask: false }, typos: true }]) {
      const plan = planType(createRng(s), p, { text, ...opts });
      assert.equal(plan.meta.typos, 0);
      assert.ok(!keySteps(plan).some((k) => k.key === 'Backspace'), 'Backspace in ' + JSON.stringify(opts));
      assert.equal(keySteps(plan).filter((k) => k.type === 'keyDown' && k.text).length, [...text].length);
      assert.equal(effectiveText(plan), text);
    }
  }
});

await test('planType: Shift around capitals and symbols (30–90 / 20–80 ms), held across a run, opposite hand', () => {
  for (let s = 0; s < 200; s++) {
    const plan = planType(createRng(s), human, { text: 'aB', field: {}, typos: false });
    const ks = keySteps(plan);
    const shiftDown = ks.find((k) => k.key === 'Shift' && k.type === 'rawKeyDown');
    const shiftUp = ks.find((k) => k.key === 'Shift' && k.type === 'keyUp');
    const bDown = ks.find((k) => k.key === 'B' && k.type === 'keyDown');
    const bUp = ks.find((k) => k.key === 'B' && k.type === 'keyUp');
    const aDown = ks.find((k) => k.key === 'a' && k.type === 'keyDown');
    assert.equal(aDown.modifiers, 0);
    assert.equal(bDown.modifiers, 8);
    assert.equal(bUp.modifiers, 8);
    assert.equal(shiftDown.modifiers, 8);
    assert.equal(shiftUp.modifiers, 0);
    assert.equal(shiftDown.code, 'ShiftRight', 'B is typed by the left hand, so the right hand holds Shift');
    assert.equal(shiftDown.location, 2);
    const lead = bDown.at - shiftDown.at;
    const trail = shiftUp.at - bUp.at;
    assert.ok(lead >= 30 && lead <= 90, 'lead ' + lead);
    assert.ok(trail >= 20 && trail <= 80, 'trail ' + trail);
    assert.equal(bDown.code, 'KeyB');
    assert.equal(bDown.windowsVirtualKeyCode, 66);
  }
  const run = planType(createRng(1), human, { text: 'HELLO world', field: {}, typos: false });
  assert.equal(keySteps(run).filter((k) => k.key === 'Shift' && k.type === 'rawKeyDown').length, 1, 'Shift held across the run');
  const sym = planType(createRng(2), human, { text: 'p!', field: {}, typos: false });
  const shift = keySteps(sym).find((k) => k.key === 'Shift');
  assert.equal(shift.code, 'ShiftRight', '! is Digit1, left hand');
  const right = planType(createRng(2), human, { text: 'P', field: {}, typos: false });
  assert.equal(keySteps(right).find((k) => k.key === 'Shift').code, 'ShiftLeft', 'P is right-hand, so left Shift');
});

await test('planType: think pause, log-normal intervals (median 140/160 ms, σ 0.35), ×1.6 after space, ×2 before shift', () => {
  const letters = 'abcdefghijklmnopqrstuvwxyz'.repeat(40);
  for (const [p, want] of [[human, 140], [stealth, 160]]) {
    const plan = planType(createRng('iki-' + p.name), p, { text: letters, field: {}, typos: false });
    const think = plan.steps[0];
    assert.equal(think.reason, 'think');
    assert.ok(think.ms >= 300 && think.ms <= 900);
    const downs = keySteps(plan).filter((k) => k.type === 'keyDown').map((k) => k.at);
    const iki = downs.slice(1).map((t, i) => t - downs[i]);
    const logs = iki.map(Math.log);
    const mu = logs.reduce((a, b) => a + b, 0) / logs.length;
    const sigma = Math.sqrt(logs.reduce((a, b) => a + (b - mu) ** 2, 0) / logs.length);
    assert.ok(Math.abs(Math.exp(mu) - want) / want < 0.08, p.name + ' median ' + Math.exp(mu).toFixed(1));
    assert.ok(Math.abs(sigma - 0.35) < 0.04, p.name + ' sigma ' + sigma.toFixed(3));
    assert.ok(iki.every((d) => d >= 35 && d <= 1500));
  }
  const spaced = planType(createRng('space'), human, { text: 'a '.repeat(600), field: {}, typos: false });
  const downs = keySteps(spaced).filter((k) => k.type === 'keyDown');
  const after = [];
  const before = [];
  for (let i = 1; i < downs.length; i++) (downs[i - 1].key === ' ' ? after : before).push(downs[i].at - downs[i - 1].at);
  const med = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const ratio = med(after) / med(before);
  assert.ok(ratio > 1.4 && ratio < 1.85, 'after-space ratio ' + ratio.toFixed(2));
  const caps = planType(createRng('caps'), resolveProfile('human', { keyboard: { shiftLeadMs: [0, 0] } }), { text: 'aA'.repeat(300), field: {}, typos: false });
  const cd = keySteps(caps).filter((k) => k.type === 'keyDown');
  const toCap = [];
  for (let i = 1; i < cd.length; i++) if (cd[i].key === 'A') toCap.push(cd[i].at - cd[i - 1].at);
  const capRatio = med(toCap) / 140;
  assert.ok(capRatio > 1.7 && capRatio < 2.4, 'before-shift ratio ' + capRatio.toFixed(2));
});

await test('planType: non-ASCII is rawKeyDown → char(text) → keyUp with no key code; line breaks are Enter', () => {
  const plan = planType(createRng(4), human, { text: 'سلام 👋', field: {}, typos: false });
  const ks = keySteps(plan);
  const chars = ks.filter((k) => k.type === 'char');
  assert.deepEqual(chars.map((c) => c.text), ['س', 'ل', 'ا', 'م', '👋']);
  for (const c of chars) {
    assert.equal(c.code, undefined);
    assert.equal(c.windowsVirtualKeyCode, undefined);
    assert.equal(c.nativeVirtualKeyCode, undefined);
    const down = ks.find((k) => k.type === 'rawKeyDown' && k.key === c.text);
    const up = ks.find((k) => k.type === 'keyUp' && k.key === c.text);
    assert.ok(down && up && down.at === c.at && up.at > c.at);
    assert.equal(down.text, undefined, 'the rawKeyDown carries no text');
  }
  assert.equal(effectiveText(plan), 'سلام 👋');
  const zwj = planType(createRng(4), human, { text: '👨‍👩‍👧', field: {} });
  assert.equal(effectiveText(zwj), '👨‍👩‍👧');
  assert.ok(keySteps(zwj).filter((k) => k.type === 'char').every((k) => k.text.length <= 2), 'per code point, under the 4-unit cap');

  const lines = planType(createRng(5), human, { text: 'a\nb\r\nc', field: {}, typos: false });
  const enters = keySteps(lines).filter((k) => k.key === 'Enter' && k.type === 'keyDown');
  assert.equal(enters.length, 2);
  assert.equal(enters[0].text, '\r');
  assert.equal(enters[0].windowsVirtualKeyCode, 13);
  assert.equal(effectiveText(lines), 'a\nb\nc');
  const empty = planType(createRng(5), human, { text: '', field: {} });
  assert.equal(empty.steps.length, 0);
  assert.equal(empty.end, null);
});

await test('planKeyPress: chords are rawKeyDown without text inside modifier presses; plain keys keyDown(text)/keyUp', () => {
  for (const spec of [{ key: 'Control+s' }, { key: 's', modifiers: ['Control'] }, { key: 'S', modifiers: 2 }]) {
    const plan = planKeyPress(createRng(1), human, spec);
    const ks = keySteps(plan);
    assert.deepEqual(ks.map((k) => `${k.type}:${k.key}:${k.modifiers}`), ['rawKeyDown:Control:2', 'rawKeyDown:s:2', 'keyUp:s:2', 'keyUp:Control:0']);
    assert.ok(ks.every((k) => k.text === undefined), 'no text anywhere in a chord');
    assert.equal(ks[1].code, 'KeyS');
    const gap = ks[1].at - ks[0].at;
    assert.ok(gap >= 30 && gap <= 90);
  }
  const three = planKeyPress(createRng(2), human, { key: 'Control+Shift+k' });
  assert.deepEqual(keySteps(three).map((k) => `${k.type}:${k.key}:${k.modifiers}`),
    ['rawKeyDown:Control:2', 'rawKeyDown:Shift:10', 'rawKeyDown:K:10', 'keyUp:K:10', 'keyUp:Shift:2', 'keyUp:Control:0']);
  const enter = planKeyPress(createRng(3), human, { key: 'Enter' });
  assert.deepEqual(keySteps(enter).map((k) => [k.type, k.text]), [['keyDown', '\r'], ['keyUp', undefined]]);
  const esc = planKeyPress(createRng(3), human, { key: 'Escape' });
  assert.deepEqual(keySteps(esc).map((k) => k.type), ['rawKeyDown', 'keyUp']);
  const bang = planKeyPress(createRng(3), human, { key: '!' });
  assert.deepEqual(keySteps(bang).map((k) => `${k.type}:${k.key}`), ['rawKeyDown:Shift', 'keyDown:!', 'keyUp:!', 'keyUp:Shift']);
  assert.equal(bang.steps[0].at, 0);
  const rep = planKeyPress(createRng(3), human, { key: 'ArrowDown', repeat: 3 });
  assert.equal(keySteps(rep).filter((k) => k.type === 'rawKeyDown').length, 3);
  const shiftAlone = planKeyPress(createRng(3), human, { key: 'Shift' });
  assert.deepEqual(keySteps(shiftAlone).map((k) => `${k.type}:${k.modifiers}`), ['rawKeyDown:8', 'keyUp:0']);
  const persian = planKeyPress(createRng(3), human, { key: 'ش' });
  assert.equal(effectiveText(persian), 'ش');
});

// ======================================================== off == v1 dispatch

await test('off: single-event plans at time 0 that reproduce v1 direct dispatch', () => {
  const box = { x: 400, y: 300, width: 120, height: 40 };
  const click = planClick(createRng(1), off, { from: { x: 1, y: 1 }, box, viewport: VP });
  assert.deepEqual(click.steps, [
    { at: 0, kind: 'mouse', type: 'mouseMoved', x: 460, y: 320, button: 'none', buttons: 0, clickCount: 1, modifiers: 0 },
    { at: 0, kind: 'mouse', type: 'mousePressed', x: 460, y: 320, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 },
    { at: 0, kind: 'mouse', type: 'mouseReleased', x: 460, y: 320, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 },
  ]);
  assert.equal(click.durationMs, 0);
  const dbl = planClick(createRng(1), off, { box, clickCount: 2, button: 'right' });
  assert.deepEqual(mouseSteps(dbl).map((m) => `${m.type}:${m.clickCount}:${m.buttons}`),
    ['mouseMoved:1:0', 'mousePressed:1:2', 'mouseReleased:1:0', 'mousePressed:2:2', 'mouseReleased:2:0']);
  const hover = planHover(createRng(1), off, { box });
  assert.equal(hover.steps.length, 1);
  assert.equal(hover.durationMs, 0);
  const move = planMove(createRng(1), off, { from: { x: 0, y: 0 }, to: { x: 10.5, y: 20.25 } });
  assert.deepEqual(move.steps.map((s) => [s.type, s.x, s.y, s.at]), [['mouseMoved', 10.5, 20.25, 0]]);
  const key = planKeyPress(createRng(1), off, { key: 's', modifiers: ['Control'] });
  assert.deepEqual(key.steps, [
    { at: 0, kind: 'key', type: 'rawKeyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, modifiers: 2, autoRepeat: false },
    { at: 0, kind: 'key', type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, modifiers: 2, autoRepeat: false },
  ]);
  const type = planType(createRng(1), off, { text: 'a\nب' });
  assert.deepEqual(type.steps.map((s) => [s.at, s.type, s.key, s.text]), [
    [0, 'keyDown', 'a', 'a'], [0, 'keyUp', 'a', undefined],
    [12, 'keyDown', 'Enter', '\r'], [12, 'keyUp', 'Enter', undefined],
    [12, 'keyDown', 'ب', 'ب'], [12, 'keyUp', 'ب', undefined],
  ]);
  assert.equal(type.steps.filter((s) => s.kind === 'pause').length, 0);
  assert.equal(planType(createRng(1), off, { text: 'abc', delayMs: 0 }).durationMs, 0);
  const drag = planDrag(createRng(1), off, { fromBox: { x: 0, y: 0, width: 20, height: 20 }, toBox: { x: 120, y: 0, width: 20, height: 20 } });
  const dm = mouseSteps(drag);
  assert.equal(dm.length, 15);
  assert.deepEqual(dm.map((m) => m.type), ['mouseMoved', 'mousePressed', ...Array(12).fill('mouseMoved'), 'mouseReleased']);
  assert.deepEqual(dm.slice(2, 14).map((m) => m.at), Array.from({ length: 12 }, (_, i) => i * 16));
  assert.equal(dm[14].at, 192);
  assert.deepEqual({ x: dm[13].x, y: dm[13].y }, { x: 130, y: 10 });
});

// ============================================================ composition

await test('sequence and planGap: plans compose in time; think gaps come from the profile', () => {
  const r = createRng('seq');
  const a = planClick(r, human, { from: { x: 0, y: 0 }, box: { x: 100, y: 100, width: 50, height: 20 }, viewport: VP });
  const g = planGap(r, human, { after: 'navigation' });
  assert.equal(g.steps.length, 1);
  assert.ok(g.durationMs >= 600 && g.durationMs <= 1500);
  const b = planType(r, human, { text: 'hi', field: {} });
  const all = sequence([a, g, b], { gapMs: 5 });
  assert.equal(all.durationMs, a.durationMs + g.durationMs + b.durationMs + 10);
  assert.deepEqual(validatePlan(all), []);
  assert.deepEqual(all.end, a.end);
  assert.equal(effectiveText(all), 'hi');
  const think = planGap(r, human);
  assert.ok(think.durationMs >= 200 && think.durationMs <= 900);
  const formKey = planGap(r, stealth, { after: 'formKey' });
  assert.ok(formKey.durationMs >= 80 && formKey.durationMs <= 250);
  assert.equal(planGap(r, off).durationMs, 0);
});

// ============================================================== calibration

/** Turn plans into the raw events a full recorder would have captured. */
function toRaw(plan, t0, extra = {}) {
  const out = [];
  for (const s of plan.steps) {
    const at = t0 + s.at;
    if (s.kind === 'mouse') {
      if (s.type === 'mouseMoved') out.push({ type: 'mousemove', at, x: s.x, y: s.y, buttons: s.buttons });
      else if (s.type === 'mousePressed') out.push({ type: 'mousedown', at, x: s.x, y: s.y, button: 0, detail: s.clickCount, ...extra });
      else if (s.type === 'mouseReleased') {
        out.push({ type: 'mouseup', at, x: s.x, y: s.y, button: 0 });
        out.push({ type: 'click', at, detail: s.clickCount });
      } else if (s.type === 'mouseWheel') out.push({ type: 'wheel', at, x: s.x, y: s.y, deltaX: s.deltaX, deltaY: s.deltaY, deltaMode: 0 });
    } else if (s.kind === 'key') {
      if (s.type === 'rawKeyDown' || s.type === 'keyDown') out.push({ type: 'keydown', at, key: s.key, code: s.code ?? '' });
      else if (s.type === 'keyUp') out.push({ type: 'keyup', at, key: s.key, code: s.code ?? '' });
    }
  }
  return out;
}

function synthesize(truth, seed, { clicks = 120, words = 400 } = {}) {
  const r = createRng(seed);
  const raw = [{ type: 'navigate', at: 0, url: 'http://example.test/' }];
  // What the planners actually drew, so a fit can be checked against the sample rather than
  // the population (60 think pauses put p5 anywhere in about 300–370 ms).
  raw.planned = { thinkMs: [] };
  let t = 800;
  let pos = { x: 640, y: 360 };
  const dict = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'Foxtrot', 'golf', 'hotel', 'India', 'juliet', 'kilo', 'lima', 'Mike', 'november', 'iPhone', 'eBay', 'McKinley', 'JavaScript', 'macOS'];
  for (let i = 0; i < clicks; i++) {
    const w = r.range(16, 240);
    const h = r.range(16, 120);
    const box = { x: r.range(0, VP.width - w), y: r.range(0, VP.height - h), width: w, height: h };
    const click = planClick(r, truth, { from: pos, box, viewport: VP, clickCount: i % 10 === 0 ? 2 : 1 });
    raw.push(...toRaw(click, t, { width: w, height: h }));
    t += click.durationMs;
    pos = click.end;
    if (i % 2 === 0) {
      let text = '';
      for (let k = 0; k < Math.ceil(words / clicks) * 2; k++) text += (k ? ' ' : '') + r.pick(dict);
      const typed = planType(r, truth, { text, field: {} });
      raw.planned.thinkMs.push(typed.steps.find((s) => s.kind === 'pause' && s.reason === 'think').ms);
      raw.push(...toRaw(typed, t));
      t += typed.durationMs;
    }
    if (i % 4 === 0) {
      const sc = planScroll(r, truth, { at: pos, deltaY: r.int(2, 12) * truth.wheel.notchPx * (r.chance(0.8) ? 1 : -1), viewport: VP });
      raw.push(...toRaw(sc, t));
      t += sc.durationMs;
      pos = sc.end;
    }
    t += planGap(r, truth).durationMs; // think time before the next action
  }
  return raw;
}

await test('fitProfile: round trip — parameters fitted from synthetic recordings match the profile that made them', () => {
  const truth = resolveProfile({
    name: 'truth', base: 'human',
    keyboard: { ikiMedianMs: 210, ikiSigma: 0.3, holdMedianMs: 100, holdSigma: 0.25, typoRate: 0.02 },
    mouse: { fitts: { a: 100, b: 180 }, pressHoldMs: [90, 130], overshoot: { chance: 0 }, dwellMs: [100, 300] },
    wheel: { notchPx: 120, burstPauseMs: [250, 700], notchIntervalMs: [50, 110] },
  });
  const raw = synthesize(truth, 'calib');
  const { profile, samples, report } = fitProfile(raw, 'human', { name: 'team-test' });
  assert.deepEqual(validateProfile(profile), []);
  assert.equal(profile.name, 'team-test');
  assert.equal(profile.base, 'human');
  const K = profile.keyboard;
  const within = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: fitted ${got}, truth ${want} (±${tol})`);
  // A fitted range is the p5–p95 of what was observed; for a uniform [lo, hi] that is lo + 5 % … hi − 5 %.
  const range = (got, [lo, hi], tol, what) => {
    within(got[0], lo + 0.05 * (hi - lo), tol, what + ' p5');
    within(got[1], hi - 0.05 * (hi - lo), tol, what + ' p95');
  };
  within(K.ikiMedianMs, 210, 210 * 0.1, 'ikiMedianMs');
  within(K.ikiSigma, 0.3, 0.06, 'ikiSigma');
  within(K.holdMedianMs, 100, 10, 'holdMedianMs');
  within(K.holdSigma, 0.25, 0.06, 'holdSigma');
  within(K.afterSpaceOrPunct, 1.6, 0.15, 'afterSpaceOrPunct');
  range(K.thinkMs, [300, 900], 60, 'thinkMs');
  // Against the pauses actually planned: the click → first-keystroke gap IS the think pause (the
  // stroke starts at the Shift for a capital — measured to the letter it read 30–90 ms long).
  const planned = raw.planned.thinkMs;
  const q = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); const i = (s.length - 1) * p; const lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
  within(K.thinkMs[0], q(planned, 0.05), 3, 'thinkMs p5 vs the planned pauses');
  within(K.thinkMs[1], q(planned, 0.95), 3, 'thinkMs p95 vs the planned pauses');
  within(K.beforeShifted, 2.0, 0.3, 'beforeShifted');
  range(K.shiftLeadMs, [30, 90], 5, 'shiftLeadMs');
  range(K.shiftTrailMs, [20, 80], 5, 'shiftTrailMs');
  within(K.typoRate, 0.02, 0.012, 'typoRate');
  range(profile.mouse.pressHoldMs, [90, 130], 4, 'pressHoldMs');
  range(profile.mouse.dwellMs, [100, 300], 15, 'dwellMs');
  range(profile.mouse.doubleClickGapMs, [90, 180], 20, 'doubleClickGapMs');
  within(profile.mouse.fitts.b, 180, 25, 'fitts b');
  within(profile.mouse.fitts.a, 100, 40, 'fitts a');
  within(profile.mouse.sampleIntervalMs[0], 8, 2, 'sample interval min');
  within(profile.mouse.sampleIntervalMs[1], 16, 2, 'sample interval max');
  within(profile.mouse.curvature.sameSideChance, 0.5, 0.12, 'sameSideChance');
  within(profile.mouse.curvature.offset[0], 0.1, 0.03, 'curvature offset min');
  within(profile.mouse.curvature.offset[1], 0.25, 0.04, 'curvature offset max');
  within(profile.mouse.settle.chance, 0.3, 0.1, 'settle chance (a lower bound: settles within 30 ms of arrival merge into the approach)');
  // idle before a move = think gap U(200,900) + pre-move U(50,250) − the 150 ms pre-move mean: p5 ≈ 218, p95 ≈ 882
  within(profile.gaps.betweenActionsMs[0], 218, 50, 'between-actions min');
  within(profile.gaps.betweenActionsMs[1], 882, 50, 'between-actions max');
  within(profile.mouse.durationJitter[0], 0.85, 0.06, 'duration jitter min');
  within(profile.mouse.durationJitter[1], 1.15, 0.06, 'duration jitter max');
  assert.equal(profile.wheel.notchPx, 120);
  range(profile.wheel.notchIntervalMs, [50, 110], 8, 'notchIntervalMs');
  range(profile.wheel.burstPauseMs, [250, 700], 45, 'burstPauseMs');
  within(profile.wheel.overshootChance, 0.4, 0.2, 'wheel overshootChance');
  assert.ok(samples.keyIntervals >= MIN_SAMPLES.keyIntervals && samples.movements >= MIN_SAMPLES.movements && samples.wheelEvents >= MIN_SAMPLES.wheelEvents);
  assert.ok(profile.calibration.fitted.includes('keyboard.ikiMedianMs'));
  assert.ok(profile.calibration.fitted.includes('mouse.fitts.b'));
  assert.match(report, /keyboard\.ikiMedianMs = \d+/);
  assert.match(report, /mouse\.fitts\.b = \d+/);
  // deterministic, and usable by the planners
  assert.deepEqual(fitProfile(raw, 'human', { name: 'team-test' }), { profile, samples, report });
  const again = planType(createRng(1), resolveProfile(profile), { text: 'works', field: {} });
  assert.equal(effectiveText(again), 'works');
});

/**
 * The shape tools/record.js stores as `input-samples.json`: keys reduced to a
 * class ('a', 'A', '!', '.', ' ', named keys) with an opaque pairing code, at
 * most one mousemove per 16 ms, presses carrying the target's size, and the
 * whole thing wrapped as { format: 'g9-input-samples/1', events }.
 */
function asRecorderSamples(raw) {
  const out = [];
  const pairing = new Map();
  let pairs = 0;
  let lastMove = -Infinity;
  const keyClass = (k) => {
    if ([...k].length > 1) return k;
    if (k === ' ') return ' ';
    if (/^[A-Z]$/.test(k)) return 'A';
    if ('~!@#$%^&*()_+{}|:"<>?'.includes(k)) return '!';
    if (/^[\p{P}\p{S}]$/u.test(k)) return '.';
    return 'a';
  };
  for (const e of raw) {
    if (e.type === 'mousemove') {
      if (e.at - lastMove < 16) continue;
      lastMove = e.at;
      out.push({ type: 'mousemove', at: e.at, x: e.x, y: e.y, buttons: e.buttons });
    } else if (e.type === 'keydown') {
      const id = 'k' + ++pairs;
      pairing.set(e.code || e.key, id);
      out.push({ type: 'keydown', at: e.at, key: keyClass(e.key), code: id, repeat: false });
    } else if (e.type === 'keyup') {
      const physical = e.code || e.key;
      const id = pairing.get(physical) || 'k0';
      pairing.delete(physical);
      out.push({ type: 'keyup', at: e.at, key: keyClass(e.key), code: id });
    } else if (e.type === 'mousedown') {
      out.push({ ...e, width: Math.round(e.width), height: Math.round(e.height) });
    } else {
      out.push(e);
    }
  }
  return { format: 'g9-input-samples/1', recordingId: 'rec-1', events: out };
}

await test('fitProfile: reads the v2 recorder’s input samples (key classes, pairing codes, throttled moves)', () => {
  const truth = resolveProfile({ name: 'truth', base: 'human', keyboard: { ikiMedianMs: 180, holdMedianMs: 90 }, mouse: { fitts: { a: 110, b: 170 }, overshoot: { chance: 0 } } });
  const file = asRecorderSamples(synthesize(truth, 'recorder-shape'));
  assert.ok(file.events.every((e) => e.type !== 'keydown' || ['a', 'A', ' ', '.', '!'].includes(e.key) || e.key.length > 1), 'no text survives');
  const { profile, report } = fitProfile([file], 'human', { name: 'team-rec' });
  const within = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: fitted ${got}, truth ${want} (±${tol})`);
  within(profile.keyboard.ikiMedianMs, 180, 18, 'ikiMedianMs');
  within(profile.keyboard.holdMedianMs, 90, 9, 'holdMedianMs (paired through the opaque codes)');
  within(profile.keyboard.beforeShifted, 2.0, 0.35, 'beforeShifted (from the A class)');
  within(profile.mouse.fitts.b, 170, 50, 'fitts b from 16 ms-throttled paths');
  assert.ok(profile.calibration.kept.includes('mouse.sampleIntervalMs'));
  assert.match(report, /recorder throttles pointer samples/);
  assert.deepEqual(profile.mouse.sampleIntervalMs, human.mouse.sampleIntervalMs, 'the throttle is not mistaken for the mouse');
});

await test('fitProfile: v1 recorder events fit typing from input values and keep the pointer, saying why', () => {
  const r = createRng('v1');
  const raw = [{ type: 'navigate', at: 0, url: 'http://x.test/' }];
  const target = { locators: [{ kind: 'css', value: '#q' }] };
  let t = 1000;
  for (let n = 0; n < 12; n++) {
    raw.push({ type: 'click', at: t, button: 'left', detail: 1, modifiers: [], target });
    t += r.int(350, 800);
    let value = '';
    for (const ch of 'searching for things') {
      value += ch;
      raw.push({ type: 'change', at: t, value, live: true, inputType: 'insertText', target });
      t += Math.round(r.logNormal(180, 0.3));
    }
    raw.push({ type: 'change', at: t, value, committed: true, target });
    t += 2000;
  }
  const { profile, samples, report } = fitProfile(raw, 'stealth');
  assert.ok(samples.keyIntervals >= 30);
  assert.ok(Math.abs(profile.keyboard.ikiMedianMs - 180) < 25, 'ikiMedianMs ' + profile.keyboard.ikiMedianMs);
  assert.ok(profile.calibration.fitted.includes('keyboard.thinkMs'));
  assert.deepEqual(profile.mouse, stealth.mouse, 'no pointer data: the pointer is the base profile’s');
  assert.deepEqual(profile.wheel, stealth.wheel);
  assert.equal(profile.base, 'stealth');
  assert.equal(profile.level, 'stealth');
  assert.match(report, /pointer paths were not recorded/);
  assert.match(report, /wheel events were not recorded/);
  assert.match(report, /key-up events were not recorded/);
});

await test('fitProfile: nothing to fit returns the base profile and says so; malformed events are ignored', () => {
  const { profile, samples, report } = fitProfile([{ type: 'bogus' }, null, { type: 'click' }, { type: 'mousemove', at: 'x' }], 'human');
  assert.equal(samples.events, 0);
  assert.equal(profile.calibration.fitted.length, 0);
  for (const key of ['mouse', 'keyboard', 'wheel', 'gaps', 'drag']) assert.deepEqual(profile[key], human[key]);
  assert.match(report, /Nothing could be fitted/);
  const sparse = fitProfile([{ type: 'keydown', at: 0, key: 'a' }, { type: 'keydown', at: 150, key: 'b' }], 'human');
  assert.equal(sparse.profile.keyboard.ikiMedianMs, 140);
  assert.match(sparse.report, /kept keyboard\.ikiMedianMs, keyboard\.ikiSigma — 1 plain inter-key intervals \(need 30\)/);
  // several recordings, in the recorder's session shape
  const truth = resolveProfile('human');
  const two = fitProfile([{ raw: synthesize(truth, 'a', { clicks: 30, words: 100 }) }, { raw: synthesize(truth, 'b', { clicks: 30, words: 100 }) }]);
  assert.equal(two.samples.recordings, 2);
  assert.ok(Math.abs(two.profile.keyboard.ikiMedianMs - 140) < 20);
});

// ======================================================== review regressions
// Each test below pins a defect found in review; the comment says what broke.

await test('regression: a literal U+0008 in the text is typed, not pressed as Backspace', () => {
  // The typo corrector used '\b' as its Backspace token, so 'ab\bc' deleted the "b".
  for (const [name, p] of [['human', human], ['stealth', stealth], ['off', off]]) {
    for (let seed = 0; seed < 50; seed++) {
      const text = 'ab\bc\x7f\x1bd';
      const plan = planType(createRng(seed), p, { text, field: {}, typos: false });
      assert.equal(effectiveText(plan), text, name + ' seed ' + seed);
      assert.equal(keySteps(plan).filter((k) => k.key === 'Backspace').length, 0, name + ' seed ' + seed + ': a Backspace nobody asked for');
      assert.equal(keySteps(plan).filter((k) => k.text === '\b').length, 1, name + ': the U+0008 itself is typed once');
      // With typos on, the corrections still leave exactly the text.
      assert.equal(effectiveText(planType(createRng(seed), resolveProfile('human', { keyboard: { typoRate: 0.5 } }), { text, field: {} })), text);
    }
  }
});

await test('regression: Shift alone does not turn a key into a shortcut (Shift+a types "A", Shift+Enter a line break)', () => {
  const sa = planKeyPress(createRng(1), human, { key: 'a', modifiers: ['Shift'] });
  assert.deepEqual(keySteps(sa).map((k) => `${k.type}:${k.key}:${k.modifiers}:${k.text ?? ''}`),
    ['rawKeyDown:Shift:8:', 'keyDown:A:8:A', 'keyUp:A:8:', 'keyUp:Shift:0:']);
  assert.equal(effectiveText(sa), 'A');
  const se = planKeyPress(createRng(1), stealth, { key: 'Shift+Enter' });
  assert.deepEqual(keySteps(se).map((k) => `${k.type}:${k.key}:${JSON.stringify(k.text ?? null)}`),
    ['rawKeyDown:Shift:null', 'keyDown:Enter:"\\r"', 'keyUp:Enter:null', 'keyUp:Shift:null']);
  const s1 = planKeyPress(createRng(1), human, { key: 'Shift+1' });
  assert.equal(effectiveText(s1), '!');
  assert.equal(keySteps(s1)[1].code, 'Digit1');
  const sArrow = planKeyPress(createRng(1), human, { key: 'Shift+ArrowDown' });
  assert.ok(keySteps(sArrow).every((k) => k.text === undefined), 'a key with no text stays textless under Shift');
  // A command modifier still suppresses text, Shift or not.
  for (const key of ['Control+Shift+a', 'Alt+a', 'Meta+Shift+Enter']) {
    assert.ok(keySteps(planKeyPress(createRng(1), human, { key })).every((k) => k.text === undefined), key);
  }
  // off stays v1: any modifier means rawKeyDown without text.
  const offShift = planKeyPress(createRng(1), off, { key: 'a', modifiers: ['Shift'] });
  assert.deepEqual(keySteps(offShift).map((k) => `${k.type}:${k.key}:${k.modifiers}:${k.text ?? ''}`), ['rawKeyDown:a:8:', 'keyUp:a:8:']);
});

await test('regression: a modifier pressed as the main key of a chord carries its own bit on keydown', () => {
  const cs = planKeyPress(createRng(1), human, { key: 'Control+Shift' });
  assert.deepEqual(keySteps(cs).map((k) => `${k.type}:${k.key}:${k.modifiers}`),
    ['rawKeyDown:Control:2', 'rawKeyDown:Shift:10', 'keyUp:Shift:2', 'keyUp:Control:0']);
  const dup = planKeyPress(createRng(1), human, { key: 'Shift', modifiers: ['Shift'] });
  assert.deepEqual(keySteps(dup).map((k) => `${k.type}:${k.key}:${k.modifiers}`), ['rawKeyDown:Shift:8', 'keyUp:Shift:0']);
});

await test('regression: an unknown key is refused, never sent as a many-character key event', () => {
  // 'Ctrl+Shit+K' used to become keyDown with text "Ctrl+Shit+K" (Chromium rejects > 4 UTF-16 units).
  for (const key of ['Ctrl+Shit+K', 'hello', 'Control+', 'constructor', '__proto__', 'toString', '👨‍👩‍👧']) {
    for (const p of [human, off]) {
      assert.throws(() => planKeyPress(createRng(1), p, { key }), (e) => e instanceof TypeError && /is not a key/.test(e.message), key);
    }
    assert.equal(H.isKnownKey(keyDefinition(key)), false, key);
    assert.equal(keyDefinition(key).text, undefined, key + ' has no text');
    assert.equal(keyDefinition(key).key, key, key + ' keeps its name');
  }
  // What still works: DOM key names, single graphemes within Chromium's 4-unit cap, chords.
  assert.deepEqual(keyDefinition('AudioVolumeUp'), { key: 'AudioVolumeUp', code: 'AudioVolumeUp', keyCode: 0, shift: false });
  for (const g of ['é', '👍🏽', '🇮🇷']) {
    assert.equal(keyDefinition(g).text, g);
    assert.equal(effectiveText(planKeyPress(createRng(1), human, { key: g })), g);
  }
  assert.equal(effectiveText(planKeyPress(createRng(1), human, { key: 'ش' })), 'ش');
  assert.deepEqual(keySteps(planKeyPress(createRng(1), human, { key: 'ش' })).map((k) => k.type), ['rawKeyDown', 'char', 'keyUp']);
  assert.throws(() => planClick(createRng(1), human, { box: { x: 0, y: 0, width: 9, height: 9 }, viewport: VP, button: 'toString' }), TypeError);
});

await test('regression: off types v1 exactly — no Shift bit, no physical key for shifted symbols', () => {
  const t = planType(createRng(1), off, { text: 'a!A{' });
  assert.deepEqual(keySteps(t).map((k) => [k.type, k.key, k.code ?? null, k.windowsVirtualKeyCode ?? null, k.modifiers, k.text ?? null]), [
    ['keyDown', 'a', 'KeyA', 65, 0, 'a'], ['keyUp', 'a', 'KeyA', 65, 0, null],
    ['keyDown', '!', null, null, 0, '!'], ['keyUp', '!', null, null, 0, null],
    ['keyDown', 'A', 'KeyA', 65, 0, 'A'], ['keyUp', 'A', 'KeyA', 65, 0, null],
    ['keyDown', '{', null, null, 0, '{'], ['keyUp', '{', null, null, 0, null],
  ]);
  const bang = planKeyPress(createRng(1), off, { key: '!' });
  assert.deepEqual(keySteps(bang).map((k) => [k.type, k.code ?? null, k.modifiers, k.text ?? null]), [['keyDown', null, 0, '!'], ['keyUp', null, 0, null]]);
  const mv = planMove(createRng(1), off, { to: { x: 5, y: 6 } });
  assert.equal(mv.steps[0].clickCount, 1, 'v1 mouse() sent clickCount 1 on every event');
});

await test('regression: a BigInt seed is recorded as a string, so a plan stays JSON-serialisable and replays', () => {
  const a = planClick(createRng(12345678901234567890n), human, { from: { x: 0, y: 0 }, box: { x: 300, y: 200, width: 80, height: 30 }, viewport: VP });
  assert.equal(a.meta.seed, '12345678901234567890');
  const json = JSON.stringify(a);
  const b = planClick(createRng(JSON.parse(json).meta.seed), human, { from: { x: 0, y: 0 }, box: { x: 300, y: 200, width: 80, height: 30 }, viewport: VP });
  assert.deepEqual(b, a);
});

await test('regression: profile level and direct must agree; a "__proto__" key is reported, not swallowed', () => {
  assert.throws(() => resolveProfile('stealth', { direct: true }), /level "stealth" and direct true disagree/);
  assert.throws(() => resolveProfile('off', { direct: false }), /level "off" and direct false disagree/);
  assert.throws(() => resolveProfile({ name: 'x', base: 'human', level: 'off' }), /disagree/);
  const hostile = JSON.parse('{"name":"team-x","base":"human","__proto__":{"direct":true},"mouse":{"__proto__":{"jitterPx":9}}}');
  assert.throws(() => resolveProfile(hostile), (e) => /__proto__ is not a known parameter/.test(e.message) && /mouse\.__proto__ is not a known parameter/.test(e.message));
  assert.equal(Object.prototype.direct, undefined, 'no prototype was polluted');
});

await test('regression: a drag that needs more samples than its duration gives takes real, jittered intervals', () => {
  // Before: evenly spaced samples (a metronome) whenever the Fitts time held fewer than drag.minSamples.
  const quick = resolveProfile('human', { mouse: { durationScale: 0.2 }, drag: { minSamples: 30 } });
  for (let seed = 0; seed < 40; seed++) {
    const plan = planDrag(createRng(seed), quick, {
      from: { x: 100, y: 100 }, fromBox: { x: 90, y: 90, width: 20, height: 20 }, toBox: { x: 500, y: 400, width: 40, height: 40 }, viewport: VP,
    });
    const ms = mouseSteps(plan);
    const press = ms.findIndex((s) => s.type === 'mousePressed');
    const carry = ms.slice(press + 1, -1);
    assert.ok(carry.length >= 30, 'seed ' + seed + ': ' + carry.length + ' carried moves');
    assert.ok(carry.every((s) => s.buttons === 1));
    const gaps = carry.slice(1).map((s, i) => s.at - carry[i].at);
    assert.ok(gaps.every((g) => g >= 8), 'seed ' + seed + ': a carried interval below 8 ms');
    assert.ok(new Set(gaps).size > 3, 'seed ' + seed + ': the carry intervals are a metronome ' + gaps.join(','));
    const release = ms[ms.length - 1];
    assert.deepEqual({ x: release.x, y: release.y }, { x: carry[carry.length - 1].x, y: carry[carry.length - 1].y }, 'release where the carry ended');
    assert.deepEqual(plan.meta.drop, { x: release.x, y: release.y });
  }
});

await test('regression: calibration keeps earlier recordings\' wheel bursts, and never fits pauses as notch cadence', () => {
  // Recording A has clear bursts; recording B has three notches (too few to split). B used to empty
  // every burst collected so far (S.wheelBursts.length = 0) and add its pauses to the notch intervals.
  const truth = resolveProfile('human', { wheel: { notchIntervalMs: [50, 70], burstPauseMs: [400, 600], burst: [3, 3], overshootChance: 0 } });
  const r = createRng('wheel-a');
  const a = [];
  let t = 0;
  for (let i = 0; i < 12; i++) {
    a.push(...toRaw(planScroll(r, truth, { at: { x: 400, y: 300 }, deltaY: 900, viewport: VP }), t));
    t += 10000;
  }
  const b = [900, 1900, 2900].map((at) => ({ type: 'wheel', at, x: 10, y: 10, deltaX: 0, deltaY: 100, deltaMode: 0 }));
  const alone = fitProfile([a], 'human');
  const both = fitProfile([a, b], 'human');
  assert.ok(alone.profile.calibration.fitted.includes('wheel.burst'));
  assert.ok(both.profile.calibration.fitted.includes('wheel.burst'), 'B must not discard A\'s bursts');
  assert.deepEqual(both.profile.wheel.burst, alone.profile.wheel.burst);
  assert.deepEqual(both.profile.wheel.notchIntervalMs, alone.profile.wheel.notchIntervalMs, 'B\'s 1000 ms gaps are not notch intervals');
  assert.ok(both.profile.wheel.notchIntervalMs[1] <= 75, 'cadence ' + both.profile.wheel.notchIntervalMs);
});

await test('regression: calibration fits typing from a v1 recording mixed with a v2 one, and drags are not click holds', () => {
  // hasKeydowns was global: one v2 recording made every v1 recording's input values invisible.
  const r = createRng('mixed');
  const v1 = [];
  let t = 1000;
  const target = { locators: [{ kind: 'css', value: '#q' }] };
  for (let n = 0; n < 6; n++) {
    v1.push({ type: 'click', at: t, target });
    t += 500;
    let value = '';
    for (const ch of 'mixed recordings') {
      value += ch;
      v1.push({ type: 'change', at: t, value, live: true, target });
      t += Math.round(r.logNormal(230, 0.25));
    }
    t += 3000;
  }
  const v2 = asRecorderSamples([{ type: 'keydown', at: 0, key: 'a', code: 'KeyA' }, { type: 'keyup', at: 90, key: 'a', code: 'KeyA' }]);
  const mixed = fitProfile([v1, v2], 'human');
  assert.ok(mixed.samples.keyIntervals >= 30, mixed.samples.keyIntervals + ' intervals');
  assert.ok(Math.abs(mixed.profile.keyboard.ikiMedianMs - 230) < 30, 'ikiMedianMs ' + mixed.profile.keyboard.ikiMedianMs);

  // Twenty clicks held ~100 ms and six text-selection drags held ~700 ms.
  const ev = [];
  t = 0;
  for (let i = 0; i < 26; i++) {
    const drag = i % 4 === 3 && i < 24;
    ev.push({ type: 'mousedown', at: t, x: 200, y: 200, button: 0, detail: 1 });
    if (drag) for (let k = 1; k <= 20; k++) ev.push({ type: 'mousemove', at: t + k * 30, x: 200 + k * 8, y: 200, buttons: 1 });
    t += drag ? 700 : r.int(90, 110);
    ev.push({ type: 'mouseup', at: t, x: drag ? 360 : 200, y: 200, button: 0 });
    t += 2000;
  }
  const holds = fitProfile(ev, 'human');
  assert.equal(holds.samples.pressHolds, 20);
  assert.ok(holds.profile.mouse.pressHoldMs[1] <= 110, 'pressHoldMs ' + holds.profile.mouse.pressHoldMs);
});

// ================================================================ purity (R2)

await test('purity: no platform APIs, clocks, timers, randomness or awaits in the library source', () => {
  const files = readdirSync(libDir).filter((f) => f.endsWith('.js'));
  assert.deepEqual(files.sort(), ['calibrate.js', 'index.js', 'keys.js', 'mouse.js', 'plan.js', 'prng.js', 'profile.js', 'profiles.js', 'wheel.js']);
  const banned = [/\bchrome\./, /\bbrowser\./, /globalThis/, /indexedDB/, /OffscreenCanvas/, /createImageBitmap/, /FileReader/, /['"]node:/,
    /Math\.random/, /Date\.now/, /new Date\b/, /setTimeout/, /setInterval/, /performance\.now/, /\bawait\b/, /\bfetch\(/, /\bimport\(/, /\brequire\(/];
  for (const f of files) {
    const src = readFileSync(join(libDir, f), 'utf8');
    for (const re of banned) assert.ok(!re.test(src), `${f} matches ${re}`);
    for (const m of src.matchAll(/^import .* from '(.+)';$/gm)) assert.match(m[1], /^\.\/[a-z]+\.js$/, `${f} imports ${m[1]}`);
  }
});

await test('speed: 2000 human plans in well under a second each', () => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 2000; i++) {
    const r = createRng(i);
    planClick(r, human, { from: { x: 0, y: 0 }, box: { x: 900, y: 600, width: 30, height: 20 }, viewport: VP });
    planType(r, human, { text: 'user@example.com', field: {} });
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 5000, '4000 plans took ' + ms.toFixed(0) + ' ms');
});

console.log(`humanize: ${passed} tests passed`);
