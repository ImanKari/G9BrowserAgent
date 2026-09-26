/**
 * Setup: the first-run wizard (docs/INSTALL.md, "The setup wizard"), five steps, each re-runnable. The main process does the
 * work (lib/wizard.mjs); this view shows what it found, asks before anything is changed, and
 * shows the install log.
 */

import { h, replace, icon } from '../lib/dom.js';
import { api, store, toast, toastError, viewHead, chip, busy, confirm, modal, field } from '../ui.js';
import { installedCft } from '../lib/engines.js';

let root = null;
let stepsEl = null;
let logEl = null;
const bodies = {};

const STEP_TEXT = {
  browsers: 'Engines launch a real Edge or Chrome that is already installed. Chrome for Testing is optional: a pinned build that never updates under you, so today\'s run and next month\'s run use the same browser.',
  profile: 'Unattended runs use a separate browser profile, never your own. Open it once, sign in to the app you test, and close the window; later runs start signed in.',
  policies: 'Your own browser stops drawing a window that is covered, locked or on another desktop, and then quietly drops input. These per-user policies keep it drawing. Minimized windows still stop; nothing can change that.',
  mcp: 'Your AI clients start G9 through a small command. This step writes it into their settings, after a backup, and never overwrites a different entry without showing you the difference.',
  extension: 'The extension lets agents work in the browser you are already using. Add it once; later updates reach it by themselves.',
};

export function mount(el, opts = {}) {
  root = el;
  stepsEl = h('ol', { class: 'steps' });
  logEl = h('pre', { class: 'log-tail' }, '');
  replace(el,
    viewHead('Setup', opts.firstRun
      ? 'Welcome to G9. Five steps make this machine ready; each one can be run again later from here.'
      : 'Five steps that make this machine ready. Run any of them again at any time.'),
    h('div', { class: 'surface pad' }, stepsEl),
    h('div', { class: 'section' }, h('details', null, h('summary', null, 'Install log (G9_HOME/logs/install.log)'), logEl)));
  renderSteps(store.state);
  loadAll();
}

export function unmount() {
  root = null;
}

let lastWizardKey = '';
let wasConnected = false;
export function update(s) {
  if (!root) return;
  const key = JSON.stringify(s.wizard);
  if (key !== lastWizardKey) {
    lastWizardKey = key;
    for (const st of s.wizard?.steps ?? []) {
      const li = stepsEl.querySelector(`[data-step="${st.id}"]`);
      if (li) setStepState(li, st.outcome);
    }
  }
  const now = s.connection?.status === 'connected';
  if (now && !wasConnected) loadAll();
  wasConnected = now;
}

export function onEvent() {}

function setStepState(li, outcome) {
  li.classList.toggle('done', !!outcome?.ok);
  li.classList.toggle('skipped', !!outcome?.skipped && !outcome?.ok);
  const status = li.querySelector('.step-status');
  if (status) replace(status, outcome?.ok ? chip('Done', 'ok') : outcome?.skipped ? chip('Skipped') : chip('To do', 'accent'));
  const done = li.querySelector('.mark-done');
  const skip = li.querySelector('.mark-skip');
  if (done) done.hidden = !!outcome?.ok;
  if (skip) skip.hidden = !!outcome?.ok || !!outcome?.skipped;
}

function renderSteps(s) {
  const steps = s?.wizard?.steps ?? [];
  replace(stepsEl, ...steps.map((st) => {
    bodies[st.id] = h('div', { class: 'step-content' }, h('p', { class: 'muted' }, h('span', { class: 'spinner' }), ' Checking…'));
    const markDone = h('button', { type: 'button', class: 'btn small ghost mark-done' }, 'Mark as done');
    markDone.addEventListener('click', () => api.invoke('wizard.mark', { step: st.id, ok: true, summary: 'Marked done by hand.' }).catch(toastError));
    const skip = h('button', { type: 'button', class: 'btn small ghost mark-skip' }, 'Skip');
    skip.addEventListener('click', () => api.invoke('wizard.mark', { step: st.id, ok: false, skipped: true, summary: 'Skipped.' }).catch(toastError));
    const li = h('li', { class: 'step', dataset: { step: st.id } },
      h('span', { class: 'step-num', 'aria-hidden': 'true' }),
      h('div', { class: 'step-body' },
        h('div', { class: 'row' }, h('h2', null, st.title), h('span', { class: 'step-status' }), h('span', { style: { marginLeft: 'auto' } }), markDone, skip),
        h('p', null, STEP_TEXT[st.id] ?? st.summary),
        bodies[st.id]));
    setStepState(li, st.outcome);
    return li;
  }));
}

async function loadAll() {
  await Promise.allSettled([loadBrowsers(), loadProfile(), loadPolicies(), loadMcp(), loadExtension()]);
  loadLog();
}

async function loadLog() {
  try {
    const lines = await api.invoke('wizard.log');
    logEl.textContent = lines.length ? lines.join('\n') : 'Nothing logged yet.';
  } catch {
    /* the log is a convenience */
  }
}

const mark = (step, ok, summary) => api.invoke('wizard.mark', { step, ok, summary }).catch(() => {});

// ------------------------------------------------------------------ 1. browsers

async function loadBrowsers() {
  const body = bodies.browsers;
  if (!body) return;
  let r;
  try {
    r = await api.invoke('wizard.browsers');
  } catch (err) {
    replace(body, h('p', null, err.message));
    return;
  }
  const install = h('button', { type: 'button', class: 'btn primary' }, r.cft.pinnedInstalled ? 'Chrome for Testing is installed' : `Install Chrome for Testing ${r.cft.pinned ?? ''}`.trim());
  install.disabled = r.cft.pinnedInstalled || !r.cft.pinned || !store.connected;
  install.addEventListener('click', () => busy(install, async () => {
    toast('Downloading Chrome for Testing (about 205 MB). You can keep going with the other steps.');
    const got = installedCft(await api.invoke('wizard.installCft', { version: r.cft.pinned }), r.cft.pinned);
    toast(`Chrome for Testing ${got.version ?? ''} is installed.`.replace(/\s+/g, ' '), 'ok');
    await mark('browsers', true, `Browsers: ${r.browsers.map((b) => b.kind).join(', ') || 'none'}; CfT ${got.version} installed.`);
    loadBrowsers();
  }, { label: 'Downloading…' }));
  const found = r.browsers.length;
  replace(body,
    found
      ? h('table', { class: 'grid' },
        h('thead', null, h('tr', null, h('th', null, 'Browser'), h('th', null, 'Version'), h('th', null, 'Where'))),
        h('tbody', null, r.browsers.map((b) => h('tr', null, h('td', null, b.kind === 'edge' ? 'Microsoft Edge' : 'Google Chrome'), h('td', { class: 'mono' }, b.version ?? '—'), h('td', { class: 'mono muted ellipsis', title: b.path }, b.path)))))
      : h('p', null, 'Neither Edge nor Chrome was found. Install Chrome for Testing below; it is enough for launched engines (the extension still needs Edge or Chrome).'),
    h('div', { class: 'row' },
      install,
      r.cft.pinned ? h('span', { class: 'muted small' }, `Pinned version ${r.cft.pinned}${r.cft.installed.length ? `; installed: ${r.cft.installed.map((c) => c.version).join(', ')}` : ''}`) : h('span', { class: 'muted small' }, store.connected ? 'The daemon reported no pinned version.' : 'Connect the daemon to see the pinned Chrome for Testing.'),
      r.source === 'desktop' ? chip('Found without the daemon', '', r.daemonError ?? 'The daemon is not connected') : null));
  if (found && !store.state?.wizard?.steps?.find((s) => s.id === 'browsers')?.outcome?.ok) {
    mark('browsers', true, `Found ${r.browsers.map((b) => `${b.kind} ${b.version ?? ''}`.trim()).join(', ')}.`);
  }
}

// ------------------------------------------------------------------ 2. profile

async function loadProfile() {
  const body = bodies.profile;
  if (!body) return;
  if (!store.connected) {
    replace(body, h('p', { class: 'muted' }, 'This step needs the daemon. It starts by itself; the step fills in when it is connected.'));
    return;
  }
  let r;
  try {
    r = await api.invoke('wizard.profile');
  } catch (err) {
    replace(body, h('p', null, err.message));
    return;
  }
  const url = h('input', { type: 'url', placeholder: 'https://your-app.example/login (optional)', style: { minWidth: '360px' } });
  const open = h('button', { type: 'button', class: 'btn primary' }, 'Open the automation profile');
  open.addEventListener('click', () => busy(open, async () => {
    await api.invoke('wizard.warm', { name: 'automation', url: url.value.trim() });
    toast('A browser window opened with the automation profile. Sign in, then close that window.', '', 9000);
    await mark('profile', true, `Opened for sign-in${url.value.trim() ? ` at ${url.value.trim()}` : ''}.`);
  }));
  replace(body,
    h('p', null, r.automation ? `The automation profile exists${r.automation.dir ? ` at ${r.automation.dir}` : ''}.` : 'The automation profile is created when you open it.'),
    h('div', { class: 'row' }, field('Sign-in page', url), h('div', { style: { alignSelf: 'flex-end' } }, open)),
    h('p', { class: 'muted small' }, 'Profiles copied to another machine lose their sign-ins (the browser encrypts cookies per machine), so do this once on every machine that runs unattended.'));
}

// ------------------------------------------------------------------ 3. policies

async function loadPolicies() {
  const body = bodies.policies;
  if (!body) return;
  let r;
  try {
    r = await api.invoke('wizard.policies');
  } catch (err) {
    replace(body, h('p', null, err.message));
    return;
  }
  const apply = h('button', { type: 'button', class: 'btn primary' }, r.appliedCount === r.total ? 'Apply again' : 'Apply policies');
  const undo = h('button', { type: 'button', class: 'btn', disabled: !r.canUndo }, 'Undo');
  apply.addEventListener('click', () => runPolicies('apply', apply));
  undo.addEventListener('click', () => runPolicies('undo', undo));
  const rows = r.rows.map((row) => h('tr', null,
    h('td', null, row.browser === 'edge' ? 'Edge' : 'Chrome'),
    h('td', { title: `${row.why}${row.browser === 'chrome' && row.chrome ? `\nRead by Chrome ${row.chrome} and later.` : ''}` }, h('span', { class: 'mono' }, row.name)),
    h('td', { class: 'mono' }, row.current?.exists ? String(row.current.data) : h('span', { class: 'muted' }, 'not set')),
    h('td', { class: 'mono' }, String(row.desired)),
    h('td', null, row.applied ? chip('Set', 'ok') : chip('Not set'))));
  replace(body,
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('colgroup', null, h('col', { style: { width: '80px' } }), h('col'), h('col', { style: { width: '100px' } }), h('col', { style: { width: '80px' } }), h('col', { style: { width: '90px' } })),
      h('thead', null, h('tr', null, h('th', null, 'Browser'), h('th', null, 'Policy (hover for why)'), h('th', null, 'Now'), h('th', null, 'G9 sets'), h('th', null, ''))),
      h('tbody', null, rows))),
    h('div', { class: 'row' }, apply, undo, h('span', { class: 'muted small' }, `${r.appliedCount} of ${r.total} set. Written under HKCU only; Undo restores exactly what was there before.`)),
    h('p', { class: 'muted small' }, 'A browser ignores a policy name it does not know. edge://policy and chrome://policy show which ones took effect after the browser restarts.'),
    h('details', null, h('summary', null, 'The exact commands'), h('pre', { class: 'diff' }, r.rows.map((x) => x.command).join('\n'))));
  if (r.appliedCount === r.total) mark('policies', true, 'All policies are set.');
}

async function runPolicies(which, button) {
  if (which === 'apply') {
    const ok = await confirm({
      title: 'Apply the browser policies?',
      body: 'G9 records the current values first, then writes the list under HKCU\\Software\\Policies for Edge and Chrome. Restart the browser for them to take effect. Undo puts back exactly what was there.',
      confirmLabel: 'Apply',
    });
    if (!ok) return;
  }
  const op = which === 'apply' ? 'wizard.applyPolicies' : 'wizard.undoPolicies';
  let r = await busy(button, () => api.invoke(op, { elevate: false }));
  if (!r) return;
  if (!r.ok && r.needsElevation) {
    const go = await modal({
      title: 'Administrator approval needed',
      content: [
        h('p', null, 'On this machine Windows lets only administrators write HKCU\\Software\\Policies, even for your own account. One Windows prompt runs the same HKCU-only commands with approval.'),
        h('p', { class: 'muted' }, 'Approve it with your own account. If someone else\'s administrator account approves, the values land in their profile and G9 will tell you.'),
      ],
      buttons: [{ label: 'Cancel', value: false }, { label: 'Show the Windows prompt', value: true, tone: 'primary' }],
      cancelValue: false,
    });
    if (!go) {
      loadPolicies();
      return;
    }
    r = await busy(button, () => api.invoke(op, { elevate: true }));
    if (!r) return;
  }
  toast(r.message, r.ok ? 'ok' : 'error', 8000);
  loadPolicies();
  loadLog();
}

// ------------------------------------------------------------------ 4. MCP clients

const STATUS = {
  create: ['Not configured yet', ''],
  add: ['Not registered', ''],
  same: ['Registered', 'ok'],
  different: ['Different entry', 'warn'],
  invalid: ['Cannot read the file', 'fail'],
};

async function loadMcp() {
  const body = bodies.mcp;
  if (!body) return;
  let r;
  try {
    r = await api.invoke('wizard.mcp');
  } catch (err) {
    replace(body, h('p', null, err.message));
    return;
  }
  const rows = r.clients.map((c) => {
    const [label, tone] = STATUS[c.status] ?? [c.status, ''];
    let action;
    if (c.status === 'same') {
      action = h('button', { type: 'button', class: 'btn small ghost' }, 'Remove');
      action.addEventListener('click', async () => {
        if (await confirm({ title: `Remove G9 from ${c.label}?`, body: `The g9-browser entry is removed from ${c.file}. A backup is kept next to it.`, confirmLabel: 'Remove', tone: 'danger' })) {
          busy(action, async () => {
            let res = await api.invoke('wizard.removeMcp', { client: c.id });
            if (res.needsConfirm === 'comments') {
              if (!(await confirm({ title: `${c.label}'s settings file has comments`, body: res.message, confirmLabel: 'Remove anyway' }))) return;
              res = await api.invoke('wizard.removeMcp', { client: c.id, confirmDropComments: true });
            }
            toast(res.message, res.ok ? '' : 'error');
            loadMcp();
            loadLog();
          });
        }
      });
    } else if (c.status === 'invalid') {
      action = h('button', { type: 'button', class: 'btn small' }, 'Show the entry');
      action.addEventListener('click', () => modal({
        title: `Add G9 to ${c.label} by hand`,
        content: [h('p', null, c.note), h('pre', { class: 'diff' }, JSON.stringify({ [c.client.key]: { 'g9-browser': c.entry } }, null, 2))],
        buttons: [{ label: 'Close', value: true, tone: 'primary' }],
      }));
    } else {
      action = h('button', { type: 'button', class: ['btn', 'small', c.status === 'different' ? '' : 'primary'] }, c.status === 'different' ? 'Review and replace' : 'Register');
      action.addEventListener('click', () => register(c, action));
    }
    return h('tr', null,
      h('td', null, h('strong', null, c.label), c.installed ? null : h('div', { class: 'muted small' }, 'not detected')),
      h('td', { class: 'mono muted ellipsis', title: c.file }, c.file),
      h('td', null, chip(label, tone, c.note ?? null)),
      h('td', { class: 'actions-cell' }, action));
  });
  replace(body,
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('colgroup', null, h('col', { style: { width: '150px' } }), h('col'), h('col', { style: { width: '140px' } }), h('col', { style: { width: '150px' } })),
      h('thead', null, h('tr', null, h('th', null, 'Client'), h('th', null, 'Settings file'), h('th', null, 'State'), h('th', null, ''))),
      h('tbody', null, rows))),
    h('details', null, h('summary', null, 'The entry G9 writes'), h('pre', { class: 'diff' }, JSON.stringify({ 'g9-browser': r.entry }, null, 2))));
  if (r.clients.some((c) => c.status === 'same')) mark('mcp', true, `Registered in ${r.clients.filter((c) => c.status === 'same').map((c) => c.label).join(', ')}.`);
}

async function register(c, button, flags = {}) {
  if (c.status === 'different' && !flags.confirmReplace) {
    const ok = await modal({
      title: `Replace the g9-browser entry in ${c.label}?`,
      content: [
        h('p', null, c.note ?? 'A different entry with the same name is configured.'),
        h('pre', { class: 'diff' }, c.diff.map((d) => h('div', { class: d.op === '-' ? 'del' : d.op === '+' ? 'add' : '' }, `${d.op} ${d.line}`))),
        h('p', { class: 'muted small' }, `A backup of ${c.file} is written first.`),
      ],
      buttons: [{ label: 'Keep the current entry', value: false }, { label: 'Replace', value: true, tone: 'primary' }],
      cancelValue: false,
    });
    if (!ok) return;
    flags.confirmReplace = true;
  }
  const r = await busy(button, () => api.invoke('wizard.registerMcp', { client: c.id, ...flags }));
  if (!r) return;
  if (r.needsConfirm === 'comments') {
    const ok = await confirm({ title: `${c.label}'s settings file has comments`, body: r.message, confirmLabel: 'Write it anyway' });
    if (ok) return register(c, button, { ...flags, confirmDropComments: true });
    return;
  }
  if (r.needsConfirm === 'replace') {
    return register({ ...c, status: 'different', diff: r.diff ?? c.diff, note: r.message }, button, { ...flags, confirmReplace: false });
  }
  toast(r.message, r.ok ? 'ok' : 'error', 8000);
  loadMcp();
  loadLog();
}

// ------------------------------------------------------------------ 5. extension

async function loadExtension() {
  const body = bodies.extension;
  if (!body) return;
  let r;
  try {
    r = await api.invoke('wizard.extension');
  } catch (err) {
    replace(body, h('p', null, err.message));
    return;
  }
  const pathBox = h('div', { class: 'path-box' }, h('code', null, r.target));
  const install = h('button', { type: 'button', class: 'btn primary' }, r.installedVersion ? 'Refresh the extension folder' : 'Prepare the extension folder');
  install.addEventListener('click', () => busy(install, async () => {
    const res = await api.invoke('wizard.installExtension');
    replace(pathBox, h('code', null, res.path), res.clipboard ? chip('Copied to the clipboard', 'ok') : null);
    toast(res.via === 'desktop' ? 'Folder ready (copied by the app: the daemon was not connected).' : 'Folder ready. The path is on the clipboard.', 'ok');
    loadExtension();
  }));
  const openers = ['edge', 'chrome'].map((kind) => {
    const b = r.browsers.find((x) => x.kind === kind);
    const btn = h('button', { type: 'button', class: 'btn', disabled: !b }, icon('external', { size: 14 }), `Open ${kind === 'edge' ? 'Edge' : 'Chrome'} extensions`);
    btn.title = b ? `${b.path} ${b.page}` : `${kind === 'edge' ? 'Edge' : 'Chrome'} was not found`;
    btn.addEventListener('click', () => busy(btn, async () => {
      await api.invoke('wizard.openExtensionsPage', { kind });
      toast('The extensions page is open in your browser. Follow the three clicks below.');
      await mark('extension', true, `Opened ${kind} extensions page; folder ${r.target}.`);
    }));
    return btn;
  });
  const primary = r.browsers[0]?.kind ?? 'edge';
  replace(body,
    h('div', { class: 'row' }, install,
      r.installedVersion ? chip(`Installed ${r.installedVersion}`, r.installedVersion === r.sourceVersion ? 'ok' : 'warn', r.installedVersion === r.sourceVersion ? 'Matches this app' : `This app carries ${r.sourceVersion}; refresh the folder`) : chip('Not prepared yet')),
    pathBox,
    h('div', { class: 'row' }, ...openers),
    h('ol', { class: 'clicks' }, r.clicks[primary].map((c) => h('li', null, c))),
    h('p', { class: 'muted small' }, 'Keep this folder where it is: the browser remembers the extension by its folder, and G9 updates the files in place.'));
}
