/**
 * Shared panel plumbing: element access, messaging, and the few DOM helpers
 * every view needs.
 *
 * ## Why the panel is four files now
 *
 * It was one file of 657 lines covering three unrelated jobs, and v1.7.0 adds a
 * fourth screen's worth of automation controls to it. Splitting afterwards is
 * strictly more expensive than splitting first — the new code would have been
 * written against whatever globals were nearest, and every one of those becomes
 * a thread to unpick.
 *
 * The split follows the tabs, because the tabs already follow the jobs:
 * session.js (is the agent connected and what may it touch), automation.js
 * (flows), issues.js (defects). This module is what they genuinely share.
 */

export const api = globalThis.browser ?? globalThis.chrome;

/**
 * `el.foo` is `document.getElementById('foo')`, resolved late.
 *
 * Late resolution is what lets modules reference elements that a sibling module
 * may not have rendered yet, and what makes the load order of the four files
 * irrelevant.
 */
export const el = new Proxy({}, { get: (_, id) => document.getElementById(String(id)) });

/** Send a command to the service worker. */
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

/**
 * Errors are shown, never swallowed.
 *
 * `refresh()` used to end in a bare `catch {}`. Any lasting failure left the
 * panel frozen mid-render, showing stale state about a live session — the worst
 * thing a trust surface can do.
 */
export function showPanelError(message) {
  el.panelError.hidden = !message;
  if (message) {
    el.panelError.textContent = message;
    console.error('[G9 panel]', message);
  }
}

export const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
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
    if (title) b.title = title;
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
 * Which tab body is on screen.
 *
 * Shared mutable state, deliberately: all three views poll, and all three must
 * skip their poll when they are not visible. A module-local copy in each file
 * would drift the moment one of them forgot to update it.
 */
export const view = {
  active: 'session',
  /** Last state object the session view rendered — the Stop button reads it. */
  state: null,
};
