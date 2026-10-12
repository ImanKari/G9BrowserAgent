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
import { codedError } from './errcode.js';

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

/**
 * (3.5) How much of the shared session storage one tab's ref table may take. chrome.storage.session
 * has ONE 10 MB quota for the whole extension — refs, console and network buffers, diff bases, every
 * tab. Before 3.5 an entry kept the element's FULL accessible name (a chat message, an article: tens
 * of kilobytes each) in every one of up to 16 generations, and nothing bounded the table in bytes:
 * on chat and media apps snapshots began to fail with "Session storage quota bytes exceeded" even
 * with maxNodes:40, while the same page in another tab was fine (field report, 8 times on three
 * sites). Now a name is cut to NAME_MAX characters (it is only used in messages), the oldest kept
 * generations go first when a table outgrows TABLE_BUDGET, and a quota refusal makes room
 * (setWithRoom) instead of failing the snapshot.
 */
export const NAME_MAX = 80;
export const TABLE_BUDGET = 1_000_000;

/** A ref entry as stored: the node's ids, its role, and a short name. */
function compactNode(node) {
  const name = String(node?.name ?? '');
  return { ...node, name: name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name };
}

/** Rough JSON size of a value, in bytes (UTF-16 units; good enough for a budget). */
function sizeOf(value) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

const QUOTA = /quota/i;

/**
 * storage.session.set that makes room when the quota refuses it: first other tabs' snapshot
 * history and diff bases (they cost those agents at most a re-snapshot), then — for this tab's own
 * table — its own history. Never console/network evidence, never anything else's state.
 * `shrink()` returns a smaller version of `items` or null when nothing more can go.
 */
export async function setWithRoom(items, { tabId = null, shrink = null } = {}) {
  try {
    await session().set(items);
    return { freed: 0 };
  } catch (err) {
    if (!QUOTA.test(String(err?.message ?? err))) throw err;
  }
  let freed = 0;
  const all = await session().get(null).catch(() => ({}));
  const mine = new Set(Object.keys(items));
  const trimmed = {};
  const dropped = [];
  for (const [key, value] of Object.entries(all ?? {})) {
    if (mine.has(key)) continue;
    if (/^snapdiff:/.test(key)) {
      dropped.push(key);
      freed += sizeOf(value);
    } else if (/^refs:/.test(key) && value?.history?.length) {
      freed += sizeOf(value.history);
      trimmed[key] = { ...value, history: [] };
    }
  }
  if (dropped.length) await session().remove(dropped).catch(() => {});
  if (Object.keys(trimmed).length) await session().set(trimmed).catch(() => {});
  let attempt = items;
  for (let i = 0; i < 6; i++) {
    try {
      await session().set(attempt);
      return { freed, ...(attempt !== items ? { shrunk: true } : {}) };
    } catch (err) {
      if (!QUOTA.test(String(err?.message ?? err))) throw err;
      const smaller = typeof shrink === 'function' ? shrink(attempt) : null;
      if (!smaller) {
        throw new Error(
          `The browser's session storage for G9BrowserAgent is full (its 10 MB quota is shared by every tab's console and ` +
            `network capture and snapshot refs), even after dropping other tabs' older snapshots${tabId != null ? ` (tab ${tabId})` : ''}. ` +
            'Close tabs you no longer need, or clear capture with browser_console clear:true / browser_network clear:true, then retry.',
        );
      }
      attempt = smaller;
    }
  }
  throw new Error('The browser\'s session storage for G9BrowserAgent is full; close unused tabs and retry.');
}

export async function saveRefs(tabId, { url, entries, by = null }) {
  const previous = await getRefs(tabId);
  const generation = Math.max(Date.now(), (previous?.generation ?? 0) + 1);
  const map = {};
  let highest = 0;
  for (const [ref, node] of entries) {
    map[ref] = compactNode(node);
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
  // (3.5) The table's byte budget: the oldest kept generations go first (the newest is always kept).
  let size = sizeOf(map);
  const kept = [];
  for (const gen of history) {
    const s = sizeOf(gen.map);
    if (size + s > TABLE_BUDGET) break;
    size += s;
    kept.push(gen);
  }
  const table = { generation, url, map, next, history: kept, by: owner };
  await setWithRoom({ [KEY(tabId)]: table }, {
    tabId,
    // Under a full quota this tab gives up its own history last, then nothing more: the newest
    // snapshot's refs are what the agent is about to use.
    shrink: (items) => (items[KEY(tabId)].history.length ? { [KEY(tabId)]: { ...items[KEY(tabId)], history: items[KEY(tabId)].history.slice(0, -1) } } : null),
  });
  return generation;
}

/**
 * (3.5) Give elements found WITHOUT a snapshot (a CSS selector in browser_interact) refs in the
 * page's table, so every action keeps working through refs: an element a kept snapshot already
 * named keeps that ref; a new one gets the next number. Added to the newest generation (or a new
 * table when the page changed). → the refs, in the order of `nodes` ({ backendNodeId, role, name, sessionId }).
 */
export async function adoptNodes(tabId, url, nodes, by = null) {
  const table = await getRefs(tabId);
  const samePage = !!table && stripHash(table.url ?? '') === stripHash(url ?? '');
  const known = await knownRefs(tabId, url);
  const numbering = await refNumbering(tabId, url);
  const map = samePage ? { ...table.map } : {};
  const refs = [];
  let highest = 0;
  for (const node of nodes) {
    let ref = known.get(nodeKey(node.sessionId ?? null, node.backendNodeId));
    if (!ref) ref = numbering.next();
    map[ref] = compactNode({ backendNodeId: node.backendNodeId, role: node.role ?? 'element', name: node.name ?? '', sessionId: node.sessionId ?? null });
    highest = Math.max(highest, refNumber(ref));
    refs.push(ref);
  }
  const next = Math.max(highest, samePage ? (table.next ?? 0) : 0);
  const out = samePage
    ? { ...table, map, next }
    : { generation: Math.max(Date.now(), (table?.generation ?? 0) + 1), url, map, next, history: [], by: by == null || by === '' ? null : String(by) };
  await setWithRoom({ [KEY(tabId)]: out }, { tabId });
  return refs;
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

/** The key that names one element across snapshots: its frame session and its backend node id. */
export function nodeKey(sessionId, backendNodeId) {
  return `${sessionId ?? ''}:${backendNodeId}`;
}

/**
 * (3.4) The refs this page's kept snapshots already gave elements: nodeKey → ref (newest first wins).
 * A new snapshot hands an element the ref it already has instead of a new number — refs are STABLE
 * per element while any kept snapshot of the page holds them. That is what makes a snapshot diff
 * readable (an unchanged element keeps its ref, so it need not be repeated) and keeps an agent's refs
 * to elements it no longer sees in a diff alive. Numbers are still never reused for ANOTHER element.
 */
export async function knownRefs(tabId, url) {
  const out = new Map();
  const table = await getRefs(tabId).catch(() => null);
  if (!table || stripHash(table.url ?? '') !== stripHash(url ?? '')) return out;
  for (const map of [table.map, ...(table.history ?? []).map((h) => h.map)]) {
    for (const [ref, node] of Object.entries(map ?? {})) {
      if (node?.backendNodeId == null) continue;
      const key = nodeKey(node.sessionId ?? null, node.backendNodeId);
      if (!out.has(key)) out.set(key, ref);
    }
  }
  return out;
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
    throw codedError('no_snapshot', `No snapshot exists for this tab yet. Call browser_snapshot first, then use the refs it returns.`);
  }
  const node = lookup(table, ref);
  if (!node) {
    const available = Object.keys(table.map).slice(0, 12).join(', ');
    throw codedError(
      'stale_ref',
      `Unknown element ref "${ref}". Refs come from browser_snapshot, and a ref stays usable for the last ` +
        `${KEEP_GENERATIONS} snapshots YOU took of this page (another agent's reads never take yours away). ` +
        `Known refs of the newest snapshot include: ${available}${Object.keys(table.map).length > 12 ? ', …' : ''}. ` +
        `Take a fresh snapshot.`,
    );
  }
  if (currentUrl && table.url && stripHash(table.url) !== stripHash(currentUrl)) {
    throw codedError(
      'stale_ref',
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
