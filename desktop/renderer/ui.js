/**
 * Shared renderer plumbing: the bridge to main, toasts, the confirm dialog, busy buttons,
 * a small store other views subscribe to. No framework; views re-render their own parts.
 */

import { h, replace, icon } from './lib/dom.js';
import { LEVELS, BROWSERS } from './lib/settings-form.js';

const bridge = window.g9;

export const api = {
  invoke: (op, args) => bridge.invoke(op, args),
  on: (topic, fn) => bridge.on(topic, fn),
  admin: (op, args = {}) => bridge.invoke('admin', { op, args }),
  call: (tool, args = {}) => bridge.invoke('call', { tool, args }),
};

// ------------------------------------------------------------------ store

const subscribers = new Set();
export const store = {
  state: null,
  set(next) {
    this.state = next;
    for (const fn of subscribers) {
      try {
        fn(next);
      } catch (err) {
        console.error(err);
      }
    }
  },
  subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },
  get connected() {
    return this.state?.connection?.status === 'connected';
  },
};

// ------------------------------------------------------------------ toasts

export function toast(text, tone = '', ms = 4200) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: ['toast', tone] }, text);
  box.append(el);
  setTimeout(() => el.remove(), tone === 'error' ? Math.max(ms, 7000) : ms);
  return el;
}

export function toastError(err) {
  return toast(String(err?.message ?? err), 'error');
}

// ------------------------------------------------------------------ modal

/**
 * A modal with a title, content nodes and buttons. Resolves the value of the button pressed
 * (Escape resolves the cancel value). Focus returns to where it was.
 * @param {{ title, content, buttons: Array<{ label, value, tone? }>, cancelValue? }} o
 */
let closeActiveModal = null;
export function modal({ title, content, buttons, cancelValue = null }) {
  const dlg = document.getElementById('modal');
  // One dialog element: a second question while one is open (a background prompt, a double
  // click) would make showModal() throw. The open one is answered with its cancel value first.
  closeActiveModal?.();
  const back = document.activeElement;
  replace(document.getElementById('modal-title'), title);
  replace(document.getElementById('modal-content'), ...(Array.isArray(content) ? content : [content]));
  const actions = document.getElementById('modal-actions');
  replace(actions);
  return new Promise((resolve) => {
    let settled = false;
    const onCancel = (e) => {
      e.preventDefault();
      done(cancelValue);
    };
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (closeActiveModal === cancelThis) closeActiveModal = null;
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      back?.focus?.();
      resolve(v);
    };
    const cancelThis = () => done(cancelValue);
    closeActiveModal = cancelThis;
    for (const b of buttons) {
      actions.append(h('button', { type: 'button', class: ['btn', b.tone], onclick: () => done(b.value) }, b.label));
    }
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
    const primary = actions.querySelector('.btn.primary, .btn.danger') ?? actions.lastElementChild;
    primary?.focus();
  });
}

export async function confirm({ title, body, confirmLabel = 'Continue', tone = 'primary', cancelLabel = 'Cancel' }) {
  const r = await modal({
    title,
    content: typeof body === 'string' ? h('p', null, body) : body,
    buttons: [{ label: cancelLabel, value: false }, { label: confirmLabel, value: true, tone }],
    cancelValue: false,
  });
  return r === true;
}

// ------------------------------------------------------------------ busy buttons

/** Disable a button with a spinner while `fn` runs; errors become a toast (and are returned). */
export async function busy(button, fn, { label = null } = {}) {
  const original = [...button.childNodes];
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  replace(button, h('span', { class: 'spinner', 'aria-hidden': 'true' }), label ?? button.textContent);
  try {
    return await fn();
  } catch (err) {
    toastError(err);
    return undefined;
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    replace(button, ...original);
  }
}

// ------------------------------------------------------------------ small building blocks

export function viewHead(title, sub, actions = []) {
  return h('div', { class: 'view-head' },
    h('div', null, h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null),
    actions.length ? h('div', { class: 'actions' }, actions) : null);
}

export function sectionHead(title, sub, actions = []) {
  return h('div', { class: 'section-head' },
    h('div', null, h('h2', null, title), sub ? h('p', { class: 'sub' }, sub) : null),
    actions.length ? h('div', { class: 'actions' }, actions) : null);
}

export function empty(title, text, actions = []) {
  return h('div', { class: 'empty' }, h('strong', null, title), text ? h('p', null, text) : null,
    actions.length ? h('div', { class: 'actions' }, actions) : null);
}

export function chip(text, tone = '', title = null) {
  return h('span', { class: ['chip', tone], title }, text);
}

export function notConnected(what) {
  const s = store.state?.connection;
  return empty(
    'The daemon is not connected',
    `${what} comes from the G9 daemon. ${s?.error ? `Last problem: ${s.error}` : 'It is starting or reconnecting.'}`,
    [h('button', { type: 'button', class: 'btn', onclick: () => api.invoke('reconnect').catch(toastError) }, icon('refresh', { size: 15 }), 'Reconnect')],
  );
}

export function field(label, control, help = null, extra = null) {
  // A combo is a wrapper; the label belongs to the input inside it.
  const target = control.input ?? control;
  const id = target.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  target.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, help ? h('span', { class: 'help' }, help) : null, extra);
}

export function select(options, value, props = {}) {
  return h('select', props, options.map((o) => {
    const opt = typeof o === 'object' ? o : { value: o, label: o };
    return h('option', { value: opt.value, selected: String(opt.value) === String(value) }, opt.label);
  }));
}

/**
 * A text input with suggestions (a <datalist>): for values that are usually one of a few words but
 * may be a name — human input takes a level or a calibrated profile's name (docs/HUMANIZE.md, Calibration). A plain
 * <select> would show a stored profile name as its first option and save that instead.
 */
let comboSeq = 0;
export function combo(options, value, props = {}) {
  const id = `combo-${++comboSeq}`;
  const list = h('datalist', { id }, options.map((o) => h('option', { value: o })));
  const input = h('input', { type: 'text', value: String(value ?? ''), autocomplete: 'off', spellcheck: false, ...props });
  input.setAttribute('list', id);
  // The datalist travels with the input: it must be in the document for the suggestions to show.
  const wrap = h('span', { class: 'combo' }, input, list);
  wrap.input = input;
  return wrap;
}

/**
 * Start an engine form (launch, schedule) at the daemon's defaults from Settings, so what the form
 * shows is what a run that does not say would use. A form the person already touched is left alone.
 * @param {{browser?, headless?, humanize?, stealth?}} ctl  the form's controls (humanize: the input)
 */
export async function prefillEngineDefaults(ctl, formEl) {
  formEl.oninput = () => { formEl.dataset.touched = '1'; };
  formEl.onchange = formEl.oninput;
  if (!store.connected) return;
  let s;
  try {
    s = await api.admin('settings.get');
  } catch {
    return;
  }
  if (formEl.dataset.touched === '1' || !s || typeof s !== 'object') return;
  if (ctl.browser && BROWSERS.includes(s.defaultBrowser)) ctl.browser.value = s.defaultBrowser;
  if (ctl.headless && typeof s.headless === 'boolean') ctl.headless.checked = s.headless;
  if (ctl.humanize && typeof s.humanize === 'string' && s.humanize.trim()) ctl.humanize.value = s.humanize;
  if (ctl.stealth && LEVELS.includes(s.stealth)) ctl.stealth.value = s.stealth;
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Switch views from inside a view (no import cycle with app.js). */
export function go(view, extra = {}) {
  window.dispatchEvent(new CustomEvent('g9:navigate', { detail: { view, ...extra } }));
}

/** A number badge in the navigation rail. */
export function setBadge(id, n, title) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = !n;
  el.textContent = String(n);
  el.title = title ?? '';
}
