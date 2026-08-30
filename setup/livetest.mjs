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

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, G9_PORT: String(PORT) },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const events = [];
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

  // -- diagnosis -----------------------------------------------------------
  head('7. browser_diagnose (the correlated health report)');

  const health = await mcp.call('browser_diagnose');
  ok('diagnose ran', `${health.findings?.length ?? 0} findings`);
  console.log(`  \x1b[90msummary: ${JSON.stringify(health.summary)}\x1b[0m`);
  for (const f of (health.findings ?? []).slice(0, 8)) {
    console.log(`    \x1b[90m[${f.severity}] ${f.kind}: ${String(f.message).slice(0, 90)}\x1b[0m`);
  }

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

  // -- stale refs ----------------------------------------------------------
  head('9. Error quality');
  try {
    await mcp.call('browser_interact', { action: 'click', ref: 'e9999' });
    bad('bogus ref was accepted');
  } catch (err) {
    /Unknown element ref/i.test(err.message)
      ? ok('bogus ref rejected with guidance', String(err.message).slice(0, 90))
      : bad('unhelpful error', String(err.message).slice(0, 90));
  }

  // -- screenshot ----------------------------------------------------------
  head('10. browser_screenshot');
  const shot = await mcp.call('browser_screenshot', { area: 'viewport' });
  if (shot.__image?.data?.length > 500) {
    ok('screenshot captured', `${Math.round(shot.__image.data.length / 1365)} KB, ${shot.__image.mimeType}`);
  } else bad('screenshot empty', JSON.stringify(shot).slice(0, 100));

  // -- emulation -----------------------------------------------------------
  head('11. browser_emulate');
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
  head('12. Connection stability');
  const drops = events.filter((e) => e.line.includes('extension disconnected'));
  const joins = events.filter((e) => e.line.includes('extension connected'));
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
  console.log('\x1b[90mLive CDP against a real browser works end to end.\x1b[0m\n');
}
process.exit(failed === 0 ? 0 : 1);
