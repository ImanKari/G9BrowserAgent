/**
 * Service worker: the extension's brain.
 *
 * Responsibilities, in order of importance:
 *   1. Route tool calls from the bridge to the right implementation.
 *   2. Keep the WebSocket alive across MV3's aggressive worker teardown.
 *   3. Ingest CDP events (console, network) continuously so they are already
 *      buffered when the agent asks for them.
 *   4. Keep the side panel truthful about what is happening.
 *
 * MV3 rule that shapes everything here: the worker can die at any moment.
 * No module-level variable is a source of truth — storage is.
 */

import { getState, setState, logActivity, clearActivity, broadcast } from './lib/state.js';
import * as transport from './lib/transport.js';
import { detachAll, evaluate, attachedTabIds } from './lib/cdp.js';
import { clearRefs } from './lib/refs.js';

import * as tabsTool from './tools/tabs.js';
import { snapshot } from './tools/snapshot.js';
import * as interact from './tools/interact.js';
import * as inspect from './tools/inspect.js';
import * as observe from './tools/observe.js';
import * as nav from './tools/navigate.js';
import { screenshot } from './tools/capture.js';
import * as diagnose from './tools/diagnose.js';
import * as emulate from './tools/emulate.js';
import * as record from './tools/record.js';
import * as replay from './tools/replay.js';
import * as issues from './tools/issues.js';
import * as store from './lib/store.js';

const api = globalThis.browser ?? globalThis.chrome;

/** Matches the slice in panel.js renderLog(). Keep the two in step. */
const PANEL_ACTIVITY_LIMIT = 120;

// ------------------------------------------------------------------ lifecycle

api.runtime.onStartup.addListener(bootstrap);
api.runtime.onInstalled.addListener(async (details) => {
  await bootstrap();
  if (details.reason === 'install') {
    api.tabs.create({ url: api.runtime.getURL('panel/welcome.html') }).catch(() => {});
  }
});

// A worker revival (message, alarm, event) also lands here on module eval.
bootstrap();

async function bootstrap() {
  try {
    await api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    /* Edge versions before 114 have no sidePanel; the action click still works */
  }
  transport.onMessage(handleBridgeMessage);
  transport.connect();
  // A heartbeat alarm resurrects the worker if it was torn down while the
  // bridge was unreachable, so the connection re-establishes on its own.
  api.alarms.create('g9-heartbeat', { periodInMinutes: 0.5 });
}

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'g9-heartbeat') return;
  // Only step in when the backoff cycle is NOT already handling it. The alarm
  // exists to revive a worker that was torn down mid-backoff (its timers die
  // with it); firing alongside a live backoff just doubles the failed attempts
  // the browser logs to the extension error console.
  if (!transport.isConnected() && !transport.isReconnectPending()) {
    transport.connect();
  }
});

// ------------------------------------------------------- CDP event ingestion

api.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return;
  // Capture failures used to be swallowed here, which meant a full storage
  // quota silently stopped console and network capture while the agent went on
  // believing the buffers were complete. Report it — a red line in the
  // extension console is the honest outcome.
  observe.ingest(source.tabId, method, params).catch((err) => {
    console.error('[G9] event capture failed', method, err);
  });

  // The recorder speaks to us through a Runtime binding rather than a content
  // script: injected before the page's own code, surviving navigation, over the
  // debugger session already open.
  if (method === 'Runtime.bindingCalled' && params.name === record.BINDING) {
    try {
      record.ingestRaw(source.tabId, JSON.parse(params.payload)).catch(() => {});
    } catch { /* a malformed payload is one lost event, not a broken recording */ }
  }

  if (method === 'Page.screencastFrame') {
    issues.ingestFrame(source.tabId, params).catch(() => {});
  }
  // A committed navigation invalidates every element ref for that tab, and
  // everything captured for the document we just left. Pruning here as well as
  // in navigate.js is what closes the gap: the outgoing page keeps emitting
  // until the new one commits, so a pre-navigation clear alone leaves residue.
  if (method === 'Page.frameNavigated' && !params.frame.parentId) {
    clearRefs(source.tabId).catch(() => {});
    observe.pruneToLoader(source.tabId, params.frame.loaderId).catch(() => {});
    // A new document cannot report the navigation that created it — the script
    // that would have emitted the event went away with the old page.
    record.ingestRaw(source.tabId, { type: 'navigate', at: Date.now(), url: params.frame.url }).catch(() => {});
  }

  // Surface dialogs immediately — they block the page until handled.
  if (method === 'Page.javascriptDialogOpening') {
    setState({ dialogOpen: { tabId: source.tabId, type: params.type, message: params.message } }).catch(() => {});
    broadcast({ type: 'dialog', tabId: source.tabId, message: params.message, dialogType: params.type });
    transport.send({ type: 'event', event: 'dialog', tabId: source.tabId, data: params });
  }

  if (method === 'Page.javascriptDialogClosed') {
    setState({ dialogOpen: null }).catch(() => {});
  }
});

api.debugger.onDetach.addListener(async (source, reason) => {
  if (source.tabId == null) return;
  const state = await getState();
  await setState({ attachedTabs: state.attachedTabs.filter((id) => id !== source.tabId) });
  await logActivity({ kind: 'detach', tabId: source.tabId, ok: false, detail: reason });
  if (source.tabId === state.pinnedTabId) {
    broadcast({ type: 'detached', tabId: source.tabId, reason });
  }
});

api.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.pinnedTabId === tabId) {
    await setState({ pinnedTabId: null });
    await logActivity({ kind: 'system', ok: false, detail: 'Pinned tab was closed' });
  }
  await clearRefs(tabId).catch(() => {});
  // Console and network buffers are keyed by tabId and nothing else reclaims
  // them; without this they sat in session storage until the browser closed.
  await observe.clearBuffers(tabId).catch(() => {});
});

// --------------------------------------------------------------- tool routing

/**
 * The tool table. Each entry receives ({ tabId, tab, args }) and returns a
 * JSON-serializable result. Keeping this flat and declarative means adding a
 * capability is a one-line change plus a schema entry in the bridge.
 */
const TOOLS = {
  // --- session -------------------------------------------------------------
  // Orientation is the one thing that must still work while halted — otherwise
  // the agent cannot discover *why* everything else is failing.
  browser_status: { needsTab: false, allowWhenHalted: true, run: () => status() },

  browser_tabs: {
    needsTab: false,
    run: async ({ args }) => {
      const action = args.action ?? 'list';
      // browser_tabs is the only tool that never goes through resolveTarget(),
      // because it has no target to resolve. Every action except "list" still
      // changes what the agent can reach, so it gets the same mode boundary.
      if (action !== 'list') await tabsTool.requireMultiMode(action);

      switch (action) {
        case 'list':
          return { tabs: await tabsTool.listTabs() };
        case 'open': {
          if (!args.url) throw new Error('action:"open" needs a url.');
          const opened = await tabsTool.openTab(args.url, { active: args.focus ?? false });
          if (args.pin) await tabsTool.pinTab(opened.tabId);
          return opened;
        }
        case 'close':
          await tabsTool.closeTab(requireTabId(args));
          return { closed: args.tabId };
        case 'focus':
          return { focused: (await tabsTool.focusTab(requireTabId(args))).id };
        case 'pin': {
          const tab = await tabsTool.pinTab(requireTabId(args));
          return { pinned: tab.id, url: tab.url, title: tab.title };
        }
        case 'unpin':
          await tabsTool.unpinTab();
          return { unpinned: true };
        default:
          throw new Error(`Unknown tabs action "${action}".`);
      }
    },
  },

  // --- perception ----------------------------------------------------------
  browser_snapshot: { run: ({ tabId, args }) => snapshot(tabId, args) },

  browser_screenshot: { run: ({ tabId, tab, args }) => screenshot(tabId, { ...args, url: tab.url }) },

  browser_inspect: {
    run: ({ tabId, tab, args }) => {
      const withUrl = { ...args, url: tab.url };
      switch (args.what ?? 'dom') {
        case 'dom': return inspect.dom(tabId, withUrl);
        case 'styles': return inspect.styles(tabId, withUrl);
        case 'box': return inspect.box(tabId, withUrl);
        case 'storage': return inspect.storage(tabId, args);
        case 'cookies': return inspect.cookies(tabId, args);
        case 'frames': return inspect.frames(tabId);
        default: throw new Error(`Unknown inspect target "${args.what}".`);
      }
    },
  },

  // --- action --------------------------------------------------------------
  browser_interact: {
    run: ({ tabId, tab, args }) => {
      const a = { ...args, url: tab.url };
      if (Array.isArray(args.modifiers)) a.modifiers = interact.modifierMask(args.modifiers);
      switch (args.action) {
        case 'click': return interact.click(tabId, a);
        case 'double_click': return interact.click(tabId, { ...a, clickCount: 2 });
        case 'right_click': return interact.click(tabId, { ...a, button: 'right' });
        case 'hover': return interact.hover(tabId, a);
        case 'type': return interact.type(tabId, a);
        case 'key': return interact.key(tabId, a);
        case 'scroll': return interact.scroll(tabId, a);
        case 'drag': return interact.drag(tabId, a);
        case 'select': return interact.select(tabId, a);
        case 'upload': return interact.upload(tabId, a);
        default: throw new Error(`Unknown interact action "${args.action}".`);
      }
    },
  },

  browser_navigate: {
    run: ({ tabId, args }) => {
      switch (args.action ?? 'goto') {
        case 'goto': return nav.navigate(tabId, args);
        case 'reload': return nav.reload(tabId, args);
        case 'back': return nav.history(tabId, { delta: -(args.steps ?? 1) });
        case 'forward': return nav.history(tabId, { delta: args.steps ?? 1 });
        case 'wait': return nav.waitFor(tabId, args);
        default: throw new Error(`Unknown navigate action "${args.action}".`);
      }
    },
  },

  browser_dialog: { run: ({ tabId, args }) => emulate.handleDialog(tabId, args) },

  browser_emulate: { run: ({ tabId, args }) => emulate.emulate(tabId, args) },

  // --- observation ---------------------------------------------------------
  browser_console: {
    run: async ({ tabId, args }) => {
      if (args.action === 'evaluate') {
        if (!args.expression) throw new Error('action:"evaluate" needs an expression.');
        const value = await evaluate(tabId, args.expression);
        return { value: value === undefined ? '(undefined)' : value };
      }
      return observe.consoleLog(tabId, args);
    },
  },

  browser_network: {
    run: ({ tabId, args }) =>
      args.requestId
        ? observe.networkDetail(tabId, args)
        : observe.network(tabId, args),
  },

  // --- automation ----------------------------------------------------------
  browser_recording: {
    // list/get/delete/export/import touch no page, so they must keep working
    // when nothing is attached — that is when someone reviews their library.
    needsTab: false,
    run: async ({ args }) => {
      const action = args.action ?? 'list';
      const needsPage = ['start', 'stop', 'replay'].includes(action);
      const tab = needsPage ? await tabsTool.resolveTarget(args.tabId) : null;

      switch (action) {
        case 'list': return { recordings: await store.listRecordings() };
        case 'get': {
          const rec = await store.getRecording(requireId(args));
          if (!rec) throw new Error(`No recording with id "${args.id}".`);
          return { ...rec, outline: rec.steps.map(record.summarize) };
        }
        case 'status': return record.recordingStatus(tab ? tab.id : (await tabsTool.resolveTarget()).id);
        case 'start': return record.startRecording(tab.id, { name: args.name });
        case 'stop': return record.stopRecording(tab.id);
        case 'replay': return replay.replay(tab.id, {
          id: requireId(args), timing: args.timing, dryRun: args.dryRun, stopOnFailure: args.stopOnFailure !== false,
        });
        case 'delete': return store.deleteRecording(requireId(args));
        case 'export': return store.exportBundle({ includeAttachments: args.includeAttachments !== false });
        case 'import': {
          if (!args.bundle) throw new Error('action:"import" needs a bundle.');
          return store.importBundle(args.bundle, { mode: args.mode ?? 'merge' });
        }
        default: throw new Error(`Unknown recording action "${action}".`);
      }
    },
  },

  browser_issue: {
    needsTab: false,
    run: async ({ args }) => {
      const action = args.action ?? 'list';
      const needsPage = ['create', 'screenshot', 'video_start', 'video_stop'].includes(action);
      const tab = needsPage ? await tabsTool.resolveTarget(args.tabId) : null;

      switch (action) {
        case 'list': return { issues: await store.listIssues(), usage: await store.usage() };
        case 'get': {
          const issue = await issues.getIssue(requireId(args));
          if (!issue) throw new Error(`No issue with id "${args.id}".`);
          return issue;
        }
        case 'create': return issues.createIssue(tab.id, args);
        case 'update': return issues.updateIssue(requireId(args), args);
        case 'delete': return store.deleteIssue(requireId(args));
        case 'screenshot': return issues.attachScreenshot(tab.id, requireId(args), args);
        case 'attach': return issues.attachFile(requireId(args), args);
        case 'attachment': {
          if (!args.attachmentId) throw new Error('action:"attachment" needs an attachmentId.');
          return store.getAttachment(args.attachmentId, { includeBytes: args.includeBytes !== false });
        }
        case 'video_start': return issues.startVideo(tab.id, args);
        case 'video_stop': return issues.stopVideo(tab.id, args.id);
        default: throw new Error(`Unknown issue action "${action}".`);
      }
    },
  },
  // --- diagnosis -----------------------------------------------------------
  browser_diagnose: {
    run: ({ tabId, args }) =>
      (args.what ?? 'health') === 'performance'
        ? diagnose.performance(tabId, args)
        : diagnose.health(tabId),
  },
};

function requireId(args) {
  if (!args.id) throw new Error('This action needs an id. Use action:"list" to see what exists.');
  return args.id;
}

function requireTabId(args) {
  if (args.tabId == null) throw new Error('This action needs a tabId. Call browser_tabs with action:"list" first.');
  return args.tabId;
}

/** Live session state — the agent's orientation tool. */
async function status() {
  const state = await getState();
  const tabs = await tabsTool.listTabs();

  // The tab the agent will ACT on, which in follow mode is the active tab, not
  // the pinned one. Reporting the pinned tab there oriented the agent to a page
  // it was not about to touch — the orientation tool describing the wrong page
  // is the one error it must never make.
  const target = tabs.find((t) => t.target) ?? null;

  let health = null;
  if (target) {
    const [logs, net] = await Promise.all([
      observe.consoleLog(target.tabId, { limit: 0 }).catch(() => null),
      observe.network(target.tabId, { limit: 0 }).catch(() => null),
    ]);
    health = {
      consoleErrors: logs?.counts?.error ?? 0,
      consoleWarnings: logs?.counts?.warning ?? 0,
      consoleTotal: logs?.total ?? 0,
      networkRequests: net?.total ?? 0,
      failedRequests: net?.failedCount ?? 0,
    };
  }

  // What the browser says, not only what we think we hold. A drift between
  // the two is exactly what makes a stuck debugger banner invisible.
  const reallyAttached = await attachedTabIds().catch(() => []);
  const held = state.attachedTabs.filter((id) => reallyAttached.includes(id));

  return {
    connected: transport.isConnected(),
    mode: state.mode,
    halted: state.halted,
    debuggedTabs: held.length,
    bridge: { host: state.bridge.host, port: state.bridge.port },
    attached: target
      ? { tabId: target.tabId, title: target.title, url: target.url, active: target.active }
      : null,
    health,
    // Redaction is not applied here any more — listTabs() owns that rule, so
    // there is exactly one place it can be got wrong. See tabs.js.
    otherTabs: tabs.filter((t) => !t.target && t.attachable).slice(0, 25),
    otherTabsNote:
      state.mode === 'multi'
        ? undefined
        : `Mode is "${state.mode}", so other tabs are listed by origin only — their titles and ` +
          `URLs are withheld. The user can change this from the G9 side panel.`,
    hint: target
      ? 'Ready. Start with browser_snapshot to see the page, then use the refs it returns.'
      : 'No tab is attached. Ask the user to open the G9 side panel and press "Attach & Pin".',
  };
}

// ------------------------------------------------------------ bridge protocol

async function handleBridgeMessage(msg) {
  if (msg.type !== 'call') return;

  const { id, tool, args = {} } = msg;
  const started = Date.now();

  try {
    const entry = TOOLS[tool];
    if (!entry) throw new Error(`Unknown tool "${tool}".`);

    // The Stop button is checked here, at the router, as well as inside
    // cdp.send(). cdp.send() alone was not enough: browser_tabs never reaches
    // it — chrome.tabs.* is not CDP — so a halted agent could still open,
    // close, focus, and pin tabs. Every tool now stops at the same line.
    if (entry.allowWhenHalted !== true) {
      const { halted, dialogOpen } = await getState();
      if (halted) {
        throw new Error(
          'The user pressed Stop. Every browser action is blocked until they press Resume in the ' +
            'G9 side panel — you cannot lift this yourself. Tell them, and wait.',
        );
      }
      // A blocked renderer answers nothing, so without this every call sits
      // until its 60s timeout before the agent learns why.
      if (dialogOpen && tool !== 'browser_dialog') {
        throw new Error(
          `The page is blocked by a JavaScript ${dialogOpen.type} dialog: ` +
            `"${String(dialogOpen.message ?? '').slice(0, 200)}". Nothing else will run until it is ` +
            `handled — call browser_dialog to accept or dismiss it, then retry this.`,
        );
      }
    }

    let tabId = null;
    let tab = null;
    if (entry.needsTab !== false) {
      tab = await tabsTool.resolveTarget(args.tabId);
      tabId = tab.id;
    }

    const result = await entry.run({ tabId, tab, args });

    await logActivity({
      kind: 'tool',
      tool,
      tabId,
      ok: true,
      detail: summarize(tool, args),
      ms: Date.now() - started,
    });

    transport.send({ type: 'result', id, ok: true, result });
  } catch (err) {
    const message = String(err?.message ?? err);
    await logActivity({
      kind: 'tool',
      tool,
      ok: false,
      detail: `${summarize(tool, args)} — ${message}`,
      ms: Date.now() - started,
    });
    transport.send({ type: 'result', id, ok: false, error: message });
  }
}

/** One-line human description for the activity log. */
function summarize(tool, args) {
  const bits = [];
  if (args.action) bits.push(args.action);
  if (args.what) bits.push(args.what);
  if (args.ref) bits.push(args.ref);
  if (args.selector) bits.push(args.selector);
  if (args.url) bits.push(args.url);
  if (args.text) bits.push(JSON.stringify(String(args.text).slice(0, 40)));
  if (args.expression) bits.push(String(args.expression).slice(0, 60));
  return bits.length ? `${tool}(${bits.join(' ')})` : tool;
}

// ------------------------------------------------------------- panel commands

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.__g9cmd) return false;

  (async () => {
    switch (msg.cmd) {
      case 'getState': {
        // The panel polls this. If it is open and we are disconnected, the user
        // is looking at the problem — retry immediately rather than making them
        // wait out a 60s backoff.
        if (msg.nudge && !transport.isConnected() && !transport.isReconnectPending()) {
          transport.connectNow();
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
      // gesture in the side panel, and someone pressing "Attach & Pin" after a
      // Stop plainly means "carry on". The agent's own pin path does not get it.
      case 'attachActive': {
        const active = await tabsTool.getActiveTab();
        if (!active) throw new Error('No active tab.');
        const tab = await tabsTool.pinTab(active.id, { clearHalt: true });
        sendResponse({ ok: true, tab: { id: tab.id, title: tab.title, url: tab.url } });
        break;
      }
      case 'attachTab': {
        const tab = await tabsTool.pinTab(msg.tabId, { clearHalt: true });
        sendResponse({ ok: true, tab: { id: tab.id, title: tab.title, url: tab.url } });
        break;
      }
      case 'detach': {
        const t0 = Date.now();
        const results = await tabsTool.unpinTab();
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
      case 'setMode':
        await setState({ mode: msg.mode });
        sendResponse({ ok: true });
        break;
      case 'setBridge':
        await setState({ bridge: { host: msg.host, port: Number(msg.port), token: msg.token ?? '' } });
        transport.connectNow();
        sendResponse({ ok: true });
        break;
      case 'reconnect':
        // User is watching — skip any pending backoff and try right now.
        transport.connectNow();
        sendResponse({ ok: true });
        break;
      case 'halt':
        await setState({ halted: true });
        await logActivity({ kind: 'system', ok: false, detail: 'STOP pressed by user' });
        sendResponse({ ok: true });
        break;
      case 'resume':
        await setState({ halted: false });
        await logActivity({ kind: 'system', ok: true, detail: 'Resumed by user' });
        sendResponse({ ok: true });
        break;
      case 'clearLog':
        await clearActivity();
        sendResponse({ ok: true });
        break;
      // The panel drives recording and issues through the same tool
      // implementations the agent uses. Two entry points, one behaviour —
      // a QA and an agent must never get different results from one button.
      case 'recStatus': {
        const tab = await tabsTool.resolveTarget().catch(() => null);
        sendResponse({ ok: true, status: tab ? await record.recordingStatus(tab.id) : { recording: false },
                       recordings: await store.listRecordings() });
        break;
      }
      case 'recStart': {
        const tab = await tabsTool.resolveTarget();
        sendResponse({ ok: true, ...(await record.startRecording(tab.id, { name: msg.name })) });
        break;
      }
      case 'recStop': {
        const tab = await tabsTool.resolveTarget();
        sendResponse({ ok: true, ...(await record.stopRecording(tab.id)) });
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
      case 'issueList':
        sendResponse({ ok: true, issues: await store.listIssues(), usage: await store.usage() });
        break;
      case 'issueCreate': {
        const tab = await tabsTool.resolveTarget();
        const issue = await issues.createIssue(tab.id, msg);
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
        const tab = await tabsTool.resolveTarget();
        sendResponse({ ok: true, attachment: await issues.attachScreenshot(tab.id, msg.id, { area: msg.area }) });
        break;
      }
      case 'issueRecapture': {
        const tab = await tabsTool.resolveTarget();
        sendResponse({ ok: true, ...(await issues.recapture(tab.id, msg.id)) });
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
        sendResponse({ ok: true, ...(await store.deleteIssue(msg.id)) });
        break;
      case 'videoStart': {
        const tab = await tabsTool.resolveTarget();
        sendResponse({ ok: true, ...(await issues.startVideo(tab.id)) });
        break;
      }
      case 'videoStop': {
        const tab = await tabsTool.resolveTarget();
        sendResponse({ ok: true, ...(await issues.stopVideo(tab.id, msg.id)) });
        break;
      }
      case 'listTabs':
        sendResponse({ ok: true, tabs: await tabsTool.listTabs() });
        break;
      case 'shutdown':
        await detachAll();
        transport.disconnect();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: `Unknown command ${msg.cmd}` });
    }
  })().catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));

  return true; // keep the message channel open for the async response
});
