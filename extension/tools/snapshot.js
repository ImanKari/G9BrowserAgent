/**
 * Page perception.
 *
 * Strategy, in order of preference:
 *   1. Accessibility tree — roles, names, values, states. Cheap, semantic, and
 *      the same signal a screen reader uses, so it matches how the page is
 *      *meant* to be operated.
 *   2. Screenshot — only when the tree is insufficient (canvas, custom widgets
 *      with no ARIA, visual-layout questions).
 *
 * The tree is pruned hard: an unpruned AX tree of a real app is tens of
 * thousands of nodes and would bury the agent. We keep interactive nodes,
 * landmarks, headings, and named content, and collapse the rest.
 */

import { send, ensureDomain } from '../lib/cdp.js';
import { saveRefs, refNumbering, ownerOf } from '../lib/refs.js';
import * as frames from '../lib/frames.js';
import { inWorld } from '../lib/world.js';

/** Roles that are always worth showing — the agent can act on these. */
const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
  'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'gridcell',
  'columnheader', 'rowheader', 'progressbar', 'scrollbar',
]);

/** Roles that give the agent structural bearings. */
const STRUCTURAL = new Set([
  'heading', 'navigation', 'main', 'banner', 'contentinfo', 'complementary',
  'form', 'search', 'dialog', 'alertdialog', 'alert', 'status', 'tablist',
  'table', 'grid', 'list', 'article', 'region', 'tabpanel', 'menu', 'menubar',
  'toolbar', 'tooltip', 'group',
]);

/** Never useful on their own. */
const NOISE = new Set(['none', 'presentation', 'generic', 'InlineTextBox', 'StaticText', 'LineBreak']);

/** An accessibility tree with nothing in it but its root: not built yet, or a truly empty page. */
const looksUnbuilt = (nodes) => (nodes ?? []).filter((n) => n.ignored !== true).length <= 1;

/**
 * `caller` decides which agent's four kept generations this snapshot joins (lib/refs.js): another
 * agent reading the same tab must never age this one's refs out. G9BrowserAgent's own internal snapshots (qa,
 * replay) pass none and share the null owner.
 */
export async function snapshot(tabId, { mode = 'a11y', maxNodes = 900, includeText = true } = {}, caller = null) {
  await ensureDomain(tabId, 'Accessibility');
  await ensureDomain(tabId, 'DOM');

  let [{ nodes }, docInfo] = await Promise.all([
    send(tabId, 'Accessibility.getFullAXTree', { depth: -1 }),
    send(tabId, 'DOM.getDocument', { depth: 0 }),
  ]);

  // A tree with only its root while the document HAS a body with elements is one the renderer has
  // not built (again) yet — right after a tab moved into a window of its own (popout), Chrome for
  // Testing's first snapshot had no page in it, and the click that followed had no ref (live round
  // 3, 1/11 CfT popouts). Asked again, briefly; a page that really is empty costs one DOM read.
  for (let attempt = 0; attempt < 4 && looksUnbuilt(nodes); attempt++) {
    const elements = await inWorld(tabId, 'document.body ? document.body.childElementCount : 0', { timeoutMs: 3000 }).catch(() => 0);
    if (!(elements > 0)) break;
    await new Promise((r) => setTimeout(r, 250));
    ({ nodes } = await send(tabId, 'Accessibility.getFullAXTree', { depth: -1 }));
  }

  const url = docInfo?.root?.documentURL ?? '';
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));

  const entries = [];
  const lines = [];
  let emitted = 0;
  // Refs continue the page's numbering (lib/refs.js): an earlier snapshot's e2 — this agent's or
  // another's — keeps naming the element IT showed, never whatever is second now.
  const numbering = await refNumbering(tabId, url);
  let truncated = false;
  // Set while walking a child frame, so each ref remembers where it can be used.
  let activeSession = null;

  const root = nodes.find((n) => !n.parentId) ?? nodes[0];

  const walk = (node, depth) => {
    if (!node || emitted >= maxNodes) {
      if (emitted >= maxNodes) truncated = true;
      return;
    }

    const role = node.role?.value ?? '';
    const name = (node.name?.value ?? '').trim();
    const ignored = node.ignored === true;

    let emittedDepth = depth;

    if (!ignored && !NOISE.has(role)) {
      const isInteractive = INTERACTIVE.has(role);
      const isStructural = STRUCTURAL.has(role);
      // Keep anything actionable; keep structure only when it carries a name
      // (an unnamed <div role=group> tells the agent nothing).
      const keep = isInteractive || (isStructural && (name || role === 'heading')) || (includeText && name && depth < 4);

      if (keep) {
        if (emitted >= maxNodes) {
          truncated = true;
          return;
        }
        const props = describeProps(node);
        const backendNodeId = node.backendDOMNodeId;
        let ref = '';
        if (isInteractive && backendNodeId != null) {
          ref = numbering.next();
          // sessionId is null for the main document and set inside a cross-origin
          // frame, so resolveRef can route the click to the process that owns the node.
          entries.push([ref, { backendNodeId, role, name, sessionId: activeSession }]);
        }
        const indent = '  '.repeat(Math.min(depth, 12));
        const label = name ? ` "${truncate(name, 120)}"` : '';
        const refTag = ref ? ` [ref=${ref}]` : '';
        lines.push(`${indent}- ${role}${label}${refTag}${props}`);
        emitted += 1;
        emittedDepth = depth + 1;
      }
    }

    for (const childId of node.childIds ?? []) walk(byId.get(childId), emittedDepth);
  };

  walk(root, 0);

  // Cross-origin frames live in another process, so their nodes are simply not
  // in the tree above. Each attached child session is walked on its own and
  // appended under a header, with every ref remembering which session it came
  // from — that is what lets browser_interact click inside a payment iframe
  // instead of reporting that the button does not exist.
  const childFrames = await frames.list(tabId).catch(() => []);
  for (const frame of childFrames) {
    if (emitted >= maxNodes) { truncated = true; break; }
    try {
      // Each child session is its own agent with its own node map. Without
      // DOM.enable + DOM.getDocument on THAT session, a later DOM.resolveNode
      // for one of its backendNodeIds fails with "Node with given id does not
      // belong to the document" — the nodes are real, the agent just has never
      // been told about the document they live in. Reading worked without this
      // and clicking did not, which is a confusing way to find out.
      const opts = { sessionId: frame.sessionId };
      await send(tabId, 'DOM.enable', {}, opts).catch(() => {});
      await send(tabId, 'Accessibility.enable', {}, opts).catch(() => {});
      await send(tabId, 'DOM.getDocument', { depth: -1, pierce: true }, opts).catch(() => {});

      const child = await send(tabId, 'Accessibility.getFullAXTree', { depth: -1 }, opts);
      const childNodes = child?.nodes ?? [];
      if (!childNodes.length) continue;

      for (const n of childNodes) byId.set(n.nodeId, n);
      const childRoot = childNodes.find((n) => !n.parentId) ?? childNodes[0];

      lines.push(`  \u2514\u2500 [cross-origin frame] ${truncate(frame.url, 80)}`);
      activeSession = frame.sessionId;
      walk(childRoot, 1);
      activeSession = null;
    } catch {
      // A frame that navigated away mid-snapshot is not a failure of the
      // snapshot; the rest of the page is still worth returning.
      lines.push(`  \u2514\u2500 [cross-origin frame] ${truncate(frame.url, 80)} \u2014 gone before it could be read`);
    }
  }

  const generation = await saveRefs(tabId, { url, entries, by: ownerOf(caller) });

  const result = {
    url,
    // The document's title comes from the accessibility root, NOT from
    // `DOM.getDocument`. CDP's Node type has no `title` field, so
    // `docInfo.root.title` was always undefined and this key was always "" —
    // on every page, since v1.0.0. The RootWebArea's accessible name IS the
    // document title, and it is already in hand.
    title: (root?.name?.value ?? '').trim() || null,
    generation,
    interactiveCount: entries.length,
    emittedNodes: emitted,
    truncated,
    tree: lines.join('\n'),
  };

  if (mode === 'a11y+text') {
    result.text = await extractText(tabId);
  }

  return result;
}

/** Compact state annotations the agent needs to decide what to do next. */
function describeProps(node) {
  const out = [];
  const value = node.value?.value;
  if (value != null && String(value).length) out.push(`value=${JSON.stringify(truncate(String(value), 80))}`);

  for (const p of node.properties ?? []) {
    const v = p.value?.value;
    switch (p.name) {
      case 'checked':
      case 'selected':
      case 'expanded':
      case 'pressed':
        if (v !== false && v !== 'false') out.push(`${p.name}=${v}`);
        break;
      case 'disabled':
      case 'readonly':
      case 'required':
      case 'invalid':
        if (v === true || v === 'true') out.push(p.name);
        break;
      case 'level':
        out.push(`level=${v}`);
        break;
      case 'focused':
        if (v === true) out.push('focused');
        break;
      case 'url':
        if (v) out.push(`url=${truncate(String(v), 90)}`);
        break;
      default:
        break;
    }
  }
  return out.length ? ` (${out.join(', ')})` : '';
}

/**
 * Visible text, for content questions the AX tree answers poorly.
 *
 * NOTE THE DOUBLE BACKSLASHES. This function body is a template literal that
 * gets evaluated in the page, so every regex escape has to survive being parsed
 * twice. `\s` is not a valid JavaScript string escape, so a template literal
 * silently reduces it to a plain `s` — the page then ran `/s+/g` and replaced
 * every letter "s" with a space. "browser_interact" arrived as "brow er_interact"
 * and "/api/missing" as "/api/mi ing", from v1.0.0 until it was finally read in
 * v1.0.13. Self-test section 13 now scans for this.
 *
 * Runs in G9BrowserAgent's isolated world (lib/world.js): the same DOM and computed
 * styles, none of the page's globals — a page that overrides
 * `getComputedStyle` or `NodeFilter` cannot bend what G9BrowserAgent reads, and nothing
 * G9BrowserAgent runs here is visible to the page.
 */
async function extractText(tabId) {
  // A document with no <body> yet (still parsing) or none at all (a frameset,
  // an SVG or XML document) has less text, not an error: v1 returned '' there
  // because its exception was never read, and a snapshot must not fail on it
  // now that page exceptions are.
  const text = await inWorld(tabId, `(() => {
      const root = document.body || document.documentElement;
      if (!root) return '';
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (/^(SCRIPT|STYLE|NOSCRIPT|TITLE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
          const s = getComputedStyle(p);
          if (s.display === 'none' || s.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          return n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      const out = []; let n;
      while ((n = walker.nextNode()) && out.length < 4000) out.push(n.textContent.trim());
      return out.join(' ').replace(/\\s+/g, ' ').slice(0, 24000);
    })()`);
  return text ?? '';
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
