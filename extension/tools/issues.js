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

import { send, evaluate, sendOnLiveSession } from '../lib/cdp.js';
import { screenshot } from './capture.js';
import * as observe from './observe.js';
import {
  saveIssue, getIssue, listIssues, deleteIssue as deleteStoredIssue, putAttachment, listAttachments,
  putVideoFrame, listVideoFrames, deleteVideoFrames,
} from '../lib/store.js';
import { serialize } from '../lib/state.js';

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

export { getIssue, listIssues, listAttachments };

/**
 * Refuse to remove the owner of an active capture.
 *
 * Finding the screencast keys used to mean `storage.session.get(null)`, which
 * deserialises EVERYTHING in session storage — every console buffer, every
 * network buffer, every ref table — to look at a handful of small records.
 * `getKeys()` reads the names only; it landed in Chrome 130 and the manifest
 * allows 116, so the old path stays as the fallback.
 */
async function screencastSessions() {
  let keys;
  if (typeof api.storage.session.getKeys === 'function') {
    keys = (await api.storage.session.getKeys()).filter((k) => k.startsWith('g9:screencast:'));
    if (!keys.length) return [];
  }
  const stored = await api.storage.session.get(keys ?? null);
  return Object.entries(stored).filter(([key]) => key.startsWith('g9:screencast:'));
}

export async function deleteIssue(id) {
  const active = (await screencastSessions()).find(([, value]) => value?.issueId === id);
  if (active) {
    throw new Error('Stop the active video capture before deleting this issue.');
  }
  return deleteStoredIssue(id);
}

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

/**
 * Why no CDP call happens inside `serialize()` here.
 *
 * `state.js` states the rule: a function running inside `serialize()` must
 * never call another serialized function, or it deadlocks. `cdp.send()` looks
 * like it is not one — and it is not, until the tab is missing from
 * `attachedTabs`, at which point `attach()` calls `setState()` and
 * `logActivity()`, both serialized. The chain then waits on itself FOREVER, and
 * because it is one shared chain the damage is not local: every later state
 * write, activity entry, console line and network record in the whole extension
 * hangs behind it until the service worker is restarted.
 *
 * It is one click away. The "browser is being debugged" infobar has a Cancel
 * button; pressing it fires onDetach, which removes the tab from
 * `attachedTabs`, and the next video_start deadlocks the extension.
 *
 * So the pattern throughout this section is: reserve state under the lock,
 * talk to CDP outside it, then commit or roll back under the lock again.
 */
export async function startVideo(tabId, { id: issueId, quality = 60, everyNthFrame = 2 } = {}) {
  if (!Number.isInteger(quality) || quality < 0 || quality > 100) {
    throw new Error('Video quality must be an integer from 0 to 100.');
  }
  if (!Number.isInteger(everyNthFrame) || everyNthFrame < 1) {
    throw new Error('everyNthFrame must be a positive integer.');
  }
  if (!issueId || !(await getIssue(issueId, { withAttachments: false }))) {
    throw new Error('Video recording needs an existing issue id so frames cannot be orphaned or attached to the wrong defect.');
  }

  const key = VIDEO_KEY(tabId);

  // Claim the slot atomically, so two concurrent starts cannot both proceed.
  const session = await serialize(async () => {
    const existing = (await api.storage.session.get(key))[key];
    if (existing) {
      throw new Error('This tab is already recording video for issue "' + existing.issueId + '". Stop that capture first.');
    }
    const claimed = {
      sessionId: 'video_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      issueId,
      frames: 0,
      bytes: 0,
      startedAt: Date.now(),
      truncated: false,
      // Frames arriving before the screencast is confirmed have nothing to be
      // attributed to yet; ingestFrame skips them rather than guessing.
      starting: true,
    };
    await api.storage.session.set({ [key]: claimed });
    return claimed;
  });

  try {
    await send(tabId, 'Page.startScreencast', {
      format: 'jpeg', quality, maxWidth: 1280, maxHeight: 800, everyNthFrame,
    });
  } catch (err) {
    await serialize(async () => api.storage.session.remove(key));
    throw err;
  }

  await serialize(async () => {
    const current = (await api.storage.session.get(key))[key];
    // Only promote the session we actually claimed: a stop that raced us must
    // not be resurrected here.
    if (current?.sessionId !== session.sessionId) return;
    delete current.starting;
    await api.storage.session.set({ [key]: current });
  });

  // Say so NOW if this recording cannot produce anything.
  //
  // `Page.startScreencast` captures composited frames, so a tab that is not
  // being painted yields none — a hidden tab, or a headless surface. The
  // command succeeds either way, frames simply never arrive, and the only
  // symptom is an empty video at the end, long after the bug being recorded has
  // gone. Same shape as the input problem in tools/interact.js: the browser
  // accepts the request and quietly does nothing.
  const visible = await evaluate(tabId, 'document.visibilityState').catch(() => null);
  const warning = visible && visible !== 'visible'
    ? `The tab is "${visible}", and a tab that is not being painted produces no video frames. ` +
      `Nothing will be captured until it is brought to the foreground — the recording is running, ` +
      `but it is currently recording nothing.`
    : null;

  return {
    recording: true,
    tabId,
    issueId,
    startedAt: session.startedAt,
    ...(warning ? { warning } : {}),
  };
}

/** Called from sw.js for every Page.screencastFrame event. */
export async function ingestFrame(tabId, params) {
  const key = VIDEO_KEY(tabId);
  try {
    // Chromium sends the next frame only after the previous one is acked, so
    // frames arrive strictly one at a time and this read needs no lock. The
    // earlier reserve-then-commit pair was guarding against a concurrency that
    // the protocol already prevents, and it cost two trips through the shared
    // write chain per frame — which, during a scroll, is a lot of frames.
    const session = (await api.storage.session.get(key))[key];
    if (!session || session.starting) return;

    const approximateBytes = Math.ceil(params.data.length * 0.75);
    if (session.frames >= MAX_FRAMES || session.bytes + approximateBytes > MAX_VIDEO_BYTES) {
      await serialize(async () => {
        const current = (await api.storage.session.get(key))[key];
        if (current?.sessionId !== session.sessionId) return;
        current.truncated = true;
        await api.storage.session.set({ [key]: current });
      });
      return;
    }

    const size = await putVideoFrame({
      sessionId: session.sessionId,
      seq: session.frames,
      at: Date.now() - session.startedAt,
      dataBase64: params.data,
    });

    // One serialized write per frame, after the bytes are durable. Never hold
    // the chain across the IndexedDB write, and never call CDP inside it — see
    // the note on startVideo.
    await serialize(async () => {
      const current = (await api.storage.session.get(key))[key];
      if (current?.sessionId !== session.sessionId) return;
      current.frames += 1;
      current.bytes += size;
      await api.storage.session.set({ [key]: current });
    });
  } finally {
    // Ack only after the frame is durable, so Chromium's back-pressure is real.
    //
    // Deliberately NOT through send(): that would run a halt check, an attach
    // check and a getTargets() round trip for every frame, on the same
    // single-threaded worker the agent's own calls run on. It starved them
    // badly enough that a scroll during a recording timed out after 60s. The
    // event we are answering is itself proof the session is live.
    await sendOnLiveSession(tabId, 'Page.screencastFrameAck', { sessionId: params.sessionId })
      .catch(() => {});
  }
}

export async function stopVideo(tabId, issueId) {
  const key = VIDEO_KEY(tabId);

  // Read and claim under the lock; everything after it — the CDP stop, the
  // IndexedDB reads, the attachment write — happens outside, per startVideo.
  const session = await serialize(async () => {
    const current = (await api.storage.session.get(key))[key];
    if (!current) return null;
    // Ownership is checked before stopping. A typo in the issue id must not
    // silently stop a valid capture and leave an unfinishable session behind.
    if (issueId && issueId !== current.issueId) {
      throw new Error('This video belongs to issue "' + current.issueId + '", not "' + issueId + '". Nothing was re-attributed.');
    }
    await api.storage.session.remove(key);
    return current;
  });

  await send(tabId, 'Page.stopScreencast').catch(() => {});
  if (!session) return { frames: 0, attached: false };

  const frames = await listVideoFrames(session.sessionId);
  if (!frames.length) {
    await deleteVideoFrames(session.sessionId);
    // An empty capture is a result that needs explaining, not a bare zero.
    const visible = await evaluate(tabId, 'document.visibilityState').catch(() => null);
    return {
      frames: 0,
      attached: false,
      issueId: session.issueId,
      reason: visible && visible !== 'visible'
        ? `No frames were captured: the tab was "${visible}" for the whole recording, and a tab ` +
          `that is not being painted produces none. Bring it to the foreground and record again.`
        : 'No frames were captured. The tab reports it is visible, so either nothing on the page ' +
          'changed during the recording, or this browser is not compositing it (a headless ' +
          'browser produces no screencast frames at all).',
    };
  }
  const durationMs = frames[frames.length - 1].at;
  const payload = JSON.stringify({
    format: 'g9-frames/1', durationMs,
    frames: frames.map(({ data, at }) => ({ data, at })),
  });
  const attachment = await putAttachment({
    owner: session.issueId,
    name: 'capture-' + Date.now() + '.g9frames.json',
    mime: 'application/json', kind: 'video', bytes: new TextEncoder().encode(payload),
    meta: { frames: frames.length, durationMs, truncated: session.truncated },
  });
  await deleteVideoFrames(session.sessionId);
  return { frames: frames.length, attached: true, issueId: session.issueId, truncated: session.truncated, attachment };
}

export async function videoStatus(tabId) {
  const session = (await api.storage.session.get(VIDEO_KEY(tabId)))[VIDEO_KEY(tabId)];
  return session ? { recording: true, ...session } : { recording: false };
}

/** Reclaim a capture whose tab or debugger session disappeared. */
export async function cancelVideo(tabId) {
  const key = VIDEO_KEY(tabId);
  const session = (await api.storage.session.get(key))[key];
  if (!session) return { cancelled: false };
  // Called after debugger detach/tab close. CDP already stopped the stream;
  // calling the normal send() wrapper here would attach the tab again.
  await api.storage.session.remove(key);
  await deleteVideoFrames(session.sessionId);
  return { cancelled: true, issueId: session.issueId, frames: session.frames };
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
