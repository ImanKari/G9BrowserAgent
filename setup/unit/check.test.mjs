#!/usr/bin/env node
/**
 * setup/check-plan.mjs and setup/doclinks.mjs: which checks a change runs, and the guides' links.
 * The plan decides what is NOT run, so what it must never do is skip a check a change can reach;
 * these tests pin that down on the real repository. No browser, no network, no ports.
 *
 * Run: node setup/unit/check.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  CHECKS, NO_CHECK, FULL_RUN, ROOT, globToRegExp, matches, closuresFor, planFor, estimateSeconds, referencesOf,
} from '../check-plan.mjs';
import { slug, anchorsOf, brokenLinks } from '../doclinks.mjs';

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n${err?.stack ?? err}`);
    process.exit(1);
  }
}

const closures = closuresFor();
const ids = (plan) => plan.checks.map((c) => c.id).sort();
// This file names repository paths as strings, and the literal scan counts those, so unit:check
// "reaches" every path used below: an over-approximation of one second. Assertions about what a
// change reaches look past it.
const others = (plan) => ids(plan).filter((id) => id !== 'unit:check');
const offlineIds = CHECKS.filter((c) => c.tier === 'offline').map((c) => c.id).sort();

await test('globs: * stays within a segment, ** crosses them, **/ may match nothing', () => {
  assert.ok(globToRegExp('extension/*.js').test('extension/sw.js'));
  assert.ok(!globToRegExp('extension/*.js').test('extension/lib/cdp.js'));
  assert.ok(globToRegExp('extension/**').test('extension/lib/cdp.js'));
  assert.ok(globToRegExp('**/*.md').test('README.md'));
  assert.ok(globToRegExp('**/*.md').test('docs/INSTALL.md'));
  assert.ok(globToRegExp('extension/lib/platform*.js').test('extension/lib/platform-cdp.js'));
  assert.ok(!globToRegExp('setup/*.html').test('setup/fixtures/stealth-local.html'));
  assert.ok(matches('a/b.c', ['x/**', 'a/*.c']));
});

await test('every check names files that exist, and every unit suite has a check', () => {
  for (const c of CHECKS) {
    for (const f of [...c.entry, c.cmd[0]]) assert.ok(fs.existsSync(path.join(ROOT, f)), `${c.id}: ${f}`);
  }
  const suites = fs.readdirSync(path.join(ROOT, 'setup', 'unit')).filter((n) => n.endsWith('.test.mjs'));
  for (const s of suites) {
    assert.ok(CHECKS.some((c) => c.unit && c.cmd[0] === `setup/unit/${s}`), `setup/unit/${s} has no entry in CHECKS: add unit('${s.replace('.test.mjs', '')}', …)`);
  }
});

await test('the import graph sees helpers: extUrl(), join(EXT, …), new URL(…, EXT), a spawned daemon', () => {
  const reach = (id, f) => closures.get(id).has(f);
  assert.ok(reach('unit:interaction', 'extension/tools/interact.js'), 'interaction loads interact.js through extUrl()');
  assert.ok(reach('unit:interaction', 'extension/humanize/plan.js'), '…and, through it, the humanize library');
  assert.ok(reach('selftest', 'daemon/router.js'), 'the self-test spawns the daemon, which imports the router');
  assert.ok(reach('selftest', 'mcp/tools.js'), '…and the shim, which imports the tool schemas');
  assert.ok(reach('unit:engine', 'engine/launch.js'));
  assert.ok(reach('extensiontest', 'extension/sw.js'), 'new URL("../extension/sw.js", import.meta.url)');
  assert.ok(reach('unit:check', 'setup/check-plan.mjs'));
  assert.deepEqual(referencesOf('extension/lib/sites.js'), [], 'a pure module refers to no repo file');
});

await test('documentation alone runs the link check; ARCHITECTURE_V2 also the panel suite, which reads it', () => {
  assert.deepEqual(ids(planFor(['README.md', 'docs/INSTALL.md', 'engine/README.md'], { closures })), ['doclinks']);
  assert.deepEqual(ids(planFor(['docs/ARCHITECTURE_V2.md'], { closures })), ['doclinks', 'unit:panel']);
  assert.equal(planFor(['desktop/README.md'], { closures }).checks.some((c) => c.id === 'unit:desktop'), false,
    'a README beside code is not the code');
});

await test('a panel change runs the panel suite and the render, and calls for no live suite', () => {
  const p = planFor(['extension/panel/panel.css', 'extension/panel/icon16.png'], { closures });
  for (const id of ['panel-render', 'unit:panel']) assert.ok(ids(p).includes(id), id);
  for (const id of ['unit:interaction', 'unit:engine', 'extensiontest', 'selftest']) assert.ok(!ids(p).includes(id), `not ${id}`);
  assert.ok(estimateSeconds(p.checks, 4) < 30, 'seconds, not minutes');
  assert.deepEqual(p.live, []);
  assert.deepEqual(p.fallback, []);
});

await test('an input change runs every offline suite that loads it, and names both live suites', () => {
  const p = planFor(['extension/tools/interact.js'], { closures });
  for (const id of ['unit:interaction', 'unit:seam', 'extensiontest', 'selftest']) assert.ok(ids(p).includes(id), id);
  assert.deepEqual(p.live.map((c) => c.id).sort(), ['engine2-livetest', 'isolated-livetest']);
  assert.equal(p.checks.some((c) => c.tier === 'live'), false, 'live suites run only when asked');
  assert.ok(planFor(['extension/tools/interact.js'], { closures, live: true }).checks.some((c) => c.tier === 'live'));
});

await test('a file no check reaches runs EVERY offline check; one NO_CHECK names runs none and says why', () => {
  const unknown = planFor(['brand-new/module.js'], { closures });
  assert.deepEqual(unknown.fallback, ['brand-new/module.js']);
  assert.deepEqual(ids(unknown), offlineIds);
  const ps1 = planFor(['setup/install.ps1'], { closures });
  assert.deepEqual(others(ps1), []);
  assert.equal(ps1.uncovered.length, 1);
  assert.match(ps1.uncovered[0][1], /by hand/);
  assert.deepEqual(ids(planFor(['setup/unittest.mjs'], { closures })), offlineIds, 'FULL_RUN: the unit runner runs everything');
});

await test('a file only a live suite reaches (a test page) runs nothing offline and names that suite', () => {
  const p = planFor(['setup/testpage.html'], { closures });
  assert.deepEqual(others(p), []);
  assert.deepEqual(p.fallback, []);
  assert.ok(p.live.length >= 1);
});

await test('--all runs every offline check; --all --live adds every live suite', () => {
  assert.deepEqual(ids(planFor([], { closures, all: true })), offlineIds);
  assert.equal(planFor([], { closures, all: true, live: true }).checks.length, CHECKS.length);
});

await test('every tracked file is reached by a check, named in NO_CHECK, or deliberately in FULL_RUN', () => {
  let files;
  try {
    files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    console.log('  SKIP every tracked file … — git is not available here');
    return;
  }
  const stray = files.filter((f) => fs.existsSync(path.join(ROOT, f)) && !FULL_RUN.includes(f) && planFor([f], { closures }).fallback.length);
  assert.deepEqual(stray, [], 'Each of these would make setup/check.mjs run every offline check. Make a check reach it (its entry imports '
    + 'it, or add it to that check\'s `reads` in setup/check-plan.mjs), or name it in NO_CHECK with the reason nothing covers it.');
  for (const [glob] of NO_CHECK) assert.ok(files.some((f) => matches(f, [glob])) || glob.includes('*'), `NO_CHECK names ${glob}, which matches no file`);
});

await test('the estimate: longest first over N lanes, live suites alone after them', () => {
  const c = (est, tier = 'offline') => ({ est, tier });
  assert.equal(estimateSeconds([c(10), c(10), c(10), c(10)], 2), 20);
  assert.equal(estimateSeconds([c(141), c(35), c(30), c(24), c(22)], 4), 141);
  assert.equal(estimateSeconds([c(10), c(300, 'live')], 4), 310);
  assert.equal(estimateSeconds([], 4), 0);
});

await test('doclinks: GitHub slugs, and a missing file or heading is reported', () => {
  assert.equal(slug('Upgrading from 2.x to 3.0'), 'upgrading-from-2x-to-30');
  assert.equal(slug('The side panel (v3)'), 'the-side-panel-v3');
  assert.equal(slug('6.10 `extension/panel/` — the side panel'), '610-extensionpanel--the-side-panel');
  assert.ok(anchorsOf('# A\n## A\n```\n# not a heading\n```\n<a id="x"></a>').has('a-1'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-doclinks-'));
  try {
    fs.writeFileSync(path.join(dir, 'b.md'), '# Real heading\n');
    fs.writeFileSync(path.join(dir, 'a.md'), '[ok](b.md#real-heading) [gone](c.md) [bad](b.md#nope) [web](https://example.test/#x) `[code](nope.md)`\n');
    const bad = brokenLinks('a.md', { root: dir });
    assert.equal(bad.length, 2, bad.join('\n'));
    assert.ok(bad.some((b) => b.includes('c.md')) && bad.some((b) => b.includes('#nope')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('check.mjs --plan prints the plan and runs nothing', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'setup', 'check.mjs'), '--plan', '--files', 'README.md'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 changed file -> 1 check/);
  assert.match(r.stdout, /links and anchors/);
  assert.doesNotMatch(r.stdout, /PASSED|FAILED/, 'nothing ran');
});
