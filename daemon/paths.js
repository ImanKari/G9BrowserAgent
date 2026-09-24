/**
 * Where G9 keeps its data, and the daemon's log.
 *
 * One data home per machine user (ARCHITECTURE §9): `G9_HOME`, else
 * `%LOCALAPPDATA%\G9` on Windows, else `~/.g9`. Every Node component resolves it
 * the same way, and the daemon exports it back into `process.env.G9_HOME` at
 * startup so `engine/*` modules (profiles, Chrome for Testing) cannot disagree
 * with it about where a profile lives.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 8765;

export function resolveHome(explicit = process.env.G9_HOME) {
  if (explicit && String(explicit).trim()) return path.resolve(String(explicit).trim());
  // The same fallback as engine/find.js g9Home() and desktop/lib/paths.mjs: on Windows
  // without LOCALAPPDATA (a service account, a stripped environment), the usual
  // AppData\Local under the profile — not ~/.g9, where the engine would disagree
  // about where profiles and Chrome for Testing live.
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'G9');
  }
  return path.join(os.homedir(), '.g9');
}

/** The §9 layout, as absolute paths. Directories are created on demand by their users. */
export function layout(home) {
  return {
    home,
    daemonJson: path.join(home, 'daemon.json'),
    settings: path.join(home, 'settings.json'),
    engineVersionsLog: path.join(home, 'engine-versions.log'),
    enginesDir: path.join(home, 'engines'),
    engineLogDir: path.join(home, 'engines', 'log'),
    profilesDir: path.join(home, 'profiles'),
    storeDir: path.join(home, 'store'),
    kvLocal: path.join(home, 'store', 'kv-local.json'),
    blobsDir: path.join(home, 'store', 'blobs'),
    runsDir: path.join(home, 'runs'),
    downloadsDir: path.join(home, 'downloads'),
    extensionDir: path.join(home, 'extension'),
    logsDir: path.join(home, 'logs'),
    daemonLog: path.join(home, 'logs', 'daemon.log'),
    installLog: path.join(home, 'logs', 'install.log'),
  };
}

/** A port from a flag/env/setting, or null when the value is not a usable TCP port. */
export function parsePort(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : null;
}

/**
 * The daemon's logger: an append-only file plus, in the foreground, stderr.
 *
 * Never stdout. The daemon has no stdout protocol, but the same helpers are
 * imported by code that runs inside the MCP shim, where one stray byte on
 * stdout corrupts the JSON-RPC stream. Rotation is by size, once, at startup
 * and every 5 MB: a daemon that runs for weeks must not fill the disk with a
 * log nobody reads.
 */
export function createLogger(file, { echo = false, maxBytes = 5 * 1024 * 1024 } = {}) {
  let fd = null;
  let written = 0;

  const open = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        const size = fs.statSync(file).size;
        if (size > maxBytes) {
          fs.renameSync(file, `${file}.1`);
          written = 0;
        } else {
          written = size;
        }
      } catch {
        written = 0;
      }
      fd = fs.openSync(file, 'a');
    } catch {
      fd = null; // a read-only home must not stop the daemon; stderr still works in the foreground
    }
  };
  open();

  const log = (...args) => {
    const text = args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ');
    const line = `${new Date().toISOString()} ${text}\n`;
    if (echo) process.stderr.write(line);
    if (fd === null) return;
    try {
      fs.writeSync(fd, line);
      written += Buffer.byteLength(line);
      if (written > maxBytes) {
        fs.closeSync(fd);
        open();
      }
    } catch {
      /* logging must never throw into the code that logged */
    }
  };
  log.close = () => {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      fd = null;
    }
  };
  return log;
}

function safeJson(value) {
  try {
    return value instanceof Error ? (value.stack ?? value.message) : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Write a file atomically: temp file in the same directory, then rename over. */
export function writeFileAtomicSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tmp, data);
  renameWithRetrySync(tmp, file);
}

/**
 * Windows refuses a rename while another process (antivirus, indexer, a backup
 * agent) has the destination open, with EPERM/EBUSY/EACCES, for a few
 * milliseconds. A handful of short retries turns that into a non-event.
 */
export function renameWithRetrySync(from, to, attempts = 8) {
  for (let i = 0; ; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        try { fs.rmSync(from, { force: true }); } catch { /* best effort */ }
        throw err;
      }
      const until = Date.now() + 15 * (i + 1);
      while (Date.now() < until) { /* short synchronous back-off */ }
    }
  }
}

export async function writeFileAtomic(file, data) {
  const fsp = fs.promises;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await fsp.writeFile(tmp, data);
  for (let i = 0; ; i += 1) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 15 * (i + 1)));
    }
  }
}
