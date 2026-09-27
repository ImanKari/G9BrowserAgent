/**
 * The desktop's one connection to g9d, as role 'ui' (DAEMON_PROTOCOL.md).
 *
 * Owns: the connect/hello/welcome handshake, reconnect with backoff, keep-alive, request ids and
 * per-request timeouts for `call` and `admin`, and the fan-out of `{type:'event', topic, data}`.
 * It does NOT decide whether to start a daemon — that is `onRefused`, supplied by main.mjs, so
 * `--smoke` and the tests can run the same client without ever spawning anything.
 *
 * States (`client.state.status`):
 *   connecting → connected                      the normal path
 *   connecting → starting → connected           nothing listened; main launched g9d and we wait for it
 *   connecting → waiting → connecting …         backoff between attempts (0.5 s doubling to 15 s)
 *   foreign                                     the port answers but it is not g9d (a v1 bridge) — never
 *                                               touched, only re-probed slowly until it goes away
 *   refused                                     the daemon said no (welcome.problem); no retry until
 *                                               reconnectNow(), as the extension does (ARCH §14)
 *   stopped                                     stop() was called
 */

import { EventEmitter } from 'node:events';
import { WsClient } from './ws.mjs';

export const DEFAULT_CALL_TIMEOUT_MS = Number(process.env.G9_TIMEOUT_MS) > 0 ? Number(process.env.G9_TIMEOUT_MS) : 120_000;

/** Admin ops that legitimately take long. Everything else gets 60 s. */
export const ADMIN_TIMEOUTS_MS = {
  'engines.installCft': 30 * 60_000, // ~150 MB download + verify + extract on a slow link
  'profiles.warm': 5 * 60_000,
  'extension.install': 2 * 60_000,
  'runs.get': 2 * 60_000,
  'schedule.runNow': 2 * 60_000,
  shutdown: 20_000,
};

/**
 * How long to wait for one tool call: DAEMON_PROTOCOL §3's table, with `floor` (G9_TIMEOUT_MS,
 * default 120 s) as the minimum. The daemon keeps working on a call for that long; giving up
 * earlier here would report "failed" for an engine launch that then succeeds a minute later.
 */
export function callTimeoutMs(tool, args = {}, floor = DEFAULT_CALL_TIMEOUT_MS) {
  const a = args && typeof args === 'object' ? args : {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  let ms = 0;
  switch (tool) {
    case 'browser_recording':
      if (a.action === 'replay' || a.action === 'calibrate') ms = 30 * 60_000;
      break;
    case 'browser_navigate':
      ms = num(a.timeoutMs, a.action === 'wait' ? 15_000 : 30_000) + 15_000;
      break;
    case 'browser_tabs':
      if (a.action === 'wait') ms = num(a.timeoutMs, 30_000) + 15_000;
      else if (['open', 'session', 'handoff'].includes(a.action)) ms = 3 * 60_000;
      break;
    case 'browser_network':
      if (a.action === 'wait_download') ms = num(a.timeoutMs, 30_000) + 15_000;
      break;
    case 'browser_diagnose':
      // `what`, as the daemon reads it (daemon/router.js timeoutFor): browser_diagnose has no
      // `action`, so reading one gave a long performance trace only the floor.
      if (a.what === 'performance') ms = num(a.durationMs, 5_000) + 60_000;
      break;
    case 'browser_engine':
      if (a.action === 'launch' || a.action === 'warm') ms = 3 * 60_000;
      else if (a.action === 'versions' && a.download) ms = 30 * 60_000;
      break;
    default:
      break;
  }
  return Math.max(floor, ms);
}

const RESERVED = new Set(['type', 'id', 'op']);

/**
 * Build an admin frame. DAEMON_PROTOCOL §6 spreads the op's arguments into the message
 * (`{type:'admin', id, op, …}`), but two ops take an argument literally called `id`
 * (`schedule.remove` / `schedule.runNow {id}`), which collides with the request id. So:
 *   - every argument except type/id/op is spread at the top level, as the protocol shows;
 *   - the complete argument object is also sent as `args` (the collision-free form);
 *   - an argument `id` is additionally sent as `entryId`.
 * A daemon reading either form gets the right value; the request id is never overwritten.
 */
export function buildAdminMessage(requestId, op, args = {}) {
  const msg = { type: 'admin', id: requestId, op };
  const a = args && typeof args === 'object' ? args : {};
  for (const [k, v] of Object.entries(a)) if (!RESERVED.has(k) && k !== 'args') msg[k] = v;
  if (a.id !== undefined) msg.entryId = a.id;
  if (Object.keys(a).length) msg.args = a;
  return msg;
}

export function buildCallMessage(requestId, tool, args = {}) {
  return { type: 'call', id: requestId, tool, args: args ?? {} };
}

/** Backoff for attempt n (0-based): 500 ms doubling, capped. Deterministic so the UI can show it. */
export function backoffDelay(attempt, { initialMs = 500, maxMs = 15_000, factor = 2 } = {}) {
  return Math.min(maxMs, Math.round(initialMs * factor ** Math.max(0, attempt)));
}

export class DaemonClient extends EventEmitter {
  /**
   * @param {object} o
   * @param {number} o.port
   * @param {string} o.version          the desktop's version, sent in hello
   * @param {(info) => Promise<{launched?: boolean, foreign?: object, held?: string}|void>} [o.onRefused]
   *        called when nothing listens on the port; may start g9d (`held`: it chose not to, and why)
   * @param {(err) => Promise<object|null>} [o.onUpgradeRefused]
   *        called when something answers HTTP but refuses the upgrade; returns what it is
   */
  constructor({
    port,
    host = '127.0.0.1',
    version,
    clientName = 'g9-desktop',
    role = 'ui',
    WebSocketImpl = WsClient,
    callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    welcomeTimeoutMs = 10_000,
    startupWaitMs = 10_000,
    keepAliveMs = 20_000,
    deadAfterMs = 65_000,
    backoff = {},
    onRefused = null,
    onUpgradeRefused = null,
    log = null,
    now = () => Date.now(),
  }) {
    super();
    this.setMaxListeners(50);
    this.host = host;
    this.port = port;
    this.url = `ws://${host}:${port}/g9`;
    this.version = version;
    this.clientName = clientName;
    this.role = role;
    this.WebSocketImpl = WebSocketImpl;
    this.callTimeoutMs = callTimeoutMs;
    this.welcomeTimeoutMs = welcomeTimeoutMs;
    this.startupWaitMs = startupWaitMs;
    this.keepAliveMs = keepAliveMs;
    this.deadAfterMs = deadAfterMs;
    this.backoffOpts = backoff;
    this.onRefused = onRefused;
    this.onUpgradeRefused = onUpgradeRefused;
    this.log = log;
    this.now = now;

    this.ws = null;
    // Bumped by every connect/stop/reconnectNow. An async failure path (the onRefused hook probes
    // /health and may spawn g9d) compares it after its await: if the world moved on meanwhile, it
    // must not schedule another connect — that would open a second, orphaned 'ui' socket.
    this.generation = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.attempt = 0;
    this.retryTimer = null;
    this.keepAliveTimer = null;
    this.welcomeTimer = null;
    this.lastInbound = 0;
    this.startingUntil = 0;
    this.wanted = false;
    this.welcome = null;
    this._state = { status: 'idle', port, url: this.url, error: null, since: now() };
  }

  get state() {
    return { ...this._state };
  }

  get connected() {
    return this._state.status === 'connected';
  }

  #setState(patch) {
    const prev = this._state;
    const next = { ...prev, ...patch };
    if (patch.status && patch.status !== prev.status) next.since = this.now();
    this._state = next;
    this.emit('state', this.state);
  }

  /** Begin connecting and keep the connection up until stop(). */
  start() {
    this.wanted = true;
    if (this.ws || this.retryTimer) return;
    this.#connect();
  }

  stop() {
    this.wanted = false;
    this.generation += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.#teardown('The desktop closed the connection');
    this.#setState({ status: 'stopped', error: null });
  }

  /** Reset the backoff and connect now (also leaves 'refused'/'foreign'). */
  reconnectNow() {
    this.wanted = true;
    this.attempt = 0;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.#teardown('Reconnecting');
    this.#connect();
  }

  /** Resolves once connected (or rejects after `timeoutMs`). */
  whenConnected(timeoutMs = 10_000) {
    if (this.connected) return Promise.resolve(this.welcome);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('welcome', onWelcome);
        reject(new Error(this.#notConnectedMessage()));
      }, timeoutMs);
      const onWelcome = (w) => {
        clearTimeout(timer);
        resolve(w);
      };
      this.once('welcome', onWelcome);
    });
  }

  #notConnectedMessage() {
    const s = this._state;
    const why = s.error ? ` (${s.error})` : '';
    return `The G9BrowserAgent daemon is not connected on port ${this.port}: ${s.status}${why}.`;
  }

  #connect() {
    if (!this.wanted) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    // Never two sockets: a connect while one is open or opening replaces nothing, it is a no-op.
    if (this.ws) return;
    const generation = ++this.generation;
    const starting = this.startingUntil > this.now();
    this.#setState({ status: starting ? 'starting' : 'connecting', attempt: this.attempt, nextRetryAt: null });
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url, { connectTimeoutMs: 5000 });
    } catch (err) {
      this.#scheduleRetry(err);
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.on('open', () => {
      opened = true;
      this.lastInbound = this.now();
      ws.send(JSON.stringify({
        type: 'hello',
        role: this.role,
        version: this.version,
        client: { name: this.clientName, pid: process.pid },
      }));
      this.welcomeTimer = setTimeout(() => {
        this.log?.warn?.('No welcome from the daemon; reconnecting');
        ws.close(4000, 'no welcome');
      }, this.welcomeTimeoutMs);
    });
    ws.on('message', (text) => this.#onMessage(text));
    ws.on('error', () => { /* the close event carries the reason */ });
    ws.on('close', ({ code, reason } = {}) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearTimeout(this.welcomeTimer);
      clearInterval(this.keepAliveTimer);
      const wasConnected = this._state.status === 'connected';
      this.welcome = null;
      this.#rejectAll(new Error(`The daemon connection closed${reason ? `: ${reason}` : ''}.`));
      if (!this.wanted) return;
      if (this._state.status === 'refused') return;
      const err = ws.lastError ?? (opened ? new Error(reason || `closed (${code})`) : new Error(reason || 'connection failed'));
      if (wasConnected) {
        this.attempt = 0;
        this.log?.warn?.('Daemon connection lost', { code, reason });
        this.emit('disconnected', { code, reason });
      }
      this.#onConnectFailure(err, { opened, generation });
    });
  }

  /** True while no stop()/reconnectNow()/new connect happened since `generation` was taken. */
  #current(generation) {
    return this.wanted && this.generation === generation && !this.ws && !this.retryTimer;
  }

  async #onConnectFailure(err, { opened, generation }) {
    const code = err?.code;
    if (!opened && (code === 'ECONNREFUSED' || code === 'ECONNRESET') && this.onRefused && this.startingUntil <= this.now()) {
      // Nothing listens: this is where main may start g9d. The hook decides; we only wait for it.
      try {
        const outcome = await this.onRefused({ port: this.port, error: err });
        if (!this.#current(generation)) return;
        if (outcome?.launched) {
          this.startingUntil = this.now() + this.startupWaitMs;
          this.#setState({ status: 'starting', error: null, pid: outcome.pid ?? null });
          this.retryTimer = setTimeout(() => this.#connect(), 300);
          return;
        }
        if (outcome?.foreign) {
          this.#markForeign(outcome.foreign);
          return;
        }
        if (outcome?.held) {
          // Deliberately not started (the person shut it down): keep looking, say why.
          this.#scheduleRetry(new Error(outcome.held));
          return;
        }
      } catch (hookErr) {
        if (!this.#current(generation)) return;
        this.log?.error?.('Starting the daemon failed', String(hookErr?.message ?? hookErr));
        this.#setState({ error: `Could not start the daemon: ${hookErr?.message ?? hookErr}` });
      }
    }
    if (!opened && code === 'EUPGRADE' && this.onUpgradeRefused) {
      try {
        const foreign = await this.onUpgradeRefused(err);
        if (!this.#current(generation)) return;
        if (foreign) {
          this.#markForeign(foreign);
          return;
        }
      } catch {
        /* fall through to a normal retry */
      }
      if (!this.#current(generation)) return;
    }
    if (!this.#current(generation)) return;
    if (this.startingUntil > this.now()) {
      // A daemon we just started is still binding its port: poll quickly, without growing backoff.
      this.#setState({ status: 'starting', error: null });
      this.retryTimer = setTimeout(() => this.#connect(), 300);
      return;
    }
    this.#scheduleRetry(err);
  }

  #markForeign(foreign) {
    const message = foreign.message ?? `Port ${this.port} is in use by something that is not the G9BrowserAgent daemon.`;
    this.#setState({ status: 'foreign', error: message, foreign });
    this.emit('foreign', foreign);
    // Never touch it; look again slowly so the app recovers by itself once it goes away.
    this.retryTimer = setTimeout(() => this.#connect(), 15_000);
  }

  #scheduleRetry(err) {
    if (!this.wanted) return;
    const delay = backoffDelay(this.attempt, this.backoffOpts);
    this.attempt += 1;
    this.#setState({
      status: 'waiting',
      error: describeConnectError(err, this.port),
      attempt: this.attempt,
      nextRetryAt: this.now() + delay,
    });
    this.retryTimer = setTimeout(() => this.#connect(), delay);
  }

  #onMessage(text) {
    this.lastInbound = this.now();
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'welcome':
        clearTimeout(this.welcomeTimer);
        if (msg.problem) {
          // The daemon refuses us (version skew). Do not hammer it; the person must act.
          this.#setState({ status: 'refused', error: String(msg.problem) });
          this.emit('refused', msg);
          this.ws?.close(1000, 'refused');
          return;
        }
        this.welcome = msg;
        this.attempt = 0;
        this.startingUntil = 0;
        this.#setState({
          status: 'connected',
          error: null,
          foreign: null,
          id: msg.id ?? null,
          daemonVersion: msg.version ?? null,
          daemonPid: msg.daemonPid ?? null,
          repoRoot: msg.repoRoot ?? null,
          project: msg.project ?? null,
          home: msg.home ?? null,
          halted: normalizeHalt(msg.halted ?? { global: false }, { global: false }),
        });
        this.#startKeepAlive();
        this.emit('welcome', msg);
        return;
      case 'result': {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(Object.assign(new Error(String(msg.error ?? 'The daemon reported a failure with no message.')), { remote: true }));
        return;
      }
      case 'event':
        if (msg.topic === 'halt' && msg.data && typeof msg.data === 'object') {
          this.#setState({ halted: normalizeHalt(msg.data, this._state.halted) });
        }
        this.emit('event', { topic: msg.topic, data: msg.data });
        return;
      case 'halt':
        // The extension-facing mirror; a daemon may send it to UI clients too.
        this.#setState({ halted: normalizeHalt(msg, this._state.halted) });
        this.emit('event', { topic: 'halt', data: { halted: !!msg.halted } });
        return;
      case 'ping':
        this.#send({ type: 'pong', at: msg.at });
        return;
      case 'pong':
        return;
      default:
        this.emit('message', msg);
    }
  }

  #startKeepAlive() {
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => {
      if (!this.ws) return;
      if (this.now() - this.lastInbound > this.deadAfterMs) {
        this.log?.warn?.('The daemon stopped answering pings; reconnecting');
        this.ws.close(4001, 'keep-alive timeout');
        return;
      }
      this.#send({ type: 'ping', at: this.now() });
    }, this.keepAliveMs);
    this.keepAliveTimer.unref?.();
  }

  #send(obj) {
    if (!this.ws) return false;
    return this.ws.send(JSON.stringify(obj));
  }

  #request(frame, timeoutMs, label) {
    if (!this.connected) return Promise.reject(new Error(this.#notConnectedMessage()));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(frame.id);
        reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.pending.set(frame.id, { resolve, reject, timer, label });
      if (!this.#send(frame)) {
        clearTimeout(timer);
        this.pending.delete(frame.id);
        reject(new Error(this.#notConnectedMessage()));
      }
    });
  }

  /** A tool call, exactly as an agent makes it (DAEMON_PROTOCOL §3), with that tool's timeout. */
  call(tool, args = {}, { timeoutMs = callTimeoutMs(tool, args, this.callTimeoutMs) } = {}) {
    const id = this.nextId++;
    return this.#request(buildCallMessage(id, tool, args), timeoutMs, `${tool}`);
  }

  /** An admin op (DAEMON_PROTOCOL §6). */
  admin(op, args = {}, { timeoutMs = ADMIN_TIMEOUTS_MS[op] ?? 60_000 } = {}) {
    const id = this.nextId++;
    return this.#request(buildAdminMessage(id, op, args), timeoutMs, `admin ${op}`);
  }

  #rejectAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  #teardown(reason) {
    clearTimeout(this.welcomeTimer);
    clearInterval(this.keepAliveTimer);
    const ws = this.ws;
    this.ws = null;
    this.welcome = null;
    this.#rejectAll(new Error(`${reason}.`));
    try { ws?.close(1000, reason); } catch { /* gone */ }
  }
}

/**
 * Fold a halt notice into `{ global: boolean, by, at }`. Shapes seen on the wire:
 *   welcome.halted            { global: true, by: 'panel' }
 *   UI event 'halt'           { global: { halted, by, at, resumedBy } }            (a global change)
 *                             { global: {…}, agentId: 'agent-2', halted: true }     (an agent's halt)
 *   daemon → extension mirror { type: 'halt', halted: true }
 * An agent's halt does not change the global state (the 'agents' event carries it).
 */
export function normalizeHalt(data, prev = { global: false }) {
  if (!data || typeof data !== 'object') return prev;
  const g = data.global;
  if (g && typeof g === 'object') return { global: !!g.halted, by: g.halted ? g.by ?? null : null, at: g.at ?? null };
  if (typeof g === 'boolean') return { ...prev, ...data };
  if (data.agentId) return prev;
  if (typeof data.halted === 'boolean') return { global: data.halted, by: data.halted ? data.by ?? null : null };
  return prev;
}

/** One sentence for the status line. */
export function describeConnectError(err, port) {
  const code = err?.code;
  if (code === 'ECONNREFUSED') return `Nothing is listening on 127.0.0.1:${port}.`;
  if (code === 'ETIMEDOUT') return `127.0.0.1:${port} did not answer in time.`;
  if (code === 'EUPGRADE') return `127.0.0.1:${port} refused the connection (HTTP ${err.status}).`;
  if (code === 'ECONNRESET') return `127.0.0.1:${port} reset the connection.`;
  return String(err?.message ?? err ?? 'connection failed');
}
