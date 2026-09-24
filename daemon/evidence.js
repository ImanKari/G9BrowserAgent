/**
 * Evidence: the runs directory (ARCHITECTURE §9) and download verification.
 *
 *   runs/<runId>/engine.json      who ran, on what browser, with which argv/seed
 *                frames/<seq>.jpg screencast frames (only while a run or a watch is active)
 *                frames.jsonl     { seq, at, bytes, metadata } per frame
 *                pointer.jsonl    the cursor track { at, x, y, buttons, type } (D9)
 *                downloads.jsonl  verified downloads (path, size, sha256, sniffed type); the files
 *                                 themselves stay in G9_HOME/downloads/<contextId>/
 *                result.json      the outcome, written last
 *
 * Why the cursor is a track and not a picture: a DOM overlay is visible to the
 * page and to its MutationObservers (plan D9, rule R4). A track beside the
 * frames is invisible to the page and lets every viewer — the desktop watch
 * window, report.html — draw the same moving cursor.
 *
 * Caps come from settings.evidence. A run that exceeds them keeps counting and
 * stops writing, and says so in result.json: a spool that silently fills a
 * disk overnight is how an unattended runner gets switched off.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from './paths.js';

export function newRunId(kind = 'run') {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-` +
    `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  const safeKind = String(kind).replace(/[^a-z0-9-]/gi, '').slice(0, 16) || 'run';
  return `${stamp}-${safeKind}-${crypto.randomBytes(3).toString('hex')}`;
}

const RUN_ID = /^[A-Za-z0-9-]{6,80}$/;

// ------------------------------------------------------------ file sniffing

/**
 * Magic numbers for the files a QA suite actually downloads. The point is to
 * catch "the export returned an HTML error page named report.xlsx", which a 200
 * response and a non-zero size both miss.
 */
const MAGIC = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  // 'BM' / 'MZ' / 'BZh' are two or three printable letters, so text can start with them
  // ("BMW,…" in a CSV). Each carries a structural check besides the letters.
  { mime: 'image/bmp', bytes: [0x42, 0x4d], minLength: 26, check: (b) => [12, 40, 52, 56, 64, 108, 124].includes(b.readUInt32LE(14)) },
  { mime: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { mime: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { mime: 'image/x-icon', bytes: [0x00, 0x00, 0x01, 0x00] },
  { mime: 'application/gzip', bytes: [0x1f, 0x8b] },
  { mime: 'application/x-7z-compressed', bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { mime: 'application/vnd.rar', bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { mime: 'application/x-bzip2', bytes: [0x42, 0x5a, 0x68], minLength: 4, check: (b) => b[3] >= 0x31 && b[3] <= 0x39 },
  { mime: 'application/x-ole-storage', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { mime: 'application/x-msdownload', bytes: [0x4d, 0x5a], minLength: 64, check: (b) => b.subarray(2, 64).includes(0) },
  { mime: 'video/webm', bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { mime: 'audio/ogg', bytes: [0x4f, 0x67, 0x67, 0x53] },
  { mime: 'audio/flac', bytes: [0x66, 0x4c, 0x61, 0x43] },
  { mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },
  { mime: 'font/woff', bytes: [0x77, 0x4f, 0x46, 0x46] },
  { mime: 'font/woff2', bytes: [0x77, 0x4f, 0x46, 0x32] },
  { mime: 'application/wasm', bytes: [0x00, 0x61, 0x73, 0x6d] },
  { mime: 'application/x-sqlite3', bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66] },
];

const ZIP_FLAVOURS = [
  [/\.docx$/i, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  [/\.xlsx$/i, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  [/\.pptx$/i, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  [/\.odt$/i, 'application/vnd.oasis.opendocument.text'],
  [/\.ods$/i, 'application/vnd.oasis.opendocument.spreadsheet'],
  [/\.jar$/i, 'application/java-archive'],
  [/\.apk$/i, 'application/vnd.android.package-archive'],
  [/\.epub$/i, 'application/epub+zip'],
];

const OLE_FLAVOURS = [
  [/\.doc$/i, 'application/msword'],
  [/\.xls$/i, 'application/vnd.ms-excel'],
  [/\.ppt$/i, 'application/vnd.ms-powerpoint'],
  [/\.msi$/i, 'application/x-msi'],
];

const startsWith = (bytes, sig, offset = 0) => sig.every((b, i) => bytes[offset + i] === b);

/**
 * Sniff a MIME type from the first bytes of a file. `name` refines container
 * formats (a .xlsx IS a zip) and never overrides contradicting content: an HTML
 * body saved as report.pdf is reported as text/html, which is the whole point.
 */
export function sniffMime(input, name = '') {
  const raw = input instanceof Uint8Array ? input : Buffer.from(input ?? []);
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (!bytes.length) return 'application/x-empty';
  // Byte-order marks first: FF FE (UTF-16 LE, how Excel and PowerShell write
  // "Unicode text") also satisfies the MPEG audio frame-sync test below, and a
  // text export reported as audio/mpeg is exactly the wrong answer.
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return 'text/plain; charset=utf-16';

  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    for (const [re, mime] of ZIP_FLAVOURS) if (re.test(name)) return mime;
    return 'application/zip';
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12) {
    const kind = Buffer.from(bytes.subarray(8, 12)).toString('latin1');
    if (kind === 'WEBP') return 'image/webp';
    if (kind === 'WAVE') return 'audio/wav';
    if (kind === 'AVI ') return 'video/x-msvideo';
    return 'application/octet-stream';
  }
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(4, 8)).toString('latin1') === 'ftyp') {
    const brand = Buffer.from(bytes.subarray(8, 12)).toString('latin1');
    if (/^(avif|avis)/.test(brand)) return 'image/avif';
    if (/^(heic|heix|mif1)/.test(brand)) return 'image/heic';
    if (/^qt/.test(brand)) return 'video/quicktime';
    if (/^M4A/.test(brand)) return 'audio/mp4';
    return 'video/mp4';
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    for (const [re, mime] of OLE_FLAVOURS) if (re.test(name)) return mime;
    return 'application/x-ole-storage';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && bytes[1] !== 0xff && !startsWith(bytes, [0xff, 0xd8])) {
    return 'audio/mpeg';
  }
  for (const entry of MAGIC) {
    if (entry.minLength && bytes.length < entry.minLength) continue;
    if (startsWith(bytes, entry.bytes) && (!entry.check || entry.check(bytes))) return entry.mime;
  }

  // Text: decide by content, not by name. BOMs first.
  let text;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) text = Buffer.from(bytes.subarray(3, 1027)).toString('utf8');
  else {
    const head = bytes.subarray(0, 1024);
    let control = 0;
    for (const b of head) if (b === 0 || (b < 0x09) || (b > 0x0d && b < 0x20 && b !== 0x1b)) control += 1;
    if (control > 0) return 'application/octet-stream';
    text = Buffer.from(head).toString('utf8');
  }
  const t = text.replace(/^\s+/, '').toLowerCase();
  if (t.startsWith('<?xml')) return /<svg[\s>]/.test(t) ? 'image/svg+xml' : 'application/xml';
  if (t.startsWith('<!doctype html') || t.startsWith('<html') || /^<(head|body|script|div|meta|title)[\s>]/.test(t)) return 'text/html';
  if (t.startsWith('<svg')) return 'image/svg+xml';
  if (t.startsWith('{') || t.startsWith('[')) return 'application/json';
  if (t.startsWith('%!ps')) return 'application/postscript';
  if (/\.csv$/i.test(name) || /^[^\n,]+(,[^\n,]*)+\r?\n/.test(text)) return 'text/csv';
  return 'text/plain';
}

/**
 * The `fileInfo` hook platform-cdp calls for Engine 2 downloads (§3.2):
 * exists, size, sha256, first 16 bytes as hex, sniffed MIME.
 */
export async function fileInfo(file) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return { exists: false, size: 0, sha256: null, magicHex: null, mime: null };
  }
  if (!stat.isFile()) return { exists: false, size: 0, sha256: null, magicHex: null, mime: null };

  const hash = crypto.createHash('sha256');
  let head = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => {
      hash.update(chunk);
      if (head.length < 1024) head = Buffer.concat([head, chunk.subarray(0, 1024 - head.length)]);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return {
    exists: true,
    size: stat.size,
    sha256: hash.digest('hex'),
    magicHex: head.subarray(0, 16).toString('hex'),
    mime: sniffMime(head, path.basename(file)),
  };
}

// ------------------------------------------------------------ runs

export class Evidence {
  /** The tail of the prune queue: passes run one after another, never at once (see prune()). */
  #pruneChain = Promise.resolve();

  constructor({ runsDir, settings = null, log = () => {} }) {
    this.runsDir = runsDir;
    this.settings = settings;
    this.log = log;
    this.active = new Map(); // runId → run state
  }

  caps() {
    const e = this.settings?.get?.().evidence ?? {};
    return {
      maxFrames: e.maxFrames ?? 3000,
      maxBytes: e.maxBytes ?? 300 * 1024 * 1024,
      keepRuns: e.keepRuns ?? 200,
    };
  }

  dirOf(runId) {
    if (!RUN_ID.test(String(runId))) throw new Error(`Invalid run id "${runId}".`);
    return path.join(this.runsDir, runId);
  }

  /** Begin a run: creates the directory and engine.json. Returns { runId, dir }. */
  async startRun({ kind = 'run', label = null, tabId = null, engine = null, meta = {} } = {}) {
    const runId = newRunId(kind);
    const dir = this.dirOf(runId);
    await fsp.mkdir(path.join(dir, 'frames'), { recursive: true });
    const run = {
      runId,
      dir,
      kind,
      label,
      tabId,
      startedAt: Date.now(),
      seq: 0,
      framesWritten: 0,
      framesDropped: 0,
      bytes: 0,
      pointerSamples: 0,
      chain: Promise.resolve(),
      truncated: null,
    };
    this.active.set(runId, run);
    await writeFileAtomic(path.join(dir, 'engine.json'), `${JSON.stringify({
      runId, kind, label, tabId, startedAt: run.startedAt, engine, ...meta,
    }, null, 2)}\n`);
    this.prune().catch(() => {});
    return { runId, dir };
  }

  isActive(runId) {
    return this.active.has(runId);
  }

  /** Append work to a run's own chain, so frames land in order and never race result.json. */
  #queue(run, fn) {
    run.chain = run.chain.then(fn).catch((err) => this.log(`[evidence] ${run.runId}: ${err.message}`));
    return run.chain;
  }

  /** One screencast frame { data: base64 jpeg, metadata, at }. Returns false when dropped. */
  frame(runId, frame) {
    const run = this.active.get(runId);
    if (!run || !frame?.data) return false;
    const caps = this.caps();
    const bytes = Buffer.from(frame.data, 'base64');
    if (run.framesWritten >= caps.maxFrames || run.bytes + bytes.length > caps.maxBytes) {
      run.framesDropped += 1;
      run.truncated ??= run.framesWritten >= caps.maxFrames
        ? `frame cap reached (${caps.maxFrames} frames)`
        : `byte cap reached (${caps.maxBytes} bytes)`;
      return false;
    }
    run.seq += 1;
    run.framesWritten += 1;
    run.bytes += bytes.length;
    const seq = run.seq;
    const at = frame.at ?? Date.now();
    this.#queue(run, async () => {
      const name = `${String(seq).padStart(6, '0')}.jpg`;
      await fsp.writeFile(path.join(run.dir, 'frames', name), bytes);
      await fsp.appendFile(
        path.join(run.dir, 'frames.jsonl'),
        `${JSON.stringify({ seq, at, file: `frames/${name}`, bytes: bytes.length, metadata: frame.metadata ?? null })}\n`,
      );
    });
    return true;
  }

  /** One cursor sample { at, x, y, buttons, type }. */
  pointer(runId, sample) {
    const run = this.active.get(runId);
    if (!run || !sample) return false;
    run.pointerSamples += 1;
    this.#queue(run, () => fsp.appendFile(path.join(run.dir, 'pointer.jsonl'), `${JSON.stringify(sample)}\n`));
    return true;
  }

  /** Record a verified download in the run. */
  download(runId, info) {
    const run = this.active.get(runId);
    if (!run) return false;
    this.#queue(run, () => fsp.appendFile(path.join(run.dir, 'downloads.jsonl'), `${JSON.stringify({ at: Date.now(), ...info })}\n`));
    return true;
  }

  /** Close a run: waits for pending writes, then writes result.json. */
  async finishRun(runId, result = {}) {
    const run = this.active.get(runId);
    if (!run) return null;
    this.active.delete(runId);
    await run.chain;
    const summary = {
      runId,
      kind: run.kind,
      label: run.label,
      tabId: run.tabId,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - run.startedAt,
      frames: run.framesWritten,
      framesDropped: run.framesDropped,
      frameBytes: run.bytes,
      pointerSamples: run.pointerSamples,
      ...(run.truncated ? { truncated: run.truncated } : {}),
      ...result,
    };
    await writeFileAtomic(path.join(run.dir, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }

  /**
   * Close every run still open — the daemon is stopping. A run directory with
   * no result.json reads as "still running" forever; one that says why it
   * ended does not.
   */
  async finishAll(result = {}) {
    const ids = [...this.active.keys()];
    for (const runId of ids) await this.finishRun(runId, { ok: false, ...result }).catch(() => {});
    return ids;
  }

  /**
   * Runs open right now, newest first: `{ runId, kind, label, startedAt }`. What admin `state`
   * and `/health` report as `activeRuns` (F6) — the desktop may not restart the daemon (an app
   * update) under any of them, whatever their age.
   */
  activeRuns() {
    return [...this.active.values()]
      .map((r) => ({ runId: r.runId, kind: r.kind, label: r.label, startedAt: r.startedAt }))
      .sort((a, b) => (a.runId < b.runId ? 1 : -1));
  }

  /**
   * Run rows, newest first. `active:true` (F6) lists every run still open, however old — a
   * newest-`limit` window could miss a long scheduled run started before fifty short ones;
   * `limit` then applies to nothing (the open runs are few by nature).
   */
  async list({ limit = 50, active = false } = {}) {
    let names = [];
    if (active) {
      names = this.activeRuns().map((r) => r.runId);
    } else {
      try {
        names = (await fsp.readdir(this.runsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        return [];
      }
      names.sort().reverse();
      names = names.slice(0, Math.max(1, limit));
    }
    const out = [];
    for (const runId of names) {
      const dir = path.join(this.runsDir, runId);
      const engine = await readJson(path.join(dir, 'engine.json'));
      const result = await readJson(path.join(dir, 'result.json'));
      out.push({
        runId,
        kind: engine?.kind ?? result?.kind ?? null,
        label: engine?.label ?? result?.label ?? null,
        startedAt: engine?.startedAt ?? result?.startedAt ?? null,
        finishedAt: result?.finishedAt ?? null,
        active: this.active.has(runId),
        ok: result?.ok ?? null,
        verdict: result?.verdict ?? null,
        exitCode: result?.exitCode ?? null,
        frames: result?.frames ?? this.active.get(runId)?.framesWritten ?? 0,
        dir: dir.replace(/\\/g, '/'),
      });
    }
    return out;
  }

  async get(runId) {
    const dir = this.dirOf(runId);
    const engine = await readJson(path.join(dir, 'engine.json'));
    if (!engine) throw new Error(`No run "${runId}".`);
    const result = await readJson(path.join(dir, 'result.json'));
    let files = [];
    try {
      files = (await fsp.readdir(dir, { withFileTypes: true })).map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
    } catch { /* empty */ }
    return { runId, dir: dir.replace(/\\/g, '/'), engine, result, files, active: this.active.has(runId) };
  }

  /**
   * Keep the newest `keepRuns` run directories; never touch an active one.
   *
   * Serialised, one pass at a time. startRun() fires a prune and does not wait
   * for it — housekeeping must never delay a run — so a second run starting, or
   * a caller pruning by hand, meets a pass already in flight. Two recursive
   * deletes of the SAME run directory race: on Windows the loser throws EPERM
   * (a file it listed is already gone, or is pending-delete with a handle still
   * open) and returns while the winner is still deleting. Measured here under
   * load: 16 of 80 concurrent pairs had the first call fail, and in 5 of 80 the
   * directory was still on disk when that first call returned — so `await
   * prune()` did not mean "pruned". Queueing the passes removes both the EPERM
   * churn and that lie.
   */
  prune() {
    const run = () => this.#pruneOnce();
    const next = this.#pruneChain.then(run, run);
    this.#pruneChain = next.then(() => {}, () => {});
    return next;
  }

  async #pruneOnce() {
    const { keepRuns } = this.caps();
    let names = [];
    try {
      names = (await fsp.readdir(this.runsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return 0;
    }
    names.sort().reverse();
    let removed = 0;
    for (const name of names.slice(keepRuns)) {
      if (this.active.has(name) || !RUN_ID.test(name)) continue;
      // Windows refuses a delete while another process (antivirus, the indexer,
      // a backup agent) holds a file open, with EPERM/EBUSY, for a few
      // milliseconds — the same short window paths.js retries a rename for.
      // Without the retries the directory survives the pass (silently: the
      // failure is swallowed and it is counted as removed anyway) and the caps
      // the settings promise are only met whenever the next run happens to
      // start. node's rm retries exactly these codes.
      await fsp.rm(path.join(this.runsDir, name), { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }).catch(() => {});
      removed += 1;
    }
    return removed;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
