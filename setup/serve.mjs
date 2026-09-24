#!/usr/bin/env node
/**
 * Tiny static server for the test page.
 *
 * Exists so testpage.html runs on a real http:// origin — file:// URLs have a
 * null origin, no cookies, and no fetch, which would make half the test
 * scenarios impossible to reproduce.
 *
 *   node setup/serve.mjs      ->  http://127.0.0.1:5199/
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5199);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ------------------------------------------------ fixtures for engine2-livetest
//
// setup/engine2-livetest.mjs checks what a tool REPORTS against what really
// happened, and the server is the one witness outside the browser: it counts
// every request by path (so "served from the pinned HAR" can be told apart from
// "reached the server"), serves downloads whose bytes are known in advance
// (so a reported sha256 can be compared with the bytes that were sent), and
// echoes the Cookie header a page's request carried (so a cookie, HttpOnly
// included, is proven by the server that received it rather than by the tool
// that set it).

/** Requests seen, by pathname. Read with GET /e2/stats. */
const hits = new Map();
let counter = 0;

/**
 * The bytes of /download/<name>, decided by the name alone so every request —
 * the browser's download and the test's own reference fetch — gets the same:
 * "empty" in the name → 0 bytes; *.pdf → a small PDF-shaped text (magic
 * "%PDF-"); anything else → 192 KiB of seeded pseudo-random bytes.
 */
function downloadBytes(name) {
  if (/empty/i.test(name)) return Buffer.alloc(0);
  if (/\.pdf$/i.test(name)) {
    const lines = ['%PDF-1.4', '%âãÏÓ'];
    for (let i = 0; i < 600; i++) lines.push(`% G9 engine2 fixture ${name} line ${i}`);
    lines.push('%%EOF', '');
    return Buffer.from(lines.join('\n'), 'latin1');
  }
  let seed = 2166136261;
  for (const ch of name) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
  const out = Buffer.alloc(192 * 1024);
  for (let i = 0; i < out.length; i++) {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    out[i] = seed & 0xff;
  }
  return out;
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/testpage.html';
  hits.set(pathname, (hits.get(pathname) ?? 0) + 1);

  // A download with known bytes, as an attachment. ?ms=N streams it in ten
  // slices over N milliseconds (capped at 30 s), for "still in progress".
  if (pathname.startsWith('/download/')) {
    const name = path.basename(pathname.slice('/download/'.length)).replace(/[^\w.-]/g, '_') || 'file.bin';
    const body = downloadBytes(name);
    res.writeHead(200, {
      'content-type': /\.pdf$/i.test(name) ? 'application/pdf' : 'application/octet-stream',
      'content-length': String(body.length),
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    });
    const ms = Math.min(Number(url.searchParams.get('ms') ?? 0) || 0, 30_000);
    if (!ms || !body.length) return res.end(body);
    const slice = Math.ceil(body.length / 10);
    let at = 0;
    const tick = () => {
      if (res.destroyed) return;
      res.write(body.subarray(at, at + slice));
      at += slice;
      if (at >= body.length) res.end();
      else setTimeout(tick, ms / 10);
    };
    return tick();
  }

  if (pathname === '/e2/stats') return sendJson(res, 200, { hits: Object.fromEntries(hits), counter });
  // Each call answers a new number: a pinned HAR that really served the page
  // shows the OLD number and leaves this counter where it was.
  if (pathname === '/e2/counter') {
    counter += 1;
    return sendJson(res, 200, { n: counter });
  }
  if (pathname === '/e2/unrecorded') return sendJson(res, 200, { ok: true });
  if (pathname === '/e2/echo') {
    return sendJson(res, 200, {
      cookie: req.headers.cookie ?? '',
      userAgent: req.headers['user-agent'] ?? '',
      acceptLanguage: req.headers['accept-language'] ?? '',
    });
  }
  // A long HttpOnly cookie, JWT-shaped (header.payload.signature in base64url),
  // exactly ?len= characters long (64-3000). A cookie reader that cut values
  // short (v2 round 3: 929 characters set, 78 returned) is caught by comparing
  // the value reported with the one answered here.
  if (pathname === '/e2/set-long') {
    const name = (url.searchParams.get('name') || 'e2jwt').replace(/[^\w-]/g, '_');
    const len = Math.max(64, Math.min(Number(url.searchParams.get('len')) || 929, 3000));
    const b64 = (s) => Buffer.from(s).toString('base64url');
    const head = `${b64('{"alg":"HS256","typ":"JWT"}')}.`;
    let body = '';
    for (let i = 0; body.length < len; i++) body += b64(`{"sub":"e2","i":${i},"pad":"${'x'.repeat(24)}"}`);
    const value = `${head}${body}`.slice(0, len - 44) + `.${b64('e2-signature-0123456789abcdef')}`.padEnd(44, 'A').slice(0, 44);
    return sendJson(res, 200, { name, value, length: value.length }, { 'set-cookie': `${name}=${value}; Path=/; HttpOnly; SameSite=Lax` });
  }
  // Sets a cookie the page's script cannot see (HttpOnly).
  if (pathname === '/e2/set-httponly') {
    const name = (url.searchParams.get('name') || 'e2http').replace(/[^\w-]/g, '_');
    const value = (url.searchParams.get('value') || 'secret').replace(/[^\w-]/g, '_');
    return sendJson(res, 200, { set: name }, { 'set-cookie': `${name}=${value}; Path=/; HttpOnly; SameSite=Lax` });
  }

  // Accept a base64 artifact from the page and write it into setup/out/.
  //
  // The browser can produce bytes — a rendered card, a canvas export — that the
  // agent then needs as a FILE, because file inputs take paths and not blobs.
  // Routing them back out through the tool result would mean carrying a
  // megabyte of base64 through the agent's context to achieve a disk write.
  //
  // Local-only, one fixed directory, name sanitised to a basename: this server
  // already binds 127.0.0.1 and exists only for testing, but a write endpoint
  // deserves the limits stated out loud.
  if (req.method === 'POST' && pathname === '/save') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const { name, dataBase64 } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const safe = path.basename(String(name || 'artifact.bin')).replace(/[^\w.-]/g, '_');
      const dir = path.join(HERE, 'out');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, safe);
      await fs.writeFile(file, Buffer.from(dataBase64, 'base64'));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, path: file, bytes: Buffer.from(dataBase64, 'base64').length }));
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(err.message) }));
    }
  }

  // Read-only view of the extension modules that get injected into pages, so
  // they can be smoke-tested against a real DOM before being wired into the
  // service worker. Injected code is the hardest thing here to test any other
  // way: it only misbehaves inside a page.
  if (pathname.startsWith('/lib/')) {
    const lib = path.join(HERE, '..', 'extension', 'lib', path.basename(pathname));
    try {
      const body = await fs.readFile(lib);
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(body);
    } catch {
      res.writeHead(404); return res.end('no such lib module');
    }
  }
  // Accepts the connection and never answers. The only reliable way to observe
  // `browser_network status:"pending"` — network throttling does not help,
  // because an agent's round trip is slower than any latency you can emulate.
  if (pathname === '/hang') {
    req.socket.setKeepAlive(true);
    return; // deliberately no response
  }

  // Answers after ?ms= milliseconds, for wait/idle scenarios.
  if (pathname === '/slow') {
    const ms = Math.min(Number(url.searchParams.get('ms') ?? 1000), 30_000);
    return setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, delayedMs: ms }));
    }, ms);
  }

  // The test page deliberately requests these; 404 is the point.
  if (pathname.startsWith('/api/') || pathname.includes('missing')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not found', path: pathname }));
  }

  // Contain path traversal — this serves from one directory only.
  const target = path.join(HERE, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(HERE)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  try {
    const body = await fs.readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

// Bound to every loopback name, not just 127.0.0.1, so the same server answers
// on `localhost` as well. Those are DIFFERENT ORIGINS to the browser, which is
// what lets the test page embed a genuinely cross-origin (out-of-process)
// iframe without a second server or a real external site.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nTest page:  http://127.0.0.1:${PORT}/`);
  console.log('Open it in Chrome or Edge, then attach it from the G9 side panel.');
  console.log('Ctrl+C to stop.\n');
});
