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

import { platform } from '../lib/platform.js';
import { send } from '../lib/cdp.js';
import { resolveRef, sessionForNode } from '../lib/refs.js';
import { inWorld, callInWorld } from '../lib/world.js';
import * as frameSessions from '../lib/frames.js';

/**
 * Every read below that runs JavaScript in the page runs it in G9's isolated
 * world (lib/world.js), never the page's main world: it shares the DOM and the
 * origin's storage, but not the page's globals — so nothing G9 does is visible
 * to the page, and a page that overrides a prototype cannot lie to the read.
 */

/** Outer HTML of an element (or the whole document when no ref is given). */
export async function dom(tabId, { ref, selector, depth = 3, url } = {}) {
  if (ref) {
    const node = await resolveRef(tabId, ref, url);
    // A node inside a cross-origin frame lives in that frame's session; the
    // page session answers "does not belong to the document" for it.
    const { outerHTML } = await send(tabId, 'DOM.getOuterHTML', { backendNodeId: node.backendNodeId },
      { sessionId: node.sessionId ?? null });
    return { ref, role: node.role, name: node.name, html: clip(outerHTML) };
  }

  if (selector) {
    const { root } = await send(tabId, 'DOM.getDocument', { depth: 0 });
    const { nodeId } = await send(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`No element matches selector ${JSON.stringify(selector)}.`);
    const { outerHTML } = await send(tabId, 'DOM.getOuterHTML', { nodeId });
    return { selector, html: clip(outerHTML) };
  }

  return outline(tabId, depth);
}

/**
 * Depth-limited structural view of the whole document.
 *
 * `depth` used to be passed to `DOM.getDocument`, which only controls how much
 * of the node tree CDP puts in its *response* — `DOM.getOuterHTML` then
 * serialised the entire document regardless. So `depth: 1` returned the same
 * 15KB as `depth: 10`: a parameter that read as working and did nothing.
 *
 * Depth is now real, and applied where it has to be — in the page. The result
 * is still HTML, so it stays recognisable, but subtrees past the limit collapse
 * to a comment saying how many children were elided. For an agent orienting on
 * an unfamiliar page that is the useful answer; the full markup of one element
 * is a `ref` or `selector` away.
 */
async function outline(tabId, depth) {
  const html = await inWorld(
    tabId,
    `(() => {
       const MAX = ${Math.max(0, Math.min(Number(depth) || 0, 30))};
       const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
       const attrs = (el) => [...el.attributes]
         .slice(0, 6)
         .map((a) => ' ' + a.name + '="' + esc(a.value).slice(0, 60) + '"')
         .join('');
       const text = (el, n) => esc((el.textContent || '').trim().replace(/[ ]+/g, ' ')).slice(0, n);
       const walk = (el, d) => {
         const tag = el.tagName.toLowerCase();
         const open = '<' + tag + attrs(el) + '>';
         const close = '</' + tag + '>';
         const kids = [...el.children];
         if (!kids.length) return open + text(el, 120) + close;
         if (d >= MAX) return open + '<!-- ' + kids.length + ' child elements elided at depth ' + MAX + ' -->' + close;
         return open + kids.map((k) => walk(k, d + 1)).join('') + close;
       };
       return walk(document.documentElement, 0);
     })()`,
  );
  return {
    url: await inWorld(tabId, 'location.href').catch(() => null),
    depth,
    note: 'Structure only, truncated at `depth`. Pass a ref or selector for an element\'s full markup.',
    html: clip(html),
  };
}

/**
 * Computed styles — the "Computed" tab. Returns only non-default properties by
 * default, because the full list is ~340 entries of mostly noise.
 */
export async function styles(tabId, { ref, selector, properties, all = false, url } = {}) {
  const backendNodeId = await nodeIdFor(tabId, { ref, selector, url });
  const opts = { sessionId: await sessionForNode(tabId, backendNodeId) };
  if (opts.sessionId) {
    // attach() enables DOM and CSS on the page session only; a frame's own
    // session needs them before it will hand out node ids and styles.
    await send(tabId, 'DOM.enable', {}, opts).catch(() => {});
    await send(tabId, 'CSS.enable', {}, opts).catch(() => {});
  }
  // Resolve once — pushNodesByBackendIdsToFrontend is not free, and calling it
  // twice in parallel can return different nodeIds for the same node.
  const nodeId = await toNodeId(tabId, backendNodeId, opts);
  const [{ computedStyle }, matched] = await Promise.all([
    send(tabId, 'CSS.getComputedStyleForNode', { nodeId }, opts),
    send(tabId, 'CSS.getMatchedStylesForNode', { nodeId }, opts).catch(() => null),
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
      // CDP returns every longhand a shorthand expands into, alongside the
      // shorthand the author actually wrote. Reporting all of them turned a
      // 7-declaration rule into 60 lines, most of them empty
      // ("border-top-color: ") because the value lives in the shorthand. Only
      // authored declarations carry a `range` — their span in the stylesheet
      // text — so that is the honest filter for "what does the CSS say".
      declarations: (r.rule.style?.cssProperties ?? [])
        .filter((p) => p.range && !p.disabled && p.value)
        .map((p) => `${p.name}: ${p.value}`),
    }))
    .slice(0, 20);

  return { computed, authoredRules: authored, inline: matched?.inlineStyle?.cssText ?? null };
}

/** Box model — position, size, margin/border/padding, the Layout pane. */
export async function box(tabId, { ref, selector, url } = {}) {
  const backendNodeId = await nodeIdFor(tabId, { ref, selector, url });
  // Both reads go to the session that owns the node (a cross-origin frame's
  // own, when it lives in one) — the box model as much as the page-side read.
  const sessionId = await sessionForNode(tabId, backendNodeId);
  const { model } = await send(tabId, 'DOM.getBoxModel', { backendNodeId }, { sessionId });
  const rect = await callInWorld(
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
    [],
    sessionId,
  );
  return { ...rect, boxModel: { width: model?.width, height: model?.height } };
}

/** Application > Storage: localStorage, sessionStorage, IndexedDB names. */
export async function storage(tabId, { kind = 'all' } = {}) {
  const out = {};

  if (kind === 'all' || kind === 'local' || kind === 'session') {
    // Bounded, because Web Storage is not. Sites routinely park serialised
    // application state, cached API responses, and whole i18n bundles in
    // localStorage; an unbounded dump is megabytes into the agent's context in
    // the best case, and over the transport's 64MB frame limit in the worst.
    // Values are truncated individually so every KEY is still visible — knowing
    // what is stored is most of the question, and one value can be read in full
    // with browser_console action:"evaluate".
    const web = await inWorld(
      tabId,
      `(() => {
         const MAX_VALUE = 2000;
         const MAX_TOTAL = 256 * 1024;
         const dump = (s) => {
           const out = {};
           let total = 0;
           let truncatedKeys = 0;
           let omittedKeys = 0;
           for (let i = 0; i < s.length; i++) {
             const k = s.key(i);
             const v = s.getItem(k) ?? '';
             if (total >= MAX_TOTAL) { omittedKeys++; continue; }
             if (v.length > MAX_VALUE) {
               out[k] = v.slice(0, MAX_VALUE) + '… [truncated ' + (v.length - MAX_VALUE) + ' chars]';
               truncatedKeys++;
             } else {
               out[k] = v;
             }
             total += Math.min(v.length, MAX_VALUE);
           }
           if (truncatedKeys || omittedKeys) {
             out['__g9note'] = truncatedKeys + ' value(s) truncated, ' + omittedKeys +
               ' key(s) omitted past the 256KB budget. Read one in full with browser_console action:"evaluate".';
           }
           return out;
         };
         try { return { local: dump(localStorage), session: dump(sessionStorage) }; }
         catch (e) { return { error: String(e) }; }
       })()`,
    );
    if (kind === 'all') Object.assign(out, web);
    else out[kind] = web?.[kind];
  }

  if (kind === 'all' || kind === 'indexeddb') {
    out.indexedDB = await inWorld(
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
    out.cacheStorage = await inWorld(
      tabId,
      `(async () => { try { return await caches.keys(); } catch (e) { return String(e); } })()`,
    );
  }

  if (kind === 'all' || kind === 'serviceworker') {
    out.serviceWorkers = await inWorld(
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

/** Never hand back an unbounded cookie jar; ad-heavy sites carry 40+. */
const MAX_COOKIES = 40;

/**
 * Application > Cookies, HttpOnly included (`platform.cookies`: chrome.cookies
 * in the extension, Storage.getCookies on a launched engine).
 *
 * Any domain: v1 limited the `url` override to the attached tab's origin as
 * part of the mode boundary, and v2 has no modes (D6/D7). Without `url` the
 * answer is the cookies the tab's own URL would send.
 */
export async function cookies(tabId, { url, limit = MAX_COOKIES } = {}) {
  const tab = await platform.tabs.get(tabId);
  const target = url || tab.url;

  const list = await platform.cookies.getAll({ url: target, tabId });
  const shown = list.slice(0, limit);
  return {
    url: target,
    count: list.length,
    ...(list.length > shown.length ? { truncated: list.length - shown.length } : {}),
    // The VALUE whole. "Full access" (D6/D7) includes it, and real session cookies are JWTs of
    // hundreds of characters: a value cut to 77 characters + "…" was a token an agent could not
    // use and might not notice was cut (isolated live test: 929 characters set, 78 returned). A
    // browser caps one cookie at 4096 bytes, and the jar at MAX_COOKIES, so the answer stays bounded.
    cookies: shown.map((c) => ({
      name: c.name,
      value: c.value,
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

/**
 * Application > Frames: the frame tree, useful for iframe-heavy apps.
 *
 * Cross-origin frames included. With site isolation a cross-origin iframe runs
 * in another renderer and is a CDP target of its own: the page session's
 * Page.getFrameTree does not contain it, so this used to list the top document
 * alone on a page whose whole point was an embedded third-party frame (Engine 2
 * live test). Each attached child session (lib/frames.js) adds its own tree,
 * under the frame that holds it (its root frame's parentId), marked
 * `crossProcess: true`.
 */
export async function frames(tabId) {
  const { frameTree } = await send(tabId, 'Page.getFrameTree');
  const flatten = (node, depth = 0, extra = {}) => [
    {
      depth,
      frameId: node.frame.id,
      url: node.frame.url,
      name: node.frame.name ?? '',
      securityOrigin: node.frame.securityOrigin,
      ...extra,
    },
    ...(node.childFrames ?? []).flatMap((c) => flatten(c, depth + 1, extra)),
  ];
  const out = flatten(frameTree);
  const children = await frameSessions.list(tabId).catch(() => []);
  // A child may hold further children; a few passes place each under its parent once that is known.
  let pending = [...children];
  for (let pass = 0; pass < 4 && pending.length; pass++) {
    const next = [];
    for (const child of pending) {
      const tree = (await send(tabId, 'Page.getFrameTree', {}, { sessionId: child.sessionId }).catch(() => null))?.frameTree;
      if (!tree || out.some((f) => f.frameId === tree.frame.id)) continue;
      const at = out.findIndex((f) => f.frameId === tree.frame.parentId);
      if (at < 0 && pass < 3) { next.push(child); continue; }
      const depth = at >= 0 ? out[at].depth + 1 : 1;
      const rows = flatten(tree, depth, { crossProcess: true });
      // Right after the parent's own subtree, so the list reads as a tree.
      let insert = at < 0 ? out.length : at + 1;
      while (insert < out.length && out[insert].depth > out[at].depth) insert += 1;
      out.splice(insert, 0, ...rows);
    }
    pending = next;
  }
  return { frames: out };
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
async function toNodeId(tabId, backendNodeId, opts = {}) {
  const { nodeIds } = await send(tabId, 'DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] }, opts);
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
