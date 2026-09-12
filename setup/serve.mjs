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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/testpage.html';

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
