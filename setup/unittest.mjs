#!/usr/bin/env node
/**
 * Unit tests — every `setup/unit/*.test.mjs`, each in its own child process
 * (ARCHITECTURE §12.1).
 *
 * Why one process per file: several suites stub `globalThis.chrome` before
 * importing extension modules, and platform.js picks its implementation at
 * module load. Two suites in one process would share that choice — the second
 * would silently test the first one's platform.
 *
 * Convention for a test file: plain Node, `node:assert/strict`, prints
 * `  PASS <name>` per test (`  SKIP <name> — why` for one it could not run),
 * exits non-zero on the first failure, never touches the network or port 8765.
 *
 * Real browsers: engine.test.mjs and platform-cdp.test.mjs have `live:` tests
 * that launch the installed Edge/Chrome/CfT HEADLESS on a temporary profile
 * (they are what proves the pipe, decision D-a and F1 against a real browser).
 * They stay ON here. `G9_UNIT_NO_BROWSER=1` skips them — it is passed through
 * to every suite unchanged, and the summary says which mode ran.
 * desktop.test.mjs runs desktop/test (it SKIPs when desktop/node_modules is absent).
 *
 *   node setup/unittest.mjs              every suite
 *   node setup/unittest.mjs daemon seam  only files whose name contains a filter
 *   G9_UNIT_NO_BROWSER=1 node setup/unittest.mjs   no real browser at all
 */

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UNIT = path.join(HERE, 'unit');
const PER_FILE_TIMEOUT_MS = 5 * 60_000;

const filters = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const verbose = process.argv.includes('--verbose');

const color = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);

function runFile(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [file], {
      cwd: path.join(HERE, '..'),
      env: { ...process.env, G9_UNIT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => {
      out += `\n(timed out after ${PER_FILE_TIMEOUT_MS / 1000}s)`;
      child.kill();
    }, PER_FILE_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const passes = (out.match(/^\s*PASS\b/gm) ?? []).length;
      const skips = (out.match(/^\s*SKIP\b/gm) ?? []).length;
      resolve({ file, code: code ?? (signal ? 1 : 0), passes, skips, out, ms: Date.now() - started });
    });
  });
}

let files = [];
try {
  files = (await readdir(UNIT)).filter((n) => n.endsWith('.test.mjs')).sort();
} catch {
  files = [];
}
if (filters.length) files = files.filter((n) => filters.some((f) => n.includes(f)));

const noBrowser = process.env.G9_UNIT_NO_BROWSER === '1';
console.log(`\nG9 unit tests — ${files.length} suite(s); live browser tests ${noBrowser ? 'SKIPPED (G9_UNIT_NO_BROWSER=1)' : 'on (headless, temp profiles; G9_UNIT_NO_BROWSER=1 skips them)'}\n`);
if (!files.length) {
  console.log(filters.length ? `No suite matches ${filters.join(', ')}.` : 'No suites in setup/unit.');
  process.exit(filters.length ? 1 : 0);
}

const results = [];
for (const name of files) {
  const result = await runFile(path.join(UNIT, name));
  results.push(result);
  const ok = result.code === 0;
  const label = ok ? color(32, 'ok  ') : color(31, 'FAIL');
  const skipped = result.skips ? `, ${result.skips} skipped` : '';
  console.log(`${label} ${name.padEnd(28)} ${String(result.passes).padStart(4)} passed${skipped}  ${String(result.ms).padStart(6)} ms`);
  if (!ok || verbose) {
    const body = result.out.trimEnd().split('\n').map((l) => `      ${l}`).join('\n');
    console.log(body);
  }
}

const failed = results.filter((r) => r.code !== 0);
const total = results.reduce((n, r) => n + r.passes, 0);
const skippedTotal = results.reduce((n, r) => n + r.skips, 0);
console.log(`\n${failed.length ? color(31, `${failed.length} suite(s) failed`) : color(32, 'all suites passed')} — ${total} test(s) passed` +
  `${skippedTotal ? `, ${skippedTotal} skipped` : ''} in ${results.length} suite(s)\n`);
process.exit(failed.length ? 1 : 0);
