#!/usr/bin/env node
/**
 * (3.4) End-to-end check of long, unattended work — on BOTH engines, through the product path.
 *
 * Run it inside the isolated Engine 1 harness, which gives it a private daemon, a real headless Edge
 * carrying a copy of the extension, and the fixture pages (setup/fixtures/longwork.html):
 *
 *   G9_TIMEOUT_MS=10000 G9_LIVE_SCRIPT=setup/longwork-livetest.mjs node setup/isolated-livetest.mjs
 *
 * G9_TIMEOUT_MS shortens the daemon's base deadline so a stuck command is cancelled after 10 s (the
 * watchdog check) instead of 120 s. Optional: G9_LONGWORK_REPORT=<file.json> keeps the numbers;
 * G9_LONGWORK_JOB_S (default 185) is the length of the evaluate job.
 *
 * What it proves, per engine (the extension in the browser, and a launched headless browser):
 *   a background tab is read, evaluated and snapshotted; a command the page never answers is cut by
 *   the watchdog and the tab works again; close returns while a call is stuck; snapshot filters and
 *   diffs, with their sizes against the full tree; a predicate wait and a ref-state wait; an evaluate
 *   job of 3+ minutes with progress, read from a fresh session at the end; fetch-to-file with its
 *   sha256 checked against the file served; a screenshot saved to a file with a thumbnail; a batch
 *   with a failing step. And over MCP HTTP: a session name and the tab's ownership carried across
 *   two fresh MCP sessions of one client (and refused to another client).
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resultFromContent } from '../mcp/mcp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PAGE = process.env.G9_LIVE_PAGE;
if (!PAGE) {
  console.error('Run me through setup/isolated-livetest.mjs (G9_LIVE_SCRIPT=setup/longwork-livetest.mjs).');
  process.exit(2);
}
const FIXTURE = new URL('fixtures/longwork.html', PAGE).href;
const FIXTURE_FILE = path.join(HERE, 'fixtures', 'longwork.html');
const JOB_S = Number(process.env.G9_LONGWORK_JOB_S) > 0 ? Number(process.env.G9_LONGWORK_JOB_S) : 185;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-longwork-'));

let passed = 0;
let failed = 0;
const report = { engines: {}, http: {}, jobSeconds: JOB_S };
const ok = (name, detail = '') => { passed += 1; console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`); };
const bad = (name, detail = '') => { failed += 1; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`); };
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : bad(name, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ------------------------------------------------------------------ MCP over stdio (the shim)

class StdioMcp {
  constructor(name) {
    this.name = name;
    this.child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'shim.mjs')], { cwd: ROOT, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p.resolve(msg); }
      }
    });
    this.child.stderr.on('data', (c) => { this.stderr += c; });
  }
  request(method, params, timeoutMs = 120_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async init() {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.name, version: '1' } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }
  /** → { ok, data, text, bytes, images, ms } — bytes: what the agent receives (every content block). */
  async call(tool, args = {}, timeoutMs = 120_000) {
    const t0 = Date.now();
    const res = await this.request('tools/call', { name: tool, arguments: args }, timeoutMs);
    return shape(res.result, res.error, Date.now() - t0);
  }
  close() { try { this.child.stdin.end(); } catch { /* gone */ } }
}

function shape(result, error, ms) {
  const content = result?.content ?? [];
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const bytes = content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : (c.data?.length ?? 0)), 0);
  const data = resultFromContent(content);
  return { ok: !result?.isError && !error, data: data && typeof data === 'object' ? data : null, text: text || String(error?.message ?? ''), bytes, images: content.filter((c) => c.type === 'image'), ms };
}

// ------------------------------------------------------------------ MCP over HTTP (mcp/http.mjs)

async function freePort() {
  for (;;) {
    const port = 18000 + Math.floor(Math.random() * 1000);
    const free = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (free) return port;
  }
}

async function startHttpEndpoint() {
  const port = await freePort();
  const token = `g9e2e_${crypto.randomBytes(24).toString('hex')}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'http.mjs')], {
    cwd: ROOT, env: { ...process.env, G9_MCP_HTTP_PORT: String(port), G9_MCP_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (c) => { log += c; });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { /* not yet */ }
    await sleep(100);
  }
  return { port, token, child, log: () => log };
}

class HttpSession {
  constructor(ep, clientName, headers = {}) { this.ep = ep; this.clientName = clientName; this.headers = headers; this.id = null; this.n = 1; }
  async post(body, timeoutMs = 600_000) {
    const res = await fetch(`http://127.0.0.1:${this.ep.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.ep.token}`, ...(this.id ? { 'Mcp-Session-Id': this.id } : {}), ...this.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!this.id) this.id = res.headers.get('mcp-session-id');
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  async init() {
    await this.post({ jsonrpc: '2.0', id: this.n++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.clientName, version: '1' } } });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return this;
  }
  async call(tool, args = {}, timeoutMs = 600_000) {
    const t0 = Date.now();
    const res = await this.post({ jsonrpc: '2.0', id: this.n++, method: 'tools/call', params: { name: tool, arguments: args } }, timeoutMs);
    return shape(res?.result, res?.error, Date.now() - t0);
  }
  async end() {
    await fetch(`http://127.0.0.1:${this.ep.port}/mcp`, { method: 'DELETE', headers: { Authorization: `Bearer ${this.ep.token}`, 'Mcp-Session-Id': this.id } }).catch(() => {});
  }
}

// ------------------------------------------------------------------ the checks, per engine

async function startJob(mcp, engine, tabId) {
  const started = await mcp.call('browser_console', { action: 'evaluate', job: true, tabId, expression: `renderVideo(${JOB_S}, __g9job)` });
  check(started.ok && /^job-/.test(started.data?.jobId ?? '') && started.ms < 5_000, `${engine}: an evaluate job answers at once with a jobId`, `${started.ms} ms, ${started.data?.jobId ?? started.text}`);
  return { jobId: started.data?.jobId, tabId, startedAt: Date.now(), samples: [] };
}

async function sampleJob(mcp, engine, job) {
  const s = await mcp.call('browser_console', { action: 'job_status', jobId: job.jobId, tabId: job.tabId });
  if (s.data) job.samples.push({ atS: Math.round((Date.now() - job.startedAt) / 1000), state: s.data.state, progress: s.data.progress, note: s.data.note });
  return s;
}

async function engineSuite(mcp, engine, { job }) {
  const r = { engine };
  report.engines[engine] = r;
  console.log(`\n\x1b[1m${engine}: background tab, reads, watchdog, close\x1b[0m`);

  if (job) await sampleJob(mcp, engine, job);
  // A BACKGROUND tab (in the person's browser: not focused). Reads, evaluate and snapshot must work.
  const opened = await mcp.call('browser_tabs', { action: 'open', url: FIXTURE, engine, focus: false });
  const tabId = opened.data?.tabId;
  check(opened.ok && Number.isInteger(tabId), `${engine}: opened the fixture in a background tab`, engine === 'extension' ? `background:${opened.data?.background}` : `tab ${tabId}`);
  await mcp.call('browser_navigate', { action: 'wait', tabId, predicate: "document.readyState === 'complete' && !!window.renderVideo", timeoutMs: 20_000 });
  const vis = await mcp.call('browser_console', { action: 'evaluate', tabId, expression: 'document.visibilityState' });
  r.backgroundVisibility = vis.data?.value;
  check(vis.ok, `${engine}: evaluate on the background tab`, `visibilityState=${vis.data?.value}, ${vis.ms} ms`);
  const full = await mcp.call('browser_snapshot', { tabId });
  check(full.ok && full.data?.interactiveCount > 100, `${engine}: a full snapshot of the background tab`, `${full.data?.interactiveCount} refs, ${full.bytes} bytes, ${full.ms} ms`);

  // Token economy: the same page through each option, sizes as the agent receives them.
  const interactive = await mcp.call('browser_snapshot', { tabId, interactiveOnly: true });
  const buttons = await mcp.call('browser_snapshot', { tabId, roles: ['button'] });
  const scoped = await mcp.call('browser_snapshot', { tabId, scope: 'form' });
  const found = await mcp.call('browser_inspect', { what: 'find', tabId, role: 'button', name: '^Save$' });
  const noText = await mcp.call('browser_snapshot', { tabId, includeText: false });
  const base = await mcp.call('browser_snapshot', { tabId, diff: true });
  await mcp.call('browser_console', { action: 'evaluate', tabId, expression: 'mutateProfile()' });
  const diff = await mcp.call('browser_snapshot', { tabId, diff: true });
  const unchanged = await mcp.call('browser_snapshot', { tabId, diff: true });
  const pretty = JSON.stringify(full.data, null, 2).length;
  r.snapshotBytes = {
    fullIndentedJson: pretty, full: full.bytes, includeTextFalse: noText.bytes, interactiveOnly: interactive.bytes, rolesButton: buttons.bytes,
    scopeForm: scoped.bytes, findSave: found.bytes, diffFirst: base.bytes, diffAfterChange: diff.bytes, diffUnchanged: unchanged.bytes,
  };
  check(found.ok && /^- button "Save" \[ref=e\d+\]$/.test(found.data?.tree ?? ''), `${engine}: find role:"button" name:"^Save$" → one line with its ref`, `${found.bytes} bytes vs ${full.bytes} full`);
  check(diff.ok && diff.data?.diff?.added === 1 && diff.data?.diff?.changed >= 1 && diff.data?.diff?.removed === 1,
    `${engine}: diff after a change: +Delete, ~Name, -Help`, `${JSON.stringify(diff.data?.diff)}; ${diff.bytes} bytes`);
  check(unchanged.data?.tree === '(no change)', `${engine}: diff with nothing changed`, `${unchanged.bytes} bytes`);
  const saveRefFull = /"Save" \[ref=(e\d+)\]/.exec(full.data?.tree ?? '')?.[1];
  check(saveRefFull && found.data?.tree.includes(`[ref=${saveRefFull}]`), `${engine}: refs are stable across snapshots`, `Save is ${saveRefFull} in both`);
  const pct = (n) => `${Math.round((1 - n / full.bytes) * 100)}%`;
  console.log(`      sizes (bytes the agent receives): full ${full.bytes} (indented JSON would be ${pretty}, compact saves ${Math.round((1 - full.bytes / pretty) * 100)}%), ` +
    `includeText:false ${noText.bytes} (−${pct(noText.bytes)}), interactiveOnly ${interactive.bytes} (−${pct(interactive.bytes)}), roles:[button] ${buttons.bytes} (−${pct(buttons.bytes)}), ` +
    `scope:form ${scoped.bytes} (−${pct(scoped.bytes)}), find ${found.bytes} (−${pct(found.bytes)}), diff ${diff.bytes} (−${pct(diff.bytes)}), unchanged diff ${unchanged.bytes} (−${pct(unchanged.bytes)})`);

  if (job) await sampleJob(mcp, engine, job);
  // Waits polled by the engine: a predicate to its final value, a ref to "gone".
  await mcp.call('browser_console', { action: 'evaluate', tabId, expression: 'startRender(3000)' });
  const waited = await mcp.call('browser_navigate', { action: 'wait', tabId, predicate: 'window.__ready', timeoutMs: 30_000 });
  r.predicateWait = { waitedMs: waited.data?.waitedMs, polls: waited.data?.polls, value: waited.data?.value, callMs: waited.ms };
  check(waited.ok && waited.data?.value?.frames === 120 && waited.data.waitedMs >= 2_500, `${engine}: predicate wait returns the final value`, `${waited.data?.waitedMs} ms, ${waited.data?.polls} looks, ${JSON.stringify(waited.data?.value)}`);
  const del = await mcp.call('browser_inspect', { what: 'find', tabId, role: 'button', name: '^Delete$' });
  const delRef = /ref=(e\d+)/.exec(del.data?.tree ?? '')?.[1];
  await mcp.call('browser_console', { action: 'evaluate', tabId, expression: "setTimeout(() => document.getElementById('delete').remove(), 1500), 'scheduled'" });
  const gone = await mcp.call('browser_navigate', { action: 'wait', tabId, ref: delRef, state: 'gone', timeoutMs: 15_000 });
  check(gone.ok && gone.data?.waitedMs >= 1_000, `${engine}: ref-state wait until "gone"`, `${delRef}, ${gone.data?.waitedMs} ms`);

  // Files on the browser's machine.
  const savePath = path.join(OUT, `${engine}-longwork.html`);
  const fetched = await mcp.call('browser_network', { action: 'fetch', tabId, url: FIXTURE, savePath });
  const disk = sha256(fs.readFileSync(FIXTURE_FILE));
  r.fetch = { size: fetched.data?.size, sha256: fetched.data?.sha256, served: disk, path: fetched.data?.path, bytes: fetched.bytes };
  check(fetched.ok && fetched.data?.sha256 === disk && fs.existsSync(savePath) && sha256(fs.readFileSync(savePath)) === disk,
    `${engine}: fetch-to-file, sha256 equal to the file served`, `${fetched.data?.size} bytes, ${String(fetched.data?.sha256).slice(0, 16)}…, answer ${fetched.bytes} bytes`);
  const shotPath = path.join(OUT, `${engine}-shot`);
  const shot = await mcp.call('browser_screenshot', { tabId, savePath: shotPath, thumbnail: true });
  r.screenshot = { bytes: shot.data?.bytes, path: shot.data?.path, thumbnail: shot.data?.thumbnail, answerBytes: shot.bytes };
  check(shot.ok && fs.existsSync(shot.data?.path ?? '') && shot.images.length === 1 && shot.data?.sha256 === sha256(fs.readFileSync(shot.data.path)),
    `${engine}: screenshot saved to a file, a thumbnail inline`, `${shot.data?.bytes} bytes on disk, answer ${shot.bytes} bytes${shot.data?.thumbnailError ? `; thumbnail: ${shot.data.thumbnailError}` : ''}${shot.ok ? '' : `; ${shot.text.slice(0, 300)}`}`);

  if (job) await sampleJob(mcp, engine, job);
  // The watchdog: a command the page never answers, past the call's deadline (G9_TIMEOUT_MS).
  const t0 = Date.now();
  const stuck = await mcp.call('browser_console', { action: 'evaluate', tabId, expression: 'new Promise(() => {})' }, 180_000);
  const stuckMs = Date.now() - t0;
  r.watchdog = { ms: stuckMs, error: stuck.text.slice(0, 300) };
  check(!stuck.ok && /\[recovered\]/.test(stuck.text), `${engine}: a stuck command is cut and its tab recovered`, `${stuckMs} ms: ${stuck.text.slice(0, 140)}`);
  const after = await mcp.call('browser_console', { action: 'evaluate', tabId, expression: '6 * 7' });
  check(after.ok && after.data?.value === 42, `${engine}: the tab answers again after the recovery`, `${after.ms} ms`);
  const snapAfter = await mcp.call('browser_snapshot', { tabId, interactiveOnly: true });
  check(snapAfter.ok, `${engine}: and snapshots again`, `${snapAfter.ms} ms`);

  // Close while a call is stuck: it must not wait behind it.
  const pending = mcp.call('browser_console', { action: 'evaluate', tabId, expression: 'new Promise(() => {})' }, 180_000);
  await sleep(1_000);
  const c0 = Date.now();
  const closed = await mcp.call('browser_tabs', { action: 'close', tabId });
  const closeMs = Date.now() - c0;
  const stuckEnd = await pending;
  r.close = { ms: closeMs, endedCalls: closed.data?.endedCalls, stuckError: stuckEnd.text.slice(0, 200) };
  check(closed.ok && closeMs < 20_000, `${engine}: close returns while a call is stuck on the tab`, `${closeMs} ms, ended ${closed.data?.endedCalls ?? 0} call(s)`);
  check(!stuckEnd.ok && /closed/.test(stuckEnd.text), `${engine}: the stuck call ends, naming the close`, stuckEnd.text.slice(0, 120));

  // A batch with a failing step, on a tab in front (input needs a shown tab in the person's browser).
  console.log(`\n\x1b[1m${engine}: batch\x1b[0m`);
  const front = await mcp.call('browser_tabs', { action: 'open', url: FIXTURE, engine, focus: true });
  const frontTab = front.data?.tabId;
  await mcp.call('browser_navigate', { action: 'wait', tabId: frontTab, predicate: "document.readyState === 'complete' && !!window.renderVideo", timeoutMs: 20_000 });
  const batch = await mcp.call('browser_recording', {
    action: 'batch', tabId: frontTab, humanize: 'off',
    steps: [
      { action: 'type', role: 'textbox', name: '^Name$', text: 'Lin', clear: true },
      { action: 'click', role: 'button', name: '^Save$' },
      { action: 'wait', predicate: "window.__saved === 'Lin'", timeoutMs: 10_000 },
      { action: 'extract', selector: '#status', saveAs: 'status' },
      { action: 'evaluate', expression: "'{{status}}'.toUpperCase()" },
      { action: 'click', role: 'button', name: '^Publish$' },
      { action: 'evaluate', expression: "'never reached'" },
    ],
  }, 300_000);
  r.batch = { ok: batch.data?.ok, completed: batch.data?.completed, failedAt: batch.data?.failedAt, ms: batch.data?.ms, bytes: batch.bytes, steps: batch.data?.steps?.map((s) => `${s.i}:${s.action}:${s.ok ? 'ok' : 'FAIL'}`) };
  check(batch.ok && batch.data?.ok === false && batch.data?.completed === 5 && batch.data?.failedAt === 6,
    `${engine}: batch ran 5 steps and stopped at the failing 6th`, `${batch.data?.ms} ms for ${batch.data?.steps?.length} steps, answer ${batch.bytes} bytes${batch.data?.failedAt !== 6 ? `; ${String(batch.data?.error ?? batch.text).slice(0, 400)}` : ''}`);
  check(batch.data?.steps?.[4]?.value === 'SAVED LIN', `${engine}: a value saved by one step feeds a later step`, JSON.stringify(batch.data?.steps?.[4]?.value));
  check(/"Save"/.test(batch.data?.excerpt?.tree ?? '') && batch.data?.excerpt?.of === 'every button on the page', `${engine}: the failure comes with an excerpt of the page there`, batch.data?.excerpt?.tree?.split('\n').length + ' lines');
  await mcp.call('browser_tabs', { action: 'close', tabId: frontTab });

  if (job) await sampleJob(mcp, engine, job);
  return r;
}

// ------------------------------------------------------------------ main

async function main() {
  console.log(`\n\x1b[1mG9 long-work live test (3.4)\x1b[0m — page ${FIXTURE}, job ${JOB_S} s, out ${OUT}`);
  const mcp = new StdioMcp('longwork-e2e');
  await mcp.init();
  const status = await mcp.call('browser_status', {});
  check(status.ok && status.data?.capabilities?.extension === true, 'the extension engine is connected', `daemon v${status.data?.daemon?.version}`);

  // A launched engine started and given a moment first: in one run the first tab of a browser launched
  // at that very moment, on a loaded machine, answered nothing for ~15 s (the watchdog recovered it, as
  // designed). The checks below are about the features, not about a cold start.
  const launched = await mcp.call('browser_engine', { action: 'launch' }, 240_000);
  check(launched.ok, 'a launched engine is running', launched.data?.engineId ?? launched.text.slice(0, 160));
  const warm = await mcp.call('browser_tabs', { action: 'open', url: FIXTURE, engine: 'launched' }, 240_000);
  await mcp.call('browser_navigate', { action: 'wait', tabId: warm.data?.tabId, predicate: '!!window.renderVideo', timeoutMs: 30_000 });
  await mcp.call('browser_tabs', { action: 'close', tabId: warm.data?.tabId });

  // The long jobs first, on tabs of their own, so they run while everything else is checked.
  const jobs = {};
  for (const engine of ['extension', 'launched']) {
    const t = await mcp.call('browser_tabs', { action: 'open', url: FIXTURE, engine, focus: engine === 'extension', keepAwake: true }, 240_000);
    check(t.ok && t.data?.awake?.keepAwake === true, `${engine}: a tab kept awake for the job`, JSON.stringify(t.data?.awake ?? t.text).slice(0, 160));
    await mcp.call('browser_navigate', { action: 'wait', tabId: t.data?.tabId, predicate: '!!window.renderVideo', timeoutMs: 20_000 });
    jobs[engine] = await startJob(mcp, engine, t.data?.tabId);
  }

  for (const engine of ['extension', 'launched']) {
    try {
      await engineSuite(mcp, engine, { job: jobs[engine] });
    } catch (err) {
      bad(`${engine}: the suite threw`, err.stack);
    }
  }

  // ----------------------------------------------------------- MCP over HTTP: stateless sessions
  console.log('\n\x1b[1mMCP over HTTP: a stateless client\x1b[0m');
  const ep = await startHttpEndpoint();
  try {
    const s1 = await new HttpSession(ep, 'panel-gate').init();
    const o = await s1.call('browser_tabs', { action: 'open', url: FIXTURE, engine: 'extension', session: 'n-bs' });
    check(o.ok && o.data?.session === 'n-bs', 'session 1 opens a tab named n-bs', `tab ${o.data?.tabId}`);
    await s1.call('browser_console', { action: 'evaluate', session: 'n-bs', expression: "document.title = 'claimed by session 1'" });
    // The very next request comes from a FRESH MCP session of the same client (a panel gate).
    const s2 = await new HttpSession(ep, 'panel-gate').init();
    const snap = await s2.call('browser_snapshot', { session: 'n-bs', interactiveOnly: true });
    check(snap.ok, 'a fresh session finds the session name', `${snap.ms} ms`);
    const act = await s2.call('browser_console', { action: 'evaluate', session: 'n-bs', expression: "document.title = 'session 2 acts'; document.title" });
    check(act.ok && act.data?.value === 'session 2 acts', 'and may act on it: the tab passed to it, not "owned by agent-N"', act.text.slice(0, 120));
    const st = await s2.call('browser_status', {});
    const mine = st.data?.owned ?? [];
    report.http.statusOwned = mine;
    check(mine.includes(o.data?.tabId) && st.data?.you?.current === o.data?.tabId, 'its status shows the tab owned and current', `owned ${JSON.stringify(mine)}, current ${st.data?.you?.current}`);
    const stranger = await new HttpSession(ep, 'another-client').init();
    const refused = await stranger.call('browser_console', { action: 'evaluate', session: 'n-bs', expression: '1' });
    check(!refused.ok && /owned by/.test(refused.text), 'another client is still refused (ownership holds)', refused.text.slice(0, 100));
    // A job started by one session is read by another after the first has ended.
    const j = await s2.call('browser_console', { action: 'evaluate', session: 'n-bs', job: true, expression: "new Promise((r) => { __g9job.progress(0.5, 'half'); setTimeout(() => r({ ok: 1 }), 4000); })" });
    await s2.end();
    const s3 = await new HttpSession(ep, 'panel-gate').init();
    const jEnd = await s3.call('browser_console', { action: 'job_status', session: 'n-bs', jobId: j.data?.jobId, waitMs: 20_000 });
    check(jEnd.ok && jEnd.data?.state === 'done' && jEnd.data?.value?.ok === 1, 'a job outlives the session that started it', `${jEnd.data?.state} after ${jEnd.data?.elapsedMs} ms`);
    await s3.call('browser_tabs', { action: 'close', session: 'n-bs' });
    await stranger.end();
    await s3.end();
    await s1.end();
  } finally {
    ep.child.kill();
  }

  // ----------------------------------------------------------- the jobs' end
  console.log(`\n\x1b[1mEvaluate jobs of ${JOB_S} s\x1b[0m`);
  for (const engine of ['extension', 'launched']) {
    const job = jobs[engine];
    if (!job?.jobId) { bad(`${engine}: no job to wait for`); continue; }
    let end = null;
    for (let i = 0; i < 8; i++) {
      end = await mcp.call('browser_console', { action: 'job_status', jobId: job.jobId, tabId: job.tabId, waitMs: 60_000 }, 120_000);
      if (end.data?.state !== 'running') break;
      job.samples.push({ atS: Math.round((Date.now() - job.startedAt) / 1000), state: end.data.state, progress: end.data.progress, note: end.data.note });
    }
    const progressSeen = job.samples.filter((s) => s.state === 'running' && s.progress > 0 && s.progress < 1);
    report.engines[engine].job = { state: end?.data?.state, elapsedMs: end?.data?.elapsedMs, value: end?.data?.value, samples: job.samples };
    check(end?.data?.state === 'done' && end.data.value?.seconds === JOB_S && end.data.elapsedMs >= JOB_S * 1000,
      `${engine}: the ${JOB_S}-second job finished with its value`, `${Math.round((end?.data?.elapsedMs ?? 0) / 1000)} s, ${JSON.stringify(end?.data?.value)}`);
    check(progressSeen.length >= 2, `${engine}: its progress was readable while it ran`, progressSeen.map((s) => `${s.atS}s→${Math.round(s.progress * 100)}%`).join(', '));
    await mcp.call('browser_tabs', { action: 'close', tabId: job.tabId });
  }

  mcp.close();
  report.passed = passed;
  report.failed = failed;
  if (process.env.G9_LONGWORK_REPORT) fs.writeFileSync(process.env.G9_LONGWORK_REPORT, JSON.stringify(report, null, 2));
  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(JSON.stringify(report.engines.extension?.snapshotBytes ?? {}));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
