/**
 * The desktop update, end to end, with real packages — never a mocked updater.
 *
 *   node test/update-e2e.mjs --old <dir> --new <dir> [--feed local|official] [--only a,b] [--report <file>] [--keep]
 *
 *   --old   a folder with the OLDER build's installer for this OS (scripts/build.mjs --as-version):
 *           Windows G9BrowserAgent-Setup-<v>.exe, Linux G9BrowserAgent-x86_64.AppImage, macOS G9BrowserAgent-<v>-mac-<arch>.zip
 *   --new   the NEWER release: its installers and latest*.yml, exactly what a release publishes.
 *           With --feed local (default) it is served on 127.0.0.1 as the app's custom update feed,
 *           with faults injected on purpose. With --feed official it is only read for its version:
 *           the app, installed with no update configuration at all, must find that release on the
 *           official GitHub releases by itself.
 *
 * What runs (Windows and a Linux AppImage install updates themselves; macOS only finds them):
 *   corrupt      the installer arrives with its bytes changed → SHA-512 mismatch, nothing installed
 *   interrupted  the connection drops mid-download → an error, and the next check downloads it
 *   skip         "Skip this version" → the next check does not download it again
 *   busy         a launched browser is open → "Install now" is deferred, with the reason
 *   install      "Install when I quit" → quit → the installer runs → the app is started again →
 *                it notices the update, refreshes G9_HOME/extension, the extension reloads (in a
 *                real headless Edge/Chrome with that folder loaded unpacked) and reconnects at the
 *                new version; the daemon is the new version; nothing reports a mismatch
 *   reload-busy  an extension reload asked for while a call runs waits for that call (60 s cap)
 *   manual       (macOS, a .deb) the release is found, nothing is downloaded, the release page is named
 *   official     (--feed official) a fresh install with no settings finds, downloads and installs the
 *                published GitHub release
 *
 * Isolation: a temporary G9_HOME and random ports (never 8765), a temporary browser profile, the
 * app's window shown but never focused on purpose. Windows installs per user (a Start-menu entry and
 * an uninstall key, removed by the uninstaller at the end). Everything this test started is stopped.
 * Exit 0 only when every selected scenario passed. A JSON report goes to --report (default: the OS
 * temp folder, g9-update-e2e-<platform>.json).
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseUpdateYml, sha512Base64 } from '../scripts/verify-artifacts.mjs';
import { DaemonClient } from '../lib/daemon-client.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(APP_DIR, '..');
const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const OLD_DIR = path.resolve(opt('--old') ?? '');
const NEW_DIR = path.resolve(opt('--new') ?? '');
const FEED = opt('--feed', 'local');
const KEEP = args.includes('--keep');
const REPORT = path.resolve(opt('--report') ?? path.join(os.tmpdir(), `g9-update-e2e-${process.platform}.json`));
const PLATFORM = process.platform;
const META = { win32: 'latest.yml', darwin: 'latest-mac.yml', linux: 'latest-linux.yml' }[PLATFORM];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
}
async function waitFor(what, fn, { timeoutMs = 60_000, everyMs = 500 } = {}) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await delay(everyMs);
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${last instanceof Error ? ` (last error: ${last.message})` : ''}`);
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}
const portIn = async (lo, hi) => {
  for (let i = 0; i < 50; i++) {
    const p = lo + Math.floor(Math.random() * (hi - lo));
    const free = await new Promise((r) => {
      const s = net.createServer();
      s.once('error', () => r(false));
      s.listen(p, '127.0.0.1', () => s.close(() => r(true)));
    });
    if (free) return p;
  }
  return freePort();
};

// ------------------------------------------------------------------ what is being tested

function readMeta(dir) {
  const file = path.join(dir, META);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing: --new must be a release folder for ${PLATFORM}`);
  return parseUpdateYml(fs.readFileSync(file, 'utf8'));
}
function oldArtifact() {
  const names = fs.readdirSync(OLD_DIR);
  const pick = {
    // Either name: an older build may still be G9-Setup-<v>.exe (before 3.2.1).
    win32: (n) => /^(G9BrowserAgent|G9)-Setup-.+\.exe$/.test(n),
    linux: (n) => /\.AppImage$/.test(n),
    darwin: (n) => n.endsWith(`-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`),
  }[PLATFORM];
  const found = names.find(pick);
  if (!found) throw new Error(`No ${PLATFORM} package in ${OLD_DIR} (${names.join(', ')})`);
  // The version from the update metadata the build wrote beside it; a file name like
  // G9-3.0.1-x86_64.AppImage would otherwise read as the prerelease "3.0.1-x86".
  const meta = path.join(OLD_DIR, META);
  const version = fs.existsSync(meta)
    ? parseUpdateYml(fs.readFileSync(meta, 'utf8')).version
    : /(\d+\.\d+\.\d+)(?=[-_.](?:x86_64|amd64|mac|exe|AppImage|zip|dmg))/.exec(found)?.[1];
  return { file: path.join(OLD_DIR, found), version };
}

// ------------------------------------------------------------------ the local feed, with faults

class Feed {
  constructor(dir) {
    this.dir = dir;
    this.requests = [];
    this.corrupt = new Set();
    this.cut = new Map(); // name → { bytes, times }: drop the connection after `bytes`, for the next `times` requests
  }

  async start() {
    this.server = http.createServer((req, res) => this.#serve(req, res));
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
    this.url = `http://127.0.0.1:${this.port}/`;
    return this;
  }

  stop() {
    return new Promise((r) => this.server?.close(() => r()) ?? r());
  }

  count(name) {
    return this.requests.filter((q) => q.name === name && q.method === 'GET').length;
  }

  #serve(req, res) {
    const url = new URL(req.url, 'http://x');
    const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    this.requests.push({ at: Date.now(), method: req.method, name, range: req.headers.range ?? null });
    if (name === 'slow') {
      // A page that takes `ms` to arrive: the "call in flight" of the reload-busy scenario.
      const ms = Math.min(Number(url.searchParams.get('ms')) || 5000, 30_000);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end('<!doctype html><title>slow</title><p>slow page</p>');
      }, ms);
      return;
    }
    if (name === '' || name === 'page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>G9BrowserAgent update test</title><h1>G9BrowserAgent update test page</h1>');
      return;
    }
    const file = path.join(this.dir, name);
    if (!file.startsWith(this.dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    const size = fs.statSync(file).size;
    let start = 0;
    let end = size - 1;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (m) {
      start = m[1] ? Number(m[1]) : size - Number(m[2]);
      end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    }
    const headers = { 'content-type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': end - start + 1 };
    if (m) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(m ? 206 : 200, headers);
    if (req.method === 'HEAD') return res.end();
    const rule = this.cut.get(name);
    let cut;
    if (rule && rule.times > 0 && req.method === 'GET') {
      cut = rule.bytes;
      rule.times -= 1;
      rule.dropped = (rule.dropped ?? 0) + 1;
    }
    const stream = fs.createReadStream(file, { start, end });
    let sent = 0;
    stream.on('data', (chunk) => {
      let out = chunk;
      if (this.corrupt.has(name)) {
        out = Buffer.from(chunk);
        for (let i = 0; i < out.length; i += 4096) out[i] ^= 0xff; // same length, wrong bytes
      }
      if (cut !== undefined && sent + out.length >= cut) {
        res.write(out.subarray(0, Math.max(0, cut - sent)));
        stream.destroy();
        res.destroy(); // the connection drops mid-transfer
        return;
      }
      sent += out.length;
      if (!res.write(out)) {
        stream.pause();
        res.once('drain', () => stream.resume());
      }
    });
    stream.on('end', () => res.end());
    stream.on('error', () => res.destroy());
  }
}

// ------------------------------------------------------------------ install, launch, uninstall

// The product's names, newest first: G9BrowserAgent since 3.2.1, G9 before it. An update from an
// older build replaces G9.exe with G9BrowserAgent.exe (in the same folder), so the executable is
// looked up whenever it is needed, not remembered from the install.
const NAMES = ['G9BrowserAgent', 'G9'];

function winUninstallers() {
  return NAMES.map((n) => path.join(process.env.LOCALAPPDATA ?? '', 'Programs', n, `Uninstall ${n}.exe`));
}

class Install {
  constructor(tmp) {
    this.tmp = tmp;
    this.dir = path.join(tmp, 'app');
    this.file = null; // Linux: the AppImage
  }

  /** The installed app's executable, as it is now (its name changes with an update across 3.2.1). */
  get exe() {
    if (PLATFORM === 'linux') return this.file;
    if (!this.root) return null;
    const found = PLATFORM === 'win32'
      ? NAMES.map((n) => path.join(this.root, `${n}.exe`)).find((p) => fs.existsSync(p))
      : NAMES.map((n) => path.join(this.dir, `${n}.app`, 'Contents', 'MacOS', n)).find((p) => fs.existsSync(p));
    return found ?? null;
  }

  install(file) {
    fs.mkdirSync(this.dir, { recursive: true });
    if (PLATFORM === 'win32') {
      // NSIS: /S silent, /D=<dir> (last, unquoted). Per user: no elevation.
      const r = spawnSync(file, ['/S', `/D=${this.dir}`], { stdio: 'ignore', timeout: 300_000, windowsHide: true });
      if (r.status !== 0) throw new Error(`The installer exited ${r.status}`);
      const dirs = [this.dir, ...NAMES.map((n) => path.join(process.env.LOCALAPPDATA ?? '', 'Programs', n))];
      this.root = dirs.find((d) => NAMES.some((n) => fs.existsSync(path.join(d, `${n}.exe`))));
      if (!this.root) throw new Error(`The app was not found after installing (looked in ${dirs.join(', ')})`);
    } else if (PLATFORM === 'linux') {
      // Under the name it is published with (G9BrowserAgent-x86_64.AppImage): the updater replaces a file IN
      // PLACE only when its name carries no version, which is what this checks.
      this.file = path.join(this.dir, path.basename(file));
      fs.copyFileSync(file, this.file);
      fs.chmodSync(this.file, 0o755);
      this.root = this.dir;
    } else {
      execFileSync('ditto', ['-x', '-k', file, this.dir]);
      this.root = NAMES.map((n) => path.join(this.dir, `${n}.app`)).find((d) => fs.existsSync(d));
      if (!this.root) throw new Error(`No app bundle in ${file}`);
      // A download from the internet carries the quarantine flag; this zip did not come from one.
      spawnSync('xattr', ['-dr', 'com.apple.quarantine', this.root]);
    }
    return this;
  }

  /** The installed version, read the way the app itself reads it. */
  version() {
    if (PLATFORM === 'win32') return JSON.parse(fs.readFileSync(path.join(this.root, 'resources', 'package.json'), 'utf8')).version;
    if (PLATFORM === 'darwin') return JSON.parse(fs.readFileSync(path.join(this.root, 'Contents', 'Resources', 'package.json'), 'utf8')).version;
    return null; // an AppImage is one file: compared by hash instead (sameFileAs)
  }

  sameFileAs(file) {
    return sha512Base64(this.exe) === sha512Base64(file);
  }

  uninstall() {
    if (PLATFORM === 'win32') {
      for (const u of [...NAMES.map((n) => path.join(this.root ?? this.dir, `Uninstall ${n}.exe`)), ...winUninstallers()]) {
        if (fs.existsSync(u)) spawnSync(u, ['/S'], { stdio: 'ignore', timeout: 120_000, windowsHide: true });
      }
    }
  }
}

class App {
  constructor({ exe, env, cdpPort }) {
    this.exe = exe;
    this.env = env;
    this.cdpPort = cdpPort;
  }

  start() {
    const extra = PLATFORM === 'linux' ? ['--no-sandbox'] : [];
    this.child = spawn(this.exe, [...extra, `--remote-debugging-port=${this.cdpPort}`], {
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: PLATFORM !== 'win32',
      windowsHide: false,
    });
    this.output = '';
    this.child.stdout.on('data', (d) => { this.output = (this.output + d).slice(-20_000); });
    this.child.stderr.on('data', (d) => { this.output = (this.output + d).slice(-20_000); });
    this.exited = new Promise((r) => this.child.once('exit', (code) => r(code)));
    return this;
  }

  /** The renderer page, over Chromium's DevTools protocol (the app is driven as a person would). */
  async connect() {
    const target = await waitFor('the app window', async () => {
      const list = await (await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`)).json();
      return list.find((t) => t.type === 'page' && String(t.url).startsWith('g9app://app/'));
    }, { timeoutMs: 90_000 });
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('CDP socket error'));
    });
    this.seq = 0;
    this.pending = new Map();
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    };
    await waitFor('the g9 bridge in the page', () => this.eval('typeof window.g9?.invoke === "function"'), { timeoutMs: 30_000 });
    return this;
  }

  eval(expression) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => (r.exceptionDetails ? reject(new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)) : resolve(r.result?.value)),
        reject,
      });
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), reject(new Error(`evaluate timed out: ${expression.slice(0, 80)}`))), 120_000).unref?.();
    });
  }

  invoke(op, a = {}) {
    return this.eval(`window.g9.invoke(${JSON.stringify(op)}, ${JSON.stringify(a)})`);
  }

  updater() {
    return this.invoke('updater.state');
  }

  async waitUpdater(what, pred, timeoutMs = 300_000) {
    return waitFor(`updater: ${what}`, async () => {
      const s = await this.updater();
      return pred(s) ? s : null;
    }, { timeoutMs, everyMs: 1000 });
  }

  async kill() {
    try { this.ws?.close(); } catch { /* closing anyway */ }
    if (!this.child || this.child.exitCode !== null) return;
    try {
      if (PLATFORM === 'win32') spawnSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-this.child.pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
}

// ------------------------------------------------------------------ a real browser with the extension

/** --browser edge|chrome|cft picks one; otherwise Edge, then Chrome, then Chrome for Testing. */
async function findBrowser() {
  const find = await import(pathToFileURL(path.join(REPO, 'engine', 'find.js')).href);
  const all = await find.findBrowsers({ includeRegistry: PLATFORM === 'win32' });
  const want = opt('--browser');
  const stable = (kind) => all.find((b) => b.kind === kind && (b.channel === 'stable' || kind === 'cft'));
  if (want) return stable(want) ?? null;
  return stable('edge') ?? stable('chrome') ?? stable('cft') ?? null;
}

/**
 * A headless browser with G9_HOME/extension loaded, the way a person has it: Edge with
 * --load-extension (reloads in ~1 s), Chrome through Developer mode + Extensions.loadUnpacked
 * (branded Chrome ignores --load-extension; see setup/isolated-livetest.mjs for the measurements).
 */
async function startBrowser({ browser, extDir, profile, pageUrl }) {
  const unpacked = browser.kind !== 'edge';
  const argv = [
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-component-update', '--disable-sync',
    '--disable-features=msImplicitSignin', '--headless=new', '--window-size=1280,900',
    ...(PLATFORM === 'linux' ? ['--no-sandbox'] : []),
    ...(unpacked ? ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging', 'about:blank'] : [`--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`, pageUrl]),
  ];
  const child = spawn(browser.path, argv, { stdio: unpacked ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : 'ignore', windowsHide: true, detached: PLATFORM !== 'win32' });
  if (unpacked) {
    const { PipeCdp } = await import(pathToFileURL(path.join(REPO, 'engine', 'pipe-cdp.js')).href);
    const pipe = new PipeCdp(child.stdio[3], child.stdio[4], { name: 'e2e browser', child });
    const page = await pipe.send('Target.createTarget', { url: 'chrome://extensions' });
    const { sessionId } = await pipe.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    let dev = null;
    for (let i = 0; i < 20 && dev !== true; i++) {
      await delay(250);
      dev = (await pipe.send('Runtime.evaluate', {
        expression: 'new Promise((d) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => chrome.developerPrivate.getProfileConfiguration((c) => d(c.inDeveloperMode))))',
        awaitPromise: true, returnByValue: true,
      }, sessionId).catch(() => null))?.result?.value ?? null;
    }
    await pipe.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    await pipe.send('Extensions.loadUnpacked', { path: extDir });
    await pipe.send('Target.createTarget', { url: pageUrl });
    child.pipe = pipe;
  }
  return child;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (PLATFORM === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* gone */ }
}

// ------------------------------------------------------------------ the run

async function main() {
  if (!fs.existsSync(OLD_DIR) || !fs.existsSync(NEW_DIR)) {
    console.error('Usage: node test/update-e2e.mjs --old <dir with the older package> --new <release dir> [--feed local|official] [--only a,b] [--keep]');
    process.exit(2);
  }
  const meta = readMeta(NEW_DIR);
  const old = oldArtifact();
  const NEW = meta.version;
  const newInstaller = path.join(NEW_DIR, meta.path ?? meta.files[0].url);
  const installerName = path.basename(newInstaller);
  const mode = PLATFORM === 'darwin' ? 'manual' : 'auto';
  const all = FEED === 'official'
    ? (mode === 'manual' ? ['manual'] : ['official'])
    : (mode === 'manual' ? ['manual'] : ['corrupt', 'interrupted', 'skip', 'busy', 'install', 'reload-busy']);
  const only = opt('--only');
  const scenarios = only ? all.filter((s) => only.split(',').includes(s)) : all;
  log(`G9BrowserAgent update e2e on ${PLATFORM}/${process.arch}: ${old.version} → ${NEW} (${FEED} feed, ${mode} install) — ${scenarios.join(', ')}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-update-e2e-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const port = await portIn(18000, 18999);
  const cdpPort = await portIn(19000, 19499);
  const feed = FEED === 'local' ? await new Feed(NEW_DIR).start() : null;
  const pageServer = feed ?? await new Feed(tmp).start(); // the test pages, also for --feed official
  const env = { ...process.env, G9_HOME: home, G9_PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;
  // A user profile of its own: the app writes AI clients' configs (~/.claude.json, …\Claude\…) at
  // start (3.2.1: mcp-register migrateRegistrations) — never this machine's own.
  const profile = path.join(tmp, 'profile');
  const profileEnv = PLATFORM === 'win32'
    ? { USERPROFILE: profile, APPDATA: path.join(profile, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(profile, 'AppData', 'Local') }
    : { HOME: profile, XDG_CONFIG_HOME: path.join(profile, '.config'), XDG_CACHE_HOME: path.join(profile, '.cache') };
  for (const d of [profile, ...Object.values(profileEnv)]) fs.mkdirSync(d, { recursive: true });
  Object.assign(env, profileEnv);
  const claudeJson = path.join(profile, '.claude.json');
  const fwd = (s) => String(s).replace(/\\/g, '/');
  const inst = new Install(tmp);
  const cleanups = [];
  let app = null;
  let browser = null;
  let daemon = null;
  const report = { platform: PLATFORM, arch: process.arch, from: old.version, to: NEW, feed: FEED, home, port, results };

  // Where the app keeps its own Electron data (userData) and electron-updater its download cache —
  // removed at the end only when this run created them.
  const userDataDirs = {
    // Both names: an older build (G9, g9-desktop-updater) may be what this run installs first.
    win32: [...NAMES.map((n) => path.join(process.env.APPDATA ?? '', n)), path.join(process.env.LOCALAPPDATA ?? '', 'g9browseragent-updater'), path.join(process.env.LOCALAPPDATA ?? '', 'g9-desktop-updater')],
    darwin: [...NAMES.map((n) => path.join(os.homedir(), 'Library', 'Application Support', n)), path.join(os.homedir(), 'Library', 'Caches', 'g9browseragent-updater'), path.join(os.homedir(), 'Library', 'Caches', 'g9-desktop-updater')],
    linux: [...NAMES.map((n) => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), n)), path.join(os.homedir(), '.cache', 'g9browseragent-updater'), path.join(os.homedir(), '.cache', 'g9-desktop-updater')],
  }[PLATFORM].filter((d) => !fs.existsSync(d));

  try {
    // --- install the old version; say where updates come from (local feed) or nothing (official)
    inst.install(old.file);
    record('the older version installs silently', true, `${old.version} at ${inst.exe}`);
    const now = new Date().toISOString();
    // Updates start OFF with a local feed: the app checks at start, and each scenario must control
    // when the download happens. They are turned on the way a person does it — Settings, which saves
    // the daemon's settings through the app (main.mjs) and checks at once. With --feed official,
    // nothing is written: a fresh install with no update settings at all.
    const desktop = { wizard: { completedAt: now, steps: {} }, ...(feed ? { update: { mode: 'off', url: feed.url, channel: 'stable' } } : {}) };
    fs.writeFileSync(path.join(home, 'desktop.json'), JSON.stringify(desktop, null, 2));
    if (feed) fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ updateMode: 'off', updateUrl: feed.url }, null, 2));

    // An AI client registered the way G9 up to 3.2.0 did it: under 'g9-browser', naming this install.
    if (PLATFORM !== 'darwin') {
      const oldEntry = PLATFORM === 'win32'
        ? { type: 'stdio', command: fwd(inst.exe), args: [fwd(path.join(inst.root, 'resources', 'mcp', 'shim.mjs'))], env: { ELECTRON_RUN_AS_NODE: '1' } }
        : { type: 'stdio', command: fwd(inst.exe), args: [fwd(path.join(home, 'bin', 'g9-run.mjs')), 'mcp/shim.mjs', '--no-sandbox'], env: { ELECTRON_RUN_AS_NODE: '1' } };
      fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'g9-browser': oldEntry, other: { command: 'other-mcp' } }, projects: { keep: true } }, null, 2));
    }

    app = new App({ exe: inst.exe, env, cdpPort }).start();
    await app.connect();
    daemon = new DaemonClient({ port, version: 'e2e', clientName: 'g9-update-e2e', role: 'ui' });
    daemon.on('error', () => {});
    daemon.start();
    const welcome = await waitFor('the daemon the app started', async () => (daemon.connected ? daemon.welcome : null), { timeoutMs: 60_000 });
    record('the old app runs and starts its daemon', welcome.version === old.version, `app ${old.version}, daemon ${welcome.version}, G9_HOME ${home}`);

    // --- the extension, installed the way the wizard does it, in a real browser
    let ext = null;
    const found = mode === 'auto' ? await findBrowser() : null;
    if (found) {
      const r = await daemon.admin('extension.install', {});
      const extDir = r.path;
      // The daemon address for this disposable profile, BEFORE the extension's first line runs; it
      // is kept in the extension's storage, so the update's folder swap (which drops dev files) and
      // the reload keep this private port — never the default 8765.
      fs.writeFileSync(path.join(extDir, 'dev-daemon.json'), JSON.stringify({ host: '127.0.0.1', port }));
      browser = await startBrowser({ browser: found, extDir, profile: path.join(tmp, 'profile'), pageUrl: `${pageServer.url}page` });
      ext = await waitFor('the extension to connect', async () => {
        const st = await daemon.admin('state', {});
        return (st.engines ?? []).find((e) => e.kind === 'extension' && e.version) ?? null;
      }, { timeoutMs: 60_000 });
      record('the extension from G9_HOME/extension connects', ext.version === old.version, `${found.kind} ${found.version ?? ''} · extension ${ext.version} · ${extDir}`);
    } else if (mode === 'auto') {
      record('a browser for the extension checks', !process.env.CI, 'no Edge/Chrome found; the extension half is not tested here');
    }

    // Turn the local feed on the way Settings does (main.mjs saves it and checks at once when the
    // feed changed); re-saving the same feed also forgets a skipped version.
    const useFeed = () => app.invoke('admin', { op: 'settings.set', args: { patch: { updateMode: 'custom', updateUrl: feed.url } } });
    // electron-updater keeps a verified download in <cache>/pending and does not fetch it again.
    const updaterCache = {
      win32: path.join(env.LOCALAPPDATA ?? '', 'g9browseragent-updater'),
      darwin: path.join(os.homedir(), 'Library', 'Caches', 'g9browseragent-updater'),
      linux: path.join(env.XDG_CACHE_HOME ?? '', 'g9browseragent-updater'),
    }[PLATFORM];
    const clearDownloads = () => fs.rmSync(path.join(updaterCache, 'pending'), { recursive: true, force: true });
    const settled = (what) => app.waitUpdater(what, (x) => ['error', 'downloaded', 'skipped', 'up-to-date'].includes(x.status), 600_000);

    // --- manual installs (macOS): found, not downloaded, the release page named
    if (scenarios.includes('manual')) {
      if (feed) await useFeed();
      await app.invoke('updater.check');
      const s = await app.waitUpdater('available-manual', (x) => x.status === 'available-manual' || x.status === 'error', 120_000);
      record('manual: the new release is found', s.status === 'available-manual' && s.version === NEW, s.line);
      record('manual: the release page is named', typeof s.releaseUrl === 'string' && s.releaseUrl.startsWith(feed ? feed.url : 'https://github.com/'), s.releaseUrl);
      if (feed) {
        const downloads = feed.requests.filter((q) => /\.(zip|dmg|deb|AppImage|exe)$/.test(q.name));
        record('manual: nothing is downloaded', downloads.length === 0, `${feed.requests.length} request(s): ${[...new Set(feed.requests.map((q) => q.name))].join(', ')}`);
      }
      await app.invoke('updater.skip');
      const k = await app.updater();
      record('manual: "Skip this version" is remembered', k.skipped === NEW, k.line);
    }

    // --- a corrupted download is rejected, never installed
    if (scenarios.includes('corrupt')) {
      clearDownloads();
      feed.corrupt.add(installerName);
      await useFeed();
      const s = await settled('the corrupted download');
      feed.corrupt.delete(installerName);
      record('corrupt: a changed installer is rejected by its SHA-512', s.status === 'error' && /sha512|checksum/i.test(s.error ?? ''), s.error ?? s.line);
      record('corrupt: nothing was installed', inst.version() === old.version || (PLATFORM === 'linux' && inst.sameFileAs(old.file)), 'the old version is still installed');
    }

    // --- an interrupted download fails loudly and the next check completes it
    if (scenarios.includes('interrupted')) {
      clearDownloads();
      if (!scenarios.includes('corrupt')) await useFeed().then(() => settled('the first check'));
      clearDownloads();
      // Every connection for the installer drops after 5 MB (electron-updater retries on its own:
      // this makes all its attempts fail), then the connection is healthy again.
      feed.cut.set(installerName, { bytes: 5 * 1024 * 1024, times: 50 });
      await app.invoke('updater.check');
      const s = await settled('the interrupted download');
      const dropped = feed.cut.get(installerName)?.dropped ?? 0;
      feed.cut.delete(installerName);
      record('interrupted: dropped connections end in an error, not an install', s.status === 'error', `${s.error ?? s.line} (${dropped} connection(s) dropped)`);
      await app.invoke('updater.check');
      const d = await settled('the next download');
      record('interrupted: the next check downloads it', d.status === 'downloaded' && d.version === NEW, d.line);
    }

    // --- "Skip this version": not downloaded again, then offered again once the source is saved
    if (scenarios.includes('skip')) {
      if ((await app.updater()).status !== 'downloaded') {
        await useFeed();
        if (feed) await useFeed();
        await app.invoke('updater.check');
        await app.waitUpdater('downloaded', (x) => x.status === 'downloaded', 600_000);
      }
      await app.invoke('updater.skip');
      clearDownloads();
      const before = feed.count(installerName);
      await app.invoke('updater.check');
      const s = await settled('the check after skipping');
      record('skip: a skipped version is not downloaded again', s.status === 'skipped' && feed.count(installerName) === before, `${s.line} (installer requests ${before} → ${feed.count(installerName)})`);
      await useFeed();
      await app.invoke('updater.check');
      const d = await settled('the check after saving the source');
      record('skip: saving the update source offers it again', d.status === 'downloaded' && d.version === NEW, d.line);
    }

    // --- a busy daemon defers the install and says why
    if (scenarios.includes('busy')) {
      if ((await app.updater()).status !== 'downloaded') {
        if (feed) await useFeed();
        await app.invoke('updater.check');
        await app.waitUpdater('downloaded', (x) => x.status === 'downloaded', 600_000);
      }
      const launched = await daemon.call('browser_engine', { action: 'launch', headless: true, ...(opt('--browser') ? { browser: opt('--browser') } : {}) }, { timeoutMs: 120_000 }).catch((err) => ({ error: err.message }));
      if (launched?.error) {
        record('busy: a launched browser for the check', false, launched.error);
      } else {
        const r = await app.invoke('updater.install');
        record('busy: "Install now" waits while a launched browser is open', r.status === 'deferred' && (r.reasons ?? []).length > 0, (r.reasons ?? []).join('; ') || r.status);
        record('busy: nothing was installed meanwhile', inst.version() === old.version || (PLATFORM === 'linux' && inst.sameFileAs(old.file)), 'still the old version');
        await daemon.call('browser_engine', { action: 'stop', engineId: launched.engineId }, { timeoutMs: 60_000 }).catch(() => {});
      }
    }

    // --- the update itself: install when quitting, start again, and everything follows
    if (scenarios.includes('install')) {
      if (!['downloaded', 'deferred'].includes((await app.updater()).status)) {
        if (feed) await useFeed();
        await app.invoke('updater.check');
        await app.waitUpdater('downloaded', (x) => x.status === 'downloaded', 600_000);
      }
      await app.invoke('updater.installOnQuit');
      const quitAt = Date.now();
      await app.invoke('app.quit').catch(() => { /* the page goes away as it quits */ });
      await Promise.race([app.exited, delay(120_000)]);
      record('install: the app quits to install', app.child.exitCode !== null, `in ${Math.round((Date.now() - quitAt) / 1000)} s`);
      await waitFor('the new version on disk', () => (PLATFORM === 'linux' ? inst.sameFileAs(newInstaller) : inst.version() === NEW), { timeoutMs: 300_000, everyMs: 2000 });
      record('install: the installer replaced the app', true, `${inst.exe} is ${NEW}`);
      daemon.stop();
      await delay(1500);
      app = new App({ exe: inst.exe, env, cdpPort }).start();
      await app.connect();
      daemon = new DaemonClient({ port, version: 'e2e', clientName: 'g9-update-e2e', role: 'ui' });
      daemon.on('error', () => {});
      daemon.start();
      const w2 = await waitFor('the new daemon', async () => (daemon.connected && daemon.welcome?.version === NEW ? daemon.welcome : null), { timeoutMs: 120_000 });
      record('install: the restarted app runs the new daemon', w2.version === NEW, `daemon ${w2.version}`);
      const dlog = path.join(home, 'logs', 'desktop.log');
      const noted = await waitFor('the app to note the update', () => {
        const text = fs.existsSync(dlog) ? fs.readFileSync(dlog, 'utf8') : '';
        return text.includes(`Updated from ${old.version} to ${NEW}`) ? text : null;
      }, { timeoutMs: 60_000 });
      record('install: the app knows it was updated', !!noted, `desktop.log: "Updated from ${old.version} to ${NEW}"`);
      if (ext) {
        const ilog = path.join(home, 'logs', 'install.log');
        await waitFor('the extension folder refresh', () => fs.existsSync(ilog) && fs.readFileSync(ilog, 'utf8').includes('Extension refreshed after the app update'), { timeoutMs: 120_000 });
        const manifest = JSON.parse(fs.readFileSync(path.join(home, 'extension', 'manifest.json'), 'utf8'));
        record('install: G9_HOME/extension was refreshed in place', manifest.version === NEW, `${path.join(home, 'extension')} → ${manifest.version}`);
        const row = await waitFor('the extension to come back at the new version', async () => {
          const st = await daemon.admin('state', {});
          return (st.engines ?? []).find((e) => e.kind === 'extension' && e.version === NEW) ?? null;
        }, { timeoutMs: 120_000 });
        record('install: the extension reloaded and reconnected at the new version', !row.versionMismatch, `extension ${row.version}, no versionMismatch`);
        const status = await daemon.call('browser_status', {}, { timeoutMs: 60_000 });
        record('install: browser_status reports no version mismatch', !status?.versionMismatch, JSON.stringify(status?.versions ?? status?.version ?? '').slice(0, 160));
      }
      if (fs.existsSync(claudeJson)) {
        // 3.2.1: the AI client's entry follows the app — under its new name, starting what is installed now.
        const cfg = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
        const e = cfg.mcpServers?.g9browseragent;
        record('install: the AI client entry is "g9browseragent" and starts the installed app',
          !!e && !cfg.mcpServers['g9-browser'] && fwd(e.command) === fwd(inst.exe) && cfg.mcpServers.other?.command === 'other-mcp' && cfg.projects?.keep === true,
          e ? `${e.command} ${JSON.stringify(e.args)}` : JSON.stringify(Object.keys(cfg.mcpServers ?? {})));
      }
    }

    // --- a reload asked for while a call runs waits for that call
    if (scenarios.includes('reload-busy') && ext) {
      const tabs = await daemon.call('browser_tabs', { action: 'list' }, { timeoutMs: 60_000 });
      const tab = (tabs?.tabs ?? tabs ?? []).find((t) => String(t.url ?? '').includes('/page')) ?? (tabs?.tabs ?? tabs ?? [])[0];
      const before = (await daemon.admin('state', {})).engines.find((e) => e.kind === 'extension');
      const started = Date.now();
      let callDone = null;
      const call = daemon.call('browser_navigate', { action: 'goto', tabId: tab.tabId, url: `${pageServer.url}slow?ms=6000` }, { timeoutMs: 120_000 })
        .then((r) => { callDone = Date.now(); return r; }, (err) => { callDone = Date.now(); return { error: err.message }; });
      await delay(700);
      const reload = daemon.admin('extension.reload', {}, { timeoutMs: 120_000 });
      const [result] = await Promise.all([call, reload]);
      const back = await waitFor('the extension after the reload', async () => {
        const e = (await daemon.admin('state', {})).engines.find((x) => x.kind === 'extension');
        return e && e.connectedAt && e.connectedAt !== before.connectedAt ? e : null;
      }, { timeoutMs: 90_000 });
      const reconnectedAt = Date.parse(back.connectedAt) || Number(back.connectedAt);
      record('reload-busy: the navigation in flight completes', !result?.error, result?.error ?? `${Math.round((callDone - started) / 1000)} s`);
      record('reload-busy: the reload waits for it', reconnectedAt >= callDone, `call done +${callDone - started} ms, extension back +${reconnectedAt - started} ms`);
    }

    // --- the official feed: a fresh install finds the published release by itself
    if (scenarios.includes('official')) {
      await app.invoke('updater.check');
      const s = await app.waitUpdater('downloaded from GitHub', (x) => ['downloaded', 'error', 'up-to-date'].includes(x.status), 900_000);
      record('official: with no update settings, the app checks the official GitHub releases', s.source === 'official' && /github\.com\/ImanKari\/G9BrowserAgent/.test(s.url ?? ''), s.url);
      record('official: the published release is downloaded (SHA-512 checked by the updater)', s.status === 'downloaded' && s.version === NEW, s.line);
      if (s.status === 'downloaded') {
        await app.invoke('updater.installOnQuit');
        await app.invoke('app.quit').catch(() => {});
        await Promise.race([app.exited, delay(120_000)]);
        await waitFor('the new version on disk', () => (PLATFORM === 'linux' ? inst.sameFileAs(newInstaller) : inst.version() === NEW), { timeoutMs: 300_000, everyMs: 2000 });
        daemon.stop();
        await delay(1500);
        app = new App({ exe: inst.exe, env, cdpPort }).start();
        await app.connect();
        const after = await app.invoke('state');
        record('official: the app restarts as the published version', after?.app?.version === NEW, `app ${after?.app?.version}`);
      }
    }
  } catch (err) {
    record('the run itself', false, String(err?.stack ?? err).split('\n').slice(0, 4).join(' | '));
    if (app?.output) console.log(`--- app output (tail) ---\n${app.output.slice(-3000)}`);
  } finally {
    // Stop everything this run started, then uninstall.
    try { await daemon?.admin('shutdown', {}, { timeoutMs: 10_000 }); } catch { /* it may be gone */ }
    daemon?.stop();
    await app?.kill();
    killTree(browser);
    await delay(2000);
    inst.uninstall();
    await feed?.stop();
    if (pageServer !== feed) await pageServer.stop();
    for (const fn of cleanups) try { await fn(); } catch { /* best effort */ }
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    console.log(`\nreport: ${REPORT}`);
    if (!KEEP) {
      for (const d of userDataDirs) fs.rmSync(d, { recursive: true, force: true });
      // Windows keeps a folder a just-killed process had open for a moment: retry, never fail the run on it.
      for (let i = 0; i < 30 && fs.existsSync(tmp); i++) {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { await delay(1000); }
      }
      if (fs.existsSync(tmp)) console.log(`(could not remove ${tmp}; remove it by hand)`);
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nupdate e2e: ${results.length - failed.length} passed, ${failed.length} failed (${PLATFORM}, ${old.version} → ${NEW}, ${FEED} feed)`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
