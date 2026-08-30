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

const MAX_DIMENSION = 2000;

export async function screenshot(tabId, opts = {}) {
  const { area = 'viewport', ref, format = 'jpeg', quality = 70, url } = opts;

  if (area === 'element') {
    if (!ref) throw new Error('area:"element" needs a ref from browser_snapshot.');
    const node = await resolveRef(tabId, ref, url);
    await callOnNode(
      tabId,
      node.backendNodeId,
      `function () { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }`,
    );
    const { model } = await send(tabId, 'DOM.getBoxModel', { backendNodeId: node.backendNodeId });
    const q = model.content;
    const x = Math.min(q[0], q[2], q[4], q[6]);
    const y = Math.min(q[1], q[3], q[5], q[7]);
    const clip = {
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.min(model.width, MAX_DIMENSION),
      height: Math.min(model.height, MAX_DIMENSION),
      scale: 1,
    };
    if (clip.width <= 0 || clip.height <= 0) throw new Error('Element has no visible area to capture.');
    const { data } = await send(tabId, 'Page.captureScreenshot', { format, quality, clip });
    return { format, area, element: node.name, dataBase64: data };
  }

  if (area === 'fullpage') {
    const metrics = await send(tabId, 'Page.getLayoutMetrics');
    const content = metrics.cssContentSize ?? metrics.contentSize;
    const { data } = await send(tabId, 'Page.captureScreenshot', {
      format,
      quality,
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: Math.min(content.width, MAX_DIMENSION),
        height: Math.min(content.height, 8000),
        scale: 1,
      },
    });
    return { format, area, size: content, dataBase64: data };
  }

  const { data } = await send(tabId, 'Page.captureScreenshot', { format, quality });
  return { format, area: 'viewport', dataBase64: data };
}
