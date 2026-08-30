/**
 * Minimal RFC 6455 WebSocket server — no dependencies.
 *
 * Written by hand rather than pulled from npm so that `git clone && node` works
 * on a locked-down machine with no registry access, and so there is no supply
 * chain under a tool that holds full control of your logged-in browser.
 *
 * Security model (this matters — read before changing):
 *   - Binds to 127.0.0.1 only. Never expose this on 0.0.0.0.
 *   - Validates the Origin header. A browser page attempting
 *     `new WebSocket('ws://127.0.0.1:8765')` sends its own https origin, which
 *     is rejected. Only chrome-extension:// / extension:// origins are allowed.
 *     This is the primary defence against a malicious page reaching the bridge.
 *   - Single client. A second connection displaces the first rather than
 *     silently sharing the session.
 *   - Optional shared token, for defence in depth.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const ALLOWED_ORIGIN = /^(chrome|edge|moz)-extension:\/\/[a-z0-9-]+$/i;

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export class WsServer extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 8765, token = '', allowAnyOrigin = false } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.token = token;
    this.allowAnyOrigin = allowAnyOrigin;
    this.client = null;
    this.server = http.createServer((req, res) => this.#handleHttp(req, res));
    this.server.on('upgrade', (req, socket, head) => this.#handleUpgrade(req, socket, head));
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject);
        resolve({ host: this.host, port: this.port });
      });
    });
  }

  close() {
    this.#dropClient(1001, 'server shutting down');
    return new Promise((resolve) => this.server.close(resolve));
  }

  get connected() {
    return !!this.client && !this.client.destroyed;
  }

  /** Send a JSON payload to the extension. Returns false when nobody is home. */
  send(obj) {
    if (!this.connected) return false;
    try {
      this.client.write(encodeFrame(OP.TEXT, Buffer.from(JSON.stringify(obj), 'utf8')));
      return true;
    } catch {
      return false;
    }
  }

  /** A tiny health endpoint, handy for `curl` when debugging setup. */
  #handleHttp(req, res) {
    if (req.url?.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, extensionConnected: this.connected }));
      return;
    }
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('This endpoint speaks WebSocket only.\n');
  }

  #handleUpgrade(req, socket, head) {
    const origin = req.headers.origin ?? '';
    const key = req.headers['sec-websocket-key'];

    const reject = (code, reason) => {
      socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      this.emit('rejected', { origin, reason });
    };

    if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      return reject(400, 'Bad Request');
    }

    if (!this.allowAnyOrigin && !ALLOWED_ORIGIN.test(origin)) {
      return reject(403, 'Forbidden Origin');
    }

    if (this.token) {
      const supplied = new URL(req.url, 'http://localhost').searchParams.get('token') ?? '';
      const a = Buffer.from(supplied);
      const b = Buffer.from(this.token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return reject(401, 'Unauthorized');
      }
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    // One client at a time — a second extension instance replaces the first.
    if (this.client) this.#dropClient(1000, 'replaced by a newer connection');

    this.client = socket;
    socket.setNoDelay(true);
    this.#pump(socket, head);
    this.emit('connect', { origin });
  }

  #pump(socket, head) {
    let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    const fragments = [];
    let fragmentOp = null;

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      for (;;) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);

        switch (frame.opcode) {
          case OP.PING:
            socket.write(encodeFrame(OP.PONG, frame.payload));
            break;

          case OP.PONG:
            break;

          case OP.CLOSE:
            this.#dropClient(1000, 'client closed');
            return;

          case OP.CONT:
            fragments.push(frame.payload);
            if (frame.fin) {
              this.#deliver(fragmentOp, Buffer.concat(fragments));
              fragments.length = 0;
              fragmentOp = null;
            }
            break;

          default:
            if (frame.fin) {
              this.#deliver(frame.opcode, frame.payload);
            } else {
              fragmentOp = frame.opcode;
              fragments.push(frame.payload);
            }
        }
      }
    });

    socket.on('error', () => this.#dropClient(1011, 'socket error'));
    socket.on('close', () => {
      if (this.client === socket) {
        this.client = null;
        this.emit('disconnect');
      }
    });
  }

  #deliver(opcode, payload) {
    if (opcode !== OP.TEXT) return;
    let msg;
    try {
      msg = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    // Answer keepalive pings inline so the extension's service worker stays up.
    if (msg.type === 'ping') {
      this.send({ type: 'pong', at: msg.at });
      return;
    }
    this.emit('message', msg);
  }

  #dropClient(code, reason) {
    const socket = this.client;
    if (!socket) return;
    this.client = null;
    try {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      socket.write(encodeFrame(OP.CLOSE, body));
    } catch {
      /* already gone */
    }
    socket.destroy();
    this.emit('disconnect', reason);
  }
}

// ------------------------------------------------------------- frame codec

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode; server frames are never masked

  return Buffer.concat([header, payload]);
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;

  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    if (big > 64n * 1024n * 1024n) throw new Error('WebSocket frame exceeds the 64MB limit');
    len = Number(big);
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + len) return null;

  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }

  return { fin, opcode, payload, consumed: offset + len };
}
