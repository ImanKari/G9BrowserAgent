/**
 * Seeded randomness — the only source of chance in the human input library.
 *
 * Nothing under extension/humanize/ may use the platform's random number
 * generator, the wall clock or any other hidden source. Every plan is a pure function of (seed, profile,
 * intent), which is what lets a failing run be replayed with identical motion:
 * the seed is written into the run record (`humanizeSeed`) and the same seed
 * reproduces the same pointer path, the same typo, the same pause.
 *
 * mulberry32 was chosen over xorshift128+ because its whole state is one
 * 32-bit integer (trivially derived from a string), it passes the statistical
 * batteries that matter at this scale, and it is ten lines anyone can audit.
 * Its period (2^32) is irrelevant here: a plan draws a few hundred numbers.
 */

const UINT32 = 4294967296;

/**
 * 32-bit hash of any string (a cyrb53 variant folded to 32 bits). Used so a
 * seed can be a readable label — "run-2026-09-21:login:3" — and so forks of a
 * generator get well-mixed independent states.
 */
export function hashSeed(value) {
  const str = String(value);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

/**
 * A seed must be given. There is deliberately no default: a generator seeded
 * from the clock would make the one property this library promises —
 * reproducibility — silently false. Callers that want a fresh seed pick one
 * themselves (outside this library) and record it.
 */
function seedState(seed) {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) throw new TypeError(`createRng: seed must be a finite number or a string (got ${seed}).`);
    if (Number.isInteger(seed) && seed >= 0 && seed < UINT32) return seed >>> 0;
    return hashSeed(`n:${seed}`);
  }
  if (typeof seed === 'string') return hashSeed(seed);
  throw new TypeError('createRng needs a seed (a number or a string). This library has no hidden randomness; record the seed you pass so the run can be replayed.');
}

/**
 * createRng(seed) → rng
 *
 *   rng()                  uniform in [0, 1)
 *   rng.int(a, b)          integer in [a, b], both ends inclusive
 *   rng.range(a, b)        uniform real in [a, b)
 *   rng.normal(mu, sigma)  Gaussian (Box–Muller)
 *   rng.logNormal(m, s)    log-normal with MEDIAN m and log-sigma s
 *   rng.pick(arr)          one element (undefined for an empty array)
 *   rng.chance(p)          true with probability p
 *   rng.sign()             -1 or +1
 *   rng.fork(label)        an independent generator derived from the current
 *                          state and a label; does not advance this one
 *   rng.seed               the seed as given (recorded in plan.meta.seed; a
 *                          BigInt is recorded as its decimal string)
 */
export function createRng(seed) {
  // A BigInt seed (a 64-bit run id) is taken as its decimal string: the seed is
  // written into plan.meta and the run record, and JSON cannot carry a BigInt —
  // JSON.stringify would throw on the plan. createRng(10n) ≡ createRng('10').
  if (typeof seed === 'bigint') seed = seed.toString();
  let state = seedState(seed);

  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };

  const rng = () => next();
  rng.seed = seed;

  rng.int = (a, b) => {
    let lo = Math.ceil(Math.min(a, b));
    let hi = Math.floor(Math.max(a, b));
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new RangeError(`rng.int: bounds must be finite (got ${a}, ${b}).`);
    if (hi < lo) hi = lo; // [2.2, 2.8] holds no integer; the nearest honest answer is 3
    return lo + Math.floor(next() * (hi - lo + 1));
  };

  rng.range = (a, b) => a + (b - a) * next();

  rng.normal = (mu = 0, sigma = 1) => {
    // 1 - u keeps the argument of log in (0, 1], so the result is never ±Infinity.
    const u1 = 1 - next();
    const u2 = next();
    return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  rng.logNormal = (median, sigma) => median * Math.exp(sigma * rng.normal(0, 1));

  rng.pick = (arr) => (arr && arr.length ? arr[Math.floor(next() * arr.length)] : undefined);

  rng.chance = (p) => next() < p;

  rng.sign = () => (next() < 0.5 ? -1 : 1);

  rng.fork = (label = '') => createRng(`fork:${state}:${label}`);

  return rng;
}
