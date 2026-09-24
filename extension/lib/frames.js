/**
 * Cross-origin iframes: the ones that used to be visible and untouchable.
 *
 * ## Why this was written off, and why that was wrong
 *
 * The QA ledger carried this as `wontfix — a browser limit, no amount of
 * development removes it`. That was simply not true, and it stayed in the
 * ledger for a day because nobody checked it. A cross-origin iframe runs in its
 * OWN process, so the tab's debugger session has no nodes for it — that part is
 * real. What follows from it is not: CDP has always been able to attach to
 * those child targets, and since **Chrome 125** `chrome.debugger` can too,
 * through flat sessions. A command carrying a `sessionId` reaches the frame.
 *
 * The practical consequence is the whole point: a payment page, an SSO form, a
 * map widget, a help chat — anything a real app embeds from another origin is
 * now clickable instead of being where a flow stops and a human takes over.
 *
 * ## How it works
 *
 * `Target.setAutoAttach({ flatten: true })` on the tab attaches to every
 * out-of-process child as it appears, each with its own session. Auto-attach is
 * **not recursive** — it attaches a frame's immediate children only — so the
 * same call is repeated on each new session, which is what makes an iframe
 * inside an iframe reachable.
 *
 * ## What is still out of reach, honestly
 *
 * A **closed** Shadow DOM. That one really is a browser boundary: the page has
 * chosen not to expose the tree, and no protocol hands it over. Same-origin
 * iframes and open Shadow DOM were never the problem — they already worked.
 */

import { platform } from './platform.js';
import { send } from './cdp.js';

const session = () => platform.storage.session;

const KEY = (tabId) => `frames:${tabId}`;

/** Deep enough for any real embed; a bound so a frame bomb cannot spin forever. */
const MAX_FRAMES = 30;

/**
 * One tab's frame table changes one event at a time.
 *
 * A page with several cross-origin embeds attaches them in one burst, and each
 * `onAttached` is a read-modify-write of the same key: unserialised, the last
 * writer won and the others' frames vanished from the table — the embed was on
 * screen and the snapshot had no nodes for it. Storage only inside; the CDP
 * call for the frame's own children goes out after the lock is released.
 */
const chains = new Map();
function exclusive(tabId, fn) {
  const run = (chains.get(tabId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(tabId, tail);
  tail.then(() => {
    if (chains.get(tabId) === tail) chains.delete(tabId);
  });
  return run;
}

/**
 * Start attaching to cross-origin children of this tab.
 *
 * Safe to call repeatedly: `setAutoAttach` is idempotent, and the session table
 * is rebuilt from the events rather than accumulated blindly.
 */
export async function watch(tabId) {
  await send(tabId, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  await exclusive(tabId, async () => {
    const existing = await stateOf(tabId);
    if (!existing) await session().set({ [KEY(tabId)]: { sessions: {}, at: Date.now() } });
  });
  return { watching: true };
}

/**
 * Record a child target the browser just attached us to.
 *
 * Called from the service worker's event router on `Target.attachedToTarget`.
 * Only iframes are kept: workers and service workers are also children, and a
 * snapshot that tried to walk a worker would be looking for a DOM that does not
 * exist there.
 */
export async function onAttached(tabId, params) {
  const info = params?.targetInfo;
  if (!info || info.type !== 'iframe') return;

  const added = await exclusive(tabId, async () => {
    const state = (await stateOf(tabId)) ?? { sessions: {}, at: Date.now() };
    if (Object.keys(state.sessions).length >= MAX_FRAMES) return false;
    state.sessions[params.sessionId] = {
      sessionId: params.sessionId,
      targetId: info.targetId,
      url: info.url ?? '',
      at: Date.now(),
    };
    await session().set({ [KEY(tabId)]: state });
    return true;
  });
  if (!added) return;

  // Not recursive: this frame's own children need their own call, or an iframe
  // nested inside this one stays invisible for exactly the original reason.
  await send(tabId, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  }, { sessionId: params.sessionId }).catch(() => {});
}

/** Forget a child target that went away. */
export async function onDetached(tabId, params) {
  await exclusive(tabId, async () => {
    const state = await stateOf(tabId);
    if (!state?.sessions?.[params?.sessionId]) return;
    delete state.sessions[params.sessionId];
    await session().set({ [KEY(tabId)]: state });
  });
}

/**
 * There is deliberately no `offsetOf` here.
 *
 * An earlier version measured where each frame sat in the top-level page so a
 * click could be translated into top-level coordinates. Two versions of that
 * arithmetic were wrong in opposite directions — a stale offset put the point
 * off-screen, a live one still missed — before the simpler answer turned up:
 * the frame's session accepts `Input` commands in ITS OWN space, so nothing
 * needs converting. See interact.js.
 *
 * Recorded because the removed code looked obviously necessary, and the next
 * person to hit a mis-aimed click in a frame will reach for it again.
 */

/** Every cross-origin frame currently attached on this tab. */
export async function list(tabId) {
  const state = await stateOf(tabId);
  return Object.values(state?.sessions ?? {});
}

export async function clear(tabId) {
  await exclusive(tabId, () => session().remove(KEY(tabId)));
}

async function stateOf(tabId) {
  const stored = await session().get(KEY(tabId));
  return stored[KEY(tabId)] ?? null;
}
