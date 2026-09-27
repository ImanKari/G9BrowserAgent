/**
 * Verify release artifacts the way electron-updater will read them.
 *
 *   node scripts/verify-artifacts.mjs <dir> [--version <v>] [--expect win,mac,linux]
 *
 * For every update-metadata file in <dir> (latest.yml, latest-mac.yml, latest-linux.yml) it checks:
 *   - `version` is the expected version (default: desktop/package.json);
 *   - every file it lists exists in <dir> with exactly that size and SHA-512 (base64) — the check
 *     electron-updater makes after downloading, so a mismatch here is an update that would fail on
 *     every machine;
 *   - `path`/`sha512` (the legacy top-level fields some updaters read) name one of those files.
 * With --expect it also requires each listed platform's metadata and installers to be present:
 *   win   latest.yml, G9BrowserAgent-Setup-<v>.exe (+ .blockmap)
 *   mac   latest-mac.yml, a .dmg and a .zip for x64 and arm64
 *   linux latest-linux.yml, G9BrowserAgent-x86_64.AppImage (no version in its name: it updates in place) and the .deb
 * Exit 0 when everything holds, 1 with every problem listed otherwise. No dependencies.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parse the small YAML electron-builder writes for update metadata. Only what that writer emits:
 * top-level scalars and a `files:` list of flat mappings. Pure.
 */
export function parseUpdateYml(text) {
  const out = { files: [] };
  let inFiles = false;
  let cur = null;
  const unquote = (v) => {
    const s = v.trim();
    if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1);
    return s;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(raw);
    if (top) {
      inFiles = top[1] === 'files' && top[2] === '';
      cur = null;
      if (!inFiles) out[top[1]] = unquote(top[2]);
      continue;
    }
    if (!inFiles) continue;
    const item = /^\s*-\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(raw);
    if (item) {
      cur = { [item[1]]: unquote(item[2]) };
      out.files.push(cur);
      continue;
    }
    const field = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(raw);
    if (field && cur) cur[field[1]] = unquote(field[2]);
  }
  for (const f of out.files) if (f.size !== undefined) f.size = Number(f.size);
  return out;
}

export function sha512Base64(file) {
  const h = crypto.createHash('sha512');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('base64');
}

export const METADATA = { win: 'latest.yml', mac: 'latest-mac.yml', linux: 'latest-linux.yml' };

/**
 * Every production dependency the lock file lists must be inside the packed app.asar — or the
 * packaged app throws "Cannot find module" the moment it loads it (electron-updater without
 * fs-extra & co. was packed once, and only the real update test caught it). Pure file reads.
 * @returns {string[]} problems
 */
export function verifyPackedDependencies(asarFile, lockFile) {
  const problems = [];
  if (!fs.existsSync(asarFile)) return [`${asarFile} does not exist`];
  if (!fs.existsSync(lockFile)) return [`${lockFile} does not exist (commit desktop/package-lock.json)`];
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const wanted = Object.entries(lock.packages ?? {})
    .filter(([key, p]) => key.startsWith('node_modules/') && !p.dev && !p.devOptional && !p.optional)
    .map(([key]) => key.replace(/^node_modules\//, ''))
    .filter((name) => !name.includes('/node_modules/'));
  const packed = new Set(asarEntries(asarFile).map((p) => /^\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(p)?.[1]).filter(Boolean));
  for (const name of wanted) if (!packed.has(name)) problems.push(`app.asar lacks node_modules/${name} (a production dependency in package-lock.json)`);
  return problems;
}

/**
 * The file list of an asar archive, read from its header (the format electron's own fs uses:
 * 16 bytes of pickle sizes, then a JSON tree). No dependency on @electron/asar.
 */
export function asarEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const jsonSize = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    fs.readSync(fd, json, 0, jsonSize, 16);
    const tree = JSON.parse(json.toString('utf8'));
    const out = [];
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const p = `${prefix}/${name}`;
        out.push(p);
        if (child.files) walk(child, p);
      }
    };
    walk(tree, '');
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** Every problem with the artifacts in `dir`, [] when they are sound. */
export function verifyArtifacts(dir, { version, expect = [] } = {}) {
  const problems = [];
  const has = (name) => fs.existsSync(path.join(dir, name));
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const metas = names.filter((n) => /^latest(-mac|-linux)?\.yml$/.test(n));
  if (!metas.length) problems.push(`no latest*.yml in ${dir}`);
  for (const meta of metas) {
    const info = parseUpdateYml(fs.readFileSync(path.join(dir, meta), 'utf8'));
    if (version && info.version !== version) problems.push(`${meta}: version ${info.version}, expected ${version}`);
    if (!info.files.length) problems.push(`${meta}: lists no files`);
    for (const f of info.files) {
      const file = path.join(dir, f.url ?? '');
      if (!f.url || !fs.existsSync(file)) {
        problems.push(`${meta}: ${f.url} is listed but missing`);
        continue;
      }
      const size = fs.statSync(file).size;
      if (f.size !== size) problems.push(`${meta}: ${f.url} is ${size} bytes, the metadata says ${f.size}`);
      const sha = sha512Base64(file);
      if (f.sha512 !== sha) problems.push(`${meta}: ${f.url} SHA-512 does not match the metadata (an updater would reject it)`);
    }
    if (info.path && !info.files.some((f) => f.url === info.path)) problems.push(`${meta}: path ${info.path} is not one of its files`);
  }
  const v = version ?? '*';
  const need = {
    win: [METADATA.win, `G9BrowserAgent-Setup-${v}.exe`, `G9BrowserAgent-Setup-${v}.exe.blockmap`],
    mac: [METADATA.mac, `G9BrowserAgent-${v}-mac-x64.dmg`, `G9BrowserAgent-${v}-mac-arm64.dmg`, `G9BrowserAgent-${v}-mac-x64.zip`, `G9BrowserAgent-${v}-mac-arm64.zip`],
    linux: [METADATA.linux, 'G9BrowserAgent-x86_64.AppImage', `G9BrowserAgent_${v}_amd64.deb`],
  };
  for (const p of expect) {
    for (const n of need[p] ?? [`(unknown platform ${p})`]) if (!has(n)) problems.push(`${p}: ${n} is missing`);
  }
  return problems;
}

// ------------------------------------------------------------------ CLI

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const dir = path.resolve(args.find((a, i) => !a.startsWith('--') && !['--version', '--expect'].includes(args[i - 1])) ?? path.join(appDir, 'dist'));
  const version = opt('--version') ?? JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
  const expect = (opt('--expect') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const problems = verifyArtifacts(dir, { version, expect });
  const listed = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile()) : [];
  for (const n of listed) console.log(`  ${n}  ${(fs.statSync(path.join(dir, n)).size / 1048576).toFixed(1)} MB`);
  if (problems.length) {
    console.error(`\nArtifact verification FAILED (${problems.length}):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`\nArtifacts verified: ${version}${expect.length ? ` (${expect.join(', ')})` : ''} — every file the update metadata lists is present with its exact size and SHA-512.`);
}
