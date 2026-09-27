/**
 * Console and network capture.
 *
 * These are *event-driven*, not request/response: CDP pushes console messages
 * and network events as they happen. We buffer them in session storage
 * so a service-worker restart does not lose the log the agent is about to ask
 * for. Buffers are ring buffers with hard caps — an app that logs in a render
 * loop must not be able to exhaust storage.
 *
 * Both buffers are read-modify-write against a single storage key, driven by
 * debugger events that arrive in bursts (one page load fires dozens of
 * Network events in the same tick). They therefore run through the shared
 * `serialize()` chain in lib/state.js — without it, interleaved writers drop
 * requests and console lines, and the agent is handed a log that looks complete
 * but is not.
 */

import { platform } from '../lib/platform.js';
import { send } from '../lib/cdp.js';
import { serialize } from '../lib/state.js';

const session = () => platform.storage.session;

const MAX_CONSOLE = 500;
const MAX_NETWORK = 400;
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Cap on a single console entry AT WRITE TIME.
 *
 * Truncating only on read is not enough: the untruncated text still had to fit
 * in storage first, so a page logging megabyte strings could reach the
 * session storage quota and take capture down with it.
 */
const MAX_ENTRY_CHARS = 4_000;

const CONSOLE_KEY = (tabId) => `console:${tabId}`;
const NETWORK_KEY = (tabId) => `network:${tabId}`;

// ---------------------------------------------------------------- ingestion

/** Called by tools/events.js for every CDP event of an attached tab. */
export async function ingest(tabId, method, params) {
  switch (method) {
    case 'Runtime.consoleAPICalled':
      return pushConsole(tabId, {
        level: params.type,
        text: params.args.map(fmtRemoteObject).join(' '),
        stack: topFrame(params.stackTrace),
        at: params.timestamp,
      });

    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails;
      return pushConsole(tabId, {
        level: 'error',
        text: d.exception?.description ?? d.text ?? 'Uncaught exception',
        stack: topFrame(d.stackTrace),
        at: params.timestamp,
        uncaught: true,
      });
    }

    case 'Log.entryAdded':
      return pushConsole(tabId, {
        level: params.entry.level,
        text: params.entry.text,
        source: params.entry.source,
        url: params.entry.url,
        at: params.entry.timestamp,
      });

    case 'Network.requestWillBeSent':
      // The only event that may CREATE a record. See upsertRequest.
      return upsertRequest(
        tabId,
        params.requestId,
        {
          requestId: params.requestId,
          // Which document this request belongs to. Used to drop the previous
          // page's traffic the moment a new one commits — see pruneToLoader.
          loaderId: params.loaderId,
          url: params.request.url,
          method: params.request.method,
          resourceType: params.type,
          startedAt: params.timestamp,
          wallTime: params.wallTime,
          requestHeaders: params.request.headers,
          hasPostData: !!params.request.hasPostData,
          status: null,
        },
        { create: true },
      );

    case 'Network.responseReceived':
      return upsertRequest(tabId, params.requestId, {
        status: params.response.status,
        statusText: params.response.statusText,
        mimeType: params.response.mimeType,
        responseHeaders: params.response.headers,
        fromCache: params.response.fromDiskCache || params.response.fromPrefetchCache,
        remoteAddress: params.response.remoteIPAddress,
        protocol: params.response.protocol,
      });

    case 'Network.loadingFinished':
      return upsertRequest(tabId, params.requestId, {
        finishedAt: params.timestamp,
        encodedDataLength: params.encodedDataLength,
      });

    case 'Network.loadingFailed':
      return upsertRequest(tabId, params.requestId, {
        failed: true,
        errorText: params.errorText,
        canceled: params.canceled,
        finishedAt: params.timestamp,
      });

    default:
      return undefined;
  }
}

/**
 * Drop both capture buffers for a tab.
 *
 * Without this they outlive the tab that produced them: closing a tab left
 * `console:<id>` and `network:<id>` in session storage until the browser shut
 * down, which is both a leak and a way to walk into the quota over a long
 * session.
 */
export async function clearBuffers(tabId) {
  await session().remove([CONSOLE_KEY(tabId), NETWORK_KEY(tabId)]);
}

/**
 * Keep only what belongs to the document that just committed.
 *
 * Clearing before `Page.navigate` is not enough on its own. The outgoing page
 * keeps running until the new document commits, and its dying ad scripts,
 * aborted requests, and tracking-prevention warnings all land in the buffer
 * *after* the clear. Navigating from an ad-heavy site to a two-line test page
 * still produced a health report of several hundred entries belonging to the
 * page we had left — attributed, in the agent's reading, to the page now open.
 *
 * `loaderId` is the honest key: every request of a document carries the same
 * one, including the document request itself, so pruning by it keeps the new
 * page complete and drops the old page entirely. Console entries carry no
 * loader, but a committed navigation means the old console is gone anyway.
 *
 * Same-document navigation (`pushState`) raises `Page.navigatedWithinDocument`,
 * not `Page.frameNavigated`, so SPA route changes correctly keep their buffers.
 */
export async function pruneToLoader(tabId, loaderId) {
  await serialize(async () => {
    const key = NETWORK_KEY(tabId);
    const stored = await session().get(key);
    const map = stored[key] ?? {};
    const kept = {};
    for (const [id, record] of Object.entries(map)) {
      if (record.loaderId === loaderId) kept[id] = record;
    }
    await session().set({ [key]: kept });
  });
  await session().remove(CONSOLE_KEY(tabId));
}

// ------------------------------------------------------------------ console

function pushConsole(tabId, entry) {
  return serialize(async () => {
    const key = CONSOLE_KEY(tabId);
    const stored = await session().get(key);
    const list = stored[key] ?? [];
    list.push({
      ...entry,
      text: truncate(entry.text, MAX_ENTRY_CHARS),
      seq: list.length ? list[list.length - 1].seq + 1 : 1,
    });
    if (list.length > MAX_CONSOLE) list.splice(0, list.length - MAX_CONSOLE);

    try {
      await session().set({ [key]: list });
    } catch {
      // Quota reached. Keep the newest quarter and say so in the data the agent
      // actually reads — failing silently here would leave it believing the log
      // is complete.
      const kept = list.slice(-Math.floor(MAX_CONSOLE / 4));
      const dropped = list.length - kept.length;
      kept.push({
        level: 'warning',
        text: `[G9BrowserAgent] console buffer hit the browser storage quota; ${dropped} older entries were dropped.`,
        at: Date.now() / 1000,
        seq: (kept[kept.length - 1]?.seq ?? 0) + 1,
      });
      await session().set({ [key]: kept });
    }
  });
}

export async function consoleLog(tabId, { level, limit = 100, since, contains, clear = false } = {}) {
  const key = CONSOLE_KEY(tabId);

  if (clear) {
    await session().remove(key);
    return { cleared: true };
  }

  const stored = await session().get(key);
  let list = stored[key] ?? [];

  if (level) {
    const wanted = new Set(Array.isArray(level) ? level : [level]);
    // "error" should also surface uncaught exceptions and severe log entries.
    list = list.filter((e) => wanted.has(e.level) || (wanted.has('error') && (e.uncaught || e.level === 'severe')));
  }
  if (since != null) list = list.filter((e) => e.seq > since);
  if (contains) {
    const needle = contains.toLowerCase();
    list = list.filter((e) => e.text?.toLowerCase().includes(needle));
  }

  const counts = (stored[key] ?? []).reduce((acc, e) => {
    const k = e.uncaught ? 'error' : e.level;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  // At the stealth level the Runtime domain is never enabled (rule R4), so the
  // page's own console.* calls and uncaught exceptions are not captured. Say so
  // in the result: an empty log that looks complete is the one answer that
  // would send someone looking in the wrong place. Browser-side Log entries
  // (network errors, interventions, violations) still arrive and are returned.
  const stealth = platform.settings.stealthFor(tabId) === 'stealth';

  return {
    ...(stealth
      ? {
          unavailable: 'Runtime domain disabled by stealth level',
          note: 'Page console.* output and uncaught exceptions are not captured at the stealth level. ' +
            'Browser-side log entries (network errors, interventions, violations) below are still complete.',
        }
      : {}),
    total: (stored[key] ?? []).length,
    counts,
    returned: Math.min(list.length, limit),
    lastSeq: list.length ? list[list.length - 1].seq : since ?? 0,
    // slice(-0) returns the whole array, so limit:0 ("counts only") must be
    // special-cased or browser_status would dump the entire buffer.
    entries: (limit <= 0 ? [] : list.slice(-limit)).map((e) => ({
      seq: e.seq,
      level: e.uncaught ? 'error' : e.level,
      text: truncate(e.text, 2000),
      ...(e.stack ? { at: e.stack } : {}),
      ...(e.url ? { url: e.url } : {}),
    })),
  };
}

// ------------------------------------------------------------------ network

/**
 * Update one request record.
 *
 * Only `Network.requestWillBeSent` may create a record (`create: true`). Every
 * other event describes a request that must already exist, and if it does not,
 * we never saw it start — capture attached mid-flight, or the buffer was reset
 * while it was in the air. Writing those patches anyway produced records with a
 * status and no method or URL, which surfaced in the health report as the
 * finding `undefined undefined -> FAILED: net::ERR_CONNECTION_CLOSED`. A
 * finding that names nothing is worse than no finding: the agent cannot act on
 * it and cannot tell it is meaningless.
 */
function upsertRequest(tabId, requestId, patch, { create = false } = {}) {
  return serialize(async () => {
    const key = NETWORK_KEY(tabId);
    const stored = await session().get(key);
    const map = stored[key] ?? {};

    if (!map[requestId] && !create) return;
    map[requestId] = { ...(map[requestId] ?? {}), ...patch };

    trimOldest(map, MAX_NETWORK);

    try {
      await session().set({ [key]: map });
    } catch {
      // Quota reached — usually a page carrying very large header sets. Keep
      // the newest quarter so capture keeps working instead of dying silently.
      trimOldest(map, Math.floor(MAX_NETWORK / 4));
      await session().set({ [key]: map });
    }
  });
}

/** Drop the oldest entries until at most `keep` remain. Mutates `map`. */
function trimOldest(map, keep) {
  const ids = Object.keys(map);
  if (ids.length <= keep) return;
  ids
    .sort((a, b) => (map[a].startedAt ?? 0) - (map[b].startedAt ?? 0))
    .slice(0, ids.length - keep)
    .forEach((id) => delete map[id]);
}

export async function network(tabId, { filter, status, method, limit = 50, clear = false } = {}) {
  const key = NETWORK_KEY(tabId);

  if (clear) {
    await session().remove(key);
    return { cleared: true };
  }

  const stored = await session().get(key);
  let list = Object.values(stored[key] ?? {});

  if (filter) {
    const needle = filter.toLowerCase();
    list = list.filter((r) => r.url?.toLowerCase().includes(needle));
  }
  if (method) list = list.filter((r) => r.method?.toUpperCase() === method.toUpperCase());
  if (status === 'failed') list = list.filter((r) => r.failed || (r.status && r.status >= 400));
  else if (status === 'pending') list = list.filter((r) => r.finishedAt == null && !r.failed);
  else if (typeof status === 'number') list = list.filter((r) => r.status === status);

  list.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  const all = Object.values(stored[key] ?? {});
  return {
    total: all.length,
    failedCount: all.filter((r) => r.failed || (r.status && r.status >= 400)).length,
    returned: Math.min(list.length, limit),
    requests: list.slice(0, limit).map((r) => ({
      requestId: r.requestId,
      method: r.method,
      url: truncate(r.url, 300),
      status: r.failed ? `FAILED: ${r.errorText}` : r.status,
      type: r.resourceType,
      size: r.encodedDataLength,
      durationMs: r.finishedAt && r.startedAt ? Math.round((r.finishedAt - r.startedAt) * 1000) : null,
      fromCache: r.fromCache || undefined,
    })),
  };
}

/** Full detail for one request, including the response body. */
export async function networkDetail(tabId, { requestId, includeBody = true }) {
  const key = NETWORK_KEY(tabId);
  const stored = await session().get(key);
  const record = (stored[key] ?? {})[requestId];
  if (!record) {
    throw new Error(`Unknown requestId "${requestId}". Call browser_network first to list requests.`);
  }

  const detail = { ...record };

  if (record.hasPostData) {
    try {
      const { postData } = await send(tabId, 'Network.getRequestPostData', { requestId });
      detail.postData = truncate(postData, MAX_BODY_BYTES);
    } catch (err) {
      detail.postData = `<unavailable: ${err.message}>`;
    }
  }

  if (includeBody && !record.failed) {
    try {
      const { body, base64Encoded } = await send(tabId, 'Network.getResponseBody', { requestId });
      detail.body = base64Encoded ? '<binary response omitted>' : truncate(body, MAX_BODY_BYTES);
      detail.bodyTruncated = !base64Encoded && body.length > MAX_BODY_BYTES;
    } catch (err) {
      // Bodies are evicted from the network cache aggressively; this is normal
      // for requests that finished long ago.
      detail.body = `<body no longer buffered: ${err.message}>`;
    }
  }

  return detail;
}

/**
 * Total response-body budget for one HAR export.
 *
 * Per-request the cap is MAX_BODY_BYTES, and 400 buffered requests at 512KB
 * each is 200MB in a single result. The transport gives up long before that:
 * `ws-server.js` drops any frame over 64MB, and it drops the CONNECTION with
 * it, so one over-eager HAR export took the whole browser session down. A HAR
 * is evidence, and evidence that cannot be delivered is worth nothing.
 */
const MAX_HAR_BODY_BYTES = 8 * 1024 * 1024;

/** Standards-shaped HAR 1.2 export from the captured request buffer. */
export async function har(tabId, { filter, includeBody = false } = {}) {
  const key = NETWORK_KEY(tabId);
  const stored = await session().get(key);
  let records = Object.values(stored[key] ?? {});
  if (filter) {
    const needle = filter.toLowerCase();
    records = records.filter((record) => record.url?.toLowerCase().includes(needle));
  }
  records.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const entries = [];
  let bodyBudget = MAX_HAR_BODY_BYTES;
  let bodiesOmitted = 0;
  for (const record of records) {
    let detail = record;
    if (includeBody && !record.failed) {
      if (bodyBudget > 0) {
        detail = await networkDetail(tabId, { requestId: record.requestId, includeBody: true });
        bodyBudget -= String(detail.body ?? '').length + String(detail.postData ?? '').length;
      } else {
        bodiesOmitted += 1;
      }
    }
    const duration = record.finishedAt && record.startedAt
      ? Math.max(0, Math.round((record.finishedAt - record.startedAt) * 1000))
      : 0;
    entries.push({
      startedDateTime: new Date((record.wallTime ?? Date.now() / 1000) * 1000).toISOString(),
      time: duration,
      request: {
        method: record.method ?? 'GET',
        url: record.url ?? '',
        httpVersion: record.protocol ?? '',
        headers: headerArray(record.requestHeaders),
        queryString: queryArray(record.url),
        cookies: [],
        headersSize: -1,
        bodySize: record.hasPostData ? -1 : 0,
        ...(detail.postData ? { postData: { mimeType: 'text/plain', text: detail.postData } } : {}),
      },
      response: {
        status: Number(record.status) || 0,
        statusText: record.statusText ?? record.errorText ?? '',
        httpVersion: record.protocol ?? '',
        headers: headerArray(record.responseHeaders),
        cookies: [],
        content: {
          size: Number(record.encodedDataLength) || 0,
          mimeType: record.mimeType ?? '',
          ...(includeBody && detail.body && !String(detail.body).startsWith('<')
            ? { text: detail.body }
            : {}),
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: Number(record.encodedDataLength) || -1,
      },
      cache: {},
      timings: { blocked: -1, dns: -1, connect: -1, send: 0, wait: duration, receive: 0, ssl: -1 },
      _g9: { requestId: record.requestId, resourceType: record.resourceType, failed: !!record.failed },
    });
  }
  return {
    log: {
      version: '1.2',
      creator: { name: 'G9BrowserAgent', version: platform.runtime.version() },
      pages: [],
      entries,
    },
    entryCount: entries.length,
    includesBodies: includeBody,
    ...(bodiesOmitted
      ? {
          bodiesOmitted,
          note:
            `Response bodies were included until the ${MAX_HAR_BODY_BYTES / 1048576}MB budget ran out; ` +
            `${bodiesOmitted} later entries carry headers and timing only. Narrow it with \`filter\`, or ` +
            `fetch a specific body with browser_network requestId:"…".`,
        }
      : {}),
  };
}

function headerArray(headers) {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value: String(value) }));
}

function queryArray(url) {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------- helpers

function fmtRemoteObject(arg) {
  if (arg.type === 'string') return arg.value;
  if ('value' in arg) return JSON.stringify(arg.value);
  if (arg.unserializableValue) return arg.unserializableValue;
  if (arg.preview) {
    const props = (arg.preview.properties ?? []).map((p) => `${p.name}: ${p.value}`).join(', ');
    return `${arg.preview.description ?? arg.className ?? 'Object'} { ${props} }`;
  }
  return arg.description ?? arg.className ?? arg.type;
}

function topFrame(stackTrace) {
  const f = stackTrace?.callFrames?.[0];
  if (!f) return null;
  const file = (f.url ?? '').split('/').pop() || f.url;
  return `${f.functionName || '(anonymous)'} @ ${file}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
}

function truncate(s, n) {
  if (s == null) return s;
  const str = String(s);
  return str.length > n ? `${str.slice(0, n)}… [truncated ${str.length - n}]` : str;
}
