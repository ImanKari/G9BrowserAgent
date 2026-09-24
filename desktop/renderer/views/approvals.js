/**
 * Approvals: flows whose LAST run found something new or missing (surprises), shown with an
 * Approve button. Approving calls browser_recording action:"approve" with `by` = the OS user name —
 * supplied by the main process, not this page — and grows the flow's known world.
 *
 * The list comes from the recordings themselves (browser_recording list: each row's lastRun carries
 * the verdict and the surprise count; `get` gives the surprise keys and when the known world was
 * last approved), across both stores — the extension's and the launched engines'. The approval is
 * pinned to the store the flow was listed from.
 *
 * Only a person approves (AIGuide §8c): nothing here runs on a timer, nothing approves in bulk,
 * and every approval asks once more before it happens. This view and the extension panel are the
 * only two approval paths.
 */

import { h, replace, icon } from '../lib/dom.js';
import { fmtDateTime } from '../lib/format.js';
import { approvalCandidates, recordingRows, runRows, normalizeRun, surpriseText, verdictLabel, verdictTone, recordingKey } from '../lib/runs.js';
import { api, store, toast, viewHead, empty, chip, notConnected, busy, confirm, go, setBadge } from '../ui.js';

let root = null;
let listEl = null;
let candidates = [];
let lastRuns = new Map();
// What the person typed, per flow: the list re-renders when a run finishes in the background, and
// that must not wipe a half-written approval note.
const notes = new Map();

export function mount(el) {
  root = el;
  listEl = h('div', { class: 'surface' });
  const refresh = h('button', { type: 'button', class: 'btn' }, icon('refresh', { size: 15 }), 'Refresh');
  refresh.addEventListener('click', () => busy(refresh, () => load()));
  replace(el,
    viewHead('Approvals',
      'Flows whose last run found something new or missing. Approving adds that run to the flow\'s known world, so the same behaviour stops being reported. Only a person approves; G9 never does it by itself.',
      [refresh]),
    h('div', { class: 'section' }, listEl));
  load();
}

export function unmount() {
  root = null;
}

let wasConnected = false;
export function update(s) {
  const now = s.connection?.status === 'connected';
  if (root && now && !wasConnected) load();
  wasConnected = now;
}

let reloadTimer = null;
export function onEvent(e) {
  if (!root || e.topic !== 'run') return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(load, 1000);
}

/**
 * Recompute the candidates (and the rail badge). Two passes: the list says which flows' last run
 * had surprises; `get` for just those says whether that run was approved since, and what differed.
 */
export async function refreshCount() {
  if (!store.connected) return;
  const rows = recordingRows(await api.call('browser_recording', { action: 'list' }));
  const first = approvalCandidates(rows);
  const details = {};
  await Promise.all(first.map(async (c) => {
    try {
      // Keyed by store and id: the same flow id in the extension's and the launched store are two flows.
      details[recordingKey({ engine: c.engine, id: c.flowId })] = await api.call('browser_recording', { action: 'get', id: c.flowId, ...(c.engine ? { engine: c.engine } : {}) });
    } catch {
      /* listed but unreadable: shown without detail */
    }
  }));
  candidates = approvalCandidates(rows, details);
  setBadge('approvals-count', candidates.length, `${candidates.length} flow${candidates.length === 1 ? '' : 's'} waiting for approval`);
  // The evidence run of each flow's latest replay, for "Open run".
  try {
    const runs = runRows(await api.admin('runs.list', { limit: 300 })).map(normalizeRun);
    lastRuns = new Map();
    for (const r of runs) {
      if (!r.flowId || lastRuns.has(r.flowId)) continue;
      lastRuns.set(r.flowId, r);
    }
  } catch {
    lastRuns = new Map();
  }
}

async function load() {
  if (!root) return;
  if (!store.connected) {
    replace(listEl, notConnected('The list of flows to approve'));
    return;
  }
  try {
    await refreshCount();
  } catch (err) {
    replace(listEl, h('p', { class: 'pad muted' }, `Could not read the flows: ${err.message}`));
    return;
  }
  render();
}

function render() {
  if (!root) return;
  if (!candidates.length) {
    replace(listEl, h('div', { class: 'pad' }, empty('Nothing waits for approval', 'When a flow\'s latest run reports surprises, it appears here with what changed.', [
      h('button', { type: 'button', class: 'btn', onclick: () => go('runs') }, 'See all runs'),
    ])));
    return;
  }
  const user = store.state?.app?.user ?? 'you';
  replace(listEl, ...candidates.map((c) => {
    const run = lastRuns.get(c.flowId) ?? null;
    const noteKey = `${c.engine ?? ''}|${c.flowId}`;
    const note = h('textarea', { rows: 3, placeholder: 'Why this is expected (saved with the approval)', 'aria-label': `Note for approving ${c.flowName}` });
    note.value = notes.get(noteKey) ?? '';
    note.addEventListener('input', () => notes.set(noteKey, note.value));
    const approve = h('button', { type: 'button', class: 'btn primary' }, icon('approvals', { size: 15 }), `Approve as ${user}`);
    approve.addEventListener('click', async () => {
      const ok = await confirm({
        title: `Approve ${c.flowName}?`,
        body: h('div', { class: 'stack' },
          h('p', null, `This adds the flow's latest run to its known world. Future runs that behave the same way will not report these ${c.surpriseCount || c.surprises.length} surprise(s).`),
          h('p', { class: 'muted' }, `Recorded as approved by ${user}${note.value.trim() ? ', with your note' : ''}. If this behaviour is a bug, do not approve it: file it instead.`)),
        confirmLabel: 'Approve',
      });
      if (!ok) return;
      await busy(approve, async () => {
        // `expectLastRunAt`: the run whose surprises this card showed. A newer one arriving while
        // the dialog was open is refused by the store, not folded in unseen.
        await api.invoke('approve', { flowId: c.flowId, runId: run?.runId ?? null, note: note.value, engine: c.engine, expectLastRunAt: c.at ?? null });
        notes.delete(noteKey);
        toast(`Approved. ${c.flowName} now expects this behaviour.`, 'ok');
        await load();
      });
    });
    const shown = c.surprises.slice(0, 12);
    return h('div', { class: 'approval' },
      h('div', null,
        h('div', { class: 'row' },
          h('h3', null, c.flowName),
          chip(verdictLabel(c.verdict), verdictTone(c.verdict)),
          c.engine ? h('span', { class: 'muted small' }, c.engine === 'extension' ? 'in your browser\'s store' : 'in the launched engines\' store') : null),
        h('p', { class: 'meta' }, `Last run ${fmtDateTime(c.at)}: ${c.lastRun?.passed ?? 0} passed, ${c.lastRun?.failed ?? 0} failed, ${c.surpriseCount} surprise(s) that are not notes.`),
        shown.length
          ? h('ul', { class: 'surprise-list' }, shown.map((s) => h('li', null,
            chip(s.kind === 'missing' ? 'Missing' : s.kind === 'new' ? 'New' : 'Changed', s.kind === 'missing' ? 'warn' : 'surprise'),
            h('span', { class: 'mono' }, surpriseText({ key: s.key, detail: s.detail })))))
          : h('p', { class: 'muted' }, 'Open the run for the details.'),
        c.surprises.length > 12 ? h('p', { class: 'muted small' }, `and ${c.surprises.length - 12} more.`) : null),
      h('div', { class: 'stack' },
        note,
        h('div', { class: 'row' }, approve, run ? h('button', { type: 'button', class: 'btn ghost', onclick: () => go('runs', { runId: run.runId }) }, 'Open run') : null)));
  }));
}
