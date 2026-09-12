/**
 * Changing the network on purpose: force a 500, stall a call, mock a payload.
 *
 * ## Why this is separate from pinning
 *
 * `netpin.js` answers "did the CLIENT change?" by freezing the backend. This
 * file answers the opposite question: "what does the UI do when the backend
 * misbehaves?" Pinning replays what the server *did*; rules produce what it
 * *never does on demand* — a 500, a 429, a timeout, an empty list.
 *
 * They share one `Fetch` session because two interceptors on one tab would
 * fight over the same paused request and one of them would lose. Rules are
 * consulted FIRST, then the pinned HAR, then pass-through. That order is the
 * useful one: pin a flow for determinism and still force one endpoint to fail,
 * which is exactly how an error path gets tested reproducibly.
 *
 * ## What a rule may do, and what it may not
 *
 * A rule matches on method and a URL substring, and then either fulfils the
 * request with a status/body you chose, fails it with a network-level error, or
 * delays it. Deliberately NOT a general rewriting language: no regex captures,
 * no scripting, no header arithmetic. A test that needs those is describing a
 * different backend, and the honest way to test against a different backend is
 * to point at one.
 *
 * ## `times` and why the default is "every time"
 *
 * A rule with `times: 1` fires once and then steps aside, which is how "the
 * first save fails, the retry succeeds" gets written. Left unset, a rule
 * applies to every match — the common case, and the one where forgetting to set
 * a count would otherwise silently test only the first request.
 */

const api = globalThis.browser ?? globalThis.chrome;

const KEY = (tabId) => `netrules:${tabId}`;

/** More than this and the rule set is a mock server, which is not what this is. */
const MAX_RULES = 40;

/** A stall long enough to trip any real timeout without hanging a suite. */
const MAX_DELAY_MS = 60_000;

/**
 * Network-level failures a rule may produce.
 *
 * These are the CDP `ErrorReason` values that correspond to something a real
 * network does. `Failed` is the generic one and the right default: it is what a
 * dropped connection looks like to `fetch`.
 */
const ERROR_REASONS = new Set([
  'Failed', 'Aborted', 'TimedOut', 'AccessDenied', 'ConnectionClosed',
  'ConnectionReset', 'ConnectionRefused', 'ConnectionAborted', 'ConnectionFailed',
  'NameNotResolved', 'InternetDisconnected', 'AddressUnreachable', 'BlockedByClient',
]);

/**
 * Validate and store the rules for a tab.
 *
 * Validation is strict and loud. A mistyped rule that silently never matches is
 * the worst outcome here: the test passes, the error path was never exercised,
 * and nobody finds out until production.
 */
export function normaliseRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('action:"intercept" needs a non-empty "rules" array. Each rule needs at least "match".');
  }
  if (rules.length > MAX_RULES) {
    throw new Error(`${rules.length} rules is more than this is for (max ${MAX_RULES}). Point the app at a mock server instead.`);
  }

  return rules.map((rule, i) => {
    const where = `rules[${i}]`;
    if (!rule || typeof rule !== 'object') throw new Error(`${where} is not an object.`);

    const match = typeof rule.match === 'string' ? rule.match.trim() : '';
    if (!match) throw new Error(`${where} needs "match" — a substring of the URL, e.g. "/api/farm".`);

    const method = rule.method ? String(rule.method).toUpperCase() : null;

    const hasFulfil = rule.status != null || rule.body != null || rule.headers != null;
    const hasAbort = rule.abort != null && rule.abort !== false;
    const hasDelay = rule.delayMs != null;

    if (hasFulfil && hasAbort) {
      throw new Error(`${where} both fulfils and aborts. A request gets one outcome; pick "status"/"body" or "abort".`);
    }
    if (!hasFulfil && !hasAbort && !hasDelay) {
      throw new Error(
        `${where} does nothing. Give it "status" (e.g. 500), "abort" (e.g. "TimedOut"), or "delayMs".`,
      );
    }

    const status = rule.status != null ? Number(rule.status) : null;
    if (status != null && (!Number.isInteger(status) || status < 100 || status > 599)) {
      throw new Error(`${where} has status ${rule.status}, which is not an HTTP status code.`);
    }

    let abort = null;
    if (hasAbort) {
      abort = rule.abort === true ? 'Failed' : String(rule.abort);
      if (!ERROR_REASONS.has(abort)) {
        throw new Error(`${where} abort "${abort}" is not a network error. One of: ${[...ERROR_REASONS].join(', ')}.`);
      }
    }

    const delayMs = hasDelay ? Number(rule.delayMs) : 0;
    if (hasDelay && (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS)) {
      throw new Error(`${where} delayMs must be between 0 and ${MAX_DELAY_MS}.`);
    }

    const headers = rule.headers && typeof rule.headers === 'object'
      ? Object.entries(rule.headers).map(([name, value]) => ({ name: String(name), value: String(value) }))
      : [];

    // A body with no status is almost always meant as a 200 replacement.
    const effectiveStatus = status ?? (rule.body != null ? 200 : null);

    return {
      match,
      method,
      status: effectiveStatus,
      body: rule.body != null ? String(rule.body) : null,
      headers,
      abort,
      delayMs,
      times: rule.times != null ? Math.max(1, Number(rule.times)) : null,
      fired: 0,
      label: rule.label ? String(rule.label) : null,
    };
  });
}

export async function setRules(tabId, rules) {
  const normalised = normaliseRules(rules);
  await api.storage.session.set({ [KEY(tabId)]: { rules: normalised, at: Date.now() } });
  return {
    intercepting: true,
    rules: normalised.map(summarise),
  };
}

export async function clearRules(tabId) {
  const state = await rulesOf(tabId);
  await api.storage.session.remove(KEY(tabId));
  return {
    cleared: true,
    rules: (state?.rules ?? []).map(summarise),
  };
}

export async function rulesStatus(tabId) {
  const state = await rulesOf(tabId);
  if (!state) return { intercepting: false };
  return { intercepting: true, rules: state.rules.map(summarise) };
}

export async function rulesOf(tabId) {
  const stored = await api.storage.session.get(KEY(tabId));
  return stored[KEY(tabId)] ?? null;
}

/**
 * Find the first rule that should act on this request, and count the hit.
 *
 * Returns `null` when no rule applies, which is the signal for the caller to
 * fall through to the pinned HAR. Exhausted rules (`times` reached) are skipped
 * rather than removed, so `status` can still show that they fired and how often
 * — a rule that silently disappears after use makes a report unreadable.
 */
export async function pick(tabId, method, url) {
  const state = await rulesOf(tabId);
  if (!state?.rules?.length) return null;

  const upper = String(method ?? '').toUpperCase();
  const target = String(url ?? '');

  for (const rule of state.rules) {
    if (rule.times != null && rule.fired >= rule.times) continue;
    if (rule.method && rule.method !== upper) continue;
    if (!target.includes(rule.match)) continue;

    rule.fired += 1;
    await api.storage.session.set({ [KEY(tabId)]: state });
    return rule;
  }
  return null;
}

function summarise(rule) {
  const action = rule.abort
    ? `abort ${rule.abort}`
    : rule.status != null
      ? `respond ${rule.status}`
      : `delay ${rule.delayMs}ms`;
  return {
    match: rule.match,
    method: rule.method ?? 'ANY',
    action: rule.delayMs && !rule.abort && rule.status == null ? action : (rule.delayMs ? `${action} after ${rule.delayMs}ms` : action),
    fired: rule.fired,
    limit: rule.times ?? 'every time',
    label: rule.label,
  };
}
