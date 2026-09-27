/**
 * G9BrowserAgent FlowSpec — the portable, versioned form of a recorded flow.
 *
 * ## Why a second representation exists
 *
 * A recording as stored in `lib/store.js` is shaped for the browser: it carries
 * locator objects, run history, IndexedDB attachment ids, and whatever the
 * recorder happened to capture. That is the right shape for the extension and
 * the wrong shape for everything else. A FlowSpec is what leaves the browser:
 *
 * - it goes in Git, so it must diff cleanly — hence canonical key ordering and
 *   no timestamps in the body;
 * - it is read by a runner that may not be this extension, so it must be
 *   self-describing and versioned;
 * - it is reviewed by a human, so it must be readable.
 *
 * ## Canonical serialisation is not cosmetic
 *
 * Two exports of an unchanged flow must be byte-identical, or every review is a
 * diff of key reordering. `canonicalize` sorts object keys everywhere and drops
 * `undefined`; run-specific state (history, lastRun, flaky) is excluded from the
 * spec entirely and stays in the local store where it belongs.
 *
 * ## Secrets never enter a spec
 *
 * A parameter may be declared `secretRef`, which stores the NAME of a secret.
 * `toFlowSpec` refuses to emit a literal value for such a parameter, and
 * `validateFlowSpec` fails a spec that contains one. The failure is loud on
 * purpose: a spec is the artefact most likely to be committed, mailed, or
 * pasted into a ticket.
 */

export const FLOWSPEC_VERSION = 1;
export const FLOWSPEC_FORMAT = 'g9/flowspec';

/** Steps a runner is expected to understand. Anything else fails loudly. */
export const KNOWN_ACTIONS = new Set([
  'navigate', 'click', 'double_click', 'rightclick', 'type', 'select',
  'check', 'key', 'drag', 'scroll', 'upload', 'assert',
]);

export const DEFAULT_SENSITIVITY = {
  /** off | layout | strict — how a visual difference is judged. */
  visual: 'layout',
  /** off | warn | fail — how a UI-shape surprise is judged. */
  surprise: 'warn',
  /** Multiple of the historical p95 a step may take before it is remarked on. */
  durationP95Factor: 1.6,
};

/** Recursively sort keys and drop undefined, so exports diff cleanly. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = canonicalize(value[key]);
      if (item !== undefined) out[key] = item;
    }
    return out;
  }
  return value;
}

export function canonicalJson(spec) {
  return `${JSON.stringify(canonicalize(spec), null, 2)}\n`;
}

/**
 * Build a FlowSpec from a stored recording.
 *
 * Deliberately lossy: run history, flaky statistics and IndexedDB references
 * are the local store's business. What survives is what another machine needs
 * in order to run the same test and judge the same outcome.
 */
export function toFlowSpec(recording, { platform = 'web', adapter = 'chromium-cdp' } = {}) {
  if (!recording) throw new Error('toFlowSpec needs a recording.');

  const parameters = {};
  for (const [name, raw] of Object.entries(recording.parameters ?? {})) {
    const value = raw && typeof raw === 'object' ? raw : { default: raw };
    if (value.type === 'secretRef') {
      if ('default' in value && value.default != null && value.default !== '') {
        throw new Error(
          `Parameter "${name}" is declared secretRef but carries a literal default. ` +
            `A FlowSpec must never contain a secret value — store the name only.`,
        );
      }
      parameters[name] = { type: 'secretRef', required: value.required !== false };
    } else {
      parameters[name] = { type: value.type ?? 'string', default: value.default };
    }
  }

  const steps = (recording.steps ?? []).map((step, index) => {
    const id = step.id ?? `s${index + 1}`;
    const base = { id, action: step.type };
    if (!KNOWN_ACTIONS.has(step.type)) base.unsupported = true;

    if (step.target) base.target = compactTarget(step.target);
    if (step.to) base.to = compactTarget(step.to);
    if (step.url != null) base.url = step.url;
    if (step.value != null) base.value = step.value;
    if (step.values) base.values = step.values;
    if (step.texts) base.texts = step.texts;
    if (step.text != null) base.text = step.text;
    if (step.key != null) base.key = step.key;
    if (step.modifiers?.length) base.modifiers = step.modifiers;
    if (step.checked != null) base.checked = step.checked;
    if (step.x != null || step.y != null) base.scrollTo = { x: step.x ?? 0, y: step.y ?? 0 };
    if (step.files) base.files = step.files;
    if (step.waitMs != null) base.waitBudgetMs = step.waitMs;

    if (step.type === 'assert') {
      base.oracle = compactObject({
        kind: step.assertion,
        operator: step.operator,
        expected: step.expected,
        contains: step.contains,
        absent: step.absent,
        state: step.state,
        status: step.status,
        method: step.method,
        level: step.level,
        minCount: step.minCount,
        maxCount: step.maxCount,
        maxViolations: step.maxViolations,
        threshold: step.threshold,
        // A visual/aria baseline is an artefact, not a spec value. The spec
        // records that a baseline is required and its identity; the bytes live
        // in the baseline store next to the flow.
        baselineRef: step.baselineRef ?? (step.baseline ? `${recording.id}:${id}` : undefined),
      });
    }
    return compactObject(base);
  });

  return canonicalize({
    format: FLOWSPEC_FORMAT,
    schemaVersion: FLOWSPEC_VERSION,
    id: recording.flowId ?? recording.id,
    name: recording.name ?? '(unnamed)',
    description: recording.description,
    target: { kind: platform, adapter },
    suite: recording.suite ?? undefined,
    folder: recording.folder ?? undefined,
    tags: recording.tags?.length ? [...recording.tags].sort() : undefined,
    risk: recording.risk ?? undefined,
    startUrl: recording.startUrl ?? undefined,
    environment: recording.environment?.name ?? recording.environment ?? undefined,
    parameters: Object.keys(parameters).length ? parameters : undefined,
    sensitivity: { ...DEFAULT_SENSITIVITY, ...(recording.sensitivity ?? {}) },
    knownWorldRef: recording.knownWorldRef ?? undefined,
    qaTestCaseIds: recording.qaTestCaseIds?.length ? [...recording.qaTestCaseIds].sort() : undefined,
    steps,
  });
}

/**
 * The inverse, for importing a spec someone edited or wrote by hand.
 *
 * Import is deliberately tolerant of missing optional fields and intolerant of
 * unknown actions: a runner that silently skips a step it does not understand
 * produces a green result for a test that never ran.
 */
export function fromFlowSpec(spec) {
  const problems = validateFlowSpec(spec);
  if (problems.length) {
    throw new Error(`FlowSpec is not valid:\n- ${problems.join('\n- ')}`);
  }

  const steps = (spec.steps ?? []).map((step) => {
    const out = { id: step.id, type: step.action, waitMs: step.waitBudgetMs ?? 0 };
    if (step.target) out.target = step.target;
    if (step.to) out.to = step.to;
    if (step.url != null) out.url = step.url;
    if (step.value != null) out.value = step.value;
    if (step.values) out.values = step.values;
    if (step.texts) out.texts = step.texts;
    if (step.text != null) out.text = step.text;
    if (step.key != null) out.key = step.key;
    if (step.modifiers) out.modifiers = step.modifiers;
    if (step.checked != null) out.checked = step.checked;
    if (step.scrollTo) { out.x = step.scrollTo.x; out.y = step.scrollTo.y; }
    if (step.files) out.files = step.files;
    if (step.action === 'assert' && step.oracle) {
      const o = step.oracle;
      Object.assign(out, compactObject({
        assertion: o.kind,
        operator: o.operator,
        expected: o.expected,
        contains: o.contains,
        absent: o.absent,
        state: o.state,
        status: o.status,
        method: o.method,
        level: o.level,
        minCount: o.minCount,
        maxCount: o.maxCount,
        maxViolations: o.maxViolations,
        threshold: o.threshold,
        baselineRef: o.baselineRef,
      }));
    }
    return out;
  });

  return {
    flowId: spec.id,
    name: spec.name,
    description: spec.description,
    suite: spec.suite ?? null,
    folder: spec.folder ?? null,
    tags: spec.tags ?? [],
    risk: spec.risk ?? null,
    startUrl: spec.startUrl ?? null,
    environment: spec.environment ? { name: spec.environment } : null,
    parameters: spec.parameters ?? {},
    sensitivity: { ...DEFAULT_SENSITIVITY, ...(spec.sensitivity ?? {}) },
    knownWorldRef: spec.knownWorldRef ?? null,
    qaTestCaseIds: spec.qaTestCaseIds ?? [],
    steps,
  };
}

/** Every problem at once, so a fix is one edit rather than a game of whack-a-mole. */
export function validateFlowSpec(spec) {
  const problems = [];
  if (!spec || typeof spec !== 'object') return ['Not an object.'];
  if (spec.format !== FLOWSPEC_FORMAT) problems.push(`format must be "${FLOWSPEC_FORMAT}".`);
  if (!Number.isInteger(spec.schemaVersion)) problems.push('schemaVersion must be an integer.');
  else if (spec.schemaVersion > FLOWSPEC_VERSION) {
    problems.push(
      `schemaVersion ${spec.schemaVersion} is newer than this build understands (${FLOWSPEC_VERSION}). ` +
        `Update the tool rather than editing the spec down.`,
    );
  }
  if (!spec.id) problems.push('id is required and is what failure fingerprints are keyed on.');
  if (!Array.isArray(spec.steps) || !spec.steps.length) problems.push('steps must be a non-empty array.');

  const ids = new Set();
  (spec.steps ?? []).forEach((step, index) => {
    const where = `step ${index + 1}`;
    if (!step || typeof step !== 'object') { problems.push(`${where} is not an object.`); return; }
    if (!step.id) problems.push(`${where} has no id; ids are what keep a fingerprint stable across edits.`);
    else if (ids.has(step.id)) problems.push(`${where} repeats id "${step.id}".`);
    else ids.add(step.id);
    if (!KNOWN_ACTIONS.has(step.action)) {
      problems.push(`${where} has unknown action "${step.action}". A runner must refuse, not skip.`);
    }
    if (step.action === 'assert' && !step.oracle?.kind) {
      problems.push(`${where} is an assert with no oracle kind.`);
    }
  });

  for (const [name, param] of Object.entries(spec.parameters ?? {})) {
    if (param?.type === 'secretRef' && 'default' in param) {
      problems.push(`Parameter "${name}" is a secretRef and must not carry a default value.`);
    }
  }

  if (spec.sensitivity) {
    const { visual, surprise } = spec.sensitivity;
    if (visual && !['off', 'layout', 'strict'].includes(visual)) problems.push(`sensitivity.visual "${visual}" is not off|layout|strict.`);
    if (surprise && !['off', 'warn', 'fail'].includes(surprise)) problems.push(`sensitivity.surprise "${surprise}" is not off|warn|fail.`);
  }

  return problems;
}

/**
 * Keep the locator set and the fingerprint; drop everything else.
 *
 * The fingerprint is not used to find the element — it exists so that when
 * nothing matches, the failure can be described in human terms. That makes it
 * worth carrying into the portable form even though it is never executed.
 */
function compactTarget(target) {
  if (!target) return undefined;
  return compactObject({
    contractId: target.contractId,
    locators: target.locators,
    fingerprint: target.fingerprint,
  });
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
