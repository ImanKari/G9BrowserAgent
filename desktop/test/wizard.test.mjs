import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite, tmpDir, rmrf } from './harness.mjs';
import { Wizard, WIZARD_STEPS, STEP_IDS } from '../lib/wizard.mjs';
import { DesktopSettings } from '../lib/settings.mjs';
import { createLogger, tailLog } from '../lib/log.mjs';
import { homeLayout, resourcePaths } from '../lib/paths.mjs';
import { mcpClients } from '../lib/mcp-register.mjs';
import { threeClicks, extensionsPageCommand, browserCandidates, installExtensionLocal } from '../lib/extension-install.mjs';

const t = suite('desktop: first-run wizard');
const root = tmpDir();
t.cleanup(() => rmrf(root));
const home = path.join(root, 'G9');
const layout = homeLayout(home);
const res = path.join(root, 'resources');
fs.mkdirSync(path.join(res, 'extension'), { recursive: true });
fs.writeFileSync(path.join(res, 'extension', 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '2.0.0' }));
fs.writeFileSync(path.join(res, 'extension', 'sw.js'), '// sw');
fs.writeFileSync(path.join(res, 'extension', 'dev-daemon.json'), '{}');
const userHome = path.join(root, 'user');
const appData = path.join(root, 'AppData', 'Roaming');
fs.mkdirSync(path.join(userHome, '.cursor'), { recursive: true });

function fakeClient({ connected = true } = {}) {
  const calls = [];
  return {
    calls,
    connected,
    admin: async (op, args) => {
      calls.push([op, args]);
      switch (op) {
        case 'engines.versions':
          return { browsers: [{ kind: 'edge', path: 'C:/Edge/msedge.exe', version: '153.0.1' }], pinned: { version: '153.0.7000.0' }, cft: [] };
        case 'engines.installCft':
          return { version: args.version, path: 'G9/engines/cft/chrome.exe' };
        case 'profiles.list':
          return { profiles: [{ name: 'automation', dir: 'G9/profiles/automation' }] };
        case 'profiles.warm':
          return { ok: true, pid: 1234 };
        case 'extension.install':
          fs.cpSync(path.join(res, 'extension'), layout.extension, { recursive: true });
          return { path: layout.extension, version: '2.0.0', reloaded: true };
        default:
          throw new Error(`unexpected ${op}`);
      }
    },
  };
}

function wizard(over = {}) {
  const clip = [];
  const spawned = [];
  const w = new Wizard({
    client: over.client ?? fakeClient(),
    settings: new DesktopSettings(layout.desktopJson),
    log: createLogger(layout.installLog),
    layout,
    resources: resourcePaths(res),
    // Pinned to Windows: the registry policies and the msedge.exe paths are Windows facts, and this
    // suite also runs on macOS and Linux agents.
    app: { isPackaged: true, execPath: 'C:/Programs/G9/G9.exe', resourceRoot: res, port: 8765, homeOverride: null, platform: 'win32' },
    deps: {
      clipboardWrite: (x) => clip.push(x),
      spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { on() {}, unref() {} }; },
      regRun: async (args) => (args[0] === 'query' ? { code: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' } : { code: 0, stdout: '', stderr: '' }),
      findBrowsers: async () => [{ kind: 'edge', path: 'C:/Edge/msedge.exe' }, { kind: 'chrome', path: 'C:/Chrome/chrome.exe' }],
      clients: () => mcpClients({ home: userHome, appData }),
      user: () => 'qa1',
    },
    ...over.ctor,
  });
  return { w, clip, spawned };
}

t.test('five steps in the documented order, none done at first', () => {
  const { w } = wizard();
  assert.deepEqual(STEP_IDS, ['browsers', 'profile', 'policies', 'mcp', 'extension']);
  assert.equal(WIZARD_STEPS.length, 5);
  const s = w.state();
  assert.equal(s.completedAt, null);
  assert.ok(s.steps.every((x) => x.outcome === null));
});

t.test('1. browsers: the daemon\'s list first, the desktop\'s own probe fills gaps; CfT pinned vs installed', async () => {
  const { w } = wizard();
  const r = await w.browsers();
  assert.equal(r.source, 'daemon');
  assert.deepEqual(r.browsers.map((b) => [b.kind, b.version]), [['edge', '153.0.1'], ['chrome', null]]);
  assert.equal(r.cft.pinned, '153.0.7000.0');
  assert.equal(r.cft.pinnedInstalled, false);
  const c = fakeClient();
  const w2 = wizard({ client: c }).w;
  await w2.installCft('153.0.7000.0');
  assert.deepEqual(c.calls.at(-1), ['engines.installCft', { version: '153.0.7000.0' }]);
  const offline = wizard({ client: fakeClient({ connected: false }) }).w;
  assert.equal((await offline.browsers()).source, 'desktop');
  await assert.rejects(offline.installCft(), /needs the G9 daemon/);
});

t.test('2. profile: listed through the daemon; warm opens it headed, and only for an http(s) sign-in page', async () => {
  const c = fakeClient();
  const { w } = wizard({ client: c });
  const p = await w.profile();
  assert.equal(p.automation.name, 'automation');
  await w.warmProfile({ url: 'https://app.example/login' });
  assert.deepEqual(c.calls.at(-1), ['profiles.warm', { name: 'automation', url: 'https://app.example/login' }]);
  await assert.rejects(w.warmProfile({ url: 'javascript:alert(1)' }), /http\(s\)/);
});

t.test('3. policies: status and apply go through the injected reg runner and the G9_HOME record', async () => {
  const { w } = wizard();
  const s = await w.policies();
  assert.equal(s.total, 10);
  assert.equal(s.appliedCount, 0);
  const r = await w.applyPolicies();
  // The fake runner accepts writes but its queries never see them, so verification must fail —
  // exactly the "did not take effect" case, which must not be reported as success.
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(layout.policiesJson), 'previous values recorded under G9_HOME/logs');
});

t.test('4. MCP: detected clients with their plan (no whole-file text sent to the page); register writes the packaged entry', () => {
  const { w } = wizard();
  const m = w.mcp();
  assert.deepEqual(m.entry, { command: 'C:/Programs/G9/G9.exe', args: [`${res.replace(/\\/g, '/')}/mcp/shim.mjs`], env: { ELECTRON_RUN_AS_NODE: '1' } });
  const cursor = m.clients.find((c) => c.id === 'cursor');
  assert.equal(cursor.installed, true);
  assert.equal(cursor.status, 'create');
  assert.ok(!('nextText' in cursor));
  const r = w.registerMcp('cursor');
  assert.equal(r.ok, true);
  assert.equal(w.mcp().clients.find((c) => c.id === 'cursor').status, 'same');
  assert.throws(() => w.registerMcp('nope'), /Unknown AI client/);
});

t.test('5. extension: installed by the daemon, path on the clipboard; the page opens with msedge.exe edge://extensions', async () => {
  const { w, clip, spawned } = wizard();
  const info = await w.extension();
  assert.equal(info.target, layout.extension);
  assert.equal(info.sourceVersion, '2.0.0');
  assert.equal(info.installedVersion, null);
  const r = await w.installExtension();
  assert.equal(r.via, 'daemon');
  assert.equal(r.clipboard, true);
  assert.deepEqual(clip, [layout.extension]);
  const o = await w.openExtensionsPage('edge');
  assert.deepEqual(spawned.at(-1).cmd, 'C:/Edge/msedge.exe');
  assert.deepEqual(spawned.at(-1).args, ['edge://extensions']);
  assert.equal(spawned.at(-1).opts.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.deepEqual(o.clicks, threeClicks('edge', 'win32'), 'this wizard is the Windows one (app.platform)');
  await w.openExtensionsPage('chrome');
  assert.deepEqual(spawned.at(-1).args, ['chrome://extensions']);
});

t.test('5. extension without a daemon: the desktop copies atomically, without dev override files', async () => {
  const target = path.join(root, 'local-ext');
  const r1 = installExtensionLocal({ from: path.join(res, 'extension'), target });
  assert.equal(r1.version, '2.0.0');
  assert.ok(fs.existsSync(path.join(target, 'sw.js')));
  assert.ok(!fs.existsSync(path.join(target, 'dev-daemon.json')), 'dev-daemon.json is not copied');
  fs.writeFileSync(path.join(res, 'extension', 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '2.0.1' }));
  const r2 = installExtensionLocal({ from: path.join(res, 'extension'), target });
  assert.equal(r2.version, '2.0.1', 'refreshed in place: same folder, new files');
  assert.ok(!fs.readdirSync(root).some((f) => f.startsWith('local-ext.')), 'no staging or old folder left');
  assert.throws(() => installExtensionLocal({ from: path.join(root, 'nothing'), target }), /manifest\.json missing/);
  const { w, clip } = wizard({ client: fakeClient({ connected: false }) });
  const r = await w.installExtension();
  assert.equal(r.via, 'desktop');
  assert.equal(clip[0], layout.extension);
});

t.test('5. extension: the folder is the DAEMON\'s G9_HOME/extension when the daemon runs with another home', async () => {
  const daemonExt = path.join(root, 'daemon-home', 'extension');
  const clip = [];
  const w = new Wizard({
    client: fakeClient({ connected: false }),
    settings: new DesktopSettings(layout.desktopJson),
    log: createLogger(layout.installLog),
    layout,
    resources: resourcePaths(res),
    // Pinned to Windows: the registry policies and the msedge.exe paths are Windows facts, and this
    // suite also runs on macOS and Linux agents.
    app: { isPackaged: true, execPath: 'C:/Programs/G9/G9.exe', resourceRoot: res, port: 8765, homeOverride: null, platform: 'win32' },
    deps: { clipboardWrite: (x) => clip.push(x), findBrowsers: async () => [], extensionDir: () => daemonExt },
  });
  const info = await w.extension();
  assert.equal(info.target, daemonExt, 'what the page shows is where the daemon installs');
  const r = await w.installExtension();
  assert.equal(r.path, daemonExt);
  assert.deepEqual(clip, [daemonExt], 'the clipboard gets the folder the browser must load');
  assert.ok(fs.existsSync(path.join(daemonExt, 'manifest.json')));
});

t.test('extensions page command and browser candidates', () => {
  assert.deepEqual(extensionsPageCommand('chrome', 'C:/c.exe'), { command: 'C:/c.exe', args: ['chrome://extensions'] });
  assert.throws(() => extensionsPageCommand('edge', null), /Microsoft Edge was not found/);
  assert.throws(() => extensionsPageCommand('firefox', 'x'), /Unknown browser/);
  const c = browserCandidates({ ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\L' }, { platform: 'win32' });
  assert.ok(c.some((x) => x.kind === 'edge' && x.path === path.join('C:\\PF86', 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
  assert.ok(c.some((x) => x.kind === 'chrome' && x.path === path.join('C:\\L', 'Google', 'Chrome', 'Application', 'chrome.exe')));
  assert.equal(threeClicks('chrome', 'win32').length, 3);
});

t.test('macOS and Linux: browsers are found where they install, and the picker steps are that OS\'s', () => {
  const mac = browserCandidates({}, { platform: 'darwin', home: '/Users/qa' });
  assert.ok(mac.some((x) => x.kind === 'chrome' && x.path === path.join('/Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')));
  assert.ok(mac.some((x) => x.kind === 'edge' && x.path === path.join('/Users/qa', 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge')), 'a per-user install (~/Applications)');
  const linux = browserCandidates({}, { platform: 'linux' });
  assert.ok(linux.some((x) => x.kind === 'chrome' && x.path === '/usr/bin/google-chrome'));
  assert.ok(linux.some((x) => x.kind === 'edge' && x.path === '/usr/bin/microsoft-edge'));
  assert.match(threeClicks('chrome', 'darwin')[2], /Cmd\+Shift\+G/);
  assert.match(threeClicks('edge', 'linux')[2], /Ctrl\+L/);
  assert.match(threeClicks('edge', 'win32')[2], /Select Folder/);
});

t.test('3. policies on macOS and Linux: not applicable, said plainly, and nothing runs reg.exe', async () => {
  const ran = [];
  for (const platform of ['darwin', 'linux']) {
    const { w } = wizard({ ctor: { app: { isPackaged: true, execPath: '/opt/G9/g9', resourceRoot: res, port: 8765, homeOverride: null, platform } } });
    w.deps.regRun = async (args) => { ran.push(args); return { code: 0, stdout: '', stderr: '' }; };
    const r = await w.policies();
    assert.equal(r.applicable, false);
    assert.match(r.reason, /Windows registry policies/);
    await assert.rejects(() => w.applyPolicies(), /Windows-only/);
    await assert.rejects(() => w.undoPolicies(), /Windows-only/);
  }
  assert.deepEqual(ran, [], 'no registry command on a non-Windows machine');
});

t.test('4. MCP on macOS: an app running from App Translocation or the disk image is not registered (the path dies next start)', () => {
  const translocated = '/private/var/folders/xy/T/AppTranslocation/1234-ABCD/d/G9.app/Contents/MacOS/G9';
  const { w } = wizard({ ctor: { app: { isPackaged: true, execPath: translocated, resourceRoot: res, port: 8765, homeOverride: null, platform: 'darwin' } } });
  assert.match(w.mcp().blocked, /App Translocation/);
  assert.throws(() => w.registerMcp('claude-code'), /Applications folder/);
  const fromImage = wizard({ ctor: { app: { isPackaged: true, execPath: '/Volumes/G9 3.1.0/G9.app/Contents/MacOS/G9', resourceRoot: res, port: 8765, homeOverride: null, platform: 'darwin' } } });
  assert.match(fromImage.w.mcp().blocked, /disk image/);
  const installed = wizard({ ctor: { app: { isPackaged: true, execPath: '/Applications/G9.app/Contents/MacOS/G9', resourceRoot: res, port: 8765, homeOverride: null, platform: 'darwin' } } });
  assert.equal(installed.w.mcp().blocked, null);
});

t.test('marking steps completes the wizard; everything is in install.log', () => {
  const { w } = wizard();
  for (const id of STEP_IDS) w.mark(id, { ok: true, summary: `${id} ok` });
  assert.ok(w.state().completedAt);
  assert.throws(() => w.mark('bogus', { ok: true }), /Unknown setup step/);
  const log = tailLog(layout.installLog, 500).join('\n');
  for (const needle of ['Setup: browsers detected', 'installing Chrome for Testing', 'opening the profile headed', 'Policies: previous values recorded', 'MCP Cursor: registered', 'extension path copied to the clipboard', 'opened the extensions page', 'Setup step "extension": done']) {
    assert.ok(log.includes(needle), `install.log mentions "${needle}"`);
  }
});

t.run();
