/**
 * Journey signatures, the known world, and the surprise detector.
 *
 * ## The problem this exists for
 *
 * An assertion only ever finds what somebody thought to look for. The bugs that
 * actually reach users are the ones nobody predicted: a console error that
 * appeared this sprint, a request that quietly started 500ing, a control that
 * vanished from a screen nobody wrote an assertion about, a step that takes six
 * seconds where it used to take one.
 *
 * So this module inverts the question. Instead of "did the thing I expected
 * happen?", it asks **"did anything happen that has never happened before?"**
 *
 * Every replay produces a `signature`: a compact, normalised description of
 * what the run actually observed. Signatures from runs a human approved are
 * merged into a **known world** — the union of everything this flow has ever
 * legitimately done. A later run is compared against that union, and anything
 * outside it is a *surprise*.
 *
 * Two directions matter equally:
 *
 * - **New** — something appeared that has never appeared. Usually a regression.
 * - **Missing** — something that happened on EVERY previous run did not happen.
 *   This is the direction people forget, and it catches the quiet failures:
 *   a sync that no longer runs, a log line that stopped being written, a
 *   request that is no longer made because the button no longer calls it.
 *
 * ## Why normalisation is the whole game
 *
 * A signature that contains a GUID, a timestamp, or a row id differs on every
 * run, so everything is a surprise and the feature is noise. `normalizeText`
 * and `normalizeUrl` reduce run-specific values to typed placeholders BEFORE
 * anything is compared or stored. Get this wrong and the detector is useless;
 * get it too aggressive and it goes blind. Both failure modes are silent, which
 * is why the placeholders are visible in the output — a reviewer can see that
 * `POST /api/task/{uuid}` was compared, not `POST /api/task/9f2a…`.
 *
 * ## Why repetition is required before something is a finding
 *
 * The accepted rule in drift detection is that a single new failure is not
 * drift — a *pattern* of new failures on things that used to pass is. So a
 * surprise carries a `seen` count and the caller decides: this module reports
 * everything it sees, and `classifySurprises` applies the confirmation rule.
 *
 * ## Auto-calibration replaces hand-written masks
 *
 * `calibrateVolatile` runs the same flow twice against the same build and marks
 * everything that differed between two IDENTICAL runs as inherently volatile.
 * Hand-masking is the usual answer and it is why visual suites die: teams mask
 * until the tool only watches the parts nobody masked. Two runs cost thirty
 * seconds and produce a mask nobody had to think about.
 */

/** Bump when the shape changes in a way old known worlds cannot be read with. */
export const SIGNATURE_VERSION = 1;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX24 = /\b[0-9a-f]{24,64}\b/gi;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g;
const JALALI = /\b1[34]\d{2}\/\d{1,2}\/\d{1,2}\b/g;
const LONG_NUMBER = /\b\d{4,}\b/g;
const G9_RUN = /\bG9-[A-Za-z0-9_]+\b/g;

/**
 * Reduce a string to something two runs can be compared on.
 *
 * Order matters: the most specific patterns first, so a UUID is not first
 * shredded by the long-number rule. Persian digits are folded to ASCII before
 * the numeric rules run, because the app under test renders both.
 */
export function normalizeText(value) {
  if (value == null) return '';
  let text = String(value);
  // Persian/Arabic-Indic digits → ASCII, so a Persian UI normalises identically.
  text = text.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
             .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  return text
    .replace(UUID, '{uuid}')
    .replace(ISO_DATE, '{date}')
    .replace(JALALI, '{date}')
    .replace(G9_RUN, '{runData}')
    .replace(HEX24, '{hash}')
    .replace(LONG_NUMBER, '{n}')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A URL reduced to the *operation* it represents.
 *
 * Query strings are kept as their key set, never their values: `?page=2` and
 * `?page=3` are the same operation, while `?page=2&debug=1` is not.
 * `normalizers` comes from the project adapter (`g9.project.json`) and lets a
 * consumer collapse routes this module cannot know about — it is the only
 * project-specific knowledge in the file, and it arrives as data.
 */
export function normalizeUrl(rawUrl, normalizers = []) {
  if (!rawUrl) return '';
  let url;
  try {
    url = new URL(rawUrl, 'http://local.invalid');
  } catch {
    return normalizeText(rawUrl);
  }
  let path = url.pathname;
  for (const rule of normalizers) {
    try {
      if (new RegExp(rule.match).test(path)) {
        path = path.replace(new RegExp(rule.match), rule.as ?? '{id}');
      }
    } catch {
      /* a bad rule in project config must not break a run */
    }
  }
  path = normalizeText(path);
  const keys = [...url.searchParams.keys()].sort();
  const query = keys.length ? `?${keys.join('&')}` : '';
  const host = url.host === 'local.invalid' ? '' : url.host;
  return `${host}${path}${query}`;
}

/** `POST /api/task 2xx` — the unit the network layer is compared in. */
export function operationKey(request, normalizers = []) {
  const method = (request.method ?? 'GET').toUpperCase();
  const status = request.status == null ? 'pending' : `${Math.floor(request.status / 100)}xx`;
  return `${method} ${normalizeUrl(request.url, normalizers)} ${status}`;
}

/**
 * A console/log line reduced to its identity.
 *
 * Two errors from the same throw site differ only in their run-specific
 * payload, so the message is normalised and truncated. The level is part of the
 * key because an INFO becoming an ERROR is exactly the kind of change worth
 * catching.
 */
export function consoleKey(entry) {
  const level = entry.level ?? entry.type ?? 'log';
  return `${level}: ${normalizeText(entry.text ?? entry.message ?? '').slice(0, 160)}`;
}

/**
 * The semantic tree reduced to a comparable set of lines.
 *
 * Refs are stripped (they are per-snapshot and mean nothing across runs) and
 * values are normalised. Indentation is kept as a depth number rather than
 * literal spaces so that re-nesting one level shows up as a change of depth on
 * the affected lines rather than a diff of the whole tree.
 */
export function ariaLines(tree) {
  if (!tree) return [];
  return String(tree)
    .split('\n')
    .map((line) => {
      const depth = Math.floor((line.match(/^ */)?.[0].length ?? 0) / 2);
      const body = line.trim().replace(/^- /, '').replace(/\s*\[ref=e\d+\]/g, '');
      return body ? `${depth}|${normalizeText(body)}` : '';
    })
    .filter(Boolean);
}

// ------------------------------------------------------------------ signature

/**
 * Build one run's signature from whatever the replay managed to observe.
 *
 * Every field is optional: a dry run has no network, a step that failed early
 * has no aria tree. A missing layer is recorded as absent rather than empty, so
 * "we did not look" is never mistaken for "there was nothing".
 */
export function buildSignature({
  flowId,
  environment = null,
  platform = 'web',
  build = null,
  steps = [],
  normalizers = [],
} = {}) {
  const network = new Map();
  const consoleEntries = new Map();
  const dialogs = new Map();
  const stepSignatures = [];

  for (const step of steps) {
    for (const request of step.network ?? []) {
      // A request that had not finished when the step's evidence was collected has no outcome
      // yet, and including it manufactures noise in BOTH directions: the same request shows up
      // as `GET /x pending` on one run and `GET /x 4xx` on the next, so every run reports one
      // spurious "new" key and one spurious "missing" key. Found live on 2026-09-04, against a
      // page that had not changed at all. An unfinished request is not an observation.
      if (request.status == null) continue;
      const key = operationKey(request, normalizers);
      network.set(key, (network.get(key) ?? 0) + 1);
    }
    for (const entry of step.console ?? []) {
      const key = consoleKey(entry);
      consoleEntries.set(key, (consoleEntries.get(key) ?? 0) + 1);
    }
    for (const dialog of step.dialogs ?? []) {
      const key = `${dialog.type}: ${normalizeText(dialog.message).slice(0, 120)}`;
      dialogs.set(key, (dialogs.get(key) ?? 0) + 1);
    }
    stepSignatures.push({
      id: step.id ?? `step:${stepSignatures.length + 1}`,
      type: step.type ?? null,
      matchedBy: step.matchedBy ?? null,
      durationMs: step.ms ?? null,
      url: step.url ? normalizeUrl(step.url, normalizers) : null,
      nodes: step.aria ? ariaLines(step.aria) : null,
      visual: step.visual ?? null,
      data: step.data ?? null,
    });
  }

  return {
    version: SIGNATURE_VERSION,
    flowId: flowId ?? null,
    environment,
    platform,
    build,
    at: Date.now(),
    network: Object.fromEntries([...network].sort(([a], [b]) => (a < b ? -1 : 1))),
    console: Object.fromEntries([...consoleEntries].sort(([a], [b]) => (a < b ? -1 : 1))),
    dialogs: Object.fromEntries([...dialogs].sort(([a], [b]) => (a < b ? -1 : 1))),
    steps: stepSignatures,
  };
}

// ---------------------------------------------------------------- known world

export function emptyKnownWorld({ flowId, environment = null, platform = 'web' } = {}) {
  return {
    version: SIGNATURE_VERSION,
    flowId: flowId ?? null,
    environment,
    platform,
    runs: 0,
    approvedAt: null,
    network: {},
    console: {},
    dialogs: {},
    steps: {},
    volatile: [],
  };
}

/**
 * Fold a signature into the known world.
 *
 * Counts are kept per key, and that count against `runs` is what makes the
 * "missing" direction possible: a key seen on every run so far is expected, a
 * key seen once is merely known. Nothing here decides anything — merging is
 * only ever called for a run a human approved.
 */
export function mergeKnownWorld(knownWorld, signature) {
  const kw = knownWorld ?? emptyKnownWorld(signature);
  const next = {
    ...kw,
    version: SIGNATURE_VERSION,
    flowId: kw.flowId ?? signature.flowId,
    environment: kw.environment ?? signature.environment,
    platform: kw.platform ?? signature.platform,
    runs: (kw.runs ?? 0) + 1,
    network: { ...kw.network },
    console: { ...kw.console },
    dialogs: { ...kw.dialogs },
    steps: { ...kw.steps },
    volatile: [...(kw.volatile ?? [])],
  };

  for (const bucket of ['network', 'console', 'dialogs']) {
    for (const key of Object.keys(signature[bucket] ?? {})) {
      next[bucket][key] = (next[bucket][key] ?? 0) + 1;
    }
  }

  for (const step of signature.steps ?? []) {
    const prior = next.steps[step.id] ?? { seen: 0, nodes: {}, durations: [] };
    const nodes = { ...prior.nodes };
    for (const node of step.nodes ?? []) nodes[node] = (nodes[node] ?? 0) + 1;
    next.steps[step.id] = {
      seen: prior.seen + 1,
      nodes,
      durations: [...prior.durations, step.durationMs ?? null].filter((v) => v != null).slice(-40),
    };
  }

  return next;
}

/** p50/p95 of a step's recorded durations, used for the slowness surprise. */
export function percentiles(values) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return { p50: null, p95: null, samples: 0 };
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  return { p50: at(0.5), p95: at(0.95), samples: sorted.length };
}

// ------------------------------------------------------------------ surprises

/** Ranked worst-first, because a truncated list must keep the important half. */
const SEVERITY_ORDER = { fail: 0, warn: 1, info: 2 };

/**
 * Everything in this run that the known world has never seen, and everything
 * the known world always sees that this run did not.
 *
 * Severity is deliberately opinionated, and the reasoning is worth keeping:
 *
 * - A **new error** (console error, 4xx/5xx, unexpected dialog) is a failure.
 *   There is no benign reading of an error that did not used to happen.
 * - A **missing operation** is a failure when it was previously universal —
 *   the request that always fired and now does not is a broken button.
 * - A **new or missing UI node** is a warning by default. Real products add and
 *   remove controls constantly, and treating that as a failure trains people to
 *   ignore the tool. A flow can raise it with `sensitivity.surprise: "fail"`.
 * - A **new successful operation** is information: usually a feature, sometimes
 *   an N+1 that shipped by accident, which is why it is reported at all.
 */
export function detectSurprises(knownWorld, signature, { sensitivity = {} } = {}) {
  const out = [];
  if (!knownWorld || !knownWorld.runs) {
    return { seeded: true, surprises: [], note: 'No approved known world yet — this run can seed one.' };
  }

  const volatile = new Set(knownWorld.volatile ?? []);
  const isVolatile = (key) => volatile.has(key);

  const push = (item) => {
    if (isVolatile(item.key)) return;
    out.push(item);
  };

  // --- network -------------------------------------------------------------
  for (const key of Object.keys(signature.network ?? {})) {
    if (knownWorld.network[key] != null) continue;
    const failed = /\s[45]xx$/.test(key);
    push({
      layer: 'network',
      kind: 'new',
      key,
      severity: failed ? 'fail' : 'info',
      detail: failed
        ? 'A request that has never been seen before failed on this run.'
        : 'A request this flow has never made before was made.',
    });
  }
  for (const [key, count] of Object.entries(knownWorld.network ?? {})) {
    if (signature.network?.[key] != null) continue;
    const universal = count >= knownWorld.runs;
    push({
      layer: 'network',
      kind: 'missing',
      key,
      severity: universal ? 'fail' : 'warn',
      detail: universal
        ? `This request happened on all ${knownWorld.runs} previous runs and did not happen now.`
        : `This request happened on ${count} of ${knownWorld.runs} previous runs and did not happen now.`,
    });
  }

  // --- console / runtime ---------------------------------------------------
  for (const key of Object.keys(signature.console ?? {})) {
    if (knownWorld.console[key] != null) continue;
    const severe = /^(error|assert|critical|severe)/i.test(key);
    push({
      layer: 'console',
      kind: 'new',
      key,
      severity: severe ? 'fail' : 'warn',
      detail: 'This console output has never been produced by this flow before.',
    });
  }
  for (const [key, count] of Object.entries(knownWorld.console ?? {})) {
    if (signature.console?.[key] != null) continue;
    if (count < knownWorld.runs) continue; // only universal disappearances matter here
    push({
      layer: 'console',
      kind: 'missing',
      key,
      severity: 'info',
      detail: 'Console output that always appeared is gone — often a fix, occasionally a lost code path.',
    });
  }

  // --- dialogs -------------------------------------------------------------
  for (const key of Object.keys(signature.dialogs ?? {})) {
    if (knownWorld.dialogs[key] != null) continue;
    push({
      layer: 'dialog',
      kind: 'new',
      key,
      severity: 'fail',
      detail: 'A dialog appeared that this flow has never shown before; it may have blocked the run.',
    });
  }

  // --- per-step UI and timing ---------------------------------------------
  const nodeSeverity = sensitivity.surprise === 'fail' ? 'fail' : sensitivity.surprise === 'off' ? null : 'warn';
  for (const step of signature.steps ?? []) {
    const prior = knownWorld.steps?.[step.id];
    if (!prior) continue;

    if (nodeSeverity && step.nodes) {
      for (const node of step.nodes) {
        if (prior.nodes[node] == null) {
          push({
            layer: 'ui', kind: 'new', key: `${step.id} :: ${node}`, severity: nodeSeverity,
            detail: 'A control or region appeared that this step has never shown before.',
          });
        }
      }
      for (const [node, count] of Object.entries(prior.nodes)) {
        if (count < prior.seen) continue;
        if (!step.nodes.includes(node)) {
          push({
            layer: 'ui', kind: 'missing', key: `${step.id} :: ${node}`, severity: nodeSeverity,
            detail: 'A control this step always showed is no longer there.',
          });
        }
      }
    }

    const factor = Number(sensitivity.durationP95Factor ?? 1.6);
    const stats = percentiles(prior.durations ?? []);
    if (stats.p95 != null && stats.samples >= 3 && step.durationMs != null) {
      const budget = Math.max(stats.p95 * factor, stats.p95 + 250);
      if (step.durationMs > budget) {
        push({
          layer: 'duration', kind: 'new', key: `${step.id} :: slow`, severity: 'warn',
          detail: `Took ${step.durationMs}ms; the p95 of ${stats.samples} previous runs is ${stats.p95}ms ` +
                  `(budget ${Math.round(budget)}ms).`,
        });
      }
    }
  }

  out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return { seeded: false, surprises: out, knownWorldRuns: knownWorld.runs };
}

/**
 * Apply the confirmation rule.
 *
 * A surprise seen once is a note; the same surprise seen in a majority of the
 * recent runs is a finding. `history` is a list of previous surprise arrays,
 * newest last. Without this every transient blip files a ticket, and the tool
 * gets muted within a fortnight.
 */
export function classifySurprises(current, history = [], { confirmAfter = 2, window = 3 } = {}) {
  const recent = history.slice(-Math.max(0, window - 1));
  return current.map((surprise) => {
    const seen = 1 + recent.filter((run) => (run ?? []).some((s) => s.key === surprise.key && s.kind === surprise.kind)).length;
    return {
      ...surprise,
      seen,
      confirmed: seen >= confirmAfter,
      // An unconfirmed failure is reported at warning strength; the evidence is
      // still attached, so a human can act on it immediately if they want to.
      effectiveSeverity: seen >= confirmAfter ? surprise.severity : (surprise.severity === 'fail' ? 'warn' : 'info'),
    };
  });
}

// --------------------------------------------------------------- calibration

/**
 * Everything that differed between two runs of the same flow on the same build.
 *
 * Whatever changes when NOTHING changed is noise by definition. This is the
 * cheapest correct mask there is, and it costs the QA nothing to produce.
 */
export function calibrateVolatile(signatureA, signatureB) {
  const volatile = new Set();

  const compareBucket = (bucket) => {
    const a = new Set(Object.keys(signatureA[bucket] ?? {}));
    const b = new Set(Object.keys(signatureB[bucket] ?? {}));
    for (const key of a) if (!b.has(key)) volatile.add(key);
    for (const key of b) if (!a.has(key)) volatile.add(key);
  };
  compareBucket('network');
  compareBucket('console');
  compareBucket('dialogs');

  const stepsB = new Map((signatureB.steps ?? []).map((s) => [s.id, s]));
  for (const stepA of signatureA.steps ?? []) {
    const stepB = stepsB.get(stepA.id);
    if (!stepB) continue;
    const a = new Set(stepA.nodes ?? []);
    const b = new Set(stepB.nodes ?? []);
    for (const node of a) if (!b.has(node)) volatile.add(`${stepA.id} :: ${node}`);
    for (const node of b) if (!a.has(node)) volatile.add(`${stepA.id} :: ${node}`);
  }

  return [...volatile].sort();
}

/** A short, human-readable line per surprise for reports and the panel. */
export function describeSurprise(surprise) {
  const arrow = surprise.kind === 'new' ? '+' : '−';
  const confirmed = surprise.confirmed === false ? ' (unconfirmed)' : '';
  return `${arrow} [${surprise.effectiveSeverity ?? surprise.severity}] ${surprise.layer}: ${surprise.key}${confirmed}`;
}
