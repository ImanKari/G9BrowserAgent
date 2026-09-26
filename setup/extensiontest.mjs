/**
 * Extension-side regression tests (v2), with a deliberately asynchronous chrome
 * API stub under the REAL platform seam: every module below reaches "the
 * browser" through lib/platform.js → platform-extension.js → this stub, exactly
 * as it does in the service worker. No browser is needed; the unit suites
 * (setup/unittest.mjs) and the live harnesses cover real CDP.
 *
 * The file also keeps the daemon-, MCP- and runner-side rules that v1 kept in
 * the bridge (now daemon/*, mcp/*, runner/*). The few loopback sockets it opens
 * use a random port in 18000-18999 — never 8765, where a person's own daemon
 * (or a v1 bridge) may be running.
 *
 * v2 removed the four modes, the workspace allowlist, redaction, the pinned tab,
 * requireTabControl, migrateModeDefault, the token and bridge port discovery
 * (ARCHITECTURE_V2 §4.1, §14). Their tests went with them. Where v2 has a rule
 * in their place — a full-access listing, attach makes the tab current, the
 * resolution order, the one-time cleanup of v1 settings, one daemon port — that
 * rule is tested instead, next to where the old test stood.
 *
 *   node setup/extensiontest.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fakeIndexedDB } from './unit/world.test.mjs';

const sessionData = new Map();
const localData = new Map();
/** Tabs the stub's debugger reports as attached (chrome.debugger.getTargets). */
const attachedTabs = new Set();
/** Every CDP command the stub answered, in order. */
const commandLog = [];
let getTargetsCalls = 0;
let failModernNetwork = false;
let failLocale = false;
let failUserAgent = false;
let axNodes = [];
/** What Network.getResponseBody answers (null: "no longer buffered"). */
let responseBody = null;

const tick = () => new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 3)));
const clone = (value) => value == null ? value : structuredClone(value);

function storageArea(map) {
  return {
    async get(keys) {
      await tick();
      const out = {};
      const names = keys == null ? [...map.keys()]
        : typeof keys === 'string' ? [keys]
          : Array.isArray(keys) ? keys
            : Object.keys(keys);
      for (const key of names) {
        if (map.has(key)) out[key] = clone(map.get(key));
        else if (keys && !Array.isArray(keys) && typeof keys === 'object' && key in keys) out[key] = clone(keys[key]);
      }
      return out;
    },
    async set(values) {
      await tick();
      for (const [key, value] of Object.entries(values)) map.set(key, clone(value));
    },
    async remove(keys) {
      await tick();
      for (const key of (Array.isArray(keys) ? keys : [keys])) map.delete(key);
    },
    async clear() { map.clear(); },
  };
}

/** A chrome.events-shaped listener list the tests can fire. */
function eventSource() {
  const set = new Set();
  return {
    set,
    addListener: (fn) => set.add(fn),
    removeListener: (fn) => set.delete(fn),
    hasListener: (fn) => set.has(fn),
    fire: (...args) => { for (const fn of set) fn(...args); },
  };
}

/**
 * The browser the tab tools see. Tab 7 is the ordinary page most tests act on;
 * tab 9 is a browser-internal page, which nothing may control, and it is the
 * ACTIVE tab — so a call that falls through to "whatever the user is looking
 * at" lands on something it must refuse. Tests that need more tabs or windows
 * add them and put the model back afterwards (resetBrowser).
 */
const browserModel = { windows: new Map(), tabs: new Map(), lastFocusedWindow: 1, nextTabId: 100 };
function resetBrowser() {
  browserModel.windows = new Map([[1, { id: 1, type: 'normal', state: 'normal', focused: true }]]);
  browserModel.tabs = new Map([
    [7, { id: 7, url: 'http://example.test/', title: 'Test', windowId: 1, active: false, status: 'complete' }],
    [9, { id: 9, url: 'chrome://settings', title: 'Settings', windowId: 1, active: true, status: 'complete' }],
  ]);
  browserModel.lastFocusedWindow = 1;
}
resetBrowser();

const downloadItems = new Map();

globalThis.chrome = {
  storage: { session: storageArea(sessionData), local: storageArea(localData) },
  runtime: {
    sendMessage: async () => {},
    getManifest: () => ({ version: 'test' }),
  },
  tabs: {
    async query(info = {}) {
      await tick();
      let rows = [...browserModel.tabs.values()];
      if (info.active) rows = rows.filter((t) => t.active);
      if (info.lastFocusedWindow) rows = rows.filter((t) => t.windowId === browserModel.lastFocusedWindow);
      if (info.windowId != null) rows = rows.filter((t) => t.windowId === info.windowId);
      return rows.map(clone);
    },
    async get(id) {
      await tick();
      const tab = browserModel.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}.`);
      return clone(tab);
    },
    async update(id, patch = {}) {
      const tab = browserModel.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}.`);
      if (patch.active) for (const other of browserModel.tabs.values()) if (other.windowId === tab.windowId) other.active = false;
      Object.assign(tab, patch);
      return clone(tab);
    },
    async create({ url = 'about:blank', active = false, windowId = 1 } = {}) {
      const tab = { id: browserModel.nextTabId++, url, title: '', windowId, active, status: 'complete' };
      browserModel.tabs.set(tab.id, tab);
      return clone(tab);
    },
    async remove(id) { browserModel.tabs.delete(id); },
    onRemoved: eventSource(),
    onCreated: eventSource(),
    onUpdated: eventSource(),
  },
  windows: {
    WINDOW_ID_NONE: -1,
    async get(id) {
      const win = browserModel.windows.get(id);
      if (!win) throw new Error(`No window with id: ${id}.`);
      return clone(win);
    },
    async getAll({ populate = false } = {}) {
      return [...browserModel.windows.values()].map((w) => ({
        ...clone(w),
        ...(populate ? { tabs: [...browserModel.tabs.values()].filter((t) => t.windowId === w.id).map(clone) } : {}),
      }));
    },
    update: async () => ({}),
    onFocusChanged: eventSource(),
  },
  downloads: {
    onCreated: eventSource(),
    onChanged: eventSource(),
    search: async ({ id }) => (downloadItems.has(id) ? [clone(downloadItems.get(id))] : []),
  },
  debugger: {
    getTargets: async () => {
      getTargetsCalls += 1;
      return [...attachedTabs].map((tabId) => ({ tabId, attached: true }));
    },
    attach: async ({ tabId }) => { attachedTabs.add(tabId); },
    detach: async ({ tabId }) => { attachedTabs.delete(tabId); },
    onEvent: eventSource(),
    onDetach: eventSource(),
    sendCommand: async (source, method, params) => {
      commandLog.push({ tabId: source?.tabId, method, params });
      if (method === 'Accessibility.getFullAXTree') return { nodes: axNodes };
      if (method === 'Network.getResponseBody') {
        if (responseBody == null) throw new Error('No resource with given identifier found');
        return { body: responseBody, base64Encoded: false };
      }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1, documentURL: 'http://example.test/', title: 'Test' } };
      if (method === 'Network.emulateNetworkConditionsByRule' || method === 'Network.overrideNetworkState') {
        if (failModernNetwork) throw new Error('Method not found');
        return {};
      }
      if (method === 'Emulation.setLocaleOverride' && failLocale) throw new Error('Bad locale');
      if (method === 'Emulation.setUserAgentOverride' && failUserAgent) throw new Error('Bad user agent');
      if (method === 'Runtime.evaluate') return { result: { value: 'Mozilla/5.0 Test' } };
      return {};
    },
  },
};

// Attachments and video frames live in IndexedDB in the extension
// (platform-extension's blob store). The same minimal fake the unit suites use.
globalThis.indexedDB = fakeIndexedDB();

const record = await import('../extension/tools/record.js');
const observe = await import('../extension/tools/observe.js');
const snapshotModule = await import('../extension/tools/snapshot.js');
const emulateModule = await import('../extension/tools/emulate.js');
const tabsModule = await import('../extension/tools/tabs.js');
const qa = await import('../extension/tools/qa.js');
const visual = await import('../extension/lib/visual.js');
const stateModule = await import('../extension/lib/state.js');
const { platform } = await import('../extension/lib/platform.js');
// The shared tool runtime (ARCHITECTURE_V2 §4): the same pipeline sw.js runs
// for every daemon call — halted → resolve → dialog → run → activity.
const runtime = await import('../extension/tools/index.js');
// v2: the MCP schemas moved from bridge/src/tools.js to mcp/tools.js.
const toolsModule = await import('../mcp/tools.js');

assert.equal(platform.name, 'extension', 'the stub must put these modules on platform-extension, as in the worker');

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed += 1;
    console.log('  PASS ' + name);
  });
}

/** Fail instead of hanging: a deadlock is a failure, not a slow test. */
function within(ms, promise, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms — a hang, not a slow call`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Lift named top-level functions out of a module's source so a rule the module
 * does not export can be exercised as code, not matched as text. Each function
 * runs from its real source; `deps` supplies what it closes over.
 */
function liftFunctions(source, names, deps = {}) {
  const bodies = names.map((name) => {
    const found = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm').exec(source);
    assert.ok(found, `${name}() is missing`);
    const end = source.indexOf('\n}\n', found.index);
    assert.ok(end > found.index, `${name}() has no end`);
    return source.slice(found.index, end + 2).replace(/^export /, '');
  });
  const factory = new Function(...Object.keys(deps), `${bodies.join('\n')}\nreturn { ${names.join(', ')} };`);
  return factory(...Object.values(deps));
}

/** A random loopback port in 18000-18999 (never 8765: a person's daemon or v1 bridge may be there). */
const testPort = () => 18000 + Math.floor(Math.random() * 1000);

console.log('\nG9 Browser Agent — extension regression test (v2)\n');

await test('normalizer collapses click/click/dblclick into one double click', () => {
  const target = { locators: [{ kind: 'testid', value: 'save' }] };
  const steps = record.normalize([
    { type: 'click', at: 1, target },
    { type: 'click', at: 2, target },
    { type: 'dblclick', at: 3, target },
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, 'double_click');
});

await test('normalizer keeps only the final select outcome, not its keyboard mechanics', () => {
  const target = { locators: [{ kind: 'testid', value: 'environment' }] };
  const steps = record.normalize([
    { type: 'key', key: 'Home', at: 1, target },
    { type: 'select', value: 'dev', text: 'Development', at: 2, target },
    { type: 'key', key: 'ArrowDown', at: 3, target },
    { type: 'select', value: 'stg', text: 'Staging', at: 4, target },
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, 'select');
  assert.equal(steps[0].value, 'stg');
});

await test('serialized recorder ingestion preserves concurrent events', async () => {
  const key = 'g9:recording-session:7';
  sessionData.set(key, { raw: [{ type: 'navigate', at: 0, url: 'x' }] });
  await Promise.all(Array.from({ length: 120 }, (_, index) =>
    record.ingestRaw(7, { type: 'scroll', at: index + 1, x: index, y: index })
  ));
  assert.equal(sessionData.get(key).raw.length, 121);
});

await test('recorder cap is enforced and reported', async () => {
  const key = 'g9:recording-session:7';
  sessionData.set(key, {
    raw: [{ type: 'navigate', at: 0, url: 'x' }, ...Array.from({ length: 4999 }, (_, index) => ({ type: 'scroll', at: index + 1 }))],
  });
  await record.ingestRaw(7, { type: 'scroll', at: 6000 });
  assert.equal(sessionData.get(key).raw.length, 5000);
  assert.equal(sessionData.get(key).droppedRawEvents, 1);
});

await test('replay guard prevents an armed recorder ingesting replay events', async () => {
  const key = 'g9:recording-session:7';
  sessionData.set(key, { raw: [] });
  await record.setReplaying(7, true);
  await record.ingestRaw(7, { type: 'click', at: 1 });
  assert.equal(sessionData.get(key).raw.length, 0);
  await record.setReplaying(7, false);
});

await test('network capture preserves concurrent request lifecycles', async () => {
  await observe.clearBuffers(7);
  await Promise.all(Array.from({ length: 50 }, async (_, index) => {
    const requestId = 'r' + index;
    await observe.ingest(7, 'Network.requestWillBeSent', {
      requestId, loaderId: 'l', timestamp: index, wallTime: 1000 + index,
      type: 'Fetch', request: { url: 'http://example.test/' + index, method: 'GET', headers: {} },
    });
    await observe.ingest(7, 'Network.responseReceived', {
      requestId, response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'text/plain' },
    });
    await observe.ingest(7, 'Network.loadingFinished', { requestId, timestamp: index + 0.5, encodedDataLength: 10 });
  }));
  assert.equal((await observe.network(7, { limit: 100 })).total, 50);
  assert.equal((await observe.network(7, { status: 'pending', limit: 100 })).returned, 0);
});

await test('pending includes responses that have not finished loading', async () => {
  await observe.ingest(7, 'Network.requestWillBeSent', {
    requestId: 'pending', loaderId: 'l', timestamp: 99, wallTime: 1099,
    type: 'Fetch', request: { url: 'http://example.test/pending', method: 'GET', headers: {} },
  });
  await observe.ingest(7, 'Network.responseReceived', {
    requestId: 'pending', response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'text/plain' },
  });
  assert.equal((await observe.network(7, { status: 'pending', limit: 100 })).returned, 1);
});

await test('snapshot maxNodes bounds every emitted line, not only refs', async () => {
  axNodes = [{ nodeId: 'root', role: { value: 'main' }, name: { value: 'Root' }, childIds: [] }];
  for (let index = 0; index < 20; index++) {
    const id = 'n' + index;
    axNodes[0].childIds.push(id);
    axNodes.push({ nodeId: id, parentId: 'root', role: { value: 'heading' }, name: { value: 'Heading ' + index }, childIds: [] });
  }
  const result = await snapshotModule.snapshot(7, { maxNodes: 5 });
  assert.equal(result.emittedNodes, 5);
  assert.equal(result.tree.split('\n').length, 5);
  assert.equal(result.truncated, true);
});

await test('network emulation uses modern CDP then an explicit legacy fallback', async () => {
  failModernNetwork = false;
  assert.equal((await emulateModule.emulate(7, { network: '4g' })).applied.network.engine, 'modern-rule+state');
  failModernNetwork = true;
  assert.equal((await emulateModule.emulate(7, { network: '4g' })).applied.network.engine, 'legacy-fallback');
  failModernNetwork = false;
});

await test('emulation reports failures and retains reset state for retry', async () => {
  failLocale = true;
  await assert.rejects(() => emulateModule.emulate(7, { locale: 'bad_locale' }), /Bad locale/);
  failLocale = false;
  sessionData.set('emulate-ua:7', 'Original UA');
  failUserAgent = true;
  const reset = await emulateModule.emulate(7, { reset: true });
  assert.equal(reset.reset, false);
  assert.equal(sessionData.get('emulate-ua:7'), 'Original UA');
  failUserAgent = false;
});

await test('emulate reset gives the browser its own user agent AND Client Hints back; presets and locales are refused at stealth', async () => {
  // "Restoring" the real UA string left an override in place with no userAgentMetadata: the tab
  // reported empty navigator.userAgentData brands and sent no Sec-CH-UA for the rest of its life,
  // and the result said `cleared: [… "userAgent"]` (docs review, 2026-09-22). '' removes it.
  const uaCalls = () => commandLog.filter((c) => c.method === 'Emulation.setUserAgentOverride');
  commandLog.length = 0;
  const reset = await emulateModule.emulate(7, { reset: true });
  assert.equal(reset.reset, true);
  assert.equal(uaCalls().length, 1);
  assert.equal(uaCalls()[0].params.userAgent, '', 'the override is removed, not replaced');
  assert.ok(reset.cleared.includes('userAgent'));

  // Not stealth-safe, so refused on a stealth tab — nothing is sent.
  await stateModule.setState({ inputMode: 'stealth' });
  try {
    commandLog.length = 0;
    await assert.rejects(() => emulateModule.emulate(7, { device: 'iphone-15' }), /Refused on a stealth tab[\s\S]*user agent/);
    await assert.rejects(() => emulateModule.emulate(7, { locale: 'de-DE' }), /Refused on a stealth tab[\s\S]*navigator\.languages/);
    assert.equal(commandLog.filter((c) => /^Emulation\./.test(c.method)).length, 0, 'nothing was emulated');
    // Layout emulation (width/height) has no such tell and is not refused: it is not in this
    // guard's list at all.
    await assert.doesNotReject(() => emulateModule.emulate(7, { network: '4g' }));
  } finally {
    await stateModule.setState({ inputMode: 'human' });
  }
});

await test('with nothing current, an unattachable active page is refused, never guessed around', async () => {
  // v1 asked this of Follow mode ("no target when the active page is
  // unattachable"). v2 has no modes, and the rule outlived them: a call without
  // a tabId acts on the current tab, else the tab the user is looking at — and
  // when that is a browser page, the answer is a refusal that names it, never a
  // different tab picked instead.
  resetBrowser();
  await stateModule.setState({ currentTabId: null, sessions: {} });
  assert.equal(await tabsModule.peekTarget(), null, 'status must report no target');
  await assert.rejects(() => tabsModule.resolveTarget(null, null),
    /The active tab is chrome:\/\/settings, a browser-internal page that cannot be controlled/);
  await assert.rejects(() => tabsModule.resolveTarget(9, null), /Tab 9 is on chrome:\/\/settings/);
  const status = await runtime.status();
  assert.equal(status.current, null);
  assert.match(status.hint, /No tab to act on/);
});

await test('data substitution and Playwright select export preserve test intent', async () => {
  assert.deepEqual(qa.substitute({ url: '/{{tenant}}', values: ['{{user}}'] }, { tenant: 'qa', user: 'iman' }), {
    url: '/qa', values: ['iman'],
  });
  assert.equal(qa.substitute('{{enabled}}', { enabled: false }), false);
  assert.throws(() => qa.substitute('{{missing}}', {}), /Missing data parameter/);
  localData.set('g9:recording:export-probe', {
    id: 'export-probe', name: 'select export', steps: [{
      type: 'select', values: ['prd'],
      target: { locators: [{ kind: 'testid', attr: 'data-qa', value: 'environment' }] },
    }],
  });
  const exported = await qa.exportPlaywright('export-probe');
  assert.match(exported.code, /page\.locator\("\[data-qa=\\"environment\\"\]"\)\.selectOption\(\["prd"\]\)/);
});

await test('visual comparison returns a normalized deterministic difference', () => {
  const a = { algorithm: 'luma-32x32-v1', values: [0, 100, 255] };
  const b = { algorithm: 'luma-32x32-v1', values: [0, 110, 0] };
  const diff = visual.visualDifference(a, b);
  assert(diff.difference > 0 && diff.difference < 1);
  assert.equal(diff.changedRatio, 1 / 3);
});

await test('diagnose is not annotated read-only because performance may reload', () => {
  const tool = toolsModule.TOOLS.find((item) => item.name === 'browser_diagnose');
  assert.equal(tool.annotations?.readOnlyHint, undefined);
  // v2: the same judgement decides tab OWNERSHIP in the daemon (a read never
  // claims a tab), so the runtime must agree with the schema — a trace that
  // reloads the page is not a read.
  assert.equal(runtime.isReadOnly('browser_diagnose', { what: 'performance', reload: true }), false);
  assert.equal(runtime.isReadOnly('browser_diagnose', { what: 'performance' }), true);
});

await test('replay, idle, video, and panel regressions retain their invariants', async () => {
  // The panel became four modules in v1.7.0 (ui/session/automation/issues), so
  // the issue-editor invariants moved with the code that holds them. Pointing
  // this test at the old path would have made it pass against a file that no
  // longer contains the behaviour — a green test for code that moved away.
  const [issues, panelIssues, replay, navigate, interact] = await Promise.all([
    readFile(new URL('../extension/tools/issues.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/panel/issues.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/tools/replay.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/tools/navigate.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/tools/interact.js', import.meta.url), 'utf8'),
  ]);
  assert.match(issues, /putVideoFrame/);
  assert.doesNotMatch(issues, /session\.frames\.push/);
  assert.match(issues, /Stop the active video capture before deleting this issue/);
  // v2 names the claimed capture record `current` (the stream itself is shared,
  // lib/screencast.js); its frames are still deleted by that capture's id.
  assert.match(issues, /deleteVideoFrames\(current\.sessionId\)/);
  assert.match(panelIssues, /await saveIssueNow/);
  assert.match(panelIssues, /videoStatus/);
  assert.match(replay, /interact\.drag/);
  assert.match(replay, /setReplaying\(tabId, true\)/);
  assert.match(replay, /Checkbox action was issued/);
  assert.match(replay, /recorded target did not observe the expected trusted event/);
  assert.doesNotMatch(replay, /note: 'drag replay uses recorded endpoints'/);
  assert.match(navigate, /status: 'pending', limit: 0[\s\S]*r\.returned/);
  assert.match(navigate, /if \(target < 0 \|\| target >= entries\.length\)[\s\S]*resetPageState/);
  assert.doesNotMatch(interact, /dispatchEvent\(new Event/);
});

// ---------------------------------------------------------- v1.4.0 defects

await test('every dispatching interaction witnesses that the page received it', async () => {
  const interact = await readFile(new URL('../extension/tools/interact.js', import.meta.url), 'utf8');

  // The bug: a headed Chromium silently discards Input.dispatch*Event for a
  // page that is not visible, so every action returned a success object for
  // something that never happened. Each dispatching action must now prove the
  // page saw a TRUSTED event, and say why when it did not.
  //
  // v2 gives every action two paths: direct input (level "off", v1's events)
  // and humanized input. BOTH must prove delivery — otherwise switching the
  // input level would silently switch the proof off with it. (The witness is
  // exercised as code in setup/unit/interaction.test.mjs; this pins where it
  // sits, which is what a refactor loses.)
  const bodyOf = (name) => {
    const found = new RegExp(`\\n(?:export )?async function ${name}\\(`).exec(interact);
    assert.ok(found, name + '() is missing');
    const next = interact.indexOf('\n}\n', found.index + 1);
    return interact.slice(found.index + 1, next === -1 ? undefined : next);
  };
  for (const impl of ['directClick', 'humanClick', 'directHover', 'humanHover', 'directDrag', 'humanDrag', 'type']) {
    assert.match(bodyOf(impl), /witnessed\(/, impl + '() dispatches without witnessing the result');
  }
  assert.equal((bodyOf('key').match(/witnessed\(/g) ?? []).length, 2, 'key() must witness at level off AND at the human levels');
  // And every level of an exported action goes through one of those paths.
  for (const [action, paths] of [
    ['click', ['humanClick', 'directClick']],
    ['hover', ['humanHover', 'directHover']],
    ['drag', ['humanDrag', 'directDrag']],
    ['scroll', ['humanScroll', 'directScroll']],
  ]) {
    for (const impl of paths) assert.match(bodyOf(action), new RegExp(`${impl}\\(tabId`), `${action}() must route to ${impl}()`);
  }

  // scroll is the exception, and for a reason worth pinning: Chromium may
  // handle wheel entirely on the compositor, so no DOM event arrives even when
  // the scroll worked. It verifies the scroll POSITION instead; a seen `wheel`
  // is only ever a positive signal, never the verdict.
  for (const impl of ['directScroll', 'humanScroll']) {
    const scrollBody = bodyOf(impl);
    assert.doesNotMatch(scrollBody, /witnessed\(/, `${impl}() must not make a wheel event its verdict`);
    assert.match(scrollBody, /scrollState\(tabId, node\)/);
    // Wheel scrolling settles on the compositor AFTER the command resolves, so
    // reading the position once reported a working scroll as `moved: false`;
    // and stopping at the FIRST changed read reported a mid-scroll position,
    // at which the next action aimed (live round 2: 50/50 runs). The position
    // is read until the page has stopped (settledScroll).
    assert.match(scrollBody, /await settledScroll\(tabId, node, before\)/, `${impl}() must wait for the page to stop scrolling`);
    assert.match(scrollBody, /movedAtAll \? \(witness\.release\(\), \{ delivery: 'delivered' \}\)/,
      `${impl}(): a position that moved is delivered, whatever the wheel witness saw`);
  }
  const settleBody = bodyOf('settledScroll');
  assert.match(settleBody, /moveWithinMs/, 'first: wait for the first movement (a page at its edge never moves)');
  assert.match(settleBody, /quietMs/, 'then: until the position has not changed for a quiet window');
  assert.match(settleBody, /capMs/, 'capped');
  assert.match(settleBody, /moved: scrollMoved\(before, last\)/, 'moved is the net movement to where the page came to rest');
  assert.match(interact, /scrollX, y: scrollY/);
  assert.match(interact, /document\.visibilityState/);
  assert.match(interact, /explainNoInput/);
  assert.match(interact, /isTrusted/);

  // Arm and read as ONE promise. Two calls assume both land in the same
  // execution context, and a single-page app swaps context as its router
  // moves — the listener is gone by the time the counter is read, and a
  // caption that typed perfectly gets reported as a failure. That inverse
  // failure is as damaging as the original: retrying a click posts twice.
  // v2 arms a promise that lives entirely inside one context (G9's isolated
  // world) and settles THAT promise. Run the real expression against a
  // stand-in page: it must leave nothing behind in the page, ignore a
  // synthetic event, answer on a trusted one, and remove its listeners.
  assert.doesNotMatch(interact, /witnessSaw|__g9witness/,
    'the witness must not keep state between separate evaluate calls');
  const { witnessExpression } = await import('../extension/tools/interact.js');
  const vm = await import('node:vm');
  const listeners = new Map();
  const page = {
    frames: { length: 0 },
    addEventListener: (kind, fn) => listeners.set(kind, fn),
    removeEventListener: (kind) => listeners.delete(kind),
    setTimeout,
    clearTimeout,
  };
  page.window = page;
  const pageKeys = new Set(Object.keys(page));
  const witness = vm.runInContext(witnessExpression(['mousedown'], 5000), vm.createContext(page));
  assert.equal(typeof witness?.then, 'function', 'the witness is one promise');
  assert.deepEqual(Object.keys(page).filter((k) => !pageKeys.has(k)), [], 'the witness leaves no state in the page');
  listeners.get('mousedown')({ isTrusted: false });
  assert.equal(listeners.size, 1, 'a synthetic event proves nothing: the witness is still listening');
  listeners.get('mousedown')({ isTrusted: true });
  assert.equal(await witness, true, 'a trusted event answers; a synthetic one proves nothing');
  assert.equal(listeners.size, 0, 'the witness removes its listeners once it has answered');

  // An observable outcome outranks any opinion about events.
  assert.match(interact, /verify && \(await verify\(\)/);
  assert.match(interact, /readValue\(tabId, node\)\) !== before/);

  // The witness must never be armed inside another witness: arming resets the
  // counter, so a nested one turns a working action into a false failure.
  assert.match(interact, /async function dispatchKey\(/);
  const typeBody = bodyOf('type');
  const emitBody = typeBody.slice(typeBody.indexOf('let emit;'), typeBody.indexOf('let w = null;'));
  assert.ok(emitBody.length > 200, 'type() must build its dispatch before witnessing it');
  assert.match(emitBody, /dispatchKey\(tabId/);
  assert.doesNotMatch(emitBody, /await key\(tabId/, 'type() must call the unwitnessed dispatchKey');
});

await test('video capture never calls CDP inside the serialize chain', async () => {
  const issues = await readFile(new URL('../extension/tools/issues.js', import.meta.url), 'utf8');

  // cdp.send() -> attach() -> setState()/logActivity(), which are themselves
  // serialized. Holding the chain across it deadlocks EVERY state write in the
  // extension, permanently. Reserve under the lock, talk to CDP outside it.
  /** Slice from an opening brace to its match, so nesting is handled. */
  const blockAt = (text, openIndex) => {
    let depth = 0;
    for (let i = openIndex; i < text.length; i++) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}' && --depth === 0) return text.slice(openIndex, i + 1);
    }
    return text.slice(openIndex);
  };

  // v2: the stream is shared (lib/screencast.js) and the video is one consumer
  // of it, so "talking to CDP" is screencast.start/stop as well as send().
  const CDP_CALL = /\b(?:send|sendOnLiveSession|inWorld|callInWorld)\(tabId|screencast\.(?:start|stop)\(tabId/;
  const bodyOf = (fn) => {
    const found = new RegExp(`\\n(?:export )?async function ${fn}\\(`).exec(issues);
    assert.ok(found, fn + ' is missing');
    const next = issues.indexOf('\n}\n', found.index + 1);
    return issues.slice(found.index + 1, next === -1 ? undefined : next);
  };
  for (const fn of ['startVideo', 'ingestVideoFrame', 'stopVideo']) {
    const body = bodyOf(fn);
    for (const block of [...body.matchAll(/serialize\(async \(\) => (\{)/g)]) {
      const inside = blockAt(body, block.index + block[0].length - 1);
      assert.doesNotMatch(inside, CDP_CALL, fn + '() calls CDP inside serialize() — that deadlocks the write chain');
    }
  }
  // …and the CDP calls still have to happen somewhere.
  assert.match(bodyOf('startVideo'), /screencast\.start\(tabId/, 'startVideo() no longer starts the stream');
  assert.match(bodyOf('stopVideo'), /screencast\.stop\(tabId/, 'stopVideo() no longer stops the stream');

  // The ack must NOT go through send(): its halt check, attach check and
  // getTargets() round trip, paid per frame on the single worker thread,
  // starved the agent's own calls until an ordinary scroll during a recording
  // timed out after 60s. The frame event is itself proof the session is live.
  const screencastSrc = await readFile(new URL('../extension/lib/screencast.js', import.meta.url), 'utf8');
  assert.match(screencastSrc, /sendOnLiveSession\(tabId, 'Page\.screencastFrameAck'/);
  const cdp = await readFile(new URL('../extension/lib/cdp.js', import.meta.url), 'utf8');
  assert.match(cdp, /export function sendOnLiveSession/);
  // At most one serialized write per frame path, never across the blob write.
  assert.ok((bodyOf('ingestVideoFrame').match(/serialize\(/g) || []).length <= 2,
    'the frame path holds the shared write chain more than necessary per frame');

  // And as behaviour, in the exact situation that deadlocked v1: the person
  // pressed Cancel on the debugging banner, so the tab is NOT in attachedTabs,
  // and starting a capture has to attach — setState() and logActivity(), both
  // on the write chain — on the way. Every step must finish, and the chain must
  // still take writes afterwards.
  const issuesTool = await import('../extension/tools/issues.js');
  localData.set('g9:issue:vid-1', { id: 'vid-1', title: 'video probe', status: 'open' });
  attachedTabs.delete(7);
  await stateModule.setState({ attachedTabs: [], halted: false });
  const started = await within(5000, issuesTool.startVideo(7, { id: 'vid-1' }), 'startVideo on a detached tab');
  assert.equal(started.recording, true);
  assert.ok(commandLog.some((c) => c.tabId === 7 && c.method === 'Page.startScreencast'));
  await assert.rejects(() => issuesTool.deleteIssue('vid-1'), /Stop the active video capture before deleting this issue/);

  const acks = () => commandLog.filter((c) => c.method === 'Page.screencastFrameAck').length;
  const acksBefore = acks();
  const targetsBefore = getTargetsCalls;
  for (let i = 1; i <= 3; i++) {
    await within(5000, issuesTool.ingestFrame(7, { data: 'AAAA', sessionId: i, metadata: { deviceWidth: 800, deviceHeight: 600 } }), 'a video frame');
  }
  assert.equal(acks() - acksBefore, 3, 'every frame is acknowledged');
  assert.equal(getTargetsCalls - targetsBefore, 0, 'a frame must not pay for send()\'s attach check');
  await within(2000, stateModule.setState({ autoAttach: false }), 'a state write after the frames');

  const stopped = await within(5000, issuesTool.stopVideo(7, 'vid-1'), 'stopVideo');
  assert.equal(stopped.frames, 3);
  assert.equal(stopped.attached, true);
  assert.deepEqual(await issuesTool.videoStatus(7), { recording: false });
});

await test('connection status does not rewrite durable bridge settings', async () => {
  const { setState, getState } = await import('../extension/lib/state.js');
  localData.clear();
  sessionData.clear();

  // A configured daemon address, as the side panel or the isolated harness
  // would write it (v2 has no token: host and port are the whole setting).
  await setState({ bridge: { host: '127.0.0.1', port: 55099 } });
  assert.equal(localData.get('settings').bridge.port, 55099);

  // A failed connection is live status, not configuration. It used to mirror
  // the whole bridge object back to disk, which reverted the seeded port to the
  // default and made setup/isolated-livetest.mjs impossible to pass.
  await setState({ bridge: { connected: false, lastError: 'bridge not reachable' } });
  assert.equal(localData.get('settings').bridge.port, 55099, 'status write clobbered the configured port');

  const state = await getState();
  assert.equal(state.bridge.connected, false);
  assert.equal(state.bridge.port, 55099);
});

await test('approving folds in the run the person REVIEWED; a newer run that arrived since is refused', async () => {
  // The desktop sent only the flow id, and the store merged `lastSignature` — which a scheduled
  // replay finishing between the review and the click had already replaced, so that run's surprises
  // (a real regression among them) went into the known world unseen (desktop review, 2026-09-22).
  const store = await import('../extension/lib/store.js');
  const replayModule = await import('../extension/tools/replay.js');
  const base = {
    id: 'rec_approve', name: 'Checkout', startUrl: 'https://shop.test/', steps: [],
    lastSignature: { network: { 'GET /api/banner 2xx': { count: 1 } }, console: {}, ui: {}, steps: [] },
    lastRun: { at: 1_000, verdict: 'SURPRISE', passed: 1, failed: 0 },
  };
  await store.saveRecording(base);
  // A newer run arrives while the dialog is open.
  await store.saveRecording({ ...base, lastRun: { ...base.lastRun, at: 2_000 }, lastSignature: { network: { 'POST /api/pay 5xx': { count: 1 } }, console: {}, ui: {}, steps: [] } });
  await assert.rejects(
    () => replayModule.approveKnownWorld('rec_approve', { by: 'qa', note: 'expected', expectLastRunAt: 1_000 }),
    /newer run[\s\S]*arrived after the one you reviewed/,
  );
  assert.equal((await store.getRecording('rec_approve')).knownWorld ?? null, null, 'nothing was approved');
  // Approving the run that IS on screen works, as always.
  const ok = await replayModule.approveKnownWorld('rec_approve', { by: 'qa', note: 'expected', expectLastRunAt: 2_000 });
  assert.equal(ok.id, 'rec_approve');
  assert.equal((await store.getRecording('rec_approve')).knownWorld.approvedBy, 'qa');
  await store.deleteRecording('rec_approve');
});

await test('a ref keeps naming the element ITS snapshot showed; another agent\'s snapshot never renumbers it (EXT-03)', async () => {
  // Refs were renumbered from e1 by every snapshot of a tab, and the table was the tab's: another
  // agent's snapshot (a read, allowed on any tab) after the page inserted a row made this agent's
  // e2 the row above the one it had seen, and its click deleted the wrong one, reported "delivered"
  // (docs review, 2026-09-22).
  const refs = await import('../extension/lib/refs.js');
  const TABID = 77;
  const page = 'https://rows.test/list';
  await refs.clearRefs(TABID);
  const first = await refs.refNumbering(TABID, page);
  assert.deepEqual([first.next(), first.next()], ['e1', 'e2']);
  await refs.saveRefs(TABID, { url: page, entries: [['e1', { backendNodeId: 11 }], ['e2', { backendNodeId: 12 }]] });

  // A second snapshot of the same page (whoever takes it) continues the numbering.
  const second = await refs.refNumbering(TABID, page);
  assert.deepEqual([second.next(), second.next(), second.next()], ['e3', 'e4', 'e5']);
  await refs.saveRefs(TABID, { url: page, entries: [['e3', { backendNodeId: 10 }], ['e4', { backendNodeId: 11 }], ['e5', { backendNodeId: 12 }]] });
  assert.equal((await refs.resolveRef(TABID, 'e2', page)).backendNodeId, 12, 'the older snapshot\'s ref still names its own element');
  assert.equal((await refs.resolveRef(TABID, 'e3', page)).backendNodeId, 10, 'and the newest snapshot\'s refs work as always');

  // Older than the ring, or from another page: refused with the fix, never resolved elsewhere.
  for (let i = 0; i < refs.KEEP_GENERATIONS; i++) {
    await refs.saveRefs(TABID, { url: page, entries: [[`e${100 + i}`, { backendNodeId: 500 + i }]] });
  }
  await assert.rejects(refs.resolveRef(TABID, 'e2', page), /Unknown element ref/);
  await refs.saveRefs(TABID, { url: 'https://rows.test/other', entries: [['e1', { backendNodeId: 90 }]] });
  await assert.rejects(refs.resolveRef(TABID, 'e103', 'https://rows.test/other'), /Unknown element ref/);
  assert.equal((await refs.refNumbering(TABID, 'https://rows.test/other')).next(), 'e2', 'a new page numbers from the start again');

  // A replay's reserved refs live apart: they never replace an agent's table.
  await refs.saveRefs(TABID, { url: page, entries: [['e1', { backendNodeId: 61 }]] });
  const seen = await refs.withPrivateRefs(TABID, { url: page, entries: [['__replay', { backendNodeId: 99 }]] }, async () => {
    assert.equal((await refs.resolveRef(TABID, '__replay', page)).backendNodeId, 99);
    return (await refs.getRefs(TABID)).map.e1.backendNodeId;
  });
  assert.equal(seen, 61, 'the agent\'s snapshot is untouched during a replay step');
  await assert.rejects(refs.resolveRef(TABID, '__replay', page), /Unknown element ref/);
  await refs.clearRefs(TABID);
});

await test('two attaches at the same time both land in attachedTabs, and Detach releases what the browser really holds', async () => {
  // attach() read attachedTabs, then wrote [itself]: two attaches finishing together each read []
  // and one tab was lost from the list — Detach then left that tab debugged while reporting a clean
  // release, and switching to Stealth never reached it (extension review, 2026-09-22: 20/20 runs
  // with a stub that delays storage).
  const cdp = await import('../extension/lib/cdp.js');
  resetBrowser();
  browserModel.tabs.set(8, { id: 8, url: 'http://example.test/second', title: 'Second', windowId: 1, active: false, status: 'complete' });
  try {
    await stateModule.setState({ attachedTabs: [], currentTabId: null, sessions: {}, halted: false });
    await Promise.all([cdp.attach(7), cdp.attach(8)]);
    assert.deepEqual([...(await stateModule.getState()).attachedTabs].sort(), [7, 8], 'neither attach was lost');

    // A tab the browser debugs for us but that fell out of the list (an older build, a race) is
    // still released by Detach — and a tab the extension does not hold is left alone, silently.
    await stateModule.setState({ attachedTabs: [7] });
    const results = await tabsModule.detachAllTabs();
    assert.deepEqual(results.filter((r) => r.detached).map((r) => r.tabId).sort(), [7, 8]);
    assert.equal(attachedTabs.has(8), false, 'the forgotten tab is no longer debugged');
    assert.equal(attachedTabs.has(7), false);
    assert.deepEqual((await stateModule.getState()).attachedTabs, []);
  } finally {
    await stateModule.setState({ attachedTabs: [], currentTabId: null, halted: false });
    resetBrowser();
  }
});

await test('the v1 mode is removed from settings once, and the daemon address survives it', async () => {
  // v1 had four modes and a migration (migrateModeDefault) that moved people
  // onto Workspace without ever widening their access. v2 has no modes; in its
  // place is a one-time cleanup, which must not take the configured address
  // with it — someone who moved off the default port did so for a reason.
  localData.set('settings', {
    mode: 'multi',
    modeDefaultMigrated: true,
    bridge: { host: '127.0.0.1', port: 55123, token: 'v1-token', serverPath: 'C:/old/bridge/src/server.js' },
    inputMode: 'stealth',
  });
  const note = await stateModule.migrateLegacySettings();
  assert.match(note, /"multi"/);
  assert.match(note, /v2 has no modes/);
  const settings = localData.get('settings');
  assert.equal('mode' in settings, false);
  assert.equal('modeDefaultMigrated' in settings, false);
  assert.deepEqual(settings.bridge, { host: '127.0.0.1', port: 55123 }, 'the token and path hints go; the address stays');
  assert.equal(settings.inputMode, 'stealth', 'a real v2 setting is kept');
  assert.equal(await stateModule.migrateLegacySettings(), null, 'once: a second run finds nothing to do');

  // A mode left in session state by a v1 worker never leaks back into v2 state.
  sessionData.set('state', { ...(sessionData.get('state') ?? {}), mode: 'pinned', pinnedTabId: 7 });
  const state = await stateModule.getState();
  assert.equal('mode' in state, false);
  assert.equal('pinnedTabId' in state, false);
  await stateModule.setState({ inputMode: 'human' });
});

await test('a v1 bridge port the BRIDGE chose (8766-8775) is kept but flagged, so g9d on 8765 can be found once', async () => {
  // v1 bridges without G9_PORT took the next free port in 8765-8775, and the panel saved whichever
  // one the person clicked. An in-place upgrade kept dialling it for ever: "Daemon offline" while
  // g9d ran on 8765 (extension review, 2026-09-22). The port is kept — someone may have set
  // G9_PORT there on purpose — and marked, so the transport tries 8765 once and switches only if
  // g9d answers there.
  localData.set('settings', { mode: 'workspace', bridge: { host: '127.0.0.1', port: 8766, token: 't' } });
  const note = await stateModule.migrateLegacySettings();
  assert.match(note, /port 8766/);
  assert.deepEqual(localData.get('settings').bridge, { host: '127.0.0.1', port: 8766, v1AutoPort: true });
  // A port outside that range was chosen by a person or a test: never flagged.
  localData.set('settings', { mode: 'workspace', bridge: { host: '127.0.0.1', port: 55123, token: 't' } });
  await stateModule.migrateLegacySettings();
  assert.deepEqual(localData.get('settings').bridge, { host: '127.0.0.1', port: 55123 });
  // 8765 itself is the default and needs no fallback.
  localData.set('settings', { mode: 'workspace', bridge: { host: '127.0.0.1', port: 8765, token: 't' } });
  await stateModule.migrateLegacySettings();
  assert.deepEqual(localData.get('settings').bridge, { host: '127.0.0.1', port: 8765 });
  localData.set('settings', { inputMode: 'human', bridge: { host: '127.0.0.1', port: 55099 } });
});

await test("D-b in your own browser: the panel's Input is the default level, and only Stealth is a floor an agent cannot loosen", async () => {
  const { levelFor } = await import('../extension/lib/humanize.js');
  try {
    await stateModule.setState({ inputMode: 'human' });
    assert.equal(platform.settings.humanizeFor(7), 'human');
    assert.equal(platform.settings.stealthFor(7), 'off', 'Human is a default, not a stealth level');
    const direct = await levelFor(7, { humanize: 'off' });
    assert.equal(direct.level, 'off', 'an agent asking for direct input on a Human panel gets it');
    assert.equal(direct.raisedFrom, undefined);
    assert.equal((await levelFor(7, {})).level, 'human', 'a call that names no level runs at the panel setting');

    await stateModule.setState({ inputMode: 'stealth' });
    assert.equal(platform.settings.stealthFor(7), 'stealth');
    const raised = await levelFor(7, { humanize: 'off' });
    assert.equal(raised.level, 'stealth', 'Stealth is a floor');
    assert.equal(raised.raisedFrom, 'off', 'and the raise is reported');

    await stateModule.setState({ inputMode: 'off' });
    assert.equal(platform.settings.stealthFor(7), 'off');
    assert.equal((await levelFor(7, { humanize: 'human' })).level, 'human', 'Direct is a default too');
    assert.equal((await levelFor(7, {})).level, 'off');
  } finally {
    await stateModule.setState({ inputMode: 'human' });
  }
});

await test('snapshot reports the real document title', async () => {
  axNodes = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'G9 Agent Test Page' }, childIds: ['2'] },
    { nodeId: '2', role: { value: 'button' }, name: { value: 'Sign in' }, backendDOMNodeId: 42, childIds: [] },
  ];
  const result = await snapshotModule.snapshot(7, {});
  // It read docInfo.root.title for four versions. CDP's Node type has no such
  // field, so this was "" on every page ever snapshotted.
  assert.equal(result.title, 'G9 Agent Test Page');
});

await test('overflow findings name the cause, not the elements it stretched', async () => {
  const diagnose = await readFile(new URL('../extension/tools/diagnose.js', import.meta.url), 'utf8');
  // The old code sliced the first five in DOCUMENT ORDER and called them
  // "widest offenders" — on the seeded page that named five stretched
  // ancestors and never the 2400px block responsible.
  assert.doesNotMatch(diagnose, /Widest offenders/);
  // Width alone cannot separate cause from victim: an overflowing document
  // stretches every auto-width block inside it, so the culprit and thirty
  // innocent ancestors all measure the same. Scored evidence is the fix.
  assert.match(diagnose, /Most likely cause/);
  assert.match(diagnose, /an empty box this wide was given an explicit width/);
  assert.match(diagnose, /sort\(\(a, b\) => b\.score - a\.score \|\| b\.width - a\.width\)/);
});

await test('bounded evidence: HAR bodies and Web Storage cannot exceed the transport', async () => {
  const [observeSrc, inspectSrc] = await Promise.all([
    readFile(new URL('../extension/tools/observe.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/tools/inspect.js', import.meta.url), 'utf8'),
  ]);
  // The socket drops any frame over 64MB AND the connection with it, so an
  // unbounded result does not truncate — it ends the session. In v2 that limit
  // is the daemon's (daemon/ws-server.js through lib/ws-codec.mjs), and a
  // result relayed from the extension crosses it.
  const { MAX_FRAME_BYTES } = await import('../lib/ws-codec.mjs');
  assert.equal(MAX_FRAME_BYTES, 64 * 1024 * 1024);
  assert.match(observeSrc, /MAX_HAR_BODY_BYTES/);
  assert.match(inspectSrc, /MAX_TOTAL/);
  assert.match(inspectSrc, /truncated/);

  // The HAR budget as behaviour: forty finished requests with 400KB bodies is
  // 16MB of bodies. The export must stop adding bodies at its budget, keep
  // every entry's headers and timing, and SAY how many bodies it left out.
  await observe.clearBuffers(7);
  for (let index = 0; index < 40; index++) {
    const requestId = 'har' + index;
    await observe.ingest(7, 'Network.requestWillBeSent', {
      requestId, loaderId: 'l', timestamp: index, wallTime: 2000 + index,
      type: 'XHR', request: { url: 'http://example.test/api/big/' + index, method: 'GET', headers: {} },
    });
    await observe.ingest(7, 'Network.responseReceived', {
      requestId, response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'application/json' },
    });
    await observe.ingest(7, 'Network.loadingFinished', { requestId, timestamp: index + 0.5, encodedDataLength: 400 * 1024 });
  }
  responseBody = 'x'.repeat(400 * 1024);
  let exported;
  try {
    exported = await observe.har(7, { includeBody: true });
  } finally {
    responseBody = null;
  }
  const bodies = exported.log.entries.map((e) => e.response.content.text ?? '');
  const bodyBytes = bodies.reduce((sum, text) => sum + text.length, 0);
  assert.equal(exported.log.entries.length, 40, 'every entry is kept, with or without its body');
  assert.ok(exported.bodiesOmitted > 0, 'the budget ran out, so some bodies were left out');
  assert.equal(bodies.filter((text) => !text).length, exported.bodiesOmitted, 'and the count says exactly how many');
  assert.ok(bodyBytes <= 8 * 1024 * 1024 + 400 * 1024, `bodies stay within the budget (${bodyBytes} bytes)`);
  assert.match(exported.note, /budget ran out/);
  assert.ok(JSON.stringify(exported).length < MAX_FRAME_BYTES);
  await observe.clearBuffers(7);
});

await test('a click that navigates is not reported as an unobserved event', async () => {
  const replay = await readFile(new URL('../extension/tools/replay.js', import.meta.url), 'utf8');
  // The proof lives on the node; a navigation destroys the node. Reading that
  // as "the page never saw the click" failed every step meant to navigate.
  assert.match(replay, /navigatedAway/);
  assert.match(replay, /unreadable/);
});

await test('the idle watcher disconnects instead of observing forever', async () => {
  const navigate = await readFile(new URL('../extension/tools/navigate.js', import.meta.url), 'utf8');
  // diagnose.memory reads node/listener growth as a leak signal, so a permanent
  // MutationObserver of our own contaminates the number it is asked to explain.
  assert.match(navigate, /stopIdleWatch/);
  assert.match(navigate, /observer\.disconnect\(\)/);
});

await test('locators refuse a text locator that resolves to a different element', async () => {
  const { LOCATOR_SOURCE } = await import('../extension/lib/locators.js');
  // The injected half is a template literal parsed twice; a stray backtick in a
  // comment silently ends it. Prove it is still complete, valid JavaScript.
  new Function(LOCATOR_SOURCE);
  assert.match(LOCATOR_SOURCE, /matches\.length === 1 && matches\[0\] === el/);
  assert.match(LOCATOR_SOURCE, /rootCache/);
});

await test('version skew between the daemon and the extension is reported to the agent', async () => {
  // Both sides always exchanged a version and neither compared them, while the
  // documented workflow (reload extension, restart client) drifts them routinely.
  // v2: the daemon (not a bridge) compares each extension's hello version with
  // its own and browser_status carries the mismatch to the agent. A v1 (major 1)
  // extension is refused at hello with code 4001 — setup/selftest.mjs checks
  // that over a real socket.
  const { Registry } = await import('../daemon/registry.js');
  const { Router } = await import('../daemon/router.js');
  const registry = new Registry({ resumeMs: 0 });
  const engines = { list: () => [], available: () => true, unavailableReason: () => null };
  const router = new Router({ registry, engines, version: '2.0.0', info: () => ({ pid: process.pid, port: 0 }) });
  let ext = null;
  ext = registry.addClient({
    role: 'engine',
    name: 'extension',
    version: '2.0.0-rc.1',
    browser: 'Edge',
    // The extension answers the relayed browser_status as sw.js would.
    send: (msg) => {
      if (msg.type === 'call') {
        setTimeout(() => router.onRelayResult(ext, { type: 'result', id: msg.id, ok: true, result: { engine: 'extension', current: null } }), 0);
      }
      return true;
    },
  });
  const agent = registry.addClient({ role: 'agent', name: 'skew-probe' });

  const [row] = router.engineRows();
  assert.match(row.versionMismatch ?? '', /extension is v2\.0\.0-rc\.1 but the daemon is v2\.0\.0\b/);
  assert.match(row.versionMismatch, /Reload the extension/);
  const status = await within(5000, router.call(agent, 'browser_status', {}), 'browser_status');
  assert.equal(status.versionMismatch, row.versionMismatch, 'the agent is told, in browser_status');

  ext.version = '2.0.0';
  assert.equal(router.engineRows()[0].versionMismatch, undefined, 'the same version is not a finding');
  const clean = await within(5000, router.call(agent, 'browser_status', {}), 'browser_status');
  assert.equal(clean.versionMismatch, undefined);
});

// ------------------------------------- regression memory (signature/known world)

const signature = await import('../extension/lib/signature.js');
const flowspec = await import('../extension/lib/flowspec.js');

await test('normalisation removes run-specific values so two runs are comparable', () => {
  // Without this every run differs from every other run and the whole surprise
  // detector is noise. Persian digits are folded because the app renders both.
  assert.equal(
    signature.normalizeText('task 9f2ab3c4-1111-2222-3333-444455556666 at 2026-09-04T10:11:12Z'),
    'task {uuid} at {date}',
  );
  assert.equal(signature.normalizeText('ردیف ۱۲۳۴۵'), 'ردیف {n}');
  assert.equal(
    signature.normalizeUrl('https://app.test/api/task/9f2ab3c4-1111-2222-3333-444455556666?b=2&a=1'),
    'app.test/api/task/{uuid}?a&b',
  );
  // Query VALUES must not matter and query KEYS must: ?page=2 and ?page=3 are
  // the same operation, ?page=2&debug=1 is not.
  assert.equal(signature.normalizeUrl('https://a.test/x?page=2'), signature.normalizeUrl('https://a.test/x?page=3'));
  assert.notEqual(signature.normalizeUrl('https://a.test/x?page=2'), signature.normalizeUrl('https://a.test/x?page=2&debug=1'));
});

await test('a surprise is raised for something new AND for something newly missing', () => {
  const base = signature.buildSignature({
    flowId: 'f1',
    steps: [{
      id: 's1', type: 'click', ms: 100,
      network: [{ method: 'POST', url: 'https://a.test/api/task', status: 201 }],
      console: [],
      aria: '- button "Save" [ref=e1]\n- heading "Tasks"',
    }],
  });
  let known = signature.mergeKnownWorld(null, base);
  known = signature.mergeKnownWorld(known, base);

  const changed = signature.buildSignature({
    flowId: 'f1',
    steps: [{
      id: 's1', type: 'click', ms: 100,
      // the POST is GONE and a 500 appeared instead
      network: [{ method: 'GET', url: 'https://a.test/api/task', status: 500 }],
      console: [{ level: 'error', text: 'Cannot read properties of undefined' }],
      aria: '- button "Save" [ref=e4]',
    }],
  });

  const { surprises } = signature.detectSurprises(known, changed, { sensitivity: { surprise: 'warn' } });
  const keys = surprises.map((s) => `${s.kind}:${s.layer}`);
  assert.ok(keys.includes('missing:network'), 'a request that always happened and now does not is a finding');
  assert.ok(keys.includes('new:network'), 'a request that never happened before is a finding');
  assert.ok(keys.includes('new:console'), 'a console error nobody asserted on is a finding');
  assert.ok(keys.includes('missing:ui'), 'a control that always appeared and is now gone is a finding');
  // The new 5xx and the new console error are failures; a UI change is a warning.
  const failures = surprises.filter((s) => s.severity === 'fail').map((s) => s.layer);
  assert.ok(failures.includes('console') && failures.includes('network'));
  assert.ok(!surprises.some((s) => s.layer === 'ui' && s.severity === 'fail'));
});

await test('an empty known world seeds instead of reporting everything as a surprise', () => {
  const sig = signature.buildSignature({ flowId: 'f1', steps: [{ id: 's1', network: [{ method: 'GET', url: 'https://a.test/', status: 200 }] }] });
  const result = signature.detectSurprises(null, sig);
  assert.equal(result.seeded, true);
  assert.equal(result.surprises.length, 0);
});

await test('confirmation downgrades a one-off; repetition promotes it', () => {
  const current = [{ layer: 'console', kind: 'new', key: 'error: boom', severity: 'fail' }];
  const first = signature.classifySurprises(current, []);
  assert.equal(first[0].confirmed, false);
  assert.equal(first[0].effectiveSeverity, 'warn', 'one sighting is a note, not a finding');

  const again = signature.classifySurprises(current, [[{ key: 'error: boom', kind: 'new' }]]);
  assert.equal(again[0].confirmed, true);
  assert.equal(again[0].effectiveSeverity, 'fail');
});

await test('calibration marks what differs between two identical runs as volatile', () => {
  const make = (token) => signature.buildSignature({
    flowId: 'f1',
    steps: [{ id: 's1', aria: `- status "${token}"\n- button "Save"`, network: [] }],
  });
  // A live counter is the classic volatile region. Normalisation deliberately
  // does NOT absorb small numbers — collapsing every digit would also hide
  // "level=2" becoming "level=3" — so this is exactly the case calibration is
  // for, and it is caught in both directions (the old value went, a new one came).
  const volatile = signature.calibrateVolatile(make('online 3 users'), make('online 4 users'));
  assert.equal(volatile.length, 2, 'the changing line is volatile going and coming');
  assert.ok(volatile.every((key) => key.startsWith('s1 :: ')));
  assert.ok(!volatile.some((key) => key.includes('Save')), 'the stable control is untouched');

  // And a volatile key is then excluded from surprise detection entirely, even
  // at the strictest sensitivity — which is what stops a counter from filing a
  // ticket every night.
  const known = { ...signature.mergeKnownWorld(null, make('online 3 users')), volatile };
  const { surprises } = signature.detectSurprises(known, make('online 4 users'), { sensitivity: { surprise: 'fail' } });
  assert.equal(surprises.length, 0);
});

await test('FlowSpec is canonical, validated, and refuses to carry a secret', () => {
  const recording = {
    id: 'rec_1', name: 'Create a task', suite: 'smoke', tags: ['b', 'a'],
    parameters: { title: { type: 'string', default: 'G9-x' }, password: { type: 'secretRef', required: true } },
    steps: [
      { id: 's1', type: 'navigate', url: 'https://app.test/' },
      { id: 's2', type: 'click', target: { locators: [{ kind: 'testid', value: 'save' }], fingerprint: { role: 'button', name: 'Save' } } },
      { id: 's3', type: 'assert', assertion: 'network', status: 201, minCount: 1 },
    ],
  };
  const spec = flowspec.toFlowSpec(recording);
  assert.deepEqual(flowspec.validateFlowSpec(spec), []);
  assert.deepEqual(spec.tags, ['a', 'b'], 'tags are sorted so a reorder is not a diff');
  assert.equal(spec.parameters.password.type, 'secretRef');
  assert.ok(!('default' in spec.parameters.password));
  assert.equal(flowspec.canonicalJson(spec), flowspec.canonicalJson(flowspec.toFlowSpec(recording)), 'export is byte-stable');

  // A secret with a literal value must fail loudly — a spec is the artefact
  // most likely to be committed or pasted into a ticket.
  assert.throws(() => flowspec.toFlowSpec({
    ...recording, parameters: { password: { type: 'secretRef', default: 'hunter2' } },
  }), /never contain a secret/);

  // An unknown action must fail rather than be skipped: a runner that silently
  // ignores a step it does not understand returns green for a test that never ran.
  const problems = flowspec.validateFlowSpec({ ...spec, steps: [{ id: 'x', action: 'teleport' }] });
  assert.ok(problems.some((p) => /unknown action/i.test(p)));

  const round = flowspec.fromFlowSpec(spec);
  assert.equal(round.steps.length, 3);
  assert.equal(round.steps[2].assertion, 'network');
});

await test('layout comparison ignores colour and notices structure', () => {
  const size = 64;
  const flat = { algorithm: 'edge-64x64-v1', width: size, height: size, edges: new Array(size * size).fill(0) };
  const withBox = { ...flat, edges: flat.edges.map((_, i) => (i % size > 10 && i % size < 20 ? 1 : 0)) };

  const same = visual.compareVisual({ structure: flat }, { structure: flat }, { mode: 'layout' });
  assert.equal(same.pass, true);
  assert.equal(same.difference, 0);

  const moved = visual.compareVisual({ structure: flat }, { structure: withBox }, { mode: 'layout' });
  assert.equal(moved.pass, false, 'new structure is a real difference');
  assert.ok(moved.changedCells.length > 0);

  // A mask over the changed columns removes it — and reports how much it hid,
  // so a mask that swallows the whole page is visible rather than silent.
  const masked = visual.compareVisual({ structure: flat }, { structure: withBox }, {
    mode: 'layout', masks: [{ x: 10 / size, y: 0, w: 12 / size, h: 1 }],
  });
  assert.equal(masked.pass, true);
  assert.ok(masked.maskedCells > 0);

  // An old baseline has no structure map; saying so beats silently comparing
  // something the caller did not ask for.
  assert.throws(() => visual.compareVisual({ fingerprint: {} }, { structure: flat }, { mode: 'layout' }), /no structure map/);
  assert.equal(visual.compareVisual({}, {}, { mode: 'off' }).skipped, true);
});

await test('pinned network answers every paused request exactly once', async () => {
  const netpin = await import('../extension/tools/netpin.js');
  const answered = [];
  const originalSend = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (_source, method, params) => {
    if (/^Fetch\.(fulfillRequest|continueRequest|failRequest)$/.test(method)) answered.push({ method, params });
    return {};
  };
  try {
    const har = { log: { entries: [{
      request: { method: 'GET', url: 'https://a.test/api/x?q=1' },
      response: { status: 200, headers: [{ name: 'content-type', value: 'application/json' }], content: { mimeType: 'application/json', text: '{"ok":true}' } },
    }] } };
    await netpin.pin(7, { har });

    await netpin.onRequestPaused(7, { requestId: 'r1', request: { method: 'GET', url: 'https://a.test/api/x?q=9' } });
    assert.equal(answered.at(-1).method, 'Fetch.fulfillRequest', 'query VALUES do not change the operation');

    await netpin.onRequestPaused(7, { requestId: 'r2', request: { method: 'GET', url: 'https://a.test/other' } });
    assert.equal(answered.at(-1).method, 'Fetch.continueRequest', 'unmatched passes through by default');

    await netpin.unpin(7);
    await netpin.pin(7, { har, strict: true });
    await netpin.onRequestPaused(7, { requestId: 'r3', request: { method: 'GET', url: 'https://a.test/other' } });
    assert.equal(answered.at(-1).method, 'Fetch.failRequest', 'strict refuses what it did not record');

    const status = await netpin.status(7);
    assert.equal(status.pinned, true);
    assert.equal(status.failed, 1);
    assert.equal((await netpin.unpin(7)).unpinned, true);
    assert.equal((await netpin.status(7)).pinned, false);
  } finally {
    chrome.debugger.sendCommand = originalSend;
  }
});

await test('a pinned response is not used up by a request the page cancelled before it was answered', async () => {
  const netpin = await import('../extension/tools/netpin.js');
  const answered = [];
  let gone = new Set();
  const originalSend = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (_source, method, params) => {
    if (/^Fetch\.(fulfillRequest|continueRequest|failRequest)$/.test(method)) {
      // A request the page cancelled no longer exists: the browser refuses every answer.
      if (gone.has(params.requestId)) throw new Error('Invalid InterceptionId.');
      answered.push({ method, requestId: params.requestId, body: params.body ? Buffer.from(params.body, 'base64').toString('utf8') : null });
    }
    return {};
  };
  const entry = (page) => ({
    request: { method: 'GET', url: 'https://a.test/api/list' },
    response: { status: 200, headers: [{ name: 'content-type', value: 'application/json' }], content: { mimeType: 'application/json', text: `{"page":${page}}` } },
  });
  try {
    await netpin.pin(7, { har: { log: { entries: [entry(1), entry(2), entry(3)] } } });
    gone = new Set(['c1']);
    await netpin.onRequestPaused(7, { requestId: 'c1', request: { method: 'GET', url: 'https://a.test/api/list' } });
    assert.equal(answered.length, 0, 'nothing could be answered: the request is gone');
    await netpin.onRequestPaused(7, { requestId: 'c2', request: { method: 'GET', url: 'https://a.test/api/list' } });
    await netpin.onRequestPaused(7, { requestId: 'c3', request: { method: 'GET', url: 'https://a.test/api/list' } });
    assert.deepEqual(answered.map((a) => a.body), ['{"page":1}', '{"page":2}'], 'the cancelled request did not use up page 1');
    const status = await netpin.status(7);
    assert.equal(status.served, 2, 'only what was really served is counted');
    assert.equal(status.passedThrough, 0);
  } finally {
    chrome.debugger.sendCommand = originalSend;
    await netpin.unpin(7).catch(() => {});
  }
});

await test('the new assertion and network actions are declared in the MCP schema', () => {
  const tools = toolsModule.TOOLS;
  const recording = tools.find((t) => t.name === 'browser_recording');
  const network = tools.find((t) => t.name === 'browser_network');
  // A capability the router implements and the schema does not declare is a
  // capability no agent will ever call.
  for (const action of ['calibrate', 'approve', 'known_world', 'export_spec', 'import_spec']) {
    assert.ok(recording.inputSchema.properties.action.enum.includes(action), `browser_recording is missing action "${action}"`);
  }
  assert.ok(recording.inputSchema.properties.assertion.enum.includes('aria'));
  for (const action of ['pin', 'unpin', 'record_har', 'pin_status']) {
    assert.ok(network.inputSchema.properties.action.enum.includes(action), `browser_network is missing action "${action}"`);
  }
  assert.match(toolsModule.INSTRUCTIONS, /known world/i);
  assert.match(toolsModule.INSTRUCTIONS, /Never approve on your own initiative/);
});

// ----------------------------------------- v2: no modes (replaced workspace)
//
// v1.7.0's workspace mode (the allowlist, the redacted listing, refusals that
// named the project file) and the pinned/follow/multi modes are gone in v2
// (decision D6): the deployment is local and trusted, and attaching a tab gives
// full access. What replaced them is tested here — a listing that shows every
// tab, attach making a tab the current one, and one resolution order for every
// call (ARCHITECTURE_V2 §4.1).

await test('v2 has no modes: the tab list shows every tab in full, keyed by tabId', async () => {
  resetBrowser();
  browserModel.tabs.set(8, {
    id: 8, url: 'https://mail.example.com/inbox/thread/42', title: 'Inbox — thread 42', windowId: 1, active: false, status: 'complete',
  });
  try {
    await stateModule.setState({ currentTabId: null, sessions: {}, halted: false });
    const { tabs } = await runtime.runTool('browser_tabs', { action: 'list' });
    const byId = new Map(tabs.map((t) => [t.tabId, t]));
    // Titles and URLs are exactly what v1 withheld outside Multi mode. In v2 a
    // listing that hides them is a bug, not a boundary.
    assert.equal(byId.get(8).url, 'https://mail.example.com/inbox/thread/42');
    assert.equal(byId.get(8).title, 'Inbox — thread 42');
    // A browser page is listed too — as not attachable, never as hidden.
    assert.equal(byId.get(9).url, 'chrome://settings');
    assert.equal(byId.get(9).attachable, false);
    assert.equal(byId.get(7).attachable, true);
    // Identity is always `tabId`, never `id`: the daemon rewrites that one key
    // between Chrome tab ids and its own handles, and a second spelling would
    // slip past the rewrite and hand an agent a raw Chrome id.
    for (const row of tabs) assert.equal('id' in row, false, 'a listing row must not carry `id`');
    for (const key of ['tabId', 'title', 'url', 'active', 'windowId', 'windowState', 'current', 'attached', 'attachable', 'status', 'openerTabId']) {
      assert.ok(key in byId.get(7), `listTabs rows carry ${key} (ARCHITECTURE_V2 §4.1)`);
    }
    // v1's ways of choosing a mode are gone, and say what to do instead.
    await assert.rejects(() => runtime.runTool('browser_tabs', { action: 'pin', tabId: 7 }), /removed in v2 — there are no modes/);
    await assert.rejects(() => runtime.runTool('browser_tabs', { action: 'unpin' }), /Use action:"attach"/);
    const tabsSchema = toolsModule.TOOLS.find((t) => t.name === 'browser_tabs');
    assert.ok(!tabsSchema.inputSchema.properties.action.enum.includes('pin'), 'pin is not offered to agents');
    assert.equal('mode' in (await stateModule.getState()), false, 'state has no mode');
  } finally {
    resetBrowser();
  }
});

await test('attach makes the tab current, and a call without a tabId then acts on it', async () => {
  // v1 had the pinned tab. v2 has the current tab (§4.1 step 3), set by the
  // panel's Attach and by browser_tabs attach — and it outranks the tab the
  // person happens to be looking at, or an agent would follow their clicks
  // around the browser.
  resetBrowser();
  browserModel.tabs.set(8, { id: 8, url: 'http://example.test/other', title: 'Other', windowId: 1, active: true, status: 'complete' });
  browserModel.tabs.get(9).active = false;
  try {
    await stateModule.setState({ currentTabId: null, sessions: {}, halted: false });
    assert.equal((await tabsModule.resolveTarget(null, null)).id, 8, 'nothing current: the active tab');

    const attached = await runtime.runTool('browser_tabs', { action: 'attach', tabId: 7 });
    assert.deepEqual({ tabId: attached.tabId, url: attached.url }, { tabId: 7, url: 'http://example.test/' });
    assert.equal((await stateModule.getState()).currentTabId, 7);
    assert.ok(attachedTabs.has(7), 'attached for real — the browser reports it');
    assert.equal((await tabsModule.resolveTarget(null, null)).id, 7, 'the current tab outranks the active one');
    assert.equal((await runtime.status()).current.tabId, 7, 'and browser_status describes it');

    // An agent's attach never lifts a Stop; only the person's own Attach in the
    // panel does (v1's pin bug made the Stop button self-defeating).
    await stateModule.setState({ halted: true });
    await assert.rejects(() => runtime.runTool('browser_tabs', { action: 'attach', tabId: 7 }), /pressed Stop/);
    const fromPanel = await tabsModule.attachTab(7, { clearHalt: true });
    assert.equal(fromPanel.resumed, true);
    assert.equal((await stateModule.getState()).halted, false);
  } finally {
    await stateModule.setState({ currentTabId: null, halted: false });
    resetBrowser();
  }
});

await test('one resolution order for every call: tabId, session, current tab, active tab — else a refusal', async () => {
  resetBrowser();
  browserModel.tabs.set(8, { id: 8, url: 'http://example.test/buyer', title: 'Buyer', windowId: 1, active: false, status: 'complete' });
  try {
    await stateModule.setState({ currentTabId: 7, sessions: {}, halted: false });
    await runtime.runTool('browser_tabs', { action: 'session', name: 'buyer', tabId: 8 });

    assert.equal((await tabsModule.resolveTarget(8, null)).id, 8, '1. an explicit tabId');
    assert.equal((await tabsModule.resolveTarget(null, 'buyer')).id, 8, '2. a session name');
    assert.equal((await tabsModule.resolveTarget(null, null)).id, 7, '3. the current tab');
    await assert.rejects(() => tabsModule.resolveTarget(404, null), /Tab 404 no longer exists/);
    await assert.rejects(() => tabsModule.resolveTarget(null, 'seller'), /No session named "seller"\. Open sessions: buyer\./);

    // The same order runs inside every tool call: a snapshot addressed by
    // session reads THAT tab, not the current one.
    axNodes = [{ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Buyer' }, childIds: [] }];
    const before = commandLog.length;
    await runtime.runTool('browser_snapshot', { session: 'buyer' });
    const read = commandLog.slice(before).filter((c) => c.method === 'Accessibility.getFullAXTree').map((c) => c.tabId);
    assert.deepEqual(read, [8], 'the snapshot read the session\'s tab');

    // A current tab that navigated to a browser page is refused, not swapped
    // for another tab behind the agent's back.
    browserModel.tabs.get(7).url = 'edge://settings/';
    await assert.rejects(() => tabsModule.resolveTarget(null, null),
      /The current tab \(7\) is on edge:\/\/settings, a browser-internal page that cannot be controlled/);

    // 4. A current tab that CLOSED is forgotten, and the active tab is used.
    browserModel.tabs.delete(7);
    browserModel.tabs.get(9).active = false;
    browserModel.tabs.get(8).active = true;
    assert.equal((await tabsModule.resolveTarget(null, null)).id, 8, '4. the active tab');
    assert.equal((await stateModule.getState()).currentTabId, null, 'a closed current tab is forgotten, not kept as a stale id');
  } finally {
    await stateModule.setState({ currentTabId: null, sessions: {} });
    resetBrowser();
  }
});

// ------------------------------------------------- v1.7.0: named sessions

await test('every tab-taking tool accepts a session, and browser_tabs manages them by name', () => {
  const withTabId = toolsModule.TOOLS.filter((t) => t.inputSchema?.properties?.tabId);
  assert.ok(withTabId.length >= 10, 'expected most tools to take a tabId');
  for (const tool of withTabId) {
    assert.ok(tool.inputSchema.properties.session, `${tool.name} accepts tabId but not session`);
  }
  // v1 kept `session` off browser_tabs so "which tab" could never be ambiguous.
  // v2 keeps that guarantee a different way: on browser_tabs `session` is only
  // the tab an action such as close/focus/claim/popout is ABOUT (the daemon
  // resolves it like a tabId), while the name a "session" action CREATES is
  // `name`. The two never mean the same thing.
  const tabs = toolsModule.TOOLS.find((t) => t.name === 'browser_tabs');
  assert.match(tabs.inputSchema.properties.session.description, /Instead of tabId/);
  assert.match(tabs.inputSchema.properties.name.description, /session name/);
  for (const action of ['session', 'sessions', 'end_session']) {
    assert.ok(tabs.inputSchema.properties.action.enum.includes(action), `browser_tabs is missing "${action}"`);
  }
  // The hidden-tab rule must be in the schema itself. An agent that opens two
  // sessions and clicks into the background one gets nothing, and the tool
  // description is the only place it will read the reason.
  assert.match(tabs.description, /only delivers input to the tab it is SHOWING/i);
});

await test('a session is a name for a tab: ending it keeps the tab, detaching drops every name', async () => {
  resetBrowser();
  browserModel.tabs.set(8, { id: 8, url: 'http://example.test/buyer', title: 'Buyer', windowId: 1, active: false, status: 'complete' });
  try {
    await stateModule.setState({ currentTabId: 7, sessions: {}, halted: false });
    const named = await runtime.runTool('browser_tabs', { action: 'session', name: 'buyer', tabId: 8 });
    assert.deepEqual({ session: named.session, tabId: named.tabId }, { session: 'buyer', tabId: 8 });
    const { sessions } = await runtime.runTool('browser_tabs', { action: 'sessions' });
    assert.deepEqual(sessions.map((s) => [s.session, s.tabId, s.alive]), [['buyer', 8, true]]);

    // Ending a session forgets the name and lets go of the debugger. It never
    // closes the tab: the person may be looking at that page, and a tool that
    // closes tabs as a side effect of bookkeeping is one people stop trusting.
    const ended = await runtime.runTool('browser_tabs', { action: 'end_session', name: 'buyer' });
    assert.equal(ended.closed, true);
    assert.ok(browserModel.tabs.has(8), 'the tab stays open');
    assert.equal(attachedTabs.has(8), false, 'and is no longer being debugged');

    // Detaching drops sessions, or a name outlives the debugger session it
    // points at — and the next call would silently re-attach a tab the person
    // just asked us to let go of.
    await runtime.runTool('browser_tabs', { action: 'session', name: 'buyer', tabId: 8 });
    await tabsModule.detachAllTabs();
    const state = await stateModule.getState();
    assert.deepEqual(state.sessions, {});
    assert.equal(state.currentTabId, null);
    assert.equal(attachedTabs.has(8), false);
  } finally {
    await stateModule.setState({ currentTabId: null, sessions: {} });
    resetBrowser();
  }
});

// --------------------------------------------- v1.7.0: panel + flow library

await test('the panel exposes the whole automation surface, not five commands of it', async () => {
  const sw = await readFile(new URL('../extension/sw.js', import.meta.url), 'utf8');
  // Every one of these already existed and was reachable only over MCP, which
  // left a QA able to record a macro and never a test.
  for (const command of [
    'recSuggest',
    'recAssert',
    'recUpdate',
    'recCalibrate',
    'recApprove',
    'recKnownWorld',
    'recExportTest',
    'flowStatus',
    'flowPull',
    'flowPush',
    // v2 (ARCHITECTURE_V2 §13): the input level, auto-attach, popping a tab
    // out, handing it to a launched browser, and what the daemon and this
    // build are.
    'setInputMode',
    'setAutoAttach',
    'popout',
    'handoff',
    'daemonInfo',
    'about',
  ]) {
    assert.match(sw, new RegExp(`case '${command}'`), `the panel cannot call ${command}`);
  }
  // The v1 commands for what v2 removed: one daemon on one port leaves nothing
  // to discover, and there are no modes to set. A worker that still answered
  // them would keep a dead feature reachable from an old panel.
  for (const gone of ['discoverBridges', 'setMode']) {
    assert.doesNotMatch(sw, new RegExp(`case '${gone}'`), `sw.js still answers the removed ${gone}`);
  }
});

await test('the replay report renders the verdict and surprises it was always given', async () => {
  const automation = await readFile(new URL('../extension/panel/automation.js', import.meta.url), 'utf8');
  // The data was in the response all along; the old report threw it away and
  // rendered passed/failed only — so the surprise detector had no UI at all.
  assert.match(automation, /surpriseLines/);
  assert.match(automation, /FAIL_AUTOMATION/);
  assert.match(automation, /VERDICT_ADVICE/);
  // The advice column is the point of separating the two failure verdicts, so
  // assert the MEANING rather than the sentence: the FAIL_AUTOMATION advice must
  // tell the reader this says nothing about the product. Pinning the exact copy
  // made this test fail the moment the wording was corrected — which is a test
  // guarding the phrasing instead of the behaviour.
  const advice = automation.match(/FAIL_AUTOMATION: '([^']+)'/)?.[1] ?? '';
  assert.ok(advice.length > 20, 'FAIL_AUTOMATION must carry advice');
  assert.match(advice, /not the product|says nothing about the product/i);
  // And it must not assert a single cause: this verdict now covers a rotted
  // locator AND input the browser never delivered.
  assert.doesNotMatch(advice, /^An element moved or was renamed\.$/);
});

/** A throwaway flow-library folder for one test (daemon/flows.js works on real files). */
async function withFlowLibrary(fn) {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { FlowLibrary } = await import('../daemon/flows.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'g9-flows-'));
  try {
    return await fn(new FlowLibrary(root), root, path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await test('the flow library refuses to write local-only run history to the repo', async () => {
  // v2: the flow library moved with the bridge into the daemon (daemon/flows.js).
  const { relativePathFor } = await import('../daemon/flows.js');
  const flows = await readFile(new URL('../daemon/flows.js', import.meta.url), 'utf8');

  // Committing run history means every replay dirties the working tree, which
  // trains people to `git checkout .` — and eventually to discard a real edit.
  assert.match(flows, /LOCAL_ONLY = \['runHistory', 'lastRun', 'flaky', 'knownWorld', 'surpriseHistory'\]/);
  assert.match(flows, /for \(const field of LOCAL_ONLY\) delete clean\[field\]/);

  // As behaviour, on a real folder: a flow that arrives carrying all five.
  await withFlowLibrary(async (library, root, path) => {
    const spec = flowspec.toFlowSpec({
      id: 'rec_hist', name: 'Login', folder: 'auth',
      steps: [{ id: 's1', type: 'navigate', url: 'https://app.test/' }],
    });
    const history = {
      runHistory: [{ at: 1, verdict: 'PASS' }], lastRun: { at: 1 }, flaky: { rate: 0.1 },
      knownWorld: { runs: 3 }, surpriseHistory: [[]],
    };
    const written = await library.write({ ...spec, ...history });
    assert.equal(written.file, 'web/auth/login.flow.json');
    const onDisk = JSON.parse(await readFile(path.join(root, written.file), 'utf8'));
    for (const field of Object.keys(history)) {
      assert.equal(field in onDisk, false, `${field} must never reach the repository`);
    }
    assert.equal(onDisk.id, 'rec_hist');
    // A replay changes only local history, so pushing again changes no byte —
    // and says so, which answers "did my edit actually save?".
    assert.equal((await library.write({ ...spec, lastRun: { at: 2 } })).changed, false);
  });

  // A path a human can read in a diff, derived from the flow's own metadata.
  assert.equal(
    relativePathFor({ id: 'rec_a91f3c', name: 'Site switch', folder: 'map', target: { kind: 'maui' } }).replace(/\\/g, '/'),
    'agripad/map/site-switch.flow.json',
  );
  assert.equal(
    relativePathFor({ id: 'rec_1', name: 'Login', folder: 'auth', target: { kind: 'web' } }).replace(/\\/g, '/'),
    'web/auth/login.flow.json',
  );
});

await test('both sides hash the same bytes, or the sync indicator lies forever', async () => {
  const flows = await readFile(new URL('../daemon/flows.js', import.meta.url), 'utf8');
  const sw = await readFile(new URL('../extension/sw.js', import.meta.url), 'utf8');
  const flowspecSrc = await readFile(new URL('../extension/lib/flowspec.js', import.meta.url), 'utf8');

  // canonicalJson() is what the extension hashes; `JSON.stringify(x, null, 2)`
  // plus a newline is what the daemon writes AND hashes. If those two strings
  // ever diverge, every flow reports as "differs" and the indicator becomes
  // noise people stop reading.
  assert.match(flowspecSrc, /JSON\.stringify\(canonicalize\(spec\), null, 2\)\}\\n/);
  assert.match(flows, /const serialised = `\$\{JSON\.stringify\(value, null, 2\)\}\\n`/);
  assert.match(flows, /createHash\('sha1'\)/);
  assert.match(sw, /crypto\.subtle\.digest\('SHA-1'/);
  assert.match(sw, /\.slice\(0, 12\)/);

  // As behaviour: sw.js's own specHash (Web Crypto) against the hash the
  // daemon's library reports (node:crypto) for the same flow pushed the way
  // flowPush pushes it — toFlowSpec, then JSON over the socket.
  const { specHash } = liftFunctions(sw, ['specHash'], {
    toFlowSpec: flowspec.toFlowSpec, canonicalJson: flowspec.canonicalJson, crypto: globalThis.crypto,
  });
  const recording = {
    id: 'rec_sync', name: 'Sync probe', folder: 'auth', tags: ['smoke'], runHistory: [{ at: 1 }],
    steps: [
      { id: 's1', type: 'navigate', url: 'https://app.test/' },
      { id: 's2', type: 'click', target: { locators: [{ kind: 'testid', value: 'save' }] } },
    ],
  };
  const extensionHash = await specHash(recording);
  assert.match(extensionHash, /^[0-9a-f]{12}$/);
  await withFlowLibrary(async (library) => {
    await library.write(JSON.parse(JSON.stringify(flowspec.toFlowSpec(recording))));
    const [listed] = (await library.list()).flows;
    assert.equal(listed.hash, extensionHash, 'the daemon and the extension disagree about identical bytes');
    const inSync = await library.status([{ id: 'rec_sync', name: 'Sync probe', hash: extensionHash }]);
    assert.deepEqual(inSync.differing, []);
    const edited = await library.status([{ id: 'rec_sync', name: 'Sync probe', hash: await specHash({ ...recording, name: 'Renamed' }) }]);
    assert.equal(edited.differing.length, 1, 'a real edit on one side is reported');
  });
});

await test('the suite is a query, so a forgotten flow cannot silently shrink it', async () => {
  const flows = await readFile(new URL('../daemon/flows.js', import.meta.url), 'utf8');
  assert.match(flows, /async resolveSuite/);
  assert.match(flows, /select\.excludeTags/);
  // A hand-maintained array is the failure this exists to prevent: it shrinks
  // the first time somebody forgets, and still reports green.
  assert.match(flows, /A suite is a QUERY, not a list/);

  // As behaviour: a suite selected by tags picks up a flow recorded after it
  // was written, with nobody editing the suite.
  await withFlowLibrary(async (library, root, path) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.join(root, 'suites'), { recursive: true });
    await writeFile(path.join(root, 'suites', 'web.smoke.json'), JSON.stringify({
      id: 'web.smoke', name: 'Smoke', select: { platform: 'web', tags: ['smoke'], excludeTags: ['slow'] }, order: 'name',
    }));
    const flow = (id, name, tags) => flowspec.toFlowSpec({ id, name, tags, steps: [{ id: 's1', type: 'navigate', url: 'https://app.test/' }] });
    await library.write(flow('a', 'Alpha', ['smoke']));
    await library.write(flow('b', 'Bravo', ['smoke', 'slow']));
    await library.write(flow('c', 'Charlie', ['nightly']));
    const ids = async () => (await library.resolveSuite('web.smoke')).flows.map((f) => f.id);
    assert.deepEqual(await ids(), ['a']);
    await library.write(flow('d', 'Delta', ['smoke']));
    assert.deepEqual(await ids(), ['a', 'd'], 'a new smoke flow joins the suite by its tags alone');
    await assert.rejects(() => library.resolveSuite('nope'), /No suite "nope"\. Known suites: web\.smoke/);
  });
});

await test('one daemon on one port: nothing to discover, and /health identifies it only to extensions', async () => {
  // v1 scanned 8765-8775 for bridges, because every editor started its own and
  // the extension had to choose one. v2 has ONE daemon per machine, shared by
  // every agent (ARCHITECTURE_V2 §1): the extension dials one configured
  // address, and there is nothing left to discover.
  const transport = await import('../extension/lib/transport.js');
  const { DEFAULT_PORT } = await import('../daemon/paths.js');
  const { DEFAULTS } = await import('../daemon/settings.js');
  assert.equal(transport.DEFAULT_PORT, 8765);
  assert.equal(DEFAULT_PORT, transport.DEFAULT_PORT, 'the daemon and the extension agree on the default port');
  assert.equal(DEFAULTS.port, transport.DEFAULT_PORT);
  for (const gone of ['discoverBridges', 'PORT_RANGE']) {
    assert.equal(gone in transport, false, `transport still exports ${gone}`);
  }

  // CORS on /health must stay conditional. A blanket allow-origin would hand a
  // malicious page a way to probe for the daemon and read its home path off
  // it — defeating the Origin check the whole security model rests on.
  const { WsServer, classifyOrigin } = await import('../daemon/ws-server.js');
  assert.deepEqual(classifyOrigin('https://evil.example'), { ok: false, kind: 'web' });
  assert.deepEqual(classifyOrigin('chrome-extension://abcdefghijklmnop'), { ok: true, kind: 'extension' });
  assert.deepEqual(classifyOrigin(''), { ok: true, kind: 'native' });

  const server = new WsServer({ port: testPort(), health: () => ({ name: 'g9d', home: 'C:/Users/someone/G9' }) });
  for (let attempt = 0; ; attempt++) {
    try {
      await server.listen();
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt >= 5) throw err;
      server.port = testPort();
    }
  }
  try {
    const http = await import('node:http');
    const health = (origin) => new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: server.port, path: '/health', headers: origin ? { origin } : {} }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ headers: res.headers, body: JSON.parse(body) }));
      });
      req.on('error', reject);
    });
    const web = await health('https://evil.example');
    assert.equal(web.headers['access-control-allow-origin'], undefined, 'a web page must not be able to read /health');
    const ext = await health('chrome-extension://abcdefghijklmnop');
    assert.equal(ext.headers['access-control-allow-origin'], 'chrome-extension://abcdefghijklmnop');
    const native = await health(null);
    assert.equal(native.headers['access-control-allow-origin'], undefined);
    // The name is what tells a v2 daemon from a v1 bridge on the same port
    // (the extension's preflight and the shim both read it).
    assert.equal(native.body.name, 'g9d');
    assert.equal(native.body.ok, true);
  } finally {
    await server.close();
  }
});

await test('a harness failure is never reported as a product regression', async () => {
  const replaySource = await readFile(new URL('../extension/tools/replay.js', import.meta.url), 'utf8');

  // FOUND LIVE, 2026-09-10, twice in two runs. Both came back FAIL_PRODUCT:
  //   "The click was dispatched but the page never received it: the attached
  //    tab is HIDDEN (document.visibilityState="hidden")"   ← Chromium's rule
  //   "Found textbox …, but it never stopped moving"        ← the gate WORKING
  // Neither is a defect in the product. Reporting them as one is exactly what
  // the FAIL_PRODUCT / FAIL_AUTOMATION split exists to prevent.
  const patterns = replaySource.match(/const AUTOMATION_FAILURE_PATTERNS = \[[\s\S]*?\n\];/);
  assert.ok(patterns, 'AUTOMATION_FAILURE_PATTERNS is missing');

  // Rebuild the predicate from the source so the test exercises the real list.
  const list = patterns[0]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/') && line.endsWith(','))
    .map((line) => {
      const body = line.slice(0, -1);
      const close = body.lastIndexOf('/');
      return new RegExp(body.slice(1, close), body.slice(close + 1));
    });
  assert.ok(list.length >= 12, `expected a real list, got ${list.length}`);
  const isAutomation = (message) => list.some((re) => re.test(message));

  for (const harnessFailure of [
    'The click was dispatched but the page never received it: the attached tab is HIDDEN (document.visibilityState="hidden").',
    'Found textbox "search", but it never stopped moving — its position was still changing after the wait.',
    'Could not find textbox "Username" under "Billing details".',
    'Lost the resolved element between locating it and acting on it.',
    'The button is covered by an overlay at that point.',
    'Timed out waiting for the page to become ready.',
  ]) {
    assert.ok(isAutomation(harnessFailure), `should be FAIL_AUTOMATION: ${harnessFailure}`);
  }

  // The other direction matters more: a real defect must never be excused as
  // "just the test". Losing a regression is worse than losing trust.
  for (const productFailure of [
    'Assertion failed: expected url to contain "/orders" but it is "/login".',
    'POST /api/task returned 500.',
    'Expected 3 rows, found 0.',
    'aria baseline differs: button "Archive" is missing.',
  ]) {
    assert.ok(!isAutomation(productFailure), `should stay FAIL_PRODUCT: ${productFailure}`);
  }
});

await test('a replay result is bounded, and says what it is not showing', async () => {
  const replaySource = await readFile(new URL('../extension/tools/replay.js', import.meta.url), 'utf8');

  // FOUND LIVE, 2026-09-10: one replay against a page full of live data emitted
  // 180+ surprise lines and a 103,553-character result that exceeded the
  // agent's token budget outright — from a tool whose own README explains that
  // it ships fourteen tools rather than fifty precisely to protect context.
  assert.match(replaySource, /const MAX_SURPRISE_LINES = \d+/);
  assert.match(replaySource, /SURPRISE_RANK/, 'the cap must keep failures ahead of notes');
  assert.match(replaySource, /ranked\.slice\(0, MAX_SURPRISE_LINES\)/);
  // A truncation that hides its own existence is the same silent-omission bug
  // in a new place, so the count of what was dropped has to be reported.
  assert.match(replaySource, /and \$\{hidden\} more/);
  assert.match(replaySource, /summary\.surpriseCount = \{/);
  // The panel and the report keep the complete set — they render locally.
  assert.match(replaySource, /summary\.surprises = classified;/);
});

await test('the AgriPad driver finds adb and spawns it without a shell', async () => {
  const driver = await readFile(new URL('../runner/drivers/agripad.mjs', import.meta.url), 'utf8');
  const { resolveAdb } = await import('../runner/drivers/agripad.mjs');

  // FOUND LIVE, 2026-09-10, twice in a row on a machine with a working emulator:
  //   "adb is not recognized as an internal or external command"   ← not on PATH
  //   "'C:\Program' is not recognized"                             ← shell:true split the path
  // The second is Node's own DEP0190 hazard: shell:true concatenates, so any
  // install path containing a space becomes two arguments.
  assert.match(driver, /export function resolveAdb/);
  assert.match(driver, /platform-tools/);
  assert.match(driver, /G9_ADB/, 'an explicit override must exist for unusual installs');
  assert.match(driver, /shell: false/);
  // Check the CODE, not the comment that explains why the old form was wrong —
  // the explanation quotes it, and an assertion over the whole file cannot tell
  // the two apart.
  const spawnCall = driver.slice(driver.indexOf('const child = spawn('));
  assert.doesNotMatch(spawnCall.slice(0, 120), /process\.platform === 'win32'/);

  // Every adb invocation must go through the resolver; a bare 'adb' left behind
  // is the one that fails on the machine nobody tested.
  assert.doesNotMatch(driver, /run\('adb'/);
  assert.equal(typeof resolveAdb(), 'string');
});

await test('a device run reports its duration instead of NaN', async () => {
  const runner = await readFile(new URL('../runner/g9.mjs', import.meta.url), 'utf8');
  // The web path set run.durationMs and the summary line read it; the device
  // path never did, so a passing run printed "PASS=1 · NaNs · exit 0". A summary
  // that prints NaN is a summary people stop reading.
  const device = runner.slice(runner.indexOf('async function commandRunAgriPad'));
  assert.match(device, /run\.durationMs = run\.finishedAt - run\.startedAt/);
});

await test('the daemon keeps its configured port, and explains a held one instead of moving', async () => {
  // v1: "a pinned port is honoured and an unset one is discovered" — a bridge
  // that could not have 8765 scanned for the next free port. v2 has ONE daemon
  // on ONE port (G9_PORT, else settings.port, else 8765) that every shim and the
  // extension dial. A daemon that helpfully moved would be one nobody finds, so
  // a held port is explained — naming the holder — and the daemon exits.
  const { parsePort } = await import('../daemon/paths.js');
  assert.equal(parsePort('18555'), 18555);
  for (const bad of ['0', '65536', 'abc', '8765.5', '']) assert.equal(parsePort(bad), null, `"${bad}" is not a port`);
  const g9d = await readFile(new URL('../daemon/g9d.mjs', import.meta.url), 'utf8');
  assert.match(g9d, /const explicitPort = parsePort\(args\.port\) \?\? parsePort\(process\.env\.G9_PORT\)/);
  // The shim (and, since 3.2, the HTTP endpoint) dials the same G9_PORT through mcp/link.mjs, and
  // starts a daemon on exactly that port.
  const link = await readFile(new URL('../mcp/link.mjs', import.meta.url), 'utf8');
  assert.match(link, /Number\(process\.env\.G9_PORT\)/);
  assert.match(link, /G9_PORT: String\(PORT\)/);
  assert.match(await readFile(new URL('../mcp/shim.mjs', import.meta.url), 'utf8'), /from '\.\/link\.mjs'/);

  // As behaviour: hold a private port with something that answers /health the
  // way a v1 bridge does, start the real g9d on it with a throwaway home, and
  // watch it refuse rather than take another port.
  const http = await import('node:http');
  const os = await import('node:os');
  const path = await import('node:path');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { spawn } = await import('node:child_process');
  const holder = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '1.9.2', pid: 4242 }));
  });
  let port;
  for (let attempt = 0; ; attempt++) {
    port = testPort();
    try {
      await new Promise((resolve, reject) => {
        holder.once('error', reject);
        holder.listen(port, '127.0.0.1', () => { holder.removeListener('error', reject); resolve(); });
      });
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt >= 5) throw err;
    }
  }
  const home = await mkdtemp(path.join(os.tmpdir(), 'g9-port-'));
  try {
    const env = { ...process.env, G9_PORT: String(port), G9_HOME: home, G9_IDLE_EXIT_MS: '3000' };
    delete env.G9_PROJECT;
    const { fileURLToPath } = await import('node:url');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../daemon/g9d.mjs', import.meta.url))], {
      env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    const exit = await within(30_000, new Promise((resolve) => child.on('exit', (code) => resolve(code))), 'g9d on a held port')
      .catch((err) => { child.kill(); throw err; });
    assert.equal(exit, 1, 'a daemon that cannot have its port exits with an error');
    const log = await readFile(path.join(home, 'logs', 'daemon.log'), 'utf8');
    assert.match(log, new RegExp(`port ${port} is held by a G9 v1 bridge \\(pid 4242, v1\\.9\\.2\\)`), 'the holder is named');
    assert.match(log, /set G9_PORT/, 'and the way out is said');
    assert.doesNotMatch(log, /listening on/, 'it never listened anywhere else');
  } finally {
    await new Promise((resolve) => holder.close(resolve));
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

await test('the project file is found by searching upward, not only in the cwd', async () => {
  const runner = await readFile(new URL('../runner/g9.mjs', import.meta.url), 'utf8');

  // FOUND 2026-09-11. loadProject looked in process.cwd() and nowhere else, so
  // running the runner from anywhere but the repository root silently returned
  // null, flowsDir fell back to a cwd-relative default, and the run died with
  // "No AgriPad flows found under <a path that never existed>". Every tool that
  // reads a project file - git, npm, tsc - climbs to the root instead.
  const load = runner.slice(runner.indexOf('async function loadProject'), runner.indexOf('function flowsRoot'));
  assert.match(load, /const parent = path\.dirname\(dir\)/, 'loadProject must climb');
  assert.match(load, /if \(parent === dir\) return null/, 'the climb must stop at the filesystem root');
  assert.match(load, /err\.code !== 'ENOENT'/, 'a malformed file at the right path is an error, not a reason to climb past it');

  // The other half of the same bug: relative paths belong to the file, not the cwd.
  assert.match(runner, /path\.resolve\(project\?\.dir \?\? process\.cwd\(\), configured\)/);
});

/**
 * The runner's selection rules, lifted from runner/g9.mjs and run as code.
 * g9.mjs runs its CLI when imported (and a run starts a daemon), so the
 * functions are taken from its source instead — the real ones, not copies.
 */
async function runnerSelection() {
  const runner = await readFile(new URL('../runner/g9.mjs', import.meta.url), 'utf8');
  const path = (await import('node:path')).default;
  const lifted = liftFunctions(
    runner,
    ['selectFlows', 'loadDeviceFlows', 'requireSelection', 'applySelect', 'readSuite', 'flowsRoot', 'collectJson'],
    { readFile, path },
  );
  return { runner, path, ...lifted };
}

await test('a selector that matches no flow refuses instead of reporting PASS', async () => {
  const { runner, selectFlows, requireSelection } = await runnerSelection();

  // The failure this prevents is silent: 0 flows selected gives failed === 0,
  // verdict PASS and exit 0, which is indistinguishable in every artifact from a
  // suite that really passed. A release gate wired to an empty suite is green
  // forever. Assert the behaviour, not the wording.
  assert.match(runner, /function requireSelection\(chosen, target, all, suite\)/);
  const flows = [
    { id: 'a', name: 'Alpha', tags: ['smoke'] },
    { id: 'b', name: 'Bravo', tags: ['nightly'], suite: 'legacy' },
  ];
  const chosen = [flows[0]];
  assert.equal(requireSelection(chosen, 'tag:smoke', flows, null), chosen, 'a non-empty selection passes through untouched');

  // Every selector that can come up empty refuses, and names what emptied it.
  await assert.rejects(() => selectFlows(flows, 'tag:missing', null, 'here'),
    /"tag:missing" selected 0 of 2 flow\(s\), so there is nothing to run\.\nA suite that matches nothing reports PASS/);
  await assert.rejects(() => selectFlows(flows, 'suite:missing', null, 'here'), /"suite:missing" selected 0 of 2 flow\(s\)/);
  await assert.rejects(() => selectFlows(flows, 'no-such-flow', null, 'here'), /Nothing matched "no-such-flow"/);
  await assert.rejects(() => selectFlows([], 'all', null, 'here'), /There are no flows here/);
  assert.deepEqual((await selectFlows(flows, 'tag:nightly', null, 'here')).map((f) => f.id), ['b']);

  // Both platforms must route through it, or the guard only covers one of them.
  const device = runner.slice(runner.indexOf('async function loadDeviceFlows'));
  assert.match(device.slice(0, 1600), /requireSelection\(/, 'the AgriPad path must use the guard');
  // v2: every browser path (launched engine, extension) selects through selectFlows.
  for (const fn of ['runLaunched', 'runExtension']) {
    const at = runner.indexOf(`async function ${fn}(`);
    assert.ok(at > -1, `${fn}() is missing`);
    assert.match(runner.slice(at, runner.indexOf('\n}\n', at)), /selectFlows\(/, `${fn}() must select through the guarded selectFlows()`);
  }
});

await test('a suite means the same thing on both platforms', async () => {
  const { selectFlows, loadDeviceFlows, path } = await runnerSelection();

  // The device path read QA/Flows/suites/*.json and applied `select`; the browser
  // path only matched a literal `suite` field on the recording. One suite id, two
  // meanings, and a Full-Test that covered different things depending on platform.
  // As behaviour: one suite file, the browser flows and the device flows, the
  // same query applied to both.
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const root = await mkdtemp(path.join(os.tmpdir(), 'g9-suite-'));
  try {
    const project = { dir: root, flowsDir: 'QA/Flows' };
    const lib = path.join(root, 'QA', 'Flows');
    await mkdir(path.join(lib, 'suites'), { recursive: true });
    await mkdir(path.join(lib, 'agripad', 'map'), { recursive: true });
    await writeFile(path.join(lib, 'suites', 'smoke.json'), JSON.stringify({ id: 'smoke', select: { tags: ['smoke'], excludeTags: ['wip'] } }));
    const web = [
      { id: 'w1', name: 'Web one', tags: ['smoke'] },
      { id: 'w2', name: 'Web two', tags: ['smoke', 'wip'] },
      { id: 'w3', name: 'Web three', tags: [], suite: 'smoke' },
      { id: 'w4', name: 'Web four', tags: [], suite: 'legacy' },
    ];
    for (const [id, extra] of [['d1', { tags: ['smoke'] }], ['d2', { tags: ['smoke', 'wip'] }], ['d3', { tags: [], suite: 'smoke' }]]) {
      await writeFile(path.join(lib, 'agripad', 'map', `${id}.flow.json`), JSON.stringify({ id, name: id, ...extra }));
    }
    assert.deepEqual((await selectFlows(web, 'suite:smoke', project, 'web')).map((f) => f.id), ['w1'],
      'the browser path must read the suite file and apply its query');
    assert.deepEqual((await loadDeviceFlows(project, 'suite:smoke')).map((f) => f.id), ['d1'],
      'the device path applies the very same query');
    // A bare suite name (what the desktop's Schedule form sends) means the same.
    assert.deepEqual((await selectFlows(web, 'smoke', project, 'web')).map((f) => f.id), ['w1']);
    // The literal-field match stays as the fallback for a suite with no file,
    // so recordings that predate the suite files keep running.
    assert.deepEqual((await selectFlows(web, 'suite:legacy', project, 'web')).map((f) => f.id), ['w4']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a device readiness timeout is not filed as a product regression', async () => {
  const runner = await readFile(new URL('../runner/g9.mjs', import.meta.url), 'utf8');

  // FOUND LIVE, 2026-09-11. A background GET /api/NewAuth token refresh was in
  // flight when the flow started; quiescence timed out with "still busy: ..." and
  // the run was filed FAIL_PRODUCT. app.busy said idle:true seconds later and the
  // same suite passed. The device path had four alternations inline while the
  // browser had twenty documented patterns and the server ten phrases - one rule,
  // three copies, and this was the drift.
  const block = runner.slice(
    runner.indexOf('const DEVICE_AUTOMATION_FAILURES'),
    runner.indexOf('function verdictForDevice'),
  );
  assert.ok(block, 'the device verdict rule must be a named, reviewable list');

  const patterns = [...block.matchAll(/\/(.+?)\/i,/g)].map(([, body]) => new RegExp(body, 'i'));
  assert.ok(patterns.length >= 10, `expected the full rule, found ${patterns.length} patterns`);
  const classify = (m) => (patterns.some((p) => p.test(m)) ? 'FAIL_AUTOMATION' : 'FAIL_PRODUCT');

  // Both directions. Mislabelling a real regression as "just the test" loses
  // defects, which is the worse of the two mistakes.
  assert.equal(classify('still busy: http:GET /api/NewAuth'), 'FAIL_AUTOMATION');
  assert.equal(classify('"SearchEntry" not found'), 'FAIL_AUTOMATION');
  assert.equal(classify('the device did not answer'), 'FAIL_AUTOMATION');
  assert.equal(classify('expected 96 farms, got 12'), 'FAIL_PRODUCT');
  assert.equal(classify('the server returned 500'), 'FAIL_PRODUCT');
});

await test('the idle oracle waits for quiescence instead of sampling it', async () => {
  const driver = await readFile(new URL('../runner/drivers/agripad.mjs', import.meta.url), 'utf8');

  // FOUND LIVE, 2026-09-11. The oracle called app.busy - an instantaneous snapshot -
  // and failed if anything at all was in flight. agripad.smoke asserts idle as its
  // FIRST step, so a periodic GET /api/NewAuth token refresh (~20s from the emulator)
  // reddened the entire suite depending only on when the run started. Three runs after
  // the fix: 21.5s, 0.6s, 0.6s - all green, the first having simply waited it out.
  const idle = driver.slice(driver.indexOf("case 'idle': {"), driver.indexOf("case 'map': {"));
  assert.match(idle, /ui\.waitIdle/, 'the idle oracle must wait on the same gate every action waits on');
  assert.match(idle, /oracle\.timeoutMs \?\? 30_000/, 'the budget must be overridable per flow');

  // app.busy may still be called, but only AFTER the wait fails, to name what is holding it.
  // Compare CODE, not prose: the comment above the fix names app.busy first, and an
  // earlier test in this very file broke by matching its own explanatory comment.
  const code = idle.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const waitAt = code.indexOf('ui.waitIdle');
  const busyAt = code.indexOf('app.busy');
  assert.ok(waitAt !== -1, 'ui.waitIdle must appear in the code, not only in a comment');
  assert.ok(busyAt === -1 || busyAt > waitAt, 'app.busy must not be what the assertion decides on');
});

await test('a device command budget rides the request root, not the args object', async () => {
  const driver = await readFile(new URL('../runner/drivers/agripad.mjs', import.meta.url), 'utf8');

  // FOUND LIVE, 2026-09-11. QaLocalRequest reads TimeoutMs off the REQUEST ROOT and
  // defaults it to 30000; a "timeoutMs" inside args is never looked at. The server's
  // idle oracle put it in args and silently got the default - an oracle that promises
  // a longer wait and does not take one is a flake waiting to happen. Proven on the
  // device: ui.waitIdle with a root-level 45000 ran 30.3s and returned idle, where the
  // same value inside args had been cut off at exactly 30s.
  const cmd = driver.slice(driver.indexOf('async command('), driver.indexOf('async command(') + 900);
  assert.match(cmd, /timeoutMs,/, 'the driver must send timeoutMs at the request root');

  // And the caller must pass a budget bigger than the wait it is asking the device for,
  // or the transport gives up before the gate it is waiting on.
  const idle = driver.slice(driver.indexOf("case 'idle': {"), driver.indexOf("case 'map': {"));
  assert.match(idle, /\{ timeoutMs: budget \+ 5_000 \}/, 'the transport budget must exceed the wait');
});

await test('a project adapter that still lists workspaceDomains loads cleanly and never forwards them', async () => {
  // v1's bridge validated `workspaceDomains` — and once stripped "*" out of
  // them, turning "allow all" into "allow nothing". v2 has no allowlist (the
  // project adapter moved to daemon/project.js): an adapter that still carries
  // one is simply not consulted for it. No problem is reported for it, nothing
  // of it reaches a client, and everything else in the file keeps working.
  const { loadProject, projectForClient } = await import('../daemon/project.js');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(os.tmpdir(), 'g9-project-'));
  try {
    await mkdir(path.join(root, 'src', 'deep'), { recursive: true });
    await writeFile(path.join(root, 'g9.project.json'), JSON.stringify({
      workspaceDomains: ['*', '*.x.test', 'a.test/path'],
      flowsDir: 'qa/flows',
      defaultEnvironment: 'dev',
      environments: { dev: { baseUrl: 'https://dev.x.test' } },
      secretRefs: ['PASSWORD'],
    }));
    // Found by walking up from where the agent was started, like git finds .git.
    const project = loadProject(path.join(root, 'src', 'deep'), { explicit: null });
    assert.equal(project.found, true);
    assert.deepEqual(project.problems, [], 'an old allowlist is not a problem worth reporting');
    // Relative paths belong to the file, not to the directory it was found from.
    assert.equal(project.flowsDir, path.join(root, 'qa', 'flows').replace(/\\/g, '/'));
    const sent = projectForClient(project);
    assert.equal('workspaceDomains' in sent, false, 'nothing of the allowlist reaches a client');
    assert.equal('secretRefs' in sent, false, 'secret names stay in the daemon');
    assert.equal(sent.defaultEnvironment, 'dev');

    // A broken adapter is a reported problem, never a daemon that will not start.
    await writeFile(path.join(root, 'g9.project.json'), '{ not json');
    const broken = loadProject(root, { explicit: null });
    assert.equal(broken.found, false);
    assert.match(broken.problems[0], /not valid JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('the daemon and the extension agree on one version, read not typed', async () => {
  // FOUND 2026-09-11. VERSION was a hand-typed constant and had drifted eight
  // releases behind package.json, so every "VERSION MISMATCH" the bridge printed
  // was measured against a number nobody maintained — telling people to reload an
  // extension that was already correct. A version announced in two places will be
  // wrong in one of them.
  // v2: every Node component (daemon, shim, runner, engine manager) reads the
  // root package.json through lib/version.mjs; setup/unit/version.test.mjs also
  // holds desktop/package.json to it.
  const { VERSION } = await import('../lib/version.mjs');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version, 'lib/version.mjs must read the root package.json');
  // The two halves ship together, so they must carry the same number.
  assert.equal(
    manifest.version, pkg.version,
    `extension manifest (${manifest.version}) and package.json (${pkg.version}) must match`,
  );
  const daemon = await readFile(new URL('../daemon/daemon.js', import.meta.url), 'utf8');
  assert.match(daemon, /import \{ VERSION[^}]*\} from '\.\.\/lib\/version\.mjs'/, 'the daemon must read its version');
  // And no Node component types its own.
  const { readdir } = await import('node:fs/promises');
  for (const dir of ['daemon', 'mcp', 'runner', 'lib', 'engine', 'bridge/src']) {
    for (const name of await readdir(new URL(`../${dir}/`, import.meta.url))) {
      if (!/\.m?js$/.test(name)) continue;
      const src = await readFile(new URL(`../${dir}/${name}`, import.meta.url), 'utf8');
      assert.doesNotMatch(src, /\b(?:const|let|var)\s+VERSION\s*=\s*['"`]\d/, `${dir}/${name} types its own version`);
    }
  }
});

await test('an interception rule must say what it does, and say it validly', async () => {
  const { normaliseRules } = await import('../extension/tools/netrules.js');

  // A mistyped rule that silently never matches is the worst outcome here: the
  // test passes, the error path was never exercised, and nobody finds out.
  assert.throws(() => normaliseRules([]), /non-empty/);
  assert.throws(() => normaliseRules([{}]), /needs "match"/);
  assert.throws(() => normaliseRules([{ match: '/api' }]), /does nothing/);
  assert.throws(() => normaliseRules([{ match: '/api', status: 999 }]), /not an HTTP status/);
  assert.throws(() => normaliseRules([{ match: '/api', abort: 'Banana' }]), /not a network error/);
  assert.throws(() => normaliseRules([{ match: '/api', status: 500, abort: true }]), /one outcome/);

  const [rule] = normaliseRules([{ match: '/api/farm', method: 'post', status: 500, times: 1, label: 'x' }]);
  assert.equal(rule.method, 'POST', 'the verb is compared upper-case, so it must be stored that way');
  assert.equal(rule.status, 500);
  assert.equal(rule.times, 1);

  // A body with no status is meant as a 200 replacement; making the author say
  // so twice is the kind of ceremony that produces a rule nobody writes.
  const [withBody] = normaliseRules([{ match: '/x', body: '[]' }]);
  assert.equal(withBody.status, 200);

  // "abort: true" is the common case and must mean the generic network failure.
  const [aborted] = normaliseRules([{ match: '/x', abort: true }]);
  assert.equal(aborted.abort, 'Failed');
});

await test('rules are consulted before the pinned HAR, and never hang the tab', async () => {
  const { readFile } = await import('node:fs/promises');
  const netpin = await readFile(new URL('../extension/tools/netpin.js', import.meta.url), 'utf8');

  const handler = netpin.slice(netpin.indexOf('export async function onRequestPaused'));

  // Order matters: the other way round makes a rule unreachable for any request
  // the HAR happens to cover, which is most of them.
  const rulePos = handler.indexOf('netrules.pick');
  const harPos = handler.indexOf('const state = await stateOf(tabId)');
  assert.ok(rulePos > -1 && harPos > -1, 'both paths must be present');
  assert.ok(rulePos < harPos, 'rules must be consulted before the pinned HAR');

  // A paused request that is never answered hangs the page forever, so the rule
  // path must be inside a try with a fall-through.
  assert.match(handler, /try \{[\s\S]*netrules\.pick[\s\S]*\} catch \{/);

  // An injected response must be identifiable as injected.
  assert.match(handler, /x-g9-intercepted/);
});

await test('a download can only be observed if the watch started first', async () => {
  const dl = await readFile(new URL('../extension/tools/downloads.js', import.meta.url), 'utf8');
  const cdpPlatform = await readFile(new URL('../extension/lib/platform-cdp.js', import.meta.url), 'utf8');

  // On a launched engine the whole feature turns on Browser.setDownloadBehavior
  // with events on; without eventsEnabled the progress events never arrive and
  // every wait times out for a reason nobody can see. v2 sends it from
  // platform-cdp on the BROWSER session: in the extension chrome.debugger cannot
  // reach the Browser domain at all (the real-Edge audit, EXT-02), so Engine 1
  // watches chrome.downloads instead.
  assert.match(cdpPlatform, /Browser\.setDownloadBehavior/);
  assert.match(cdpPlatform, /eventsEnabled: true/);
  // Waiting before watching is the mistake this must explain, not just refuse.
  assert.match(dl, /BEFORE the click that starts it/);

  // As behaviour, on the extension's chrome.downloads path, through the same
  // runTool pipeline an agent's call takes.
  resetBrowser();
  await stateModule.setState({ halted: false, currentTabId: null });
  await assert.rejects(
    () => runtime.runTool('browser_network', { action: 'wait_download', tabId: 7, timeoutMs: 300 }),
    /BEFORE the click that starts it/,
  );
  assert.match((await runtime.runTool('browser_network', { action: 'downloads', tabId: 7 })).hint, /BEFORE the click/);

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  const item = (id, patch = {}) => ({
    id,
    url: `http://example.test/export-${id}.csv`,
    referrer: 'http://example.test/',
    startTime: new Date().toISOString(),
    state: 'in_progress',
    filename: `C:\\Users\\qa\\Downloads\\export-${id}.csv`,
    bytesReceived: 0,
    totalBytes: 0,
    fileSize: 0,
    exists: true,
    mime: 'text/csv',
    ...patch,
  });
  // A download that begins while nothing is watched is the person's own, and
  // it is not evidence for anything — even if it finishes after a watch starts.
  downloadItems.set(40, item(40));
  chrome.downloads.onCreated.fire(item(40));
  await settle();

  await runtime.runTool('browser_network', { action: 'watch_downloads', tabId: 7 });
  downloadItems.set(41, item(41));
  chrome.downloads.onCreated.fire(item(41));
  await settle();
  // Both finish, with nothing in them.
  for (const id of [40, 41]) {
    downloadItems.set(id, item(id, { state: 'complete', endTime: new Date().toISOString() }));
    chrome.downloads.onChanged.fire({ id, state: { current: 'complete' } });
  }

  const done = await runtime.runTool('browser_network', { action: 'wait_download', tabId: 7, timeoutMs: 5000 });
  assert.equal(done.state, 'complete');
  assert.equal(done.filename, 'export-41.csv');
  // "empty" is the assertion people actually want, so it is computed rather than
  // left to the caller to derive from two other fields: a finished, zero-byte file.
  assert.equal(done.empty, true);
  const all = await runtime.runTool('browser_network', { action: 'downloads', tabId: 7 });
  assert.deepEqual(all.downloads.map((d) => d.id), ['41'], 'the download that began before the watch is not claimed');
  assert.equal(all.empty, 1);
  await runtime.runTool('browser_network', { action: 'stop_downloads', tabId: 7 });
});

await test('every extension source parses as a real ES module', async () => {
  const { readdir, readFile, writeFile, mkdtemp } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const os = await import('node:os');
  const path = await import('node:path');
  const run = promisify(execFile);

  // FOUND 2026-09-11. An `await` inside a non-async handler made sw.js fail to
  // parse, and `node --check` did NOT catch it: given a .js file it parses as
  // CommonJS, where the enclosing structure differs. The extension then loaded
  // with a DEAD service worker, and the only symptom anywhere was the isolated
  // live test reporting "bridge port null" — a message about configuration, for
  // a syntax error two layers away.
  //
  // Parsing rather than importing, deliberately: importing needs a chrome stub
  // complete enough to survive every listener the worker registers, and a stub
  // that drifts would turn this guard into a source of false failures. Parsing
  // catches the whole class with nothing to maintain.
  const root = new URL('../extension/', import.meta.url);
  const files = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path.join(entry.parentPath ?? entry.path, entry.name));
    }
  }
  assert.ok(files.length > 10, `expected the extension sources, found ${files.length}`);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'g9-parse-'));
  const broken = [];
  try {
    for (const file of files) {
      // .mjs forces MODULE parsing, which is how the browser actually loads these.
      const copy = path.join(dir, path.basename(file).replace(/\.js$/, '') + '.mjs');
      await writeFile(copy, await readFile(file, 'utf8'));
      try {
        await run(process.execPath, ['--check', copy]);
      } catch (err) {
        broken.push(`${path.relative(fileURLToPath(root), file)}: ${String(err.stderr ?? err).split('\n')[1] ?? ''}`.trim());
      }
    }
  } finally {
    // It used to leave one g9-parse-* folder in %TEMP% per run.
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual(broken, [], `these do not parse as ES modules:\n  ${broken.join('\n  ')}`);
});

await test('refusing a browser-internal page says whose rule it is and what to do', async () => {
  // HIT FOR REAL, 2026-09-11. Reloading the extension leaves you standing on
  // edge://extensions, so the very next thing anybody does is press "Attach &
  // Pin" there. The message named the page and stopped, which reads as the tool
  // refusing rather than the browser forbidding — and a user had to ask what the
  // error meant. The two facts that help are whose rule it is, and that
  // switching tabs is the entire fix.
  // v2: pinTab is gone; the panel's Attach (attachTab) is where people hit it.
  resetBrowser();
  browserModel.tabs.set(11, { id: 11, url: 'edge://extensions/', title: 'Extensions', windowId: 1, active: true, status: 'complete' });
  browserModel.tabs.get(9).active = false;
  try {
    await stateModule.setState({ currentTabId: null, halted: false });
    const refusal = await tabsModule.attachTab(null, { clearHalt: true }).then(
      () => assert.fail('attaching edge://extensions must be refused'),
      (err) => err.message,
    );
    assert.match(refusal, /Cannot attach to edge:\/\/extensions — /, 'the page is named the way the address bar shows it');
    assert.match(refusal, /the browser itself does not let any debugger attach/);
    assert.match(refusal, /Switch to the page you want to test/);
    assert.match(refusal, /This is not a setting/, 'say it cannot be turned on, or somebody will look for the switch');
    assert.doesNotMatch(refusal, /Workspace|Pinned|mode/, 'v2 has no modes to send anybody to');
    assert.equal(attachedTabs.has(11), false, 'nothing was attached');
    assert.equal((await stateModule.getState()).currentTabId, null);
  } finally {
    resetBrowser();
  }
});

await test('an internal page is named the way the address bar shows it', async () => {
  // originOf() renders these as "(edge)" because they carry the opaque origin,
  // which tells a reader nothing about the page they are on. And the naive
  // scheme+host join produces "about://blank". An error message that renders
  // its own subject wrongly is one people stop believing.
  const internalName = (url = '') => {
    try {
      const u = new URL(url);
      if (u.host) return `${u.protocol}//${u.host}`;
      return `${u.protocol}${u.pathname}`.replace(/\/+$/, '');
    } catch {
      return '(unknown)';
    }
  };
  assert.equal(internalName('edge://extensions/'), 'edge://extensions');
  assert.equal(internalName('chrome://settings'), 'chrome://settings');
  assert.equal(internalName('about:blank'), 'about:blank');
  assert.equal(internalName('devtools://devtools/bundled/x.html'), 'devtools://devtools');

  const { readFile } = await import('node:fs/promises');
  const tabs = await readFile(new URL('../extension/tools/tabs.js', import.meta.url), 'utf8');
  assert.match(tabs, /function internalName/, 'the helper must exist in the source, not only here');
  assert.match(tabs, /internalName\(tab\.url\)/, 'and the refusal must use it');
});

await test('an assertion waits for its budget, and a dry run still does not', async () => {
  const replay = await readFile(new URL('../extension/tools/replay.js', import.meta.url), 'utf8');

  // FOUND 2026-09-11 writing the first long flow. Assertions ran the instant
  // their turn came and ignored the step's wait budget, so the very first check
  // after a navigation raced the SPA's first paint: page text was still "" and
  // the run reported FAIL_PRODUCT for an app that was merely rendering.
  assert.match(replay, /async function assertWithin\(tabId, step, budgetMs\)/);

  // The real run hands every assertion to assertWithin with the step's budget.
  const runAt = replay.indexOf('async function runStep');
  const run = replay.slice(runAt, replay.indexOf('\n}\n', runAt));
  assert.match(run, /const budgetMs = Math\.round\(\(step\.waitMs \?\? 0\) \* mode\.budget\)/);
  assert.match(run, /if \(step\.type === 'assert'\) return assertWithin\(tabId, step, budgetMs\)/, 'the real run must retry');

  // The dry run must NOT: "resolve everything, change nothing" would become a
  // slow partial execution if it started waiting for assertions to come true.
  const probe = replay.slice(replay.indexOf('async function probe('), replay.indexOf('async function runStep'));
  assert.match(probe, /executeAssertion\(tabId, step\)/, 'dry run calls it directly');
  assert.doesNotMatch(probe, /assertWithin/, 'dry run must not wait');

  // The retry as behaviour, run from replay.js's own source. executeAssertion
  // throws rather than returning ok:false, so the retry must rethrow the LAST
  // real error — a synthetic timeout would hide the cause.
  let calls = 0;
  let passFrom = 3;
  const executeAssertion = async () => {
    calls += 1;
    if (calls < passFrom) throw new Error(`page text is still "" (attempt ${calls})`);
    return { assertion: 'text', matched: 'Tasks' };
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { assertWithin } = liftFunctions(replay, ['assertWithin'], { executeAssertion, sleep });
  assert.deepEqual(await assertWithin(7, {}, 3000), { assertion: 'text', matched: 'Tasks' });
  assert.equal(calls, 3, 'it kept looking until the page caught up');

  calls = 0;
  passFrom = Infinity;
  const started = Date.now();
  await assert.rejects(() => assertWithin(7, {}, 300), (err) => {
    assert.match(err.message, /^page text is still "" \(attempt (\d+)\)$/);
    assert.equal(err.message, `page text is still "" (attempt ${calls})`, 'the LAST real error, not a timeout');
    return true;
  });
  assert.ok(Date.now() - started >= 250, 'it used its budget before giving up');
  // No budget is one look — what a step without a wait asked for.
  calls = 0;
  await assert.rejects(() => assertWithin(7, {}, 0), /attempt 1\)/);
  assert.equal(calls, 1);
});

await test('the long web flow places its checks where they belong', async () => {
  // EXT-16: this used to read a flow from a QA tree OUTSIDE the repository
  // (../../../../QA/Flows/web/tasks/tasks-browse-and-open.flow.json), so any
  // other checkout failed here with ENOENT — and install.ps1 runs this file.
  // The fixture now lives in the repo: a minimal representative FlowSpec with
  // that flow's shape, written by the product's own exporter.
  const raw = (await readFile(new URL('./fixtures/tasks-browse-and-open.flow.json', import.meta.url), 'utf8'))
    .replace(/\r\n/g, '\n');
  const flow = JSON.parse(raw);
  // A FlowSpec the runner and the importer accept, byte for byte canonical — a
  // fixture nothing could produce would test the fixture, not the product.
  assert.deepEqual(flowspec.validateFlowSpec(flow), []);
  assert.equal(raw, flowspec.canonicalJson(flow), 'the fixture is canonical FlowSpec JSON');

  const kinds = flow.steps.map((s) => s.action);
  assert.ok(flow.steps.length >= 15, `a long flow, got ${flow.steps.length} steps`);
  assert.ok(kinds.filter((k) => k === 'assert').length >= 8, 'a long flow earns several checks');

  // The point of the flow: checks are INTERLEAVED, not all appended. If every
  // assertion sat at the end they would all describe the same final moment,
  // which looks thorough and tests less.
  const firstAssert = kinds.indexOf('assert');
  const lastAction = kinds.lastIndexOf('click') > -1 ? kinds.lastIndexOf('click') : 0;
  assert.ok(firstAssert < lastAction, 'at least one check must come before the last interaction');

  // And every check must be allowed to wait, or the one after a navigation
  // races the first paint.
  for (const step of flow.steps.filter((s) => s.action === 'assert')) {
    assert.ok((step.waitBudgetMs ?? 0) > 0, `assertion ${step.id} has no wait budget`);
  }
  // …and that budget survives the import: replay reads it as the step's waitMs.
  for (const step of flowspec.fromFlowSpec(flow).steps.filter((s) => s.type === 'assert')) {
    assert.ok(step.waitMs > 0, `assertion ${step.id} lost its wait budget on import`);
  }
});

await test('a semantic baseline separates live data from structural change', async () => {
  const { readFile } = await import('node:fs/promises');
  const qa = await readFile(new URL('../extension/tools/qa.js', import.meta.url), 'utf8');

  // The rule itself, exercised directly. The function is not exported (nothing
  // outside the assertion has any business calling it), so it is lifted out and
  // evaluated with the one helper it depends on.
  const body = qa.slice(qa.indexOf('function separateDataChurn'), qa.indexOf('async function executeElementAssertion'));
  const separate = new Function('ariaDataKey', `${body}; return separateDataChurn;`)(signature.ariaDataKey);

  // 1. The case that cost seven red runs in a row: a site list where every row
  //    carries a live temperature, humidity and wind speed.
  const before = ['2|option "NL1 A 13 ha -5m 69 2 km/h"', '2|option "NL2 B 9 ha -4m 71 3 km/h"'];
  const after  = ['2|option "NL1 A 13 ha -3m 64 5 km/h"', '2|option "NL2 B 9 ha -2m 66 1 km/h"'];
  const churn = separate(before, after);
  assert.equal(churn.missing.length, 0, 'new readings are not a structural change');
  assert.equal(churn.added.length, 0);
  assert.equal(churn.dataChanges.length, 2, 'and they are reported, not discarded');

  // 2. The case that must still fail: a search box that stopped filtering. Every
  //    row masks to the same shape, so the masked key alone would wave it
  //    through — the multiplicity rule is what catches it.
  const grew = separate(
    ['2|option "NL1 A 13 ha"'],
    ['2|option "NL1 A 13 ha"', '2|option "NL2 B 14 ha"', '2|option "NL3 C 15 ha"'],
  );
  assert.ok(grew.added.length > 0, 'a list that grew is structural, whatever its numbers look like');

  // 3. And a control that genuinely disappeared is never data.
  const gone = separate(['1|button "Save"'], []);
  assert.equal(gone.missing.length, 1);
  assert.equal(gone.dataChanges.length, 0);

  // Depth is structure, not content, so masking must leave it alone.
  assert.ok(signature.ariaDataKey('2|option "x 13"').startsWith('2|'));
  assert.notEqual(signature.ariaDataKey('2|option "x"'), signature.ariaDataKey('3|option "x"'));

  // The assertion has to say when it leaned on this, or a passing run hides it.
  assert.match(qa, /dataChanges: dataChanges\.length/);
  const replaySrc = await readFile(new URL('../extension/tools/replay.js', import.meta.url), 'utf8');
  assert.match(replaySrc, /outcome\.dataChanges/, 'replay reports the churn as a warning');
});

await test('a run you can watch, and a stop that only stops the run', async () => {
  const { readFile } = await import('node:fs/promises');
  const automation = await readFile(new URL('../extension/panel/automation.js', import.meta.url), 'utf8');
  const replaySrc = await readFile(new URL('../extension/tools/replay.js', import.meta.url), 'utf8');

  // The announcement must go out BEFORE the step runs. After it, the bar would
  // only ever move once the slow step everybody is worried about had finished.
  const loop = replaySrc.slice(replaySrc.indexOf('const stepStarted = Date.now();'));
  assert.ok(loop.indexOf('replayProgress') < loop.indexOf('await runStep'),
    'each step is announced before it runs');

  // A replay must not fail because nobody had the panel open. sendMessage
  // rejects when there is no receiver, which is the normal agent-driven case —
  // so it goes through the one helper that already swallows that, rather than a
  // second sender written next to it. v2: that helper is state.js broadcast(),
  // which hands the message to platform.runtime.broadcast — so prove, through
  // the real chain, that a missing receiver is swallowed in both of the ways
  // chrome reports it.
  assert.match(replaySrc, /broadcast\(\{/);
  assert.match(replaySrc, /import \{ broadcast \} from '\.\.\/lib\/state\.js'/);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const originalSend = chrome.runtime.sendMessage;
  try {
    chrome.runtime.sendMessage = () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    stateModule.broadcast({ type: 'replayProgress', index: 1 });
    chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
    stateModule.broadcast({ type: 'replayProgress', index: 2 });
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    chrome.runtime.sendMessage = originalSend;
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, [], 'a broadcast nobody receives must never surface as an error');

  // The live state has to be gone before anything repaints, or an error leaves
  // a stuck bar and a Stop button on a flow that already finished.
  const run = automation.slice(automation.indexOf('async function runReplay'),
                               automation.indexOf('function endRun'));
  assert.doesNotMatch(run, /\}\s*finally\s*\{/,
    'a finally block runs AFTER the return expression, so it cannot be the teardown');
  assert.ok(run.indexOf('endRun()') < run.indexOf('showPanelError'), 'torn down, then reported');

  // Stop means stop THIS RUN. Leaving the agent halted afterwards strands the
  // next person on a panel where nothing works for a reason they cannot see.
  assert.match(automation, /haltedForRun/);
  const end = automation.slice(automation.indexOf('function endRun'));
  assert.match(end, /cmd\(\{ cmd: 'resume' \}\)/, 'the scoped halt is lowered again');

  // And the panel must not own a second copy of the id the debugger button uses.
  const html = await readFile(new URL('../extension/panel/panel.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length,
    `duplicate id in panel.html: getElementById silently returns the first one (${ids.join(', ')})`);
});

await test("the agent's own window is never mistaken for the page under test", async () => {
  const tabs = await readFile(new URL('../extension/tools/tabs.js', import.meta.url), 'utf8');

  // lastFocusedWindow includes the popped-out panel and devtools. Taking it at
  // face value means the agent loses its target the moment somebody clicks the
  // agent's own interface — which is exactly when they are about to use it.
  const active = tabs.slice(tabs.indexOf('export async function getActiveTab'),
                            tabs.indexOf('export async function resolveTarget'));
  assert.match(active, /isAttachable\(tab\.url/, 'an extension page is not the user’s place');
  assert.match(active, /type === 'normal'/, 'only ordinary browser windows count');
  const sw = await readFile(new URL('../extension/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /windows\.onFocusChanged/, 'nothing records focus unless the worker listens');
  assert.match(sw, /rememberFocus\(windowId\)/);

  // As behaviour. Window 1 is the browser, its active tab 8 the page being
  // worked on; window 5 is the popped-out panel, a popup whose only tab is the
  // extension's own page — and it is the window the OS focused last.
  resetBrowser();
  browserModel.tabs.get(9).active = false;
  browserModel.tabs.set(8, { id: 8, url: 'http://example.test/work', title: 'Work', windowId: 1, active: true, status: 'complete' });
  browserModel.windows.get(1).focused = false;
  browserModel.windows.set(5, { id: 5, type: 'popup', state: 'normal', focused: true });
  browserModel.tabs.set(50, { id: 50, url: 'chrome-extension://g9/panel/panel.html', title: 'G9', windowId: 5, active: true, status: 'complete' });
  try {
    await stateModule.setState({ currentTabId: null, sessions: {} });
    // getAll has no ordering, so the last ordinary window has to be remembered as
    // it happens rather than reconstructed afterwards — and remembered somewhere
    // that outlives the service worker (storage.session).
    await tabsModule.rememberFocus(1);
    await tabsModule.rememberFocus(5);
    assert.equal(sessionData.get('g9:lastNormalWindow'), 1, 'focusing the panel window must not overwrite it');
    browserModel.lastFocusedWindow = 5;
    assert.equal((await tabsModule.getActiveTab()).id, 8, 'the panel window is never the page under test');
    assert.equal((await tabsModule.resolveTarget(null, null)).id, 8);

    // And the current tab outranks every guess: it is the user saying "this one"
    // (v1: the pinned tab, consulted before any guess).
    await stateModule.setState({ currentTabId: 7 });
    assert.equal((await tabsModule.resolveTarget(null, null)).id, 7);
  } finally {
    await stateModule.setState({ currentTabId: null });
    resetBrowser();
  }
});

await test("another extension's traffic is not this product's behaviour", () => {
  // The agent drives the user's REAL browser, so whatever else that browser runs
  // shows up in the same capture. Left in, it DOMINATED: a 17-step flow came back
  // with 103 surprises, 8 of them at `fail`, and every one was another extension's
  // asset. A detector whose loudest findings are never about the product is one
  // nobody reads — and the real regression arrives in the middle of that list.
  assert.equal(signature.isProductTraffic('https://dev.acme.example/api/task'), true);
  assert.equal(signature.isProductTraffic('chrome-extension://abc/inject.js'), false);
  assert.equal(signature.isProductTraffic('moz-extension://abc/inject.js'), false);
  assert.equal(signature.isProductTraffic('data:image/png;base64,iVBOR'), false);

  // The same rule has to reach keys ALREADY stored in a known world, or every
  // flow approved before the filter reports those bundles as missing forever —
  // not because the request stopped happening, but because we stopped looking.
  // Asking everyone to re-approve to silence that would be the wrong fix.
  const stale = [
    'GET bbobopahenonfdgjgaleledndnnfhooj/assets/Commands-4785c0d0.js 2xx',
    'GET majdfhpaihoncoakbjgbdhglocklcgno/assets/message-9HKYgmfq.js 2xx',
    'GET image/png;base64,iVBORw0KGgo 2xx',
  ];
  for (const key of stale) {
    assert.equal(signature.isProductOperation(key), false, `should be foreign: ${key}`);
  }

  // And it must not swallow the product. A 32-letter extension id has no dot in
  // it; every real host does — including the map tiles, whose churn is a genuine
  // finding about the app.
  const real = [
    'GET dev.acme.example/api/client/settings 2xx',
    'POST dev.acme.example/api/task 2xx',
    'GET basemap.acme.example/5/ghm/18/12.jpg 0xx',
    'GET cdn.mu.chat/embeds/dist/chatbox/index.js?v 2xx',
  ];
  for (const key of real) {
    assert.equal(signature.isProductOperation(key), true, `should be the product: ${key}`);
  }
});

await test('v3 (C1): the issue index carries severity, tags, site and evidence, and follows the attachments', async () => {
  const store = await import('../extension/lib/store.js');
  const bytes = new TextEncoder().encode('x');
  const issue = await store.saveIssue({
    title: 'Totals wrong', severity: 'high', tags: ['checkout', 7], status: 'open',
    context: { url: 'https://Shop.test:8443/cart?coupon=1', console: { entries: [{ level: 'error', text: 'boom' }] }, failedRequests: [] },
  });
  const entryOf = async (id) => (await store.listIssues()).find((e) => e.id === id);
  let entry = await entryOf(issue.id);
  assert.deepEqual(entry, {
    id: issue.id, title: 'Totals wrong', url: 'https://Shop.test:8443/cart?coupon=1', site: 'https://shop.test:8443', status: 'open',
    severity: 'high', tags: ['checkout'], filedAs: null,
    evidence: { screenshots: 0, videos: 0, files: 0, console: true, network: false, dom: false },
    createdAt: issue.createdAt, updatedAt: issue.updatedAt,
  }, 'the shape of an index entry (v3)');
  // Attachments arrive after the save (tools/issues.js createIssue): the entry follows each one.
  await store.putAttachment({ owner: issue.id, name: 'screenshot.png', mime: 'image/png', kind: 'screenshot', bytes });
  await store.putAttachment({ owner: issue.id, name: 'failed-requests.log', mime: 'text/plain', kind: 'evidence', bytes });
  await store.putAttachment({ owner: issue.id, name: 'page-fragment.html', mime: 'text/html', kind: 'evidence', bytes });
  await store.putAttachment({ owner: issue.id, name: 'page-context.json', mime: 'application/json', kind: 'evidence', bytes });
  const video = await store.putAttachment({ owner: issue.id, name: 'capture.g9frames.json', mime: 'application/json', kind: 'video', bytes });
  await store.putAttachment({ owner: issue.id, name: 'pointer-track.json', mime: 'application/json', kind: 'pointer-track', bytes });
  await store.putAttachment({ owner: issue.id, name: 'repro.csv', mime: 'text/csv', kind: 'file', bytes });
  entry = await entryOf(issue.id);
  assert.deepEqual(entry.evidence, { screenshots: 1, videos: 1, files: 1, console: true, network: true, dom: true });
  await store.deleteAttachment(video.id);
  assert.equal((await entryOf(issue.id)).evidence.videos, 0, 'a removed attachment is uncounted');
  // Defaults for what an issue does not say.
  const plain = await store.saveIssue({ title: 'plain' });
  assert.deepEqual(await entryOf(plain.id), {
    id: plain.id, title: 'plain', url: null, site: null, status: 'open', severity: 'normal', tags: [], filedAs: null,
    evidence: { screenshots: 0, videos: 0, files: 0, console: false, network: false, dom: false },
    createdAt: plain.createdAt, updatedAt: plain.updatedAt,
  });
  // A save moves the entry to the top and keeps the counts.
  await store.saveIssue({ ...(await store.getIssue(issue.id, { withAttachments: false })), status: 'filed', filedAs: 'JIRA-9' });
  const top = (await store.listIssues())[0];
  assert.deepEqual([top.id, top.status, top.filedAs, top.evidence.screenshots], [issue.id, 'filed', 'JIRA-9', 1]);
  // A recording's attachment is not an issue's: the issue index is untouched.
  const before = JSON.stringify(await store.listIssues());
  await store.putAttachment({ owner: 'rec_not_an_issue', name: 'diff.png', mime: 'image/png', kind: 'diff', bytes });
  assert.equal(JSON.stringify(await store.listIssues()), before);
  await store.deleteIssue(issue.id);
  await store.deleteIssue(plain.id);
});

await test('v3 (C1): an issue index written before v3 is completed once, serialized, and never loses an entry', async () => {
  const store = await import('../extension/lib/store.js');
  // A v2 world: records carry severity and tags, the index does not; an attachment is already there.
  localData.set('g9:issue:old-1', {
    id: 'old-1', title: 'Old one', severity: 'critical', tags: ['legacy'], status: 'filed', filedAs: 'JIRA-1',
    context: { url: 'https://old.test/a?b=1', console: { entries: [] }, failedRequests: [{ method: 'GET', url: 'https://old.test/api', status: 500 }] },
    createdAt: 1, updatedAt: 2,
  });
  localData.set('g9:issue:old-2', { id: 'old-2', title: 'No context', status: 'open', createdAt: 3, updatedAt: 4 });
  await platform.blobs.put('blobs', {
    id: 'att_old_shot', owner: 'old-1', name: 'screenshot.png', mime: 'image/png', kind: 'screenshot', size: 1, at: 1, meta: {},
    blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
  });
  localData.set('g9:issues', [
    { id: 'old-2', title: 'No context', url: null, status: 'open', filedAs: null, createdAt: 3, updatedAt: 4 },
    { id: 'gone-1', title: 'Its record was lost', url: 'https://gone.test/x', status: 'open', filedAs: null, createdAt: 2, updatedAt: 2 },
    { id: 'old-1', title: 'Old one', url: 'https://old.test/a?b=1', status: 'filed', filedAs: 'JIRA-1', createdAt: 1, updatedAt: 2 },
  ]);

  // Two lists and a save at once: one backfill, the new issue kept, nothing lost.
  const [first, saved, second] = await Promise.all([
    store.listIssues(), store.saveIssue({ title: 'Filed during the backfill' }), store.listIssues(),
  ]);
  for (const list of [first, second]) {
    assert.deepEqual(list.filter((e) => e.id !== saved.id).map((e) => e.id), ['old-2', 'gone-1', 'old-1'], 'order kept, no entry lost');
    assert.ok(list.every((e) => 'severity' in e), 'every entry complete');
  }
  const stored = localData.get('g9:issues');
  assert.deepEqual(stored.map((e) => e.id).sort(), ['gone-1', 'old-1', 'old-2', saved.id].sort(), 'written back, the new issue included');
  const byId = Object.fromEntries(stored.map((e) => [e.id, e]));
  assert.deepEqual(byId['old-1'], {
    id: 'old-1', title: 'Old one', url: 'https://old.test/a?b=1', site: 'https://old.test', status: 'filed', severity: 'critical',
    tags: ['legacy'], filedAs: 'JIRA-1', evidence: { screenshots: 1, videos: 0, files: 0, console: false, network: true, dom: false },
    createdAt: 1, updatedAt: 2,
  }, 'rebuilt from its record and attachment metadata; its dates unchanged');
  assert.equal(byId['old-2'].severity, 'normal');
  assert.equal(byId['old-2'].site, null);
  assert.deepEqual(byId['gone-1'], {
    id: 'gone-1', title: 'Its record was lost', url: 'https://gone.test/x', site: 'https://gone.test', status: 'open', severity: 'normal',
    tags: [], filedAs: null, evidence: { screenshots: 0, videos: 0, files: 0, console: false, network: false, dom: false },
    createdAt: 2, updatedAt: 2,
  }, 'an entry whose record is gone is kept, with the defaults');

  // Once: a later list writes nothing.
  const realSet = chrome.storage.local.set;
  let indexWrites = 0;
  chrome.storage.local.set = async (values) => {
    if ('g9:issues' in values) indexWrites += 1;
    return realSet(values);
  };
  try {
    await store.listIssues();
    await store.listIssues();
  } finally {
    chrome.storage.local.set = realSet;
  }
  assert.equal(indexWrites, 0, 'the backfill ran once');
  for (const id of ['old-1', 'old-2', 'gone-1', saved.id]) await store.deleteIssue(id);
});

await test('recUpdate stores the TC ids the panel sends, and a start URL only when it is http(s)', async () => {
  // "Covers (TC ids)" said Saved and stored nothing: updateRecording's field list lacked
  // qaTestCaseIds (found by the v3 panel stage). startUrl is new in v3 — a flow's site is
  // the origin of its start URL, so a flow recorded without one needs a way to get it.
  const store = await import('../extension/lib/store.js');
  const saved = await store.saveRecording({ name: 'tc and start', steps: [] });
  try {
    await qa.updateRecording(saved.id, { qaTestCaseIds: ['TC-06-01', 'TC-06-02'] });
    let rec = await store.getRecording(saved.id);
    assert.deepEqual(rec.qaTestCaseIds, ['TC-06-01', 'TC-06-02']);
    const row = (await store.listRecordings()).find((r) => r.id === saved.id);
    assert.deepEqual(row.qaTestCaseIds, ['TC-06-01', 'TC-06-02'], 'the index the panel lists carries them too');

    await qa.updateRecording(saved.id, { startUrl: '  https://admin.example.test/orders?x=1  ' });
    rec = await store.getRecording(saved.id);
    assert.equal(rec.startUrl, 'https://admin.example.test/orders?x=1', 'trimmed and normalised');

    await assert.rejects(qa.updateRecording(saved.id, { startUrl: 'javascript:alert(1)' }), /http\(s\)/);
    await assert.rejects(qa.updateRecording(saved.id, { startUrl: 'not a url' }), /not a URL/);
    rec = await store.getRecording(saved.id);
    assert.equal(rec.startUrl, 'https://admin.example.test/orders?x=1', 'a refused value changes nothing');

    await qa.updateRecording(saved.id, { startUrl: '' });
    rec = await store.getRecording(saved.id);
    assert.equal(rec.startUrl, null, 'an empty value clears it');

    // v3 review, finding 4: a string where a list belongs froze the panel's Automation list.
    await qa.updateRecording(saved.id, { tags: 'smoke, orders ', qaTestCaseIds: 'TC-9' });
    rec = await store.getRecording(saved.id);
    assert.deepEqual(rec.tags, ['smoke', 'orders'], 'a comma string becomes a list');
    assert.deepEqual(rec.qaTestCaseIds, ['TC-9']);
    await assert.rejects(qa.updateRecording(saved.id, { tags: [1, 2] }), /list of strings/);
    await assert.rejects(qa.updateRecording(saved.id, { qaTestCaseIds: { a: 1 } }), /list of strings/);
    await qa.updateRecording(saved.id, { tags: null });
    assert.deepEqual((await store.getRecording(saved.id)).tags, [], 'null clears a list');
  } finally {
    await store.deleteRecording(saved.id);
  }
});

await test('the recording index keeps an environment only as a name, never as an object', async () => {
  // v3 review, finding 7: an environment with variables and no name reached the panel as
  // "[object Object]".
  const store = await import('../extension/lib/store.js');
  const a = await store.saveRecording({ name: 'env object', steps: [], environment: { variables: { a: 1 } } });
  const b = await store.saveRecording({ name: 'env named', steps: [], environment: { name: 'staging', variables: {} } });
  const c = await store.saveRecording({ name: 'env string', steps: [], environment: 'test1' });
  try {
    const rows = await store.listRecordings();
    const envOf = (id) => rows.find((r) => r.id === id)?.environment;
    assert.equal(envOf(a.id), null);
    assert.equal(envOf(b.id), 'staging');
    assert.equal(envOf(c.id), 'test1');
  } finally {
    for (const r of [a, b, c]) await store.deleteRecording(r.id);
  }
});

// ------------------------------------------- 3.1: what a person approved travels with the flow

/** A flow with a screenshot check, an aria check and a human approval — what a QA has after a week. */
async function approvedFlowFixture(store, { id = 'rec_travel', approvedAt = 1_700_000_000_000 } = {}) {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  const att = await store.putAttachment({ owner: id, name: 'baseline-2.png', mime: 'image/png', kind: 'baseline', bytes: png });
  const rec = await store.saveRecording({
    id,
    name: 'Checkout travels',
    folder: 'shop',
    startUrl: 'https://shop.example.test/cart',
    steps: [
      { id: 's1', type: 'navigate', url: 'https://shop.example.test/cart' },
      { id: 's2', type: 'assert', assertion: 'screenshot', baseline: [1, 2, 3], baselineStructure: { cells: [[0, 1]] }, visualMode: 'layout', baselineImageId: att.id },
      { id: 's3', type: 'assert', assertion: 'aria', ariaBaseline: ['button "Pay"', 'heading "Cart"'], maxNodes: 200 },
    ],
    knownWorld: { runs: 2, network: { 'GET /api/cart': 2 }, console: {}, dialogs: {}, steps: { s1: {} }, volatile: [], approvedAt, approvedBy: 'qa' },
    runHistory: [{ at: 5, verdict: 'PASS' }],
  });
  return { rec, png };
}

await test('3.2: push writes the approval and baselines beside the flow; pull on another machine brings them back', async () => {
  const store = await import('../extension/lib/store.js');
  const sync = await import('../extension/lib/flowsync.js');
  const { rec, png } = await approvedFlowFixture(store);
  try {
    await withFlowLibrary(async (library, root, path) => {
      const { readdir } = await import('node:fs/promises');
      // Push, the way sw.js flowPush does it.
      const spec = flowspec.toFlowSpec(rec);
      const w = await library.write(spec);
      const bundle = await sync.approvedBundle(rec.id);
      assert.ok(bundle, 'an approved flow with baselines has a sidecar');
      assert.equal(bundle.approved.knownWorld.approvedBy, 'qa');
      assert.deepEqual(Object.keys(bundle.approved.baselines).sort(), ['s2', 's3']);
      const a = await library.writeApproved(spec.id, bundle.approved, bundle.images);
      assert.equal(a.written, true);
      assert.equal(a.file, w.file.replace('.flow.json', '.approved.json'));
      const dir = path.join(root, w.file.replace('.flow.json', '.baselines'));
      assert.deepEqual(await readdir(dir), ['s2.png']);
      assert.deepEqual(new Uint8Array(await readFile(path.join(dir, 's2.png'))), png, 'the approved screenshot, byte for byte');
      // The sidecar is not a flow: the library still lists one flow, now with its approval time.
      const { flows } = await library.list();
      assert.equal(flows.length, 1);
      assert.equal(flows[0].approvedAt, 1_700_000_000_000);
      assert.equal(flows[0].baselines, 2);
      assert.equal(flows[0].startUrl, 'https://shop.example.test/cart');
      // Writing the same approval again changes no byte.
      assert.equal((await library.writeApproved(spec.id, bundle.approved, bundle.images)).changed, false);

      // "Another machine": this store no longer has the flow.
      await store.deleteRecording(rec.id);
      const side = await library.readApproved(spec.id);
      const pulled = await sync.importFlow(await library.read(spec.id), { approved: side.approved, images: side.images });
      assert.equal(pulled.created, true);
      assert.equal(pulled.knownWorld, 'repo');
      assert.deepEqual(pulled.baselines, { fromRepo: 2, kept: 0 });
      const got = await store.getRecording(pulled.id);
      assert.equal(got.flowId, spec.id);
      assert.deepEqual(got.steps[1].baseline, [1, 2, 3], 'the screenshot check has its fingerprint again');
      assert.deepEqual(got.steps[1].baselineStructure, { cells: [[0, 1]] });
      assert.deepEqual(got.steps[2].ariaBaseline, ['button "Pay"', 'heading "Cart"'], 'the aria check has its expected lines again');
      assert.equal(got.knownWorld.approvedAt, 1_700_000_000_000);
      const image = await store.getAttachment(got.steps[1].baselineImageId);
      assert.equal(image.kind, 'baseline');
      assert.deepEqual(new Uint8Array(Buffer.from(image.dataBase64, 'base64')), png);

      // Pull again: the same flow, not a second copy — and no second copy of its image.
      const before = (await store.listRecordings()).filter((r) => r.flowId === spec.id || r.id === spec.id).length;
      const again = await sync.importFlow(await library.read(spec.id), { approved: side.approved, images: side.images });
      assert.equal(again.created, false);
      assert.equal(again.id, pulled.id);
      assert.equal(again.images, 0, 'an unchanged image is not stored again');
      assert.equal((await store.listRecordings()).filter((r) => r.flowId === spec.id || r.id === spec.id).length, before);
      await store.deleteRecording(pulled.id);

      // Removing the flow removes its approval and baselines too.
      await library.remove(spec.id);
      assert.deepEqual((await readdir(root, { recursive: true })).filter((f) => /approved|baselines/.test(f)), []);
    });
  } finally {
    await store.deleteRecording(rec.id).catch(() => {});
  }
});

await test('3.2: the later human approval wins; a seeded known world and run history never travel', async () => {
  const store = await import('../extension/lib/store.js');
  const sync = await import('../extension/lib/flowsync.js');
  const approvedMod = await import('../extension/lib/approved.js');
  const { rec } = await approvedFlowFixture(store, { id: 'rec_newer', approvedAt: 2_000 });
  try {
    // A known world only a first run seeded was approved by nobody: it does not travel.
    assert.equal(approvedMod.isApproved({ runs: 1, approvedAt: 1, approvedBy: 'seed' }), false);
    const seededOnly = approvedMod.approvedDocFor({ id: 'x', steps: [], knownWorld: { runs: 1, approvedAt: 1, approvedBy: 'seed' } });
    assert.equal(seededOnly, null);

    await withFlowLibrary(async (library) => {
      const spec = flowspec.toFlowSpec(rec);
      await library.write(spec);
      const olderInRepo = (await sync.approvedBundle(rec.id)).approved;
      await library.writeApproved(spec.id, { ...olderInRepo, knownWorld: { ...olderInRepo.knownWorld, approvedAt: 1_000, approvedBy: 'someone else' } }, {});
      // This browser approved later: pull keeps it, says so, and status shows it as newer here.
      const side = await library.readApproved(spec.id);
      const r = await sync.importFlow(await library.read(spec.id), { approved: side.approved, images: side.images });
      assert.equal(r.knownWorld, 'local');
      assert.equal(r.localNewer, true);
      const kept = await store.getRecording(r.id);
      assert.equal(kept.knownWorld.approvedBy, 'qa');
      assert.deepEqual(kept.runHistory, [{ at: 5, verdict: 'PASS' }], 'run history is this machine\'s and stays');
      const status = await library.status([{ id: spec.id, name: spec.name, hash: null, approvedAt: 2_000 }]);
      assert.deepEqual(status.approvalNewerHere.map((f) => f.id), [spec.id]);
      assert.deepEqual(status.approvalNewerInRepo, []);
      // Someone approves later and pushes: the next pull takes theirs.
      await library.writeApproved(spec.id, { ...olderInRepo, knownWorld: { ...olderInRepo.knownWorld, approvedAt: 3_000, approvedBy: 'lead' } }, {});
      const side2 = await library.readApproved(spec.id);
      const r2 = await sync.importFlow(await library.read(spec.id), { approved: side2.approved, images: side2.images });
      assert.equal(r2.knownWorld, 'repo');
      assert.equal((await store.getRecording(r2.id)).knownWorld.approvedBy, 'lead');
    });
  } finally {
    await store.deleteRecording(rec.id).catch(() => {});
  }
});

await test('3.2: a repo flow without a sidecar keeps this browser\'s baselines instead of erasing them', async () => {
  const store = await import('../extension/lib/store.js');
  const sync = await import('../extension/lib/flowsync.js');
  const { rec } = await approvedFlowFixture(store, { id: 'rec_keep' });
  try {
    const r = await sync.importFlow(flowspec.toFlowSpec(rec), { approved: null, images: {} });
    assert.deepEqual(r.baselines, { fromRepo: 0, kept: 2 });
    const got = await store.getRecording(r.id);
    assert.deepEqual(got.steps[1].baseline, [1, 2, 3]);
    assert.deepEqual(got.steps[2].ariaBaseline, ['button "Pay"', 'heading "Cart"']);
    assert.equal(got.steps[1].baselineImageId, rec.steps[1].baselineImageId);
  } finally {
    await store.deleteRecording(rec.id).catch(() => {});
  }
});

await test('3.2: an approval reports what its listener did with the repository, and a failing listener never fails it', async () => {
  const store = await import('../extension/lib/store.js');
  const replayMod = await import('../extension/tools/replay.js');
  const base = {
    id: 'rec_listener', name: 'listener', steps: [{ id: 's1', type: 'navigate', url: 'https://a.test/' }],
    lastRun: { at: 1 }, lastSignature: { network: { 'GET /x': { count: 1 } }, console: {}, ui: {}, steps: [] },
  };
  await store.saveRecording(base);
  const seen = [];
  try {
    replayMod.onApproved(async (id) => { seen.push(id); return { written: true, file: 'web/listener.approved.json' }; });
    const a = await replayMod.approveKnownWorld('rec_listener', { by: 'qa' });
    assert.deepEqual(seen, ['rec_listener']);
    assert.deepEqual(a.repo, { written: true, file: 'web/listener.approved.json' });
    replayMod.onApproved(async () => { throw new Error('disk full'); });
    await store.saveRecording({ ...(await store.getRecording('rec_listener')), lastRun: { at: 2 } });
    const b = await replayMod.approveKnownWorld('rec_listener', { by: 'qa' });
    assert.equal(b.repo.written, false);
    assert.match(b.repo.reason, /disk full/);
    assert.equal((await store.getRecording('rec_listener')).knownWorld.approvedBy, 'qa', 'the approval itself stands');
    // "seed" is what a first run calls itself; a person approving is never recorded as it.
    await replayMod.approveKnownWorld('rec_listener', { by: 'seed' });
    assert.equal((await store.getRecording('rec_listener')).knownWorld.approvedBy, 'operator');
  } finally {
    replayMod.onApproved(null);
    await store.deleteRecording('rec_listener');
  }
});

await test('3.2: import_spec takes the sidecar; export_spec returns it', async () => {
  const store = await import('../extension/lib/store.js');
  const { rec, png } = await approvedFlowFixture(store, { id: 'rec_tool' });
  try {
    const exported = await runtime.runTool('browser_recording', { action: 'export_spec', id: rec.id, includeImages: true });
    assert.equal(exported.approved.knownWorld.approvedBy, 'qa');
    assert.deepEqual(Object.keys(exported.images), ['s2.png']);
    const imported = await runtime.runTool('browser_recording', {
      action: 'import_spec', id: 'rec_tool_copy', spec: exported.spec, approved: exported.approved, images: exported.images,
    });
    assert.equal(imported.id, 'rec_tool_copy');
    assert.equal(imported.knownWorld, 'repo');
    const copy = await store.getRecording('rec_tool_copy');
    assert.deepEqual(copy.steps[2].ariaBaseline, ['button "Pay"', 'heading "Cart"']);
    const image = await store.getAttachment(copy.steps[1].baselineImageId);
    assert.deepEqual(new Uint8Array(Buffer.from(image.dataBase64, 'base64')), png);
    const plain = await runtime.runTool('browser_recording', { action: 'export_spec', id: rec.id });
    assert.deepEqual(plain.imageNames, ['s2.png'], 'without includeImages only the names');
    assert.equal('images' in plain, false);
  } finally {
    await store.deleteRecording(rec.id).catch(() => {});
    await store.deleteRecording('rec_tool_copy').catch(() => {});
  }
});

await test('3.2: the flow library narrows to one site, and "none" means flows with no start URL', async () => {
  const { siteMatches } = await import('../daemon/flows.js');
  assert.equal(siteMatches('https://Shop.example.test/cart?x=1', 'https://shop.example.test'), true);
  assert.equal(siteMatches('https://shop.example.test:8443/', 'https://shop.example.test'), false);
  assert.equal(siteMatches(null, 'none'), true);
  assert.equal(siteMatches('about:blank', 'none'), true);
  assert.equal(siteMatches('https://a.test/', 'none'), false);
  await withFlowLibrary(async (library) => {
    const flow = (id, name, startUrl) => flowspec.toFlowSpec({ id, name, startUrl, steps: [{ id: 's1', type: 'navigate', url: 'https://x.test/' }] });
    await library.write(flow('f1', 'One', 'https://shop.example.test/a'));
    await library.write(flow('f2', 'Two', 'https://admin.example.test/'));
    await library.write(flow('f3', 'Three', null));
    assert.deepEqual((await library.list({ site: 'https://shop.example.test' })).flows.map((f) => f.id), ['f1']);
    assert.deepEqual((await library.list({ site: 'none' })).flows.map((f) => f.id), ['f3']);
    const st = await library.status([], { site: 'https://admin.example.test' });
    assert.deepEqual(st.onlyInRepo.map((f) => f.id), ['f2']);
    assert.equal(st.total, 1);
  });
});

console.log('\n' + passed + ' passed, 0 failed\n');
