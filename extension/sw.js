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
import { detachAll, evaluate } from './lib/cdp.js';
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

const api = globalThis.browser ?? globalThis.chrome;

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
  observe.ingest(source.tabId, method, params).catch(() => {});

  // A committed navigation invalidates every element ref for that tab.
  if (method === 'Page.frameNavigated' && !params.frame.parentId) {
    clearRefs(source.tabId).catch(() => {});
  }

  // Surface dialogs immediately — they block the page until handled.
  if (method === 'Page.javascriptDialogOpening') {
    broadcast({ type: 'dialog', tabId: source.tabId, message: params.message, dialogType: params.type });
    transport.send({ type: 'event', event: 'dialog', tabId: source.tabId, data: params });
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
});

// --------------------------------------------------------------- tool routing

/**
 * The tool table. Each entry receives ({ tabId, tab, args }) and returns a
 * JSON-serializable result. Keeping this flat and declarative means adding a
 * capability is a one-line change plus a schema entry in the bridge.
 */
const TOOLS = {
  // --- session -------------------------------------------------------------
  browser_status: { needsTab: false, run: () => status() },

  browser_tabs: {
    needsTab: false,
    run: async ({ args }) => {
      switch (args.action ?? 'list') {
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
          throw new Error(`Unknown tabs action "${args.action}".`);
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

  // --- diagnosis -----------------------------------------------------------
  browser_diagnose: {
    run: ({ tabId, args }) =>
      (args.what ?? 'health') === 'performance'
        ? diagnose.performance(tabId, args)
        : diagnose.health(tabId),
  },
};

function requireTabId(args) {
  if (args.tabId == null) throw new Error('This action needs a tabId. Call browser_tabs with action:"list" first.');
  return args.tabId;
}

/** Live session state — the agent's orientation tool. */
async function status() {
  const state = await getState();
  const tabs = await tabsTool.listTabs();
  const pinned = tabs.find((t) => t.tabId === state.pinnedTabId) ?? null;

  let health = null;
  if (pinned) {
    const [logs, net] = await Promise.all([
      observe.consoleLog(state.pinnedTabId, { limit: 0 }).catch(() => null),
      observe.network(state.pinnedTabId, { limit: 0 }).catch(() => null),
    ]);
    health = {
      consoleErrors: logs?.counts?.error ?? 0,
      consoleWarnings: logs?.counts?.warning ?? 0,
      consoleTotal: logs?.total ?? 0,
      networkRequests: net?.total ?? 0,
      failedRequests: net?.failedCount ?? 0,
    };
  }

  return {
    connected: transport.isConnected(),
    mode: state.mode,
    halted: state.halted,
    bridge: { host: state.bridge.host, port: state.bridge.port },
    attached: pinned
      ? { tabId: pinned.tabId, title: pinned.title, url: pinned.url, active: pinned.active }
      : null,
    health,
    otherTabs: tabs
      .filter((t) => t.tabId !== state.pinnedTabId && t.attachable)
      .slice(0, 25)
      .map((t) => ({ tabId: t.tabId, title: t.title, url: t.url, active: t.active })),
    hint: pinned
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
        sendResponse({ ok: true, state: await getState(), status: await status() });
        break;
      }
      case 'attachActive': {
        const active = await tabsTool.getActiveTab();
        if (!active) throw new Error('No active tab.');
        const tab = await tabsTool.pinTab(active.id);
        sendResponse({ ok: true, tab: { id: tab.id, title: tab.title, url: tab.url } });
        break;
      }
      case 'attachTab': {
        const tab = await tabsTool.pinTab(msg.tabId);
        sendResponse({ ok: true, tab: { id: tab.id, title: tab.title, url: tab.url } });
        break;
      }
      case 'detach':
        await tabsTool.unpinTab();
        sendResponse({ ok: true });
        break;
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
