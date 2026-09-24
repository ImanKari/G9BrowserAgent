/**
 * Minimal WebSocket client for Node — the shim, the runner's tests and the
 * self-test all use it to reach the daemon.
 *
 * Why not Node's global `WebSocket`: it exists from Node 22, but the shim also
 * runs inside the desktop app under `ELECTRON_RUN_AS_NODE=1`, whose embedded
 * Node version is Electron's choice, not ours. A hundred lines of RFC 6455 we
 * control beat a transport that may or may not be there. It also lets a test
 * send an arbitrary `Origin` — which is exactly what the daemon's origin rule
 * has to be proven against — and it sends NO Origin by default, which is how
 * the daemon recognises a native client.
 *
 * API (JSON in, JSON out, because every g9d message is one JSON object):
 *   const ws = await WsClient.connect('ws://127.0.0.1:8765/g9', { origin })
 *   ws.on('message', (obj) => …); ws.on('close', ({ code, reason }) => …)
 *   ws.send(obj) → boolean; ws.close(code, reason)
 * A refused handshake rejects with `err.status` (e.g. 403) and a refused TCP
 * connection with `err.code === 'ECONNREFUSED'`.
 */

import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { OP, MAX_FRAME_BYTES, acceptKey, encodeFrame, closeBody, parseCloseBody, FrameReader } from './ws-codec.mjs';

export class WsClient extends EventEmitter {
  static connect(url, { origin = null, headers = {}, timeoutMs = 5_000, maxBytes = MAX_FRAME_BYTES } = {}) {
    const target = new URL(url);
    const port = Number(target.port || 80);
    const host = target.hostname;
    const key = crypto.randomBytes(16).toString('base64');

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.destroy(); } catch { /* already gone */ }
        reject(err);
      };

      const socket = net.connect(port, host, () => {
        const lines = [
          `GET ${target.pathname}${target.search} HTTP/1.1`,
          `Host: ${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
        ];
        if (origin) lines.push(`Origin: ${origin}`);
        for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      });

      const timer = setTimeout(() => {
        const err = new Error(`WebSocket handshake with ${url} timed out after ${timeoutMs}ms`);
        err.code = 'ETIMEDOUT';
        fail(err);
      }, timeoutMs);

      let head = Buffer.alloc(0);
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) {
          if (head.length > 16_384) fail(new Error('WebSocket handshake response too large'));
          return;
        }
        socket.removeListener('data', onData);
        const text = head.subarray(0, end).toString('latin1');
        const status = Number(text.slice(9, 12));
        if (status !== 101) {
          const err = new Error(`handshake rejected: ${status} ${text.split('\r\n')[0].slice(13)}`.trim());
          err.status = status;
          return fail(err);
        }
        const accept = /\r\nsec-websocket-accept:\s*([^\r\n]+)/i.exec(`\r\n${text}`)?.[1]?.trim();
        if (accept !== acceptKey(key)) return fail(new Error('WebSocket handshake failed: bad Sec-WebSocket-Accept'));

        settled = true;
        clearTimeout(timer);
        const client = new WsClient(socket, { maxBytes });
        const rest = head.subarray(end + 4);
        resolve(client);
        // Deliver anything that arrived glued to the handshake AFTER the caller
        // has had a chance to attach listeners.
        if (rest.length) queueMicrotask(() => client.#ingest(rest));
      };

      socket.on('data', onData);
      socket.on('error', (err) => fail(err));
      socket.on('close', () => {
        if (!settled) {
          const err = new Error(`connection to ${url} closed during the handshake`);
          err.code = 'ECONNRESET';
          fail(err);
        }
      });
    });
  }

  constructor(socket, { maxBytes = MAX_FRAME_BYTES } = {}) {
    super();
    this.socket = socket;
    this.closed = false;
    this.closeInfo = null;
    socket.setNoDelay(true);
    this.reader = new FrameReader({
      maxBytes,
      onMessage: (opcode, payload) => {
        if (opcode !== OP.TEXT) return;
        let msg;
        try {
          msg = JSON.parse(payload.toString('utf8'));
        } catch {
          return; // one garbled message is not a reason to drop the link
        }
        this.emit('message', msg);
      },
      onControl: (opcode, payload) => {
        if (opcode === OP.PING) {
          this.#write(OP.PONG, payload);
        } else if (opcode === OP.CLOSE) {
          const info = parseCloseBody(payload);
          this.#write(OP.CLOSE, closeBody(info.code === 1005 ? 1000 : info.code));
          this.#finish(info);
          return false;
        }
        return true;
      },
    });
    socket.on('data', (chunk) => this.#ingest(chunk));
    // 'close' always follows a socket error and reports it; an 'error' event
    // with no listener would throw and take the whole process down.
    socket.on('error', (err) => { if (this.listenerCount('error')) this.emit('error', err); });
    socket.on('close', () => this.#finish({ code: 1006, reason: 'connection lost' }));
  }

  get open() {
    return !this.closed && !this.socket.destroyed;
  }

  /** Bytes queued in the kernel/socket buffer — a producer's backpressure signal. */
  get bufferedAmount() {
    return this.socket.writableLength ?? 0;
  }

  send(obj) {
    if (!this.open) return false;
    return this.#write(OP.TEXT, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    this.#write(OP.CLOSE, closeBody(code, reason));
    this.#finish({ code, reason });
  }

  /** Close without a close frame — used by tests to simulate a crash. */
  destroy() {
    this.socket.destroy();
  }

  #ingest(chunk) {
    try {
      this.reader.push(chunk);
    } catch (err) {
      if (this.listenerCount('error')) this.emit('error', err);
      this.close(1009, 'protocol error');
    }
  }

  #write(opcode, payload) {
    try {
      this.socket.write(encodeFrame(opcode, payload, { mask: true }));
      return true;
    } catch {
      return false;
    }
  }

  #finish(info) {
    if (this.closed) return;
    this.closed = true;
    this.closeInfo = info;
    try { this.socket.end(); } catch { /* already gone */ }
    setTimeout(() => { try { this.socket.destroy(); } catch { /* gone */ } }, 200).unref?.();
    this.emit('close', info);
  }
}
