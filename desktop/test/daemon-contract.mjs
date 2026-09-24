/**
 * Live contract check: the desktop's own client, normalizers, wizard and `--smoke` against the REAL
 * g9d of this repository (DAEMON_PROTOCOL.md), not the fake one the unit tests use.
 *
 * Not part of `npm test` on purpose: the unit tests never depend on another package's code. Run it
 * with `npm run test:daemon` once daemon/ is in place. Same convention as the tests (`  PASS name`,
 * exit 1 on the first failure). Safety:
 *   - a fresh temp G9_HOME and a random port in 18000-18999, never 8765;
 *   - the daemon is started here (`--foreground`, so it cannot idle-exit under a slow step) and shut
 *     down through admin `shutdown`; the one it restarts by itself (restartDaemonIfIdle →
 *     DaemonLauncher, exactly the app's path) gets G9_IDLE_EXIT_MS as a safety net and is shut down
 *     too; any process of ours still alive at the end is killed by pid (only ours);
 *   - no browser is launched (no engine launch, no warm, no schedule run).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { suite, freePort, tmpDir, rmrf, until } from './harness.mjs';
import { DaemonClient } from '../lib/daemon-client.mjs';
import { DaemonLauncher, probeHealth, queryActivity, activityFromHealth, restartDaemonIfIdle, waitForPortFree } from '../lib/daemon-launch.mjs';
import { resourceRoot, resourcePaths, homeLayout } from '../lib/paths.mjs';
import { DesktopSettings } from '../lib/settings.mjs';
import { feedConfig } from '../lib/updater.mjs';
import { Wizard } from '../lib/wizard.mjs';
import { createLogger } from '../lib/log.mjs';
import { buildSettingsPatch, readField, SETTINGS_FIELDS, pickUpdateConfig } from '../renderer/lib/settings-form.js';
import { normalizeAgent, normalizeEngine, normalizeTab, normalizeVersions, pickList } from '../renderer/lib/engines.js';
import { buildScheduleEntry, scheduleRows, describeWhen, lastResult } from '../renderer/lib/schedule.js';
import { runRows, normalizeRun } from '../renderer/lib/runs.js';

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(APP_DIR, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
const G9D = path.join(REPO, 'daemon', 'g9d.mjs');

if (!fs.existsSync(G9D)) {
  console.log(`desktop: live daemon contract — SKIPPED: ${G9D} does not exist`);
  process.exit(0);
}

const t = suite('desktop: live contract with the repository\'s g9d (temp G9_HOME, port 18000-18999)');
const home = tmpDir('g9-desktop-contract-');
const port = await freePort();
process.env.G9_HOME = home;
process.env.G9_PORT = String(port);
// A daemon the launcher starts detached must never outlive this script for long.
process.env.G9_IDLE_EXIT_MS = '20000';
delete process.env.ELECTRON_RUN_AS_NODE;

const ours = new Set(); // pids this script started
let daemon = null;
let client = null;
const events = [];

t.cleanup(async () => {
  client?.stop();
  for (const pid of ours) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
  await waitForPortFree(port, { timeoutMs: 5000 }).catch(() => {});
  rmrf(home);
});

function connect() {
  const c = new DaemonClient({ port, version: VERSION, clientName: 'g9-desktop-contract', backoff: { initialMs: 200, maxMs: 1000 } });
  c.on('event', (e) => events.push(e));
  c.start();
  return c;
}

t.test('the daemon starts on the temp home and answers /health as g9d', async () => {
  daemon = spawn(process.execPath, [G9D, '--foreground', '--port', String(port), '--home', home], {
    cwd: REPO, env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  ours.add(daemon.pid);
  let stderr = '';
  daemon.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const h = await until(async () => {
    if (daemon.exitCode !== null) throw new Error(`g9d exited with ${daemon.exitCode}: ${stderr}`);
    const r = await probeHealth(port);
    return r.status === 'g9d' ? r : null;
  }, { timeoutMs: 15_000, intervalMs: 150, what: 'g9d /health' });
  assert.equal(h.body.version, VERSION);
  assert.equal(path.resolve(h.body.home).toLowerCase(), path.resolve(home).toLowerCase());
});

t.test('hello as role ui → welcome with a ui id, the daemon version, its home and the halt state', async () => {
  client = connect();
  const w = await client.whenConnected(10_000);
  assert.match(w.id, /^ui-\d+$/);
  assert.equal(w.version, VERSION);
  assert.equal(path.resolve(w.home).toLowerCase(), path.resolve(home).toLowerCase());
  assert.equal(client.state.halted.global, false);
});

t.test('settings.get/set: every form field reads from the daemon; update URL + channel round-trip', async () => {
  const s = await client.admin('settings.get');
  // updateChannel is a daemon setting now (F6), so every field — the channel included — is read.
  const missing = SETTINGS_FIELDS.filter((f) => !readField(s, f).present).map((f) => f.key);
  assert.equal(s.updateChannel, 'stable', 'the daemon\'s default channel');
  assert.deepEqual(missing, [], 'the form knows every daemon key it shows');
  const { patch, changed } = buildSettingsPatch(s, { updateUrl: 'https://updates.example.test/g9', updateChannel: 'beta', evidenceMaxMB: 100 });
  assert.deepEqual(changed.sort(), ['evidenceMaxMB', 'updateChannel', 'updateUrl']);
  await client.admin('settings.set', { patch });
  const after = await client.admin('settings.get');
  assert.equal(after.evidence.maxBytes, 100 * 1024 * 1024);
  assert.equal(after.evidence.keepRuns, s.evidence.keepRuns, 'evidence merges one level deep');
  const cfg = pickUpdateConfig(after, {});
  assert.deepEqual(cfg, { url: 'https://updates.example.test/g9', channel: 'beta', source: 'daemon' });
  assert.deepEqual(feedConfig(cfg), { provider: 'generic', url: 'https://updates.example.test/g9/', channel: 'beta' });
  await client.admin('settings.set', { patch: { updateUrl: null, updateChannel: null } });
  assert.equal(pickUpdateConfig(await client.admin('settings.get'), {}).url, '');
  await assert.rejects(client.admin('settings.set', { patch: { stealth: 'sideways' } }), /stealth/i, 'a bad value is refused by name');
  // F6: a feed electron-updater cannot use is refused when it is saved, not on every QA machine later.
  await assert.rejects(client.admin('settings.set', { patch: { updateUrl: 'file:///C:/updates/' } }), /file:\/\/ URL[\s\S]*http\(s\)/);
  await assert.rejects(client.admin('settings.set', { patch: { updateChannel: 'nightly' } }), /updateChannel must be one of stable, beta/);
});

t.test('admin state normalises for the first render', async () => {
  const st = await client.admin('state');
  assert.ok(Array.isArray(st.agents) && Array.isArray(st.engines) && Array.isArray(st.tabs));
  st.agents.map(normalizeAgent);
  st.engines.map(normalizeEngine);
  st.tabs.map(normalizeTab);
  assert.equal(typeof st.halted.halted, 'boolean');
  assert.equal(st.daemon.name, 'g9d');
});

t.test('Stop all / Resume: the halt event reaches the UI and folds into the connection state', async () => {
  events.length = 0;
  await client.admin('halt');
  await until(() => client.state.halted.global === true, { what: 'global halt in the UI state' });
  assert.equal(client.state.halted.by, 'desktop');
  assert.ok(events.some((e) => e.topic === 'halt'));
  const status = await client.call('browser_status', {});
  assert.equal(status.halted.global, true, 'browser_status answers while halted');
  await client.admin('resume');
  await until(() => client.state.halted.global === false, { what: 'resume in the UI state' });
});

t.test('runs.list and the updater\'s idle check: an empty daemon is idle', async () => {
  const runs = runRows(await client.admin('runs.list', { limit: 10 })).map(normalizeRun);
  assert.ok(Array.isArray(runs));
  const activity = await queryActivity(client);
  assert.equal(activity.busy, false, activity.reasons.join('; '));
  // F6: the active-only list, /health and admin state all report the open runs.
  assert.deepEqual(runRows(await client.admin('runs.list', { active: true })), []);
  const h = await probeHealth(port);
  assert.deepEqual(h.body.activeRuns, []);
  assert.equal(h.body.launched, 0);
  assert.equal(activityFromHealth(h.body).busy, false);
  assert.deepEqual((await client.admin('state')).activeRuns, []);
});

t.test('schedule: add in the desktop\'s words, list, runNow/remove address the entry by entryId', async () => {
  const entry = buildScheduleEntry({ target: 'suite:contract', name: 'Contract check', env: 'staging', mode: 'daily', at: '06:30', browser: 'edge', headless: true, humanize: 'stealth', stealth: 'off', profile: 'automation' });
  const saved = await client.admin('schedule.add', { entry });
  assert.match(saved.id, /\S/);
  assert.deepEqual(saved.args, entry.args, 'explicit args win; nothing derived twice');
  const rows = scheduleRows(await client.admin('schedule.list'));
  const row = rows.find((r) => r.id === saved.id);
  assert.ok(row, 'listed');
  assert.equal(row.suite, 'suite:contract');
  assert.equal(row.at, '06:30');
  assert.equal(row.env, 'staging');
  assert.equal(describeWhen(row), 'Daily at 06:30');
  assert.deepEqual(lastResult(row), { label: 'Never ran', tone: '' });
  assert.ok(Number.isFinite(row.nextRunAt));
  await assert.rejects(client.admin('schedule.runNow', { entryId: 'sch_does_not_exist' }), /sch_does_not_exist/);
  assert.deepEqual(await client.admin('schedule.remove', { entryId: saved.id }), { removed: saved.id });
  assert.equal(scheduleRows(await client.admin('schedule.list')).length, 0);
});

t.test('engines.versions / profiles.list normalise; the wizard\'s browser step reads the daemon', async () => {
  const v = normalizeVersions(await client.admin('engines.versions'));
  assert.ok(v.browsers.length >= 1, 'Edge or Chrome is installed on this machine');
  for (const b of v.browsers) assert.ok(['edge', 'chrome'].includes(b.kind) && b.path, JSON.stringify(b));
  assert.match(String(v.cft.pinned), /^\d+\.\d+\.\d+\.\d+$/);
  const profiles = pickList(await client.admin('profiles.list'), 'profiles');
  assert.ok(Array.isArray(profiles));
  const layout = homeLayout(home);
  const wizard = new Wizard({
    client,
    settings: new DesktopSettings(layout.desktopJson),
    log: createLogger(layout.installLog),
    layout,
    resources: resourcePaths(resourceRoot({ isPackaged: false, appDir: APP_DIR })),
    app: { isPackaged: false, execPath: process.execPath, resourceRoot: REPO, port, homeOverride: home },
    deps: { clipboardWrite: () => {}, regRun: async () => ({ code: 1, stdout: '', stderr: 'not used' }) },
  });
  const r = await wizard.browsers();
  assert.equal(r.source, 'daemon');
  assert.equal(r.cft.pinned, v.cft.pinned);
});

t.test('extension.install: the bundled extension lands in G9_HOME/extension with its version', async () => {
  const layout = homeLayout(home);
  let copied = null;
  const wizard = new Wizard({
    client,
    settings: new DesktopSettings(layout.desktopJson),
    log: createLogger(layout.installLog),
    layout,
    resources: resourcePaths(REPO),
    app: { isPackaged: false, execPath: process.execPath, resourceRoot: REPO, port, homeOverride: home },
    deps: { clipboardWrite: (text) => { copied = text; }, regRun: async () => ({ code: 1, stdout: '', stderr: '' }) },
  });
  const r = await wizard.installExtension();
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'extension', 'manifest.json'), 'utf8'));
  assert.equal(r.via, 'daemon');
  assert.equal(path.resolve(r.path).toLowerCase(), path.resolve(layout.extension).toLowerCase());
  assert.equal(r.version, manifest.version);
  assert.equal(copied, r.path, 'the path is what goes on the clipboard');
  assert.ok(fs.existsSync(path.join(layout.extension, 'manifest.json')));
  assert.ok(!fs.existsSync(path.join(layout.extension, 'dev-daemon.json')), 'no dev override ships');
  assert.match(fs.readFileSync(layout.installLog, 'utf8'), /extension/i);
});

t.test('watch refuses a tab that does not exist (no frames for nothing)', async () => {
  await assert.rejects(client.admin('watch', { tabId: 987654 }), /987654/);
});

t.test('an agent cannot use admin ops (only the desktop resumes a halt)', async () => {
  const agent = new DaemonClient({ port, version: VERSION, role: 'agent', clientName: 'contract-agent' });
  agent.start();
  await agent.whenConnected(10_000);
  await assert.rejects(agent.admin('resume'), /desktop app/i);
  agent.stop();
});

t.test('--smoke under plain node: one JSON line with the welcome and the settings', async () => {
  const r = await runSmoke(process.execPath, [path.join(APP_DIR, 'main.mjs'), '--smoke']);
  assert.equal(r.code, 0, r.err || r.out);
  const j = JSON.parse(r.out.trim());
  assert.equal(j.ok, true);
  assert.equal(j.welcome.version, VERSION);
  assert.equal(j.settings.humanize, 'human');
});

t.test('--smoke under Electron (main process, no window)', async () => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    console.log('    (electron is not installed in desktop/node_modules — skipped)');
    return;
  }
  const r = await runSmoke(electronPath, [APP_DIR, '--smoke']);
  assert.equal(r.code, 0, r.err || r.out);
  const j = JSON.parse(r.out.trim().split('\n').at(-1));
  assert.equal(j.ok, true);
  assert.equal(j.version, VERSION, 'app.getVersion() of the Electron app');
});

t.test('restart when idle: shutdown, port free, the launcher starts g9d again (the app\'s own path)', async () => {
  const firstPid = client.state.daemonPid;
  const launcher = new DaemonLauncher({
    commandOptions: { isPackaged: false, execPath: process.execPath, resourceRoot: REPO, home },
    port,
    cooldownMs: 0,
  });
  client.onRefused = () => launcher.onRefused();
  const r = await restartDaemonIfIdle(client, launcher, { reason: 'contract check' });
  assert.equal(r.restarted, true, JSON.stringify(r));
  await until(() => client.connected && client.state.daemonPid && client.state.daemonPid !== firstPid, { timeoutMs: 15_000, what: 'a new daemon' });
  ours.add(client.state.daemonPid);
  assert.equal(launcher.lastPid, client.state.daemonPid, 'the daemon the app spawned is the one it talks to');
  assert.notEqual(daemon.exitCode, null, 'the first daemon exited');
});

t.test('shutdown: the daemon stops and frees the port', async () => {
  const r = await client.admin('shutdown');
  assert.deepEqual(r, { stopping: true });
  client.stop();
  assert.equal(await waitForPortFree(port, { timeoutMs: 15_000 }), true);
});

function runSmoke(command, args) {
  return new Promise((resolve) => {
    const env = { ...process.env, G9_PORT: String(port), G9_HOME: home };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

t.run();
