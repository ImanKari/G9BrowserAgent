#!/usr/bin/env node
/**
 * End-to-end self-test — no browser required.
 *
 * Spawns the real bridge, speaks real MCP over stdio, and connects a fake
 * "extension" over a real WebSocket. If this passes, the plumbing is sound and
 * anything that then fails is in the extension's browser code, not the wiring.
 *
 *   node setup/selftest.mjs
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'bridge', 'src', 'server.js');
const PORT = Number(process.env.G9_TEST_PORT ?? 8799);

let passed = 0;
let failed = 0;

const ok = (name, detail = '') => {
  passed++;
  console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`);
};
const bad = (name, detail = '') => {
  failed++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------- minimal WebSocket client

/**
 * Hand-rolled so the test can set an arbitrary Origin header, which the
 * built-in WebSocket class does not allow — and Origin validation is exactly
 * what we need to prove works.
 */
function wsConnect({ port, origin, token }) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1', () => {
      const p = token ? `/agent?token=${encodeURIComponent(token)}` : '/agent';
      socket.write(
        `GET ${p} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          `Origin: ${origin}\r\n\r\n`,
      );
    });

    let handshake = '';
    const onData = (chunk) => {
      handshake += chunk.toString('latin1');
      const end = handshake.indexOf('\r\n\r\n');
      if (end === -1) return;

      socket.removeListener('data', onData);
      const status = Number(handshake.slice(9, 12));
      if (status !== 101) {
        socket.destroy();
        return reject(new Error(`handshake rejected: ${status}`));
      }

      const client = new EventTargetish(socket);
      const leftover = Buffer.from(handshake.slice(end + 4), 'latin1');
      client.feed(leftover);
      socket.on('data', (c) => client.feed(c));
      resolve(client);
    };

    socket.on('data', onData);
    socket.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 4000);
  });
}

class EventTargetish {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.handlers = [];
  }
  onMessage(fn) {
    this.handlers.push(fn);
  }
  send(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];

    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
  close() {
    this.socket.destroy();
  }
  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0] & 0x0f;
      let len = this.buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + len) return;
      const payload = this.buffer.subarray(offset, offset + len);
      this.buffer = this.buffer.subarray(offset + len);
      if (opcode === 0x1) {
        try {
          const msg = JSON.parse(payload.toString('utf8'));
          for (const h of this.handlers) h(msg);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

// ------------------------------------------------------------- MCP over stdio

class McpClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.id = 1;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          bad('stdout carried non-JSON', line.slice(0, 80));
          continue;
        }
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          entry(msg);
        }
      }
    });
  }
  request(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 8000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
}

// ------------------------------------------------------------------- the run

console.log('\n\x1b[1mG9 Browser Agent — self-test\x1b[0m');
console.log(`\x1b[90mbridge: ${SERVER}\x1b[0m`);
console.log(`\x1b[90mport:   ${PORT}\x1b[0m\n`);

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, G9_PORT: String(PORT), G9_TIMEOUT_MS: '5000' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const stderrLines = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => stderrLines.push(d.trim()));

const mcp = new McpClient(child);
await sleep(700);

try {
  // -- 1. MCP handshake ------------------------------------------------------
  console.log('\x1b[1m1. MCP protocol\x1b[0m');
  const init = await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'g9-selftest', version: '1.0.0' },
  });
  if (init.result?.serverInfo?.name === 'g9-browser-agent') ok('initialize', init.result.protocolVersion);
  else bad('initialize', JSON.stringify(init).slice(0, 120));

  if (init.result?.instructions?.includes('LIVE browser')) {
    ok('instructions delivered', `${init.result.instructions.length} chars auto-loaded into agent context`);
  } else bad('instructions delivered');

  mcp.notify('notifications/initialized');

  const list = await mcp.request('tools/list');
  const tools = list.result?.tools ?? [];
  if (tools.length === 12) ok('tools/list', `${tools.length} tools`);
  else bad('tools/list', `expected 12, got ${tools.length}`);

  const schemaProblems = tools.filter((t) => !t.description || t.inputSchema?.type !== 'object');
  if (!schemaProblems.length) ok('every tool has a description and object schema');
  else bad('tool schemas', schemaProblems.map((t) => t.name).join(', '));

  const resources = await mcp.request('resources/list');
  if ((resources.result?.resources ?? []).length === 2) ok('resources/list', 'guide + status');
  else bad('resources/list');

  // -- 2. no extension yet ---------------------------------------------------
  console.log('\n\x1b[1m2. Error handling with no browser attached\x1b[0m');
  const orphan = await mcp.request('tools/call', { name: 'browser_status', arguments: {} });
  const orphanText = orphan.result?.content?.[0]?.text ?? '';
  if (orphan.result?.isError && orphanText.includes('not connected')) {
    ok('actionable error when the extension is absent');
  } else bad('missing-extension error', orphanText.slice(0, 100));

  // -- 3. origin enforcement -------------------------------------------------
  console.log('\n\x1b[1m3. Security\x1b[0m');
  try {
    await wsConnect({ port: PORT, origin: 'https://evil.example.com' });
    bad('a web page origin was ALLOWED — this is a security hole');
  } catch (err) {
    if (String(err.message).includes('403')) ok('web-page origin rejected', 'https://evil.example.com -> 403');
    else bad('origin rejection', err.message);
  }

  // -- 4. real round trip ----------------------------------------------------
  console.log('\n\x1b[1m4. End-to-end tool call\x1b[0m');
  const fakeExtension = await wsConnect({
    port: PORT,
    origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
  });
  ok('extension origin accepted');

  // One dispatcher, so per-tool responders can be registered as the test goes.
  // (Registering several independent handlers would let the first one answer
  // every call before the specialised ones ever run.)
  const responders = new Map();
  let gotPong = false;

  fakeExtension.onMessage((msg) => {
    if (msg.type === 'pong') {
      gotPong = true;
      return;
    }
    if (msg.type !== 'call') return;

    const responder = responders.get(msg.tool);
    const result = responder
      ? responder(msg)
      : {
          echoedTool: msg.tool,
          echoedArgs: msg.args,
          mode: 'pinned',
          attached: { tabId: 42, title: 'Self-test page', url: 'https://localhost:7241/' },
        };

    if (result?.__error) {
      fakeExtension.send({ type: 'result', id: msg.id, ok: false, error: result.__error });
    } else {
      fakeExtension.send({ type: 'result', id: msg.id, ok: true, result });
    }
  });

  // The bridge must answer 'hello' with its own absolute path, so the side
  // panel can render a pasteable MCP config. Regression guard: shipping a
  // placeholder path here produced a config that failed with
  // "Cannot find module" the first time someone copied it.
  let welcome = null;
  fakeExtension.onMessage((msg) => {
    if (msg.type === 'welcome') welcome = msg;
  });

  fakeExtension.send({ type: 'hello', role: 'extension', version: '1.0.0' });
  await sleep(300);

  if (welcome?.serverPath?.endsWith('bridge/src/server.js')) {
    ok('bridge reports its own path', welcome.serverPath);
  } else bad('bridge handshake path', JSON.stringify(welcome));

  if (welcome?.serverPath && path.isAbsolute(welcome.serverPath.replace(/\//g, path.sep))) {
    ok('reported path is absolute', 'side panel config is pasteable');
  } else bad('reported path is not absolute', welcome?.serverPath ?? '(none)');

  const call = await mcp.request('tools/call', {
    name: 'browser_snapshot',
    arguments: { mode: 'a11y', maxNodes: 500 },
  });
  const payload = JSON.parse(call.result?.content?.[0]?.text ?? '{}');
  if (payload.echoedTool === 'browser_snapshot') ok('tool call reached the extension');
  else bad('tool routing', JSON.stringify(call.result).slice(0, 140));

  if (payload.echoedArgs?.maxNodes === 500) ok('arguments preserved end to end');
  else bad('argument passing', JSON.stringify(payload.echoedArgs));

  // -- 5. keepalive ----------------------------------------------------------
  console.log('\n\x1b[1m5. Keepalive\x1b[0m');
  fakeExtension.send({ type: 'ping', at: Date.now() });
  await sleep(300);
  if (gotPong) ok('ping/pong', 'service worker will stay alive');
  else bad('ping/pong — the MV3 worker would be killed after ~30s');

  // -- 6. image results ------------------------------------------------------
  console.log('\n\x1b[1m6. Screenshot content type\x1b[0m');
  responders.set('browser_screenshot', () => ({
    format: 'jpeg',
    area: 'viewport',
    dataBase64: '/9j/4AAQSkZJRg==',
  }));
  const shot = await mcp.request('tools/call', { name: 'browser_screenshot', arguments: {} });
  const parts = shot.result?.content ?? [];
  if (parts.some((p) => p.type === 'image' && p.mimeType === 'image/jpeg')) {
    ok('screenshots return an image block', 'multimodal models can see it');
  } else bad('screenshot content', JSON.stringify(parts).slice(0, 120));

  // -- 7. tool errors --------------------------------------------------------
  console.log('\n\x1b[1m7. Tool-level errors\x1b[0m');
  responders.set('browser_interact', () => ({ __error: 'Unknown element ref "e99".' }));
  const errCall = await mcp.request('tools/call', {
    name: 'browser_interact',
    arguments: { action: 'click', ref: 'e99' },
  });
  if (errCall.result?.isError && errCall.result.content[0].text.includes('e99')) {
    ok('extension errors surface as readable tool errors');
  } else bad('error propagation', JSON.stringify(errCall.result).slice(0, 120));

  // -- 8. disconnect ---------------------------------------------------------
  console.log('\n\x1b[1m8. Disconnect handling\x1b[0m');
  fakeExtension.close();
  await sleep(400);
  const afterClose = await mcp.request('tools/call', { name: 'browser_status', arguments: {} });
  if (afterClose.result?.isError) ok('calls fail fast after the browser goes away');
  else bad('disconnect handling', 'call should have failed');

  // -- 9. stdout hygiene -----------------------------------------------------
  console.log('\n\x1b[1m9. stdio hygiene\x1b[0m');
  if (stderrLines.some((l) => l.includes('[g9] bridge listening'))) {
    ok('diagnostics go to stderr', 'stdout stays pure JSON-RPC');
  } else bad('stderr logging', stderrLines.join(' | ').slice(0, 120));

  // -- 10. standalone survival ----------------------------------------------
  // Regression guard: the bridge used to exit ~5ms after binding the port when
  // stdin had no writer, because 'end' fired immediately. That made
  // `node bridge/src/server.js` — the command the README and side panel tell
  // people to use for debugging — silently impossible.
  console.log('\n\x1b[1m10. Standalone mode (no MCP client)\x1b[0m');
  await standaloneCheck();
} catch (err) {
  bad('unexpected exception', String(err?.stack ?? err));
} finally {
  child.kill();
}

async function standaloneCheck() {
  const solo = spawn(process.execPath, [SERVER], {
    env: { ...process.env, G9_PORT: String(PORT + 1) },
    stdio: ['ignore', 'pipe', 'pipe'], // stdin closed, exactly like a redirect
  });

  let soloErr = '';
  solo.stderr.setEncoding('utf8');
  solo.stderr.on('data', (d) => (soloErr += d));

  let exitedEarly = false;
  solo.on('exit', () => {
    exitedEarly = true;
  });

  await sleep(1200);

  if (!exitedEarly) ok('bridge survives stdin EOF', 'debugging without an MCP client works');
  else bad('bridge exited immediately on stdin EOF', 'the standalone regression is back');

  if (soloErr.includes('STANDALONE mode')) ok('standalone mode announced on stderr');
  else bad('standalone notice missing', soloErr.slice(0, 120));

  // And it must still be reachable, not merely alive.
  try {
    const res = await fetch(`http://127.0.0.1:${PORT + 1}/health`);
    const body = await res.json();
    if (body.ok === true) ok('health endpoint responds in standalone mode');
    else bad('health endpoint body', JSON.stringify(body));
  } catch (err) {
    bad('health endpoint unreachable', String(err.message));
  }

  solo.kill();
  await sleep(150);
}

console.log(
  `\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`,
);
if (failed === 0) {
  console.log('\x1b[90mThe bridge, MCP layer, and WebSocket transport all work.');
  console.log('Next: load the extension in Chrome/Edge and attach a tab.\x1b[0m\n');
}
process.exit(failed === 0 ? 0 : 1);
