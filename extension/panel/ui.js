/**
 * Shared panel plumbing: element access, messaging, the version, and the few
 * DOM helpers every view needs.
 *
 * ## Why the panel is several files
 *
 * It was one file of 657 lines covering three unrelated jobs, and v1.7.0 added
 * a fourth screen's worth of automation controls to it. Splitting afterwards is
 * strictly more expensive than splitting first — the new code would have been
 * written against whatever globals were nearest, and every one of those becomes
 * a thread to unpick.
 *
 * The split follows the tabs, because the tabs already follow the jobs:
 * session.js (is the daemon connected, which tab is the agent on, how does its
 * input look), automation.js (flows), issues.js (defects), about.js (which
 * version is this). This module is what they genuinely share.
 */

export const api = globalThis.browser ?? globalThis.chrome;

export const PRODUCT = 'G9 Browser Agent';

/**
 * The version of THIS extension, from its manifest — the one source.
 *
 * Shown in the header, the window title and the About tab. Every change bumps
 * it (repo rule), and a person reloading the extension checks it to know the
 * reload took: a version they can only find on edge://extensions is a version
 * nobody checks.
 */
export const VERSION = (() => {
  try {
    return api?.runtime?.getManifest?.().version ?? '';
  } catch {
    return '';
  }
})();

/**
 * The window title. The detached panel is a real window, and its title bar and
 * taskbar entry are the only part of it visible while it sits behind the page
 * under test — so the version is there, and so is a Stop, which is the one
 * state somebody glancing at the taskbar needs to know about.
 */
export function titleFor(state) {
  return `${state?.halted ? 'Stopped · ' : ''}${PRODUCT} v${VERSION}`;
}

export function setTitle(state) {
  const title = titleFor(state);
  if (document.title !== title) document.title = title;
}

/**
 * `el.foo` is `document.getElementById('foo')`, resolved late.
 *
 * Late resolution is what lets modules reference elements that a sibling module
 * may not have rendered yet, and what makes the load order of the files
 * irrelevant.
 */
export const el = new Proxy({}, { get: (_, id) => document.getElementById(String(id)) });

/** Send a command to the service worker. The command table is ARCHITECTURE_V2 §13. */
export function cmd(payload) {
  return api.runtime.sendMessage({ __g9cmd: true, ...payload });
}

export function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function toast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => {
    el.toast.hidden = true;
  }, 2400);
}

/** How long an action's error stays up when nobody dismisses it. */
const ACTION_ERROR_MS = 20_000;
let errorSource = null;
let errorTimer = null;

/**
 * Errors are shown, never swallowed.
 *
 * `refresh()` used to end in a bare `catch {}`. Any lasting failure left the
 * panel frozen mid-render, showing stale state about a live session — the worst
 * thing a trust surface can do.
 *
 * Two sources, cleared separately. A 'refresh' error (the panel cannot read
 * state) lasts exactly as long as the problem: the next good refresh clears it.
 * An 'action' error (Stop, the input level, a pull from the repo failed) is the
 * answer to something a person just pressed. Every button handler refreshes
 * right after it acts, and when one good refresh cleared EVERY error, a failed
 * Stop showed its reason for a few milliseconds — the error was reported and
 * never seen. So a refresh no longer clears an action's error: it stays until
 * it is clicked away, replaced, or ACTION_ERROR_MS passes.
 */
export function showPanelError(message, { source = 'action' } = {}) {
  const box = el.panelError;
  if (!box) return;
  if (!message) {
    if (errorSource !== source) return;
    clearTimeout(errorTimer);
    errorSource = null;
    box.hidden = true;
    return;
  }
  // A refresh hiccup must not overwrite the reason an action just failed.
  if (source === 'refresh' && errorSource === 'action' && !box.hidden) {
    console.error('[G9 panel]', message);
    return;
  }
  box.textContent = String(message);
  box.hidden = false;
  errorSource = source;
  clearTimeout(errorTimer);
  if (source === 'action') {
    box.title = 'Click to dismiss';
    errorTimer = setTimeout(() => showPanelError(null, { source: 'action' }), ACTION_ERROR_MS);
  } else {
    box.removeAttribute('title');
  }
  console.error('[G9 panel]', message);
}

/** Clicking an error dismisses it: it has been read. */
export function wireErrors() {
  el.panelError?.addEventListener('click', () => showPanelError(null, { source: errorSource ?? 'action' }));
}

export const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
};

export const bytes = (n) =>
  n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;

/** A row in one of the lists: name, subtitle, and a few actions. */
export function row(name, sub, actions, onOpen) {
  const li = document.createElement('li');
  const who = node('div', 'who');
  who.append(node('div', 'nm', name), node('div', 'sub', sub));
  if (onOpen) {
    who.style.cursor = 'pointer';
    who.addEventListener('click', onOpen);
  }
  const acts = node('div', 'acts');
  for (const [label, cls, fn, title] of actions) {
    const b = node('button', cls, label);
    b.type = 'button';
    if (title) {
      b.title = title;
      b.setAttribute('aria-label', title);
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    acts.append(b);
  }
  li.append(who, acts);
  return li;
}

export function fileToBase64(file) {
  return file.arrayBuffer().then((buf) => {
    const b = new Uint8Array(buf);
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < b.length; i += CHUNK) s += String.fromCharCode.apply(null, b.subarray(i, i + CHUNK));
    return btoa(s);
  });
}

/**
 * Which browser this is, by its own account.
 *
 * `userAgentData` names the product ("Microsoft Edge", "Google Chrome") where
 * the UA string only says "Chrome/…" for both; the high-entropy call adds the
 * full build number, which is what a bug report needs. The UA string is the
 * fallback for anything without Client Hints.
 */
export async function browserInfo() {
  const nav = globalThis.navigator ?? {};
  const ua = nav.userAgent ?? '';
  const pick = (list) =>
    (list ?? []).find((b) => !/not.?a.?brand|chromium/i.test(b.brand)) ??
    (list ?? []).find((b) => /chromium/i.test(b.brand)) ??
    null;
  try {
    const hi = await nav.userAgentData?.getHighEntropyValues?.(['fullVersionList', 'platform']);
    const b = pick(hi?.fullVersionList);
    if (b) return { name: b.brand, version: b.version, platform: hi.platform ?? null, ua };
  } catch {
    /* low-entropy brands below */
  }
  const b = pick(nav.userAgentData?.brands);
  if (b) return { name: b.brand, version: b.version, platform: nav.userAgentData?.platform ?? null, ua };
  const edge = /Edg\/([\d.]+)/.exec(ua);
  if (edge) return { name: 'Microsoft Edge', version: edge[1], platform: null, ua };
  const chrome = /Chrome\/([\d.]+)/.exec(ua);
  if (chrome) return { name: 'Chrome', version: chrome[1], platform: null, ua };
  return { name: 'Unknown browser', version: '', platform: null, ua };
}

/**
 * Which tab body is on screen.
 *
 * Shared mutable state, deliberately: all views poll, and all must skip their
 * poll when they are not visible. A module-local copy in each file would drift
 * the moment one of them forgot to update it.
 */
export const view = {
  active: 'session',
  /** Last state object the session view rendered — the Stop button and About read it. */
  state: null,
  /** Last `daemonInfo` answer, shared by the Session and About views. */
  daemon: null,
};
