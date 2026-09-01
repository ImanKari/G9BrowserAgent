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

// ---------------------------------------------------------- v1.4.0 defects

await test('every dispatching interaction witnesses that the page received it', async () => {
  const interact = await readFile(new URL('../extension/tools/interact.js', import.meta.url), 'utf8');

  // The bug: a headed Chromium silently discards Input.dispatch*Event for a
  // page that is not visible, so every action returned a success object for
  // something that never happened. Each dispatching action must now prove the
  // page saw a TRUSTED event, and say why when it did not.
  const bodyOf = (name) => {
    const start = interact.indexOf('export async function ' + name + '(');
    assert.ok(start > -1, name + '() is missing');
    const next = interact.indexOf('\nexport ', start + 10);
    return interact.slice(start, next === -1 ? undefined : next);
  };
  for (const action of ['click', 'hover', 'type', 'key', 'drag']) {
    assert.match(bodyOf(action), /witnessed\(/, action + '() dispatches without witnessing the result');
  }
  // scroll is the exception, and for a reason worth pinning: Chromium may
  // handle wheel entirely on the compositor, so no DOM event arrives even when
  // the scroll worked. It verifies the scroll POSITION instead.
  const scrollBody = bodyOf('scroll');
  assert.doesNotMatch(scrollBody, /witnessed\(/, 'scroll must not witness a wheel event');
  assert.match(scrollBody, /scrollX, y: scrollY/);
  assert.match(scrollBody, /moved/);
  assert.doesNotMatch(interact, /WITNESS_EVENTS = \[[^\]]*'wheel'/);
  assert.match(interact, /document\.visibilityState/);
  assert.match(interact, /explainNoInput/);
  assert.match(interact, /isTrusted/);

  // Arm and read in ONE evaluate. Two calls assume both land in the same
  // execution context, and a single-page app swaps context as its router
  // moves — the listener is gone by the time the counter is read, and a
  // caption that typed perfectly gets reported as a failure. That inverse
  // failure is as damaging as the original: retrying a click posts twice.
  assert.match(interact, /function watchForInput/);
  assert.doesNotMatch(interact, /armWitness|witnessSaw|__g9witness/,
    'the witness must not keep state between separate evaluate calls');
  // An observable outcome outranks any opinion about events.
  assert.match(interact, /verify && \(await verify\(\)/);
  assert.match(interact, /readValue\(tabId, node\.backendNodeId\)\) !== before/);

  // The witness must never be armed inside another witness: arming resets the
  // counter, so a nested one turns a working action into a false failure.
  assert.match(interact, /async function dispatchKey\(/);
  const emitBody = interact.slice(interact.indexOf('const emit = async ()'), interact.indexOf('if (text.length)'));
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

  for (const fn of ['startVideo', 'ingestFrame', 'stopVideo']) {
    const start = issues.indexOf('export async function ' + fn);
    assert.ok(start > -1, fn + ' is missing');
    const next = issues.indexOf('\nexport ', start + 10);
    const body = issues.slice(start, next === -1 ? undefined : next);

    for (const block of [...body.matchAll(/serialize\(async \(\) => (\{)/g)]) {
      const inside = blockAt(body, block.index + block[0].length - 1);
      assert.doesNotMatch(inside, /\bsend(OnLiveSession)?\(tabId/, fn + '() calls CDP inside serialize() — that deadlocks the write chain');
    }
    // …and the CDP call still has to happen somewhere in the function.
    assert.match(body, /\bsend(OnLiveSession)?\(tabId/, fn + '() no longer talks to CDP at all');
  }
  assert.match(issues, /Page\.screencastFrameAck/);

  // The ack must NOT go through send(): its halt check, attach check and
  // getTargets() round trip, paid per frame on the single worker thread,
  // starved the agent's own calls until an ordinary scroll during a recording
  // timed out after 60s. The frame event is itself proof the session is live.
  const ingest = issues.slice(issues.indexOf('export async function ingestFrame'));
  assert.match(ingest, /sendOnLiveSession\(tabId, 'Page\.screencastFrameAck'/);
  const cdp = await readFile(new URL('../extension/lib/cdp.js', import.meta.url), 'utf8');
  assert.match(cdp, /export function sendOnLiveSession/);
  // At most one serialized write per frame path, never across the blob write.
  const ingestBody = ingest.slice(0, ingest.indexOf('\nexport '));
  assert.ok((ingestBody.match(/serialize\(/g) || []).length <= 2,
    'ingestFrame holds the shared write chain more than necessary per frame');
});

await test('connection status does not rewrite durable bridge settings', async () => {
  const { setState, getState } = await import('../extension/lib/state.js');
  localData.clear();
  sessionData.clear();

  // A configured port, as the side panel or the isolated harness would write it.
  await setState({ bridge: { host: '127.0.0.1', port: 55099, token: '' } });
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
  // ws-server.js drops any frame over 64MB AND the connection with it, so an
  // unbounded result does not truncate — it ends the session.
  assert.match(observeSrc, /MAX_HAR_BODY_BYTES/);
  assert.match(observeSrc, /bodiesOmitted/);
  assert.match(inspectSrc, /MAX_TOTAL/);
  assert.match(inspectSrc, /truncated/);
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

await test('version skew between bridge and extension is reported to the agent', async () => {
  const server = await readFile(new URL('../bridge/src/server.js', import.meta.url), 'utf8');
  // Both sides always exchanged a version and neither compared them, while the
  // documented workflow (reload extension, restart client) drifts them routinely.
  assert.match(server, /versionSkew/);
  assert.match(server, /extensionVersion/);
  assert.match(server, /browser_status/);
});

console.log('\n' + passed + ' passed, 0 failed\n');
