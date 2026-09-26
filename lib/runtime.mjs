/**
 * How one G9 process starts another G9 script with the SAME runtime: the desktop starting the
 * daemon, the MCP shim starting the daemon, and the MCP entry the desktop registers with AI clients.
 *
 * Three runtimes exist:
 *
 *   - Node (a repository checkout): `node <root>/<script>`.
 *   - An installed app (G9.exe, G9.app, /opt/G9/g9): the Electron binary run as plain Node with
 *     ELECTRON_RUN_AS_NODE=1: `<exe> <root>/<script>`. Both paths are stable, so they may be written
 *     into an MCP config and used later.
 *   - A Linux AppImage. Its files live in a FUSE mount (`/tmp/.mount_G9xxxx`) that exists only while
 *     the process the AppImage runtime started is alive, under a new name on every start. A daemon
 *     spawned from that mount dies with the desktop that spawned it, and an MCP entry naming it
 *     breaks as soon as G9 quits. The only stable path is the `.AppImage` FILE (`$APPIMAGE`). So an
 *     AppImage process starts others as `$APPIMAGE <home>/bin/g9-run.mjs <script>`: each start gets
 *     its own mount, and the small bootstrap (a real file outside the mount) finds the script inside
 *     whichever mount it runs in. `ensureBootstrap` writes it; it never changes between versions.
 *
 * Pure except `ensureBootstrap`, so every rule is tested with plain node.
 */

import fs from 'node:fs';
import path from 'node:path';

export const BOOTSTRAP_NAME = 'g9-run.mjs';

/**
 * electron-builder's AppImage `AppRun` probes user namespaces (`unshare -Ur true`) and, where they
 * are unavailable — Ubuntu 24.04's default AppArmor policy, containers — puts `--no-sandbox` in
 * FRONT of every argument. With ELECTRON_RUN_AS_NODE the binary is Node, which rejects it ("bad
 * option: --no-sandbox", exit 9: measured in a container), so the daemon and the MCP shim never
 * start. AppRun adds it only when it is not already in the arguments: G9 passes it itself, after
 * the script, where Node treats it as a script argument, and the bootstrap drops it.
 */
export const NO_SANDBOX = '--no-sandbox';

/** The arguments that run `script` through an AppImage (`$APPIMAGE <these>`). */
export function appImageArgs(bootstrap, script) {
  return [bootstrap, script, NO_SANDBOX];
}

/** The bootstrap's source. Runs <script> (relative to the runtime's resources) as if started directly. */
export const BOOTSTRAP_SOURCE = `// G9 runtime bootstrap, written by G9 (lib/runtime.mjs). Do not edit: G9 rewrites it.
// Usage: <G9 executable, run as Node> ${BOOTSTRAP_NAME} <script relative to resources/> [args...]
// Finds the script inside the runtime THIS process runs from — for an AppImage, its own mount.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const rel = process.argv[2];
if (!rel) {
  console.error('${BOOTSTRAP_NAME}: which script? e.g. daemon/g9d.mjs');
  process.exit(2);
}
const root = process.env.APPDIR ? path.join(process.env.APPDIR, 'resources') : path.join(path.dirname(process.execPath), 'resources');
const script = path.join(root, rel);
// The script sees the argv it would see when started directly. '${NO_SANDBOX}' is dropped: it is only
// there so the AppImage's AppRun does not put it in FRONT of the script, where Node rejects it.
process.argv = [process.argv[0], script, ...process.argv.slice(3).filter((a) => a !== '${NO_SANDBOX}')];
await import(pathToFileURL(script).href);
`;

/** The bootstrap's path under a G9 home. */
export function bootstrapPath(home) {
  return path.join(home, 'bin', BOOTSTRAP_NAME);
}

/**
 * True when THIS process runs from a mounted AppImage: `$APPIMAGE` names the file and the
 * executable sits inside `$APPDIR`. Both are checked because an AppImage exports them to every
 * child — a terminal inside an AppImage editor would otherwise make a repository checkout believe
 * it is one.
 */
export function isAppImageRuntime({ env = process.env, execPath = process.execPath, platform = process.platform } = {}) {
  if (platform !== 'linux') return false;
  const file = String(env.APPIMAGE ?? '').trim();
  const dir = String(env.APPDIR ?? '').trim();
  if (!file || !dir) return false;
  // AppImages exist only on Linux: POSIX path rules, whatever machine runs this (and its tests).
  return path.posix.resolve(execPath).startsWith(path.posix.resolve(dir) + '/');
}

/**
 * The command that runs `<root>/<script>` with this runtime. Pure.
 *
 * @param {object} o
 * @param {string} o.script         relative to the resource root, '/'-separated (e.g. 'daemon/g9d.mjs')
 * @param {string} o.root           the resource root (repo root, or the packaged resources folder)
 * @param {string} o.execPath       this process's executable
 * @param {boolean} o.electron      the executable is the Electron binary (packaged app, or node mode)
 * @param {string} [o.home]         G9_HOME, needed for the AppImage bootstrap
 * @param {object} [o.env]
 * @param {string} [o.nodePath]     what runs a script in a repository checkout (default: execPath)
 * @returns {{ command: string, args: string[], env: object, stable: boolean, appImage: boolean }}
 */
export function scriptCommand({ script, root, execPath, electron, home = null, env = process.env, platform = process.platform, nodePath = null }) {
  const childEnv = { ...env };
  if (isAppImageRuntime({ env, execPath, platform })) {
    if (!home) throw new Error('An AppImage runtime needs the G9 home to find its bootstrap.');
    childEnv.ELECTRON_RUN_AS_NODE = '1';
    return { command: env.APPIMAGE, args: appImageArgs(bootstrapPath(home), script), env: childEnv, stable: true, appImage: true };
  }
  const file = path.join(root, ...script.split('/'));
  if (electron) {
    childEnv.ELECTRON_RUN_AS_NODE = '1';
    return { command: execPath, args: [file], env: childEnv, stable: true, appImage: false };
  }
  // A dev shell (VS Code, some agent hosts) may export ELECTRON_RUN_AS_NODE; a real node ignores
  // it, but anything started in turn should not inherit it.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return { command: nodePath ?? execPath, args: [file], env: childEnv, stable: true, appImage: false };
}

/** Write the bootstrap when it is missing or differs. Returns its path. */
export function ensureBootstrap(home, { fsImpl = fs } = {}) {
  const file = bootstrapPath(home);
  let current = null;
  try {
    current = fsImpl.readFileSync(file, 'utf8');
  } catch {
    /* not there yet */
  }
  if (current !== BOOTSTRAP_SOURCE) {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fsImpl.writeFileSync(tmp, BOOTSTRAP_SOURCE, 'utf8');
    fsImpl.renameSync(tmp, file);
  }
  return file;
}

/**
 * An identity for "this installation" that survives restarts: the `.AppImage` file for an
 * AppImage (its resource root is a new mount every start), else the resource root.
 */
export function installId({ root, env = process.env, execPath = process.execPath, platform = process.platform } = {}) {
  if (isAppImageRuntime({ env, execPath, platform })) return path.posix.resolve(String(env.APPIMAGE).trim());
  return String(root ?? '').replace(/\\/g, '/');
}

/**
 * Environment variables an AppImage or Electron runtime sets for itself that must not reach a
 * browser G9 launches: a LD_LIBRARY_PATH into the mount is a known way to break a system Chrome,
 * and ELECTRON_RUN_AS_NODE turns any Electron-based program into Node. Returns a copy.
 */
export function cleanChildEnv(env = process.env) {
  const out = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  const appDir = String(env.APPDIR ?? '').trim();
  if (appDir) {
    for (const key of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete out[key];
    for (const key of ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR', 'QT_PLUGIN_PATH', 'PYTHONPATH', 'PERLLIB']) {
      if (typeof out[key] !== 'string') continue;
      const kept = out[key].split(':').filter((p) => p && !path.posix.resolve(p).startsWith(path.posix.resolve(appDir)));
      if (kept.length) out[key] = kept.join(':');
      else delete out[key];
    }
  }
  return out;
}
