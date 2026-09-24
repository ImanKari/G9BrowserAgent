/**
 * Runs: every flow run the daemon recorded (runs.list / runs.get), with the verdict, the steps,
 * the surprises, and a replay of the run's frames with the cursor drawn from its pointer track.
 * "Export video" records that replay (canvas + MediaRecorder, plan §P6.3) into
 * runs/<runId>/video.webm.
 */

import { h, replace, icon } from '../lib/dom.js';
import { fmtDateTime, fmtDuration, fmtBytes } from '../lib/format.js';
import { normalizeRun, runRows, recordingRows, verdictTone, verdictLabel, surpriseSeverity, surpriseText, flowsOf, kindLabel, VERDICTS } from '../lib/runs.js';
import { fitRect, viewportToCanvas, interpolateTrack, frameIndexAt } from '../lib/track.js';
import { api, store, toast, toastError, viewHead, empty, chip, notConnected, busy, go, select } from '../ui.js';
import { drawCursor } from './watch.js';

let root = null;
let listEl = null;
let detailEl = null;
let filterEl = null;
let runs = [];
let selected = null;
let listLoadedWhileConnected = false;
let detailShown = false;

export function mount(el, opts = {}) {
  root = el;
  listEl = h('div', { class: 'surface runs-list' });
  detailEl = h('div', { class: 'run-detail' });
  filterEl = select([
    { value: 'all', label: 'All runs' },
    { value: 'attention', label: 'Needs attention' },
    ...VERDICTS.map((v) => ({ value: v, label: verdictLabel(v) })),
  ], 'all', { 'aria-label': 'Filter runs by verdict' });
  filterEl.addEventListener('change', renderList);
  const refresh = h('button', { type: 'button', class: 'btn' }, icon('refresh', { size: 15 }), 'Refresh');
  refresh.addEventListener('click', () => busy(refresh, () => loadList(true)));
  replace(el,
    viewHead('Runs', 'Every flow run the daemon recorded, newest first. Select one for its steps, its surprises and a replay with the cursor.', [filterEl, refresh]),
    h('div', { class: 'runs-layout' }, listEl, detailEl));
  if (opts.runId) selected = String(opts.runId);
  detailShown = false;
  renderDetailEmpty();
  loadList(false);
}

export function unmount() {
  player.stop();
  player.cancelExport?.();
  root = null;
}

export function update(s) {
  if (!root) return;
  if (s.connection?.status === 'connected' && !listLoadedWhileConnected) loadList(false);
  if (s.connection?.status !== 'connected') listLoadedWhileConnected = false;
}

let reloadTimer = null;
export function onEvent(e) {
  if (!root || e.topic !== 'run') return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => loadList(false), 800);
}

async function loadList(announce) {
  if (!store.connected) {
    replace(listEl, notConnected('The run list'));
    return;
  }
  try {
    const [list, recs] = await Promise.all([
      api.admin('runs.list', { limit: 300 }),
      // A replay run is labelled with its recording id; the recording list gives it a readable name.
      api.call('browser_recording', { action: 'list' }).catch(() => null),
    ]);
    const names = new Map(recordingRows(recs).map((r) => [String(r.id), r.name]));
    runs = runRows(list).map(normalizeRun).map((r) => (r.flowId && names.has(String(r.flowId)) ? { ...r, flowName: names.get(String(r.flowId)) } : r))
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    listLoadedWhileConnected = true;
    if (!root) return;
    renderList();
    // Re-open the selection only when asked (or on first load): a background 'run' event must not
    // yank a replay someone is watching back to its first frame.
    if (selected && runs.some((r) => r.runId === selected) && (announce || !detailShown)) openRun(selected, { keepTab: true });
    if (announce) toast('Runs refreshed.');
  } catch (err) {
    replace(listEl, h('p', { class: 'pad muted' }, `Could not list runs: ${err.message}`));
  }
}

function filtered() {
  const f = filterEl?.value ?? 'all';
  if (f === 'all') return runs;
  if (f === 'attention') return runs.filter((r) => r.verdict && !['PASS', 'RUNNING', 'WATCH', 'FINISHED'].includes(r.verdict));
  return runs.filter((r) => r.verdict === f);
}

function renderList() {
  const rows = filtered();
  if (!runs.length) {
    replace(listEl, h('div', { class: 'pad' }, empty('No runs yet', 'A run appears here when an agent, the runner or the schedule replays a flow on an engine.', [
      h('button', { type: 'button', class: 'btn', onclick: () => go('schedule') }, 'Schedule a suite'),
    ])));
    return;
  }
  if (!rows.length) {
    replace(listEl, h('p', { class: 'pad muted' }, 'No run matches this filter.'));
    return;
  }
  // Two columns, two lines each: the list is narrow, and a flow name squeezed to "C…" helps nobody.
  replace(listEl, h('table', { class: 'grid' },
    h('colgroup', null, h('col'), h('col', { style: { width: '124px' } })),
    h('thead', null, h('tr', null, h('th', null, 'Flow and verdict'), h('th', null, 'Started'))),
    h('tbody', null, rows.map((r) => {
      const tr = h('tr', { class: 'selectable', tabindex: 0, 'aria-selected': String(r.runId === selected) },
        h('td', { title: r.flowName ?? r.runId },
          h('div', { class: 'ellipsis', style: { fontWeight: 600 } }, r.flowName ?? r.runId),
          h('div', { class: 'row', style: { gap: '6px', marginTop: '3px', flexWrap: 'nowrap' } },
            chip(verdictLabel(r.verdict), verdictTone(r.verdict)),
            r.kind && r.kind !== 'replay' && r.kind !== 'watch' ? h('span', { class: 'muted small nowrap' }, kindLabel(r.kind)) : null,
            r.surpriseCount?.total ? h('span', { class: 'muted small nowrap' }, `${r.surpriseCount.total} surprise${r.surpriseCount.total === 1 ? '' : 's'}`) : null)),
        h('td', { class: 'muted nowrap' }, h('div', null, fmtDateTime(r.startedAt)), h('div', { class: 'small' }, r.status === 'running' ? 'in progress' : `took ${fmtDuration(r.durationMs)}`)));
      const open = () => openRun(r.runId);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
      return tr;
    }))));
}

function renderDetailEmpty() {
  replace(detailEl, h('div', { class: 'surface pad' }, empty('Select a run', 'Its steps, surprises and replay appear here.')));
}

let activeTab = 'steps';

async function openRun(runId, { keepTab = false } = {}) {
  selected = runId;
  renderList();
  if (!keepTab) activeTab = 'steps';
  player.stop();
  const base = runs.find((r) => r.runId === runId);
  let run = base;
  replace(detailEl, h('div', { class: 'surface pad muted' }, h('span', { class: 'spinner' }), ' Loading the run…'));
  try {
    const full = await api.invoke('runs.detail', { runId });
    run = normalizeRun({ ...(base?.raw ?? {}), ...(full ?? {}) });
    // Keep the readable name the list resolved from the recordings.
    if (base?.flowName && run.flowName === run.flowId) run = { ...run, flowName: base.flowName };
  } catch (err) {
    if (!base) {
      replace(detailEl, h('div', { class: 'surface pad' }, h('p', null, `Could not load run ${runId}: ${err.message}`)));
      return;
    }
    toastError(err);
  }
  // A replay run keeps its verdict and counts on disk; the surprises themselves live in the
  // recording (its surpriseHistory). Fetch them when this run is the recording's latest.
  if (run && run.flowId && !run.surprises.length && (run.kind === 'replay' || run.kind === 'calibrate')) {
    run = { ...run, recordingSurprises: await surprisesFromRecording(run).catch(() => null) };
  }
  if (selected !== runId || !root) return;
  detailShown = true;
  renderDetail(run);
}

async function surprisesFromRecording(run) {
  const rec = await api.call('browser_recording', { action: 'get', id: String(run.flowId), engine: 'launched' });
  const last = rec?.lastRun;
  const history = Array.isArray(rec?.surpriseHistory) ? rec.surpriseHistory : [];
  if (!last || !history.length) return null;
  // Only when the recording's latest run is this run (finished within two minutes of each other).
  if (run.endedAt && last.at && Math.abs(last.at - run.endedAt) > 120_000) return { stale: true, count: 0, items: [] };
  const items = history[history.length - 1] ?? [];
  return { stale: false, count: Number(last.surprises) || items.length, items };
}

function renderDetail(run) {
  const flows = flowsOf(run);
  const stepCount = flows.reduce((n, f) => n + f.steps.length, 0);
  const surpriseCount = flows.reduce((n, f) => n + f.surprises.length, 0) || run.recordingSurprises?.items?.length || run.surpriseCount?.total || 0;
  const tabs = [
    ['steps', flows.length > 1 ? `Flows (${flows.length})` : `Steps${stepCount ? ` (${stepCount})` : ''}`],
    ['surprises', `Surprises (${surpriseCount})`],
    ['replay', 'Replay'],
  ];
  const body = h('div');
  const tabBar = h('div', { class: 'subtabs', role: 'tablist' }, tabs.map(([id, label]) => {
    const b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(id === activeTab) }, label);
    b.addEventListener('click', () => {
      activeTab = id;
      for (const x of tabBar.children) x.setAttribute('aria-selected', String(x === b));
      player.stop();
      renderTab(run, body);
    });
    return b;
  }));
  const engineText = [run.engineId, run.browser ? `${run.browser}${run.browserVersion ? ` ${run.browserVersion}` : ''}` : null, run.headless === false ? 'headed' : run.headless ? 'headless' : null, run.profile ? `profile ${run.profile}` : null].filter(Boolean).join(', ');
  const humanize = run.humanize && typeof run.humanize === 'object' ? run.humanize.level ?? run.humanize.profile ?? null : run.humanize;
  replace(detailEl,
    h('div', { class: 'surface pad' },
      h('div', { class: 'row' },
        h('h2', { style: { fontSize: '16px' } }, run.flowName ?? run.runId),
        chip(verdictLabel(run.verdict), verdictTone(run.verdict)),
        run.kind && run.kind !== 'watch' ? chip(kindLabel(run.kind)) : null),
      h('dl', { class: 'kv kv-2', style: { marginTop: '8px' } },
        h('dt', null, 'Run'), h('dd', { class: 'mono ellipsis', title: run.runId }, run.runId),
        h('dt', null, 'Started'), h('dd', null, fmtDateTime(run.startedAt)),
        run.flowId ? [h('dt', null, 'Flow'), h('dd', { class: 'mono ellipsis' }, String(run.flowId))] : null,
        h('dt', null, 'Took'), h('dd', null, run.status === 'running' ? 'in progress' : fmtDuration(run.durationMs)),
        run.total != null ? [h('dt', null, 'Steps'), h('dd', null, `${run.passed ?? 0} passed, ${run.failed ?? 0} failed of ${run.total}`)] : null,
        run.exitCode != null ? [h('dt', null, 'Exit code'), h('dd', null, String(run.exitCode))] : null,
        engineText ? [h('dt', null, 'Engine'), h('dd', { class: 'ellipsis', title: engineText }, engineText)] : null,
        humanize ? [h('dt', null, 'Human input'), h('dd', null, `${humanize}${run.seed != null ? `, seed ${run.seed}` : ''}`)] : null,
        run.frames != null && (run.frames > 0 || run.kind === 'replay' || run.kind === 'calibrate') ? [h('dt', null, 'Frames'), h('dd', null, `${run.frames}${run.framesDropped ? ` (+${run.framesDropped} over the cap)` : ''}`)] : null),
      run.kind === 'schedule' ? h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { type: 'button', class: 'btn small', onclick: () => api.invoke('runs.openReport', { runId: run.runId }).catch(toastError) }, icon('external', { size: 14 }), 'Open report'),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => api.invoke('runs.openFolder', { runId: run.runId }).catch(toastError) }, icon('folder', { size: 14 }), 'Folder')) : null,
      run.truncated ? h('p', { class: 'small', style: { color: 'var(--warn)', marginTop: '6px' } }, `Evidence was capped: ${run.truncated}.`) : null,
      run.error ? h('p', { class: 'small', style: { color: 'var(--stop)', marginTop: '6px' } }, run.error) : null,
      tabBar,
      body));
  renderTab(run, body);
}

function renderTab(run, body) {
  if (activeTab === 'steps') return renderSteps(run, body);
  if (activeTab === 'surprises') return renderSurprises(run, body);
  return renderReplay(run, body);
}

function stepsTable(steps) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
    h('colgroup', null, h('col', { style: { width: '40px' } }), h('col', { style: { width: '100px' } }), h('col'), h('col', { style: { width: '80px' } }), h('col', { style: { width: '66px' } })),
    h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Action'), h('th', null, 'Target and result'), h('th', null, 'Result'), h('th', null, 'Took'))),
    h('tbody', null, steps.map((s) => h('tr', { class: ['step-row', s.ok ? '' : 'fail'] },
      h('td', { class: 'muted' }, String(s.n)),
      h('td', { class: 'ellipsis' }, s.action),
      h('td', { class: 'ellipsis', title: [s.target, s.message].filter(Boolean).join('\n') }, s.target, s.message ? h('span', { class: s.ok ? 'muted' : '' }, `  ${s.message}`) : null, s.matchedBy ? h('span', { class: 'muted' }, `  (matched by ${s.matchedBy})`) : null),
      h('td', null, chip(s.ok ? 'OK' : 'Failed', s.ok ? 'ok' : 'fail')),
      h('td', { class: 'muted nowrap' }, fmtDuration(s.durationMs)))))));
}

/**
 * What made a pass "with warnings", in the run's own words. A verdict chip alone left the reader
 * asking why (render check, round 3: every lab run said "Pass with warnings" and no view said what
 * the warnings were). When the run kept no text, say that, rather than showing nothing.
 */
function warningsBlock(f) {
  const list = f?.warnings ?? [];
  if (list.length) {
    return h('div', { class: 'run-warnings', role: 'note' },
      h('strong', null, list.length === 1 ? 'Warning' : `Warnings (${list.length})`),
      h('ul', null, list.slice(0, 50).map((w) => h('li', null, w))),
      list.length > 50 ? h('p', { class: 'muted small' }, `and ${list.length - 50} more.`) : null);
  }
  if (String(f?.verdict ?? '').toUpperCase() === 'PASS_WITH_WARNING') {
    return h('p', { class: 'muted small run-warnings-none' }, 'Passed with warnings; their text was not kept with this run (it went to whoever started the replay: an agent, or the runner and its report).');
  }
  return null;
}

function renderSteps(run, body) {
  const flows = flowsOf(run);
  if (run.kind === 'watch') {
    replace(body, h('p', { class: 'muted' }, 'A watch session records what was on screen; it has no steps. Open Replay to see it.'));
    return;
  }
  if (flows.length > 1) {
    replace(body, h('div', { class: 'stack' }, flows.map((f) => h('details', { open: f.verdict !== 'PASS' },
      h('summary', null, h('span', { class: 'row', style: { display: 'inline-flex' } }, h('strong', null, f.name), chip(verdictLabel(f.verdict), verdictTone(f.verdict)), f.total != null ? h('span', { class: 'muted small' }, `${f.passed ?? 0}/${f.total} steps`) : null)),
      f.failureMessage ? h('p', { class: 'small', style: { color: 'var(--stop)', margin: '6px 0' } }, f.failureMessage) : null,
      warningsBlock(f),
      f.steps.length ? stepsTable(f.steps) : h('p', { class: 'muted small' }, 'No step detail.')))));
    return;
  }
  const f = flows[0];
  if (!f || !f.steps.length) {
    replace(body, warningsBlock(f), h('p', { class: 'muted' }, f?.total != null
      ? `${f.passed ?? 0} of ${f.total} steps passed. The step-by-step result went to the agent that ran it; the run folder keeps the evidence (frames, cursor track, downloads).`
      : 'This run recorded no steps.'));
    return;
  }
  replace(body, warningsBlock(f), stepsTable(f.steps));
}

function surpriseItem(s) {
  // A surprise kept by the recording has no severity (that is decided per run): say what it is instead.
  if (s.effectiveSeverity == null && s.severity == null && (s.kind === 'new' || s.kind === 'missing')) {
    return h('li', null, chip(s.kind === 'new' ? 'New' : 'Missing', s.kind === 'new' ? 'surprise' : 'warn'), h('span', { class: 'mono' }, surpriseText({ key: s.key, detail: s.detail })));
  }
  const sev = surpriseSeverity(s);
  return h('li', null, chip(sev === 'fail' ? 'Fail' : sev === 'warn' ? 'Warning' : 'Note', sev === 'fail' ? 'fail' : sev === 'warn' ? 'warn' : ''), h('span', null, surpriseText(s)));
}

function renderSurprises(run, body) {
  const order = { fail: 0, warn: 1, info: 2 };
  let list = flowsOf(run).flatMap((f) => f.surprises.map((s) => ({ ...s, flow: f.name })));
  const fromRecording = !list.length && run.recordingSurprises && !run.recordingSurprises.stale ? run.recordingSurprises.items : [];
  if (!list.length && fromRecording.length) list = fromRecording;
  if (!list.length) {
    const counted = run.surpriseCount?.total ?? 0;
    replace(body, h('p', { class: 'muted' }, counted
      ? `${counted} surprise(s) were counted, but their details are no longer available (a newer run of this flow replaced them).`
      : 'Nothing new or missing compared with the approved known world.'));
    return;
  }
  list.sort((a, b) => (order[surpriseSeverity(a)] ?? 3) - (order[surpriseSeverity(b)] ?? 3));
  replace(body,
    fromRecording.length ? h('p', { class: 'muted small', style: { marginBottom: '8px' } }, 'From the flow\'s latest comparison (severity is decided per run; these are the keys that differed).') : null,
    h('ul', { class: 'surprise-list' }, list.slice(0, 300).map(surpriseItem)),
    list.length > 300 ? h('p', { class: 'muted small' }, `and ${list.length - 300} more.`) : null,
    h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { type: 'button', class: 'btn', onclick: () => go('approvals') }, 'Review in Approvals')));
}

// ------------------------------------------------------------------ replay

const player = {
  run: null,
  frames: [],
  pointer: [],
  t0: 0,
  t1: 0,
  t: 0,
  speed: 1,
  playing: false,
  raf: 0,
  lastTick: 0,
  cache: new Map(),
  loading: new Set(),
  shown: null,
  canvas: null,
  ctx: null,
  scrub: null,
  timeEl: null,
  playBtn: null,
  cancelExport: null,
  resizeObs: null,
  // Every run names its frames 000001.jpg, 000002.jpg, … A decode still in flight when the person
  // switches runs must not land in the new run's cache under the same name: reset() bumps this,
  // and a decode that finishes for an older generation is dropped.
  generation: 0,

  stop() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.updateControls();
  },

  reset() {
    this.stop();
    this.generation += 1;
    for (const b of this.cache.values()) b.close?.();
    this.cache.clear();
    this.loading.clear();
    this.shown = null;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
  },

  async bitmap(frame) {
    if (this.cache.has(frame.file)) {
      const b = this.cache.get(frame.file);
      this.cache.delete(frame.file); // LRU: move to the end
      this.cache.set(frame.file, b);
      return b;
    }
    if (this.loading.has(frame.file)) return null;
    this.loading.add(frame.file);
    const generation = this.generation;
    try {
      const bytes = await api.invoke('runs.frame', { runId: this.run.runId, file: frame.file });
      const b = await createImageBitmap(new Blob([bytes], { type: /\.png$/i.test(frame.file) ? 'image/png' : 'image/jpeg' }));
      if (generation !== this.generation) {
        b.close?.();
        return null;
      }
      this.cache.set(frame.file, b);
      while (this.cache.size > 90) {
        const [k, old] = this.cache.entries().next().value;
        this.cache.delete(k);
        old.close?.();
      }
      return b;
    } catch {
      return null;
    } finally {
      if (generation === this.generation) this.loading.delete(frame.file);
    }
  },

  /** Draw time t onto a canvas (the on-screen one, or the export one). */
  drawAt(t, g = this.ctx, cw = this.canvas?.width, ch = this.canvas?.height) {
    if (!g) return;
    g.fillStyle = '#0f141b';
    g.fillRect(0, 0, cw, ch);
    const i = frameIndexAt(this.frames, t);
    const f = this.frames[i];
    if (f) {
      const cached = this.cache.get(f.file);
      if (cached) this.shown = { bmp: cached, meta: f.metadata };
      else if (!this.loading.has(f.file)) {
        // Redraw once the frame is decoded — only on success: chaining on a null result (already
        // loading, or unreadable) would spin forever in microtasks and freeze the window.
        this.bitmap(f).then((b) => { if (b && !this.playing && g === this.ctx) this.drawAt(this.t); });
      }
      for (let k = 1; k <= 6 && i + k < this.frames.length; k++) {
        const next = this.frames[i + k];
        if (!this.cache.has(next.file)) this.bitmap(next);
      }
    }
    const shown = this.shown;
    if (!shown) return;
    const fitted = fitRect(shown.bmp.width, shown.bmp.height, cw, ch);
    g.drawImage(shown.bmp, fitted.x, fitted.y, fitted.width, fitted.height);
    const p = interpolateTrack(this.pointer, t);
    if (p && t >= (this.pointer[0]?.at ?? Infinity) - 50) {
      drawCursor(g, viewportToCanvas(p, shown.meta, shown.bmp.width, shown.bmp.height, fitted), p, Math.max(1, cw / 1100));
    }
  },

  play() {
    if (!this.frames.length) return;
    if (this.t >= this.t1) this.t = this.t0;
    this.playing = true;
    this.lastTick = performance.now();
    const tick = (now) => {
      if (!this.playing) return;
      this.t = Math.min(this.t1, this.t + (now - this.lastTick) * this.speed);
      this.lastTick = now;
      this.drawAt(this.t);
      this.updateControls();
      if (this.t >= this.t1) {
        this.stop();
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.updateControls();
  },

  updateControls() {
    if (!this.scrub) return;
    const span = Math.max(1, this.t1 - this.t0);
    this.scrub.value = String(Math.round(((this.t - this.t0) / span) * 1000));
    this.timeEl.textContent = `${fmtClockSpan(this.t - this.t0)} / ${fmtClockSpan(span)}`;
    replace(this.playBtn, icon(this.playing ? 'pause' : 'play', { size: 15 }), this.playing ? 'Pause' : 'Play');
  },
};

function fmtClockSpan(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function renderReplay(run, body) {
  replace(body, h('p', { class: 'muted' }, h('span', { class: 'spinner' }), ' Reading the frames…'));
  let local;
  try {
    local = await api.invoke('runs.local', { runId: run.runId });
  } catch (err) {
    replace(body, h('p', null, `Could not read this run's evidence: ${err.message}`));
    return;
  }
  if (activeTab !== 'replay' || selected !== run.runId) return;
  player.reset();
  player.run = run;
  player.frames = local.frames ?? [];
  player.pointer = local.pointer ?? [];
  if (!local.exists || !player.frames.length) {
    const why = !local.exists
      ? `The run folder ${local.dir} does not exist on this machine.`
      : run.kind === 'watch'
        ? 'The tab painted nothing while it was watched (a page that does not change sends no frames).'
        : run.kind === 'schedule'
          ? 'A scheduled run records its flows in the report; each flow\'s own replay run holds its frames.'
          : run.status === 'running'
            ? 'The run is still going; frames appear as they are written.'
            : 'Frames are recorded for replays on launched engines. The verdict and counts above do not depend on them.';
    replace(body, empty('No frames for this run', why));
    return;
  }
  player.t0 = player.frames[0].at;
  player.t1 = Math.max(player.frames[player.frames.length - 1].at, player.pointer.at?.(-1)?.at ?? 0);
  player.t = player.t0;

  const canvas = h('canvas', { role: 'img', 'aria-label': `Replay of run ${run.runId}` });
  const stage = h('div', { class: 'stage' }, canvas);
  player.canvas = canvas;
  player.ctx = canvas.getContext('2d', { alpha: false });
  player.scrub = h('input', { type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Position in the run' });
  player.timeEl = h('span', { class: 'time' });
  player.playBtn = h('button', { type: 'button', class: 'btn' });
  const speed = select([{ value: '0.5', label: '0.5×' }, { value: '1', label: '1×' }, { value: '2', label: '2×' }, { value: '4', label: '4×' }, { value: '8', label: '8×' }], String(player.speed), { 'aria-label': 'Playback speed' });
  const exportBtn = h('button', { type: 'button', class: 'btn' }, 'Export video');
  const folderBtn = h('button', { type: 'button', class: 'btn ghost', title: 'Open the run folder' }, icon('folder', { size: 15 }), 'Folder');

  player.playBtn.addEventListener('click', () => (player.playing ? player.stop() : player.play()));
  player.scrub.addEventListener('input', () => {
    player.t = player.t0 + ((player.t1 - player.t0) * Number(player.scrub.value)) / 1000;
    player.drawAt(player.t);
    player.updateControls();
  });
  speed.addEventListener('change', () => {
    player.speed = Number(speed.value);
  });
  folderBtn.addEventListener('click', () => api.invoke('runs.openFolder', { runId: run.runId }).catch(toastError));
  exportBtn.addEventListener('click', () => exportVideo(run, exportBtn));

  replace(body,
    stage,
    h('div', { class: 'player' }, player.playBtn, player.scrub, player.timeEl, speed),
    h('div', { class: 'row', style: { marginTop: '8px' } },
      exportBtn,
      folderBtn,
      h('span', { class: 'muted small' }, `${player.frames.length} frames, ${player.pointer.length} cursor samples${local.video ? `. video.webm saved (${fmtBytes(local.video.size)})` : ''}`)));
  const sizeIt = () => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(stage.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(stage.clientHeight * dpr));
    player.drawAt(player.t);
  };
  player.resizeObs = new ResizeObserver(sizeIt);
  player.resizeObs.observe(stage);
  sizeIt();
  player.updateControls();
  await player.bitmap(player.frames[0]);
  player.drawAt(player.t);
}

/**
 * Record the replay into WebM at the chosen speed, full frame resolution (capped at 1920 wide),
 * with the cursor drawn. Real time: a 3-minute run at 1× takes 3 minutes to export.
 */
async function exportVideo(run, button) {
  if (player.cancelExport) {
    player.cancelExport();
    return;
  }
  const first = await player.bitmap(player.frames[0]);
  if (!first) {
    toastError(new Error('The first frame could not be read.'));
    return;
  }
  const scale = Math.min(1, 1920 / first.width);
  const out = document.createElement('canvas');
  out.width = Math.round(first.width * scale);
  out.height = Math.round(first.height * scale);
  const g = out.getContext('2d', { alpha: false });
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const recorder = new MediaRecorder(out.captureStream(30), { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  let cancelled = false;
  let t = player.t0;
  let last = performance.now();
  let raf = 0;
  const speed = player.speed;
  player.stop();
  button.textContent = 'Cancel export';
  player.cancelExport = () => {
    cancelled = true;
  };
  const finished = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start(1000);
  const tick = (now) => {
    t = Math.min(player.t1, t + (now - last) * speed);
    last = now;
    player.drawAt(t, g, out.width, out.height);
    player.t = t;
    player.updateControls();
    if (cancelled || t >= player.t1) {
      recorder.stop();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  await finished;
  cancelAnimationFrame(raf);
  player.cancelExport = null;
  button.textContent = 'Export video';
  if (cancelled) {
    toast('Export cancelled.');
    return;
  }
  try {
    const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    const r = await api.invoke('runs.saveVideo', { runId: run.runId, bytes });
    toast(`Saved ${r.path} (${fmtBytes(r.size)}).`, 'ok', 7000);
  } catch (err) {
    toastError(err);
  }
}
