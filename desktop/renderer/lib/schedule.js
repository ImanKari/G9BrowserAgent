/**
 * Schedule entries, as data (the Schedule view). Pure and browser-safe.
 *
 * The daemon's shape (daemon/scheduler.js): a due entry runs
 *   runner/g9.mjs run <target> …args --report runs/<runId>/report
 *   { id, name, target: 'suite:smoke' | '<flow id>' | 'tag:<t>' | 'all', args: ['--env','staging', …],
 *     daily: 'HH:MM' | everyMinutes: N, enabled, createdAt, lastRunAt, lastExitCode, lastRunId }
 *   schedule.list adds { nextRunAt, running }.
 * So the engine options of the form become runner flags in `args` (runner/g9.mjs --help).
 * The entry also carries the protocol's display words (`suite`, `at`, `env`, `engine`,
 * DAEMON_PROTOCOL §6 schedule.add): the daemon keeps them for display and derives nothing twice,
 * because explicit `args` win over flags it would derive from them.
 */

import { LEVELS, BROWSERS, isHumanizeValue } from './settings-form.js';
import { verdictLabel, verdictTone } from './runs.js';

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_EVERY = 60 * 24 * 31;

/**
 * The runner flags for the form's engine options — every one the form showed, explicitly. Leaving
 * "defaults" out would hand them to whatever the daemon's defaults are on the night the entry
 * runs (a later Settings change would silently alter a scheduled suite), and g9d would derive the
 * missing ones from the display words anyway (measured against the real daemon: it appended
 * --stealth off --profile automation). Explicit means the run is what the person saw.
 */
export function runnerArgs({ env, browser, headless, humanize, stealth, profile }) {
  const args = [];
  if (env) args.push('--env', env);
  if (browser) args.push('--browser', browser);
  if (headless === false) args.push('--headed');
  else if (headless === true) args.push('--headless');
  if (humanize) args.push('--humanize', humanize);
  if (stealth) args.push('--stealth', stealth);
  if (profile) args.push('--profile', profile);
  return args;
}

/** The engine options back out of an entry's args (for display). Unknown flags are kept in `other`. */
export function parseRunnerArgs(args) {
  const out = { env: null, browser: 'auto', headless: null, humanize: 'human', stealth: 'off', profile: 'automation', project: null, other: [] };
  const a = Array.isArray(args) ? args : [];
  for (let i = 0; i < a.length; i++) {
    const flag = a[i];
    const next = a[i + 1];
    switch (flag) {
      case '--env': out.env = next ?? null; i++; break;
      case '--browser': out.browser = next ?? 'auto'; i++; break;
      case '--humanize': out.humanize = next ?? 'human'; i++; break;
      case '--stealth': out.stealth = next ?? 'off'; i++; break;
      case '--profile': out.profile = next ?? 'automation'; i++; break;
      // Added by the daemon for an entry with a project (scheduler.js normalizeEntry): where the flows
      // come from, not how the engine runs — kept out of the Engine column, path and all.
      case '--project': out.project = next ?? null; i++; break;
      case '--headless': out.headless = true; break;
      case '--headed': out.headless = false; break;
      default: out.other.push(flag);
    }
  }
  return out;
}

/** A target as the runner reads it: `suite:x`, `tag:x`, `all`, or a flow id/name. */
export function normalizeTarget(raw) {
  const t = String(raw ?? '').trim();
  if (!t) throw new Error('What to run: a flow id, suite:<name>, tag:<name> or all.');
  if (t.length > 200) throw new Error('What to run: 200 characters at most.');
  if (/\s--/.test(t)) throw new Error('What to run: put runner options in the fields below, not here.');
  return t;
}

/**
 * Validate the add form. Throws an Error naming the field; returns the entry for `schedule.add`.
 * @param {object} f  raw form values (strings from inputs)
 */
export function buildScheduleEntry(f) {
  const target = normalizeTarget(f.target ?? f.suite);
  const env = String(f.env ?? '').trim() || null;
  if (env && !/^[A-Za-z0-9._-]{1,64}$/.test(env)) throw new Error('Environment: letters, digits, dot, dash and underscore only.');
  const mode = f.mode === 'every' ? 'every' : 'daily';
  const entry = { target, name: String(f.name ?? '').trim() || target, enabled: true };
  if (mode === 'daily') {
    const t = String(f.at ?? f.daily ?? '').trim();
    if (!TIME.test(t)) throw new Error('Time of day: use HH:MM, 24-hour (for example 06:30).');
    entry.daily = t;
  } else {
    const n = Number(String(f.everyMinutes ?? '').trim());
    if (!Number.isInteger(n) || n < 1 || n > MAX_EVERY) throw new Error(`Every: a whole number of minutes from 1 to ${MAX_EVERY}.`);
    entry.everyMinutes = n;
  }
  const browser = f.browser == null || f.browser === '' ? 'auto' : String(f.browser);
  if (!BROWSERS.includes(browser)) throw new Error(`Browser: one of ${BROWSERS.join(', ')}.`);
  const humanize = f.humanize == null || String(f.humanize).trim() === '' ? 'human' : String(f.humanize).trim();
  if (!isHumanizeValue(humanize)) throw new Error(`Human input: ${LEVELS.join(', ')}, or the name of a calibrated profile.`);
  const stealth = f.stealth == null || f.stealth === '' ? 'off' : String(f.stealth);
  if (!LEVELS.includes(stealth)) throw new Error(`Stealth level: one of ${LEVELS.join(', ')}.`);
  const profile = String(f.profile ?? '').trim() || 'automation';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(profile) || profile.startsWith('.')) throw new Error('Profile: letters, digits, dot, dash and underscore only.');
  const headless = f.headless === undefined ? true : !!f.headless;
  entry.args = runnerArgs({ env, browser, headless, humanize, stealth, profile });
  // Display words (what the person chose), next to the runner words that are executed.
  entry.suite = target;
  if (entry.daily) entry.at = entry.daily;
  if (env) entry.env = env;
  entry.engine = { browser, headless, humanize, stealth, profile };
  return entry;
}

export function describeWhen(entry) {
  const e = entry ?? {};
  if (e.everyMinutes) {
    const n = Number(e.everyMinutes);
    if (n % 60 === 0) return `Every ${n / 60 === 1 ? 'hour' : `${n / 60} hours`}`;
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }
  const daily = e.daily ?? e.at;
  if (daily) return `Daily at ${daily}`;
  if (e.cron) return `Cron ${e.cron}`;
  return 'Not scheduled';
}

/** "edge, headless, input stealth" from an entry (its args) or a plain engine object. */
export function describeEngine(entryOrEngine) {
  const x = entryOrEngine ?? {};
  const e = Array.isArray(x.args) ? parseRunnerArgs(x.args) : x.engine ?? x;
  const parts = [e.browser ?? 'auto', e.headless === false ? 'headed' : 'headless'];
  if (e.humanize && e.humanize !== 'human') parts.push(`input ${e.humanize}`);
  if (e.stealth && e.stealth !== 'off') parts.push(`stealth ${e.stealth}`);
  if (e.profile && e.profile !== 'automation') parts.push(`profile ${e.profile}`);
  if (e.other?.length) parts.push(e.other.join(' '));
  return parts.join(', ');
}

/** Environment of an entry (from its args). */
export function entryEnv(entry) {
  if (entry?.env) return entry.env;
  return Array.isArray(entry?.args) ? parseRunnerArgs(entry.args).env : null;
}

/** Rows of schedule.list, whatever envelope. */
export function scheduleRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.entries)) return result.entries;
  if (Array.isArray(result?.schedule)) return result.schedule;
  if (Array.isArray(result?.items)) return result.items;
  return [];
}

/**
 * The next time a daily entry fires after `now` (local time), for display when the daemon does
 * not report `nextRunAt` itself.
 */
export function nextDailyRun(at, now = new Date()) {
  const m = TIME.exec(String(at ?? ''));
  if (!m) return null;
  const next = new Date(now);
  next.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/**
 * The last result of an entry, as { label, tone }. g9d keeps `lastRun: { runId, at, finishedAt,
 * exitCode, verdict }` (the worst verdict of the suite); older entries only `lastExitCode`.
 */
export function lastResult(entry) {
  if (entry?.running) return { label: 'Running', tone: 'live' };
  const last = entry?.lastRun && typeof entry.lastRun === 'object' ? entry.lastRun : null;
  const exitCode = last?.exitCode ?? entry?.lastExitCode ?? null;
  if (last?.verdict) {
    const label = verdictLabel(last.verdict);
    return { label: exitCode && !/fail/i.test(label) ? `${label} (exit ${exitCode})` : label, tone: verdictTone(last.verdict) };
  }
  if (exitCode == null) return entry?.lastRunAt ? { label: 'Started', tone: '' } : { label: 'Never ran', tone: '' };
  if (exitCode === 0) return { label: 'Passed', tone: 'ok' };
  return { label: `Failed (exit ${exitCode})`, tone: 'fail' };
}

/** The run to open for an entry's last result, if any. */
export function lastRunId(entry) {
  return entry?.lastRun?.runId ?? entry?.lastRunId ?? null;
}
