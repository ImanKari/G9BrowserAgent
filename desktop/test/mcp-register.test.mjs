import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite, tmpDir, rmrf } from './harness.mjs';
import {
  ENTRY_NAME, mcpClients, userConfigRoot, unstableExecReason, detectClients, shimEntry, entryForClient, planRegistration, applyRegistration, removeRegistration,
  stripJsonc, parseConfig, sameEntry, diffLines, inspectClient,
} from '../lib/mcp-register.mjs';

const t = suite('desktop: MCP client registration');
const root = tmpDir();
t.cleanup(() => rmrf(root));
const home = path.join(root, 'home');
const appData = path.join(root, 'AppData', 'Roaming');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(appData, { recursive: true });
const clients = mcpClients({ home, appData });
const byId = Object.fromEntries(clients.map((c) => [c.id, c]));

const PACKAGED = shimEntry({ isPackaged: true, execPath: 'C:\\Users\\qa\\AppData\\Local\\Programs\\G9\\G9.exe', resourceRoot: 'C:\\Users\\qa\\AppData\\Local\\Programs\\G9\\resources' });
const DEV = shimEntry({ isPackaged: false, execPath: 'electron.exe', resourceRoot: 'G:\\Projects\\G9Products\\g9-browser-agent' });

t.test('the four clients and their user-level config files', () => {
  assert.deepEqual(clients.map((c) => [c.id, c.key]), [['claude-code', 'mcpServers'], ['cursor', 'mcpServers'], ['vscode', 'servers'], ['claude-desktop', 'mcpServers']]);
  assert.equal(byId['claude-code'].file, path.join(home, '.claude.json'));
  assert.equal(byId.cursor.file, path.join(home, '.cursor', 'mcp.json'));
  assert.equal(byId.vscode.file, path.join(appData, 'Code', 'User', 'mcp.json'));
  assert.equal(byId['claude-desktop'].file, path.join(appData, 'Claude', 'claude_desktop_config.json'));
});

t.test('detection looks for the client folders', () => {
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  const d = Object.fromEntries(detectClients(clients).map((c) => [c.id, c.installed]));
  assert.deepEqual(d, { 'claude-code': false, cursor: true, vscode: false, 'claude-desktop': false });
});

t.test('entry: packaged G9.exe + ELECTRON_RUN_AS_NODE + resources/mcp/shim.mjs; dev node + repo shim; forward slashes', () => {
  assert.deepEqual(PACKAGED, {
    command: 'C:/Users/qa/AppData/Local/Programs/G9/G9.exe',
    args: ['C:/Users/qa/AppData/Local/Programs/G9/resources/mcp/shim.mjs'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.deepEqual(DEV, { command: 'node', args: ['G:/Projects/G9Products/g9-browser-agent/mcp/shim.mjs'] });
  const custom = shimEntry({ isPackaged: false, execPath: 'x', resourceRoot: 'C:\\r', port: 18765, homeOverride: 'D:\\g9' });
  assert.deepEqual(custom.env, { G9_PORT: '18765', G9_HOME: 'D:/g9' });
  assert.deepEqual(entryForClient(byId.vscode, DEV), { type: 'stdio', ...DEV });
  assert.deepEqual(entryForClient(byId.cursor, DEV), DEV);
});

t.test('JSONC: comments and trailing commas are understood, strings are left alone', () => {
  const text = '{\n  // servers\n  "servers": { "a": { "command": "http://x//y", "args": ["/*not a comment*/"], }, },\n  /* block */ "x": 1\n}';
  const p = parseConfig(text);
  assert.equal(p.ok, true);
  assert.equal(p.jsonc, true);
  assert.equal(p.value.servers.a.command, 'http://x//y');
  assert.deepEqual(p.value.servers.a.args, ['/*not a comment*/']);
  assert.equal(parseConfig('{ "a": 1 }').jsonc, false);
  assert.equal(parseConfig('{ nope').ok, false);
  assert.equal(stripJsonc('"a\\"//b"'), '"a\\"//b"');
});

t.test('plan: create / add / same / different / invalid', () => {
  const c = byId.cursor;
  assert.equal(planRegistration(c, null, DEV).status, 'create');
  assert.equal(planRegistration(c, '{"mcpServers":{"other":{"command":"x"}}}', DEV).status, 'add');
  assert.equal(planRegistration(c, JSON.stringify({ mcpServers: { [ENTRY_NAME]: { args: ['G:\\Projects\\G9Products\\g9-browser-agent\\mcp\\shim.mjs'], command: 'node' } } }), DEV).status, 'same', 'slash direction and key order do not matter');
  const diff = planRegistration(c, JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: 'node', args: ['G:/old/bridge/src/server.js'], env: { G9_HOST: '127.0.0.1', G9_PORT: '8765' } } } }), DEV);
  assert.equal(diff.status, 'different');
  assert.match(diff.note, /v1 entry/);
  assert.ok(diff.diff.some((d) => d.op === '-' && d.line.includes('bridge/src/server.js')));
  assert.ok(diff.diff.some((d) => d.op === '+' && d.line.includes('mcp/shim.mjs')));
  assert.equal(planRegistration(c, '[1,2]', DEV).status, 'invalid');
  assert.equal(planRegistration(c, '{"mcpServers": []}', DEV).status, 'invalid');
  assert.equal(planRegistration(c, '{ broken', DEV).status, 'invalid');
});

t.test('register into ~/.claude.json keeps every other key, backs up first, verifies by reading back', () => {
  const c = byId['claude-code'];
  const original = { numStartups: 42, projects: { 'G:/x': { history: ['a', 'b'], allowedTools: [] } }, mcpServers: { other: { type: 'stdio', command: 'x', args: [] } }, userID: 'abc' };
  fs.writeFileSync(c.file, JSON.stringify(original, null, 2));
  const r = applyRegistration(c, PACKAGED);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.changed, true);
  assert.ok(r.backup && fs.existsSync(r.backup), 'backup written');
  assert.deepEqual(JSON.parse(fs.readFileSync(r.backup, 'utf8')), original, 'the backup is the untouched original');
  const now = JSON.parse(fs.readFileSync(c.file, 'utf8'));
  assert.deepEqual(now.projects, original.projects);
  assert.equal(now.numStartups, 42);
  assert.deepEqual(now.mcpServers.other, original.mcpServers.other);
  assert.deepEqual(now.mcpServers[ENTRY_NAME], { type: 'stdio', ...PACKAGED });
  const again = applyRegistration(c, PACKAGED);
  assert.equal(again.changed, false, 'running it twice changes nothing');
});

t.test('a different existing entry is never overwritten without confirmation', () => {
  const c = byId['claude-desktop'];
  fs.mkdirSync(path.dirname(c.file), { recursive: true });
  const mine = { mcpServers: { [ENTRY_NAME]: { command: 'C:/custom/g9.cmd', args: [] } } };
  fs.writeFileSync(c.file, JSON.stringify(mine));
  const r = applyRegistration(c, PACKAGED);
  assert.equal(r.ok, false);
  assert.equal(r.needsConfirm, 'replace');
  assert.ok(r.diff.length);
  assert.deepEqual(JSON.parse(fs.readFileSync(c.file, 'utf8')), mine, 'file untouched');
  const backupsBefore = fs.readdirSync(path.dirname(c.file)).filter((f) => f.includes('g9-backup')).length;
  assert.equal(backupsBefore, 0, 'no backup either: nothing was written');
  const ok = applyRegistration(c, PACKAGED, { confirmReplace: true });
  assert.equal(ok.ok, true);
  assert.ok(fs.existsSync(ok.backup));
  assert.deepEqual(JSON.parse(fs.readFileSync(c.file, 'utf8')).mcpServers[ENTRY_NAME], PACKAGED);
});

t.test('VS Code mcp.json uses "servers" with type stdio; comments need their own confirmation', () => {
  const c = byId.vscode;
  fs.mkdirSync(path.dirname(c.file), { recursive: true });
  fs.writeFileSync(c.file, '{\n  // my servers\n  "servers": {\n    "git": { "type": "stdio", "command": "git-mcp" },\n  },\n}\n');
  const r1 = applyRegistration(c, DEV);
  assert.equal(r1.needsConfirm, 'comments');
  const r2 = applyRegistration(c, DEV, { confirmDropComments: true });
  assert.equal(r2.ok, true, r2.message);
  const now = JSON.parse(fs.readFileSync(c.file, 'utf8'));
  assert.deepEqual(now.servers.git, { type: 'stdio', command: 'git-mcp' });
  assert.deepEqual(now.servers[ENTRY_NAME], { type: 'stdio', command: 'node', args: ['G:/Projects/G9Products/g9-browser-agent/mcp/shim.mjs'] });
  assert.equal(now.mcpServers, undefined, 'VS Code does not read mcpServers');
});

t.test('a missing file is created with just the entry; an unreadable one is never written', () => {
  const c = byId.cursor;
  fs.rmSync(c.file, { force: true });
  const r = applyRegistration(c, DEV);
  assert.equal(r.ok, true);
  assert.equal(r.backup, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(c.file, 'utf8')), { mcpServers: { [ENTRY_NAME]: DEV } });
  fs.writeFileSync(c.file, '{ "mcpServers": { oops');
  const bad = applyRegistration(c, DEV);
  assert.equal(bad.ok, false);
  assert.equal(fs.readFileSync(c.file, 'utf8'), '{ "mcpServers": { oops', 'untouched');
  assert.deepEqual(bad.snippet, { mcpServers: { [ENTRY_NAME]: DEV } }, 'the person gets the entry to paste');
});

t.test('inspectClient never throws on an unreadable path', () => {
  const weird = { ...byId.cursor, file: root }; // a directory: readFileSync fails with EISDIR
  const r = inspectClient(weird, DEV);
  assert.equal(r.status, 'invalid');
});

t.test('remove takes out only the g9-browser entry, after a backup', () => {
  const c = byId['claude-code'];
  const r = removeRegistration(c);
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(r.backup));
  const now = JSON.parse(fs.readFileSync(c.file, 'utf8'));
  assert.equal(now.mcpServers[ENTRY_NAME], undefined);
  assert.ok(now.mcpServers.other);
  assert.equal(removeRegistration(c).changed, false);
});

t.test('JSONC: a trailing-comma lookalike INSIDE a string survives the rewrite of the whole file', () => {
  const c = byId.vscode;
  fs.mkdirSync(path.dirname(c.file), { recursive: true });
  // Another server's arguments contain ", }" and ",]" — a regex over the whole text ate those commas.
  const text = '{\n  // mine\n  "servers": {\n    "other": { "type": "stdio", "command": "x", "args": ["--fmt", "{a, }", "[1,]"], },\n  },\n}\n';
  assert.deepEqual(parseConfig(text).value.servers.other.args, ['--fmt', '{a, }', '[1,]']);
  fs.writeFileSync(c.file, text);
  const r = applyRegistration(c, DEV, { confirmDropComments: true });
  assert.equal(r.ok, true, r.message);
  const now = JSON.parse(fs.readFileSync(c.file, 'utf8'));
  assert.deepEqual(now.servers.other.args, ['--fmt', '{a, }', '[1,]'], 'string values are written back exactly');
  assert.ok(now.servers[ENTRY_NAME]);
  fs.rmSync(c.file, { force: true });
});

t.test('remove: a JSONC file asks before dropping its comments; odd shapes are refused, never thrown on', () => {
  const c = byId.vscode;
  fs.mkdirSync(path.dirname(c.file), { recursive: true });
  fs.writeFileSync(c.file, `{\n  // keep me\n  "servers": { "${ENTRY_NAME}": { "command": "node" }, "other": { "command": "y" } }\n}\n`);
  const ask = removeRegistration(c);
  assert.equal(ask.ok, false);
  assert.equal(ask.needsConfirm, 'comments');
  assert.match(fs.readFileSync(c.file, 'utf8'), /keep me/, 'nothing written before the confirmation');
  const done = removeRegistration(c, { confirmDropComments: true });
  assert.equal(done.ok, true);
  assert.ok(fs.existsSync(done.backup));
  const now = JSON.parse(fs.readFileSync(c.file, 'utf8'));
  assert.equal(now.servers[ENTRY_NAME], undefined);
  assert.ok(now.servers.other);
  fs.writeFileSync(c.file, '{ "servers": "not an object" }');
  const odd = removeRegistration(c);
  assert.equal(odd.ok, false);
  assert.equal(odd.changed, false);
  fs.writeFileSync(c.file, '[1, 2]');
  assert.equal(removeRegistration(c).ok, false);
  fs.rmSync(c.file, { force: true });
});

t.test('sameEntry and diffLines', () => {
  assert.equal(sameEntry({ type: 'stdio', command: 'a', args: ['b'] }, { args: ['b'], command: 'a' }), true);
  assert.equal(sameEntry({ command: 'a', args: ['b'], env: {} }, { command: 'a', args: ['b'] }), true);
  assert.equal(sameEntry({ command: 'a', args: ['c'] }, { command: 'a', args: ['b'] }), false);
  const d = diffLines({ a: 1, b: 2 }, { a: 1, b: 3 });
  assert.deepEqual(d.filter((x) => x.op !== ' ').map((x) => `${x.op}${x.line.trim()}`), ['-"b": 2', '+"b": 3']);
});

t.test('config locations per OS: VS Code and Claude Desktop under %APPDATA%, ~/Library/Application Support, or $XDG_CONFIG_HOME (~/.config)', () => {
  assert.equal(userConfigRoot({ platform: 'win32', env: { APPDATA: 'C:\\Users\\qa\\AppData\\Roaming' }, home: 'C:\\Users\\qa' }), 'C:\\Users\\qa\\AppData\\Roaming');
  assert.equal(userConfigRoot({ platform: 'darwin', env: {}, home: '/Users/qa' }), path.join('/Users/qa', 'Library', 'Application Support'));
  assert.equal(userConfigRoot({ platform: 'linux', env: {}, home: '/home/qa' }), path.join('/home/qa', '.config'));
  assert.equal(userConfigRoot({ platform: 'linux', env: { XDG_CONFIG_HOME: '/home/qa/cfg' }, home: '/home/qa' }), '/home/qa/cfg');
  const mac = Object.fromEntries(mcpClients({ home: '/Users/qa', platform: 'darwin', env: {} }).map((c) => [c.id, c]));
  assert.equal(mac.vscode.file, path.join('/Users/qa', 'Library', 'Application Support', 'Code', 'User', 'mcp.json'));
  assert.equal(mac['claude-desktop'].file, path.join('/Users/qa', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  assert.match(mac['claude-desktop'].restartHint, /Cmd\+Q/);
  assert.equal(mac['claude-code'].file, path.join('/Users/qa', '.claude.json'), 'Claude Code and Cursor keep one place on every OS');
  const linux = Object.fromEntries(mcpClients({ home: '/home/qa', platform: 'linux', env: {} }).map((c) => [c.id, c]));
  assert.equal(linux.vscode.file, path.join('/home/qa', '.config', 'Code', 'User', 'mcp.json'));
  assert.equal(linux.cursor.file, path.join('/home/qa', '.cursor', 'mcp.json'));
});

t.test('a Linux AppImage entry names the .AppImage file and the bootstrap, never the temporary mount', () => {
  const e = shimEntry({ isPackaged: true, execPath: '/tmp/.mount_G9q/g9', resourceRoot: '/tmp/.mount_G9q/resources', appImage: { file: '/home/qa/Apps/G9.AppImage', bootstrap: '/home/qa/.g9/bin/g9-run.mjs' } });
  assert.deepEqual(e, { command: '/home/qa/Apps/G9.AppImage', args: ['/home/qa/.g9/bin/g9-run.mjs', 'mcp/shim.mjs', '--no-sandbox'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(unstableExecReason({ execPath: '/Applications/G9.app/Contents/MacOS/G9', platform: 'darwin' }), null);
  assert.match(unstableExecReason({ execPath: '/private/var/folders/a/T/AppTranslocation/X/d/G9.app/Contents/MacOS/G9', platform: 'darwin' }), /App Translocation/);
  assert.equal(unstableExecReason({ execPath: 'C:/Users/qa/AppData/Local/Programs/G9/G9.exe', platform: 'win32' }), null);
});

t.run();
