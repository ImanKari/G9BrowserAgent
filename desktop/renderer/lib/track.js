/**
 * The cursor, drawn from data (D9): the pointer is a timestamped track stored beside screencast
 * frames, never an element in the page. This module is the geometry and timing of drawing it.
 * Pure and browser-safe; the watch view, the run replayer and the tray icon all use it.
 *
 * Coordinates: pointer samples are CSS pixels of the tab's viewport (what Input.dispatchMouseEvent
 * takes). A screencast frame is that viewport scaled to the JPEG's size; its metadata says the
 * viewport size (`deviceWidth`/`deviceHeight`, DIP) and any top offset. So
 *   image = pointer × (imageSize / deviceSize), then the image is fitted into the canvas.
 */

/** The arrow, normalised to a 1×1 box with its hot spot at (0, 0). Also the tray icon's glyph. */
export const CURSOR_POLYGON = [
  [0, 0], [0, 0.78], [0.2, 0.6], [0.34, 0.92], [0.47, 0.86], [0.33, 0.56], [0.58, 0.56],
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v));

/** Normalise one pointer sample from any producer (live event, pointer.jsonl, frame record). */
export function normalizeSample(s) {
  if (!s || typeof s !== 'object') return null;
  const at = num(s.at ?? s.timestamp ?? s.t ?? s.time);
  const x = num(s.x);
  const y = num(s.y);
  if (!Number.isFinite(at) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { at, x, y, buttons: Number(s.buttons ?? 0) || 0, type: s.type ?? null };
}

/** First index whose `at` is > t (upper bound), for arrays sorted by `at`. */
export function upperBound(items, t, key = 'at') {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid][key] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The pointer at time t, linearly interpolated between the samples around it.
 * Buttons are discrete: they come from the earlier sample. `pressAge` is ms since the latest
 * press at or before t (for the click ripple), or null.
 */
export function interpolateTrack(samples, t) {
  if (!samples?.length) return null;
  const i = upperBound(samples, t);
  let pos;
  if (i === 0) pos = { ...samples[0] };
  else if (i >= samples.length) pos = { ...samples[samples.length - 1] };
  else {
    const a = samples[i - 1];
    const b = samples[i];
    const span = b.at - a.at;
    const k = span > 0 ? (t - a.at) / span : 1;
    pos = { at: t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, buttons: a.buttons, type: a.type };
  }
  let pressAge = null;
  for (let j = Math.min(i, samples.length) - 1; j >= 0 && t - samples[j].at < 1000; j--) {
    if (samples[j].type === 'mousePressed' || samples[j].type === 'down') {
      pressAge = t - samples[j].at;
      break;
    }
  }
  return { ...pos, pressAge };
}

/** Fit a src rectangle into a box, preserving aspect ratio, centred ("contain"). */
export function fitRect(srcW, srcH, boxW, boxH) {
  if (!(srcW > 0 && srcH > 0 && boxW > 0 && boxH > 0)) return { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  return { x: (boxW - width) / 2, y: (boxH - height) / 2, width, height, scale };
}

/**
 * A viewport point → a point in the image. Without metadata the image is assumed to be the
 * viewport at 1:1 (what a screenshot is).
 */
export function viewportToImage(point, metadata, imgW, imgH) {
  const devW = num(metadata?.deviceWidth);
  const devH = num(metadata?.deviceHeight);
  const top = num(metadata?.offsetTop) || 0;
  const sx = devW > 0 ? imgW / devW : 1;
  const sy = devH > 0 ? imgH / (devH + top) : sx;
  return { x: point.x * sx, y: (point.y + top) * sy };
}

/** A viewport point → canvas pixels, through the image's fitted rectangle. */
export function viewportToCanvas(point, metadata, imgW, imgH, fitted) {
  const p = viewportToImage(point, metadata, imgW, imgH);
  const k = imgW > 0 ? fitted.width / imgW : 0;
  return { x: fitted.x + p.x * k, y: fitted.y + p.y * k };
}

/** The frame to show at time t: the last one at or before t (the first one before the start). */
export function frameIndexAt(frames, t) {
  if (!frames?.length) return -1;
  const i = upperBound(frames, t);
  return Math.max(0, i - 1);
}

/**
 * A bounded, time-ordered buffer of live pointer samples for one tab. Out-of-order samples
 * (two producers, a reconnect) are inserted in place rather than appended.
 */
export class TrackBuffer {
  constructor(max = 4000) {
    this.max = max;
    this.samples = [];
  }

  push(raw) {
    const s = normalizeSample(raw);
    if (!s) return false;
    const arr = this.samples;
    if (!arr.length || arr[arr.length - 1].at <= s.at) arr.push(s);
    else arr.splice(upperBound(arr, s.at), 0, s);
    if (arr.length > this.max) arr.splice(0, arr.length - this.max);
    return true;
  }

  clear() {
    this.samples = [];
  }

  get last() {
    return this.samples[this.samples.length - 1] ?? null;
  }

  /**
   * Where to draw the cursor now. Live samples arrive in bursts; drawing slightly in the past
   * (`delayMs`) keeps a sample on both sides so motion is interpolated rather than jumping.
   * Never draws further back than the newest sample minus the delay would leave the cursor idle.
   */
  at(nowMs, delayMs = 100) {
    if (!this.samples.length) return null;
    const t = Math.min(nowMs - delayMs, this.last.at);
    return interpolateTrack(this.samples, t);
  }
}

/** Polygon points for the cursor at canvas position (x, y) and a pixel size. */
export function cursorPoints(x, y, size = 22) {
  return CURSOR_POLYGON.map(([px, py]) => [x + px * size, y + py * size]);
}
