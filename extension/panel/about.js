/**
 * The About view: which build is this, what did it replace, and what is it
 * talking to.
 *
 * ## Why a whole tab for a version number
 *
 * Every change to this product bumps the version, and the version is how a
 * person confirms that a reload actually took. It used to live only on
 * edge://extensions, one page away from where anyone was looking — so it was
 * never checked, and "I reloaded, it still does the old thing" had no quick
 * answer. The header badge answers "which build"; this tab answers the rest of
 * a bug report: the build it replaced and when, the browser's own build, and
 * the daemon on the other end, whose version is compared rather than assumed.
 */

import { api, el, cmd, view, VERSION, PRODUCT, browserInfo, ago, toast, showPanelError } from './ui.js';

/** Re-ask the worker for `about` at most this often; it changes once per update. */
const ABOUT_TTL_MS = 30_000;
const SEEN_KEY = 'g9.updateSeen';

let about = null;
let aboutAt = 0;
let aboutPending = null;
let browser = null;

export async function refresh({ force = false } = {}) {
  if (view.active !== 'about') return;
  if (!browser) browser = await browserInfo().catch(() => null);
  if ((force || !about || Date.now() - aboutAt > ABOUT_TTL_MS) && !aboutPending) {
    aboutPending = cmd({ cmd: 'about' })
      .then((res) => {
        about = res?.ok ? res : null;
      })
      .catch(() => {
        about = null;
      })
      .finally(() => {
        aboutAt = Date.now();
        aboutPending = null;
      });
    await aboutPending;
  }
  // Opening this tab is reading the update notice.
  markSeen(currentVersion());
  render();
}

/** Called by the session view when fresh daemon info arrives. */
export function noteDaemon() {
  if (view.active === 'about') render();
}

function currentVersion() {
  return about?.version ?? view.state?.version ?? VERSION;
}

function facts() {
  const state = view.state ?? {};
  const b = state.bridge ?? {};
  const version = currentVersion();
  const previousVersion = about?.previousVersion ?? state.previousVersion ?? null;
  const updatedAt = about?.updatedAt ?? state.updatedAt ?? null;
  const daemonVersion = b.daemonVersion ?? view.daemon?.version ?? null;
  const host = String(b.host || '127.0.0.1');
  // `::1` is bracketed in an address, exactly as the transport dials it.
  const address = `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${b.port || view.daemon?.port || 8765}`;
  return {
    version,
    previousVersion: previousVersion && previousVersion !== version ? previousVersion : null,
    updatedAt: Number.isFinite(updatedAt) || typeof updatedAt === 'string' ? updatedAt : null,
    browser: browserText(about?.browser),
    daemonVersion,
    daemonPid: b.daemonPid ?? view.daemon?.pid ?? null,
    connected: !!b.connected,
    connectedAt: b.connectedAt ?? null,
    address,
    lastError: b.problem ?? b.lastError ?? null,
    engineId: b.engineId ?? null,
    extensionId: api?.runtime?.id ?? null,
  };
}

/**
 * The worker's `about.browser` may be a name, an object, or the raw user-agent
 * string. A UA string names Edge as "Chrome/…" plus a suffix, so it is only the
 * fallback: the panel's own Client Hints read is more precise.
 */
function browserText(fromWorker) {
  if (fromWorker && typeof fromWorker === 'object') {
    const text = [fromWorker.name ?? fromWorker.brand ?? fromWorker.kind, fromWorker.version].filter(Boolean).join(' ');
    if (text) return text;
  }
  if (typeof fromWorker === 'string' && fromWorker && !/^Mozilla\//.test(fromWorker)) return fromWorker;
  if (browser) return [browser.name, browser.version, browser.platform ? `(${browser.platform})` : null].filter(Boolean).join(' ');
  return '…';
}

function when(t) {
  const ms = typeof t === 'string' ? Date.parse(t) : t;
  if (!Number.isFinite(ms)) return null;
  return `${new Date(ms).toLocaleString()} (${ago(ms)})`;
}

function render() {
  const f = facts();
  el.aboutVersion.textContent = `v${f.version}`;
  el.aboutUpdated.textContent = f.previousVersion
    ? `Updated from v${f.previousVersion}${f.updatedAt ? ` · ${ago(typeof f.updatedAt === 'string' ? Date.parse(f.updatedAt) : f.updatedAt)}` : ''}`
    : 'Installed fresh — no earlier version on record';

  el.aboutExt.textContent = `v${f.version}`;
  el.aboutPrev.textContent = f.previousVersion ? `v${f.previousVersion}` : '— (first install)';
  el.aboutWhen.textContent = when(f.updatedAt) ?? '—';
  el.aboutBrowser.textContent = f.browser;
  el.aboutDaemon.textContent = f.daemonVersion
    ? `g9d v${f.daemonVersion}${f.daemonPid ? ` · pid ${f.daemonPid}` : ''}`
    : f.connected
      ? 'connected (version not reported)'
      : 'not connected';
  el.aboutConn.textContent = f.connected
    ? `ws://${f.address}/g9 · connected${f.connectedAt ? ` ${ago(f.connectedAt)}` : ''}`
    : `offline — ${f.lastError ?? `waiting for the daemon on ${f.address}`}`;
  el.aboutEngine.textContent = f.engineId ?? '—';
  el.aboutExtId.textContent = f.extensionId ?? '—';

  const skew = f.connected && f.daemonVersion && f.daemonVersion !== f.version;
  el.aboutSkew.hidden = !skew;
  if (skew) {
    el.aboutSkew.textContent =
      `Version skew: daemon v${f.daemonVersion}, extension v${f.version}. Update the older one — G9 Desktop updates both.`;
  }
}

/** Plain text a person can paste into a bug report or a chat. */
function detailsText() {
  const f = facts();
  return [
    `${PRODUCT} v${f.version}` +
      (f.previousVersion ? ` (updated from v${f.previousVersion}${when(f.updatedAt) ? `, ${when(f.updatedAt)}` : ''})` : ''),
    `Browser: ${f.browser}`,
    `Daemon: ${f.daemonVersion ? `g9d v${f.daemonVersion}` : 'unknown'}${f.daemonPid ? ` · pid ${f.daemonPid}` : ''} · ` +
      (f.connected ? `connected on ws://${f.address}/g9` : `offline (${f.lastError ?? 'not reachable'})`),
    `Engine id: ${f.engineId ?? '—'} · extension id: ${f.extensionId ?? '—'}`,
    `User agent: ${globalThis.navigator?.userAgent ?? '—'}`,
  ].join('\n');
}

// ------------------------------------------------------------ update notice

/**
 * "Updated from vX to vY", once, at the top of the panel.
 *
 * Shown until dismissed, "what's new" is opened, or the About tab is visited —
 * any of which means the person has seen it. Remembered per version in this
 * page's own storage: it is a courtesy, and losing it costs one more notice.
 */
export function renderUpdateNote(state) {
  const prev = state?.previousVersion;
  const cur = state?.version ?? VERSION;
  const show = !!prev && prev !== cur && seenVersion() !== cur;
  el.updateNote.hidden = !show;
  if (show) el.updateText.textContent = `Updated from v${prev} to v${cur}.`;
}

function seenVersion() {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function markSeen(version) {
  try {
    // Called on every About poll; write only when it changes.
    if (version && seenVersion() !== version) localStorage.setItem(SEEN_KEY, version);
  } catch {
    /* storage blocked: the notice just shows again next time */
  }
  if (el.updateNote) el.updateNote.hidden = true;
}

function openWelcome({ updated }) {
  const url = api.runtime.getURL(`panel/welcome.html${updated ? '?updated=1' : ''}`);
  return api.tabs.create({ url }).catch((err) => showPanelError(`Could not open the welcome page: ${err?.message ?? err}`));
}

export function wire() {
  el.updateDismiss.addEventListener('click', () => markSeen(view.state?.version ?? VERSION));
  el.updateWhatsNew.addEventListener('click', () => {
    markSeen(view.state?.version ?? VERSION);
    openWelcome({ updated: true });
  });
  el.aboutWelcome.addEventListener('click', () => {
    const f = facts();
    openWelcome({ updated: !!f.previousVersion });
  });
  el.aboutCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(detailsText());
      toast('Version details copied');
    } catch (err) {
      showPanelError(`Could not copy: ${err?.message ?? err}`);
    }
  });
}
