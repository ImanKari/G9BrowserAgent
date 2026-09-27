#!/usr/bin/env node
/**
 * One-command real-browser validation of Engine 1 (the extension), v2.
 *
 * Everything this run touches is private to it and lives under ONE temp folder:
 *
 *   - a fresh G9_HOME and a REAL daemon (`daemon/g9d.mjs --foreground`) on a
 *     random port in 18000-18999 — not a bridge, not a stub;
 *   - a static server (127.0.0.1, random port) for setup/testpage.html and the
 *     fixtures the live checks need;
 *   - a COPY of extension/ carrying `dev-daemon.json` (this run's daemon) and a
 *     TRIPWIRE (below) in place of its built-in default port;
 *   - a headless Edge (temp --user-data-dir) with that copy loaded — or Chrome /
 *     Chrome for Testing (G9_BROWSER), which get it installed as unpacked.
 *
 * Then it runs setup/livetest.mjs — an MCP client speaking through a real
 * `mcp/shim.mjs` with G9_PORT set to the private port — renders the side
 * panel, and tears everything down: the daemon is shut down through its own
 * admin op (so the Engine 2 browsers it launched close with it), Edge is closed
 * over CDP, and any process whose command line still names this run's folder is
 * ended. The owner's browsers, profiles and daemon are never touched.
 *
 *   node setup/isolated-livetest.mjs
 *   G9_BROWSER=<path to msedge/chrome>   choose the browser (default: Edge, else Chrome)
 *   G9_LIVE_LOADER=flag|unpacked         how the copy is loaded (default: --load-extension on Edge,
 *                                        CDP Extensions.loadUnpacked elsewhere — see main())
 *   G9_PANEL_SCREENSHOT=<file.png>       keep the panel screenshot (default: checked, not kept)
 *   G9_LIVE_KEEP=1                       keep the temp folder for a post-mortem
 *   G9_LIVE_LOGS=1                       print the worker's console and the daemon log on a green run too
 *   G9_LIVE_SCRIPT=<file.mjs>            run that client instead of setup/livetest.mjs,
 *                                        with the same environment (a focused diagnostic
 *                                        gets the same private daemon, browser and pages)
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, access, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WsClient } from '../lib/ws-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXTENSION = path.join(ROOT, 'extension');
const VERSION = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
/** The owner's port. This harness never binds, connects to or probes it — see the tripwire. */
const OWNER_PORT = 8765;
const PORT_MIN = 18000;
const PORT_MAX = 18999;

const RUN = await mkdtemp(path.join(tmpdir(), 'g9-live-'));
const HOME = path.join(RUN, 'home');
const PROFILE = path.join(RUN, 'profile');
const EXT_COPY = path.join(RUN, 'ext');

const children = [];
const workerLog = [];
const daemonLog = [];
let harnessFailed = 0;

const ok = (n, d = '') => console.log(`  \x1b[32mPASS\x1b[0m ${n}${d ? ` \x1b[90m${d}\x1b[0m` : ''}`);
const bad = (n, d = '') => { harnessFailed++; console.log(`  \x1b[31mFAIL\x1b[0m ${n}${d ? ` \x1b[90m${d}\x1b[0m` : ''}`); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------- ports

/**
 * A free port in 18000-18999, proven free by binding it.
 *
 * Random rather than OS-assigned: other live suites run in parallel on this
 * machine and every one of them keeps to that range, and a fixed port (v1 used
 * 5199 for the page) collides the moment two runs overlap.
 */
async function freePort(taken = new Set()) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
    if (port === OWNER_PORT || taken.has(port)) continue;
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) {
      taken.add(port);
      return port;
    }
  }
  throw new Error(`No free port in ${PORT_MIN}-${PORT_MAX}.`);
}

// ------------------------------------------------------------ page server

/**
 * The fixtures, served over real http:// on 127.0.0.1.
 *
 * file:// has a null origin, no cookies and no fetch, which would make half the
 * scenarios impossible (v1's serve.mjs said so first). This server is in-process
 * so it binds 127.0.0.1 only and dies with the run; setup/serve.mjs stays the
 * tool for a person testing by hand.
 *
 * testpage.html embeds its cross-origin frame on the OTHER loopback name of the
 * same port (127.0.0.1 ↔ localhost): different ORIGINS to the browser, which is
 * what gives the frame its own process — the case lib/frames.js exists for.
 * An older copy hard-coded `localhost:5199`; that literal is rewritten to this
 * run's port on the way out, so either version of the page works here.
 */
function fixtures(port) {
  const animation = `
    <style>
      /* Something always repaints: a headless browser composites — and so
         produces screencast frames — only while the page changes. */
      .spin { width: 24px; height: 24px; border: 3px solid #4f46e5; border-top-color: transparent;
              border-radius: 50%; animation: s 0.8s linear infinite; display: inline-block; }
      @keyframes s { to { transform: rotate(360deg); } }
      body { font: 15px system-ui, sans-serif; margin: 24px; }
      button { font: inherit; padding: 14px 22px; margin: 8px 0; }
    </style>`;
  // A click counter that trusts nothing it did not see: every click records
  // whether the browser marked it trusted, and every mousemove is counted so a
  // humanized path (many moves) can be told from a direct one (one move).
  //
  // Round 3 added what the page can see of HOW input arrived, because each of
  // these was a live-found tell or loss (see livetest.mjs sections 8, 9, 25):
  // the pointerdown's pressure (0 from CDP until force was sent), how long the
  // button was held (a slow dispatcher once collapsed it to 2-8 ms), one
  // counter per input kind so a hidden tab's "nothing arrived" is measured for
  // hover/key/wheel/select/drag too, and scroll/resize events so a scroll that
  // is still moving after the tool returned — or a screenshot that resized the
  // viewport — is caught by the page itself. The page is tall (a spacer and a
  // far button) so there is something to scroll to.
  const clickPage = (title, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <title>${title}</title>${animation}</head><body>
    <h1>${title}</h1><span class="spin" aria-hidden="true"></span>
    <p><button id="target">Press me</button></p>
    <p><label>Note <input id="note" autocomplete="off"></label></p>
    <p><label>Pick <select id="pick"><option value="a">alpha</option><option value="b">beta</option></select></label></p>
    <h2 id="out">clicks 0</h2>
    ${extra}
    <div id="spacer" style="height: 2600px"></div>
    <p><button id="far">Far below</button></p>
    <script>
      window.clicks = { n: 0, trusted: 0, untrusted: 0, visibility: [], moves: 0,
        downs: 0, pressure: [], holds: [], keys: 0, overs: 0, wheels: 0, picks: 0,
        scrolls: 0, lastScrollAt: 0, resizes: [] };
      const c = window.clicks;
      let downAt = null;
      addEventListener('mousemove', (e) => { if (e.isTrusted) c.moves++; }, true);
      addEventListener('pointerdown', (e) => { if (e.isTrusted) { c.downs++; c.pressure.push(e.pressure); } }, true);
      addEventListener('mousedown', (e) => { if (e.isTrusted) downAt = e.timeStamp; }, true);
      addEventListener('mouseup', (e) => {
        if (e.isTrusted && downAt != null) { c.holds.push(Math.round((e.timeStamp - downAt) * 10) / 10); downAt = null; }
      }, true);
      addEventListener('keydown', (e) => { if (e.isTrusted) c.keys++; }, true);
      addEventListener('wheel', (e) => { if (e.isTrusted) c.wheels++; }, { capture: true, passive: true });
      addEventListener('scroll', () => { c.scrolls++; c.lastScrollAt = performance.now(); }, true);
      addEventListener('resize', () => { c.resizes.push(Math.round(performance.now()) + 'ms:' + innerWidth + 'x' + innerHeight); });
      document.getElementById('pick').addEventListener('change', (e) => { if (e.isTrusted) c.picks++; });
      document.getElementById('target').addEventListener('mouseover', (e) => { if (e.isTrusted) c.overs++; });
      document.getElementById('target').addEventListener('click', (e) => {
        c.n++; if (e.isTrusted) c.trusted++; else c.untrusted++;
        c.visibility.push(document.visibilityState);
        document.getElementById('out').textContent = 'clicks ' + c.n;
      });
    </script></body></html>`;

  // The witness under test (live round 2 found both): a page that cancels
  // pointerdown (the spec then suppresses mousedown/mouseup; click still
  // arrives), and a target that is covered the moment the pointer ARRIVES —
  // after G9BrowserAgent's obstruction check passed — so the press lands on the veil. The
  // first is a delivered click; the second must be an error naming the veil,
  // never "delivered", and never repeated.
  const witnessPage = `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <title>G9BrowserAgent witness fixture</title>${animation}
    <style>#veil { position: fixed; background: rgba(200, 30, 30, 0.35); z-index: 10; }</style></head><body>
    <h1>G9BrowserAgent witness fixture</h1><span class="spin" aria-hidden="true"></span>
    <p><button id="cancels">Cancels pointerdown</button></p>
    <p style="margin-top: 60px"><button id="trap">Covered on arrival</button></p>
    <p style="margin-top: 60px"><button id="away">Somewhere else</button></p>
    <script>
      window.w = { cancelDowns: 0, cancelMouseDowns: 0, cancelClicks: 0, trapDowns: 0, trapClicks: 0,
        veilDowns: 0, veilClicks: 0, armed: false };
      const cancels = document.getElementById('cancels');
      cancels.addEventListener('pointerdown', (e) => { if (e.isTrusted) w.cancelDowns++; e.preventDefault(); });
      cancels.addEventListener('mousedown', (e) => { if (e.isTrusted) w.cancelMouseDowns++; });
      cancels.addEventListener('click', (e) => { if (e.isTrusted) w.cancelClicks++; });
      const trap = document.getElementById('trap');
      trap.addEventListener('pointerdown', (e) => { if (e.isTrusted) w.trapDowns++; });
      trap.addEventListener('click', (e) => { if (e.isTrusted) w.trapClicks++; });
      trap.addEventListener('pointerenter', (e) => {
        if (!e.isTrusted || !w.armed || document.getElementById('veil')) return;
        const r = trap.getBoundingClientRect();
        const veil = document.createElement('div');
        veil.id = 'veil';
        Object.assign(veil.style, { left: (r.left - 40) + 'px', top: (r.top - 40) + 'px',
          width: (r.width + 80) + 'px', height: (r.height + 80) + 'px' });
        veil.addEventListener('pointerdown', (ev) => { if (ev.isTrusted) w.veilDowns++; });
        veil.addEventListener('click', (ev) => { if (ev.isTrusted) w.veilClicks++; });
        document.body.appendChild(veil);
      });
      // Armed only by the test, and only once the pointer is elsewhere: Chromium
      // re-runs hover after a layout change, so re-arming with the pointer
      // resting on the trap would veil it BEFORE G9BrowserAgent's check (a correct
      // "covered" refusal, but not the case under test).
      window.armTrap = () => {
        document.getElementById('veil')?.remove();
        Object.assign(w, { trapDowns: 0, trapClicks: 0, veilDowns: 0, veilClicks: 0, armed: true });
        return true;
      };
    </script></body></html>`;

  const longTitle =
    'G9BrowserAgent long title fixture — ' + 'every character of this title must survive the tab list, '.repeat(4) +
    'ünïcödé ✓ end';

  return {
    longTitle,
    routes: {
      '/clicks.html': () => clickPage('G9BrowserAgent click fixture'),
      '/background.html': () => clickPage('G9BrowserAgent background fixture'),
      '/popout.html': () => clickPage('G9BrowserAgent popout fixture'),
      '/auto.html': () => clickPage('G9BrowserAgent auto-attach fixture'),
      '/witness.html': () => witnessPage,
      '/long-title.html': () => `<!doctype html><html><head><meta charset="utf-8"><title>${longTitle}</title></head>
        <body><p>long title</p></body></html>`,
      // No globals of any kind, so "the main world holds nothing of G9BrowserAgent's" is
      // a statement about G9BrowserAgent and not about the fixture.
      '/clean.html': () => `<!doctype html><html lang="en"><head><meta charset="utf-8">
        <title>G9BrowserAgent clean fixture</title>${animation}</head><body>
        <h1>Greeting</h1>
        <p><label>Your name <input id="name" autocomplete="off"></label></p>
        <p><button id="go">Greet</button></p>
        <h2 id="result">nobody greeted</h2>
        <script>
          document.getElementById('go').addEventListener('click', () => {
            document.getElementById('result').textContent = 'Hello, ' + document.getElementById('name').value + '!';
          });
        </script></body></html>`,
    },
    testPageRewrite: (html) => html.replaceAll('localhost:5199', `localhost:${port}`),
  };
}

function startPageServer(port) {
  const fx = fixtures(port);
  const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    const html = (body, headers = {}) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
      res.end(body);
    };
    try {
      if (pathname === '/' || pathname === '/testpage.html') {
        const body = fx.testPageRewrite(await readFile(path.join(HERE, 'testpage.html'), 'utf8'));
        // An HttpOnly cookie the page's own JavaScript cannot see: the proof
        // that cookie reads (and a handoff) carry what document.cookie hides.
        return html(body, { 'set-cookie': 'g9_httponly=h1-secret; Path=/; HttpOnly; SameSite=Lax' });
      }
      if (fx.routes[pathname]) return html(fx.routes[pathname]());
      // The test page requests these on purpose; a 404 is the point.
      if (pathname.startsWith('/api/') || pathname.includes('missing')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Not found', path: pathname }));
      }
      if (pathname === '/crossframe.html') {
        return html(await readFile(path.join(HERE, 'crossframe.html'), 'utf8'));
      }
      pathname = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      const file = path.join(HERE, pathname);
      if (!file.startsWith(HERE) || !/\.(html|css|js|png)$/.test(file)) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, longTitle: fx.longTitle }));
  });
}

// ---------------------------------------------------------------- tripwire

/**
 * Where the extension copy would go if the dev override failed.
 *
 * A freshly loaded extension has no stored settings, so without an override it
 * dials its built-in default — 8765, which on this machine is the OWNER's live
 * session. v1's harness did exactly that during the v1.4.0 audit and displaced
 * the developer's own agent. v2 fixes it with `dev-daemon.json`, read by sw.js
 * before the first connect; but "the override worked" must be MEASURED, and a
 * failure must land somewhere harmless. So the copy's two built-in defaults
 * (lib/state.js DEFAULTS.bridge.port, lib/transport.js DEFAULT_PORT) are
 * rewritten to this listener, which answers nothing and counts every
 * connection. Zero hits at the end is the proof; one hit fails the run. The
 * owner's port is never reachable from the test browser at all.
 */
function startTripwire(port) {
  const hits = [];
  const server = net.createServer((socket) => {
    hits.push({ at: new Date().toISOString(), from: `${socket.remoteAddress}:${socket.remotePort}` });
    socket.destroy();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, hits }));
  });
}

async function patchExtensionCopy(dir, { daemonPort, tripwirePort }) {
  await writeFile(path.join(dir, 'dev-daemon.json'), JSON.stringify({ host: '127.0.0.1', port: daemonPort }));
  const patches = [
    ['lib/state.js', /(\bport:\s*)8765(,)/g],
    ['lib/transport.js', /(\bDEFAULT_PORT\s*=\s*)8765(;)/g],
  ];
  for (const [file, pattern] of patches) {
    const full = path.join(dir, file);
    const source = await readFile(full, 'utf8');
    let count = 0;
    const patched = source.replace(pattern, (_m, a, b) => {
      count++;
      return `${a}${tripwirePort}${b}`;
    });
    // A patch that silently matched nothing would remove the guard and leave
    // the copy dialling the owner's port. Refuse to run instead.
    if (count !== 1) throw new Error(`Tripwire patch of ${file} matched ${count} time(s), expected 1. Update the harness.`);
    await writeFile(full, patched);
  }
}

// ------------------------------------------------------------------ daemon

async function startDaemon(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'daemon', 'g9d.mjs'), '--port', String(port), '--home', HOME, '--foreground'], {
    cwd: RUN,
    env: { ...process.env, G9_PORT: String(port), G9_HOME: HOME },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    for (const line of d.split('\n')) if (line.trim()) daemonLog.push(line.trim());
    if (daemonLog.length > 400) daemonLog.splice(0, daemonLog.length - 400);
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`The daemon exited (${child.exitCode}) before listening:\n  ${daemonLog.slice(-10).join('\n  ')}`);
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).json();
      if (body?.name === 'g9d') return { child, health: body };
    } catch { /* still starting */ }
    await delay(150);
  }
  throw new Error(`The daemon did not answer /health on ${port} within 15 s.`);
}

/**
 * Shut the daemon down through its own admin op, so the Engine 2 browsers it
 * launched (a handoff starts one) are closed by the code that owns them.
 * Killing the process on Windows skips every exit handler and orphans them.
 */
async function shutdownDaemon(port, child) {
  if (!child || child.exitCode != null) return;
  try {
    const ws = await WsClient.connect(`ws://127.0.0.1:${port}/g9`, { timeoutMs: 3000 });
    ws.on('error', () => {});
    const welcomed = new Promise((resolve) => ws.on('message', (m) => { if (m.type === 'welcome') resolve(); }));
    ws.send({ type: 'hello', role: 'ui', version: VERSION, client: { name: 'isolated-livetest', pid: process.pid } });
    await Promise.race([welcomed, delay(3000)]);
    ws.send({ type: 'admin', id: 1, op: 'shutdown' });
    await Promise.race([new Promise((r) => child.once('exit', r)), delay(20_000)]);
  } catch { /* fall through to the kill */ }
  if (child.exitCode == null) child.kill();
}

// ------------------------------------------------------------------ browser

async function findBrowser() {
  const candidates = [
    process.env.G9_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error('Chrome/Edge was not found. Set G9_BROWSER to the executable path.');
}

/**
 * Buffer the extension service worker's own console output and exceptions.
 *
 * The harness drives the browser from outside, so when something goes wrong in
 * the extension all it sees is a tool call that never came back. The worker
 * usually knows exactly what happened; nothing was listening. Three debugging
 * runs were once spent guessing at a hang the worker was explaining the whole time.
 */
function watchWorkerConsole(session, sink) {
  session.on('Runtime.consoleAPICalled', (params) => {
    const text = (params.args ?? [])
      .map((a) => a.value ?? a.description ?? a.unserializableValue ?? a.type)
      .join(' ');
    sink.push('[' + params.type + '] ' + text);
  });
  session.on('Runtime.exceptionThrown', (params) => {
    const d = params.exceptionDetails ?? {};
    sink.push('[exception] ' + (d.exception?.description ?? d.text ?? 'unknown'));
  });
}

function dumpLogs() {
  console.log('\n\x1b[1mExtension service worker said:\x1b[0m');
  if (!workerLog.length) console.log('  \x1b[90m(nothing)\x1b[0m');
  for (const line of workerLog.slice(-60)) console.log('  \x1b[90m' + line + '\x1b[0m');
  console.log('\n\x1b[1mDaemon log (last lines):\x1b[0m');
  for (const line of daemonLog.slice(-40)) console.log('  \x1b[90m' + line + '\x1b[0m');
}

/**
 * Find the extension's service worker.
 *
 * Two things made this flaky, and both are MV3 facts rather than timing luck:
 *
 * 1. An idle worker is TORN DOWN and stops appearing in `Target.getTargets`
 *    entirely. Waiting longer does not help; something has to wake it. Opening
 *    any page from the extension's own origin does, which is why the extension
 *    id is resolved from a target of any type rather than from the worker.
 * 2. A candidate that failed the probe was added to `checked` and never tried
 *    again — but the usual reason to fail is being probed mid-startup, which is
 *    exactly the case that would have succeeded a moment later.
 *
 * `setDiscoverTargets` is requested first so targets that nobody is attached to
 * are still reported.
 */
async function waitExtensionWorker(cdp, timeoutMs, debugPort, knownId = null) {
  const deadline = Date.now() + timeoutMs;
  await cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
  const notOurs = new Set();
  let seen = [];
  let woke = false;

  while (Date.now() < deadline) {
    const result = await cdp.send('Target.getTargets');
    seen = result.targetInfos ?? [];

    for (const target of seen) {
      if (target.type !== 'service_worker') continue;
      if (!target.url.startsWith('chrome-extension://')) continue;
      if (notOurs.has(target.targetId)) continue;
      try {
        const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const session = cdp.session(attached.sessionId);
        await session.send('Runtime.enable');
        const name = await session.evaluate('chrome.runtime.getManifest().name');
        if (name === 'G9BrowserAgent') return { target, session };
        notOurs.add(target.targetId);
      } catch {
        // Mid-startup or mid-teardown. Deliberately NOT blacklisted.
      }
    }

    // No worker is running. Wake it by loading a page from its own origin.
    // Chrome lists its own component extensions too; the id we installed, when
    // known, is the only one worth waking (a panel.html of another is an error tab).
    if (!woke) {
      const anyExtension = knownId ? { url: 'chrome-extension://' + knownId + '/' } : seen.find((t) => t.url.startsWith('chrome-extension://'));
      if (anyExtension) {
        woke = true;
        const id = new URL(anyExtension.url).hostname;
        await openTarget(debugPort, 'chrome-extension://' + id + '/panel/panel.html').catch(() => {});
      }
    }

    await delay(200);
  }

  throw new Error(
    'Timed out waiting for the G9BrowserAgent service worker. Targets visible were:\n  ' +
      (seen.map((t) => `${t.type} ${t.url}`).join('\n  ') || '(none)') +
      '\n  (A browser that ignores --load-extension shows no chrome-extension:// target at all.)',
  );
}

/**
 * Prove the isolated extension is on THIS run's daemon before anything runs.
 *
 * Without this the failure is silent and expensive: the harness drives a
 * browser that is talking to a different daemon, every check behaves oddly,
 * and a real session is being answered by a throwaway profile the whole time.
 * Two independent witnesses: the extension's own stored address, and the
 * daemon saying an extension is connected to it.
 */
async function assertPrivateDaemon(workerCdp, daemonPort) {
  const deadline = Date.now() + 20_000;
  let stored = null;
  let health = null;
  while (Date.now() < deadline) {
    stored = await workerCdp.evaluate(
      `(async () => {
         const session = (await chrome.storage.session.get('state')).state || {};
         const local = (await chrome.storage.local.get('settings')).settings || {};
         return { session: session.bridge || null, local: local.bridge || null };
       })()`,
    ).catch(() => null);
    health = await fetch(`http://127.0.0.1:${daemonPort}/health`).then((r) => r.json()).catch(() => null);
    const port = stored?.local?.port ?? stored?.session?.port ?? null;
    if (port === daemonPort && health?.extension === true) return { stored, health };
    await delay(250);
  }
  throw new Error(
    'The isolated extension did not connect to this run\'s daemon (port ' + daemonPort + '): stored address ' +
      JSON.stringify(stored) + ', daemon /health ' + JSON.stringify(health) + '. dev-daemon.json was not ' +
      'applied, or the daemon refused it. Aborting before anything is driven.',
  );
}

async function openTarget(port, url) {
  const response = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  if (!response.ok) throw new Error('Could not open target: HTTP ' + response.status);
  return response.json();
}

async function waitJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await delay(150);
  }
  throw new Error('Timed out waiting for ' + url + '.');
}

class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.listeners = [];
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id == null) {
        for (const l of this.listeners) {
          if (l.sessionId === (message.sessionId ?? null) && l.method === message.method) {
            try { l.handler(message.params ?? {}); } catch { /* a bad listener is not fatal */ }
          }
        }
        return;
      }
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
  async send(method, params = {}, sessionId = null) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Runtime evaluation failed');
    return result.result?.value;
  }
  close() { try { this.socket.close(); } catch {} }
  session(sessionId) {
    return {
      send: (method, params = {}) => this.send(method, params, sessionId),
      on: (method, handler) => { this.listeners.push({ sessionId, method, handler }); },
      evaluate: async (expression) => {
        const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Runtime evaluation failed');
        return result.result?.value;
      },
    };
  }
}

// ----------------------------------------------------------------- cleanup

/** Processes whose command line names this run's folder — and only those. */
function processesOfRun() {
  if (process.platform !== 'win32') return [];
  const script =
    `$r = '${RUN.replace(/'/g, "''").toLowerCase()}'; ` +
    'Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($r) } | ' +
    'ForEach-Object { "$($_.ProcessId)|$($_.Name)" }';
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    return out.split(/\r?\n/).filter(Boolean).map((l) => { const [pid, name] = l.split('|'); return { pid: Number(pid), name }; })
      .filter((p) => p.pid && p.pid !== process.pid);
  } catch {
    return [];
  }
}

/** The pid listening on one of THIS run's ports (never any other port). */
function listenerOn(port) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`],
    { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    const pid = Number(out.trim());
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- main

async function main() {
  const browser = await findBrowser();
  const taken = new Set();
  const daemonPort = await freePort(taken);
  const pagePort = await freePort(taken);
  const tripwirePort = await freePort(taken);
  const debugPort = await freePort(taken);
  const PAGE = `http://127.0.0.1:${pagePort}/`;

  console.log('\n\x1b[1mG9 isolated live test (Engine 1, v' + VERSION + ')\x1b[0m');
  console.log('browser:   ' + browser);
  console.log('run dir:   ' + RUN);
  console.log(`ports:     daemon ${daemonPort} · pages ${pagePort} · tripwire ${tripwirePort} · CDP ${debugPort}`);

  let browserControl = null;
  let browserChild = null;
  let loaderPipe = null;
  let loadedId = null;
  let daemon = null;
  let pages = null;
  let tripwire = null;
  let exitCode = 1;

  try {
    pages = await startPageServer(pagePort);
    tripwire = await startTripwire(tripwirePort);

    // The daemon BEFORE the browser: the extension connects on its first line,
    // and it must find this run's daemon there, not a refused port.
    daemon = await startDaemon(daemonPort);
    console.log(`daemon:    g9d v${daemon.health.version} pid ${daemon.health.pid}, home ${daemon.health.home}`);
    if (daemon.health.version !== VERSION) bad('daemon version', `${daemon.health.version} != ${VERSION}`);

    // Load a COPY of the extension with this run's daemon baked in. The address
    // has to be there before the worker's first line: it connects at startup,
    // and configuring afterwards is always too late (see the tripwire above).
    await cp(EXTENSION, EXT_COPY, { recursive: true });
    await patchExtensionCopy(EXT_COPY, { daemonPort, tripwirePort });

    // How the extension copy gets into the browser (G9_LIVE_LOADER=flag|unpacked).
    //
    // Edge: --load-extension, as always. Chrome cannot use it, measured in live
    // round 3 on 153: branded Chrome ignores the switch (no extension target at
    // all), and Chrome for Testing loads it but DROPS it for good on
    // chrome.runtime.reload() (worker and pages gone after 21 s; the welcome-on-
    // update checks and the daemon's own reload path need that call). Installed
    // as UNPACKED instead — CDP Extensions.loadUnpacked over the pipe, what
    // "Load unpacked" does and how a person installs G9BrowserAgent — the same reload comes
    // back in ~1 s on both — once Developer mode is on, as it is for anyone who
    // loaded an extension unpacked. Off (a fresh profile), Chrome disables it at
    // that reload with DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION (chrome://
    // extensions-internals). Edge reloads a --load-extension copy in ~1 s.
    const loader = process.env.G9_LIVE_LOADER ?? (/msedge\.exe$/i.test(browser) ? 'flag' : 'unpacked');
    browserChild = spawn(browser, [
      '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + debugPort,
      ...(loader === 'unpacked'
        ? ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging']
        : ['--load-extension=' + EXT_COPY, '--disable-extensions-except=' + EXT_COPY]),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-update',
      '--disable-background-mode',
      '--disable-sync',
      // Live round 2: a fresh Edge profile signs itself in to the Windows account unless this is
      // off from its first start (engine/launch.js DISABLED_FEATURES says what was measured).
      '--disable-features=msImplicitSignin',
      '--headless=new',
      '--window-size=1280,900',
      // Chrome over the pipe left a start-up URL pending for good (chrome.tabs: url "", pendingUrl
      // the page, status "complete"; the page about:blank) in 4 of 7 runs, so that tab is sent to
      // the page after the extension is in.
      loader === 'unpacked' ? 'about:blank' : PAGE,
    ], { stdio: loader === 'unpacked' ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : 'ignore', windowsHide: true });
    children.push(browserChild);
    if (loader === 'unpacked') {
      const { PipeCdp } = await import('../engine/pipe-cdp.js');
      // Held open for the whole run: the browser treats the pipe closing as the end of its session.
      loaderPipe = new PipeCdp(browserChild.stdio[3], browserChild.stdio[4], { name: 'test browser (pipe)', child: browserChild });
      // Developer mode first, the way a person does it: the toggle on chrome://extensions.
      const page = await loaderPipe.send('Target.createTarget', { url: 'chrome://extensions' });
      const { sessionId: extPage } = await loaderPipe.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      let devMode = null;
      for (let attempt = 0; attempt < 20 && devMode !== true; attempt++) {
        await delay(250);
        devMode = (await loaderPipe.send('Runtime.evaluate', {
          expression: 'new Promise((done) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, ' +
            '() => chrome.developerPrivate.getProfileConfiguration((c) => done(c.inDeveloperMode))))',
          awaitPromise: true, returnByValue: true,
        }, extPage).catch(() => null))?.result?.value ?? null;
      }
      await loaderPipe.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
      if (devMode !== true) throw new Error('Could not switch Developer mode on in the test profile (chrome://extensions).');
      const installed = await loaderPipe.send('Extensions.loadUnpacked', { path: EXT_COPY });
      console.log(`loader:    Developer mode on, unpacked through CDP (Extensions.loadUnpacked) → ${installed?.id}`);
      loadedId = installed?.id ?? null;
      const first = ((await loaderPipe.send('Target.getTargets')).targetInfos ?? []).find((t) => t.type === 'page' && t.url === 'about:blank');
      if (!first) throw new Error('The start-up tab (about:blank) was not found.');
      const { sessionId: firstTab } = await loaderPipe.send('Target.attachToTarget', { targetId: first.targetId, flatten: true });
      await loaderPipe.send('Page.navigate', { url: PAGE }, firstTab);
      await loaderPipe.send('Target.detachFromTarget', { sessionId: firstTab }).catch(() => {});
    }

    const version = await waitJson('http://127.0.0.1:' + debugPort + '/json/version', 15_000);
    console.log('engine 1:  ' + version.Browser + ' (headless)\n');
    browserControl = new Cdp(version.webSocketDebuggerUrl);
    await browserControl.ready;
    const foundWorker = await waitExtensionWorker(browserControl, 45_000, debugPort, loadedId);
    const extensionId = new URL(foundWorker.target.url).hostname;
    watchWorkerConsole(foundWorker.session, workerLog);
    const proof = await assertPrivateDaemon(foundWorker.session, daemonPort);
    ok('extension copy connected to this run\'s private daemon', `id ${extensionId}, port ${proof.stored.local?.port ?? proof.stored.session?.port}`);

    // The live checks. An MCP client through a real shim, on the private port.
    const script = process.env.G9_LIVE_SCRIPT ? path.resolve(process.env.G9_LIVE_SCRIPT) : path.join(HERE, 'livetest.mjs');
    if (process.env.G9_LIVE_SCRIPT) console.log('client:    ' + script + ' (G9_LIVE_SCRIPT)');
    const live = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: {
        ...process.env,
        G9_PORT: String(daemonPort),
        G9_HOME: HOME,
        G9_LIVE_CDP_PORT: String(debugPort),
        G9_LIVE_EXTENSION_ID: extensionId,
        G9_LIVE_EXTENSION_DIR: EXT_COPY,
        G9_LIVE_PAGE: PAGE,
        G9_LIVE_LONG_TITLE: pages.longTitle,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(live);
    live.stdout.pipe(process.stdout);
    live.stderr.pipe(process.stderr);
    exitCode = await new Promise((resolve) => live.once('exit', (code) => resolve(code ?? 1)));

    // ---------------------------------------------------- panel render
    console.log('\n\x1b[1mHarness: side panel render\x1b[0m');
    const panelTarget = await openTarget(debugPort, 'chrome-extension://' + extensionId + '/panel/panel.html');
    const panelCdp = new Cdp(panelTarget.webSocketDebuggerUrl);
    await panelCdp.ready;
    await panelCdp.send('Runtime.enable');
    await panelCdp.send('Page.enable');
    await panelCdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
    await panelCdp.send('Page.reload');
    await delay(1500);
    // Check STRUCTURE, not copy.
    //
    // v1 once required the literal words "Attached tab" in the panel's text;
    // a refactor changed the label and the harness failed a panel that was
    // rendering perfectly — the third assertion in this repository to break
    // because it was pinned to wording rather than to what the wording is
    // evidence OF. Ids are what a refactor is supposed to keep. The title is
    // the exception on purpose: the version in it is a product requirement.
    const identity = await panelCdp.evaluate(`({
      title: document.title,
      tabs: document.querySelectorAll('button[data-tab]').length,
      sessionBody: !!document.querySelector('[data-body="session"]'),
      // v3 (U1–U3): Record from now replaces the Attach button; auto-attach has three
      // settings; the blocked-agent toast has its place above the tab bar.
      recordControl: !!document.getElementById('recordNow') && !document.getElementById('attachActive'),
      autoModes: [...document.querySelectorAll('input[name="autoAttach"]')].map((r) => r.value).join(','),
      autoChecked: document.querySelector('input[name="autoAttach"]:checked')?.value ?? null,
      blockedToast: !!document.getElementById('blockedAlerts'),
      modeButtons: document.querySelectorAll('[data-mode]').length,
      error: document.getElementById('panelError')?.hidden === false ? document.getElementById('panelError').textContent : '',
      overflow: document.documentElement.scrollWidth > innerWidth,
    })`);
    const expectedTitle = 'G9BrowserAgent v' + VERSION;
    identity.title === expectedTitle && identity.tabs >= 4 && identity.sessionBody && identity.recordControl && identity.blockedToast
      ? ok('panel rendered its session UI', `title "${identity.title}", ${identity.tabs} section tabs`)
      : bad('panel did not render its session UI', JSON.stringify(identity));
    // livetest.mjs section 18 leaves auto-attach on its default, Project sites.
    identity.autoModes === 'off,project,all' && identity.autoChecked === 'project'
      ? ok('auto-attach offers Off / Project sites / All tabs', `selected "${identity.autoChecked}"`)
      : bad('auto-attach control', JSON.stringify({ modes: identity.autoModes, checked: identity.autoChecked }));
    identity.modeButtons === 0 ? ok('no v1 mode buttons in the panel') : bad('v1 mode buttons still rendered', String(identity.modeButtons));
    identity.error ? bad('panel shows an error', identity.error) : ok('panel shows no error');
    identity.overflow ? bad('panel overflows horizontally at 420px') : ok('no horizontal overflow at 420px');
    await panelCdp.evaluate('document.querySelector(\'button[data-tab="automation"]\').click()');
    await delay(300);
    const automationVisible = await panelCdp.evaluate(
      '!document.querySelector(\'[data-body="automation"]\').hidden && document.getElementById("recToggle").offsetWidth > 0',
    );
    automationVisible ? ok('Automation tab responds') : bad('Automation tab did not respond');
    const image = await panelCdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const bytes = Buffer.from(image.data ?? '', 'base64');
    bytes.length > 2000 ? ok('panel screenshot', `${Math.round(bytes.length / 1024)} KB`) : bad('panel screenshot empty');
    if (process.env.G9_PANEL_SCREENSHOT) {
      await writeFile(process.env.G9_PANEL_SCREENSHOT, bytes);
      console.log('  \x1b[90mPanel screenshot: ' + process.env.G9_PANEL_SCREENSHOT + '\x1b[0m');
    }
    panelCdp.close();

  } catch (err) {
    bad('harness', String(err?.stack ?? err).slice(0, 600));
  } finally {
    // The tripwire's verdict in every outcome — an aborted run included, since
    // "the override did not take" is exactly what aborts one.
    if (tripwire) {
      tripwire.hits.length === 0
        ? ok('tripwire: the extension never dialled its built-in default port', 'dev-daemon.json held for the whole run, reloads included')
        : bad('tripwire: the extension dialled its built-in default port', `${tripwire.hits.length} connection(s), first ${JSON.stringify(tripwire.hits[0])}`);
    }
    // Errors the worker logged are shown even on a green run: a caught error
    // that changed nothing visible today is tomorrow's unexplained hang.
    const workerErrors = workerLog.filter((l) => /^\[(error|exception)\]/.test(l));
    if (workerErrors.length) console.log(`\n\x1b[33mThe extension worker logged ${workerErrors.length} error(s)\x1b[0m (first: ${workerErrors[0].slice(0, 200)})`);
    if (exitCode !== 0 || harnessFailed || process.env.G9_LIVE_LOGS) dumpLogs();
    // The daemon first: its shutdown closes the Engine 2 browsers it launched.
    await shutdownDaemon(daemonPort, daemon?.child).catch(() => {});
    if (browserControl) {
      await Promise.race([browserControl.send('Browser.close').catch(() => {}), delay(5000)]);
      browserControl.close();
    }
    if (browserChild && browserChild.exitCode == null) {
      await Promise.race([new Promise((r) => browserChild.once('exit', r)), delay(8000)]);
    }
    try { loaderPipe?.close?.(); } catch { /* already closed with the browser */ }
    // Live round 2: a fresh Edge profile signed itself in to the Windows
    // account and synced it (history, tabs, extensions) unless implicit
    // sign-in was off from its first start. This browser was started with it
    // off; the profile's own files say whether that held. Booleans only.
    if (browserChild) {
      try {
        const { signInState } = await import('../engine/profile.js');
        const sin = await signInState(null, { dir: PROFILE });
        if (!sin.checked.length) console.log('  \x1b[33mSKIP\x1b[0m test profile sign-in state \x1b[90mthe profile wrote no Local State/Preferences\x1b[0m');
        else if (sin.signedIn === false) ok('the test browser profile never signed in to an account', `read ${sin.checked.join(' + ')}`);
        else bad('the test browser profile is signed in to an account', `account_info entries ${sin.accountInfo}`);
      } catch (err) {
        bad('test profile sign-in state could not be read', String(err?.message ?? err).slice(0, 200));
      }
    }
    for (const child of children.reverse()) {
      if (child.exitCode == null) child.kill();
    }
    pages?.server.close();
    tripwire?.server.close();
    // A daemon a shim started by itself (it would if ours had died) has no
    // run folder on its command line; it is found by this run's port instead.
    const stray = listenerOn(daemonPort);
    if (stray && stray !== process.pid) {
      try { process.kill(stray); } catch {}
    }
    let leftovers = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      await delay(800);
      leftovers = processesOfRun();
      if (!leftovers.length) break;
      for (const p of leftovers) {
        try { process.kill(p.pid); } catch {}
      }
    }
    if (leftovers.length) bad('cleanup', 'processes still running: ' + leftovers.map((p) => `${p.name}#${p.pid}`).join(', '));
    if (!process.env.G9_LIVE_KEEP) {
      let removed = false;
      for (let attempt = 0; attempt < 6 && !removed; attempt++) {
        try {
          await rm(RUN, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
          removed = !existsSync(RUN);
        } catch { /* a browser lock still held */ }
        if (!removed) await delay(700 + attempt * 500);
      }
      if (!removed) bad('cleanup', 'could not remove ' + RUN);
    } else {
      console.log('\x1b[90mKept: ' + RUN + '\x1b[0m');
    }
  }
  const final = exitCode === 0 && harnessFailed === 0 ? 0 : 1;
  console.log(final === 0 ? '\n\x1b[32mIsolated live test: PASS\x1b[0m\n' : `\n\x1b[31mIsolated live test: FAIL\x1b[0m (livetest exit ${exitCode}, harness failures ${harnessFailed})\n`);
  process.exitCode = final;
}

await main();
