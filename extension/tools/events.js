/**
 * The CDP event fan-out — what used to be the event half of sw.js.
 *
 * Both engines wire the same three functions: sw.js against
 * `chrome.debugger`/`chrome.tabs` (platform-extension), the daemon's Engine 2
 * runtime against a launched browser (platform-cdp). Events are ingested
 * continuously so that console, network, recorder input and dialogs are
 * already buffered when an agent asks — a tool that only listened while it ran
 * would miss everything that happened between calls.
 *
 * Every handler here reports its own failure and never throws into the event
 * source: one broken consumer must not stop the others (a paused request that
 * nobody answers hangs the tab; a dialog nobody records blocks every call).
 */

import { platform } from '../lib/platform.js';
import { getState, setState, updateState, logActivity, broadcast, noteDialog, forgetDialog } from '../lib/state.js';
import { sendOnLiveSession, forgetTab, forgetAttached } from '../lib/cdp.js';
import { clearRefs } from '../lib/refs.js';
import * as frames from '../lib/frames.js';
import * as world from '../lib/world.js';
import * as screencast from '../lib/screencast.js';
import * as pointer from '../lib/pointer.js';
import * as observe from './observe.js';
import * as record from './record.js';
import * as netpin from './netpin.js';
import * as issues from './issues.js';
import { hooks } from './index.js';

const report = (what) => (err) => console.error(`[G9BrowserAgent] ${what} failed`, err);

/** Per-tab session-storage keys that die with the tab. Refs and buffers have their own owners. */
const TAB_KEYS = (tabId) => [
  `netpin:${tabId}`,
  `netrules:${tabId}`,
  `downloads:${tabId}`,
  `emulate-ua:${tabId}`,
];

/**
 * One CDP event from an attached tab. `source.sessionId` is set when it came
 * from a CHILD session (a cross-origin iframe or a worker), absent for the page.
 */
export function onCdpEvent(source, method, params = {}) {
  const tabId = source?.tabId;
  if (tabId == null) return;
  const child = source.sessionId ?? null;

  // Capture failures used to be swallowed here, which meant a full storage
  // quota silently stopped console and network capture while the agent went on
  // believing the buffers were complete. Report it — a red line in the console
  // is the honest outcome.
  observe.ingest(tabId, method, params).catch(report(`event capture (${method})`));

  // The recorder speaks through a Runtime binding rather than a content script:
  // injected before the page's own code, surviving navigation, over the
  // debugger session already open (and, in v2, bound in G9BrowserAgent's isolated world).
  if (method === 'Runtime.bindingCalled' && params.name === record.BINDING) {
    try {
      record.ingestRaw(tabId, JSON.parse(params.payload)).catch(() => {});
    } catch {
      /* a malformed payload is one lost event, not a broken recording */
    }
  }

  // One screencast per tab, shared by the issue video and live watchers.
  // screencast.onFrame acks and fans out; if it ever fails, ack here anyway —
  // Chromium sends the next frame only after this one is acknowledged.
  if (method === 'Page.screencastFrame' && !child) {
    const unstick = (err) => {
      report('screencast frame')(err);
      sendOnLiveSession(tabId, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    };
    try {
      Promise.resolve(screencast.onFrame(tabId, params)).catch(unstick);
    } catch (err) {
      unstick(err);
    }
  }

  // A cross-origin iframe is a separate target in a separate process, so the
  // only way to reach it is to be told when it attaches. Without this the frame
  // is visible in the page and has no nodes anyone can click.
  if (method === 'Target.attachedToTarget') {
    frames.onAttached(tabId, params).catch(report('frame attach'));
  }
  if (method === 'Target.detachedFromTarget') {
    frames.onDetached(tabId, params).catch(report('frame detach'));
    if (params.sessionId) world.invalidate(tabId, params.sessionId);
  }

  // A paused request is a request the page is WAITING on. Every branch inside
  // onRequestPaused answers it; if this handler ever throws before one of them
  // runs, the tab hangs — so the failure path continues the request rather than
  // only logging. A child session's pause is answered on that session.
  if (method === 'Fetch.requestPaused') {
    if (child) {
      sendOnLiveSession(tabId, 'Fetch.continueRequest', { requestId: params.requestId }, child).catch(() => {});
    } else {
      netpin.onRequestPaused(tabId, params).catch((err) => {
        report('pinned-network interception')(err);
        sendOnLiveSession(tabId, 'Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      });
    }
  }

  // A committed navigation invalidates every element ref for that tab, G9BrowserAgent's
  // isolated world in it, and everything captured for the document we just
  // left. Pruning here as well as in navigate.js is what closes the gap: the
  // outgoing page keeps emitting until the new one commits, so a
  // pre-navigation clear alone leaves residue.
  if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) {
    if (!child) {
      clearRefs(tabId).catch(() => {});
      observe.pruneToLoader(tabId, params.frame.loaderId).catch(() => {});
      world.invalidate(tabId);
      // A new document cannot report the navigation that created it — the
      // script that would have emitted the event went away with the old page.
      record.ingestRaw(tabId, { type: 'navigate', at: Date.now(), url: params.frame.url }).catch(() => {});
    } else {
      world.invalidate(tabId, child);
    }
  }

  // Surface dialogs immediately — they block the page until handled.
  if (method === 'Page.javascriptDialogOpening' && !child) {
    const dialog = { tabId, type: params.type, message: params.message };
    noteDialog(dialog).catch(() => {});
    broadcast({ type: 'dialog', tabId, message: params.message, dialogType: params.type });
    emit('dialog', dialog);
  }

  if (method === 'Page.javascriptDialogClosed' && !child) {
    forgetDialog(tabId).catch(() => {});
    emit('dialogClosed', { tabId });
  }
}

/** The debugger let go of a tab (it closed, the user cancelled the banner, DevTools took it). */
export async function onDetach(source, reason) {
  const tabId = source?.tabId;
  if (tabId == null) return;
  // Everything tied to the dead session is dropped BEFORE the first await: the
  // next tool call may re-attach at once, and its fresh frames, world and
  // domains must not be wiped by cleanup that was still in flight.
  world.invalidate(tabId);
  forgetTab(tabId);
  // The session is gone, so is any screencast on it. Forget without CDP
  // traffic: talking to the tab now would only re-attach it.
  screencast.forget(tabId);
  // Every child (cross-origin frame) session died with the page's. The next
  // attach re-attaches the frames under NEW session ids; the old ones would
  // only send a snapshot into sessions that no longer exist. (Queued now, on
  // the frame table's own lock, so it lands ahead of any re-attach's frames.)
  const framesCleared = frames.clear(tabId).catch(() => {});
  await issues.cancelVideo(tabId).catch(() => {});
  await framesCleared;
  // Read and written as one step (lib/state.js updateState): a concurrent attach must not be lost.
  // Its capture start time (attachedSince) goes too: a re-attach starts a new capture.
  const state = await updateState((s) => forgetAttached(s, [tabId]));
  await logActivity({ kind: 'detach', tabId, ok: false, detail: reason });
  if (tabId === state.currentTabId) {
    broadcast({ type: 'detached', tabId, reason });
  }
}

/**
 * A tab is gone. Everything keyed by its id goes with it — nothing else
 * reclaims those keys, and on a long day they are a leak and a way to walk into
 * the session-storage quota.
 */
export async function onTabRemoved(tabId) {
  await issues.cancelVideo(tabId).catch(() => {});
  world.invalidate(tabId);
  forgetTab(tabId);
  screencast.forget(tabId);
  await pointer.forget(tabId).catch(() => {});
  await platform.downloads.end(tabId).catch(() => {});

  // One read-modify-write step (lib/state.js updateState): computed from the state it writes, so a
  // concurrent attach or session write is never undone by a stale copy.
  let wasCurrent = false;
  let forgotten = [];
  await updateState((state) => {
    wasCurrent = state.currentTabId === tabId;
    forgotten = Object.keys(state.sessions ?? {}).filter((name) => state.sessions[name] === tabId);
    const patch = {};
    if (wasCurrent) patch.currentTabId = null;
    if (forgotten.length) patch.sessions = Object.fromEntries(Object.entries(state.sessions ?? {}).filter(([, id]) => id !== tabId));
    if (state.attachedTabs.includes(tabId) || (state.attachedSince ?? {})[tabId] != null) Object.assign(patch, forgetAttached(state, [tabId]));
    return Object.keys(patch).length ? patch : null;
  });
  // A closed tab's dialog is gone with it (another tab's stays in force).
  await forgetDialog(tabId).catch(() => {});
  if (wasCurrent || forgotten.length) {
    await logActivity({
      kind: 'system',
      tabId,
      ok: false,
      detail: `Tab ${tabId} was closed` +
        (wasCurrent ? ' (it was the current tab)' : '') +
        (forgotten.length ? `; session ${forgotten.map((n) => `"${n}"`).join(', ')} forgotten` : ''),
    });
  }

  await clearRefs(tabId).catch(() => {});
  // Console and network buffers are keyed by tabId and nothing else reclaims
  // them; without this they sat in session storage until the browser closed.
  await observe.clearBuffers(tabId).catch(() => {});
  await frames.clear(tabId).catch(() => {});
  await platform.storage.session.remove(TAB_KEYS(tabId)).catch(() => {});
}


function emit(event, data) {
  try {
    hooks.emit?.(event, data);
  } catch {
    /* a transport hook must never break event ingestion */
  }
}
