/**
 * A minimal RFC 6455 WebSocket CLIENT for the Electron main process — no dependencies.
 *
 * Why not the runtime's global WebSocket: the desktop must talk to g9d the same way on every
 * Electron/Node version it ships with, including when it runs under ELECTRON_RUN_AS_NODE for
 * `--smoke`. The daemon's origin rule (DAEMON_PROTOCOL §1) refuses `Origin: http(s)://…`; this
 * client sends no Origin at all, which is exactly what the rule accepts for native clients.
 * The frame codec mirrors daemon/ws-server.js (moved from bridge/src/ws-server.js): 64 MiB cap,
 * fragmented messages reassembled, client frames masked as the RFC requires.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const MAX_FRAME = 64 * 1024 * 1024;
export const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Encode one frame. `mask` is true for client → server frames (mandatory per RFC 6455 §5.3). */
export function encodeFrame(opcode, payload, { mask = false, fin = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '');
  const len = body.length;
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
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (!mask) return Buffer.concat([header, body]);
  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = body[i] ^ key[i & 3];
  return Buffer.concat([header, key, masked]);
}

/**
 * Decode one frame from the front of `buf`. Returns null when the buffer does not yet hold a
 * whole frame. Throws on a frame over the cap — the caller turns that into a closed connection,
 * never an uncaught exception inside a socket 'data' handler (that would take the process down).
 */
export function decodeFrame(buf, { maxFrame = MAX_FRAME } = {}) {
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
    if (big > BigInt(maxFrame)) throw new Error(`WebSocket frame exceeds the ${Math.round(maxFrame / 1048576)} MiB limit`);
    len = Number(big);
    offset += 8;
  }
  if (len > maxFrame) throw new Error(`WebSocket frame exceeds the ${Math.round(maxFrame / 1048576)} MiB limit`);
  let key = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    key = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (key) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
  return { fin, opcode, payload, consumed: offset + len };
}

/**
 * How many bytes the frame at the front of `buf` needs in total, as far as its header tells —
 * or the size of the header still missing. Lets the reader wait for a big frame (a screencast JPEG
 * arrives in dozens of socket chunks) without re-concatenating everything it holds on every chunk.
 */
export function frameSizeHint(buf) {
  if (buf.length < 2) return 2;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return 4;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return 10;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (buf[1] & 0x80) offset += 4;
  return offset + len;
}

/**
 * Incremental reader shared by the client and the test server: feed bytes, get whole messages.
 * Control frames may arrive between the fragments of a data message (RFC 6455 §5.4).
 * Linear in the bytes received: chunks are only joined once the frame they belong to is complete.
 */
export class FrameReader {
  constructor({ maxFrame = MAX_FRAME, maxMessage = MAX_FRAME } = {}) {
    this.maxFrame = maxFrame;
    this.maxMessage = maxMessage;
    this.chunks = [];
    this.buffered = 0;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOp = null;
    this.need = 2; // bytes the next frame needs before decoding can succeed
  }

  /** @returns {Array<{opcode, payload}>} complete messages and control frames, in order */
  push(chunk) {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    if (this.buffered < this.need) return [];
    let buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
    const out = [];
    for (;;) {
      const frame = decodeFrame(buf, { maxFrame: this.maxFrame });
      if (!frame) {
        this.need = frameSizeHint(buf);
        break;
      }
      buf = buf.subarray(frame.consumed);
      if (frame.opcode >= 0x8) {
        out.push({ opcode: frame.opcode, payload: frame.payload });
        continue;
      }
      if (frame.opcode === OP.CONT) {
        if (this.fragmentOp === null) throw new Error('Continuation frame with no message to continue');
      } else {
        if (this.fragmentOp !== null) throw new Error('New data frame inside a fragmented message');
        this.fragmentOp = frame.opcode;
      }
      this.fragments.push(frame.payload);
      this.fragmentBytes += frame.payload.length;
      if (this.fragmentBytes > this.maxMessage) throw new Error('WebSocket message exceeds the size limit');
      if (frame.fin) {
        out.push({ opcode: this.fragmentOp, payload: Buffer.concat(this.fragments, this.fragmentBytes) });
        this.fragments = [];
        this.fragmentBytes = 0;
        this.fragmentOp = null;
      }
    }
    this.chunks = buf.length ? [Buffer.from(buf)] : [];
    this.buffered = buf.length;
    return out;
  }
}

/**
 * One client connection. Events: 'open', 'message' (string), 'close' ({code, reason}), 'error' (Error).
 * 'close' is emitted exactly once, after 'error' when there was one.
 */
export class WsClient extends EventEmitter {
  constructor(url, { headers = {}, connectTimeoutMs = 5000, maxFrame = MAX_FRAME } = {}) {
    super();
    this.url = new URL(url);
    if (this.url.protocol !== 'ws:') throw new Error(`Only ws:// URLs are supported (got ${this.url.protocol})`);
    this.headers = headers;
    this.connectTimeoutMs = connectTimeoutMs;
    this.reader = new FrameReader({ maxFrame, maxMessage: maxFrame });
    this.socket = null;
    this.readyState = 'connecting';
    this.closed = false;
    this.#open();
  }

  #open() {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: this.url.hostname,
      port: Number(this.url.port || 80),
      path: `${this.url.pathname}${this.url.search}`,
      method: 'GET',
      // No Origin header on purpose — see the file comment.
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...this.headers,
      },
    });
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error(`Timed out connecting to ${this.url.href}`), { code: 'ETIMEDOUT' }));
    }, this.connectTimeoutMs);

    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        this.#fail(new Error('The server answered the upgrade with a wrong Sec-WebSocket-Accept'));
        return;
      }
      this.socket = socket;
      socket.setNoDelay(true);
      this.readyState = 'open';
      socket.on('data', (chunk) => this.#onData(chunk));
      socket.on('error', (err) => this.#fail(err));
      socket.on('close', () => this.#finish(1006, 'connection lost'));
      this.emit('open');
      if (head?.length) this.#onData(head);
    });
    req.on('response', (res) => {
      clearTimeout(timer);
      // A plain HTTP answer to an upgrade: 403 from the origin rule, 404 from something that is not
      // g9d, 426 from a v1 bridge path. Keep the status so the caller can say which.
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 2000) body += d; });
      res.on('end', () => {
        const err = new Error(`The server refused the WebSocket upgrade: HTTP ${res.statusCode} ${res.statusMessage ?? ''}`.trim());
        err.code = 'EUPGRADE';
        err.status = res.statusCode;
        err.body = body;
        this.#fail(err);
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      this.#fail(err);
    });
    req.end();
  }

  #onData(chunk) {
    let messages;
    try {
      messages = this.reader.push(chunk);
    } catch (err) {
      // Oversized or malformed: the connection goes, never the process.
      this.#sendClose(1009, 'protocol error');
      this.#fail(err);
      return;
    }
    for (const { opcode, payload } of messages) {
      if (opcode === OP.PING) {
        this.#write(encodeFrame(OP.PONG, payload, { mask: true }));
      } else if (opcode === OP.PONG) {
        // nothing to do
      } else if (opcode === OP.CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        this.#sendClose(code === 1005 ? 1000 : code, '');
        this.#finish(code, reason);
        return;
      } else if (opcode === OP.TEXT) {
        this.emit('message', payload.toString('utf8'));
      }
      // Binary messages are not part of the g9d protocol; ignored.
    }
  }

  #write(buf) {
    if (!this.socket || this.socket.destroyed) return false;
    try {
      this.socket.write(buf);
      return true;
    } catch {
      return false;
    }
  }

  #sendClose(code, reason) {
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.#write(encodeFrame(OP.CLOSE, body, { mask: true }));
  }

  #fail(err) {
    if (this.closed) return;
    this.lastError = err;
    // An 'error' with no listener throws in EventEmitter; the close event carries the reason anyway.
    if (this.listenerCount('error') > 0) this.emit('error', err);
    this.#finish(1006, err?.message ?? String(err));
  }

  #finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 'closed';
    try { this.socket?.destroy(); } catch { /* already gone */ }
    this.emit('close', { code, reason });
  }

  /** Send a text message. Returns false when the socket is not open. */
  send(text) {
    if (this.readyState !== 'open') return false;
    return this.#write(encodeFrame(OP.TEXT, Buffer.from(String(text), 'utf8'), { mask: true }));
  }

  close(code = 1000, reason = 'client closing') {
    if (this.closed) return;
    if (this.readyState === 'open') this.#sendClose(code, reason);
    this.#finish(code, reason);
  }
}

/**
 * The server half of the handshake, for the desktop's own tests (a fake g9d). Not used by the app.
 * @returns {{ send(text), close(code, reason), on(event, fn) }} an emitter over the upgraded socket
 */
export function acceptUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const peer = new EventEmitter();
  const reader = new FrameReader();
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    socket.destroy();
    peer.emit('close');
  };
  peer.socket = socket;
  peer.send = (text, { fragments = 1 } = {}) => {
    const buf = Buffer.from(String(text), 'utf8');
    if (fragments <= 1) return socket.write(encodeFrame(OP.TEXT, buf));
    const size = Math.ceil(buf.length / fragments);
    for (let i = 0; i < fragments; i++) {
      const part = buf.subarray(i * size, (i + 1) * size);
      socket.write(encodeFrame(i === 0 ? OP.TEXT : OP.CONT, part, { fin: i === fragments - 1 }));
      // A ping between fragments is legal and must not break reassembly.
      if (i === 0) socket.write(encodeFrame(OP.PING, Buffer.from('mid')));
    }
    return true;
  };
  peer.close = (code = 1000, reason = '') => {
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try { socket.write(encodeFrame(OP.CLOSE, body)); } catch { /* gone */ }
    setTimeout(end, 20);
  };
  const onData = (chunk) => {
    let messages;
    try {
      messages = reader.push(chunk);
    } catch {
      end();
      return;
    }
    for (const { opcode, payload } of messages) {
      if (opcode === OP.TEXT) peer.emit('message', payload.toString('utf8'));
      else if (opcode === OP.PING) socket.write(encodeFrame(OP.PONG, payload));
      else if (opcode === OP.CLOSE) end();
    }
  };
  socket.on('data', onData);
  socket.on('error', end);
  socket.on('close', end);
  if (head?.length) onData(head);
  return peer;
}
