/**
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
 * and must not be able to; the bridge is a Node process and already is the
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

const FLOW_SUFFIX = '.flow.json';
const SUITE_DIR = 'suites';

/** Fields that are local-only truth and must never be written to disk. */
const LOCAL_ONLY = ['runHistory', 'lastRun', 'flaky', 'knownWorld', 'surpriseHistory'];

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
        'No flow library is configured. The bridge could not find g9.project.json, so it does not ' +
          'know which repository the flows belong to. Create one next to your project (copy ' +
          'g9.project.example.json) or set G9_PROJECT to its path, then reconnect.',
      );
    }
  }

  /** Every flow and suite on disk, with a content hash for change detection. */
  async list() {
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
        });
      }
    }

    return { root: this.root.replace(/\\/g, '/'), flows, suites };
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
    const target = existing ?? path.join(this.root, relativePathFor(clean));
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

    return { file: path.relative(this.root, target).replace(/\\/g, '/'), changed };
  }

  async remove(id) {
    this.#requireRoot();
    const found = await this.#findById(id);
    if (!found) return { removed: false };
    await fs.unlink(found);
    return { removed: true, file: path.relative(this.root, found).replace(/\\/g, '/') };
  }

  /**
   * Compare what the browser holds against what the repo holds.
   *
   * Deliberately returns the three lists rather than a verdict: the panel says
   * "3 new in repo, 1 not committed" and the human decides. An automatic merge
   * would silently overwrite whichever side the tool guessed was older, and the
   * loser is always somebody's unsaved work.
   */
  async status(local = []) {
    this.#requireRoot();
    const { flows } = await this.list();
    const byId = new Map(flows.filter((f) => f.id).map((f) => [f.id, f]));
    const localById = new Map(local.filter((f) => f.id).map((f) => [f.id, f]));

    const onlyInRepo = [];
    const onlyLocal = [];
    const differing = [];

    for (const [id, remote] of byId) {
      const mine = localById.get(id);
      if (!mine) onlyInRepo.push(remote);
      else if (mine.hash && mine.hash !== remote.hash) differing.push({ id, name: remote.name });
    }
    for (const [id, mine] of localById) {
      if (!byId.has(id)) onlyLocal.push({ id, name: mine.name });
    }

    return { onlyInRepo, onlyLocal, differing, total: flows.length };
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

/** Every *.flow.json and suites/*.json under the root. Missing root is empty. */
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
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await walk(full, out);
    } else if (entry.name.endsWith(FLOW_SUFFIX) || entry.name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}
