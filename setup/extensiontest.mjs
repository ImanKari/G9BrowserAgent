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
  assert.match(issues, /deleteVideoFrames\(session\.sessionId\)/);
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
  // Wheel scrolling settles on the compositor AFTER the command resolves, so
  // reading the position once reported a working scroll as `moved: false`.
  assert.match(scrollBody, /settleBy/);
  assert.match(scrollBody, /if \(moved \|\| Date\.now\(\) >= settleBy\) break;/);
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

await test('the new assertion and network actions are declared in the bridge schema', () => {
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

// ---------------------------------------------------- v1.7.0: workspace mode

await test('an empty workspace allowlist denies everything, never allows everything', async () => {
  const { inWorkspace } = await import('../extension/lib/workspace.js');

  // THE rule. Get this backwards and a missing config file silently hands an
  // agent every tab the user has open, which is the opposite of what the mode
  // is for. It is also exactly the shape a tired refactor reaches for.
  assert.equal(inWorkspace('https://anything.example', []), false);
  assert.equal(inWorkspace('https://anything.example', undefined), false);
  assert.equal(inWorkspace('https://anything.example', null), false);
});

await test('workspace domain matching covers subdomains, ports, and refuses paths', async () => {
  const { inWorkspace } = await import('../extension/lib/workspace.js');
  const { normaliseDomains } = await import('../bridge/src/project.js');

  assert.equal(inWorkspace('https://app.acme.example/x', ['*.acme.example']), true);
  // An apex must match its own wildcard. A QA who allowlists the subdomains and
  // then finds the bare domain refused would rightly call that a bug.
  assert.equal(inWorkspace('https://acme.example/', ['*.acme.example']), true);
  assert.equal(inWorkspace('https://evil-acme.example/', ['*.acme.example']), false);
  assert.equal(inWorkspace('https://mail.google.com/', ['*.acme.example']), false);

  // A pattern with a port pins the port; one without matches any.
  assert.equal(inWorkspace('http://localhost:5173/', ['localhost:5173']), true);
  assert.equal(inWorkspace('http://localhost:5174/', ['localhost:5173']), false);
  assert.equal(inWorkspace('http://localhost:9999/', ['localhost']), true);

  // Never a browser-internal page, whatever the list says — including "*".
  // Chrome will not let any debugger attach to these, so claiming them would be
  // a promise the tool cannot keep.
  assert.equal(inWorkspace('chrome://settings', ['*']), false);
  assert.equal(inWorkspace('devtools://devtools/x', ['*']), false);
  assert.equal(inWorkspace('view-source:https://x.test/', ['*']), false);

  const problems = [];
  // "*" is now a supported entry and must survive; path and URL shapes are still
  // refused, and still reported rather than silently dropped.
  assert.deepEqual(normaliseDomains(['example.com/path', 'https://x.com', '*', 'ok.com'], problems), ['*', 'ok.com']);
  assert.equal(problems.length, 2, 'every refused pattern must be reported, not silently dropped');
});

await test('workspace refusal names the allowlist and both ways out', async () => {
  const { refusalFor } = await import('../extension/lib/workspace.js');

  // "Not allowed" without a remedy is the message that makes people uninstall a
  // tool. Both remedies must appear, and they are different in kind: edit the
  // project file (durable, shared, reviewed) or switch mode (immediate, personal).
  const refusal = refusalFor('https://mail.google.com/', ['*.acme.example'], { projectPath: '/repo/g9.project.json' });
  assert.match(refusal, /mail\.google\.com/);
  assert.match(refusal, /\*\.acme\.example/);
  assert.match(refusal, /workspaceDomains/);
  assert.match(refusal, /Multi-tab/);

  const empty = refusalFor('', [], {});
  assert.match(empty, /no allowlist/i);
  assert.match(empty, /Pinned/);
});

await test('workspace is the default mode and the migration cannot widen access', async () => {
  const state = await readFile(new URL('../extension/lib/state.js', import.meta.url), 'utf8');
  assert.match(state, /mode: 'workspace'/, 'workspace must be the shipped default');
  assert.match(state, /migrateModeDefault/);
  // follow and multi are deliberate choices and must survive the migration.
  assert.match(state, /!settings\.mode \|\| settings\.mode === 'pinned'/);
});

// ------------------------------------------------- v1.7.0: named sessions

await test('every tab-taking tool accepts a session, and browser_tabs does not', () => {
  const withTabId = toolsModule.TOOLS.filter(
    (t) => t.inputSchema?.properties?.tabId && t.name !== 'browser_tabs',
  );
  assert.ok(withTabId.length >= 10, 'expected most tools to take a tabId');
  for (const tool of withTabId) {
    assert.ok(tool.inputSchema.properties.session, `${tool.name} accepts tabId but not session`);
  }
  // browser_tabs uses `name`, not `session`: it MANAGES sessions rather than
  // acting inside one, and accepting both would make "which tab" ambiguous.
  const tabs = toolsModule.TOOLS.find((t) => t.name === 'browser_tabs');
  assert.equal(tabs.inputSchema.properties.session, undefined);
  for (const action of ['session', 'sessions', 'end_session']) {
    assert.ok(tabs.inputSchema.properties.action.enum.includes(action), `browser_tabs is missing "${action}"`);
  }
  // The hidden-tab rule must be in the schema itself. An agent that opens two
  // sessions and clicks into the background one gets nothing, and the tool
  // description is the only place it will read the reason.
  assert.match(tabs.description, /only delivers input to the tab it is SHOWING/i);
});

await test('a session is a name for a tab, never a grant of access to one', async () => {
  const tabs = await readFile(new URL('../extension/tools/tabs.js', import.meta.url), 'utf8');
  // resolveSession must re-check the mode. Without this, naming a tab would be
  // a way around workspace mode: open a session on the user's bank, then drive
  // it by name forever.
  assert.match(tabs, /function resolveSession/);
  assert.match(tabs, /state\.mode === 'workspace' && !isWorkspaceTab\(tab, state\)/);
  // Opening a session goes through the same control check as opening a tab.
  assert.match(tabs, /export async function openSession[\s\S]*requireTabControl\('session', url\)/);
  // Detaching drops sessions, or a name outlives the debugger session it points at.
  assert.match(tabs, /pinnedTabId: null, sessions: \{\}/);
});

await test('workspace tab control checks the URL before the tab exists', async () => {
  const tabs = await readFile(new URL('../extension/tools/tabs.js', import.meta.url), 'utf8');
  const sw = await readFile(new URL('../extension/sw.js', import.meta.url), 'utf8');
  assert.match(tabs, /export async function requireTabControl/);
  // Checking after the fact would mean the tab is already open, and "we opened
  // your bank and then closed it" is not a boundary.
  assert.match(tabs, /Refused before the tab was touched/);
  assert.match(sw, /requireTabControl\(action, urlFor\(action, args\)\)/);
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
    'discoverBridges',
  ]) {
    assert.match(sw, new RegExp(`case '${command}'`), `the panel cannot call ${command}`);
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

await test('the flow library refuses to write local-only run history to the repo', async () => {
  const { relativePathFor } = await import('../bridge/src/flows.js');
  const flows = await readFile(new URL('../bridge/src/flows.js', import.meta.url), 'utf8');

  // Committing run history means every replay dirties the working tree, which
  // trains people to `git checkout .` — and eventually to discard a real edit.
  assert.match(flows, /LOCAL_ONLY = \['runHistory', 'lastRun', 'flaky', 'knownWorld', 'surpriseHistory'\]/);
  assert.match(flows, /for \(const field of LOCAL_ONLY\) delete clean\[field\]/);

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
  const flows = await readFile(new URL('../bridge/src/flows.js', import.meta.url), 'utf8');
  const sw = await readFile(new URL('../extension/sw.js', import.meta.url), 'utf8');
  const flowspec = await readFile(new URL('../extension/lib/flowspec.js', import.meta.url), 'utf8');

  // canonicalJson() is what the extension hashes; `JSON.stringify(x, null, 2)`
  // plus a newline is what the bridge writes AND hashes. If those two strings
  // ever diverge, every flow reports as "differs" and the indicator becomes
  // noise people stop reading.
  assert.match(flowspec, /JSON\.stringify\(canonicalize\(spec\), null, 2\)\}\\n/);
  assert.match(flows, /const serialised = `\$\{JSON\.stringify\(value, null, 2\)\}\\n`/);
  assert.match(flows, /createHash\('sha1'\)/);
  assert.match(sw, /crypto\.subtle\.digest\('SHA-1'/);
  assert.match(sw, /\.slice\(0, 12\)/);
});

await test('the suite is a query, so a forgotten flow cannot silently shrink it', async () => {
  const flows = await readFile(new URL('../bridge/src/flows.js', import.meta.url), 'utf8');
  assert.match(flows, /async resolveSuite/);
  assert.match(flows, /select\.excludeTags/);
  // A hand-maintained array is the failure this exists to prevent: it shrinks
  // the first time somebody forgets, and still reports green.
  assert.match(flows, /A suite is a QUERY, not a list/);
});

await test('bridge discovery scans a bounded range and health identifies each one', async () => {
  const transport = await readFile(new URL('../extension/lib/transport.js', import.meta.url), 'utf8');
  const wsServer = await readFile(new URL('../bridge/src/ws-server.js', import.meta.url), 'utf8');
  const registry = await readFile(new URL('../bridge/src/registry.js', import.meta.url), 'utf8');

  assert.match(transport, /PORT_RANGE = \{ start: 8765, end: 8775 \}/);
  assert.match(registry, /PORT_RANGE_START = 8765/);
  assert.match(registry, /PORT_RANGE_END = 8775/);
  assert.match(transport, /export async function discoverBridges/);
  // The most useful fact in the list: connecting to that bridge displaces
  // whatever browser is already on it.
  assert.match(transport, /extensionConnected/);

  // CORS on /health must stay conditional. A blanket allow-origin would hand a
  // malicious page a way to probe for a bridge and read the project path off
  // it — defeating the Origin check the whole security model rests on.
  assert.match(wsServer, /ALLOWED_ORIGIN\.test\(origin\)/);
  assert.match(wsServer, /access-control-allow-origin/);
  assert.doesNotMatch(wsServer, /'access-control-allow-origin': '\*'/);
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

await test('a workspace refusal never quotes the URL of a tab it is refusing', async () => {
  const tabs = await readFile(new URL('../extension/tools/tabs.js', import.meta.url), 'utf8');
  const { refusalFor } = await import('../extension/lib/workspace.js');

  // FOUND LIVE, 2026-09-10. Naming a tab by id reached requireTabControl with a
  // URL read off the BROWSER, and the refusal echoed it in full — handing back
  // `https://chatgpt.com/c/<conversation-id>` for a tab the agent was being told
  // it may not touch. Titles and URLs are exactly what pinned and workspace mode
  // withhold, so a refusal must not become the way to read them.
  assert.match(tabs, /targets \$\{originOf\(url\)\}/, 'the refusal must redact to an origin');
  assert.doesNotMatch(tabs, /targets \$\{url\}/, 'the refusal must never interpolate a raw URL');

  const refusal = refusalFor('https://mail.example.com/inbox/thread/secret-subject', ['*.ok.test'], {});
  assert.doesNotMatch(refusal, /secret-subject/, 'refusalFor leaked a path');
  assert.doesNotMatch(refusal, /inbox/, 'refusalFor leaked a path');
  assert.match(refusal, /mail\.example\.com/, 'the host is fine — it is the path that is private');

  // An unparseable address is described, never quoted: that fallback is where a
  // redaction is most likely to be skipped and least likely to be noticed.
  const weird = refusalFor('not a url at all', ['*.ok.test'], {});
  assert.doesNotMatch(weird, /not a url at all/);
});

await test('a pinned port is honoured and an unset one is discovered', async () => {
  const server = await readFile(new URL('../bridge/src/server.js', import.meta.url), 'utf8');
  // If the user wrote G9_PORT they typed the same number into the side panel.
  // A bridge that helpfully moved would break the setup they configured.
  assert.match(server, /PORT_PINNED = process\.env\.G9_PORT != null/);
  assert.match(server, /pinned: PORT_PINNED/);
  // Discovery inside listenOrExplain, so a retry after a conflict re-scans.
  assert.match(server, /async function listenOrExplain\(\)[\s\S]*registry\.pickPort/);
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

await test('a selector that matches no flow refuses instead of reporting PASS', async () => {
  const runner = await readFile(new URL('../runner/g9.mjs', import.meta.url), 'utf8');

  // The failure this prevents is silent: 0 flows selected gives failed === 0,
  // verdict PASS and exit 0, which is indistinguishable in every artifact from a
  // suite that really passed. A release gate wired to an empty suite is green
  // forever. Assert the behaviour, not the wording.
  assert.match(runner, /function requireSelection\(chosen, target, all, suite\)/);

  const guard = runner.slice(runner.indexOf('function requireSelection'), runner.indexOf('function applySelect'));
  assert.match(guard, /if \(chosen\.length\) return chosen/, 'a non-empty selection must pass through untouched');
  assert.match(guard, /throw new Error/, 'an empty selection must throw');

  // Both platforms must route through it, or the guard only covers one of them.
  const device = runner.slice(runner.indexOf('async function loadDeviceFlows'));
  assert.match(device.slice(0, 1600), /requireSelection\(/, 'the AgriPad path must use the guard');
  const web = runner.slice(runner.indexOf('async function resolveFlows'));
  assert.match(web.slice(0, 1600), /requireSelection\(/, 'the browser path must use the guard');
});

await test('a suite means the same thing on both platforms', async () => {
  const runner = await readFile(new URL('../runner/g9.mjs', import.meta.url), 'utf8');

  // The device path read QA/Flows/suites/*.json and applied `select`; the browser
  // path only matched a literal `suite` field on the recording. One suite id, two
  // meanings, and a Full-Test that covered different things depending on platform.
  const web = runner.slice(runner.indexOf('async function resolveFlows'), runner.indexOf('async function commandRun('));
  assert.match(web, /readSuite\(flowsRoot\(project\), name\)/, 'the browser path must read the suite file');
  assert.match(web, /applySelect\(recordings, suite\.select/, 'the browser path must apply the query');
  // The literal-field match stays as the fallback, so recordings that predate the
  // suite files keep running.
  assert.match(web, /recordings\.filter\(\(r\) => r\.suite === name\)/);
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

await test('a workspace of ["*"] allows everything, and an empty one still allows nothing', async () => {
  const { inWorkspace, isUnrestricted, refusalFor } = await import('../extension/lib/workspace.js');

  // The two must never converge. An empty list is a misconfiguration; "*" is a
  // decision somebody typed into a reviewed file. Treating silence as consent is
  // the one mistake this module exists to avoid.
  assert.equal(inWorkspace('https://anything.example/x', ['*']), true);
  assert.equal(inWorkspace('https://anything.example/x', []), false);
  assert.equal(isUnrestricted(['*']), true);
  assert.equal(isUnrestricted(['*.example.com']), false);

  // "*" must cover the addresses a host rule cannot describe at all.
  assert.equal(inWorkspace('file:///D:/report.html', ['*']), true);
  assert.equal(inWorkspace('file:///D:/report.html', ['*.example.com']), false);

  // A narrow list keeps behaving exactly as before.
  assert.equal(inWorkspace('https://dev.example.com/a', ['*.example.com']), true);
  assert.equal(inWorkspace('https://evil.test/a', ['*.example.com']), false);

  // With "*" nothing is refused for being outside the workspace, so the refusal
  // must not send the reader off to edit a list that already allows everything.
  const refusal = refusalFor('chrome://settings', ['*'], {});
  assert.doesNotMatch(refusal, /outside this project's workspace/);
  assert.match(refusal, /chrome:\/\//);
});

await test('the bridge does not strip "*" out of the allowlist', async () => {
  const { normaliseDomains } = await import('../bridge/src/project.js');

  // FOUND 2026-09-11, before it could ship. The extension understood "*" and the
  // bridge dropped it as "not host-shaped", so the extension received an EMPTY
  // list — which it correctly reads as deny-everything. A config line saying
  // "allow all" would have meant "allow nothing": the worst way for a rule about
  // permissions to fail.
  assert.deepEqual(normaliseDomains(['*'], []), ['*']);

  // And the hard validation everything else gets must be untouched.
  const problems = [];
  assert.deepEqual(
    normaliseDomains(['*.x.com', 'https://y.com', 'a.com/path', 'localhost:1234'], problems),
    ['*.x.com', 'localhost:1234'],
  );
  assert.equal(problems.length, 2, 'a rejected entry must be reported, never silently dropped');
});

await test('the bridge and the extension agree on one version, read not typed', async () => {
  const { readFile } = await import('node:fs/promises');
  const server = await readFile(new URL('../bridge/src/server.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('../bridge/package.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

  // FOUND 2026-09-11. VERSION was a hand-typed constant and had drifted eight
  // releases behind package.json, so every "VERSION MISMATCH" the bridge printed
  // was measured against a number nobody maintained — telling people to reload an
  // extension that was already correct. A version announced in two places will be
  // wrong in one of them.
  assert.match(server, /const VERSION = readVersion\(\)/, 'the bridge must read its version');
  assert.doesNotMatch(server, /const VERSION = '[\d.]+'/, 'no hand-typed bridge version');

  // The two halves ship together, so they must carry the same number.
  assert.equal(
    manifest.version, pkg.version,
    `extension manifest (${manifest.version}) and bridge package.json (${pkg.version}) must match`,
  );
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
  const { readFile } = await import('node:fs/promises');
  const dl = await readFile(new URL('../extension/tools/downloads.js', import.meta.url), 'utf8');

  // The whole feature turns on Browser.setDownloadBehavior with events on;
  // without eventsEnabled the progress events never arrive and every wait times
  // out for a reason nobody can see.
  assert.match(dl, /Browser\.setDownloadBehavior/);
  assert.match(dl, /eventsEnabled: true/);

  // "empty" is the assertion people actually want, so it is computed rather than
  // left to the caller to derive from two other fields.
  assert.match(dl, /empty: item\.state === 'completed' && !item\.receivedBytes/);

  // Waiting before watching is the mistake this must explain, not just refuse.
  assert.match(dl, /BEFORE the click that starts it/);
});

await test('every extension source parses as a real ES module', async () => {
  const { readdir, readFile, writeFile, mkdtemp } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
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
  for (const file of files) {
    // .mjs forces MODULE parsing, which is how the browser actually loads these.
    const copy = path.join(dir, path.basename(file).replace(/\.js$/, '') + '.mjs');
    await writeFile(copy, await readFile(file, 'utf8'));
    try {
      await run(process.execPath, ['--check', copy]);
    } catch (err) {
      broken.push(`${path.basename(file)}: ${String(err.stderr ?? err).split('\n')[1] ?? ''}`.trim());
    }
  }
  assert.deepEqual(broken, [], `these do not parse as ES modules:\n  ${broken.join('\n  ')}`);
});

await test('refusing a browser-internal page says whose rule it is and what to do', async () => {
  const { readFile } = await import('node:fs/promises');
  const tabs = await readFile(new URL('../extension/tools/tabs.js', import.meta.url), 'utf8');

  // HIT FOR REAL, 2026-09-11. Reloading the extension leaves you standing on
  // edge://extensions, so the very next thing anybody does is press "Attach &
  // Pin" there. The message named the page and stopped, which reads as the tool
  // refusing rather than the browser forbidding — and a user had to ask what the
  // error meant. The two facts that help are whose rule it is, and that
  // switching tabs is the entire fix.
  const guard = tabs.slice(tabs.indexOf('export async function pinTab'), tabs.indexOf('export async function unpinTab'));
  assert.match(guard, /the browser itself does not let any debugger attach/);
  assert.match(guard, /Switch to the page you want to test/);
  assert.match(guard, /Workspace mode you usually do not need to/);
  assert.match(guard, /This is not a setting/, 'say it cannot be turned on, or somebody will look for the switch');
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
  const { readFile } = await import('node:fs/promises');
  const replay = await readFile(new URL('../extension/tools/replay.js', import.meta.url), 'utf8');

  // FOUND 2026-09-11 writing the first long flow. Assertions ran the instant
  // their turn came and ignored the step's wait budget, so the very first check
  // after a navigation raced the SPA's first paint: page text was still "" and
  // the run reported FAIL_PRODUCT for an app that was merely rendering.
  assert.match(replay, /async function assertWithin\(tabId, step, budgetMs\)/);

  const run = replay.slice(replay.indexOf('async function runStep'));
  assert.match(run.slice(0, 400), /assertWithin\(tabId, step, budgetMs\)/, 'the real run must retry');

  // The dry run must NOT: "resolve everything, change nothing" would become a
  // slow partial execution if it started waiting for assertions to come true.
  const probe = replay.slice(replay.indexOf('async function probe('), replay.indexOf('async function runStep'));
  assert.match(probe, /executeAssertion\(tabId, step\)/, 'dry run calls it directly');
  assert.doesNotMatch(probe, /assertWithin/, 'dry run must not wait');

  // executeAssertion throws rather than returning ok:false, so the retry must
  // rethrow the LAST real error — a synthetic timeout would hide the cause.
  const helper = replay.slice(replay.indexOf('async function assertWithin'), replay.indexOf('/** What a dry run does'));
  assert.match(helper, /catch \(err\)/);
  assert.match(helper, /throw err/);
  assert.match(helper, /Date\.now\(\) >= deadline/);
});

await test('the long web flow places its checks where they belong', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(
    new URL('../../../../QA/Flows/web/tasks/tasks-browse-and-open.flow.json', import.meta.url), 'utf8');
  const flow = JSON.parse(raw);

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
  // second sender written next to it.
  assert.match(replaySrc, /broadcast\(\{/);
  const state = await readFile(new URL("../extension/lib/state.js", import.meta.url), "utf8");
  assert.match(state.slice(state.indexOf("export function broadcast")), /catch/);

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
  const { readFile } = await import('node:fs/promises');
  const tabs = await readFile(new URL('../extension/tools/tabs.js', import.meta.url), 'utf8');

  // lastFocusedWindow includes the popped-out panel and devtools. Taking it at
  // face value means the agent loses its target the moment somebody clicks the
  // agent's own interface — which is exactly when they are about to use it.
  const active = tabs.slice(tabs.indexOf('export async function getActiveTab'),
                            tabs.indexOf('/** Is this tab inside'));
  assert.match(active, /isAttachable\(tab\.url/, 'an extension page is not the user\u2019s place');
  assert.match(active, /type === 'normal'/, 'only ordinary browser windows count');

  // getAll has no ordering, so the last ordinary window has to be remembered as
  // it happens rather than reconstructed afterwards — and remembered somewhere
  // that outlives the service worker.
  assert.match(tabs, /export async function rememberFocus/);
  assert.match(tabs, /storage\.session\.set/);
  const sw = await readFile(new URL('../extension/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /windows\.onFocusChanged/, 'nothing records focus unless the worker listens');

  // And a pinned tab outranks every guess: it is the user saying "this one".
  const workspace = tabs.slice(tabs.indexOf('async function resolveWorkspaceTarget'),
                               tabs.indexOf('/** Look up a named session'));
  assert.ok(workspace.indexOf('state.pinnedTabId') < workspace.indexOf('workspace tabs are open'),
    'the pinned tab is consulted before refusing as ambiguous');
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

console.log('\n' + passed + ' passed, 0 failed\n');
