/**
 * Service worker: Engine 1's host.
 *
 * In v2 the tools themselves live in tools/index.js (shared with the daemon's
 * launched engines) and the CDP event fan-out in tools/events.js. What stays
 * here is what only an extension has:
 *   1. Lifecycle — install/update, the heartbeat, auto-attach.
 *   2. The transport to the G9 daemon — `call` messages become runTool calls,
 *      halts and reloads are applied, frames are streamed to watchers.
 *   3. The side panel's commands.
 *
 * MV3 rule that shapes everything here: the worker can die at any moment.
 * No module-level variable is a source of truth — storage is. And every
 * listener that must be able to WAKE the worker is registered synchronously,
 * at the top level, while this module evaluates.
 */

import { platform } from './lib/platform.js';
import {
  getState, setState, updateState, logActivity, clearActivity, migrateLegacySettings, getAbout, setAbout, broadcast,
  autoAttachMode, AUTO_ATTACH_MODES,
} from './lib/state.js';
import * as transport from './lib/transport.js';
import { attach, detachAll, applyStealthLevel, runtimeEnabledTabs, asPerson } from './lib/cdp.js';
import { hostMatches, siteOf } from './lib/sites.js';
import { importFlow, approvedBundle } from './lib/flowsync.js';
import { approvedAtFor } from './lib/approved.js';
import * as screencast from './lib/screencast.js';
import * as pointer from './lib/pointer.js';
import { toFlowSpec, canonicalJson, validateFlowSpec } from './lib/flowspec.js';
import * as store from './lib/store.js';

import { runTool, setHooks, status } from './tools/index.js';
import { onCdpEvent, onDetach, onTabRemoved } from './tools/events.js';
import * as tabsTool from './tools/tabs.js';
import * as record from './tools/record.js';
import * as replay from './tools/replay.js';
import * as issues from './tools/issues.js';
import * as qa from './tools/qa.js';
import * as navigate from './tools/navigate.js';

const api = globalThis.browser ?? globalThis.chrome;

/** Matches the slice in panel.js renderLog(). Keep the two in step. */
const PANEL_ACTIVITY_LIMIT = 120;

const INPUT_MODES = new Set(['off', 'human', 'stealth']);

// ------------------------------------------------------------- the runtime

setHooks({
  connection: () => ({
    connected: transport.isConnected(),
    reconnecting: transport.isReconnectPending(),
  }),
  // Everything a tool module emits ('dialog', 'activity', 'download', …) goes
  // to the daemon as an engine event. A disconnected transport drops it, which
  // is right: the daemon reads current state on reconnect.
  emit: (event, data) => {
    transport.send({ type: 'event', event, data });
  },
});

// (3.2) An approval made in this browser (the panel's Approve, an agent's approve) travels with the
// flow: written beside it in whichever repository holds it. Not in the repository yet is normal.
replay.onApproved(async (id) => {
  const bundle = await approvedBundle(id);
  if (!bundle) return null;
  if (!transport.isConnected()) {
    return { written: false, reason: 'the daemon is not connected; push the flow later and its approval goes with it' };
  }
  const result = await transport.flowLib('writeApproved', { flowId: bundle.flowId, approved: bundle.approved, images: bundle.images }, { timeoutMs: 15_000 });
  if (result?.written) await logActivity({ kind: 'system', ok: true, detail: `Approval written to the repository: ${result.file}` });
  return result;
});

// CDP events, detaches and closed tabs — the same three functions the daemon
// wires for its launched engines.
platform.debugger.onEvent(onCdpEvent);
platform.debugger.onDetach((source, reason) => {
  onDetach(source, reason).catch((err) => console.error('[G9] detach handling failed', err));
});
platform.tabs.onRemoved((tabId) => {
  // Closing a recording tab ends that recording: a deferred update may go ahead now.
  onTabRemoved(tabId).catch((err) => console.error('[G9] tab cleanup failed', err)).finally(() => maybeReload().catch(() => {}));
  // A watched tab that closed: drop the pointer stream (events.js already
  // forgot the screencast, without talking to a tab that no longer exists).
  watchers.get(tabId)?.();
  watchers.delete(tabId);
  unblock(tabId).catch(() => {});
  scheduleTabsEvent();
});
platform.tabs.onCreated((tab) => {
  autoAttachTab(tab).catch(() => {});
  scheduleTabsEvent();
});
platform.tabs.onUpdated((tabId, change, tab) => {
  if (change.url || change.status === 'complete') autoAttachTab(tab).catch(() => {});
  if (change.url || change.title || change.status) scheduleTabsEvent();
});

// Which ordinary browser window the user was last in.
//
// Needed because the agent's own surfaces are windows too. With the panel popped
// out, `lastFocusedWindow` is the PANEL, and every tool call then reported that
// no tab was focused while the user was looking straight at one. See
// tools/tabs.js `getActiveTab`.
platform.windows.onFocusChanged((windowId) => {
  tabsTool.rememberFocus(windowId).catch(() => {});
  // A focused window shows its active tab: an agent blocked on it can drive it now.
  unblockShownIn(windowId).catch(() => {});
});
// The same when a tab becomes the active one of its window (platform.tabs has no onActivated: the
// seam never needed it, and this is the extension's own panel bookkeeping, not a tool's).
api.tabs.onActivated?.addListener?.(({ tabId, windowId }) => {
  unblockIfShown(tabId, windowId).catch(() => {});
});

transport.onMessage(handleDaemonMessage);

// ------------------------------------------------------------------ lifecycle

api.runtime.onStartup.addListener(() => {
  bootstrap();
});
api.runtime.onInstalled.addListener((details) => {
  onInstalled(details).catch((err) => console.error('[G9] install handling failed', err));
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'g9-heartbeat') return;
  // Only step in when the backoff cycle is NOT already handling it. The alarm
  // exists to revive a worker that was torn down mid-backoff (its timers die
  // with it); firing alongside a live backoff just doubles the failed attempts
  // the browser logs to the extension error console.
  //
  // After bootstrap, always: an alarm that wakes the worker is dispatched while
  // bootstrap is still reading dev-daemon.json, and connecting ahead of it
  // would reach the stored address instead of the override (see below).
  bootstrap().then(() => {
    if (!transport.isConnected() && !transport.isReconnectPending()) transport.connect();
  });
});

/**
 * A daemon address baked into the bundle, for disposable test profiles.
 *
 * A freshly installed extension has no stored settings, so `bootstrap()`
 * connects to the default 8765 on its very first line — before any harness can
 * possibly configure it. v1's bridge accepted one client and let the newest
 * win, so spinning up a throwaway profile SILENTLY TOOK OVER whatever real agent
 * session was running on that port. `setup/isolated-livetest.mjs` did exactly
 * that to the developer's own session during the v1.4.0 audit.
 *
 * Nothing the harness does after launch can close that window, so the address
 * has to be present BEFORE the first line runs. `dev-daemon.json` (v2 name,
 * preferred) or `dev-bridge.json` (v1 name) is written into a COPY of this
 * directory by the harness; both are absent from the real extension, where
 * this is two failed fetches at startup and nothing else.
 */
async function applyDevOverride() {
  for (const file of ['dev-daemon.json', 'dev-bridge.json']) {
    try {
      const response = await fetch(api.runtime.getURL(file));
      if (!response.ok) continue;
      const config = await response.json();
      if (!Number.isInteger(config.port)) continue;
      await setState({ bridge: { host: config.host ?? '127.0.0.1', port: config.port } });
      console.log(`[G9] dev daemon override (${file}) active:`, config.host ?? '127.0.0.1', config.port);
      return config;
    } catch {
      /* the normal case: this is not a test build */
    }
  }
  return null;
}

let booting = null;

/** Once per worker lifetime, however many of module-eval/onStartup/onInstalled ask. */
function bootstrap() {
  if (!booting) {
    booting = doBootstrap().catch((err) => {
      booting = null;
      console.error('[G9] bootstrap failed', err);
    });
  }
  return booting;
}

async function doBootstrap() {
  try {
    await api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    /* Edge versions before 114 have no sidePanel; the action click still works */
  }
  // The version on the toolbar button's tooltip: the fastest way for anyone to
  // confirm which build a browser is actually running after a reload.
  try {
    await api.action.setTitle({ title: `G9 Browser Agent v${platform.runtime.version()}` });
  } catch {
    /* cosmetic */
  }

  // v1 left `mode` and friends in storage.local. Removing them is logged rather
  // than silent: changing someone's stored settings under them is something
  // they are entitled to see. First, because the override below rewrites the
  // settings key, and a rewrite would drop `mode` without the log line.
  const migration = await migrateLegacySettings().catch(() => null);
  if (migration) await logActivity({ kind: 'system', ok: true, detail: migration });

  // Before connect(), never after — see applyDevOverride.
  await applyDevOverride();

  // A reload the G9 app asked for: said in the new session, whose log the reload emptied.
  const about = await getAbout().catch(() => ({}));
  if (about.lastReload) {
    const at = new Date(about.lastReload.at).toLocaleTimeString([], { hour12: false });
    await logActivity({ kind: 'system', ok: true, detail: `Reloaded at ${at} (${about.lastReload.reason ?? 'update from the G9 app'}).` }).catch(() => {});
    await setAbout({ lastReload: null }).catch(() => {});
  }

  transport.connect();
  // A heartbeat alarm resurrects the worker if it was torn down while the
  // daemon was unreachable, so the connection re-establishes on its own.
  api.alarms.create('g9-heartbeat', { periodInMinutes: 0.5 });
  // A reload deferred by a worker that has since been stopped (storage.session survives that).
  maybeReload().catch(() => {});

  const state = await getState();
  if (state.autoAttach !== 'off') attachAllEligible().catch(() => {});
}

/**
 * First install: the welcome page. An update to a DIFFERENT version: the same
 * page with `?updated=1`, reusing an open one rather than stacking a second.
 * A reload of the same version (unpacked development, or the desktop app
 * refreshing identical files) opens nothing — a tab on every reload is noise.
 *
 * (3.2) An extension loaded with --load-extension (the browser node, docker/) is
 * reported as "install" on EVERY browser start, while its storage survives. So an
 * "install" that finds a version already recorded is a restart: the same version
 * opens nothing, another version is an update. A real first install (or a reinstall,
 * which wipes storage) has none.
 */
async function onInstalled(details) {
  await bootstrap();
  const version = platform.runtime.version();
  const about = await getAbout();

  if (details.reason === 'install' && !about.lastSeenVersion) {
    await setAbout({ lastSeenVersion: version, installedAt: Date.now() });
    // (3.2) The browser node's image says so in deployment.json: Chromium wipes a command-line
    // extension's storage and installs it again on every start, so each start is a "first install".
    if ((await readDeployment()).welcome === false) return;
    await openWelcome({ updated: false });
    return;
  }

  if (details.reason === 'update' || details.reason === 'install') {
    const previous = details.previousVersion ?? about.lastSeenVersion ?? null;
    if (previous && previous !== version) {
      await setAbout({ previousVersion: previous, updatedAt: Date.now(), lastSeenVersion: version });
      await logActivity({ kind: 'system', ok: true, detail: `Updated from v${previous} to v${version}.` });
      await openWelcome({ updated: true });
    } else if (about.lastSeenVersion !== version) {
      await setAbout({ lastSeenVersion: version });
    }
  }
}

/**
 * (3.2) `deployment.json` beside the manifest: written by an image that ships the extension (the
 * browser node, docker/), absent everywhere else — then this is one failed fetch and `{}`.
 */
async function readDeployment() {
  try {
    const response = await fetch(api.runtime.getURL('deployment.json'));
    return response.ok ? await response.json() : {};
  } catch {
    return {};
  }
}

let welcomeBusy = Promise.resolve();

/** Open the welcome page, or focus and reload the one already open — never a second one. */
function openWelcome({ updated }) {
  welcomeBusy = welcomeBusy.then(async () => {
    const base = api.runtime.getURL('panel/welcome.html');
    const url = updated ? `${base}?updated=1` : base;
    const open = (await api.tabs.query({}).catch(() => []))
      .filter((t) => String(t.url || t.pendingUrl || '').startsWith(base));
    if (!open.length) {
      await api.tabs.create({ url, active: true });
      return;
    }
    const [keep, ...extra] = open;
    if ((keep.url || keep.pendingUrl) === url) await api.tabs.reload(keep.id);
    else await api.tabs.update(keep.id, { url });
    await api.tabs.update(keep.id, { active: true }).catch(() => {});
    if (keep.windowId != null) await api.windows.update(keep.windowId, { focused: true }).catch(() => {});
    for (const tab of extra) await api.tabs.remove(tab.id).catch(() => {});
  }).catch((err) => console.error('[G9] could not open the welcome page', err));
  return welcomeBusy;
}

// ---------------------------------------------------------------- auto-attach

const REPORTED_KEY = 'g9:autoattach:reported';

/** How the panel and the activity log name each auto-attach mode. */
const AUTO_ATTACH_LABEL = { off: 'Off', project: 'Project sites', all: 'All tabs' };

/**
 * Attach a tab when auto-attach says so (v3: 'off' | 'project' | 'all'). Called on startup, on
 * creation, on every navigation and whenever the project sites change. Quiet on success, one line
 * per ineligible kind of page.
 *
 * 'project' attaches only a connected agent's project sites (state.projectDomains, the daemon's
 * `projects` push) and, with none known, nothing. It is a filter on what G9 CAPTURES by itself,
 * never on what can be reached (v2 D6/D7 stand: a tab attached by hand or by an agent is attached,
 * and every tab stays reachable) — so nothing here ever detaches a tab, whatever the mode or the
 * domains become.
 */
async function autoAttachTab(tab) {
  if (!tab || tab.id == null) return;
  const state = await getState();
  const mode = state.autoAttach;
  if (mode === 'off' || state.halted) return;
  const url = tab.url || tab.pendingUrl || '';
  if (!url) return; // nothing to judge yet; the URL arrives with onUpdated
  if (!tabsTool.isAttachable(url)) {
    // Only "All tabs" promised every tab; a browser page is never a project site.
    if (mode === 'all') await reportIneligible(url);
    return;
  }
  if (mode === 'project' && !hostMatches(url, state.projectDomains)) return;
  if (state.attachedTabs.includes(tab.id)) return;
  try {
    await attach(tab.id);
  } catch (err) {
    await logActivity({ kind: 'attach', tabId: tab.id, ok: false, detail: `auto-attach: ${err.message}` });
  }
}

/** "edge://newtab", "chrome://settings", the store… reported once each per browser session, not per tab. */
async function reportIneligible(url) {
  let kind;
  try {
    const u = new URL(url);
    kind = u.host ? `${u.protocol}//${u.host}` : u.protocol;
  } catch {
    kind = String(url).slice(0, 40);
  }
  const stored = await platform.storage.session.get(REPORTED_KEY);
  const seen = stored[REPORTED_KEY] ?? [];
  if (seen.includes(kind)) return;
  await platform.storage.session.set({ [REPORTED_KEY]: [...seen, kind].slice(-100) });
  await logActivity({
    kind: 'system',
    ok: false,
    detail: `Auto-attach skipped ${kind}: the browser does not let any debugger attach to its own pages or the extension store.`,
  });
}

async function attachAllEligible() {
  const tabs = await platform.tabs.query({}).catch(() => []);
  for (const tab of tabs) await autoAttachTab(tab).catch(() => {});
}

/**
 * The daemon's `{type:'projects'}` (DAEMON_PROTOCOL §5): the connected agents' project sites.
 * Stored as projectDomains/projects; when the domains changed and auto-attach is "Project sites",
 * every open tab is judged again (tabs that no longer match are left as they are — never detached).
 */
async function onProjects(msg) {
  const domains = [...new Set((Array.isArray(msg.domains) ? msg.domains : []).filter((d) => typeof d === 'string' && d))];
  const projects = Array.isArray(msg.projects) ? msg.projects.filter((p) => p && typeof p === 'object') : [];
  let changed = false;
  const next = await updateState((s) => {
    const was = [...(s.projectDomains ?? [])].sort().join('\n');
    changed = was !== [...domains].sort().join('\n');
    return { projectDomains: domains, projects };
  });
  if (changed && next.autoAttach === 'project') await attachAllEligible();
}

// ------------------------------------------------------ an agent blocked by a hidden tab

/**
 * (v3, U3) An agent's input failed because its tab is HIDDEN — the one failure the panel's
 * Pop out and Send to background exist for. They used to demand foresight; now the moment is
 * recorded in state.blocked (a panel opened later still sees it) and announced as
 * {type:'agentBlocked'} for a toast that offers them. Only calls the daemon relayed (an agent's):
 * the person acting in the panel can see their own tab.
 */
async function noteBlocked(tabId, caller, tool, err) {
  let entry = null;
  await updateState(async (s) => {
    const tab = await platform.tabs.get(tabId).catch(() => null);
    if (!tab) return null; // closed meanwhile: nothing left to offer
    // Shown again before this ran (the person switched to it): no stale toast.
    if (tab.active && (await shownWindow(tab.windowId))) return null;
    entry = {
      tabId,
      agent: { id: caller?.agentId ?? null, name: caller?.name ?? null },
      reason: 'hidden',
      at: Date.now(),
      title: tab.title ?? '',
      url: tab.url ?? '',
      tool,
      delivery: err?.delivery ?? null,
    };
    return { blocked: { ...(s.blocked ?? {}), [tabId]: entry } };
  });
  if (entry) broadcast({ type: 'agentBlocked', ...entry });
}

/** The tab is no longer blocked (shown, popped out, handed off, closed, or input reached it). */
async function unblock(tabId) {
  if (tabId == null) return;
  let had = false;
  await updateState((s) => {
    if (!s.blocked?.[tabId]) return null;
    had = true;
    const blocked = { ...s.blocked };
    delete blocked[tabId];
    return { blocked };
  });
  if (had) broadcast({ type: 'agentUnblocked', tabId });
}

/** A focused, not minimized window: its active tab is visible. */
async function shownWindow(windowId) {
  if (windowId == null) return false;
  const win = await platform.windows.get(windowId).catch(() => null);
  return !!win?.focused && win.state !== 'minimized';
}

async function unblockIfShown(tabId, windowId) {
  const { blocked } = await getState();
  if (!blocked?.[tabId]) return;
  if (await shownWindow(windowId)) await unblock(tabId);
}

async function unblockShownIn(windowId) {
  if (windowId == null || windowId === platform.windows.WINDOW_ID_NONE) return;
  const { blocked } = await getState();
  if (!Object.keys(blocked ?? {}).length) return;
  const [active] = await platform.tabs.query({ active: true, windowId }).catch(() => []);
  if (active) await unblockIfShown(active.id, windowId);
}

/**
 * What a relayed call's outcome says about a blocked tab: a hidden refusal blocks it; input that
 * landed (browser_interact succeeded), or the agent moving it into view or away (popout, focus,
 * handoff_export), clears it. Runs after the result is sent, so it never delays an answer.
 */
function afterRelayedCall(tool, args, caller, err) {
  const tabId = Number.isInteger(args?.tabId) ? args.tabId : null;
  if (tabId == null) return;
  if (err) {
    if (err.hidden === true) noteBlocked(tabId, caller, tool, err).catch(() => {});
    return;
  }
  if (tool === 'browser_interact' || (tool === 'browser_tabs' && ['popout', 'focus', 'handoff_export'].includes(args.action))) {
    unblock(tabId).catch(() => {});
  }
}

/** Blocked entries of agents the daemon no longer lists (disconnected, or a restarted daemon's numbering). */
async function pruneBlocked(agents) {
  const live = new Set(agents.map((a) => a?.id));
  const gone = [];
  await updateState((s) => {
    const entries = Object.entries(s.blocked ?? {});
    const keep = entries.filter(([, e]) => live.has(e?.agent?.id));
    if (keep.length === entries.length) return null;
    for (const [id, e] of entries) if (!live.has(e?.agent?.id)) gone.push(e?.tabId ?? Number(id));
    return { blocked: Object.fromEntries(keep) };
  });
  for (const tabId of gone) broadcast({ type: 'agentUnblocked', tabId });
}

// ------------------------------------------------------------ tab list events

let tabsTimer = null;

/**
 * Tell the daemon the tab list changed. Coalesced: a page load fires a burst of
 * onUpdated events (loading, title, favicon, complete), and one list 250ms
 * after the first of them says everything the burst did.
 */
function scheduleTabsEvent() {
  if (tabsTimer || !transport.isConnected()) return;
  tabsTimer = setTimeout(async () => {
    tabsTimer = null;
    try {
      transport.send({ type: 'event', event: 'tabs', data: { tabs: await tabsTool.listTabs() } });
    } catch {
      /* the next change sends a fresh list */
    }
  }, 250);
}

// ------------------------------------------------------------ daemon protocol

let inFlight = 0;
/** The side panel's own long operations (a replay, a calibration, an issue recapture) running now. */
let panelOps = 0;
const PANEL_LONG_OPS = new Set(['recReplay', 'recCalibrate', 'issueRecapture', 'issueCreate', 'issueShot', 'recStop', 'videoStart', 'videoStop', 'recordNow']);
/**
 * An update reload the G9 app asked for and that has not happened yet. In storage.session, not a
 * variable: MV3 stops an idle worker after ~30 s, and a reload deferred behind a long recording
 * would otherwise die with it — the daemon never asks twice. The reload itself clears it.
 */
const RELOAD_KEY = 'g9:reloadPending';
/** Daemon call id → AbortController: the daemon cancels a call that ran past its deadline ({type:'cancel'}). */
const callControllers = new Map();

/**
 * What must not be interrupted by a reload. chrome.runtime.reload() CLEARS storage.session — the
 * in-progress recording's steps, an issue video session, download watches, the activity log —
 * measured, Edge 153, 2026-09-22: session {} after the reload, local kept. Waiting only for daemon
 * calls lost a QA's recording to an app update (extension review, 2026-09-22). → reasons, or [].
 */
async function reloadBlockers() {
  const reasons = [];
  if (inFlight > 0) reasons.push(`${inFlight} agent call(s) running`);
  if (panelOps > 0) reasons.push('a side-panel operation running');
  const recording = await record.recordingTabs().catch(() => []);
  if (recording.length) reasons.push(`the recording on tab ${recording.map((r) => r.tabId).join(', ')} (Stop and save it)`);
  let keys = [];
  try {
    keys = typeof platform.storage.session.getKeys === 'function'
      ? await platform.storage.session.getKeys()
      : Object.keys(await platform.storage.session.get(null));
  } catch { keys = []; }
  if (keys.some((k) => k.startsWith('g9:screencast:'))) reasons.push('an issue video being recorded');
  if (keys.some((k) => k.startsWith('g9:replaying:'))) reasons.push('a replay running');
  return reasons;
}

let reloading = false;

/**
 * Reload only when nothing is running (reloadBlockers). A deferred reload is announced once per
 * reason — in the activity log and to the daemon (`reloadDeferred`) — and tried again whenever a
 * call or a panel operation ends, a tab closes, and at every worker start.
 */
async function maybeReload() {
  if (reloading) return;
  let pending = null;
  try {
    pending = (await platform.storage.session.get(RELOAD_KEY))[RELOAD_KEY] ?? null;
  } catch { pending = null; }
  if (!pending) return;
  const blockers = await reloadBlockers();
  if (blockers.length) {
    const why = blockers.join('; ');
    if (pending.announced !== why) {
      await platform.storage.session.set({ [RELOAD_KEY]: { ...pending, announced: why } }).catch(() => {});
      await logActivity({ kind: 'system', ok: true, detail: `Update ready: the extension reloads once nothing is running — waiting for ${why}.` }).catch(() => {});
      transport.send({ type: 'event', event: 'reloadDeferred', data: { reasons: blockers } });
    }
    return;
  }
  if (reloading) return;
  reloading = true;
  try {
    // Written where a reload cannot erase it: the new worker logs it into its (empty) session.
    await setAbout({ lastReload: { at: Date.now(), reason: pending.reason ?? 'update from the G9 app', version: platform.runtime.version() } }).catch(() => {});
    await logActivity({ kind: 'system', ok: true, detail: 'Reloading the extension (update from the G9 app).' }).catch(() => {});
    // Cleared first: the reload empties storage.session anyway, and this way a reload that does not
    // end the worker (a test double) cannot ask again.
    await platform.storage.session.remove(RELOAD_KEY).catch(() => {});
    platform.runtime.reload();
  } finally {
    reloading = false;
  }
}

async function handleDaemonMessage(msg) {
  switch (msg?.type) {
    case 'call':
      return handleCall(msg);
    case 'halt': {
      // The daemon mirrors a global halt (the desktop's Stop, or another
      // engine's panel) into this panel. Not echoed back: the daemon already knows.
      const halted = !!msg.halted;
      const { halted: was } = await getState();
      if (was === halted) return undefined;
      await setState({ halted });
      await logActivity({ kind: 'system', ok: !halted, detail: halted ? 'Stopped from the G9 app' : 'Resumed from the G9 app' });
      return undefined;
    }
    case 'cancel':
      // The daemon gave up on this call (its deadline, a dialog on its tab, a per-agent Stop): its
      // input stops at the next step (lib/humanize.js perform), and the answer says what was sent.
      callControllers.get(msg.id)?.abort(new Error('the G9 daemon cancelled it (it ran past its deadline, or its tab or agent was stopped)'));
      return undefined;
    case 'reload':
      await platform.storage.session.set({ [RELOAD_KEY]: { at: Date.now(), reason: 'update from the G9 app' } }).catch(() => {});
      await maybeReload();
      return undefined;
    case 'agents': {
      const agents = Array.isArray(msg.agents) ? msg.agents : [];
      await setState({ agents });
      // The daemon pushes its agent list right after it welcomes this engine,
      // and the transport keeps the welcome to itself — so this is the first
      // moment the daemon can take our tab list. Debounced, so the later pushes
      // (an agent claiming a tab) cost one list at most.
      scheduleTabsEvent();
      // An agent that is gone is blocked on nothing: its toast would name someone who left.
      await pruneBlocked(agents).catch(() => {});
      return undefined;
    }
    case 'projects':
      // (v3) The connected agents' project sites, for auto-attach "Project sites" (DAEMON_PROTOCOL §5).
      await onProjects(msg);
      return undefined;
    case 'watch':
      if (msg.tabId == null) return undefined;
      return msg.on ? startWatch(msg.tabId) : stopWatch(msg.tabId);
    case 'openWatch': {
      // (3.2) An agent asked to show the person a live view of a tab (browser_tabs action:"watch").
      if (!Number.isInteger(msg.handle)) return undefined;
      const who = msg.agent?.name || msg.agent?.id || 'An agent';
      await openWatchWindow({ handle: msg.handle, agent: msg.agent ?? null, focus: msg.focus === true });
      await logActivity({ kind: 'system', ok: true, detail: `${who} opened a live view of tab ${msg.handle}${msg.engineKind === 'launched' ? ' (a launched browser)' : ''}.` });
      broadcast({ type: 'watchOpened', handle: msg.handle, agent: msg.agent ?? null, engineKind: msg.engineKind ?? null, url: msg.url ?? null });
      return undefined;
    }
    case 'closeWatch':
      if (Number.isInteger(msg.handle)) broadcast({ type: 'watchRemove', handle: msg.handle });
      return undefined;
    default:
      return undefined;
  }
}

// ------------------------------------------------------------- live view (3.2)

const WATCH_WINDOW_KEY = 'g9:watchWindow';

/** The watch window, if it is still open. */
async function watchWindowId() {
  const saved = (await platform.storage.session.get(WATCH_WINDOW_KEY).catch(() => ({})))?.[WATCH_WINDOW_KEY];
  if (!Number.isInteger(saved?.windowId)) return null;
  const win = await api.windows.get(saved.windowId).catch(() => null);
  return win ? saved.windowId : null;
}

/**
 * Open the watch window (panel/watch.html), or add a tab to the one already open. A person's own
 * press (the panel's Live view) brings it up in front. An agent's request must not take the keyboard
 * from someone typing: the window opens without focus and flashes in the taskbar, and the panel says
 * who opened it — unless the agent passed focus:true.
 */
async function openWatchWindow({ handle = null, agent = null, person = false, focus = false } = {}) {
  const inFront = person || focus;
  const existing = await watchWindowId();
  if (existing != null) {
    if (handle != null) broadcast({ type: 'watchAdd', handle, agent });
    await api.windows.update(existing, inFront ? { focused: true, drawAttention: false } : { drawAttention: true }).catch(() => {});
    return { windowId: existing, reused: true };
  }
  const params = new URLSearchParams();
  if (handle != null) params.set('tab', String(handle));
  if (agent?.name) params.set('agent', String(agent.name));
  const query = params.toString();
  const url = api.runtime.getURL(`panel/watch.html${query ? `?${query}` : ''}`);
  const win = await api.windows.create({ url, type: 'popup', width: 1100, height: 720, focused: inFront });
  await platform.storage.session.set({ [WATCH_WINDOW_KEY]: { windowId: win.id } }).catch(() => {});
  if (!inFront) await api.windows.update(win.id, { drawAttention: true }).catch(() => {});
  return { windowId: win.id, reused: false };
}

async function handleCall(msg) {
  const { id, tool, args = {}, caller = null } = msg;
  inFlight += 1;
  const controller = new AbortController();
  callControllers.set(id, controller);
  try {
    const result = await runTool(tool, args ?? {}, caller ? { ...caller, signal: controller.signal } : { signal: controller.signal });
    transport.send({ type: 'result', id, ok: true, result });
    if (caller?.relayed === true) afterRelayedCall(tool, args, caller, null);
  } catch (err) {
    // The delivery state of an input error travels as fields too (DAEMON_PROTOCOL §4), not only as
    // the [delivery: …] tag runTool put in the message.
    transport.send({
      type: 'result', id, ok: false, error: String(err?.message ?? err),
      ...(typeof err?.delivery === 'string' ? { delivery: err.delivery, hit: err.hit ?? null, hidden: err.hidden === true } : {}),
    });
    if (caller?.relayed === true) afterRelayedCall(tool, args, caller, err);
  } finally {
    callControllers.delete(id);
    inFlight -= 1;
    maybeReload().catch(() => {});
  }
}

// ------------------------------------------------------------------- watching

/** tabId → unsubscribe for the pointer stream. The screencast consumer is 'watch'. */
const watchers = new Map();

/**
 * Stream one tab to the daemon for a live viewer: screencast frames and the
 * pointer track. The cursor is never drawn in the page (decision D9) — the
 * viewer draws it from the samples. Subscribed before the screencast starts,
 * so the first frames are not lost.
 */
async function startWatch(tabId) {
  if (watchers.has(tabId)) return;
  screencast.subscribe(tabId, 'watch', (frame) => {
    transport.send({ type: 'event', event: 'frame', data: { tabId, ...frame } });
  });
  const off = pointer.subscribe((sampleTab, sample) => {
    if (sampleTab === tabId) transport.send({ type: 'event', event: 'pointer', data: { tabId, sample } });
  });
  // A hidden tab renders no frames: the viewer is told, not left with a stale
  // picture that looks live (lib/screencast.js watchdog).
  const offDog = screencast.watchdog(tabId, {
    onStatus: (status) => transport.send({ type: 'event', event: 'watchStatus', data: { tabId, ...status } }),
  });
  watchers.set(tabId, () => {
    offDog();
    if (typeof off === 'function') off();
  });
  try {
    await screencast.start(tabId, 'watch');
  } catch (err) {
    watchers.get(tabId)?.();
    watchers.delete(tabId);
    // Drop the subscription too; the stream never started, so nothing to stop.
    await screencast.stop(tabId, 'watch', { sendStop: false }).catch(() => {});
    await logActivity({ kind: 'system', tabId, ok: false, detail: `Live view could not start: ${err.message}` });
  }
}

async function stopWatch(tabId) {
  watchers.get(tabId)?.();
  watchers.delete(tabId);
  await screencast.stop(tabId, 'watch').catch(() => {});
}

// ------------------------------------------------------------------- helpers

/**
 * The content hash, computed identically on both sides of the socket.
 *
 * Two rules, and getting either one wrong makes the sync indicator lie:
 *
 * 1. **Hash the SPEC, never the recording.** A recording carries run history
 *    and attachment ids that differ between two machines holding the same
 *    flow. Hashing those reports everything as divergent, and an indicator
 *    that always says "different" is one people stop reading.
 * 2. **Hash the exact bytes that land in the file.** `canonicalJson()` produces
 *    precisely what `flows.js` writes, so the daemon can hash what it read off
 *    disk and get the same answer without re-deriving anything. SHA-1 on both
 *    sides, first 12 hex — node:crypto there, Web Crypto here, and they agree
 *    because the input and the algorithm are the same.
 */
/** (3.2) This browser's recordings in full; with `site`, only those whose start URL is on it ('none': no start URL). */
async function localFlows(site = null) {
  const index = await store.listRecordings();
  const keep = site ? index.filter((e) => (siteOf(e.startUrl) ?? 'none') === site) : index;
  return (await Promise.all(keep.map((e) => store.getRecording(e.id).catch(() => null)))).filter(Boolean);
}

async function specHash(recording) {
  if (!recording) return null;
  try {
    const spec = toFlowSpec(recording, { platform: recording.platform ?? 'web' });
    const bytes = new TextEncoder().encode(canonicalJson(spec));
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 12);
  } catch {
    return null;
  }
}

/** The panel's Stop/Resume, applied here and reported to the daemon, which applies it globally. */
/**
 * The panel's Stop/Resume. → whether the daemon was told NOW. A Stop that could not be sent (no
 * socket) makes the transport connect at once (transport.hurry): the welcome then re-sends it
 * (reconcileHalt) within about a second, instead of after a backoff of up to 60 s during which the
 * daemon kept running agents on launched engines (extension review, 2026-09-22). The panel says
 * which it was — "Agents stopped" was shown either way.
 */
async function setHalt(halted, detail) {
  await setState({ halted });
  await logActivity({ kind: 'system', ok: !halted, detail });
  const told = transport.send({ type: 'event', event: 'halt', data: { halted, by: 'panel' } });
  // Only for Stop: nothing re-sends a Resume, and a daemon that is still halted re-halts this
  // browser after its welcome — the safe direction.
  if (!told && halted) transport.hurry();
  return told;
}

/** The tab the panel means: an explicit one, else what a call would act on. */
async function panelTarget(tabId) {
  if (tabId != null) return tabId;
  const target = await tabsTool.peekTarget();
  if (!target) throw new Error('No tab to act on. Attach one first.');
  return target.id;
}

// ------------------------------------------------------------- panel commands

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.__g9cmd) return false;
  const long = PANEL_LONG_OPS.has(msg.cmd);
  if (long) panelOps += 1;

  (async () => {
    switch (msg.cmd) {
      case 'getState': {
        // The panel polls this. If it is open and we are disconnected, the user
        // is looking at the problem — retry immediately rather than making them
        // wait out a 60s backoff.
        if (msg.nudge && !transport.isConnected() && !transport.isReconnectPending()) {
          // Not ahead of bootstrap: a panel open at first start must not
          // connect before the dev override is read.
          bootstrap().then(() => transport.connectNow());
        }
        // Send only the activity the panel actually renders. The full 200-entry
        // log rides in every poll otherwise — 2.5s apart, for as long as the
        // panel is open — and none of it past the first 120 is ever drawn.
        const full = await getState();
        sendResponse({
          ok: true,
          state: { ...full, activity: full.activity.slice(0, PANEL_ACTIVITY_LIMIT) },
          status: await status(),
        });
        break;
      }

      // clearHalt is passed only on these two paths. They are the user's own
      // gesture in the side panel, and someone pressing Attach after a Stop
      // plainly means "carry on". The agent's own attach path does not get it.
      case 'attachActive':
      case 'attachTab': {
        const attached = await tabsTool.attachTab(msg.cmd === 'attachTab' ? msg.tabId : null, { clearHalt: true });
        if (attached.resumed) transport.send({ type: 'event', event: 'halt', data: { halted: false, by: 'panel' } });
        sendResponse({
          ok: true,
          tab: { id: attached.tabId, title: attached.title, url: attached.url },
          ...(attached.resumed ? { resumed: true } : {}),
        });
        break;
      }
      case 'recordNow': {
        // (v3) "Record from now" (U1): exactly attachActive/attachTab — start capture on
        // this tab, make it current, lift Stop (the person's own gesture) and tell the daemon — then,
        // with reload:true, reload the tab through browser_navigate's own reload path (and its load
        // wait), so the capture holds the page load from its first request. One gesture, one
        // activity line: the attach is not logged on its own.
        const attached = await tabsTool.attachTab(msg.tabId ?? null, { clearHalt: true, log: false });
        if (attached.resumed) transport.send({ type: 'event', event: 'halt', data: { halted: false, by: 'panel' } });
        const tabId = attached.tabId;
        let reloaded = false;
        let reloadError = null;
        if (msg.reload === true) {
          try {
            await navigate.reload(tabId, {});
            reloaded = true;
          } catch (err) {
            // Capture is on either way; the answer says the reload did not happen, and why.
            reloadError = String(err?.message ?? err);
          }
        }
        const tab = await platform.tabs.get(tabId).catch(() => null);
        const { attachedSince } = await getState();
        await logActivity({
          kind: 'attach', tabId, ok: !reloadError,
          detail: 'Record from now' +
            (reloaded ? ' — page reloaded to capture its load' : '') +
            (reloadError ? ` — the reload failed: ${reloadError}` : '') +
            (attached.resumed ? '; Stop lifted' : ''),
        });
        sendResponse({
          ok: true,
          tabId,
          title: tab?.title ?? attached.title ?? '',
          url: tab?.url ?? attached.url ?? '',
          attachedSince: attachedSince?.[tabId] ?? null,
          reloaded,
          ...(reloadError ? { reloadError } : {}),
          ...(attached.resumed ? { resumed: true } : {}),
        });
        break;
      }
      case 'focusTab': {
        // (v3) An agent's tab chip in the panel: bring that tab to the front of its window and the
        // window to the front. The person's own gesture — works while Stop is on (it is what they
        // could do by hand, and no page is touched).
        const tabId = Number(msg.tabId);
        if (!Number.isInteger(tabId)) throw new Error('focusTab needs the tabId of a tab in this browser.');
        const tab = await tabsTool.focusTab(tabId);
        await unblock(tabId); // the active tab of a focused window now
        sendResponse({ ok: true, tabId: tab.id, windowId: tab.windowId ?? null });
        break;
      }
      case 'detach': {
        const t0 = Date.now();
        const results = await tabsTool.detachAllTabs();
        const stuck = results.filter((r) => r.stillAttached);
        sendResponse({
          ok: true,
          detached: results.length - stuck.length,
          // Timed so a slow banner can be attributed. If this reads ~50ms and
          // the banner lingers for seconds, the delay is the browser's, not ours.
          ms: Date.now() - t0,
          // The user can see the debugger banner. If it is still up, say why
          // rather than letting the panel claim a clean detach.
          ...(stuck.length
            ? {
                warning:
                  `${stuck.length} tab(s) are still being debugged — an open DevTools window holds them. ` +
                  `The banner stays until that window closes.`,
              }
            : {}),
        });
        break;
      }
      case 'setInputMode': {
        if (!INPUT_MODES.has(msg.mode)) throw new Error(`Unknown input mode "${msg.mode}". Use off, human or stealth.`);
        const { inputMode: was, attachedTabs } = await getState();
        await setState({ inputMode: msg.mode });
        // Apply to what is already attached: switching TO stealth must switch
        // Runtime OFF now, not at the next attach (rule R4).
        // …and to every tab whose Runtime this extension enabled, listed or not: a tab missing from
        // attachedTabs must not keep Runtime on under Stealth.
        for (const tabId of new Set([...attachedTabs, ...runtimeEnabledTabs()])) await applyStealthLevel(tabId).catch(() => {});
        if (was !== msg.mode) {
          await logActivity({ kind: 'system', ok: true, detail: `Input mode: ${was} → ${msg.mode}` });
        }
        sendResponse({ ok: true });
        break;
      }
      case 'setAutoAttach': {
        // v3 takes {mode}; a v2 panel's {enabled:boolean} still works (true → 'all', false → 'off').
        const mode = 'mode' in msg ? autoAttachMode(msg.mode) : 'enabled' in msg ? autoAttachMode(!!msg.enabled) : null;
        if (!mode) {
          throw new Error(`setAutoAttach needs mode: ${AUTO_ATTACH_MODES.map((m) => `"${m}"`).join(', ')} (or the v2 form enabled:true|false).`);
        }
        await setState({ autoAttach: mode });
        await logActivity({ kind: 'system', ok: true, detail: `Auto-attach: ${AUTO_ATTACH_LABEL[mode]}` });
        sendResponse({ ok: true, mode });
        // After answering: attaching every open tab can take a while, and the
        // toggle should not look stuck while it does.
        if (mode !== 'off') attachAllEligible().catch(() => {});
        break;
      }
      case 'popout': {
        // The person's own button: it works while Stop is on (resolveTarget
        // would refuse), so the tab is picked the way the panel shows it.
        // The person asked to see it: in front, focused (tabs.js popout, "two callers").
        const result = await tabsTool.popout(await panelTarget(msg.tabId ?? null), { focus: true });
        await unblock(result.tabId); // in its own window, in front: an agent blocked on it can drive it
        sendResponse({ ok: true, ...result });
        break;
      }
      case 'handoff': {
        const tabId = await panelTarget(msg.tabId ?? null);
        const result = await transport.request('handoff', { tabId });
        await unblock(tabId); // the agent works in the launched copy now
        sendResponse({ ok: true, result });
        break;
      }
      // (3.2) The live view: the person's own press opens (or raises) the watch window, on a daemon
      // tab handle or on its picker; the watch page asks where the daemon is, to connect as a viewer.
      case 'openWatch': {
        const handle = Number.isInteger(msg.handle) ? msg.handle : null;
        sendResponse({ ok: true, ...(await openWatchWindow({ handle, person: true })) });
        break;
      }
      case 'watchAddress': {
        const address = transport.connectedAddress();
        sendResponse(address
          ? { ok: true, address, version: platform.runtime.version() }
          : { ok: false, error: 'The G9 daemon is not connected. The live view comes back when it is (an agent\'s first call starts it).' });
        break;
      }
      case 'daemonInfo': {
        if (!transport.isConnected()) {
          sendResponse({ ok: true, daemon: null });
          break;
        }
        try {
          sendResponse({ ok: true, daemon: await transport.request('info', {}, { timeoutMs: 5_000 }) });
        } catch (err) {
          sendResponse({ ok: true, daemon: null, error: String(err?.message ?? err) });
        }
        break;
      }
      case 'about': {
        const state = await getState();
        sendResponse({
          ok: true,
          version: state.version,
          previousVersion: state.previousVersion,
          updatedAt: state.updatedAt,
          browser: globalThis.navigator?.userAgent ?? null,
        });
        break;
      }
      case 'setBridge':
        // An address the person saved is theirs: never switched by the v1-port fallback.
        await setState({ bridge: { host: msg.host || '127.0.0.1', port: Number(msg.port), v1AutoPort: false } });
        transport.connectNow();
        sendResponse({ ok: true });
        break;
      case 'reconnect':
        // User is watching — skip any pending backoff and try right now.
        transport.connectNow();
        sendResponse({ ok: true });
        break;
      case 'halt':
        sendResponse({ ok: true, daemonInformed: await setHalt(true, 'STOP pressed by user') });
        break;
      case 'resume':
        sendResponse({ ok: true, daemonInformed: await setHalt(false, 'Resumed by user') });
        break;
      case 'detachPanel': {
        // The side panel in its own window.
        //
        // Asked for directly: the panel is narrow, a long report has nowhere to
        // go in it, and it sits on top of the page being tested. A popup window
        // is resizable, movable to a second screen, and stays put while the tab
        // under test scrolls — which is the whole point when you are watching a
        // run and the page is moving.
        //
        // Same document, so there is no second implementation to keep in step;
        // it simply has more room.
        const existing = (await api.windows.getAll({ populate: true }).catch(() => []))
          .find((w) => w.type === 'popup' && (w.tabs ?? []).some((t) => t.url?.includes('panel/panel.html')));
        if (existing) {
          await api.windows.update(existing.id, { focused: true });
          sendResponse({ ok: true, windowId: existing.id, reused: true });
          break;
        }
        const win = await api.windows.create({
          url: api.runtime.getURL('panel/panel.html?detached=1'),
          type: 'popup',
          width: 520,
          height: 860,
        });
        sendResponse({ ok: true, windowId: win.id, reused: false });
        break;
      }

      case 'clearLog':
        await clearActivity();
        sendResponse({ ok: true });
        break;
      // The panel drives recording and issues through the same tool
      // implementations the agent uses. Two entry points, one behaviour —
      // a QA and an agent must never get different results from one button.
      case 'recStatus': {
        // peekTarget, not resolveTarget: the latter refuses under Stop, and the panel then said this
        // tab was not recording and named it as "another tab" (extension review, 2026-09-22).
        const tab = await tabsTool.peekTarget().catch(() => null);
        const { halted } = await getState();
        // Recordings in OTHER tabs, so the panel can name them (F8).
        const all = await record.recordingTabs().catch(() => []);
        const elsewhere = tab ? all.filter((r) => r.tabId !== tab.id) : all;
        sendResponse({ ok: true, status: tab ? await record.recordingStatus(tab.id) : { recording: false },
                       elsewhere, halted: !!halted, recordings: await store.listRecordings() });
        break;
      }
      case 'recStart': {
        const tab = await tabsTool.resolveTarget();
        sendResponse({ ok: true, ...(await record.startRecording(tab.id, { name: msg.name })) });
        break;
      }
      case 'recStop': {
        // The person's own save: works under Stop (lib/cdp.js asPerson — no input, no navigation).
        const tabId = await panelTarget();
        sendResponse({ ok: true, ...(await asPerson(tabId, () => record.stopRecording(tabId))) });
        break;
      }
      case 'recReplay': {
        const tab = await tabsTool.resolveTarget();
        sendResponse({ ok: true, ...(await replay.replay(tab.id, { id: msg.id, dryRun: msg.dryRun })) });
        break;
      }
      case 'recDelete':
        sendResponse({ ok: true, ...(await store.deleteRecording(msg.id)) });
        break;

      // ---------------------------------------------------------------------
      // The rest of the automation surface, reachable without an agent.
      //
      // A QA who cannot add an assertion records a macro, and a macro proves
      // that the steps could be performed, never that they did anything.
      //
      // `approve` in particular BELONGS here rather than in MCP: the whole
      // design rests on a human, and only a human, folding a run into the
      // known world.
      // ---------------------------------------------------------------------
      case 'recGet':
        sendResponse({ ok: true, recording: await store.getRecording(msg.id) });
        break;
      case 'recSuggest': {
        const tab = await tabsTool.resolveTarget();
        sendResponse({ ok: true, ...(await qa.suggestAssertions(tab.id, msg.id)) });
        break;
      }
      case 'recAssert': {
        const tab = await tabsTool.resolveTarget();
        sendResponse({ ok: true, ...(await qa.addAssertion(tab.id, { ...msg.assertion, id: msg.id })) });
        break;
      }
      case 'recUpdate':
        sendResponse({ ok: true, ...(await qa.updateRecording(msg.id, msg.patch ?? {})) });
        break;
      case 'recCalibrate': {
        const tab = await tabsTool.resolveTarget();
        sendResponse({ ok: true, ...(await replay.calibrate(tab.id, { id: msg.id })) });
        break;
      }
      case 'recApprove':
        sendResponse({
          ok: true,
          ...(await replay.approveKnownWorld(msg.id, { by: msg.by ?? 'side panel', note: msg.note })),
        });
        break;
      case 'recKnownWorld': {
        const rec = await store.getRecording(msg.id);
        if (!rec) throw new Error(`No recording ${msg.id}.`);
        sendResponse({
          ok: true,
          knownWorld: rec.knownWorld ?? null,
          runHistory: rec.runHistory ?? [],
          surpriseHistory: rec.surpriseHistory ?? [],
        });
        break;
      }
      case 'recExportTest':
        sendResponse({ ok: true, ...(await qa.exportPlaywright(msg.id)) });
        break;

      // --- flow library on disk (see lib/transport.js flowLib) --------------
      // (3.2) The run-history report's data: the flows asked for, without what it does not show
      // (signatures, locators, the known world's contents).
      case 'recHistory': {
        const ids = Array.isArray(msg.ids) ? msg.ids.slice(0, 2000) : (await store.listRecordings()).map((r) => r.id);
        const recs = [];
        for (const id of ids) {
          const r = await store.getRecording(id).catch(() => null);
          if (!r) continue;
          recs.push({
            id: r.id, flowId: r.flowId ?? null, name: r.name, startUrl: r.startUrl ?? null, suite: r.suite ?? null,
            tags: r.tags ?? [], qaTestCaseIds: r.qaTestCaseIds ?? [], environment: r.environment ?? null,
            runHistory: r.runHistory ?? [], flaky: r.flaky ?? null,
            steps: (r.steps ?? []).map((s) => ({ type: s.type })),
            knownWorld: r.knownWorld ? { approvedAt: r.knownWorld.approvedAt ?? null, approvedBy: r.knownWorld.approvedBy ?? null } : null,
          });
        }
        sendResponse({ ok: true, recordings: recs });
        break;
      }
      // (3.2) Every library the daemon can reach: its own project's and each connected agent's.
      case 'flowProjects':
        sendResponse({ ok: true, ...(await transport.flowLib('projects')) });
        break;
      // (3.2) `project` picks the library (a path from flowProjects; none: the daemon's own) and
      // `site` narrows to one origin ('none': flows with no start URL), on both sides.
      case 'flowStatus': {
        const { project = null, site = null } = msg;
        const local = await localFlows(site);
        const withHashes = await Promise.all(
          local.map(async (full) => ({ id: full.flowId ?? full.id, name: full.name, hash: await specHash(full), approvedAt: approvedAtFor(full) })),
        );
        // Pulls before 3.1 saved every repo flow again under a new id: the copies are named, never
        // deleted here (which one a person edited is theirs to say).
        const byFlow = new Map();
        for (const r of local) byFlow.set(r.flowId ?? r.id, [...(byFlow.get(r.flowId ?? r.id) ?? []), r]);
        const duplicates = [...byFlow.values()].filter((rs) => rs.length > 1).map((rs) => ({ flowId: rs[0].flowId ?? rs[0].id, name: rs[0].name, copies: rs.length }));
        sendResponse({ ok: true, ...(await transport.flowLib('status', { local: withHashes, project, site })), duplicates });
        break;
      }
      case 'flowPull': {
        const { project = null, site = null } = msg;
        const { flows } = await transport.flowLib('list', { project, site });
        let imported = 0;
        let created = 0;
        let approvals = 0;
        let baselines = 0;
        const newerHere = [];
        const problems = [];
        for (const entry of flows) {
          if (entry.broken) {
            problems.push(`${entry.file}: ${entry.error}`);
            continue;
          }
          try {
            const { spec } = await transport.flowLib('read', { flowId: entry.id, project });
            // The sidecar: what a person approved (known world, baselines). A flow without one keeps
            // this browser's baselines and known world (lib/approved.js applyApproved).
            const side = await transport.flowLib('readApproved', { flowId: entry.id, project }, { timeoutMs: 60_000 })
              .catch((err) => { problems.push(`${entry.file}: its approval was not read (${err.message})`); return null; });
            // Keeps what this machine learned (run history, flakiness) — the repo has no business
            // overwriting it, which is why it never leaves — and finds the local copy by the flow's id
            // (pulling twice used to list every flow twice).
            const result = await importFlow(spec, { approved: side?.approved ?? null, images: side?.images ?? {} });
            imported += 1;
            if (result.created) created += 1;
            if (result.knownWorld === 'repo') approvals += 1;
            if (result.localNewer) newerHere.push(spec.name ?? spec.id);
            baselines += result.baselines.fromRepo;
          } catch (err) {
            problems.push(`${entry.file}: ${err.message}`);
          }
        }
        sendResponse({ ok: true, imported, created, approvals, baselines, newerHere, problems });
        break;
      }
      case 'flowPush': {
        const { project = null, site = null } = msg;
        const recs = msg.ids
          ? (await Promise.all(msg.ids.map((id) => store.getRecording(id).catch(() => null)))).map((r, i) => r ?? { missing: msg.ids[i] })
          : await localFlows(site);
        const written = [];
        const problems = [];
        let approvals = 0;
        for (const rec of recs) {
          const label = rec.missing ?? rec.id;
          try {
            if (rec.missing) throw new Error('not found in this browser');
            const spec = toFlowSpec(rec, { platform: rec.platform ?? 'web' });
            const problem = validateFlowSpec(spec);
            if (problem?.length) throw new Error(problem.join('; '));
            const w = await transport.flowLib('write', { spec, project });
            // What a person approved goes with it: the known world and the baselines (3.2).
            const bundle = await approvedBundle(rec);
            if (bundle) {
              const a = await transport.flowLib('writeApproved', { flowId: spec.id, approved: bundle.approved, images: bundle.images, project }, { timeoutMs: 60_000 });
              if (a?.written) {
                approvals += 1;
                if (a.changed) w.changed = true;
              }
            }
            written.push(w);
          } catch (err) {
            problems.push(`${label}: ${err.message}`);
          }
        }
        // A flow whose name slugs to another flow's file is written beside it, under a name with
        // its id (daemon/flows.js): said, so the person can rename it.
        const notes = written.filter((w) => w.collidedWith).map((w) =>
          `${w.file}: written under this name because ${w.collidedWith.file} holds another flow` +
          `${w.collidedWith.name ? ` ("${w.collidedWith.name}"${w.collidedWith.id ? `, ${w.collidedWith.id}` : ''})` : ''} — rename one of them.`);
        sendResponse({
          ok: true,
          written: written.length,
          changed: written.filter((w) => w.changed).length,
          approvals,
          files: written.map((w) => w.file),
          problems,
          ...(notes.length ? { notes } : {}),
        });
        break;
      }
      case 'flowSuite':
        sendResponse({ ok: true, ...(await transport.flowLib('suite', { suiteId: msg.suiteId })) });
        break;

      // --- named sessions, from the panel -----------------------------------
      case 'sessionList':
        sendResponse({ ok: true, sessions: await tabsTool.listSessions() });
        break;
      case 'sessionName': {
        const tab = msg.tabId != null ? { id: msg.tabId } : await tabsTool.getActiveTab();
        if (!tab) throw new Error('No tab to name.');
        sendResponse({ ok: true, ...(await tabsTool.nameSession(msg.name, tab.id)) });
        break;
      }
      case 'sessionEnd':
        sendResponse({ ok: true, ...(await tabsTool.closeSession(msg.name)) });
        break;

      // --- issues ------------------------------------------------------------
      case 'issueList':
        sendResponse({ ok: true, issues: await store.listIssues(), usage: await store.usage() });
        break;
      // Evidence the PERSON captures works under Stop (lib/cdp.js asPerson): pressing Stop because an
      // agent misbehaves is exactly when the page is worth an issue.
      case 'issueCreate': {
        const tabId = await panelTarget();
        const issue = await asPerson(tabId, () => issues.createIssue(tabId, msg));
        sendResponse({ ok: true, id: issue.id, title: issue.title });
        break;
      }
      case 'issueGet':
        sendResponse({ ok: true, issue: await issues.getIssue(msg.id) });
        break;
      case 'issueUpdate':
        sendResponse({ ok: true, issue: await issues.updateIssue(msg.id, msg) });
        break;
      case 'issueShot': {
        const tabId = await panelTarget();
        sendResponse({ ok: true, attachment: await asPerson(tabId, () => issues.attachScreenshot(tabId, msg.id, { area: msg.area })) });
        break;
      }
      case 'issueRecapture': {
        const tabId = await panelTarget();
        sendResponse({ ok: true, ...(await asPerson(tabId, () => issues.recapture(tabId, msg.id))) });
        break;
      }
      case 'issueAttach':
        sendResponse({ ok: true, attachment: await issues.attachFile(msg.id, msg) });
        break;
      case 'issueDetach':
        sendResponse({ ok: true, ...(await store.deleteAttachment(msg.attachmentId)) });
        break;
      case 'issueAttachment':
        sendResponse({ ok: true, attachment: await store.getAttachment(msg.attachmentId) });
        break;
      case 'issueDelete':
        sendResponse({ ok: true, ...(await issues.deleteIssue(msg.id)) });
        break;
      case 'videoStart': {
        const tabId = await panelTarget();
        sendResponse({ ok: true, ...(await asPerson(tabId, () => issues.startVideo(tabId, { id: msg.id }))) });
        break;
      }
      case 'videoStop': {
        const tabId = await panelTarget();
        sendResponse({ ok: true, ...(await asPerson(tabId, () => issues.stopVideo(tabId, msg.id))) });
        break;
      }
      case 'videoStatus': {
        const tabId = await panelTarget();
        sendResponse({ ok: true, status: await asPerson(tabId, () => issues.videoStatus(tabId)) });
        break;
      }
      case 'listTabs':
        sendResponse({ ok: true, tabs: await tabsTool.listTabs() });
        break;
      case 'shutdown':
        for (const tabId of [...watchers.keys()]) await stopWatch(tabId);
        await detachAll();
        transport.disconnect();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: `Unknown command ${msg.cmd}` });
    }
  })().catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) })).finally(() => {
    if (long) panelOps -= 1;
    // A saved recording, a stopped video, a finished replay: a deferred update may go ahead. Checked
    // after every panel command (one session read), so a deferred update is never forgotten.
    maybeReload().catch(() => {});
  });

  return true; // keep the message channel open for the async response
});

// A worker revival (message, alarm, event) also lands here on module eval.
// Last, so every module-level binding bootstrap() touches is initialised.
bootstrap();
