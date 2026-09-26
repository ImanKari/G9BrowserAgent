/**
 * Publish a verified release folder as a GitHub release — the last step of azure-pipelines.yml,
 * run only after every build, test and update check passed and the repository was mirrored.
 *
 *   GITHUB_PAT=… node setup/github-release.mjs --dir <release folder> --version <v> --commit <sha>
 *               [--owner ImanKari] [--repo G9BrowserAgent] [--notes <file>] [--dry-run]
 *
 * 1. If release v<version> is already PUBLISHED, stop: a re-run without a version bump publishes
 *    nothing (the NuGet --skip-duplicate of the other G9 pipelines). Its assets are still checked.
 * 2. Create the release as a DRAFT on tag v<version> at <commit> (the mirror pushed both), or reuse
 *    the draft a failed run left, removing assets it had half-uploaded.
 * 3. Upload every file of the folder.
 * 4. Verify every uploaded asset against the local file: GitHub's sha256 digest where it gives one,
 *    else the size. A mismatch leaves the release a draft — invisible to people and to the updater.
 * 5. Publish (draft → release, marked latest).
 * 6. Check the official update feed the way electron-updater's github provider reads it:
 *    /releases/latest names the tag, and releases/download/<tag>/latest*.yml carry this version.
 *
 * No dependencies (Node 22 fetch). The token only ever travels in an Authorization header.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const DIR = path.resolve(opt('--dir') ?? '');
const VERSION = opt('--version');
const COMMIT = opt('--commit');
const OWNER = opt('--owner', 'ImanKari');
const REPO = opt('--repo', 'G9BrowserAgent');
const NOTES = opt('--notes');
const DRY = args.includes('--dry-run');
const TOKEN = process.env.GITHUB_PAT ?? process.env.GH_TOKEN ?? '';
const TAG = `v${VERSION}`;
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

const say = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`##vso[task.logissue type=error]${msg}`);
  console.error(msg);
  process.exit(1);
};

async function gh(url, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'g9-release',
      ...(body && !(body instanceof Uint8Array) && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body && !(body instanceof Uint8Array) && typeof body !== 'string' ? JSON.stringify(body) : body,
    redirect: 'follow',
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new Error(`${method} ${url} → ${res.status}: ${json?.message ?? text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function localFiles() {
  if (!fs.existsSync(DIR)) fail(`--dir ${DIR} does not exist`);
  return fs.readdirSync(DIR).filter((n) => fs.statSync(path.join(DIR, n)).isFile()).sort();
}

async function verifyAssets(release, files) {
  const assets = await gh(`${API}/releases/${release.id}/assets?per_page=100`);
  const problems = [];
  for (const name of files) {
    const a = assets.find((x) => x.name === name);
    const file = path.join(DIR, name);
    if (!a) { problems.push(`${name} is not on the release`); continue; }
    if (a.state !== 'uploaded') problems.push(`${name} is ${a.state}`);
    if (a.size !== fs.statSync(file).size) problems.push(`${name}: ${a.size} bytes on GitHub, ${fs.statSync(file).size} here`);
    if (a.digest) {
      if (a.digest !== `sha256:${sha256(file)}`) problems.push(`${name}: GitHub's ${a.digest} is not this file's sha256`);
    }
  }
  const extra = assets.filter((a) => !files.includes(a.name)).map((a) => a.name);
  if (extra.length) problems.push(`unexpected assets: ${extra.join(', ')}`);
  return { problems, assets };
}

async function main() {
  if (!VERSION || !/^\d+\.\d+\.\d+$/.test(VERSION)) fail('--version <x.y.z> is required (a release, not a prerelease)');
  if (!COMMIT || !/^[0-9a-f]{40}$/.test(COMMIT)) fail('--commit <40-hex sha> is required');
  if (!TOKEN) fail('GITHUB_PAT is not set');
  const files = localFiles();
  for (const need of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) if (!files.includes(need)) fail(`${need} is missing from ${DIR}`);
  say(`Release ${TAG} of ${OWNER}/${REPO} at ${COMMIT.slice(0, 12)}: ${files.length} files`);

  // 1. already published?
  let release = null;
  try {
    release = await gh(`${API}/releases/tags/${TAG}`);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (release && !release.draft) {
    say(`##vso[task.logissue type=warning]Release ${TAG} is already published (${release.html_url}). The version was not bumped: nothing is published again.`);
    const { problems } = await verifyAssets(release, files).catch((e) => ({ problems: [e.message] }));
    if (problems.length) say(`##vso[task.logissue type=warning]The published ${TAG} differs from this build: ${problems.join('; ')}`);
    return;
  }
  if (DRY) {
    say('(dry run: stopping before any write)');
    return;
  }

  // 2. draft
  const notes = NOTES && fs.existsSync(NOTES) ? fs.readFileSync(NOTES, 'utf8') : `G9 ${VERSION}`;
  if (!release) {
    // Drafts are invisible to /releases, releases.atom and /releases/latest — to people and to
    // electron-updater — until step 5.
    release = await gh(`${API}/releases`, { method: 'POST', body: { tag_name: TAG, target_commitish: COMMIT, name: `G9 ${VERSION}`, body: notes, draft: true, prerelease: false } });
    say(`Draft created: ${release.html_url}`);
  } else {
    say(`Reusing the draft a previous run left: ${release.html_url}`);
    for (const a of await gh(`${API}/releases/${release.id}/assets?per_page=100`)) {
      await gh(`${API}/releases/assets/${a.id}`, { method: 'DELETE' });
      say(`  removed half-uploaded ${a.name}`);
    }
    release = await gh(`${API}/releases/${release.id}`, { method: 'PATCH', body: { tag_name: TAG, target_commitish: COMMIT, name: `G9 ${VERSION}`, body: notes } });
  }

  // 3. upload
  for (const name of files) {
    const bytes = fs.readFileSync(path.join(DIR, name));
    const type = name.endsWith('.yml') ? 'text/yaml' : name.endsWith('.txt') ? 'text/plain' : 'application/octet-stream';
    for (let attempt = 1; ; attempt++) {
      try {
        await gh(`https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
          method: 'POST', body: new Uint8Array(bytes), headers: { 'content-type': type, 'content-length': String(bytes.length) },
        });
        say(`  uploaded ${name} (${(bytes.length / 1048576).toFixed(1)} MB)`);
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        say(`  upload of ${name} failed (${err.message}); retrying`);
        const stale = (await gh(`${API}/releases/${release.id}/assets?per_page=100`)).find((a) => a.name === name);
        if (stale) await gh(`${API}/releases/assets/${stale.id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  }

  // 4. verify what GitHub holds
  const { problems } = await verifyAssets(release, files);
  if (problems.length) fail(`The uploaded assets do not match the verified build — the release stays a draft:\n  ${problems.join('\n  ')}`);
  say('Every asset on GitHub matches the local file.');

  // 5. publish
  release = await gh(`${API}/releases/${release.id}`, { method: 'PATCH', body: { draft: false, make_latest: 'true' } });
  say(`Published: ${release.html_url}`);

  // 6. the official feed, as electron-updater reads it (github provider, stable channel)
  const latest = await fetch(`https://github.com/${OWNER}/${REPO}/releases/latest`, { headers: { accept: 'application/json', 'user-agent': 'g9-release' } }).then((r) => r.json());
  if (latest?.tag_name !== TAG) fail(`/releases/latest names ${latest?.tag_name}, not ${TAG}`);
  for (const meta of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) {
    const res = await fetch(`https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${meta}`, { redirect: 'follow', headers: { 'user-agent': 'g9-release' } });
    const text = await res.text();
    if (!res.ok || !new RegExp(`^version: ${VERSION.replace(/\./g, '\\.')}$`, 'm').test(text)) fail(`${meta} from the release does not carry version ${VERSION} (HTTP ${res.status})`);
  }
  say(`The official update feed serves ${VERSION}: /releases/latest → ${TAG}; latest.yml, latest-mac.yml and latest-linux.yml carry ${VERSION}.`);
}

main().catch((err) => fail(String(err?.stack ?? err)));
