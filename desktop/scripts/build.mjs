/**
 * `npm run build:win | build:mac | build:linux` — the desktop packages, into dist/.
 *
 *   node scripts/build.mjs [--win | --mac | --linux] [--allow-missing]
 *   (no platform flag: the machine's own)
 *
 *   Windows  G9-Setup-<v>.exe (+ .blockmap), latest.yml                 build on Windows
 *   macOS    G9-<v>-mac-{x64,arm64}.{dmg,zip} (+ .blockmap), latest-mac.yml   build on macOS
 *   Linux    G9-x86_64.AppImage, G9_<v>_amd64.deb, latest-linux.yml        build on Linux
 *
 * 1. Draw build/icon.png (scripts/make-icons.mjs).
 * 2. Check that every packaged resource exists — an app that cannot start its daemon is worse than
 *    no package — and that desktop/package.json and the root package.json carry the same version.
 * 3. Run electron-builder with electron-builder.yml, never publishing: the release pipeline uploads.
 *    The yml's `publish` block (the official GitHub releases) makes the build write the latest*.yml
 *    update metadata and the app's app-update.yml. G9_UPDATE_URL=<https folder> builds for a
 *    self-hosted generic feed instead; the metadata is the same, only the app's built-in default
 *    differs, and the app still takes its feed from Settings at runtime.
 * 4. Verify the output the way electron-updater will (scripts/verify-artifacts.mjs).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { verifyArtifacts, verifyPackedDependencies } from './verify-artifacts.mjs';

const require = createRequire(import.meta.url);
const sourceApp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRepo = path.resolve(sourceApp, '..');
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

/**
 * --as-version <v> [--out <dir>]: the same source, packaged as another version — the "installed old
 * version" of the update end-to-end test (test/update-e2e.mjs). Built from a staged copy so the
 * working tree is never touched: the four version files are rewritten there (the app, the daemon
 * and the extension must all be that version, or the app sees a daemon mismatch), node_modules is
 * copied with it (see below).
 */
const asVersion = argOf('--as-version');
const outDir = argOf('--out') ? path.resolve(argOf('--out')) : null;
let repo = sourceRepo;
let appDir = sourceApp;
if (asVersion) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(asVersion)) {
    console.error(`--as-version wants a semver version (got ${asVersion}).`);
    process.exit(2);
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-build-stage-'));
  const skip = new Set(['.git', 'node_modules', 'dist', '.vs']);
  fs.cpSync(sourceRepo, stage, { recursive: true, filter: (src) => !skip.has(path.basename(src)) });
  // A COPY, not a link: electron-builder does not follow a junction/symlinked node_modules when it
  // collects the production dependencies, and packed electron-updater without fs-extra & co. (an
  // app whose updater throws "Cannot find module 'fs-extra'" — found by test/update-e2e.mjs).
  fs.cpSync(path.join(sourceApp, 'node_modules'), path.join(stage, 'desktop', 'node_modules'), { recursive: true, verbatimSymlinks: true });
  for (const rel of ['package.json', 'extension/manifest.json', 'desktop/package.json', 'desktop/package-lock.json']) {
    const file = path.join(stage, rel);
    if (!fs.existsSync(file)) continue;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    json.version = asVersion;
    if (json.packages?.['']) json.packages[''].version = asVersion;
    fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  }
  repo = stage;
  appDir = path.join(stage, 'desktop');
  console.log(`Building ${asVersion} from a staged copy: ${stage}`);
  process.on('exit', () => {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* a temp dir */ }
  });
}

const HOST = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
const target = args.includes('--win') ? 'win' : args.includes('--mac') ? 'mac' : args.includes('--linux') ? 'linux' : HOST;
if (!target) {
  console.error(`No desktop package for ${process.platform}.`);
  process.exit(2);
}
if (target !== HOST) {
  // electron-builder can cross-build some targets, but not these: a dmg needs macOS (hdiutil, and
  // the ad-hoc signature), an AppImage needs Linux tools. The pipeline builds each on its own OS.
  console.error(`Build the ${target} packages on ${target === 'mac' ? 'macOS' : target === 'linux' ? 'Linux' : 'Windows'} (this is ${process.platform}).`);
  process.exit(2);
}

execFileSync(process.execPath, [path.join(appDir, 'scripts', 'make-icons.mjs')], { stdio: 'inherit' });

const required = ['extension/manifest.json', 'daemon/g9d.mjs', 'mcp/shim.mjs', 'engine', 'runner/g9.mjs', 'lib', 'lib/runtime.mjs', 'package.json'];
const missing = required.filter((p) => !fs.existsSync(path.join(repo, p)));
if (missing.length && !args.includes('--allow-missing')) {
  console.error(`Cannot build: these packaged resources are missing from ${repo}:\n  ${missing.join('\n  ')}\n(pass --allow-missing to build anyway, for a shell-only test build)`);
  process.exit(2);
}

const version = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
try {
  const root = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
  if (root !== version) {
    console.error(`Version skew: desktop/package.json is ${version}, the root package.json is ${root}. They must be equal (ARCHITECTURE_V2 §2).`);
    process.exit(2);
  }
} catch {
  /* reported as missing above */
}

const { build, Platform } = require('electron-builder');
const config = { extends: null };
if (outDir) config.directories = { output: outDir, buildResources: 'build' };
if (process.env.G9_UPDATE_URL) {
  console.log(`Self-hosted feed: ${process.env.G9_UPDATE_URL} (built-in default; Settings still decides at runtime)`);
  config.publish = { provider: 'generic', url: process.env.G9_UPDATE_URL, channel: 'latest' };
}

// Never let the builder's own child processes inherit ELECTRON_RUN_AS_NODE (see scripts/start.mjs).
delete process.env.ELECTRON_RUN_AS_NODE;
// macOS: no Developer ID exists, and a certificate that happens to be in the build machine's
// keychain must not be picked up silently. The yml asks for an ad-hoc signature ("-").
if (target === 'mac') process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

const platform = { win: Platform.WINDOWS, mac: Platform.MAC, linux: Platform.LINUX }[target];
const dist = outDir ?? path.join(appDir, 'dist');

try {
  // No explicit targets: the ones in electron-builder.yml for this platform (and their archs).
  const files = await build({ projectDir: appDir, targets: platform.createTarget(), config, publish: 'never' });
  for (const f of files) {
    const size = fs.existsSync(f) ? fs.statSync(f).size : 0;
    console.log(`${path.relative(appDir, f)}  ${(size / 1048576).toFixed(1)} MB`);
  }
} catch (err) {
  console.error(err?.stack ?? err);
  process.exit(1);
}

const problems = verifyArtifacts(dist, { version, expect: [target] });
// Every packed app (win-unpacked, linux-unpacked, mac/G9.app, mac-arm64/G9.app) carries every
// production dependency — electron-updater once shipped without its own (verify-artifacts.mjs).
const asars = fs.readdirSync(dist, { withFileTypes: true }).filter((d) => d.isDirectory())
  .flatMap((d) => [path.join(dist, d.name, 'resources', 'app.asar'), path.join(dist, d.name, 'G9.app', 'Contents', 'Resources', 'app.asar')])
  .filter((f) => fs.existsSync(f));
if (!asars.length) problems.push('no packed app.asar found in the output');
for (const asar of asars) problems.push(...verifyPackedDependencies(asar, path.join(appDir, 'package-lock.json')).map((p) => `${path.relative(dist, asar)}: ${p}`));
if (problems.length) {
  console.error(`\nThe ${target} packages do not verify:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`\n${target} packages for ${version} verified (update metadata matches every file).`);
