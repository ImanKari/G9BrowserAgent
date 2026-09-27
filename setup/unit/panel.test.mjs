#!/usr/bin/env node
/**
 * WP-panel unit tests: the side panel, the welcome page, the manifest, and the
 * extension's transport to the daemon.
 *
 * Convention (ARCHITECTURE_V2 §12.1): standalone, node:assert/strict, one
 * `  PASS <name>` line per test, exit non-zero on the first failure, and no
 * network, no real browser, no port 8765. `globalThis.chrome`, `WebSocket`,
 * `fetch` and the timers are stubbed here, before any extension module loads.
 *
 * Three kinds of check:
 *
 *  1. Source-level: the four modes, the workspace allowlist and bridge
 *     discovery are gone; the version is shown in the header, the title, the
 *     About tab and the welcome page; every command the panel sends is in the
 *     §13 table; every element the scripts reach for exists. (v3) The Attach
 *     button is gone, Record from now / the three auto-attach modes / the
 *     blocked-agent toast are there, and no script builds HTML from strings.
 *  2. Behavioural, for the small pure parts of the panel (ui.js titles and
 *     browser detection) and for welcome.js against a stub DOM.
 *  3. The transport, twice: once as an isolated copy over a stub state.js (the
 *     transport's own logic, whatever state.js is doing), and once over the
 *     real state.js → platform-extension → stubbed chrome.storage (the module
 *     graph the service worker actually loads).
 */

import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdtemp, access } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
const exists = (rel) => access(path.join(ROOT, rel)).then(() => true, () => false);

/** Temp dirs this run created. Removed on ANY exit — a failing test exits early. */
const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(err?.stack ?? err);
    process.exit(1);
  }
}

// ------------------------------------------------------------------ the stubs

const real = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
};

// A test that hangs is a failure, not a stuck CI job.
real.setTimeout(() => {
  console.log('  FAIL watchdog: the panel tests did not finish within 60s');
  process.exit(1);
}, 60_000).unref();

/** Let every queued promise chain run (the transport's handlers are async). */
const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => real.setImmediate(r));
};

/** A fake clock for the transport's backoff, ping, welcome and request timers. */
const clock = { now: 0, seq: 0, timers: new Map() };
globalThis.setTimeout = (fn, ms = 0, ...args) => {
  const id = ++clock.seq;
  clock.timers.set(id, { at: clock.now + Math.max(0, ms), fn, args, every: null });
  return id;
};
globalThis.clearTimeout = (id) => {
  clock.timers.delete(id);
};
globalThis.setInterval = (fn, ms = 0, ...args) => {
  const id = ++clock.seq;
  clock.timers.set(id, { at: clock.now + ms, fn, args, every: ms });
  return id;
};
globalThis.clearInterval = globalThis.clearTimeout;

async function advance(ms) {
  const end = clock.now + ms;
  for (;;) {
    let next = null;
    for (const [id, t] of clock.timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
    if (!next) break;
    const [id, t] = next;
    clock.now = t.at;
    if (t.every) t.at += t.every;
    else clock.timers.delete(id);
    t.fn(...t.args);
    await flush();
  }
  clock.now = end;
  await flush();
}

const storageMaps = { session: new Map(), local: new Map() };
/** `storageFail.gets = n` makes the next n reads of chrome.storage.session reject. */
const storageFail = { gets: 0 };
function area(map) {
  return {
    async get(keys) {
      if (map === storageMaps.session && storageFail.gets > 0) {
        storageFail.gets -= 1;
        throw new Error('storage exploded');
      }
      if (keys == null) return structuredClone(Object.fromEntries(map));
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) {
        if (map.has(k)) out[k] = structuredClone(map.get(k));
        else if (keys && typeof keys === 'object' && !Array.isArray(keys)) out[k] = keys[k];
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) map.delete(k);
    },
    async clear() {
      map.clear();
    },
  };
}

/** What chrome.tabs.query({}) answers. */
const openTabsStub = [{ id: 5, url: 'https://a.test/' }, { id: 6, url: '', pendingUrl: 'https://b.test/' }];

/** Everything sent through chrome.runtime.sendMessage (the transport's broadcasts, state's). */
const broadcasts = [];
const noopEvent = { addListener() {}, removeListener() {} };
globalThis.chrome = {
  runtime: {
    id: 'g9testextensionid',
    getManifest: () => ({ version: '2.0.0' }),
    getURL: (p) => `chrome-extension://g9testextensionid/${p}`,
    sendMessage: (msg) => {
      broadcasts.push(msg);
      return Promise.resolve(undefined);
    },
    onMessage: noopEvent,
    reload() {},
  },
  storage: { session: area(storageMaps.session), local: area(storageMaps.local), onChanged: noopEvent },
  // Present so platform.js selects platform-extension (and so chrome.storage
  // above) exactly as it does in the service worker. Nothing here attaches.
  debugger: { onEvent: noopEvent, onDetach: noopEvent },
  // query(): the open tabs the hello reports (D-c), so the daemon can check a reconnect's handles.
  tabs: { onRemoved: noopEvent, onCreated: noopEvent, onUpdated: noopEvent, query: async () => structuredClone(openTabsStub) },
  windows: { onFocusChanged: noopEvent, WINDOW_ID_NONE: -1 },
};

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    this.closedWith = null;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  dispatch(type, event) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('InvalidStateError: not open');
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.closedWith = { code, reason };
  }
  // --- the server's side
  serverOpen() {
    this.readyState = 1;
    this.dispatch('open', {});
  }
  serverSend(obj) {
    this.dispatch('message', { data: JSON.stringify(obj) });
  }
  serverClose(code = 1006, reason = '') {
    this.readyState = 3;
    this.dispatch('close', { code, reason });
  }
  /** Complete a close the client started — the late event a real socket delivers. */
  finishClose() {
    this.readyState = 3;
    this.dispatch('close', { code: this.closedWith?.code ?? 1000, reason: this.closedWith?.reason ?? '' });
  }
  frames(type) {
    return this.sent.filter((f) => f.type === type);
  }
}
globalThis.WebSocket = FakeWebSocket;

const DAEMON_HEALTH = { ok: true, name: 'g9d', version: '2.0.0', pid: 4321, port: 8765, engines: 0, agents: 0, extension: false };
let health = DAEMON_HEALTH;
const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  const h = typeof health === 'function' ? await health() : health;
  if (h === 'refused') throw new TypeError('Failed to fetch');
  if (h === 'timeout') {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  }
  if (typeof h === 'number') return { ok: false, status: h, json: async () => { throw new SyntaxError('no json'); } };
  if (h && typeof h.json === 'function') return h;
  return { ok: true, status: 200, json: async () => structuredClone(h) };
};

function resetWorld() {
  clock.timers.clear();
  FakeWebSocket.instances.length = 0;
  fetchCalls.length = 0;
  broadcasts.length = 0;
  health = DAEMON_HEALTH;
  storageMaps.session.clear();
  storageMaps.local.clear();
  storageFail.gets = 0;
}

const reconnecting = () => broadcasts.filter((m) => m?.type === 'reconnecting').map((m) => m.in);
const lastSocket = () => FakeWebSocket.instances.at(-1);

// =========================================================== 1. source checks

const PANEL_DIR = 'extension/panel';
const panelFiles = (await readdir(path.join(ROOT, PANEL_DIR))).filter((f) => f.endsWith('.js'));
const panelJs = Object.fromEntries(
  await Promise.all(panelFiles.map(async (f) => [f, await read(`${PANEL_DIR}/${f}`)])),
);
const panelHtml = await read(`${PANEL_DIR}/panel.html`);
const panelCss = await read(`${PANEL_DIR}/panel.css`);
const welcomeHtml = await read(`${PANEL_DIR}/welcome.html`);
const transportSrc = await read('extension/lib/transport.js');
const arch = await read('docs/ARCHITECTURE_V2.md');

const htmlIds = (html) => [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
/** Code without block comments and whole-line comments (which quote examples such as `el.foo`). */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

await test('manifest: version equals package.json, Chrome 125+, downloads permission, v2 title', async () => {
  const manifest = JSON.parse(await read('extension/manifest.json'));
  // Never a literal: the owner bumps the version on every change, and a test that pins a number
  // turns each bump into a failing suite (2.0.0 → 2.0.1 did exactly that). The rule is that the
  // three files agree with each other and with lib/version.mjs — setup/unit/version.test.mjs owns
  // the whole comparison; here we only check the manifest against the root package.json.
  assert.ok(await exists('package.json'), 'the root package.json is the one version source');
  const expected = JSON.parse(await read('package.json')).version;
  assert.match(expected, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'package.json carries a semver version');
  assert.equal(manifest.version, expected, 'manifest version must equal the root package.json version');
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, '125', 'flat child sessions need 125');
  for (const p of ['debugger', 'tabs', 'activeTab', 'cookies', 'storage', 'alarms', 'sidePanel', 'unlimitedStorage', 'downloads']) {
    assert.ok(manifest.permissions.includes(p), `permission ${p}`);
  }
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  // The toolbar title names the MAJOR version (sw.js sets the exact one at runtime). Derived from
  // the manifest's own version, so a major bump cannot leave a stale literal behind again.
  const major = manifest.version.split('.')[0];
  assert.equal(manifest.action.default_title, `G9BrowserAgent v${major}`);
  assert.match(manifest.description, /\bv[23]\b/, 'the description names the engine architecture (v2 onwards)');
  assert.ok(manifest.description.length <= 132, 'store descriptions are capped at 132 characters');
  assert.equal(manifest.background.service_worker, 'sw.js');
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.side_panel.default_path, 'panel/panel.html');
  for (const icon of Object.values(manifest.icons)) assert.ok(await exists(`extension/${icon}`), `icon ${icon}`);
  assert.ok(await exists(`extension/${manifest.side_panel.default_path}`));
});

await test('no trace of the four modes, the workspace allowlist or bridge discovery in the panel', () => {
  // Markup: the segmented mode control, its warning line, the allowlist box, the
  // discovery list and the token field.
  for (const pattern of [/data-mode=/, /id="modes"/, /modeWarn/, /workspaceBox/, /wsbox/, /bridgeList/, /discoverBtn/,
    /id="token"/, /Attach &amp; Pin/, /What the agent may touch/i, />\s*(Workspace|Pinned|Follow|Multi)\s*</]) {
    assert.doesNotMatch(panelHtml, pattern, `panel.html still has ${pattern}`);
  }
  // Scripts: the commands and helpers that drove them.
  for (const [file, src] of Object.entries(panelJs)) {
    for (const pattern of [/setMode\b/, /discoverBridges/, /MODE_HELP/, /workspaceDomains/, /renderWorkspace/,
      /state\.mode\b/, /pinnedTabId/, /\btoken\b/, /Attach & Pin/, /Follow mode/, /Multi-tab mode/]) {
      assert.doesNotMatch(src, pattern, `${file} still has ${pattern}`);
    }
  }
  // Styles: the mode buttons and the allowlist box and its chips. (v3 has a
  // generic `.chip` component — tags, evidence, tab chips — so the allowlist is
  // checked by its own names, not by the word "chip".)
  assert.doesNotMatch(panelCss, /^\.modes\b/m);
  assert.doesNotMatch(panelCss, /\.wsbox/);
  assert.doesNotMatch(panelCss, /workspace|allowlist|\.ws-?chip/i);
  // The welcome page names the modes only to say they are gone.
  assert.doesNotMatch(welcomeHtml, /Attach &amp; Pin|locked to that tab/);
  assert.match(welcomeHtml, /Workspace, Pinned, Follow and Multi are gone/);
  // The transport: one daemon, one port.
  assert.doesNotMatch(transportSrc, /discoverBridges|PORT_RANGE/);
});

await test('the version is shown in the header, the window title, the About tab and the welcome page', () => {
  const header = panelHtml.slice(panelHtml.indexOf('<header'), panelHtml.indexOf('</header>'));
  assert.match(header, /id="versionBadge"/, 'a version badge in the header');
  assert.match(header, /G9BrowserAgent/);
  for (const id of ['aboutVersion', 'aboutExt', 'aboutPrev', 'aboutWhen', 'aboutBrowser', 'aboutDaemon', 'aboutConn']) {
    assert.ok(htmlIds(panelHtml).includes(id), `About shows ${id}`);
  }
  assert.match(panelJs['ui.js'], /getManifest\?\.\(\)\.version/, 'the version comes from the manifest');
  assert.match(panelJs['ui.js'], /\$\{PRODUCT\} v\$\{VERSION\}/, 'the title carries the version');
  assert.match(panelJs['panel.js'], /setTitle\(null\)/, 'the title is set before anything can fail');
  assert.match(panelJs['panel.js'], /versionBadge\.textContent = `v\$\{VERSION\}`/);
  assert.match(panelJs['session.js'], /setTitle\(state\)/, 'the title follows Stop');
  // welcome.html: a big version, filled from the manifest; ?updated=1 banner.
  assert.match(welcomeHtml, /class="bigver" id="ver"/);
  assert.match(welcomeHtml, /id="updated"[^>]*hidden/);
  assert.match(welcomeHtml, /\[hidden\] \{ display: none !important; \}/, 'the flex banner must still honour hidden');
  assert.match(panelJs['welcome.js'], /getManifest\?\.\(\)\.version/);
  assert.match(panelJs['welcome.js'], /get\('updated'\) === '1'/);
});

await test('every panel command is in the ARCHITECTURE_V2 §13 table, and every added one is used', () => {
  const s13 = arch.slice(arch.indexOf('## 13.'), arch.indexOf('## 14.'));
  assert.ok(s13.length > 200, '§13 found');
  const ticks = (text) => [...text.matchAll(/`([A-Za-z*]+)`/g)].map((m) => m[1]);
  const kept = ticks(s13.slice(s13.indexOf('Kept:'), s13.indexOf('Removed:')));
  const removed = ticks(s13.slice(s13.indexOf('Removed:'), s13.indexOf('Added:')));
  const added = [...s13.matchAll(/^\|\s*`([A-Za-z]+)`\s*\|/gm)].map((m) => m[1]);
  assert.ok(kept.includes('getState') && kept.includes('rec*'), 'kept list parsed');
  assert.deepEqual(removed.sort(), ['discoverBridges', 'setMode']);
  assert.deepEqual(added.sort(), ['about', 'daemonInfo', 'flowProjects', 'focusTab', 'handoff', 'openWatch', 'popout', 'recHistory', 'recordNow', 'setAutoAttach', 'setInputMode', 'watchAddress']);

  const allowed = (c) =>
    added.includes(c) ||
    kept.some((k) => (k.endsWith('*') ? c.startsWith(k.slice(0, -1)) : k === c));

  const used = new Map();
  for (const [file, src] of Object.entries(panelJs)) {
    // `cmd: 'x'`, `cmd: flag ? 'a' : 'b'` …
    for (const m of src.matchAll(/\bcmd:\s*([^,}\n]+)/g)) {
      for (const q of m[1].matchAll(/'([A-Za-z]+)'/g)) used.set(q[1], file);
    }
    // … and welcome.js's ask('x').
    for (const m of src.matchAll(/\bask\('([A-Za-z]+)'\)/g)) used.set(m[1], file);
  }
  assert.ok(used.size >= 40, `found ${used.size} commands — the scan itself is broken`);
  for (const [c, file] of used) {
    assert.ok(!removed.includes(c), `${file} still sends the removed command ${c}`);
    assert.ok(allowed(c), `${file} sends "${c}", which is not in the §13 table`);
  }
  for (const c of added) assert.ok(used.has(c), `the panel never sends the §13 command ${c}`);
});

await test('the service worker answers every command the panel sends (once sw.js is v2)', async () => {
  const sw = await read('extension/sw.js');
  if (/case 'setMode'/.test(sw)) {
    console.log('  SKIP sw.js is still the v1 router; this check runs once WP-core lands it');
    return;
  }
  const used = new Set();
  for (const src of Object.values(panelJs)) {
    for (const m of src.matchAll(/\bcmd:\s*([^,}\n]+)/g)) for (const q of m[1].matchAll(/'([A-Za-z]+)'/g)) used.add(q[1]);
    for (const m of src.matchAll(/\bask\('([A-Za-z]+)'\)/g)) used.add(m[1]);
  }
  for (const c of used) {
    assert.match(sw, new RegExp(`case '${c}'|['"]?\\b${c}['"]?\\s*[:(]`), `sw.js has no handler for the panel command ${c}`);
  }
});

await test('every element the scripts reach for exists, once', async () => {
  const ids = htmlIds(panelHtml);
  assert.equal(new Set(ids).size, ids.length, `duplicate id in panel.html: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
  for (const [file, src] of Object.entries(panelJs)) {
    // welcome.js and watch.js belong to pages of their own (checked below).
    if (file === 'welcome.js' || file === 'watch.js') continue;
    for (const m of code(src).matchAll(/\bel\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      assert.ok(ids.includes(m[1]), `${file} uses el.${m[1]} but panel.html has no id="${m[1]}"`);
    }
  }
  const wIds = htmlIds(welcomeHtml);
  for (const m of panelJs['welcome.js'].matchAll(/\$\('([^']+)'\)/g)) {
    assert.ok(wIds.includes(m[1]), `welcome.js uses #${m[1]} but welcome.html has none`);
  }
  // (3.2) The live view: every $('…') watch.js looks up is in watch.html, once.
  const watchIds = htmlIds(await read(`${PANEL_DIR}/watch.html`));
  assert.equal(new Set(watchIds).size, watchIds.length, 'duplicate id in watch.html');
  const looked = [...panelJs['watch.js'].matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(looked.length >= 8, 'watch.js looks its elements up by id');
  for (const id of looked) assert.ok(watchIds.includes(id), `watch.js uses #${id} but watch.html has none`);
  for (const m of panelHtml.matchAll(/aria-controls="([^"]+)"/g)) assert.ok(ids.includes(m[1]), `aria-controls ${m[1]}`);
  // Each tab has a body, and each body names its tab.
  const tabs = [...panelHtml.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  const bodies = [...panelHtml.matchAll(/data-body="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['session', 'automation', 'issues', 'about']);
  assert.deepEqual(bodies, tabs);
  // The input level: three radios with the contract's values.
  const levels = [...panelHtml.matchAll(/name="inputMode" value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(levels, ['off', 'human', 'stealth']);
  for (const label of ['Direct', 'Human', 'Stealth', 'Pop out tab', 'Send to background', 'Auto-attach', 'Detach all',
    'Record from now', 'reload to capture page load', 'Keep working elsewhere', 'Project sites', 'All tabs']) {
    assert.ok(panelHtml.includes(label), `panel shows "${label}"`);
  }
  assert.match(panelHtml, /Do not minimise it/);
  assert.match(panelHtml, /reloads there with its cookies and storage/);
  // Stealth's real cost (docs/STEALTH.md, the five things to know, point 4) is named where it is chosen.
  assert.match(panelHtml, /<b>Stealth<\/b>[^<]*<span class="muted">[^<]*console capture off/);
  // Decision D-b in the person's own browser: only Stealth is a floor; Human and
  // Direct are defaults an agent's humanize can change. Each option says which.
  assert.match(panelHtml, /<b>Stealth<\/b>[^<]*<span class="muted">[^<]*an agent cannot ask for less/);
  assert.match(panelHtml, /<b>Human<\/b>[^<]*<span class="muted">[^<]*The default; an agent can still ask for direct input/);
  assert.match(panelHtml, /<b>Direct<\/b>[^<]*<span class="muted">[^<]*unless the agent asks for human input/);
  assert.doesNotMatch(panelHtml, /<b>(Human|Direct)<\/b>[^<]*<span class="muted">[^<]*(cannot ask for less|floor)/);
  // A per-second countdown must not be a live region; the status label is one.
  assert.doesNotMatch(panelHtml, /id="retryNote"[^>]*aria-live/);
  assert.match(panelHtml, /id="daemonLabel" aria-live="polite"/);
});

await test('v3 A1: the Attach button is gone; Record from now (with its reload box) sends recordNow', () => {
  assert.doesNotMatch(panelHtml, /id="attachActive"|Attach current tab/, 'the big Attach button and its copy are gone');
  for (const [file, src] of Object.entries(panelJs)) {
    assert.doesNotMatch(code(src), /el\.attachActive|cmd:\s*'attachActive'/, `${file} still drives the removed Attach button`);
  }
  assert.match(panelHtml, /<button id="recordNow"[^>]*>/);
  assert.match(panelHtml, /<input type="checkbox" id="recordReload"/);
  assert.match(panelJs['session.js'], /cmd\(\{ cmd: 'recordNow', reload \}\)/, 'the box decides reload');
  // The capture is stated honestly, from attachedSince.
  assert.match(panelJs['session.js'], /Recording console and network since \$\{hm\(since\)\}/);
  assert.match(panelJs['session.js'], /Not recording — starts on an agent(’|\\u2019)s first action, or press Record/);
  assert.match(panelJs['session.js'], /status\.current\.attachedSince[\s\S]{0,80}state\.attachedSince/);
});

await test('v3 A2: auto-attach is three settings — Off, Project sites, All tabs — sent as setAutoAttach {mode}', () => {
  const modes = [...panelHtml.matchAll(/name="autoAttach" value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(modes, ['off', 'project', 'all']);
  assert.doesNotMatch(panelHtml, /id="autoAttach"[^>]*role="switch"/, 'the v2 on/off switch is gone');
  assert.match(panelHtml, /<fieldset class="field" id="autoAttachGroup">\s*<legend[^>]*>Auto-attach<\/legend>/);
  assert.match(panelJs['session.js'], /cmd\(\{ cmd: 'setAutoAttach', mode \}\)/);
  assert.doesNotMatch(panelJs['session.js'], /setAutoAttach', enabled/, 'not the v2 boolean form');
  // One line of help per option, and the honest "behaves as Off" line.
  for (const mode of ['off', 'project', 'all']) assert.match(panelJs['session.js'], new RegExp(`^  ${mode}: '`, 'm'));
  assert.match(panelJs['session.js'], /behaves as Off until an agent whose g9\.project\.json lists environments connects/);
  assert.match(panelJs['session.js'], /state\.projectDomains/);
});

await test('v3 A3/A4: the blocked-agent toast sits above the tab bar; agent rows name project and tab (focusTab)', () => {
  const toastAt = panelHtml.indexOf('id="blockedAlerts"');
  assert.ok(toastAt > 0 && toastAt < panelHtml.indexOf('<nav class="tabs"'), 'the toast is pinned above the tab bar');
  assert.match(panelHtml, /<section class="alerts" id="blockedAlerts"[^>]*hidden>/);
  const session = panelJs['session.js'];
  // Read from state on every render (a panel opened later still shows it), and moved by the broadcasts.
  assert.match(session, /function renderBlocked\(state\) \{[\s\S]{0,200}state\.blocked/);
  assert.match(session, /^  renderBlocked\(state\);$/m, 'every render paints it');
  assert.match(panelJs['panel.js'], /case 'agentBlocked':\s*case 'agentUnblocked':\s*session\.onBlockedMessage\(msg\)/);
  const alert = session.slice(session.indexOf('function blockedAlert'), session.indexOf('export function onBlockedMessage'));
  assert.match(alert, /btn\('⧉ Pop out'[\s\S]*popout\(e\.tabId\)/);
  assert.match(alert, /btn\('⇢ Send to background'[\s\S]*handoff\(e\.tabId\)/);
  assert.match(alert, /btn\('Dismiss'/);
  assert.match(alert, /node\('b', null, who\)/, 'it names the agent');
  assert.match(alert, /node\('b', null, `“\$\{tab\}”`\)/, 'and the tab');
  assert.match(session, /cmd\(\{ cmd: 'popout', \.\.\.\(tabId != null \? \{ tabId \} : \{\}\) \}\)/);
  assert.match(session, /cmd\(\{ cmd: 'handoff', \.\.\.\(tabId != null \? \{ tabId \} : \{\}\) \}\)/);
  // Agents: "name · project", then where it works; the tab chip focuses the tab.
  assert.match(session, /\[a\.name \|\| 'agent', a\.project\]\.filter\(Boolean\)\.join\(' · '\)/);
  for (const words of ['working in a launched browser', 'working in another browser', 'no tab yet']) assert.ok(session.includes(words), words);
  assert.match(session, /cmd\(\{ cmd: 'focusTab', tabId \}\)/);
  // The daemon line names no project any more (U4).
  const bare = code(session);
  const daemon = bare.slice(bare.indexOf('function renderDaemon'), bare.indexOf('export function noteRetry'));
  assert.doesNotMatch(daemon, /project/i, 'the daemon line drops the project name');
  assert.doesNotMatch(bare, /function projectName/, 'and the helper that made it');
  // Pop out and Send to background: one line each, the long explanation in the title (A3).
  assert.match(panelHtml, /<button id="popoutTab"[^>]*title="[^"]*Do not minimise it[^"]*"/);
  assert.match(panelHtml, /<button id="handoffTab"[^>]*title="[^"]*reloads there with its cookies and storage[^"]*"/);
});

await test('no script builds HTML from strings; links are http(s) only and open with noopener noreferrer', () => {
  // Page titles, URLs, flow names, issue titles, tags and agent names come from
  // arbitrary pages or people, and this page runs with the extension's debugger
  // privileges. So: DOM nodes and textContent only. An assignment of '' (or a
  // fixed literal) is the one allowed use of innerHTML/outerHTML.
  const staticLiteral = /^\s*(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")\s*$/;
  let scanned = 0;
  for (const [file, src] of Object.entries(panelJs)) {
    const body = code(src);
    scanned += 1;
    for (const m of body.matchAll(/\.(innerHTML|outerHTML)\s*\+?=\s*([^;\n]*)/g)) {
      assert.match(m[2], staticLiteral, `${file}: .${m[1]} = ${m[2].trim()} — build nodes instead`);
    }
    for (const m of body.matchAll(/\b(insertAdjacentHTML|document\.write(?:ln)?)\s*\(([^)]*)\)/g)) {
      const arg = m[1] === 'insertAdjacentHTML' ? m[2].split(',').slice(1).join(',') : m[2];
      assert.match(arg, staticLiteral, `${file}: ${m[1]}(${m[2].trim()}) — build nodes instead`);
    }
    assert.doesNotMatch(body, /createContextualFragment|\.srcdoc\s*=|\beval\s*\(|new Function\s*\(/, `${file} evaluates or parses markup`);
    assert.doesNotMatch(body, /setAttribute\(\s*['"]on[a-z]+['"]/i, `${file} sets an inline event handler`);
    // One place makes links: ui.js extLink, from safeHref.
    if (file !== 'ui.js') assert.doesNotMatch(body, /\.href\s*=/, `${file} sets a link's href itself — use ui.js extLink`);
  }
  assert.ok(scanned >= 7, 'every panel script was scanned');
  // The scan itself works: it would have caught the v2 empty-log line if it were dynamic.
  assert.doesNotMatch("el.log.innerHTML = `<li>${x}</li>`".match(/\.(innerHTML)\s*\+?=\s*([^;\n]*)/)[2], staticLiteral);
  const ui = code(panelJs['ui.js']);
  const link = ui.slice(ui.indexOf('export function extLink'), ui.indexOf('export const prefs'));
  assert.match(link, /const href = safeHref\(url\);\s*if \(!href\) return null;/);
  assert.match(link, /a\.rel = 'noopener noreferrer'/);
});

await test('v3 pure helpers: safeHref, middle, the flow filter and scope, the issue filter and evidence chips', async () => {
  const ui = await import(pathToFileURL(path.join(ROOT, PANEL_DIR, 'ui.js')).href);
  assert.equal(ui.safeHref('https://a.test/x?y=1'), 'https://a.test/x?y=1');
  assert.equal(ui.safeHref('http://a.test'), 'http://a.test/');
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'chrome://settings', 'not a url', null]) {
    assert.equal(ui.safeHref(bad), null, String(bad));
  }
  assert.equal(ui.middle('short', 20), 'short');
  const cut = ui.middle('/a/very/long/path/that/ends/with/the-file.csv', 24);
  assert.equal(cut.length, 24);
  assert.ok(cut.startsWith('/a/very') && cut.endsWith('file.csv') && cut.includes('…'), cut);

  const automation = await import(pathToFileURL(path.join(ROOT, PANEL_DIR, 'automation.js')).href);
  const rows = [
    { id: 'a', name: 'Login', startUrl: 'https://admin.test/login', suite: 'smoke', tags: ['@smoke'], lastRun: { verdict: 'PASS', at: 1 } },
    { id: 'b', name: 'Refund', startUrl: 'https://admin.test/r', suite: 'orders', tags: [], lastRun: { verdict: 'FAIL_PRODUCT', at: 2 }, flaky: { detected: true } },
    { id: 'c', name: 'Checkout', startUrl: 'https://shop.test/c', suite: 'smoke', tags: ['@manual'], lastRun: null },
    { id: 'd', name: 'Old', startUrl: null, suite: null, tags: [], lastRun: null },
  ];
  const ids = (f) => automation.applyFilter(rows, { site: '', suite: '', tag: '', verdict: '', flaky: false, q: '', ...f }).map((r) => r.id);
  assert.deepEqual(ids({}), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids({ site: 'https://admin.test' }), ['a', 'b'], 'site = origin of startUrl');
  assert.deepEqual(ids({ site: 'none' }), ['d'], 'no start URL is its own bucket');
  assert.deepEqual(ids({ suite: 'smoke' }), ['a', 'c']);
  assert.deepEqual(ids({ suite: automation.NO_SUITE }), ['d'], 'no suite is its own bucket, under a key nobody can type');
  // v3 review, finding 8: a real suite named "none" is not the no-suite bucket.
  const withNone = [...rows, { id: 'e', name: 'Named none', startUrl: 'https://admin.test/n', suite: 'none', tags: [], lastRun: null }];
  const idsIn = (list, f) => automation.applyFilter(list, { site: '', suite: '', tag: '', verdict: '', flaky: false, q: '', ...f }).map((r) => r.id);
  assert.deepEqual(idsIn(withNone, { suite: 'none' }), ['e']);
  assert.deepEqual(idsIn(withNone, { suite: automation.NO_SUITE }), ['d']);
  assert.deepEqual(ids({ tag: '@manual' }), ['c']);
  assert.deepEqual(ids({ verdict: 'none' }), ['c', 'd'], 'never run');
  assert.deepEqual(ids({ verdict: 'FAIL_PRODUCT' }), ['b']);
  assert.deepEqual(ids({ flaky: true }), ['b']);
  assert.deepEqual(ids({ q: 'check' }), ['c']);
  const scope = (f) => automation.scopeText({ site: '', suite: '', tag: '', verdict: '', flaky: false, q: '', ...f });
  assert.equal(scope({}), 'all sites');
  assert.equal(scope({ suite: 'smoke' }), 'smoke');
  assert.equal(scope({ site: 'https://admin.test', suite: 'smoke' }), 'smoke on admin.test');
  assert.equal(scope({ site: 'http://intranet:8080' }), 'http://intranet:8080', 'a non-https origin is named in full');
  assert.equal(scope({ suite: 'smoke', flaky: true }), 'smoke (flaky)');
  // The runner runs what the filter shows and never a flow tagged @manual.
  assert.match(panelJs['automation.js'], /const list = applyFilter\(res\?\.recordings \?\? \[\]\)\.filter\(\(r\) => !isManual\(r\)\);/);
  assert.match(panelJs['automation.js'], /`▶ Run \$\{runnable\.length\} flow\$\{runnable\.length === 1 \? '' : 's'\} in \$\{scope\}`/);

  const issues = await import(pathToFileURL(path.join(ROOT, PANEL_DIR, 'issues.js')).href);
  assert.deepEqual(issues.evidenceChips({ screenshots: 2, videos: 1, files: 3, console: true, network: true, dom: true }).map((c) => c[0]),
    ['shot 2', 'video', 'file 3', 'console', 'network', 'DOM']);
  assert.deepEqual(issues.evidenceChips({ screenshots: 0, videos: 2, files: 0, console: false, network: false, dom: false }).map((c) => c[0]), ['video 2']);
  assert.deepEqual(issues.evidenceChips(undefined), []);
  const list = [
    { id: 1, title: 'Total wrong', site: 'https://a.test', status: 'open', severity: 'blocker', tags: ['orders'] },
    { id: 2, title: 'Tooltip', site: 'https://a.test', status: 'filed', severity: 'minor', tags: [], filedAs: 'X-9' },
    { id: 3, title: 'Legacy', url: 'https://b.test/p', status: 'open' }, // written before v3: no site, no severity
  ];
  const iids = (f) => issues.applyIssueFilter(list, { site: '', status: '', severity: '', tag: '', q: '', ...f }).map((i) => i.id);
  assert.deepEqual(iids({ site: 'https://b.test' }), [3], 'site falls back to the origin of the URL');
  assert.deepEqual(iids({ severity: 'normal' }), [3], 'no severity reads as normal');
  assert.deepEqual(iids({ status: 'filed' }), [2]);
  assert.deepEqual(iids({ tag: 'orders' }), [1]);
  assert.deepEqual(iids({ q: 'x-9' }), [2], 'search covers the tracker key');
  // The editor saves tags with the rest, so the list shows them after Back (C2).
  assert.match(panelJs['issues.js'], /tags: el\.dTags\.value\.split\(','\)/);
});

await test('3.2 repository and report helpers: which project, which flows, what the report says', async () => {
  const automation = await import(pathToFileURL(path.join(ROOT, PANEL_DIR, 'automation.js')).href);
  const report = await import(pathToFileURL(path.join(ROOT, PANEL_DIR, 'report.js')).href);
  // Scope: the person's pick, else the list's site filter, else all flows.
  assert.equal(automation.repoScopeOf(null, { site: 'https://a.test' }), 'https://a.test');
  assert.equal(automation.repoScopeOf('', { site: 'https://a.test' }), '', 'an explicit "all flows" is kept');
  assert.equal(automation.repoScopeOf('https://b.test', { site: '' }), 'https://b.test');
  // Project: a pick still offered; else the one whose environments name the site; else the default.
  const projects = [
    { path: 'G:/own/g9.project.json', domains: ['own.test'] },
    { path: 'G:/shop/g9.project.json', domains: ['shop.test', 'localhost:3000'] },
  ];
  assert.equal(automation.repoProjectOf(projects, { saved: 'G:/shop/g9.project.json', fallback: 'G:/own/g9.project.json' }), 'G:/shop/g9.project.json');
  assert.equal(automation.repoProjectOf(projects, { saved: 'G:/gone/g9.project.json', fallback: 'G:/own/g9.project.json', site: 'http://localhost:3000' }), 'G:/shop/g9.project.json', 'a project that left is not picked; the site decides');
  assert.equal(automation.repoProjectOf(projects, { fallback: 'G:/own/g9.project.json', site: 'https://elsewhere.test' }), 'G:/own/g9.project.json');
  assert.equal(automation.repoProjectOf([], { fallback: null }), null);

  const s = report.summarizeHistory([
    { id: 'a', name: 'Login', startUrl: 'https://a.test/login', suite: 'smoke', flaky: { detected: true },
      runHistory: [{ at: 3, verdict: 'FAIL_PRODUCT', durationMs: 3000 }, { at: 1, verdict: 'PASS', durationMs: 1000 }, { at: 2, passed: 3, failed: 0 }],
      steps: [{ type: 'assert' }, { type: 'click' }], knownWorld: { approvedAt: 9, approvedBy: 'qa' } },
    { id: 'b', name: 'Macro', startUrl: null, runHistory: [], knownWorld: { approvedAt: 1, approvedBy: 'seed' } },
    null,
  ]);
  assert.deepEqual(s.totals, { flows: 2, runs: 3, passed: 2, flaky: 1, neverRun: 1, sites: 2 });
  const login = s.flows.find((f) => f.id === 'a');
  assert.deepEqual(login.runs.map((r) => r.verdict), ['PASS', 'PASS', 'FAIL_PRODUCT'], 'oldest first; a pre-v1.7 run counts by its failures');
  assert.equal(login.last, 'FAIL_PRODUCT');
  assert.equal(login.meanMs, 2000);
  assert.equal(login.checks, 1);
  assert.equal(login.approvedBy, 'qa');
  const macro = s.flows.find((f) => f.id === 'b');
  assert.equal(macro.site, 'none');
  assert.equal(macro.approvedAt, null, 'a seeded known world is not an approval');
  assert.equal(macro.last, 'none');
  assert.equal(report.reportFileName('smoke on admin.test (flaky)', Date.UTC(2026, 8, 25)), 'g9-history-smoke-on-admin-test-flaky-2026-09-25.html');
  // It builds a document, never markup from strings (the scan above covers report.js too).
  assert.ok(Object.keys(panelJs).includes('report.js'), 'report.js is scanned');
  assert.match(panelJs['report.js'], /createHTMLDocument/);
});

await test('every panel script and the transport parse', async () => {
  // Most panel modules are only ever loaded by the browser, so nothing else in
  // this suite would notice one that no longer parses — the whole panel would
  // just fail to start (a broken automation.js takes panel.js down with it).
  const { execFileSync } = await import('node:child_process');
  const files = [...panelFiles.map((f) => `${PANEL_DIR}/${f}`), 'extension/lib/transport.js'];
  for (const rel of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' });
    } catch (err) {
      assert.fail(`${rel} does not parse:\n${String(err.stderr ?? err.message).trim()}`);
    }
  }
});

await test('pages are self-contained and CSP-clean; no node: imports; no top-level await', async () => {
  const watchHtml = await read(`${PANEL_DIR}/watch.html`);
  for (const [name, html] of [['panel.html', panelHtml], ['welcome.html', welcomeHtml], ['watch.html', watchHtml]]) {
    assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//, `${name} loads something remote`);
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /\bsrc="/, `${name} has an inline script (MV3 CSP blocks it)`);
    assert.doesNotMatch(html, /\son[a-z]+="/, `${name} has an inline event handler`);
  }
  for (const [file, src] of [...Object.entries(panelJs), ['transport.js', transportSrc]]) {
    assert.doesNotMatch(src, /from\s+['"]node:|import\(['"]node:|require\(/, `${file} imports node`);
    assert.doesNotMatch(src, /^(?:export\s+)?(?:const|let|var)\s+[^=\n]+=\s*await\b|^await\b/m, `${file} has a top-level await`);
  }
  const imports = [...transportSrc.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./state.js'], 'the transport depends on state.js and nothing else');
});

await test('3.2 live view: the cursor is drawn by the desktop\'s own code, the page talks to the daemon as a viewer only', async () => {
  // One drawing of the cursor in two places: extension/panel/track.js IS desktop/renderer/lib/track.js
  // (neither can import the other: an unpacked extension loads nothing outside its folder).
  const mine = await read(`${PANEL_DIR}/track.js`);
  const desktops = await read('desktop/renderer/lib/track.js');
  assert.equal(mine, desktops, 'extension/panel/track.js drifted from desktop/renderer/lib/track.js — copy one over the other');
  const w = code(panelJs['watch.js']);
  assert.match(w, /role: 'viewer'/, 'it says hello as a viewer');
  assert.doesNotMatch(w, /role: '(ui|engine|agent)'/);
  assert.match(w, /type: 'viewer', id, op/, 'every request is a viewer op');
  assert.doesNotMatch(w, /type: '(call|admin|flowlib|request)'/, 'nothing but viewer ops');
  assert.match(w, /cmd: 'watchAddress'/, 'the address comes from the worker, not a guess');
  const watch = await import(pathToFileURL(path.join(ROOT, PANEL_DIR, 'watch.js')).href).catch((err) => ({ err }));
  // Importing it outside a page throws on its DOM wiring; its pure part is checked by source instead.
  assert.ok(watch.err || typeof watch.tabLabel === 'function');
  const label = w.slice(w.indexOf('export function tabLabel'), w.indexOf('function paintPicker'));
  assert.match(label, /headless/);
  assert.match(label, /middle\(/, 'a long title is shortened in the middle');
});

// ======================================================= 2. panel behaviour

await test('ui.js: the title carries the version, and a Stop', async () => {
  const ui = await import(pathToFileURL(path.join(ROOT, PANEL_DIR, 'ui.js')).href);
  assert.equal(ui.VERSION, '2.0.0');
  assert.equal(ui.titleFor(null), 'G9BrowserAgent v2.0.0');
  assert.equal(ui.titleFor({ halted: false }), 'G9BrowserAgent v2.0.0');
  assert.equal(ui.titleFor({ halted: true }), 'Stopped · G9BrowserAgent v2.0.0');
});

await test('ui.js: the browser is named by its own brand and full build', async () => {
  const ui = await import(pathToFileURL(path.join(ROOT, PANEL_DIR, 'ui.js')).href);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const set = (value) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.3405.80';
  try {
    set({
      userAgent: UA,
      userAgentData: {
        brands: [{ brand: 'Not.A/Brand', version: '99' }, { brand: 'Chromium', version: '153' }, { brand: 'Microsoft Edge', version: '153' }],
        platform: 'Windows',
        getHighEntropyValues: async () => ({
          platform: 'Windows',
          fullVersionList: [{ brand: 'Chromium', version: '153.0.7000.1' }, { brand: 'Microsoft Edge', version: '153.0.3405.80' }],
        }),
      },
    });
    assert.deepEqual(await ui.browserInfo(), { name: 'Microsoft Edge', version: '153.0.3405.80', platform: 'Windows', ua: UA });
    set({ userAgent: UA }); // no Client Hints: the UA string decides, and Edge is still Edge
    assert.equal((await ui.browserInfo()).name, 'Microsoft Edge');
    assert.equal((await ui.browserInfo()).version, '153.0.3405.80');
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
  }
});

/** A stand-in for the few DOM nodes ui.js reaches through `el`. */
function stubPanelDom() {
  const els = {};
  const make = (id) => ({
    id,
    hidden: true,
    textContent: '',
    attrs: {},
    listeners: {},
    get title() {
      return this.attrs.title;
    },
    set title(v) {
      this.attrs.title = String(v);
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
  });
  globalThis.document = { title: '', getElementById: (id) => (els[id] ??= make(id)) };
  return els;
}

await test('F8: Record is disabled, with the reason shown, while this tab records; Stop and save is the action', async () => {
  const automation = await import(pathToFileURL(path.join(ROOT, PANEL_DIR, 'automation.js')).href);
  const { recordControls } = automation;
  let c = recordControls({ recording: false });
  assert.deepEqual([c.startDisabled, c.stopHidden, c.why], [false, true, '']);
  c = recordControls({ recording: true, name: 'checkout' });
  assert.equal(c.startDisabled, true, 'startRecording would refuse this tab: the button says so first');
  assert.match(c.why, /already recording "checkout"/);
  assert.match(c.why, /second start on the same tab is refused/);
  assert.equal(c.startTitle, c.why, 'the reason is on the button too');
  assert.equal(c.stopHidden, false);
  assert.equal(c.stopDisabled, false);
  c = recordControls({ recording: false }, { busy: true });
  assert.equal(c.startDisabled, true, 'a double click is not a second start');
  c = recordControls({ recording: true, name: 'x' }, { busy: true });
  assert.equal(c.stopDisabled, true, 'nor a second stop');
  c = recordControls({ recording: false }, { elsewhere: [{ tabId: 9, name: 'other' }] });
  assert.equal(c.startDisabled, false, 'another tab recording does not block this one');
  assert.match(c.why, /another tab: "other" \(tab 9\)/);

  // Stop blocks AGENTS, not the person: under Stop the panel used to say this tab was not recording
  // and name it as "another tab", with Stop-and-save hidden (extension review, 2026-09-22).
  c = recordControls({ recording: true, name: 'checkout' }, { halted: true });
  assert.equal(c.stopHidden, false, 'the person can still save the recording');
  assert.equal(c.startDisabled, true);
  assert.match(c.why, /Agents are stopped; this tab is still recording "checkout"/);
  assert.match(c.why, /Stop and save works while Stop is on/);
  c = recordControls({ recording: false }, { halted: true });
  assert.equal(c.startDisabled, true);
  assert.match(c.why, /Press Resume to record/);

  // Wired: refresh() paints from recStatus; the Record click is ignored while recording.
  const els = {};
  const make = (id) => ({
    id, hidden: false, disabled: false, textContent: '', title: '', innerHTML: '', listeners: {}, attrs: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    appendChild() {},
    // v3: the lists and selects are repainted with these.
    append() {},
    replaceChildren() {},
    querySelectorAll() { return []; },
  });
  const previousDocument = globalThis.document;
  globalThis.document = { title: '', getElementById: (id) => (els[id] ??= make(id)), createElement: (tag) => make(tag) };
  const sent = [];
  const originalSend = globalThis.chrome.runtime.sendMessage;
  let status = { recording: true, name: 'checkout', steps: 2 };
  globalThis.chrome.runtime.sendMessage = async (msg) => {
    sent.push(msg.cmd);
    if (msg.cmd === 'recStatus') return { ok: true, status, elsewhere: [], recordings: [] };
    if (msg.cmd === 'recStop') { status = { recording: false }; return { ok: true, name: 'checkout', steps: 2 }; }
    if (msg.cmd === 'recStart') return { ok: true };
    return { ok: true };
  };
  const ui = await import(pathToFileURL(path.join(ROOT, PANEL_DIR, 'ui.js')).href);
  const wasView = ui.view.active;
  try {
    ui.view.active = 'automation';
    automation.wire();
    await automation.refresh();
    assert.equal(els.recToggle.disabled, true, 'Record disabled while this tab records');
    assert.equal(els.recWhy.hidden, false);
    assert.match(els.recWhy.textContent, /already recording "checkout"/);
    assert.equal(els.recStop.hidden, false, 'Stop and save offered');
    // A click that slips through (a stale button) sends nothing.
    sent.length = 0;
    await els.recToggle.listeners.click[0]();
    assert.ok(!sent.includes('recStart'), 'no recStart while recording');
    // Stop and save, then Record is back.
    await els.recStop.listeners.click[0]();
    await flush();
    await automation.refresh();
    assert.ok(sent.includes('recStop'));
    assert.equal(els.recToggle.disabled, false);
    assert.equal(els.recStop.hidden, true);
    assert.equal(els.recWhy.hidden, true);
  } finally {
    ui.view.active = wasView;
    globalThis.chrome.runtime.sendMessage = originalSend;
    globalThis.document = previousDocument;
  }
  assert.match(panelHtml, /<button id="recStop"[^>]*hidden/);
  assert.match(panelHtml, /id="recWhy"/);
});

await test("ui.js: an action's error survives the refresh that follows it; a refresh error does not linger", async () => {
  const ui = await import(pathToFileURL(path.join(ROOT, PANEL_DIR, 'ui.js')).href);
  const els = stubPanelDom();
  const quiet = console.error;
  console.error = () => {};
  try {
    ui.wireErrors();
    const box = els.panelError;
    // A failed Stop, then the refresh() every handler runs right after acting.
    ui.showPanelError('Could not stop the agents.');
    ui.showPanelError(null, { source: 'refresh' });
    assert.equal(box.hidden, false, 'a good refresh must not wipe the reason an action failed');
    assert.equal(box.textContent, 'Could not stop the agents.');
    // A refresh hiccup does not overwrite it either.
    ui.showPanelError('The extension returned no state.', { source: 'refresh' });
    assert.equal(box.textContent, 'Could not stop the agents.');
    // Clicked away: read.
    box.listeners.click[0]();
    assert.equal(box.hidden, true);

    // A refresh error lasts exactly as long as the problem.
    ui.showPanelError('Panel could not reach the extension: gone', { source: 'refresh' });
    assert.equal(box.hidden, false);
    ui.showPanelError(null, { source: 'action' });
    assert.equal(box.hidden, false, 'clearing another source leaves it');
    ui.showPanelError(null, { source: 'refresh' });
    assert.equal(box.hidden, true);

    // An unattended action error goes after a while, not on the next poll.
    ui.showPanelError('Pull failed.');
    await advance(19_999);
    assert.equal(box.hidden, false);
    await advance(1);
    assert.equal(box.hidden, true);
  } finally {
    console.error = quiet;
    clock.timers.clear();
    delete globalThis.document;
  }
});

await test('session.js: a typed daemon address is normalised or refused, never saved half-wrong', async () => {
  const session = await import(pathToFileURL(path.join(ROOT, PANEL_DIR, 'session.js')).href);
  const p = session.parseAddress;
  assert.deepEqual(p('127.0.0.1', '8765'), { host: '127.0.0.1', port: 8765 });
  assert.deepEqual(p('  ', '8765'), { host: '127.0.0.1', port: 8765 }, 'empty host means the default');
  assert.deepEqual(p('ws://127.0.0.1:18765/g9', '8765'), { host: '127.0.0.1', port: 18765 }, 'a pasted URL');
  assert.deepEqual(p('localhost:18123', '8765'), { host: 'localhost', port: 18123 });
  assert.deepEqual(p('http://localhost/', '18001'), { host: 'localhost', port: 18001 });
  assert.deepEqual(p('::1', '18002'), { host: '::1', port: 18002 }, 'bare IPv6');
  assert.deepEqual(p('[::1]:18003', '8765'), { host: '::1', port: 18003 }, 'bracketed IPv6 with a port');
  assert.equal(p('my host', '8765').field, 'host');
  assert.equal(p('user@host', '8765').field, 'host');
  for (const port of ['0', '65536', 'eighty', '', '12.5', '-1']) assert.equal(p('127.0.0.1', port).field, 'port', `port ${port}`);
});

await test('session.js: the agents list never shows agents the daemon already said are gone', async () => {
  const { chooseAgents } = await import(pathToFileURL(path.join(ROOT, PANEL_DIR, 'session.js')).href);
  const A = { id: 'agent-1', name: 'claude-code', owned: [5] };
  const B = { id: 'agent-2', name: 'cursor', owned: [] };
  const memo = { key: null, infoStale: false };
  // Before the first push (state starts at []), the info answer fills in.
  assert.deepEqual(chooseAgents([], [A], memo), [A]);
  // The push arrives and wins.
  assert.deepEqual(chooseAgents([A, B], [A], memo), [A, B]);
  // Everyone leaves: an empty push is news, and the older info copy must not resurrect A.
  assert.deepEqual(chooseAgents([], [A], memo), []);
  assert.deepEqual(chooseAgents([], [A], memo), [], 'still stale on the next poll');
  // A fresh info answer is newer than the push, so it may fill in again.
  memo.infoStale = false;
  assert.deepEqual(chooseAgents([], [B], memo), [B]);
  assert.deepEqual(chooseAgents(undefined, undefined, { key: null, infoStale: false }), []);
});

/** Load welcome.js fresh against a stub DOM; returns the elements it touched. */
async function runWelcome({ search, answers, sidePanel }) {
  const els = {};
  const make = (id) => ({
    id,
    textContent: '',
    hidden: id === 'updated',
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    addEventListener(type, fn) {
      this.on = fn;
    },
    firstElementChild: {
      children: null,
      replaceChildren(...c) {
        this.children = c;
      },
    },
  });
  globalThis.document = {
    title: '',
    getElementById: (id) => (els[id] ??= make(id)),
    createElement: (tag) => ({ tag, textContent: '' }),
    createTextNode: (text) => ({ text }),
  };
  globalThis.location = { search };
  const sent = [];
  const saved = { ...globalThis.chrome.runtime };
  globalThis.chrome.runtime.sendMessage = async (m) => {
    sent.push(m.cmd);
    return answers[m.cmd] ?? { ok: false, error: `Unknown command ${m.cmd}` };
  };
  globalThis.chrome.tabs.getCurrent = async () => ({ id: 3, windowId: 7 });
  globalThis.chrome.sidePanel = sidePanel;
  try {
    await import(`${pathToFileURL(path.join(ROOT, PANEL_DIR, 'welcome.js')).href}?case=${Math.random()}`);
    await flush();
    return { els, sent, title: globalThis.document.title };
  } finally {
    // sidePanel and tabs.getCurrent stay until the next run replaces them: the
    // click tests call into the page after this returns.
    Object.assign(globalThis.chrome.runtime, saved);
  }
}

await test('welcome.js: ?updated=1 says "Updated from vX to vY"', async () => {
  const { els, sent, title } = await runWelcome({
    search: '?updated=1',
    answers: { about: { ok: true, version: '2.0.0', previousVersion: '1.7.21', updatedAt: Date.UTC(2026, 8, 21), browser: 'Edge 153' } },
  });
  assert.equal(els.ver.textContent, 'v2.0.0');
  assert.equal(title, 'G9BrowserAgent v2.0.0 — updated');
  assert.equal(els.updated.hidden, false);
  assert.equal(els.fromVer.textContent, 'v1.7.21');
  assert.equal(els.toVer.textContent, 'v2.0.0');
  assert.ok(els.updatedWhen.textContent.length > 0, 'and when');
  assert.deepEqual(sent, ['about']);
});

await test('welcome.js: a fresh install shows no update banner; an update with no record does not invent a "from"', async () => {
  const fresh = await runWelcome({ search: '', answers: {} });
  assert.ok(!fresh.els.updated || fresh.els.updated.hidden === true, 'the banner stays hidden (the HTML starts it hidden)');
  assert.equal(fresh.title, 'G9BrowserAgent v2.0.0 — installed');
  assert.equal(fresh.els.ver.textContent, 'v2.0.0');
  assert.deepEqual(fresh.sent, [], 'nothing to ask on a fresh install');

  // `about` unknown (an older worker), getState has no previousVersion either.
  const unknown = await runWelcome({ search: '?updated=1', answers: { getState: { ok: true, state: { previousVersion: null } } } });
  assert.equal(unknown.els.updated.hidden, false);
  assert.deepEqual(unknown.sent, ['about', 'getState']);
  const line = unknown.els.updated.firstElementChild.children;
  assert.equal(line[0].text, 'Updated to ');
  assert.equal(line[1].textContent, 'v2.0.0');

  // getState is the fallback source of previousVersion.
  const fallback = await runWelcome({ search: '?updated=1', answers: { getState: { ok: true, state: { previousVersion: '1.7.20' } } } });
  assert.equal(fallback.els.fromVer.textContent, 'v1.7.20');
});

await test('welcome.js: "Open the G9BrowserAgent panel" opens the side panel inside the click, with a window fallback', async () => {
  const opened = [];
  const { els } = await runWelcome({ search: '', answers: {}, sidePanel: { open: (o) => (opened.push(o), Promise.resolve()) } });
  els.openPanel.on();
  assert.deepEqual(opened, [{ windowId: 7 }], 'called synchronously, with the window looked up ahead of the click');

  const fallbackSent = [];
  const noPanel = await runWelcome({ search: '', answers: { detachPanel: { ok: true } } });
  globalThis.chrome.runtime.sendMessage = async (m) => (fallbackSent.push(m.cmd), { ok: true });
  noPanel.els.openPanel.on();
  await flush();
  assert.deepEqual(fallbackSent, ['detachPanel']);
  globalThis.chrome.runtime.sendMessage = (msg) => (broadcasts.push(msg), Promise.resolve(undefined));
  delete globalThis.chrome.sidePanel;
  delete globalThis.chrome.tabs.getCurrent;
  delete globalThis.document;
  delete globalThis.location;
});

// ============================================================ 3. transport

/** An isolated copy: transport.js next to a minimal in-memory state.js. */
async function isolatedGraph() {
  const dir = await mkdtemp(path.join(tmpdir(), 'g9-panel-transport-'));
  tempDirs.push(dir);
  await writeFile(path.join(dir, 'transport.js'), transportSrc);
  await writeFile(
    path.join(dir, 'state.js'),
    `const initial = () => ({ halted: false, agents: [], project: { found: false },
       bridge: { host: '127.0.0.1', port: 8765, connected: false, lastError: null } });
     let state = initial();
     let failGets = 0;
     export function __reset() { state = initial(); failGets = 0; }
     export function __failGets(n) { failGets = n; }
     export async function getState() {
       if (failGets > 0) { failGets -= 1; throw new Error('storage exploded'); }
       return structuredClone(state);
     }
     export async function setState(patch) {
       const next = { ...state, ...patch };
       if (patch.bridge) next.bridge = { ...state.bridge, ...patch.bridge };
       state = next;
       return structuredClone(next);
     }
     export const activity = [];
     export async function logActivity(entry) { activity.push(entry); return entry; }`,
  );
  const stateModule = await import(pathToFileURL(path.join(dir, 'state.js')).href);
  let n = 0;
  return {
    label: 'isolated',
    dir,
    state: stateModule,
    reset: () => stateModule.__reset(),
    failNextGets: (count = 1) => stateModule.__failGets(count),
    fresh: () => import(`${pathToFileURL(path.join(dir, 'transport.js')).href}?i=${++n}`),
  };
}

/** The real graph: transport.js → state.js → platform.js → platform-extension → stubbed chrome.storage. */
async function realGraph() {
  const stateModule = await import(pathToFileURL(path.join(ROOT, 'extension/lib/state.js')).href);
  let n = 0;
  return {
    label: 'real state.js',
    state: stateModule,
    reset: () => {},
    failNextGets: (count = 1) => {
      storageFail.gets = count;
    },
    fresh: () => import(`${pathToFileURL(path.join(ROOT, 'extension/lib/transport.js')).href}?i=${++n}`),
  };
}

const WELCOME = {
  type: 'welcome',
  version: '2.0.0',
  daemonPid: 77,
  id: 'engine-3',
  repoRoot: 'G:/repo',
  project: { found: true, path: 'G:/repo/g9.project.json', environments: { dev: {} }, flowsDir: 'G:/repo/flows' },
  halted: { global: false },
};

async function connectWelcomed(t, welcome = {}) {
  await t.connect();
  await flush();
  const ws = lastSocket();
  ws.serverOpen();
  await flush();
  ws.serverSend({ ...WELCOME, ...welcome });
  await flush();
  return ws;
}

function settledFlag(promise) {
  const box = { settled: false, value: undefined, error: undefined };
  promise.then(
    (v) => Object.assign(box, { settled: true, value: v }),
    (e) => Object.assign(box, { settled: true, error: e }),
  );
  return box;
}

const TRANSPORT_TESTS = [
  ['exports exactly the §14 surface; discovery and the port range are gone', async (g) => {
    const t = await g.fresh();
    assert.deepEqual(Object.keys(t).sort(), [
      // `hurry`: a Stop that could not be sent connects at once instead of waiting out the backoff.
      'DEFAULT_PORT', 'connect', 'connectNow', 'connectedAddress', 'disconnect', 'flowLib', 'hurry', 'isConnected', 'isReconnectPending',
      'onMessage', 'request', 'send',
    ]);
    assert.equal(t.DEFAULT_PORT, 8765);
    assert.equal(t.isConnected(), false);
    assert.equal(t.send({ type: 'x' }), false, 'send before any socket is a no-op');
  }],

  ['connect checks /health, opens ws://host:port/g9 and says hello as an engine', async (g) => {
    const t = await g.fresh();
    await t.connect();
    await flush();
    assert.deepEqual(fetchCalls, ['http://127.0.0.1:8765/health']);
    assert.equal(FakeWebSocket.instances.length, 1);
    const ws = lastSocket();
    assert.equal(ws.url, 'ws://127.0.0.1:8765/g9');
    ws.serverOpen();
    await flush();
    const { instanceId, loadId, ...rest } = ws.sent[0].client;
    assert.deepEqual({ ...ws.sent[0], client: rest }, {
      type: 'hello',
      role: 'engine',
      version: '2.0.0',
      client: {
        name: 'extension', browser: globalThis.navigator?.userAgent ?? '', extensionId: 'g9testextensionid',
        tabs: [{ tabId: 5, url: 'https://a.test/' }, { tabId: 6, url: 'https://b.test/' }],
      },
    });
    assert.match(instanceId, /^[A-Za-z0-9._-]{8,128}$/);
    assert.match(loadId, /^[A-Za-z0-9._-]{8,128}$/);
    assert.notEqual(instanceId, loadId);
    assert.equal(t.isConnected(), false, 'an open socket is not a connection until the daemon welcomes it');
    assert.equal((await g.state.getState()).bridge.connected, false);
  }],

  ['D-c: the hello\'s instanceId survives reconnects, worker restarts and reloads; loadId only the worker restart', async (g) => {
    let t = await g.fresh();
    let ws = await connectWelcomed(t);
    const first = ws.sent[0].client;
    assert.equal(storageMaps.local.get('g9:instanceId'), first.instanceId, 'kept in storage.local');
    assert.equal(storageMaps.session.get('g9:loadId'), first.loadId, 'kept in storage.session');
    // A dropped socket and a reconnect: same identity.
    ws.serverClose(1006);
    await flush();
    await advance(500);
    ws = lastSocket();
    ws.serverOpen();
    await flush();
    assert.equal(ws.sent[0].client.instanceId, first.instanceId);
    assert.equal(ws.sent[0].client.loadId, first.loadId);
    // A worker restart (a fresh module, the same storage): same identity.
    t = await g.fresh();
    await t.connect();
    await flush();
    ws = lastSocket();
    ws.serverOpen();
    await flush();
    assert.equal(ws.sent[0].client.instanceId, first.instanceId, 'a restarted worker is the same extension');
    assert.equal(ws.sent[0].client.loadId, first.loadId, '…in the same browser session');
    // An extension reload or a browser restart clears storage.session: a new loadId, the same instanceId.
    storageMaps.session.delete('g9:loadId');
    t = await g.fresh();
    await t.connect();
    await flush();
    ws = lastSocket();
    ws.serverOpen();
    await flush();
    assert.equal(ws.sent[0].client.instanceId, first.instanceId);
    assert.notEqual(ws.sent[0].client.loadId, first.loadId);
    await t.disconnect();
  }],

  ['the welcome marks the link connected and stores what the daemon said', async (g) => {
    const t = await g.fresh();
    const seen = [];
    t.onMessage((m) => seen.push(m));
    await connectWelcomed(t);
    assert.equal(t.isConnected(), true);
    const st = await g.state.getState();
    assert.equal(st.bridge.connected, true);
    assert.equal(st.bridge.lastError, null);
    assert.equal(st.bridge.daemonVersion, '2.0.0');
    assert.equal(st.bridge.engineId, 'engine-3');
    assert.equal(st.bridge.daemonPid, 77);
    assert.equal(st.bridge.repoRoot, 'G:/repo');
    assert.equal(st.project.found, true);
    assert.equal(st.project.flowsDir, 'G:/repo/flows');
    assert.deepEqual(seen, [], 'the welcome is the transport\'s, not the handler\'s');
  }],

  ['daemon messages reach the handler; pings are answered; responses are not forwarded', async (g) => {
    const t = await g.fresh();
    const seen = [];
    t.onMessage((m) => seen.push(m.type));
    const ws = await connectWelcomed(t);
    for (const m of [
      { type: 'call', id: 901, tool: 'browser_snapshot', args: { tabId: 5 }, caller: { agentId: 'agent-1', name: 'x' } },
      { type: 'halt', halted: true },
      { type: 'agents', agents: [] },
      { type: 'pong', at: 1 },
      { type: 'ping', at: 5 },
      { type: 'response', id: 424242, ok: true, result: {} },
      { type: 'flowlibResult', id: 434343, ok: true, result: {} },
    ]) ws.serverSend(m);
    ws.dispatch('message', { data: 'not json' });
    await flush();
    assert.deepEqual(seen, ['call', 'halt', 'agents']);
    assert.deepEqual(ws.frames('pong'), [{ type: 'pong', at: 5 }]);
  }],

  ['request() correlates the daemon\'s response by id', async (g) => {
    const t = await g.fresh();
    const ws = await connectWelcomed(t);
    const p = settledFlag(t.request('info'));
    const frame = ws.frames('request').at(-1);
    assert.equal(frame.op, 'info');
    assert.equal(typeof frame.id, 'number');
    ws.serverSend({ type: 'response', id: frame.id + 1000, ok: true, result: 'wrong' });
    await flush();
    assert.equal(p.settled, false, 'another id does not answer this request');
    ws.serverSend({ type: 'response', id: frame.id, ok: true, result: { version: '2.0.0', agents: [], engines: [] } });
    await flush();
    assert.deepEqual(p.value, { version: '2.0.0', agents: [], engines: [] });

    const q = t.request('handoff', { tabId: 9 });
    const hf = ws.frames('request').at(-1);
    assert.equal(hf.tabId, 9);
    ws.serverSend({ type: 'response', id: hf.id, ok: false, error: 'No launched engine could start.' });
    await assert.rejects(q, /No launched engine could start/);

    // The payload cannot overwrite the envelope.
    t.request('info', { type: 'evil', id: 999, op: 'nope' }).catch(() => {});
    const env = ws.frames('request').at(-1);
    assert.equal(env.op, 'info');
    assert.notEqual(env.id, 999);
    assert.ok(ws.sent.every((f) => f.type !== 'evil'));
  }],

  ['request() times out with a named reason, and fails at once when offline', async (g) => {
    const t = await g.fresh();
    await connectWelcomed(t);
    const p = settledFlag(t.request('info', {}, { timeoutMs: 1000 }));
    await advance(999);
    assert.equal(p.settled, false);
    await advance(1);
    assert.match(p.error?.message ?? '', /did not answer the request "info" within 1s/);

    await t.disconnect();
    await assert.rejects(t.request('handoff', { tabId: 1 }), /daemon is not connected, so "handoff" cannot run/);
    await assert.rejects(t.flowLib('status'), /flow library on disk is unreachable/);
  }],

  ['flowLib sends {type:"flowlib", id, op, …} and settles on the flowlibResult with that id', async (g) => {
    const t = await g.fresh();
    const ws = await connectWelcomed(t);
    const p = t.flowLib('status', { local: [{ id: 'a' }] });
    const f = ws.frames('flowlib').at(-1);
    assert.equal(f.op, 'status');
    assert.equal(typeof f.id, 'number');
    assert.equal('flowId' in f, false, 'status is about no single flow');
    assert.deepEqual(f.local, [{ id: 'a' }]);
    ws.serverSend({ type: 'flowlibResult', id: f.id, ok: true, result: { total: 3 } });
    assert.deepEqual(await p, { total: 3 });
  }],

  ['F5: read/remove name the flow in flowId; the correlation id is the transport\'s own; two reads of one flow may overlap', async (g) => {
    // v1 used `id` for both the flow and the correlation: v1 looked the answer
    // up by number and timed out; v2 at first asked the daemon for "flow 3".
    // Now the flow travels as flowId and nothing else is overloaded.
    const t = await g.fresh();
    const ws = await connectWelcomed(t);
    const read = settledFlag(t.flowLib('read', { flowId: 'checkout-guest' }));
    const f = ws.frames('flowlib').at(-1);
    assert.equal(f.op, 'read');
    assert.equal(f.flowId, 'checkout-guest', 'the daemon is asked for the flow by flowId');
    assert.equal(typeof f.id, 'number', 'the correlation id is a number of this side\'s own');
    // The same flow read twice at once: allowed now (the one-request-per-flow limit is gone).
    const again = settledFlag(t.flowLib('read', { id: 'checkout-guest' }));
    const f2 = ws.frames('flowlib').at(-1);
    assert.equal(f2.flowId, 'checkout-guest', 'a caller\'s `id` is still read as the flow');
    assert.equal('id' in f2 && f2.id === 'checkout-guest', false, 'and never sent as the correlation id');
    assert.notEqual(f2.id, f.id);
    ws.serverSend({ type: 'flowlibResult', id: f2.id, ok: true, result: { spec: { id: 'checkout-guest', n: 2 } } });
    ws.serverSend({ type: 'flowlibResult', id: f.id, ok: true, result: { spec: { id: 'checkout-guest', n: 1 } } });
    await flush();
    assert.deepEqual(read.value, { spec: { id: 'checkout-guest', n: 1 } }, 'each answer reaches its own request');
    assert.deepEqual(again.value, { spec: { id: 'checkout-guest', n: 2 } });
    // An answer keyed by the flow id (a v1 daemon) answers nothing.
    const removed = settledFlag(t.flowLib('remove', { flowId: 'checkout-guest' }));
    const rf = ws.frames('flowlib').at(-1);
    ws.serverSend({ type: 'flowlibResult', id: 'checkout-guest', ok: true, result: {} });
    await flush();
    assert.equal(removed.settled, false);
    ws.serverSend({ type: 'flowlibResult', id: rf.id, ok: false, error: 'No flow with id "checkout-guest".' });
    await flush();
    assert.match(removed.error?.message ?? '', /No flow with id "checkout-guest"/);
  }],

  ['a handoff waits for a browser launch; other requests keep the short default', async (g) => {
    const t = await g.fresh();
    await connectWelcomed(t);
    const handoff = settledFlag(t.request('handoff', { tabId: 3 }));
    const info = settledFlag(t.request('info'));
    await advance(15_000);
    assert.match(info.error?.message ?? '', /did not answer the request "info" within 15s/);
    assert.equal(handoff.settled, false, 'a cold engine start takes longer than 15s; failing early misreports a handoff that completes');
    await advance(165_000);
    assert.equal(handoff.settled, false, 'the daemon itself allows a handoff 3 minutes');
    await advance(5_000);
    assert.match(handoff.error?.message ?? '', /did not answer the request "handoff" within 185s/);
    // An explicit timeout still wins.
    const quick = settledFlag(t.request('handoff', { tabId: 3 }, { timeoutMs: 2000 }));
    await advance(2000);
    assert.equal(quick.settled, true);
  }],

  ['a storage failure mid-attempt never rejects connect() and never ends the retries', async (g) => {
    const t = await g.fresh();
    const quiet = console.error;
    console.error = () => {};
    try {
      g.failNextGets(1);
      await t.connect(); // resolves: the heartbeat alarm and the backoff timer cannot handle a rejection
      await flush();
      assert.equal(FakeWebSocket.instances.length, 0);
      assert.equal(t.isReconnectPending(), true, 'the retry chain must survive');
      assert.match((await g.state.getState()).bridge.lastError, /connection attempt failed: storage exploded/);

      // The same inside the backoff timer's own connect().
      g.failNextGets(1);
      await advance(500);
      assert.equal(t.isReconnectPending(), true);
      await advance(1000);
      assert.equal(FakeWebSocket.instances.length, 1, 'and the next attempt connects');

      // connectNow() with unreadable storage still makes its attempt.
      resetWorld();
      g.reset();
      const t2 = await g.fresh();
      const warn = console.warn;
      console.warn = () => {};
      try {
        g.failNextGets(1);
        await t2.connectNow();
        await flush();
      } finally {
        console.warn = warn;
      }
      assert.equal(FakeWebSocket.instances.length, 1);
    } finally {
      console.error = quiet;
    }
  }],

  ['connectNow() racing a background connect() cannot leave the link refused', async (g) => {
    await g.state.setState({ bridge: { problem: 'refused earlier', lastError: 'refused earlier' } });
    const t = await g.fresh();
    health = 'refused';
    // The person presses Reconnect while the heartbeat alarm fires: the
    // alarm's attempt reads the stored refusal before connectNow() clears it.
    const now = t.connectNow();
    const bg = t.connect();
    await now;
    await bg;
    await flush();
    assert.equal(FakeWebSocket.instances.length, 0, 'nothing listening');
    assert.equal(t.isReconnectPending(), true, 'the forced attempt failed like any other and must be retried');
    health = DAEMON_HEALTH;
    await advance(500);
    assert.equal(FakeWebSocket.instances.length, 1);
  }],

  ['waiting requests fail the moment the socket closes', async (g) => {
    const t = await g.fresh();
    const ws = await connectWelcomed(t);
    const p = settledFlag(t.request('handoff', { tabId: 1 }));
    ws.serverClose(1006);
    await flush();
    assert.equal(p.settled, true, 'no waiting out the timeout');
    assert.match(p.error.message, /closed before it answered \(daemon not reachable\)/);
  }],

  ['pings every 20 seconds while connected', async (g) => {
    const t = await g.fresh();
    const ws = await connectWelcomed(t);
    assert.equal(ws.frames('ping').length, 0);
    await advance(19_999);
    assert.equal(ws.frames('ping').length, 0);
    await advance(1);
    assert.equal(ws.frames('ping').length, 1);
    assert.equal(typeof ws.frames('ping')[0].at, 'number');
    await advance(20_000);
    assert.equal(ws.frames('ping').length, 2);
  }],

  ['hurry() connects at once when a Stop could not be sent, and never lifts a refusal', async (g) => {
    // A daemon that was down for a while pushes the backoff to 40–60 s. A Stop pressed then was
    // written locally, the send returned false, and the daemon (still running agents on launched
    // engines) heard nothing until the next scheduled attempt — 48.6 s in the review's measurement.
    const t = await g.fresh();
    health = 'refused';
    await t.connect();
    await flush();
    assert.equal(t.isReconnectPending(), true, 'a backoff is queued');
    const sockets = FakeWebSocket.instances.length;
    health = DAEMON_HEALTH;
    assert.equal(t.send({ type: 'event', event: 'halt', data: { halted: true } }), false, 'nothing to send it on');
    assert.equal(t.hurry(), true);
    await flush();
    assert.equal(FakeWebSocket.instances.length, sockets + 1, 'it connected at once instead of waiting');
    const ws = lastSocket();
    ws.serverOpen();
    await flush();
    ws.serverSend({ ...WELCOME });
    await flush();
    assert.equal(t.isConnected(), true);
    // Connected, or already connecting: nothing to hurry, and no second socket.
    assert.equal(t.hurry(), true);
    await flush();
    assert.equal(FakeWebSocket.instances.length, sockets + 1);
    // A refusal (a superseded connection, a daemon that said no) is NOT lifted by a hurry.
    ws.serverSend({ type: 'welcome', version: '2.0.0', problem: 'another connection of this extension is live' });
    await flush();
    const after = FakeWebSocket.instances.length;
    assert.equal(t.hurry(), false, 'only the person\'s Reconnect lifts a refusal');
    await flush();
    assert.equal(FakeWebSocket.instances.length, after);
  }],

  ['a dropped link reconnects on a backoff that never stacks', async (g) => {
    const t = await g.fresh();
    const ws = await connectWelcomed(t);
    const before = FakeWebSocket.instances.length;

    // The socket dies without a close event yet: the ping notices first…
    ws.readyState = 3;
    await advance(20_000);
    assert.equal(t.isReconnectPending(), true);
    // …then the close event arrives too. Two sources, one reconnect.
    ws.dispatch('close', { code: 1006, reason: '' });
    await flush();
    assert.deepEqual(reconnecting(), [500]);
    const st = await g.state.getState();
    assert.equal(st.bridge.connected, false);
    assert.equal(st.bridge.lastError, 'daemon not reachable');

    await advance(500);
    assert.equal(FakeWebSocket.instances.length, before + 1, 'exactly one new socket');
    const ws2 = lastSocket();
    // The heartbeat alarm calling connect() while a socket is CONNECTING.
    await t.connect();
    await flush();
    assert.equal(FakeWebSocket.instances.length, before + 1, 'connect() while connecting opens nothing');

    ws2.serverClose(1006);
    await flush();
    await advance(1000);
    lastSocket().serverClose(1006);
    await flush();
    assert.deepEqual(reconnecting(), [500, 1000, 2000]);
    assert.equal(FakeWebSocket.instances.length, before + 2);
  }],

  ['connectNow() skips the backoff and resets it', async (g) => {
    const t = await g.fresh();
    health = 'refused';
    await t.connect();
    await flush();
    await advance(500);
    await advance(1000);
    assert.deepEqual(reconnecting(), [500, 1000, 2000]);
    assert.equal(FakeWebSocket.instances.length, 0, 'nothing listening: no socket attempts at all');

    health = DAEMON_HEALTH;
    await t.connectNow();
    await flush();
    assert.equal(FakeWebSocket.instances.length, 1, 'immediately, not after the 2s backoff');
    lastSocket().serverClose(1006);
    await flush();
    assert.equal(reconnecting().at(-1), 500, 'the backoff starts again from the bottom');
  }],

  ['a forced reconnect ignores the old socket\'s late close', async (g) => {
    const t = await g.fresh();
    const ws1 = await connectWelcomed(t);
    await t.connectNow();
    await flush();
    assert.equal(ws1.readyState, 2, 'the old socket was asked to close');
    const ws2 = lastSocket();
    assert.notEqual(ws2, ws1);
    ws2.serverOpen();
    await flush();
    ws2.serverSend(WELCOME);
    await flush();
    assert.equal(t.isConnected(), true);

    ws1.finishClose(); // the old socket's close event, arriving late
    await flush();
    assert.equal(t.isConnected(), true);
    assert.equal((await g.state.getState()).bridge.connected, true, 'a stale close must not flip the panel to offline');
    assert.equal(t.isReconnectPending(), false, 'and must not queue a stray reconnect');
  }],

  ['welcome.problem stops reconnecting until connectNow(), even across a worker restart', async (g) => {
    const t = await g.fresh();
    const problem = 'Another G9BrowserAgent build is connected as this browser. Reload the extension.';
    const ws = await connectWelcomed(t, { problem });
    assert.equal(ws.readyState, 2, 'the client closes a refused socket');
    assert.equal(t.isConnected(), false);
    let st = await g.state.getState();
    assert.equal(st.bridge.connected, false);
    assert.equal(st.bridge.lastError, problem);
    assert.equal(st.bridge.problem, problem);

    ws.finishClose();
    await flush();
    assert.equal(t.isReconnectPending(), false);
    assert.equal((await g.state.getState()).bridge.lastError, problem, 'the close does not overwrite the reason');

    const sockets = FakeWebSocket.instances.length;
    const fetches = fetchCalls.length;
    await advance(120_000);
    await t.connect(); // the heartbeat alarm
    await flush();
    const revived = await g.fresh(); // the worker was evicted and re-evaluated
    await revived.connect();
    await flush();
    assert.equal(FakeWebSocket.instances.length, sockets, 'no socket until a person asks');
    assert.equal(fetchCalls.length, fetches, 'not even a health check');

    await revived.connectNow();
    await flush();
    assert.equal(FakeWebSocket.instances.length, sockets + 1);
    st = await g.state.getState();
    assert.equal(st.bridge.problem ?? null, null, 'asking again lifts the refusal');
  }],

  ['a v1 bridge that reaches the welcome is refused, not retried', async (g) => {
    const t = await g.fresh();
    const ws = await connectWelcomed(t, { version: '1.7.21', id: undefined, serverPath: 'G:/x/bridge/src/server.js' });
    assert.equal(ws.readyState, 2);
    const st = await g.state.getState();
    assert.match(st.bridge.lastError, /G9BrowserAgent v1 bridge \(v1\.7\.21\)/);
    assert.equal(st.bridge.connected, false);
    ws.finishClose();
    await flush();
    assert.equal(t.isReconnectPending(), false, 'no tug of war with the v1 browser');
  }],

  ['close code 4001 is the daemon\'s refusal', async (g) => {
    const t = await g.fresh();
    await t.connect();
    await flush();
    const ws = lastSocket();
    ws.serverOpen();
    await flush();
    ws.serverClose(4001, 'Extension v1.7.21 cannot drive g9d v2.0.0. Reload the v2 extension.');
    await flush();
    const st = await g.state.getState();
    assert.match(st.bridge.lastError, /Reload the v2 extension/);
    assert.match(st.bridge.problem, /Reload the v2 extension/);
    assert.equal(t.isReconnectPending(), false);
  }],

  ['D-c: superseded by a newer connection of the same extension → no tug of war, nothing persisted, Reconnect takes it back', async (g) => {
    const t = await g.fresh();
    const ws = await connectWelcomed(t);
    const sockets = FakeWebSocket.instances.length;
    ws.serverClose(1000, 'superseded by a new connection from the same extension');
    await flush();
    const st = await g.state.getState();
    assert.equal(st.bridge.connected, false);
    assert.match(st.bridge.lastError, /Another connection of this same extension replaced this one/);
    assert.ok(!st.bridge.problem, 'not persisted: a dying worker must not block its replacement');
    assert.equal(t.isReconnectPending(), false, 'it does not take the identity straight back');
    await advance(120_000);
    assert.equal(FakeWebSocket.instances.length, sockets, 'and never retries by itself');
    await t.connectNow();
    await flush();
    assert.equal(FakeWebSocket.instances.length, sockets + 1, 'a person pressing Reconnect does');
  }],

  ['/health naming a v1 bridge means no socket — nobody is displaced — and it keeps checking', async (g) => {
    const t = await g.fresh();
    health = { ok: true, version: '1.7.21', pid: 5512, extensionConnected: true, project: 'shop' };
    await t.connect();
    await flush();
    assert.equal(FakeWebSocket.instances.length, 0, 'a v1 bridge displaces its client on ANY upgrade');
    const st = await g.state.getState();
    assert.match(st.bridge.lastError, /held by a G9BrowserAgent v1 bridge \(v1\.7\.21, pid 5512\)/);
    assert.match(st.bridge.lastError, /left alone/);
    assert.equal(t.isReconnectPending(), true);

    await advance(500);
    assert.equal(fetchCalls.length, 2);
    assert.equal(FakeWebSocket.instances.length, 0);

    health = DAEMON_HEALTH; // the editor holding the bridge was closed; the daemon took the port
    await advance(1000);
    assert.equal(FakeWebSocket.instances.length, 1);
  }],

  ['nothing listening: no socket attempt, a plain reason, a scheduled retry', async (g) => {
    const t = await g.fresh();
    health = 'refused';
    await t.connect();
    await flush();
    assert.equal(FakeWebSocket.instances.length, 0);
    const st = await g.state.getState();
    assert.equal(st.bridge.lastError, 'daemon not reachable on 127.0.0.1:8765');
    assert.equal(st.bridge.connected, false);
    assert.equal(t.isReconnectPending(), true);
  }],

  ['an unreadable /health does not block the socket; the welcome decides', async (g) => {
    for (const h of [404, 'timeout', { ok: true, hello: 'some other server' }]) {
      resetWorld();
      health = h;
      const t = await g.fresh();
      await t.connect();
      await flush();
      assert.equal(FakeWebSocket.instances.length, 1, `health ${JSON.stringify(h)}`);
    }
  }],

  ['a server that never welcomes is named, not trusted', async (g) => {
    const t = await g.fresh();
    await t.connect();
    await flush();
    const ws = lastSocket();
    ws.serverOpen();
    await flush();
    await advance(9_999);
    assert.equal(ws.readyState, 1);
    await advance(1);
    assert.equal(ws.readyState, 2, 'closed after 10s without a welcome');
    ws.finishClose();
    await flush();
    const st = await g.state.getState();
    assert.match(st.bridge.lastError, /never answered the handshake — it is not a G9BrowserAgent v2 daemon/);
    assert.equal(t.isReconnectPending(), true, 'an ordinary failure: the backoff goes on');
  }],

  ['the address comes from state; IPv6 is bracketed; a bad port falls back to 8765', async (g) => {
    await g.state.setState({ bridge: { host: '::1', port: 18123 } });
    const t = await g.fresh();
    await t.connect();
    await flush();
    assert.equal(fetchCalls.at(-1), 'http://[::1]:18123/health');
    assert.equal(lastSocket().url, 'ws://[::1]:18123/g9');

    resetWorld();
    g.reset();
    await g.state.setState({ bridge: { host: 'localhost', port: 'eighty' } });
    const t2 = await g.fresh();
    await t2.connect();
    await flush();
    assert.equal(lastSocket().url, 'ws://localhost:8765/g9');
  }],

  ['Stop survives a reconnect in either direction, and a welcome never clears one', async (g) => {
    // Pressed here while the socket was down: said again on the welcome.
    await g.state.setState({ halted: true });
    let t = await g.fresh();
    let seen = [];
    t.onMessage((m) => seen.push(m));
    let ws = await connectWelcomed(t, { halted: { global: false } });
    assert.deepEqual(ws.frames('event'), [{ type: 'event', event: 'halt', data: { halted: true, by: 'panel' } }]);
    assert.deepEqual(seen, []);
    assert.equal((await g.state.getState()).halted, true, 'the welcome did not resume anything');

    // Halted in the daemon (desktop Stop): the daemon's own {type:'halt'} that
    // follows the welcome is what mirrors it. The transport neither echoes it
    // back nor synthesises a second one to race it.
    resetWorld();
    g.reset();
    t = await g.fresh();
    seen = [];
    t.onMessage((m) => seen.push(m));
    ws = await connectWelcomed(t, { halted: { global: true, by: 'desktop' } });
    assert.deepEqual(seen, []);
    assert.equal(ws.frames('event').length, 0);
    ws.serverSend({ type: 'halt', halted: true });
    await flush();
    assert.deepEqual(seen.map((m) => [m.type, m.halted]), [['halt', true]], 'the daemon\'s halt reaches the worker');

    // Neither: nothing said.
    resetWorld();
    g.reset();
    t = await g.fresh();
    ws = await connectWelcomed(t);
    assert.equal(ws.frames('event').length, 0);
  }],

  ['disconnect() stops everything, including an attempt still checking /health', async (g) => {
    const t = await g.fresh();
    const ws = await connectWelcomed(t);
    await t.disconnect();
    assert.equal(ws.readyState, 2);
    ws.finishClose();
    await flush();
    const st = await g.state.getState();
    assert.equal(st.bridge.connected, false);
    assert.equal(st.bridge.lastError, null);
    assert.equal(t.isReconnectPending(), false);
    const sockets = FakeWebSocket.instances.length;
    await advance(120_000);
    assert.equal(FakeWebSocket.instances.length, sockets);

    // disconnect() while the preflight is in flight, then connect() again
    // BEFORE that check returns: the dead attempt must open nothing, and the
    // new connect() must not be handed the dead attempt as "already connecting".
    const releases = [];
    health = () => new Promise((r) => releases.push(() => r(DAEMON_HEALTH)));
    const first = t.connect();
    await flush();
    await t.disconnect();
    const second = t.connect();
    await flush();
    assert.equal(releases.length, 2, 'the second connect() made its own health check');
    for (const release of releases) release();
    await first;
    await second;
    await flush();
    assert.equal(FakeWebSocket.instances.length, sockets + 1, 'one socket, from the live attempt only');
  }],

  ['a lost daemon link forgets project sites and blocked-agent alerts, and tells the panel (v3 review 2, 3)', async (g) => {
    const t = await g.fresh();
    const ws = await connectWelcomed(t);
    // What the daemon's word made true while it was connected.
    await g.state.setState({
      projectDomains: ['admin.example.test'],
      projects: [{ name: 'shop', domains: ['admin.example.test'] }],
      blocked: { 12: { tabId: 12, agent: { id: 'agent-1', name: 'claude-code' }, reason: 'hidden', at: 1 } },
    });
    broadcasts.length = 0;
    ws.serverClose(1006);
    await flush();
    const st = await g.state.getState();
    assert.deepEqual(st.projectDomains, [], 'Project sites no longer attaches a departed project\'s hosts');
    assert.deepEqual(st.projects, []);
    assert.deepEqual(st.blocked, {}, 'an alert naming a per-process agent id does not outlive its daemon');
    assert.ok(broadcasts.some((m) => m?.type === 'agentUnblocked' && m.tabId === 12), 'the open panel is told to drop the alert');
    await t.disconnect();
  }],
];

const isolated = await isolatedGraph();
let graphs = [isolated];
try {
  graphs.push(await realGraph());
} catch (err) {
  console.log('  FAIL the real extension/lib/state.js does not import under the chrome stub');
  console.log(err?.stack ?? err);
  process.exit(1);
}

for (const g of graphs) {
  for (const [name, fn] of TRANSPORT_TESTS) {
    resetWorld();
    g.reset();
    await test(`transport [${g.label}]: ${name}`, () => fn(g));
  }
}

process.exit(0);
