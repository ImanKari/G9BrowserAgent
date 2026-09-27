/**
 * Registering the G9BrowserAgent MCP shim with the AI clients on this machine (docs/INSTALL.md, "AI clients (MCP registration)").
 *
 * The entry is named 'g9browseragent'. Until 3.2.0 it was 'g9-browser' (also the name v1's
 * install.ps1 used): an entry under that old name is recognised as this app's own, and registering
 * moves it to the new name instead of leaving two (LEGACY_ENTRY_NAMES, migrateRegistrations).
 *
 * Packaged: `G9BrowserAgent.exe` + ELECTRON_RUN_AS_NODE=1 runs resources/mcp/shim.mjs — no Node needed.
 * Dev:      `node <repo>/mcp/shim.mjs`.
 *
 * Rules:
 *   - Never silently overwrite. An existing 'g9browseragent' entry that differs is shown as a diff and
 *     only replaced after the person confirms (`confirmReplace`).
 *   - Back up first: `<file>.g9-backup-<timestamp>` next to the original, before any write.
 *   - Everything else in the file is preserved. ~/.claude.json in particular is Claude Code's own
 *     state file (projects, history, settings) — we only touch `mcpServers['g9browseragent']`, re-read
 *     it immediately before writing, write atomically, and read back to verify.
 *   - A file with comments (VS Code's mcp.json is JSONC) is parsed, but writing it back as JSON
 *     drops the comments, so that needs its own confirmation (`confirmDropComments`).
 *   - A file that does not parse is never written. The person gets the snippet to paste instead.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forwardSlashes, DEFAULT_PORT, resourcePaths } from './paths.mjs';
import { writeTextAtomic } from './jsonfile.mjs';

export const ENTRY_NAME = 'g9browseragent';
/** Names this app's entry had before (G9 up to 3.2.0, and v1's install.ps1). */
export const LEGACY_ENTRY_NAMES = Object.freeze(['g9-browser']);

/**
 * Where desktop apps keep per-user settings (VS Code's User folder, Claude Desktop's config). Pure.
 *   Windows  %APPDATA%                          (…\AppData\Roaming)
 *   macOS    ~/Library/Application Support
 *   Linux    $XDG_CONFIG_HOME, else ~/.config
 */
export function userConfigRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') return env.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME && String(env.XDG_CONFIG_HOME).trim() ? String(env.XDG_CONFIG_HOME).trim() : path.join(home, '.config');
}

/**
 * The four clients G9BrowserAgent registers with, with where their user-level config lives. Pure.
 * `appData` is the per-user settings root (userConfigRoot); tests pass it directly.
 */
export function mcpClients({ home = os.homedir(), platform = process.platform, env = process.env, appData = userConfigRoot({ platform, env, home }) } = {}) {
  const claudeRestart = platform === 'darwin'
    ? 'Quit Claude Desktop (Claude → Quit, or Cmd+Q) and start it again.'
    : 'Quit Claude Desktop from the tray and start it again.';
  return [
    {
      id: 'claude-code', label: 'Claude Code', file: path.join(home, '.claude.json'), key: 'mcpServers', type: 'stdio',
      detect: [path.join(home, '.claude.json'), path.join(home, '.claude')],
      restartHint: 'Start a new Claude Code session (or run /mcp) to pick it up.',
    },
    {
      id: 'cursor', label: 'Cursor', file: path.join(home, '.cursor', 'mcp.json'), key: 'mcpServers', type: null,
      detect: [path.join(home, '.cursor')],
      restartHint: 'Restart Cursor, or toggle the server in Settings → MCP.',
    },
    {
      id: 'vscode', label: 'VS Code', file: path.join(appData, 'Code', 'User', 'mcp.json'), key: 'servers', type: 'stdio',
      detect: [path.join(appData, 'Code', 'User')],
      restartHint: 'VS Code picks it up from the MCP: List Servers command; start it there once.',
    },
    {
      id: 'claude-desktop', label: 'Claude Desktop', file: path.join(appData, 'Claude', 'claude_desktop_config.json'), key: 'mcpServers', type: null,
      detect: [path.join(appData, 'Claude')],
      restartHint: claudeRestart,
    },
  ];
}

/** Which clients look installed (any detection path exists). */
export function detectClients(clients, { exists = fs.existsSync } = {}) {
  return clients.map((c) => ({ ...c, installed: c.detect.some((p) => exists(p)), fileExists: exists(c.file) }));
}

/**
 * The shim entry, before per-client shaping. Env carries only what differs from the defaults, so an
 * entry written on a default machine stays identical across re-runs.
 */
export function shimEntry({ isPackaged, execPath, resourceRoot, port = DEFAULT_PORT, homeOverride = null, appImage = null }) {
  const { shimScript } = resourcePaths(resourceRoot);
  const env = {};
  if (isPackaged || appImage) env.ELECTRON_RUN_AS_NODE = '1';
  if (port && Number(port) !== DEFAULT_PORT) env.G9_PORT = String(port);
  if (homeOverride) env.G9_HOME = forwardSlashes(homeOverride);
  // A Linux AppImage runs from a mount that is gone once G9BrowserAgent quits: the entry names the .AppImage
  // file and the stable bootstrap instead (`appImage` = { file, bootstrap }, lib/runtime.mjs).
  const entry = appImage
    // '--no-sandbox' after the script keeps the AppImage's AppRun from putting it before it, where
    // Node (ELECTRON_RUN_AS_NODE) rejects it; the bootstrap drops it (lib/runtime.mjs NO_SANDBOX).
    ? { command: forwardSlashes(appImage.file), args: [forwardSlashes(appImage.bootstrap), 'mcp/shim.mjs', '--no-sandbox'] }
    : {
      command: isPackaged ? forwardSlashes(execPath) : 'node',
      args: [forwardSlashes(shimScript)],
    };
  if (Object.keys(env).length) entry.env = env;
  return entry;
}

/**
 * Why an executable path must not be written into an MCP config, or null when it may. Pure.
 * macOS runs an unsigned app that was opened from Downloads or a disk image from a random,
 * read-only copy (App Translocation, `/private/var/folders/…/AppTranslocation/…`) or from the
 * mounted image (`/Volumes/…`); an MCP entry naming either stops working at the next start.
 */
export function unstableExecReason({ execPath, platform = process.platform }) {
  const p = forwardSlashes(execPath ?? '');
  if (platform === 'darwin' && /\/AppTranslocation\//.test(p)) {
    return 'macOS is running G9BrowserAgent from a temporary copy (App Translocation). Move G9BrowserAgent.app to the Applications folder, start it from there, and register again.';
  }
  if (platform === 'darwin' && /^\/Volumes\//.test(p)) {
    return 'G9BrowserAgent is running from the disk image. Drag G9BrowserAgent.app to the Applications folder, start it from there, and register again.';
  }
  return null;
}

/** Shape the entry for one client: VS Code and Claude Code carry `type: 'stdio'`. */
export function entryForClient(client, base) {
  return client.type ? { type: client.type, ...base } : { ...base };
}

// --------------------------------------------------------------- JSON with comments

/**
 * Remove // and /* *\/ comments and trailing commas, leaving strings intact — including the
 * trailing-comma pass: a regex over the whole text would also rewrite `", }"` INSIDE a string
 * value (another server's argument), and the file is written back from what this parses.
 */
export function stripJsonc(text) {
  const n = text.length;
  const stringEnd = (i) => {
    let j = i + 1;
    while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
    return Math.min(j + 1, n);
  };
  let out = '';
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      const j = stringEnd(i);
      out += text.slice(i, j);
      i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  // Trailing commas, outside strings only (comments are gone, so only whitespace can follow).
  let result = '';
  const m = out.length;
  for (let k = 0; k < m; k++) {
    const ch = out[k];
    if (ch === '"') {
      let j = k + 1;
      while (j < m && out[j] !== '"') j += out[j] === '\\' ? 2 : 1;
      result += out.slice(k, j + 1);
      k = j;
      continue;
    }
    if (ch === ',') {
      let j = k + 1;
      while (j < m && /\s/.test(out[j])) j++;
      if (out[j] === '}' || out[j] === ']') continue;
    }
    result += ch;
  }
  return result;
}

/** @returns {{ ok, value?, jsonc?, error? }} */
export function parseConfig(text) {
  const clean = String(text ?? '').replace(/^﻿/, '');
  if (!clean.trim()) return { ok: true, value: {}, jsonc: false, empty: true };
  try {
    return { ok: true, value: JSON.parse(clean), jsonc: false };
  } catch {
    /* maybe JSONC */
  }
  try {
    const stripped = stripJsonc(clean);
    return { ok: true, value: JSON.parse(stripped), jsonc: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// --------------------------------------------------------------- comparing and diffing

function normalizeForCompare(v) {
  if (Array.isArray(v)) return v.map(normalizeForCompare);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalizeForCompare(v[k]);
    return out;
  }
  if (typeof v === 'string') return v.replace(/\\/g, '/');
  return v;
}

/** Same entry, ignoring key order, slash direction and an explicit type:"stdio" (the default). */
export function sameEntry(a, b) {
  const strip = (e) => {
    const c = { ...(e ?? {}) };
    if (c.type === 'stdio') delete c.type;
    if (c.env && !Object.keys(c.env).length) delete c.env;
    return normalizeForCompare(c);
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/** A line diff (LCS) between two JSON renderings: [{op:' '|'-'|'+', line}]. */
export function diffLines(before, after) {
  const a = before == null ? [] : JSON.stringify(before, null, 2).split('\n');
  const b = after == null ? [] : JSON.stringify(after, null, 2).split('\n');
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ op: ' ', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', line: a[i++] });
    else out.push({ op: '+', line: b[j++] });
  }
  while (i < m) out.push({ op: '-', line: a[i++] });
  while (j < n) out.push({ op: '+', line: b[j++] });
  return out;
}

function isV1Entry(e) {
  return JSON.stringify(e ?? {}).replace(/\\\\/g, '/').includes('bridge/src/server.js');
}

/**
 * What registering would do to this file. Pure.
 * @param {string|null} text   the file's current contents, null when it does not exist
 * 'rename': this app's entry is there under an old name (LEGACY_ENTRY_NAMES); writing moves it to
 * ENTRY_NAME with the current command, and needs no confirmation (it was ours).
 * @returns {{ status: 'create'|'add'|'same'|'different'|'rename'|'invalid', jsonc, existing, entry, diff, nextText, note }}
 */
export function planRegistration(client, text, entry) {
  const shaped = entryForClient(client, entry);
  if (text == null) {
    const value = { [client.key]: { [ENTRY_NAME]: shaped } };
    return { status: 'create', jsonc: false, existing: null, entry: shaped, diff: diffLines(null, shaped), nextText: `${JSON.stringify(value, null, 2)}\n`, note: null };
  }
  const parsed = parseConfig(text);
  if (!parsed.ok) {
    return { status: 'invalid', jsonc: false, existing: null, entry: shaped, diff: [], nextText: null, note: `The file is not valid JSON (${parsed.error}). It was not touched; add the entry by hand.` };
  }
  const root = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value : null;
  if (!root) return { status: 'invalid', jsonc: false, existing: null, entry: shaped, diff: [], nextText: null, note: 'The file does not hold a JSON object. It was not touched.' };
  const servers = root[client.key];
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    return { status: 'invalid', jsonc: parsed.jsonc, existing: null, entry: shaped, diff: [], nextText: null, note: `"${client.key}" in this file is not an object. It was not touched.` };
  }
  const legacyNames = LEGACY_ENTRY_NAMES.filter((n) => servers && Object.hasOwn(servers, n));
  const current = servers?.[ENTRY_NAME] ?? null;
  const existing = current ?? (legacyNames.length ? servers[legacyNames[0]] : null);
  if (current && sameEntry(current, shaped) && !legacyNames.length) {
    return { status: 'same', jsonc: parsed.jsonc, existing, entry: shaped, diff: [], nextText: null, note: 'Already registered.' };
  }
  const nextServers = { ...(servers ?? {}) };
  for (const n of legacyNames) delete nextServers[n];
  const next = { ...root, [client.key]: { ...nextServers, [ENTRY_NAME]: shaped } };
  const indent = /\n\t/.test(text) ? '\t' : 2;
  const trailingNewline = /\n\s*$/.test(text) || !text.length;
  const nextText = JSON.stringify(next, null, indent) + (trailingNewline ? '\n' : '');
  // This app's own entry under its old name is moved, not questioned — unless an entry under the
  // new name is also there and differs, which someone put there deliberately.
  const renamed = legacyNames.length && (!current || sameEntry(current, shaped));
  return {
    status: renamed ? 'rename' : existing ? 'different' : 'add',
    jsonc: parsed.jsonc,
    existing,
    entry: shaped,
    diff: diffLines(existing, shaped),
    nextText,
    note: renamed
      ? `The entry is renamed from "${legacyNames.join('", "')}" to "${ENTRY_NAME}" (G9BrowserAgent's new name).`
      : existing
      ? isV1Entry(existing)
        ? 'This is the v1 entry (bridge/src/server.js). v2 keeps that path working through a forwarder, so replacing it is optional but recommended.'
        : 'A different g9browseragent entry is already configured. Replace it only if it is not deliberate.'
      : null,
  };
}

function timestamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function backupFile(file, { now = new Date() } = {}) {
  if (!fs.existsSync(file)) return null;
  let target = `${file}.g9-backup-${timestamp(now)}`;
  for (let i = 2; fs.existsSync(target); i++) target = `${file}.g9-backup-${timestamp(now)}-${i}`;
  fs.copyFileSync(file, target);
  return target;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Plan against the file as it is right now. */
export function inspectClient(client, entry) {
  const head = { client: { id: client.id, label: client.label, file: client.file, key: client.key } };
  let text;
  try {
    text = readText(client.file);
  } catch (err) {
    return { ...head, status: 'invalid', jsonc: false, existing: null, entry: entryForClient(client, entry), diff: [], nextText: null, note: `The file cannot be read (${err.code ?? err.message}). It was not touched.` };
  }
  return { ...head, ...planRegistration(client, text, entry) };
}

/**
 * Register (or replace, when confirmed). Re-reads the file at the last moment, backs it up,
 * writes atomically and verifies by reading back.
 */
export function applyRegistration(client, entry, { confirmReplace = false, confirmDropComments = false, log = null } = {}) {
  const text = readText(client.file);
  const plan = planRegistration(client, text, entry);
  const base = { client: client.id, file: client.file, status: plan.status, diff: plan.diff, note: plan.note };
  if (plan.status === 'invalid') {
    log?.warn?.(`MCP ${client.label}: ${plan.note}`, { file: client.file });
    return { ...base, ok: false, message: plan.note, snippet: { [client.key]: { [ENTRY_NAME]: plan.entry } } };
  }
  if (plan.status === 'same') {
    log?.info?.(`MCP ${client.label}: already registered`, { file: client.file });
    return { ...base, ok: true, changed: false, message: 'Already registered.' };
  }
  if (plan.status === 'different' && !confirmReplace) {
    return { ...base, ok: false, needsConfirm: 'replace', existing: plan.existing, entry: plan.entry, message: plan.note };
  }
  if (plan.jsonc && !confirmDropComments) {
    return { ...base, ok: false, needsConfirm: 'comments', message: 'This file contains comments. Writing it keeps every setting but removes the comments (a backup keeps the original).' };
  }
  const backup = plan.status === 'create' ? null : backupFile(client.file);
  writeTextAtomic(client.file, plan.nextText);
  const verify = planRegistration(client, readText(client.file), entry);
  const ok = verify.status === 'same';
  const done = plan.status === 'different' ? 'Replaced' : plan.status === 'rename' ? 'Renamed' : 'Registered';
  log?.[ok ? 'info' : 'error']?.(`MCP ${client.label}: ${done.toLowerCase()}${ok ? '' : ' but the read-back did not match'}`, { file: client.file, backup });
  return {
    ...base,
    ok,
    changed: true,
    backup,
    message: ok
      ? `${done} in ${client.file}. ${client.restartHint ?? ''}`.trim()
      : 'Written, but reading the file back did not show the entry (another program may have rewritten it). Try again after closing that client.',
  };
}

/** Remove the g9browseragent entry (backup first). Leaves every other entry alone. */
export function removeRegistration(client, { confirmDropComments = false, log = null } = {}) {
  const text = readText(client.file);
  if (text == null) return { ok: true, changed: false, message: 'No config file.' };
  const parsed = parseConfig(text);
  if (!parsed.ok) return { ok: false, changed: false, message: 'The file is not valid JSON; not touched.' };
  const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(parsed.value)) return { ok: false, changed: false, message: 'The file does not hold a JSON object; not touched.' };
  const servers = parsed.value[client.key];
  if (servers === undefined) return { ok: true, changed: false, message: 'Not registered.' };
  if (!isObject(servers)) return { ok: false, changed: false, message: `"${client.key}" in this file is not an object; not touched.` };
  const names = [ENTRY_NAME, ...LEGACY_ENTRY_NAMES].filter((n) => Object.hasOwn(servers, n));
  if (!names.length) return { ok: true, changed: false, message: 'Not registered.' };
  // Same rule as registering: rewriting a JSONC file drops its comments, so that is asked first.
  if (parsed.jsonc && !confirmDropComments) {
    return { ok: false, changed: false, needsConfirm: 'comments', message: 'This file contains comments. Removing the entry keeps every setting but removes the comments (a backup keeps the original).' };
  }
  const nextServers = { ...servers };
  for (const n of names) delete nextServers[n];
  const next = { ...parsed.value, [client.key]: nextServers };
  const backup = backupFile(client.file);
  writeTextAtomic(client.file, `${JSON.stringify(next, null, /\n\t/.test(text) ? '\t' : 2)}\n`);
  log?.info?.(`MCP ${client.label}: entry removed`, { file: client.file, backup });
  return { ok: true, changed: true, backup, message: `Removed from ${client.file}.` };
}

/**
 * Move this app's entry from an old name to ENTRY_NAME, keeping its content (an entry under the new
 * name wins; the old one is dropped). Backup first; atomic write; plain JSON files only.
 */
function renameEntry(client, { log = null } = {}) {
  const text = readText(client.file);
  const parsed = text == null ? { ok: false } : parseConfig(text);
  if (!parsed.ok || parsed.jsonc) return { ok: false, changed: false, message: 'Not a plain JSON file; left for Setup.' };
  const servers = parsed.value?.[client.key];
  const legacy = LEGACY_ENTRY_NAMES.find((n) => servers && Object.hasOwn(servers, n));
  if (!legacy) return { ok: true, changed: false, message: 'Nothing to rename.' };
  const next = { ...servers, [ENTRY_NAME]: servers[ENTRY_NAME] ?? servers[legacy] };
  for (const n of LEGACY_ENTRY_NAMES) delete next[n];
  const backup = backupFile(client.file);
  writeTextAtomic(client.file, `${JSON.stringify({ ...parsed.value, [client.key]: next }, null, /\n\t/.test(text) ? '\t' : 2)}\n`);
  log?.info?.(`MCP ${client.label}: entry renamed from ${legacy} to ${ENTRY_NAME}`, { file: client.file, backup });
  return { ok: true, changed: true, backup, message: `Renamed from ${legacy} to ${ENTRY_NAME} in ${client.file}.` };
}

/**
 * The absolute paths an entry depends on: its command (unless it is `node` from the PATH) and any
 * absolute argument — the shim script, or an AppImage's bootstrap in the data folder.
 */
function entryPaths(e) {
  const abs = (s) => typeof s === 'string' && (path.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s));
  return [e?.command, ...(Array.isArray(e?.args) ? e.args : [])].filter(abs);
}

/**
 * At the installed app's start: bring this app's entries in every AI client up to date, without
 * asking, where they are certainly its own and certainly stale —
 *   - an entry under an old name (G9 up to 3.2.0: 'g9-browser') moves to ENTRY_NAME, as it is when
 *     every file it names still exists (a repository checkout, a fork: someone's choice);
 *   - an entry under ENTRY_NAME that names a file which no longer exists (3.2.1 renamed G9.exe, G9.app,
 *     /opt/G9 and the data folder holding an AppImage's bootstrap) is pointed at this app.
 * An entry whose files all exist and that differs is someone's deliberate choice: left alone.
 * A file with comments is left for Setup, which asks before dropping them. Every write is backed up.
 * @returns {Array<{client, file, status, ok, changed, message}>} one row per client with a file
 */
export function migrateRegistrations(clients, entry, { exists = fs.existsSync, log = null } = {}) {
  const rows = [];
  for (const client of clients) {
    let text;
    try { text = readText(client.file); } catch { continue; }
    if (text == null) continue;
    const plan = planRegistration(client, text, entry);
    const paths = entryPaths(plan.existing);
    const gone = !isV1Entry(plan.existing) && paths.length > 0 && paths.some((p) => !exists(p));
    const stale = (plan.status === 'different' || plan.status === 'rename') && gone;
    if (plan.status !== 'rename' && !stale) continue;
    if (plan.jsonc) {
      rows.push({ client: client.id, file: client.file, status: plan.status, ok: false, changed: false, message: 'Left for Setup: the file has comments.' });
      continue;
    }
    if (!stale) {
      // Its files all exist — a repository checkout, a fork, another install: only the name changes.
      const r = renameEntry(client, { log });
      rows.push({ client: client.id, file: client.file, status: 'renamed', ok: r.ok, changed: r.changed, message: r.message });
      continue;
    }
    const r = applyRegistration(client, entry, { confirmReplace: true, log });
    rows.push({ client: client.id, file: client.file, status: 'repointed', ok: r.ok, changed: !!r.changed, message: r.message });
  }
  return rows;
}
