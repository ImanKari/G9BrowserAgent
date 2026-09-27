/**
 * Where the mouse is, per tab — and where it has been.
 *
 * CDP input moves no real cursor, so "where the pointer is" exists only as far
 * as G9BrowserAgent remembers it. v1 remembered nothing: every click teleported to its
 * target, which is both a bot signal (a pointer that appears from nowhere) and
 * a gap in the evidence (a video of a run showed things happening with no
 * visible cause). v2 keeps two things here:
 *
 * - the POSITION, persisted in platform.storage.session under
 *   `pointer:<tabId>`, so every humanized action starts where the last one
 *   ended (docs/HUMANIZE.md, "never teleport"), across service-worker restarts;
 * - the TRACK, a timestamped ring buffer of every dispatched mouse event, which
 *   the video recorder, the live watch stream and the exporter use to draw a
 *   cursor over the frames. The cursor is never drawn in the page (decision D9):
 *   a DOM overlay is visible to the page and to its MutationObservers.
 *
 * All coordinates are CSS pixels in the TOP-LEVEL viewport of the tab, the
 * space `Input.dispatchMouseEvent` speaks on the page session. `at` is
 * wall-clock milliseconds (Date.now scale), the same clock screencast frames
 * are stamped with, so a viewer can pair a frame with the pointer at that
 * moment.
 *
 * The track is module memory and dies with the worker; that is acceptable for
 * evidence of a run that is still being watched, and `sampleAt` falls back to
 * the persisted position when the track has a hole. The position is the part
 * that must survive, and it does.
 */

import { platform } from './platform.js';

const RING = 10_000;
const KEY = (tabId) => `pointer:${tabId}`;

/** tabId → sample[] (oldest first), bounded to RING. */
const tracks = new Map();
/** tabId → {x, y}: a read cache of the persisted position. */
const positions = new Map();
const subscribers = new Set();

/** The last known pointer position of a tab, or null when nothing has moved it yet. */
export async function position(tabId) {
  if (positions.has(tabId)) return { ...positions.get(tabId) };
  let stored = null;
  try {
    const got = await platform.storage.session.get(KEY(tabId));
    stored = got?.[KEY(tabId)] ?? null;
  } catch {
    stored = null;
  }
  if (!stored || !Number.isFinite(stored.x) || !Number.isFinite(stored.y)) return null;
  const p = { x: stored.x, y: stored.y };
  positions.set(tabId, p);
  return { ...p };
}

export async function setPosition(tabId, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const p = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  positions.set(tabId, p);
  try {
    await platform.storage.session.set({ [KEY(tabId)]: { ...p, at: Date.now() } });
  } catch {
    // The cache still holds it for this worker's lifetime; a lost write only
    // means the next worker re-initialises the pointer, which is not an error.
  }
}

/**
 * Append one dispatched mouse event to the tab's track.
 * `sample = { at, x, y, buttons, type }`; `type` is the CDP event type.
 */
export function record(tabId, sample) {
  if (!sample || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) return;
  const entry = {
    at: Number.isFinite(sample.at) ? sample.at : Date.now(),
    x: Math.round(sample.x * 10) / 10,
    y: Math.round(sample.y * 10) / 10,
    buttons: sample.buttons | 0,
    type: sample.type ?? 'mouseMoved',
  };
  let track = tracks.get(tabId);
  if (!track) {
    track = [];
    tracks.set(tabId, track);
  }
  track.push(entry);
  // Trim in batches: splicing on every push would make recording O(n).
  if (track.length > RING + RING / 10) track.splice(0, track.length - RING);
  for (const fn of subscribers) {
    try {
      fn(tabId, entry);
    } catch {
      // A broken watcher must never break input dispatch.
    }
  }
}

/** Samples recorded at or after `sinceMs` (wall clock), oldest first. */
export function trackSince(tabId, sinceMs = 0) {
  const track = tracks.get(tabId) ?? [];
  const from = firstAtOrAfter(track, sinceMs);
  return track.slice(from).slice(-RING);
}

/**
 * Where the pointer was at `atMs`: the last sample at or before it, else the
 * persisted position, else null. Synchronous, for per-frame use.
 */
export function sampleAt(tabId, atMs) {
  const track = tracks.get(tabId) ?? [];
  // Not firstAtOrAfter(at + ε) - 1: at epoch-millisecond magnitude a tiny ε
  // rounds away and the search lands one sample early.
  const i = firstAfter(track, atMs) - 1;
  if (i >= 0) {
    const s = track[i];
    return { x: s.x, y: s.y, buttons: s.buttons, at: s.at };
  }
  const p = positions.get(tabId);
  return p ? { x: p.x, y: p.y, buttons: 0, at: null } : null;
}

/** Watch every recorded sample of every tab. Returns an unsubscribe function. */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Drop a closed tab's track and position. */
export async function forget(tabId) {
  tracks.delete(tabId);
  positions.delete(tabId);
  try {
    await platform.storage.session.remove(KEY(tabId));
  } catch {
    /* nothing to reclaim */
  }
}

function firstAfter(track, at) {
  let lo = 0;
  let hi = track.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid].at <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function firstAtOrAfter(track, at) {
  let lo = 0;
  let hi = track.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid].at < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
