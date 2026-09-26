#!/usr/bin/env node
/**
 * G9 over the network: the MCP Streamable HTTP transport (3.2).
 *
 *   remote agent ──HTTPS (nginx)──▶ this ──WS 127.0.0.1──▶ g9d ──▶ engines
 *
 * The stdio shim (mcp/shim.mjs) serves an agent on the same machine. A browser node on a server — a
 * container with the desktop, the extension and the daemon (docker/) — is driven by agents that are
 * NOT on that machine: Claude Code on a laptop, the G9ServerManager assistant. They speak MCP over
 * HTTP; this is that endpoint, over the same server core (mcp/server.mjs) and daemon link
 * (mcp/link.mjs) the shim uses.
 *
 * Security — the daemon has no password by design (local trust, D7); this process is what puts it
 * on a network, so everything that makes that safe is here:
 * - **A bearer token**, compared in constant time. Without G9_MCP_TOKEN it listens on loopback
 *   only; asked to listen anywhere else without one (or with a short one) it refuses to start.
 * - **No browser can use it**: a request carrying an Origin header is refused (the MCP spec's DNS
 *   rebinding rule) unless that origin is listed in G9_MCP_ALLOWED_ORIGINS. MCP clients send none.
 * - **One agent per MCP session**: `initialize` opens a daemon connection of its own (its own tabs,
 *   ownership and queue, named by clientInfo.name); DELETE or 30 idle minutes close it.
 * - Bodies over 64 MiB are refused; at most 32 sessions (the least recently used idle one goes).
 *
 * Environment: G9_MCP_HTTP_HOST (127.0.0.1), G9_MCP_HTTP_PORT (8931), G9_MCP_TOKEN or
 * G9_MCP_TOKEN_FILE, G9_MCP_ALLOWED_ORIGINS (comma list), G9_MCP_IDLE_MINUTES (30),
 * G9_MCP_AGENT_CWD (the folder whose g9.project.json the sessions' agents get), and G9_PORT/G9_HOME
 * for the daemon, as the shim.
 *
 * Endpoint: POST (and DELETE) on `/mcp` — or any path ending in `/mcp`, so a reverse proxy may mount
 * it under a prefix. GET is 405: this server never opens a stream of its own. `/healthz` answers
 * "ok" without authentication and without saying anything else.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DaemonLink } from './link.mjs';
import { createMcpServer } from './server.mjs';
import { log } from './mcp.js';
import { VERSION } from '../lib/version.mjs';

export const MAX_BODY_BYTES = 64 * 1024 * 1024;
export const MAX_SESSIONS = 32;
export const MIN_TOKEN_LENGTH = 24;

/** Constant-time comparison of a presented bearer token with the configured one. */
export function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b) && presented.length === expected.length;
}

export function isLoopback(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

/**
 * The request handler and its sessions, without listening — the tests drive it with a fake link.
 *
 * @param {object} o
 * @param {string} [o.token]           required bearer token ('' = none: loopback only, see main)
 * @param {(o: {name: string}) => object} [o.makeLink]  a DaemonLink per session
 * @param {number} [o.idleMs]          a session unused this long is closed
 * @param {string[]} [o.allowedOrigins]
 * @param {number} [o.maxSessions]
 */
export function createGateway({
  token = '',
  makeLink = ({ name }) => new DaemonLink({ name, cwd: process.env.G9_MCP_AGENT_CWD || process.cwd() }),
  idleMs = 30 * 60_000,
  allowedOrigins = [],
  maxSessions = MAX_SESSIONS,
  now = () => Date.now(),
} = {}) {
  const sessions = new Map(); // id → { link, server, lastUsed, inFlight }

  // The reason is what the daemon logs beside "agent disconnected".
  const endSession = (id, reason = 'MCP session ended') => {
    const s = sessions.get(id);
    if (!s) return false;
    sessions.delete(id);
    try { s.link.close(reason); } catch { /* already closed */ }
    return true;
  };

  const sweep = () => {
    const t = now();
    for (const [id, s] of sessions) if (s.inFlight === 0 && t - s.lastUsed > idleMs) endSession(id, 'MCP session idle');
  };
  const sweeper = setInterval(sweep, Math.max(1_000, Math.min(60_000, Math.floor(idleMs / 4))));
  sweeper.unref?.();

  const send = (res, status, body, headers = {}) => {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Cache-Control': 'no-store',
      ...(body !== undefined && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    });
    res.end(text);
  };
  const rpcError = (code, message) => ({ jsonrpc: '2.0', id: null, error: { code, message } });

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const openSession = () => {
    if (sessions.size >= maxSessions) {
      // The least recently used session that is not in a call makes room; if every one is busy, no.
      const idle = [...sessions].filter(([, s]) => s.inFlight === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!idle) return null;
      endSession(idle[0], 'MCP session evicted (too many sessions)');
    }
    const id = crypto.randomUUID();
    const link = makeLink({ name: 'mcp-http-agent' });
    const server = createMcpServer(link, { transport: 'http' });
    sessions.set(id, { link, server, lastUsed: now(), inFlight: 0 });
    return id;
  };

  async function handler(req, res) {
    let url;
    try { url = new URL(req.url ?? '/', 'http://g9'); } catch { return send(res, 400, 'bad request'); }
    if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
    if (!(url.pathname === '/mcp' || url.pathname.endsWith('/mcp'))) return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });

    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) {
      return send(res, 403, rpcError(-32000, 'Requests from web pages are refused (Origin present). MCP clients send no Origin.'));
    }
    if (token) {
      const auth = String(req.headers.authorization ?? '');
      const presented = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? '';
      if (!tokenMatches(presented, token)) {
        return send(res, 401, rpcError(-32001, 'A valid bearer token is required.'), { 'WWW-Authenticate': 'Bearer realm="g9", error="invalid_token"' });
      }
    }

    const sessionId = req.headers['mcp-session-id'];
    if (req.method === 'DELETE') {
      return endSession(String(sessionId ?? '')) ? send(res, 204) : send(res, 404, rpcError(-32001, 'No such session.'));
    }
    if (req.method !== 'POST') return send(res, 405, rpcError(-32000, 'Method not allowed: use POST (this server opens no stream of its own).'), { Allow: 'POST, DELETE' });
    if (!/application\/json/i.test(String(req.headers['content-type'] ?? ''))) {
      return send(res, 415, rpcError(-32000, 'Content-Type must be application/json.'));
    }

    let text;
    try {
      text = await readBody(req);
    } catch (err) {
      return send(res, err.status ?? 400, rpcError(-32000, err.status === 413 ? `The body is larger than ${MAX_BODY_BYTES / 1048576} MiB.` : 'Could not read the body.'));
    }
    let payload;
    try { payload = JSON.parse(text); } catch { return send(res, 400, rpcError(-32700, 'Parse error')); }
    const messages = Array.isArray(payload) ? payload : [payload];
    if (!messages.length) return send(res, 400, rpcError(-32600, 'Invalid Request: empty batch.'));

    const isInit = messages.some((m) => m && typeof m === 'object' && m.method === 'initialize');
    let id = sessionId ? String(sessionId) : null;
    let opened = false;
    if (isInit) {
      if (id && sessions.has(id)) endSession(id, 'MCP session re-initialized'); // a client that initializes again starts over
      id = openSession();
      opened = true;
      if (!id) return send(res, 503, rpcError(-32000, `Too many sessions (${maxSessions}), all busy. Retry shortly.`));
    } else if (!id) {
      return send(res, 400, rpcError(-32000, 'Bad Request: no Mcp-Session-Id header. Send initialize first.'));
    } else if (!sessions.has(id)) {
      return send(res, 404, rpcError(-32001, 'Session not found (it ended or expired). Send initialize again.'));
    }

    const s = sessions.get(id);
    s.inFlight++;
    s.lastUsed = now();
    try {
      const out = [];
      for (const m of messages) {
        const r = await s.server.handle(m);
        if (r) out.push(r);
      }
      const headers = opened ? { 'Mcp-Session-Id': id } : {};
      if (!out.length) return send(res, 202, undefined, headers);
      return send(res, 200, Array.isArray(payload) ? out : out[0], headers);
    } finally {
      s.inFlight--;
      s.lastUsed = now();
    }
  }

  return {
    handler,
    sessions,
    sweep,
    close() {
      clearInterval(sweeper);
      for (const id of [...sessions.keys()]) endSession(id, 'MCP endpoint stopping');
    },
  };
}

/** Read the configuration from the environment and listen. Exits with a reason when it is unsafe. */
export async function main(env = process.env) {
  const host = env.G9_MCP_HTTP_HOST || '127.0.0.1';
  const port = Number(env.G9_MCP_HTTP_PORT) || 8931;
  let token = String(env.G9_MCP_TOKEN ?? '').trim();
  if (!token && env.G9_MCP_TOKEN_FILE) token = fs.readFileSync(env.G9_MCP_TOKEN_FILE, 'utf8').trim();
  if (!isLoopback(host)) {
    if (!token) throw new Error(`Refusing to listen on ${host} without G9_MCP_TOKEN: the G9 daemon has no password, and this endpoint would hand every browser tab to anyone who can reach it.`);
    if (token.length < MIN_TOKEN_LENGTH) throw new Error(`G9_MCP_TOKEN is too short (${token.length} characters; at least ${MIN_TOKEN_LENGTH}).`);
  }
  const allowedOrigins = String(env.G9_MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const idleMinutes = Number(env.G9_MCP_IDLE_MINUTES) > 0 ? Number(env.G9_MCP_IDLE_MINUTES) : 30;
  const gw = createGateway({ token, allowedOrigins, idleMs: idleMinutes * 60_000 });
  const server = http.createServer((req, res) => {
    gw.handler(req, res).catch((err) => {
      log(`[g9-mcp-http] ${err?.stack ?? err}`);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    });
  });
  // Long tool calls (a replay, a humanized flow) keep their POST open for minutes.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  log(`[g9-mcp-http] G9 v${VERSION} MCP over HTTP on http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp — ${token ? 'bearer token required' : 'no token (loopback only)'}`);
  const stop = () => { gw.close(); server.close(); setTimeout(() => process.exit(0), 200).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return { server, gateway: gw };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    log(`[g9-mcp-http] ${err.message}`);
    process.exit(1);
  });
}
