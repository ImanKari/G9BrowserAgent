/**
 * Extension-side regression tests with a deliberately asynchronous chrome API
 * stub. No browser is needed; setup/livetest.mjs covers real CDP separately.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sessionData = new Map();
const localData = new Map();
let attached = false;
let failModernNetwork = false;
let failLocale = false;
let failUserAgent = false;
let axNodes = [];

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

globalThis.chrome = {
  storage: { session: storageArea(sessionData), local: storageArea(localData) },
  runtime: {
    sendMessage: async () => {},
    getManifest: () => ({ version: 'test' }),
  },
  tabs: {
    query: async () => [{ id: 9, active: true, url: 'chrome://settings', title: 'Settings', windowId: 1 }],
    get: async (id) => ({ id, url: 'http://example.test/', title: 'Test', windowId: 1 }),
  },
  windows: { update: async () => {} },
  debugger: {
    getTargets: async () => attached ? [{ tabId: 7, attached: true }] : [],
    attach: async () => { attached = true; },
    detach: async () => { attached = false; },
    sendCommand: async (_source, method) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: axNodes };
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

const record = await import('../extension/tools/record.js');
const observe = await import('../extension/tools/observe.js');
const snapshotModule = await import('../extension/tools/snapshot.js');
const emulateModule = await import('../extension/tools/emulate.js');
const tabsModule = await import('../extension/tools/tabs.js');
const qa = await import('../extension/tools/qa.js');
const visual = await import('../extension/lib/visual.js');
const toolsModule = await import('../bridge/src/tools.js');

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed += 1;
    console.log('  PASS ' + name);
  });
}

console.log('\nG9 Browser Agent — extension regression test\n');

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

await test('follow status has no target when the active page is unattachable', async () => {
  assert.equal(await tabsModule.currentTargetId({ mode: 'follow', pinnedTabId: 7 }), null);
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
});

await test('replay, idle, video, and panel regressions retain their invariants', async () => {
  const [issues, panel, replay, navigate, interact] = await Promise.all([
    readFile(new URL('../extension/tools/issues.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/panel/panel.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/tools/replay.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/tools/navigate.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/tools/interact.js', import.meta.url), 'utf8'),
  ]);
  assert.match(issues, /putVideoFrame/);
  assert.doesNotMatch(issues, /session\.frames\.push/);
  assert.match(issues, /Stop the active video capture before deleting this issue/);
  assert.match(issues, /deleteVideoFrames\(session\.sessionId\)/);
  assert.match(panel, /await saveIssueNow/);
  assert.match(panel, /videoStatus/);
  assert.match(replay, /interact\.drag/);
  assert.match(replay, /setReplaying\(tabId, true\)/);
  assert.match(replay, /Checkbox action was issued/);
  assert.match(replay, /recorded target did not observe the expected trusted event/);
  assert.doesNotMatch(replay, /note: 'drag replay uses recorded endpoints'/);
  assert.match(navigate, /status: 'pending', limit: 0[\s\S]*r\.returned/);
  assert.match(navigate, /if \(target < 0 \|\| target >= entries\.length\)[\s\S]*resetPageState/);
  assert.doesNotMatch(interact, /dispatchEvent\(new Event/);
});

console.log('\n' + passed + ' passed, 0 failed\n');
