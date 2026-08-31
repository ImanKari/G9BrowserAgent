/**
 * Screenshots.
 *
 * The agent should reach for these only when the accessibility snapshot is
 * insufficient — canvas rendering, visual regressions, layout questions, or a
 * custom widget with no ARIA. Images are expensive in context; the tool caps
 * dimensions and defaults to JPEG for that reason.
 */

import { send, callOnNode } from '../lib/cdp.js';
import { resolveRef } from '../lib/refs.js';

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

export async function screenshot(tabId, opts = {}) {
  const { area = 'viewport', ref, format = 'jpeg', quality = 70, url } = opts;

  if (area === 'element') {
    if (!ref) throw new Error('area:"element" needs a ref from browser_snapshot.');
    const node = await resolveRef(tabId, ref, url);

    // Scroll into view and measure in ONE page call, in PAGE coordinates.
    //
    // The obvious approach — DOM.getBoxModel — returns viewport coordinates,
    // while Page.captureScreenshot's clip is in page coordinates. They agree
    // only at scroll offset zero, so this silently captured the wrong region on
    // any scrolled page and returned a plausible-looking blank image rather
    // than an error. It showed up on a horizontally scrolled page: the button
    // was at viewport x=1422, page x=2691, and the capture took x=1422.
    const rect = await callOnNode(
      tabId,
      node.backendNodeId,
      `function () {
         this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
         const r = this.getBoundingClientRect();
         return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
       }`,
    );
    if (!(rect?.width > 0) || !(rect?.height > 0)) {
      throw new Error('Element has no visible area to capture.');
    }

    const scale = fit(rect.width, rect.height);
    const { data } = await send(tabId, 'Page.captureScreenshot', {
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
      format,
      area,
      element: node.name,
      size: { width: Math.round(rect.width), height: Math.round(rect.height) },
      scale,
      dataBase64: data,
    };
  }

  if (area === 'fullpage') {
    const metrics = await send(tabId, 'Page.getLayoutMetrics');
    const content = metrics.cssContentSize ?? metrics.contentSize;
    if (!(content?.width > 0) || !(content?.height > 0)) {
      throw new Error('Could not measure the page for a full-page capture — try area:"viewport".');
    }
    const scale = fit(content.width, content.height);
    const { data } = await send(tabId, 'Page.captureScreenshot', {
      format,
      quality,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: content.width, height: content.height, scale },
    });
    return { format, area, size: content, scale, dataBase64: data };
  }

  const { data } = await send(tabId, 'Page.captureScreenshot', { format, quality });
  return { format, area: 'viewport', dataBase64: data };
}
