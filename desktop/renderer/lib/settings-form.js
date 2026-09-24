/**
 * The daemon settings form, as data. Shared by the renderer (Settings view) and the main process
 * (the updater reads its URL/channel through `pickUpdateConfig`). Browser-safe: no Node, no DOM.
 *
 * The first path of every field is the daemon's own key (daemon/settings.js DEFAULTS: humanize,
 * stealth, defaultBrowser, headless, maxParallel, evidence.{maxFrames,maxBytes,keepRuns,quality},
 * idleExitMinutes, updateUrl). Later paths are older spellings. The form reads whichever path the
 * daemon reports and writes the change back to that same path — a renamed key degrades to
 * "not reported", never to a write into a key the daemon ignores. `updateChannel` is the desktop's
 * own addition; the daemon stores unknown keys as they are. Anything the form does not know is
 * still editable in the view's raw JSON panel.
 *
 * `scale`: the stored value is `shown × scale` (evidence.maxBytes is bytes; the form shows MB).
 */

export const LEVELS = ['off', 'human', 'stealth'];
/**
 * A calibrated humanize profile is used by its name (plan §6.7: humanize:"team-qa"), so the
 * human-input fields take a level OR such a name. The pattern is the one profile files are saved
 * under; anything else is refused by name rather than quietly replaced with a level.
 */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function isHumanizeValue(v) {
  return LEVELS.includes(v) || PROFILE_NAME.test(String(v ?? ''));
}
export const BROWSERS = ['auto', 'edge', 'chrome', 'cft'];
export const CHANNELS = ['stable', 'beta'];
const MB = 1024 * 1024;

export const SETTINGS_FIELDS = [
  {
    key: 'humanize', group: 'Defaults for new runs', label: 'Human input', type: 'select', options: LEVELS, default: 'human', custom: PROFILE_NAME,
    help: 'How pointer and keyboard input is planned when a run does not say: a level, or the name of a calibrated profile. "off" dispatches instantly, as v1 did.',
    paths: ['humanize', 'defaults.humanize', 'defaultHumanize'],
  },
  {
    key: 'stealth', group: 'Defaults for new runs', label: 'Stealth level', type: 'select', options: LEVELS, default: 'off',
    help: '"stealth" never enables the Runtime domain, so console capture is unavailable in those runs.',
    paths: ['stealth', 'defaults.stealth', 'defaultStealth'],
  },
  {
    key: 'browser', group: 'Defaults for new runs', label: 'Browser', type: 'select', options: BROWSERS, default: 'auto',
    help: '"auto" uses the pinned Chrome for Testing when installed, else Edge, else Chrome.',
    paths: ['defaultBrowser', 'browser', 'defaults.browser'],
  },
  {
    key: 'headless', group: 'Defaults for new runs', label: 'Run headless', type: 'boolean', default: true,
    help: 'Headless runs have no window, so minimizing, locking or covering the screen cannot pause them.',
    paths: ['headless', 'defaults.headless'],
  },
  {
    key: 'maxParallel', group: 'Defaults for new runs', label: 'Actions at the same time', type: 'number', min: 1, max: 256, step: 1, default: 8,
    help: 'How many changing actions launched engines run at once. Reading a page is never limited.',
    paths: ['maxParallel'],
  },
  {
    key: 'evidenceMaxFrames', group: 'Evidence', label: 'Frames kept per run', type: 'number', min: 0, max: 1_000_000, step: 100, default: 3000,
    help: 'Later frames are counted, not written; the run itself continues.',
    paths: ['evidence.maxFrames'],
  },
  {
    key: 'evidenceMaxMB', group: 'Evidence', label: 'Frame storage per run (MB)', type: 'number', min: 0, max: 65_536, step: 10, default: 300, scale: MB,
    paths: ['evidence.maxBytes'],
  },
  {
    key: 'evidenceKeepRuns', group: 'Evidence', label: 'Runs kept', type: 'number', min: 1, max: 100_000, step: 10, default: 200,
    help: 'The oldest run folders are removed when a new run starts. A run in progress is never removed.',
    paths: ['evidence.keepRuns'],
  },
  {
    key: 'evidenceQuality', group: 'Evidence', label: 'Frame JPEG quality', type: 'number', min: 1, max: 100, step: 5, default: 60,
    paths: ['evidence.quality'],
  },
  {
    key: 'idleExitMinutes', group: 'Daemon', label: 'Exit when idle for (minutes)', type: 'number', min: 0, max: 60 * 24 * 30, step: 5, default: 60,
    help: '0 keeps it running. The daemon never exits while an engine runs, a client is connected or a schedule is enabled.',
    paths: ['idleExitMinutes', 'daemon.idleExitMinutes'],
  },
  {
    key: 'updateUrl', group: 'Updates', label: 'Update server URL', type: 'url', default: '',
    help: 'An http(s) folder holding latest.yml and the installer. Empty means updates are not configured.',
    paths: ['updateUrl', 'update.url', 'updates.url'],
  },
  {
    key: 'updateChannel', group: 'Updates', label: 'Channel', type: 'select', options: CHANNELS, default: 'stable',
    paths: ['updateChannel', 'update.channel', 'updates.channel'],
  },
];

export function getPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

/** The field's current value (in form units): the first reported path wins; else the default, marked absent. */
export function readField(settings, field) {
  for (const p of field.paths) {
    const v = getPath(settings ?? {}, p);
    if (v !== undefined) {
      const shown = field.scale && typeof v === 'number' ? Math.round((v / field.scale) * 100) / 100 : v;
      return { value: shown, path: p, present: true };
    }
  }
  return { value: field.default, path: field.paths[0], present: false };
}

/** Coerce a raw form value (strings from inputs) to the field's type. Throws a readable Error. */
export function coerceField(field, raw) {
  switch (field.type) {
    case 'boolean':
      return raw === true || raw === 'true' || raw === 'on' || raw === 1 || raw === '1';
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n) || String(raw).trim() === '') throw new Error(`${field.label}: enter a number.`);
      if (field.min !== undefined && n < field.min) throw new Error(`${field.label}: the minimum is ${field.min}.`);
      if (field.max !== undefined && n > field.max) throw new Error(`${field.label}: the maximum is ${field.max}.`);
      if (!field.scale && !Number.isInteger(n)) throw new Error(`${field.label}: use a whole number.`);
      return n;
    }
    case 'select': {
      const v = String(raw ?? '').trim();
      if (field.options.includes(v)) return v;
      if (field.custom && field.custom.test(v)) return v;
      throw new Error(`${field.label}: choose one of ${field.options.join(', ')}${field.custom ? ', or type a calibrated profile name' : ''}.`);
    }
    case 'url': {
      const v = String(raw ?? '').trim();
      const problem = validateUpdateUrl(v);
      if (problem) throw new Error(`${field.label}: ${problem}`);
      return v;
    }
    default:
      return raw;
  }
}

/**
 * '' is valid (not configured). Otherwise an absolute https:// URL — or http:// on the loopback
 * address, for a local test feed. Returns a problem string or null.
 *
 * https, not "http(s)": the installer G9 downloads from this feed is unsigned, so TLS to the feed
 * host is the only thing that authenticates it (desktop review, 2026-09-22).
 */
export function validateUpdateUrl(v) {
  if (!v) return null;
  let u;
  try {
    u = new URL(v);
  } catch {
    return 'not a valid URL.';
  }
  const loopback = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(u.hostname);
  if (u.protocol === 'http:' && !loopback) return 'use an https:// address: the update is authenticated only by TLS to this host (plain http would let anyone on the path hand G9 an installer). http:// is allowed on localhost for a test feed.';
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'use an https:// address (the updater downloads over HTTPS; serve a file share through a web server).';
  if (u.username || u.password) return 'do not put credentials in the URL.';
  return null;
}

/**
 * The minimal `settings.set` patch for the form values that changed. Unknown keys in `values`
 * are ignored; each changed field is written at the path it was read from, in stored units.
 * @returns {{ patch: object, changed: string[] }}
 */
export function buildSettingsPatch(settings, values) {
  const patch = {};
  const changed = [];
  for (const field of SETTINGS_FIELDS) {
    if (!(field.key in values)) continue;
    const current = readField(settings, field);
    const next = coerceField(field, values[field.key]);
    if (current.present && Object.is(current.value, next)) continue;
    if (!current.present && Object.is(field.default, next)) continue;
    setPath(patch, current.path, field.scale ? Math.round(next * field.scale) : next);
    changed.push(field.key);
  }
  return { patch, changed };
}

/** What the updater needs, from daemon settings with a desktop-local fallback. */
export function pickUpdateConfig(daemonSettings, fallback = {}) {
  const urlField = SETTINGS_FIELDS.find((f) => f.key === 'updateUrl');
  const chField = SETTINGS_FIELDS.find((f) => f.key === 'updateChannel');
  const url = readField(daemonSettings, urlField);
  const ch = readField(daemonSettings, chField);
  return {
    url: String((url.present ? url.value : fallback.url) ?? '').trim(),
    channel: String((ch.present ? ch.value : fallback.channel) ?? 'stable'),
    source: url.present ? 'daemon' : fallback.url ? 'desktop' : 'none',
  };
}
