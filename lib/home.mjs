/**
 * G9BrowserAgent's data home (G9_HOME), and the one-time move from the folder it had before 3.2.1.
 *
 *   G9_HOME, when set                     used as is (never moved)
 *   Windows  %LOCALAPPDATA%\G9BrowserAgent   (until 3.2.0: %LOCALAPPDATA%\G9)
 *   macOS, Linux  ~/.g9browseragent           (until 3.2.0: ~/.g9)
 *
 * The folder's owners — the daemon at its start, the desktop app — move an old folder to the new
 * name when the new one does not exist yet (`migrate: true`; any other caller only looks): one rename,
 * atomic on the same volume, so two processes racing to do it cannot both succeed. The old folder
 * is only taken when it is recognisably G9's (its settings, desktop state or extension are there),
 * never a stranger's ~/.g9. When the rename fails — on Windows a running older daemon, a launched
 * browser or an open log holds files there — nothing is moved and the old folder stays in use until
 * a later start succeeds, so no two components ever disagree about where the data is.
 *
 * The move leaves `migrated-from.json` in the new home. The desktop app reads it once: the browser
 * knows the extension by its folder, so the extension has to be loaded again from the new place.
 *
 * desktop/lib/paths.mjs carries a copy (the packaged app cannot import this folder at load time);
 * desktop/test/paths.test.mjs keeps the two in step.
 */

import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME_NAME = Object.freeze({ win32: 'G9BrowserAgent', posix: '.g9browseragent' });
export const LEGACY_HOME_NAME = Object.freeze({ win32: 'G9', posix: '.g9' });
export const MIGRATION_MARKER = 'migrated-from.json';

/** The default home and the pre-3.2.1 one, for this platform. Pure. */
export function defaultHomes({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (platform === 'win32') {
    // Without LOCALAPPDATA (a service account, a stripped environment): the usual AppData\Local.
    const local = env.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local');
    return { home: path.win32.join(local, HOME_NAME.win32), legacy: path.win32.join(local, LEGACY_HOME_NAME.win32) };
  }
  return { home: path.posix.join(homedir, HOME_NAME.posix), legacy: path.posix.join(homedir, LEGACY_HOME_NAME.posix) };
}

/** Whether a folder is G9's data home: something only G9 writes there. */
export function looksLikeG9Home(dir, { fs = nodeFs } = {}) {
  return ['settings.json', 'daemon.json', 'desktop.json', path.join('extension', 'manifest.json'), 'daemon.lock']
    .some((f) => fs.existsSync(path.join(dir, f)));
}

/**
 * Use `home`; if it does not exist and `legacy` is G9's, move `legacy` there first.
 * @returns {{ home: string, migratedFrom?: string, error?: string }} `home` is the folder to use
 */
export function adoptLegacyHome({ home, legacy }, { fs = nodeFs, now = () => new Date() } = {}) {
  if (fs.existsSync(home) || !legacy || !fs.existsSync(legacy) || !looksLikeG9Home(legacy, { fs })) return { home };
  try {
    fs.renameSync(legacy, home);
  } catch (err) {
    // Someone else moved it in the meantime: that is the outcome we wanted.
    if (fs.existsSync(home) && !fs.existsSync(legacy)) return { home };
    return { home: legacy, error: `${err.code ?? 'error'}: ${err.message}` };
  }
  try {
    fs.writeFileSync(path.join(home, MIGRATION_MARKER), `${JSON.stringify({ from: legacy, to: home, at: now().toISOString() }, null, 2)}\n`);
  } catch { /* the move itself succeeded; the note is a courtesy */ }
  return { home, migratedFrom: legacy };
}

/**
 * G9_HOME when set, else the default home. Only the folder's owners move it (`migrate: true`: the
 * daemon at its start, and the desktop app, which has its own copy); everyone else — an MCP shim,
 * the engine's helpers, a test — only looks: the old folder while it is still G9's and the new one
 * does not exist, else the new one. So a library call never moves a person's data, and every
 * component names the same folder before the move and after it.
 */
export function resolveDefaultHome({ env = process.env, platform = process.platform, homedir = os.homedir(), fs = nodeFs, migrate = false } = {}) {
  if (env.G9_HOME && String(env.G9_HOME).trim()) return path.resolve(String(env.G9_HOME).trim());
  const homes = defaultHomes({ env, platform, homedir });
  if (migrate) return adoptLegacyHome(homes, { fs }).home;
  const stillOld = !fs.existsSync(homes.home) && fs.existsSync(homes.legacy) && looksLikeG9Home(homes.legacy, { fs });
  return stillOld ? homes.legacy : homes.home;
}
