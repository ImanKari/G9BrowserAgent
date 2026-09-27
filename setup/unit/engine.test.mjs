// setup/unit/engine.test.mjs — engine/ (Engine 2 launcher, pipe transport, CfT, profiles, stealth).
//
// Convention (ARCHITECTURE_V2 §12.1): standalone, node:assert/strict, "  PASS <name>" per test,
// exit non-zero on the first failure. Offline: the downloader is tested against a local server on
// 127.0.0.1 (random port 18000–18999), never the network, never port 8765.
//
// EXCEPTION, asked for by the WP-engine task: the "live:" tests launch the REAL installed Edge
// headless (temp profile, closed and checked at the end) and, when a Chrome for Testing zip or
// install is cached locally, the pinned CfT. They are what proves the pipe, the switch list and the
// shutdown path against a real browser. They SKIP (with the reason) when no browser is installed,
// and G9_UNIT_NO_BROWSER=1 skips them on purpose. The CfT cache is G9_CFT_CACHE, default
// %TEMP%\g9-cft-cache (see engine/README.md); nothing is ever downloaded by this file.

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

// A fresh G9_HOME before anything reads it. Nothing in this file touches the real one.
const TEMP_ROOT = await mkdtemp(path.join(os.tmpdir(), 'g9-engine-unit-'));
const HOME = path.join(TEMP_ROOT, 'home');
process.env.G9_HOME = HOME;
await mkdir(HOME, { recursive: true });

const { PipeCdp, timeoutFor, DEFAULT_TIMEOUT_MS, SLOW_COMMANDS, MAX_TIMER_MS } = await import('../../engine/pipe-cdp.js');
const find = await import('../../engine/find.js');
const cft = await import('../../engine/cft.js');
const stealth = await import('../../engine/stealth.js');
const profile = await import('../../engine/profile.js');
const launch = await import('../../engine/launch.js');
const firewall = await import('../../engine/firewall.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const skip = (reason) => { const e = new Error(reason); e.skip = true; throw e; };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────

/** A fake browser on the other end of a PipeCdp: parses what we send, lets the test answer. */
function fakeBrowser(opts = {}) {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const conn = new PipeCdp(toBrowser, fromBrowser, { name: 'fake', ...opts });
  const received = [];
  const waiters = [];
  let buf = Buffer.alloc(0);
  toBrowser.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    let i;
    while ((i = buf.indexOf(0)) >= 0) {
      received.push(JSON.parse(buf.subarray(0, i).toString('utf8')));
      buf = buf.subarray(i + 1);
    }
    while (waiters.length && waiters[0].n <= received.length) waiters.shift().resolve();
  });
  const frame = (obj) => Buffer.from(JSON.stringify(obj) + '\0', 'utf8');
  return {
    conn,
    toBrowser,
    fromBrowser,
    received,
    frame,
    write: (bufOrObj) => fromBrowser.write(Buffer.isBuffer(bufOrObj) ? bufOrObj : frame(bufOrObj)),
    waitCommands: (n) => (received.length >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ n, resolve }))),
  };
}

async function writeInChunks(stream, buffer, size) {
  for (let i = 0; i < buffer.length; i += size) {
    stream.write(buffer.subarray(i, i + size));
    if ((i / size) % 64 === 0) await new Promise((r) => setImmediate(r));
  }
}

/** A standards-conforming zip (stored/deflate, UTF-8 names), built by hand for the reader tests. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 0;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = (e.crc ?? zlib.crc32(data)) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(e.name.endsWith('/') ? 0x10 : 0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const md5b64 = (buf) => crypto.createHash('md5').update(buf).digest('base64');

/** A local HTTP server on a random port in 18000–18999 (never 8765). */
async function localServer(handler) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 18000 + Math.floor(Math.random() * 1000);
    const server = http.createServer(handler);
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) return { server, port, url: (p) => `http://127.0.0.1:${port}${p}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
  }
  throw new Error('no free port in 18000-18999');
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// ─── pipe-cdp ────────────────────────────────────────────────────────────────────────────────

test('pipe: commands are NUL-framed JSON with increasing ids and optional sessionId', async () => {
  const fb = fakeBrowser();
  const a = fb.conn.send('Browser.getVersion');
  const b = fb.conn.send('Runtime.evaluate', { expression: '1+1' }, 'S1');
  await fb.waitCommands(2);
  assert.deepEqual(fb.received[0], { id: 1, method: 'Browser.getVersion', params: {} });
  assert.deepEqual(fb.received[1], { id: 2, method: 'Runtime.evaluate', params: { expression: '1+1' }, sessionId: 'S1' });
  // Answer out of order: ids, not arrival order, route replies.
  fb.write({ id: 2, result: { result: { value: 2 } }, sessionId: 'S1' });
  fb.write({ id: 1, result: { product: 'X/1.2.3.4' } });
  assert.deepEqual(await b, { result: { value: 2 } });
  assert.deepEqual(await a, { product: 'X/1.2.3.4' });
  assert.equal(fb.conn.pendingCount, 0);
  fb.conn.close();
});

test('pipe: a reply split into 1-byte chunks keeps multi-byte UTF-8 intact', async () => {
  const fb = fakeBrowser();
  const p = fb.conn.send('Target.getTargetInfo');
  await fb.waitCommands(1);
  const title = 'سلام — € 😀 日本';
  const bytes = fb.frame({ id: 1, result: { targetInfo: { title } } });
  await writeInChunks(fb.fromBrowser, bytes, 1);
  assert.equal((await p).targetInfo.title, title);
  fb.conn.close();
});

test('pipe: several messages (events and replies) in one chunk, the last one cut in half', async () => {
  const fb = fakeBrowser();
  const events = [];
  fb.conn.on('event', (m, params, sid) => events.push([m, params, sid]));
  const p1 = fb.conn.send('A.one');
  const p2 = fb.conn.send('A.two');
  await fb.waitCommands(2);
  const merged = Buffer.concat([
    fb.frame({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T1' } } }),
    fb.frame({ id: 1, result: { n: 1 } }),
    fb.frame({ method: 'Page.loadEventFired', params: { timestamp: 5 }, sessionId: 'S9' }),
  ]);
  const last = fb.frame({ id: 2, result: { n: 2 } });
  fb.write(Buffer.concat([merged, last.subarray(0, 7)]));
  assert.deepEqual(await p1, { n: 1 });
  fb.write(last.subarray(7));
  assert.deepEqual(await p2, { n: 2 });
  assert.deepEqual(events, [
    ['Target.targetCreated', { targetInfo: { targetId: 'T1' } }, null],
    ['Page.loadEventFired', { timestamp: 5 }, 'S9'],
  ]);
  fb.conn.close();
});

test('pipe: a 24 MB reply arriving in 64 KB chunks', async () => {
  const fb = fakeBrowser();
  const p = fb.conn.send('Page.captureScreenshot');
  await fb.waitCommands(1);
  const data = crypto.randomBytes(18 * 1024 * 1024).toString('base64');   // ~24 MB of base64
  const t = Date.now();
  await writeInChunks(fb.fromBrowser, fb.frame({ id: 1, result: { data } }), 64 * 1024);
  const res = await p;
  assert.equal(res.data.length, data.length);
  assert.equal(res.data, data);
  assert.ok(Date.now() - t < 10_000, 'framing a large message must stay linear');
  fb.conn.close();
});

test('pipe: CDP errors reject with the browser\'s own text, code and method', async () => {
  const fb = fakeBrowser();
  const p = fb.conn.send('DOM.resolveNode', { backendNodeId: 7 }, 'S2');
  await fb.waitCommands(1);
  fb.write({ id: 1, error: { code: -32000, message: 'No node with given id found', data: 'backendNodeId 7' }, sessionId: 'S2' });
  await assert.rejects(p, (err) => {
    assert.equal(err.message, 'No node with given id found (backendNodeId 7)');
    assert.equal(err.code, -32000);
    assert.equal(err.method, 'DOM.resolveNode');
    assert.equal(err.sessionId, 'S2');
    return true;
  });
  fb.conn.close();
});

test('pipe: a stuck command times out by name; its late reply is ignored; the pipe stays usable', async () => {
  const fb = fakeBrowser();
  const stuck = fb.conn.send('Input.dispatchMouseEvent', { type: 'mouseWheel' }, 'S1', { timeoutMs: 60 });
  await assert.rejects(stuck, /"Input\.dispatchMouseEvent" did not return after 0s\. The command is stuck rather than slow/);
  fb.write({ id: 1, result: {} });           // the late reply
  const next = fb.conn.send('Page.navigate', { url: 'about:blank' });
  await fb.waitCommands(2);
  fb.write({ id: 2, result: { frameId: 'F' } });
  assert.deepEqual(await next, { frameId: 'F' });
  assert.equal(fb.conn.stats.lateReplies, 1);
  fb.conn.close();
});

test('pipe: budgets — 20 s default, the slow-command table, per-call and per-connection overrides', async () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 20_000);
  assert.equal(timeoutFor('Runtime.evaluate'), 20_000);
  assert.equal(timeoutFor('Page.captureScreenshot'), 45_000);
  assert.equal(timeoutFor('Page.getLayoutMetrics'), 30_000);
  assert.equal(timeoutFor('Tracing.end'), 45_000);
  assert.equal(timeoutFor('IO.read'), 45_000);
  assert.equal(timeoutFor('Page.captureScreenshot', 5000), 5000);
  assert.equal(SLOW_COMMANDS.size, 4);
  const fb = fakeBrowser({ defaultTimeoutMs: 50 });
  await assert.rejects(fb.conn.send('Anything.at'), /did not return/);
  fb.conn.close();
});

test('pipe: the browser closing its end rejects every pending call naming its method, and emits close once', async () => {
  const fb = fakeBrowser();
  let closes = 0;
  let reason = null;
  fb.conn.on('close', (r) => { closes++; reason = r; });
  const a = fb.conn.send('Page.captureScreenshot', {}, 'S1');
  const b = fb.conn.send('Runtime.evaluate', {}, 'S1');
  await fb.waitCommands(2);
  fb.fromBrowser.end();
  await assert.rejects(a, /closed before "Page\.captureScreenshot" answered/);
  await assert.rejects(b, /closed before "Runtime\.evaluate" answered/);
  await delay(10);
  assert.equal(closes, 1);
  assert.match(reason, /closed its end of the pipe/);
  assert.equal(fb.conn.closed, true);
  await assert.rejects(fb.conn.send('Page.reload'), /Cannot send "Page\.reload": the connection to fake is closed/);
});

test('pipe: close() rejects pending calls and destroys both streams', async () => {
  const fb = fakeBrowser();
  const p = fb.conn.send('Tracing.end');
  await fb.waitCommands(1);
  fb.conn.close('test is done');
  await assert.rejects(p, (err) => err.code === 'CLOSED' && /"Tracing\.end"/.test(err.message) && /test is done/.test(err.message));
  assert.equal(fb.toBrowser.destroyed, true);
  assert.equal(fb.fromBrowser.destroyed, true);
  fb.conn.close();   // idempotent
});

test('pipe: the child process exiting closes the connection with its exit code', async () => {
  const child = new EventEmitter();
  const fb = fakeBrowser({ child });
  const p = fb.conn.send('Browser.getVersion');
  await fb.waitCommands(1);
  child.emit('exit', 3, null);
  await assert.rejects(p, /the browser process exited \(code 3\)/);
  assert.equal(fb.conn.closed, true);
});

test('pipe: a reply still in the pipe when the process exits is delivered, not failed', async () => {
  // Node may emit 'exit' before the child's last bytes were read from fd 4.
  const child = new EventEmitter();
  const fb = fakeBrowser({ child });
  let reason = null;
  fb.conn.on('close', (r) => { reason = r; });
  const shot = fb.conn.send('Page.captureScreenshot');
  const other = fb.conn.send('Runtime.evaluate');
  await fb.waitCommands(2);
  child.emit('exit', 0, null);
  fb.write({ id: 1, result: { data: 'iVBOR' } });   // arrives just after 'exit'
  assert.deepEqual(await shot, { data: 'iVBOR' });
  fb.fromBrowser.end();                              // then the pipe ends
  await assert.rejects(other, /closed before "Runtime\.evaluate" answered \(fake: the browser process exited \(code 0\)\)/);
  assert.match(reason, /the browser process exited \(code 0\)/, 'the close names the exit, which is the better reason');
});

test('pipe: a write error closes the connection instead of throwing', async () => {
  const fb = fakeBrowser();
  const p = fb.conn.send('Page.enable');
  await fb.waitCommands(1);
  fb.toBrowser.destroy(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
  await assert.rejects(p, /writing to the pipe failed \(EPIPE\)|closed its end/);
  assert.equal(fb.conn.closed, true);
});

test('pipe: a malformed frame is counted and skipped; the connection survives', async () => {
  const fb = fakeBrowser();
  const seen = [];
  fb.conn.on('protocolError', (e) => seen.push(e));
  const p = fb.conn.send('DOM.getDocument');
  await fb.waitCommands(1);
  fb.write(Buffer.from('{not json\0', 'utf8'));
  fb.write({ id: 1, result: { root: {} } });
  assert.deepEqual(await p, { root: {} });
  assert.equal(fb.conn.stats.malformed, 1);
  assert.equal(seen.length, 1);
  fb.conn.close();
});

test('pipe: a throwing event listener neither starves the others nor kills the reader', async () => {
  const fb = fakeBrowser();
  const errors = [];
  const got = [];
  fb.conn.on('listenerError', (err, method) => errors.push([err.message, method]));
  fb.conn.on('event', () => { throw new Error('buggy subsystem'); });
  fb.conn.on('event', (m) => got.push(m));
  fb.write({ method: 'Network.requestWillBeSent', params: {} });
  fb.write({ method: 'Network.responseReceived', params: {} });
  await delay(20);
  assert.deepEqual(got, ['Network.requestWillBeSent', 'Network.responseReceived']);
  assert.equal(errors.length, 2);
  assert.deepEqual(errors[0], ['buggy subsystem', 'Network.requestWillBeSent']);
  fb.conn.close();
});

test('pipe: waitForEvent filters by session and predicate, and fails on close', async () => {
  const fb = fakeBrowser();
  const w = fb.conn.waitForEvent('Page.frameNavigated', { sessionId: 'S1', predicate: (p) => p.frame.url === 'b' });
  fb.write({ method: 'Page.frameNavigated', params: { frame: { url: 'b' } }, sessionId: 'S2' });
  fb.write({ method: 'Page.frameNavigated', params: { frame: { url: 'a' } }, sessionId: 'S1' });
  fb.write({ method: 'Page.frameNavigated', params: { frame: { url: 'b' } }, sessionId: 'S1' });
  assert.deepEqual(await w, { frame: { url: 'b' } });
  const never = fb.conn.waitForEvent('Page.loadEventFired', { timeoutMs: 5000 });
  // A JSON null budget is the default one, not an instant timeout.
  const nullBudget = fb.conn.waitForEvent('Page.domContentEventFired', { timeoutMs: null });
  await delay(20);
  fb.write({ method: 'Page.domContentEventFired', params: { timestamp: 1 } });
  assert.deepEqual(await nullBudget, { timestamp: 1 });
  fb.conn.close('bye');
  await assert.rejects(never, /closed while waiting for "Page\.loadEventFired"/);
});

test('pipe: close() after the browser side closed still releases both streams; a throwing close listener is contained', async () => {
  const fb = fakeBrowser();
  const errors = [];
  let after = 0;
  fb.conn.on('listenerError', (err, what) => errors.push([err.message, what]));
  fb.conn.on('close', () => { throw new Error('buggy close handler'); });
  fb.conn.on('close', () => { after++; });
  // The browser ends its side: the connection closes, but nothing destroyed our write stream.
  fb.fromBrowser.end();
  await delay(10);
  assert.equal(fb.conn.closed, true);
  assert.equal(after, 1, 'the listener after a throwing one still learns of the close');
  assert.deepEqual(errors, [['buggy close handler', 'close']]);
  assert.equal(fb.toBrowser.destroyed, false);
  // What launch.js close() does after the process exited: the handles must be released now.
  fb.conn.close();
  assert.equal(fb.toBrowser.destroyed, true);
  assert.equal(after, 1, "'close' is emitted once");
});

test('pipe: a budget beyond the timer limit is clamped instead of becoming an instant timeout', async () => {
  assert.equal(MAX_TIMER_MS, 2 ** 31 - 1);
  assert.equal(timeoutFor('Tracing.end', 2 ** 40), MAX_TIMER_MS);
  const fb = fakeBrowser();
  const p = fb.conn.send('Tracing.end', {}, null, { timeoutMs: 2 ** 40 });
  await fb.waitCommands(1);
  await delay(30);
  assert.equal(fb.conn.pendingCount, 1, 'still waiting for the reply');
  fb.write({ id: 1, result: { stream: 'S' } });
  assert.deepEqual(await p, { stream: 'S' });
  fb.conn.close();
});

// ─── find ────────────────────────────────────────────────────────────────────────────────────

function fakePe(version, { strayFirst = true } = {}) {
  const [a, b, c, d] = version.split('.').map(Number);
  const prefix = Buffer.alloc(100, 0x41);
  if (strayFirst) {
    // The bare signature followed by garbage, as it occurs in real code sections.
    Buffer.from([0xbd, 0x04, 0xef, 0xfe, 0, 0, 1, 0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]).copy(prefix, 20);
  }
  const header = Buffer.alloc(6);
  const key = Buffer.from('VS_VERSION_INFO\0', 'utf16le');
  const pad = Buffer.alloc(2);
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0);
  fixed.writeUInt32LE(0x00010000, 4);
  fixed.writeUInt32LE(((a << 16) | b) >>> 0, 8);
  fixed.writeUInt32LE(((c << 16) | d) >>> 0, 12);
  return Buffer.concat([prefix, header, key, pad, fixed, Buffer.alloc(64)]);
}

test('find: the PE version reader anchors on VS_VERSION_INFO, not on a stray signature', () => {
  assert.equal(find.peVersion(fakePe('153.0.4234.32')), '153.0.4234.32');
  assert.equal(find.peVersion(fakePe('65535.1.2.65535', { strayFirst: false })), '65535.1.2.65535');
  assert.equal(find.peVersion(Buffer.alloc(4096)), null);
  assert.equal(find.compareVersions('153.0.10.1', '153.0.9.99'), 1);
  assert.equal(find.compareVersions('1.2.3.4', '1.2.3.4'), 0);
});

test('find: default user-data directories (and anything inside them) are recognised', () => {
  const [edgeDefault] = find.defaultUserDataDirs();
  assert.equal(find.isDefaultUserDataDir(edgeDefault), true);
  assert.equal(find.isDefaultUserDataDir(path.join(edgeDefault, 'Default')), true);
  if (process.platform === 'win32') assert.equal(find.isDefaultUserDataDir(edgeDefault.toUpperCase()), true);
  assert.equal(find.isDefaultUserDataDir(path.join(HOME, 'profiles', 'automation')), false);
  assert.equal(find.isDefaultUserDataDir(os.tmpdir()), false);
});

test('find: the default-profile guard sees through junctions and symlinks (fake LOCALAPPDATA)', async () => {
  if (process.platform === 'darwin') skip('macOS default dirs are under the real home; not faked here');
  // Everything lives in the temp root: the real browsers' directories are never linked to.
  const fakeLocal = path.join(TEMP_ROOT, 'fake-local');
  const env = { ...process.env, LOCALAPPDATA: fakeLocal, XDG_CONFIG_HOME: fakeLocal };
  const fakeDefault = find.defaultUserDataDirs(env)[0];
  assert.ok(fakeDefault.startsWith(fakeLocal));
  await mkdir(fakeDefault, { recursive: true });
  const link = path.join(TEMP_ROOT, 'innocent-looking-dir');
  await symlink(fakeDefault, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(find.isDefaultUserDataDir(link, env), true, 'a junction to a default dir IS that dir');
  assert.equal(find.isDefaultUserDataDir(path.join(link, 'Default'), env), true);
  assert.equal(find.isDefaultUserDataDir(path.join(link, 'not', 'created', 'yet'), env), true, 'a missing tail still resolves through the link');
  assert.equal(find.isDefaultUserDataDir(path.join(TEMP_ROOT, 'elsewhere'), env), false);
  assert.equal(find.realPathOf(path.join(link, 'x', 'y')).toLowerCase(), path.join(find.realPathOf(fakeDefault), 'x', 'y').toLowerCase());
});

test('find: a flat CfT build with no readable PE resource is identified by its <version>.manifest', async () => {
  const d = path.join(TEMP_ROOT, 'flat-cft', 'chrome-win64');
  await mkdir(d, { recursive: true });
  await writeFile(path.join(d, 'chrome.exe'), 'MZ — not a real image');
  await writeFile(path.join(d, '153.0.1.2.manifest'), '<assembly/>');
  assert.deepEqual(await find.exeVersionInfo(path.join(d, 'chrome.exe'), { kind: 'cft' }), { version: '153.0.1.2', source: 'manifest' });
  assert.equal(await find.manifestVersion(path.join(d, 'chrome.exe')), '153.0.1.2');
  await writeFile(path.join(d, '153.0.1.3.manifest'), '<assembly/>');
  assert.equal(await find.manifestVersion(path.join(d, 'chrome.exe')), null, 'two manifests: ambiguous, not guessed');
});

let EDGE = null;
test('find: Edge is found on this machine, with the version of the exe itself', async () => {
  const all = await find.findBrowsers();
  const edge = all.find((b) => b.kind === 'edge' && b.channel === 'stable');
  if (!edge) {
    if (process.platform === 'win32' && find.candidatePaths().some((c) => c.kind === 'edge' && existsSync(c.path))) {
      assert.fail('Edge is installed but findBrowsers() did not report it');
    }
    skip('Microsoft Edge is not installed here');
  }
  assert.match(edge.version, /^\d+\.\d+\.\d+\.\d+$/);
  if (process.platform === 'win32') assert.equal(edge.versionSource, 'pe');
  const dirs = await find.versionDirs(edge.path);
  assert.ok(dirs.includes(edge.version), `the exe version ${edge.version} must be one of the version dirs ${dirs}`);
  EDGE = edge;
  for (const b of all) assert.ok(find.KINDS.includes(b.kind));
});

test('find: resolveBrowser — kinds, auto without CfT, paths, and useful errors', async () => {
  if (!EDGE) skip('needs Edge');
  const edge = await find.resolveBrowser('edge');
  assert.equal(edge.kind, 'edge');
  assert.equal(edge.path, EDGE.path);
  const auto = await find.resolveBrowser('auto', { home: HOME });   // the unit G9_HOME has no CfT yet
  assert.equal(auto.kind, 'edge');
  const byPath = await find.resolveBrowser(EDGE.path);
  assert.equal(byPath.kind, 'edge');
  assert.equal(byPath.version, EDGE.version);
  await assert.rejects(find.resolveBrowser('firefox'), /Unknown browser "firefox". Use one of: auto, edge, chrome, cft/);
  await assert.rejects(find.resolveBrowser('cft', { home: path.join(TEMP_ROOT, 'empty-home') }), /No cft browser was found\. Found: .*Install the pinned Chrome for Testing first/);
  await assert.rejects(find.resolveBrowser(path.join(TEMP_ROOT, 'nope', 'chrome.exe')), /Browser executable not found/);
});

// ─── stealth ─────────────────────────────────────────────────────────────────────────────────

test('stealth: levels, domain sets (never Runtime in stealth), and the one stealth switch (decision D-a)', () => {
  assert.deepEqual(stealth.LEVELS, ['off', 'human', 'stealth']);
  assert.deepEqual(stealth.autoEnableDomains('off'), ['Page', 'Runtime', 'Log', 'Network', 'DOM', 'CSS']);
  assert.deepEqual(stealth.autoEnableDomains('human'), ['Page', 'Runtime', 'Log', 'Network', 'DOM', 'CSS']);
  assert.deepEqual(stealth.autoEnableDomains('stealth'), ['Page', 'Log', 'Network', 'DOM', 'CSS']);
  assert.equal(stealth.isDomainAllowed('stealth', 'Runtime'), false);
  assert.equal(stealth.isDomainAllowed('human', 'Runtime'), true);
  const expected = { off: [], human: [], stealth: ['--disable-blink-features=AutomationControlled'] };
  assert.equal(stealth.WEBDRIVER_SWITCH, '--disable-blink-features=AutomationControlled');
  for (const l of stealth.LEVELS) {
    const args = stealth.launchArgsFor(l);
    assert.deepEqual(args, expected[l], l);
    args.push('--mutated');
    assert.deepEqual(stealth.launchArgsFor(l), expected[l], 'a fresh array every call');
  }
  assert.deepEqual(stealth.launchArgsFor('STEALTH'), expected.stealth, 'level names are case-insensitive');
  assert.throws(() => stealth.launchArgsFor('ninja'), /Unknown stealth level "ninja"/);
});

test('stealth: launch warnings — webdriver is named honestly at off/human; stealth warns only about headless', () => {
  for (const level of ['off', 'human']) {
    for (const headless of [true, false]) {
      const w = stealth.launchWarnings({ level, headless });
      assert.equal(w.length, 1, `${level} headless=${headless}`);
      assert.match(w[0], /navigator\.webdriver is true/);
      assert.match(w[0], /decision D-a/);
    }
  }
  const w = stealth.launchWarnings({ level: 'stealth', headless: true });
  assert.equal(w.length, 1);
  assert.match(w[0], /HeadlessChrome/);
  // Live round 2: headless Edge and CfT reported the REAL GPU renderer in 30/30 runs, so the
  // warning names what was measured (UA brand, outer size 0×0 at load) and software GL only as
  // a possibility on machines without a GPU.
  assert.match(w[0], /outer size can read 0×0/);
  assert.match(w[0], /without a GPU/);
  assert.ok(!w.some((x) => /webdriver/.test(x)), 'stealth clears webdriver, so it is no longer warned about');
  assert.ok(!w.some((x) => /screen-info/.test(x)), 'launch.js now sizes the headless screen itself');
  assert.deepEqual(stealth.launchWarnings({ level: 'stealth', headless: false }), []);
  // Chrome for Testing at stealth: its brand and its missing Widevine are read by detectors, and its
  // input arrived at 10 Hz (live round 2, re-confirmed by an interleaved A/B on 2026-09-23).
  const cft = stealth.launchWarnings({ level: 'stealth', headless: false, kind: 'cft' });
  assert.equal(cft.length, 1);
  assert.match(cft[0], /Chrome for Testing/);
  assert.match(cft[0], /Widevine/);
  assert.match(cft[0], /10 Hz/);
  assert.match(cft[0], /disable-frame-rate-limit/);
  assert.deepEqual(stealth.launchWarnings({ level: 'stealth', headless: false, kind: 'edge' }), []);
  assert.equal(stealth.launchWarnings({ level: 'human', headless: false, kind: 'cft' }).length, 1, 'off/human: only the webdriver fact');
});

test('stealth: checkConsistency — consistent settings pass, each kind of contradiction is named', () => {
  assert.deepEqual(stealth.checkConsistency({ locale: 'de-DE', timezone: 'Europe/Berlin', acceptLanguage: 'de-DE,de;q=0.9,en;q=0.8' }), []);
  assert.deepEqual(stealth.checkConsistency({ locale: 'en-IN', timezone: 'Asia/Kolkata' }), []);          // alias Asia/Calcutta
  assert.deepEqual(stealth.checkConsistency({ locale: 'fa-IR', timezone: 'Asia/Tehran', acceptLanguage: 'fa-IR,fa;q=0.9,en-US;q=0.8' }), []);
  assert.deepEqual(stealth.checkConsistency({ locale: 'en', timezone: 'Asia/Tokyo' }), [], 'no region → nothing to contradict');

  const lang = stealth.checkConsistency({ locale: 'en-US', timezone: 'America/New_York', acceptLanguage: 'de-DE,de;q=0.9' });
  assert.equal(lang.length, 1);
  assert.match(lang[0], /Accept-Language starts with "de-DE" but the locale is "en-US"/);

  const zone = stealth.checkConsistency({ locale: 'en-US', timezone: 'Asia/Tokyo' });
  assert.equal(zone.length, 1);
  assert.match(zone[0], /region US, but the timezone "Asia\/Tokyo" is not used there/);

  const host = stealth.checkConsistency({ locale: 'de-DE', hostTimezone: 'Asia/Tehran' });
  assert.equal(host.length, 1);
  assert.match(host[0], /host timezone \(no timezone was set\) "Asia\/Tehran"/);
  assert.deepEqual(stealth.checkConsistency({ locale: 'de-DE', hostTimezone: null }), []);

  assert.match(stealth.checkConsistency({ timezone: 'Mars/Olympus' })[0], /not an IANA time zone/);
  assert.match(stealth.checkConsistency({ locale: 'en_US!' })[0], /not a valid BCP 47 language tag/);
  assert.match(stealth.checkConsistency({ acceptLanguage: 'en;q=0.5,de;q=0.9', hostTimezone: null })[0], /q-values must not increase/);
  assert.match(stealth.checkConsistency({ acceptLanguage: 'en;q=abc', hostTimezone: null })[0], /invalid parameter/);
  assert.match(stealth.checkConsistency({ acceptLanguage: 'en;q=1.5', hostTimezone: null })[0], /invalid parameter "q=1\.5"/, 'a q-value above 1 is not a q-value');
  assert.deepEqual(stealth.parseAcceptLanguage('en-US;q=1.000,en;Q=0.9'), { items: [{ tag: 'en-US', q: 1 }, { tag: 'en', q: 0.9 }], problems: [] });
  assert.equal(stealth.launchWarnings({ level: 'stealth', headless: true, extraArgs: null }).length, 1, 'null extraArgs (JSON) is no extraArgs');
});

// ─── launch (pure parts) ─────────────────────────────────────────────────────────────────────

test('launch: the sandbox stays on unless G9_BROWSER_NO_SANDBOX=1 on Linux; a sandbox abort says how to fix it', () => {
  const dir = path.join(TEMP_ROOT, 'p');
  assert.ok(!launch.buildArgs({ profileDir: dir }).includes('--no-sandbox'), 'never by default');
  assert.equal(launch.buildArgs({ profileDir: dir, noSandbox: true })[2], '--no-sandbox');
  assert.equal(launch.noSandboxWanted({ platform: 'linux', env: {} }), false);
  assert.equal(launch.noSandboxWanted({ platform: 'linux', env: { G9_BROWSER_NO_SANDBOX: '1' } }), true);
  assert.equal(launch.noSandboxWanted({ platform: 'win32', env: { G9_BROWSER_NO_SANDBOX: '1' } }), false, 'Linux only');
  // Edge 153's own words on a hosted Ubuntu 24.04 machine (setuid_sandbox_host.cc).
  const abort = '[2812:2812:0926/142108.241953:FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166] The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I\'m aborting now. You need to make sure that /opt/microsoft/msedge/msedge-sandbox is owned by root and has mode 4755.';
  const hint = launch.sandboxHint(abort);
  assert.match(hint, /sudo chown root:root \/opt\/microsoft\/msedge\/msedge-sandbox && sudo chmod 4755 \/opt\/microsoft\/msedge\/msedge-sandbox/);
  assert.match(hint, /G9_BROWSER_NO_SANDBOX=1/);
  assert.match(launch.sandboxHint('No usable sandbox! Update your kernel'), /user namespaces/);
  assert.match(launch.sandboxHint('[3494:3494:0927/080108.139285:ERROR:content/browser/zygote_host/zygote_host_impl_linux.cc:102] Running as root without --no-sandbox is not supported. See https://crbug.com/638180.'), /as root[\s\S]*G9_BROWSER_NO_SANDBOX=1/);
  assert.equal(launch.sandboxHint('[123:FATAL:gpu] something else'), '');
  assert.equal(launch.sandboxHint(''), '');
});

test('launch: the switch list is exactly the designed list (+ the Edge sign-in guards, + stealth, + extraArgs, + start URL)', () => {
  const dir = path.join(TEMP_ROOT, 'p');
  const args = launch.buildArgs({ profileDir: dir });
  const taskbar = launch.HEADLESS_TASKBAR;
  assert.deepEqual(args, [
    '--remote-debugging-pipe',
    `--user-data-dir=${dir}`,
    '--headless=new',
    `--window-size=1920,${1080 - taskbar}`,
    taskbar ? `--screen-info={1920x1080 workAreaBottom=${taskbar}}` : '--screen-info={1920x1080}',
    '--no-first-run', '--no-default-browser-check', '--disable-component-update', '--disable-background-mode',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    // Live round 2: Edge signed every new profile into the Windows account and synced it.
    '--disable-sync',
    '--disable-features=CalculateNativeWinOcclusion,Translate,MediaRouter,GlobalMediaControls,PaintHolding,HttpsUpgrades,AutoDeElevate,OptimizationHints,msImplicitSignin',
    'about:blank',
  ]);
  const headed = launch.buildArgs({
    profileDir: dir, headless: false, windowSize: { width: 1280, height: 800 }, lang: 'de-de',
    proxy: { server: 'http://proxy.local:3128', bypass: ['<local>', '*.corp'] }, stealth: 'stealth',
    extraArgs: ['--disable-features=Foo,Translate', '--enable-features=Bar', '--screen-info={1280x800}'], startUrl: 'https://example.test/',
  });
  assert.ok(!headed.some((a) => a.startsWith('--headless')));
  assert.equal(headed.filter((a) => /^--screen-info/.test(a)).length, 1, 'headed: only the caller\'s own --screen-info');
  assert.ok(headed.includes('--window-size=1280,800'));
  assert.ok(headed.includes('--lang=de-DE'));
  assert.ok(headed.includes('--proxy-server=http://proxy.local:3128'));
  assert.ok(headed.includes('--proxy-bypass-list=<local>;*.corp'));
  assert.ok(headed.includes('--enable-features=Bar'));
  assert.ok(headed.includes('--screen-info={1280x800}'));
  assert.equal(headed.filter((a) => a.startsWith('--disable-features=')).length, 1, 'Chrome only honours the last --disable-features, so they are merged');
  assert.ok(headed.includes('--disable-features=CalculateNativeWinOcclusion,Translate,MediaRouter,GlobalMediaControls,PaintHolding,HttpsUpgrades,AutoDeElevate,OptimizationHints,msImplicitSignin,Foo'));
  assert.ok(headed.includes('--disable-sync'), 'the sign-in guards apply headed too (warm windows included)');
  assert.equal(headed[headed.length - 1], 'https://example.test/');
  for (const a of [...args, ...headed]) {
    assert.ok(!/^--enable-automation|^--remote-debugging-port/.test(a), a);
  }
  // Decision D-a: stealth (and only stealth) carries the one switch that clears navigator.webdriver.
  assert.ok(!args.some((a) => /AutomationControlled/.test(a)), 'off: webdriver stays true (the truth)');
  assert.deepEqual(headed.filter((a) => /AutomationControlled/.test(a)), ['--disable-blink-features=AutomationControlled']);
  assert.ok(!launch.buildArgs({ profileDir: dir, stealth: 'human' }).some((a) => /AutomationControlled/.test(a)));
  assert.equal(launch.buildArgs({ profileDir: dir, startUrl: null }).at(-1).startsWith('--'), true);
  // Stealth suite, round 3: --disable-component-update kept Widevine out of every launched Edge/Chrome
  // (9/9) — a classic automation tell. Left out at stealth and when warming; kept below stealth.
  assert.ok(!headed.includes('--disable-component-update'), 'stealth: components (Widevine) may update');
  assert.ok(args.includes('--disable-component-update'), 'off: the environment stays fixed');
  assert.ok(launch.buildArgs({ profileDir: dir, stealth: 'human' }).includes('--disable-component-update'), 'human: likewise');
  assert.ok(!launch.buildArgs({ profileDir: dir, componentUpdate: true }).includes('--disable-component-update'), 'a warm launch may update');
  assert.ok(launch.buildArgs({ profileDir: dir, stealth: 'stealth', componentUpdate: false }).includes('--disable-component-update'), 'an explicit false wins');
  assert.equal(launch.buildArgs({ profileDir: dir, stealth: 'stealth', extraArgs: ['--disable-component-update'] }).filter((a) => a === '--disable-component-update').length, 1,
    'a caller who asks for it at stealth gets it, once');
  assert.equal(launch.buildArgs({ profileDir: dir, extraArgs: ['--disable-component-update'] }).filter((a) => a === '--disable-component-update').length, 1,
    'below stealth it is not duplicated');
});

test('launch: switches that identify automation or bypass an option are refused by name', () => {
  const dir = path.join(TEMP_ROOT, 'p');
  const refused = [
    ['--enable-automation', /navigator\.webdriver/],
    ['--remote-debugging-port=9222', /debugging port/],
    ['--remote-debugging-address=0.0.0.0', /no debugging port/],
    ['--disable-blink-features=AutomationControlled', /only stealth "stealth" does \(decision D-a/],
    ['--user-data-dir=C:\\x', /profileDir option/],
    ['--headless', /headless option/],
    ['--window-size=10,10', /windowSize option/],
    ['--lang=fr', /lang option/],
    ['--proxy-server=x:1', /proxy option/],
    ['--remote-debugging-pipe', /always passes it/],
  ];
  for (const [arg, why] of refused) {
    assert.throws(() => launch.buildArgs({ profileDir: dir, extraArgs: [arg] }), (err) => err.message.includes(`"${arg}"`) && why.test(err.message), arg);
  }
  assert.throws(() => launch.buildArgs({ profileDir: dir, extraArgs: ['https://x.test'] }), /only carry switches/);
  assert.throws(() => launch.buildArgs({ profileDir: dir, windowSize: { width: 50, height: 600 } }), /Invalid windowSize/);
  assert.throws(() => launch.buildArgs({ profileDir: dir, lang: 'not a tag!' }), /Invalid lang/);
  assert.throws(() => launch.buildArgs({ profileDir: dir, extraArgs: ['--enable-features=Translate'] }), /both enabled and disabled: Translate/);
  assert.throws(() => launch.buildArgs({ profileDir: dir, stealth: 'max' }), /Unknown stealth level/);
  assert.throws(() => launch.buildArgs({ profileDir: dir, stealth: 'human', extraArgs: ['--disable-blink-features=Foo,AutomationControlled'] }), /at stealth "human"/);
  assert.throws(() => launch.buildArgs({ profileDir: dir, stealth: 'stealth', extraArgs: ['--enable-automation'] }), /never identifies as automation/, '--enable-automation is refused at every level');
  assert.equal(launch.parseProduct('HeadlessChrome/153.0.8010.52'), '153.0.8010.52');
  assert.equal(launch.parseProduct('Edg/153.0.4234.32'), '153.0.4234.32');
});

test('launch: stealth merges --disable-blink-features into one switch; the headless screen follows the window (decision D-a)', () => {
  const dir = path.join(TEMP_ROOT, 'p');
  // At stealth a caller's own copy of the switch is accepted and merged, never a second (last-wins) copy.
  const s = launch.buildArgs({ profileDir: dir, stealth: 'stealth', extraArgs: ['--Disable-Blink-Features=automationcontrolled,Foo', '--disable-blink-features=Bar'] });
  assert.deepEqual(s.filter((a) => /^--disable-blink-features=/i.test(a)), ['--disable-blink-features=AutomationControlled,Foo,Bar']);
  assert.throws(() => launch.buildArgs({ profileDir: dir, stealth: 'stealth', extraArgs: ['--enable-blink-features=AutomationControlled'] }), /Blink features both enabled and disabled: AutomationControlled/);
  // Other blink features are no concern of the level check.
  assert.deepEqual(launch.buildArgs({ profileDir: dir, extraArgs: ['--disable-blink-features=Foo'] }).filter((a) => /blink/.test(a)), ['--disable-blink-features=Foo']);
  // Headless at every level: the SCREEN is the windowSize, with a taskbar work area at its
  // bottom, and the window fills the work area (a maximized window). Live round 2: without a
  // work area, availHeight === height in 30/30 headless runs — no Windows desktop reports that.
  const taskbar = launch.HEADLESS_TASKBAR;
  const screen1366 = taskbar ? `--screen-info={1366x768 workAreaBottom=${taskbar}}` : '--screen-info={1366x768}';
  for (const stealthLevel of ['off', 'human', 'stealth']) {
    const a = launch.buildArgs({ profileDir: dir, stealth: stealthLevel, windowSize: { width: 1366, height: 768 } });
    assert.deepEqual(a.filter((x) => /^--screen-info/.test(x)), [screen1366], stealthLevel);
    assert.equal(a.indexOf(screen1366), a.indexOf(`--window-size=1366,${768 - taskbar}`) + 1);
  }
  if (process.platform === 'win32') assert.equal(taskbar, 48, 'the Windows 11 taskbar at 100 % (headed availHeight 1032 on a 1080 screen, measured)');
  assert.equal(launch.screenInfoSwitch({ width: 800, height: 600 }), '--screen-info={800x600}');
  assert.equal(launch.screenInfoSwitch({ width: 1920, height: 1080 }, { workAreaBottom: 48 }), '--screen-info={1920x1080 workAreaBottom=48}', 'the syntax measured on Edge and CfT 153');
  assert.deepEqual(launch.headlessGeometry({ width: 1920, height: 1080 }), { screen: { width: 1920, height: 1080 }, window: { width: 1920, height: 1080 - taskbar }, workAreaBottom: taskbar });
  assert.equal(launch.headlessGeometry({ width: 400, height: 120 }).workAreaBottom, 0, 'a size too small to lose a taskbar keeps no work area');
  // The caller's own --screen-info wins (one copy only), and then the window is exactly windowSize; headed gets none of ours.
  const own = launch.buildArgs({ profileDir: dir, extraArgs: ['--screen-info={2560x1440}'] });
  assert.deepEqual(own.filter((x) => /^--screen-info/.test(x)), ['--screen-info={2560x1440}']);
  assert.ok(own.includes('--window-size=1920,1080'));
  assert.ok(!launch.buildArgs({ profileDir: dir, headless: false }).some((x) => /^--screen-info/.test(x)));
  assert.ok(launch.buildArgs({ profileDir: dir, headless: false }).includes('--window-size=1920,1080'), 'headed: the window is windowSize');
  // A fixed switch passed again (a harness adding --disable-sync) is not doubled.
  assert.equal(launch.buildArgs({ profileDir: dir, extraArgs: ['--disable-sync', '--Disable-Sync'] }).filter((x) => /^--disable-sync$/i.test(x)).length, 1);
});

test('launch: Chrome for Testing (and only CfT) gets --disable-frame-rate-limit — its renderer runs at 10 Hz', () => {
  // Live round 2, and again in an interleaved A/B on 2026-09-23 (4 rounds of CfT+switch / CfT /
  // Edge, back to back, fresh profiles): CfT rAF 100.5 ms and press hold 1.4–3.1 ms without the
  // switch, 17.4 ms and 25.7–59.3 ms with it; Edge 10.5 ms and 106–108 ms. See KIND_SWITCHES.
  const dir = path.join(TEMP_ROOT, 'p');
  assert.deepEqual(launch.KIND_SWITCHES.cft, ['--disable-frame-rate-limit']);
  const cft = launch.buildArgs({ profileDir: dir, kind: 'cft' });
  assert.equal(cft.filter((a) => a === '--disable-frame-rate-limit').length, 1);
  assert.ok(cft.indexOf('--disable-frame-rate-limit') < cft.findIndex((a) => a.startsWith('--disable-features=')), 'with the fixed switches, before the feature lists');
  for (const kind of ['edge', 'chrome', null]) {
    assert.ok(!launch.buildArgs({ profileDir: dir, kind }).includes('--disable-frame-rate-limit'), `${kind}: measured 10.5 ms frames without it; with it they drop to 17.4 ms`);
  }
  assert.equal(launch.buildArgs({ profileDir: dir, kind: 'cft', extraArgs: ['--disable-frame-rate-limit'] }).filter((a) => a === '--disable-frame-rate-limit').length, 1, 'not doubled');
});

test('launch: refusals ignore case (Windows Chromium lowercases switch names); "--", switch-like start URLs, JSON nulls', () => {
  const dir = path.join(TEMP_ROOT, 'p');
  for (const arg of ['--ENABLE-AUTOMATION', '--Remote-Debugging-Port=9222', '--User-Data-Dir=C:\\x', '--HEADLESS=new', '--remote-debugging-io-pipes=5,6', '--Disable-Blink-Features=automationcontrolled']) {
    assert.throws(() => launch.buildArgs({ profileDir: dir, extraArgs: [arg] }), (err) => err.message.includes(`"${arg}"`), arg);
  }
  // "--Disable-Features=Foo" is the same switch to Chromium on Windows: merged, never a second (last-wins) copy.
  const merged = launch.buildArgs({ profileDir: dir, extraArgs: ['--Disable-Features=Foo', '--ENABLE-FEATURES=Bar'] });
  assert.equal(merged.filter((a) => /^--disable-features=/i.test(a)).length, 1);
  assert.ok(merged.includes(`--disable-features=${launch.DISABLED_FEATURES.join(',')},Foo`));
  assert.ok(merged.includes('--enable-features=Bar'));
  assert.throws(() => launch.buildArgs({ profileDir: dir, extraArgs: ['--'] }), /ends Chromium's switch parsing/);
  for (const bad of ['--enable-automation', '-remote-debugging-port=1', '/enable-automation', 'example.test']) {
    assert.throws(() => launch.buildArgs({ profileDir: dir, startUrl: bad }), /Invalid startUrl/, bad);
  }
  for (const ok of ['about:blank', 'data:text/html,x', 'https://example.test/a?b', 'file:///C:/x.html']) {
    assert.equal(launch.buildArgs({ profileDir: dir, startUrl: ok }).at(-1), ok);
  }
  // Options from JSON: null means the default — above all, a null `headless` is NOT a headed window.
  assert.deepEqual(launch.buildArgs({ profileDir: dir, headless: null, windowSize: null, extraArgs: null, stealth: null }), launch.buildArgs({ profileDir: dir }));
  assert.throws(() => launch.buildArgs({ profileDir: dir, extraArgs: '--foo' }), /extraArgs must be an array/);
});

test('launch: the leftover sweep matches a profile dir exactly, never a sibling profile', () => {
  const uses = launch.commandLineUsesProfile;
  const exe = '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"';
  const qa = path.join(TEMP_ROOT, 'profiles', 'qa');
  assert.equal(uses(`${exe} --type=renderer --user-data-dir=${qa} --lang=en`, qa), true);
  assert.equal(uses(`${exe} --type=renderer --user-data-dir="${qa}" --lang=en`, qa), true, 'Chromium quotes the value');
  assert.equal(uses(`${exe} --remote-debugging-pipe "--user-data-dir=${qa}" --headless=new`, qa), true, 'Node quotes the whole argument');
  assert.equal(uses(`${exe} --user-data-dir=${qa}`, qa), true, 'at the end of the line');
  assert.equal(uses(`${exe} --user-data-dir=${qa}${path.sep} --x`, qa), true, 'with a trailing separator');
  assert.equal(uses(`${exe} --type=renderer --user-data-dir=${qa}-2 --lang=en`, qa), false, '"qa" is a prefix of "qa-2": another engine');
  assert.equal(uses(`${exe} --user-data-dir="${qa}-2"`, qa), false);
  assert.equal(uses(`${exe} --user-data-dir=${path.join(qa, 'Default')}`, qa), false);
  assert.equal(uses(`${exe} --log-file=${qa} --x`, qa), false, 'only the --user-data-dir value counts');
  assert.equal(uses('', qa), false);
  if (process.platform === 'win32') assert.equal(uses(`${exe} --user-data-dir=${qa.toUpperCase()} --x`, qa), true, 'Windows paths compare case-insensitively');
  const spaced = path.join(TEMP_ROOT, 'my profiles', 'qa');
  assert.equal(uses(`${exe} --user-data-dir="${spaced}" --x`, spaced), true);
  assert.equal(uses(`${exe} "--user-data-dir=${spaced}" --x`, spaced), true);
  assert.equal(uses(`${exe} "--user-data-dir=${spaced} 2" --x`, spaced), false);
});

test('launch: a browser\'s default user-data directory is refused before anything starts', async () => {
  if (!EDGE) skip('needs a browser to resolve');
  const [edgeDefault] = find.defaultUserDataDirs();
  await assert.rejects(launch.launchBrowser({ browser: EDGE, profileDir: edgeDefault }), /default user-data directory/);
  await assert.rejects(launch.launchBrowser({ browser: EDGE, profileDir: path.join(edgeDefault, 'Profile 9') }), /default user-data directory/);
});

test('launch: a process that is not a browser fails fast with its exit code and output', async () => {
  // node.exe rejects --remote-debugging-pipe as a bad option and exits: the error must say so
  // instead of waiting 30 s for a Browser.getVersion reply.
  const t = Date.now();
  await assert.rejects(
    launch.launchBrowser({ browser: { kind: 'chrome', path: process.execPath, version: 'node' }, timeoutMs: 20_000 }),
    (err) => /did not become ready/.test(err.message) && /exited \(code \d+\)/.test(err.message) && /bad option|remote-debugging-pipe/.test(err.message),
  );
  assert.ok(Date.now() - t < 15_000, 'must not wait out the ready timeout');
});

test('launch: a file that is not an executable fails clearly and leaves no temporary profile', async () => {
  const tempDirs = async () => (await readdir(os.tmpdir())).filter((n) => /^g9-engine-(?!unit-)/.test(n)).sort();
  const before = await tempDirs();
  const fake = path.join(TEMP_ROOT, 'fake-browser.exe');
  await writeFile(fake, 'not an executable');
  await assert.rejects(
    launch.launchBrowser({ browser: { kind: 'chrome', path: fake, version: 'x' } }),
    /Could not start chrome x .*fake-browser\.exe|did not become ready/,
  );
  assert.deepEqual(await tempDirs(), before);
});

// ─── profiles ────────────────────────────────────────────────────────────────────────────────

test('profile: names, ensure/list/meta, dotted preference merge, remove', async () => {
  for (const bad of ['', '../x', 'a/b', 'CON', 'con.txt', '.hidden', 'x'.repeat(65), 'trail.']) {
    assert.throws(() => profile.validateName(bad), /Invalid profile name/, bad);
  }
  const created = await profile.ensure('qa-1', { locale: 'de-DE', timezone: 'Europe/Berlin', notes: 'unit' });
  assert.equal(created.created, true);
  assert.equal(created.dir, path.join(HOME, 'profiles', 'qa-1'));
  assert.equal(created.meta.warmedAt, null);
  assert.ok(Date.parse(created.meta.createdAt));
  const again = await profile.ensure('qa-1');
  assert.equal(again.created, false);
  assert.equal(again.meta.locale, 'de-DE');
  const onDisk = JSON.parse(await readFile(path.join(HOME, 'profiles', 'qa-1.json'), 'utf8'));
  assert.deepEqual(Object.keys(onDisk).sort(), ['createdAt', 'locale', 'name', 'notes', 'timezone', 'warmedAt']);

  const merged = await profile.applyPreferences('qa-1', {
    'intl.accept_languages': 'de-DE,de',
    download: { prompt_for_download: false },
    'profile.default_content_setting_values.notifications': 2,
  });
  assert.equal(merged.intl.accept_languages, 'de-DE,de');
  const merged2 = await profile.applyPreferences('qa-1', { 'download.default_directory': 'D:\\dl', spellcheck: { dictionaries: ['de-DE'] } });
  assert.deepEqual(merged2.download, { prompt_for_download: false, default_directory: 'D:\\dl' });
  assert.equal(merged2.profile.default_content_setting_values.notifications, 2);
  assert.deepEqual(merged2.spellcheck.dictionaries, ['de-DE']);
  assert.deepEqual(await profile.readPreferences('qa-1'), merged2);
  await assert.rejects(profile.applyPreferences('ghost', {}), /does not exist/);

  const rows = await profile.list();
  assert.deepEqual(rows.map((r) => [r.name, r.inUse]), [['qa-1', false]]);
  const meta = await profile.updateMeta('qa-1', { notes: 'changed' });
  assert.equal(meta.notes, 'changed');
  assert.equal(meta.locale, 'de-DE');
  // The manager's consistency check reads Accept-Language from the metadata: applyPreferences keeps it there.
  assert.equal((await profile.ensure('qa-1')).meta.acceptLanguage, 'de-DE,de');
  await profile.remove('qa-1');
  assert.equal(existsSync(path.join(HOME, 'profiles', 'qa-1')), false);
  assert.equal(existsSync(path.join(HOME, 'profiles', 'qa-1.json')), false);
  assert.deepEqual(await profile.list(), []);
  // What a crashed remove() leaves behind looks like a valid name but is never listed as a profile.
  await mkdir(path.join(HOME, 'profiles', `qa-9.removing-${process.pid}-${Date.now()}`), { recursive: true });
  assert.deepEqual(await profile.list(), []);
  assert.deepEqual(await profile.profileInUse(path.join(TEMP_ROOT, 'never-used')), { inUse: false, how: process.platform === 'win32' ? 'no lockfile' : 'no SingletonLock' });
});

test('profile: signInState — a browser account in Local State or Preferences is seen, and no identity is returned', async () => {
  // Live round 2: Edge signed new profiles into the Windows account (Local State info_cache
  // user_name / gaia_id / edge_account_cid, Preferences account_info). The manager refuses such a
  // profile at stealth and warns otherwise; this is what it reads.
  const { dir } = await profile.ensure('signin-1');
  assert.deepEqual(await profile.signInState('signin-1'), { signedIn: false, profiles: [], accountInfo: 0, checked: [] }, 'a profile that never ran');
  await writeFile(path.join(dir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1', user_name: '', gaia_id: '' } } } }));
  let s = await profile.signInState('signin-1');
  assert.equal(s.signedIn, false, 'empty identity fields are not an account');
  assert.deepEqual(s.checked, ['Local State']);
  await writeFile(path.join(dir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: {
    user_name: 'someone@live.example', gaia_id: '0001', edge_account_cid: 'abc', edge_account_type: 1, is_consented_primary_account: true,
  } } } }));
  s = await profile.signInState('signin-1');
  assert.equal(s.signedIn, true);
  assert.deepEqual(s.profiles, [{ key: 'Default', userName: true, gaiaId: true, edgeAccount: true, accountType: 1, consentedPrimary: true }]);
  assert.ok(!JSON.stringify(s).includes('someone@live.example'), 'the account name never leaves the function');
  // Preferences alone (account_info) is enough.
  await rm(path.join(dir, 'Local State'));
  await mkdir(path.join(dir, 'Default'), { recursive: true });
  await writeFile(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ account_info: [{ email: 'x@y.example' }] }));
  s = await profile.signInState('signin-1');
  assert.equal(s.signedIn, true);
  assert.equal(s.accountInfo, 1);
  assert.ok(!JSON.stringify(s).includes('x@y.example'));
  // Also by directory (a temp profile), with nothing there.
  assert.equal((await profile.signInState(null, { dir: path.join(TEMP_ROOT, 'nothing-here') })).signedIn, false);
  await profile.remove('signin-1');
});

test('profile: clearSessionRestore removes the previous run\'s session files (and only those), never while in use', async () => {
  // Live round 2: Chrome for Testing reopened the previous run's tabs on every relaunch of a reused
  // profile, and a restored tab sat in front of the agent's in 4/5 runs.
  const { dir } = await profile.ensure('restore-1');
  const def = path.join(dir, 'Default');
  await mkdir(path.join(def, 'Sessions'), { recursive: true });
  await writeFile(path.join(def, 'Sessions', 'Session_13300000000000001'), 'x');
  await writeFile(path.join(def, 'Sessions', 'Tabs_13300000000000001'), 'x');
  await writeFile(path.join(def, 'Current Tabs'), 'x');
  await writeFile(path.join(def, 'Cookies'), 'keep me');
  await writeFile(path.join(def, 'Preferences'), '{}');
  const out = await profile.clearSessionRestore('restore-1');
  assert.deepEqual(out.removed.sort(), ['Current Tabs', 'Sessions']);
  assert.equal(existsSync(path.join(def, 'Sessions')), false);
  assert.equal(await readFile(path.join(def, 'Cookies'), 'utf8'), 'keep me', 'cookies — the warmed login — stay');
  assert.ok(existsSync(path.join(def, 'Preferences')));
  assert.deepEqual((await profile.clearSessionRestore('restore-1')).removed, [], 'nothing left to remove');
  // (While a browser holds the profile, clearSessionRestore refuses like applyPreferences does:
  // profileInUse's lockfile test — Node cannot hold a lockfile with Chromium's share mode, so the
  // refusal is exercised live, by the manager, not here.)
  await new Promise((r) => setTimeout(r, 200));
  await profile.remove('restore-1').catch(() => {});
});

test('manager: a locale becomes the profile\'s languages in Chrome\'s own shape (acceptLanguagesFor)', async () => {
  // Live round 2: locale de-DE changed Intl only; navigator.languages and Accept-Language stayed
  // en-US because they come from intl.accept_languages, which the manager now writes.
  const { acceptLanguagesFor } = await import('../../engine/manager.js');
  assert.equal(acceptLanguagesFor('de-DE'), 'de-DE,de');
  assert.equal(acceptLanguagesFor('de-de'), 'de-DE,de', 'canonicalised');
  assert.equal(acceptLanguagesFor('fa-IR'), 'fa-IR,fa');
  assert.equal(acceptLanguagesFor('de'), 'de');
  assert.equal(acceptLanguagesFor('zh-Hant-TW'), 'zh-Hant-TW,zh');
  assert.equal(acceptLanguagesFor('not a tag!'), null);
  assert.deepEqual(stealth.checkConsistency({ locale: 'de-DE', timezone: 'Europe/Berlin', acceptLanguage: acceptLanguagesFor('de-DE') }), [], 'what the manager writes passes its own check');
});

test('profile: warm() reports a crashed or killed browser as NOT warmed (fake launcher, no browser)', async () => {
  const calls = [];
  const fakeLaunch = (exit) => async (opts) => {
    calls.push(opts);
    return {
      pid: 1, argv: ['browser.exe'], browser: { kind: 'edge', version: '153.0.0.0' },
      exited: Promise.resolve(exit), close: async () => ({}),
    };
  };
  const crashed = await profile.warm('qa-warm', 'https://login.example.test/', { launch: fakeLaunch({ code: -1073741819, signal: null }) });
  assert.equal(crashed.warmed, false);
  assert.match(crashed.reason, /exit code -1073741819.*warm the profile again/);
  assert.equal(calls[0].headless, false, 'a real warm is headed');
  assert.equal(calls[0].startUrl, 'https://login.example.test/');
  assert.equal(calls[0].componentUpdate, true, 'warming lets the browser fetch its components (Widevine) — stealth suite, round 3');
  // Engine review, 2026-09-22: the sign-in window reported navigator.webdriver === true (the pipe
  // turns AutomationControlled on below stealth). A person drives it, so it launches at stealth.
  assert.equal(calls[0].stealth, 'stealth', 'the warm window clears navigator.webdriver like a stealth run');
  const killed = await profile.warm('qa-warm', null, { launch: fakeLaunch({ code: null, signal: 'SIGKILL' }) });
  assert.equal(killed.warmed, false);
  assert.match(killed.reason, /signal SIGKILL/);
  assert.equal((await profile.ensure('qa-warm')).meta.warmedAt, null, 'nothing was stamped');
  const fine = await profile.warm('qa-warm', null, { launch: fakeLaunch({ code: 0, signal: null }) });
  assert.equal(fine.warmed, true);
  assert.equal((await profile.ensure('qa-warm')).meta.warmedAt, fine.warmedAt);
  await profile.remove('qa-warm');
});

// ─── firewall (offline) ──────────────────────────────────────────────────────────────────────

test('firewall: the first CfT launch from a path gives the one-time Firewall warning; the same path never again', async () => {
  const home = path.join(TEMP_ROOT, 'fw-home');
  const exe = path.join(home, 'engines', 'cft-153.0.8010.52', 'chrome-win64', 'chrome.exe');
  const file = firewall.firewallSeenPath(home);
  assert.equal(file, path.join(home, 'engines', 'firewall-seen.json'));
  assert.deepEqual(await firewall.readFirewallSeen(home), { version: 1, paths: {} }, 'no file: nothing seen');

  const first = await firewall.noteFirewallLaunch({ home, exePath: exe, kind: 'cft', platform: 'win32', now: new Date('2026-09-22T10:00:00Z') });
  assert.equal(first.first, true);
  assert.equal(first.tracked, true);
  assert.equal(first.warning, firewall.firewallWarning(exe));
  assert.ok(first.warning.includes(exe), 'names the chrome.exe it is about');
  assert.match(first.warning, /one-time Windows Defender Firewall prompt/);
  assert.match(first.warning, /Allow or Cancel does not affect G9BrowserAgent/);
  assert.match(first.warning, /inbound connections only/);

  const doc = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.paths[firewall.firewallKey(exe, 'win32')], { path: exe, kind: 'cft', firstLaunchAt: '2026-09-22T10:00:00.000Z' });

  // The same exe, spelled differently (case, forward slashes): Windows paths are case-insensitive.
  const again = await firewall.noteFirewallLaunch({ home, exePath: exe.toUpperCase().replace(/\\/g, '/'), kind: 'cft', platform: 'win32' });
  assert.deepEqual(again, { warning: null, first: false, tracked: true });
  // A new version is a new path, and Windows asks again.
  const other = path.join(home, 'engines', 'cft-154.0.1.2', 'chrome-win64', 'chrome.exe');
  assert.ok((await firewall.noteFirewallLaunch({ home, exePath: other, kind: 'cft', platform: 'win32' })).warning);
  assert.equal(Object.keys((await firewall.readFirewallSeen(home)).paths).length, 2, 'both paths kept');
  assert.equal((await firewall.noteFirewallLaunch({ home, exePath: other, kind: 'cft', platform: 'win32' })).warning, null);
  assert.deepEqual((await readdir(path.dirname(file))).filter((n) => n.includes('.tmp-')), [], 'no temp file left behind');
});

test('firewall: installed Edge/Chrome and other platforms are not tracked; a damaged or unwritable file never fails a launch', async () => {
  const home = path.join(TEMP_ROOT, 'fw-home-2');
  const exe = path.join(home, 'engines', 'cft-153.0.8010.52', 'chrome-win64', 'chrome.exe');
  for (const kind of ['edge', 'chrome']) {
    assert.deepEqual(await firewall.noteFirewallLaunch({ home, exePath: `C:\\Program Files\\${kind}\\app.exe`, kind, platform: 'win32' }),
      { warning: null, first: false, tracked: false }, `${kind}: its installer registers its own firewall rule`);
  }
  assert.deepEqual(await firewall.noteFirewallLaunch({ home, exePath: '/opt/cft/chrome', kind: 'cft', platform: 'linux' }),
    { warning: null, first: false, tracked: false }, 'Windows only');
  assert.equal(existsSync(firewall.firewallSeenPath(home)), false, 'nothing written for them');

  // A damaged file counts as empty: one warning too many, then a good file again.
  await mkdir(path.dirname(firewall.firewallSeenPath(home)), { recursive: true });
  await writeFile(firewall.firewallSeenPath(home), '{ not json', 'utf8');
  const r = await firewall.noteFirewallLaunch({ home, exePath: exe, kind: 'cft', platform: 'win32' });
  assert.ok(r.warning);
  assert.equal(r.tracked, true);
  assert.ok(JSON.parse(await readFile(firewall.firewallSeenPath(home), 'utf8')).paths[firewall.firewallKey(exe, 'win32')]);

  // A G9_HOME where engines/ cannot be created (a file is in the way): the warning is still given.
  const blocked = path.join(TEMP_ROOT, 'fw-home-blocked');
  await writeFile(blocked, 'not a directory', 'utf8');
  const b = await firewall.noteFirewallLaunch({ home: blocked, exePath: exe, kind: 'cft', platform: 'win32' });
  assert.equal(b.first, true);
  assert.equal(b.tracked, false);
  assert.ok(b.warning, 'not tracked, so said again next time rather than never');
});

test('firewall: two engines started together from one new path give one warning, not two', async () => {
  const home = path.join(TEMP_ROOT, 'fw-home-3');
  const exe = path.join(home, 'engines', 'cft-153.0.8010.52', 'chrome-win64', 'chrome.exe');
  const results = await Promise.all([1, 2, 3].map(() => firewall.noteFirewallLaunch({ home, exePath: exe, kind: 'cft', platform: 'win32' })));
  assert.equal(results.filter((x) => x.warning).length, 1);
  assert.equal(Object.keys((await firewall.readFirewallSeen(home)).paths).length, 1);
});

// ─── cft (offline) ───────────────────────────────────────────────────────────────────────────

test('cft: the pin names the current Stable win64 build with its size and sha256', () => {
  const pin = cft.pinned();
  assert.match(pin.version, /^\d+\.\d+\.\d+\.\d+$/);
  assert.equal(pin.platform, 'win64');
  assert.match(pin.sha256 ?? '', /^[0-9a-f]{64}$/, 'versions.json must pin a sha256 for win64');
  assert.ok(Number.isInteger(pin.size) && pin.size > 50 * 1024 * 1024, 'and its size');
  assert.equal(pin.url, `https://storage.googleapis.com/chrome-for-testing-public/${pin.version}/win64/chrome-win64.zip`);
  assert.equal(cft.exeRelativePath('win64'), path.join('chrome-win64', 'chrome.exe'));
});

const ZIP_ENTRIES = [
  { name: 'chrome-win64/', data: null },
  { name: 'chrome-win64/chrome.exe', data: Buffer.from('not really chrome'), method: 0 },
  { name: 'chrome-win64/resources/big.pak', data: Buffer.from('x'.repeat(200_000) + crypto.randomBytes(2000).toString('hex')), method: 8 },
  { name: 'chrome-win64/locales/fa.pak', data: Buffer.from('سلام', 'utf8'), method: 8 },
  { name: 'chrome-win64/empty.txt', data: Buffer.alloc(0), method: 0 },
];

async function assertExtracted(dir) {
  for (const e of ZIP_ENTRIES) {
    if (!e.data) continue;
    const got = await readFile(path.join(dir, ...e.name.split('/')));
    assert.ok(got.equals(e.data), `${e.name} extracted intact`);
  }
}

test('cft: the pure-JS zip reader extracts stored + deflate entries and verifies CRCs', async () => {
  const zipPath = path.join(TEMP_ROOT, 'a.zip');
  await writeFile(zipPath, makeZip(ZIP_ENTRIES));
  const list = await cft.listZip(zipPath);
  assert.deepEqual(list.map((e) => [e.name, e.method, e.isDir]), ZIP_ENTRIES.map((e) => [e.name, e.method ?? 0, !e.data]));
  const out = path.join(TEMP_ROOT, 'js-out');
  const res = await cft.extractZipJs(zipPath, out);
  assert.equal(res.files, 4);
  await assertExtracted(out);

  const bad = path.join(TEMP_ROOT, 'bad-crc.zip');
  await writeFile(bad, makeZip([{ name: 'f.bin', data: Buffer.from('hello'), method: 8, crc: 12345 }]));
  await assert.rejects(cft.extractZipJs(bad, path.join(TEMP_ROOT, 'bad-out')), /f\.bin: CRC mismatch/);

  const slip = path.join(TEMP_ROOT, 'slip.zip');
  await writeFile(slip, makeZip([{ name: '../evil.txt', data: Buffer.from('x') }]));
  await assert.rejects(cft.extractZipJs(slip, path.join(TEMP_ROOT, 'slip-out')), /unsafe path in zip: \.\.\/evil\.txt/);
  assert.equal(existsSync(path.join(TEMP_ROOT, 'evil.txt')), false);
  await assert.rejects(cft.listZip(path.join(TEMP_ROOT, 'a.zip.nope')), /ENOENT/);
  await writeFile(path.join(TEMP_ROOT, 'not.zip'), 'plain text');
  await assert.rejects(cft.listZip(path.join(TEMP_ROOT, 'not.zip')), /not a zip file/);
  if (process.platform === 'win32') {
    // "a:b" is an NTFS alternate data stream of "a"; "x/c:y" is drive-relative. Neither is a file.
    assert.throws(() => cft.safeEntryPath(TEMP_ROOT, 'chrome-win64/chrome.exe:hidden'), /unsafe path in zip/);
    assert.throws(() => cft.safeEntryPath(TEMP_ROOT, 'x/c:y'), /unsafe path in zip/);
  }
  assert.equal(cft.safeEntryPath(TEMP_ROOT, 'chrome-win64/locales/fa.pak'), path.join(TEMP_ROOT, 'chrome-win64', 'locales', 'fa.pak'));
});

test('cft: the pure-JS CRC-32 (fallback for Node < 22.2) equals zlib, chained or not', () => {
  const a = crypto.randomBytes(100_003);
  const b = crypto.randomBytes(777);
  assert.equal(cft.crc32Js(Buffer.alloc(0)), 0);
  assert.equal(cft.crc32Js(Buffer.from('123456789')), 0xcbf43926, 'the standard check value');
  if (typeof zlib.crc32 === 'function') {
    assert.equal(cft.crc32Js(a), zlib.crc32(a));
    assert.equal(cft.crc32Js(b, cft.crc32Js(a)), zlib.crc32(Buffer.concat([a, b])));
  }
  assert.equal(cft.crc32(b, cft.crc32(a)), cft.crc32Js(Buffer.concat([a, b])));
});

test('cft: the install lock — never steals a lock being written, takes a dead or hung holder\'s, and a heartbeat keeps a live one', async () => {
  const dir = path.join(TEMP_ROOT, 'locks');
  await mkdir(dir, { recursive: true });
  const timing = { heartbeatMs: 50, staleMs: 400, youngEmptyMs: 1500, pollMs: 50 };

  // 1. An EMPTY, young lock is another process between open('wx') and writing its pid: wait.
  const young = path.join(dir, 'young.lock');
  await writeFile(young, '');
  await assert.rejects(cft.acquireLock(young, { waitMs: 300, timing }), /pid unknown\) is still installing/);
  // ... and one that stays empty past youngEmptyMs was abandoned: taken.
  await delay(1300);
  const r1 = await cft.acquireLock(young, { waitMs: 2000, timing });
  assert.equal(JSON.parse(await readFile(young, 'utf8')).pid, process.pid);
  await r1();
  assert.equal(existsSync(young), false);

  // 2. A dead holder's lock is taken at once.
  const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
  const dead = path.join(dir, 'dead.lock');
  await writeFile(dead, JSON.stringify({ pid: deadPid, at: new Date().toISOString() }));
  const t = Date.now();
  await (await cft.acquireLock(dead, { waitMs: 100, timing }))();
  assert.ok(Date.now() - t < 300);

  // 3. A live holder with a running heartbeat is waited for, well past staleMs.
  const live = path.join(dir, 'live.lock');
  const release = await cft.acquireLock(live, { timing });
  await assert.rejects(cft.acquireLock(live, { waitMs: 900, timing }), new RegExp(`pid ${process.pid}\\) is still installing`));
  await release();
  await delay(150);
  assert.equal(existsSync(live), false, 'the heartbeat stops with release() and never recreates the lock');

  // 4. A live pid whose heartbeat stopped long ago is hung: taken.
  const hung = path.join(dir, 'hung.lock');
  await writeFile(hung, JSON.stringify({ pid: process.pid, at: new Date(0).toISOString() }));
  const old = new Date(Date.now() - 10_000);
  await utimes(hung, old, old);
  await (await cft.acquireLock(hung, { waitMs: 200, timing }))();
});

test('cft: what an interrupted install left behind is swept — only entries whose process is gone', async () => {
  // download() and the extraction tree are removed by in-process catch/finally, which a killed
  // process never runs, and the next install uses new pid-based names: 494 MB stayed for good
  // (engine review, 2026-09-22). A live pid's entry is never touched (it may still be writing).
  const home = path.join(TEMP_ROOT, 'sweep-home');
  const engines = path.join(home, 'engines');
  const downloads = path.join(engines, '.download');
  await mkdir(downloads, { recursive: true });
  const dead = 0x7ffffff0; // a pid this machine is not running
  const live = process.pid;
  const tree = async (name) => { await mkdir(path.join(engines, name, 'chrome-win64'), { recursive: true }); await writeFile(path.join(engines, name, 'chrome-win64', 'chrome.exe'), 'x'); };
  await tree(`.cft-153.0.8010.52.tmp-${dead}-abc123`);
  await tree(`.cft-153.0.8010.52.tmp-${live}-def456`);
  await tree(`cft-152.0.0.0.broken-${dead}-1758000000000`);
  await tree(`cft-151.0.0.0.removing-${dead}-1758000000000`);
  await mkdir(path.join(engines, 'cft-153.0.8010.52'), { recursive: true }); // a real install
  await writeFile(path.join(downloads, `chrome-win64-153.0.8010.52-${dead}.zip`), 'partial');
  await writeFile(path.join(downloads, `chrome-win64-153.0.8010.52-${dead}.zip.part-${dead}-aa11bb22`), 'partial');
  await writeFile(path.join(downloads, `chrome-win64-153.0.8010.52-${live}.zip`), 'mine');

  const { removed } = await cft.sweepLeftovers({ home });
  const left = (await readdir(engines)).sort();
  assert.ok(removed.length >= 4, `swept: ${removed.join(', ')}`);
  assert.deepEqual(left, ['.cft-153.0.8010.52.tmp-' + live + '-def456', '.download', 'cft-153.0.8010.52'].sort());
  assert.deepEqual((await readdir(downloads)).sort(), [`chrome-win64-153.0.8010.52-${live}.zip`]);
  // Twice is a no-op, and a home with no engines folder is not an error.
  assert.deepEqual((await cft.sweepLeftovers({ home })).removed, []);
  assert.deepEqual((await cft.sweepLeftovers({ home: path.join(TEMP_ROOT, 'no-such-home') })).removed, []);
});

test('cft: extractZip uses the system tar (System32 bsdtar on Windows) and falls back to JS', async () => {
  const zipPath = path.join(TEMP_ROOT, 'a.zip');
  if (process.platform === 'win32') assert.match(cft.systemTar(), /System32[\\/]tar\.exe$/i);
  const viaTar = path.join(TEMP_ROOT, 'tar-out');
  const r1 = await cft.extractZip(zipPath, viaTar, { expect: 'chrome-win64/chrome.exe' });
  if (process.platform === 'win32') assert.equal(r1.extractor, 'tar');
  await assertExtracted(viaTar);
  const viaJs = path.join(TEMP_ROOT, 'forced-js-out');
  const r2 = await cft.extractZip(zipPath, viaJs, { preferJs: true, expect: 'chrome-win64/chrome.exe' });
  assert.equal(r2.extractor, 'js');
  await assertExtracted(viaJs);
  // A tar that "succeeds" without producing the browser falls back to the JS reader.
  const r3 = await cft.extractZip(zipPath, path.join(TEMP_ROOT, 'expect-out'), { expect: 'chrome-win64/chrome.exe' });
  assert.ok(['tar', 'js'].includes(r3.extractor));
  await assert.rejects(cft.extractZip(zipPath, path.join(TEMP_ROOT, 'missing-out'), { expect: 'chrome-win64/nothere.exe' }), /does not contain/);
});

test('cft: ensure() from a cached zip — verified, installed atomically, logged once, idempotent', async () => {
  const version = '1.2.3.4';
  const cache = path.join(TEMP_ROOT, 'cache');
  await mkdir(cache, { recursive: true });
  const zip = makeZip(ZIP_ENTRIES);
  await writeFile(cft.cachedZipPath(cache, version, 'win64'), zip);
  const phases = [];
  const r = await cft.ensure({ version, platform: 'win64', cacheDir: cache, sha256: sha256(zip), size: zip.length, trigger: 'unit', onProgress: (e) => phases.push(e.phase) });
  assert.equal(r.source, 'cache');
  assert.equal(r.sha256, sha256(zip));
  assert.equal(r.path, path.join(HOME, 'engines', `cft-${version}`, 'chrome-win64', 'chrome.exe'));
  assert.ok(existsSync(r.path));
  assert.ok(phases.includes('verify') && phases.includes('extract') && phases.includes('install') && phases.at(-1) === 'done');
  const marker = JSON.parse(await readFile(path.join(r.dir, '.g9-install.json'), 'utf8'));
  assert.equal(marker.version, version);
  assert.equal(marker.sha256, sha256(zip));
  assert.equal(marker.trigger, 'unit');
  const leftovers = (await readdir(path.join(HOME, 'engines'))).filter((n) => n.includes('.tmp-') || n.endsWith('.lock'));
  assert.deepEqual(leftovers, []);
  const log = (await readFile(path.join(HOME, 'engine-versions.log'), 'utf8')).trim().split('\n');
  assert.equal(log.length, 1);
  const fields = log[0].split('\t');
  assert.ok(Date.parse(fields[0]));
  assert.equal(fields[1], 'install');
  assert.equal(fields[2], `cft ${version}`);
  assert.equal(fields[3], `sha256=${sha256(zip)}`);
  assert.equal(fields[4], 'trigger=unit');

  const again = await cft.ensure({ version, platform: 'win64', cacheDir: cache, trigger: 'unit' });
  assert.equal(again.source, 'installed');
  assert.equal((await readFile(path.join(HOME, 'engine-versions.log'), 'utf8')).trim().split('\n').length, 1, 'no second install line');
  const [same1, same2] = await Promise.all([cft.ensure({ version, platform: 'win64' }), cft.ensure({ version, platform: 'win64' })]);
  assert.equal(same1.path, same2.path);

  const inst = await cft.installed({ platform: 'win64' });
  assert.deepEqual(inst.map((i) => [i.version, i.verified]), [[version, true]]);
  if (process.platform === 'win32') {
    const all = await find.findBrowsers();
    assert.ok(all.some((b) => b.kind === 'cft' && b.version === version), 'findBrowsers lists installed CfT');
    const res = await find.resolveBrowser('cft');
    assert.equal(res.version, version, 'cft resolves to the newest installed build when the pinned one is absent');
  }
  await cft.uninstall(version);
  assert.equal(existsSync(r.dir), false);
  assert.match(await readFile(path.join(HOME, 'engine-versions.log'), 'utf8'), /\tuninstall\tcft 1\.2\.3\.4\t/);
});

test('cft: downloads — progress, resume after a dropped connection, MD5 and sha256 verification', async () => {
  const version = '5.6.7.8';
  const zip = makeZip(ZIP_ENTRIES);
  const etag = '"g1"';
  let mode = 'drop-once';
  let dropped = false;
  let badTotal = false;
  const ranges = [];
  const srv = await localServer((req, res) => {
    if (req.url !== '/chrome-win64.zip') {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end('<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>');
      return;
    }
    const range = req.headers.range;
    const headers = { etag, 'accept-ranges': 'bytes', 'x-goog-hash': [`crc32c=AAAAAA==`, `md5=${mode === 'bad-md5' ? md5b64(Buffer.from('other')) : md5b64(zip)}`] };
    if (range && req.headers['if-range'] === etag) {
      const start = Number(/bytes=(\d+)-/.exec(range)[1]);
      ranges.push(start);
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${zip.length - 1}/${badTotal ? zip.length + 5 : zip.length}`, 'content-length': zip.length - start });
      res.end(zip.subarray(start));
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': zip.length });
    if (mode === 'drop-once' && !dropped) {
      dropped = true;
      res.write(zip.subarray(0, Math.floor(zip.length / 2)), () => setTimeout(() => res.destroy(), 30));
      return;
    }
    res.end(zip);
  });
  try {
    const url = srv.url('/chrome-win64.zip');
    // 1. A connection dropped halfway resumes with Range + If-Range and ends byte-identical.
    const progress = [];
    const dest = path.join(TEMP_ROOT, 'dl', 'z.zip');
    const dl = await cft.download(url, dest, { onProgress: (e) => progress.push(e), version, retries: 3 });
    assert.equal(dl.sha256, sha256(zip));
    assert.equal(dl.size, zip.length);
    assert.equal(dl.resumes, 1);
    assert.equal(ranges.length, 1);
    assert.ok(ranges[0] > 0 && ranges[0] <= zip.length / 2 + 1);
    assert.ok(progress.some((e) => e.retry === 1), 'the retry is reported');
    assert.equal(progress.at(-1).received, zip.length);
    assert.equal(progress.at(-1).total, zip.length);
    assert.ok((await readFile(dest)).equals(zip));
    assert.deepEqual((await readdir(path.dirname(dest))).filter((n) => n.includes('.part-')), []);

    // 1b. The resume answers for a file of another size (no validator could have caught it): the
    // download starts over instead of splicing two files together.
    dropped = false;
    badTotal = true;
    ranges.length = 0;
    const dl2 = await cft.download(url, path.join(TEMP_ROOT, 'dl', 'z2.zip'), { version, retries: 3 });
    badTotal = false;
    assert.equal(ranges.length, 1, 'a resume was attempted');
    assert.equal(dl2.resumes, 0, '... and refused');
    assert.equal(dl2.sha256, sha256(zip));

    // 2. A body whose MD5 differs from the server's x-goog-hash is rejected and deleted.
    mode = 'bad-md5';
    await assert.rejects(cft.download(url, path.join(TEMP_ROOT, 'dl', 'bad.zip'), { retries: 0 }), /is corrupt: MD5/);
    assert.equal(existsSync(path.join(TEMP_ROOT, 'dl', 'bad.zip')), false);
    mode = 'ok';

    // 3. ensure() with the wrong pinned hash: nothing installed, nothing left behind.
    await assert.rejects(
      cft.ensure({ version, platform: 'win64', url, sha256: 'f'.repeat(64), trigger: 'unit' }),
      /failed verification: sha256 [0-9a-f]{64}, expected f{64}.*nothing was installed/s,
    );
    assert.equal(existsSync(cft.installDir(version)), false);
    assert.deepEqual((await readdir(path.join(HOME, 'engines'))).filter((n) => n !== '.download' && !n.startsWith('cft-')), []);
    assert.deepEqual(await readdir(path.join(HOME, 'engines', '.download')).catch(() => []), []);

    // 4. ensure() downloading for real (no cache dir): installed, and the temporary zip deleted.
    const r = await cft.ensure({ version, platform: 'win64', url, sha256: sha256(zip), trigger: 'unit' });
    assert.equal(r.source, 'download');
    assert.ok(existsSync(r.path));
    assert.deepEqual(await readdir(path.join(HOME, 'engines', '.download')), []);
    await cft.uninstall(version);

    // 5. A 404 is not retried (no backoff wait), and says what the server said.
    const t404 = Date.now();
    await assert.rejects(cft.download(srv.url('/missing'), path.join(TEMP_ROOT, 'dl', 'm.zip'), { retries: 5 }), /answered HTTP 404 \("The specified key does not exist\."\)/);
    assert.ok(Date.now() - t404 < 900, 'no retry on a 404');
  } finally {
    await srv.close();
  }
  // Plain http to anything but loopback is refused (the real feed is https).
  await assert.rejects(cft.httpGet('http://example.com/x.zip'), /Refusing plain http/);
});

// ─── live: a real browser ────────────────────────────────────────────────────────────────────

const NO_BROWSER = process.env.G9_UNIT_NO_BROWSER === '1';

test('live: headless Edge over the pipe — version, createTarget, flat attach, evaluate, close, no process left', async () => {
  if (NO_BROWSER) skip('G9_UNIT_NO_BROWSER=1');
  if (!EDGE) skip('Microsoft Edge is not installed here');
  const { dir } = await profile.ensure('unit-live');
  const t0 = Date.now();
  const h = await launch.launchBrowser({ browser: 'edge', profileDir: dir, stealth: 'off' });
  let closed = false;
  try {
    assert.ok(Date.now() - t0 < 30_000);
    assert.equal(h.browser.kind, 'edge');
    assert.equal(h.browser.version, EDGE.version, 'the running product is the version read from the exe');
    assert.match(h.browser.product, /\/\d+\.\d+\.\d+\.\d+$/);
    assert.match(h.browser.userAgent, /Edg\//);
    assert.equal(h.argv[0], EDGE.path);
    assert.deepEqual(h.argv.slice(1), h.args);
    assert.ok(h.args.includes('--remote-debugging-pipe') && h.args.includes('--headless=new'));
    assert.ok(!h.args.some((a) => /enable-automation|remote-debugging-port/.test(a)));
    assert.equal(h.headless, true);
    assert.equal(h.warnings.length, 1, 'off: the one honest webdriver fact (decision D-a)');
    assert.match(h.warnings[0], /navigator\.webdriver is true/);

    // The profile is locked while the browser runs; the lock test must see that.
    assert.equal((await profile.profileInUse(dir)).inUse, true);
    await assert.rejects(profile.applyPreferences('unit-live', { 'intl.accept_languages': 'en' }), /in use by a running browser/);
    await assert.rejects(launch.launchBrowser({ browser: 'edge', profileDir: dir }), /already in use by a running browser/);

    // The leftover sweep finds this browser by its exact profile dir, and nothing for a dir that is
    // only a prefix of it (which would be a sibling profile).
    const procs = await launch.findProfileProcesses(dir);
    assert.ok(procs.some((p) => p.pid === h.pid), `the sweep must find the running browser (pid ${h.pid}); found ${JSON.stringify(procs)}`);
    assert.deepEqual(await launch.findProfileProcesses(dir.slice(0, -2)), [], 'a prefix of the dir names another profile');

    const version = await h.conn.send('Browser.getVersion');
    assert.equal(version.product, h.browser.product);

    const created = [];
    h.conn.on('event', (m, p) => { if (m === 'Target.targetCreated') created.push(p.targetInfo); });
    await h.conn.send('Target.setDiscoverTargets', { discover: true });
    const { targetId } = await h.conn.send('Target.createTarget', { url: 'data:text/html,<title>g9 unit</title><p id=x>hello</p>' });
    const { sessionId } = await h.conn.send('Target.attachToTarget', { targetId, flatten: true });
    assert.ok(sessionId);

    // Events on a page session arrive tagged with that session id.
    const ctx = h.conn.waitForEvent('Runtime.executionContextCreated', { sessionId, timeoutMs: 10_000 });
    await h.conn.send('Runtime.enable', {}, sessionId);
    assert.ok((await ctx).context.id);

    const two = await h.conn.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, sessionId);
    assert.equal(two.result.value, 2);
    const title = await h.conn.send('Runtime.evaluate', { expression: 'document.title + "|" + document.getElementById("x").textContent', returnByValue: true }, sessionId);
    assert.equal(title.result.value, 'g9 unit|hello');
    assert.ok(created.some((t) => t.targetId === targetId && t.type === 'page'));

    const detached = h.conn.waitForEvent('Target.detachedFromTarget', { predicate: (p) => p.sessionId === sessionId, timeoutMs: 10_000 });
    const { success } = await h.conn.send('Target.closeTarget', { targetId });
    assert.equal(success, true);
    await detached;
    await assert.rejects(h.conn.send('Runtime.evaluate', { expression: '1' }, sessionId, { timeoutMs: 5000 }), /session|not found|No target/i);

    const pid = h.pid;
    const res = await h.close();
    closed = true;
    // The graceful budget (GRACEFUL_EXIT_MS) is sized from a measured worst case under load, so a
    // kill here means a browser that ignored Browser.close — not a busy machine. Report the wait.
    assert.equal(res.killed, false, `Browser.close was enough; no kill needed (waited ${res.gracefulMs} ms of ${launch.GRACEFUL_EXIT_MS})`);
    assert.ok(res.exit, 'close() reports how the browser exited, never null once it is gone');
    assert.equal(res.exit.code, 0);
    assert.ok(Number.isFinite(res.gracefulMs) && Number.isFinite(res.closeMs), 'close() reports how long the graceful wait and the whole close took');
    assert.equal(pidAlive(pid), false, `browser pid ${pid} must be gone`);
    assert.deepEqual(await launch.findProfileProcesses(dir), [], 'no process launched with this profile is left');
    assert.equal((await profile.profileInUse(dir)).inUse, false);
    assert.equal(h.conn.closed, true);
    assert.equal(existsSync(dir), true, 'a named profile is kept');
    const again = await h.close();
    assert.equal(again, res, 'close() is idempotent');
  } finally {
    if (!closed) await h.close().catch(() => {});
  }
});

/**
 * Decision D-a, measured rather than assumed: over --remote-debugging-pipe navigator.webdriver is
 * true unless the level is stealth, and a headless screen equals the window at every level.
 */
async function measureEnvironment(browser, stealthLevel, windowSize) {
  const h = await launch.launchBrowser({ browser, stealth: stealthLevel, windowSize });
  try {
    const { targetId } = await h.conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await h.conn.send('Target.attachToTarget', { targetId, flatten: true });
    const { result } = await h.conn.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ webdriver: navigator.webdriver, sw: screen.width, sh: screen.height, aw: screen.availWidth, ah: screen.availHeight, ow: outerWidth, oh: outerHeight })',
      returnByValue: true,
    }, sessionId);
    return { ...JSON.parse(result.value), args: h.args, warnings: h.warnings };
  } finally {
    const pid = h.pid;
    const res = await h.close();
    assert.equal(pidAlive(pid), false, `browser pid ${pid} must be gone`);
    assert.equal(res.profileRemoved, true);
  }
}

test('live: decision D-a — navigator.webdriver is false only at stealth; the headless screen is windowSize, with a taskbar', async () => {
  if (NO_BROWSER) skip('G9_UNIT_NO_BROWSER=1');
  if (!EDGE) skip('Microsoft Edge is not installed here');
  const windowSize = { width: 1366, height: 768 };
  const off = await measureEnvironment('edge', 'off', windowSize);
  assert.equal(off.webdriver, true, 'off: the pipe makes webdriver true, and off tells the truth');
  assert.match(off.warnings[0], /navigator\.webdriver is true/);
  const human = await measureEnvironment('edge', 'human', windowSize);
  assert.equal(human.webdriver, true);
  const st = await measureEnvironment('edge', 'stealth', windowSize);
  assert.equal(st.webdriver, false, `stealth: navigator.webdriver must be false (args: ${st.args.join(' ')})`);
  assert.ok(!st.warnings.some((w) => /webdriver/.test(w)));
  for (const [name, m] of [['off', off], ['human', human], ['stealth', st]]) {
    assert.equal(m.sw, windowSize.width, `${name}: screen.width = windowSize width (${JSON.stringify(m)})`);
    assert.equal(m.sh, windowSize.height, `${name}: screen.height = windowSize height`);
    assert.ok(m.sw >= m.ow, `${name}: the screen is never smaller than the window (${m.sw} < ${m.ow})`);
    // Live round 2: availHeight === height in 30/30 headless runs (no taskbar) — a headless tell.
    assert.equal(m.ah, windowSize.height - launch.HEADLESS_TASKBAR, `${name}: the screen has a work area (availHeight ${m.ah})`);
    assert.ok(m.oh <= m.ah, `${name}: the window fits the work area, as a maximized window does (${m.oh} > ${m.ah})`);
  }
  // Chrome, when installed, measured the same way (the same Blink rule).
  const chrome = (await find.findBrowsers()).find((b) => b.kind === 'chrome');
  if (chrome) {
    const c = await measureEnvironment({ kind: 'chrome', path: chrome.path }, 'stealth', windowSize);
    assert.equal(c.webdriver, false, 'Chrome stealth: webdriver false');
    assert.equal(c.sw, windowSize.width);
    const co = await measureEnvironment({ kind: 'chrome', path: chrome.path }, 'off', windowSize);
    assert.equal(co.webdriver, true, 'Chrome off: webdriver true');
  }
});

test('live: a temporary profile is deleted by close(); the pipe closing alone makes the browser exit', async () => {
  if (NO_BROWSER) skip('G9_UNIT_NO_BROWSER=1');
  if (!EDGE) skip('Microsoft Edge is not installed here');
  const a = await launch.launchBrowser({ browser: 'edge' });
  assert.equal(a.tempProfile, true);
  assert.ok(existsSync(a.profileDir));
  const r = await a.close();
  assert.equal(r.profileRemoved, true);
  assert.equal(existsSync(a.profileDir), false);

  // Orphan protection: if the daemon dies, its pipe closes and the browser goes with it.
  const b = await launch.launchBrowser({ browser: 'edge' });
  try {
    const pid = b.pid;
    b.conn.close('simulated daemon death');
    const exit = await Promise.race([b.exited, delay(20_000).then(() => null)]);
    assert.ok(exit, 'the browser exits by itself when its pipe closes');
    assert.equal(pidAlive(pid), false);
  } finally {
    await b.close();
  }
});

test('live: warm() opens the profile, and stamps warmedAt when the browser exits (headless test mode)', async () => {
  if (NO_BROWSER) skip('G9_UNIT_NO_BROWSER=1');
  if (!EDGE) skip('Microsoft Edge is not installed here');
  let seenUrl = null;
  let webdriver = 'unread';
  const r = await profile.warm('unit-warm', 'data:text/html,<title>login</title>', {
    browser: 'edge',
    headless: true,
    onLaunched: async (h) => {
      const { targetInfos } = await h.conn.send('Target.getTargets');
      const page = targetInfos.find((t) => t.type === 'page');
      seenUrl = page?.url;
      // What the sign-in page itself sees (engine review, 2026-09-22: true before the fix).
      const { sessionId } = await h.conn.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      webdriver = (await h.conn.send('Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true }, sessionId))?.result?.value;
      // What a person closing the window amounts to.
      await h.close();
    },
  });
  assert.equal(seenUrl, 'data:text/html,<title>login</title>', 'the start URL is the first tab');
  assert.equal(webdriver, false, 'the sign-in window does not say it is automated');
  assert.ok(r.argv.includes('--disable-blink-features=AutomationControlled'), 'the webdriver switch is on the warm window');
  assert.equal(r.warmed, true);
  assert.ok(Date.parse(r.warmedAt));
  assert.ok(r.argv.includes('--headless=new'), 'test mode is headless (a real warm is headed: see the buildArgs test)');
  assert.ok(!r.argv.includes('--disable-component-update'), 'a warm launch fetches components (the Widevine CDM)');
  const { meta } = await profile.ensure('unit-warm');
  assert.equal(meta.warmedAt, r.warmedAt);
  assert.match(meta.warmedWith, /^edge \d+\./);

  // An aborted warm is not a login.
  const ac = new AbortController();
  const aborted = await profile.warm('unit-warm', 'about:blank', { browser: 'edge', headless: true, signal: ac.signal, onLaunched: () => ac.abort() });
  assert.equal(aborted.warmed, false);
  assert.equal(aborted.reason, 'aborted');
  assert.equal((await profile.ensure('unit-warm')).meta.warmedAt, r.warmedAt, 'warmedAt unchanged');
});

test('live: the pinned Chrome for Testing (from the local cache) starts headless and reports its version', async () => {
  if (NO_BROWSER) skip('G9_UNIT_NO_BROWSER=1');
  if (process.platform !== 'win32') skip('the pinned build is win64');
  const pin = cft.pinned();
  const cacheDir = process.env.G9_CFT_CACHE || path.join(os.tmpdir(), 'g9-cft-cache');
  const zip = cft.cachedZipPath(cacheDir, pin.version, 'win64');
  let exe;
  if (existsSync(zip)) {
    // The real ensure() path: pinned sha256 check, tar extraction, atomic install — offline.
    const r = await cft.ensure({ cacheDir, trigger: 'unit' });
    assert.equal(r.version, pin.version);
    assert.ok(['cache', 'installed'].includes(r.source));
    assert.equal(r.sha256, pin.sha256);
    exe = r.path;
  } else {
    const installedCopy = path.join(cacheDir, 'engines', `cft-${pin.version}`, 'chrome-win64', 'chrome.exe');
    if (!existsSync(installedCopy)) skip(`no cached Chrome for Testing ${pin.version} in ${cacheDir} (see engine/README.md)`);
    exe = installedCopy;
  }
  assert.equal(await find.exeVersion(exe, { kind: 'cft' }), pin.version);
  const h = await launch.launchBrowser({ browser: { kind: 'cft', path: exe } });
  try {
    assert.equal(h.browser.kind, 'cft');
    // The first launch from this path in this (fresh) G9_HOME carries the one-time Firewall warning.
    assert.equal(h.warnings.filter((w) => /Windows Defender Firewall/.test(w)).length, 1, `first launch from ${exe}: ${JSON.stringify(h.warnings)}`);
    assert.ok((await firewall.readFirewallSeen(HOME)).paths[firewall.firewallKey(exe)], 'the path is recorded in G9_HOME/engines/firewall-seen.json');
    assert.equal(h.browser.version, pin.version);
    // Measured: CfT 153's Browser.getVersion product is "Chrome/<version>" even headless (Edge 153
    // headless says "Edg/…"); the page-visible user agent still says HeadlessChrome.
    assert.match(h.browser.product, new RegExp(`^(Headless)?Chrome/${pin.version.replace(/\./g, '\\.')}$`));
    const { targetId } = await h.conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await h.conn.send('Target.attachToTarget', { targetId, flatten: true });
    const v = await h.conn.send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }, sessionId);
    assert.match(v.result.value, /HeadlessChrome\/\d+/);
    assert.match(h.browser.userAgent, /HeadlessChrome\/\d+/);
  } finally {
    const pid = h.pid;
    await h.close();
    assert.equal(pidAlive(pid), false);
  }
  // Decision D-a on CfT too: webdriver false only at stealth, headless screen = window.
  const cftStealth = await measureEnvironment({ kind: 'cft', path: exe }, 'stealth', { width: 1366, height: 768 });
  assert.equal(cftStealth.webdriver, false, 'CfT stealth: webdriver false');
  assert.equal(cftStealth.sw, 1366);
  assert.equal(cftStealth.sh, 768);
  const cftOff = await measureEnvironment({ kind: 'cft', path: exe }, 'off', { width: 1366, height: 768 });
  assert.equal(cftOff.webdriver, true, 'CfT off: webdriver true');
  for (const later of [cftStealth, cftOff]) {
    assert.ok(!later.warnings.some((w) => /Firewall/.test(w)), 'the Firewall warning is not repeated for the same path');
  }
  if (existsSync(zip)) {
    const auto = await find.resolveBrowser('auto');
    assert.equal(auto.kind, 'cft', "'auto' prefers the pinned CfT once it is installed");
    assert.equal(auto.version, pin.version);
  }
});

// ─── run ─────────────────────────────────────────────────────────────────────────────────────

let failed = false;
const started = Date.now();
for (const t of tests) {
  const t0 = Date.now();
  try {
    await t.fn();
    console.log(`  PASS ${t.name} (${Date.now() - t0} ms)`);
  } catch (err) {
    if (err?.skip) {
      console.log(`  SKIP ${t.name} — ${err.message}`);
      continue;
    }
    console.log(`  FAIL ${t.name}`);
    console.log(err?.stack ?? err);
    failed = true;
    break;
  }
}
await rm(TEMP_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch((err) => {
  console.log(`  (could not remove ${TEMP_ROOT}: ${err.code})`);
});
console.log(`${failed ? 'engine tests FAILED' : 'engine tests passed'} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
