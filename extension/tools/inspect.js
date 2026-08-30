/**
 * DevTools-panel inspection.
 *
 * Maps onto what a human reads in DevTools:
 *   dom      -> Elements
 *   styles   -> Elements > Computed / Styles
 *   box      -> Elements > Layout (box model)
 *   storage  -> Application > Storage
 *   cookies  -> Application > Cookies
 *   frames   -> Application > Frames
 */

import { send, callOnNode, evaluate } from '../lib/cdp.js';
import { resolveRef } from '../lib/refs.js';

const api = globalThis.browser ?? globalThis.chrome;

/** Outer HTML of an element (or the whole document when no ref is given). */
export async function dom(tabId, { ref, selector, depth = 3, url } = {}) {
  if (ref) {
    const node = await resolveRef(tabId, ref, url);
    const { outerHTML } = await send(tabId, 'DOM.getOuterHTML', { backendNodeId: node.backendNodeId });
    return { ref, role: node.role, name: node.name, html: clip(outerHTML) };
  }

  if (selector) {
    const { root } = await send(tabId, 'DOM.getDocument', { depth: 0 });
    const { nodeId } = await send(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`No element matches selector ${JSON.stringify(selector)}.`);
    const { outerHTML } = await send(tabId, 'DOM.getOuterHTML', { nodeId });
    return { selector, html: clip(outerHTML) };
  }

  const { root } = await send(tabId, 'DOM.getDocument', { depth });
  const { outerHTML } = await send(tabId, 'DOM.getOuterHTML', { nodeId: root.nodeId });
  return { url: root.documentURL, html: clip(outerHTML) };
}

/**
 * Computed styles — the "Computed" tab. Returns only non-default properties by
 * default, because the full list is ~340 entries of mostly noise.
 */
export async function styles(tabId, { ref, selector, properties, all = false, url } = {}) {
  const backendNodeId = await nodeIdFor(tabId, { ref, selector, url });
  // Resolve once — pushNodesByBackendIdsToFrontend is not free, and calling it
  // twice in parallel can return different nodeIds for the same node.
  const nodeId = await toNodeId(tabId, backendNodeId);
  const [{ computedStyle }, matched] = await Promise.all([
    send(tabId, 'CSS.getComputedStyleForNode', { nodeId }),
    send(tabId, 'CSS.getMatchedStylesForNode', { nodeId }).catch(() => null),
  ]);

  const computed = {};
  for (const { name, value } of computedStyle) {
    if (properties && !properties.includes(name)) continue;
    if (!properties && !all && isDefaultish(name, value)) continue;
    computed[name] = value;
  }

  const authored = (matched?.matchedCSSRules ?? [])
    .filter((r) => r.rule?.origin === 'regular')
    .map((r) => ({
      selector: r.rule.selectorList?.text,
      source: r.rule.styleSheetId,
      declarations: (r.rule.style?.cssProperties ?? [])
        .filter((p) => p.value != null && !p.disabled)
        .map((p) => `${p.name}: ${p.value}`),
    }))
    .slice(0, 20);

  return { computed, authoredRules: authored, inline: matched?.inlineStyle?.cssText ?? null };
}

/** Box model — position, size, margin/border/padding, the Layout pane. */
export async function box(tabId, { ref, selector, url } = {}) {
  const backendNodeId = await nodeIdFor(tabId, { ref, selector, url });
  const { model } = await send(tabId, 'DOM.getBoxModel', { backendNodeId });
  const rect = await callOnNode(
    tabId,
    backendNodeId,
    `function () {
       const r = this.getBoundingClientRect();
       const s = getComputedStyle(this);
       return {
         rect: { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left },
         visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0',
         inViewport: r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0,
         zIndex: s.zIndex, position: s.position, overflow: s.overflow,
       };
     }`,
  );
  return { ...rect, boxModel: { width: model?.width, height: model?.height } };
}

/** Application > Storage: localStorage, sessionStorage, IndexedDB names. */
export async function storage(tabId, { kind = 'all' } = {}) {
  const out = {};

  if (kind === 'all' || kind === 'local' || kind === 'session') {
    const web = await evaluate(
      tabId,
      `(() => {
         const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return o; };
         try { return { local: dump(localStorage), session: dump(sessionStorage) }; }
         catch (e) { return { error: String(e) }; }
       })()`,
    );
    if (kind === 'all') Object.assign(out, web);
    else out[kind] = web?.[kind];
  }

  if (kind === 'all' || kind === 'indexeddb') {
    out.indexedDB = await evaluate(
      tabId,
      `(async () => {
         try {
           if (!indexedDB.databases) return 'indexedDB.databases() unsupported';
           const dbs = await indexedDB.databases();
           return dbs.map(d => ({ name: d.name, version: d.version }));
         } catch (e) { return String(e); }
       })()`,
    );
  }

  if (kind === 'all' || kind === 'cache') {
    out.cacheStorage = await evaluate(
      tabId,
      `(async () => { try { return await caches.keys(); } catch (e) { return String(e); } })()`,
    );
  }

  if (kind === 'all' || kind === 'serviceworker') {
    out.serviceWorkers = await evaluate(
      tabId,
      `(async () => {
         try {
           if (!navigator.serviceWorker) return [];
           const regs = await navigator.serviceWorker.getRegistrations();
           return regs.map(r => ({ scope: r.scope, active: !!r.active, state: r.active?.state }));
         } catch (e) { return String(e); }
       })()`,
    );
  }

  return out;
}

/** Application > Cookies. Uses chrome.cookies, which sees HttpOnly cookies. */
export async function cookies(tabId, { url } = {}) {
  const tab = await api.tabs.get(tabId);
  const target = url ?? tab.url;
  const list = await api.cookies.getAll({ url: target });
  return {
    url: target,
    count: list.length,
    cookies: list.map((c) => ({
      name: c.name,
      value: c.value.length > 80 ? `${c.value.slice(0, 77)}…` : c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      session: c.session,
      expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : null,
    })),
  };
}

/** Application > Frames: the frame tree, useful for iframe-heavy apps. */
export async function frames(tabId) {
  const { frameTree } = await send(tabId, 'Page.getFrameTree');
  const flatten = (node, depth = 0) => [
    {
      depth,
      frameId: node.frame.id,
      url: node.frame.url,
      name: node.frame.name ?? '',
      securityOrigin: node.frame.securityOrigin,
    },
    ...(node.childFrames ?? []).flatMap((c) => flatten(c, depth + 1)),
  ];
  return { frames: flatten(frameTree) };
}

/** Resolve ref|selector to a backendNodeId. */
async function nodeIdFor(tabId, { ref, selector, url }) {
  if (ref) return (await resolveRef(tabId, ref, url)).backendNodeId;
  if (!selector) throw new Error('Provide either a ref (from browser_snapshot) or a CSS selector.');
  const { root } = await send(tabId, 'DOM.getDocument', { depth: 0 });
  const { nodeId } = await send(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`No element matches selector ${JSON.stringify(selector)}.`);
  const { node } = await send(tabId, 'DOM.describeNode', { nodeId });
  return node.backendNodeId;
}

/** CSS.* commands want a nodeId, not a backendNodeId. */
async function toNodeId(tabId, backendNodeId) {
  const { nodeIds } = await send(tabId, 'DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] });
  return nodeIds[0];
}

/** Filter out the ~250 properties that are just CSS initial values. */
const DEFAULTS = new Set([
  'auto', 'none', 'normal', '0px', '0s', 'visible', 'static', 'baseline',
  'rgba(0, 0, 0, 0)', 'repeat', 'start', 'ltr', 'medium', 'stretch', 'nowrap',
]);

function isDefaultish(name, value) {
  if (DEFAULTS.has(value)) return true;
  if (/^0(px|%|s|deg)?$/.test(value)) return true;
  if (name.startsWith('-webkit-') || name.startsWith('-internal-')) return true;
  return false;
}

function clip(html, max = 60_000) {
  if (!html) return '';
  return html.length > max ? `${html.slice(0, max)}\n… [truncated ${html.length - max} chars]` : html;
}
