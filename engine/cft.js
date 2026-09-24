// engine/cft.js — Chrome for Testing: pinned, downloaded once, verified, installed atomically.
//
// Why Chrome for Testing at all: installed Edge/Chrome update themselves whenever they like (Chrome
// ships a major every two weeks since 153), so "the suite passed on Tuesday" and "the suite passed
// on Thursday" may be two different browsers. CfT is a stock Chrome build at a version WE choose,
// exempt from the Chrome 136 rule that ignores remote debugging on the default profile (plan §2.1),
// with no auto-updater. The pinned version and its hash live in engine/versions.json.
//
//   pinned()                    → { version, platform, sha256, size, url, … } from versions.json
//   installed({ home })         → [{ version, path, dir, … }] under G9_HOME/engines/cft-<version>/
//   ensure({ version, onProgress, cacheDir, … }) → { version, path, … }   idempotent
//   latestStable()              → what Google currently calls Stable (for the Engines screen)
//
// Trust model (engine/README.md has the long form): the sha256 in versions.json was computed by G9
// from the first download (trust on first use), cross-checked against the MD5 that Google's storage
// declares in `x-goog-hash`. Every later install must match it byte for byte. A version that is not
// pinned installs with whatever hash it has, and that hash is written to engine-versions.log so the
// first install of it is still on record.
//
// Zero dependencies: node:https for the download, `tar -xf` for the zip (Windows 10+ ships bsdtar,
// which reads zip), and a small pure-JS zip reader as the fallback.

import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, readFileSync, existsSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile, appendFile, symlink, chmod, unlink, utimes } from 'node:fs/promises';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { g9Home, exeVersion, compareVersions } from './find.js';

export const ENDPOINTS = {
  knownGood: 'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json',
  lastKnownGood: 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json',
};

const VERSIONS_FILE = fileURLToPath(new URL('./versions.json', import.meta.url));
const USER_AGENT = 'g9-browser-agent (engine/cft.js; +https://github.com/GoogleChromeLabs/chrome-for-testing)';
const INSTALL_MARKER = '.g9-install.json';

/** CfT platform key for this machine. */
export function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'ia32' ? 'win32' : 'win64';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return 'linux64';
}

/** Path of the browser executable inside an extracted CfT zip, relative to the install dir. */
export function exeRelativePath(platform = platformKey()) {
  switch (platform) {
    case 'win64': case 'win32': return path.join(`chrome-${platform}`, 'chrome.exe');
    case 'mac-x64': case 'mac-arm64':
      return path.join(`chrome-${platform}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    default: return path.join('chrome-linux64', 'chrome');
  }
}

export function canonicalZipUrl(version, platform = platformKey()) {
  return `https://storage.googleapis.com/chrome-for-testing-public/${version}/${platform}/chrome-${platform}.zip`;
}

// ─── the pin ─────────────────────────────────────────────────────────────────────────────────

let versionsCache = null;

export function readVersionsFile({ fresh = false } = {}) {
  if (!versionsCache || fresh) versionsCache = JSON.parse(readFileSync(VERSIONS_FILE, 'utf8'));
  return versionsCache;
}

/**
 * The pinned Chrome for Testing build → { version, platform, sha256?, size?, url, revision, channel }.
 * `platform` defaults to 'win64' (ARCHITECTURE_V2 §7); a platform without a recorded hash returns
 * no sha256, and ensure() then installs trust-on-first-use.
 */
export function pinned({ platform = 'win64' } = {}) {
  const pin = readVersionsFile()['chrome-for-testing'] ?? {};
  const dl = pin.downloads?.[platform] ?? {};
  const out = { version: pin.version, platform, url: dl.url ?? (pin.version ? canonicalZipUrl(pin.version, platform) : undefined) };
  if (dl.sha256) out.sha256 = dl.sha256;
  if (dl.size) out.size = dl.size;
  if (pin.revision) out.revision = pin.revision;
  if (pin.channel) out.channel = pin.channel;
  if (pin.pinnedAt) out.pinnedAt = pin.pinnedAt;
  return out;
}

// ─── what is installed ───────────────────────────────────────────────────────────────────────

export function enginesDir(home = g9Home()) {
  return path.join(home, 'engines');
}

export function installDir(version, { home = g9Home() } = {}) {
  return path.join(enginesDir(home), `cft-${version}`);
}

/** Installed CfT builds, newest first → [{ version, path, dir, platform, verified, sha256?, installedAt? }]. */
export async function installed({ home = g9Home(), platform = platformKey() } = {}) {
  let entries;
  try {
    entries = await readdir(enginesDir(home), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const m = e.isDirectory() && /^cft-(\d+\.\d+\.\d+\.\d+)$/.exec(e.name);
    if (!m) continue;
    const dir = path.join(enginesDir(home), e.name);
    const exe = path.join(dir, exeRelativePath(platform));
    if (!existsSync(exe)) continue;
    let marker = null;
    try { marker = JSON.parse(await readFile(path.join(dir, INSTALL_MARKER), 'utf8')); } catch {}
    out.push({
      version: m[1],
      path: exe,
      dir,
      platform,
      verified: !!marker,
      ...(marker?.sha256 ? { sha256: marker.sha256 } : {}),
      ...(marker?.installedAt ? { installedAt: marker.installedAt } : {}),
    });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/** Delete an installed build. Fails (EBUSY/EPERM) while a browser from it is running — by design. */
export async function uninstall(version, { home = g9Home(), trigger = 'uninstall' } = {}) {
  const dir = installDir(version, { home });
  if (!existsSync(dir)) return { removed: false };
  const trash = `${dir}.removing-${process.pid}-${Date.now()}`;
  try {
    await rename(dir, trash);
  } catch (err) {
    throw new Error(`Cannot remove Chrome for Testing ${version}: ${err.code ?? err.message}. Is a browser from ${dir} still running?`);
  }
  await rm(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await appendVersionLog({ home, event: 'uninstall', kind: 'cft', version, trigger });
  return { removed: true };
}

// ─── engine-versions.log ─────────────────────────────────────────────────────────────────────

/**
 * One line per event in G9_HOME/engine-versions.log, tab-separated and greppable:
 *   2026-09-21T17:44:17.000Z  install  cft 153.0.8010.52  sha256=…  trigger=first-run  …
 * The daemon's engine manager appends its launch lines through this same function.
 */
export async function appendVersionLog({ home = g9Home(), event, kind = 'cft', version, sha256, trigger, ...extra } = {}) {
  const fields = [new Date().toISOString(), event ?? 'event', `${kind} ${version ?? '?'}`];
  if (sha256) fields.push(`sha256=${sha256}`);
  if (trigger) fields.push(`trigger=${trigger}`);
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) continue;
    fields.push(`${k}=${String(v).replace(/[\t\r\n]+/g, ' ')}`);
  }
  await mkdir(home, { recursive: true });
  await appendFile(path.join(home, 'engine-versions.log'), fields.join('\t') + '\n', 'utf8');
}

// ─── HTTP (zero-dependency, proxy-aware) ─────────────────────────────────────────────────────

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function proxyFor(url, env = process.env) {
  if (url.protocol !== 'https:') return null;
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = url.hostname.toLowerCase();
  if (LOOPBACK.has(host)) return null;
  if (noProxy.some((n) => n === '*' || host === n.replace(/^\./, '') || host.endsWith(n.startsWith('.') ? n : `.${n}`))) return null;
  const raw = env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  if (!raw) return null;
  return new URL(raw.includes('://') ? raw : `http://${raw}`);
}

/** HTTP CONNECT tunnel through a corporate proxy (QA fleets often have one). */
function connectTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = { host: `${host}:${port}` };
    if (proxy.username) {
      headers['proxy-authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
    }
    const req = http.request({ host: proxy.hostname, port: proxy.port || 80, method: 'CONNECT', path: `${host}:${port}`, headers, timeout: timeoutMs });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy ${proxy.host} refused the tunnel to ${host}:${port} (HTTP ${res.statusCode}).`));
        return;
      }
      resolve(socket);
    });
    req.once('timeout', () => req.destroy(new Error(`Proxy ${proxy.host} did not answer within ${timeoutMs / 1000}s.`)));
    req.once('error', reject);
    req.end();
  });
}

/** The first few KB of an error body (Google storage explains refusals in XML). */
async function readSmall(res, limit = 4096) {
  const chunks = [];
  let n = 0;
  try {
    for await (const c of res) {
      if (n < limit) chunks.push(c.subarray(0, limit - n));
      n += c.length;
    }
  } catch {}
  return Buffer.concat(chunks).toString('utf8');
}

function explainRefusal(body) {
  const details = /<Details>([^<]+)<\/Details>/.exec(body)?.[1] ?? /<Message>([^<]+)<\/Message>/.exec(body)?.[1];
  return details ? ` ("${details.trim()}")` : '';
}

/**
 * GET with redirects → the final IncomingMessage (status 200). `http:` is accepted only for
 * loopback hosts (the unit tests' local server); everything real is https.
 */
export async function httpGet(url, { timeoutMs = 60_000, maxRedirects = 5, signal, headers = {}, env = process.env } = {}) {
  let current = new URL(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (current.protocol === 'http:' && !LOOPBACK.has(current.hostname)) {
      throw new Error(`Refusing plain http for ${current.host}; Chrome for Testing downloads are https.`);
    }
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error(`Unsupported URL: ${current.href}`);
    const mod = current.protocol === 'https:' ? https : http;
    const opts = {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: '*/*', ...headers },
      timeout: timeoutMs,
      signal,
    };
    const proxy = proxyFor(current, env);
    const once = async (family) => {
      const o = { ...opts };
      if (proxy) {
        const port = Number(current.port || 443);
        const socket = await connectTunnel(proxy, current.hostname, port, timeoutMs);
        o.createConnection = () => tls.connect({ socket, servername: current.hostname });
        o.agent = false;
      } else if (family) {
        o.family = family;
        o.agent = false;
      }
      return new Promise((resolve, reject) => {
        const req = mod.request(current, o, resolve);
        // `timeout` is an idle-socket timeout: it fires when no byte arrives for that long, which is
        // what a stalled download looks like. A slow-but-moving download is not cut off.
        req.once('timeout', () => req.destroy(new Error(`No data from ${current.host} for ${Math.round(timeoutMs / 1000)}s.`)));
        req.once('error', reject);
        req.end();
      });
    };
    // Address families to try. Measured 2026-09-21 on the owner's network: storage.googleapis.com
    // answers 403 "this service is not available in your location" over IPv4 and 200 over IPv6 —
    // curl (which prefers IPv6) downloaded fine while Node (IPv4 first) was refused. A 403 or a
    // connection failure is therefore retried over the other family before it is reported.
    const families = proxy || LOOPBACK.has(current.hostname) ? [0] : [0, 6, 4];
    let res = null;
    let connectionError = null;
    let httpRefusal = null;
    for (const family of families) {
      try {
        res = await once(family);
      } catch (err) {
        if (signal?.aborted) throw err;
        connectionError = connectionError ?? `${err.code ?? err.message}`;
        res = null;
        continue;
      }
      if (res.statusCode !== 403 || family === families[families.length - 1]) break;
      httpRefusal = `HTTP 403${explainRefusal(await readSmall(res))}`;
      res = null;
    }
    if (!res) {
      // An HTTP refusal is an answer (not retried by download()); only a connection problem is.
      if (httpRefusal) throw new Error(`GET ${current.href} answered ${httpRefusal}. If this network needs a proxy, set HTTPS_PROXY.`);
      throw new Error(`GET ${current.href} failed: ${connectionError}. If this network needs a proxy, set HTTPS_PROXY.`);
    }
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, current);
      continue;
    }
    if (res.statusCode !== 200 && !(res.statusCode === 206 && headers.range)) {
      const body = await readSmall(res);
      throw new Error(`GET ${current.href} answered HTTP ${res.statusCode}${explainRefusal(body)}.`);
    }
    // Keep the idle timeout on the body as well.
    res.setTimeout?.(timeoutMs, () => res.destroy(new Error(`The download from ${current.host} stalled for ${Math.round(timeoutMs / 1000)}s.`)));
    res.finalUrl = current.href;
    return res;
  }
  throw new Error(`Too many redirects for ${url}.`);
}

export async function getJson(url, opts) {
  const res = await httpGet(url, opts);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Google's current Stable (or another channel) for a platform → { channel, version, revision, url }. */
export async function latestStable({ channel = 'Stable', platform = platformKey(), ...opts } = {}) {
  const data = await getJson(ENDPOINTS.lastKnownGood, opts);
  const ch = data.channels?.[channel];
  if (!ch) throw new Error(`The Chrome for Testing feed has no "${channel}" channel.`);
  const url = ch.downloads?.chrome?.find((d) => d.platform === platform)?.url;
  return { channel, version: ch.version, revision: ch.revision, url: url ?? canonicalZipUrl(ch.version, platform), feedTimestamp: data.timestamp };
}

/** The zip URL for `version` from the known-good feed (falls back to the canonical pattern). */
export async function downloadUrl(version, { platform = platformKey(), ...opts } = {}) {
  const data = await getJson(ENDPOINTS.knownGood, opts);
  const entry = data.versions?.find((v) => v.version === version);
  if (!entry) throw new Error(`Chrome for Testing ${version} is not in the known-good feed (${ENDPOINTS.knownGood}).`);
  const url = entry.downloads?.chrome?.find((d) => d.platform === platform)?.url;
  if (!url) throw new Error(`Chrome for Testing ${version} has no ${platform} download.`);
  return url;
}

/** Errors worth another attempt: the connection, not the request, went wrong. */
function retryable(err) {
  const msg = String(err?.message ?? err);
  if (/answered HTTP (4\d\d)/.test(msg) && !/HTTP (408|429)/.test(msg)) return false;
  if (/Refusing plain http|Unsupported URL|Too many redirects/.test(msg)) return false;
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Download `url` to `dest` (via a .part file) → { path, size, sha256, md5, declaredMd5, url, resumes }.
 *
 * A 200 MB zip over a slow or flaky route WILL lose its connection sometimes (measured 2026-09-21:
 * the first pin attempt died at 95% with "aborted" after six minutes). Each failure resumes from the
 * bytes already on disk with an HTTP Range request guarded by If-Range (the ETag of the first
 * response), so a file that changed on the server restarts from zero instead of being spliced.
 *
 * Verified here: the byte count against Content-Length (a truncated body is not a download), and
 * the MD5 Google storage declares in `x-goog-hash` (transport integrity). Hashes are computed from
 * the finished file on disk, never from a running digest a resume could have skewed. The sha256
 * pin is checked by the caller.
 */
export async function download(url, dest, { onProgress, signal, timeoutMs = 60_000, env, version, retries = 8 } = {}) {
  await mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let received = 0;
  let total = null;
  let declaredMd5 = null;
  let validator = null;
  let finalUrl = url;
  let failures = 0;
  let resumes = 0;
  let lastReport = 0;
  const started = Date.now();
  const report = (force, extra = {}) => {
    const now = Date.now();
    if (!onProgress || (!force && now - lastReport < 250)) return;
    lastReport = now;
    const seconds = Math.max(0.001, (now - started) / 1000);
    try {
      onProgress({
        phase: 'download', version, received, total,
        percent: total ? Math.min(100, (received / total) * 100) : null,
        bytesPerSecond: Math.round(received / seconds), ...extra,
      });
    } catch {}
  };
  try {
    for (;;) {
      const resuming = received > 0;
      let res;
      try {
        const headers = resuming ? { range: `bytes=${received}-`, ...(validator ? { 'if-range': validator } : {}) } : {};
        res = await httpGet(url, { signal, timeoutMs, env, headers });
      } catch (err) {
        if (signal?.aborted || !retryable(err) || failures >= retries) throw err;
        failures++;
        report(true, { retry: failures, reason: err.message });
        await sleep(Math.min(30_000, 1000 * 2 ** (failures - 1)));
        continue;
      }
      if (resuming && res.statusCode === 206) {
        const m = /bytes (\d+)-\d+\/(\d+|\*)/.exec(res.headers['content-range'] ?? '');
        // The server resumed somewhere else, or the file it now has is a different size than the
        // one we started (possible when it sent no ETag/Last-Modified, so If-Range could not guard
        // the request). Start over rather than splice two files together.
        if (!m || Number(m[1]) !== received || (m[2] !== '*' && total !== null && Number(m[2]) !== total)) {
          res.resume();
          received = 0;
          await rm(part, { force: true });
          continue;
        }
        resumes++;
      } else {
        // A full body: the first response, or a server that ignored the Range (If-Range mismatch —
        // the file changed). Either way the file restarts from zero.
        if (resuming) await rm(part, { force: true });
        received = 0;
        total = Number(res.headers['content-length']) || null;
        declaredMd5 = [].concat(res.headers['x-goog-hash'] ?? [])
          .flatMap((h) => String(h).split(','))
          .map((h) => h.trim())
          .find((h) => h.startsWith('md5='))?.slice(4) ?? null;
        validator = res.headers.etag ?? res.headers['last-modified'] ?? null;
        finalUrl = res.finalUrl ?? url;
      }
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          received += chunk.length;
          report(false);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(res, meter, createWriteStream(part, { flags: received > 0 ? 'a' : 'w' }), { signal });
        break;
      } catch (err) {
        // What is on disk is the truth; the meter may have counted a chunk the file never got.
        received = await fileSize(part);
        if (signal?.aborted || failures >= retries) {
          throw new Error(`The download of ${url} failed at ${received}${total ? ` of ${total}` : ''} bytes: ${err.message}`);
        }
        failures++;
        report(true, { retry: failures, reason: err.message });
        await sleep(Math.min(30_000, 1000 * 2 ** (failures - 1)));
      }
    }
    received = await fileSize(part);
    report(true);
    if (total !== null && received !== total) {
      throw new Error(`The download of ${url} was truncated: ${received} of ${total} bytes arrived.`);
    }
    const { sha256, md5, size } = await hashFile(part, { md5: true });
    if (declaredMd5 && declaredMd5 !== md5) {
      throw new Error(`The download of ${url} is corrupt: MD5 ${md5}, the server declared ${declaredMd5}.`);
    }
    await rename(part, dest);
    return { path: dest, size, sha256, md5, declaredMd5, url: finalUrl, resumes };
  } catch (err) {
    await rm(part, { force: true }).catch(() => {});
    throw err;
  }
}

async function fileSize(file) {
  try { return (await stat(file)).size; } catch { return 0; }
}

/** sha256 (and optionally base64 MD5) + size of a local file, in one pass. */
export async function hashFile(file, { md5 = false } = {}) {
  const sha = crypto.createHash('sha256');
  const md = md5 ? crypto.createHash('md5') : null;
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    sha.update(chunk);
    md?.update(chunk);
    size += chunk.length;
  }
  return { sha256: sha.digest('hex'), size, ...(md ? { md5: md.digest('base64') } : {}) };
}

// ─── zip extraction: tar first, pure JS as the fallback ──────────────────────────────────────

/**
 * The tar to use. On Windows it MUST be %SystemRoot%\System32\tar.exe (bsdtar, reads zip): under
 * Git Bash — the shell this project's tests run in — `tar` on PATH is GNU tar, which cannot read a
 * zip at all and would also take `C:` in a path for a remote host.
 */
export function systemTar() {
  if (process.platform === 'win32') {
    const p = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'tar.exe');
    return existsSync(p) ? p : null;
  }
  return 'tar';
}

function runTar(zipPath, destDir, { timeoutMs = 15 * 60_000 } = {}) {
  const tar = systemTar();
  if (!tar) return Promise.resolve({ ok: false, reason: 'no system tar' });
  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try {
      child = spawn(tar, ['-xf', zipPath, '-C', destDir], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, reason: err.message });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, reason: err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, reason: `tar exited ${code}: ${stderr.trim().slice(-500)}` });
    });
  });
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (!bytesRead) break;
    done += bytesRead;
  }
  return done === length ? buf : buf.subarray(0, done);
}

/**
 * The central directory of a zip → [{ name, method, flags, crc, csize, usize, localOffset, mode, isDir, isSymlink }].
 * Handles zip64 (sizes/offsets ≥ 4 GiB or ≥ 65535 entries) even though CfT does not need it today.
 */
export async function listZip(zipPath) {
  const fh = await open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
    let total = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locPos = size - tailLen + eocd - 20;
      const loc = await readAt(fh, locPos, 20);
      if (loc.readUInt32LE(0) !== SIG_ZIP64_LOCATOR) throw new Error('zip64 locator missing');
      const z64 = await readAt(fh, Number(loc.readBigUInt64LE(8)), 56);
      if (z64.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new Error('zip64 end record missing');
      total = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let n = 0; n < total; n++) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`corrupt central directory at entry ${n}`);
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      let localOffset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      // Bit 11 = UTF-8 names; otherwise CP437, which for the ASCII names in a CfT zip is the same.
      const name = nameBuf.toString((flags & 0x800) ? 'utf8' : 'latin1');
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        x += 4 + len;
      }
      const unixMode = (madeBy >> 8) === 3 ? external >>> 16 : 0;
      entries.push({
        name,
        method,
        flags,
        crc,
        csize,
        usize,
        localOffset,
        mode: unixMode,
        isDir: name.endsWith('/') || (external & 0x10) !== 0,
        isSymlink: (unixMode & 0o170000) === 0o120000,
      });
      p = xEnd + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/**
 * Resolve an entry name inside `destDir`, refusing absolute paths and `..` (zip-slip). On Windows
 * a ':' anywhere is refused too: "a:b" names an NTFS alternate data stream of "a", and "x/c:y" a
 * drive-relative path — neither is a file a browser zip contains.
 */
export function safeEntryPath(destDir, name) {
  const clean = name.replace(/\\/g, '/');
  if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean) || clean.split('/').includes('..') || clean.includes('\0')
    || (process.platform === 'win32' && clean.includes(':'))) {
    throw new Error(`unsafe path in zip: ${name}`);
  }
  const root = path.resolve(destDir);
  const target = path.resolve(root, ...clean.split('/').filter(Boolean));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`unsafe path in zip: ${name}`);
  return target;
}

// CRC-32 (IEEE, as in zip). zlib.crc32 exists from Node 22.2; the root package allows any Node 22,
// so a table-driven fallback keeps extraction working on 22.0/22.1 instead of failing on a
// TypeError halfway through an install.
let crcTable = null;
/** Pure-JS CRC-32 with zlib.crc32's continuation semantics (pass the previous value to continue). */
export function crc32Js(buf, previous = 0) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = ~previous;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}
export const crc32 = typeof zlib.crc32 === 'function' ? (buf, previous = 0) => zlib.crc32(buf, previous) : crc32Js;

/** CRC-32 and byte count of what flows through, compared at the end. */
function crcCheck(entry) {
  let crc = 0;
  let bytes = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      crc = crc32(chunk, crc);
      bytes += chunk.length;
      cb(null, chunk);
    },
    flush(cb) {
      if (bytes !== entry.usize) cb(new Error(`${entry.name}: ${bytes} bytes extracted, the zip says ${entry.usize}`));
      else if ((crc >>> 0) !== (entry.crc >>> 0)) cb(new Error(`${entry.name}: CRC mismatch (corrupt zip)`));
      else cb();
    },
  });
}

/**
 * Minimal zip extractor: stored (0) and deflate (8) entries, streamed (chrome.dll is hundreds of MB
 * uncompressed — never held in memory), CRC-32 and size verified per entry, unix modes and symlinks
 * restored on POSIX. Encrypted entries and other methods are refused by name.
 */
export async function extractZipJs(zipPath, destDir, { onEntry } = {}) {
  const entries = await listZip(zipPath);
  await mkdir(destDir, { recursive: true });
  const fh = await open(zipPath, 'r');
  let files = 0;
  let bytes = 0;
  try {
    for (const [i, entry] of entries.entries()) {
      const target = safeEntryPath(destDir, entry.name);
      if (entry.isDir) {
        await mkdir(target, { recursive: true });
        continue;
      }
      if (entry.flags & 0x1) throw new Error(`${entry.name}: encrypted zip entries are not supported`);
      if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name}: compression method ${entry.method} is not supported`);
      const local = await readAt(fh, entry.localOffset, 30);
      if (local.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`${entry.name}: bad local header`);
      const dataStart = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      await mkdir(path.dirname(target), { recursive: true });
      const source = entry.csize > 0
        ? createReadStream(zipPath, { start: dataStart, end: dataStart + entry.csize - 1 })
        : null;
      if (entry.isSymlink && process.platform !== 'win32') {
        const chunks = [];
        if (source) for await (const c of source.pipe(entry.method === 8 ? zlib.createInflateRaw() : new PassThrough())) chunks.push(c);
        await unlink(target).catch(() => {});
        await symlink(Buffer.concat(chunks).toString('utf8'), target);
        continue;
      }
      const stages = [];
      if (source) {
        stages.push(source);
        if (entry.method === 8) stages.push(zlib.createInflateRaw());
      } else {
        // An empty entry: nothing to read, but still create the file and check the header's size/CRC.
        stages.push(Readable.from([]));
      }
      stages.push(crcCheck(entry), createWriteStream(target));
      await pipeline(...stages);
      if (entry.mode && process.platform !== 'win32') await chmod(target, entry.mode & 0o777).catch(() => {});
      files++;
      bytes += entry.usize;
      if (onEntry) { try { onEntry({ index: i, total: entries.length, name: entry.name, files, bytes }); } catch {} }
    }
  } finally {
    await fh.close();
  }
  return { files, bytes, entries: entries.length };
}

/**
 * Extract a zip into `destDir` → { extractor: 'tar'|'js', tarError? }.
 * `expect` (a relative path) is checked after tar: a tar that exits 0 but did not produce the
 * browser (a GNU tar that silently wrote nothing useful, a truncated zip) falls back to the JS reader.
 */
export async function extractZip(zipPath, destDir, { expect, onProgress, preferJs = false } = {}) {
  await mkdir(destDir, { recursive: true });
  let tarError = null;
  if (!preferJs) {
    onProgress?.({ phase: 'extract', extractor: 'tar' });
    const res = await runTar(zipPath, destDir);
    if (res.ok && (!expect || existsSync(path.join(destDir, expect)))) return { extractor: 'tar' };
    tarError = res.ok ? `tar finished but ${expect} is missing` : res.reason;
    // Start the JS reader from a clean directory: tar may have left a partial tree.
    await rm(destDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    await mkdir(destDir, { recursive: true });
  }
  onProgress?.({ phase: 'extract', extractor: 'js', tarError });
  await extractZipJs(zipPath, destDir, {
    onEntry: onProgress ? (e) => onProgress({ phase: 'extract', extractor: 'js', ...e }) : undefined,
  });
  if (expect && !existsSync(path.join(destDir, expect))) throw new Error(`The zip does not contain ${expect}.`);
  return { extractor: 'js', ...(tarError ? { tarError } : {}) };
}

// ─── ensure ──────────────────────────────────────────────────────────────────────────────────

const inFlight = new Map();   // "<home>|<version>|<platform>" → Promise

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

export const LOCK_TIMING = Object.freeze({
  heartbeatMs: 30_000,    // the holder touches the lock's mtime this often
  staleMs: 3 * 60_000,    // no heartbeat for this long: the holder is gone or hung
  youngEmptyMs: 10_000,   // an EMPTY lock younger than this is being written right now
  pollMs: 1000,           // how often a waiter looks again
});

/**
 * A cross-process lock file, so the desktop wizard and the daemon never extract the same build
 * twice. → release() (or null when `isDone()` says the work was finished by someone else).
 *
 * Liveness is the holder's pid AND a heartbeat: the holder touches the file's mtime every 30 s for
 * as long as it holds the lock, so a slow 200 MB download is never mistaken for a dead holder (a
 * fixed age limit would let a second process "take over" a live install), and a hung holder is.
 * The heartbeat only touches the mtime (utimes) — rewriting the file could race with release() and
 * recreate a lock nobody holds.
 *
 * An empty or half-written lock file is what another process's open('wx') looks like in the moment
 * before it writes its pid; it is only treated as stale once it is older than a few seconds.
 * Stealing it at once would put two installers in the same directory.
 */
export async function acquireLock(lockPath, { waitMs = 30 * 60_000, isDone, timing: custom } = {}) {
  const timing = { ...LOCK_TIMING, ...(custom ?? {}) };
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx');
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      } finally {
        await fh.close();
      }
      const beat = setInterval(() => {
        const now = new Date();
        utimes(lockPath, now, now).catch(() => {});
      }, timing.heartbeatMs);
      beat.unref?.();
      return async () => {
        clearInterval(beat);
        await rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (isDone && await isDone()) return null;
    let holder = null;
    try { holder = JSON.parse(await readFile(lockPath, 'utf8')); } catch {}
    let age;
    try {
      age = Date.now() - (await stat(lockPath)).mtimeMs;
    } catch {
      continue;   // released between our open and our stat: try again at once
    }
    const stale = holder && Number.isInteger(holder.pid)
      ? (!pidAlive(holder.pid) || age > timing.staleMs)
      : age > timing.youngEmptyMs;
    if (stale) {
      await rm(lockPath, { force: true }).catch(() => {});
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`Another G9 process (pid ${holder?.pid ?? 'unknown'}) is still installing into ${path.dirname(lockPath)}.`);
    }
    await new Promise((r) => setTimeout(r, timing.pollMs));
  }
}

/**
 * Remove what an INTERRUPTED install left in G9_HOME/engines: a partial download
 * (`.download/chrome-<platform>-<v>-<pid>.zip[.part-<pid>-<hex>]`), an extraction tree
 * (`.cft-<v>.tmp-<pid>-<hex>`, about 450 MB), and the `.broken-`/`.removing-` trees of an
 * interrupted replace or uninstall. Each is removed only by its own process's catch/finally, which
 * a killed process never runs — nor does a daemon that exits mid-install — and the next install
 * uses new pid-based names, so they stayed for good (engine review, 2026-09-22: 494,808,349 bytes
 * after two interrupted installs and a successful one).
 *
 * Every version and platform is swept, not only the one being installed (leftovers of an old pin
 * would otherwise never go). An entry is deleted only when its pid is not this process and is not
 * alive — even under the version lock, whose holder can be stolen from while still writing; a
 * reused pid makes the sweep skip an entry, which is the safe direction. A caller-supplied cacheDir
 * is never touched: it lives outside G9_HOME and may be shared.
 * → { removed: [names] }
 */
export async function sweepLeftovers({ home = g9Home() } = {}) {
  const root = enginesDir(home);
  const removed = [];
  const dead = (pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid && !pidAlive(pid);
  const drop = async (dir, name) => {
    try {
      await rm(path.join(dir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      removed.push(name);
    } catch { /* still in use: the next sweep tries again */ }
  };
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return { removed }; }
  const trees = [/^\.cft-.+\.tmp-(\d+)-[0-9a-f]+$/, /^cft-.+\.broken-(\d+)-\d+$/, /^cft-.+\.removing-(\d+)-\d+$/];
  for (const e of entries) {
    for (const re of trees) {
      const m = re.exec(e.name);
      if (m) {
        if (dead(Number(m[1]))) await drop(root, e.name);
        break;
      }
    }
  }
  const downloads = path.join(root, '.download');
  let files = null;
  try { files = await readdir(downloads); } catch { files = null; }
  if (files) {
    for (const name of files) {
      const m = /^chrome-.+-(\d+)\.zip(?:\.part-(\d+)-[0-9a-f]+)?$/.exec(name);
      if (m && dead(Number(m[2] ?? m[1]))) await drop(downloads, name);
    }
    // The (empty) folder itself stays: another process may be about to write its zip into it.
  }
  return { removed };
}

async function readMarker(dir) {
  try { return JSON.parse(await readFile(path.join(dir, INSTALL_MARKER), 'utf8')); } catch { return null; }
}

/** Where a cached zip for `version` lives in `cacheDir`. */
export function cachedZipPath(cacheDir, version, platform = platformKey()) {
  return path.join(cacheDir, `chrome-${platform}-${version}.zip`);
}

/**
 * Make Chrome for Testing `version` available under G9_HOME/engines/cft-<version>/. Idempotent:
 * an existing verified install returns immediately (source 'installed').
 *
 * opts:
 *   version     default: the pinned version
 *   platform    default: this machine's CfT platform
 *   onProgress  ({ phase: 'download'|'verify'|'extract'|'install'|'done', … }) => void
 *   cacheDir    keep/reuse the zip here (chrome-<platform>-<version>.zip): a cached zip that
 *               verifies is used without any network access; a fresh download is kept there
 *   sha256/size expected values for a version that is not pinned (else trust-on-first-use)
 *   trigger     who asked, for engine-versions.log ('first-run', 'engines-screen', 'auto', …)
 *   home, signal, url, env
 * → { version, path, dir, platform, sha256, size, source: 'installed'|'cache'|'download', extractor? }
 */
export function ensure(opts = {}) {
  const home = opts.home ?? g9Home();
  const platform = opts.platform ?? platformKey();
  const version = opts.version ?? pinned({ platform }).version;
  if (!version || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
    return Promise.reject(new Error(`Not a Chrome for Testing version: ${version ?? '(none pinned in engine/versions.json)'}`));
  }
  const key = `${home}|${version}|${platform}`;
  if (!inFlight.has(key)) {
    inFlight.set(key, ensureOnce({ ...opts, home, platform, version }).finally(() => inFlight.delete(key)));
  }
  return inFlight.get(key);
}

async function ensureOnce({ home, platform, version, onProgress, cacheDir, sha256, size, trigger = 'ensure', signal, url, env }) {
  const progress = (e) => { if (onProgress) { try { onProgress({ version, ...e }); } catch {} } };
  const dir = installDir(version, { home });
  const exeRel = exeRelativePath(platform);
  const exe = path.join(dir, exeRel);

  const already = async () => {
    const marker = await readMarker(dir);
    return marker && existsSync(exe) ? marker : null;
  };
  let marker = await already();
  if (marker) {
    progress({ phase: 'done', source: 'installed' });
    return { version, path: exe, dir, platform, sha256: marker.sha256, size: marker.size, source: 'installed' };
  }

  const release = await acquireLock(path.join(enginesDir(home), `.cft-${version}.lock`), { isDone: async () => !!(await already()) });
  try {
    // An earlier install killed mid-way (the wizard or daemon closed, a crash, power loss) left
    // its partial zip and extraction tree behind: removed now that this process owns the install.
    await sweepLeftovers({ home }).catch(() => {});
    marker = await already();
    if (marker) {
      progress({ phase: 'done', source: 'installed' });
      return { version, path: exe, dir, platform, sha256: marker.sha256, size: marker.size, source: 'installed' };
    }

    const pin = pinned({ platform });
    const expected = {
      sha256: (sha256 ?? (pin.version === version ? pin.sha256 : undefined))?.toLowerCase(),
      size: size ?? (pin.version === version ? pin.size : undefined),
    };
    const verify = (facts, where) => {
      if (expected.size && facts.size !== expected.size) {
        return `size ${facts.size} bytes, expected ${expected.size} (${where})`;
      }
      if (expected.sha256 && facts.sha256 !== expected.sha256) {
        return `sha256 ${facts.sha256}, expected ${expected.sha256} (${where})`;
      }
      return null;
    };

    // 1. The zip: a cached copy that verifies, else a download.
    let zip = null;
    let facts = null;
    let source = 'download';
    let downloadedUrl = null;
    let removeZipAfter = false;
    if (cacheDir) {
      const cached = cachedZipPath(cacheDir, version, platform);
      if (existsSync(cached)) {
        progress({ phase: 'verify', file: cached });
        const f = await hashFile(cached);
        const problem = verify(f, 'cached zip');
        if (!problem) {
          // With no pin for this version the cached zip is trusted on first use, like a download
          // would be; the marker and the log line record pinned: no.
          zip = cached; facts = f; source = 'cache';
        } else {
          // A cache that does not verify is not trusted and not deleted silently either: rename it
          // aside so the evidence survives, then download.
          await rename(cached, `${cached}.bad-${Date.now()}`).catch(() => {});
          progress({ phase: 'verify', warning: `cached zip rejected: ${problem}` });
        }
      }
    }
    if (!zip) {
      const zipUrl = url ?? (pin.version === version && pin.url ? pin.url : await downloadUrl(version, { platform, env }).catch(() => canonicalZipUrl(version, platform)));
      const target = cacheDir
        ? cachedZipPath(cacheDir, version, platform)
        : path.join(enginesDir(home), '.download', `chrome-${platform}-${version}-${process.pid}.zip`);
      removeZipAfter = !cacheDir;
      const dl = await download(zipUrl, target, { onProgress: (e) => progress(e), signal, env, version });
      downloadedUrl = dl.url;
      facts = { sha256: dl.sha256, size: dl.size };
      zip = dl.path;
      progress({ phase: 'verify', file: zip });
      const problem = verify(facts, zipUrl);
      if (problem) {
        await rm(zip, { force: true }).catch(() => {});
        throw new Error(
          `Chrome for Testing ${version} (${platform}) failed verification: ${problem}. ` +
          `The download was deleted and nothing was installed. If Google re-published this build, ` +
          `check why before re-pinning it with "node engine/cft.js pin".`,
        );
      }
    }

    // 2. Extract next to the final location (same volume → the rename below is atomic).
    const tmp = path.join(enginesDir(home), `.cft-${version}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
    await rm(tmp, { recursive: true, force: true });
    let extraction;
    let winner = null;
    try {
      extraction = await extractZip(zip, tmp, { expect: exeRel, onProgress: progress });
      // 3. The exe must BE that version. A zip from the wrong folder would otherwise install as a lie.
      const actual = await exeVersion(path.join(tmp, exeRel), { kind: 'cft' });
      if (actual && actual !== version) throw new Error(`the zip contains Chrome ${actual}, not ${version}`);
      const record = {
        kind: 'cft',
        version,
        platform,
        sha256: facts.sha256,
        size: facts.size,
        pinned: !!(expected.sha256),
        url: downloadedUrl ?? url ?? (pin.version === version ? pin.url : null) ?? null,
        source,
        extractor: extraction.extractor,
        ...(extraction.tarError ? { tarError: extraction.tarError } : {}),
        exeVersion: actual ?? null,
        installedAt: new Date().toISOString(),
        trigger,
      };
      await writeFile(path.join(tmp, INSTALL_MARKER), JSON.stringify(record, null, 2));
      progress({ phase: 'install', dir });
      // Someone else may have finished the same build meanwhile (a process whose lock looked stale
      // to us). A verified install is never replaced: keep theirs, drop ours.
      winner = await already();
      if (winner) {
        await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
      } else {
        if (existsSync(dir)) {
          // A directory without a marker is a broken earlier attempt. Move it aside, then delete it
          // (it is ~450 MB). If it cannot be moved, a browser is running from it: say so, and do not
          // delete files from under that browser.
          const broken = `${dir}.broken-${process.pid}-${Date.now()}`;
          try {
            await rename(dir, broken);
          } catch (err) {
            throw new Error(`the incomplete install at ${dir} cannot be replaced (${err.code ?? err.message}); is a browser from it still running?`);
          }
          await rm(broken, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
        }
        await rename(tmp, dir);
      }
    } catch (err) {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
      throw err instanceof Error && err.message.startsWith('Chrome for Testing') ? err
        : new Error(`Installing Chrome for Testing ${version} failed: ${err.message}`);
    } finally {
      if (removeZipAfter) await rm(zip, { force: true }).catch(() => {});
    }
    if (winner) {
      progress({ phase: 'done', source: 'installed' });
      return { version, path: exe, dir, platform, sha256: winner.sha256, size: winner.size, source: 'installed' };
    }

    await appendVersionLog({
      home, event: 'install', kind: 'cft', version, sha256: facts.sha256, trigger,
      platform, size: facts.size, source, extractor: extraction.extractor, pinned: expected.sha256 ? 'yes' : 'no (trust-on-first-use)',
    });
    progress({ phase: 'done', source });
    return { version, path: exe, dir, platform, sha256: facts.sha256, size: facts.size, source, extractor: extraction.extractor };
  } finally {
    if (release) await release();
  }
}

/** Pinned / installed / (optionally) Google's current Stable — for the admin `engines.versions` op. */
export async function status({ home = g9Home(), checkLatest = false, ...opts } = {}) {
  const out = { pinned: pinned({ platform: platformKey() }), installed: await installed({ home }) };
  if (checkLatest) {
    try {
      out.latest = await latestStable(opts);
      out.updateAvailable = compareVersions(out.latest.version, out.pinned.version) > 0;
    } catch (err) {
      out.latestError = err.message;
    }
  }
  return out;
}

// ─── pinning (a maintainer action; writes engine/versions.json) ──────────────────────────────

/**
 * Pin the current Stable (or `version`): download it once, compute sha256 and size, write
 * versions.json. This IS the trust-on-first-use step; run it deliberately, commit the result.
 */
export async function pin({ channel = 'Stable', version, platform = 'win64', cacheDir, onProgress, env } = {}) {
  let chosen;
  if (version) {
    chosen = { channel: null, version, url: await downloadUrl(version, { platform, env }) };
  } else {
    chosen = await latestStable({ channel, platform, env });
  }
  const dir = cacheDir ?? path.join(os.tmpdir(), 'g9-cft-cache');
  const zipPath = cachedZipPath(dir, chosen.version, platform);
  let facts;
  let md5 = null;
  if (existsSync(zipPath)) {
    // A zip already in the cache is what gets pinned, so it must at least be a whole zip: a
    // truncated file has no readable central directory and fails here instead of being pinned.
    await listZip(zipPath).catch((err) => {
      throw new Error(`The cached ${zipPath} is not a complete zip (${err.message}); delete it and pin again.`);
    });
    facts = await hashFile(zipPath);
  } else {
    const dl = await download(chosen.url, zipPath, { onProgress, env, version: chosen.version });
    facts = { sha256: dl.sha256, size: dl.size };
    md5 = dl.declaredMd5;
  }
  const doc = readVersionsFile({ fresh: true });
  const prev = doc['chrome-for-testing'] ?? {};
  const downloads = prev.version === chosen.version ? { ...(prev.downloads ?? {}) } : {};
  downloads[platform] = {
    url: chosen.url,
    size: facts.size,
    sha256: facts.sha256,
    ...(md5 ? { serverMd5: md5 } : {}),
  };
  doc['chrome-for-testing'] = {
    channel: chosen.channel ?? prev.channel ?? null,
    version: chosen.version,
    ...(chosen.revision ? { revision: chosen.revision } : {}),
    pinnedAt: new Date().toISOString(),
    trust: 'trust-on-first-use: sha256 and size computed by engine/cft.js pin from the first download; the transfer was checked against the MD5 in Google storage\'s x-goog-hash header',
    source: ENDPOINTS.lastKnownGood,
    downloads,
  };
  await writeFile(VERSIONS_FILE, JSON.stringify(doc, null, 2) + '\n');
  versionsCache = null;
  return { ...doc['chrome-for-testing'], zip: zipPath };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────────────────────
//   node engine/cft.js status [--latest]
//   node engine/cft.js ensure [--version V] [--cache DIR] [--home DIR]
//   node engine/cft.js pin [--channel Stable] [--version V] [--cache DIR]

function progressPrinter() {
  let lastStep = -1;
  let lastLine = '';
  const mb = (n) => (n / 1048576).toFixed(1);
  return (e) => {
    if (e.phase === 'download') {
      // One line per 5% (or per 10 MB when the size is unknown), not one per chunk.
      const step = e.percent != null ? Math.floor(e.percent / 5) : Math.floor(e.received / 10485760);
      if (step === lastStep) return;
      lastStep = step;
      const of = e.total ? `/${mb(e.total)}` : '';
      const pct = e.percent != null ? ` (${e.percent.toFixed(0)}%)` : '';
      process.stderr.write(`download ${mb(e.received)}${of} MB${pct} at ${mb(e.bytesPerSecond)} MB/s\n`);
      return;
    }
    if (e.phase === 'extract' && e.index !== undefined) return;   // per-entry JS progress: too chatty for a terminal
    const parts = [e.phase];
    if (e.extractor) parts.push(`(${e.extractor})`);
    if (e.warning) parts.push(`: ${e.warning}`);
    if (e.tarError) parts.push(`— tar failed: ${e.tarError}`);
    if (e.source) parts.push(`: ${e.source}`);
    const line = parts.join(' ');
    if (line !== lastLine) process.stderr.write(line + '\n');
    lastLine = line;
  };
}

async function main(argv) {
  const [cmd = 'status', ...rest] = argv;
  const arg = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  const home = arg('home') ? path.resolve(arg('home')) : undefined;
  let result;
  if (cmd === 'status') result = await status({ home, checkLatest: rest.includes('--latest') });
  else if (cmd === 'ensure') result = await ensure({ version: arg('version'), cacheDir: arg('cache'), home, trigger: 'cli', onProgress: progressPrinter() });
  else if (cmd === 'pin') result = await pin({ channel: arg('channel') ?? 'Stable', version: arg('version'), cacheDir: arg('cache'), onProgress: progressPrinter() });
  else throw new Error(`Unknown command "${cmd}". Use status, ensure or pin.`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

/** True when this file is the script node was started with (not when it is imported). */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    // Real paths, compared case-insensitively on Windows: `node engine\cft.js` from a Git Bash
    // prompt on "g:" vs the loader's "G:" must still count as the same file.
    const self = realpathSync(fileURLToPath(import.meta.url));
    const started = realpathSync(path.resolve(process.argv[1]));
    return process.platform === 'win32' ? self.toLowerCase() === started.toLowerCase() : self === started;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`cft: ${err.message}\n`);
    process.exit(1);
  });
}
