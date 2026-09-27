/**
 * (Moved from bridge/src/flows.js in v2; behaviour unchanged.)
 *
 * The flow library — FlowSpec files on disk, in the project's own repository.
 *
 * ## The problem this solves
 *
 * A recording lives in `chrome.storage.local`. That is the right home for it
 * while it is being made and the wrong home for it afterwards: it is invisible
 * to every other QA, absent from code review, missing from Git history, and
 * gone when the browser profile is cleared. The engine was always able to
 * export a FlowSpec — a canonical, versioned, reviewable form — but nothing
 * ever wrote one to a file.
 *
 * This module is that missing half. The extension cannot touch the filesystem
 * and must not be able to; the daemon is a Node process and already is the
 * component that knows where the repo lives. So the library lives here, and the
 * panel reaches it over the WebSocket that is already open.
 *
 * ## Layout
 *
 *   QA/Flows/web/auth/login.flow.json
 *   QA/Flows/agripad/map/site-select.flow.json
 *   QA/Flows/suites/web.full.json
 *
 * The folder path is derived from the flow's own `folder` field, so moving a
 * flow between sections is a metadata edit rather than a manual file move.
 *
 * ## Two rules that keep the diffs honest
 *
 * 1. **Canonical JSON only.** The extension canonicalises before sending; we
 *    write exactly what we were given plus a trailing newline. Two exports of
 *    an unchanged flow are byte-identical, so a diff is always a real change.
 * 2. **Run history never lands here.** `runHistory`, `lastRun` and `flaky` are
 *    local truth about one machine. Committing them would mean every replay
 *    dirties the working tree, which trains people to `git checkout .` — and
 *    eventually to throw away a real edit.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { approvedJson, validateApproved, latestApprovalOf } from '../extension/lib/approved.js';

const FLOW_SUFFIX = '.flow.json';
const SUITE_DIR = 'suites';
// (3.2) What a person approved travels beside the flow (extension/lib/approved.js):
// login.flow.json + login.approved.json + login.baselines/<step>.png.
const APPROVED_SUFFIX = '.approved.json';
const BASELINES_SUFFIX = '.baselines';
const IMAGE_NAME = /^[\w.-]{1,80}\.png$/;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/** Fields that are local-only truth and must never be written to disk. */
const LOCAL_ONLY = ['runHistory', 'lastRun', 'flaky', 'knownWorld', 'knownWorlds', 'surpriseHistory'];

export class FlowLibrary {
  constructor(rootDir) {
    this.root = rootDir ? path.resolve(rootDir) : null;
  }

  get available() {
    return !!this.root;
  }

  /**
   * Why an unavailable library explains itself rather than throwing.
   *
   * "No project adapter" is a setup state, not a fault. The panel shows the
   * sentence; the user adds `g9.project.json` and presses sync again.
   */
  #requireRoot() {
    if (!this.root) {
      throw new Error(
        'No flow library is configured. The daemon could not find g9.project.json, so it does not ' +
          'know which repository the flows belong to. Create one next to your project (copy ' +
          'g9.project.example.json) or set G9_PROJECT to its path, then reconnect.',
      );
    }
  }

  /**
   * Every flow and suite on disk, with a content hash for change detection. With `site` (3.2), only
   * the flows whose start URL is on that origin (`'none'`: flows with no start URL); suites stay.
   */
  async list({ site = null } = {}) {
    this.#requireRoot();
    const files = await walk(this.root);
    const flows = [];
    const suites = [];

    for (const file of files) {
      const rel = path.relative(this.root, file).replace(/\\/g, '/');
      let parsed;
      try {
        parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (err) {
        flows.push({ file: rel, broken: true, error: `not valid JSON: ${err.message}` });
        continue;
      }

      const entry = {
        file: rel,
        id: parsed.id ?? null,
        name: parsed.name ?? '(unnamed)',
        hash: hash(parsed),
        risk: parsed.risk ?? 'normal',
        updatedAt: (await fs.stat(file)).mtimeMs,
      };

      if (rel.startsWith(`${SUITE_DIR}/`) || parsed.select) {
        suites.push({ ...entry, select: parsed.select ?? null });
      } else {
        flows.push({
          ...entry,
          platform: parsed.target?.kind ?? 'web',
          folder: parsed.folder ?? null,
          suite: parsed.suite ?? null,
          tags: parsed.tags ?? [],
          stepCount: (parsed.steps ?? []).length,
          qaTestCaseIds: parsed.qaTestCaseIds ?? [],
          startUrl: typeof parsed.startUrl === 'string' ? parsed.startUrl : null,
          ...(await sidecarSummary(file)),
        });
      }
    }

    const shown = site ? flows.filter((f) => !f.broken && siteMatches(f.startUrl, site)) : flows;
    return { root: this.root.replace(/\\/g, '/'), flows: shown, suites, ...(site ? { site } : {}) };
  }

  /** One flow, by id. */
  async read(id) {
    this.#requireRoot();
    const found = await this.#findById(id);
    if (!found) throw new Error(`No flow with id "${id}" in ${this.root}.`);
    return JSON.parse(await fs.readFile(found, 'utf8'));
  }

  /**
   * Write a FlowSpec, deriving its path from its own metadata.
   *
   * Returns `{ file, changed }`. `changed:false` means the bytes on disk were
   * already identical — worth reporting, because "pushed 4 flows, 0 changed"
   * is the answer to "did my edit actually save?".
   */
  async write(spec) {
    this.#requireRoot();
    if (!spec?.id) throw new Error('A FlowSpec needs an id before it can be written to the library.');

    const clean = { ...spec };
    for (const field of LOCAL_ONLY) delete clean[field];

    const existing = await this.#findById(spec.id);
    let target = existing;
    let collidedWith = null;
    if (!target) {
      // A NEW flow never overwrites a file that is not its own. Two flows whose names slug to the
      // same file ("Checkout" and "checkout!", two recordings both named "Login") used to share
      // it: the second push replaced the first flow, which then vanished from the library — and
      // every suite that selected it quietly stopped covering it (daemon review, 2026-09-22).
      // The fallback name carries the flow's id, so it is the same on every machine and in every
      // push order; later pushes find the file by id anyway.
      const derived = path.join(this.root, relativePathFor(clean));
      const foreign = await foreignFlowAt(derived, spec.id);
      if (!foreign) {
        target = derived;
      } else {
        const fallback = path.join(path.dirname(derived), `${path.basename(derived, FLOW_SUFFIX)}-${slug(spec.id) || 'flow'}${FLOW_SUFFIX}`);
        const second = await foreignFlowAt(fallback, spec.id);
        const rel = (p) => path.relative(this.root, p).replace(/\\/g, '/');
        if (second) {
          throw new Error(
            `Flow "${clean.name ?? spec.id}" (${spec.id}) was not written: ${rel(derived)} holds ${foreign.what}, and ` +
              `${rel(fallback)} holds ${second.what}. Rename one of the flows.`,
          );
        }
        target = fallback;
        collidedWith = { id: foreign.id, name: foreign.name, file: rel(derived) };
      }
    }
    const body = `${JSON.stringify(clean, null, 2)}\n`;

    let changed = true;
    try {
      changed = (await fs.readFile(target, 'utf8')) !== body;
    } catch {
      /* new file */
    }

    if (changed) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body, 'utf8');
    }

    return { file: path.relative(this.root, target).replace(/\\/g, '/'), changed, ...(collidedWith ? { collidedWith } : {}) };
  }

  async remove(id) {
    this.#requireRoot();
    const found = await this.#findById(id);
    if (!found) return { removed: false };
    await fs.unlink(found);
    // Its approval and baselines go with it: a sidecar with no flow is noise in the next review.
    const side = sidecarOf(found);
    await fs.rm(side.approved, { force: true }).catch(() => {});
    await fs.rm(side.dir, { recursive: true, force: true }).catch(() => {});
    return { removed: true, file: path.relative(this.root, found).replace(/\\/g, '/') };
  }

  /**
   * (3.2) Write what a person approved about a flow that is in this library: the sidecar document
   * (extension/lib/approved.js approvedDocFor) and its baseline screenshots, `{ name: base64 }`.
   * A flow that is not here is not an error — the answer says so (`written: false`), because an
   * approval of a flow nobody pushed yet is normal and must not fail the approval.
   * Images no longer named by the document are removed; unchanged bytes are not rewritten.
   */
  async writeApproved(flowId, doc, images = {}) {
    this.#requireRoot();
    const found = await this.#findById(String(flowId));
    if (!found) {
      return { written: false, reason: `Flow ${flowId} is not in ${this.root.replace(/\\/g, '/')} yet: push it, and its approval travels with it.` };
    }
    const problems = validateApproved(doc, String(flowId));
    if (problems.length) throw new Error(`The approval of flow ${flowId} was not written: ${problems.join('; ')}.`);
    const side = sidecarOf(found);
    const rel = (p) => path.relative(this.root, p).replace(/\\/g, '/');
    const body = approvedJson(doc);
    let changed = true;
    try { changed = (await fs.readFile(side.approved, 'utf8')) !== body; } catch { /* new */ }
    if (changed) await fs.writeFile(side.approved, body, 'utf8');

    const named = new Set(Object.values(doc.baselines ?? {}).map((b) => b?.image).filter(Boolean));
    let imagesChanged = 0;
    const missing = [];
    for (const name of named) {
      const data = images?.[name];
      if (typeof data !== 'string' || !data) { missing.push(name); continue; }
      if (!IMAGE_NAME.test(name)) throw new Error(`Baseline image name "${name}" is not a plain .png file name.`);
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`Baseline image ${name} is larger than ${MAX_IMAGE_BYTES / 1048576} MB.`);
      const file = path.join(side.dir, name);
      let same = false;
      try { same = (await fs.readFile(file)).equals(bytes); } catch { /* new */ }
      if (!same) {
        await fs.mkdir(side.dir, { recursive: true });
        await fs.writeFile(file, bytes);
        imagesChanged++;
      }
    }
    let removedImages = 0;
    try {
      for (const name of await fs.readdir(side.dir)) {
        if (name.endsWith('.png') && !named.has(name)) {
          await fs.rm(path.join(side.dir, name), { force: true });
          removedImages++;
        }
      }
      if (!(await fs.readdir(side.dir)).length) await fs.rmdir(side.dir);
    } catch { /* no folder */ }
    return {
      written: true,
      file: rel(side.approved),
      changed: changed || imagesChanged > 0 || removedImages > 0,
      images: named.size - missing.length,
      ...(missing.length ? { missingImages: missing } : {}),
      // The latest approval across environments (a sidecar may carry one world per environment).
      approvedAt: latestApprovalOf(doc).approvedAt,
    };
  }

  /** (3.2) A flow's sidecar and its baseline images `{ name: base64 }`; `approved: null` when it has none. */
  async readApproved(flowId) {
    this.#requireRoot();
    const found = await this.#findById(String(flowId));
    if (!found) throw new Error(`No flow with id "${flowId}" in ${this.root}.`);
    const side = sidecarOf(found);
    let approved = null;
    try {
      approved = JSON.parse(await fs.readFile(side.approved, 'utf8'));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw new Error(`${path.relative(this.root, side.approved).replace(/\\/g, '/')} is not valid JSON: ${err.message}`);
    }
    const images = {};
    if (approved) {
      for (const b of Object.values(approved.baselines ?? {})) {
        if (!b?.image || !IMAGE_NAME.test(b.image)) continue;
        try { images[b.image] = (await fs.readFile(path.join(side.dir, b.image))).toString('base64'); } catch { /* missing image: the fingerprint still compares */ }
      }
    }
    return { approved, images };
  }

  /**
   * Compare what the browser holds against what the repo holds.
   *
   * Deliberately returns the three lists rather than a verdict: the panel says
   * "3 new in repo, 1 not committed" and the human decides. An automatic merge
   * would silently overwrite whichever side the tool guessed was older, and the
   * loser is always somebody's unsaved work.
   */
  async status(local = [], { site = null } = {}) {
    this.#requireRoot();
    const { flows } = await this.list({ site });
    const byId = new Map(flows.filter((f) => f.id).map((f) => [f.id, f]));
    const localById = new Map(local.filter((f) => f.id).map((f) => [f.id, f]));

    const onlyInRepo = [];
    const onlyLocal = [];
    const differing = [];
    // (3.2) Approvals are compared by when a person approved: `approvedAt` in the local entry
    // (null when this browser has no human approval) against the sidecar's.
    const approvalNewerInRepo = [];
    const approvalNewerHere = [];

    for (const [id, remote] of byId) {
      const mine = localById.get(id);
      if (!mine) onlyInRepo.push(remote);
      else if (mine.hash && mine.hash !== remote.hash) differing.push({ id, name: remote.name });
      if (mine) {
        const here = Number(mine.approvedAt) || 0;
        const there = Number(remote.approvedAt) || 0;
        if (there > here) approvalNewerInRepo.push({ id, name: remote.name, approvedAt: there, approvedBy: remote.approvedBy ?? null });
        else if (here > there) approvalNewerHere.push({ id, name: remote.name, approvedAt: here });
      }
    }
    for (const [id, mine] of localById) {
      if (!byId.has(id)) onlyLocal.push({ id, name: mine.name });
    }

    return { onlyInRepo, onlyLocal, differing, approvalNewerInRepo, approvalNewerHere, total: flows.length, ...(site ? { site } : {}) };
  }

  /**
   * Resolve a suite's `select` query into concrete flows.
   *
   * A suite is a QUERY, not a list, on purpose: a hand-maintained array of flow
   * names shrinks silently the first time somebody forgets to add theirs, and a
   * Full-Test that quietly stopped covering a feature still reports green.
   */
  async resolveSuite(suiteId) {
    this.#requireRoot();
    const { flows, suites } = await this.list();
    const suite = suites.find((s) => s.id === suiteId || s.file === suiteId);
    if (!suite) {
      throw new Error(
        `No suite "${suiteId}". Known suites: ${suites.map((s) => s.id ?? s.file).join(', ') || '(none)'}.`,
      );
    }

    const raw = JSON.parse(await fs.readFile(path.join(this.root, suite.file), 'utf8'));
    const select = raw.select ?? {};
    let chosen = flows.filter((f) => !f.broken);

    if (select.platform) chosen = chosen.filter((f) => f.platform === select.platform);
    if (select.folder) chosen = chosen.filter((f) => (f.folder ?? '').startsWith(select.folder));
    if (select.suite) chosen = chosen.filter((f) => f.suite === select.suite);
    if (select.tags?.length) chosen = chosen.filter((f) => select.tags.every((t) => f.tags.includes(t)));
    if (select.anyTags?.length) chosen = chosen.filter((f) => select.anyTags.some((t) => f.tags.includes(t)));
    if (select.excludeTags?.length) {
      chosen = chosen.filter((f) => !select.excludeTags.some((t) => f.tags.includes(t)));
    }
    if (select.ids?.length) chosen = chosen.filter((f) => select.ids.includes(f.id));

    if (raw.order === 'risk-desc') {
      const rank = { critical: 0, high: 1, normal: 2, low: 3 };
      chosen.sort((a, b) => (rank[a.risk] ?? 2) - (rank[b.risk] ?? 2));
    } else if (raw.order === 'name') {
      chosen.sort((a, b) => a.name.localeCompare(b.name));
    }

    return { suite: raw, flows: chosen };
  }

  async #findById(id) {
    const files = await walk(this.root);
    for (const file of files) {
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        if (parsed.id === id) return file;
      } catch {
        /* a broken file cannot be the one we want */
      }
    }
    return null;
  }
}

/**
 * Is a start URL on this site? `site` is an origin (`https://admin.example.test`, what
 * extension/lib/sites.js siteOf gives), or `'none'` for a flow with no usable start URL.
 */
export function siteMatches(startUrl, site) {
  let origin = null;
  try {
    const u = new URL(String(startUrl ?? ''));
    if (/^https?:$/.test(u.protocol)) origin = u.origin.toLowerCase();
  } catch { /* no URL */ }
  return site === 'none' ? origin === null : origin === String(site).toLowerCase();
}

/**
 * Whose flow is in `file`, when it is not the flow `id`'s own: `{ id, name, what }`, or null when
 * the file does not exist or already holds this id. A file that is not valid JSON (or has no id)
 * is foreign too — it is not overwritten either.
 */
async function foreignFlowAt(file, id) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { id: null, name: null, what: 'a file that is not valid JSON' };
  }
  if (parsed?.id === id) return null;
  const name = typeof parsed?.name === 'string' ? parsed.name : null;
  return { id: parsed?.id ?? null, name, what: parsed?.id ? `flow "${name ?? parsed.id}" (${parsed.id})` : 'a flow file with no id' };
}

/**
 * The on-disk path a flow belongs at.
 *
 * `platform/folder/name.flow.json`, with the name slugified from the flow's own
 * name rather than its id: `login.flow.json` is reviewable in a diff and
 * `rec_a91f3c.flow.json` is not.
 */
export function relativePathFor(spec) {
  const platform = spec.target?.kind === 'maui' ? 'agripad' : (spec.target?.kind ?? 'web');
  const folder = (spec.folder ?? '')
    .split('/')
    .map(slug)
    .filter(Boolean)
    .join('/');
  const base = slug(spec.name) || slug(spec.id) || 'flow';
  return path.join(platform, folder, `${base}${FLOW_SUFFIX}`);
}

function slug(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * The content hash — must agree, byte for byte, with the extension's.
 *
 * So it hashes the SERIALISED form the file holds, not the parsed object:
 * `JSON.stringify(x, null, 2) + '\n'` is exactly what `write()` puts on disk
 * and exactly what `canonicalJson()` produces in the extension. Hashing the
 * parsed object instead would be a different string, the two sides would never
 * agree, and every flow would be reported as diverged forever.
 *
 * SHA-1, first 12 hex, on both sides. Not a security primitive — a change
 * detector.
 */
function hash(value) {
  const serialised = `${JSON.stringify(value, null, 2)}\n`;
  return crypto.createHash('sha1').update(serialised, 'utf8').digest('hex').slice(0, 12);
}

/** Where a flow file's approval and baselines live (3.2): beside it, sharing its base name. */
function sidecarOf(flowFile) {
  const base = flowFile.endsWith(FLOW_SUFFIX) ? flowFile.slice(0, -FLOW_SUFFIX.length) : flowFile.replace(/.json$/i, '');
  return { approved: `${base}${APPROVED_SUFFIX}`, dir: `${base}${BASELINES_SUFFIX}` };
}

/** A sidecar's approval time and baseline count, for list(); nulls when there is none or it is unreadable. */
async function sidecarSummary(flowFile) {
  try {
    const doc = JSON.parse(await fs.readFile(sidecarOf(flowFile).approved, 'utf8'));
    // The latest approval across environments: what the status line compares.
    const { approvedAt, approvedBy } = latestApprovalOf(doc);
    return {
      approvedAt,
      approvedBy,
      baselines: Object.keys(doc?.baselines ?? {}).length,
    };
  } catch {
    return { approvedAt: null, approvedBy: null, baselines: 0 };
  }
}

/** Every *.flow.json and suites/*.json under the root (not sidecars). Missing root is empty. */
async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // A flow's baselines folder holds images only (3.2).
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name.endsWith(BASELINES_SUFFIX)) continue;
      await walk(full, out);
    } else if (entry.name.endsWith(APPROVED_SUFFIX)) {
      // A sidecar is not a flow: it belongs to the flow file beside it (3.2).
      continue;
    } else if (entry.name.endsWith('.candidate.json')) {
      // A harvested candidate (`g9 harvest`) is raw device material for a human
      // to turn INTO a flow — it is not a FlowSpec and must never be listed,
      // matched by id, or imported as one.
      continue;
    } else if (entry.name.endsWith(FLOW_SUFFIX) || entry.name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}
