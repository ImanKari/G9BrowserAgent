import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite, tmpDir, rmrf } from './harness.mjs';
import { DesktopSettings, detectUpdate, DESKTOP_DEFAULTS } from '../lib/settings.mjs';
import { SETTINGS_FIELDS, readField, buildSettingsPatch, pickUpdateConfig, validateUpdateUrl, coerceField, getPath } from '../renderer/lib/settings-form.js';
import { g9Home, daemonPort, homeLayout, resourceRoot, resourcePaths, forwardSlashes, osUserName } from '../lib/paths.mjs';
import { createLogger, tailLog, formatLine } from '../lib/log.mjs';
import { writeJsonAtomic, readJson, deepMerge } from '../lib/jsonfile.mjs';

const t = suite('desktop: paths, settings, logs');
const dir = tmpDir();
t.cleanup(() => rmrf(dir));

t.test('G9_HOME: env override, else %LOCALAPPDATA%\\G9 on Windows, else ~/.g9', () => {
  assert.equal(g9Home({ env: { G9_HOME: dir }, platform: 'win32' }), path.resolve(dir));
  assert.equal(g9Home({ env: { LOCALAPPDATA: 'C:\\Users\\qa\\AppData\\Local' }, platform: 'win32' }), path.join('C:\\Users\\qa\\AppData\\Local', 'G9'));
  assert.equal(g9Home({ env: {}, platform: 'linux', homedir: '/home/qa' }), path.join('/home/qa', '.g9'));
});

t.test('port: G9_PORT when valid, else 8765', () => {
  assert.equal(daemonPort({ G9_PORT: '18001' }), 18001);
  assert.equal(daemonPort({}), 8765);
  assert.equal(daemonPort({ G9_PORT: 'abc' }), 8765);
  assert.equal(daemonPort({ G9_PORT: '70000' }), 8765);
});

t.test('layout and resource roots (packaged → resourcesPath, dev → repo root)', () => {
  const l = homeLayout('C:\\h');
  assert.equal(l.installLog, path.join('C:\\h', 'logs', 'install.log'));
  assert.equal(l.policiesJson, path.join('C:\\h', 'logs', 'policies.json'));
  assert.equal(l.extension, path.join('C:\\h', 'extension'));
  assert.equal(resourceRoot({ isPackaged: true, resourcesPath: 'C:\\app\\resources', appDir: 'x' }), 'C:\\app\\resources');
  assert.equal(resourceRoot({ isPackaged: false, appDir: path.join('G:\\repo', 'desktop') }), path.resolve('G:\\repo'));
  const r = resourcePaths('C:\\res');
  assert.equal(r.daemonScript, path.join('C:\\res', 'daemon', 'g9d.mjs'));
  assert.equal(r.shimScript, path.join('C:\\res', 'mcp', 'shim.mjs'));
  assert.equal(forwardSlashes('C:\\a\\b'), 'C:/a/b');
  assert.equal(osUserName({ userInfo: () => ({ username: 'qa1' }) }), 'qa1');
  assert.equal(osUserName({ env: { USERNAME: 'qa2' }, userInfo: () => { throw new Error('x'); } }), 'qa2');
});

t.test('desktop.json: defaults, deep patches persisted atomically, wizard completion after all five', () => {
  const file = path.join(dir, 'desktop.json');
  const s = new DesktopSettings(file);
  assert.deepEqual(s.get().wizard, DESKTOP_DEFAULTS.wizard);
  s.patch({ window: { width: 1300 } });
  assert.deepEqual(readJson(file).window, { width: 1300, height: 720 });
  const ids = ['browsers', 'profile', 'policies', 'mcp', 'extension'];
  for (const id of ids.slice(0, 4)) s.recordStep(id, { ok: true }, ids);
  assert.equal(s.get().wizard.completedAt, null);
  s.recordStep('extension', { ok: false, skipped: true }, ids);
  assert.ok(s.get().wizard.completedAt, 'skipped counts as handled');
  const again = new DesktopSettings(file);
  assert.equal(again.get().wizard.steps.mcp.ok, true);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp files left behind');
});

t.test('update detection: first start is not an update; a changed version is', () => {
  assert.equal(detectUpdate(null, '2.0.0').updated, false);
  assert.equal(detectUpdate('2.0.0', '2.0.0').updated, false);
  assert.deepEqual(detectUpdate('2.0.0', '2.0.1'), { updated: true, from: '2.0.0', to: '2.0.1' });
});

t.test('settings form: reads whichever path the daemon reports, writes back to that same path', () => {
  const humanize = SETTINGS_FIELDS.find((f) => f.key === 'humanize');
  assert.deepEqual(readField({ defaults: { humanize: 'stealth' } }, humanize), { value: 'stealth', path: 'defaults.humanize', present: true });
  assert.deepEqual(readField({}, humanize), { value: 'human', path: 'humanize', present: false });
  // The daemon's own keys (daemon/settings.js DEFAULTS).
  const MB = 1024 * 1024;
  const current = { humanize: 'human', defaultBrowser: 'auto', evidence: { maxFrames: 3000, maxBytes: 300 * MB, keepRuns: 200 }, idleExitMinutes: 60, updateUrl: '' };
  assert.equal(readField(current, SETTINGS_FIELDS.find((f) => f.key === 'evidenceMaxMB')).value, 300, 'bytes shown as MB');
  const { patch, changed } = buildSettingsPatch(current, { humanize: 'off', browser: 'edge', evidenceMaxMB: '500', idleExitMinutes: '60', updateUrl: 'https://u.example/g9/' });
  assert.deepEqual(patch, { humanize: 'off', defaultBrowser: 'edge', evidence: { maxBytes: 500 * MB }, updateUrl: 'https://u.example/g9/' });
  assert.deepEqual(changed.sort(), ['browser', 'evidenceMaxMB', 'humanize', 'updateUrl']);
  const unchanged = buildSettingsPatch(current, { humanize: 'human', idleExitMinutes: 60, evidenceMaxMB: 300 });
  assert.deepEqual(unchanged.patch, {});
  // A key this daemon does not report is written at its preferred (first) path.
  assert.deepEqual(buildSettingsPatch({}, { updateChannel: 'beta' }).patch, { updateChannel: 'beta' });
});

t.test('settings form: coercion errors name the field', () => {
  const idle = SETTINGS_FIELDS.find((f) => f.key === 'idleExitMinutes');
  assert.throws(() => coerceField(idle, 'soon'), /Exit when idle.*enter a number/);
  assert.throws(() => coerceField(idle, '-1'), /minimum is 0/);
  assert.throws(() => coerceField(idle, '1.5'), /whole number/);
  assert.equal(coerceField(idle, '0'), 0, '0 = never exit');
  const browser = SETTINGS_FIELDS.find((f) => f.key === 'browser');
  assert.throws(() => coerceField(browser, 'firefox'), /choose one of auto, edge, chrome, cft/);
  assert.equal(coerceField(SETTINGS_FIELDS.find((f) => f.key === 'headless'), 'on'), true);
  // Human input takes a level or a calibrated profile's name (plan §6.7) — kept, never coerced to a level.
  const humanize = SETTINGS_FIELDS.find((f) => f.key === 'humanize');
  assert.equal(coerceField(humanize, 'team-qa'), 'team-qa');
  assert.equal(coerceField(humanize, ' stealth '), 'stealth');
  assert.throws(() => coerceField(humanize, '../evil'), /calibrated profile name/);
  assert.throws(() => coerceField(humanize, ''), /Human input/);
  // A stored profile name is not a change: saving the form untouched writes nothing.
  assert.deepEqual(buildSettingsPatch({ humanize: 'team-qa' }, { humanize: 'team-qa' }), { patch: {}, changed: [] });
  // Stealth stays a closed list (the daemon refuses anything else).
  assert.throws(() => coerceField(SETTINGS_FIELDS.find((f) => f.key === 'stealth'), 'team-qa'), /choose one of off, human, stealth./);
  assert.throws(() => buildSettingsPatch({}, { updateUrl: 'ftp://x' }), /https:\/\//);
  // https only over the network; http is kept for a loopback test feed (desktop review).
  assert.throws(() => buildSettingsPatch({}, { updateUrl: 'http://updates.example/g9/' }), /only by TLS/);
  assert.deepEqual(buildSettingsPatch({}, { updateUrl: 'http://127.0.0.1:18080/g9/' }).changed, ['updateUrl']);
});

t.test('update URL validation and pickUpdateConfig (daemon first, desktop cache second)', () => {
  assert.equal(validateUpdateUrl(''), null);
  assert.equal(validateUpdateUrl('https://a/b'), null);
  assert.match(validateUpdateUrl('https://u:p@a/b'), /credentials/);
  assert.match(validateUpdateUrl('nope'), /not a valid URL/);
  assert.match(validateUpdateUrl('file:///C:/share'), /https:\/\//);
  assert.match(validateUpdateUrl('http://updates.example/g9/'), /only by TLS/);
  assert.equal(validateUpdateUrl('http://localhost:18080/g9/'), null, 'a loopback test feed stays allowed');
  assert.deepEqual(pickUpdateConfig({ updateUrl: 'https://d/', updateChannel: 'beta' }, { url: 'https://c/' }), { url: 'https://d/', channel: 'beta', source: 'daemon' });
  assert.deepEqual(pickUpdateConfig({ update: { url: 'https://old/', channel: 'stable' } }), { url: 'https://old/', channel: 'stable', source: 'daemon' });
  assert.deepEqual(pickUpdateConfig({}, { url: 'https://c/', channel: 'stable' }), { url: 'https://c/', channel: 'stable', source: 'desktop' });
  assert.deepEqual(pickUpdateConfig({}, {}), { url: '', channel: 'stable', source: 'none' });
  assert.equal(getPath({ a: { b: 0 } }, 'a.b'), 0);
});

t.test('logs: one line per event, rotation-safe, never throwing; tail for the Setup view', () => {
  const file = path.join(dir, 'logs', 'install.log');
  const log = createLogger(file);
  log.info('Setup: policies applied', { count: 10 });
  log.warn('MCP Cursor: file not valid JSON');
  const lines = tailLog(file);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT.*INFO  Setup: policies applied \{"count":10\}$/);
  assert.match(lines[1], /WARN  MCP Cursor/);
  const broken = createLogger(path.join(dir, 'no\0such', 'x.log'));
  broken.info('does not throw');
  assert.match(formatLine('info', 'x', 'y'.repeat(5000)), /… \(5000 chars\)/);
  assert.deepEqual(tailLog(path.join(dir, 'missing.log')), []);
});

t.test('atomic JSON writes and deepMerge', () => {
  const f = path.join(dir, 'x', 'y.json');
  writeJsonAtomic(f, { a: 1 });
  assert.deepEqual(readJson(f), { a: 1 });
  assert.equal(readJson(path.join(dir, 'nope.json'), 'fallback'), 'fallback');
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { b: 3 }, d: [2], e: undefined }), { a: { b: 3, c: 2 }, d: [2] });
});

t.run();
