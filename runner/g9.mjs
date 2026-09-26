#!/usr/bin/env node
/**
 * `g9` — run recorded flows with no agent and no QA present.
 *
 * ## What this is for
 *
 * The side panel can replay a flow, and an agent can drive one. Neither is a
 * thing you can put in Task Scheduler. This is: one command, a standard exit
 * code, and a report directory.
 *
 * It speaks MCP through `mcp/shim.mjs` — the same shim an agent uses — to the
 * one G9 daemon on this machine. That is deliberate: the runner can do nothing
 * an agent could not do, so ownership, the Stop button and every refusal apply
 * to an unattended run exactly as to an agent.
 *
 * ## v2: the port rule is gone
 *
 * v1 needed a second browser profile with its own extension copy, because the
 * extension talked to exactly one bridge and an editor usually held it. In v2
 * any number of clients share one daemon, and by default the runner does not
 * touch the person's browser at all: `--engine launched` (the default) runs in a
 * browser the daemon launches (headless unless `--headed`), with its own
 * profile — unaffected by a minimised window, a locked screen or someone
 * working in their own browser meanwhile. `--port` only says where the daemon is.
 *
 * Flows come from the repository: the FlowSpec files under the project's flow
 * library (g9.project.json → flowsDir, default QA/Flows) are imported into the
 * launched engine's store before they run — the repo is the source of truth, the
 * store a cache of it (the known world and run history stay in the store).
 *
 * ## Exit codes
 *
 *   0  everything passed (warnings allowed)
 *   1  a product failure — an assertion or an oracle failed
 *   2  an automation failure — the test broke, not the product
 *   3  a confirmed surprise — the flow did something it has never done
 *   4  the runner could not run at all (no engine, no flows, bad arguments)
 *
 * Separating 1 from 2 is the point of the whole classification: a pipeline that
 * treats a rotted locator as a product regression trains people to ignore it.
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { McpClient } from './mcp-client.mjs';
import { writeReports } from './report.mjs';
// The extension's own comparison and FlowSpec logic, imported directly. They are
// plain ES modules with no browser APIs, so the runner reuses them rather than
// growing a second implementation that drifts.
import { calibrateVolatile } from '../extension/lib/signature.js';
import { validateFlowSpec } from '../extension/lib/flowspec.js';

const EXIT = { OK: 0, PRODUCT: 1, AUTOMATION: 2, SURPRISE: 3, RUNNER: 4 };

// ------------------------------------------------------------------- CLI

/** Flags that never take a value, so `--headed suite:smoke` does not swallow the target. */
const BOOLEAN_FLAGS = new Set(['seed', 'no-compare', 'strict-pin', 'quiet', 'headless', 'headed', 'help', 'keep-engine']);

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) { options._.push(token); continue; }
    const eq = token.indexOf('=');
    const key = eq > 2 ? token.slice(2, eq) : token.slice(2);
    if (eq > 2) { options[key] = token.slice(eq + 1); continue; }
    if (BOOLEAN_FLAGS.has(key)) { options[key] = true; continue; }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) options[key] = true;
    else { options[key] = next; i++; }
  }
  return { command, options };
}

const HELP = `
g9 — run recorded G9 flows without an agent

  g9 list                              what flows exist (repository and browser stores)
  g9 run <target> [options]            replay one flow, a suite, a tag, or all
  g9 calibrate <flowId>                run twice on one build; mark what differs as noise
  g9 approve <flowId>                  fold the last run into the approved known world
  g9 spec <flowId> [--out file.json]   export a canonical, Git-diffable FlowSpec
  g9 ab <flowId> --a <url> --b <url>   run the same flow against two builds and diff them

Targets for "run":
  <flowId>            one flow, by id (or name); a bare suite name also works
  suite:<name>        every flow a suite selects (QA/Flows/suites/<name>.json)
  tag:<name>          every flow carrying a tag
  all                 everything

Engine:
  --engine <e>          launched (default): a browser the daemon launches, headless,
                        own profile — unaffected by the desktop. extension: the tab
                        the person's own browser has current (flows from its store).
  --browser <b>         auto | edge | chrome | cft (default: the daemon's defaultBrowser setting)
  --headless / --headed launched engine window mode (default: settings, normally headless)
  --profile <name>      launched engine profile (default "automation"; warm it once
                        with the desktop app or browser_engine action:"warm")
  --humanize <level>    off | human | stealth | <calibrated profile>
  --humanize-seed <n>   reproduce a run's exact motion (the report records every seed)
  --stealth <level>     off | human | stealth (launched engine)
  --keep-engine         leave an engine this run launched running afterwards
  --port <n>            the G9 daemon's port (default: G9_PORT, else 8765)

Run options:
  --env <name>          environment label recorded in the report
  --data <file.json>    variables substituted into {{placeholders}}
  --report <dir>        where to write run.json / junit.xml / report.html
  --timing <mode>       recorded (default) | adaptive | fast
  --signature <mode>    lite (default) | full | off
  --pin <file.har>      serve the network from a HAR; any difference is then the client's
  --strict-pin          fail requests the HAR does not contain
  --seed                seed the known world when a flow has none yet
  --no-compare          skip the known-world comparison (produces a reference run)
  --project <file>      project adapter (default: nearest g9.project.json upwards)
  --platform <name>     web (default) or agripad — agripad drives a real device over adb
  --device <serial>     which device, when adb sees more than one (agripad only)
  --device-port <n>     the device automation port (agripad only; default 8799)
  --token <t>           the device automation token, when the device requires one (agripad only)
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
 * Find and read `g9.project.json`.
 *
 * Why it searches upward instead of only looking in the working directory:
 * the config lives at the repository root, but nobody runs the runner from
 * there reliably — QA runs it from the tool folder, CI from a job directory, an
 * editor from wherever the file being edited lives. A cwd-only lookup silently
 * returned `null` in every one of those cases, the flows directory then fell
 * back to a cwd-relative default, and the run failed with "No AgriPad flows
 * found under <a path that never existed>". So: walk up to the filesystem root,
 * the way git finds `.git`. Callers get `dir` back too, because every relative
 * path in the file must resolve against the file's own location.
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

// ------------------------------------------------------------- connecting

async function connect(options) {
  const env = {};
  if (options.port && options.port !== true) env.G9_PORT = String(options.port);
  const client = new McpClient({ env, name: 'g9-runner' });
  try {
    await client.initialize();
  } catch (err) {
    client.close();
    throw new Error(`The G9 MCP shim did not start: ${err.message}`);
  }

  let status;
  try {
    status = await client.call('browser_status', {});
  } catch (err) {
    client.close();
    // The shim's message already names the cause (a v1 bridge on the port, a
    // daemon that could not start) — pass it through rather than guess.
    throw new Error(`G9 is not reachable.\n  ${String(err.message ?? err).replace(/^browser_status: /, '')}`);
  }
  if (status.halted?.global || status.halted?.mine) {
    client.close();
    throw new Error('Stop is engaged (side panel or desktop app). Nothing will run until somebody presses Resume — by design.');
  }
  return { client, status };
}

function engineChoice(options) {
  const engine = options.engine === true || options.engine == null ? 'launched' : String(options.engine);
  if (!['launched', 'extension'].includes(engine)) throw new Error(`--engine must be "launched" or "extension" (got "${engine}").`);
  return engine;
}

/**
 * The launched engine this run uses: an engine already running on the same
 * profile is reused (a profile can be open in one browser at a time anyway);
 * otherwise one is launched with the run's options.
 *
 * Either way the run HOLDS it (a lease: browser_engine action:"acquire", or
 * launch lease:true) and RELEASES it at the end — it never stops it itself. The
 * daemon stops an engine launched for a run once every run using it has let go
 * and no agent owns a tab there. Two overlapping scheduled suites on one
 * profile used to break each other: the run that launched the engine stopped it
 * at its end, either between the other run's flows (every remaining flow failed
 * with 'Unknown engine') or not at all, silently (daemon review, 2026-09-22).
 */
async function ensureLaunchedEngine(client, options) {
  const profile = options.profile && options.profile !== true ? String(options.profile) : 'automation';
  // Another client (an agent's first "open") may be launching this very profile
  // right now; the daemon refuses a second launch of one profile, so wait for
  // that one to come up and reuse it instead of failing the run.
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      return await ensureLaunchedEngineOnce(client, options, profile);
    } catch (err) {
      // (or finished launching between our list and our launch: the next list finds it)
      if ((err.listAgain !== true && !/being launched right now|is already in use by launched-/.test(String(err.message))) || Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

async function ensureLaunchedEngineOnce(client, options, profile) {
  const { engines = [] } = await client.call('browser_engine', { action: 'list' });
  const running = engines.find((e) => e.kind === 'launched' && e.profile === profile);
  if (running) {
    const mismatch = [];
    if (options.headed && running.headless) mismatch.push('it is headless but --headed was asked');
    if (options.headless && running.headless === false) mismatch.push('it is headed but --headless was asked');
    if (options.browser && options.browser !== true && options.browser !== 'auto' && running.browser !== options.browser) {
      mismatch.push(`it is ${running.browser}, not ${options.browser}`);
    }
    if (mismatch.length) {
      throw new Error(
        `Launched engine ${running.engineId} already uses profile "${profile}" but ${mismatch.join(' and ')}. ` +
          'Stop it (browser_engine action:"stop"), or run with another --profile.',
      );
    }
    let leased = false;
    try {
      await client.call('browser_engine', { action: 'acquire', engineId: running.engineId });
      leased = true;
    } catch (err) {
      // An engine that stopped between the list and the hold: the caller lists again.
      if (/No launched engine|Unknown engine"/.test(String(err.message))) throw Object.assign(new Error(err.message), { listAgain: true });
      if (!/Unknown engine action/.test(String(err.message))) throw err;
    }
    return { info: running, launchedHere: false, leased };
  }
  const launchArgs = { action: 'launch', profile };
  if (options.browser && options.browser !== true) launchArgs.browser = String(options.browser);
  if (options.headed) launchArgs.headless = false;
  else if (options.headless) launchArgs.headless = true;
  if (options.stealth && options.stealth !== true) launchArgs.stealth = String(options.stealth);
  if (options.humanize && options.humanize !== true) launchArgs.humanize = String(options.humanize);
  launchArgs.name = 'g9 runner';
  // Held for this run; stopped by the daemon once every run holding it has released it — unless
  // --keep-engine asked for it to stay.
  launchArgs.lease = true;
  launchArgs.stopWhenReleased = options['keep-engine'] !== true;
  const info = await client.call('browser_engine', launchArgs, 240_000);
  return { info, launchedHere: true, leased: !!info?.lease };
}

/**
 * The end of a run's use of its engine: release the hold (the daemon stops the engine when it was
 * launched for runs and nobody else holds it). A refused or failed release is LOGGED, never
 * swallowed. Against a daemon without leases, the old rule: stop what this run launched.
 */
async function releaseEngine(client, launched, options) {
  if (!launched?.info?.engineId) return;
  const engineId = launched.info.engineId;
  try {
    if (launched.leased) {
      const r = await client.call('browser_engine', { action: 'release', engineId });
      if (r?.stopped) log(options, `engine: ${engineId} stopped (no other run holds it)`);
      else if (r?.holders?.length) log(options, `engine: ${engineId} left running — still held by ${r.holders.join(', ')}`);
    } else if (launched.launchedHere && options['keep-engine'] !== true) {
      await client.call('browser_engine', { action: 'stop', engineId });
    }
  } catch (err) {
    console.error(`g9: engine ${engineId} was not released: ${String(err.message ?? err)}`);
  }
}

function engineRecord(info, launchedHere) {
  if (!info) return null;
  return {
    engineId: info.engineId,
    kind: info.kind ?? 'launched',
    browser: info.browser ?? null,
    version: info.version ?? null,
    headless: info.headless ?? null,
    profile: info.profile ?? null,
    stealth: info.stealth ?? null,
    humanize: info.humanize ?? null,
    pid: info.pid ?? null,
    launchedByRunner: launchedHere,
  };
}

/** One humanize seed per run: recorded in the report so a failing run replays with identical motion. */
function humanizeFor(options) {
  const level = options.humanize && options.humanize !== true ? String(options.humanize) : null;
  const raw = options['humanize-seed'];
  const seed = raw != null && raw !== true
    ? (Number.isFinite(Number(raw)) ? Number(raw) : String(raw))
    : crypto.randomBytes(4).readUInt32BE(0);
  return { level, seed };
}

// ------------------------------------------------------------- flows on disk

/** Every web FlowSpec file under the flow library (agripad/ and suites/ excluded). */
async function loadDiskFlows(project) {
  if (!project) return [];
  const root = flowsRoot(project);
  const files = await collectJson(root);
  const flows = [];
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (rel.startsWith('agripad/') || rel.startsWith('suites/')) continue;
    let spec;
    try {
      spec = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${err.message}`);
    }
    if (spec?.target?.kind && spec.target.kind !== 'web') continue;
    const problems = validateFlowSpec(spec);
    if (problems.length) throw new Error(`${rel} is not a valid FlowSpec:\n- ${problems.join('\n- ')}`);
    flows.push({ ...spec, file: rel });
  }
  return flows;
}

/** The target grammar (id | name | suite:<n> | tag:<t> | all) over any list of flows. */
async function selectFlows(flows, target, project, label) {
  if (!target || target === 'all') {
    if (!flows.length) throw new Error(`There are no flows ${label}.`);
    return flows;
  }
  if (target.startsWith('suite:')) {
    const name = target.slice(6);
    // A suite is a query on both platforms or on neither — the same suite id
    // must mean the same thing whichever engine runs it.
    const suite = project ? await readSuite(flowsRoot(project), name) : null;
    const chosen = suite ? applySelect(flows, suite.select ?? {}) : flows.filter((f) => f.suite === name);
    return requireSelection(chosen, target, flows, suite);
  }
  if (target.startsWith('tag:')) {
    const tag = target.slice(4);
    return requireSelection(flows.filter((f) => (f.tags ?? []).includes(tag)), target, flows, null);
  }
  const byId = flows.filter((f) => f.id === target);
  if (byId.length) return byId;
  const byName = flows.filter((f) => f.name === target);
  if (byName.length) return byName;
  // A bare suite name ("smoke") — what the desktop's Schedule form sends: a
  // flow id or name wins, then a suite of that name. Never an empty selection.
  const suite = project ? await readSuite(flowsRoot(project), target) : null;
  const bySuite = suite ? applySelect(flows, suite.select ?? {}) : flows.filter((f) => f.suite === target);
  if (bySuite.length) return bySuite;
  throw new Error(
    `Nothing matched "${target}". Known flows ${label}:\n` +
      (flows.map((f) => `  ${f.id}  ${f.name}${f.suite ? `  [suite:${f.suite}]` : ''}`).join('\n') || '  (none)'),
  );
}

// -------------------------------------------------------------------- run

async function commandRun({ options }) {
  const target = options._[0] ?? 'all';
  const project = await loadProject(options.project === true ? undefined : options.project);
  const variables = options.data ? JSON.parse(await readFile(options.data, 'utf8')) : {};
  const reportDir = path.resolve(options.report === true || !options.report ? './g9-artifacts' : options.report);

  // Two platforms, one report. The browser path talks to the daemon through the
  // shim; the AgriPad path talks to a device over `adb forward` and never
  // touches a browser at all. They share the flow format, the verdicts and the
  // artefacts — which is why FlowSpec carries `target.kind`.
  if ((options.platform ?? 'web') === 'agripad') {
    return commandRunAgriPad({ options, project, reportDir, target });
  }

  const engine = engineChoice(options);
  const humanize = humanizeFor(options);
  const { client, status } = await connect(options);
  const run = {
    format: 'g9/run',
    version: 1,
    startedAt: Date.now(),
    environment: options.env ?? project?.defaultEnvironment ?? null,
    suite: target,
    pinned: false,
    daemon: { version: status.daemon?.version ?? null, port: status.daemon?.port ?? null },
    humanize,
    engine: null,
    flows: [],
  };

  let launched = null;
  try {
    const har = options.pin ? JSON.parse(await readFile(options.pin, 'utf8')) : null;
    if (engine === 'launched') {
      launched = await ensureLaunchedEngine(client, options);
      run.engine = engineRecord(launched.info, launched.launchedHere);
      log(options, `engine: ${run.engine.engineId} — ${run.engine.browser} ${run.engine.version ?? ''} ` +
        `(${run.engine.headless ? 'headless' : 'headed'}, profile ${run.engine.profile}${launched.launchedHere ? ', launched for this run' : ', reused'})`);
      const engine = {
        id: launched.info.engineId,
        // The engine went away mid-run (stopped by someone, crashed): get one again, once per loss,
        // instead of failing every remaining flow with 'Unknown engine'.
        again: async () => {
          await releaseEngine(client, launched, options);
          launched = await ensureLaunchedEngine(client, options);
          engine.id = launched.info.engineId;
          run.engine = { ...engineRecord(launched.info, launched.launchedHere), replaced: run.engine?.engineId ?? null };
          log(options, `engine: continuing on ${engine.id}${launched.launchedHere ? ' (launched again)' : ' (reused)'}`);
          return engine.id;
        },
      };
      await runLaunched({ client, options, project, target, variables, har, run, engine, humanize });
    } else {
      const ext = (status.engines ?? []).find((e) => e.kind === 'extension');
      if (!ext) {
        throw new Error(
          'No extension engine is connected, so --engine extension has nothing to run in. Open the browser with ' +
            'the G9 extension (v2) enabled, or run with the default --engine launched.',
        );
      }
      run.engine = { engineId: ext.engineId, kind: 'extension', browser: ext.browser ?? null, version: ext.version ?? null };
      await runExtension({ client, options, project, target, variables, har, run, humanize });
    }
  } finally {
    await releaseEngine(client, launched, options);
    client.close();
  }

  run.durationMs = Date.now() - run.startedAt;
  await writeReports(reportDir, run);

  const code = exitCodeFor(run, options['fail-on'] ?? 'surprise');
  summarize(run, reportDir, code);
  return code;
}

/**
 * Launched engine: flows from the repository, imported into the launched
 * engine's store (their known world and history there are kept), each run in
 * a fresh tab on its start URL, closed afterwards.
 */
async function runLaunched({ client, options, project, target, variables, har, run, engine, humanize }) {
  const disk = await loadDiskFlows(project);
  let flows;
  let fromDisk = true;
  if (disk.length) {
    flows = await selectFlows(disk, target, project, `in ${flowsRoot(project)}`);
  } else {
    // No flow library (no g9.project.json, or an empty one): run what the
    // stores hold. A recording that only exists in the person's browser is
    // copied to the launched engine by the daemon when it replays.
    fromDisk = false;
    const { recordings = [] } = await client.call('browser_recording', { action: 'list' });
    const unique = [...new Map(recordings.map((r) => [r.id, r])).values()];
    flows = await selectFlows(unique, target, project, 'in the browser stores (no flow library found)');
  }
  log(options, `${flows.length} flow(s) to run${fromDisk ? ' from the repository' : ' from the browser stores'}\n`);

  for (const flow of flows) {
    const started = Date.now();
    log(options, `▶ ${flow.name} (${flow.id})`);
    let result;
    let tabId = null;
    try {
      if (fromDisk) {
        const { file, ...spec } = flow;
        // (3.2) With what a person approved (the known world, the baselines), from the sidecar.
        const side = await readSidecar(project, file);
        await client.call('browser_recording', { action: 'import_spec', spec, id: spec.id, engine: 'launched', ...side });
      }
      let opened;
      try {
        opened = await client.call('browser_tabs', { action: 'open', url: 'about:blank', engine: engine.id });
      } catch (err) {
        if (!/Unknown engine|No launched engine|is stopping/.test(String(err.message)) || !engine.again) throw err;
        log(options, `  engine ${engine.id} is gone (${String(err.message).split('\n')[0]})`);
        await engine.again();
        opened = await client.call('browser_tabs', { action: 'open', url: 'about:blank', engine: engine.id });
      }
      tabId = opened.tabId;
      if (har) {
        const pinned = await client.call('browser_network', { action: 'pin', har, strict: options['strict-pin'] === true, tabId });
        run.pinned = true;
        run.pinDetail ??= pinned;
      }
      const startUrl = flow.startUrl ?? null;
      // timeoutMs is the whole goto's deadline (the server's first byte included — a cold staging server
      // can take longer than the 30 s default); the call budget stays above it.
      if (startUrl) await client.call('browser_navigate', { action: 'goto', url: startUrl, tabId, waitUntil: 'load', timeoutMs: 110_000 }, 140_000);
      result = await client.call('browser_recording', {
        action: 'replay',
        id: flow.id,
        tabId,
        timing: options.timing ?? 'recorded',
        signature: options.signature ?? 'lite',
        compare: options['no-compare'] !== true,
        seedKnownWorld: options.seed === true,
        stopOnFailure: true,
        variables,
        ...(humanize.level ? { humanize: humanize.level } : {}),
        seed: humanize.seed,
      }, 1_900_000);
    } catch (err) {
      result = errorResult(flow, started, err);
    } finally {
      if (tabId != null) await client.call('browser_tabs', { action: 'close', tabId }).catch(() => {});
    }
    pushFlow(run, flow, result, options);
  }
}

/** Extension engine: the v1 path — recordings in the person's browser, replayed on its current tab. */
async function runExtension({ client, options, project, target, variables, har, run, humanize }) {
  if (har) {
    const pinned = await client.call('browser_network', { action: 'pin', har, strict: options['strict-pin'] === true });
    run.pinned = true;
    run.pinDetail = pinned;
    log(options, `network pinned: ${pinned.operations} operations, ${pinned.responses} recorded responses`);
  }
  const { recordings = [] } = await client.call('browser_recording', { action: 'list', engine: 'extension' });
  const flows = await selectFlows(recordings, target, project, 'in this browser profile');
  log(options, `${flows.length} flow(s) to run\n`);

  for (const entry of flows) {
    const started = Date.now();
    log(options, `▶ ${entry.name} (${entry.id})`);
    let result;
    try {
      result = await client.call('browser_recording', {
        action: 'replay',
        id: entry.id,
        engine: 'extension',
        timing: options.timing ?? 'recorded',
        signature: options.signature ?? 'lite',
        compare: options['no-compare'] !== true,
        seedKnownWorld: options.seed === true,
        stopOnFailure: true,
        variables,
        ...(humanize.level ? { humanize: humanize.level } : {}),
        seed: humanize.seed,
      }, 1_900_000);
    } catch (err) {
      result = errorResult(entry, started, err);
    }
    pushFlow(run, entry, result, options);
  }
  if (run.pinned) await client.call('browser_network', { action: 'unpin' }).catch(() => {});
}

function errorResult(flow, started, err) {
  return {
    id: flow.id, name: flow.name, verdict: 'ERROR', total: 0, passed: 0, failed: 1,
    durationMs: Date.now() - started, steps: [],
    failureMessage: String(err.message ?? err),
  };
}

function pushFlow(run, entry, result, options) {
  const failing = (result.steps ?? []).find((step) => !step.ok);
  run.flows.push({
    ...result,
    qaTestCaseIds: entry.qaTestCaseIds ?? [],
    tags: entry.tags ?? [],
    suite: entry.suite ?? null,
    ...(entry.file ? { file: entry.file } : {}),
    failureMessage: result.failureMessage ?? failing?.error ?? null,
    detail: failing ? `step ${failing.step} (${failing.type}): ${failing.error}` : null,
  });
  log(options, `  ${verdictLine(result)}\n`);
}

// -------------------------------------------------------------- AgriPad

/**
 * Run a suite against a real AgriPad device over the cable.
 *
 * ## Why this is a separate function and not a branch inside the browser path
 *
 * They share almost nothing operationally. There is no daemon, no extension, no tab, no HAR to
 * pin, no console to read. What they DO share is the flow format, the five verdicts and the report
 * — and those are shared through data, not through a common code path. Threading a device through
 * the browser runner's plumbing would have meant `if (device)` in a dozen places, which is how a
 * second platform quietly degrades the first.
 *
 * ## Flows come from disk here, not from a browser profile
 *
 * A device flow has no browser to live in, so `QA/Flows/agripad/**` IS the library.
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
    // `--device-port` is the v2 name; `--port` is still honoured here because in
    // v1 it meant the device port on this path.
    port: Number(options['device-port'] ?? options.port) || 8799,
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
  if (select.platform) chosen = chosen.filter((f) => (f.platform ?? f.target?.kind ?? 'web') === select.platform);
  if (select.folder) chosen = chosen.filter((f) => (f.folder ?? '').startsWith(select.folder));
  if (select.suite) chosen = chosen.filter((f) => f.suite === select.suite);
  if (select.tags?.length) chosen = chosen.filter((f) => select.tags.every((t) => (f.tags ?? []).includes(t)));
  if (select.anyTags?.length) chosen = chosen.filter((f) => select.anyTags.some((t) => (f.tags ?? []).includes(t)));
  if (select.excludeTags?.length) {
    chosen = chosen.filter((f) => !select.excludeTags.some((t) => (f.tags ?? []).includes(t)));
  }
  if (select.ids?.length) chosen = chosen.filter((f) => select.ids.includes(f.id));
  return chosen;
}

/**
 * (3.2) A flow file's sidecar (daemon/flows.js): `login.approved.json` and `login.baselines/*.png`
 * beside `login.flow.json`. `{}` when there is none — the launched store then keeps the baselines
 * and known world it already has (extension/lib/flowsync.js importFlow).
 */
async function readSidecar(project, relFile) {
  if (!relFile || !relFile.endsWith('.flow.json')) return {};
  const base = path.join(flowsRoot(project), relFile.slice(0, -'.flow.json'.length));
  let approved;
  try {
    approved = JSON.parse(await readFile(`${base}.approved.json`, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw new Error(`${relFile.replace(/\.flow\.json$/, '.approved.json')} is not valid JSON: ${err.message}`);
  }
  const images = {};
  for (const b of Object.values(approved?.baselines ?? {})) {
    if (!b?.image || !/^[\w.-]{1,80}\.png$/.test(b.image)) continue;
    try { images[b.image] = (await readFile(path.join(`${base}.baselines`, b.image))).toString('base64'); } catch { /* the fingerprint still compares */ }
  }
  return { approved, images };
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
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await collectJson(full, out);
    } else if (entry.name.endsWith('.flow.json')) out.push(full);
  }
  return out;
}

// ------------------------------------------------------------ verdicts, summary

function verdictLine(result) {
  const bits = [`${result.verdict ?? 'ERROR'}`, `${result.passed ?? 0}/${result.total ?? 0} steps`];
  if (result.surprises?.length) {
    const fails = result.surprises.filter((s) => s.effectiveSeverity === 'fail').length;
    bits.push(`${result.surprises.length} surprise(s)${fails ? `, ${fails} at failure level` : ''}`);
  }
  if (result.warnings?.length) bits.push(`${result.warnings.length} warning(s)`);
  if (result.knownWorld && !result.knownWorld.runs) bits.push('no known world — run with --seed once');
  if (result.failureMessage && result.verdict === 'ERROR') bits.push(result.failureMessage.split('\n')[0].slice(0, 160));
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
  if (run.humanize?.seed != null) console.log(`humanize seed: ${run.humanize.seed} (pass --humanize-seed ${run.humanize.seed} to reproduce the motion)`);
  console.log(`reports: ${reportDir}`);
}

// ------------------------------------------------------------ other commands

async function commandList({ options }) {
  const project = await loadProject(options.project === true ? undefined : options.project);
  const disk = await loadDiskFlows(project).catch((err) => {
    console.log(`flow library: ${err.message}`);
    return [];
  });
  if (disk.length) {
    console.log(`Repository (${flowsRoot(project)}):`);
    for (const f of disk) console.log(`  ${[f.id, f.name, f.suite ? `suite:${f.suite}` : null, f.tags?.length ? f.tags.map((t) => `#${t}`).join(' ') : null, `${(f.steps ?? []).length} steps`].filter(Boolean).join('  ·  ')}`);
    console.log('');
  }
  const { client } = await connect(options);
  try {
    const { recordings = [], problems } = await client.call('browser_recording', { action: 'list' });
    if (!recordings.length && !disk.length) { console.log('No flows.'); return EXIT.OK; }
    if (recordings.length) console.log('Browser stores:');
    for (const r of recordings) {
      const bits = [r.id, r.name, r.engine ? `[${r.engine}]` : null];
      if (r.suite) bits.push(`suite:${r.suite}`);
      if (r.tags?.length) bits.push(r.tags.map((t) => `#${t}`).join(' '));
      bits.push(`${r.stepCount} steps`);
      if (r.flaky?.detected) bits.push('FLAKY');
      console.log(`  ${bits.filter(Boolean).join('  ·  ')}`);
    }
    for (const p of problems ?? []) console.log(`  (store unavailable: ${p})`);
    return EXIT.OK;
  } finally { client.close(); }
}

/**
 * A tab to run a flow in, for commands that need one. Launched: a fresh tab on
 * the flow's start URL in the run's engine (the flow imported from the
 * repository first, when it is there). Extension: the current tab.
 */
async function flowTab(client, options, id, { url = null } = {}) {
  if (engineChoice(options) === 'extension') return { tabId: null, engine: null, close: async () => {} };
  const launched = await ensureLaunchedEngine(client, options);
  const project = await loadProject(options.project === true ? undefined : options.project).catch(() => null);
  const disk = await loadDiskFlows(project).catch(() => []);
  const spec = disk.find((f) => f.id === id);
  if (spec) {
    const { file, ...clean } = spec;
    const side = await readSidecar(project, file);
    await client.call('browser_recording', { action: 'import_spec', spec: clean, id: clean.id, engine: 'launched', ...side });
  }
  const start = url ?? spec?.startUrl ?? (await client.call('browser_recording', { action: 'get', id, engine: 'launched' }).catch(() => null))?.startUrl ?? 'about:blank';
  const opened = await client.call('browser_tabs', { action: 'open', url: start, engine: launched.info.engineId });
  return {
    tabId: opened.tabId,
    engine: launched,
    close: async () => {
      await client.call('browser_tabs', { action: 'close', tabId: opened.tabId }).catch(() => {});
      await releaseEngine(client, launched, options);
    },
  };
}

async function commandCalibrate({ options }) {
  const id = requireTarget(options, 'calibrate');
  const { client } = await connect(options);
  let tab = null;
  try {
    tab = await flowTab(client, options, id);
    const result = await client.call('browser_recording', {
      action: 'calibrate', id, timing: options.timing ?? 'recorded',
      ...(tab.tabId != null ? { tabId: tab.tabId } : {}),
    }, 1_900_000);
    console.log(`${result.volatileKeys} volatile item(s) recorded.`);
    console.log(result.note);
    for (const key of result.volatile ?? []) console.log(`  · ${key}`);
    return EXIT.OK;
  } finally {
    await tab?.close();
    client.close();
  }
}

async function commandApprove({ options }) {
  const id = requireTarget(options, 'approve');
  const { client } = await connect(options);
  try {
    const result = await client.call('browser_recording', {
      action: 'approve', id, engine: engineChoice(options), by: options.by ?? 'runner', note: options.note === true ? null : options.note,
    });
    console.log(
      `Known world for ${id} (${result.engine ?? engineChoice(options)} store): ${result.runs} approved run(s), ` +
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
  const launched = engineChoice(options) === 'launched';
  const store = launched ? 'launched' : 'extension';
  try {
    const runSide = async (label, url) => {
      log(options, `▶ ${label}: ${url}`);
      const tab = launched ? await flowTab(client, options, id, { url }) : null;
      try {
        if (!launched) await client.call('browser_navigate', { action: 'goto', url, waitUntil: 'load' });
        const run = await client.call('browser_recording', {
          action: 'replay', id, timing: options.timing ?? 'recorded',
          signature: 'full', compare: false, stopOnFailure: false,
          ...(tab ? { tabId: tab.tabId } : { engine: 'extension' }),
        }, 1_900_000);
        const signature = await client.call('browser_recording', { action: 'signature', id, engine: store });
        log(options, `  ${run.verdict} · ${run.passed}/${run.total} steps`);
        return { run, signature };
      } finally {
        await tab?.close();
      }
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
      }, null, 2)}\n`, 'utf8');
      console.log(`\nwrote ${path.join(dir, 'ab.json')}`);
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
    const args = { action: 'export_spec', id, includeImages: true };
    if (options.engine && options.engine !== true) args.engine = engineChoice(options);
    const result = await client.call('browser_recording', args);
    if (options.out && options.out !== true) {
      const out = path.resolve(options.out);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, result.json, 'utf8');
      console.log(`Wrote ${out}`);
      // (3.2) What a person approved goes beside it, the way the flow library writes it:
      // login.flow.json → login.approved.json and login.baselines/<step>.png.
      if (result.approved && out.endsWith('.flow.json')) {
        const base = out.slice(0, -'.flow.json'.length);
        const { approvedJson } = await import('../extension/lib/approved.js');
        await writeFile(`${base}.approved.json`, approvedJson(result.approved), 'utf8');
        const names = Object.keys(result.images ?? {}).filter((n) => /^[\w.-]{1,80}\.png$/.test(n));
        if (names.length) await mkdir(`${base}.baselines`, { recursive: true });
        for (const name of names) await writeFile(path.join(`${base}.baselines`, name), Buffer.from(result.images[name], 'base64'));
        console.log(`Wrote ${base}.approved.json${names.length ? ` and ${names.length} baseline image(s)` : ''}`);
      }
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

const COMMANDS = {
  run: commandRun,
  list: commandList,
  calibrate: commandCalibrate,
  approve: commandApprove,
  spec: commandSpec,
  ab: commandAb,
};

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'help' || options.help) {
    console.log(HELP);
    return EXIT.OK;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command "${command}".`);
    console.log(HELP);
    return EXIT.RUNNER;
  }
  try {
    return await handler({ options });
  } catch (err) {
    console.error(`\n${err.message ?? err}`);
    return EXIT.RUNNER;
  }
}

process.exitCode = await main();
