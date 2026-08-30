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
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 15_000];

let socket = null;
let pingTimer = null;
let attempt = 0;
let handler = null;
let wantConnection = false;

export function onMessage(fn) {
  handler = fn;
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
      });
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
  const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  attempt += 1;
  broadcast({ type: 'reconnecting', in: delay, attempt });
  setTimeout(() => {
    if (wantConnection) connect();
  }, delay);
}
