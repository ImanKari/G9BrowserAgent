/**
 * Console and network capture.
 *
 * These are *event-driven*, not request/response: CDP pushes console messages
 * and network events as they happen. We buffer them in chrome.storage.session
 * so a service-worker restart does not lose the log the agent is about to ask
 * for. Buffers are ring buffers with hard caps — an app that logs in a render
 * loop must not be able to exhaust storage.
 */

import { send } from '../lib/cdp.js';

const api = globalThis.browser ?? globalThis.chrome;

const MAX_CONSOLE = 500;
const MAX_NETWORK = 400;
const MAX_BODY_BYTES = 512 * 1024;

const CONSOLE_KEY = (tabId) => `console:${tabId}`;
const NETWORK_KEY = (tabId) => `network:${tabId}`;

// ---------------------------------------------------------------- ingestion

/** Called by sw.js for every chrome.debugger event. */
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
      return upsertRequest(tabId, params.requestId, {
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        resourceType: params.type,
        startedAt: params.timestamp,
        requestHeaders: params.request.headers,
        hasPostData: !!params.request.hasPostData,
        status: null,
      });

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

// ------------------------------------------------------------------ console

async function pushConsole(tabId, entry) {
  const key = CONSOLE_KEY(tabId);
  const stored = await api.storage.session.get(key);
  const list = stored[key] ?? [];
  list.push({ ...entry, seq: list.length ? list[list.length - 1].seq + 1 : 1 });
  if (list.length > MAX_CONSOLE) list.splice(0, list.length - MAX_CONSOLE);
  await api.storage.session.set({ [key]: list });
}

export async function consoleLog(tabId, { level, limit = 100, since, contains, clear = false } = {}) {
  const key = CONSOLE_KEY(tabId);

  if (clear) {
    await api.storage.session.remove(key);
    return { cleared: true };
  }

  const stored = await api.storage.session.get(key);
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

  return {
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

async function upsertRequest(tabId, requestId, patch) {
  const key = NETWORK_KEY(tabId);
  const stored = await api.storage.session.get(key);
  const map = stored[key] ?? {};
  map[requestId] = { ...(map[requestId] ?? {}), ...patch };

  const ids = Object.keys(map);
  if (ids.length > MAX_NETWORK) {
    ids
      .sort((a, b) => (map[a].startedAt ?? 0) - (map[b].startedAt ?? 0))
      .slice(0, ids.length - MAX_NETWORK)
      .forEach((id) => delete map[id]);
  }
  await api.storage.session.set({ [key]: map });
}

export async function network(tabId, { filter, status, method, limit = 50, clear = false } = {}) {
  const key = NETWORK_KEY(tabId);

  if (clear) {
    await api.storage.session.remove(key);
    return { cleared: true };
  }

  const stored = await api.storage.session.get(key);
  let list = Object.values(stored[key] ?? {});

  if (filter) {
    const needle = filter.toLowerCase();
    list = list.filter((r) => r.url?.toLowerCase().includes(needle));
  }
  if (method) list = list.filter((r) => r.method?.toUpperCase() === method.toUpperCase());
  if (status === 'failed') list = list.filter((r) => r.failed || (r.status && r.status >= 400));
  else if (status === 'pending') list = list.filter((r) => r.status == null && !r.failed);
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
  const stored = await api.storage.session.get(key);
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
