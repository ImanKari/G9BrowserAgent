/**
 * JSON files that survive a crash mid-write: write a sibling temp file, then rename over the target.
 * A half-written desktop.json or policies.json would lose the wizard's progress or, worse, the
 * previous registry values that Undo needs — so no file here is ever written in place.
 */

import fs from 'node:fs';
import path from 'node:path';

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows refuses a rename over a file another process holds open for reading; retry as copy.
    try {
      fs.copyFileSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    if (!fs.existsSync(file)) throw err;
  }
}

export function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.copyFileSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    if (!fs.existsSync(file)) throw err;
  }
}

/** Plain-object deep merge; arrays and non-plain values replace. `undefined` in the patch is ignored. */
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
