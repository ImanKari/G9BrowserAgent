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
import { getState } from '../lib/state.js';
import { originOf } from './tabs.js';

const api = globalThis.browser ?? globalThis.chrome;

function sameOrigin(a, b) {
  const oa = originOf(a);
  // originOf() reports unparseable and opaque origins in parentheses —
  // "(unknown)", "(about)", "(data)". None of those is an origin, and two
  // opaque origins are never the same one, so they can never satisfy this
  // check. Getting that wrong would widen the cookie boundary, not narrow it.
  return !oa.startsWith('(') && oa === originOf(b);
}

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
  const html = await evaluate(
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
    url: await evaluate(tabId, 'location.href').catch(() => null),
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
    // Bounded, because Web Storage is not. Sites routinely park serialised
    // application state, cached API responses, and whole i18n bundles in
    // localStorage; an unbounded dump is megabytes into the agent's context in
    // the best case, and over the transport's 64MB frame limit in the worst.
    // Values are truncated individually so every KEY is still visible — knowing
    // what is stored is most of the question, and one value can be read in full
    // with browser_console action:"evaluate".
    const web = await evaluate(
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

/** Never hand back an unbounded cookie jar; ad-heavy sites carry 40+. */
const MAX_COOKIES = 40;

/**
 * Application > Cookies. Uses chrome.cookies, which sees HttpOnly cookies.
 *
 * The `url` override is limited to the attached tab's origin outside multi
 * mode. `chrome.cookies` is not scoped to the debugger session — it reads every
 * domain in the profile — so an agent pinned to one tab could ask for
 * `https://mail.google.com` and be handed live session cookies for it. Pinned
 * mode promises the agent reaches exactly the tab the user consented to, and a
 * cookie read that crosses origins breaks that promise as completely as
 * attaching to the tab would. Same boundary as `browser_status`'s tab list
 * (v1.0.7) and `browser_tabs` (v1.0.7); this one was missed then.
 */
export async function cookies(tabId, { url, limit = MAX_COOKIES } = {}) {
  const tab = await api.tabs.get(tabId);
  let target = tab.url;

  if (url && url !== tab.url) {
    const { mode } = await getState();
    if (mode !== 'multi' && !sameOrigin(url, tab.url)) {
      throw new Error(
        `Reading cookies for ${originOf(url)} is not allowed: the mode is "${mode}", which limits ` +
          `you to ${originOf(tab.url)}. chrome.cookies can see every site the user is signed in to, ` +
          `so this boundary is the point. Ask the user to switch to "Multi-tab" mode if they want it.`,
      );
    }
    target = url;
  }

  const list = await api.cookies.getAll({ url: target });
  const shown = list.slice(0, limit);
  return {
    url: target,
    count: list.length,
    ...(list.length > shown.length ? { truncated: list.length - shown.length } : {}),
    cookies: shown.map((c) => ({
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
