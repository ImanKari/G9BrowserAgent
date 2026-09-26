/**
 * Source guards for the rules that no unit test of behaviour can see:
 * the shell is never an engine (D4), the page loads nothing remote, the IPC surface stays small,
 * approvals keep `by` in the main process, and every version is the one version.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './harness.mjs';

const t = suite('desktop: source guards');
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(app, p), 'utf8');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(app, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}
const runtimeFiles = ['main.mjs', 'preload.cjs', ...walk('lib'), ...walk('renderer')];

/** Code without comments: the comments explain the rules and may name what is banned. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1').replace(/<!--[\s\S]*?-->/g, '');

t.test('never an engine: no BrowserView, WebContentsView, <webview>, webviewTag, or offscreen pages', () => {
  for (const f of runtimeFiles) {
    const src = code(read(f));
    for (const banned of ['BrowserView', 'WebContentsView', 'webviewTag: true', 'offscreen: true', '<webview']) {
      assert.ok(!src.includes(banned), `${f} mentions ${banned}`);
    }
  }
});

t.test('the only page Electron loads is the app\'s own renderer, over g9app://app/', () => {
  const main = read('main.mjs');
  const loads = [...main.matchAll(/\.(loadURL|loadFile)\(([^)]*)\)/g)].map((m) => m[2].trim());
  assert.deepEqual(loads, ["'g9app://app/index.html'"]);
  assert.match(main, /will-attach-webview/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /nodeIntegration: false/);
});

t.test('the page loads nothing remote: CSP meta, no external src/href, no network APIs in the renderer', () => {
  const html = read('renderer/index.html');
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.ok(!/(src|href)="https?:/i.test(html), 'no remote script, style or font');
  for (const f of walk('renderer')) {
    const src = read(f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|new WebSocket|EventSource|importScripts/.test(src), `${f} uses a network API`);
    assert.ok(!/fonts\.googleapis|cdn\.|unpkg|jsdelivr/.test(src), `${f} references a CDN`);
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/.test(src), `${f} parses strings as HTML`);
  }
});

t.test('the preload exposes one object with invoke/on and nothing else', () => {
  const pre = read('preload.cjs');
  assert.equal((pre.match(/exposeInMainWorld\(/g) ?? []).length, 1);
  assert.match(pre, /exposeInMainWorld\('g9', \{/);
  assert.ok(!/require\('(fs|child_process|path|os|node:)/.test(pre), 'no Node module reaches the page');
});

t.test('every topic a view subscribes to and main pushes is in the preload allowlist', () => {
  // g9.on() throws for a topic the preload does not list; a view subscribing in mount() then stops
  // half-mounted in the real window (the Watch view and 'watchStatus', found by --check-render).
  const listed = new Set(JSON.parse(read('preload.cjs').match(/const TOPICS = new Set\((\[[^\]]*\])\)/)[1].replace(/'/g, '"')));
  const subscribed = new Set();
  for (const f of walk('renderer')) {
    for (const m of code(read(f)).matchAll(/\b(?:api|bridge|g9)\.on\(\s*'([A-Za-z]+)'/g)) subscribed.add(m[1]);
  }
  const main = code(read('main.mjs'));
  const pushed = new Set([...main.matchAll(/\bpush\(\s*'([A-Za-z]+)'/g)].map((m) => m[1]));
  // Daemon event topics main passes straight through as push(topic, data): the case labels of
  // the switch arm that ends in that call.
  for (const m of main.matchAll(/push\(topic, data\)/g)) {
    const before = main.slice(Math.max(0, m.index - 600), m.index);
    const arm = before.slice(Math.max(before.lastIndexOf('return;'), before.lastIndexOf('break;')) + 1);
    for (const x of arm.matchAll(/case '([A-Za-z]+)':/g)) pushed.add(x[1]);
  }
  assert.ok(subscribed.has('state') && subscribed.has('watchStatus'), `found the subscriptions: ${[...subscribed]}`);
  for (const topic of subscribed) assert.ok(listed.has(topic), `a view subscribes to '${topic}', which the preload does not allow`);
  for (const topic of pushed) assert.ok(listed.has(topic), `main pushes '${topic}', which the preload drops`);
  for (const topic of subscribed) assert.ok(pushed.has(topic), `a view waits for '${topic}', which main never pushes`);
});

t.test('every class the renderer puts on an element has a rule in styles.css (or is a named JS hook)', () => {
  // A class with no rule is invisible to every fake-DOM test and shows only in pixels: Schedule's
  // "last result" <button class="chip-link"> had none and kept Chromium's grey button face in the
  // dark scheme (render check, round 3). Classes that only exist for querySelector are listed here.
  const hooks = new Set(['login-hint', 'mark-done', 'mark-skip', 'step-status']);
  const notClasses = new Set(['different']); // a status compared inside a class expression (setup.js)
  const css = read('renderer/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const defined = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  const missing = [];
  for (const f of walk('renderer').filter((x) => /\.(js|html)$/.test(x))) {
    const src = read(f);
    const found = new Set();
    for (const m of src.matchAll(/class(?:Name)?\s*[:=]\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/g)) {
      for (const lit of m[1].matchAll(/['"]([^'"]*)['"]/g)) for (const c of lit[1].split(/\s+/)) if (/^[A-Za-z][\w-]*$/.test(c)) found.add(c);
    }
    for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\(\s*'([\w-]+)'/g)) found.add(m[1]);
    for (const c of found) if (!defined.has(c) && !hooks.has(c) && !notClasses.has(c)) missing.push(`${c} (${f})`);
  }
  assert.deepEqual(missing, [], 'classes with no CSS rule');
});

t.test('approval: the page cannot supply `by`; browser_recording approve is only reachable through main', () => {
  const main = read('main.mjs');
  assert.match(main, /browser_recording: new Set\(\['list', 'get', 'known_world'\]\)/);
  assert.match(main, /approvalArgs\(\{ flowId, by: user, note, runId, engine, expectLastRunAt \}\)/);
  const approvals = read('renderer/views/approvals.js');
  assert.ok(!/by:/.test(approvals.replace(/approved by/gi, '')), 'the approvals view never sends a `by`');
  assert.ok(!/setInterval|setTimeout\([^)]*approve/.test(approvals), 'nothing approves on a timer');
});

t.test('HKLM is never written: the only reg writes go through the HKCU guard', () => {
  for (const f of runtimeFiles) {
    const src = read(f);
    if (f.endsWith('policies.mjs')) continue;
    assert.ok(!/reg(\.exe)?['"]?\s*,\s*\[\s*['"](add|delete)/i.test(src), `${f} runs reg add/delete outside policies.mjs`);
  }
  const pol = read('lib/policies.mjs');
  assert.match(pol, /HKCU\\\\Software\\\\Policies\\\\Microsoft\\\\Edge/);
  assert.match(pol, /HKCU\\\\Software\\\\Policies\\\\Google\\\\Chrome/);
});

t.test('one version: desktop, the root package.json and the extension manifest agree (no literal pinned here)', () => {
  const pkg = JSON.parse(read('package.json'));
  // The owner bumps the version on every change, so this test compares the files with each other
  // instead of pinning a number — pinning 2.0.0 made the 2.0.1 bump fail three suites.
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'semver');
  assert.equal(pkg.name, 'g9-desktop');
  assert.equal(pkg.productName, 'G9');
  assert.equal(pkg.main, 'main.mjs');
  assert.equal(pkg.type, 'module');
  assert.deepEqual(Object.keys(pkg.dependencies), ['electron-updater']);
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['electron', 'electron-builder']);
  for (const other of ['../package.json', '../extension/manifest.json']) {
    const p = path.join(app, other);
    if (!fs.existsSync(p)) continue;
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
    assert.equal(v, pkg.version, `${other} is ${v}`);
  }
});

t.test('package config: Windows per user and assisted; macOS dmg+zip for both archs, ad-hoc; Linux AppImage+deb; the official GitHub feed; resources packed', () => {
  const yml = read('electron-builder.yml');
  for (const line of [
    'appId: com.g9.browseragent', 'productName: G9', 'oneClick: false', 'perMachine: false', 'allowToChangeInstallationDirectory: false',
    'artifactName: G9-Setup-${version}.exe', 'executableName: G9', 'include: build/installer.nsh',
    // macOS: the zip is what latest-mac.yml describes; both archs; no Developer ID, so ad-hoc.
    'target: dmg', 'target: zip', 'arch: [x64, arm64]', "identity: '-'", 'artifactName: G9-${version}-mac-${arch}.${ext}',
    // Linux: the AppImage is the one that updates itself; the .deb installs to /opt/G9.
    'target: AppImage', 'target: deb', 'executableName: g9', 'artifactName: G9-x86_64.${ext}', 'artifactName: G9_${version}_amd64.${ext}',
    // Every build writes latest*.yml and app-update.yml for the official releases.
    'provider: github', 'owner: ImanKari', 'repo: G9BrowserAgent',
  ]) {
    assert.ok(yml.includes(line), `electron-builder.yml has "${line}"`);
  }
  assert.ok(!yml.includes('provider: generic'), 'a self-hosted feed is a build option (G9_UPDATE_URL), not the default');
  for (const r of ['../extension', '../engine', '../daemon', '../mcp', '../runner', '../lib', '../package.json']) {
    assert.ok(yml.includes(`from: ${r}`), `extraResources copies ${r}`);
  }
  assert.match(read('build/installer.nsh'), /isForceCurrentInstall "1"/);
});

t.test('the app shows its version: window title, rail badge and tray tooltip', () => {
  const main = read('main.mjs');
  assert.match(main, /title: `G9 \$\{version\}`/);
  assert.match(main, /setToolTip\(`G9 \$\{version\}/);
  assert.match(read('renderer/index.html'), /id="app-version"/);
});

t.run();
