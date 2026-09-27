#!/usr/bin/env node
/**
 * LIVE test of Engine 1 — the G9BrowserAgent extension in a real browser — v2.
 *
 * Unlike selftest.mjs (which fakes the extension and proves only the plumbing),
 * this drives real CDP against real pages. It is an MCP client itself, speaking
 * through a real `mcp/shim.mjs` to a real daemon (g9d), exactly as an AI agent
 * does — so it needs no agent configured.
 *
 * Normally started by setup/isolated-livetest.mjs, which builds a private
 * daemon, a temp browser profile with a copy of the extension, and the fixture
 * pages, and passes their coordinates here:
 *
 *   G9_PORT                the daemon's port (REQUIRED — this test never assumes one)
 *   G9_HOME                that daemon's data folder (its log is read for stability)
 *   G9_LIVE_CDP_PORT       the test browser's DevTools port: the checks that need the
 *                          browser itself (extension pages, reloads, background tabs)
 *   G9_LIVE_EXTENSION_ID   the extension's id in that browser
 *   G9_LIVE_EXTENSION_DIR  the extension COPY (its manifest version is changed to
 *                          simulate an update — never the repository's)
 *   G9_LIVE_PAGE           base URL of the fixture server
 *   G9_LIVE_SECTIONS       optional, e.g. "9,16": run only those sections (1-3 always run)
 *
 * By hand, against your own daemon and browser (it will open tabs there):
 *
 *   1. node setup/serve.mjs                 -> http://127.0.0.1:5199/ (open it)
 *   2. G9_PORT=8765 node setup/livetest.mjs
 *
 * Without the G9_LIVE_* variables, every check that needs the browser's
 * DevTools port or the fixture pages is reported as SKIP with that reason.
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SHIM = path.join(ROOT, 'mcp', 'shim.mjs');
const VERSION = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;

// No default port. v1 fell back to 8765, which on a machine running a real
// session is somebody's live agent — a test that silently attaches there is a
// test that breaks the work it is meant to protect.
if (!process.env.G9_PORT) {
  console.error('\nSet G9_PORT to the daemon this test should use, e.g. G9_PORT=8765 for your own.');
  console.error('Or run setup/isolated-livetest.mjs, which builds a private one.\n');
  process.exit(2);
}
const PORT = Number(process.env.G9_PORT);
const HOME = process.env.G9_HOME || null;
const CDP_PORT = Number(process.env.G9_LIVE_CDP_PORT) || null;
const EXT_ID = process.env.G9_LIVE_EXTENSION_ID || null;
const EXT_DIR = process.env.G9_LIVE_EXTENSION_DIR || null;
const FIXTURES = !!process.env.G9_LIVE_PAGE;
const PAGE = process.env.G9_LIVE_PAGE || 'http://127.0.0.1:5199/';
const LONG_TITLE = process.env.G9_LIVE_LONG_TITLE || null;
const WAIT_FOR_EXTENSION_MS = 30_000;
const NO_CDP = 'needs the test browser\'s DevTools port (run setup/isolated-livetest.mjs)';
const NO_FIXTURES = 'needs the fixture pages (run setup/isolated-livetest.mjs)';

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

const ok = (n, d = '') => { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${n}${d ? ` \x1b[90m${d}\x1b[0m` : ''}`); };
const bad = (n, d = '') => { failed++; failures.push(n); console.log(`  \x1b[31mFAIL\x1b[0m ${n}${d ? ` \x1b[90m${d}\x1b[0m` : ''}`); };
const skip = (n, d = '') => { skipped++; console.log(`  \x1b[33mSKIP\x1b[0m ${n}${d ? ` \x1b[90m${d}\x1b[0m` : ''}`); };
const check = (cond, n, d = '') => (cond ? ok(n, d) : bad(n, d));
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v, n = 160) => (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)).slice(0, n);

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

  request(method, params = {}, timeoutMs = 90_000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** Call a tool and return its parsed JSON payload (or throw with the error text). */
  async call(name, args = {}, timeoutMs = 90_000) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (res.error) throw new Error(res.error.message ?? JSON.stringify(res.error));
    const content = res.result?.content ?? [];
    const text = content.find((c) => c.type === 'text')?.text ?? '';
    if (res.result?.isError) throw new Error(text);
    const image = content.find((c) => c.type === 'image');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
    if (parsed && typeof parsed === 'object') {
      // Non-enumerable, so it never shows up when a test prints a result: it
      // is harness metadata, not tool output.
      Object.defineProperty(parsed, '__image', { value: image, enumerable: false });
    }
    return parsed;
  }
}

// ------------------------------------------------------------------- CDP

/** The test browser's own DevTools endpoint: for what no G9BrowserAgent tool does (and must not). */
class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id == null) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
    });
    this.socket.addEventListener('close', () => {
      for (const [, p] of this.pending) p.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }
  async send(method, params = {}, sessionId = null, timeoutMs = 20_000) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(expression, sessionId) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed');
    return result.result?.value;
  }
  close() { try { this.socket.close(); } catch {} }
}

let cdp = null;

async function targets() {
  return (await cdp.send('Target.getTargets')).targetInfos ?? [];
}

const extUrl = (p) => `chrome-extension://${EXT_ID}/${p}`;

/** Open an extension page (or any URL) as a BACKGROUND tab and attach to it. */
async function openPage(url, { background = true } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url, background });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
  const page = {
    targetId,
    sessionId,
    evaluate: (expr) => cdp.evaluate(expr, sessionId),
    close: () => cdp.send('Target.closeTarget', { targetId }).catch(() => {}),
  };
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate('document.readyState').catch(() => null);
    if (ready === 'complete') break;
    await sleep(100);
  }
  return page;
}

async function welcomeTabs() {
  return (await targets()).filter((t) => t.type === 'page' && t.url.startsWith(extUrl('panel/welcome.html')));
}

/** The extension's service worker, attached. Woken by an extension page if MV3 tore it down. */
async function workerSession(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let woke = null;
  try {
    while (Date.now() < deadline) {
      const sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.startsWith(extUrl('')));
      if (sw) {
        try {
          const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
          await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
          const name = await cdp.evaluate('chrome.runtime.getManifest().name', sessionId);
          if (name) return { targetId: sw.targetId, sessionId, evaluate: (e) => cdp.evaluate(e, sessionId) };
        } catch { /* mid-startup; try again */ }
      } else if (!woke) {
        woke = await openPage(extUrl('panel/about-blank-wake.html')).catch(() => null);
      }
      await sleep(250);
    }
  } finally {
    await woke?.close();
  }
  throw new Error('the extension service worker did not appear');
}

async function activateTarget(url) {
  const pages = (await targets()).filter((x) => x.type === 'page');
  const t = pages.find((x) => x.url === url) ?? pages.find((x) => x.url.startsWith(url));
  if (t) await cdp.send('Target.activateTarget', { targetId: t.targetId }).catch(() => {});
  return t ?? null;
}

// ------------------------------------------------------------------- run

console.log('\n\x1b[1mG9BrowserAgent — LIVE test (Engine 1, v' + VERSION + ')\x1b[0m');
console.log(`\x1b[90mdaemon port ${PORT} · shim ${path.relative(ROOT, SHIM)} · ${CDP_PORT ? `browser CDP ${CDP_PORT}` : 'no browser CDP (checks that need it are skipped)'}\x1b[0m`);

const child = spawn(process.execPath, [SHIM], {
  cwd: ROOT,
  env: { ...process.env, G9_PORT: String(PORT), ...(HOME ? { G9_HOME: HOME } : {}) },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const shimErr = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => { for (const l of d.split('\n')) if (l.trim()) shimErr.push(l.trim()); });

const mcp = new Mcp(child);
const call = (name, args = {}, timeoutMs) => mcp.call(name, args, timeoutMs);
const evalIn = async (tabId, expression) => (await call('browser_console', { action: 'evaluate', expression, ...(tabId != null ? { tabId } : {}) })).value;
const refOf = (tree, pattern) => {
  const line = String(tree ?? '').split('\n').find((l) => pattern.test(l) && /\[ref=/.test(l));
  return line?.match(/\[ref=(e\d+)\]/)?.[1] ?? null;
};
const rowFor = (rows, url) => rows.find((r) => typeof r.url === 'string' && r.url === url) ?? rows.find((r) => typeof r.url === 'string' && r.url.startsWith(url));
/** Bring the main test tab to the front, wherever it has navigated since. */
const activateMain = async () => {
  if (!cdp || mainTab == null) return;
  const row = ((await call('browser_tabs', { action: 'list' }).catch(() => ({}))).tabs ?? []).find((r) => r.tabId === mainTab);
  if (row?.url) await activateTarget(row.url);
};
/** Names G9BrowserAgent must never leave in a page's MAIN world; `pageOwned` are the fixture's own. */
const mainWorldLeaks = async (tabId, pageOwned = []) => {
  const names = await evalIn(tabId, 'Object.getOwnPropertyNames(window).filter((n) => /^__g9|g9emit|__g9rec|__g9loc/i.test(n))');
  return (names ?? []).filter((n) => !pageOwned.includes(n));
};
const waitFor = async (fn, { timeoutMs = 10_000, every = 250 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn().catch((e) => ({ __error: e }));
    if (last && !last.__error) return last;
    await sleep(every);
  }
  return last?.__error ? null : last;
};
const loadedIn = (tabId) => waitFor(async () => (await evalIn(tabId, 'document.readyState')) === 'complete');

/**
 * Only these sections, e.g. G9_LIVE_SECTIONS=9,16 — for working on one area.
 * Sections 1-3 (connection, install, attach) always run: the rest stand on them.
 */
const ONLY = new Set(String(process.env.G9_LIVE_SECTIONS ?? '').split(',').map((x) => Number(x.trim())).filter(Boolean));

/** Section runner: one broken section is a failure, not the end of the run. */
async function section(title, fn) {
  const n = Number(/^(\d+)\./.exec(title)?.[1]);
  if (ONLY.size && n > 3 && !ONLY.has(n)) return;
  head(title);
  try {
    await fn();
  } catch (err) {
    bad(`${title}: unexpected exception`, short(String(err?.stack ?? err), 400));
  }
}

let mainTab = null;
let mainUrl = null;
let stabilityStartAt = null;
let reloadsStartAt = null;
let extensionReady = false;

try {
  // -------------------------------------------------------------- connection
  head('1. Shim → daemon → extension');
  const init = await mcp.request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'g9-livetest', version: VERSION },
  });
  if (init.result?.serverInfo?.name === 'G9BrowserAgent') ok('MCP handshake through mcp/shim.mjs', `server v${init.result.serverInfo.version}`);
  else { bad('MCP handshake', short(init)); throw new Error('cannot continue'); }
  check(init.result.serverInfo.version === VERSION, 'shim reports v' + VERSION, init.result.serverInfo.version);
  mcp.notify('notifications/initialized');
  const list = await mcp.request('tools/list');
  const names = (list.result?.tools ?? []).map((t) => t.name);
  check(names.length === 15 && names.includes('browser_engine') && names.includes('browser_tabs'), 'tools/list serves the v2 tools', `${names.length} tools`);

  let status = null;
  const deadline = Date.now() + WAIT_FOR_EXTENSION_MS;
  while (Date.now() < deadline) {
    status = await call('browser_status').catch((e) => ({ problem: e.message }));
    if (status?.capabilities?.extension === true) break;
    await sleep(500);
  }
  if (status?.capabilities?.extension === true) {
    extensionReady = true;
    ok('extension engine connected to the daemon', (status.engines ?? []).filter((e) => e.kind === 'extension').map((e) => e.engineId ?? e.id).join(', '));
  } else {
    bad('extension never connected', `waited ${WAIT_FOR_EXTENSION_MS / 1000}s: ${short(status)}`);
    console.log('\n  Is the browser open with the G9BrowserAgent v2 extension, on daemon port ' + PORT + '?\n');
    throw new Error('no extension');
  }
  check(status.daemon?.port === PORT, 'daemon is the one on G9_PORT', `port ${status.daemon?.port}, pid ${status.daemon?.pid}`);
  check(status.daemon?.version === VERSION && status.version === VERSION && status.shim?.version === VERSION && !status.shimVersionMismatch,
    'daemon, extension and shim all report v' + VERSION, `daemon ${status.daemon?.version}, extension ${status.version}, shim ${status.shim?.version}`);
  check(status.engine?.kind === 'extension', 'status is about the extension engine', short(status.engine));
  check(!('mode' in status) && !('pinnedTabId' in status), 'no v1 mode fields in browser_status');
  check(status.capabilities?.popout === true && status.capabilities?.handoff === true, 'capabilities: popout and handoff available', short(status.capabilities));
  // v3 (U2): auto-attach defaults to "Project sites". `autoAttach` stays a boolean for agents
  // ("does auto-attach capture anything": true only with project domains known) and the mode is
  // `autoAttachMode`. A fresh profile with no project anywhere captures nothing by itself.
  check(status.inputMode === 'human' && status.autoAttachMode === 'project' && typeof status.autoAttach === 'boolean',
    'defaults: input "human", auto-attach "Project sites"', `inputMode=${status.inputMode}, autoAttachMode=${status.autoAttachMode}, autoAttach=${status.autoAttach}`);

  if (CDP_PORT) {
    const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    cdp = new Cdp(version.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
  }

  // ------------------------------------------------------ install + front tab
  await section('2. First install: the welcome tab, once', async () => {
    if (!cdp || !EXT_ID) return skip('welcome tab on install', NO_CDP);
    const found = await waitFor(async () => ((await welcomeTabs()).length ? welcomeTabs() : null), { timeoutMs: 6000 });
    const tabs = found ?? [];
    check(tabs.length === 1 && !tabs[0].url.includes('updated=1'), 'install opened exactly one welcome tab (not ?updated=1)', tabs.map((t) => t.url).join(', ') || 'none');
    // Out of the way: it opened in FRONT, and a background test tab receives no input.
    for (const t of tabs) await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    await activateTarget(PAGE);
  });

  // ------------------------------------------------------- tabs, attach
  await section('3. browser_tabs: full titles and URLs, attach makes current', async () => {
    let longTarget = null;
    if (cdp && FIXTURES) {
      // A background tab the extension has never attached, with a title far past
      // any display width and a URL with a long query: v1 redacted and v1 panels
      // truncated; v2 lists every tab in full.
      longTarget = (await cdp.send('Target.createTarget', {
        url: PAGE + 'long-title.html?q=' + 'x'.repeat(300) + '&v=%C3%BC#frag', background: true,
      })).targetId;
      await sleep(1200);
      await activateTarget(PAGE);
    }
    const listed = await call('browser_tabs', { action: 'list' });
    const rows = listed.tabs ?? [];
    check(rows.length > 0 && rows.every((r) => Number.isInteger(r.tabId) && typeof r.title === 'string' && typeof r.url === 'string'),
      'every row carries tabId, title and url', `${rows.length} tab(s)`);
    check(rows.every((r) => !('id' in r)), 'tab identity is always "tabId", never "id"');
    if (cdp) {
      const pages = (await targets()).filter((t) => t.type === 'page' && /^https?:/.test(t.url));
      const mismatched = pages.filter((t) => {
        const row = rows.find((r) => r.url === t.url);
        return !row || row.title !== t.title;
      });
      check(mismatched.length === 0, 'titles and URLs equal the browser\'s own, unredacted and untruncated',
        mismatched.length ? short(mismatched.map((t) => [t.url.slice(0, 60), t.title.slice(0, 40)])) : `${pages.length} web tab(s) compared`);
    } else skip('list compared with the browser\'s own targets', NO_CDP);
    if (longTarget) {
      const row = rows.find((r) => r.url?.includes('long-title.html'));
      check(row && row.title === LONG_TITLE && row.url.length > 300 && row.url.endsWith('&v=%C3%BC#frag') && row.attached === false,
        'an unattached background tab is listed with its full title and URL',
        row ? `title ${row.title.length} chars, url ${row.url.length} chars, attached=${row.attached}` : 'not listed');
      await cdp.send('Target.closeTarget', { targetId: longTarget }).catch(() => {});
    }

    const pageRow = rowFor(rows, PAGE);
    if (!pageRow) {
      bad('the test page is open', `no tab on ${PAGE} — open it (node setup/serve.mjs) and re-run`);
      throw new Error('no test page');
    }
    if (cdp) {
      // No tabId: the tab the person is looking at (the test page, in front).
      await activateTarget(pageRow.url);
      const active = await call('browser_tabs', { action: 'attach' });
      check(active.tabId === pageRow.tabId && active.current === true, 'attach without tabId takes the tab in front', `${active.tabId} (${active.url})`);
    }
    const attached = await call('browser_tabs', { action: 'attach', tabId: pageRow.tabId });
    check(attached.tabId === pageRow.tabId && attached.current === true, 'attach returns the tab, current:true', short(attached));
    mainTab = pageRow.tabId;
    mainUrl = pageRow.url;
    const st = await call('browser_status');
    check(st.current?.tabId === mainTab && st.you?.current === mainTab, 'browser_status: the attached tab is now current', `current ${st.current?.tabId}, you.current ${st.you?.current}`);
    check(st.current?.url === mainUrl && typeof st.current?.title === 'string' && st.current.title.length > 0, 'current carries the full url and title', `${st.current?.title} — ${st.current?.url}`);
    const href = await evalIn(null, 'location.href');
    check(href === mainUrl, 'a call without tabId acts on the current tab', href);
    const again = await call('browser_tabs', { action: 'list' });
    check(rowFor(again.tabs ?? [], mainUrl)?.attached === true, 'the list reports it attached');
  });
  if (mainTab == null) throw new Error('no test page');
  stabilityStartAt = Date.now();
  const onTestPage = /testpage\.html|\/$/.test(new URL(mainUrl).pathname);

  // Capture starts at attach. Reload before taking refs or diagnosing so every
  // seeded load-time console/network defect belongs to this run.
  if (onTestPage) {
    const reloaded = await call('browser_navigate', { action: 'reload', waitUntil: 'idle', timeoutMs: 15_000 });
    reloaded.readyState === 'complete'
      ? ok('test page reloaded after attach', 'load-time evidence is now captured')
      : bad('test page reload did not settle', short(reloaded));
  }

  // --------------------------------------------------------------- perception
  let snap = null;
  await section('4. browser_snapshot (accessibility tree + refs)', async () => {
    snap = await call('browser_snapshot');
    if (snap.tree?.length) ok('snapshot returned a tree', `${snap.tree.split('\n').length} lines`);
    else bad('snapshot empty');
    if (snap.interactiveCount > 0) ok('interactive elements got refs', `${snap.interactiveCount} refs`);
    else bad('no refs assigned', 'interaction will be impossible');
    console.log(`  \x1b[90m${String(snap.tree ?? '').split('\n').slice(0, 5).join('\n  ')}\x1b[0m`);
  });

  await section('5. browser_inspect, console, network, diagnose', async () => {
    const styles = await call('browser_inspect', { what: 'styles', selector: 'body' });
    styles.computed && Object.keys(styles.computed).length
      ? ok('computed styles', `${Object.keys(styles.computed).length} non-default properties`)
      : bad('computed styles empty');
    const storage = await call('browser_inspect', { what: 'storage' });
    ok('storage readable', `keys: ${Object.keys(storage).join(', ')}`);

    const logs = await call('browser_console', { limit: 20 });
    ok('console buffer read', `${logs.total} entries, counts=${JSON.stringify(logs.counts)}`);
    const evald = await call('browser_console', { action: 'evaluate', expression: '({ title: document.title, url: location.href, forms: document.forms.length })' });
    evald.value?.title != null ? ok('JavaScript evaluation (page main world)', JSON.stringify(evald.value)) : bad('evaluate failed', short(evald));

    const net = await call('browser_network', { limit: 10 });
    ok('network list', `${net.total} requests, ${net.failedCount} failed`);
    if (net.requests?.length) {
      const detail = await call('browser_network', { requestId: net.requests[0].requestId });
      detail.url ? ok('request detail', `${detail.method} ${String(detail.url).slice(0, 60)} -> ${detail.status}`) : bad('request detail empty');
    } else skip('request detail', 'no requests captured yet — reload the page');
    const har = await call('browser_network', { format: 'har' });
    har.log?.version === '1.2' && har.entryCount === har.log.entries.length
      ? ok('HAR 1.2 export', har.entryCount + ' entries')
      : bad('HAR export invalid', short(har));

    const health = await call('browser_diagnose');
    ok('diagnose ran', `${health.findings?.length ?? 0} findings`);
    const vitals = await call('browser_diagnose', { what: 'vitals', durationMs: 250 });
    vitals.coreWebVitals && vitals.longTasks ? ok('Core Web Vitals + long tasks', JSON.stringify(vitals.coreWebVitals)) : bad('vitals diagnostics missing');
    const memory = await call('browser_diagnose', { what: 'memory', samples: 2, intervalMs: 50 });
    memory.samples?.length === 2 ? ok('memory/leak sampling', JSON.stringify(memory.growth)) : bad('memory diagnostics missing');

    if (onTestPage) {
      const s = health.summary ?? {};
      const kinds = new Set((health.findings ?? []).map((f) => f.kind));
      const msgs = (health.findings ?? []).map((f) => String(f.message)).join(' | ');
      s.consoleErrors > 0 ? ok('deliberate defect: console errors found', `${s.consoleErrors}`) : bad('console errors missed');
      s.failedRequests > 0 ? ok('deliberate defect: failed request found', `${s.failedRequests}`) : bad('failed request missed');
      s.brokenImages > 0 ? ok('deliberate defect: broken image found') : bad('broken image missed');
      s.formIssues > 0 ? ok('deliberate defect: unlabelled form control found') : bad('form issue missed');
      s.overflowing ? ok('deliberate defect: horizontal overflow found') : bad('overflow missed');
      /[Dd]uplicate/.test(msgs) ? ok('deliberate defect: duplicate IDs found') : bad('duplicate IDs missed');
      kinds.has('a11y') ? ok('accessibility checks ran') : skip('a11y findings', 'none reported');
    } else skip('deliberate-defect checks', 'not on the test page');
  });

  // ------------------------------------------------------------------ cookies
  await section('6. Cookies: HttpOnly, any domain, full access', async () => {
    const own = await call('browser_inspect', { what: 'cookies' });
    if (FIXTURES) {
      const hidden = (own.cookies ?? []).find((c) => c.name === 'g9_httponly');
      check(hidden?.httpOnly === true && hidden.value === 'h1-secret', 'the tab\'s HttpOnly cookie is readable (document.cookie cannot see it)', short(hidden ?? own));
      const pageView = await evalIn(mainTab, 'document.cookie');
      check(!String(pageView).includes('g9_httponly'), 'and the page itself indeed cannot', `document.cookie="${pageView}"`);
    } else ok('cookies readable', `${own.count} cookie(s)`);
    if (!cdp) return skip('a cookie of another domain', NO_CDP);
    // Planted by the browser itself for a domain no tab has ever visited: v1 scoped
    // cookie reads to the attached origin; v2 reads any site in that browser.
    await cdp.send('Storage.setCookies', { cookies: [{
      name: 'g9_far', value: 'far-away-value', domain: 'g9-any-domain.example', path: '/', secure: true, httpOnly: true, sameSite: 'Lax',
    }] });
    const far = await call('browser_inspect', { what: 'cookies', url: 'https://g9-any-domain.example/deep/path' });
    const c = (far.cookies ?? []).find((x) => x.name === 'g9_far');
    check(c?.value === 'far-away-value' && c.httpOnly === true && c.domain.endsWith('g9-any-domain.example'),
      'a cookie of an unrelated domain is readable in full', short(c ?? far));
    // "Full access" (D6: every cookie; D7: no cookie scoping) includes the
    // VALUE. Real session cookies are JWTs of several hundred characters; a
    // value cut short is a token an agent cannot use and may not notice is cut.
    const jwtish = 'eyJhbGciOiJIUzI1NiJ9.' + 'x'.repeat(900) + '.sig-end';
    await cdp.send('Storage.setCookies', { cookies: [{
      name: 'g9_long', value: jwtish, domain: 'g9-any-domain.example', path: '/', secure: true, httpOnly: true, sameSite: 'Lax',
    }] });
    const longJar = await call('browser_inspect', { what: 'cookies', url: 'https://g9-any-domain.example/' });
    const long = (longJar.cookies ?? []).find((x) => x.name === 'g9_long');
    check(long?.value === jwtish, 'a long (JWT-sized) cookie value comes back whole, not cut short',
      long ? `${jwtish.length} chars set, ${long.value.length} returned${long.value !== jwtish ? `, ends "${long.value.slice(-12)}"` : ''}` : 'not listed');
  });

  // -------------------------------------------------------------- interaction
  await section('7. browser_interact on the test page (trusted, delivered)', async () => {
    if (!onTestPage || !snap?.tree) return skip('login flow', 'not on the test page');
    const userRef = refOf(snap.tree, /textbox|Username/i);
    const passRef = snap.tree.split('\n').filter((l) => /\[ref=/.test(l) && /textbox|password/i.test(l))[1]?.match(/\[ref=(e\d+)\]/)?.[1] ?? null;
    const loginRef = refOf(snap.tree, /button.*Sign in/i);
    if (!userRef || !loginRef) return skip('login flow', `refs not found (user=${userRef}, login=${loginRef})`);

    const typed = await call('browser_interact', { action: 'type', ref: userRef, text: 'admin', clear: true });
    check(typed.delivery === 'delivered', 'typed into username', `delivery=${typed.delivery}, humanize=${typed.humanize?.level}`);
    if (passRef) {
      const p = await call('browser_interact', { action: 'type', ref: passRef, text: 'g9secret', clear: true });
      check(p.delivery === 'delivered', 'typed into password', `delivery=${p.delivery}`);
    } else skip('password field', 'no ref found (it is deliberately unlabelled)');
    const clicked = await call('browser_interact', { action: 'click', ref: loginRef });
    check(clicked.delivery === 'delivered' && clicked.pointer && clicked.humanize?.level === 'human',
      'clicked Sign in (human input by default)', `delivery=${clicked.delivery}, pointer=${short(clicked.pointer)}, level=${clicked.humanize?.level}`);
    await sleep(400);
    const statusText = await evalIn(mainTab, 'document.getElementById("status")?.textContent');
    /Signed in as admin/i.test(statusText ?? '') ? ok('LOGIN SUCCEEDED', 'trusted events accepted by the page') : bad('login did not complete', `status reads: ${statusText}`);

    const envRef = refOf(snap.tree, /combobox.*Environment/i);
    if (envRef) {
      const sel = await call('browser_interact', { action: 'select', ref: envRef, values: 'Staging' });
      const selected = await evalIn(mainTab, '({ value: document.getElementById("env").value, trusted: window.__g9SelectTrusted })');
      selected?.value === 'stg' && selected?.trusted === true
        ? ok('trusted select applied and verified', `Staging · isTrusted=true · delivery=${sel.delivery}`)
        : bad('select was not a trusted verified interaction', short(selected));
    } else skip('trusted select', 'combobox ref not found');

    const coveredRef = refOf(snap.tree, /You cannot click me/i);
    if (coveredRef) {
      try {
        await call('browser_interact', { action: 'click', ref: coveredRef });
        bad('covered button was clicked', 'obstruction detection did not fire');
      } catch (err) {
        /covered by|not clickable/i.test(err.message) ? ok('obstruction detected', short(err.message, 80)) : bad('wrong error for covered button', short(err.message, 120));
      }
    } else skip('obstruction test', 'covered button ref not found');
  });

  // Input levels: off / human / stealth, each proven by the page, not by the reply.
  let panel = null;
  const openPanel = async () => {
    if (panel) return panel;
    panel = await openPage(extUrl('panel/panel.html'));
    await waitFor(async () => (await panel.evaluate('document.getElementById("stop")?.textContent')) === 'Stop', { timeoutMs: 8000 });
    await activateMain();
    return panel;
  };
  const setInputMode = async (mode) => {
    const p = await openPanel();
    await p.evaluate(`document.querySelector('input[name="inputMode"][value="${mode}"]').click(); true`);
    return waitFor(async () => (await call('browser_status')).inputMode === mode, { timeoutMs: 6000 });
  };

  await section('8. Input levels off / human / stealth, with delivery', async () => {
    if (!FIXTURES) return skip('input levels', NO_FIXTURES);
    await call('browser_navigate', { action: 'goto', url: PAGE + 'clicks.html', waitUntil: 'load' });
    const s = await call('browser_snapshot');
    const target = refOf(s.tree, /button "Press me"/);
    const note = refOf(s.tree, /textbox "Note"/);
    if (!target) return bad('click fixture has no button ref', short(s.tree, 200));
    const read = () => evalIn(mainTab, 'JSON.parse(JSON.stringify(window.clicks))');

    // Every level runs, with or without the DevTools port: the panel's Human
    // (its default) is a default, not a floor, so a call's humanize:"off" is
    // honoured (decision D-b; only the panel's Stealth is a floor).
    const levels = ['off', 'human', 'stealth'];
    // The planned press hold per level (extension/humanize/profiles.js
    // pressHoldMs) and the dispatcher's promise to keep >= 80% of a planned
    // interval that ends in a release (docs/HUMANIZE.md, lib/humanize.js
    // perform rule 1). 5 ms is left for timer granularity in the renderer.
    const HOLD_FLOOR = { human: 60 * 0.8 - 5, stealth: 80 * 0.8 - 5 };
    for (const level of levels) {
      // Stealth is chosen in the PANEL and the call names no level, so the
      // panel's third setting is proven to reach the tool, not only the
      // per-call argument.
      const viaPanel = cdp && level === 'stealth';
      if (cdp) {
        const set = await setInputMode(level);
        if (!set) bad(`panel Input set to ${level}`, 'browser_status never reported it');
      }
      const before = await read();
      const r = await call('browser_interact', { action: 'click', ref: target, ...(viaPanel ? {} : { humanize: level }), seed: `live-${level}` });
      await sleep(150);
      const after = await read();
      const landed = after.n === before.n + 1 && after.trusted === before.trusted + 1 && after.untrusted === 0;
      const moves = after.moves - before.moves;
      check(r.delivery === 'delivered' && r.humanize?.level === level && landed,
        `${level}: click delivered and the page saw exactly one trusted click${viaPanel ? ' (level from the panel, none in the call)' : ''}`,
        `delivery=${r.delivery}, level=${r.humanize?.level}${r.humanize?.raisedFrom ? ` (raised from ${r.humanize.raisedFrom})` : ''}, page clicks ${before.n}→${after.n}, trusted mousemoves ${moves}`);
      if (level === 'off') check(moves <= 2, 'off: direct input (no pointer path)', `${moves} mousemove(s)`);
      else check(moves >= 3, `${level}: a humanized pointer path reached the page`, `${moves} mousemove(s), seed ${r.humanize?.seed ?? r.seed}`);
      // What the page can see of the press itself (live round 2: pressure 0 in
      // 50/50 runs; holds of 1.9-8.1 ms on a slow dispatcher).
      const pressure = after.pressure.slice(before.pressure.length);
      check(pressure.length === 1 && pressure[0] === 0.5, `${level}: the pointerdown carries a held mouse button's pressure (0.5)`, `pressure ${JSON.stringify(pressure)}`);
      const hold = after.holds.slice(before.holds.length)[0];
      if (level === 'off') console.log(`  \x1b[90moff: press hold ${hold} ms (direct input; no floor)\x1b[0m`);
      else check(Number.isFinite(hold) && hold >= HOLD_FLOOR[level], `${level}: the button is held like a person's (>= ${HOLD_FLOOR[level]} ms)`, `mousedown→mouseup ${hold} ms`);
    }
    if (cdp) await setInputMode('human');
    if (note) {
      const t = await call('browser_interact', { action: 'type', ref: note, text: 'stealthy words', clear: true, humanize: 'stealth', typos: false });
      const value = await evalIn(mainTab, 'document.getElementById("note").value');
      check(t.delivery === 'delivered' && value === 'stealthy words' && t.humanize?.level === 'stealth', 'stealth typing lands exactly', `value="${value}", delivery=${t.delivery}`);
    }
    if (cdp) {
      // Decision D-b in the person's own browser: the panel's Human is only a
      // default, so asking for "off" gets direct input. Its Stealth is a floor:
      // "off" is raised to stealth, and the result says so.
      await setInputMode('human');
      const r = await call('browser_interact', { action: 'click', ref: target, humanize: 'off' });
      check(r.humanize?.level === 'off' && !r.humanize?.raisedFrom, 'the panel\'s Human is a default, not a floor (humanize "off" gives direct input)', short(r.humanize));
      if (await setInputMode('stealth')) {
        const st = await call('browser_interact', { action: 'click', ref: target, humanize: 'off', seed: 'live-floor' });
        check(st.humanize?.level === 'stealth' && st.humanize?.raisedFrom === 'off', 'the panel\'s Stealth is a floor (off raised to stealth, and reported)', short(st.humanize));
      } else bad('panel Input set to stealth', 'browser_status never reported it');
      await setInputMode('human');
    }
  });

  // ------------------------------------------------------------------ EXT-01
  await section('9. EXT-01: input to a HIDDEN background tab is never reported as success', async () => {
    if (!FIXTURES) return skip('hidden-tab delivery', NO_FIXTURES);
    // The invariant is EXT-01's: a reply of success means the page got the
    // input. What a browser does with input to a hidden tab varies by event kind
    // and build (the v1 audit saw typing land in a hidden tab), so each outcome
    // is judged against the page's own record — and the answer must come back
    // within the tool's own budget, not hang until the caller's deadline.
    //
    // One fresh background tab per action: a stuck action holds its tab's queue,
    // and a second action behind it would be measuring the first one's hang.
    // [label, action, what the page would show if any of it arrived, refs to find]
    const BUTTON = /button "Press me"/;
    const NOTE = /textbox "Note"/;
    const cases = [
      ['click', { action: 'click' }, 'window.clicks.n + window.clicks.downs', { ref: BUTTON }],
      ['type', { action: 'type', text: 'lost?', typos: false }, 'document.getElementById("note").value.length + window.clicks.keys', { ref: NOTE }],
      // Round 3 (bench B2): every input action reads visibility first and sends
      // nothing to a hidden page — before, a hidden wheel stalled 4 s and was
      // blamed on a screencast, and typing ended in a 120 s relay timeout.
      ['hover', { action: 'hover' }, 'window.clicks.overs + window.clicks.moves', { ref: BUTTON }],
      ['key', { action: 'key', key: 'a' }, 'window.clicks.keys', {}],
      ['scroll', { action: 'scroll', direction: 'down', amount: 400 }, 'window.clicks.wheels + Math.round(scrollY)', {}],
      ['select', { action: 'select', values: 'beta' }, 'window.clicks.picks + (document.getElementById("pick").value === "b" ? 1 : 0)', { ref: /combobox "Pick"/ }],
      ['drag', { action: 'drag' }, 'window.clicks.downs + window.clicks.moves', { from: BUTTON, to: NOTE }],
    ];
    // Direct input (humanize:"off"; the panel's Human is a default, not a
    // floor — decision D-b): one event per step, so it ends either way — the
    // invariant is checked on a path that always terminates.
    cases.push(['click-off', { action: 'click', humanize: 'off' }, 'window.clicks.n + window.clicks.downs', { ref: BUTTON }]);
    for (const [label, action, readBack, refSpec] of cases) {
      const url = `${PAGE}background.html?${label}`;
      const opened = await call('browser_tabs', { action: 'open', url });
      const bg = opened.tabId;
      await loadedIn(bg);
      const vis = await evalIn(bg, '({ state: document.visibilityState, hidden: document.hidden })');
      const row = rowFor((await call('browser_tabs', { action: 'list' })).tabs ?? [], url);
      check(opened.current === true && row?.active === false && vis?.hidden === true,
        `hidden ${label}: browser_tabs open made a background tab, current and hidden`, `tab ${bg}, active=${row?.active}, visibilityState=${vis?.state}`);
      if (label === 'click') {
        const st = await call('browser_status', { tabId: bg });
        check((st.warnings ?? []).some((w) => /not the active tab|hidden/i.test(w)), 'browser_status warns that input may not be delivered', short(st.warnings, 120));
      }
      const s = await call('browser_snapshot', { tabId: bg });
      const refs = Object.fromEntries(Object.entries(refSpec).map(([key, pattern]) => [key, refOf(s.tree, pattern)]));
      if (Object.values(refs).some((r) => !r)) { bad(`hidden ${label}: no ref`, `reads should work on a hidden tab: ${short(refs)}`); continue; }
      let threw = null;
      let reply = null;
      const t0 = Date.now();
      try { reply = await call('browser_interact', { ...action, ...refs, tabId: bg }, 170_000); } catch (err) { threw = err; }
      const ms = Date.now() - t0;
      await sleep(1500);
      const effect = await evalIn(bg, readBack).catch(() => null);
      const detail = `${(ms / 1000).toFixed(1)} s · page effect ${effect}`;
      if (!threw && effect) {
        ok(`hidden ${label}: reported delivered, and the page really has it`, `${detail} · delivery=${reply?.delivery}`);
      } else if (!threw) {
        bad(`hidden ${label}: SUCCESS reported for input the page never received (EXT-01 regression)`, `${detail} · ${short(reply)}`);
      } else if (effect) {
        bad(`hidden ${label}: an error was reported for input that landed (an agent would repeat it)`, `${detail} · "${short(threw.message, 200)}"`);
      } else {
        check(/not-delivered|never received|HIDDEN|not visible/i.test(threw.message),
          `hidden ${label}: refused with an error naming the hidden tab, and the page got nothing`,
          `${detail} · "${short(threw.message, 200)}"`);
      }
      check(ms < 45_000, `hidden ${label}: answered within the tool's own budget`, `${(ms / 1000).toFixed(1)} s`);
      if (label === 'click' && threw) {
        // The remedy the tool description gives ("focus it first") works.
        await call('browser_tabs', { action: 'focus', tabId: bg });
        await waitFor(async () => ((await evalIn(bg, 'document.visibilityState')) === 'visible' ? true : null), { timeoutMs: 5000 });
        const again = await call('browser_interact', { ...action, ...refs, tabId: bg }).catch((e) => ({ error: e.message }));
        await sleep(200);
        const n = await evalIn(bg, 'window.clicks.n').catch(() => null);
        check(again.delivery === 'delivered' && n === 1, 'hidden click: after browser_tabs focus the same click is delivered, once',
          again.error ? `"${short(again.error, 120)}"` : `delivery=${again.delivery}, page clicks ${n}`);
      }
      // Closing the tab also ends any dispatch the extension is still doing there.
      await call('browser_tabs', { action: 'close', tabId: bg }).catch(() => {});
    }
    const back = await call('browser_tabs', { action: 'attach', tabId: mainTab });
    check(back.current === true, 're-attached the main tab (current again)');
    await activateMain();
  });

  // Sections 24-27 were added in live round 3 and run next to the checks they
  // extend (24-26 here, 27 after the issue video); their numbers are new so
  // G9_LIVE_SECTIONS keeps selecting the same sections as before.

  // --------------------------------------------------------------- witness
  await section('24. The delivery witness: a cancelled pointerdown is delivered; a press on a veil is "missed"', async () => {
    if (!FIXTURES) return skip('witness', NO_FIXTURES);
    await call('browser_navigate', { action: 'goto', url: PAGE + 'witness.html', waitUntil: 'load' });
    const s = await call('browser_snapshot');
    const cancels = refOf(s.tree, /button "Cancels pointerdown"/);
    const trap = refOf(s.tree, /button "Covered on arrival"/);
    const away = refOf(s.tree, /button "Somewhere else"/);
    if (!cancels || !trap || !away) return bad('witness fixture refs', short({ cancels, trap, away }));
    const w = () => evalIn(mainTab, 'JSON.parse(JSON.stringify(window.w))');
    const globalsBefore = await evalIn(mainTab, 'Object.getOwnPropertyNames(window)');
    const levels = ['off', 'human', 'stealth'];
    for (const level of levels) {
      if (cdp && !(await setInputMode(level))) { bad(`panel Input set to ${level}`); continue; }
      // 1. The page cancels pointerdown: the spec then suppresses mousedown
      //    and mouseup, and click still arrives (live round 2: 22/22 reported
      //    lost, and an agent told "lost" clicks again).
      const b = await w();
      let r = null;
      let err = null;
      try { r = await call('browser_interact', { action: 'click', ref: cancels, humanize: level, seed: `witness-${level}` }); } catch (e) { err = e; }
      await sleep(150);
      const a = await w();
      check(!err && r?.delivery === 'delivered' && a.cancelClicks === b.cancelClicks + 1 && a.cancelDowns === b.cancelDowns + 1,
        `${level}: a click on a page that cancels pointerdown is delivered, and the page got it`,
        err ? `error "${short(err.message, 160)}"` : `delivery=${r?.delivery}, page pointerdown ${b.cancelDowns}→${a.cancelDowns}, click ${b.cancelClicks}→${a.cancelClicks}, compat mousedown ${b.cancelMouseDowns}→${a.cancelMouseDowns} (suppressed by the spec)`);

      // 2. The target is veiled the moment the pointer arrives — after G9BrowserAgent's
      //    obstruction check passed — so the press lands on the veil.
      await call('browser_interact', { action: 'hover', ref: away, humanize: level, seed: `away-${level}` });
      await evalIn(mainTab, 'window.armTrap()');
      let reply = null;
      let threw = null;
      try { reply = await call('browser_interact', { action: 'click', ref: trap, humanize: level, seed: `trap-${level}` }); } catch (e) { threw = e; }
      await sleep(300);
      const t = await w();
      const msg = threw ? String(threw.message) : '';
      if (!threw) {
        bad(`${level}: a press that landed on another element was reported as success`, `delivery=${reply?.delivery} · page ${short(t)}`);
      } else {
        check(/<div#veil>/.test(msg) && /NOT repeated/.test(msg) && t.trapDowns === 0 && t.trapClicks === 0 && t.veilDowns === 1,
          `${level}: the press that landed on the veil is an error naming the veil, and it was not repeated`,
          `"${short(msg, 150)}" · page: trap pointerdown ${t.trapDowns}, trap click ${t.trapClicks}, veil pointerdown ${t.veilDowns}`);
      }
      await evalIn(mainTab, 'document.getElementById("veil")?.remove(), window.w.armed = false, true');
    }
    const added = ((await evalIn(mainTab, 'Object.getOwnPropertyNames(window)')) ?? []).filter((n) => !(globalsBefore ?? []).includes(n));
    check(added.length === 0, 'the witnesses left no global in the page main world (off, human, stealth)', added.join(', ') || 'unchanged');
    if (cdp) await setInputMode('human');
    await call('browser_navigate', { action: 'goto', url: mainUrl, waitUntil: 'load' });
  });

  // ----------------------------------------------------------- scroll settle
  await section('25. Scrolling returns once the page has settled, at the position it reports', async () => {
    if (!FIXTURES) return skip('scroll settle', NO_FIXTURES);
    const levels = ['off', 'human', 'stealth'];
    for (const level of levels) {
      if (cdp && !(await setInputMode(level))) { bad(`panel Input set to ${level}`); continue; }
      await call('browser_navigate', { action: 'goto', url: PAGE + 'clicks.html?scroll=' + level, waitUntil: 'load' });
      const read = () => evalIn(mainTab, '({ y: scrollY, scrolls: window.clicks.scrolls, wheels: window.clicks.wheels })');
      const r = await call('browser_interact', { action: 'scroll', direction: 'down', amount: 400, humanize: level, seed: `scroll-${level}` });
      const first = await read();
      await sleep(800);
      const later = await read();
      // Live round 2: 50/50 humanized scrolls returned while the page was still
      // moving, so the position reported was not where the page ended.
      check(r.delivery === 'delivered' && r.moved && Math.abs((r.position?.y ?? NaN) - first.y) <= 1 && later.y === first.y && later.scrolls === first.scrolls,
        `${level}: scroll delivered; reported position = the page's; nothing moved after the tool returned`,
        `reported y=${r.position?.y}, page y=${first.y} → ${later.y} 800 ms later, scroll events after return ${later.scrolls - first.scrolls}, via=${r.via ?? 'wheel'}${r.settled === false ? ', settled:false' : ''}`);
      if (level !== 'off') {
        check(first.wheels >= 1, `${level}: the page saw trusted wheel events (not a programmatic scroll)`, `${first.wheels} wheel event(s)`);
      }
    }
    if (cdp) await setInputMode('human');
    await call('browser_navigate', { action: 'goto', url: mainUrl, waitUntil: 'load' });
  });

  // ----------------------------------------------------- stealth screenshots
  await section('26. Screenshots at stealth: nothing the page can see', async () => {
    if (!cdp || !FIXTURES) return skip('stealth screenshots', cdp ? NO_FIXTURES : NO_CDP);
    if (!(await setInputMode('stealth'))) return bad('panel Input set to stealth');
    try {
      await call('browser_navigate', { action: 'goto', url: PAGE + 'clicks.html?shots=1', waitUntil: 'load' });
      const read = () => evalIn(mainTab, '({ y: scrollY, resizes: window.clicks.resizes.slice(), wheels: window.clicks.wheels, h: document.documentElement.scrollHeight, vh: innerHeight })');
      // Resize events are judged per step. The page ALREADY saw two at load,
      // and that is not the screenshot's doing: while chrome.debugger is
      // attached anywhere, the browser shows its "started debugging this
      // browser" infobar, and every cross-document load in EVERY tab (one G9BrowserAgent
      // never attached included) sees innerHeight jump ~1-40 px and come back
      // ~170 ms in; the same headless Edge with no extension shows none
      // (measured round 3, 808 px viewport vs 760). It is Engine 1's, it is
      // printed here, and it is not judged.
      const start = await read();
      console.log(`  \x1b[90mload-time resize events (the debugger infobar, not a G9BrowserAgent call): ${JSON.stringify(start.resizes)}\x1b[0m`);
      const vp = await call('browser_screenshot', { area: 'viewport' });
      await sleep(250);
      const afterVp = await read();
      check(vp.__image?.data?.length > 500 && afterVp.resizes.length === start.resizes.length, 'viewport shot at stealth; the page saw no resize',
        `${Math.round((vp.__image?.data?.length ?? 0) / 1365)} KB, new resize events ${JSON.stringify(afterVp.resizes.slice(start.resizes.length))}`);
      // An element far below the fold: reached with the WHEEL, captured with a
      // clip inside the viewport — no captureBeyondViewport, so no resize.
      const s = await call('browser_snapshot');
      const far = refOf(s.tree, /button "Far below"/);
      const beforeEl = await read();
      const el = await call('browser_screenshot', { area: 'element', ref: far });
      await sleep(250);
      const afterEl = await read();
      const elResizes = afterEl.resizes.slice(beforeEl.resizes.length);
      check(el.__image?.data?.length > 200 && elResizes.length === 0 && afterEl.wheels > beforeEl.wheels && afterEl.y > beforeEl.y && !el.pageSaw,
        'element shot below the fold: reached by trusted wheel, the page saw no resize',
        `scrolled ${beforeEl.y} → ${afterEl.y} via ${el.scrolled?.via ?? 'none'}, wheel events ${afterEl.wheels - beforeEl.wheels}, resize events during the call ${JSON.stringify(elResizes)}`);
      // A full page taller than the viewport would be a resize the page sees.
      let full = null;
      let refused = null;
      try { full = await call('browser_screenshot', { area: 'fullpage' }); } catch (e) { refused = e; }
      await sleep(250);
      const afterFull = await read();
      const fullResizes = afterFull.resizes.slice(afterEl.resizes.length);
      check(!!refused && /stealth/i.test(refused.message) && fullResizes.length === 0,
        `full-page shot of a ${start.h}px page in a ${start.vh}px viewport is refused at stealth, and nothing resized`,
        refused ? `"${short(refused.message, 110)}" · resize events during the call ${JSON.stringify(fullResizes)}` : `captured: ${short(full, 120)}`);
    } finally {
      await setInputMode('human');
    }
    // The same request at human is taken, and the page's view of it disclosed.
    const before = (await evalIn(mainTab, 'window.clicks.resizes.length')) ?? 0;
    const full = await call('browser_screenshot', { area: 'fullpage' }).catch((e) => ({ error: e.message }));
    await sleep(300);
    const seen = (await evalIn(mainTab, 'window.clicks.resizes.slice()')) ?? [];
    check(full.__image?.data?.length > 500 && typeof full.pageSaw === 'string' && full.pageSaw.length > 0,
      'human: the full-page shot is taken and its page-visible resize is disclosed (pageSaw)',
      `page saw ${seen.length - before} resize event(s) ${short(seen.slice(before), 80)}; pageSaw "${short(full.pageSaw ?? full.error, 90)}"`);
    await call('browser_navigate', { action: 'goto', url: mainUrl, waitUntil: 'load' });
  });

  // ---------------------------------------------------------------- recording
  await section('10. Recording in G9BrowserAgent\'s isolated world, replay with a verdict, main world clean', async () => {
    if (!FIXTURES) return skip('isolated recorder', NO_FIXTURES);
    await call('browser_navigate', { action: 'goto', url: PAGE + 'clean.html', waitUntil: 'load' });
    check((await mainWorldLeaks(mainTab)).length === 0, 'main world clean before recording');
    // Every own name of window, not only the __g9* pattern: a helper that
    // leaked under any other name would pass a name filter.
    const globalsBefore = await evalIn(mainTab, 'Object.getOwnPropertyNames(window)');
    const started = await call('browser_recording', { action: 'start', name: 'G9BrowserAgent live isolated recorder' });
    check(!!started, 'recording started', short(started, 100));
    const during = await mainWorldLeaks(mainTab);
    check(during.length === 0, 'main world clean WHILE recording (recorder and binding live in world "g9")', during.join(', ') || 'no __g9* names, no binding');
    try {
      await call('browser_recording', { action: 'start', name: 'second on the same tab' });
      bad('a second recording on a recording tab was accepted', 'v1 silently replaced the first and leaked its scripts');
    } catch (err) {
      ok('a second recording on the same tab is refused', short(err.message, 90));
    }
    const s = await call('browser_snapshot');
    await call('browser_interact', { action: 'type', ref: refOf(s.tree, /textbox "Your name"/), text: 'Ada', typos: false });
    await call('browser_interact', { action: 'click', ref: refOf(s.tree, /button "Greet"/) });
    await sleep(700);
    const stopped = await call('browser_recording', { action: 'stop' });
    const steps = await call('browser_recording', { action: 'get', id: stopped.id });
    const kinds = (steps.steps ?? []).map((x) => x.action ?? x.type).join(', ');
    check(stopped.id && stopped.steps >= 2 && /type|fill/.test(kinds) && /click/.test(kinds),
      'the isolated-world recorder captured the typing and the click', `${stopped.steps} steps: ${kinds}`);
    const after = await mainWorldLeaks(mainTab);
    check(after.length === 0, 'main world clean after recording', after.join(', ') || 'clean');
    await call('browser_recording', { action: 'assert', id: stopped.id, assertion: 'text', contains: 'Hello, Ada!' });
    const run = await call('browser_recording', { action: 'replay', id: stopped.id, timing: 'fast' }, 240_000);
    check(run.failed === 0 && run.passed === run.total && /^PASS/.test(run.verdict ?? ''),
      'replay passes with a verdict', `verdict=${run.verdict}, ${run.passed}/${run.total}, humanize=${short(run.humanize)}`);
    const result = await evalIn(mainTab, 'document.getElementById("result").textContent');
    check(result === 'Hello, Ada!', 'the replay really re-did the flow on the page', result);
    const leaks = await mainWorldLeaks(mainTab);
    check(leaks.length === 0, 'main world clean after replay', leaks.join(', ') || 'clean');
    const globalsAfter = await evalIn(mainTab, 'Object.getOwnPropertyNames(window)');
    const added = (globalsAfter ?? []).filter((n) => !(globalsBefore ?? []).includes(n));
    check(Array.isArray(globalsBefore) && globalsBefore.length > 100 && added.length === 0,
      'no new global of any name after recording and replay', added.length ? added.join(', ') : `${globalsBefore?.length} names, unchanged`);

    // A replay that cannot pass must say so, not report optimistic success.
    await call('browser_recording', { action: 'assert', id: stopped.id, assertion: 'text', contains: 'TEXT_THAT_DOES_NOT_EXIST_9F8E' });
    const failing = await call('browser_recording', { action: 'replay', id: stopped.id, timing: 'fast', stopOnFailure: false }, 240_000);
    check(failing.failed >= 1 && failing.verdict !== 'PASS' && /assertion failed/i.test(failing.steps?.find((x) => !x.ok)?.error ?? ''),
      'a failing assertion gives a failing verdict', `verdict=${failing.verdict}, failed=${failing.failed}`);
    await call('browser_recording', { action: 'delete', id: stopped.id });
    await call('browser_navigate', { action: 'goto', url: mainUrl, waitUntil: 'load' });
  });

  await section('11. Recorder assertions, run history and export on the test page', async () => {
    if (!onTestPage) return skip('assertion flow', 'not on the test page');
    await call('browser_recording', { action: 'start', name: 'G9BrowserAgent live assertion flow' });
    const liveSnap = await call('browser_snapshot');
    const envRef = refOf(liveSnap.tree, /combobox.*Environment/i);
    if (envRef) await call('browser_interact', { action: 'select', ref: envRef, values: 'Production' });
    const recorded = await call('browser_recording', { action: 'stop' });
    recorded.id && recorded.steps >= 2 ? ok('recording captured trusted select', recorded.steps + ' steps') : bad('recording did not capture select', short(recorded));
    await call('browser_recording', {
      action: 'update', id: recorded.id, suite: 'Live smoke', folder: 'setup',
      tags: ['live', 'regression'], environment: { name: 'local', variables: { expectedEnv: 'prd' } },
      parameters: { expectedTitle: 'G9BrowserAgent Test Page' },
    });
    const host = new URL(mainUrl).host;
    await call('browser_recording', { action: 'assert', id: recorded.id, assertion: 'url', contains: host, operator: 'contains' });
    await call('browser_recording', { action: 'assert', id: recorded.id, assertion: 'text', contains: '{{expectedTitle}}' });
    await call('browser_recording', { action: 'assert', id: recorded.id, assertion: 'visible', selector: '#hidden-assertion-target', expected: false });
    if (envRef) await call('browser_recording', { action: 'assert', id: recorded.id, assertion: 'value', ref: envRef, expected: '{{expectedEnv}}' });
    await call('browser_recording', { action: 'assert', id: recorded.id, assertion: 'network', contains: '/api/missing', minCount: 1 });
    await call('browser_recording', { action: 'assert', id: recorded.id, assertion: 'console', contains: 'THIS_MESSAGE_MUST_NOT_EXIST', absent: true });
    await call('browser_recording', { action: 'assert', id: recorded.id, assertion: 'a11y', maxViolations: 1 });
    await call('browser_recording', { action: 'assert', id: recorded.id, assertion: 'screenshot', threshold: 0.12 });
    const run = await call('browser_recording', { action: 'replay', id: recorded.id, timing: 'fast' }, 240_000);
    run.failed === 0 && run.passed === run.total
      ? ok('assertion replay passed with observable checks', `${run.passed}/${run.total}, verdict=${run.verdict}`)
      : bad('assertion replay failed', short(run.steps?.find((step) => !step.ok), 300));
    const saved = await call('browser_recording', { action: 'get', id: recorded.id });
    saved.runHistory?.length === 1 && saved.suite === 'Live smoke' ? ok('run history + suite metadata persisted') : bad('run history or metadata missing');
    const exported = await call('browser_recording', { action: 'export_test', id: recorded.id });
    /@playwright\/test/.test(exported.code ?? '') && /toHaveScreenshot/.test(exported.code ?? '')
      ? ok('Playwright test export', exported.code.split('\n').length + ' lines')
      : bad('Playwright export missing expected code');
    await call('browser_recording', { action: 'delete', id: recorded.id });
  });

  await section('12. Regression memory: aria baselines, known world, surprises, pinning', async () => {
    if (!onTestPage) return skip('regression memory', 'not on the test page');
    // A flow with a semantic baseline and a navigate step, so every replay
    // produces traffic and console output to compare. A flow that does nothing
    // gives the detector nothing to observe, which would prove nothing.
    await call('browser_recording', { action: 'start', name: 'G9BrowserAgent live regression memory' });
    await call('browser_navigate', { action: 'reload' });
    const flow = await call('browser_recording', { action: 'stop' });
    await call('browser_recording', { action: 'assert', id: flow.id, assertion: 'aria' });
    const seeded = await call('browser_recording', { action: 'replay', id: flow.id, timing: 'fast', signature: 'full', seedKnownWorld: true }, 240_000);
    seeded.failed === 0 && seeded.knownWorld?.runs === 1
      ? ok('aria baseline replays and seeds a known world', `verdict=${seeded.verdict}`)
      : bad('known world was not seeded', short({ failed: seeded.failed, kw: seeded.knownWorld }));
    // A second identical run must be quiet. A signature that is not normalised
    // shows HERE: the same page compared with itself invents findings (it
    // caught a real one on 2026-09-04 — a request captured mid-flight on one run
    // and completed on the next produced a spurious "new" and "missing" pair).
    const quiet = await call('browser_recording', { action: 'replay', id: flow.id, timing: 'fast', signature: 'full' }, 240_000);
    const noisy = (quiet.surprises ?? []).filter((item) => item.effectiveSeverity !== 'info');
    quiet.failed === 0 && noisy.length === 0
      ? ok('an unchanged page produces no surprises', `verdict=${quiet.verdict}`)
      : bad(quiet.failed ? 'an identical second replay FAILED' : 'signature is noisy against itself',
        short({ verdict: quiet.verdict, failed: quiet.failed, step: (quiet.steps ?? []).find((x) => !x.ok), surprises: noisy.slice(0, 3) }, 500));
    // Break the world underneath the flow WITHOUT changing an assertion: offline
    // is a regression the flow has no check for; the detector must notice alone.
    await call('browser_emulate', { network: 'offline' });
    const broken = await call('browser_recording', { action: 'replay', id: flow.id, timing: 'fast', signature: 'full', stopOnFailure: false }, 240_000);
    await call('browser_emulate', { reset: true });
    await call('browser_navigate', { action: 'reload' });
    const surprises = broken.surprises ?? [];
    const missingTraffic = surprises.find((item) => item.layer === 'network' && item.kind === 'missing');
    missingTraffic ? ok('traffic that always happened and now does not is caught', missingTraffic.key.slice(0, 60)) : bad('the missing-direction detector saw nothing', short(surprises.slice(0, 3), 300));
    surprises.length > 0 && broken.verdict !== 'PASS'
      ? ok('a run nobody wrote an assertion for is not reported as clean', `verdict=${broken.verdict}, ${surprises.length} surprise(s)`)
      : bad('a broken run was reported as PASS', short({ verdict: broken.verdict, surprises }, 300));
    const known = await call('browser_recording', { action: 'known_world', id: flow.id });
    known.runs === 1 ? ok('known world stays at its approved size', `${known.runs} approved run(s)`) : bad('known world grew without approval', short(known));
    await call('browser_recording', { action: 'delete', id: flow.id });

    // Network pinning: record the page's traffic, serve it back, prove a reload uses it.
    const captured = await call('browser_network', { action: 'record_har' });
    if (!captured.har?.log?.entries?.length) {
      bad('record_har produced no entries', short(captured));
    } else {
      ok('HAR captured for pinning', `${captured.recorded} entries`);
      const pinned = await call('browser_network', { action: 'pin', har: captured.har });
      pinned.pinned ? ok('network pinned', `${pinned.operations} operations`) : bad('pin did not engage', short(pinned));
      await call('browser_navigate', { action: 'reload' });
      const after = await call('browser_network', { action: 'pin_status' });
      after.served > 0 ? ok('pinned responses were served to a real reload', `${after.served} served, ${after.passedThrough} passed through`) : bad('pin served nothing on reload', short(after));
      const released = await call('browser_network', { action: 'unpin' });
      released.unpinned ? ok('network unpinned') : bad('unpin failed', short(released));
    }

    // The assertion wizard proposes from what was OBSERVED and adds nothing.
    // Reload first: the pinning above leaves a HAR-served page and a pruned
    // console, and the wizard would be testing those leftovers.
    await call('browser_navigate', { action: 'goto', url: mainUrl, waitUntil: 'load' });
    await call('browser_recording', { action: 'start', name: 'G9BrowserAgent live wizard' });
    const wizardFlow = await call('browser_recording', { action: 'stop' });
    const before = await call('browser_recording', { action: 'get', id: wizardFlow.id });
    const advice = await call('browser_recording', { action: 'suggest', id: wizardFlow.id });
    const afterGet = await call('browser_recording', { action: 'get', id: wizardFlow.id });
    const kinds = (advice.suggestions ?? []).map((item) => item.assertion);
    kinds.includes('url') && kinds.includes('aria') && kinds.includes('console') ? ok('wizard proposes observable assertions', kinds.join(', ')) : bad('wizard proposed too little', short(kinds));
    (advice.suggestions ?? []).every((item) => item.why && item.strength) ? ok('every suggestion carries a strength and a reason') : bad('a suggestion arrived with no rationale');
    const consoleAdvice = (advice.suggestions ?? []).find((item) => item.assertion === 'console');
    consoleAdvice?.strength === 'blocked' ? ok('a suggestion that would fail immediately is marked blocked') : bad('the wizard offered a console assertion the page cannot pass', short(consoleAdvice));
    (afterGet.steps?.length ?? 0) === (before.steps?.length ?? 0) ? ok('the wizard added nothing — a human still chooses') : bad('the wizard mutated the recording');
    await call('browser_recording', { action: 'delete', id: wizardFlow.id });

    // The FlowSpec round trip, against a real recording rather than a fixture.
    await call('browser_recording', { action: 'start', name: 'G9BrowserAgent live flowspec' });
    const specFlow = await call('browser_recording', { action: 'stop' });
    await call('browser_recording', { action: 'assert', id: specFlow.id, assertion: 'url', operator: 'contains', expected: '127.0.0.1' });
    const exported = await call('browser_recording', { action: 'export_spec', id: specFlow.id });
    const canonical = exported.json ?? '';
    canonical.includes('"format": "g9/flowspec"') && canonical.includes('"schemaVersion"') ? ok('FlowSpec exported in canonical form') : bad('FlowSpec export is not canonical', canonical.slice(0, 120));
    const reimported = await call('browser_recording', { action: 'import_spec', spec: exported.spec });
    reimported.steps === (exported.spec?.steps?.length ?? -1) ? ok('FlowSpec re-imports with every step', `${reimported.steps} steps`) : bad('FlowSpec round trip lost steps', short(reimported));
    await call('browser_recording', { action: 'delete', id: reimported.id }).catch(() => {});
    await call('browser_recording', { action: 'delete', id: specFlow.id }).catch(() => {});
  });

  // --------------------------------------------------------------- issue video
  await section('13. Issue video with pointer-track.json', async () => {
    if (!FIXTURES) return skip('issue video', NO_FIXTURES);
    await call('browser_navigate', { action: 'goto', url: PAGE + 'clicks.html', waitUntil: 'load' });
    const s = await call('browser_snapshot');
    const target = refOf(s.tree, /button "Press me"/);
    const note = refOf(s.tree, /textbox "Note"/);
    const issue = await call('browser_issue', { action: 'create', title: 'G9BrowserAgent live video + pointer check', withScreenshot: false });
    await call('browser_issue', { action: 'video_start', id: issue.id });
    // Pointer work while it records: a humanized hover and click make a track.
    await call('browser_interact', { action: 'hover', ref: note });
    await call('browser_interact', { action: 'click', ref: target });
    // Wait for a FRAME, not for a duration. `sleep(600)` once made this a race
    // with the compositor: three runs gave PASS, SKIP and FAIL from identical
    // code, which teaches people to re-run until green.
    let frames = 0;
    for (let waited = 0; waited < 6000; waited += 250) {
      const vs = await call('browser_issue', { action: 'video_status', id: issue.id }).catch(() => null);
      frames = vs?.frames ?? 0;
      if (frames > 2) break;
      await sleep(250);
    }
    const video = await call('browser_issue', { action: 'video_stop', id: issue.id });
    const got = await call('browser_issue', { action: 'get', id: issue.id });
    const attachments = got.attachments ?? got.issue?.attachments ?? [];
    const vid = attachments.find((a) => a.kind === 'video');
    const track = attachments.find((a) => a.name === 'pointer-track.json');
    if (!video.attached && video.frames === 0) {
      bad('no video frames', short(video, 300));
    } else {
      check(video.attached === true && !!vid, 'video frames spooled and attached', `${video.frames} frames`);
    }
    check(!!track && video.pointerTrack?.samples > 0, 'pointer-track.json attached with samples', short(video.pointerTrack ?? track));
    if (track) {
      const full = await call('browser_issue', { action: 'attachment', attachmentId: track.id, includeBytes: true });
      const b64 = full.dataBase64 ?? full.attachment?.dataBase64 ?? full.data ?? null;
      const json = b64 ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : null;
      const samples = json?.samples ?? [];
      check(json?.format === 'g9-pointer/1' && samples.length > 3 && samples.every((p) => Number.isFinite(p.t) && Number.isFinite(p.x) && Number.isFinite(p.y)),
        'the track is g9-pointer/1 with timed x/y samples', `${samples.length} samples, viewport ${short(json?.viewport)}`);
      check(samples.some((p) => p.type === 'mousePressed' || p.buttons > 0), 'the track includes the click press');
    }
    if (vid) {
      const full = await call('browser_issue', { action: 'attachment', attachmentId: vid.id, includeBytes: true });
      const b64 = full.dataBase64 ?? full.attachment?.dataBase64 ?? null;
      const json = b64 ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : null;
      check(json?.format === 'g9-frames/1' && json.frames?.some((f) => f.pointer), 'video frames carry the pointer sampled at frame time', `${json?.frames?.length ?? 0} frames`);
    }
    await call('browser_issue', { action: 'delete', id: issue.id });
    await call('browser_navigate', { action: 'goto', url: mainUrl, waitUntil: 'load' });
  });

  // --------------------------------------------------------------- live watch
  await section('27. Watching a tab from the desktop: live frames, and a hidden tab says so', async () => {
    if (!FIXTURES) return skip('live watch', NO_FIXTURES);
    // The desktop's Watch view is a UI client of the daemon; this is that
    // client, on the same private daemon. Round 3 (bench B5): a watch on a
    // hidden tab sent one frame and then nothing, and nothing said why.
    const { WsClient } = await import('../lib/ws-client.mjs');
    const ui = await WsClient.connect(`ws://127.0.0.1:${PORT}/g9`, { timeoutMs: 5000 });
    const events = [];
    const waiting = new Map();
    let welcomed = null;
    const welcome = new Promise((resolve) => { welcomed = resolve; });
    ui.on('error', () => {});
    ui.on('message', (m) => {
      if (m?.type === 'welcome') welcomed(m);
      else if (m?.type === 'event') events.push({ ...m, seenAt: Date.now() });
      else if (m?.type === 'result' && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    });
    let nextId = 1;
    const admin = (op, args = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => { waiting.delete(id); reject(new Error(`admin ${op} timed out`)); }, 15_000);
      waiting.set(id, (m) => { clearTimeout(t); m.ok ? resolve(m.result) : reject(new Error(String(m.error))); });
      ui.send({ type: 'admin', id, op, ...args });
    });
    try {
      ui.send({ type: 'hello', role: 'ui', version: VERSION, client: { name: 'livetest-watch', pid: process.pid } });
      await Promise.race([welcome, sleep(5000)]);
      const of = (tabId, topic) => events.filter((e) => e.topic === topic && e.data?.tabId === tabId);

      // 1. The tab in front: frames and the pointer track arrive.
      await call('browser_navigate', { action: 'goto', url: PAGE + 'clicks.html?watch=1', waitUntil: 'load' });
      await activateMain();
      const started = await admin('watch', { tabId: mainTab });
      const s = await call('browser_snapshot');
      await call('browser_interact', { action: 'hover', ref: refOf(s.tree, /textbox "Note"/) });
      await waitFor(async () => (of(mainTab, 'frame').length >= 3 && of(mainTab, 'pointer').length >= 1 ? true : null), { timeoutMs: 8000 });
      const frames = of(mainTab, 'frame');
      const pointers = of(mainTab, 'pointer');
      const hiddenMain = of(mainTab, 'watchStatus').filter((e) => e.data.state === 'hidden');
      check(started?.watching !== false && frames.length >= 3 && pointers.length >= 1 && hiddenMain.length === 0 && typeof frames[0].data?.data === 'string',
        'a watch on the tab in front streams frames and the pointer, and never says hidden',
        `${frames.length} frame(s), ${pointers.length} pointer sample(s), watchStatus ${JSON.stringify(of(mainTab, 'watchStatus').map((e) => e.data.state))}, run ${started?.runId ?? '-'}`);
      await admin('unwatch', { tabId: mainTab });

      // 2. A background (hidden) tab: the viewer is TOLD the picture is not live.
      const opened = await call('browser_tabs', { action: 'open', url: PAGE + 'background.html?watch' });
      const bg = opened.tabId;
      await loadedIn(bg);
      const vis = await evalIn(bg, 'document.visibilityState');
      const t0 = Date.now();
      await admin('watch', { tabId: bg });
      const told = await waitFor(async () => of(bg, 'watchStatus').find((e) => e.data.state === 'hidden') ?? null, { timeoutMs: 8000 });
      await sleep(2500); // hysteresis: a stray frame must not flip it back to "live"
      const states = of(bg, 'watchStatus').map((e) => e.data.state);
      check(vis === 'hidden' && !!told && states.at(-1) === 'hidden' && /hidden/i.test(told.data.reason ?? ''),
        'a watch on a hidden background tab tells the viewer it is not live',
        `visibility ${vis}, watchStatus ${JSON.stringify(states)} after ${told ? told.seenAt - t0 : '-'} ms, ${of(bg, 'frame').length} frame(s)`);
      await admin('unwatch', { tabId: bg });
      await call('browser_tabs', { action: 'close', tabId: bg }).catch(() => {});
    } finally {
      try { ui.close(); } catch {}
      await call('browser_tabs', { action: 'attach', tabId: mainTab }).catch(() => {});
      await activateMain();
      await call('browser_navigate', { action: 'goto', url: mainUrl, waitUntil: 'load' }).catch(() => {});
    }
  });

  await section('28. The live view: an agent opens the watch window, which streams the tab as a viewer', async () => {
    if (!FIXTURES) return skip('live view', NO_FIXTURES);
    // (3.2) browser_tabs action:"watch": the daemon asks this browser's extension to open
    // panel/watch.html, which connects to the daemon itself (role "viewer") and draws the frames.
    const watchPages = async () => (await targets()).filter((t) => t.type === 'page' && t.url.startsWith(extUrl('panel/watch.html')));
    for (const t of await watchPages()) await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    await call('browser_navigate', { action: 'goto', url: PAGE + 'clicks.html?liveview=1', waitUntil: 'load' });
    await activateMain();
    let page = null;
    try {
      const opened = await call('browser_tabs', { action: 'watch', tabId: mainTab });
      check(opened?.shown === true && (opened.shownIn ?? []).some((w) => /^browser \(/.test(w)), 'browser_tabs action:"watch" is shown in the person\'s browser', JSON.stringify(opened?.shownIn));
      const target = await waitFor(async () => (await watchPages())[0] ?? null, { timeoutMs: 10_000 });
      check(!!target && new URL(target.url).searchParams.get('tab') === String(mainTab), 'the extension opens panel/watch.html on that tab', target?.url ?? 'no watch page');
      if (!target) return;
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
      page = { targetId: target.targetId, evaluate: (expr) => cdp.evaluate(expr, sessionId) };
      await activateMain();
      // Something to paint: the pointer moves on the page.
      const snapped = await call('browser_snapshot');
      await call('browser_interact', { action: 'hover', ref: refOf(snapped.tree, /textbox "Note"/) });
      const drawn = await waitFor(async () => (await page.evaluate(String.raw`(() => {
        const tiles = document.querySelectorAll('.watch-tile');
        const c = document.querySelector('.watch-tile canvas');
        if (tiles.length !== 1 || !c || c.width < 50) return null;
        const d = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
        const hud = document.querySelector('.watch-hud')?.textContent ?? '';
        return !(d[0] === 15 && d[1] === 20 && d[2] === 27) && hud.includes('fps')
          ? { conn: document.getElementById('wConn').textContent, hud, state: document.querySelector('.watch-state')?.textContent } : null;
      })()`).catch(() => null)), { timeoutMs: 15_000 });
      check(!!drawn && /Connected/.test(drawn.conn), 'the watch page connects as a viewer and draws the tab\'s frames', JSON.stringify(drawn));
      // The agent closes it again: the tile goes.
      await call('browser_tabs', { action: 'watch', tabId: mainTab, on: false });
      const gone = await waitFor(async () => ((await page.evaluate("document.querySelectorAll('.watch-tile').length").catch(() => -1)) === 0 ? true : null), { timeoutMs: 8000 });
      check(!!gone, 'on:false takes the tab out of the live view', gone ? 'removed' : 'still shown');
    } finally {
      for (const t of await watchPages()) await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
      await activateMain();
      await call('browser_navigate', { action: 'goto', url: mainUrl, waitUntil: 'load' }).catch(() => {});
    }
  });

  // ----------------------------------------------------------- misc tool checks
  await section('14. Error quality, screenshot, emulation', async () => {
    // Replays navigate and invalidate prior refs. A fresh generation makes this
    // exercise the unknown-ref branch specifically.
    await call('browser_snapshot');
    try {
      await call('browser_interact', { action: 'click', ref: 'e9999' });
      bad('bogus ref was accepted');
    } catch (err) {
      /Unknown element ref/i.test(err.message) ? ok('bogus ref rejected with guidance', short(err.message, 90)) : bad('unhelpful error', short(err.message, 90));
    }
    // No retry here on purpose: capture.js retries a stalled capture itself.
    const shot = await call('browser_screenshot', { area: 'viewport' });
    shot.__image?.data?.length > 500 ? ok('screenshot captured', `${Math.round(shot.__image.data.length / 1365)} KB, ${shot.__image.mimeType}`) : bad('screenshot empty', short(shot));
    await call('browser_emulate', { device: 'iphone-15' });
    await sleep(300);
    const mobile = await evalIn(mainTab, '({ w: innerWidth, h: innerHeight })');
    mobile?.w === 393 ? ok('device emulation applied', `viewport ${mobile.w}x${mobile.h}`) : bad('emulation did not apply', short(mobile));
    await call('browser_emulate', { reset: true });
    ok('emulation reset');
  });

  // The QA ledger once wrote this off as "a browser limit no amount of
  // development removes". It is not: a cross-origin frame runs in its own
  // process, and CDP reaches it through flat sessions. It has to be live — the
  // question is whether the browser really hands the child session over.
  await section('15. Cross-origin iframe', async () => {
    if (!onTestPage) return skip('cross-origin iframe', 'not on the test page');
    const s = await call('browser_snapshot', { maxNodes: 900 });
    const tree = s.tree ?? '';
    if (!tree.includes('cross-origin frame')) return bad('the cross-origin frame was not attached', 'no frame header in the snapshot');
    if (!/Pay now/.test(tree)) return bad('the frame attached but its contents are missing', 'no "Pay now" button in the tree');
    ok('a cross-origin iframe appears in the snapshot');
    // Round 3: browser_inspect frames listed the top document alone, because
    // an out-of-process frame is not in the page session's frame tree.
    const fr = (await call('browser_inspect', { what: 'frames' })).frames ?? [];
    const oopif = fr.find((f) => /\/crossframe\.html/.test(f.url ?? ''));
    check(!!oopif && oopif.crossProcess === true && /localhost/.test(oopif.securityOrigin ?? oopif.url) && oopif.depth >= 1,
      'browser_inspect frames lists the cross-origin frame under its parent', oopif ? `${oopif.url} depth ${oopif.depth}, crossProcess ${oopif.crossProcess}` : short(fr.map((f) => f.url), 200));
    const payRef = (tree.match(/button "Pay now" \[ref=(e\d+)\]/) ?? [])[1];
    const cardRef = (tree.match(/textbox "Card number" \[ref=(e\d+)\]/) ?? [])[1];
    if (!payRef) return bad('the frame is visible but its button has no ref');
    if (cardRef) {
      const typed = await call('browser_interact', { action: 'type', ref: cardRef, text: '4111111111111111', typos: false });
      check(typed.delivery === 'delivered', 'typing inside the cross-origin frame delivered', `delivery=${typed.delivery}`);
    }
    const clicked = await call('browser_interact', { action: 'click', ref: payRef });
    // Read the TREE, not the page text: an evaluate reads the main document
    // only, so a frame that happily said PAID would look like a failure.
    const after = await call('browser_snapshot', { maxNodes: 900 });
    /PAID/.test(after.tree ?? '')
      ? ok('clicking INSIDE the cross-origin frame worked', `the frame reported PAID · delivery=${clicked.delivery}`)
      : bad('the click did not reach the frame', `clicked at ${short(clicked?.at)} · delivery=${clicked.delivery}`);
  });

  // ------------------------------------------------------------------- popout
  await section('16. Popout: the tab moves into its own window and keeps its state', async () => {
    if (!FIXTURES) return skip('popout', NO_FIXTURES);
    const opened = await call('browser_tabs', { action: 'open', url: PAGE + 'popout.html', focus: true });
    const tab = opened.tabId;
    await loadedIn(tab);
    const marker = `kept-${Date.now()}`;
    const before = await evalIn(tab, `(window.liveMarker = ${JSON.stringify(marker)}, { origin: performance.timeOrigin, nav: performance.getEntriesByType('navigation').length })`);
    const listedBefore = rowFor((await call('browser_tabs', { action: 'list' })).tabs ?? [], PAGE + 'popout.html');
    const cdpTarget = cdp ? (await targets()).find((t) => t.url === PAGE + 'popout.html') : null;
    const winBefore = cdpTarget ? await cdp.send('Browser.getWindowForTarget', { targetId: cdpTarget.targetId }).catch(() => null) : null;
    const res = await call('browser_tabs', { action: 'popout', tabId: tab, width: 900, height: 700 });
    check(res.tabId === tab && Number.isInteger(res.windowId) && res.windowId !== listedBefore?.windowId && /minimi/i.test(res.note ?? ''),
      'popout moved the tab into a new window (and says not to minimise it)', `window ${listedBefore?.windowId} → ${res.windowId}`);
    await sleep(500);
    const afterState = await evalIn(tab, '({ marker: window.liveMarker, origin: performance.timeOrigin, nav: performance.getEntriesByType("navigation").length, state: document.visibilityState })');
    check(afterState?.marker === marker && afterState.origin === before.origin,
      'the page kept its JavaScript state: no reload', `marker "${afterState?.marker}", timeOrigin ${before.origin} → ${afterState?.origin}`);
    const listedAfter = rowFor((await call('browser_tabs', { action: 'list' })).tabs ?? [], PAGE + 'popout.html');
    check(listedAfter?.windowId === res.windowId && listedAfter?.tabId === tab && listedAfter?.active === true && listedAfter?.attached === true,
      'the same tab handle, active and still attached, in the new window', short(listedAfter));
    if (cdp && cdpTarget) {
      const winAfter = await cdp.send('Browser.getWindowForTarget', { targetId: cdpTarget.targetId }).catch(() => null);
      check(winAfter && winBefore && winAfter.windowId !== winBefore.windowId && winAfter.bounds?.windowState !== 'minimized',
        'the browser agrees: another window, not minimised', `${winBefore?.windowId} → ${winAfter?.windowId} (${winAfter?.bounds?.windowState}, ${winAfter?.bounds?.width}x${winAfter?.bounds?.height})`);
    }
    // The point of popping out: the tab is its window's active tab, so input lands.
    //
    // The FIRST snapshot after the move is judged on its own: an agent takes
    // one right after popout. (Chrome for Testing, live round 3: 1 run in 3
    // returned a tree without the button there, and the tab listed with an
    // empty title.) If it misses, later snapshots say whether it recovered.
    const t0 = Date.now();
    let s = await call('browser_snapshot', { tabId: tab });
    let buttonRef = refOf(s.tree, /button "Press me"/);
    if (!buttonRef) {
      const first = String(s.tree ?? '').split('\n').slice(0, 4).join(' | ');
      const later = await waitFor(async () => {
        const again = await call('browser_snapshot', { tabId: tab });
        return refOf(again.tree, /button "Press me"/) ? again : null;
      }, { timeoutMs: 8000, every: 500 });
      bad('the first snapshot after popout shows the page', `no "Press me" in it: "${short(first, 200)}" · title in list "${listedAfter?.title}" · ` +
        (later ? `present ${Date.now() - t0} ms after popout` : 'still missing 8 s later'));
      if (!later) return;
      s = later;
      buttonRef = refOf(s.tree, /button "Press me"/);
    }
    const c = await call('browser_interact', { action: 'click', ref: buttonRef, tabId: tab });
    const n = await evalIn(tab, 'window.clicks.trusted');
    check(c.delivery === 'delivered' && n === 1, 'input is delivered in the popped-out window', `delivery=${c.delivery}, page trusted clicks ${n}`);
    await call('browser_tabs', { action: 'close', tabId: tab });
    await call('browser_tabs', { action: 'attach', tabId: mainTab });
    await activateMain();
  });

  // ------------------------------------------------------------------ handoff
  await section('17. Handoff to Engine 2 through the daemon', async () => {
    if (!onTestPage) return skip('handoff', 'not on the test page');
    // The login in section 7 left a cookie and a localStorage entry; make sure
    // they are there, or the transfer below proves nothing.
    await call('browser_navigate', { action: 'goto', url: mainUrl, waitUntil: 'load' });
    const source = await evalIn(mainTab, '({ cookie: document.cookie, ls: localStorage.getItem("g9_session") })');
    if (!/g9_test_session=/.test(source?.cookie ?? '') || !source?.ls) {
      await evalIn(mainTab, 'document.cookie = "g9_test_session=" + btoa("admin") + "; path=/; SameSite=Lax"; localStorage.setItem("g9_session", JSON.stringify({ user: "admin", at: 1 })); true');
    }
    const expected = await evalIn(mainTab, '({ cookie: document.cookie, ls: localStorage.getItem("g9_session") })');
    const t0 = Date.now();
    const res = await call('browser_tabs', { action: 'handoff', tabId: mainTab }, 240_000);
    const ms = Date.now() - t0;
    check(Number.isInteger(res.tabId) && res.tabId !== mainTab && typeof res.engineId === 'string',
      'handoff returned a new tab in a launched engine', `tab ${res.tabId} in ${res.engineId}, ${ms} ms`);
    check(res.transferred?.cookies >= 2 && res.transferred?.localStorage >= 1 && (res.notTransferred ?? []).includes('in-memory page state'),
      'cookies (HttpOnly included) and localStorage travelled; what cannot is named', short({ transferred: res.transferred, notTransferred: res.notTransferred }));
    const there = await evalIn(res.tabId, '({ cookie: document.cookie, ls: localStorage.getItem("g9_session"), href: location.href, webdriver: navigator.webdriver })');
    const cookieValue = /g9_test_session=([^;]+)/.exec(expected.cookie ?? '')?.[1];
    check(there?.href === mainUrl && cookieValue && there.cookie.includes(`g9_test_session=${cookieValue}`) && there.ls === expected.ls,
      'the page in Engine 2 sees the cookie and the localStorage value', `href ${there?.href}, cookie "${there?.cookie}", ls ${there?.ls}`);
    const jar = await call('browser_inspect', { what: 'cookies', tabId: res.tabId });
    check((jar.cookies ?? []).some((c) => c.name === 'g9_httponly' && c.httpOnly), 'the HttpOnly cookie arrived as HttpOnly');
    const engines = await call('browser_engine', { action: 'list' });
    const launched = (engines.engines ?? engines.list ?? []).find((e) => e.engineId === res.engineId);
    check(launched && launched.headless === true, 'Engine 2 is a headless launched browser', short(launched ? { engineId: launched.engineId, browser: launched.browser, version: launched.version, headless: launched.headless } : engines, 200));
    // Live round 2's blocker: a fresh Edge profile signed itself in to the
    // Windows account and synced it. The handoff launches a browser too, so
    // the fix is checked on this path: the argv the daemon recorded, and the
    // profile's own files (booleans only — never an identity).
    if (HOME) {
      const info = await readFile(path.join(HOME, 'engines', 'log', `${res.engineId}.json`), 'utf8').then(JSON.parse).catch(() => null);
      const argv = info?.argv ?? [];
      const features = argv.filter((a) => a.startsWith('--disable-features=')).join(',');
      check(argv.includes('--disable-sync') && /\bmsImplicitSignin\b/.test(features),
        'Engine 2 was launched with sync and implicit sign-in off', info ? `profile "${info.profile}", ${argv.length} args, disable-features=${features.replace(/^--disable-features=/, '').slice(0, 90)}` : 'no engine log');
      if (info?.profile) {
        const { signInState } = await import('../engine/profile.js');
        const sin = await signInState(info.profile, { home: HOME }).catch((e) => ({ error: e.message }));
        check(sin.signedIn === false, 'the Engine 2 profile is not signed in to any browser account',
          sin.error ?? `signedIn=${sin.signedIn}, account_info entries ${sin.accountInfo}, read ${sin.checked?.join(' + ')}`);
      }
    } else skip('Engine 2 sign-in state', 'needs G9_HOME');
    const rows = (await call('browser_tabs', { action: 'list' })).tabs ?? [];
    check(rows.some((r) => r.tabId === mainTab && r.engineKind === 'extension'), 'the person\'s own tab is untouched, still in the extension');
    const stop = await call('browser_engine', { action: 'stop', engineId: res.engineId });
    const left = await call('browser_engine', { action: 'list' });
    check(!(left.engines ?? []).some((e) => e.engineId === res.engineId), 'the launched engine stopped', short(stop, 120));
    await call('browser_tabs', { action: 'attach', tabId: mainTab });
    await activateMain();

    // The person's own button: the panel's "Send to background" goes
    // extension → daemon as a request (sw.js transport.request('handoff')),
    // a different path from an agent's browser_tabs handoff.
    if (!cdp) return skip('panel handoff button', NO_CDP);
    const p = await openPanel();
    await waitFor(async () => ((await p.evaluate('!document.getElementById("handoffTab").disabled')) ? true : null), { timeoutMs: 8000 });
    const t1 = Date.now();
    await p.evaluate('document.getElementById("handoffTab").click(); true');
    const shown = await waitFor(async () => {
      const r = await p.evaluate('({ cls: document.getElementById("tabResult")?.className, text: document.getElementById("tabResult")?.innerText })');
      return /\b(good|bad)\b/.test(r?.cls ?? '') ? r : null;
    }, { timeoutMs: 60_000, every: 300 });
    const panelMs = Date.now() - t1;
    const launchedRow = ((await call('browser_tabs', { action: 'list' })).tabs ?? []).find((r) => r.engineKind === 'launched' && r.url === mainUrl);
    const seen = launchedRow ? await evalIn(launchedRow.tabId, '({ cookie: document.cookie, ls: localStorage.getItem("g9_session") })').catch(() => null) : null;
    check(/\bgood\b/.test(shown?.cls ?? '') && !!launchedRow && seen?.cookie?.includes(`g9_test_session=${cookieValue}`) && seen?.ls === expected.ls,
      'the panel\'s "Send to background" hands the tab off too; the page there has the cookie and localStorage',
      `${panelMs} ms · panel: "${short((shown?.text ?? 'nothing shown').replace(/\s+/g, ' '), 110)}" · launched tab ${launchedRow?.tabId ?? '-'}`);
    if (launchedRow?.engine) await call('browser_engine', { action: 'stop', engineId: launchedRow.engine }).catch(() => {});
    const leftover = ((await call('browser_engine', { action: 'list' })).engines ?? []).filter((e) => e.kind === 'launched');
    for (const e of leftover) await call('browser_engine', { action: 'stop', engineId: e.engineId }).catch(() => {});
    await call('browser_tabs', { action: 'attach', tabId: mainTab });
    await activateMain();
  });

  // -------------------------------------------------------------- auto-attach
  // v3: three settings (Off / Project sites / All tabs), picked in the panel's segmented control.
  await section('18. Auto-attach: Off, Project sites, All tabs (the panel\'s control)', async () => {
    if (!cdp || !FIXTURES) return skip('auto-attach', cdp ? NO_FIXTURES : NO_CDP);
    const p = await openPanel();
    const pick = async (mode, want) => {
      await p.evaluate(`document.querySelector('input[name="autoAttach"][value="${mode}"]').click(); true`);
      return waitFor(async () => {
        const st = await call('browser_status');
        return st.autoAttachMode === mode && st.autoAttach === want ? st : null;
      }, { timeoutMs: 6000 });
    };
    const attachedState = async (url) => rowFor((await call('browser_tabs', { action: 'list' })).tabs ?? [], url)?.attached;
    const opened = [];
    const openAndWait = async (query, ms = 3000) => {
      const t = await cdp.send('Target.createTarget', { url: PAGE + 'auto.html?' + query, background: true });
      opened.push(t.targetId);
      await sleep(ms);
      return attachedState(PAGE + 'auto.html?' + query);
    };

    check(!!(await pick('all', true)), 'All tabs: browser_status reports autoAttachMode "all", autoAttach true');
    await cdp.send('Target.createTarget', { url: PAGE + 'auto.html?on=1', background: true }).then((t) => opened.push(t.targetId));
    const onAttached = await waitFor(async () => (await attachedState(PAGE + 'auto.html?on=1')) === true, { timeoutMs: 10_000 });
    check(!!onAttached, 'a tab opened under All tabs attaches by itself');
    check(!!(await pick('off', false)), 'Off: autoAttachMode "off", autoAttach false');
    const offState = await openAndWait('off=1');
    check(offState === false, 'a tab opened under Off stays unattached', `attached=${offState}`);
    // The default, and with no project domains known (no agent here has a g9.project.json with
    // environments), it behaves as Off: the fixture server is on no project's site either way.
    check(!!(await pick('project', false)), 'Project sites with no project known: autoAttachMode "project", autoAttach false');
    const projectState = await openAndWait('project=1');
    check(projectState === false, 'a tab opened under Project sites, on no project site, stays unattached', `attached=${projectState}`);
    for (const targetId of opened) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    await activateMain();
  });

  // -------------------------------------------------------------- versions
  await section('19. The version, in the side panel and on the welcome page', async () => {
    if (!cdp || !EXT_ID) return skip('version in extension pages', NO_CDP);
    const p = await openPanel();
    const ui = await p.evaluate('({ title: document.title, badge: document.getElementById("versionBadge")?.textContent, brand: document.querySelector(".hd .name")?.textContent })');
    check(ui.title === `G9BrowserAgent v${VERSION}` && ui.badge === `v${VERSION}`, 'side panel: title and header badge name the version', short(ui));
    const w = await openPage(extUrl('panel/welcome.html'));
    await sleep(300);
    const wel = await w.evaluate('({ title: document.title, ver: document.getElementById("ver")?.textContent, footer: document.getElementById("footer")?.textContent })');
    check(wel.title.startsWith(`G9BrowserAgent v${VERSION}`) && wel.ver === `v${VERSION}` && wel.footer.includes(`v${VERSION}`),
      'welcome page: title, big version and footer', short(wel));
    await w.close();
    const manifest = JSON.parse(await readFile(path.join(EXT_DIR ?? path.join(ROOT, 'extension'), 'manifest.json'), 'utf8'));
    check(manifest.version === VERSION, 'the loaded manifest is v' + VERSION);
    await activateMain();
  });

  // ------------------------------------------------------------ Stop / Resume
  await section('20. Stop in the panel reaches the daemon; Resume lifts it', async () => {
    if (!cdp || !EXT_ID) return skip('panel Stop', NO_CDP);
    const p = await openPanel();
    await p.evaluate('document.getElementById("stop").click(); true');
    const halted = await waitFor(async () => {
      const st = await call('browser_status');
      return st.halted?.global === true ? st : null;
    }, { timeoutMs: 8000 });
    check(halted?.halted?.global === true && halted.halted.by === 'panel', 'the daemon holds a GLOBAL halt, by the panel', short(halted?.halted));
    try {
      await call('browser_snapshot');
      bad('a page tool still worked after Stop');
    } catch (err) {
      check(/pressed Stop/i.test(err.message), 'a shim call fails with the halt message', short(err.message, 120));
    }
    // Answered by the daemon itself, never reaching the extension: proof the
    // Stop propagated, rather than the extension refusing on its own.
    try {
      await call('browser_engine', { action: 'list' });
      bad('a daemon-only tool still worked after Stop');
    } catch (err) {
      check(/pressed Stop/i.test(err.message), 'a tool the daemon answers itself (browser_engine) is halted too', short(err.message, 120));
    }
    const title = await waitFor(async () => {
      const t = await p.evaluate('document.title');
      return t.startsWith('Stopped · ') ? t : null;
    }, { timeoutMs: 5000 });
    check(!!title, 'the panel title says Stopped', title ?? '');
    await p.evaluate('document.getElementById("stop").click(); true');
    const resumed = await waitFor(async () => ((await call('browser_status')).halted?.global === false ? true : null), { timeoutMs: 8000 });
    check(!!resumed, 'Resume in the panel lifts the daemon\'s halt');
    const again = await call('browser_snapshot').catch((e) => ({ error: e.message }));
    check(!!again.tree, 'page tools work again', again.error ?? '');

    // Stop while an action is IN FLIGHT: long humanized typing (seconds of
    // keystrokes) must end at the Stop, fail, and send nothing more. The page
    // is read over the browser's own DevTools, because every G9BrowserAgent tool is
    // blocked while halted — which is the point.
    if (FIXTURES) {
      await call('browser_navigate', { action: 'goto', url: PAGE + 'clicks.html?stop=1', waitUntil: 'load' });
      await activateMain();
      const snapNow = await call('browser_snapshot');
      const note = refOf(snapNow.tree, /textbox "Note"/);
      const target = (await targets()).find((x) => x.type === 'page' && x.url === PAGE + 'clicks.html?stop=1');
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      const valueLength = () => cdp.evaluate('document.getElementById("note").value.length', sessionId);
      const text = 'the quick brown fox jumps over the lazy dog '.repeat(4);
      const typing = call('browser_interact', { action: 'type', ref: note, text, typos: false, humanize: 'human' }, 120_000)
        .then((r) => ({ r }), (e) => ({ e }));
      const begun = await waitFor(async () => ((await valueLength()) >= 5 ? true : null), { timeoutMs: 15_000, every: 100 });
      const tStop = Date.now();
      await p.evaluate('document.getElementById("stop").click(); true');
      const out = await typing;
      const endedMs = Date.now() - tStop;
      const atEnd = await valueLength();
      await sleep(2000);
      const later = await valueLength();
      check(!!begun && !!out.e && /Stop/i.test(out.e.message) && endedMs < 3000 && later === atEnd && later < text.length,
        'Stop during a long humanized typing ends it: the call fails, and no key arrives after it',
        `${out.e ? `failed after ${endedMs} ms: "${short(out.e.message, 90)}"` : `SUCCEEDED: ${short(out.r, 90)}`} · field ${atEnd} chars at the end, ${later} 2 s later, of ${text.length}`);
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      await p.evaluate('document.getElementById("stop").click(); true');
      const resumed2 = await waitFor(async () => ((await call('browser_status')).halted?.global === false ? true : null), { timeoutMs: 8000 });
      check(!!resumed2, 'Resume after the in-flight Stop lifts the halt again');
      await call('browser_navigate', { action: 'goto', url: mainUrl, waitUntil: 'load' }).catch(() => {});
    }
    await activateMain();
  });

  // ----------------------------------------------------- connection stability
  await section('21. Connection stability', async () => {
    if (!HOME) return skip('connection stability', 'needs G9_HOME to read the daemon log');
    const log = await readFile(path.join(HOME, 'logs', 'daemon.log'), 'utf8').catch(() => '');
    const lines = log.split('\n').filter((l) => / engine disconnected: /.test(l)).filter((l) => Date.parse(l.slice(0, 24)) >= stabilityStartAt);
    lines.length === 0
      ? ok('the extension never dropped its daemon connection during the run', `${Math.round((Date.now() - stabilityStartAt) / 1000)}s`)
      : bad(`${lines.length} disconnect(s) during the run`, short(lines.slice(0, 3).join(' | '), 300));
  });

  // Main world, at the end of everything: nothing G9BrowserAgent did may be visible to the page.
  await section('22. Main world after the whole run', async () => {
    await call('browser_navigate', { action: 'goto', url: mainUrl, waitUntil: 'load' });
    await call('browser_snapshot');
    const leaks = await mainWorldLeaks(mainTab, ['__g9SelectTrusted' /* testpage.html's own */]);
    check(leaks.length === 0, 'no __g9* name and no binding in the test page\'s main world', leaks.join(', ') || 'clean');
  });

  // ------------------------------------------------ welcome on update / reload
  await section('23. Welcome page: once on a version change, never on a same-version reload', async () => {
    if (!cdp || !EXT_ID || !EXT_DIR) return skip('welcome on update', NO_CDP);
    reloadsStartAt = Date.now();
    const manifestPath = path.join(EXT_DIR, 'manifest.json');
    const original = await readFile(manifestPath, 'utf8');
    const bumped = VERSION.replace(/\d+$/, (n) => String(Number(n) + 1));
    const reload = async (label) => {
      const sw = await workerSession();
      await cdp.evaluate('setTimeout(() => chrome.runtime.reload(), 50); true', sw.sessionId).catch(() => {});
      // The old worker goes away and a new one registers; the daemon must see
      // the extension again before anything else is asked of it.
      await sleep(1500);
      await workerSession(20_000);
      const back = await waitFor(async () => {
        const st = await call('browser_status');
        return st.capabilities?.extension === true && !(st.engines ?? []).some((e) => e.kind === 'extension' && e.reconnecting) ? st : null;
      }, { timeoutMs: 20_000, every: 500 });
      if (!back) bad(`${label}: the extension did not reconnect to the daemon`);
      await sleep(2500); // onInstalled's welcome tab opens asynchronously
      return back;
    };
    const about = async () => (await workerSession()).evaluate('chrome.storage.local.get("about").then((x) => x.about ?? null)');

    for (const t of await welcomeTabs()) await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});

    // 1. The same version, reloaded: nothing opens.
    await reload('same-version reload');
    let open = await welcomeTabs();
    check(open.length === 0, 'same-version reload opens no welcome tab', open.map((t) => t.url).join(', ') || 'none');

    // 2. The stored 'about' state says an older build ran here last. Chrome's own
    //    previousVersion for a same-version reload wins over it (sw.js
    //    onInstalled: `details.previousVersion ?? about.lastSeenVersion`), so
    //    the files did not change and nothing may open. Asserted, not logged:
    //    an earlier copy of this step only printed the count, and a welcome tab
    //    stacking on every reload of stale storage would have passed it.
    const w = await workerSession();
    await w.evaluate('chrome.storage.local.get("about").then((x) => chrome.storage.local.set({ about: { ...(x.about ?? {}), lastSeenVersion: "1.7.21" } }))');
    const a0 = await about();
    check(a0?.lastSeenVersion === '1.7.21', 'simulated: the stored about state names an older build', short(a0));
    await reload('same-version reload with an older lastSeenVersion stored');
    open = await welcomeTabs();
    const a1 = await about();
    check(open.length === 0, 'a same-version reload opens no welcome tab even when the stored about state is older',
      `${open.length} welcome tab(s)${open.length ? ': ' + open.map((t) => t.url).join(', ') : ''}`);
    check(a1?.lastSeenVersion === VERSION, 'the stored lastSeenVersion is brought up to the running version', short(a1));
    for (const t of open) await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});

    // 3. A real version change: the copy's manifest is bumped, then reloaded.
    await writeFile(manifestPath, original.replace(`"version": "${VERSION}"`, `"version": "${bumped}"`));
    try {
      await reload('update to ' + bumped);
      open = (await waitFor(async () => ((await welcomeTabs()).length ? welcomeTabs() : null), { timeoutMs: 8000 })) ?? [];
      check(open.length === 1 && open[0].url.includes('updated=1'), `update ${VERSION} → ${bumped} opens the welcome page once, with ?updated=1`, open.map((t) => t.url).join(', ') || 'none');
      if (open.length) {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: open[0].targetId, flatten: true });
        await sleep(500);
        const dom = await cdp.evaluate('({ ver: document.getElementById("ver")?.textContent, from: document.getElementById("fromVer")?.textContent, to: document.getElementById("toVer")?.textContent, banner: !document.getElementById("updated")?.hidden, title: document.title })', sessionId);
        check(dom.ver === `v${bumped}` && dom.from === `v${VERSION}` && dom.to === `v${bumped}` && dom.banner,
          'the welcome page names what it replaced', short(dom));
      }
      const a2 = await about();
      check(a2?.previousVersion === VERSION && a2?.lastSeenVersion === bumped, 'about: previousVersion and lastSeenVersion recorded', short(a2));
      const st = await call('browser_status');
      check(st.version === bumped, 'browser_status reports the new extension version', `extension ${st.version}`);
    } finally {
      await writeFile(manifestPath, original);
    }
    // 4. Back to the real version — also a change — reuses the open welcome tab.
    await reload('back to ' + VERSION);
    await sleep(1500);
    open = await welcomeTabs();
    check(open.length === 1, 'a second version change reuses the welcome tab (never a second one)', `${open.length} welcome tab(s)`);
    for (const t of open) await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    // 5. And a plain reload after all that: still nothing.
    await reload('final same-version reload');
    open = await welcomeTabs();
    check(open.length === 0, 'the next same-version reload opens nothing', `${open.length} welcome tab(s)`);

    // The engine is usable after the reloads (new worker, new debugger sessions).
    await activateMain();
    const rows = (await call('browser_tabs', { action: 'list' })).tabs ?? [];
    const row = rowFor(rows, mainUrl);
    console.log(`  \x1b[90mtab handle across reloads: ${mainTab} → ${row?.tabId} (D-c keeps it when the page is unchanged)\x1b[0m`);
    const s = row ? await call('browser_snapshot', { tabId: row.tabId }).catch((e) => ({ error: e.message })) : { error: 'tab not listed' };
    check(!!s.tree, 'tools work on the tab after the extension reloaded', s.error ?? `handle ${row?.tabId}`);
  });
} catch (err) {
  if (!/no extension|no test page|cannot continue/.test(String(err.message))) {
    bad('unexpected exception', short(String(err?.stack ?? err), 400));
  }
} finally {
  try { await panel?.close(); } catch {}
  cdp?.close();
  // End stdin the way an MCP client does, so the shim closes its daemon link
  // cleanly (a kill is a TerminateProcess on Windows: the daemon logged every
  // run's end as "1006 socket error"). Killed only if it does not go.
  try { child.stdin.end(); } catch {}
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(3000)]);
  if (child.exitCode == null) child.kill();
}

const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`\n${colour}${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}\x1b[0m`);
if (failed) console.log('\x1b[31mFailed: ' + failures.join(' · ') + '\x1b[0m');
if (failed && shimErr.length) console.log('\x1b[90mshim stderr: ' + shimErr.slice(-8).join(' | ') + '\x1b[0m');
process.exit(failed === 0 && extensionReady ? 0 : 1);
