/**
 * Diagnosis: the "what is wrong with this page" tool.
 *
 * This is deliberately opinionated. Rather than making the agent run six tools
 * and correlate them, `health` gathers the signals a developer actually checks
 * first — console errors, failed requests, unhandled rejections, broken images,
 * accessibility violations, layout overflow — and returns them ranked.
 */

import { send, evaluate } from '../lib/cdp.js';
import { consoleLog, network } from './observe.js';

export async function health(tabId) {
  const [logs, net, page] = await Promise.all([
    consoleLog(tabId, { limit: 40, level: ['error', 'warning'] }),
    network(tabId, { status: 'failed', limit: 30 }),
    pageAudit(tabId),
  ]);

  const findings = [];

  for (const e of logs.entries) {
    findings.push({
      severity: e.level === 'error' ? 'error' : 'warning',
      kind: 'console',
      // A finding is a pointer, not the payload. Console text is already capped
      // at 2000 chars for browser_console, but 40 of those in one report is
      // 80KB of the agent's context — and the worst offenders are tracking URLs
      // whose first line already says everything. Read the full text with
      // browser_console when a finding warrants it.
      message: brief(e.text, 300),
      where: e.at ?? e.url ?? null,
    });
  }

  for (const r of net.requests) {
    findings.push({
      severity: 'error',
      kind: 'network',
      message: `${r.method} ${r.url} -> ${r.status}`,
      where: r.type,
    });
  }

  findings.push(...page.findings);

  const rank = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || auditFirst(a) - auditFirst(b));

  const { kept, omitted } = capPerSeverity(findings);

  return {
    summary: {
      consoleErrors: logs.counts.error ?? 0,
      consoleWarnings: logs.counts.warning ?? 0,
      failedRequests: net.failedCount,
      brokenImages: page.brokenImages,
      formIssues: page.formIssues,
      overflowing: page.overflowing,
    },
    metrics: page.metrics,
    ...(omitted ? { omittedFindings: omitted } : {}),
    findings: kept,
  };
}

function brief(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars, see browser_console]` : s;
}

/**
 * Kinds produced by the in-page audit rather than by console/network capture.
 *
 * These outrank capture noise at the same severity, and the reason is not
 * aesthetic. They are the only findings this tool produces that no other tool
 * does — an agent can read the console and the request list directly, but
 * nothing else reports an unlabelled input or a horizontally overflowing
 * layout. They are also bounded by construction (a few dozen at most), so
 * giving them priority costs nothing.
 *
 * Learned the hard way, twice: a flat slice buried them, and then a
 * per-severity budget buried them again when 500 console warnings arrived
 * first. The summary said `formIssues: 7` while the findings list contained
 * none of them — a report contradicting itself in the same response.
 */
const AUDIT_KINDS = new Set(['a11y', 'layout', 'dom', 'asset']);

function auditFirst(finding) {
  return AUDIT_KINDS.has(finding.kind) ? 0 : 1;
}

/** Per-severity budgets, tuned so the report stays readable in a context window. */
const BUDGET = { error: 30, warning: 20, info: 10 };

/**
 * Cap the report without letting one severity crowd out another.
 *
 * A flat `slice(60)` after a severity sort looks reasonable and is not: a page
 * with 60+ console errors (any site carrying ad tech clears that easily) pushed
 * every warning past the cut. The findings lost were the accessibility, layout,
 * and duplicate-ID checks — the ones nothing else in the toolset produces, and
 * the whole reason to call this tool rather than reading the console.
 */
function capPerSeverity(findings) {
  const seen = { error: 0, warning: 0, info: 0 };
  const kept = [];
  let omitted = 0;

  for (const f of findings) {
    const severity = f.severity in BUDGET ? f.severity : 'info';
    if (seen[severity] < BUDGET[severity]) {
      seen[severity] += 1;
      kept.push(f);
    } else {
      omitted += 1;
    }
  }

  return { kept, omitted };
}

/** In-page checks that need DOM access rather than CDP domains. */
async function pageAudit(tabId) {
  const audit = await evaluate(
    tabId,
    `(() => {
      const findings = [];

      // Images that failed to load.
      const broken = [...document.images].filter(i => i.complete && i.naturalWidth === 0);
      for (const img of broken.slice(0, 15)) {
        findings.push({ severity: 'error', kind: 'asset', message: 'Broken image: ' + (img.currentSrc || img.src || '(no src)'), where: 'img' });
      }

      // Form controls with no accessible label — the single most common a11y
      // defect, and it also breaks agent interaction.
      const unlabeled = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter(el => {
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.title) return false;
        if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return false;
        return !el.closest('label');
      });
      for (const el of unlabeled.slice(0, 15)) {
        findings.push({ severity: 'warning', kind: 'a11y', message: 'Form control has no accessible label: <' + el.tagName.toLowerCase() + (el.name ? ' name="' + el.name + '"' : '') + '>', where: 'form' });
      }

      // Buttons and links with no discernible text.
      const nameless = [...document.querySelectorAll('button, a[href]')].filter(el =>
        !el.innerText.trim() && !el.getAttribute('aria-label') && !el.title && !el.querySelector('img[alt]:not([alt=""])')
      );
      for (const el of nameless.slice(0, 10)) {
        findings.push({ severity: 'warning', kind: 'a11y', message: 'Interactive element has no accessible name: <' + el.tagName.toLowerCase() + '>', where: 'a11y' });
      }

      // Horizontal overflow — the classic responsive bug.
      const de = document.documentElement;
      const overflowing = de.scrollWidth > de.clientWidth + 1;
      if (overflowing) {
        const culprits = [...document.querySelectorAll('body *')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.right > de.clientWidth + 1 && r.width > 0;
        }).slice(0, 5).map(el => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : ''));
        findings.push({ severity: 'warning', kind: 'layout', message: 'Page scrolls horizontally (' + de.scrollWidth + 'px content in ' + de.clientWidth + 'px viewport). Widest offenders: ' + culprits.join(', '), where: 'layout' });
      }

      // Duplicate element IDs break querySelector and label association.
      const ids = {}; const dupes = [];
      for (const el of document.querySelectorAll('[id]')) {
        ids[el.id] = (ids[el.id] || 0) + 1;
        if (ids[el.id] === 2) dupes.push(el.id);
      }
      if (dupes.length) {
        findings.push({ severity: 'warning', kind: 'dom', message: 'Duplicate element IDs: ' + dupes.slice(0, 10).join(', '), where: 'dom' });
      }

      const nav = performance.getEntriesByType('navigation')[0];
      const paints = performance.getEntriesByType('paint');

      return {
        findings,
        brokenImages: broken.length,
        formIssues: unlabeled.length + nameless.length,
        overflowing,
        metrics: {
          domNodes: document.querySelectorAll('*').length,
          domDepth: (function d(el, n) { let m = n; for (const c of el.children) m = Math.max(m, d(c, n + 1)); return m; })(document.documentElement, 1),
          listeners: null,
          domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
          loadMs: nav ? Math.round(nav.loadEventEnd) : null,
          firstContentfulPaintMs: Math.round(paints.find(p => p.name === 'first-contentful-paint')?.startTime ?? 0) || null,
          transferredBytes: nav ? nav.transferSize : null,
        }
      };
    })()`,
  );

  return audit ?? { findings: [], brokenImages: 0, formIssues: 0, overflowing: false, metrics: {} };
}

/**
 * Performance trace. Returns aggregate numbers rather than the raw trace —
 * a raw Chrome trace is megabytes and useless in an agent's context window.
 */
export async function performance(tabId, { durationMs = 4000, reload = false } = {}) {
  await send(tabId, 'Tracing.start', {
    categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline',
    transferMode: 'ReturnAsStream',
  });

  if (reload) await send(tabId, 'Page.reload', { ignoreCache: false });
  await new Promise((r) => setTimeout(r, durationMs));

  const streamHandle = await new Promise((resolve, reject) => {
    const chrome = globalThis.chrome ?? globalThis.browser;
    const timer = setTimeout(() => reject(new Error('Tracing did not complete in time')), 20_000);
    const onEvent = (source, method, params) => {
      if (source.tabId !== tabId || method !== 'Tracing.tracingComplete') return;
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(onEvent);
      resolve(params.stream);
    };
    chrome.debugger.onEvent.addListener(onEvent);
    send(tabId, 'Tracing.end').catch(reject);
  });

  const events = await readTraceStream(tabId, streamHandle);
  return summarizeTrace(events);
}

async function readTraceStream(tabId, handle) {
  let buffer = '';
  for (;;) {
    const { data, eof } = await send(tabId, 'IO.read', { handle, size: 1_000_000 });
    buffer += data;
    if (eof) break;
  }
  await send(tabId, 'IO.close', { handle }).catch(() => {});
  try {
    const parsed = JSON.parse(buffer);
    return Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
  } catch {
    return [];
  }
}

/** Roll a raw trace into the handful of numbers a developer would look at. */
function summarizeTrace(events) {
  const byName = new Map();
  let longTasks = 0;
  let longestTaskMs = 0;

  for (const e of events) {
    if (e.ph !== 'X' || !e.dur) continue;
    const ms = e.dur / 1000;
    byName.set(e.name, (byName.get(e.name) ?? 0) + ms);
    if (e.name === 'RunTask' && ms > 50) {
      longTasks++;
      longestTaskMs = Math.max(longestTaskMs, ms);
    }
  }

  const top = [...byName.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, ms]) => ({ name, totalMs: Math.round(ms) }));

  const pick = (name) => Math.round(byName.get(name) ?? 0);

  return {
    eventCount: events.length,
    longTasks,
    longestTaskMs: Math.round(longestTaskMs),
    breakdown: {
      scriptingMs: pick('EvaluateScript') + pick('FunctionCall') + pick('v8.run'),
      stylesMs: pick('UpdateLayoutTree') + pick('ParseAuthorStyleSheet'),
      layoutMs: pick('Layout'),
      paintMs: pick('Paint') + pick('CompositeLayers'),
    },
    topActivities: top,
  };
}
