/**
 * Thin wrapper over chrome.debugger.
 *
 * Everything the agent can "see" or "do" at DevTools depth funnels through
 * send(). Attach/detach is reference-counted per tab so that two concurrent
 * tool calls on the same tab don't detach each other.
 */

import { getState, setState, logActivity } from './state.js';
import { sessionForNode } from './refs.js';

const api = globalThis.browser ?? globalThis.chrome;

/** CDP protocol version. 1.3 is the stable Chrome/Edge protocol. */
const PROTOCOL = '1.3';

/**
 * Domains we enable on attach. Enabling is what makes events start flowing —
 * without Network.enable there are no requests, without Runtime.enable there
 * are no console messages.
 */
const AUTO_ENABLE = ['Page', 'Runtime', 'Log', 'Network', 'DOM', 'CSS'];

/** In-memory caches. Rebuilt after a service-worker restart, so never trusted. */
const enabled = new Set();

export class CdpError extends Error {
  constructor(message, { method, tabId } = {}) {
    super(message);
    this.name = 'CdpError';
    this.method = method;
    this.tabId = tabId;
  }
}

/** Is the debugger already attached to this tab (by us or anyone)? */
async function isAttached(tabId) {
  const targets = await api.debugger.getTargets();
  return targets.some((t) => t.tabId === tabId && t.attached);
}

/**
 * Tab ids the BROWSER reports as being debugged, by anyone.
 *
 * This is the only source of truth for "is the banner still up". Our
 * `attachedTabs` list is bookkeeping and can drift from it — which is exactly
 * the drift that made a failed detach invisible.
 */
export async function attachedTabIds() {
  const targets = await api.debugger.getTargets();
  return targets.filter((t) => t.attached && t.tabId != null).map((t) => t.tabId);
}

export async function attach(tabId) {
  const state = await getState();
  if (state.attachedTabs.includes(tabId) && (await isAttached(tabId))) return;

  try {
    await api.debugger.attach({ tabId }, PROTOCOL);
  } catch (err) {
    const msg = String(err?.message ?? err);
    // Another client (a real DevTools window, or a previous session we lost
    // track of) already owns this tab. That is recoverable only by the user.
    if (msg.includes('Another debugger') || msg.includes('already attached')) {
      if (!(await isAttached(tabId))) throw new CdpError(msg, { tabId });
      // It's us from before the SW restarted — carry on.
    } else {
      throw new CdpError(msg, { tabId });
    }
  }

  for (const domain of AUTO_ENABLE) {
    try {
      await rawSend(tabId, `${domain}.enable`);
      enabled.add(`${tabId}:${domain}`);
    } catch {
      /* some domains are unavailable on some target types; not fatal */
    }
  }

  // Attach to cross-origin children as they appear.
  //
  // Done here rather than on demand because a frame that loads before anyone
  // asks for a snapshot would otherwise never be attached, and the symptom is
  // the old one: the iframe is right there on screen and has no nodes. Failure
  // is non-fatal — on a browser without flat-session support (before Chrome
  // 125) this simply does nothing and same-origin work is unaffected.
  try {
    await rawSend(tabId, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  } catch {
    /* older Chrome, or a target type that has no children */
  }

  const fresh = await getState();
  if (!fresh.attachedTabs.includes(tabId)) {
    await setState({ attachedTabs: [...fresh.attachedTabs, tabId] });
  }
  await logActivity({ kind: 'attach', tabId, ok: true });
}

/**
 * Detach from several tabs at once, and check that it worked.
 *
 * Batched deliberately. The first version verified per tab, which meant N
 * `getTargets()` round trips plus N pairs of serialized state writes — and the
 * user is watching the debugger banner the whole time. Detaching is independent
 * per tab, so the calls go out together and one `getTargets()` answers for all
 * of them.
 *
 * The verification is the point: the old code caught the failure with
 * `catch { /* already gone *​/ }`, dropped the tab from `attachedTabs` anyway,
 * and logged `ok: true`. "Already gone" is a guess about why the call failed —
 * the call never says that — and when the guess was wrong the banner stayed up
 * while the extension reported a clean detach.
 */
export async function detachMany(tabIds) {
  const started = Date.now();
  const ids = [...new Set(tabIds)].filter((id) => id != null);
  if (!ids.length) return [];

  const errors = new Map();
  await Promise.all(
    ids.map(async (id) => {
      try {
        await api.debugger.detach({ tabId: id });
      } catch (err) {
        errors.set(id, String(err?.message ?? err));
      }
    }),
  );

  for (const key of [...enabled]) {
    if (ids.some((id) => key.startsWith(`${id}:`))) enabled.delete(key);
  }

  const stillAttached = new Set(await attachedTabIds().catch(() => []));

  const state = await getState();
  await setState({ attachedTabs: state.attachedTabs.filter((id) => !ids.includes(id)) });

  const results = ids.map((id) => ({
    tabId: id,
    detached: !stillAttached.has(id),
    stillAttached: stillAttached.has(id),
    error: errors.get(id) ?? null,
  }));

  const stuck = results.filter((r) => r.stillAttached);
  await logActivity({
    kind: 'detach',
    ok: !stuck.length,
    ms: Date.now() - started,
    detail: stuck.length
      ? `released ${ids.length - stuck.length}/${ids.length}; ${stuck.length} still debugged by another client (DevTools open on that tab)`
      : `released ${ids.length} tab(s)`,
  });

  return results;
}

export async function detach(tabId) {
  const [result] = await detachMany([tabId]);
  return result ?? { tabId, detached: true, stillAttached: false, error: null };
}

/** Detach from every tab we hold. Returns one result per tab. */
export async function detachAll() {
  const state = await getState();
  return detachMany(state.attachedTabs);
}

/**
 * Send without the attach guard — used during attach itself.
 *
 * `sessionId` routes the command to a CHILD target: a cross-origin iframe, or a
 * worker. Chrome 125 added flat sessions to `chrome.debugger`, which is what
 * makes this a property on the debuggee rather than a second `attach` call per
 * frame. Without it, a cross-origin iframe is visible and untouchable — the tab
 * session simply has no nodes for a document that lives in another process.
 */
function rawSend(tabId, method, params = {}, sessionId = null) {
  const debuggee = sessionId ? { tabId, sessionId } : { tabId };
  return api.debugger.sendCommand(debuggee, method, params);
}

/**
 * How long any single CDP command may take before we stop waiting.
 *
 * Some commands can wedge and never resolve at all. `Input.dispatchMouseEvent`
 * with `mouseWheel` does it reliably while `Page.startScreencast` is running:
 * the promise simply never settles. Without a bound, that consumed the bridge's
 * entire 60s tool budget and then produced a diagnosis that was not merely
 * unhelpful but WRONG — "the page may be blocked by a JavaScript dialog" — and
 * sent whoever read it looking in the wrong place. Bounding it here means one
 * stuck command reports itself, by name, instead of poisoning the call.
 *
 * Comfortably longer than any healthy command, and comfortably shorter than the
 * bridge timeout, so this error wins the race and the agent learns something.
 *
 * A few commands are legitimately slow rather than stuck — capturing a large
 * page, or ending a trace — and cutting those off would invent a failure where
 * there was only patience required. They get their own budget, still under the
 * bridge's 60s. Callers can override per call; nothing may exceed the bridge.
 */
const COMMAND_TIMEOUT_MS = 20_000;

const SLOW_COMMANDS = new Map([
  ['Page.captureScreenshot', 45_000],
  ['Page.getLayoutMetrics', 30_000],
  ['Tracing.end', 45_000],
  ['IO.read', 45_000],
]);

function withTimeout(promise, method, tabId, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new CdpError(
          `The CDP command "${method}" did not return after ${Math.round(timeoutMs / 1000)}s. ` +
          `The command is stuck rather than slow — the browser accepted it and never answered.`,
          { method, tabId },
        )),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Send a CDP command, attaching first if needed.
 * This is the single choke point for every deep browser operation.
 */
export async function send(tabId, method, params = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? SLOW_COMMANDS.get(method) ?? COMMAND_TIMEOUT_MS;
  const sessionId = options.sessionId ?? null;
  const state = await getState();
  if (state.halted) throw new CdpError('Agent is halted by the user (Stop was pressed)', { method, tabId });

  await attach(tabId);

  try {
    const result = await withTimeout(rawSend(tabId, method, params, sessionId), method, tabId, timeoutMs);
    return result ?? {};
  } catch (err) {
    const msg = String(err?.message ?? err);
    // A navigation can tear down the session mid-command. One retry after
    // re-attaching resolves the overwhelming majority of these.
    //
    // A CHILD session is not re-created by re-attaching to the tab, so retrying
    // one would send the command to a session that no longer exists. A frame
    // that went away is reported, and the caller takes a fresh snapshot.
    if (!sessionId && (msg.includes('Detached') || msg.includes('not attached') || msg.includes('Target closed'))) {
      await attach(tabId);
      const result = await withTimeout(rawSend(tabId, method, params), method, tabId, timeoutMs);
      return result ?? {};
    }
    if (sessionId && (msg.includes('Session') || msg.includes('not attached') || msg.includes('Target closed'))) {
      throw new CdpError(
        `${msg} — that cross-origin frame is gone (it navigated or was removed). Take a fresh browser_snapshot.`,
        { method, tabId },
      );
    }
    throw new CdpError(msg, { method, tabId });
  }
}

/**
 * Send a command on a session we already know is live, skipping every guard.
 *
 * `send()` pays for its safety on every call: a halt check, an attach check,
 * and inside `attach()` a `chrome.debugger.getTargets()` round trip. That is
 * the right price for a tool call. It is the wrong price for answering a
 * high-frequency event on a session that just proved it exists by DELIVERING
 * that event — the screencast frame ack is the case that matters, and paying
 * full price per frame starved the worker badly enough that an ordinary scroll
 * during a recording timed out after 60s.
 *
 * Use this ONLY to respond to an event from the same tab, never to start work.
 * There is no halt check here, which is safe for an ack and would not be for
 * anything the agent asked for.
 */
export function sendOnLiveSession(tabId, method, params = {}) {
  return rawSend(tabId, method, params);
}

/** Ensure a domain is enabled before relying on its events. */
export async function ensureDomain(tabId, domain, params = {}) {
  const key = `${tabId}:${domain}`;
  if (enabled.has(key)) return;
  try {
    await send(tabId, `${domain}.enable`, params);
    enabled.add(key);
  } catch (err) {
    throw new CdpError(`Could not enable ${domain}: ${err.message}`, { tabId });
  }
}

/** Evaluate an expression in the page and return a plain JS value. */
export async function evaluate(tabId, expression, { awaitPromise = true, returnByValue = true } = {}) {
  const res = await send(tabId, 'Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new CdpError(d.exception?.description ?? d.text ?? 'Script threw', { tabId });
  }
  return res.result?.value;
}

/** Call a function with `this` bound to a specific DOM node. */
export async function callOnNode(tabId, backendNodeId, fnDecl, args = [], sessionId = null) {
  // `sessionId` is the fifth parameter and not the fourth on purpose: `args`
  // was already there and callers pass it positionally, so inserting ahead of
  // it would have silently handed a session string to `args.map`.
  //
  // When the caller does not say, ASK. Every node this extension acts on came
  // from a snapshot, and the snapshot recorded which frame it lives in — so the
  // routing is knowable without a dozen call sites each remembering to pass it.
  const resolved = sessionId ?? await sessionForNode(tabId, backendNodeId);
  const opts = { sessionId: resolved };
  const { object } = await send(tabId, 'DOM.resolveNode', { backendNodeId }, opts);
  if (!object?.objectId) throw new CdpError('Node is no longer in the document', { tabId });
  try {
    const res = await send(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: fnDecl,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, opts);
    if (res.exceptionDetails) {
      throw new CdpError(res.exceptionDetails.exception?.description ?? 'Call threw', { tabId });
    }
    return res.result?.value;
  } finally {
    await send(tabId, 'Runtime.releaseObject', { objectId: object.objectId }, opts).catch(() => {});
  }
}
