#!/usr/bin/env node
/**
 * g9d — the G9 daemon. One per machine, on 127.0.0.1:8765 by default.
 *
 * Usually nobody starts this by hand: the first MCP shim that finds no daemon
 * spawns it (detached, hidden), and it exits by itself after an idle period
 * with no client, no launched browser and no enabled schedule
 * (DAEMON_PROTOCOL §8). The desktop app keeps it alive while it runs.
 *
 *   node daemon/g9d.mjs [--port N] [--home DIR] [--foreground]
 *
 *   --port        overrides G9_PORT and settings.port
 *   --home        overrides G9_HOME (default %LOCALAPPDATA%\G9, or ~/.g9)
 *   --foreground  log to stderr as well as G9_HOME/logs/daemon.log, and never
 *                 idle-exit (a person started it and is watching; Ctrl+C stops it)
 *
 * Environment: G9_PORT, G9_HOME, G9_TIMEOUT_MS (per-call base deadline, default
 * 120000), G9_PROJECT (default project adapter for the extension's flow library),
 * G9_IDLE_EXIT_MS (overrides settings.idleExitMinutes — for tests that must see an
 * idle exit in seconds, not an hour), G9_ENGINE_RESUME_MS (how long a disconnected
 * extension keeps its engine id and tab handles for a reconnect, default 600000 —
 * decision D-c; 0 drops them at once).
 *
 * A port that is already held is explained, not crashed on: if the holder is
 * another g9d, this process exits 0 quietly (two shims raced to start one and
 * the other won — the normal case); if it is anything else, the log says what
 * and the exit code is 1.
 *
 * A HOME that is already served is refused the same way: G9_HOME/daemon.lock
 * (daemon/home-lock.js) names the g9d that owns it; a second one — started on
 * another port by a config without G9_PORT — exits 0 and logs the port to use.
 */

import { resolveHome, parsePort, createLogger, DEFAULT_PORT } from './paths.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const [key, inline] = token.startsWith('--') ? token.slice(2).split('=', 2) : [null, null];
    if (!key) continue;
    if (key === 'foreground') { out.foreground = true; continue; }
    const value = inline ?? argv[i + 1];
    if (inline == null) i += 1;
    out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const home = resolveHome(args.home ?? process.env.G9_HOME);
// Every Node component — and every engine/* module this process imports —
// must agree on where profiles and Chrome for Testing live.
process.env.G9_HOME = home;

const foreground = args.foreground === true;
const log = createLogger(`${home}/logs/daemon.log`, { echo: foreground });

const explicitPort = parsePort(args.port) ?? parsePort(process.env.G9_PORT);
for (const [source, raw] of [['--port', args.port], ['G9_PORT', process.env.G9_PORT]]) {
  if (raw != null && raw !== '' && parsePort(raw) == null) log(`[g9d] ignoring invalid ${source} "${raw}"`);
}
const timeoutMs = Number(process.env.G9_TIMEOUT_MS) > 0 ? Number(process.env.G9_TIMEOUT_MS) : 120_000;

process.on('uncaughtException', (err) => {
  // A bug in one handler must cost that call, not every agent's session.
  log(`[g9d] uncaught exception (kept running): ${err?.stack ?? err}`);
});
process.on('unhandledRejection', (err) => {
  log(`[g9d] unhandled rejection (kept running): ${err?.stack ?? err}`);
});

// One daemon per G9_HOME (daemon/home-lock.js), taken before anything touches the home: a second
// g9d on another port would run every schedule entry again and fight over settings.json.
const { acquireHomeLock } = await import('./home-lock.js');
let homeLock;
try {
  homeLock = await acquireHomeLock(home, { log });
} catch (err) {
  log(`[g9d] cannot start: ${err.message}`);
  log.close?.();
  process.exit(1);
}
if (!homeLock.ok) {
  const h = homeLock.holder;
  log(`[g9d] G9_HOME ${home} already has g9d pid ${h.pid}${h.port ? ` on port ${h.port}` : ' (still starting)'}; this one exits.` +
    (h.port && h.port !== explicitPort ? ` Point this client at it: set G9_PORT=${h.port}.` : ''));
  log.close?.();
  process.exit(0);
}

const { Daemon } = await import('./daemon.js');
const idleExitMs = Number(process.env.G9_IDLE_EXIT_MS) > 0 ? Number(process.env.G9_IDLE_EXIT_MS) : null;
const engineResumeMs = process.env.G9_ENGINE_RESUME_MS != null && process.env.G9_ENGINE_RESUME_MS !== '' && Number(process.env.G9_ENGINE_RESUME_MS) >= 0
  ? Number(process.env.G9_ENGINE_RESUME_MS)
  : undefined;
const daemon = new Daemon({ home, port: explicitPort, foreground, log, timeoutMs, cwd: process.cwd(), idleExitMs, engineResumeMs });

const exit = async (reason, code = 0) => {
  await daemon.stop(reason).catch(() => {});
  homeLock.release();
  log.close?.();
  process.exit(code);
};
daemon.onIdleExit = () => exit('idle: no client, no launched engine and no schedule');
daemon.onShutdownRequest = (reason) => exit(reason);
process.on('SIGINT', () => exit('SIGINT'));
process.on('SIGTERM', () => exit('SIGTERM'));
process.on('SIGHUP', () => exit('SIGHUP'));

try {
  await daemon.start();
  homeLock.setPort(daemon.port);
  if (foreground) process.stderr.write(`g9d listening on ws://127.0.0.1:${daemon.port}/g9 — Ctrl+C to stop\n`);
} catch (err) {
  homeLock.release();
  const port = err.port ?? explicitPort ?? DEFAULT_PORT;
  if (err.code === 'EADDRINUSE') {
    let body = null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      body = await res.json();
    } catch {
      body = null;
    }
    if (body?.name === 'g9d') {
      log(`[g9d] port ${port} already has g9d v${body.version} (pid ${body.pid}); this one exits.`);
      log.close?.();
      process.exit(0);
    }
    const holder = body?.ok ? `a G9 v1 bridge (pid ${body.pid ?? '?'}, v${body.version ?? '?'})` : 'another program';
    log(`[g9d] cannot listen: port ${port} is held by ${holder}. Close it (for a v1 bridge: close the editor or MCP client that started it), or set G9_PORT.`);
  } else {
    log(`[g9d] cannot start: ${err?.stack ?? err}`);
  }
  if (foreground) process.stderr.write(`g9d could not start — see ${home}/logs/daemon.log\n`);
  log.close?.();
  process.exit(1);
}
