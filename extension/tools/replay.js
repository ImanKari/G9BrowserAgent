/**
 * Replaying a recording, and explaining it when it fails.
 *
 * The failure message is the product here. A test that says "step 4 failed" has
 * told the QA nothing they did not already know; the work is in saying which
 * element, what it looked for, what it found instead, and what that implies.
 *
 * ## Waiting is not sleeping
 *
 * Recordings carry the wall-clock gap between steps, because a session's rhythm
 * is part of what it reproduces. But replaying a gap as `sleep(waitMs)` is the
 * single reason recorded tests are famous for flaking: the gap that was enough
 * on the QA's machine is not enough on a loaded CI box, and is far too long
 * everywhere else.
 *
 * So the gap is a **budget**, not a duration. Each step polls for its element
 * to exist and be actionable, and proceeds the moment it is. `timing: "fast"`
 * shrinks the budget, `"recorded"` also honours the original pause once the
 * element is ready — for pages whose behaviour genuinely depends on pacing —
 * and `"adaptive"` (the default) waits only as long as it must.
 *
 * ## Degradation is reported before it becomes failure
 *
 * `lib/locators.js` says which locator matched. A step that used to match on
 * `testid` and now matches on `xpath` still passes, and is one refactor from
 * not passing. Replay collects those as warnings, so a recording tells you it
 * is rotting before the morning it breaks.
 *
 * ## Input level and seed (v2)
 *
 * A replay runs every step at one input level (`humanize`: the call's
 * argument, else the recording's own `humanize`, else the engine default) and
 * from one RUN seed. Step n acts with the seed `<runSeed>:s<n>`, so the run's
 * whole motion is reproduced by passing the reported `humanizeSeed` back. A
 * failure that only happens with one particular pointer path is then a
 * failure you can watch again.
 */

import { send } from '../lib/cdp.js';
// Every page read and every piece of bookkeeping replay leaves in the page
// (the resolved target, the settle box, the event proofs) lives in G9BrowserAgent's
// isolated world: the page never sees __g9target or __g9ReplayProof.
import { inWorld, callInWorld } from '../lib/world.js';
import { levelFor, nextSeed } from '../lib/humanize.js';
import { LOCATOR_SOURCE } from '../lib/locators.js';
import { getRecording, saveRecording } from '../lib/store.js';
import { withPrivateRefs } from '../lib/refs.js';
import * as interact from './interact.js';
import * as nav from './navigate.js';
import { setReplaying } from './record.js';
import { broadcast } from '../lib/state.js';
import { executeAssertion, substitute, summarizeAssertion } from './qa.js';
import { snapshot } from './snapshot.js';
import * as observe from './observe.js';
import {
  buildSignature, detectSurprises, classifySurprises, mergeKnownWorld,
  calibrateVolatile, emptyKnownWorld, describeSurprise,
  envKeyOf, knownWorldFor, withKnownWorld, renormalizeKnownWorld,
} from '../lib/signature.js';
import { DEFAULT_SENSITIVITY } from '../lib/flowspec.js';

/** Two consecutive identical boxes is the cheapest proof an element has settled. */
const POLL_MS = 120;
/** Even a zero-gap step gets this long to become ready. */
const MIN_WAIT_MS = 2000;

/** Locator kinds that mean the page still identifies this element well. */
const HEALTHY_MATCH = new Set(['testid', 'role', 'label']);

/**
 * How the recorded gap between steps is spent.
 *
 * `budget` multiplies it into how long we are willing to WAIT for the page to
 * be ready. `honourPause` decides whether to also sit out the remainder once it
 * is ready.
 *
 * "recorded" is the default, and that is a change from the first version, which
 * defaulted to running as fast as the page allowed. A ten-second session
 * replayed in 200ms is not the same test: it never gives a debounce a chance to
 * fire, an animation a chance to finish, or an autosave a chance to race. The
 * QA's pace is part of what they were testing, and speed is the thing you opt
 * into once you trust the flow — not the thing you get by surprise.
 */
const TIMING = {
  fast: { budget: 0.1, honourPause: false },
  adaptive: { budget: 1, honourPause: false },
  recorded: { budget: 1.5, honourPause: true },
};

/**
 * How much of the run's own behaviour is recorded for the surprise detector.
 *
 * `lite` is the default because an accessibility tree is the single most
 * expensive thing this file can ask for, and taking one after every step of a
 * forty-step flow doubles the run for evidence nobody reads. Assertion steps
 * and the final step are where the flow claims something is true, so those are
 * where the UI shape is worth keeping.
 */
const SIGNATURE_MODES = {
  off: { network: false, console: false, ui: 'none' },
  lite: { network: true, console: true, ui: 'checkpoints' },
  full: { network: true, console: true, ui: 'every-step' },
};

export async function replay(tabId, {
  id, timing = 'recorded', stopOnFailure = true, dryRun = false, variables = {},
  signature: signatureMode = 'lite', compare = true, seedKnownWorld = false,
  includeSignature = false, humanize, seed, environment, urlNormalizers,
} = {}) {
  const recording = await getRecording(id);
  if (!recording) throw new Error(`No recording with id "${id}". Call browser_recording action:"list" to see them.`);

  // Which environment's known world this run belongs to (the runner's --env,
  // else the flow's own environment, else the default), and the project's url
  // rules — both arrive as arguments because this module knows no project.
  const envName = envKeyOf(environment ?? recording.environment?.name ?? recording.environment);
  const normalizers = urlNormalizers ?? recording.urlNormalizers ?? [];

  // Resolved once, up front: an unknown profile name fails before step 1, not
  // halfway through a flow.
  const humanizeArg = humanize ?? recording.humanize ?? undefined;
  const runSeed = seed ?? nextSeed(tabId);
  const hz = await levelFor(tabId, { humanize: humanizeArg, seed: runSeed });
  // The resolved profile itself travels to every step, so a calibrated profile
  // chosen by name is the one each action uses.
  const input = { humanize: hz.profile, level: hz.level, runSeed };
  // The run's motion starts from a point fixed by its seed (interact.homePointer): the same seed
  // then reproduces the same paths, whatever the previous run on this tab left behind. Reported
  // as pointerStart; a tab that cannot take input yet (hidden) leaves it to step 1 to say so.
  let pointerStart = null;
  if (!dryRun && hz.level !== 'off') pointerStart = await interact.homePointer(tabId, hz, runSeed).catch(() => null);

  const mode = TIMING[timing] ?? TIMING.adaptive;
  const evidence = SIGNATURE_MODES[signatureMode] ?? SIGNATURE_MODES.lite;
  const sensitivity = { ...DEFAULT_SENSITIVITY, ...(recording.sensitivity ?? {}) };
  const started = Date.now();
  const results = [];
  const warnings = [];
  const data = {
    ...parameterDefaults(recording.parameters),
    ...(recording.environment?.variables ?? {}),
    ...variables,
  };

  await ensureLocators(tabId);
  await setReplaying(tabId, true);

  // Everything already in the buffers belongs to whatever happened before this
  // run started. Recording the watermark rather than clearing the buffers keeps
  // the agent's own view of the page intact — a replay must not destroy the
  // console history somebody is reading.
  const watermark = await captureWatermark(tabId, evidence);

  try {
    for (let i = 0; i < recording.steps.length; i++) {
    const raw = recording.steps[i];
    // Assertions that write evidence need to know which recording owns it.
    const step = substitute({ ...raw, recordingId: recording.id }, data);
    const stepId = raw.id ?? `s${i + 1}`;
    const label = `step ${i + 1}/${recording.steps.length}`;
    const stepStarted = Date.now();

    // Tell whoever is watching, before the step runs rather than after.
    //
    // A replay used to be one message that returned when the whole thing was
    // over. On a 20-step flow that is half a minute of a panel showing nothing,
    // and the first thing a tester asks is whether they actually pressed the
    // button. Announcing the step at its START is what makes the progress bar
    // move while the slow step is still going, which is exactly when somebody is
    // wondering whether it has hung.
    // `broadcast` and not a bespoke sender: it already carries the `__g9`
    // envelope every panel listener filters on, and it already swallows the
    // rejection you get when no panel is open — which is the normal case for an
    // agent-driven run, and must never fail a replay.
    // `stepType`, not `type`: `type` is the envelope's own field and a second
    // one silently overwrote it, so every message went out labelled "click" or
    // "assert" and no listener ever recognised it. The panel showed step 0 for
    // the whole run and nobody could see why — a duplicate key is not an error
    // in JavaScript, it is a quiet last-one-wins.
    broadcast({
      type: 'replayProgress',
      id: recording.id,
      step: i + 1,
      total: recording.steps.length,
      stepType: step.type,
      describe: describeStep(step),
      elapsedMs: Date.now() - started,
    });

    try {
      const outcome = dryRun ? await probe(tabId, step) : await runStep(tabId, step, mode, {
        ...input, seed: `${runSeed}:s${i + 1}`,
      });
      const record = { step: i + 1, id: stepId, type: step.type, ok: true, ms: Date.now() - stepStarted, ...outcome };
      results.push(record);

      // A semantic assertion that passed because a hundred rows merely carried
      // new readings still owes the reader that sentence. Silence here is how a
      // baseline quietly stops testing anything.
      if (outcome.dataChanges) {
        warnings.push(
          `${label} (${describeStep(step)}) passed, but ${outcome.dataChanges} node(s) came back with ` +
            `different numbers — live data, not a structural change` +
            (outcome.dataSample?.length ? `: ${outcome.dataSample.join(' | ')}` : '') + '.',
        );
      }

      if (outcome.matchedBy && !HEALTHY_MATCH.has(outcome.matchedBy)) {
        warnings.push(
          `${label} (${describeStep(step)}) matched only by ${outcome.matchedBy}. ` +
            `Its stable identifiers no longer work, so this step is one refactor from breaking.`,
        );
      }

      await attachEvidence(tabId, record, {
        evidence, watermark,
        wantUi: evidence.ui === 'every-step'
          || (evidence.ui === 'checkpoints' && (step.type === 'assert' || i === recording.steps.length - 1)),
      });
    } catch (err) {
      const record = {
        step: i + 1,
        id: stepId,
        type: step.type,
        ok: false,
        ms: Date.now() - stepStarted,
        error: String(err?.message ?? err),
      };
      results.push(record);
      // A failing step is exactly the one whose surroundings matter, so its
      // evidence is collected even though the run is about to stop.
      await attachEvidence(tabId, record, { evidence, watermark, wantUi: evidence.ui !== 'none' });
      if (stopOnFailure) break;
    }
    }
  } finally {
    await setReplaying(tabId, false);
  }

  // ---- let the page finish reacting to the last step ------------------------
  // Each step's evidence is read right after it. A page that logs an error and fires a failing
  // request a few ms after the LAST step (a save that reports back) had those recorded or not
  // depending on who won the race, so identical runs differed: surprises 3, 3, 2, 3, 3, 3 over six
  // replays of one flow (desktop render check, round 3), and the known world and the Approvals list
  // changed with them. Wait (bounded) until the page is quiet, then give the last step what arrived.
  let settledAfterLastStep = null;
  if (!dryRun && signatureMode !== 'off' && results.length && (evidence.console || evidence.network)) {
    const readActivity = async () => {
      const [log, net, pending] = await Promise.all([
        evidence.console ? observe.consoleLog(tabId, { limit: 0 }).catch(() => null) : null,
        evidence.network ? observe.network(tabId, { limit: 0 }).catch(() => null) : null,
        evidence.network ? observe.network(tabId, { status: 'pending', limit: 0 }).catch(() => null) : null,
      ]);
      return { consoleSeq: log?.lastSeq ?? 0, requests: net?.total ?? 0, pending: pending?.returned ?? 0 };
    };
    const quiet = await awaitQuiet(readActivity);
    const late = await attachLateEvidence(tabId, results.at(-1), { evidence, watermark });
    settledAfterLastStep = { ...quiet, lateConsole: late.console, lateRequests: late.network };
  }

  const failed = results.filter((r) => !r.ok);
  const summary = {
    id: recording.id,
    name: recording.name,
    dryRun,
    timing,
    total: recording.steps.length,
    ran: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    durationMs: Date.now() - started,
    warnings,
    humanize: hz.level === 'off'
      ? { level: 'off' }
      : { level: hz.level, profile: hz.name, ...(hz.raisedFrom ? { raisedFrom: hz.raisedFrom, stealthLevel: hz.stealthLevel } : {}) },
    humanizeSeed: runSeed,
    ...(pointerStart ? { pointerStart } : {}),
    dataParameters: Object.keys(data),
    steps: results.map(publicStep),
    ...(settledAfterLastStep ? { settledAfterLastStep } : {}),
  };

  // ---- settle the evidence ------------------------------------------------
  // Evidence is collected immediately after each step, so a request that had not finished yet was
  // recorded with no status. Excluding those is right (an unfinished request is not an outcome),
  // but leaving it there makes the SAME request look brand-new on the next run, when it happens to
  // complete in time. Re-reading the buffer once at the end gives every request its final status,
  // which is the only status worth comparing. Found live on 2026-09-04.
  if (evidence.network && !dryRun) {
    await settleNetworkEvidence(tabId, results);
  }

  // ---- signature, known world, surprises ---------------------------------
  let runSignature = null;
  let classified = [];
  if (signatureMode !== 'off') {
    runSignature = buildSignature({
      flowId: recording.flowId ?? recording.id,
      environment: envName,
      platform: 'web',
      build: recording.build ?? null,
      normalizers,
      steps: results,
    });

    if (compare) {
      // The stored world's keys are re-normalised with today's url rules, so a
      // rule added after the approval collapses BOTH sides the same way.
      const world = renormalizeKnownWorld(knownWorldFor(recording, envName), normalizers);
      const detection = detectSurprises(world, runSignature, { sensitivity });
      classified = classifySurprises(detection.surprises, recording.surpriseHistory ?? []);

      // ⚠️ BOUNDED. The first live run against a real data-heavy page produced
      // 180+ surprise lines — every row of a site list counted as a new UI node
      // — and a 103,553-character tool result that blew the agent's token
      // budget outright. That is the opposite of the discipline this tool
      // claims elsewhere ("fourteen tools rather than fifty, because
      // definitions are re-sent on every request").
      //
      // The fix is a projection, not a filter: the full classified set stays on
      // `summary.surprises` for the panel and the report, which render locally
      // and pay nothing for volume. What crosses to the agent is ranked —
      // failures first, then warnings, then notes — capped, and told how many
      // it is not seeing. A truncation that hides its own existence would be
      // the same silent-omission bug in a new place.
      const ranked = [...classified].sort(
        (a, b) => SURPRISE_RANK[b.effectiveSeverity ?? 'info'] - SURPRISE_RANK[a.effectiveSeverity ?? 'info'],
      );
      summary.surprises = classified;
      summary.surpriseLines = ranked.slice(0, MAX_SURPRISE_LINES).map(describeSurprise);
      if (ranked.length > MAX_SURPRISE_LINES) {
        const hidden = ranked.length - MAX_SURPRISE_LINES;
        summary.surpriseLines.push(
          `… and ${hidden} more, all of lower severity. ${
            ranked.every((s) => (s.effectiveSeverity ?? 'info') === 'info')
              ? 'Every one is an unconfirmed note, which is what a first run against a page full of live data looks like. Run action:"calibrate" once to mark this noise as volatile.'
              : 'Open the flow in the side panel to read them all.'
          }`,
        );
      }
      summary.surpriseCount = {
        total: classified.length,
        fail: classified.filter((s) => s.effectiveSeverity === 'fail').length,
        warn: classified.filter((s) => s.effectiveSeverity === 'warn').length,
        info: classified.filter((s) => (s.effectiveSeverity ?? 'info') === 'info').length,
      };
      summary.knownWorld = detection.seeded
        ? { seeded: false, runs: 0, note: detection.note }
        : { runs: detection.knownWorldRuns, volatileKeys: (world?.volatile ?? []).length };
      summary.environment = envName;
    }
    // Never sent to an agent: a full signature is kilobytes of normalised
    // evidence. Internal callers (calibration, A/B) ask for it by name.
    if (includeSignature) summary.signature = runSignature;
  }

  summary.verdict = verdictFor({ failed, warnings, surprises: classified, dryRun });

  if (!dryRun) {
    const run = {
      at: Date.now(),
      passed: summary.passed,
      failed: summary.failed,
      durationMs: summary.durationMs,
      verdict: summary.verdict,
      humanize: hz.level,
      humanizeSeed: runSeed,
      surprises: classified.filter((s) => s.effectiveSeverity !== 'info').length,
    };
    const runHistory = [...(recording.runHistory ?? []), run].slice(-20);
    const recent = runHistory.slice(-10);
    const passRuns = recent.filter((item) => item.failed === 0).length;
    const failRuns = recent.length - passRuns;

    // Read again before writing: an approval made WHILE this run was going would otherwise be
    // undone by the copy read at the start (the flow would still be reported as approved).
    const current = (await getRecording(id)) ?? recording;
    // The known world is only ever grown by a human approving a run, EXCEPT for
    // the very first one: a flow with no known world can never produce a useful
    // comparison, and asking somebody to approve an empty baseline they have
    // not seen is theatre. `seedKnownWorld` makes that first merge explicit —
    // per environment: seeding test2's first world never touches test1's.
    const shouldSeed = seedKnownWorld && runSignature && !(knownWorldFor(current, envName)?.runs);

    let next = {
      ...current,
      lastRun: run,
      runHistory,
      lastSignature: runSignature ?? current.lastSignature ?? null,
      surpriseHistory: [...(current.surpriseHistory ?? []), classified.map((s) => ({ key: s.key, kind: s.kind }))].slice(-5),
      flaky: {
        detected: passRuns > 0 && failRuns > 0,
        sampleSize: recent.length,
        passRuns,
        failRuns,
      },
    };
    if (shouldSeed) {
      next = withKnownWorld(next, envName, {
        ...mergeKnownWorld(emptyKnownWorld(runSignature), runSignature), approvedAt: Date.now(), approvedBy: 'seed',
      });
    }
    await saveRecording(next);
    summary.flaky = passRuns > 0 && failRuns > 0;
    if (shouldSeed) summary.knownWorld = { runs: 1, seeded: true, note: 'Known world seeded from this run.' };
  }

  return summary;
}

/**
 * Run the same flow twice on the same build and mark what differed as noise.
 *
 * Anything that changes when nothing changed is volatile by definition. This is
 * the cheapest correct mask there is, and — unlike hand-written masks — it does
 * not slowly blind the suite, because it only ever excludes things that were
 * proven unstable rather than things somebody found annoying.
 */
export async function calibrate(tabId, { id, timing = 'recorded', variables = {}, humanize, environment, urlNormalizers } = {}) {
  const options = {
    id, timing, variables, signature: 'full', compare: false, stopOnFailure: true, includeSignature: true, humanize,
    ...(environment !== undefined ? { environment } : {}), ...(urlNormalizers !== undefined ? { urlNormalizers } : {}),
  };

  const first = await replay(tabId, options);
  if (first.failed) {
    throw new Error(
      `Calibration needs a flow that passes: run 1 failed at step ${first.steps.find((s) => !s.ok)?.step}. ` +
        `Fix the flow first — calibrating a broken run would mark the breakage itself as noise.`,
    );
  }
  const second = await replay(tabId, options);
  if (second.failed) {
    throw new Error('Calibration needs two clean runs; the second run failed. The flow is not stable enough to calibrate.');
  }

  const volatile = calibrateVolatile(first.signature, second.signature);
  const recording = await getRecording(id);
  // The noise mask belongs to the environment it was measured on: the run's
  // signature already carries the resolved environment key.
  const envName = envKeyOf(second.signature?.environment ?? environment ?? recording.environment?.name ?? recording.environment);
  const knownWorld = { ...(knownWorldFor(recording, envName) ?? emptyKnownWorld(second.signature)), volatile };
  await saveRecording(withKnownWorld(recording, envName, knownWorld));

  return {
    id,
    environment: envName,
    runs: 2,
    volatileKeys: volatile.length,
    volatile: volatile.slice(0, 60),
    note: volatile.length
      ? 'These differed between two identical runs and will no longer be reported as surprises.'
      : 'Nothing differed between two identical runs — this flow is fully deterministic.',
  };
}

/**
 * Fold the last run into the known world.
 *
 * Deliberately a separate, explicit action. Everything else in this file is
 * allowed to observe; only a person is allowed to say "that is normal now".
 */
export async function approveKnownWorld(id, { by = 'operator', note = null, expectLastRunAt = null, environment } = {}) {
  const recording = await getRecording(id);
  if (!recording) throw new Error(`No recording with id "${id}".`);
  if (!recording.lastSignature) {
    throw new Error('There is no recorded signature to approve. Replay the flow once, then approve that run.');
  }
  // The approval lands in the environment the REVIEWED run ran on — its
  // signature says which. An explicit environment that disagrees is refused:
  // folding a test1 run into test2's known world would poison both worlds.
  const runEnv = envKeyOf(recording.lastSignature.environment ?? recording.environment?.name ?? recording.environment);
  if (environment != null && envKeyOf(environment) !== runEnv) {
    throw new Error(
      `The last run of "${recording.name ?? id}" was on environment "${runEnv}", not "${envKeyOf(environment)}", so nothing was approved. ` +
        'Replay the flow on that environment first, then approve that run.',
    );
  }
  // What is approved is the run the person REVIEWED. A replay that finished between the review and
  // the press replaced lastSignature, and its surprises — a real regression among them — went into
  // the known world unseen (desktop review, 2026-09-22). Checked here, next to the write, because
  // a check in the caller leaves a gap between the read and the merge.
  if (expectLastRunAt != null && Number(recording.lastRun?.at ?? 0) !== Number(expectLastRunAt)) {
    throw new Error(
      `A newer run of "${recording.name ?? id}" arrived after the one you reviewed (${new Date(Number(expectLastRunAt)).toISOString()} → ` +
        `${recording.lastRun?.at ? new Date(Number(recording.lastRun.at)).toISOString() : 'none'}), so nothing was approved. ` +
        'Review that run and approve it instead.',
    );
  }
  const merged = mergeKnownWorld(knownWorldFor(recording, runEnv), recording.lastSignature);
  // A person's name, never the word a first run uses for itself (lib/approved.js isApproved).
  const approver = by === 'seed' ? 'operator' : by;
  const knownWorld = { ...merged, approvedAt: Date.now(), approvedBy: approver, approvalNote: note };
  await saveRecording(withKnownWorld({ ...recording, surpriseHistory: [] }, runEnv, knownWorld));
  const result = {
    id,
    environment: runEnv,
    runs: knownWorld.runs,
    networkOperations: Object.keys(knownWorld.network).length,
    consoleSignatures: Object.keys(knownWorld.console).length,
    steps: Object.keys(knownWorld.steps).length,
    volatileKeys: knownWorld.volatile.length,
  };
  // (3.2) The approval travels with the flow: the engine's listener writes it next to the flow in
  // the repository, when the flow is there. The approval above already stands, so a slow or failed
  // write is reported, never thrown.
  if (approvedListener) {
    let timer = null;
    try {
      result.repo = await Promise.race([
        Promise.resolve(approvedListener(id)),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ written: false, reason: 'the flow library did not answer within 15 s' }), 15_000); }),
      ]);
    } catch (err) {
      result.repo = { written: false, reason: String(err?.message ?? err) };
    } finally {
      clearTimeout(timer);
    }
    if (result.repo == null) delete result.repo;
  }
  return result;
}

let approvedListener = null;

/**
 * (3.2) Who writes an approval to the repository: the extension's service worker (through the
 * daemon's flow library) or the daemon itself (for the launched-engine store). `fn(id)` resolves to
 * what it did, e.g. `{ written: true, file }` or `{ written: false, reason }`; null removes it.
 */
export function onApproved(fn) {
  approvedListener = typeof fn === 'function' ? fn : null;
}

/**
 * The result classification.
 *
 * `FAIL_AUTOMATION` is separated from `FAIL_PRODUCT` on the wording of the
 * error, because those two outcomes have different owners: one is a bug and
 * one is a broken test, and filing the second as the first is how a QA system
 * loses its audience.
 */
function verdictFor({ failed, warnings, surprises, dryRun }) {
  if (dryRun) return failed.length ? 'FAIL_AUTOMATION' : 'PASS';
  if (failed.length) {
    const automation = failed.every((step) => AUTOMATION_FAILURE.test(step.error ?? ''));
    return automation ? 'FAIL_AUTOMATION' : 'FAIL_PRODUCT';
  }
  if (surprises.some((s) => s.effectiveSeverity === 'fail')) return 'SURPRISE';
  if (warnings.length || surprises.some((s) => s.effectiveSeverity === 'warn')) return 'PASS_WITH_WARNING';
  return 'PASS';
}

/**
 * How many surprise lines cross the wire to the agent, and in what order.
 *
 * Twelve is enough to carry every failure and warning a healthy flow produces,
 * and small enough that a noisy first run costs a paragraph instead of a
 * context window. The panel and the report are not subject to this — they read
 * `summary.surprises`, which stays complete.
 */
const MAX_SURPRISE_LINES = 12;

/** Failures before warnings before notes: the cap must never drop the signal. */
const SURPRISE_RANK = { fail: 3, warn: 2, info: 1 };

/**
 * What counts as the TEST breaking rather than the PRODUCT breaking.
 *
 * ## Why this list grew on 2026-09-10
 *
 * It used to match only locator-resolution failures, anchored to the start of
 * the message. Two live runs produced these, and both were classified
 * `FAIL_PRODUCT`:
 *
 *   "The click was dispatched but the page never received it: the attached tab
 *    is HIDDEN (document.visibilityState=\"hidden\")…"
 *   "Found textbox \"جستجو\", but it never stopped moving…"
 *
 * Neither is a product defect. The first is Chromium refusing to deliver input
 * to a tab nobody is showing — the harness's own environment. The second is the
 * stability gate declining to click into a running animation, which is the gate
 * WORKING. Reporting either as a product regression is precisely the failure the
 * whole `FAIL_PRODUCT` / `FAIL_AUTOMATION` split exists to prevent: a pipeline
 * that cries wolf about the product teaches people to ignore it.
 *
 * ## The rule for adding to this list
 *
 * An entry belongs here when the message describes something about the HARNESS
 * or the ENVIRONMENT — an element that could not be addressed, input that was
 * never delivered, a readiness gate that never opened. It does NOT belong here
 * when the page did something and the something was wrong: a failed assertion,
 * a 500, a value that came back different. When in doubt, leave it out —
 * mislabelling a real regression as "just the test" is the worse direction, and
 * it is the direction that loses defects rather than trust.
 *
 * Unanchored on purpose: several of these appear after a leading clause.
 */
const AUTOMATION_FAILURE_PATTERNS = [
  // Element identity — the recorded locators no longer address anything.
  /^Could not find /,
  /^Lost the resolved /,
  /^Assertion target could not be resolved/,
  /^No recording /,

  // Steps this driver cannot perform at all.
  /^Step is a file upload/,
  /^Unknown step type/,

  // Input the browser refused to deliver. Environment, never product.
  /the page never received it/i,
  /is HIDDEN \(document\.visibilityState/i,
  /tab is not visible/i,
  /bring (?:that|the) tab to the front/i,

  // Readiness gates that never opened. The gate doing its job is not a defect.
  /never stopped moving/i,
  /still (?:changing|animating)/i,
  /is covered by /i,
  /obstructed by /i,

  // The harness could not reach the page at all.
  /^Timed out waiting for the page/i,
  /^The tab (?:was closed|no longer exists)/i,
  /debugger detached/i,
];

const AUTOMATION_FAILURE = {
  test: (message) => AUTOMATION_FAILURE_PATTERNS.some((pattern) => pattern.test(message)),
};

/** The buffer positions this run starts from, so its own slice can be isolated. */
async function captureWatermark(tabId, evidence) {
  const mark = { consoleSeq: 0, requestIds: new Set() };
  if (evidence.console) {
    const log = await observe.consoleLog(tabId, { limit: 0 }).catch(() => null);
    mark.consoleSeq = log?.lastSeq ?? 0;
  }
  if (evidence.network) {
    const net = await observe.network(tabId, { limit: 500 }).catch(() => null);
    for (const request of net?.requests ?? []) mark.requestIds.add(request.requestId);
  }
  return mark;
}

/**
 * Attach this step's slice of the world to its result record.
 *
 * Attribution is by identity, never by wall-clock: console entries carry a
 * monotonic `seq` and requests carry an id, so "what happened during this step"
 * is a set difference rather than a guess about timing. The alternative —
 * filtering by timestamp — quietly mis-assigns everything on a slow page.
 */
async function attachEvidence(tabId, record, { evidence, watermark, wantUi }) {
  if (evidence.console) {
    const log = await observe.consoleLog(tabId, { since: watermark.consoleSeq, limit: 50 }).catch(() => null);
    if (log?.entries?.length) {
      record.console = log.entries.map((e) => ({ level: e.level, text: e.text }));
      watermark.consoleSeq = log.lastSeq ?? watermark.consoleSeq;
    }
  }
  if (evidence.network) {
    const net = await observe.network(tabId, { limit: 500 }).catch(() => null);
    const fresh = [];
    for (const request of net?.requests ?? []) {
      if (watermark.requestIds.has(request.requestId)) continue;
      watermark.requestIds.add(request.requestId);
      fresh.push({
        requestId: request.requestId,
        method: request.method,
        url: request.url,
        status: normalizeStatus(request.status),
      });
    }
    if (fresh.length) record.network = fresh;
  }
  if (wantUi) {
    const tree = await snapshot(tabId, { mode: 'a11y', maxNodes: 300 }).catch(() => null);
    if (tree) {
      record.aria = tree.tree;
      record.url = tree.url;
    }
  }
}

/**
 * Wait until the page has gone QUIET: for `quietMs`, no new console entry, no new request and none
 * still pending — bounded by `capMs`, so a page that never stops (polling, a long-lived request)
 * costs at most that. `read()` → `{ consoleSeq, requests, pending }`. → `{ quiet, waitedMs }`.
 */
export async function awaitQuiet(read, { quietMs = 500, capMs = 2_000, everyMs = 100 } = {}) {
  const started = Date.now();
  let last = await read().catch(() => null);
  let quietSince = last && !(last.pending > 0) ? Date.now() : Infinity;
  while (Date.now() - started < capMs) {
    await new Promise((r) => setTimeout(r, everyMs));
    const now = await read().catch(() => null);
    // `consoleSeq` and `requests` only grow, so a change in them is an EDGE: observing it at this
    // poll means it already happened, and the quiet window may start from here. `pending` is a
    // LEVEL, and a request finishing moves no counter at all — it was counted into `requests` when
    // it STARTED, and completing only drops `pending` back to zero. Folding `pending > 0` into
    // `changed` therefore opened the quiet window at the last moment a request was seen RUNNING
    // instead of the first moment nothing was: whenever the poll slipped (a loaded box turns
    // setTimeout(20) into 90 ms, measured), the window opened a whole interval before the request
    // actually settled, and awaitQuiet could return before the late response — and its status —
    // was readable. That is the exact race this function exists to close, so the level gates the
    // clock: while anything is in flight there is no quiet start, only a first poll that sees none.
    const changed = !now || !last || now.consoleSeq !== last.consoleSeq || now.requests !== last.requests;
    if (changed) quietSince = Date.now();
    if (!now || now.pending > 0) quietSince = Infinity;
    else if (quietSince === Infinity) quietSince = Date.now();
    last = now;
    if (Date.now() - quietSince >= quietMs) return { quiet: true, waitedMs: Date.now() - started };
  }
  return { quiet: false, waitedMs: Date.now() - started };
}

/**
 * Add to `record` (the last step's) the console entries and requests that arrived after its own
 * evidence was read. Appends — never replaces what the step already had. → counts added.
 */
async function attachLateEvidence(tabId, record, { evidence, watermark }) {
  if (!record) return { console: 0, network: 0 };
  const late = {};
  await attachEvidence(tabId, late, { evidence, watermark, wantUi: false });
  if (late.console?.length) record.console = [...(record.console ?? []), ...late.console];
  if (late.network?.length) record.network = [...(record.network ?? []), ...late.network];
  return { console: late.console?.length ?? 0, network: late.network?.length ?? 0 };
}

/**
 * Give every request its FINAL status.
 *
 * One extra buffer read, after the run, patching by requestId. Requests that are still unfinished
 * even now keep a null status and are dropped from the signature — a request that never completed
 * has no outcome to compare, and inventing one is how a detector starts lying.
 */
async function settleNetworkEvidence(tabId, results) {
  const latest = await observe.network(tabId, { limit: 500 }).catch(() => null);
  if (!latest?.requests?.length) return;

  const byId = new Map(latest.requests.map((request) => [request.requestId, request]));
  for (const record of results) {
    for (const entry of record.network ?? []) {
      const current = byId.get(entry.requestId);
      if (!current) continue;
      entry.status = normalizeStatus(current.status);
    }
  }
}

/** A failed request is an outcome (0), a pending one is not (null). */
function normalizeStatus(status) {
  if (typeof status === 'number') return status;
  return String(status ?? '').startsWith('FAILED') ? 0 : null;
}

/**
 * What leaves the extension.
 *
 * The raw step record carries the whole aria tree and every request, which is
 * the signature's input and is far too much for a tool result. The counts stay
 * so a reader can see the evidence existed.
 */
function publicStep(record) {
  const { aria, network, console: consoleEntries, ...rest } = record;
  return {
    ...rest,
    ...(consoleEntries?.length ? { consoleCount: consoleEntries.length } : {}),
    ...(network?.length ? { requestCount: network.length } : {}),
    ...(aria ? { uiCaptured: true } : {}),
  };
}

/** Make sure the locator engine is present — it may have been lost to a navigation. */
async function ensureLocators(tabId) {
  await inWorld(tabId, LOCATOR_SOURCE).catch(() => {});
}

// -------------------------------------------------------------------- resolve

/**
 * Find the step's element, or throw the message the QA actually needs.
 *
 * Everything about this function is the error path. The happy path is two
 * lines; the rest turns "not found" into a sentence naming what was sought,
 * where, what was tried, and what is there now instead.
 */
async function locate(tabId, step, { budgetMs }) {
  const deadline = Date.now() + Math.max(budgetMs, MIN_WAIT_MS);
  let last = null;

  for (;;) {
    await ensureLocators(tabId);
    last = await inWorld(
      tabId,
      `(() => {
         const t = ${JSON.stringify(step.target)};
         if (!window.__g9loc) return { ok: false, noEngine: true };

         // Page readiness first. A step that runs while the document is still
         // loading acts on a page that is not the one that was recorded — the
         // element may exist and be about to move, or the section it belongs to
         // may not have arrived. On a fast connection this never shows up,
         // which is exactly why it has to be checked rather than assumed.
         const loading = document.readyState !== 'complete';

         const r = window.__g9loc.resolve(t);
         if (!r.ok) return { ok: false, loading, tried: r.tried, nearest: r.nearest };

         window.__g9target = r.el;
         const box = r.el.getBoundingClientRect();
         const style = getComputedStyle(r.el);

         // Stability: an element mid-animation or mid-reflow is still moving,
         // and clicking where it WAS is how a replay hits the wrong thing.
         const key = [box.x, box.y, box.width, box.height].map(Math.round).join(',');
         const previous = window.__g9lastBox;
         const settled = previous && previous.el === r.el && previous.key === key;
         window.__g9lastBox = { el: r.el, key };

         return {
           ok: true,
           loading,
           settled,
           matchedBy: r.matchedBy,
           tried: r.tried,
           describe: window.__g9loc.describeBriefly(r.el),
           visible: box.width > 0 && box.height > 0 && style.visibility !== 'hidden',
           enabled: !r.el.disabled && style.pointerEvents !== 'none',
         };
       })()`,
    ).catch(() => null);

    if (last?.ok && last.visible && last.enabled && last.settled && !last.loading) return last;
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }

  const fp = step.target?.fingerprint ?? {};
  const sought = `${fp.role || fp.tag || 'element'}${fp.name ? ` "${fp.name}"` : ''}`;
  const where = fp.heading ? ` under "${fp.heading}"` : '';

  // Each of these is a different problem with a different fix, so each says so
  // rather than collapsing into "element not ready".
  if (last?.ok) {
    if (last.loading) {
      throw new Error(
        `Found ${sought}${where}, but the page is still loading after ${Math.round((Date.now() - deadline + Math.max(budgetMs, MIN_WAIT_MS)) / 1000)}s. ` +
          `Acting now would use a page that is not finished building. If this page is genuinely slow, ` +
          `re-record it so the step carries a longer gap, or replay with timing:"recorded".`,
      );
    }
    if (!last.visible) {
      throw new Error(
        `Found ${sought}${where}, but it is not visible — zero size or hidden. ` +
          `It is probably inside a collapsed section, or a step that should have opened it did not.`,
      );
    }
    if (!last.enabled) {
      throw new Error(
        `Found ${sought}${where}, but it is disabled or does not accept pointer events. ` +
          `Something earlier in the flow normally enables it.`,
      );
    }
    throw new Error(
      `Found ${sought}${where}, but it never stopped moving — its position was still changing ` +
        `after the wait. An animation or a reflow is still running; clicking now would hit whatever ` +
        `lands there instead.`,
    );
  }

  const tried = (last?.tried ?? []).map((t) => `${t.kind} (${t.matches} matches)`).join(', ');
  const nearest = last?.nearest
    ? ` The closest thing on the page now is ${last.nearest.describe} — this usually means it was renamed.`
    : ` Nothing similar is on the page, so it was probably removed or never rendered.`;

  throw new Error(
    `Could not find ${sought}${where}. Tried ${(step.target?.locators ?? []).length} recorded locators` +
      (tried ? `: ${tried}` : '') + `.${nearest}`,
  );
}

/**
 * An assertion is "eventually true", not "true this microsecond".
 *
 * Assertions used to run the instant their turn came, ignoring the step's wait
 * budget. After a navigation that is a guaranteed race: the SPA has not painted,
 * `document.body.innerText` is still empty, and the check fails against a blank
 * document — reporting FAIL_PRODUCT for an app that was merely still rendering.
 * Caught on the first long flow written, whose very first assertion failed that
 * way every single time.
 *
 * Retrying inside the declared budget is what makes a long flow possible at all:
 * a check placed where it belongs, immediately after the step it describes,
 * has to be allowed to wait for that step to finish.
 *
 * `executeAssertion` signals failure by THROWING, so the last error is kept and
 * rethrown when the budget runs out — the caller still sees the real message,
 * not a synthetic timeout that hides what was actually wrong.
 *
 * A budget of zero means one attempt and no waiting, so every recording made
 * before this replays exactly as it did.
 */
async function assertWithin(tabId, step, budgetMs) {
  const deadline = Date.now() + Math.max(0, budgetMs || 0);
  for (;;) {
    try {
      return await executeAssertion(tabId, step);
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await sleep(Math.min(250, Math.max(50, deadline - Date.now())));
    }
  }
}

/** What a dry run does: resolve everything, change nothing. */
async function probe(tabId, step) {
  if (step.type === 'assert') return executeAssertion(tabId, step);
  if (step.type === 'navigate' || step.type === 'scroll' || (step.type === 'key' && !step.target)) {
    return { skipped: 'not element-bound' };
  }
  const found = await locate(tabId, step, { budgetMs: 0 });
  return { matchedBy: found.matchedBy, resolved: found.describe };
}

// ----------------------------------------------------------------- execution

async function runStep(tabId, step, mode, input = {}) {
  const stepStart = Date.now();
  const budgetMs = Math.round((step.waitMs ?? 0) * mode.budget);
  // Passed to every interaction of this step: its level and its seed.
  const hz = input.humanize !== undefined ? { humanize: input.humanize, seed: input.seed } : { seed: input.seed };
  const humanLevel = !!input.level && input.level !== 'off';

  if (step.type === 'assert') return assertWithin(tabId, step, budgetMs);

  if (step.type === 'navigate') {
    await nav.navigate(tabId, { url: step.url, waitUntil: 'load' });
    await ensureLocators(tabId);
    return { url: step.url };
  }

  if (step.type === 'scroll') {
    const to = { x: Number(step.x) || 0, y: Number(step.y) || 0 };
    if (!humanLevel) {
      await inWorld(tabId, `scrollTo(${to.x}, ${to.y})`, { idempotent: false });
      return { to };
    }
    // A person scrolls to a resting place with the wheel. The wheel moves in
    // WHOLE notches (snap), so the landing is reported rather than promised to the pixel — it used
    // to send the exact offset, ending on a partial notch no wheel produces. A resting place within
    // half a notch of where the page already is needs no wheel at all.
    const at = await inWorld(tabId, '({ x: scrollX, y: scrollY })').catch(() => ({ x: 0, y: 0 }));
    const dy = to.y - (at?.y ?? 0);
    const dx = to.x - (at?.x ?? 0);
    const HALF_NOTCH = 50;
    let result = null;
    if (Math.abs(dy) >= HALF_NOTCH) {
      result = await interact.scroll(tabId, { direction: dy > 0 ? 'down' : 'up', amount: Math.abs(dy), snap: true, ...hz, seed: `${input.seed}:y` });
    }
    if (Math.abs(dx) >= HALF_NOTCH) {
      result = await interact.scroll(tabId, { direction: dx > 0 ? 'right' : 'left', amount: Math.abs(dx), snap: true, ...hz, seed: `${input.seed}:x` });
    }
    return { to, landed: result?.position ?? at, via: 'wheel', ...(result ? { delivery: result.delivery } : {}) };
  }

  if (step.type === 'key' && !step.target) {
    const pressed = await interact.key(tabId, {
      key: step.key,
      modifiers: interact.modifierMask(step.modifiers || []),
      ...hz,
    });
    return { pressed: step.key, delivery: pressed?.delivery };
  }

  const found = await locate(tabId, step, { budgetMs });

  // The page was ready sooner than the person was. In "recorded" mode that
  // difference is kept, because a flow that only works when you go slowly is a
  // finding, not a detail to optimise away.
  if (mode.honourPause) {
    const remaining = (step.waitMs ?? 0) - (Date.now() - stepStart);
    if (remaining > 0) await sleep(Math.min(remaining, 10_000));
  }

  const backendNodeId = await resolvedNodeId(tabId);
  const common = { matchedBy: found.matchedBy, resolved: found.describe };

  switch (step.type) {
    case 'click':
    case 'double_click':
    case 'rightclick': {
      const eventName = step.type === 'rightclick' ? 'contextmenu' : step.type === 'double_click' ? 'dblclick' : 'click';
      await armEventProof(tabId, backendNodeId, eventName);
      const clicked = await withRefBypass(tabId, backendNodeId, (opts) =>
        interact.click(tabId, {
          ...opts,
          ...hz,
          clickCount: step.type === 'double_click' ? 2 : 1,
          button: step.type === 'rightclick' ? 'right' : 'left',
          modifiers: interact.modifierMask(step.modifiers || []),
        }),
      ).catch(async (err) => {
        // The click failed (refused, not delivered): take the proof listener
        // down rather than leave it waiting in the page for a click that never comes.
        await dropEventProof(tabId, backendNodeId);
        throw err;
      });
      const proof = await verifyEventProof(tabId, backendNodeId, eventName);
      return { ...common, delivery: clicked?.delivery, ...(proof?.navigatedAway ? { navigatedAway: true } : {}) };
    }

    case 'type': {
      const typed = await withRefBypass(tabId, backendNodeId, (opts) =>
        interact.type(tabId, { ...opts, ...hz, text: String(step.value ?? ''), clear: true }),
      );
      const actual = await callInWorld(
        tabId,
        backendNodeId,
        `function () { return this.value != null ? String(this.value) : String(this.textContent || ''); }`,
      );
      if (actual !== String(step.value ?? '')) {
        throw new Error(`Typing was issued, but the field contains ${JSON.stringify(actual)} instead of ${JSON.stringify(String(step.value ?? ''))}.`);
      }
      return { ...common, value: step.value, delivery: typed?.delivery };
    }

    case 'select': {
      await withRefBypass(tabId, backendNodeId, (opts) =>
        interact.select(tabId, { ...opts, ...hz, values: step.values || step.texts || step.text || step.value }),
      );
      return { ...common, selected: step.values || step.texts || step.text || step.value };
    }

    case 'check': {
      const now = await callInWorld(tabId, backendNodeId, `function () { return !!this.checked; }`);
      if (now !== step.checked) {
        await withRefBypass(tabId, backendNodeId, (opts) => interact.click(tabId, { ...opts, ...hz }));
      }
      const after = await callInWorld(tabId, backendNodeId, `function () { return !!this.checked; }`);
      if (after !== step.checked) {
        throw new Error(`Checkbox action was issued, but checked is ${after}; expected ${step.checked}.`);
      }
      return { ...common, checked: step.checked };
    }

    case 'key': {
      const isFocused = () => callInWorld(
        tabId,
        backendNodeId,
        `function () { return this.ownerDocument.activeElement === this; }`,
      );
      if (input.level === 'stealth') {
        // No DOM.focus at this level: focus is earned by clicking the target.
        if (!(await isFocused())) {
          await withRefBypass(tabId, backendNodeId, (opts) => interact.click(tabId, { ...opts, ...hz, seed: `${input.seed}:focus` }));
        }
      } else {
        await send(tabId, 'DOM.focus', { backendNodeId });
      }
      const focused = await isFocused();
      if (!focused) throw new Error('Could not focus the recorded key target; the key was not sent to another element by guesswork.');
      const pressed = await interact.key(tabId, {
        key: step.key,
        modifiers: interact.modifierMask(step.modifiers || []),
        ...hz,
      });
      return { ...common, pressed: step.key, targetFocused: true, delivery: pressed?.delivery };
    }

    case 'upload':
      throw new Error(
        `Step is a file upload of ${(step.files || []).join(', ')}, but a browser never reveals the path ` +
          `of a file a user picked — only its name. Replay it with browser_interact action:"upload" and an ` +
          `absolute path, or edit this step to add one.`,
      );

    case 'drag': {
      const to = await locate(tabId, { target: step.to }, { budgetMs: 0 });
      const toBackendNodeId = await resolvedNodeId(tabId);
      await withRefsBypass(tabId, {
        __replay_from: { backendNodeId, role: 'element', name: 'replay drag source' },
        __replay_to: { backendNodeId: toBackendNodeId, role: 'element', name: 'replay drag target' },
      }, (url) => interact.drag(tabId, { from: '__replay_from', to: '__replay_to', url, ...hz }));
      return { ...common, dragTo: to.describe, executed: true };
    }

    default:
      throw new Error(`Unknown step type "${step.type}".`);
  }
}

/**
 * Interaction tools address elements by ref, and a replay has no refs — it has
 * a locator that just resolved. Rather than teach every tool a second address
 * mode, the resolved node is registered under a reserved ref for the duration
 * of the call. One translation point, and interact.js keeps a single contract.
 */
async function withRefBypass(tabId, backendNodeId, run) {
  const url = await inWorld(tabId, 'location.href').catch(() => null);
  // Reserved refs live apart from the agents' snapshot table (lib/refs.js withPrivateRefs): swapping
  // the whole table in and out threw away any snapshot another agent took during the step.
  return withPrivateRefs(tabId, {
    url,
    entries: [['__replay', { backendNodeId, role: 'element', name: 'replay target' }]],
  }, () => run({ ref: '__replay', url }));
}

async function withRefsBypass(tabId, refs, run) {
  const url = await inWorld(tabId, 'location.href').catch(() => null);
  return withPrivateRefs(tabId, { url, entries: Object.entries(refs) }, () => run(url));
}

async function armEventProof(tabId, backendNodeId, eventName) {
  // The proof is an expando on the node's wrapper IN G9BrowserAgent'S WORLD and a
  // listener on the node's own window there: the page sees neither, and both
  // still observe the page's real events.
  await callInWorld(
    tabId,
    backendNodeId,
    `function (eventName) {
       const previous = this.__g9ReplayProof;
       if (previous && previous.detach) previous.detach();
       const proof = { target: this, eventName, seen: false, trusted: false };
       this.__g9ReplayProof = proof;
       const view = this.ownerDocument.defaultView || window;
       // NOT { once: true }: a once-listener is consumed by the FIRST event of
       // this type anywhere in the window — the page's own synthetic click on
       // another element, say — and the real one for the target then arrives
       // with nobody listening (the same trap select() in interact.js records).
       // Filter by target, stop at the first trusted hit, detach explicitly.
       const verify = (e) => {
         const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
         if (e.target === proof.target || proof.target.contains(e.target) || path.includes(proof.target)) {
           proof.seen = true;
           proof.trusted = proof.trusted || e.isTrusted === true;
           if (proof.trusted) proof.detach();
         }
       };
       proof.detach = () => view.removeEventListener(eventName, verify, true);
       view.addEventListener(eventName, verify, { capture: true });
     }`,
    [eventName],
  );
}

/** Remove an armed proof without reading it. Best effort: the node may be gone. */
function dropEventProof(tabId, backendNodeId) {
  return callInWorld(
    tabId,
    backendNodeId,
    `function () {
       const p = this.__g9ReplayProof;
       if (p && p.detach) p.detach();
       delete this.__g9ReplayProof;
     }`,
  ).catch(() => {});
}

async function verifyEventProof(tabId, backendNodeId, eventName) {
  // Read the proof from the target node, not the top window. A same-origin
  // iframe has its own Window realm even though its element is controllable.
  const proof = await callInWorld(
    tabId,
    backendNodeId,
    `function () {
       const p = this.__g9ReplayProof;
       if (!p) return p;
       if (p.detach) p.detach();
       delete this.__g9ReplayProof;
       return { seen: p.seen, trusted: p.trusted };
     }`,
  ).catch((err) => ({ unreadable: String(err?.message ?? err) }));

  if (proof?.seen && proof?.trusted) return;

  // The node being gone is the SUCCESS case for a link or a submit button.
  //
  // The handler runs synchronously on the click; the navigation it starts then
  // tears the document down, and by the time we ask, the node we were holding
  // no longer exists. Reading that as "the page never saw the click" failed
  // every recorded step whose whole purpose was to navigate — and did it
  // non-deterministically, because a slow server left the old document alive
  // long enough to answer.
  if (proof?.unreadable) {
    const navigated = await inWorld(tabId, 'document.readyState').catch(() => null);
    if (navigated !== null) {
      return { navigatedAway: true, note: `The ${eventName} started a navigation, which replaced the page.` };
    }
    throw new Error(
      `The ${eventName} command was issued, but the result could not be read back: ${proof.unreadable}.`,
    );
  }

  throw new Error(`The ${eventName} command was issued, but the recorded target did not observe the expected trusted event.`);
}

/** backendNodeId of whatever `locate` stored in window.__g9target (G9BrowserAgent's world). */
async function resolvedNodeId(tabId) {
  const result = await inWorld(tabId, 'window.__g9target', { returnByValue: false }).catch(() => null);
  if (!result?.objectId) throw new Error('Lost the resolved element before acting on it — the page changed mid-step.');
  try {
    const { node } = await send(tabId, 'DOM.describeNode', { objectId: result.objectId });
    return node.backendNodeId;
  } finally {
    await send(tabId, 'Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
  }
}

function describeStep(step) {
  if (step.type === 'assert') return summarizeAssertion(step);
  const fp = step.target?.fingerprint;
  return fp ? `${step.type} ${fp.role || fp.tag}${fp.name ? ` "${fp.name}"` : ''}` : step.type;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parameterDefaults(parameters) {
  if (!parameters || typeof parameters !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (value && typeof value === 'object') {
      // A secretRef NAMES a secret; it never has a value here. Leaving it out
      // makes an unresolved secret fail loudly at substitution ("Missing data
      // parameter") — the old code handed the declaration object itself over,
      // and the flow typed "[object Object]" into the password field.
      if (value.type === 'secretRef') continue;
      if ('default' in value) out[key] = value.default;
      continue;
    }
    out[key] = value;
  }
  return out;
}
