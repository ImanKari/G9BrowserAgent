// engine/find.js — which real browsers are on this machine, where, and which version.
//
// Engine 2 drives stock Edge, Chrome or Chrome for Testing (decision D1, AIGuide §2.0). This module answers three
// questions without touching any browser profile and without starting a browser (the one
// exception, a last-resort `--version` probe for CfT, runs headless on a throwaway profile):
//   findBrowsers()        every installed candidate, with its version
//   resolveBrowser(kind)  the one to launch for 'auto' | 'edge' | 'chrome' | 'cft' (or a path)
//   exeVersion(path)      the version of one executable
//
// VERSIONS ARE READ FROM THE EXECUTABLE ITSELF. On Windows the obvious shortcuts are wrong at the
// worst moment: while a browser update is staged but not applied, the Application folder holds TWO
// version directories (the running one and the staged one), `new_msedge.exe` sits next to
// `msedge.exe`, and `msedge.VisualElementsManifest.xml` already names the NEW version. Measured on
// the owner's machine 2026-09-21: dirs 153.0.4234.32 and 153.0.4234.48, manifest says .48, but
// msedge.exe — the binary that actually starts — is .32. The PE version resource of the exe is the
// truth, costs a ~5 MB read and ~5 ms, and needs no wmic/PowerShell. The version-named directory is
// only a fallback, and only when there is exactly one.

import { access, readFile, readdir, stat, mkdtemp, rm } from 'node:fs/promises';
import { constants as fsConstants, existsSync, realpathSync } from 'node:fs';
import { spawn, spawnSync, execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

export const KINDS = ['edge', 'chrome', 'cft'];

/**
 * G9's data home (ARCHITECTURE_V2 §9): `G9_HOME`, else %LOCALAPPDATA%\G9 on Windows, else ~/.g9.
 * Every engine function also accepts `{ home }` so the daemon can pass its own.
 */
export function g9Home(env = process.env) {
  if (env.G9_HOME) return path.resolve(env.G9_HOME);
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'G9');
  }
  return path.join(os.homedir(), '.g9');
}

/**
 * A Windows system tool by full path (%SystemRoot%\System32\…), falling back to the bare name.
 * Never trust PATH for these: under Git Bash, PATH puts GNU tools first (its `tar` cannot read a
 * zip — see cft.js systemTar), and a QA machine's PATH is whatever its software made it.
 */
export function systemBinary(relative) {
  if (process.platform !== 'win32') return path.basename(relative);
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const full = path.join(root, 'System32', relative);
  return existsSync(full) ? full : path.basename(relative);
}

// ─── version of an executable ────────────────────────────────────────────────────────────────

const VS_KEY = Buffer.from('VS_VERSION_INFO\0', 'utf16le');
const VS_FIXEDFILEINFO_SIGNATURE = 0xfeef04bd;

/**
 * Parse the VS_FIXEDFILEINFO of a PE image (Windows .exe/.dll) → "153.0.4234.32", or null.
 *
 * The version resource is a VS_VERSIONINFO block: wLength, wValueLength, wType, the UTF-16 key
 * "VS_VERSION_INFO\0", padding to a 32-bit boundary, then VS_FIXEDFILEINFO (signature 0xFEEF04BD).
 * Anchoring on the key — not on the bare signature — matters: the four signature bytes also occur
 * in code sections (they did in msedge.exe, twice, with garbage versions after them).
 */
export function peVersion(buffer) {
  let at = buffer.indexOf(VS_KEY);
  while (at !== -1) {
    const start = at - 6;
    if (start >= 0) {
      const afterKey = at + VS_KEY.length;
      const value = start + ((afterKey - start + 3) & ~3);
      if (value + 52 <= buffer.length && buffer.readUInt32LE(value) === VS_FIXEDFILEINFO_SIGNATURE) {
        const ms = buffer.readUInt32LE(value + 8);    // dwFileVersionMS
        const ls = buffer.readUInt32LE(value + 12);   // dwFileVersionLS
        const version = `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
        if (version !== '0.0.0.0') return version;
      }
    }
    at = buffer.indexOf(VS_KEY, at + 2);
  }
  return null;
}

const VERSION_DIR = /^\d+\.\d+\.\d+\.\d+$/;

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Version-named directories next to an exe (Chrome/Edge/CfT layout: Application\153.0.x.y\). */
export async function versionDirs(exePath) {
  try {
    const entries = await readdir(path.dirname(exePath), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && VERSION_DIR.test(e.name)).map((e) => e.name).sort(compareVersions);
  } catch {
    return [];
  }
}

/**
 * `<version>.manifest` next to the exe — the flat Chrome for Testing layout (chrome-win64\ holds
 * 153.0.8010.52.manifest beside chrome.exe; there is no version directory). Only when there is
 * exactly one, for the same reason as versionDirs.
 */
export async function manifestVersion(exePath) {
  try {
    const names = (await readdir(path.dirname(exePath))).filter((n) => /^\d+\.\d+\.\d+\.\d+\.manifest$/i.test(n));
    return names.length === 1 ? names[0].slice(0, -'.manifest'.length) : null;
  } catch {
    return null;
  }
}

/**
 * The version of a browser executable, and where the answer came from.
 * Order: PE resource (Windows) → the single version directory next to it → the single
 * `<version>.manifest` next to it (CfT's flat layout) → `--version` (only for Chrome for Testing on
 * Windows, and for every browser elsewhere, where it actually prints).
 */
export async function exeVersionInfo(exePath, { kind } = {}) {
  if (process.platform === 'win32') {
    try {
      const version = peVersion(await readFile(exePath));
      if (version) return { version, source: 'pe' };
    } catch {}
  }
  const dirs = await versionDirs(exePath);
  if (dirs.length === 1) return { version: dirs[0], source: 'dir' };
  if (kind === 'cft' || process.platform === 'win32') {
    const fromManifest = await manifestVersion(exePath);
    if (fromManifest) return { version: fromManifest, source: 'manifest' };
  }
  if (process.platform !== 'win32' || kind === 'cft') {
    const printed = await versionFromCli(exePath);
    if (printed) return { version: printed, source: 'cli' };
  }
  if (dirs.length > 1) {
    // Two directories = an update is staged. The running binary is usually the OLDER one; say so
    // instead of guessing silently.
    return { version: dirs[0], source: 'dir-ambiguous', candidates: dirs };
  }
  return { version: null, source: 'unknown' };
}

export async function exeVersion(exePath, opts) {
  return (await exeVersionInfo(exePath, opts)).version;
}

/**
 * `<exe> --version`. On POSIX Chromium prints the version and exits. On Windows chrome.exe has no
 * --version handler (it is POSIX-only in chrome_main_delegate.cc): the switch is ignored and the
 * BROWSER STARTS — on its default user-data dir, with a window. So on Windows the probe carries a
 * throwaway --user-data-dir and --headless=new, and whatever it started is killed as a tree when
 * the probe ends; it can never open a window or touch a real profile. The manifest fallback above
 * means this is practically never reached for an installed CfT.
 */
async function versionFromCli(exePath, { timeoutMs = 8000 } = {}) {
  const win = process.platform === 'win32';
  let scratch = null;
  if (win) {
    try { scratch = await mkdtemp(path.join(os.tmpdir(), 'g9-version-probe-')); } catch { return null; }
  }
  const args = win
    ? ['--version', '--headless=new', `--user-data-dir=${scratch}`, '--no-first-run', '--no-default-browser-check', '--disable-component-update', 'about:blank']
    : ['--version'];
  const printed = await new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(exePath, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      if (win && child.pid) spawnSync(systemBinary('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
      else { try { child.kill('SIGKILL'); } catch {} }
      finish(out.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null);
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => finish(null));
    child.on('close', () => finish(out.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null));
  });
  if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  return printed;
}

// ─── candidates ──────────────────────────────────────────────────────────────────────────────

/**
 * Where browsers live. Windows: both Program Files trees (Edge Stable is under x86 even on 64-bit
 * Windows; Chrome moved to 64-bit Program Files), the per-user install location, and the registry
 * App Paths. Non-stable channels are listed after stable ones with `channel` set, so 'edge' and
 * 'chrome' resolve to the browser people actually use.
 */
export function candidatePaths(env = process.env) {
  const list = [];
  const add = (kind, channel, p) => { if (p) list.push({ kind, channel, path: p }); };
  if (process.platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const edge = (root, folder) => path.join(root, 'Microsoft', folder, 'Application', 'msedge.exe');
    const chrome = (root, folder) => path.join(root, 'Google', folder, 'Application', 'chrome.exe');
    for (const root of [pf86, pf, local]) add('edge', 'stable', edge(root, 'Edge'));
    for (const root of [pf, pf86, local]) add('chrome', 'stable', chrome(root, 'Chrome'));
    for (const [folder, channel] of [['Edge Beta', 'beta'], ['Edge Dev', 'dev'], ['Edge SxS', 'canary']]) {
      for (const root of [pf86, pf, local]) add('edge', channel, edge(root, folder));
    }
    for (const [folder, channel] of [['Chrome Beta', 'beta'], ['Chrome Dev', 'dev'], ['Chrome SxS', 'canary']]) {
      for (const root of [pf, pf86, local]) add('chrome', channel, chrome(root, folder));
    }
  } else if (process.platform === 'darwin') {
    // /Applications first; a per-user install (~/Applications, no admin rights) after it.
    for (const root of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      add('chrome', 'stable', path.join(root, 'Google Chrome.app/Contents/MacOS/Google Chrome'));
      add('edge', 'stable', path.join(root, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
    }
    add('chrome', 'beta', '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta');
    add('edge', 'beta', '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta');
  } else {
    for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']) add('chrome', 'stable', p);
    for (const p of ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge']) add('edge', 'stable', p);
    add('chrome', 'beta', '/usr/bin/google-chrome-beta');
    add('edge', 'beta', '/usr/bin/microsoft-edge-beta');
  }
  return list;
}

/**
 * Registry App Paths (HKCU then HKLM) — how Windows itself resolves `start msedge`.
 * Asynchronous on purpose: resolveBrowser runs on every launch inside the daemon, and four
 * synchronous reg.exe runs would stall every agent's socket for their duration.
 */
export async function appPathsFromRegistry() {
  if (process.platform !== 'win32') return [];
  const query = (key) => new Promise((resolve) => {
    execFile(systemBinary('reg.exe'), ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
  const keys = [];
  for (const [exe, kind] of [['msedge.exe', 'edge'], ['chrome.exe', 'chrome']]) {
    for (const hive of ['HKCU', 'HKLM']) keys.push({ kind, key: `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}` });
  }
  const answers = await Promise.all(keys.map((k) => query(k.key)));
  const out = [];
  keys.forEach(({ kind }, i) => {
    const m = answers[i]?.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/m);
    if (!m) return;
    const value = m[1].trim().replace(/^"(.*)"$/, '$1').replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`);
    out.push({ kind, channel: 'stable', path: value, source: 'app-paths' });
  });
  return out;
}

/** 'edge' | 'chrome' | 'cft' for an executable path, from its name and location. */
export function kindFromPath(exePath, { home } = {}) {
  const p = path.resolve(exePath);
  const lower = p.toLowerCase();
  const base = path.basename(lower);
  const engines = path.join(home ?? g9Home(), 'engines').toLowerCase();
  if (lower.startsWith(engines + path.sep) || /[\\/]chrome-(win64|win32|mac-x64|mac-arm64|linux64)[\\/]/.test(lower)) return 'cft';
  if (base.startsWith('msedge') || base.includes('microsoft edge')) return 'edge';
  return 'chrome';
}

async function isFile(p) {
  try {
    const s = await stat(p);
    if (!s.isFile()) return false;
    if (process.platform !== 'win32') await access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Every browser G9 could launch, in preference order within each kind (stable before other
 * channels, installed CfT newest first). Never starts a browser (except `--version` for CfT on
 * Windows when the exe has no readable version, or on non-Windows).
 * → [{ kind, path, version, channel, source, versionSource }]
 */
export async function findBrowsers({ home, env = process.env, includeRegistry = true } = {}) {
  const found = [];
  const seen = [];
  const consider = async (c) => {
    const resolved = path.resolve(c.path);
    if (seen.some((s) => samePath(s, resolved))) return;
    if (!(await isFile(resolved))) return;
    seen.push(resolved);
    const info = await exeVersionInfo(resolved, { kind: c.kind });
    found.push({
      kind: c.kind,
      path: resolved,
      version: info.version,
      channel: c.channel ?? 'stable',
      source: c.source ?? 'known-location',
      versionSource: info.source,
      ...(info.candidates ? { versionCandidates: info.candidates } : {}),
    });
  };
  for (const c of candidatePaths(env)) await consider(c);
  if (includeRegistry) for (const c of await appPathsFromRegistry()) await consider(c);

  // Chrome for Testing installed by engine/cft.js. Imported lazily: cft.js imports this module.
  const { installed } = await import('./cft.js');
  for (const cft of await installed({ home: home ?? g9Home(env) })) {
    await consider({ kind: 'cft', channel: 'pinned', path: cft.path, source: 'g9-home' });
    const row = found.find((f) => samePath(f.path, path.resolve(cft.path)));
    // The directory name is what cft.js verified at install time; prefer it over a CLI probe.
    if (row && !row.version) { row.version = cft.version; row.versionSource = 'install-dir'; }
  }
  const channelRank = { stable: 0, pinned: 0, beta: 1, dev: 2, canary: 3 };
  return found.sort((a, b) =>
    KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)
    || (channelRank[a.channel] ?? 9) - (channelRank[b.channel] ?? 9)
    || (a.kind === 'cft' ? -compareVersions(a.version ?? '0', b.version ?? '0') : 0));
}

/**
 * The browser to launch.
 *   'auto'   → the pinned Chrome for Testing if it is installed, else Edge, else Chrome
 *   'edge' | 'chrome' → that browser (stable channel first)
 *   'cft'    → the pinned CfT if installed, else the newest installed CfT
 *   a path   → that executable (kind inferred from its name/location)
 * Throws with what WAS found when nothing matches, so the message says what to do.
 * → { kind, path, version, channel, source }
 */
export async function resolveBrowser(kind = 'auto', { home, env = process.env } = {}) {
  const wanted = kind ?? 'auto';
  if (typeof wanted === 'object' && wanted.path) {
    const p = path.resolve(wanted.path);
    if (!(await isFile(p))) throw new Error(`Browser executable not found: ${p}`);
    const k = wanted.kind ?? kindFromPath(p, { home });
    return { kind: k, path: p, version: wanted.version ?? await exeVersion(p, { kind: k }), channel: wanted.channel ?? null, source: 'explicit' };
  }
  if (typeof wanted === 'string' && (wanted.includes('/') || wanted.includes('\\'))) {
    return resolveBrowser({ path: wanted }, { home, env });
  }
  if (wanted !== 'auto' && !KINDS.includes(wanted)) {
    throw new Error(`Unknown browser "${wanted}". Use one of: auto, ${KINDS.join(', ')}, or the full path to an executable.`);
  }
  const all = await findBrowsers({ home, env });
  const pick = (k) => all.find((b) => b.kind === k);
  let choice = null;
  if (wanted === 'auto' || wanted === 'cft') {
    const { pinned } = await import('./cft.js');
    const pin = pinned();
    choice = all.find((b) => b.kind === 'cft' && b.version === pin.version)
      ?? (wanted === 'cft' ? pick('cft') : null);
  }
  if (!choice && wanted === 'auto') choice = pick('edge') ?? pick('chrome');
  if (!choice && wanted !== 'auto' && wanted !== 'cft') choice = pick(wanted);
  if (!choice) {
    const have = all.length ? all.map((b) => `${b.kind} ${b.version ?? '?'} (${b.path})`).join('; ') : 'none';
    const hint = wanted === 'cft'
      ? 'Install the pinned Chrome for Testing first (engine/cft.js ensure(), or the desktop app\'s Engines screen).'
      : 'Install Microsoft Edge or Google Chrome, or pass the full path to a Chromium-based browser.';
    throw new Error(`No ${wanted === 'auto' ? 'usable' : wanted} browser was found. Found: ${have}. ${hint}`);
  }
  const { kind: k, path: p, version, channel, source } = choice;
  return { kind: k, path: p, version, channel, source };
}

/**
 * The browsers' DEFAULT user-data directories on this machine. Engine 2 never launches on one of
 * these (AIGuide §2.8.1: Chrome 136+ ignores --remote-debugging-pipe on the default dir anyway, and
 * App-Bound Encryption means a person's cookies are useless to another process), and never on a
 * directory inside one.
 */
export function defaultUserDataDirs(env = process.env) {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      ['Microsoft', 'Edge'], ['Microsoft', 'Edge Beta'], ['Microsoft', 'Edge Dev'], ['Microsoft', 'Edge SxS'],
      ['Google', 'Chrome'], ['Google', 'Chrome Beta'], ['Google', 'Chrome Dev'], ['Google', 'Chrome SxS'],
      ['Google', 'Chrome for Testing'], ['Chromium'],
    ].map((parts) => path.join(local, ...parts, 'User Data'));
  }
  if (process.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Microsoft Edge', 'Microsoft Edge Beta', 'Chromium', 'Google/Chrome for Testing']
      .map((p) => path.join(support, ...p.split('/')));
  }
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'microsoft-edge', 'microsoft-edge-beta', 'chromium', 'google-chrome-for-testing']
    .map((p) => path.join(config, p));
}

/**
 * The real path of `p` even when its tail does not exist yet: the deepest existing ancestor is
 * resolved (symlinks, junctions, and on Windows 8.3 short names such as MICROS~1, via
 * GetFinalPathNameByHandle) and the missing rest is appended.
 */
export function realPathOf(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(cur), ...rest);
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

/**
 * True when `dir` is a browser's default user-data dir or lies inside one — compared both as
 * written and as the real path, so a junction, a symlink or an 8.3 short name
 * (C:\Users\me\AppData\Local\MICROS~1\Edge\User Data) cannot walk around the guard.
 */
export function isDefaultUserDataDir(dir, env = process.env) {
  const norm = (p) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const targets = [...new Set([norm(dir), norm(realPathOf(dir))])];
  const bases = [...new Set(defaultUserDataDirs(env).flatMap((d) => [norm(d), norm(realPathOf(d))]))];
  return targets.some((target) => bases.some((base) => target === base || target.startsWith(base + path.sep)));
}
