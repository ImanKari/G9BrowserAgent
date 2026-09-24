/**
 * g9d — the one daemon per machine (ARCHITECTURE §1, §8; DAEMON_PROTOCOL.md).
 *
 * This module composes the parts; `g9d.mjs` is only the command line around it.
 *
 *   WsServer ── hello/welcome ──▶ Registry (clients, engines, handles, ownership, halts)
 *        │                           ▲
 *        └── call/result/event ──▶ Router ──▶ extension engines (relay) | EngineManager (Engine 2)
 *                                    │
 *   admin (ui) ──▶ settings, schedule, runs, extension install, watch, halt, shutdown
 *
 * Why one daemon and not one bridge per agent (plan D5): v1's extension could
 * talk to exactly one bridge, so the second editor window, the runner and any
 * second agent all fought over one port and one browser. Here every agent's
 * shim is a client of the same process, which owns every engine and decides —
 * per tab, not per socket — who may do what.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { VERSION, REPO_ROOT, majorOf } from '../lib/version.mjs';
import { WsServer, classifyOrigin } from './ws-server.js';
import { Registry } from './registry.js';
import { Router, deliveryFields } from './router.js';
import { Settings } from './settings.js';
import { FileStorageArea, MemoryStorageArea, FileBlobs } from './storage.js';
import { Evidence } from './evidence.js';
import { Scheduler } from './scheduler.js';
import { installExtension } from './extension-update.js';
import { loadProject, projectForClient } from './project.js';
import { FlowLibrary } from './flows.js';
import { layout, writeFileAtomicSync } from './paths.js';
import { EngineManager } from '../engine/manager.js';

const HELLO_TIMEOUT_MS = 10_000;

export class Daemon {
  /**
   * @param {object} o
   * @param {string} o.home        G9_HOME (already resolved)
   * @param {number} [o.port]      overrides settings.port
   * @param {boolean} [o.foreground]  a person is watching: never idle-exit
   * @param {(...a) => void} o.log
   * @param {number} [o.timeoutMs] per-call base deadline (G9_TIMEOUT_MS)
   * @param {string} [o.cwd]       where to look for the default g9.project.json
   * @param {number} [o.idleExitMs] overrides settings.idleExitMinutes (tests; G9_IDLE_EXIT_MS)
   * @param {number} [o.engineResumeMs] how long a disconnected extension keeps its identity (D-c; G9_ENGINE_RESUME_MS)
   */
  constructor({ home, port = null, foreground = false, log, timeoutMs = 120_000, cwd = process.cwd(), idleExitMs = null, engineResumeMs = undefined }) {
    this.home = home;
    this.paths = layout(home);
    this.foreground = foreground;
    this.idleExitMs = Number(idleExitMs) > 0 ? Number(idleExitMs) : null;
    this.log = log;
    this.startedAt = Date.now();
    // Which daemon INSTANCE a client is talking to (welcome.bootId): tab handles restart at 1 in
    // every daemon, so a client that kept a handle across a daemon restart must not reuse it — the
    // desktop re-watched handle 3 of the OLD daemon and streamed whatever tab the new one had
    // numbered 3, in the person's own browser (desktop review, 2026-09-22). A pid alone is weak:
    // Windows reuses pids.
    this.bootId = crypto.randomBytes(8).toString('hex');
    fs.mkdirSync(this.paths.logsDir, { recursive: true });

    this.settings = new Settings(this.paths.settings, { log });
    this.port = port ?? this.settings.get().port;
    this.registry = new Registry({ log, ...(engineResumeMs !== undefined ? { resumeMs: engineResumeMs } : {}) });
    this.storage = {
      local: new FileStorageArea(this.paths.kvLocal, { log }),
      session: new MemoryStorageArea(),
      blobs: new FileBlobs(this.paths.blobsDir, { log }),
    };
    this.evidence = new Evidence({ runsDir: this.paths.runsDir, settings: this.settings, log });
    this.engines = new EngineManager({
      home,
      registry: this.registry,
      log,
      emit: (event, data) => this.#onEngine2Event(event, data),
      settings: this.settings,
      evidence: this.evidence,
      storage: this.storage,
      version: VERSION,
    });
    this.router = new Router({
      registry: this.registry,
      engines: this.engines,
      evidence: this.evidence,
      settings: this.settings,
      log,
      version: VERSION,
      timeoutMs,
      info: () => ({ pid: process.pid, port: this.port, home: this.home.replace(/\\/g, '/'), repoRoot: REPO_ROOT, startedAt: this.startedAt }),
    });
    this.router.emitUi = (topic, data) => this.broadcastUi(topic, data);
    this.router.onHaltFromEngine = (engineId, halted, by) => this.setGlobalHalt(halted, by, { except: engineId });
    this.router.onWatchData = (handle, kind, data) => this.#watchData(handle, kind, data);

    this.scheduler = new Scheduler({
      settings: this.settings,
      evidence: this.evidence,
      repoRoot: REPO_ROOT,
      port: () => this.port,
      home,
      log,
      emit: (topic, data) => this.broadcastUi(topic, data),
      // Scheduled runs use the daemon's default project when their entry names none.
      project: () => (this.project?.found ? this.project.path : null),
    });

    this.project = loadProject(cwd);
    this.flows = new FlowLibrary(this.project.flowsDir);
    this.projectCache = new Map();

    this.watchers = new Map(); // handle → Set(uiId)
    this.watchRuns = new Map(); // handle → runId
    this.idleSince = Date.now();
    this.v1Refusals = new Map(); // origin → last log time

    this.ws = new WsServer({ port: this.port, health: () => this.health() });
    this.ws.on('connection', (conn, meta) => this.#onConnection(conn, meta));
    this.ws.on('rejected', ({ origin, path: p, code, reason }) => this.log(`[ws] refused ${code} ${reason} (origin "${origin || '-'}", path ${p})`));
    this.ws.on('protocolError', ({ reason }) => this.log(`[ws] dropped a connection: ${reason}`));

    this.registry.on('agents', () => this.#schedulePush());
    this.registry.on('engines', () => this.broadcastUi('engines', { engines: this.router.engineRows() }));
    this.registry.on('halt', (data) => this.broadcastUi('halt', { global: this.registry.global, ...data }));
    // A per-agent Stop stops that agent's calls already running too (the global Stop reaches every
    // engine's state, which perform() checks between input steps).
    this.registry.on('halt', (data) => {
      if (data?.agentId && data.halted) this.router.cancelFor(data.agentId, 'the user stopped this agent');
    });
    // Engines launched for a run are stopped by the daemon once nobody holds them (engine leases).
    const recheckLeases = () => {
      if (!this.registry.releasedEngines().length) return;
      this.router.stopReleasedEngines().catch((err) => this.log(`[engines] lease check: ${err.message}`));
    };
    this.registry.on('leaseReleased', recheckLeases);
    this.registry.on('tabGone', recheckLeases);
    this.registry.on('agents', recheckLeases);
    this.registry.on('tabGone', ({ tabId, reason }) => {
      this.#stopWatching(tabId).catch(() => {});
      this.broadcastUi('tabs', { gone: tabId, reason });
    });
    this.settings.onChange((_s, patch) => {
      if ('humanize' in patch || 'stealth' in patch) this.engines.reconfigure();
    });
  }

  // ------------------------------------------------------------ lifecycle

  async start() {
    try {
      await this.ws.listen();
    } catch (err) {
      err.port = this.port;
      throw err;
    }
    this.port = this.ws.port;
    writeFileAtomicSync(this.paths.daemonJson, `${JSON.stringify({
      pid: process.pid, port: this.port, version: VERSION, startedAt: this.startedAt, home: this.home.replace(/\\/g, '/'),
    }, null, 2)}\n`);
    this.log(`[g9d] v${VERSION} listening on ws://127.0.0.1:${this.port}/g9 (pid ${process.pid}, home ${this.home})`);
    if (this.project.found) this.log(`[g9d] default project: ${this.project.path}`);
    for (const problem of this.settings.loadProblems) this.log(`[g9d] settings: ${problem}`);

    // What interrupted Chrome for Testing installs left in G9_HOME/engines (hundreds of MB each).
    this.engines.sweepInstallLeftovers?.().catch(() => {});
    // Engine 2's tool runtime loads in the background; a failure is recorded
    // and reported, never fatal (the extension path must keep working).
    this.engines.init().then(() => {
      if (!this.engines.available()) this.log(`[g9d] Engine 2 unavailable: ${this.engines.unavailableReason()}`);
    });
    this.scheduler.start();
    this.idleTimer = setInterval(() => this.#idleCheck(), this.idleExitMs ? Math.max(100, Math.min(30_000, Math.floor(this.idleExitMs / 4))) : 30_000);
    this.idleTimer.unref?.();
    return { port: this.port };
  }

  stop(reason = 'stopped') {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.log(`[g9d] shutting down: ${reason}`);
      clearInterval(this.idleTimer);
      this.scheduler.stop();
      for (const handle of [...this.watchers.keys()]) await this.#stopWatching(handle).catch(() => {});
      await this.engines.shutdown().catch((err) => this.log(`[g9d] engine shutdown: ${err.message}`));
      const unfinished = await this.evidence.finishAll({ error: `the daemon stopped (${reason}) before this run finished`, interrupted: true }).catch(() => []);
      if (unfinished.length) this.log(`[g9d] closed ${unfinished.length} unfinished run record(s): ${unfinished.join(', ')}`);
      await this.ws.close().catch(() => {});
      try {
        const current = JSON.parse(fs.readFileSync(this.paths.daemonJson, 'utf8'));
        if (current.pid === process.pid) fs.rmSync(this.paths.daemonJson, { force: true });
      } catch { /* already gone */ }
      this.log('[g9d] stopped');
    })();
    return this.stopping;
  }

  /**
   * Idle exit (DAEMON_PROTOCOL §8): no client of any role, no launched engine,
   * no enabled schedule entry and no scheduled run, for `idleExitMinutes`. A
   * daemon started by hand (--foreground) never idles out — someone is watching.
   */
  #idleCheck() {
    const limitMs = this.idleExitMs ?? Number(this.settings.get().idleExitMinutes) * 60_000;
    const busy = this.registry.clients.size > 0 || this.engines.list().length > 0 || this.scheduler.hasWork();
    if (busy) {
      this.idleSince = null;
      return;
    }
    this.idleSince ??= Date.now();
    if (this.foreground || !limitMs) return;
    if (Date.now() - this.idleSince >= limitMs) {
      this.onIdleExit?.();
    }
  }

  health() {
    const extension = this.registry.extensionEngines().length > 0;
    return {
      name: 'g9d',
      version: VERSION,
      pid: process.pid,
      port: this.port,
      home: this.home.replace(/\\/g, '/'),
      engines: this.registry.extensionEngines().length + this.engines.list().length,
      agents: this.registry.agents().length,
      extension,
      /** Launched (Engine 2) browsers: a daemon restart would close them. */
      launched: this.engines.list().length,
      // Every run still open (replays, calibrations, scheduled runs, live watches): what the
      // desktop checks before restarting this daemon for an update (F6).
      activeRuns: this.evidence.activeRuns(),
      startedAt: this.startedAt,
      bootId: this.bootId,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  // ------------------------------------------------------------ connections

  #onConnection(conn, meta) {
    let client = null;
    const helloTimer = setTimeout(() => {
      if (!client) conn.close(4000, 'The first message must be {"type":"hello"} within 10 s.');
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    conn.on('message', (msg) => {
      if (!client) {
        if (msg.type !== 'hello') {
          conn.close(4000, 'The first message must be {"type":"hello"}.');
          return;
        }
        clearTimeout(helloTimer);
        client = this.#hello(conn, msg, meta);
        return;
      }
      // A socket whose engine identity a reconnect took over (D-c) is closing;
      // anything it still says (a stale tab list above all) is not the engine's.
      if (this.registry.getClient(client.id) !== client) return;
      this.#dispatch(client, msg).catch((err) => this.log(`[g9d] ${client.id}: ${err?.stack ?? err}`));
    });

    conn.on('close', (info) => {
      clearTimeout(helloTimer);
      if (client) this.#goodbye(client, info);
    });
  }

  #hello(conn, msg, meta) {
    let role = msg.role;
    if (role === 'extension') role = 'engine'; // a v1 extension's word for it
    if (role === 'runner') role = 'agent'; // the runner is an agent like any other
    if (!['agent', 'engine', 'ui'].includes(role)) {
      conn.send({ type: 'welcome', version: VERSION, daemonPid: process.pid, id: null, problem: `Unknown role "${msg.role}". Use agent, engine or ui.` });
      setTimeout(() => conn.close(4002, 'unknown role'), 50).unref?.();
      return null;
    }
    // Admin ops (settings — the update feed among them — halts, schedule, extension install) are for
    // the desktop's main process, a NATIVE client: it sends no Origin header at all. A browser
    // extension could say hello as "ui" and rewrite settings.updateUrl, which the desktop's updater
    // then followed (desktop review, 2026-09-22). No token (D7's local trust model): the role is
    // tied to where the connection came from.
    const originKind = meta.originKind ?? classifyOrigin(meta.origin).kind;
    if (role === 'ui' && originKind !== 'native') {
      conn.send({
        type: 'welcome', version: VERSION, daemonPid: process.pid, id: null,
        problem: 'The "ui" role (admin operations) is only for native clients — the G9 desktop app — which send no Origin header. Connect as "engine" or "agent".',
      });
      setTimeout(() => conn.close(4003, 'ui role needs a native client'), 50).unref?.();
      this.log(`[g9d] refused a "ui" hello from origin ${meta.origin ?? '-'}: admin is for native clients only`);
      return null;
    }

    if (role === 'engine' && !(majorOf(msg.version) >= 2)) {
      const problem =
        `This is the G9 extension v${msg.version ?? '?'}, but port ${this.port} now runs the G9 v2 daemon (g9d v${VERSION}). ` +
        'A v1 extension cannot work with it. Reload the extension from the v2 folder: open edge://extensions or ' +
        'chrome://extensions, find G9 Browser Agent and press Reload (or Load unpacked the "extension" folder of the ' +
        'v2 install).';
      conn.send({ type: 'welcome', version: VERSION, daemonPid: process.pid, id: null, repoRoot: REPO_ROOT.replace(/\\/g, '/'), problem });
      setTimeout(() => conn.close(4001, 'G9 v1 extension: reload the v2 extension (g9d v2 runs here)'), 50).unref?.();
      const key = meta.origin ?? 'none';
      const last = this.v1Refusals.get(key) ?? 0;
      if (Date.now() - last > 60_000) {
        this.v1Refusals.set(key, Date.now());
        this.log(`[g9d] refused a v1 extension (v${msg.version ?? '?'}, ${meta.origin ?? 'no origin'}): it must be reloaded as v2`);
      }
      return null;
    }

    const c = msg.client ?? {};
    // Decision D-c: an extension says who it is across reconnects. A reconnect
    // can beat the old socket's close (an extension reload, a worker restart
    // whose old socket the OS has not reported closed yet): the old one is
    // superseded first — its pending calls fail now with the reason, it is
    // parked, and closed — so the new socket takes the identity back.
    const instanceId = role === 'engine' && typeof c.instanceId === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(c.instanceId) ? c.instanceId : null;
    if (instanceId) {
      const stale = this.registry.engineByInstance(instanceId);
      if (stale) {
        this.router.failEngine(stale.id, 'The browser extension reconnected (a new connection replaced this one) before answering this call. Retry it.');
        this.registry.removeClient(stale.id, { expected: stale });
        try { stale.conn?.close(1000, 'superseded by a new connection from the same extension'); } catch { /* already closing */ }
      }
    }
    const client = this.registry.addClient({
      role,
      name: c.name ?? null,
      pid: Number.isInteger(c.pid) ? c.pid : null,
      version: msg.version ?? null,
      send: (obj) => conn.send(obj),
      browser: c.browser ?? null,
      cwd: c.cwd ?? null,
      origin: meta.origin,
      ...(instanceId ? {
        instanceId,
        loadId: typeof c.loadId === 'string' ? c.loadId.slice(0, 128) : null,
        tabs: Array.isArray(c.tabs) ? c.tabs : null,
      } : {}),
    });
    client.conn = conn;
    client.project = role === 'agent' && (c.cwd || c.project) ? this.#projectFor(c.cwd, c.project) : this.project;

    conn.send({
      type: 'welcome',
      version: VERSION,
      daemonPid: process.pid,
      // This daemon instance (DAEMON_PROTOCOL §2): handles are only meaningful within one.
      bootId: this.bootId,
      startedAt: this.startedAt,
      id: client.id,
      repoRoot: REPO_ROOT.replace(/\\/g, '/'),
      project: projectForClient(client.project),
      halted: { global: this.registry.global.halted, ...(this.registry.global.halted ? { by: this.registry.global.by } : {}) },
      port: this.port,
      home: this.home.replace(/\\/g, '/'),
    });
    this.log(`[g9d] ${role} connected: ${this.registry.describe(client.id)}${c.pid ? ` pid ${c.pid}` : ''}${role === 'engine' ? ` v${msg.version}` : ''}` +
      `${client.resumed ? ` (resumed: ${client.resumed.kept.length} tab handle(s) kept, ${client.resumed.dropped.length} dropped)` : ''}`);

    if (role === 'engine') {
      if (this.registry.global.halted) conn.send({ type: 'halt', halted: true });
      this.#pushAgents();
      // Live views of this engine's tabs lived in the old worker's memory; ask again.
      if (client.resumed) {
        for (const handle of this.watchers.keys()) {
          if (this.registry.engineOf(handle) === client.id) {
            conn.send({ type: 'watch', tabId: this.registry.chromeTabOf(handle, client.id), on: true });
          }
        }
      }
    }
    this.idleSince = null;
    return client;
  }

  #goodbye(client, info) {
    // A socket superseded by a reconnect of the same extension (D-c) was
    // handled when the new one said hello; its late close changes nothing.
    if (this.registry.getClient(client.id) !== client) return;
    const { released, dropped, parked } = this.registry.removeClient(client.id, { expected: client });
    if (client.role === 'engine') {
      this.router.failEngine(client.id, 'The browser extension disconnected mid-call. Check that the browser is still open.');
    }
    if (client.role === 'ui') {
      for (const [handle, set] of this.watchers) {
        if (set.delete(client.id) && set.size === 0) this.#stopWatching(handle).catch(() => {});
      }
    }
    this.log(`[g9d] ${client.role} disconnected: ${client.id}${info?.code ? ` (${info.code}${info.reason ? ` ${info.reason}` : ''})` : ''}` +
      `${released.length ? `; released tabs ${released.join(', ')}` : ''}${dropped.length ? `; ${dropped.length} tab handle(s) gone` : ''}` +
      `${parked ? '; its tabs are kept for a reconnect' : ''}`);
  }

  #projectFor(cwd, explicit) {
    const key = `${cwd ?? ''}|${explicit ?? ''}`;
    if (!this.projectCache.has(key)) {
      this.projectCache.set(key, loadProject(cwd || process.cwd(), { explicit: explicit || process.env.G9_PROJECT }));
    }
    return this.projectCache.get(key);
  }

  // ------------------------------------------------------------ messages

  async #dispatch(client, msg) {
    switch (msg.type) {
      case 'call':
        if (client.role === 'engine') return; // engines answer calls, they do not make them
        return this.#call(client, msg);
      case 'result':
        if (client.role === 'engine') this.router.onRelayResult(client, msg);
        return;
      case 'event':
        if (client.role === 'engine') {
          // v1 put the dialog's tabId next to `data`; v2 puts it inside. Accept both.
          const data = { ...(msg.data ?? {}) };
          if (msg.tabId != null && data.tabId == null) data.tabId = msg.tabId;
          this.router.onEngineEvent(client.id, msg.event, data, { fromExtension: true });
        }
        return;
      case 'request':
        return this.#request(client, msg);
      case 'flowlib':
        return this.#flowlibMessage(client, msg);
      case 'admin':
        return this.#admin(client, msg);
      default:
        return; // unknown types are ignored, as the protocol promises
    }
  }

  async #call(client, msg) {
    if (msg.caller?.name) this.registry.setName(client.id, msg.caller.name);
    const started = Date.now();
    try {
      const result = await this.router.call(client, msg.tool, msg.args ?? {});
      client.send({ type: 'result', id: msg.id, ok: true, result });
      this.broadcastUi('activity', { kind: 'tool', agentId: client.id, name: client.name, tool: msg.tool, detail: summarize(msg.tool, msg.args ?? {}), ok: true, ms: Date.now() - started, at: Date.now() });
    } catch (err) {
      const error = String(err?.message ?? err);
      client.send({ type: 'result', id: msg.id, ok: false, error, ...deliveryFields(err) });
      this.broadcastUi('activity', { kind: 'tool', agentId: client.id, name: client.name, tool: msg.tool, detail: `${summarize(msg.tool, msg.args ?? {})} — ${error.slice(0, 300)}`, ok: false, ms: Date.now() - started, at: Date.now() });
    }
  }

  /** Extension → daemon requests (DAEMON_PROTOCOL §5). */
  async #request(client, msg) {
    const reply = (ok, payload) => client.send({ type: 'response', id: msg.id, ok, ...(ok ? { result: payload } : { error: payload }) });
    try {
      switch (msg.op) {
        case 'handoff': {
          if (client.role !== 'engine') throw new Error('handoff requests come from the extension.');
          if (this.registry.global.halted) throw new Error('Stop is pressed; press Resume before sending a tab to the background.');
          const handle = this.registry.handleForChrome(client.id, Number(msg.tabId));
          if (handle == null) throw new Error('handoff needs the tabId of a tab in this browser.');
          const result = await this.router.handoff(client, handle, msg, { agentId: null, name: 'side panel' });
          return reply(true, result);
        }
        case 'info':
          return reply(true, {
            version: VERSION,
            port: this.port,
            pid: process.pid,
            agents: this.#agentsFor(client),
            engines: this.router.engineRows().map(({ argv, ...rest }) => rest),
            halted: this.registry.global,
          });
        case 'flowlib':
          // As a request, `id` is the correlation id and nothing else; the flow is `flowId`.
          return reply(true, await this.#flowlib(msg.flowOp ?? msg.sub, { ...msg, flowId: msg.flowId ?? null }));
        default:
          throw new Error(`Unknown request op "${msg.op}". Known: handoff, info, flowlib.`);
      }
    } catch (err) {
      reply(false, String(err?.message ?? err));
    }
  }

  /**
   * `{type:'flowlib', id, op, flowId?}` (F5). `id` is the sender's correlation
   * id, echoed on the flowlibResult; the flow an op is about is `flowId`. A
   * v1-shaped message has no `flowId` and named the flow in `id` (the same
   * field did both jobs, which cost two bugs); only then is `id` read as the flow.
   */
  async #flowlibMessage(client, msg) {
    try {
      const result = await this.#flowlib(msg.op, { ...msg, flowId: msg.flowId ?? msg.id ?? null });
      client.send({ type: 'flowlibResult', id: msg.id, ok: true, result });
    } catch (err) {
      client.send({ type: 'flowlibResult', id: msg.id, ok: false, error: String(err?.message ?? err) });
    }
  }

  /**
   * The flow library's request handler (unchanged from v1). An unknown op is
   * refused by name rather than ignored: a library that silently does nothing
   * for a verb it does not know reports success for work that never happened.
   */
  async #flowlib(op, msg) {
    const flowId = () => {
      if (msg.flowId == null || msg.flowId === '') throw new Error(`The flow-library op "${op}" needs a flowId.`);
      return String(msg.flowId);
    };
    switch (op) {
      case 'list': return this.flows.list();
      case 'read': return { spec: await this.flows.read(flowId()) };
      case 'write': return this.flows.write(msg.spec);
      case 'remove': return this.flows.remove(flowId());
      case 'status': return this.flows.status(msg.local ?? []);
      case 'suite': return this.flows.resolveSuite(msg.suiteId);
      default:
        throw new Error(`Unknown flow-library op "${op}". Known: list, read, write, remove, status, suite.`);
    }
  }

  // ------------------------------------------------------------ admin (ui)

  async #admin(client, msg) {
    const reply = (ok, payload) => client.send({ type: 'result', id: msg.id, ok, ...(ok ? { result: payload } : { error: payload }) });
    if (client.role !== 'ui') return reply(false, 'Admin operations are for the G9 desktop app (role "ui"). Agents cannot halt, resume or reconfigure the daemon.');
    try {
      reply(true, await this.#adminOp(client, msg));
    } catch (err) {
      reply(false, String(err?.message ?? err));
    }
    if (msg.op === 'shutdown') setTimeout(() => this.onShutdownRequest?.('shutdown requested by the desktop app'), 50).unref?.();
  }

  async #adminOp(client, raw) {
    const msg = { op: raw.op, ...adminArgs(raw) };
    switch (msg.op) {
      case 'halt':
        this.setGlobalHalt(true, 'desktop');
        return { halted: true };
      case 'resume':
        this.setGlobalHalt(false, 'desktop');
        return { halted: false };
      case 'haltAgent':
        return { changed: this.registry.setAgentHalt(requireArg(msg, 'agentId'), true, { by: 'desktop' }) };
      case 'resumeAgent':
        return { changed: this.registry.setAgentHalt(requireArg(msg, 'agentId'), false, { by: 'desktop' }) };
      case 'watch':
        return this.#watch(client, Number(requireArg(msg, 'tabId')), true);
      case 'unwatch':
        return this.#watch(client, Number(requireArg(msg, 'tabId')), false);
      case 'settings.get':
        return this.settings.get();
      case 'settings.set':
        return this.settings.set(msg.patch ?? {});
      case 'extension.install': {
        const installed = await installExtension({
          from: msg.from ?? path.join(REPO_ROOT, 'extension'),
          target: this.paths.extensionDir,
          log: this.log,
        });
        return { ...installed, reloadSent: await this.reloadExtensions() };
      }
      case 'extension.reload':
        return { reloadSent: await this.reloadExtensions() };
      case 'schedule.list':
        return { entries: this.scheduler.list() };
      case 'schedule.add':
        return this.scheduler.add(msg.entry ?? withoutOp(msg));
      case 'schedule.remove':
        return this.scheduler.remove(requireArg(msg, 'id', 'entryId'));
      case 'schedule.runNow':
        return this.scheduler.runNow(requireArg(msg, 'id', 'entryId'));
      case 'runs.list':
        // { active:true } → every run still open, whatever its age (F6); else the newest `limit`.
        return { runs: await this.evidence.list({ limit: msg.limit ?? 50, active: msg.active === true }) };
      case 'runs.get':
        return this.evidence.get(requireArg(msg, 'runId'));
      case 'engines.versions':
        return this.engines.versions({ download: false });
      case 'engines.installCft':
        return this.engines.versions({ download: true, version: msg.version ?? null });
      case 'profiles.list':
        return { profiles: await this.engines.profiles() };
      case 'profiles.warm':
        return this.engines.warm({ profile: requireArg(msg, 'name'), url: msg.url ?? null, browser: msg.browser });
      case 'state':
        return {
          daemon: this.health(),
          halted: this.registry.global,
          agents: this.registry.agentRows(),
          engines: this.router.engineRows(),
          sessions: this.registry.listSessions(),
          tabs: await this.router.listTabs(null).catch(() => []),
          schedule: this.scheduler.list(),
          activeRuns: this.evidence.activeRuns(),
          watching: [...this.watchers.entries()].filter(([, s]) => s.has(client.id)).map(([h]) => h),
        };
      case 'shutdown':
        return { stopping: true };
      default:
        throw new Error(`Unknown admin op "${msg.op}".`);
    }
  }

  // ------------------------------------------------------------ halts, pushes, broadcasts

  /** The global Stop: mirrored to every extension (their panels) and into Engine 2's state. */
  setGlobalHalt(halted, by, { except = null } = {}) {
    const changed = this.registry.setGlobalHalt(halted, { by });
    if (!changed) return false;
    for (const ext of this.registry.extensionEngines()) {
      if (ext.id !== except) ext.send({ type: 'halt', halted: !!halted });
    }
    this.engines.setHalted(halted).catch(() => {});
    return true;
  }

  /** Ask connected extensions to reload, each once it has no call in flight (max 60 s wait). */
  async reloadExtensions() {
    const engines = this.registry.extensionEngines();
    await Promise.all(engines.map(async (ext) => {
      const deadline = Date.now() + 60_000;
      while (this.router.inFlight(ext.id) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
      ext.send({ type: 'reload' });
      this.log(`[g9d] asked ${ext.id} to reload`);
    }));
    return engines.length;
  }

  broadcastUi(topic, data) {
    for (const ui of this.registry.byRole('ui')) ui.send({ type: 'event', topic, data });
  }

  #agentsFor(ext) {
    return this.registry.agentRows().map((a) => ({
      id: a.id,
      name: a.name,
      owned: a.owned.map((h) => this.registry.chromeTabOf(h, ext.id)).filter((n) => n != null),
      halted: a.halted,
    }));
  }

  #pushAgents() {
    for (const ext of this.registry.extensionEngines()) ext.send({ type: 'agents', agents: this.#agentsFor(ext) });
    this.broadcastUi('agents', { agents: this.registry.agentRows() });
  }

  #schedulePush() {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.#pushAgents();
    }, 100);
    this.pushTimer.unref?.();
  }

  #onEngine2Event(event, data = {}) {
    switch (event) {
      case 'dialog': {
        const engineId = this.engines.engineOfTab(data.tabId);
        if (engineId) this.router.onEngineEvent(engineId, 'dialog', data, { fromExtension: false });
        return;
      }
      case 'engineGone':
        this.router.failEngine(data.engineId, `The launched browser ${data.engineId} is gone: ${data.reason}.`);
        return;
      case 'engines':
        this.broadcastUi('engines', { engines: this.router.engineRows() });
        return;
      case 'activity':
        // Engine 2's record of a call the daemon made (F7): already reported by the daemon.
        if (data?.relayed === true) return;
        this.broadcastUi('activity', { engine: 'launched', kind: event, ...data, at: data.at ?? Date.now() });
        return;
      default:
        this.broadcastUi('activity', { engine: 'launched', kind: event, ...data, at: data.at ?? Date.now() });
    }
  }

  // ------------------------------------------------------------ watching (desktop live view)

  async #watch(ui, handle, on) {
    if (!this.registry.hasHandle(handle)) throw new Error(`Tab ${handle} does not exist.`);
    let set = this.watchers.get(handle);
    if (!on) {
      if (set?.delete(ui.id) && set.size === 0) await this.#stopWatching(handle);
      return { watching: false, tabId: handle };
    }
    if (!set) {
      set = new Set();
      this.watchers.set(handle, set);
    }
    if (set.has(ui.id)) return { watching: true, tabId: handle, runId: this.watchRuns.get(handle) ?? null };
    set.add(ui.id);
    if (set.size === 1) {
      const { runId } = await this.evidence.startRun({ kind: 'watch', label: `tab ${handle}`, tabId: handle, engine: { engineId: this.registry.engineOf(handle) } });
      // startRun did file I/O: an unwatch, the UI disconnecting, or the tab closing may have run
      // meanwhile (admin messages are not serialised). #stopWatching then found no run and sent
      // on:false — and this went on to record the run and send on:true: the tab was screencast and
      // spooled with nobody watching, until the daemon stopped (daemon review, 2026-09-22).
      if (this.watchers.get(handle) !== set || set.size === 0 || !this.registry.hasHandle(handle)) {
        await this.evidence.finishRun(runId, { ok: true, note: 'the watch was cancelled before it started' }).catch(() => {});
        return { watching: false, tabId: handle };
      }
      const engineId = this.registry.engineOf(handle);
      this.watchRuns.set(handle, runId);
      if (this.registry.engineKind(engineId) === 'extension') {
        const ext = this.registry.getClient(engineId);
        ext?.send({ type: 'watch', tabId: this.registry.chromeTabOf(handle, engineId), on: true });
      } else {
        // A LAUNCHED engine's stream starts over CDP, so this is a second wait — and the guard
        // above is already spent. Two things can happen inside it, and the answer must tell the
        // truth about both, or the desktop shows a live view that is not live and the watch run
        // stays open until the daemon stops (the mirror of the cancelled watch above).
        const problem = await this.engines.watch(handle, true, 'ui-watch', {
          onFrame: (frame) => this.#watchData(handle, 'frame', frame),
          onPointer: (sample) => this.#watchData(handle, 'pointer', { tabId: handle, sample }),
          onStatus: (status) => this.#watchData(handle, 'status', status),
          runId,
        }).then(() => null, (err) => String(err?.message ?? err));
        // The browser refused the screencast (the tab closed or navigated mid-start, Engine 2's
        // tool runtime is not loaded): there is nothing to watch, so nobody is left watching it.
        if (problem) {
          this.log(`[watch] tab ${handle}: ${problem}`);
          if (this.watchers.get(handle) === set) await this.#stopWatching(handle);
          return { watching: false, tabId: handle, problem };
        }
        // Or an unwatch arrived while it was starting. EngineManager.watch runs one change per tab
        // at a time, so that stop is already queued behind this start and will undo it; all this
        // has to do is not claim otherwise.
        if (this.watchers.get(handle) !== set) return { watching: false, tabId: handle };
      }
    }
    return { watching: true, tabId: handle, runId: this.watchRuns.get(handle) ?? null };
  }

  async #stopWatching(handle) {
    const runId = this.watchRuns.get(handle);
    this.watchRuns.delete(handle);
    this.watchers.delete(handle);
    const engineId = this.registry.engineOf(handle);
    if (engineId && this.registry.engineKind(engineId) === 'extension') {
      this.registry.getClient(engineId)?.send({ type: 'watch', tabId: this.registry.chromeTabOf(handle, engineId), on: false });
    } else {
      await this.engines.watch(handle, false, 'ui-watch').catch(() => {});
    }
    if (runId) await this.evidence.finishRun(runId, { ok: true }).catch(() => {});
  }

  /** Frames and pointer samples for a watched tab: spooled, then multicast to its watchers. */
  #watchData(handle, kind, data) {
    const runId = this.watchRuns.get(handle);
    const set = this.watchers.get(handle);
    if (kind === 'frame') {
      if (runId) this.evidence.frame(runId, data);
      const payload = { type: 'event', topic: 'frame', data: { tabId: handle, data: data.data, metadata: data.metadata ?? null, at: data.at ?? Date.now() } };
      for (const id of set ?? []) this.registry.getClient(id)?.conn?.sendDroppable(payload);
    } else if (kind === 'pointer') {
      const sample = data.sample ?? data;
      if (runId) this.evidence.pointer(runId, sample);
      const payload = { type: 'event', topic: 'pointer', data: { tabId: handle, sample } };
      for (const id of set ?? []) this.registry.getClient(id)?.conn?.sendDroppable(payload, 2 * 1024 * 1024);
    } else if (kind === 'status') {
      // Whether the picture is live (lib/screencast.js watchdog): 'hidden' — the
      // tab renders no frames, so the last one is stale; 'idle'; 'live'. Rare and
      // small, so never dropped.
      const { tabId: _ignored, ...status } = data ?? {};
      const payload = { type: 'event', topic: 'watchStatus', data: { tabId: handle, ...status } };
      for (const id of set ?? []) this.registry.getClient(id)?.send?.(payload);
    }
  }
}

/**
 * An admin op's arguments, collision-free (DAEMON_PROTOCOL §6). They may be
 * spread at the top level of the message or sent as `args`; the entry an op
 * is ABOUT (schedule.remove/runNow) travels as `entryId` (or `args.id`),
 * because the message's own `id` is the request correlation id and must never
 * be read as anything else.
 */
export function adminArgs(msg) {
  const { type, id, op, args, entryId, scheduleId, ...top } = msg;
  // `args` is the argument envelope when it is an object; an ARRAY is a
  // schedule entry's own runner arguments spread at the top level.
  const envelope = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const merged = { ...top, ...(Array.isArray(args) ? { args } : {}), ...envelope };
  const entry = entryId ?? scheduleId ?? (args && typeof args === 'object' ? args.id : undefined);
  if (entry !== undefined && entry !== null) merged.id = entry;
  else delete merged.id;
  return merged;
}

function requireArg(msg, key, wireName = key) {
  if (msg[key] == null || msg[key] === '') throw new Error(`This admin op needs "${wireName}".`);
  return msg[key];
}

function withoutOp(msg) {
  const { op, ...rest } = msg;
  return rest;
}

/** One-line description of a call for the activity view (as sw.js summarises). */
export function summarize(tool, args) {
  const bits = [];
  if (args.action) bits.push(args.action);
  if (args.what) bits.push(args.what);
  if (args.ref) bits.push(args.ref);
  if (args.selector) bits.push(args.selector);
  if (args.url) bits.push(args.url);
  if (args.tabId != null) bits.push(`tab ${args.tabId}`);
  if (args.session) bits.push(`session ${args.session}`);
  if (args.text) bits.push(JSON.stringify(String(args.text).slice(0, 40)));
  if (args.expression) bits.push(String(args.expression).slice(0, 60));
  return bits.length ? `${tool}(${bits.join(' ')})` : tool;
}
