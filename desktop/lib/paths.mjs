/**
 * Where things are, for the desktop main process. Pure functions over injected facts
 * (env, platform, packaged or not) so every rule here is testable with plain node.
 *
 * Two roots matter:
 *   - G9_HOME — the data home shared with the daemon (ARCHITECTURE_V2 §9). The desktop reads
 *     runs/ and writes logs/install.log, logs/policies.json and desktop.json there.
 *   - the resource root — where extension/, engine/, daemon/, mcp/, runner/, lib/ and package.json
 *     live. Packaged: `process.resourcesPath` (electron-builder extraResources). Dev: the repo root,
 *     one level above desktop/. Both have the same layout, so nothing else branches on it.
 *
 * Keep this path-agnostic: no hard-coded backslashes (Windows, macOS and Linux run it); `path` does the joining.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 8765;

/** G9_HOME: env override, else %LOCALAPPDATA%\G9BrowserAgent on Windows, else ~/.g9browseragent (ARCHITECTURE_V2 §1). Pure. */
export function g9Home({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (env.G9_HOME && String(env.G9_HOME).trim()) return path.resolve(String(env.G9_HOME).trim());
  return defaultHomes({ env, platform, homedir }).home;
}

// ---- the one-time move from the pre-3.2.1 folder name: a copy of lib/home.mjs, which the packaged
// app cannot import at load time; desktop/test/paths.test.mjs keeps the two in step.

export const MIGRATION_MARKER = 'migrated-from.json';

/** The default home and the pre-3.2.1 one (%LOCALAPPDATA%\G9, ~/.g9). Pure. */
export function defaultHomes({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
    return { home: path.join(local, 'G9BrowserAgent'), legacy: path.join(local, 'G9') };
  }
  return { home: path.join(homedir, '.g9browseragent'), legacy: path.join(homedir, '.g9') };
}

/** Whether a folder is G9's data home: something only G9 writes there. */
export function looksLikeG9Home(dir, { exists = fs.existsSync } = {}) {
  return ['settings.json', 'daemon.json', 'desktop.json', path.join('extension', 'manifest.json'), 'daemon.lock']
    .some((f) => exists(path.join(dir, f)));
}

/**
 * Use `home`; if it does not exist and `legacy` is G9's, rename `legacy` to it first (atomic; a
 * failure — files held open by an older daemon — keeps `legacy` in use until a later start).
 * @returns {{ home: string, migratedFrom?: string, error?: string }}
 */
export function adoptLegacyHome({ home, legacy }, { fsApi = fs, now = () => new Date() } = {}) {
  if (fsApi.existsSync(home) || !legacy || !fsApi.existsSync(legacy) || !looksLikeG9Home(legacy, { exists: fsApi.existsSync })) return { home };
  try {
    fsApi.renameSync(legacy, home);
  } catch (err) {
    if (fsApi.existsSync(home) && !fsApi.existsSync(legacy)) return { home };
    return { home: legacy, error: `${err.code ?? 'error'}: ${err.message}` };
  }
  try {
    fsApi.writeFileSync(path.join(home, MIGRATION_MARKER), `${JSON.stringify({ from: legacy, to: home, at: now().toISOString() }, null, 2)}\n`);
  } catch { /* the move itself succeeded */ }
  return { home, migratedFrom: legacy };
}

/** The home this app uses: G9_HOME when set, else the default after the one-time move. */
export function resolveAppHome({ env = process.env, platform = process.platform, homedir = os.homedir(), fsApi = fs } = {}) {
  if (env.G9_HOME && String(env.G9_HOME).trim()) return { home: path.resolve(String(env.G9_HOME).trim()) };
  return adoptLegacyHome(defaultHomes({ env, platform, homedir }), { fsApi });
}

/** The daemon port: G9_PORT when it is a valid TCP port, else 8765. */
export function daemonPort(env = process.env) {
  const n = Number(env.G9_PORT);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : DEFAULT_PORT;
}

/** Everything the desktop reads or writes under G9_HOME. */
export function homeLayout(home) {
  const logs = path.join(home, 'logs');
  return {
    home,
    logs,
    installLog: path.join(logs, 'install.log'),
    desktopLog: path.join(logs, 'desktop.log'),
    policiesJson: path.join(logs, 'policies.json'),
    desktopJson: path.join(home, 'desktop.json'),
    daemonJson: path.join(home, 'daemon.json'),
    extension: path.join(home, 'extension'),
    runs: path.join(home, 'runs'),
    profiles: path.join(home, 'profiles'),
  };
}

/** The resource root: packaged → resourcesPath; dev → the repo root above desktop/. */
export function resourceRoot({ isPackaged, resourcesPath, appDir }) {
  if (isPackaged) {
    if (!resourcesPath) throw new Error('A packaged app must know its resources path');
    return resourcesPath;
  }
  return path.resolve(appDir, '..');
}

/** The packaged product pieces inside a resource root. */
export function resourcePaths(root) {
  return {
    root,
    extension: path.join(root, 'extension'),
    engineDir: path.join(root, 'engine'),
    daemonScript: path.join(root, 'daemon', 'g9d.mjs'),
    shimScript: path.join(root, 'mcp', 'shim.mjs'),
    runnerScript: path.join(root, 'runner', 'g9.mjs'),
    rootPackage: path.join(root, 'package.json'),
  };
}

/** A path as MCP client configs have always carried it in this repo: forward slashes (v1 install.ps1). */
export function forwardSlashes(p) {
  return String(p).replace(/\\/g, '/');
}

/** The OS user name recorded as `by` on approvals. Never empty: falls back to env, then 'operator'. */
export function osUserName({ env = process.env, userInfo = () => os.userInfo() } = {}) {
  try {
    const name = userInfo()?.username;
    if (name) return String(name);
  } catch {
    /* no passwd entry (containers) */
  }
  return env.USERNAME || env.USER || 'operator';
}
