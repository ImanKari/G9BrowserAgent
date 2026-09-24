#!/usr/bin/env node
/**
 * Engine 2 end-to-end live test — THROUGH THE PRODUCT PATH.
 *
 *   node setup/engine2-livetest.mjs [--only a,b,c] [--keep]
 *
 * What runs, all real: a daemon (daemon/g9d.mjs) on a random private port with
 * a throw-away G9_HOME; agents that speak MCP to it through real mcp/shim.mjs
 * processes over stdio, exactly as an AI client does; headless Edge launched by
 * the daemon (browser_engine action:"launch"); setup/testpage.html served by
 * setup/serve.mjs on another random port. Nothing is stubbed except, in the
 * handoff section, the Engine 1 side (a fake extension answers
 * handoff_export with a synthetic payload, because the extension cannot run
 * here without touching the owner's browser).
 *
 * The rule every check follows: never trust a tool's echo. A click is checked
 * by the events the PAGE received (window.e2log, recorded by the test page's
 * own listeners, with isTrusted and timestamps); a download by hashing the
 * bytes the server sent and the file on disk; a pinned HAR by the server's own
 * request counter; a cookie by the Cookie header the server received. The
 * tool's report is then compared with that observation.
 *
 * Safety (the owner's real browser and v1 bridge are running on this machine):
 * ports are random in 18000-18999 and never 8765; every data folder and
 * browser profile lives under a fresh temp directory; no headed window is
 * opened; at the end every process whose command line names this run's temp
 * directory is gone (checked, and killed if not), and the temp directories are
 * removed. Nothing here touches another process.
 *
 * Round 3 added the re-checks of what round 2 found, each against the page's
 * own record: pointerdown.pressure 0.5; a click on a page that cancels
 * pointerdown is "delivered"; a press that lands on another element (a button
 * that runs from the pointer) is reported "missed", naming what it hit, and
 * never repeated; a scroll returns only once the page has settled; a click
 * below the fold is reached by the wheel and lands on its element; element
 * screenshots show the element's pixels (compared with a viewport shot) and at
 * stealth cause no resize, while a tall full page is refused there; a
 * 929-character cookie comes back whole; a second tab keeps the first visible;
 * maxParallel gates input but not a wait; a de-DE persona is consistent in the
 * page, its requests and its worker, and a relaunch restores no tabs; no
 * profile signs in to a browser account; no downloads-hub tab (plus a raw A/B
 * outside the product on whether the preference is what suppresses it); the
 * desktop's live watch; the main world compared with a pristine window; windows
 * the PAGE opens (window.open from a click, target=_blank to a page and to a
 * download) — found, captured from their first load, drivable, and the opener
 * still usable — each on a tab of its own, so a wedged opener cannot take the
 * main tab and every later section down with it.
 *
 * Exit code: 0 when every check passed, 1 otherwise. `E2_REPORT=<file>` also
 * writes the checks and measurements as JSON.
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { WsClient } from '../lib/ws-client.mjs';
import { VERSION } from '../lib/version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DAEMON = path.join(ROOT, 'daemon', 'g9d.mjs');
const SHIM = path.join(ROOT, 'mcp', 'shim.mjs');
const SERVE = path.join(HERE, 'serve.mjs');

const argv = process.argv.slice(2);
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? new Set(argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean)) : null;
})();
const KEEP = argv.includes('--keep');

// ------------------------------------------------------------------ reporting

const results = [];
const measurements = [];
let currentSection = '';
const color = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);

function record(status, name, detail = '') {
  results.push({ section: currentSection, status, name, detail: String(detail ?? '') });
  const tag = status === 'PASS' ? color(32, 'PASS') : status === 'FAIL' ? color(31, 'FAIL') : color(33, 'SKIP');
  console.log(`  ${tag} ${name}${detail ? ` ${color(90, String(detail).slice(0, 600))}` : ''}`);
}
const ok = (name, detail) => record('PASS', name, detail);
const bad = (name, detail) => record('FAIL', name, detail);
const skip = (name, detail) => record('SKIP', name, detail);
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : bad(name, detail));
function measure(text) {
  measurements.push(`${currentSection}: ${text}`);
  console.log(`  ${color(36, 'INFO')} ${text}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const short = (v, n = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

async function waitFor(predicate, timeoutMs = 8_000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch { /* not yet */ }
    await sleep(stepMs);
  }
  return null;
}

// ------------------------------------------------------------------ processes and temp dirs

const usedPorts = new Set();
async function freePort() {
  for (let i = 0; i < 300; i++) {
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
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `g9-e2live-${label}-`));
  tempDirs.push(dir);
  return dir;
}

const children = new Set();
function track(child) {
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

/**
 * Processes whose command line contains `fragment` (a unique temp-dir name of
 * this run), via one CIM query. Only ever used to find — and at the end kill —
 * what THIS run started: the fragment is a random directory name nobody else has.
 */
function processesMatching(fragment) {
  const script =
    "$ErrorActionPreference='SilentlyContinue'; " +
    `$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${fragment}') } | ` +
    'Select-Object ProcessId,ParentProcessId,Name; if ($p) { $p | ConvertTo-Json -Compress } else { "[]" }';
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  try {
    const parsed = JSON.parse((out.stdout || '[]').trim() || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    // The query's own powershell.exe carries the fragment in ITS command line.
    return rows.filter((r) => r && r.ProcessId !== out.pid && !/^powershell/i.test(r.Name ?? ''));
  } catch {
    return [];
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function killTree(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
}

// ------------------------------------------------------------------ MCP over stdio to a real shim

class Mcp {
  constructor(name, env, cwd) {
    this.name = name;
    this.child = track(spawn(process.execPath, [SHIM], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }));
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
        try { msg = JSON.parse(line); } catch { this.nonJson.push(line); continue; }
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          entry(msg);
        }
      }
    });
  }

  request(method, params = {}, timeoutMs = 30_000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: ${method} timed out after ${timeoutMs} ms`));
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

  /** tools/call → { ok, data, text, images, ms }; a tool failure is ok:false with the message in text. */
  async call(name, args = {}, timeoutMs = 90_000) {
    const started = Date.now();
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content = res.result?.content ?? [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const images = content.filter((c) => c.type === 'image');
    let data = null;
    try { data = JSON.parse(content.find((c) => c.type === 'text')?.text ?? 'null'); } catch { data = null; }
    return { ok: !res.result?.isError && !res.error, data, text: text || JSON.stringify(res.error ?? ''), images, ms: Date.now() - started };
  }

  close() {
    try { this.child.stdin.end(); } catch { /* gone */ }
  }

  kill() {
    try { this.child.kill(); } catch { /* gone */ }
  }
}

/** A tool call that must succeed; its failure throws with the tool's own message. */
async function must(agent, tool, args, what = `${tool} ${args?.action ?? args?.what ?? ''}`, timeoutMs) {
  const r = await agent.call(tool, args, timeoutMs);
  if (!r.ok) throw new Error(`${what} failed: ${short(r.text, 500)}`);
  return r.data;
}

// ------------------------------------------------------------------ the page, as the page saw it

/** browser_console evaluate (main world) → value. The page's own records are read this way. */
async function pageEval(agent, tabId, expression) {
  const r = await agent.call('browser_console', { action: 'evaluate', expression, tabId }, 60_000);
  if (!r.ok) throw new Error(`evaluate failed on tab ${tabId}: ${short(r.text, 400)}`);
  const v = r.data?.value;
  return v === '(undefined)' ? undefined : v;
}

const pageMark = (agent, tabId) => pageEval(agent, tabId, '[window.e2log.length, window.e2moves.length, (window.e2ptr || []).length, (window.e2resizes || []).length]');

/**
 * What the page received since `mark`: its event log, trusted mouse moves
 * [t, x, y, buttons], pointer presses/releases (with pressure) and resizes.
 */
async function pageSince(agent, tabId, mark) {
  return pageEval(agent, tabId, `({
    log: window.e2log.slice(${mark[0]}),
    moves: window.e2moves.slice(${mark[1]}).filter((m) => m.trusted).map((m) => [Math.round(m.t * 10) / 10, m.x, m.y, m.buttons]),
    ptr: (window.e2ptr || []).slice(${mark[2] ?? 0}),
    resizes: (window.e2resizes || []).slice(${mark[3] ?? 0}),
    now: performance.now()
  })`);
}

const rectOf = (agent, tabId, id) => pageEval(agent, tabId, `(() => {
  const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
})()`);

const inside = (rect, p, tol = 1.5) => !!rect && !!p &&
  p.x >= rect.left - tol && p.x <= rect.right + tol && p.y >= rect.top - tol && p.y <= rect.bottom + tol;

/** Refs from a snapshot tree: [{ role, name, ref, inFrame }]. */
function parseRefs(tree) {
  const out = [];
  let inFrame = false;
  for (const line of String(tree ?? '').split('\n')) {
    if (line.includes('[cross-origin frame]')) { inFrame = true; continue; }
    const m = /- (\S+)(?: "((?:[^"\\]|\\.)*)")? \[ref=(e\d+)\]/.exec(line);
    if (m) out.push({ role: m[1], name: m[2] ?? '', ref: m[3], inFrame });
  }
  return out;
}

async function snap(agent, tabId) {
  const data = await must(agent, 'browser_snapshot', { tabId }, 'snapshot');
  const refs = parseRefs(data.tree);
  data.refs = refs;
  data.ref = (role, name, { frame = false } = {}) => {
    const hit = refs.find((r) => r.role === role && (name instanceof RegExp ? name.test(r.name) : r.name === name) && r.inFrame === frame);
    if (!hit) throw new Error(`no ${role} "${name}" in the snapshot of tab ${tabId}`);
    return hit.ref;
  };
  return data;
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
const pngSize = (buf) => (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null);

/**
 * Decode an 8-bit, non-interlaced RGB/RGBA PNG (what Chromium's capture
 * produces) → { width, height, channels, px }. Enough to compare what an
 * element screenshot shows with the same region of a viewport screenshot,
 * which proves the clip was taken WHERE the element is, not just at its size.
 */
function decodePng(buf) {
  const size = pngSize(buf);
  if (!size) throw new Error('not a PNG');
  const depth = buf[24];
  const type = buf[25];
  const interlace = buf[28];
  if (depth !== 8 || interlace !== 0 || (type !== 2 && type !== 6)) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const channels = type === 6 ? 4 : 3;
  const idat = [];
  for (let i = 8; i < buf.length;) {
    const len = buf.readUInt32BE(i);
    const kind = buf.toString('latin1', i + 4, i + 8);
    if (kind === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
    if (kind === 'IEND') break;
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = size;
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, channels, px };
}

/** Mean absolute RGB difference between image `a` and the region of `b` whose top-left is (ox, oy). */
function regionDiff(a, b, ox, oy) {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const bx = x + ox;
      const by = y + oy;
      if (bx < 0 || by < 0 || bx >= b.width || by >= b.height) return Infinity;
      for (let k = 0; k < 3; k++) {
        sum += Math.abs(a.px[(y * a.width + x) * a.channels + k] - b.px[(by * b.width + bx) * b.channels + k]);
        n += 1;
      }
    }
  }
  return n ? sum / n : Infinity;
}

/**
 * Is a browser ACCOUNT signed in to this profile? Read from the profile's own
 * files (Local State info_cache, Default/Preferences account_info), the same
 * sources engine/profile.js signInState reads — but here, independently of the
 * product. Only field NAMES leave this function, never a value: an identity
 * must not end up in a test log.
 */
function accountState(dir) {
  const out = { dir: path.basename(dir), localState: false, prefs: false, fields: [] };
  try {
    const local = JSON.parse(fs.readFileSync(path.join(dir, 'Local State'), 'utf8'));
    out.localState = true;
    for (const [key, info] of Object.entries(local?.profile?.info_cache ?? {})) {
      for (const f of ['user_name', 'gaia_id', 'edge_account_cid', 'edge_account_oid']) {
        if (typeof info?.[f] === 'string' && info[f].trim()) out.fields.push(`${key}.${f}`);
      }
      if (info?.is_consented_primary_account === true) out.fields.push(`${key}.is_consented_primary_account`);
    }
  } catch { /* no Local State (yet) */ }
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'));
    out.prefs = true;
    if (Array.isArray(prefs.account_info) && prefs.account_info.length) out.fields.push(`account_info[${prefs.account_info.length}]`);
    out.hubPref = prefs?.browser?.show_hub_popup_on_download_start ?? null;
  } catch { /* no Preferences (yet) */ }
  out.signedIn = out.fields.length > 0;
  return out;
}

// ------------------------------------------------------------------ daemon-side clients

function spawnDaemon(port, home) {
  const child = track(spawn(process.execPath, [DAEMON, '--port', String(port), '--home', home], {
    cwd: home,
    env: { ...process.env, G9_PROJECT: '', G9_ENGINE_RESUME_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }));
  child.stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { child.stderrText += d; });
  return child;
}

async function health(port) {
  const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3_000) });
  return res.json();
}

async function uiClient(port) {
  const ws = await WsClient.connect(`ws://127.0.0.1:${port}/g9`);
  const ui = { ws, events: [], results: new Map(), nextId: 1, welcome: null };
  ws.on('message', (msg) => {
    if (msg.type === 'welcome') ui.welcome = msg;
    else if (msg.type === 'event') ui.events.push(msg);
    else if (msg.type === 'result') ui.results.get(msg.id)?.(msg);
    else if (msg.type === 'ping') ws.send({ type: 'pong', at: msg.at });
  });
  ws.on('error', () => {});
  ws.send({ type: 'hello', role: 'ui', version: VERSION, client: { name: 'engine2-livetest-ui', pid: process.pid } });
  await waitFor(() => ui.welcome, 5_000, 50);
  ui.admin = (op, extra = {}) => new Promise((resolve, reject) => {
    const id = ui.nextId++;
    const timer = setTimeout(() => reject(new Error(`admin ${op} timed out`)), 20_000);
    ui.results.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    ws.send({ type: 'admin', id, op, ...extra });
  });
  return ui;
}

/**
 * The Engine 1 side of a handoff, faked: an extension-origin WebSocket that
 * says hello as a v2 engine and answers what the daemon relays for a handoff
 * (list, status, handoff_export). No instanceId, so it is dropped — not
 * parked — when it disconnects.
 */
async function fakeExtension(port, { tab, exportPayload }) {
  const ws = await WsClient.connect(`ws://127.0.0.1:${port}/g9`, { origin: 'chrome-extension://g9e2livetestfakeext' });
  const ext = { ws, calls: [], welcome: null, closed: null };
  ws.on('close', (info) => { ext.closed = info; });
  ws.on('error', () => {});
  ws.on('message', (msg) => {
    if (msg.type === 'welcome') ext.welcome = msg;
    if (msg.type === 'ping') { ws.send({ type: 'pong', at: msg.at }); return; }
    if (msg.type !== 'call') return;
    ext.calls.push({ tool: msg.tool, args: msg.args });
    const reply = (result) => ws.send({ type: 'result', id: msg.id, ok: true, result });
    const fail = (error) => ws.send({ type: 'result', id: msg.id, ok: false, error });
    const row = { tabId: tab.tabId, title: tab.title, url: tab.url, active: true, windowId: 1, attachable: true, attached: true, current: true };
    if (msg.tool === 'browser_tabs' && (msg.args.action ?? 'list') === 'list') return reply({ tabs: [row] });
    if (msg.tool === 'browser_tabs' && msg.args.action === 'handoff_export') {
      if (msg.args.tabId !== tab.tabId) return fail(`fake extension: no tab ${msg.args.tabId}`);
      return reply(exportPayload);
    }
    if (msg.tool === 'browser_status') {
      return reply({ engine: 'extension', version: VERSION, current: { tabId: tab.tabId, title: tab.title, url: tab.url, active: true }, health: { consoleErrors: 0, failedRequests: 0 }, tabs: { count: 1, rows: [row] }, hint: 'Ready.' });
    }
    return fail(`fake extension: ${msg.tool} ${msg.args?.action ?? ''} is not implemented in this test`);
  });
  ws.send({ type: 'hello', role: 'engine', version: VERSION, client: { name: 'extension', browser: 'Mozilla/5.0 Edg/153.0 (engine2-livetest fake)', extensionId: 'g9e2livetestfakeext', tabs: [{ tabId: tab.tabId, url: tab.url }] } });
  await waitFor(() => ext.welcome, 5_000, 50);
  return ext;
}

// ------------------------------------------------------------------ run state

const S = {}; // shared state between sections
const agents = [];

function section(name, title) {
  currentSection = name;
  console.log(`\n${color(1, `[${name}] ${title}`)}`);
}

async function run(name, title, fn, { core = false } = {}) {
  if (ONLY && !core && !ONLY.has(name)) return;
  section(name, title);
  try {
    await fn();
  } catch (err) {
    bad(`section "${name}" stopped on an unexpected error`, err?.stack ?? err);
  }
}

function newAgent(name) {
  const agent = new Mcp(name, { G9_PORT: String(S.port), G9_HOME: S.home, G9_PROJECT: '' }, S.home);
  agents.push(agent);
  return agent;
}

// ================================================================== sections

async function setup() {
  S.port = await freePort();
  S.webPort = await freePort();
  S.home = tempDir('home');
  S.work = tempDir('work');
  S.fragment = path.basename(S.home);
  S.web = `http://127.0.0.1:${S.webPort}`;
  S.testUrl = `${S.web}/`;
  console.log(color(90, `daemon port ${S.port} (never 8765), web port ${S.webPort}\nG9_HOME ${S.home}`));

  S.serve = track(spawn(process.execPath, [SERVE], { env: { ...process.env, PORT: String(S.webPort) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  const served = await waitFor(async () => (await fetch(`${S.web}/e2/stats`)).ok, 10_000);
  check(!!served, 'serve.mjs answers on a random port', S.web);

  S.daemon = spawnDaemon(S.port, S.home);
  const up = await waitFor(async () => (await health(S.port)).name === 'g9d', 15_000);
  check(!!up, 'daemon answers /health on a random port with a temp G9_HOME', `port ${S.port}`);
  const h = await health(S.port);
  check(h.version === VERSION && h.port === S.port && path.resolve(h.home) === path.resolve(S.home), '/health reports this daemon', short({ version: h.version, port: h.port, home: h.home }));

  S.A = newAgent('e2-agent-A');
  const init = await S.A.init();
  check(init.result?.serverInfo?.version === VERSION, 'shim A initializes over stdio (MCP)', init.result?.serverInfo?.version);
  const tools = await S.A.request('tools/list');
  check((tools.result?.tools ?? []).length === 15, 'tools/list serves the 15 grouped tools', `${tools.result?.tools?.length}`);
}

async function sectionLaunch() {
  const { A } = S;
  const launched = await A.call('browser_engine', { action: 'launch', browser: 'edge', headless: true }, 240_000);
  check(launched.ok, 'browser_engine launch (edge, headless) through the shim', launched.ok ? `${launched.ms} ms` : launched.text);
  if (!launched.ok) throw new Error('no engine — nothing else can run');
  const e = launched.data;
  S.engineId = e.engineId;
  S.enginePid = e.pid;
  check(/^launched-\d+$/.test(e.engineId) && e.kind === 'launched' && e.browser === 'edge' && e.headless === true,
    'launch result names a headless launched Edge', short({ engineId: e.engineId, kind: e.kind, browser: e.browser, headless: e.headless }));
  check(pidAlive(e.pid), 'the reported browser pid is a live process', `pid ${e.pid}`);
  const args = e.argv ?? [];
  check(args.some((a) => /^--headless/.test(a)) && args.includes('--remote-debugging-pipe') &&
    args.some((a) => a.startsWith('--user-data-dir=') && a.includes(S.fragment)),
  'argv: --headless, --remote-debugging-pipe, --user-data-dir inside the temp G9_HOME', short(args.filter((a) => /headless|pipe|user-data-dir|screen-info/.test(a))));
  measure(`engine ${e.engineId}: Edge ${e.version}, pid ${e.pid}, launch ${launched.ms} ms, warnings: ${short(e.warnings ?? [], 400)}`);
  // Round-2 blocker: Edge signed every new profile into the Windows account and synced it.
  check(args.includes('--disable-sync') && args.some((a) => /^--disable-features=.*\bmsImplicitSignin\b/.test(a)),
    'argv: --disable-sync and msImplicitSignin disabled (no implicit browser-account sign-in)', short(args.filter((a) => /sync|features=/.test(a)), 400));
  S.profileDir = e.profileDir ?? path.join(S.home, 'profiles', 'automation');
  measure(`closedAtLaunch: ${short(e.closedAtLaunch ?? [])}; profileDir inside G9_HOME: ${String(S.profileDir).includes(S.fragment)}`);
  const running = processesMatching(S.fragment).filter((p) => /msedge/i.test(p.Name));
  check(running.some((p) => p.ProcessId === e.pid), 'Windows sees msedge.exe processes on the temp profile', `${running.length} msedge process(es)`);

  const list = await must(A, 'browser_engine', { action: 'list' });
  check(list.engines?.some((x) => x.engineId === e.engineId && x.kind === 'launched'), 'browser_engine list shows it');
  const h = await health(S.port);
  check(h.launched === 1 && h.engines === 1, '/health counts one launched engine', short({ launched: h.launched, engines: h.engines }));

  // The main tab: the lab page on the default context.
  const opened = await must(A, 'browser_tabs', { action: 'open', url: S.testUrl });
  S.tabMain = opened.tabId;
  S.defaultContext = opened.contextId;
  S.agentA = (await must(A, 'browser_status', {})).you?.agentId;
  check(Number.isInteger(opened.tabId) && opened.engine === e.engineId && opened.current === true, 'browser_tabs open returns a handle in that engine and makes it current', short(opened));
  await must(A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: S.tabMain, timeoutMs: 20_000 }, 'wait for the lab');
  await sleep(900); // the page throws its deliberate ReferenceError 300 ms after load
  const seen = await pageEval(A, S.tabMain, '({ title: document.title, href: location.href, lab: !!document.getElementById("e2lab") })');
  check(seen.title === 'G9 Agent Test Page' && seen.href === S.testUrl && seen.lab, 'the page itself reports the test page loaded', short(seen));
  // Round 3: headless got --screen-info with a taskbar work area and a window that fills it.
  const geo = await pageEval(A, S.tabMain, '({ sw: screen.width, sh: screen.height, aw: screen.availWidth, ah: screen.availHeight, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, vis: document.visibilityState, headlessUA: /HeadlessChrome/.test(navigator.userAgent) })');
  check(geo.sw === 1920 && geo.sh === 1080 && geo.ah < geo.sh && geo.ow > 0 && geo.oh > 0 && geo.oh <= geo.ah && geo.ow <= geo.aw,
    'headless screen: 1920x1080 with a taskbar work area, and the window inside it (not 800x600, not avail = screen)', short(geo));
  check(geo.vis === 'visible', 'the agent tab is visible (so input reaches it)', geo.vis);
  measure(`headless geometry as the page sees it: ${short(geo)}`);
  const hits = await (await fetch(`${S.web}/e2/stats`)).json();
  check((hits.hits['/testpage.html'] ?? 0) >= 1 && (hits.hits['/crossframe.html'] ?? 0) >= 1 && (hits.hits['/api/missing'] ?? 0) >= 1,
    'the server saw the page, its cross-origin frame and /api/missing requested', short({ page: hits.hits['/testpage.html'], frame: hits.hits['/crossframe.html'], missing: hits.hits['/api/missing'] }));
  // The first load of a tab G9 opened itself: Engine 2 tabs are attached from
  // birth, so nothing of that load may be missing from capture.
  const firstLoad = await must(A, 'browser_network', { tabId: S.tabMain, limit: 100 });
  const urls = (firstLoad.requests ?? []).map((q) => q.url);
  check(urls.includes(S.testUrl) && urls.some((u) => /\/api\/missing$/.test(u)) && urls.some((u) => /definitely-missing-image/.test(u)),
    'first load after open: browser_network has the document, /api/missing and the broken image', short(urls));
  const firstDiag = await must(A, 'browser_diagnose', { what: 'health', tabId: S.tabMain });
  check((firstDiag.findings ?? []).some((f) => f.kind === 'network' && /\/api\/missing -> 404/.test(f.message)),
    'first load after open: browser_diagnose reports the failed /api/missing', short(firstDiag.summary));
}

async function sectionStatus() {
  const { A } = S;
  const r = await A.call('browser_status', {});
  check(r.ok, 'browser_status answers', r.ok ? '' : r.text);
  const s = r.data ?? {};
  S.agentA = s.you?.agentId;
  check(s.daemon?.version === VERSION && s.daemon?.port === S.port && path.resolve(s.daemon?.home ?? '.') === path.resolve(S.home), 'status.daemon: version, port, home', short(s.daemon));
  check(/^agent-\d+$/.test(s.you?.agentId ?? '') && s.you?.current === S.tabMain, 'status.you: my agent id and my current tab', short(s.you));
  check(s.you?.name === 'e2-agent-A', 'status.you.name is the MCP clientInfo name', s.you?.name);
  check(s.engine?.engineId === S.engineId && s.engine?.kind === 'launched', 'status.engine is the engine of my current tab', short(s.engine));
  check(s.current?.tabId === S.tabMain && s.current?.url === S.testUrl && s.current?.title === 'G9 Agent Test Page', 'status.current describes my tab (url, title)', short(s.current));
  const row = s.engines?.find((x) => x.engineId === S.engineId);
  check(row?.kind === 'launched' && row?.browser === 'edge' && row?.headless === true && row?.pid === S.enginePid, 'status.engines lists the launched engine (browser, headless, pid)', short(row && { kind: row.kind, browser: row.browser, headless: row.headless, pid: row.pid }));
  check(s.halted?.global === false && s.halted?.mine === false, 'status.halted: not halted');
  check(Array.isArray(s.owned) && s.owned.includes(S.tabMain), 'status.owned includes the tab I opened', short(s.owned));
  check(s.agents?.some((a) => a.id === S.agentA), 'status.agents lists me', short(s.agents?.map((a) => a.id)));
  check(s.capabilities?.launch === true && s.capabilities?.extension === false && s.capabilities?.handoff === false,
    'status.capabilities: launch yes, extension/handoff no (no extension connected)', short(s.capabilities));
  check(s.shim?.version === VERSION && Number.isInteger(s.shim?.pid), 'status.shim added by the shim', short(s.shim));
  check(typeof s.hint === 'string' && s.hint.includes(String(S.tabMain)), 'status.hint names my current tab', s.hint);
  // Health counters must be THIS tab's and agree with the tools that own them.
  const con = await must(A, 'browser_console', { action: 'read', tabId: S.tabMain, limit: 0 });
  const netw = await must(A, 'browser_network', { tabId: S.tabMain, limit: 0 });
  const failedRows = await must(A, 'browser_network', { tabId: S.tabMain, status: 'failed', limit: 20 });
  measure(`failed requests ~1 s after load: ${short(failedRows.requests?.map((q) => `${q.status} ${q.url}`))}`);
  check(s.health && s.health.consoleErrors === (con.counts?.error ?? 0) && s.health.consoleErrors >= 2,
    'status.health.consoleErrors agrees with browser_console (>= the 2 seeded errors)', `${s.health?.consoleErrors} vs ${con.counts?.error}`);
  check(s.health && s.health.failedRequests === netw.failedCount,
    'status.health.failedRequests agrees with browser_network', `${s.health?.failedRequests} vs ${netw.failedCount}`);
  const h = await health(S.port);
  check(h.agents >= 1 && h.launched === 1, '/health counts agents and the launched engine', short({ agents: h.agents, launched: h.launched }));
}

async function sectionTabs() {
  const { A } = S;
  const list = await must(A, 'browser_tabs', { action: 'list' });
  const row = list.tabs?.find((t) => t.tabId === S.tabMain);
  check(row && row.url === S.testUrl && row.title === 'G9 Agent Test Page' && row.engineKind === 'launched' && row.engine === S.engineId,
    'list: my tab with full url/title, engine, engineKind', short(row));
  check(row?.owner === S.agentA && row?.current === true, 'list: owner is me, current:true', short({ owner: row?.owner, current: row?.current }));

  const ses = await must(A, 'browser_tabs', { action: 'session', name: 'e2s', url: `${S.testUrl}?s=1` });
  S.tabSession = ses.tabId;
  check(ses.session === 'e2s' && Number.isInteger(ses.tabId) && ses.tabId !== S.tabMain, 'session with url opens a named tab', short(ses));
  await must(A, 'browser_navigate', { action: 'wait', selector: '#e2lab', session: 'e2s', timeoutMs: 20_000 });
  const sn = await A.call('browser_snapshot', { session: 'e2s' });
  check(sn.ok && sn.data?.url === `${S.testUrl}?s=1`, 'a tool addressed by session reads that tab', sn.data?.url ?? sn.text);
  const st = await must(A, 'browser_status', {});
  check(st.you?.current === S.tabMain, 'opening a session (no focus) keeps my current tab', `${st.you?.current}`);
  const sessions = await must(A, 'browser_tabs', { action: 'sessions' });
  check(sessions.sessions?.some((x) => (x.session ?? x.name) === 'e2s' && x.tabId === S.tabSession && x.alive === true), 'sessions lists it alive', short(sessions.sessions));
  const again = await must(A, 'browser_tabs', { action: 'session', name: 'e2s', url: `${S.testUrl}?s=2` });
  await must(A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: S.tabSession, timeoutMs: 20_000 });
  const href = await pageEval(A, S.tabSession, 'location.href');
  check(again.reused === true && again.tabId === S.tabSession && href === `${S.testUrl}?s=2`, 'session with the same name re-points its tab (the page is on ?s=2)', short({ reused: again.reused, href }));
  // History: back to ?s=1, forward to ?s=2 — as the page itself reports.
  const back = await A.call('browser_navigate', { action: 'back', tabId: S.tabSession });
  const hrefBack = await waitFor(async () => { const h = await pageEval(A, S.tabSession, 'location.href'); return h === `${S.testUrl}?s=1` ? h : null; }, 10_000, 200);
  const fwd = await A.call('browser_navigate', { action: 'forward', tabId: S.tabSession });
  const hrefFwd = await waitFor(async () => { const h = await pageEval(A, S.tabSession, 'location.href'); return h === `${S.testUrl}?s=2` ? h : null; }, 10_000, 200);
  check(back.ok && fwd.ok && !!hrefBack && !!hrefFwd, 'navigate back / forward: the page is on ?s=1, then ?s=2', short({ back: back.ok ? back.data?.url ?? 'ok' : back.text, fwd: fwd.ok ? fwd.data?.url ?? 'ok' : fwd.text, hrefBack, hrefFwd }));
  const ended = await must(A, 'browser_tabs', { action: 'end_session', name: 'e2s' });
  const gone = await A.call('browser_snapshot', { session: 'e2s' });
  check(ended.ended === true && !gone.ok, 'end_session forgets the name (a call by that name now fails)', short(gone.text, 160));
  const closed = await A.call('browser_tabs', { action: 'close', tabId: S.tabSession });
  check(closed.ok && closed.data?.closed === S.tabSession, 'close by tabId', short(closed.data ?? closed.text));
  const after = await must(A, 'browser_tabs', { action: 'list' });
  const dead = await A.call('browser_snapshot', { tabId: S.tabSession });
  check(!after.tabs.some((t) => t.tabId === S.tabSession) && !dead.ok && /does not exist|no longer exists/i.test(dead.text),
    'the closed tab is gone from the list and refused by handle', short(dead.text, 160));
  const noTab = await A.call('browser_tabs', { action: 'close' });
  check(!noTab.ok && /needs a tabId/.test(noTab.text), 'close without a tabId is refused (never an implicit default)', short(noTab.text, 120));
}

async function sectionSnapshot() {
  const { A } = S;
  const s1 = await snap(A, S.tabMain);
  check(s1.title === 'G9 Agent Test Page' && s1.url === S.testUrl, 'snapshot: title and url', short({ title: s1.title, url: s1.url }));
  const want = [['button', 'Sign in'], ['textbox', 'Username'], ['button', 'Lab button'], ['textbox', 'Lab text'], ['link', 'Download data file']];
  const missing = want.filter(([role, name]) => !s1.refs.some((r) => r.role === role && r.name === name && !r.inFrame));
  check(!missing.length, 'snapshot: refs for the controls a person would use', missing.length ? `missing ${short(missing)}` : `${s1.interactiveCount} interactive`);
  check(s1.refs.some((r) => r.inFrame && r.role === 'textbox' && r.name === 'Card number') && s1.refs.some((r) => r.inFrame && r.role === 'button' && r.name === 'Pay now'),
    'snapshot: refs inside the cross-origin iframe', short(s1.refs.filter((r) => r.inFrame)));
  const s2 = await snap(A, S.tabMain);
  check(s2.generation > s1.generation, 'snapshot generations increase', `${s1.generation} → ${s2.generation}`);
  S.labRef = s2.ref('button', 'Lab button');
  // A ref from before a reload names a node that no longer exists: refused, never guessed.
  await must(A, 'browser_navigate', { action: 'reload', tabId: S.tabMain });
  await must(A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: S.tabMain });
  const stale = await A.call('browser_interact', { action: 'click', ref: S.labRef, humanize: 'off', tabId: S.tabMain });
  const clicks = await pageEval(A, S.tabMain, 'window.e2log.filter((e) => e.type === "click").length');
  check(!stale.ok && clicks === 0, 'a ref from before a reload is refused and nothing is clicked', short(stale.text, 200));
  await sleep(700);
}

async function sectionDiagnose() {
  const { A } = S;
  const d = await must(A, 'browser_diagnose', { what: 'health', tabId: S.tabMain });
  const f = d.findings ?? [];
  const has = (kind, re) => f.some((x) => x.kind === kind && re.test(x.message));
  check(has('console', /failed to initialise analytics/), 'defect: console error on load');
  check(has('console', /undefinedFunctionCall/), 'defect: uncaught ReferenceError');
  check(has('network', /\/api\/missing -> 404/), 'defect: failed request /api/missing → 404');
  check(has('asset', /Broken image/), 'defect: broken image');
  check(has('a11y', /Form control has no accessible label: <input/), 'defect: unlabelled form control (#pass)');
  check(has('layout', /Page scrolls horizontally/) && f.some((x) => x.kind === 'layout' && /too-wide/.test(x.message)), 'defect: horizontal overflow, blamed on div.too-wide');
  check(has('dom', /Duplicate element IDs: dupe/), 'defect: duplicate id "dupe"');
  check(d.summary?.formIssues === 1 && d.summary?.brokenImages === 1 && d.summary?.overflowing === true,
    'summary: exactly the seeded form issue and broken image (the lab adds none)', short(d.summary));
  measure(`diagnose health: ${f.length} findings; summary ${short(d.summary)}`);
}

// ------------------------------------------------------------------ interaction matrix

async function ensureStealthTab() {
  if (S.tabStealth) return;
  const ctx = await must(S.A, 'browser_engine', { action: 'context', stealth: 'stealth' }, 'context stealth');
  S.stealthContext = ctx.contextId;
  const opened = await must(S.A, 'browser_tabs', { action: 'open', url: S.testUrl, context: ctx.contextId });
  S.tabStealth = opened.tabId;
  await must(S.A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: S.tabStealth, timeoutMs: 20_000 });
  await sleep(900);
}

/**
 * Every browser_interact action at one input level, each checked against what
 * the page received: event types, isTrusted, target, timing; the result's
 * delivery, pointer and humanize fields checked against that.
 */
async function interactAt(level) {
  const { A } = S;
  const tab = level === 'stealth' ? S.tabStealth : S.tabMain;
  const hz = level === 'stealth' ? {} : { humanize: level };
  const human = level !== 'off';
  const act = async (args) => A.call('browser_interact', { ...args, ...hz, tabId: tab }, 120_000);
  let s = await snap(A, tab);
  const expectLevel = (r) => r.data?.humanize?.level === level;

  // -- click
  let mark = await pageMark(A, tab);
  let r = await act({ action: 'click', ref: s.ref('button', 'Lab button') });
  let seen = await pageSince(A, tab, mark);
  let rect = await rectOf(A, tab, 'e2Btn');
  const down = seen.log.find((e) => e.type === 'mousedown' && e.target === 'e2Btn');
  const up = seen.log.find((e) => e.type === 'mouseup' && e.target === 'e2Btn');
  const click = seen.log.find((e) => e.type === 'click' && e.target === 'e2Btn');
  check(r.ok && r.data?.delivery === 'delivered', `${level} click: delivery "delivered"`, r.ok ? r.data?.delivery : r.text);
  check(!!(down && up && click && down.trusted && up.trusted && click.trusted && click.button === 0 && click.detail === 1),
    `${level} click: the page got trusted mousedown/mouseup/click on the button`, short({ down: !!down, up: !!up, click: click && { trusted: click.trusted, button: click.button, detail: click.detail } }));
  check(r.ok && inside(rect, r.data?.pointer) && click && Math.abs(r.data.pointer.x - click.x) <= 1.5 && Math.abs(r.data.pointer.y - click.y) <= 1.5,
    `${level} click: result.pointer is where the page saw the click, inside the button`, short({ pointer: r.data?.pointer, page: click && { x: click.x, y: click.y } }));
  check(r.ok && expectLevel(r), `${level} click: humanize.level is "${level}"`, short(r.data?.humanize));
  if (down && up && click) {
    const hold = up.t - down.t;
    const firstMove = seen.moves.length ? seen.moves[0][0] : null;
    const approach = firstMove != null ? click.t - firstMove : null;
    measure(`${level} click: call ${r.ms} ms, page moves ${seen.moves.length}, first move→click ${approach == null ? '-' : Math.round(approach)} ms, press→release ${Math.round(hold)} ms`);
    if (human) {
      check(approach != null && approach > 150 && seen.moves.length >= 5, `${level} click takes > 150 ms of visible pointer approach (${seen.moves.length} moves)`, `${Math.round(approach)} ms`);
      // Planned 60–140 ms; the dispatcher keeps ≥ 80 % of a press/release interval (round-2 CfT holds were 2–8 ms).
      check(hold >= 45 && hold <= 250, `${level} click: press held like a finger (60–140 ms planned, ≥ 80 % kept)`, `${Math.round(hold)} ms`);
    } else {
      check(hold < 60, 'off click: direct press/release (no human hold)', `${Math.round(hold)} ms`);
    }
    (S.holds ??= []).push({ level, hold: Math.round(hold * 10) / 10 });
  }
  // Round 2: pointerdown.pressure was 0 — a mouse with a button held reports 0.5.
  const pdown = seen.ptr.find((p) => p.type === 'pointerdown' && p.target === 'e2Btn');
  const pup = seen.ptr.find((p) => p.type === 'pointerup' && p.target === 'e2Btn');
  check(!!pdown && pdown.trusted && pdown.pointerType === 'mouse' && pdown.pressure === 0.5 && pup?.pressure === 0,
    `${level} click: trusted pointerdown with pressure 0.5, pointerup with 0`, short({ down: pdown && { p: pdown.pressure, type: pdown.pointerType, trusted: pdown.trusted }, up: pup && { p: pup.pressure } }));

  // -- double click
  mark = await pageMark(A, tab);
  r = await act({ action: 'double_click', ref: s.ref('button', 'Lab button') });
  seen = await pageSince(A, tab, mark);
  const dbl = seen.log.find((e) => e.type === 'dblclick' && e.target === 'e2Btn');
  const downs = seen.log.filter((e) => e.type === 'mousedown' && e.target === 'e2Btn');
  const ups = seen.log.filter((e) => e.type === 'mouseup' && e.target === 'e2Btn');
  check(r.ok && r.data?.delivery === 'delivered' && !!dbl?.trusted && downs.length === 2 && downs[1].detail === 2,
    `${level} double_click: trusted dblclick, second press has detail 2`, r.ok ? short({ dbl: !!dbl, downs: downs.map((d) => d.detail) }) : r.text);
  if (downs.length === 2 && ups.length >= 1) measure(`${level} double_click: release→second press ${Math.round(downs[1].t - ups[0].t)} ms`);
  check(r.ok && !!r.data?.pointer && expectLevel(r), `${level} double_click: pointer and humanize reported`, short({ pointer: r.data?.pointer, hz: r.data?.humanize }));

  // -- right click
  mark = await pageMark(A, tab);
  r = await act({ action: 'right_click', ref: s.ref('button', 'Lab button') });
  seen = await pageSince(A, tab, mark);
  const ctx = seen.log.find((e) => e.type === 'contextmenu' && e.target === 'e2Btn');
  const rdown = seen.log.find((e) => e.type === 'mousedown' && e.target === 'e2Btn');
  check(r.ok && r.data?.delivery === 'delivered' && !!ctx?.trusted && ctx.button === 2 && rdown?.button === 2,
    `${level} right_click: trusted contextmenu with button 2`, r.ok ? short({ ctx: ctx && { trusted: ctx.trusted, button: ctx.button } }) : r.text);

  // -- a page that cancels pointerdown: by the Pointer Events spec the
  // compatibility mousedown/mouseup are then suppressed, while click still
  // fires. Round 2 called every such click lost (22/22), and an agent told
  // that clicks again.
  await pageEval(A, tab, 'window.e2cancel = { clicks: 0, trusted: null }');
  mark = await pageMark(A, tab);
  r = await act({ action: 'click', ref: s.ref('button', 'Cancelled pointerdown') });
  seen = await pageSince(A, tab, mark);
  const cz = await pageEval(A, tab, 'window.e2cancel');
  const czDowns = seen.log.filter((e) => e.type === 'mousedown' && e.target === 'e2Cancel').length;
  const czPtr = seen.ptr.filter((p) => p.type === 'pointerdown' && p.target === 'e2Cancel' && p.trusted).length;
  check(r.ok && r.data?.delivery === 'delivered' && cz?.clicks === 1 && cz.trusted === true && czPtr === 1 && czDowns === 0,
    `${level} click where the page cancels pointerdown: "delivered", and the page got one trusted pointerdown + click (no mousedown, per spec)`,
    r.ok ? short({ delivery: r.data?.delivery, page: cz, pointerdowns: czPtr, mousedowns: czDowns }) : r.text);

  // -- a button that jumps away as the pointer arrives: the press lands on
  // the track under it. The tool must say so (delivery "missed", naming what
  // it hit) and must not repeat the click; round 2 called this "delivered".
  await pageEval(A, tab, 'window.e2runReset()');
  s = await snap(A, tab);
  mark = await pageMark(A, tab);
  r = await act({ action: 'click', ref: s.ref('button', 'Runaway button') });
  await sleep(300);
  seen = await pageSince(A, tab, mark);
  const run = await pageEval(A, tab, 'window.e2run');
  const runDowns = seen.ptr.filter((p) => p.type === 'pointerdown' && p.trusted);
  const onTrack = run?.clicks === 0 && runDowns.length === 1 && runDowns[0].target === 'e2RunTrack';
  const onButton = run?.clicks === 1 && runDowns.length === 1 && runDowns[0].target === 'e2Run';
  const saysMissed = !r.ok && /reached the page, but not/.test(r.text) && /e2RunTrack/.test(r.text) && /NOT repeated/.test(r.text);
  if (human) {
    // A human approach enters the button first, so it has moved by the press.
    check(saysMissed, `${level} click on a button that moves away as the pointer arrives: an error naming <div#e2RunTrack> as what was hit (missed), never "delivered"`,
      short(r.ok ? { delivery: r.data?.delivery, page: run } : r.text, 400));
    check(run?.moved === 1 && onTrack, `${level} runaway: the page saw exactly one press, on the track, and no click on the button (not repeated)`,
      short({ page: run, presses: runDowns.map((p) => p.target) }));
  } else {
    // At off the move and the press are back to back, and where the press
    // lands is Chromium's race (measured, runs of this suite: on the moved
    // button — pointerdown and click on it — or on the track). A button that
    // left before G9 aimed is refused at its centre, with nothing pressed.
    // Whatever the page saw, the tool must say the same.
    const refusedFirst = !r.ok && runDowns.length === 0 && run?.clicks === 0 && /not clickable/.test(r.text);
    check((onButton && r.ok && r.data?.delivery === 'delivered') || (onTrack && saysMissed) || refusedFirst,
      'off runaway: the tool\'s report agrees with where the page says the (at most one) press landed',
      short({ page: run, presses: runDowns.map((p) => p.target), tool: r.ok ? r.data?.delivery : short(r.text, 160) }));
  }
  (S.missedTexts ??= []).push(`${level}: ${r.ok ? `ok, delivery ${r.data?.delivery}; page press on ${runDowns.map((p) => p.target)}` : short(r.text, 240)}`);
  await pageEval(A, tab, 'window.e2runReset()');
  s = await snap(A, tab);

  // -- hover (the pointer rests on the lab button now)
  await pageEval(A, tab, 'document.getElementById("e2HoverOut").textContent = "not hovered"');
  mark = await pageMark(A, tab);
  r = await act({ action: 'hover', ref: s.ref('button', 'Hover target') });
  const hoverText = await pageEval(A, tab, 'document.getElementById("e2HoverOut").textContent');
  rect = await rectOf(A, tab, 'e2Hover');
  check(r.ok && r.data?.delivery === 'delivered' && hoverText === 'hovered (trusted)', `${level} hover: the page saw a trusted mouseover`, r.ok ? hoverText : r.text);
  check(r.ok && inside(rect, r.data?.pointer) && expectLevel(r), `${level} hover: result.pointer lies on the target`, short({ pointer: r.data?.pointer, rect }));

  // -- type (field pre-filled, clear:true must remove it; timing from keydowns)
  const text = 'qwertyuiopasdfghjklzxcvbnm';
  await pageEval(A, tab, 'document.getElementById("e2Text").value = "old value"');
  mark = await pageMark(A, tab);
  r = await act({ action: 'type', ref: s.ref('textbox', 'Lab text'), text, clear: true, typos: false });
  seen = await pageSince(A, tab, mark);
  const value = await pageEval(A, tab, 'document.getElementById("e2Text").value');
  const keys = seen.log.filter((e) => e.type === 'keydown' && e.target === 'e2Text' && typeof e.key === 'string' && /^[a-z]$/.test(e.key)).slice(-text.length);
  const gaps = keys.slice(1).map((k, i) => k.t - keys[i].t);
  const med = median(gaps);
  check(r.ok && r.data?.delivery === 'delivered' && value === text, `${level} type (clear:true): the field holds exactly the text`, r.ok ? short({ value, delivery: r.data?.delivery }) : r.text);
  check(keys.length === text.length && keys.every((k) => k.trusted), `${level} type: one trusted keydown per character`, `${keys.length}/${text.length}`);
  measure(`${level} type ${text.length} chars: call ${r.ms} ms, median inter-key ${med == null ? '-' : Math.round(med)} ms (min ${Math.round(Math.min(...gaps))}, max ${Math.round(Math.max(...gaps))})`);
  if (level === 'off') check(med != null && med < 50, 'off type: direct typing (v1 12 ms/char)', `${Math.round(med)} ms`);
  if (level === 'human') check(med != null && med >= 100 && med <= 190, 'human type: median inter-key ~140 ms (log-normal)', `${Math.round(med)} ms`);
  if (level === 'stealth') check(med != null && med >= 110 && med <= 220, 'stealth type: median inter-key ~160 ms', `${Math.round(med)} ms`);
  check(!human || (r.ok && r.data?.pointer && expectLevel(r)), `${level} type: pointer/humanize reported`, short({ pointer: r.data?.pointer, hz: r.data?.humanize }));

  // -- key: Tab moves focus; Shift+Tab moves it back
  mark = await pageMark(A, tab);
  r = await act({ action: 'key', key: 'Tab' });
  let focus = await pageEval(A, tab, 'document.activeElement && document.activeElement.id');
  check(r.ok && r.data?.delivery === 'delivered' && focus === 'e2CookieValue', `${level} key Tab: focus moved to the next field`, r.ok ? focus : r.text);
  mark = await pageMark(A, tab);
  r = await act({ action: 'key', key: 'Tab', modifiers: ['Shift'] });
  seen = await pageSince(A, tab, mark);
  focus = await pageEval(A, tab, 'document.activeElement && document.activeElement.id');
  const shift = seen.log.find((e) => e.type === 'keydown' && e.key === 'Shift');
  const tabDown = seen.log.find((e) => e.type === 'keydown' && e.key === 'Tab');
  check(r.ok && focus === 'e2Text' && tabDown?.trusted && tabDown?.shift === true, `${level} key Shift+Tab: focus moved back (trusted Tab keydown with shiftKey)`, r.ok ? short({ focus, tab: tabDown && { shift: tabDown.shift, trusted: tabDown.trusted }, shiftKeydown: !!shift }) : r.text);
  measure(`${level} Shift+Tab: separate Shift keydown ${shift ? `yes (location ${shift.location})` : 'no (modifier flag only)'}`);
  if (human) check(shift?.location === 1, `${level} key: Shift keydown carries location 1 (left), as a keyboard sends it`, `${shift?.location}`);

  // -- scroll (document, no ref)
  const y0 = await pageEval(A, tab, 'scrollY');
  mark = await pageMark(A, tab);
  r = await act({ action: 'scroll', direction: 'down', amount: 400 });
  // Round 2: a humanized scroll returned while the page was still moving
  // (50/50). The position the result reports must be where the page stays.
  const atReturn = await pageEval(A, tab, '[scrollY, window.e2log.filter((e) => e.type === "scroll").length]');
  await sleep(800);
  seen = await pageSince(A, tab, mark);
  const y1 = await pageEval(A, tab, 'scrollY');
  const scrollsAfter = await pageEval(A, tab, 'window.e2log.filter((e) => e.type === "scroll").length') - atReturn[1];
  const wheels = seen.log.filter((e) => e.type === 'wheel');
  check(r.ok && r.data?.delivery === 'delivered' && Math.abs((y1 - y0) - 400) <= 120, `${level} scroll 400 down: the document moved ~400 px`, r.ok ? `${y0} → ${y1}, via ${r.data?.via}` : r.text);
  check(r.ok && r.data?.settled !== false && Math.abs((r.data?.position?.y ?? NaN) - y1) <= 1 && atReturn[0] === y1 && scrollsAfter === 0,
    `${level} scroll returns settled: reported position = where the page stays, no scroll event after the return`,
    short({ reported: r.data?.position, atReturn: atReturn[0], final: y1, scrollEventsAfterReturn: scrollsAfter, settled: r.data?.settled }));
  // At off the wheel turns at a fixed point (400,300) — over the cross-origin
  // iframe on this page, whose document gets the event — so the top document
  // may see no wheel event; the movement above is the proof there.
  if (human) check(wheels.length >= 1 && wheels.every((w) => w.trusted), `${level} scroll: trusted wheel events (${wheels.length})`, short(wheels.map((w) => w.deltaY)));
  else measure(`off scroll: via ${r.data?.via}, top-document wheel events ${wheels.length}, pointer ${short(r.data?.pointer)}`);
  if (human) {
    check(wheels.length >= 3 && wheels.every((w) => Math.abs(w.deltaY) === 100), `${level} scroll: whole wheel notches of 100 px`, short(wheels.map((w) => w.deltaY)));
    check(r.ok && !!r.data?.pointer && expectLevel(r), `${level} scroll: pointer and humanize reported`, short({ pointer: r.data?.pointer, notches: r.data?.notches }));
  }

  // -- drag (pointer-driven)
  s = await snap(A, tab);
  await pageEval(A, tab, 'window.e2drag = null');
  mark = await pageMark(A, tab);
  r = await act({ action: 'drag', from: s.ref('button', 'Drag handle'), to: s.ref('button', /^(Drop zone|Dropped here)$/) });
  const dragged = await pageEval(A, tab, 'window.e2drag');
  seen = await pageSince(A, tab, mark);
  const handleRect = await rectOf(A, tab, 'e2Handle');
  const dropRect = await rectOf(A, tab, 'e2Drop');
  check(r.ok && r.data?.delivery === 'delivered' && dragged?.inZone === true && dragged?.trusted === true && dragged?.moves >= 10,
    `${level} drag: the page saw a trusted press, ≥10 moves and a release over the drop zone`,
    r.ok ? short({ dragged, result: r.data, pageEvents: seen.log.filter((e) => /mouse|scroll/.test(e.type)).map((e) => (e.type === 'scroll' ? `scroll(${e.sx},${e.sy})` : `${e.type}@${e.target}(${e.x},${e.y})`)), movesWithButton: seen.moves.filter((m) => m[3] & 1).length, handleRect, dropRect }, 900) : r.text);
  check(r.ok && !!r.data?.pointer, `${level} drag: pointer reported`, short(r.data?.pointer));

  // -- HTML5 drag and drop (measured, see the report)
  if (level === 'human') {
    await pageEval(A, tab, 'window.e2dnd = null');
    r = await act({ action: 'drag', from: s.ref('button', 'HTML5 draggable'), to: s.ref('button', 'HTML5 drop zone') });
    const dnd = await pageEval(A, tab, 'window.e2dnd');
    S.html5dnd = { ok: r.ok, delivery: r.data?.delivery, dnd, error: r.ok ? null : r.text };
    measure(`human drag on HTML5 draggable → drop zone: tool ${r.ok ? r.data?.delivery : 'error'}; page drop event: ${short(dnd)}`);
  }

  // -- select
  await pageEval(A, tab, 'document.getElementById("env").value = "dev"; window.__g9SelectTrusted = null');
  r = await act({ action: 'select', ref: s.ref('combobox', /^Environment/), values: 'prd' });
  const env = await pageEval(A, tab, '({ value: document.getElementById("env").value, trusted: window.__g9SelectTrusted })');
  check(r.ok && r.data?.delivery === 'delivered' && env.value === 'prd' && env.trusted === true, `${level} select: the page holds "prd" after a trusted change`, r.ok ? short(env) : r.text);

  // -- upload
  const uploadText = `engine2 upload ${level} ✓ ${crypto.randomBytes(4).toString('hex')}`;
  const file = path.join(S.work, `e2-upload-${level}.txt`);
  fs.writeFileSync(file, uploadText);
  r = await act({ action: 'upload', selector: '#e2File', files: [file] });
  const got = await waitFor(() => pageEval(A, tab, 'window.e2upload'), 5_000, 150);
  check(r.ok && r.data?.delivery === 'delivered' && got?.[0]?.name === path.basename(file) && got[0].size === Buffer.byteLength(uploadText) && got[0].text === uploadText,
    `${level} upload: the page read the file's name, size and content`, r.ok ? short(got) : r.text);
  await pageEval(A, tab, 'window.e2upload = null');

  // -- a click on an element far below the fold: reached (by the wheel at the
  // human levels), then pressed ON it. Round 2: CfT clicks after a scroll hit
  // the spacer the button had just left, reported "delivered" (22/22).
  await pageEval(A, tab, 'window.e2bottom = 0');
  s = await snap(A, tab);
  mark = await pageMark(A, tab);
  r = await act({ action: 'click', ref: s.ref('button', 'Bottom button') });
  seen = await pageSince(A, tab, mark);
  const bottomRect = await rectOf(A, tab, 'e2BottomBtn');
  const bottomClicks = await pageEval(A, tab, 'window.e2bottom');
  const bottomWheels = seen.log.filter((e) => e.type === 'wheel' && e.trusted).length;
  check(r.ok && r.data?.delivery === 'delivered' && bottomClicks === 1 && inside(bottomRect, r.data?.pointer),
    `${level} click on a button below the fold: delivered, clicked once, pointer on it`,
    r.ok ? short({ clicks: bottomClicks, pointer: r.data?.pointer, rect: bottomRect, scrolled: r.data?.scrolled }) : r.text);
  if (human) {
    check(r.ok && r.data?.scrolled?.via === 'wheel' && bottomWheels >= 1, `${level} below the fold: reached with trusted wheel events (${bottomWheels}), not scrollIntoView`, short(r.data?.scrolled));
  }
  measure(`${level} bottom click: call ${r.ms} ms, scrolled ${short(r.data?.scrolled)}, page wheels ${bottomWheels}`);
}

async function sectionInteract() {
  await ensureStealthTab();
  for (const level of ['off', 'human', 'stealth']) {
    console.log(color(90, `  -- ${level}`));
    try {
      await interactAt(level);
    } catch (err) {
      bad(`${level}: interaction sequence stopped`, err.message);
    }
  }
  // Decision D-b: a stealth tab's level is a floor.
  const { A } = S;
  const s = await snap(A, S.tabStealth);
  const r = await A.call('browser_interact', { action: 'click', ref: s.ref('button', 'Lab button'), humanize: 'off', tabId: S.tabStealth });
  check(r.ok && r.data?.humanize?.level === 'stealth' && r.data?.humanize?.raisedFrom === 'off', 'humanize:"off" on a stealth tab is raised to stealth and says so', short(r.data?.humanize ?? r.text));
  if (S.html5dnd) {
    check(S.html5dnd.dnd?.dropped === true || S.html5dnd.delivery !== 'delivered',
      'HTML5 drag: either the page saw the drop, or the tool did not claim "delivered"', short(S.html5dnd));
  }
  measure(`press holds seen by the page (mousedown→mouseup, ms): ${short(S.holds ?? [])}`);
  for (const t of S.missedTexts ?? []) measure(`runaway ${t}`);
}

async function sectionFrames() {
  const { A } = S;
  const s = await snap(A, S.tabMain);
  const card = s.ref('textbox', 'Card number', { frame: true });
  const pay = s.ref('button', 'Pay now', { frame: true });
  const t = await A.call('browser_interact', { action: 'type', ref: card, text: '4111 1111 1111 1111', typos: false, humanize: 'human', tabId: S.tabMain });
  check(t.ok && t.data?.delivery === 'delivered', 'human type inside the cross-origin iframe', t.ok ? short(t.data?.value) : t.text);
  const c = await A.call('browser_interact', { action: 'click', ref: pay, humanize: 'human', tabId: S.tabMain });
  check(c.ok && c.data?.delivery === 'delivered', 'human click inside the cross-origin iframe', c.ok ? '' : c.text);
  const after = await snap(A, S.tabMain);
  check(after.tree.includes('heading "PAID 1111"'), 'the frame\'s own page shows "PAID 1111" (read from its accessibility tree)', short(after.tree.split('\n').filter((l) => /PAID|not paid/.test(l))));
  // An element under an invisible overlay is refused, naming the cover.
  for (const level of ['off', 'human']) {
    const mark = await pageMark(A, S.tabMain);
    const cov = await A.call('browser_interact', { action: 'click', ref: after.ref('button', 'You cannot click me'), humanize: level, tabId: S.tabMain });
    const seen = await pageSince(A, S.tabMain, mark);
    const clicked = seen.log.some((e) => e.type === 'click');
    check(!cov.ok && /cover|obscur|overlay/i.test(cov.text) && !clicked, `${level}: a covered button is refused (named cover) and nothing is clicked`, short(cov.text, 200));
  }
}

async function sectionConsoleNetwork() {
  const { A } = S;
  const read = await must(A, 'browser_console', { action: 'read', tabId: S.tabMain, limit: 200 });
  const has = (level, re) => read.entries?.some((e) => e.level === level && re.test(e.text));
  check(has('log', /\[TestPage\] booted/) && has('warning', /legacyMode/) && has('error', /failed to initialise analytics/),
    'console read: log, warning and error from the page', `${read.total} entries`);
  const ref = read.entries?.find((e) => /undefinedFunctionCall/.test(e.text));
  check(!!ref && ref.level === 'error' && !!ref.at, 'console read: the uncaught ReferenceError, with a stack', short(ref));
  const s = await snap(A, S.tabMain);
  await A.call('browser_interact', { action: 'click', ref: s.ref('button', 'Throw error'), humanize: 'off', tabId: S.tabMain });
  const next = await waitFor(async () => {
    const r = await must(A, 'browser_console', { action: 'read', tabId: S.tabMain, since: read.lastSeq, level: 'error' });
    return r.entries?.find((e) => /Deliberate error from the Throw error button/.test(e.text)) ?? null;
  }, 5_000, 200);
  check(!!next && !!next.at, 'console read since lastSeq: the new uncaught error, with stack frames', short(next));

  const netw = await must(A, 'browser_network', { tabId: S.tabMain, limit: 200 });
  const missing = netw.requests?.find((q) => /\/api\/missing$/.test(q.url));
  check(missing?.status === 404, 'network list: /api/missing → 404', short(missing));
  const failedOnly = await must(A, 'browser_network', { tabId: S.tabMain, status: 'failed', limit: 50 });
  check(failedOnly.requests?.every((q) => q.status >= 400 || q.failed || q.error) && failedOnly.requests?.some((q) => /definitely-missing-image/.test(q.url)),
    'network status:"failed" lists only failures, including the broken image', short(failedOnly.requests?.map((q) => `${q.status} ${q.url}`)));
  const doc = netw.requests?.find((q) => q.url === S.testUrl);
  if (doc?.requestId) {
    const detail = await must(A, 'browser_network', { tabId: S.tabMain, requestId: doc.requestId });
    const body = typeof detail.body === 'string' ? detail.body : typeof detail.responseBody === 'string' ? detail.responseBody : JSON.stringify(detail);
    check(/G9 Agent Test Page/.test(body), 'network requestId: the document\'s response body', `${body.length} chars`);
  } else {
    bad('network list has the document request', short(netw.requests?.slice(0, 3)));
  }
  const har = await must(A, 'browser_network', { tabId: S.tabMain, format: 'har', limit: 50 });
  check(har.log?.entries?.length > 3 && har.log?.version === '1.2', 'network format:"har": a HAR 1.2 document', `${har.log?.entries?.length} entries`);

  // Stealth: the page's console is not captured, and says so; the network still is.
  const sr = await must(A, 'browser_console', { action: 'read', tabId: S.tabStealth, limit: 200 });
  check(typeof sr.unavailable === 'string' && !sr.entries?.some((e) => /\[TestPage\]/.test(e.text)),
    'stealth console read: "unavailable" stated, no page console.* entries', short({ unavailable: sr.unavailable, entries: sr.entries?.map((e) => e.text.slice(0, 60)) }));
  // A request made now, after the tab's first tool call (see the first-load check in [launch]).
  const sref = await snap(A, S.tabStealth);
  await must(A, 'browser_interact', { action: 'click', ref: sref.ref('button', 'Fetch (404)'), tabId: S.tabStealth });
  const sn = await waitFor(async () => {
    const r = await must(A, 'browser_network', { tabId: S.tabStealth, limit: 200 });
    return r.requests?.some((q) => /\/api\/also-missing$/.test(q.url) && q.status === 404) ? r : null;
  }, 5_000, 200);
  check(!!sn, 'stealth network: a request the page makes is captured (Network domain on, Runtime off)', short(sn?.requests?.map((q) => `${q.status} ${q.url}`)));
  const st = await must(A, 'browser_status', { tabId: S.tabStealth });
  check(st.current?.tabId === S.tabStealth && typeof st.health?.console === 'string', 'stealth status: health says console capture is unavailable', short(st.health));
  // A page-side detector of the Runtime domain (measured, not relied on).
  const probe = async (tab) => {
    const sn2 = await snap(A, tab);
    await A.call('browser_interact', { action: 'click', ref: sn2.ref('button', 'Probe runtime'), tabId: tab, ...(tab === S.tabMain ? { humanize: 'off' } : {}) });
    return pageEval(A, tab, 'window.e2probe');
  };
  const probeMain = await probe(S.tabMain);
  const probeStealth = await probe(S.tabStealth);
  measure(`Runtime-domain probe (Error.stack getter read by console.debug): default context ${probeMain}, stealth context ${probeStealth}`);
  if (probeMain === true) check(probeStealth === false, 'stealth: the page cannot see the Runtime domain (probe fires in the default context, not in stealth)', `${probeMain}/${probeStealth}`);
}

async function sectionInspect() {
  const { A } = S;
  // Sign in (human) so storage and a script cookie exist; then an HttpOnly cookie from the server.
  let s = await snap(A, S.tabMain);
  await must(A, 'browser_interact', { action: 'type', ref: s.ref('textbox', 'Username'), text: 'admin', clear: true, typos: false, tabId: S.tabMain });
  s = await snap(A, S.tabMain);
  const passRef = s.refs.find((r) => r.role === 'textbox' && r.name === 'password')?.ref ?? s.refs.find((r) => r.role === 'textbox' && /password/i.test(r.name))?.ref;
  await must(A, 'browser_interact', { action: 'type', ref: passRef, text: 'g9secret', clear: true, tabId: S.tabMain });
  await must(A, 'browser_interact', { action: 'click', ref: s.ref('button', 'Sign in'), tabId: S.tabMain });
  const status = await pageEval(A, S.tabMain, 'document.getElementById("status").textContent');
  check(status === 'Signed in as admin.', 'human sign-in works (page status text)', status);
  await pageEval(A, S.tabMain, 'fetch("/e2/set-httponly?name=e2http&value=hidden42").then((r) => r.status)');

  const dom = await must(A, 'browser_inspect', { what: 'dom', selector: '#login', tabId: S.tabMain });
  check(/<button[^>]*id="login"[^>]*>Sign in<\/button>/.test(dom.html ?? ''), 'inspect dom: outerHTML of #login', short(dom.html, 120));
  const styles = await must(A, 'browser_inspect', { what: 'styles', selector: '#login', properties: ['display', 'background-color', 'font-weight'], tabId: S.tabMain });
  const pageStyles = await pageEval(A, S.tabMain, '(() => { const c = getComputedStyle(document.getElementById("login")); return { display: c.display, bg: c.backgroundColor, fw: c.fontWeight }; })()');
  check(styles.computed?.display === pageStyles.display && styles.computed?.['background-color'] === pageStyles.bg && styles.computed?.['font-weight'] === pageStyles.fw,
    'inspect styles: computed values equal the page\'s getComputedStyle', short({ tool: styles.computed, page: pageStyles }));
  const box = await must(A, 'browser_inspect', { what: 'box', selector: '#e2Btn', tabId: S.tabMain });
  const rect = await rectOf(A, S.tabMain, 'e2Btn');
  check(box.rect && Math.abs(box.rect.x - rect.left) <= 1 && Math.abs(box.rect.y - rect.top) <= 1 && Math.abs(box.rect.width - rect.width) <= 1 && box.visible === true,
    'inspect box: the rect the page reports', short({ tool: box.rect, page: rect }));
  const storage = await must(A, 'browser_inspect', { what: 'storage', kind: 'local', tabId: S.tabMain });
  const ls = await pageEval(A, S.tabMain, 'localStorage.getItem("g9_session")');
  check(storage.local?.g9_session === ls && /"user":"admin"/.test(ls ?? ''), 'inspect storage: localStorage as the page has it', short(storage.local));
  const cookies = await must(A, 'browser_inspect', { what: 'cookies', tabId: S.tabMain });
  const docCookie = await pageEval(A, S.tabMain, 'document.cookie');
  const echo = await pageEval(A, S.tabMain, 'fetch("/e2/echo").then((r) => r.json())');
  const http = cookies.cookies?.find((c) => c.name === 'e2http');
  const sess = cookies.cookies?.find((c) => c.name === 'g9_test_session');
  check(sess?.value === 'YWRtaW4=' && docCookie.includes('g9_test_session=YWRtaW4='), 'inspect cookies: the page\'s own cookie', short(sess));
  check(http?.httpOnly === true && http.value === 'hidden42' && !docCookie.includes('e2http') && echo.cookie.includes('e2http=hidden42'),
    'inspect cookies: an HttpOnly cookie the page cannot see, which the server does receive', short({ http, docCookie, server: echo.cookie }));
  // Round 3: values were cut to 77 characters (a 929-character JWT came back as 78).
  const long = await pageEval(A, S.tabMain, 'fetch("/e2/set-long?len=929").then((r) => r.json())');
  const cookies2 = await must(A, 'browser_inspect', { what: 'cookies', tabId: S.tabMain });
  const jwt = cookies2.cookies?.find((c) => c.name === 'e2jwt');
  const echo2 = await pageEval(A, S.tabMain, 'fetch("/e2/echo").then((r) => r.json())');
  check(long?.length === 929 && jwt?.value === long.value && jwt?.httpOnly === true && echo2.cookie.includes(`e2jwt=${long.value}`),
    'inspect cookies: a 929-character HttpOnly JWT comes back whole (the server received the same)', short({ set: long?.length, got: jwt?.value?.length, same: jwt?.value === long?.value, keys: jwt && Object.keys(jwt) }));
  const frames = await must(A, 'browser_inspect', { what: 'frames', tabId: S.tabMain });
  const xo = frames.frames?.find((f) => (f.url ?? '').startsWith(`http://localhost:${S.webPort}/crossframe.html`));
  check(frames.frames?.[0]?.url === S.testUrl && !!xo && xo.depth === 1, 'inspect frames: the tree includes the cross-origin iframe', short(frames.frames?.map((f) => `${f.depth} ${f.url}`)));
}

async function sectionScreenshots() {
  const { A } = S;
  const s = await snap(A, S.tabMain);
  const moved = await must(A, 'browser_interact', { action: 'hover', ref: s.ref('button', 'Lab button'), tabId: S.tabMain });
  const view = await pageEval(A, S.tabMain, '({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight })');
  const vp = await A.call('browser_screenshot', { area: 'viewport', tabId: S.tabMain });
  const vpImg = vp.images?.[0];
  const vpSize = vpImg ? jpegSize(Buffer.from(vpImg.data, 'base64')) : null;
  check(vp.ok && vpImg?.mimeType === 'image/jpeg' && vpSize && Math.abs(vpSize.width - view.w * view.dpr) <= 2 && Math.abs(vpSize.height - view.h * view.dpr) <= 2,
    'viewport screenshot: a JPEG the size of the viewport', short({ image: vpSize, viewport: view }));
  check(vp.ok && vp.data?.pointer && moved.pointer && vp.data.pointer.x === moved.pointer.x && vp.data.pointer.y === moved.pointer.y,
    'viewport screenshot: pointer is where the last action left it', short({ shot: vp.data?.pointer, last: moved.pointer }));
  let markShot = await pageMark(A, S.tabMain);
  const full = await A.call('browser_screenshot', { area: 'fullpage', format: 'png', tabId: S.tabMain });
  const seenFull = await pageSince(A, S.tabMain, markShot);
  const fullSize = full.images?.[0] ? pngSize(Buffer.from(full.images[0].data, 'base64')) : null;
  const scale = full.data?.scale ?? 1;
  check(full.ok && fullSize && Math.abs(fullSize.height - Math.round(view.sh * scale * view.dpr)) <= 3 && Math.abs(fullSize.width - Math.round(view.sw * scale * view.dpr)) <= 3,
    'fullpage screenshot: the whole document (scaled as reported)', short({ image: fullSize, doc: { w: view.sw, h: view.sh }, scale }));
  check(full.ok && !!full.data?.pointer, 'fullpage screenshot: pointer reported', short(full.data?.pointer));
  // At human a full page taller than the viewport is still captured beyond the
  // viewport (a resize the page sees) — by design, and the result must say so.
  check(full.ok && typeof full.data?.pageSaw === 'string' && /resize/i.test(full.data.pageSaw),
    'human fullpage (page taller than the viewport): the result discloses what the page saw (pageSaw)', short(full.data?.pageSaw, 200));
  measure(`human fullpage: the page saw ${seenFull.resizes.length} resize event(s) ${short(seenFull.resizes.map((z) => `${z.w}x${z.h}`))}`);
  markShot = await pageMark(A, S.tabMain);
  const el = await A.call('browser_screenshot', { area: 'element', ref: s.ref('button', 'Sign in'), format: 'png', tabId: S.tabMain });
  const seenEl = await pageSince(A, S.tabMain, markShot);
  const vpAfterEl = await A.call('browser_screenshot', { area: 'viewport', format: 'png', tabId: S.tabMain });
  const elSize = el.images?.[0] ? pngSize(Buffer.from(el.images[0].data, 'base64')) : null;
  const loginRect = await rectOf(A, S.tabMain, 'login');
  check(el.ok && elSize && Math.abs(elSize.width - loginRect.width * view.dpr) <= 2 && Math.abs(elSize.height - loginRect.height * view.dpr) <= 2,
    'element screenshot: the element\'s own size', short({ image: elSize, rect: { w: loginRect.width, h: loginRect.height } }));
  check(el.ok && !!el.data?.pointer, 'element screenshot: pointer reported', short(el.data?.pointer));
  check(el.ok && seenEl.resizes.length === 0 && !el.data?.pageSaw, 'human element screenshot: the page saw no resize', short({ resizes: seenEl.resizes, pageSaw: el.data?.pageSaw }));
  compareWithViewport('human element screenshot', el, vpAfterEl, loginRect, view.dpr);

  // Stealth: an element below the fold is reached with the wheel and captured
  // inside the viewport; a full page taller than the viewport is refused;
  // nothing the page can see happens that a person would not do.
  const st = S.tabStealth;
  if (!st) return;
  await pageEval(A, st, 'scrollTo(0, 0)');
  await sleep(400);
  const ss = await snap(A, st);
  markShot = await pageMark(A, st);
  const se = await A.call('browser_screenshot', { area: 'element', ref: ss.ref('button', 'Bottom button'), format: 'png', tabId: st }, 120_000);
  const vpS = await A.call('browser_screenshot', { area: 'viewport', format: 'png', tabId: st });
  let seenS = await pageSince(A, st, markShot);
  const bRect = await rectOf(A, st, 'e2BottomBtn');
  const sdpr = await pageEval(A, st, 'devicePixelRatio');
  const seSize = se.images?.[0] ? pngSize(Buffer.from(se.images[0].data, 'base64')) : null;
  check(se.ok && seSize && Math.abs(seSize.width - bRect.width * sdpr) <= 2 && Math.abs(seSize.height - bRect.height * sdpr) <= 2,
    'stealth element screenshot of a button below the fold: the element\'s own size', se.ok ? short({ image: seSize, rect: bRect }) : se.text);
  check(se.ok && se.data?.scrolled?.via === 'wheel' && seenS.log.some((e) => e.type === 'wheel' && e.trusted) && seenS.resizes.length === 0 && !se.data?.pageSaw,
    'stealth element screenshot: reached by trusted wheel events; the page saw no resize', short({ scrolled: se.data?.scrolled, wheels: seenS.log.filter((e) => e.type === 'wheel').length, resizes: seenS.resizes, pageSaw: se.data?.pageSaw }));
  compareWithViewport('stealth element screenshot', se, vpS, bRect, sdpr);
  markShot = await pageMark(A, st);
  const sf = await A.call('browser_screenshot', { area: 'fullpage', tabId: st });
  const sv = await A.call('browser_screenshot', { area: 'viewport', tabId: st });
  seenS = await pageSince(A, st, markShot);
  check(!sf.ok && /resize/i.test(sf.text) && /Nothing was captured/i.test(sf.text), 'stealth fullpage of a page taller than the viewport: refused, saying why', short(sf.ok ? sf.data : sf.text, 200));
  check(sv.ok && sv.images?.length === 1 && seenS.resizes.length === 0 && !seenS.log.some((e) => e.type === 'scroll'),
    'stealth: the refused fullpage and a viewport shot left no resize and no scroll in the page', short({ resizes: seenS.resizes, scrolls: seenS.log.filter((e) => e.type === 'scroll').length }));
}

/**
 * The element screenshot must show what the viewport screenshot shows at the
 * element's rectangle (same moment, same scroll): its size alone would not
 * catch a clip taken at the wrong place. A 40-px-off region is compared too,
 * so a match is not just "both are background".
 */
function compareWithViewport(label, el, vp, rect, dpr) {
  try {
    if (!el.ok || !vp.ok || !el.images?.[0] || !vp.images?.[0]) throw new Error(el.ok ? vp.text : el.text);
    const a = decodePng(Buffer.from(el.images[0].data, 'base64'));
    const b = decodePng(Buffer.from(vp.images[0].data, 'base64'));
    const ox = Math.round(rect.left * dpr);
    const oy = Math.round(rect.top * dpr);
    let best = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) best = Math.min(best, regionDiff(a, b, ox + dx, oy + dy));
    const off = Math.min(regionDiff(a, b, ox, oy + Math.round(40 * dpr)), regionDiff(a, b, ox, oy - Math.round(40 * dpr)));
    check(best <= 6 && off > best * 3 + 4, `${label}: shows what the viewport shows at the element's rectangle`, `mean |diff| ${best.toFixed(2)} at the rect, ${Number.isFinite(off) ? off.toFixed(2) : 'n/a'} 40 px away`);
  } catch (err) {
    bad(`${label}: content comparison`, err.message);
  }
}

async function sectionEmulate() {
  const { A } = S;
  const before = await pageEval(A, S.tabMain, '({ w: innerWidth, ua: navigator.userAgent })');
  const dev = await A.call('browser_emulate', { device: 'iphone-15', tabId: S.tabMain });
  await must(A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: S.tabMain });
  const phone = await pageEval(A, S.tabMain, '({ w: innerWidth, dpr: devicePixelRatio, ua: navigator.userAgent, coarse: matchMedia("(pointer: coarse)").matches })');
  check(dev.ok && phone.w === 393 && phone.dpr === 3 && /iPhone/.test(phone.ua), 'emulate iphone-15: the page sees a 393 px, dpr 3, iPhone viewport', short(phone));
  const reset1 = await A.call('browser_emulate', { reset: true, tabId: S.tabMain });
  await must(A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: S.tabMain });
  const back = await pageEval(A, S.tabMain, '({ w: innerWidth, ua: navigator.userAgent })');
  check(reset1.ok && back.w === before.w && back.ua === before.ua, 'emulate reset: viewport and user agent restored', short({ before, back }));
  const scheme = () => pageEval(A, S.tabMain, '({ dark: matchMedia("(prefers-color-scheme: dark)").matches, bg: getComputedStyle(document.body).backgroundColor })');
  const baseline = await scheme();
  measure(`host default colour scheme seen by headless Edge: ${baseline.dark ? 'dark' : 'light'} (${baseline.bg})`);
  const want = baseline.dark ? 'light' : 'dark';
  const dark = await A.call('browser_emulate', { colorScheme: want, tabId: S.tabMain });
  const darkSeen = await scheme();
  const palette = { dark: 'rgb(21, 21, 25)', light: 'rgb(246, 246, 249)' };
  check(dark.ok && darkSeen.dark === (want === 'dark') && darkSeen.bg === palette[want], `emulate colorScheme ${want}: the page's ${want} palette applies`, short(darkSeen));
  const hitsBefore = (await (await fetch(`${S.web}/e2/stats`)).json()).hits['/e2/echo'] ?? 0;
  const off = await A.call('browser_emulate', { network: 'offline', tabId: S.tabMain });
  const offSeen = await pageEval(A, S.tabMain, 'fetch("/e2/echo").then(() => "reached", (e) => "failed: " + e.message).then((r) => ({ online: navigator.onLine, r }))');
  const hitsOffline = (await (await fetch(`${S.web}/e2/stats`)).json()).hits['/e2/echo'] ?? 0;
  check(off.ok && offSeen.online === false && /^failed/.test(offSeen.r) && hitsOffline === hitsBefore, 'emulate network offline: fetch fails and the server sees nothing', short({ offSeen, hitsBefore, hitsOffline }));
  await must(A, 'browser_emulate', { network: 'none', tabId: S.tabMain });
  const onSeen = await pageEval(A, S.tabMain, 'fetch("/e2/echo").then(() => "reached", (e) => "failed: " + e.message)');
  check(onSeen === 'reached', 'emulate network none: back online', onSeen);
  const reset2 = await A.call('browser_emulate', { reset: true, tabId: S.tabMain });
  const restored = await scheme();
  check(reset2.ok && restored.dark === baseline.dark && restored.bg === baseline.bg, 'emulate reset: colour scheme back to the host default', short({ baseline, restored }));
}

async function clickExpectingDialog(tab, ref) {
  // The click opens a modal dialog: the renderer blocks inside the handler, so
  // the call either returns or is failed by the daemon with the dialog named.
  const r = await S.A.call('browser_interact', { action: 'click', ref, humanize: 'off', tabId: tab }, 60_000);
  return r;
}

async function sectionDialogs() {
  const { A } = S;
  const tab = S.tabMain;
  let s = await snap(A, tab);
  const c = await clickExpectingDialog(tab, s.ref('button', 'Open confirm()'));
  check(c.ok || /dialog|confirm/i.test(c.text), 'a click that opens confirm() returns, or fails naming the dialog', short(c.ok ? c.data : c.text, 200));
  const st = await must(A, 'browser_status', { tabId: tab });
  check(st.dialogOpen?.type === 'confirm' && /destructive/.test(st.dialogOpen?.message ?? ''), 'status: dialogOpen names the confirm()', short(st.dialogOpen));
  const t0 = Date.now();
  const blocked = await A.call('browser_snapshot', { tabId: tab }, 60_000);
  check(!blocked.ok && /dialog/i.test(blocked.text) && Date.now() - t0 < 5_000, 'any other call on that tab fails fast, naming the dialog', `${Date.now() - t0} ms: ${short(blocked.text, 160)}`);
  const acc = await A.call('browser_dialog', { accept: true, tabId: tab });
  const out1 = await waitFor(() => pageEval(A, tab, 'document.getElementById("status").textContent').then((t) => (/confirm\(\) returned/.test(t) ? t : null)), 5_000);
  check(acc.ok && acc.data?.handled === true && out1 === 'confirm() returned true', 'browser_dialog accept:true → the page got true', short({ result: acc.data ?? acc.text, page: out1 }));
  s = await snap(A, tab);
  await clickExpectingDialog(tab, s.ref('button', 'Open confirm()'));
  const dis = await A.call('browser_dialog', { accept: false, tabId: tab });
  const out2 = await waitFor(() => pageEval(A, tab, 'document.getElementById("status").textContent').then((t) => (t === 'confirm() returned false' ? t : null)), 5_000);
  check(dis.ok && out2 === 'confirm() returned false', 'browser_dialog accept:false → the page got false', short({ page: out2 }));
  s = await snap(A, tab);
  await clickExpectingDialog(tab, s.ref('button', 'Open prompt()'));
  const pr = await A.call('browser_dialog', { accept: true, promptText: 'hello e2', tabId: tab });
  const out3 = await waitFor(() => pageEval(A, tab, 'document.getElementById("e2DialogOut").textContent').then((t) => (/prompt returned/.test(t) ? t : null)), 5_000);
  check(pr.ok && out3 === 'prompt returned "hello e2"', 'browser_dialog promptText → the page got the text', short({ page: out3 }));
  s = await snap(A, tab);
  await clickExpectingDialog(tab, s.ref('button', 'Open alert()'));
  const al = await A.call('browser_dialog', { accept: true, tabId: tab });
  const out4 = await waitFor(() => pageEval(A, tab, 'document.getElementById("e2DialogOut").textContent').then((t) => (t === 'alert closed' ? t : null)), 5_000);
  check(al.ok && out4 === 'alert closed', 'browser_dialog on alert() → the page continued', short({ page: out4 }));
  const none = await A.call('browser_dialog', { accept: true, tabId: tab });
  check(none.ok && none.data?.handled === false, 'browser_dialog with no dialog open says so', short(none.data ?? none.text));
}

async function servedBytes(name) {
  const res = await fetch(`${S.web}/download/${name}`);
  return Buffer.from(await res.arrayBuffer());
}

async function tabRows() {
  return (await must(S.A, 'browser_tabs', { action: 'list' })).tabs ?? [];
}

async function sectionDownloads() {
  const { A } = S;
  const tab = S.tabMain;
  const before = await tabRows();
  const currentBefore = (await must(A, 'browser_status', {})).you?.current;
  const w = await must(A, 'browser_network', { action: 'watch_downloads', tabId: tab });
  check(w.watching === true && w.mode === 'cdp' && typeof w.downloadPath === 'string' && w.downloadPath.includes(S.fragment),
    'watch_downloads: CDP mode, a folder inside G9_HOME', short(w));
  const s = await snap(A, tab);

  const cases = [
    { link: 'Download data file', name: 'e2-data.bin' },
    { link: 'Download report', name: 'e2-report.pdf', mime: 'application/pdf' },
    { link: 'Download empty file', name: 'e2-empty.txt', empty: true },
  ];
  for (const c of cases) {
    const expected = await servedBytes(c.name);
    const click = await A.call('browser_interact', { action: 'click', ref: s.ref('link', c.link), tabId: tab });
    check(click.ok, `click "${c.link}" (human)`, click.ok ? click.data?.delivery : click.text);
    const d = await A.call('browser_network', { action: 'wait_download', contains: c.name.replace(/\..*$/, ''), timeoutMs: 30_000, tabId: tab }, 60_000);
    if (!d.ok) { bad(`wait_download ${c.name}`, d.text); continue; }
    const f = d.data.file ?? {};
    const onDisk = d.data.path && fs.existsSync(d.data.path) ? fs.readFileSync(d.data.path) : null;
    check(d.data.filename === c.name && d.data.state === 'complete', `${c.name}: completed under its suggested name`, short({ filename: d.data.filename, state: d.data.state }));
    check(d.data.attribution === 'exact' && d.data.tabId === tab, `${c.name}: attributed exactly to the tab that clicked`, short({ attribution: d.data.attribution, tabId: d.data.tabId }));
    check(f.verified === true && f.exists === true && f.size === expected.length && f.sha256 === sha256(expected),
      `${c.name}: size and sha256 equal the served bytes`, short({ size: f.size, served: expected.length, sha: f.sha256?.slice(0, 16), want: sha256(expected).slice(0, 16) }));
    check(!!onDisk && sha256(onDisk) === sha256(expected), `${c.name}: the file on disk is the served file`, d.data.path);
    check(f.magicHex === expected.subarray(0, 16).toString('hex'), `${c.name}: magic bytes as served`, `${f.magicHex}`);
    if (c.mime) check(f.mime === c.mime, `${c.name}: type sniffed from content`, f.mime);
    if (c.empty) check(d.data.empty === true && f.size === 0 && f.mime === 'application/x-empty', `${c.name}: reported empty`, short({ empty: d.data.empty, mime: f.mime }));
    else check(d.data.empty === false, `${c.name}: not empty`, `${d.data.empty}`);
  }

  // A slow download is seen in progress, then completes.
  const expectedSlow = await servedBytes('e2-slow.bin');
  const t0 = Date.now();
  await A.call('browser_interact', { action: 'click', ref: s.ref('link', 'Download slow file'), humanize: 'off', tabId: tab });
  const inProgress = await waitFor(async () => {
    const l = await must(A, 'browser_network', { action: 'downloads', tabId: tab });
    return l.downloads?.find((x) => x.filename === 'e2-slow.bin' && x.state === 'in_progress') ?? null;
  }, 3_000, 100);
  check(!!inProgress, 'slow download: listed in_progress while it runs', short(inProgress));
  const slow = await A.call('browser_network', { action: 'wait_download', contains: 'e2-slow', timeoutMs: 30_000, tabId: tab }, 60_000);
  check(slow.ok && slow.data.file?.sha256 === sha256(expectedSlow) && Date.now() - t0 >= 1_200, 'slow download: waited to completion, bytes verified',
    short({ ms: Date.now() - t0, durationMs: slow.data?.durationMs, ok: slow.ok ? '' : slow.text }));

  const list = await must(A, 'browser_network', { action: 'downloads', tabId: tab });
  check(list.completed === 4 && list.empty === 1, 'downloads: 4 completed, 1 empty', short({ completed: list.completed, empty: list.empty }));

  // Edge's downloads hub (reported, not asserted — see the report).
  await sleep(1_500);
  const after = await tabRows();
  const newRows = after.filter((r) => !before.some((b) => b.tabId === r.tabId));
  const hub = after.filter((r) => /downloads-hub|edge:\/\/downloads/i.test(r.url ?? ''));
  S.hubMain = hub;
  measure(`after 4 downloads on the default profile: new tabs ${short(newRows.map((r) => ({ tabId: r.tabId, url: r.url, attachable: r.attachable, owner: r.owner })))}`);
  // Round 3: the manager writes browser.show_hub_popup_on_download_start:false before launch.
  const prefsNow = accountState(S.profileDir);
  check(hub.length === 0 && newRows.length === 0 && prefsNow.hubPref === false,
    'no edge://downloads-hub tab after 4 downloads (the profile carries show_hub_popup_on_download_start:false)', short({ newRows: newRows.map((r) => r.url), hubPref: prefsNow.hubPref }));
  const st = await must(A, 'browser_status', {});
  check(st.you?.current === currentBefore, 'my current tab did not change (a hub tab never becomes current)', `${currentBefore} → ${st.you?.current}`);
  for (const h of hub) {
    const r = await A.call('browser_snapshot', { tabId: h.tabId });
    measure(`snapshot of the ${h.url} tab: ${r.ok ? 'answered' : short(r.text, 200)}`);
    check(h.attachable === false, `browser_tabs list marks the ${h.url} tab attachable:false (tools refuse it)`, short({ attachable: h.attachable, attached: h.attached, tool: r.ok ? 'answered' : r.text.slice(0, 80) }));
  }
  if (hub.length) {
    // An agent with no current tab gets a default one: never a browser-internal page.
    const D = newAgent('e2-agent-D');
    await D.init();
    const r = await D.call('browser_snapshot', {});
    const stD = await D.call('browser_status', {});
    check(r.ok && /^http/.test(r.data?.url ?? ''), 'a new agent\'s default tab is a controllable page, not the downloads hub',
      short({ snapshot: r.ok ? r.data?.url : r.text.slice(0, 160), current: stD.data?.you?.current, hubTabs: hub.map((h) => h.tabId) }));
    D.close();
    await waitFor(() => D.exited, 5_000);
  }

  const stop = await must(A, 'browser_network', { action: 'stop_downloads', tabId: tab });
  check(stop.watching === false && stop.seen === 4, 'stop_downloads: watch ended, 4 seen', short(stop));
  const w2 = await must(A, 'browser_network', { action: 'watch_downloads', tabId: tab });
  const fresh = await must(A, 'browser_network', { action: 'downloads', tabId: tab });
  check(w2.watching && fresh.downloads?.length === 0, 'a new watch starts a fresh list', `${fresh.downloads?.length}`);
  await must(A, 'browser_network', { action: 'stop_downloads', tabId: tab });
  // Close hub tabs so they do not linger into later sections.
  for (const h of hub) await A.call('browser_tabs', { action: 'close', tabId: h.tabId });
}

async function stats() {
  return (await (await fetch(`${S.web}/e2/stats`)).json()).hits;
}

async function sectionHar() {
  const { A } = S;
  const tab = S.tabMain;
  const s = await snap(A, tab);
  const counterRef = s.ref('button', 'Fetch counter');
  const clickCounter = async () => {
    await pageEval(A, tab, 'window.e2counter = null');
    await must(A, 'browser_interact', { action: 'click', ref: counterRef, humanize: 'off', tabId: tab });
    return waitFor(() => pageEval(A, tab, 'window.e2counter'), 5_000, 100);
  };
  const first = await clickCounter();
  const k1 = first?.n;
  check(Number.isInteger(k1) && first.pinned === false, 'live: the page fetched a counter from the server', short(first));
  const rec = await must(A, 'browser_network', { action: 'record_har', filter: '/e2/counter', tabId: tab });
  const entry = rec.har?.log?.entries?.find((e) => /\/e2\/counter$/.test(e.request?.url ?? ''));
  check(rec.recorded >= 1 && entry && JSON.parse(entry.response?.content?.text ?? '{}').n === k1, 'record_har: the counter response, body included', short({ recorded: rec.recorded, body: entry?.response?.content?.text }));
  const pin = await must(A, 'browser_network', { action: 'pin', har: rec.har, tabId: tab });
  check(pin.pinned === true && pin.strict === false, 'pin: pinned', short(pin));
  const hits0 = (await stats())['/e2/counter'] ?? 0;
  const pinned = await clickCounter();
  const hits1 = (await stats())['/e2/counter'] ?? 0;
  check(pinned?.n === k1 && pinned.pinned === true && hits1 === hits0, 'pinned: the page got the recorded answer and the server was not asked', short({ page: pinned, serverHits: `${hits0} → ${hits1}` }));
  const ps = await must(A, 'browser_network', { action: 'pin_status', tabId: tab });
  check(ps.pinned === true && ps.served >= 1, 'pin_status counts what it served', short(ps));
  const unpin = await must(A, 'browser_network', { action: 'unpin', tabId: tab });
  const live = await clickCounter();
  const hits2 = (await stats())['/e2/counter'] ?? 0;
  check(unpin.unpinned === true && live?.n > k1 && live.pinned === false && hits2 === hits1 + 1, 'unpin: live again (new number, server asked)', short({ page: live, serverHits: hits2 }));

  const strict = await must(A, 'browser_network', { action: 'pin', har: rec.har, strict: true, tabId: tab });
  const u0 = (await stats())['/e2/unrecorded'] ?? 0;
  await pageEval(A, tab, 'window.e2unrecorded = null');
  await must(A, 'browser_interact', { action: 'click', ref: s.ref('button', 'Fetch unrecorded'), humanize: 'off', tabId: tab });
  const un = await waitFor(() => pageEval(A, tab, 'window.e2unrecorded'), 5_000, 100);
  const u1 = (await stats())['/e2/unrecorded'] ?? 0;
  check(strict.strict === true && !!un?.error && u1 === u0, 'strict pin: a request the HAR lacks fails and never reaches the server', short({ page: un, serverHits: `${u0} → ${u1}` }));
  const again = await clickCounter();
  check(again?.n === k1 && again.pinned === true, 'strict pin: recorded requests are still served', short(again));
  const ps2 = await must(A, 'browser_network', { action: 'pin_status', tabId: tab });
  check(ps2.failed >= 1 && ps2.strict === true, 'pin_status counts the refused request', short(ps2));
  await must(A, 'browser_network', { action: 'unpin', tabId: tab });
}

function loginSpec(id) {
  const css = (sel) => ({ locators: [{ kind: 'css', css: sel }] });
  return {
    format: 'g9/flowspec',
    schemaVersion: 1,
    id,
    name: 'Engine 2 lab — sign in',
    startUrl: S.testUrl,
    steps: [
      { id: 's1', action: 'navigate', url: S.testUrl, waitBudgetMs: 15_000 },
      { id: 's2', action: 'type', target: css('#user'), value: 'admin', waitBudgetMs: 5_000 },
      { id: 's3', action: 'type', target: css('#pass'), value: 'g9secret', waitBudgetMs: 5_000 },
      { id: 's4', action: 'click', target: css('#login'), waitBudgetMs: 5_000 },
      { id: 's5', action: 'assert', oracle: { kind: 'text', contains: 'Signed in as admin.' }, waitBudgetMs: 5_000 },
    ],
  };
}

async function sectionRecording() {
  const { A } = S;
  const tab = S.tabMain;
  await must(A, 'browser_navigate', { action: 'goto', url: S.testUrl, tabId: tab });
  await must(A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: tab });
  const start = await A.call('browser_recording', { action: 'start', name: 'e2 recorded sign-in', tabId: tab });
  check(start.ok, 'recording start on a launched tab', start.ok ? short(start.data) : start.text);
  if (start.ok) {
    let s = await snap(A, tab);
    await must(A, 'browser_interact', { action: 'type', ref: s.ref('textbox', 'Username'), text: 'admin', typos: false, tabId: tab });
    s = await snap(A, tab);
    const passRef = s.refs.find((r) => r.role === 'textbox' && /password/i.test(r.name))?.ref;
    await must(A, 'browser_interact', { action: 'type', ref: passRef, text: 'g9secret', tabId: tab });
    await must(A, 'browser_interact', { action: 'click', ref: s.ref('button', 'Sign in'), tabId: tab });
    // While the recorder is armed: nothing of it in the page's main world.
    S.midRecordingNames = await mainWorldLeaks(tab);
    check(S.midRecordingNames.length === 0, 'while recording: no G9 name in the page\'s main world', short(S.midRecordingNames));
    const stop = await A.call('browser_recording', { action: 'stop', tabId: tab });
    check(stop.ok && stop.data?.steps >= 3, 'recording stop: steps captured', stop.ok ? short(stop.data?.outline) : stop.text);
    if (stop.ok) {
      S.recordedId = stop.data.id;
      measure(`recorded ${stop.data.steps} steps, inputSamples ${stop.data.inputSamples ?? 0}: ${short(stop.data.outline, 500)}`);
      const list = await must(A, 'browser_recording', { action: 'list' });
      check(list.recordings?.some((r) => r.id === S.recordedId && r.engine === 'launched'), 'the recording is in the launched-engine store', `${list.recordings?.length} recording(s)`);
      await must(A, 'browser_navigate', { action: 'goto', url: S.testUrl, tabId: tab });
      await must(A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: tab });
      const rp = await A.call('browser_recording', { action: 'replay', id: S.recordedId, timing: 'adaptive', tabId: tab }, 300_000);
      const status = await pageEval(A, tab, 'document.getElementById("status").textContent');
      check(rp.ok && /^PASS/.test(rp.data?.verdict ?? '') && status === 'Signed in as admin.', 'replay of the recording: verdict and the page signed in',
        short({ verdict: rp.data?.verdict ?? rp.text, status }));
    }
  }

  // An imported FlowSpec, replayed in a launched browser opened for it.
  const specId = 'e2.lab.sign-in';
  const imp = await A.call('browser_recording', { action: 'import_spec', spec: loginSpec(specId), engine: 'launched' });
  check(imp.ok && imp.data?.id && imp.data?.steps === 5 && imp.data?.engine === 'launched', 'import_spec into the launched store', short(imp.data ?? imp.text));
  if (!imp.ok) return;
  S.specRecordingId = imp.data.id;
  const rp = await A.call('browser_recording', { action: 'replay', id: imp.data.id, engine: 'launched', seedKnownWorld: true, seed: 'e2-seed' }, 300_000);
  check(rp.ok, 'replay engine:"launched" of the imported FlowSpec', rp.ok ? '' : rp.text);
  if (!rp.ok) return;
  const d = rp.data;
  S.tabReplay = d.ranOn?.tabId;
  check(d.ranOn?.openedForThisReplay === true && Number.isInteger(d.ranOn?.tabId), 'replay opened its own launched tab (ranOn)', short(d.ranOn));
  check(['PASS', 'PASS_WITH_WARNING'].includes(d.verdict), 'replay verdict', `${d.verdict} (${d.passed ?? '?'}/${d.total ?? '?'})`);
  const why = (d.steps ?? []).filter((x) => x.warning || x.warnings?.length || x.matchedBy).map((x) => ({ step: x.index ?? x.id, matchedBy: x.matchedBy, warning: x.warning ?? x.warnings }));
  measure(`FlowSpec replay: verdict ${d.verdict}; result keys ${Object.keys(d).join(',')}; warnings ${short(d.warnings ?? d.summary?.warnings ?? null, 400)}; steps ${short(why, 400)}; surprises ${short(d.surprises ?? null, 300)}`);
  const status = S.tabReplay ? await pageEval(A, S.tabReplay, 'document.getElementById("status").textContent') : null;
  check(status === 'Signed in as admin.', 'after the replay the page itself says signed in', status);
  check(d.humanize?.level && (d.humanizeSeed === 'e2-seed' || d.humanize?.seed === 'e2-seed' || JSON.stringify(d).includes('e2-seed')), 'replay reports humanize level and the seed used', short({ humanize: d.humanize, humanizeSeed: d.humanizeSeed }));
  const ev = d.evidence;
  const runDir = ev?.runId ? path.join(S.home, 'runs', ev.runId) : null;
  const resultJson = runDir && fs.existsSync(path.join(runDir, 'result.json')) ? JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8')) : null;
  const frameFiles = runDir && fs.existsSync(path.join(runDir, 'frames')) ? fs.readdirSync(path.join(runDir, 'frames')).filter((f) => f.endsWith('.jpg')) : [];
  check(!!resultJson && ev.frames > 0 && frameFiles.length === ev.frames && fs.existsSync(path.join(runDir, 'engine.json')),
    'evidence run on disk: engine.json, result.json, the reported number of frames', short({ runId: ev?.runId, frames: ev?.frames, files: frameFiles.length, verdict: resultJson?.verdict }));
  const kw = await A.call('browser_recording', { action: 'known_world', id: imp.data.id });
  check(kw.ok && kw.data?.runs >= 1, 'seedKnownWorld created a known world', short(kw.data ?? kw.text));
}

/** Names in the page's MAIN world that G9 put there (page-owned __g9 names excluded). */
async function mainWorldLeaks(tab) {
  const pageOwn = [...new Set([...fs.readFileSync(path.join(HERE, 'testpage.html'), 'utf8').matchAll(/window\.(__g9\w+)/g)].map((m) => m[1]))];
  return pageEval(S.A, tab, `Object.getOwnPropertyNames(window).filter((n) => /^__g9|g9emit/i.test(n) && !${JSON.stringify(pageOwn)}.includes(n))`);
}

async function sectionIssueVideo() {
  const { A } = S;
  const tab = S.tabMain;
  await must(A, 'browser_navigate', { action: 'goto', url: S.testUrl, tabId: tab });
  await must(A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: tab });
  const created = await A.call('browser_issue', { action: 'create', title: 'e2: lab button does nothing', body: 'engine2-livetest', severity: 'minor', tabId: tab });
  check(created.ok && created.data?.id, 'issue create on a launched tab', short(created.data ?? created.text, 200));
  if (!created.ok) return;
  const id = created.data.id;
  const start = await A.call('browser_issue', { action: 'video_start', id, everyNthFrame: 1, tabId: tab });
  check(start.ok && start.data?.recording === true, 'video_start', short(start.data ?? start.text));
  const s = await snap(A, tab);
  const t0 = Date.now();
  await must(A, 'browser_interact', { action: 'click', ref: s.ref('button', 'Lab button'), tabId: tab });
  await must(A, 'browser_interact', { action: 'hover', ref: s.ref('button', 'Hover target'), tabId: tab });
  await must(A, 'browser_interact', { action: 'scroll', direction: 'down', amount: 300, tabId: tab });
  const status = await must(A, 'browser_issue', { action: 'video_status', tabId: tab });
  const stop = await A.call('browser_issue', { action: 'video_stop', id, tabId: tab });
  const ms = Date.now() - t0;
  check(stop.ok && stop.data?.attached === true && stop.data?.frames > 0, 'video_stop: frames captured and attached', short({ frames: stop.data?.frames, status: status.frames, err: stop.ok ? '' : stop.text }));
  check(stop.ok && stop.data?.pointerTrack?.samples > 10, 'video_stop: a pointer track was attached', short(stop.data?.pointerTrack));
  measure(`video: ${stop.data?.frames} frames over ${ms} ms of humanized input; pointer track ${stop.data?.pointerTrack?.samples} samples`);
  const issue = await must(A, 'browser_issue', { action: 'get', id });
  const atts = issue.attachments ?? [];
  const trackRow = atts.find((a) => a.name === 'pointer-track.json');
  const videoRow = atts.find((a) => a.kind === 'video');
  check(!!trackRow && !!videoRow && atts.some((a) => /screenshot|image/.test(a.kind ?? a.mime ?? '')), 'the issue carries a screenshot, the video and pointer-track.json', short(atts.map((a) => `${a.kind}:${a.name}`)));
  if (trackRow) {
    const t = await must(A, 'browser_issue', { action: 'attachment', attachmentId: trackRow.id });
    const track = JSON.parse(Buffer.from(t.dataBase64 ?? '', 'base64').toString('utf8'));
    const vp = track.viewport ?? { width: 1e9, height: 1e9 };
    const inView = track.samples?.every((p) => p.x >= 0 && p.y >= 0 && p.x <= vp.width + 1 && p.y <= vp.height + 1);
    const types = new Set(track.samples?.map((p) => p.type));
    check(track.format === 'g9-pointer/1' && track.samples?.length === stop.data?.pointerTrack?.samples && inView, 'pointer-track.json: every sample inside the viewport', short({ n: track.samples?.length, viewport: track.viewport, types: [...types] }));
    check(types.has('mouseMoved') && types.has('mousePressed') && types.has('mouseReleased'), 'pointer track has moves, a press and a release', short([...types]));
  }
  if (videoRow) {
    const v = await must(A, 'browser_issue', { action: 'attachment', attachmentId: videoRow.id });
    const video = JSON.parse(Buffer.from(v.dataBase64 ?? '', 'base64').toString('utf8'));
    const withPointer = video.frames?.filter((f) => f.pointer).length ?? 0;
    const first = video.frames?.[0] ? jpegSize(Buffer.from(video.frames[0].data, 'base64')) : null;
    check(video.format === 'g9-frames/1' && video.frames?.length === stop.data?.frames && withPointer > 0 && !!first,
      'the video attachment: JPEG frames, pointer on frames', short({ frames: video.frames?.length, withPointer, first }));
  }
}

async function sectionTwoAgents() {
  const { A } = S;
  const B = newAgent('e2-agent-B');
  await B.init();
  S.B = B;
  const sb = await B.call('browser_snapshot', { tabId: S.tabMain });
  check(sb.ok && sb.data?.url === S.testUrl, 'agent B may READ agent A\'s tab (snapshot)', sb.ok ? '' : sb.text);
  const refB = parseRefs(sb.data?.tree).find((r) => r.role === 'button' && r.name === 'Lab button')?.ref;
  const mark = await pageMark(A, S.tabMain);
  const clickB = await B.call('browser_interact', { action: 'click', ref: refB, tabId: S.tabMain });
  const seen = await pageSince(A, S.tabMain, mark);
  check(!clickB.ok && /owned by agent-\d+ \(e2-agent-A\)/.test(clickB.text) && !seen.log.some((e) => e.type === 'mousedown'),
    'agent B\'s click on A\'s tab is refused naming A, and nothing reached the page', short(clickB.text, 200));
  const evalB = await B.call('browser_console', { action: 'evaluate', expression: '1', tabId: S.tabMain });
  check(!evalB.ok && /owned by/.test(evalB.text), 'agent B\'s evaluate (mutating) is refused too');
  const stB = await must(B, 'browser_status', {});
  check(stB.agents?.some((a) => a.id === S.agentA) && stB.agents?.some((a) => a.id === stB.you?.agentId), 'B\'s status lists both agents', short(stB.agents?.map((a) => `${a.id}:${a.name}`)));

  const C = newAgent('e2-agent-C');
  await C.init();
  const openedC = await must(C, 'browser_tabs', { action: 'open', url: S.testUrl });
  const tabC = openedC.tabId;
  await must(C, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: tabC, timeoutMs: 20_000 });
  // Round 2 (bench B4): a second Engine 2 tab put the first one behind it,
  // and input to the hidden one was lost. Every page G9 opens has its own
  // window now, so both must be visible, and the first still takes input.
  const visMain = await pageEval(A, S.tabMain, 'document.visibilityState');
  const visC = await pageEval(C, tabC, 'document.visibilityState');
  const sm = await snap(A, S.tabMain);
  const mk = await pageMark(A, S.tabMain);
  const ck = await A.call('browser_interact', { action: 'click', ref: sm.ref('button', 'Lab button'), humanize: 'human', tabId: S.tabMain });
  const ckSeen = await pageSince(A, S.tabMain, mk);
  check(visMain === 'visible' && visC === 'visible' && ck.ok && ck.data?.delivery === 'delivered' && ckSeen.log.some((e) => e.type === 'click' && e.target === 'e2Btn' && e.trusted),
    'another tab opened in the same context: both pages stay visible, and a human click on the first is delivered', short({ visMain, visC, click: ck.ok ? `${ck.data?.delivery} in ${ck.ms} ms` : ck.text }));
  const snC = await snap(B, tabC);
  const refusedC = await B.call('browser_interact', { action: 'click', ref: snC.ref('button', 'Lab button'), humanize: 'off', tabId: tabC });
  check(!refusedC.ok && /\(e2-agent-C\)/.test(refusedC.text), 'B is refused on C\'s tab', short(refusedC.text, 160));
  C.close();
  await waitFor(() => C.exited, 8_000, 100);
  const released = await waitFor(async () => {
    const rows = (await must(B, 'browser_tabs', { action: 'list' })).tabs;
    const row = rows.find((t) => t.tabId === tabC);
    return row && !row.owner ? row : null;
  }, 8_000, 200);
  check(!!released && C.exited, 'C disconnects (its shim exits) → its claim is released', short(released));
  const nowB = await B.call('browser_interact', { action: 'click', ref: snC.ref('button', 'Lab button'), humanize: 'off', tabId: tabC });
  const pageSaw = await pageEval(B, tabC, 'window.e2log.filter((e) => e.type === "click" && e.target === "e2Btn" && e.isTrusted !== false).length');
  const row = (await must(B, 'browser_tabs', { action: 'list' })).tabs.find((t) => t.tabId === tabC);
  check(nowB.ok && pageSaw >= 1 && row?.owner === stB.you?.agentId, 'B can now act on it, and owns it', short({ owner: row?.owner, clicks: pageSaw }));
  S.tabC = tabC;
}

/**
 * Reads are allowed on any tab at any time (never queued). Does another agent
 * reading a tab — snapshot after snapshot — disturb a humanized action running
 * on it? The same seeded plan is timed without and with a reader, from the
 * same starting pointer, so any difference is delivery latency.
 */
async function sectionConcurrentReads() {
  const { A } = S;
  const B = S.B ?? newAgent('e2-agent-B');
  if (!S.B) { await B.init(); S.B = B; }
  const tab = S.tabMain;
  const s = await snap(A, tab);
  const home = { action: 'hover', ref: s.ref('button', 'Hover target'), humanize: 'human', seed: 'e2-reads-home', tabId: tab };
  const click = { action: 'click', ref: s.ref('button', 'Lab button'), humanize: 'human', seed: 'e2-reads-click', tabId: tab };
  const type = { action: 'type', ref: s.ref('textbox', 'Lab text'), text: 'concurrent', clear: true, typos: false, humanize: 'human', seed: 'e2-reads-type', tabId: tab };
  const rows = [];
  for (let trial = 1; trial <= 3; trial++) {
    for (const disturbed of [false, true]) {
      for (const args of [click, type]) {
        await must(A, 'browser_interact', home);
        let stop = false;
        const reads = [];
        const reader = disturbed ? (async () => {
          while (!stop) {
            const t = Date.now();
            const r = await B.call('browser_snapshot', { tabId: tab });
            reads.push({ ms: Date.now() - t, ok: r.ok });
            await sleep(100);
          }
        })() : null;
        const r = await A.call('browser_interact', args, 120_000);
        stop = true;
        await reader;
        rows.push({ trial, action: args.action, disturbed, ms: r.ms, ok: r.ok && r.data?.delivery === 'delivered', reads: reads.length, readMs: Math.round(median(reads.map((x) => x.ms)) ?? 0), err: r.ok ? null : r.text.slice(0, 160) });
      }
    }
  }
  for (const action of ['click', 'type']) {
    const base = rows.filter((x) => x.action === action && !x.disturbed).map((x) => x.ms);
    const dist = rows.filter((x) => x.action === action && x.disturbed).map((x) => x.ms);
    measure(`${action} with the same seed: alone ${short(base)} ms; while agent B snapshots every ~100 ms: ${short(dist)} ms (reads per action ${short(rows.filter((x) => x.action === action && x.disturbed).map((x) => `${x.reads}×${x.readMs}ms`))})`);
    check(rows.filter((x) => x.action === action).every((x) => x.ok), `${action}: delivered with and without a concurrent reader`, short(rows.filter((x) => !x.ok)));
    check(Math.max(...dist) <= Math.max(...base) * 2 + 1_500, `${action}: another agent's reads do not stall it (≤ 2× the undisturbed time + 1.5 s)`, `alone max ${Math.max(...base)} ms, with reader max ${Math.max(...dist)} ms`);
  }
}

/**
 * maxParallel is the daemon's gate for calls that drive a page. Set to 1 from
 * a ui client: a second mutating call must wait for the slot (the gate
 * works), but a navigate wait must not hold one (bench B6: a wait held a slot
 * and another agent's click queued behind it for the wait's whole timeout).
 */
async function sectionSlots() {
  const { A } = S;
  const B = S.B;
  if (!B || !Number.isInteger(S.tabC)) { skip('slots', 'needs the agents section (agent B owning tab C)'); return; }
  const ui = S.ui ?? await uiClient(S.port);
  S.ui = ui;
  const got = await ui.admin('settings.get');
  const prevMax = got.result?.maxParallel ?? 8;
  const set1 = await ui.admin('settings.set', { patch: { maxParallel: 1 } });
  check(set1.ok && (set1.result?.maxParallel ?? (await ui.admin('settings.get')).result?.maxParallel) === 1, 'admin settings.set maxParallel:1 from a ui client', short(set1.result ?? set1.error));
  try {
    const sA = await snap(A, S.tabMain);
    const sB = await snap(B, S.tabC);
    const clicksOnC = () => pageEval(B, S.tabC, 'window.e2log.filter((e) => e.type === "click" && e.target === "e2Btn" && e.trusted).length');
    // Control: a slot-holding human type, and another agent's click 400 ms later.
    let c0 = await clicksOnC();
    const t0 = Date.now();
    let typeEnd = null;
    let clickEnd = null;
    const typing = A.call('browser_interact', { action: 'type', ref: sA.ref('textbox', 'Lab text'), text: 'gate check', clear: true, typos: false, humanize: 'human', tabId: S.tabMain }, 120_000)
      .then((r) => { typeEnd = Date.now() - t0; return r; });
    await sleep(400);
    const clicking = B.call('browser_interact', { action: 'click', ref: sB.ref('button', 'Lab button'), humanize: 'off', tabId: S.tabC })
      .then((r) => { clickEnd = Date.now() - t0; return r; });
    const [ty, cl] = await Promise.all([typing, clicking]);
    let c1 = await clicksOnC();
    check(ty.ok && cl.ok && c1 === c0 + 1 && clickEnd >= typeEnd - 100,
      'maxParallel 1: another agent\'s click waits until the running type releases the slot (the gate works)', short({ typeEndMs: typeEnd, clickEndMs: clickEnd, pageClicks: c1 - c0, err: ty.ok && cl.ok ? null : `${ty.text} ${cl.text}` }));
    // The fix: a navigate wait for something that never comes holds no slot.
    c0 = c1;
    const t1 = Date.now();
    let waitEnd = null;
    const waiting = A.call('browser_navigate', { action: 'wait', selector: '#e2-never-there', timeoutMs: 6_000, tabId: S.tabMain }, 60_000)
      .then((r) => { waitEnd = Date.now() - t1; return r; });
    await sleep(400);
    const c2 = await B.call('browser_interact', { action: 'click', ref: sB.ref('button', 'Lab button'), humanize: 'off', tabId: S.tabC });
    const click2 = Date.now() - t1;
    const w = await waiting;
    c1 = await clicksOnC();
    check(c2.ok && c1 === c0 + 1 && click2 < 3_000 && !w.ok && waitEnd >= 5_500,
      'maxParallel 1: a click runs at once while another agent\'s navigate wait is pending (a wait holds no slot)', short({ clickDoneAtMs: click2, clickCallMs: c2.ms, pageClicks: c1 - c0, waitEndMs: waitEnd, wait: w.ok ? 'returned ok?!' : short(w.text, 100) }));
    measure(`slots at maxParallel 1: click behind a human type finished at ${clickEnd} ms (type at ${typeEnd} ms); click during a 6 s wait took ${c2.ms} ms`);
  } finally {
    await ui.admin('settings.set', { patch: { maxParallel: prevMax } }).catch(() => null);
  }
}

async function sectionParallel() {
  const { A } = S;
  const n = 4;
  const P = [];
  for (let i = 1; i <= n; i++) {
    const agent = newAgent(`e2-par-${i}`);
    await agent.init();
    P.push(agent);
  }
  S.P = P;
  const ctxs = [];
  for (let i = 0; i < n; i++) ctxs.push((await must(A, 'browser_engine', { action: 'context', humanize: 'human' })).contextId);
  check(new Set(ctxs).size === n && !ctxs.includes(S.defaultContext), `${n} fresh browser contexts in one engine`, short(ctxs));
  const tabs = [];
  for (let i = 0; i < n; i++) {
    const o = await must(P[i], 'browser_tabs', { action: 'open', url: S.testUrl, context: ctxs[i] });
    tabs.push(o.tabId);
    check(o.contextId === ctxs[i], `agent ${i + 1} opened its tab in its own context`, short(o));
  }
  S.parallelTabs = tabs;
  await Promise.all(tabs.map((t, i) => must(P[i], 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: t, timeoutMs: 20_000 })));
  const spans = [];
  const t0 = Date.now();
  const outcomes = await Promise.all(P.map(async (agent, i) => {
    const tab = tabs[i];
    const started = Date.now();
    const s = await snap(agent, tab);
    const value = `ctx${i + 1}-${crypto.randomBytes(3).toString('hex')}`;
    const typed = await agent.call('browser_interact', { action: 'type', ref: s.ref('textbox', 'Cookie value'), text: value, typos: false, humanize: 'human', tabId: tab }, 120_000);
    const clicked = await agent.call('browser_interact', { action: 'click', ref: s.ref('button', 'Set cookie'), humanize: 'human', tabId: tab }, 120_000);
    spans.push({ i, start: started - t0, end: Date.now() - t0 });
    return { value, typed, clicked };
  }));
  const wall = Date.now() - t0;
  const sum = spans.reduce((a, s) => a + (s.end - s.start), 0);
  check(outcomes.every((o) => o.typed.ok && o.clicked.ok && o.typed.data?.delivery === 'delivered' && o.clicked.data?.delivery === 'delivered'),
    `${n} agents typed and clicked (human) concurrently, all delivered`, short(outcomes.map((o) => (o.typed.ok && o.clicked.ok ? 'ok' : `${o.typed.text} ${o.clicked.text}`))));
  const overlap = spans.every((a) => spans.some((b) => b !== a && b.start < a.end && a.start < b.end));
  check(overlap && wall < sum * 0.6, 'they ran at the same time (wall time well under the sum)', `wall ${wall} ms vs sum ${sum} ms; spans ${short(spans)}`);
  measure(`${n} parallel human sequences: wall ${wall} ms, sum of individual ${sum} ms`);
  for (let i = 0; i < n; i++) {
    const own = outcomes[i].value;
    const docCookie = await pageEval(P[i], tabs[i], 'document.cookie');
    const echo = await pageEval(P[i], tabs[i], 'fetch("/e2/echo").then((r) => r.json())');
    const others = outcomes.filter((_, j) => j !== i).map((o) => o.value);
    const cookies = await must(P[i], 'browser_inspect', { what: 'cookies', tabId: tabs[i] });
    const e2who = cookies.cookies?.filter((c) => c.name === 'e2who').map((c) => c.value);
    check(docCookie.includes(`e2who=${own}`) && echo.cookie.includes(`e2who=${own}`) && !others.some((o) => docCookie.includes(o) || echo.cookie.includes(o)) && e2who?.length === 1 && e2who[0] === own,
      `context ${i + 1}: only its own cookie (page, server and inspect agree)`, short({ docCookie, server: echo.cookie, inspect: e2who }));
  }
  const mainCookie = await pageEval(A, S.tabMain, 'document.cookie');
  check(!/e2who=ctx/.test(mainCookie), 'the default context saw none of them', mainCookie);

  // A download in a created context: its own folder, exact attribution, the served bytes.
  try {
    const P1 = P[1];
    const t1 = tabs[1];
    const w = await must(P1, 'browser_network', { action: 'watch_downloads', tabId: t1 });
    const sP = await snap(P1, t1);
    const expected = await servedBytes('e2-data.bin');
    const c = await P1.call('browser_interact', { action: 'click', ref: sP.ref('link', 'Download data file'), tabId: t1 });
    const d = await P1.call('browser_network', { action: 'wait_download', contains: 'e2-data', timeoutMs: 30_000, tabId: t1 }, 60_000);
    const onDisk = d.ok && d.data.path && fs.existsSync(d.data.path) ? fs.readFileSync(d.data.path) : null;
    check(c.ok && d.ok && d.data.attribution === 'exact' && d.data.tabId === t1 && d.data.file?.sha256 === sha256(expected) && !!onDisk && sha256(onDisk) === sha256(expected) &&
      typeof w.downloadPath === 'string' && w.downloadPath.includes(ctxs[1]) && d.data.path.startsWith(w.downloadPath),
    'a download in a created context: its own folder, attributed exactly, the served bytes', short(d.ok ? { attribution: d.data.attribution, tabId: d.data.tabId, folder: w.downloadPath, path: d.data.path } : d.text, 400));
    await P1.call('browser_network', { action: 'stop_downloads', tabId: t1 });
  } catch (err) {
    bad('a download in a created context', err.message);
  }
}

/**
 * Windows the PAGE opens. They join the opener's browser window as tabs, in
 * front of the opener (platform-cdp createTabIn gives a window of its own only
 * to pages G9 opens). Three ways a page does it:
 *  - window.open() from a click (OAuth/SSO, payment, "open in new window");
 *  - a target=_blank link;
 *  - a target=_blank link to a download.
 * Checked: the agent finds the new tab (browser_tabs wait), its first load is
 * captured, it can be driven, the opener still takes input, and the tool's
 * report agrees with the page throughout.
 */
async function openerAlive(tab) {
  const t0 = Date.now();
  try {
    const v = await pageEval(S.A, tab, 'String(window.e2popup)');
    return { ok: true, ms: Date.now() - t0, value: v };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: short(err.message, 160) };
  }
}

async function freshTab(label) {
  const o = await must(S.A, 'browser_tabs', { action: 'open', url: `${S.testUrl}?${label}=opener` });
  await must(S.A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: o.tabId, timeoutMs: 20_000 });
  return o.tabId;
}

async function sectionPopup() {
  const { A } = S;
  // Each part runs on a tab of its own: a wedged opener (see the report) must
  // not take the main tab, and every later section, down with it.
  let tab = await freshTab('wopen');

  // -- window.open() from a click
  let s = await snap(A, tab);
  const t0 = Date.now();
  const opened = await A.call('browser_interact', { action: 'click', ref: s.ref('button', 'Open popup'), tabId: tab }, 90_000);
  const clickMs = Date.now() - t0;
  const w = await A.call('browser_tabs', { action: 'wait', url: 'popup=1', openerTabId: tab, timeoutMs: 15_000 }, 30_000);
  const rows = await tabRows();
  const children = rows.filter((r) => r.openerTabId === tab);
  const alive = await openerAlive(tab);
  S.windowOpen = { clickMs, click: opened.ok ? opened.data?.delivery : short(opened.text, 200), wait: w.ok ? w.data?.tabId : short(w.text, 120), children: children.map((r) => ({ tabId: r.tabId, url: r.url })), opener: alive };
  measure(`window.open() from a human click: ${short(S.windowOpen, 700)}`);
  check(opened.ok && opened.data?.delivery === 'delivered' && clickMs < 15_000 && w.ok && Number.isInteger(w.data?.tabId),
    'window.open() from a click: the click returns, and browser_tabs wait finds the popup by url and opener', short(S.windowOpen, 500));
  check(alive.ok && alive.value === 'true', 'window.open() from a click: the opener\'s script continued (window.open returned the popup)', short(alive));
  // Recovery: close whatever the click opened; does the opener answer again?
  for (const r of children) await A.call('browser_tabs', { action: 'close', tabId: r.tabId });
  if (children.length && !alive.ok) {
    const back = await waitFor(async () => { const a = await openerAlive(tab); return a.ok ? a : null; }, 30_000, 1_000);
    measure(`after closing the ${children.length} tab(s) the click opened: opener ${short(back ?? 'still not answering after 30 s')}`);
  }
  const closedOpener = await A.call('browser_tabs', { action: 'close', tabId: tab }, 60_000);
  measure(`closing the window.open opener tab: ${closedOpener.ok ? 'closed' : short(closedOpener.text, 160)}`);

  // -- a target=_blank link to a page
  tab = await freshTab('blank');
  s = await snap(A, tab);
  const nt = await A.call('browser_interact', { action: 'click', ref: s.ref('link', 'Open in a new tab'), tabId: tab }, 90_000);
  const w2 = await A.call('browser_tabs', { action: 'wait', url: 'newtab=1', openerTabId: tab, timeoutMs: 15_000 }, 30_000);
  check(nt.ok && nt.data?.delivery === 'delivered' && w2.ok && Number.isInteger(w2.data?.tabId) && w2.data.tabId !== tab,
    'a target=_blank link: the click is delivered; browser_tabs wait finds the new tab by url and opener', short({ click: nt.ok ? nt.data?.delivery : nt.text, wait: w2.ok ? w2.data : w2.text }));
  if (w2.ok) {
    const pop = w2.data.tabId;
    await must(A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: pop, timeoutMs: 20_000 });
    const popSeen = await pageEval(A, pop, '({ href: location.href, opener: !!window.opener, vis: document.visibilityState })');
    check(popSeen.href === `${S.testUrl}?newtab=1`, 'the new tab itself is on the linked page', short(popSeen));
    const net = await must(A, 'browser_network', { tabId: pop, limit: 100 });
    const urls = (net.requests ?? []).map((q) => q.url);
    const con = await must(A, 'browser_console', { action: 'read', tabId: pop, limit: 100 });
    const texts = (con.entries ?? []).map((e) => e.text);
    const diag = await must(A, 'browser_diagnose', { what: 'health', tabId: pop });
    check(urls.includes(`${S.testUrl}?newtab=1`) && urls.some((u) => /\/api\/missing$/.test(u)),
      'a page-opened tab: its first load\'s network is captured (its document and its /api/missing)', short({ urls, keys: Object.keys(net), note: net.note ?? net.hint ?? null }, 400));
    check(texts.some((t) => /\[TestPage\] booted/.test(t)) && texts.some((t) => /failed to initialise analytics/.test(t)),
      'a page-opened tab: its load-time console output is captured', short({ texts: texts.map((t) => t.slice(0, 60)), total: con.total, note: con.note ?? con.unavailable ?? null }, 400));
    measure(`page-opened tab, diagnose right after load: ${short(diag.summary)}`);
    const row = (await tabRows()).find((r) => r.tabId === pop);
    measure(`page-opened tab row: ${short(row && { owner: row.owner, openerTabId: row.openerTabId, windowId: row.windowId, sameContext: row.contextId === S.defaultContext, attachable: row.attachable })}`);
    const sp = await snap(A, pop);
    const mkp = await pageMark(A, pop);
    const cp = await A.call('browser_interact', { action: 'click', ref: sp.ref('button', 'Lab button'), tabId: pop }, 180_000);
    const seenP = await pageSince(A, pop, mkp);
    check(cp.ok && cp.data?.delivery === 'delivered' && seenP.log.some((e) => e.type === 'click' && e.target === 'e2Btn' && e.trusted),
      'a human click in the page-opened tab is delivered and seen', cp.ok ? `${cp.ms} ms` : cp.text);
    // The opener, now behind that tab in its window.
    const vis = await pageEval(A, tab, '({ vis: document.visibilityState, focus: document.hasFocus() })');
    s = await snap(A, tab);
    const mk = await pageMark(A, tab);
    const c2 = await A.call('browser_interact', { action: 'click', ref: s.ref('button', 'Lab button'), tabId: tab }, 240_000);
    const seen2 = await pageSince(A, tab, mk);
    const got = seen2.log.some((e) => e.type === 'click' && e.target === 'e2Btn' && e.trusted);
    S.openerClick = { ms: c2.ms, ok: c2.ok, delivery: c2.data?.delivery, got, vis, error: c2.ok ? null : short(c2.text, 300) };
    measure(`opener behind a page-opened tab: ${short(vis)}; a human click took ${c2.ms} ms (${c2.ok ? c2.data?.delivery : 'error'}), the page saw it: ${got}`);
    check((c2.ok && c2.data?.delivery === 'delivered' && got) || (!c2.ok && !got), 'opener click while a page-opened tab is in front: the report agrees with the page', short(S.openerClick));
    check(c2.ok && c2.ms < 15_000, 'opener click while a page-opened tab is in front: done in human time (< 15 s; round 2 measured ~1 s per mouse event for a tab behind another)', `${c2.ms} ms`);
    const cl = await A.call('browser_tabs', { action: 'close', tabId: pop });
    check(cl.ok, 'close the page-opened tab', short(cl.data ?? cl.text));
  }

  // -- a target=_blank link to a download
  try {
    const before = await tabRows();
    const wd = await must(A, 'browser_network', { action: 'watch_downloads', tabId: tab });
    s = await snap(A, tab);
    const expected = await servedBytes('e2-popup.bin');
    await must(A, 'browser_interact', { action: 'click', ref: s.ref('link', 'Download in a new tab'), humanize: 'off', tabId: tab });
    const d = await A.call('browser_network', { action: 'wait_download', contains: 'e2-popup', timeoutMs: 30_000, tabId: tab }, 60_000);
    await sleep(1_500);
    const after = await tabRows();
    const left = after.filter((r) => !before.some((b) => b.tabId === r.tabId));
    check(d.ok && d.data.file?.sha256 === sha256(expected) && d.data.tabId === tab && d.data.attribution === 'exact',
      'a target=_blank download: attributed exactly to the tab that clicked, the served bytes', short(d.ok ? { attribution: d.data.attribution, tabId: d.data.tabId, viaTabId: d.data.viaTabId, folder: wd.downloadPath } : d.text));
    check(!left.some((r) => /downloads-hub/.test(r.url ?? '')), 'no downloads-hub tab after a target=_blank download either', short(left.map((r) => r.url)));
    measure(`target=_blank download: viaTabId ${d.data?.viaTabId ?? '-'}; tabs left behind ${short(left.map((r) => r.url))}`);
    await A.call('browser_network', { action: 'stop_downloads', tabId: tab });
    for (const r of left) await A.call('browser_tabs', { action: 'close', tabId: r.tabId });
  } catch (err) {
    bad('a target=_blank download', err.message);
  }
  await A.call('browser_tabs', { action: 'close', tabId: tab }, 60_000);
  const rest = (await tabRows()).filter((r) => /(wopen|blank)=opener|popup=1|newtab=1/.test(r.url ?? '') || (r.url === '' && r.engine === S.engineId));
  check(rest.length === 0, 'the popup test leaves no tab behind', short(rest.map((r) => ({ tabId: r.tabId, url: r.url }))));
}

/**
 * The desktop's live view: a ui client watches a launched tab (admin watch)
 * and receives its screencast frames, the pointer and the watch status, while
 * an agent acts; the watch is spooled as an evidence run; unwatch stops it.
 */
async function sectionWatch() {
  const { A } = S;
  const ui = S.ui ?? await uiClient(S.port);
  S.ui = ui;
  const tab = S.tabMain;
  const n0 = ui.events.length;
  const w = await ui.admin('watch', { tabId: tab });
  check(w.ok && w.result?.watching === true && typeof w.result?.runId === 'string', 'admin watch on a launched tab (a ui client, as the desktop does)', short(w.result ?? w.error));
  const s = await snap(A, tab);
  await must(A, 'browser_interact', { action: 'hover', ref: s.ref('button', 'Hover target'), tabId: tab });
  await must(A, 'browser_interact', { action: 'click', ref: s.ref('button', 'Lab button'), tabId: tab });
  await sleep(600);
  const evs = ui.events.slice(n0);
  const frames = evs.filter((e) => e.topic === 'frame' && e.data?.tabId === tab);
  const pointer = evs.filter((e) => e.topic === 'pointer' && e.data?.tabId === tab);
  const status = evs.filter((e) => e.topic === 'watchStatus' && e.data?.tabId === tab).map((e) => e.data?.state ?? e.data?.status ?? short(e.data));
  const first = frames[0]?.data?.data ? jpegSize(Buffer.from(frames[0].data.data, 'base64')) : null;
  const view = await pageEval(A, tab, '({ w: innerWidth, h: innerHeight })');
  check(frames.length >= 3 && !!first && first.width > 0, 'the ui client receives JPEG frames of the tab while an agent acts', short({ frames: frames.length, first, viewport: view }));
  const inView = pointer.every((p) => p.data?.sample && p.data.sample.x >= 0 && p.data.sample.y >= 0 && p.data.sample.x <= view.w + 1 && p.data.sample.y <= view.h + 1);
  check(pointer.length >= 10 && inView, 'and the pointer samples of that input, inside the viewport', short({ samples: pointer.length, last: pointer.at(-1)?.data?.sample }));
  measure(`watch: ${frames.length} frames, ${pointer.length} pointer samples, watchStatus ${short(status)}`);
  const u = await ui.admin('unwatch', { tabId: tab });
  await sleep(800);
  const n1 = ui.events.length;
  await must(A, 'browser_interact', { action: 'hover', ref: s.ref('button', 'Lab button'), tabId: tab });
  await sleep(800);
  const late = ui.events.slice(n1).filter((e) => e.topic === 'frame' || e.topic === 'pointer').length;
  check(u.ok && u.result?.watching === false && late === 0, 'unwatch: frames and pointer samples stop', short({ result: u.result, eventsAfter: late }));
  const runDir = w.result?.runId ? path.join(S.home, 'runs', w.result.runId) : null;
  const spooled = runDir && fs.existsSync(path.join(runDir, 'frames')) ? fs.readdirSync(path.join(runDir, 'frames')).filter((f) => f.endsWith('.jpg')).length : 0;
  check(spooled >= 1, 'the watch was spooled as an evidence run (frames on disk)', `${spooled} frame file(s) in runs/${w.result?.runId}`);
}

async function sectionHalt() {
  const { A } = S;
  const ui = S.ui ?? await uiClient(S.port);
  S.ui = ui;
  const tab = S.tabMain;
  const s = await snap(A, tab);
  await pageEval(A, tab, '(() => { const f = document.getElementById("e2Text"); f.value = ""; f.removeAttribute("data-len"); })()');
  const long ='the quick brown fox jumps over the lazy dog again and again';
  const t0 = Date.now();
  let typingSettled = null;
  const typing = A.call('browser_interact', { action: 'type', ref: s.ref('textbox', 'Lab text'), text: long, typos: false, humanize: 'human', tabId: tab }, 120_000)
    .then((r) => { typingSettled = Date.now() - t0; return r; });
  // Halt once the page shows a few characters. Watched through a READ that is
  // not queued behind the typing and does not touch the tab's refs (a snapshot
  // would replace the refs the typing is using): inspect dom of the field,
  // whose data-len attribute the page keeps equal to the value's length.
  const polls = [];
  const startedTyping = await waitFor(async () => {
    if (typingSettled != null) return { settledAt: typingSettled };
    const pt = Date.now();
    const r = await A.call('browser_inspect', { what: 'dom', selector: '#e2Text', tabId: tab });
    const len = Number(/data-len="(\d+)"/.exec(r.data?.html ?? '')?.[1] ?? 0);
    polls.push({ at: pt - t0, ms: Date.now() - pt, len });
    return len >= 5 ? len : null;
  }, 30_000, 200);
  const pollNote = `${polls.length} polls (inspect ${Math.round(median(polls.map((p) => p.ms)) ?? 0)} ms median); ${typeof startedTyping === 'number' ? `${startedTyping} chars` : short(startedTyping)} at ${Date.now() - t0} ms after the call`;
  check(typeof startedTyping === 'number', 'the typing is visibly under way before Stop', pollNote);
  measure(`halt precondition: ${pollNote}`);
  const halt = await ui.admin('halt');
  check(halt.ok && halt.result?.halted === true, 'admin halt from a ui client', short(halt));
  const typed = await typing;
  check(!typed.ok && /Stop|halt/i.test(typed.text), 'the in-flight human typing stopped with the halt reason', short(typed.ok ? typed.data : typed.text, 200));
  const blockedCalls = await Promise.all([
    A.call('browser_snapshot', { tabId: tab }),
    A.call('browser_tabs', { action: 'list' }),
    A.call('browser_engine', { action: 'list' }),
    A.call('browser_interact', { action: 'click', ref: s.ref('button', 'Lab button'), tabId: tab }),
  ]);
  check(blockedCalls.every((r) => !r.ok && /Stop/i.test(r.text)), 'while halted every tool except status fails with the reason', short(blockedCalls.map((r) => r.text.slice(0, 50))));
  const st = await A.call('browser_status', {});
  check(st.ok && st.data?.halted?.global === true && /Stop/.test(st.data?.hint ?? ''), 'browser_status still answers, says halted', short(st.data?.halted));
  const bs = S.B ? await S.B.call('browser_snapshot', { tabId: tab }) : null;
  check(!bs || (!bs.ok && /Stop/i.test(bs.text)), 'the halt is global: agent B is blocked too');
  await sleep(1_200);
  const value = await (async () => {
    await ui.admin('resume');
    return pageEval(A, tab, 'document.getElementById("e2Text").value');
  })();
  const seenAtStop = typeof startedTyping === 'number' ? startedTyping : null;
  measure(`Stop pressed when the page showed ${seenAtStop} chars: the field then held ${value.length}/${long.length} ("${value}")`);
  check(seenAtStop != null && value.length >= seenAtStop && value.length < long.length && long.startsWith(value) && value.length - seenAtStop <= 3,
    'the page shows the typing stopped where Stop was pressed (at most a key or two in flight)', `${seenAtStop} → ${value.length}/${long.length}`);
  const resumed = await A.call('browser_snapshot', { tabId: tab });
  check(resumed.ok, 'admin resume: tools work again', resumed.ok ? '' : resumed.text);
  const events = ui.events.filter((e) => e.topic === 'halt').map((e) => e.data?.global?.halted);
  check(events.includes(true) && events.includes(false), 'the ui client received halt and resume events', short(events));
}

async function sectionHandoff() {
  const { A } = S;
  const url = `${S.testUrl}?handoff=1`;
  const payload = {
    url,
    title: 'G9 Agent Test Page (handoff)',
    origin: S.web,
    cookies: [
      { name: 'e2hand', value: 'from-ext', domain: '127.0.0.1', hostOnly: true, path: '/', secure: false, httpOnly: false, session: true, sameSite: 'lax' },
      { name: 'e2hand_http', value: 'secret-ext', domain: '127.0.0.1', hostOnly: true, path: '/', secure: false, httpOnly: true, session: false, expirationDate: Math.floor(Date.now() / 1000) + 3600, sameSite: 'strict' },
      { name: 'e2hand_old', value: 'expired', domain: '127.0.0.1', hostOnly: true, path: '/', secure: false, httpOnly: false, session: false, expirationDate: 1000, sameSite: 'lax' },
    ],
    localStorage: [['e2hand_ls', 'ls-from-ext']],
    sessionStorage: [['e2hand_ss', 'ss-from-ext']],
    viewport: { width: 1280, height: 720, dpr: 1 },
    userAgent: 'Mozilla/5.0 (fake extension user agent)',
  };
  const ext = await fakeExtension(S.port, { tab: { tabId: 4242, title: payload.title, url }, exportPayload: payload });
  check(!!ext.welcome?.id && /^engine-\d+$/.test(ext.welcome.id), 'a fake extension engine connects (Engine 1 stand-in)', ext.welcome?.id);
  try {
    const list = await must(A, 'browser_tabs', { action: 'list' });
    const extRow = list.tabs.find((t) => t.engineKind === 'extension' && t.url === url);
    check(!!extRow && Number.isInteger(extRow.tabId) && extRow.tabId !== 4242, 'its tab gets a daemon handle', short(extRow));
    if (!extRow) return;
    const h = await A.call('browser_tabs', { action: 'handoff', tabId: extRow.tabId }, 200_000);
    check(h.ok, 'browser_tabs handoff → EngineManager.handoffImport', h.ok ? '' : h.text);
    if (!h.ok) return;
    const r = h.data;
    S.tabHandoff = r.tabId;
    check(r.engineId === S.engineId && r.contextId && r.contextId !== S.defaultContext, 'the page landed in a FRESH context of the launched engine', short({ engineId: r.engineId, contextId: r.contextId }));
    check(r.transferred?.cookies === 2 && r.transferred?.localStorage === 1 && r.transferred?.sessionStorage === 1 && r.cookiesNotSet?.some((c) => c.name === 'e2hand_old' && /expired/.test(c.reason)),
      'result: 2 cookies (the expired one skipped, named), 1 local, 1 session', short({ transferred: r.transferred, notSet: r.cookiesNotSet }));
    check(r.storageCheck?.sameOrigin === true && r.storageCheck.localStorage === 1 && r.storageCheck.sessionStorage === 1, 'storageCheck read back after load', short(r.storageCheck));
    check(Array.isArray(r.notTransferred) && r.notTransferred.includes('IndexedDB') && /reloaded/.test(r.note ?? ''), 'result says what did not travel', short(r.note, 200));
    const seen = await pageEval(A, r.tabId, '({ href: location.href, cookie: document.cookie, ls: localStorage.getItem("e2hand_ls"), ss: sessionStorage.getItem("e2hand_ss") })');
    const echo = await pageEval(A, r.tabId, 'fetch("/e2/echo").then((x) => x.json())');
    check(seen.href === url && seen.cookie.includes('e2hand=from-ext') && !seen.cookie.includes('e2hand_http'), 'the page sees the script cookie (not the HttpOnly one)', short(seen));
    check(echo.cookie.includes('e2hand_http=secret-ext') && echo.cookie.includes('e2hand=from-ext') && !echo.cookie.includes('e2hand_old'), 'the server receives both cookies, not the expired one', echo.cookie);
    check(seen.ls === 'ls-from-ext' && seen.ss === 'ss-from-ext', 'the page sees the handed-off local and session storage', short({ ls: seen.ls, ss: seen.ss }));
    check(!/fake extension user agent/.test(echo.userAgent), 'the user agent is never overridden', short(echo.userAgent, 120));
    const st = await must(A, 'browser_status', {});
    check(st.you?.current === r.tabId && st.owned?.includes(r.tabId) && !st.owned?.includes(extRow.tabId), 'the new tab is mine and current; the source tab was released', short({ current: st.you?.current, owned: st.owned }));
    const mainCookie = await pageEval(A, S.tabMain, 'document.cookie');
    check(!mainCookie.includes('e2hand'), 'the handed-off session did not leak into the default context', mainCookie);
  } finally {
    ext.ws.close(1000, 'test done');
    await waitFor(async () => !(await health(S.port)).extension, 5_000);
  }
}

/**
 * Every own property of the page's MAIN-world window that neither a pristine
 * window (a same-origin about:blank iframe created now) nor the test page's
 * own script explains. Frame indices ("0", "1") are not names anyone added.
 * Also: every name, in the page or the pristine window, that looks like an
 * automation artefact (a G9 helper, a CDP binding, a driver marker).
 */
async function mainWorldExtras(tab) {
  const html = fs.readFileSync(path.join(HERE, 'testpage.html'), 'utf8');
  const pageOwn = [...new Set([...html.matchAll(/window\.(\w+)\s*=/g)].map((m) => m[1]))];
  return pageEval(S.A, tab, `(() => {
    const suspicious = (n) => /g9|__pw|puppeteer|playwright|cdc_|__webdriver|__driver|__selenium|__nightmare|domAutomation|callPhantom|_phantom/i.test(n);
    const f = document.createElement('iframe');
    f.style.display = 'none';
    document.documentElement.appendChild(f);
    const pristine = Object.getOwnPropertyNames(f.contentWindow);
    f.remove();
    const base = new Set(pristine);
    const own = ${JSON.stringify(pageOwn)};
    const names = Object.getOwnPropertyNames(window);
    return {
      total: names.length,
      pristine: pristine.length,
      extras: names.filter((n) => !base.has(n) && !own.includes(n) && !/^[0-9]+$/.test(n)),
      suspicious: names.filter((n) => suspicious(n) && !own.includes(n)),
      suspiciousInPristine: pristine.filter(suspicious),
    };
  })()`);
}

async function sectionCleanliness() {
  const tabs = [S.tabMain, S.tabStealth, S.tabReplay, S.tabHandoff].filter(Number.isInteger);
  for (const tab of tabs) {
    try {
      const leaks = await mainWorldLeaks(tab);
      const x = await mainWorldExtras(tab);
      const dom = await pageEval(S.A, tab, 'document.querySelectorAll("[id^=__g9], [class*=__g9], [id*=g9-], g9-cursor").length');
      check(leaks.length === 0 && x.extras.length === 0 && x.suspicious.length === 0 && x.suspiciousInPristine.length === 0 && dom === 0,
        `tab ${tab}: the page's main world has no name G9 added (vs a pristine window) and no G9 element, after all tools`,
        short({ leaks, extras: x.extras, suspicious: x.suspicious, inPristine: x.suspiciousInPristine, names: `${x.total} vs pristine ${x.pristine}` }));
    } catch (err) {
      bad(`tab ${tab}: cleanliness check`, err.message);
    }
  }
}

async function sectionStealthEngine() {
  const { A } = S;
  const r = await A.call('browser_engine', { action: 'launch', browser: 'edge', headless: true, profile: 'e2stealth', stealth: 'stealth' }, 240_000);
  check(r.ok && r.data?.stealth === 'stealth', 'launch a stealth engine (own profile)', r.ok ? `${r.data.engineId}` : r.text);
  if (!r.ok) return;
  const e = r.data;
  check((e.argv ?? []).some((a) => /--disable-blink-features=.*AutomationControlled/.test(a)), 'stealth argv carries AutomationControlled off (decision D-a)', short((e.argv ?? []).filter((a) => /blink|automation/i.test(a))));
  const opened = await must(A, 'browser_tabs', { action: 'open', url: S.testUrl, engine: e.engineId });
  await must(A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: opened.tabId, timeoutMs: 20_000 });
  const wd = await pageEval(A, opened.tabId, 'navigator.webdriver');
  const wdMain = await pageEval(A, S.tabMain, 'navigator.webdriver');
  check(wd === false, 'stealth engine: navigator.webdriver is false', `${wd}`);
  measure(`navigator.webdriver: stealth engine ${wd}, default (off) engine ${wdMain}; stealth engine warnings: ${short(e.warnings ?? [], 300)}`);
  const con = await must(A, 'browser_console', { action: 'read', tabId: opened.tabId });
  check(typeof con.unavailable === 'string', 'stealth engine: console read states capture unavailable', short(con.unavailable));
  const s = await snap(A, opened.tabId);
  const c = await A.call('browser_interact', { action: 'click', ref: s.ref('button', 'Lab button'), tabId: opened.tabId });
  check(c.ok && c.data?.delivery === 'delivered' && c.data?.humanize?.level === 'stealth', 'stealth engine: default input is stealth and delivered', short(c.data?.humanize ?? c.text));
  const stop = await A.call('browser_engine', { action: 'stop', engineId: e.engineId });
  const gone = await waitFor(() => !pidAlive(e.pid) && processesMatching(`${S.fragment}\\profiles\\e2stealth`).length === 0, 15_000, 500);
  check(stop.ok && !!gone, 'stealth engine stopped: no process left on its profile', short(stop.data ?? stop.text));
}

/**
 * Edge opens edge://downloads-hub by itself after a download. The product now
 * writes browser.show_hub_popup_on_download_start:false into every profile
 * before launch (engine/manager.js), so a product launch can no longer serve
 * as the control. This A/B therefore runs OUTSIDE the product, on raw
 * engine/launch.js launches (same switches, temp profiles in this run's
 * G9_HOME, headless): one profile without the preference, one with it written
 * before launch, the same download in each. Reported as measurements.
 */
async function sectionHubExperiment() {
  const { launchBrowser } = await import('../engine/launch.js');
  const variants = [
    { name: 'no preference (raw control)', dir: 'hub-control', prefs: null },
    { name: 'show_hub_popup_on_download_start:false', dir: 'hub-pref', prefs: { show_hub_popup_on_download_start: false } },
    { name: 'show_hub_popup_on_downloads_completed:false only', dir: 'hub-completed', prefs: { show_hub_popup_on_downloads_completed: false } },
  ];
  S.hubRows = [];
  for (const v of variants) {
    const dir = path.join(S.home, 'rawhub', v.dir);
    const dl = path.join(S.home, 'rawhub', `${v.dir}-downloads`);
    fs.mkdirSync(dl, { recursive: true });
    if (v.prefs) {
      fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ browser: v.prefs }));
    }
    let h = null;
    try {
      h = await launchBrowser({ browser: 'edge', headless: true, profileDir: dir, home: S.home });
      const conn = h.conn;
      let completed = false;
      conn.on('event', (method, params) => { if (method === 'Browser.downloadProgress' && params?.state === 'completed') completed = true; });
      await conn.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dl, eventsEnabled: true });
      const before = (await conn.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');
      const { sessionId } = await conn.send('Target.attachToTarget', { targetId: before[0].targetId, flatten: true });
      await conn.send('Page.navigate', { url: `${S.web}/download/e2-data.bin` }, sessionId).catch(() => null);
      await waitFor(() => completed, 15_000, 100);
      await sleep(2_500);
      const after = (await conn.send('Target.getTargets')).targetInfos;
      const hub = after.filter((t) => /downloads-hub|edge:\/\/downloads/.test(t.url ?? ''));
      const row = { variant: v.name, completed, pagesBefore: before.length, targetsAfter: after.map((t) => `${t.type}:${t.url}`), hub: hub.length };
      S.hubRows.push(row);
      const background = row.targetsAfter.filter((t) => /^(service_worker|background_page):chrome-extension:/.test(t));
      measure(`raw Edge ${h.browser?.version}, ${v.name}: download ${completed ? 'completed' : 'NOT completed'}; hub tabs ${hub.length}; ` +
        `page/other targets ${short(row.targetsAfter.filter((t) => !background.includes(t)), 400)}; ${background.length} built-in extension background target(s)`);
    } catch (err) {
      measure(`raw hub variant "${v.name}" stopped: ${err.message}`);
    } finally {
      if (h) await h.close().catch(() => null);
    }
  }
}

/**
 * A persona: a profile launched with a locale and timezone. Round 2: the
 * locale changed Intl only (navigator.languages and Accept-Language stayed
 * en-US, 6/6). The profile's languages are now written before launch and the
 * persona is saved with the profile. Also: a relaunch must not reopen the
 * previous run's tabs (Chrome for Testing did, every time), and a context
 * locale in another language is refused at stealth.
 */
async function personaProbe(tabId) {
  return pageEval(S.A, tabId, `(async () => {
    const worker = await new Promise((resolve) => {
      const src = 'postMessage({ languages: navigator.languages, language: navigator.language, locale: Intl.DateTimeFormat().resolvedOptions().locale, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })';
      let w;
      try { w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); } catch (e) { resolve({ error: String(e) }); return; }
      const timer = setTimeout(() => resolve(null), 5000);
      w.onmessage = (e) => { clearTimeout(timer); w.terminate(); resolve(e.data); };
    });
    const echo = await fetch('/e2/echo').then((x) => x.json());
    const ro = Intl.DateTimeFormat().resolvedOptions();
    return { languages: navigator.languages, language: navigator.language, locale: ro.locale, tz: ro.timeZone,
      januaryOffset: new Date('2026-01-15T12:00:00Z').getTimezoneOffset(), acceptLanguage: echo.acceptLanguage, worker };
  })()`);
}

async function sectionLocale() {
  const { A } = S;
  const first = await A.call('browser_engine', { action: 'launch', browser: 'edge', headless: true, profile: 'e2de', locale: 'de-DE', timezone: 'Europe/Berlin' }, 240_000);
  check(first.ok, 'launch a de-DE / Europe/Berlin persona on its own profile', first.ok ? short({ locale: first.data.locale, timezone: first.data.timezone, acceptLanguage: first.data.acceptLanguage, warnings: first.data.warnings }) : first.text);
  if (!first.ok) return;
  const good = (p) => JSON.stringify(p?.languages) === '["de-DE","de"]' && p.language === 'de-DE' && p.locale === 'de-DE' && p.tz === 'Europe/Berlin' &&
    p.januaryOffset === -60 && /^de-DE,de;q=0\.9/.test(p.acceptLanguage ?? '') &&
    JSON.stringify(p.worker?.languages) === '["de-DE","de"]' && p.worker?.locale === 'de-DE' && p.worker?.tz === 'Europe/Berlin';
  let engineId = first.data.engineId;
  const o1 = await must(A, 'browser_tabs', { action: 'open', url: `${S.testUrl}?persona=1`, engine: engineId });
  await must(A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: o1.tabId, timeoutMs: 20_000 });
  const p1 = await personaProbe(o1.tabId);
  check(good(p1), 'de-DE persona: navigator.languages, Intl, timezone, Accept-Language and a dedicated worker all agree', short(p1, 500));
  const boot1 = await pageEval(A, o1.tabId, 'window.e2boot');
  check(boot1?.tz === 'Europe/Berlin' && boot1?.locale === 'de-DE' && boot1?.language === 'de-DE', 'de-DE persona, a tab G9 opened: the document already saw it while loading', short(boot1));
  // A tab the PAGE opens (target=_blank) in that persona: same persona from its first script?
  try {
    const s1 = await snap(A, o1.tabId);
    await must(A, 'browser_interact', { action: 'click', ref: s1.ref('link', 'Open in a new tab'), tabId: o1.tabId });
    const w = await A.call('browser_tabs', { action: 'wait', url: 'newtab=1', openerTabId: o1.tabId, timeoutMs: 15_000 }, 30_000);
    if (!w.ok) throw new Error(`no new tab: ${short(w.text, 160)}`);
    await must(A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: w.data.tabId, timeoutMs: 20_000 });
    const bootPop = await pageEval(A, w.data.tabId, 'window.e2boot');
    const nowPop = await personaProbe(w.data.tabId);
    check(bootPop?.tz === 'Europe/Berlin' && bootPop?.locale === 'de-DE' && bootPop?.language === 'de-DE',
      'de-DE persona, a tab the page opened (target=_blank): its document saw the persona while loading', short({ atLoad: bootPop, now: { tz: nowPop.tz, locale: nowPop.locale, languages: nowPop.languages } }, 400));
    await A.call('browser_tabs', { action: 'close', tabId: w.data.tabId });
  } catch (err) {
    bad('de-DE persona, a tab the page opened', err.message);
  }
  // Leave a second page open, then stop: a relaunch must not bring either back.
  const o2 = await must(A, 'browser_tabs', { action: 'open', url: `${S.testUrl}?persona=left-open`, engine: engineId });
  await must(A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: o2.tabId, timeoutMs: 20_000 });
  const stop1 = await A.call('browser_engine', { action: 'stop', engineId });
  check(stop1.ok, 'stop the persona engine with two pages open', short(stop1.data ?? stop1.text));
  await waitFor(() => processesMatching(`${S.fragment}\\profiles\\e2de`).length === 0, 15_000, 500);

  const again = await A.call('browser_engine', { action: 'launch', browser: 'edge', headless: true, profile: 'e2de' }, 240_000);
  check(again.ok && again.data?.locale === 'de-DE' && again.data?.timezone === 'Europe/Berlin', 'relaunch without locale: the profile\'s saved persona is used', again.ok ? short({ locale: again.data.locale, timezone: again.data.timezone }) : again.text);
  if (!again.ok) return;
  engineId = again.data.engineId;
  await sleep(1_500);
  const rows = (await must(A, 'browser_tabs', { action: 'list' })).tabs.filter((t) => t.engine === engineId);
  check(!rows.some((t) => /persona=/.test(t.url ?? '')), 'relaunch: none of the previous run\'s pages came back', short({ tabs: rows.map((t) => t.url), closedAtLaunch: again.data.closedAtLaunch ?? [] }));
  measure(`persona relaunch: tabs ${short(rows.map((t) => t.url))}, closedAtLaunch ${short(again.data.closedAtLaunch ?? [])}`);
  const o3 = await must(A, 'browser_tabs', { action: 'open', url: `${S.testUrl}?persona=2`, engine: engineId });
  await must(A, 'browser_navigate', { action: 'wait', selector: '#e2lab', tabId: o3.tabId, timeoutMs: 20_000 });
  const p3 = await personaProbe(o3.tabId);
  check(good(p3), 'relaunched persona: the page still sees de-DE / Europe/Berlin everywhere', short(p3, 400));
  const stop2 = await A.call('browser_engine', { action: 'stop', engineId });
  check(stop2.ok, 'stop the relaunched persona engine', short(stop2.data ?? stop2.text));

  // Context locale on the main engine (an en profile).
  const hostLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  const warnCtx = await A.call('browser_engine', { action: 'context', engineId: S.engineId, locale: 'fr-FR' });
  check(warnCtx.ok && (warnCtx.data?.warnings ?? []).some((w) => /navigator\.languages/.test(w) && /launch a profile with this locale/.test(w)),
    'context locale fr-FR on an English profile (stealth off): created, with a warning that languages stay the profile\'s', short(warnCtx.ok ? warnCtx.data?.warnings : warnCtx.text, 300));
  const refused = await A.call('browser_engine', { action: 'context', engineId: S.engineId, locale: 'fr-FR', stealth: 'stealth' });
  check(!refused.ok && /Refused at stealth/.test(refused.text), 'the same context at stealth is refused (the page would see two languages)', short(refused.ok ? refused.data : refused.text, 200));
  const region = await A.call('browser_engine', { action: 'context', engineId: S.engineId, locale: 'en-GB', stealth: 'stealth' });
  measure(`host locale ${hostLocale}; context en-GB at stealth: ${region.ok ? `created, warnings ${short(region.data?.warnings ?? [])}` : `refused: ${short(region.text, 160)}`}`);
  check(region.ok, 'context en-GB (same language, other region) at stealth: allowed (a warning at most)', short(region.ok ? region.data?.warnings ?? [] : region.text, 200));
}

async function sectionEngineStop() {
  const { A } = S;
  const owners = (await must(A, 'browser_tabs', { action: 'list' })).tabs.filter((t) => t.engine === S.engineId && t.owner && t.owner !== S.agentA);
  const refused = await A.call('browser_engine', { action: 'stop', engineId: S.engineId });
  const othersExpected = owners.length > 0;
  if (othersExpected) {
    check(!refused.ok && /other agents own/.test(refused.text) && /e2-agent-B|e2-par-/.test(refused.text), 'stop is refused while other connected agents own tabs in it (named)', short(refused.text, 240));
  }
  const stop = refused.ok ? refused : await A.call('browser_engine', { action: 'stop', engineId: S.engineId, force: true });
  check(stop.ok && stop.data?.stopped === S.engineId, 'stop (force when others own tabs) closes the engine', short(stop.data ?? stop.text));
  const gone = await waitFor(() => !pidAlive(S.enginePid) && processesMatching(S.fragment).filter((p) => /msedge/i.test(p.Name)).length === 0, 20_000, 500);
  const left = processesMatching(S.fragment).filter((p) => /msedge/i.test(p.Name));
  check(!!gone, 'after stop no browser process of this run is left (Win32_Process)', left.length ? short(left) : `pid ${S.enginePid} gone`);
  const list = await must(A, 'browser_engine', { action: 'list' });
  const tabs = await must(A, 'browser_tabs', { action: 'list' });
  const h = await health(S.port);
  check(!list.engines.length && !tabs.tabs.some((t) => t.engineKind === 'launched') && h.launched === 0, 'no engine, no launched tab, /health launched 0', short({ engines: list.engines.length, launched: h.launched }));
  const st = await must(A, 'browser_status', {});
  check(st.you?.current == null && st.engine == null, 'my current tab went with it', short({ current: st.you?.current, engine: st.engine }));
  // Every profile this run used, read from its own files now that no browser holds it.
  const roots = [path.join(S.home, 'profiles'), path.join(S.home, 'rawhub')].filter((d) => fs.existsSync(d));
  const states = roots.flatMap((root) => fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !/-downloads$/.test(d.name)).map((d) => accountState(path.join(root, d.name))));
  const main = states.find((x) => x.dir === path.basename(S.profileDir ?? 'automation'));
  check(!!main?.localState && !!main?.prefs && states.every((x) => !x.signedIn),
    'no profile of this run is signed in to a browser account (Local State info_cache, Preferences account_info)', short(states.map((x) => ({ p: x.dir, localState: x.localState, prefs: x.prefs, signedIn: x.signedIn, fields: x.fields })), 600));
}

// ================================================================== main

async function cleanup() {
  console.log(`\n${color(1, '[cleanup]')}`);
  for (const agent of agents) agent.close();
  try {
    if (S.ui) {
      await S.ui.admin('shutdown').catch(() => null);
    } else if (S.port) {
      const ui = await uiClient(S.port).catch(() => null);
      await ui?.admin('shutdown').catch(() => null);
    }
  } catch { /* already gone */ }
  if (S.daemon) await waitFor(() => S.daemon.exitCode != null || S.daemon.signalCode != null, 20_000, 200);
  await sleep(500);
  for (const agent of agents) if (!agent.exited) agent.kill();
  for (const child of children) { try { child.kill(); } catch { /* gone */ } }
  // A daemon a shim spawned on its own (it should not have) names its pid in daemon.json.
  try {
    const dj = JSON.parse(fs.readFileSync(path.join(S.home, 'daemon.json'), 'utf8'));
    if (pidAlive(dj.pid) && dj.home && path.resolve(dj.home) === path.resolve(S.home)) killTree(dj.pid);
  } catch { /* none */ }
  let leftovers = S.fragment ? processesMatching(S.fragment) : [];
  if (leftovers.length) {
    for (const p of leftovers) killTree(p.ProcessId);
    await sleep(1_500);
  }
  leftovers = S.fragment ? processesMatching(S.fragment) : [];
  const daemonExited = S.daemon ? S.daemon.exitCode != null || S.daemon.signalCode != null : true;
  currentSection = 'cleanup';
  check(leftovers.length === 0, 'no process of this run is left (by temp-dir name, Win32_Process)', short(leftovers));
  check(daemonExited && !fs.existsSync(path.join(S.home ?? '.', 'daemon.json')), 'the daemon shut down (admin shutdown) and removed daemon.json', `exit ${S.daemon?.exitCode}`);
  if (!KEEP) {
    for (const dir of tempDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (err) { bad(`remove ${dir}`, err.message); }
    }
    check(tempDirs.every((d) => !fs.existsSync(d)), 'temp directories removed');
  } else {
    console.log(color(90, `kept: ${tempDirs.join(', ')}`));
  }
}

console.log(`\n${color(1, 'G9 v2 — Engine 2 live test (product path)')} ${color(90, `(v${VERSION}, node ${process.version})`)}`);
const startedAt = Date.now();
try {
  await run('setup', 'serve.mjs, daemon, shim', setup, { core: true });
  await run('launch', 'browser_engine launch (headless Edge) and a tab', sectionLaunch, { core: true });
  await run('status', 'browser_status composition', sectionStatus);
  await run('tabs', 'open / list / session / close', sectionTabs);
  await run('snapshot', 'snapshot and refs', sectionSnapshot);
  await run('diagnose', 'the six seeded defects', sectionDiagnose);
  await run('interact', 'every interaction at off, human and stealth, checked by the page', sectionInteract);
  await run('frames', 'cross-origin iframe input, covered element', sectionFrames);
  await run('console', 'console and network capture (and stealth)', async () => { await ensureStealthTab(); await sectionConsoleNetwork(); });
  await run('inspect', 'inspect dom/styles/box/storage/cookies/frames', sectionInspect);
  await run('screenshot', 'viewport / fullpage / element, with pointer', sectionScreenshots);
  await run('emulate', 'device, network, colour scheme', sectionEmulate);
  await run('dialogs', 'confirm, prompt, alert', sectionDialogs);
  await run('downloads', 'downloads end to end, file facts vs served bytes', sectionDownloads);
  await run('popup', 'a page-opened window (window.open, target=_blank)', sectionPopup);
  await run('har', 'record_har, pin, strict', sectionHar);
  await run('recording', 'record start/stop + replay; FlowSpec import + replay', sectionRecording);
  await run('video', 'issue + video with frames and pointer-track.json', sectionIssueVideo);
  await run('agents', 'two agents: ownership, reads, release on disconnect', sectionTwoAgents);
  await run('reads', 'another agent reading a tab while a human action runs on it', sectionConcurrentReads);
  await run('slots', 'maxParallel: the gate works, a wait holds no slot', sectionSlots);
  await run('parallel', '4 contexts, 4 agents, concurrent human input, own cookies', sectionParallel);
  await run('watch', 'live watch from a ui client (the desktop\'s view)', sectionWatch);
  await run('halt', 'halt from a ui client', sectionHalt);
  await run('handoff', 'handoff import (synthetic Engine 1 export)', sectionHandoff);
  await run('clean', 'isolated-world cleanliness', async () => { await ensureStealthTab(); await sectionCleanliness(); });
  await run('stealth', 'a stealth engine', sectionStealthEngine);
  await run('locale', 'a de-DE persona, relaunch without restored tabs, context locale rules', sectionLocale);
  await run('hub', 'Edge downloads-hub without / with the profile preference (raw launches, A/B)', sectionHubExperiment);
  await run('stop', 'engine stop leaves no browser process', sectionEngineStop, { core: true });
} catch (err) {
  bad('run aborted', err?.stack ?? err);
} finally {
  await cleanup().catch((err) => bad('cleanup', err?.stack ?? err));
}

const passed = results.filter((r) => r.status === 'PASS').length;
const failedN = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n${failedN ? color(31, 'FAIL') : color(32, 'PASS')}: ${passed} passed, ${failedN} failed, ${skipped} skipped in ${Math.round((Date.now() - startedAt) / 1000)} s`);
if (failedN) {
  console.log('\nFailures:');
  for (const r of results.filter((x) => x.status === 'FAIL')) console.log(`  [${r.section}] ${r.name} — ${r.detail.slice(0, 400)}`);
}
if (process.env.E2_REPORT) {
  fs.writeFileSync(process.env.E2_REPORT, JSON.stringify({ passed, failed: failedN, skipped, results, measurements, at: new Date().toISOString() }, null, 2));
}
process.exit(failedN ? 1 : 0);
