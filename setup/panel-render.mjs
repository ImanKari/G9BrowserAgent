#!/usr/bin/env node
/**
 * The side panel, rendered for a person to look at — a dev harness, not a test suite.
 *
 *   node setup/panel-render.mjs --out <dir>
 *
 * Serves extension/panel/ and extension/lib/sites.js over a local http server (127.0.0.1, a
 * random port in 18000-18999), launches a headless Edge through engine/launch.js on a temporary
 * profile, and installs a stub `chrome` API before the panel's scripts run. The stub answers the
 * panel's commands (getState, recStatus, recGet, issueList, issueGet, daemonInfo, about, …) with
 * REALISTIC fixtures: three agents in two projects, flows on three sites in several suites with
 * mixed verdicts, issues across sites/statuses/severities with evidence, an agent blocked on a
 * hidden tab, and a signed URL long enough to have filled a third of the v2 panel.
 *
 * It writes one PNG per view — Session, Automation (a drawer open), Issues (list and detail),
 * About — at 360 and 1000 px wide (1000 is the detached window: panel.html?detached=1), light and
 * dark (Emulation.setEmulatedMedia prefers-color-scheme), full page height, into --out.
 *
 * It fails (exit 1) on any page exception, console error, dialog or failed load; on horizontal
 * overflow at 360 px; on markup injected from a fixture string (the fixtures carry `<img onerror>`
 * and `<script>` titles); and when the blocked-tab toast does not go on agentUnblocked.
 *
 * Why no real extension: the panel is a page of DOM and a message channel. A stubbed channel
 * shows every state on demand — three agents, a blocked tab, twenty runs of history — which a
 * live extension shows only after the events that cause them. The isolated live test is what
 * proves the real channel (setup/isolated-livetest.mjs, its panel section).
 *
 * Never binds, connects to or probes port 8765 (the owner's daemon): the fixture merely NAMES it,
 * the way a real panel would. The browser is headless, on a temporary profile, closed at the end.
 */

import http from 'node:http';
import zlib from 'node:zlib';
import net from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser } from '../engine/launch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXT = path.join(ROOT, 'extension');
const VERSION = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
const OWNER_PORT = 8765;

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const OUT = path.resolve(argOf('--out') ?? path.join(os.tmpdir(), `g9-panel-render-${Date.now()}`));
const ONLY = argOf('--only'); // e.g. "360-light" while iterating on one view

const failures = [];
/** True while the self-check plants its own error: counted, not printed. */
let muted = false;
const fail = (what, detail = '') => {
  failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
  if (!muted) console.log(`  \x1b[31mFAIL\x1b[0m ${what}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`);
};
const ok = (what, detail = '') => console.log(`  \x1b[32mok\x1b[0m   ${what}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ the server

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

/** Only extension/panel/* and extension/lib/sites.js: the panel's own module graph, nothing else. */
async function serve(req, res) {
  const url = new URL(req.url, 'http://x');
  let file = null;
  if (url.pathname === '/lib/sites.js') file = path.join(EXT, 'lib', 'sites.js');
  else if (/^\/panel\/[A-Za-z0-9_.-]+$/.test(url.pathname)) file = path.join(EXT, 'panel', url.pathname.slice('/panel/'.length));
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  if (!file) {
    res.writeHead(404);
    return res.end('not here');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('missing');
  }
}

async function listen() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = 18000 + Math.floor(Math.random() * 1000);
    if (port === OWNER_PORT) continue;
    const server = http.createServer((req, res) => serve(req, res).catch(() => res.end()));
    const bound = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (bound) return { server, port };
  }
  throw new Error('no free port in 18000-18999');
}

// ---------------------------------------------------------------- the fixtures

/** A small, valid PNG that looks like a page: a header bar, a sidebar, content blocks. */
function pagePng(w = 160, h = 100) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = [0];
    for (let x = 0; x < w; x++) {
      let c = [246, 246, 248];
      if (y < 14) c = [79, 70, 229];
      else if (x < 30) c = [228, 228, 236];
      else if (y > 24 && y < 34 && x > 40 && x < 130) c = [200, 200, 212];
      else if (y > 42 && y < 88 && x > 40 && x < 150 && (y % 10) < 6) c = [222, 222, 230];
      if (y > 60 && y < 72 && x > 110 && x < 150) c = [196, 54, 47];
      row.push(...c);
    }
    rows.push(Buffer.from(row));
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

/**
 * The first run of a fresh install: no daemon, no tab, nothing recorded or reported, and
 * auto-attach on its default (Project sites) with no project known — every empty state at once.
 */
function emptyFixtures() {
  const F = fixtures();
  F.state = {
    ...F.state,
    previousVersion: null,
    bridge: { host: '127.0.0.1', port: OWNER_PORT, connected: false, lastError: `daemon not reachable on 127.0.0.1:${OWNER_PORT}` },
    currentTabId: null, attachedTabs: [], attachedSince: {}, agents: [], projectDomains: [], projects: [], blocked: {}, activity: [],
  };
  F.status = { current: null, tabs: { count: 0, rows: [] }, sessions: [], autoAttach: false, autoAttachMode: 'project' };
  F.recordings = [];
  F.full = {};
  F.issues = [];
  F.tabs = [];
  F.daemon = null;
  return F;
}

function fixtures() {
  const now = Date.now();
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  const A = 'https://admin.contoso.example';
  const B = 'https://shop.example.com';
  const C = 'http://intranet.local:8080';
  const signed = `${A}/orders/2026/09/exports/batch-7f3a9c2e-1b44-4c1d-9a0e-55d2f0c1e9ab/files/quarterly-reconciliation-report-final-v3.csv` +
    '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260925%2Feu-central-1%2Fs3%2Faws4_request' +
    '&X-Amz-Date=20260925T140312Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host' +
    '&X-Amz-Signature=4f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0#row=1200';

  const tabs = [
    { tabId: 101, title: 'Orders export — Contoso Admin', url: signed, active: true, windowState: 'normal', attached: true },
    { tabId: 102, title: 'Customers — Contoso Admin', url: `${A}/customers?page=3`, active: false, windowState: 'normal', attached: true },
    { tabId: 103, title: 'Staging dashboard', url: 'https://staging.contoso.example/', active: false, windowState: 'normal', attached: false },
    { tabId: 104, title: 'Checkout — Shop <img src=x onerror=alert(1)>', url: `${B}/checkout/payment`, active: false, windowState: 'normal', attached: true },
    { tabId: 105, title: 'Inbox', url: 'https://mail.example.org/', active: false, windowState: 'normal', attached: false },
  ];

  const agents = [
    { id: 'agent-1', name: 'claude-code', owned: [101, 102], halted: false, project: 'contoso-admin', cwd: 'C:/work/contoso-admin', current: 101, currentEngine: 'extension' },
    { id: 'agent-2', name: 'cursor', owned: [], halted: false, project: 'contoso-admin', cwd: 'C:/work/contoso-admin', current: null, currentEngine: 'launched' },
    { id: 'agent-3', name: 'claude-code', owned: [104], halted: true, project: 'shop-web', cwd: 'D:/src/shop-web', current: 104, currentEngine: 'extension' },
  ];

  const activity = [
    ['browser_interact click "Export CSV"', true, 412], ['browser_snapshot', true, 88], ['browser_navigate goto /orders/2026/09/exports', true, 1320],
    ['browser_interact type into "Search orders"', true, 2210], ['Record from now — page reloaded to capture its load', true, null, 'attach'],
    ['browser_interact click "Pay now" — [delivery: not-delivered; tab hidden]', false, 30], ['Auto-attach: Project sites', true, null, 'system'],
    ['browser_diagnose console', true, 45], ['browser_wait for text "Export ready"', true, 5400], ['browser_tabs attach 104', true, 61],
  ].map(([detail, ok2, ms, kind], i) => ({ at: now - i * 47_000, detail, ok: ok2, ms, kind: kind ?? 'tool', tabId: 101 }));

  const state = {
    halted: false,
    version: VERSION,
    previousVersion: '2.0.2',
    updatedAt: now - 2 * day,
    bridge: {
      host: '127.0.0.1', port: OWNER_PORT, connected: true, daemonVersion: VERSION, engineId: 'engine-1', daemonPid: 4242,
      connectedAt: now - 3 * hour, repoRoot: 'C:/Users/qa/G9BrowserAgent', lastError: null,
    },
    currentTabId: 101,
    attachedTabs: [101, 102, 104],
    attachedSince: { 101: now - 42 * min, 102: now - 2 * hour, 104: now - 20 * min },
    inputMode: 'human',
    autoAttach: 'project',
    projectDomains: ['admin.contoso.example', 'staging.contoso.example', 'shop.example.com', 'shop-staging.example.com'],
    projects: [
      { name: 'contoso-admin', path: 'C:/work/contoso-admin/g9.project.json', domains: ['admin.contoso.example', 'staging.contoso.example'], agents: ['agent-1', 'agent-2'] },
      { name: 'shop-web', path: 'D:/src/shop-web/g9.project.json', domains: ['shop.example.com', 'shop-staging.example.com'], agents: ['agent-3'] },
    ],
    agents,
    blocked: {
      104: {
        tabId: 104, agent: { id: 'agent-3', name: 'claude-code' }, reason: 'hidden', at: now - 35_000,
        title: tabs[3].title, url: tabs[3].url, tool: 'browser_interact', delivery: 'not-delivered',
      },
    },
    sessions: {},
    dialogs: {},
    activity,
  };

  const status = {
    current: { tabId: 101, title: tabs[0].title, url: signed, active: true, attachedSince: state.attachedSince[101] },
    health: { consoleErrors: 2, consoleWarnings: 5, networkRequests: 184, failedRequests: 1 },
    tabs: { count: tabs.length, rows: tabs },
    sessions: [
      { session: 'admin', tabId: 101, alive: true, active: true, url: `${A}/orders` },
      { session: 'customer', tabId: 104, alive: true, active: false, url: `${B}/checkout/payment` },
    ],
    autoAttach: true,
    autoAttachMode: 'project',
  };

  const run = (verdict, ago, extra = {}) => ({ at: now - ago, verdict, passed: verdict.startsWith('FAIL') ? 3 : 5, failed: verdict.startsWith('FAIL') ? 1 : 0, durationMs: 8000 + Math.round(ago % 5000), ...extra });
  const flow = (id, name, startUrl, suite, assertionCount, last, more = {}) => ({
    id, name, startUrl, suite, folder: more.folder ?? null, tags: more.tags ?? [], stepCount: more.steps ?? 8 + (id.length % 7),
    assertionCount, durationMs: 9000, createdAt: now - 30 * day, updatedAt: now - (last?.[1] ?? 20 * day),
    lastRun: last ? run(last[0], last[1]) : null, qaTestCaseIds: more.tc ?? [], platform: 'web',
    environment: more.env ?? null, flaky: more.flaky ?? null,
  });
  const flaky = { detected: true, sampleSize: 10, passRuns: 6, failRuns: 4 };
  const recordings = [
    flow('rec_admin_login', 'Login as admin', `${A}/login`, 'smoke', 3, ['PASS', 2 * hour], { tags: ['@smoke'], env: 'staging', tc: ['TC-101'] }),
    flow('rec_order_discount', 'Create order with discount code', `${A}/orders/new`, 'orders', 5, ['FAIL_PRODUCT', 25 * min], { env: 'staging', folder: 'Orders' }),
    flow('rec_export_csv', 'Export orders CSV', `${A}/orders/export`, 'orders', 0, ['PASS_WITH_WARNING', day], { env: 'staging' }),
    flow('rec_refund', 'Refund a partial payment on a split-tender order', `${A}/orders/42/refund`, 'orders', 2, ['SURPRISE', 3 * hour], { env: 'prod', flaky }),
    flow('rec_dashboard', 'Dashboard widgets load', `${A}/`, 'smoke', 4, ['PASS', 10 * min], { env: 'staging' }),
    flow('rec_customer_phone', 'Customer search by phone', `${A}/customers`, null, 1, null),
    flow('rec_settings', 'Admin settings save', `${A}/settings`, 'smoke', 2, ['FAIL_PRODUCT', hour], { env: 'staging' }),
    flow('rec_guest_card', 'Guest checkout with card', `${B}/checkout`, 'checkout', 6, ['FAIL_AUTOMATION', 5 * hour], { env: 'test1', flaky, tags: ['regression'] }),
    flow('rec_gift', 'Apply gift card at checkout', `${B}/checkout/gift`, 'checkout', 3, ['PASS', day], { env: 'test1' }),
    flow('rec_search_auto', 'Search autocomplete <img src=x onerror=alert(1)>', `${B}/search`, 'search', 2, ['PASS', 3 * day], { tags: ['@manual'] }),
    flow('rec_price_filter', 'Filter by price range', `${B}/search?cat=shoes`, 'search', 0, null),
    flow('rec_bulk_prices', 'Bulk edit product prices', `${B}/admin/products`, 'catalog', 4, ['PASS', 2 * hour], { tags: ['regression'] }),
    flow('rec_monthly', 'Monthly revenue report', `${C}/reports/monthly`, 'reports', 2, ['PASS', 6 * day], { env: 'intranet' }),
    flow('rec_legacy_import', 'Legacy import wizard', null, 'legacy', 0, null),
    flow('rec_old_smoke', 'Old smoke from v1', null, null, 1, ['PASS_WITH_WARNING', 12 * day]),
    // v3 review, findings 4, 7, 8: stored shapes that used to freeze the list or print nonsense.
    { ...flow('rec_malformed', 'Malformed from an old agent', `${A}/malformed`, 'none', 1, ['PASS', 4 * day]),
      tags: 'legacy, import', qaTestCaseIds: 'TC-9', environment: { variables: { a: 1 } } },
  ];
  const verdicts = ['PASS', 'PASS', 'PASS_WITH_WARNING', 'PASS', 'FAIL_AUTOMATION', 'PASS', 'SURPRISE', 'PASS', 'FAIL_PRODUCT', 'PASS', 'PASS', 'PASS'];
  const full = Object.fromEntries(recordings.map((r, i) => [r.id, {
    ...r,
    steps: [],
    runHistory: r.lastRun ? [...verdicts.slice(i % 4, 4 + (i % 9)).map((v, k) => run(v, (k + 2) * day)).reverse(), r.lastRun] : [],
    knownWorld: r.lastRun ? { runs: 1 + (i % 3) } : null,
  }]));

  const ev = (o = {}) => ({ screenshots: 0, videos: 0, files: 0, console: false, network: false, dom: false, ...o });
  const issue = (id, title, url, status2, severity, ago, evidence, more = {}) => ({
    id, title, url, site: url ? new URL(url).origin : null, status: status2, ...(severity ? { severity } : {}),
    tags: more.tags ?? [], filedAs: more.filedAs ?? null, evidence, createdAt: now - ago, updatedAt: now - ago + 60_000,
  });
  const issues = [
    issue('bug_total', 'Order total ignores the discount code on split-tender orders', `${A}/orders/new`, 'open', 'blocker', 40 * min,
      ev({ screenshots: 2, videos: 1, console: true, network: true, dom: true }), { tags: ['orders', 'regression'] }),
    issue('bug_csv', 'Export CSV missing header row', `${A}/orders/export`, 'open', 'major', day, ev({ screenshots: 1, dom: true })),
    issue('bug_tooltip', 'Tooltip overlaps the Save button', `${A}/settings`, 'filed', 'minor', 3 * day, ev({ screenshots: 1 }), { filedAs: 'CON-1182' }),
    issue('bug_dash500', 'Dashboard 500 on first load after login', `${A}/`, 'closed', 'major', 9 * day, ev({ screenshots: 1, console: true, network: true }), { filedAs: 'CON-1101' }),
    issue('bug_declined', 'Card declined message is generic', `${B}/checkout/payment`, 'open', 'normal', 2 * hour, ev({ screenshots: 1, files: 1, network: true }), { tags: ['checkout'] }),
    issue('bug_xss', '<script>alert("x")</script> in a product name renders as markup', `${B}/p/123`, 'open', 'major', 5 * hour, ev({ screenshots: 1, dom: true }), { tags: ['xss'] }),
    issue('bug_flicker', 'Search results flicker while typing', `${B}/search`, 'filed', 'normal', 2 * day, ev({ videos: 2 }), { filedAs: 'SHOP-77' }),
    issue('bug_paging', 'Pagination resets the price filter', `${B}/search?cat=shoes`, 'closed', 'minor', 20 * day, ev()),
    issue('bug_pdf', 'Report PDF times out after 30 s', `${C}/reports/monthly`, 'open', 'normal', 4 * day, ev({ console: true })),
    // Written before v3: no severity in the entry — it must read as "normal".
    issue('bug_legacy', 'Panel froze during capture (filed from v2)', null, 'open', null, 6 * day, ev()),
  ];
  const detail = {
    body: 'Steps: open a split-tender order, apply SAVE10, pay part by card.\nExpected: total drops by 10%.\nActual: total unchanged; the discount line shows 0.00.',
    context: {
      url: `${A}/orders/new?draft=8812`, title: 'New order — Contoso Admin', referrer: `${A}/orders`,
      viewport: { width: 1440, height: 900, dpr: 1 }, at: new Date(now - 40 * min).toISOString(),
      console: { total: 14, counts: { error: 2 } }, failedRequestCount: 1,
    },
    attachments: [
      { id: 'att1', kind: 'screenshot', name: 'viewport.png', mime: 'image/png', size: 183_422 },
      { id: 'att2', kind: 'screenshot', name: 'fullpage.png', mime: 'image/png', size: 912_004 },
      { id: 'att3', kind: 'video', name: 'tab-recording.webm', mime: 'video/webm', size: 4_812_004 },
      { id: 'att4', kind: 'evidence', name: 'console.log', mime: 'text/plain', size: 2_310 },
      { id: 'att5', kind: 'evidence', name: 'failed-requests.log', mime: 'text/plain', size: 880 },
      { id: 'att6', kind: 'evidence', name: 'page-fragment.html', mime: 'text/html', size: 12_004 },
    ],
  };

  const daemon = {
    version: VERSION, port: OWNER_PORT, pid: 4242, agents,
    engines: [
      { engineId: 'engine-1', kind: 'extension', browser: { name: 'Microsoft Edge', version: '153.0.3405.80' }, tabs: 5 },
      { engineId: 'engine-2', kind: 'launched', headless: true, browser: { kind: 'edge', version: '153.0.3405.80' }, profile: 'automation', tabs: 2, pid: 9911 },
    ],
  };

  return { state, status, recordings, full, issues, detail, daemon, tabs, png: pagePng() };
}

/**
 * (3.2) The daemon, as the watch page sees it: a WebSocket that says welcome, lists three tabs (one
 * title carries markup) and streams frames of a drawn mock page with a moving, pressing cursor.
 * Serialised into the page like installStub.
 */
function installFakeDaemon() {
  const tabs = [
    { tabId: 21, title: 'Checkout — Shop <img src=x onerror=alert(1)>', url: 'https://shop.example.com/checkout?session=a7f3', engineId: 'engine-2', engineKind: 'launched', headless: true, browser: 'edge', owner: { id: 'agent-2', name: 'cursor' }, agents: [{ id: 'agent-2', name: 'cursor' }] },
    { tabId: 22, title: 'Orders — Admin', url: 'https://admin.contoso.example/orders', engineId: 'engine-2', engineKind: 'launched', headless: true, browser: 'edge', owner: { id: 'agent-3', name: 'codex' }, agents: [] },
    { tabId: 5, title: 'Inbox', url: 'https://mail.example.com/', engineId: 'engine-1', engineKind: 'extension', headless: null, browser: 'Microsoft Edge', owner: null, agents: [] },
  ];
  const frames = new Map();
  const frameFor = (tabId) => {
    if (frames.has(tabId)) return frames.get(tabId);
    const c = document.createElement('canvas');
    c.width = 800; c.height = 500;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 800, 500);
    g.fillStyle = tabId === 21 ? '#1f6feb' : '#8250df'; g.fillRect(0, 0, 800, 56);
    g.fillStyle = '#ffffff'; g.font = 'bold 22px sans-serif'; g.fillText(tabId === 21 ? 'Shop — Checkout' : 'Admin — Orders', 24, 36);
    g.fillStyle = '#e6e8eb';
    for (let i = 0; i < 6; i++) g.fillRect(24, 90 + i * 52, 480, 34);
    g.fillStyle = '#2da44e'; g.fillRect(560, 390, 200, 48);
    g.fillStyle = '#ffffff'; g.font = 'bold 18px sans-serif'; g.fillText('Pay now', 620, 420);
    const data = c.toDataURL('image/jpeg', 0.85).split(',')[1];
    frames.set(tabId, data);
    return data;
  };
  class FakeSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      window.__g9ws = this;
      setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }, 20);
    }
    reply(obj) { setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(obj) })), 10); }
    send(text) {
      const m = JSON.parse(text);
      (window.__g9viewerSent ??= []).push(m.type === 'viewer' ? m.op : m.type + ':' + (m.role ?? ''));
      if (m.type === 'hello') this.reply({ type: 'welcome', id: 'viewer-1', version: '3.1.0' });
      else if (m.type === 'viewer' && m.op === 'watchables') this.reply({ type: 'viewerResult', id: m.id, ok: true, result: { tabs } });
      else if (m.type === 'viewer' && m.op === 'watch') {
        this.reply({ type: 'viewerResult', id: m.id, ok: true, result: { watching: true, tabId: m.tabId } });
        this.stream(m.tabId);
      } else if (m.type === 'viewer' && m.op === 'unwatch') this.reply({ type: 'viewerResult', id: m.id, ok: true, result: { watching: false, tabId: m.tabId } });
    }
    stream(tabId) {
      let t = 0;
      setInterval(() => {
        t++;
        const at = Date.now();
        const emit = (obj) => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(obj) }));
        if (t === 1) emit({ type: 'event', topic: 'watchStatus', data: { tabId, state: 'live' } });
        if (t % 3 === 1) emit({ type: 'event', topic: 'frame', data: { tabId, data: frameFor(tabId), metadata: { deviceWidth: 800, deviceHeight: 500 }, at } });
        emit({ type: 'event', topic: 'pointer', data: { tabId, sample: { at, x: 560 + ((t * 9) % 180), y: 380 + ((t * 5) % 50), buttons: t % 12 < 2 ? 1 : 0, type: t % 12 === 0 ? 'mousePressed' : 'mouseMoved' } } });
      }, 60);
    }
    close() {}
  }
  FakeSocket.CONNECTING = 0; FakeSocket.OPEN = 1; FakeSocket.CLOSING = 2; FakeSocket.CLOSED = 3;
  window.WebSocket = FakeSocket;
}

/**
 * The stub, serialised into the page before any script runs. It must be self-contained: it is
 * `toString()`ed, so it closes over nothing but its two arguments.
 */
function installStub(F, version) {
  const listeners = [];
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const answer = (m) => {
    switch (m.cmd) {
      case 'getState': return { ok: true, state: F.state, status: F.status };
      case 'listTabs': return { ok: true, tabs: F.tabs };
      case 'daemonInfo': return { ok: true, daemon: F.daemon };
      case 'about': return { ok: true, version, previousVersion: F.state.previousVersion, updatedAt: F.state.updatedAt, browser: navigator.userAgent };
      case 'recStatus': return { ok: true, status: { recording: false }, elsewhere: [], halted: false, recordings: F.recordings };
      case 'recGet': return { ok: true, recording: F.full[m.id] ?? null };
      case 'recKnownWorld': return { ok: true, knownWorld: F.full[m.id]?.knownWorld ?? null, runHistory: F.full[m.id]?.runHistory ?? [], surpriseHistory: [] };
      case 'flowStatus': return { ok: true, onlyInRepo: ['a'], onlyLocal: ['b', 'c'], differing: [], approvalNewerInRepo: [{ id: 'x' }], approvalNewerHere: [], total: 13 };
      // (3.2) Two project repositories: the daemon's own and a connected agent's.
      case 'watchAddress': return { ok: true, address: 'fake-daemon:1', version };
      case 'openWatch': (window.__g9sent ??= []).push('openWatch'); return { ok: true, windowId: 1, reused: false };
      case 'flowProjects': return { ok: true, default: 'G:/work/admin-panel/g9.project.json', projects: [
        { name: 'admin-panel', path: 'G:/work/admin-panel/g9.project.json', flowsDir: 'G:/work/admin-panel/QA/Flows', own: true, agents: ['agent-1'], domains: ['admin.contoso.example'] },
        { name: 'shop-web', path: 'G:/work/shop-web/g9.project.json', flowsDir: 'G:/work/shop-web/QA/Flows', own: false, agents: ['agent-2', 'agent-3'], domains: ['shop.example.com'] },
      ] };
      case 'recHistory': return { ok: true, recordings: (m.ids ?? []).map((id) => {
        const row = F.recordings.find((r) => r.id === id) ?? {};
        return { ...row, runHistory: F.full[id]?.runHistory ?? (row.lastRun ? [row.lastRun] : []), steps: [], knownWorld: F.full[id]?.knownWorld ?? null };
      }) };
      case 'issueList': return { ok: true, issues: F.issues, usage: { attachments: 23, attachmentMB: 14.2 } };
      case 'issueGet': {
        const row = F.issues.find((i) => i.id === m.id);
        return row ? { ok: true, issue: { ...row, ...F.detail, severity: row.severity } } : { ok: false, error: `No issue ${m.id}` };
      }
      case 'issueUpdate': {
        // What the store does: the index entry is rewritten from the saved record.
        const row = F.issues.find((i) => i.id === m.id);
        if (!row) return { ok: false, error: `No issue ${m.id}` };
        for (const k of ['title', 'severity', 'status', 'tags', 'filedAs']) if (k in m) row[k] = m[k];
        row.updatedAt = Date.now();
        return { ok: true, issue: row };
      }
      case 'issueAttachment': return { ok: true, attachment: { dataBase64: F.png } };
      case 'videoStatus': return { ok: true, status: { recording: false } };
      case 'setAutoAttach': (window.__g9sent ??= []).push(m.mode); F.state.autoAttach = m.mode; return { ok: true, mode: m.mode };
      case 'setInputMode': F.state.inputMode = m.mode; return { ok: true };
      default: return { ok: true };
    }
  };
  const stub = {
    runtime: {
      id: 'g9panelrenderfixture',
      getManifest: () => ({ version }),
      getURL: (p) => `${location.origin}/${p}`,
      sendMessage: (m) => new Promise((resolve) => setTimeout(() => resolve(clone(m?.__g9cmd ? answer(m) : undefined)), 5)),
      onMessage: { addListener: (fn) => listeners.push(fn), removeListener() {} },
    },
    tabs: { create: async () => ({}), update: async () => ({}), getCurrent: async () => null },
    windows: { update: async () => ({}) },
  };
  Object.defineProperty(window, 'chrome', { value: stub, configurable: true, writable: true });
  // The harness plays the worker's broadcasts through this.
  window.__g9Fixture = F;
  window.__g9Broadcast = (msg) => { for (const fn of listeners) fn({ __g9: true, ...msg }); };
}

/**
 * What sticks out past the viewport's right edge, unless an ancestor clips it (an ellipsis box, a
 * scroller): at 360 px that is a panel the person has to scroll sideways to reach Stop.
 */
const OVERFLOW_PROBE = `(() => {
  const W = document.documentElement.clientWidth;
  const out = [];
  if (document.documentElement.scrollWidth > W + 1) out.push('document ' + document.documentElement.scrollWidth + ' > ' + W);
  for (const n of document.querySelectorAll('body *')) {
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= W + 1) continue;
    let clipped = false;
    for (let p = n.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX !== 'visible' && p.getBoundingClientRect().right <= W + 1) { clipped = true; break; }
    }
    if (!clipped) out.push((n.id ? '#' + n.id : n.tagName.toLowerCase() + '.' + [...n.classList].join('.')) + ' right ' + Math.round(r.right));
  }
  return out.slice(0, 8);
})()`;

// ------------------------------------------------------------------- the browser

async function main() {
  await mkdir(OUT, { recursive: true });
  const { server, port } = await listen();
  const origin = `http://127.0.0.1:${port}`;
  console.log(`panel-render: serving ${EXT} on ${origin} · out ${OUT}`);

  let browser = null;
  try {
    // --browser chrome|cft when Edge cannot start headless on this machine (default: edge, the one the panel ships for).
    browser = await launchBrowser({ browser: argOf('--browser') ?? 'edge', headless: true, windowSize: { width: 1280, height: 900 } });
    console.log(`  ${browser.browser.product} · temp profile ${browser.profileDir}`);
    const conn = browser.conn;
    const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params = {}) => conn.send(method, params, sessionId);

    let phase = 'start';
    conn.on('event', (method, params, sid) => {
      if (sid !== sessionId) return;
      if (method === 'Runtime.exceptionThrown') {
        fail(`[${phase}] page exception`, params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text);
      } else if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'assert')) {
        fail(`[${phase}] console.${params.type}`, (params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
      } else if (method === 'Log.entryAdded' && params.entry?.level === 'error') {
        fail(`[${phase}] ${params.entry.source} error`, `${params.entry.text} ${params.entry.url ?? ''}`.slice(0, 300));
      } else if (method === 'Page.javascriptDialogOpening') {
        fail(`[${phase}] a dialog opened — fixture text ran as script`, params.message);
        send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
      }
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');

    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result?.value;
    };
    const waitFor = async (expression, what, timeoutMs = 6000) => {
      const end = Date.now() + timeoutMs;
      for (;;) {
        if (await evaluate(expression).catch(() => false)) return true;
        if (Date.now() > end) {
          fail(`[${phase}] timed out waiting for ${what}`);
          return false;
        }
        await delay(80);
      }
    };

    // A page's load event, or — when it does not come — what is still loading, said by name. A page
    // whose DOM is parsed and whose scripts ran is renderable; the checks below judge the rendering.
    // (3.2.1: the panel's first load on the hosted agent's Edge 153 never fired "load" within 15 s.)
    const pageLoaded = async (loaded, what) => {
      try {
        await loaded;
        return;
      } catch (err) {
        if (err?.code !== 'TIMEOUT') throw err;
      }
      const why = await evaluate(`JSON.stringify({ readyState: document.readyState,
        images: [...document.images].filter((i) => !i.complete).map((i) => i.src).slice(0, 5),
        resources: performance.getEntriesByType('resource').filter((e) => !e.responseEnd).map((e) => e.name).slice(0, 5),
        scripts: document.scripts.length })`).catch((e) => `unreadable: ${e.message}`);
      if (/"readyState":"(interactive|complete)"/.test(why)) {
        console.log(`  WARN ${what}: no load event within 15 s, continuing with the parsed page ${why}`);
        return;
      }
      throw new Error(`${what}: the page did not load within 15 s ${why}`);
    };

    let stubScript = null;
    let selfChecked = false;
    const combos = [];
    for (const width of [360, 1000]) for (const scheme of ['light', 'dark']) combos.push({ width, scheme, empty: false });
    for (const scheme of ['light', 'dark']) combos.push({ width: 360, scheme, empty: true });

    for (const { width, scheme, empty } of combos) {
      const tag = `${empty ? 'empty-' : ''}${width}-${scheme}`;
      if (ONLY && ONLY !== tag) continue;
      const scale = width <= 400 ? 2 : 1;
      await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: scale, mobile: false });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      // A fresh fixture per load (issueUpdate edits it), installed before the panel's scripts.
      if (stubScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubScript });
      ({ identifier: stubScript } = await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(${installStub.toString()})(${JSON.stringify(empty ? emptyFixtures() : fixtures())}, ${JSON.stringify(VERSION)});`,
      }));
      phase = `${tag} load`;
      const loaded = conn.waitForEvent('Page.loadEventFired', { sessionId, timeoutMs: 15_000 });
      await send('Page.navigate', { url: `${origin}/panel/panel.html${width > 400 ? '?detached=1' : ''}` });
      await pageLoaded(loaded, `[${tag}] panel.html`);

      const shoot = async (name) => {
        await delay(250);
        const overflow = await evaluate(OVERFLOW_PROBE);
        if (width <= 400 && overflow.length) fail(`[${tag}] ${name}: horizontal overflow at ${width}px`, overflow.join('; '));
        const injected = await evaluate(`document.querySelectorAll('img[src="x"], script:not([src])').length`);
        if (injected) fail(`[${tag}] ${name}: fixture text became markup`, `${injected} element(s)`);
        const nonsense = await evaluate(`(document.body.innerText.match(/\\[object Object\\]|\\bNaN\\b/g) || []).length`);
        if (nonsense) fail(`[${tag}] ${name}: "[object Object]" or NaN shown to the person`, `${nonsense} occurrence(s)`);
        const { cssContentSize } = await send('Page.getLayoutMetrics');
        const height = Math.ceil(Math.max(800, cssContentSize?.height ?? 800));
        const shot = await send('Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 },
        });
        const file = path.join(OUT, `${name}-${tag}.png`);
        await writeFile(file, Buffer.from(shot.data, 'base64'));
        ok(`${name}-${tag}.png`, `${width}×${height}${overflow.length && width > 400 ? ` (overflow noted: ${overflow[0]})` : ''}`);
      };

      // The checks check themselves, once: a console error and an overflowing element are
      // planted and must be seen. A "clean" from a harness that hears nothing is worth nothing.
      if (!selfChecked) {
        selfChecked = true;
        phase = 'self-check';
        const before = failures.length;
        muted = true;
        await evaluate(`console.error('g9-render self-check'), true`);
        await delay(300);
        muted = false;
        const heard = failures.slice(before).some((f) => f.includes('g9-render self-check'));
        failures.splice(before);
        const wide = await evaluate(`(() => { const d = document.createElement('div'); d.id = 'g9SelfCheck';
          d.style.width = '2000px'; d.style.height = '4px'; document.body.append(d);
          const r = (${OVERFLOW_PROBE}); d.remove(); return r; })()`);
        if (!heard) fail('self-check: a console.error in the page was not heard');
        else if (!wide.some((w) => w.includes('g9SelfCheck'))) fail('self-check: a 2000px element was not reported as overflow', JSON.stringify(wide));
        else ok('self-check: console errors and overflow are detected');
      }

      if (empty) {
        phase = `${tag} session`;
        await waitFor(`document.getElementById('daemonLabel').textContent === 'Daemon offline'
          && document.getElementById('attached').classList.contains('empty')
          && !document.getElementById('autoAttachSites').hidden
          && document.getElementById('blockedAlerts').hidden`, 'the empty Session view');
        await shoot('session');
        phase = `${tag} automation`;
        await evaluate(`document.getElementById('tab-automation').click(), true`);
        await waitFor(`!document.getElementById('recEmpty').hidden && document.getElementById('flowFilters').hidden && document.getElementById('suiteCard').hidden`, 'the empty flow list');
        await shoot('automation');
        phase = `${tag} issues`;
        await evaluate(`document.getElementById('tab-issues').click(), true`);
        await waitFor(`!document.getElementById('issueEmpty').hidden && document.getElementById('issueFilters').hidden`, 'the empty issue list');
        await shoot('issues');
        continue;
      }

      // Session: the daemon, three agents, the current tab, the blocked-agent toast.
      phase = `${tag} session`;
      await waitFor(`document.getElementById('daemonLabel').textContent === 'Daemon connected'
        && document.querySelectorAll('#agentList > li').length === 3
        && !document.getElementById('blockedAlerts').hidden
        && document.querySelector('#attached .capture') !== null
        && document.querySelectorAll('#engineList > li').length === 2`, 'the Session view');
      await shoot('session');

      // Automation: site → suite → flow, with the first flow of this site's drawer open.
      phase = `${tag} automation`;
      await evaluate(`document.getElementById('tab-automation').click(), true`);
      await waitFor(`document.querySelectorAll('#recList .flow-panel').length >= 10 && !document.getElementById('flowAffinity').hidden`, 'the flow list');
      await evaluate(`[...document.querySelectorAll('#recList .flow-panel')]
        .find((p) => p.textContent.includes('Create order with discount code')).querySelector('.flow-open').click(), true`);
      await waitFor(`document.querySelector('#recList .drawer .spark .vd') !== null`, 'an open drawer with its run history');
      await shoot('automation');

      phase = `${tag} automation malformed`;
      const malformed = await evaluate(`(() => {
        const row = [...document.querySelectorAll('#recList .flow-panel')].find((p) => p.textContent.includes('Malformed from an old agent'));
        if (!row) return { found: false };
        const b = row.querySelector('.flow-open');
        if (b.getAttribute('aria-expanded') !== 'true') b.click();
        return { found: true };
      })()`);
      if (!malformed?.found) fail(`[${tag}] malformed flow`, 'the flow with stored strings for lists is not listed');

      // (3.2) The history report: built from the same fixtures (markup in titles included), parsed
      // back, and checked for injected markup and its data block.
      const report = await evaluate(`(async () => {
        const m = await import('./report.js');
        const { cmd } = await import('./ui.js');
        const ids = (await cmd({ cmd: 'recStatus' })).recordings.map((r) => r.id);
        const res = await cmd({ cmd: 'recHistory', ids });
        const html = m.buildHistoryReport(m.summarizeHistory(res.recordings), { scope: 'all sites <b>x</b>', version: '0' });
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const data = JSON.parse(doc.getElementById('g9-history').textContent);
        return {
          injected: doc.querySelectorAll('img, h1 b, script:not([type="application/json"])').length + (doc.querySelector('h1').textContent.includes('<b>x</b>') ? 0 : 1),
          rows: doc.querySelectorAll('tbody tr').length,
          flows: data.totals.flows,
          title: doc.querySelector('h1').textContent,
          name: m.reportFileName('all sites <b>x</b>', 0),
        };
      })()`);
      if (report.injected) fail(`[${tag}] history report`, `${report.injected} element(s) of injected markup`);
      else if (report.rows !== report.flows || report.rows < 10) fail(`[${tag}] history report`, `${report.rows} row(s) for ${report.flows} flow(s)`);
      else if (!/^g9-history-all-sites-b-x-b-1970-01-01.html$/.test(report.name)) fail(`[${tag}] history report`, `file name ${report.name}`);
      else ok(`[${tag}] history report: ${report.rows} flows, no injected markup, data block parses`);
      await waitFor(`[...document.querySelectorAll('#recList .drawer input')].some((i) => i.value === 'legacy, import')`,
        'the malformed flow\'s drawer shows its tags as a list');
      const groups = await evaluate(`[...document.querySelectorAll('#recList *')].filter((n) => n.childElementCount === 0).map((n) => n.textContent.trim())`);
      if (!groups.includes('none')) fail(`[${tag}] suite "none"`, 'a suite named "none" is not shown under its own name');
      else ok(`[${tag}] malformed flow opens, suite "none" keeps its name`);

      // Arrow keys only move within Auto-attach; they must not switch it (review finding 5).
      phase = `${tag} auto-attach keys`;
      await evaluate(`document.getElementById('tab-session').click(), true`);
      await evaluate(`(window.__g9sent = [], document.querySelector('input[name="autoAttach"][value="off"]').focus(), true)`);
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
      await delay(200);
      const sentByArrow = await evaluate(`window.__g9sent.slice()`);
      if (sentByArrow.length) fail(`[${tag}] auto-attach arrow keys`, `ArrowLeft sent setAutoAttach ${JSON.stringify(sentByArrow)}`);
      else ok(`[${tag}] ArrowLeft in Auto-attach moves focus without switching the mode`);
      await evaluate(`document.getElementById('tab-automation').click(), true`);

      // Issues: the list, then one opened.
      phase = `${tag} issues`;
      await evaluate(`document.getElementById('tab-issues').click(), true`);
      await waitFor(`document.querySelectorAll('#issueList .issue').length >= 8`, 'the issue list');
      const legacy = await evaluate(`[...document.querySelectorAll('#issueList .issue-open')].find((b) => b.textContent.includes('Panel froze'))?.querySelector('.vt')?.textContent`);
      if (legacy !== 'Normal') fail(`[${tag}] an index entry without severity reads as "${legacy}", not Normal`);
      await shoot('issues');
      phase = `${tag} issue detail`;
      await evaluate(`document.querySelector('#issueList .issue-open').click(), true`);
      await waitFor(`!document.getElementById('issueDetailView').hidden && document.querySelectorAll('#dAttachments li').length === 6`, 'the issue editor');
      await shoot('issue-detail');

      // An edit made in the editor is what the list shows after Back (C2).
      phase = `${tag} issue edit`;
      await evaluate(`(() => {
        const s = document.getElementById('dSeverity'); s.value = 'minor'; s.dispatchEvent(new Event('change'));
        const t = document.getElementById('dTags'); t.value = 'orders, edited-tag'; t.dispatchEvent(new Event('input'));
        document.getElementById('issueBack').click(); return true; })()`);
      const reflected = await waitFor(`(() => { const b = document.querySelector('#issueList [data-k="open:bug_total"]');
        return !document.getElementById('issueListView').hidden && b && b.querySelector('.vt').textContent === 'Minor' && b.textContent.includes('edited-tag'); })()`,
      'the edited severity and tag in the list');
      if (reflected) ok(`[${tag}] severity and tag edits show in the list after Back`);

      // About.
      phase = `${tag} about`;
      await evaluate(`document.getElementById('tab-about').click(), true`);
      await waitFor(`document.getElementById('aboutVersion').textContent === 'v${VERSION}' && document.getElementById('aboutDaemon').textContent.includes('g9d')`, 'the About view');
      await shoot('about');

      // The toast goes when the worker says the tab is no longer blocked (A3).
      phase = `${tag} unblock`;
      await evaluate(`(() => { window.__g9Fixture.state.blocked = {}; window.__g9Broadcast({ type: 'agentUnblocked', tabId: 104 }); return true; })()`);
      if (await waitFor(`document.getElementById('blockedAlerts').hidden`, 'the blocked toast to go on agentUnblocked', 3000)) {
        ok(`[${tag}] agentUnblocked removes the toast`);
      }
      const title = await evaluate('document.title');
      if (title !== `G9BrowserAgent v${VERSION}`) fail(`[${tag}] document.title is "${title}"`);
    }

    // (3.2) The live view: the page an agent's browser_tabs action:"watch" opens.
    for (const { width, scheme } of [{ width: 1000, scheme: 'light' }, { width: 1000, scheme: 'dark' }, { width: 360, scheme: 'light' }]) {
      const tag = `${width}-${scheme}`;
      if (ONLY && ONLY !== tag) continue;
      phase = `watch ${tag}`;
      await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: width <= 400 ? 2 : 1, mobile: false });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      if (stubScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubScript });
      ({ identifier: stubScript } = await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(${installStub.toString()})(${JSON.stringify(fixtures())}, ${JSON.stringify(VERSION)}); (${installFakeDaemon.toString()})();`,
      }));
      const loaded = conn.waitForEvent('Page.loadEventFired', { sessionId, timeoutMs: 15_000 });
      await send('Page.navigate', { url: `${origin}/panel/watch.html?tab=21&agent=cursor` });
      await pageLoaded(loaded, `[watch ${tag}] watch.html`);
      await waitFor("document.querySelectorAll('.watch-tile').length === 1 && document.getElementById('wConn').textContent.includes('Connected')", 'the first tile and the viewer link');
      await waitFor("[...document.getElementById('wPicker').options].some((o) => o.value === '22')", 'the picker listing the other tabs');
      await evaluate("(document.getElementById('wPicker').value = '22', document.getElementById('wAdd').click(), true)");
      await waitFor("document.querySelectorAll('.watch-tile').length === 2", 'a second tile');
      // Frames drawn: the middle of each canvas is page, not the dark stage.
      const drawn = await waitFor("[...document.querySelectorAll('.watch-tile canvas')].every((c) => { const g = c.getContext('2d'); const w = c.width, h = c.height; if (w < 50 || h < 50) return false; const d = g.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1).data; return !(d[0] === 15 && d[1] === 20 && d[2] === 27); }) && [...document.querySelectorAll('.watch-hud')].every((d) => d.textContent.includes('fps'))", 'frames drawn in both tiles');
      await delay(400);
      if (drawn) ok(`[watch ${tag}] two live tiles, frames drawn, cursor and HUD running`);
      const said = await evaluate("(window.__g9viewerSent ?? []).join(',')");
      if (!/^hello:viewer,watchables/.test(said) || /call|admin|flowlib/.test(said)) fail(`[watch ${tag}] the page spoke more than viewer`, said);
      const injected = await evaluate("document.querySelectorAll('img[src=\"x\"], script:not([src])').length");
      if (injected) fail(`[watch ${tag}] a tab title became markup`, `${injected} element(s)`);
      const overflow = await evaluate(OVERFLOW_PROBE);
      if (width <= 400 && overflow.length) fail(`[watch ${tag}] horizontal overflow`, overflow.join('; '));
      const { cssContentSize } = await send('Page.getLayoutMetrics');
      const height = Math.ceil(Math.max(800, cssContentSize?.height ?? 800));
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
      await writeFile(path.join(OUT, `watch-${tag}.png`), Buffer.from(shot.data, 'base64'));
      ok(`watch-${tag}.png`, `${width}×${height}`);
    }
  } finally {
    if (browser) {
      const closed = await browser.close().catch((err) => ({ error: err.message }));
      if (closed?.error) console.log(`  (browser close: ${closed.error})`);
    }
    await new Promise((r) => server.close(r));
  }
}

try {
  await main();
} catch (err) {
  fail('harness', String(err?.stack ?? err).slice(0, 800));
}
console.log(failures.length ? `\n${failures.length} failure(s). Screenshots in ${OUT}` : `\nclean. Screenshots in ${OUT}`);
process.exit(failures.length ? 1 : 0);
