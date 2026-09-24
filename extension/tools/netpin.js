/**
 * Pinning the network: record once, replay the same backend every time.
 *
 * ## Why this exists
 *
 * When a run goes red, the first question is always "is this the UI or the
 * backend?" — and answering it usually costs somebody an afternoon. Pinning
 * removes the question. The flow is recorded once against a real server; from
 * then on the recorded responses are served from a HAR, so **any** difference
 * in the result is the client's doing. Nothing else about the run changes.
 *
 * The second reason is determinism. A retried test that hits a live API sees
 * different data each time, so a retry is not a repeat. Pinned, every retry
 * sees byte-identical responses, which is what makes "it failed twice" mean
 * something.
 *
 * ## The two lanes, and why both are kept
 *
 * | Lane | Backend | Answers |
 * |---|---|---|
 * | live | the real server | does the whole system still work |
 * | pinned | a recorded HAR | did the client change |
 *
 * A pinned run that goes red while the live run is green is a client
 * regression. A live run that goes red while the pinned run is green is the
 * backend or the data. That single fact is worth most of what this file costs.
 *
 * ## Deliberate limits
 *
 * - **Matching is by method + normalised URL**, first unconsumed entry wins.
 *   Request bodies are not matched on: two POSTs to the same endpoint with
 *   different payloads are served in the order they were recorded. Matching on
 *   body would need a normaliser per API and is the kind of cleverness that
 *   fails silently.
 * - **Unmatched requests pass through by default.** `strict: true` fails them
 *   instead, which is the honest setting for a test that claims to be hermetic —
 *   but it is opt-in, because a page that loads one un-recorded font should not
 *   look like a product bug.
 * - The HAR lives in session storage, so it is per-tab, never touches
 *   disk, and dies with the browser. Bodies are capped; a pinned HAR is a test
 *   fixture, not an archive.
 */

import { platform } from '../lib/platform.js';
import { send, ensureDomain, sendOnLiveSession } from '../lib/cdp.js';
import * as netrules from './netrules.js';
import { har as captureHar } from './observe.js';

const session = () => platform.storage.session;

const KEY = (tabId) => `netpin:${tabId}`;

/**
 * One tab's pin state changes one step at a time (storage only — never a CDP
 * call inside, so a slow browser cannot hold a paused request behind it).
 *
 * Paused requests arrive in parallel. Unserialised, two requests for the same
 * operation both took the FIRST recorded response (each shifted its own copy
 * of the queue) and the counters lost hits; and a request handled across an
 * `unpin` wrote the pin back, so `pin_status` said pinned after unpin.
 */
const chains = new Map();
function exclusive(tabId, fn) {
  const run = (chains.get(tabId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(tabId, tail);
  tail.then(() => {
    if (chains.get(tabId) === tail) chains.delete(tabId);
  });
  return run;
}

/** Bodies above this are served as an empty 200 with a header saying so. */
const MAX_BODY_BYTES = 512 * 1024;
/** A pinned HAR beyond this many entries is a recording of a session, not a test. */
const MAX_ENTRIES = 600;

/**
 * Record the current tab's traffic as a HAR.
 *
 * This is deliberately the same capture `browser_network format:"har"` returns —
 * there is one network truth in this extension and pinning does not get its own.
 */
export async function record(tabId, { filter } = {}) {
  const har = await captureHar(tabId, { filter, includeBody: true });
  const entries = har?.log?.entries ?? [];
  return {
    recorded: entries.length,
    truncated: entries.length > MAX_ENTRIES,
    har: entries.length > MAX_ENTRIES
      ? { ...har, log: { ...har.log, entries: entries.slice(0, MAX_ENTRIES) } }
      : har,
  };
}

/** Method + path + sorted query keys. Values are ignored on purpose — see above. */
function matchKey(method, url) {
  let path = url;
  let query = '';
  try {
    const parsed = new URL(url);
    path = `${parsed.origin}${parsed.pathname}`;
    const keys = [...parsed.searchParams.keys()].sort();
    query = keys.length ? `?${keys.join('&')}` : '';
  } catch {
    /* a relative or opaque URL matches on its literal text */
  }
  return `${(method ?? 'GET').toUpperCase()} ${path}${query}`;
}

function indexHar(har) {
  const index = {};
  for (const entry of har?.log?.entries ?? []) {
    const key = matchKey(entry.request?.method, entry.request?.url);
    (index[key] ??= []).push({
      status: entry.response?.status ?? 200,
      headers: (entry.response?.headers ?? [])
        .filter((h) => !/^(content-encoding|content-length|transfer-encoding)$/i.test(h.name))
        .map((h) => ({ name: h.name, value: String(h.value ?? '') })),
      mime: entry.response?.content?.mimeType ?? 'application/octet-stream',
      text: typeof entry.response?.content?.text === 'string'
        ? entry.response.content.text.slice(0, MAX_BODY_BYTES)
        : '',
    });
  }
  return index;
}

/**
 * Serve this tab's requests from a HAR.
 *
 * `Fetch.enable` is a heavyweight switch — every request in the tab now waits
 * for us — so the pin is per tab, is cleared on unpin, tab close and detach,
 * and reports how many requests it actually served so a silent no-op is
 * impossible to mistake for a working pin.
 */
export async function pin(tabId, { har, strict = false, filter } = {}) {
  if (!har?.log?.entries?.length) {
    throw new Error('pin needs a HAR with entries. Capture one first with action:"record".');
  }
  const index = indexHar(har);
  const total = Object.values(index).reduce((sum, list) => sum + list.length, 0);

  await ensureDomain(tabId, 'Fetch');
  await send(tabId, 'Fetch.enable', {
    patterns: [{ urlPattern: filter ? `*${filter}*` : '*', requestStage: 'Request' }],
  });

  await exclusive(tabId, () => session().set({
    [KEY(tabId)]: { index, strict, filter: filter ?? null, served: 0, passed: 0, failed: 0, at: Date.now() },
  }));

  return { pinned: true, operations: Object.keys(index).length, responses: total, strict, filter: filter ?? null };
}

/**
 * Turn on interception for RULES alone, with no HAR behind it.
 *
 * Pinning and rules share one `Fetch` session, so whichever is switched on
 * first owns it. This is the entry point for "I only want to force a 500":
 * enabling Fetch without a HAR means every unmatched request simply continues.
 */
export async function enableForRules(tabId, { filter } = {}) {
  await ensureDomain(tabId, 'Fetch');
  await send(tabId, 'Fetch.enable', {
    patterns: [{ urlPattern: filter ? `*${filter}*` : '*', requestStage: 'Request' }],
  });
  return { enabled: true, filter: filter ?? null };
}

/** Is a HAR pinned on this tab? Used to decide whether disabling Fetch is safe. */
export async function isPinned(tabId) {
  return (await stateOf(tabId)) != null;
}

export async function unpin(tabId) {
  // Intercept rules share this Fetch session. While any remain, Fetch stays on
  // — for every URL again, since a pin may have narrowed it with a filter —
  // or unpinning would silently switch off a failure the agent is testing.
  const rules = await netrules.rulesOf(tabId).catch(() => null);
  if (rules?.rules?.length) await enableForRules(tabId).catch(() => {});
  else await send(tabId, 'Fetch.disable').catch(() => {});
  const state = await exclusive(tabId, async () => {
    const current = await stateOf(tabId);
    await session().remove(KEY(tabId));
    return current;
  });
  return {
    unpinned: true,
    served: state?.served ?? 0,
    passedThrough: state?.passed ?? 0,
    failed: state?.failed ?? 0,
  };
}

export async function status(tabId) {
  const state = await stateOf(tabId);
  if (!state) return { pinned: false };
  return {
    pinned: true,
    operations: Object.keys(state.index).length,
    served: state.served,
    passedThrough: state.passed,
    failed: state.failed,
    strict: state.strict,
  };
}

async function stateOf(tabId) {
  const stored = await session().get(KEY(tabId));
  return stored[KEY(tabId)] ?? null;
}

/**
 * The interception handler, called from the service worker's CDP event router.
 *
 * Every path here ends in exactly one of `fulfillRequest`, `continueRequest` or
 * `failRequest`. A paused request that is never answered hangs the page
 * forever, so the catch-all at the bottom continues rather than logging and
 * returning — a bug in this file must not be able to freeze the tab.
 *
 * The answers go out on the live session WITHOUT `send()`'s guards. `send()`
 * refuses everything while the user's Stop is on — which made every paused
 * request on a pinned or intercepted tab hang the moment Stop was pressed,
 * freezing the very page the person had stopped the agent to look at. Stop
 * halts the agent; answering the browser is not the agent acting.
 */
export async function onRequestPaused(tabId, params) {
  const answer = (method, extra = {}) =>
    sendOnLiveSession(tabId, method, { requestId: params.requestId, ...extra });

  // Rules first, then the pinned HAR, then pass-through.
  //
  // That order is what lets a flow be pinned for determinism AND still force one
  // endpoint to fail. The other order would make the rule unreachable for any
  // request the HAR happened to cover, which is most of them.
  try {
    const rule = await netrules.pick(tabId, params.request?.method, params.request?.url);
    if (rule) {
      if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));

      if (rule.abort) {
        await answer('Fetch.failRequest', { errorReason: rule.abort });
        return;
      }
      if (rule.status != null) {
        await answer('Fetch.fulfillRequest', {
          responseCode: rule.status,
          responseHeaders: [
            ...rule.headers,
            // Say so in the response itself. A 500 that a rule produced and a 500
            // the server produced are indistinguishable in devtools otherwise, and
            // somebody will eventually chase the wrong one.
            { name: 'x-g9-intercepted', value: rule.label ?? rule.match },
          ],
          body: toBase64(rule.body ?? ''),
        });
        return;
      }
      // delay-only: fall through and let the request proceed, just later.
    }
  } catch {
    // A broken rule must not hang the tab; fall through to the normal paths.
  }

  // Decide under the tab's lock — including the queue shift, persisted at
  // once, so a parallel request for the same operation gets the NEXT response.
  const key = matchKey(params.request?.method, params.request?.url);
  const decision = await exclusive(tabId, async () => {
    const state = await stateOf(tabId);
    if (!state) return null;
    const queue = state.index[key];
    let chosen;
    if (queue?.length) {
      // Shift so a repeated call gets the SECOND recorded response, which is
      // how a paged list or a poll replays correctly.
      const shifted = queue.length > 1;
      chosen = { kind: 'fulfill', response: shifted ? queue.shift() : queue[0], shifted, pinAt: state.at };
      if (shifted) await session().set({ [KEY(tabId)]: state });
    } else {
      chosen = { kind: state.strict ? 'fail' : 'continue' };
    }
    return chosen;
  }).catch(() => null);

  if (!decision) {
    // Not pinned (any more). Let it through; Fetch may still be enabled for a
    // moment while the disable command is in flight.
    await answer('Fetch.continueRequest').catch(() => {});
    return;
  }

  // Answer outside the lock; count only what actually happened.
  let outcome = null;
  try {
    if (decision.kind === 'fulfill') {
      await answer('Fetch.fulfillRequest', {
        responseCode: decision.response.status,
        responseHeaders: [
          ...decision.response.headers,
          { name: 'x-g9-pinned', value: '1' },
        ],
        body: toBase64(decision.response.text),
      });
      outcome = 'served';
    } else if (decision.kind === 'fail') {
      await answer('Fetch.failRequest', { errorReason: 'BlockedByClient' });
      outcome = 'failed';
    } else {
      await answer('Fetch.continueRequest');
      outcome = 'passed';
    }
  } catch {
    outcome = await answer('Fetch.continueRequest').then(() => 'passed', () => null);
  }

  if (!outcome && decision.kind === 'fulfill' && decision.shifted) {
    // Neither answer was taken: the request is gone (the page cancelled it, or
    // the tab navigated away). Nothing was served, so the recorded response goes
    // back to the FRONT of its queue — the next request for the same operation
    // gets it, as it would have without the cancelled one. Only for the same pin:
    // a re-pin has a queue of its own.
    await exclusive(tabId, async () => {
      const state = await stateOf(tabId);
      if (!state || state.at !== decision.pinAt) return;
      state.index[key] = [decision.response, ...(state.index[key] ?? [])];
      await session().set({ [KEY(tabId)]: state });
    }).catch(() => {});
  }

  if (outcome) {
    await exclusive(tabId, async () => {
      const state = await stateOf(tabId);
      if (!state) return; // unpinned meanwhile: nothing to count into
      state[outcome] += 1;
      await session().set({ [KEY(tabId)]: state });
    }).catch(() => {});
  }
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text ?? '');
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
