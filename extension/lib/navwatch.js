/**
 * (3.6) Did an action take the page somewhere else?
 *
 * A click on what looked like a button was a link: the page navigated, the agent did not notice,
 * and its next steps acted on the wrong page (field report). browser_interact now says so in its
 * result (`navigated: { url, sameDocument }`), and with `expectSamePage:true` it is an error
 * (code `navigated`) instead.
 *
 * The top frame's navigation events since a mark, per tab: `Page.frameRequestedNavigation` (a link,
 * a form, a script asked — fired while the input is handled, so before the click's answer),
 * `Page.frameStartedNavigating`, `Page.frameNavigated` (committed) and `Page.navigatedWithinDocument`
 * (a single-page app's route change). Only a change of URL apart from its #fragment counts.
 * Lazy: subscribes on first use; on a platform without events nothing is ever reported.
 */

import { platform } from './platform.js';
import { send } from './cdp.js';

const MAX_EVENTS = 20;
/** tabId → [{ seq, url, sameDocument }] */
const byTab = new Map();
let seq = 0;
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  try {
    platform.debugger.onEvent((source, method, params) => {
      if (source?.tabId == null || source.sessionId) return;
      let url = null;
      let sameDocument = false;
      if (method === 'Page.frameRequestedNavigation' || method === 'Page.frameStartedNavigating') {
        if (params?.frameId && isTop(source.tabId, params.frameId)) url = params.url;
      } else if (method === 'Page.frameNavigated') {
        if (params?.frame && !params.frame.parentId) {
          tops.set(source.tabId, params.frame.id);
          url = params.frame.url;
        }
      } else if (method === 'Page.navigatedWithinDocument') {
        if (params?.frameId && isTop(source.tabId, params.frameId)) {
          url = params.url;
          sameDocument = true;
        }
      }
      if (!url) return;
      const list = byTab.get(source.tabId) ?? [];
      list.push({ seq: ++seq, url: String(url), sameDocument });
      if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
      byTab.set(source.tabId, list);
    });
  } catch {
    /* no event source here (a unit test without a debugger) */
  }
}

/** tabId → the top frame's id (from Page.getFrameTree at the first mark, then from commits). */
const tops = new Map();
function isTop(tabId, frameId) {
  return tops.get(tabId) === frameId; // unknown: not counted — an iframe's navigation is not the page's
}

/** Start watching a tab's navigations; resolves a mark for `since`. Never throws. */
export async function mark(tabId) {
  listen();
  if (!tops.has(tabId)) {
    const tree = await send(tabId, 'Page.getFrameTree').catch(() => null);
    if (tree?.frameTree?.frame?.id) tops.set(tabId, tree.frameTree.frame.id);
  }
  return { tabId, seq };
}

const strip = (u) => String(u ?? '').split('#')[0];

/**
 * The navigation since `m` that left `fromUrl` (fragment ignored), or null. The last such event
 * wins: a redirect chain reports where it went. Pure over what was recorded.
 */
export function since(m, fromUrl) {
  const list = byTab.get(m?.tabId) ?? [];
  let found = null;
  for (const e of list) {
    if (e.seq <= m.seq) continue;
    if (strip(e.url) === strip(fromUrl) || e.url === 'about:blank') continue;
    found = e;
  }
  return found ? { url: found.url, sameDocument: found.sameDocument } : null;
}

/** For tests: name a tab's top frame, and record an event as if the browser sent it. */
export function _top(tabId, frameId) {
  tops.set(tabId, frameId);
}
export function _record(tabId, url, sameDocument = false) {
  const list = byTab.get(tabId) ?? [];
  list.push({ seq: ++seq, url, sameDocument });
  byTab.set(tabId, list);
}
