/**
 * (3.4) Evaluate jobs: in-page work that takes minutes or hours (rendering a video, a long upload,
 * a batch the page runs itself), started by `browser_console action:"evaluate" job:true`.
 *
 * ## Why the job lives in the page
 *
 * A caller of a long job is often gone before the job ends: a stateless MCP client opens a new
 * session for every request, an HTTP connection is cut by a proxy, the extension's service worker
 * is restarted. So nothing about a job is held by the call that started it, nor only in this
 * module's memory: the page itself holds the job — `window.__g9jobs[id]` with its state, progress
 * and value — and every status read asks the page. A job therefore survives the caller, a new MCP
 * session, and a worker restart; it does NOT survive its page (a navigation or reload ends it, and
 * the status says so).
 *
 * ## What the page sees
 *
 * This is the main world, deliberately, like `browser_console evaluate`: the agent's own code is
 * the job. `window.__g9jobs` and `window.__g9job` are visible to the page — this is not for stealth
 * runs. Inside the expression, `__g9job` is the job (lexically, so concurrent jobs never mix):
 * `__g9job.progress(fraction, note)` reports progress, `__g9job.signal` is an AbortSignal that
 * `job_cancel` aborts, and `__g9job.cancelled` says the same. `window.__g9job` is the job started
 * last, for code that reads it once at its start.
 *
 * Results are bounded: a status carries at most RESULT_MAX characters of the value's JSON, and the
 * page keeps at most KEEP_FINISHED finished jobs.
 */

import { evaluate as evaluateInPage } from '../lib/cdp.js';
import { platform } from '../lib/platform.js';

/** The longest a job may run before it is reported as overdue (it is never killed by G9BrowserAgent). */
export const MAX_JOB_MS = 4 * 60 * 60_000;
/** Characters of a finished job's value (as JSON) a status returns. */
export const RESULT_MAX = 256 * 1024;
/** Finished jobs one page keeps (the oldest go first). */
export const KEEP_FINISHED = 20;
/** The longest one job_status call may wait for the job to finish (waitMs). */
export const MAX_STATUS_WAIT_MS = 10 * 60_000;

const INDEX_KEY = 'g9:jobs';
const INDEX_MAX = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newJobId() {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The page-side starter: installs the job and starts the expression, returns at once. */
export function jobStarter(id, expression, maxMs = MAX_JOB_MS) {
  return `(() => {
    const store = window.__g9jobs || (Object.defineProperty(window, '__g9jobs', { value: {}, configurable: true, enumerable: false }), window.__g9jobs);
    const finished = Object.values(store).filter((j) => j.state !== 'running').sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
    while (finished.length >= ${KEEP_FINISHED}) delete store[finished.shift().id];
    const ctl = new AbortController();
    const job = {
      id: ${JSON.stringify(id)}, state: 'running', startedAt: Date.now(), updatedAt: Date.now(), maxMs: ${Number(maxMs)},
      fraction: null, note: null, cancelled: false, signal: ctl.signal,
      progress(fraction, note) {
        this.fraction = typeof fraction === 'number' && isFinite(fraction) ? fraction : null;
        this.note = note == null ? null : String(note).slice(0, 500);
        this.updatedAt = Date.now();
      },
      cancel() { this.cancelled = true; try { ctl.abort(new Error('cancelled by G9BrowserAgent')); } catch (e) {} },
    };
    store[job.id] = job;
    window.__g9job = job;
    const __g9job = job;
    Promise.resolve()
      .then(() => (${expression}))
      .then((value) => { job.state = job.cancelled ? 'cancelled' : 'done'; job.value = value; job.finishedAt = Date.now(); },
        (err) => { job.state = job.cancelled ? 'cancelled' : 'failed'; job.error = String((err && (err.stack || err.message)) || err).slice(0, 4000); job.finishedAt = Date.now(); });
    return job.id;
  })()`;
}

/** The page-side status read: bounded, and never the value of a job still running. */
export function jobReader(id, max = RESULT_MAX) {
  return `(() => {
    const j = window.__g9jobs && window.__g9jobs[${JSON.stringify(id)}];
    if (!j) return null;
    const out = { id: j.id, state: j.state, startedAt: j.startedAt, updatedAt: j.updatedAt, finishedAt: j.finishedAt || null,
      progress: j.fraction, note: j.note, cancelled: j.cancelled, error: j.error || null, maxMs: j.maxMs };
    if (j.state === 'done') {
      let text;
      try { text = JSON.stringify(j.value === undefined ? null : j.value); } catch (e) { text = JSON.stringify(String(j.value)); }
      if (text == null) text = 'null';
      out.valueLength = text.length;
      if (text.length > ${Number(max)}) { out.valuePreview = text.slice(0, ${Number(max)}); out.truncated = true; }
      else out.valueJson = text;
    }
    return out;
  })()`;
}

async function readIndex() {
  try {
    const stored = await platform.storage.session.get(INDEX_KEY);
    return Array.isArray(stored?.[INDEX_KEY]) ? stored[INDEX_KEY] : [];
  } catch {
    return [];
  }
}

async function writeIndex(list) {
  await platform.storage.session.set({ [INDEX_KEY]: list.slice(-INDEX_MAX) }).catch(() => {});
}

/** Start a job on `tabId`. → { jobId, tabId, state:'running', startedAt } (at once). */
export async function startJob(tabId, expression, { timeoutMs = null } = {}) {
  if (!expression) throw new Error('action:"evaluate" job:true needs an expression.');
  const maxMs = Math.max(1_000, Math.min(MAX_JOB_MS, Number(timeoutMs) || MAX_JOB_MS));
  const id = newJobId();
  const started = await evaluateInPage(tabId, jobStarter(id, String(expression), maxMs), { awaitPromise: false, timeoutMs: 20_000 });
  if (started !== id) throw new Error('The job could not be started in the page.');
  const startedAt = Date.now();
  const index = (await readIndex()).filter((j) => j.jobId !== id);
  index.push({ jobId: id, tabId, startedAt, expression: String(expression).slice(0, 120) });
  await writeIndex(index);
  return {
    jobId: id, tabId, state: 'running', startedAt, maxMs,
    hint: 'Poll with browser_console action:"job_status" jobId (waitMs to wait for the end in one call); action:"job_cancel" asks it to stop. Page code reports progress with __g9job.progress(fraction, note).',
  };
}

/** The tab a job runs on: the caller's tab when it has the job, else the index. */
async function tabOf(jobId, tabId) {
  const entry = (await readIndex()).find((j) => j.jobId === jobId);
  return { tabId: entry?.tabId ?? tabId, entry };
}

function shapeStatus(raw, entry, jobId, tabId) {
  if (!raw) {
    return {
      jobId, tabId, state: 'lost',
      note: 'The page no longer has this job: it navigated, reloaded or closed since the job started (a job lives in its page).',
      ...(entry ? { startedAt: entry.startedAt } : {}),
    };
  }
  const now = Date.now();
  const out = {
    jobId, tabId, state: raw.state,
    elapsedMs: (raw.finishedAt ?? now) - raw.startedAt,
    ...(raw.progress != null ? { progress: raw.progress } : {}),
    ...(raw.note ? { note: raw.note } : {}),
    ...(raw.state === 'running' ? { lastProgressAgoMs: now - raw.updatedAt } : {}),
    ...(raw.error ? { error: raw.error } : {}),
  };
  if (raw.state === 'running' && raw.maxMs && now - raw.startedAt > raw.maxMs) out.overdue = `running longer than its ${Math.round(raw.maxMs / 60_000)} min budget`;
  if (raw.state === 'done') {
    if (raw.valueJson != null) {
      try { out.value = JSON.parse(raw.valueJson); } catch { out.value = raw.valueJson; }
    } else {
      out.valuePreview = raw.valuePreview;
      out.truncated = true;
      out.valueLength = raw.valueLength;
    }
  }
  return out;
}

/**
 * A job's state, progress and (when done) value. `waitMs` waits up to that long (≤ 10 min) for it to
 * finish, polling the page — one call instead of many.
 */
export async function jobStatus(tabId, { jobId, waitMs = 0, pollMs = null } = {}) {
  if (!jobId) throw new Error('action:"job_status" needs a jobId (from evaluate job:true, or action:"jobs").');
  const { tabId: tab, entry } = await tabOf(jobId, tabId);
  const wait = Math.max(0, Math.min(MAX_STATUS_WAIT_MS, Number(waitMs) || 0));
  const deadline = Date.now() + wait;
  for (;;) {
    let raw = null;
    try {
      raw = await evaluateInPage(tab, jobReader(jobId), { awaitPromise: false, timeoutMs: 15_000 });
    } catch (err) {
      if (/No tab with id|does not exist|closed/i.test(String(err?.message))) return { jobId, tabId: tab, state: 'lost', note: `The job's tab is gone: ${err.message}` };
      throw err;
    }
    const status = shapeStatus(raw, entry, jobId, tab);
    if (status.state !== 'running' || Date.now() >= deadline) return status;
    const elapsed = wait - (deadline - Date.now());
    await sleep(Math.min(Number(pollMs) > 0 ? Number(pollMs) : (elapsed < 10_000 ? 500 : 2_000), Math.max(1, deadline - Date.now())));
  }
}

/** Ask a job to stop: its AbortSignal fires and `cancelled` turns true; code that ignores both runs on. */
export async function cancelJob(tabId, { jobId } = {}) {
  if (!jobId) throw new Error('action:"job_cancel" needs a jobId.');
  const { tabId: tab } = await tabOf(jobId, tabId);
  const raw = await evaluateInPage(tab, `(() => {
      const j = window.__g9jobs && window.__g9jobs[${JSON.stringify(jobId)}];
      if (!j) return null;
      if (j.state === 'running') j.cancel();
      return j.state;
    })()`, { awaitPromise: false, timeoutMs: 15_000 });
  if (raw == null) return { jobId, tabId: tab, state: 'lost', note: 'The page no longer has this job.' };
  await sleep(150);
  const after = await jobStatus(tab, { jobId });
  return {
    ...after,
    ...(after.state === 'running' ? { cancelRequested: true, note: 'Cancel was signalled (__g9job.signal aborted, __g9job.cancelled true); the job\'s code has not stopped yet — it must honour the signal.' } : {}),
  };
}

/** The jobs this engine started (newest last), with each one's tab — state needs job_status. */
export async function listJobs() {
  return { jobs: (await readIndex()).map((j) => ({ jobId: j.jobId, tabId: j.tabId, startedAt: j.startedAt, expression: j.expression })) };
}
