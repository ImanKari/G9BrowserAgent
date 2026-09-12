/**
 * Did the file actually download, and was there anything in it?
 *
 * ## Why the network assertion was not enough
 *
 * Until now the only way to check an export was to assert on the response to
 * `GET /api/report/excel`. That proves the SERVER answered. It does not prove
 * the browser accepted the download, that the filename was what the user asked
 * for, or that the body was not zero bytes — and "the export button produces an
 * empty file" is a real defect that a 200 response reports as success.
 *
 * ## Why CDP and not the `downloads` permission
 *
 * `chrome.downloads` would work and would also mean asking every QA machine for
 * a new permission at install time, for one assertion. CDP already has the
 * whole story: `Browser.setDownloadBehavior` with `eventsEnabled` turns on
 * `downloadWillBegin` (url, filename) and `downloadProgress` (received, total,
 * state). The debugger is already attached, so this costs no new trust.
 *
 * ## What it can and cannot say
 *
 * It can say: a download started, with this suggested filename, from this URL,
 * and it finished having received N bytes. That covers the defect above.
 *
 * It cannot open the file and read it. The bytes are reported by the browser,
 * not read back off disk, so a flow asserting on CONTENT is still outside this
 * — and saying so here is better than implying a guarantee that is not made.
 */

const api = globalThis.browser ?? globalThis.chrome;

const KEY = (tabId) => `downloads:${tabId}`;

/** A test that downloads more than this is not asserting, it is mirroring. */
const MAX_TRACKED = 50;

/**
 * Start watching downloads for a tab.
 *
 * `behavior: 'allowAndName'` makes Chrome save each file under its GUID, which
 * keeps a repeated run from colliding with the last one's file and from being
 * silently renamed to "report (3).xlsx" — a rename that would make a filename
 * assertion fail for a reason that has nothing to do with the product.
 */
export async function watch(tabId, { send }) {
  await send(tabId, 'Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: downloadDir(),
    eventsEnabled: true,
  });
  await api.storage.session.set({ [KEY(tabId)]: { items: [], at: Date.now() } });
  return { watching: true, downloadPath: downloadDir() };
}

export async function stop(tabId, { send }) {
  const state = await stateOf(tabId);
  await send(tabId, 'Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
  await api.storage.session.remove(KEY(tabId));
  return { watching: false, seen: state?.items?.length ?? 0 };
}

/**
 * What has downloaded since `watch` was called.
 *
 * Reports every item with the three things an assertion actually needs: the
 * suggested filename, how many bytes arrived, and whether it completed.
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
  return {
    watching: true,
    downloads: state.items.map(present),
    completed: state.items.filter((d) => d.state === 'completed').length,
    empty: state.items.filter((d) => d.state === 'completed' && !d.receivedBytes).length,
  };
}

/**
 * Wait for a download to finish.
 *
 * Downloads are asynchronous and a click returns long before the bytes land, so
 * without this every assertion would be a race. Matching on a filename
 * substring rather than an index, because a flow knows what it asked for and
 * does not know what else the page may fetch.
 */
export async function waitFor(tabId, { contains = null, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = 0;

  while (Date.now() < deadline) {
    const state = await stateOf(tabId);
    if (!state) {
      throw new Error(
        'Downloads are not being watched on this tab. Call action:"watch_downloads" BEFORE the click that starts it — ' +
          'a download that already finished cannot be observed after the fact.',
      );
    }
    lastSeen = state.items.length;

    const match = state.items.find((d) =>
      d.state === 'completed' && (!contains || (d.filename ?? '').includes(contains) || (d.url ?? '').includes(contains)));
    if (match) return { ...present(match), waitedMs: timeoutMs - (deadline - Date.now()) };

    const failed = state.items.find((d) =>
      d.state === 'canceled' && (!contains || (d.filename ?? '').includes(contains)));
    if (failed) {
      throw new Error(`The download of "${failed.filename ?? failed.url}" was canceled by the browser.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(
    contains
      ? `No completed download matching "${contains}" within ${timeoutMs}ms. ${lastSeen} download(s) were seen on this tab.`
      : `No download completed within ${timeoutMs}ms. ${lastSeen} download(s) were seen on this tab.`,
  );
}

/** Called from the service worker's CDP event router. */
export async function ingest(tabId, method, params) {
  const state = await stateOf(tabId);
  if (!state) return;

  if (method === 'Browser.downloadWillBegin') {
    if (state.items.length >= MAX_TRACKED) return;
    state.items.push({
      guid: params.guid,
      url: params.url,
      filename: params.suggestedFilename ?? null,
      state: 'inProgress',
      receivedBytes: 0,
      totalBytes: null,
      startedAt: Date.now(),
    });
  } else if (method === 'Browser.downloadProgress') {
    const item = state.items.find((d) => d.guid === params.guid);
    if (!item) return;
    item.receivedBytes = params.receivedBytes ?? item.receivedBytes;
    item.totalBytes = params.totalBytes || item.totalBytes;
    item.state = params.state ?? item.state;
    if (params.state === 'completed') item.finishedAt = Date.now();
  } else {
    return;
  }

  await api.storage.session.set({ [KEY(tabId)]: state });
}

async function stateOf(tabId) {
  const stored = await api.storage.session.get(KEY(tabId));
  return stored[KEY(tabId)] ?? null;
}

function present(item) {
  return {
    filename: item.filename,
    url: item.url,
    state: item.state,
    receivedBytes: item.receivedBytes,
    totalBytes: item.totalBytes,
    // The one an assertion usually wants, stated rather than left to arithmetic.
    empty: item.state === 'completed' && !item.receivedBytes,
    durationMs: item.finishedAt ? item.finishedAt - item.startedAt : null,
  };
}

/**
 * Where downloads land.
 *
 * A fixed folder under the OS temp dir rather than the user's Downloads: a test
 * run should not silt up somewhere a person keeps things, and a predictable
 * path is what makes a failed run inspectable afterwards.
 */
function downloadDir() {
  return 'g9-downloads';
}
