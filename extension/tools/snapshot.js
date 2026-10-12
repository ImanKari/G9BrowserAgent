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

import { platform } from '../lib/platform.js';
import { send, ensureDomain } from '../lib/cdp.js';
import { saveRefs, refNumbering, ownerOf, knownRefs, nodeKey, resolveRef } from '../lib/refs.js';
import * as frames from '../lib/frames.js';
import { inWorld, callInWorld } from '../lib/world.js';

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
 *
 * (3.4) Token economy. A full tree of a busy app is thousands of lines, re-read after every step of
 * a long job. The options cut it to what the agent asks about:
 * - `scope`: a ref ("e12") or a CSS selector — only that element's subtree.
 * - `roles` (a list) and/or `name` (a regex, case-insensitive): only matching nodes, as flat lines;
 *   every match with a DOM node gets a ref (headings and text included, so they can scope or be read).
 *   (3.6) `matchCase:true` makes the regex case-sensitive ("Save" no longer matches "Save draft"'s
 *   lower-case cousin "save"); `exact:true` compares the whole name literally — no regex, so "(1)"
 *   or "?" in a name needs no escaping — case-insensitively unless matchCase.
 * - `interactiveOnly`: only the controls (flat).
 * - `includeText:false`: no named content beyond controls and named structure.
 * - `maxNodes`: the cap on emitted lines.
 * - `diff:true`: only what changed since THIS caller's previous snapshot of this page with the same
 *   options — `+` added, `~` changed (with what it was), `-` removed. Refs are stable per element
 *   (lib/refs.js knownRefs), so an unchanged element keeps the ref the agent already holds.
 */
export async function snapshot(tabId, opts = {}, caller = null) {
  const {
    mode = 'a11y', includeText = true, scope = null, roles = null, name: namePattern = null,
    interactiveOnly = false, diff = false, find = false, matchCase = false, exact = false,
  } = opts ?? {};
  const maxNodes = Math.max(1, Math.min(20_000, Number(opts?.maxNodes) || 900));
  const roleSet = normalizeRoles(roles);
  const nameRe = compileName(namePattern, { matchCase, exact });
  const filtered = !!(roleSet || nameRe || interactiveOnly || find);

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
  /** (3.4) key → line text without indentation, for the diff. */
  const seen = new Map();
  let emitted = 0;
  // Refs continue the page's numbering (lib/refs.js): an earlier snapshot's e2 — this agent's or
  // another's — keeps naming the element IT showed, never whatever is second now. (3.4) An element a
  // kept snapshot already named keeps that ref.
  const numbering = await refNumbering(tabId, url);
  const known = await knownRefs(tabId, url);
  const used = new Set();
  let truncated = false;
  // Set while walking a child frame, so each ref remembers where it can be used.
  let activeSession = null;

  const root = nodes.find((n) => !n.parentId) ?? nodes[0];

  const refFor = (backendNodeId) => {
    const key = nodeKey(activeSession, backendNodeId);
    let ref = known.get(key);
    if (!ref || used.has(ref)) ref = numbering.next();
    used.add(ref);
    return ref;
  };

  const walk = (node, depth) => {
    if (!node || emitted >= maxNodes) {
      if (emitted >= maxNodes) truncated = true;
      return;
    }

    const role = node.role?.value ?? '';
    const name = (node.name?.value ?? '').trim();
    const ignored = node.ignored === true;

    let emittedDepth = depth;

    if (!ignored && (!NOISE.has(role) || roleSet?.has(role.toLowerCase()))) {
      const isInteractive = INTERACTIVE.has(role);
      const isStructural = STRUCTURAL.has(role);
      // Keep anything actionable; keep structure only when it carries a name
      // (an unnamed <div role=group> tells the agent nothing).
      let keep;
      if (filtered) {
        keep = (!roleSet || roleSet.has(role.toLowerCase()))
          && (!interactiveOnly || isInteractive)
          && (!nameRe || nameRe.test(name))
          && (roleSet || isInteractive || isStructural || !!name);
      } else {
        keep = isInteractive || (isStructural && (name || role === 'heading')) || (includeText && name && depth < 4);
      }

      if (keep) {
        if (emitted >= maxNodes) {
          truncated = true;
          return;
        }
        const props = describeProps(node);
        const backendNodeId = node.backendDOMNodeId;
        let ref = '';
        if ((isInteractive || filtered) && backendNodeId != null) {
          ref = refFor(backendNodeId);
          // sessionId is null for the main document and set inside a cross-origin
          // frame, so resolveRef can route the click to the process that owns the node.
          entries.push([ref, { backendNodeId, role, name, sessionId: activeSession }]);
        }
        const label = name ? ` "${truncate(name, 120)}"` : '';
        const refTag = ref ? ` [ref=${ref}]` : '';
        const text = `- ${role}${label}${refTag}${props}`;
        // Filtered output is flat: the parents that gave the indentation are not shown.
        const indent = filtered ? '' : '  '.repeat(Math.min(depth, 12));
        lines.push(`${indent}${text}`);
        seen.set(backendNodeId != null ? nodeKey(activeSession, backendNodeId) : `ax:${node.nodeId}`, text);
        emitted += 1;
        emittedDepth = depth + 1;
      }
    }

    for (const childId of node.childIds ?? []) walk(byId.get(childId), emittedDepth);
  };

  // (3.4) scope: walk only the subtree of one element.
  let scopeInfo = null;
  if (scope) {
    scopeInfo = await resolveScope(tabId, scope, url, opts.url ?? null);
    if (scopeInfo.sessionId) {
      // Inside a cross-origin frame: that frame's own tree.
      const child = await send(tabId, 'Accessibility.getFullAXTree', { depth: -1 }, { sessionId: scopeInfo.sessionId });
      for (const n of child?.nodes ?? []) byId.set(n.nodeId, n);
      nodes = child?.nodes ?? [];
    }
    const roots = scopeRoots(nodes, byId, scopeInfo.backendNodeId, scopeInfo.descendants);
    if (!roots.length) {
      throw new Error(`The scope ${JSON.stringify(scope)} is not in the page's accessibility tree (hidden, or not rendered). Take a fresh browser_snapshot without scope.`);
    }
    activeSession = scopeInfo.sessionId ?? null;
    for (const r of roots) walk(r, 0);
    activeSession = null;
  } else {
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
        const frameOpts = { sessionId: frame.sessionId };
        await send(tabId, 'DOM.enable', {}, frameOpts).catch(() => {});
        await send(tabId, 'Accessibility.enable', {}, frameOpts).catch(() => {});
        await send(tabId, 'DOM.getDocument', { depth: -1, pierce: true }, frameOpts).catch(() => {});

        const child = await send(tabId, 'Accessibility.getFullAXTree', { depth: -1 }, frameOpts);
        const childNodes = child?.nodes ?? [];
        if (!childNodes.length) continue;

        for (const n of childNodes) byId.set(n.nodeId, n);
        const childRoot = childNodes.find((n) => !n.parentId) ?? childNodes[0];

        if (!filtered) lines.push(`  └─ [cross-origin frame] ${truncate(frame.url, 80)}`);
        activeSession = frame.sessionId;
        walk(childRoot, 1);
        activeSession = null;
      } catch {
        // A frame that navigated away mid-snapshot is not a failure of the
        // snapshot; the rest of the page is still worth returning.
        if (!filtered) lines.push(`  └─ [cross-origin frame] ${truncate(frame.url, 80)} — gone before it could be read`);
      }
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
    ...(scope ? { scope: String(scope) } : {}),
    ...(filtered ? { filter: compactFilter({ roles: roleSet ? [...roleSet] : null, name: namePattern, interactiveOnly, matchCase, exact }) } : {}),
    tree: lines.join('\n'),
  };

  // (3.4) The diff against this caller's previous snapshot of this page with the same options.
  const optsKey = JSON.stringify({ scope: scope ?? null, roles: roleSet ? [...roleSet].sort() : null, name: namePattern ?? null, interactiveOnly: !!interactiveOnly, includeText: !!includeText, maxNodes, find: !!find });
  // Kept only by diff:true snapshots (a plain snapshot costs no storage): the first diff:true of a
  // page returns the full tree and becomes the base of the next.
  const owner = ownerOf(caller);
  const previous = diff ? await loadDiffBase(tabId, owner) : null;
  if (diff) await saveDiffBase(tabId, owner, { url, optsKey, generation, lines: Object.fromEntries(seen) });
  if (diff) {
    if (!previous || stripHash(previous.url) !== stripHash(url) || previous.optsKey !== optsKey) {
      result.diff = {
        base: null,
        note: previous && previous.optsKey !== optsKey && stripHash(previous.url) === stripHash(url)
          ? 'Your previous snapshot of this page used other options (scope/filter/maxNodes), so this is the full tree; the next diff:true with these options is a diff.'
          : 'No previous snapshot of this page by you, so this is the full tree; the next diff:true is a diff against it.',
      };
    } else {
      const before = previous.lines ?? {};
      const added = [];
      const changed = [];
      const removed = [];
      for (const [key, text] of seen) {
        if (!(key in before)) added.push(`+ ${text}`);
        else if (before[key] !== text) changed.push(`~ ${text}   (was: ${before[key]})`);
      }
      for (const [key, text] of Object.entries(before)) if (!seen.has(key)) removed.push(`- ${text}`);
      result.diff = { base: previous.generation, added: added.length, changed: changed.length, removed: removed.length, unchanged: seen.size - added.length - changed.length };
      result.tree = [...added, ...changed, ...removed].join('\n') || '(no change)';
    }
  }

  if (mode === 'a11y+text') {
    result.text = scopeInfo && !scopeInfo.sessionId
      ? await scopedText(tabId, scopeInfo.backendNodeId)
      : await extractText(tabId);
  }

  return result;
}

/**
 * (3.4) `browser_inspect what:"find"`: role and/or name regex → the matching lines with refs, and
 * nothing else. The cheapest way to get the ref of "the Save button" on a page of thousands of nodes.
 */
export async function find(tabId, { roles = null, role = null, name = null, interactiveOnly = false, limit = 50, scope = null, url = null, matchCase = false, exact = false } = {}, caller = null) {
  const wanted = roles ?? (role ? [role] : null);
  if (!wanted && !name) throw new Error('what:"find" needs role (or roles) and/or name (a regular expression).');
  const snap = await snapshot(tabId, { roles: wanted, name, interactiveOnly, maxNodes: Math.max(1, Math.min(500, Number(limit) || 50)), find: true, scope, url, matchCase: matchCase === true, exact: exact === true }, caller);
  return {
    url: snap.url,
    count: snap.emittedNodes,
    truncated: snap.truncated,
    generation: snap.generation,
    tree: snap.tree || '(no match)',
  };
}

/** `roles` as a lower-case Set, or null for "any role". Accepts a list or a comma-separated string. */
function normalizeRoles(roles) {
  if (roles == null || roles === '') return null;
  const list = Array.isArray(roles) ? roles : String(roles).split(',');
  const set = new Set(list.map((r) => String(r).trim().toLowerCase()).filter(Boolean));
  return set.size ? set : null;
}

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * A name pattern as a matcher `{ test(name) }`: a case-insensitive RegExp by default; (3.6)
 * case-sensitive with `matchCase`; with `exact`, the whole name compared literally (whitespace
 * runs count as one space; case-insensitive unless `matchCase`). A bad regex is refused by name.
 */
export function compileName(pattern, { matchCase = false, exact = false } = {}) {
  if (pattern == null || pattern === '') return null;
  if (exact) {
    const want = matchCase ? squash(pattern) : squash(pattern).toLowerCase();
    return { test: (name) => (matchCase ? squash(name) : squash(name).toLowerCase()) === want };
  }
  try {
    return new RegExp(String(pattern), matchCase ? '' : 'i');
  } catch (err) {
    throw new Error(`name must be a regular expression (or pass exact:true to match it literally): ${err.message}`);
  }
}

/** How a name filter reads in a message: /x/i, /x/ (matchCase), or "x" (exact). Pure. */
export function nameLabel(pattern, { matchCase = false, exact = false } = {}) {
  if (exact) return `name "${squash(pattern)}"${matchCase ? ' (exact case)' : ' (exact)'}`;
  return `name /${pattern}/${matchCase ? '' : 'i'}`;
}

function compactFilter(f) {
  const out = {};
  if (f.roles) out.roles = f.roles;
  if (f.name) out.name = String(f.name);
  if (f.interactiveOnly) out.interactiveOnly = true;
  if (f.matchCase) out.matchCase = true;
  if (f.exact) out.exact = true;
  return out;
}

/**
 * The element a `scope` names: a ref from a snapshot, or a CSS selector in the top document.
 * → { backendNodeId, sessionId, descendants:Set|null }
 */
async function resolveScope(tabId, scope, url, currentUrl) {
  const text = String(scope).trim();
  if (/^e\d+$/.test(text)) {
    const node = await resolveRef(tabId, text, currentUrl ?? url);
    return { backendNodeId: node.backendNodeId, sessionId: node.sessionId ?? null, descendants: await descendantsOf(tabId, node.backendNodeId, node.sessionId ?? null) };
  }
  const doc = await send(tabId, 'DOM.getDocument', { depth: 0 });
  let found;
  try {
    found = await send(tabId, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: text });
  } catch (err) {
    throw new Error(`scope ${JSON.stringify(text)} is neither a ref ("e12") nor a valid CSS selector: ${err.message}`);
  }
  if (!found?.nodeId) throw new Error(`The scope selector ${JSON.stringify(text)} matched nothing on this page.`);
  const described = await send(tabId, 'DOM.describeNode', { nodeId: found.nodeId });
  const backendNodeId = described?.node?.backendNodeId;
  if (backendNodeId == null) throw new Error(`The scope selector ${JSON.stringify(text)} matched a node with no backend id.`);
  return { backendNodeId, sessionId: null, descendants: await descendantsOf(tabId, backendNodeId, null) };
}

/** Backend ids of an element and everything under it (open shadow roots included), or null. */
async function descendantsOf(tabId, backendNodeId, sessionId) {
  try {
    const { node } = await send(tabId, 'DOM.describeNode', { backendNodeId, depth: -1, pierce: true }, { sessionId });
    const ids = new Set();
    const visit = (n) => {
      if (!n) return;
      if (n.backendNodeId != null) ids.add(n.backendNodeId);
      for (const c of n.children ?? []) visit(c);
      for (const c of n.shadowRoots ?? []) visit(c);
      if (n.contentDocument) visit(n.contentDocument);
    };
    visit(node);
    return ids;
  } catch {
    return null;
  }
}

/**
 * The AX nodes to walk for a scope: the element's own AX node when it has one; else the topmost AX
 * nodes whose DOM node lies inside it (a plain <div> may have no AX node of its own).
 */
function scopeRoots(nodes, byId, backendNodeId, descendants) {
  const own = nodes.find((n) => n.backendDOMNodeId === backendNodeId);
  if (own) return [own];
  if (!descendants) return [];
  const inside = nodes.filter((n) => n.backendDOMNodeId != null && descendants.has(n.backendDOMNodeId));
  const insideIds = new Set(inside.map((n) => n.nodeId));
  return inside.filter((n) => !n.parentId || !insideIds.has(n.parentId) || !byId.has(n.parentId));
}

/** Visible text of one element (a scoped a11y+text). */
async function scopedText(tabId, backendNodeId) {
  const text = await callInWorld(tabId, backendNodeId, `function () {
      return String(this.innerText || this.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24000);
    }`).catch(() => '');
  return text ?? '';
}

// ------------------------------------------------------------------ diff base (3.4)

const DIFF_KEY = (tabId) => `snapdiff:${tabId}`;
/** Callers whose last snapshot of a tab is kept for a diff; the least recent goes first. */
const DIFF_OWNERS = 8;

async function loadDiffBase(tabId, owner) {
  try {
    const stored = await platform.storage.session.get(DIFF_KEY(tabId));
    return stored?.[DIFF_KEY(tabId)]?.[owner ?? ''] ?? null;
  } catch {
    return null;
  }
}

async function saveDiffBase(tabId, owner, base) {
  try {
    const stored = await platform.storage.session.get(DIFF_KEY(tabId));
    const all = { ...(stored?.[DIFF_KEY(tabId)] ?? {}) };
    delete all[owner ?? ''];
    all[owner ?? ''] = { ...base, at: Date.now() };
    const keys = Object.keys(all).sort((a, b) => (all[a].at ?? 0) - (all[b].at ?? 0));
    while (keys.length > DIFF_OWNERS) delete all[keys.shift()];
    await platform.storage.session.set({ [DIFF_KEY(tabId)]: all });
  } catch {
    /* a diff base that could not be kept only costs the next diff its base */
  }
}

/** Forget a tab's diff bases (navigation clears refs; a diff across documents means nothing). */
export async function clearDiffBases(tabId) {
  await platform.storage.session.remove(DIFF_KEY(tabId)).catch(() => {});
}

function stripHash(u) {
  return String(u ?? '').split('#')[0];
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
