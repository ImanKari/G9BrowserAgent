/**
 * (3.5) What a browser_interact call acts on, without a snapshot first.
 *
 * A ref from browser_snapshot is still the way to name an element. But a click on "the Share
 * button" cost a full snapshot of a large page and a search through it, every time (field report);
 * and a page that renders the control a moment later answered "No element matches". So an
 * interaction may name its target by:
 *
 * - `role` (+ `name`, a case-insensitive regex, + `nth` when several match) — the accessibility
 *   tree, as browser_inspect what:"find" reads it;
 * - `selector` — a CSS selector in the top document (only visible matches count; `nth` picks one);
 * - `ref`, as before.
 *
 * `waitMs` waits for the target to appear (and, in interact, for a covered or moving target to be
 * clickable). Several matches without `nth` are refused with the list, never guessed: guessing the
 * first is how a step clicks the wrong "Delete". The element gets a ref in the page's table
 * (lib/refs.js adoptNodes), so the result names it and later calls can use it.
 */

import { send } from '../lib/cdp.js';
import { callInWorld } from '../lib/world.js';
import { adoptNodes, ownerOf } from '../lib/refs.js';
import { find } from './snapshot.js';

export const MAX_WAIT_MS = 60_000;
const POLL_MS = 250;
const SELECTOR_MAX = 40;

/** Does this call name its target some other way than a ref? */
export function wantsLookup(args = {}) {
  return !args.ref && (args.role != null || args.name != null || (args.selector != null && args.action !== 'upload'));
}

function label(args) {
  if (args.selector != null) return `selector ${JSON.stringify(String(args.selector))}`;
  return `${args.role != null ? `role ${JSON.stringify(String(args.role))}` : 'any role'}${args.name != null ? ` name /${args.name}/i` : ''}`;
}

/** One look: → { refs:[…], lines:[…] } (lines for messages). */
async function lookOnce(tabId, args, caller, url) {
  if (args.selector != null) return bySelector(tabId, String(args.selector), caller, url);
  const found = await find(tabId, { roles: args.role != null ? [String(args.role)] : null, name: args.name ?? null, limit: 30, url }, caller);
  const lines = found.tree === '(no match)' ? [] : found.tree.split('\n');
  const refs = lines.map((l) => /\[ref=(e\d+)\]/.exec(l)?.[1]).filter(Boolean);
  return { refs, lines };
}

const VISIBLE_FN = `function () {
    const r = this.getBoundingClientRect();
    const s = this.ownerDocument.defaultView.getComputedStyle(this);
    const name = (this.getAttribute('aria-label') || this.getAttribute('title') || this.innerText || this.value || this.getAttribute('placeholder') || '').toString().replace(/\\s+/g, ' ').trim().slice(0, 80);
    return { visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none', tag: this.tagName.toLowerCase(), name };
  }`;

async function bySelector(tabId, selector, caller, url) {
  const doc = await send(tabId, 'DOM.getDocument', { depth: 0 });
  let nodeIds;
  try {
    ({ nodeIds } = await send(tabId, 'DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector }));
  } catch (err) {
    throw new Error(`${JSON.stringify(selector)} is not a valid CSS selector: ${err.message}`);
  }
  const nodes = [];
  for (const nodeId of (nodeIds ?? []).slice(0, SELECTOR_MAX)) {
    const described = await send(tabId, 'DOM.describeNode', { nodeId }).catch(() => null);
    const backendNodeId = described?.node?.backendNodeId;
    if (backendNodeId == null) continue;
    const facts = await callInWorld(tabId, backendNodeId, VISIBLE_FN).catch(() => null);
    if (!facts?.visible) continue;
    nodes.push({ backendNodeId, role: facts.tag, name: facts.name, sessionId: null });
  }
  if (!nodes.length) return { refs: [], lines: [] };
  const refs = await adoptNodes(tabId, url, nodes, ownerOf(caller));
  return { refs, lines: nodes.map((n, i) => `- ${n.role}${n.name ? ` "${n.name}"` : ''} [ref=${refs[i]}]`) };
}

/**
 * Resolve the call's target to ONE ref, waiting up to `waitMs` for it to appear.
 * → { ref, matched: <how>, waitedMs }
 */
export async function lookupRef(tabId, args, caller, { url = null, signal = null } = {}) {
  const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, Number(args.waitMs) || 0));
  const started = Date.now();
  let last = { refs: [], lines: [] };
  for (;;) {
    last = await lookOnce(tabId, args, caller, url);
    if (last.refs.length && (args.nth != null || last.refs.length === 1)) break;
    if (last.refs.length > 1) break; // ambiguity does not improve by waiting
    if (Date.now() - started >= waitMs || signal?.aborted) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const what = label(args);
  if (!last.refs.length) {
    const err = new Error(`No element with ${what} on the page${waitMs ? ` after waiting ${Math.round((Date.now() - started) / 100) / 10} s` : ''}; nothing was sent. ` +
      'Check the name with browser_inspect what:"find", or pass waitMs if it appears later.');
    err.delivery = 'not-delivered';
    err.lookedFor = { role: args.role ?? null, name: args.name ?? null, selector: args.selector ?? null };
    throw err;
  }
  if (args.nth != null) {
    const n = Number(args.nth);
    if (!(Number.isInteger(n) && n >= 1 && n <= last.refs.length)) {
      throw new Error(`${what} matched ${last.refs.length}; nth ${args.nth} is out of range (1..${last.refs.length}). Nothing was sent.`);
    }
    return { ref: last.refs[n - 1], matched: `${what}, #${n} of ${last.refs.length}`, waitedMs: Date.now() - started };
  }
  if (last.refs.length > 1) {
    const err = new Error(`${what} matched ${last.refs.length} elements: ${last.lines.slice(0, 8).join(' | ')}. Pass nth (1-based) or a stricter name. Nothing was sent.`);
    err.delivery = 'not-delivered';
    throw err;
  }
  return { ref: last.refs[0], matched: what, waitedMs: Date.now() - started };
}
