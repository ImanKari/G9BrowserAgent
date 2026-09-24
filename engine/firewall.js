// engine/firewall.js — say once per chrome.exe path that Windows may ask about its firewall.
//
// Windows Defender Firewall asks "Allow access?" the first time a program that has no firewall
// rule starts listening for inbound connections. The Chrome and Edge installers add rules for
// their own executables. Chrome for Testing is a zip that G9 unpacks under
// G9_HOME/engines/cft-<version>/, so it has no rule, and each new path (a new version, or a new
// G9_HOME) can ask once.
//
// The prompt is about INBOUND connections only. G9 drives the browser over a private pipe
// (--remote-debugging-pipe), never over a port, and outbound traffic is not affected, so choosing
// Allow or Cancel leaves G9 working either way. G9 does not change the firewall itself: that needs
// administrator rights and would change the machine's policy. It only says so, once per path.
//
// The paths G9 has launched are kept in G9_HOME/engines/firewall-seen.json:
//   { "version": 1,
//     "paths": { "<resolved path, lower-cased on Windows>": { "path": "<as launched>", "kind": "cft",
//                                                             "firstLaunchAt": "<ISO time>" } } }
// A missing or unreadable file counts as empty: the worst case is one warning too many, never a
// failed launch.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { g9Home } from './find.js';

export const FIREWALL_SEEN_FILE = 'firewall-seen.json';

/** Browser kinds that come without a firewall rule of their own (no installer registers one). */
export const FIREWALL_KINDS = new Set(['cft']);

/** G9_HOME/engines/firewall-seen.json */
export function firewallSeenPath(home = g9Home()) {
  return path.join(home, 'engines', FIREWALL_SEEN_FILE);
}

/** One key per executable: resolved, and case-insensitive on Windows (so is its file system). */
export function firewallKey(exePath, platform = process.platform) {
  const resolved = platform === 'win32' ? path.win32.resolve(String(exePath)) : path.resolve(String(exePath));
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** The launch warning for a first launch from `exePath`. */
export function firewallWarning(exePath) {
  return (
    `Windows may show a one-time Windows Defender Firewall prompt for ${exePath}, because G9 has not ` +
    'started Chrome for Testing from this path before and it has no firewall rule of its own. Choosing ' +
    'Allow or Cancel does not affect G9: the prompt is about inbound connections only, and G9 talks to ' +
    'the browser over a private pipe. G9 does not mention it again for this path.'
  );
}

/** The paths already seen → { version: 1, paths: { key: entry } }. Never throws. */
export async function readFirewallSeen(home = g9Home()) {
  try {
    const doc = JSON.parse(await readFile(firewallSeenPath(home), 'utf8'));
    const paths = doc?.paths;
    if (paths && typeof paths === 'object' && !Array.isArray(paths)) return { version: 1, paths: { ...paths } };
  } catch {
    /* missing or unreadable: nothing seen */
  }
  return { version: 1, paths: {} };
}

// Launches in one process are noted one at a time, so two engines started together from the same
// new path give one warning, not two.
let queue = Promise.resolve();

/**
 * Record a launch of `exePath` and say whether it is the first from that path.
 *
 *   noteFirewallLaunch({ home, exePath, kind, platform?, now? })
 *     → { warning: string | null, first: boolean, tracked: boolean }
 *
 * `warning` is set only on Windows, only for a kind in FIREWALL_KINDS, and only the first time
 * that path is launched. `tracked` is false when nothing was checked (another kind or platform)
 * or when the file could not be written (the warning is still given; it will be given again next
 * time). Never throws.
 */
export function noteFirewallLaunch({ home = g9Home(), exePath, kind, platform = process.platform, now = new Date() } = {}) {
  const run = queue.then(() => note({ home, exePath, kind, platform, now }));
  queue = run.catch(() => {});
  return run.catch(() => ({ warning: null, first: false, tracked: false }));
}

async function note({ home, exePath, kind, platform, now }) {
  if (platform !== 'win32' || !FIREWALL_KINDS.has(kind) || !exePath) return { warning: null, first: false, tracked: false };
  const key = firewallKey(exePath, platform);
  const doc = await readFirewallSeen(home);
  if (doc.paths[key]) return { warning: null, first: false, tracked: true };
  doc.paths[key] = { path: String(exePath), kind, firstLaunchAt: new Date(now).toISOString() };
  const file = firewallSeenPath(home);
  let tracked = true;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    try {
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  } catch {
    tracked = false;
  }
  return { warning: firewallWarning(exePath), first: true, tracked };
}
