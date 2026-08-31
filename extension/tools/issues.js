/**
 * Capturing a defect the moment someone sees it.
 *
 * The value here is not the title and body — a QA can already write those
 * anywhere. It is everything they would otherwise have to remember to collect,
 * and that a developer always has to ask for afterwards: which page, which page
 * before that, what the console said, which requests failed, what the viewport
 * was. By the time the question is asked the tab has usually moved on.
 *
 * So capture is automatic and simultaneous. Pressing the button takes the
 * screenshot, reads the console and network buffers, and records the
 * navigation trail in the same instant the bug is visible.
 */

import { send, evaluate } from '../lib/cdp.js';
import { screenshot } from './capture.js';
import * as observe from './observe.js';
import { saveIssue, getIssue, listIssues, deleteIssue, putAttachment, listAttachments } from '../lib/store.js';

const api = globalThis.browser ?? globalThis.chrome;

/** How much of each buffer is worth keeping with a bug report. */
const CONSOLE_TAIL = 40;
const NETWORK_TAIL = 25;

/**
 * Everything about the moment, gathered without being asked.
 *
 * Deliberately bounded: a bug report carrying the full console of an ad-heavy
 * page is a bug report nobody reads. The tails are the part that is almost
 * always relevant — what happened just before someone noticed.
 */
export async function captureContext(tabId) {
  const [page, logs, net] = await Promise.all([
    evaluate(
      tabId,
      `({
         url: location.href,
         title: document.title,
         referrer: document.referrer || null,
         viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
         scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
         userAgent: navigator.userAgent,
         language: navigator.language,
         at: new Date().toISOString()
       })`,
    ).catch(() => ({})),
    observe.consoleLog(tabId, { limit: CONSOLE_TAIL, level: ['error', 'warning'] }).catch(() => null),
    observe.network(tabId, { status: 'failed', limit: NETWORK_TAIL }).catch(() => null),
  ]);

  return {
    ...page,
    console: {
      counts: logs?.counts ?? {},
      total: logs?.total ?? 0,
      entries: (logs?.entries ?? []).map((e) => ({ level: e.level, text: e.text, at: e.at ?? null })),
    },
    failedRequests: (net?.requests ?? []).map((r) => ({ method: r.method, url: r.url, status: r.status })),
    failedRequestCount: net?.failedCount ?? 0,
  };
}

/**
 * Create an issue, capturing the page state as it is right now.
 *
 * `withScreenshot` defaults on because a screenshot taken a minute later is a
 * screenshot of a different page, and the whole point of capturing at the
 * button press is that the evidence matches the complaint.
 */
export async function createIssue(tabId, { title, body = '', severity = 'normal', tags = [], withScreenshot = true } = {}) {
  if (!title || !String(title).trim()) {
    throw new Error('An issue needs a title — it is what everyone reads first in a tracker.');
  }

  const context = await captureContext(tabId);
  const issue = await saveIssue({
    title: String(title).trim(),
    body: String(body ?? ''),
    severity,
    tags,
    status: 'open',
    context,
  });

  if (withScreenshot) {
    try {
      const shot = await screenshot(tabId, { area: 'viewport', format: 'png' });
      await putAttachment({
        owner: issue.id,
        name: 'screenshot.png',
        mime: 'image/png',
        kind: 'screenshot',
        bytes: base64ToBytes(shot.dataBase64),
        meta: { area: 'viewport', url: context.url },
      });
    } catch (err) {
      // A missing screenshot must not lose the report — the text is the part
      // that cannot be recreated later.
      issue.screenshotError = String(err?.message ?? err);
      await saveIssue(issue);
    }
  }

  await attachEvidence(tabId, issue.id, context);
  return getIssue(issue.id);
}

/**
 * Write the captured context out as real attachments, not just a nested object.
 *
 * The issue record already holds this data, so this looks like duplication. It
 * is not. An agent filing to Jira or Azure DevOps uploads *attachments* — a
 * ticket with `console.log` and `network.log` on it is one a developer can open
 * and read, while the same bytes buried in a JSON field are something the agent
 * would have to paste into the description and truncate. Making them files at
 * capture time means the ticket can be complete without anyone deciding what to
 * summarise.
 *
 * Each is written only when it carries something, so an issue on a clean page
 * does not arrive with three empty files.
 */
async function attachEvidence(tabId, issueId, context) {
  const text = (name, mime, body, meta) =>
    putAttachment({
      owner: issueId,
      name,
      mime,
      kind: 'evidence',
      bytes: new TextEncoder().encode(body),
      meta,
    }).catch(() => null);

  const jobs = [];

  if (context.console?.entries?.length) {
    const lines = context.console.entries
      .map((e) => `[${String(e.level).toUpperCase()}] ${e.text}${e.at ? `  (${e.at})` : ''}`)
      .join('\n');
    jobs.push(
      text('console.log', 'text/plain', `${context.url}\ncaptured ${context.at}\n\n${lines}\n`, {
        entries: context.console.entries.length,
        counts: context.console.counts,
      }),
    );
  }

  if (context.failedRequests?.length) {
    const lines = context.failedRequests.map((r) => `${r.method} ${r.url} -> ${r.status}`).join('\n');
    jobs.push(
      text('failed-requests.log', 'text/plain', `${context.url}\ncaptured ${context.at}\n\n${lines}\n`, {
        count: context.failedRequests.length,
      }),
    );
  }

  // Always written: it is the one attachment that answers "where was I".
  jobs.push(
    text('page-context.json', 'application/json', JSON.stringify(context, null, 2), { url: context.url }),
  );

  // The DOM of the element under suspicion is often the whole answer, and it is
  // impossible to recover once the tab moves on.
  const html = await evaluate(
    tabId,
    `(() => {
       const el = document.activeElement && document.activeElement !== document.body
         ? document.activeElement : document.body;
       const scope = el.closest('section, article, form, dialog, main') || document.body;
       return scope.outerHTML.slice(0, 200000);
     })()`,
  ).catch(() => null);
  if (html) {
    jobs.push(text('page-fragment.html', 'text/html', html, { note: 'section around the focused element' }));
  }

  await Promise.all(jobs);
}

/**
 * Refresh the context and evidence of an existing issue.
 *
 * For the case a QA hits constantly: the issue was filed, then they reproduced
 * it more precisely, or the console filled with the actual error a moment after
 * the screenshot. The original evidence is not replaced — it is added to, and
 * both sets carry their own timestamp, because "it looked like this, then like
 * this" is often the report.
 */
export async function recapture(tabId, id) {
  const issue = await getIssue(id, { withAttachments: false });
  if (!issue) throw new Error(`No issue with id "${id}".`);

  const context = await captureContext(tabId);
  await saveIssue({
    ...issue,
    context,
    contextHistory: [...(issue.contextHistory ?? []), { at: issue.context?.at, url: issue.context?.url }],
  });
  await attachEvidence(tabId, id, context);
  return { recaptured: true, url: context.url, at: context.at };
}

export async function updateIssue(id, patch = {}) {
  const existing = await getIssue(id, { withAttachments: false });
  if (!existing) throw new Error(`No issue with id "${id}".`);

  const allowed = ['title', 'body', 'severity', 'tags', 'status', 'filedAs'];
  const next = { ...existing };
  for (const key of allowed) if (key in patch) next[key] = patch[key];

  await saveIssue(next);
  return getIssue(id);
}

export { getIssue, listIssues, deleteIssue, listAttachments };

/**
 * Attach a fresh screenshot to an existing issue.
 *
 * Separate from create because the useful second screenshot is usually taken
 * after reproducing the bug a different way, not at the moment of filing.
 */
export async function attachScreenshot(tabId, id, { area = 'viewport', ref, note } = {}) {
  const issue = await getIssue(id, { withAttachments: false });
  if (!issue) throw new Error(`No issue with id "${id}".`);

  const shot = await screenshot(tabId, { area, ref, format: 'png' });
  const url = await evaluate(tabId, 'location.href').catch(() => null);

  return putAttachment({
    owner: id,
    name: `screenshot-${Date.now()}.png`,
    mime: 'image/png',
    kind: 'screenshot',
    bytes: base64ToBytes(shot.dataBase64),
    meta: { area, url, note: note ?? null },
  });
}

/** Attach arbitrary bytes — the file a QA was testing an upload with, say. */
export async function attachFile(id, { name, mime, dataBase64, note }) {
  const issue = await getIssue(id, { withAttachments: false });
  if (!issue) throw new Error(`No issue with id "${id}".`);
  if (!dataBase64) throw new Error('attachFile needs dataBase64.');

  return putAttachment({
    owner: id,
    name: name || `attachment-${Date.now()}`,
    mime: mime || 'application/octet-stream',
    kind: 'file',
    bytes: base64ToBytes(dataBase64),
    meta: { note: note ?? null },
  });
}

// ---------------------------------------------------------------- tab video

/**
 * Record the attached tab as a sequence of frames.
 *
 * `Page.startScreencast` rather than getDisplayMedia: it captures exactly the
 * tab under test, needs no permission, and puts no source-picker between a QA
 * and the bug they are trying to report. The cost is that it yields frames
 * rather than an encoded video — which is why they are stored as frames and
 * played back in the panel, instead of pretending to be a .webm.
 *
 * Frames are capped by count and by total bytes. A screencast left running is
 * otherwise an unbounded write to disk.
 */
const VIDEO_KEY = (tabId) => `g9:screencast:${tabId}`;
const MAX_FRAMES = 600;
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;

export async function startVideo(tabId, { quality = 60, everyNthFrame = 2 } = {}) {
  await api.storage.session.set({ [VIDEO_KEY(tabId)]: { frames: [], bytes: 0, startedAt: Date.now() } });
  await send(tabId, 'Page.startScreencast', {
    format: 'jpeg',
    quality,
    maxWidth: 1280,
    maxHeight: 800,
    everyNthFrame,
  });
  return { recording: true, tabId };
}

/** Called from sw.js for every Page.screencastFrame event. */
export async function ingestFrame(tabId, params) {
  const key = VIDEO_KEY(tabId);
  const stored = await api.storage.session.get(key);
  const session = stored[key];
  // Acknowledge regardless, or Chromium stops sending frames.
  await send(tabId, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  if (!session) return;

  if (session.frames.length >= MAX_FRAMES || session.bytes >= MAX_VIDEO_BYTES) return;
  session.frames.push({ data: params.data, at: Date.now() - session.startedAt });
  session.bytes += params.data.length;
  await api.storage.session.set({ [key]: session });
}

export async function stopVideo(tabId, issueId) {
  await send(tabId, 'Page.stopScreencast').catch(() => {});
  const key = VIDEO_KEY(tabId);
  const stored = await api.storage.session.get(key);
  const session = stored[key];
  await api.storage.session.remove(key);

  if (!session || !session.frames.length) return { frames: 0, attached: false };
  if (!issueId) return { frames: session.frames.length, attached: false };

  const payload = JSON.stringify({
    format: 'g9-frames/1',
    durationMs: session.frames[session.frames.length - 1].at,
    frames: session.frames,
  });

  const attachment = await putAttachment({
    owner: issueId,
    name: `capture-${Date.now()}.g9frames.json`,
    mime: 'application/json',
    kind: 'video',
    bytes: new TextEncoder().encode(payload),
    meta: { frames: session.frames.length, durationMs: session.frames[session.frames.length - 1].at },
  });

  return { frames: session.frames.length, attached: true, attachment };
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
