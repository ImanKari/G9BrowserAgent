/**
 * Settings: the daemon's settings (settings.get / settings.set {patch}) as a form built from
 * SETTINGS_FIELDS, the raw JSON for anything the form does not know, the updater, the daemon
 * connection and this app's own facts.
 */

import { h, replace, icon } from '../lib/dom.js';
import { SETTINGS_FIELDS, readField, buildSettingsPatch } from '../lib/settings-form.js';
import { api, store, toast, toastError, viewHead, sectionHead, notConnected, busy, field, select, combo, confirm } from '../ui.js';

let root = null;
let formEl = null;
let rawEl = null;
let updatesEl = null;
let daemonEl = null;
let appEl = null;
let current = null; // last settings.get result

export function mount(el) {
  root = el;
  formEl = h('form', { class: 'surface', novalidate: true });
  rawEl = h('div', { class: 'surface pad stack' });
  updatesEl = h('div', { class: 'surface pad stack' });
  daemonEl = h('div', { class: 'surface pad stack' });
  appEl = h('div', { class: 'surface pad stack' });
  replace(el,
    viewHead('Settings', 'Defaults the daemon uses for new runs, stored in G9_HOME/settings.json. A run or an agent can still ask for something else.'),
    h('div', { class: 'section' }, formEl),
    h('div', { class: 'section' }, sectionHead('Updates'), updatesEl),
    h('div', { class: 'grid-2 section' },
      h('div', null, sectionHead('Daemon'), daemonEl),
      h('div', null, sectionHead('This app'), appEl)),
    h('div', { class: 'section' }, sectionHead('All daemon settings', 'Everything settings.get returns, including keys this form does not show.'), rawEl));
  lastKeys = {};
  load();
  if (store.state) update(store.state);
}

export function unmount() {
  root = null;
}

let wasConnected = false;
export function update(s) {
  if (!root) return;
  const now = s.connection?.status === 'connected';
  if (now && !wasConnected) load();
  wasConnected = now;
  // State snapshots arrive often; rebuild a section only when what it shows changed.
  const keys = {
    updates: JSON.stringify(s.update ?? {}),
    daemon: JSON.stringify([s.connection?.status, s.connection?.error, s.connection?.daemonVersion, s.connection?.daemonPid, s.connection?.id, s.app?.home]),
    app: JSON.stringify(s.app ?? {}),
  };
  if (keys.updates !== lastKeys.updates) renderUpdates(s);
  if (keys.daemon !== lastKeys.daemon) renderDaemon(s);
  if (keys.app !== lastKeys.app) renderApp(s);
  lastKeys = keys;
}
let lastKeys = {};

async function load() {
  if (!root) return;
  if (!store.connected) {
    replace(formEl, h('div', { class: 'pad' }, notConnected('The settings')));
    replace(rawEl, h('p', { class: 'muted' }, 'Shown once the daemon is connected.'));
    return;
  }
  try {
    current = await api.admin('settings.get');
    renderForm();
    renderRaw();
  } catch (err) {
    replace(formEl, h('p', { class: 'pad' }, `Could not read the settings: ${err.message}`));
  }
}

function renderForm() {
  const controls = new Map();
  const groups = new Map();
  for (const f of SETTINGS_FIELDS) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }
  const problem = h('p', { class: 'small', role: 'alert', style: { color: 'var(--stop)' }, hidden: true });
  const save = h('button', { type: 'submit', class: 'btn primary' }, 'Save');
  const revert = h('button', { type: 'button', class: 'btn' }, 'Revert');
  revert.addEventListener('click', () => renderForm());

  const sections = [...groups].map(([group, fields]) => h('div', { class: 'settings-group' },
    h('h2', null, group),
    h('div', { class: 'form-grid' }, fields.map((f) => {
      const { value, path, present } = readField(current, f);
      let control;
      if (f.type === 'boolean') control = h('input', { type: 'checkbox', checked: !!value });
      // A field that also takes a name (human input: a calibrated profile) is a combo, so a stored
      // name is shown and kept instead of being replaced by the first option on the next save.
      else if (f.type === 'select') control = f.custom ? combo(f.options, value) : select(f.options, value);
      else if (f.type === 'number') control = h('input', { type: 'number', value: String(value ?? ''), min: f.min, max: f.max, step: f.step ?? 1 });
      else control = h('input', { type: f.type === 'url' ? 'url' : 'text', value: String(value ?? ''), placeholder: f.type === 'url' ? 'https://updates.example.com/g9/' : '', autocomplete: 'off' });
      controls.set(f.key, control.input ?? control);
      const absent = present ? null : h('span', { class: 'absent' }, `Not reported by this daemon; saving writes "${path}".`);
      if (f.type === 'boolean') {
        return h('div', { class: 'field' }, h('label', { class: 'check' }, control, f.label), f.help ? h('span', { class: 'help' }, f.help) : null, absent);
      }
      return h('div', { class: f.type === 'url' ? 'span-2' : '' }, field(f.label, control, f.help, absent));
    }))));

  replace(formEl, ...sections, h('div', { class: 'settings-group row' }, save, revert, problem));
  formEl.onsubmit = (e) => {
    e.preventDefault();
    const values = {};
    for (const [key, control] of controls) values[key] = control.type === 'checkbox' ? control.checked : control.value;
    let built;
    try {
      built = buildSettingsPatch(current, values);
      problem.hidden = true;
    } catch (err) {
      problem.textContent = err.message;
      problem.hidden = false;
      return;
    }
    if (!built.changed.length) {
      toast('Nothing changed.');
      return;
    }
    busy(save, async () => {
      await api.admin('settings.set', { patch: built.patch });
      toast(`Saved ${built.changed.length} setting${built.changed.length === 1 ? '' : 's'}.`, 'ok');
      await load();
    });
  };
}

function renderRaw() {
  const pre = h('pre', { class: 'log-tail' }, JSON.stringify(current ?? {}, null, 2));
  const patch = h('textarea', { rows: 5, placeholder: '{ "evidence": { "maxRunMB": 800 } }', 'aria-label': 'JSON patch for settings.set' });
  const apply = h('button', { type: 'button', class: 'btn' }, 'Apply patch');
  apply.addEventListener('click', async () => {
    let obj;
    try {
      obj = JSON.parse(patch.value);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('The patch must be a JSON object.');
    } catch (err) {
      toastError(err);
      return;
    }
    const ok = await confirm({ title: 'Apply this patch?', body: h('pre', { class: 'diff' }, JSON.stringify(obj, null, 2)), confirmLabel: 'Apply' });
    if (!ok) return;
    busy(apply, async () => {
      await api.admin('settings.set', { patch: obj });
      toast('Patch applied.', 'ok');
      patch.value = '';
      await load();
    });
  });
  replace(rawEl, h('details', null, h('summary', null, 'Show the settings as JSON'), pre), field('Patch (merged into the settings)', patch), h('div', { class: 'row' }, apply));
}

function renderUpdates(s) {
  const u = s.update ?? {};
  const check = h('button', { type: 'button', class: 'btn' }, icon('refresh', { size: 15 }), 'Check now');
  check.disabled = ['dev', 'not-configured', 'invalid-url', 'checking', 'downloading', 'installing'].includes(u.status);
  check.addEventListener('click', () => busy(check, () => api.invoke('updater.check')));
  const install = h('button', { type: 'button', class: 'btn primary', hidden: !['downloaded', 'deferred'].includes(u.status) }, `Install ${u.version ?? ''}`.trim());
  install.addEventListener('click', () => busy(install, async () => {
    const r = await api.invoke('updater.install');
    if (r?.status === 'deferred') toast(`Waiting: ${(r.reasons ?? []).join('; ')}. It installs by itself when the daemon is idle.`);
  }));
  const help = u.status === 'not-configured'
    ? 'Set "Update server URL" above to an http(s) folder that holds latest.yml and G9-Setup-<version>.exe. Until then G9 does not check anywhere.'
    : u.status === 'dev'
      ? 'This is a development build (run from the repository). Installed builds update themselves.'
      : `Checks on start and every 6 hours${u.lastCheckAt ? `; last check ${new Date(u.lastCheckAt).toLocaleString()}` : ''}. Installing waits until no run is in progress.`;
  replace(updatesEl, h('p', null, h('strong', null, u.line ?? 'Updates: …')), h('p', { class: 'muted' }, help), h('div', { class: 'row' }, check, install));
}

function renderDaemon(s) {
  const c = s.connection ?? {};
  const reconnect = h('button', { type: 'button', class: 'btn' }, 'Reconnect');
  reconnect.addEventListener('click', () => api.invoke('reconnect').catch(toastError));
  const auto = h('input', { type: 'checkbox' });
  api.invoke('desktop.get').then((d) => { auto.checked = d.startDaemon !== false; }).catch(() => {});
  auto.addEventListener('change', () => api.invoke('desktop.patch', { startDaemon: auto.checked }).then(() => toast(auto.checked ? 'The app starts the daemon when it is not running.' : 'The app no longer starts the daemon; an agent\'s MCP shim still can.')).catch(toastError));
  const shutdown = h('button', { type: 'button', class: 'btn danger', disabled: c.status !== 'connected' }, 'Shut down daemon');
  shutdown.addEventListener('click', async () => {
    const ok = await confirm({
      title: 'Shut down the daemon?',
      body: "Every launched browser closes and every connected agent loses its tools until the daemon starts again. This app does not start it by itself afterwards: press Reconnect when you want it back (an agent's next call also starts it).",
      confirmLabel: 'Shut down',
      tone: 'danger',
    });
    if (ok) busy(shutdown, async () => {
      await api.admin('shutdown');
      toast('The daemon is shutting down. Press Reconnect to start it again.');
    });
  });
  replace(daemonEl,
    h('dl', { class: 'kv' },
      h('dt', null, 'State'), h('dd', null, c.status ?? '—', c.error ? h('span', { class: 'muted' }, ` (${c.error})`) : null),
      h('dt', null, 'Address'), h('dd', { class: 'mono' }, `ws://127.0.0.1:${s.app?.port ?? 8765}/g9`),
      h('dt', null, 'Version'), h('dd', null, c.daemonVersion ?? '—'),
      h('dt', null, 'Process'), h('dd', null, c.daemonPid ? `pid ${c.daemonPid}` : '—'),
      h('dt', null, 'This client'), h('dd', { class: 'mono' }, c.id ?? '—'),
      h('dt', null, 'Data folder'), h('dd', { class: 'mono' }, s.app?.home ?? '—')),
    h('label', { class: 'check' }, auto, 'Start the daemon when it is not running'),
    h('div', { class: 'row' }, reconnect, shutdown));
}

function renderApp(s) {
  const a = s.app ?? {};
  const open = (what, label) => {
    const b = h('button', { type: 'button', class: 'btn small' }, icon('folder', { size: 14 }), label);
    b.addEventListener('click', () => api.invoke('open', { what }).catch(toastError));
    return b;
  };
  const atLogin = h('input', { type: 'checkbox', disabled: true });
  const atLoginWhy = h('span', { class: 'help' });
  api.invoke('desktop.loginItem.get').then((li) => {
    atLogin.checked = !!li.openAtLogin;
    atLogin.disabled = !li.supported;
    atLoginWhy.textContent = li.supported ? 'Scheduled suites need the daemon; after a restart this is what starts it.' : li.reason;
  }).catch(() => {});
  atLogin.addEventListener('change', () => api.invoke('desktop.loginItem.set', { enabled: atLogin.checked })
    .then((li) => toast(li.openAtLogin ? 'G9 starts in the tray when you sign in.' : 'G9 no longer starts at sign-in.'))
    .catch((err) => {
      atLogin.checked = !atLogin.checked;
      toastError(err);
    }));
  replace(appEl,
    h('div', { class: 'field' }, h('label', { class: 'check' }, atLogin, 'Start G9 when I sign in (in the tray)'), atLoginWhy),
    h('dl', { class: 'kv' },
      h('dt', null, 'Version'), h('dd', null, a.version ?? '—'),
      h('dt', null, 'Build'), h('dd', null, a.packaged ? 'Installed' : 'Development (from the repository)'),
      h('dt', null, 'Signed in as'), h('dd', null, a.user ?? '—'),
      h('dt', null, 'Program files'), h('dd', { class: 'mono' }, a.resourceRoot ?? '—')),
    h('div', { class: 'row' }, open('logs', 'Logs'), open('home', 'Data folder'), open('extension', 'Extension folder')));
}
