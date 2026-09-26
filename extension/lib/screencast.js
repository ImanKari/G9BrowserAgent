/**
 * One screencast per tab, shared.
 *
 * `Page.startScreencast` is a per-session singleton: a second start replaces
 * the first one's parameters, and a stop ends it for everybody. v1 had one
 * consumer (issue video) and could ignore that. v2 has at least two — the
 * issue video recorder and the live watch stream (desktop watch window) — and
 * without a single owner one of them stopping would silently blind the other.
 *
 * So consumers register here by id (`video:<issueId>`, `watch`, …). The first
 * one starts the stream, the last one to leave stops it, and in between the
 * stream runs with the most demanding parameters any consumer asked for
 * (highest quality and size, smallest everyNthFrame); a consumer that asked
 * for fewer frames is handed every k-th one.
 *
 * ## Acknowledging frames
 *
 * Chromium sends the next frame only after the previous one is acked, so the
 * ack is the back-pressure. By default the ack goes out FIRST, before fan-out,
 * so a slow watcher never stalls the stream. A consumer that registers with
 * `backpressure: true` — the video recorder, whose rule since v1 is "ack only
 * after the frame is durable" — instead makes the ack wait for the promise its
 * handler returns (bounded by ACK_WAIT_MAX_MS, so a wedged writer can slow the
 * stream but never stop it). Acks use `cdp.sendOnLiveSession`: the frame event
 * is itself proof the session is live, and paying `send()`'s halt check,
 * attach check and target lookup per frame starved the worker badly enough in
 * v1 that a scroll during a recording timed out.
 *
 * ## The wheel stall
 *
 * While a screencast runs, `Input.dispatchMouseEvent` with `mouseWheel` can
 * wedge (v1.5.1). Nothing here works around it; the per-command timeout in
 * cdp.js reports the stall by name, and tools/interact.js decides per input
 * level what to do about it.
 *
 * State is module memory. After a service-worker restart Chromium keeps
 * sending frames for a stream nobody here remembers; `onRevive` lets a
 * consumer whose own state is durable (the video recorder keeps its session in
 * storage) re-subscribe before the frame is judged an orphan. An orphan stream
 * is acked and stopped.
 */

import { send, sendOnLiveSession } from './cdp.js';
import { inWorld } from './world.js';

export const DEFAULTS = Object.freeze({ format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });

/** How long a back-pressure consumer may hold the ack. */
const ACK_WAIT_MAX_MS = 5000;

/**
 * tabId → {
 *   consumers: Map<id, { opts|null, fn|null, seen, backpressure }>,
 *   running: boolean, params: object|null, chain: Promise
 * }
 */
const tabs = new Map();
const revivers = new Set();
/**
 * Frames already handled, by event object. NOT by `params.sessionId`: that
 * number names the screencast SESSION (Chromium bumps it per startScreencast,
 * and the ack must echo it), so every frame of one stream carries the same
 * value. Deduping on it dropped every frame after the first — unacked, which
 * also stalled the stream. A frame that reaches onFrame twice through two
 * routes is the same event object; that is what is remembered.
 */
const handled = new WeakSet();

function tabState(tabId) {
  let tab = tabs.get(tabId);
  if (!tab) {
    tab = { consumers: new Map(), running: false, params: null, chain: Promise.resolve() };
    tabs.set(tabId, tab);
  }
  return tab;
}

/** Start/stop for one tab run one at a time, so a stop cannot overtake the start it follows. */
function serial(tab, job) {
  const next = tab.chain.then(job, job);
  tab.chain = next.catch(() => {});
  return next;
}

function normalize(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  return {
    format: o.format === 'png' ? 'png' : 'jpeg',
    quality: clampInt(o.quality, 0, 100, DEFAULTS.quality),
    maxWidth: clampInt(o.maxWidth, 16, 8192, DEFAULTS.maxWidth),
    maxHeight: clampInt(o.maxHeight, 16, 8192, DEFAULTS.maxHeight),
    everyNthFrame: clampInt(o.everyNthFrame, 1, 1000, 1),
  };
}

function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** The stream every current consumer can live with: the most demanding of each. */
export function effectiveParams(optsList) {
  const list = optsList.filter(Boolean);
  if (!list.length) return null;
  return {
    format: list.every((o) => o.format === 'png') ? 'png' : 'jpeg',
    quality: Math.max(...list.map((o) => o.quality)),
    maxWidth: Math.max(...list.map((o) => o.maxWidth)),
    maxHeight: Math.max(...list.map((o) => o.maxHeight)),
    everyNthFrame: Math.min(...list.map((o) => o.everyNthFrame)),
  };
}

const sameParams = (a, b) => !!a && !!b
  && a.format === b.format && a.quality === b.quality && a.maxWidth === b.maxWidth
  && a.maxHeight === b.maxHeight && a.everyNthFrame === b.everyNthFrame;

/**
 * Register a consumer and make sure the stream runs with parameters it can use.
 * Rejects (and unregisters the consumer) when the browser refuses to start.
 * Options beyond the CDP ones: `backpressure` (see the header).
 */
/**
 * Page.startScreencast, asked again for a moment the browser refuses it in: "Not attached to an
 * active page" while the tab is between two documents (a tab opened a moment ago committing its first
 * navigation, a process swap). A replay that opened its own launched tab started its evidence stream
 * in exactly that moment and recorded 0 frames — 2 of 10 Engine 2 live runs on 2026-09-25 (the
 * daemon log said "no screencast (Not attached to an active page)"). Anything else fails at once.
 */
const TRANSIENT_START = /Not attached to an active page/i;
async function startScreencast(tabId, params) {
  for (let attempt = 1; ; attempt++) {
    try {
      await send(tabId, 'Page.startScreencast', params);
      return attempt;
    } catch (err) {
      if (attempt >= 4 || !TRANSIENT_START.test(String(err?.message ?? err))) throw err;
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
}

export async function start(tabId, consumerId, opts = {}) {
  if (!consumerId || typeof consumerId !== 'string') throw new Error('screencast.start needs a consumer id.');
  const tab = tabState(tabId);
  const previous = tab.consumers.get(consumerId);
  // Registered BEFORE the stream starts, so the first frame already has
  // somewhere to go and is never mistaken for an orphan.
  tab.consumers.set(consumerId, {
    opts: normalize(opts),
    fn: previous?.fn ?? null,
    seen: 0,
    backpressure: opts.backpressure === true,
  });

  return serial(tab, async () => {
    const want = effectiveParams([...tab.consumers.values()].map((c) => c.opts));
    if (!want || (tab.running && sameParams(want, tab.params))) return;
    // A new consumer that needs more than the running stream gives restarts it.
    if (tab.running) await send(tabId, 'Page.stopScreencast').catch(() => {});
    try {
      const attempts = await startScreencast(tabId, want);
      tab.running = true;
      tab.params = want;
      // Said, so a caller can log it: a start that needed a second try was a page between documents.
      if (attempts > 1) return { attempts };
    } catch (err) {
      const restarting = tab.running;
      tab.running = false;
      tab.params = null;
      tab.consumers.delete(consumerId);
      // A RESTART the browser refused (a new consumer asked for more than the
      // running stream gave) had already stopped the stream the others were
      // using. Bring theirs back with the parameters they had, or the watch
      // window would go dark because somebody else's video failed to start.
      const rest = restarting ? effectiveParams([...tab.consumers.values()].map((c) => c.opts)) : null;
      if (rest) {
        try {
          await send(tabId, 'Page.startScreencast', rest);
          tab.running = true;
          tab.params = rest;
        } catch {
          /* the browser serves nobody now; the next start tries again */
        }
      }
      if (!tab.consumers.size) tabs.delete(tabId);
      throw err;
    }
  });
}

/**
 * Unregister a consumer; the stream stops when the last one leaves.
 * `sendStop:false` is for a tab whose debugger session is already gone (a
 * detach or a closed tab), where talking to CDP would only re-attach it.
 */
export async function stop(tabId, consumerId, { sendStop = true } = {}) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  tab.consumers.delete(consumerId);
  if ([...tab.consumers.values()].some((c) => c.opts)) return;
  await serial(tab, async () => {
    if ([...tab.consumers.values()].some((c) => c.opts)) return;
    const wasRunning = tab.running;
    tab.running = false;
    tab.params = null;
    if (!tab.consumers.size && tabs.get(tabId) === tab) tabs.delete(tabId);
    if (wasRunning && sendStop) await send(tabId, 'Page.stopScreencast').catch(() => {});
  });
}

/** Set (or replace) the frame handler of a consumer. May be called before or after start. */
export function subscribe(tabId, consumerId, fn) {
  const tab = tabState(tabId);
  const current = tab.consumers.get(consumerId);
  if (current) current.fn = fn;
  else tab.consumers.set(consumerId, { opts: null, fn, seen: 0, backpressure: false });
}

/** Ids of the consumers that have started a stream on this tab. */
export function consumers(tabId) {
  const tab = tabs.get(tabId);
  return tab ? [...tab.consumers.entries()].filter(([, c]) => c.opts).map(([id]) => id) : [];
}

/** Is a stream running on this tab, and with what parameters? */
export function status(tabId) {
  const tab = tabs.get(tabId);
  return tab ? { running: tab.running, params: tab.params, consumers: consumers(tabId) } : { running: false, params: null, consumers: [] };
}

/**
 * Register a function that may re-subscribe a durable consumer after a worker
 * restart. Called with the tabId of a frame nobody is registered for.
 */
export function onRevive(fn) {
  revivers.add(fn);
  return () => revivers.delete(fn);
}

/**
 * Re-register a consumer for a stream that is ALREADY running — the revival
 * path after a worker restart, where calling Page.startScreencast again would
 * only reset the stream that is still delivering.
 */
export function adopt(tabId, consumerId, opts = {}, fn = null) {
  const tab = tabState(tabId);
  const previous = tab.consumers.get(consumerId);
  tab.consumers.set(consumerId, {
    opts: normalize(opts),
    fn: fn ?? previous?.fn ?? null,
    seen: 0,
    backpressure: opts.backpressure === true,
  });
  tab.running = true;
  tab.params = tab.params ?? effectiveParams([...tab.consumers.values()].map((c) => c.opts));
}

/** Drop all state for a tab whose session is gone. No CDP traffic. */
export function forget(tabId) {
  tabs.delete(tabId);
}

/** When the last frame of this tab's stream arrived (ms epoch), or null. */
export function lastFrameAt(tabId) {
  return tabs.get(tabId)?.lastFrameAt ?? null;
}

/**
 * Tell a live viewer when its picture has stopped being live.
 *
 * Chromium produces no screencast frames for a page that renders nothing — a
 * hidden page above all (a background tab, a minimized or covered window).
 * A watch there sent exactly one frame and then nothing, while the page kept
 * animating, and no event said why: the desktop showed a stale picture as if
 * it were current (P8 matrix, round 2: 10/10 hidden rows; 40 frames on every
 * visible one). This checks visibility when the watch starts and whenever no
 * frame has arrived for `idleMs`, and calls `onStatus` on every CHANGE:
 *
 *   { state: 'hidden', visibility, reason, lastFrameAt }  the page is hidden
 *   { state: 'idle',   visibility, reason, lastFrameAt }  visible, but no frame for idleMs
 *                                                         (a static page sends none — normal)
 *   { state: 'live' }                                     frames are arriving again
 *
 * A page whose visibility cannot be read reports 'idle' with visibility null.
 * Returns stop(). One CDP round trip per check, only while frames are missing.
 */
export function watchdog(tabId, { onStatus, idleMs = 2000, everyMs = 1000 } = {}) {
  if (typeof onStatus !== 'function') throw new Error('screencast.watchdog needs onStatus.');
  const startedAt = Date.now();
  let last = null;
  let stopped = false;
  let checking = false;
  const report = (status) => {
    if (stopped || last === status.state) return;
    last = status.state;
    try { onStatus({ ...status, at: Date.now() }); } catch { /* a viewer's problem is not the stream's */ }
  };
  const check = async (initial = false) => {
    if (stopped || checking) return;
    const seen = tabs.get(tabId)?.lastFrameAt ?? null;
    const quietFor = Date.now() - (seen ?? startedAt);
    // A frame arrived lately. That means live — unless the page was hidden: a hidden page still
    // hands over one frame now and then (the matrix saw hidden → live → hidden from a single one),
    // so "live" again needs the page to say it is visible.
    if (!initial && quietFor < idleMs && last !== 'hidden') {
      if (seen) report({ state: 'live' });
      return;
    }
    checking = true;
    try {
      const visibility = await inWorld(tabId, 'document.visibilityState', { timeoutMs: 5000 }).catch(() => null);
      if (stopped) return;
      if (!initial && quietFor < idleMs) {
        // Frames are arriving on a page reported hidden before: live only once it says visible.
        if (visibility === 'visible') report({ state: 'live' });
      } else if (visibility === 'hidden') {
        report({
          state: 'hidden',
          visibility,
          lastFrameAt: seen,
          reason: 'The tab is hidden (document.visibilityState="hidden"): a background tab, or a minimized or covered window. ' +
            'A hidden page renders no frames, so the picture is the last one it drew and is NOT live. ' +
            'Bring the tab to the front, or hand it to a launched engine, to see it move again.',
        });
      } else if (!initial) {
        report({
          state: 'idle',
          visibility,
          lastFrameAt: seen,
          reason: `No frame for ${Math.round(quietFor / 1000)} s while the page reports it is ${visibility ?? 'in an unknown state'}. ` +
            'A page that is not changing sends no frames, so this is often normal; the picture is the last one it drew.',
        });
      }
    } finally {
      checking = false;
    }
  };
  check(true);
  const timer = setInterval(() => { check(false); }, everyMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function ack(tabId, params) {
  try {
    return Promise.resolve(sendOnLiveSession(tabId, 'Page.screencastFrameAck', { sessionId: params.sessionId }))
      .catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/**
 * Called by tools/events.js for every `Page.screencastFrame`. Never throws.
 */
export async function onFrame(tabId, params) {
  if (!params || typeof params.data !== 'string') return;
  // The same frame delivered twice (two routes wired to it) is handled once:
  // a second copy in the video would be a lie about what was on screen.
  if (handled.has(params)) return;
  handled.add(params);
  let tab = tabs.get(tabId);

  if (!tab || !consumers(tabId).length) {
    for (const revive of revivers) {
      try {
        await revive(tabId);
      } catch {
        /* a consumer that cannot revive is simply absent */
      }
    }
    tab = tabs.get(tabId);
  }

  const live = tab ? [...tab.consumers.values()].filter((c) => c.opts) : [];
  if (!tab || !live.length) {
    // Nobody wants these frames any more. Ack (so the session is not left
    // with an unanswered frame) and stop the stream.
    await ack(tabId, params);
    try {
      await Promise.resolve(sendOnLiveSession(tabId, 'Page.stopScreencast', {})).catch(() => {});
    } catch {
      /* already gone */
    }
    if (tab) tab.running = false;
    return;
  }
  // A stream we did not start in this worker's lifetime (revived) is running.
  tab.running = true;

  const frame = { data: params.data, metadata: params.metadata ?? {}, at: Date.now() };
  tab.lastFrameAt = frame.at;
  const holdsAck = live.some((c) => c.backpressure && c.fn);
  if (!holdsAck) ack(tabId, params);

  const streamNth = tab.params?.everyNthFrame ?? 1;
  const waits = [];
  for (const c of live) {
    c.seen += 1;
    const k = Math.max(1, Math.round(c.opts.everyNthFrame / streamNth));
    if ((c.seen - 1) % k !== 0 || typeof c.fn !== 'function') continue;
    try {
      const out = c.fn(frame);
      if (c.backpressure && out && typeof out.then === 'function') waits.push(out);
    } catch {
      // One broken consumer must not take the others' frames with it.
    }
  }

  if (holdsAck) {
    let timer;
    await Promise.race([
      Promise.allSettled(waits),
      new Promise((resolve) => { timer = setTimeout(resolve, ACK_WAIT_MAX_MS); }),
    ]);
    clearTimeout(timer);
    await ack(tabId, params);
  }
}
