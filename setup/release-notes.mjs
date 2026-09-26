/**
 * The GitHub release notes for one version: what to download per platform, how updates arrive
 * there, this version's entry from the AIGuide change log, and the SHA-256 of every file.
 *
 *   node setup/release-notes.mjs --version <v> [--dir <release folder with SHA256SUMS.txt>] [--out <file>]
 *
 * Used by azure-pipelines.yml (Release stage). No dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const version = opt('--version') ?? JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const dir = opt('--dir');
const out = opt('--out');

/** This version's change-log entry: from its "### <date> — v<version>" heading to the next "### ". */
export function changeLogEntry(guide, v) {
  const lines = guide.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^### .*\\bv${v.replace(/\./g, '\\.')}\\b`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^#{2,3} /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

/**
 * Repository-relative links resolve against the release page on GitHub, where they break: point
 * them at the files as they are at this release's tag.
 */
export function absoluteLinks(markdown, v, repoUrl = 'https://github.com/ImanKari/G9BrowserAgent') {
  return markdown.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_m, target) => `](${repoUrl}/blob/v${v}/${target.replace(/^\.\//, '')})`);
}

const guide = fs.readFileSync(path.join(ROOT, 'AIGuide.md'), 'utf8');
const raw = changeLogEntry(guide, version);
const entry = raw ? absoluteLinks(raw, version) : null;
const sums = dir && fs.existsSync(path.join(dir, 'SHA256SUMS.txt')) ? fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8').trim() : null;

const notes = `## Download

| System | File | Updates |
|---|---|---|
| Windows 10/11 (x64) | \`G9-Setup-${version}.exe\` — per user, no administrator rights | Automatic: G9 checks these releases, downloads in the background and asks before installing |
| macOS 12+ (Apple silicon) | \`G9-${version}-mac-arm64.dmg\` | G9 tells you when a release is out; download it and replace the app (the app is not signed with an Apple Developer ID yet, so macOS cannot install updates into it) |
| macOS 12+ (Intel) | \`G9-${version}-mac-x64.dmg\` | As above |
| Linux (x64) | \`G9-x86_64.AppImage\` — keep this file name: updates replace the file in place | Automatic, like Windows |
| Debian/Ubuntu (x64) | \`G9_${version}_amd64.deb\` | G9 tells you; install the new .deb with your package manager |

The installers are **not code-signed**: Windows SmartScreen and macOS Gatekeeper ask once before the first start. See the README for what to click, and for the browser extension (loaded once, updated by G9 itself).

\`latest.yml\`, \`latest-mac.yml\` and \`latest-linux.yml\` are the update metadata G9 reads; the \`.zip\` and \`.blockmap\` files are for the updater.

## What changed in ${version}

${entry ?? `See the change log in AIGuide.md (§9).`}
${sums ? `\n## SHA-256\n\n\`\`\`\n${sums}\n\`\`\`\n` : ''}`;

if (out) {
  fs.writeFileSync(out, notes);
  console.log(`Release notes for ${version} → ${out}${entry ? '' : ' (no change-log entry found for this version)'}`);
} else {
  process.stdout.write(notes);
}
