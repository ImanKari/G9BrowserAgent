import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { suite, tmpDir, rmrf } from './harness.mjs';
import { readRunLocal, readFrame, saveVideo, runDir, normalizeFrames, readJsonl } from '../lib/runs-store.mjs';
import { iconPng, drawIcon, crc32, ICON_COLORS } from '../lib/icon.mjs';

const t = suite('desktop: run evidence on disk, and the drawn icon');
const runs = tmpDir();
t.cleanup(() => rmrf(runs));

function makeRun(id, { pointerFile = true } = {}) {
  const dir = path.join(runs, id);
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'frames', '1.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]));
  fs.writeFileSync(path.join(dir, 'frames', '2.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 3, 4]));
  fs.writeFileSync(path.join(dir, 'frames.jsonl'), [
    JSON.stringify({ seq: 2, timestamp: 2000, metadata: { deviceWidth: 1280, deviceHeight: 800 }, pointer: { x: 20, y: 20, buttons: 0 } }),
    JSON.stringify({ seq: 1, at: 1000, file: 'frames/1.jpg', metadata: { deviceWidth: 1280, deviceHeight: 800 }, pointer: { x: 10, y: 10, buttons: 1 } }),
    '{"seq": 3, "at": 30', // a torn last line from a run still being written
  ].join('\n'));
  if (pointerFile) {
    fs.writeFileSync(path.join(dir, 'pointer.jsonl'), [
      JSON.stringify({ timestamp: 1500, x: 15, y: 15, buttons: 0 }),
      JSON.stringify({ at: 1000, x: 10, y: 10, buttons: 0 }),
    ].join('\n'));
  }
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ verdict: 'PASS' }));
  return dir;
}

t.test('readRunLocal: frames sorted by time, file names normalised, torn lines skipped, pointer track sorted', () => {
  makeRun('run-1');
  const r = readRunLocal(runs, 'run-1');
  assert.equal(r.exists, true);
  assert.deepEqual(r.frames.map((f) => [f.seq, f.at, f.file]), [[1, 1000, '1.jpg'], [2, 2000, '2.jpg']]);
  assert.deepEqual(r.pointer.map((p) => [p.at, p.x]), [[1000, 10], [1500, 15]]);
  assert.deepEqual(r.result, { verdict: 'PASS' });
  assert.equal(r.video, null);
});

t.test('without pointer.jsonl the per-frame pointer fields stand in', () => {
  makeRun('run-2', { pointerFile: false });
  const r = readRunLocal(runs, 'run-2');
  assert.deepEqual(r.pointer.map((p) => [p.at, p.x, p.buttons]), [[1000, 10, 1], [2000, 20, 0]]);
});

t.test('a run that does not exist says so', () => {
  const r = readRunLocal(runs, 'nope');
  assert.equal(r.exists, false);
  assert.deepEqual(r.frames, []);
});

t.test('frames are read by name only: no traversal through the run id or the file name', () => {
  assert.deepEqual([...readFrame(runs, 'run-1', '1.jpg')], [0xff, 0xd8, 0xff, 0xe0, 1, 2]);
  assert.throws(() => readFrame(runs, 'run-1', '../result.json'), /Not a frame file name/);
  assert.throws(() => readFrame(runs, 'run-1', '..\\..\\x.jpg'), /Not a frame file name/);
  assert.throws(() => readFrame(runs, '../etc', '1.jpg'), /Not a run id/);
  assert.throws(() => runDir(runs, ''), /Not a run id/);
});

t.test('saveVideo writes WebM only (EBML magic), atomically, into the run folder', () => {
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100, 7)]);
  const r = saveVideo(runs, 'run-1', new Uint8Array(webm));
  assert.equal(r.size, 104);
  assert.ok(fs.readFileSync(path.join(runs, 'run-1', 'video.webm')).equals(webm));
  assert.throws(() => saveVideo(runs, 'run-1', Buffer.from('MZ not a video')), /not WebM/);
  assert.throws(() => saveVideo(runs, 'run-1', new Uint8Array()), /no data/);
  assert.equal(readRunLocal(runs, 'run-1').video.size, 104);
});

t.test('normalizeFrames / readJsonl edge cases', () => {
  assert.deepEqual(normalizeFrames([{ seq: 'x' }, { seq: 1 }]), []);
  assert.deepEqual(normalizeFrames([{ seq: 4, metadata: { timestamp: 1.5 } }]).map((f) => f.at), [1500]);
  assert.deepEqual(readJsonl(path.join(runs, 'missing.jsonl')), []);
});

t.test('the icon is a valid PNG: signature, IHDR, CRCs, inflated size, transparent corners, glyph in the middle', () => {
  const png = iconPng(32, 'connected');
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let off = 8;
  const chunks = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString('ascii');
    const data = png.subarray(off + 8, off + 8 + len);
    assert.equal(png.readUInt32BE(off + 8 + len), crc32(png.subarray(off + 4, off + 8 + len)), `CRC of ${type}`);
    chunks.push({ type, data });
    off += 12 + len;
  }
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  assert.equal(chunks[0].data.readUInt32BE(0), 32);
  assert.equal(chunks[0].data.readUInt32BE(4), 32);
  assert.equal(zlib.inflateSync(chunks[1].data).length, (32 * 4 + 1) * 32);
  const { rgba } = drawIcon(32, 'halted');
  assert.equal(rgba[3], 0, 'top-left corner is transparent (rounded)');
  const centre = (16 * 32 + 16) * 4;
  assert.equal(rgba[centre + 3], 255);
  const [r, g, b] = ICON_COLORS.halted;
  const px = (4 * 32 + 28) * 4; // right edge, background colour
  assert.deepEqual([rgba[px], rgba[px + 1], rgba[px + 2]], [r, g, b]);
  assert.ok(iconPng(256).length > 1000);
});

t.run();
