/**
 * One version for the whole product (ARCHITECTURE §2, plan D12).
 *
 * v1 announced its version in three places and they drifted (v1.7.13): the
 * bridge warned people to reload an extension that was already correct. The
 * fix is structural — one package.json, everything else reads or mirrors it —
 * and this test is what keeps the mirrors honest.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const pkg = readJson('package.json');

test('root package.json carries a semver version', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  assert.equal(pkg.type, 'module', 'the repo is ESM: bridge/, daemon/, extension/ rely on it for .js files');
  assert.ok(pkg.engines?.node && /22/.test(pkg.engines.node), 'engines.node requires Node 22');
  assert.ok(!pkg.dependencies || !Object.keys(pkg.dependencies).length, 'the core has zero dependencies (D11)');
});

test('extension/manifest.json version equals package.json', () => {
  const manifest = readJson('extension/manifest.json');
  assert.equal(manifest.version, pkg.version,
    `extension/manifest.json is ${manifest.version} but package.json is ${pkg.version} — bump both together`);
});

test('desktop/package.json version equals package.json (when desktop/ exists)', () => {
  const file = path.join(ROOT, 'desktop', 'package.json');
  if (!existsSync(file)) {
    console.log('  (desktop/package.json not present — skipped)');
    return;
  }
  const desktop = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(desktop.version, pkg.version,
    `desktop/package.json is ${desktop.version} but package.json is ${pkg.version} — bump both together`);
});

/**
 * The lock file carries the version too, and nothing else checks it.
 *
 * `npm ci` in desktop/ installs from the lock file, so a lock left on the old
 * version quietly produces a build whose package disagrees with the app. The
 * confirmation run of 2026-09-23 found exactly this gap: three files were
 * bumped, the lock was not covered by any test.
 */
test('desktop/package-lock.json version equals package.json (when it exists)', () => {
  const file = path.join(ROOT, 'desktop', 'package-lock.json');
  if (!existsSync(file)) {
    console.log('  (desktop/package-lock.json not present — skipped)');
    return;
  }
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(lock.version, pkg.version,
    `desktop/package-lock.json is ${lock.version} but package.json is ${pkg.version} — run npm install in desktop/ after a bump`);
  const root = lock.packages?.[''];
  if (root) {
    assert.equal(root.version, pkg.version,
      `desktop/package-lock.json packages[""] is ${root.version} but package.json is ${pkg.version}`);
  }
});

test('no second package.json announces a version in the core', () => {
  assert.equal(existsSync(path.join(ROOT, 'bridge', 'package.json')), false, 'bridge/package.json must be gone in v2');
  for (const dir of ['daemon', 'mcp', 'engine', 'runner', 'lib', 'extension']) {
    assert.equal(existsSync(path.join(ROOT, dir, 'package.json')), false, `${dir}/package.json would be a second version source`);
  }
});

test('lib/version.mjs reads package.json', async () => {
  const { VERSION, REPO_ROOT, PACKAGE_JSON, majorOf } = await import('../../lib/version.mjs');
  assert.equal(VERSION, pkg.version);
  assert.equal(path.resolve(REPO_ROOT), ROOT);
  assert.equal(path.resolve(PACKAGE_JSON), path.join(ROOT, 'package.json'));
  assert.equal(majorOf('2.0.0'), 2);
  assert.equal(majorOf('v1.7.21'), 1);
  assert.ok(Number.isNaN(majorOf('garbage')));
  assert.ok(Number.isNaN(majorOf(undefined)));
});

test('package.json scripts cover the documented suites', () => {
  for (const script of ['test', 'test:unit', 'test:self', 'test:ext', 'test:engine2', 'test:live', 'test:stealth', 'bench', 'matrix', 'endurance', 'daemon', 'shim']) {
    assert.ok(pkg.scripts?.[script], `missing npm script "${script}"`);
  }
  assert.equal(pkg.scripts.test, 'node setup/unittest.mjs && node setup/selftest.mjs && node setup/extensiontest.mjs',
    '"npm test" is the three offline suites');
  assert.match(pkg.scripts['test:engine2'], /setup\/engine2-livetest\.mjs/);
  assert.match(pkg.scripts['test:live'], /setup\/isolated-livetest\.mjs/);
  assert.match(pkg.scripts['test:stealth'], /setup\/stealthtest\.mjs/);
});

test('every package.json script and bin points at a file that exists', () => {
  // A script naming a file that is not there fails only when someone runs it (v2.0.0 shipped
  // test:engine2 before its file existed). Each `node <file>` in each script is checked.
  const missing = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    const files = [...String(cmd).matchAll(/(?:^|&&|\|\||;)\s*node\s+(?:--?[\w-]+(?:=\S+)?\s+)*([^\s&|;]+)/g)].map((m) => m[1]);
    assert.ok(files.length, `script "${name}" runs no node file ("${cmd}")`);
    for (const f of files) if (!existsSync(path.join(ROOT, f))) missing.push(`${name}: ${f}`);
  }
  for (const [name, f] of Object.entries(pkg.bin ?? {})) if (!existsSync(path.join(ROOT, f))) missing.push(`bin ${name}: ${f}`);
  assert.deepEqual(missing, [], `missing files: ${missing.join(', ')}`);
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}\n${err?.stack ?? err}`);
    process.exit(1);
  }
}
