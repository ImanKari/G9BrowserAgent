/**
 * Durable storage for recordings and issues.
 *
 * Everything else in this extension is deliberately ephemeral — §4.1 puts live
 * state in `chrome.storage.session` precisely so that page data never touches
 * disk. This file is the exception, and the exception is the point: a recorded
 * test that vanishes when the browser closes is not a test, and a bug report
 * that vanishes is worse than not filing one.
 *
 * ## Two stores, on purpose
 *
 * - `chrome.storage.local` holds the structured records: recordings, steps,
 *   issue metadata. They are small, they are JSON, and they need to be listed
 *   and searched cheaply.
 * - **IndexedDB** holds attachment bytes. Screenshots and tab video are the
 *   only things here that get large, and `storage.local` is a JSON key-value
 *   store — putting megabytes of base64 in it means every read of any key
 *   deserialises them. IndexedDB stores Blobs natively and reads one by id.
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

import { serialize } from './state.js';

const api = globalThis.browser ?? globalThis.chrome;

const DB_NAME = 'g9-attachments';
const DB_VERSION = 2;
const BLOB_STORE = 'blobs';
const FRAME_STORE = 'video-frames';

/** Index keys in storage.local. The records themselves are one key each. */
const RECORDING_INDEX = 'g9:recordings';
const ISSUE_INDEX = 'g9:issues';

const recordingKey = (id) => `g9:recording:${id}`;
const issueKey = (id) => `g9:issue:${id}`;

/** Short, sortable, human-quotable. Long enough not to collide in a lifetime. */
function newId(prefix) {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}${rand}`;
}

// ------------------------------------------------------------------ IndexedDB

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        const store = db.createObjectStore(BLOB_STORE, { keyPath: 'id' });
        // Deleting an issue must be able to find its attachments without
        // scanning every blob in the database.
        store.createIndex('owner', 'owner', { unique: false });
      }
      if (!db.objectStoreNames.contains(FRAME_STORE)) {
        const frames = db.createObjectStore(FRAME_STORE, { keyPath: 'id' });
        frames.createIndex('session', 'sessionId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    // Never cache a rejected promise: a transient failure would otherwise make
    // attachments permanently unavailable for the life of the worker.
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(BLOB_STORE, mode);
        const store = transaction.objectStore(BLOB_STORE);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        transaction.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      }),
  );
}

/** Wrap an IDBRequest so tx() resolves with its result once the tx commits. */
const req = (r) => ({ __req: r });

function frameTx(mode, fn) {
  return openDb().then(
    (db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(FRAME_STORE, mode);
      const store = transaction.objectStore(FRAME_STORE);
      let result;
      try { result = fn(store); } catch (err) { reject(err); return; }
      transaction.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    }),
  );
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
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime || 'application/octet-stream' });
  await tx('readwrite', (store) =>
    req(
      store.put({
        id,
        owner,
        name: name || id,
        mime: mime || blob.type || 'application/octet-stream',
        kind,
        size: blob.size,
        at: Date.now(),
        meta,
        blob,
      }),
    ),
  );
  return { id, owner, name: name || id, mime: mime || blob.type, kind, size: blob.size, meta };
}

/** Metadata for an owner's attachments — never the bytes. */
export async function listAttachments(owner) {
  const rows = await tx('readonly', (store) => req(store.index('owner').getAll(owner)));
  return (rows || []).map(({ blob, ...meta }) => meta);
}

/** One attachment, bytes included. Base64 so it can cross the WebSocket. */
export async function getAttachment(id, { includeBytes = true } = {}) {
  const row = await tx('readonly', (store) => req(store.get(id)));
  if (!row) return null;
  const { blob, ...meta } = row;
  if (!includeBytes) return meta;
  return { ...meta, dataBase64: await blobToBase64(blob) };
}

export async function deleteAttachment(id) {
  await tx('readwrite', (store) => req(store.delete(id)));
  return { deleted: id };
}

async function deleteAttachmentsOf(owner) {
  const rows = await tx('readonly', (store) => req(store.index('owner').getAllKeys(owner)));
  if (!rows || !rows.length) return 0;
  await tx('readwrite', (store) => {
    for (const key of rows) store.delete(key);
    return rows.length;
  });
  return rows.length;
}

function blobToBase64(blob) {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let binary = '';
    // Chunked: String.fromCharCode with a few hundred thousand arguments
    // overflows the call stack, and a video attachment reaches that easily.
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  });
}

// ---------------------------------------------------------- video frame spool

/** One screencast frame in IndexedDB; session storage holds metadata only. */
export async function putVideoFrame({ sessionId, seq, at, dataBase64 }) {
  const bytes = base64ToBytes(dataBase64);
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  await frameTx('readwrite', (store) => req(store.put({
    id: `${sessionId}:${String(seq).padStart(6, '0')}`,
    sessionId,
    seq,
    at,
    size: blob.size,
    blob,
  })));
  return blob.size;
}

export async function listVideoFrames(sessionId) {
  const rows = await frameTx('readonly', (store) => req(store.index('session').getAll(sessionId)));
  const sorted = (rows ?? []).sort((a, b) => a.seq - b.seq);
  const out = [];
  for (const row of sorted) out.push({ at: row.at, data: await blobToBase64(row.blob), size: row.size });
  return out;
}

export async function deleteVideoFrames(sessionId) {
  const keys = await frameTx('readonly', (store) => req(store.index('session').getAllKeys(sessionId)));
  if (!keys?.length) return 0;
  await frameTx('readwrite', (store) => {
    for (const key of keys) store.delete(key);
    return keys.length;
  });
  return keys.length;
}

// ------------------------------------------------------------------- indices

async function readIndex(key) {
  const stored = await api.storage.local.get(key);
  return stored[key] ?? [];
}

/** Add or replace one entry in an index, newest first. */
function upsertIndex(key, entry) {
  return serialize(async () => {
    const list = await readIndex(key);
    const next = [entry, ...list.filter((e) => e.id !== entry.id)];
    await api.storage.local.set({ [key]: next });
    return next;
  });
}

function removeFromIndex(key, id) {
  return serialize(async () => {
    const list = await readIndex(key);
    await api.storage.local.set({ [key]: list.filter((e) => e.id !== id) });
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
  await api.storage.local.set({ [recordingKey(id)]: record });
  await upsertIndex(RECORDING_INDEX, {
    id,
    name: record.name ?? '(unnamed)',
    startUrl: record.startUrl ?? null,
    stepCount: (record.steps ?? []).length,
    durationMs: record.durationMs ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastRun: record.lastRun ?? null,
    suite: record.suite ?? null,
    folder: record.folder ?? null,
    tags: record.tags ?? [],
    environment: record.environment?.name ?? record.environment ?? null,
    flaky: record.flaky ?? null,
  });
  return record;
}

export function listRecordings() {
  return readIndex(RECORDING_INDEX);
}

export async function getRecording(id) {
  const stored = await api.storage.local.get(recordingKey(id));
  return stored[recordingKey(id)] ?? null;
}

export async function deleteRecording(id) {
  await api.storage.local.remove(recordingKey(id));
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
  await api.storage.local.set({ [issueKey(id)]: record });
  await upsertIndex(ISSUE_INDEX, {
    id,
    title: record.title ?? '(untitled)',
    url: record.context?.url ?? null,
    status: record.status ?? 'open',
    filedAs: record.filedAs ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
  return record;
}

export function listIssues() {
  return readIndex(ISSUE_INDEX);
}

export async function getIssue(id, { withAttachments = true } = {}) {
  const stored = await api.storage.local.get(issueKey(id));
  const issue = stored[issueKey(id)] ?? null;
  if (!issue) return null;
  return withAttachments ? { ...issue, attachments: await listAttachments(id) } : issue;
}

export async function deleteIssue(id) {
  await api.storage.local.remove(issueKey(id));
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

function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Rough usage, for the panel and for telling the user when to prune. */
export async function usage() {
  const [recordings, issues] = await Promise.all([listRecordings(), listIssues()]);
  const rows = await tx('readonly', (store) => req(store.getAll()));
  const attachmentBytes = (rows || []).reduce((sum, r) => sum + (r.size || 0), 0);
  return {
    recordings: recordings.length,
    issues: issues.length,
    attachments: (rows || []).length,
    attachmentBytes,
    attachmentMB: Math.round((attachmentBytes / 1048576) * 10) / 10,
  };
}
