/**
 * One daemon per G9_HOME (ARCHITECTURE §1: "one daemon per machine").
 *
 * The port was the only thing that kept a second g9d away, and a port is per MCP config: a
 * client whose config lacked G9_PORT (or a runner started with --port Y) found nothing on ITS
 * port and spawned a second g9d on the same home. Both then ran the same schedule (every entry
 * twice, 4 runs where 2 were due), each rewrote settings.json from its own memory (last writer
 * wins), and daemon.json named only the newer one (daemon review, 2026-09-22). A scheduled
 * daemon never idles out, so the stray one ran until someone killed it.
 *
 * So the home is LOCKED, atomically, before the daemon touches anything in it:
 * `G9_HOME/daemon.lock`, created with open('wx'), holding `{pid, port}` (the port is written
 * once the daemon listens). A second daemon that finds the lock asks the holder's /health; if it
 * answers as g9d for the same home, the newcomer exits and says which port to use. A lock whose
 * pid is dead, or whose port does not answer as g9d for this home (a reused pid, a hung or
 * crashed holder), is stale and taken over. daemon.json alone could not do this: two daemons
 * starting at once both find none.
 */

import fs from 'node:fs';
import path from 'node:path';

/** How long a holder may take between creating the lock and writing its port (a daemon starting up). */
export const STARTING_GRACE_MS = 30_000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** The same home, however it is spelled (slashes; case on Windows). */
export function sameHome(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    const r = path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Does 127.0.0.1:port answer as g9d for this home? → the /health body, or null. */
export async function g9dFor(port, home, { fetchImpl = globalThis.fetch, timeoutMs = 1_500 } = {}) {
  if (!Number.isInteger(port) || port <= 0) return null;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json();
    return body?.name === 'g9d' && sameHome(body.home, home) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Is the daemon named by a lock (or daemon.json) body alive and serving this home?
 * → { live: true, pid, port, version } | { live: false, why }
 */
export async function checkHolder(body, home, { fetchImpl, waitMs = 2_000, file = null, pollMs = 200 } = {}) {
  let holder = body;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (!holder || !Number.isInteger(holder.pid)) {
      // An empty or half-written lock is what another process's open('wx') looks like in the
      // moment before it writes: read it again for a moment before calling it stale.
      if (file && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        holder = readJson(file);
        continue;
      }
      return { live: false, why: 'the lock names no process' };
    }
    if (!pidAlive(holder.pid)) return { live: false, why: `process ${holder.pid} is not running` };
    if (Number.isInteger(holder.port)) {
      const health = await g9dFor(holder.port, home, { fetchImpl });
      if (health && (health.pid == null || health.pid === holder.pid)) {
        return { live: true, pid: holder.pid, port: holder.port, version: health.version ?? null };
      }
      if (Date.now() >= deadline) return { live: false, why: `port ${holder.port} does not answer as g9d for this home` };
    } else if (Date.now() >= deadline) {
      // A daemon that is still starting (it writes its port once it listens) — unless the lock is old.
      let age = 0;
      try { age = file ? Date.now() - fs.statSync(file).mtimeMs : 0; } catch { age = Infinity; }
      if (age < STARTING_GRACE_MS) return { live: true, pid: holder.pid, port: null, starting: true };
      return { live: false, why: `process ${holder.pid} never said which port it listens on` };
    }
    await new Promise((r) => setTimeout(r, pollMs));
    if (file) holder = readJson(file) ?? holder;
  }
}

/**
 * Take G9_HOME's daemon lock. → { ok: true, setPort(port), release() } or
 * { ok: false, holder: { pid, port, version } } when a live g9d already serves this home.
 */
export async function acquireHomeLock(home, { pid = process.pid, fetchImpl, waitMs = 2_000, log = () => {} } = {}) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'daemon.lock');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid, port: null, at: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return {
        ok: true,
        file,
        setPort(port) {
          const current = readJson(file);
          if (current?.pid !== pid) return;
          try { fs.writeFileSync(file, JSON.stringify({ pid, port, at: Date.now() })); } catch { /* the lock still holds */ }
        },
        release() {
          const current = readJson(file);
          if (current == null || current.pid === pid) {
            try { fs.rmSync(file, { force: true }); } catch { /* gone */ }
          }
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    const verdict = await checkHolder(readJson(file), home, { fetchImpl, waitMs, file });
    if (verdict.live) return { ok: false, holder: verdict };
    log(`[g9d] ${file} is stale (${verdict.why}); taking it over`);
    try { fs.rmSync(file, { force: true }); } catch { /* raced: the next open decides */ }
  }
  throw new Error(`Could not take the daemon lock ${file}: another process keeps recreating it.`);
}

/**
 * For the shim, before it spawns a daemon: is a live g9d for this home already running on another
 * port? Read from daemon.json (written once a daemon listens). → { pid, port, version } | null
 */
export async function runningDaemonFor(home, { fetchImpl } = {}) {
  const info = readJson(path.join(home, 'daemon.json'));
  if (!info || !Number.isInteger(info.port)) return null;
  const verdict = await checkHolder(info, home, { fetchImpl, waitMs: 0 });
  return verdict.live && verdict.port != null ? verdict : null;
}
