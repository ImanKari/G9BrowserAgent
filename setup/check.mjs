#!/usr/bin/env node
/**
 * Run the checks a change needs — and say, while they run, what is running.
 *
 *   node setup/check.mjs                  what the working tree's changes need (git status against HEAD)
 *   node setup/check.mjs --since <ref>    what the changes since <ref> need (e.g. origin/main, HEAD~3)
 *   node setup/check.mjs --files a b …    what these files need
 *   node setup/check.mjs --all            every offline check (the coverage of `npm test`, plus the
 *                                         panel render and the link check), several at a time
 *   node setup/check.mjs --live           also run the live suites the change calls for
 *   node setup/check.mjs --release        --all --live: everything short of the installer build
 *   node setup/check.mjs --plan           print the plan and the estimate, run nothing
 *   options: --jobs N (default 4), --keep-going (do not stop starting checks after a failure),
 *            --verbose (print every check's output as it arrives)
 *
 * Which checks and why is setup/check-plan.mjs: a check runs when a changed file is among the files
 * it imports (followed transitively) or reads; a changed file no check reaches runs every offline
 * check. Offline checks run `--jobs` at a time, longest first; live suites run one at a time after
 * them, and only with --live (or --release). Changed JavaScript files are syntax-checked first.
 *
 * While checks run it prints a line every 15 s naming each running check, its time and how many
 * PASS lines it has printed, and flags one that has printed nothing for 90 s — so a slow check and
 * a stuck one look different. Every check's full output goes to a log file (path printed at the
 * end); a failing check's last 60 lines are printed.
 *
 * Every check it runs is one this repository already had and keeps its own safety rules (temp
 * G9_HOME, temp profiles, random ports 18000-18999, never 8765, headless). G9_UNIT_NO_BROWSER=1 is
 * passed through, and it also skips the checks that launch a browser (the panel render, live).
 * Exit 0 when every check that ran passed.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHECKS, ROOT, planFor, estimateSeconds } from './check-plan.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const release = flag('--release');
const opts = {
  all: flag('--all') || release,
  live: flag('--live') || release,
  planOnly: flag('--plan'),
  keepGoing: flag('--keep-going'),
  verbose: flag('--verbose'),
  since: valueOf('--since'),
  jobs: Math.max(1, Number(valueOf('--jobs')) || 4),
  files: flag('--files') ? argv.slice(argv.indexOf('--files') + 1).filter((a) => !a.startsWith('--')) : null,
};
const noBrowser = process.env.G9_UNIT_NO_BROWSER === '1';
const HEARTBEAT_MS = Number(process.env.G9_CHECK_HEARTBEAT_MS) || 15_000;
const SILENT_MS = 90_000;

const tty = process.stdout.isTTY;
const color = (code, text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const secs = (ms) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const est = (s) => (s < 1 ? '<1 s' : s < 90 ? `~${Math.round(s)} s` : `~${(s / 60).toFixed(1)} min`);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ------------------------------------------------------------------------------ what changed

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Changed files, repo-relative. Renames count both names (the old one is gone: nothing imports it). */
function changedFiles() {
  if (opts.files) return opts.files.map((f) => path.relative(ROOT, path.resolve(f)).split(path.sep).join('/'));
  const out = new Set();
  if (opts.since) {
    for (const f of git(['diff', '--name-only', '-z', opts.since]).split('\0')) if (f) out.add(f);
    for (const f of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) if (f) out.add(f);
    return [...out];
  }
  const entries = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    const xy = e.slice(0, 2);
    out.add(e.slice(3));
    if (/[RC]/.test(xy)) out.add(entries[++i]); // the source of a rename or copy follows
  }
  return [...out];
}

// ------------------------------------------------------------------------------------ the plan

let files;
try {
  files = opts.all && !opts.files && !opts.since ? [] : changedFiles();
} catch (err) {
  console.error(`Could not ask git what changed (${String(err.message).split('\n')[0]}). Use --files … or --all.`);
  process.exit(2);
}
const plan = planFor(files, { all: opts.all, live: opts.live });
let toRun = plan.checks;
const skippedForBrowser = noBrowser ? toRun.filter((c) => c.browser) : [];
if (noBrowser) toRun = toRun.filter((c) => !c.browser);

const scope = opts.all ? 'every offline check' + (opts.live ? ' and every live suite' : '')
  : `${files.length} changed file${files.length === 1 ? '' : 's'}${opts.since ? ` since ${opts.since}` : ''}`;
console.log(`\nG9 check: ${scope} -> ${toRun.length} check${toRun.length === 1 ? '' : 's'}, ${est(estimateSeconds(toRun, opts.jobs))} at ${opts.jobs} at a time\n`);

if (plan.fallback.length) {
  console.log(color(33, `  No check reaches ${plan.fallback.length} changed file(s), so every offline check runs:`));
  for (const f of plan.fallback.slice(0, 8)) console.log(`    ${f}`);
  if (plan.fallback.length > 8) console.log(`    … and ${plan.fallback.length - 8} more`);
  console.log('');
}
for (const c of toRun) {
  const w = plan.why.get(c.id) ?? plan.liveWhy.get(c.id) ?? [];
  const reason = w.length ? `for ${w.slice(0, 2).join(', ')}${w.length > 2 ? ` +${w.length - 2}` : ''}` : '';
  console.log(`  ${c.label.padEnd(52)} ${est(c.est).padStart(9)}  ${color(90, reason)}`);
}
if (!toRun.length && !plan.syntax.length) console.log('  nothing to run for these changes');
const liveNotRun = plan.live.filter((c) => !toRun.includes(c));
if (liveNotRun.length) {
  console.log(`\n  Also covers this change, NOT run now (add --live, or run before shipping):`);
  for (const c of liveNotRun) console.log(`    ${c.label} (${est(c.est)}): node ${c.cmd[0]}`);
}
if (plan.uncovered.length) {
  console.log('\n  Changed, and no automated check covers it:');
  for (const [f, why] of plan.uncovered) console.log(`    ${f} — ${why}`);
}
if (skippedForBrowser.length) console.log(`\n  Skipped (G9_UNIT_NO_BROWSER=1): ${skippedForBrowser.map((c) => c.label).join(', ')}`);
console.log('');

if (opts.planOnly) process.exit(0);

// ------------------------------------------------------------------------------ syntax first

let failed = 0;
const started = Date.now();
const results = [];
for (const f of plan.syntax) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    failed++;
    console.log(`  ${color(31, 'FAIL')} syntax ${f}\n${(r.stderr || r.stdout).trim().split('\n').slice(0, 8).map((l) => `      ${l}`).join('\n')}`);
  }
}
if (plan.syntax.length) {
  console.log(`  ${failed ? color(31, 'FAIL') : color(32, 'ok  ')} syntax of ${plan.syntax.length} changed JavaScript file(s)`);
  results.push({ label: `syntax (${plan.syntax.length} files)`, ok: !failed, passes: plan.syntax.length - failed, ms: Date.now() - started });
}

// ---------------------------------------------------------------------------------- the pool

const logPath = path.join(os.tmpdir(), `g9-check-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const log = fs.createWriteStream(logPath);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-check-'));
const running = new Map();

function runCheck(check) {
  return new Promise((resolve) => {
    const args = check.cmd.map((a, i) => (i === 0 ? path.join(ROOT, a) : a.replace('{tmp}', tmp)));
    const env = { ...process.env, ...(check.unit ? { G9_UNIT: '1' } : {}) };
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const job = { check, child, started: Date.now(), lastOutput: Date.now(), passes: 0, out: '', partial: '' };
    running.set(check.id, job);
    const limitMs = check.unit ? 5 * 60_000 : Math.max(5 * 60_000, check.est * 3000);
    const timer = setTimeout(() => { job.out += `\n(check.mjs: stopped after ${secs(limitMs)})`; child.kill(); }, limitMs);
    const onData = (d) => {
      const text = d.toString('utf8');
      job.out += text;
      job.lastOutput = Date.now();
      job.partial += text;
      const lines = job.partial.split('\n');
      job.partial = lines.pop();
      for (const line of lines) {
        const plain = stripAnsi(line);
        if (/^\s*PASS\b/.test(plain)) job.passes++;
        if (opts.verbose) console.log(color(90, `    [${check.id}] ${plain}`));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      running.delete(check.id);
      const ms = Date.now() - job.started;
      const ok = code === 0 && !signal;
      log.write(`\n===== ${check.label} — ${ok ? 'ok' : `FAILED (exit ${code ?? signal})`} in ${secs(ms)}\n${stripAnsi(job.out)}\n`);
      // A suite that prints no PASS lines (or prints a total) is still counted from its summary.
      const total = stripAnsi(job.out).match(/(\d+)\s+passed/g)?.pop()?.match(/\d+/)?.[0];
      const passes = job.passes || Number(total) || 0;
      console.log(`  ${ok ? color(32, 'ok  ') : color(31, 'FAIL')} ${check.label.padEnd(52)} ${String(passes || '').padStart(4)}${passes ? ' passed' : '       '} ${secs(ms).padStart(7)}`);
      if (!ok) {
        const tail = stripAnsi(job.out).trimEnd().split('\n').slice(-60);
        console.log(tail.map((l) => color(90, `      ${l}`)).join('\n'));
      }
      results.push({ label: check.label, ok, passes, ms });
      resolve(ok);
    });
  });
}

const heartbeat = setInterval(() => {
  if (!running.size) return;
  const now = Date.now();
  const parts = [...running.values()].map((j) => {
    const quiet = now - j.lastOutput >= SILENT_MS ? color(33, `, no output for ${secs(now - j.lastOutput)}`) : '';
    return `${j.check.id} ${secs(now - j.started)}${j.passes ? `, ${j.passes} passed` : ''}${quiet}`;
  });
  console.log(color(90, `  … ${secs(now - started)}: running ${parts.join(' | ')}`));
}, HEARTBEAT_MS);
heartbeat.unref();

let stopStarting = false;
const kill = () => { for (const j of running.values()) j.child.kill(); };
process.on('SIGINT', () => { stopStarting = true; kill(); process.exit(130); });

async function pool(checks, jobs) {
  const queue = [...checks].sort((a, b) => b.est - a.est);
  const lane = async () => {
    while (queue.length && !stopStarting) {
      const ok = await runCheck(queue.shift());
      if (!ok) { failed++; if (!opts.keepGoing) stopStarting = true; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, lane));
  return queue; // what never started
}

if (failed && !opts.keepGoing) stopStarting = true;
const notStarted = [
  ...(await pool(toRun.filter((c) => c.tier !== 'live'), opts.jobs)),
  ...(await pool(toRun.filter((c) => c.tier === 'live'), 1)),
];
clearInterval(heartbeat);
log.end();
fs.rmSync(tmp, { recursive: true, force: true });

const passedN = results.filter((r) => r.ok).length;
console.log(`\n${failed ? color(31, 'FAILED') : color(32, 'PASSED')}: ${passedN} of ${results.length} check(s) passed in ${secs(Date.now() - started)}` +
  `${notStarted.length ? `; ${notStarted.length} not started after the failure (--keep-going runs them)` : ''}.`);
if (results.length) console.log(color(90, `Full output: ${logPath}`));
if (liveNotRun.length && !failed) console.log(`Not run: ${liveNotRun.map((c) => c.label).join(', ')} — add --live before shipping.`);
process.exit(failed ? 1 : 0);
