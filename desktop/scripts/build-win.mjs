/**
 * `npm run build:win` — the NSIS installer, per user, into dist/G9-Setup-<version>.exe.
 *
 * 1. Draw build/icon.png (scripts/make-icons.mjs).
 * 2. Check that every packaged resource exists; a missing daemon/ or mcp/ would build an installer
 *    whose app cannot start its daemon, which is worse than no installer.
 * 3. Run electron-builder with electron-builder.yml. When G9_UPDATE_URL is set, the build carries a
 *    generic publish block and writes latest.yml beside the installer (upload both to that URL).
 *    When it is not set, `publish` is dropped: the build still installs and runs, and the app shows
 *    "Updates: not configured" until an URL is saved in Settings. No placeholder URL is invented.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(appDir, '..');

execFileSync(process.execPath, [path.join(appDir, 'scripts', 'make-icons.mjs')], { stdio: 'inherit' });

const required = ['extension/manifest.json', 'daemon/g9d.mjs', 'mcp/shim.mjs', 'engine', 'runner/g9.mjs', 'lib', 'package.json'];
const missing = required.filter((p) => !fs.existsSync(path.join(repo, p)));
if (missing.length && !process.argv.includes('--allow-missing')) {
  console.error(`Cannot build: these packaged resources are missing from ${repo}:\n  ${missing.join('\n  ')}\n(pass --allow-missing to build anyway, for a shell-only test build)`);
  process.exit(2);
}

const own = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
try {
  const root = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
  if (root !== own) {
    console.error(`Version skew: desktop/package.json is ${own}, the root package.json is ${root}. They must be equal (ARCHITECTURE_V2 §2).`);
    process.exit(2);
  }
} catch {
  /* reported as missing above */
}

const { build, Platform } = require('electron-builder');
const config = {};
if (!process.env.G9_UPDATE_URL) {
  console.log('G9_UPDATE_URL is not set: building without a publish feed (no latest.yml). The app will show "Updates: not configured" until a URL is saved in Settings.');
  config.publish = null;
  // electron-builder writes resources/app-update.yml only when a publish feed resolves — and
  // electron-updater reads that file BEFORE it downloads anything, so a build without one could
  // check for updates and never install them ("ENOENT … app-update.yml", desktop review,
  // 2026-09-22). One is written here with the cache folder name the NSIS installer itself uses
  // (appInfo: "<package name>-updater"); the feed URL comes from Settings at runtime.
  config.afterPack = async ({ appOutDir }) => {
    const file = path.join(appOutDir, 'resources', 'app-update.yml');
    if (fs.existsSync(file)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'updaterCacheDirName: g9-desktop-updater\n', 'utf8');
    console.log(`wrote ${file} (no publish feed: the updater still needs this file to install)`);
  };
} else {
  console.log(`Update feed: ${process.env.G9_UPDATE_URL}`);
}

// Never let the builder's own child processes inherit ELECTRON_RUN_AS_NODE (see scripts/start.mjs).
delete process.env.ELECTRON_RUN_AS_NODE;

// electron-builder still reads electron-builder.yml; `config` is deep-merged on top of it
// (`publish: null` replaces the yml's publish block; `extends: null` turns off preset detection).
build({
  projectDir: appDir,
  targets: Platform.WINDOWS.createTarget('nsis', 1 /* x64 */),
  config: { extends: null, ...config },
  publish: 'never',
})
  .then((files) => {
    for (const f of files) {
      const size = fs.existsSync(f) ? fs.statSync(f).size : 0;
      console.log(`${f}  ${(size / 1048576).toFixed(1)} MB`);
    }
  })
  .catch((err) => {
    console.error(err?.stack ?? err);
    process.exit(1);
  });
