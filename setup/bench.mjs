#!/usr/bin/env node
/**
 * P8 parallelism benchmark — through the product path, nothing reached into directly.
 *
 *   node setup/bench.mjs [--levels 1,4,8,16] [--iterations 5] [--gated 16] [--browser edge]
 *                        [--max-parallel 64] [--seeds shared|distinct] [--out <file.json>] [--keep]
 *
 * For every level N: a PRIVATE daemon (fresh temp G9_HOME, random port 18000-18999), started the
 * way an AI client starts it — by the first MCP shim that finds none — and N more shims, one per
 * simulated agent. The first agent launches a headless browser (Engine 2, profile "automation");
 * every agent then creates its OWN browser context (`browser_engine action:"context"`, humanize
 * "human") and opens setup/testpage.html in it (served by setup/serve.mjs on another random port).
 * After a barrier all N agents run the same scripted flow at once, `--iterations` times:
 *
 *   goto → snapshot → type user → type password → click Sign in → wait "Signed in as admin."
 *        → select Staging → wheel-scroll 400 px → viewport screenshot
 *
 * Input is humanized (humanize:"human"), and every interaction result is checked for `delivery`
 * and `humanize.level`. Seeds are SHARED by default: in iteration k every agent at every level runs
 * the same plans (seed "bench-k<k>"), so a step's latency differs between levels only by load — with
 * a seed per agent, a longer planned path looked like contention. Latency is measured per step at
 * the MCP client (what an agent waits), p50/p95/max; `click_overhead` is the click's latency minus
 * the dispatch time the click itself reports (durationMs): resolution, witness and round trips.
 * CPU and RAM of the daemon process, of the browser's whole process tree and of the shims are
 * sampled every --sample-ms by a PowerShell Get-CimInstance Win32_Process loop (CPU from
 * Kernel+UserModeTime deltas, RAM as private bytes and working set, summed over the tree). The
 * machine's own load before/after (other suites share it) is recorded as `conditions*`.
 *
 * maxParallel recommendation (recommend()): the largest level before the first one where the flow
 * p95 exceeds 1.25x the single-context p95, or an interaction step's p95 is both > 1.5x and more
 * than 250 ms above its single-context p95, or anything failed, or daemon+browser CPU > 60% of the
 * machine. The strict ratio-only verdict is reported beside it.
 *
 * Network: every launched browser goes through the guard proxy (startGuard): only the test page's
 * port is reachable, nothing leaves the machine (a fresh Edge profile signs itself into the Windows
 * user's Microsoft account and turns sync on — measured; see startGuard). Each level records whether
 * its Engine 2 profile did (profiles[]: signedIn, account domain only, sync consent).
 *
 * Settings: maxParallel is raised to --max-parallel (default 64) so the daemon's gate does not
 * hide the real curve; --gated N adds one more run at N contexts with the shipped default (8) to
 * show what the gate itself costs.
 *
 * SAFETY, the rules this file exists under (other people's sessions share this machine):
 *   - never port 8765 — every port is random in 18000-18999 and assertSafePort() refuses anything
 *     else, BEFORE a shim (which would otherwise default to 8765) is spawned;
 *   - every G9_HOME, profile and extension copy lives under one mkdtemp root, so every browser we
 *     start carries that root in its command line and cleanup can match exactly our processes;
 *   - processes are killed only by pid we started or by that root in their command line.
 *
 * This module also exports the helpers setup/matrix.mjs and setup/endurance.mjs share.
 */

import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpClient } from '../runner/mcp-client.mjs';
import { WsClient } from '../lib/ws-client.mjs';
import { VERSION } from '../lib/version.mjs';

export const SETUP = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(SETUP, '..');
export const FORBIDDEN_PORT = 8765;
export const PORT_MIN = 18000;
export const PORT_MAX = 18999;
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// ─────────────────────────────────────────────────────────────── safety: ports and roots

/** Refuse any port outside 18000-18999, and 8765 whatever happens to the range. */
export function assertSafePort(port, what = 'port') {
  const n = Number(port);
  if (!Number.isInteger(n) || n === FORBIDDEN_PORT || n < PORT_MIN || n > PORT_MAX) {
    throw new Error(`Refusing ${what} ${JSON.stringify(port)}: harness ports must be random in ${PORT_MIN}-${PORT_MAX} and never ${FORBIDDEN_PORT}.`);
  }
  return n;
}

const takenPorts = new Set();
/** A random free port in 18000-18999 (bound once on 127.0.0.1 to prove it is free). */
export async function freePort() {
  for (let i = 0; i < 400; i += 1) {
    const p = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
    if (p === FORBIDDEN_PORT || takenPorts.has(p)) continue;
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) { takenPorts.add(p); return assertSafePort(p); }
  }
  throw new Error('No free port in 18000-18999.');
}

/** One mkdtemp root per run: everything we create lives under it. */
export async function makeRoot(tag) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `g9-p8-${tag}-`));
  return root;
}

export function log(...a) {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}]`, ...a);
}

// ─────────────────────────────────────────────────────────────── statistics

export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[idx];
}

export function summarize(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return { n: 0 };
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    n: v.length,
    p50: Math.round(percentile(v, 50)),
    p95: Math.round(percentile(v, 95)),
    max: Math.round(Math.max(...v)),
    mean: Math.round(sum / v.length),
  };
}

/** Least-squares slope of y over x (x in minutes → y units per minute). */
export function slope(points) {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den === 0 ? null : num / den;
}

export const MB = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

/** Machine-wide CPU counters; machineBusy(a, b) = share of all logical CPUs busy between two reads. */
export function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}
export function machineBusy(a, b) {
  const dt = b.total - a.total;
  return dt > 0 ? Math.round((1 - (b.idle - a.idle) / dt) * 1000) / 10 : null;
}

// ─────────────────────────────────────────────────────────────── the test page server

/** setup/serve.mjs on a private port. Returns { url, port, pid, stop }. */
export async function startServe(port) {
  assertSafePort(port, 'serve port');
  const child = spawn(process.execPath, [path.join(SETUP, 'serve.mjs')], {
    cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.resume();
  child.stderr.resume();
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) { await res.arrayBuffer(); break; }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error('setup/serve.mjs did not answer within 10 s'); }
    await delay(100);
  }
  return {
    url, port, pid: child.pid, child,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill();
      setTimeout(resolve, 2000).unref();
    }),
  };
}

// ─────────────────────────────────────────────────────────────── the network guard

/**
 * A forward proxy every browser a P8 harness starts must use (with <-loopback>, so loopback goes
 * through it too): the Engine 1 profiles the matrix launches itself, AND every Engine 2 browser the
 * product launches (browser_engine launch proxy/proxyBypass). It lets through only
 * 127.0.0.1/localhost on the ports this run owns and refuses everything else — the internet, and
 * above all 8765 — before any socket to it is opened.
 *
 * Why Engine 2 needs it too (measured 2026-09-22, Edge 153 on this workstation): a FRESH Edge
 * profile signs itself into the Windows user's Microsoft account within seconds of launch and turns
 * sync on (Local State info_cache user_name set, consented_to_sync, sync.has_setup_completed,
 * edge://sync-confirmation-dialog opened) — with no proxy, a test browser would sync with the
 * owner's account. Through the guard nothing leaves the machine. See guardedLaunch().
 */
export async function startGuard(allowedPorts) {
  const allowed = new Set([...allowedPorts].map((p) => assertSafePort(p, 'guarded port')));
  const hits = [];
  const isOk = (host, port) => (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') && allowed.has(port) && port !== 8765;
  const server = http.createServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
    const port = Number(u.port || 80);
    const ok = isOk(u.hostname, port);
    hits.push({ kind: 'http', host: u.hostname, port, ok, at: Date.now() });
    if (!ok) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('blocked by the P8 guard'); }
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: u.pathname + u.search, headers: req.headers }, (ur) => {
      ur.on('error', () => res.destroy());
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => { try { res.writeHead(502); res.end(); } catch { /* closed */ } });
    req.pipe(up);
  });
  // A browser closing mid-request resets its sockets; that must never take the harness down.
  server.on('clientError', (_err, sock) => { try { sock.destroy(); } catch { /* gone */ } });
  server.on('connect', (req, sock, head) => {
    sock.on('error', () => {});
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(String(req.url));
    const host = m?.[1] ?? '';
    const port = Number(m?.[2] ?? 0);
    const ok = isOk(host, port);
    hits.push({ kind: 'connect', host, port, ok, at: Date.now() });
    if (!ok) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = net.connect(port, '127.0.0.1', () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port,
    hits,
    allow: (p) => allowed.add(assertSafePort(p, 'guarded port')),
    attempts8765: () => hits.filter((h) => h.port === 8765).length,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** The browser_engine launch arguments that route an Engine 2 browser through the guard. */
export function guardedLaunch(guard) {
  return { proxy: `http://127.0.0.1:${assertSafePort(guard.port, 'guard port')}`, proxyBypass: '<-loopback>' };
}

/**
 * Did this browser profile sign itself into an account? Reads the profile's own Local State and
 * Preferences (only presence and the e-mail DOMAIN are kept — never the address). A profile dir
 * is a --user-data-dir: it holds "Local State" and Default/Preferences.
 */
export function profileSignIn(dir) {
  const out = { dir: path.basename(dir) };
  try {
    const ls = JSON.parse(fs.readFileSync(path.join(dir, 'Local State'), 'utf8'));
    const ic = Object.values(ls.profile?.info_cache ?? {})[0] ?? {};
    out.signedIn = !!ic.user_name;
    out.accountDomain = ic.user_name ? String(ic.user_name).split('@')[1] ?? '?' : null;
  } catch (err) { out.localState = err.code ?? String(err.message).slice(0, 60); }
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'));
    out.consentedToSync = p.google?.services?.consented_to_sync ?? null;
    out.syncSetupCompleted = p.sync?.has_setup_completed ?? null;
  } catch (err) { out.preferences = err.code ?? String(err.message).slice(0, 60); }
  return out;
}

/** profileSignIn for every user-data-dir under G9_HOME/profiles (the Engine 2 profiles). */
export function homeProfilesSignIn(home) {
  const dir = path.join(home, 'profiles');
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  return names.map((n) => profileSignIn(path.join(dir, n)));
}

// ─────────────────────────────────────────────────────────────── the daemon, as the product starts it

/**
 * A private daemon started by the first MCP shim (the product path). `settings` is written into
 * G9_HOME/settings.json before anything starts. Returns an object that makes more agents (shims),
 * a UI client, and stops everything it started.
 */
export async function startDaemon({ root, settings = {}, name = 'p8-agent-0', env = {} } = {}) {
  const port = await freePort();
  const home = path.join(root, `home-${port}`);
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, 'settings.json'), JSON.stringify({ port, ...settings }, null, 2));
  const baseEnv = { G9_PORT: String(assertSafePort(port, 'daemon port')), G9_HOME: home, ...env };
  const agents = [];
  const makeAgent = async (agentName) => {
    assertSafePort(baseEnv.G9_PORT, 'G9_PORT');
    const client = new McpClient({ env: baseEnv, name: agentName });
    agents.push(client);
    await client.initialize();
    return client;
  };
  const first = await makeAgent(name);
  // The shim connects lazily on some builds; one status call proves the daemon is up.
  await callTool(first, 'browser_status', {});
  const health = await getHealth(port);
  if (health?.name !== 'g9d' || health.port !== port) throw new Error(`Private daemon did not come up on ${port}: ${JSON.stringify(health)}`);
  const d = {
    port, home, pid: health.pid, first, agents, env: baseEnv,
    agent: makeAgent,
    health: () => getHealth(port),
    ui: () => UiClient.connect(port),
    async stop() {
      for (const a of agents) { try { a.close(); } catch { /* gone */ } }
      let ui = null;
      try {
        ui = await UiClient.connect(port);
        await ui.admin('shutdown', {}, 20_000).catch(() => {});
      } catch { /* already down */ }
      try { ui?.close(); } catch { /* gone */ }
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && pidAlive(d.pid)) await delay(200);
      if (pidAlive(d.pid)) killTreeSync(d.pid);
      return !pidAlive(d.pid);
    },
  };
  return d;
}

export async function getHealth(port) {
  assertSafePort(port, 'health port');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return await res.json();
  } catch {
    return null;
  }
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

export function killTreeSync(pid) {
  if (!pid) return false;
  const res = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 15_000 });
  return res.status === 0;
}

/**
 * Call a tool through a shim and return { ok, ms, json, text, images, error }. Never throws for a
 * tool failure: a refusal is data here (its text says not-delivered, halted, …).
 */
export async function callTool(client, name, args = {}, timeoutMs = 180_000) {
  const t0 = performance.now();
  let response;
  try {
    response = await client.request('tools/call', { name, arguments: args }, timeoutMs);
  } catch (err) {
    return { ok: false, ms: performance.now() - t0, error: String(err?.message ?? err), transport: true };
  }
  const ms = performance.now() - t0;
  if (response.error) return { ok: false, ms, error: response.error.message ?? 'protocol error' };
  const result = response.result ?? {};
  const content = result.content ?? [];
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const images = content.filter((c) => c.type === 'image');
  if (result.isError) return { ok: false, ms, error: text || 'tool error without a message', images };
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { text }; }
  return { ok: true, ms, json, text, images };
}

/** The daemon's UI role (admin ops, watch frames) over the same WebSocket the desktop app uses. */
export class UiClient extends EventEmitter {
  static async connect(port) {
    assertSafePort(port, 'ui port');
    const ws = await WsClient.connect(`ws://127.0.0.1:${port}/g9`, { timeoutMs: 5000 });
    const c = new UiClient(ws);
    const welcome = c.waitFor((m) => m.type === 'welcome', 5000);
    ws.send({ type: 'hello', role: 'ui', version: VERSION, client: { name: 'p8-harness', pid: process.pid } });
    c.welcome = await welcome;
    return c;
  }

  constructor(ws) {
    super();
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    ws.on('message', (m) => {
      if (m?.type === 'result' && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error ?? 'admin failed'));
        return;
      }
      if (m?.type === 'event') this.emit('event', m.topic, m.data);
      this.emit('message', m);
    });
    ws.on('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('ui socket closed')); }
      this.pending.clear();
      this.emit('close');
    });
  }

  waitFor(pred, timeoutMs) {
    return new Promise((resolve, reject) => {
      const on = (m) => { if (pred(m)) { clearTimeout(timer); this.off('message', on); resolve(m); } };
      const timer = setTimeout(() => { this.off('message', on); reject(new Error('ui: timed out waiting')); }, timeoutMs);
      this.on('message', on);
    });
  }

  #request(msg, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ui ${msg.op ?? msg.tool} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send({ ...msg, id });
    });
  }

  admin(op, args = {}, timeoutMs = 30_000) { return this.#request({ type: 'admin', op, args }, timeoutMs); }
  call(tool, args = {}, timeoutMs = 60_000) { return this.#request({ type: 'call', tool, args }, timeoutMs); }
  close() { try { this.ws.close(1000, 'p8 done'); } catch { /* gone */ } }
}

// ─────────────────────────────────────────────────────────────── process sampling (PowerShell CIM)

const SAMPLER_PS1 = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$rootsFile = $env:P8_ROOTS; $stopFile = $env:P8_STOP; $interval = [int]$env:P8_INTERVAL; $parent = [int]$env:P8_PARENT
$typeCache = @{}
while ($true) {
  if (Test-Path $stopFile) { break }
  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $roots = @()
  foreach ($line in (Get-Content $rootsFile)) { if ($line -match '^\d+$') { $roots += [int]$line } }
  $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime,CreationDate,HandleCount,ThreadCount
  $byId = @{}; $kids = @{}
  foreach ($p in $all) {
    $id = [int]$p.ProcessId; $byId[$id] = $p
    $pp = [int]$p.ParentProcessId
    if (-not $kids.ContainsKey($pp)) { $kids[$pp] = New-Object System.Collections.ArrayList }
    [void]$kids[$pp].Add($p)
  }
  $out = New-Object System.Collections.ArrayList
  $seen = @{}
  $missing = @{}
  foreach ($r in $roots) {
    if (-not $byId.ContainsKey($r)) { continue }
    $stack = New-Object System.Collections.Stack
    $stack.Push($byId[$r])
    while ($stack.Count -gt 0) {
      $p = $stack.Pop(); $id = [int]$p.ProcessId
      if ($seen.ContainsKey($id)) { continue }; $seen[$id] = $true
      # The Chromium process type (--type=renderer/gpu-process/utility, none = the browser) is read
      # once per process, for all new processes of a sample in ONE query below (one query per pid
      # stretched a 2 s interval to 30 s while sixteen contexts started).
      $key = "$id|$($p.CreationDate)"
      if (-not $typeCache.ContainsKey($key)) { $missing[$id] = $key }
      [void]$out.Add(@{ root = $r; pid = $id; ppid = [int]$p.ParentProcessId; name = [string]$p.Name; key = $key; ws = [int64]$p.WorkingSetSize; priv = [int64]$p.PrivatePageCount; cpu = ([int64]$p.KernelModeTime + [int64]$p.UserModeTime); h = [int]$p.HandleCount; th = [int]$p.ThreadCount })
      if ($kids.ContainsKey($id)) {
        foreach ($c in $kids[$id]) {
          # A child must be younger than its parent: Windows reuses pids, and a stale parent id
          # must not adopt an unrelated process into our tree.
          if ($c.CreationDate -ge $p.CreationDate) { $stack.Push($c) }
        }
      }
    }
  }
  if ($missing.Count -gt 0) {
    $filter = 'ProcessId=' + (($missing.Keys | ForEach-Object { [string]$_ }) -join ' OR ProcessId=')
    foreach ($q in @(Get-CimInstance Win32_Process -Filter $filter -Property ProcessId,Name,CommandLine,CreationDate)) {
      $k = "$([int]$q.ProcessId)|$($q.CreationDate)"
      $cl = [string]$q.CommandLine
      $ty = ''
      if ($cl -match '--type=([a-z-]+)') { $ty = $matches[1] } elseif ($q.Name -match '^(msedge|chrome)\.exe$') { $ty = 'browser' }
      if ($cl -match '--utility-sub-type=([\w.]+)') { $ty = "$ty/$($matches[1])" }
      $typeCache[$k] = $ty
    }
  }
  foreach ($o in $out) { $o.type = if ($typeCache.ContainsKey($o.key)) { $typeCache[$o.key] } else { '' }; $o.Remove('key') }
  $line = ConvertTo-Json -Compress -Depth 4 @{ t = $t; procs = $out }
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $interval
}
`;

/**
 * Sample the process trees under `roots` every `intervalMs` in one long-lived PowerShell process.
 * setRoots() may change the roots at any time. Returns { samples, setRoots, stop }.
 * Each sample: { t, procs:[{root,pid,ppid,name,ws,priv,cpu(100 ns),h,th}] }.
 */
export async function startSampler({ dir, roots = [], intervalMs = 2000 }) {
  await fsp.mkdir(dir, { recursive: true });
  const script = path.join(dir, 'p8-sampler.ps1');
  const rootsFile = path.join(dir, 'p8-roots.txt');
  const stopFile = path.join(dir, 'p8-stop.flag');
  await fsp.writeFile(script, SAMPLER_PS1);
  await fsp.writeFile(rootsFile, roots.join('\n'));
  await fsp.rm(stopFile, { force: true });
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    env: { ...process.env, P8_ROOTS: rootsFile, P8_STOP: stopFile, P8_INTERVAL: String(intervalMs), P8_PARENT: String(process.pid) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const samples = [];
  const listeners = new Set();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try {
        const s = JSON.parse(line);
        s.procs = Array.isArray(s.procs) ? s.procs : s.procs ? [s.procs] : [];
        samples.push(s);
        for (const fn of listeners) fn(s);
      } catch { /* partial line */ }
    }
  });
  child.stderr.resume();
  return {
    samples,
    pid: child.pid,
    onSample: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    setRoots: (r) => fsp.writeFile(rootsFile, r.join('\n')),
    /** Resolve with the next sample taken after now. */
    next: (timeoutMs = intervalMs * 4 + 5000) => new Promise((resolve) => {
      const t = Date.now();
      let timer = null;
      const fn = (s) => {
        if (s.t < t) return;
        listeners.delete(fn);
        clearTimeout(timer);
        resolve(s);
      };
      listeners.add(fn);
      timer = setTimeout(() => { listeners.delete(fn); resolve(null); }, timeoutMs);
    }),
    async stop() {
      await fsp.writeFile(stopFile, '1').catch(() => {});
      await Promise.race([new Promise((r) => child.once('exit', r)), delay(intervalMs + 5000)]);
      if (child.exitCode === null) { try { child.kill(); } catch { /* gone */ } }
    },
  };
}

/**
 * Split one sample into categories. `classify(proc)` → category name or null (not counted).
 * Returns { [cat]: { procs, ws, priv, cpu, handles } }.
 */
export function categorize(sample, classify) {
  const out = {};
  for (const p of sample?.procs ?? []) {
    const cat = classify(p);
    if (!cat) continue;
    const c = (out[cat] ??= { procs: 0, ws: 0, priv: 0, cpu: 0, handles: 0, pids: [] });
    c.procs += 1; c.ws += p.ws; c.priv += p.priv; c.cpu += p.cpu; c.handles += p.h ?? 0; c.pids.push(p.pid);
  }
  return out;
}

/**
 * CPU use per category between samples, in cores (1.0 = one logical CPU busy), from per-pid CPU
 * deltas: a pid present in both samples contributes its delta; a pid born in between contributes
 * all of its CPU time (it can only have spent it in the interval).
 */
export function cpuSeries(samples, classify) {
  const series = [];
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1];
    const b = samples[i];
    const dtMs = b.t - a.t;
    if (dtMs <= 0) continue;
    const prev = new Map((a.procs ?? []).map((p) => [p.pid, p]));
    const cores = {};
    for (const p of b.procs ?? []) {
      const cat = classify(p);
      if (!cat) continue;
      const before = prev.get(p.pid);
      const d = before && before.name === p.name ? Math.max(0, p.cpu - before.cpu) : p.cpu;
      cores[cat] = (cores[cat] ?? 0) + d / 10_000 / dtMs; // 100 ns → ms, per ms of wall
    }
    series.push({ t: b.t, dtMs, cores });
  }
  return series;
}

// ─────────────────────────────────────────────────────────────── cleanup

/** Every process whose command line contains `needle` (our temp root) → [{pid, name}]. */
export function processesMatching(needle) {
  const script = `$n = $env:P8_NEEDLE; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($n, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { "$($_.ProcessId)\`t$($_.Name)" }`;
  const res = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, P8_NEEDLE: needle }, encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  return String(res.stdout ?? '').split(/\r?\n/).filter(Boolean).map((l) => {
    const [pid, name] = l.split('\t');
    return { pid: Number(pid), name };
  }).filter((p) => p.pid && !/powershell/i.test(p.name));
}

/** Kill everything under our root (command-line match) and remove the root. Returns a report. */
export async function cleanupRoot(root, { pids = [] } = {}) {
  const report = { killedByPid: [], killedByRoot: [], leftovers: [], rootRemoved: false };
  for (const pid of pids) {
    if (pid && pidAlive(pid)) { killTreeSync(pid); report.killedByPid.push(pid); }
  }
  const needle = path.basename(root);
  for (let pass = 0; pass < 3; pass += 1) {
    const found = processesMatching(needle);
    if (!found.length) break;
    for (const p of found) {
      spawnSync('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
      report.killedByRoot.push(p);
    }
    await delay(1000);
  }
  report.leftovers = processesMatching(needle);
  for (let i = 0; i < 5; i += 1) {
    try {
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      break;
    } catch { await delay(1000); }
  }
  report.rootRemoved = !fs.existsSync(root);
  return report;
}

// ─────────────────────────────────────────────────────────────── the scripted flow

/** Refs for the flow's controls, read from a browser_snapshot tree. */
export function refsFrom(tree) {
  const find = (re) => {
    for (const line of String(tree ?? '').split('\n')) {
      if (re.test(line)) {
        const m = /\[ref=(e\d+)\]/.exec(line);
        if (m) return m[1];
      }
    }
    return null;
  };
  return {
    user: find(/textbox "Username"/),
    pass: find(/textbox "password"/),
    login: find(/button "Sign in"/),
    env: find(/combobox "Environment"/),
  };
}

/**
 * One pass of the flow on `tabId`. `record(step, res)` receives every call's result. Returns
 * { ok, failures:[…] } where a failure is a step that errored or whose effect did not show.
 *
 * `spa: true` is the single-page-app variant (setup/endurance.mjs): no navigation — the same
 * document takes every pass — and the fields are cleared before typing so their contents do not
 * grow. Anything G9BrowserAgent leaves behind in a document (a witness listener not released) then piles up
 * pass after pass instead of being thrown away with the document by the next goto.
 */
export async function runFlow(agent, { tabId, url, seed, record, humanize = 'human', spa = false, selectValue = 'stg', scrollDirection = 'down' }) {
  const failures = [];
  const step = async (name, tool, args, check = null) => {
    const res = await callTool(agent, tool, { tabId, ...args });
    let problem = res.ok ? null : res.error;
    if (!problem && check) problem = check(res);
    record(name, res, problem);
    if (problem) failures.push({ step: name, problem: String(problem).slice(0, 400) });
    return res;
  };
  const interactCheck = (res) => {
    const d = res.json?.delivery;
    if (d !== 'delivered') return `delivery ${JSON.stringify(d)}${res.json?.deliveryNote ? ` (${res.json.deliveryNote})` : ''}`;
    if (humanize !== 'off' && res.json?.humanize?.level !== humanize) return `humanize level ${JSON.stringify(res.json?.humanize)}`;
    return null;
  };
  if (!spa) await step('goto', 'browser_navigate', { action: 'goto', url, waitUntil: 'load' });
  const snap = await step('snapshot', 'browser_snapshot', {}, (res) => (refsFrom(res.json?.tree).login ? null : 'no Sign in ref in the snapshot'));
  const refs = refsFrom(snap.json?.tree);
  if (!refs.user || !refs.pass || !refs.login || !refs.env) return { ok: false, failures };
  await step('type_user', 'browser_interact', { action: 'type', ref: refs.user, text: 'admin', humanize, seed: `${seed}-u`, typos: false, ...(spa ? { clear: true } : {}) }, interactCheck);
  await step('type_pass', 'browser_interact', { action: 'type', ref: refs.pass, text: 'g9secret', humanize, seed: `${seed}-p`, ...(spa ? { clear: true } : {}) }, interactCheck);
  await step('click_login', 'browser_interact', { action: 'click', ref: refs.login, humanize, seed: `${seed}-c` }, interactCheck);
  await step('wait_signed_in', 'browser_navigate', { action: 'wait', text: 'Signed in as admin.', timeoutMs: 10_000 });
  await step('select_env', 'browser_interact', { action: 'select', ref: refs.env, values: selectValue, humanize, seed: `${seed}-s` }, interactCheck);
  await step('scroll', 'browser_interact', { action: 'scroll', direction: scrollDirection, amount: 400, humanize, seed: `${seed}-w` }, interactCheck);
  await step('screenshot', 'browser_screenshot', { area: 'viewport', format: 'jpeg', quality: 60 }, (res) => (res.images?.length && res.images[0].data?.length > 1000 ? null : 'no image'));
  return { ok: failures.length === 0, failures };
}

// ─────────────────────────────────────────────────────────────── bench main

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split('=', 2);
    const next = argv[i + 1];
    if (inline !== undefined) out[k] = inline;
    else if (next !== undefined && !next.startsWith('--')) { out[k] = next; i += 1; } else out[k] = true;
  }
  return out;
}

/**
 * daemon = the g9d process itself; browser = every Edge/Chrome process in its tree (browser,
 * renderers, GPU, utility, crashpad); shim = the MCP shims (one per simulated agent, as an AI
 * client runs them). A helper the daemon starts (PowerShell for a file check) is none of these.
 */
const classifyBench = (daemonPid, shimPids = new Set()) => (p) => {
  if (p.pid === daemonPid) return 'daemon';
  if (/^(msedge|chrome|identity_helper|msedge_crashpad_handler|chrome_crashpad_handler)\.exe$/i.test(p.name)) return 'browser';
  if (shimPids.has(p.pid)) return 'shim';
  return null;
};

/**
 * What else the machine was doing: the conditions every number here was taken under (other
 * suites share this workstation). Machine CPU busy over `ms`, and how many browser/node
 * processes exist that are not ours (not under `root`).
 */
export async function machineConditions(ms = 3000) {
  const a = cpuTimes();
  await delay(ms);
  const busy = machineBusy(a, cpuTimes());
  const script = String.raw`Get-CimInstance Win32_Process -Property Name | Group-Object Name | Where-Object { $_.Name -match '^(msedge|chrome|node)\.exe$' } | ForEach-Object { "$($_.Name)` + '\t' + String.raw`$($_.Count)" }`;
  const res = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const counts = Object.fromEntries(String(res.stdout ?? '').split(/\r?\n/).filter(Boolean).map((l) => { const [n, c] = l.split('\t'); return [n, Number(c)]; }));
  return { machineCpuBusyPct: busy, overMs: ms, processCounts: counts, freeMemGB: Math.round(os.freemem() / 1024 ** 3 * 10) / 10 };
}

async function benchLevel({ root, n, iterations, browser, maxParallel, serve, guard, sampleMs, seedMode = 'shared' }) {
  log(`── level ${n}: ${n} context(s) × ${iterations} iteration(s), maxParallel ${maxParallel}`);
  const daemon = await startDaemon({ root, settings: { maxParallel, humanize: 'human', stealth: 'off', headless: true, idleExitMinutes: 0 }, name: `p8-bench-${n}-a0` });
  const sampler = await startSampler({ dir: path.join(root, `sampler-${n}-${maxParallel}`), roots: [daemon.pid], intervalMs: sampleMs });
  const result = { contexts: n, iterations, maxParallel, daemonPid: daemon.pid, port: daemon.port };
  let cls = classifyBench(daemon.pid);
  try {
    const t0 = performance.now();
    const launch = await callTool(daemon.first, 'browser_engine', { action: 'launch', browser, headless: true, humanize: 'human', stealth: 'off', ...guardedLaunch(guard) });
    if (!launch.ok) throw new Error(`launch failed: ${launch.error}`);
    result.launchMs = Math.round(launch.ms);
    result.browser = { kind: launch.json.browser, version: launch.json.version, pid: launch.json.pid, headless: launch.json.headless };
    // What the launch itself said (round 3: a profile found signed in is warned about here at
    // human, refused at stealth — a fresh temp profile must produce no such warning).
    result.launchWarnings = launch.json.warnings ?? [];
    const engineId = launch.json.engineId;
    const agents = [daemon.first];
    for (let i = 1; i < n; i += 1) agents.push(await daemon.agent(`p8-bench-${n}-a${i}`));
    const shimPids = new Set(agents.map((a) => a.child?.pid).filter(Boolean));
    cls = classifyBench(daemon.pid, shimPids);
    await sampler.setRoots([daemon.pid, ...shimPids]);
    await sampler.next(); // the first sample that sees the new roots
    const idle = await sampler.next();
    const setupMs = [];
    const tabs = await Promise.all(agents.map(async (agent, i) => {
      const ctx = await callTool(agent, 'browser_engine', { action: 'context', engineId, humanize: 'human' });
      if (!ctx.ok) throw new Error(`context failed: ${ctx.error}`);
      const open = await callTool(agent, 'browser_tabs', { action: 'open', url: serve.url, engine: engineId, context: ctx.json.contextId });
      if (!open.ok) throw new Error(`open failed: ${open.error}`);
      setupMs.push(ctx.ms + open.ms);
      return { tabId: open.json.tabId, contextId: ctx.json.contextId, i };
    }));
    result.setupMsPerContext = summarize(setupMs);
    result.idle = categorize(idle, cls);
    const loadedIdle = await sampler.next();
    result.loadedIdle = categorize(loadedIdle, cls);

    const steps = {};
    const failures = [];
    const deliveries = {};
    const humanLevels = {};
    const record = (name, res, problem) => {
      (steps[name] ??= []).push(res.ms);
      // What the product adds on top of the hand's own motion: the click reports how long its
      // dispatch took (durationMs); the rest of the call is resolution, witness and round trips.
      if (name === 'click_login' && res.ok && Number.isFinite(res.json?.durationMs)) (steps.click_overhead ??= []).push(res.ms - res.json.durationMs);
      if (res.json?.delivery) deliveries[res.json.delivery] = (deliveries[res.json.delivery] ?? 0) + 1;
      if (res.json?.humanize?.level) humanLevels[res.json.humanize.level] = (humanLevels[res.json.humanize.level] ?? 0) + 1;
      if (problem) failures.push({ step: name, problem: String(problem).slice(0, 300) });
    };
    const loadStart = Date.now();
    const cpuStart = cpuTimes();
    const tStart = performance.now();
    const flowMs = [];
    await Promise.all(tabs.map(async ({ tabId, i }) => {
      for (let k = 0; k < iterations; k += 1) {
        const f0 = performance.now();
        // Shared seeds (default): every agent at every level runs the SAME humanized plans in
        // iteration k, so a step's latency differs between levels only by load, not by a seed that
        // happened to plan a longer path. --seeds distinct gives each agent its own.
        await runFlow(agents[i], { tabId, url: serve.url, seed: seedMode === 'distinct' ? `bench-${n}-${i}-${k}` : `bench-k${k}`, record });
        flowMs.push(performance.now() - f0);
      }
    }));
    const wallMs = performance.now() - tStart;
    const loadEnd = Date.now();
    // The whole machine, not only our processes: other work on it (other suites) is part of the
    // conditions these numbers were taken under, and says how far they can be trusted.
    result.machineCpuBusyPct = machineBusy(cpuStart, cpuTimes());
    await sampler.next(); // one sample after the load ends, so the last interval is covered
    const during = sampler.samples.filter((s) => s.t >= loadStart && s.t <= loadEnd + sampleMs);
    const cpu = cpuSeries(sampler.samples.filter((s) => s.t >= loadStart - sampleMs), cls).filter((c) => c.t >= loadStart && c.t <= loadEnd + sampleMs);
    const cats = during.map((s) => categorize(s, cls));
    const peak = (cat, key) => Math.max(0, ...cats.map((c) => c[cat]?.[key] ?? 0));
    const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    result.wallMs = Math.round(wallMs);
    result.flowMs = summarize(flowMs);
    result.flows = flowMs.length;
    result.throughputFlowsPerMin = Math.round((flowMs.length / (wallMs / 60_000)) * 10) / 10;
    result.steps = Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, summarize(v)]));
    const allInteract = ['type_user', 'type_pass', 'click_login', 'select_env', 'scroll'].flatMap((k) => steps[k] ?? []);
    result.interactMs = summarize(allInteract);
    result.deliveries = deliveries;
    result.humanizeLevels = humanLevels;
    result.failures = failures;
    result.failureCount = failures.length;
    result.cpuCores = {
      daemonMean: Math.round(mean(cpu.map((c) => c.cores.daemon ?? 0)) * 100) / 100,
      daemonPeak: Math.round(Math.max(0, ...cpu.map((c) => c.cores.daemon ?? 0)) * 100) / 100,
      browserMean: Math.round(mean(cpu.map((c) => c.cores.browser ?? 0)) * 100) / 100,
      browserPeak: Math.round(Math.max(0, ...cpu.map((c) => c.cores.browser ?? 0)) * 100) / 100,
      shimsMean: Math.round(mean(cpu.map((c) => c.cores.shim ?? 0)) * 100) / 100,
      intervals: cpu.length,
      logicalCpus: os.cpus().length,
    };
    result.memoryMB = {
      daemonPrivatePeak: MB(peak('daemon', 'priv')),
      daemonWsPeak: MB(peak('daemon', 'ws')),
      browserPrivatePeak: MB(peak('browser', 'priv')),
      browserWsPeak: MB(peak('browser', 'ws')),
      browserProcsPeak: peak('browser', 'procs'),
      shimsPrivatePeak: MB(peak('shim', 'priv')),
      shims: peak('shim', 'procs'),
      idleBrowserPrivate: MB(result.idle.browser?.priv ?? 0),
      loadedIdleBrowserPrivate: MB(result.loadedIdle.browser?.priv ?? 0),
      loadedIdleDaemonPrivate: MB(result.loadedIdle.daemon?.priv ?? 0),
    };
    result.samples = during.length;
    result.totalMs = Math.round(performance.now() - t0);
    log(`   level ${n}: wall ${result.wallMs} ms, flow p50 ${result.flowMs.p50} p95 ${result.flowMs.p95}, interact p50 ${result.interactMs.p50} p95 ${result.interactMs.p95}, ` +
      `daemon ${result.cpuCores.daemonMean}/${result.cpuCores.daemonPeak} cores, browser ${result.cpuCores.browserMean}/${result.cpuCores.browserPeak} cores, ` +
      `browser priv peak ${result.memoryMB.browserPrivatePeak} MB, daemon priv peak ${result.memoryMB.daemonPrivatePeak} MB, failures ${failures.length}`);
    for (const f of failures.slice(0, 5)) log(`   FAIL ${f.step}: ${f.problem}`);
    if (result.launchWarnings.length) log(`   launch warnings: ${JSON.stringify(result.launchWarnings).slice(0, 600)}`);
  } finally {
    await sampler.stop();
    const stopped = await daemon.stop();
    result.daemonStoppedCleanly = stopped;
    result.profiles = homeProfilesSignIn(daemon.home);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // A stray socket error must cost one measurement, never the cleanup of everything we started.
  process.on('uncaughtException', (err) => log(`uncaught (kept running): ${err?.stack ?? err}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection (kept running): ${err?.stack ?? err}`));
  const levels = String(args.levels ?? '1,4,8,16').split(',').map(Number).filter((n) => n > 0);
  const iterations = Number(args.iterations ?? 5);
  const seedMode = String(args.seeds ?? 'shared');
  const browser = String(args.browser ?? 'edge');
  const maxParallel = Number(args['max-parallel'] ?? 64);
  const gated = args.gated === undefined ? 16 : Number(args.gated) || 0;
  const sampleMs = Number(args['sample-ms'] ?? 2000);
  const root = await makeRoot('bench');
  log(`P8 bench — root ${root}, levels ${levels.join(',')}, iterations ${iterations}, browser ${browser}, G9BrowserAgent ${VERSION}, node ${process.version}`);
  const report = {
    date: new Date().toISOString(), g9: VERSION, node: process.version, os: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemGB: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10,
    iterations, seedMode, levels: [], gated: null,
  };
  let serve = null;
  let guard = null;
  let exitCode = 0;
  try {
    report.conditionsBefore = await machineConditions();
    log(`conditions before: ${JSON.stringify(report.conditionsBefore)}`);
    serve = await startServe(await freePort());
    guard = await startGuard([serve.port]);
    for (const n of levels) {
      report.levels.push(await benchLevel({ root, n, iterations, browser, maxParallel, serve, guard, sampleMs, seedMode }));
    }
    if (gated) {
      report.gated = await benchLevel({ root, n: gated, iterations, browser, maxParallel: 8, serve, guard, sampleMs, seedMode });
    }
    const all = [...report.levels, ...(report.gated ? [report.gated] : [])];
    if (all.some((l) => l.failureCount > 0)) exitCode = 1;
    report.recommendation = recommend(report.levels);
    report.conditionsAfter = await machineConditions();
    printTable(report);
  } catch (err) {
    exitCode = 2;
    report.error = String(err?.stack ?? err);
    console.error('BENCH ERROR', err);
  } finally {
    if (guard) {
      report.guard = { blocked: guard.hits.filter((h) => !h.ok).length, allowed: guard.hits.filter((h) => h.ok).length, attempts8765: guard.attempts8765(),
        blockedHosts: [...new Set(guard.hits.filter((h) => !h.ok).map((h) => `${h.host}:${h.port}`))].slice(0, 30) };
      await guard.close();
    }
    await serve?.stop();
    if (!args.keep) report.cleanup = await cleanupRoot(root, { pids: serve ? [serve.pid] : [] });
    const out = args.out ? path.resolve(String(args.out)) : null;
    if (out) await fsp.writeFile(out, JSON.stringify(report, null, 2));
    log(`cleanup: ${JSON.stringify(report.cleanup ?? 'kept')}`);
    if (out) log(`report written to ${out}`);
  }
  process.exit(exitCode);
}

/**
 * maxParallel from the data: the largest measured level at which
 *   - the whole flow's p95 stays within 1.25x of the single-context p95,
 *   - EVERY interaction step's p95 stays within 1.5x of its single-context p95 (judged per step:
 *     a pooled p95 is dominated by the 5 s password typing and hides a click that doubled),
 *   - nothing failed, and daemon + browser CPU stay under 60% of the machine.
 */
export const STEP_KEYS = ['type_user', 'type_pass', 'click_login', 'select_env', 'scroll'];
export function recommend(levels) {
  const strict = judge(levels, { stepRatio: 1.5, stepSlackMs: 0 });
  const tolerant = judge(levels, { stepRatio: 1.5, stepSlackMs: 250 });
  return {
    maxParallel: tolerant.maxParallel,
    rule: 'largest level before the first one over: flow p95 <= 1.25x the single-context run; no interaction step whose p95 is BOTH above 1.5x and more than 250 ms above its single-context p95 (a ratio alone on a 450 ms step trips on noise nobody would notice); no failures; daemon+browser CPU <= 60% of the machine',
    reasons: tolerant.reasons,
    strictRatioOnly: { maxParallel: strict.maxParallel, reasons: strict.reasons },
  };
}

function judge(levels, { stepRatio, stepSlackMs }) {
  const base = levels.find((l) => l.contexts === 1) ?? levels[0];
  if (!base?.flowMs?.p95) return { maxParallel: null, reasons: ['no single-context baseline'] };
  const cpus = base.cpuCores?.logicalCpus ?? os.cpus().length;
  let best = base.contexts;
  const reasons = [];
  for (const l of [...levels].sort((a, b) => a.contexts - b.contexts)) {
    const flowRatio = l.flowMs.p95 / base.flowMs.p95;
    const steps = STEP_KEYS.map((k) => {
      const now = l.steps?.[k]?.p95 ?? NaN;
      const was = base.steps?.[k]?.p95 ?? NaN;
      return { k, ratio: now / was, extraMs: now - was, over: now / was > stepRatio && now - was > stepSlackMs };
    });
    const worst = steps.reduce((w, cur) => (cur.ratio > w.ratio ? cur : w), { k: 'none', ratio: 0, extraMs: 0, over: false });
    const cpuShare = (l.cpuCores.browserMean + l.cpuCores.daemonMean) / cpus;
    const ok = l.failureCount === 0 && flowRatio <= 1.25 && !steps.some((x) => x.over) && cpuShare <= 0.6;
    reasons.push(`${l.contexts}: flow p95 x${flowRatio.toFixed(2)}, worst step ${worst.k} p95 x${worst.ratio.toFixed(2)} (+${Math.round(worst.extraMs)} ms), cpu ${(cpuShare * 100).toFixed(0)}% of ${cpus} CPUs, failures ${l.failureCount} -> ${ok ? 'ok' : 'over'}`);
    if (ok) best = Math.max(best, l.contexts);
    else break; // the first level over the line ends it: a larger one passing by noise is not capacity
  }
  return { maxParallel: best, reasons };
}

function printTable(report) {
  const rows = [...report.levels, ...(report.gated ? [{ ...report.gated, label: `${report.gated.contexts} (gate 8)` }] : [])];
  console.log('\nctx | machine cpu % | wall s | flow p50/p95 ms | interact p50/p95 ms | click p50/p95 | click overhead p50/p95 | type pass p50/p95 | scroll p50/p95 | shot p50/p95 | wait p50/p95 | goto p50/p95 | daemon cores mean/peak | browser cores mean/peak | browser priv MB peak | daemon priv MB peak | fail');
  for (const l of rows) {
    const s = l.steps ?? {};
    console.log([
      l.label ?? l.contexts, l.machineCpuBusyPct, (l.wallMs / 1000).toFixed(1), `${l.flowMs.p50}/${l.flowMs.p95}`, `${l.interactMs.p50}/${l.interactMs.p95}`,
      `${s.click_login?.p50}/${s.click_login?.p95}`, `${s.click_overhead?.p50}/${s.click_overhead?.p95}`, `${s.type_pass?.p50}/${s.type_pass?.p95}`, `${s.scroll?.p50}/${s.scroll?.p95}`, `${s.screenshot?.p50}/${s.screenshot?.p95}`, `${s.wait_signed_in?.p50}/${s.wait_signed_in?.p95}`, `${s.goto?.p50}/${s.goto?.p95}`,
      `${l.cpuCores.daemonMean}/${l.cpuCores.daemonPeak}`, `${l.cpuCores.browserMean}/${l.cpuCores.browserPeak}`,
      l.memoryMB.browserPrivatePeak, l.memoryMB.daemonPrivatePeak, l.failureCount,
    ].join(' | '));
  }
  console.log('\nrecommendation:', JSON.stringify(report.recommendation, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
