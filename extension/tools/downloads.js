/**
 * Did the file actually download, and was there anything in it?
 *
 * ## Why the network assertion was not enough
 *
 * Until v1.7.14 the only way to check an export was to assert on the response
 * to `GET /api/report/excel`. That proves the SERVER answered. It does not prove
 * the browser accepted the download, that the filename was what the user asked
 * for, or that the body was not zero bytes — and "the export button produces an
 * empty file" is a real defect that a 200 response reports as success.
 *
 * ## Why this is on the platform now (EXT-02)
 *
 * v1 watched downloads with `Browser.setDownloadBehavior` through the page's
 * debugger session. The extension can never reach the Browser domain — the
 * real-Edge audit answered "'Browser.setDownloadBehavior' wasn't found" — so in
 * the extension the feature never worked at all. v2 splits it by engine:
 *
 * - **Engine 1** uses `chrome.downloads`. A DownloadItem carries no tab id, so
 *   attribution is inferred and LABELLED: 'exact' when the URL is a request that
 *   tab was seen making, 'probable' by referrer/origin or single watched tab.
 *   File facts are the browser's own record (exists, size) — no content access.
 * - **Engine 2** calls `Browser.setDownloadBehavior` on the BROWSER session of
 *   the launched engine, where it is allowed, and attributes by frame id —
 *   exact. File facts come from disk through the daemon: size, sha256, the
 *   first bytes, a sniffed type.
 *
 * ## What it will not do
 *
 * Claim a file exists without evidence. Every completed item carries `file`,
 * which says what was checked and by whom; when nothing could be checked it
 * says so (`verified: false`) instead of implying a guarantee that was not made.
 */

import { platform } from '../lib/platform.js';
import { serialize } from '../lib/state.js';

const KEY = (tabId) => `downloads:${tabId}`;
/** Downloads no tab could be attributed to, while anything is being watched. */
const UNATTRIBUTED = 'downloads:unattributed';

/** A test that downloads more than this is not asserting, it is mirroring. */
const MAX_TRACKED = 50;

/** How long a completed download's file may take to appear on disk before it is reported missing. */
const FILE_GRACE_MS = 2_000;

/** Progress events can arrive many times a second; persisting each is wasted work. */
const PROGRESS_WRITE_MS = 250;
const lastProgressWrite = new Map();

const session = () => platform.storage.session;

async function stateOf(tabId) {
  const stored = await session().get(KEY(tabId));
  return stored[KEY(tabId)] ?? null;
}

/**
 * Start watching downloads for a tab. Call it BEFORE the click that starts the
 * download: a download that already finished cannot be observed after the fact.
 *
 * On a launched engine the files are saved under their GUID
 * (`behavior: 'allowAndName'`), which keeps a repeated run from colliding with
 * the last one's file and from being silently renamed to "report (3).xlsx" — a
 * rename that would make a filename assertion fail for a reason that has
 * nothing to do with the product.
 */
export async function watch(tabId, { downloadPath } = {}) {
  if (!platform.downloads.available) {
    throw new Error(
      'Download tracking is not available in this engine: the extension build lacks the "downloads" ' +
        'permission. Reload the G9BrowserAgent v2 extension, or run the flow on a launched engine.',
    );
  }
  const began = await platform.downloads.begin(tabId, { downloadPath });
  await serialize(() => session().set({
    [KEY(tabId)]: {
      watching: true,
      mode: began.mode,
      downloadPath: began.downloadPath ?? null,
      since: Date.now(),
      // A fresh window every time, as in v1. A flow that exports twice calls
      // watch → click → wait twice; carrying the first file over made the
      // second wait_download return the FIRST export at once — a pass for a
      // download that had not happened yet.
      items: [],
    },
  }));
  return {
    watching: true,
    mode: began.mode,
    downloadPath: began.downloadPath ?? null,
    note: began.mode === 'extension'
      ? 'Files are saved to the browser\'s own download folder. Completion and size come from the browser\'s ' +
        'download record; the file content cannot be read from the extension.'
      : 'Files are saved under their download GUID in downloadPath and checked on disk when they complete.',
  };
}

export async function stop(tabId) {
  const state = await stateOf(tabId);
  await platform.downloads.end(tabId).catch(() => {});
  await serialize(async () => {
    await session().remove(KEY(tabId));
    // The side list only means something while a watch is running.
    if (!(await anyWatched())) await session().remove(UNATTRIBUTED);
  });
  return { watching: false, seen: state?.items?.length ?? 0 };
}

/**
 * What has downloaded since `watch` was called, with the file facts for every
 * finished item. Facts are gathered once and remembered, so listing twice does
 * not hash a large file twice.
 */
export async function list(tabId) {
  const state = await stateOf(tabId);
  if (!state) {
    return {
      watching: false,
      downloads: [],
      hint: 'Nothing is being watched. Call action:"watch_downloads" BEFORE the click that starts the download.',
    };
  }
  const items = [];
  for (const item of state.items) items.push(present(item, await factsFor(tabId, item)));
  const unattributed = (await session().get(UNATTRIBUTED))[UNATTRIBUTED] ?? [];
  return {
    watching: true,
    mode: state.mode,
    downloadPath: state.downloadPath,
    downloads: items,
    completed: items.filter((d) => d.state === 'complete').length,
    empty: items.filter((d) => d.empty).length,
    ...(unattributed.length
      ? {
          unattributed: unattributed.map((item) => present(item, null)),
          unattributedNote:
            'These downloads began while this tab was watched but could not be tied to it — no tab at all, or ' +
            '(tabId set) a tab nobody is watching. They are listed, not claimed.',
        }
      : {}),
  };
}

/**
 * Wait for a download to finish.
 *
 * Downloads are asynchronous and a click returns long before the bytes land, so
 * without this every assertion would be a race. Matching on a filename or URL
 * substring rather than an index, because a flow knows what it asked for and
 * does not know what else the page may fetch.
 */
export async function waitFor(tabId, { contains = null, timeoutMs = 30_000 } = {}) {
  const budget = Math.max(100, Number(timeoutMs) || 30_000);
  const deadline = Date.now() + budget;
  let lastSeen = 0;
  const matches = (d) => !contains ||
    String(d.filename ?? '').includes(contains) || String(d.url ?? '').includes(contains);

  while (Date.now() < deadline) {
    const state = await stateOf(tabId);
    if (!state) {
      throw new Error(
        'Downloads are not being watched on this tab. Call action:"watch_downloads" BEFORE the click that starts it — ' +
          'a download that already finished cannot be observed after the fact.',
      );
    }
    lastSeen = state.items.length;

    // An item tied to the tab by its own request ('exact') is preferred over one inferred from an
    // origin or the time (Engine 1 has no tab id on a download): a pass on someone else's file is
    // the failure this tool exists to prevent.
    const complete = state.items.filter((d) => d.state === 'complete' && matches(d));
    const done = complete.find((d) => (d.attribution ?? 'exact') === 'exact') ?? complete[0];
    if (done) {
      let facts = await factsFor(tabId, done);
      // The browser reports completion as it finalises the file; give the disk
      // a moment to agree before reporting it missing (a negative check is
      // never cached, so each look is a real one).
      const grace = Math.min(deadline, Date.now() + FILE_GRACE_MS);
      while (facts?.verified && facts.exists === false && Date.now() < grace) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        facts = await factsFor(tabId, done);
      }
      const inferred = done.attribution && done.attribution !== 'exact';
      return {
        ...present(done, facts),
        waitedMs: budget - (deadline - Date.now()),
        ...(inferred
          ? {
              attributionNote:
                `"${done.filename ?? done.url}" was tied to this tab by inference (${done.attribution}), not by a request the tab ` +
                'made: the browser gives a download no tab id. Check that it is the file you expected (pass contains:"…") ' +
                'before reporting a pass.',
            }
          : {}),
      };
    }

    const failed = state.items.find((d) => (d.state === 'canceled' || d.state === 'interrupted') && matches(d));
    if (failed) {
      throw new Error(
        `The download of "${failed.filename ?? failed.url}" ${failed.state === 'canceled' ? 'was canceled' : 'was interrupted'}` +
          `${failed.error ? ` (${failed.error})` : ''}. Nothing was saved.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(
    contains
      ? `No completed download matching "${contains}" within ${budget}ms. ${lastSeen} download(s) were seen on this tab.`
      : `No download completed within ${budget}ms. ${lastSeen} download(s) were seen on this tab.`,
  );
}

/**
 * Called for every DownloadEvent the platform reports (wired in tools/index.js).
 *
 * An event for a watched tab updates that tab's list. An event nobody could
 * attribute is kept aside while anything is watched — reported, never claimed.
 */
export async function ingest(evt) {
  if (!evt?.id) return;
  const final = evt.state !== 'in_progress';
  if (!final) {
    const last = lastProgressWrite.get(evt.id) ?? 0;
    if (Date.now() - last < PROGRESS_WRITE_MS) return;
    lastProgressWrite.set(evt.id, Date.now());
  } else {
    lastProgressWrite.delete(evt.id);
  }

  await serialize(async () => {
    const state = evt.tabId != null ? await stateOf(evt.tabId) : null;
    if (state) {
      const index = state.items.findIndex((d) => d.id === evt.id);
      if (index >= 0) {
        // Keep facts already gathered; the event is newer about everything else.
        state.items[index] = { ...state.items[index], ...evt };
      } else {
        if (state.items.length >= MAX_TRACKED) return;
        state.items.push({ ...evt });
      }
      await session().set({ [KEY(evt.tabId)]: state });
      return;
    }
    // No tab, or a tab nobody watches (a popup the watched page opened, say):
    // kept aside while anything is watched, with its tabId, never claimed.
    const watched = await anyWatched();
    if (!watched) return;
    const stored = (await session().get(UNATTRIBUTED))[UNATTRIBUTED] ?? [];
    const index = stored.findIndex((d) => d.id === evt.id);
    if (index >= 0) stored[index] = { ...stored[index], ...evt };
    else if (stored.length < MAX_TRACKED) stored.push({ ...evt });
    await session().set({ [UNATTRIBUTED]: stored });
  });
}

async function anyWatched() {
  const keys = typeof session().getKeys === 'function'
    ? await session().getKeys()
    : Object.keys(await session().get(null));
  return keys.some((k) => /^downloads:\d+$/.test(k));
}

/**
 * File facts for one finished download, from the platform — gathered once.
 * Returns null while the download is still running or when no check is possible.
 */
async function factsFor(tabId, item) {
  if (item.state !== 'complete') return null;
  if (item.file) return item.file;
  let facts = null;
  let failure = null;
  try {
    facts = await platform.downloads.inspect(item);
  } catch (err) {
    failure = String(err?.message ?? err);
  }
  const file = facts
    ? { verified: true, ...facts }
    : {
        verified: false,
        reason: failure
          ? `The file check failed: ${failure}`
          : !item.path && platform.name === 'cdp'
            ? 'The browser did not say where the file was saved, so it could not be checked.'
            : 'This engine has no way to check the file; only the browser\'s event stream is known.',
      };
  // A check that failed, or found no file YET, is not remembered: the next
  // list or wait looks again instead of repeating a stale "missing".
  if (failure || (facts && facts.exists === false)) return file;
  // Remember it, so a second list does not hash the same file again.
  await serialize(async () => {
    const state = await stateOf(tabId);
    const stored = state?.items.find((d) => d.id === item.id);
    if (!stored) return;
    stored.file = file;
    await session().set({ [KEY(tabId)]: state });
  });
  return file;
}

function present(item, file) {
  // A file that was looked for and not found has no size to speak of — zero
  // bytes would read as "empty", which is a different defect.
  const missing = !!file?.verified && file.exists === false;
  const size = file?.verified && !missing ? file.size : null;
  return {
    id: item.id,
    filename: item.filename ?? null,
    url: item.url ?? null,
    path: item.path ?? null,
    state: item.state,
    receivedBytes: item.receivedBytes ?? 0,
    totalBytes: item.totalBytes || null,
    attribution: item.attribution ?? 'unknown',
    ...(item.tabId != null ? { tabId: item.tabId } : {}),
    ...(item.viaTabId != null ? { viaTabId: item.viaTabId } : {}),
    ...(Array.isArray(item.candidates) && item.candidates.length ? { candidates: item.candidates } : {}),
    ...(item.error ? { error: item.error } : {}),
    ...(item.mime ? { mime: item.mime } : {}),
    // The one an assertion usually wants, stated rather than left to arithmetic.
    // Evidence first: a verified size of zero is empty whatever the stream said.
    empty: item.state === 'complete' && (size != null ? size === 0 : !item.receivedBytes),
    ...(missing
      ? {
          missing: true,
          note: 'The browser reported the download complete, but the file is not on disk at this path (moved, ' +
            'deleted, or blocked by security software). Do not treat this as a saved file.',
        }
      : {}),
    durationMs: item.endedAt && item.startedAt ? item.endedAt - item.startedAt : null,
    ...(file ? { file } : {}),
  };
}
