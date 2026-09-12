/**
 * The project adapter — everything the tool knows about the app under test.
 *
 * ## Why this is a file in YOUR repo, not configuration in ours
 *
 * The extension is deliberately product-agnostic: it sees a browser, never
 * whether the page behind it is ASP.NET, React or PHP. That is what lets one
 * copy of this tool serve every project on the machine. But automation needs
 * product knowledge — which domains are ours, which requests are the same
 * operation, which button must never be clicked by an exploratory run.
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
 *      it. Set this in `.mcp.json` when the launch directory is unpredictable.
 *   2. A walk up from `process.cwd()`. MCP clients launch the bridge with the
 *      project directory as the working directory, so this is the common case
 *      and needs no configuration at all.
 *   3. Nothing. An absent adapter is NOT an error — the tool still works, it
 *      just knows nothing about the product, and Workspace mode degrades to
 *      Pinned rather than attaching to everything.
 *
 * That last rule is the important one. An empty allowlist must never mean
 * "everything is allowed"; that is the silent-failure shape this whole codebase
 * is written against.
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
 * `project?.workspaceDomains ?? []` in five places will forget it in a sixth.
 */
export function emptyProject() {
  return {
    found: false,
    path: null,
    root: null,
    defaultEnvironment: null,
    environments: {},
    workspaceDomains: [],
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
export function findProjectFile(startDir = process.cwd()) {
  const fromEnv = process.env.G9_PROJECT;
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
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
 * the whole bridge down — it must produce a tool that still works and a
 * message the user can act on. `problems` is surfaced in `browser_status`.
 */
export function loadProject(startDir = process.cwd()) {
  const project = emptyProject();
  const file = findProjectFile(startDir);
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

  project.workspaceDomains = normaliseDomains(raw.workspaceDomains, project.problems);

  // A found adapter that declares no workspace domains is worth saying out
  // loud: the user probably expected Workspace mode to work and it will not.
  // A list of ["*"] is not that case — it is a decision, and warning about it
  // would train people to ignore this channel.
  if (!project.workspaceDomains.length) {
    project.problems.push(
      `${PROJECT_FILENAME} declares no "workspaceDomains", so Workspace mode has no allowlist and ` +
        `falls back to Pinned. Add the domains of the app under test, e.g. ["*.example.com", "localhost:5173"].`,
    );
  }

  return project;
}

/**
 * Domain patterns, validated hard.
 *
 * Only three shapes are accepted, and everything else is refused by name:
 *
 *   "example.com"        exact host
 *   "*.example.com"      host and any subdomain
 *   "localhost:5173"     host with an explicit port
 *
 * plus one more that is not a host at all:
 *
 *   "*"                  every host, and every scheme the debugger can attach to
 *
 * Paths and regular expressions are deliberately NOT supported. This list
 * decides which tabs an agent may touch without being asked; a pattern language
 * rich enough to be subtly wrong is the wrong tool for that job. A rejected
 * entry is reported, never silently dropped — a silently dropped allowlist
 * entry reads exactly like "the tool ignored my tab".
 */
export function normaliseDomains(value, problems = []) {
  const out = [];
  for (const entry of arr(value)) {
    if (typeof entry !== 'string') {
      problems.push(`workspaceDomains entry ${JSON.stringify(entry)} is not a string — ignored.`);
      continue;
    }
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) continue;

    // The explicit everything-grant, accepted before any host-shaped rule can
    // reject it for not looking like a host. It does not, and that is the point.
    //
    // This check has to be here and not only in the extension: the bridge is
    // what hands the list over, so a "*" dropped here arrives as an EMPTY list,
    // which the extension correctly reads as "deny everything". The config would
    // then mean the exact opposite of what it says — the worst possible failure
    // for a line whose whole job is to say who may do what.
    if (trimmed === '*') {
      out.push('*');
      continue;
    }

    if (/^https?:\/\//.test(trimmed)) {
      problems.push(
        `workspaceDomains entry "${entry}" looks like a URL. Use the host only, e.g. ` +
          `"${safeHost(trimmed) ?? 'example.com'}".`,
      );
      continue;
    }
    if (trimmed.includes('/')) {
      problems.push(`workspaceDomains entry "${entry}" contains a path. Only hosts are matched — ignored.`);
      continue;
    }
    if (!/^(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/.test(trimmed)) {
      problems.push(`workspaceDomains entry "${entry}" is not a host pattern — ignored.`);
      continue;
    }
    if (trimmed === '*' || trimmed === '*.') {
      problems.push(`workspaceDomains entry "${entry}" would match every site. Refused.`);
      continue;
    }
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * What the extension needs, and nothing more.
 *
 * The adapter can carry report sinks, secret names and aliases the browser has
 * no business knowing. This is the projection that crosses the WebSocket.
 */
export function projectForExtension(project) {
  return {
    found: project.found,
    path: project.path,
    root: project.root,
    workspaceDomains: project.workspaceDomains,
    environments: project.environments,
    defaultEnvironment: project.defaultEnvironment,
    destructiveActions: project.destructiveActions,
    flowsDir: project.flowsDir,
    problems: project.problems,
  };
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
