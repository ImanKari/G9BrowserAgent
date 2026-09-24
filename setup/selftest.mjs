#!/usr/bin/env node
/**
 * End-to-end self-test — no browser required.
 *
 * Spawns a REAL daemon (daemon/g9d.mjs) on a random private port with a
 * throw-away G9_HOME, connects a FAKE extension engine over a real WebSocket
 * (Origin chrome-extension://test) that answers relayed calls, and drives it
 * through TWO real MCP shims (mcp/shim.mjs over stdio) acting as two agents.
 * If this passes, the wiring — MCP, the daemon protocol, routing, id
 * rewriting, ownership, queues, halts — is sound, and anything that then fails
 * is in the tool code or the browser.
 *
 *   node setup/selftest.mjs
 *
 * Never touches port 8765 (the owner's real daemon/bridge lives there) and
 * never the owner's profiles: every port is random in 18000–18999 and every
 * data folder is a fresh temp directory, deleted at the end.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WsClient } from '../lib/ws-client.mjs';
import { VERSION } from '../lib/version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DAEMON = path.join(ROOT, 'daemon', 'g9d.mjs');
const SHIM = path.join(ROOT, 'mcp', 'shim.mjs');
const FORWARDER = path.join(ROOT, 'bridge', 'src', 'server.js');

let passed = 0;
let failed = 0;
const color = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const ok = (name, detail = '') => {
  passed++;
  console.log(`  ${color(32, 'PASS')} ${name}${detail ? ` ${color(90, detail)}` : ''}`);
};
const bad = (name, detail = '') => {
  failed++;
  console.log(`  ${color(31, 'FAIL')} ${name}${detail ? ` ${color(90, detail)}` : ''}`);
};
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : bad(name, detail));
const section = (title) => console.log(`\n${color(1, title)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ helpers

const usedPorts = new Set();
async function freePort() {
  for (let i = 0; i < 200; i++) {
    const port = 18000 + Math.floor(Math.random() * 1000);
    if (port === 8765 || usedPorts.has(port)) continue;
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) {
      usedPorts.add(port);
      return port;
    }
  }
  throw new Error('no free port in 18000-18999');
}

const tempDirs = [];
function tempHome(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `g9-selftest-${label}-`));
  tempDirs.push(dir);
  return dir;
}

async function health(port) {
  const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
  return res.json();
}

async function waitFor(predicate, timeoutMs = 8_000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch { /* not yet */ }
    await sleep(stepMs);
  }
  return false;
}

const children = new Set();
function track(child) {
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

/** MCP over stdio to a real shim. Any non-JSON line on stdout is a hygiene failure. */
class Mcp {
  constructor(script, env, name) {
    this.name = name;
    this.child = track(spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
    this.pending = new Map();
    this.id = 1;
    this.buffer = '';
    this.stderr = '';
    this.nonJson = [];
    this.exited = false;
    this.child.on('exit', () => { this.exited = true; });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    this.child.stdin.on('error', () => {});
    this.child.stdout.on('data', (chunk) => {
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
          this.nonJson.push(line);
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

  request(method, params = {}, timeoutMs = 15_000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: ${method} timed out`));
      }, timeoutMs);
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

  async init() {
    const res = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.name, version: '1.0.0' } });
    this.notify('notifications/initialized');
    return res;
  }

  /** tools/call → { ok, data, text, raw } with the JSON payload parsed. */
  async call(name, args = {}, timeoutMs = 15_000) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const text = (res.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    return { ok: !res.result?.isError && !res.error, data, text, raw: res };
  }

  close() {
    try { this.child.stdin.end(); } catch { /* gone */ }
  }

  kill() {
    try { this.child.kill(); } catch { /* gone */ }
  }
}

/**
 * The fake extension: a WebSocket client with an extension Origin that says
 * hello as a v2 engine and answers relayed calls from a responder table. It
 * records every call (tool, Chrome-id args, caller) and per-tab concurrency.
 */
async function fakeExtension(port, { origin = 'chrome-extension://test', version = '2.0.0', client = {} } = {}) {
  const ws = await WsClient.connect(`ws://127.0.0.1:${port}/g9`, { origin });
  const ext = {
    ws,
    calls: [],
    messages: [],
    welcome: null,
    responders: new Map(),
    active: new Map(), // chrome tabId → in-flight mutating calls
    maxActive: new Map(),
    closed: null,
  };
  ws.on('close', (info) => { ext.closed = info; });
  ws.on('message', async (msg) => {
    ext.messages.push(msg);
    if (msg.type === 'welcome') ext.welcome = msg;
    if (msg.type !== 'call') return;
    ext.calls.push({ tool: msg.tool, args: msg.args, caller: msg.caller, at: Date.now() });
    const responder = ext.responders.get(msg.tool) ?? defaultResponder;
    try {
      const result = await responder(msg, ext);
      if (result === NEVER) return;
      ws.send({ type: 'result', id: msg.id, ok: true, result });
    } catch (err) {
      // As extension/sw.js does: an input error's delivery state travels as fields too.
      ws.send({
        type: 'result', id: msg.id, ok: false, error: err.message,
        ...(typeof err.delivery === 'string' ? { delivery: err.delivery, hit: err.hit ?? null, hidden: err.hidden === true } : {}),
      });
    }
  });
  ws.send({ type: 'hello', role: 'engine', version, client: { name: 'extension', browser: 'Mozilla/5.0 Edg/153.0 (fake)', ...client } });
  await waitFor(() => ext.welcome, 5_000);
  return ext;
}

const NEVER = Symbol('never');

const TABS = [
  { tabId: 101, title: 'Orders — Test App', url: 'https://app.test/orders', active: true, windowId: 1, attachable: true },
  { tabId: 102, title: 'Popup', url: 'https://app.test/popup', active: false, windowId: 1, openerTabId: 101, attachable: true },
];

function defaultResponder(msg) {
  switch (msg.tool) {
    case 'browser_status':
      return {
        engine: 'extension',
        version: VERSION,
        current: { tabId: 101, title: TABS[0].title, url: TABS[0].url, active: true },
        health: { consoleErrors: 1, failedRequests: 0 },
        tabs: { count: 2, rows: TABS },
        hint: 'Ready.',
      };
    case 'browser_tabs':
      if ((msg.args.action ?? 'list') === 'list') return { tabs: TABS };
      if (msg.args.action === 'open') return { tabId: 103, url: msg.args.url };
      if (msg.args.action === 'attach') return { tabId: msg.args.tabId ?? 101, title: 'Orders — Test App', url: TABS[0].url };
      return { ok: true, action: msg.args.action };
    case 'browser_snapshot':
      return { echoedArgs: msg.args, tabIds: [101, 102], tree: '- button "Save" [ref=e1]' };
    case 'browser_screenshot':
      return { format: 'jpeg', area: 'viewport', dataBase64: '/9j/4AAQSkZJRg==' };
    default:
      return { echoedTool: msg.tool, echoedArgs: msg.args };
  }
}

/** A slow mutating call that records per-tab concurrency, so serialisation can be proven. */
function slowInteract(ms) {
  return async (msg, ext) => {
    const tab = msg.args.tabId;
    const now = (ext.active.get(tab) ?? 0) + 1;
    ext.active.set(tab, now);
    ext.maxActive.set(tab, Math.max(ext.maxActive.get(tab) ?? 0, now));
    if (msg.args.ref === 'never') return NEVER;
    await sleep(ms);
    ext.active.set(tab, ext.active.get(tab) - 1);
    return { delivery: 'delivered', tabId: tab, ref: msg.args.ref };
  };
}

function spawnDaemon(port, home, extraEnv = {}) {
  // cwd is the temp home and G9_PROJECT is cleared, so no g9.project.json from
  // wherever the test happens to run can leak into the daemon's default project.
  const child = track(spawn(process.execPath, [DAEMON, '--port', String(port), '--home', home], {
    cwd: home,
    env: { ...process.env, G9_TIMEOUT_MS: '6000', G9_PROJECT: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }));
  child.stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { child.stderrText += d; });
  return child;
}

async function uiClient(port) {
  const ws = await WsClient.connect(`ws://127.0.0.1:${port}/g9`);
  const ui = { ws, events: [], results: new Map(), nextId: 1, welcome: null };
  ws.on('message', (msg) => {
    if (msg.type === 'welcome') ui.welcome = msg;
    else if (msg.type === 'event') ui.events.push(msg);
    else if (msg.type === 'result') ui.results.get(msg.id)?.(msg);
  });
  ws.send({ type: 'hello', role: 'ui', version: VERSION, client: { name: 'selftest-ui', pid: process.pid } });
  await waitFor(() => ui.welcome, 5_000);
  ui.admin = (op, extra = {}) => new Promise((resolve, reject) => {
    const id = ui.nextId++;
    const timer = setTimeout(() => reject(new Error(`admin ${op} timed out`)), 10_000);
    ui.results.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    ws.send({ type: 'admin', id, op, ...extra });
  });
  return ui;
}

// ------------------------------------------------------------------ the run

console.log(`\n${color(1, 'G9 v2 — self-test')} ${color(90, `(v${VERSION})`)}`);

const PORT = await freePort();
const HOME = tempHome('main');
console.log(color(90, `daemon: ${DAEMON}\nport:   ${PORT} (never 8765)\nhome:   ${HOME}`));

let daemon = null;
let shimA = null;
let shimB = null;
let ext = null;
let ui = null;

try {
  // -- 1. daemon ---------------------------------------------------------------
  section('1. Daemon start and /health');
  daemon = spawnDaemon(PORT, HOME);
  const up = await waitFor(async () => (await health(PORT)).name === 'g9d', 10_000);
  check(up, 'daemon answers /health', `port ${PORT}`);
  const h = await health(PORT);
  check(h.ok === true && h.name === 'g9d' && h.version === VERSION && Number.isInteger(h.pid) && h.port === PORT,
    '/health shape', JSON.stringify({ name: h.name, version: h.version, port: h.port }));
  check(typeof h.home === 'string' && h.engines === 0 && h.agents === 0 && h.extension === false, '/health counts engines, agents, extension');
  const dj = JSON.parse(fs.readFileSync(path.join(HOME, 'daemon.json'), 'utf8'));
  check(dj.pid === h.pid && dj.port === PORT && dj.version === VERSION, 'daemon.json written', `pid ${dj.pid}`);
  check(fs.existsSync(path.join(HOME, 'logs', 'daemon.log')), 'logs to G9_HOME/logs/daemon.log');
  const cors = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: { Origin: 'https://evil.example.com' } });
  check(!cors.headers.get('access-control-allow-origin'), 'no CORS header for a web page on /health');
  const corsExt = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: { Origin: 'chrome-extension://test' } });
  check(corsExt.headers.get('access-control-allow-origin') === 'chrome-extension://test', 'CORS header echoed for an extension origin');

  // -- 2. origin rule and v1 refusal ----------------------------------------------
  section('2. Origin rule and version refusal');
  try {
    await WsClient.connect(`ws://127.0.0.1:${PORT}/g9`, { origin: 'https://evil.example.com' });
    bad('a web-page origin was ALLOWED — security hole');
  } catch (err) {
    check(err.status === 403, 'web-page origin rejected with 403', err.message);
  }
  try {
    await WsClient.connect(`ws://127.0.0.1:${PORT}/g9`, { origin: 'http://127.0.0.1:5199' });
    bad('a local web page origin was ALLOWED');
  } catch (err) {
    check(err.status === 403, 'a page on localhost is still a web page → 403');
  }
  try {
    await WsClient.connect(`ws://127.0.0.1:${PORT}/elsewhere`);
    bad('unknown path accepted');
  } catch (err) {
    check(err.status === 404, 'unknown WebSocket path → 404');
  }

  const v1 = await WsClient.connect(`ws://127.0.0.1:${PORT}/agent`, { origin: 'chrome-extension://oldv1' });
  const v1Msgs = [];
  let v1Close = null;
  v1.on('message', (m) => v1Msgs.push(m));
  v1.on('close', (info) => { v1Close = info; });
  v1.send({ type: 'hello', role: 'extension', version: '1.7.21' });
  await waitFor(() => v1Close, 5_000);
  const v1Welcome = v1Msgs.find((m) => m.type === 'welcome');
  check(!!v1Welcome?.problem && /v1\.7\.21/.test(v1Welcome.problem) && /Reload/i.test(v1Welcome.problem),
    'v1 extension hello gets a welcome naming the problem and the fix', (v1Welcome?.problem ?? '').slice(0, 90));
  check(v1Close?.code === 4001 && /reload/i.test(v1Close?.reason ?? ''), 'and is closed with code 4001', `${v1Close?.code} ${v1Close?.reason}`);

  const silent = await WsClient.connect(`ws://127.0.0.1:${PORT}/g9`);
  let silentClose = null;
  silent.on('close', (i) => { silentClose = i; });
  silent.send({ type: 'call', id: 1, tool: 'browser_status', args: {} });
  await waitFor(() => silentClose, 3_000);
  check(silentClose?.code === 4000, 'a client that skips hello is closed (4000)');

  // -- 3. fake extension -----------------------------------------------------------
  section('3. Fake extension engine');
  ext = await fakeExtension(PORT);
  check(ext.welcome?.id === 'engine-1' && ext.welcome.version === VERSION && ext.welcome.halted?.global === false,
    'extension welcomed as engine-1', JSON.stringify({ id: ext.welcome?.id, version: ext.welcome?.version }));
  check(typeof ext.welcome.repoRoot === 'string' && path.isAbsolute(ext.welcome.repoRoot.replace(/\//g, path.sep)), 'welcome carries the repo root');
  let pong = false;
  ext.ws.on('message', (m) => { if (m.type === 'pong') pong = true; });
  ext.ws.send({ type: 'ping', at: Date.now() });
  await waitFor(() => pong, 2_000);
  check(pong, 'ping/pong keep-alive', 'the MV3 worker stays alive');
  check((await health(PORT)).extension === true, '/health reports the extension');

  // -- 4. two shims ---------------------------------------------------------------
  section('4. Two agents through two real MCP shims');
  const shimEnv = { G9_PORT: String(PORT), G9_HOME: HOME, G9_TIMEOUT_MS: '6000' };
  shimA = new Mcp(SHIM, shimEnv, 'agent-alpha');
  shimB = new Mcp(SHIM, shimEnv, 'agent-beta');
  const [initA, initB] = await Promise.all([shimA.init(), shimB.init()]);
  check(initA.result?.serverInfo?.name === 'g9-browser-agent' && initA.result.serverInfo.version === VERSION, 'initialize', initA.result?.protocolVersion);
  check(initB.result?.instructions?.includes('Two engines, one set of tools'), 'v2 instructions delivered', `${initB.result?.instructions?.length} chars`);
  const list = await shimA.request('tools/list');
  const tools = list.result?.tools ?? [];
  check(tools.length === 15, 'tools/list: 15 tools', tools.map((t) => t.name).join(' ').slice(0, 80));
  const schemaProblems = tools.filter((t) => !t.description || t.inputSchema?.type !== 'object' ||
    Object.values(t.inputSchema.properties ?? {}).some((p) => !p || typeof p !== 'object'));
  check(!schemaProblems.length, 'every schema is an object schema with a description', schemaProblems.map((t) => t.name).join(','));
  check(tools.some((t) => t.name === 'browser_engine'), 'browser_engine is listed');
  const resources = await shimA.request('resources/list');
  check((resources.result?.resources ?? []).length === 2, 'resources/list: guide + status');
  const guide = await shimA.request('resources/read', { uri: 'g9://guide' });
  check(guide.result?.contents?.[0]?.text?.includes('ownership'), 'g9://guide readable');

  // -- 5. status composition --------------------------------------------------------
  section('5. browser_status composition');
  const stA = await shimA.call('browser_status');
  const s = stA.data ?? {};
  check(stA.ok && s.daemon?.version === VERSION && s.daemon?.port === PORT, 'daemon block', JSON.stringify(s.daemon ?? {}).slice(0, 90));
  check(s.engines?.length === 1 && s.engines[0].kind === 'extension' && s.engines[0].engineId === 'engine-1', 'engines list the extension');
  const names = (s.agents ?? []).map((a) => a.name).sort();
  check(names.includes('agent-alpha') && names.includes('agent-beta'), 'agents list both shims by their MCP client names', names.join(', '));
  check(s.halted?.global === false && s.halted?.mine === false, 'halted { global, mine }');
  check(s.health?.consoleErrors === 1, 'engine-local status carried (health)');
  check(Number.isInteger(s.current?.tabId) && s.current.tabId !== 101, 'engine tab ids come back as G9 handles', `101 → ${s.current?.tabId}`);
  check(s.you?.current === s.current?.tabId, 'the engine\'s target became the agent\'s current tab');
  check(s.capabilities?.extension === true && s.capabilities?.popout === true, 'capabilities block');
  check(s.shim?.version === VERSION, 'shim version reported');

  // -- 6. relay and id rewriting ----------------------------------------------------
  section('6. Relay and tab-id rewriting');
  const tl = await shimA.call('browser_tabs', { action: 'list' });
  const rows = tl.data?.tabs ?? [];
  const h101 = rows.find((r) => r.title === TABS[0].title)?.tabId;
  const h102 = rows.find((r) => r.title === 'Popup')?.tabId;
  check(Number.isInteger(h101) && Number.isInteger(h102) && h101 !== 101 && h102 !== 102, 'list returns handles, not Chrome ids', `101→${h101}, 102→${h102}`);
  check(rows.every((r) => r.engine === 'engine-1'), 'each row names its engine');
  check(rows.find((r) => r.tabId === h102)?.openerTabId === h101, 'openerTabId rewritten too');
  const snap = await shimA.call('browser_snapshot', { tabId: h102, maxNodes: 321 });
  const lastSnap = ext.calls.filter((c) => c.tool === 'browser_snapshot').at(-1);
  check(lastSnap?.args?.tabId === 102 && lastSnap.args.maxNodes === 321, 'the extension receives the Chrome id and the arguments', JSON.stringify(lastSnap?.args));
  check(lastSnap?.caller?.name === 'agent-alpha' && /^agent-\d+$/.test(lastSnap?.caller?.agentId ?? ''), 'caller { agentId, name } forwarded', JSON.stringify(lastSnap?.caller));
  check(JSON.stringify(snap.data?.tabIds) === JSON.stringify([h101, h102]), 'tabIds[] in results rewritten to handles');
  check(snap.data?.echoedArgs?.tabId === h102, 'nested tab ids in results are rewritten back too', `102 → ${snap.data?.echoedArgs?.tabId}`);
  const shot = await shimA.call('browser_screenshot', { tabId: h101 });
  check(shot.raw.result?.content?.some((c) => c.type === 'image' && c.mimeType === 'image/jpeg'), 'screenshots arrive as MCP image blocks');
  const unknown = await shimA.call('browser_snapshot', { tabId: 424242 });
  check(!unknown.ok && /does not exist/.test(unknown.text), 'an unknown handle is refused with the fix', unknown.text.slice(0, 80));

  // -- 7. ownership --------------------------------------------------------------
  section('7. Ownership between agents');
  ext.responders.set('browser_interact', slowInteract(250));
  const clickA = await shimA.call('browser_interact', { action: 'click', ref: 'e1', tabId: h101 });
  check(clickA.ok && clickA.data?.delivery === 'delivered', 'agent A clicks: its first mutating call claims the tab');
  const clickB = await shimB.call('browser_interact', { action: 'click', ref: 'e1', tabId: h101 });
  check(!clickB.ok && /owned by agent-\d+ \(agent-alpha\)/.test(clickB.text) && /force:true/.test(clickB.text),
    'agent B is refused, with the owner named and the fix', clickB.text.slice(0, 100));
  const readB = await shimB.call('browser_snapshot', { tabId: h101 });
  check(readB.ok, 'agent B may still READ the tab');
  const stB = await shimB.call('browser_status');
  check((stB.data?.agents ?? []).find((a) => a.name === 'agent-alpha')?.owned?.includes(h101), 'status shows who owns what');
  check(ext.messages.some((m) => m.type === 'agents' && m.agents.some((a) => a.owned.includes(101))), 'the extension is told the owners (Chrome ids)');

  // -- 8. per-tab serialisation ------------------------------------------------------
  section('8. Per-tab queue');
  ext.maxActive.clear();
  const t0 = Date.now();
  const burst = await Promise.all([
    shimA.call('browser_interact', { action: 'click', ref: 'e2', tabId: h101 }),
    shimA.call('browser_interact', { action: 'type', ref: 'e3', text: 'x', tabId: h101 }),
    shimA.call('browser_interact', { action: 'click', ref: 'e4', tabId: h101 }),
  ]);
  const elapsed = Date.now() - t0;
  check(burst.every((r) => r.ok), 'three concurrent mutating calls all complete');
  check(ext.maxActive.get(101) === 1 && elapsed >= 700, 'they ran strictly one at a time on that tab', `max concurrency ${ext.maxActive.get(101)}, ${elapsed} ms`);
  const refOrder = ext.calls.filter((c) => c.tool === 'browser_interact').slice(-3).map((c) => c.args.ref);
  check(JSON.stringify(refOrder) === JSON.stringify(['e2', 'e3', 'e4']), 'in arrival order', refOrder.join(','));
  // A read is not queued behind a slow write.
  const slowWrite = shimA.call('browser_interact', { action: 'click', ref: 'e5', tabId: h101 });
  await sleep(40);
  const r0 = Date.now();
  const quickRead = await shimB.call('browser_snapshot', { tabId: h101 });
  check(quickRead.ok && Date.now() - r0 < 200, 'reads are not queued behind a mutating call', `${Date.now() - r0} ms`);
  await slowWrite;

  // -- 9. halts ---------------------------------------------------------------------
  section('9. Stop: the panel\'s halt, then the desktop\'s');
  ext.ws.send({ type: 'event', event: 'halt', data: { halted: true, by: 'panel' } });
  await waitFor(async () => (await shimA.call('browser_status')).data?.halted?.global === true, 3_000);
  const haltedA = await shimA.call('browser_snapshot', { tabId: h101 });
  const haltedB = await shimB.call('browser_tabs', { action: 'list' });
  check(!haltedA.ok && /pressed Stop in the G9 side panel/.test(haltedA.text), 'agent A blocked by the panel\'s Stop', haltedA.text.slice(0, 80));
  check(!haltedB.ok && /pressed Stop/.test(haltedB.text), 'agent B blocked too (even browser_tabs list)');
  const haltStatus = await shimB.call('browser_status');
  check(haltStatus.ok && haltStatus.data?.halted?.global === true && haltStatus.data?.halted?.by === 'panel', 'browser_status still answers, and says why');
  ext.ws.send({ type: 'event', event: 'halt', data: { halted: false, by: 'panel' } });
  await waitFor(async () => (await shimA.call('browser_status')).data?.halted?.global === false, 3_000);
  check((await shimA.call('browser_snapshot', { tabId: h101 })).ok, 'the panel\'s Resume lifts it');

  ui = await uiClient(PORT);
  check(ui.welcome?.id?.startsWith('ui-'), 'desktop (ui) client connects without an Origin', ui.welcome?.id);
  const extHaltBefore = ext.messages.filter((m) => m.type === 'halt').length;
  const haltRes = await ui.admin('halt');
  check(haltRes.ok, 'admin halt');
  await waitFor(() => ext.messages.filter((m) => m.type === 'halt').length > extHaltBefore, 2_000);
  check(ext.messages.filter((m) => m.type === 'halt').at(-1)?.halted === true, 'the extension is told {type:"halt", halted:true}');
  const desktopHalted = await shimA.call('browser_snapshot', { tabId: h101 });
  check(!desktopHalted.ok && /G9 desktop app/.test(desktopHalted.text), 'agents blocked by the desktop Stop');
  check(ui.events.some((e) => e.topic === 'halt'), 'the UI receives the halt event');
  await ui.admin('resume');
  await waitFor(() => ext.messages.filter((m) => m.type === 'halt').at(-1)?.halted === false, 2_000);
  check((await shimA.call('browser_snapshot', { tabId: h101 })).ok, 'admin resume lifts it, and the extension is told');
  const agentsNow = (await shimA.call('browser_status')).data?.agents ?? [];
  const alphaId = agentsNow.find((a) => a.name === 'agent-alpha')?.id;
  await ui.admin('haltAgent', { agentId: alphaId });
  const onlyA = await shimA.call('browser_snapshot', { tabId: h101 });
  const notB = await shimB.call('browser_snapshot', { tabId: h101 });
  check(!onlyA.ok && /stopped this agent/.test(onlyA.text) && notB.ok, 'a per-agent halt blocks only that agent');
  await ui.admin('resumeAgent', { agentId: alphaId });
  check((await shimA.call('browser_snapshot', { tabId: h101 })).ok, 'and resumeAgent lifts it');
  const settingsGet = await ui.admin('settings.get');
  check(settingsGet.ok && settingsGet.result?.port === 8765 && settingsGet.result?.idleExitMinutes === 60, 'admin settings.get returns the defaults');
  const badSet = await ui.admin('settings.set', { patch: { stealth: 'ninja' } });
  check(!badSet.ok && /stealth/.test(badSet.error), 'admin settings.set validates');
  const runs = await ui.admin('runs.list');
  check(runs.ok && Array.isArray(runs.result?.runs), 'admin runs.list');
  const sched = await ui.admin('schedule.add', { entry: { target: 'suite:smoke', daily: '03:15', enabled: false } });
  const schedList = await ui.admin('schedule.list');
  check(sched.ok && schedList.result?.entries?.some((e) => e.id === sched.result.id && e.target === 'suite:smoke'), 'admin schedule.add/list persist an entry');
  // The entry id travels as entryId: the message's own id is the request id.
  const removed = await ui.admin('schedule.remove', { entryId: sched.result.id });
  check(removed.ok && removed.result?.removed === sched.result.id, 'admin schedule.remove {entryId} (no clash with the request id)');
  // The desktop's Schedule view sends its own words (suite/at/env/engine) — as
  // desktop/lib/daemon-client.mjs buildAdminMessage frames them: spread AND as args.
  const desktopEntry = { suite: 'smoke', env: 'staging', at: '06:30', everyMinutes: null, enabled: false,
    engine: { browser: 'auto', headless: true, humanize: 'human', stealth: 'off', profile: 'automation' } };
  const dAdd = await ui.admin('schedule.add', { ...desktopEntry, entry: desktopEntry, args: { ...desktopEntry, entry: desktopEntry } });
  const dRow = (await ui.admin('schedule.list')).result?.entries?.find((e) => e.id === dAdd.result?.id);
  check(dAdd.ok && dRow?.target === 'smoke' && dRow.daily === '06:30' && dRow.at === '06:30' && dRow.suite === 'smoke' &&
    dRow.args.join(' ') === '--env staging --headless --humanize human --stealth off --profile automation',
  'admin schedule.add accepts the desktop\'s entry shape', dAdd.ok ? dRow?.args?.join(' ') : dAdd.error);
  if (dAdd.ok) await ui.admin('schedule.remove', { entryId: dAdd.result.id });
  const state = await ui.admin('state');
  check(state.ok && state.result?.agents?.length === 2 && state.result?.engines?.length === 1, 'admin state snapshot');
  check(Array.isArray(state.result?.tabs) && state.result.tabs.length === 2 && state.result.tabs.every((t) => Number.isInteger(t.tabId)),
    'admin state lists the tabs of every engine', `${state.result?.tabs?.length} tab(s)`);
  // An agent cannot use admin ops (it cannot resume a halt it did not press, for one).
  const agentWs = await WsClient.connect(`ws://127.0.0.1:${PORT}/g9`);
  const agentMsgs = [];
  agentWs.on('message', (m) => agentMsgs.push(m));
  agentWs.send({ type: 'hello', role: 'agent', version: VERSION, client: { name: 'sneaky' } });
  await waitFor(() => agentMsgs.some((m) => m.type === 'welcome'), 2_000);
  agentWs.send({ type: 'admin', id: 7, op: 'resume' });
  await waitFor(() => agentMsgs.some((m) => m.type === 'result'), 2_000);
  check(agentMsgs.find((m) => m.type === 'result')?.ok === false, 'agents are refused admin ops');
  agentWs.close();

  // -- 9b. extension requests, watch, extension update ----------------------------------
  section('9b. Extension requests, live watch, extension update');
  const request = (msg) => new Promise((resolve) => {
    const onMsg = (m) => {
      if ((m.type === 'response' || m.type === 'flowlibResult') && m.id === msg.id) {
        ext.ws.removeListener('message', onMsg);
        resolve(m);
      }
    };
    ext.ws.on('message', onMsg);
    ext.ws.send(msg);
  });
  const info = await request({ type: 'request', id: 'r1', op: 'info' });
  check(info.ok && info.result?.version === VERSION && info.result.agents?.length === 2, 'request info → version and agents for the panel');
  const flowlib = await request({ type: 'flowlib', id: 'f1', op: 'list' });
  check(flowlib.ok === false && /No flow library is configured/.test(flowlib.error), 'flowlib without a project explains itself', (flowlib.error ?? '').slice(0, 70));
  const unknownOp = await request({ type: 'request', id: 'r2', op: 'bogus' });
  check(unknownOp.ok === false && /Unknown request op/.test(unknownOp.error), 'an unknown request op is refused by name');

  const watchBefore = ext.messages.filter((m) => m.type === 'watch').length;
  const watched = await ui.admin('watch', { tabId: h101 });
  await waitFor(() => ext.messages.filter((m) => m.type === 'watch').length > watchBefore, 2_000);
  const watchMsg = ext.messages.filter((m) => m.type === 'watch').at(-1);
  check(watched.ok && watchMsg?.tabId === 101 && watchMsg.on === true, 'admin watch → the extension is asked to stream (Chrome id)', JSON.stringify(watchMsg));
  const framesBefore = ui.events.filter((e) => e.topic === 'frame').length;
  ext.ws.send({ type: 'event', event: 'frame', data: { tabId: 101, data: '/9j/4AAQSkZJRg==', metadata: { deviceWidth: 800 }, at: Date.now() } });
  ext.ws.send({ type: 'event', event: 'pointer', data: { tabId: 101, sample: { at: Date.now(), x: 5, y: 6, buttons: 0, type: 'mouseMoved' } } });
  await waitFor(() => ui.events.filter((e) => e.topic === 'frame').length > framesBefore && ui.events.some((e) => e.topic === 'pointer'), 2_000);
  const frameEvt = ui.events.filter((e) => e.topic === 'frame').at(-1);
  const pointerEvt = ui.events.filter((e) => e.topic === 'pointer').at(-1);
  check(frameEvt?.data?.tabId === h101 && frameEvt.data.data === '/9j/4AAQSkZJRg==', 'frames reach the watching UI, as handles');
  check(pointerEvt?.data?.tabId === h101 && pointerEvt.data.sample?.x === 5, 'pointer samples reach it too (the cursor is drawn from them)');
  await ui.admin('unwatch', { tabId: h101 });
  await waitFor(() => ext.messages.filter((m) => m.type === 'watch').at(-1)?.on === false, 2_000);
  check(ext.messages.filter((m) => m.type === 'watch').at(-1)?.on === false, 'unwatch → the extension is told to stop');
  const watchRun = (await ui.admin('runs.list')).result?.runs?.find((r) => r.kind === 'watch');
  check(watchRun?.frames === 1 && fs.existsSync(path.join(watchRun.dir, 'pointer.jsonl')), 'the watch was spooled into a run (frames + pointer track)', watchRun?.runId);

  const reloadsBefore = ext.messages.filter((m) => m.type === 'reload').length;
  const install = await ui.admin('extension.install', {});
  check(install.ok && install.result?.version && install.result.files > 5, 'admin extension.install copies the extension into G9_HOME/extension', `${install.result?.files} files, ${install.result?.method}`);
  check(fs.existsSync(path.join(HOME, 'extension', 'manifest.json')) && fs.existsSync(path.join(HOME, 'extension', 'g9-install.json')), 'the folder is complete, with an install marker');
  check(!fs.existsSync(path.join(HOME, 'extension.new')) && !fs.existsSync(path.join(HOME, 'extension.old')), 'no staging folder left behind');
  await waitFor(() => ext.messages.filter((m) => m.type === 'reload').length > reloadsBefore, 3_000);
  check(ext.messages.filter((m) => m.type === 'reload').length > reloadsBefore && install.result.reloadSent === 1, 'and the connected extension is told to reload');
  const again = await ui.admin('extension.install', {});
  check(again.ok && again.result.previousVersion === install.result.version, 'an update replaces it in place (same folder, so the same extension id)');

  const second = spawnDaemon(PORT, tempHome('second'));
  const secondExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still running'), 8_000);
    second.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  check(secondExit === 0, 'a second daemon on the same port exits 0 and leaves the first alone', `exit ${secondExit}`);
  check((await health(PORT)).pid === h.pid, 'the first daemon is untouched');

  // One daemon per G9_HOME, not only per port: a second one on ANOTHER port with this HOME would
  // run every schedule entry twice and rewrite settings.json from its own memory (daemon review,
  // 2026-09-22). It exits 0 and says which port to use.
  const otherPort = await freePort();
  const sameHome = spawnDaemon(otherPort, HOME);
  const sameHomeExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still running'), 8_000);
    sameHome.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  const daemonLog = fs.readFileSync(path.join(HOME, 'logs', 'daemon.log'), 'utf8');
  check(sameHomeExit === 0, 'a second daemon on the same G9_HOME (another port) exits 0', `exit ${sameHomeExit}`);
  check(/already has g9d pid \d+ on port \d+/.test(daemonLog), 'and the log names the daemon that owns the home');
  check(new RegExp(`set G9_PORT=${PORT}`, 'i').test(daemonLog), 'with the port to use');
  check(JSON.parse(fs.readFileSync(path.join(HOME, 'daemon.json'), 'utf8')).pid === h.pid, 'daemon.json still names the first daemon');
  check((await health(PORT)).pid === h.pid, 'which is still serving');
  check(!(await health(otherPort).then(() => true, () => false)), 'and nothing is listening on the other port');

  // -- 10. dialogs --------------------------------------------------------------------
  section('10. A dialog fails the pending call at once');
  ext.responders.set('browser_interact', slowInteract(10));
  const blocked = shimA.call('browser_interact', { action: 'click', ref: 'never', tabId: h101 });
  await waitFor(() => ext.calls.some((c) => c.tool === 'browser_interact' && c.args.ref === 'never'), 2_000);
  const d0 = Date.now();
  ext.ws.send({ type: 'event', event: 'dialog', data: { tabId: 101, type: 'confirm', message: 'Delete order?' } });
  const blockedRes = await blocked;
  check(!blockedRes.ok && /JavaScript confirm \("Delete order\?"\)/.test(blockedRes.text) && Date.now() - d0 < 1000,
    'the call fails fast naming the dialog and browser_dialog', `${Date.now() - d0} ms`);
  check((await shimA.call('browser_dialog', { accept: true, tabId: h101 })).ok, 'browser_dialog goes through');

  // -- 10b. delivery states -----------------------------------------------------------
  section('10b. An input error names its delivery state, to the agent and to programs');
  // Live round 3 (both engines): interact.js set err.delivery, but every relay kept only the
  // message, so "missed" (it landed ELSEWHERE) could not be told from "not sent" without parsing
  // prose. runTool now starts the message with a [delivery: …] tag; the protocol carries fields too.
  const deliveryError = (state, text, extra = {}) => Object.assign(new Error(text), { delivery: state }, extra);
  ext.responders.set('browser_interact', (msg) => {
    if (msg.args.ref === 'missed') {
      throw deliveryError('missed', '[delivery: missed; hit <div#veil>] The click reached the page, but not "Save": it landed on <div#veil> at (10, 20). The click was NOT repeated.', { hit: '<div#veil>' });
    }
    if (msg.args.ref === 'hidden') {
      throw deliveryError('not-delivered', '[delivery: not-delivered; tab hidden] The click was not sent: the attached tab is HIDDEN (document.visibilityState="hidden").', { hidden: true });
    }
    if (msg.args.ref === 'partial') {
      throw deliveryError('partial', '[delivery: partial; 3 of 12 input events sent; tab hidden] The scroll was interrupted: the tab became HIDDEN after 3 of 12 input events.', { hidden: true });
    }
    return { delivery: 'delivered' };
  });
  for (const [ref, state, tag] of [
    ['missed', 'missed', '[delivery: missed; hit <div#veil>] '],
    ['hidden', 'not-delivered', '[delivery: not-delivered; tab hidden] '],
    ['partial', 'partial', '[delivery: partial; 3 of 12 input events sent; tab hidden] '],
  ]) {
    const res = await shimA.call('browser_interact', { action: 'click', ref, tabId: h101 });
    check(!res.ok && res.text.startsWith(tag), `${state}: the agent reads the state first`, res.text.slice(0, 70));
  }
  const rawAgent = await WsClient.connect(`ws://127.0.0.1:${PORT}/g9`);
  const rawMsgs = [];
  rawAgent.on('message', (m) => rawMsgs.push(m));
  rawAgent.send({ type: 'hello', role: 'agent', version: VERSION, client: { name: 'raw-delivery' } });
  await waitFor(() => rawMsgs.some((m) => m.type === 'welcome'), 5_000);
  rawAgent.send({ type: 'call', id: 77, tool: 'browser_interact', args: { action: 'click', ref: 'missed', tabId: h102 } });
  await waitFor(() => rawMsgs.some((m) => m.type === 'result' && m.id === 77), 5_000);
  const rawRes = rawMsgs.find((m) => m.type === 'result' && m.id === 77);
  check(rawRes?.ok === false && rawRes.delivery === 'missed' && rawRes.hit === '<div#veil>' && rawRes.hidden === false && /^\[delivery: missed/.test(rawRes.error),
    'the daemon result carries delivery/hit/hidden as fields (DAEMON_PROTOCOL §3)', JSON.stringify({ delivery: rawRes?.delivery, hit: rawRes?.hit }));
  rawAgent.close();
  ext.responders.set('browser_interact', slowInteract(10));

  // -- 11. disconnect releases claims -----------------------------------------------
  section('11. An agent disconnect releases its claims');
  shimA.close();
  await waitFor(async () => !(await shimB.call('browser_status')).data?.agents?.some((a) => a.name === 'agent-alpha'), 5_000);
  const afterA = await shimB.call('browser_interact', { action: 'click', ref: 'e9', tabId: h101 });
  check(afterA.ok, 'agent B can now drive the tab agent A held');
  const stAfter = await shimB.call('browser_status');
  check(stAfter.data?.owned?.includes(h101), 'and owns it');

  // -- 12. extension disconnect mid-call --------------------------------------------
  section('12. The extension disconnecting mid-call');
  const hanging = shimB.call('browser_interact', { action: 'click', ref: 'never', tabId: h101 });
  await waitFor(() => ext.calls.filter((c) => c.args?.ref === 'never').length >= 2, 2_000);
  const c0 = Date.now();
  ext.ws.close(1000, 'browser closed');
  const hangRes = await hanging;
  check(!hangRes.ok && /disconnected/.test(hangRes.text) && Date.now() - c0 < 1500, 'the pending call fails at once with the reason', `${Date.now() - c0} ms`);
  const noExt = await shimB.call('browser_snapshot', { tabId: h101 });
  check(!noExt.ok, 'its tab handles are gone', noExt.text.slice(0, 80));
  const statusNoExt = await shimB.call('browser_status');
  check(statusNoExt.ok && statusNoExt.data?.engines?.length === 0, 'status: no engines, and it says what to do', (statusNoExt.data?.hint ?? '').slice(0, 70));

  // -- 12b. extension identity across reconnects (decision D-c), F5, F7 ------------------
  section('12b. An extension that reconnects keeps its engine id, tabs, claims and sessions (D-c)');
  const identity = { instanceId: 'selftest-instance-0001', loadId: 'selftest-load-A' };
  const tabsNow = TABS.map(({ tabId, url }) => ({ tabId, url }));
  const extA = await fakeExtension(PORT, { client: { ...identity, tabs: tabsNow } });
  const idA = extA.welcome?.id;
  check(/^engine-\d+$/.test(idA ?? ''), 'an extension with an instanceId connects', idA);
  extA.ws.send({ type: 'event', event: 'tabs', data: { tabs: TABS } });
  const listA = await shimB.call('browser_tabs', { action: 'list' });
  const hA = (listA.data?.tabs ?? []).find((t) => t.engine === idA && t.url === TABS[0].url)?.tabId;
  const hB = (listA.data?.tabs ?? []).find((t) => t.engine === idA && t.url === TABS[1].url)?.tabId;
  check(Number.isInteger(hA) && Number.isInteger(hB), 'its tabs have handles', `${hA}, ${hB}`);
  extA.responders.set('browser_interact', () => ({ delivery: 'delivered' }));
  const claimA = await shimB.call('browser_interact', { action: 'click', ref: 'e1', tabId: hA });
  const named = await shimB.call('browser_tabs', { action: 'session', name: 'buyer', tabId: hB });
  check(claimA.ok && named.ok, 'agent B claims one tab and names the other');
  const uiActivityBefore = ui.events.filter((e) => e.topic === 'activity' && e.data?.engine === idA && e.data?.kind === 'tool').length;
  extA.ws.send({ type: 'event', event: 'activity', data: { kind: 'tool', tool: 'browser_interact', by: 'agent-beta', relayed: true, ok: true } });
  extA.ws.send({ type: 'event', event: 'activity', data: { kind: 'tool', tool: 'browser_recording', ok: true, detail: 'replay from the side panel' } });
  await sleep(200);
  const engineTools = ui.events.filter((e) => e.topic === 'activity' && e.data?.engine === idA && e.data?.kind === 'tool').slice(uiActivityBefore);
  check(engineTools.length === 1 && engineTools[0].data.tool === 'browser_recording', 'F7: the echo of a relayed call is not forwarded; a panel action is', engineTools.map((e) => e.data.tool).join(','));
  const lastCall = extA.calls.filter((c) => c.tool === 'browser_interact').at(-1);
  check(lastCall?.caller?.relayed === true, 'F7: relayed calls carry caller.relayed');

  extA.ws.close(1000, 'service worker stopped');
  await waitFor(async () => (await shimB.call('browser_tabs', { action: 'list' })).data?.tabs?.some((t) => t.reconnecting), 3_000);
  const whileAway = await shimB.call('browser_snapshot', { tabId: hA });
  check(!whileAway.ok && /reconnecting/.test(whileAway.text), 'while it is away, a call on its tab says "reconnecting"', whileAway.text.slice(0, 90));

  const extA2 = await fakeExtension(PORT, { client: { ...identity, tabs: tabsNow } });
  check(extA2.welcome?.id === idA, 'the same instanceId gets the same engine id back', extA2.welcome?.id);
  const snapBack = await shimB.call('browser_snapshot', { tabId: hA });
  check(snapBack.ok && extA2.calls.at(-1)?.args?.tabId === 101, 'the same handle reaches the same Chrome tab');
  const stBack = await shimB.call('browser_status');
  check(stBack.data?.owned?.includes(hA), 'the claim survived the reconnect');
  check((stBack.data?.sessions ?? []).some((x) => x.session === 'buyer' && x.tabId === hB), 'and so did the session name');

  // An extension reload whose new socket beats the old one's close: the old one is superseded.
  const extA3 = await fakeExtension(PORT, { client: { ...identity, loadId: 'selftest-load-B', tabs: [{ tabId: 101, url: TABS[0].url }] } });
  await waitFor(() => extA2.closed, 3_000);
  check(extA3.welcome?.id === idA && /superseded/.test(extA2.closed?.reason ?? ''), 'a reconnect racing the old socket supersedes it', `${extA2.closed?.code} ${extA2.closed?.reason}`);
  const afterReload = await shimB.call('browser_tabs', { action: 'list' });
  const reloadRows = (afterReload.data?.tabs ?? []).filter((t) => t.engine === idA);
  check(reloadRows.some((t) => t.tabId === hA) && !reloadRows.some((t) => t.tabId === hB),
    'after a reload, a tab that is gone is dropped; the one still showing its page keeps its handle', reloadRows.map((t) => t.tabId).join(','));

  // F5 over the wire: the flow is flowId, the correlation id is the sender's own.
  const flowAnswer = await new Promise((resolve) => {
    const onMsg = (m) => { if (m.type === 'flowlibResult' && m.id === 77) { extA3.ws.removeListener('message', onMsg); resolve(m); } };
    extA3.ws.on('message', onMsg);
    extA3.ws.send({ type: 'flowlib', id: 77, op: 'read', flowId: 'checkout' });
  });
  check(flowAnswer.ok === false && /No flow library is configured/.test(flowAnswer.error), 'F5: flowlib answers the correlation id it was sent (flowId names the flow)');
  extA3.ws.close(1000, 'selftest done');

  // -- 13. malformed frames ------------------------------------------------------------
  section('13. Protocol robustness');
  const evil = await WsClient.connect(`ws://127.0.0.1:${PORT}/g9`, { origin: 'chrome-extension://test' });
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0xff; // masked, 64-bit length
  header.writeBigUInt64BE(1n << 40n, 2);
  evil.socket.write(header);
  await sleep(300);
  check((await health(PORT)).ok === true, 'an oversized frame costs the connection, never the daemon');
  check(shimB.nonJson.length === 0 && shimA.nonJson.length === 0, 'shim stdout carried only JSON-RPC', shimB.nonJson.slice(0, 1).join(''));

  // -- 14. the v1 entry point ---------------------------------------------------------
  section('14. bridge/src/server.js forwards to the shim');
  const fwd = new Mcp(FORWARDER, shimEnv, 'v1-config');
  const fwdInit = await fwd.init();
  const fwdTools = await fwd.request('tools/list');
  check(fwdInit.result?.serverInfo?.version === VERSION && (fwdTools.result?.tools ?? []).length === 15, 'the v1 path speaks v2 MCP (15 tools)');
  const fwdStatus = await fwd.call('browser_status');
  check(fwdStatus.ok && fwdStatus.data?.daemon?.port === PORT, 'and reaches the same daemon');
  check(/v1 entry point/.test(fwd.stderr) && /mcp\/shim\.mjs/.test(fwd.stderr), 'with a one-line note on stderr', fwd.stderr.trim().split('\n')[0].slice(0, 80));
  fwd.close();

  // -- 15. shim starts the daemon -------------------------------------------------------
  section('15. The shim starts the daemon when none runs');
  const PORT2 = await freePort();
  const HOME2 = tempHome('autostart');
  const auto = new Mcp(SHIM, { G9_PORT: String(PORT2), G9_HOME: HOME2 }, 'autostarter');
  await auto.init();
  const autoStatus = await auto.call('browser_status', {}, 20_000);
  check(autoStatus.ok && autoStatus.data?.daemon?.port === PORT2, 'browser_status answered by a daemon the shim started', `port ${PORT2}`);
  const h2 = await health(PORT2).catch(() => null);
  check(h2?.name === 'g9d' && h2.pid !== h.pid, '/health on the new port is a separate g9d', `pid ${h2?.pid}`);
  check(/started g9d \(pid \d+\)/.test(auto.stderr), 'the shim said so on stderr');
  check(fs.existsSync(path.join(HOME2, 'daemon.json')), 'it uses the G9_HOME it was given');
  auto.close();
  // Stop the daemon the shim started (we started it, so we stop it).
  const ui2 = await uiClient(PORT2);
  await ui2.admin('shutdown');
  const gone = await waitFor(async () => { try { await health(PORT2); return false; } catch { return true; } }, 8_000);
  const cleaned = await waitFor(() => !fs.existsSync(path.join(HOME2, 'daemon.json')), 8_000);
  check(gone && cleaned, 'admin shutdown stops it and it removes its daemon.json');
  if ((!gone || !cleaned) && h2?.pid) { try { process.kill(h2.pid); } catch { /* gone */ } }

  // -- 16. a v1 bridge on the port --------------------------------------------------------
  section('16. A v1 bridge on the port is named, not guessed at');
  const PORT3 = await freePort();
  const fakeBridge = http.createServer((req, res) => {
    if (req.url?.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, extensionConnected: true, version: '1.7.21', port: PORT3, pid: 4242 }));
      return;
    }
    res.writeHead(426);
    res.end();
  });
  fakeBridge.on('upgrade', (_req, socket) => { socket.write('HTTP/1.1 403 Forbidden Origin\r\nConnection: close\r\n\r\n'); socket.destroy(); });
  await new Promise((r) => fakeBridge.listen(PORT3, '127.0.0.1', r));
  const blockedShim = new Mcp(SHIM, { G9_PORT: String(PORT3), G9_HOME: tempHome('v1') }, 'blocked');
  const blockedInit = await blockedShim.init();
  check(!!blockedInit.result?.serverInfo, 'MCP still works (initialize) — no silent exit');
  const v1Status = await blockedShim.call('browser_status', {}, 20_000);
  check(!v1Status.ok && /v1 bridge/.test(v1Status.text) && /4242/.test(v1Status.text), 'every tool fails naming the v1 bridge, its pid and the fix', v1Status.text.slice(0, 100));
  blockedShim.close();
  await new Promise((r) => fakeBridge.close(r));

  // -- 16b. idle exit ---------------------------------------------------------------------
  section('16b. Idle exit (settings.idleExitMinutes, shortened for the test)');
  const PORT4 = await freePort();
  const HOME4 = tempHome('idle');
  const idle = spawnDaemon(PORT4, HOME4, { G9_IDLE_EXIT_MS: '1500' });
  await waitFor(async () => (await health(PORT4)).name === 'g9d', 8_000);
  const holder = await uiClient(PORT4);
  await sleep(2_500);
  check(idle.exitCode === null && (await health(PORT4)).ok, 'it never exits while a client is connected');
  holder.ws.close();
  const idleExit = await waitFor(() => idle.exitCode !== null, 8_000);
  check(idleExit && idle.exitCode === 0, 'it exits by itself once idle', `exit ${idle.exitCode}`);
  check(!fs.existsSync(path.join(HOME4, 'daemon.json')), 'and removes its daemon.json');
  check(/idle/.test(fs.readFileSync(path.join(HOME4, 'logs', 'daemon.log'), 'utf8')), 'the log says why it stopped');

  // -- 17. injected-code escaping (kept from v1) ------------------------------------------
  section('17. Escaping in injected page code');
  await injectedEscapeCheck();

  // -- 18. clean shutdown --------------------------------------------------------------
  section('18. Clean shutdown');
  shimB.close();
  await ui.admin('shutdown');
  const down = await waitFor(() => daemon.exitCode !== null, 8_000);
  check(down && daemon.exitCode === 0, 'admin shutdown exits 0', `exit ${daemon.exitCode}`);
  check(!fs.existsSync(path.join(HOME, 'daemon.json')), 'daemon.json removed on exit');
} catch (err) {
  bad('unexpected exception', String(err?.stack ?? err));
} finally {
  for (const child of children) {
    try { child.kill(); } catch { /* gone */ }
  }
  await sleep(300);
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
  }
}

/**
 * A whole class of silent corruption, caught by reading the source (v1.0.13).
 *
 * Half the extension's page logic is a template literal evaluated in the page,
 * so every escape is parsed twice. `\s` is not a valid JavaScript string escape,
 * so a template literal quietly reduces it to a bare `s` — and the page then
 * runs `/s+/g`. `browser_snapshot mode:"a11y+text"` shipped that from v1.0.0 to
 * v1.0.13, replacing every letter "s" in the extracted text with a space.
 * Inside a template literal, a regex escape MUST be written `\\s`.
 */
async function injectedEscapeCheck() {
  const dirs = ['lib', 'tools'].map((d) => path.join(ROOT, 'extension', d));
  const offenders = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.js')) continue;
      const src = stripComments(fs.readFileSync(path.join(dir, name), 'utf8'));
      for (const body of templateLiterals(src)) {
        const hit = body.match(/(?:^|[^\\])\\([sdwSDWbB])/);
        if (hit) offenders.push(`${name}: \\${hit[1]}`);
      }
    }
  }
  check(!offenders.length, 'no single-escaped regex classes in injected code', offenders.join(', ') || 'template literals are parsed twice');
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function templateLiterals(src) {
  const bodies = [];
  let i = 0;
  while ((i = src.indexOf('`', i)) !== -1) {
    let j = i + 1;
    while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
    bodies.push(src.slice(i + 1, j));
    i = j + 1;
  }
  return bodies;
}

console.log(`\n${failed === 0 ? color(32, `${passed} passed, 0 failed`) : color(31, `${passed} passed, ${failed} failed`)}`);
if (failed === 0) {
  console.log(color(90, 'The daemon, the MCP shim, routing, ownership, queues and halts all work.'));
  console.log(color(90, 'Next: node setup/extensiontest.mjs, then load the extension and attach a tab.\n'));
}
process.exit(failed === 0 ? 0 : 1);
