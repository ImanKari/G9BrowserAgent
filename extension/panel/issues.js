/**
 * The Issues view: capture evidence while the bug is still on screen.
 *
 * The capture-first ordering is the whole design and is documented at its call
 * site below — a form held open while the page moves on underneath it collects
 * a screenshot of the aftermath.
 *
 * ## v3 (V3_UX_PLAN part C)
 *
 * The index now carries site, severity, tags and what evidence each issue holds
 * (lib/store.js issueIndexEntry), so the list is grouped by site then status,
 * shows severity and evidence at a glance, and filters on all of it — the QA
 * sees whether an issue is worth opening without opening it. The editor is
 * today's, with tags added; whatever it saves is what the list shows on return.
 */

import { siteOf, displayUrl } from '../lib/sites.js';
import {
  el, cmd, node, btn, chip, dot, toast, showPanelError, ago, bytes, fileToBase64, view, setOptions, prefs, group,
  keepFocus, metaLine,
} from './ui.js';

let openIssueId = null;
let saveTimer = null;
let videoState = { recording: false };

const GLYPH = { screenshot: '🖼', video: '🎞', evidence: '📄', file: '📎' };

const FILTER_KEY = 'g9.issueFilters';
const FOLD_KEY = 'g9.issueFold';
const EMPTY_FILTER = { site: '', status: '', severity: '', tag: '', q: '' };
let filter = { ...EMPTY_FILTER, ...prefs.get(FILTER_KEY, {}) };
let lastList = [];
let paintedKey = null;

const STATUSES = ['open', 'filed', 'closed'];
const STATUS_NAMES = { open: 'Open', filed: 'Filed', closed: 'Closed' };
const SEVERITIES = ['blocker', 'major', 'normal', 'minor'];
const SEVERITY_NAMES = { blocker: 'Blocker', major: 'Major', normal: 'Normal', minor: 'Minor' };
const NO_SITE = 'none';

// An entry written before v3 has no severity: it reads as "normal" (plan C1).
const severityOf = (i) => (SEVERITIES.includes(i?.severity) ? i.severity : 'normal');
const statusOf = (i) => (typeof i?.status === 'string' && i.status ? i.status : 'open');
const siteKeyOf = (i) => i?.site ?? siteOf(i?.url) ?? NO_SITE;
const tagsOf = (i) => (Array.isArray(i?.tags) ? i.tags.filter((t) => typeof t === 'string') : []);

function siteLabel(key) {
  if (key === NO_SITE) return 'No page URL';
  const d = displayUrl(key);
  return d.origin?.startsWith('https://') ? d.host : (d.origin ?? key);
}

/** Pure; exported for the unit test. Which issues the filter lets through. */
export function applyIssueFilter(list, f = filter) {
  const q = String(f.q ?? '').trim().toLowerCase();
  return (Array.isArray(list) ? list : []).filter((i) => {
    if (f.site && siteKeyOf(i) !== f.site) return false;
    if (f.status && statusOf(i) !== f.status) return false;
    if (f.severity && severityOf(i) !== f.severity) return false;
    if (f.tag && !tagsOf(i).includes(f.tag)) return false;
    if (q) {
      const hay = [i.title, i.filedAs, i.url, ...tagsOf(i)].filter((v) => typeof v === 'string').join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * The evidence an issue holds, as chips (C2): "shot 2", "video", "file 1",
 * "console", "network", "DOM". Pure; exported for the unit test.
 */
export function evidenceChips(e) {
  if (!e || typeof e !== 'object') return [];
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const out = [];
  if (n(e.screenshots)) out.push([`shot ${n(e.screenshots)}`, `${n(e.screenshots)} screenshot${n(e.screenshots) === 1 ? '' : 's'}`]);
  if (n(e.videos)) out.push([n(e.videos) > 1 ? `video ${n(e.videos)}` : 'video', `${n(e.videos)} tab recording${n(e.videos) === 1 ? '' : 's'}`]);
  if (n(e.files)) out.push([`file ${n(e.files)}`, `${n(e.files)} attached file${n(e.files) === 1 ? '' : 's'}`]);
  if (e.console) out.push(['console', 'Console errors captured']);
  if (e.network) out.push(['network', 'Failed requests captured']);
  if (e.dom) out.push(['DOM', 'The page fragment around the focused element']);
  return out;
}

function setFilter(patch) {
  filter = { ...filter, ...patch };
  prefs.set(FILTER_KEY, filter);
  paintedKey = null;
  renderList(lastList);
}

export async function refresh() {
  if (view.active !== 'issues' || openIssueId) return;
  let res;
  try {
    res = await cmd({ cmd: 'issueList' });
  } catch (err) {
    el.issueUsage.textContent = 'refresh failed';
    return showPanelError('Issue refresh failed: ' + (err?.message ?? err), { source: 'refresh' });
  }
  if (!res?.ok) return showPanelError(res?.error ?? 'Issue refresh failed.', { source: 'refresh' });

  el.issueUsage.textContent = res.usage?.attachments ? `${res.usage.attachmentMB}MB of evidence` : '';
  renderList(res.issues ?? []);
}

function renderList(list) {
  lastList = Array.isArray(list) ? list : [];
  el.issueEmpty.hidden = lastList.length > 0;
  el.issueCount.textContent = lastList.length
    ? `${lastList.filter((i) => statusOf(i) === 'open').length} open · ${lastList.length} total`
    : '';
  paintFilters(lastList);
  const shown = applyIssueFilter(lastList);

  const key = JSON.stringify([
    shown.map((i) => [i.id, i.title, i.status, i.severity, i.tags, i.filedAs, i.evidence, i.site, i.url, i.updatedAt]),
    filter, Math.floor(Date.now() / 60_000), lastList.length,
  ]);
  if (key === paintedKey) return;
  paintedKey = key;
  keepFocus(el.issueList, () => paintGroups(shown));
}

function paintFilters(list) {
  el.issueFilters.hidden = list.length === 0;
  const distinct = (fn) => {
    const m = new Map();
    for (const i of list) for (const k of [].concat(fn(i))) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const sites = distinct(siteKeyOf);
  if (filter.site && !sites.has(filter.site)) sites.set(filter.site, 0);
  const siteOpts = [...sites.keys()].sort((a, b) => (a === NO_SITE) - (b === NO_SITE) || siteLabel(a).localeCompare(siteLabel(b)));
  setOptions(el.iSite, [['', `All sites (${list.length})`], ...siteOpts.map((k) => [k, `${siteLabel(k)} (${sites.get(k)})`])], filter.site);

  const statuses = distinct(statusOf);
  const statusOpts = [...STATUSES, ...[...statuses.keys()].filter((s) => !STATUSES.includes(s))];
  setOptions(el.iStatus, [['', 'Any status'], ...statusOpts.map((s) => [s, `${STATUS_NAMES[s] ?? s}${statuses.get(s) ? ` (${statuses.get(s)})` : ''}`])], filter.status);

  setOptions(el.iSeverity, [['', 'Any severity'], ...SEVERITIES.map((s) => [s, SEVERITY_NAMES[s]])], filter.severity);

  const tags = distinct(tagsOf);
  if (filter.tag) tags.set(filter.tag, tags.get(filter.tag) ?? 0);
  setOptions(el.iTag, [['', 'All tags'], ...[...tags.keys()].sort().map((t) => [t, t])], filter.tag);
  el.iTag.hidden = tags.size === 0;
  if (document.activeElement !== el.iSearch) el.iSearch.value = filter.q ?? '';
}

/** Site, then status (open, filed, closed). Closed starts folded: it is the record, not the work. */
function paintGroups(shown) {
  if (!lastList.length) {
    el.issueList.replaceChildren();
    return;
  }
  if (!shown.length) {
    const empty = node('div', 'empty');
    empty.append(node('p', null, 'No issues match these filters.'),
      btn('Clear filters', 'link', () => setFilter({ ...EMPTY_FILTER }), { key: 'clearfilters' }));
    el.issueList.replaceChildren(empty);
    return;
  }
  const bySite = new Map();
  for (const i of shown) {
    const k = siteKeyOf(i);
    if (!bySite.has(k)) bySite.set(k, []);
    bySite.get(k).push(i);
  }
  const openCount = (rows) => rows.filter((i) => statusOf(i) === 'open').length;
  const sites = [...bySite.keys()].sort((a, b) =>
    (a === NO_SITE) - (b === NO_SITE) || openCount(bySite.get(b)) - openCount(bySite.get(a)) || siteLabel(a).localeCompare(siteLabel(b)));

  const out = [];
  for (const site of sites) {
    const rows = bySite.get(site);
    const g = group({ store: FOLD_KEY, key: `site:${site}`, title: siteLabel(site), count: rows.length, level: 1, titleAttr: site === NO_SITE ? '' : site });
    const byStatus = new Map();
    for (const i of rows) {
      const s = statusOf(i);
      if (!byStatus.has(s)) byStatus.set(s, []);
      byStatus.get(s).push(i);
    }
    const order = [...STATUSES.filter((s) => byStatus.has(s)), ...[...byStatus.keys()].filter((s) => !STATUSES.includes(s))];
    for (const status of order) {
      const items = byStatus.get(status).sort((a, b) =>
        SEVERITIES.indexOf(severityOf(a)) - SEVERITIES.indexOf(severityOf(b)) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
      const sg = group({
        store: FOLD_KEY, key: `status:${site}|${status}`, title: STATUS_NAMES[status] ?? status, count: items.length,
        level: 2, open: status !== 'closed',
      });
      for (const i of items) sg.body.append(issueRow(i));
      g.body.append(sg.wrap);
    }
    out.push(g.wrap);
  }
  el.issueList.replaceChildren(...out);
}

function issueRow(i) {
  const sev = severityOf(i);
  const wrap = node('div', 'issue');
  const main = btn(null, 'issue-open', () => openIssue(i.id), { key: `open:${i.id}` });
  main.title = [i.title, i.url].filter(Boolean).join('\n');
  const l1 = node('span', 'l1');
  l1.append(dot('sev', sev), node('span', 'nm', i.title || '(untitled)'));
  const s = node('span', 'vt', SEVERITY_NAMES[sev]);
  s.dataset.sev = sev;
  const chips = node('span', 'chips');
  for (const [text, title] of evidenceChips(i.evidence)) chips.append(chip(text, null, title));
  for (const t of tagsOf(i).slice(0, 3)) chips.append(chip(t, 'acc', `tag ${t}`));
  main.append(l1, metaLine([
    s,
    statusOf(i),
    ago(i.createdAt ?? i.updatedAt ?? Date.now()),
    i.filedAs ? node('span', 'mono', String(i.filedAs)) : null,
    chips.childNodes.length ? chips : null,
  ]));

  const side = node('div', 'side');
  side.append(btn('✕', 'icon', async () => {
    await cmd({ cmd: 'issueDelete', id: i.id });
    paintedKey = null;
    refresh();
  }, { title: 'Delete this issue', aria: `Delete the issue "${i.title || '(untitled)'}"`, key: `del:${i.id}` }));
  wrap.append(main, side);
  return wrap;
}

async function openIssue(id, { focusTitle = false } = {}) {
  const res = await cmd({ cmd: 'issueGet', id });
  if (!res?.ok) return showPanelError(res?.error ?? 'Could not open that issue.');

  openIssueId = id;
  el.issueListView.hidden = true;
  el.issueDetailView.hidden = false;

  const i = res.issue;
  el.dTitle.value = i.title ?? '';
  el.dBody.value = i.body ?? '';
  el.dSeverity.value = severityOf(i);
  el.dStatus.value = i.status ?? 'open';
  el.dFiledAs.value = i.filedAs ?? '';
  el.dTags.value = tagsOf(i).join(', ');
  el.dContext.textContent = summariseContext(i.context);
  renderAttachments(i.attachments ?? []);
  el.issueSaved.textContent = `saved ${ago(i.updatedAt)}`;
  const video = await cmd({ cmd: 'videoStatus' }).catch(() => null);
  setVideoState(video?.ok ? video.status : { recording: false });

  if (focusTitle) {
    el.dTitle.focus();
    el.dTitle.select();
  } else {
    el.issueBack.focus();
  }
}

function setVideoState(status) {
  videoState = status ?? { recording: false };
  const forThisIssue = videoState.recording && videoState.issueId === openIssueId;
  el.dVideo.textContent = forThisIssue ? '■ Stop recording' : '● Record tab';
  el.dVideo.classList.toggle('stop', forThisIssue);
  el.dVideo.disabled = videoState.recording && !forThisIssue;
  el.dDelete.disabled = forThisIssue;
  el.dVideo.title = el.dVideo.disabled
    ? 'This tab is recording video for another issue. Open that issue to stop it.'
    : '';
}

function summariseContext(c) {
  if (!c) return '(no context captured)';
  return [
    `url        ${c.url ?? '?'}`,
    `title      ${c.title ?? '?'}`,
    `came from  ${c.referrer || '(direct)'}`,
    `viewport   ${c.viewport?.width}×${c.viewport?.height} @${c.viewport?.dpr}x`,
    `captured   ${c.at ?? '?'}`,
    `console    ${c.console?.total ?? 0} entries, ${c.console?.counts?.error ?? 0} errors`,
    `failed req ${c.failedRequestCount ?? 0}`,
  ].join('\n');
}

function renderAttachments(list) {
  el.dAttCount.textContent = list.length ? `${list.length} file${list.length === 1 ? '' : 's'}` : 'nothing attached yet';
  el.dAttachments.replaceChildren();
  for (const a of list) {
    const li = document.createElement('li');
    if (a.kind === 'screenshot') {
      const img = document.createElement('img');
      img.alt = a.name;
      // Bytes are fetched only for images, one at a time. A 40MB frame capture
      // has no business being pulled into the panel to draw an icon.
      cmd({ cmd: 'issueAttachment', attachmentId: a.id }).then((r) => {
        // Only an image type makes it into a data: URL; anything else stays a glyph.
        if (r?.ok && r.attachment?.dataBase64 && /^image\/(png|jpeg|webp|gif)$/.test(a.mime ?? '')) {
          img.src = `data:${a.mime};base64,${r.attachment.dataBase64}`;
        }
      });
      li.append(img);
    } else {
      li.append(node('div', 'glyph', GLYPH[a.kind] ?? '📎'));
    }
    li.append(node('div', 'cap', `${a.name} · ${bytes(a.size)}`));
    li.title = a.name;

    li.append(btn('✕', 'rm', async () => {
      await cmd({ cmd: 'issueDetach', attachmentId: a.id });
      openIssue(openIssueId);
    }, { title: 'Remove', aria: `Remove ${a.name}` }));
    el.dAttachments.append(li);
  }
}

/** Debounced, so typing a body does not write on every keystroke. */
async function saveIssueNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!openIssueId) return true;
  el.issueSaved.textContent = 'saving…';
  const res = await cmd({
    cmd: 'issueUpdate',
    id: openIssueId,
    title: el.dTitle.value.trim() || '(untitled)',
    body: el.dBody.value,
    severity: el.dSeverity.value,
    status: el.dStatus.value,
    filedAs: el.dFiledAs.value.trim(),
    tags: el.dTags.value.split(',').map((t) => t.trim()).filter(Boolean),
  });
  el.issueSaved.textContent = res?.ok ? 'saved just now' : 'not saved';
  if (!res?.ok) {
    showPanelError(res?.error ?? 'Could not save the issue.');
    return false;
  }
  return true;
}

function queueSave() {
  clearTimeout(saveTimer);
  el.issueSaved.textContent = 'saving…';
  saveTimer = setTimeout(() => {
    saveIssueNow().catch((err) => showPanelError(err?.message ?? err));
  }, 500);
}

export function wire() {
  /**
   * Creating an issue captures first and asks questions second.
   *
   * The evidence is only true at the instant the bug is on screen — the console
   * tail, the failed requests, the screenshot. A title can be written any time
   * after. So the button files immediately with a placeholder name and opens the
   * editor, rather than holding a form open while the page moves on underneath
   * it and the evidence goes stale.
   */
  el.issueNew.addEventListener('click', async () => {
    el.issueNew.disabled = true;
    const res = await cmd({
      cmd: 'issueCreate',
      title: `Issue ${new Date().toLocaleTimeString([], { hour12: false })}`,
      body: '',
      severity: 'normal',
    });
    el.issueNew.disabled = false;

    if (!res?.ok) return showPanelError(res?.error ?? 'Could not capture the issue.');
    toast('Captured — screenshot, console, requests and context saved');
    openIssue(res.id, { focusTitle: true });
  });

  for (const id of ['dTitle', 'dBody', 'dSeverity', 'dStatus', 'dFiledAs', 'dTags']) {
    el[id].addEventListener('input', queueSave);
    el[id].addEventListener('change', queueSave);
  }

  // Back to the list: whatever was just typed is saved first, and the list is
  // read again, so a severity, status or tag changed here is what it shows.
  el.issueBack.addEventListener('click', async () => {
    if (saveTimer && !(await saveIssueNow())) return;
    const was = openIssueId;
    openIssueId = null;
    el.issueDetailView.hidden = true;
    el.issueListView.hidden = false;
    paintedKey = null;
    await refresh();
    [...el.issueList.querySelectorAll('[data-k]')].find((n) => n.dataset.k === `open:${was}`)?.focus();
  });

  el.dDelete.addEventListener('click', async () => {
    const id = openIssueId;
    clearTimeout(saveTimer);
    saveTimer = null;
    openIssueId = null;
    el.issueDetailView.hidden = true;
    el.issueListView.hidden = false;
    await cmd({ cmd: 'issueDelete', id });
    toast('Deleted');
    paintedKey = null;
    refresh();
  });

  const shoot = (area) => async () => {
    const res = await cmd({ cmd: 'issueShot', id: openIssueId, area });
    if (!res?.ok) return showPanelError(res?.error ?? 'Could not capture.');
    toast('Screenshot attached');
    openIssue(openIssueId);
  };
  el.dShot.addEventListener('click', shoot('viewport'));
  el.dShotFull.addEventListener('click', shoot('fullpage'));

  el.dRecapture.addEventListener('click', async () => {
    const res = await cmd({ cmd: 'issueRecapture', id: openIssueId });
    if (!res?.ok) return showPanelError(res?.error ?? 'Could not re-capture.');
    toast('Context, console and requests re-captured');
    openIssue(openIssueId);
  });

  el.dVideo.addEventListener('click', async () => {
    if (videoState.recording && videoState.issueId === openIssueId) {
      const res = await cmd({ cmd: 'videoStop', id: openIssueId });
      if (!res?.ok) return showPanelError(res?.error ?? 'Could not stop recording.');
      setVideoState({ recording: false });
      toast(res?.frames ? `${res.frames} frames attached` : 'Stopped — nothing captured');
      openIssue(openIssueId);
    } else {
      const res = await cmd({ cmd: 'videoStart', id: openIssueId });
      if (!res?.ok) return showPanelError(res?.error ?? 'Could not start recording.');
      setVideoState({ recording: true, issueId: openIssueId, startedAt: res.startedAt });
      toast('Recording this tab — reproduce the bug, then stop');
    }
  });

  el.dFile.addEventListener('click', () => el.dFileInput.click());

  el.dFileInput.addEventListener('change', async () => {
    const files = [...el.dFileInput.files];
    el.dFileInput.value = '';
    for (const file of files) {
      const res = await cmd({
        cmd: 'issueAttach',
        id: openIssueId,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        dataBase64: await fileToBase64(file),
      });
      if (!res?.ok) showPanelError(res?.error ?? `Could not attach ${file.name}.`);
    }
    toast(`${files.length} file${files.length === 1 ? '' : 's'} attached`);
    openIssue(openIssueId);
  });

  el.iSite.addEventListener('change', () => setFilter({ site: el.iSite.value }));
  el.iStatus.addEventListener('change', () => setFilter({ status: el.iStatus.value }));
  el.iSeverity.addEventListener('change', () => setFilter({ severity: el.iSeverity.value }));
  el.iTag.addEventListener('change', () => setFilter({ tag: el.iTag.value }));
  let typing = null;
  el.iSearch.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => setFilter({ q: el.iSearch.value }), 150);
  });
}
