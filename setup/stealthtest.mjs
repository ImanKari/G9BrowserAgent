#!/usr/bin/env node
/**
 * Stealth self-test — the pre-suite gate (docs/STEALTH.md, "Running the self-test").
 *
 *   node setup/stealthtest.mjs                      one run: Edge (auto), headless, stealth
 *   node setup/stealthtest.mjs --headed             headed, window parked off-screen
 *   node setup/stealthtest.mjs --matrix             the whole matrix (see MATRIX below)
 *   node setup/stealthtest.mjs --local-only         only the local detector page (no network)
 *   node setup/stealthtest.mjs --only sannysoft,creepjs
 *
 * Options: --browser auto|edge|chrome|cft   --headed   --stealth stealth|human|off (not stealth = a
 * control that MUST be detected)   --locale de-DE --timezone Europe/Berlin   --matrix [--configs a,b]
 * --local-only | --public-only   --repeat N (local page N times per configuration, to measure flake
 * rates)   --no-warm   --profile NAME   --home DIR (use an existing G9 home and its profile as-is)
 * --out DIR   --seed S   --extra-arg <switch> (repeatable, for controlled experiments)   --verbose
 * --keep-home   --on-screen (headed without parking the window off-screen: never on a desk in use)
 * --no-control (skip the settled-scroll control actions)   --allow-sync (do not add --disable-sync
 * to Edge launches; see SAFETY_ARGS)   --no-children (no cross-site frame, no popup)   --no-popup
 * --no-sweep (skip the read-tool sweep)   --no-product-checks (skip the sign-in refusal and the
 * context-locale guard)   --no-interact (public pages: load, wait and read only — no scroll, hover
 * or click; for telling a verdict on behaviour from one on the environment)
 *
 * Measured facts this test is built on (Edge 153.0.4234.32, CfT 153.0.8010.52, 2026-09-22):
 * * The classic Runtime probe (console.debug of an Error with a `stack` getter) no longer fires; an
 *   own `name` getter on a logged Error is read twice with Runtime enabled, once without — the page
 *   uses that, and the human-level control proves it (Runtime is enabled there).
 * * pointerenter/mouseenter do not reach window capture listeners in Chromium; the page listens on
 *   its elements for them.
 * * A document loaded by Page.navigate while a CDP session is attached reads outerWidth/outerHeight/
 *   screenX/screenY = 0 until just after `load` (headless and headed); loaded with no session
 *   attached, it reads the real window.
 * * Edge signs a NEW profile in to the Windows account on its first start and turns sync on
 *   (account, passwords, extensions, history), unless it is launched with
 *   --disable-features=msImplicitSignin; the switch does not sign out a profile that is already
 *   signed in. Synced extensions then inject content scripts into every page (seen: main-world
 *   globals, a custom element, dispatchEvent calls). Hence the profile check after every
 *   configuration, and SAFETY_ARGS.
 * * CfT 153.0.8010.52 delivers mousemove to the page every ~100 ms (10 Hz), headless and headed,
 *   and each Input.dispatchMouseEvent takes ~40-50 ms; Chrome 153 and Edge 153 on the same machine
 *   deliver every ~11-14 ms. Hence --disable-frame-rate-limit for CfT (engine/launch.js
 *   KIND_SWITCHES), re-confirmed on 2026-09-23 in an interleaved A/B: without it CfT is at 100.5 ms
 *   in 8/8 launches, with it at 17.4 ms in 12/12. CfT also reopens the previous session's tabs on
 *   every launch of a reused profile, and one of them becomes the active tab.
 * * A page that calls preventDefault() on pointerdown gets pointerdown/pointerup/click but no
 *   mousedown/mouseup (Pointer Events spec); the local page has such an element on purpose.
 * * Pointer events carry `height`: the page's handler time is `hd`, not `h`.
 * * (round 3) A page's window.open() never completes in an engine whose browser session
 *   auto-attaches with waitForDebuggerOnStart:false: the popup stays at url "" and the opener's
 *   renderer stops (Edge 153 and Chrome 153, raw CDP too). See runPopupTest.
 * * (round 3) An out-of-process (cross-site) iframe keeps the HOST's time zone and locale when the
 *   Emulation overrides go to the page session only; sent to its own child session before it runs
 *   (waitForDebuggerOnStart + Runtime.runIfWaitingForDebugger), it follows them. TZ in the browser's
 *   environment changes nothing on Windows.
 *
 * What it does, through the PRODUCT path and nothing else: a private daemon (daemon/g9d.mjs on a
 * random 18000–18999 port, a throw-away G9_HOME) and a real MCP shim (mcp/shim.mjs over stdio),
 * exactly what an agent's client runs. Every browser action is a tool call an agent could make
 * (browser_engine launch, browser_tabs open, browser_interact, browser_screenshot …); the harness
 * never talks CDP itself, so what the detector pages see is what an agent's run would show them.
 *
 * Two kinds of detector:
 * 1. The LOCAL page, setup/fixtures/stealth-local.html, served by setup/serve.mjs. It was written
 *    against G9 itself: main-world globals and DOM calls G9 might leave, the Runtime-domain console
 *    side channel, trusted/ordered/curved input, locale/timezone/Accept-Language agreement, screen
 *    vs window, WebGL, permissions. Each of its checks names who could fix a failure (cls):
 *    g9 = a G9 leak or broken promise; headless/cdp/browser = inherent to headless Chromium, CDP
 *    input or the binary; host/harness = this machine, or how this test launched the browser.
 * 2. PUBLIC pages, listed in setup/stealth-pages.json (they drift: a broken extractor is a WARN,
 *    a detected verdict is a FAIL naming the page and field).
 *
 * And checks the harness makes itself (res.harnessChecks, same classes): the launch argv against
 * engine/launch.js's promises (launch-argv), no tab nobody opened at the end (tabs-at-end), the
 * local page's cross-site frame (oopif-*: Runtime probe, main world, webdriver, locale/timezone vs
 * the top page) and a popup the page opens itself (popup-*: headless only, in a tab of its own
 * site), a sweep of every read tool at stealth measuring what each one made the page see
 * (tool-sweep, with a main-world evaluate as the control that proves the detector sees), the
 * full-page screenshot refusal/disclosure, a stealth context in another language (refused), and a
 * profile signed in to a browser account (refused at stealth, before any browser starts).
 *
 * The run directory (--out, default %TEMP%\g9-stealthtest-<stamp>) keeps results.json, report.html
 * and every screenshot; it is the evidence and is NOT deleted. Everything else this test creates —
 * the G9_HOME with its profiles, the daemon, the shim, the browsers, the page server — is removed
 * at the end, and a process sweep by the temp home's path makes sure nothing is left running.
 *
 * Safety: never port 8765 (the owner's daemon/bridge lives there), never the owner's G9_HOME or
 * browser profiles (unless --home is passed explicitly), headed browsers only off-screen
 * (--window-position=-32000,-32000) so a window can never take the keyboard from a person.
 *
 * Profiles: stealth runs never start on a fresh profile (docs/STEALTH.md, "warm profile"). Unless --no-warm,
 * each browser kind's persona profile is warmed first in a separate launch (a few ordinary pages,
 * cookies and history written to disk), stopped, and then reused by every configuration.
 *
 * Exit code: 0 when every configuration that claims stealth came through undetected and every
 * control configuration WAS detected (proof that the checks can see a bot); 1 otherwise; 2 when the
 * harness itself could not run.
 */

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient } from '../runner/mcp-client.mjs';
import { VERSION } from '../lib/version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DAEMON = path.join(ROOT, 'daemon', 'g9d.mjs');
const SERVE = path.join(HERE, 'serve.mjs');
const OFFSCREEN = '--window-position=-32000,-32000';
const WARM_URLS = ['https://example.com/', 'https://www.wikipedia.org/', 'https://www.bing.com/'];

// ------------------------------------------------------------------ arguments

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    const next = argv[i + 1];
    if (v !== undefined) out[k] = v;
    else if (next !== undefined && !next.startsWith('--') && !['matrix', 'headed', 'headless', 'local-only', 'public-only', 'no-warm', 'keep-home', 'on-screen', 'no-control', 'allow-sync', 'no-children', 'no-popup', 'no-sweep', 'no-product-checks', 'no-interact', 'help'].includes(k)) { out[k] = next; i++; }
    else out[k] = true;
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
const EXTRA_ARGS = process.argv.slice(2).flatMap((a, i, all) => (a === '--extra-arg' && all[i + 1] ? [all[i + 1]] : (a.startsWith('--extra-arg=') ? [a.slice('--extra-arg='.length)] : [])));
/**
 * Switches the SELF-TEST adds for the safety of the machine it runs on, not to change what is
 * measured. Measured 2026-09-22 (Edge 153): a new Edge profile signs itself in to the Windows
 * account on its first start and syncs — the account's extensions, passwords and history come
 * into the test profile, and the detector pages this test visits go into the account's history.
 * `--disable-sync` keeps that data where it is (Sync Data stayed at ~0.5 KB) and has no effect a
 * page can see; the sign-in itself still happens, so the profile check below still catches it.
 * `--allow-sync` turns this off.
 */
const SAFETY_ARGS = (browser) => (ARGS['allow-sync'] || !['edge', 'auto'].includes(String(browser)) ? [] : ['--disable-sync']);
if (ARGS.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

/**
 * The matrix. `control` configurations are expected to be DETECTED (webdriver true at `human`, the
 * Runtime domain enabled): they prove the checks can see a bot, and fail the run if they cannot.
 */
const MATRIX = [
  { name: 'edge-headless-stealth', browser: 'edge', headless: true, stealth: 'stealth' },
  { name: 'edge-headless-human', browser: 'edge', headless: true, stealth: 'human', control: true },
  { name: 'edge-headed-stealth', browser: 'edge', headless: false, stealth: 'stealth' },
  { name: 'edge-headless-stealth-de', browser: 'edge', headless: true, stealth: 'stealth', locale: 'de-DE', timezone: 'Europe/Berlin', localOnly: true },
  { name: 'cft-headless-stealth', browser: 'cft', headless: true, stealth: 'stealth' },
  { name: 'cft-headed-stealth', browser: 'cft', headless: false, stealth: 'stealth' },
  { name: 'cft-headless-human', browser: 'cft', headless: true, stealth: 'human', control: true },
];

function configsFromArgs() {
  if (ARGS.matrix) {
    const only = ARGS.configs ? String(ARGS.configs).split(',') : null;
    return MATRIX.filter((c) => !only || only.includes(c.name));
  }
  const stealth = String(ARGS.stealth ?? 'stealth');
  const headless = !ARGS.headed;
  const browser = String(ARGS.browser ?? 'auto');
  return [{
    name: `${browser}-${headless ? 'headless' : 'headed'}-${stealth}`,
    browser, headless, stealth,
    control: stealth !== 'stealth',
    locale: ARGS.locale ? String(ARGS.locale) : undefined,
    timezone: ARGS.timezone ? String(ARGS.timezone) : undefined,
  }];
}

// ------------------------------------------------------------------ output helpers

const tty = process.stdout.isTTY;
const color = (code, text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const tag = { PASS: color(32, 'PASS'), FAIL: color(31, 'FAIL'), WARN: color(33, 'WARN'), INFO: color(90, 'INFO'), DETECTED: color(31, 'DETECTED') };
const say = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ------------------------------------------------------------------ resources (all cleaned up)

const children = new Set();
const tempDirs = [];
let sweepMarker = null;

function track(child) {
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

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
    if (free) { usedPorts.add(port); return port; }
  }
  throw new Error('no free port in 18000-18999');
}

async function waitFor(predicate, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return true; } catch { /* not yet */ }
    await sleep(stepMs);
  }
  return false;
}

/** Processes whose command line carries `marker` (our temp home): the daemon and every browser it started. */
function processesWith(marker) {
  if (process.platform !== 'win32' || !marker) return [];
  const needle = marker.replace(/'/g, "''");
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne $PID } | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return String(r.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => { const [pid, name] = l.split('|'); return { pid: Number(pid), name }; });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

let cleaned = false;
async function cleanup() {
  if (cleaned) return { leftovers: [] };
  cleaned = true;
  for (const child of [...children]) { try { child.kill(); } catch { /* gone */ } }
  await sleep(500);
  let leftovers = processesWith(sweepMarker);
  for (const p of leftovers) killTree(p.pid);
  if (leftovers.length) await sleep(1500);
  const after = processesWith(sweepMarker);
  if (!ARGS['keep-home']) {
    for (const dir of tempDirs) {
      for (let i = 0; i < 10; i++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(500); }
      }
    }
  }
  return { swept: leftovers, leftovers: after, removed: tempDirs.filter((d) => !fs.existsSync(d)), notRemoved: tempDirs.filter((d) => fs.existsSync(d)) };
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

// ------------------------------------------------------------------ servers

async function startPageServer() {
  const port = await freePort();
  const child = track(spawn(process.execPath, [SERVE], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  child.stdout.resume();
  child.stderr.resume();
  const ok = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/fixtures/stealth-local.html`, { signal: AbortSignal.timeout(1000) })).ok, 10_000, 150);
  if (!ok) throw new Error('setup/serve.mjs did not start');
  return { port, child };
}

/** Echoes the request headers back (CORS open), so the page can compare Accept-Language / Client Hints with navigator. */
async function startEchoServer() {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port, server };
}

async function startDaemon(home, port) {
  if (port === 8765) throw new Error('refusing port 8765');
  const log = fs.openSync(path.join(home, 'daemon-stdio.log'), 'a');
  const child = track(spawn(process.execPath, [DAEMON, '--port', String(port), '--home', home], {
    env: { ...process.env, G9_PORT: String(port), G9_HOME: home, ELECTRON_RUN_AS_NODE: '' },
    stdio: ['ignore', log, log],
    windowsHide: true,
  }));
  const ok = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).json()).name === 'g9d', 15_000, 150);
  if (!ok) throw new Error(`the daemon did not answer /health on ${port}; see ${path.join(home, 'logs', 'daemon.log')}`);
  return child;
}

// ------------------------------------------------------------------ MCP

class G9 {
  constructor(port, home) {
    this.client = new McpClient({ env: { G9_PORT: String(port), G9_HOME: home, ELECTRON_RUN_AS_NODE: '' }, name: 'g9-stealthtest' });
    track(this.client.child);
    this.calls = [];
  }
  async init() { return this.client.initialize(); }
  /** A tool call → { ok, result, text, images, error, ms }. Never throws: every outcome is evidence. */
  async tool(name, args = {}, timeoutMs = 120_000) {
    // t0/t1 are wall-clock epoch ms: the local page reports its events on the same clock
    // (performance.timeOrigin + timeStamp), so "did the tool return before the page stopped
    // moving" is a subtraction.
    const t0 = Date.now();
    try {
      const msg = await this.client.request('tools/call', { name, arguments: args }, timeoutMs);
      const t1 = Date.now();
      const ms = t1 - t0;
      if (msg.error) return this.#log(name, args, { ok: false, error: msg.error.message ?? 'protocol error', ms, t0, t1 });
      const content = msg.result?.content ?? [];
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const images = content.filter((c) => c.type === 'image');
      if (msg.result?.isError) return this.#log(name, args, { ok: false, error: text, ms, t0, t1 });
      let result;
      try { result = text ? JSON.parse(text) : {}; } catch { result = { text }; }
      return this.#log(name, args, { ok: true, result, images, ms, t0, t1 });
    } catch (err) {
      const t1 = Date.now();
      return this.#log(name, args, { ok: false, error: String(err?.message ?? err), ms: t1 - t0, t0, t1 });
    }
  }
  #log(name, args, out) {
    const brief = { ...args };
    for (const k of Object.keys(brief)) if (typeof brief[k] === 'string' && brief[k].length > 160) brief[k] = `${brief[k].slice(0, 157)}…`;
    this.calls.push({ at: new Date(out.t0).toISOString(), t0: out.t0, t1: out.t1, tool: name, args: brief, ok: out.ok, ms: out.ms, ...(out.ok ? {} : { error: String(out.error).slice(0, 600) }) });
    return out;
  }
  close() { this.client.close(); }
}

// ------------------------------------------------------------------ snapshot parsing

/** Lines of a snapshot tree → [{ role, name, ref }]. */
function refsOf(tree) {
  const out = [];
  for (const line of String(tree ?? '').split('\n')) {
    const m = /^\s*-\s+(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?\s+\[ref=(e\d+)\]/.exec(line);
    if (m) out.push({ role: m[1], name: m[2] ?? '', ref: m[3] });
  }
  return out;
}
const findRef = (refs, role, name) => refs.find((r) => r.role === role && (name == null || r.name === name))?.ref ?? null;

function decodeEntities(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// ------------------------------------------------------------------ the local detector page

async function readLocalResult(g9, tabId, minSeq = 0) {
  for (let i = 0; i < 20; i++) {
    const r = await g9.tool('browser_inspect', { what: 'dom', selector: '#sl-result', tabId });
    if (r.ok) {
      const html = String(r.result?.html ?? '');
      const m = /data-json="([^"]+)"/.exec(html);
      const seq = Number(/data-seq="(\d+)"/.exec(html)?.[1] ?? 0);
      if (m && seq > minSeq) {
        try { return JSON.parse(Buffer.from(decodeEntities(m[1]), 'base64').toString('utf8')); } catch (err) { return { error: `decode: ${err.message}` }; }
      }
    }
    await sleep(400);
  }
  return null;
}

/** The page's compact event digest (see stealth-local.html #sl-digest): rows on the epoch clock. */
async function readDigest(g9, tabId) {
  const r = await g9.tool('browser_inspect', { what: 'dom', selector: '#sl-digest', tabId });
  if (!r.ok) return null;
  const m = /data-json="([^"]+)"/.exec(String(r.result?.html ?? ''));
  if (!m) return null;
  try {
    const d = JSON.parse(Buffer.from(decodeEntities(m[1]), 'base64').toString('utf8'));
    const base = Number(d.timeOrigin) || 0;
    return { ...d, events: (d.rows ?? []).map(([ty, t, h, id, cx, cy, scy, k]) => ({ ty, t, h, id, cx, cy, scy, k, at: base + t, hAt: h != null ? base + h : null })) };
  } catch { return null; }
}

/**
 * Did each scroll call return only once the page had stopped moving? A humanized wheel scroll
 * animates after its last notch is dispatched; an action that measures its target before the page
 * settles aims at where the target WAS (the hover/click misses this test found).
 */
function scrollSettleFacts(actions, digest) {
  if (!digest?.events?.length) return null;
  const order = Object.entries(actions).filter(([, a]) => a?.t0).sort((a, b) => a[1].t0 - b[1].t0);
  const out = {};
  for (let i = 0; i < order.length; i++) {
    const [key, a] = order[i];
    if (!/^scroll/.test(key) || !a.ok) continue;
    const nextStart = order[i + 1]?.[1]?.t0 ?? a.t1 + 3000;
    // A scroll that lands after the call returned belongs to this call until the next SCROLL call
    // starts (or 2.5 s have passed): the action straight after it does not scroll by itself.
    const nextScroll = order.slice(i + 1).find(([k]) => /^scroll/.test(k))?.[1]?.t0 ?? Infinity;
    const windowEnd = Math.min(nextScroll, a.t1 + 2500);
    const scrolls = digest.events.filter((e) => e.ty === 'scroll' && e.at >= a.t0 && e.at <= windowEnd);
    const last = scrolls[scrolls.length - 1];
    const afterReturn = scrolls.filter((e) => e.at > a.t1);
    const beforeNext = digest.events.filter((e) => e.ty === 'scroll' && e.at <= nextStart);
    out[key] = {
      toolReturnedAt: a.t1,
      lastScrollAt: last ? Math.round(last.at) : null,
      lagMs: last ? Math.round(last.at - a.t1) : null,
      scrollEventsAfterReturn: afterReturn.length,
      reportedY: a.position?.y ?? null,
      pageYWhenNextActionStarted: beforeNext.length ? beforeNext[beforeNext.length - 1].scy : null,
      finalY: last?.scy ?? null,
      notches: a.notches ?? null,
    };
  }
  return out;
}

async function saveScreenshot(g9, tabId, file, area = 'viewport') {
  const r = await g9.tool('browser_screenshot', { area, format: 'jpeg', quality: 70, tabId }, 90_000);
  if (!r.ok || !r.images?.length) return { ok: false, error: r.error ?? 'no image in the result' };
  const buf = Buffer.from(r.images[0].data, 'base64');
  fs.writeFileSync(file, buf);
  return { ok: true, file, bytes: buf.length, meta: { width: r.result?.width, height: r.result?.height, scale: r.result?.scale }, pageSaw: r.result?.pageSaw ?? null };
}

function actionFacts(r) {
  if (!r.ok) return { ok: false, error: String(r.error).slice(0, 400), ms: r.ms };
  const x = r.result ?? {};
  return {
    ok: true, ms: r.ms, t0: r.t0, t1: r.t1, delivery: x.delivery, deliveryNote: x.deliveryNote, humanize: x.humanize?.level ?? x.humanize,
    raisedFrom: x.humanize?.raisedFrom, durationMs: x.durationMs, scrolled: x.scrolled?.via ?? x.via, pointer: x.pointer,
    ...(x.position ? { position: x.position } : {}), ...(x.notches != null ? { notches: x.notches } : {}), ...(x.at ? { at: x.at } : {}),
  };
}

/**
 * The local page's URL. Children (unless --no-children): `xframe` embeds the same page from
 * `localhost` — another SITE than 127.0.0.1, so Chromium puts it in its own process and G9 meets it
 * as a child session of the tab — and `popup` is what the page's "Open popup" button opens.
 */
function localUrl(cfg, ctx, extra = {}, { host = '127.0.0.1', frame = !ARGS['no-children'], popup = false } = {}) {
  const q = new URLSearchParams({ echo: `http://127.0.0.1:${ctx.echoPort}/h` });
  if (cfg.locale || cfg.timezone) q.set('expect', JSON.stringify({ locale: cfg.locale ?? null, timezone: cfg.timezone ?? null }));
  if (frame) q.set('xframe', `http://localhost:${ctx.pagePort}/fixtures/stealth-local.html?role=frame&probe=100`);
  if (popup) q.set('popup', `http://localhost:${ctx.pagePort}/fixtures/stealth-local.html?role=popup&probe=100&life=3000`);
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  return `http://${host}:${ctx.pagePort}/fixtures/stealth-local.html?${q}`;
}

/** The rows of browser_tabs list that belong to one engine. */
async function engineTabs(g9, engineId) {
  const tabs = await g9.tool('browser_tabs', { action: 'list' }, 30_000);
  if (!tabs.ok) return { error: String(tabs.error).slice(0, 200) };
  const rows = tabs.result?.tabs ?? tabs.result?.rows ?? [];
  return rows.filter((t) => !t.engine || t.engine === engineId || t.engineId === engineId)
    .map((t) => ({ tabId: t.tabId ?? t.id, url: String(t.url ?? '').slice(0, 140), active: t.active ?? null, owner: t.owner ?? t.ownedBy ?? null, ...(t.attachable === false ? { attachable: false } : {}), ...(t.openerTabId != null ? { openerTabId: t.openerTabId } : {}) }));
}

async function runLocal(g9, cfg, engineId, ctx, runDir, iteration) {
  const url = localUrl(cfg, ctx);
  const out = { url, iteration, actions: {}, problems: [] };
  let tabId = ctx.tabId;
  if (tabId == null) {
    const open = await g9.tool('browser_tabs', { action: 'open', url, engine: engineId }, 60_000);
    if (!open.ok) { out.problems.push(`open: ${open.error}`); return out; }
    tabId = open.result.tabId;
    ctx.tabId = tabId;
  } else {
    const nav = await g9.tool('browser_navigate', { action: 'goto', url, tabId }, 60_000);
    out.actions.goto = actionFacts(nav);
    if (!nav.ok) { out.problems.push(`goto: ${nav.error}`); return out; }
  }
  out.tabId = tabId;
  const ready = await g9.tool('browser_navigate', { action: 'wait', selector: '#sl-result[data-ready="1"]', timeoutMs: 20_000, tabId }, 40_000);
  if (!ready.ok) out.problems.push(`ready: ${ready.error}`);
  const before = await readLocalResult(g9, tabId);
  out.beforeInput = before ? { seq: before.seq, fails: (before.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.id) } : null;

  const snap = await g9.tool('browser_snapshot', { tabId });
  const refs = snap.ok ? refsOf(snap.result.tree) : [];
  const ref = {
    hover: findRef(refs, 'button', 'Hover target'),
    btn: findRef(refs, 'button', 'Click me'),
    btn2: findRef(refs, 'button', 'Lower button'),
    text: findRef(refs, 'textbox', 'Name'),
    sel: findRef(refs, 'combobox', 'Choice'),
    pd: findRef(refs, 'button', 'Press area'),
    pop: findRef(refs, 'button', 'Open popup'),
  };
  out.refs = ref;
  const seed = ARGS.seed ?? undefined;
  const act = async (key, args) => {
    const r = await g9.tool('browser_interact', { ...args, tabId, ...(seed != null ? { seed: `${seed}-${key}` } : {}) }, 90_000);
    out.actions[key] = actionFacts(r);
    if (!r.ok) out.problems.push(`${key}: ${r.error}`);
    return r;
  };
  const btn2Clicks = async () => { await sleep(300); const r = await readLocalResult(g9, tabId, 0); return r?.behaviour?.clicksOn?.['sl-btn2'] ?? 0; };
  await act('scrollDown', { action: 'scroll', direction: 'down', amount: 600 });
  // Straight after the wheel: the lower button is on screen now, so this click needs no scroll of
  // its own — and aims at wherever the page shows it at this moment.
  if (ref.btn2) {
    await act('clickAfterScroll', { action: 'click', ref: ref.btn2 });
    out.btn2ClicksAfterFirst = await btn2Clicks();
  }
  await act('scrollUp', { action: 'scroll', direction: 'up', amount: 600 });
  if (ref.hover) {
    await act('hover', { action: 'hover', ref: ref.hover });
    // What the page saw of the hover, before anything else moves the pointer: the event tail and
    // whether the target got its over/enter (a hover that "delivered" but never reached its element
    // is a finding, not noise).
    await sleep(300);
    const seen = await readLocalResult(g9, tabId, 0);
    const lastMove = [...(seen?.tail ?? [])].reverse().find((e) => e.ty === 'mousemove');
    out.afterHover = seen ? { endTarget: lastMove?.id ?? null, endAt: lastMove ? [lastMove.cx, lastMove.cy] : null, hoverTarget: (seen.checks ?? []).find((c) => c.id === 'hover-target')?.value ?? null, tail: (seen.tail ?? []).slice(-25) } : null;
  }
  if (ref.btn) await act('click', { action: 'click', ref: ref.btn });
  if (ref.text) await act('type', { action: 'type', ref: ref.text, text: 'Hello World from G9' });
  if (ref.sel) await act('select', { action: 'select', ref: ref.sel, values: 'Two' });
  if (ref.pd) {
    const before = await readLocalResult(g9, tabId, 0);
    await act('clickCancelledPointerdown', { action: 'click', ref: ref.pd });
    await sleep(300);
    const after = await readLocalResult(g9, tabId, 0);
    const clicksOf = (r) => r?.behaviour?.clicksOn?.['sl-pd'] ?? 0;
    out.pdClicks = clicksOf(after) - clicksOf(before);
    out.pdTail = (after?.tail ?? []).filter((e) => e.id === 'sl-pd' && /down|up|click/.test(e.ty)).map((e) => `${e.ty}${e.tr ? '' : '(untrusted)'}`).slice(-8);
  }
  if (!ARGS['no-control'] && ref.btn2 && ref.hover) {
    // CONTROL for the two misses above: the same wheel scroll, the same click and hover, but the
    // page is given 1.5 s to finish scrolling first (as a person's eyes would). If these land while
    // the immediate ones miss, the cause is the scroll call returning before the page settled.
    await act('scrollDown2', { action: 'scroll', direction: 'down', amount: 600 });
    await sleep(1500);
    const before2 = await btn2Clicks();
    await act('clickAfterSettledScroll', { action: 'click', ref: ref.btn2 });
    out.btn2ClicksControl = (await btn2Clicks()) - before2;
    await act('scrollUp2', { action: 'scroll', direction: 'up', amount: 600 });
    await sleep(1500);
    await act('hoverAfterSettledScroll', { action: 'hover', ref: ref.hover });
    await sleep(300);
    const seen2 = await readLocalResult(g9, tabId, 0);
    const lm = [...(seen2?.tail ?? [])].reverse().find((e) => e.ty === 'mousemove');
    out.afterHoverControl = { endTarget: lm?.id ?? null, endAt: lm ? [lm.cx, lm.cy] : null };
  }
  // G9's read tools, used the way an agent uses them, one at a time, while the page watches for side
  // effects (resize, visibility, blur, programmatic scroll): which tool caused what is the difference
  // between two reads.
  // pageshow is the page's own load, not a side effect (the page's check leaves it out too).
  const effectsNow = async () => { await sleep(400); const r = await readLocalResult(g9, tabId, 0); return { side: (r?.sideEffects ?? []).filter((x) => x.ty !== 'pageshow').length, lonelyScrolls: (r?.behaviour?.scrollsWithoutInput ?? []).length }; };
  const e0 = await effectsNow();
  const viewShot = await saveScreenshot(g9, tabId, path.join(runDir, `${cfg.name}-local-${iteration}.jpg`), 'viewport');
  out.screenshot = viewShot.ok ? path.basename(viewShot.file) : viewShot.error;
  const e1 = await effectsNow();
  const fullShot = await saveScreenshot(g9, tabId, path.join(runDir, `${cfg.name}-local-${iteration}-full.jpg`), 'fullpage');
  out.fullpageScreenshot = fullShot.ok ? { file: path.basename(fullShot.file), meta: fullShot.meta, pageSaw: fullShot.pageSaw } : fullShot.error;
  const e2 = await effectsNow();
  const textSnap = await g9.tool('browser_snapshot', { tabId, mode: 'a11y+text' });
  out.textSnapshot = textSnap.ok ? { chars: String(textSnap.result.text ?? '').length } : textSnap.error;
  const e3 = await effectsNow();
  let e4 = e3;
  if (ref.btn2) {
    // The lower button is off screen again (the page is back at the top): an element screenshot of it.
    const r = await g9.tool('browser_screenshot', { area: 'element', ref: ref.btn2, format: 'jpeg', tabId }, 60_000);
    out.elementScreenshot = r.ok ? { ok: true } : { ok: false, error: String(r.error).slice(0, 200) };
    e4 = await effectsNow();
  }
  out.toolEffects = {
    viewportScreenshot: { sideEffects: e1.side - e0.side, programmaticScrolls: e1.lonelyScrolls - e0.lonelyScrolls },
    fullpageScreenshot: { sideEffects: e2.side - e1.side, programmaticScrolls: e2.lonelyScrolls - e1.lonelyScrolls },
    textSnapshot: { sideEffects: e3.side - e2.side, programmaticScrolls: e3.lonelyScrolls - e2.lonelyScrolls },
    elementScreenshot: { sideEffects: e4.side - e3.side, programmaticScrolls: e4.lonelyScrolls - e3.lonelyScrolls },
    beforeTheReadTools: { sideEffects: e0.side, programmaticScrolls: e0.lonelyScrolls },
  };
  await sleep(1000);
  const result = await readLocalResult(g9, tabId, 0);
  out.result = result;
  const digest = await readDigest(g9, tabId);
  out.digest = digest ? { seq: digest.seq, timeOrigin: digest.timeOrigin, count: digest.events.length, events: digest.events.map(({ ty, at, hAt, id, cx, cy, scy, k }) => ({ ty, at: Math.round(at), q: hAt != null ? Math.round(hAt - at) : null, id, cx, cy, scy, k })) } : null;
  out.scrollSettle = scrollSettleFacts(out.actions, digest);
  if (result?.checks) {
    // Checks only the harness can make: it knows what it asked for and what G9 answered.
    const b = result.behaviour ?? {};
    if (out.afterHover) {
      const ok = out.afterHover.endTarget === 'sl-hover';
      result.checks.push({ id: 'hover-lands-on-target', status: ok ? 'pass' : 'fail', cls: 'g9', value: { endTarget: out.afterHover.endTarget, endAt: out.afterHover.endAt, delivery: out.actions.hover?.delivery, reportedPointer: out.actions.hover?.pointer, control: out.afterHoverControl ?? null },
        detail: ok ? '' : `the hover ended over another element, yet the tool reported it ${out.actions.hover?.delivery}${out.afterHoverControl ? ` (control after a 1.5 s settle ended on ${out.afterHoverControl.endTarget})` : ''}` });
    }
    if (out.actions.clickAfterScroll) {
      const hits = out.btn2ClicksAfterFirst ?? b.clicksOn?.['sl-btn2'] ?? 0;
      const ok = hits >= 1;
      const a = out.actions.clickAfterScroll;
      result.checks.push({ id: 'click-after-scroll-hits', status: ok ? 'pass' : 'fail', cls: 'g9',
        value: { clicksOnTarget: hits, delivery: a.delivery ?? null, refused: a.ok ? null : a.error, mousedowns: b.mousedownsOn, reportedAt: a.at ?? a.pointer, controlClicksOnTarget: out.btn2ClicksControl ?? null },
        detail: ok ? '' : (a.ok ? `the click was reported ${a.delivery} but the button never got it${out.btn2ClicksControl != null ? ` (control after a 1.5 s settle: ${out.btn2ClicksControl} click(s) on the button)` : ''}` : 'the click was refused (the button was on screen and uncovered)') });
    }
    if (out.actions.clickCancelledPointerdown) {
      const a = out.actions.clickCancelledPointerdown;
      const got = (out.pdClicks ?? 0) >= 1;
      const ok = got ? a.ok && a.delivery === 'delivered' : true;
      result.checks.push({ id: 'click-delivery-cancelled-pointerdown', status: ok ? (got ? 'pass' : 'info') : 'fail', cls: 'g9',
        value: { pageGotClick: got, pageSaw: out.pdTail, toolOk: a.ok, delivery: a.delivery ?? null, error: a.ok ? null : String(a.error).slice(0, 200) },
        detail: ok ? '' : 'the page received a trusted pointerdown/pointerup/click (it cancels pointerdown, so no mousedown follows), yet the tool reported the click as not delivered' });
    }
    if (out.scrollSettle) {
      // Unsettled = the page scrolled again after the call returned, so the position the call
      // reported is not where the page came to rest (or it kept moving for a long time). The next
      // action then measures its target mid-scroll; whether that miss shows depends on how many
      // round trips it spends before it measures, which is why the misses themselves are flaky.
      const late = Object.entries(out.scrollSettle).filter(([, s]) => (s.lagMs != null && s.lagMs > 50)
        || (s.scrollEventsAfterReturn > 0 && s.reportedY != null && s.finalY != null && s.reportedY !== s.finalY));
      result.checks.push({ id: 'scroll-returns-settled', status: late.length ? 'fail' : 'pass', cls: 'g9', value: out.scrollSettle,
        detail: late.length ? late.map(([k, s]) => `${k}: returned reporting y ${s.reportedY}; the page scrolled on for ${s.lagMs} ms more and came to rest at y ${s.finalY}`).join('; ') : '' });
    }
  }
  if (result?.checks) {
    // A full-page capture of a page taller than the viewport resizes the viewport (the page sees
    // it). Stealth must refuse it; below stealth it is taken, and the result must SAY what the page
    // saw (pageSaw) — an undisclosed side effect is the finding there, not the resize itself.
    const fx = out.toolEffects.fullpageScreenshot.sideEffects;
    const refused = typeof out.fullpageScreenshot === 'string';
    let status = 'pass';
    let detail = '';
    if (cfg.stealth === 'stealth') {
      if (!refused) { status = 'fail'; detail = `a full-page capture was taken at stealth; the page saw ${fx} side effect(s)`; }
      else if (!/stealth/i.test(out.fullpageScreenshot)) { status = 'warn'; detail = 'refused, but not for the stealth reason'; }
    } else if (!refused && fx > 0 && !out.fullpageScreenshot.pageSaw) { status = 'fail'; detail = `the page saw ${fx} side effect(s) and the result has no pageSaw`; }
    result.checks.push({ id: 'fullpage-disclosure', status, cls: 'g9', value: { level: cfg.stealth, refused, pageSideEffects: fx, pageSaw: refused ? null : (out.fullpageScreenshot.pageSaw ?? null), refusal: refused ? String(out.fullpageScreenshot).slice(0, 160) : null }, detail });
  }
  const consoleRead = await g9.tool('browser_console', { action: 'read', limit: 5, tabId });
  out.console = consoleRead.ok ? { entries: (consoleRead.result.entries ?? consoleRead.result.messages ?? []).length, note: consoleRead.result.note ?? consoleRead.result.unavailable ?? consoleRead.result.capture ?? null, keys: Object.keys(consoleRead.result) } : { error: consoleRead.error };
  const fr = result?.children?.frame;
  if (result?.children) out.children = { frame: fr ? { runs: fr.runtimeProbe?.runs, hits: fr.runtimeProbe?.hits, origin: fr.origin, suspicious: fr.suspicious, visibility: fr.visibility } : null };
  return out;
}

// ------------------------------------------------------------------ tool sweep

/** The page-visible counters of a local-page result: "what did this one tool make the page see". */
function counters(r) {
  const chk = (id) => (r?.checks ?? []).find((c) => c.id === id);
  return {
    runtimeRuns: chk('runtime-console-probe')?.value?.runs ?? 0,
    runtimeHits: chk('runtime-console-probe')?.value?.hits ?? 0,
    frameRuntimeRuns: r?.children?.frame?.runtimeProbe?.runs ?? 0,
    frameRuntimeHits: r?.children?.frame?.runtimeProbe?.hits ?? 0,
    mainWorldCalls: r?.counts?.mainWorldCalls ?? 0,
    frameMainWorldCalls: (r?.children?.frame?.mainWorldCalls ?? []).length,
    suspiciousGlobals: (chk('main-world-globals')?.value?.suspicious ?? []).length,
    otherGlobals: (chk('main-world-globals')?.value?.other ?? []).length,
    frameGlobals: (r?.children?.frame?.suspicious ?? []).length,
    foreignNodes: (chk('main-world-dom')?.value ?? []).length,
    sideEffects: (r?.sideEffects ?? []).filter((x) => x.ty !== 'pageshow' && !x.popup).length,
    listenerStacks: r?.counts?.listenerStacks ?? 0,
    untrusted: chk('events-trusted')?.value?.untrusted ?? 0,
    inputEvents: r?.counts?.events ?? 0,
    lonelyScrolls: (r?.behaviour?.scrollsWithoutInput ?? []).length,
  };
}

/** Counters a READ tool must never move (inputEvents is reported as a warning, not judged). */
const LEAK_COUNTERS = ['runtimeHits', 'frameRuntimeHits', 'mainWorldCalls', 'frameMainWorldCalls', 'suspiciousGlobals', 'otherGlobals', 'frameGlobals', 'foreignNodes', 'sideEffects', 'listenerStacks', 'untrusted', 'lonelyScrolls'];

/**
 * Every tool an agent reads a page with, one at a time, on a fresh local page whose Runtime probe
 * runs every 40 ms (its cross-site frame's every 100 ms): the difference in what the page saw
 * before and after each call is that tool's footprint. Run at stealth, where the promise is "none".
 * The last step is a CONTROL: browser_console evaluate runs in the main world by design, so the
 * page's main-world-call detector must see it — proof that a zero elsewhere is not a blind detector.
 */
async function runSweep(g9, cfg, ctx, tabId) {
  const out = { steps: [], problems: [] };
  const nav = await g9.tool('browser_navigate', { action: 'goto', url: localUrl(cfg, ctx, { probe: 40, sweep: 1 }), tabId }, 60_000);
  if (!nav.ok) { out.problems.push(`goto: ${nav.error}`); return out; }
  const ready = await g9.tool('browser_navigate', { action: 'wait', selector: '#sl-result[data-ready="1"]', timeoutMs: 20_000, tabId }, 40_000);
  if (!ready.ok) out.problems.push(`ready: ${ready.error}`);
  await sleep(1500); // the cross-site frame reports every 500 ms
  const snap = await g9.tool('browser_snapshot', { tabId });
  const btnRef = snap.ok ? findRef(refsOf(snap.result.tree), 'button', 'Click me') : null;
  const steps = [
    ['browser_status', {}],
    ['browser_snapshot', {}],
    ['browser_snapshot', { mode: 'a11y+text' }],
    ['browser_inspect', { what: 'dom', selector: 'h1' }],
    ['browser_inspect', { what: 'dom' }],
    ['browser_inspect', { what: 'styles', selector: '#sl-btn' }],
    ['browser_inspect', { what: 'box', selector: '#sl-btn' }],
    ['browser_inspect', { what: 'storage' }],
    ['browser_inspect', { what: 'cookies' }],
    ['browser_inspect', { what: 'frames' }],
    ['browser_console', { action: 'read', limit: 5 }],
    ['browser_network', { action: 'list', limit: 5 }],
    ['browser_navigate', { action: 'wait', selector: '#sl-btn', timeoutMs: 5000 }],
    ['browser_navigate', { action: 'wait', text: 'End of page', timeoutMs: 5000 }],
    ['browser_navigate', { action: 'wait', idle: true, timeoutMs: 8000 }],
    ['browser_diagnose', { what: 'health' }],
    ['browser_diagnose', { what: 'vitals' }],
    ['browser_diagnose', { what: 'memory', samples: 2, intervalMs: 300 }],
    ['browser_diagnose', { what: 'performance', durationMs: 1500 }],
    ['browser_screenshot', { area: 'viewport', format: 'jpeg', quality: 50 }],
    ...(btnRef ? [['browser_screenshot', { area: 'element', ref: btnRef, format: 'jpeg', quality: 50 }]] : []),
    ['browser_recording', { action: 'start', name: 'stealthtest-sweep' }],
    ['browser_recording', { action: 'status' }],
    ['browser_recording', { action: 'stop' }],
    ['browser_tabs', { action: 'list' }],
    ['browser_console', { action: 'evaluate', expression: "document.querySelector('h1') ? 1 : 0" }, { control: true }],
  ];
  let before = counters(await readLocalResult(g9, tabId, 0));
  out.baseline = before;
  for (const [tool, args, opt = {}] of steps) {
    const label = `${tool} ${Object.entries(args).filter(([k]) => k !== 'format' && k !== 'quality').map(([k, v]) => `${k}:${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')}`.trim();
    const r = await g9.tool(tool, { ...args, tabId }, 90_000);
    await sleep(700);
    const after = counters(await readLocalResult(g9, tabId, 0));
    const delta = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
    const leaks = LEAK_COUNTERS.filter((k) => delta[k] > 0);
    out.steps.push({ step: label, control: !!opt.control, ok: r.ok, ms: r.ms, ...(r.ok ? {} : { error: String(r.error).slice(0, 240) }), leaks, delta: Object.fromEntries(Object.entries(delta).filter(([, v]) => v !== 0)), probeRan: delta.runtimeRuns > 0 });
    before = after;
  }
  const real = out.steps.filter((st) => !st.control);
  const control = out.steps.find((st) => st.control);
  out.checks = [
    { id: 'tool-sweep', status: real.some((st) => st.leaks.length) ? 'fail' : 'pass', cls: 'g9',
      value: real.filter((st) => st.leaks.length || !st.ok).map((st) => ({ step: st.step, leaks: st.leaks, delta: st.delta, ...(st.ok ? {} : { error: st.error }) })),
      detail: real.some((st) => st.leaks.length) ? `read tools the page could see: ${real.filter((st) => st.leaks.length).map((st) => `${st.step} (${st.leaks.join(', ')})`).join('; ')}` : '' },
    { id: 'tool-sweep-control', status: control?.ok && control.delta.mainWorldCalls > 0 ? 'pass' : (control?.ok ? 'warn' : 'info'), cls: 'harness',
      value: control ? { ok: control.ok, delta: control.delta, error: control.error ?? null } : null,
      detail: control?.ok && !(control.delta.mainWorldCalls > 0) ? 'a main-world evaluate that calls document.querySelector was not seen by the page: the main-world-call detector is blind' : '' },
    { id: 'tool-sweep-input-events', status: real.some((st) => st.delta.inputEvents > 0) ? 'warn' : 'pass', cls: 'g9',
      value: real.filter((st) => st.delta.inputEvents > 0).map((st) => ({ step: st.step, events: st.delta.inputEvents })),
      detail: real.some((st) => st.delta.inputEvents > 0) ? 'read tools that produced input events on the page (pointer, focus or scroll)' : '' },
    { id: 'tool-sweep-errors', status: real.some((st) => !st.ok) ? 'warn' : 'pass', cls: 'harness',
      value: real.filter((st) => !st.ok).map((st) => ({ step: st.step, error: st.error })) },
  ];
  return out;
}

// ------------------------------------------------------------------ a popup the PAGE opens

/**
 * A page that opens a window of its own (OAuth, payment, "share" popups): the local page's "Open
 * popup" button calls window.open() on a trusted click, and the popup — the same page from
 * `localhost`, role=popup — runs the same probes and posts them to its opener. G9 did not open
 * that tab; it must still get the stealth treatment, and the page must not be hurt by G9 being
 * attached.
 *
 * Measured 2026-09-22 (Edge 153 and Chrome 153, headless, raw CDP without G9's tool layer): with
 * a browser-level Target.setAutoAttach({waitForDebuggerOnStart:false, flatten:true}), window.open()
 * never returns — the popup target stays at url "" and the opener's renderer stops (its timers,
 * its input acks: the click's mouseReleased "did not return after 20s", and a later goto of the
 * opener timed out). Without browser-level auto-attach, or with waitForDebuggerOnStart:true and
 * Runtime.runIfWaitingForDebugger per new target, the same click returned in 32-42 ms and the
 * popup loaded. A target=_blank link (noopener) was not affected.
 *
 * Isolation: the opener here is its own tab on its own SITE (127.0.0.2 — every 127/8 address is
 * this machine), so a frozen renderer cannot be shared with the tab the rest of the run uses, and
 * the tabs are closed afterwards. Headless only: a headed browser would open the tab in its
 * window, and a window must never come forward on a desk in use.
 */
async function runPopupTest(g9, cfg, ctx, engineId) {
  const out = { checks: [], problems: [] };
  const url = localUrl(cfg, ctx, {}, { host: '127.0.0.2', frame: false, popup: true });
  const tabsBefore = await engineTabs(g9, engineId);
  const open = await g9.tool('browser_tabs', { action: 'open', url, engine: engineId }, 60_000);
  if (!open.ok) { out.problems.push(`open: ${open.error}`); out.checks.push({ id: 'popup-test', status: 'warn', cls: 'harness', value: out.problems }); return out; }
  const tabId = open.result.tabId;
  out.openerTabId = tabId;
  try {
    const ready = await g9.tool('browser_navigate', { action: 'wait', selector: '#sl-result[data-ready="1"]', timeoutMs: 20_000, tabId }, 40_000);
    if (!ready.ok) out.problems.push(`ready: ${ready.error}`);
    const snap = await g9.tool('browser_snapshot', { tabId });
    const ref = snap.ok ? findRef(refsOf(snap.result.tree), 'button', 'Open popup') : null;
    if (!ref) { out.problems.push('no "Open popup" button in the snapshot'); return out; }
    const click = await g9.tool('browser_interact', { action: 'click', ref, tabId }, 90_000);
    out.click = actionFacts(click);
    await sleep(1200);
    out.tabsDuring = await engineTabs(g9, engineId);
    let seen = null;
    for (let i = 0; i < 10; i++) {
      seen = await readLocalResult(g9, tabId, 0);
      if (seen?.children?.popup?.final) break;
      await sleep(600);
    }
    await sleep(800);
    const last = await readLocalResult(g9, tabId, 0);
    seen = last ?? seen;
    out.tabsAfter = await engineTabs(g9, engineId);
    out.report = seen?.children?.popup ?? null;
    out.openerRead = last ? 'ok' : 'the opener page could not be read after the click';
    const popupRows = (Array.isArray(out.tabsDuring) ? out.tabsDuring : []).filter((t) => t.openerTabId === tabId || (!tabsBefore.some?.((b) => b.tabId === t.tabId) && t.tabId !== tabId));
    out.checks.push({ id: 'popup-click-returns', status: click.ok ? 'pass' : 'fail', cls: 'g9', value: { ok: click.ok, ms: click.ms, delivery: click.result?.delivery ?? null, error: click.ok ? null : String(click.error).slice(0, 200) },
      detail: click.ok ? '' : 'a trusted click on a button whose handler calls window.open() did not complete' });
    const loaded = !!out.report;
    out.checks.push({ id: 'popup-loads', status: loaded ? 'pass' : 'fail', cls: 'g9',
      value: { reported: loaded, final: !!out.report?.final, popupTabs: popupRows.map((t) => `${t.tabId} "${t.url.slice(0, 60)}"`), openerReadable: !!last },
      detail: loaded ? '' : `the page's window.open() never completed: the popup tab ${popupRows.length ? `stayed at "${popupRows[0].url}"` : 'was not listed'}${last ? '' : ' and the opener page stopped answering'}` });
    for (const c of seen?.checks ?? []) if (/^popup-(runtime-probe|main-world|webdriver|vs-top)$/.test(c.id)) out.checks.push(c);
    const leftOver = (Array.isArray(out.tabsAfter) ? out.tabsAfter : []).filter((t) => t.tabId !== tabId && !(Array.isArray(tabsBefore) && tabsBefore.some((b) => b.tabId === t.tabId)));
    out.checks.push({ id: 'popup-tab-closed', status: leftOver.length ? (loaded ? 'fail' : 'info') : 'pass', cls: 'g9', value: leftOver.map((t) => `${t.tabId} "${t.url.slice(0, 60)}"`),
      detail: leftOver.length ? (loaded ? 'the popup closed itself (window.close) but G9 still lists its tab' : 'the popup never loaded, so it could not close itself') : '' });
  } finally {
    // Close the opener and whatever it opened, so neither outlives the test in this engine.
    const now = await engineTabs(g9, engineId);
    const extra = (Array.isArray(now) ? now : []).filter((t) => t.tabId === tabId || !(Array.isArray(tabsBefore) && tabsBefore.some((b) => b.tabId === t.tabId)));
    out.closed = [];
    for (const t of extra) {
      const c = await g9.tool('browser_tabs', { action: 'close', tabId: t.tabId }, 30_000);
      out.closed.push({ tabId: t.tabId, ok: c.ok, ...(c.ok ? {} : { error: String(c.error).slice(0, 160) }) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ public pages

/**
 * Page-specific verdict readers. Each gets { text: the page's visible text (browser_snapshot
 * a11y+text), html: [outerHTML of the page's `inspect` selectors] } and returns
 * { verdict: 'pass'|'detected'|'unknown', detectedFields, warnFields, fields, reason }.
 * They are written against what the pages showed on 2026-09-22 (the comments quote it); when a page
 * changes, 'unknown' (a WARN) says so instead of a silent pass.
 */
const EXTRACTORS = {
  /**
   * bot.sannysoft.com: "Intoli.com tests" (result cells carry class passed / warn / failed) and
   * "Fingerprint Scanner tests" ("HEADCHR_UA FAIL { … }", "CHR_MEMORY FAIL {}", "PHANTOM_UA ok …").
   */
  sannysoft({ html, text }) {
    const fields = {};
    const failed = [];
    const warned = [];
    for (const table of html) {
      for (const m of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells = [...m[1].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)];
        if (cells.length < 2) continue;
        const label = decodeEntities(cells[0][2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
        const last = cells[cells.length - 1];
        const cls = /class="([^"]*)"/.exec(last[1])?.[1] ?? '';
        const value = decodeEntities(last[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).slice(0, 140);
        if (!label || /^[A-Z_]{4,}$/.test(label)) continue; // the scanner table is read from the text below
        fields[label] = { cls, value };
        if (/\bfailed\b/.test(cls)) failed.push(label);
        else if (/\bwarn\b/.test(cls)) warned.push(label);
      }
    }
    for (const m of text.matchAll(/\b([A-Z][A-Z_]{3,})\s+(ok|FAIL|WARN)\b/g)) {
      fields[m[1]] = { value: m[2] };
      if (m[2] === 'FAIL' && !failed.includes(m[1])) failed.push(m[1]);
      if (m[2] === 'WARN' && !warned.includes(m[1])) warned.push(m[1]);
    }
    const n = Object.keys(fields).length;
    if (n < 8) return { verdict: 'unknown', reason: `only ${n} result rows found`, fields, textSample: text.slice(0, 400) };
    return { verdict: failed.length ? 'detected' : 'pass', detectedFields: failed, warnFields: warned, fields };
  },

  /**
   * creepjs, "Headless" card: "chromium: true 25% like headless: 8d3a3ce5 67% headless: f49f2dad
   * 0% stealth: 0c019315" (the percentage comes BEFORE its label).
   */
  creepjs({ text }) {
    const pct = (re) => { const m = re.exec(text); return m ? Number(m[1]) : null; };
    const fields = {
      likeHeadless: pct(/(\d+(?:\.\d+)?)%\s*like headless\b/i),
      headless: pct(/(\d+(?:\.\d+)?)%\s*(?<!like )headless:/i),
      stealth: pct(/(\d+(?:\.\d+)?)%\s*stealth:/i),
      chromium: /chromium:\s*(true|false)/i.exec(text)?.[1] ?? null,
      workerUserAgent: /Worker [0-9a-f]+ .*?userAgent:\s*(Mozilla\/.*?)\s+device:/i.exec(text)?.[1] ?? null,
      resistance: /Resistance [0-9a-f]+ privacy:\s*(\w+)/i.exec(text)?.[1] ?? null,
    };
    if (fields.headless == null && fields.likeHeadless == null && fields.stealth == null) return { verdict: 'unknown', reason: 'no headless/stealth percentages in the page text', fields, textSample: text.slice(0, 500) };
    const detected = [];
    if (fields.headless > 0) detected.push(`headless ${fields.headless}%`);
    if (fields.stealth > 0) detected.push(`stealth ${fields.stealth}%`);
    const warn = fields.likeHeadless != null && fields.likeHeadless > 0 ? [`like headless ${fields.likeHeadless}%`] : [];
    return { verdict: detected.length ? 'detected' : 'pass', detectedFields: detected, warnFields: warn, fields };
  },

  /**
   * browserscan.net/bot-detection: "Test Results: Normal|Robot", then "WebDriver Normal WebDriver
   * Advance Normal … Headless Chrome Normal … CDP Normal Dev Tool Normal"; a flagged one says Abnormal.
   */
  browserscan({ text }) {
    const fields = { overall: /Test Results?\s*:\s*(Normal|Robot|Bot|Abnormal|Human)/i.exec(text)?.[1] ?? null };
    const tests = {};
    // A test name is up to four capitalised words, none of them the verdict words themselves.
    // A flagged test says "Robot" as well as "Abnormal" (measured: "WebDriver Robot WebDriver Advance Normal").
    const word = '(?!(?:Normal|Abnormal|Robot)\\b)[A-Z][A-Za-z]*';
    for (const m of text.matchAll(new RegExp(`(${word}(?: ${word}){0,3}) (Normal|Abnormal|Robot)\\b`, 'g'))) tests[m[1]] = m[2];
    fields.tests = tests;
    if (!fields.overall && !Object.keys(tests).length) return { verdict: 'unknown', reason: 'no "Test Results" line or per-test verdicts found', fields, textSample: text.slice(0, 500) };
    const detected = Object.entries(tests).filter(([, v]) => v !== 'Normal').map(([k]) => k);
    if (fields.overall && !/Normal|Human/i.test(fields.overall)) detected.unshift(`overall ${fields.overall}`);
    return { verdict: detected.length ? 'detected' : 'pass', detectedFields: detected, fields };
  },

  /**
   * pixelscan.net/fingerprint-check: "Your Browser Fingerprint is inconsistent", then one verdict per
   * card: "Timezone spoofed | Location", "Proxy detected | Proxy", "No masking detected |
   * Fingerprint", "Automated behavior detected | Bot check".
   */
  pixelscan({ text }) {
    const fields = {
      fingerprint: /Fingerprint is (consistent|inconsistent)/i.exec(text)?.[1] ?? null,
      location: /\b(Timezone spoofed|Timezone (?:is )?(?:consistent|matches)|Location (?:is )?consistent|No location issues?)\b/i.exec(text)?.[1] ?? null,
      proxy: /\b(Proxy detected|No proxy detected)\b/i.exec(text)?.[1] ?? null,
      masking: /\b(No masking detected|Masking detected)\b/i.exec(text)?.[1] ?? null,
      bot: /\b(Automated behavior detected|No automated behavior detected|Automation (?:framework )?detected|No automation detected)\b/i.exec(text)?.[1] ?? null,
      ipCountry: /Country\s+([A-Z][A-Za-z ]+?)\s+City/.exec(text)?.[1] ?? null,
      timezoneJs: /Timezone from JS\s+(\S+)/.exec(text)?.[1] ?? null,
      userTypeByIp: /User Type by IP\s+(\w+)/.exec(text)?.[1] ?? null,
    };
    if (!fields.fingerprint && !fields.bot && !fields.masking) return { verdict: 'unknown', reason: 'none of the verdict phrases found', fields, textSample: text.slice(0, 600) };
    const detected = [];
    if (fields.bot && !/^No /i.test(fields.bot)) detected.push(`bot check: ${fields.bot}`);
    if (fields.masking && !/^No /i.test(fields.masking)) detected.push(`fingerprint: ${fields.masking}`);
    const warn = [];
    if (/spoofed/i.test(fields.location ?? '')) warn.push(`location: ${fields.location}`);
    if (/^Proxy detected/i.test(fields.proxy ?? '')) warn.push(`proxy: ${fields.proxy}`);
    if (/inconsistent/i.test(fields.fingerprint ?? '')) warn.push('fingerprint is inconsistent');
    return { verdict: detected.length ? 'detected' : 'pass', detectedFields: detected, warnFields: warn, fields };
  },

  /**
   * fingerprint.com/products/bot-detection: a live demo panel with this visit's API response,
   * { "bot" : "bad" | "good" | "notDetected", … } (the prose around it lists all three values, so
   * only the JSON counts).
   */
  fingerprint({ text }) {
    const bot = /"bot"\s*:\s*"([A-Za-z_ ]+)"/.exec(text)?.[1] ?? null;
    const fields = { bot, eventId: /"event_id"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null };
    if (!bot) return { verdict: 'unknown', reason: 'no "bot": … value in the demo response', fields, textSample: text.slice(0, 600) };
    const detected = /^(bad|good)$/i.test(bot) ? [`bot: ${bot}`] : [];
    return { verdict: detected.length ? 'detected' : 'pass', detectedFields: detected, fields };
  },

  /**
   * bot-detector.rebrowser.net: one line per test, "🔴 useragent 46.4 ms …", "🟢 runtimeEnableLeak
   * 1.7 ms No leak detected.", "⚪️ dummyFn …" (white = not triggered: needs the automation to call it).
   */
  rebrowser({ text, cfg }) {
    const fields = {};
    for (const m of text.matchAll(/(\u{1F534}|\u{1F7E2}|\u{1F7E1}|⚪️?)\s*([A-Za-z]+)\s+([\d.]+) ms\s*([^\u{1F534}\u{1F7E2}\u{1F7E1}⚪]*)/gu)) {
      const state = m[1] === '\u{1F534}' ? 'red' : m[1] === '\u{1F7E2}' ? 'green' : m[1] === '\u{1F7E1}' ? 'yellow' : 'white';
      fields[m[2]] = { state, note: m[4].trim().slice(0, 160) };
    }
    const names = Object.keys(fields);
    if (names.length < 3) return { verdict: 'unknown', reason: 'no test lines found', fields, textSample: text.slice(0, 500) };
    // "Google Chrome is not presented in navigator.userAgentData" (measured 2026-09-22) is aimed at
    // Chrome for Testing, but it fires for every Microsoft Edge too, whose brand is "Microsoft
    // Edge": on Edge it says nothing about automation, so it is a warning there, not a verdict.
    const edgeQuirk = (n) => cfg?.browser === 'edge' && n === 'useragent' && /Google Chrome is not presented/i.test(fields[n].note);
    const detected = names.filter((n) => fields[n].state === 'red' && !edgeQuirk(n));
    const warn = [...names.filter((n) => fields[n].state === 'yellow'), ...names.filter((n) => fields[n].state === 'red' && edgeQuirk(n)).map((n) => `${n} (flags every Edge: no "Google Chrome" brand)`)];
    return { verdict: detected.length ? 'detected' : 'pass', detectedFields: detected, warnFields: warn, fields };
  },
};

/**
 * Who could fix what a public page flagged, by the field's name — the same classes as the local
 * page's checks. Unknown is the honest default.
 */
function attribute(field, cfg) {
  const f = String(field);
  if (/timezone|proxy|location|geo|\bip\b/i.test(f)) return 'host';
  if (/user.?agent|HEADCHR_UA|headless/i.test(f)) return cfg.headless ? 'headless' : (cfg.browser === 'cft' ? 'browser' : 'unknown');
  if (/webdriver|runtime|cdp|devtool/i.test(f)) return 'g9';
  return 'unknown';
}

async function runPublic(g9, cfg, page, tabId, runDir, viewport) {
  const out = { name: page.name, url: page.url, actions: {}, problems: [] };
  let nav = await g9.tool('browser_navigate', { action: 'goto', url: page.url, timeoutMs: 45_000, tabId }, 90_000);
  out.actions.goto = actionFacts(nav);
  if (!nav.ok && /did not return after/.test(String(nav.error))) {
    // Measured (round 3): Page.navigate answers only when the server's response arrives, and G9
    // gives it a fixed 20 s whatever timeoutMs says, so on a slow network a navigation that is
    // merely slow is reported "stuck" while it carries on in the browser. Give it the rest of the
    // 45 s and see where the tab really is; the tool's error stays in the report as a problem.
    out.problems.push(`goto (then waited for the navigation to finish): ${nav.error}`);
    const waited = await g9.tool('browser_navigate', { action: 'wait', selector: 'body', timeoutMs: 30_000, tabId }, 60_000);
    const tabs = await g9.tool('browser_tabs', { action: 'list' }, 30_000);
    const row = (tabs.result?.tabs ?? tabs.result?.rows ?? []).find((t) => (t.tabId ?? t.id) === tabId);
    const host = new URL(page.url).host;
    out.actions.gotoRecovered = { waitOk: waited.ok, url: row?.url ?? null, ms: waited.ms };
    if (row && String(row.url).includes(host)) nav = { ok: true, result: { url: row.url, title: row.title ?? null } };
  }
  if (!nav.ok) {
    out.verdict = 'unreachable';
    out.problems.push(`goto: ${nav.error}`);
    return out;
  }
  out.finalUrl = nav.result?.url ?? null;
  out.title = nav.result?.title ?? null;
  await sleep(page.settleMs ?? 5000);
  const snap = await g9.tool('browser_snapshot', { tabId, maxNodes: 400 });
  const refs = snap.ok ? refsOf(snap.result.tree) : [];
  const act = async (key, args) => {
    const r = await g9.tool('browser_interact', { ...args, tabId }, 90_000);
    out.actions[key] = actionFacts(r);
    if (!r.ok) out.problems.push(`${key}: ${r.error}`);
    return r;
  };
  if (ARGS['no-interact']) {
    await sleep((page.afterMs ?? 3000) + 6000);
    return finishPublic(g9, cfg, page, tabId, runDir, out);
  }
  await act('scrollDown', { action: 'scroll', direction: 'down', amount: 500 });
  // Pointer moves: hover over up to two elements that are on screen now (a hover changes nothing).
  const candidates = refs.filter((r) => ['link', 'button', 'textbox', 'checkbox', 'combobox', 'tab', 'menuitem'].includes(r.role)).slice(0, 12);
  let hovered = 0;
  for (const c of candidates) {
    if (hovered >= 2) break;
    const r = await g9.tool('browser_interact', { action: 'hover', ref: c.ref, tabId }, 60_000);
    if (r.ok) { hovered += 1; out.actions[`hover${hovered}`] = { ...actionFacts(r), target: `${c.role} "${c.name.slice(0, 40)}"` }; }
    else if (!out.actions.hoverError) out.actions.hoverError = String(r.error).slice(0, 200);
  }
  await act('scrollUp', { action: 'scroll', direction: 'up', amount: 300 });
  // One click on an empty spot of the page (configured per page, as fractions of the viewport the
  // local page measured; 1920x1000 when the local page did not run).
  const W = Number(viewport?.width) || 1920;
  const H = Number(viewport?.height) || 1000;
  const cx = page.click?.x ?? 0.97;
  const cy = page.click?.y ?? 0.5;
  const x = Math.round(cx <= 1 ? cx * W : cx);
  const y = Math.round(cy <= 1 ? cy * H : cy);
  await act('click', { action: 'click', x, y });
  out.actions.click.at = { x, y };
  await sleep(page.afterMs ?? 3000);
  return finishPublic(g9, cfg, page, tabId, runDir, out);
}

/** Screenshot, page text and verdict of a public page (after its interaction, if any). */
async function finishPublic(g9, cfg, page, tabId, runDir, out) {
  let shot = await saveScreenshot(g9, tabId, path.join(runDir, `${cfg.name}-${page.name}.jpg`), page.screenshot === 'fullpage' ? 'fullpage' : 'viewport');
  // At stealth G9 refuses a full-page capture of a page taller than the viewport (the browser would
  // resize the viewport — the page sees it). The evidence is then the viewport, and the report says so.
  let shotNote = '';
  if (!shot.ok && page.screenshot === 'fullpage' && /resize the page's viewport/.test(String(shot.error))) {
    shot = await saveScreenshot(g9, tabId, path.join(runDir, `${cfg.name}-${page.name}.jpg`), 'viewport');
    shotNote = ' (viewport: a full-page capture is refused at stealth)';
  }
  out.screenshot = shot.ok ? `${path.basename(shot.file)}${shotNote}` : `screenshot failed: ${shot.error}`;
  const full = await g9.tool('browser_snapshot', { tabId, mode: 'a11y+text', maxNodes: 50 });
  const text = full.ok ? String(full.result.text ?? '') : '';
  const html = [];
  for (const sel of page.inspect ?? []) {
    const r = await g9.tool('browser_inspect', { what: 'dom', selector: sel, tabId });
    if (r.ok) html.push(String(r.result.html ?? ''));
  }
  // Whole tables are more than one selector match; sannysoft has two. Read each by index too.
  if ((page.inspect ?? []).includes('table')) {
    for (const sel of ['table:nth-of-type(2)', 'body table:last-of-type']) {
      const r = await g9.tool('browser_inspect', { what: 'dom', selector: sel, tabId });
      if (r.ok && !html.includes(String(r.result.html ?? ''))) html.push(String(r.result.html ?? ''));
    }
  }
  fs.writeFileSync(path.join(runDir, `${cfg.name}-${page.name}.txt`), text);
  const fn = EXTRACTORS[page.extractor];
  let verdict;
  try {
    verdict = fn ? fn({ text, html, cfg }) : { verdict: 'unknown', reason: `no extractor "${page.extractor}"` };
  } catch (err) {
    verdict = { verdict: 'unknown', reason: `extractor threw: ${err.message}` };
  }
  Object.assign(out, verdict);
  if (Array.isArray(out.detectedFields)) out.attribution = Object.fromEntries(out.detectedFields.map((f) => [f, attribute(f, cfg)]));
  if (!text && out.verdict === 'unknown') out.reason = `${out.reason}; the page text could not be read (${full.error ?? 'empty'})`;
  return out;
}

// ------------------------------------------------------------------ the profile after a run

/**
 * What the persona profile holds once the browser has closed: every extension that is not part of
 * the browser itself, and whether the profile is signed in or syncing. A G9 profile is created
 * empty; anything else in it was put there by the browser behind G9's back (sync, import, an
 * external-extension registration on this machine) and runs content scripts in every page a
 * stealth run opens. Account facts are reported as counts and flags only — never an identity.
 */
const EXT_LOCATION = { 1: 'internal', 2: 'external-pref', 3: 'external-registry', 4: 'unpacked', 5: 'component', 6: 'external-pref-download', 7: 'external-policy-download', 8: 'command-line', 9: 'external-policy', 10: 'external-component' };
function inspectProfile(home, name) {
  const dir = path.join(home, 'profiles', name);
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const prefs = readJson(path.join(dir, 'Default', 'Preferences'));
  const secure = readJson(path.join(dir, 'Default', 'Secure Preferences'));
  const local = readJson(path.join(dir, 'Local State'));
  if (!prefs && !local) return { dir, error: 'no Preferences / Local State (the profile was not written)' };
  const extDir = path.join(dir, 'Default', 'Extensions');
  const onDisk = fs.existsSync(extDir) ? fs.readdirSync(extDir).filter((n) => n !== 'Temp') : [];
  const manifestOf = (id) => {
    try {
      const ver = fs.readdirSync(path.join(extDir, id)).sort().pop();
      const m = readJson(path.join(extDir, id, ver, 'manifest.json'));
      return m ? { name: String(m.name).slice(0, 80), version: m.version, updateUrl: m.update_url ?? null, contentScripts: (m.content_scripts ?? []).length } : null;
    } catch { return null; }
  };
  const settings = { ...(prefs?.extensions?.settings ?? {}), ...(secure?.extensions?.settings ?? {}) };
  const extensions = [];
  const stubs = [];
  for (const [id, s] of Object.entries(settings)) {
    const location = EXT_LOCATION[s?.location] ?? `location ${s?.location}`;
    if (location === 'component' || location === 'external-component') continue;
    // Round 4: with component updates on (stealth — Widevine), Edge records this machine's EXTERNAL
    // extension registrations (disabled, awaiting approval, never installed), and on the profile's
    // next launch turns them into entries that hold only permissions: no location, no manifest, no
    // files on disk (measured, Edge 153, any level). Nothing of such an entry can run in a page, so it
    // is reported as a stub, never counted as an enabled foreign extension. Anything with a location,
    // a manifest or files is judged as before.
    if (s?.location == null && !onDisk.includes(id) && !s?.manifest && !s?.path && !(s?.disable_reasons ?? []).some((r) => r)) {
      stubs.push({ id, keys: Object.keys(s ?? {}).slice(0, 6) });
      continue;
    }
    extensions.push({
      id, location, fromWebstore: s?.from_webstore ?? null, installedByDefault: s?.was_installed_by_default ?? null,
      installedByOem: s?.was_installed_by_oem ?? null, state: s?.state ?? null, disableReasons: s?.disable_reasons ?? null,
      firstInstall: s?.first_install_time ?? s?.install_time ?? null, onDisk: onDisk.includes(id),
      manifest: manifestOf(id) ?? (s?.manifest ? { name: String(s.manifest.name).slice(0, 80), version: s.manifest.version } : null),
    });
  }
  for (const id of onDisk) if (!settings[id]) extensions.push({ id, location: 'on disk only', manifest: manifestOf(id) });
  const cache = local?.profile?.info_cache ?? {};
  const accounts = Object.entries(cache).map(([profile, p]) => ({
    profile, hasUserName: !!p?.user_name, hasGaiaId: !!p?.gaia_id, hasAccountId: !!(p?.edge_account_cid || p?.edge_account_oid || p?.account_id),
    accountType: p?.edge_account_type ?? null, signinRequired: p?.signin_required ?? null,
  }));
  const syncDir = path.join(dir, 'Default', 'Sync Data');
  let syncDataBytes = 0;
  const du = (d) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) du(f); else syncDataBytes += fs.statSync(f).size; } } catch { /* none */ } };
  du(syncDir);
  // Pref NAMES (never values) that speak of sign-in, sync or import, for the report.
  const keysLike = (obj, re, pre = '', out = []) => {
    if (!obj || typeof obj !== 'object' || out.length > 60) return out;
    for (const [k, v] of Object.entries(obj)) {
      const full = pre ? `${pre}.${k}` : k;
      if (re.test(k)) out.push(full);
      else if (v && typeof v === 'object' && !Array.isArray(v) && full.split('.').length < 3) keysLike(v, re, full, out);
    }
    return out;
  };
  // The browser's own first-run defaults (e.g. Edge's "Google Docs Offline", installed by default
  // and disabled) are what a person's fresh profile has too; anything else came from somewhere.
  // Disabled ones cannot run: an external registration on this machine that the browser disabled
  // until someone approves it (disable reason 8192) is what a person's browser here has too.
  const foreign = extensions.filter((e) => !e.installedByDefault && !e.disableReasons?.some((r) => r));
  const disabledExternal = extensions.filter((e) => !e.installedByDefault && e.disableReasons?.some((r) => r)).map((e) => ({ id: e.id, location: e.location, disableReasons: e.disableReasons }));
  return {
    dir,
    extensions,
    foreign,
    disabledExternal,
    registrationStubs: stubs,
    defaults: extensions.filter((e) => e.installedByDefault).map((e) => ({ id: e.id, name: e.manifest?.name ?? null, disabled: !!e.disableReasons?.some((r) => r)  })),
    accountInfoEntries: Array.isArray(prefs?.account_info) ? prefs.account_info.length : 0,
    accounts,
    syncDataBytes,
    signinSyncImportPrefKeys: keysLike(prefs, /sync|signin|sign_in|account|import/i),
  };
}

// ------------------------------------------------------------------ one configuration

async function warmProfile(g9, cfg, profile) {
  const t0 = Date.now();
  // The warm launch is the profile's FIRST start, which is when a browser decides things for good
  // (Edge signs a new profile in to the Windows account then, measured) — so it gets the same
  // --extra-arg switches as every configuration.
  const launch = await g9.tool('browser_engine', {
    action: 'launch', browser: cfg.browser, headless: true, stealth: cfg.stealth === 'stealth' ? 'stealth' : 'human', humanize: 'human', profile, name: `warm-${profile}`,
    ...(EXTRA_ARGS.length || SAFETY_ARGS(cfg.browser).length ? { extraArgs: [...SAFETY_ARGS(cfg.browser), ...EXTRA_ARGS] } : {}),
  }, 180_000);
  if (!launch.ok) return { ok: false, error: launch.error };
  const engineId = launch.result.engineId;
  const visited = [];
  let tabId = null;
  for (const url of WARM_URLS) {
    const r = tabId == null
      ? await g9.tool('browser_tabs', { action: 'open', url, engine: engineId }, 60_000)
      : await g9.tool('browser_navigate', { action: 'goto', url, timeoutMs: 30_000, tabId }, 60_000);
    if (r.ok && tabId == null) tabId = r.result.tabId;
    visited.push({ url, ok: r.ok, ...(r.ok ? {} : { error: String(r.error).slice(0, 160) }) });
    if (r.ok) {
      await g9.tool('browser_interact', { action: 'scroll', direction: 'down', amount: 400, tabId }, 60_000);
      await sleep(1500);
    }
  }
  const stop = await g9.tool('browser_engine', { action: 'stop', engineId }, 60_000);
  return { ok: stop.ok, engineId, visited, ms: Date.now() - t0, ...(stop.ok ? {} : { error: stop.error }) };
}

/**
 * Switches for this configuration's launch: the off-screen position for headed runs, plus any
 * `--extra-arg <switch>` given on the command line (repeatable; for controlled experiments such as
 * "does pixelscan still flag this with a different user agent" — launch.js refuses the switches
 * that would turn a run into something G9 never does).
 */
function extraArgsFor(cfg) {
  const out = [];
  if (!cfg.headless && !ARGS['on-screen']) out.push(OFFSCREEN);
  out.push(...SAFETY_ARGS(cfg.browser), ...EXTRA_ARGS);
  return out;
}

/**
 * What the engine was launched with, against what G9 promises (engine/launch.js): the switch
 * list is the part of the environment G9 alone decides, so it is judged here, from the argv the
 * launch result reports. cls g9: every item is G9's choice.
 */
function launchArgvCheck(cfg, engine) {
  const argv = (engine.argv ?? []).map(String);
  const sw = argv.filter((a) => a.startsWith('--'));
  const names = sw.map((a) => a.split('=')[0].toLowerCase());
  const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  const features = (sw.find((a) => a.toLowerCase().startsWith('--disable-features=')) ?? '').split('=').slice(1).join('=').split(',').filter(Boolean);
  const problems = [];
  if (dup.length) problems.push(`switch given more than once: ${dup.join(', ')}`);
  if (!names.includes('--disable-sync')) problems.push('no --disable-sync');
  if (!features.includes('msImplicitSignin')) problems.push('msImplicitSignin is not disabled (Edge signs a new profile in to the Windows account)');
  const ac = sw.some((a) => /^--disable-blink-features=.*AutomationControlled/i.test(a));
  if (cfg.stealth === 'stealth' && !ac) problems.push('stealth without --disable-blink-features=AutomationControlled (navigator.webdriver stays true)');
  if (cfg.stealth !== 'stealth' && ac) problems.push('AutomationControlled disabled below stealth');
  if (names.includes('--enable-automation')) problems.push('--enable-automation');
  if (names.includes('--remote-debugging-port')) problems.push('a remote-debugging PORT (any local process could connect)');
  const si = sw.find((a) => a.toLowerCase().startsWith('--screen-info='));
  const userSi = EXTRA_ARGS.some((a) => a.toLowerCase().startsWith('--screen-info='));
  if (cfg.headless && !si) problems.push('headless without --screen-info (screen 800x600)');
  if (cfg.headless && si && !userSi && !/workAreaBottom=\d+/.test(si)) problems.push('headless --screen-info without a work area (availHeight === height)');
  if (!cfg.headless && si && !userSi) problems.push('--screen-info on a headed browser');
  const frl = names.includes('--disable-frame-rate-limit');
  if (cfg.browser === 'cft' && !frl) problems.push('Chrome for Testing without --disable-frame-rate-limit (input at 10 Hz)');
  if (cfg.browser !== 'cft' && frl) problems.push('--disable-frame-rate-limit on a browser that does not need it');
  return {
    id: 'launch-argv', status: problems.length ? 'fail' : 'pass', cls: 'g9',
    value: { disableFeatures: features, screenInfo: si ?? null, windowSize: sw.find((a) => a.startsWith('--window-size=')) ?? null, switches: sw.length, problems },
    detail: problems.join('; '),
  };
}

/**
 * A profile already signed in to a browser account must not be launched at stealth (engine/
 * manager.js): its synced extensions and data would be in every page. Made through the product
 * path with a FABRICATED Local State (a placeholder account; no real one is involved) in the
 * throw-away home: the launch must be refused before any browser starts.
 */
async function signInRefusalCheck(g9, home, browser) {
  const name = 'stealthtest-signed-in';
  const dir = path.join(home, 'profiles', name);
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1', user_name: 'stealthtest@example.invalid', gaia_id: '000000000000' } } } }));
  const r = await g9.tool('browser_engine', { action: 'launch', browser, headless: true, stealth: 'stealth', profile: name, name: 'signin-refusal' }, 120_000);
  const procs = processesWith(dir);
  if (r.ok) {
    await g9.tool('browser_engine', { action: 'stop', engineId: r.result.engineId }, 60_000);
  }
  const ok = !r.ok && /signed in/i.test(String(r.error)) && !procs.length;
  return {
    id: 'signin-refusal', status: ok ? 'pass' : 'fail', cls: 'g9',
    value: { refused: !r.ok, ms: r.ms, error: r.ok ? null : String(r.error).slice(0, 220), browserProcessesOnTheProfile: procs.length, launched: r.ok ? r.result.engineId : null },
    detail: ok ? '' : (r.ok ? 'a profile signed in to a browser account was launched at stealth' : (procs.length ? 'refused, but a browser was started on the profile' : 'refused for another reason')),
  };
}

/**
 * A context cannot speak another language than its profile (a per-tab override reaches the page
 * but not its workers, measured): at stealth a context locale in another LANGUAGE is refused, and
 * one in the same language (another region) is allowed with a warning.
 */
async function contextLocaleGuardCheck(g9, engineId) {
  const other = await g9.tool('browser_engine', { action: 'context', engineId, stealth: 'stealth', locale: 'de-DE' }, 60_000);
  const same = await g9.tool('browser_engine', { action: 'context', engineId, stealth: 'stealth', locale: 'en-GB' }, 60_000);
  const ok = !other.ok && same.ok;
  return {
    id: 'context-locale-guard', status: ok ? 'pass' : 'fail', cls: 'g9',
    value: {
      otherLanguage: other.ok ? { created: other.result?.contextId ?? true, warnings: other.result?.warnings ?? null } : { refused: String(other.error).slice(0, 200) },
      sameLanguage: same.ok ? { created: same.result?.contextId ?? true, warnings: same.result?.warnings ?? same.result?.warning ?? null } : { refused: String(same.error).slice(0, 200) },
    },
    detail: ok ? '' : (other.ok ? 'a stealth context in another language than its profile was created (its workers keep the profile\'s language)' : 'a stealth context in the profile\'s own language (another region) was refused'),
  };
}

async function runConfig(g9, cfg, ctx, pages, runDir) {
  const res = { config: cfg, startedAt: new Date().toISOString(), local: [], public: [], problems: [], harnessChecks: [] };
  say(`\n${color(1, `== ${cfg.name}`)} ${color(90, `(${cfg.browser}, ${cfg.headless ? 'headless' : 'headed off-screen'}, stealth ${cfg.stealth}${cfg.locale ? `, locale ${cfg.locale}` : ''}${cfg.timezone ? `, tz ${cfg.timezone}` : ''}${cfg.control ? ', CONTROL' : ''})`)}`);
  const profile = ARGS.profile ? String(ARGS.profile) : `persona-${cfg.browser}`;
  const launchArgs = {
    action: 'launch',
    browser: cfg.browser,
    headless: cfg.headless,
    stealth: cfg.stealth,
    humanize: cfg.stealth === 'off' ? 'off' : cfg.stealth,
    profile,
    name: cfg.name,
    ...(cfg.locale ? { locale: cfg.locale } : {}),
    ...(cfg.timezone ? { timezone: cfg.timezone } : {}),
    ...(extraArgsFor(cfg).length ? { extraArgs: extraArgsFor(cfg) } : {}),
  };
  const launch = await g9.tool('browser_engine', launchArgs, 180_000);
  if (!launch.ok) {
    res.problems.push(`launch: ${launch.error}`);
    say(`  ${tag.FAIL} launch: ${launch.error}`);
    return res;
  }
  const engine = launch.result;
  res.engine = { engineId: engine.engineId, browser: engine.browser, version: engine.version, headless: engine.headless, stealth: engine.stealth, humanize: engine.humanize, profile: engine.profile, argv: engine.argv, warnings: engine.warnings ?? [] };
  say(`  ${tag.INFO} ${engine.engineId}: ${engine.browser} ${engine.version} pid ${engine.pid}`);
  for (const w of engine.warnings ?? []) say(`  ${tag.INFO} launch warning: ${w}`);
  res.harnessChecks = [launchArgvCheck(cfg, engine)];
  const perConfig = { echoPort: ctx.echoPort, pagePort: ctx.pagePort, tabId: null };

  try {
    if (!ARGS['public-only']) {
      const reps = Math.max(1, Number(ARGS.repeat ?? 1) || 1);
      for (let i = 1; i <= reps; i++) {
        const local = await runLocal(g9, cfg, engine.engineId, perConfig, runDir, i);
        res.local.push(local);
        const win = local.result?.env?.window;
        if (win?.innerWidth) perConfig.viewport = { width: win.innerWidth, height: win.innerHeight };
        reportLocal(cfg, local);
      }
      const status = await g9.tool('browser_status', { tabId: perConfig.tabId });
      if (status.ok) res.status = { warnings: status.result.warnings ?? null, capabilities: status.result.capabilities ?? null, engine: status.result.engine ?? null };
      if (!ARGS['no-sweep'] && cfg.stealth === 'stealth' && perConfig.tabId != null) {
        res.sweep = await runSweep(g9, cfg, perConfig, perConfig.tabId);
        res.harnessChecks.push(...(res.sweep.checks ?? []));
        for (const st of res.sweep.steps) {
          if (st.leaks.length || !st.ok || ARGS.verbose || st.control) say(`  ${st.control ? tag.INFO : (st.leaks.length ? tag.FAIL : (st.ok ? tag.PASS : tag.WARN))} sweep ${st.step}${st.control ? ' (control)' : ''} ${color(90, `${st.ok ? `${st.ms} ms` : `error: ${String(st.error).slice(0, 140)}`}${Object.keys(st.delta).length ? ` Δ ${JSON.stringify(st.delta)}` : ''}`)}`);
        }
        say(`  ${color(90, `sweep: ${res.sweep.steps.length} tool calls, ${res.sweep.steps.filter((st) => !st.control && st.leaks.length).length} with a page-visible footprint${res.sweep.problems.length ? `; problems: ${res.sweep.problems.join('; ')}` : ''}`)}`);
      }
    }
    if (!ARGS['local-only'] && !cfg.localOnly) {
      if (perConfig.tabId == null) {
        const open = await g9.tool('browser_tabs', { action: 'open', url: 'about:blank', engine: engine.engineId }, 60_000);
        if (open.ok) perConfig.tabId = open.result.tabId;
      }
      for (const page of pages) {
        const r = await runPublic(g9, cfg, page, perConfig.tabId, runDir, perConfig.viewport);
        res.public.push(r);
        reportPublic(cfg, r, page);
      }
    }
    if (!ARGS['no-popup'] && !ARGS['no-children'] && !ARGS['public-only'] && cfg.headless) {
      res.popup = await runPopupTest(g9, cfg, perConfig, engine.engineId);
      res.harnessChecks.push(...res.popup.checks);
    }
  } finally {
    // Every tab of this engine before it stops: a tab nobody opened (an extension's welcome page, a
    // popup) takes the foreground and leaves the tested tab in the background, where a headed
    // browser throttles its frames and input.
    const tabsNow = await engineTabs(g9, engine.engineId);
    if (Array.isArray(tabsNow)) {
      res.tabsAtEnd = tabsNow;
      const others = tabsNow.filter((t) => t.tabId !== perConfig.tabId);
      res.harnessChecks.push({ id: 'tabs-at-end', status: others.length ? 'fail' : 'pass', cls: 'g9', value: tabsNow.map((t) => `${t.tabId}${t.tabId === perConfig.tabId ? ' (agent)' : ''} ${t.url.slice(0, 70)}${t.active ? ' active' : ''}`),
        detail: others.length ? 'tabs nobody opened are open in the engine (restored session, start-up page, a popup that did not close)' : '' });
    }
    if (!ARGS['no-product-checks'] && cfg.stealth === 'stealth' && !cfg.locale && !ctx.contextGuardDone) {
      ctx.contextGuardDone = true;
      res.harnessChecks.push(await contextLocaleGuardCheck(g9, engine.engineId));
    }
    for (const c of res.harnessChecks) {
      if (c.status === 'pass' && !ARGS.verbose) continue;
      say(`  ${c.status === 'fail' ? (cfg.control ? tag.DETECTED : tag.FAIL) : c.status === 'warn' ? tag.WARN : c.status === 'pass' ? tag.PASS : tag.INFO} ${c.id} [${c.cls}] ${color(90, `${JSON.stringify(c.value).slice(0, 260)}${c.detail ? ` — ${c.detail}` : ''}`)}`);
    }
    const stop = await g9.tool('browser_engine', { action: 'stop', engineId: engine.engineId }, 60_000);
    if (!stop.ok) res.problems.push(`stop: ${stop.error}`);
  }
  if (ctx.home) {
    await sleep(1500); // the browser writes Preferences on its way out
    res.profileAfter = inspectProfile(ctx.home, profile);
    const p = res.profileAfter;
    if (p.foreign?.length || p.accounts?.some((a) => a.hasUserName || a.hasGaiaId || a.hasAccountId) || p.accountInfoEntries) {
      say(`  ${tag.FAIL} profile ${profile} after the run: ${p.foreign.length} foreign extension(s) ${p.foreign.map((e) => `${e.id} "${e.manifest?.name ?? '?'}" (${e.location}${e.fromWebstore ? ', web store' : ''})`).join(', ')}; account entries ${p.accountInfoEntries}; signed-in profiles ${p.accounts.filter((a) => a.hasUserName || a.hasGaiaId || a.hasAccountId).length}; Sync Data ${p.syncDataBytes} bytes`);
    } else {
      say(`  ${tag.INFO} profile ${profile} after the run: not signed in, no enabled foreign extensions (browser defaults: ${p.defaults?.map((d) => `${d.id}${d.disabled ? ' disabled' : ''}`).join(', ') || 'none'}; disabled external registrations: ${p.disabledExternal?.map((d) => d.id).join(', ') || 'none'}; permission-only stubs, not installed: ${p.registrationStubs?.length ?? 0}), Sync Data ${p.syncDataBytes ?? 0} bytes`);
    }
  }
  res.finishedAt = new Date().toISOString();
  return res;
}

// ------------------------------------------------------------------ verdicts

function localVerdict(cfg, local) {
  const checks = local.result?.checks ?? [];
  const failed = checks.filter((c) => c.status === 'fail');
  const g9Fails = failed.filter((c) => c.cls === 'g9');
  const other = failed.filter((c) => c.cls !== 'g9');
  const warns = checks.filter((c) => c.status === 'warn');
  return { checks, failed, g9Fails, other, warns, detected: failed.length > 0 };
}

function reportLocal(cfg, local) {
  if (!local.result) {
    say(`  ${tag.WARN} local page: no result (${local.problems.join('; ')})`);
    return;
  }
  const v = localVerdict(cfg, local);
  for (const p of local.problems) say(`  ${tag.WARN} local action: ${p}`);
  for (const c of v.checks) {
    const t = c.status === 'pass' ? tag.PASS : c.status === 'fail' ? (cfg.control ? tag.DETECTED : tag.FAIL) : c.status === 'warn' ? tag.WARN : tag.INFO;
    if (c.status === 'pass' && !ARGS.verbose) continue;
    const val = typeof c.value === 'string' ? c.value : JSON.stringify(c.value);
    say(`  ${t} local#${local.iteration} ${c.id} [${c.cls}] ${color(90, `${String(val).slice(0, 220)}${c.detail ? ` — ${c.detail}` : ''}`)}`);
  }
  if (local.toolEffects) say(`  ${tag.INFO} local#${local.iteration} what each read tool made the page see: ${JSON.stringify(local.toolEffects)}`);
  const passed = v.checks.filter((c) => c.status === 'pass').length;
  say(`  ${color(90, `local#${local.iteration}: ${passed} pass, ${v.failed.length} fail (${v.g9Fails.length} G9), ${v.warns.length} warn`)}`);
}

function reportPublic(cfg, r) {
  const t = r.verdict === 'pass' ? tag.PASS : r.verdict === 'detected' ? (cfg.control ? tag.DETECTED : tag.FAIL) : tag.WARN;
  const detail = r.verdict === 'detected' ? `detected: ${(r.detectedFields ?? []).join(', ')}` : r.verdict === 'pass' ? (r.warnFields?.length ? `warn: ${r.warnFields.join(', ')}` : '') : (r.reason ?? r.problems.join('; '));
  say(`  ${t} ${r.name} ${color(90, `${detail}${r.screenshot ? ` [${r.screenshot}]` : ''}`)}`);
}

function summarise(results) {
  const rows = [];
  let gateFail = false;
  for (const res of results) {
    const cfg = res.config;
    const locals = res.local.map((l) => localVerdict(cfg, l));
    const localDetected = locals.some((v) => v.detected);
    const g9Leaks = [...new Set(locals.flatMap((v) => v.g9Fails.map((c) => c.id)))];
    const pa = res.profileAfter;
    if (pa && (pa.foreign?.length || pa.accountInfoEntries || pa.accounts?.some((a) => a.hasUserName || a.hasGaiaId || a.hasAccountId))) g9Leaks.push('profile-foreign-content');
    for (const c of res.harnessChecks ?? []) if (c.status === 'fail' && c.cls === 'g9' && !g9Leaks.includes(c.id)) g9Leaks.push(c.id);
    const otherSignals = [...new Set(locals.flatMap((v) => v.other.map((c) => `${c.id} [${c.cls}]`)))];
    const pubDetected = res.public.filter((p) => p.verdict === 'detected').map((p) => `${p.name}: ${(p.detectedFields ?? []).join(', ')}`);
    const pubUnknown = res.public.filter((p) => p.verdict !== 'detected' && p.verdict !== 'pass').map((p) => `${p.name}: ${p.verdict} (${p.reason ?? p.problems.join('; ')})`);
    let verdict;
    if (res.problems.length && !res.local.length && !res.public.length) verdict = 'ERROR';
    else if (cfg.control) {
      const wd = locals.some((v) => v.failed.some((c) => c.id === 'webdriver'));
      verdict = wd ? 'CONTROL-DETECTED' : 'CONTROL-NOT-DETECTED';
      if (!wd) gateFail = true;
    } else {
      verdict = localDetected || pubDetected.length || g9Leaks.length ? 'DETECTED' : 'UNDETECTED';
      if (verdict === 'DETECTED') gateFail = true;
    }
    rows.push({ name: cfg.name, verdict, g9Leaks, otherSignals, publicDetected: pubDetected, publicWarnings: pubUnknown, problems: res.problems });
  }
  return { rows, gateFail };
}

/** The product checks that are not a configuration (sign-in refusal): a failed one fails the gate. */
function summariseProduct(checks) {
  const failed = (checks ?? []).filter((c) => c.status === 'fail');
  return { rows: (checks ?? []).map((c) => ({ id: c.id, status: c.status, detail: c.detail ?? '' })), gateFail: failed.length > 0 };
}

function writeReport(runDir, payload) {
  fs.writeFileSync(path.join(runDir, 'results.json'), `${JSON.stringify(payload, null, 2)}\n`);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const parts = [];
  parts.push(`<!doctype html><meta charset="utf-8"><title>G9 stealth self-test</title><style>
    :root { color-scheme: light dark; --bg:#fff; --fg:#1d1d1f; --mut:#6e6e73; --line:#d2d2d7; --ok:#1a7f37; --bad:#c62828; --warn:#9a6700; }
    @media (prefers-color-scheme: dark) { :root { --bg:#161618; --fg:#f2f2f3; --mut:#a1a1a6; --line:#3a3a3c; --ok:#4ac26b; --bad:#ff6b6b; --warn:#e3b341; } }
    body { font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); margin: 24px; }
    table { border-collapse: collapse; margin: 8px 0 20px; width: 100%; } td, th { border: 1px solid var(--line); padding: 4px 8px; vertical-align: top; text-align: left; }
    .pass { color: var(--ok); } .fail { color: var(--bad); } .warn { color: var(--warn); } .mut { color: var(--mut); }
    img { max-width: 420px; border: 1px solid var(--line); } code { font-size: 12px; }
  </style>`);
  parts.push(`<h1>G9 stealth self-test</h1><p class="mut">G9 ${esc(payload.version)} · ${esc(payload.startedAt)} · ${esc(payload.host)}</p>`);
  parts.push('<h2>Summary</h2><table><tr><th>configuration</th><th>verdict</th><th>G9 leaks</th><th>other signals</th><th>public detectors</th></tr>');
  for (const r of payload.summary.rows) {
    const cls = /UNDETECTED|CONTROL-DETECTED/.test(r.verdict) ? 'pass' : 'fail';
    parts.push(`<tr><td>${esc(r.name)}</td><td class="${cls}">${esc(r.verdict)}</td><td>${esc(r.g9Leaks.join(', ') || '—')}</td><td>${esc(r.otherSignals.join(', ') || '—')}</td><td>${esc([...r.publicDetected, ...r.publicWarnings].join(' · ') || '—')}</td></tr>`);
  }
  parts.push('</table>');
  if (payload.productChecks?.length) {
    parts.push('<h2>Product checks</h2><table><tr><th>check</th><th>status</th><th>value</th></tr>');
    for (const c of payload.productChecks) parts.push(`<tr><td>${esc(c.id)}</td><td class="${esc(c.status)}">${esc(c.status)}</td><td><code>${esc(JSON.stringify(c.value)).slice(0, 600)}</code>${c.detail ? `<br><span class="mut">${esc(c.detail)}</span>` : ''}</td></tr>`);
    parts.push('</table>');
  }
  for (const res of payload.results) {
    parts.push(`<h2>${esc(res.config.name)}</h2><p class="mut">${esc(res.engine ? `${res.engine.browser} ${res.engine.version} · argv: ${(res.engine.argv ?? []).join(' ')}` : res.problems.join('; '))}</p>`);
    for (const l of res.local) {
      parts.push(`<h3>local page #${l.iteration}</h3>${l.screenshot && !/fail/.test(l.screenshot) ? `<img src="${esc(l.screenshot)}">` : ''}<table><tr><th>check</th><th>status</th><th>class</th><th>value</th></tr>`);
      for (const c of l.result?.checks ?? []) parts.push(`<tr><td>${esc(c.id)}</td><td class="${esc(c.status)}">${esc(c.status)}</td><td>${esc(c.cls)}</td><td><code>${esc(JSON.stringify(c.value)).slice(0, 400)}</code>${c.detail ? `<br><span class="mut">${esc(c.detail)}</span>` : ''}</td></tr>`);
      parts.push('</table>');
    }
    if (res.harnessChecks?.length) {
      parts.push('<h3>checks made by the harness</h3><table><tr><th>check</th><th>status</th><th>class</th><th>value</th></tr>');
      for (const c of res.harnessChecks) parts.push(`<tr><td>${esc(c.id)}</td><td class="${esc(c.status)}">${esc(c.status)}</td><td>${esc(c.cls)}</td><td><code>${esc(JSON.stringify(c.value)).slice(0, 600)}</code>${c.detail ? `<br><span class="mut">${esc(c.detail)}</span>` : ''}</td></tr>`);
      parts.push('</table>');
    }
    if (res.sweep?.steps?.length) {
      parts.push('<h3>tool sweep (what each read tool made the page see)</h3><table><tr><th>tool call</th><th>ok</th><th>ms</th><th>page-visible change</th></tr>');
      for (const st of res.sweep.steps) parts.push(`<tr><td>${esc(st.step)}${st.control ? ' <span class="mut">(control)</span>' : ''}</td><td class="${st.ok ? 'pass' : 'warn'}">${st.ok ? 'ok' : esc(String(st.error).slice(0, 200))}</td><td>${esc(st.ms)}</td><td class="${st.leaks.length && !st.control ? 'fail' : ''}"><code>${esc(JSON.stringify(st.delta))}</code></td></tr>`);
      parts.push('</table>');
    }
    if (res.public.length) {
      parts.push('<h3>public detectors</h3><table><tr><th>page</th><th>verdict</th><th>fields</th><th>screenshot</th></tr>');
      for (const p of res.public) {
        const cls = p.verdict === 'pass' ? 'pass' : p.verdict === 'detected' ? 'fail' : 'warn';
        parts.push(`<tr><td><a href="${esc(p.url)}">${esc(p.name)}</a></td><td class="${cls}">${esc(p.verdict)}${p.reason ? `<br><span class="mut">${esc(p.reason)}</span>` : ''}</td><td><code>${esc(JSON.stringify(p.detectedFields ?? p.fields ?? {})).slice(0, 600)}</code></td><td>${p.screenshot && p.screenshot.endsWith('.jpg') ? `<img src="${esc(p.screenshot)}">` : esc(p.screenshot)}</td></tr>`);
      }
      parts.push('</table>');
    }
  }
  fs.writeFileSync(path.join(runDir, 'report.html'), parts.join('\n'));
}

// ------------------------------------------------------------------ main

async function main() {
  const configs = configsFromArgs();
  const pagesFile = ARGS.pages ? path.resolve(String(ARGS.pages)) : path.join(HERE, 'stealth-pages.json');
  let pages = JSON.parse(fs.readFileSync(pagesFile, 'utf8')).pages ?? [];
  if (ARGS.only) { const only = String(ARGS.only).split(','); pages = pages.filter((p) => only.includes(p.name)); }
  const runDir = path.resolve(String(ARGS.out ?? path.join(os.tmpdir(), `g9-stealthtest-${stamp()}`)));
  fs.mkdirSync(runDir, { recursive: true });

  let home;
  if (ARGS.home) home = path.resolve(String(ARGS.home));
  else {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-stealth-home-'));
    tempDirs.push(home);
  }
  sweepMarker = home;
  const port = ARGS.port ? Number(ARGS.port) : await freePort();
  if (port === 8765 || !(port >= 1024 && port < 65536)) throw new Error(`refusing port ${port}`);

  say(color(1, `G9 stealth self-test — v${VERSION}`));
  say(color(90, `run dir: ${runDir}\nhome:    ${home}\nport:    ${port} (never 8765)`));

  const payload = { version: VERSION, startedAt: new Date().toISOString(), host: `${os.hostname()} ${os.platform()} ${os.release()}`, argv: process.argv.slice(2), runDir, results: [], warm: {}, calls: null };

  // Chrome for Testing: installed into the temp home from the local zip cache, never downloaded here.
  if (configs.some((c) => c.browser === 'cft')) {
    const cacheDir = process.env.G9_CFT_CACHE || path.join(os.tmpdir(), 'g9-cft-cache');
    const t0 = Date.now();
    try {
      const { ensure } = await import('../engine/cft.js');
      const got = await ensure({ home, cacheDir, trigger: 'stealthtest' });
      payload.cft = { version: got.version, path: got.path, ms: Date.now() - t0, cacheDir };
      say(`  ${tag.INFO} Chrome for Testing ${got.version} installed from ${cacheDir} in ${Date.now() - t0} ms`);
    } catch (err) {
      payload.cft = { error: err.message };
      say(`  ${tag.WARN} Chrome for Testing unavailable (${err.message}); cft configurations will fail to launch`);
    }
  }

  const page = await startPageServer();
  const echo = await startEchoServer();
  await startDaemon(home, port);
  const g9 = new G9(port, home);
  await g9.init();
  const ctx = { pagePort: page.port, echoPort: echo.port, home };

  try {
    if (!ARGS['no-warm'] && !ARGS.home) {
      for (const browser of [...new Set(configs.map((c) => c.browser))]) {
        const cfg = configs.find((c) => c.browser === browser);
        const profile = ARGS.profile ? String(ARGS.profile) : `persona-${browser}`;
        say(color(90, `warming profile ${profile} (${browser}) …`));
        payload.warm[profile] = await warmProfile(g9, cfg, profile);
        const w = payload.warm[profile];
        say(`  ${w.ok ? tag.INFO : tag.WARN} warm ${profile}: ${w.ok ? `${w.visited.filter((v) => v.ok).length}/${w.visited.length} pages in ${w.ms} ms` : w.error}`);
      }
    }
    payload.productChecks = [];
    if (!ARGS['no-product-checks'] && !ARGS.home && configs.some((c) => c.browser === 'edge' || c.browser === 'auto')) {
      const c = await signInRefusalCheck(g9, home, configs.find((x) => x.browser === 'edge' || x.browser === 'auto').browser);
      payload.productChecks.push(c);
      say(`  ${c.status === 'pass' ? tag.PASS : tag.FAIL} ${c.id} ${color(90, `${JSON.stringify(c.value).slice(0, 260)}${c.detail ? ` — ${c.detail}` : ''}`)}`);
    }
    for (const cfg of configs) payload.results.push(await runConfig(g9, cfg, ctx, pages, runDir));
  } finally {
    payload.calls = g9.calls;
    g9.close();
    echo.server.close();
    await sleep(500);
  }

  payload.summary = summarise(payload.results);
  payload.productSummary = summariseProduct(payload.productChecks);
  payload.finishedAt = new Date().toISOString();
  const clean = await cleanup();
  payload.cleanup = clean;
  writeReport(runDir, payload);

  say(`\n${color(1, 'Summary')}`);
  for (const r of payload.summary.rows) {
    const t = /UNDETECTED|CONTROL-DETECTED/.test(r.verdict) ? tag.PASS : tag.FAIL;
    say(`  ${t} ${r.name}: ${r.verdict}${r.g9Leaks.length ? ` — G9 leaks: ${r.g9Leaks.join(', ')}` : ''}${r.otherSignals.length ? ` — other signals: ${r.otherSignals.join(', ')}` : ''}${r.publicDetected.length ? ` — public: ${r.publicDetected.join(' · ')}` : ''}`);
    for (const w of r.publicWarnings) say(`  ${tag.WARN} ${r.name}: ${w}`);
  }
  say(color(90, `\ncleanup: swept ${clean.swept?.length ?? 0} process(es), ${clean.leftovers.length} left; temp dirs removed ${clean.removed?.length ?? 0}, not removed ${clean.notRemoved?.length ?? 0}`));
  say(color(90, `report: ${path.join(runDir, 'report.html')}`));
  for (const r of payload.productSummary.rows) say(`  ${r.status === 'pass' ? tag.PASS : tag.FAIL} product check ${r.id}${r.detail ? `: ${r.detail}` : ''}`);
  process.exitCode = payload.summary.gateFail || payload.productSummary.gateFail ? 1 : 0;
}

main().catch(async (err) => {
  console.error(`stealthtest could not run: ${err?.stack ?? err}`);
  await cleanup();
  process.exitCode = 2;
});
