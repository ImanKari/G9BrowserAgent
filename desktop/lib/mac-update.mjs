/**
 * macOS updates without a Developer ID (3.6): G9BrowserAgent replaces its own app bundle.
 *
 * electron-updater installs on macOS through Squirrel.Mac, which refuses an app that is not signed
 * with an Apple Developer ID — and G9BrowserAgent is ad-hoc signed — so until 3.5 a Mac only found
 * the release and opened its page. Now the app does what Squirrel would have:
 *   1. electron-updater still checks (latest-mac.yml); this module downloads the release's zip for
 *      this Mac's architecture, over the same feed (GitHub releases, or the custom https folder),
 *      and checks its SHA-512 against latest-mac.yml — nothing else authenticates it;
 *   2. it unpacks the zip (ditto) into a staging folder and checks that it holds G9BrowserAgent at
 *      the version announced;
 *   3. to install, a small shell script waits for the app to quit, moves the old bundle aside,
 *      MOVES the new one into its place (a copy only across volumes: macOS 26 refused writes into
 *      the app's place half-way through a copy, measured on a real Mac, but allows a rename),
 *      puts the old one back if that fails, and starts it again unless the person was quitting. A download made by the app itself carries no
 *      quarantine flag, so Gatekeeper does not ask again.
 * Possible only when the app can write where it is installed (it was dragged to Applications by
 * the person who runs it) and macOS is not running it from a randomized read-only copy ("app
 * translocation", an app opened straight from Downloads). Otherwise the update stays manual:
 * the release page, as before (`selfUpdatable`).
 *
 * The network (`fetch`, Electron's net.fetch in the app: the system proxy applies), the file system
 * and the child processes are plain Node or injected, so all of it but `ditto` is tested on any OS.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

/** The bundle a macOS executable belongs to: …/X.app/Contents/MacOS/exe → …/X.app. Pure. */
export function bundleOf(execPath) {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(execPath ?? ''));
  return m ? m[1] : null;
}

/**
 * Can this installation replace itself? Pure apart from `writable`.
 * @returns {{ok: boolean, reason?: string, bundle?: string}}
 */
export function selfUpdatable({ execPath, platform = process.platform, writable = (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } } } = {}) {
  if (platform !== 'darwin') return { ok: false, reason: 'not macOS' };
  const bundle = bundleOf(execPath);
  if (!bundle) return { ok: false, reason: 'G9BrowserAgent is not running from an app bundle' };
  if (/\/AppTranslocation\//.test(bundle)) {
    return { ok: false, bundle, reason: 'macOS runs G9BrowserAgent from a temporary read-only copy (it was opened straight from where it was downloaded); move it to Applications and open it from there' };
  }
  if (!writable(path.dirname(bundle)) || !writable(bundle)) {
    return { ok: false, bundle, reason: `G9BrowserAgent cannot write to ${path.dirname(bundle)}, where it is installed` };
  }
  return { ok: true, bundle };
}

/** The release file for this Mac: G9BrowserAgent-<v>-mac-<arch>.zip. Pure. */
export function pickMacZip(files, arch = process.arch) {
  const zips = (files ?? []).filter((f) => /\.zip$/i.test(String(f?.url ?? '')));
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  return zips.find((f) => String(f.url).endsWith(`-mac-${a}.zip`))
    ?? zips.find((f) => new RegExp(`[-_.]${a}[-_.]`).test(String(f.url)))
    ?? (zips.length === 1 ? zips[0] : null);
}

/**
 * Where a release file is downloaded from, on the feed the check used. Pure.
 * github → https://github.com/<owner>/<repo>/releases/download/<tag>/<file>; generic → beside the feed's yml.
 */
export function releaseFileUrl({ feed, file, tag = null, version = null }) {
  const name = String(file?.url ?? '');
  if (!name) return null;
  if (/^https?:\/\//i.test(name)) return name;
  if (feed?.provider === 'github') {
    const t = tag ?? (version ? `v${String(version).replace(/^v/, '')}` : null);
    if (!t) return null;
    return `https://github.com/${feed.owner}/${feed.repo}/releases/download/${encodeURIComponent(t)}/${encodeURIComponent(name)}`;
  }
  if (feed?.url) return new URL(name, feed.url).href;
  return null;
}

/** The script that swaps the bundle after the app has quit. Plain sh; `ditto` where it exists. */
export const SWAP_SCRIPT = `#!/bin/sh
# G9BrowserAgent (macOS): replace the app bundle once the app has quit (desktop/lib/mac-update.mjs).
pid="$1"; new="$2"; app="$3"; relaunch="$4"; log="$5"; exe="$6"; same="$7"
n=0
# Gone, or a zombie (exited, not yet reaped by its parent: it holds nothing).
running() { kill -0 "$pid" 2>/dev/null && [ "$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ' | cut -c1)" != "Z" ]; }
while running; do
  n=$((n+1))
  if [ "$n" -gt 900 ]; then echo "G9BrowserAgent did not quit; the update was not installed" >>"$log"; exit 1; fi
  sleep 0.2
done
copy() { if command -v ditto >/dev/null 2>&1; then ditto "$1" "$2"; else cp -R "$1" "$2"; fi; }
# On one volume the new bundle is MOVED into place: macOS (App Management, measured on macOS 26)
# refuses writes into an app bundle where an app was installed — a copy stopped half-way with
# "Operation not permitted" — but lets a whole bundle be renamed.
put() { if [ "$same" = "1" ]; then mv "$1" "$2"; else copy "$1" "$2"; fi; }
old="$app.g9-previous"
rm -rf "$old"
if mv "$app" "$old"; then
  if put "$new" "$app" 2>>"$log"; then
    xattr -dr com.apple.quarantine "$app" >/dev/null 2>&1
    rm -rf "$old" "$new"
    echo "installed $new into $app" >>"$log"
  else
    rm -rf "$app"
    mv "$old" "$app"
    echo "the copy failed; the previous version is back in place" >>"$log"
  fi
else
  echo "could not move $app aside; nothing changed" >>"$log"
fi
if [ "$relaunch" = "1" ]; then
  nohup "$app/Contents/MacOS/$exe" >/dev/null 2>&1 &
fi
`;

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(`${cmd} failed: ${String(stderr || err.message).trim()}`)) : resolve(String(stdout))));
});

export class MacSelfUpdate {
  /**
   * @param {object} o
   * @param {string} o.cacheDir     where downloads go (…/Caches/g9browseragent-updater/pending)
   * @param {string} o.execPath     this app's executable
   * @param {typeof fetch} [o.fetch]
   * @param {(cmd: string, args: string[]) => Promise<string>} [o.exec]
   * @param {() => void} [o.quit]   quit the app (installing happens after it exits)
   */
  constructor({ cacheDir, execPath, fetch: fetchImpl = globalThis.fetch, exec = run, spawnDetached = null, quit = () => {}, log = null, arch = process.arch, pid = process.pid }) {
    this.cacheDir = cacheDir;
    this.execPath = execPath;
    this.fetch = fetchImpl;
    this.exec = exec;
    this.spawnDetached = spawnDetached ?? ((cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref());
    this.quit = quit;
    this.log = log;
    this.arch = arch;
    this.pid = pid;
    this.staged = null; // { version, app }
  }

  /**
   * Download, verify and stage the update described by electron-updater's `update-available` info.
   * @param {{info: object, feed: object, onProgress?: (p: {percent, transferred, total}) => void}} o
   * @returns {Promise<{version, app, file}>}
   */
  async prepare({ info, feed, onProgress = null }) {
    const version = info?.version;
    const file = pickMacZip(info?.files, this.arch);
    if (!version || !file) throw new Error(`The release ${version ?? ''} has no macOS zip for ${this.arch} in latest-mac.yml`.replace(/\s+/g, ' '));
    if (!file.sha512) throw new Error(`latest-mac.yml gives no sha512 for ${file.url}: the download could not be verified, so it is not used`);
    const url = releaseFileUrl({ feed, file, tag: info?.tag ?? null, version });
    if (!url || !(/^https:\/\//i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(url))) throw new Error(`No usable https address for ${file.url}`);
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const zip = path.join(this.cacheDir, path.basename(String(file.url)));
    if (!(fs.existsSync(zip) && (await sha512File(zip)) === file.sha512)) {
      await this.#download(url, zip, file, onProgress);
    } else {
      this.log?.info?.('The update was already downloaded and verified', { zip });
    }
    const app = await this.#stage(zip, version);
    this.staged = { version, app, file: zip };
    return this.staged;
  }

  async #download(url, zip, file, onProgress) {
    const part = `${zip}.part`;
    fs.rmSync(part, { force: true });
    this.log?.info?.('Downloading the update', { url });
    const res = await this.fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Downloading ${path.basename(zip)} failed: HTTP ${res.status}`);
    const total = Number(res.headers?.get?.('content-length')) || Number(file.size) || 0;
    const hash = crypto.createHash('sha512');
    const out = fs.createWriteStream(part);
    let transferred = 0;
    let lastTick = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        transferred += value.length;
        if (!out.write(value)) await new Promise((r) => out.once('drain', r));
        const now = Date.now();
        if (onProgress && (now - lastTick > 500 || (total && transferred >= total))) {
          lastTick = now;
          onProgress({ transferred, total, percent: total ? Math.min(100, (transferred / total) * 100) : null });
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      fs.rmSync(part, { force: true });
      throw new Error(`Downloading ${path.basename(zip)} was interrupted: ${err?.cause?.code ?? err?.message ?? err}`);
    }
    if (file.size && transferred !== Number(file.size)) {
      fs.rmSync(part, { force: true });
      throw new Error(`Downloading ${path.basename(zip)} stopped at ${transferred} of ${file.size} bytes`);
    }
    const got = hash.digest('base64');
    if (got !== file.sha512) {
      fs.rmSync(part, { force: true });
      throw new Error(`sha512 checksum mismatch for ${path.basename(zip)}: expected ${file.sha512}, got ${got}. The download is not used.`);
    }
    fs.renameSync(part, zip);
  }

  async #stage(zip, version) {
    const dir = path.join(this.cacheDir, 'staged');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await this.exec('ditto', ['-x', '-k', zip, dir]);
    const name = fs.readdirSync(dir).find((n) => n.endsWith('.app'));
    if (!name) throw new Error(`${path.basename(zip)} holds no app bundle`);
    const app = path.join(dir, name);
    let staged = null;
    try {
      staged = JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'package.json'), 'utf8')).version;
    } catch { /* checked below */ }
    if (staged !== version) throw new Error(`${path.basename(zip)} holds G9BrowserAgent ${staged ?? '(unknown version)'}, not ${version}; it is not installed`);
    await this.exec('xattr', ['-dr', 'com.apple.quarantine', app]).catch(() => {});
    return app;
  }

  /** Replace the bundle once the app has quit, then quit. `relaunch`: start the new version after. */
  install({ relaunch = true } = {}) {
    if (!this.staged) throw new Error('No update is staged');
    const bundle = bundleOf(this.execPath);
    if (!bundle) throw new Error('G9BrowserAgent is not running from an app bundle');
    const script = path.join(this.cacheDir, 'g9-swap.sh');
    fs.writeFileSync(script, SWAP_SCRIPT, { mode: 0o755 });
    const logFile = path.join(this.cacheDir, 'install.log');
    // Moved, not copied, when the staged bundle and the app are on one volume (SWAP_SCRIPT `put`).
    let same = false;
    try { same = fs.statSync(path.dirname(this.staged.app)).dev === fs.statSync(path.dirname(bundle)).dev; } catch { /* copied */ }
    this.log?.info?.('Installing the update after quitting', { from: this.staged.app, to: bundle, relaunch, move: same });
    this.spawnDetached('/bin/sh', [script, String(this.pid), this.staged.app, bundle, relaunch ? '1' : '0', logFile, path.basename(this.execPath), same ? '1' : '0']);
    setTimeout(() => this.quit(), 100);
  }
}

/** SHA-512 of a file, base64 (what latest*.yml carries). */
export function sha512File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('base64')));
  });
}
