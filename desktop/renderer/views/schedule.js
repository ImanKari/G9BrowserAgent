/**
 * Schedule: suites the daemon runs by itself (daemon/scheduler.js) — daily at a time, or every
 * N minutes — through the runner on a launched engine, with no window and no one at the desk.
 * A locked Windows session is fine; a logged-off one runs nothing (docs/INSTALL.md, "Unattended machines").
 */

import { h, replace, icon } from '../lib/dom.js';
import { fmtDateTime } from '../lib/format.js';
import { LEVELS, BROWSERS } from '../lib/settings-form.js';
import { buildScheduleEntry, describeWhen, describeEngine, scheduleRows, nextDailyRun, entryEnv, lastResult, lastRunId } from '../lib/schedule.js';
import { api, store, toast, viewHead, sectionHead, empty, chip, notConnected, busy, field, select, combo, confirm, go, prefillEngineDefaults } from '../ui.js';

let root = null;
let listEl = null;
let formEl = null;
let entries = [];

export function mount(el) {
  root = el;
  listEl = h('div', { class: 'surface table-wrap' });
  formEl = h('form', { class: 'surface pad stack', novalidate: true });
  const refresh = h('button', { type: 'button', class: 'btn' }, icon('refresh', { size: 15 }), 'Refresh');
  refresh.addEventListener('click', () => busy(refresh, () => load(true)));
  replace(el,
    viewHead('Schedule', 'Suites the daemon runs on its own on a launched engine: no browser window, no one at the desk. The machine must stay signed in (a locked screen is fine).', [refresh]),
    h('div', { class: 'notice login-hint', hidden: true }, icon('alert', { size: 16 }),
      h('p', null, 'Schedules run while the G9 daemon runs. After a restart nothing starts it until G9 opens: turn on "Start G9 when I sign in" in Settings.',
        ' ', h('button', { type: 'button', class: 'btn small ghost', onclick: () => go('settings') }, 'Open Settings'))),
    h('div', { class: 'section' }, listEl),
    h('div', { class: 'section' }, sectionHead('Add a schedule'), formEl));
  renderForm();
  load(false);
}

export function unmount() {
  root = null;
}

let wasConnected = false;
export function update(s) {
  const now = s.connection?.status === 'connected';
  if (root && now && !wasConnected) load(false);
  wasConnected = now;
}

export function onEvent(e) {
  if (!root) return;
  if (e.topic === 'schedule' && Array.isArray(e.data?.entries)) {
    entries = e.data.entries;
    renderList();
  } else if (e.topic === 'run' && e.data?.kind === 'schedule') {
    load(false);
  }
}

async function load(announce) {
  if (!root) return;
  if (!store.connected) {
    replace(listEl, notConnected('The schedule'));
    return;
  }
  try {
    entries = scheduleRows(await api.admin('schedule.list'));
    renderList();
    if (announce) toast('Schedule refreshed.');
  } catch (err) {
    replace(listEl, h('p', { class: 'pad muted' }, `Could not read the schedule: ${err.message}`));
  }
}

/** Schedules run only while the daemon runs; say so when nothing will start it after a restart. */
async function loginHint() {
  const box = root?.querySelector('.login-hint');
  if (!box) return;
  try {
    const li = await api.invoke('desktop.loginItem.get');
    box.hidden = !entries.length || li.openAtLogin || !li.supported;
  } catch {
    box.hidden = true;
  }
}

function renderList() {
  loginHint();
  if (!entries.length) {
    replace(listEl, h('div', { class: 'pad' }, empty('Nothing is scheduled', 'Add a suite below. Scheduled runs appear in Runs like any other, and surprises land in Approvals.')));
    return;
  }
  replace(listEl, h('table', { class: 'grid' },
    // At 1100x720 the table is ~835px wide; the old widths left "What runs" ~130px, so a name like
    // "Billing every hour" (and its paused mark) was cut off. The name may now wrap instead.
    // "Last result" is 150px: at 128px a "Pass with warnings" chip (≈118px) inside a bordered button
    // was clipped by the cell under the Run now button (seen in the render check, 2026-09-22). The
    // chip is now the button itself (no border or padding around it) and ellipsizes past that width
    // ("Pass with warnings (exit 3)"), with the whole label in its tooltip.
    h('colgroup', null, h('col'), h('col', { style: { width: '104px' } }), h('col', { style: { width: '15%' } }), h('col', { style: { width: '118px' } }), h('col', { style: { width: '150px' } }), h('col', { style: { width: '150px' } })),
    h('thead', null, h('tr', null, ['What runs', 'When', 'Engine', 'Next run', 'Last result', ''].map((t) => h('th', null, t)))),
    h('tbody', null, entries.map((e) => {
      const id = e.id ?? e.scheduleId;
      const runNow = h('button', { type: 'button', class: 'btn small', disabled: !!e.running }, 'Run now');
      const remove = h('button', { type: 'button', class: 'btn small danger' }, 'Remove');
      runNow.addEventListener('click', () => busy(runNow, async () => {
        // The entry is named `entryId`, never `id`: `id` is the request id (DAEMON_PROTOCOL §6).
        const r = await api.admin('schedule.runNow', { entryId: id });
        toast(`${e.name ?? e.target} started${r?.runId ? ` as run ${r.runId}` : ''}. It appears in Runs.`);
        await load(false);
      }));
      remove.addEventListener('click', async () => {
        const ok = await confirm({ title: `Remove the schedule for ${e.name ?? e.target}?`, body: 'Runs already recorded stay in Runs.', confirmLabel: 'Remove', tone: 'danger' });
        if (ok) busy(remove, async () => {
          await api.admin('schedule.remove', { entryId: id });
          toast('Removed.');
          await load(false);
        });
      });
      const next = e.nextRunAt ?? (e.daily ?? e.at ? nextDailyRun(e.daily ?? e.at) : null);
      const env = entryEnv(e);
      const last = lastResult(e);
      const lastId = lastRunId(e);
      const lastChip = h('span', { class: ['chip', 'fit', last.tone], title: last.label }, h('span', { class: 'ellipsis' }, last.label));
      const lastCell = lastId
        ? h('button', { type: 'button', class: 'chip-link', title: `${last.label}: open run ${lastId}`, onclick: () => go('runs', { runId: lastId }) }, lastChip)
        : lastChip;
      return h('tr', null,
        h('td', { title: e.target },
          h('div', { class: 'wrap-anywhere' }, h('strong', null, e.name ?? e.target), e.enabled === false ? h('span', { class: 'muted' }, ' (paused)') : null),
          h('div', { class: 'muted small ellipsis' }, [e.name && e.name !== e.target ? e.target : null, env ? `on ${env}` : null].filter(Boolean).join(', ') || 'no environment')),
        h('td', null, describeWhen(e)),
        h('td', { class: 'ellipsis muted', title: describeEngine(e) }, describeEngine(e)),
        h('td', { class: 'muted nowrap' }, e.enabled === false ? 'Paused' : next ? fmtDateTime(next) : '—'),
        h('td', null, lastCell, e.lastRunAt ? h('div', { class: 'muted small' }, fmtDateTime(e.lastRunAt)) : null),
        h('td', { class: 'actions-cell' }, h('div', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } }, runNow, remove)));
    }))));
}

function renderForm() {
  const target = h('input', { type: 'text', name: 'target', placeholder: 'suite:smoke', autocomplete: 'off', required: true });
  const name = h('input', { type: 'text', name: 'name', placeholder: 'Nightly smoke (optional)', autocomplete: 'off' });
  const env = h('input', { type: 'text', name: 'env', placeholder: 'e.g. staging (optional)', autocomplete: 'off' });
  const daily = h('input', { type: 'radio', name: 'mode', value: 'daily', checked: true });
  const every = h('input', { type: 'radio', name: 'mode', value: 'every' });
  const at = h('input', { type: 'time', name: 'at', value: '06:00', 'aria-label': 'Time of day' });
  const minutes = h('input', { type: 'number', name: 'everyMinutes', min: 1, max: 44640, step: 1, value: 60, 'aria-label': 'Minutes between runs', style: { width: '90px' } });
  const browser = select(BROWSERS, 'auto', { name: 'browser' });
  const headless = h('input', { type: 'checkbox', name: 'headless', checked: true });
  const humanize = combo(LEVELS, 'human', { name: 'humanize' });
  const stealth = select(LEVELS, 'off', { name: 'stealth' });
  const profile = h('input', { type: 'text', name: 'profile', value: 'automation', autocomplete: 'off' });
  const add = h('button', { type: 'submit', class: 'btn primary' }, 'Add schedule');
  const problem = h('p', { class: 'small', role: 'alert', style: { color: 'var(--stop)' }, hidden: true });
  const syncMode = () => {
    at.disabled = !daily.checked;
    minutes.disabled = !every.checked;
  };
  daily.addEventListener('change', syncMode);
  every.addEventListener('change', syncMode);
  syncMode();

  replace(formEl,
    h('div', { class: 'form-grid' },
      field('What to run', target, 'suite:<name>, tag:<name>, all, or one flow id.'),
      field('Name', name),
      field('Environment', env, 'Recorded in the report (runner --env).'),
      field('Profile', profile),
      h('fieldset', { class: 'span-2', style: { border: 0, padding: 0, margin: 0 } },
        h('legend', { class: 'small', style: { color: 'var(--ink-2)', fontWeight: 500, marginBottom: '6px' } }, 'When'),
        h('div', { class: 'row' },
          h('label', { class: 'check' }, daily, 'Daily at'), at,
          h('span', { style: { width: '18px' } }),
          h('label', { class: 'check' }, every, 'Every'), minutes, h('span', { class: 'muted' }, 'minutes'))),
      field('Browser', browser),
      field('Human input', humanize),
      field('Stealth level', stealth),
      h('label', { class: 'check', style: { alignSelf: 'end', paddingBottom: '6px' } }, headless, 'Headless')),
    problem,
    h('div', { class: 'row' }, add));
  prefillEngineDefaults({ browser, headless, humanize: humanize.input, stealth }, formEl);

  formEl.onsubmit = (e) => {
    e.preventDefault();
    let entry;
    try {
      entry = buildScheduleEntry({
        target: target.value, name: name.value, env: env.value, mode: every.checked ? 'every' : 'daily', at: at.value, everyMinutes: minutes.value,
        browser: browser.value, headless: headless.checked, humanize: humanize.input.value, stealth: stealth.value, profile: profile.value,
      });
      problem.hidden = true;
    } catch (err) {
      problem.textContent = err.message;
      problem.hidden = false;
      return;
    }
    busy(add, async () => {
      await api.admin('schedule.add', { entry });
      toast(`Scheduled ${entry.name}: ${describeWhen(entry).toLowerCase()}.`, 'ok');
      target.value = '';
      name.value = '';
      await load(false);
    });
  };
}
