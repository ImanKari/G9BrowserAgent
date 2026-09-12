/**
 * WebSocket link to the local bridge.
 *
 * Two MV3 hazards are handled here:
 *
 *  1. The service worker is killed after ~30s idle. An open WebSocket counts as
 *     activity ONLY while messages flow, so we ping every 20s. Chrome 116+
 *     keeps the worker alive for the duration of an active WS connection that
 *     is actually exchanging data.
 *  2. The worker can still be torn down (browser restart, crash, update). On
 *     restart we reconnect with backoff and rebuild state from storage rather
 *     than assuming anything survived in memory.
 */

import { getState, setState, broadcast } from './state.js';

const api = globalThis.browser ?? globalThis.chrome;

const PING_INTERVAL_MS = 20_000;

/**
 * Reconnect backoff, climbing to a one-minute ceiling.
 *
 * Every failed attempt makes the BROWSER log
 * "WebSocket connection failed: ERR_CONNECTION_REFUSED" into the extension's
 * error console. That log happens below our JavaScript — we cannot catch or
 * suppress it. So the only way to keep the console readable when the bridge is
 * simply not running is to attempt less often. A 15s ceiling produced roughly
 * four entries a minute, forever; 60s produces one, and a user who actually
 * wants to connect gets an instant retry via connectNow().
 */
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 20_000, 40_000, 60_000];

let socket = null;
let pingTimer = null;
let reconnectTimer = null;
let attempt = 0;
let handler = null;
let wantConnection = false;

/** In-flight flow-library requests, keyed by id. See flowLib() below. */
const flowLibPending = new Map();
let flowLibId = 1;

/**
 * Ask the bridge to do something with the flow library on disk.
 *
 * This is the only request that travels extension → bridge and expects an
 * answer. It exists because the panel needs the filesystem and must never have
 * it: the extension holds `debugger` over every tab the user is logged into, so
 * adding file access to that blast radius to save one hop would be a poor
 * trade. The bridge already knows where the repo is and already has a socket
 * open, so the hop is nearly free.
 *
 * A short timeout on purpose: this backs a button a human is watching, and a
 * spinner that never resolves is worse than an error that names the cause.
 */
export function flowLib(op, payload = {}, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!isConnected()) {
      return reject(
        new Error(
          'The bridge is not connected, so the flow library on disk is unreachable. Start the ' +
            'bridge (or your MCP client) and try again — recordings in this browser are unaffected.',
        ),
      );
    }
    const id = flowLibId++;
    const timer = setTimeout(() => {
      flowLibPending.delete(id);
      reject(new Error(`The bridge did not answer the flow-library request "${op}" within ${timeoutMs / 1000}s.`));
    }, timeoutMs);
    flowLibPending.set(id, { resolve, reject, timer });
    if (!send({ type: 'flowlib', id, op, ...payload })) {
      clearTimeout(timer);
      flowLibPending.delete(id);
      reject(new Error('The bridge connection dropped while sending the flow-library request.'));
    }
  });
}

export function onMessage(fn) {
  handler = fn;
}

/** True while a backoff reconnect is already queued. */
export function isReconnectPending() {
  return reconnectTimer !== null;
}

/**
 * User-initiated reconnect: cancel any pending backoff, reset the counter, and
 * try immediately. Called when someone opens the side panel or presses
 * Reconnect — at that moment they are watching, so waiting out a 60s backoff
 * would feel broken.
 */
export function connectNow() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  attempt = 0;
  return connect({ force: true });
}

export async function connect({ force = false } = {}) {
  wantConnection = true;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    if (!force) return;
    teardown();
  }

  const { bridge } = await getState();
  const url = `ws://${bridge.host}:${bridge.port}/agent${bridge.token ? `?token=${encodeURIComponent(bridge.token)}` : ''}`;

  try {
    socket = new WebSocket(url);
  } catch (err) {
    await setState({ bridge: { connected: false, lastError: String(err?.message ?? err) } });
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', async () => {
    attempt = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    await setState({ bridge: { connected: true, lastError: null } });
    startPing();
    send({ type: 'hello', role: 'extension', version: api.runtime.getManifest().version });
  });

  socket.addEventListener('message', async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'pong') return;

    // The bridge reports its own on-disk location on connect. Storing it lets
    // the side panel render an MCP config the user can actually paste, instead
    // of a placeholder path that fails with "Cannot find module".
    if (msg.type === 'welcome') {
      await setState({
        bridge: {
          serverPath: msg.serverPath,
          repoRoot: msg.repoRoot,
          bridgeVersion: msg.version,
        },
        // The project adapter arrives here and nowhere else. The extension has
        // no filesystem, so this handshake is the only path by which product
        // knowledge — above all the Workspace allowlist — can reach it. It is
        // deliberately NOT cached to disk: a stale allowlist outliving the file
        // it came from is the one kind of stale state with a security cost.
        project: msg.project ?? {
          found: false,
          path: null,
          workspaceDomains: [],
          environments: {},
          defaultEnvironment: null,
          flowsDir: null,
          problems: [],
        },
      });
      return;
    }

    // The bridge answering a flow-library request we sent. Correlated by id,
    // exactly as tool calls are in the other direction.
    if (msg.type === 'flowlibResult') {
      const entry = flowLibPending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      flowLibPending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error));
      return;
    }

    if (handler) {
      try {
        await handler(msg);
      } catch (err) {
        console.error('[G9] handler failed', err);
      }
    }
  });

  socket.addEventListener('close', async (event) => {
    stopPing();
    const reason = event.reason || (event.code === 1006 ? 'bridge not reachable' : `closed (${event.code})`);
    await setState({ bridge: { connected: false, lastError: reason } });
    if (wantConnection) scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    // 'close' always follows; recording the error here would double-report.
  });
}

export function disconnect() {
  wantConnection = false;
  teardown();
  setState({ bridge: { connected: false, lastError: null } });
}

function teardown() {
  stopPing();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try {
      socket.close(1000, 'client shutdown');
    } catch {
      /* already closing */
    }
    socket = null;
  }
}

export function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function isConnected() {
  return !!socket && socket.readyState === WebSocket.OPEN;
}

/**
 * The port range the bridge picks from. Must match registry.js in the bridge.
 *
 * Duplicated rather than shared because the two sides ship separately: the
 * extension is reloaded in the browser and the bridge is restarted by the MCP
 * client, and a constant imported across that boundary would be a constant that
 * silently disagrees with itself. Eleven numbers are cheap to keep in step; a
 * cross-process import is not.
 */
export const PORT_RANGE = { start: 8765, end: 8775 };

/**
 * Find every bridge running on this machine.
 *
 * ## Why this exists
 *
 * The MCP client launches the bridge, and every editor window launches its own.
 * They all wanted port 8765, so the second one failed with EADDRINUSE and said
 * so every five seconds — while the extension, which connects to exactly ONE
 * bridge, sat on whichever process won the race. The user saw "port in use" and
 * had no way to find out which bridge their browser was actually talking to.
 *
 * Bridges now take the next free port and publish their identity on `/health`.
 * The extension cannot read `~/.g9/bridges.json` — no filesystem — so it asks
 * each port directly. Eleven parallel requests to localhost, once, when a human
 * opens the dropdown.
 *
 * The `/health` endpoint only sends CORS headers back to extension origins, so
 * this scan works and the same scan from a web page does not.
 */
export async function discoverBridges({ host = '127.0.0.1', timeoutMs = 1200 } = {}) {
  const ports = [];
  for (let p = PORT_RANGE.start; p <= PORT_RANGE.end; p += 1) ports.push(p);

  const found = await Promise.all(
    ports.map(async (port) => {
      try {
        const res = await fetch(`http://${host}:${port}/health`, {
          signal: AbortSignal.timeout(timeoutMs),
          cache: 'no-store',
        });
        if (!res.ok) return null;
        const body = await res.json();
        if (body?.ok !== true) return null;
        return {
          host,
          port,
          version: body.version ?? null,
          pid: body.pid ?? null,
          project: body.project ?? null,
          projectPath: body.projectPath ?? null,
          flowsDir: body.flowsDir ?? null,
          cwd: body.cwd ?? null,
          // "Some other browser is already on this one" is the single most
          // useful fact in the list: connecting to it displaces that session.
          extensionConnected: body.extensionConnected === true,
        };
      } catch {
        return null; // nothing listening, or not one of ours
      }
    }),
  );

  return found.filter(Boolean);
}

function startPing() {
  stopPing();
  // chrome.alarms has a 30s floor, which is too slow to hold the worker open.
  // A plain interval works because the WS traffic itself resets the idle timer.
  pingTimer = setInterval(() => {
    if (!send({ type: 'ping', at: Date.now() })) {
      stopPing();
      if (wantConnection) scheduleReconnect();
    }
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

function scheduleReconnect() {
  // Never stack reconnects. The heartbeat alarm also calls connect(), and
  // without this guard the two sources interleaved and roughly doubled the
  // number of failed attempts (and therefore console errors).
  if (reconnectTimer) return;

  const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  attempt += 1;
  broadcast({ type: 'reconnecting', in: delay, attempt });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (wantConnection) connect();
  }, delay);
}
