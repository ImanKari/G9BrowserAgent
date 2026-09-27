/**
 * Tool routing: every `browser_*` call from every agent passes through here.
 *
 *   halt check → target resolution (tabId | session | the agent's current tab |
 *   the default engine's current tab) → ownership → per-tab queue →
 *   Engine 1 (relay to the extension, ids rewritten both ways) or
 *   Engine 2 (EngineManager.runTool, in this process)
 *
 * The daemon is still "deliberately dumb" about PAGES, as the v1 bridge was:
 * it never clicks, reads or waits on a page itself — the same tool modules do
 * that in either engine. What it owns is everything BETWEEN pages and agents:
 * which tab a call is about, whose it is, whether it may run now, and which
 * engine runs it. That is the part v1 could not express, because v1 had one
 * agent, one extension and one socket.
 *
 * Ids: an agent only ever sees daemon handles. Engine 1 speaks Chrome tab ids,
 * so every numeric `tabId`/`openerTabId` and every element of `tabIds` is
 * rewritten on the way to the extension and on the way back — including ids the
 * daemon has never seen, which get a fresh handle (a popup the page opened is a
 * real tab the agent may want next).
 */

import { TOOL_NAMES } from '../mcp/tools.js';
import { handoff as runHandoff } from './handoff.js';

// ------------------------------------------------------------------ pure helpers

const ID_KEYS = new Set(['tabId', 'openerTabId']);
const MAX_DEPTH = 64;

/**
 * Fields whose contents are DATA, never tab references: what an agent hands in
 * (replay variables, an import bundle, a FlowSpec, a HAR, intercept rules, an
 * assertion's expected value, environment/parameters) and what a page hands
 * back (`browser_console evaluate`'s value, a spec's canonical json). A
 * `tabId` key inside them belongs to the user's data: rewriting it either
 * failed the call ("Tab 3 does not exist" for a variable named tabId) or
 * silently changed the number and minted a handle for a tab that never existed.
 */
export const OPAQUE_KEYS = new Set(['variables', 'bundle', 'spec', 'har', 'rules', 'expected', 'environment', 'parameters', 'value', 'json', 'dataBase64']);

/**
 * Rewrite tab ids in a JSON value. `map(n, key)` returns the replacement for a
 * numeric id under `key` ('tabId' | 'openerTabId' | 'tabIds'). Returns a new
 * value; the input is not modified. Values under OPAQUE_KEYS are copied as they are.
 */
export function rewriteTabIds(value, map, depth = 0) {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => rewriteTabIds(item, map, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (OPAQUE_KEYS.has(key)) {
      out[key] = item;
    } else if (ID_KEYS.has(key) && typeof item === 'number' && Number.isInteger(item)) {
      out[key] = map(item, key);
    } else if (key === 'tabIds' && Array.isArray(item)) {
      out[key] = item.map((x) => (typeof x === 'number' && Number.isInteger(x) ? map(x, 'tabIds') : rewriteTabIds(x, map, depth + 1)));
    } else {
      out[key] = rewriteTabIds(item, map, depth + 1);
    }
  }
  return out;
}

/**
 * Which calls may run on a tab someone else owns, and outside the per-tab queue.
 *
 * The authoritative classifier is `isReadOnly` in extension/tools/index.js —
 * the same table both engines use. This fallback is used ONLY while that module
 * cannot be loaded (a broken build must still let an agent read status), and it
 * errs towards "mutating": wrongly queueing a read costs latency, wrongly
 * letting a write past ownership costs someone's session.
 */
export function fallbackIsReadOnly(tool, args = {}) {
  const action = args.action;
  switch (tool) {
    case 'browser_status':
    case 'browser_snapshot':
    case 'browser_inspect':
      return true;
    case 'browser_screenshot':
      // As tools/index.js isReadOnly: an element or full-page capture scrolls or resizes the page.
      return (args.area ?? 'viewport') === 'viewport';
    case 'browser_console':
      return (action ?? 'read') === 'read' && !args.clear;
    case 'browser_network':
      return [undefined, 'list', 'pin_status', 'intercept_status', 'downloads'].includes(action) && !args.clear;
    case 'browser_diagnose':
      return [undefined, 'health', 'vitals', 'memory'].includes(args.what);
    case 'browser_tabs':
      return [undefined, 'list', 'sessions', 'watch'].includes(action);
    case 'browser_recording':
      return [undefined, 'list', 'get', 'status', 'known_world', 'signature', 'export', 'export_spec', 'export_test'].includes(action);
    case 'browser_issue':
      return [undefined, 'list', 'get', 'attachment'].includes(action);
    case 'browser_engine':
      return [undefined, 'list'].includes(action) || (action === 'versions' && !args.download);
    default:
      return false;
  }
}

/**
 * How long a call that ran past its deadline is given to STOP before the daemon answers anyway.
 * The call is aborted at the deadline (its input stops at the next step, as for Stop) and the
 * tab's queue stays held until it has stopped or this runs out: the next call on that tab must
 * never run while the old one is still sending input (docs review, 2026-09-22: a type that hit
 * its deadline kept typing into the Submit button the next call had clicked — 24 extra presses).
 */
export const STOP_GRACE_MS = 5_000;

/**
 * An upper bound of the time a humanized `type`/`key` spends on its own input, per character:
 * the human profile's median inter-key interval is 140 ms (x1.6 after spaces and punctuation, x2
 * before a shifted key, clamped at 1.5 s), stealth's 160 ms; about 6 characters a second. A flat
 * 120 s base ran out at roughly 650-750 characters of plain typing. The daemon cannot see a
 * calibrated profile, so this is a fixed, conservative figure, not the profile's own.
 */
export const INPUT_MS_PER_CHAR = 450;

/** Extra deadline a browser_interact call needs for its own typing (0 for everything else). */
export function interactInputMs(args = {}) {
  const a = args ?? {};
  if (a.action === 'type' && a.fast !== true) return String(a.text ?? '').length * INPUT_MS_PER_CHAR;
  if (a.action === 'key') return Math.max(0, Math.min(10_000, Number(a.repeat) || 1) - 1) * INPUT_MS_PER_CHAR;
  return 0;
}

/**
 * Per-call deadline. One number for everything was wrong in v1 (a 60 s bridge
 * timeout under a runner that allowed 600 s for a replay): the deadline has to
 * follow what the call itself asked for, with the base as a floor.
 */
export function timeoutFor(tool, args = {}, base = 120_000) {
  const t = (n) => Math.max(base, n);
  const asked = (fallback) => (Number.isFinite(Number(args.timeoutMs)) && Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : fallback);
  switch (tool) {
    case 'browser_interact':
      return base + interactInputMs(args);
    case 'browser_recording':
      if (args.action === 'replay' || args.action === 'calibrate') return t(30 * 60_000);
      return base;
    case 'browser_diagnose':
      return args.what === 'performance' ? t((Number(args.durationMs) || 4_000) + 60_000) : base;
    case 'browser_navigate':
      return t(asked(args.action === 'wait' ? 15_000 : 30_000) + 15_000);
    case 'browser_network':
      return args.action === 'wait_download' ? t(asked(30_000) + 15_000) : base;
    case 'browser_tabs':
      if (args.action === 'wait') return t(asked(15_000) + 15_000);
      if (args.action === 'open' || args.action === 'handoff' || args.action === 'session') return t(180_000);
      return base;
    case 'browser_engine':
      if (args.action === 'versions' && args.download) return t(30 * 60_000);
      if (args.action === 'launch' || args.action === 'warm') return t(180_000);
      return base;
    default:
      return base;
  }
}

/** Tab-free store actions vs actions that act on a page, per store tool. */
const PAGE_ACTIONS = {
  browser_recording: new Set(['start', 'stop', 'replay', 'assert', 'suggest', 'calibrate', 'status']),
  browser_issue: new Set(['create', 'screenshot', 'video_start', 'video_stop', 'video_status']),
};
/** Store actions that CREATE something: they go to one store, never "whichever has it". */
const CREATE_ACTIONS = new Set(['import', 'import_spec', 'create']);

const NOT_FOUND = /\bNo (recording|issue|attachment|flow)\b|not found in this browser|has not been replayed yet/i;

/** What a store learns about a flow by running it; never part of a FlowSpec (daemon/flows.js LOCAL_ONLY). */
const LOCAL_TRUTH = ['runHistory', 'lastRun', 'flaky', 'knownWorld', 'surpriseHistory', 'lastSignature'];

const TABS_ACTIONS = ['list', 'open', 'close', 'focus', 'attach', 'claim', 'release', 'popout', 'handoff', 'session', 'sessions', 'end_session', 'wait', 'watch'];

/**
 * An input error's delivery state ("not-delivered" | "missed" | "partial"), carried as fields from
 * the engine's result to the agent's (DAEMON_PROTOCOL §3/§4): the message already starts with the
 * [delivery: …] tag, the fields are for programs (the runner, the desktop's activity).
 */
export function withDelivery(error, from) {
  if (typeof from?.delivery !== 'string') return error;
  error.delivery = from.delivery;
  if (from.hit != null) error.hit = from.hit;
  if (from.hidden === true) error.hidden = true;
  return error;
}

/** The fields of an Error's delivery state, for a result message; {} when it has none. */
export function deliveryFields(err) {
  return typeof err?.delivery === 'string' ? { delivery: err.delivery, hit: err.hit ?? null, hidden: err.hidden === true } : {};
}

function stripRouting(args) {
  const { session, engine, context, ...rest } = args ?? {};
  return rest;
}

// ------------------------------------------------------------------ the router

export class Router {
  /**
   * @param {object} o
   * @param {import('./registry.js').Registry} o.registry
   * @param {import('../engine/manager.js').EngineManager} o.engines
   */
  constructor({ registry, engines, evidence, settings, log = () => {}, version, info = () => ({}), timeoutMs = 120_000, flows = null }) {
    this.registry = registry;
    this.engines = engines;
    this.evidence = evidence;
    this.settings = settings;
    this.log = log;
    this.version = version;
    this.info = info; // () => { pid, port, home, repoRoot, startedAt }
    this.timeoutMs = timeoutMs;
    this.flows = flows;

    this.nextRelayId = 1;
    this.pending = new Map(); // relay id → { resolve, reject, timer, tool, handle, engineId }
    this.local = new Map(); // local call id → { reject, tool, handle, engineId }
    this.nextLocalId = 1;
    this.extTabs = new Map(); // engineId → last `tabs` rows (handles)
  }

  // ------------------------------------------------------------ helpers

  isReadOnly(tool, args) {
    const fn = this.engines?.isReadOnlyFn?.();
    if (typeof fn === 'function') {
      try {
        return !!fn(tool, args ?? {});
      } catch {
        /* fall through */
      }
    }
    return fallbackIsReadOnly(tool, args ?? {});
  }

  #extensionClient(engineId = null) {
    const engines = this.registry.extensionEngines();
    if (engineId) return engines.find((e) => e.id === engineId) ?? null;
    // The most recently connected extension is the default: it is the browser
    // the person most recently opened or reloaded.
    return engines.sort((a, b) => b.connectedAt - a.connectedAt)[0] ?? null;
  }

  #kindOf(handle) {
    return this.registry.engineKind(this.registry.engineOf(handle));
  }

  /**
   * The caller as engines see it. Null for the daemon's own reads (the desktop's first-render `state`).
   *
   * `relayed: true` (F7) marks a call the DAEMON sent. The engine logs it too
   * (its activity record carries `relayed`), and the daemon — which already
   * reported the agent's call to the desktop itself — does not forward that
   * echo, so the desktop shows each agent call once. Records without the tag
   * (the person acting in the side panel) are still forwarded.
   */
  #caller(client) {
    return client ? { agentId: client.id, name: client.name, relayed: true } : { agentId: null, name: 'g9d', relayed: true };
  }

  /**
   * The halt check again, at the moment a queued call actually starts. A call
   * that waited behind a long replay must not run because Stop was pressed
   * AFTER it arrived — "every tool fails while halted" covers the queue too.
   */
  #checkHalt(client) {
    const halted = this.registry.haltError(client.id);
    if (halted) throw new Error(halted);
  }

  /**
   * Everything a call must still be true when its TURN comes, not only when it arrived: the agent
   * is still connected, nobody pressed Stop, and — for a state-changing call — the tab is still
   * the caller's. Only the halt used to be re-checked here; a click queued behind a long type
   * still ran after its agent disconnected (its claims released, another agent then took the
   * tab), or after another agent took the tab over with claim force:true — on someone else's
   * tab, before their own call (daemon review, 2026-09-22). The liveness check comes first:
   * otherwise ensureOwnership would claim the tab again for an agent that is gone. A tab that is
   * unowned now (the agent released it while the call waited) is claimed again, as any first
   * mutating call claims it. Also run at the moment a launched-engine call gets its maxParallel
   * slot (EngineManager precheck), which can be long after its queue turn.
   */
  #atTurn(client, handle, { mutating = true } = {}) {
    if (client?.id != null && this.registry.getClient(client.id) !== client) {
      throw new Error('The agent that sent this call disconnected before its turn came, so it was not run.');
    }
    this.#checkHalt(client);
    if (mutating && handle != null && this.registry.hasHandle(handle)) this.registry.ensureOwnership(handle, client.id);
  }

  /** The tabs this handle's engine is, as a routing target. */
  #targetOf(handle) {
    const engineId = this.registry.engineOf(handle);
    const kind = this.registry.engineKind(engineId);
    if (!engineId || !kind) {
      throw new Error(`Tab ${handle} no longer exists — its browser engine is gone. Call browser_tabs action:"list".`);
    }
    if (kind === 'extension' && this.registry.isParked(engineId)) throw reconnectingError(handle, engineId);
    return kind === 'extension' ? { kind, engineId, client: this.#extensionClient(engineId) } : { kind, engineId };
  }

  #noEngineError() {
    return new Error(
      'No browser engine is available. Either open a tab with browser_tabs action:"open" url:"…" ' +
        '(G9BrowserAgent launches a headless Chrome/Edge for it), or ask the user to open their browser with the G9BrowserAgent extension ' +
        'enabled so it connects to the daemon.',
    );
  }

  // ------------------------------------------------------------ relay (Engine 1)

  /**
   * Send a call to an extension engine and await its result, with tab ids
   * rewritten in both directions. `args` carry daemon handles.
   */
  relay(engineClient, tool, args, caller, { timeoutMs = null, handle = null, agentId = null } = {}) {
    if (!engineClient) {
      return Promise.reject(new Error('The browser extension is not connected (it may be reconnecting). Retry in a few seconds; if it persists, ask the user to check that the browser is open.'));
    }
    const engineId = engineClient.id;
    let outArgs;
    try {
      outArgs = rewriteTabIds(args ?? {}, (n, key) => {
        const chrome = this.registry.chromeTabOf(n, engineId);
        if (chrome == null) {
          const other = this.registry.engineOf(n);
          throw new Error(
            other
              ? `Tab ${n} (${key}) belongs to ${other}, not to the browser this call went to (${engineId}).`
              : `Tab ${n} (${key}) does not exist. Call browser_tabs action:"list" — tab ids are G9BrowserAgent handles, not Chrome tab ids.`,
          );
        }
        return chrome;
      });
    } catch (err) {
      return Promise.reject(err);
    }
    const ms = timeoutMs ?? timeoutFor(tool, args, this.timeoutMs);
    return new Promise((resolve, reject) => {
      if (!engineClient.send || this.registry.getClient(engineId) == null) {
        reject(new Error('The browser extension disconnected. Ask the user to check that the browser is still open.'));
        return;
      }
      const id = this.nextRelayId++;
      const secs = Math.round(ms / 1000);
      // Past the deadline the call is CANCELLED in the extension (its input stops at the next
      // step) and its answer is awaited a little longer, so the tab's queue is not released while
      // it may still be typing. An extension without cancel support ignores the message; then the
      // answer after the grace says the call may still be running.
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        entry.overdue = secs;
        try { engineClient.send?.({ type: 'cancel', id }); } catch { /* the socket is going */ }
        entry.graceTimer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new Error(
            `"${tool}" did not respond within ${secs}s. G9BrowserAgent asked the extension to stop it, but it has not answered, so it ` +
              'may STILL be running on this tab: take a browser_snapshot before sending this tab more input. Likely causes: ' +
              'the page is stuck loading, the tab is hidden, or a JavaScript dialog G9BrowserAgent did not see is open (browser_dialog handles one).',
          ));
        }, STOP_GRACE_MS);
        entry.graceTimer.unref?.();
      }, ms);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (result) => resolve(rewriteTabIds(result, (n) => this.registry.handleForChrome(engineId, n))),
        reject,
        timer,
        graceTimer: null,
        overdue: null,
        tool,
        handle,
        engineId,
        agentId,
        client: engineClient,
      });
      const sent = engineClient.send({ type: 'call', id, tool, args: outArgs, caller });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('The browser extension connection dropped while sending the call.'));
      }
    });
  }

  /** `{type:'result'}` from an extension engine. */
  onRelayResult(engineClient, msg) {
    const entry = this.pending.get(msg.id);
    if (!entry || entry.engineId !== engineClient.id) return;
    clearTimeout(entry.timer);
    clearTimeout(entry.graceTimer);
    this.pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else {
      const text = String(msg.error ?? 'The extension reported an error with no message.');
      entry.reject(withDelivery(new Error(entry.overdue != null ? overdueMessage(entry.tool, entry.overdue, text) : text), msg));
    }
  }

  /**
   * A per-agent Stop: that agent's calls already running are cancelled now (their input stops at
   * the next step), as the global Stop stops everyone's. Its queued calls fail at their turn.
   */
  cancelFor(agentId, reason = 'The user stopped this agent.') {
    for (const [id, entry] of this.pending) {
      if (entry.agentId !== agentId) continue;
      try { entry.client?.send?.({ type: 'cancel', id }); } catch { /* going */ }
    }
    for (const entry of this.local.values()) {
      if (entry.agentId === agentId) entry.abort(new Error(reason));
    }
  }

  /** Calls relayed to this engine and not yet answered (the extension reloads only when this is 0). */
  inFlight(engineId) {
    let n = 0;
    for (const entry of this.pending.values()) if (entry.engineId === engineId) n += 1;
    return n;
  }

  /** An engine went away: every call waiting on it fails now, with the reason, not at its timeout. */
  failEngine(engineId, reason) {
    for (const [id, entry] of this.pending) {
      if (entry.engineId !== engineId) continue;
      clearTimeout(entry.timer);
      clearTimeout(entry.graceTimer);
      this.pending.delete(id);
      entry.reject(new Error(reason));
    }
    for (const [id, entry] of this.local) {
      if (entry.engineId !== engineId) continue;
      this.local.delete(id);
      entry.reject(new Error(reason));
    }
    this.extTabs.delete(engineId);
  }

  /**
   * A JavaScript dialog froze a page: fail every pending call on that tab now,
   * with the recovery named, instead of letting each sit to its timeout.
   * `browser_dialog` is the call that will fix it and is never failed.
   */
  failForDialog(engineId, handle, data = {}) {
    const kind = data.type ?? data.dialogType ?? 'dialog';
    const text = String(data.message ?? '').slice(0, 200);
    const message =
      `The page opened a JavaScript ${kind} ("${text}") which blocks it until handled, so this call cannot ` +
      `complete. Call browser_dialog to accept or dismiss it${handle != null ? ` (tabId:${handle})` : ''}, then retry.`;
    const hits = (entry) => entry.tool !== 'browser_dialog' && entry.engineId === engineId &&
      (handle == null || entry.handle === handle);
    for (const [id, entry] of this.pending) {
      if (!hits(entry)) continue;
      clearTimeout(entry.timer);
      clearTimeout(entry.graceTimer);
      this.pending.delete(id);
      // The blocked call resumes when the dialog is handled: it must not carry on typing then.
      try { entry.client?.send?.({ type: 'cancel', id }); } catch { /* going */ }
      entry.reject(new Error(message));
    }
    for (const [id, entry] of this.local) {
      if (!hits(entry)) continue;
      this.local.delete(id);
      entry.reject(new Error(message));
    }
  }

  /**
   * Run an Engine 2 call with the same deadline and dialog rules as a relay.
   *
   * `fn(ctl)` gets `{ signal, onQueued, onStart }` for EngineManager.runTool. Two phases, two
   * bounds (daemon review, 2026-09-22):
   * - **Waiting for a maxParallel slot** (onQueued … onStart) is bounded by the call's deadline and
   *   ends with its own answer — "[delivery: not-delivered] waited Ns for one of maxParallel=K
   *   slots … nothing was sent to the page" — and the waiter is removed, so the call never runs
   *   later. It used to count against the call's deadline, report a "JavaScript dialog", and stay
   *   parked: the click the agent was told had failed ran minutes later, beside its own retry.
   * - **Running** gets the full deadline from the moment its slot was granted. At the deadline it
   *   is ABORTED (the signal reaches lib/humanize.js perform, which stops between input steps)
   *   and its answer is awaited for STOP_GRACE_MS more — the tab's queue is held meanwhile, so the
   *   next call on that tab never overlaps the old one's input.
   */
  #local(engineId, handle, tool, fn, timeoutMs, { agentId = null } = {}) {
    const id = this.nextLocalId++;
    const controller = new AbortController();
    const secs = Math.round(timeoutMs / 1000);
    return new Promise((resolve, reject) => {
      let settled = false;
      let phase = 'running';
      let gate = null;
      let timer = null;
      let graceTimer = null;
      const done = () => {
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        this.local.delete(id);
      };
      const entry = {
        tool,
        handle,
        engineId,
        agentId,
        overdue: false,
        abort: (reason) => {
          if (!controller.signal.aborted) controller.abort(reason instanceof Error ? reason : new Error(String(reason)));
        },
        reject: (err) => {
          if (settled) return;
          done();
          entry.abort(err);
          reject(err);
        },
      };
      const onDeadline = () => {
        if (settled) return;
        if (phase === 'slot') {
          const err = withDelivery(new Error(
            `[delivery: not-delivered] "${tool}" waited ${secs}s for one of maxParallel=${gate?.max ?? '?'} slots for ` +
              'launched-engine calls, all in use by other calls; nothing was sent to the page. Retry it, or raise ' +
              'maxParallel in the G9BrowserAgent settings.',
          ), { delivery: 'not-delivered' });
          done();
          entry.abort(err);
          reject(err);
          return;
        }
        entry.overdue = true;
        entry.abort(new Error(`it ran past its ${secs}s deadline`));
        graceTimer = setTimeout(() => {
          if (settled) return;
          done();
          reject(new Error(
            `"${tool}" did not finish within ${secs}s. G9BrowserAgent asked it to stop, but it has not stopped yet, so it may STILL be ` +
              'running on this tab: take a browser_snapshot before sending this tab more input. Likely causes: the page is ' +
              'stuck loading, or a JavaScript dialog G9BrowserAgent did not see is open (browser_dialog handles one).',
          ));
        }, STOP_GRACE_MS);
        graceTimer.unref?.();
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(onDeadline, timeoutMs);
        timer.unref?.();
      };
      arm();
      this.local.set(id, entry);
      const ctl = {
        signal: controller.signal,
        onQueued: (info) => {
          phase = 'slot';
          gate = info ?? {};
        },
        onStart: () => {
          if (phase !== 'slot') return;
          phase = 'running';
          if (!settled && !entry.overdue) arm();
        },
      };
      Promise.resolve()
        .then(() => fn(ctl))
        .then(
          (value) => {
            if (settled) return;
            done();
            resolve(value);
          },
          (err) => {
            if (settled) return;
            done();
            if (entry.overdue) {
              const wrapped = new Error(overdueMessage(tool, secs, String(err?.message ?? err)));
              reject(Object.assign(wrapped, deliveryFields(err)));
            } else {
              reject(err);
            }
          },
        );
    });
  }

  // ------------------------------------------------------------ entry point

  /**
   * Run one tool call for a client (agent or UI). Throws an Error whose message
   * the agent reads — every refusal names its reason and its fix.
   */
  async call(client, tool, args = {}) {
    if (!TOOL_NAMES.includes(tool)) {
      throw new Error(`Unknown tool "${tool}". Known: ${TOOL_NAMES.join(', ')}.`);
    }
    args = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};

    if (tool !== 'browser_status') {
      const halted = this.registry.haltError(client.id);
      if (halted) throw new Error(halted);
    }

    switch (tool) {
      case 'browser_status':
        return this.#status(client, args);
      case 'browser_engine':
        return this.#engineTool(client, args);
      case 'browser_tabs':
        return this.#tabs(client, args);
      case 'browser_recording':
      case 'browser_issue':
        if (!PAGE_ACTIONS[tool].has(args.action ?? 'list')) return this.#store(client, tool, args);
        return this.#pageTool(client, tool, args);
      default:
        return this.#pageTool(client, tool, args);
    }
  }

  // ------------------------------------------------------------ target resolution

  /**
   * Which tab a call is about: explicit `tabId` → `session` → the agent's
   * current tab → the default engine's current tab (which then BECOMES the
   * agent's current tab, so a conversation keeps acting on one page even if the
   * person clicks elsewhere).
   */
  async #resolve(client, args, { require = true } = {}) {
    if (args.tabId != null && args.tabId !== '') {
      const handle = Number(args.tabId);
      if (!Number.isInteger(handle) || !this.registry.hasHandle(handle)) {
        throw new Error(
          `Tab ${args.tabId} does not exist. Call browser_tabs action:"list" — tab ids are G9BrowserAgent handles ` +
            '(shared by every engine), not Chrome tab ids.',
        );
      }
      return handle;
    }
    if (args.session) return this.registry.sessionHandle(String(args.session));

    const current = this.registry.current(client.id);
    if (current != null) return current;

    const handle = await this.#defaultTab(client);
    if (handle == null) {
      if (!require) return null;
      if (!this.registry.extensionEngines().length && !this.engines.list().length) throw this.#noEngineError();
      throw new Error('No tab to act on. Open one with browser_tabs action:"open", or attach one with browser_tabs action:"attach".');
    }
    this.registry.setCurrent(client.id, handle);
    return handle;
  }

  /**
   * May this tab become the caller's current tab by default? Not when another
   * connected agent owns it: a second agent that latched onto the first one's
   * page would have its first action refused and its implicit reads land on
   * someone else's work. An explicit tabId/session is never subject to this.
   */
  #availableTo(client, handle) {
    const owner = this.registry.ownerOf(handle);
    return !owner || owner === client?.id || !this.registry.getClient(owner);
  }

  /** The default engine's own idea of "the current tab", among the tabs this caller may take. */
  async #defaultTab(client) {
    const ext = this.#extensionClient();
    if (ext) {
      const handle = await this.#extensionDefaultTab(client, ext);
      if (handle != null) return this.#availableTo(client, handle) ? handle : null;
    }
    const last = this.engines.currentTab?.() ?? null;
    if (last != null && this.#availableTo(client, last)) return last;
    // Newest first: the tab opened last is the likeliest one meant — never a browser-internal
    // page (Edge's own edge://downloads-hub/ tab after a download), which every tool refuses.
    for (const engine of this.engines.list?.() ?? []) {
      if (engine.starting || engine.stopping) continue; // not handed out before its setup finished
      const tabs = [...(engine.tabs ?? [])].sort((a, b) => b - a);
      const tab = tabs.find((h) => this.registry.hasHandle(h) && this.#availableTo(client, h) && this.engines.isControllable?.(h) !== false);
      if (tab != null) return tab;
    }
    return null;
  }

  /** Which tab an extension would act on (its attached/current tab, else the active tab of the person's last window). */
  async #extensionDefaultTab(client, ext) {
    try {
      const status = await this.relay(ext, 'browser_status', {}, this.#caller(client), { timeoutMs: 15_000 });
      const handle = pickStatusTarget(status);
      if (handle != null && this.registry.hasHandle(handle)) return handle;
    } catch {
      /* fall through to the cached list */
    }
    const rows = this.extTabs.get(ext.id) ?? [];
    const row = rows.find((r) => r.current) ?? null;
    return row && this.registry.hasHandle(row.tabId) ? row.tabId : null;
  }

  // ------------------------------------------------------------ page tools

  async #pageTool(client, tool, args, { handle: forcedArg = null } = {}) {
    const caller = this.#caller(client);
    let forced = forcedArg;
    let forcedHere = false;

    // `engine:"launched"` on a replay means "run it in the background": make
    // sure there is an Engine 2 tab on the recording's start URL.
    if (tool === 'browser_recording' && args.action === 'replay' && forced == null) {
      const wanted = this.#wantsLaunched(args.engine);
      if (wanted) {
        let explicit = null;
        if (args.tabId != null || args.session) explicit = await this.#resolve(client, args);
        if (explicit == null || this.#kindOf(explicit) !== 'launched') {
          forced = await this.#launchedTabForReplay(client, args, wanted);
          forcedHere = true;
        }
      }
    }

    const handle = forced ?? (await this.#resolveFor(client, args));
    const target = this.#targetOf(handle);
    const readOnly = this.isReadOnly(tool, args);
    if (!readOnly) this.registry.ensureOwnership(handle, client.id);

    const forward = { ...stripRouting(args), tabId: handle };
    const timeoutMs = timeoutFor(tool, args, this.timeoutMs);

    const execute = async () => {
      this.#atTurn(client, handle, { mutating: !readOnly });
      if (target.kind === 'extension') {
        // Resolved again at the call's turn: the socket it was queued for may have been
        // replaced by a reconnect of the same extension (D-c) while it waited.
        const live = this.#extensionClient(target.engineId);
        if (!live && this.registry.isParked(target.engineId)) throw reconnectingError(handle, target.engineId);
        if (!live) throw new Error('The browser extension disconnected. Ask the user to check that the browser is still open.');
        target.client = live;
        return this.relay(target.client, tool, forward, caller, { timeoutMs, handle, agentId: client.id });
      }
      if (tool === 'browser_recording' && (args.action === 'replay' || args.action === 'calibrate') && args.id) {
        await this.#ensureInLaunchedStore(args.id, caller);
      }
      return this.#local(target.engineId, handle, tool, (ctl) => this.engines.runTool(tool, forward, caller, {
        ...ctl,
        // Checked again when the call gets its maxParallel slot, which can be long after its turn.
        precheck: () => this.#atTurn(client, handle, { mutating: !readOnly }),
      }), timeoutMs, { agentId: client.id });
    };

    // Reads are never queued; browser_dialog is the call that unblocks a queue
    // stuck behind a dialog, so it must not wait in that queue itself.
    const result = readOnly || tool === 'browser_dialog' ? await execute() : await this.registry.enqueue(handle, execute);
    if (forcedHere && result && typeof result === 'object' && !Array.isArray(result)) {
      // The replay opened this tab itself; say which, so the agent can read it,
      // act on it or close it rather than leave one tab behind per replay.
      return { ...result, ranOn: { tabId: handle, engine: this.registry.engineOf(handle), openedForThisReplay: true } };
    }
    return result;
  }

  /**
   * Target for a page tool. `engine:"extension"` (the runner's --engine
   * extension) means the person's browser even when the caller's current tab
   * is a launched one — honoured, not silently ignored.
   */
  async #resolveFor(client, args) {
    const explicit = (args.tabId != null && args.tabId !== '') || !!args.session;
    if (!explicit && args.engine && (args.engine === 'extension' || this.registry.engineKind(args.engine) === 'extension')) {
      const ext = this.#extensionClient(args.engine === 'extension' ? null : args.engine);
      if (!ext) throw new Error('No extension engine is connected, so engine:"extension" has no tab to act on.');
      const current = this.registry.current(client.id);
      if (current != null && this.registry.engineOf(current) === ext.id) return current;
      const handle = await this.#extensionDefaultTab(client, ext);
      if (handle == null) throw new Error('The extension has no tab to act on. Attach one (browser_tabs action:"attach") or open one.');
      // Named explicitly, so it is used — but it only becomes this caller's
      // current tab when no other agent owns it (the default-tab rule).
      if (this.#availableTo(client, handle)) this.registry.setCurrent(client.id, handle);
      return handle;
    }
    return this.#resolve(client, args);
  }

  #wantsLaunched(engine) {
    if (!engine) return null;
    if (engine === 'launched') return 'launched';
    if (this.registry.engineKind(engine) === 'launched') return engine;
    if (engine === 'extension' || this.registry.engineKind(engine) === 'extension') return null;
    throw new Error(`Unknown engine "${engine}". Use "extension", "launched", or an engineId from browser_engine action:"list".`);
  }

  /** Open an Engine 2 tab on the recording's start URL, launching the default engine if needed. */
  async #launchedTabForReplay(client, args, wanted) {
    if (!args.id) throw new Error('action:"replay" needs an id. Use action:"list" to see what exists.');
    const caller = this.#caller(client);
    const recording = await this.#ensureInLaunchedStore(args.id, caller);
    const engineId = await this.#launchedEngineId(wanted === 'launched' ? null : wanted);
    const url = recording?.startUrl || 'about:blank';
    const opened = await this.engines.openTab(engineId, args.context ?? null, url);
    this.registry.ensureOwnership(opened.tabId, client.id);
    this.registry.setCurrent(client.id, opened.tabId);
    return opened.tabId;
  }

  /** A running launched engine (the given one, else the first), launching the default one when none runs. */
  async #launchedEngineId(engineId = null) {
    if (engineId) {
      if (this.registry.engineKind(engineId) !== 'launched') throw new Error(`No launched engine "${engineId}". See browser_engine action:"list".`);
      return engineId;
    }
    // The manager's own answer: an engine whose setup has FINISHED and that is not being stopped,
    // after any launch in progress (an engine still being set up was handed out, and its start-up
    // sweep closed the new tab, or its stealth tab got Runtime — engine review, 2026-09-22).
    if (typeof this.engines.defaultEngineId === 'function') return this.engines.defaultEngineId();
    const running = this.engines.list().filter((e) => !e.starting && !e.stopping);
    if (running.length) return running[0].engineId;
    // reuse: two agents opening their first tab at the same moment must share
    // one default engine, not race two browsers onto one profile directory.
    const info = await this.engines.launch({ reuse: true });
    return info.engineId;
  }

  /**
   * Replay on Engine 2 needs the recording in Engine 2's store. When it only
   * exists in the extension's store, fetch it (relay `get`) and save it — the
   * person recorded it in their browser; they should not have to export it.
   */
  async #ensureInLaunchedStore(id, caller) {
    const mine = await this.engines.getRecording?.(id).catch(() => null);
    if (mine) return mine;
    const ext = this.#extensionClient();
    if (!ext) throw new Error(`No recording with id "${id}" in the launched engine's store, and no extension is connected to fetch it from.`);
    const fetched = await this.relay(ext, 'browser_recording', { action: 'get', id }, caller, { timeoutMs: 30_000 });
    const { outline, ...recording } = fetched ?? {};
    if (!recording.id) throw new Error(`The extension returned no recording for "${id}".`);
    await this.engines.saveRecording(recording);
    this.log(`[store] copied recording ${id} from ${ext.id} into the launched-engine store`);
    return recording;
  }

  // ------------------------------------------------------------ stores (recordings, issues)

  /** Which store(s) to try, in order, for a tab-free store action. */
  #storeOrder(client, engineArg) {
    const hasExt = !!this.#extensionClient();
    const hasLaunched = this.engines.available?.() !== false;
    if (engineArg) {
      if (engineArg === 'extension' || this.registry.engineKind(engineArg) === 'extension') {
        if (!hasExt) throw new Error('No extension engine is connected, so its store cannot be reached.');
        return [{ kind: 'extension', engineId: engineArg === 'extension' ? null : engineArg }];
      }
      if (engineArg === 'launched' || this.registry.engineKind(engineArg) === 'launched') return [{ kind: 'launched' }];
      throw new Error(`Unknown engine "${engineArg}". Use "extension" or "launched".`);
    }
    const current = this.registry.current(client.id);
    const first = current != null ? this.#kindOf(current) : null;
    const order = [];
    const push = (kind) => {
      if (kind === 'extension' && hasExt && !order.some((o) => o.kind === kind)) order.push({ kind });
      if (kind === 'launched' && hasLaunched && !order.some((o) => o.kind === kind)) order.push({ kind });
    };
    if (first) push(first);
    push('extension');
    push('launched');
    if (!order.length) throw this.#noEngineError();
    return order;
  }

  async #storeCall(client, store, tool, args) {
    const caller = this.#caller(client);
    const forward = stripRouting(args);
    delete forward.tabId;
    if (store.kind === 'extension') {
      const ext = this.#extensionClient(store.engineId ?? null);
      if (!ext) throw new Error('No extension engine is connected.');
      return this.relay(ext, tool, forward, caller);
    }
    return this.engines.runTool(tool, forward, caller);
  }

  async #store(client, tool, args) {
    const action = args.action ?? 'list';
    const order = this.#storeOrder(client, args.engine);

    if (action === 'list') {
      const merged = [];
      const problems = [];
      const key = tool === 'browser_recording' ? 'recordings' : 'issues';
      let usage = null;
      for (const store of order) {
        try {
          const result = await this.#storeCall(client, store, tool, { ...args, action: 'list' });
          for (const row of result?.[key] ?? []) merged.push({ ...row, engine: store.kind });
          if (result?.usage && store.kind === 'extension') usage = result.usage;
        } catch (err) {
          problems.push(`${store.kind}: ${err.message}`);
        }
      }
      if (!merged.length && problems.length === order.length) throw new Error(problems.join('\n'));
      return { [key]: merged, ...(usage ? { usage } : {}), ...(problems.length ? { problems } : {}) };
    }

    if (CREATE_ACTIONS.has(action)) {
      const store = order[0];
      // Re-importing a FlowSpec must not erase what the store learned about the
      // flow (a spec never carries it — see daemon/flows.js LOCAL_ONLY). The
      // runner imports from the repository before every launched run; without
      // this, the known world would be wiped each time and no surprise could
      // ever be detected there.
      const id = action === 'import_spec' && store.kind === 'launched' ? (args.id ?? args.spec?.id ?? null) : null;
      const previous = id ? await this.engines.getRecording?.(id).catch(() => null) : null;
      const result = await this.#storeCall(client, store, tool, args);
      let kept = [];
      // (3.2) import_spec keeps local truth itself (lib/flowsync.js importFlow) and may have taken a
      // LATER approval from the repository's sidecar: then the old known world must not come back.
      const skip = result?.knownWorld === 'repo' ? ['knownWorld', 'surpriseHistory'] : [];
      if (previous && result?.id) kept = await this.#restoreLocalTruth(result.id, previous, skip);
      if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
      return { ...result, engine: store.kind, ...(kept.length ? { keptLocal: kept } : {}) };
    }

    let lastError = null;
    for (const store of order) {
      try {
        const result = await this.#storeCall(client, store, tool, args);
        if (action === 'calibrate_humanize' && result?.profile) return this.#installHumanizeProfile(args, { ...result, engine: store.kind });
        return result && typeof result === 'object' && !Array.isArray(result) ? { ...result, engine: store.kind } : result;
      } catch (err) {
        lastError = err;
        if (!NOT_FOUND.test(String(err.message))) throw err;
      }
    }
    throw lastError ?? new Error(`Nothing to ${action}.`);
  }

  /** Copy the local-only fields of a recording's previous version onto its re-imported one. */
  async #restoreLocalTruth(id, previous, skip = []) {
    const current = await this.engines.getRecording(id).catch(() => null);
    if (!current) return [];
    const kept = LOCAL_TRUTH.filter((key) => !skip.includes(key) && previous[key] !== undefined && previous[key] !== null);
    if (!kept.length) return [];
    const merged = { ...current };
    for (const key of kept) merged[key] = previous[key];
    await this.engines.saveRecording(merged);
    return kept;
  }

  /**
   * `calibrate_humanize` fits a profile in whichever engine holds the
   * recording and returns it uninstalled; saving it under a name is the
   * daemon's job. It is saved into the launched-engine store (shared by every
   * launched browser), so `humanize:"<name>"` works there from the next call.
   */
  async #installHumanizeProfile(args, result) {
    if (!args.name) {
      return { ...result, saved: null, note: 'Pass name:"team-…" to save this profile for use as humanize:"<name>".' };
    }
    // With a name, the engine that fitted the profile already saved it in ITS
    // store (record.js calibrateFromRecording → `saved`). A profile fitted in
    // the extension must also reach the launched-engine store, where unattended
    // runs look it up; one fitted in a launched engine is already there.
    const name = String(args.name);
    const engines = result.saved ? [result.engine] : [];
    let saveError = null;
    if (!engines.includes('launched')) {
      try {
        await this.engines.saveHumanizeProfile(name, result.profile);
        engines.push('launched');
      } catch (err) {
        saveError = err.message;
      }
    }
    if (!engines.length) return { ...result, saved: null, saveError };
    const where = engines.length === 2 ? 'the extension and on launched engines' : engines[0] === 'launched' ? 'launched engines' : 'the extension';
    return {
      ...result,
      saved: { name, engines },
      note: `Saved. Use humanize:"${name}" on ${where}.` + (saveError ? ` It could not be saved for launched engines: ${saveError}` : ''),
      ...(saveError ? { saveError } : {}),
    };
  }

  // ------------------------------------------------------------ browser_tabs

  async #tabs(client, args) {
    const action = args.action ?? 'list';
    const caller = this.#caller(client);
    switch (action) {
      case 'list':
        return { tabs: await this.listTabs(client) };

      case 'open': {
        if (!args.url) throw new Error('action:"open" needs a url.');
        const opened = await this.#open(client, args.url, args);
        if (args.name) this.registry.nameSession(String(args.name), opened.tabId);
        return { ...opened, ...(args.name ? { session: String(args.name) } : {}), current: true };
      }

      case 'close': {
        const handle = await this.#explicit(client, args, 'close');
        this.registry.ensureOwnership(handle, client.id);
        const target = this.#targetOf(handle);
        await this.registry.enqueue(handle, () => (this.#atTurn(client, handle), target.kind === 'extension'
          ? this.relay(target.client, 'browser_tabs', { action: 'close', tabId: handle }, caller, { handle })
          : this.#local(target.engineId, handle, 'browser_tabs', () => this.engines.runTool('browser_tabs', { action: 'close', tabId: handle }, caller), this.timeoutMs)));
        this.registry.dropHandle(handle, 'closed by an agent');
        return { closed: handle };
      }

      case 'focus': {
        const handle = await this.#explicit(client, args, 'focus');
        this.registry.ensureOwnership(handle, client.id);
        const target = this.#targetOf(handle);
        const result = await this.registry.enqueue(handle, () => (this.#atTurn(client, handle), target.kind === 'extension'
          ? this.relay(target.client, 'browser_tabs', { action: 'focus', tabId: handle }, caller, { handle })
          : this.#local(target.engineId, handle, 'browser_tabs', () => this.engines.runTool('browser_tabs', { action: 'focus', tabId: handle }, caller), this.timeoutMs)));
        this.registry.setCurrent(client.id, handle);
        return { ...(result ?? {}), focused: handle };
      }

      case 'attach':
        return this.#attach(client, args);

      case 'claim': {
        const handle = await this.#resolve(client, args);
        const result = this.registry.claim(handle, client.id, { force: args.force === true });
        if (result.previousOwner && result.changed) {
          this.emitUi?.('activity', {
            kind: 'takeover', tabId: handle, by: client.id, from: result.previousOwner, at: Date.now(),
            detail: `${this.registry.describe(client.id)} took tab ${handle} over from ${this.registry.describe(result.previousOwner)}`,
          });
        }
        return result;
      }

      case 'release': {
        if (args.tabId != null || args.session) {
          const handle = await this.#resolve(client, args);
          return { released: this.registry.release(handle, client.id) ? [handle] : [] };
        }
        return { released: this.registry.releaseAll(client.id) };
      }

      case 'popout': {
        const handle = await this.#resolve(client, args);
        const target = this.#targetOf(handle);
        if (target.kind !== 'extension') {
          throw new Error(
            'Popping a tab into its own window is an Engine 1 (extension) action; launched engines have no windows. ' +
              'A HEADLESS launched engine keeps running while the person minimises or covers their windows (a locked ' +
              'screen has not been measured), so no popout is needed; a headed one must not be minimised.',
          );
        }
        this.registry.ensureOwnership(handle, client.id);
        // `focus` travels too: mcp/tools.js advertises it for popout, and dropping it here made an
        // agent's focus:true silently open the window unfocused (found by the 2.0.3 docs audit).
        const { width, height, left, top, focus } = args;
        return this.registry.enqueue(handle, () => (this.#atTurn(client, handle),
          this.relay(target.client, 'browser_tabs', { action: 'popout', tabId: handle, width, height, left, top, focus }, caller, { handle })));
      }

      case 'watch': {
        // (3.2) Show the PERSON a live view of this tab — a headless one above all, which has no
        // window: the daemon opens the watch window in their browser (and tells the desktop app).
        // Read-only: nothing reaches the page, so it needs no ownership and no turn in the queue.
        const handle = await this.#resolve(client, args);
        if (typeof this.onWatchRequest !== 'function') throw new Error('This daemon cannot open a live view.');
        return this.onWatchRequest({ handle, caller: { agentId: client.id, name: client.name ?? null }, on: args.on !== false, focus: args.focus === true });
      }

      case 'handoff': {
        const handle = await this.#resolve(client, args);
        const target = this.#targetOf(handle);
        if (target.kind !== 'extension') {
          throw new Error(`Tab ${handle} already runs in a launched engine (${target.engineId}); there is nothing to hand off.`);
        }
        const result = await this.handoff(target.client, handle, args, caller);
        this.registry.ensureOwnership(result.tabId, client.id);
        this.registry.setCurrent(client.id, result.tabId);
        this.registry.release(handle, client.id);
        return result;
      }

      case 'session':
        return this.#session(client, args);

      case 'sessions':
        return { sessions: await this.#sessionRows(client) };

      case 'end_session': {
        if (!args.name) throw new Error('action:"end_session" needs a name.');
        const handle = this.registry.endSession(String(args.name));
        if (handle != null) this.registry.release(handle, client.id);
        return { session: String(args.name), ended: handle != null, tabId: handle, note: 'The tab stays open; only the name is gone.' };
      }

      case 'wait': {
        let engineHandle = null;
        if (args.openerTabId != null) {
          engineHandle = Number(args.openerTabId);
          if (!this.registry.hasHandle(engineHandle)) throw new Error(`openerTabId ${args.openerTabId} is not a known tab.`);
        } else {
          engineHandle = this.registry.current(client.id);
        }
        const forward = stripRouting(args);
        delete forward.tabId;
        const target = engineHandle != null ? this.#targetOf(engineHandle) : null;
        const ext = target?.kind === 'extension' ? target.client : (!target ? this.#extensionClient() : null);
        if (ext) return this.relay(ext, 'browser_tabs', forward, caller);
        if (target?.kind === 'launched' || this.engines.list().length) {
          return this.#local(target?.engineId ?? null, null, 'browser_tabs', () => this.engines.runTool('browser_tabs', forward, caller), timeoutFor('browser_tabs', args, this.timeoutMs));
        }
        throw this.#noEngineError();
      }

      default:
        throw new Error(`Unknown tabs action "${action}". Known: ${TABS_ACTIONS.join(', ')}.`);
    }
  }

  /** A tab named by tabId or session — never an implicit default, for actions that destroy or move. */
  async #explicit(client, args, action) {
    if (args.tabId == null && !args.session) {
      throw new Error(`action:"${action}" needs a tabId (or a session name). Call browser_tabs action:"list" first.`);
    }
    return this.#resolve(client, args);
  }

  /**
   * Open a tab. Default engine: the extension when one is connected and
   * `engine` is not given; otherwise Engine 2, launching the default engine
   * (headless unless settings say otherwise) if none runs.
   */
  async #open(client, url, args) {
    const caller = this.#caller(client);
    const engineArg = args.engine ?? null;
    let useExtension;
    let extClient = null;
    if (!engineArg) {
      extClient = this.#extensionClient();
      useExtension = !!extClient;
    } else if (engineArg === 'extension' || this.registry.engineKind(engineArg) === 'extension') {
      extClient = this.#extensionClient(engineArg === 'extension' ? null : engineArg);
      if (!extClient) throw new Error('No extension engine is connected. Open the browser with the G9BrowserAgent extension, or use engine:"launched".');
      useExtension = true;
    } else if (engineArg === 'launched' || this.registry.engineKind(engineArg) === 'launched') {
      useExtension = false;
    } else {
      throw new Error(`Unknown engine "${engineArg}". Use "extension", "launched", or an engineId from browser_engine action:"list".`);
    }

    let opened;
    if (useExtension) {
      const result = await this.relay(extClient, 'browser_tabs', { action: 'open', url, focus: args.focus ?? false }, caller);
      if (!Number.isInteger(result?.tabId)) throw new Error('The extension opened a tab but did not report its id.');
      opened = { tabId: result.tabId, engine: extClient.id, url: result.url ?? url };
      // In the person's browser a tab opens in the BACKGROUND unless asked otherwise, and a browser
      // delivers input only to the tab it shows: said here, or the agent's first click is refused
      // with a "tab hidden" it had no way to expect (docs review, 2026-09-22).
      if (args.focus !== true) {
        opened.background = true;
        opened.hint = 'This tab opened in the background: it can be read (snapshot, console, network, viewport screenshot) ' +
          'but not clicked or typed into. Call browser_tabs action:"focus" first, or open with focus:true.';
      }
    } else {
      const engineId = await this.#launchedEngineId(engineArg && engineArg !== 'launched' ? engineArg : null);
      const result = await this.engines.openTab(engineId, args.context ?? null, url);
      opened = { tabId: result.tabId, engine: result.engineId, contextId: result.contextId, url: result.url ?? url };
    }
    this.registry.ensureOwnership(opened.tabId, client.id);
    this.registry.setCurrent(client.id, opened.tabId);
    return opened;
  }

  async #attach(client, args) {
    const caller = this.#caller(client);
    if (args.tabId != null || args.session) {
      const handle = await this.#resolve(client, args);
      const target = this.#targetOf(handle);
      this.registry.ensureOwnership(handle, client.id);
      if (target.kind === 'launched') {
        // Engine 2 tabs are always attached; attaching makes it current and claims it.
        this.registry.setCurrent(client.id, handle);
        return { tabId: handle, engine: target.engineId, current: true };
      }
      const result = await this.registry.enqueue(handle, () => (this.#atTurn(client, handle),
        this.relay(target.client, 'browser_tabs', { action: 'attach', tabId: handle }, caller, { handle })));
      this.registry.setCurrent(client.id, handle);
      return { ...result, tabId: handle, engine: target.engineId, current: true };
    }
    const ext = this.#extensionClient(args.engine && args.engine !== 'extension' ? args.engine : null);
    if (!ext) throw new Error('Attach works on the extension (the person\'s own browser), and no extension is connected. Use browser_tabs action:"open" for a launched engine.');
    const result = await this.relay(ext, 'browser_tabs', { action: 'attach' }, caller);
    if (!Number.isInteger(result?.tabId)) throw new Error('The extension attached a tab but did not report its id.');
    this.registry.ensureOwnership(result.tabId, client.id);
    this.registry.setCurrent(client.id, result.tabId);
    return { ...result, engine: ext.id, current: true };
  }

  async #session(client, args) {
    if (!args.name) throw new Error('action:"session" needs a name, e.g. name:"buyer".');
    const name = String(args.name);
    if (args.url) {
      let existing = null;
      try { existing = this.registry.sessionHandle(name); } catch { existing = null; }
      if (existing != null) {
        // Re-point the session's tab instead of piling up duplicates: a flow
        // that runs twice must not leave two "buyer" tabs behind.
        await this.#pageTool(client, 'browser_navigate', { action: 'goto', url: args.url, tabId: existing });
        if (args.focus || this.registry.current(client.id) == null) this.registry.setCurrent(client.id, existing);
        return { session: name, tabId: existing, engine: this.registry.engineOf(existing), url: args.url, reused: true };
      }
      const previous = this.registry.current(client.id);
      const opened = await this.#open(client, args.url, args);
      if (previous != null && !args.focus) this.registry.setCurrent(client.id, previous);
      this.registry.nameSession(name, opened.tabId);
      return { session: name, ...opened };
    }
    if (args.tabId == null) throw new Error('action:"session" needs a url (to open a tab) or a tabId (to name one already open).');
    const handle = await this.#resolve(client, { tabId: args.tabId });
    this.registry.nameSession(name, handle);
    if (args.focus || this.registry.current(client.id) == null) this.registry.setCurrent(client.id, handle);
    return { session: name, tabId: handle, engine: this.registry.engineOf(handle) };
  }

  async #sessionRows(client) {
    const rows = this.registry.listSessions();
    if (!rows.length) return [];
    const tabs = await this.listTabs(client).catch(() => []);
    const byId = new Map(tabs.map((t) => [t.tabId, t]));
    return rows.map((r) => {
      const tab = byId.get(r.tabId);
      return { ...r, alive: !!tab, ...(tab ? { title: tab.title, url: tab.url, active: tab.active } : {}) };
    });
  }

  /** Every tab in every engine, full titles and URLs (no modes in v2), with engine and owner. */
  async listTabs(client) {
    const caller = this.#caller(client);
    const rows = [];
    for (const ext of this.registry.extensionEngines()) {
      try {
        const result = await this.relay(ext, 'browser_tabs', { action: 'list' }, caller, { timeoutMs: 15_000 });
        const tabs = Array.isArray(result) ? result : (result?.tabs ?? []);
        this.extTabs.set(ext.id, tabs);
        for (const row of tabs) {
          if (Number.isInteger(row?.tabId)) this.registry.noteUrl(row.tabId, row.url);
          rows.push({ ...row, engine: ext.id, engineKind: 'extension' });
        }
      } catch (err) {
        rows.push({ engine: ext.id, engineKind: 'extension', error: err.message });
      }
    }
    // An extension that is reconnecting (D-c) still holds its tabs: listed as such, so an
    // agent sees its handle is alive and waits instead of opening the page again.
    for (const { engineId } of this.registry.parkedEngines()) {
      for (const handle of this.registry.handlesOf(engineId)) {
        rows.push({ tabId: handle, url: this.registry.handles.get(handle)?.url ?? null, engine: engineId, engineKind: 'extension', reconnecting: true });
      }
    }
    if (this.engines.list().length) {
      try {
        const tabs = await this.engines.listTabs();
        for (const row of tabs) rows.push({ ...row, engineKind: 'launched' });
      } catch (err) {
        rows.push({ engineKind: 'launched', error: err.message });
      }
    }
    const current = client ? this.registry.current(client.id) : null;
    return rows.map((row) => {
      if (row.tabId == null) return row;
      const owner = this.registry.ownerOf(row.tabId);
      const session = this.registry.sessionOf(row.tabId);
      return {
        ...row,
        current: row.tabId === current,
        owner,
        ...(owner ? { ownerName: this.registry.getClient(owner)?.name ?? null } : {}),
        ...(session ? { session } : {}),
      };
    });
  }

  /** Handoff, also used by the panel's "Send to background" (caller without an agent). */
  async handoff(engineClient, handle, args, caller) {
    return runHandoff({
      router: this,
      engines: this.engines,
      registry: this.registry,
      engineClient,
      sourceHandle: handle,
      args,
      caller,
    });
  }

  // ------------------------------------------------------------ browser_engine

  async #engineTool(client, args) {
    const action = args.action ?? 'list';
    switch (action) {
      case 'list':
        return { engines: this.engineRows() };
      case 'launch': {
        const { action: _a, lease, stopWhenReleased, ...opts } = args;
        const info = await this.engines.launch(opts);
        if (lease !== true || !info?.engineId) return info;
        // A lease says "I use this browser across my tabs": the daemon stops an engine launched
        // with stopWhenReleased once every lease is released and no connected agent owns a tab
        // there — never while another run that reused it is between two flows.
        const held = this.registry.acquireLease(info.engineId, client.id, { stopWhenReleased: stopWhenReleased === true && opts.reuse !== true });
        return { ...info, lease: held };
      }
      case 'acquire': {
        if (!args.engineId) throw new Error('action:"acquire" needs an engineId (see action:"list").');
        if (this.registry.engineKind(args.engineId) !== 'launched') throw new Error(`No launched engine "${args.engineId}". See browser_engine action:"list".`);
        return { lease: this.registry.acquireLease(args.engineId, client.id) };
      }
      case 'release': {
        if (!args.engineId) throw new Error('action:"release" needs an engineId.');
        const released = this.registry.releaseLease(args.engineId, client.id);
        const stopped = released ? await this.stopReleasedEngines() : [];
        return { engineId: args.engineId, released, stopped: stopped.includes(args.engineId), holders: this.registry.leaseHolders(args.engineId) };
      }
      case 'stop': {
        if (!args.engineId) throw new Error('action:"stop" needs an engineId (see action:"list").');
        if (this.registry.engineKind(args.engineId) === 'extension') {
          throw new Error(`${args.engineId} is the person's own browser (the extension). G9BrowserAgent never closes it.`);
        }
        // Another run holds this engine (a runner between flows owns no tab, but still uses it).
        const leased = this.registry.leaseHolders(args.engineId).filter((id) => id !== client.id && this.registry.getClient(id));
        if (leased.length && args.force !== true) {
          throw new Error(
            `${args.engineId} is in use by ${leased.map((id) => this.registry.describe(id)).join(', ')} (they hold it with ` +
              'browser_engine action:"acquire"). Stopping it would break their run. Release your own hold instead ' +
              '(action:"release"), or pass force:true if the user asked for it.',
          );
        }
        // Stopping a browser closes every tab in it — a mutating act on each of
        // them. Tabs another connected agent owns are refused by name, exactly
        // as a click on them would be, unless the caller forces it (logged).
        const others = this.registry.handlesOf(args.engineId)
          .map((h) => ({ tabId: h, owner: this.registry.ownerOf(h) }))
          .filter((t) => t.owner && t.owner !== client.id && this.registry.getClient(t.owner));
        if (others.length && args.force !== true) {
          throw new Error(
            `${args.engineId} has tabs other agents own: ${others.map((t) => `tab ${t.tabId} (${this.registry.describe(t.owner)})`).join(', ')}. ` +
              'Stopping it would close their work. Ask them to release those tabs, or pass force:true if the user asked for it.',
          );
        }
        if (others.length) {
          this.log(`[ownership] ${this.registry.describe(client.id)} stopped ${args.engineId} over tabs of ${others.map((t) => this.registry.describe(t.owner)).join(', ')} (force)`);
          this.emitUi?.('activity', {
            kind: 'takeover', by: client.id, engine: args.engineId, tabs: others.map((t) => t.tabId), at: Date.now(),
            detail: `${this.registry.describe(client.id)} stopped ${args.engineId} (force)`,
          });
        }
        await this.engines.stop(args.engineId);
        return { stopped: args.engineId, ...(others.length ? { closedOthersTabs: others.map((t) => t.tabId) } : {}) };
      }
      case 'context': {
        const engineId = await this.#launchedEngineId(args.engineId ?? null);
        return this.engines.createContext(engineId, {
          proxy: args.proxy,
          proxyBypass: args.proxyBypass,
          locale: args.locale,
          timezone: args.timezone,
          humanize: args.humanize,
          stealth: args.stealth,
          downloadPath: args.downloadPath,
        });
      }
      case 'versions':
        return this.engines.versions({ download: args.download === true, version: args.version ?? null });
      case 'warm':
        return this.engines.warm({ profile: args.profile ?? 'automation', url: args.url ?? null, browser: args.browser });
      default:
        throw new Error(`Unknown engine action "${action}". Known: launch, list, stop, context, versions, warm, acquire, release.`);
    }
  }

  /**
   * Stop every launched engine whose last lease is gone and that was launched with
   * stopWhenReleased — unless a connected agent still owns a tab in it (then it is checked again
   * when that tab closes or that agent disconnects). → the engineIds stopped.
   */
  async stopReleasedEngines() {
    this.stoppingReleased ??= new Set();
    const stopped = [];
    for (const engineId of this.registry.releasedEngines()) {
      if (this.stoppingReleased.has(engineId)) continue;
      if (this.registry.engineKind(engineId) !== 'launched') {
        this.registry.leases.delete(engineId);
        continue;
      }
      const owned = this.registry.handlesOf(engineId).some((h) => {
        const owner = this.registry.ownerOf(h);
        return owner && this.registry.getClient(owner);
      });
      if (owned) continue;
      this.stoppingReleased.add(engineId);
      this.registry.leases.delete(engineId);
      try {
        await this.engines.stop(engineId);
        stopped.push(engineId);
        this.log(`[engines] ${engineId}: its last lease was released and no agent owns a tab there; stopped`);
      } catch (err) {
        this.log(`[engines] ${engineId}: could not be stopped after its last lease was released: ${err.message}`);
      } finally {
        this.stoppingReleased.delete(engineId);
      }
    }
    return stopped;
  }

  engineRows() {
    const version = this.version;
    const ext = this.registry.extensionEngines().map((e) => ({
      engineId: e.id,
      kind: 'extension',
      browser: e.browser ?? null,
      version: e.version ?? null,
      connectedAt: e.connectedAt,
      tabs: this.registry.handlesOf(e.id),
      ...(e.version && e.version !== version
        ? { versionMismatch: `The extension is v${e.version} but the daemon is v${version}. Reload the extension so both run the same tools.` }
        : {}),
    }));
    const parked = this.registry.parkedEngines().map((p) => ({
      engineId: p.engineId,
      kind: 'extension',
      reconnecting: true,
      parkedAt: p.parkedAt,
      resumeUntil: p.resumeUntil,
      tabs: this.registry.handlesOf(p.engineId),
    }));
    const launched = this.engines.list().map((e) => {
      const holders = this.registry.leaseHolders?.(e.engineId) ?? [];
      return holders.length ? { ...e, leasedBy: holders } : e;
    });
    return [...ext, ...parked, ...launched];
  }

  // ------------------------------------------------------------ browser_status

  /**
   * Orientation: the daemon's view (agents, engines, ownership, halts) composed
   * over the relevant engine's own status (the tab, its health). It must answer
   * while halted — an agent that cannot ask why everything fails will guess.
   */
  async #status(client, args) {
    const caller = this.#caller(client);
    let handle = null;
    let targetError = null;
    try {
      if (args.tabId != null || args.session) handle = await this.#resolve(client, args);
      else handle = this.registry.current(client.id);
    } catch (err) {
      // Still answer (status must always answer), but never pass another tab
      // off as the one that was asked about.
      handle = null;
      targetError = err.message;
    }

    let engineId = handle != null ? this.registry.engineOf(handle) : null;
    if (!engineId) engineId = this.#extensionClient()?.id ?? this.engines.list()[0]?.engineId ?? null;
    const kind = this.registry.engineKind(engineId);

    let engineStatus = null;
    let engineError = null;
    if (engineId) {
      try {
        const forward = handle != null ? { tabId: handle } : {};
        if (kind === 'extension') engineStatus = await this.relay(this.#extensionClient(engineId), 'browser_status', forward, caller, { timeoutMs: 20_000 });
        else engineStatus = await this.engines.runTool('browser_status', forward, caller);
      } catch (err) {
        engineError = err.message;
      }
    }
    if (engineStatus && typeof engineStatus !== 'object') engineStatus = { engineStatus };

    // What the engine says it would act on becomes the agent's current tab when
    // it has none, so the next call acts on the page this status described.
    const target = pickStatusTarget(engineStatus);
    if (this.registry.current(client.id) == null && target != null && this.registry.hasHandle(target) && this.#availableTo(client, target)) {
      this.registry.setCurrent(client.id, target);
    }

    // The engine reports on the tab it was asked about (F4: status(args.tabId)
    // in extension/tools/index.js), so `current` and its `health` counters are
    // THIS tab's — with several agents each on its own tab, the engine's own
    // current tab is somebody else's; the engine names that one `engineCurrent`.
    // This replaced a workaround that rebuilt `current` here and withheld the
    // health figures. What stays is a guard for an engine that ignored the
    // tabId (a mismatched extension build): its figures belong to another
    // page and are never shown as this one's.
    if (engineStatus && handle != null && engineStatus.current && engineStatus.current.tabId !== handle && !engineStatus.targetError) {
      engineStatus = {
        ...engineStatus,
        engineCurrent: { ...engineStatus.current, health: engineStatus.health ?? null },
        current: { tabId: handle },
        health: null,
        healthNote: `This engine reported on its own current tab instead of tab ${handle} (an older build?). browser_diagnose tabId:${handle} reports on this one.`,
      };
    }

    const info = this.info();
    const settings = this.settings?.get?.() ?? {};
    const engines = this.engineRows();
    const extConnected = engines.some((e) => e.kind === 'extension' && !e.reconnecting);
    const skew = engines.find((e) => e.versionMismatch)?.versionMismatch;
    const g = this.registry.global;
    const me = this.registry.getClient(client.id);

    const status = {
      ...(engineStatus ?? {}),
      daemon: {
        version: this.version,
        pid: info.pid,
        port: info.port,
        home: info.home,
        uptimeMs: info.startedAt ? Date.now() - info.startedAt : null,
        project: client.project?.found ? client.project.path : null,
        flowLibrary: client.project?.flowsDir ?? null,
        ...(client.project?.problems?.length ? { projectProblems: client.project.problems } : {}),
      },
      you: { agentId: client.id, name: client.name, current: this.registry.current(client.id) },
      owned: this.registry.ownedBy(client.id),
      halted: {
        global: g.halted,
        ...(g.halted ? { by: g.by, since: g.at } : {}),
        mine: !!me?.halted,
      },
      agents: this.registry.agentRows(),
      engines,
      sessions: this.registry.listSessions(),
      engine: engineId ? { engineId, kind } : null,
      capabilities: {
        ...(engineStatus?.capabilities ?? {}),
        extension: extConnected,
        launch: this.engines.available?.() !== false,
        ...(this.engines.unavailableReason?.() ? { launchUnavailable: this.engines.unavailableReason() } : {}),
        handoff: extConnected && this.engines.available?.() !== false,
        popout: extConnected,
        maxParallel: settings.maxParallel ?? null,
        humanizeDefault: settings.humanize ?? null,
        stealthDefault: settings.stealth ?? null,
      },
      ...(engineError ? { engineError } : {}),
      ...(targetError ? { targetError } : {}),
      ...(skew ? { versionMismatch: skew } : {}),
    };
    status.hint = statusHint(status, { engineStatus, g, me });
    return status;
  }

  // ------------------------------------------------------------ events from engines

  /**
   * An event from an engine. Extension events carry Chrome tab ids and are
   * rewritten here; Engine 2 events already carry handles (`fromExtension:false`).
   */
  onEngineEvent(engineId, event, rawData, { fromExtension = true } = {}) {
    const data = fromExtension
      ? rewriteTabIds(rawData ?? {}, (n) => this.registry.handleForChrome(engineId, n))
      : (rawData ?? {});
    switch (event) {
      case 'dialog': {
        const handle = Number.isInteger(data.tabId) ? data.tabId : null;
        this.failForDialog(engineId, handle, data.params ?? data);
        this.emitUi?.('activity', { kind: 'dialog', engine: engineId, tabId: handle, type: data.type ?? data.params?.type, message: data.message ?? data.params?.message, at: Date.now() });
        break;
      }
      case 'halt':
        this.onHaltFromEngine?.(engineId, !!data.halted, data.by ?? 'panel');
        break;
      case 'tabs': {
        const rows = Array.isArray(data.tabs) ? data.tabs : [];
        if (fromExtension) this.#reconcileExtensionTabs(engineId, rows);
        this.emitUi?.('tabs', { engine: engineId, tabs: rows });
        break;
      }
      case 'activity':
        // The engine's own record of a call the daemon relayed (F7): the daemon
        // reported that call already; forwarding it showed each agent call twice.
        if (data?.relayed === true) break;
        this.emitUi?.('activity', { engine: engineId, ...data });
        break;
      case 'frame':
      case 'pointer': {
        const handle = Number.isInteger(data.tabId) ? data.tabId : null;
        if (handle != null) this.onWatchData?.(handle, event, data);
        break;
      }
      case 'watchStatus': {
        // Is the watched picture live? (lib/screencast.js watchdog: hidden / idle / live)
        const handle = Number.isInteger(data.tabId) ? data.tabId : null;
        if (handle != null) this.onWatchData?.(handle, 'status', data);
        break;
      }
      case 'download':
        this.emitUi?.('activity', { kind: 'download', engine: engineId, ...data });
        break;
      default:
        this.emitUi?.('activity', { kind: event, engine: engineId, ...data });
    }
  }

  /**
   * A `tabs` push is the extension's complete tab list. Handles for Chrome tabs
   * no longer in it are dropped — but only once they are a few seconds old,
   * because the push is debounced and may have been computed before a tab this
   * daemon just learned about (from an `open` result) existed.
   */
  #reconcileExtensionTabs(engineId, rows) {
    this.extTabs.set(engineId, rows);
    // The last page seen in each tab: what a reconnect of this extension is checked against (D-c).
    for (const r of rows) if (Number.isInteger(r?.tabId)) this.registry.noteUrl(r.tabId, r.url);
    const present = new Set(rows.map((r) => r.tabId).filter(Number.isInteger));
    const now = Date.now();
    for (const handle of this.registry.handlesOf(engineId)) {
      const entry = this.registry.handles.get(handle);
      if (!present.has(handle) && entry && now - entry.createdAt > 3_000) {
        this.registry.dropHandle(handle, 'the tab was closed in the browser');
      }
    }
  }
}

/** The answer for a call that ran past its deadline and was stopped (it settled within STOP_GRACE_MS). */
function overdueMessage(tool, secs, detail) {
  return `"${tool}" did not finish within ${secs}s, so G9BrowserAgent stopped it: ${detail}`;
}

/** A call for a tab whose extension is between a disconnect and its reconnect (decision D-c). */
function reconnectingError(handle, engineId) {
  return new Error(
    `Tab ${handle} is in a browser whose G9BrowserAgent extension is reconnecting (${engineId}: its service worker restarted or the ` +
      'extension was reloaded). The tab, your claim on it and its session name are kept for a few minutes; retry in a few ' +
      'seconds. If it keeps failing, ask the user to check that the browser is open.',
  );
}

/** The tab an engine's status says it would act on, as a handle (already rewritten). */
export function pickStatusTarget(status) {
  if (!status || typeof status !== 'object') return null;
  for (const key of ['attached', 'target', 'current', 'currentTab', 'tab']) {
    const v = status[key];
    if (v && typeof v === 'object' && Number.isInteger(v.tabId)) return v.tabId;
  }
  if (Number.isInteger(status.currentTabId)) return status.currentTabId;
  return null;
}

function statusHint(status, { engineStatus, g, me }) {
  if (g.halted) return 'The user pressed Stop. Every tool except browser_status fails until THEY press Resume. Tell them and wait.';
  if (me?.halted) return 'The user stopped this agent. Every tool except browser_status fails until they resume it. Tell them and wait.';
  if (!status.engines.length) {
    return 'No browser engine is running. browser_tabs action:"open" url:"…" launches a headless browser (Engine 2) ' +
      'and opens the page; or ask the user to open their browser with the G9BrowserAgent extension (Engine 1).';
  }
  if (status.you.current != null) {
    return `Ready. Your current tab is ${status.you.current}. Start with browser_snapshot, then act with the refs it returns.`;
  }
  if (engineStatus?.hint) return engineStatus.hint;
  return 'No current tab yet. browser_tabs action:"list" shows every tab; attach one or open one.';
}
