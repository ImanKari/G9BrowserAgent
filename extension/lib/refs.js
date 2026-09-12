/**
 * Element reference registry.
 *
 * Agents are bad at CSS selectors and good at short symbolic handles. Every
 * snapshot hands back refs like `e12`; every interaction tool accepts them.
 * A ref maps to a CDP backendNodeId, which is stable for the lifetime of the
 * document but invalid after a navigation — so refs are versioned per snapshot
 * and a stale ref produces an actionable error rather than a wrong click.
 */

const api = globalThis.browser ?? globalThis.chrome;

const KEY = (tabId) => `refs:${tabId}`;

export async function saveRefs(tabId, { url, entries }) {
  const generation = Date.now();
  const map = {};
  for (const [ref, node] of entries) map[ref] = node;
  await api.storage.session.set({
    [KEY(tabId)]: { generation, url, map },
  });
  return generation;
}

export async function getRefs(tabId) {
  const stored = await api.storage.session.get(KEY(tabId));
  return stored[KEY(tabId)] ?? null;
}

/**
 * Which CDP session owns this node?
 *
 * Cross-origin frames run in their own process, so a command about one of their
 * nodes has to carry that frame's `sessionId` or it arrives at an agent that
 * has never heard of the node ("Node with given id does not belong to the
 * document").
 *
 * **Looked up here rather than threaded through every caller.** The first
 * attempt passed the session down from `resolveRef` by hand, and interact.js
 * alone has a dozen places that act on a node — click, hover, type, drag,
 * select, upload, focus checks, verification reads. Two were patched, ten were
 * not, and the symptom was that reading inside a frame worked while clicking
 * did not. A rule that every new call site must remember is a rule that will be
 * broken; asking the table is a rule that cannot be.
 *
 * Returns null for the main document, which is exactly what the CDP helpers
 * want when no session routing is needed.
 */
export async function sessionForNode(tabId, backendNodeId) {
  try {
    const table = await getRefs(tabId);
    if (table) {
      for (const node of Object.values(table.map)) {
        if (node?.backendNodeId === backendNodeId) return node.sessionId ?? null;
      }
    }
  } catch {
    // A missing table is the main document, not an error.
  }
  return null;
}

/**
 * Resolve a ref to a backendNodeId, or throw an error that tells the agent
 * exactly how to recover (which is always: take a fresh snapshot).
 */
export async function resolveRef(tabId, ref, currentUrl) {
  const table = await getRefs(tabId);
  if (!table) {
    throw new Error(
      `No snapshot exists for this tab yet. Call browser_snapshot first, then use the refs it returns.`,
    );
  }
  const node = table.map[ref];
  if (!node) {
    const available = Object.keys(table.map).slice(0, 12).join(', ');
    throw new Error(
      `Unknown element ref "${ref}". Refs come from browser_snapshot. ` +
        `Known refs include: ${available}${Object.keys(table.map).length > 12 ? ', …' : ''}. ` +
        `If the page changed, take a fresh snapshot.`,
    );
  }
  if (currentUrl && table.url && stripHash(table.url) !== stripHash(currentUrl)) {
    throw new Error(
      `Stale snapshot: refs were captured on ${table.url} but the tab is now on ${currentUrl}. ` +
        `Take a fresh browser_snapshot before interacting.`,
    );
  }
  return node;
}

export async function clearRefs(tabId) {
  await api.storage.session.remove(KEY(tabId));
}

function stripHash(u) {
  try {
    const parsed = new URL(u);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return u;
  }
}
