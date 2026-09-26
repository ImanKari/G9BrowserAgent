/**
 * Durable storage for recordings and issues.
 *
 * Everything else in this extension is deliberately ephemeral — §4.1 puts live
 * state in session storage precisely so that page data never touches disk.
 * This file is the exception, and the exception is the point: a recorded test
 * that vanishes when the browser closes is not a test, and a bug report that
 * vanishes is worse than not filing one.
 *
 * ## Two stores, on purpose
 *
 * - `platform.storage.local` holds the structured records: recordings, steps,
 *   issue metadata. They are small, they are JSON, and they need to be listed
 *   and searched cheaply.
 * - `platform.blobs` holds attachment bytes (IndexedDB in the extension, files
 *   under G9_HOME/store/blobs in the daemon). Screenshots and tab video are the
 *   only things here that get large, and a JSON key-value store would
 *   deserialise megabytes of base64 on every read of any key.
 *
 * The split is what keeps `listIssues()` fast on an issue with a 20MB video
 * attached: the video is never touched until someone asks for it.
 *
 * ## Ordering
 *
 * Writes go through the same `serialize()` chain as everything else. The
 * read-modify-write hazard that cost v1.0.5 and v1.0.7 applies here too — an
 * index array updated from two contexts loses entries the same way.
 */

import { platform } from './platform.js';
import { serialize } from './state.js';
import { siteOf } from './sites.js';

const BLOB_STORE = 'blobs';
const FRAME_STORE = 'video-frames';

/** Index keys in storage.local. The records themselves are one key each. */
const RECORDING_INDEX = 'g9:recordings';
const ISSUE_INDEX = 'g9:issues';

const recordingKey = (id) => `g9:recording:${id}`;
const issueKey = (id) => `g9:issue:${id}`;

const local = () => platform.storage.local;

/** Short, sortable, human-quotable. Long enough not to collide in a lifetime. */
function newId(prefix) {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}${rand}`;
}

// ----------------------------------------------------------------- base64

/**
 * Base64 without FileReader, so the same code runs in the worker and in Node.
 * Chunked: String.fromCharCode with a few hundred thousand arguments overflows
 * the call stack, and a video attachment reaches that easily.
 */
export function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A stored `blob` field may come back as a Blob (IndexedDB) or bytes (a file-backed store). */
async function bytesOf(blob) {
  if (blob == null) return new Uint8Array(0);
  if (blob instanceof Uint8Array) return blob;
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
  if (ArrayBuffer.isView(blob)) return new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  throw new Error('Stored attachment bytes are in an unknown format.');
}

function sizeOf(blob) {
  if (blob == null) return 0;
  if (typeof blob.size === 'number') return blob.size;
  return blob.byteLength ?? blob.length ?? 0;
}

// ---------------------------------------------------------------- attachments

/**
 * Store one attachment.
 *
 * `owner` is the issue or recording it belongs to, so a delete can take its
 * attachments with it. Nothing here is reference-counted: an attachment has
 * exactly one owner, which keeps deletion honest.
 */
export async function putAttachment({ owner, name, mime, bytes, kind = 'file', meta = {} }) {
  const id = newId('att');
  const type = mime || (typeof Blob !== 'undefined' && bytes instanceof Blob ? bytes.type : '') || 'application/octet-stream';
  const blob = typeof Blob !== 'undefined' && bytes instanceof Blob ? bytes : new Blob([bytes ?? new Uint8Array(0)], { type });
  const size = sizeOf(blob);
  await platform.blobs.put(BLOB_STORE, {
    id,
    owner,
    name: name || id,
    mime: type,
    kind,
    size,
    at: Date.now(),
    meta,
    blob,
  });
  // An issue's evidence chips count its attachments, which arrive AFTER the issue is saved (the
  // screenshot, the console log, the DOM fragment, a video): its index entry follows each one.
  await refreshIssueEntry(owner).catch(() => {});
  return { id, owner, name: name || id, mime: type, kind, size, meta };
}

/** Metadata for an owner's attachments — never the bytes. */
export async function listAttachments(owner) {
  const rows = await platform.blobs.byIndex(BLOB_STORE, 'owner', owner);
  return (rows || []).map(({ blob, ...meta }) => meta);
}

/** One attachment, bytes included. Base64 so it can cross the WebSocket. */
export async function getAttachment(id, { includeBytes = true } = {}) {
  const row = await platform.blobs.get(BLOB_STORE, id);
  if (!row) return null;
  const { blob, ...meta } = row;
  if (!includeBytes) return meta;
  return { ...meta, dataBase64: bytesToBase64(await bytesOf(blob)) };
}

export async function deleteAttachment(id) {
  const owner = (await platform.blobs.get(BLOB_STORE, id).catch(() => null))?.owner ?? null;
  await platform.blobs.delete(BLOB_STORE, id);
  if (owner != null) await refreshIssueEntry(owner).catch(() => {});
  return { deleted: id };
}

function deleteAttachmentsOf(owner) {
  return platform.blobs.deleteByIndex(BLOB_STORE, 'owner', owner);
}

// ---------------------------------------------------------- video frame spool

/**
 * One screencast frame in the blob store; session storage holds metadata only.
 *
 * `pointer` is the cursor sampled at frame time ({ x, y, buttons }) so every
 * viewer can draw it (decision D9: the cursor lives in the evidence, never in
 * the page). Any other `meta` rides along untouched.
 */
export async function putVideoFrame({ sessionId, seq, at, dataBase64, pointer = null, meta = null }) {
  const bytes = base64ToBytes(dataBase64);
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const size = sizeOf(blob);
  await platform.blobs.put(FRAME_STORE, {
    id: `${sessionId}:${String(seq).padStart(6, '0')}`,
    sessionId,
    seq,
    at,
    size,
    ...(pointer ? { pointer } : {}),
    ...(meta ? { meta } : {}),
    blob,
  });
  return size;
}

export async function listVideoFrames(sessionId) {
  const rows = await platform.blobs.byIndex(FRAME_STORE, 'sessionId', sessionId);
  const sorted = (rows ?? []).sort((a, b) => a.seq - b.seq);
  const out = [];
  for (const row of sorted) {
    out.push({
      at: row.at,
      data: bytesToBase64(await bytesOf(row.blob)),
      size: row.size,
      ...(row.pointer ? { pointer: row.pointer } : {}),
      ...(row.meta ? { meta: row.meta } : {}),
    });
  }
  return out;
}

export function deleteVideoFrames(sessionId) {
  return platform.blobs.deleteByIndex(FRAME_STORE, 'sessionId', sessionId);
}

// ------------------------------------------------------------------- indices

async function readIndex(key) {
  const stored = await local().get(key);
  return stored[key] ?? [];
}

/** Add or replace one entry in an index, newest first. */
function upsertIndex(key, entry) {
  return serialize(async () => {
    const list = await readIndex(key);
    const next = [entry, ...list.filter((e) => e.id !== entry.id)];
    await local().set({ [key]: next });
    return next;
  });
}

function removeFromIndex(key, id) {
  return serialize(async () => {
    const list = await readIndex(key);
    await local().set({ [key]: list.filter((e) => e.id !== id) });
  });
}

// ----------------------------------------------------------------- recordings

/**
 * A recording is metadata plus an ordered list of steps.
 *
 * The index holds only what a listing needs — the steps stay in their own key,
 * so listing fifty recordings does not deserialise fifty step arrays.
 */
export async function saveRecording(recording) {
  const id = recording.id || newId('rec');
  const record = {
    ...recording,
    id,
    updatedAt: Date.now(),
    createdAt: recording.createdAt ?? Date.now(),
  };
  await local().set({ [recordingKey(id)]: record });
  const steps = record.steps ?? [];
  await upsertIndex(RECORDING_INDEX, {
    id,
    // (3.2) The flow's own id when it came from the repository (lib/flowsync.js findByFlowId).
    flowId: record.flowId ?? null,
    name: record.name ?? '(unnamed)',
    startUrl: record.startUrl ?? null,
    stepCount: steps.length,
    // Counted into the index rather than derived in the panel, because the
    // index exists so that listing fifty flows does not deserialise fifty step
    // arrays — and "does this flow assert anything at all?" is the first thing
    // a reader needs. A flow with no checks is a macro, and the list should
    // say so without being opened.
    assertionCount: steps.filter((s) => s.type === 'assert').length,
    durationMs: record.durationMs ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastRun: record.lastRun ?? null,
    suite: record.suite ?? null,
    folder: record.folder ?? null,
    tags: record.tags ?? [],
    qaTestCaseIds: record.qaTestCaseIds ?? [],
    platform: record.platform ?? 'web',
    // A name, never an object: an environment with variables but no name reached the panel as
    // "[object Object]" (v3 review, finding 7).
    environment: typeof record.environment?.name === 'string'
      ? record.environment.name
      : typeof record.environment === 'string' ? record.environment : null,
    flaky: record.flaky ?? null,
  });
  return record;
}

export function listRecordings() {
  return readIndex(RECORDING_INDEX);
}

export async function getRecording(id) {
  const stored = await local().get(recordingKey(id));
  return stored[recordingKey(id)] ?? null;
}

export async function deleteRecording(id) {
  await local().remove(recordingKey(id));
  await removeFromIndex(RECORDING_INDEX, id);
  const attachments = await deleteAttachmentsOf(id);
  return { deleted: id, attachmentsRemoved: attachments };
}

// --------------------------------------------------------------------- issues

export async function saveIssue(issue) {
  const id = issue.id || newId('bug');
  const record = {
    ...issue,
    id,
    updatedAt: Date.now(),
    createdAt: issue.createdAt ?? Date.now(),
  };
  await local().set({ [issueKey(id)]: record });
  await refreshIssueEntry(id, { front: true });
  return record;
}

/**
 * What an issue's attachments and captured context hold, for the list's evidence chips (v3,
 * U7, AIGuide §6.10) — so the QA sees whether an issue is worth opening without opening it. Counted
 * from attachment METADATA (kind, mime, name; never the bytes): tools/issues.js files screenshots
 * as kind 'screenshot', videos as 'video', a person's own files as 'file', and the captured context
 * as 'evidence' text files (console.log, failed-requests.log, page-context.json and, when the page
 * had one, page-fragment.html — the DOM around the focused element). console/network also count
 * the record's current context: a recapture replaces it, and the files of every capture stay.
 */
export function issueEvidence(record = {}, attachments = []) {
  const isEvidence = (a, name) => a.kind === 'evidence' && a.name === name;
  const count = (fn) => attachments.filter(fn).length;
  return {
    screenshots: count((a) => a.kind === 'screenshot'),
    videos: count((a) => a.kind === 'video'),
    files: count((a) => a.kind === 'file'),
    console: (record.context?.console?.entries?.length ?? 0) > 0 || attachments.some((a) => isEvidence(a, 'console.log')),
    network: (record.context?.failedRequests?.length ?? 0) > 0 || attachments.some((a) => isEvidence(a, 'failed-requests.log')),
    dom: attachments.some((a) => a.kind === 'evidence' && /^text\/html\b/.test(a.mime ?? '')),
  };
}

/**
 * An issue's index entry: what the Issues list shows and filters on, so listing fifty issues reads
 * one key. `severity`, `tags` and `site` (origin of the page it was filed on) and `evidence` are
 * v3 (C1): the list groups by site and status and shows severity, tags and evidence chips.
 */
export function issueIndexEntry(record, attachments = []) {
  const url = record.context?.url ?? null;
  return {
    id: record.id,
    title: record.title ?? '(untitled)',
    url,
    site: siteOf(url),
    status: record.status ?? 'open',
    severity: typeof record.severity === 'string' && record.severity ? record.severity : 'normal',
    tags: Array.isArray(record.tags) ? record.tags.filter((t) => typeof t === 'string') : [],
    filedAs: record.filedAs ?? null,
    evidence: issueEvidence(record, attachments),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Rewrite one issue's index entry from its STORED record and attachment list, as one step of the
 * write chain: computed from what is on disk at that moment, so a save and an attachment landing
 * together never leave the entry with the older of the two. `front` moves it to the top (a save,
 * newest first); otherwise it keeps its place. An owner with no issue record (a recording's
 * attachment, a deleted issue) changes nothing — and is checked once before taking the chain, so a
 * recording's attachments do not wait on it.
 */
async function refreshIssueEntry(id, { front = false } = {}) {
  if (id == null) return;
  if (!front && !(await local().get(issueKey(id)))[issueKey(id)]) return;
  await serialize(async () => {
    const record = (await local().get(issueKey(id)))[issueKey(id)];
    if (!record) return;
    const entry = issueIndexEntry({ ...record, id }, await listAttachments(id).catch(() => []));
    const list = await readIndex(ISSUE_INDEX);
    const at = list.findIndex((e) => e.id === id);
    const next = front || at < 0
      ? [entry, ...list.filter((e) => e.id !== id)]
      : list.map((e, i) => (i === at ? entry : e));
    await local().set({ [ISSUE_INDEX]: next });
  });
}

/**
 * The index, with entries written before v3 completed once. They lack `severity` (and tags, site,
 * evidence): each is rebuilt from its record, attachment metadata included, never the bytes. One
 * serialized pass that rewrites the index once; later reads find nothing to do. An entry whose record
 * is gone is kept, with the defaults — an index entry is never lost here.
 */
export async function listIssues() {
  const list = await readIndex(ISSUE_INDEX);
  const complete = (entries) => entries.every((e) => !e || typeof e !== 'object' || 'severity' in e);
  if (complete(list)) return list;
  return serialize(async () => {
    const current = await readIndex(ISSUE_INDEX);
    if (complete(current)) return current;
    const next = [];
    for (const entry of current) {
      if (!entry || typeof entry !== 'object' || 'severity' in entry) {
        next.push(entry);
        continue;
      }
      const record = (await local().get(issueKey(entry.id)))[issueKey(entry.id)] ?? null;
      // The entry's own id and dates win over a record that lacks them: the entry is what the list had.
      next.push(record
        ? issueIndexEntry(
          { ...record, id: entry.id, createdAt: record.createdAt ?? entry.createdAt, updatedAt: record.updatedAt ?? entry.updatedAt },
          await listAttachments(entry.id).catch(() => []),
        )
        : { ...issueIndexEntry({ ...entry, context: { url: entry.url ?? null } }), ...entry });
    }
    await local().set({ [ISSUE_INDEX]: next });
    return next;
  });
}

export async function getIssue(id, { withAttachments = true } = {}) {
  const stored = await local().get(issueKey(id));
  const issue = stored[issueKey(id)] ?? null;
  if (!issue) return null;
  return withAttachments ? { ...issue, attachments: await listAttachments(id) } : issue;
}

export async function deleteIssue(id) {
  await local().remove(issueKey(id));
  await removeFromIndex(ISSUE_INDEX, id);
  const attachments = await deleteAttachmentsOf(id);
  return { deleted: id, attachmentsRemoved: attachments };
}

// ------------------------------------------------------------ backup, restore

/**
 * One self-contained JSON bundle.
 *
 * Attachment bytes are inlined as base64 so a bundle is a single file that can
 * be mailed, committed, or handed to another machine — the alternative, a
 * manifest plus a folder, is the kind of backup that arrives incomplete.
 * `includeAttachments: false` exports just the structure, which is what you
 * want when the point is to share a test rather than a bug.
 */
export async function exportBundle({ includeAttachments = true } = {}) {
  const [recordingIndex, issueIndex] = await Promise.all([listRecordings(), listIssues()]);

  const recordings = [];
  for (const entry of recordingIndex) {
    const full = await getRecording(entry.id);
    if (full) recordings.push(full);
  }

  const issues = [];
  for (const entry of issueIndex) {
    const full = await getIssue(entry.id, { withAttachments: false });
    if (!full) continue;
    const attachments = [];
    for (const meta of await listAttachments(entry.id)) {
      attachments.push(includeAttachments ? await getAttachment(meta.id) : meta);
    }
    issues.push({ ...full, attachments });
  }

  return {
    format: 'g9-browser-agent/bundle',
    version: 1,
    exportedAt: new Date().toISOString(),
    includesAttachments: includeAttachments,
    recordings,
    issues,
  };
}

/**
 * Restore a bundle.
 *
 * `mode: "merge"` keeps existing records and re-ids anything that collides;
 * `mode: "replace"` clears first. Merge is the default because the destructive
 * option should be the one you have to ask for by name.
 */
export async function importBundle(bundle, { mode = 'merge' } = {}) {
  if (!bundle || bundle.format !== 'g9-browser-agent/bundle') {
    throw new Error('Not a G9 bundle: expected format "g9-browser-agent/bundle".');
  }

  if (mode === 'replace') {
    for (const entry of await listRecordings()) await deleteRecording(entry.id);
    for (const entry of await listIssues()) await deleteIssue(entry.id);
  }

  const existing = new Set([
    ...(await listRecordings()).map((r) => r.id),
    ...(await listIssues()).map((i) => i.id),
  ]);

  let recordings = 0;
  let issues = 0;
  let attachments = 0;

  for (const rec of bundle.recordings ?? []) {
    const id = existing.has(rec.id) ? newId('rec') : rec.id;
    await saveRecording({ ...rec, id, importedFrom: rec.id !== id ? rec.id : undefined });
    recordings += 1;
  }

  for (const issue of bundle.issues ?? []) {
    const id = existing.has(issue.id) ? newId('bug') : issue.id;
    const { attachments: incoming = [], ...rest } = issue;
    await saveIssue({ ...rest, id, importedFrom: issue.id !== id ? issue.id : undefined });
    for (const att of incoming) {
      if (!att.dataBase64) continue;
      await putAttachment({
        owner: id,
        name: att.name,
        mime: att.mime,
        kind: att.kind,
        meta: att.meta,
        bytes: base64ToBytes(att.dataBase64),
      });
      attachments += 1;
    }
    issues += 1;
  }

  return { mode, recordings, issues, attachments };
}

/**
 * Rough usage, for the panel and for telling the user when to prune.
 *
 * `platform.blobs.stats()` walks a cursor rather than materialising rows: this
 * runs on every issue-list refresh — the side panel polls it every 2.5s while
 * its Issues tab is open — and reading every attachment record, Blob handles
 * included, to add up a `size` field is the wrong price. A blob store without
 * `stats` (it is optional) falls back to per-owner metadata, which is slower
 * and still never touches the bytes.
 */
export async function usage() {
  const [recordings, issues] = await Promise.all([listRecordings(), listIssues()]);

  let totals = typeof platform.blobs.stats === 'function'
    ? await platform.blobs.stats(BLOB_STORE).catch(() => null)
    : null;
  if (!totals) {
    totals = { count: 0, bytes: 0 };
    for (const owner of [...recordings, ...issues].map((e) => e.id)) {
      for (const meta of await listAttachments(owner)) {
        totals.count += 1;
        totals.bytes += meta.size || 0;
      }
    }
  }

  return {
    recordings: recordings.length,
    issues: issues.length,
    attachments: totals.count,
    attachmentBytes: totals.bytes,
    attachmentMB: Math.round((totals.bytes / 1048576) * 10) / 10,
  };
}
