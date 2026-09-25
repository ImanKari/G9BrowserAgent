#!/usr/bin/env node
/**
 * Links in the guides: every relative link points at a file that exists, and every `#anchor` at a
 * heading (or an `<a id>`) that exists in the target, with GitHub's heading slugs. External links
 * are not fetched.
 *
 *   node setup/doclinks.mjs              every Markdown file git knows (tracked or new, not ignored)
 *   node setup/doclinks.mjs README.md …  these files
 *
 * Exit 1 when a link is broken. It is what setup/check.mjs runs for a change that touches only
 * documentation; it takes about a second.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** GitHub's heading id: lower case, punctuation dropped, each space a hyphen. */
export function slug(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // a link keeps its text
    .replace(/<[^>]+>/g, '')
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const withoutCode = (text) => text.replace(/^(```|~~~)[\s\S]*?^\1/gm, '');

export function anchorsOf(text) {
  const out = new Set();
  const seen = new Map();
  for (const m of withoutCode(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const s = slug(m[1]);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    out.add(n ? `${s}-${n}` : s);
  }
  for (const m of text.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/g)) out.add(m[1]);
  return out;
}

/** Broken links of one file, as "file: why link". */
export function brokenLinks(file, { root = ROOT, cache = new Map() } = {}) {
  const abs = path.resolve(root, file);
  const text = withoutCode(fs.readFileSync(abs, 'utf8')).replace(/`[^`\n]*`/g, '');
  const anchors = (target) => {
    if (!cache.has(target)) cache.set(target, anchorsOf(fs.readFileSync(target, 'utf8')));
    return cache.get(target);
  };
  const bad = [];
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const link = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue; // http:, https:, mailto:, vscode:, …
    const [p, hash] = link.split('#');
    let target = abs;
    if (p) {
      try { target = path.resolve(path.dirname(abs), decodeURIComponent(p)); } catch { bad.push(`${file}: undecodable ${link}`); continue; }
    }
    if (!fs.existsSync(target)) { bad.push(`${file}: no such file ${link}`); continue; }
    if (hash && /\.md$/i.test(target) && !anchors(target).has(hash)) bad.push(`${file}: no heading for ${link}`);
  }
  return bad;
}

function markdownFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\0').filter((f) => f && fs.existsSync(path.join(ROOT, f)));
  } catch {
    const found = [];
    const skip = new Set(['node_modules', '.git', 'dist', '.kilo', 'out']);
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(dir, e.name)); } else if (e.name.endsWith('.md')) found.push(path.relative(ROOT, path.join(dir, e.name)));
      }
    };
    walk(ROOT);
    return found;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const files = args.length ? args : markdownFiles();
  const cache = new Map();
  const bad = files.flatMap((f) => brokenLinks(f, { cache }));
  for (const b of bad) console.log(`  FAIL ${b}`);
  console.log(bad.length ? `${bad.length} broken link(s) in ${files.length} file(s)` : `  PASS links and anchors in ${files.length} Markdown file(s)`);
  process.exit(bad.length ? 1 : 0);
}
