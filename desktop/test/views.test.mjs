/**
 * The renderer, end to end, without a window: renderer/app.js boots on the real index.html in a
 * small fake DOM (test/fake-dom.mjs); window.g9 is a fake of the preload bridge that answers with
 * the daemon's real shapes (read from daemon/*.js and engine/manager.js) and records every call.
 *
 * Each view is opened, rendered, clicked through its main actions, and checked for what it asks
 * the main process to do — including the rules that matter most: the Watch canvas never sends
 * input anywhere, an approval never carries `by` from the page, nothing approves without a person
 * confirming, schedule entries are addressed by `entryId`, and a calibrated humanize profile is
 * kept by name. Any console.error or unhandled rejection fails the file.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './harness.mjs';
import { installFakeDom } from './fake-dom.mjs';
import { WIZARD_STEPS } from '../lib/wizard.mjs';
import { normalizeAgent, normalizeEngine, normalizeTab } from '../renderer/lib/engines.js';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer');
const t = suite('desktop: every view renders and acts in a fake DOM (no window)');

// ------------------------------------------------------------------ problems anywhere fail the file

const problems = [];
const origError = console.error;
console.error = (...a) => {
  problems.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' '));
  origError(...a);
};
process.on('unhandledRejection', (err) => problems.push(`unhandledRejection: ${err?.stack ?? err}`));

// ------------------------------------------------------------------ the daemon's world, as main shows it

const NOW = Date.now();
const settingsFromDaemon = {
  port: 8765, defaultBrowser: 'auto', headless: true, humanize: 'human', stealth: 'off', maxParallel: 8,
  evidence: { maxFrames: 3000, maxBytes: 300 * 1024 * 1024, keepRuns: 200, quality: 60, maxWidth: 1280, maxHeight: 800 },
  idleExitMinutes: 60, updateUrl: '', schedule: [],
};
const extensionRow = { engineId: 'engine-1', kind: 'extension', browser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.3405.12', version: '2.0.0', connectedAt: NOW - 90_000, tabs: [3, 4] };
const launchedRow = {
  engineId: 'launched-1', kind: 'launched', browser: { kind: 'edge', path: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', version: '153.0.3405.12' }, version: '153.0.3405.12',
  headless: true, profile: 'automation', pid: 5150, argv: ['--headless=new'], startedAt: NOW - 30_000,
  contexts: [{ contextId: 'ctx-1', engineId: 'launched-1', humanize: 'human', stealth: 'off', locale: 'de-DE', timezone: 'Europe/Berlin', proxy: null, downloadPath: 'C:/G9BrowserAgent/downloads/ctx-1' }],
  tabs: [7],
};
const tabRows = [
  { tabId: 3, title: 'Checkout — Shop', url: 'https://shop.example/checkout', engine: 'engine-1', engineKind: 'extension', owner: 'agent-1', ownerName: 'claude-code', current: false },
  { tabId: 4, title: 'Inbox', url: 'https://mail.example/', engine: 'engine-1', engineKind: 'extension', owner: null, current: false },
  { tabId: 7, title: 'Login', url: 'https://app.example/login', engine: 'launched-1', engineKind: 'launched', owner: 'agent-2', ownerName: 'cursor', session: 'main' },
];
const agentRows = [
  { id: 'agent-1', name: 'claude-code', pid: 11, owned: [3], current: 3, halted: false, connectedAt: NOW - 60_000 },
  { id: 'agent-2', name: 'cursor', pid: 12, owned: [7], current: 7, halted: true, connectedAt: NOW - 30_000 },
];
const runsList = [
  { runId: '20260921-221000-replay-ab12', kind: 'replay', label: 'rec_checkout', startedAt: NOW - 600_000, finishedAt: NOW - 540_000, active: false, ok: true, verdict: 'SURPRISE', exitCode: null, frames: 3, dir: 'C:/G9BrowserAgent/runs/20260921-221000-replay-ab12' },
  { runId: '20260921-020000-schedule-cd34', kind: 'schedule', label: 'Nightly smoke', startedAt: NOW - 3_600_000, finishedAt: NOW - 3_500_000, active: false, ok: false, verdict: 'FAIL_PRODUCT', exitCode: 1, frames: 0, dir: 'C:/G9BrowserAgent/runs/x' },
  { runId: '20260921-230000-watch-ef56', kind: 'watch', label: 'tab 7', startedAt: NOW - 60_000, finishedAt: NOW - 30_000, active: false, ok: true, verdict: null, exitCode: null, frames: 20, dir: 'C:/G9BrowserAgent/runs/y' },
];
const scheduleEntries = [
  { id: 'sch_1a2b3c4d', name: 'Nightly smoke', target: 'suite:smoke', args: ['--env', 'staging', '--browser', 'auto', '--headless', '--humanize', 'human', '--stealth', 'off', '--profile', 'automation'], daily: '02:00', enabled: true, suite: 'suite:smoke', env: 'staging', at: '02:00', nextRunAt: NOW + 3_600_000, running: false, lastRunAt: NOW - 3_600_000, lastExitCode: 1, lastRunId: '20260921-020000-schedule-cd34', lastRun: { runId: '20260921-020000-schedule-cd34', at: NOW - 3_600_000, finishedAt: NOW - 3_500_000, exitCode: 1, verdict: 'FAIL_PRODUCT' } },
];
const recordings = [
  { id: 'rec_checkout', name: 'Checkout', engine: 'launched', stepCount: 9, lastRun: { at: NOW - 540_000, passed: 9, failed: 0, verdict: 'SURPRISE', humanize: 'human', surprises: 2 } },
  { id: 'rec_login', name: 'Login', engine: 'extension', stepCount: 4, lastRun: { at: NOW - 900_000, passed: 4, failed: 0, verdict: 'PASS', surprises: 0 } },
];

function snapshot(patch = {}) {
  return {
    app: { version: '2.0.0', packaged: false, home: 'C:/G9BrowserAgent', desktopHome: 'C:/G9BrowserAgent', port: 8765, user: 'qa1', platform: 'win32', resourceRoot: 'G:/repo' },
    connection: { status: 'connected', port: 8765, url: 'ws://127.0.0.1:8765/g9', error: null, id: 'ui-1', daemonVersion: '2.0.0', daemonPid: 4242, home: 'C:/G9BrowserAgent', halted: { global: false } },
    halted: { global: false },
    agents: agentRows.map(normalizeAgent),
    engines: [extensionRow, launchedRow].map(normalizeEngine),
    tabs: tabRows.map(normalizeTab),
    activity: [
      { kind: 'tool', agentId: 'agent-1', name: 'claude-code', tool: 'browser_interact', detail: 'click e7', ok: true, ms: 140, at: NOW - 5000, receivedAt: NOW - 5000 },
      { kind: 'tool', agentId: 'agent-2', name: 'cursor', tool: 'browser_navigate', detail: 'goto https://x — net::ERR_NAME_NOT_RESOLVED', ok: false, ms: 30, at: NOW - 4000, receivedAt: NOW - 4000 },
      { kind: 'dialog', engine: 'engine-1', tabId: 3, type: 'confirm', message: 'Leave this page?', at: NOW - 3000, receivedAt: NOW - 3000 },
    ],
    daemonMismatch: null,
    notices: [],
    update: { status: 'not-configured', line: 'Updates: not configured' },
    wizard: { steps: WIZARD_STEPS.map((s) => ({ ...s, outcome: null })), completedAt: null },
    watching: [],
    ...patch,
  };
}

// ------------------------------------------------------------------ the preload bridge

// The real preload.cjs, run against a fake `electron` module, so the page meets the same topic
// allowlist and error wrapping the window does. A fake bridge that accepted every topic once hid a
// Watch view that threw half-way through mount() in the real window ('watchStatus' was not in the
// preload's list). Only main's side is faked: ipcMain answers from answer() below, and push() is
// main's webContents.send('g9:push', …).
const calls = [];
let applyAttempts = 0;
const { bridge, push } = loadRealPreload(async (op, args) => {
  calls.push({ op, args: structuredClone(args ?? {}) });
  await null;
  return structuredClone(await answer(op, args ?? {}));
});

function loadRealPreload(handle) {
  let exposed = null;
  let onPush = null;
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        assert.equal(name, 'g9');
        exposed = value;
      },
    },
    ipcRenderer: {
      on(channel, fn) {
        assert.equal(channel, 'g9:push');
        onPush = fn;
      },
      // main.mjs's ipcMain.handle('g9', …) replies { ok, result } or { ok: false, error }.
      async invoke(channel, op, args) {
        assert.equal(channel, 'g9');
        try {
          return { ok: true, result: await handle(op, args) };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err) };
        }
      },
    },
  };
  const src = fs.readFileSync(path.join(RENDERER, '..', 'preload.cjs'), 'utf8');
  const requireFake = (m) => {
    if (m === 'electron') return electron;
    throw new Error(`preload.cjs requires ${m}; a sandboxed preload gets only electron`);
  };
  new Function('require', 'module', 'exports', src)(requireFake, { exports: {} }, {});
  assert.ok(exposed && onPush, 'the preload exposed g9 and listens for pushes');
  return { bridge: exposed, push: (topic, data) => onPush({}, { topic, data }) };
}

function answer(op, a) {
  switch (op) {
    case 'state': return snapshot();
    case 'desktop.get': return { lastView: 'agents', startDaemon: true };
    case 'desktop.patch': return {};
    case 'desktop.loginItem.get': return { supported: true, openAtLogin: false, reason: null };
    case 'desktop.loginItem.set': return { supported: true, openAtLogin: !!a.enabled, reason: null };
    case 'reconnect': return snapshot().connection;
    case 'admin': return adminAnswer(a.op, a.args ?? {});
    case 'call': return callAnswer(a.tool, a.args ?? {});
    case 'approve': return { id: a.flowId, runs: 3 };
    case 'runs.detail': if (/schedule/.test(a.runId)) return {
      runId: a.runId, dir: 'C:/G9BrowserAgent/runs/x', active: false, files: ['engine.json', 'report/', 'result.json'],
      engine: { runId: a.runId, kind: 'schedule', label: 'Nightly smoke', startedAt: NOW - 3_600_000 },
      result: { finishedAt: NOW - 3_500_000, ok: false, exitCode: 1, verdict: 'FAIL_PRODUCT', verdicts: { PASS: 1, FAIL_PRODUCT: 1 }, reportDir: 'C:/G9BrowserAgent/runs/x/report' },
      report: { flows: [
        { id: 'rec_login', name: 'Login', verdict: 'PASS_WITH_WARNING', passed: 4, total: 4, warnings: ['step 1/4 (click "Sign in") matched only by css. Its stable identifiers no longer work, so this step is one refactor from breaking.'], steps: [{ step: 1, type: 'click', ok: true, matchedBy: 'css' }] },
        { id: 'rec_checkout', name: 'Checkout', verdict: 'FAIL_PRODUCT', passed: 8, total: 9, failureMessage: 'Expected "Thank you"', steps: [{ step: 9, type: 'assert', ok: false, error: 'Expected "Thank you"' }], surprises: [{ kind: 'new', layer: 'network', key: 'POST /api/pay 500', effectiveSeverity: 'fail' }] },
      ] },
    };
    if (/warn/.test(a.runId)) return {
      runId: a.runId, dir: `C:/G9BrowserAgent/runs/${a.runId}`, active: false, files: ['engine.json', 'result.json'],
      engine: { runId: a.runId, kind: 'replay', label: 'rec_login', tabId: 7, startedAt: NOW - 300_000 },
      result: { finishedAt: NOW - 280_000, ok: true, verdict: 'PASS_WITH_WARNING', passed: 4, failed: 0, total: 4, ...(a.runId.endsWith('text') ? { warnings: ['step 3/4 passed, but 12 node(s) came back with different numbers — live data, not a structural change.'] } : {}) },
      report: null,
    };
    return {
      runId: a.runId, dir: `C:/G9BrowserAgent/runs/${a.runId}`, active: false, files: ['engine.json', 'frames/', 'frames.jsonl', 'pointer.jsonl', 'result.json'],
      engine: { runId: a.runId, kind: 'replay', label: 'rec_checkout', tabId: 7, startedAt: NOW - 600_000, engine: { engineId: 'launched-1' } },
      result: { finishedAt: NOW - 540_000, durationMs: 60_000, frames: 3, framesDropped: 0, ok: true, verdict: 'SURPRISE', passed: 9, failed: 0, total: 9, humanize: { level: 'human', seed: 42 }, seed: 42 },
      report: null,
    };
    case 'runs.local': return {
      exists: true, dir: 'C:/G9BrowserAgent/runs/r',
      frames: [1, 2, 3].map((seq) => ({ seq, at: 1000 * seq, file: `00000${seq}.jpg`, metadata: { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0 }, pointer: null })),
      pointer: [{ at: 1000, x: 10, y: 10, buttons: 0, type: 'mouseMoved' }, { at: 2000, x: 200, y: 120, buttons: 1, type: 'mousePressed' }],
      result: null, engine: null, video: null,
    };
    case 'runs.frame': return new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    case 'runs.openReport': return { path: `C:/G9BrowserAgent/runs/${a.runId}/report/report.html` };
    case 'runs.openFolder': return { path: `C:/G9BrowserAgent/runs/${a.runId}` };
    case 'updater.check':
    case 'updater.state': return snapshot().update;
    case 'wizard.state':
    case 'wizard.mark': return snapshot().wizard;
    case 'wizard.log': return ['2026-09-21T22:00:00.000Z INFO  Setup: browsers detected'];
    case 'wizard.browsers': return { browsers: [{ kind: 'edge', path: 'C:/Edge/msedge.exe', version: '153.0.3405.12' }, { kind: 'chrome', path: 'C:/Chrome/chrome.exe', version: '153.0.7000.4' }], cft: { pinned: '153.0.7000.1', installed: [], pinnedInstalled: false }, source: 'daemon', daemonError: null };
    case 'wizard.installCft': return { cft: { downloaded: { version: '153.0.7000.1', path: 'C:/G9BrowserAgent/engines/cft-153.0.7000.1/chrome.exe' } } };
    case 'wizard.profile': return { profiles: [{ name: 'automation', dir: 'C:/G9BrowserAgent/profiles/automation' }], automation: { name: 'automation', dir: 'C:/G9BrowserAgent/profiles/automation' } };
    case 'wizard.warm': return { profile: 'automation', warming: true, pid: 99 };
    case 'wizard.policies': return {
      rows: [{ browser: 'edge', key: 'HKCU\\Software\\Policies\\Microsoft\\Edge', name: 'WindowOcclusionEnabled', type: 'REG_DWORD', desired: 0, why: 'covered windows keep drawing', chrome: '90', current: { exists: false }, applied: false, recordedPrevious: null, command: 'reg add "HKCU\\Software\\Policies\\Microsoft\\Edge" /v WindowOcclusionEnabled /t REG_DWORD /d 0 /f', undoCommand: null }],
      appliedCount: 0, total: 1, canUndo: false, record: { appliedAt: null, by: null, entries: 0 },
    };
    case 'wizard.applyPolicies':
      applyAttempts += 1;
      return a.elevate ? { ok: true, message: 'All 1 policy values are set.' } : { ok: false, needsElevation: true, message: 'Windows allows only administrators…' };
    case 'wizard.mcp': return {
      entry: { command: 'node', args: ['G:/repo/mcp/shim.mjs'] },
      clients: [
        { id: 'claude-code', label: 'Claude Code', file: 'C:/Users/qa1/.claude.json', installed: true, fileExists: true, restartHint: 'Start a new session.', client: { id: 'claude-code', label: 'Claude Code', file: 'C:/Users/qa1/.claude.json', key: 'mcpServers' }, status: 'different', jsonc: false, existing: { command: 'node', args: ['G:/repo/bridge/src/server.js'] }, entry: { type: 'stdio', command: 'node', args: ['G:/repo/mcp/shim.mjs'] }, diff: [{ op: '-', line: '"args": ["G:/repo/bridge/src/server.js"]' }, { op: '+', line: '"args": ["G:/repo/mcp/shim.mjs"]' }], note: 'This is the v1 entry (bridge/src/server.js).' },
        { id: 'cursor', label: 'Cursor', file: 'C:/Users/qa1/.cursor/mcp.json', installed: true, fileExists: true, client: { id: 'cursor', key: 'mcpServers' }, status: 'same', diff: [], note: 'Already registered.' },
        { id: 'vscode', label: 'VS Code', file: 'C:/Users/qa1/AppData/Roaming/Code/User/mcp.json', installed: true, fileExists: true, client: { id: 'vscode', key: 'servers' }, status: 'invalid', entry: { type: 'stdio', command: 'node', args: ['x'] }, diff: [], note: 'The file is not valid JSON.' },
        { id: 'claude-desktop', label: 'Claude Desktop', file: 'C:/Users/qa1/AppData/Roaming/Claude/claude_desktop_config.json', installed: false, fileExists: false, client: { id: 'claude-desktop', key: 'mcpServers' }, status: 'create', diff: [], note: null },
      ],
    };
    case 'wizard.registerMcp': return { ok: true, changed: true, message: `Replaced in ${a.client}.`, backup: 'x.g9-backup' };
    case 'wizard.extension': return { source: 'G:/repo/extension', sourceVersion: '2.0.0', target: 'C:/G9BrowserAgent/extension', installedVersion: null, browsers: [{ kind: 'edge', path: 'C:/Edge/msedge.exe', page: 'edge://extensions' }], clicks: { edge: ['Developer mode', 'Load unpacked', 'Paste'], chrome: ['a', 'b', 'c'] } };
    case 'wizard.installExtension': return { path: 'C:/G9BrowserAgent/extension', version: '2.0.0', via: 'daemon', reloaded: 1, clipboard: true };
    case 'wizard.openExtensionsPage': return { command: 'C:/Edge/msedge.exe', args: ['edge://extensions'], clicks: [] };
    default: throw new Error(`fake bridge: unexpected op ${op}`);
  }
}

function adminAnswer(op, a) {
  switch (op) {
    case 'settings.get': return settingsFromDaemon;
    case 'settings.set': return { ...settingsFromDaemon, ...a.patch };
    case 'engines.versions': return { running: [], browsers: [{ kind: 'edge', path: 'C:/Edge/msedge.exe', version: '153.0.3405.12' }, { kind: 'chrome', path: 'C:/Chrome/chrome.exe', version: '153.0.7000.4' }], cft: { pinned: { version: '153.0.7000.1', platform: 'win64' }, installed: [] }, log: 'C:/G9BrowserAgent/engine-versions.log' };
    case 'engines.installCft': return { cft: { downloaded: { version: '153.0.7000.1', path: 'C:/G9BrowserAgent/engines/cft/chrome.exe' } } };
    case 'profiles.list': return { profiles: [{ name: 'automation', dir: 'C:/G9BrowserAgent/profiles/automation' }, { name: 'berlin', dir: 'C:/G9BrowserAgent/profiles/berlin' }] };
    case 'profiles.warm': return { profile: a.name, warming: true, pid: 77 };
    case 'runs.list': return { runs: runsList };
    case 'schedule.list': return { entries: scheduleEntries };
    case 'schedule.add': return { id: 'sch_new', ...a.entry };
    case 'schedule.remove': return { removed: a.entryId };
    case 'schedule.runNow': return { runId: '20260921-235900-schedule-0001', dir: 'C:/G9BrowserAgent/runs/z' };
    case 'watch': return { watching: true, tabId: a.tabId, runId: '20260921-235959-watch-0002' };
    case 'unwatch': return { watching: false, tabId: a.tabId };
    case 'halt': return { halted: true };
    case 'resume': return { halted: false };
    case 'haltAgent':
    case 'resumeAgent': return { changed: true };
    case 'extension.reload': return { reloadSent: 1 };
    default: throw new Error(`fake bridge: unexpected admin op ${op}`);
  }
}

function callAnswer(tool, a) {
  if (tool === 'browser_tabs' && a.action === 'list') return { tabs: tabRows };
  if (tool === 'browser_engine' && a.action === 'list') return { engines: [extensionRow, launchedRow] };
  if (tool === 'browser_engine' && a.action === 'launch') return { engineId: 'launched-2', browser: { kind: 'edge', version: '153.0.3405.12' }, version: '153.0.3405.12' };
  if (tool === 'browser_engine' && a.action === 'stop') return { stopped: a.engineId };
  if (tool === 'browser_recording' && a.action === 'list') return { recordings };
  if (tool === 'browser_recording' && a.action === 'get') {
    return { ...recordings.find((r) => r.id === a.id), knownWorld: { runs: 2, approvedAt: NOW - 86_400_000, approvedBy: 'qa0' }, surpriseHistory: [[{ key: 'POST /api/pay/confirm', kind: 'new' }, { key: 'GET /api/banner', kind: 'missing' }]] };
  }
  if (tool === 'browser_status') return { halted: { global: false } };
  throw new Error(`fake bridge: unexpected call ${tool} ${a.action}`);
}

// ------------------------------------------------------------------ helpers

const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
const { document } = installFakeDom({ bridge, html });
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => root.querySelectorAll(sel);
const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 2));
};
const since = (mark) => calls.slice(mark);
const opsSince = (mark) => since(mark).map((c) => (c.op === 'admin' ? `admin:${c.args.op}` : c.op === 'call' ? `call:${c.args.tool}:${c.args.args?.action ?? ''}` : c.op));
const button = (label, root = document) => $$('button', root).find((b) => b.textContent.trim().startsWith(label));
async function go(view) {
  push('navigate', { view });
  await flush();
  assert.equal($(`#view-${view}`).hidden, false, `${view} is shown`);
}
async function answerModal(label) {
  await flush(2);
  assert.equal($('#modal').open, true, 'a confirmation is asked');
  const b = button(label, $('#modal-actions'));
  assert.ok(b, `modal button "${label}"`);
  b.click();
  await flush();
}

// ------------------------------------------------------------------ tests

t.test('boot: the first run opens Setup; the bar, version badge and setup counter reflect the state', async () => {
  await import('../renderer/app.js');
  await flush(10);
  assert.equal($('#view-setup').hidden, false, 'a first run lands on Setup');
  assert.equal($('#app-version').textContent, '2.0.0', 'the version badge');
  assert.match($('#conn-text').textContent, /Daemon 2\.0\.0 connected on port 8765, pid 4242/);
  assert.equal($('#stop-all').disabled, false);
  assert.equal($('#resume-all').hidden, true);
  assert.equal($('#setup-count').textContent, '5');
  assert.equal($('#update-line').textContent, 'Updates: not configured');
  assert.equal($$('#nav button').length, 8);
  assert.equal($$('#nav button svg').length, 8, 'every section has its icon');
});

t.test('Setup: five steps filled from the wizard; policies ask, then offer the one elevation', async () => {
  const steps = $$('#view-setup li.step');
  assert.deepEqual(steps.map((li) => li.dataset.step), ['browsers', 'profile', 'policies', 'mcp', 'extension']);
  assert.ok(!$$('#view-setup .step-content').some((b) => /Checking…/.test(b.textContent)), 'every step finished loading');
  assert.match($('[data-step="browsers"]').textContent, /Install Chrome for Testing 153\.0\.7000\.1/);
  assert.match($('[data-step="extension"]').textContent, /C:\/G9BrowserAgent\/extension/);
  const mark = calls.length;
  button('Apply policies').click();
  await answerModal('Apply');
  await answerModal('Show the Windows prompt');
  const applied = since(mark).filter((c) => c.op === 'wizard.applyPolicies').map((c) => c.args.elevate);
  assert.deepEqual(applied, [false, true], 'unelevated first; elevated only after the person agreed');
});

t.test('Setup: a different MCP entry is shown as a diff and replaced only when confirmed', async () => {
  const mark = calls.length;
  button('Review and replace').click();
  await flush(2);
  assert.match($('#modal-content').textContent, /bridge\/src\/server\.js/, 'the old entry is in the diff');
  assert.equal(since(mark).filter((c) => c.op === 'wizard.registerMcp').length, 0, 'nothing written before the answer');
  await answerModal('Replace');
  const reg = since(mark).find((c) => c.op === 'wizard.registerMcp');
  assert.deepEqual(reg.args, { client: 'claude-code', confirmReplace: true });
});

t.test('Setup: the extension step prepares the folder and opens the extensions page', async () => {
  const mark = calls.length;
  button('Prepare the extension folder').click();
  await flush();
  button('Open Edge extensions').click();
  await flush();
  assert.deepEqual(opsSince(mark).filter((o) => o.startsWith('wizard.')).slice(0, 3), ['wizard.installExtension', 'wizard.extension', 'wizard.openExtensionsPage']);
});

t.test('Agents: owners, per-agent Halt/Resume, and the activity log in words', async () => {
  await go('agents');
  const rows = $$('#view-agents tbody tr');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /claude-code.*#3 Checkout — Shop/);
  assert.match(rows[1].textContent, /Halted/);
  const log = $$('#view-agents .activity li').map((li) => li.textContent);
  assert.match(log.join('\n'), /browser_interact click e7/);
  assert.match(log.join('\n'), /ERR_NAME_NOT_RESOLVED/);
  assert.match(log.join('\n'), /confirm dialog blocks tab 3/);
  const mark = calls.length;
  button('Halt', rows[0]).click();
  button('Resume', rows[1]).click();
  await flush();
  const ops = since(mark).filter((c) => c.op === 'admin').map((c) => [c.args.op, c.args.args.agentId]);
  assert.deepEqual(ops, [['haltAgent', 'agent-1'], ['resumeAgent', 'agent-2']]);
});

t.test('Engines: running engines with contexts, installed browsers + pinned CfT, profiles with Warm', async () => {
  await go('engines');
  await flush();
  const view = $('#view-engines');
  assert.match(view.textContent, /Extension 2\.0\.0 in Edge 153\.0\.3405\.12/, 'the extension row names the browser from its UA');
  assert.match(view.textContent, /context ctx-1, input human, de-DE, Europe\/Berlin/);
  // Chromium's browserContextId is 32 hex characters: shortened in the chip, whole in its tooltip.
  const longId = '7A099386FE816F7462B99B037A2FCD91';
  push('state', snapshot({ engines: [extensionRow, { ...launchedRow, contexts: [{ ...launchedRow.contexts[0], contextId: longId }] }].map(normalizeEngine) }));
  await flush();
  const ctxChip = $$('#view-engines .chip').find((c) => c.textContent.startsWith('context '));
  assert.equal(ctxChip.textContent.split(',')[0], 'context 7A0993…CD91');
  assert.match(ctxChip.getAttribute('title'), new RegExp(`Context ${longId}`));
  push('state', snapshot());
  await flush();
  assert.match(view.textContent, /153\.0\.7000\.1 \(pinned\)/);
  assert.match(view.textContent, /C:\/G9BrowserAgent\/profiles\/berlin/);
  const mark = calls.length;
  button('Install 153.0.7000.1', view).click();
  await flush();
  button('Warm (open headed)', view).click();
  await flush();
  const admins = since(mark).filter((c) => c.op === 'admin').map((c) => c.args);
  assert.deepEqual(admins.find((x) => x.op === 'engines.installCft').args, { version: '153.0.7000.1' });
  assert.equal(admins.find((x) => x.op === 'profiles.warm').args.name, 'automation');
});

t.test('Engines: the launch form starts at the daemon defaults and keeps a calibrated profile name', async () => {
  const form = $('#view-engines form');
  const humanize = $('input[name="humanize"]', form);
  assert.equal(humanize.value, 'human', 'pre-filled from settings.get');
  assert.equal($('select[name="browser"]', form).value, 'auto');
  humanize.value = 'team-qa';
  $('input[name="locale"]', form).value = 'de-DE';
  const mark = calls.length;
  button('Launch engine', form).click();
  await flush();
  const launch = since(mark).find((c) => c.op === 'call' && c.args.args.action === 'launch').args.args;
  assert.deepEqual(launch, { action: 'launch', browser: 'auto', headless: true, profile: 'automation', humanize: 'team-qa', stealth: 'off', locale: 'de-DE' });
  humanize.value = 'not a name';
  const mark2 = calls.length;
  button('Launch engine', form).click();
  await flush();
  assert.equal(since(mark2).filter((c) => c.op === 'call').length, 0, 'an invalid human input is refused before anything is sent');
});

t.test('Engines: the extension row offers Reload (never Stop); a launched engine asks before Stop', async () => {
  const view = $('#view-engines');
  const mark = calls.length;
  button('Reload', view).click();
  await flush();
  assert.ok(opsSince(mark).includes('admin:extension.reload'));
  button('Stop', view).click();
  await answerModal('Stop engine');
  const stop = since(mark).find((c) => c.op === 'call' && c.args.args.action === 'stop');
  assert.deepEqual(stop.args.args, { action: 'stop', engineId: 'launched-1' });
});

t.test('Watch: with no tab anywhere the placeholder says where tabs come from, and follows the list', async () => {
  push('state', snapshot({ tabs: [], agents: [], engines: [] }));
  await go('watch');
  assert.match($('#view-watch select').textContent, /No tabs to watch/);
  assert.match($('#view-watch .stage-empty').textContent, /No tab to watch yet/, 'not "Pick a tab" when there is none (render check, round 3)');
  assert.doesNotMatch($('#view-watch .stage-empty').textContent, /Pick a tab/);
  push('state', snapshot());
  await flush();
  assert.match($('#view-watch .stage-empty').textContent, /Pick a tab and press Watch/, 'a tab arrived: the placeholder follows');
  await go('agents');
  // A second visit with the same tabs: mount() makes a new <select>, and the picker key (module
  // level) still matched the last visit, so the new picker stayed empty until a tab changed.
  await go('watch');
  assert.equal($('#view-watch select').querySelectorAll('option').length, 3, 'a second visit fills the new picker');
  assert.equal($('#view-watch select').disabled, false);
  await go('agents');
});

t.test('Watch: frames and cursor are drawn; a click on the picture reaches nothing; leaving unwatches', async () => {
  await go('watch');
  const picker = $('#view-watch select');
  assert.equal(picker.querySelectorAll('option').length, 3, 'every tab of every engine');
  picker.value = '7';
  const mark = calls.length;
  button('Watch', $('#view-watch')).click();
  await flush();
  assert.deepEqual(since(mark).find((c) => c.op === 'admin').args, { op: 'watch', args: { tabId: 7 } });
  push('frame', { tabId: 7, data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64'), metadata: { deviceWidth: 1280, deviceHeight: 800 }, at: Date.now() });
  push('pointer', { tabId: 7, sample: { at: Date.now(), x: 100, y: 80, buttons: 0, type: 'mouseMoved' } });
  push('frame', { tabId: 99, data: 'AAAA', at: Date.now() }); // another tab's frame is ignored
  await flush();
  assert.equal($('#view-watch .stage-empty').hidden, true, 'the first frame replaced the placeholder');
  // A hidden tab renders no frames: the daemon says so, and the picture must not pass for live (P8 matrix, round 2).
  assert.equal($('#view-watch .stage-status').hidden, true, 'nothing to say while the picture is live');
  push('watchStatus', { tabId: 99, state: 'hidden', reason: 'another tab' });
  await flush();
  assert.equal($('#view-watch .stage-status').hidden, true, 'another tab\'s status is ignored');
  push('watchStatus', { tabId: 7, state: 'hidden', reason: 'The tab is hidden (document.visibilityState="hidden").' });
  await flush();
  assert.equal($('#view-watch .stage-status').hidden, false, 'a hidden tab is announced over the picture');
  assert.match($('#view-watch .stage-status').textContent, /not live/);
  push('watchStatus', { tabId: 7, state: 'live' });
  await flush();
  assert.equal($('#view-watch .stage-status').hidden, true, 'frames again: the notice goes');
  // A visible page that is not changing sends no frames: 'idle' is its normal state, so no amber
  // banner over every static page (render check, round 3); an unreadable visibility still warns.
  push('watchStatus', { tabId: 7, state: 'idle', visibility: 'visible', reason: 'No frame for 2 s while the page reports it is visible.' });
  await flush();
  assert.equal($('#view-watch .stage-status').hidden, true, 'idle on a visible page: no banner');
  push('watchStatus', { tabId: 7, state: 'idle', visibility: null, reason: 'No frame for 2 s while the page reports it is in an unknown state.' });
  await flush();
  assert.equal($('#view-watch .stage-status').hidden, false, 'idle with a visibility nobody could read: the banner says so');
  assert.match($('#view-watch .stage-status').textContent, /No new frames/);
  push('watchStatus', { tabId: 7, state: 'live' });
  await flush();
  const before = calls.length;
  const canvas = $('#view-watch canvas');
  for (const type of ['click', 'mousedown', 'mouseup', 'mousemove', 'wheel', 'keydown', 'dblclick', 'contextmenu']) canvas.dispatchEvent(new Event(type));
  await flush();
  assert.equal(calls.length, before, 'no input path from the canvas to anything');
  assert.match($('#toasts').textContent, /View only/);
  await go('runs');
  assert.ok(opsSince(before).includes('admin:unwatch'), 'leaving the view stops the stream');
});

t.test('Runs: list with verdicts, a run with steps/surprises, and a replay player', async () => {
  const rows = $$('#view-runs tbody tr');
  assert.equal(rows.length, 3);
  // Newest first: the watch session, the replay, the scheduled suite.
  assert.match(rows[0].textContent, /^tab 7Watch session/);
  assert.match(rows[1].textContent, /^CheckoutSurprise/, 'the recording name replaces the id rec_checkout');
  assert.match(rows[2].textContent, /Nightly smokeProduct failureScheduled/);
  rows[1].click();
  await flush();
  const detail = $('#view-runs .run-detail');
  assert.match(detail.textContent, /9 passed, 0 failed of 9/);
  assert.match(detail.textContent, /human, seed 42/);
  button('Surprises', detail).click();
  await flush();
  assert.match(detail.textContent, /POST \/api\/pay\/confirm/, 'surprise keys from the recording\'s latest comparison');
  button('Replay', detail).click();
  await flush(10);
  assert.match(detail.textContent, /3 frames, 2 cursor samples/);
  assert.ok(button('Play', detail), 'the player is up');
  button('Play', detail).click();
  await flush();
  // A scheduled suite: every flow with its verdict and failing step, and its runner report.
  $$('#view-runs tbody tr')[2].click();
  await flush();
  assert.match(detail.textContent, /Flows \(2\)/);
  assert.match(detail.textContent, /Expected "Thank you"/);
  // What made the pass "with warnings", in the run's words (render check, round 3: nowhere said).
  assert.match($('#view-runs .run-warnings').textContent, /Warning.*matched only by css.*one refactor from breaking/);
  const mark = calls.length;
  button('Open report', detail).click();
  await flush();
  assert.deepEqual(since(mark).find((c) => c.op === 'runs.openReport').args, { runId: '20260921-020000-schedule-cd34' });
});

t.test('Runs: a replay that passed with warnings shows their text, or says it was not kept', async () => {
  runsList.push(
    { runId: '20260921-220500-replay-warn', kind: 'replay', label: 'rec_login', startedAt: NOW - 300_000, finishedAt: NOW - 280_000, active: false, ok: true, verdict: 'PASS_WITH_WARNING', exitCode: null, frames: 0, dir: 'C:/G9BrowserAgent/runs/w1' },
    { runId: '20260921-220400-replay-warn-text', kind: 'replay', label: 'rec_login', startedAt: NOW - 400_000, finishedAt: NOW - 380_000, active: false, ok: true, verdict: 'PASS_WITH_WARNING', exitCode: null, frames: 0, dir: 'C:/G9BrowserAgent/runs/w2' },
  );
  try {
    await go('agents');
    await go('runs');
    await flush(6);
    const rows = $$('#view-runs tbody tr').filter((r) => /LoginPass with warnings/.test(r.textContent));
    assert.equal(rows.length, 2, `both warned replays are listed: ${$$('#view-runs tbody tr').map((r) => r.textContent).join(' | ')}`);
    const detail = $('#view-runs .run-detail');
    rows[0].click();
    await flush();
    assert.match(detail.textContent, /Passed with warnings; their text was not kept with this run/);
    assert.equal($('#view-runs .run-warnings'), null);
    rows[1].click();
    await flush();
    assert.match($('#view-runs .run-warnings').textContent, /live data, not a structural change/);
  } finally {
    runsList.splice(-2, 2);
  }
});

t.test('Approvals: the flow with surprises is listed; Approve asks first and never sends `by`', async () => {
  await go('approvals');
  await flush();
  assert.equal($('#approvals-count').textContent, '1');
  const view = $('#view-approvals');
  assert.match(view.textContent, /Checkout/);
  assert.doesNotMatch(view.textContent, /Login/, 'a passing flow waits for nobody');
  const mark = calls.length;
  button('Approve as qa1', view).click();
  await flush(2);
  assert.equal(since(mark).filter((c) => c.op === 'approve').length, 0, 'nothing happens before the confirmation');
  await answerModal('Approve');
  const approve = since(mark).find((c) => c.op === 'approve');
  assert.equal(approve.args.flowId, 'rec_checkout');
  assert.equal(approve.args.engine, 'launched', 'pinned to the store it was listed from');
  assert.equal(approve.args.runId, '20260921-221000-replay-ab12');
  assert.ok(!('by' in approve.args), 'the page never supplies the approver');
  assert.equal(since(mark).filter((c) => c.op === 'call' && c.args.args?.action === 'approve').length, 0, 'no direct tool call');
});

t.test('Schedule: entries with their last verdict; add sends explicit flags; run/remove use entryId', async () => {
  await go('schedule');
  await flush();
  const view = $('#view-schedule');
  assert.match(view.textContent, /Nightly smoke.*Daily at 02:00/);
  assert.match(view.textContent, /Product failure/, 'the suite\'s worst verdict, not just an exit code');
  assert.equal($('.login-hint', view).hidden, false, 'a schedule with no start at sign-in is warned about');
  const form = $('form', view);
  $('input[name="target"]', form).value = 'suite:checkout';
  $('input[name="env"]', form).value = 'test1';
  $('input[name="humanize"]', form).value = 'team-qa';
  const mark = calls.length;
  button('Add schedule', form).click();
  await flush();
  const add = since(mark).find((c) => c.op === 'admin' && c.args.op === 'schedule.add').args.args.entry;
  assert.equal(add.target, 'suite:checkout');
  assert.equal(add.daily, '06:00');
  assert.deepEqual(add.args, ['--env', 'test1', '--browser', 'auto', '--headless', '--humanize', 'team-qa', '--stealth', 'off', '--profile', 'automation']);
  assert.deepEqual(add.engine, { browser: 'auto', headless: true, humanize: 'team-qa', stealth: 'off', profile: 'automation' });
  button('Run now', view).click();
  await flush();
  button('Remove', view).click();
  await answerModal('Remove');
  const admins = since(mark).filter((c) => c.op === 'admin').map((c) => c.args);
  assert.deepEqual(admins.find((x) => x.op === 'schedule.runNow').args, { entryId: 'sch_1a2b3c4d' });
  assert.deepEqual(admins.find((x) => x.op === 'schedule.remove').args, { entryId: 'sch_1a2b3c4d' });
});

t.test('Settings: the daemon settings as a form; a calibrated profile is saved by name; updates say "not configured"', async () => {
  await go('settings');
  await flush();
  const view = $('#view-settings');
  assert.match(view.textContent, /Updates: not configured/);
  const humanize = $$('input', view).find((i) => i.value === 'human' && i.getAttribute('list'));
  assert.ok(humanize, 'human input is a text field with suggestions');
  const atLogin = $$('input[type="checkbox"]', view).find((c) => /sign in/.test(c.parentNode.textContent));
  assert.equal(atLogin.disabled, false);
  atLogin.checked = true;
  atLogin.dispatchEvent(new Event('change'));
  await flush();
  assert.deepEqual(calls.findLast((c) => c.op === 'desktop.loginItem.set').args, { enabled: true });
  humanize.value = 'team-qa';
  const mark = calls.length;
  button('Save', view).click();
  await flush();
  const set = since(mark).find((c) => c.op === 'admin' && c.args.op === 'settings.set');
  assert.deepEqual(set.args.args, { patch: { humanize: 'team-qa' } });
});

t.test('Stop all / Resume in the bar; Resume asks first', async () => {
  const mark = calls.length;
  $('#stop-all').click();
  await flush();
  assert.ok(opsSince(mark).includes('admin:halt'));
  push('state', snapshot({ halted: { global: true, by: 'panel' } }));
  await flush();
  assert.equal($('#bar').classList.contains('halted'), true);
  assert.equal($('#resume-all').hidden, false);
  assert.match($('#halt-text').textContent, /Stopped from the panel/);
  $('#resume-all').click();
  await flush(2);
  assert.ok(!opsSince(mark).includes('admin:resume'), 'not before the confirmation');
  await answerModal('Resume');
  assert.ok(opsSince(mark).includes('admin:resume'));
});

t.test('disconnected: views say so and offer Reconnect instead of failing', async () => {
  push('state', snapshot({ connection: { status: 'waiting', port: 8765, error: 'Nothing is listening on 127.0.0.1:8765.', nextRetryAt: Date.now() + 4000 } }));
  await go('agents');
  assert.match($('#conn-text').textContent, /Daemon not reachable\. Nothing is listening/);
  assert.equal($('#reconnect').hidden, false);
  assert.match($('#view-agents').textContent, /The daemon is not connected/);
  assert.equal($('#stop-all').disabled, true);
});

t.test('no console.error and no unhandled rejection anywhere above', async () => {
  await flush(4);
  assert.deepEqual(problems, []);
});

t.run();
