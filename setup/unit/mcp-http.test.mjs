#!/usr/bin/env node
/**
 * mcp/http.mjs (3.2): MCP over Streamable HTTP, the way a remote agent reaches a browser node. The
 * daemon has no password by design, so what this transport refuses matters as much as what it
 * serves: no token, a wrong token, a web page's Origin, a missing or ended session, a body too large.
 * A real HTTP server on a random port in 18000-18999, a fake daemon link; never port 8765.
 *
 * Run: node setup/unit/mcp-http.test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway, tokenMatches, isLoopback, main, MIN_TOKEN_LENGTH } from '../../mcp/http.mjs';
import { TOOLS } from '../../mcp/tools.js';

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n${err?.stack ?? err}`);
    process.exit(1);
  }
}

const TOKEN = 'g9test_' + 'x'.repeat(40);
const links = [];
function fakeLink({ name }) {
  const link = {
    name,
    closed: false,
    calls: [],
    welcome: { version: 'fake' },
    async call(tool, args) {
      link.calls.push({ tool, args, as: link.name });
      if (tool === 'browser_status') return { daemon: 'fake', you: { name: link.name } };
      if (tool === 'browser_snapshot') throw new Error('No tab to act on.');
      return { ok: true, tool };
    },
    close(reason) { link.closed = true; link.closeReason = reason; },
  };
  links.push(link);
  return link;
}

let clock = 1_000_000;
const gw = createGateway({ token: TOKEN, makeLink: fakeLink, idleMs: 60_000, maxSessions: 3, now: () => clock });
const server = http.createServer((req, res) => gw.handler(req, res));
const port = await new Promise((resolve, reject) => {
  const tryPort = (n) => {
    const p = 18000 + Math.floor(Math.random() * 1000);
    server.once('error', (err) => (n > 0 && err.code === 'EADDRINUSE' ? tryPort(n - 1) : reject(err)));
    server.listen(p, '127.0.0.1', () => resolve(p));
  };
  tryPort(20);
});

async function post(body, { token = TOKEN, session = null, headers = {}, raw = null, method = 'POST', path = '/mcp' } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(session ? { 'Mcp-Session-Id': session } : {}),
      ...headers,
    },
    body: method === 'POST' ? (raw ?? JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}
const init = (name = 'claude-code') => post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name, version: '1' }, capabilities: {} } });

try {
  await test('tokens compare in constant time, and only an exact match passes', () => {
    assert.equal(tokenMatches(TOKEN, TOKEN), true);
    assert.equal(tokenMatches(TOKEN + 'x', TOKEN), false);
    assert.equal(tokenMatches(TOKEN.slice(1), TOKEN), false);
    assert.equal(tokenMatches('', TOKEN), false);
    assert.equal(tokenMatches(TOKEN, ''), false, 'an empty configured token matches nothing');
    assert.equal(isLoopback('127.0.0.1'), true);
    assert.equal(isLoopback('::1'), true);
    assert.equal(isLoopback('0.0.0.0'), false);
  });

  await test('no token, a wrong token or a web page\'s Origin: refused before any session exists', async () => {
    const none = await init.call(null);
    assert.equal(none.status, 200, 'sanity: the right token works');
    const before = gw.sessions.size;
    const noToken = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { token: null });
    assert.equal(noToken.status, 401);
    assert.match(noToken.headers.get('www-authenticate') ?? '', /Bearer realm="g9"/);
    const wrong = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { token: TOKEN.replace('x', 'y') });
    assert.equal(wrong.status, 401);
    const page = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { headers: { Origin: 'https://evil.example' } });
    assert.equal(page.status, 403, 'DNS rebinding: a browser page is refused even with the token');
    assert.equal(gw.sessions.size, before, 'no session was opened by a refused request');
  });

  await test('initialize opens a session with its own daemon agent, named by clientInfo', async () => {
    const r = await init('cursor');
    assert.equal(r.status, 200);
    const sid = r.headers.get('mcp-session-id');
    assert.match(sid, /^[0-9a-f-]{36}$/);
    assert.equal(r.json.result.serverInfo.name, 'G9BrowserAgent');
    assert.ok(r.json.result.instructions.length > 100, 'the agent instructions come with it');
    const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { session: sid });
    assert.equal(note.status, 202, 'a notification gets no body');
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { session: sid });
    assert.equal(list.json.result.tools.length, TOOLS.length);
    const status = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_status', arguments: {} } }, { session: sid });
    const parsed = JSON.parse(status.json.result.content[0].text);
    assert.equal(parsed.you.name, 'cursor', 'the daemon sees the client\'s name');
    assert.equal(parsed.shim.transport, 'http');
    const failed = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } }, { session: sid });
    assert.equal(failed.json.result.isError, true, 'a tool failure is a result the agent can read, not a transport fault');
    assert.match(failed.json.result.content[0].text, /No tab to act on/);
  });

  await test('two sessions are two agents; a batch is answered as a batch', async () => {
    const a = (await init('agent-a')).headers.get('mcp-session-id');
    const b = (await init('agent-b')).headers.get('mcp-session-id');
    assert.notEqual(a, b);
    const batch = await post([
      { jsonrpc: '2.0', id: 10, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'browser_tabs', arguments: { action: 'list' } } },
    ], { session: a });
    assert.equal(batch.status, 200);
    assert.deepEqual(batch.json.map((r) => r.id), [10, 11]);
    const la = links.find((l) => l.name === 'agent-a');
    const lb = links.find((l) => l.name === 'agent-b');
    assert.deepEqual(la.calls.map((c) => c.tool), ['browser_tabs']);
    assert.deepEqual(lb.calls, []);
  });

  await test('a missing, unknown or ended session is refused; DELETE ends one and closes its daemon agent', async () => {
    const noSession = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(noSession.status, 400);
    const unknown = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { session: '00000000-0000-0000-0000-000000000000' });
    assert.equal(unknown.status, 404, 'a client re-initializes on 404');
    const r = await init('short-lived');
    const sid = r.headers.get('mcp-session-id');
    const link = links.find((l) => l.name === 'short-lived');
    const del = await post(null, { method: 'DELETE', session: sid });
    assert.equal(del.status, 204);
    assert.equal(link.closed, true);
    assert.equal(link.closeReason, 'MCP session ended', 'the daemon logs why the agent left');
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { session: sid })).status, 404);
  });

  await test('GET is 405, a wrong content type 415, bad JSON a parse error, /healthz says only "ok"', async () => {
    assert.equal((await post(null, { method: 'GET' })).status, 405);
    assert.equal((await post({}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    const bad = await post(null, { raw: '{not json' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, -32700);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');
    assert.equal((await post({}, { path: '/other' })).status, 404);
    const prefixed = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'proxied' } } }, { path: '/b1/mcp' });
    assert.equal(prefixed.status, 200, 'a reverse proxy may mount it under a prefix');
  });

  await test('idle sessions close; the least recently used idle one makes room at the limit', async () => {
    gw.close(); // start from none
    const s1 = (await init('one')).headers.get('mcp-session-id');
    clock += 10;
    await init('two');
    clock += 10;
    await init('three');
    clock += 10;
    await init('four'); // the limit is 3: "one" goes
    assert.equal(gw.sessions.has(s1), false);
    assert.equal(links.find((l) => l.name === 'one').closeReason, 'MCP session evicted (too many sessions)');
    clock += 61_000;
    gw.sweep();
    assert.equal(gw.sessions.size, 0, 'an hour of nothing closes every session');
    assert.equal(links.find((l) => l.name === 'four').closeReason, 'MCP session idle');
  });

  await test('main refuses to put the daemon on a network without a strong token', async () => {
    await assert.rejects(main({ G9_MCP_HTTP_HOST: '0.0.0.0', G9_MCP_HTTP_PORT: '18999' }), /Refusing to listen on 0\.0\.0\.0 without G9_MCP_TOKEN/);
    await assert.rejects(main({ G9_MCP_HTTP_HOST: '0.0.0.0', G9_MCP_HTTP_PORT: '18999', G9_MCP_TOKEN: 'short' }), new RegExp(`at least ${MIN_TOKEN_LENGTH}`));
  });
} finally {
  gw.close();
  server.close();
}
// Exit once the sockets closed above are gone: Node 24 on Windows aborts (libuv async.c assertion)
// when process.exit() runs while a handle is still closing.
setTimeout(() => process.exit(0), 100);
