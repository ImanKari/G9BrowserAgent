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

export async function detach(tabId) {
  try {
    await api.debugger.detach({ tabId });
  } catch {
    /* already gone */
  }
  for (const key of [...enabled]) if (key.startsWith(`${tabId}:`)) enabled.delete(key);
  const state = await getState();
  await setState({ attachedTabs: state.attachedTabs.filter((id) => id !== tabId) });
  await logActivity({ kind: 'detach', tabId, ok: true });
}

export async function detachAll() {
  const state = await getState();
  await Promise.all(state.attachedTabs.map((id) => detach(id)));
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
