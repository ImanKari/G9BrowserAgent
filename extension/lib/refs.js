/**
 * Element reference registry.
 *
 * Agents are bad at CSS selectors and good at short symbolic handles. Every
 * snapshot hands back refs like `e12`; every interaction tool accepts them.
 * A ref maps to a CDP backendNodeId, which is stable for the lifetime of the
 * document but invalid after a navigation.
 *
 * ## A ref names ONE element, for good (EXT-03)
 *
 * Refs used to be renumbered from e1 by every snapshot of a tab, and the table
 * was the tab's, not the caller's: another agent's snapshot (a read, allowed on
 * any tab) after the page inserted a row made THIS agent's `e2` the row above
 * the one it had seen — and its click on "Delete row 2" deleted row 1, reported
 * "delivered" (docs review, 2026-09-22). The same happened to one agent that
 * snapshotted twice. Now:
 *
 * - **Numbers are never reused on a page.** A snapshot continues the page's
 *   numbering (e1…e30, then e31…e58), so a ref from an earlier snapshot can never
 *   collide with a later one's.
 * - **The last KEEP_GENERATIONS snapshots EACH CALLER took of a page are kept.**
 *   A ref from any of them resolves to the element THAT snapshot showed — whoever
 *   took a newer one meanwhile. A ref from an older snapshot of your own, from
 *   another page (the numbering and the history start over when the URL changes),
 *   or for an element the page has since removed is refused with "take a fresh
 *   snapshot".
 * - **Replay's reserved refs (`__…`) live apart** (withPrivateRefs), so a replay
 *   step never swaps the table out from under an agent's snapshot.
 *
 * ## Why retention is per caller (live round 4, 2026-09-22)
 *
 * Counting generations per PAGE made a read by someone else destructive after
 * all. Reads are allowed on any tab at any time and are never queued
 * (DAEMON_PROTOCOL §7), so a second agent watching a tab — the desktop, a
 * reviewer, `browser_snapshot` every 100 ms — pushed four generations through in
 * under half a second and every ref the working agent held stopped resolving,
 * mid-action ("Unknown element ref e14", engine2-livetest section "reads",
 * reproduced 2/2 before this change). The working agent had done nothing wrong
 * and had no way to notice.
 *
 * So each snapshot records who took it (`by`: the caller's agentId, else its
 * name, else null for G9BrowserAgent's own internal snapshots — qa, replay), and a
 * generation survives while it is among that caller's newest KEEP_GENERATIONS.
 * MAX_GENERATIONS caps the whole table so a crowd of agents cannot grow it
 * without bound: the oldest generations beyond the cap are dropped, whoever took
 * them. That is the only case in which another caller can still cost you a ref,
 * and it needs MAX_GENERATIONS/KEEP_GENERATIONS busy agents on one page.
 */

import { platform } from './platform.js';

const session = () => platform.storage.session;

const KEY = (tabId) => `refs:${tabId}`;
const PRIVATE_KEY = (tabId) => `refs-private:${tabId}`;

/** Snapshots of one page, BY ONE CALLER, whose refs stay usable: the newest and three before it. */
export const KEEP_GENERATIONS = 4;

/**
 * The most snapshot generations one page's table ever holds, across every caller. Four agents can
 * each keep their full KEEP_GENERATIONS; beyond that the oldest generation is dropped whoever took
 * it. A generation is a map of at most `maxNodes` refs (900 by default, ~40 bytes of JSON each), so
 * the cap bounds one tab's session-storage entry at roughly 0.6 MB.
 */
export const MAX_GENERATIONS = 16;

/** Who a snapshot belongs to: an agent id if the caller has one, else its name, else null (G9BrowserAgent itself). */
export function ownerOf(caller) {
  const id = caller?.agentId ?? caller?.name ?? null;
  return id == null || id === '' ? null : String(id);
}

/** tabId → { page, n }: the page's ref numbering in this process (a snapshot hands out e<n+1>…). */
const counters = new Map();

function refNumber(ref) {
  const m = /^e(\d+)$/.exec(String(ref ?? ''));
  return m ? Number(m[1]) : 0;
}

export async function saveRefs(tabId, { url, entries, by = null }) {
  const previous = await getRefs(tabId);
  const generation = Math.max(Date.now(), (previous?.generation ?? 0) + 1);
  const map = {};
  let highest = 0;
  for (const [ref, node] of entries) {
    map[ref] = node;
    highest = Math.max(highest, refNumber(ref));
  }
  const owner = by == null || by === '' ? null : String(by);
  const samePage = !!previous && stripHash(previous.url ?? '') === stripHash(url ?? '');
  // Newest first. Each caller keeps its own KEEP_GENERATIONS; MAX_GENERATIONS caps the lot.
  const older = samePage
    ? [{ generation: previous.generation, map: previous.map, by: previous.by ?? null }, ...(previous.history ?? [])]
    : [];
  const perOwner = new Map([[owner, 1]]);
  const history = [];
  for (const gen of older) {
    if (history.length >= MAX_GENERATIONS - 1) break;
    const key = gen.by ?? null;
    const n = (perOwner.get(key) ?? 0) + 1;
    perOwner.set(key, n);
    if (n <= KEEP_GENERATIONS) history.push(gen);
  }
  const next = Math.max(highest, samePage ? (previous.next ?? 0) : 0);
  await session().set({
    [KEY(tabId)]: { generation, url, map, next, history, by: owner },
  });
  return generation;
}

/** The tab's newest snapshot table: `{ generation, url, map, next, history, by }`, or null. */
export async function getRefs(tabId) {
  const stored = await session().get(KEY(tabId));
  return stored[KEY(tabId)] ?? null;
}

/**
 * The numbering for a new snapshot of `url` on this tab: `next()` returns e<n+1>, continuing where
 * the page's last snapshot stopped (from 1 on another page). Shared by concurrent snapshots in
 * this process, so two agents snapshotting at once never hand out the same number.
 */
export async function refNumbering(tabId, url) {
  const page = stripHash(url ?? '');
  let counter = counters.get(tabId);
  if (!counter || counter.page !== page) {
    const table = await getRefs(tabId).catch(() => null);
    const n = table && stripHash(table.url ?? '') === page ? (table.next ?? 0) : 0;
    counter = counters.get(tabId);
    if (!counter || counter.page !== page) {
      counter = { page, n };
      counters.set(tabId, counter);
    }
  }
  const c = counter;
  return { next: () => `e${++c.n}` };
}

/** The node a ref names: the newest snapshot first, then the kept older ones, newest first. */
function lookup(table, ref) {
  if (!table) return null;
  if (table.map?.[ref]) return table.map[ref];
  for (const older of table.history ?? []) if (older.map?.[ref]) return older.map[ref];
  return null;
}

async function privateRefs(tabId) {
  const stored = await session().get(PRIVATE_KEY(tabId));
  return stored[PRIVATE_KEY(tabId)] ?? null;
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
    const tables = [await privateRefs(tabId).catch(() => null), await getRefs(tabId)];
    for (const table of tables) {
      if (!table) continue;
      for (const map of [table.map, ...(table.history ?? []).map((h) => h.map)]) {
        for (const node of Object.values(map ?? {})) {
          if (node?.backendNodeId === backendNodeId) return node.sessionId ?? null;
        }
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
  if (String(ref ?? '').startsWith('__')) {
    const reserved = await privateRefs(tabId);
    if (reserved?.map?.[ref]) return reserved.map[ref];
  }
  const table = await getRefs(tabId);
  if (!table) {
    throw new Error(
      `No snapshot exists for this tab yet. Call browser_snapshot first, then use the refs it returns.`,
    );
  }
  const node = lookup(table, ref);
  if (!node) {
    const available = Object.keys(table.map).slice(0, 12).join(', ');
    throw new Error(
      `Unknown element ref "${ref}". Refs come from browser_snapshot, and a ref stays usable for the last ` +
        `${KEEP_GENERATIONS} snapshots YOU took of this page (another agent's reads never take yours away). ` +
        `Known refs of the newest snapshot include: ${available}${Object.keys(table.map).length > 12 ? ', …' : ''}. ` +
        `Take a fresh snapshot.`,
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
  counters.delete(tabId);
  await session().remove([KEY(tabId), PRIVATE_KEY(tabId)]);
}

/**
 * Run `run()` with reserved refs (names starting "__": a replay's resolved element) registered for
 * this tab, APART from the agents' snapshot table: a replay step used to swap the whole table and
 * put it back afterwards, which also threw away any snapshot another agent took meanwhile.
 */
export async function withPrivateRefs(tabId, { url, entries }, run) {
  const map = {};
  for (const [ref, node] of entries) map[ref] = node;
  const previous = await privateRefs(tabId);
  await session().set({ [PRIVATE_KEY(tabId)]: { url, map } });
  try {
    return await run();
  } finally {
    if (previous) await session().set({ [PRIVATE_KEY(tabId)]: previous });
    else await session().remove(PRIVATE_KEY(tabId));
  }
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
