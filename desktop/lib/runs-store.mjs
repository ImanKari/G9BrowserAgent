/**
 * Reading a run's evidence straight from G9_HOME/runs/<runId>/ (ARCHITECTURE_V2 §9):
 *   frames/<seq>.jpg, frames.jsonl (seq, timestamp, metadata), pointer.jsonl (timestamp, x, y,
 *   buttons), engine.json, result.json.
 *
 * Why the desktop reads files instead of asking the daemon for every frame: a replay scrubs through
 * hundreds of JPEGs; pushing each through the WebSocket as base64 would double the bytes and block
 * live traffic. The desktop is on the same machine and the layout is part of the contract.
 * `runs.get` still supplies the verdict/steps/surprises; this supplies the pictures and the cursor.
 *
 * Every path is built from a validated run id and a validated file name — the renderer can only
 * name a run and a frame, never a path.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './jsonfile.mjs';
import { normalizeSample } from '../renderer/lib/track.js';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FRAME_FILE = /^[A-Za-z0-9._-]{1,64}\.(jpe?g|png)$/i;

export function runDir(runsDir, runId) {
  if (!RUN_ID.test(String(runId ?? ''))) throw new Error(`Not a run id: ${runId}`);
  const dir = path.join(runsDir, String(runId));
  if (path.relative(runsDir, dir).startsWith('..')) throw new Error('Run id escapes the runs folder');
  return dir;
}

export function readJsonl(file, { max = 200_000 } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn last line from a run still being written */
    }
    if (out.length >= max) break;
  }
  return out;
}

/** Frame index rows, normalised: { seq, at, file, metadata }. */
export function normalizeFrames(rows) {
  const frames = [];
  for (const r of rows) {
    const seq = Number(r.seq ?? r.n ?? r.index);
    const at = Number(r.at ?? r.timestamp ?? r.t ?? (r.metadata?.timestamp ? r.metadata.timestamp * 1000 : NaN));
    if (!Number.isFinite(seq) || !Number.isFinite(at)) continue;
    const file = r.file ? path.basename(String(r.file)) : `${seq}.jpg`;
    frames.push({ seq, at, file, metadata: r.metadata ?? null, pointer: r.pointer ?? null });
  }
  frames.sort((a, b) => a.at - b.at || a.seq - b.seq);
  return frames;
}

/**
 * The replay index for a run. The pointer track comes from pointer.jsonl; when that is missing
 * (older runs), the per-frame `pointer` fields recorded by issues.js video frames stand in.
 */
export function readRunLocal(runsDir, runId) {
  const dir = runDir(runsDir, runId);
  if (!fs.existsSync(dir)) return { exists: false, dir, frames: [], pointer: [], result: null, engine: null };
  const frames = normalizeFrames(readJsonl(path.join(dir, 'frames.jsonl')));
  let pointer = readJsonl(path.join(dir, 'pointer.jsonl')).map(normalizeSample).filter(Boolean);
  if (!pointer.length) {
    pointer = frames.filter((f) => f.pointer).map((f) => normalizeSample({ at: f.at, ...f.pointer })).filter(Boolean);
  }
  pointer.sort((a, b) => a.at - b.at);
  let video = null;
  try {
    const st = fs.statSync(path.join(dir, 'video.webm'));
    video = { size: st.size, at: st.mtimeMs };
  } catch {
    /* none yet */
  }
  return {
    exists: true,
    dir,
    frames,
    pointer,
    result: readJson(path.join(dir, 'result.json'), null),
    engine: readJson(path.join(dir, 'engine.json'), null),
    video,
  };
}

/** One frame's bytes. */
export function readFrame(runsDir, runId, file) {
  const name = String(file ?? '');
  if (!FRAME_FILE.test(name)) throw new Error(`Not a frame file name: ${name}`);
  return fs.readFileSync(path.join(runDir(runsDir, runId), 'frames', name));
}

/** Save the exported video (canvas + MediaRecorder in the renderer, plan §P6.3). */
export function saveVideo(runsDir, runId, bytes, { maxBytes = 2 * 1024 * 1024 * 1024 } = {}) {
  const buf = Buffer.from(bytes);
  if (!buf.length) throw new Error('The recorder produced no data.');
  if (buf.length > maxBytes) throw new Error('The video is larger than 2 GB; not saved.');
  // WebM starts with the EBML magic 1A 45 DF A3 — refuse anything else under that name.
  if (!(buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3)) throw new Error('The recorder output is not WebM.');
  const dir = runDir(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'video.webm');
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, target);
  return { path: target, size: buf.length };
}
