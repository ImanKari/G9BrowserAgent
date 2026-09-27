/**
 * The run-history report (3.2): the flows the Automation filter shows, with the last runs of each,
 * as one self-contained HTML file to keep, mail or attach to a ticket.
 *
 * Run history is a fact about ONE machine, so it never goes into the repository (daemon/flows.js
 * LOCAL_ONLY): a replay would dirty the working tree every time. What the team needs from it —
 * which flows pass, which are flaky, what ran when — travels as this report instead.
 *
 * Built as a DOM document with textContent only and serialised once; nothing here builds HTML from
 * strings (panel rule, setup/unit/panel.test.mjs). The data rides along as JSON for a script to
 * read, with every "<" escaped so no value can end its element.
 */

import { siteOf, displayUrl } from '../lib/sites.js';

const OK = new Set(['PASS', 'PASS_WITH_WARNING']);
const LABEL = {
  PASS: 'Pass',
  PASS_WITH_WARNING: 'Warnings',
  SURPRISE: 'Surprise',
  FAIL_PRODUCT: 'Product fail',
  FAIL_AUTOMATION: 'Test fail',
  SKIPPED: 'Skipped',
  NOT_RUN: 'Not run',
  none: 'Never run',
};
const COLOR = {
  PASS: '#16803c',
  PASS_WITH_WARNING: '#b46a00',
  SURPRISE: '#5b50d6',
  FAIL_PRODUCT: '#c62828',
  FAIL_AUTOMATION: '#d4560b',
  SKIPPED: '#0e7490',
  NOT_RUN: '#64748b',
  none: '#8a8f98',
};

const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
/** A run from before v1.7 has no verdict, only counts: that much is said, and no more. */
const verdictOf = (run) => (LABEL[run?.verdict] ? run.verdict : run?.failed ? 'FAIL_AUTOMATION' : 'PASS');

/**
 * What the report says, from full recordings. Pure; exported for the unit test.
 * @returns {{ flows: object[], totals: { flows, runs, passed, flaky, neverRun, sites } }}
 */
export function summarizeHistory(recordings) {
  const flows = (Array.isArray(recordings) ? recordings : []).filter(Boolean).map((r) => {
    const runs = (Array.isArray(r.runHistory) ? r.runHistory : [])
      .filter((x) => x && Number.isFinite(Number(x.at)))
      .map((x) => ({
        at: Number(x.at),
        verdict: verdictOf(x),
        durationMs: Number.isFinite(Number(x.durationMs)) ? Number(x.durationMs) : null,
        surprises: Number(x.surprises) || 0,
      }))
      .sort((a, b) => a.at - b.at);
    const passed = runs.filter((x) => OK.has(x.verdict)).length;
    const durations = runs.map((x) => x.durationMs).filter((x) => x != null);
    const approved = r.knownWorld && Number.isFinite(r.knownWorld.approvedAt) && r.knownWorld.approvedBy !== 'seed';
    return {
      id: String(r.id ?? ''),
      flowId: String(r.flowId ?? r.id ?? ''),
      name: typeof r.name === 'string' && r.name ? r.name : '(unnamed)',
      site: siteOf(r.startUrl) ?? 'none',
      startUrl: typeof r.startUrl === 'string' ? r.startUrl : null,
      suite: typeof r.suite === 'string' && r.suite.trim() ? r.suite.trim() : null,
      tags: list(r.tags),
      testCases: list(r.qaTestCaseIds),
      environment: typeof r.environment === 'string' ? r.environment : (typeof r.environment?.name === 'string' ? r.environment.name : null),
      checks: (r.steps ?? []).filter((s) => s?.type === 'assert').length,
      runs,
      passed,
      passRate: runs.length ? passed / runs.length : null,
      last: runs.length ? runs[runs.length - 1].verdict : 'none',
      flaky: !!(r.flaky === true || r.flaky?.detected),
      meanMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      approvedAt: approved ? r.knownWorld.approvedAt : null,
      approvedBy: approved ? (r.knownWorld.approvedBy ?? null) : null,
    };
  });
  flows.sort((a, b) => a.site.localeCompare(b.site) || String(a.suite ?? '￿').localeCompare(String(b.suite ?? '￿')) || a.name.localeCompare(b.name));
  return {
    flows,
    totals: {
      flows: flows.length,
      runs: flows.reduce((n, f) => n + f.runs.length, 0),
      passed: flows.reduce((n, f) => n + f.passed, 0),
      flaky: flows.filter((f) => f.flaky).length,
      neverRun: flows.filter((f) => !f.runs.length).length,
      sites: new Set(flows.map((f) => f.site)).size,
    },
  };
}

/** A file name for the report: `g9-history-<scope>-<yyyy-mm-dd>.html`, safe on every OS. */
export function reportFileName(scope, at = Date.now()) {
  const day = new Date(at).toISOString().slice(0, 10);
  const slug = String(scope ?? 'all').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'all';
  return `g9-history-${slug}-${day}.html`;
}

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const secs = (ms) => (ms == null ? '—' : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const when = (t) => (t ? new Date(t).toLocaleString() : '—');
const siteName = (site) => {
  if (site === 'none') return 'No start URL';
  const d = displayUrl(site);
  return d.origin?.startsWith('https://') ? d.host : (d.origin ?? site);
};

const STYLE = [
  ':root{color-scheme:light dark;--fg:#1d1d24;--muted:#5d6270;--line:#d9dbe1;--bg:#fff;--card:#f6f7f9}',
  '@media (prefers-color-scheme:dark){:root{--fg:#e8e8ee;--muted:#a3a7b3;--line:#383a46;--bg:#15151b;--card:#1e1f27}}',
  'body{margin:0;padding:24px;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg)}',
  'h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}p.meta{color:var(--muted);margin:0 0 16px}',
  '.totals{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0 8px}.totals div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px}',
  '.totals b{display:block;font-size:18px}table{border-collapse:collapse;width:100%;margin:4px 0 8px}',
  'th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600;font-size:12px}',
  '.v{display:inline-block;padding:1px 8px;border-radius:10px;color:#fff;font-size:12px;white-space:nowrap}',
  '.strip{display:flex;gap:2px;flex-wrap:wrap;max-width:320px}.strip span{width:10px;height:14px;border-radius:2px;display:inline-block}',
  '.muted{color:var(--muted)}.num{text-align:right;font-variant-numeric:tabular-nums}.flaky{color:#b46a00;font-weight:600}',
  '@media print{body{padding:0}.strip span{-webkit-print-color-adjust:exact;print-color-adjust:exact}}',
].join('\n');

/**
 * The report as one HTML document string. Needs a DOM (the panel); `summary` is summarizeHistory's.
 * @param {{ scope: string, at?: number, product?: string, version?: string }} o
 */
export function buildHistoryReport(summary, { scope = 'all flows', at = Date.now(), product = 'G9BrowserAgent', version = '' } = {}) {
  const doc = document.implementation.createHTMLDocument(`${product} — history — ${scope}`);
  const make = (tag, text, cls) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };
  const meta = doc.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  doc.head.prepend(meta);
  const viewport = doc.createElement('meta');
  viewport.setAttribute('name', 'viewport');
  viewport.setAttribute('content', 'width=device-width, initial-scale=1');
  doc.head.append(viewport, make('style', STYLE));

  const { flows, totals } = summary;
  doc.body.append(
    make('h1', `Run history — ${scope}`),
    make('p', `${product}${version ? ` v${version}` : ''} · generated ${when(at)} · this browser's own runs (run history stays on the machine that ran it; the flows and their approvals are in the repository)`, 'meta'),
  );
  const box = make('div', null, 'totals');
  for (const [label, value] of [
    ['flows', totals.flows],
    ['runs', totals.runs],
    ['passed', totals.runs ? pct(totals.passed / totals.runs) : '—'],
    ['flaky', totals.flaky],
    ['never run', totals.neverRun],
  ]) {
    const d = make('div');
    d.append(make('b', value), make('span', label, 'muted'));
    box.append(d);
  }
  doc.body.append(box);

  const bySite = new Map();
  for (const f of flows) {
    if (!bySite.has(f.site)) bySite.set(f.site, []);
    bySite.get(f.site).push(f);
  }
  for (const [site, rows] of bySite) {
    const h = make('h2', `${siteName(site)} — ${rows.length} flow${rows.length === 1 ? '' : 's'}`);
    if (site !== 'none') h.title = site;
    doc.body.append(h);
    const table = doc.createElement('table');
    const head = doc.createElement('tr');
    for (const t of ['Flow', 'Suite', 'Last', 'Recent runs (oldest → newest)', 'Runs', 'Pass rate', 'Mean time', 'Approved']) head.append(make('th', t));
    const thead = doc.createElement('thead');
    thead.append(head);
    const tbody = doc.createElement('tbody');
    for (const f of rows) {
      const tr = doc.createElement('tr');
      const name = make('td');
      name.append(make('div', f.name));
      const sub = [f.environment, f.checks ? `${f.checks} check${f.checks === 1 ? '' : 's'}` : 'macro — no checks', ...f.tags, ...f.testCases].filter(Boolean).join(' · ');
      name.append(make('div', sub, 'muted'));
      if (f.flaky) name.append(make('div', 'flaky', 'flaky'));
      const last = make('td');
      const tag = make('span', LABEL[f.last] ?? f.last, 'v');
      tag.style.background = COLOR[f.last] ?? COLOR.none;
      last.append(tag);
      const strip = make('div', null, 'strip');
      for (const run of f.runs) {
        const s = make('span');
        s.style.background = COLOR[run.verdict] ?? COLOR.none;
        s.title = `${when(run.at)} — ${LABEL[run.verdict] ?? run.verdict}${run.durationMs != null ? `, ${secs(run.durationMs)}` : ''}${run.surprises ? `, ${run.surprises} surprise(s)` : ''}`;
        strip.append(s);
      }
      const stripCell = make('td');
      stripCell.append(f.runs.length ? strip : make('span', 'never run', 'muted'));
      tr.append(
        name,
        make('td', f.suite ?? '—', f.suite ? null : 'muted'),
        last,
        stripCell,
        make('td', f.runs.length, 'num'),
        make('td', pct(f.passRate), 'num'),
        make('td', secs(f.meanMs), 'num'),
        make('td', f.approvedAt ? `${when(f.approvedAt)}${f.approvedBy ? ` by ${f.approvedBy}` : ''}` : 'not approved', f.approvedAt ? null : 'muted'),
      );
      tbody.append(tr);
    }
    table.append(thead, tbody);
    doc.body.append(table);
  }
  if (!flows.length) doc.body.append(make('p', 'No flows in this scope.', 'muted'));

  // The same facts for a script: JSON in an inert element, every "<" escaped.
  const data = doc.createElement('script');
  data.type = 'application/json';
  data.id = 'g9-history';
  data.textContent = JSON.stringify({ format: 'g9-history', version: 1, scope, generatedAt: at, product, productVersion: version, ...summary })
    .replace(/</g, '\\u003c');
  doc.body.append(data);

  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}\n`;
}
