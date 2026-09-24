/**
 * WebSocket link from Engine 1 (this extension) to the local G9 daemon, g9d.
 *
 * Protocol: docs/DAEMON_PROTOCOL.md. Contract: docs/ARCHITECTURE_V2.md §14.
 * One daemon per machine, one port (8765 unless G9_PORT), path `/g9`. v1's port
 * range and bridge discovery are gone: with a single daemon there is nothing
 * to choose between, and a dropdown of one is noise.
 *
 * Two MV3 hazards are handled here, unchanged from v1:
 *
 *  1. The service worker is killed after ~30s idle. An open WebSocket counts as
 *     activity ONLY while messages flow, so we ping every 20s. Chrome 116+
 *     keeps the worker alive for the duration of an active WS connection that
 *     is actually exchanging data.
 *  2. The worker can still be torn down (browser restart, crash, update). On
 *     restart we reconnect with backoff and rebuild state from storage rather
 *     than assuming anything survived in memory.
 *
 * And four v2 ones:
 *
 *  3. A v1 bridge may still hold the port during migration. It accepts an
 *     upgrade on ANY path and displaces whichever client it had — so blindly
 *     opening `/g9` against it would knock a v1 browser off its own session.
 *     `/health` tells the two apart first (see preflight()).
 *  4. "Connected" means the handshake completed, not that a TCP socket opened.
 *     A server that accepts the upgrade and never welcomes us is not a daemon.
 *  5. A forced reconnect closes the old socket asynchronously. Its late `close`
 *     event used to flip the new, healthy connection to "offline" and queue a
 *     stray reconnect. Every handler now ignores events from a socket that is
 *     no longer the current one.
 *  6. A daemon that refuses us (`welcome.problem`, or close code 4001) is not a
 *     network blip. Retrying just repeats the refusal every few seconds, so we
 *     stop until a person asks again (connectNow()).
 *
 * And one identity rule (decision D-c): every hello says WHICH extension this
 * is — `instanceId`, random, generated once and kept in storage.local — plus
 * `loadId` (kept in storage.session: the same across worker restarts, new
 * after an extension reload or a browser restart) and the open tabs. The
 * daemon then gives a reconnecting extension its engine id, tab handles,
 * claims and session names back instead of treating it as a new browser; MV3
 * restarts the worker whenever it likes, and the desktop reloads the extension
 * after every update, so without this every agent lost its tabs mid-task.
 */

import { getState, setState, logActivity } from './state.js';

const api = () => globalThis.browser ?? globalThis.chrome;

export const DEFAULT_PORT = 8765;

const PING_INTERVAL_MS = 20_000;
/** Long enough for a daemon busy starting an engine; short enough that a foreign server is named quickly. */
const WELCOME_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 3_000;

/**
 * Per-op default timeouts for request(), used when the caller names none.
 *
 * A handoff relays the tab's export back through this very socket, then may
 * LAUNCH a browser and load the page there: a cold first start runs past 15s.
 * Timing out first would report "could not send the tab" for a handoff the
 * daemon then completes — the tab lands in the background while the panel
 * says it failed. The daemon allows a handoff 3 minutes (DAEMON_PROTOCOL §3);
 * this waits a little longer, so a stuck one still ends with the daemon's own
 * reason rather than ours.
 */
const REQUEST_TIMEOUT_MS = { handoff: 185_000 };

// WebSocket readyState values. Numeric on purpose: a class constant read at
// call time is one more thing a test double has to imitate exactly.
const CONNECTING = 0;
const OPEN = 1;

/**
 * Reconnect backoff, climbing to a one-minute ceiling.
 *
 * Every failed attempt makes the BROWSER log a connection error into the
 * extension's error console. That log happens below our JavaScript — we cannot
 * catch or suppress it. So the only way to keep the console readable when the
 * daemon is simply not running is to attempt less often. A 15s ceiling produced
 * roughly four entries a minute, forever; 60s produces one, and a user who
 * actually wants to connect gets an instant retry via connectNow().
 */
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 20_000, 40_000, 60_000];

let socket = null;
/** True once the daemon's welcome arrived on the current socket. */
let welcomed = false;
let pingTimer = null;
let reconnectTimer = null;
let welcomeTimer = null;
let attempt = 0;
let handler = null;
let wantConnection = false;
/** The daemon's refusal, when it refused us. Reconnecting waits for connectNow(). */
let blocked = null;
/** Why WE closed the current socket, so the close handler reports that and not "closed (1000)". */
let closingReason = null;
/** Bumped by every forced connect and by disconnect(); a stale attempt checks it after each await. */
let generation = 0;
let inflight = null;

/**
 * Requests this side sent and is waiting on, keyed by id.
 *
 * One id space for both kinds (`request` → `response`, and v1's `flowlib` →
 * `flowlibResult`), so the two can never answer each other's question. The id
 * is ALWAYS this side's own number — never a flow id (F5, see flowLib()).
 */
const pending = new Map();
let nextId = 1;

// ------------------------------------------------------------------ identity (D-c)

const INSTANCE_KEY = 'g9:instanceId';
const LOAD_KEY = 'g9:loadId';
const ID_SHAPE = /^[A-Za-z0-9._-]{8,128}$/;
let identityPromise = null;

function randomId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    /* fall through */
  }
  const bytes = new Uint8Array(16);
  try {
    globalThis.crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Read `key` from a storage area, or create and store a fresh id. Never rejects. */
async function storedId(area, key) {
  try {
    const got = await area?.get?.(key);
    const value = got?.[key];
    if (typeof value === 'string' && ID_SHAPE.test(value)) return value;
  } catch {
    /* unreadable: a fresh id below */
  }
  const fresh = randomId();
  try {
    await area?.set?.({ [key]: fresh });
  } catch {
    /* unwritable: this worker still uses it; the next one makes another */
  }
  return fresh;
}

/**
 * `{ instanceId, loadId }` for the hello. Memoised per worker, so two connect
 * attempts can never race each other into two different ids.
 */
function identity() {
  identityPromise ??= (async () => ({
    instanceId: await storedId(api()?.storage?.local, INSTANCE_KEY),
    loadId: await storedId(api()?.storage?.session, LOAD_KEY),
  }))();
  return identityPromise;
}

/** The open tabs as `{ tabId, url }` — what the daemon checks a reconnect's handles against. */
async function openTabs() {
  try {
    const tabs = await api()?.tabs?.query?.({});
    if (!Array.isArray(tabs)) return null;
    return tabs.filter((t) => Number.isInteger(t?.id)).map((t) => ({ tabId: t.id, url: t.url || t.pendingUrl || '' }));
  } catch {
    return null;
  }
}

/** Filled in just before each socket opens; sent in its hello. */
let helloIdentity = { instanceId: null, loadId: null, tabs: null };

export function onMessage(fn) {
  handler = fn;
}

/** True while a backoff reconnect is already queued. */
export function isReconnectPending() {
  return reconnectTimer !== null;
}

/** Connected = the socket is open AND the daemon welcomed us. */
export function isConnected() {
  return !!socket && socket.readyState === OPEN && welcomed;
}

export function send(payload) {
  if (!socket || socket.readyState !== OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * Something that matters NOW could not be sent (no socket) — the panel's Stop: try to connect at
 * once instead of waiting out a backoff of up to 60 s, so the welcome's reconcileHalt tells the
 * daemon within a second or so (extension review, 2026-09-22: 48.6 s after an outage; 0.1 s with
 * this). Unlike connectNow() it never lifts a refusal or a supersede (`blocked`: another live
 * connection of this extension, or a daemon that refused it), never overrides a disconnect(), and
 * leaves an attempt already in progress alone — its welcome reconciles the halt.
 * → true when a connection is (being) made that will carry it.
 */
export function hurry() {
  if (!wantConnection || blocked) return false;
  if (isConnected() || inflight || (socket && socket.readyState === CONNECTING)) return true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  attempt = 0;
  connect();
  return true;
}

/**
 * User-initiated reconnect: cancel any pending backoff, reset the counter,
 * lift a refusal, and try immediately. Called when someone opens the side panel
 * or presses Reconnect — at that moment they are watching, so waiting out a 60s
 * backoff would feel broken.
 */
export async function connectNow() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  attempt = 0;
  blocked = null;
  // The refusal is persisted (see onWelcome), so a revived worker does not
  // hammer a daemon that already said no. A person asking again clears it.
  // A storage hiccup here must not cost them the attempt: a forced connect
  // ignores a persisted refusal anyway.
  try {
    const { bridge } = await getState();
    if (bridge?.problem) await setState({ bridge: { problem: null } });
  } catch (err) {
    console.warn('[G9] could not clear the stored refusal', err);
  }
  return connect({ force: true });
}

export async function connect({ force = false } = {}) {
  wantConnection = true;
  if (force) {
    // A person asked. Also drop a refusal that a background connect() re-read
    // from storage while connectNow() was still clearing it: left set, it
    // would make scheduleReconnect() refuse to retry after this attempt fails.
    blocked = null;
    teardown();
  } else {
    if (blocked) return;
    if (inflight) return inflight;
    if (socket && (socket.readyState === OPEN || socket.readyState === CONNECTING)) return;
  }
  const gen = ++generation;
  const run = open(gen, force).finally(() => {
    if (inflight === run) inflight = null;
  });
  inflight = run;
  return run;
}

export function disconnect() {
  wantConnection = false;
  generation += 1;
  // The attempt in flight bails out at its next await (stale generation); it
  // must not also be handed to the next connect() as "already connecting".
  inflight = null;
  teardown();
  return setState({ bridge: { connected: false, lastError: null } }).catch(() => {});
}

/**
 * Ask the daemon for something and wait for its answer.
 *
 * `{type:'request', id, op, ...payload}` → `{type:'response', id, ok, result|error}`.
 * Used for `handoff` (the panel's "Send to background") and `info` (daemon
 * version, agents, engines for the panel). A short default timeout on purpose:
 * these back buttons a human is watching, and a spinner that never resolves is
 * worse than an error that names the cause. `handoff` is the one exception
 * (REQUEST_TIMEOUT_MS): its answer waits on a browser launch.
 */
export function request(op, payload = {}, { timeoutMs = defaultTimeout(op) } = {}) {
  return call(
    { ...payload, type: 'request', op },
    {
      timeoutMs,
      label: `the request "${op}"`,
      offline:
        `The G9 daemon is not connected, so "${op}" cannot run. Start your AI client (it starts the ` +
        'daemon on demand) or G9 Desktop, then try again.',
    },
  );
}

/**
 * Ask the daemon to do something with the flow library on disk.
 *
 * `{type:'flowlib', id, op, flowId?, …}` → `{type:'flowlibResult', id, ok, result|error}`.
 * It exists because the panel needs the filesystem and must never have it: the
 * extension holds `debugger` over every tab the user is logged into, so adding
 * file access to that blast radius to save one hop would be a poor trade. The
 * daemon already knows where the repo is and already has a socket open, so the
 * hop is nearly free.
 *
 * F5: the flow a request is about travels as `flowId`; `id` is only this
 * side's correlation number. v1's wire shape used `id` for both, and it bit
 * twice: v1 sent the flow id but looked the answer up by number (every read
 * sat out its timeout), and v2 at first numbered it (the daemon was asked for
 * "flow 3", so every Pull from repo failed flow by flow). The stop-gap — the
 * flow id as the correlation key, one request per flow at a time — is gone:
 * the daemon reads `flowId` (falling back to `id` only for a v1-shaped message
 * without one). Callers may pass the flow as `flowId` or, as before, `id`.
 */
export function flowLib(op, payload = {}, { timeoutMs = 15_000 } = {}) {
  const { id: legacyFlowId, flowId: given, type: _type, op: _op, ...rest } = payload ?? {};
  const flowId = given ?? legacyFlowId ?? null;
  return call(
    { ...rest, ...(flowId != null ? { flowId } : {}), type: 'flowlib', op },
    {
      timeoutMs,
      label: `the flow-library request "${op}"${flowId != null ? ` for "${flowId}"` : ''}`,
      offline:
        'The G9 daemon is not connected, so the flow library on disk is unreachable. Start your AI ' +
        'client (it starts the daemon) or G9 Desktop and try again — recordings in this browser are unaffected.',
    },
  );
}

function call(frame, { timeoutMs, label, offline }) {
  return new Promise((resolve, reject) => {
    if (!isConnected()) return reject(new Error(offline));
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The daemon did not answer ${label} within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    if (!send({ ...frame, id })) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(`The daemon connection dropped while sending ${label}.`));
    }
  });
}

function settle(msg) {
  const entry = pending.get(msg.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(msg.id);
  if (msg.ok) entry.resolve(msg.result);
  else entry.reject(new Error(msg.error ?? 'The daemon reported a failure without a message.'));
}

/**
 * Fail every waiting request NOW rather than at its timeout. The answer can no
 * longer arrive — it would come on a socket that is gone — and a person
 * watching "Send to background" deserves the reason, not fifteen seconds of it.
 */
function rejectAll(reason) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(new Error(reason));
  }
}

// ------------------------------------------------------------------ connecting

/**
 * One connection attempt. Never rejects: its callers are a backoff timer, the
 * heartbeat alarm and panel commands, none of which can do anything useful with
 * an exception — and a rejection inside the backoff timer used to end the
 * retry chain outright, leaving the link dead until the next alarm.
 */
async function open(gen, force) {
  try {
    await attemptOpen(gen, force);
  } catch (err) {
    if (gen !== generation || !wantConnection) return;
    console.error('[G9] connection attempt failed', err);
    await setState({ bridge: { connected: false, lastError: `connection attempt failed: ${err?.message ?? err}` } }).catch(
      () => {},
    );
    scheduleReconnect();
  }
}

async function attemptOpen(gen, force) {
  const { bridge = {} } = await getState();
  if (gen !== generation || !wantConnection) return;
  if (!force && bridge.problem) {
    blocked = bridge.problem;
    return;
  }

  const host = String(bridge.host || '127.0.0.1').trim();
  let port = validPort(bridge.port) ? Number(bridge.port) : DEFAULT_PORT;
  let address = `${hostForUrl(host)}:${port}`;

  let health = await preflight(address);
  if (gen !== generation || !wantConnection) return;
  // A port v1 picked by itself (8766-8775, the next free one) kept by the v1→v2 migration
  // (state.js migrateLegacySettings flags it): g9d is not there. Switch — once — to the default
  // port, and only when what answers there says it IS g9d. Never for a port nobody flagged: an
  // isolated test on a private port must never drift onto the owner's 8765 (extension review,
  // 2026-09-22).
  if ((health.kind === 'unreachable' || health.kind === 'v1') && bridge.v1AutoPort === true && port !== DEFAULT_PORT && isLoopback(host)) {
    const fallback = `${hostForUrl(host)}:${DEFAULT_PORT}`;
    const there = await preflight(fallback);
    if (gen !== generation || !wantConnection) return;
    if (there.kind === 'daemon') {
      const from = port;
      await setState({ bridge: { port: DEFAULT_PORT, v1AutoPort: false } });
      await logActivity({
        kind: 'system', ok: true,
        detail: `Moved the daemon address from ${from} (a port the v1 bridge chose by itself) to ${DEFAULT_PORT}, where the G9 daemon is running.`,
      }).catch(() => {});
      port = DEFAULT_PORT;
      address = fallback;
      health = there;
    }
  }
  if (health.kind === 'unreachable') {
    await setState({ bridge: { connected: false, lastError: `daemon not reachable on ${address}` } });
    scheduleReconnect();
    return;
  }
  if (health.kind === 'v1') {
    // No socket, so nobody is displaced. Keep checking on the normal backoff:
    // the bridge goes away when the editor that started it closes, and the
    // next attempt then finds the daemon without anyone pressing anything.
    await setState({ bridge: { connected: false, lastError: v1BridgeMessage(address, health) } });
    scheduleReconnect();
    return;
  }

  // Who this extension is, for the hello (D-c). Read before the socket exists,
  // because the hello goes out synchronously the moment it opens.
  const who = await identity();
  const tabs = await openTabs();
  if (gen !== generation || !wantConnection) return;
  helloIdentity = { ...who, tabs };

  const WS = globalThis.WebSocket;
  let ws;
  try {
    ws = new WS(`ws://${address}/g9`);
  } catch (err) {
    await setState({ bridge: { connected: false, lastError: String(err?.message ?? err) } });
    scheduleReconnect();
    return;
  }
  socket = ws;
  welcomed = false;
  closingReason = null;

  ws.addEventListener('open', () => onOpen(ws, address));
  ws.addEventListener('message', (event) => {
    onFrame(ws, event).catch((err) => console.error('[G9] daemon message failed', err));
  });
  ws.addEventListener('close', (event) => {
    onClose(ws, event).catch((err) => console.error('[G9] close handling failed', err));
  });
  ws.addEventListener('error', () => {
    // 'close' always follows; recording the error here would double-report.
  });
}

/**
 * Who is on the port, before we open a socket to it.
 *
 * The v1 bridge answers `/health` with `{ ok:true, version:'1.x', pid, … }` and
 * no `name`; g9d answers `{ ok:true, name:'g9d', version:'2.x', … }`. Only a
 * POSITIVE identification of a v1 bridge stops us. Anything we cannot read —
 * a slow daemon, a test double without `/health` — proceeds to the socket, and
 * the welcome decides. A refused connection skips the socket attempt: it would
 * fail the same way and log a second console error for nothing.
 *
 * The extension's host permission covers 127.0.0.1, so this needs no CORS; the
 * daemon's CORS header for extension origins is for other callers.
 */
async function preflight(address) {
  if (typeof globalThis.fetch !== 'function') return { kind: 'unknown' };
  let response;
  try {
    const init = { cache: 'no-store' };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
    response = await globalThis.fetch(`http://${address}/health`, init);
  } catch (err) {
    // A timeout means something IS listening, just slowly: let the socket try.
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { kind: 'unknown' };
    return { kind: 'unreachable' };
  }
  if (!response?.ok) return { kind: 'unknown' };
  let body;
  try {
    body = await response.json();
  } catch {
    return { kind: 'unknown' };
  }
  if (body?.name === 'g9d') return { kind: 'daemon', version: body.version ?? null };
  if (body?.ok === true && majorOf(body.version) === 1) {
    return { kind: 'v1', version: body.version, pid: body.pid ?? null, project: body.project ?? null };
  }
  return { kind: 'unknown' };
}

function v1BridgeMessage(address, info) {
  return (
    `${address} is held by a G9 v1 bridge (v${info.version}${info.pid ? `, pid ${info.pid}` : ''}), not the v2 ` +
    'daemon. Close the editor or AI client that started it, then press Reconnect — the v2 daemon starts ' +
    'on demand. G9 did not connect, so that session was left alone.'
  );
}

function onOpen(ws, address) {
  if (ws !== socket) return;
  startPing();
  send({
    type: 'hello',
    role: 'engine',
    version: manifestVersion(),
    client: {
      name: 'extension',
      browser: globalThis.navigator?.userAgent ?? '',
      extensionId: api()?.runtime?.id ?? null,
      ...(helloIdentity.instanceId ? { instanceId: helloIdentity.instanceId } : {}),
      ...(helloIdentity.loadId ? { loadId: helloIdentity.loadId } : {}),
      ...(Array.isArray(helloIdentity.tabs) ? { tabs: helloIdentity.tabs } : {}),
    },
  });
  clearTimeout(welcomeTimer);
  welcomeTimer = setTimeout(() => {
    welcomeTimer = null;
    if (ws !== socket || welcomed) return;
    closingReason =
      `The server on ${address} accepted the connection but never answered the handshake — it is not ` +
      'a G9 v2 daemon.';
    try {
      ws.close(1000, 'no welcome');
    } catch {
      /* already closing */
    }
  }, WELCOME_TIMEOUT_MS);
}

async function onFrame(ws, event) {
  if (ws !== socket) return;
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'pong':
      return;
    case 'ping':
      // Either side may ping (protocol §1). Answering is transport business;
      // the service worker never needs to see it.
      send({ type: 'pong', at: msg.at });
      return;
    case 'welcome':
      await onWelcome(ws, msg);
      return;
    case 'response':
    case 'flowlibResult':
      settle(msg);
      return;
    default:
      await deliver(msg);
  }
}

async function deliver(msg) {
  if (!handler) return;
  try {
    await handler(msg);
  } catch (err) {
    console.error('[G9] handler failed', err);
  }
}

/**
 * The daemon accepted us — or told us why not.
 *
 * The project adapter arrives here and nowhere else: the extension has no
 * filesystem, so this handshake is the only path by which the repo's
 * environments and flows directory reach the panel. The engine id is what the
 * daemon calls this browser in its agent and engine lists.
 */
async function onWelcome(ws, msg) {
  clearTimeout(welcomeTimer);
  welcomeTimer = null;

  const problem = msg.problem || versionProblem(msg.version);
  if (problem) {
    blocked = problem;
    closingReason = problem;
    await setState({
      bridge: { connected: false, lastError: problem, problem, daemonVersion: msg.version ?? null },
    });
    try {
      ws.close(1000, 'refused');
    } catch {
      /* already closing */
    }
    return;
  }

  welcomed = true;
  attempt = 0;
  blocked = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  // The stored port works: a v1-chosen port that g9d really runs on is the person's, and stays.
  const kept = await getState().then((s) => s.bridge?.v1AutoPort === true, () => false);
  await setState({
    bridge: {
      ...(kept ? { v1AutoPort: false } : {}),
      connected: true,
      lastError: null,
      problem: null,
      daemonVersion: msg.version ?? null,
      daemonPid: msg.daemonPid ?? null,
      engineId: msg.id ?? null,
      connectedAt: Date.now(),
      ...(msg.repoRoot ? { repoRoot: msg.repoRoot } : {}),
    },
    project: normaliseProject(msg.project),
  });

  await reconcileHalt(msg);
}

/**
 * Stop is Stop, even when it was pressed while the socket was down.
 *
 * If this browser is halted and the daemon is not, the panel's Stop happened
 * while we were disconnected (or the daemon restarted since), so its report
 * never arrived or was forgotten. Say it again, or the launched engines keep
 * running on a Stop the person believes is in force.
 *
 * Only in that direction. A welcome that says "not halted" never clears a Stop
 * pressed here — only a person resumes. And a daemon that IS halted sends its
 * own `{type:'halt'}` right after the welcome (protocol §5), which the service
 * worker mirrors; echoing it from here as well would just race that message.
 */
async function reconcileHalt(msg) {
  if (msg.halted?.global === true) return;
  let halted = false;
  try {
    halted = !!(await getState()).halted;
  } catch {
    return;
  }
  if (halted) send({ type: 'event', event: 'halt', data: { halted: true, by: 'panel' } });
}

async function onClose(ws, event) {
  if (ws !== socket) return; // a superseded socket closing late — see hazard 5
  socket = null;
  welcomed = false;
  stopPing();
  clearTimeout(welcomeTimer);
  welcomeTimer = null;

  let reason =
    closingReason ?? (event?.reason || (event?.code === 1006 ? 'daemon not reachable' : `closed (${event?.code})`));
  closingReason = null;
  // 4001 is the daemon's "wrong version" close (protocol §2). Same meaning as a
  // welcome problem, whether or not the welcome made it here first.
  let refusedNow = false;
  if (event?.code === 4001 && !blocked) {
    blocked = event.reason || 'The daemon refused this extension (code 4001). Reload the v2 extension.';
    reason = blocked;
    refusedNow = true;
  }
  // Superseded (D-c): the daemon gave this extension's identity to a newer connection with the same
  // instanceId — normally this worker's own replacement, which means this one is on its way out; or
  // another browser running a COPY of this profile (same storage.local, same instanceId). Reconnecting
  // would take the identity back, and the two would displace each other in turn, as v1's bridge
  // clients did. So wait for a person — but only in memory: a persisted refusal written by a dying
  // worker would block its healthy replacement.
  if (!blocked && /^superseded\b/i.test(event?.reason ?? '')) {
    blocked =
      'Another connection of this same extension replaced this one (a newer instance of it, or another browser ' +
      'using a copy of this profile). Press Reconnect to take the connection back.';
    reason = blocked;
  }
  rejectAll(`The daemon connection closed before it answered (${reason}).`);

  if (blocked) {
    await setState({ bridge: { connected: false, lastError: blocked, ...(refusedNow ? { problem: blocked } : {}) } });
    return;
  }
  try {
    await setState({ bridge: { connected: false, lastError: reason } });
  } finally {
    // Retry even if the status write failed: a stale panel is recoverable, a
    // link nobody reconnects is not.
    if (wantConnection) scheduleReconnect();
  }
}

function teardown() {
  stopPing();
  clearTimeout(welcomeTimer);
  welcomeTimer = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const old = socket;
  socket = null;
  welcomed = false;
  closingReason = null;
  if (old) {
    try {
      old.close(1000, 'client shutdown');
    } catch {
      /* already closing */
    }
    rejectAll('The daemon connection was reset before it answered.');
  }
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
  if (reconnectTimer || blocked || !wantConnection) return;

  const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  attempt += 1;
  broadcast({ type: 'reconnecting', in: delay, attempt, at: Date.now() });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (wantConnection) connect();
  }, delay);
}

// --------------------------------------------------------------------- helpers

/**
 * Tell the side panel, if it is open. A failed sendMessage is normal (no panel)
 * and must not surface as an unhandled rejection. Local rather than imported so
 * the transport depends on nothing from state.js but getState/setState.
 */
function broadcast(message) {
  try {
    const p = api()?.runtime?.sendMessage?.({ __g9: true, ...message });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* no receiver */
  }
}

function manifestVersion() {
  try {
    return api()?.runtime?.getManifest?.().version ?? null;
  } catch {
    return null;
  }
}

function defaultTimeout(op) {
  return Object.hasOwn(REQUEST_TIMEOUT_MS, op) ? REQUEST_TIMEOUT_MS[op] : 15_000;
}

function majorOf(version) {
  const m = /^v?(\d+)\./.exec(String(version ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * A v1 bridge that got as far as a welcome (one too old to answer `/health`)
 * has ALREADY displaced its previous client by the time we know. Closing at
 * once and not retrying keeps that to a single bump instead of a tug of war
 * with the v1 browser, which reconnects too.
 */
function versionProblem(version) {
  const major = majorOf(version);
  if (major == null || major >= 2) return null;
  return (
    `This is a G9 v1 bridge (v${version}), not the v2 daemon. Close the editor or AI client that started ` +
    'it, then press Reconnect — the v2 daemon starts on demand.'
  );
}

function normaliseProject(project) {
  return {
    found: false,
    path: null,
    environments: {},
    defaultEnvironment: null,
    flowsDir: null,
    problems: [],
    ...(project && typeof project === 'object' ? project : {}),
  };
}

function isLoopback(host) {
  return /^(127\.0\.0\.1|localhost|\[?::1\]?)$/i.test(String(host ?? '').trim());
}

function validPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n < 65536;
}

/** `::1` has to be bracketed in a URL; a hostname or IPv4 address must not be. */
function hostForUrl(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
