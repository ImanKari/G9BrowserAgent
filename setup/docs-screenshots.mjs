/**
 * The README screenshots, from a real run — never mock data or a hand-arranged UI.
 *
 *   node setup/docs-screenshots.mjs [--out docs/assets] [--app <packaged G9 executable>] [--browser <chrome/edge path>]
 *                                   [--engine edge|chrome|cft]   (the launched browser for Watch; default auto)
 *
 * What happens, all on this machine and all disposable:
 *   - a private daemon (temporary G9_HOME, a random port — never 8765),
 *   - the made-up Demo Shop (setup/fixtures/demo-shop.html) on 127.0.0.1,
 *   - a real headless Chrome/Edge with the real extension, installed the way the setup wizard does
 *     (G9_HOME/extension) and loaded unpacked,
 *   - an AI agent's side of it through the real MCP shim (mcp/shim.mjs over stdio, started in a demo
 *     project folder): it attaches the shop tab, records a checkout flow, fills and submits the
 *     form with human-like input, and files an issue with a screenshot,
 *   - the side panel of that extension, opened as its own page, photographed tab by tab,
 *   - with --app, the packaged desktop app on the same daemon: each view, and Watch showing a
 *     launched browser live with the cursor drawn from the pointer track.
 *
 * Privacy: run it where the machine's user name and paths are neutral (the screenshots show the
 * G9 home folder, the program folder and, in Settings, the OS user name). The published images
 * were made in a container as user "demo" (see docs/assets/README.md). Nothing here signs in anywhere,
 * and the only site visited is the local Demo Shop.
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(opt('--out', path.join(ROOT, 'docs', 'assets')));
const APP = opt('--app');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[docs] ${a.join(' ')}`);
const children = [];

async function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
async function waitFor(what, fn, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await delay(400);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

// ------------------------------------------------------------------ CDP over a WebSocket

class Cdp {
  static async connect(url) {
    const c = new Cdp();
    c.ws = new WebSocket(url);
    c.seq = 0;
    c.pending = new Map();
    await new Promise((res, rej) => { c.ws.onopen = res; c.ws.onerror = () => rej(new Error('CDP socket error')); });
    c.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      const p = c.pending.get(m.id);
      if (!p) return;
      c.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression, sessionId) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* closing */ } }
}

async function shot(send, file, { width, height, scale = 2, sessionId } = {}) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
  await delay(700);
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  fs.writeFileSync(path.join(OUT, file), Buffer.from(data, 'base64'));
  log(`wrote ${file}`);
}

// ------------------------------------------------------------------ an MCP client: the agent

class Agent {
  constructor({ cwd, env }) {
    this.child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'shim.mjs')], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(this.child);
    this.seq = 0;
    this.pending = new Map();
    let buf = '';
    this.child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      }
    });
    this.child.stderr.on('data', () => {});
  }
  request(method, params) {
    const id = ++this.seq;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async init() {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.x' } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }
  async call(name, args) {
    const r = await this.request('tools/call', { name, arguments: args });
    const text = (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r?.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return text; }
  }
}

// ------------------------------------------------------------------ the run

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-docs-'));
  const home = path.join(work, 'home');
  const project = path.join(work, 'demo-shop');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const port = 18000 + Math.floor(Math.random() * 900);
  const env = { ...process.env, G9_HOME: home, G9_PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;

  // The shop.
  const page = fs.readFileSync(path.join(ROOT, 'setup', 'fixtures', 'demo-shop.html'));
  const shop = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); });
  const shopPort = await freePort();
  await new Promise((r) => shop.listen(shopPort, '127.0.0.1', r));
  const SHOP = `http://127.0.0.1:${shopPort}/`;
  fs.writeFileSync(path.join(project, 'g9.project.json'), JSON.stringify({ defaultEnvironment: 'local', environments: { local: SHOP } }, null, 2));
  // The desktop app opens on Setup until the wizard is done; the screenshots show it done except
  // the extension step, so the Setup view has something to show.
  fs.writeFileSync(path.join(home, 'desktop.json'), JSON.stringify({ wizard: { completedAt: new Date().toISOString(), steps: {} } }, null, 2));

  // The daemon.
  // Started IN the demo project folder: from anywhere else it would look up the tree for a
  // g9.project.json and could find a real project of this machine's owner.
  const daemon = spawn(process.execPath, [path.join(ROOT, 'daemon', 'g9d.mjs'), '--foreground'], { env, cwd: project, stdio: 'ignore' });
  children.push(daemon);
  await waitFor('the daemon', async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok);
  log(`daemon on ${port}, home ${home}`);

  // The extension, as the wizard installs it, then a real browser with it.
  const { DaemonClient } = await import(pathToFileURL(path.join(ROOT, 'desktop', 'lib', 'daemon-client.mjs')).href);
  const admin = new DaemonClient({ port, version: 'docs', clientName: 'g9-docs', role: 'ui' });
  admin.on('error', () => {});
  admin.start();
  await waitFor('the admin connection', () => admin.connected);
  const installed = await admin.admin('extension.install', {});
  fs.writeFileSync(path.join(installed.path, 'dev-daemon.json'), JSON.stringify({ host: '127.0.0.1', port }));
  const find = await import(pathToFileURL(path.join(ROOT, 'engine', 'find.js')).href);
  const browsers = await find.findBrowsers({ includeRegistry: process.platform === 'win32' });
  const browserPath = opt('--browser') ?? (browsers.find((b) => b.kind === 'chrome' && b.channel === 'stable') ?? browsers.find((b) => b.kind === 'edge') ?? browsers[0])?.path;
  if (!browserPath) throw new Error('No Chrome or Edge found (pass --browser <path>).');
  const debugPort = await freePort();
  const browser = spawn(browserPath, [
    `--user-data-dir=${path.join(work, 'profile')}`, `--remote-debugging-port=${debugPort}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-features=msImplicitSignin', '--headless=new', '--window-size=1280,860',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  children.push(browser);
  const { PipeCdp } = await import(pathToFileURL(path.join(ROOT, 'engine', 'pipe-cdp.js')).href);
  const pipe = new PipeCdp(browser.stdio[3], browser.stdio[4], { name: 'docs browser', child: browser });
  const ext = await pipe.send('Target.createTarget', { url: 'chrome://extensions' });
  const { sessionId: extPage } = await pipe.send('Target.attachToTarget', { targetId: ext.targetId, flatten: true });
  for (let i = 0; i < 20; i++) {
    await delay(250);
    const on = (await pipe.send('Runtime.evaluate', { expression: 'new Promise((d) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => chrome.developerPrivate.getProfileConfiguration((c) => d(c.inDeveloperMode))))', awaitPromise: true, returnByValue: true }, extPage).catch(() => null))?.result?.value;
    if (on) break;
  }
  await pipe.send('Target.closeTarget', { targetId: ext.targetId }).catch(() => {});
  const { id: extId } = await pipe.send('Extensions.loadUnpacked', { path: installed.path });
  const shopTarget = await pipe.send('Target.createTarget', { url: SHOP });
  await waitFor('the extension to connect', async () => (await admin.admin('state', {})).engines?.some((e) => e.kind === 'extension'));
  log(`extension ${extId} connected`);

  // The agent, through the real MCP shim, from the demo project folder.
  const agent = new Agent({ cwd: project, env });
  await agent.init();
  const tabs = await agent.call('browser_tabs', { action: 'list' });
  const tab = (tabs.tabs ?? tabs).find((t) => String(t.url ?? '').startsWith(SHOP));
  await agent.call('browser_tabs', { action: 'attach', tabId: tab.tabId });
  // It opened behind about:blank: G9 refuses input to a hidden tab, and says to bring it forward.
  await agent.call('browser_tabs', { action: 'focus', tabId: tab.tabId });
  const started = await agent.call('browser_recording', { action: 'start', tabId: tab.tabId, name: 'Checkout — place an order' });
  const recId = started?.id ?? started?.recording?.id ?? started?.recordingId ?? null;
  // As an agent works: read the page (browser_snapshot), then act on the refs it names.
  const tree = await agent.call('browser_snapshot', { tabId: tab.tabId });
  const text = typeof tree === 'string' ? tree : (tree.snapshot ?? tree.tree ?? tree.text ?? JSON.stringify(tree));
  const nodes = [...text.matchAll(/- (\w+) "([^"]*)" \[ref=(e\d+)\]/g)].map((m) => ({ role: m[1], name: m[2], ref: m[3] }));
  const ref = (role, name, nth = 0) => {
    const r = nodes.filter((n) => n.role === role && n.name === name)[nth]?.ref;
    if (!r) throw new Error(`no ${role} "${name}" #${nth} in the snapshot`);
    return r;
  };
  const act = (action, r, extra = {}) => agent.call('browser_interact', { action, ref: r, tabId: tab.tabId, ...extra });
  await act('click', ref('button', 'Add to cart', 0)); // the desk lamp
  await act('click', ref('button', 'Add to cart', 4)); // the small plant
  await act('type', ref('textbox', 'Full name'), { text: 'Alex Example' });
  await act('type', ref('textbox', 'Email'), { text: 'alex@example.com' });
  await act('click', ref('button', 'Place order'));
  const stopped = await agent.call('browser_recording', { action: 'stop', tabId: tab.tabId });
  const flowId = stopped?.id ?? stopped?.recording?.id ?? stopped?.flowId ?? recId;
  if (!flowId) throw new Error(`browser_recording stop returned no id: ${JSON.stringify(stopped).slice(0, 300)}`);
  // A check makes it a test, not a macro: the confirmation must say the order was placed.
  await agent.call('browser_recording', { action: 'assert', id: flowId, tabId: tab.tabId, assertion: 'text', operator: 'contains', contains: 'Order #1042 placed' });
  await agent.call('browser_recording', { action: 'update', id: flowId, suite: 'checkout', tags: ['smoke'] });
  await agent.call('browser_issue', { action: 'create', tabId: tab.tabId, title: 'Order total ignores the shipping option', severity: 'major', tags: ['checkout'], body: 'Express shipping is selectable, but the total stays the same.', withScreenshot: true });
  log('agent: attached, recorded a flow, filed an issue');

  // The demo page as the agent left it.
  const { sessionId: shopSession } = await pipe.send('Target.attachToTarget', { targetId: shopTarget.targetId, flatten: true });
  await shot((m, p, s) => pipe.send(m, p, s), 'demo-shop.png', { width: 1100, height: 640, scale: 1, sessionId: shopSession });

  // The side panel, as its own page.
  const panel = await pipe.send('Target.createTarget', { url: `chrome-extension://${extId}/panel/panel.html`, newWindow: true });
  const { sessionId: ps } = await pipe.send('Target.attachToTarget', { targetId: panel.targetId, flatten: true });
  const psend = (m, p) => pipe.send(m, p, ps);
  await delay(1500);
  const tabShot = async (id, file) => {
    await pipe.send('Runtime.evaluate', { expression: `document.getElementById('tab-${id}')?.click()`, returnByValue: true }, ps);
    await delay(900);
    await shot(psend, file, { width: 380, height: 760, scale: 2 });
  };
  await tabShot('session', 'panel-session.png');
  await tabShot('automation', 'panel-automation.png');
  await tabShot('issues', 'panel-issues.png');
  await tabShot('about', 'panel-about.png');

  // The desktop app on the same daemon.
  if (APP) {
    const cdpPort = await freePort();
    const app = spawn(APP, [...(process.platform === 'linux' ? ['--no-sandbox'] : []), `--remote-debugging-port=${cdpPort}`], { env, stdio: 'ignore' });
    children.push(app);
    const target = await waitFor('the desktop window', async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => String(t.url).startsWith('g9app://')), 90_000);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const csend = (m, p) => cdp.send(m, p);
    await waitFor('the app to connect', async () => (await cdp.eval('window.g9.invoke("state").then((s) => s.connection?.status)')) === 'connected');
    // A launched browser for Watch, driven by the agent so the cursor moves.
    const launched = await agent.call('browser_engine', { action: 'launch', headless: true, ...(opt('--engine') ? { browser: opt('--engine') } : {}) });
    const opened = await agent.call('browser_tabs', { action: 'open', url: SHOP, engine: launched.engineId });
    const view = async (name, file, extra = null) => {
      await cdp.eval(`document.querySelector('[data-view=${name}]')?.click()`);
      await delay(1200);
      if (extra) await extra();
      await shot(csend, file, { width: 1200, height: 760, scale: 1.5 });
    };
    await view('agents', 'desktop-agents.png');
    await view('engines', 'desktop-engines.png');
    await view('watch', 'desktop-watch.png', async () => {
      // Pick the launched shop tab in the view's own picker, then press Watch — as a person does.
      await cdp.eval(`(async () => {
        const sel = document.querySelector('select[aria-label="Tab to watch"]');
        const opt = [...(sel?.options ?? [])].find((o) => o.value === String(${opened.tabId}) || /Demo Shop/.test(o.textContent));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Watch')?.click();
      })()`).catch(() => {});
      await delay(2000);
      const t2 = await agent.call('browser_snapshot', { tabId: opened.tabId });
      const txt2 = typeof t2 === 'string' ? t2 : (t2.snapshot ?? t2.tree ?? t2.text ?? JSON.stringify(t2));
      const add = [...txt2.matchAll(/- button "Add to cart" \[ref=(e\d+)\]/g)].map((m) => m[1]);
      if (add[1]) await agent.call('browser_interact', { action: 'click', ref: add[1], tabId: opened.tabId }).catch(() => {});
      const name = /- textbox "Full name" \[ref=(e\d+)\]/.exec(txt2)?.[1];
      if (name) await agent.call('browser_interact', { action: 'hover', ref: name, tabId: opened.tabId }).catch(() => {});
      await delay(1500);
    });
    await view('runs', 'desktop-runs.png');
    await view('settings', 'desktop-settings.png');
    await view('settings', 'desktop-updates.png', async () => {
      await cdp.eval("[...document.querySelectorAll('h2, h3, .section-head')].find((e) => /Updates/.test(e.textContent))?.scrollIntoView()");
      await delay(500);
    });
    await view('setup', 'desktop-setup.png');
    cdp.close();
  }
  admin.stop();
  log(`done: ${OUT}`);
  return work;
}

let work = null;
main().then((w) => { work = w; }, (err) => { console.error(err?.stack ?? err); process.exitCode = 1; }).finally(async () => {
  for (const c of children.reverse()) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  await delay(800);
  if (work) fs.rmSync(work, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
});
