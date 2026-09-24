/**
 * Starting g9d when nothing listens, and restarting it only when that cannot hurt a run.
 *
 * Packaged: `G9.exe` itself runs the daemon script with ELECTRON_RUN_AS_NODE=1 — the machine needs
 * no Node (ARCHITECTURE_V2 §11). Dev: `node <repo>/daemon/g9d.mjs`.
 *
 * The daemon is spawned DETACHED: it serves every agent on the machine, not just this window, and
 * must outlive the desktop (it exits by itself after settings.idleExitMinutes with no client and no
 * engine — DAEMON_PROTOCOL §8).
 *
 * The one thing this module never does is fight for the port. If 127.0.0.1:PORT answers and it is
 * not g9d (on the owner's machine today: the v1 bridge, a node process), we say what it is and
 * leave it alone. Killing a process we did not start would take down someone's live session.
 */

import fs from 'node:fs';
import http from 'node:http';
import { spawn as nodeSpawn } from 'node:child_process';
import { resourcePaths } from './paths.mjs';

/**
 * The exact command that starts the daemon. Pure.
 * @returns {{ command, args, env, cwd, script }}
 */
export function daemonCommand({ isPackaged, execPath, resourceRoot, env = process.env, port, home, nodePath = 'node' }) {
  const { daemonScript, root } = resourcePaths(resourceRoot);
  const childEnv = { ...env };
  if (port) childEnv.G9_PORT = String(port);
  if (home) childEnv.G9_HOME = home;
  if (isPackaged) {
    // The Electron binary as a plain Node runtime.
    childEnv.ELECTRON_RUN_AS_NODE = '1';
    return { command: execPath, args: [daemonScript], env: childEnv, cwd: root, script: daemonScript };
  }
  // A dev shell (VS Code, some agent hosts) may export ELECTRON_RUN_AS_NODE; a real node ignores it,
  // but anything the daemon spawns in turn should not inherit it.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return { command: nodePath, args: [daemonScript], env: childEnv, cwd: root, script: daemonScript };
}

/**
 * Who answers on the port. Never sends anything but GET /health.
 * @returns {Promise<{ status: 'none'|'g9d'|'foreign', httpStatus?, body?, error? }>}
 */
export function probeHealth(port, { host = '127.0.0.1', timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (text.length < 64 * 1024) text += d; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        if (res.statusCode === 200 && body && body.name === 'g9d') resolve({ status: 'g9d', httpStatus: 200, body });
        else resolve({ status: 'foreign', httpStatus: res.statusCode, body: body ?? text.slice(0, 500) });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') resolve({ status: 'none' });
      // Something accepted the TCP connection but did not speak HTTP in time: occupied, not ours.
      else resolve({ status: 'foreign', error: `${err.code ?? ''} ${err.message}`.trim() });
    });
  });
}

/** One paragraph naming what holds the port and what to do. Pure. */
export function describeForeign(health, port) {
  const b = health?.body && typeof health.body === 'object' ? health.body : null;
  const version = b?.version ? String(b.version) : null;
  const pid = b?.pid ?? b?.bridgePid ?? null;
  const isV1 = !!b && (b.extensionConnected !== undefined || /^1\./.test(version ?? '') || b.name === 'g9-bridge');
  const who = isV1
    ? `a v1 G9 bridge${version ? ` (version ${version}` : ''}${pid ? `${version ? ', ' : ' ('}pid ${pid}` : ''}${version || pid ? ')' : ''}`
    : `another program${health?.httpStatus ? ` (HTTP ${health.httpStatus} on /health)` : ''}`;
  return {
    kind: isV1 ? 'v1-bridge' : 'unknown',
    pid,
    version,
    message:
      `Port ${port} is held by ${who}, not the G9 v2 daemon. G9 will not stop it. ` +
      (isV1
        ? 'Close the AI client that started the v1 bridge (or end that node process yourself), then press Reconnect. '
        : 'Stop that program, then press Reconnect. ') +
      'To run both side by side, start the desktop and your agents with the same G9_PORT instead.',
  };
}

/** Spawn detached and forget. Returns the pid. */
export function spawnDetached(cmd, { spawn = nodeSpawn } = {}) {
  const child = spawn(cmd.command, cmd.args, {
    cwd: cmd.cwd,
    env: cmd.env,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.on?.('error', () => { /* reported through the connection state instead */ });
  child.unref?.();
  return child.pid ?? null;
}

/**
 * The `onRefused` hook for DaemonClient: probe, then start g9d at most once per cooldown.
 * A cooldown matters: a daemon that crashes on start must not be respawned in a tight loop.
 */
export class DaemonLauncher {
  constructor({ commandOptions, port, log = null, cooldownMs = 20_000, spawn = nodeSpawn, probe = probeHealth, now = () => Date.now(), enabled = () => true }) {
    this.commandOptions = commandOptions;
    this.port = port;
    this.log = log;
    this.cooldownMs = cooldownMs;
    this.spawn = spawn;
    this.probe = probe;
    this.now = now;
    this.enabled = enabled;
    this.lastLaunchAt = 0;
    this.lastPid = null;
    this.held = null;
  }

  /**
   * Do not start g9d until release(). Used when the person shut the daemon down on purpose: the
   * client's own reconnect would otherwise start it again a second later, and "Shut down" would
   * silently mean "restart". An agent's shim may still start it; the client then just connects.
   */
  hold(reason) {
    this.held = String(reason || 'Starting the daemon is paused.');
  }

  release() {
    this.held = null;
  }

  command() {
    return daemonCommand({ ...this.commandOptions, port: this.port });
  }

  async onRefused() {
    // A refusal that happened while held is never this launcher's to act on, even if release()
    // comes while its probe is still out: "Reconnect" releases and reconnects at once, and that
    // fresh attempt is what may start g9d. Seen once in the main-process test: a real g9d was left
    // running on the test port after the run (the fake daemon had answered the Reconnect). A
    // refusal from the held period, released while its probe saw an empty port, is the path that
    // starts one then; now it cannot.
    const heldAtRefusal = this.held;
    if (heldAtRefusal) return { launched: false, held: heldAtRefusal };
    const health = await this.probe(this.port);
    if (health.status === 'foreign') return { foreign: describeForeign(health, this.port) };
    if (health.status === 'g9d') return { launched: false };
    if (this.held) return { launched: false, held: this.held };
    if (!this.enabled()) return { launched: false };
    if (this.lastLaunchAt && this.now() - this.lastLaunchAt < this.cooldownMs) return { launched: false };
    const cmd = this.command();
    if (!fs.existsSync(cmd.script)) {
      throw new Error(`The daemon script is missing: ${cmd.script}`);
    }
    this.lastLaunchAt = this.now();
    this.lastPid = spawnDetached(cmd, { spawn: this.spawn });
    this.log?.info?.('Started the daemon', { pid: this.lastPid, command: cmd.command, args: cmd.args, port: this.port });
    return { launched: true, pid: this.lastPid };
  }

  async onUpgradeRefused() {
    const health = await this.probe(this.port);
    return health.status === 'foreign' ? describeForeign(health, this.port) : null;
  }

  /** Allow an immediate relaunch (after a deliberate shutdown for an update). */
  resetCooldown() {
    this.lastLaunchAt = 0;
  }
}

const ACTIVE_RUN_STATES = new Set(['running', 'active', 'started', 'starting', 'queued', 'replaying', 'in_progress']);

/** Rows of runs.list, whatever envelope the daemon uses. */
export function runsFrom(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.runs)) return result.runs;
  if (Array.isArray(result?.items)) return result.items;
  return [];
}

export function isRunActive(run) {
  if (!run || typeof run !== 'object') return false;
  // g9d's runs.list says it outright (daemon/evidence.js: `active` = the run is open in memory).
  // It must win over the heuristics below: a finished watch session has a start, no verdict and
  // `finishedAt` (not `endedAt`), and reading it as "still going" deferred every update forever.
  if (typeof run.active === 'boolean') return run.active;
  const status = String(run.status ?? run.state ?? '').toLowerCase();
  if (ACTIVE_RUN_STATES.has(status)) return true;
  if (status) return false;
  // No status field: a run with a start and neither an end nor a verdict is still going.
  return !!(run.startedAt && !run.endedAt && !run.finishedAt && !run.verdict && !run.result);
}

/**
 * Is it safe to restart the daemon? Pure over what the daemon reported.
 * Busy when a run is active or a launched engine exists (restarting closes launched browsers,
 * which would pull a live page out from under an agent even with no "run" recorded).
 * A `watch` run does not count: it is this app's own live view being spooled, it ends when the
 * app quits to install, and nothing is lost by restarting under it.
 */
export function daemonActivity({ runs = [], engines = [], agents = [] } = {}) {
  const active = runs.filter((r) => isRunActive(r) && r.kind !== 'watch');
  const launched = engines.filter((e) => (e?.kind ?? 'launched') === 'launched');
  const reasons = [];
  if (active.length) reasons.push(`${active.length} run${active.length === 1 ? ' is' : 's are'} in progress`);
  if (launched.length) reasons.push(`${launched.length} launched engine${launched.length === 1 ? '' : 's'} would be closed`);
  return {
    busy: reasons.length > 0,
    reasons,
    activeRuns: active.map((r) => r.runId ?? r.id ?? null),
    engines: launched.length,
    agents: agents.length,
  };
}

/**
 * Is a daemon this app is NOT connected to idle? From its `/health` body alone (g9d 2.0.0, F6):
 * `activeRuns` (every open run) and `launched` (running Engine 2 browsers). A body without them
 * (an older daemon) is busy with that reason — never guess idle. Pure.
 */
export function activityFromHealth(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.activeRuns) || !Number.isInteger(body.launched)) {
    return { busy: true, reasons: ['the daemon is running but this app is not connected to it, and its /health does not list its runs'], activeRuns: [], engines: 0, agents: 0 };
  }
  return daemonActivity({
    runs: body.activeRuns.map((r) => ({ ...r, active: true })),
    engines: Array.from({ length: body.launched }, () => ({ kind: 'launched' })),
  });
}

/**
 * Ask the daemon what it is doing (runs.list + engines). Any failure counts as busy: never guess idle.
 *
 * `runs.list {active:true}` lists EVERY run the daemon still has open, however old (g9d 2.0.0,
 * F6; `/health` and admin `state` report the same list as `activeRuns`). It replaced reading the
 * newest 50 rows, where a long scheduled run older than fifty short ones was missed and an update
 * could restart the daemon under it. A daemon that ignores the filter returns its newest rows
 * instead; each row's own `active` flag still decides (isRunActive), so that is safe too.
 */
export async function queryActivity(client, { enginesFallback = [] } = {}) {
  try {
    const runs = runsFrom(await client.admin('runs.list', { active: true }));
    let engines = enginesFallback;
    try {
      const listed = await client.call('browser_engine', { action: 'list' }, { timeoutMs: 15_000 });
      engines = Array.isArray(listed) ? listed : Array.isArray(listed?.engines) ? listed.engines : enginesFallback;
    } catch {
      /* keep the fallback from the last 'engines' event */
    }
    return daemonActivity({ runs, engines });
  } catch (err) {
    return { busy: true, reasons: [`the daemon did not report its runs (${err.message})`], activeRuns: [], engines: 0, agents: 0 };
  }
}

/** Wait until nothing answers on the port (the old daemon is gone). */
export async function waitForPortFree(port, { timeoutMs = 15_000, probe = probeHealth, intervalMs = 300 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await probe(port)).status === 'none') return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * What to do about a daemon whose version is not this app's. Pure.
 *
 * Only an OLDER daemon from THIS install is restarted — the case the restart exists for, a daemon
 * left over from before an app update. A newer one (a repository checkout whose shim started it), or
 * one from another install, is left alone and reported: the app used to shut it down and start its
 * own older daemon over it, and with "Start the daemon" off it shut it down and started nothing
 * (desktop review, 2026-09-22).
 * → 'none' | 'restart' | 'notice-newer' | 'notice-other-install' | 'notice-no-autostart'
 */
export function mismatchAction({ daemonVersion, appVersion, daemonRoot = null, appRoot = null, startDaemon = true, platform = process.platform } = {}) {
  if (!daemonVersion || daemonVersion === appVersion) return 'none';
  if (compareVersions(daemonVersion, appVersion) > 0) return 'notice-newer';
  const same = (a, b) => {
    if (!a || !b) return true; // an older daemon that does not say where it lives: treat as ours
    const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
  };
  if (!same(daemonRoot, appRoot)) return 'notice-other-install';
  if (!startDaemon) return 'notice-no-autostart';
  return 'restart';
}

/** Numeric version compare: 1 when a is newer, -1 when older, 0 when the same. A prerelease is older. */
export function compareVersions(a, b) {
  const parts = (v) => {
    const [core, pre] = String(v ?? '').split('-', 2);
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre: pre ?? null };
  };
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i += 1) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  }
  if (!!x.pre === !!y.pre) return 0;
  return x.pre ? -1 : 1;
}

/**
 * Restart the daemon when idle: `shutdown`, wait for the port, then let the client's own
 * reconnect start the new one (through DaemonLauncher). Returns what happened.
 */
export async function restartDaemonIfIdle(client, launcher, { reason = 'update', log = null, enginesFallback = [] } = {}) {
  // Never shut a daemon down that this app will not start again.
  if (launcher?.enabled && launcher.enabled() === false) {
    return { restarted: false, activity: { busy: true, reasons: ['this app does not start the daemon ("Start the daemon" is off), so it must not stop it either'] } };
  }
  const activity = await queryActivity(client, { enginesFallback });
  if (activity.busy) {
    log?.info?.(`Daemon restart deferred (${reason})`, activity.reasons);
    return { restarted: false, activity };
  }
  log?.info?.(`Restarting the daemon (${reason})`);
  try {
    await client.admin('shutdown', {});
  } catch {
    /* the socket may close before the result arrives; the port check below is what counts */
  }
  const free = await waitForPortFree(launcher.port);
  if (!free) return { restarted: false, activity, error: 'The daemon did not exit within 15 s.' };
  launcher.release?.();
  launcher.resetCooldown();
  client.reconnectNow();
  return { restarted: true, activity };
}
