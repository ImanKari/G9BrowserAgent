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
async function loadProject(file) {
  const candidate = file ?? path.resolve(process.cwd(), 'g9.project.json');
  try {
    return JSON.parse(await readFile(candidate, 'utf8'));
  } catch (err) {
    if (file) throw new Error(`Could not read project file ${candidate}: ${err.message}`);
    return null;
  }
}

// -------------------------------------------------------------------- run

async function connect(options) {
  const env = {};
  if (options.port) env.G9_PORT = String(options.port);
  if (options.token) env.G9_TOKEN = String(options.token);

  const client = new McpClient(SERVER, env);
  await client.initialize();

  const status = await client.call('browser_status', {}).catch((err) => ({ error: String(err.message ?? err) }));
  if (status.error || status.connected === false || status.extension === 'disconnected') {
    client.close();
    throw new Error(
      'The G9 extension is not connected to this bridge.\n' +
      `  port:    ${options.port ?? 8765}\n` +
      '  Check:   is the browser running, is the extension enabled, and does its side panel show this port?\n' +
      '  For unattended runs, use a dedicated browser profile whose extension copy carries dev-bridge.json\n' +
      '  (setup/isolated-livetest.mjs builds exactly that).\n' +
      (status.error ? `  bridge:  ${status.error}\n` : ''),
    );
  }
  if (status.halted) {
    client.close();
    throw new Error('Stop is engaged in the side panel. Nothing will run until somebody presses Resume — by design.');
  }
  return { client, status };
}

async function resolveFlows(client, target) {
  const { recordings = [] } = await client.call('browser_recording', { action: 'list' });
  if (!recordings.length) throw new Error('There are no recordings in this browser profile.');

  if (!target || target === 'all') return recordings;
  if (target.startsWith('suite:')) {
    const suite = target.slice(6);
    return recordings.filter((r) => r.suite === suite);
  }
  if (target.startsWith('tag:')) {
    const tag = target.slice(4);
    return recordings.filter((r) => (r.tags ?? []).includes(tag));
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

    const flows = await resolveFlows(client, target);
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
