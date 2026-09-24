/**
 * The project adapter — everything the tool knows about the app under test.
 *
 * Moved from `bridge/src/project.js`. Unchanged in behaviour except one field:
 * `workspaceDomains` no longer matters. v2 has no modes and no allowlist (plan
 * D6/D7): attach means full access, so an adapter that still lists domains is
 * simply not consulted for them, and an adapter WITHOUT them is no longer a
 * problem worth reporting. The old warning ("Workspace mode will fall back to
 * Pinned") would now describe a mode that does not exist.
 *
 * ## Why this is a file in YOUR repo, not configuration in ours
 *
 * The extension is deliberately product-agnostic: it sees a browser, never
 * whether the page behind it is ASP.NET, React or PHP. That is what lets one
 * copy of this tool serve every project on the machine. But automation needs
 * product knowledge — which requests are the same operation, which button must
 * never be clicked by an exploratory run, where the flow library lives.
 *
 * So the knowledge lives as DATA in the project's own repository
 * (`g9.project.json`), and the tool reads it. Nothing product-specific is ever
 * hard-coded here.
 *
 * ## Finding it
 *
 * In order, first hit wins:
 *
 *   1. `G9_PROJECT` — an explicit path to the file or to the directory holding
 *      it. Set this in the MCP config when the launch directory is unpredictable.
 *   2. A walk up from the start directory. MCP clients launch the shim with the
 *      project directory as the working directory; the shim tells the daemon
 *      that directory in its hello, so each agent gets ITS project even though
 *      one daemon serves them all.
 *   3. Nothing. An absent adapter is NOT an error — the tool still works, it
 *      just knows nothing about the product and has no flow library.
 */

import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_FILENAME = 'g9.project.json';

/** How far up from cwd we are willing to look. Deep enough for a monorepo. */
const MAX_WALK_UP = 8;

/**
 * A project that knows nothing, which is a valid state.
 *
 * Every consumer must work with this object, so the shape is always complete
 * and never partially undefined. A caller that has to write
 * `project?.environments ?? {}` in five places will forget it in a sixth.
 */
export function emptyProject() {
  return {
    found: false,
    path: null,
    root: null,
    defaultEnvironment: null,
    environments: {},
    urlNormalizers: [],
    secretRefs: [],
    volatile: [],
    operationAliases: {},
    destructiveActions: [],
    reportSink: null,
    flowsDir: null,
    problems: [],
  };
}

/** Locate `g9.project.json`, or return null. */
export function findProjectFile(startDir = process.cwd(), { explicit = process.env.G9_PROJECT } = {}) {
  if (explicit) {
    const resolved = path.resolve(explicit);
    try {
      const stat = fs.statSync(resolved);
      const file = stat.isDirectory() ? path.join(resolved, PROJECT_FILENAME) : resolved;
      if (fs.existsSync(file)) return file;
    } catch {
      /* fall through to the walk — a bad G9_PROJECT should not be fatal */
    }
  }

  let dir = path.resolve(startDir);
  for (let i = 0; i < MAX_WALK_UP; i += 1) {
    const candidate = path.join(dir, PROJECT_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Read and normalise the adapter.
 *
 * Problems are collected rather than thrown. A typo in one field must not take
 * the whole daemon down — it must produce a tool that still works and a
 * message the user can act on. `problems` is surfaced in `browser_status`.
 */
export function loadProject(startDir = process.cwd(), options = {}) {
  const project = emptyProject();
  const file = findProjectFile(startDir, options);
  if (!file) return project;

  project.path = file.replace(/\\/g, '/');
  project.root = path.dirname(file).replace(/\\/g, '/');

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    project.problems.push(`${PROJECT_FILENAME} is not valid JSON: ${err.message}`);
    return project;
  }

  project.found = true;
  project.defaultEnvironment = str(raw.defaultEnvironment);
  project.environments = obj(raw.environments);
  project.urlNormalizers = arr(raw.urlNormalizers);
  project.secretRefs = arr(raw.secretRefs).filter((s) => typeof s === 'string');
  project.volatile = arr(raw.volatile).filter((s) => typeof s === 'string');
  project.operationAliases = obj(raw.operationAliases);
  project.destructiveActions = arr(raw.destructiveActions).filter((s) => typeof s === 'string');
  project.reportSink = raw.reportSink ?? null;

  // Where the flow library lives, relative to the adapter. Defaults to QA/Flows
  // because that is where the convention puts it; overridable for repos that
  // organise differently.
  const flowsRel = str(raw.flowsDir) ?? 'QA/Flows';
  project.flowsDir = path.resolve(project.root, flowsRel).replace(/\\/g, '/');

  return project;
}

/**
 * What crosses the WebSocket to a client, and nothing more.
 *
 * The adapter can carry report sinks, secret names and aliases the browser has
 * no business knowing. This is the projection sent in `welcome`.
 */
export function projectForClient(project) {
  return {
    found: project.found,
    path: project.path,
    root: project.root,
    environments: project.environments,
    defaultEnvironment: project.defaultEnvironment,
    destructiveActions: project.destructiveActions,
    flowsDir: project.flowsDir,
    problems: project.problems,
  };
}

/** v1 name, kept for any caller that still uses it. */
export const projectForExtension = projectForClient;

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
