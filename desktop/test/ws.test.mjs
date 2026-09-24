import assert from 'node:assert/strict';
import http from 'node:http';
import { suite, freePort } from './harness.mjs';
import { encodeFrame, decodeFrame, FrameReader, OP, WsClient, acceptUpgrade, MAX_FRAME } from '../lib/ws.mjs';

const t = suite('desktop: WebSocket client (lib/ws.mjs)');

t.test('frames round-trip at every length encoding (7-bit, 16-bit, 64-bit)', () => {
  for (const len of [0, 5, 125, 126, 65_535, 65_536, 200_000]) {
    const payload = Buffer.alloc(len, 0x61);
    for (const mask of [false, true]) {
      const f = decodeFrame(encodeFrame(OP.TEXT, payload, { mask }));
      assert.equal(f.opcode, OP.TEXT);
      assert.equal(f.fin, true);
      assert.equal(f.payload.length, len);
      assert.ok(f.payload.equals(payload), `len ${len} mask ${mask}`);
    }
  }
});

t.test('client frames are masked (RFC 6455 §5.3), server frames are not', () => {
  assert.equal(encodeFrame(OP.TEXT, Buffer.from('x'), { mask: true })[1] & 0x80, 0x80);
  assert.equal(encodeFrame(OP.TEXT, Buffer.from('x'))[1] & 0x80, 0);
});

t.test('a partial frame waits for more bytes', () => {
  const full = encodeFrame(OP.TEXT, Buffer.alloc(300, 1));
  assert.equal(decodeFrame(full.subarray(0, 3)), null);
  assert.equal(decodeFrame(full.subarray(0, full.length - 1)), null);
  assert.ok(decodeFrame(full));
});

t.test('an oversized frame throws instead of allocating', () => {
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(MAX_FRAME) + 1n, 2);
  assert.throws(() => decodeFrame(header), /64 MiB/);
});

t.test('FrameReader is linear: a 24 MiB frame in 64 KiB socket chunks, and frames fed one byte at a time', () => {
  const big = Buffer.alloc(24 * 1024 * 1024, 0x62);
  const wire = Buffer.concat([encodeFrame(OP.TEXT, big), encodeFrame(OP.TEXT, Buffer.from('after'))]);
  const r = new FrameReader();
  const out = [];
  const started = Date.now();
  for (let i = 0; i < wire.length; i += 64 * 1024) out.push(...r.push(wire.subarray(i, i + 64 * 1024)));
  const ms = Date.now() - started;
  assert.equal(out.length, 2);
  assert.equal(out[0].payload.length, big.length);
  assert.equal(out[1].payload.toString(), 'after');
  // Re-joining everything buffered on every chunk copied ~4.8 GB for this frame (seconds);
  // joining once when the frame is complete takes a few tens of ms.
  assert.ok(ms < 1500, `took ${ms} ms`);
  // Tiny chunks across every header length form still decode exactly.
  const small = [Buffer.alloc(3, 1), Buffer.alloc(200, 2), Buffer.alloc(70_000, 3)].map((p) => encodeFrame(OP.TEXT, p, { mask: true }));
  const r2 = new FrameReader();
  const got = [];
  for (const b of Buffer.concat(small)) got.push(...r2.push(Buffer.from([b])));
  assert.deepEqual(got.map((m) => m.payload.length), [3, 200, 70_000]);
  assert.ok(got[2].payload.every((x) => x === 3));
  // The size cap still fires as soon as the header is known, before the body arrives.
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(MAX_FRAME) + 1n, 2);
  const r3 = new FrameReader();
  assert.deepEqual(r3.push(header.subarray(0, 4)), []);
  assert.throws(() => r3.push(header.subarray(4)), /64 MiB/);
});

t.test('FrameReader reassembles a fragmented message around an interleaved ping', () => {
  const r = new FrameReader();
  const parts = [
    encodeFrame(OP.TEXT, Buffer.from('hel'), { fin: false }),
    encodeFrame(OP.PING, Buffer.from('p')),
    encodeFrame(OP.CONT, Buffer.from('lo '), { fin: false }),
    encodeFrame(OP.CONT, Buffer.from('world'), { fin: true }),
  ];
  const bytes = Buffer.concat(parts);
  const out = [];
  // Feed one byte at a time: the worst case for a stream parser.
  for (let i = 0; i < bytes.length; i++) out.push(...r.push(bytes.subarray(i, i + 1)));
  assert.equal(out.length, 2);
  assert.equal(out[0].opcode, OP.PING);
  assert.equal(out[1].opcode, OP.TEXT);
  assert.equal(out[1].payload.toString(), 'hello world');
});

t.test('FrameReader rejects a continuation with nothing to continue', () => {
  const r = new FrameReader();
  assert.throws(() => r.push(encodeFrame(OP.CONT, Buffer.from('x'))), /Continuation/);
});

async function server(port, onPeer, { status = null } = {}) {
  const s = http.createServer();
  s.on('upgrade', (req, socket, head) => {
    if (status) {
      socket.write(`HTTP/1.1 ${status} Nope\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.end();
      return;
    }
    onPeer(acceptUpgrade(req, socket, head), req);
  });
  await new Promise((r) => s.listen(port, '127.0.0.1', r));
  return s;
}

t.test('WsClient talks to a server: no Origin header, text both ways, 1 MiB fragmented message', async () => {
  const port = await freePort();
  let origin = 'unset';
  const big = 'x'.repeat(1024 * 1024);
  const s = await server(port, (peer, req) => {
    origin = req.headers.origin;
    peer.on('message', (m) => {
      if (m === 'big') peer.send(big, { fragments: 4 });
      else peer.send(`echo:${m}`);
    });
  });
  const c = new WsClient(`ws://127.0.0.1:${port}/g9`);
  const got = [];
  c.on('message', (m) => got.push(m));
  await new Promise((r) => c.on('open', r));
  assert.equal(origin, undefined, 'a native client sends no Origin (the daemon accepts exactly that)');
  c.send('hi');
  c.send('big');
  const end = Date.now() + 5000;
  while (got.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.equal(got[0], 'echo:hi');
  assert.equal(got[1].length, big.length);
  c.close();
  await new Promise((r) => s.close(r));
});

t.test('WsClient reports the server close code and reason', async () => {
  const port = await freePort();
  const s = await server(port, (peer) => setTimeout(() => peer.close(4001, 'reload the v2 extension'), 20));
  const c = new WsClient(`ws://127.0.0.1:${port}/g9`);
  const closed = await new Promise((r) => c.on('close', r));
  assert.equal(closed.code, 4001);
  assert.equal(closed.reason, 'reload the v2 extension');
  await new Promise((r) => s.close(r));
});

t.test('WsClient turns a refused upgrade into EUPGRADE with the HTTP status', async () => {
  const port = await freePort();
  const s = await server(port, () => {}, { status: 403 });
  const c = new WsClient(`ws://127.0.0.1:${port}/g9`);
  let err = null;
  c.on('error', (e) => { err = e; });
  await new Promise((r) => c.on('close', r));
  assert.equal(err.code, 'EUPGRADE');
  assert.equal(err.status, 403);
  await new Promise((r) => s.close(r));
});

t.test('WsClient: nothing listening → ECONNREFUSED on close, and no throw without an error listener', async () => {
  const port = await freePort();
  const c = new WsClient(`ws://127.0.0.1:${port}/g9`);
  const closed = await new Promise((r) => c.on('close', r));
  assert.equal(closed.code, 1006);
  assert.equal(c.lastError.code, 'ECONNREFUSED');
});

t.test('only ws:// URLs are accepted', () => {
  assert.throws(() => new WsClient('wss://127.0.0.1:1/g9'), /Only ws:\/\//);
});

t.run();
