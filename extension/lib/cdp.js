/**
 * Thin wrapper over chrome.debugger.
 *
 * Everything the agent can "see" or "do" at DevTools depth funnels through
 * send(). Attach/detach is reference-counted per tab so that two concurrent
 * tool calls on the same tab don't detach each other.
 */

import { getState, setState, logActivity } from './state.js';

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

  const fresh = await getState();
  if (!fresh.attachedTabs.includes(tabId)) {
    await setState({ attachedTabs: [...fresh.attachedTabs, tabId] });
  }
  await logActivity({ kind: 'attach', tabId, ok: true });
}

/**
 * Detach from a tab, and check that it worked.
 *
 * The old version swallowed the failure, dropped the tab from `attachedTabs`
 * anyway, and logged `ok: true`. So when a detach did not take, the "browser is
 * being debugged" banner stayed on the user's tab while the extension reported
 * a clean detach and showed nothing attached — the user is left looking at
 * evidence the tool says does not exist. Verify against the browser instead.
 */
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

/** Send without the attach guard — used during attach itself. */
function rawSend(tabId, method, params = {}) {
  return api.debugger.sendCommand({ tabId }, method, params);
}

/**
 * Send a CDP command, attaching first if needed.
 * This is the single choke point for every deep browser operation.
 */
export async function send(tabId, method, params = {}) {
  const state = await getState();
  if (state.halted) throw new CdpError('Agent is halted by the user (Stop was pressed)', { method, tabId });

  await attach(tabId);

  try {
    const result = await rawSend(tabId, method, params);
    return result ?? {};
  } catch (err) {
    const msg = String(err?.message ?? err);
    // A navigation can tear down the session mid-command. One retry after
    // re-attaching resolves the overwhelming majority of these.
    if (msg.includes('Detached') || msg.includes('not attached') || msg.includes('Target closed')) {
      await attach(tabId);
      const result = await rawSend(tabId, method, params);
      return result ?? {};
    }
    throw new CdpError(msg, { method, tabId });
  }
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
export async function callOnNode(tabId, backendNodeId, fnDecl, args = []) {
  const { object } = await send(tabId, 'DOM.resolveNode', { backendNodeId });
  if (!object?.objectId) throw new CdpError('Node is no longer in the document', { tabId });
  try {
    const res = await send(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: fnDecl,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new CdpError(res.exceptionDetails.exception?.description ?? 'Call threw', { tabId });
    }
    return res.result?.value;
  } finally {
    await send(tabId, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}
