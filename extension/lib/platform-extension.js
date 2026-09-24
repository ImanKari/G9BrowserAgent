/**
 * The platform seam, Engine 1: thin wrappers over `chrome.*`.
 *
 * Everything the shared tool code needs from "the browser it runs in" goes
 * through `lib/platform.js`, which picks this file inside the extension and
 * `platform-cdp.js` inside the daemon. This is one of only three files under
 * extension/lib that may touch `chrome.*` (with `transport.js` and the
 * selector in `platform.js`); see ARCHITECTURE_V2 §3 and rule R2.
 *
 * ## Nothing here may run at import time
 *
 * `platform.js` imports BOTH implementations statically (no top-level await in
 * a service worker, and the daemon needs the file to evaluate in Node). So this
 * module must evaluate cleanly where `chrome` does not exist. Every `chrome.*`
 * access is inside a function, and the only top-level work — registering the
 * `chrome.downloads` listeners — is guarded.
 *
 * Why the downloads listeners ARE registered at top level: an MV3 worker is
 * revived by an event only if a listener for it was added synchronously while
 * the module evaluated. A download that finishes while the worker sleeps would
 * otherwise never be reported.
 */

const api = () => globalThis.browser ?? globalThis.chrome;

/** CDP protocol version. 1.3 is the stable Chrome/Edge protocol. */
const PROTOCOL = '1.3';

// ------------------------------------------------------------------ debugger

const debuggerApi = {
  /**
   * Idempotent. Chrome refuses a second attach with "Another debugger is
   * already attached"; when the browser says the tab IS attached, that is us
   * from before a worker restart (or DevTools, which coexists since Chrome 63),
   * so it is not an error. cdp.js keeps its own check as well — the message is
   * the only signal, and two readings of it cost nothing.
   */
  async attach(tabId) {
    try {
      await api().debugger.attach({ tabId }, PROTOCOL);
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (msg.includes('Another debugger') || msg.includes('already attached')) {
        const targets = await api().debugger.getTargets();
        if (targets.some((t) => t.tabId === tabId && t.attached)) return;
      }
      throw err;
    }
  },

  async detach(tabId) {
    await api().debugger.detach({ tabId });
  },

  /**
   * `sessionId` routes the command to a CHILD target (a cross-origin iframe or
   * a worker). Chrome 125 added flat sessions to `chrome.debugger`, which is
   * what makes this a property on the debuggee rather than a second attach per
   * frame. The fifth argument (`{ timeoutMs }`) is accepted for parity with
   * platform-cdp and ignored: cdp.js enforces its own timeout.
   */
  sendCommand(tabId, method, params = {}, sessionId = null) {
    const debuggee = sessionId ? { tabId, sessionId } : { tabId };
    return api().debugger.sendCommand(debuggee, method, params);
  },

  async getTargets() {
    const targets = await api().debugger.getTargets();
    return targets.filter((t) => t.tabId != null).map((t) => ({ tabId: t.tabId, attached: !!t.attached }));
  },

  /** Adds a listener. Returns an unsubscribe function (a superset of the contract). */
  onEvent(fn) {
    const listener = (source, method, params) => {
      if (source?.tabId == null) return;
      fn(source.sessionId ? { tabId: source.tabId, sessionId: source.sessionId } : { tabId: source.tabId }, method, params);
    };
    api().debugger.onEvent.addListener(listener);
    return () => api().debugger.onEvent.removeListener(listener);
  },

  onDetach(fn) {
    const listener = (source, reason) => {
      if (source?.tabId == null) return;
      fn({ tabId: source.tabId }, reason);
    };
    api().debugger.onDetach.addListener(listener);
    return () => api().debugger.onDetach.removeListener(listener);
  },
};

// ---------------------------------------------------------------------- tabs

const tabs = {
  get: (tabId) => api().tabs.get(tabId),
  query: (info = {}) => api().tabs.query(info),
  create: ({ url, active = false, windowId } = {}) =>
    api().tabs.create({ url, active, ...(windowId != null ? { windowId } : {}) }),
  update: (tabId, patch = {}) => api().tabs.update(tabId, patch),
  async remove(tabId) {
    await api().tabs.remove(tabId);
  },
  /**
   * Launched engines bring a headless tab that is behind another to the front before input
   * (platform-cdp). A person's own browser is never rearranged by G9 itself: the answer is
   * 'unknown', and browser_status says when the current tab is not in front.
   */
  async ensureFront() {
    return null;
  },
  onRemoved(fn) {
    api().tabs.onRemoved.addListener((tabId, info) => fn(tabId, info));
  },
  onCreated(fn) {
    api().tabs.onCreated.addListener((tab) => fn(tab));
  },
  onUpdated(fn) {
    api().tabs.onUpdated.addListener((tabId, changeInfo, tab) => fn(tabId, changeInfo, tab));
  },
};

// ------------------------------------------------------------------- windows

const windows = {
  WINDOW_ID_NONE: -1,
  get: (windowId, opts = {}) => api().windows.get(windowId, opts),
  getAll: (opts = {}) => api().windows.getAll(opts),
  create: (opts) => api().windows.create(opts),
  update: (windowId, opts) => api().windows.update(windowId, opts),
  onFocusChanged(fn) {
    api().windows.onFocusChanged.addListener((windowId) => fn(windowId));
  },
};

// ------------------------------------------------------------------- cookies

/**
 * `chrome.cookies` already speaks the contract's shape, HttpOnly included.
 * The one adjustment: tool code may pass `tabId` so platform-cdp can pick the
 * right browser context. Chrome validates its argument strictly and rejects an
 * unknown property, so it is stripped here.
 */
const cookies = {
  getAll(filter = {}) {
    const { tabId, ...rest } = filter;
    return api().cookies.getAll(rest);
  },
  async set(details) {
    const { tabId, ...rest } = details ?? {};
    return (await api().cookies.set(rest)) ?? null;
  },
  async remove({ url, name }) {
    await api().cookies.remove({ url, name });
  },
};

// ------------------------------------------------------------------- storage

function area(name) {
  return {
    get: (keys) => api().storage[name].get(keys ?? null),
    set: (obj) => api().storage[name].set(obj),
    remove: (keys) => api().storage[name].remove(keys),
    /** Chrome 130+; callers must treat it as optional. */
    getKeys: typeof globalThis.chrome?.storage?.[name]?.getKeys === 'function'
      ? () => api().storage[name].getKeys()
      : undefined,
  };
}

const storage = {
  session: area('session'),
  local: area('local'),
};

// --------------------------------------------------------------------- blobs

/**
 * IndexedDB, moved here verbatim from store.js.
 *
 * Same database name, version, store names and index names as v1 — an upgrade
 * must not orphan a single screenshot anyone already filed. `storage.local` is a
 * JSON key-value store; putting megabytes of base64 in it means every read of
 * any key deserialises them. IndexedDB stores Blobs natively and reads one by id,
 * which is what keeps listing issues fast when one of them carries a 20MB video.
 */
const DB_NAME = 'g9-attachments';
const DB_VERSION = 2;

/** Contract field → IndexedDB index name. The v1 frame index is called "session". */
const INDEXES = {
  blobs: { owner: 'owner' },
  'video-frames': { sessionId: 'session' },
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('blobs')) {
        const store = db.createObjectStore('blobs', { keyPath: 'id' });
        // Deleting an issue must be able to find its attachments without
        // scanning every blob in the database.
        store.createIndex('owner', 'owner', { unique: false });
      }
      if (!db.objectStoreNames.contains('video-frames')) {
        const frames = db.createObjectStore('video-frames', { keyPath: 'id' });
        frames.createIndex('session', 'sessionId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    // Never cache a rejected promise: a transient failure would otherwise make
    // attachments permanently unavailable for the life of the worker.
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

/** Run `fn(store)` in one transaction; resolve with its request's result once committed. */
function tx(storeName, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        transaction.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      }),
  );
}

/** Wrap an IDBRequest so tx() resolves with its result once the tx commits. */
const req = (r) => ({ __req: r });

function toStorable(record) {
  // Bytes are kept as a Blob, exactly as v1 stored them, so rows written by
  // either version read back the same way.
  if (record?.blob instanceof Uint8Array) {
    return { ...record, blob: new Blob([record.blob], { type: record.mime || 'application/octet-stream' }) };
  }
  return record;
}

/** A cursor walk for fields that have no index. Rare; nothing in v2 relies on it. */
function scan(storeName, field, value) {
  return tx(storeName, 'readonly', (store) => {
    const rows = [];
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.value?.[field] === value) rows.push(cursor.value);
      cursor.continue();
    };
    return rows;
  });
}

const blobs = {
  async put(storeName, record) {
    await tx(storeName, 'readwrite', (store) => req(store.put(toStorable(record))));
  },
  async get(storeName, id) {
    return (await tx(storeName, 'readonly', (store) => req(store.get(id)))) ?? null;
  },
  async delete(storeName, id) {
    await tx(storeName, 'readwrite', (store) => req(store.delete(id)));
  },
  async byIndex(storeName, field, value) {
    const index = INDEXES[storeName]?.[field];
    if (!index) return scan(storeName, field, value);
    return (await tx(storeName, 'readonly', (store) => req(store.index(index).getAll(value)))) ?? [];
  },
  async deleteByIndex(storeName, field, value) {
    const index = INDEXES[storeName]?.[field];
    const keys = index
      ? await tx(storeName, 'readonly', (store) => req(store.index(index).getAllKeys(value)))
      : (await scan(storeName, field, value)).map((row) => row.id);
    if (!keys?.length) return 0;
    await tx(storeName, 'readwrite', (store) => {
      for (const key of keys) store.delete(key);
      return keys.length;
    });
    return keys.length;
  },
  /**
   * Count and total `size` of a store, for the panel's usage line.
   *
   * A cursor rather than `getAll()`: the side panel polls this every 2.5s while
   * its Issues tab is open, and `getAll()` structured-clones every record, Blob
   * handles included, to add up one number. (Not in the contract's surface;
   * store.js treats it as optional.)
   */
  stats(storeName) {
    return tx(storeName, 'readonly', (store) => {
      const acc = { count: 0, bytes: 0 };
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        acc.count += 1;
        acc.bytes += cursor.value?.size || 0;
        cursor.continue();
      };
      return acc;
    });
  },
};

// --------------------------------------------------------------------- image

function base64ToBytes(dataBase64) {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  // Chunked: String.fromCharCode with a few hundred thousand arguments
  // overflows the call stack, and a full-page PNG reaches that easily.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function requireCanvas() {
  if (typeof globalThis.createImageBitmap !== 'function' || typeof globalThis.OffscreenCanvas !== 'function') {
    throw new Error('This Chromium build does not expose OffscreenCanvas/createImageBitmap to extension workers.');
  }
}

/**
 * Target size for a decode. `width`+`height` STRETCH to exactly that box — the
 * v1 fingerprints (`luma-32x32-v1`, `edge-64x64-v1`) were computed that way and
 * every stored baseline depends on it. `fit` keeps the aspect ratio inside a
 * square box and never enlarges.
 */
export function targetSize(sourceWidth, sourceHeight, { fit, width, height } = {}) {
  if (width && height) return { width: Math.round(width), height: Math.round(height) };
  if (fit) {
    const scale = Math.min(1, fit / sourceWidth, fit / sourceHeight);
    return { width: Math.max(1, Math.round(sourceWidth * scale)), height: Math.max(1, Math.round(sourceHeight * scale)) };
  }
  return { width: sourceWidth, height: sourceHeight };
}

const image = {
  async decode(dataBase64, mime = 'image/png', opts = {}) {
    requireCanvas();
    const bitmap = await createImageBitmap(new Blob([base64ToBytes(dataBase64)], { type: mime }));
    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    const size = targetSize(sourceWidth, sourceHeight, opts);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close?.();
    const rgba = context.getImageData(0, 0, size.width, size.height).data;
    return { width: size.width, height: size.height, rgba, sourceWidth, sourceHeight };
  },

  async encodePng({ width, height, rgba }) {
    requireCanvas();
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    const pixels = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
    context.putImageData(new ImageData(pixels, width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  },
};

// ------------------------------------------------------------------- runtime

const runtime = {
  version: () => api()?.runtime?.getManifest?.().version ?? 'unknown',
  getURL: (path) => api()?.runtime?.getURL?.(path) ?? null,
  reload: () => api().runtime.reload(),
  /**
   * Push an update to the side panel. The panel may not be open — a failed
   * sendMessage is normal and must not surface as an unhandled rejection.
   */
  broadcast(message) {
    try {
      const p = api()?.runtime?.sendMessage({ __g9: true, ...message });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* no receiver */
    }
  },
};

// ------------------------------------------------------------------ settings

/**
 * The input level chosen in the side panel, cached synchronously.
 *
 * `humanizeFor`/`stealthFor` are sync by contract (they sit on hot paths such
 * as cdp.attach's domain list), and storage is async. `state.js` calls
 * `noteInputMode()` on every getState/setState, so the cache is current as soon
 * as anything has read state — which every tool call does before it acts. Until
 * then the default is the documented one, 'human'.
 *
 * Decision D-b as it applies to the person's own browser:
 *   - `humanizeFor` is the panel's setting as the DEFAULT level: a call that
 *     names no `humanize` runs at it;
 *   - `stealthFor` is 'stealth' only when the panel says Stealth, and 'off'
 *     otherwise. humanize.js levelFor treats it as a floor, so only Stealth is
 *     one: with the panel at Human (or Direct) an agent's `humanize:"off"`
 *     gets direct input, and with the panel at Stealth every action gets
 *     stealth input whatever the call asks for.
 */
let inputMode = 'human';
const LEVELS = new Set(['off', 'human', 'stealth']);

const settings = {
  humanizeFor: () => inputMode,
  stealthFor: () => (inputMode === 'stealth' ? 'stealth' : 'off'),
  noteInputMode(mode) {
    if (LEVELS.has(mode)) inputMode = mode;
  },
};

// ----------------------------------------------------------------- downloads

/**
 * Engine 1 download tracking over `chrome.downloads` (EXT-02).
 *
 * v1 used `Browser.setDownloadBehavior`, which `chrome.debugger` refuses — the
 * real-Edge audit returned "'Browser.setDownloadBehavior' wasn't found". An
 * extension is an untrusted CDP client; the Browser domain is closed to it.
 *
 * `chrome.downloads` has no tab id on a DownloadItem, so attribution is
 * inferred, and the result SAYS how:
 *   - 'exact'    the download URL is a request that tab's Network capture saw;
 *   - 'probable' the referrer or blob:/data: origin is that tab's origin, or it
 *                is the only tab being watched and the download began after
 *                the watch started;
 *   - 'unknown'  none of the above — reported with tabId null, never guessed.
 *
 * Watched tabs and per-download attribution live in storage.session, because
 * the worker may be evicted between `onCreated` and completion.
 *
 * Nothing is reported while no tab is watched: a download the person starts
 * on their own is theirs, not evidence for a test, and it never leaves the
 * browser.
 */
const WATCH_KEY = 'g9:dl:watch';
const ITEM_KEY = (id) => `g9:dl:item:${id}`;
const downloadListeners = new Set();

/**
 * onCreated's attribution while it is still being worked out, by download id.
 *
 * Attribution awaits storage and `tabs.get`; a small file (a CSV export, a
 * data: URL) can COMPLETE before that finishes, and `onChanged` used to find
 * no record, conclude "began before anything was watching" and drop the
 * completion — `wait_download` then timed out on a download that had finished.
 * `onChanged` waits for this instead.
 */
const pendingMeta = new Map();

/**
 * The watch list is one storage key, read-modify-written by begin() and end().
 * Two tabs starting a watch at the same moment must not lose one of them.
 */
let watchChain = Promise.resolve();
function updateWatched(mutate) {
  const run = watchChain.then(async () => {
    const watched = await watchedTabs();
    if (mutate(watched) === false) return watched;
    await api().storage.session.set({ [WATCH_KEY]: watched });
    return watched;
  });
  watchChain = run.catch(() => {});
  return run;
}

function emitDownload(evt) {
  for (const fn of downloadListeners) {
    try {
      fn(evt);
    } catch (err) {
      console.error('[G9] download listener failed', err);
    }
  }
}

function stateOf(item) {
  if (item.state === 'complete') return 'complete';
  if (item.state === 'interrupted') {
    return /CANCELED/i.test(item.error ?? '') ? 'canceled' : 'interrupted';
  }
  return 'in_progress';
}

function originOf(url) {
  try {
    const u = new URL(url);
    // blob:https://site/uuid has the origin of the page that created it.
    if (u.protocol === 'blob:') return new URL(u.pathname).origin;
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

async function watchedTabs() {
  const stored = await api().storage.session.get(WATCH_KEY);
  return stored[WATCH_KEY] ?? {};
}

/**
 * The origins a watched tab speaks for: its own page, the cross-origin frames attached in it
 * (lib/frames.js `frames:<tabId>` — an export from an embedded widget is the tab's), and the
 * pages it opened (a popup's download is its opener's, as on Engine 2).
 */
async function originsOfTab(id) {
  const origins = new Set();
  const tab = await api().tabs.get(id).catch(() => null);
  const own = originOf(tab?.url);
  if (own) origins.add(own);
  try {
    const stored = (await api().storage.session.get(`frames:${id}`))[`frames:${id}`];
    for (const frame of Object.values(stored?.sessions ?? {})) {
      const o = originOf(frame?.url);
      if (o) origins.add(o);
    }
  } catch { /* no frame table */ }
  try {
    for (const t of await api().tabs.query({})) {
      if (t.openerTabId !== id) continue;
      const o = originOf(t.url || t.pendingUrl);
      if (o) origins.add(o);
    }
  } catch { /* no tab list */ }
  return origins;
}

/** When a buffered request was made, in ms since the epoch (observe.js keeps CDP's wallTime, in s). */
function requestTime(r) {
  const wall = Number(r?.wallTime);
  return Number.isFinite(wall) && wall > 0 ? wall * 1000 : null;
}

/**
 * Who started this download — or null when no tab is watched at all (then it is not ours to report).
 *
 * A DownloadItem carries no tab id, so this is inference, and a wrong 'exact' or 'probable' made
 * wait_download pass on a file the tab never produced (extension review, 2026-09-22: the person's
 * own PDF from another site came back as the watched tab's export; tab 12's export came back as
 * tab 11's because both had once requested the URL). So:
 * 1. 'exact' only when exactly ONE watched tab requested the URL since its own watch began. When
 *    several did, the one that asked last is 'probable' and the others are named (`candidates`).
 * 2. Origin evidence (the referrer, a blob's creator) decides next: the watched tab whose page,
 *    frames or popups have that origin. Evidence that points at no watched tab is NOT overruled
 *    by timing — the download is 'unknown' (listed aside, never claimed).
 * 3. Only with no origin evidence at all: one watched tab, the download began after its watch.
 */
async function attribute(item) {
  const watched = await watchedTabs();
  const ids = Object.keys(watched).map(Number);
  if (!ids.length) return null;

  const urls = [item.url, item.finalUrl].filter(Boolean);
  // 1. Exact: the URL was a request in that tab. The key format is observe.js's
  //    (`network:<tabId>` → { requestId: { url, wallTime } }); it is stable and documented there.
  const keys = ids.map((id) => `network:${id}`);
  const buffers = await api().storage.session.get(keys);
  const asked = [];
  for (const id of ids) {
    const since = watched[id]?.since ?? 0;
    let latest = null;
    for (const r of Object.values(buffers[`network:${id}`] ?? {})) {
      if (!urls.includes(r.url)) continue;
      const at = requestTime(r);
      if (at != null && at < since - 1000) continue; // made before this tab's watch: not evidence
      latest = Math.max(latest ?? -Infinity, at ?? since);
    }
    if (latest != null) asked.push({ id, at: latest });
  }
  if (asked.length === 1) return { tabId: asked[0].id, attribution: 'exact' };
  if (asked.length > 1) {
    asked.sort((a, b) => b.at - a.at);
    return { tabId: asked[0].id, attribution: 'probable', candidates: asked.map((a) => a.id) };
  }

  // 2. Probable: same origin as the referrer or as the blob/data creator.
  const refOrigin = originOf(item.referrer);
  const blobOrigin = /^blob:/i.test(item.url ?? '') ? originOf(item.url) : null;
  const evidence = [refOrigin, blobOrigin].filter(Boolean);
  if (evidence.length) {
    const candidates = [];
    for (const id of ids) {
      const origins = await originsOfTab(id);
      if (evidence.some((o) => origins.has(o))) candidates.push(id);
    }
    if (candidates.length === 1) return { tabId: candidates[0], attribution: 'probable' };
    return { tabId: null, attribution: 'unknown', ...(candidates.length ? { candidates } : {}) };
  }

  // 3. Probable by time: one watched tab, no origin evidence, and the download began after its watch.
  if (ids.length === 1) {
    const since = watched[ids[0]]?.since ?? 0;
    const started = Date.parse(item.startTime ?? '') || Date.now();
    if (started >= since - 1000) return { tabId: ids[0], attribution: 'probable' };
  }
  return { tabId: null, attribution: 'unknown' };
}

function toEvent(item, meta) {
  const state = stateOf(item);
  return {
    id: String(item.id),
    tabId: meta.tabId,
    url: item.finalUrl || item.url,
    filename: item.filename ? item.filename.split(/[\\/]/).pop() : null,
    path: item.filename || null,
    state,
    receivedBytes: item.bytesReceived ?? 0,
    totalBytes: item.totalBytes > 0 ? item.totalBytes : (item.fileSize ?? 0),
    ...(item.error ? { error: item.error } : {}),
    ...(item.mime ? { mime: item.mime } : {}),
    startedAt: meta.startedAt,
    ...(item.endTime ? { endedAt: Date.parse(item.endTime) || Date.now() } : state !== 'in_progress' ? { endedAt: Date.now() } : {}),
    attribution: meta.attribution,
    ...(Array.isArray(meta.candidates) && meta.candidates.length ? { candidates: meta.candidates } : {}),
  };
}

async function onDownloadCreated(item) {
  if (!downloadListeners.size) return;
  const pending = (async () => {
    const attributed = await attribute(item);
    if (!attributed) return null;
    const meta = { ...attributed, startedAt: Date.parse(item.startTime ?? '') || Date.now() };
    await api().storage.session.set({ [ITEM_KEY(item.id)]: meta });
    return meta;
  })();
  pendingMeta.set(item.id, pending);
  let meta;
  try {
    meta = await pending;
  } finally {
    if (pendingMeta.get(item.id) === pending) pendingMeta.delete(item.id);
  }
  if (meta) emitDownload(toEvent(item, meta));
}

async function onDownloadChanged(delta) {
  if (!downloadListeners.size) return;
  // Still being attributed? Wait for it (see pendingMeta). Awaiting the same
  // promise AFTER onCreated did keeps the order: "began" is emitted first.
  let meta = pendingMeta.has(delta.id) ? await pendingMeta.get(delta.id).catch(() => null) : undefined;
  if (meta === undefined) {
    const stored = await api().storage.session.get(ITEM_KEY(delta.id));
    meta = stored[ITEM_KEY(delta.id)];
  }
  if (!meta) return; // began while nothing was watched, or before this worker saw it
  // onChanged carries only the changed fields and never bytesReceived; the
  // full item is one search away and is the truth the event is built from.
  const [item] = await api().downloads.search({ id: delta.id });
  if (!item) return;
  emitDownload(toEvent(item, meta));
  if (item.state !== 'in_progress') {
    await api().storage.session.remove(ITEM_KEY(delta.id)).catch(() => {});
  }
}

// Top-level, synchronous, guarded — see the header for why.
try {
  const d = globalThis.chrome?.downloads ?? globalThis.browser?.downloads;
  if (d?.onCreated) {
    d.onCreated.addListener((item) => {
      onDownloadCreated(item).catch((err) => console.error('[G9] download capture failed', err));
    });
    d.onChanged.addListener((delta) => {
      onDownloadChanged(delta).catch((err) => console.error('[G9] download capture failed', err));
    });
  }
} catch {
  /* no downloads API here; `available` reports it */
}

const downloads = {
  get available() {
    return !!(globalThis.chrome?.downloads ?? globalThis.browser?.downloads);
  },
  async begin(tabId) {
    if (!downloads.available) {
      throw new Error(
        'Download tracking needs the "downloads" permission, which this build of the extension does not ' +
          'have. Reload the G9 v2 extension from its folder.',
      );
    }
    await updateWatched((watched) => {
      watched[tabId] = { since: Date.now() };
    });
    // The browser saves into the user's own download folder; an extension can
    // only choose a path RELATIVE to it, so there is no directory to report.
    return { mode: 'extension', downloadPath: null };
  },
  async end(tabId) {
    // Called for every closed tab; only a watched one costs a storage write.
    await updateWatched((watched) => {
      if (!(tabId in watched)) return false;
      delete watched[tabId];
      return true;
    });
  },
  onEvent(fn) {
    downloadListeners.add(fn);
    return () => downloadListeners.delete(fn);
  },
  /**
   * What the browser knows about the file: its own record, not the bytes. An
   * extension has no file access, so no hash and no content sniffing — the
   * result says `source: 'browser'` so nobody mistakes it for a disk read.
   */
  async inspect(evt) {
    if (!downloads.available || evt?.id == null) return null;
    const [item] = await api().downloads.search({ id: Number(evt.id) }).catch(() => []);
    if (!item) return null;
    return {
      exists: item.state === 'complete' && item.exists !== false,
      size: item.fileSize > 0 ? item.fileSize : (item.bytesReceived ?? 0),
      ...(item.mime ? { mime: item.mime } : {}),
      path: item.filename || null,
      source: 'browser',
    };
  },
};

export const platform = {
  name: 'extension',
  debugger: debuggerApi,
  tabs,
  windows,
  cookies,
  storage,
  blobs,
  image,
  runtime,
  settings,
  downloads,
};
