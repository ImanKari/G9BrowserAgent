/**
 * G9BrowserAgent's private JavaScript world inside a page.
 *
 * Everything G9BrowserAgent evaluates for its own purposes — the input witness, the
 * recorder, the locator engine, text extraction, QA reads, replay's element
 * resolution — runs HERE, in an isolated world named `g9`, and never in the
 * page's own (main) world. Same DOM, separate JavaScript globals: a variable
 * G9BrowserAgent sets is invisible to the page, a listener G9BrowserAgent adds cannot be seen by
 * `getEventListeners`-style probes in the page, and the page cannot tamper
 * with G9BrowserAgent's helpers. v1 evaluated in the main world and left `__g9loc`,
 * `__g9target`, `__g9rec` and the recorder binding on the page's `window`,
 * where any MutationObserver or bot detector could find them (rule R4, AIGuide §2.9).
 *
 * `browser_console action:"evaluate"` is the one deliberate exception: there
 * the agent asks about the PAGE's JavaScript, so that stays in the main world
 * (tools/observe.js).
 *
 * ## Facts this file rests on (verified against Edge 153 headless, 2026-09-21)
 *
 * - `Page.createIsolatedWorld` works with the Runtime domain DISABLED, which is
 *   what the stealth level needs (enabling Runtime is a detection vector). The
 *   context id comes back from the command itself, not from
 *   `Runtime.executionContextCreated`, which only fires when Runtime is enabled.
 * - It is idempotent per (frame, worldName): calling it twice returns the same
 *   context id, and `Page.addScriptToEvaluateOnNewDocument({worldName:'g9'})`
 *   runs in that very world. So the recorder, the locator engine and every
 *   evaluation here share one world per document.
 * - Context ids restart per renderer PROCESS. After a cross-process navigation
 *   the new document's g9 world came back as id 2 where the old one was 3. A
 *   cached id can therefore point at a DIFFERENT context in the new process —
 *   possibly the page's main world. That is why every evaluation here carries
 *   a guard (below) instead of trusting the cache.
 * - A stale id fails `Runtime.evaluate` with "Cannot find context with
 *   specified id", and fails `DOM.resolveNode` with "Node with given id does
 *   not belong to the document" (the same text as a genuinely removed node).
 *
 * ## The guard
 *
 * When a context is created, a marker is written into ITS global:
 * `__g9world = <token of this module instance>`. Every expression and function
 * sent through here first checks that marker and throws `G9_STALE_WORLD` if it
 * is missing. Reading an absent global in the wrong world creates nothing
 * there, so a stale id that happens to name the page's main world costs one
 * failed call and a transparent retry — never G9BrowserAgent code running on the page's
 * globals. The marker lives in the isolated world only.
 *
 * The guard throws a STRING, not `new Error(…)`: in the wrong world `Error` is
 * the page's own binding, which a page can replace, so constructing one would
 * run page-controlled code — and tell a detector that G9BrowserAgent was there. A global
 * read and a primitive throw are all the page's world ever sees of it.
 *
 * ## Caching and invalidation
 *
 * Context ids are cached per (tab, CDP session, frame) with the frame's
 * loaderId. A committed navigation (`Page.frameNavigated`) drops the entries it
 * makes stale; a detached child session drops its own. Events are an
 * optimisation, not the correctness mechanism: the guard and one transparent
 * retry on "Cannot find context" / "Execution context was destroyed" are what
 * make a missed event harmless. The cache is module memory, rebuilt on demand
 * after a service-worker restart (AIGuide §4.1): nothing here is a source of
 * truth, only a saved round trip.
 */

import { send } from './cdp.js';
import { sessionForNode } from './refs.js';
import { platform } from './platform.js';

export const WORLD = 'g9';

/** The marker global inside the isolated world, and this instance's token. */
const MARK = '__g9world';
const TOKEN = `g9-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const STALE_MARK = 'G9_STALE_WORLD';

/**
 * Errors that mean "that context id no longer names our world". The expression
 * cannot have run in any of these cases, except "destroyed", which can also
 * mean the document went away while an awaited promise was pending — callers
 * whose expression has side effects pass `idempotent:false` and get the error.
 */
const NEVER_RAN = /Cannot find context with specified id|Cannot find default execution context|Execution context with given id not found|G9_STALE_WORLD/;
const DESTROYED = /Execution context was destroyed|Inspected target navigated or closed/;

/** key(tab, session) → main frame id of that session's frame tree. */
const mainFrames = new Map();
/** key(tab, session, frame) → { contextId, frameId, loaderId, at } */
const contexts = new Map();
/** key(tab, session, frame|'main') → Promise<entry>, so concurrent callers share one creation. */
const creating = new Map();

const sessKey = (tabId, sessionId) => `${tabId}|${sessionId || ''}`;
const ctxKey = (tabId, sessionId, frameId) => `${sessKey(tabId, sessionId)}|${frameId}`;

// ------------------------------------------------------------------- events

let listening = false;

/**
 * Subscribe to the navigations that make cached ids stale. Lazy (first use),
 * because this module may be imported where no debugger exists yet, and a
 * missed event is harmless anyway (see the guard). tools/events.js may also
 * call `invalidate()` directly; doing both costs nothing.
 */
function ensureListening() {
  if (listening) return;
  listening = true;
  try {
    platform.debugger.onEvent((source, method, params) => {
      if (source?.tabId == null) return;
      if (method === 'Page.frameNavigated' && params?.frame) {
        onFrameNavigated(source.tabId, source.sessionId ?? null, params.frame);
      } else if (method === 'Page.frameDetached' && params?.frameId) {
        dropFrame(source.tabId, params.frameId);
      } else if (method === 'Target.detachedFromTarget' && params?.sessionId) {
        invalidate(source.tabId, params.sessionId);
      }
    });
    platform.debugger.onDetach?.((source) => {
      if (source?.tabId != null) invalidate(source.tabId);
    });
  } catch {
    // No event source on this platform (a unit test, say). The guard and the
    // retry still keep every call correct; only the saved round trip is lost.
  }
}

function onFrameNavigated(tabId, sessionId, frame) {
  // The page session's main frame navigated: every world in the tab went with
  // the old document, including the out-of-process children it contained.
  if (!frame.parentId && !sessionId) {
    invalidate(tabId);
    return;
  }
  dropFrame(tabId, frame.id, frame.loaderId);
}

/** Drop cached worlds of one frame (in any session of the tab), except those already on `loaderId`. */
function dropFrame(tabId, frameId, loaderId = null) {
  const prefix = `${tabId}|`;
  for (const [key, entry] of contexts) {
    if (key.startsWith(prefix) && entry.frameId === frameId && (!loaderId || entry.loaderId !== loaderId)) {
      contexts.delete(key);
    }
  }
}

/**
 * Forget cached worlds. `sessionId` null drops the whole tab (every session):
 * the right answer for a top-level navigation, a detach or a closed tab. A
 * child sessionId drops only that frame process's worlds.
 */
export function invalidate(tabId, sessionId = null) {
  const prefix = sessionId ? `${sessKey(tabId, sessionId)}|` : `${tabId}|`;
  for (const key of [...contexts.keys()]) if (key.startsWith(prefix)) contexts.delete(key);
  for (const key of [...creating.keys()]) if (key.startsWith(prefix)) creating.delete(key);
  if (sessionId) mainFrames.delete(sessKey(tabId, sessionId));
  else for (const key of [...mainFrames.keys()]) if (key.startsWith(`${tabId}|`)) mainFrames.delete(key);
}

function dropEntry(tabId, sessionId, contextId) {
  const prefix = `${sessKey(tabId, sessionId)}|`;
  for (const [key, entry] of contexts) {
    if (key.startsWith(prefix) && entry.contextId === contextId) contexts.delete(key);
  }
}

// ------------------------------------------------------------------ context

/**
 * The execution context id of G9BrowserAgent's world in a frame.
 *
 * `frameId` null means the main frame of the given session: the top document
 * for the page session, the frame's own document for a cross-origin child
 * session (whose frame tree is rooted at that frame).
 */
export async function contextFor(tabId, { sessionId = null, frameId = null } = {}) {
  const cached = cachedEntry(tabId, sessionId, frameId);
  if (cached) return cached.contextId;
  return (await createEntry(tabId, sessionId, frameId)).contextId;
}

function cachedEntry(tabId, sessionId, frameId) {
  const fid = frameId ?? mainFrames.get(sessKey(tabId, sessionId));
  return fid ? contexts.get(ctxKey(tabId, sessionId, fid)) ?? null : null;
}

function createEntry(tabId, sessionId, frameId) {
  ensureListening();
  const pendingKey = ctxKey(tabId, sessionId, frameId ?? 'main');
  const existing = creating.get(pendingKey);
  if (existing) return existing;

  const job = (async () => {
    const tree = await send(tabId, 'Page.getFrameTree', {}, { sessionId });
    const root = tree?.frameTree?.frame;
    if (!root?.id) {
      throw new Error('The page reported no frame tree, so G9BrowserAgent cannot create its isolated world there.');
    }
    mainFrames.set(sessKey(tabId, sessionId), root.id);

    let frame = root;
    if (frameId && frameId !== root.id) {
      frame = findFrame(tree.frameTree, frameId);
      if (!frame) {
        throw new Error(
          `Frame ${frameId} is no longer in this page — it navigated away or was removed. Take a fresh browser_snapshot.`,
        );
      }
    }

    const created = await send(tabId, 'Page.createIsolatedWorld', {
      frameId: frame.id,
      worldName: WORLD,
      // (sic) — the protocol's own spelling. Universal access lets the world
      // read same-process frames of another origin (a sibling subdomain), which
      // the witness needs to listen where the event will land.
      grantUniveralAccess: true,
    }, { sessionId });
    const contextId = created?.executionContextId;
    if (!Number.isInteger(contextId)) {
      throw new Error('Page.createIsolatedWorld returned no execution context id.');
    }

    // Mark the world as ours. See "The guard" at the top of this file.
    const marked = await send(tabId, 'Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(MARK)}] = ${JSON.stringify(TOKEN)}; true`,
      contextId,
      returnByValue: true,
    }, { sessionId });
    if (marked?.exceptionDetails) {
      throw new Error(`Could not initialise G9BrowserAgent's isolated world: ${describeException(marked.exceptionDetails)}`);
    }

    const entry = { contextId, frameId: frame.id, loaderId: frame.loaderId ?? null, at: Date.now() };
    contexts.set(ctxKey(tabId, sessionId, frame.id), entry);
    return entry;
  })();

  creating.set(pendingKey, job);
  job.then(() => creating.delete(pendingKey), () => creating.delete(pendingKey));
  return job;
}

function findFrame(node, frameId, depth = 0) {
  if (!node || depth > 40) return null;
  if (node.frame?.id === frameId) return node.frame;
  for (const child of node.childFrames ?? []) {
    const hit = findFrame(child, frameId, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * contextFor, but PROVEN to still name G9BrowserAgent's world (the guard runs in it first).
 *
 * For callers that hand the id to a command with no guard of its own —
 * `Runtime.addBinding({executionContextId})`. A cached id that went stale in a
 * cross-process navigation can name the page's MAIN world in the new process;
 * binding there would put `__g9emit` on the page's window (rule R4). The check
 * and the use are two commands, so a navigation landing exactly between them
 * is not excluded — only the stale-cache case, which is the one that happens.
 */
export async function verifiedContextFor(tabId, { sessionId = null, frameId = null } = {}) {
  return withContext(tabId, { sessionId, frameId }, async (contextId) => {
    const res = await send(tabId, 'Runtime.evaluate', {
      expression: guardExpression('true'),
      contextId,
      returnByValue: true,
    }, { sessionId });
    if (res?.exceptionDetails) throw new Error(describeException(res.exceptionDetails));
    return contextId;
  });
}

/**
 * Every frame of a session's tree, flattened (depth-first, bounded). Used by
 * the recorder to bind each frame's world when the Runtime domain is off.
 */
export async function framesOf(tabId, { sessionId = null, limit = 30 } = {}) {
  const tree = await send(tabId, 'Page.getFrameTree', {}, { sessionId });
  const out = [];
  const walk = (node, depth) => {
    if (!node?.frame || out.length >= limit || depth > 10) return;
    out.push({ id: node.frame.id, parentId: node.frame.parentId ?? null, url: node.frame.url ?? '', loaderId: node.frame.loaderId ?? null });
    for (const child of node.childFrames ?? []) walk(child, depth + 1);
  };
  walk(tree?.frameTree, 0);
  return out;
}

// --------------------------------------------------------------- evaluation

/**
 * Run with a context id, retrying ONCE with a fresh one when the cached id
 * turned out to be stale. The retry is transparent because a stale id means
 * the expression never ran (or ran in a document that no longer exists).
 */
async function withContext(tabId, { sessionId = null, frameId = null }, run, { idempotent = true, staleNode = false } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const wasCached = !!cachedEntry(tabId, sessionId, frameId);
    // Creating the world is inside the retry too: a navigation that lands
    // between Page.createIsolatedWorld and the marker write fails the write
    // with "Cannot find context" — the same stale id, one step earlier. The
    // caller's expression has not run at all then, so a retry is always safe.
    let contextId;
    try {
      contextId = await contextFor(tabId, { sessionId, frameId });
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (attempt === 0 && (NEVER_RAN.test(msg) || DESTROYED.test(msg))) {
        if (frameId == null) mainFrames.delete(sessKey(tabId, sessionId));
        continue;
      }
      throw explain(err);
    }
    try {
      return await run(contextId);
    } catch (err) {
      const msg = String(err?.message ?? err);
      const stale = NEVER_RAN.test(msg)
        || (idempotent && DESTROYED.test(msg))
        // A stale id in DOM.resolveNode reads exactly like a removed node.
        // Only a CACHED id earns the benefit of the doubt; a fresh one that
        // still fails means the node really is gone.
        || (staleNode && wasCached && /does not belong to the document/.test(msg));
      if (attempt === 0 && stale) {
        dropEntry(tabId, sessionId, contextId);
        if (frameId == null) mainFrames.delete(sessKey(tabId, sessionId));
        continue;
      }
      throw explain(err);
    }
  }
}

function explain(err) {
  const msg = String(err?.message ?? err);
  if (msg.includes(STALE_MARK) || NEVER_RAN.test(msg)) {
    const out = new Error(
      'The page replaced its document while G9BrowserAgent was reading it (a navigation or a frame reload), ' +
        'and G9BrowserAgent could not re-establish its isolated world there. Try again once the page has settled.',
    );
    out.cause = err;
    return out;
  }
  return err instanceof Error ? err : new Error(msg);
}

function describeException(details) {
  return details?.exception?.description ?? details?.exception?.value ?? details?.text ?? 'Script threw';
}

/**
 * Prefix an expression with the world guard. A statement before the
 * expression does not change a script's completion value, so the caller's
 * expression still decides what comes back — including a promise to await.
 */
export function guardExpression(expression) {
  return `if (globalThis[${JSON.stringify(MARK)}] !== ${JSON.stringify(TOKEN)}) throw ${JSON.stringify(STALE_MARK)};\n${expression}`;
}

/** Wrap a function declaration so it refuses to run outside G9BrowserAgent's world. */
export function guardFunction(fnDecl) {
  return `function () {
  if (globalThis[${JSON.stringify(MARK)}] !== ${JSON.stringify(TOKEN)}) throw ${JSON.stringify(STALE_MARK)};
  return (${fnDecl}).apply(this, arguments);
}`;
}

/**
 * Evaluate an expression in G9BrowserAgent's world.
 *
 * `returnByValue` true (default) returns the plain value. With
 * `returnByValue:false` the RemoteObject itself is returned — `{ objectId,
 * type, subtype, … }` — and the CALLER owns it and must release it
 * (`Runtime.releaseObject`, same sessionId). The input witness uses that to
 * get a handle on a promise without awaiting it.
 *
 * `userGesture` is off by default: an evaluation that counts as a user
 * activation is visible to the page (`navigator.userActivation`) with no input
 * event to explain it.
 */
export async function inWorld(tabId, expression, {
  sessionId = null, awaitPromise = true, returnByValue = true, frameId = null,
  userGesture = false, idempotent = true, timeoutMs,
} = {}) {
  return withContext(tabId, { sessionId, frameId }, async (contextId) => {
    const res = await send(tabId, 'Runtime.evaluate', {
      expression: guardExpression(expression),
      contextId,
      awaitPromise,
      returnByValue,
      userGesture,
    }, { sessionId, ...(timeoutMs ? { timeoutMs } : {}) });
    if (res?.exceptionDetails) throw new Error(describeException(res.exceptionDetails));
    return returnByValue ? res?.result?.value : (res?.result ?? null);
  }, { idempotent });
}

/**
 * Call a function with `this` bound to a remote object G9BrowserAgent already holds in
 * its world — a witness promise, say. The object's own context decides where
 * it runs, and the guard still refuses anything that is not G9BrowserAgent's world. No
 * retry: an object does not outlive its context, so a stale one is simply gone
 * and the error says so.
 */
export async function callOnObject(tabId, objectId, fnDecl, args = [], sessionId = null, { via = send } = {}) {
  // `via` replaces cdp.send for a caller with its own sending rules (interact.js ends its witness
  // after Stop that way); the call is the same guarded call in the object's own world.
  const res = await via(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: guardFunction(fnDecl),
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: false,
    userGesture: false,
  }, { sessionId });
  if (res?.exceptionDetails) throw new Error(describeException(res.exceptionDetails));
  return res?.result?.value;
}

/**
 * Call a function with `this` bound to a DOM node, inside G9BrowserAgent's world.
 *
 * `DOM.resolveNode({backendNodeId, executionContextId})` wraps the node in
 * the g9 world, so everything the function touches — `window`, expandos on the
 * node, listeners it adds — belongs to G9BrowserAgent's world, not the page's. For a node
 * inside a same-origin iframe the function still compiles in the top frame's
 * g9 world (the context the node was resolved in), and `this.ownerDocument.
 * defaultView` is that iframe's window IN THE G9BrowserAgent WORLD: exactly the realm
 * semantics v1's main-world `callOnNode` had, one world over.
 *
 * `sessionId` null asks the snapshot table which frame process owns the node,
 * like cdp.callOnNode, so no call site has to remember to thread it.
 */
export async function callInWorld(tabId, backendNodeId, fnDecl, args = [], sessionId = null, {
  returnByValue = true, awaitPromise = true, userGesture = false,
} = {}) {
  const session = sessionId ?? await sessionForNode(tabId, backendNodeId);
  return withContext(tabId, { sessionId: session }, async (contextId) => {
    const resolved = await send(tabId, 'DOM.resolveNode', { backendNodeId, executionContextId: contextId }, { sessionId: session });
    const objectId = resolved?.object?.objectId;
    if (!objectId) throw new Error('Node is no longer in the document');
    try {
      const res = await send(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: guardFunction(fnDecl),
        arguments: args.map((value) => ({ value })),
        returnByValue,
        awaitPromise,
        userGesture,
      }, { sessionId: session });
      if (res?.exceptionDetails) throw new Error(describeException(res.exceptionDetails));
      return returnByValue ? res?.result?.value : (res?.result ?? null);
    } finally {
      await send(tabId, 'Runtime.releaseObject', { objectId }, { sessionId: session }).catch(() => {});
    }
  }, { staleNode: true });
}
