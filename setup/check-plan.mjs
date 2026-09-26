/**
 * Which checks a change needs — the planning half of setup/check.mjs (the running half is there).
 *
 * Why: every check used to run after every change. On 2026-09-25 that was about 4 minutes of unit
 * suites (interaction alone 141 s of the 240), plus 10 s self-test, 30 s extension suite and, for
 * anything near input or launching, 9 minutes of live suites — even for a README edit or a new icon.
 * A check is needed when the change can reach what it runs, and that is mostly knowable: a test
 * reaches the files it imports (followed transitively), plus the files it spawns or reads as text,
 * which are listed by hand below (`reads`). A changed file no check reaches is NOT skipped quietly:
 * it makes the plan fall back to every offline check (`fallback`), unless it is listed in NO_CHECK
 * with the reason nothing automated covers it.
 *
 * Pure apart from reading the repository's files; no git, no processes (check.mjs does those), so
 * setup/unit/check.test.mjs can test it directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every check. `tier`: 'offline' runs by default when the change reaches it; 'live' launches real
 * browsers for minutes and runs only with --live (it is named in the output when it would cover the
 * change). `est`: seconds, measured on the owner's machine on 2026-09-25 (i9-10900X, 20 threads).
 * `entry`: files whose imports are followed. `reads`: globs the check also depends on without
 * importing them (spawned scripts, source scans, files read as text).
 */
export const CHECKS = [
  unit('daemon', 6, []),
  unit('desktop', 22, ['desktop/**']),
  unit('engine', 35, []),
  unit('humanize', 2, []),
  unit('interaction', 141, []),
  unit('panel', 1, ['extension/panel/**', 'extension/manifest.json', 'extension/sw.js', 'extension/lib/transport.js',
    'extension/lib/state.js', 'docs/ARCHITECTURE_V2.md', 'package.json']),
  unit('platform-cdp', 8, []),
  // The R2 scan reads every module of the shared tool layer, imported or not.
  unit('seam', 24, ['extension/sw.js', 'extension/tools/**', 'extension/lib/**', 'extension/humanize/**']),
  unit('sites', 0.1, []),
  unit('version', 0.1, ['package.json', 'extension/manifest.json', 'desktop/package.json', 'desktop/package-lock.json', 'lib/version.mjs']),
  unit('world', 0.2, []),
  unit('runtime', 0.5, []),
  unit('check', 1, ['setup/check.mjs']),
  {
    id: 'selftest', label: 'self-test (daemon + two shims + a fake extension)', tier: 'offline', est: 10,
    cmd: ['setup/selftest.mjs'],
    // It spawns the daemon, the shim and the v1 forwarder, and scans extension/lib and tools for
    // escapes that a template literal would eat.
    entry: ['setup/selftest.mjs', 'daemon/g9d.mjs', 'mcp/shim.mjs', 'bridge/src/server.js'],
    reads: ['extension/lib/*.js', 'extension/tools/*.js'],
  },
  {
    id: 'extensiontest', label: 'extension suite', tier: 'offline', est: 30,
    cmd: ['setup/extensiontest.mjs'],
    entry: ['setup/extensiontest.mjs', 'setup/fixtures/tasks-browse-and-open.flow.json'],
    reads: [],
  },
  {
    id: 'panel-render', label: 'panel render (headless Edge, pictures)', tier: 'offline', est: 15, browser: true,
    cmd: ['setup/panel-render.mjs', '--out', '{tmp}/panel-render'],
    entry: ['setup/panel-render.mjs'],
    reads: ['extension/panel/**', 'extension/lib/sites.js'],
  },
  {
    id: 'doclinks', label: 'links and anchors in the guides', tier: 'offline', est: 1,
    cmd: ['setup/doclinks.mjs'],
    entry: ['setup/doclinks.mjs'],
    reads: ['**/*.md'],
  },
  {
    id: 'engine2-livetest', label: 'Engine 2 live suite (headless Edge)', tier: 'live', est: 330, browser: true,
    cmd: ['setup/engine2-livetest.mjs'],
    entry: ['setup/engine2-livetest.mjs', 'daemon/g9d.mjs', 'mcp/shim.mjs'],
    reads: ['daemon/**', 'mcp/**', 'lib/**', 'engine/**', 'extension/tools/**', 'extension/lib/**', 'extension/humanize/**',
      'setup/serve.mjs', 'setup/*.html', 'setup/fixtures/**'],
  },
  {
    id: 'isolated-livetest', label: 'Engine 1 live suite (the real extension, headless)', tier: 'live', est: 210, browser: true,
    cmd: ['setup/isolated-livetest.mjs'],
    entry: ['setup/isolated-livetest.mjs', 'setup/livetest.mjs', 'daemon/g9d.mjs', 'mcp/shim.mjs'],
    reads: ['extension/**', 'daemon/**', 'mcp/**', 'lib/**', 'engine/**', 'setup/serve.mjs', 'setup/*.html', 'setup/fixtures/**'],
  },
];

function unit(name, est, reads) {
  return {
    id: `unit:${name}`, label: `unit: ${name}`, tier: 'offline', est, unit: true,
    cmd: [`setup/unit/${name}.test.mjs`],
    entry: [`setup/unit/${name}.test.mjs`],
    reads,
  };
}

/**
 * The live suites cost minutes, so they are not run for every change they could reach. AIGuide §7:
 * run them before shipping anything that touches perception, input, launching or the seam — these
 * paths. For them the plan names the live suites to run (check.mjs runs them with --live).
 */
export const LIVE_TRIGGERS = [
  'extension/humanize/**', 'extension/lib/humanize.js', 'extension/lib/pointer.js', 'extension/tools/interact.js',
  'extension/tools/snapshot.js', 'extension/tools/inspect.js', 'extension/tools/observe.js', 'extension/tools/capture.js',
  'extension/tools/events.js', 'extension/tools/tabs.js', 'extension/tools/navigate.js', 'extension/tools/replay.js',
  'extension/tools/record.js', 'extension/lib/cdp.js', 'extension/lib/refs.js', 'extension/lib/frames.js',
  'extension/lib/world.js', 'extension/lib/screencast.js', 'extension/lib/platform*.js', 'extension/sw.js',
  'engine/**', 'daemon/router.js', 'daemon/handoff.js', 'mcp/tools.js',
  // The live suites' own scripts and the pages they test against.
  'setup/livetest.mjs', 'setup/isolated-livetest.mjs', 'setup/engine2-livetest.mjs', 'setup/serve.mjs', 'setup/*.html',
  'setup/fixtures/**',
];

/** Files no automated check covers, and why. A change to one of them runs only the syntax check. */
export const NO_CHECK = [
  ['scripts/**', 'standalone example automations, documented against v1.7.21; run them by hand'],
  ['setup/*.ps1', 'PowerShell: install.ps1 and make-icons.ps1 are run by hand'],
  ['setup/bench.mjs', 'a measurement harness; run it by hand'],
  ['setup/endurance.mjs', 'a measurement harness; run it by hand'],
  ['setup/matrix.mjs', 'the background-state matrix; run it by hand'],
  ['setup/stealthtest.mjs', 'the stealth gate; run it by hand (npm run test:stealth)'],
  ['setup/stealth-pages.json', 'read by the stealth gate only'],
  ['setup/mcp.example.json', 'a template'],
  ['g9.project.example.json', 'a template'],
  ['**/.gitignore', 'no behaviour'],
  ['.gitattributes', 'line endings (LF everywhere); no behaviour'],
  ['desktop/electron-builder.yml', 'the package builds: cd desktop && npm run build:win|mac|linux (each verifies its artifacts), then test/update-e2e.mjs'],
  ['desktop/build/**', 'the package builds: cd desktop && npm run build:win|mac|linux, then test/update-e2e.mjs'],
  ['azure-pipelines.yml', 'the release pipeline itself: every run of it exercises it'],
  ['setup/github-release.mjs', 'the pipeline Publish stage (a GitHub release); --dry-run against a folder to try it'],
  ['setup/release-notes.mjs', 'the pipeline Release stage; run it with --version <v> to print the notes'],
  ['LICENSE', 'no behaviour'],
  ['**/*.png', 'images; an icon named in the manifest is checked by the panel suite'],
  ['**/*.ico', 'images'],
];

/**
 * Files no single check reaches ON PURPOSE: a change to one runs every offline check (the unit
 * runner runs every suite). setup/unit/check.test.mjs fails for any other tracked file that no
 * check reaches and NO_CHECK does not name — so a new module cannot quietly slow every run down.
 */
export const FULL_RUN = ['setup/unittest.mjs'];

// -------------------------------------------------------------------------------------- globs

const globCache = new Map();

/** `*` matches within a path segment, `**` across segments; paths use '/'. */
export function globToRegExp(glob) {
  let re = globCache.get(glob);
  if (re) return re;
  let src = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // "**/" matches zero or more whole segments; a trailing "**" matches the rest.
      if (glob[i + 2] === '/') { src += '(?:.*/)?'; i += 2; } else { src += '.*'; i += 1; }
    } else if (c === '*') src += '[^/]*';
    else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re = new RegExp(`^${src}$`);
  globCache.set(glob, re);
  return re;
}

export const matches = (file, globs) => globs.some((g) => globToRegExp(g).test(file));

// ------------------------------------------------------------------------------ import graph

const IMPORT_RES = [
  /\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g, // import x from '…', import '…'
  /\bexport\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s+['"]([^'"]+)['"]/g, // export … from '…'
  /\bimport\(\s*['"`]([^'"`$]+)['"`]\s*\)/g, // import('…') with a literal
  /\bnew\s+URL\(\s*['"`]([^'"`$]+)['"`]\s*,\s*import\.meta\.url\s*\)/g, // a sibling file a test reads or spawns
];

/** Repo-relative, '/'-separated. */
export const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

/**
 * Folders a file NAME in a string literal is looked up in. Tests and the engine manager load
 * modules through helpers — `extUrl('tools/interact.js')`, `join(EXT, 'lib', 'store.js')`,
 * `new URL('tools/index.js', EXT)`, `path.join(ROOT, 'daemon', 'g9d.mjs')` — which no import
 * statement shows. A literal that names an existing file under one of these folders counts as a
 * reference. It over-approximates (a stray 'index.js' reaches every index.js here), which only ever
 * runs a check too many, never one too few.
 */
const LITERAL_BASES = ['', 'extension', 'extension/lib', 'extension/tools', 'extension/panel', 'extension/humanize',
  'daemon', 'engine', 'mcp', 'lib', 'runner', 'runner/drivers', 'bridge/src', 'setup', 'setup/unit', 'setup/fixtures'];
// Quotes only, not backticks: comments here name files in backticks (`setup/livetest.mjs`), and a
// template literal that loads a module has a ${…} in it anyway.
const LITERAL_RE = /(['"])([\w@./-]+\.(?:m?js|cjs|json|html|css))\1/g;

const isFileCache = new Map();
function isRepoFile(relPath) {
  if (!isFileCache.has(relPath)) {
    let ok = false;
    try { ok = !relPath.startsWith('..') && !relPath.includes('node_modules') && fs.statSync(path.join(ROOT, relPath)).isFile(); } catch { ok = false; }
    isFileCache.set(relPath, ok);
  }
  return isFileCache.get(relPath);
}

/** The repo files one file refers to: relative imports, and file names in string literals (above). */
export function referencesOf(file, read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')) {
  if (!/\.(m?js|cjs)$/.test(file)) return [];
  let src;
  try { src = read(file); } catch { return []; }
  const out = new Set();
  const dir = path.posix.dirname(file);
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(dir, spec));
      if (isRepoFile(target)) out.add(target);
    }
  }
  for (const m of src.matchAll(LITERAL_RE)) {
    const name = m[2];
    const bases = name.startsWith('.') ? [dir] : [dir, ...LITERAL_BASES];
    for (const base of bases) {
      const target = path.posix.normalize(path.posix.join(base, name));
      if (target !== file && isRepoFile(target)) out.add(target);
    }
  }
  return [...out];
}

/** Every repo file reachable from `entries` through referencesOf, entries included. */
export function closureOf(entries, refs = referencesOf) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const r of refs(f)) if (!seen.has(r)) stack.push(r);
  }
  return seen;
}

// ------------------------------------------------------------------------------------ planning

/**
 * Does this check depend on this file? Markdown counts only for a check that names markdown in
 * `reads` (the link check; the panel suite reads ARCHITECTURE_V2.md): a README next to code is not
 * the code.
 */
export function covers(check, file, closures) {
  if (closures.get(check.id).has(file)) return true;
  if (file.endsWith('.md') && !check.reads.some((g) => g.endsWith('.md'))) return false;
  return matches(file, check.reads);
}

export function closuresFor(checks = CHECKS, refs = referencesOf) {
  return new Map(checks.map((c) => [c.id, closureOf(c.entry, refs)]));
}

/**
 * The plan for a set of changed files (repo-relative, '/'-separated).
 *
 * @param {string[]} files
 * @param {object} [o]
 * @param {boolean} [o.all]   every offline check, whatever changed
 * @param {boolean} [o.live]  also the live checks that cover the change (with `all`: every live check)
 * @returns {{ checks: object[], why: Map<string,string[]>, live: object[], liveWhy: Map<string,string[]>,
 *   fallback: string[], uncovered: [string,string][], syntax: string[] }}
 *   `checks` to run now; `why` per check id, the changed files that reach it; `live` the live checks
 *   the change calls for (run only with o.live); `fallback` the changed files no check reaches, which
 *   put every offline check in `checks`; `uncovered` files NO_CHECK names, with the reason; `syntax`
 *   the changed JavaScript files to `node --check`.
 */
export function planFor(files, { all = false, live = false, checks = CHECKS, closures = closuresFor(checks) } = {}) {
  const why = new Map();
  const liveWhy = new Map();
  const fallback = [];
  const uncovered = [];
  const add = (map, id, f) => { if (!map.has(id)) map.set(id, []); if (f && !map.get(id).includes(f)) map.get(id).push(f); };
  const offline = checks.filter((c) => c.tier === 'offline');
  const liveChecks = checks.filter((c) => c.tier === 'live');

  for (const f of files) {
    if (FULL_RUN.includes(f)) { fallback.push(f); continue; }
    const reachedBy = checks.filter((c) => covers(c, f, closures));
    const reachedOffline = reachedBy.filter((c) => c.tier === 'offline');
    const reachedLive = reachedBy.filter((c) => c.tier === 'live');
    for (const c of reachedOffline) add(why, c.id, f);
    // A live suite is called for by the paths AIGuide §7 names, and by a file only it reaches (its
    // own script, a test page): nothing offline would notice that change at all.
    if (matches(f, LIVE_TRIGGERS) || !reachedOffline.length) for (const c of reachedLive) add(liveWhy, c.id, f);
    if (reachedBy.length) continue;
    const reason = NO_CHECK.find(([g]) => matches(f, [g]));
    if (reason) uncovered.push([f, reason[1]]);
    else fallback.push(f);
  }
  if (all || fallback.length) for (const c of offline) add(why, c.id, null);
  if (all && live) for (const c of liveChecks) add(liveWhy, c.id, null);

  const run = offline.filter((c) => why.has(c.id));
  const liveList = liveChecks.filter((c) => liveWhy.has(c.id));
  if (live) run.push(...liveList);
  return {
    checks: run,
    why,
    live: liveList,
    liveWhy,
    fallback,
    uncovered,
    syntax: files.filter((f) => /\.(m?js|cjs)$/.test(f) && fs.existsSync(path.join(ROOT, f))),
  };
}

/**
 * Wall-clock estimate for running `checks` `jobs` at a time, longest first (what check.mjs does);
 * live checks run alone after the rest.
 */
export function estimateSeconds(checks, jobs) {
  const offline = checks.filter((c) => c.tier !== 'live').map((c) => c.est).sort((a, b) => b - a);
  const lanes = new Array(Math.max(1, jobs)).fill(0);
  for (const s of offline) lanes[lanes.indexOf(Math.min(...lanes))] += s;
  return Math.max(0, ...lanes) + checks.filter((c) => c.tier === 'live').reduce((s, c) => s + c.est, 0);
}
