/**
 * Visual baselines: fingerprints, structure maps, and a diff image.
 *
 * ## Three levels, because one is always wrong
 *
 * 1. **Fingerprint** (`luma-32x32-v1`) — 1KB, stored inline in the step. It is
 *    a prefilter: if two fingerprints match, nothing further needs loading.
 *    Kept exactly as it was, because every existing recording carries one.
 * 2. **Structure map** (`edge-64x64-v1`) — a binarised gradient map. This is
 *    what `mode: "layout"` compares, and it is the level that matters most in
 *    practice: it goes blind to colour, font smoothing and copy changes, and
 *    stays sharp on things that moved, got clipped, or acquired an overlay.
 * 3. **Full PNG** — the bytes, kept in the blob store as an attachment so a human
 *    can look at expected/actual/diff. Never compared directly; images are for
 *    people.
 *
 * The reason for level 2 is the failure mode that kills visual suites: a pixel
 * comparison flags anti-aliasing and a timestamp, so teams raise thresholds and
 * mask regions until the tool only watches the parts nobody masked. Comparing
 * structure instead of pixels removes most of that pressure at the source.
 *
 * ## Masks are normalised, not pixel rectangles
 *
 * A mask is `{ x, y, w, h }` in 0..1 of the viewport. Pixel rectangles break
 * the moment somebody runs the same flow at another viewport size, which is
 * precisely when a mask is most needed.
 */

import { platform } from './platform.js';

const FINGERPRINT_SIZE = 32;
const STRUCTURE_SIZE = 64;

/** Above this, a cell counts as materially different rather than noise. */
const CELL_DELTA = 0.12;
/** Gradient magnitude above which a structure cell is considered an edge. */
const EDGE_THRESHOLD = 0.08;

/**
 * Decode through the platform: OffscreenCanvas in the extension worker, the
 * engine's hidden utility page in the daemon (Node has no image decoder and v2
 * has no dependencies). The image is STRETCHED to size×size — that is how the
 * v1 fingerprints were computed, and every stored baseline depends on it.
 */
async function lumaGrid(dataBase64, mime, size) {
  const decoded = await platform.image.decode(dataBase64, mime, { width: size, height: size });
  const rgba = decoded.rgba;
  const source = { width: decoded.sourceWidth ?? null, height: decoded.sourceHeight ?? null };
  const values = new Array(size * size);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    values[p] = Math.round((rgba[i] * 0.2126) + (rgba[i + 1] * 0.7152) + (rgba[i + 2] * 0.0722));
  }
  return { values, size, source };
}

// ----------------------------------------------------------------- level one

export async function visualFingerprint(dataBase64, mime = 'image/png') {
  const { values } = await lumaGrid(dataBase64, mime, FINGERPRINT_SIZE);
  return { algorithm: 'luma-32x32-v1', width: FINGERPRINT_SIZE, height: FINGERPRINT_SIZE, values };
}

export function visualDifference(a, b) {
  if (!a || !b || a.algorithm !== b.algorithm || a.values?.length !== b.values?.length) {
    throw new Error('Visual baseline format does not match the current screenshot fingerprint.');
  }
  let total = 0;
  let changed = 0;
  for (let i = 0; i < a.values.length; i++) {
    const delta = Math.abs(a.values[i] - b.values[i]) / 255;
    total += delta;
    if (delta > CELL_DELTA) changed += 1;
  }
  return {
    difference: total / a.values.length,
    changedRatio: changed / a.values.length,
  };
}

// ----------------------------------------------------------------- level two

/**
 * A binarised gradient map — "where are the edges", not "what colour is it".
 *
 * Sobel would be more principled; a forward difference is enough here and is
 * a quarter of the arithmetic. What matters is that the output is a bitmap of
 * structure, so re-theming a page produces an identical map and moving a card
 * by 8px does not.
 */
export async function structureMap(dataBase64, mime = 'image/png') {
  const { values, size, source } = await lumaGrid(dataBase64, mime, STRUCTURE_SIZE);
  const edges = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size) + x;
      const right = x + 1 < size ? values[i + 1] : values[i];
      const down = y + 1 < size ? values[i + size] : values[i];
      const magnitude = (Math.abs(values[i] - right) + Math.abs(values[i] - down)) / 510;
      edges[i] = magnitude > EDGE_THRESHOLD ? 1 : 0;
    }
  }
  return {
    algorithm: 'edge-64x64-v1',
    width: size,
    height: size,
    sourceWidth: source.width,
    sourceHeight: source.height,
    // A plain array so it survives structured JSON transport to the bridge.
    edges: Array.from(edges),
  };
}

/** Cell indices covered by any normalised mask rectangle. */
function maskedCells(masks, size) {
  const excluded = new Set();
  for (const mask of masks ?? []) {
    const x0 = Math.max(0, Math.floor((mask.x ?? 0) * size));
    const y0 = Math.max(0, Math.floor((mask.y ?? 0) * size));
    const x1 = Math.min(size, Math.ceil(((mask.x ?? 0) + (mask.w ?? 0)) * size));
    const y1 = Math.min(size, Math.ceil(((mask.y ?? 0) + (mask.h ?? 0)) * size));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) excluded.add((y * size) + x);
  }
  return excluded;
}

/**
 * Compare two captures at the requested sensitivity.
 *
 * `layout` compares structure maps and is the default; `strict` compares the
 * luminance fingerprint and will notice a colour change; `off` short-circuits
 * to a pass and says so, so a disabled comparison is visible in the result
 * rather than looking like a green one.
 */
export function compareVisual(baseline, current, { mode = 'layout', masks = [], threshold } = {}) {
  if (mode === 'off') return { mode, skipped: true, pass: true, difference: 0 };

  if (mode === 'strict') {
    const diff = visualDifference(baseline.fingerprint ?? baseline, current.fingerprint ?? current);
    const limit = threshold ?? 0.08;
    return { mode, ...diff, threshold: limit, pass: diff.difference <= limit, changedCells: [] };
  }

  const a = baseline.structure ?? baseline;
  const b = current.structure ?? current;
  if (!a?.edges || !b?.edges || a.edges.length !== b.edges.length) {
    // An older baseline has no structure map. Say so rather than silently
    // falling back — a comparison the caller did not ask for is a lie.
    throw new Error(
      'This baseline has no structure map, so mode:"layout" cannot be used. ' +
        'Re-approve the baseline, or compare with mode:"strict".',
    );
  }

  const size = a.width;
  const excluded = maskedCells(masks, size);
  let differing = 0;
  let considered = 0;
  const changedCells = [];
  for (let i = 0; i < a.edges.length; i++) {
    if (excluded.has(i)) continue;
    considered += 1;
    if (a.edges[i] !== b.edges[i]) {
      differing += 1;
      if (changedCells.length < 400) changedCells.push(i);
    }
  }
  const difference = considered ? differing / considered : 0;
  const limit = threshold ?? 0.03;
  return {
    mode,
    difference,
    changedRatio: difference,
    changedCells,
    maskedCells: excluded.size,
    consideredCells: considered,
    threshold: limit,
    pass: difference <= limit,
  };
}

/**
 * A PNG that shows a human where the difference is.
 *
 * The current screenshot, desaturated, with changed cells painted. Evidence,
 * not a comparison — nothing decides anything from this image.
 */
export async function diffImage(currentBase64, comparison, { mime = 'image/png' } = {}) {
  if (!comparison?.changedCells?.length) return null;
  const { width, height, rgba } = await platform.image.decode(currentBase64, mime);
  const out = new Uint8ClampedArray(rgba);

  // Wash the whole image towards white so the painted cells stand out. Same
  // colours as the canvas version this replaced: white at 0.55, then a red fill
  // at 0.45 with a darker 1px outline per changed cell.
  blend(out, 0, 0, width, height, width, [255, 255, 255], 0.55);

  const size = STRUCTURE_SIZE;
  const cellW = width / size;
  const cellH = height / size;
  for (const index of comparison.changedCells) {
    const x0 = Math.round((index % size) * cellW);
    const y0 = Math.round(Math.floor(index / size) * cellH);
    const x1 = Math.max(x0 + 1, Math.round(((index % size) + 1) * cellW));
    const y1 = Math.max(y0 + 1, Math.round((Math.floor(index / size) + 1) * cellH));
    blend(out, x0, y0, x1, y1, width, [220, 38, 38], 0.45);
    // Outline, inside the cell.
    blend(out, x0, y0, x1, y0 + 1, width, [153, 27, 27], 0.9);
    blend(out, x0, y1 - 1, x1, y1, width, [153, 27, 27], 0.9);
    blend(out, x0, y0, x0 + 1, y1, width, [153, 27, 27], 0.9);
    blend(out, x1 - 1, y0, x1, y1, width, [153, 27, 27], 0.9);
  }

  return platform.image.encodePng({ width, height, rgba: out });
}

/** Source-over blend of one colour into a rectangle of an RGBA buffer, in place. */
function blend(rgba, x0, y0, x1, y1, width, [r, g, b], alpha) {
  const height = rgba.length / 4 / width;
  const xs = Math.max(0, x0);
  const ys = Math.max(0, y0);
  const xe = Math.min(width, x1);
  const ye = Math.min(height, y1);
  const keep = 1 - alpha;
  for (let y = ys; y < ye; y++) {
    for (let x = xs; x < xe; x++) {
      const i = ((y * width) + x) * 4;
      rgba[i] = (rgba[i] * keep) + (r * alpha);
      rgba[i + 1] = (rgba[i + 1] * keep) + (g * alpha);
      rgba[i + 2] = (rgba[i + 2] * keep) + (b * alpha);
      rgba[i + 3] = 255;
    }
  }
}

/** Everything a baseline needs, captured once. */
export async function captureVisual(dataBase64, mime = 'image/png') {
  const [fingerprint, structure] = await Promise.all([
    visualFingerprint(dataBase64, mime),
    structureMap(dataBase64, mime),
  ]);
  return { fingerprint, structure };
}
