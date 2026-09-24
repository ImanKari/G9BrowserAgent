/**
 * The extension step (V2 plan §9 step 2, §8 "Extension (unpacked)").
 *
 * G9_HOME/extension is the one folder the QA person ever loads unpacked. Its path never changes,
 * because an unpacked extension's id is derived from its path — a new path would be a new
 * extension with none of the old one's recordings. The daemon owns the copy (`extension.install`:
 * write extension.new, rename into place, then tell the extension to `runtime.reload()` when idle).
 *
 * This module adds the parts only the desktop can do: put the path on the clipboard, open the
 * browser's extensions page, and say the three clicks. And one fallback: if the daemon cannot be
 * reached during setup, the same atomic copy is done here so the wizard is never stuck — the
 * extension then picks up the files on its next reload.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { readJson } from './jsonfile.mjs';

export const EXTENSIONS_PAGE = { edge: 'edge://extensions', chrome: 'chrome://extensions' };

/** The three clicks, per browser. */
export function threeClicks(kind = 'edge') {
  const name = kind === 'chrome' ? 'Chrome' : 'Edge';
  return [
    `In ${name}'s extensions page, turn on Developer mode (${kind === 'chrome' ? 'top right' : 'left side'}).`,
    'Click Load unpacked.',
    'Paste the folder path (Ctrl+V) into the folder box and press Select Folder.',
  ];
}

/** Candidate install paths, per-machine and per-user. Pure. */
export function browserCandidates(env = process.env) {
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA || '';
  const list = [
    { kind: 'edge', path: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { kind: 'edge', path: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { kind: 'chrome', path: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { kind: 'chrome', path: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
  ];
  if (local) {
    list.push({ kind: 'edge', path: path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
    list.push({ kind: 'chrome', path: path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') });
  }
  return list;
}

/** Read `App Paths` (read-only registry query) for one exe. */
function appPath(exe) {
  const keys = [
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
  ];
  return new Promise((resolve) => {
    const next = (i) => {
      if (i >= keys.length || process.platform !== 'win32') return resolve(null);
      execFile('reg.exe', ['query', keys[i], '/ve'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
        const m = !err && /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(String(stdout));
        if (m) resolve(m[1].trim().replace(/^"|"$/g, ''));
        else next(i + 1);
      });
    };
    next(0);
  });
}

/**
 * Locate installed Edge and Chrome executables on this machine (the desktop's own, lighter view;
 * engine/find.js via `engines.versions` is preferred when the daemon is up).
 */
export async function findBrowserExecutables({ env = process.env, exists = fs.existsSync, useRegistry = true } = {}) {
  const found = new Map();
  for (const c of browserCandidates(env)) if (!found.has(c.kind) && exists(c.path)) found.set(c.kind, c.path);
  if (useRegistry) {
    for (const [kind, exe] of [['edge', 'msedge.exe'], ['chrome', 'chrome.exe']]) {
      if (found.has(kind)) continue;
      const p = await appPath(exe);
      if (p && exists(p)) found.set(kind, p);
    }
  }
  return [...found].map(([kind, p]) => ({ kind, path: p }));
}

/** What to spawn to open the extensions page. Pure. */
export function extensionsPageCommand(kind, exePath) {
  if (!EXTENSIONS_PAGE[kind]) throw new Error(`Unknown browser "${kind}"`);
  if (!exePath) throw new Error(`${kind === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} was not found on this machine.`);
  return { command: exePath, args: [EXTENSIONS_PAGE[kind]] };
}

/**
 * Open the page in the person's own browser (their default profile — this is the one step where
 * that is the point). Environment is cleaned of ELECTRON_RUN_AS_NODE so it cannot leak into a
 * browser-launched helper.
 */
export function openExtensionsPage(kind, exePath, { spawn = nodeSpawn } = {}) {
  const cmd = extensionsPageCommand(kind, exePath);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(cmd.command, cmd.args, { detached: true, stdio: 'ignore', windowsHide: false, env });
  child.on?.('error', () => {});
  child.unref?.();
  return cmd;
}

export function manifestVersion(dir) {
  const m = readJson(path.join(dir, 'manifest.json'), null);
  return m?.version ?? null;
}

/**
 * Atomic folder replacement: copy to `<target>.new`, move the current folder aside, move the new
 * one into place, delete the old one. The target path itself never changes.
 * Used only when the daemon is unreachable (the daemon's extension.install is the normal path).
 */
export function installExtensionLocal({ from, target }) {
  if (!fs.existsSync(path.join(from, 'manifest.json'))) throw new Error(`No extension at ${from} (manifest.json missing).`);
  const staging = `${target}.new`;
  const old = `${target}.old-${Date.now()}`;
  fs.rmSync(staging, { recursive: true, force: true });
  // Dev override files (dev-daemon.json / dev-bridge.json point the extension at another port) belong
  // to a developer's checkout, never to the folder a QA person loads.
  fs.cpSync(from, staging, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) && !/[\\/]dev-(daemon|bridge)\.json$/i.test(src) });
  let movedOld = false;
  if (fs.existsSync(target)) {
    fs.renameSync(target, old);
    movedOld = true;
  }
  try {
    fs.renameSync(staging, target);
  } catch (err) {
    if (movedOld) fs.renameSync(old, target);
    throw err;
  }
  if (movedOld) fs.rmSync(old, { recursive: true, force: true });
  return { path: target, version: manifestVersion(target), via: 'desktop' };
}

/**
 * Install/refresh G9_HOME/extension: ask the daemon; fall back to the local copy only when the
 * daemon is not connected (never when it answered with an error — that error is the truth).
 */
export async function installExtension({ client, from, target, log = null }) {
  if (client?.connected) {
    const result = await client.admin('extension.install', from ? { from } : {});
    const installedPath = result?.path ?? result?.dir ?? target;
    log?.info?.('Extension installed by the daemon', { path: installedPath, version: result?.version ?? manifestVersion(installedPath) });
    return { path: installedPath, version: result?.version ?? manifestVersion(installedPath), previousVersion: result?.previousVersion ?? null, via: 'daemon', reloaded: result?.reloadSent ?? result?.reloaded ?? null };
  }
  const local = installExtensionLocal({ from, target });
  log?.warn?.('Daemon not connected: extension copied by the desktop', local);
  return { ...local, reloaded: false };
}
