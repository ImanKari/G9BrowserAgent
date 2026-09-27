/**
 * Daemon settings — `G9_HOME/settings.json`.
 *
 * One small JSON file the desktop app edits through `settings.set` and a person
 * can edit by hand. Unknown keys are kept (a newer desktop may write fields an
 * older daemon does not know yet, and silently dropping them would erase the
 * user's choice on the next save); known keys are validated, and a bad value is
 * refused by name rather than coerced — a setting that quietly means something
 * other than what it says is worse than one that fails to save.
 */

import fs from 'node:fs';
import { writeFileAtomicSync } from './paths.js';
import { validateEntry } from './scheduler.js';

export const HUMANIZE_LEVELS = ['off', 'human', 'stealth'];
/** The desktop app's update channels (electron-updater: 'stable' → its 'latest' channel). */
export const UPDATE_CHANNELS = ['stable', 'beta'];
/** Where the desktop app's updates come from: the official GitHub releases, an https folder, or nowhere. */
export const UPDATE_MODES = ['official', 'custom', 'off'];
export const STEALTH_LEVELS = ['off', 'human', 'stealth'];
export const BROWSERS = ['auto', 'edge', 'chrome', 'cft'];

export const DEFAULTS = Object.freeze({
  port: 8765,
  /** auto = pinned Chrome for Testing if installed, else Edge, else Chrome (engine/find.js). */
  defaultBrowser: 'auto',
  headless: true,
  /** 'off' | 'human' | 'stealth' | a calibrated profile name. */
  humanize: 'human',
  stealth: 'off',
  /** Concurrent MUTATING Engine 2 calls; reads are never limited. P8 measures the real number. */
  maxParallel: 8,
  evidence: Object.freeze({
    /** Frames kept per run; later frames are counted, not written. */
    maxFrames: 3000,
    /** Bytes of frames kept per run. */
    maxBytes: 300 * 1024 * 1024,
    /** Run directories kept; the oldest are pruned when a new run starts. */
    keepRuns: 200,
    quality: 60,
    maxWidth: 1280,
    maxHeight: 800,
  }),
  /** Exit after this long with no client, no launched engine and no enabled schedule. 0 = never. */
  idleExitMinutes: 60,
  /**
   * Where the desktop app updates from (desktop/lib/updater.mjs): 'official' (the default) is the
   * published G9BrowserAgent releases on GitHub and needs nothing configured; 'custom' uses `updateUrl`;
   * 'off' never checks.
   */
  updateMode: 'official',
  /**
   * For updateMode 'custom': an https:// URL of an electron-updater "generic" feed (http:// only on
   * localhost, for a test feed). file:// is refused (F6): electron-updater's generic provider
   * downloads over http(s) only, so a file:// feed saved fine and then failed every check on every
   * QA machine with "the configured URL is not usable".
   */
  updateUrl: '',
  /** Which releases the desktop app follows: 'stable' | 'beta'. */
  updateChannel: 'stable',
  schedule: Object.freeze([]),
});

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.host;
  } catch {
    return false;
  }
}

/** Deep clone of JSON data. */
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * Merge a patch into settings. Objects merge one level deep for `evidence`
 * (a patch of `{evidence:{keepRuns:5}}` must not erase the other caps);
 * arrays and scalars replace; `null` resets a key to its default.
 */
export function mergeSettings(base, patch) {
  const out = clone(base) ?? {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) {
      if (key in DEFAULTS) out[key] = clone(DEFAULTS[key]);
      else delete out[key];
    } else if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = { ...out[key], ...clone(value) };
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}

/** Problems with a settings object, [] when valid. Validates known keys only. */
export function validateSettings(s) {
  const problems = [];
  const int = (key, min, max) => {
    const v = s[key];
    if (!Number.isInteger(v) || v < min || v > max) problems.push(`${key} must be an integer ${min}..${max} (got ${JSON.stringify(v)}).`);
  };
  int('port', 1, 65_535);
  if (!BROWSERS.includes(s.defaultBrowser)) problems.push(`defaultBrowser must be one of ${BROWSERS.join(', ')} (got ${JSON.stringify(s.defaultBrowser)}).`);
  if (typeof s.headless !== 'boolean') problems.push('headless must be true or false.');
  if (typeof s.humanize !== 'string' || !s.humanize.trim()) {
    problems.push(`humanize must be one of ${HUMANIZE_LEVELS.join(', ')} or a calibrated profile name.`);
  }
  if (!STEALTH_LEVELS.includes(s.stealth)) problems.push(`stealth must be one of ${STEALTH_LEVELS.join(', ')} (got ${JSON.stringify(s.stealth)}).`);
  int('maxParallel', 1, 256);
  int('idleExitMinutes', 0, 60 * 24 * 30);
  if (!UPDATE_MODES.includes(s.updateMode)) problems.push(`updateMode must be one of ${UPDATE_MODES.join(', ')} (got ${JSON.stringify(s.updateMode)}).`);
  if (s.updateMode === 'custom' && typeof s.updateUrl === 'string' && !s.updateUrl.trim()) problems.push('updateMode "custom" needs updateUrl (an https:// folder).');
  if (typeof s.updateUrl !== 'string') problems.push('updateUrl must be a string (used only when updateMode is "custom").');
  else if (/^file:/i.test(s.updateUrl.trim())) {
    problems.push(
      'updateUrl cannot be a file:// URL: the desktop app\'s updater (electron-updater, generic provider) downloads ' +
        'over http(s) only. Serve that folder over http(s) — any static web server or file share with a web front — ' +
        'and use its http(s):// address, or leave updateUrl empty.',
    );
  } else if (s.updateUrl && !isHttpUrl(s.updateUrl.trim())) {
    problems.push('updateUrl must be an https:// URL, or empty.');
  } else if (s.updateUrl && /^http:/i.test(s.updateUrl.trim()) && !/^http:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)([:/]|$)/i.test(s.updateUrl.trim())) {
    problems.push(
      'updateUrl must be https:// (or http:// on localhost, for a test feed): the installer G9BrowserAgent downloads is authenticated ' +
        'by TLS to that host alone, so a plain-http feed would let anyone on the network path hand the app an installer.',
    );
  }
  if (!UPDATE_CHANNELS.includes(s.updateChannel)) {
    problems.push(`updateChannel must be one of ${UPDATE_CHANNELS.join(', ')} (got ${JSON.stringify(s.updateChannel)}).`);
  }
  if (!isPlainObject(s.evidence)) {
    problems.push('evidence must be an object.');
  } else {
    const e = s.evidence;
    const eint = (key, min, max) => {
      if (!Number.isInteger(e[key]) || e[key] < min || e[key] > max) problems.push(`evidence.${key} must be an integer ${min}..${max} (got ${JSON.stringify(e[key])}).`);
    };
    eint('maxFrames', 0, 1_000_000);
    eint('maxBytes', 0, 64 * 1024 * 1024 * 1024);
    eint('keepRuns', 1, 100_000);
    eint('quality', 1, 100);
    eint('maxWidth', 64, 8192);
    eint('maxHeight', 64, 8192);
  }
  if (!Array.isArray(s.schedule)) {
    problems.push('schedule must be an array (use the schedule.* admin ops to edit it).');
  } else {
    // Every stored entry must be runnable: an entry without an id cannot be
    // removed or run, and a malformed one would fail every tick in silence.
    const ids = new Set();
    s.schedule.forEach((entry, i) => {
      const own = [...validateEntry(entry)];
      if (entry && typeof entry === 'object' && (typeof entry.id !== 'string' || !entry.id)) own.push('it has no id');
      else if (entry?.id && ids.has(entry.id)) own.push(`id "${entry.id}" is used twice`);
      if (entry?.id) ids.add(entry.id);
      if (own.length) problems.push(`schedule entry ${i + 1}${entry?.id ? ` (${entry.id})` : ''}: ${own.join(' ')}`);
    });
  }
  return problems;
}

export class Settings {
  constructor(file, { log = () => {} } = {}) {
    this.file = file;
    this.log = log;
    this.listeners = new Set();
    this.data = clone(DEFAULTS);
    this.loadProblems = [];
    this.load();
  }

  /**
   * Read the file, merge over DEFAULTS, and keep going on a broken file: the
   * daemon must start with defaults and SAY the file was ignored, not refuse to
   * start because someone mistyped a comma.
   */
  load() {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!isPlainObject(raw)) throw new Error('not a JSON object');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.loadProblems = [`${this.file} could not be read (${err.message}); using defaults.`];
        this.log(`[settings] ${this.loadProblems[0]}`);
      }
      raw = {};
    }
    const merged = mergeSettings(DEFAULTS, raw);
    // Before updateMode existed, a URL was the only way to turn updates on: keep that meaning.
    if (!('updateMode' in raw) && typeof raw.updateUrl === 'string' && raw.updateUrl.trim()) merged.updateMode = 'custom';
    // A broken schedule ENTRY costs that entry, not the whole schedule: the
    // other entries are somebody's nightly runs.
    if (Array.isArray(merged.schedule)) {
      const kept = [];
      const seen = new Set();
      for (const entry of merged.schedule) {
        const bad = validateEntry(entry).length || typeof entry?.id !== 'string' || !entry.id || seen.has(entry.id);
        if (bad) {
          const why = `ignored schedule entry ${JSON.stringify(entry?.id ?? entry?.target ?? null)}: ${[...validateEntry(entry), ...(typeof entry?.id !== 'string' || !entry?.id ? ['it has no id'] : seen.has(entry.id) ? ['duplicate id'] : [])].join(' ')}`;
          this.loadProblems.push(why);
          this.log(`[settings] ${why}`);
          continue;
        }
        seen.add(entry.id);
        kept.push(entry);
      }
      merged.schedule = kept;
    }
    const problems = validateSettings(merged);
    if (problems.length) {
      // Keep what is valid: reset only the offending keys to their defaults.
      for (const problem of problems) {
        const key = problem.split(/[ .]/)[0];
        if (key in DEFAULTS) merged[key] = clone(DEFAULTS[key]);
      }
      this.loadProblems.push(...problems.map((p) => `ignored: ${p}`));
      for (const p of problems) this.log(`[settings] ignored invalid value: ${p}`);
    }
    this.data = merged;
    return this.data;
  }

  get() {
    return clone(this.data);
  }

  /** Validate and persist a patch. Throws with every problem named; nothing is written on failure. */
  set(patch) {
    if (!isPlainObject(patch)) throw new Error('settings.set needs a patch object, e.g. { "headless": false }.');
    const next = mergeSettings(this.data, patch);
    const problems = validateSettings(next);
    if (problems.length) throw new Error(`Settings not saved:\n- ${problems.join('\n- ')}`);
    this.data = next;
    this.save();
    for (const fn of this.listeners) {
      try { fn(this.get(), patch); } catch { /* a listener must not undo a save */ }
    }
    return this.get();
  }

  save() {
    writeFileAtomicSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
