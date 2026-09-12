/**
 * Bridge registry and port discovery.
 *
 * ## The failure this removes
 *
 * The MCP client launches the bridge. Every editor window, every MCP client,
 * launches its OWN bridge — and every one of them defaulted to port 8765. The
 * second one got EADDRINUSE and stayed up explaining itself every five seconds,
 * which is the correct behaviour and still leaves the user with a broken setup
 * and a mysterious message.
 *
 * Worse, the extension connects to exactly one bridge. Whichever process won
 * the race owns the browser; the others are alive, listening on nothing, and
 * their tool calls time out with no clue as to why.
 *
 * ## The fix, in two halves
 *
 * 1. **Take the next free port** from a small range instead of insisting on
 *    one. Two bridges are a normal state — two editor windows on two projects
 *    — so the tool should accommodate them rather than treat it as a fault.
 * 2. **Publish who you are** to `~/.g9/bridges.json`, so something can list
 *    them. The extension cannot read that file (no filesystem), which is why
 *    `/health` also answers with the same identity: the panel discovers
 *    bridges by scanning the range, and the file exists for humans and the
 *    runner.
 *
 * ## Why a stale entry is not cleaned up eagerly
 *
 * A crashed bridge leaves its row behind. We do NOT try to prove liveness by
 * signalling the pid — on Windows that is unreliable, and a false "it is dead"
 * would delete a live bridge's row while it is working. Instead every row
 * carries `startedAt`/`touchedAt` and readers decide. A row whose port answers
 * `/health` is alive whatever the file says; that is the only test that cannot
 * lie.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

/** The scan range. Small on purpose: a scan is 11 requests, not 65,535. */
export const PORT_RANGE_START = 8765;
export const PORT_RANGE_END = 8775;

const REGISTRY_DIR = path.join(os.homedir(), '.g9');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'bridges.json');

/** A row older than this with no touch is presumed dead by readers. */
const STALE_AFTER_MS = 5 * 60_000;

/**
 * Find a free port in the range, starting at the preferred one.
 *
 * An explicit `G9_PORT` is honoured absolutely: if the user pinned a port, a
 * bridge that quietly moved somewhere else would be worse than one that fails
 * loudly — their extension is configured for that number.
 */
export async function pickPort({ host = '127.0.0.1', preferred, pinned = false } = {}) {
  const first = preferred ?? PORT_RANGE_START;
  if (pinned) return { port: first, scanned: false };

  for (let port = first; port <= PORT_RANGE_END; port += 1) {
    if (await isFree(host, port)) return { port, scanned: port !== first };
  }
  // Every port taken: fall back to the preferred one so the caller produces the
  // familiar EADDRINUSE message, which already explains itself well.
  return { port: first, scanned: true, exhausted: true };
}

function isFree(host, port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/** Record this bridge in the shared registry. Best-effort, never fatal. */
export function register(entry) {
  try {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    const rows = readRows().filter((r) => r.pid !== entry.pid && r.port !== entry.port);
    rows.push({ ...entry, startedAt: Date.now(), touchedAt: Date.now() });
    fs.writeFileSync(REGISTRY_FILE, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  } catch {
    /* the registry is a convenience; a read-only home directory must not stop the bridge */
  }
}

/** Refresh this bridge's liveness stamp. */
export function touch(pid, patch = {}) {
  try {
    const rows = readRows();
    const row = rows.find((r) => r.pid === pid);
    if (!row) return;
    Object.assign(row, patch, { touchedAt: Date.now() });
    fs.writeFileSync(REGISTRY_FILE, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

export function unregister(pid) {
  try {
    const rows = readRows().filter((r) => r.pid !== pid);
    fs.writeFileSync(REGISTRY_FILE, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

/** Every registered bridge, newest first, with a `stale` hint for readers. */
export function list() {
  const now = Date.now();
  return readRows()
    .map((r) => ({ ...r, stale: now - (r.touchedAt ?? 0) > STALE_AFTER_MS }))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

function readRows() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const REGISTRY_PATH = REGISTRY_FILE;
