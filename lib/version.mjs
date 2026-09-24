/**
 * The one version string of the whole product, read from the root package.json.
 *
 * v1 had three places that announced a version (bridge package.json, a
 * hand-written constant, the extension manifest) and they drifted: the bridge
 * spent eight releases telling people to reload an extension that was already
 * correct (v1.7.13). A version announced in two places is wrong in one of them.
 * So every Node component — daemon, shim, runner, engine manager — imports it
 * from here, and `setup/unit/version.test.mjs` fails the build when
 * extension/manifest.json or desktop/package.json disagree with package.json.
 *
 * Read once, synchronously, at import time: a version that can change under a
 * running process is not a version.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository (or packaged resources) root: the directory holding package.json. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    // A component that cannot read its own package.json still works, and
    // saying so is better than refusing to start over a label.
  }
  return '0.0.0-unknown';
}

export const VERSION = readVersion();

/** Major version as a number (2 for "2.0.0"); NaN for garbage. */
export function majorOf(version) {
  const match = /^v?(\d+)\./.exec(String(version ?? ''));
  return match ? Number(match[1]) : Number.NaN;
}
