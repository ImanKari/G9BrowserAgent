/**
 * What a person approved about a flow, in a form that travels with it (3.2).
 *
 * A FlowSpec (lib/flowspec.js) carries the steps and checks of a flow and deliberately none of what
 * a machine learned. Two things a person DECIDED were lost with that rule, though:
 *
 * - **the known world** — what "normal" looks like for this flow, grown only when a person presses
 *   Approve (tools/replay.js approveKnownWorld). Without it a flow pulled on another machine starts
 *   over: no surprise can be reported until someone approves again there.
 * - **baselines** — a screenshot check's fingerprint and layout map, an aria check's expected
 *   semantic lines. These are the substance of those checks, yet the spec kept only a reference to
 *   them, so a repo flow with a screenshot or aria check could never pass anywhere but the browser
 *   it was recorded in (and the runner's import dropped them before every run).
 *
 * Both now travel as a sidecar next to the flow file: `login.flow.json` + `login.approved.json` +
 * `login.baselines/<step>.png` (the screenshot a person approved, for review in a diff; the
 * fingerprint in the JSON is what is compared). The sidecar is written when a flow is pushed and
 * whenever a person approves a flow that is in the repository — both deliberate acts, so replays
 * never touch the working tree. Run history, flakiness and surprise history stay local (they are
 * facts about one machine), and so does a known world only SEEDED by a first run: nobody approved it.
 *
 * Pure: no storage, no network. Callers move the bytes (the extension through the daemon's flow
 * library, the daemon and the runner through the file system).
 */

import { canonicalize } from './flowspec.js';

export const APPROVED_FORMAT = 'g9-approved';
export const APPROVED_VERSION = 1;

/** A step's id as the FlowSpec has it (toFlowSpec: `step.id ?? s<n>`), so both files agree. */
export const stepIdOf = (step, index) => step?.id ?? `s${index + 1}`;

/** The file a step's baseline image is stored under: `<step id>.png`, safe as a file name. */
export function imageNameFor(stepId) {
  const safe = String(stepId).replace(/[^\w.-]/g, '_').slice(0, 76) || 'step';
  return `${safe}.png`;
}

/** A known world a PERSON approved (not one a first run seeded). */
export function isApproved(knownWorld) {
  return !!(knownWorld && knownWorld.runs && Number.isFinite(knownWorld.approvedAt) && knownWorld.approvedBy !== 'seed');
}

const approvedAtOf = (knownWorld) => (isApproved(knownWorld) ? knownWorld.approvedAt : 0);

/**
 * Every approved known world of a recording or a sidecar document, keyed by
 * environment (lib/signature.js): the flat `knownWorld` IS the default
 * environment's world — that is the whole compatibility story, because every
 * store and sidecar written before environments existed keeps meaning exactly
 * what it meant — and named environments live under `knownWorlds`.
 */
export function approvedWorldsOf(holder) {
  const worlds = {};
  if (isApproved(holder?.knownWorld)) worlds.default = holder.knownWorld;
  for (const [env, kw] of Object.entries(holder?.knownWorlds ?? {})) {
    if (env !== 'default' && isApproved(kw)) worlds[env] = kw;
  }
  return worlds;
}

/** The latest human approval across every environment: `{ approvedAt, approvedBy }`, or nulls. */
export function latestApprovalOf(holder) {
  let approvedAt = 0;
  let approvedBy = null;
  for (const kw of Object.values(approvedWorldsOf(holder))) {
    if (kw.approvedAt > approvedAt) { approvedAt = kw.approvedAt; approvedBy = kw.approvedBy ?? null; }
  }
  return approvedAt ? { approvedAt, approvedBy } : { approvedAt: null, approvedBy: null };
}

/**
 * The sidecar for a recording, or null when there is nothing to carry (no approval, no baseline).
 * `images` lists the baseline screenshots to copy: `{ name, stepId, attachmentId }`.
 */
export function approvedDocFor(recording) {
  if (!recording) return null;
  const baselines = {};
  const images = [];
  (recording.steps ?? []).forEach((step, index) => {
    if (step?.type !== 'assert') return;
    const id = stepIdOf(step, index);
    if (step.assertion === 'screenshot' && step.baseline != null) {
      const entry = {
        kind: 'screenshot',
        fingerprint: step.baseline,
        structure: step.baselineStructure ?? undefined,
        visualMode: step.visualMode ?? undefined,
        masks: Array.isArray(step.masks) && step.masks.length ? step.masks : undefined,
      };
      if (step.baselineImageId) {
        entry.image = imageNameFor(id);
        images.push({ name: entry.image, stepId: id, attachmentId: step.baselineImageId });
      }
      baselines[id] = entry;
    } else if (step.assertion === 'aria' && Array.isArray(step.ariaBaseline)) {
      baselines[id] = { kind: 'aria', lines: step.ariaBaseline, maxNodes: step.maxNodes ?? undefined };
    }
  });
  // Per environment: the default environment's world stays under the flat key
  // (so an older G9BrowserAgent reading this sidecar still applies it), named
  // environments' worlds travel under `knownWorlds`.
  const worlds = approvedWorldsOf(recording);
  const { default: defaultWorld, ...namedWorlds } = worlds;
  if (!Object.keys(worlds).length && !Object.keys(baselines).length) return null;
  const doc = canonicalize({
    format: APPROVED_FORMAT,
    schemaVersion: APPROVED_VERSION,
    flowId: recording.flowId ?? recording.id,
    knownWorld: defaultWorld ?? undefined,
    knownWorlds: Object.keys(namedWorlds).length ? namedWorlds : undefined,
    baselines: Object.keys(baselines).length ? baselines : undefined,
  });
  return { doc, images };
}

/** The bytes a sidecar file holds: canonical, so two writes of the same approval are identical. */
export function approvedJson(doc) {
  return `${JSON.stringify(canonicalize(doc), null, 2)}\n`;
}

/** Every problem at once; [] when the document can be applied. */
export function validateApproved(doc, flowId = null) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['not an object'];
  if (doc.format !== APPROVED_FORMAT) problems.push(`format must be "${APPROVED_FORMAT}"`);
  if (!Number.isInteger(doc.schemaVersion)) problems.push('schemaVersion must be an integer');
  else if (doc.schemaVersion > APPROVED_VERSION) problems.push(`schemaVersion ${doc.schemaVersion} is newer than this build (${APPROVED_VERSION}); update G9BrowserAgent`);
  if (flowId != null && doc.flowId !== flowId) problems.push(`it belongs to flow "${doc.flowId}", not "${flowId}"`);
  if (doc.knownWorld != null && (typeof doc.knownWorld !== 'object' || !Number.isFinite(doc.knownWorld.approvedAt))) {
    problems.push('knownWorld must be an approved known world (with approvedAt)');
  }
  if (doc.knownWorlds != null) {
    if (typeof doc.knownWorlds !== 'object' || Array.isArray(doc.knownWorlds)) {
      problems.push('knownWorlds must be an object keyed by environment name');
    } else {
      for (const [env, kw] of Object.entries(doc.knownWorlds)) {
        if (env === 'default') problems.push('knownWorlds must not carry the "default" environment; that world lives under knownWorld');
        else if (!kw || typeof kw !== 'object' || !Number.isFinite(kw.approvedAt)) {
          problems.push(`knownWorlds.${env} must be an approved known world (with approvedAt)`);
        }
      }
    }
  }
  for (const [id, b] of Object.entries(doc.baselines ?? {})) {
    if (b?.kind === 'screenshot') {
      if (b.fingerprint == null) problems.push(`baseline ${id}: a screenshot baseline needs its fingerprint`);
      if (b.image != null && !/^[\w.-]{1,80}\.png$/.test(String(b.image))) problems.push(`baseline ${id}: image "${b.image}" is not a plain .png file name`);
    } else if (b?.kind === 'aria') {
      if (!Array.isArray(b.lines)) problems.push(`baseline ${id}: an aria baseline needs its lines`);
    } else {
      problems.push(`baseline ${id}: unknown kind "${b?.kind}"`);
    }
  }
  return problems;
}

/**
 * A recording with what travels applied to it. `recording` is the one about to be saved (from a
 * FlowSpec: its steps have no baselines); `local` is what this store already holds for the flow,
 * or null. Per step (matched by id and check kind): the sidecar's baseline, else the local one —
 * so a pull from a repo without a sidecar no longer erases the baselines this machine has.
 * Known world: the sidecar's when a person approved it LATER than the local approval (or there is
 * none here, or only a seeded one); otherwise the local one stays and is reported as newer.
 *
 * @returns {{ recording: object, knownWorld: 'repo'|'local'|null, localNewer: boolean,
 *   baselines: { fromRepo: number, kept: number }, images: { name: string, stepId: string }[] }}
 *   `images` are the sidecar images the caller must store and link (setBaselineImage).
 */
export function applyApproved(recording, doc, local = null) {
  const out = { ...recording };
  const repoBaselines = doc?.baselines ?? {};
  const localSteps = new Map((local?.steps ?? []).map((s, i) => [stepIdOf(s, i), s]));
  const images = [];
  let fromRepo = 0;
  let kept = 0;
  out.steps = (recording.steps ?? []).map((step, index) => {
    if (step?.type !== 'assert') return step;
    const id = stepIdOf(step, index);
    const b = repoBaselines[id];
    if (b && b.kind === step.assertion) {
      fromRepo++;
      if (b.kind === 'screenshot') {
        if (b.image) images.push({ name: b.image, stepId: id });
        const mine = localSteps.get(id);
        return compact({
          ...step,
          baseline: b.fingerprint,
          baselineStructure: b.structure,
          visualMode: b.visualMode ?? step.visualMode,
          masks: b.masks ?? step.masks,
          // Linked by the caller once the image is stored; the local one meanwhile, if any.
          baselineImageId: mine?.assertion === 'screenshot' ? mine.baselineImageId : undefined,
        });
      }
      return compact({ ...step, ariaBaseline: b.lines, maxNodes: b.maxNodes ?? step.maxNodes });
    }
    const mine = localSteps.get(id);
    if (mine?.type === 'assert' && mine.assertion === step.assertion) {
      if (step.assertion === 'screenshot' && mine.baseline != null) {
        kept++;
        return compact({ ...step, baseline: mine.baseline, baselineStructure: mine.baselineStructure, visualMode: mine.visualMode ?? step.visualMode, masks: mine.masks ?? step.masks, baselineImageId: mine.baselineImageId });
      }
      if (step.assertion === 'aria' && Array.isArray(mine.ariaBaseline)) {
        kept++;
        return compact({ ...step, ariaBaseline: mine.ariaBaseline, maxNodes: mine.maxNodes ?? step.maxNodes });
      }
    }
    return step;
  });

  // Known worlds, per environment: for each environment either side knows, the
  // LATER human approval wins — independently, so a fresh approval on test2 in
  // the repo never overwrites this machine's newer approval on test1. A world
  // this machine merely SEEDED loses to any human approval and never travels.
  const repoWorlds = { default: doc?.knownWorld, ...(doc?.knownWorlds ?? {}) };
  const localWorlds = { default: local?.knownWorld, ...(local?.knownWorlds ?? {}) };
  let tookRepo = false;
  let keptLocal = false;
  let localNewer = false;
  for (const env of new Set([...Object.keys(repoWorlds), ...Object.keys(localWorlds)])) {
    const repoAt = approvedAtOf(repoWorlds[env]);
    const localAt = approvedAtOf(localWorlds[env]);
    let world = null;
    if (repoAt && repoAt > localAt) {
      world = repoWorlds[env];
      tookRepo = true;
    } else if (localWorlds[env]) {
      world = localWorlds[env];
      keptLocal = true;
    }
    // This machine holds an approval the repository does not have yet: push to share it.
    if (localAt > 0 && localAt > repoAt) localNewer = true;
    if (env === 'default') out.knownWorld = world ?? undefined;
    else if (world) out.knownWorlds = { ...(out.knownWorlds ?? {}), [env]: world };
  }
  if (out.knownWorld === undefined) delete out.knownWorld;
  if (tookRepo) out.surpriseHistory = [];
  const knownWorld = tookRepo ? 'repo' : (keptLocal ? 'local' : null);
  return { recording: out, knownWorld, localNewer, baselines: { fromRepo, kept }, images };
}

/** The recording with one step's baseline image linked (after the caller stored the bytes). */
export function setBaselineImage(recording, stepId, attachmentId) {
  return {
    ...recording,
    steps: (recording.steps ?? []).map((s, i) => (stepIdOf(s, i) === stepId ? { ...s, baselineImageId: attachmentId } : s)),
  };
}

/** When the flow's LATEST approval was made, across environments, for status lines: ms epoch, or null. */
export function approvedAtFor(recording) {
  return latestApprovalOf(recording).approvedAt;
}

function compact(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}
