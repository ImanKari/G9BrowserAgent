/**
 * A flow crossing between a store and the repository, with what a person approved (3.2).
 *
 * lib/approved.js decides WHAT travels; this module moves it in and out of a recording store —
 * the extension's (Engine 1) or the launched-engine store (Engine 2), through the same platform
 * seam — so the side panel's Pull, `browser_recording import_spec` and the runner's import all
 * apply a flow the same way:
 *
 * - the local copy is found by the flow's id, whichever local id it was saved under. Pull used to
 *   look it up by an id a FlowSpec never has, so every pull saved every repo flow again under a
 *   new id: pulling twice listed each flow twice (found while building 3.1);
 * - what the machine learned stays (run history, flakiness, surprise history, last signature);
 * - baselines come from the sidecar, else the local ones stay (lib/approved.js applyApproved);
 * - the known world is the later of the two human approvals.
 *
 * No chrome.* and no node: (rule R2).
 */

import { getRecording, listRecordings, saveRecording, getAttachment, putAttachment, deleteAttachment } from './store.js';
import { fromFlowSpec, validateFlowSpec } from './flowspec.js';
import { approvedDocFor, applyApproved, setBaselineImage } from './approved.js';

/** What a machine learned about a flow: never taken from the repository, never lost to a pull. */
const LOCAL_TRUTH = ['runHistory', 'lastRun', 'flaky', 'surpriseHistory', 'lastSignature'];

/**
 * The local recording of a flow: saved under the flow's own id (pushed from here), or carrying it
 * as `flowId` (pulled or imported here). Null when this store has none.
 */
export async function findByFlowId(flowId) {
  if (flowId == null || flowId === '') return null;
  const direct = await getRecording(String(flowId)).catch(() => null);
  if (direct) return direct;
  const index = await listRecordings();
  // The index carries flowId since 3.1; an entry written before that is opened to find out.
  for (const entry of index) {
    if (entry.flowId === flowId) return getRecording(entry.id);
  }
  for (const entry of index) {
    if ('flowId' in entry) continue;
    const full = await getRecording(entry.id).catch(() => null);
    if (full?.flowId === flowId) return full;
  }
  return null;
}

/**
 * A recording's sidecar with its images as base64: `{ flowId, approved, images }`, or null when it
 * has nothing to carry. An image whose attachment is gone is left out (the fingerprint still
 * compares; the file just is not there to look at).
 */
export async function approvedBundle(recordingOrId) {
  const recording = typeof recordingOrId === 'string' ? await getRecording(recordingOrId) : recordingOrId;
  if (!recording) return null;
  const built = approvedDocFor(recording);
  if (!built) return null;
  const images = {};
  for (const img of built.images) {
    const att = await getAttachment(img.attachmentId).catch(() => null);
    if (att?.dataBase64) images[img.name] = att.dataBase64;
  }
  return { flowId: built.doc.flowId, approved: built.doc, images };
}

/**
 * Save a FlowSpec into this store with its sidecar (`approved`, `images` as from the flow library's
 * readApproved), keeping what the local copy learned. `id` forces the local id (the launched store
 * keeps flows under their flow id).
 *
 * @returns {{ id, name, steps, created: boolean, knownWorld: 'repo'|'local'|null, localNewer: boolean,
 *   baselines: { fromRepo, kept }, images: number }}
 */
export async function importFlow(spec, { approved = null, images = {}, id = null } = {}) {
  const problems = validateFlowSpec(spec);
  if (problems.length) throw new Error(`FlowSpec is not valid:\n- ${problems.join('\n- ')}`);
  const fresh = fromFlowSpec(spec);
  const local = id ? await getRecording(String(id)).catch(() => null) : await findByFlowId(spec.id);
  const base = {
    ...fresh,
    id: id ? String(id) : (local?.id ?? undefined),
    flowId: spec.id,
    platform: local?.platform ?? (spec.target?.kind === 'maui' ? 'maui' : 'web'),
    ...(local?.createdAt ? { createdAt: local.createdAt } : {}),
  };
  for (const key of LOCAL_TRUTH) if (local?.[key] !== undefined) base[key] = local[key];
  const applied = applyApproved(base, approved, local);
  let saved = await saveRecording(applied.recording);

  // Baseline screenshots: stored once per content — a pull of an unchanged flow adds nothing.
  let stored = 0;
  for (const img of applied.images) {
    const data = images?.[img.name];
    if (typeof data !== 'string' || !data) continue;
    const current = saved.steps.find((s, i) => (s.id ?? `s${i + 1}`) === img.stepId)?.baselineImageId;
    const existing = current ? await getAttachment(current).catch(() => null) : null;
    if (existing?.dataBase64 === data) continue;
    const att = await putAttachment({
      owner: saved.id,
      name: `baseline-${img.stepId}.png`,
      mime: 'image/png',
      kind: 'baseline',
      bytes: base64ToBytes(data),
      meta: { role: 'expected', from: 'repository', createdAt: Date.now() },
    });
    saved = setBaselineImage(saved, img.stepId, att.id);
    // The image it replaces belonged to this step alone.
    if (existing) await deleteAttachment(current).catch(() => {});
    stored++;
  }
  if (stored) saved = await saveRecording(saved);
  return {
    id: saved.id,
    name: saved.name,
    steps: saved.steps.length,
    created: !local,
    knownWorld: applied.knownWorld,
    localNewer: applied.localNewer,
    baselines: applied.baselines,
    images: stored,
  };
}

function base64ToBytes(dataBase64) {
  const bin = atob(String(dataBase64));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
