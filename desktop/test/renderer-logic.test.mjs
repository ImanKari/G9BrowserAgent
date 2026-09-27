import assert from 'node:assert/strict';
import { suite } from './harness.mjs';
import { interpolateTrack, fitRect, viewportToImage, viewportToCanvas, frameIndexAt, TrackBuffer, normalizeSample, cursorPoints, CURSOR_POLYGON } from '../renderer/lib/track.js';
import { normalizeRun, approvalCandidates, approvalArgs, verdictTone, verdictLabel, surpriseText, relevantSurprises, runRows, recordingRows, flowsOf, worstVerdict, kindLabel } from '../renderer/lib/runs.js';
import { buildScheduleEntry, describeWhen, describeEngine, nextDailyRun, scheduleRows, parseRunnerArgs, runnerArgs, entryEnv, lastResult, lastRunId } from '../renderer/lib/schedule.js';
import { describeActivity, isDuplicateEngineActivity, unwrapEngineActivity, isOwnReadActivity } from '../renderer/lib/activity.js';
import { fmtDuration, fmtBytes, fmtAgo, shortUrl, plural } from '../renderer/lib/format.js';
import { normalizeVersions, normalizeEngine, normalizeAgent, normalizeTab, groupTabs, installedCft } from '../renderer/lib/engines.js';

const t = suite('desktop: renderer logic (cursor track, runs, approvals, schedule)');

const track = [
  { at: 1000, x: 0, y: 0, buttons: 0, type: 'mouseMoved' },
  { at: 1100, x: 100, y: 50, buttons: 0, type: 'mouseMoved' },
  { at: 1200, x: 100, y: 50, buttons: 1, type: 'mousePressed' },
  { at: 1260, x: 101, y: 50, buttons: 0, type: 'mouseReleased' },
];

t.test('the cursor is interpolated between samples, clamped at both ends', () => {
  assert.deepEqual(interpolateTrack(track, 500), { ...track[0], pressAge: null });
  const mid = interpolateTrack(track, 1050);
  assert.equal(mid.x, 50);
  assert.equal(mid.y, 25);
  assert.equal(mid.buttons, 0);
  const end = interpolateTrack(track, 5000);
  assert.equal(end.x, 101);
  assert.equal(interpolateTrack([], 1), null);
});

t.test('a press is reported for the ripple (pressAge), buttons come from the earlier sample', () => {
  const p = interpolateTrack(track, 1230);
  assert.equal(p.buttons, 1);
  assert.equal(p.pressAge, 30);
  assert.equal(interpolateTrack(track, 1100).pressAge, null);
});

t.test('fitRect keeps the aspect ratio and centres ("contain")', () => {
  assert.deepEqual(fitRect(1280, 800, 640, 800), { x: 0, y: 200, width: 640, height: 400, scale: 0.5 });
  assert.deepEqual(fitRect(0, 0, 10, 10), { x: 0, y: 0, width: 0, height: 0, scale: 0 });
});

t.test('viewport → image → canvas mapping uses the screencast metadata', () => {
  const meta = { deviceWidth: 1920, deviceHeight: 1080, offsetTop: 0 };
  assert.deepEqual(viewportToImage({ x: 960, y: 540 }, meta, 1280, 720), { x: 640, y: 360 });
  assert.deepEqual(viewportToImage({ x: 10, y: 20 }, null, 100, 100), { x: 10, y: 20 }, 'no metadata: 1:1');
  const fitted = fitRect(1280, 720, 640, 400);
  const c = viewportToCanvas({ x: 1920, y: 1080 }, meta, 1280, 720, fitted);
  assert.equal(Math.round(c.x), 640);
  assert.equal(Math.round(c.y), Math.round(fitted.y + fitted.height));
});

t.test('frameIndexAt picks the last frame at or before t', () => {
  const frames = [{ at: 10 }, { at: 20 }, { at: 30 }];
  assert.equal(frameIndexAt(frames, 5), 0);
  assert.equal(frameIndexAt(frames, 20), 1);
  assert.equal(frameIndexAt(frames, 29), 1);
  assert.equal(frameIndexAt(frames, 99), 2);
  assert.equal(frameIndexAt([], 1), -1);
});

t.test('TrackBuffer: normalises, orders out-of-order samples, caps its size, draws slightly in the past', () => {
  const b = new TrackBuffer(3);
  b.push({ timestamp: 200, x: 2, y: 2 });
  b.push({ at: 100, x: 1, y: 1 });
  b.push({ at: 300, x: 3, y: 3 });
  b.push({ at: 400, x: 4, y: 4 });
  assert.deepEqual(b.samples.map((s) => s.at), [200, 300, 400]);
  assert.equal(b.push({ x: 1 }), false, 'a sample without time is ignored');
  assert.equal(b.at(450, 100).x, 3.5);
  assert.equal(b.at(10_000, 100).x, 4, 'never extrapolates past the newest sample');
  assert.equal(normalizeSample({ t: 1, x: '5', y: 6 }).x, 5);
});

t.test('the cursor polygon has its hot spot at the pointer position', () => {
  const pts = cursorPoints(100, 50, 20);
  assert.deepEqual(pts[0], [100, 50]);
  assert.equal(pts.length, CURSOR_POLYGON.length);
});

t.test('normalizeRun: a runs.list row of the v2 daemon (replay, schedule, watch, active)', () => {
  const replay = normalizeRun({ runId: '20260921-093000-replay-ab12', kind: 'replay', label: 'rec_checkout', startedAt: 1000, finishedAt: 61_000, active: false, ok: true, verdict: 'SURPRISE', exitCode: null, frames: 240, dir: 'C:/G9BrowserAgent/runs/x' });
  assert.equal(replay.kind, 'replay');
  assert.equal(replay.flowId, 'rec_checkout', 'a replay run is labelled with its recording id');
  assert.equal(replay.verdict, 'SURPRISE');
  assert.equal(replay.status, 'done');
  assert.equal(replay.durationMs, 60_000);
  assert.equal(replay.frames, 240);
  const sched = normalizeRun({ runId: 's1', kind: 'schedule', label: 'Nightly smoke', startedAt: 1, finishedAt: 2, active: false, ok: false, exitCode: 1 });
  assert.equal(sched.flowId, null);
  assert.equal(sched.flowName, 'Nightly smoke');
  assert.equal(sched.verdict, 'FAILED');
  assert.equal(normalizeRun({ runId: 's2', kind: 'schedule', result: { verdicts: { PASS: 3, SURPRISE: 1 }, exitCode: 1 } }).verdict, 'SURPRISE', 'the worst verdict of the suite');
  assert.equal(normalizeRun({ runId: 'w', kind: 'watch', label: 'tab 3', startedAt: 1, finishedAt: 2, active: false, ok: true }).verdict, 'WATCH');
  const live = normalizeRun({ runId: 'r', kind: 'replay', startedAt: 1, active: true });
  assert.equal(live.status, 'running');
  assert.equal(live.verdict, 'RUNNING');
  assert.equal(worstVerdict({ PASS: 2, FAIL_AUTOMATION: 1, SURPRISE: 4 }), 'FAIL_AUTOMATION');
  assert.equal(worstVerdict({}), null);
  assert.equal(kindLabel('schedule'), 'Scheduled');
});

t.test('normalizeRun: a runs.get detail (engine.json + result.json) and a runner report with flows', () => {
  const d = normalizeRun({
    runId: 'r1', dir: 'C:/G9BrowserAgent/runs/r1', active: false, files: ['engine.json', 'frames/', 'result.json'],
    engine: { runId: 'r1', kind: 'replay', label: 'rec_1', tabId: 3, startedAt: 1000, engine: { engineId: 'launched-1' }, recordingId: 'rec_1', humanize: { level: 'human', seed: 42 } },
    result: { finishedAt: 5000, durationMs: 4000, frames: 12, framesDropped: 3, truncated: 'frame cap reached (12 frames)', ok: true, verdict: 'PASS_WITH_WARNING', passed: 5, failed: 0, total: 5, humanize: { level: 'human', seed: 42 }, seed: 42 },
  });
  assert.equal(d.kind, 'replay');
  assert.equal(d.flowId, 'rec_1');
  assert.equal(d.verdict, 'PASS_WITH_WARNING');
  assert.deepEqual([d.passed, d.failed, d.total], [5, 0, 5]);
  assert.equal(d.seed, 42);
  assert.equal(d.truncated, 'frame cap reached (12 frames)');
  assert.equal(d.framesDropped, 3);
  assert.equal(flowsOf(d).length, 1);
  const sched = normalizeRun({
    runId: 's', engine: { kind: 'schedule', label: 'smoke' }, result: { exitCode: 1, ok: false },
    report: { flows: [
      { id: 'f1', name: 'Login', verdict: 'PASS', passed: 3, total: 3, steps: [{ step: 1, type: 'click', ok: true, matchedBy: 'role' }] },
      { id: 'f2', name: 'Pay', verdict: 'FAIL_PRODUCT', passed: 1, total: 2, failureMessage: 'Expected text', steps: [{ step: 1, type: 'click', ok: true }, { step: 2, type: 'assert', ok: false, error: 'Expected text' }], surprises: [{ kind: 'new', layer: 'network', key: 'POST /api/pay 500', effectiveSeverity: 'fail' }] },
    ] },
  });
  const flows = flowsOf(sched);
  assert.deepEqual(flows.map((f) => [f.name, f.verdict, f.steps.length, f.surprises.length]), [['Login', 'PASS', 1, 0], ['Pay', 'FAIL_PRODUCT', 2, 1]]);
  assert.equal(flows[1].steps[1].ok, false);
  assert.equal(flows[1].steps[1].message, 'Expected text');
  assert.equal(flows[1].steps[1].action, 'assert');
  assert.equal(surpriseText(flows[1].surprises[0]), 'New network: POST /api/pay 500');
  assert.deepEqual(flowsOf(normalizeRun({ runId: 'w', kind: 'watch' })), []);
});

t.test('warnings: the text behind "Pass with warnings" is carried from the runner report and from result.json', () => {
  // The runner's report/run.json spreads each replay result into its flow, `warnings` included
  // (runner/g9.mjs pushFlow); a replay's result.json carries them when the engine writes them.
  const text = 'step 2/5 (type into "#user") matched only by css. Its stable identifiers no longer work, so this step is one refactor from breaking.';
  const sched = normalizeRun({ runId: 's', engine: { kind: 'schedule' }, result: { exitCode: 0 }, report: { flows: [{ id: 'f1', name: 'Login', verdict: 'PASS_WITH_WARNING', passed: 5, total: 5, warnings: [text], steps: [] }] } });
  assert.deepEqual(flowsOf(sched)[0].warnings, [text]);
  const replay = normalizeRun({ runId: 'r', engine: { kind: 'replay', label: 'f1' }, result: { verdict: 'PASS_WITH_WARNING', passed: 5, total: 5, warnings: [text, '', null] } });
  assert.deepEqual(replay.warnings, [text], 'empty entries are dropped');
  assert.deepEqual(flowsOf(replay)[0].warnings, [text]);
  // A result.json with no warnings (the engine does not write them today): an empty list, never undefined.
  assert.deepEqual(flowsOf(normalizeRun({ runId: 'r2', engine: { kind: 'replay', label: 'f1' }, result: { verdict: 'PASS_WITH_WARNING' } }))[0].warnings, []);
});

t.test('normalizeRun keeps reading older/hand-made shapes (steps and surprises inline)', () => {
  const r = normalizeRun({
    runId: 'r1', flowId: 'f1', name: 'Checkout', startedAt: '2026-09-21T10:00:00Z', endedAt: '2026-09-21T10:01:00Z',
    result: { verdict: 'SURPRISE', steps: [{ action: 'click', status: 'ok', ms: 12 }, { action: 'type', error: 'Element not found' }], surprises: [{ effectiveSeverity: 'fail', text: 'new request POST /api/x' }, { effectiveSeverity: 'info', kind: 'ui', key: 'row 3' }] },
  });
  assert.equal(r.flowName, 'Checkout');
  assert.equal(r.durationMs, 60_000);
  assert.equal(r.steps[1].message, 'Element not found');
  assert.deepEqual(r.surpriseCount, { total: 2, fail: 1, warn: 0, info: 1 });
  assert.equal(verdictTone('FAIL_AUTOMATION'), 'fail');
  assert.equal(verdictLabel('PASS_WITH_WARNING'), 'Pass with warnings');
  assert.equal(surpriseText({ kind: 'missing', key: 'GET /a' }), 'Missing: GET /a');
  assert.equal(relevantSurprises([{ effectiveSeverity: 'info' }, { effectiveSeverity: 'warn' }]).length, 1);
  assert.deepEqual(runRows({ runs: [1] }), [1]);
});

t.test('approvals come from the recordings: last run with surprises, not approved since, both stores', () => {
  const recordings = [
    { id: 'A', name: 'Checkout', engine: 'launched', lastRun: { at: 500, verdict: 'SURPRISE', passed: 5, failed: 0, surprises: 2 } },
    { id: 'B', name: 'Login', engine: 'extension', lastRun: { at: 400, verdict: 'PASS', surprises: 0 } },
    { id: 'C', name: 'Search', engine: 'extension', lastRun: { at: 300, verdict: 'PASS_WITH_WARNING', surprises: 1 } },
    { id: 'D', name: 'Profile', engine: 'launched', lastRun: { at: 200, verdict: 'SURPRISE', surprises: 1 } },
    { id: 'E', name: 'Never ran', engine: 'launched', lastRun: null },
  ];
  const first = approvalCandidates(recordings);
  assert.deepEqual(first.map((c) => c.flowId), ['A', 'C', 'D'], 'newest first');
  const details = {
    A: { knownWorld: { runs: 3, approvedAt: 100, approvedBy: 'qa1' }, surpriseHistory: [[{ key: 'old', kind: 'new' }], [{ key: 'network POST /api/x', kind: 'new' }, { key: 'ui button "Pay"', kind: 'missing' }]] },
    D: { knownWorld: { runs: 2, approvedAt: 250, approvedBy: 'qa2' }, surpriseHistory: [] },
  };
  const c = approvalCandidates(recordings, details);
  assert.deepEqual(c.map((x) => x.flowId), ['A', 'C'], 'D was approved after its last run');
  assert.deepEqual(c[0].surprises.map((s) => s.key), ['network POST /api/x', 'ui button "Pay"'], 'the latest run\'s surprises');
  assert.equal(c[0].engine, 'launched');
  assert.equal(c[0].surpriseCount, 2);
  assert.deepEqual(recordingRows({ recordings: [1] }), [1]);
});

t.test('approvals: the same flow id in both stores are two flows (details keyed by store and id)', async () => {
  const { recordingKey } = await import('../renderer/lib/runs.js');
  const recordings = [
    { id: 'X', name: 'Checkout (launched)', engine: 'launched', lastRun: { at: 500, verdict: 'SURPRISE', surprises: 1 } },
    { id: 'X', name: 'Checkout (browser)', engine: 'extension', lastRun: { at: 400, verdict: 'SURPRISE', surprises: 3 } },
  ];
  const details = {
    [recordingKey(recordings[0])]: { knownWorld: { approvedAt: 900, approvedBy: 'qa1' } }, // approved since its run
    [recordingKey(recordings[1])]: { knownWorld: { approvedAt: 100, approvedBy: 'qa1' }, surpriseHistory: [[{ key: 'k', kind: 'new' }]] },
  };
  const c = approvalCandidates(recordings, details);
  assert.deepEqual(c.map((x) => [x.flowId, x.engine]), [['X', 'extension']], 'the launched copy was approved; the extension copy still waits');
  assert.deepEqual(c[0].surprises.map((s) => s.key), ['k']);
});

t.test('approval args: action approve, flow id, `by` required, note defaulted, store pinned', () => {
  assert.deepEqual(approvalArgs({ flowId: 'A', by: 'qa1', note: '  new banner is expected  ', runId: 'r', engine: 'launched' }), { action: 'approve', id: 'A', by: 'qa1', note: 'new banner is expected', engine: 'launched' });
  assert.equal(approvalArgs({ flowId: 'A', by: 'qa1', runId: 'r9' }).note, 'Approved in G9BrowserAgent desktop from run r9.');
  assert.equal(approvalArgs({ flowId: 'A', by: 'qa1', engine: 'evil' }).engine, undefined, 'only the two store names');
  assert.throws(() => approvalArgs({ flowId: 'A' }), /name of the person/);
  assert.throws(() => approvalArgs({ by: 'x' }), /flow id/);
});

t.test('schedule entries: the daemon\'s shape (target, daily|everyMinutes, runner args)', () => {
  const e = buildScheduleEntry({ target: ' suite:smoke ', env: 'staging', mode: 'daily', at: '06:30', browser: 'edge', headless: true, humanize: 'stealth', stealth: 'human', profile: 'automation' });
  assert.deepEqual(e, {
    target: 'suite:smoke', name: 'suite:smoke', enabled: true, daily: '06:30',
    // Every engine option explicitly: the run is what the form showed, whatever the defaults become.
    args: ['--env', 'staging', '--browser', 'edge', '--headless', '--humanize', 'stealth', '--stealth', 'human', '--profile', 'automation'],
    // DAEMON_PROTOCOL §6 display words, kept by the daemon; explicit args win there.
    suite: 'suite:smoke', at: '06:30', env: 'staging', engine: { browser: 'edge', headless: true, humanize: 'stealth', stealth: 'human', profile: 'automation' },
  });
  assert.ok(!('everyMinutes' in e), 'exactly one of daily / everyMinutes');
  const every = buildScheduleEntry({ target: 'rec_1', name: 'Checkout hourly', mode: 'every', everyMinutes: '60', headless: false, profile: 'berlin' });
  assert.deepEqual(every, {
    target: 'rec_1', name: 'Checkout hourly', enabled: true, everyMinutes: 60, args: ['--browser', 'auto', '--headed', '--humanize', 'human', '--stealth', 'off', '--profile', 'berlin'],
    suite: 'rec_1', engine: { browser: 'auto', headless: false, humanize: 'human', stealth: 'off', profile: 'berlin' },
  });
  assert.ok(!('at' in every) && !('env' in every), 'no display word for what was not chosen');
  assert.ok(!e.args.includes('--report'), 'the scheduler adds --report itself');
  assert.throws(() => buildScheduleEntry({ target: '', mode: 'daily', at: '06:00' }), /What to run/);
  assert.throws(() => buildScheduleEntry({ target: 'suite:x --report y', mode: 'daily', at: '06:00' }), /runner options/);
  assert.throws(() => buildScheduleEntry({ target: 'x', mode: 'daily', at: '6:00' }), /HH:MM/);
  assert.throws(() => buildScheduleEntry({ target: 'x', mode: 'every', everyMinutes: '0' }), /1 to 44640/);
  assert.throws(() => buildScheduleEntry({ target: 'x', mode: 'daily', at: '06:00', profile: '../evil' }), /Profile/);
  assert.throws(() => buildScheduleEntry({ target: 'x', mode: 'daily', at: '06:00', env: 'a b' }), /Environment/);
  assert.deepEqual(parseRunnerArgs(['--env', 'test1', '--browser', 'cft', '--headed', '--fail-on', 'SURPRISE']), { env: 'test1', browser: 'cft', headless: false, humanize: 'human', stealth: 'off', profile: 'automation', project: null, other: ['--fail-on', 'SURPRISE'] });
  // The daemon appends --project <path> for an entry with a project: not an engine option, and its
  // path must not land in the Engine column as loose words (seen in the 1100x720 render check).
  assert.equal(parseRunnerArgs(['--headless', '--project', 'C:/p/g9.project.json']).project, 'C:/p/g9.project.json');
  assert.equal(describeEngine({ args: ['--seed', '--browser', 'chrome', '--headless', '--project', 'C:/p/g9.project.json'] }), 'chrome, headless, --seed');
  assert.deepEqual(runnerArgs({ browser: 'auto', headless: undefined }), ['--browser', 'auto']);
  assert.deepEqual(runnerArgs({}), []);
  // A calibrated humanize profile is kept by name; a bad value is refused by name, never replaced.
  assert.deepEqual(buildScheduleEntry({ target: 'x', mode: 'daily', at: '06:00', humanize: 'team-qa' }).engine.humanize, 'team-qa');
  assert.ok(buildScheduleEntry({ target: 'x', mode: 'daily', at: '06:00', humanize: 'team-qa' }).args.join(' ').includes('--humanize team-qa'));
  assert.throws(() => buildScheduleEntry({ target: 'x', mode: 'daily', at: '06:00', humanize: 'a b' }), /Human input/);
  assert.throws(() => buildScheduleEntry({ target: 'x', mode: 'daily', at: '06:00', stealth: 'max' }), /Stealth level/);
  assert.throws(() => buildScheduleEntry({ target: 'x', mode: 'daily', at: '06:00', browser: 'firefox' }), /Browser/);
  assert.equal(describeWhen({ everyMinutes: 120 }), 'Every 2 hours');
  assert.equal(describeWhen({ everyMinutes: 60 }), 'Every hour');
  assert.equal(describeWhen({ everyMinutes: 15 }), 'Every 15 minutes');
  assert.equal(describeWhen({ daily: '06:30' }), 'Daily at 06:30');
  assert.equal(describeEngine({ args: ['--browser', 'edge', '--headed', '--stealth', 'stealth'] }), 'edge, headed, stealth stealth');
  assert.equal(entryEnv({ args: ['--env', 'prod-mirror'] }), 'prod-mirror');
  assert.deepEqual(lastResult({ running: true }), { label: 'Running', tone: 'live' });
  assert.deepEqual(lastResult({ lastExitCode: 0 }), { label: 'Passed', tone: 'ok' });
  assert.deepEqual(lastResult({ lastExitCode: 2 }), { label: 'Failed (exit 2)', tone: 'fail' });
  assert.deepEqual(lastResult({}), { label: 'Never ran', tone: '' });
  // g9d's lastRun (the suite's worst verdict) wins over the bare exit code.
  assert.deepEqual(lastResult({ lastExitCode: 1, lastRun: { runId: 'r1', exitCode: 1, verdict: 'SURPRISE' } }), { label: 'Surprise (exit 1)', tone: 'surprise' });
  assert.deepEqual(lastResult({ lastRun: { runId: 'r2', exitCode: 0, verdict: 'PASS' } }), { label: 'Pass', tone: 'ok' });
  assert.deepEqual(lastResult({ lastRun: { runId: 'r3', exitCode: 3, verdict: 'FAIL_PRODUCT' } }), { label: 'Product failure', tone: 'fail' });
  assert.equal(lastRunId({ lastRunId: 'old', lastRun: { runId: 'new' } }), 'new');
  assert.equal(lastRunId({ lastRunId: 'old' }), 'old');
  assert.equal(lastRunId({}), null);
  const now = new Date(2026, 8, 21, 7, 0, 0);
  assert.equal(new Date(nextDailyRun('06:30', now)).getDate(), 22, 'already past today → tomorrow');
  assert.equal(new Date(nextDailyRun('08:00', now)).getHours(), 8);
  assert.deepEqual(scheduleRows({ entries: [1] }), [1]);
});

t.test('engines.versions envelopes normalise to browsers + CfT (pinned, installed)', () => {
  const a = normalizeVersions({ browsers: [{ kind: 'edge', path: 'e.exe', version: '153.0.1' }, { kind: 'cft', path: 'c.exe', version: '153.0.7000.1' }], pinned: { version: '153.0.7000.1' } });
  assert.deepEqual(a.browsers, [{ kind: 'edge', path: 'e.exe', version: '153.0.1' }]);
  assert.deepEqual(a.cft, { pinned: '153.0.7000.1', installed: [{ version: '153.0.7000.1', path: 'c.exe' }], pinnedInstalled: true });
  const b = normalizeVersions({ installed: [{ kind: 'chrome', path: 'c', version: '1' }], cft: { pinned: '2', installed: [] } });
  assert.equal(b.cft.pinned, '2');
  assert.equal(b.cft.pinnedInstalled, false);
  assert.deepEqual(normalizeVersions(null), { browsers: [], cft: { pinned: null, installed: [], pinnedInstalled: false } });
  // The exact envelope engine/manager.js versions() returns: browsers from find.js, cft.pinned an object.
  const real = normalizeVersions({ running: [], browsers: [{ kind: 'edge', path: 'C:/e/msedge.exe', version: '153.0.3405.1' }], cft: { pinned: { version: '153.0.7000.1', platform: 'win64' }, installed: [] }, log: 'x' });
  assert.equal(real.cft.pinned, '153.0.7000.1');
  assert.equal(real.browsers.length, 1);
  // find.js failing is reported as { error } — the list is then empty, never a crash.
  assert.deepEqual(normalizeVersions({ browsers: { error: 'no registry' }, cft: { pinned: { version: '1' }, installed: [] } }).browsers, []);
  // engines.installCft: the versions report with the installed build under cft.downloaded.
  assert.deepEqual(installedCft({ cft: { downloaded: { version: '153.0.7000.1', path: 'C:/G9BrowserAgent/engines/cft-153.0.7000.1/chrome.exe' } } }, '9'), { version: '153.0.7000.1', path: 'C:/G9BrowserAgent/engines/cft-153.0.7000.1/chrome.exe' });
  assert.deepEqual(installedCft({}, '9'), { version: '9', path: null });
});

t.test('engines/agents/tabs normalise and group for the Watch picker', () => {
  const e = normalizeEngine({ engineId: 'launched-1', browser: { kind: 'edge', version: '153' }, headless: true, contexts: [{ contextId: 'c1', humanize: 'human' }], tabs: [3, { tabId: 4 }] });
  assert.equal(e.kind, 'launched');
  assert.equal(e.browser, 'edge');
  assert.deepEqual(e.tabs, [3, 4]);
  assert.equal(normalizeEngine({ engineId: 'engine-2' }).kind, 'extension');
  const a = normalizeAgent({ id: 'agent-1', client: { name: 'cursor' }, owned: [{ tabId: 3 }] });
  assert.equal(a.name, 'cursor');
  assert.deepEqual(a.owned, [3]);
  const tabs = [normalizeTab({ tabId: 3, title: 'A' }), normalizeTab({ id: 4, title: 'B' }), normalizeTab({ tabId: 9, engineId: 'engine-1' })];
  const g = groupTabs(tabs, [e]);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].tabs.map((x) => x.tabId), [3, 4]);
  assert.equal(g[1].engine.engineId, 'engine-1');
});

t.test('activity rows: the daemon tool record, engine events, and no duplicate engine copies', () => {
  const tool = describeActivity({ kind: 'tool', agentId: 'agent-2', name: 'cursor', tool: 'browser_interact', detail: 'click e7', ok: true, ms: 120, at: 5 });
  assert.deepEqual(tool, { at: 5, who: 'cursor', whoTitle: 'agent-2', what: 'browser_interact click e7', ok: true, ms: 120, kind: 'tool' });
  const failed = describeActivity({ kind: 'tool', agentId: 'agent-2', name: 'cursor', tool: 'browser_navigate', detail: 'goto x — net::ERR_NAME_NOT_RESOLVED', ok: false, ms: 9, at: 6 });
  assert.equal(failed.ok, false);
  assert.match(failed.what, /ERR_NAME_NOT_RESOLVED/);
  // The engine's copy of an agent's call repeats the daemon's record; the person's own panel action does not.
  assert.equal(isDuplicateEngineActivity({ engine: 'engine-1', kind: 'tool', tool: 'browser_snapshot', by: 'cursor', ok: true }), true);
  assert.equal(isDuplicateEngineActivity({ engine: 'engine-1', kind: 'tool', tool: 'browser_recording', ok: true }), false);
  assert.equal(isDuplicateEngineActivity({ kind: 'tool', agentId: 'agent-1', name: 'x', tool: 't' }), false);
  assert.match(describeActivity({ engine: 'engine-1', kind: 'tool', tool: 'browser_recording', detail: 'start', ok: true }).who, /side panel/);
  assert.match(describeActivity({ kind: 'dialog', engine: 'engine-1', tabId: 7, type: 'confirm', message: 'Leave?' }).what, /confirm dialog blocks tab 7: "Leave\?"/);
  assert.match(describeActivity({ kind: 'takeover', by: 'agent-3', engine: 'launched-1', tabs: [4], detail: 'agent-3 (cursor) stopped launched-1 (force)' }).what, /stopped launched-1/);
  assert.match(describeActivity({ engine: 'launched', kind: 'cft-download', percent: 42.4, version: '153.0.7000.1' }).what, /Chrome for Testing 153\.0\.7000\.1: downloading 42%/);
  assert.match(describeActivity({ engine: 'launched', kind: 'profile-warm', profile: 'automation', warmed: true }).what, /automation signed in and closed/);
  assert.match(describeActivity({ kind: 'download', engine: 'launched-1', filename: 'C:/x/report.pdf', state: 'complete', tabId: 3 }).what, /Download report\.pdf \(complete\) from tab 3/);
  assert.equal(describeActivity(null).what.length > 0, true, 'never throws on junk');
});

t.test('activity: Engine 2 panel broadcasts, the daemon detail, and the desktop\'s own reads (1100x720 check, g9d 2.0.0)', () => {
  // The daemon's detail is summarize() = "tool(args)": shown once, not "browser_recording browser_recording(list)".
  assert.equal(describeActivity({ kind: 'tool', agentId: 'agent-1', name: 'claude-code', tool: 'browser_recording', detail: 'browser_recording(list)', ok: true }).what, 'browser_recording(list)');
  assert.equal(describeActivity({ kind: 'tool', agentId: 'agent-1', name: 'x', tool: 'browser_status', detail: 'browser_status', ok: true }).what, 'browser_status');
  // Shapes measured on the wire from engine/manager.js onBroadcast.
  const wrap = (message) => ({ engine: 'launched', kind: 'engine2', message, at: 1 });
  assert.equal(unwrapEngineActivity(wrap({ type: 'state', state: { attachedTabs: [1] } })), null, 'a panel state snapshot is not activity');
  assert.equal(unwrapEngineActivity(wrap({ type: 'replayProgress', id: 'f', step: 1, total: 3 })), null);
  assert.equal(unwrapEngineActivity(wrap({ type: 'activity', entry: { kind: 'attach', tabId: 1, ok: true } })), null, 'attach/detach bookkeeping');
  const echo = unwrapEngineActivity(wrap({ type: 'activity', entry: { kind: 'tool', tool: 'browser_snapshot', tabId: 1, ok: true, detail: 'browser_snapshot', by: 'claude-code', relayed: true } }));
  assert.equal(echo.engine, 'launched');
  assert.equal(isDuplicateEngineActivity(echo), true, 'an agent call echoed by the engine is dropped like any other echo');
  const plain = { kind: 'tool', agentId: 'agent-1', tool: 't' };
  assert.equal(unwrapEngineActivity(plain), plain, 'anything else passes through unchanged');
  // Whatever arrives, never "[object Object]".
  assert.doesNotMatch(describeActivity({ engine: 'launched', kind: 'engine2', message: { type: 'state' } }).what, /\[object Object\]/);
  // The desktop's own refresh reads are not shown; its own changes are.
  assert.equal(isOwnReadActivity({ kind: 'tool', agentId: 'ui-1', name: 'g9-desktop', tool: 'browser_recording', detail: 'browser_recording(list)' }, 'ui-1'), true);
  assert.equal(isOwnReadActivity({ kind: 'tool', agentId: 'ui-1', name: 'g9-desktop', tool: 'browser_engine', detail: 'browser_engine(list)' }, 'ui-1'), true);
  assert.equal(isOwnReadActivity({ kind: 'tool', agentId: 'ui-1', name: 'g9-desktop', tool: 'browser_engine', detail: 'browser_engine(launch)' }, 'ui-1'), false);
  assert.equal(isOwnReadActivity({ kind: 'tool', agentId: 'agent-2', name: 'cursor', tool: 'browser_recording', detail: 'browser_recording(list)' }, 'ui-1'), false, 'an agent\'s reads stay');
  assert.equal(isOwnReadActivity({ kind: 'tool', agentId: 'ui-1', tool: 'browser_status' }, null), false, 'unknown own id: keep everything');
});

t.test('formatting', () => {
  assert.equal(fmtDuration(850), '850 ms');
  assert.equal(fmtDuration(4200), '4.2 s');
  assert.equal(fmtDuration(125_000), '2 min 5 s');
  assert.equal(fmtDuration(3_720_000), '1 h 2 min');
  // Rounding at the shown unit, never "1 min 60 s" or "60 s".
  assert.equal(fmtDuration(119_600), '2 min');
  assert.equal(fmtDuration(59_600), '1 min');
  assert.equal(fmtDuration(9_960), '10 s');
  assert.equal(fmtDuration(999.7), '1.0 s');
  assert.equal(fmtDuration(3_599_700), '1 h');
  assert.equal(fmtDuration(null), '—');
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(fmtAgo(1000, 1000 + 90_000), '2 min ago');
  assert.equal(shortUrl('https://example.com/a/b?q=1'), 'example.com/a/b?q=1');
  assert.equal(shortUrl(`https://e.com/${'x'.repeat(100)}`, 20).length, 20);
  assert.equal(plural(1, 'tab'), '1 tab');
  assert.equal(plural(2, 'tab'), '2 tabs');
});

t.run();
