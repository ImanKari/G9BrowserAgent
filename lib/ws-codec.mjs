/**
 * RFC 6455 frame codec — shared by the daemon's server and the Node clients.
 *
 * Written by hand, like everything else on this path, so `git clone && node`
 * works on a locked-down machine with no registry access, and so nothing with
 * full control of a logged-in browser carries a supply chain.
 *
 * One codec, two users: `daemon/ws-server.js` (server frames are never masked)
 * and `lib/ws-client.mjs` (client frames are always masked). Keeping the two
 * directions in one file means a fix to length handling cannot land on one side
 * only.
 */

import crypto from 'node:crypto';

export const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** 64 MiB: a full-page screenshot or a large HAR fits; a runaway producer does not. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

export function encodeFrame(opcode, payload, { mask = false } = {}) {
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
  header[0] = 0x80 | opcode; // FIN + opcode; we never fragment what we send

  if (!mask) return Buffer.concat([header, payload]);

  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return Buffer.concat([header, key, body]);
}

/**
 * Decode one frame from the front of `buf`, or return null when more bytes are
 * needed. Throws on a frame larger than `maxBytes` — BEFORE waiting for its
 * body, so a hostile 1 TB length costs ten bytes rather than a terabyte. The
 * caller must catch: this runs inside a socket 'data' handler, where an
 * uncaught exception would take the whole process with it.
 */
export function decodeFrame(buf, { maxBytes = MAX_FRAME_BYTES } = {}) {
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
    if (big > BigInt(maxBytes)) throw new Error(`WebSocket frame exceeds the ${Math.round(maxBytes / 1048576)}MB limit`);
    len = Number(big);
    offset += 8;
  }
  if (len > maxBytes) throw new Error(`WebSocket frame exceeds the ${Math.round(maxBytes / 1048576)}MB limit`);

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

/**
 * Total bytes (header + mask + payload) of the frame at the front of `buf`, or
 * 0 while even its header is incomplete. Lets a reader wait for the whole frame
 * without re-joining its buffer on every TCP chunk.
 */
export function frameSize(buf) {
  if (buf.length < 2) return 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return 0;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return 0;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (buf[1] & 0x80) offset += 4;
  return offset + len;
}

/** A CLOSE frame body: 2-byte code + UTF-8 reason (truncated to fit 125 bytes). */
export function closeBody(code, reason = '') {
  const text = Buffer.from(String(reason ?? ''), 'utf8').subarray(0, 123);
  const body = Buffer.alloc(2 + text.length);
  body.writeUInt16BE(code, 0);
  text.copy(body, 2);
  return body;
}

export function parseCloseBody(payload) {
  if (!payload || payload.length < 2) return { code: 1005, reason: '' };
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString('utf8') };
}

/**
 * Reassembles fragmented messages and hands complete ones to `onFrame`.
 * Shared state machine for both ends; `maxMessageBytes` caps the assembled
 * message, not just each fragment, or fragmentation would be a way around the
 * frame cap.
 */
export class FrameReader {
  constructor({ maxBytes = MAX_FRAME_BYTES, onMessage, onControl }) {
    this.maxBytes = maxBytes;
    this.onMessage = onMessage;
    this.onControl = onControl;
    this.chunks = []; // received bytes not yet parsed, in arrival order
    this.buffered = 0;
    this.need = 0; // bytes the frame at the front needs in total (0 = header incomplete)
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOp = null;
  }

  /**
   * Feed received bytes. A large message arrives in hundreds of TCP chunks;
   * joining the whole pending buffer on each of them made a 30 MB relay result
   * cost gigabytes of copying on the daemon's only thread. Chunks are kept as a
   * list and joined once, when the frame at the front can be complete.
   */
  push(chunk) {
    if (!chunk?.length) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    if (this.need && this.buffered < this.need) return;
    let buffer = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;
    this.need = 0;
    for (;;) {
      const frame = decodeFrame(buffer, { maxBytes: this.maxBytes });
      if (!frame) {
        if (buffer.length) {
          this.chunks.push(buffer);
          this.buffered = buffer.length;
          this.need = frameSize(buffer);
        }
        return;
      }
      buffer = buffer.subarray(frame.consumed);

      if (frame.opcode >= 0x8) {
        // Control frames may arrive between fragments of a data message.
        if (this.onControl(frame.opcode, frame.payload) === false) return;
        continue;
      }
      if (frame.opcode === OP.CONT) {
        if (this.fragmentOp === null) throw new Error('continuation frame without a start');
        this.#collect(frame.payload);
        if (frame.fin) this.#flush();
        continue;
      }
      // RFC 6455 §5.4: a new data message may not start inside a fragmented one.
      if (this.fragmentOp !== null) throw new Error('a new message started before the fragmented one finished');
      if (frame.fin) {
        this.onMessage(frame.opcode, frame.payload);
      } else {
        this.fragmentOp = frame.opcode;
        this.#collect(frame.payload);
      }
    }
  }

  #collect(payload) {
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxBytes) {
      throw new Error(`WebSocket message exceeds the ${Math.round(this.maxBytes / 1048576)}MB limit`);
    }
    this.fragments.push(payload);
  }

  #flush() {
    const op = this.fragmentOp;
    const body = Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOp = null;
    this.onMessage(op, body);
  }
}
