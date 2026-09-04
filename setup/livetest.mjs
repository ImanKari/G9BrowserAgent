#!/usr/bin/env node
/**
 * LIVE test — requires a real browser with the extension attached to a tab.
 *
 * Unlike selftest.mjs (which fakes the extension and proves only the plumbing),
 * this drives real CDP against a real page. It acts as the MCP client itself,
 * so it works without configuring any agent.
 *
 *   1. node setup/serve.mjs          -> http://127.0.0.1:5199/
 *   2. open that page, click the G9 icon, press "Attach & Pin current tab"
 *   3. node setup/livetest.mjs
 *
 * It expects setup/testpage.html, which carries six deliberate defects, and
 * checks that the agent-facing tools actually surface them.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'bridge', 'src', 'server.js');
const PORT = Number(process.env.G9_PORT ?? 8765);
const WAIT_FOR_EXTENSION_MS = 25_000;

let passed = 0;
let failed = 0;
let skipped = 0;

const ok = (n, d = '') => { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${n}${d ? ` \x1b[90m${d}\x1b[0m` : ''}`); };
const bad = (n, d = '') => { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${n}${d ? ` \x1b[90m${d}\x1b[0m` : ''}`); };
const skip = (n, d = '') => { skipped++; console.log(`  \x1b[33mSKIP\x1b[0m ${n}${d ? ` \x1b[90m${d}\x1b[0m` : ''}`); };
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- MCP client

class Mcp {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.id = 1;
    this.buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      this.buf += c;
      let i;
      while ((i = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          const e = this.pending.get(m.id);
          if (e) { this.pending.delete(m.id); e(m); }
        } catch { /* non-JSON on stdout is caught by selftest */ }
      }
    });
  }

  request(method, params = {}, timeoutMs = 70_000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** Call a tool and return its parsed JSON payload (or throw with the error text). */
  async call(name, args = {}) {
    const res = await this.request('tools/call', { name, arguments: args });
    const content = res.result?.content ?? [];
    const text = content.find((c) => c.type === 'text')?.text ?? '';
    if (res.result?.isError) throw new Error(text);
    const image = content.find((c) => c.type === 'image');
    // Attach the image non-enumerably so it never shows up when a test prints
    // Object.keys() of a result — it is harness metadata, not tool output.
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
    Object.defineProperty(parsed, '__image', { value: image, enumerable: false });
    return parsed;
  }
}

// ------------------------------------------------------------------- run

console.log('\n\x1b[1mG9 Browser Agent — LIVE test\x1b[0m');
console.log(`\x1b[90mport ${PORT} · needs the extension attached to a tab\x1b[0m`);

/**
 * This test must run its OWN bridge, because it speaks MCP over that process's
 * stdio — it cannot attach to a bridge someone else started. If the port is
 * already taken, say so plainly rather than letting the child die with
 * EADDRINUSE and surfacing later as a confusing handshake timeout.
 */
try {
  const probe = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
  if (probe.ok) {
    console.log(`\n\x1b[31mPort ${PORT} is already in use by another bridge.\x1b[0m`);
    console.log('This test needs its own bridge so it can speak MCP over stdio.');
    console.log('Stop the other one first:');
    console.log('  \x1b[90m- started in a terminal? press Ctrl+C there\x1b[0m');
    console.log('  \x1b[90m- launched by your MCP client? close the client\x1b[0m\n');
    process.exit(1);
  }
} catch {
  // Nothing listening, which is exactly what we want.
}

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, G9_PORT: String(PORT) },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const events = [];
let stabilityStartAt = 0;
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => {
  for (const l of d.trim().split('\n')) {
    if (l) events.push({ at: Date.now(), line: l.trim() });
  }
});

const mcp = new Mcp(child);
await sleep(600);

try {
  // -- connection ----------------------------------------------------------
  head('1. Bridge + extension');

  const init = await mcp.request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'g9-livetest', version: '1' },
  });
  if (init.result?.serverInfo?.name === 'g9-browser-agent') ok('MCP handshake');
  else { bad('MCP handshake', JSON.stringify(init).slice(0, 120)); throw new Error('cannot continue'); }
  mcp.notify('notifications/initialized');

  const deadline = Date.now() + WAIT_FOR_EXTENSION_MS;
  let connected = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if ((await r.json()).extensionConnected) { connected = true; break; }
    } catch { /* bridge still binding */ }
    await sleep(400);
  }

  if (connected) ok('extension connected', 'real browser on the other end');
  else {
    bad('extension never connected', `waited ${WAIT_FOR_EXTENSION_MS / 1000}s`);
    console.log('\n  Is the browser open with the G9 extension enabled?');
    console.log('  Check the side panel — it should say "Bridge connected".\n');
    throw new Error('no extension');
  }

  // -- orientation ---------------------------------------------------------
  head('2. browser_status');

  const status = await mcp.call('browser_status');
  ok('status returned', `mode=${status.mode}`);
  // Isolated setup may deliberately reload the extension while selecting its
  // private bridge port. Only transport loss after the first real tool call is
  // a session-stability failure.
  stabilityStartAt = Date.now();

  if (!status.attached) {
    console.log('\n  \x1b[33mNo tab is pinned.\x1b[0m Open a page, click the G9 icon,');
    console.log('  press "Attach & Pin current tab", then re-run this test.');
    console.log(`\n  Tabs the extension can see: ${status.otherTabs?.length ?? 0}`);
    for (const t of (status.otherTabs ?? []).slice(0, 8)) {
      console.log(`    \x1b[90m- ${(t.title ?? '').slice(0, 50)} — ${t.url?.slice(0, 60)}\x1b[0m`);
    }
    throw new Error('no tab attached');
  }

  ok('tab attached', `${status.attached.title} — ${status.attached.url}`);
  const onTestPage = /127\.0\.0\.1:5199|testpage\.html/.test(status.attached.url ?? '');
  console.log(`  \x1b[90mhealth: ${JSON.stringify(status.health)}\x1b[0m`);

  // Capture starts at attach. Reload before taking refs or diagnosing so every
  // seeded load-time console/network defect belongs to this run.
  if (onTestPage) {
    const reloaded = await mcp.call('browser_navigate', {
      action: 'reload', waitUntil: 'idle', timeoutMs: 15_000,
    });
    reloaded.readyState === 'complete'
      ? ok('test page reloaded after attach', 'load-time evidence is now captured')
      : bad('test page reload did not settle', JSON.stringify(reloaded));
  }

  // -- perception ----------------------------------------------------------
  head('3. browser_snapshot (accessibility tree + refs)');

  const snap = await mcp.call('browser_snapshot');
  if (snap.tree?.length) ok('snapshot returned a tree', `${snap.tree.split('\n').length} lines`);
  else bad('snapshot empty');

  if (snap.interactiveCount > 0) ok('interactive elements got refs', `${snap.interactiveCount} refs`);
  else bad('no refs assigned', 'interaction will be impossible');

  const refOf = (pattern) => {
    const line = snap.tree.split('\n').find((l) => pattern.test(l) && /\[ref=/.test(l));
    return line?.match(/\[ref=(e\d+)\]/)?.[1] ?? null;
  };
  console.log(`  \x1b[90m${snap.tree.split('\n').slice(0, 6).join('\n  ')}\x1b[0m`);

  // -- inspection ----------------------------------------------------------
  head('4. browser_inspect (DevTools panels)');

  const styles = await mcp.call('browser_inspect', { what: 'styles', selector: 'body' });
  if (styles.computed && Object.keys(styles.computed).length) {
    ok('computed styles', `${Object.keys(styles.computed).length} non-default properties`);
  } else bad('computed styles empty');

  const storage = await mcp.call('browser_inspect', { what: 'storage' });
  ok('storage readable', `keys: ${Object.keys(storage).join(', ')}`);

  const cookies = await mcp.call('browser_inspect', { what: 'cookies' });
  ok('cookies readable', `${cookies.count} cookie(s)`);

  // -- console -------------------------------------------------------------
  head('5. browser_console');

  const logs = await mcp.call('browser_console', { limit: 20 });
  ok('console buffer read', `${logs.total} entries, counts=${JSON.stringify(logs.counts)}`);

  const evald = await mcp.call('browser_console', {
    action: 'evaluate',
    expression: '({ title: document.title, url: location.href, forms: document.forms.length })',
  });
  if (evald.value?.title != null) ok('JavaScript evaluation', JSON.stringify(evald.value));
  else bad('evaluate failed', JSON.stringify(evald).slice(0, 120));

  // -- network -------------------------------------------------------------
  head('6. browser_network');

  const net = await mcp.call('browser_network', { limit: 10 });
  ok('network list', `${net.total} requests, ${net.failedCount} failed`);

  if (net.requests?.length) {
    const detail = await mcp.call('browser_network', { requestId: net.requests[0].requestId });
    if (detail.url) ok('request detail', `${detail.method} ${String(detail.url).slice(0, 60)} -> ${detail.status}`);
    else bad('request detail empty');
  } else skip('request detail', 'no requests captured yet — reload the page');

  const har = await mcp.call('browser_network', { format: 'har' });
  har.log?.version === '1.2' && har.entryCount === har.log.entries.length
    ? ok('HAR 1.2 export', har.entryCount + ' entries')
    : bad('HAR export invalid', JSON.stringify(har).slice(0, 120));

  // -- diagnosis -----------------------------------------------------------
  head('7. browser_diagnose (the correlated health report)');

  const health = await mcp.call('browser_diagnose');
  ok('diagnose ran', `${health.findings?.length ?? 0} findings`);
  console.log(`  \x1b[90msummary: ${JSON.stringify(health.summary)}\x1b[0m`);
  for (const f of (health.findings ?? []).slice(0, 8)) {
    console.log(`    \x1b[90m[${f.severity}] ${f.kind}: ${String(f.message).slice(0, 90)}\x1b[0m`);
  }

  const vitals = await mcp.call('browser_diagnose', { what: 'vitals', durationMs: 250 });
  vitals.coreWebVitals && vitals.longTasks
    ? ok('Core Web Vitals + long tasks', JSON.stringify(vitals.coreWebVitals))
    : bad('vitals diagnostics missing');
  const memory = await mcp.call('browser_diagnose', { what: 'memory', samples: 2, intervalMs: 50 });
  memory.samples?.length === 2
    ? ok('memory/leak sampling', JSON.stringify(memory.growth))
    : bad('memory diagnostics missing');

  if (onTestPage) {
    head('7b. Deliberate defects on the test page');
    const s = health.summary ?? {};
    const kinds = new Set((health.findings ?? []).map((f) => f.kind));
    const msgs = (health.findings ?? []).map((f) => String(f.message)).join(' | ');

    s.consoleErrors > 0 ? ok('console errors found', `${s.consoleErrors}`) : bad('console errors missed');
    s.failedRequests > 0 ? ok('failed request found', `${s.failedRequests}`) : bad('failed request missed');
    s.brokenImages > 0 ? ok('broken image found') : bad('broken image missed');
    s.formIssues > 0 ? ok('unlabelled form control found') : bad('form issue missed');
    s.overflowing ? ok('horizontal overflow found') : bad('overflow missed');
    /[Dd]uplicate/.test(msgs) ? ok('duplicate IDs found') : bad('duplicate IDs missed');
    kinds.has('a11y') ? ok('accessibility checks ran') : skip('a11y findings', 'none reported');
  } else {
    skip('deliberate-defect checks', 'not on the test page — run setup/serve.mjs and attach it');
  }

  // -- interaction ---------------------------------------------------------
  head('8. browser_interact (trusted input events)');

  if (onTestPage) {
    const userRef = refOf(/textbox|Username/i);
    const passRef = snap.tree.split('\n').filter((l) => /\[ref=/.test(l) && /textbox|password/i.test(l))[1]
      ?.match(/\[ref=(e\d+)\]/)?.[1] ?? null;
    const loginRef = refOf(/button.*Sign in/i);

    if (userRef && loginRef) {
      await mcp.call('browser_interact', { action: 'type', ref: userRef, text: 'admin', clear: true });
      ok('typed into username', `ref=${userRef}`);

      if (passRef) {
        await mcp.call('browser_interact', { action: 'type', ref: passRef, text: 'g9secret', clear: true });
        ok('typed into password', `ref=${passRef}`);
      } else skip('password field', 'no ref found (it is deliberately unlabelled)');

      await mcp.call('browser_interact', { action: 'click', ref: loginRef });
      ok('clicked Sign in', `ref=${loginRef}`);

      await sleep(400);
      const after = await mcp.call('browser_console', {
        action: 'evaluate',
        expression: 'document.getElementById("status")?.textContent',
      });
      if (/Signed in as admin/i.test(after.value ?? '')) {
        ok('LOGIN SUCCEEDED', 'trusted events accepted by the page');
      } else {
        bad('login did not complete', `status reads: ${after.value}`);
      }

      const envRef = refOf(/combobox.*Environment/i);
      if (envRef) {
        await mcp.call('browser_interact', { action: 'select', ref: envRef, values: 'Staging' });
        const selected = await mcp.call('browser_console', {
          action: 'evaluate',
          expression: '({ value: document.getElementById("env").value, trusted: window.__g9SelectTrusted })',
        });
        selected.value?.value === 'stg' && selected.value?.trusted === true
          ? ok('trusted select applied and verified', 'Staging · isTrusted=true')
          : bad('select was not a trusted verified interaction', JSON.stringify(selected.value));
      } else skip('trusted select', 'combobox ref not found');

      // Obstruction detection: this click must be refused.
      const coveredRef = refOf(/You cannot click me/i);
      if (coveredRef) {
        try {
          await mcp.call('browser_interact', { action: 'click', ref: coveredRef });
          bad('covered button was clicked', 'obstruction detection did not fire');
        } catch (err) {
          /covered by|not clickable/i.test(err.message)
            ? ok('obstruction detected', String(err.message).slice(0, 80))
            : bad('wrong error for covered button', String(err.message).slice(0, 80));
        }
      } else skip('obstruction test', 'covered button ref not found');
    } else {
      skip('login flow', `refs not found (user=${userRef}, login=${loginRef})`);
    }
  } else {
    // Safe, read-only interaction on an arbitrary page.
    try {
      await mcp.call('browser_interact', { action: 'scroll', direction: 'down', amount: 100 });
      ok('scroll dispatched');
      await mcp.call('browser_interact', { action: 'scroll', direction: 'up', amount: 100 });
    } catch (err) { bad('scroll failed', err.message.slice(0, 80)); }
    skip('login flow', 'not on the test page');
  }

  // -- recorder + assertions -----------------------------------------------
  if (onTestPage) {
    head('9. Recorder, assertions, run history, and export');
    await mcp.call('browser_recording', { action: 'start', name: 'G9 live assertion flow' });
    const liveSnap = await mcp.call('browser_snapshot');
    const envLine = liveSnap.tree.split('\n').find((line) => /combobox.*Environment/i.test(line) && /\[ref=/.test(line));
    const envRef = envLine?.match(/\[ref=(e\d+)\]/)?.[1];
    if (envRef) {
      await mcp.call('browser_interact', { action: 'select', ref: envRef, values: 'Production' });
    }
    const recorded = await mcp.call('browser_recording', { action: 'stop' });
    if (recorded.id && recorded.steps >= 2) ok('recording captured trusted select', recorded.steps + ' steps');
    else bad('recording did not capture select', JSON.stringify(recorded));

    await mcp.call('browser_recording', {
      action: 'update', id: recorded.id, suite: 'Live smoke', folder: 'setup',
      tags: ['live', 'regression'], environment: { name: 'local', variables: { expectedEnv: 'prd' } },
      parameters: { expectedTitle: 'G9 Agent Test Page' },
    });
    await mcp.call('browser_recording', { action: 'assert', id: recorded.id, assertion: 'url', contains: '127.0.0.1:5199', operator: 'contains' });
    await mcp.call('browser_recording', { action: 'assert', id: recorded.id, assertion: 'text', contains: '{{expectedTitle}}' });
    await mcp.call('browser_recording', {
      action: 'assert', id: recorded.id, assertion: 'visible', selector: '#hidden-assertion-target', expected: false,
    });
    if (envRef) {
      await mcp.call('browser_recording', { action: 'assert', id: recorded.id, assertion: 'value', ref: envRef, expected: '{{expectedEnv}}' });
    }
    await mcp.call('browser_recording', { action: 'assert', id: recorded.id, assertion: 'network', contains: '/api/missing', minCount: 1 });
    await mcp.call('browser_recording', { action: 'assert', id: recorded.id, assertion: 'console', contains: 'THIS_MESSAGE_MUST_NOT_EXIST', absent: true });
    await mcp.call('browser_recording', { action: 'assert', id: recorded.id, assertion: 'a11y', maxViolations: 1 });
    await mcp.call('browser_recording', { action: 'assert', id: recorded.id, assertion: 'screenshot', threshold: 0.12 });

    const run = await mcp.call('browser_recording', { action: 'replay', id: recorded.id, timing: 'fast' });
    run.failed === 0 && run.passed === run.total
      ? ok('assertion replay passed with observable checks', run.passed + '/' + run.total)
      : bad('assertion replay failed', JSON.stringify(run.steps?.find((step) => !step.ok)));
    const saved = await mcp.call('browser_recording', { action: 'get', id: recorded.id });
    saved.runHistory?.length === 1 && saved.suite === 'Live smoke'
      ? ok('run history + suite metadata persisted')
      : bad('run history or metadata missing');
    const exported = await mcp.call('browser_recording', { action: 'export_test', id: recorded.id });
    /@playwright\/test/.test(exported.code ?? '') && /toHaveScreenshot/.test(exported.code ?? '')
      ? ok('Playwright test export', exported.code.split('\n').length + ' lines')
      : bad('Playwright export missing expected code');
    await mcp.call('browser_recording', { action: 'delete', id: recorded.id });

    await mcp.call('browser_recording', { action: 'start', name: 'G9 deliberate failing assertion' });
    const failing = await mcp.call('browser_recording', { action: 'stop' });
    await mcp.call('browser_recording', {
      action: 'assert', id: failing.id, assertion: 'text', contains: 'TEXT_THAT_DOES_NOT_EXIST_9F8E',
    });
    const failedRun = await mcp.call('browser_recording', { action: 'replay', id: failing.id, timing: 'fast' });
    failedRun.failed === 1 && /assertion failed/i.test(failedRun.steps?.find((step) => !step.ok)?.error ?? '')
      ? ok('assertion failure path is explicit')
      : bad('failing assertion reported optimistic success', JSON.stringify(failedRun));
    await mcp.call('browser_recording', { action: 'delete', id: failing.id });
  }

  // -- v1.6.0: regression memory ------------------------------------------
  head('9b. Regression memory: aria baselines, known world, surprises, pinning');
  {
    // A flow with a semantic baseline rather than a pixel one, and a navigate step so that each
    // replay actually produces traffic and console output to compare. A flow that does nothing
    // gives the detector nothing to observe, which would make this section prove nothing.
    await mcp.call('browser_recording', { action: 'start', name: 'G9 live regression memory' });
    await mcp.call('browser_navigate', { action: 'reload' });
    const flow = await mcp.call('browser_recording', { action: 'stop' });
    await mcp.call('browser_recording', { action: 'assert', id: flow.id, assertion: 'aria' });

    const seeded = await mcp.call('browser_recording', {
      action: 'replay', id: flow.id, timing: 'fast', signature: 'full', seedKnownWorld: true,
    });
    seeded.failed === 0 && seeded.knownWorld?.runs === 1
      ? ok('aria baseline replays and seeds a known world', `verdict=${seeded.verdict}`)
      : bad('known world was not seeded', JSON.stringify({ failed: seeded.failed, kw: seeded.knownWorld }));

    // A second identical run must be quiet. If a signature is not normalised properly, THIS is
    // where it shows: the same page compared against itself starts inventing findings. It caught
    // a real one on 2026-09-04 — a request captured mid-flight on one run and completed on the
    // next produced a spurious pair, one "new" and one "missing".
    const quiet = await mcp.call('browser_recording', {
      action: 'replay', id: flow.id, timing: 'fast', signature: 'full',
    });
    const noisy = (quiet.surprises ?? []).filter((item) => item.effectiveSeverity !== 'info');
    quiet.failed === 0 && noisy.length === 0
      ? ok('an unchanged page produces no surprises', `verdict=${quiet.verdict}`)
      : bad('signature is noisy against itself', JSON.stringify(noisy.slice(0, 3)));

    // Now break the world underneath the flow, WITHOUT changing a single assertion. Offline is a
    // regression the flow has no check for; the detector has to notice on its own, which is the
    // entire point of the feature.
    await mcp.call('browser_emulate', { network: 'offline' });
    const broken = await mcp.call('browser_recording', {
      action: 'replay', id: flow.id, timing: 'fast', signature: 'full', stopOnFailure: false,
    });
    await mcp.call('browser_emulate', { reset: true });
    await mcp.call('browser_navigate', { action: 'reload' });

    const surprises = broken.surprises ?? [];
    const missingTraffic = surprises.find((item) => item.layer === 'network' && item.kind === 'missing');
    missingTraffic
      ? ok('traffic that always happened and now does not is caught', missingTraffic.key.slice(0, 60))
      : bad('the missing-direction detector saw nothing', JSON.stringify(surprises.slice(0, 3)));

    surprises.length > 0 && broken.verdict !== 'PASS'
      ? ok('a run nobody wrote an assertion for is not reported as clean', `verdict=${broken.verdict}, ${surprises.length} surprise(s)`)
      : bad('a broken run was reported as PASS', JSON.stringify({ verdict: broken.verdict, surprises }));

    const known = await mcp.call('browser_recording', { action: 'known_world', id: flow.id });
    known.runs === 1
      ? ok('known world stays at its approved size', `${known.runs} approved run(s)`)
      : bad('known world grew without approval', JSON.stringify(known));

    await mcp.call('browser_recording', { action: 'delete', id: flow.id });
  }

  {
    // Network pinning: record the page's traffic, serve it back, and prove the
    // page still loads from the recording rather than the server.
    const captured = await mcp.call('browser_network', { action: 'record_har' });
    if (!captured.har?.log?.entries?.length) {
      bad('record_har produced no entries', JSON.stringify(captured).slice(0, 120));
    } else {
      ok('HAR captured for pinning', `${captured.recorded} entries`);
      const pinned = await mcp.call('browser_network', { action: 'pin', har: captured.har });
      pinned.pinned
        ? ok('network pinned', `${pinned.operations} operations`)
        : bad('pin did not engage', JSON.stringify(pinned));

      await mcp.call('browser_navigate', { action: 'reload' });
      const after = await mcp.call('browser_network', { action: 'pin_status' });
      after.served > 0
        ? ok('pinned responses were served to a real reload', `${after.served} served, ${after.passedThrough} passed through`)
        : bad('pin served nothing on reload', JSON.stringify(after));

      const released = await mcp.call('browser_network', { action: 'unpin' });
      released.unpinned ? ok('network unpinned') : bad('unpin failed', JSON.stringify(released));
    }
  }

  {
    // The assertion wizard, against the real page. It must propose from what was OBSERVED, and it
    // must add nothing — a wizard that quietly wrote assertions would be the exact blind spot the
    // whole design refuses.
    //
    // Reload the seeded page FIRST, and make this block self-contained. The pinning section above
    // leaves the tab holding a page served from a HAR and a console buffer pruned by that
    // navigation, so a wizard run straight after it correctly sees a small tree and a clean
    // console — and the assertions here would be testing the previous section's leftovers rather
    // than the wizard. Test ordering is a fixture, not an accident.
    await mcp.call('browser_navigate', { action: 'goto', url: 'http://127.0.0.1:5199/', waitUntil: 'load' });

    await mcp.call('browser_recording', { action: 'start', name: 'G9 live wizard' });
    const wizardFlow = await mcp.call('browser_recording', { action: 'stop' });
    const before = await mcp.call('browser_recording', { action: 'get', id: wizardFlow.id });
    const advice = await mcp.call('browser_recording', { action: 'suggest', id: wizardFlow.id });
    const after = await mcp.call('browser_recording', { action: 'get', id: wizardFlow.id });

    const kinds = (advice.suggestions ?? []).map((item) => item.assertion);
    kinds.includes('url') && kinds.includes('aria') && kinds.includes('console')
      ? ok('wizard proposes observable assertions', kinds.join(', '))
      : bad('wizard proposed too little', JSON.stringify(kinds));

    (advice.suggestions ?? []).every((item) => item.why && item.strength)
      ? ok('every suggestion carries a strength and a reason')
      : bad('a suggestion arrived with no rationale', JSON.stringify(advice.suggestions?.slice(0, 2)));

    // The seeded page has deliberate console errors, so the console-absence suggestion must be
    // marked BLOCKED rather than offered as safe. Offering it would hand the QA an assertion that
    // fails on the first run.
    const consoleAdvice = (advice.suggestions ?? []).find((item) => item.assertion === 'console');
    consoleAdvice?.strength === 'blocked'
      ? ok('a suggestion that would fail immediately is marked blocked', consoleAdvice.why.slice(0, 60))
      : bad('the wizard offered a console assertion the page cannot pass', JSON.stringify(consoleAdvice));

    (after.steps?.length ?? 0) === (before.steps?.length ?? 0)
      ? ok('the wizard added nothing — a human still chooses')
      : bad('the wizard mutated the recording', `${before.steps?.length} -> ${after.steps?.length}`);

    await mcp.call('browser_recording', { action: 'delete', id: wizardFlow.id });
  }

  {
    // The FlowSpec round trip, against a real recording rather than a fixture.
    await mcp.call('browser_recording', { action: 'start', name: 'G9 live flowspec' });
    const spec_flow = await mcp.call('browser_recording', { action: 'stop' });
    await mcp.call('browser_recording', { action: 'assert', id: spec_flow.id, assertion: 'url', operator: 'contains', expected: '127.0.0.1' });
    const exported = await mcp.call('browser_recording', { action: 'export_spec', id: spec_flow.id });
    const canonical = exported.json ?? '';
    canonical.includes('"format": "g9/flowspec"') && canonical.includes('"schemaVersion"')
      ? ok('FlowSpec exported in canonical form', `${canonical.split('\n').length} lines`)
      : bad('FlowSpec export is not canonical', canonical.slice(0, 120));

    const reimported = await mcp.call('browser_recording', { action: 'import_spec', spec: exported.spec });
    reimported.steps === (exported.spec.steps?.length ?? -1)
      ? ok('FlowSpec re-imports with every step', `${reimported.steps} steps`)
      : bad('FlowSpec round trip lost steps', JSON.stringify(reimported));

    await mcp.call('browser_recording', { action: 'delete', id: reimported.id });
    await mcp.call('browser_recording', { action: 'delete', id: spec_flow.id });
  }

  // -- stale refs ----------------------------------------------------------
  head('10. Error quality');
  // Replays navigate and deliberately invalidate prior refs. Establish a fresh
  // generation so this check exercises the unknown-ref branch specifically.
  await mcp.call('browser_snapshot');
  try {
    await mcp.call('browser_interact', { action: 'click', ref: 'e9999' });
    bad('bogus ref was accepted');
  } catch (err) {
    /Unknown element ref/i.test(err.message)
      ? ok('bogus ref rejected with guidance', String(err.message).slice(0, 90))
      : bad('unhelpful error', String(err.message).slice(0, 90));
  }

  // -- screenshot ----------------------------------------------------------
  head('11. browser_screenshot');
  // No retry here on purpose: capture.js retries a stalled capture itself, so
  // if this fails the retry failed too and that is a real result.
  const shot = await mcp.call('browser_screenshot', { area: 'viewport' });
  if (shot.__image?.data?.length > 500) {
    ok('screenshot captured', `${Math.round(shot.__image.data.length / 1365)} KB, ${shot.__image.mimeType}`);
  } else bad('screenshot empty', JSON.stringify(shot).slice(0, 100));

  if (onTestPage) {
    const issue = await mcp.call('browser_issue', {
      action: 'create', title: 'G9 live video spool check', withScreenshot: false,
    });
    await mcp.call('browser_issue', { action: 'video_start', id: issue.id });
    await mcp.call('browser_interact', { action: 'scroll', direction: 'down', amount: 120 });
    await sleep(600);
    const video = await mcp.call('browser_issue', { action: 'video_stop', id: issue.id });
    const issueAfter = await mcp.call('browser_issue', { action: 'get', id: issue.id });
    if (video.attached && issueAfter.attachments?.some((attachment) => attachment.kind === 'video')) {
      ok('video frames spooled through IndexedDB', video.frames + ' frames');
    } else if (video.frames === 0 && /headless|not being painted/i.test(video.reason ?? '')) {
      // `Page.startScreencast` captures COMPOSITED frames, and a headless
      // browser composites nothing — it delivers zero screencast events, so
      // there is no video to assert. Failing here would be reporting the
      // harness's own limitation as a defect in the extension. What can be
      // checked headlessly is checked above: the session starts, stops cleanly,
      // and explains itself. The frame spool needs a headed run.
      skip('video frames spooled through IndexedDB', 'headless composites no frames; needs a headed browser');
    } else {
      bad('video attachment missing', JSON.stringify(video));
    }
    await mcp.call('browser_issue', { action: 'delete', id: issue.id });
  }

  // -- emulation -----------------------------------------------------------
  head('12. browser_emulate');
  await mcp.call('browser_emulate', { device: 'iphone-15' });
  await sleep(300);
  const mobile = await mcp.call('browser_console', {
    action: 'evaluate', expression: '({ w: innerWidth, h: innerHeight })',
  });
  mobile.value?.w === 393
    ? ok('device emulation applied', `viewport ${mobile.value.w}x${mobile.value.h}`)
    : bad('emulation did not apply', JSON.stringify(mobile.value));
  await mcp.call('browser_emulate', { reset: true });
  ok('emulation reset');

  // -- connection stability ------------------------------------------------
  head('13. Connection stability');
  const drops = events.filter((e) => e.at >= stabilityStartAt && e.line.includes('extension disconnected'));
  const joins = events.filter((e) => e.at >= stabilityStartAt && e.line.includes('extension connected'));
  if (drops.length === 0) {
    ok('no disconnects during the run', `${Math.round((Date.now() - events[0].at) / 1000)}s`);
  } else {
    const gaps = [];
    for (let i = 1; i < joins.length; i++) gaps.push(Math.round((joins[i].at - joins[i - 1].at) / 1000));
    bad(`${drops.length} disconnect(s) during the run`, gaps.length ? `reconnect gaps: ${gaps.join('s, ')}s` : '');
  }
} catch (err) {
  if (!/no extension|no tab attached|cannot continue/.test(String(err.message))) {
    bad('unexpected exception', String(err?.stack ?? err).slice(0, 300));
  }
} finally {
  child.kill();
}

const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`\n${colour}${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}\x1b[0m`);
if (failed === 0 && passed > 10) {
  console.log('\x1b[90mLive CDP against a real browser works end to end.\x1b[0m');
}

// This test owns the bridge it spawned, so exiting takes the bridge down with
// it and the side panel flips to "Bridge offline" within a second. That is
// expected — but the timing makes it look like the test broke something, so
// say so out loud rather than leaving the user to guess.
console.log(
  '\n\x1b[90mThe test bridge has now stopped, so the side panel will say\n' +
    '"Bridge offline". That is expected: this test runs its own bridge and\n' +
    'cleans it up afterwards. Your MCP client starts its own when you use the\n' +
    'agent, and that one stays up for the whole session.\x1b[0m\n',
);

process.exit(failed === 0 ? 0 : 1);
