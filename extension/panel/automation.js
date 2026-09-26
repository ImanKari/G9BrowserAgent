/**
 * The Automation view — the whole engine, reachable without an agent.
 *
 * ## What changed in v1.7.0 and why
 *
 * Everything below already existed and was callable only over MCP. The panel
 * offered five commands out of nineteen: record, stop, replay, dry-run, delete.
 * So a QA working alone could produce a MACRO — proof that the steps could be
 * performed — and never a TEST, which is proof that they did something. The
 * assertion wizard, calibration, the known world and the five verdicts were all
 * invisible to the people the tool exists for.
 *
 * Three of these deserve their reasoning restated where the code lives:
 *
 * - **The verdict was always computed and thrown away.** `replay()` returns
 *   `verdict`, `surpriseLines` and `knownWorld` on every call, including the
 *   panel's. The old report rendered `passed/failed/warnings` and dropped the
 *   rest — so the surprise detector, the most original thing in the tool, had
 *   no user interface at all.
 *
 * - **Approve belongs to a human, so it belongs here.** The known world may
 *   only be grown by a person who looked at a run. It was previously reachable
 *   only through MCP — by the agent, the one caller it was written to exclude.
 *
 * - **The wizard proposes; the person decides.** `suggest` returns each
 *   candidate with a strength and a reason, and adds nothing by itself. Shown
 *   as checkboxes, that becomes a thirty-second job. A weak assertion someone
 *   consciously accepted is a decision; one a tool added quietly is a blind spot.
 *
 * ## What changed in v3 (U6, AIGuide §6.10)
 *
 * The index always carried startUrl, suite, folder, tags, lastRun, flaky,
 * assertionCount and environment; the list used none of them and rendered one
 * flat column. Now: site (the origin of startUrl) → suite → flow, filters built
 * from the values the QA already enters, a row that says the last verdict, the
 * checks and flakiness at a glance, and one drawer per flow holding everything
 * the old per-flow row offered. "Run all" runs what the filter shows and says so.
 */

import { siteOf, displayUrl } from '../lib/sites.js';
import {
  el, cmd, node, btn, chip, dot, toast, showPanelError, ago, view, setOptions, prefs, group, keepFocus, middle, extLink,
  copyText, metaLine, downloadText, PRODUCT, VERSION,
} from './ui.js';
import { summarizeHistory, buildHistoryReport, reportFileName } from './report.js';

let recording = false;
/** A start or stop is on its way to the service worker. */
let recBusy = false;
/** The last recStatus answer, so a busy repaint keeps the same text. */
let lastRecStatus = { recording: false };
let lastRecElsewhere = [];
let lastRecHalted = false;

/**
 * What the Record controls show (F8). Pure; exported for the unit test.
 *
 * `startRecording` refuses a tab that is already recording (tools/record.js: a
 * second start used to replace the session, leak the first one's scripts into
 * every later page of the tab and lose its steps). So while THIS tab records,
 * the Record button is disabled and says why, and "Stop and save" is the
 * action; while a start or stop is on its way, neither can be pressed again —
 * a double click was exactly a second start. Another tab recording does not
 * block this one (sessions are per tab), but it is named, because the panel
 * otherwise shows nothing about it.
 */
export function recordControls(status = {}, { busy = false, elsewhere = [], halted = false } = {}) {
  const on = !!status?.recording;
  const name = status?.name ? `"${status.name}"` : 'a flow';
  let why = '';
  if (on && halted) {
    // Stop blocks agents, not the person's own save (sw.js recStop runs as the person).
    why = `Agents are stopped; this tab is still recording ${name}. Stop and save works while Stop is on.`;
  } else if (on) {
    why = `This tab is already recording ${name}. Stop and save it before starting another — ` +
      'a second start on the same tab is refused.';
  } else if (halted) {
    why = 'Agents are stopped. Press Resume to record.';
  } else if (busy) {
    why = 'Starting…';
  }
  const others = (Array.isArray(elsewhere) ? elsewhere : []).filter((r) => r && r.tabId != null);
  const note = others.length
    ? ` Also recording in another tab: ${others.map((r) => `${r.name ? `"${r.name}"` : 'a flow'} (tab ${r.tabId})`).join(', ')}.`
    : '';
  return {
    startDisabled: on || busy || halted,
    startTitle: on || halted ? why : busy ? 'Starting…' : 'Record what you do in this tab',
    stopHidden: !on,
    stopDisabled: busy,
    why: (why + note).trim(),
  };
}

function paintRecordControls() {
  const c = recordControls(lastRecStatus, { busy: recBusy, elsewhere: lastRecElsewhere, halted: lastRecHalted });
  el.recToggle.disabled = c.startDisabled;
  el.recToggle.title = c.startTitle;
  el.recToggle.setAttribute?.('aria-disabled', String(c.startDisabled));
  el.recStop.hidden = c.stopHidden;
  el.recStop.disabled = c.stopDisabled;
  el.recWhy.textContent = c.why;
  el.recWhy.hidden = !c.why;
}

/** Flow ids whose drawer is open. */
const expanded = new Set();
/**
 * The run happening right now, if any.
 *
 * A replay used to be a single message that returned when everything was over.
 * On a twenty-step flow that is half a minute of a panel showing nothing at all,
 * and the first thing a tester asks is whether the button actually did anything.
 * The service worker now announces each step as it STARTS, and this is where
 * those announcements land.
 */
let liveRun = null;
let liveTimer = null;

const api = globalThis.browser ?? globalThis.chrome;
api?.runtime?.onMessage?.addListener((msg) => {
  if (!msg?.__g9 || msg.type !== 'replayProgress' || !liveRun || msg.id !== liveRun.id) return;
  liveRun.step = msg.step;
  liveRun.total = msg.total;
  liveRun.describe = msg.describe;
  liveRun.stepStartedAt = Date.now();
  paintProgress();
});

/** Last replay result per flow id, so a re-render does not lose the report. */
const lastResult = new Map();
let suiteRun = null;

const VERDICT = {
  PASS: { icon: '✅', cls: 'good', text: 'Passed' },
  PASS_WITH_WARNING: { icon: '⚠️', cls: 'warn', text: 'Passed with warnings' },
  SURPRISE: { icon: '🔎', cls: 'warn', text: 'Surprise — it did something new' },
  FAIL_PRODUCT: { icon: '❌', cls: 'bad', text: 'Product failure' },
  FAIL_AUTOMATION: { icon: '🔧', cls: 'bad', text: 'Test failure (not the product)' },
};

/**
 * What each verdict means for the person reading it.
 *
 * The separation of FAIL_PRODUCT from FAIL_AUTOMATION is the whole point of the
 * classification, and it only pays off if the reader is told what to do
 * differently. A pipeline that reports a rotted locator as a product regression
 * teaches people to ignore it.
 */
const VERDICT_ADVICE = {
  PASS: '',
  PASS_WITH_WARNING: 'The flow still works but is drifting — usually a locator that now matches more weakly.',
  SURPRISE: 'Something happened that has never happened on this flow. Read it, then Approve if it is the new normal.',
  FAIL_PRODUCT: 'The product did the wrong thing. This is a bug — file it from the Issues tab.',
  FAIL_AUTOMATION: 'The test could not run, so this says nothing about the product. An element moved or was renamed, or the browser never delivered the input — check the step message.',
};

/** The verdict as a row shows it: short, next to its dot. The code is in the title.
 * Kept after VERDICT_ADVICE: setup/extensiontest.mjs reads the first FAIL_AUTOMATION string in this file as the advice. */
const VERDICT_LABEL = {
  PASS: 'Pass',
  PASS_WITH_WARNING: 'Warnings',
  SURPRISE: 'Surprise',
  FAIL_PRODUCT: 'Product fail',
  FAIL_AUTOMATION: 'Test fail',
  none: 'Never run',
};

// ------------------------------------------------------------------ filters

const FILTER_KEY = 'g9.flowFilters';
const FOLD_KEY = 'g9.flowFold';
const EMPTY_FILTER = { site: '', suite: '', tag: '', verdict: '', flaky: false, q: '' };
/** The filter, remembered for this viewer: a QA working one site all day should not re-pick it. */
let filter = { ...EMPTY_FILTER, ...prefs.get(FILTER_KEY, {}) };
/** The index as last read, for the filters' change handlers. */
let lastList = [];
/** Full recordings (recGet) for open drawers: the run history and the start URL. */
const details = new Map();
/** Each open drawer's wizard box, kept across repaints so ticked checkboxes survive a poll. */
const wizards = new Map();
/** Bumped by anything that changes what the list shows without changing the index. */
let dirty = 0;
let paintedKey = null;
let affinityKey = null;

const NO_SITE = 'none';
// A value nobody can type: a real suite named "none" used to merge into "No suite" (v3 review, finding 8).
const NO_SUITE = '\u0000none';

const siteKeyOf = (r) => siteOf(r?.startUrl) ?? NO_SITE;
const suiteKeyOf = (r) => (typeof r?.suite === 'string' && r.suite.trim() ? r.suite.trim() : NO_SUITE);
/** A run from before v1.7 has no verdict, only passed/failed: that much is said, and no more. */
const verdictOf = (r) => {
  if (!r?.lastRun) return 'none';
  if (VERDICT[r.lastRun.verdict]) return r.lastRun.verdict;
  return r.lastRun.failed ? 'FAIL_AUTOMATION' : 'PASS';
};
const isManual = (r) => Array.isArray(r?.tags) && r.tags.includes('@manual');
const isFlaky = (r) => !!(r?.flaky === true || r?.flaky?.detected);
const lastAt = (r) => r?.lastRun?.at ?? 0;

/** "admin.example.test", or "http://intranet:8080" when it is not plain https. */
function siteLabel(key) {
  if (key === NO_SITE) return 'No start URL';
  const d = displayUrl(key);
  return d.origin?.startsWith('https://') ? d.host : (d.origin ?? key);
}

/** Pure; exported for the unit test. Which of the index rows the filter lets through. */
export function applyFilter(list, f = filter) {
  const q = String(f.q ?? '').trim().toLowerCase();
  return (Array.isArray(list) ? list : []).filter((r) => {
    if (f.site && siteKeyOf(r) !== f.site) return false;
    if (f.suite && suiteKeyOf(r) !== f.suite) return false;
    if (f.tag && !(Array.isArray(r.tags) && r.tags.includes(f.tag))) return false;
    if (f.verdict && verdictOf(r) !== f.verdict) return false;
    if (f.flaky && !isFlaky(r)) return false;
    if (q) {
      const hay = [r.name, r.suite, r.folder, typeof r.environment === 'string' ? r.environment : '', r.startUrl, ...listOf(r.tags), ...listOf(r.qaTestCaseIds)]
        .filter((v) => typeof v === 'string').join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** What "Run N flows in <scope>" names. Pure; exported for the unit test. */
export function scopeText(f = filter) {
  const site = f.site ? (f.site === NO_SITE ? 'no start URL' : siteLabel(f.site)) : null;
  const suite = f.suite ? (f.suite === NO_SUITE ? 'no suite' : f.suite) : null;
  const base = suite && site ? `${suite} on ${site}` : suite || site || 'all sites';
  const extra = [
    f.tag || null,
    f.verdict ? (VERDICT_LABEL[f.verdict] ?? f.verdict).toLowerCase() : null,
    f.flaky ? 'flaky' : null,
    String(f.q ?? '').trim() ? `“${String(f.q).trim()}”` : null,
  ].filter(Boolean);
  return extra.length ? `${base} (${extra.join(', ')})` : base;
}

function setFilter(patch) {
  filter = { ...filter, ...patch };
  prefs.set(FILTER_KEY, filter);
  dirty += 1;
  renderList(lastList);
}

/** The selects, built from the distinct values in the index (B2: structure from what the QA enters). */
function paintFilters(list) {
  el.flowFilters.hidden = list.length === 0;
  const count = (fn) => {
    const m = new Map();
    for (const r of list) for (const k of [].concat(fn(r))) if (k != null) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const withSelected = (map, value) => (value && !map.has(value) ? new Map([...map, [value, 0]]) : map);

  const sites = withSelected(count(siteKeyOf), filter.site);
  const siteOpts = [...sites.keys()].sort((a, b) => (a === NO_SITE) - (b === NO_SITE) || siteLabel(a).localeCompare(siteLabel(b)));
  setOptions(el.fSite, [['', `All sites (${list.length})`], ...siteOpts.map((k) => [k, `${siteLabel(k)} (${sites.get(k)})`])], filter.site);

  // Suites and tags narrow to the chosen site, so the choices are ones that match something.
  const inSite = filter.site ? list.filter((r) => siteKeyOf(r) === filter.site) : list;
  const suites = withSelected(count(suiteKeyOf), filter.suite);
  const suitesHere = withSelected(new Map([...count(suiteKeyOf)].filter(([k]) => inSite.some((r) => suiteKeyOf(r) === k))), filter.suite);
  const suiteOpts = [...suitesHere.keys()].sort((a, b) => (a === NO_SUITE) - (b === NO_SUITE) || a.localeCompare(b));
  setOptions(el.fSuite, [['', 'All suites'], ...suiteOpts.map((k) => [k, k === NO_SUITE ? 'No suite' : k])], filter.suite);
  el.fSuite.hidden = !filter.suite && ![...suites.keys()].some((k) => k !== NO_SUITE);

  const tags = withSelected(count((r) => (Array.isArray(r.tags) ? r.tags.filter((t) => typeof t === 'string') : [])), filter.tag);
  const tagsHere = [...tags.keys()].filter((t) => t === filter.tag || inSite.some((r) => r.tags?.includes(t))).sort();
  setOptions(el.fTag, [['', 'All tags'], ...tagsHere.map((t) => [t, t])], filter.tag);
  el.fTag.hidden = !filter.tag && tags.size === 0;

  const verdicts = withSelected(count(verdictOf), filter.verdict);
  const order = ['FAIL_PRODUCT', 'FAIL_AUTOMATION', 'SURPRISE', 'PASS_WITH_WARNING', 'PASS', 'none'];
  setOptions(el.fVerdict, [['', 'Any verdict'], ...order.filter((v) => verdicts.has(v)).map((v) => [v, VERDICT_LABEL[v]])], filter.verdict);

  el.fFlaky.setAttribute('aria-pressed', String(!!filter.flaky));
  el.fFlaky.hidden = !filter.flaky && !list.some(isFlaky);
  if (document.activeElement !== el.fSearch) el.fSearch.value = filter.q ?? '';
}

// ------------------------------------------------------------------ the list

export async function refresh() {
  if (view.active !== 'automation') return;
  let res;
  try {
    res = await cmd({ cmd: 'recStatus' });
  } catch (err) {
    el.recCount.textContent = 'refresh failed';
    return showPanelError('Automation refresh failed: ' + (err?.message ?? err), { source: 'refresh' });
  }
  if (!res?.ok) return showPanelError(res?.error ?? 'Automation refresh failed.', { source: 'refresh' });

  recording = !!res.status?.recording;
  lastRecStatus = res.status ?? { recording: false };
  lastRecElsewhere = Array.isArray(res.elsewhere) ? res.elsewhere : [];
  lastRecHalted = res.halted === true;
  paintRecordControls();
  el.recLive.hidden = !recording;
  if (recording) {
    const st = res.status;
    el.recLive.textContent =
      `Recording "${st.name}" — ${st.steps} step${st.steps === 1 ? '' : 's'}` +
      (st.lastStep ? ` · last: ${st.lastStep}` : ' · go and use the page');
  }

  renderList(res.recordings ?? []);
}

function renderList(list) {
  lastList = Array.isArray(list) ? list : [];
  el.recCount.textContent = lastList.length ? `${lastList.length} saved` : '';
  el.recEmpty.hidden = lastList.length > 0;
  paintFilters(lastList);

  const shown = applyFilter(lastList);
  const here = siteOf(view.current?.url);
  paintAffinity(lastList, here);
  paintRunBar(shown);
  paintRepoPickers();

  // Repaint only when what the list shows changed (or once a minute, for the
  // "2h ago"s): the list holds buttons and fields, and a rebuild on every poll
  // took the keyboard focus and a half-typed tag with it.
  const key = JSON.stringify([
    shown.map((r) => [r.id, r.name, r.updatedAt, r.lastRun?.at, r.lastRun?.verdict, isFlaky(r), r.assertionCount,
      r.environment, r.suite, r.folder, r.tags, r.startUrl, r.stepCount, r.qaTestCaseIds]),
    here, dirty, liveRun?.id ?? null, Math.floor(Date.now() / 60_000), lastList.length,
  ]);
  if (key === paintedKey) return;
  paintedKey = key;
  keepFocus(el.recList, () => paintGroups(shown, here));
}

function paintGroups(shown, here) {
  if (!lastList.length) {
    el.recList.replaceChildren();
    return;
  }
  if (!shown.length) {
    const empty = node('div', 'empty');
    empty.append(node('p', null, 'No flows match these filters.'),
      btn('Clear filters', 'link', () => setFilter({ ...EMPTY_FILTER }), { key: 'clearfilters' }));
    el.recList.replaceChildren(empty);
    return;
  }

  // Site → suite → flow. The site in front of the person first, then the most
  // recently run, "No start URL" last; suites by name; flows newest run first.
  const bySite = new Map();
  for (const r of shown) {
    const s = siteKeyOf(r);
    if (!bySite.has(s)) bySite.set(s, []);
    bySite.get(s).push(r);
  }
  const newest = (rows) => Math.max(0, ...rows.map((r) => lastAt(r) || r.updatedAt || 0));
  const sites = [...bySite.keys()].sort((a, b) =>
    (b === here) - (a === here) || (a === NO_SITE) - (b === NO_SITE) || newest(bySite.get(b)) - newest(bySite.get(a)));

  const out = [];
  for (const site of sites) {
    const rows = bySite.get(site);
    const g = group({
      store: FOLD_KEY, key: `site:${site}`, title: siteLabel(site), count: rows.length, level: 1,
      titleAttr: site === NO_SITE ? 'Flows recorded without a start URL: open one and fill in Start URL to give it a site' : site,
    });
    if (site === NO_SITE) {
      g.body.append(node('p', 'help', 'These have no start URL, so they have no site. Open one and fill in Start URL to give it one.'));
    }
    const bySuite = new Map();
    for (const r of rows) {
      const k = suiteKeyOf(r);
      if (!bySuite.has(k)) bySuite.set(k, []);
      bySuite.get(k).push(r);
    }
    const suites = [...bySuite.keys()].sort((a, b) => (a === NO_SUITE) - (b === NO_SUITE) || a.localeCompare(b));
    // One suite, and it is "no suite": a second level would only add a header.
    const flat = suites.length === 1 && suites[0] === NO_SUITE;
    for (const suite of suites) {
      const flows = bySuite.get(suite).sort((a, b) => lastAt(b) - lastAt(a) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      let target = g.body;
      if (!flat) {
        const sg = group({ store: FOLD_KEY, key: `suite:${site}|${suite}`, title: suite === NO_SUITE ? 'No suite' : suite, count: flows.length, level: 2 });
        g.body.append(sg.wrap);
        target = sg.body;
      }
      for (const r of flows) target.append(flowBlock(r));
    }
    out.push(g.wrap);
  }
  el.recList.replaceChildren(...out);
}

/** "This site: admin.example.test — 3 flows": the QA lands on what is in front of them. */
function paintAffinity(list, here) {
  const n = here ? list.filter((r) => siteKeyOf(r) === here).length : 0;
  el.flowAffinity.hidden = n === 0;
  if (!n) return;
  const only = filter.site === here;
  // Painted when it changes, not on every poll: it holds a button.
  const key = JSON.stringify([here, n, only]);
  if (key === affinityKey) return;
  affinityKey = key;
  const text = node('span', 'grow-text');
  text.append('This site: ', node('b', null, siteLabel(here)), ` — ${n} flow${n === 1 ? '' : 's'}`);
  text.title = here;
  const action = only
    ? btn('Show all sites', 'link', () => setFilter({ site: '' }), { key: 'aff' })
    : btn('Show only these', 'link', () => setFilter({ site: here, suite: '' }), { key: 'aff' });
  keepFocus(el.flowAffinity, () => el.flowAffinity.replaceChildren(text, action));
}

/** "Run 3 flows in smoke" — the scope is the filter, so it is never an accidental run of everything. */
function paintRunBar(shown) {
  el.suiteCard.hidden = lastList.length === 0;
  const runnable = shown.filter((r) => !isManual(r));
  const manual = shown.length - runnable.length;
  const scope = scopeText(filter);
  if (!suiteRun?.running) {
    el.suiteBtn.textContent = runnable.length
      ? `▶ Run ${runnable.length} flow${runnable.length === 1 ? '' : 's'} in ${scope}`
      : `No runnable flows in ${scope}`;
    el.suiteBtn.title = `Replays ${runnable.length} flow${runnable.length === 1 ? '' : 's'} one after another` +
      (manual ? `, skipping ${manual} tagged @manual` : '') + '. The filter above decides which.';
    el.suiteBtn.disabled = runnable.length === 0;
    if (!suiteRun) {
      el.suiteProgress.textContent = manual
        ? `In order; ${manual} tagged @manual skipped.`
        : 'In order, one tab at a time; @manual flows are skipped.';
    }
  }
}

// ------------------------------------------------------------------ a flow

function flowBlock(r) {
  const wrap = node('div', 'flow-panel');
  const open = expanded.has(r.id);
  const v = verdictOf(r);
  const drawerId = `drawer-${cssSafe(r.id)}`;

  const row = node('div', `flow${open ? ' open' : ''}`);
  const main = btn(null, 'flow-open', () => toggle(r.id), { key: `open:${r.id}` });
  main.setAttribute('aria-expanded', String(open));
  if (open) main.setAttribute('aria-controls', drawerId);
  main.title = `${r.name ?? '(unnamed)'}${r.lastRun ? ` — last run ${v} ${ago(r.lastRun.at ?? r.updatedAt)}` : ' — never run'}`;

  const l1 = node('span', 'l1');
  l1.append(dot('v', v), node('span', 'nm', r.name || '(unnamed)'));
  const vt = node('span', 'vt', VERDICT_LABEL[v]);
  vt.dataset.v = v;
  const f = r.flaky ?? {};
  main.append(l1, metaLine([
    vt,
    r.assertionCount ? `${r.assertionCount} check${r.assertionCount === 1 ? '' : 's'}` : 'macro — no checks',
    isFlaky(r)
      ? chip('flaky', 'warn', f.sampleSize ? `${f.passRuns ?? '?'} passed and ${f.failRuns ?? '?'} failed of the last ${f.sampleSize} runs` : 'Recent runs both passed and failed')
      : null,
    typeof r.environment === 'string' && r.environment ? r.environment : null,
    r.lastRun ? ago(r.lastRun.at ?? r.updatedAt) : null,
  ]));

  const side = node('div', 'side');
  side.append(liveRun?.id === r.id
    ? btn('■', 'danger sm', () => stopRun(), { title: 'Stop this run', aria: `Stop the run of ${r.name}`, key: `run:${r.id}` })
    : btn('▶', 'sm', () => runReplay(r.id, false), { title: 'Replay for real', aria: `Replay ${r.name}`, key: `run:${r.id}` }));
  row.append(main, side);
  wrap.append(row);

  if (liveRun?.id === r.id) wrap.append(progressRow(r));
  const result = lastResult.get(r.id);
  if (result) wrap.append(reportRow(r.id, result));
  if (open) wrap.append(drawer(r, drawerId));
  return wrap;
}

function cssSafe(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_');
}

function toggle(id) {
  if (expanded.has(id)) expanded.delete(id);
  else {
    expanded.add(id);
    loadDetails(id);
  }
  dirty += 1;
  renderList(lastList);
}

/** The full recording for a drawer — once, and again only when the flow changed. */
async function loadDetails(id) {
  const row = lastList.find((r) => r.id === id);
  const have = details.get(id);
  if (have && (have.pending || have.updatedAt === row?.updatedAt)) return;
  details.set(id, { pending: true, updatedAt: row?.updatedAt });
  const res = await cmd({ cmd: 'recGet', id }).catch(() => null);
  details.set(id, { pending: false, updatedAt: row?.updatedAt, rec: res?.ok ? res.recording : null });
  dirty += 1;
  renderList(lastList);
}

/** Everything the per-flow row used to offer, in one place. */
function drawer(r, id) {
  if (details.get(r.id)?.updatedAt !== r.updatedAt) loadDetails(r.id);
  const rec = details.get(r.id)?.rec ?? null;
  const box = node('div', 'drawer');
  box.id = id;

  // Where it starts.
  const start = node('div', 'startline');
  if (r.startUrl) {
    const d = displayUrl(r.startUrl);
    const url = node('span', 'mono', middle(`${d.origin ?? ''}${d.path}${d.query ? '?…' : ''}`, 64));
    url.title = d.href;
    start.append(node('span', 'muted', 'Starts at'), url);
    const link = extLink(r.startUrl, 'open');
    if (link) start.append(link);
  } else {
    start.append(node('span', 'help', 'No start URL recorded.'));
  }
  box.append(start);

  // How it has been doing: one dot per run, oldest first.
  const runs = Array.isArray(rec?.runHistory) ? rec.runHistory : r.lastRun ? [r.lastRun] : [];
  const hist = node('div', 'row wrap');
  hist.append(node('span', 'muted sm', runs.length ? `Last ${runs.length} run${runs.length === 1 ? '' : 's'}` : 'Never run'));
  if (runs.length) {
    const spark = node('span', 'spark');
    spark.setAttribute('role', 'img');
    const pass = runs.filter((x) => x.verdict === 'PASS' || x.verdict === 'PASS_WITH_WARNING').length;
    spark.setAttribute('aria-label', `${pass} of the last ${runs.length} runs passed`);
    for (const run of runs.slice(-20)) {
      const d = dot('v', VERDICT[run.verdict] ? run.verdict : 'none');
      d.title = `${run.verdict ?? '?'} — ${run.passed ?? '?'}/${(run.passed ?? 0) + (run.failed ?? 0)} in ${run.durationMs ?? '?'}ms · ${run.at ? ago(run.at) : ''}`;
      d.removeAttribute('aria-hidden');
      spark.append(d);
    }
    hist.append(spark);
  }
  hist.append(node('span', 'muted sm', `${r.stepCount ?? 0} steps`));
  if (rec?.knownWorld?.runs) hist.append(node('span', 'muted sm', `known world: ${rec.knownWorld.runs} approved`));
  box.append(hist);

  const acts = node('div', 'btnrow');
  acts.append(
    liveRun?.id === r.id
      ? btn('■ Stop', 'danger sm', () => stopRun(), { key: `drun:${r.id}` })
      : btn('▶ Replay', 'primary sm', () => runReplay(r.id, false), { title: 'Replay for real', key: `drun:${r.id}` }),
    btn('🔍 Dry run', 'sm', () => runReplay(r.id, true), { title: 'Resolve every step, change nothing', key: `dry:${r.id}` }),
    btn('✦ Add checks', 'sm', () => openWizard(r.id), { title: 'Ask the tool what is worth asserting here', key: `wiz:${r.id}` }),
    btn('⚖ Calibrate', 'sm', () => calibrate(r.id), { title: 'Run twice on this build and mark what differs as noise', key: `cal:${r.id}` }),
    btn('✓ Approve', 'sm', () => approve(r.id), { title: 'Fold the last run into this flow’s known world', key: `ok:${r.id}` }),
    btn('📜 History', 'sm', () => history(r.id), { title: 'Past runs and the known world', key: `hist:${r.id}` }),
    btn('⬆ Push', 'sm', () => push([r.id]), { title: 'Write this flow to the repo', key: `push:${r.id}` }),
    btn('⤓ Playwright', 'sm', () => exportTest(r.id), { title: 'Copy it as a Playwright test', key: `pw:${r.id}` }),
    btn('✕ Delete', 'sm danger', () => remove(r.id), { title: 'Delete this flow from this browser', key: `del:${r.id}` }),
  );
  box.append(acts);

  const meta = node('div', 'fields');
  meta.append(
    field(r.id, 'folder', 'Section', r.folder ?? '', (v) => patch(r.id, { folder: v })),
    field(r.id, 'suite', 'Suite', r.suite ?? '', (v) => patch(r.id, { suite: v })),
    field(r.id, 'tags', 'Tags', listOf(r.tags).join(', '), (v) =>
      patch(r.id, { tags: v.split(',').map((t) => t.trim()).filter(Boolean) }),
    ),
    field(r.id, 'tc', 'Covers (TC ids)', listOf(r.qaTestCaseIds).join(', '), (v) =>
      patch(r.id, { qaTestCaseIds: v.split(',').map((t) => t.trim()).filter(Boolean) }),
    ),
    // The flow's site is the origin of its start URL. A flow recorded without one sits in
    // "No start URL"; this is how it gets a site without being recorded again. The service
    // worker validates it (http(s) only) and says why when it refuses.
    field(r.id, 'start', 'Start URL', r.startUrl ?? '', (v) => patch(r.id, { startUrl: v })),
  );
  box.append(meta, wizardBox(r.id));
  return box;
}

/**
 * A list field as a list, whatever was stored. A stored string or object would otherwise throw
 * inside a repaint and freeze the whole Automation list (v3 review, finding 4).
 */
function listOf(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string');
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function field(id, name, label, value, onSave) {
  const wrap = node('label', 'fl');
  wrap.append(label);
  const input = document.createElement('input');
  input.value = value;
  input.spellcheck = false;
  input.dataset.k = `field:${id}:${name}`;
  input.addEventListener('change', () => onSave(input.value.trim()));
  wrap.append(input);
  return wrap;
}

function wizardBox(id) {
  if (!wizards.has(id)) {
    const box = node('div', 'wizard');
    box.setAttribute('aria-live', 'polite');
    wizards.set(id, box);
  }
  return wizards.get(id);
}

// ------------------------------------------------------------- the wizard

/**
 * The assertion wizard: proposals with reasons, and nothing ticked by default.
 *
 * `blocked` candidates are shown greyed rather than hidden, because "you cannot
 * assert a clean console here — the page already has 3 errors" is one of the
 * most useful things the tool ever says. Hiding it would leave the reader
 * wondering why the obvious check is missing.
 */
async function openWizard(id) {
  const box = wizardBox(id);
  box.replaceChildren(node('p', 'help', 'Looking at what this flow actually did…'));

  let res;
  try {
    res = await cmd({ cmd: 'recSuggest', id });
  } catch (err) {
    return box.replaceChildren(node('p', 'warn', `Could not suggest: ${err?.message ?? err}`));
  }
  if (!res?.ok) return box.replaceChildren(node('p', 'warn', res?.error ?? 'Could not suggest assertions.'));

  const list = res.suggestions ?? res.assertions ?? [];
  if (!list.length) {
    return box.replaceChildren(node('p', 'help', 'Nothing to propose for this flow yet — try running it once first.'));
  }

  const form = node('div', 'wizlist');
  for (const [index, s] of list.entries()) {
    const line = node('label', `wizrow${s.strength === 'blocked' ? ' blocked' : ''}`);
    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.disabled = s.strength === 'blocked';
    tick.dataset.index = String(index);
    line.append(
      tick,
      node('span', 'kind', s.kind ?? s.assertion ?? '?'),
      node('span', `strength ${s.strength ?? ''}`, s.strength ?? ''),
      node('span', 'why', s.reason ?? ''),
    );
    form.append(line);
  }

  const add = btn('Add selected checks', 'primary sm', async () => {
    const chosen = [...form.querySelectorAll('input:checked')].map((c) => list[Number(c.dataset.index)]);
    if (!chosen.length) return toast('Nothing ticked.');
    let added = 0;
    for (const s of chosen) {
      const res2 = await cmd({ cmd: 'recAssert', id, assertion: s.assertion ?? s });
      if (res2?.ok) added += 1;
      else showPanelError(res2?.error ?? 'Could not add a check.');
    }
    toast(`${added} check${added === 1 ? '' : 's'} added`);
    box.replaceChildren();
    refresh();
  });
  const actions = node('div', 'btnrow');
  actions.append(add, btn('Cancel', 'sm ghost', () => box.replaceChildren()));
  box.replaceChildren(node('div', 'card-t', 'Suggested checks — tick the ones you want'), form, actions);
}

// ------------------------------------------------------------------ actions

async function runReplay(id, dryRun) {
  if (liveRun) return toast('A flow is already running — stop it first.');
  lastResult.delete(id);

  const rec = (await cmd({ cmd: 'recStatus' }).catch(() => null))?.recordings?.find((r) => r.id === id);
  liveRun = {
    id,
    dryRun,
    step: 0,
    total: rec?.stepCount ?? 0,
    describe: null,
    stepStartedAt: null,
    startedAt: Date.now(),
    // The last run's duration is the only honest basis for an estimate, and it
    // is labelled as one. A countdown invented from nothing reads as a promise.
    estimateMs: rec?.lastRun?.durationMs ?? rec?.durationMs ?? null,
  };
  // A ticking clock, because a bar that only moves on step changes looks frozen
  // during exactly the slow step somebody is worried about.
  liveTimer = setInterval(paintProgress, 250);
  dirty += 1;
  refresh();

  let res;
  let failure = null;
  try {
    res = await cmd({ cmd: 'recReplay', id, dryRun });
    if (!res?.ok) failure = res?.error ?? 'Replay could not start.';
  } catch (err) {
    failure = `Replay could not run: ${err?.message ?? err}`;
  }

  // Torn down BEFORE anything repaints. A `finally` would not do: its body runs
  // after the `return` expression is evaluated, so an error path would repaint
  // while the run still looked live and leave a stuck progress bar and a Stop
  // button on a flow that had already finished.
  endRun();
  if (failure) return showPanelError(failure);

  lastResult.set(id, res);
  dirty += 1;
  refresh();
}

function endRun() {
  clearInterval(liveTimer);
  liveTimer = null;
  liveRun = null;
  dirty += 1;
  if (haltedForRun) {
    haltedForRun = false;
    cmd({ cmd: 'resume' }).catch(() => {}).then(refresh);
  }
  refresh();
}

/**
 * Stop the run — and only the run.
 *
 * The mechanism is the global halt flag, because that is the one thing replay
 * already checks between steps. But the INTENT of pressing ■ on a flow is "stop
 * this flow", not "disarm the agent until somebody remembers to re-arm it", and
 * leaving the browser halted afterwards would strand the next person on a panel
 * where nothing works and the reason is two clicks away in another tab.
 *
 * So the halt is scoped: raised here, and lowered again in `endRun()` — but only
 * if this is who raised it. A halt the USER pressed in the header stays up.
 */
let haltedForRun = false;

async function stopRun() {
  haltedForRun = true;
  await cmd({ cmd: 'halt' }).catch(() => {});
  toast('Stopping after the current step…');
}

/** Repaint just the progress strip, without re-rendering the whole list. */
function paintProgress() {
  const strip = document.getElementById('runProgress');
  if (!strip || !liveRun) return;
  const { bar, label } = describeProgress(liveRun);
  const fill = strip.querySelector('.bar > i');
  if (fill) fill.style.width = `${Math.round(bar * 100)}%`;
  const text = strip.querySelector('.runlabel');
  if (text) text.textContent = label;
}

/**
 * How far along, and how much longer.
 *
 * Two numbers with different standing, and the bar is built so it can never
 * confuse them. The STEP COUNT is the skeleton: the bar's floor is the fraction
 * of steps that have actually finished, its ceiling is the step now running.
 * TIME only interpolates between those two, so it can make a long step look
 * alive without ever claiming that step is over.
 *
 * The first version let time run the whole bar (`max(byStep, byTime)`), and on a
 * five-step flow it slid to the end in a couple of seconds while the label still
 * read "step 0/5". A bar that finishes before the work does is worse than no
 * bar: it is a claim, and it is wrong.
 *
 * The pace comes from THIS run wherever possible — once k steps have started,
 * the time they took divided by k-1 is a measurement, and it corrects itself as
 * the run goes on. The previous run's total is only a prior, used before the
 * first step lands.
 */
function describeProgress(run) {
  const now = Date.now();
  const elapsed = now - run.startedAt;
  const total = run.total || 0;
  const started = Math.max(0, Math.min(run.step ?? 0, total));

  // How long one step takes: measured if this run has given us anything to
  // measure, otherwise borrowed from the last run, otherwise a plain guess.
  const prior = run.estimateMs && total ? run.estimateMs / total : 4000;
  const perStep = started > 1 ? elapsed / (started - 1) : prior;

  const floor = total ? Math.max(0, started - 1) / total : 0;
  const ceil = total ? started / total : 0;
  const inStep = run.stepStartedAt
    // Capped below 1: the current step is not finished until the NEXT one is
    // announced, and a bar that reaches a step's ceiling early has to sit still
    // there, which reads as a freeze.
    ? Math.min((now - run.stepStartedAt) / Math.max(perStep, 400), 0.92)
    : 0;
  // Capped below full while the run is still going: on the LAST step the ceiling
  // is 1.0, so the creep rounds to 100% with the step still running — and a full
  // bar sitting there is exactly when somebody decides it has hung.
  const bar = Math.min(floor + (ceil - floor) * inStep, 0.98);

  const secs = (ms) => `${Math.max(0, Math.round(ms / 1000))}s`;
  let time;
  if (!started) {
    time = run.estimateMs ? `~${secs(Math.max(0, run.estimateMs - elapsed))} left` : `${secs(elapsed)} elapsed`;
  } else {
    const thisStepLeft = Math.max(0, perStep - (now - (run.stepStartedAt ?? now)));
    time = `~${secs((total - started) * perStep + thisStepLeft)} left`;
  }

  const where = started ? `step ${started}/${total}` : `starting${total ? ` · ${total} steps` : ''}`;
  return { bar, label: `${where} · ${time}${run.describe ? ` · ${run.describe}` : ''}` };
}

function progressRow() {
  const box = node('div', 'report running');
  box.id = 'runProgress';
  box.setAttribute('role', 'status');

  const head = node('div', 'nm', liveRun.dryRun ? 'Dry run in progress' : 'Running');
  const bar = node('div', 'bar');
  bar.append(node('i', ''));
  const label = node('div', 'runlabel sub', '');

  box.append(head, bar, label);
  // Fill it in immediately rather than waiting for the first tick.
  queueMicrotask(paintProgress);
  return box;
}

async function calibrate(id) {
  toast('Running this flow twice to learn what is just noise…');
  const res = await cmd({ cmd: 'recCalibrate', id }).catch((err) => ({ ok: false, error: String(err) }));
  if (!res?.ok) return showPanelError(res?.error ?? 'Calibration failed.');
  toast(
    `Calibrated — ${res.volatile?.length ?? 0} volatile item${res.volatile?.length === 1 ? '' : 's'} will now be ignored`,
  );
  refresh();
}

async function approve(id) {
  const res = await cmd({ cmd: 'recApprove', id }).catch((err) => ({ ok: false, error: String(err) }));
  if (!res?.ok) return showPanelError(res?.error ?? 'Could not approve.');
  toast('Approved — this run is now the known normal for this flow');
  details.delete(id);
  dirty += 1;
  refresh();
}

async function history(id) {
  const res = await cmd({ cmd: 'recKnownWorld', id }).catch((err) => ({ ok: false, error: String(err) }));
  if (!res?.ok) return showPanelError(res?.error ?? 'Could not read history.');
  const box = wizardBox(id);
  const runs = res.runHistory ?? [];
  const lines = [node('div', 'card-t', `Last ${runs.length} run${runs.length === 1 ? '' : 's'}`)];
  if (!runs.length) lines.push(node('p', 'help', 'Never run.'));
  for (const run of [...runs].reverse()) {
    const v = VERDICT[run.verdict] ?? {};
    lines.push(
      node('div', 'histline', `${v.icon ?? '·'} ${run.verdict ?? '?'} — ${run.passed}/${run.passed + run.failed} in ${run.durationMs}ms · ${ago(run.at)}`),
    );
  }
  lines.push(
    node(
      'div',
      'help',
      res.knownWorld?.runs
        ? `Known world: built from ${res.knownWorld.runs} approved run(s).`
        : 'Known world: not established yet — approve a run you trust.',
    ),
    btn('Close', 'link', () => box.replaceChildren()),
  );
  box.replaceChildren(...lines);
}

async function patch(id, fields) {
  const res = await cmd({ cmd: 'recUpdate', id, patch: fields }).catch((err) => ({ ok: false, error: String(err) }));
  if (!res?.ok) return showPanelError(res?.error ?? 'Could not save.');
  toast('Saved');
  refresh();
}

async function remove(id) {
  await cmd({ cmd: 'recDelete', id });
  expanded.delete(id);
  lastResult.delete(id);
  details.delete(id);
  wizards.delete(id);
  dirty += 1;
  refresh();
}

async function exportTest(id) {
  const res = await cmd({ cmd: 'recExportTest', id }).catch((err) => ({ ok: false, error: String(err) }));
  if (!res?.ok) return showPanelError(res?.error ?? 'Could not export.');
  await copyText(res.test ?? res.code ?? '', 'Playwright test copied to the clipboard');
}

// --------------------------------------------------------------- the report

/**
 * Show the whole outcome, not a verdict.
 *
 * The failing step's message is the product of this feature — which element,
 * what it looked for, what is on the page instead. And the surprises are the
 * part no other tool reports at all: a request that always happened and did not
 * this time is a button that no longer does anything, and nobody ever writes an
 * assertion for that.
 */
function reportRow(id, res) {
  const v = VERDICT[res.verdict] ?? { icon: '·', cls: '', text: res.verdict ?? 'done' };
  const box = node('div', `report ${v.cls}`);

  const bad = res.steps?.find((s) => !s.ok);
  box.append(
    node(
      'div',
      'nm',
      `${v.icon} ${v.text} — ${res.passed}/${res.total}${res.durationMs != null ? ` in ${res.durationMs}ms` : ''}` +
        (res.dryRun ? ' (dry run)' : ''),
    ),
  );
  if (VERDICT_ADVICE[res.verdict]) box.append(node('div', 'advice', VERDICT_ADVICE[res.verdict]));
  if (bad) box.append(node('div', 'failline', `Step ${bad.step} of ${res.total}: ${bad.error}`));
  for (const w of res.warnings ?? []) box.append(node('div', 'warn', w));

  for (const line of res.surpriseLines ?? []) box.append(node('div', 'surprise', line));

  if (res.knownWorld && !res.dryRun) {
    box.append(
      node(
        'div',
        'sub',
        res.knownWorld.runs
          ? `Compared against ${res.knownWorld.runs} approved run(s).`
          : (res.knownWorld.note ?? 'No known world yet — nothing to compare against.'),
      ),
    );
  }

  const acts = node('div', 'btnrow');
  if (res.verdict === 'SURPRISE' || res.verdict === 'PASS_WITH_WARNING') {
    acts.append(btn('✓ This is the new normal', 'sm', () => approve(id)));
  }
  acts.append(btn('dismiss', 'link', () => {
    lastResult.delete(id);
    dirty += 1;
    refresh();
  }, { key: `dismiss:${id}` }));
  box.append(acts);
  return box;
}

// ------------------------------------------------------------- suite + sync

/**
 * Run the flows the filter shows, one after another.
 *
 * Sequential on purpose. A browser delivers input only to the tab it is
 * showing, so two flows running at once would have one of them clicking into a
 * hidden page — the exact failure v1.4.0 was released to stop reporting as
 * success. The scope is read again at the press: the list may have changed
 * since it was painted.
 */
async function runAll() {
  const res = await cmd({ cmd: 'recStatus' });
  const scope = scopeText(filter);
  const list = applyFilter(res?.recordings ?? []).filter((r) => !isManual(r));
  if (!list.length) return toast(`No flows to run in ${scope}.`);

  suiteRun = { total: list.length, done: 0, results: [], scope, running: true };
  el.suiteBtn.disabled = true;
  el.suiteBtn.textContent = `Running ${scope}…`;
  for (const r of list) {
    suiteRun.done += 1;
    el.suiteProgress.textContent = `Running ${suiteRun.done}/${suiteRun.total} — ${r.name}`;
    const out = await cmd({ cmd: 'recReplay', id: r.id, dryRun: false }).catch((err) => ({
      ok: false,
      error: String(err),
      verdict: 'FAIL_AUTOMATION',
    }));
    suiteRun.results.push({ name: r.name, verdict: out?.verdict ?? 'FAIL_AUTOMATION', ok: out?.ok });
    lastResult.set(r.id, out);
    dirty += 1;
  }
  suiteRun.running = false;
  el.suiteBtn.disabled = false;
  renderSuiteSummary();
  refresh();
}

function renderSuiteSummary() {
  if (!suiteRun) return;
  const counts = {};
  for (const r of suiteRun.results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  el.suiteProgress.textContent = `${suiteRun.scope}: ` + Object.entries(counts)
    .map(([verdict, n]) => `${VERDICT[verdict]?.icon ?? '·'} ${n} ${verdict}`)
    .join('   ');
}

// ------------------------------------------------------------ the repository (3.2)
//
// Which library: the daemon's own project or a connected agent's (it used to be only the daemon's,
// the project of whichever session happened to start it). Which flows: all, or one site's.

const REPO_KEY = 'g9.repoProject';
const SCOPE_KEY = 'g9.repoScope';
let repo = { projects: [], default: null, loaded: false, error: null };

async function loadProjects() {
  const res = await cmd({ cmd: 'flowProjects' }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
  // A daemon older than 3.2 knows one library, its own, and no `projects` op: that library is used, and
  // the line says why there is no choice.
  const legacy = !res?.ok && /Unknown flow-library op/i.test(String(res?.error ?? ''));
  repo = res?.ok
    ? { projects: Array.isArray(res.projects) ? res.projects : [], default: res.default ?? null, loaded: true, error: null, legacy: false }
    : { projects: [], default: null, loaded: true, error: legacy ? null : (res?.error ?? 'Could not reach the flow library.'), legacy };
  paintRepoPickers();
}

/**
 * The scope: '' (all flows) or a site key. Follows the list's site filter until the person picks one
 * here. Pure over its inputs; exported for the unit test.
 */
export function repoScopeOf(saved, f = filter) {
  if (saved === '' || (typeof saved === 'string' && saved)) return saved;
  return f.site || '';
}

/**
 * The project: the person's pick when it is still offered; else the one whose environments name the
 * scope's site; else the daemon's default. Pure; exported for the unit test.
 */
export function repoProjectOf(projects, { saved = null, fallback = null, site = '' } = {}) {
  const list = Array.isArray(projects) ? projects : [];
  if (saved && list.some((p) => p.path === saved)) return saved;
  if (site && site !== NO_SITE) {
    const host = displayUrl(site).host?.toLowerCase();
    const match = host && list.find((p) => Array.isArray(p.domains) && p.domains.includes(host));
    if (match) return match.path;
  }
  return fallback ?? list[0]?.path ?? null;
}

const currentScope = () => repoScopeOf(prefs.get(SCOPE_KEY, null));
const currentProject = () => repoProjectOf(repo.projects, { saved: prefs.get(REPO_KEY, null), fallback: repo.default, site: currentScope() });
const projectName = (path) => repo.projects.find((p) => p.path === path)?.name ?? 'repository';
const inScope = (site) => lastList.filter((r) => !site || siteKeyOf(r) === site);

function paintRepoPickers() {
  const project = currentProject();
  setOptions(el.syncProject, repo.projects.map((p) => [p.path, `${p.name}${p.own ? ' · daemon' : ''}${p.agents?.length ? ` · ${p.agents.length} agent${p.agents.length === 1 ? '' : 's'}` : ''}`]), project ?? '');
  el.syncProject.hidden = repo.projects.length < 2;
  if (project) el.syncProject.title = `${project}\nflows in ${repo.projects.find((p) => p.path === project)?.flowsDir ?? '?'}`;
  const counts = new Map();
  for (const r of lastList) counts.set(siteKeyOf(r), (counts.get(siteKeyOf(r)) ?? 0) + 1);
  const scope = currentScope();
  const keys = [...counts.keys()].sort((a, b) => (a === NO_SITE) - (b === NO_SITE) || siteLabel(a).localeCompare(siteLabel(b)));
  if (scope && !counts.has(scope)) keys.push(scope);
  setOptions(el.syncScope, [['', `All flows (${lastList.length})`], ...keys.map((k) => [k, `${siteLabel(k)} (${counts.get(k) ?? 0})`])], scope);
  el.syncScope.hidden = keys.length < 1;
  const n = inScope(scope).length;
  el.syncPush.textContent = `↑ Push ${n} to repo`;
  el.syncPush.disabled = n === 0;
  el.syncPull.disabled = !repo.projects.length && !repo.legacy;
}

async function syncStatus() {
  if (!repo.loaded) await loadProjects();
  if (!repo.projects.length && !repo.legacy) {
    el.syncLine.textContent = repo.error ?? 'No project repository: neither the daemon nor a connected agent has a g9.project.json. Start your agent in the project folder, or add g9.project.json there.';
    return;
  }
  const project = currentProject();
  const site = currentScope() || null;
  let res;
  try {
    res = await cmd({ cmd: 'flowStatus', project, site });
  } catch (err) {
    el.syncLine.textContent = String(err?.message ?? err);
    return;
  }
  if (!res?.ok) {
    el.syncLine.textContent = res?.error ?? 'Could not reach the flow library.';
    return;
  }
  const parts = [];
  if (res.onlyInRepo?.length) parts.push(`↓ ${res.onlyInRepo.length} new in repo`);
  if (res.onlyLocal?.length) parts.push(`↑ ${res.onlyLocal.length} not in repo`);
  if (res.differing?.length) parts.push(`⇅ ${res.differing.length} differ`);
  if (res.approvalNewerInRepo?.length) parts.push(`✓ ${res.approvalNewerInRepo.length} newer approval${res.approvalNewerInRepo.length === 1 ? '' : 's'} in repo — pull`);
  if (res.approvalNewerHere?.length) parts.push(`✓ ${res.approvalNewerHere.length} approval${res.approvalNewerHere.length === 1 ? '' : 's'} only here — push to share`);
  // Copies an earlier Pull made (before 3.1): named, for the person to delete the ones they did not edit.
  if (res.duplicates?.length) {
    parts.push(`⚠ ${res.duplicates.length} flow${res.duplicates.length === 1 ? ' is' : 's are'} here more than once (${res.duplicates.slice(0, 3).map((d) => `"${d.name}" ×${d.copies}`).join(', ')}${res.duplicates.length > 3 ? ', …' : ''}) — from pulls before 3.1; delete the extra copies`);
  }
  const where = repo.legacy ? "The daemon's project (it is older than 3.2: restart it to choose a project or a site)" : `${projectName(project)}${site ? ` · ${siteLabel(site)}` : ''}`;
  el.syncLine.textContent = `${where}: ${parts.length ? parts.join(' · ') : `in sync — ${res.total} flow(s) in the repo`}`;
}

async function pull() {
  const project = currentProject();
  const site = currentScope() || null;
  const res = await cmd({ cmd: 'flowPull', project, site }).catch((err) => ({ ok: false, error: String(err) }));
  if (!res?.ok) return showPanelError(res?.error ?? 'Pull failed.');
  const extra = [
    res.created ? `${res.created} new` : null,
    res.approvals ? `${res.approvals} approval${res.approvals === 1 ? '' : 's'}` : null,
    res.baselines ? `${res.baselines} baseline${res.baselines === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  toast(`${res.imported} flow(s) pulled from ${projectName(project)}${extra.length ? ` — ${extra.join(', ')}` : ''}`);
  // Every problem, not just the last: each one is a flow that did not come over.
  const lines = [...(res.problems ?? [])];
  if (res.newerHere?.length) {
    lines.push(`Kept this browser's approval of ${res.newerHere.length} flow(s), approved here after the repository's: ${res.newerHere.join(', ')}. Push to share it.`);
  }
  if (lines.length) showPanelError(lines.join('\n'));
  syncStatus();
  refresh();
}

async function push(ids) {
  const project = currentProject();
  const res = await cmd({ cmd: 'flowPush', ids, project, site: ids ? null : currentScope() || null }).catch((err) => ({ ok: false, error: String(err) }));
  if (!res?.ok) return showPanelError(res?.error ?? 'Push failed.');
  const approvals = res.approvals ? `, with ${res.approvals} approval${res.approvals === 1 ? '' : 's'}` : '';
  toast(
    res.changed
      ? `${res.changed} flow(s) written to ${projectName(project)}${approvals} — commit them on a branch`
      : `${res.written} flow(s) already up to date in ${projectName(project)}`,
  );
  const lines = [...(res.problems ?? []), ...(res.notes ?? [])];
  if (lines.length) showPanelError(lines.join('\n'));
  syncStatus();
}

/** (3.2) The run history of the flows shown, saved as one HTML file (panel/report.js). */
async function historyReport() {
  const shown = applyFilter(lastList);
  if (!shown.length) return toast('No flows shown, so there is nothing to report');
  const res = await cmd({ cmd: 'recHistory', ids: shown.map((r) => r.id) }).catch((err) => ({ ok: false, error: String(err) }));
  if (!res?.ok) return showPanelError(res?.error ?? 'Could not read the run history.');
  const summary = summarizeHistory(res.recordings);
  const scope = scopeText(filter);
  const saved = downloadText(reportFileName(scope), buildHistoryReport(summary, { scope, product: PRODUCT, version: VERSION }));
  toast(`Saved ${saved} — ${summary.totals.flows} flow(s), ${summary.totals.runs} run(s)`);
}

// -------------------------------------------------------------------- wiring

export function wire() {
  // Two buttons, not one toggle (F8): Record is disabled, with the reason
  // shown, while this tab records; Stop and save is the action then.
  const recordCommand = async (which) => {
    if (recBusy) return;
    if (which === 'recStart' && recording) return; // disabled, but never trust a stale button
    recBusy = true;
    paintRecordControls();
    try {
      const res = await cmd({ cmd: which });
      if (!res?.ok) return showPanelError(res?.error ?? 'Recording command failed.');
      toast(which === 'recStop' ? `Saved "${res.name}" — ${res.steps} steps` : 'Recording — go and use the page');
    } catch (err) {
      showPanelError(`Recording command failed: ${err?.message ?? err}`);
    } finally {
      recBusy = false;
      paintRecordControls();
      refresh();
    }
  };
  el.recToggle.addEventListener('click', () => recordCommand('recStart'));
  el.recStop.addEventListener('click', () => recordCommand('recStop'));

  el.suiteBtn.addEventListener('click', runAll);
  el.syncPull.addEventListener('click', pull);
  el.syncPush.addEventListener('click', () => push());
  el.syncRefresh.addEventListener('click', () => loadProjects().then(syncStatus));
  el.syncProject.addEventListener('change', () => { prefs.set(REPO_KEY, el.syncProject.value || null); paintRepoPickers(); syncStatus(); });
  el.syncScope.addEventListener('change', () => { prefs.set(SCOPE_KEY, el.syncScope.value); paintRepoPickers(); syncStatus(); });
  el.historyBtn.addEventListener('click', historyReport);

  el.fSite.addEventListener('change', () => setFilter({ site: el.fSite.value, suite: '' }));
  el.fSuite.addEventListener('change', () => setFilter({ suite: el.fSuite.value }));
  el.fTag.addEventListener('change', () => setFilter({ tag: el.fTag.value }));
  el.fVerdict.addEventListener('change', () => setFilter({ verdict: el.fVerdict.value }));
  el.fFlaky.addEventListener('click', () => setFilter({ flaky: !filter.flaky }));
  let typing = null;
  el.fSearch.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => setFilter({ q: el.fSearch.value }), 150);
  });
}

export { syncStatus, NO_SUITE, NO_SITE };
export { summarizeHistory } from './report.js';
