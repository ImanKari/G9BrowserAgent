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

/** "5m ago", "3d ago"; a date past a month, when "41d ago" stops meaning anything. */
export const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 31 * 86400) return `${Math.round(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
};

/**
 * A row's second line: items separated by "·". Each item carries its own
 * separator, and the line is shifted left by one separator's width inside a
 * clipping box, so an item that wraps to the start of a line loses its "·"
 * instead of starting the line with one.
 */
export function metaLine(items) {
  const outer = node('span', 'meta');
  const inner = node('span');
  for (const it of items) {
    if (it == null) continue;
    const cell = node('span', 'mi');
    cell.append(it);
    inner.append(cell);
  }
  outer.append(inner);
  return outer;
}

export const bytes = (n) =>
  n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;

// ------------------------------------------------------- shared components (v3)
//
// Every dynamic value on this page — a page title, a URL, a flow name, an issue
// title, a tag, an agent's name — comes from an arbitrary web page or a person,
// and this page runs with the extension's debugger privileges. So nothing here
// builds HTML from strings: elements, textContent and setAttribute only
// (setup/unit/panel.test.mjs scans for the alternatives).

/** A button. `title` doubles as the accessible name when the label is a glyph. */
export function btn(label, cls, onClick, { title, aria, key } = {}) {
  const b = node('button', cls || null, label);
  b.type = 'button';
  if (title) b.title = title;
  if (aria) b.setAttribute('aria-label', aria);
  if (key) b.dataset.k = key;
  if (onClick) {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick(e);
    });
  }
  return b;
}

export function chip(text, cls, title) {
  const c = node('span', `chip${cls ? ` ${cls}` : ''}`, text);
  if (title) c.title = title;
  return c;
}

/** A verdict or severity dot. Decorative: the word beside it carries the meaning. */
export function dot(kind, value) {
  const d = node('span', 'vd');
  d.dataset[kind] = value;
  d.setAttribute('aria-hidden', 'true');
  return d;
}

/**
 * Fill a <select> with [value, label] pairs, keeping `value` selected. Rebuilt
 * only when the options changed: a rebuild under an open dropdown closes it.
 */
export function setOptions(select, options, value) {
  if (!select) return;
  const key = JSON.stringify(options);
  if (select.dataset?.opts !== key) {
    select.replaceChildren?.(
      ...options.map(([v, label]) => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        return o;
      }),
    );
    if (select.dataset) select.dataset.opts = key;
  }
  select.value = value;
}

/** "abc…xyz": the start and the end of a long string both carry meaning (a path's leaf, a flow's id). */
export function middle(text, max) {
  const s = String(text ?? '');
  if (s.length <= max || max < 8) return s;
  const head = Math.ceil((max - 1) * 0.55);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}

/** 14:03 — the clock time a capture or a run started. */
export const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** A URL a link may point at: http(s) only, or null. */
export function safeHref(url) {
  try {
    const u = new URL(String(url));
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

/** A link that leaves the panel. Opens a new tab; the page it opens gets no handle back to this one. */
export function extLink(url, text) {
  const href = safeHref(url);
  if (!href) return null;
  const a = node('a', null, text ?? href);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/**
 * Per-viewer conveniences — filters, folded groups, a dismissed notice — in this
 * page's own storage. Storage can be blocked or empty; losing them costs a click.
 */
export const prefs = {
  get(key, fallback) {
    try {
      const raw = globalThis.localStorage?.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
      /* blocked: it just does not survive a reopen */
    }
  },
};

let groupSeq = 0;

/**
 * A collapsible group: a header button (aria-expanded) and its body. What the
 * person chose is remembered per `store` ({ key: open }), so a group stays as
 * they left it across polls and reopens; `open` is the default until they do.
 */
export function group({ store, key, title, count, level = 1, titleAttr, open: byDefault = true }) {
  const chosen = foldState(store);
  const open = key in chosen ? !!chosen[key] : byDefault;
  const wrap = node('section', `grp l${level}`);
  const bodyId = `grp-${++groupSeq}`;
  const head = node('button', 'grp-h');
  head.type = 'button';
  head.dataset.k = `grp:${key}`;
  head.setAttribute('aria-expanded', String(open));
  head.setAttribute('aria-controls', bodyId);
  if (titleAttr) head.title = titleAttr;
  const chev = node('span', 'chev', '▾');
  chev.setAttribute('aria-hidden', 'true');
  head.append(chev, node('span', 'grp-t', title), node('span', 'grp-n', count != null ? String(count) : ''));
  const body = node('div', 'grp-b');
  body.id = bodyId;
  body.hidden = !open;
  head.addEventListener('click', () => {
    const opening = head.getAttribute('aria-expanded') !== 'true';
    prefs.set(store, { ...foldState(store), [key]: opening });
    head.setAttribute('aria-expanded', String(opening));
    body.hidden = !opening;
  });
  wrap.append(head, body);
  return { wrap, body };
}

function foldState(store) {
  const v = prefs.get(store, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * Repaint a list without losing the keyboard: the focused control's `data-k`
 * is found again in the new DOM and focused. A poll that rebuilt the list under
 * someone's focus used to drop them back to the top of the page.
 */
export function keepFocus(container, paint) {
  const active = document.activeElement;
  const k = active && container?.contains?.(active) ? active.dataset?.k : null;
  // A field being typed in keeps what was typed, and where the caret was.
  const typing = k && /^(INPUT|TEXTAREA)$/.test(active.tagName ?? '')
    ? { value: active.value, start: active.selectionStart, end: active.selectionEnd }
    : null;
  paint();
  if (!k) return;
  const again = [...container.querySelectorAll('[data-k]')].find((n) => n.dataset.k === k);
  if (!again) return;
  if (typing && 'value' in again) {
    again.value = typing.value;
    try {
      again.setSelectionRange?.(typing.start, typing.end);
    } catch {
      /* not a text field */
    }
  }
  again.focus?.();
}

/** Copy text; say so, or say why not. */
export async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch (err) {
    showPanelError(`Could not copy: ${err?.message ?? err}`);
  }
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
  /** The tab agents act on, as the Session view last showed it ({tabId, title, url}) — Automation's "this site". */
  current: null,
};
