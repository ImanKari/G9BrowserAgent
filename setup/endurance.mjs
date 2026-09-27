#!/usr/bin/env node
/**
 * P8 endurance — the flow in a loop on launched-engine contexts, memory sampled on a fixed clock.
 *
 *   node setup/endurance.mjs --minutes 10 [--contexts 2] [--spa-contexts 1] [--sample-s 30] [--no-watch] [--no-gc]
 *                            [--out <file.json>] [--keep]
 *
 * Product path, as in setup/bench.mjs: a private daemon started by the first MCP shim (temp
 * G9_HOME, random port 18000-18999), one headless Edge (Engine 2), one browser context and one
 * shim per simulated agent, all input humanized. Each agent loops the bench flow (goto → snapshot →
 * type → type → click → wait → select → wheel → screenshot) until the time is up.
 *
 * Measured every --sample-s seconds (PowerShell Get-CimInstance Win32_Process over the daemon's
 * process tree): the daemon's private bytes, working set and OS handle count; the browser tree's
 * private bytes, working set and process count; the number of processes the daemon has as
 * children besides the browser (short-lived helpers must not pile up).
 *
 * Per iteration, from the page's own renderer (browser_diagnose what:"memory", Performance
 * metrics): JS event listeners right after the page loaded and again after every interaction of
 * the flow ran. Each interaction arms a witness listener in G9BrowserAgent's isolated world; if witnesses
 * were not released, that difference would grow with every action.
 *
 * Round 3: the listener count is a count of live listener OBJECTS, so garbage not yet collected
 * made it noisy (round 2, run 1: first third -3.8, last third +14.1; run 2: none). The engine is
 * now launched with --js-flags=--expose-gc (--no-gc turns it off) and every reading is taken right
 * after gc() in the page, so the numbers are exact. And the LAST --spa-contexts contexts (default
 * 1) run the flow as a single-page app: one document for the whole run, no navigation, fields
 * cleared before typing — a listener G9BrowserAgent leaves behind there is never thrown away with a document,
 * so the count after each pass must stay flat. (The goto flow alone cannot show a per-document
 * leak: the next goto discards it, and the per-flow delta stays constant.)
 *
 * With the live watch (default on): the desktop's view of context 0 — a UI client watching its tab —
 * so the screencast spool into G9_HOME/runs/<watch run>/frames is exercised for the whole run, with
 * settings.evidence.maxFrames lowered to 300: the spool must stop at the cap, not grow with time.
 *
 * Assertions (the run fails, exit 1, if any is broken):
 *   - daemon private-bytes slope after the first 2 minutes ≤ 1 MB/min, browser ≤ 3 MB/min
 *     (least squares over the samples; the slopes are printed either way);
 *   - daemon handle-count slope ≤ 5 handles/min;
 *   - browser process count never above its first loaded sample + 2;
 *   - no leftover helper processes under the daemon at the end;
 *   - per-iteration listener delta does not trend upward (last third mean ≤ first third mean + 5);
 *   - single-page-app contexts: listeners after each pass (after gc) do not grow — last third mean
 *     ≤ first third mean + 5 and least-squares slope ≤ 0.5 listener per pass; DOM nodes: slope
 *     ≤ 2.5 per pass. Not flat, measured (round 3, scratch probe on Edge 153): every edit that
 *     REPLACES a field's text — G9BrowserAgent's clear, or the page's own execCommand select+delete+insert
 *     with no G9BrowserAgent input at all — keeps exactly one text node alive after gc() (the browser's undo
 *     history, bounded by its depth); setting .value keeps none; snapshot, screenshot, click,
 *     select, wheel and wait keep none. Two cleared fields per pass → 2 nodes per pass is the
 *     browser, anything above 2.5 is something else;
 *   - the watch run's frames on disk ≤ maxFrames;
 *   - after the watch ends, the daemon's /health lists no open run, and still exactly the agents
 *     this file connected;
 *   - after shutdown: no process with this run's root in its command line, root removed.
 *
 * Also recorded (not asserted): G9_HOME size at start and end, and per sample which kind of browser
 * process (browser, gpu-process, renderer, utility/…) holds the memory, with the three largest.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  SETUP, freePort, makeRoot, log, delay, startServe, startDaemon, callTool, cleanupRoot, startSampler, categorize, cpuSeries,
  summarize, slope, MB, runFlow, refsFrom, startGuard, guardedLaunch, homeProfilesSignIn,
} from './bench.mjs';
import { VERSION } from '../lib/version.mjs';

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

const BROWSER_NAMES = /^(msedge|chrome|identity_helper|msedge_crashpad_handler|chrome_crashpad_handler)\.exe$/i;

async function listenersOf(agent, tabId, { gc = false } = {}) {
  let collected = null;
  if (gc) {
    // Main world, with --js-flags=--expose-gc: a full collection of the renderer's isolate (both
    // worlds share it), twice so weak callbacks run, then the counters are read.
    const g = await callTool(agent, 'browser_console', { action: 'evaluate', expression: "typeof gc === 'function' ? (gc(), gc(), true) : false", tabId }, 30_000);
    collected = g.ok ? g.json?.value === true : false;
  }
  const r = await callTool(agent, 'browser_diagnose', { what: 'memory', samples: 2, intervalMs: 100, tabId }, 60_000);
  if (!r.ok) return null;
  const last = r.json?.samples?.at(-1) ?? null;
  return last ? { listeners: last.listeners, nodes: last.nodes, documents: last.documents, heap: last.jsHeapUsedBytes, collected } : null;
}

/** Bytes and files under a directory tree (G9_HOME: runs, evidence, logs must not grow without bound). */
async function treeSize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = async (d) => {
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else { files += 1; bytes += (await fsp.stat(full).catch(() => ({ size: 0 }))).size; }
    }
  };
  await walk(dir);
  return { files, bytes };
}

async function countFiles(dir) {
  try {
    const names = await fsp.readdir(dir);
    let bytes = 0;
    for (const n of names) bytes += (await fsp.stat(path.join(dir, n)).catch(() => ({ size: 0 }))).size;
    return { files: names.length, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

async function main() {
  process.on('uncaughtException', (err) => log(`uncaught (kept running): ${err?.stack ?? err}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection (kept running): ${err?.stack ?? err}`));
  const args = parseArgs(process.argv.slice(2));
  const minutes = Number(args.minutes ?? 10);
  const contexts = Number(args.contexts ?? 2);
  const sampleMs = Number(args['sample-s'] ?? 30) * 1000;
  const watch = !args['no-watch'];
  const maxFrames = Number(args['max-frames'] ?? 300);
  const useGc = !args['no-gc'];
  const spaContexts = Math.max(0, Math.min(Number(args['spa-contexts'] ?? 1), Number(args.contexts ?? 2)));
  if (!(minutes > 0)) throw new Error('--minutes must be a positive number');
  const root = await makeRoot('endure');
  const report = {
    date: new Date().toISOString(), g9: VERSION, node: process.version, os: `${os.type()} ${os.release()}`,
    minutes, contexts, spaContexts, gc: useGc, sampleSeconds: sampleMs / 1000, watch, maxFrames,
    testpageSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(SETUP, 'testpage.html'))).digest('hex').slice(0, 16),
  };
  log(`P8 endurance — ${minutes} min, ${contexts} contexts, sample every ${sampleMs / 1000} s, watch ${watch}, root ${root}`);
  let serve = null;
  let guard = null;
  let daemon = null;
  let sampler = null;
  let ui = null;
  let exitCode = 0;
  const problems = [];
  try {
    serve = await startServe(await freePort());
    // Nothing leaves the machine: a fresh Edge profile signs into the Windows user's Microsoft
    // account and turns sync on by itself (measured; bench.mjs startGuard).
    guard = await startGuard([serve.port]);
    daemon = await startDaemon({
      root,
      settings: { humanize: 'human', stealth: 'off', headless: true, idleExitMinutes: 0, maxParallel: 8, evidence: { maxFrames, maxBytes: 300 * 1024 * 1024, keepRuns: 200, quality: 60, maxWidth: 1280, maxHeight: 800 } },
      name: 'p8-endure-a0',
    });
    log(`daemon ${daemon.pid} on ${daemon.port}, home ${daemon.home}`);
    report.homeAtStart = await treeSize(daemon.home);
    sampler = await startSampler({ dir: path.join(root, 'sampler'), roots: [daemon.pid], intervalMs: sampleMs });
    const launch = await callTool(daemon.first, 'browser_engine', { action: 'launch', browser: 'edge', headless: true, humanize: 'human', stealth: 'off', ...(useGc ? { extraArgs: ['--js-flags=--expose-gc'] } : {}), ...guardedLaunch(guard) });
    if (!launch.ok) throw new Error(`launch failed: ${launch.error}`);
    report.browser = { kind: launch.json.browser, version: launch.json.version, pid: launch.json.pid, launchWarnings: launch.json.warnings ?? [] };
    const engineId = launch.json.engineId;
    const agents = [daemon.first];
    for (let i = 1; i < contexts; i += 1) agents.push(await daemon.agent(`p8-endure-a${i}`));
    const tabs = [];
    for (const [i, agent] of agents.entries()) {
      const ctx = await callTool(agent, 'browser_engine', { action: 'context', engineId, humanize: 'human' });
      if (!ctx.ok) throw new Error(`context failed: ${ctx.error}`);
      const open = await callTool(agent, 'browser_tabs', { action: 'open', url: serve.url, engine: engineId, context: ctx.json.contextId });
      if (!open.ok) throw new Error(`open failed: ${open.error}`);
      tabs.push({ i, tabId: open.json.tabId, spa: i >= contexts - spaContexts });
    }
    let watchInfo = null;
    let framesSeen = 0;
    if (watch) {
      ui = await daemon.ui();
      ui.on('event', (topic, data) => { if (topic === 'frame' && data?.tabId === tabs[0].tabId) framesSeen += 1; });
      watchInfo = await ui.admin('watch', { tabId: tabs[0].tabId }, 20_000);
      log(`watching tab ${tabs[0].tabId} as run ${watchInfo?.runId}`);
    }

    report.healthAtStart = await daemon.health();
    const t0 = Date.now();
    const deadline = t0 + minutes * 60_000;
    const iterations = [];
    const stepMs = {};
    const failures = [];
    let stepCount = 0;
    const loops = tabs.map(async ({ i, tabId, spa }) => {
      const agent = agents[i];
      let k = 0;
      if (spa) {
        // The one document this context keeps for the whole run.
        await callTool(agent, 'browser_navigate', { action: 'goto', url: serve.url, waitUntil: 'load', tabId });
      }
      while (Date.now() < deadline) {
        const it = { agent: i, k, at: Date.now() - t0, spa };
        const f0 = performance.now();
        let loaded = null;
        const record = (name, res, problem) => {
          stepCount += 1;
          (stepMs[name] ??= []).push(res.ms);
          if (problem) failures.push({ agent: i, k, step: name, problem: String(problem).slice(0, 300), at: Date.now() - t0 });
        };
        // The flow, with a listener reading after the load and after the last interaction.
        const flow = await runFlow(agent, {
          tabId, url: serve.url, seed: `endure-${i}-${k}`,
          ...(spa ? { spa: true, selectValue: k % 2 ? 'prd' : 'stg', scrollDirection: k % 2 ? 'up' : 'down' } : {}),
          record: (name, res, problem) => {
            record(name, res, problem);
            if (name === 'snapshot') loaded = true;
          },
        });
        it.ok = flow.ok;
        it.ms = Math.round(performance.now() - f0);
        if (spa) {
          // Same document every pass: the count after the pass is the whole story.
          const now = await listenersOf(agent, tabId, { gc: useGc });
          if (now) { it.spaListeners = now.listeners; it.spaNodes = now.nodes; it.spaDocuments = now.documents; it.spaHeap = now.heap; it.gcCollected = now.collected; }
          iterations.push(it);
          k += 1;
          continue;
        }
        // Listener delta for this document: reload-free reading at the end vs. a fresh load now.
        const end = await listenersOf(agent, tabId, { gc: useGc });
        const nav = await callTool(agent, 'browser_navigate', { action: 'goto', url: serve.url, waitUntil: 'load', tabId });
        const fresh = nav.ok ? await listenersOf(agent, tabId, { gc: useGc }) : null;
        if (end && fresh) {
          it.gcCollected = end.collected;
          it.listenersAfterFlow = end.listeners;
          it.listenersFresh = fresh.listeners;
          it.listenersDelta = end.listeners - fresh.listeners;
          it.documentsAfterFlow = end.documents;
          it.nodesAfterFlow = end.nodes;
        }
        void loaded;
        iterations.push(it);
        k += 1;
      }
    });

    // Progress line every sample.
    const off = sampler.onSample((s) => {
      const c = categorize(s, (p) => (p.pid === daemon.pid ? 'daemon' : BROWSER_NAMES.test(p.name) ? 'browser' : 'other'));
      log(`  t+${Math.round((s.t - t0) / 1000)} s: daemon ${MB(c.daemon?.priv ?? 0)} MB priv / ${c.daemon?.handles ?? 0} handles; ` +
        `browser ${MB(c.browser?.priv ?? 0)} MB priv in ${c.browser?.procs ?? 0} procs; other children ${c.other?.procs ?? 0}; ` +
        `iterations ${iterations.length}, failures ${failures.length}${watch ? `, frames seen ${framesSeen}` : ''}`);
    });
    await Promise.all(loops);
    report.loopMs = Date.now() - t0;
    const endSample = await sampler.next();
    off();

    // After the load: stop watching, let the daemon settle, take the idle reading.
    let spool = null;
    if (watch) {
      const un = await ui.admin('unwatch', { tabId: tabs[0].tabId }, 20_000).catch((e) => ({ error: e.message }));
      const runDir = watchInfo?.runId ? path.join(daemon.home, 'runs', watchInfo.runId) : null;
      await delay(1500);
      const frames = runDir ? await countFiles(path.join(runDir, 'frames')) : null;
      let result = null;
      try { result = JSON.parse(await fsp.readFile(path.join(runDir, 'result.json'), 'utf8')); } catch { /* none */ }
      let jsonlLines = null;
      try { jsonlLines = (await fsp.readFile(path.join(runDir, 'frames.jsonl'), 'utf8')).split('\n').filter(Boolean).length; } catch { /* none */ }
      spool = { runId: watchInfo?.runId, framesSeenByUi: framesSeen, framesOnDisk: frames?.files ?? null, bytesOnDisk: frames?.bytes ?? null, framesJsonl: jsonlLines, result, unwatch: un };
      if (frames && frames.files > maxFrames) problems.push(`spool not bounded: ${frames.files} frames on disk > maxFrames ${maxFrames}`);
    }
    report.spool = spool;
    report.homeAtEnd = await treeSize(daemon.home);
    for (const { tabId, i } of tabs) await callTool(agents[i], 'browser_tabs', { action: 'close', tabId }).catch(() => {});
    await delay(sampleMs);
    const idleSample = await sampler.next();
    // The daemon's own accounting after the load: every run it opened (the live watch) must be
    // closed again, and the agents are still the ones this file connected.
    report.healthAfter = await daemon.health();

    // ── analysis
    const cls = (p) => (p.pid === daemon.pid ? 'daemon' : BROWSER_NAMES.test(p.name) ? 'browser' : 'other');
    const series = sampler.samples.filter((s) => s.t >= t0 && s.t <= (endSample?.t ?? Date.now())).map((s) => {
      const c = categorize(s, cls);
      return {
        min: (s.t - t0) / 60_000,
        daemonPriv: c.daemon?.priv ?? 0, daemonWs: c.daemon?.ws ?? 0, daemonHandles: c.daemon?.handles ?? 0,
        browserPriv: c.browser?.priv ?? 0, browserWs: c.browser?.ws ?? 0, browserProcs: c.browser?.procs ?? 0,
        other: c.other?.procs ?? 0, otherNames: (s.procs ?? []).filter((p) => cls(p) === 'other').map((p) => p.name),
        // Which KIND of browser process holds the memory (the sampler reads --type once per process).
        byType: (s.procs ?? []).filter((p) => cls(p) === 'browser').reduce((acc, p) => { const t = p.type || '?'; acc[t] = (acc[t] ?? 0) + p.priv; return acc; }, {}),
        top: (s.procs ?? []).filter((p) => cls(p) === 'browser').sort((a, b) => b.priv - a.priv).slice(0, 3).map((p) => ({ pid: p.pid, type: p.type || '?', privMB: MB(p.priv) })),
      };
    });
    const warm = series.filter((p) => p.min >= Math.min(2, minutes / 3));
    const slopeOf = (key, div = 1024 * 1024) => {
      const v = slope(warm.map((p) => [p.min, p[key] / div]));
      return v == null ? null : Math.round(v * 100) / 100;
    };
    report.series = series.map((p) => ({ min: Math.round(p.min * 100) / 100, daemonPrivMB: MB(p.daemonPriv), daemonWsMB: MB(p.daemonWs), daemonHandles: p.daemonHandles,
      browserPrivMB: MB(p.browserPriv), browserWsMB: MB(p.browserWs), browserProcs: p.browserProcs, otherChildren: p.other,
      browserByTypeMB: Object.fromEntries(Object.entries(p.byType).map(([t, v]) => [t, MB(v)])), top: p.top }));
    report.slopes = {
      daemonPrivMBperMin: slopeOf('daemonPriv'), daemonWsMBperMin: slopeOf('daemonWs'), daemonHandlesPerMin: slopeOf('daemonHandles', 1),
      browserPrivMBperMin: slopeOf('browserPriv'), browserWsMBperMin: slopeOf('browserWs'), browserProcsPerMin: slopeOf('browserProcs', 1),
      fromMinute: Math.min(2, minutes / 3), points: warm.length,
    };
    const cpu = cpuSeries(sampler.samples.filter((s) => s.t >= t0 && s.t <= (endSample?.t ?? Date.now())), cls);
    report.cpuCoresMean = {
      daemon: Math.round((cpu.reduce((a, c) => a + (c.cores.daemon ?? 0), 0) / Math.max(1, cpu.length)) * 100) / 100,
      browser: Math.round((cpu.reduce((a, c) => a + (c.cores.browser ?? 0), 0) / Math.max(1, cpu.length)) * 100) / 100,
    };
    const idle = idleSample ? categorize(idleSample, cls) : null;
    report.afterIdle = idle ? { daemonPrivMB: MB(idle.daemon?.priv ?? 0), daemonHandles: idle.daemon?.handles ?? 0, browserPrivMB: MB(idle.browser?.priv ?? 0), browserProcs: idle.browser?.procs ?? 0, otherChildren: idle.other?.procs ?? 0 } : null;
    report.iterations = iterations.length;
    report.iterationMs = summarize(iterations.map((i) => i.ms));
    report.failures = failures;
    report.steps_total = stepCount;
    report.failureRate = stepCount ? Math.round((failures.length / stepCount) * 10000) / 100 : null;
    report.steps = Object.fromEntries(Object.entries(stepMs).map(([k, v]) => [k, summarize(v)]));
    const deltas = iterations.filter((i) => Number.isFinite(i.listenersDelta));
    const third = Math.max(1, Math.floor(deltas.length / 3));
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    report.listeners = {
      samples: deltas.length,
      deltaFirstThirdMean: mean(deltas.slice(0, third).map((i) => i.listenersDelta)),
      deltaLastThirdMean: mean(deltas.slice(-third).map((i) => i.listenersDelta)),
      afterFlowFirst: deltas[0]?.listenersAfterFlow ?? null,
      afterFlowLast: deltas.at(-1)?.listenersAfterFlow ?? null,
      freshFirst: deltas[0]?.listenersFresh ?? null,
      freshLast: deltas.at(-1)?.listenersFresh ?? null,
      documentsAfterFlowMax: Math.max(0, ...deltas.map((i) => i.documentsAfterFlow ?? 0)),
      deltaMin: deltas.length ? Math.min(...deltas.map((i) => i.listenersDelta)) : null,
      deltaMax: deltas.length ? Math.max(...deltas.map((i) => i.listenersDelta)) : null,
      gcCollected: deltas.length ? deltas.every((i) => i.gcCollected === true) : null,
    };
    const spaIts = iterations.filter((i) => i.spa && Number.isFinite(i.spaListeners));
    const spaThird = Math.max(1, Math.floor(spaIts.length / 3));
    report.spa = {
      passes: spaIts.length,
      listenersFirst: spaIts[0]?.spaListeners ?? null,
      listenersLast: spaIts.at(-1)?.spaListeners ?? null,
      listenersMin: spaIts.length ? Math.min(...spaIts.map((i) => i.spaListeners)) : null,
      listenersMax: spaIts.length ? Math.max(...spaIts.map((i) => i.spaListeners)) : null,
      listenersFirstThirdMean: mean(spaIts.slice(0, spaThird).map((i) => i.spaListeners)),
      listenersLastThirdMean: mean(spaIts.slice(-spaThird).map((i) => i.spaListeners)),
      listenersSlopePerPass: (() => { const v = slope(spaIts.map((i, n) => [n, i.spaListeners])); return v == null ? null : Math.round(v * 1000) / 1000; })(),
      nodesFirst: spaIts[0]?.spaNodes ?? null,
      nodesLast: spaIts.at(-1)?.spaNodes ?? null,
      nodesSlopePerPass: (() => { const v = slope(spaIts.map((i, n) => [n, i.spaNodes])); return v == null ? null : Math.round(v * 1000) / 1000; })(),
      nodesFirstThirdMean: mean(spaIts.slice(0, spaThird).map((i) => i.spaNodes)),
      nodesLastThirdMean: mean(spaIts.slice(-spaThird).map((i) => i.spaNodes)),
      heapFirstMB: spaIts[0]?.spaHeap != null ? MB(spaIts[0].spaHeap) : null,
      heapLastMB: spaIts.at(-1)?.spaHeap != null ? MB(spaIts.at(-1).spaHeap) : null,
      documentsMax: Math.max(0, ...spaIts.map((i) => i.spaDocuments ?? 0)),
      gcCollected: spaIts.length ? spaIts.every((i) => i.gcCollected === true) : null,
      series: spaIts.map((i) => [i.spaListeners, i.spaNodes]),
    };

    // ── assertions
    const s = report.slopes;
    if (s.daemonPrivMBperMin != null && s.daemonPrivMBperMin > 1) problems.push(`daemon private bytes grow ${s.daemonPrivMBperMin} MB/min (> 1)`);
    if (s.browserPrivMBperMin != null && s.browserPrivMBperMin > 3) problems.push(`browser private bytes grow ${s.browserPrivMBperMin} MB/min (> 3)`);
    if (s.daemonHandlesPerMin != null && s.daemonHandlesPerMin > 5) problems.push(`daemon handle count grows ${s.daemonHandlesPerMin}/min (> 5)`);
    const firstProcs = warm[0]?.browserProcs ?? series[0]?.browserProcs ?? 0;
    const maxProcs = Math.max(0, ...series.map((p) => p.browserProcs));
    if (maxProcs > firstProcs + 2) problems.push(`browser process count rose from ${firstProcs} to ${maxProcs}`);
    if ((report.afterIdle?.otherChildren ?? 0) > 0) problems.push(`${report.afterIdle.otherChildren} helper process(es) still under the daemon after the run`);
    if (report.listeners.samples >= 6 && report.listeners.deltaLastThirdMean > report.listeners.deltaFirstThirdMean + 5) {
      problems.push(`listener delta per flow trends up: first third ${report.listeners.deltaFirstThirdMean}, last third ${report.listeners.deltaLastThirdMean}`);
    }
    if (failures.length) problems.push(`${failures.length} failed step(s) in ${iterations.length} iterations`);
    const sp = report.spa;
    if (sp.passes >= 6) {
      if (sp.listenersLastThirdMean > sp.listenersFirstThirdMean + 5) problems.push(`single-page app: listeners grow pass after pass: first third ${sp.listenersFirstThirdMean}, last third ${sp.listenersLastThirdMean} (${sp.listenersFirst} → ${sp.listenersLast})`);
      if (sp.listenersSlopePerPass != null && sp.listenersSlopePerPass > 0.5) problems.push(`single-page app: listener slope ${sp.listenersSlopePerPass} per pass (> 0.5)`);
      if (sp.nodesSlopePerPass != null && sp.nodesSlopePerPass > 2.5) problems.push(`single-page app: DOM nodes grow ${sp.nodesSlopePerPass} per pass (> 2.5, the undo history of the 2 cleared fields): first third ${sp.nodesFirstThirdMean}, last third ${sp.nodesLastThirdMean}`);
    }
    if (useGc && (report.listeners.gcCollected === false || sp.gcCollected === false)) problems.push('gc() was not available in the page although the engine was launched with --js-flags=--expose-gc: the listener numbers include uncollected garbage');
    const ha = report.healthAfter;
    const openRuns = Array.isArray(ha?.activeRuns) ? ha.activeRuns.length : Number(ha?.activeRuns ?? 0);
    if (openRuns > 0) problems.push(`daemon still reports active runs after unwatch: ${JSON.stringify(ha.activeRuns)}`);
    if (ha && ha.agents !== contexts) problems.push(`daemon reports ${ha.agents} agents after the run, expected ${contexts}`);
    report.problems = problems;
    if (problems.length) exitCode = 1;

    console.log('\nminute | daemon priv MB | daemon handles | browser priv MB | browser procs | other children');
    for (const p of report.series) console.log(`${p.min} | ${p.daemonPrivMB} | ${p.daemonHandles} | ${p.browserPrivMB} | ${p.browserProcs} | ${p.otherChildren}`);
    console.log('\nslopes (after warm-up):', JSON.stringify(report.slopes));
    console.log('iterations:', report.iterations, 'iteration ms:', JSON.stringify(report.iterationMs), 'failures:', failures.length);
    console.log('listeners:', JSON.stringify(report.listeners));
    console.log('single-page app:', JSON.stringify({ ...report.spa, series: undefined }));
    console.log('spool:', JSON.stringify(report.spool && { ...report.spool, result: report.spool.result ? Object.keys(report.spool.result) : null }));
    console.log('after idle:', JSON.stringify(report.afterIdle));
    console.log(problems.length ? `\nPROBLEMS:\n- ${problems.join('\n- ')}` : '\nall endurance assertions hold');
  } catch (err) {
    exitCode = 2;
    report.error = String(err?.stack ?? err);
    console.error('ENDURANCE ERROR', err);
  } finally {
    try { ui?.close(); } catch { /* gone */ }
    await sampler?.stop();
    if (daemon) report.daemonStopped = await daemon.stop();
    if (daemon) report.profiles = homeProfilesSignIn(daemon.home);
    if (guard) { report.guard = { blocked: guard.hits.filter((h) => !h.ok).length, allowed: guard.hits.filter((h) => h.ok).length, attempts8765: guard.attempts8765() }; await guard.close(); }
    await serve?.stop();
    if (!args.keep) report.cleanup = await cleanupRoot(root, { pids: [serve?.pid, daemon?.pid].filter(Boolean) });
    if (report.cleanup?.leftovers?.length) { exitCode = exitCode || 1; }
    const out = args.out ? path.resolve(String(args.out)) : null;
    if (out) await fsp.writeFile(out, JSON.stringify(report, null, 2));
    log(`cleanup: ${JSON.stringify(report.cleanup ?? 'kept')}`);
  }
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
