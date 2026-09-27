/**
 * Diagnosis: the "what is wrong with this page" tool.
 *
 * This is deliberately opinionated. Rather than making the agent run six tools
 * and correlate them, `health` gathers the signals a developer actually checks
 * first — console errors, failed requests, unhandled rejections, broken images,
 * accessibility violations, layout overflow — and returns them ranked.
 */

import { platform } from '../lib/platform.js';
import { send } from '../lib/cdp.js';
import { inWorld } from '../lib/world.js';
import { consoleLog, network } from './observe.js';

// The in-page audit and the vitals observers run in G9BrowserAgent's isolated world: they
// see the same DOM and the same performance timeline, and they leave nothing on
// the page's own window — so the page is measured without G9BrowserAgent inside it.

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
      accessibilityIssues: page.accessibilityIssues,
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
  const audit = await inWorld(
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

      const missingAlt = [...document.querySelectorAll('img:not([alt])')];
      for (const el of missingAlt.slice(0, 10)) {
        findings.push({ severity: 'warning', kind: 'a11y', message: 'Image has no alt attribute: ' + (el.currentSrc || el.src || '<img>'), where: 'image' });
      }
      const untitledFrames = [...document.querySelectorAll('iframe:not([title])')];
      for (const el of untitledFrames.slice(0, 10)) {
        findings.push({ severity: 'warning', kind: 'a11y', message: 'Iframe has no title: ' + (el.src || '<iframe>'), where: 'frame' });
      }
      if (!document.documentElement.lang) {
        findings.push({ severity: 'warning', kind: 'a11y', message: 'Document has no language on <html lang>. Screen readers cannot choose the correct pronunciation rules.', where: 'document' });
      }
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')];
      for (let index = 1; index < headings.length; index++) {
        const previous = Number(headings[index - 1].tagName.slice(1));
        const current = Number(headings[index].tagName.slice(1));
        if (current > previous + 1) {
          findings.push({ severity: 'warning', kind: 'a11y', message: 'Heading level jumps from h' + previous + ' to h' + current + ': ' + headings[index].textContent.trim().slice(0, 80), where: 'heading' });
        }
      }

      // Horizontal overflow — the classic responsive bug.
      const de = document.documentElement;
      const overflowing = de.scrollWidth > de.clientWidth + 1;
      if (overflowing) {
        // Name the CAUSE, not the victims.
        //
        // The old version took the first five elements in DOCUMENT ORDER whose
        // right edge passed the viewport and called them "widest offenders".
        // Both halves were wrong. Once a page overflows, every centred or
        // full-width ancestor is dragged past the viewport too, so the earliest
        // elements in the document are almost always innocent: on the seeded
        // test page this reported "div, h1, p.lede, section, h2" and never
        // mentioned the 2400px block that actually caused it.
        //
        // An element earns the blame when it is wider than the room its parent
        // gives it — that is the box that forced the scrollbar, rather than one
        // that was stretched by it.
        const name = (el) => el.tagName.toLowerCase() +
          (el.id ? '#' + el.id : '') +
          (el.className && typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\\s+/)[0] : '');

        // Width alone cannot separate cause from victim, which is the trap the
        // first two versions of this fell into. Once a document overflows, its
        // containing block grows, and every auto-width block inside stretches
        // to match — so on the seeded page the 2400px culprit and thirty-one
        // innocent ancestors and siblings all measure 2400-2434px. Ranking by
        // width, or by how far something exceeds its parent, ranks noise.
        //
        // What actually marks a cause is evidence that the element's width came
        // from the element rather than from the layout around it. Each signal
        // below is weak alone and decisive together: on the test page this
        // scores the real culprit 4 and everything else 1.
        const INTRINSIC = ['IMG', 'TABLE', 'PRE', 'IFRAME', 'VIDEO', 'CANVAS', 'OBJECT', 'EMBED'];
        const suspects = [...document.querySelectorAll('body *')].map((el) => {
          const r = el.getBoundingClientRect();
          if (r.width <= de.clientWidth + 1) return null;
          const why = [];
          let score = 0;
          if (!el.children.length && !(el.textContent || '').trim()) {
            score += 3; why.push('an empty box this wide was given an explicit width');
          }
          if (el.scrollWidth > el.clientWidth + 1) {
            score += 2; why.push('its own content does not fit inside it');
          }
          if (INTRINSIC.indexOf(el.tagName) >= 0) {
            score += 2; why.push('intrinsically sized element');
          }
          const widestChild = el.children.length
            ? Math.max.apply(null, [].map.call(el.children, (c) => c.getBoundingClientRect().width))
            : 0;
          if (widestChild < r.width - 1) {
            score += 1; why.push('no child accounts for its width');
          }
          return { el, width: r.width, score, why };
        }).filter(Boolean).sort((a, b) => b.score - a.score || b.width - a.width);

        const best = suspects[0];
        const listed = suspects.slice(0, 5)
          .map((s) => name(s.el) + ' (' + Math.round(s.width) + 'px)').join(', ');

        findings.push({
          severity: 'warning',
          kind: 'layout',
          message: 'Page scrolls horizontally (' + de.scrollWidth + 'px content in ' + de.clientWidth +
            'px viewport). ' +
            (!best
              ? 'No single element is wider than the viewport, so the overflow is cumulative — check margins, absolute positioning, or transforms.'
              : best.score >= 3
                ? 'Most likely cause: ' + name(best.el) + ' at ' + Math.round(best.width) + 'px — ' +
                  best.why[0] + '. Also over the viewport: ' + listed + '.'
                : 'No element stands out as the cause; everything over the viewport looks stretched by the ' +
                  'overflow rather than causing it. Widest: ' + listed + '.'),
          where: 'layout',
        });
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
        accessibilityIssues: unlabeled.length + nameless.length + missingAlt.length + untitledFrames.length +
          (document.documentElement.lang ? 0 : 1) +
          findings.filter((finding) => finding.kind === 'a11y' && finding.where === 'heading').length,
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

  // The completion arrives as an event, so listen on the platform's event
  // stream for exactly this tab's Tracing.tracingComplete, and always remove
  // the listener — on success, on timeout, and when Tracing.end itself fails.
  const streamHandle = await new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const finish = (fn, value) => {
      clearTimeout(timer);
      unsubscribe();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('Tracing did not complete in time')), 20_000);
    const off = platform.debugger.onEvent((source, method, params) => {
      if (source.tabId !== tabId || source.sessionId || method !== 'Tracing.tracingComplete') return;
      finish(resolve, params.stream);
    });
    if (typeof off === 'function') unsubscribe = off;
    send(tabId, 'Tracing.end').catch((err) => finish(reject, err));
  });

  const events = await readTraceStream(tabId, streamHandle);
  return summarizeTrace(events);
}

/**
 * Buffered Web Vitals plus long tasks. Observers collect what Chromium still
 * retains and then watch a short window for late layout/input activity.
 */
export async function vitals(tabId, { durationMs = 1000 } = {}) {
  const wait = Math.max(100, Math.min(Number(durationMs) || 1000, 5000));
  return inWorld(
    tabId,
    `new Promise((resolve) => {
      const data = { lcp: [], shifts: [], events: [], longTasks: [] };
      const observers = [];
      const watch = (type, key) => {
        try {
          const observer = new PerformanceObserver((list) => data[key].push(...list.getEntries()));
          observer.observe({ type, buffered: true, durationThreshold: type === 'event' ? 40 : undefined });
          observers.push(observer);
        } catch {}
      };
      watch('largest-contentful-paint', 'lcp');
      watch('layout-shift', 'shifts');
      watch('event', 'events');
      watch('longtask', 'longTasks');
      setTimeout(() => {
        observers.forEach((observer) => observer.disconnect());
        const nav = performance.getEntriesByType('navigation')[0];
        const paints = performance.getEntriesByType('paint');
        const lcp = data.lcp[data.lcp.length - 1];
        const cls = data.shifts.filter((entry) => !entry.hadRecentInput).reduce((sum, entry) => sum + entry.value, 0);
        const interactions = data.events.filter((entry) => entry.interactionId);
        const inp = interactions.length ? Math.max(...interactions.map((entry) => entry.duration)) : null;
        resolve({
          coreWebVitals: {
            lcpMs: lcp ? Math.round(lcp.startTime) : null,
            cls: Math.round(cls * 10000) / 10000,
            inpMs: inp == null ? null : Math.round(inp),
          },
          paint: {
            firstPaintMs: Math.round(paints.find((entry) => entry.name === 'first-paint')?.startTime ?? 0) || null,
            firstContentfulPaintMs: Math.round(paints.find((entry) => entry.name === 'first-contentful-paint')?.startTime ?? 0) || null,
          },
          navigation: nav ? {
            ttfbMs: Math.round(nav.responseStart),
            domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
            loadMs: Math.round(nav.loadEventEnd),
            transferBytes: nav.transferSize,
          } : null,
          longTasks: {
            count: data.longTasks.length,
            totalMs: Math.round(data.longTasks.reduce((sum, entry) => sum + entry.duration, 0)),
            longestMs: Math.round(Math.max(0, ...data.longTasks.map((entry) => entry.duration))),
          },
          note: inp == null ? 'INP needs a real user interaction during the observation window.' : undefined,
        });
      }, ` + wait + `);
    })`,
  );
}

/** Repeated CDP metrics expose meaningful heap/node/listener growth signals. */
export async function memory(tabId, { samples = 3, intervalMs = 500 } = {}) {
  const count = Math.max(2, Math.min(Number(samples) || 3, 10));
  const gap = Math.max(50, Math.min(Number(intervalMs) || 500, 5000));
  await send(tabId, 'Performance.enable');
  const rows = [];
  for (let index = 0; index < count; index++) {
    const result = await send(tabId, 'Performance.getMetrics');
    const metrics = Object.fromEntries((result.metrics ?? []).map((metric) => [metric.name, metric.value]));
    rows.push({
      atMs: index * gap,
      jsHeapUsedBytes: metrics.JSHeapUsedSize ?? null,
      jsHeapTotalBytes: metrics.JSHeapTotalSize ?? null,
      nodes: metrics.Nodes ?? null,
      listeners: metrics.JSEventListeners ?? null,
      documents: metrics.Documents ?? null,
      frames: metrics.Frames ?? null,
      layoutCount: metrics.LayoutCount ?? null,
      recalcStyleCount: metrics.RecalcStyleCount ?? null,
    });
    if (index + 1 < count) await new Promise((resolve) => setTimeout(resolve, gap));
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  const growth = {
    jsHeapUsedBytes: delta(first.jsHeapUsedBytes, last.jsHeapUsedBytes),
    nodes: delta(first.nodes, last.nodes),
    listeners: delta(first.listeners, last.listeners),
    documents: delta(first.documents, last.documents),
  };
  return {
    samples: rows,
    growth,
    suspectedLeak: (growth.jsHeapUsedBytes ?? 0) > 5 * 1024 * 1024 ||
      (growth.nodes ?? 0) > 500 || (growth.listeners ?? 0) > 100,
    note: 'Growth is a signal, not proof. Re-run around a repeatable open/close flow to identify retained objects.',
  };
}

function delta(a, b) {
  return a == null || b == null ? null : Math.round(b - a);
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
