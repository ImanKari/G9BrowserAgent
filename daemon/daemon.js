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
 * Why one daemon and not one bridge per agent (D5, AIGuide §2.0): v1's extension could
 * talk to exactly one bridge, so the second editor window, the runner and any
 * second agent all fought over one port and one browser. Here every agent's
 * shim is a client of the same process, which owns every engine and decides —
 * per tab, not per socket — who may do what.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { VERSION, REPO_ROOT, majorOf } from '../lib/version.mjs';
import { installId } from '../lib/runtime.mjs';

/** This installation, stable across restarts (an AppImage's resource root is a new mount every start). */
const INSTALL_ID = installId({ root: REPO_ROOT });
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
      info: () => ({ pid: process.pid, port: this.port, home: this.home.replace(/\\/g, '/'), repoRoot: REPO_ROOT, installId: INSTALL_ID, startedAt: this.startedAt }),
    });
    this.router.emitUi = (topic, data) => this.broadcastUi(topic, data);
    this.router.onHaltFromEngine = (engineId, halted, by) => this.setGlobalHalt(halted, by, { except: engineId });
    this.router.onWatchData = (handle, kind, data) => this.#watchData(handle, kind, data);
    this.router.onWatchRequest = (req) => this.requestWatch(req);
    // (3.2) An approval in the launched-engine store goes beside the flow in the repository.
    this.engines.onApproved = async (id) => {
      const bundle = await this.engines.approvedBundle(id);
      if (!bundle) return { written: false, reason: 'nothing approved to write' };
      const result = await this.writeApprovedAnywhere(bundle.flowId, bundle.approved, bundle.images);
      if (result.written) this.log(`[flows] approval of ${bundle.flowId} written to ${result.project}: ${result.file}`);
      return result;
    };

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
    this.libraries = new Map(); // flowsDir → FlowLibrary, for connected agents' projects (3.2)
    this.projectCache = new Map();

    this.watchers = new Map(); // handle → Set(uiId)
    this.watchRuns = new Map(); // handle → runId
    this.idleSince = Date.now();
    this.v1Refusals = new Map(); // origin → last log time

    this.ws = new WsServer({ port: this.port, health: () => this.health() });
    this.ws.on('connection', (conn, meta) => this.#onConnection(conn, meta));
    this.ws.on('rejected', ({ origin, path: p, code, reason }) => this.log(`[ws] refused ${code} ${reason} (origin "${origin || '-'}", path ${p})`));
    this.ws.on('protocolError', ({ reason }) => this.log(`[ws] dropped a connection: ${reason}`));

    // 'agents' also fires when an agent's current tab changes (registry.setCurrent): the panel's
    // agent rows name that tab (v3). #schedulePush coalesces, so a busy agent costs one push per 100 ms.
    this.registry.on('agents', () => this.#schedulePush());
    // (v3) The connected agents' project sites, for the extension's auto-attach "Project sites".
    this.registry.on('clients', ({ role }) => {
      if (role === 'agent') this.#scheduleProjects();
    });
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
      // A closed tab takes every agent's "current" pointer to it along (registry.dropHandle), silently.
      this.#schedulePush();
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
      /** This installation (lib/runtime.mjs installId): the .AppImage file for an AppImage, else the resource root. */
      installId: INSTALL_ID,
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
    // (3.2) "viewer": the extension's watch window. It may list tabs and watch them, nothing else —
    // no calls, no admin — so an extension origin is enough (web pages never get this far: the
    // WebSocket upgrade refuses http(s) origins, ws-server.js).
    if (!['agent', 'engine', 'ui', 'viewer'].includes(role)) {
      conn.send({ type: 'welcome', version: VERSION, daemonPid: process.pid, id: null, problem: `Unknown role "${msg.role}". Use agent, engine, ui or viewer.` });
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
        problem: 'The "ui" role (admin operations) is only for native clients — the G9BrowserAgent desktop app — which send no Origin header. Connect as "engine" or "agent".',
      });
      setTimeout(() => conn.close(4003, 'ui role needs a native client'), 50).unref?.();
      this.log(`[g9d] refused a "ui" hello from origin ${meta.origin ?? '-'}: admin is for native clients only`);
      return null;
    }

    if (role === 'engine' && !(majorOf(msg.version) >= 2)) {
      const problem =
        `This is the G9BrowserAgent extension v${msg.version ?? '?'}, but port ${this.port} now runs the G9BrowserAgent v2 daemon (g9d v${VERSION}). ` +
        'A v1 extension cannot work with it. Reload the extension from the v2 folder: open edge://extensions or ' +
        'chrome://extensions, find G9BrowserAgent and press Reload (or Load unpacked the "extension" folder of the ' +
        'v2 install).';
      conn.send({ type: 'welcome', version: VERSION, daemonPid: process.pid, id: null, repoRoot: REPO_ROOT.replace(/\\/g, '/'), problem });
      setTimeout(() => conn.close(4001, 'G9BrowserAgent v1 extension: reload the v2 extension (g9d v2 runs here)'), 50).unref?.();
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
      installId: INSTALL_ID,
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
      this.#pushProjects(client);
      this.#catchUpExtension(client, msg.version).catch((err) => this.log(`[g9d] extension catch-up failed: ${err.message}`));
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
    if (client.role === 'ui' || client.role === 'viewer') {
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
    // (3.2) A viewer watches and nothing else: no calls, no requests, no flow library, no admin.
    if (client.role === 'viewer' && msg.type !== 'viewer') {
      if (msg.id != null) client.send({ type: 'viewerResult', id: msg.id, ok: false, error: 'A viewer (the watch window) may only list and watch tabs.' });
      return;
    }
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
      case 'viewer':
        return this.#viewerMessage(client, msg);
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
    if (op === 'projects') return this.#libraryList();
    // An approval names no project: it goes where the flow is.
    if (op === 'writeApproved' && !msg.project) return this.writeApprovedAnywhere(flowId(), msg.approved, msg.images ?? {});
    // (3.2) `project` names WHICH library: a g9.project.json path from the `projects` op. Without
    // it, the daemon's own project, as before 3.2.
    const lib = this.#libraryFor(msg.project ?? null);
    const site = typeof msg.site === 'string' && msg.site ? msg.site : null;
    switch (op) {
      case 'list': return lib.list({ site });
      case 'read': return { spec: await lib.read(flowId()) };
      case 'write': return lib.write(msg.spec);
      case 'remove': return lib.remove(flowId());
      case 'status': return lib.status(msg.local ?? [], { site });
      case 'suite': return lib.resolveSuite(msg.suiteId);
      case 'readApproved': return lib.readApproved(flowId());
      case 'writeApproved': return lib.writeApproved(flowId(), msg.approved, msg.images ?? {});
      default:
        throw new Error(`Unknown flow-library op "${op}". Known: projects, list, read, write, remove, status, suite, readApproved, writeApproved.`);
    }
  }

  /**
   * (3.2) An approval made where no project was named (an agent's approve, the runner's, the
   * panel's) belongs in whichever library holds that flow: the daemon's own project first, then the
   * connected agents'. `{ written: false, reason }` when none holds it — a flow nobody pushed yet.
   */
  async writeApprovedAnywhere(flowId, approved, images) {
    const rows = this.#libraryRows().sort((a, b) => Number(b.own) - Number(a.own));
    for (const row of rows) {
      const lib = this.#libraryFor(row.project.path);
      const result = await lib.writeApproved(flowId, approved, images);
      if (result.written) return { ...result, project: row.project.path };
    }
    return { written: false, reason: rows.length
      ? `Flow ${flowId} is in none of the flow libraries (${rows.map((r) => r.project.flowsDir).join(', ')}): push it, and its approval travels with it.`
      : 'No flow library: no g9.project.json for the daemon or any connected agent.' };
  }

  /**
   * (3.2) Every flow library this daemon can reach: its own project's (the folder it was started
   * in) and each connected agent's. One row per g9.project.json. The panel's Repository card
   * used to reach only the daemon's own project — the project of whichever session happened to
   * start the daemon — so a QA working in a second project could neither pull nor push its flows.
   * Only projects that exist here are offered: a path is never taken from the caller.
   */
  #libraryRows() {
    const rows = new Map();
    const add = (project, { own = false, agentId = null } = {}) => {
      if (!project?.found || !project.path || !project.flowsDir) return;
      let row = rows.get(project.path);
      if (!row) {
        row = { project, own: false, agents: [] };
        rows.set(project.path, row);
      }
      if (own) row.own = true;
      if (agentId && !row.agents.includes(agentId)) row.agents.push(agentId);
    };
    add(this.project, { own: true });
    for (const agent of this.registry.agents()) add(agent.project, { agentId: agent.id });
    return [...rows.values()];
  }

  #libraryList() {
    const rows = this.#libraryRows();
    const fallback = rows.find((r) => r.own) ?? rows[0] ?? null;
    return {
      default: fallback?.project.path ?? null,
      projects: rows.map((r) => ({
        name: projectLabel(r.project, null),
        path: r.project.path,
        root: r.project.root,
        flowsDir: r.project.flowsDir,
        own: r.own,
        agents: r.agents,
        domains: environmentHosts(r.project.environments),
      })),
    };
  }

  /** The library for a project path from #libraryRows, or the default one; a stranger path is refused. */
  #libraryFor(projectPath) {
    const rows = this.#libraryRows();
    let row;
    if (projectPath == null || projectPath === '') {
      row = rows.find((r) => r.own) ?? rows[0] ?? null;
      if (!row) return this.flows; // unavailable: it explains itself (no g9.project.json)
    } else {
      row = rows.find((r) => r.project.path === String(projectPath));
      if (!row) {
        throw new Error(`"${projectPath}" is not the g9.project.json of this daemon or of a connected agent, so its flow library is not offered. ` +
          `Known: ${rows.map((r) => r.project.path).join(', ') || '(none)'}.`);
      }
    }
    if (row.project === this.project) return this.flows;
    const key = row.project.flowsDir;
    if (!this.libraries.has(key)) this.libraries.set(key, new FlowLibrary(key));
    return this.libraries.get(key);
  }

  // ------------------------------------------------------------ admin (ui)

  async #admin(client, msg) {
    const reply = (ok, payload) => client.send({ type: 'result', id: msg.id, ok, ...(ok ? { result: payload } : { error: payload }) });
    if (client.role !== 'ui') return reply(false, 'Admin operations are for the G9BrowserAgent desktop app (role "ui"). Agents cannot halt, resume or reconfigure the daemon.');
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
  /**
   * An extension older than this daemon whose folder already holds this version gets one reload.
   *
   * After an app update the desktop refreshes G9_HOME/extension and asks every CONNECTED extension to
   * reload — but the extension is usually reconnecting at that moment (the old daemon was stopped for
   * the install), so the ask reached nobody and the browser kept running the old code from the new
   * folder: a version mismatch that nothing ever cleared (found by desktop/test/update-e2e.mjs). So
   * the daemon checks at hello: extension older than the daemon, and the folder the updater writes
   * is the daemon's version → reload, once the extension has no call in flight. At most once per
   * extension instance and version: an extension loaded from another folder comes back unchanged,
   * and is then only reported (browser_status versionMismatch), never reloaded in a loop.
   */
  async #catchUpExtension(client, version) {
    if (!version || version === VERSION) return;
    let folder = null;
    try {
      folder = JSON.parse(await fs.promises.readFile(path.join(this.paths.extensionDir, 'manifest.json'), 'utf8')).version ?? null;
    } catch {
      return; // no G9_HOME/extension (a repository checkout loads extension/ directly)
    }
    if (folder !== VERSION) return;
    this.catchUpAsked ??= new Set();
    const key = `${client.instanceId ?? client.id}:${version}`;
    if (this.catchUpAsked.has(key)) return;
    this.catchUpAsked.add(key);
    const deadline = Date.now() + 60_000;
    while (this.router.inFlight(client.id) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    if (this.registry.getClient(client.id) !== client) return; // gone meanwhile; it loads the new files when it comes back
    client.send({ type: 'reload' });
    this.log(`[g9d] ${client.id} is v${version} but ${this.paths.extensionDir} holds v${VERSION}: asked it to reload`);
  }

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

  /**
   * The agent rows ONE extension's panel shows (DAEMON_PROTOCOL §5), tab ids as that browser's
   * Chrome ids. v3 adds who each agent is and where it works: v2 sent only `owned`, so three agents
   * rendered as three identical rows (U4, AIGuide §6.10).
   * - `project`: the folder name of the agent's project (g9.project.json's folder), else of its cwd;
   * - `current`: its current tab as THIS browser's Chrome tab id, or null;
   * - `currentEngine`: 'extension' (that tab is in this browser), 'launched' (an Engine 2 tab: no
   *   Chrome id to show — engine rows carry no tab titles, so none is sent), 'elsewhere' (a tab of
   *   ANOTHER browser's extension), or null (no current tab).
   */
  #agentsFor(ext) {
    return this.registry.agentRows().map((a) => {
      const client = this.registry.getClient(a.id);
      let current = null;
      let currentEngine = null;
      if (a.current != null) {
        const engineId = this.registry.engineOf(a.current);
        const kind = this.registry.engineKind(engineId);
        if (engineId === ext.id) current = this.registry.chromeTabOf(a.current, ext.id);
        currentEngine = current != null ? 'extension' : kind === 'launched' ? 'launched' : kind === 'extension' ? 'elsewhere' : null;
      }
      return {
        id: a.id,
        name: a.name,
        owned: a.owned.map((h) => this.registry.chromeTabOf(h, ext.id)).filter((n) => n != null),
        halted: a.halted,
        project: projectLabel(client?.project, client?.cwd),
        cwd: client?.cwd ?? null,
        current,
        currentEngine,
        // (3.2) The daemon's handle for a tab this browser cannot name (launched, or another
        // browser's): what the panel's Watch opens the live view on.
        ...(a.current != null && current == null ? { currentHandle: a.current } : {}),
      };
    });
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

  /**
   * (v3) `{type:'projects', domains, projects}` for extension engines (DAEMON_PROTOCOL §5): the sites
   * of every CONNECTED agent's project — the hosts (host[:port]) of its `environments` URLs — for
   * the panel's auto-attach "Project sites". One row per project file, naming the agents in it; a
   * project whose environments name no URL contributes nothing. `domains` is the de-duplicated
   * union. A capture filter in the extension, never an access boundary (v2 D6/D7).
   */
  projectsPayload() {
    const byPath = new Map();
    for (const agent of this.registry.agents()) {
      const project = agent.project;
      if (!project?.found || !project.path) continue;
      const domains = environmentHosts(project.environments);
      if (!domains.length) continue;
      let row = byPath.get(project.path);
      if (!row) {
        row = { name: projectLabel(project, null), path: project.path, domains, agents: [] };
        byPath.set(project.path, row);
      }
      row.agents.push(agent.id);
    }
    const projects = [...byPath.values()];
    return { type: 'projects', domains: [...new Set(projects.flatMap((p) => p.domains))], projects };
  }

  /** To one engine (right after its welcome) or to every extension engine. */
  #pushProjects(only = null) {
    const msg = this.projectsPayload();
    for (const ext of only ? [only] : this.registry.extensionEngines()) ext.send(msg);
  }

  /** Coalesced like #schedulePush: a runner starting four agents at once costs one push. */
  #scheduleProjects() {
    if (this.projectsTimer) return;
    this.projectsTimer = setTimeout(() => {
      this.projectsTimer = null;
      this.#pushProjects();
    }, 100);
    this.projectsTimer.unref?.();
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

  /**
   * (3.2) An agent's `browser_tabs action:"watch"`: show the person a live view of a tab. The newest
   * connected extension opens its watch window on it (`{type:'openWatch'}`, DAEMON_PROTOCOL §5) and
   * the desktop app hears `watchRequest`. `on:false` closes that view again (`closeWatch`).
   * Nobody to show it to is an answer, not an error: the agent is told where a person could look.
   */
  requestWatch({ handle, caller = {}, on = true, focus = false }) {
    if (!this.registry.hasHandle(handle)) throw new Error(`Tab ${handle} does not exist.`);
    const engineId = this.registry.engineOf(handle);
    const engineKind = this.registry.engineKind(engineId);
    const url = this.registry.handles.get(handle)?.url ?? null;
    const agent = { id: caller.agentId ?? null, name: caller.name ?? null };
    const exts = this.registry.extensionEngines();
    const uis = this.registry.byRole('ui');
    const shownIn = [];
    if (!on) {
      for (const ext of exts) ext.send({ type: 'closeWatch', handle });
      this.broadcastUi('watchRequest', { tabId: handle, on: false, agent });
      return { tabId: handle, on: false, closedIn: [...exts.map((e) => e.id), ...(uis.length ? ['desktop'] : [])] };
    }
    // The newest extension connection is the browser the person is using (usually the only one).
    const ext = exts[exts.length - 1] ?? null;
    if (ext) {
      ext.send({ type: 'openWatch', handle, engineKind, url, agent, focus: !!focus });
      shownIn.push(`browser (${ext.id})`);
    }
    if (uis.length) {
      this.broadcastUi('watchRequest', { tabId: handle, on: true, engineKind, url, agent });
      shownIn.push('desktop app');
    }
    const where = engineKind === 'launched' ? 'a launched browser' : "the person's own browser";
    return {
      tabId: handle,
      on: true,
      shown: shownIn.length > 0,
      shownIn,
      note: shownIn.length
        ? `A live view of tab ${handle} (in ${where}) is open for the person: frames and your cursor as you act, view only. ` +
          'It stays open until they close it or you call action:"watch" with on:false.'
        : 'Nobody could be shown a live view: no browser with the G9BrowserAgent extension and no G9BrowserAgent desktop app is connected. ' +
          "Ask the person to open the G9BrowserAgent side panel (Session → Live view) or the desktop app's Watch view.",
    };
  }

  /**
   * (3.2) The watch window's requests (DAEMON_PROTOCOL §7): `watchables`, `watch`, `unwatch`, answered as
   * `{type:'viewerResult', id, ok, result|error}`. Frames, pointer samples and watchStatus arrive as the
   * desktop's do (`{type:'event', topic}`), the same stream and the same evidence run.
   */
  async #viewerMessage(client, msg) {
    const reply = (ok, payload) => client.send({ type: 'viewerResult', id: msg.id ?? null, ok, ...(ok ? { result: payload } : { error: payload }) });
    if (client.role !== 'viewer' && client.role !== 'ui') return reply(false, 'Viewer messages are for the watch window (role "viewer").');
    const tab = () => {
      const n = Number(msg.tabId);
      if (!Number.isInteger(n)) throw new Error(`The viewer op "${msg.op}" needs a tabId.`);
      return n;
    };
    try {
      switch (msg.op) {
        case 'watchables': return reply(true, await this.watchables());
        case 'watch': return reply(true, await this.#watch(client, tab(), true));
        case 'unwatch': return reply(true, await this.#watch(client, tab(), false));
        default: return reply(false, `Unknown viewer op "${msg.op}". Known: watchables, watch, unwatch.`);
      }
    } catch (err) {
      return reply(false, String(err?.message ?? err));
    }
  }

  /**
   * (3.2) Every tab there is to watch, for the watch window's picker: its handle, title, URL, which
   * engine (and whether headless), and which agent owns it or works in it.
   */
  async watchables() {
    const rows = await this.router.listTabs(null).catch(() => []);
    const engines = new Map(this.router.engineRows().map((e) => [e.engineId, e]));
    const nameOf = (id) => (id ? this.registry.getClient(id)?.name ?? id : null);
    const currentOf = new Map();
    for (const a of this.registry.agents()) {
      if (a.current == null) continue;
      if (!currentOf.has(a.current)) currentOf.set(a.current, []);
      currentOf.get(a.current).push({ id: a.id, name: a.name });
    }
    const tabs = [];
    for (const r of rows) {
      if (!Number.isInteger(r?.tabId)) continue;
      const engineId = r.engine ?? r.engineId ?? this.registry.engineOf(r.tabId);
      const owner = this.registry.ownerOf(r.tabId);
      tabs.push({
        tabId: r.tabId,
        title: r.title ?? null,
        url: r.url ?? null,
        engineId,
        engineKind: r.engineKind ?? this.registry.engineKind(engineId),
        headless: engines.get(engineId)?.headless ?? null,
        browser: typeof engines.get(engineId)?.browser === 'string' ? engines.get(engineId).browser : (engines.get(engineId)?.browser?.kind ?? null),
        owner: owner ? { id: owner, name: nameOf(owner) } : null,
        agents: currentOf.get(r.tabId) ?? [],
        watched: this.watchers.has(r.tabId),
      });
    }
    return { tabs };
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

/**
 * (v3) The hosts (host[:port], lower case, default ports omitted) of a project's `environments`:
 * `{ "test1": "https://test1.example.internal" }`, or an object per environment whose string values
 * are URLs (`{ "dev": { "baseUrl": "https://dev.x.test" } }`, one level deep). Anything that is not
 * an http(s) URL is ignored — a typo in one environment must not take the others with it.
 */
export function environmentHosts(environments) {
  const urls = [];
  for (const value of Object.values(environments && typeof environments === 'object' ? environments : {})) {
    if (typeof value === 'string') urls.push(value);
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const inner of Object.values(value)) if (typeof inner === 'string') urls.push(inner);
    }
  }
  const hosts = [];
  for (const raw of urls) {
    try {
      const u = new URL(raw.trim());
      if (/^https?:$/.test(u.protocol) && u.host) hosts.push(u.host.toLowerCase());
    } catch { /* not a URL */ }
  }
  return [...new Set(hosts)];
}

/** An agent's project as the panel names it: its project folder, else its working folder, else null. */
export function projectLabel(project, cwd) {
  const base = (p) => String(p ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null;
  if (project?.found && project.root) return base(project.root);
  return cwd ? base(cwd) : null;
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
