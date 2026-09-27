/**
 * Run reports: JSON, JUnit, HTML, and the QA-suite status file.
 *
 * Four formats because four audiences read them, and a format that serves two
 * of them badly serves neither:
 *
 * - `run.json` — the machine record. Everything, unabridged; a triage worker
 *   reads this.
 * - `junit.xml` — every CI on earth already parses it. Surprises appear as
 *   test cases in their own right, because a surprise that only exists in a
 *   custom format is a surprise nobody sees.
 * - `report.html` — a single self-contained file a QA can open by
 *   double-clicking. No CDN, no build step; the same rule the manual QA suite
 *   in this product already follows.
 * - `qa-automation-status.json` — one line per QA test-case id, so the existing
 *   manual suite can show which scenarios are already covered automatically.
 *   This is the file that turns "we have automation" into "you can skip these
 *   twelve scenarios today".
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * How each verdict is shown, and — the part that matters — what the reader
 * should DO about it.
 *
 * The audience for this file is a tester, not the person who wrote the runner.
 * A report that says `FAIL_AUTOMATION` and stops has named a category; it has
 * not told anybody whether to file a bug, re-run, or call somebody. Each verdict
 * therefore carries one sentence of instruction, in the language the team uses.
 *
 * `advice` is deliberately about the NEXT ACTION rather than the cause: the
 * cause is in the step message right below it, and a reader who does not know
 * what to do next will not get as far as reading it.
 */
const VERDICT_STYLE = {
  PASS: {
    colour: '#15803d',
    label: 'PASS',
    fa: 'قبول',
    advice: 'همه‌چیز درست کار کرد. کاری لازم نیست.',
  },
  PASS_WITH_WARNING: {
    colour: '#a16207',
    label: 'PASS (warnings)',
    fa: 'قبول با هشدار',
    advice: 'تست رد شد، ولی چیزی سر جایش نبود. اگر تکرار شد، به برنامه‌نویس بگو.',
  },
  SURPRISE: {
    colour: '#b45309',
    label: 'SURPRISE',
    fa: 'تغییر غیرمنتظره',
    advice: 'صفحه با دفعهٔ قبل فرق دارد. اگر تغییر عمدی بوده، بگذار تأییدش کنند؛ وگرنه گزارشش کن.',
  },
  FAIL_PRODUCT: {
    colour: '#b91c1c',
    label: 'FAIL — product',
    fa: 'ایراد در برنامه',
    advice: 'این یک باگ واقعی است. ثبتش کن و متن خطای پایین را هم بگذار.',
  },
  FAIL_AUTOMATION: {
    colour: '#6d28d9',
    label: 'FAIL — automation',
    fa: 'ایراد در ابزار تست',
    advice: 'باگ برنامه نیست — ابزار نتوانست کارش را تمام کند. به عنوان باگ ثبت نکن؛ به برنامه‌نویس بگو.',
  },
  ERROR: {
    colour: '#b91c1c',
    label: 'ERROR',
    fa: 'خطا',
    advice: 'تست نیمه‌کاره ماند. متن خطا را برای برنامه‌نویس بفرست.',
  },
};

export async function writeReports(dir, run) {
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(path.join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8'),
    writeFile(path.join(dir, 'junit.xml'), junit(run), 'utf8'),
    writeFile(path.join(dir, 'report.html'), html(run), 'utf8'),
    writeFile(path.join(dir, 'qa-automation-status.json'), `${JSON.stringify(qaStatus(run), null, 2)}\n`, 'utf8'),
  ]);
  return dir;
}

// ------------------------------------------------------------------- JUnit

function junit(run) {
  const cases = [];
  for (const flow of run.flows) {
    const name = esc(flow.name ?? flow.id);
    const time = ((flow.durationMs ?? 0) / 1000).toFixed(3);

    if (flow.verdict === 'PASS' || flow.verdict === 'PASS_WITH_WARNING') {
      cases.push(`    <testcase classname="g9.flow" name="${name}" time="${time}"/>`);
    } else {
      const kind = flow.verdict === 'FAIL_AUTOMATION' ? 'error' : 'failure';
      const message = esc(flow.failureMessage ?? flow.verdict);
      cases.push(
        `    <testcase classname="g9.flow" name="${name}" time="${time}">\n` +
        `      <${kind} message="${message}" type="${flow.verdict}">${esc(flow.detail ?? '')}</${kind}>\n` +
        `    </testcase>`,
      );
    }

    // Surprises are their own test cases. A run that passed every assertion but
    // started emitting a new console error is not a green run, and burying that
    // in a summary field means CI never shows it.
    for (const surprise of flow.surprises ?? []) {
      const surpriseName = esc(`${name} :: surprise ${surprise.kind} ${surprise.layer}: ${surprise.key}`);
      if (surprise.effectiveSeverity === 'fail') {
        cases.push(
          `    <testcase classname="g9.surprise" name="${surpriseName}" time="0">\n` +
          `      <failure message="${esc(surprise.detail ?? '')}" type="SURPRISE"/>\n` +
          `    </testcase>`,
        );
      } else {
        cases.push(
          `    <testcase classname="g9.surprise" name="${surpriseName}" time="0">\n` +
          `      <skipped message="${esc(surprise.detail ?? '')}"/>\n` +
          `    </testcase>`,
        );
      }
    }
  }

  const failures = run.flows.filter((f) => f.verdict === 'FAIL_PRODUCT' || f.verdict === 'SURPRISE').length;
  const errors = run.flows.filter((f) => f.verdict === 'FAIL_AUTOMATION' || f.verdict === 'ERROR').length;

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="G9BrowserAgent" tests="${cases.length}" failures="${failures}" errors="${errors}" time="${((run.durationMs ?? 0) / 1000).toFixed(3)}">
  <testsuite name="${esc(run.suite ?? 'g9')}" tests="${cases.length}" failures="${failures}" errors="${errors}" timestamp="${new Date(run.startedAt).toISOString()}">
${properties(run)}${cases.join('\n')}
  </testsuite>
</testsuites>
`;
}

// -------------------------------------------------------------------- HTML

function html(run) {
  const rows = run.flows.map((flow) => {
    const style = VERDICT_STYLE[flow.verdict] ?? VERDICT_STYLE.ERROR;
    const surprises = (flow.surprises ?? []).map((s) => `
        <li class="s-${s.effectiveSeverity ?? s.severity}">
          <code>${s.kind === 'new' ? '+' : '−'}</code>
          <b>${escHtml(s.layer)}</b> ${escHtml(s.key)}
          ${s.confirmed === false ? '<em>(unconfirmed)</em>' : ''}
          <span>${escHtml(s.detail ?? '')}</span>
        </li>`).join('');
    const steps = (flow.steps ?? []).filter((s) => !s.ok || s.matchedBy && !['testid', 'role', 'label'].includes(s.matchedBy)).map((s) => `
        <li class="${s.ok ? 'warn' : 'bad'}">step ${s.step} (${escHtml(s.type)}) — ${escHtml(s.error ?? `matched only by ${s.matchedBy}`)}</li>`).join('');

    return `
    <section>
      <h2><span class="badge" style="background:${style.colour}">${style.fa}</span> ${escHtml(flow.name ?? flow.id)}</h2>
      <p class="advice">${style.advice}</p>
      <p class="meta">${flow.passed ?? 0} از ${flow.total ?? 0} مرحله · ${Math.round((flow.durationMs ?? 0) / 100) / 10} ثانیه
        ${flow.knownWorld?.runs ? ` · ${flow.knownWorld.runs} اجرای تأییدشده` : ' · <b>اولین اجرا</b>'}
        ${flow.flaky ? ' · <b>ناپایدار</b>' : ''}
        · <span dir="ltr">${escHtml(flow.verdict)}</span></p>
      ${steps ? `<h3>مراحلی که باید نگاه کنی</h3><ul class="steps" dir="ltr">${steps}</ul>` : ''}
      ${surprises ? `<h3>تغییرات غیرمنتظره</h3><ul class="surprises" dir="ltr">${surprises}</ul>` : ''}
    </section>`;
  }).join('');

  const counts = run.flows.reduce((acc, f) => { acc[f.verdict] = (acc[f.verdict] ?? 0) + 1; return acc; }, {});

  return `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>گزارش تست — ${escHtml(run.suite ?? 'all')}</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --bg:#fff; --muted:#666; --line:#e5e5e5; --card:#fafafa; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --bg:#141414; --muted:#9a9a9a; --line:#2a2a2a; --card:#1c1c1c; } }
  body { font:15px/1.8 Vazirmatn,Segoe UI,Tahoma,ui-sans-serif,system-ui,sans-serif; margin:0; padding:32px; color:var(--fg); background:var(--bg); }
  .advice { margin:0 0 10px; font-size:14px; }
  ul.steps, ul.surprises { text-align:left; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:16px; margin:0 0 6px; }
  h3 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:14px 0 4px; }
  .meta { color:var(--muted); margin:0 0 8px; font-size:12px; }
  .summary { display:flex; gap:10px; flex-wrap:wrap; margin:14px 0 26px; }
  .pill { border:1px solid var(--line); border-radius:999px; padding:4px 12px; font-size:12px; }
  section { border:1px solid var(--line); background:var(--card); border-radius:10px; padding:16px 18px; margin-bottom:14px; }
  .badge { color:#fff; border-radius:5px; padding:2px 8px; font-size:11px; font-weight:600; margin-left:8px; }
  ul { margin:0; padding-right:18px; padding-left:0; } li { margin:3px 0; }
  li span { color:var(--muted); display:block; font-size:12px; }
  .s-fail { color:#b91c1c; } .s-warn { color:#a16207; } .s-info { color:var(--muted); }
  .bad { color:#b91c1c; } .warn { color:#a16207; }
  code { background:rgba(127,127,127,.15); padding:0 4px; border-radius:3px; }
  footer { color:var(--muted); font-size:12px; margin-top:24px; }
</style></head><body>
<h1>گزارش تست — ${escHtml(run.suite ?? 'همهٔ سناریوها')}</h1>
<p class="meta">${new Date(run.startedAt).toLocaleString('fa-IR')} · محیط <b>${escHtml(run.environment ?? 'default')}</b> · ${Math.round((run.durationMs ?? 0) / 100) / 10} ثانیه${run.pinned ? ' · <b>شبکه ثابت‌شده</b>' : ''}</p>
${runFacts(run)}
<div class="summary">${Object.entries(counts).map(([verdict, n]) =>
  `<span class="pill" style="border-color:${(VERDICT_STYLE[verdict] ?? VERDICT_STYLE.ERROR).colour}">${(VERDICT_STYLE[verdict] ?? VERDICT_STYLE.ERROR).fa}: <b>${n}</b></span>`).join('')}</div>
${rows}
<footer>ساختهٔ runner خودکار. «تغییر غیرمنتظره» یعنی صفحه کاری کرد که تا امروز نکرده بود —
الزاماً باگ نیست، ولی هیچ‌وقت هم هیچ نیست.</footer>
</body></html>
`;
}

// ------------------------------------------------------------- run facts (v2)

/**
 * What ran the flows, and with which random seed. A report that cannot say
 * which browser build produced it cannot be compared with the next one, and a
 * humanized run that failed can only be replayed with identical motion if its
 * seed was written down.
 */
function engineLabel(run) {
  const e = run.engine;
  if (!e) return null;
  const mode = e.kind === 'extension' ? 'extension' : (e.headless === false ? 'headed' : 'headless');
  const parts = [e.browser ?? e.kind ?? 'browser', e.version ?? ''].filter(Boolean).join(' ');
  const extra = [mode, e.profile ? `profile ${e.profile}` : null, e.engineId ?? null].filter(Boolean).join(', ');
  return `${parts} (${extra})`;
}

function properties(run) {
  const props = [];
  const add = (name, value) => {
    if (value != null && value !== '') props.push(`      <property name="${esc(name)}" value="${esc(value)}"/>`);
  };
  add('g9.engine', engineLabel(run));
  add('g9.daemon.version', run.daemon?.version);
  add('g9.humanize.level', run.humanize ? (run.humanize.level ?? 'default') : null);
  add('g9.humanize.seed', run.humanize?.seed);
  add('g9.environment', run.environment);
  return props.length ? `    <properties>\n${props.join('\n')}\n    </properties>\n` : '';
}

function runFacts(run) {
  const bits = [];
  const engine = engineLabel(run);
  if (engine) bits.push(`موتور <b dir="ltr">${escHtml(engine)}</b>`);
  if (run.humanize?.seed != null) {
    bits.push(`seed حرکت <code dir="ltr">${escHtml(run.humanize.seed)}</code>${run.humanize.level ? ` (${escHtml(run.humanize.level)})` : ''}`);
  }
  if (run.daemon?.version) bits.push(`G9BrowserAgent <span dir="ltr">v${escHtml(run.daemon.version)}</span>`);
  return bits.length ? `<p class="meta">${bits.join(' · ')}</p>` : '';
}

// ------------------------------------------------------------- QA suite link

/**
 * `{ "TC-06-01": { status, runId, at, build } }`
 *
 * Deliberately a separate small file rather than a section of run.json: the
 * manual QA suite is an offline HTML document with no network access, and the
 * only thing it can reasonably do is let a tester pick a file off disk.
 */
function qaStatus(run) {
  const out = { format: 'g9/qa-automation-status', version: 1, at: run.startedAt, environment: run.environment ?? null, cases: {} };
  for (const flow of run.flows) {
    for (const id of flow.qaTestCaseIds ?? []) {
      const existing = out.cases[id];
      const status = flow.verdict;
      // Worst verdict wins: a case covered by two flows is only green when both are.
      if (!existing || rank(status) > rank(existing.status)) {
        out.cases[id] = { status, flowId: flow.id, flowName: flow.name, at: run.startedAt, durationMs: flow.durationMs };
      }
    }
  }
  return out;
}

const RANK = { PASS: 0, PASS_WITH_WARNING: 1, SURPRISE: 2, FAIL_AUTOMATION: 3, FAIL_PRODUCT: 4, ERROR: 5 };
const rank = (verdict) => RANK[verdict] ?? 5;

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // Control characters are illegal in XML 1.0 and a stack trace can contain them.
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

const escHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
