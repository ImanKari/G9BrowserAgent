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
 * - The HAR lives in `chrome.storage.session`, so it is per-tab, never touches
 *   disk, and dies with the browser. Bodies are capped; a pinned HAR is a test
 *   fixture, not an archive.
 */

import { send, ensureDomain } from '../lib/cdp.js';
import { har as captureHar } from './observe.js';

const api = globalThis.browser ?? globalThis.chrome;

const KEY = (tabId) => `netpin:${tabId}`;

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

  await api.storage.session.set({
    [KEY(tabId)]: { index, strict, filter: filter ?? null, served: 0, passed: 0, failed: 0, at: Date.now() },
  });

  return { pinned: true, operations: Object.keys(index).length, responses: total, strict, filter: filter ?? null };
}

export async function unpin(tabId) {
  const state = await stateOf(tabId);
  await send(tabId, 'Fetch.disable').catch(() => {});
  await api.storage.session.remove(KEY(tabId));
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
  const stored = await api.storage.session.get(KEY(tabId));
  return stored[KEY(tabId)] ?? null;
}

/**
 * The interception handler, called from the service worker's CDP event router.
 *
 * Every path here ends in exactly one of `fulfillRequest`, `continueRequest` or
 * `failRequest`. A paused request that is never answered hangs the page
 * forever, so the catch-all at the bottom continues rather than logging and
 * returning — a bug in this file must not be able to freeze the tab.
 */
export async function onRequestPaused(tabId, params) {
  const state = await stateOf(tabId);
  if (!state) {
    // Not pinned (any more). Let it through; Fetch may still be enabled for a
    // moment while the disable command is in flight.
    await send(tabId, 'Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
    return;
  }

  const key = matchKey(params.request?.method, params.request?.url);
  const queue = state.index[key];

  try {
    if (queue?.length) {
      // Shift so a repeated call gets the SECOND recorded response, which is
      // how a paged list or a poll replays correctly.
      const response = queue.length > 1 ? queue.shift() : queue[0];
      await send(tabId, 'Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: response.status,
        responseHeaders: [
          ...response.headers,
          { name: 'x-g9-pinned', value: '1' },
        ],
        body: toBase64(response.text),
      });
      state.served += 1;
    } else if (state.strict) {
      await send(tabId, 'Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' });
      state.failed += 1;
    } else {
      await send(tabId, 'Fetch.continueRequest', { requestId: params.requestId });
      state.passed += 1;
    }
  } catch {
    await send(tabId, 'Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
  }

  await api.storage.session.set({ [KEY(tabId)]: state });
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
