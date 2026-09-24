/**
 * The daemon's WebSocket server — hand-written RFC 6455, one socket per client.
 *
 * Moved from `bridge/src/ws-server.js`. What changed in v2 and why:
 *
 * - **Many clients.** v1 held exactly one socket and let a newcomer displace it,
 *   because exactly one extension talked to exactly one bridge. g9d is shared by
 *   every agent's shim, the runner, the desktop app and one extension per
 *   browser, so every accepted socket becomes its own `WsConnection`.
 * - **Native clients have no Origin.** The shim, the runner and the desktop main
 *   process are Node processes; they send no `Origin` header at all. A web page
 *   ALWAYS sends its own `http(s)://` origin and cannot forge another one, so the
 *   rule (DAEMON_PROTOCOL §1) is: refuse any `http://`/`https://` (and any other
 *   scheme we do not recognise) with 403; accept extension origins and a
 *   MISSING Origin. That keeps the v1 guarantee that a malicious page's
 *   `new WebSocket('ws://127.0.0.1:8765')` cannot drive the browser, without a
 *   token. Loopback-only binding stays: never `0.0.0.0`.
 * - **`Origin: null` is a web page too.** A sandboxed iframe (`sandbox="allow-scripts"`)
 *   and a file:// page send the literal `null` — measured, Chrome 153, 2026-09-22: a
 *   sandboxed iframe on a loopback page opened its WebSocket with `Origin: null`
 *   while its parent sent its http origin. It used to be accepted as "native",
 *   which let such a page reach every tool and, as role "ui", the admin ops (the
 *   update feed among them). Native clients send no Origin header at all, so
 *   refusing `null` costs them nothing. The "ui" role additionally requires a
 *   connection with NO Origin (daemon.js #hello): an extension is an engine or an
 *   agent, never the desktop.
 *
 * Kept from v1, deliberately:
 * - A malformed or oversized frame costs the CONNECTION, never the process: the
 *   decoder throws inside a socket 'data' handler, where an uncaught exception
 *   would make the daemon vanish — indistinguishable, from an agent's side, from
 *   a daemon that never started.
 * - App-level `{type:'ping'}` is answered inline so the MV3 service worker's 20 s
 *   keep-alive never waits behind a slow tool call.
 * - `/health`'s CORS header is echoed only for extension origins: a blanket `*`
 *   would let any page probe for a running daemon and read its home path.
 */

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { OP, MAX_FRAME_BYTES, acceptKey, encodeFrame, closeBody, parseCloseBody, FrameReader } from '../lib/ws-codec.mjs';

const EXTENSION_ORIGIN = /^(chrome|edge|moz)-extension:\/\/[a-z0-9._-]+\/?$/i;
const GENERIC_EXTENSION_ORIGIN = /^extension:\/\/[a-z0-9._-]+\/?$/i;

/** The WebSocket paths: `/g9` for v2, `/agent` so a v1 extension reaches us and gets a clear error. */
export const WS_PATHS = ['/g9', '/agent'];

/**
 * The origin rule (DAEMON_PROTOCOL §1), as a pure function for the tests.
 * Returns { ok, kind } — kind is 'native' | 'extension' | 'web' | 'other'.
 */
export function classifyOrigin(origin) {
  const value = origin == null ? '' : String(origin).trim();
  if (value === '') return { ok: true, kind: 'native' };
  if (value.toLowerCase() === 'null') return { ok: false, kind: 'opaque' };
  if (EXTENSION_ORIGIN.test(value) || GENERIC_EXTENSION_ORIGIN.test(value)) return { ok: true, kind: 'extension' };
  if (/^https?:\/\//i.test(value)) return { ok: false, kind: 'web' };
  return { ok: false, kind: 'other' };
}

export function isExtensionOrigin(origin) {
  return classifyOrigin(origin).kind === 'extension';
}

export class WsConnection extends EventEmitter {
  constructor(socket, { id, origin, path, maxBytes }) {
    super();
    this.socket = socket;
    this.id = id;
    this.origin = origin;
    this.path = path;
    this.closed = false;
    this.closeInfo = null;
    this.remote = `${socket.remoteAddress}:${socket.remotePort}`;
    this.reader = new FrameReader({
      maxBytes,
      onMessage: (opcode, payload) => this.#deliver(opcode, payload),
      onControl: (opcode, payload) => {
        if (opcode === OP.PING) {
          this.#write(OP.PONG, payload);
        } else if (opcode === OP.CLOSE) {
          const info = parseCloseBody(payload);
          this.#write(OP.CLOSE, closeBody(info.code === 1005 ? 1000 : info.code));
          this.#finish({ code: info.code, reason: info.reason || 'client closed' });
          return false;
        }
        return true;
      },
    });
  }

  get open() {
    return !this.closed && !this.socket.destroyed;
  }

  /** Bytes waiting in the socket buffer. Evidence streams drop frames above a threshold. */
  get bufferedAmount() {
    return this.socket.writableLength ?? 0;
  }

  send(obj) {
    if (!this.open) return false;
    let text;
    try {
      text = JSON.stringify(obj);
    } catch {
      return false;
    }
    return this.#write(OP.TEXT, Buffer.from(text, 'utf8'));
  }

  /**
   * Send unless the peer is already this far behind. Used for screencast frames
   * and pointer samples: a watcher on a slow link should see a lower frame rate,
   * never make the daemon buffer gigabytes on its behalf.
   */
  sendDroppable(obj, maxBuffered = 8 * 1024 * 1024) {
    if (this.bufferedAmount > maxBuffered) return false;
    return this.send(obj);
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    this.#write(OP.CLOSE, closeBody(code, reason));
    this.#finish({ code, reason });
  }

  ingest(chunk) {
    try {
      this.reader.push(chunk);
    } catch (err) {
      this.emit('protocolError', { reason: String(err?.message ?? err) });
      this.close(1009, 'protocol error');
    }
  }

  #deliver(opcode, payload) {
    if (opcode !== OP.TEXT) return;
    let msg;
    try {
      msg = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    // Keep-alive answered here, below every queue: the MV3 worker must hear its
    // pong even while the daemon is busy running a long tool call for it.
    if (msg.type === 'ping') {
      this.send({ type: 'pong', at: msg.at });
      return;
    }
    this.emit('message', msg);
  }

  #write(opcode, payload) {
    try {
      this.socket.write(encodeFrame(opcode, payload));
      return true;
    } catch {
      return false;
    }
  }

  finishFromSocket(info) {
    this.#finish(info);
  }

  #finish(info) {
    if (this.closed) return;
    this.closed = true;
    this.closeInfo = info;
    try { this.socket.end(); } catch { /* already gone */ }
    const timer = setTimeout(() => { try { this.socket.destroy(); } catch { /* gone */ } }, 250);
    timer.unref?.();
    this.emit('close', info);
  }
}

export class WsServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.host]   always 127.0.0.1 in production; never 0.0.0.0
   * @param {number} opts.port
   * @param {() => object} [opts.health]  body of GET /health (merged over {ok:true})
   */
  constructor({ host = '127.0.0.1', port, health = () => ({}), maxBytes = MAX_FRAME_BYTES } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.health = health;
    this.maxBytes = maxBytes;
    this.connections = new Set();
    this.nextId = 1;
    this.server = http.createServer((req, res) => this.#handleHttp(req, res));
    this.server.on('upgrade', (req, socket, head) => this.#handleUpgrade(req, socket, head));
    // A client that opens a TCP connection and says nothing must not hold a
    // socket forever; upgraded WS sockets are detached from these timers.
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;
  }

  listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.removeListener('error', onError);
        this.port = this.server.address().port;
        resolve({ host: this.host, port: this.port });
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
  }

  close() {
    for (const conn of this.connections) conn.close(1001, 'daemon shutting down');
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      // Keep-alive HTTP sockets would otherwise hold close() open.
      this.server.closeAllConnections?.();
    });
  }

  #handleHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      const origin = req.headers.origin ?? '';
      const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
      if (isExtensionOrigin(origin)) {
        headers['access-control-allow-origin'] = origin;
        headers.vary = 'Origin';
      }
      let body;
      try {
        body = { ok: true, ...this.health() };
      } catch (err) {
        body = { ok: false, error: String(err?.message ?? err) };
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('g9d speaks WebSocket on /g9. GET /health for status.\n');
  }

  #handleUpgrade(req, socket, head) {
    const origin = req.headers.origin ?? '';
    const key = req.headers['sec-websocket-key'];
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

    const reject = (code, reason) => {
      try {
        socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } catch { /* the peer may already be gone */ }
      socket.destroy();
      this.emit('rejected', { origin, path, code, reason });
    };

    if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') return reject(400, 'Bad Request');
    if (!WS_PATHS.includes(path)) return reject(404, 'Not Found');

    // THE check. A page in the user's own browser is not local, whatever
    // address it dials; see the header comment.
    const verdict = classifyOrigin(origin);
    if (!verdict.ok) return reject(403, 'Forbidden Origin');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    socket.setKeepAlive?.(true, 30_000);

    const conn = new WsConnection(socket, {
      id: this.nextId++,
      origin: origin || null,
      path,
      maxBytes: this.maxBytes,
    });
    this.connections.add(conn);

    socket.on('data', (chunk) => conn.ingest(chunk));
    socket.on('error', () => conn.finishFromSocket({ code: 1006, reason: 'socket error' }));
    socket.on('close', () => conn.finishFromSocket({ code: 1006, reason: 'connection lost' }));
    conn.on('protocolError', (info) => this.emit('protocolError', { ...info, conn }));
    conn.on('close', () => this.connections.delete(conn));

    this.emit('connection', conn, { origin: origin || null, path, originKind: verdict.kind });
    if (head?.length) conn.ingest(head);
  }
}
