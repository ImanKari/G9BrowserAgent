/**
 * Screenshots.
 *
 * The agent should reach for these only when the accessibility snapshot is
 * insufficient — canvas rendering, visual regressions, layout questions, or a
 * custom widget with no ARIA. Images are expensive in context; the tool caps
 * dimensions and defaults to JPEG for that reason.
 *
 * ## A screenshot must not do things a person would not
 *
 * A viewport capture is invisible to the page. Two things the other areas used
 * to do are not (live round 2, the page's own listeners, 50/50 runs):
 *
 * - `captureBeyondViewport: true` makes Chromium RESIZE the frame's viewport
 *   for the capture: the page got 1–2 `resize` events, and in 27 of 50 runs
 *   saw a transient innerWidth × innerHeight of 1 × 1.
 * - the element path called `scrollIntoView` — a programmatic scroll no wheel
 *   produced, which plan §6.1 rules out at the human levels — and left the
 *   page scrolled there (0 → 656 → 1411 → 656), changing what the next action
 *   saw.
 *
 * So at the human and stealth input levels (lib/humanize.js levelFor, which
 * includes the tab's stealth floor) an element is brought into view the way
 * the interaction tools reach one — with the wheel (interact.js
 * bringIntoView) — and captured with a viewport clip; a full page that does
 * not fit the viewport is refused at stealth and captured with a note at
 * human. Level `off` keeps v1's behaviour exactly, and its result says what
 * the page saw.
 */

import { send } from '../lib/cdp.js';
import { resolveRef } from '../lib/refs.js';
import { callInWorld, inWorld } from '../lib/world.js';
import { platform } from '../lib/platform.js';
import { position as pointerPosition } from '../lib/pointer.js';
import { levelFor } from '../lib/humanize.js';
import { bringIntoView } from './interact.js';
import { realWindowState } from './tabs.js';

/**
 * Where G9's pointer is on this tab, for the result. The cursor is never drawn
 * in the page (decision D9), so a viewer that wants to show it draws it from
 * this. Null when nothing has moved the pointer on this tab yet.
 */
async function pointerFor(tabId) {
  try {
    return (await pointerPosition(tabId)) ?? null;
  } catch {
    return null;
  }
}

/** Longest edge of the returned image. Oversized captures are scaled, not cut. */
const MAX_DIMENSION = 2000;
const MAX_CAPTURE_HEIGHT = 8000;

/**
 * Fit a region inside the image budget by scaling.
 *
 * This used to clamp width and height instead, which silently *cropped*.
 * A full-page shot is usually taken to find content that runs off the side of
 * the page — cropping to 2000px removed exactly the evidence being looked for,
 * and nothing in the result said so.
 */
function fit(width, height) {
  return Math.min(1, MAX_DIMENSION / width, MAX_CAPTURE_HEIGHT / height);
}

/**
 * Capture, retrying once if the command STALLS rather than fails.
 *
 * `Page.captureScreenshot` intermittently never returns: the browser accepts
 * the command and no answer ever comes. It is a compositor stall, most visible
 * headless but not exclusive to it, and it is not deterministic — the same page
 * captures fine on the next attempt. Before `cdp.send()` had a timeout this
 * consumed the whole 60s tool budget and then blamed a JavaScript dialog.
 *
 * One retry, only for a stall, and the result SAYS when it happened. Retrying
 * quietly would turn a browser problem into a mystery about why screenshots are
 * sometimes slow; retrying at all is worth it because the alternative is losing
 * evidence the user asked for to a transient fault.
 */
/** A capture slower than this gets the same explanation as a stalled one (a 36 s capture had none). */
const SLOW_CAPTURE_MS = 10_000;

async function captureWithRetry(tabId, params) {
  // A launched HEADLESS engine's tab behind a page-opened tab renders a frame at a time — its
  // screenshots took 24–46 s (P8 matrix, round 3). It is brought to the front first; the extension
  // never rearranges a person's tabs (platform.tabs.ensureFront is a no-op there).
  await platform.tabs.ensureFront?.(tabId)?.catch?.(() => null);
  const started = Date.now();
  try {
    const result = await send(tabId, 'Page.captureScreenshot', params);
    const ms = Date.now() - started;
    if (ms < SLOW_CAPTURE_MS) return { ...result, stalled: false };
    return { ...result, stalled: false, slowMs: ms, why: await stallContext(tabId) };
  } catch (err) {
    if (!/did not return after/.test(String(err?.message ?? err))) throw err;
    const why = await stallContext(tabId);
    const result = await send(tabId, 'Page.captureScreenshot', params);
    return { ...result, stalled: true, why };
  }
}

/**
 * Why a capture may have stalled, when the page or its window can say.
 *
 * "A random compositor stall" was the only explanation offered, and it was
 * wrong in the cases the P8 matrix measured (round 2): a launched tab that was
 * not the one in front of its window, and a minimized headed window, render ~1
 * frame per 1.5 s — the first capture there stalled 45 s every time. A page
 * that renders no frames cannot be captured quickly; that is the cause to name.
 */
async function stallContext(tabId) {
  const state = await inWorld(tabId, 'document.visibilityState', { timeoutMs: 5000 }).catch(() => null);
  if (state === 'hidden') {
    return 'The page is HIDDEN (document.visibilityState="hidden"): a background tab or a minimized or covered window renders no frames, which is the usual cause.';
  }
  // The REAL window first: a minimized launched window reports a "visible" page, and its tab is in
  // front of it — only the window says why nothing renders (P8 matrix, round 3: this used to be
  // explained as a compositor stall, 2/3).
  if ((await realWindowState(tabId)) === 'minimized') {
    return 'Its window is minimized, and a minimized window renders almost no frames — the usual cause. Restore the window (and keep it on screen).';
  }
  // `active` is "in front of its real window" on both engines (platform-cdp isActive).
  const tab = await platform.tabs.get(tabId).catch(() => null);
  if (tab && tab.active === false) {
    return 'This tab is not the one in front of its window (another tab — one the page opened, for example — is in front of it), and a tab behind another is rendered only a frame at a time — the usual cause. Focus it (browser_tabs action:"focus"), or close the tab in front.';
  }
  return null;
}

const stallNote = (capture) => {
  if (capture.stalled) {
    return {
      note: 'The first capture attempt stalled and was retried; the image below is from the successful retry. ' +
        (capture.why ?? 'The page reports it is visible, its tab is in front and its window is not minimized, so this looks like a browser-side compositor stall, not a page problem.'),
    };
  }
  if (capture.slowMs) {
    return {
      note: `The capture took ${Math.round(capture.slowMs / 1000)} s. ` +
        (capture.why ?? 'The page reports it is visible, its tab is in front and its window is not minimized, so the browser itself was slow to render.'),
    };
  }
  return {};
};

const RESIZE_NOTE =
  'The page saw this capture: a capture beyond the viewport makes the browser resize the page\'s viewport for it ' +
  '(resize events, briefly as small as 1×1), and the page\'s own resize listeners run.';

/** Level `off`: v1's element capture, exactly (scrollIntoView + a clip beyond the viewport). */
async function elementCaptureOff(tabId, node, { format, quality }) {
  // Scroll into view and measure in ONE page call, in PAGE coordinates.
  //
  // The obvious approach — DOM.getBoxModel — returns viewport coordinates,
  // while Page.captureScreenshot's clip is in page coordinates. They agree
  // only at scroll offset zero, so this silently captured the wrong region on
  // any scrolled page and returned a plausible-looking blank image rather
  // than an error. It showed up on a horizontally scrolled page: the button
  // was at viewport x=1422, page x=2691, and the capture took x=1422.
  const rect = await callInWorld(
    tabId,
    node.backendNodeId,
    `function () {
       this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
       const r = this.getBoundingClientRect();
       return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
     }`,
    [],
    node.sessionId ?? null,
  );
  if (!(rect?.width > 0) || !(rect?.height > 0)) {
    throw new Error('Element has no visible area to capture.');
  }

  const scale = fit(rect.width, rect.height);
  const capture = await captureWithRetry(tabId, {
    format,
    quality,
    captureBeyondViewport: true,
    clip: {
      x: Math.max(0, rect.x),
      y: Math.max(0, rect.y),
      width: rect.width,
      height: rect.height,
      scale,
    },
  });
  return {
    size: { width: Math.round(rect.width), height: Math.round(rect.height) },
    scale,
    capture,
    pageSaw: 'At input level off the element was scrolled into view programmatically (scrollIntoView) and the page was left scrolled there. ' + RESIZE_NOTE,
  };
}

/**
 * Human levels: the element is reached with the wheel, then captured with a
 * clip INSIDE the viewport (no captureBeyondViewport, so no resize). An element
 * larger than the viewport is captured as far as it shows, and the result
 * says so.
 */
async function elementCaptureHuman(tabId, reached, { format, quality }) {
  const box = reached.box;
  const vp = reached.viewport;
  if (!box || !(box.width > 0) || !(box.height > 0)) throw new Error('Element has no visible area to capture.');
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(vp.width, box.x + box.width);
  const y1 = Math.min(vp.height, box.y + box.height);
  if (x1 - x0 < 1 || y1 - y0 < 1) throw new Error('The element could not be brought on screen to capture it.');
  // The clip is in PAGE coordinates (see elementCaptureOff): the viewport box
  // plus where the visual viewport sits in the page.
  const metrics = await send(tabId, 'Page.getLayoutMetrics').catch(() => null);
  const vv = metrics?.cssVisualViewport ?? {};
  const pageX = Number(vv.pageX) || 0;
  const pageY = Number(vv.pageY) || 0;
  const width = x1 - x0;
  const height = y1 - y0;
  const scale = fit(width, height);
  const capture = await captureWithRetry(tabId, {
    format,
    quality,
    clip: { x: x0 + pageX, y: y0 + pageY, width, height, scale },
  });
  const cropped = width + 0.5 < box.width || height + 0.5 < box.height;
  return {
    size: { width: Math.round(width), height: Math.round(height) },
    scale,
    capture,
    ...(cropped
      ? {
          cropped: {
            element: { width: Math.round(box.width), height: Math.round(box.height) },
            note: `The element (${Math.round(box.width)}×${Math.round(box.height)}) is larger than the part of it on screen; ` +
              `the ${Math.round(width)}×${Math.round(height)} on screen was captured. Capturing beyond the viewport would ` +
              'resize the page\'s viewport, which the page can see.',
          },
        }
      : {}),
  };
}

export async function screenshot(tabId, opts = {}) {
  const { area = 'viewport', ref, format = 'jpeg', quality = 70, url } = opts;

  if (area === 'element') {
    if (!ref) throw new Error('area:"element" needs a ref from browser_snapshot.');
    const node = await resolveRef(tabId, ref, url);
    const reached = await bringIntoView(tabId, node, opts);
    const shot = reached.level === 'off'
      ? await elementCaptureOff(tabId, node, { format, quality })
      : await elementCaptureHuman(tabId, reached, { format, quality });
    return {
      format,
      area,
      element: node.name,
      size: shot.size,
      scale: shot.scale,
      ...(shot.cropped ? { cropped: shot.cropped } : {}),
      ...(reached.scroll && reached.scroll.via !== 'none' ? { scrolled: reached.scroll } : {}),
      ...(shot.pageSaw ? { pageSaw: shot.pageSaw } : {}),
      ...(reached.note ? { reachNote: reached.note } : {}),
      ...(reached.humanize ? { humanize: reached.humanize } : {}),
      ...stallNote(shot.capture),
      pointer: await pointerFor(tabId),
      dataBase64: shot.capture.data,
    };
  }

  if (area === 'fullpage') {
    const metrics = await send(tabId, 'Page.getLayoutMetrics');
    const content = metrics.cssContentSize ?? metrics.contentSize;
    if (!(content?.width > 0) || !(content?.height > 0)) {
      throw new Error('Could not measure the page for a full-page capture — try area:"viewport".');
    }
    const view = metrics.cssVisualViewport ?? metrics.cssLayoutViewport ?? {};
    const fits = content.width <= Math.ceil(Number(view.clientWidth) || 0) && content.height <= Math.ceil(Number(view.clientHeight) || 0);
    const hz = await levelFor(tabId, opts);
    if (fits) {
      // The whole page is already on screen: a viewport capture is the full page, and the page sees nothing.
      const capture = await captureWithRetry(tabId, { format, quality });
      return { format, area, size: content, scale: 1, note: 'The whole page fits in the viewport, so it was captured without resizing anything.', ...stallNote(capture), pointer: await pointerFor(tabId), dataBase64: capture.data };
    }
    if (hz.level === 'stealth') {
      throw new Error(
        `A full-page capture of this page (${Math.round(content.width)}×${Math.round(content.height)}, larger than the ` +
          `${Math.round(Number(view.clientWidth) || 0)}×${Math.round(Number(view.clientHeight) || 0)} viewport) makes the browser ` +
          'resize the page\'s viewport for the capture — the page sees resize events, once as small as 1×1 — and at the ' +
          'stealth level G9 does nothing a page could see that a person would not. Nothing was captured. Take area:"viewport" ' +
          'shots, scrolling between them (browser_interact action:"scroll"), or capture an element (area:"element").',
      );
    }
    const scale = fit(content.width, content.height);
    const capture = await captureWithRetry(tabId, {
      format,
      quality,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: content.width, height: content.height, scale },
    });
    return { format, area, size: content, scale, pageSaw: RESIZE_NOTE, ...stallNote(capture), pointer: await pointerFor(tabId), dataBase64: capture.data };
  }

  const capture = await captureWithRetry(tabId, { format, quality });
  return { format, area: 'viewport', ...stallNote(capture), pointer: await pointerFor(tabId), dataBase64: capture.data };
}
