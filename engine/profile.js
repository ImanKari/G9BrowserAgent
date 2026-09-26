// engine/profile.js — Engine 2's browser profiles: G9_HOME/profiles/<name>/ (+ <name>.json).
//
// A profile is a browser user-data-dir that G9 owns. It is never a person's own browser profile:
// Chrome 136+ refuses remote debugging on the default dir, and App-Bound Encryption (Chrome 127+)
// makes a person's cookies undecryptable by any other process or copy (AIGuide §2.8.1). So a site login
// for Engine 2 is made ONCE, by a person, in a headed window on the G9 profile — warm() — and then
// reused by every run on that profile. The same fact means a profile copied to another machine
// loses its cookies; profiles are per machine.
//
// Layout (ARCHITECTURE_V2 §9):
//   G9_HOME/profiles/<name>/          the user-data-dir (Default/Preferences, Cookies, …)
//   G9_HOME/profiles/<name>.json      { name, createdAt, warmedAt, locale, timezone, notes, … }
//
// Preferences are merged into <dir>/Default/Preferences only while no browser uses the profile: a
// running browser keeps its prefs in memory and rewrites the file on exit, silently discarding an
// edit made underneath it.

import { mkdir, readFile, readdir, rename, rm, writeFile, open, readlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { g9Home } from './find.js';

export const DEFAULT_PROFILE = 'automation';

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Profile names are directory names on every OS: letters, digits, '.', '_', '-'; 1–64 chars. */
export function validateName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.endsWith('.') || RESERVED.test(name.split('.')[0])) {
    throw new Error(`Invalid profile name "${name}". Use 1–64 letters, digits, ".", "_" or "-", starting with a letter or digit.`);
  }
  return name;
}

export function profilesDir({ home = g9Home() } = {}) {
  return path.join(home, 'profiles');
}

export function profileDir(name, { home = g9Home() } = {}) {
  return path.join(profilesDir({ home }), validateName(name));
}

function metaPath(name, home) {
  return path.join(profilesDir({ home }), `${validateName(name)}.json`);
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

async function readMeta(name, home) {
  try {
    return JSON.parse(await readFile(metaPath(name, home), 'utf8'));
  } catch {
    return null;
  }
}

function freshMeta(name, { locale = null, timezone = null, notes = '' } = {}) {
  return { name, createdAt: new Date().toISOString(), warmedAt: null, locale, timezone, notes };
}

/**
 * Is a browser using this user-data-dir right now? → { inUse, how, pid? }
 *
 * Windows: Chrome/Edge create `<dir>\lockfile` with GENERIC_WRITE, FILE_SHARE_READ and
 * FILE_FLAG_DELETE_ON_CLOSE for their whole lifetime (process_singleton_win.cc). So: while the
 * browser runs, a READ open succeeds (measured: a read-only probe called a running Edge's profile
 * "free") but a WRITE open fails with EBUSY; after a clean exit the file is gone; after a crash it
 * may remain and opens fine. Opening it for writing — never writing, truncating or deleting — is
 * therefore an exact, non-destructive test.
 * POSIX: `SingletonLock` is a symlink "<hostname>-<pid>"; in use when that pid is alive here.
 */
export async function profileInUse(dir) {
  if (process.platform === 'win32') {
    const lock = path.join(dir, 'lockfile');
    if (!existsSync(lock)) return { inUse: false, how: 'no lockfile' };
    try {
      const fh = await open(lock, 'r+');
      await fh.close();
      return { inUse: false, how: 'stale lockfile' };
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') return { inUse: true, how: `lockfile held (${err.code})` };
      return { inUse: false, how: `lockfile unreadable (${err.code})` };
    }
  }
  try {
    const target = await readlink(path.join(dir, 'SingletonLock'));
    const m = /^(.*)-(\d+)$/.exec(target);
    if (!m) return { inUse: true, how: `SingletonLock → ${target}` };
    const [, host, pidText] = m;
    const pid = Number(pidText);
    if (host !== os.hostname()) return { inUse: true, how: `locked by host ${host}`, pid };
    try {
      process.kill(pid, 0);
      return { inUse: true, how: 'SingletonLock pid alive', pid };
    } catch (err) {
      return err.code === 'EPERM' ? { inUse: true, how: 'SingletonLock pid alive', pid } : { inUse: false, how: 'stale SingletonLock', pid };
    }
  } catch {
    return { inUse: false, how: 'no SingletonLock' };
  }
}

// What remove() and the atomic writers leave behind for a moment (or for good, after a crash):
// "<name>.removing-<pid>-<time>" and "<file>.tmp-<pid>-<time>". Valid-looking names, never profiles.
const LEFTOVER = /\.(removing|tmp)-\d+-\d+$/;

/** Every profile → [{ name, dir, meta, inUse }], sorted by name. */
export async function list({ home = g9Home() } = {}) {
  let entries;
  try {
    entries = await readdir(profilesDir({ home }), { withFileTypes: true });
  } catch {
    return [];
  }
  const names = new Set();
  for (const e of entries) {
    if (e.isDirectory()) names.add(e.name);
    else if (e.isFile() && e.name.endsWith('.json')) names.add(e.name.slice(0, -5));
  }
  const out = [];
  for (const name of [...names].sort()) {
    if (LEFTOVER.test(name)) continue;
    try { validateName(name); } catch { continue; }
    const dir = profileDir(name, { home });
    if (!existsSync(dir)) continue;      // metadata without a directory: a half-removed profile
    const meta = (await readMeta(name, home)) ?? { ...freshMeta(name), createdAt: null };
    out.push({ name, dir, meta, inUse: (await profileInUse(dir)).inUse });
  }
  return out;
}

/**
 * The profile `name`, created if missing → { name, dir, meta, created }.
 * `locale`/`timezone`/`notes` are recorded on creation, or updated when passed for an existing one.
 */
export async function ensure(name = DEFAULT_PROFILE, { home = g9Home(), locale, timezone, notes } = {}) {
  const dir = profileDir(name, { home });
  await mkdir(dir, { recursive: true });
  let meta = await readMeta(name, home);
  const created = !meta;
  if (!meta) meta = freshMeta(name, { locale: locale ?? null, timezone: timezone ?? null, notes: notes ?? '' });
  else {
    if (locale !== undefined) meta.locale = locale;
    if (timezone !== undefined) meta.timezone = timezone;
    if (notes !== undefined) meta.notes = notes;
  }
  if (created || locale !== undefined || timezone !== undefined || notes !== undefined) await writeJsonAtomic(metaPath(name, home), meta);
  return { name, dir, meta, created };
}

/** Merge `patch` into a profile's metadata → the new metadata. */
export async function updateMeta(name, patch, { home = g9Home() } = {}) {
  const meta = { ...((await readMeta(name, home)) ?? freshMeta(name)), ...patch, name };
  await writeJsonAtomic(metaPath(name, home), meta);
  return meta;
}

/** Delete a profile (directory and metadata). Refuses while a browser uses it. */
export async function remove(name, { home = g9Home() } = {}) {
  const dir = profileDir(name, { home });
  if (existsSync(dir)) {
    const use = await profileInUse(dir);
    if (use.inUse) throw new Error(`Profile "${name}" is in use by a running browser (${use.how}); stop that engine first.`);
    // Rename first so a half-deleted profile is never mistaken for a usable one.
    const trash = `${dir}.removing-${process.pid}-${Date.now()}`;
    await rename(dir, trash);
    await rm(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  await rm(metaPath(name, home), { force: true });
  return { removed: true, name };
}

// ─── Preferences ─────────────────────────────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `{ 'intl.accept_languages': 'de-DE,de', download: { prompt_for_download: false } }` →
 * nested objects. Chrome's pref names ARE dotted paths into the Preferences JSON.
 */
export function expandPrefs(prefs) {
  const out = {};
  for (const [key, value] of Object.entries(prefs ?? {})) {
    const parts = key.split('.');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!isPlainObject(node[parts[i]])) node[parts[i]] = {};
      node = node[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    node[leaf] = isPlainObject(value) && isPlainObject(node[leaf])
      ? deepMerge(node[leaf], expandPrefs(value))
      : (isPlainObject(value) ? expandPrefs(value) : value);
  }
  return out;
}

/** Objects merge recursively; arrays and scalars replace. */
export function deepMerge(base, patch) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/**
 * Merge `prefs` into <profile>/Default/Preferences (creating it for a fresh profile; Chrome reads
 * a pre-seeded file on first start). → the merged Preferences object.
 *
 * Useful prefs: `intl.accept_languages`, `download.default_directory`,
 * `download.prompt_for_download`, `spellcheck.dictionaries`,
 * `profile.default_content_setting_values.notifications` (2 = block), `credentials_enable_service`,
 * `translate.enabled`. Prefs that Chrome protects with a MAC in "Secure Preferences" (homepage,
 * startup URLs, search engine, extensions) are reset by the browser when edited here — by design.
 */
export async function applyPreferences(name, prefs, { home = g9Home() } = {}) {
  const dir = profileDir(name, { home });
  if (!existsSync(dir)) throw new Error(`Profile "${name}" does not exist. Create it first (profile.ensure).`);
  const use = await profileInUse(dir);
  if (use.inUse) {
    throw new Error(`Profile "${name}" is in use by a running browser (${use.how}). Preferences can only be changed while it is closed — a running browser rewrites the file on exit.`);
  }
  const file = path.join(dir, 'Default', 'Preferences');
  let current = {};
  try {
    current = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${err.message}`);
  }
  const merged = deepMerge(current, expandPrefs(prefs));
  await writeJsonAtomic(file, merged);
  // The engine manager checks locale / timezone / Accept-Language for consistency (docs/STEALTH.md) from
  // the profile's METADATA — it cannot open Preferences while the browser runs. Keep the language
  // list there too, so what the check sees is what the browser sends.
  const acceptLanguage = merged?.intl?.accept_languages;
  if (typeof acceptLanguage === 'string' && acceptLanguage) {
    const meta = await readMeta(name, home);
    if (meta?.acceptLanguage !== acceptLanguage) await updateMeta(name, { acceptLanguage }, { home });
  }
  return merged;
}

export async function readPreferences(name, { home = g9Home() } = {}) {
  try {
    return JSON.parse(await readFile(path.join(profileDir(name, { home }), 'Default', 'Preferences'), 'utf8'));
  } catch {
    return null;
  }
}

// ─── browser account sign-in ─────────────────────────────────────────────────────────────────

const nonEmpty = (v) => (typeof v === 'string' ? v.trim().length > 0 : v != null && v !== false && v !== 0);

/**
 * Is a browser ACCOUNT signed in to this profile (not a site login — the browser's own
 * Microsoft/Google account, the one that syncs)? → { signedIn, profiles: [{ key, userName,
 * gaiaId, edgeAccount, accountType, consentedPrimary }], accountInfo, checked: [files] }.
 *
 * Why it exists (live round 2, 2026-09-22): Edge signs every NEW profile into the Windows
 * account by itself and turns sync on (engine/launch.js DISABLED_FEATURES says what and how it is
 * now prevented). Prevention only works from a profile's first start: a profile created before
 * that fix stays signed in, and so does one a person signed in on purpose. Launching it for
 * automation would pull that person's synced data into agent runs, and a stealth run would carry
 * the synced extensions' content scripts into every page. The engine manager asks this before
 * every launch.
 *
 * Read-only, and it reports only WHETHER an identity is there — never the name, e-mail or id
 * itself (booleans), so nothing personal ends up in logs or tool results. Sources: `<dir>/Local
 * State` profile.info_cache.<profile>.{user_name, gaia_id, edge_account_cid, edge_account_oid,
 * is_consented_primary_account, edge_account_type} and `<dir>/Default/Preferences` account_info.
 * Files that do not exist (a fresh profile) mean "not signed in".
 */
export async function signInState(name, { home = g9Home(), dir = null } = {}) {
  const root = dir ?? profileDir(name, { home });
  const checked = [];
  const profiles = [];
  try {
    const local = JSON.parse(await readFile(path.join(root, 'Local State'), 'utf8'));
    checked.push('Local State');
    for (const [key, info] of Object.entries(local?.profile?.info_cache ?? {})) {
      if (!info || typeof info !== 'object') continue;
      const row = {
        key,
        userName: nonEmpty(info.user_name),
        gaiaId: nonEmpty(info.gaia_id),
        edgeAccount: nonEmpty(info.edge_account_cid) || nonEmpty(info.edge_account_oid),
        accountType: Number.isFinite(Number(info.edge_account_type)) ? Number(info.edge_account_type) : null,
        consentedPrimary: info.is_consented_primary_account === true,
      };
      profiles.push(row);
    }
  } catch { /* no Local State yet: a profile that never ran */ }
  let accountInfo = 0;
  try {
    const prefs = JSON.parse(await readFile(path.join(root, 'Default', 'Preferences'), 'utf8'));
    checked.push('Default/Preferences');
    accountInfo = Array.isArray(prefs?.account_info) ? prefs.account_info.length : 0;
  } catch { /* no Preferences yet */ }
  const signedIn = accountInfo > 0 || profiles.some((p) => p.userName || p.gaiaId || p.edgeAccount);
  return { signedIn, profiles, accountInfo, checked };
}

// ─── session restore ─────────────────────────────────────────────────────────────────────────

/**
 * Forget the tabs the previous run left open, so the next start does not reopen them.
 *
 * Measured (live round 2, Chrome for Testing 153.0.8010.52): a reused profile reopened the previous
 * session's tabs on EVERY relaunch — the warm-up's last page, then detector pages from earlier runs,
 * up to four tabs, three of them nobody's — after a clean Browser.close (exit_type Normal, no
 * session.* prefs set), and in 4 of 5 runs a restored tab ended up in front of the agent's. That is
 * traffic and cookies to sites nobody asked for on every launch. Edge did not restore.
 *
 * The startup preference (`session.restore_on_startup`) is one of the prefs Chrome protects with a
 * MAC in Secure Preferences: editing it here is reverted by the browser and can raise a "settings
 * were changed" notice. So the SESSION FILES go instead — with nothing to restore, nothing is. Only
 * while no browser uses the profile (a running one rewrites them). → { removed: [names] }
 */
export async function clearSessionRestore(name, { home = g9Home(), dir = null } = {}) {
  const root = dir ?? profileDir(name, { home });
  const use = await profileInUse(root);
  if (use.inUse) throw new Error(`Profile "${name}" is in use by a running browser (${use.how}); its session can only be cleared while it is closed.`);
  const removed = [];
  // Sessions/ (Chrome 100+); the four flat files are the older layout, still read if present.
  for (const entry of ['Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) {
    const target = path.join(root, 'Default', entry);
    if (!existsSync(target)) continue;
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    removed.push(entry);
  }
  return { removed };
}

// ─── warm ────────────────────────────────────────────────────────────────────────────────────

/**
 * Open the profile in a HEADED browser at `url` so a person can sign in once; resolves when they
 * close the browser, then stamps `warmedAt`. → { name, dir, url, warmedAt, exit, browser, argv }
 *
 * The window is the same browser, switches and profile the runs will use (launch.js), so the
 * session a person creates here is the session the runs inherit. G9 sends nothing to the page:
 * the pipe is only used to learn the version and, if asked, to close the browser.
 *
 * opts: browser ('auto'|'edge'|'chrome'|'cft'|path), windowSize, lang, extraArgs,
 *       signal (AbortSignal: closes the window), timeoutMs (0 = wait for the person),
 *       onLaunched(handle) — called with launchBrowser's handle once the window is up,
 *       headless (tests only: nobody can sign in to a window that does not exist).
 */
export async function warm(name, url, {
  home = g9Home(), browser = 'auto', windowSize, lang, extraArgs = [], signal, timeoutMs = 0,
  onLaunched, headless = false, launch,
} = {}) {
  const { dir, meta } = await ensure(name, { home });
  const use = await profileInUse(dir);
  if (use.inUse) throw new Error(`Profile "${name}" is already open in a browser (${use.how}). Close that window first.`);
  const startUrl = url ? String(url) : 'about:blank';
  const launchBrowser = launch ?? (await import('./launch.js')).launchBrowser;
  // componentUpdate: a person's first launch of a browser is when it fetches its components — the
  // Widevine CDM among them (launch.js COMPONENT_UPDATE_SWITCH); the stealth runs on this profile use it.
  // stealth 'stealth': a PERSON drives this window and G9 sends nothing to the page, so decision
  // D-a's "off/human tell the truth" (about agent-driven runs) does not apply. Without it the
  // debugging pipe turned AutomationControlled on and every page of the sign-in window reported
  // navigator.webdriver === true — the one-time sign-in ran in a browser that said it was automated,
  // exactly what sign-in pages and bot walls refuse (engine review, 2026-09-22: Edge 153 and CfT
  // 153 both {webdriver:true}; with this, false). At this level launch.js adds only
  // --disable-blink-features=AutomationControlled, and the stealth runs on this profile carry the same
  // switch, which keeps "the same switches the runs use" true.
  const handle = await launchBrowser({
    browser, headless, profileDir: dir, windowSize, lang: lang ?? meta.locale ?? undefined, extraArgs, startUrl, home,
    componentUpdate: true,
    stealth: 'stealth',
  });
  // A window G9 closed (abort, timeout) is not a finished login: only a person closing it counts.
  let cancelledBy = null;
  const cancel = (why) => { cancelledBy = cancelledBy ?? why; handle.close().catch(() => {}); };
  const onAbort = () => cancel('aborted');
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer = null;
  if (timeoutMs > 0) timer = setTimeout(() => cancel(`timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
  try {
    if (signal?.aborted) cancel('aborted');
    if (onLaunched) await onLaunched(handle);
    const exit = await handle.exited;
    // A person closing the window ends the browser with code 0 (measured, Edge 153 headed: last
    // tab closed → exit 0 in 0.5 s). Anything else — a crash code, a kill signal — may have lost
    // the login before it reached the disk, so it is not reported as a warmed profile.
    if (!cancelledBy && (exit?.signal || (exit?.code !== 0 && exit?.code !== undefined))) {
      cancelledBy = `the browser ended abnormally (${exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`}); the sign-in may not have been saved — warm the profile again`;
    }
    if (cancelledBy) {
      return { name, dir, url: startUrl, warmed: false, reason: cancelledBy, warmedAt: meta.warmedAt ?? null, exit, browser: handle.browser, argv: handle.argv };
    }
    const warmedAt = new Date().toISOString();
    await updateMeta(name, { warmedAt, warmedWith: `${handle.browser.kind} ${handle.browser.version}`, warmedUrl: startUrl }, { home });
    return { name, dir, url: startUrl, warmed: true, warmedAt, exit, browser: handle.browser, argv: handle.argv };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await handle.close().catch(() => {});
  }
}
