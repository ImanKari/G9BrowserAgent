/**
 * The G9 desktop window: the shell (navigation, connection bar, Stop control, notices) and the
 * router. Each view lives in views/<name>.js and exports { mount(el), unmount?(), update?(state) }.
 *
 * Everything the page knows arrives from main as a 'state' snapshot or an 'event'; everything it
 * does goes back through window.g9.invoke — the page has no Node, no network and no daemon socket.
 */

import { h, replace, icon } from './lib/dom.js';
import { api, store, toast, toastError, confirm } from './ui.js';
import * as agents from './views/agents.js';
import * as engines from './views/engines.js';
import * as watch from './views/watch.js';
import * as runs from './views/runs.js';
import * as approvals from './views/approvals.js';
import * as schedule from './views/schedule.js';
import * as settings from './views/settings.js';
import * as setup from './views/setup.js';

const VIEWS = { agents, engines, watch, runs, approvals, schedule, settings, setup };
let current = null;
const mounted = new Set();

// ------------------------------------------------------------------ navigation

function navigate(name, opts = {}) {
  if (!VIEWS[name]) name = 'agents';
  if (current === name && !opts.force) return;
  if (current) {
    VIEWS[current].unmount?.();
    document.getElementById(`view-${current}`).hidden = true;
  }
  current = name;
  const el = document.getElementById(`view-${name}`);
  el.hidden = false;
  for (const b of document.querySelectorAll('#nav button')) {
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  document.title = `G9 — ${el.dataset.title}`;
  VIEWS[name].mount(el, opts);
  mounted.add(name);
  if (store.state) VIEWS[name].update?.(store.state);
  api.invoke('desktop.patch', { lastView: name }).catch(() => {});
  if (!opts.keepFocus) document.getElementById('main').focus({ preventScroll: true });
}
window.addEventListener('g9:navigate', (e) => navigate(e.detail?.view, e.detail ?? {}));

for (const b of document.querySelectorAll('#nav button')) {
  b.prepend(icon(b.dataset.view, { size: 17 }));
  b.addEventListener('click', () => navigate(b.dataset.view));
}

// ------------------------------------------------------------------ the bar

const bar = document.getElementById('bar');
const conn = document.getElementById('conn');
const connText = document.getElementById('conn-text');
const reconnectBtn = document.getElementById('reconnect');
const stopBtn = document.getElementById('stop-all');
const resumeBtn = document.getElementById('resume-all');
const haltText = document.getElementById('halt-text');

function connectionLine(s, port) {
  const c = s.connection ?? {};
  switch (c.status) {
    case 'connected':
      return `Daemon ${c.daemonVersion ?? ''} connected on port ${port}${c.daemonPid ? `, pid ${c.daemonPid}` : ''}`.replace(/\s+/g, ' ');
    case 'starting':
      return 'Starting the daemon…';
    case 'connecting':
    case 'idle':
      return `Connecting to the daemon on port ${port}…`;
    case 'waiting': {
      const secs = c.nextRetryAt ? Math.max(0, Math.ceil((c.nextRetryAt - Date.now()) / 1000)) : null;
      return `Daemon not reachable. ${c.error ?? ''} ${secs !== null ? `Retrying in ${secs} s.` : ''}`.replace(/\s+/g, ' ').trim();
    }
    case 'foreign':
      return c.error ?? `Port ${port} is used by another program.`;
    case 'refused':
      return `The daemon refused this app: ${c.error ?? 'no reason given'}`;
    case 'stopped':
      return 'Disconnected.';
    default:
      return 'Connecting…';
  }
}

function renderBar(s) {
  const status = s.connection?.status ?? 'idle';
  conn.dataset.status = status;
  connText.textContent = connectionLine(s, s.app?.port ?? 8765);
  connText.title = connText.textContent;
  reconnectBtn.hidden = !['waiting', 'foreign', 'refused', 'stopped'].includes(status);
  const connected = status === 'connected';
  const halted = !!s.halted?.global;
  bar.classList.toggle('halted', connected && halted);
  stopBtn.hidden = connected && halted;
  stopBtn.disabled = !connected;
  resumeBtn.hidden = !(connected && halted);
  haltText.hidden = !(connected && halted);
  haltText.textContent = halted ? `Stopped${s.halted?.by ? ` from the ${s.halted.by}` : ''}: every agent is halted` : '';
}

stopBtn.addEventListener('click', async () => {
  try {
    await api.admin('halt');
    toast('Stopped. Every agent is halted until you press Resume.');
  } catch (err) {
    toastError(err);
  }
});
resumeBtn.addEventListener('click', async () => {
  const ok = await confirm({
    title: 'Resume every agent?',
    body: 'Agents continue from where they were stopped. Anything they had already dispatched before the stop is not undone.',
    confirmLabel: 'Resume',
  });
  if (!ok) return;
  try {
    await api.admin('resume');
    toast('Resumed.');
  } catch (err) {
    toastError(err);
  }
});
reconnectBtn.addEventListener('click', () => api.invoke('reconnect').catch(toastError));
// The retry countdown is the only thing in the bar that changes without a new state.
setInterval(() => {
  if (store.state?.connection?.status === 'waiting') renderBar(store.state);
}, 1000);

// ------------------------------------------------------------------ notices + counters

function renderNotices(s) {
  const box = document.getElementById('notices');
  const items = [];
  if (s.daemonMismatch) {
    // Only an older daemon of this install is restarted; anything else is reported and left alone
    // (main.mjs / daemon-launch.mjs mismatchAction).
    const m = s.daemonMismatch;
    const why = (m.reasons ?? []).join('; ');
    items.push({
      tone: 'warn',
      text: m.kind && m.kind !== 'restart'
        ? why || `The daemon is version ${m.daemonVersion}; this app is ${m.appVersion}. G9 leaves it running.`
        : `The daemon is version ${m.daemonVersion}; this app is ${m.appVersion}. It restarts with the new version once it is idle (${why}).`,
    });
  }
  for (const n of s.notices ?? []) items.push(n);
  replace(box, ...items.map((n) => h('div', { class: ['notice', n.tone === 'info' ? 'info' : ''] }, icon(n.tone === 'info' ? 'check' : 'alert', { size: 16 }), h('p', null, n.text))));
}

function renderCounters(s) {
  const setupCount = document.getElementById('setup-count');
  const open = (s.wizard?.steps ?? []).filter((st) => !st.outcome?.ok && !st.outcome?.skipped).length;
  setupCount.hidden = !!s.wizard?.completedAt || open === 0;
  setupCount.textContent = String(open);
  setupCount.title = `${open} setup step${open === 1 ? '' : 's'} left`;
  const line = document.getElementById('update-line');
  line.textContent = s.update?.line ?? 'Updates: …';
  document.getElementById('app-version').textContent = s.app?.version ?? '';
}

// ------------------------------------------------------------------ state from main

function apply(s) {
  store.set(s);
  renderBar(s);
  renderNotices(s);
  renderCounters(s);
  if (current) VIEWS[current].update?.(s);
}

api.on('state', apply);
api.on('updater', (u) => {
  if (!store.state) return;
  apply({ ...store.state, update: u });
});
api.on('navigate', (d) => navigate(d?.view, { ...d, force: false }));
api.on('event', (e) => {
  for (const name of mounted) VIEWS[name].onEvent?.(e);
  if (e.topic === 'run') approvals.refreshCount().catch(() => {});
});

document.getElementById('update-line').addEventListener('click', () => navigate('settings'));

// ------------------------------------------------------------------ start

(async () => {
  try {
    const s = await api.invoke('state');
    apply(s);
    const desk = await api.invoke('desktop.get').catch(() => ({}));
    const first = !s.wizard?.completedAt;
    navigate(first ? 'setup' : desk.lastView ?? 'agents', { keepFocus: true });
    approvals.refreshCount().catch(() => {});
  } catch (err) {
    toastError(err);
    navigate('agents');
  }
})();

// Refresh the approvals badge whenever the connection comes (back) up.
let wasConnected = false;
store.subscribe((s) => {
  const now = s.connection?.status === 'connected';
  if (now && !wasConnected) approvals.refreshCount().catch(() => {});
  wasConnected = now;
});
