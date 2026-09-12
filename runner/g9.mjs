#!/usr/bin/env node
/**
 * `g9` — run recorded flows with no agent and no QA present.
 *
 * ## What this is for
 *
 * The side panel can already replay a flow, and an agent can already drive one.
 * Neither is a thing you can put in Task Scheduler. This is: one command, a
 * standard exit code, and a report directory.
 *
 * It speaks MCP to a bridge it spawns itself — the same interface an agent uses.
 * That is deliberate. The runner can do nothing an agent could not do, so every
 * boundary the extension enforces (pinned mode, the Stop button, cookie scope)
 * still applies to an unattended run.
 *
 * ## The port rule, which is the thing that actually bites
 *
 * The extension connects to exactly ONE bridge, on the port configured in its
 * side panel. If an editor's MCP client already holds 8765, this runner cannot
 * have it — and the extension is talking to that other bridge anyway. So the
 * unattended arrangement is a SECOND browser profile with its own copy of the
 * extension carrying `dev-bridge.json`, exactly as `setup/isolated-livetest.mjs`
 * builds one. `--port` selects that bridge. Running against the developer's own
 * browser is supported for convenience and is not the mode to schedule.
 *
 * ## Exit codes
 *
 *   0  everything passed (warnings allowed)
 *   1  a product failure — an assertion or an oracle failed
 *   2  an automation failure — the test broke, not the product
 *   3  a confirmed surprise — the flow did something it has never done
 *   4  the runner could not run at all (no extension, no flows, bad arguments)
 *
 * Separating 1 from 2 is the point of the whole classification: a pipeline that
 * treats a rotted locator as a product regression trains people to ignore it.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { McpClient } from './mcp-client.mjs';
import { writeReports } from './report.mjs';
// The extension's own comparison logic, imported directly. It is a plain ES module with no browser
// APIs, so the runner can reuse it rather than growing a second implementation that drifts.
import { calibrateVolatile } from '../extension/lib/signature.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'bridge', 'src', 'server.js');

const EXIT = { OK: 0, PRODUCT: 1, AUTOMATION: 2, SURPRISE: 3, RUNNER: 4 };

// ------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) { options._.push(token); continue; }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) options[key] = true;
    else { options[key] = next; i++; }
  }
  return { command, options };
}

const HELP = `
g9 — run recorded G9 flows without an agent

  g9 list                              what flows exist
  g9 run <target> [options]            replay one flow, a suite, a tag, or all
  g9 calibrate <flowId>                run twice on one build; mark what differs as noise
  g9 approve <flowId>                  fold the last run into the approved known world
  g9 spec <flowId> [--out file.json]   export a canonical, Git-diffable FlowSpec
  g9 ab <flowId> --a <url> --b <url>   run the same flow against two builds and diff them

Targets for "run":
  <flowId>            one recording, by id
  suite:<name>        every recording in a suite
  tag:<name>          every recording carrying a tag
  all                 everything

Options:
  --env <name>          environment label recorded in the report
  --data <file.json>    variables substituted into {{placeholders}}
  --report <dir>        where to write run.json / junit.xml / report.html
  --timing <mode>       recorded (default) | adaptive | fast
  --signature <mode>    lite (default) | full | off
  --pin <file.har>      serve the network from a HAR; any difference is then the client's
  --strict-pin          fail requests the HAR does not contain
  --seed                seed the known world when a flow has none yet
  --no-compare          skip the known-world comparison (produces a reference run)
  --port <n>            bridge port; must match the extension's side-panel port
  --token <secret>      G9_TOKEN, if the bridge is configured with one
  --project <file>      project adapter (default: ./g9.project.json if present)
  --platform <name>     web (default) or agripad — agripad drives a real device over adb
  --device <serial>     which device, when adb sees more than one (agripad only)
  --fail-on <verdict>   lowest verdict that makes the exit code non-zero
                        (warning | surprise | failure — default: surprise)
  --quiet               only the summary line

Options for "ab":
  --a <url>             the reference build (usually what is already released)
  --b <url>             the candidate build
  --timing <mode>       as for "run"
`;

// ------------------------------------------------------------- project config

/**
 * The one place a project may teach the runner about itself.
 *
 * The extension stays entirely generic; the knowledge lives here, in the
 * consumer's repo, as data. That boundary is the reason this tool can be used
 * on the next project without being untangled from this one first.
 */
/**
 * Find and read `g9.project.json`.
 *
 * Why it searches upward instead of only looking in the working directory.
 *
 * The config lives at the repository root, but nobody runs the runner from
 * there reliably — QA runs it from the tool folder, CI runs it from a job
 * directory, an editor runs it from wherever the file being edited lives.
 * A cwd-only lookup silently returned `null` in every one of those cases, the
 * flows directory then fell back to a cwd-relative default, and the run failed
 * with "No AgriPad flows found under <a path that never existed>". The flows
 * were fine; only the search was wrong.
 *
 * So: walk up to the filesystem root, the way git finds `.git`, npm finds
 * `package.json`, and tsc finds `tsconfig.json`. Callers get `dir` back too,
 * because every relative path in the file must resolve against the file's own
 * location — resolving them against the cwd is the same bug wearing a hat.
 */
async function loadProject(file) {
  if (file) {
    const explicit = path.resolve(file);
    try {
      return { ...JSON.parse(await readFile(explicit, 'utf8')), dir: path.dirname(explicit) };
    } catch (err) {
      throw new Error(`Could not read project file ${explicit}: ${err.message}`);
    }
  }

  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, 'g9.project.json');
    try {
      return { ...JSON.parse(await readFile(candidate, 'utf8')), dir };
    } catch (err) {
      // A malformed file at the right place is a real error, not a reason to
      // keep climbing and then blame a missing file three directories up.
      if (err.code !== 'ENOENT') {
        throw new Error(`Could not read project file ${candidate}: ${err.message}`);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The flow library root, resolved against the project file rather than the cwd. */
function flowsRoot(project) {
  const configured = project?.flowsDir ?? 'QA/Flows';
  return path.resolve(project?.dir ?? process.cwd(), configured);
}

// -------------------------------------------------------------------- run

/**
 * Is some OTHER live bridge holding the extension?
 *
 * Reads the same registry the bridges write to. Best effort by design: a missing or malformed
 * registry means we simply fall back to the generic advice rather than failing the run twice.
 */
async function occupiedByAnotherBridge() {
  try {
    const { list } = await import('../bridge/src/registry.js');
    return list().find((entry) => entry.extensionConnected && entry.pid !== process.pid) ?? null;
  } catch {
    return null;
  }
}

async function connect(options) {
  const env = {};
  if (options.port) env.G9_PORT = String(options.port);
  if (options.token) env.G9_TOKEN = String(options.token);

  const client = new McpClient(SERVER, env);
  await client.initialize();

  const status = await client.call('browser_status', {}).catch((err) => ({ error: String(err.message ?? err) }));
  if (status.error || status.connected === false || status.extension === 'disconnected') {
    client.close();

    // Name the common cause instead of listing every possible one.
    //
    // A bridge owns its WebSocket port exclusively, so when an editor or MCP client is already
    // running one, the extension is attached THERE and the bridge this run just started sits on a
    // different port with nothing connected to it. That is by far the most frequent way this error
    // appears, and the generic "is the browser running?" text sends people to check three things
    // that are all fine. The registry knows exactly which bridge has the extension, so say so.
    const holder = await occupiedByAnotherBridge();

    throw new Error(
      'The G9 extension is not connected to this bridge.\n' +
      `  port:    ${options.port ?? 8765}\n` +
      (holder
        ? `\n  The extension is attached to a DIFFERENT bridge: port ${holder.port}, pid ${holder.pid}` +
          `${holder.version ? `, v${holder.version}` : ''}.\n` +
          '  One bridge owns the port at a time, so this run started its own and nothing joined it.\n' +
          '  Either close the editor / MCP client that owns that bridge and run again, or give this\n' +
          '  run its own browser profile with setup/isolated-livetest.mjs.\n'
        : '  Check:   is the browser running, is the extension enabled, and does its side panel show this port?\n' +
          '  For unattended runs, use a dedicated browser profile whose extension copy carries dev-bridge.json\n' +
          '  (setup/isolated-livetest.mjs builds exactly that).\n') +
      (status.error ? `  bridge:  ${status.error}\n` : ''),
    );
  }
  if (status.halted) {
    client.close();
    throw new Error('Stop is engaged in the side panel. Nothing will run until somebody presses Resume — by design.');
  }
  return { client, status };
}

/**
 * Run a suite against a real AgriPad device over the cable.
 *
 * ## Why this is a separate function and not a branch inside the browser path
 *
 * They share almost nothing operationally. There is no bridge, no extension, no tab, no HAR to
 * pin, no console to read. What they DO share is the flow format, the five verdicts and the report
 * — and those are shared through data, not through a common code path. Threading a device through
 * the browser runner's plumbing would have meant `if (device)` in a dozen places, which is how a
 * second platform quietly degrades the first.
 *
 * ## Flows come from disk here, not from a browser profile
 *
 * The web path lists recordings out of `chrome.storage.local`. A device flow has no browser to
 * live in, so `QA/Flows/agripad/**` IS the library. That is also the direction the web path is
 * moving — the repo is the source of truth and the browser is a cache of it.
 */
async function commandRunAgriPad({ options, project, reportDir, target }) {
  const { AgriPadDriver, listDevices } = await import('./drivers/agripad.mjs');

  const devices = await listDevices();
  const usable = devices.filter((d) => d.state === 'device');
  if (!usable.length) {
    const detail = devices.length
      ? `adb sees ${devices.length} device(s) but none is ready: ` +
        devices.map((d) => `${d.serial} (${d.state})`).join(', ') +
        '. "unauthorized" means the tablet is showing a permission dialog — accept it.'
      : 'adb sees no devices. Check the cable and that USB debugging is on.';
    throw new Error(detail);
  }

  const serial = options.device === true ? null : (options.device ?? (usable.length === 1 ? usable[0].serial : null));
  if (!serial) {
    throw new Error(
      `${usable.length} devices are connected, so there is no unambiguous target: ` +
        usable.map((d) => `${d.serial}${d.model ? ` (${d.model})` : ''}`).join(', ') +
        '. Name one with --device <serial>.',
    );
  }

  const driver = new AgriPadDriver({
    serial,
    port: Number(options.port) || 8799,
    token: options.token === true ? '' : (options.token ?? ''),
    log: (message) => log(options, `  ${message}`),
  });

  const flows = await loadDeviceFlows(project, target);
  log(options, `${flows.length} flow(s) to run on ${serial}\n`);

  const run = {
    format: 'g9/run',
    version: 1,
    platform: 'maui',
    // Labelled honestly. Actuating a control's own command proves the command works; it does not
    // prove a finger could have reached the control, and a report that does not say so invites
    // exactly that reading.
    fidelity: 'gray-box',
    device: serial,
    startedAt: Date.now(),
    environment: options.env ?? project?.defaultEnvironment ?? null,
    suite: target,
    pinned: false,
    flows: [],
  };

  const ready = await driver.connect();
  run.deviceInfo = ready.hello;
  await driver.acquire();

  try {
    for (const flow of flows) {
      const started = Date.now();
      log(options, `▶ ${flow.name} (${flow.id})`);
      const steps = [];
      let failed = 0;

      for (const [index, step] of (flow.steps ?? []).entries()) {
        let outcome;
        try {
          outcome = await driver.step(step);
        } catch (err) {
          outcome = { ok: false, error: String(err.message ?? err) };
        }
        steps.push({ step: index + 1, id: step.id, action: step.action, ...outcome });
        if (!outcome.ok) {
          failed += 1;
          log(options, `  ✗ step ${index + 1} (${step.action}): ${outcome.error}`);
          break; // stop on first failure: later steps run against a state nobody intended
        }
      }

      const passed = steps.filter((s) => s.ok).length;
      run.flows.push({
        id: flow.id,
        name: flow.name,
        verdict: verdictForDevice(steps, failed),
        total: flow.steps?.length ?? 0,
        passed,
        failed,
        durationMs: Date.now() - started,
        steps,
        qaTestCaseIds: flow.qaTestCaseIds ?? [],
      });
      log(options, `  ${failed ? '✗' : '✓'} ${passed}/${flow.steps?.length ?? 0}\n`);
    }
  } finally {
    // Always release. A crashed runner that keeps a lease locks the device until the TTL expires,
    // and the next person's first command is refused for a reason they cannot see.
    await driver.release();
  }

  run.finishedAt = Date.now();
  // The web path sets this and the summary line reads it; without it the device
  // path printed "NaNs". A summary that prints NaN is a summary people stop
  // reading, and it was one assignment away from being right.
  run.durationMs = run.finishedAt - run.startedAt;
  const code = exitCodeFor(run, options['fail-on'] ?? 'surprise');
  await writeReports(reportDir, run);
  summarize(run, reportDir, code);
  return code;
}

/**
 * A device failure is a TEST failure only when the harness could not find the control.
 *
 * The same distinction the browser path makes, and for the same reason: a pipeline that reports a
 * renamed automation id as a product regression teaches people to ignore it.
 */
/**
 * Which device failures are the harness's fault rather than the product's.
 *
 * This is the same rule `AUTOMATION_FAILURE_PATTERNS` states for the browser
 * (extension/tools/replay.js) and `AutomationFailurePhrases` states for the
 * server: a message that describes the HARNESS or the ENVIRONMENT — a control
 * that could not be addressed, a command this bridge does not have, a device
 * that never answered, a readiness gate that never opened — is FAIL_AUTOMATION.
 * A message about something the app DID and did wrongly is FAIL_PRODUCT.
 *
 * It used to be four alternations inline, and the gap showed up the first time a
 * real device hit it: a background `GET /api/NewAuth` token refresh was still in
 * flight when the flow started, quiescence timed out with "still busy: …", and
 * the run was filed as FAIL_PRODUCT. `app.busy` reported `idle: true` seconds
 * later and the identical suite passed. Nothing was wrong with the product; a
 * readiness gate declining to proceed is that gate WORKING, which is exactly the
 * case the browser list calls out by name.
 *
 * Three copies of one rule is a defect in itself — three chances to drift, and
 * this is the drift. Keep them in step when any of them changes.
 */
const DEVICE_AUTOMATION_FAILURES = [
  // Control identity — the recorded automation ids no longer address anything.
  /not found/i,
  /automationId/i,
  /no such/i,
  /could not find/i,
  /no visible control/i,

  // Commands this bridge cannot perform at all.
  /not supported/i,
  /unknown command/i,

  // The device was never reachable. Environment, never product.
  /did not answer/i,
  /has not granted live access/i,
  /is offline/i,

  // Readiness gates that never opened. The gate doing its job is not a defect.
  /still busy/i,
  /timed out/i,
  /budget and was stopped/i,
];

function verdictForDevice(steps, failed) {
  if (!failed) return 'PASS';
  const bad = steps.find((s) => !s.ok);
  const message = bad?.error ?? '';
  return DEVICE_AUTOMATION_FAILURES.some((pattern) => pattern.test(message))
    ? 'FAIL_AUTOMATION'
    : 'FAIL_PRODUCT';
}

/** Read `QA/Flows/agripad/**` off disk and apply the same target grammar the web path uses. */
async function loadDeviceFlows(project, target) {
  const root = flowsRoot(project);
  const files = await collectJson(path.join(root, 'agripad'));
  const flows = [];

  for (const file of files) {
    try {
      flows.push(JSON.parse(await readFile(file, 'utf8')));
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${err.message}`);
    }
  }

  if (!flows.length) {
    throw new Error(
      `No AgriPad flows found under ${path.join(root, 'agripad')}. Record one, or check flowsDir in g9.project.json.`,
    );
  }

  if (!target || target === 'all') return flows;
  if (target.startsWith('suite:')) {
    const name = target.slice(6);
    const suite = await readSuite(root, name);
    const chosen = suite ? applySelect(flows, suite.select ?? {}) : flows.filter((f) => f.suite === name);
    return requireSelection(chosen, target, flows, suite);
  }
  if (target.startsWith('tag:')) {
    const tag = target.slice(4);
    return requireSelection(flows.filter((f) => (f.tags ?? []).includes(tag)), target, flows, null);
  }
  const matched = flows.filter((f) => f.id === target || f.name === target);
  if (!matched.length) {
    throw new Error(
      `Nothing matched "${target}". Known AgriPad flows:\n` +
        flows.map((f) => `  ${f.id}  ${f.name}`).join('\n'),
    );
  }
  return matched;
}

async function readSuite(root, name) {
  for (const candidate of [`${name}.json`, `agripad.${name}.json`]) {
    try {
      return JSON.parse(await readFile(path.join(root, 'suites', candidate), 'utf8'));
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

/**
 * Refuse a run that selected nothing.
 *
 * Why this is an error and not "0 flows, PASS".
 *
 * An empty selection is indistinguishable, in every report this runner writes,
 * from a suite whose flows all passed: `failed` is 0, the verdict is PASS and
 * the exit code is 0. Wire that to a release gate and the gate is green forever
 * — loudest exactly when someone renames a tag, points at the wrong flows
 * directory, or defines a suite before recording anything for it. A suite that
 * matches nothing is a broken suite, and the only safe report is a refusal that
 * says which selector emptied it.
 */
function requireSelection(chosen, target, all, suite) {
  if (chosen.length) return chosen;

  const criteria = suite?.select
    ? Object.entries(suite.select)
        .map(([k, v]) => `    ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\n')
    : target.startsWith('tag:')
      ? `    tag: ${target.slice(4)}`
      : '    (matched on the flow\'s own suite field)';

  throw new Error(
    `"${target}" selected 0 of ${all.length} flow(s), so there is nothing to run.\n` +
      `A suite that matches nothing reports PASS, which is why this is an error instead.\n` +
      `  selection:\n${criteria}\n` +
      `  available:\n` +
      all
        .slice(0, 20)
        .map((f) => `    ${f.id}  [${(f.tags ?? []).join(' ') || 'no tags'}]`)
        .join('\n') +
      (all.length > 20 ? `\n    … and ${all.length - 20} more` : ''),
  );
}

function applySelect(flows, select) {
  let chosen = flows;
  if (select.folder) chosen = chosen.filter((f) => (f.folder ?? '').startsWith(select.folder));
  if (select.tags?.length) chosen = chosen.filter((f) => select.tags.every((t) => (f.tags ?? []).includes(t)));
  if (select.excludeTags?.length) {
    chosen = chosen.filter((f) => !select.excludeTags.some((t) => (f.tags ?? []).includes(t)));
  }
  if (select.ids?.length) chosen = chosen.filter((f) => select.ids.includes(f.id));
  return chosen;
}

async function collectJson(dir, out = []) {
  const { readdir } = await import('node:fs/promises');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectJson(full, out);
    else if (entry.name.endsWith('.flow.json')) out.push(full);
  }
  return out;
}

async function resolveFlows(client, target, project) {
  const { recordings = [] } = await client.call('browser_recording', { action: 'list' });
  if (!recordings.length) throw new Error('There are no recordings in this browser profile.');

  if (!target || target === 'all') return recordings;
  if (target.startsWith('suite:')) {
    const name = target.slice(6);
    // A suite is a query on both platforms or on neither. Before this, the device path read
    // QA/Flows/suites/*.json and applied `select`, while the web path only matched a literal
    // `suite` field on the recording — so the same suite id meant two different things
    // depending on which platform ran it.
    const suite = project ? await readSuite(flowsRoot(project), name) : null;
    const chosen = suite
      ? applySelect(recordings, suite.select ?? {})
      : recordings.filter((r) => r.suite === name);
    return requireSelection(chosen, target, recordings, suite);
  }
  if (target.startsWith('tag:')) {
    const tag = target.slice(4);
    return requireSelection(
      recordings.filter((r) => (r.tags ?? []).includes(tag)), target, recordings, null,
    );
  }
  const byId = recordings.filter((r) => r.id === target);
  if (byId.length) return byId;
  const byName = recordings.filter((r) => r.name === target);
  if (byName.length) return byName;

  throw new Error(
    `Nothing matched "${target}". Known flows:\n` +
      recordings.map((r) => `  ${r.id}  ${r.name}${r.suite ? `  [suite:${r.suite}]` : ''}`).join('\n'),
  );
}

async function commandRun({ options }) {
  const target = options._[0] ?? 'all';
  const project = await loadProject(options.project === true ? undefined : options.project);
  const variables = options.data ? JSON.parse(await readFile(options.data, 'utf8')) : {};
  const reportDir = path.resolve(options.report === true || !options.report ? './g9-artifacts' : options.report);

  // Two platforms, one report. The browser path talks to the extension through the bridge; the
  // AgriPad path talks to a device over `adb forward` and never touches a browser at all. They
  // share the flow format, the verdicts and the artefacts — which is the whole reason FlowSpec
  // carries `target.kind` rather than assuming the web.
  if ((options.platform ?? 'web') === 'agripad') {
    return commandRunAgriPad({ options, project, reportDir, target });
  }

  const { client } = await connect(options);
  const run = {
    format: 'g9/run',
    version: 1,
    startedAt: Date.now(),
    environment: options.env ?? project?.defaultEnvironment ?? null,
    suite: target,
    pinned: false,
    flows: [],
  };

  try {
    if (options.pin) {
      const har = JSON.parse(await readFile(options.pin, 'utf8'));
      const pinned = await client.call('browser_network', {
        action: 'pin', har, strict: options['strict-pin'] === true,
      });
      run.pinned = true;
      run.pinDetail = pinned;
      log(options, `network pinned: ${pinned.operations} operations, ${pinned.responses} recorded responses`);
    }

    const flows = await resolveFlows(client, target, project);
    log(options, `${flows.length} flow(s) to run\n`);

    for (const entry of flows) {
      const started = Date.now();
      log(options, `▶ ${entry.name} (${entry.id})`);
      let result;
      try {
        result = await client.call('browser_recording', {
          action: 'replay',
          id: entry.id,
          timing: options.timing ?? 'recorded',
          signature: options.signature ?? 'lite',
          compare: options['no-compare'] !== true,
          seedKnownWorld: options.seed === true,
          stopOnFailure: true,
          variables,
        }, 600_000);
      } catch (err) {
        result = {
          id: entry.id, name: entry.name, verdict: 'ERROR', total: 0, passed: 0, failed: 1,
          durationMs: Date.now() - started, steps: [],
          failureMessage: String(err.message ?? err),
        };
      }

      const failing = (result.steps ?? []).find((step) => !step.ok);
      run.flows.push({
        ...result,
        qaTestCaseIds: entry.qaTestCaseIds ?? [],
        tags: entry.tags ?? [],
        suite: entry.suite ?? null,
        failureMessage: result.failureMessage ?? failing?.error ?? null,
        detail: failing ? `step ${failing.step} (${failing.type}): ${failing.error}` : null,
      });

      log(options, `  ${verdictLine(result)}\n`);
    }

    if (run.pinned) await client.call('browser_network', { action: 'unpin' }).catch(() => {});
  } finally {
    client.close();
  }

  run.durationMs = Date.now() - run.startedAt;
  await writeReports(reportDir, run);

  const code = exitCodeFor(run, options['fail-on'] ?? 'surprise');
  summarize(run, reportDir, code);
  return code;
}

function verdictLine(result) {
  const bits = [`${result.verdict ?? 'ERROR'}`, `${result.passed ?? 0}/${result.total ?? 0} steps`];
  if (result.surprises?.length) {
    const fails = result.surprises.filter((s) => s.effectiveSeverity === 'fail').length;
    bits.push(`${result.surprises.length} surprise(s)${fails ? `, ${fails} at failure level` : ''}`);
  }
  if (result.warnings?.length) bits.push(`${result.warnings.length} warning(s)`);
  if (result.knownWorld && !result.knownWorld.runs) bits.push('no known world — run with --seed once');
  return bits.join(' · ');
}

/**
 * The exit code, and the reason it is configurable.
 *
 * A team adopting this will not want a brand-new surprise detector blocking
 * their pipeline on day one — they want to watch it for a fortnight first. So
 * `--fail-on failure` keeps the gate where it was, and moving to
 * `--fail-on surprise` is a decision somebody makes deliberately once they
 * trust it.
 */
function exitCodeFor(run, failOn) {
  const has = (verdict) => run.flows.some((flow) => flow.verdict === verdict);
  if (has('FAIL_PRODUCT') || has('ERROR')) return EXIT.PRODUCT;
  if (has('FAIL_AUTOMATION')) return EXIT.AUTOMATION;
  if (failOn !== 'failure' && has('SURPRISE')) return EXIT.SURPRISE;
  if (failOn === 'warning' && has('PASS_WITH_WARNING')) return EXIT.SURPRISE;
  return EXIT.OK;
}

function summarize(run, reportDir, code) {
  const counts = run.flows.reduce((acc, f) => { acc[f.verdict] = (acc[f.verdict] ?? 0) + 1; return acc; }, {});
  const parts = Object.entries(counts).map(([verdict, n]) => `${verdict}=${n}`).join(' ');
  console.log(`\n${parts || 'nothing ran'}  ·  ${Math.round(run.durationMs / 100) / 10}s  ·  exit ${code}`);
  console.log(`reports: ${reportDir}`);
}

// ------------------------------------------------------------ other commands

async function commandList({ options }) {
  const { client } = await connect(options);
  try {
    const { recordings } = await client.call('browser_recording', { action: 'list' });
    if (!recordings.length) { console.log('No recordings.'); return EXIT.OK; }
    for (const r of recordings) {
      const bits = [r.id, r.name];
      if (r.suite) bits.push(`suite:${r.suite}`);
      if (r.tags?.length) bits.push(r.tags.map((t) => `#${t}`).join(' '));
      bits.push(`${r.stepCount} steps`);
      if (r.flaky?.detected) bits.push('FLAKY');
      console.log(bits.join('  ·  '));
    }
    return EXIT.OK;
  } finally { client.close(); }
}

async function commandCalibrate({ options }) {
  const id = requireTarget(options, 'calibrate');
  const { client } = await connect(options);
  try {
    const result = await client.call('browser_recording', {
      action: 'calibrate', id, timing: options.timing ?? 'recorded',
    }, 900_000);
    console.log(`${result.volatileKeys} volatile item(s) recorded.`);
    console.log(result.note);
    for (const key of result.volatile ?? []) console.log(`  · ${key}`);
    return EXIT.OK;
  } finally { client.close(); }
}

async function commandApprove({ options }) {
  const id = requireTarget(options, 'approve');
  const { client } = await connect(options);
  try {
    const result = await client.call('browser_recording', {
      action: 'approve', id, by: options.by ?? 'runner', note: options.note === true ? null : options.note,
    });
    console.log(
      `Known world for ${id}: ${result.runs} approved run(s), ` +
      `${result.networkOperations} network operations, ${result.consoleSignatures} console signatures, ` +
      `${result.steps} steps, ${result.volatileKeys} volatile.`,
    );
    return EXIT.OK;
  } finally { client.close(); }
}

/**
 * A/B shadow run: the same flow against two builds, diffed against each other.
 *
 * ## Why this exists alongside the known world
 *
 * An approved baseline answers "has this flow changed since somebody last blessed it". In a product
 * that ships several times a week, that baseline goes stale between blessings and the answer drifts
 * towards "yes, lots, and nobody remembers which parts were fine".
 *
 * A/B asks a sharper question: **what does THIS build do differently from THAT one, right now.**
 * Both sides run minutes apart on the same machine, same browser, same data, so almost everything
 * that would otherwise be noise cancels out, and what is left is attributable to the build.
 *
 * ## Why it reuses `calibrateVolatile`
 *
 * Calibration already answers "what differed between two runs of the same flow" — it was written
 * for two runs of the SAME build, to find noise. Point it at two different builds and the identical
 * computation answers "what changed", because the only thing that varies is which side is supposed
 * to be identical. One implementation, two readings.
 *
 * ## The honest caveat
 *
 * This finds differences, not regressions. A deliberate feature and a defect look the same from
 * here, and only a human can say which is which — so the output is a diff to read, and the exit
 * code stays 0 unless a side actually failed to run.
 */
async function commandAb({ options }) {
  const id = requireTarget(options, 'ab');
  const urlA = options.a;
  const urlB = options.b;
  if (!urlA || !urlB || urlA === true || urlB === true) {
    throw new Error('g9 ab needs --a <url> and --b <url>: the two builds to compare.');
  }

  const { client } = await connect(options);
  try {
    const runSide = async (label, url) => {
      log(options, `▶ ${label}: ${url}`);
      await client.call('browser_navigate', { action: 'goto', url, waitUntil: 'load' });
      const run = await client.call('browser_recording', {
        action: 'replay', id, timing: options.timing ?? 'recorded',
        signature: 'full', compare: false, stopOnFailure: false,
      }, 600_000);
      const signature = await client.call('browser_recording', { action: 'signature', id });
      log(options, `  ${run.verdict} · ${run.passed}/${run.total} steps`);
      return { run, signature };
    };

    const a = await runSide('A (reference)', urlA);
    const b = await runSide('B (candidate)', urlB);

    const differences = calibrateVolatile(a.signature, b.signature);

    console.log('');
    if (!differences.length) {
      console.log('No observable difference between the two builds for this flow.');
    } else {
      console.log(`${differences.length} difference(s) between A and B:`);
      for (const key of differences) console.log(`  · ${key}`);
      console.log('');
      console.log('These are DIFFERENCES, not verdicts — a shipped feature and a regression look the');
      console.log('same from here. Read them, then decide.');
    }

    if (options.report && options.report !== true) {
      const dir = path.resolve(options.report);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'ab.json'), `${JSON.stringify({
        flowId: id, a: { url: urlA, verdict: a.run.verdict }, b: { url: urlB, verdict: b.run.verdict },
        differences,
      }, null, 2)}
`, 'utf8');
      console.log(`
wrote ${path.join(dir, 'ab.json')}`);
    }

    // A difference is information, not a failure. Only a side that could not run is an error.
    const brokeA = a.run.verdict === 'FAIL_AUTOMATION' || a.run.verdict === 'ERROR';
    const brokeB = b.run.verdict === 'FAIL_AUTOMATION' || b.run.verdict === 'ERROR';
    return brokeA || brokeB ? EXIT.AUTOMATION : EXIT.OK;
  } finally {
    client.close();
  }
}

async function commandSpec({ options }) {
  const id = requireTarget(options, 'spec');
  const { client } = await connect(options);
  try {
    const result = await client.call('browser_recording', { action: 'export_spec', id });
    if (options.out && options.out !== true) {
      await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
      await writeFile(path.resolve(options.out), result.json, 'utf8');
      console.log(`Wrote ${path.resolve(options.out)}`);
    } else {
      process.stdout.write(result.json);
    }
    return EXIT.OK;
  } finally { client.close(); }
}

function requireTarget(options, command) {
  const id = options._[0];
  if (!id) throw new Error(`g9 ${command} needs a flow id. Run "g9 list" to see them.`);
  return id;
}

function log(options, message) {
  if (options.quiet !== true) console.log(message);
}

// ------------------------------------------------------------------- entry

const { command, options } = parseArgs(process.argv.slice(2));

const COMMANDS = {
  run: commandRun,
  list: commandList,
  calibrate: commandCalibrate,
  approve: commandApprove,
  spec: commandSpec,
  ab: commandAb,
};

if (command === 'help' || options.help) {
  console.log(HELP);
  process.exit(EXIT.OK);
}

const handler = COMMANDS[command];
if (!handler) {
  console.error(`Unknown command "${command}".`);
  console.log(HELP);
  process.exit(EXIT.RUNNER);
}

try {
  process.exitCode = await handler({ options });
} catch (err) {
  console.error(`\n${err.message ?? err}`);
  process.exitCode = EXIT.RUNNER;
}
