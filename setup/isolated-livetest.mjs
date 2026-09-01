#!/usr/bin/env node
/**
 * One-command real-browser validation in an isolated Chrome profile.
 *
 * It loads the unpacked extension, serves the seeded page, configures a private
 * bridge port, pins the page, runs livetest.mjs, then renders and screenshots
 * the panel. The normal browser profile and installed G9 extension are untouched.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXTENSION = path.join(ROOT, 'extension');
const TEST_URL = 'http://127.0.0.1:5199/';
const profile = await mkdtemp(path.join(tmpdir(), 'g9-isolated-'));
const bridgePort = await freePort();
const debugPort = await freePort();
const screenshotPath = process.env.G9_PANEL_SCREENSHOT ??
  path.join(tmpdir(), 'g9-panel-' + Date.now() + '.png');
const children = [];

async function main() {
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

  const chrome = spawn(browser, [
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + debugPort,
    '--load-extension=' + EXTENSION,
    '--disable-extensions-except=' + EXTENSION,
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
  const foundWorker = await waitExtensionWorker(browserControl, 25_000);
  const worker = foundWorker.target;
  const extensionId = new URL(worker.url).hostname;
  const workerCdp = foundWorker.session;
  await workerCdp.evaluate(
    'chrome.storage.local.set({ settings: ' + JSON.stringify({
      mode: 'pinned',
      bridge: { host: '127.0.0.1', port: bridgePort, token: '', serverPath: null, repoRoot: null },
    }) + ' })',
  );

  const live = spawn(process.execPath, [path.join(HERE, 'livetest.mjs')], {
    cwd: ROOT,
    env: { ...process.env, G9_PORT: String(bridgePort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(live);
  live.stdout.pipe(process.stdout);
  live.stderr.pipe(process.stderr);

  // Reload after the private bridge exists so bootstrap reads the persisted
  // port and connects immediately. Then seed the same pinned state a user
  // creates with the panel button.
  await delay(600);
  await workerCdp.evaluate('chrome.runtime.reload(); true').catch(() => {});
  const reloadedWorker = await waitBrowserTarget(browserControl, (target) =>
    target.type === 'service_worker' && target.targetId !== worker.targetId &&
    target.url.startsWith('chrome-extension://' + extensionId + '/'), 10_000);
  const reattached = await browserControl.send('Target.attachToTarget', { targetId: reloadedWorker.targetId, flatten: true });
  const activeWorker = browserControl.session(reattached.sessionId);
  await activeWorker.send('Runtime.enable');
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
  const identity = await panelCdp.evaluate(
    '({ title: document.title, text: document.body.innerText.slice(0, 3000), error: document.getElementById("panelError")?.textContent || "" })',
  );
  if (identity.title !== 'G9 Browser Agent' || !identity.text.includes('Attached tab')) {
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

async function waitExtensionWorker(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const checked = new Set();
  while (Date.now() < deadline) {
    const result = await cdp.send('Target.getTargets');
    const candidates = (result.targetInfos ?? []).filter((target) =>
      target.type === 'service_worker' &&
      target.url.startsWith('chrome-extension://') &&
      !checked.has(target.targetId)
    );
    for (const target of candidates) {
      checked.add(target.targetId);
      try {
        const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const session = cdp.session(attached.sessionId);
        await session.send('Runtime.enable');
        const name = await session.evaluate('chrome.runtime.getManifest().name');
        if (name === 'G9 Browser Agent') return { target, session };
      } catch {}
    }
    await delay(150);
  }
  throw new Error('Timed out waiting for the G9 Browser Agent service worker.');
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
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
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
