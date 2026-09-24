/**
 * The Automation view — the whole engine, finally reachable without an agent.
 *
 * ## What changed in v1.7.0 and why
 *
 * Everything below already existed and was callable only over MCP. The panel
 * offered five commands out of nineteen: record, stop, replay, dry-run, delete.
 * So a QA working alone could produce a MACRO — proof that the steps could be
 * performed — and never a TEST, which is proof that they did something. The
 * assertion wizard, calibration, the known world and the five verdicts were all
 * invisible to the people the tool exists for.
 *
 * Three of these deserve their reasoning restated where the code lives:
 *
 * - **The verdict was always computed and thrown away.** `replay()` returns
 *   `verdict`, `surpriseLines` and `knownWorld` on every call, including the
 *   panel's. The old report rendered `passed/failed/warnings` and dropped the
 *   rest — so the surprise detector, the most original thing in the tool, had
 *   no user interface at all.
 *
 * - **Approve belongs to a human, so it belongs here.** The known world may
 *   only be grown by a person who looked at a run. It was previously reachable
 *   only through MCP — by the agent, the one caller it was written to exclude.
 *
 * - **The wizard proposes; the person decides.** `suggest` returns each
 *   candidate with a strength and a reason, and adds nothing by itself. Shown
 *   as checkboxes, that becomes a thirty-second job. A weak assertion someone
 *   consciously accepted is a decision; one a tool added quietly is a blind spot.
 */

import { el, cmd, node, row, toast, showPanelError, ago, view } from './ui.js';

let recording = false;
/** A start or stop is on its way to the service worker. */
let recBusy = false;
/** The last recStatus answer, so a busy repaint keeps the same text. */
let lastRecStatus = { recording: false };
let lastRecElsewhere = [];
let lastRecHalted = false;

/**
 * What the Record controls show (F8). Pure; exported for the unit test.
 *
 * `startRecording` refuses a tab that is already recording (tools/record.js: a
 * second start used to replace the session, leak the first one's scripts into
 * every later page of the tab and lose its steps). So while THIS tab records,
 * the Record button is disabled and says why, and "Stop and save" is the
 * action; while a start or stop is on its way, neither can be pressed again —
 * a double click was exactly a second start. Another tab recording does not
 * block this one (sessions are per tab), but it is named, because the panel
 * otherwise shows nothing about it.
 */
export function recordControls(status = {}, { busy = false, elsewhere = [], halted = false } = {}) {
  const on = !!status?.recording;
  const name = status?.name ? `"${status.name}"` : 'a flow';
  let why = '';
  if (on && halted) {
    // Stop blocks agents, not the person's own save (sw.js recStop runs as the person).
    why = `Agents are stopped; this tab is still recording ${name}. Stop and save works while Stop is on.`;
  } else if (on) {
    why = `This tab is already recording ${name}. Stop and save it before starting another — ` +
      'a second start on the same tab is refused.';
  } else if (halted) {
    why = 'Agents are stopped. Press Resume to record.';
  } else if (busy) {
    why = 'Starting…';
  }
  const others = (Array.isArray(elsewhere) ? elsewhere : []).filter((r) => r && r.tabId != null);
  const note = others.length
    ? ` Also recording in another tab: ${others.map((r) => `${r.name ? `"${r.name}"` : 'a flow'} (tab ${r.tabId})`).join(', ')}.`
    : '';
  return {
    startDisabled: on || busy || halted,
    startTitle: on || halted ? why : busy ? 'Starting…' : 'Record what you do in this tab',
    stopHidden: !on,
    stopDisabled: busy,
    why: (why + note).trim(),
  };
}

function paintRecordControls() {
  const c = recordControls(lastRecStatus, { busy: recBusy, elsewhere: lastRecElsewhere, halted: lastRecHalted });
  el.recToggle.disabled = c.startDisabled;
  el.recToggle.title = c.startTitle;
  el.recToggle.setAttribute?.('aria-disabled', String(c.startDisabled));
  el.recStop.hidden = c.stopHidden;
  el.recStop.disabled = c.stopDisabled;
  el.recWhy.textContent = c.why;
  el.recWhy.hidden = !c.why;
}

/** Flow ids whose detail row is expanded. */
const expanded = new Set();
/**
 * The run happening right now, if any.
 *
 * A replay used to be a single message that returned when everything was over.
 * On a twenty-step flow that is half a minute of a panel showing nothing at all,
 * and the first thing a tester asks is whether the button actually did anything.
 * The service worker now announces each step as it STARTS, and this is where
 * those announcements land.
 */
let liveRun = null;
let liveTimer = null;

const api = globalThis.browser ?? globalThis.chrome;
api?.runtime?.onMessage?.addListener((msg) => {
  if (!msg?.__g9 || msg.type !== 'replayProgress' || !liveRun || msg.id !== liveRun.id) return;
  liveRun.step = msg.step;
  liveRun.total = msg.total;
  liveRun.describe = msg.describe;
  liveRun.stepStartedAt = Date.now();
  paintProgress();
});

/** Last replay result per flow id, so a re-render does not lose the report. */
const lastResult = new Map();
let suiteRun = null;

const VERDICT = {
  PASS: { icon: '✅', cls: 'good', text: 'Passed' },
  PASS_WITH_WARNING: { icon: '⚠️', cls: 'warn', text: 'Passed with warnings' },
  SURPRISE: { icon: '🔎', cls: 'warn', text: 'Surprise — it did something new' },
  FAIL_PRODUCT: { icon: '❌', cls: 'bad', text: 'Product failure' },
  FAIL_AUTOMATION: { icon: '🔧', cls: 'bad', text: 'Test failure (not the product)' },
};

/**
 * What each verdict means for the person reading it.
 *
 * The separation of FAIL_PRODUCT from FAIL_AUTOMATION is the whole point of the
 * classification, and it only pays off if the reader is told what to do
 * differently. A pipeline that reports a rotted locator as a product regression
 * teaches people to ignore it.
 */
const VERDICT_ADVICE = {
  PASS: '',
  PASS_WITH_WARNING: 'The flow still works but is drifting — usually a locator that now matches more weakly.',
  SURPRISE: 'Something happened that has never happened on this flow. Read it, then Approve if it is the new normal.',
  FAIL_PRODUCT: 'The product did the wrong thing. This is a bug — file it from the Issues tab.',
  FAIL_AUTOMATION: 'The test could not run, so this says nothing about the product. An element moved or was renamed, or the browser never delivered the input — check the step message.',
};

export async function refresh() {
  if (view.active !== 'automation') return;
  let res;
  try {
    res = await cmd({ cmd: 'recStatus' });
  } catch (err) {
    el.recCount.textContent = 'refresh failed';
    return showPanelError('Automation refresh failed: ' + (err?.message ?? err), { source: 'refresh' });
  }
  if (!res?.ok) return showPanelError(res?.error ?? 'Automation refresh failed.', { source: 'refresh' });

  recording = !!res.status?.recording;
  lastRecStatus = res.status ?? { recording: false };
  lastRecElsewhere = Array.isArray(res.elsewhere) ? res.elsewhere : [];
  lastRecHalted = res.halted === true;
  paintRecordControls();
  el.recLive.hidden = !recording;
  if (recording) {
    const st = res.status;
    el.recLive.textContent =
      `Recording "${st.name}" — ${st.steps} step${st.steps === 1 ? '' : 's'}` +
      (st.lastStep ? ` · last: ${st.lastStep}` : ' · go and use the page');
  }

  renderList(res.recordings ?? []);
}

function renderList(list) {
  el.recCount.textContent = list.length ? `${list.length} saved` : '';
  el.recEmpty.hidden = list.length > 0;
  el.suiteCard.hidden = list.length === 0;
  el.recList.innerHTML = '';

  for (const r of list) {
    const verdict = VERDICT[r.lastRun?.verdict] ?? null;
    const bits = [
      r.suite ? r.suite : null,
      `${r.stepCount} steps`,
      r.assertionCount ? `${r.assertionCount} checks` : 'no checks yet',
      r.lastRun ? `${verdict?.icon ?? ''} ${ago(r.lastRun.at ?? r.updatedAt)}` : 'never run',
      r.flaky?.detected ? 'possibly flaky' : null,
    ].filter(Boolean);

    const li = row(
      r.name,
      bits.join(' · '),
      [
        liveRun?.id === r.id
          ? ['■', 'danger', () => stopRun(), 'Stop this run']
          : ['▶', 'primary', () => runReplay(r.id, false), 'Replay for real'],
        ['🔍', '', () => runReplay(r.id, true), 'Dry run — resolve every step, change nothing'],
        [expanded.has(r.id) ? '▴' : '▾', '', () => toggle(r.id), 'More'],
      ],
      () => toggle(r.id),
    );
    el.recList.append(li);

    if (liveRun?.id === r.id) el.recList.append(progressRow(r));
    if (expanded.has(r.id)) el.recList.append(detailRow(r));
    const result = lastResult.get(r.id);
    if (result) el.recList.append(reportRow(r.id, result));
  }
}

function toggle(id) {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  refresh();
}

/** The row that holds everything the panel could not previously do. */
function detailRow(r) {
  const li = node('li', 'detail');
  const acts = node('div', 'btnrow wrap');

  acts.append(
    button('✦ Add checks', 'primary sm', () => openWizard(r.id), 'Ask the tool what is worth asserting here'),
    button('⚖ Calibrate', 'ghost sm', () => calibrate(r.id), 'Run twice on this build and mark what differs as noise'),
    button('✓ Approve', 'ghost sm', () => approve(r.id), 'Fold the last run into this flow’s known world'),
    button('📜 History', 'ghost sm', () => history(r.id), 'Past runs and the known world'),
    button('⬆ Push', 'ghost sm', () => push([r.id]), 'Write this flow to the repo'),
    button('⤓ Playwright', 'ghost sm', () => exportTest(r.id), 'Export as a Playwright test'),
    button('✕ Delete', 'ghost sm danger', () => remove(r.id)),
  );

  const meta = node('div', 'metaedit');
  meta.append(
    field('Section', r.folder ?? '', (v) => patch(r.id, { folder: v })),
    field('Suite', r.suite ?? '', (v) => patch(r.id, { suite: v })),
    field('Tags', (r.tags ?? []).join(', '), (v) =>
      patch(r.id, { tags: v.split(',').map((t) => t.trim()).filter(Boolean) }),
    ),
    field('Covers (TC ids)', (r.qaTestCaseIds ?? []).join(', '), (v) =>
      patch(r.id, { qaTestCaseIds: v.split(',').map((t) => t.trim()).filter(Boolean) }),
    ),
  );

  li.append(acts, meta, node('div', 'wizard', ''));
  li.querySelector('.wizard').id = `wizard-${r.id}`;
  return li;
}

function button(label, cls, fn, title) {
  const b = node('button', cls, label);
  if (title) b.title = title;
  b.addEventListener('click', fn);
  return b;
}

function field(label, value, onSave) {
  const wrap = node('label', 'metafield');
  wrap.append(node('span', null, label));
  const input = document.createElement('input');
  input.value = value;
  input.spellcheck = false;
  input.addEventListener('change', () => onSave(input.value.trim()));
  wrap.append(input);
  return wrap;
}

// ------------------------------------------------------------- the wizard

/**
 * The assertion wizard: proposals with reasons, and nothing ticked by default.
 *
 * `blocked` candidates are shown greyed rather than hidden, because "you cannot
 * assert a clean console here — the page already has 3 errors" is one of the
 * most useful things the tool ever says. Hiding it would leave the reader
 * wondering why the obvious check is missing.
 */
async function openWizard(id) {
  const box = document.getElementById(`wizard-${id}`);
  if (!box) return;
  box.innerHTML = '';
  box.append(node('p', 'muted', 'Looking at what this flow actually did…'));

  let res;
  try {
    res = await cmd({ cmd: 'recSuggest', id });
  } catch (err) {
    box.innerHTML = '';
    return box.append(node('p', 'warn', `Could not suggest: ${err?.message ?? err}`));
  }
  if (!res?.ok) {
    box.innerHTML = '';
    return box.append(node('p', 'warn', res?.error ?? 'Could not suggest assertions.'));
  }

  const list = res.suggestions ?? res.assertions ?? [];
  box.innerHTML = '';
  if (!list.length) {
    return box.append(node('p', 'muted', 'Nothing to propose for this flow yet — try running it once first.'));
  }

  box.append(node('div', 'nm', 'Suggested checks — tick the ones you want'));
  const form = node('div', 'wizlist');
  for (const [index, s] of list.entries()) {
    const line = node('label', `wizrow ${s.strength === 'blocked' ? 'blocked' : ''}`);
    const box2 = document.createElement('input');
    box2.type = 'checkbox';
    box2.disabled = s.strength === 'blocked';
    box2.dataset.index = String(index);
    line.append(
      box2,
      node('span', 'kind', s.kind ?? s.assertion ?? '?'),
      node('span', `strength ${s.strength ?? ''}`, s.strength ?? ''),
      node('span', 'why', s.reason ?? ''),
    );
    form.append(line);
  }
  box.append(form);

  const add = button('Add selected checks', 'primary sm', async () => {
    const chosen = [...form.querySelectorAll('input:checked')].map((c) => list[Number(c.dataset.index)]);
    if (!chosen.length) return toast('Nothing ticked.');
    let added = 0;
    for (const s of chosen) {
      const res2 = await cmd({ cmd: 'recAssert', id, assertion: s.assertion ?? s });
      if (res2?.ok) added += 1;
      else showPanelError(res2?.error ?? 'Could not add a check.');
    }
    toast(`${added} check${added === 1 ? '' : 's'} added`);
    box.innerHTML = '';
    refresh();
  });
  const actions = node('div', 'btnrow');
  actions.append(add);
  box.append(actions);
}

// ------------------------------------------------------------------ actions

async function runReplay(id, dryRun) {
  if (liveRun) return toast('A flow is already running — stop it first.');
  lastResult.delete(id);

  const rec = (await cmd({ cmd: 'recStatus' }).catch(() => null))?.recordings?.find((r) => r.id === id);
  liveRun = {
    id,
    dryRun,
    step: 0,
    total: rec?.stepCount ?? 0,
    describe: null,
    stepStartedAt: null,
    startedAt: Date.now(),
    // The last run's duration is the only honest basis for an estimate, and it
    // is labelled as one. A countdown invented from nothing reads as a promise.
    estimateMs: rec?.lastRun?.durationMs ?? rec?.durationMs ?? null,
  };
  // A ticking clock, because a bar that only moves on step changes looks frozen
  // during exactly the slow step somebody is worried about.
  liveTimer = setInterval(paintProgress, 250);
  refresh();

  let res;
  let failure = null;
  try {
    res = await cmd({ cmd: 'recReplay', id, dryRun });
    if (!res?.ok) failure = res?.error ?? 'Replay could not start.';
  } catch (err) {
    failure = `Replay could not run: ${err?.message ?? err}`;
  }

  // Torn down BEFORE anything repaints. A `finally` would not do: its body runs
  // after the `return` expression is evaluated, so an error path would repaint
  // while the run still looked live and leave a stuck progress bar and a Stop
  // button on a flow that had already finished.
  endRun();
  if (failure) return showPanelError(failure);

  lastResult.set(id, res);
  refresh();
}

function endRun() {
  clearInterval(liveTimer);
  liveTimer = null;
  liveRun = null;
  if (haltedForRun) {
    haltedForRun = false;
    cmd({ cmd: 'resume' }).catch(() => {}).then(refresh);
  }
  refresh();
}

/**
 * Stop the run — and only the run.
 *
 * The mechanism is the global halt flag, because that is the one thing replay
 * already checks between steps. But the INTENT of pressing ■ on a flow is "stop
 * this flow", not "disarm the agent until somebody remembers to re-arm it", and
 * leaving the browser halted afterwards would strand the next person on a panel
 * where nothing works and the reason is two clicks away in another tab.
 *
 * So the halt is scoped: raised here, and lowered again in `endRun()` — but only
 * if this is who raised it. A halt the USER pressed in the header stays up.
 */
let haltedForRun = false;

async function stopRun() {
  haltedForRun = true;
  await cmd({ cmd: 'halt' }).catch(() => {});
  toast('Stopping after the current step…');
}

/** Repaint just the progress strip, without re-rendering the whole list. */
function paintProgress() {
  const strip = document.getElementById('runProgress');
  if (!strip || !liveRun) return;
  const { bar, label } = describeProgress(liveRun);
  const fill = strip.querySelector('.bar > i');
  if (fill) fill.style.width = `${Math.round(bar * 100)}%`;
  const text = strip.querySelector('.runlabel');
  if (text) text.textContent = label;
}

/**
 * How far along, and how much longer.
 *
 * Two numbers with different standing, and the bar is built so it can never
 * confuse them. The STEP COUNT is the skeleton: the bar's floor is the fraction
 * of steps that have actually finished, its ceiling is the step now running.
 * TIME only interpolates between those two, so it can make a long step look
 * alive without ever claiming that step is over.
 *
 * The first version let time run the whole bar (`max(byStep, byTime)`), and on a
 * five-step flow it slid to the end in a couple of seconds while the label still
 * read "step 0/5". A bar that finishes before the work does is worse than no
 * bar: it is a claim, and it is wrong.
 *
 * The pace comes from THIS run wherever possible — once k steps have started,
 * the time they took divided by k-1 is a measurement, and it corrects itself as
 * the run goes on. The previous run's total is only a prior, used before the
 * first step lands.
 */
function describeProgress(run) {
  const now = Date.now();
  const elapsed = now - run.startedAt;
  const total = run.total || 0;
  const started = Math.max(0, Math.min(run.step ?? 0, total));

  // How long one step takes: measured if this run has given us anything to
  // measure, otherwise borrowed from the last run, otherwise a plain guess.
  const prior = run.estimateMs && total ? run.estimateMs / total : 4000;
  const perStep = started > 1 ? elapsed / (started - 1) : prior;

  const floor = total ? Math.max(0, started - 1) / total : 0;
  const ceil = total ? started / total : 0;
  const inStep = run.stepStartedAt
    // Capped below 1: the current step is not finished until the NEXT one is
    // announced, and a bar that reaches a step's ceiling early has to sit still
    // there, which reads as a freeze.
    ? Math.min((now - run.stepStartedAt) / Math.max(perStep, 400), 0.92)
    : 0;
  // Capped below full while the run is still going: on the LAST step the ceiling
  // is 1.0, so the creep rounds to 100% with the step still running — and a full
  // bar sitting there is exactly when somebody decides it has hung.
  const bar = Math.min(floor + (ceil - floor) * inStep, 0.98);

  const secs = (ms) => `${Math.max(0, Math.round(ms / 1000))}s`;
  let time;
  if (!started) {
    time = run.estimateMs ? `~${secs(Math.max(0, run.estimateMs - elapsed))} left` : `${secs(elapsed)} elapsed`;
  } else {
    const thisStepLeft = Math.max(0, perStep - (now - (run.stepStartedAt ?? now)));
    time = `~${secs((total - started) * perStep + thisStepLeft)} left`;
  }

  const where = started ? `step ${started}/${total}` : `starting${total ? ` · ${total} steps` : ''}`;
  return { bar, label: `${where} · ${time}${run.describe ? ` · ${run.describe}` : ''}` };
}

function progressRow(rec) {
  const li = node('li', 'reportrow');
  const box = node('div', 'report running');
  box.id = 'runProgress';

  const head = node('div', 'nm', liveRun.dryRun ? 'Dry run in progress' : 'Running');
  const bar = node('div', 'bar');
  bar.append(node('i', ''));
  const label = node('div', 'runlabel sub', '');

  box.append(head, bar, label);
  li.append(box);
  // Fill it in immediately rather than waiting for the first tick.
  queueMicrotask(paintProgress);
  return li;
}

async function calibrate(id) {
  toast('Running this flow twice to learn what is just noise…');
  const res = await cmd({ cmd: 'recCalibrate', id }).catch((err) => ({ ok: false, error: String(err) }));
  if (!res?.ok) return showPanelError(res?.error ?? 'Calibration failed.');
  toast(
    `Calibrated — ${res.volatile?.length ?? 0} volatile item${res.volatile?.length === 1 ? '' : 's'} will now be ignored`,
  );
  refresh();
}

async function approve(id) {
  const res = await cmd({ cmd: 'recApprove', id }).catch((err) => ({ ok: false, error: String(err) }));
  if (!res?.ok) return showPanelError(res?.error ?? 'Could not approve.');
  toast('Approved — this run is now the known normal for this flow');
  refresh();
}

async function history(id) {
  const res = await cmd({ cmd: 'recKnownWorld', id }).catch((err) => ({ ok: false, error: String(err) }));
  if (!res?.ok) return showPanelError(res?.error ?? 'Could not read history.');
  const box = document.getElementById(`wizard-${id}`);
  if (!box) return;
  box.innerHTML = '';
  const runs = res.runHistory ?? [];
  box.append(node('div', 'nm', `Last ${runs.length} run${runs.length === 1 ? '' : 's'}`));
  if (!runs.length) box.append(node('p', 'muted', 'Never run.'));
  for (const run of [...runs].reverse()) {
    const v = VERDICT[run.verdict] ?? {};
    box.append(
      node('div', 'sub', `${v.icon ?? '·'} ${run.verdict ?? '?'} — ${run.passed}/${run.passed + run.failed} in ${run.durationMs}ms · ${ago(run.at)}`),
    );
  }
  box.append(
    node(
      'div',
      'sub',
      res.knownWorld?.runs
        ? `Known world: built from ${res.knownWorld.runs} approved run(s).`
        : 'Known world: not established yet — approve a run you trust.',
    ),
  );
}

async function patch(id, fields) {
  const res = await cmd({ cmd: 'recUpdate', id, patch: fields }).catch((err) => ({ ok: false, error: String(err) }));
  if (!res?.ok) return showPanelError(res?.error ?? 'Could not save.');
  toast('Saved');
  refresh();
}

async function remove(id) {
  await cmd({ cmd: 'recDelete', id });
  expanded.delete(id);
  lastResult.delete(id);
  refresh();
}

async function exportTest(id) {
  const res = await cmd({ cmd: 'recExportTest', id }).catch((err) => ({ ok: false, error: String(err) }));
  if (!res?.ok) return showPanelError(res?.error ?? 'Could not export.');
  await navigator.clipboard.writeText(res.test ?? res.code ?? '');
  toast('Playwright test copied to the clipboard');
}

// --------------------------------------------------------------- the report

/**
 * Show the whole outcome, not a verdict.
 *
 * The failing step's message is the product of this feature — which element,
 * what it looked for, what is on the page instead. And the surprises are the
 * part no other tool reports at all: a request that always happened and did not
 * this time is a button that no longer does anything, and nobody ever writes an
 * assertion for that.
 */
function reportRow(id, res) {
  const li = node('li', 'reportrow');
  const v = VERDICT[res.verdict] ?? { icon: '·', cls: '', text: res.verdict ?? 'done' };
  const box = node('div', `report ${v.cls}`);

  const bad = res.steps?.find((s) => !s.ok);
  box.append(
    node(
      'div',
      'nm',
      `${v.icon} ${v.text} — ${res.passed}/${res.total}${res.durationMs != null ? ` in ${res.durationMs}ms` : ''}` +
        (res.dryRun ? ' (dry run)' : ''),
    ),
  );
  if (VERDICT_ADVICE[res.verdict]) box.append(node('div', 'advice', VERDICT_ADVICE[res.verdict]));
  if (bad) box.append(node('div', 'failline', `Step ${bad.step} of ${res.total}: ${bad.error}`));
  for (const w of res.warnings ?? []) box.append(node('div', 'warn', w));

  for (const line of res.surpriseLines ?? []) box.append(node('div', 'surprise', line));

  if (res.knownWorld && !res.dryRun) {
    box.append(
      node(
        'div',
        'sub',
        res.knownWorld.runs
          ? `Compared against ${res.knownWorld.runs} approved run(s).`
          : (res.knownWorld.note ?? 'No known world yet — nothing to compare against.'),
      ),
    );
  }

  if (res.verdict === 'SURPRISE' || res.verdict === 'PASS_WITH_WARNING') {
    const acts = node('div', 'btnrow');
    acts.append(button('✓ This is the new normal', 'ghost sm', () => approve(id)));
    box.append(acts);
  }

  const dismiss = node('button', 'link', 'dismiss');
  dismiss.addEventListener('click', () => {
    lastResult.delete(id);
    refresh();
  });
  box.append(dismiss);

  li.append(box);
  return li;
}

// ------------------------------------------------------------- suite + sync

/**
 * Run every flow in the library, one after another.
 *
 * Sequential on purpose. A browser delivers input only to the tab it is
 * showing, so two flows running at once would have one of them clicking into a
 * hidden page — the exact failure v1.4.0 was released to stop reporting as
 * success.
 */
async function runAll() {
  const res = await cmd({ cmd: 'recStatus' });
  const list = (res?.recordings ?? []).filter((r) => !r.tags?.includes('@manual'));
  if (!list.length) return toast('No flows to run.');

  suiteRun = { total: list.length, done: 0, results: [] };
  el.suiteBtn.disabled = true;
  for (const r of list) {
    suiteRun.done += 1;
    el.suiteProgress.textContent = `Running ${suiteRun.done}/${suiteRun.total} — ${r.name}`;
    const out = await cmd({ cmd: 'recReplay', id: r.id, dryRun: false }).catch((err) => ({
      ok: false,
      error: String(err),
      verdict: 'FAIL_AUTOMATION',
    }));
    suiteRun.results.push({ name: r.name, verdict: out?.verdict ?? 'FAIL_AUTOMATION', ok: out?.ok });
    lastResult.set(r.id, out);
  }
  el.suiteBtn.disabled = false;
  renderSuiteSummary();
  refresh();
}

function renderSuiteSummary() {
  if (!suiteRun) return;
  const counts = {};
  for (const r of suiteRun.results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  el.suiteProgress.textContent = Object.entries(counts)
    .map(([verdict, n]) => `${VERDICT[verdict]?.icon ?? '·'} ${n} ${verdict}`)
    .join('   ');
}

async function syncStatus() {
  let res;
  try {
    res = await cmd({ cmd: 'flowStatus' });
  } catch (err) {
    el.syncLine.textContent = String(err?.message ?? err);
    return;
  }
  if (!res?.ok) {
    el.syncLine.textContent = res?.error ?? 'Could not reach the flow library.';
    return;
  }
  const parts = [];
  if (res.onlyInRepo?.length) parts.push(`↓ ${res.onlyInRepo.length} new in repo`);
  if (res.onlyLocal?.length) parts.push(`↑ ${res.onlyLocal.length} not in repo`);
  if (res.differing?.length) parts.push(`⇅ ${res.differing.length} differ`);
  el.syncLine.textContent = parts.length ? parts.join(' · ') : `In sync — ${res.total} flow(s) in the repo.`;
}

async function pull() {
  const res = await cmd({ cmd: 'flowPull' }).catch((err) => ({ ok: false, error: String(err) }));
  if (!res?.ok) return showPanelError(res?.error ?? 'Pull failed.');
  toast(`${res.imported} flow(s) pulled from the repo`);
  // Every problem, not just the last: each one is a flow that did not come over.
  if (res.problems?.length) showPanelError(res.problems.join('\n'));
  syncStatus();
  refresh();
}

async function push(ids) {
  const res = await cmd({ cmd: 'flowPush', ids }).catch((err) => ({ ok: false, error: String(err) }));
  if (!res?.ok) return showPanelError(res?.error ?? 'Push failed.');
  toast(
    res.changed
      ? `${res.changed} file(s) written — commit them on a branch off dev`
      : `${res.written} flow(s) already up to date`,
  );
  const lines = [...(res.problems ?? []), ...(res.notes ?? [])];
  if (lines.length) showPanelError(lines.join('\n'));
  syncStatus();
}

// -------------------------------------------------------------------- wiring

export function wire() {
  // Two buttons, not one toggle (F8): Record is disabled, with the reason
  // shown, while this tab records; Stop and save is the action then.
  const recordCommand = async (which) => {
    if (recBusy) return;
    if (which === 'recStart' && recording) return; // disabled, but never trust a stale button
    recBusy = true;
    paintRecordControls();
    try {
      const res = await cmd({ cmd: which });
      if (!res?.ok) return showPanelError(res?.error ?? 'Recording command failed.');
      toast(which === 'recStop' ? `Saved "${res.name}" — ${res.steps} steps` : 'Recording — go and use the page');
    } catch (err) {
      showPanelError(`Recording command failed: ${err?.message ?? err}`);
    } finally {
      recBusy = false;
      paintRecordControls();
      refresh();
    }
  };
  el.recToggle.addEventListener('click', () => recordCommand('recStart'));
  el.recStop.addEventListener('click', () => recordCommand('recStop'));

  el.suiteBtn.addEventListener('click', runAll);
  el.syncPull.addEventListener('click', pull);
  el.syncPush.addEventListener('click', () => push());
  el.syncRefresh.addEventListener('click', syncStatus);
}

export { syncStatus };
