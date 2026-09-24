/**
 * The scheduler: suites that run on their own, with nobody at the machine.
 *
 * An entry is persisted in settings.schedule:
 *
 *   { id, name, target: "suite:smoke", args: ["--env","test1"],
 *     daily: "02:30"          ← local time, every day
 *     | everyMinutes: 60,     ← or a fixed interval
 *     enabled: true, lastRunAt, lastExitCode, lastRunId }
 *
 * A due entry runs `runner/g9.mjs run <target> …args --report runs/<runId>/report`
 * as a CHILD PROCESS with the daemon's own `process.execPath` — so it is the same
 * runner a person would type, speaking MCP through the shim to this daemon like
 * any agent (no private back door), and under the desktop app `process.execPath`
 * is G9.exe with ELECTRON_RUN_AS_NODE=1, so a QA machine needs no Node.
 *
 * The result lands in runs/<runId>/ like every other run: engine.json, the
 * runner's reports under report/, result.json with the exit code.
 *
 * Two entry shapes are accepted (DAEMON_PROTOCOL §6): the runner's own words
 * (`target`, `daily`, `args`) and the desktop Schedule view's (`suite`,
 * `at`, `env`, `engine:{browser, headless, humanize, stealth, profile}`),
 * which normalizeEntry() turns into the first. The display fields are kept on
 * the stored entry so the desktop can show what it saved.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const MIN_INTERVAL = 1;

/**
 * The desktop's entry shape → the runner's. Idempotent; an entry already in
 * runner words passes through. Arguments the entry already carries win over
 * the ones derived from display fields.
 */
export function normalizeEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const e = { ...input };
  if ((e.target == null || e.target === '') && typeof e.suite === 'string') e.target = e.suite.trim();
  if (e.daily == null && e.at != null && e.at !== '') e.daily = e.at;
  // The desktop sends null for whichever of the two it did not choose.
  if (e.daily === null || e.daily === '') delete e.daily;
  if (e.everyMinutes === null || e.everyMinutes === '') delete e.everyMinutes;
  if (e.args != null && !Array.isArray(e.args)) return e; // let validation name it
  const args = [...(e.args ?? [])];
  const has = (flag) => args.includes(flag);
  const add = (flag, value) => { if (value != null && value !== '' && !has(flag)) args.push(flag, String(value)); };
  add('--env', e.env ?? e.environment ?? null);
  const engine = e.engine && typeof e.engine === 'object' ? e.engine : {};
  if (engine.browser && engine.browser !== 'auto') add('--browser', engine.browser);
  if (!has('--headed') && !has('--headless')) {
    if (engine.headless === false) args.push('--headed');
    else if (engine.headless === true) args.push('--headless');
  }
  add('--humanize', engine.humanize);
  add('--stealth', engine.stealth);
  add('--profile', engine.profile);
  add('--project', e.project);
  e.args = args;
  return e;
}

/** Problems with a schedule entry, [] when valid. */
export function validateEntry(entry) {
  const problems = [];
  if (!entry || typeof entry !== 'object') return ['A schedule entry must be an object.'];
  if (typeof entry.target !== 'string' || !entry.target.trim()) {
    problems.push('target is required: a flow id, suite:<name>, tag:<name> or all.');
  }
  const hasDaily = entry.daily != null;
  const hasEvery = entry.everyMinutes != null;
  if (hasDaily === hasEvery) problems.push('Give exactly one of daily:"HH:MM" or everyMinutes:N.');
  if (hasDaily && !HHMM.test(String(entry.daily))) problems.push(`daily must be "HH:MM" in 24-hour local time (got ${JSON.stringify(entry.daily)}).`);
  if (hasEvery && (!Number.isInteger(entry.everyMinutes) || entry.everyMinutes < MIN_INTERVAL || entry.everyMinutes > 60 * 24 * 31)) {
    problems.push(`everyMinutes must be an integer ${MIN_INTERVAL}..${60 * 24 * 31} (got ${JSON.stringify(entry.everyMinutes)}).`);
  }
  if (entry.args != null && (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== 'string'))) {
    problems.push('args must be an array of strings, e.g. ["--env","test1","--engine","launched"].');
  }
  if (Array.isArray(entry.args) && entry.args.includes('--report')) {
    problems.push('args must not contain --report: the scheduler writes the report into the run directory.');
  }
  for (const key of ['cwd', 'project', 'name']) {
    if (entry[key] != null && typeof entry[key] !== 'string') problems.push(`${key} must be a string.`);
  }
  if (entry.id != null && !/^[A-Za-z0-9_-]{1,40}$/.test(String(entry.id))) problems.push('id must be 1-40 letters, digits, "_" or "-".');
  return problems;
}

/** The worst verdict of a runner report, or one inferred from its exit code. */
export function overallVerdict(report, exitCode) {
  const order = ['ERROR', 'FAIL_PRODUCT', 'FAIL_AUTOMATION', 'SURPRISE', 'PASS_WITH_WARNING', 'PASS'];
  const seen = new Set((report?.flows ?? []).map((f) => f.verdict));
  for (const verdict of order) if (seen.has(verdict)) return verdict;
  return { 0: 'PASS', 1: 'FAIL_PRODUCT', 2: 'FAIL_AUTOMATION', 3: 'SURPRISE' }[exitCode] ?? 'ERROR';
}

/**
 * When an entry next runs, in epoch ms, strictly after `fromMs`; null when disabled.
 *
 * - daily "HH:MM": the next local wall-clock occurrence after `fromMs`. Built
 *   from local date parts, so a DST change moves it with the clock, as a person
 *   expects ("02:30 every night" stays 02:30).
 * - everyMinutes N: lastRunAt + N; never-run entries are due N minutes after
 *   they were created (or after `fromMs` when no creation time is known). A
 *   daemon that was off for a day runs a missed interval once, not 24 times.
 */
export function nextRunAt(entry, fromMs = Date.now()) {
  if (!entry || entry.enabled === false) return null;
  if (entry.daily != null) {
    const m = HHMM.exec(String(entry.daily));
    if (!m) return null;
    const from = new Date(fromMs);
    const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate(), Number(m[1]), Number(m[2]), 0, 0);
    if (candidate.getTime() <= fromMs) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  if (entry.everyMinutes != null) {
    const every = Number(entry.everyMinutes) * 60_000;
    if (!Number.isFinite(every) || every <= 0) return null;
    const base = entry.lastRunAt ?? entry.createdAt ?? fromMs;
    const next = base + every;
    return next > fromMs ? next : fromMs;
  }
  return null;
}

/**
 * The argv for one scheduled run (exported for the tests). `project` is the
 * g9.project.json to use when the entry names none: a scheduled run's working
 * directory is not the project, so without it the runner would search upwards
 * from the G9 install and find no flow library.
 */
export function runnerArgv({ runnerPath, entry, reportDir, project = null }) {
  const args = [...(entry.args ?? [])];
  if (project && !args.includes('--project')) args.push('--project', project);
  return [runnerPath, 'run', entry.target, ...args, '--report', reportDir, '--quiet'];
}

export class Scheduler {
  /**
   * @param {object} o
   * @param {import('./settings.js').Settings} o.settings
   * @param {import('./evidence.js').Evidence} o.evidence
   * @param {string} o.repoRoot   where runner/g9.mjs lives
   * @param {() => number} o.port  the daemon's port (for G9_PORT)
   * @param {string} o.home
   */
  constructor({ settings, evidence, repoRoot, port, home, log = () => {}, emit = () => {}, tickMs = 30_000, project = () => null }) {
    this.settings = settings;
    this.project = project; // () => absolute path of the daemon's default g9.project.json, or null
    this.evidence = evidence;
    this.repoRoot = repoRoot;
    this.port = port;
    this.home = home;
    this.log = log;
    this.emit = emit;
    this.tickMs = tickMs;
    this.timer = null;
    this.running = new Map(); // entryId → { child, runId, startedAt }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((err) => this.log(`[schedule] tick failed: ${err.message}`)), this.tickMs);
    this.timer.unref?.();
    // Catch anything that came due while the daemon was not running.
    setTimeout(() => this.tick().catch(() => {}), 2_000).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const { child } of this.running.values()) {
      if (!child) continue; // a run still being set up has no process yet
      try { child.kill(); } catch { /* already gone */ }
    }
  }

  entries() {
    return this.settings.get().schedule ?? [];
  }

  /** True when the idle-exit rule must keep the daemon alive for the schedule. */
  hasWork() {
    return this.running.size > 0 || this.entries().some((e) => e.enabled !== false);
  }

  list() {
    const now = Date.now();
    return this.entries().map((e) => ({
      ...e,
      // The desktop's display words, for entries saved in the runner's words.
      suite: e.suite ?? e.target,
      at: e.at ?? e.daily ?? null,
      nextRunAt: nextRunAt(e, now),
      running: this.running.has(e.id),
    }));
  }

  add(input) {
    const entry = normalizeEntry(input);
    const problems = validateEntry(entry);
    if (problems.length) throw new Error(`Schedule entry not saved:\n- ${problems.join('\n- ')}`);
    const clean = {
      id: entry.id ? String(entry.id) : `sch_${crypto.randomBytes(4).toString('hex')}`,
      name: entry.name ?? entry.suite ?? entry.target,
      target: entry.target.trim(),
      args: entry.args ?? [],
      ...(entry.daily != null ? { daily: String(entry.daily) } : { everyMinutes: entry.everyMinutes }),
      enabled: entry.enabled !== false,
      // Display fields, as the desktop sent them.
      ...(entry.suite != null ? { suite: String(entry.suite) } : {}),
      ...((entry.env ?? entry.environment) != null ? { env: String(entry.env ?? entry.environment) } : {}),
      ...(entry.engine && typeof entry.engine === 'object' ? { engine: { ...entry.engine } } : {}),
      ...(entry.project ? { project: entry.project } : {}),
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      createdAt: Date.now(),
      lastRunAt: null,
      lastExitCode: null,
      lastRunId: null,
      lastRun: null,
    };
    const rest = this.entries().filter((e) => e.id !== clean.id);
    this.settings.set({ schedule: [...rest, clean] });
    this.emit('schedule', { entries: this.list() });
    return clean;
  }

  remove(id) {
    const before = this.entries();
    const after = before.filter((e) => e.id !== id);
    if (after.length === before.length) throw new Error(`No schedule entry "${id}".`);
    this.settings.set({ schedule: after });
    this.emit('schedule', { entries: this.list() });
    return { removed: id };
  }

  #patch(id, patch) {
    const entries = this.entries().map((e) => (e.id === id ? { ...e, ...patch } : e));
    this.settings.set({ schedule: entries });
  }

  async tick(now = Date.now()) {
    for (const entry of this.entries()) {
      if (entry.enabled === false || this.running.has(entry.id)) continue;
      const from = entry.lastRunAt ?? entry.createdAt;
      if (from == null) {
        // A hand-written entry with no history: start its clock now rather than
        // recomputing "N minutes from now" on every tick, which would never fire.
        this.#patch(entry.id, { createdAt: now });
        continue;
      }
      const due = nextRunAt(entry, from);
      if (due != null && due <= now) await this.runNow(entry.id).catch((err) => this.log(`[schedule] ${entry.id}: ${err.message}`));
    }
  }

  /**
   * Start one entry now. Resolves when the child has STARTED, with { runId }.
   *
   * The entry's slot is RESERVED before the first await: the check and the reservation used to
   * be separated by evidence.startRun (file I/O), so a due tick and a "Run now" (or two UI
   * clients) both passed the check and started two runners; the second overwrote the first's
   * slot, and the first run was never finished — active until the daemon restarted, which kept
   * the desktop deferring updates (daemon review, 2026-09-22). Each run now finishes exactly
   * once (a per-run flag: 'error' and 'exit' can both fire), and frees the slot only while the
   * slot is still its own.
   */
  async runNow(id) {
    const entry = this.entries().find((e) => e.id === id);
    if (!entry) throw new Error(`No schedule entry "${id}".`);
    const held = this.running.get(id);
    if (held) throw new Error(`Schedule entry "${id}" is already running${held.runId ? ` (run ${held.runId})` : ''}.`);
    const slot = { child: null, runId: null, startedAt: null };
    this.running.set(id, slot);

    let runId = null;
    let dir = null;
    let child = null;
    let reportDir = null;
    let startedAt = null;
    const tail = { out: '', err: '' };
    try {
      ({ runId, dir } = await this.evidence.startRun({
        kind: 'schedule',
        label: entry.name ?? entry.target,
        meta: { schedule: { id: entry.id, target: entry.target, args: entry.args ?? [] } },
      }));
      reportDir = path.join(dir, 'report');
      const project = entry.project || this.project?.() || null;
      const argv = runnerArgv({ runnerPath: path.join(this.repoRoot, 'runner', 'g9.mjs'), entry, reportDir, project });
      // Run where the project is: the runner resolves relative paths (--data, a
      // pinned HAR) against its working directory, as when a person runs it there.
      const cwd = [entry.cwd, project ? path.dirname(project) : null].find((d) => d && isDir(d)) ?? this.repoRoot;
      const env = {
        ...process.env,
        G9_PORT: String(this.port()),
        G9_HOME: this.home,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      };
      startedAt = Date.now();
      child = spawn(process.execPath, argv, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      if (this.running.get(id) === slot) this.running.delete(id);
      if (runId) await this.evidence.finishRun(runId, { ok: false, error: String(err?.message ?? err) }).catch(() => {});
      throw err;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { tail.out = (tail.out + d).slice(-8_000); });
    child.stderr.on('data', (d) => { tail.err = (tail.err + d).slice(-8_000); });

    Object.assign(slot, { child, runId, startedAt });
    this.#patch(id, { lastRunAt: startedAt, lastRunId: runId });
    this.log(`[schedule] ${id} started run ${runId}: ${entry.target}`);
    this.emit('run', { runId, kind: 'schedule', scheduleId: id, state: 'started' });

    let done = false;
    const finish = async (code, error = null) => {
      if (done) return;
      done = true;
      if (this.running.get(id) === slot) this.running.delete(id);
      let report = null;
      try {
        const { readFile } = await import('node:fs/promises');
        report = JSON.parse(await readFile(path.join(reportDir, 'run.json'), 'utf8'));
      } catch { /* the runner may have failed before writing one */ }
      const verdicts = report?.flows?.reduce((acc, f) => { acc[f.verdict] = (acc[f.verdict] ?? 0) + 1; return acc; }, {}) ?? null;
      const verdict = overallVerdict(report, code);
      const summary = await this.evidence.finishRun(runId, {
        ok: code === 0,
        exitCode: code,
        verdict,
        ...(error ? { error } : {}),
        verdicts,
        reportDir: reportDir.replace(/\\/g, '/'),
        stdoutTail: tail.out.slice(-2_000),
        stderrTail: tail.err.slice(-2_000),
      });
      try {
        this.#patch(id, { lastExitCode: code, lastRun: { runId, at: startedAt, finishedAt: Date.now(), exitCode: code, verdict } });
      } catch { /* entry removed meanwhile */ }
      this.log(`[schedule] ${id} run ${runId} finished with exit ${code}`);
      this.emit('run', { runId, kind: 'schedule', scheduleId: id, state: 'finished', exitCode: code, summary });
    };
    child.on('exit', (code) => finish(code ?? -1));
    child.on('error', (err) => finish(-1, err.message));
    return { runId, dir: dir.replace(/\\/g, '/') };
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
