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

import { send } from '../lib/cdp.js';
import { screenshot } from './capture.js';
import * as observe from './observe.js';
import {
  saveIssue, getIssue, listIssues, deleteIssue as deleteStoredIssue, putAttachment, listAttachments,
  putVideoFrame, listVideoFrames, deleteVideoFrames,
} from '../lib/store.js';
import { serialize } from '../lib/state.js';
import { platform } from '../lib/platform.js';
// Page reads run in G9BrowserAgent's isolated world: same DOM, none of the page's globals.
import { inWorld } from '../lib/world.js';
import * as screencast from '../lib/screencast.js';
import * as pointer from '../lib/pointer.js';

const session = () => platform.storage.session;

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
    inWorld(
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
  const html = await inWorld(
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
  if (typeof session().getKeys === 'function') {
    keys = (await session().getKeys()).filter((k) => k.startsWith('g9:screencast:'));
    if (!keys.length) return [];
  }
  const stored = await session().get(keys ?? null);
  return Object.entries(stored ?? {}).filter(([key]) => key.startsWith('g9:screencast:'));
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
  const url = await inWorld(tabId, 'location.href').catch(() => null);

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
 * v2: the stream is shared (lib/screencast.js). The video is one CONSUMER of
 * it, `video:<issueId>`, next to whatever else is watching the tab (the
 * desktop's live watch); stopping the video no longer blinds the watcher, and
 * the watcher cannot stop the video. The video consumer is registered with
 * back-pressure, so its rule since v1 still holds: a frame is acknowledged only
 * after it is durable.
 *
 * The cursor is not in the frames — CDP input moves no real cursor, and
 * drawing one into the page would be visible to it (decision D9). Instead every
 * stored frame carries `pointer: {x, y, buttons}`, the pointer at the moment
 * the frame arrived, and stopVideo attaches the whole track as
 * `pointer-track.json`, so any viewer can draw the cursor over the frames.
 *
 * Frames are capped by count and by total bytes. A screencast left running is
 * otherwise an unbounded write to disk.
 */
const VIDEO_KEY = (tabId) => `g9:screencast:${tabId}`;
const MAX_FRAMES = 600;
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
const consumerOf = (issueId) => `video:${issueId}`;
const streamOptions = (quality, everyNthFrame) => ({
  format: 'jpeg', quality, maxWidth: 1280, maxHeight: 800, everyNthFrame, backpressure: true,
});

/**
 * After a service-worker restart the stream keeps delivering frames for a
 * video whose session record survived in storage; re-attach the consumer to
 * the running stream instead of letting its frames be judged orphans.
 */
screencast.onRevive(async (tabId) => {
  const key = VIDEO_KEY(tabId);
  const current = (await session().get(key))?.[key];
  if (!current || current.starting) return;
  screencast.adopt(
    tabId,
    consumerOf(current.issueId),
    streamOptions(current.quality ?? 60, current.everyNthFrame ?? 2),
    (frame) => ingestVideoFrame(tabId, frame),
  );
});

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
  const consumer = consumerOf(issueId);

  // Claim the slot atomically, so two concurrent starts cannot both proceed.
  const claimed = await serialize(async () => {
    const existing = (await session().get(key))?.[key];
    if (existing) {
      throw new Error('This tab is already recording video for issue "' + existing.issueId + '". Stop that capture first.');
    }
    const record = {
      sessionId: 'video_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      issueId,
      consumer,
      quality,
      everyNthFrame,
      frames: 0,
      bytes: 0,
      startedAt: Date.now(),
      truncated: false,
      viewport: null,
      // Frames arriving before the screencast is confirmed have nothing to be
      // attributed to yet; the consumer skips them rather than guessing.
      starting: true,
    };
    await session().set({ [key]: record });
    return record;
  });

  screencast.subscribe(tabId, consumer, (frame) => ingestVideoFrame(tabId, frame));
  try {
    await screencast.start(tabId, consumer, streamOptions(quality, everyNthFrame));
  } catch (err) {
    await screencast.stop(tabId, consumer, { sendStop: false }).catch(() => {});
    await serialize(async () => session().remove(key));
    throw err;
  }

  await serialize(async () => {
    const current = (await session().get(key))?.[key];
    // Only promote the session we actually claimed: a stop that raced us must
    // not be resurrected here.
    if (current?.sessionId !== claimed.sessionId) return;
    delete current.starting;
    await session().set({ [key]: current });
  });

  // Say so NOW if this recording cannot produce anything.
  //
  // `Page.startScreencast` captures composited frames, so a tab that is not
  // being painted yields none — a hidden tab in a headed window. The command
  // succeeds either way, frames simply never arrive, and the only symptom is an
  // empty video at the end, long after the bug being recorded has gone. Same
  // shape as the input problem in tools/interact.js: the browser accepts the
  // request and quietly does nothing.
  const visible = await inWorld(tabId, 'document.visibilityState').catch(() => null);
  const warning = visible && visible !== 'visible'
    ? `The tab is "${visible}", and a tab that is not being painted produces no video frames. ` +
      `Nothing will be captured until it is brought to the foreground — the recording is running, ` +
      `but it is currently recording nothing.`
    : null;

  return {
    recording: true,
    tabId,
    issueId,
    startedAt: claimed.startedAt,
    sharedWith: screencast.consumers(tabId).filter((c) => c !== consumer),
    ...(warning ? { warning } : {}),
  };
}

/**
 * The video consumer's frame handler. Returns a promise the stream waits on
 * before acknowledging the frame (write-before-ack back-pressure).
 */
async function ingestVideoFrame(tabId, frame) {
  const key = VIDEO_KEY(tabId);
  // Chromium sends the next frame only after the previous one is acked, and
  // this handler holds the ack, so frames reach it strictly one at a time and
  // this read needs no lock. The earlier reserve-then-commit pair was guarding
  // against a concurrency that the protocol already prevents, and it cost two
  // trips through the shared write chain per frame.
  const current = (await session().get(key))?.[key];
  if (!current || current.starting) return;

  const approximateBytes = Math.ceil(frame.data.length * 0.75);
  if (current.frames >= MAX_FRAMES || current.bytes + approximateBytes > MAX_VIDEO_BYTES) {
    if (current.truncated) return;
    await serialize(async () => {
      const latest = (await session().get(key))?.[key];
      if (latest?.sessionId !== current.sessionId) return;
      latest.truncated = true;
      await session().set({ [key]: latest });
    });
    return;
  }

  // Where the cursor was when this frame arrived, from the input dispatcher's
  // track (lib/pointer.js). Null before anything ever moved it on this tab.
  const p = pointer.sampleAt(tabId, frame.at);
  const meta = frameMeta(frame.metadata);
  const size = await putVideoFrame({
    sessionId: current.sessionId,
    seq: current.frames,
    at: frame.at - current.startedAt,
    dataBase64: frame.data,
    pointer: p ? { x: p.x, y: p.y, buttons: p.buttons } : null,
    meta,
  });

  // One serialized write per frame, after the bytes are durable. Never hold
  // the chain across the store write, and never call CDP inside it — see the
  // note on startVideo.
  await serialize(async () => {
    const latest = (await session().get(key))?.[key];
    if (latest?.sessionId !== current.sessionId) return;
    latest.frames += 1;
    latest.bytes += size;
    if (meta && (!latest.viewport || latest.viewport.width !== meta.deviceWidth || latest.viewport.height !== meta.deviceHeight)) {
      latest.viewport = { width: meta.deviceWidth, height: meta.deviceHeight };
    }
    await session().set({ [key]: latest });
  });
}

/** The frame facts a viewer needs to map CSS-pixel pointer samples onto the image. */
function frameMeta(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const pick = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined);
  return {
    deviceWidth: pick(metadata.deviceWidth),
    deviceHeight: pick(metadata.deviceHeight),
    pageScaleFactor: pick(metadata.pageScaleFactor),
    offsetTop: pick(metadata.offsetTop),
    scrollOffsetX: pick(metadata.scrollOffsetX),
    scrollOffsetY: pick(metadata.scrollOffsetY),
  };
}

/**
 * Compatibility: v1's event router called this for every Page.screencastFrame.
 * In v2 tools/events.js hands frames to lib/screencast.js, which acks and fans
 * them out; routing a frame here does exactly that (and a frame that arrives
 * through both routes is handled once).
 */
export function ingestFrame(tabId, params) {
  return screencast.onFrame(tabId, params);
}

export async function stopVideo(tabId, issueId) {
  const key = VIDEO_KEY(tabId);
  const stoppedAt = Date.now();

  // Read and claim under the lock; everything after it — the CDP stop, the
  // frame reads, the attachment writes — happens outside, per startVideo.
  const current = await serialize(async () => {
    const record = (await session().get(key))?.[key];
    if (!record) return null;
    // Ownership is checked before stopping. A typo in the issue id must not
    // silently stop a valid capture and leave an unfinishable session behind.
    if (issueId && issueId !== record.issueId) {
      throw new Error('This video belongs to issue "' + record.issueId + '", not "' + issueId + '". Nothing was re-attributed.');
    }
    await session().remove(key);
    return record;
  });

  if (!current) {
    // Nothing of ours is recording; still make sure no stream is left that
    // only a vanished video wanted.
    if (!screencast.consumers(tabId).length) await send(tabId, 'Page.stopScreencast').catch(() => {});
    return { frames: 0, attached: false };
  }
  // Stops the stream only when no other consumer (a live watch) still uses it.
  await screencast.stop(tabId, current.consumer ?? consumerOf(current.issueId)).catch(() => {});

  const frames = await listVideoFrames(current.sessionId);
  if (!frames.length) {
    await deleteVideoFrames(current.sessionId);
    // An empty capture is a result that needs explaining, not a bare zero.
    const visible = await inWorld(tabId, 'document.visibilityState').catch(() => null);
    return {
      frames: 0,
      attached: false,
      issueId: current.issueId,
      reason: visible && visible !== 'visible'
        ? `No frames were captured: the tab was "${visible}" for the whole recording, and a tab ` +
          `that is not being painted produces none. Bring it to the foreground and record again.`
        : 'No frames were captured. The tab reports it is visible, so either nothing on the page ' +
          'changed during the recording, or this browser is not compositing it (a headless ' +
          'browser only produces screencast frames while something on the page repaints).',
    };
  }

  const durationMs = frames[frames.length - 1].at;
  const withPointer = frames.map(({ data, at, pointer: p, meta }) => {
    const sample = p ?? pointer.sampleAt(tabId, current.startedAt + at);
    return {
      data,
      at,
      ...(sample ? { pointer: { x: sample.x, y: sample.y, buttons: sample.buttons ?? 0 } } : {}),
      ...(meta ? { meta } : {}),
    };
  });
  const payload = JSON.stringify({
    format: 'g9-frames/1',
    durationMs,
    // CSS-pixel size of the captured viewport: a viewer scales pointer samples
    // by image.width / viewport.width to draw the cursor on a frame.
    viewport: current.viewport,
    frames: withPointer,
  });
  const attachment = await putAttachment({
    owner: current.issueId,
    name: 'capture-' + Date.now() + '.g9frames.json',
    mime: 'application/json', kind: 'video', bytes: new TextEncoder().encode(payload),
    meta: { frames: frames.length, durationMs, truncated: current.truncated, withPointer: true },
  });

  // The whole cursor track of the recording, finer-grained than the frames:
  // every dispatched mouse event, so the exporter can interpolate between
  // frames and show the path, not just where the cursor happened to be.
  const samples = pointer.trackSince(tabId, current.startedAt)
    .filter((s) => s.at <= stoppedAt)
    .map((s) => ({ t: Math.round(s.at - current.startedAt), x: s.x, y: s.y, buttons: s.buttons, type: s.type }));
  const resting = pointer.sampleAt(tabId, current.startedAt);
  const track = await putAttachment({
    owner: current.issueId,
    name: 'pointer-track.json',
    mime: 'application/json',
    kind: 'pointer-track',
    bytes: new TextEncoder().encode(JSON.stringify({
      format: 'g9-pointer/1',
      startedAt: current.startedAt,
      durationMs: stoppedAt - current.startedAt,
      viewport: current.viewport,
      start: resting ? { x: resting.x, y: resting.y } : null,
      samples,
    })),
    meta: { samples: samples.length, video: attachment.id },
  }).catch(() => null);

  await deleteVideoFrames(current.sessionId);
  return {
    frames: frames.length,
    attached: true,
    issueId: current.issueId,
    truncated: current.truncated,
    attachment,
    ...(track ? { pointerTrack: { id: track.id, samples: samples.length } } : {}),
  };
}

export async function videoStatus(tabId) {
  const current = (await session().get(VIDEO_KEY(tabId)))?.[VIDEO_KEY(tabId)];
  return current
    ? { recording: true, ...current, sharedWith: screencast.consumers(tabId).filter((c) => c !== current.consumer) }
    : { recording: false };
}

/** Reclaim a capture whose tab or debugger session disappeared. */
export async function cancelVideo(tabId) {
  const key = VIDEO_KEY(tabId);
  const current = (await session().get(key))?.[key];
  // Called after debugger detach/tab close. CDP already stopped the stream;
  // talking to CDP here would attach the tab again.
  screencast.forget(tabId);
  if (!current) return { cancelled: false };
  await session().remove(key);
  await deleteVideoFrames(current.sessionId);
  return { cancelled: true, issueId: current.issueId, frames: current.frames };
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
