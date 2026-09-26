/**
 * Keeping the unpacked extension current (docs/INSTALL.md, "The extension: load once, updated by reload").
 *
 * The extension a QA loads with "Load unpacked" lives at a STABLE path,
 * `G9_HOME/extension`: an unpacked extension's id is derived from its folder
 * path, so moving the folder would make the browser treat it as a different
 * extension (lost storage, lost pin, a second copy). So an update replaces the
 * folder's CONTENTS in place:
 *
 *   1. copy the bundled extension to `G9_HOME/extension.new` (never half-written
 *      into the live folder),
 *   2. swap: extension → extension.old, extension.new → extension, drop .old,
 *   3. tell every connected extension engine `{type:'reload'}`; the extension
 *      calls chrome.runtime.reload() when no action is in flight.
 *
 * If the swap is refused (Windows: another process holds a file in the live
 * folder), the copy falls back to overwriting file by file and says so — the
 * folder path, and therefore the extension id, never changes either way.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

/** Files a test harness writes into a COPY of the extension; never shipped. */
const EXCLUDE = new Set(['dev-bridge.json', 'dev-daemon.json', '.DS_Store', 'Thumbs.db', 'desktop.ini']);

export async function copyDir(from, to) {
  let files = 0;
  let bytes = 0;
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      const sub = await copyDir(src, dst);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      await fsp.copyFile(src, dst);
      files += 1;
      bytes += (await fsp.stat(src)).size;
    }
  }
  return { files, bytes };
}

async function readManifestVersion(dir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Install (or update) the extension folder.
 * @returns {{ path, version, previousVersion, files, bytes, method: 'swap'|'overwrite' }}
 */
export async function installExtension({ from, target, log = () => {} }) {
  const source = path.resolve(from);
  const version = await readManifestVersion(source);
  if (!version) throw new Error(`${source} does not look like the G9 extension (no readable manifest.json).`);

  const previousVersion = await readManifestVersion(target);
  const staging = `${target}.new`;
  const old = `${target}.old`;
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.rm(old, { recursive: true, force: true });
  const { files, bytes } = await copyDir(source, staging);
  await fsp.writeFile(
    path.join(staging, 'g9-install.json'),
    `${JSON.stringify({ version, installedAt: new Date().toISOString(), from: source.replace(/\\/g, '/') }, null, 2)}\n`,
  );

  let method = 'swap';
  try {
    let hadTarget = true;
    try {
      await fsp.rename(target, old);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      hadTarget = false;
    }
    try {
      await fsp.rename(staging, target);
    } catch (err) {
      if (hadTarget) await fsp.rename(old, target).catch(() => {});
      throw err;
    }
    await fsp.rm(old, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    method = 'overwrite';
    log(`[extension] folder swap refused (${err.code ?? err.message}); overwriting files in place`);
    await copyDir(staging, target);
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  log(`[extension] installed v${version} into ${target} (${files} files, ${method})`);
  return { path: target.replace(/\\/g, '/'), version, previousVersion, files, bytes, method };
}
