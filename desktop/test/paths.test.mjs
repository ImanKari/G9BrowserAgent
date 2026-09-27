import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite, tmpDir, rmrf } from './harness.mjs';
import { defaultHomes, adoptLegacyHome, resolveAppHome, looksLikeG9Home, MIGRATION_MARKER } from '../lib/paths.mjs';
import * as shared from '../../lib/home.mjs';

// The data folder's one-time move from its pre-3.2.1 name (%LOCALAPPDATA%\G9, ~/.g9) to
// %LOCALAPPDATA%\G9BrowserAgent / ~/.g9browseragent. Always against temporary folders: resolving the
// real default would move this machine's own data folder.

const t = suite('desktop: the data folder and its move to the new name');
const root = tmpDir();
t.cleanup(() => rmrf(root));
let n = 0;
const profile = () => {
  const dir = path.join(root, `p${++n}`);
  fs.mkdirSync(path.join(dir, 'AppData', 'Local'), { recursive: true });
  return dir;
};
const g9Folder = (dir) => {
  fs.mkdirSync(path.join(dir, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"port":8765}');
  fs.writeFileSync(path.join(dir, 'extension', 'manifest.json'), '{"name":"G9 Browser Agent"}');
};

t.test('the names: G9BrowserAgent and .g9browseragent, before them G9 and .g9', () => {
  assert.deepEqual(defaultHomes({ env: { LOCALAPPDATA: 'C:\\Users\\qa\\AppData\\Local' }, platform: 'win32', homedir: 'C:\\Users\\qa' }),
    { home: path.join('C:\\Users\\qa\\AppData\\Local', 'G9BrowserAgent'), legacy: path.join('C:\\Users\\qa\\AppData\\Local', 'G9') });
  assert.deepEqual(defaultHomes({ env: {}, platform: 'linux', homedir: '/home/qa' }),
    { home: path.join('/home/qa', '.g9browseragent'), legacy: path.join('/home/qa', '.g9') });
});

t.test('an old G9 folder is moved once, with everything in it, and leaves a note for the app', () => {
  const p = profile();
  const env = { LOCALAPPDATA: path.join(p, 'AppData', 'Local') };
  const { home, legacy } = defaultHomes({ env, platform: 'win32', homedir: p });
  g9Folder(legacy);
  const r = resolveAppHome({ env, platform: 'win32', homedir: p });
  assert.equal(r.home, home);
  assert.equal(r.migratedFrom, legacy);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.readFileSync(path.join(home, 'extension', 'manifest.json'), 'utf8'), '{"name":"G9 Browser Agent"}');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, MIGRATION_MARKER), 'utf8')).from, legacy);
  assert.deepEqual(resolveAppHome({ env, platform: 'win32', homedir: p }), { home }, 'the second time there is nothing to move');
});

t.test('a folder that is not G9\'s, a home that already exists, and G9_HOME are never moved', () => {
  const p = profile();
  const env = { LOCALAPPDATA: path.join(p, 'AppData', 'Local') };
  const { home, legacy } = defaultHomes({ env, platform: 'linux', homedir: p });
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'notes.txt'), 'someone else\'s ~/.g9');
  assert.equal(looksLikeG9Home(legacy), false);
  assert.deepEqual(resolveAppHome({ env, platform: 'linux', homedir: p }), { home });
  assert.ok(fs.existsSync(path.join(legacy, 'notes.txt')), 'a stranger\'s folder stays where it is');
  g9Folder(legacy);
  fs.mkdirSync(home);
  assert.deepEqual(resolveAppHome({ env, platform: 'linux', homedir: p }), { home }, 'a new home that exists wins; nothing is merged');
  assert.ok(fs.existsSync(legacy));
  const custom = path.join(p, 'custom');
  assert.deepEqual(resolveAppHome({ env: { ...env, G9_HOME: custom }, platform: 'linux', homedir: p }), { home: path.resolve(custom) });
});

t.test('when the move fails (files held open by an older daemon), the old folder stays in use — both components agree', () => {
  const p = profile();
  const env = { LOCALAPPDATA: path.join(p, 'AppData', 'Local') };
  const homes = defaultHomes({ env, platform: 'win32', homedir: p });
  g9Folder(homes.legacy);
  const busy = { ...fs, renameSync: () => { const e = new Error('resource busy or locked'); e.code = 'EBUSY'; throw e; } };
  const r = adoptLegacyHome(homes, { fsApi: busy });
  assert.equal(r.home, homes.legacy);
  assert.match(r.error, /EBUSY/);
  const s = shared.adoptLegacyHome(homes, { fs: busy });
  assert.equal(s.home, homes.legacy, 'lib/home.mjs (the daemon, the shim, the engine) chooses the same folder');
});

t.test('lib/home.mjs and this copy agree on every case', () => {
  for (const [platform, homedir] of [['win32', 'C:\\Users\\qa'], ['linux', '/home/qa'], ['darwin', '/Users/qa']]) {
    const env = platform === 'win32' ? { LOCALAPPDATA: 'C:\\Users\\qa\\AppData\\Local' } : {};
    const a = defaultHomes({ env, platform, homedir });
    const b = shared.defaultHomes({ env, platform, homedir });
    // The same folder, whatever separator the joining used (a Windows path tested on Linux keeps its backslashes).
    const same = (x) => x.replace(/[\\/]+/g, '/');
    assert.equal(same(a.home), same(b.home), `${platform} home`);
    assert.equal(same(a.legacy), same(b.legacy), `${platform} legacy`);
  }
  const p = profile();
  const env = { LOCALAPPDATA: path.join(p, 'AppData', 'Local') };
  const homes = shared.defaultHomes({ env, platform: process.platform, homedir: p });
  g9Folder(homes.legacy);
  // A library call only looks: the old folder, untouched, until an owner (the daemon, the app) moves it.
  assert.equal(shared.resolveDefaultHome({ env, platform: process.platform, homedir: p }), path.normalize(homes.legacy));
  assert.ok(fs.existsSync(homes.legacy) && !fs.existsSync(homes.home), 'nothing moved by looking');
  assert.equal(shared.resolveDefaultHome({ env, platform: process.platform, homedir: p, migrate: true }), path.normalize(homes.home));
  assert.ok(fs.existsSync(path.join(homes.home, MIGRATION_MARKER)), 'the daemon side leaves the same note');
  assert.equal(shared.resolveDefaultHome({ env, platform: process.platform, homedir: p }), path.normalize(homes.home), 'and then everyone names the new folder');
  assert.equal(shared.MIGRATION_MARKER, MIGRATION_MARKER);
});

t.run();
