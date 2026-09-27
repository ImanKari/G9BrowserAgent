/**
 * Runs, surprises and approvals, as data. Pure and browser-safe (the Runs and Approvals views,
 * and the main process's approval handler, all read through here).
 *
 * Where the data comes from (daemon v2):
 *   runs.list  → { runs: [{ runId, kind, label, startedAt, finishedAt, active, ok, verdict, exitCode, frames, dir }] }
 *   runs.get   → { runId, dir, engine /* engine.json *\/, result /* result.json *\/, files, active }
 *     kind 'replay'|'calibrate': label = the recording id; result has verdict, passed, failed, total,
 *                                humanize, seed, frames, framesDropped, truncated?, error?
 *     kind 'schedule':           result has ok, exitCode, verdicts {VERDICT: n}, reportDir; the
 *                                runner's report/run.json holds every flow with steps and surprises
 *     kind 'watch':              a live-watch recording; no verdict
 *   browser_recording list → { recordings: [{ id, name, lastRun: { at, verdict, passed, failed,
 *                              surprises /* non-info count *\/ }, engine: 'extension'|'launched', … }] }
 *   browser_recording get  → the recording, with knownWorld.approvedAt and surpriseHistory (the last
 *                              entry = the latest run's surprises as { key, kind })
 * Field names are read defensively — a run written by an older daemon must still list.
 */

export const VERDICTS = ['PASS', 'PASS_WITH_WARNING', 'SURPRISE', 'FAIL_PRODUCT', 'FAIL_AUTOMATION'];
// SKIPPED/NOT_RUN (the runner's preflight and stopOn verdicts) rank between a
// warning and a surprise: not green, not a failure.
const RANK = { PASS: 0, PASS_WITH_WARNING: 1, SKIPPED: 2, NOT_RUN: 3, SURPRISE: 4, FAIL_PRODUCT: 5, FAIL_AUTOMATION: 6, ERROR: 7 };

export function verdictTone(verdict) {
  switch (String(verdict ?? '').toUpperCase()) {
    case 'PASS': return 'ok';
    case 'FINISHED': return 'ok';
    case 'PASS_WITH_WARNING': return 'warn';
    case 'SURPRISE': return 'surprise';
    case 'FAIL_PRODUCT':
    case 'FAIL_AUTOMATION':
    case 'ERROR':
    case 'FAILED': return 'fail';
    case 'RUNNING': return 'live';
    case 'SKIPPED':
    case 'NOT_RUN': return 'neutral';
    default: return 'neutral';
  }
}

export function verdictLabel(verdict) {
  switch (String(verdict ?? '').toUpperCase()) {
    case 'PASS': return 'Pass';
    case 'PASS_WITH_WARNING': return 'Pass with warnings';
    case 'SURPRISE': return 'Surprise';
    case 'FAIL_PRODUCT': return 'Product failure';
    case 'FAIL_AUTOMATION': return 'Automation failure';
    case 'ERROR': return 'Error';
    case 'FAILED': return 'Failed';
    case 'FINISHED': return 'Finished';
    case 'RUNNING': return 'Running';
    case 'WATCH': return 'Watch session';
    case 'SKIPPED': return 'Skipped';
    case 'NOT_RUN': return 'Not run';
    default: return verdict ? String(verdict) : 'No verdict';
  }
}

export function kindLabel(kind) {
  return { replay: 'Replay', calibrate: 'Calibration', schedule: 'Scheduled', watch: 'Watch' }[kind] ?? (kind ? String(kind) : 'Run');
}

/** The worst verdict of a histogram { PASS: 3, SURPRISE: 1 } (a scheduled suite's result). */
export function worstVerdict(hist) {
  if (!hist || typeof hist !== 'object') return null;
  let worst = null;
  for (const [v, n] of Object.entries(hist)) {
    if (!n) continue;
    if (worst === null || (RANK[v] ?? 7) > (RANK[worst] ?? 7)) worst = v;
  }
  return worst;
}

const toTime = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

function pickSurprises(raw) {
  const r = raw ?? {};
  const list = r.surprises ?? r.result?.surprises ?? r.summary?.surprises ?? r.comparison?.surprises;
  return Array.isArray(list) ? list : [];
}

/**
 * The sentences behind a "Pass with warnings" (replay.js: a step that matched only by a fallback
 * locator, live data that changed under a semantic assertion). The runner's report keeps them per
 * flow; a replay's result.json keeps them when the engine writes them. Without this the render
 * check showed every run as "Pass with warnings" and nowhere said what the warnings were.
 */
function pickWarnings(r, result) {
  const list = r.warnings ?? result.warnings;
  return Array.isArray(list) ? list.filter((w) => w != null && w !== '').map((w) => (typeof w === 'string' ? w : w.message ?? w.text ?? JSON.stringify(w))) : [];
}

export function surpriseSeverity(s) {
  return String(s?.effectiveSeverity ?? s?.severity ?? 'info');
}

/** One human sentence for a surprise, whatever shape it came in. */
export function surpriseText(s) {
  if (typeof s === 'string') return s;
  if (!s || typeof s !== 'object') return String(s);
  if (s.text) return String(s.text);
  if (s.message) return String(s.message);
  if (s.description) return String(s.description);
  const dir = s.kind === 'new' || s.direction === 'new' || s.new ? 'New' : s.kind === 'missing' || s.direction === 'missing' || s.missing ? 'Missing' : null;
  const layer = s.layer ?? (dir ? null : s.kind ?? s.type) ?? null;
  const what = s.key ?? s.label ?? s.value ?? '';
  const head = [dir, layer].filter(Boolean).join(' ');
  const text = `${head ? `${head}: ` : ''}${what}${s.detail ? ` (${s.detail})` : ''}`.trim();
  return text || JSON.stringify(s).slice(0, 200);
}

function statusOf(r, result, endedAt, verdict) {
  if (r.active === true) return 'running';
  const s = String(r.status ?? r.state ?? '').toLowerCase();
  if (s === 'started' || s === 'running' || s === 'active' || s === 'queued') return 'running';
  if (s === 'finished' || s === 'done' || s === 'failed') return 'done';
  if (s) return s;
  if (r.active === false) return 'done';
  return endedAt || verdict || result.verdict ? 'done' : 'running';
}

/** A run row (runs.list), a run detail (runs.get), or an older/hand-made shape — normalised. */
export function normalizeRun(raw) {
  const r = raw ?? {};
  const result = r.result && typeof r.result === 'object' ? r.result : r.summary && typeof r.summary === 'object' ? r.summary : {};
  const engineJson = r.engine && typeof r.engine === 'object' ? r.engine : {};
  const kind = r.kind ?? engineJson.kind ?? result.kind ?? null;
  const label = r.label ?? engineJson.label ?? result.label ?? null;
  const steps = Array.isArray(r.steps) ? r.steps : Array.isArray(result.steps) ? result.steps : Array.isArray(result.results) ? result.results : [];
  const surprises = pickSurprises(r);
  const startedAt = toTime(r.startedAt ?? r.startAt ?? engineJson.startedAt ?? result.startedAt ?? r.at);
  const endedAt = toTime(r.finishedAt ?? r.endedAt ?? r.endAt ?? result.finishedAt ?? result.endedAt);
  const exitCode = r.exitCode ?? result.exitCode ?? null;
  const ok = r.ok ?? result.ok ?? null;
  let verdict = r.verdict ?? result.verdict ?? worstVerdict(r.verdicts ?? result.verdicts) ?? null;
  const status = statusOf(r, result, endedAt, verdict);
  if (!verdict) {
    if (status === 'running') verdict = 'RUNNING';
    else if (kind === 'watch') verdict = 'WATCH';
    else if (ok === false || (exitCode != null && exitCode !== 0)) verdict = 'FAILED';
    else if (ok === true || exitCode === 0) verdict = 'FINISHED';
  }
  const flowId = r.flowId ?? r.recordingId ?? engineJson.recordingId ?? r.flow?.id ?? result.flowId ?? result.recordingId
    ?? (kind === 'replay' || kind === 'calibrate' ? label : null);
  const count = r.surpriseCount ?? result.surpriseCount ?? null;
  const browser = engineJson.browser ?? r.browser ?? null;
  return {
    runId: String(r.runId ?? r.id ?? ''),
    kind,
    label,
    flowId,
    flowName: r.flowName ?? r.name ?? r.flow?.name ?? result.name ?? label ?? flowId ?? null,
    suite: r.suite ?? null,
    environment: r.environment ?? r.env ?? null,
    verdict,
    status,
    ok,
    exitCode,
    startedAt,
    endedAt,
    durationMs: r.durationMs ?? result.durationMs ?? (startedAt && endedAt ? endedAt - startedAt : null),
    engineId: engineJson.engineId ?? (typeof r.engine === 'string' ? r.engine : r.engineId) ?? null,
    browser: typeof browser === 'object' && browser ? browser.kind ?? null : browser,
    browserVersion: engineJson.version ?? (typeof browser === 'object' ? browser?.version : null) ?? null,
    headless: engineJson.headless ?? null,
    profile: engineJson.profile ?? null,
    humanize: result.humanize ?? engineJson.humanize ?? null,
    seed: result.seed ?? engineJson.humanize?.seed ?? null,
    passed: result.passed ?? r.passed ?? null,
    failed: result.failed ?? r.failed ?? null,
    total: result.total ?? r.total ?? null,
    frames: r.frames ?? result.frames ?? null,
    framesDropped: result.framesDropped ?? null,
    truncated: result.truncated ?? null,
    error: result.error ?? r.error ?? null,
    tabId: r.tabId ?? engineJson.tabId ?? null,
    steps: steps.map((s, i) => normalizeStep(s, i)),
    warnings: pickWarnings(r, result),
    surprises,
    surpriseCount: count ?? (surprises.length ? {
      total: surprises.length,
      fail: surprises.filter((s) => surpriseSeverity(s) === 'fail').length,
      warn: surprises.filter((s) => surpriseSeverity(s) === 'warn').length,
      info: surprises.filter((s) => surpriseSeverity(s) === 'info').length,
    } : typeof r.surprises === 'number' ? { total: r.surprises } : { total: 0 }),
    dir: r.dir ?? r.path ?? null,
    files: Array.isArray(r.files) ? r.files : null,
    report: r.report ?? null,
    approved: r.approved ?? null,
    raw: r,
  };
}

export function normalizeStep(s, i) {
  const x = s ?? {};
  const ok = x.ok ?? (x.status ? /^(ok|pass|passed|done)$/i.test(x.status) : !x.error);
  return {
    n: x.n ?? x.step ?? x.index ?? i + 1,
    action: x.action ?? x.type ?? x.kind ?? '',
    target: x.target ?? x.summary ?? x.name ?? x.label ?? x.locator?.name ?? '',
    status: x.status ?? (ok ? 'ok' : 'failed'),
    ok: !!ok,
    durationMs: x.durationMs ?? x.ms ?? null,
    message: x.error ?? x.message ?? x.warning ?? '',
    matchedBy: x.matchedBy ?? x.locator?.by ?? null,
  };
}

/**
 * The flows of a run, each with its steps and surprises: a scheduled run's report lists every
 * flow; a replay run is one flow, whose steps/surprises are only there when the daemon kept them.
 */
export function flowsOf(run) {
  const report = run?.report;
  if (report && Array.isArray(report.flows)) {
    return report.flows.map((f) => {
      const n = normalizeRun({ ...f, runId: run.runId, active: false });
      return { id: f.id ?? null, name: f.name ?? f.id ?? '(unnamed)', verdict: f.verdict ?? null, passed: f.passed ?? null, failed: f.failed ?? null, total: f.total ?? null, durationMs: f.durationMs ?? null, steps: n.steps, warnings: n.warnings, surprises: n.surprises, failureMessage: f.failureMessage ?? null };
    });
  }
  if (!run || run.kind === 'watch') return [];
  return [{ id: run.flowId, name: run.flowName, verdict: run.verdict, passed: run.passed, failed: run.failed, total: run.total, durationMs: run.durationMs, steps: run.steps, warnings: run.warnings ?? [], surprises: run.surprises, failureMessage: run.error }];
}

/** Surprises that matter for approval: everything except unconfirmed notes, unless that is all there is. */
export function relevantSurprises(surprises) {
  const notInfo = surprises.filter((s) => surpriseSeverity(s) !== 'info');
  return notInfo.length ? notInfo : surprises;
}

/** Rows of browser_recording list, whatever envelope. */
export function recordingRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.recordings)) return result.recordings;
  if (Array.isArray(result?.items)) return result.items;
  return [];
}

/** The key of a recording in `details`: the same id can live in both stores (extension, launched). */
export function recordingKey(rec) {
  return `${rec?.engine ?? ''}|${rec?.id ?? rec?.flowId ?? ''}`;
}

/**
 * Approvals: flows whose LAST run has surprises, newest first. `details` (optional) maps
 * recordingKey(row) (or, for older callers, the bare id) to the full `get` result; a known world
 * approved after that last run means the decision was already made — the flow is not shown again.
 */
export function approvalCandidates(recordings, details = {}) {
  const out = [];
  const seen = new Set();
  for (const rec of recordings ?? []) {
    const last = rec?.lastRun;
    if (!rec?.id || !last) continue;
    const key = `${rec.engine ?? ''}|${rec.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hasSurprises = (Number(last.surprises) || 0) > 0 || last.verdict === 'SURPRISE';
    if (!hasSurprises) continue;
    const full = details[recordingKey(rec)] ?? details[rec.id] ?? null;
    const approvedAt = full?.knownWorld?.approvedAt ?? null;
    if (approvedAt && approvedAt >= (last.at ?? 0) && full?.knownWorld?.approvedBy !== 'seed') continue;
    const history = Array.isArray(full?.surpriseHistory) ? full.surpriseHistory : [];
    out.push({
      flowId: rec.id,
      flowName: rec.name ?? rec.id,
      engine: rec.engine ?? null,
      lastRun: last,
      verdict: last.verdict ?? null,
      at: last.at ?? null,
      surpriseCount: Number(last.surprises) || 0,
      surprises: history.length ? history[history.length - 1] ?? [] : [],
      knownWorldRuns: full?.knownWorld?.runs ?? null,
    });
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** The exact tool arguments of an approval. `by` comes from the main process, never the page. */
export function approvalArgs({ flowId, by, note, runId, engine, expectLastRunAt = null }) {
  if (!flowId) throw new Error('An approval needs the flow id.');
  if (!by) throw new Error('An approval needs the name of the person approving.');
  const args = { action: 'approve', id: String(flowId), by: String(by) };
  // The run the person reviewed: the store refuses the approval when a newer run arrived since
  // (a schedule or an agent replayed the flow while the confirm dialog was open).
  if (expectLastRunAt != null && Number.isFinite(Number(expectLastRunAt))) args.expectLastRunAt = Number(expectLastRunAt);
  const trimmed = String(note ?? '').trim();
  args.note = trimmed ? trimmed : `Approved in G9BrowserAgent desktop${runId ? ` from run ${runId}` : ''}.`;
  // Pin the store the flow was listed from (the extension's or the launched engines').
  if (engine === 'extension' || engine === 'launched') args.engine = engine;
  return args;
}

/** Rows of runs.list, whatever envelope the daemon used. */
export function runRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.runs)) return result.runs;
  if (Array.isArray(result?.items)) return result.items;
  return [];
}
