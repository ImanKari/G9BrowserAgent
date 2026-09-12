#!/usr/bin/env node
/**
 * One-command real-browser validation in an isolated Chrome profile.
 *
 * It loads the unpacked extension, serves the seeded page, configures a private
 * bridge port, pins the page, runs livetest.mjs, then renders and screenshots
 * the panel. The normal browser profile and installed G9 extension are untouched.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, access, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXTENSION = path.join(ROOT, 'extension');
const TEST_URL = 'http://127.0.0.1:5199/';
const profile = await mkdtemp(path.join(tmpdir(), 'g9-isolated-'));
const extensionCopy = await mkdtemp(path.join(tmpdir(), 'g9-ext-'));
const bridgePort = await freePort();
const debugPort = await freePort();
const screenshotPath = process.env.G9_PANEL_SCREENSHOT ??
  path.join(tmpdir(), 'g9-panel-' + Date.now() + '.png');
const children = [];
const workerLog = [];

/**
 * Buffer the extension service worker's own console output and exceptions.
 *
 * The harness drives the browser from outside, so when something goes wrong in
 * the extension all it sees is a tool call that never came back. The worker
 * usually knows exactly what happened; nothing was listening.
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

function dumpWorkerLog() {
  if (!workerLog.length) {
    console.log('\n\x1b[90m(the extension service worker logged nothing)\x1b[0m');
    return;
  }
  console.log('\n\x1b[1mExtension service worker said:\x1b[0m');
  for (const line of workerLog.slice(-60)) console.log('  \x1b[90m' + line + '\x1b[0m');
}

/**
 * Keep this run away from a real session on the default port.
 *
 * A freshly loaded extension has no stored settings, so `bootstrap()` connects
 * to the DEFAULT 8765 before this harness can seed anything — and the bridge's
 * single-client rule lets the newest connection win. The isolated browser
 * therefore displaces whatever agent session is running, silently, for as long
 * as it takes to reconfigure and reload. During the audit that produced v1.4.0
 * that is exactly what happened: a tool call meant for the developer's own tab
 * was answered by the throwaway test profile.
 *
 * That window cannot be closed from the harness — nothing can seed storage
 * before the worker's first line runs. So the address is baked into a COPY of
 * the extension instead (`dev-bridge.json`, read by `sw.js` before connect),
 * and this run never uses the default port at all.
 *
 * The note below stays because the override is the only thing standing between
 * a test run and someone's live session; `assertPrivateBridge()` verifies it
 * actually took effect rather than assuming.
 */
async function warnAboutLiveSession() {
  try {
    const probe = await fetch('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(1500) });
    if (!probe.ok || (await probe.json())?.ok !== true) return;
  } catch {
    return; // nothing there
  }
  console.warn('\n\x1b[33mNote: a G9 bridge is already running on the default port 8765.\x1b[0m');
  console.warn('This run bakes its own port into a copy of the extension, so it will not touch');
  console.warn('that session. If the override fails, the run aborts rather than taking it over.\n');
}

/**
 * Prove the isolated extension is on THIS run's port before doing anything.
 *
 * Without this the failure is silent and expensive: the harness drives a
 * browser that is talking to a different bridge, every check behaves oddly, and
 * the real session is being answered by a throwaway profile the whole time.
 */
async function assertPrivateBridge(workerCdp, expectedPort) {
  // bootstrap() applies the override asynchronously, and the worker target can
  // appear before that write lands. Poll rather than race it.
  const deadline = Date.now() + 8000;
  let actual = null;
  while (Date.now() < deadline) {
    actual = await workerCdp.evaluate(
      `(async () => {
         const session = (await chrome.storage.session.get('state')).state || {};
         const local = (await chrome.storage.local.get('settings')).settings || {};
         return (session.bridge && session.bridge.port) || (local.bridge && local.bridge.port) || null;
       })()`,
    ).catch(() => null);
    if (actual === expectedPort) return;
    await delay(200);
  }
  if (actual !== expectedPort) {
    throw new Error(
      'The isolated extension is configured for bridge port ' + actual + ', not this run\'s ' +
        expectedPort + '. dev-bridge.json was not applied, so the run would drive the wrong ' +
        'browser and could take over a live session. Aborting.',
    );
  }
}

async function main() {
await warnAboutLiveSession();
const browser = await findBrowser();
console.log('\nG9 isolated live test');
console.log('browser: ' + browser);
console.log('profile: ' + profile);
console.log('bridge port: ' + bridgePort + ' · debug port: ' + debugPort + '\n');
let browserControl = null;

try {
  const server = spawn(process.execPath, [path.join(HERE, 'serve.mjs')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(server);
  await waitHttp(TEST_URL, 10_000);

  // Load a COPY of the extension with this run's bridge address baked in.
  //
  // The address has to be present before the service worker's first line: it
  // connects on startup, and a default-port connection would take over whatever
  // real session is on 8765. Configuring afterwards is always too late.
  await cp(EXTENSION, extensionCopy, { recursive: true });
  await writeFile(
    path.join(extensionCopy, 'dev-bridge.json'),
    JSON.stringify({ host: '127.0.0.1', port: bridgePort, token: '' }),
  );

  const chrome = spawn(browser, [
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + debugPort,
    '--load-extension=' + extensionCopy,
    '--disable-extensions-except=' + extensionCopy,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-component-update',
    '--disable-background-mode',
    '--headless=new',
    TEST_URL,
  ], { stdio: 'ignore', windowsHide: true });
  children.push(chrome);

  const version = await waitJson('http://127.0.0.1:' + debugPort + '/json/version', 10_000);
  browserControl = new Cdp(version.webSocketDebuggerUrl);
  await browserControl.ready;
  const foundWorker = await waitExtensionWorker(browserControl, 45_000, debugPort);
  const worker = foundWorker.target;
  const extensionId = new URL(worker.url).hostname;
  const workerCdp = foundWorker.session;
  await assertPrivateBridge(workerCdp, bridgePort);

  // Watch what the extension itself says.
  //
  // Without this a failure shows only what the MCP client saw — usually a bare
  // 60s timeout — while the reason sits in a service-worker console nobody is
  // reading. Three debugging runs were spent guessing at a hang that the worker
  // was explaining the whole time.
  watchWorkerConsole(workerCdp, workerLog);

  // Start the private bridge BEFORE the extension is pointed at it.
  //
  // The old order started it after seeding, which left a window in which the
  // fresh extension had already fallen back to the default 8765 and connected
  // to whatever bridge was there — in practice, the developer's own live
  // session, which it then displaced, silently, because the bridge's
  // single-client rule lets the newest connection win. Running the test suite
  // broke the work it was supposed to protect.
  const live = spawn(process.execPath, [path.join(HERE, 'livetest.mjs')], {
    cwd: ROOT,
    env: { ...process.env, G9_PORT: String(bridgePort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(live);
  live.stdout.pipe(process.stdout);
  live.stderr.pipe(process.stderr);
  await waitHttp('http://127.0.0.1:' + bridgePort + '/health', 15_000);

  // Seed BOTH stores, not just local.
  //
  // getState() layers session over local, so a session record written by the
  // extension's own first connection attempt outranks anything seeded here.
  // Writing local alone left the seeded port permanently shadowed.
  const seed = {
    mode: 'pinned',
    bridge: { host: '127.0.0.1', port: bridgePort, token: '', serverPath: null, repoRoot: null },
  };
  await workerCdp.evaluate(
    `(async () => {
       await chrome.storage.local.set({ settings: ${JSON.stringify(seed)} });
       const current = (await chrome.storage.session.get('state')).state || {};
       await chrome.storage.session.set({ state: { ...current, mode: 'pinned',
         bridge: { ...(current.bridge || {}), host: '127.0.0.1', port: ${bridgePort}, token: '' } } });
       return true;
     })()`,
  );

  // Reload so bootstrap reads the seeded port and connects immediately.
  await workerCdp.evaluate('chrome.runtime.reload(); true').catch(() => {});
  const reloadedWorker = await waitBrowserTarget(browserControl, (target) =>
    target.type === 'service_worker' && target.targetId !== worker.targetId &&
    target.url.startsWith('chrome-extension://' + extensionId + '/'), 10_000);
  const reattached = await browserControl.send('Target.attachToTarget', { targetId: reloadedWorker.targetId, flatten: true });
  const activeWorker = browserControl.session(reattached.sessionId);
  await activeWorker.send('Runtime.enable');
  // The reload above replaced the worker, and with it the session id — a watch
  // on the old one hears nothing. This is the session that runs the whole test.
  watchWorkerConsole(activeWorker, workerLog);
  const pinned = await activeWorker.evaluate(
    `(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((item) => item.url && item.url.startsWith('http://127.0.0.1:5199/'));
      if (!tab) throw new Error('Seeded test tab was not found');
      const current = (await chrome.storage.session.get('state')).state || {};
      await chrome.storage.session.set({ state: {
        ...current,
        mode: 'pinned',
        pinnedTabId: tab.id,
        attachedTabs: [],
        halted: false,
      } });
      return { tabId: tab.id };
    })()`,
  );
  if (!pinned?.tabId) throw new Error('Could not pin the isolated test tab.');

  // Put the test page back in front before driving it.
  //
  // Waking the service worker opens a page from the extension's own origin,
  // which pushes the test tab into the background — and a background tab is
  // exactly the state where a browser stops delivering input (§4.3a). The
  // harness would then be testing its own side effect: every interaction check
  // failing with a correct explanation about a hidden tab. A real user has the
  // tab they are working on in front of them, so the harness should too.
  await browserControl.send('Target.activateTarget', { targetId: (await browserControl.send('Target.getTargets'))
    .targetInfos.find((t) => t.type === 'page' && t.url.startsWith(TEST_URL))?.targetId }).catch(() => {});
  await delay(400);
  const visibility = await activeWorker.evaluate(
    `(async () => {
       const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:5199/*' });
       if (tab) await chrome.tabs.update(tab.id, { active: true });
       return tab ? tab.id : null;
     })()`,
  ).catch(() => null);
  if (visibility == null) console.warn('Could not re-activate the test tab; interaction checks may fail as hidden.');
  await delay(500);

  const exitCode = await new Promise((resolve) => live.once('exit', (code) => resolve(code ?? 1)));

  const panelTarget = await openTarget(
    debugPort,
    'chrome-extension://' + extensionId + '/panel/panel.html',
  );
  const panelCdp = new Cdp(panelTarget.webSocketDebuggerUrl);
  await panelCdp.ready;
  await panelCdp.send('Runtime.enable');
  await panelCdp.send('Page.enable');
  await panelCdp.send('Emulation.setDeviceMetricsOverride', {
    width: 420, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await panelCdp.send('Page.reload');
  await delay(1000);
  // Check STRUCTURE, not copy.
  //
  // This used to require the literal words "Attached tab" in the panel's text.
  // Splitting panel.js into session/automation/issues changed that label to
  // "Re-attach current tab", and the harness failed a panel that was rendering
  // perfectly — the third assertion in this repository to break because it was
  // pinned to wording rather than to what the wording is evidence OF.
  //
  // What actually matters here is that the panel booted its session UI: the tab
  // strip is there, the session body exists, and the attach control rendered.
  // Those are ids, and ids are what a refactor is supposed to keep.
  const identity = await panelCdp.evaluate(
    `({
      title: document.title,
      tabs: document.querySelectorAll('button[data-tab]').length,
      sessionBody: !!document.querySelector('[data-body="session"]'),
      attachControl: !!document.getElementById('attachActive'),
      modeButtons: document.querySelectorAll('[data-mode]').length,
      error: document.getElementById('panelError')?.textContent || '',
      text: document.body.innerText.slice(0, 400),
    })`,
  );
  const rendered = identity.title === 'G9 Browser Agent'
    && identity.tabs >= 3
    && identity.sessionBody
    && identity.attachControl;
  if (!rendered) {
    throw new Error('Panel did not render its meaningful session UI: ' + JSON.stringify(identity));
  }
  await panelCdp.evaluate('document.querySelector(\'button[data-tab="automation"]\').click()');
  const automationVisible = await panelCdp.evaluate(
    '!document.querySelector(\'[data-body="automation"]\').hidden && document.getElementById("recToggle").offsetWidth > 0',
  );
  if (!automationVisible) throw new Error('Panel Automation tab did not respond.');
  const image = await panelCdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(image.data, 'base64'));
  console.log('\nPanel render: PASS · Automation tab interaction: PASS');
  console.log('Panel screenshot: ' + screenshotPath + '\n');

  workerCdp.close();
  activeWorker.close();
  panelCdp.close();
  if (exitCode !== 0) dumpWorkerLog();
  process.exitCode = exitCode;
} finally {
  if (browserControl) {
    await browserControl.send('Browser.close').catch(() => {});
    browserControl.close();
  }
  for (const child of children.reverse()) {
    if (child.exitCode == null) child.kill();
  }
  let cleaned = false;
  for (let attempt = 0; attempt < 5 && !cleaned; attempt++) {
    await delay(500 + attempt * 500);
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      await rm(extensionCopy, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      cleaned = true;
    } catch (err) {
      if (attempt === 4) {
        console.warn('Could not remove isolated profile yet (browser lock still held): ' + profile);
        console.warn(String(err?.message ?? err));
      }
    }
  }
}
}

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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error('Timed out waiting for ' + url);
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

async function waitBrowserTarget(cdp, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await cdp.send('Target.getTargets');
    const target = result.targetInfos?.find(predicate);
    if (target) return target;
    await delay(150);
  }
  throw new Error('Timed out waiting for the extension service worker target via Target.getTargets.');
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
async function waitExtensionWorker(cdp, timeoutMs, debugPort) {
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
        if (name === 'G9 Browser Agent') return { target, session };
        notOurs.add(target.targetId);
      } catch {
        // Mid-startup or mid-teardown. Deliberately NOT blacklisted.
      }
    }

    // No worker is running. Wake it by loading a page from its own origin.
    if (!woke) {
      const anyExtension = seen.find((t) => t.url.startsWith('chrome-extension://'));
      if (anyExtension) {
        woke = true;
        const id = new URL(anyExtension.url).hostname;
        await openTarget(debugPort, 'chrome-extension://' + id + '/panel/panel.html').catch(() => {});
      }
    }

    await delay(200);
  }

  throw new Error(
    'Timed out waiting for the G9 Browser Agent service worker. Targets visible were:\n  ' +
      (seen.map((t) => `${t.type} ${t.url}`).join('\n  ') || '(none)'),
  );
}

async function openTarget(port, url) {
  const response = await fetch(
    'http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url),
    { method: 'PUT' },
  );
  if (!response.ok) throw new Error('Could not open panel target: HTTP ' + response.status);
  return response.json();
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
        // An event, not a reply. Deliver it to anyone watching this session.
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
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Runtime evaluation failed',
    );
    return result.result?.value;
  }
  close() { this.socket.close(); }
  session(sessionId) {
    return {
      ready: this.ready,
      send: (method, params = {}) => this.send(method, params, sessionId),
      on: (method, handler) => { this.listeners.push({ sessionId, method, handler }); },
      evaluate: async (expression) => {
        const result = await this.send('Runtime.evaluate', {
          expression, awaitPromise: true, returnByValue: true, userGesture: true,
        }, sessionId);
        if (result.exceptionDetails) throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Runtime evaluation failed',
        );
        return result.result?.value;
      },
      close() {},
    };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
