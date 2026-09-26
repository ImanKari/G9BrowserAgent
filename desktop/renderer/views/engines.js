/**
 * Engines: the browsers the daemon launched (Engine 2) and the extension engines (Engine 1),
 * a launch form, the browsers installed on this machine with the pinned Chrome for Testing, and
 * the profiles with a Warm button (open headed once to sign in).
 */

import { h, replace, icon } from '../lib/dom.js';
import { fmtAgo, shortUrl } from '../lib/format.js';
import { LEVELS, BROWSERS, isHumanizeValue } from '../lib/settings-form.js';
import { normalizeEngine, normalizeVersions, pickList, installedCft } from '../lib/engines.js';
import { api, toast, toastError, viewHead, sectionHead, empty, chip, notConnected, busy, field, select, combo, confirm, prefillEngineDefaults } from '../ui.js';

let root = null;
let runningEl = null;
let versionsEl = null;
let profilesEl = null;
let formEl = null;
let lastKey = '';
let profiles = [];
let lastState = null;
let profileSelect = null;

export function mount(el) {
  root = el;
  runningEl = h('div', { class: 'surface' });
  versionsEl = h('div', { class: 'surface table-wrap' });
  profilesEl = h('div', { class: 'surface table-wrap' });
  formEl = h('form', { class: 'surface pad stack', onsubmit: (e) => e.preventDefault() });
  const refresh = h('button', { type: 'button', class: 'btn' }, icon('refresh', { size: 15 }), 'Refresh');
  refresh.addEventListener('click', () => busy(refresh, () => loadAll(true)));
  replace(el,
    viewHead('Engines', 'Browsers the daemon launched for unattended runs, and the extension in your own browser. Launched engines run headless by default, so nothing on your desktop can pause them.', [refresh]),
    h('div', { class: 'grid-2' },
      h('div', { class: 'section' }, sectionHead('Running'), runningEl),
      h('div', { class: 'section' }, sectionHead('Launch an engine'), formEl)),
    h('div', { class: 'section' }, sectionHead('Browsers on this machine', 'Installed Edge and Chrome update themselves; Chrome for Testing is pinned so runs are repeatable.'), versionsEl),
    h('div', { class: 'section' }, sectionHead('Profiles', 'A profile is a browser user-data folder under G9_HOME. Open one headed once to sign in; unattended runs then start signed in.'), profilesEl));
  lastKey = '';
  renderForm();
  loadAll(false);
}

export function unmount() {
  root = null;
}

export function update(s) {
  lastState = s;
  if (!root) return;
  const key = JSON.stringify([s.connection?.status, s.engines, s.tabs.map((t) => [t.tabId, t.title, t.url, t.engineId])]);
  if (key === lastKey) return;
  const wasConnected = lastKey.includes('"connected"');
  lastKey = key;
  renderRunning(s);
  if (s.connection?.status === 'connected' && !wasConnected) loadAll(false);
}

async function loadAll(announce) {
  if (!lastState || lastState.connection?.status !== 'connected') {
    replace(versionsEl, notConnected('The browser list'));
    replace(profilesEl, h('p', { class: 'pad muted' }, 'Profiles are listed once the daemon is connected.'));
    return;
  }
  const [versions, profileList, engineList] = await Promise.allSettled([
    api.admin('engines.versions'),
    api.admin('profiles.list'),
    api.call('browser_engine', { action: 'list' }),
    // The tab titles and addresses under each engine come from the state's tab list, which only a
    // browser_tabs list refreshes: without it a tab opened since then showed as "Untitled", no URL.
    api.call('browser_tabs', { action: 'list' }),
  ]);
  if (!root) return;
  if (versions.status === 'fulfilled') renderVersions(normalizeVersions(versions.value));
  else replace(versionsEl, h('p', { class: 'pad muted' }, `Could not read browser versions: ${versions.reason?.message}`));
  if (profileList.status === 'fulfilled') {
    profiles = pickList(profileList.value, 'profiles', 'items').map((p) => (typeof p === 'string' ? { name: p } : p));
    renderProfiles();
    updateProfileOptions();
  } else {
    replace(profilesEl, h('p', { class: 'pad muted' }, `Could not list profiles: ${profileList.reason?.message}`));
  }
  if (engineList.status === 'fulfilled') {
    const rows = pickList(engineList.value, 'engines').map(normalizeEngine);
    if (rows.length || lastState.engines.length === 0) renderRunning({ ...lastState, engines: mergeEngines(lastState.engines, rows) });
  }
  if (announce) toast('Engines refreshed.');
}

function mergeEngines(a, b) {
  const map = new Map(a.map((e) => [e.engineId, e]));
  for (const e of b) map.set(e.engineId, { ...map.get(e.engineId), ...e });
  return [...map.values()];
}

function renderRunning(s) {
  if (s.connection?.status !== 'connected') {
    replace(runningEl, notConnected('The engine list'));
    return;
  }
  if (!s.engines.length) {
    replace(runningEl, h('div', { class: 'pad' }, empty('No engine is running', 'Launch one with the form, or let an agent do it with browser_engine action:"launch". The extension appears here too once your browser connects.')));
    return;
  }
  const tabsById = new Map(s.tabs.map((t) => [t.tabId, t]));
  replace(runningEl, ...s.engines.map((e) => {
    const launched = e.kind === 'launched';
    const stop = launched ? h('button', { type: 'button', class: 'btn small danger' }, 'Stop') : null;
    stop?.addEventListener('click', async () => {
      const ok = await confirm({
        title: `Stop ${e.engineId}?`,
        body: `The browser closes with its ${e.tabs.length} tab(s). An agent working in one of them gets an error on its next call.`,
        confirmLabel: 'Stop engine',
        tone: 'danger',
      });
      if (ok) busy(stop, async () => {
        await api.call('browser_engine', { action: 'stop', engineId: e.engineId });
        toast(`${e.engineId} stopped.`);
      });
    });
    // The extension (Engine 1) is never stopped from here — it is the person's own browser. What the
    // app can do is refresh G9_HOME/extension and ask it to reload (runtime.reload, sent by the
    // daemon only when no relayed call is in flight; DAEMON_PROTOCOL §5).
    const reload = launched ? null : h('button', { type: 'button', class: ['btn', 'small', e.versionMismatch ? 'primary' : ''] }, e.versionMismatch ? 'Update and reload' : 'Reload');
    reload?.addEventListener('click', () => busy(reload, async () => {
      if (e.versionMismatch) {
        const r = await api.invoke('wizard.installExtension');
        toast(`Extension folder updated to ${r.version ?? 'this version'}; ${r.reloaded ? 'the extension reloads once nothing is running in it (an unsaved recording or an issue video waits for it)' : 'reload it on the extensions page of your browser'}.`, 'ok', 7000);
      } else {
        const r = await api.admin('extension.reload');
        toast(r?.reloadSent ? 'The extension reloads once nothing is running in it — no agent call, no unsaved recording, no issue video.' : 'No extension is connected to reload.');
      }
    }));
    const title = launched
      ? `${label(e.browser)} ${e.browserVersion ?? e.version ?? ''}`.trim()
      : `Extension${e.version ? ` ${e.version}` : ''}${e.browser ? ` in ${label(e.browser)}${e.browserVersion ? ` ${e.browserVersion}` : ''}` : ''}`;
    return h('div', { class: 'engine' },
      h('div', { class: 'engine-head' },
        h('h3', null, title),
        chip(launched ? (e.headless === false ? 'Headed' : 'Headless') : 'Your browser', launched ? 'accent' : 'live'),
        h('span', { class: 'mono muted' }, e.engineId),
        h('span', { style: { marginLeft: 'auto' } }, stop ?? reload)),
      e.versionMismatch ? h('p', { class: 'small', style: { color: 'var(--warn)', marginTop: '4px' } }, e.versionMismatch) : null,
      h('div', { class: 'engine-meta' },
        e.profile ? h('span', null, `Profile ${e.profile}`) : null,
        e.pid ? h('span', null, `pid ${e.pid}`) : null,
        e.startedAt ? h('span', null, `started ${fmtAgo(e.startedAt)}`) : null,
        h('span', null, `${e.tabs.length} tab${e.tabs.length === 1 ? '' : 's'}`)),
      e.contexts.length ? h('div', { class: 'row', style: { marginTop: '6px' } }, e.contexts.map((c) => chip(
        // A launched engine's context id is Chromium's 32-hex browserContextId: shortened in the chip
        // (the render check showed it filling the card), whole in the tooltip.
        [`context ${shortId(c.contextId)}`, c.humanize && `input ${c.humanize}`, c.stealth && c.stealth !== 'off' && `stealth ${c.stealth}`, c.locale, c.timezone, c.proxy && 'proxy'].filter(Boolean).join(', '),
        '', [`Context ${c.contextId}`, c.proxy ? `Proxy ${c.proxy}` : null].filter(Boolean).join('\n'),
      ))) : null,
      e.tabs.length ? h('div', { class: 'engine-tabs' }, e.tabs.slice(0, 12).map((id) => {
        const t = tabsById.get(id);
        return h('div', null, chip(`#${id}`, 'tab-chip'), h('span', { class: 'ellipsis' }, t?.title || 'Untitled'), h('span', { class: 'muted ellipsis' }, t?.url ? shortUrl(t.url, 48) : ''));
      }), e.tabs.length > 12 ? h('div', { class: 'muted' }, `and ${e.tabs.length - 12} more`) : null) : null);
  }));
}

function label(kind) {
  return { edge: 'Edge', chrome: 'Chrome', cft: 'Chrome for Testing', auto: 'Browser' }[kind] ?? (kind || 'Browser');
}

/** A long id as its head and tail ("7A0993…CD91"); short ids (ctx-1) stay whole. */
function shortId(id) {
  const s = String(id ?? '');
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

function renderForm() {
  if (!formEl) return;
  const browser = select(BROWSERS.map((b) => ({ value: b, label: b === 'auto' ? 'Automatic' : label(b) })), 'auto', { name: 'browser', title: 'Automatic: the pinned Chrome for Testing when installed, else Edge, else Chrome' });
  const headless = h('input', { type: 'checkbox', name: 'headless', checked: true });
  const profileNames = [...new Set(['automation', ...profiles.map((p) => p.name)])];
  const profile = select(profileNames, 'automation', { name: 'profile' });
  profileSelect = profile;
  const humanize = combo(LEVELS, 'human', { name: 'humanize' });
  const stealth = select(LEVELS, 'off', { name: 'stealth' });
  const locale = h('input', { type: 'text', name: 'locale', placeholder: 'e.g. en-US', autocomplete: 'off' });
  const timezone = h('input', { type: 'text', name: 'timezone', placeholder: 'e.g. Europe/Berlin', autocomplete: 'off' });
  const proxy = h('input', { type: 'text', name: 'proxy', placeholder: 'e.g. http://proxy:8080', autocomplete: 'off' });
  const launch = h('button', { type: 'submit', class: 'btn primary' }, 'Launch engine');
  replace(formEl,
    h('div', { class: 'form-grid' },
      field('Browser', browser),
      field('Profile', profile),
      field('Human input', humanize, 'A level, or the name of a calibrated profile. "off" sends input instantly.'),
      field('Stealth level', stealth, '"stealth" disables console capture.'),
      field('Locale', locale),
      field('Time zone', timezone),
      h('div', { class: 'span-2' }, field('Proxy', proxy)),
      h('label', { class: 'check span-2' }, headless, 'Headless (no window; nothing on the desktop can pause it)')),
    h('div', { class: 'row' }, launch));
  prefillEngineDefaults({ browser, headless, humanize: humanize.input, stealth }, formEl);
  formEl.onsubmit = (e) => {
    e.preventDefault();
    const args = {
      action: 'launch',
      browser: browser.value,
      headless: headless.checked,
      profile: profile.value,
      humanize: humanize.input.value.trim() || 'human',
      stealth: stealth.value,
    };
    if (!isHumanizeValue(args.humanize)) {
      toastError(new Error('Human input: off, human, stealth, or the name of a calibrated profile.'));
      return;
    }
    for (const [k, input] of Object.entries({ locale, timezone, proxy })) if (input.value.trim()) args[k] = input.value.trim();
    busy(launch, async () => {
      const r = await api.call('browser_engine', args);
      toast(`Launched ${r?.engineId ?? 'the engine'}${r?.browser ? ` (${label(r.browser?.kind ?? r.browser)} ${r.version ?? r.browser?.version ?? ''})` : ''}.`, 'ok');
    }, { label: 'Launching…' });
  };
}

function renderVersions(v) {
  const rows = v.browsers.map((b) => h('tr', null,
    h('td', null, label(b.kind)),
    h('td', { class: 'mono' }, b.version ?? '—'),
    h('td', { class: 'mono muted ellipsis', title: b.path ?? '' }, b.path ?? '—'),
    h('td', null)));
  const pinned = v.cft.pinned;
  const install = h('button', { type: 'button', class: 'btn small primary' }, v.cft.pinnedInstalled ? 'Reinstall' : `Install ${pinned ?? ''}`.trim());
  install.addEventListener('click', () => busy(install, async () => {
    toast('Downloading Chrome for Testing. This can take a few minutes; the app stays usable.');
    const r = await api.admin('engines.installCft', pinned ? { version: pinned } : {});
    const got = installedCft(r, pinned);
    toast(`Chrome for Testing ${got.version ?? ''} is installed${got.path ? ` at ${got.path}` : ''}.`.replace(/\s+/g, ' '), 'ok');
    loadAll(false);
  }, { label: 'Installing…' }));
  rows.push(h('tr', null,
    h('td', null, 'Chrome for Testing'),
    h('td', { class: 'mono' }, pinned ? `${pinned} (pinned)` : 'no pinned version'),
    h('td', { class: 'muted' }, v.cft.installed.length ? `Installed: ${v.cft.installed.map((c) => c.version).join(', ')}` : 'Not installed'),
    h('td', { class: 'actions-cell' }, pinned ? install : null)));
  replace(versionsEl, h('table', { class: 'grid' },
    // The last column holds "Install 153.0.8010.52" (a small button, ~150px): at 120px it was cut off
    // at the table's edge in the 1100x720 check. The path column gives way instead (it ellipsizes).
    h('colgroup', null, h('col', { style: { width: '170px' } }), h('col', { style: { width: '190px' } }), h('col'), h('col', { style: { width: '180px' } })),
    h('thead', null, h('tr', null, h('th', null, 'Browser'), h('th', null, 'Version'), h('th', null, 'Where'), h('th', null, ''))),
    h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 4, class: 'muted' }, 'No Edge or Chrome found.')))));
}

function renderProfiles() {
  if (!profiles.length) {
    replace(profilesEl, h('div', { class: 'pad' }, empty('No profiles yet', 'The automation profile is created the first time an engine launches, or from Setup.')));
    return;
  }
  replace(profilesEl, h('table', { class: 'grid' },
    h('colgroup', null, h('col', { style: { width: '170px' } }), h('col'), h('col', { style: { width: '360px' } })),
    h('thead', null, h('tr', null, h('th', null, 'Profile'), h('th', null, 'Folder'), h('th', null, 'Warm: sign in once'))),
    h('tbody', null, profiles.map((p) => {
      const url = h('input', { type: 'url', placeholder: 'https://your-app.example/login', 'aria-label': `Sign-in page for ${p.name}` });
      const warm = h('button', { type: 'button', class: 'btn small', title: 'Open this profile in a visible browser window once, to sign in; close the window when done' }, 'Warm (open headed)');
      warm.addEventListener('click', () => busy(warm, async () => {
        await api.admin('profiles.warm', { name: p.name, url: url.value.trim() || undefined });
        toast(`A browser window opened with the ${p.name} profile. Sign in, then close that window.`);
      }));
      return h('tr', null,
        h('td', null, h('strong', null, p.name)),
        h('td', { class: 'mono muted ellipsis', title: p.dir ?? '' }, p.dir ?? '—'),
        h('td', null, h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, url, warm)));
    }))));
}

/** Keep the launch form's input; only the profile choices change when profiles are listed. */
function updateProfileOptions() {
  if (!profileSelect) return;
  const current = profileSelect.value;
  const names = [...new Set(['automation', ...profiles.map((p) => p.name)])];
  replace(profileSelect, ...names.map((n) => h('option', { value: n, selected: n === current }, n)));
}

export function onEvent() {
  /* the running list follows state snapshots; versions and profiles reload on Refresh */
}
