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
import { saveRefs } from '../lib/refs.js';

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

export async function snapshot(tabId, { mode = 'a11y', maxNodes = 900, includeText = true } = {}) {
  await ensureDomain(tabId, 'Accessibility');
  await ensureDomain(tabId, 'DOM');

  const [{ nodes }, docInfo] = await Promise.all([
    send(tabId, 'Accessibility.getFullAXTree', { depth: -1 }),
    send(tabId, 'DOM.getDocument', { depth: 0 }),
  ]);

  const url = docInfo?.root?.documentURL ?? '';
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));

  const entries = [];
  const lines = [];
  let emitted = 0;
  let refCounter = 0;
  let truncated = false;

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
          ref = `e${++refCounter}`;
          entries.push([ref, { backendNodeId, role, name }]);
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

  const generation = await saveRefs(tabId, { url, entries });

  const result = {
    url,
    title: docInfo?.root?.title ?? '',
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
 */
async function extractText(tabId) {
  const { result } = await send(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
          const s = getComputedStyle(p);
          if (s.display === 'none' || s.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          return n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      const out = []; let n;
      while ((n = walker.nextNode()) && out.length < 4000) out.push(n.textContent.trim());
      return out.join(' ').replace(/\\s+/g, ' ').slice(0, 24000);
    })()`,
    returnByValue: true,
  });
  return result?.value ?? '';
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
