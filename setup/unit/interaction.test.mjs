// Unit tests for input dispatch, the input witness (EXT-01), the cursor track
// and main-world cleanliness (extension/tools/interact.js, lib/humanize.js,
// lib/pointer.js, tools/record.js).
//
// Standalone (ARCHITECTURE_V2 §12.1): node:assert/strict, prints "  PASS <name>"
// per test, exits non-zero on the first failure. No network, no browser, no
// port. globalThis.chrome is the fake browser from world.test.mjs, installed
// before any extension module is imported: every expression G9 sends is
// EXECUTED in a node:vm context standing in for a page world, and every input
// event is delivered to the listeners registered in that frame.
//
//   node setup/unit/interaction.test.mjs

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeBrowser, installChrome, fakeIndexedDB, extUrl, EXT, test } from './world.test.mjs';

const fake = installChrome(createFakeBrowser({ viewport: { width: 1280, height: 800 } }));
// The panel's Input setting is this browser's DEFAULT input level, and its
// Stealth setting (only that one) is also the tab's stealth level, which by
// decision D-b is a floor for a call's `humanize`. The suite starts at "off"
// so that a call naming no level runs direct; the D-b tests below change it
// on purpose.
fake.store.local.set('settings', { inputMode: 'off' });
// Attachments and video frames go to IndexedDB in the extension; every write
// is stamped on the same clock as CDP commands, so order can be asserted.
const writes = [];
globalThis.indexedDB = fakeIndexedDB({ onWrite: (storeName, row) => writes.push({ store: storeName, id: row.id, seq: fake.nextSeq() }) });

const TAB = 11;
const URL0 = 'https://example.test/';
const tab = fake.addTab(TAB, { url: URL0 });
const MAIN = `F${TAB}`;
const frame = tab.frames.get(MAIN);

const BTN = fake.addNode(TAB, { backendNodeId: 101, tag: 'button', box: { x: 100, y: 100, width: 120, height: 40 } });
const FIELD = fake.addNode(TAB, { backendNodeId: 102, tag: 'input', type: 'text', box: { x: 100, y: 200, width: 240, height: 30 } });
const NUMERIC = fake.addNode(TAB, { backendNodeId: 103, tag: 'input', type: 'tel', attrs: { inputmode: 'numeric', pattern: '[0-9]*' }, rejects: /[^0-9]/, box: { x: 100, y: 260, width: 240, height: 30 } });
const SECRET = fake.addNode(TAB, { backendNodeId: 104, tag: 'input', type: 'password', box: { x: 100, y: 320, width: 240, height: 30 } });
const FAR = fake.addNode(TAB, { backendNodeId: 105, tag: 'button', box: { x: 100, y: 1100, width: 120, height: 40 } });
const LINK = fake.addNode(TAB, { backendNodeId: 106, tag: 'a', box: { x: 400, y: 100, width: 80, height: 20 } });
const TARGET = fake.addNode(TAB, { backendNodeId: 107, tag: 'div', box: { x: 700, y: 500, width: 100, height: 100 } });

const interact = await import(extUrl('tools/interact.js'));
const pointer = await import(extUrl('lib/pointer.js'));
const refs = await import(extUrl('lib/refs.js'));
const record = await import(extUrl('tools/record.js'));
const screencast = await import(extUrl('lib/screencast.js'));
const issues = await import(extUrl('tools/issues.js'));
const store = await import(extUrl('lib/store.js'));
const H = await import(extUrl('humanize/index.js'));
const state = await import(extUrl('lib/state.js'));
const { platform } = await import(extUrl('lib/platform.js'));

await refs.saveRefs(TAB, {
  url: URL0,
  entries: [
    ['e1', { backendNodeId: 101, role: 'button', name: 'Save', sessionId: null }],
    ['e2', { backendNodeId: 102, role: 'textbox', name: 'Name', sessionId: null }],
    ['e3', { backendNodeId: 103, role: 'textbox', name: 'Phone', sessionId: null }],
    ['e4', { backendNodeId: 104, role: 'textbox', name: 'Password', sessionId: null }],
    ['e5', { backendNodeId: 105, role: 'button', name: 'Far away', sessionId: null }],
    ['e6', { backendNodeId: 106, role: 'link', name: 'Next', sessionId: null }],
    ['e7', { backendNodeId: 107, role: 'region', name: 'Drop here', sessionId: null }],
  ],
});

const VIEWPORT = { width: 1280, height: 800 };
const since = () => fake.log.length;
const slice = (mark) => fake.log.slice(mark);
const mouseOf = (cmds) => cmds.filter((c) => c.method === 'Input.dispatchMouseEvent');
const keysOf = (cmds) => cmds.filter((c) => c.method === 'Input.dispatchKeyEvent');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JPEG = Buffer.from('not really a jpeg, but bytes').toString('base64');
async function attachmentJson(id) {
  const row = await store.getAttachment(id);
  return JSON.parse(Buffer.from(row.dataBase64, 'base64').toString('utf8'));
}

// ---------------------------------------------------------------- witness

function bareWindow(extra = {}) {
  const listeners = [];
  const win = {
    frames: { length: 0 },
    addEventListener: (type, fn, options) => listeners.push({ type, fn, options }),
    removeEventListener: (type, fn, capture) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && capture === true);
      if (i >= 0) listeners.splice(i, 1);
    },
    ...extra,
  };
  return { win, listeners };
}

await test('witness expression EXECUTES in node:vm with nothing but page globals (EXT-01 regression)', async () => {
  const expr = interact.witnessExpression(['mousedown', 'keydown'], 500);
  assert.ok(!/sessionId/.test(expr), 'no CDP routing identifier inside page code');
  const { win, listeners } = bareWindow();
  // Only what a page has: a window and timers. Any other free identifier throws here.
  const ctx = vm.createContext({ window: win, setTimeout, clearTimeout });
  const promise = vm.runInContext(expr, ctx);
  assert.equal(typeof promise.then, 'function', 'it evaluates to a promise');
  assert.equal(listeners.length, 2);
  assert.ok(listeners.every((l) => l.options.capture === true && l.options.passive === true));
  listeners[0].fn({ isTrusted: false }); // the page's own synthetic event cannot vouch
  listeners[1].fn({ isTrusted: true });
  assert.equal(await promise, true);
  assert.equal(listeners.length, 0, 'every listener removed once settled');
});

await test('witness: after dispatch ended, no event within the grace period is false; listeners removed', async () => {
  const { win, listeners } = bareWindow();
  const ctx = vm.createContext({ window: win, setTimeout, clearTimeout });
  const promise = vm.runInContext(interact.witnessExpression(['mousedown'], 60_000), ctx);
  promise.extend(30, true); // settle(): dispatch is over, the page has 30 ms
  assert.equal(await promise, false);
  assert.equal(listeners.length, 0);
});

await test('witness: the safety ceiling firing DURING dispatch answers "expired", never false (P8 matrix regression)', async () => {
  // Round 2: the in-page ceiling (2 × plan + 5 s) fired while a slow humanized dispatch was still
  // going; the witness settled false, extend() was then ignored, and a click the page HAD received
  // was reported not-delivered after 85 s. The ceiling now says only "I stopped waiting".
  const { win, listeners } = bareWindow();
  const ctx = vm.createContext({ window: win, setTimeout, clearTimeout });
  const promise = vm.runInContext(interact.witnessExpression(['mousedown'], 20), ctx);
  assert.equal(await promise, 'expired');
  assert.equal(listeners.length, 0);
  // extend() after it answered changes nothing.
  promise.extend(10, true);
  assert.equal(await promise, 'expired');
});

/** Arm the page-side witness ON `target` in node:vm, exactly as callInWorld would (`this` = the element). */
function armOn(target, kinds, opts, timeoutMs = 60_000) {
  const bare = bareWindow();
  const ctx = vm.createContext({ window: bare.win, setTimeout, clearTimeout });
  const fn = vm.runInContext(`(${interact.WITNESS_FN})`, ctx);
  return { promise: fn.call(target, kinds, timeoutMs, opts), listeners: bare.listeners };
}

/** A value from the vm realm as a plain object of this realm (deepStrictEqual compares prototypes). */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** A minimal element for the page-side witness: identity, a parent chain, a tag. */
function el(tag, { id = '', parent = null, extra = {} } = {}) {
  return { tagName: tag.toUpperCase(), id, className: '', nodeType: 1, parentNode: parent, getRootNode() { return { host: null }; }, ...extra };
}

await test('witness armed ON an element: a hit is true; an event at another element is {missed}, naming it', async () => {
  // Called with `this` = the element, as callInWorld does.
  const run = (target) => armOn(target, ['pointerdown', 'mousedown'], { targeted: true });
  const button = el('button', { id: 'go' });
  const inner = el('span', { parent: button });
  const spacer = el('div', { id: 'sl-spacer' });

  let w = run(button);
  w.listeners[0].fn({ isTrusted: true, target: inner, composedPath: () => [inner, button], clientX: 5, clientY: 6 });
  assert.equal(await w.promise, true, 'an event inside the element is a hit');

  w = run(button);
  w.listeners[1].fn({ isTrusted: true, target: spacer, composedPath: () => [spacer], clientX: 105.4, clientY: 592 });
  assert.deepEqual(plain(await w.promise), { missed: '<div#sl-spacer>', x: 105, y: 592 }, 'the press landed on the spacer — live round 2, 22/22 CfT runs said "delivered"');
  assert.equal(w.listeners.length, 0);

  // A <label> that forwards activation to the element counts, as checkObscured allows it.
  const input = el('input', { id: 'agree' });
  const label = el('label', { extra: { control: input } });
  w = run(input);
  w.listeners[0].fn({ isTrusted: true, target: label, composedPath: () => [label] });
  assert.equal(await w.promise, true);

  // A synthetic event proves nothing, anywhere.
  w = run(button);
  w.listeners[0].fn({ isTrusted: false, target: button, composedPath: () => [button] });
  w.promise.extend(20, true);
  assert.equal(await w.promise, false);
});

await test('witness: an element the page RE-RENDERED mid-approach is not a miss — it is indeterminate, and named', async () => {
  // A polling list, an innerHTML swap, a list without keys: the press lands on the identical
  // replacement and the page's handler runs, but the armed node is detached. "missed" invited a
  // second click on an action that had happened (interaction review, 2026-09-22).
  const connected = (tag, attrs = {}) => ({
    tagName: tag.toUpperCase(), id: attrs.id ?? '', className: '', nodeType: 1, parentNode: null,
    isConnected: attrs.isConnected !== false,
    textContent: attrs.text ?? '', getAttribute: (n) => attrs[n] ?? null,
    getBoundingClientRect: () => attrs.box ?? { left: 10, top: 20, right: 110, bottom: 60 },
    getRootNode() { return { host: null }; },
  });
  const box = { left: 10, top: 20, right: 110, bottom: 60 };
  const armedGone = connected('button', { id: 'poll', text: 'Poll', isConnected: false, box });
  const replacement = connected('button', { id: 'poll', text: 'Poll', box });
  let w = armOn(armedGone, ['pointerdown', 'mousedown'], { targeted: true });
  w.listeners[0].fn({ isTrusted: true, target: replacement, composedPath: () => [replacement], clientX: 32, clientY: 40 });
  assert.deepEqual(plain(await w.promise), { replaced: true, same: true, hit: '<button#poll>', x: 32, y: 40 });

  // A DIFFERENT element in its place is still a miss — and says the element was re-rendered away.
  const other = connected('button', { id: 'del', text: 'Delete row', box });
  w = armOn(armedGone, ['pointerdown', 'mousedown'], { targeted: true });
  w.listeners[0].fn({ isTrusted: true, target: other, composedPath: () => [other], clientX: 32, clientY: 40 });
  assert.deepEqual(plain(await w.promise), { missed: '<button#del>', replaced: true, x: 32, y: 40 });

  // A target still in the document keeps the old verdict exactly.
  const armedLive = connected('button', { id: 'poll', text: 'Poll', box });
  w = armOn(armedLive, ['pointerdown', 'mousedown'], { targeted: true });
  w.listeners[0].fn({ isTrusted: true, target: other, composedPath: () => [other], clientX: 5, clientY: 6 });
  assert.deepEqual(plain(await w.promise), { missed: '<button#del>', x: 5, y: 6 });
});

await test('witness mode "last" (hover): judged by where the pointer ENDS, not by the first move', async () => {
  const run = (target) => armOn(target, ['pointermove', 'mousemove'], { targeted: true, mode: 'last' });
  const target = el('div', { id: 'hover-me' });
  const h1 = el('h1');
  let w = run(target);
  w.listeners[0].fn({ isTrusted: true, target: h1, composedPath: () => [h1] });   // on the way
  w.listeners[0].fn({ isTrusted: true, target, composedPath: () => [target] });   // arrived
  w.promise.extend(1000, true);
  assert.equal(await w.promise, true, 'crossing other elements on the way is fine; it ended on the target');

  w = run(target);
  w.listeners[0].fn({ isTrusted: true, target, composedPath: () => [target] });
  w.listeners[0].fn({ isTrusted: true, target: h1, composedPath: () => [h1], clientX: 76, clientY: 66 });
  w.promise.extend(20, true);
  assert.deepEqual(plain(await w.promise), { missed: '<h1>', x: 76, y: 66 }, 'the pointer ended over the h1');
});

await test('witness listens in same-process child frames and skips unreachable ones', async () => {
  const same = bareWindow({ document: {} });
  const cross = bareWindow();
  Object.defineProperty(cross.win, 'document', { get() { throw new Error('SecurityError: cross-origin'); } });
  const top = bareWindow({ frames: { length: 2, 0: same.win, 1: cross.win } });
  const ctx = vm.createContext({ window: top.win, setTimeout, clearTimeout });
  const promise = vm.runInContext(interact.witnessExpression(['mousedown'], 500), ctx);
  assert.equal(top.listeners.length, 1);
  assert.equal(same.listeners.length, 1, 'a click inside a same-origin iframe is heard');
  assert.equal(cross.listeners.length, 0, 'a frame in another process is left to its own session');
  same.listeners[0].fn({ isTrusted: true });
  assert.equal(await promise, true);
  assert.equal(top.listeners.length + same.listeners.length, 0);
});

await test('the harness has teeth: v1\'s expression shape throws "sessionId is not defined" here', () => {
  const { win } = bareWindow();
  const ctx = vm.createContext({ window: win, setTimeout, clearTimeout });
  const v1 = 'new Promise((resolve) => { setTimeout(() => resolve(false), 5); }, { sessionId })';
  assert.throws(() => vm.runInContext(v1, ctx), /sessionId is not defined/);
});

// ------------------------------------------------------- humanized click

let clickSent;
let clickPlan;
let clickStartedAt;
await test('humanized click: witness armed in G9\'s world first, then the planned events in order and on schedule', async () => {
  await pointer.setPosition(TAB, 640, 400);
  clickStartedAt = Date.now();
  const mark = since();
  const res = await interact.click(TAB, { ref: 'e1', humanize: 'human', seed: 12345 });
  assert.equal(res.delivery, 'delivered');
  assert.deepEqual(res.humanize, { level: 'human', profile: 'human', seed: 12345 });
  const cmds = slice(mark);

  // Armed ON the button (Runtime.callFunctionOn, `this` = the element in G9's world), for
  // pointerdown OR mousedown: a page that cancels pointerdown gets no mousedown (live round 2).
  const arm = cmds.findIndex((c) => c.method === 'Runtime.callFunctionOn' && /const kinds = /.test(c.params.functionDeclaration));
  const firstInput = cmds.findIndex((c) => c.method === 'Input.dispatchMouseEvent');
  assert.ok(arm >= 0 && arm < firstInput, 'armed before anything is dispatched');
  assert.equal(cmds[arm].world, 'g9');
  assert.equal(cmds[arm].params.awaitPromise, false);
  assert.equal(cmds[arm].params.returnByValue, false);
  assert.deepEqual(cmds[arm].params.arguments[0].value, ['pointerdown', 'mousedown']);
  assert.equal(cmds[arm].params.arguments[2].value.targeted, true, 'the witness knows its element');

  // The same seed, profile and intent reproduce the same plan: compare event for event.
  clickPlan = H.planClick(H.createRng(12345), H.resolveProfile('human'), {
    from: { x: 640, y: 400 }, box: { x: 100, y: 100, width: 120, height: 40 }, viewport: VIEWPORT,
    button: 'left', clickCount: 1, modifiers: 0,
  });
  const planned = clickPlan.steps.filter((s) => s.kind === 'mouse');
  clickSent = mouseOf(cmds);
  // Every sent event IS a planned event, in order. The dispatcher may merge a pointer MOVE into the
  // next one when it is really behind schedule (lib/humanize.js perform, rule 2) — never a press or
  // a release — so the sent list is the plan with at most some moves left out.
  const index = []; // planned index of each sent event
  let j = 0;
  clickSent.forEach((c, i) => {
    while (j < planned.length && !(planned[j].type === c.params.type && planned[j].x === c.params.x && planned[j].y === c.params.y)) {
      assert.equal(planned[j].type, 'mouseMoved', `planned event ${j} (${planned[j].type}) was skipped — only moves may be merged`);
      j += 1;
    }
    assert.ok(j < planned.length, `sent event ${i} (${c.params.type} ${c.params.x},${c.params.y}) is not in the plan`);
    const p = planned[j];
    assert.equal(c.params.buttons, p.buttons);
    assert.equal(c.params.button, p.button);
    assert.equal(c.params.pointerType, 'mouse');
    assert.equal(c.sessionId, null, 'humanized input goes to the page session');
    index.push(j);
    j += 1;
  });
  assert.equal(index.at(-1), planned.length - 1, 'the plan was sent to its end');
  const types = clickSent.map((c) => c.params.type);
  assert.equal(types.filter((t) => t === 'mousePressed').length, 1);
  assert.equal(types.filter((t) => t === 'mouseReleased').length, 1);
  assert.ok(types.indexOf('mousePressed') < types.indexOf('mouseReleased'));
  // The PLAN travels before it presses. How many of those samples are SENT is the machine's business,
  // not the product's: on a saturated machine rule 2 merges the overdue ones and does its job (8 of 67
  // survived here with 32 CPU hogs running) — every merge is justified against rule 2's own threshold
  // below, and the last move before the press is never one of them.
  assert.ok(planned.findIndex((p) => p.type === 'mousePressed') > 3, 'the pointer travelled before pressing');
  assert.equal(index[types.indexOf('mousePressed') - 1], index[types.indexOf('mousePressed')] - 1,
    'the last move before the press is never merged');
  assert.ok(clickSent.slice(0, types.indexOf('mousePressed')).every((c) => c.params.buttons === 0));

  // Timing: never ahead of the plan, and lateness never carried forward.
  //
  // The schedule's origin is perform()'s own t0, taken when it is called — after the witness was
  // armed, which is the last command logged before the first event (measured: 0.6–2 ms before t0).
  // So `arm.t` provably precedes the origin and is the anchor. The first SENT event is not: it
  // absorbs its own lateness into the anchor, and every later event that is less late then looks
  // "early". That is a property of the machine, not of the dispatcher — it is why this assertion
  // used to fail under load, while lib/humanize.js waitFor() cannot return before its deadline.
  const anchor = cmds[arm].t;
  const late = clickSent.map((c, i) => c.t - anchor - planned[index[i]].at);
  late.forEach((ms, i) => {
    assert.ok(ms >= 0, `event ${i} dispatched ${Math.round(-ms)} ms before its due time (${planned[index[i]].at} ms into the plan)`);
  });
  // Rule 2's condition, checked from outside: a move is merged only when the dispatcher is at least
  // MERGE_BEHIND_MS (24) past that move's due time. The merge decision is taken before the next event
  // goes out, so that event's timestamp is a lower bound on how late the dispatcher already was.
  for (let k = 0; k < index.length; k++) {
    for (let s = (k ? index[k - 1] : -1) + 1; s < index[k]; s++) {
      const behind = clickSent[k].t - anchor - planned[s].at;
      assert.ok(behind >= 24, `planned move ${s} was merged while the dispatcher was only ${Math.round(behind)} ms behind (rule 2 needs 24)`);
    }
  }
  // The schedule is absolute, so a slow round trip delays one event without shifting the ones after
  // it: lateness comes back DOWN as soon as the machine lets go. A chain of sleeps adds every round
  // trip to everything that follows, and then late[i] >= late[i-1] by construction — not one event
  // can be less late than the one before it. Zero recoveries is that regression's signature.
  // (Asserting instead that some event late in the plan is back ON its due time would need slack
  // after the machine's worst stall: a 1.2 s stall in a 1.2 s plan leaves none, and that failed for
  // the machine's reason, not the dispatcher's. Skipped when the machine merged the plan down to a
  // handful of events, which costs nothing: on a machine quiet enough to run a unit suite the chained
  // schedule never believes it is behind, rule 2 never fires and all 67 go out — measured 0 of 65
  // recoveries against 18–21 for the code as it stands.)
  const recovered = late.filter((ms, i) => i && ms < late[i - 1] - 1).length;
  if (clickSent.length >= 20) {
    assert.ok(recovered >= 2, `lateness comes back down (only ${recovered} of ${clickSent.length} events were less late than the one before)`);
  }
  const press = types.indexOf('mousePressed');
  const release = types.indexOf('mouseReleased');
  const hold = clickSent[release].t - clickSent[press].t;
  // Rule 1's floor: a decisive step starts no earlier than KEEP_GAP (80 %) of the planned gap after
  // the previous event, however late the dispatcher is (minus 2 ms: `start` is taken just before the
  // send that the log timestamps). The full gap is what an idle machine gives, not what the code promises.
  const plannedHold = planned[index[release]].at - planned[index[press]].at;
  assert.ok(hold >= plannedHold * 0.8 - 2, `held ${Math.round(hold)} ms of a planned ${plannedHold} ms (rule 1 keeps 80 %)`);

  // The witness promise was awaited and released.
  const awaited = cmds.find((c) => c.method === 'Runtime.awaitPromise');
  assert.ok(awaited && fake.released.includes(awaited.params.promiseObjectId));
  assert.equal(res.at.x, Math.round(clickPlan.meta.press.x));
  assert.equal(res.at.y, Math.round(clickPlan.meta.press.y));
});

await test('pointer track: every dispatched mouse event recorded; position persisted at the end', async () => {
  const track = pointer.trackSince(TAB, clickStartedAt);
  assert.equal(track.length, clickSent.length);
  track.forEach((s, i) => {
    assert.equal(s.x, clickSent[i].params.x);
    assert.equal(s.y, clickSent[i].params.y);
    assert.equal(s.type, clickSent[i].params.type);
    assert.equal(s.buttons, clickSent[i].params.buttons);
    if (i) assert.ok(s.at >= track[i - 1].at, 'timestamps never go backwards');
  });
  assert.equal(track.find((s) => s.type === 'mousePressed').buttons, 1);
  const pos = await pointer.position(TAB);
  assert.deepEqual(pos, { x: clickPlan.end.x, y: clickPlan.end.y });
  const stored = fake.store.session.get(`pointer:${TAB}`);
  assert.equal(stored.x, clickPlan.end.x, 'persisted in storage.session, surviving a worker restart');
  const mid = pointer.sampleAt(TAB, track[3].at);
  assert.equal(mid.x, track[3].x);
});

await test('the next humanized action starts where the last one ended (never teleports)', async () => {
  const mark = since();
  const from = clickPlan.end; // where the click left the pointer, persisted by perform()
  const res = await interact.hover(TAB, { ref: 'e7', humanize: 'human', seed: 7 });
  const sent = mouseOf(slice(mark));
  // The path the product must have taken: the same seed and profile, planned FROM THE RESTING POINT.
  // Asserting the first SENT sample instead was a timing assumption — under load the dispatcher merges
  // the first overdue samples away (rule 2), the first one sent is then further along the path, and
  // the check failed for a reason that has nothing to do with teleporting (37 px of the 40 allowed,
  // measured under load). Every sent event being on this path pins the start much harder than a
  // 40 px radius did: a path planned from anywhere else shares no sample with it.
  const hoverPlan = H.planHover(H.createRng(7), H.resolveProfile('human'), {
    from, box: { x: 700, y: 500, width: 100, height: 100 }, viewport: VIEWPORT,
  });
  const hplanned = hoverPlan.steps.filter((s) => s.kind === 'mouse');
  assert.ok(Math.hypot(hplanned[0].x - from.x, hplanned[0].y - from.y) < 40, 'the path starts at the resting point');
  let j = 0;
  sent.forEach((c, i) => {
    while (j < hplanned.length && !(hplanned[j].type === c.params.type && hplanned[j].x === c.params.x && hplanned[j].y === c.params.y)) {
      assert.equal(hplanned[j].type, 'mouseMoved', `planned event ${j} (${hplanned[j].type}) was skipped — only moves may be merged`);
      j += 1;
    }
    assert.ok(j < hplanned.length, `sent event ${i} (${c.params.x},${c.params.y}) is not on the path from the resting point`);
    j += 1;
  });
  assert.equal(j, hplanned.length, 'the path was followed to its end (the last sample is never merged)');
  assert.equal(res.delivery, 'delivered');
  assert.ok(res.pointer.x >= 700 && res.pointer.x <= 800 && res.pointer.y >= 500 && res.pointer.y <= 600);
});

await test('Stop pressed mid-plan aborts promptly, says how far it got, and sends nothing more', async () => {
  await pointer.setPosition(TAB, 1100, 700);
  const mark = since();
  // Stop is pressed once the plan is demonstrably UNDER WAY — after three events have gone out —
  // and promptness is measured from that moment. A fixed 250 ms delay assumed the machine reaches
  // the dispatcher within it: saturated, this host was still measuring the element at 250 ms, Stop
  // then refused the next CDP command instead of interrupting a plan in flight, and the error was
  // the bare "Agent is halted by the user (Stop was pressed)" — a true message about a different
  // moment, which says nothing about how far the plan got.
  let stoppedAt = 0;
  const pressStop = (async () => {
    for (let i = 0; i < 2000 && mouseOf(slice(mark)).length < 3; i++) await sleep(5);
    stoppedAt = Date.now();
    await state.setState({ halted: true }).catch(() => {});
  })();
  try {
    await assert.rejects(interact.click(TAB, { ref: 'e1', humanize: 'human', seed: 4242 }), (err) => {
      assert.match(err.message, /Stop/);
      assert.match(err.message, /input events of this click were sent; the rest were not/);
      return true;
    });
    assert.ok(Date.now() - stoppedAt < 1500, 'stopped promptly after Stop was pressed');
    const sent = mouseOf(slice(mark));
    assert.ok(!sent.some((c) => c.params.type === 'mousePressed'), 'the press never happened');
    const count = sent.length;
    await sleep(300);
    assert.equal(mouseOf(slice(mark)).length, count, 'nothing dispatched after the stop');
    // G9's own witness is ended and let go although Stop is on. send() refuses
    // everything while halted, and the witness stayed armed in G9's world until
    // its safety net, up to 10 minutes (live round 2).
    const after = slice(mark);
    assert.ok(after.some((c) => c.method === 'Runtime.callFunctionOn' && /this\.extend\(ms, ended\)/.test(c.params.functionDeclaration ?? '') &&
      c.params.arguments?.[0]?.value === 0), 'the witness was ended (listeners removed) after Stop');
    assert.ok(after.some((c) => c.method === 'Runtime.releaseObject'), 'the witness handle was released after Stop');
  } finally {
    await pressStop; // never leave the poller behind to press Stop after this test restored it
    await state.setState({ halted: false });
  }
});

// ------------------------------------------------------------ level off

await test('level off reproduces v1\'s click event for event (plus a real mouse\'s pressure on the press)', async () => {
  const mark = since();
  const res = await interact.click(TAB, { ref: 'e1', humanize: 'off' });
  const sent = mouseOf(slice(mark)).map((c) => ({ sessionId: c.sessionId, ...c.params }));
  const at = { x: 160, y: 120 };
  // v1's three events. The one deliberate difference: the press carries force 0.5 — CDP's default
  // of 0 read as pointerdown.pressure 0, an automation tell at every level (live round 2, 50/50).
  assert.deepEqual(sent, [
    { sessionId: null, type: 'mouseMoved', ...at, button: 'none', clickCount: 1, modifiers: 0, buttons: 0, pointerType: 'mouse' },
    { sessionId: null, type: 'mousePressed', ...at, button: 'left', clickCount: 1, modifiers: 0, buttons: 1, pointerType: 'mouse', force: 0.5 },
    { sessionId: null, type: 'mouseReleased', ...at, button: 'left', clickCount: 1, modifiers: 0, buttons: 0, pointerType: 'mouse' },
  ]);
  assert.equal(res.delivery, 'delivered');
  assert.deepEqual(res.humanize, { level: 'off' });
  assert.deepEqual(res.pointer, at);
  // v1 scrolled the element into view first; off keeps that (in G9's world now).
  assert.ok(slice(mark).some((c) => c.method === 'Runtime.callFunctionOn' && /scrollIntoView/.test(c.params.functionDeclaration) && c.world === 'g9'));
});

await test('level off: double click and right click keep v1\'s sequence', async () => {
  let mark = since();
  await interact.click(TAB, { ref: 'e1', humanize: 'off', clickCount: 2 });
  assert.deepEqual(mouseOf(slice(mark)).map((c) => [c.params.type, c.params.clickCount, c.params.buttons]), [
    ['mouseMoved', 1, 0], ['mousePressed', 1, 1], ['mouseReleased', 1, 0], ['mousePressed', 2, 1], ['mouseReleased', 2, 0],
  ]);
  mark = since();
  await interact.click(TAB, { ref: 'e1', humanize: 'off', button: 'right' });
  assert.deepEqual(mouseOf(slice(mark)).map((c) => [c.params.type, c.params.button, c.params.buttons]), [
    ['mouseMoved', 'none', 0], ['mousePressed', 'right', 2], ['mouseReleased', 'right', 0],
  ]);
});

await test('level off: typing and keys are v1\'s events (a shifted symbol has no physical code)', async () => {
  FIELD.value = '';
  const mark = since();
  const res = await interact.type(TAB, { ref: 'e2', text: 'aA!', humanize: 'off', delayMs: 0 });
  assert.equal(res.value, 'aA!');
  assert.equal(res.delivery, 'delivered');
  const keys = keysOf(slice(mark)).map((c) => c.params);
  assert.deepEqual(keys, [
    { type: 'keyDown', text: 'a', key: 'a', unmodifiedText: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
    { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
    { type: 'keyDown', text: 'A', key: 'A', unmodifiedText: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
    { type: 'keyUp', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
    { type: 'keyDown', text: '!', key: '!', unmodifiedText: '!' },
    { type: 'keyUp', key: '!' },
  ]);
  // The click that focused the field was v1's three events.
  assert.deepEqual(mouseOf(slice(mark)).map((c) => c.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);

  let m2 = since();
  await interact.key(TAB, { key: 'Enter', humanize: 'off' });
  assert.deepEqual(keysOf(slice(m2)).map((c) => c.params), [
    { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', modifiers: 0 },
    { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0 },
  ]);
  m2 = since();
  const chord = await interact.key(TAB, { key: 's', modifiers: interact.modifierMask(['Control']), humanize: 'off' });
  assert.deepEqual(keysOf(slice(m2)).map((c) => [c.params.type, c.params.text, c.params.modifiers]), [
    ['rawKeyDown', undefined, 2], ['keyUp', undefined, 2],
  ]);
  assert.equal(chord.delivery, 'delivered');
});

await test('unknown key names are refused with the fix; a chord string is split into key and modifiers', async () => {
  const mark = since();
  await assert.rejects(interact.key(TAB, { key: 'Ctrl+Shit+K', humanize: 'off' }), /Unknown key "Ctrl.Shit.K"/);
  await assert.rejects(interact.key(TAB, { key: 'two words', humanize: 'human' }), /Unknown key/);
  assert.equal(keysOf(slice(mark)).length, 0, 'nothing was dispatched for a key that does not exist');
  const res = await interact.key(TAB, { key: 'Control+s', humanize: 'off' });
  assert.deepEqual(keysOf(slice(mark)).map((c) => [c.params.type, c.params.key, c.params.modifiers]), [
    ['rawKeyDown', 's', 2], ['keyUp', 's', 2],
  ]);
  assert.equal(res.pressed, 's');
  assert.equal(res.modifiers, 2);
});

// --------------------------------------------------------- delivery states

await test('not-delivered: a hidden tab is refused BEFORE anything is sent, for every input action (P8 matrix regression)', async () => {
  // Round 2: on a hidden page the click failed as a wheel stall "while a screencast is running"
  // (none was) and typing as a 120 s "JavaScript dialog" timeout, 30/30 cells; HIDDEN was never
  // reached. Now visibility is asked first, and nothing at all is dispatched.
  tab.hidden = true;
  try {
    const actions = [
      () => interact.click(TAB, { ref: 'e1', humanize: 'off' }),
      () => interact.click(TAB, { ref: 'e5', humanize: 'human', seed: 3 }),
      () => interact.hover(TAB, { ref: 'e1', humanize: 'stealth', seed: 3 }),
      () => interact.type(TAB, { ref: 'e2', text: 'x', humanize: 'human', seed: 3 }),
      () => interact.key(TAB, { key: 'Enter', humanize: 'off' }),
      () => interact.scroll(TAB, { direction: 'down', humanize: 'human', seed: 3 }),
      () => interact.drag(TAB, { from: 'e1', to: 'e7', humanize: 'off' }),
    ];
    for (const act of actions) {
      const mark = since();
      const t0 = performance.now();
      await assert.rejects(act(), (err) => {
        assert.match(err.message, /HIDDEN/);
        assert.match(err.message, /was not sent/);
        assert.equal(err.delivery, 'not-delivered');
        return true;
      });
      const cmds = slice(mark);
      assert.equal(mouseOf(cmds).length + keysOf(cmds).length, 0, 'not one input event was dispatched');
      assert.ok(performance.now() - t0 < 1000, 'answered at once, not after a timeout');
    }
  } finally {
    tab.hidden = false;
  }
});

await test('not-delivered: a tab that becomes hidden as the input goes out is still caught by the witness', async () => {
  tab.hideOnInput = true;
  try {
    await assert.rejects(interact.click(TAB, { ref: 'e1', humanize: 'off' }), (err) => {
      assert.match(err.message, /HIDDEN/);
      assert.match(err.message, /never received it/);
      assert.equal(err.delivery, 'not-delivered');
      // v3 review, finding 6: the flag the side panel's alert keys on. Without it this path gave
      // the hidden-tab sentence with hidden:false on the wire, and no alert.
      assert.equal(err.hidden, true, 'the error is marked hidden, so sw.js raises the agentBlocked alert');
      return true;
    });
  } finally {
    tab.hidden = false;
    tab.hideOnInput = false;
  }
});

await test('partial: a tab hidden PART-WAY through a scroll reports what arrived — never "the page never received it" (P8 matrix, round 3)', async () => {
  // 9/9 hidemid rows: a 2000 px scroll hidden 0.55 s in had delivered 3–6 notches and moved the
  // page 300–600 px, and the report said not-delivered, "the page never received it".
  tab.scrollY = 0;
  tab.wheelsSeen = 0;
  tab.hideAfterWheels = 2;
  tab.hiddenInputHangs = true;
  try {
    await assert.rejects(interact.scroll(TAB, { direction: 'down', amount: 1200, humanize: 'human', seed: 3 }), (err) => {
      assert.equal(err.delivery, 'partial');
      assert.equal(err.hidden, true);
      assert.ok(err.sent >= 2 && err.of > err.sent, `sent ${err.sent} of ${err.of}`);
      assert.equal(err.scrolled?.dy, tab.scrollY, 'the movement it names is the page\'s own');
      assert.ok(tab.scrollY > 0);
      assert.match(err.message, new RegExp(`The page scrolled ${tab.scrollY} px down`));
      assert.match(err.message, /may arrive when the tab is shown again/);
      assert.match(err.message, /browser_tabs action:"focus"/, 'the remedy the agent can apply itself');
      assert.doesNotMatch(err.message, /never received|Ask the user|headed Chromium/);
      return true;
    });
  } finally {
    tab.hidden = false;
    tab.hideAfterWheels = 0;
    tab.hiddenInputHangs = false;
    tab.scrollY = 0;
  }
});

await test('a click hidden while its target is scrolled into view is a click NOT made — and says the page scrolled', async () => {
  // P8 matrix, round 3: "The scroll wheel was dispatched but the page never received it" (7/9) for
  // a click whose bring-into-view had partly landed.
  tab.scrollY = 0;
  tab.wheelsSeen = 0;
  tab.hideAfterWheels = 1;
  tab.hiddenInputHangs = true;
  const mark = since();
  try {
    await assert.rejects(interact.click(TAB, { ref: 'e5', humanize: 'human', seed: 4 }), (err) => {
      assert.equal(err.delivery, 'not-delivered', 'no button went down');
      assert.equal(err.hidden, true);
      assert.match(err.message, /The click was not made — no mouse button was pressed/);
      assert.match(err.message, /The page scrolled \d+ px down/);
      assert.doesNotMatch(err.message, /scroll wheel was dispatched/);
      return true;
    });
    assert.equal(mouseOf(slice(mark)).filter((c) => c.params.type === 'mousePressed').length, 0, 'indeed no press');
  } finally {
    tab.hidden = false;
    tab.hideAfterWheels = 0;
    tab.hiddenInputHangs = false;
    tab.scrollY = 0;
  }
});

await test('the hidden-tab refusal names the remedies the agent has (focus, popout, handoff) and the true physics', async () => {
  // Live round 3: it said "Ask the user … A headed Chromium silently discards CDP input" for a
  // HEADLESS tab, while browser_tabs action:"focus" then delivered the same click (measured). And key
  // events DO reach a hidden page (P8 matrix, round 3) — refusing them is G9's policy.
  tab.hidden = true;
  try {
    await assert.rejects(interact.key(TAB, { key: 'Enter', humanize: 'off' }), (err) => {
      assert.match(err.message, /browser_tabs action:"focus"/);
      assert.match(err.message, /"popout"/);
      assert.match(err.message, /"handoff"/);
      assert.match(err.message, /pointer or wheel input/);
      assert.match(err.message, /key events would reach it/);
      assert.doesNotMatch(err.message, /Ask the user|headed Chromium|silently discards CDP input/);
      return true;
    });
  } finally {
    tab.hidden = false;
  }
});

await test('the delivery state leads the message a tool call returns: [delivery: …] (live round 3)', async () => {
  // Every relay keeps only the message; interact's err.delivery used to be lost on the way.
  const tools = await import(extUrl('tools/index.js'));
  const tag = (fields, text = 'x') => tools.tagDelivery(Object.assign(new Error(text), fields)).message;
  assert.equal(tag({ delivery: 'missed', hit: '<div#veil>' }), '[delivery: missed; hit <div#veil>] x');
  assert.equal(tag({ delivery: 'not-delivered', hidden: true }), '[delivery: not-delivered; tab hidden] x');
  assert.equal(tag({ delivery: 'partial', hidden: true, sent: 3, of: 12 }), '[delivery: partial; 3 of 12 input events sent; tab hidden] x');
  assert.equal(tag({}), 'x', 'an error without a delivery state is untouched');
  assert.equal(tag({ delivery: 'missed' }, '[delivery: missed] y'), '[delivery: missed] y', 'never tagged twice');
  tab.hidden = true;
  try {
    await assert.rejects(tools.runTool('browser_interact', { action: 'click', ref: 'e1', tabId: TAB, humanize: 'off' }), (err) => {
      assert.match(err.message, /^\[delivery: not-delivered; tab hidden\] The click was not sent/);
      assert.equal(err.delivery, 'not-delivered');
      return true;
    });
  } finally {
    tab.hidden = false;
  }
});

await test('pointerdown cancelled by the page: the click is DELIVERED (pointerdown/pointerup/click arrive, no mousedown)', async () => {
  // Live round 2, 22/22 runs: the page's own listener called preventDefault on pointerdown, so the
  // compatibility mousedown/mouseup never fired, and a witness that waited for mousedown alone threw
  // "never received a trusted event" for a click the page had received. An agent told that clicks again.
  const PD = fake.addNode(TAB, { backendNodeId: 120, tag: 'button', attrs: { id: 'sl-pd' }, box: { x: 500, y: 100, width: 120, height: 40 }, cancelsPointerdown: true });
  await refs.saveRefs(TAB, { url: URL0, entries: [...Object.entries((await refs.getRefs(TAB)).map), ['e20', { backendNodeId: 120, role: 'button', name: 'Press area', sessionId: null }]] });
  // The fake suppresses mousedown/mouseup for this node exactly as Chromium does.
  for (const level of ['off', 'human', 'stealth']) {
    const res = await interact.click(TAB, { ref: 'e20', humanize: level, seed: 5 });
    assert.equal(res.delivery, 'delivered', level);
  }
  tab.nodes.delete(PD.backendNodeId);
});

await test('missed: a press that lands on ANOTHER element is reported as such, never as delivered, and not repeated', async () => {
  // Live round 2: after a scroll the press went to #sl-spacer, and the result said "delivered"
  // (22/22 CfT runs). The witness is now armed on the element itself.
  const COVER = fake.addNode(TAB, { backendNodeId: 121, tag: 'div', attrs: { id: 'cover' }, box: { x: 90, y: 90, width: 140, height: 60 }, z: 10 });
  try {
    for (const level of ['off', 'human']) {
      const mark = since();
      await assert.rejects(interact.click(TAB, { ref: 'e1', humanize: level, force: true, seed: 8 }), (err) => {
        assert.equal(err.delivery, 'missed', level);
        assert.match(err.message, /landed on <div#cover>/);
        assert.match(err.message, /NOT repeated/);
        return true;
      });
      assert.equal(mouseOf(slice(mark)).filter((c) => c.params.type === 'mousePressed').length, 1, 'exactly one press');
    }
    // A hover that ends over the cover says so too.
    await assert.rejects(interact.hover(TAB, { ref: 'e1', humanize: 'human', seed: 8 }), (err) => {
      assert.equal(err.delivery, 'missed');
      assert.match(err.message, /pointer ended over <div#cover>/);
      return true;
    });
  } finally {
    tab.nodes.delete(121);
    void COVER;
  }
  // Without the cover the same actions are delivered.
  assert.equal((await interact.click(TAB, { ref: 'e1', humanize: 'human', seed: 8 })).delivery, 'delivered');
  assert.equal((await interact.hover(TAB, { ref: 'e1', humanize: 'human', seed: 8 })).delivery, 'delivered');
});

await test('an element that MOVED after it was measured is reported as moved — not as covered by its container, no force:true advice', async () => {
  // Live round 3 (1/9 runs): a button that ran from the pointer was refused as "covered by its
  // ancestor <div#e2RunTrack>, which paints something over it … pass force:true" — there was no overlay.
  const TRACK = fake.addNode(TAB, { backendNodeId: 130, tag: 'div', attrs: { id: 'track' }, box: { x: 600, y: 600, width: 400, height: 100 }, z: 0 });
  const RUN = fake.addNode(TAB, { backendNodeId: 131, tag: 'button', attrs: { id: 'run' }, box: { x: 620, y: 620, width: 80, height: 40 }, z: 1 });
  await refs.saveRefs(TAB, { url: URL0, entries: [...Object.entries((await refs.getRefs(TAB)).map), ['e31', { backendNodeId: 131, role: 'button', name: 'Runaway', sessionId: null }]] });
  try {
    RUN.moveAfterMeasure = { x: 900 };
    const mark = since();
    await assert.rejects(interact.click(TAB, { ref: 'e31', humanize: 'off' }), (err) => {
      assert.match(err.message, /"Runaway" is no longer where G9 measured it: it moved/);
      assert.match(err.message, /nothing was pressed/);
      assert.doesNotMatch(err.message, /covered by|force:true|overlay/);
      return true;
    });
    assert.equal(mouseOf(slice(mark)).filter((c) => c.params.type === 'mousePressed').length, 0, 'nothing was pressed');
    // A real overlay is still named as one.
    RUN.box = { x: 620, y: 620, width: 80, height: 40 };
    const COVER = fake.addNode(TAB, { backendNodeId: 132, tag: 'div', attrs: { id: 'veil' }, box: { x: 610, y: 610, width: 120, height: 60 }, z: 5 });
    await assert.rejects(interact.click(TAB, { ref: 'e31', humanize: 'off' }), /covered by <div#veil>.*force:true/s);
    tab.nodes.delete(COVER.backendNodeId);
  } finally {
    tab.nodes.delete(TRACK.backendNodeId);
    tab.nodes.delete(RUN.backendNodeId);
  }
});

await test('pressure: a held button presses with 0.5 (a real mouse), never CDP\'s default 0; no button, no pressure', async () => {
  // Live round 2: pointerdown.pressure was 0 in 50/50 runs.
  for (const level of ['off', 'human']) {
    const mark = since();
    await interact.click(TAB, { ref: 'e1', humanize: level, seed: 21 });
    const mouse = mouseOf(slice(mark));
    const presses = mouse.filter((c) => c.params.type === 'mousePressed');
    assert.ok(presses.length >= 1);
    assert.ok(presses.every((c) => c.params.force === 0.5), `${level}: press force 0.5`);
    assert.ok(mouse.filter((c) => c.params.type === 'mouseReleased').every((c) => c.params.force === undefined), `${level}: release carries no pressure`);
    assert.ok(mouse.filter((c) => c.params.type === 'mouseMoved' && !c.params.buttons).every((c) => c.params.force === undefined), `${level}: a hovering move has no pressure`);
  }
  // A drag's moves hold the button: pressure while held.
  const mark = since();
  await interact.drag(TAB, { from: 'e1', to: 'e7', humanize: 'human', seed: 22 });
  const held = mouseOf(slice(mark)).filter((c) => c.params.type === 'mouseMoved' && c.params.buttons);
  assert.ok(held.length >= 1 && held.every((c) => c.params.force === 0.5));
});

await test('indeterminate: a click that navigates is reported, and NEVER repeated', async () => {
  LINK.navigatesOnPress = true;
  const mark = since();
  const res = await interact.click(TAB, { ref: 'e6', humanize: 'off' });
  assert.equal(res.delivery, 'indeterminate');
  assert.match(res.deliveryNote, /NOT repeated/);
  assert.equal(mouseOf(slice(mark)).filter((c) => c.params.type === 'mousePressed').length, 1);
  await refs.saveRefs(TAB, { url: URL0, entries: Object.entries((await refs.getRefs(TAB)).map) });
});

await test('an arming failure is an ERROR and nothing is dispatched', async () => {
  tab.breakWitness = true;
  const mark = since();
  try {
    await assert.rejects(interact.click(TAB, { ref: 'e1', humanize: 'off' }), /Could not arm the input witness, so nothing was dispatched/);
    assert.equal(mouseOf(slice(mark)).length, 0);
  } finally {
    tab.breakWitness = false;
  }
});

await test('repeated actions leak neither listeners nor remote objects', async () => {
  for (let i = 0; i < 3; i++) await interact.click(TAB, { ref: 'e1', humanize: 'off' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(frame.listeners.filter((l) => l.ctx.alive).length, 0, 'no listener left behind');
  const awaited = fake.calls('Runtime.awaitPromise').map((c) => c.params.promiseObjectId);
  assert.ok(awaited.length >= 3);
  assert.ok(awaited.every((id) => fake.released.includes(id)), 'every witness promise released');
  const resolved = fake.log.filter((c) => c.method === 'DOM.resolveNode').length;
  const releasedNodes = fake.log.filter((c) => c.method === 'Runtime.releaseObject').length;
  assert.ok(releasedNodes >= resolved, 'every node handle released');
});

// ------------------------------------------------------ scrolling / stealth

await test('stealth refuses a programmatic scroll: the wheel is tried, scrollIntoView never', async () => {
  tab.wheelScrolls = false;
  tab.scrollY = 0;
  await pointer.setPosition(TAB, 640, 400);
  const mark = since();
  try {
    await assert.rejects(
      interact.click(TAB, { ref: 'e5', humanize: 'stealth', seed: 99 }),
      /does not fall back to a programmatic scroll/,
    );
    const cmds = slice(mark);
    assert.ok(mouseOf(cmds).some((c) => c.params.type === 'mouseWheel'), 'wheel notches were dispatched');
    assert.ok(!cmds.some((c) => c.method === 'Runtime.callFunctionOn' && /scrollIntoView/.test(c.params.functionDeclaration)));
    assert.ok(!cmds.some((c) => c.method === 'Runtime.evaluate' && /scroll(To|By)\(/.test(c.params.expression)));
    assert.equal(FAR.scrolledIntoView, undefined);
    assert.ok(!mouseOf(cmds).some((c) => c.params.type === 'mousePressed'), 'nothing was clicked');
  } finally {
    tab.wheelScrolls = true;
  }
});

await test('human falls back to a programmatic scroll only when the wheel cannot get there, and says so', async () => {
  tab.wheelScrolls = false;
  tab.scrollY = 0;
  try {
    const res = await interact.click(TAB, { ref: 'e5', humanize: 'human', seed: 99 });
    assert.equal(res.scrolled.via, 'programmatic');
    assert.match(res.scrolled.note, /programmatically/);
    assert.equal(FAR.scrolledIntoView, 1);
    assert.equal(res.delivery, 'delivered');
  } finally {
    tab.wheelScrolls = true;
    tab.scrollY = 0;
    FAR.scrolledIntoView = undefined;
  }
});

await test('a hidden tab during a wheel reach is reported as undelivered input, not as a scrolling problem', async () => {
  tab.hidden = true;
  tab.scrollY = 0;
  try {
    await assert.rejects(interact.click(TAB, { ref: 'e5', humanize: 'Human', seed: 12 }), (err) => {
      assert.match(err.message, /HIDDEN/);
      assert.equal(err.delivery, 'not-delivered');
      return true;
    });
    assert.equal(FAR.scrolledIntoView, undefined, 'no programmatic fallback for input that is not being delivered');
  } finally {
    tab.hidden = false;
  }
});

await test('human reaches an off-screen target with the WHEEL (no scrollIntoView)', async () => {
  tab.scrollY = 0;
  const mark = since();
  const res = await interact.click(TAB, { ref: 'e5', humanize: 'human', seed: 5 });
  assert.equal(res.scrolled.via, 'wheel');
  assert.ok(tab.scrollY > 0);
  assert.equal(FAR.scrolledIntoView, undefined);
  const wheel = mouseOf(slice(mark)).filter((c) => c.params.type === 'mouseWheel');
  assert.ok(wheel.length >= 3, 'notches, not one programmatic jump');
  assert.ok(wheel.every((c) => Math.abs(c.params.deltaY) <= 100), 'no notch larger than a real wheel notch');
  assert.equal(res.delivery, 'delivered');
  tab.scrollY = 0;
});

await test('human scroll: wheel notches at the pointer add up to the amount', async () => {
  tab.scrollY = 0;
  const mark = since();
  const res = await interact.scroll(TAB, { direction: 'down', amount: 400, humanize: 'human', seed: 3 });
  const wheel = mouseOf(slice(mark)).filter((c) => c.params.type === 'mouseWheel');
  assert.equal(wheel.reduce((sum, c) => sum + c.params.deltaY, 0), 400);
  assert.equal(res.moved, true);
  assert.equal(res.delivery, 'delivered');
  assert.equal(res.via, 'wheel');
  tab.scrollY = 0;
});

// ---------------------------------------------------------------- typing

await test('stealth typing: focus by clicking, no DOM.focus, no insertText; no typos in a password field', async () => {
  SECRET.value = '';
  tab.focused = null;
  const mark = since();
  const res = await interact.type(TAB, { ref: 'e4', text: 'Secret1!', humanize: 'stealth', seed: 42 });
  const cmds = slice(mark);
  assert.equal(res.value, 'Secret1!');
  assert.ok(!cmds.some((c) => c.method === 'DOM.focus'));
  assert.ok(!cmds.some((c) => c.method === 'Input.insertText'));
  assert.ok(mouseOf(cmds).some((c) => c.params.type === 'mousePressed'), 'focused by a click');
  assert.ok(!keysOf(cmds).some((c) => c.params.key === 'Backspace'), 'no typo corrections in a password field');
  assert.equal(res.typosCorrected, undefined);
  assert.equal(res.humanize.level, 'stealth');
  assert.equal(res.delivery, 'delivered');
});

await test('fast:true is honoured when explicitly asked, and says it is not human', async () => {
  FIELD.value = '';
  const mark = since();
  const res = await interact.type(TAB, { ref: 'e2', text: 'xyz', fast: true, humanize: 'stealth', seed: 1 });
  assert.equal(slice(mark).filter((c) => c.method === 'Input.insertText').length, 1);
  assert.match(res.fast, /not human-like/);
  assert.equal(res.value, 'xyz');
});

await test('typing reports, never asserts, a value the page filtered', async () => {
  NUMERIC.value = '';
  const res = await interact.type(TAB, { ref: 'e3', text: '12ab34', humanize: 'human', seed: 8, typos: false });
  assert.equal(res.value, '1234');
  assert.match(res.note, /filtered or reformatted/);
  assert.equal(res.delivery, 'delivered');
});

await test('clear:true at stealth uses only keys a person presses, and proves the field is empty', async () => {
  FIELD.value = 'old value';
  const mark = since();
  const res = await interact.type(TAB, { ref: 'e2', text: 'new', clear: true, humanize: 'stealth', seed: 4, typos: false });
  const cmds = slice(mark);
  assert.equal(res.value, 'new');
  assert.ok(!cmds.some((c) => c.method === 'Runtime.callFunctionOn' && /this\.select\(\)/.test(c.params.functionDeclaration)));
  assert.ok(keysOf(cmds).some((c) => c.params.key === 'a' && c.params.modifiers === 2 && c.params.type === 'rawKeyDown'));
});

// ------------------------------------------------------------------ drag

await test('humanized drag: press, a carried path of at least 12 held moves, release on the target', async () => {
  const mark = since();
  const res = await interact.drag(TAB, { from: 'e1', to: 'e7', humanize: 'human', seed: 21 });
  const sent = mouseOf(slice(mark));
  const press = sent.findIndex((c) => c.params.type === 'mousePressed');
  const release = sent.findIndex((c) => c.params.type === 'mouseReleased');
  assert.ok(press > 0 && release > press);
  const carried = sent.slice(press + 1, release).filter((c) => c.params.type === 'mouseMoved');
  assert.ok(carried.length >= 12);
  assert.ok(carried.every((c) => c.params.buttons === 1));
  const end = sent[release].params;
  assert.ok(end.x >= 700 && end.x <= 800 && end.y >= 500 && end.y <= 600);
  assert.equal(res.delivery, 'delivered');
});

// --------------------------------------------------------------- recorder

await test('recorder: lives in the g9 world, bound by name and by context id, survives a Runtime-less navigation', async () => {
  fake.chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method === 'Runtime.bindingCalled' && params.name === record.BINDING) {
      record.ingestRaw(source.tabId, JSON.parse(params.payload)).catch(() => {});
    }
  });
  const mark = since();
  await record.startRecording(TAB, { name: 'unit' });
  const cmds = slice(mark);
  const scripts = cmds.filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument');
  assert.ok(scripts.length >= 1 && scripts.every((c) => c.params.worldName === 'g9'));
  const bindings = cmds.filter((c) => c.method === 'Runtime.addBinding');
  assert.ok(bindings.some((c) => c.params.executionContextName === 'g9'));
  assert.ok(bindings.some((c) => c.params.executionContextId != null && fake.contexts.get(c.params.executionContextId)?.world === 'g9'));
  assert.ok(bindings.every((c) => c.params.executionContextName === 'g9' || c.params.executionContextId != null), 'never a bare binding');
  const g9 = frame.worlds.get('g9');
  assert.equal(typeof g9.sandbox[record.BINDING], 'function');
  assert.equal(g9.sandbox.__g9rec, true);
  assert.equal(frame.mainCtx.sandbox[record.BINDING], undefined, 'the page cannot see the binding');
  assert.equal(frame.mainCtx.sandbox.__g9rec, undefined);

  // Raw samples for calibration arrive in batches: pointer movement, and key
  // TIMING reduced to classes — never the characters, never a password field.
  await interact.hover(TAB, { ref: 'e1', humanize: 'human', seed: 77 });
  FIELD.value = '';
  await interact.type(TAB, { ref: 'e2', text: 'Zq!', humanize: 'off', delayMs: 0 });
  SECRET.value = '';
  await interact.type(TAB, { ref: 'e4', text: 'hunter2', humanize: 'off', delayMs: 0 });
  await new Promise((r) => setTimeout(r, 1300));
  const status = await record.recordingStatus(TAB);
  assert.ok(status.inputSamples > 0, `samples recorded (${status.inputSamples})`);
  const buffered = fake.store.session.get(`g9:recording-samples:${TAB}`).items;
  const keySamples = buffered.filter((e) => e.type === 'keydown');
  assert.deepEqual(keySamples.map((e) => e.key), ['A', 'a', '!'], 'classes only, and nothing from the password field');
  assert.ok(keySamples.every((e) => /^k\d+$/.test(e.code)), 'the physical code is an opaque pairing token');
  assert.ok(buffered.some((e) => e.type === 'mousemove' && Number.isFinite(e.x) && Number.isFinite(e.y)));
  assert.ok(buffered.some((e) => e.type === 'mousedown' && e.width > 0 && e.height > 0), 'press samples carry the target size (Fitts W)');

  // Navigate with the Runtime domain OFF (stealth): the name binding is not
  // installed in the new world, so the recorder must be re-bound by context id.
  tab.runtimeEnabled.clear();
  fake.navigate(TAB, { fireEvent: true, url: 'https://example.test/page2' });
  const fresh = frame.worlds.get('g9');
  assert.equal(fresh.sandbox.__g9rec, true, 'the registered script ran in the new document');
  assert.equal(fresh.sandbox[record.BINDING], undefined, 'not bound yet: Runtime is off');
  await record.ingestRaw(TAB, { type: 'navigate', at: Date.now(), url: 'https://example.test/page2' });
  for (let i = 0; i < 40 && typeof frame.worlds.get('g9').sandbox[record.BINDING] !== 'function'; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(typeof frame.worlds.get('g9').sandbox[record.BINDING], 'function', 're-bound by context id');
  assert.equal(frame.mainCtx.sandbox[record.BINDING], undefined);

  const out = await record.stopRecording(TAB);
  assert.ok(out.id);
  assert.equal(frame.listeners.filter((l) => l.ctx.alive).length, 0, 'the recorder removed every listener it added');
  const removed = fake.calls('Page.removeScriptToEvaluateOnNewDocument');
  assert.ok(removed.length >= 1);

  // The samples are stored with the recording, in fitProfile's shape…
  assert.ok(out.inputSamples > 0);
  const data = await record.inputSamplesOf(out.id);
  assert.equal(data.format, 'g9-input-samples/1');
  assert.ok(data.events.some((e) => e.type === 'mousemove'));
  assert.ok(data.events.every((e) => e.value === undefined), 'typed values are not copied into calibration data');
  // …and calibration turns them into a named profile an action can use.
  const cal = await record.calibrateFromRecording(out.id, { name: 'team-unit' });
  assert.equal(cal.saved, 'team-unit');
  assert.ok(cal.report);
  const used = await interact.click(TAB, { ref: 'e1', humanize: 'team-unit', seed: 3 });
  assert.equal(used.humanize.profile, 'team-unit');
  assert.equal(used.delivery, 'delivered');
  await assert.rejects(interact.click(TAB, { ref: 'e1', humanize: 'no-such-profile' }), /Unknown humanize profile/);
});

// ----------------------------------------------------------- screencast

const STREAM = 3; // a screencast session id, shared by all frames of the stream
await test('screencast: one stream shared by consumers, most demanding parameters, stopped by the last', async () => {
  const fromSeq = fake.nextSeq();
  const got = { watch: [], other: [] };
  screencast.subscribe(TAB, 'watch', (frameArg) => {
    // A consumer without back-pressure gets the frame AFTER it was acked.
    const acks = fake.log.filter((c) => c.method === 'Page.screencastFrameAck' && c.params.sessionId === STREAM);
    assert.equal(acks.length, got.watch.length + 1, 'this frame was acked before it was handed out');
    got.watch.push(frameArg);
  });
  await screencast.start(TAB, 'watch', { quality: 50, everyNthFrame: 1 });
  screencast.subscribe(TAB, 'other', (frameArg) => got.other.push(frameArg));
  await screencast.start(TAB, 'other', { quality: 80, everyNthFrame: 2 });
  const starts = fake.calls('Page.startScreencast').filter((c) => c.seq > fromSeq);
  assert.equal(starts.length, 2, 'restarted once for the more demanding consumer');
  assert.deepEqual(starts.at(-1).params, { format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
  assert.deepEqual(screencast.consumers(TAB).sort(), ['other', 'watch']);
  // As in Chromium, every frame of one stream carries the SAME sessionId (it
  // names the screencast session; the ack echoes it). A dedupe on it would
  // drop every frame after the first.
  const frames = [];
  for (let n = 1; n <= 4; n++) {
    frames.push({ data: JPEG, metadata: { n }, sessionId: STREAM });
    await screencast.onFrame(TAB, frames.at(-1));
  }
  assert.equal(got.watch.length, 4, 'every frame of the stream is delivered');
  assert.equal(got.other.length, 2, 'a consumer that asked for every 2nd frame gets every 2nd frame');
  assert.ok(got.watch.every((fr) => fr.data === JPEG && Number.isFinite(fr.at)));
  assert.equal(fake.log.filter((c) => c.method === 'Page.screencastFrameAck' && c.params.sessionId === STREAM).length, 4, 'every frame acked');
  // The same frame EVENT delivered twice (two routes) is handled once.
  await screencast.onFrame(TAB, frames.at(-1));
  assert.equal(got.watch.length, 4);
  const stopsBefore = fake.calls('Page.stopScreencast').length;
  await screencast.stop(TAB, 'watch');
  assert.equal(fake.calls('Page.stopScreencast').length, stopsBefore, 'still in use by another consumer');
  await screencast.stop(TAB, 'other');
  assert.equal(fake.calls('Page.stopScreencast').length, stopsBefore + 1);
  assert.deepEqual(screencast.consumers(TAB), []);
  // An orphan frame (a stream nobody here remembers) is acked and stopped.
  await screencast.onFrame(TAB, { data: JPEG, metadata: {}, sessionId: 777 });
  assert.ok(tab.acks.includes(777));
  assert.equal(fake.calls('Page.stopScreencast').length, stopsBefore + 2);
});

await test('issue video: a screencast consumer; each frame written BEFORE its ack and carrying the pointer; the track attached', async () => {
  const issue = await issues.createIssue(TAB, { title: 'unit video', withScreenshot: false });
  const started = await issues.startVideo(TAB, { id: issue.id });
  assert.equal(started.recording, true);
  assert.deepEqual(screencast.consumers(TAB), [`video:${issue.id}`]);
  const start = fake.calls('Page.startScreencast').at(-1);
  assert.deepEqual(start.params, { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 2 });

  const moving = interact.hover(TAB, { ref: 'e7', humanize: 'human', seed: 31 });
  const meta = { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 };
  for (let n = 1; n <= 5; n++) {
    await sleep(80);
    await screencast.onFrame(TAB, { data: JPEG, metadata: meta, sessionId: 9 });
  }
  await moving;
  const frameWrites = writes.filter((w) => w.store === 'video-frames');
  assert.equal(frameWrites.length, 5);
  const acks = fake.log.filter((c) => c.method === 'Page.screencastFrameAck' && c.params.sessionId === 9);
  assert.equal(acks.length, 5, 'every frame acked, with the stream session id');
  for (let n = 0; n < 5; n++) {
    assert.ok(frameWrites[n].seq < acks[n].seq, `frame ${n + 1} written before it was acked`);
    if (n) assert.ok(acks[n - 1].seq < frameWrites[n].seq, 'one frame at a time: write, ack, next');
  }
  const status = await issues.videoStatus(TAB);
  assert.equal(status.frames, 5);
  assert.deepEqual(status.viewport, { width: 1280, height: 800 });

  const stopped = await issues.stopVideo(TAB, issue.id);
  assert.equal(stopped.frames, 5);
  assert.equal(stopped.attached, true);
  assert.ok(stopped.pointerTrack.samples > 0);
  assert.ok(fake.calls('Page.stopScreencast').at(-1).seq > start.seq, 'the stream stopped with its last consumer');
  const rows = await store.listAttachments(issue.id);
  const videoRow = rows.find((r) => r.kind === 'video');
  const trackRow = rows.find((r) => r.name === 'pointer-track.json');
  assert.ok(videoRow && trackRow);
  const video = await attachmentJson(videoRow.id);
  assert.equal(video.format, 'g9-frames/1');
  assert.deepEqual(video.viewport, { width: 1280, height: 800 });
  assert.equal(video.frames.length, 5);
  assert.ok(video.frames.every((fr) => fr.pointer && Number.isFinite(fr.pointer.x) && Number.isFinite(fr.pointer.y) && Number.isFinite(fr.pointer.buttons)));
  assert.ok(video.frames.every((fr) => fr.meta && fr.meta.deviceWidth === 1280));
  const track = await attachmentJson(trackRow.id);
  assert.equal(track.format, 'g9-pointer/1');
  assert.equal(track.samples.length, stopped.pointerTrack.samples);
  assert.ok(track.samples.every((p) => p.t >= 0 && Number.isFinite(p.x) && typeof p.type === 'string'));
  const last = track.samples.at(-1);
  assert.ok(last.x >= 700 && last.x <= 800 && last.y >= 500 && last.y <= 600, 'the track ends where the hover did');
  assert.deepEqual(await issues.videoStatus(TAB), { recording: false });
});

// ------------------------------------------------------------ review fixes

const framesLib = await import(extUrl('lib/frames.js'));
const snapshotTool = await import(extUrl('tools/snapshot.js'));
const hzLib = await import(extUrl('lib/humanize.js'));

await test('level off: a shifted symbol pressed as a KEY has no physical code either (v1\'s dispatchKey)', async () => {
  const mark = since();
  const res = await interact.key(TAB, { key: '!', humanize: 'off' });
  assert.deepEqual(keysOf(slice(mark)).map((c) => c.params), [
    { type: 'keyDown', key: '!', text: '!', modifiers: 0 },
    { type: 'keyUp', key: '!', modifiers: 0 },
  ]);
  assert.equal(res.delivery, 'delivered');
});

// A page with a cross-origin iframe (an ad, a widget): the key witness listens
// there too, but the first frame that saw the key answers the question.
const ADTAB = 12;
const adTab = fake.addTab(ADTAB, {
  url: 'https://news.test/',
  frames: [{ id: 'AD12', parentId: `F${ADTAB}`, url: 'https://ads.test/', session: 'S-AD' }],
});
await framesLib.onAttached(ADTAB, { sessionId: 'S-AD', targetInfo: { type: 'iframe', targetId: 'T-AD', url: 'https://ads.test/' } });
const AD_FIELD = fake.addNode(ADTAB, { backendNodeId: 1201, tag: 'input', frameId: 'AD12', box: { x: 5, y: 5, width: 100, height: 20 } });

await test('inspect frames: a cross-origin (out-of-process) frame is in the tree, under the frame that holds it', async () => {
  // Engine 2 live test: only the top document was listed — the page session's own frame tree does
  // not contain a site-isolated iframe; its attached child session does.
  const inspectTool = await import(extUrl('tools/inspect.js'));
  const res = await inspectTool.frames(ADTAB);
  assert.deepEqual(res.frames.map((f) => [f.depth, f.url, !!f.crossProcess]), [[0, 'https://news.test/', false], [1, 'https://ads.test/', true]]);
});

await test('key witness: the first frame that saw the key answers — no waiting out the others\' timeouts', async () => {
  adTab.focused = null;
  let mark = since();
  let t0 = performance.now();
  let res = await interact.key(ADTAB, { key: 'Enter', humanize: 'off' });
  let ms = performance.now() - t0;
  assert.equal(res.delivery, 'delivered');
  assert.ok(slice(mark).some((c) => c.sessionId === 'S-AD' && c.method === 'Runtime.evaluate' && /const kinds = /.test(c.params.expression)),
    'a witness was armed in the cross-origin frame too');
  assert.ok(ms < 1000, `delivered in the page, answered at once (took ${Math.round(ms)} ms; the witness timeout is 1500)`);

  // Focus inside the cross-origin frame: the frame's own witness answers.
  adTab.focused = AD_FIELD;
  mark = since();
  t0 = performance.now();
  res = await interact.key(ADTAB, { key: 'Tab', humanize: 'off' });
  ms = performance.now() - t0;
  assert.equal(res.delivery, 'delivered');
  assert.ok(ms < 1000, `delivered in the frame, answered at once (took ${Math.round(ms)} ms)`);
  // Every witness handle is released, the early-answered ones included.
  const armed = slice(mark).filter((c) => c.method === 'Runtime.awaitPromise').map((c) => c.params.promiseObjectId);
  assert.equal(armed.length, 2);
  await sleep(20);
  assert.ok(armed.every((id) => fake.released.includes(id)));
  adTab.focused = null;
});

await test('witness: a press that goes out late (slow dispatch) is still delivered — the verdict is timed from the end of dispatch', async () => {
  // The press reaches the page 2.5 s after the witness was armed: past the
  // 1.5 s grace. Timed from arming, this click that DID land was reported as
  // not delivered — an invitation to click again.
  tab.inputDelay = { mousePressed: 2500 };
  try {
    const res = await interact.click(TAB, { ref: 'e1', humanize: 'off' });
    assert.equal(res.delivery, 'delivered');
  } finally {
    tab.inputDelay = null;
  }
  // …and a press that never lands (the page stays visible; something the browser owns eats the
  // input) is still reported, one grace period after dispatch.
  tab.dropInput = true;
  try {
    const t0 = performance.now();
    await assert.rejects(interact.click(TAB, { ref: 'e1', humanize: 'off' }), (err) => err.delivery === 'not-delivered' && /reports it is visible/.test(err.message));
    const ms = performance.now() - t0;
    assert.ok(ms >= 1400 && ms < 4000, `not-delivered reported after the grace period (${Math.round(ms)} ms)`);
  } finally {
    tab.dropInput = false;
  }
  await sleep(20);
  assert.equal(frame.listeners.filter((l) => l.ctx.alive).length, 0, 'no witness left listening');
});

await test('scroll returns the SETTLED position when the page applies each notch late (live round 2 regression)', async () => {
  // Round 2: a notch's scroll landed ~100 ms after its dispatch returned on CfT; the scroll tool
  // returned at the first changed read ("y=500" with y=600 still to come) in 50/50 runs.
  tab.scrollLag = 120;
  try {
    for (const level of ['human', 'off']) {
      tab.scrollY = 0;
      await pointer.setPosition(TAB, 640, 400);
      const t0 = performance.now();
      const res = await interact.scroll(TAB, { direction: 'down', amount: 600, humanize: level, seed: 31 });
      const took = performance.now() - t0;
      assert.equal(res.moved, true, level);
      await sleep(400); // anything still in flight lands now
      assert.equal(res.position.y, tab.scrollY, `${level}: the reported position is where the page came to rest (${res.position.y} vs ${tab.scrollY})`);
      // settled:false is only honest if the wait really ran out of its budget (settledScroll's
      // capMs is 1500). A saturated machine cannot see 160 ms of quiet in three 80 ms polls and
      // then says so truthfully; a dispatcher that gave up early would return long before that.
      assert.ok(res.settled !== false || took >= 1500, `${level}: settled within the cap (gave up after ${Math.round(took)} ms of the 1500 ms budget)`);
    }
  } finally {
    tab.scrollLag = 0;
    tab.scrollY = 0;
  }
});

await test('a click after a wheel reach aims at where the element CAME TO REST, not where it was (late scroll)', async () => {
  // Round 2: settledBox took the first read matching the pre-scroll box as "settled" and the press
  // went where the button used to be: 22/22 CfT clicks after a scroll missed.
  tab.scrollLag = 150;
  try {
    // Several seeds: whether the last notch is still in flight when the element is measured
    // depends on the plan (a re-introduced early "settled" missed 3 of these 5 — measured).
    for (const seed of [41, 42, 43, 44, 45]) {
      tab.scrollY = 0;
      await pointer.setPosition(TAB, 640, 400);
      const res = await interact.click(TAB, { ref: 'e5', humanize: 'human', seed });
      assert.equal(res.delivery, 'delivered', `seed ${seed}: the witness armed on the button saw the press on the button`);
      assert.equal(res.scrolled.via, 'wheel');
      await sleep(300);
    }
  } finally {
    tab.scrollLag = 0;
    tab.scrollY = 0;
  }
});

await test('a page still moving when the action starts (a smooth scroll in progress): G9 aims where the element comes to rest', async () => {
  // The next action must not measure once and aim at geometry in motion — the page's own smooth
  // scroll, an animation, or a scroll an earlier action began (reachByWheel's initial settle).
  for (const seed of [51, 52, 53]) {
    tab.scrollY = 500; // "Far away" at y=600: on screen, no wheel needed
    await pointer.setPosition(TAB, 640, 400);
    const timers = [100, 200, 300].map((ms, i) => setTimeout(() => { tab.scrollY = [600, 680, 720][i]; }, ms));
    try {
      const res = await interact.click(TAB, { ref: 'e5', humanize: 'human', seed });
      assert.equal(res.delivery, 'delivered', `seed ${seed}: aimed at the resting place`);
    } finally {
      timers.forEach(clearTimeout);
    }
    await sleep(100);
  }
  tab.scrollY = 0;
});

await test('dispatcher: a slow transport never collapses the press hold or the dwell (live round 2 regression)', async () => {
  // Round 2, Chrome for Testing: 35–54 ms per mouseMoved against the plan's 8–16 ms put the plan
  // seconds behind; mousePressed and mouseReleased then went out back to back (1.9–8.1 ms holds).
  tab.inputDelay = { mouseMoved: 40 };
  try {
    const mark = since();
    const res = await interact.click(TAB, { ref: 'e1', humanize: 'human', seed: 77 });
    assert.equal(res.delivery, 'delivered');
    const mouse = mouseOf(slice(mark));
    const press = mouse.find((c) => c.params.type === 'mousePressed');
    const release = mouse.find((c) => c.params.type === 'mouseReleased');
    const hold = release.t - press.t;
    // Rule 1 keeps at least 80 % of a planned interval: a 60–140 ms hold never goes below 48 ms (it was 2–8 ms).
    assert.ok(hold >= 45, `the hold survived the slow transport (${Math.round(hold)} ms; the plan holds 60–140 ms)`);
  } finally {
    tab.inputDelay = null;
  }
});

await test('dispatcher: overdue moves are merged, presses and keys never; gaps before decisive steps survive', async () => {
  const hz = await import(extUrl('lib/humanize.js'));
  // A hand-made plan: 20 moves 10 ms apart, then press (+80 ms dwell) and release (+100 ms hold).
  const steps = [];
  for (let i = 0; i < 20; i++) steps.push({ at: i * 10, kind: 'mouse', type: 'mouseMoved', x: 100 + i, y: 100, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 });
  steps.push({ at: 270, kind: 'mouse', type: 'mousePressed', x: 119, y: 100, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 });
  steps.push({ at: 370, kind: 'mouse', type: 'mouseReleased', x: 119, y: 100, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 });
  const plan = { steps, durationMs: 400, end: { x: 119, y: 100 }, meta: { kind: 'test' } };
  tab.inputDelay = { mouseMoved: 45 };
  try {
    const mark = since();
    const out = await hz.perform(TAB, plan);
    const mouse = mouseOf(slice(mark));
    const moves = mouse.filter((c) => c.params.type === 'mouseMoved');
    const press = mouse.find((c) => c.params.type === 'mousePressed');
    const release = mouse.find((c) => c.params.type === 'mouseReleased');
    assert.ok(out.merged > 0 && moves.length < 20, `behind schedule, moves were merged (${moves.length} of 20 sent, merged ${out.merged})`);
    assert.equal(moves.at(-1).params.x, 119, 'the last move before the press is always sent');
    assert.equal(mouse.filter((c) => c.params.type !== 'mouseMoved').length, 2, 'press and release: never merged');
    // At least 80 % of each planned interval survives (KEEP_GAP), minus timer jitter.
    assert.ok(press.t - moves.at(-1).t >= 62, `the dwell survived (${Math.round(press.t - moves.at(-1).t)} ms of 80)`);
    assert.ok(release.t - press.t >= 78, `the hold survived (${Math.round(release.t - press.t)} ms of 100)`);
    assert.equal(out.dispatched, moves.length + 2);
  } finally {
    tab.inputDelay = null;
  }
  // With no transport delay the plan goes out whole — on a machine that can keep a 10 ms schedule.
  // That is the machine's promise, not the product's: saturated, this host genuinely falls 200–400 ms
  // behind a 400 ms plan and merges 15 of the 20 moves, which is rule 2 doing exactly what it is for.
  // So the rule is asserted, not the machine: every planned event is either sent or merged and counted,
  // presses are never merged, nothing goes out before its due time, and a move is merged only when the
  // dispatcher is at least MERGE_BEHIND_MS (24) past that move's due time.
  const mark = since();
  const t0 = performance.now(); // taken before perform(), so never later than its own origin
  const out = await hz.perform(TAB, plan);
  const sent = mouseOf(slice(mark));
  assert.ok(!('merged' in out) || out.merged > 0, 'merged is reported only when something was merged');
  assert.equal(sent.length + (out.merged ?? 0), 22, 'every planned event was either sent or merged');
  assert.equal(out.dispatched, sent.length);
  assert.equal(sent.filter((c) => c.params.type !== 'mouseMoved').length, 2, 'press and release: never merged');
  assert.equal(sent.at(-1).params.type, 'mouseReleased');
  let s = 0;
  sent.forEach((c, i) => {
    while (s < steps.length && !(steps[s].type === c.params.type && steps[s].x === c.params.x)) {
      const behind = c.t - t0 - steps[s].at;
      assert.equal(steps[s].type, 'mouseMoved', `planned event ${s} (${steps[s].type}) was skipped — only moves may be merged`);
      assert.ok(behind >= 24, `planned move ${s} was merged while the dispatcher was only ${Math.round(behind)} ms behind (rule 2 needs 24)`);
      s += 1;
    }
    assert.ok(s < steps.length, `sent event ${i} is not in the plan`);
    assert.ok(c.t - t0 >= steps[s].at, `event ${i} dispatched ${Math.round(steps[s].at - (c.t - t0))} ms before its due time`);
    s += 1;
  });
});

await test('dispatcher: a hiccup just before a press never eats the dwell or the hold (rule 1: ≥ 80 % survives)', async () => {
  // One slow move right before the press puts the dispatcher ~70 ms behind. On the absolute schedule
  // alone the press then goes out ~30 ms after the last move instead of 100 — the collapse that made
  // Chrome for Testing's holds 2–8 ms (live round 2). Rule 1 keeps at least 80 % of each interval.
  const hz = await import(extUrl('lib/humanize.js'));
  const steps = [];
  for (let i = 0; i < 20; i++) steps.push({ at: i * 10, kind: 'mouse', type: 'mouseMoved', x: 100 + i, y: 100, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 });
  steps.push({ at: 290, kind: 'mouse', type: 'mousePressed', x: 119, y: 100, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 });
  steps.push({ at: 390, kind: 'mouse', type: 'mouseReleased', x: 119, y: 100, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 });
  const plan = { steps, durationMs: 400, end: { x: 119, y: 100 }, meta: { kind: 'test' } };
  tab.inputDelayAt = { x: 118, ms: 80 };
  try {
    for (let round = 0; round < 3; round++) {
      const mark = since();
      await hz.perform(TAB, plan);
      const mouse = mouseOf(slice(mark));
      const last = mouse.filter((c) => c.params.type === 'mouseMoved').at(-1);
      const press = mouse.find((c) => c.params.type === 'mousePressed');
      const release = mouse.find((c) => c.params.type === 'mouseReleased');
      assert.equal(last.params.x, 119);
      assert.ok(press.t - last.t >= 78, `round ${round}: dwell ${Math.round(press.t - last.t)} ms of 100 planned (≥ 80 %)`);
      assert.ok(release.t - press.t >= 78, `round ${round}: hold ${Math.round(release.t - press.t)} ms of 100 planned (≥ 80 %)`);
    }
  } finally {
    tab.inputDelayAt = null;
  }
});

await test('a wheel that never answers on a VISIBLE page with no screencast is not blamed on a screencast', async () => {
  // P8 matrix, round 2: "the browser stopped answering wheel events — this happens while a
  // screencast is running" was said on pages where no screencast ran (they were hidden). The
  // cause named must be the one present.
  tab.wheelHangs = true;
  tab.scrollY = 0;
  try {
    await pointer.setPosition(TAB, 640, 400);
    await assert.rejects(interact.scroll(TAB, { direction: 'down', amount: 100, humanize: 'human', seed: 9 }), (err) => {
      assert.equal(err.wheelStall, true);
      assert.doesNotMatch(err.message, /one is running on this tab/);
      assert.match(err.message, /no screencast is running on this tab/);
      assert.match(err.message, /visible/);
      return true;
    });
  } finally {
    tab.wheelHangs = false;
  }
});

await test('off drag: bringing the drop target in never scrolls the grip away; a press elsewhere is "missed", never "delivered"', async () => {
  // Engine 2 live test: v1's off drag centred the grip, then centred the drop target, which
  // scrolled the grip off screen; the press landed on the track under it and the result said
  // "delivered". Grip "Save" (y 100..140) and drop "Drop here" (y 500..600) fit on one screen.
  tab.scrollY = 0;
  const mark = since();
  const res = await interact.drag(TAB, { from: 'e1', to: 'e7', humanize: 'off' });
  assert.equal(res.delivery, 'delivered');
  assert.equal(tab.scrollY, 0, 'nothing needed scrolling, so nothing scrolled');
  const mouse = mouseOf(slice(mark));
  const press = mouse.find((c) => c.params.type === 'mousePressed');
  const release = mouse.find((c) => c.params.type === 'mouseReleased');
  assert.ok(press.params.y >= 100 && press.params.y <= 140, `the press is on the grip (y ${press.params.y})`);
  assert.ok(release.params.y >= 500 && release.params.y <= 600, `the release is over the drop target (y ${release.params.y})`);
});

/** A <select> for SELECT_PLAN_FN in node:vm: options, optgroups, display:none and a current index. */
function fakeSelect(spec, { selectedIndex = 0, multiple = false } = {}) {
  const groups = new Map();
  const options = spec.map((o, i) => {
    const opt = {
      value: o.value ?? `v${i}`, label: o.label ?? o.text, textContent: o.text,
      disabled: !!o.disabled, hidden: !!o.hidden, selected: i === selectedIndex,
      __display: o.display ?? 'block', parentElement: null,
    };
    if (o.group) {
      if (!groups.has(o.group)) groups.set(o.group, { tagName: 'OPTGROUP', disabled: !!o.groupDisabled, __display: o.groupDisplay ?? 'block' });
      opt.parentElement = groups.get(o.group);
    }
    return opt;
  });
  const view = {
    addEventListener() {}, removeEventListener() {},
    getComputedStyle: (el) => ({ display: el.hidden ? 'none' : (el.__display ?? 'block') }),
  };
  return { tagName: 'SELECT', options, multiple, selectedIndex, ownerDocument: { defaultView: view } };
}

await test('a cancelled call stops its input between steps and says how much was sent (the daemon\'s deadline)', async () => {
  // The daemon binds an AbortSignal to the tab for the call's duration; perform() checks it exactly
  // as it checks Stop, so a call that ran past its deadline stops instead of typing into whatever
  // the next call focuses (docs review, 2026-09-22).
  const hum = await import(extUrl('lib/humanize.js'));
  const controller = new AbortController();
  const unbind = hum.bindCallSignal(TAB, controller.signal);
  try {
    assert.equal(hum.callSignalFor(TAB), controller.signal);
    const profile = H.resolveProfile('human');
    const plan = H.planType(H.createRng('cancel'), profile, { text: 'hello world, this is a long sentence', field: {} });
    tab.focused = FIELD;
    const running = hum.perform(TAB, plan);
    setTimeout(() => controller.abort(new Error('it ran past its 1s deadline')), 40);
    await assert.rejects(running, (err) => {
      assert.match(err.message, /Cancelled: it ran past its 1s deadline/);
      assert.match(err.message, /input events of this type were sent; the rest were not/);
      assert.equal(err.halted, true, 'it stops the way Stop does');
      return true;
    });
  } finally {
    unbind();
    assert.equal(hum.callSignalFor(TAB), null, 'the binding lasts only for that call');
  }
});

await test('select: the keys move from the CURRENT option over SELECTABLE ones only, and an option already chosen needs none', async () => {
  // Chromium's Home/arrows skip a disabled option, one in a disabled optgroup and one that is not
  // rendered — the plan counted them, so every target after the usual disabled "Choose…" placeholder
  // was off by one (Apple gave Banana), and the page was blamed (interaction review, 2026-09-22).
  const ctx = vm.createContext({});
  const plan = vm.runInContext(`(${interact.SELECT_PLAN_FN})`, ctx);
  const list = [
    { text: 'Choose a fruit', disabled: true },
    { text: 'Apple' },
    { text: 'Banana' },
    { text: 'Ghost', hidden: true },
    { text: 'Cherry' },
    { text: 'Old', group: 'g', groupDisabled: true },
  ];
  const at = (i) => fakeSelect(list, { selectedIndex: i });
  assert.deepEqual(plain(plan.call(at(0), ['Apple'])).move, { key: 'ArrowDown', repeat: 1 });
  assert.deepEqual(plain(plan.call(at(0), ['Banana'])).move, { key: 'ArrowDown', repeat: 2 });
  assert.deepEqual(plain(plan.call(at(0), ['Cherry'])).move, { key: 'ArrowDown', repeat: 3 }, 'the hidden option is not a step');
  assert.deepEqual(plain(plan.call(at(4), ['Apple'])).move, { key: 'ArrowUp', repeat: 2 });
  assert.deepEqual(plain(plan.call(at(2), ['Banana'])).move, { key: null, repeat: 0 }, 'already selected: no keys at all');
  // An option a person could not select is refused BEFORE anything is sent.
  const blocked = plain(plan.call(at(1), ['Choose a fruit']));
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /cannot be selected[\s\S]*nothing was sent/);
  assert.match(plain(plan.call(at(1), ['Old'])).reason, /cannot be selected/);
  assert.match(plain(plan.call(at(1), ['Ghost'])).reason, /cannot be selected/);
  // Multi-select: each toggle is counted in selectable options from the top (Ctrl+Home + Ctrl+Down×n).
  const multi = fakeSelect(list, { selectedIndex: -1, multiple: true });
  const m = plain(plan.call(multi, ['Cherry']));
  assert.equal(m.ok, true);
  assert.equal(m.rank[4], 2, 'Cherry is the third selectable option');
  assert.equal(m.rank[1], 0);
});

await test('type: appending puts the caret at the END of the field, and the result no longer blames the page', async () => {
  // At human and stealth the focus click aims at a random point in the field, and at off at its
  // centre: " epsilon" typed into "alpha beta gamma delta" became "alpha beta gamma d epsilonelta",
  // reported as delivered with "the page filtered or reformatted it" (interaction review, 2026-09-22).
  FIELD.value = 'alpha beta gamma delta';
  FIELD.selection = [0, 0];
  FIELD.selectionCalls = 0;
  tab.focused = null;
  const off = await interact.type(TAB, { ref: 'e2', text: ' epsilon', url: URL0, humanize: 'off' });
  assert.equal(FIELD.value, 'alpha beta gamma delta epsilon');
  assert.deepEqual(FIELD.selection, [22, 22], 'the caret was put at the end before typing');
  assert.equal(off.note, undefined, 'a correct append is not "the page filtered it"');
  assert.equal(off.caretNote, undefined);

  // The same at human, where the click aims at a random point inside the text.
  FIELD.value = 'alpha beta gamma delta';
  FIELD.selection = [3, 3];
  tab.focused = null;
  const human = await interact.type(TAB, { ref: 'e2', text: ' zeta', url: URL0, humanize: 'human', seed: 52, typos: false });
  assert.deepEqual(FIELD.selection, [22, 22]);
  assert.equal(human.note, undefined);

  // A field the caller EMPTIES first needs no caret move, and a page that really filters is still named.
  FIELD.selectionCalls = 0;
  tab.focused = null;
  await interact.type(TAB, { ref: 'e2', text: 'fresh', url: URL0, clear: true, humanize: 'off' });
  assert.equal(FIELD.value, 'fresh');
  const filtered = await interact.type(TAB, { ref: 'e3', text: '12ab34', url: URL0, clear: true, humanize: 'off' });
  assert.equal(filtered.value, '1234');
  assert.match(filtered.note, /filtered or reformatted/);
});

await test('an element already on screen is captured on a HIDDEN tab; only a capture that must SCROLL is refused', async () => {
  // bringIntoView asked for visibility before it knew whether any scroll was needed, so an element
  // shot at the default level was refused on a hidden tab with "The scroll was not sent … reading
  // tools keep working" — advice that contradicted the refusal (interaction review, 2026-09-22).
  const capture = await import(extUrl('tools/capture.js'));
  const shots = (cmds) => cmds.filter((c) => c.method === 'Page.captureScreenshot');
  tab.scrollY = 0;
  tab.hidden = true;
  try {
    let mark = since();
    const on = await capture.screenshot(TAB, { area: 'element', ref: 'e1', humanize: 'human', seed: 7 });
    let cmds = slice(mark);
    assert.ok(on.image || on.dataBase64 || on.bytes, 'the capture happened');
    assert.equal(mouseOf(cmds).length, 0, 'nothing was sent to the hidden page');
    assert.equal(shots(cmds).length, 1);
    // An element off screen cannot be wheeled into view on a hidden tab: refused, in the
    // screenshot's own words, with nothing sent and nothing captured.
    mark = since();
    await assert.rejects(capture.screenshot(TAB, { area: 'element', ref: 'e5', humanize: 'human', seed: 7 }), (err) => {
      assert.match(err.message, /off screen and the tab is HIDDEN/);
      assert.match(err.message, /area:"viewport"/);
      assert.equal(err.delivery, 'not-delivered');
      return true;
    });
    cmds = slice(mark);
    assert.equal(mouseOf(cmds).length, 0);
    assert.equal(shots(cmds).length, 0);
    // A viewport shot keeps working, as the remedy says.
    assert.ok(await capture.screenshot(TAB, { area: 'viewport' }));
  } finally {
    tab.hidden = false;
  }
});

await test('reaching an element by wheel sends WHOLE notches, at every human level', async () => {
  // The exact pixel need ended every reach on a partial notch (deltaY 47, 88) that no notched wheel
  // produces — at stealth too (interaction review, 2026-09-22).
  for (const level of ['human', 'stealth']) {
    tab.scrollY = 0;
    await pointer.setPosition(TAB, 640, 400);
    const mark = since();
    await interact.hover(TAB, { ref: 'e5', humanize: level, seed: 11 });
    const wheels = mouseOf(slice(mark)).filter((c) => c.params.type === 'mouseWheel');
    assert.ok(wheels.length, `${level}: the element was reached with the wheel`);
    const odd = wheels.filter((c) => Math.abs(c.params.deltaY) % 100 !== 0 || (c.params.deltaX ?? 0) % 100 !== 0);
    assert.deepEqual(odd.map((c) => c.params.deltaY), [], `${level}: every notch is a whole one`);
  }
});

await test('screenshots do nothing a person would not at the human levels: wheel, viewport clip, no resize; full page refused at stealth', async () => {
  // Live round 2 (the page's own listeners, 50/50 runs): area:"fullpage" resized the viewport (once to
  // 1×1) and area:"element" scrolled the page with scrollIntoView and left it there.
  const capture = await import(extUrl('tools/capture.js'));
  const shots = (cmds) => cmds.filter((c) => c.method === 'Page.captureScreenshot');
  const scrolledIntoView = (cmds) => cmds.some((c) => c.method === 'Runtime.callFunctionOn' && /scrollIntoView/.test(c.params.functionDeclaration));
  tab.scrollY = 0;
  await pointer.setPosition(TAB, 640, 400);

  // An element off screen, at human: reached with the WHEEL, captured with a clip inside the viewport.
  let mark = since();
  const el = await capture.screenshot(TAB, { area: 'element', ref: 'e5', humanize: 'human', seed: 61 });
  let cmds = slice(mark);
  assert.ok(mouseOf(cmds).some((c) => c.params.type === 'mouseWheel'), 'brought into view with the wheel');
  assert.ok(!scrolledIntoView(cmds), 'never scrollIntoView');
  assert.equal(shots(cmds).length, 1);
  assert.equal(shots(cmds)[0].params.captureBeyondViewport, undefined, 'no capture beyond the viewport, so no resize');
  const clip = shots(cmds)[0].params.clip;
  assert.ok(Math.abs(clip.x - 100) < 1 && Math.abs(clip.y - 1100) < 1, `the clip is the element in PAGE coordinates (${clip.x}, ${clip.y})`);
  assert.deepEqual([clip.width, clip.height], [120, 40]);
  assert.equal(el.scrolled.via, 'wheel');
  assert.equal(el.pageSaw, undefined);
  assert.equal(typeof el.dataBase64, 'string');

  // A full page taller than the viewport: refused at stealth, nothing captured…
  mark = since();
  await assert.rejects(capture.screenshot(TAB, { area: 'fullpage', humanize: 'stealth' }), /resize the page's viewport/);
  assert.equal(shots(slice(mark)).length, 0, 'nothing captured');
  // …taken at human, and the result says what the page saw.
  const fp = await capture.screenshot(TAB, { area: 'fullpage', humanize: 'human' });
  assert.match(fp.pageSaw, /resize/);

  // Level off keeps v1's element capture exactly, and says what the page saw.
  mark = since();
  const off = await capture.screenshot(TAB, { area: 'element', ref: 'e1', humanize: 'off' });
  cmds = slice(mark);
  assert.ok(scrolledIntoView(cmds), 'v1: scrollIntoView');
  assert.equal(shots(cmds)[0].params.captureBeyondViewport, true);
  assert.match(off.pageSaw, /scrollIntoView/);
  tab.scrollY = 0;
});

await test('snapshot text: a document with no <body> yet gives empty text, not a failed snapshot', async () => {
  const SNAPTAB = 14;
  const snapTab = fake.addTab(SNAPTAB, { url: 'https://example.test/loading' });
  snapTab.noBody = true;
  const res = await snapshotTool.snapshot(SNAPTAB, { mode: 'a11y+text' });
  assert.equal(res.text, '');
  snapTab.noBody = false;
  assert.equal((await snapshotTool.snapshot(SNAPTAB, { mode: 'a11y+text' })).text, '');
});

await test('recorder: a second start is refused (no leaked script), and a stale world id never binds the main world', async () => {
  const RECTAB = 13;
  const recTab = fake.addTab(RECTAB, { url: 'https://example.test/rec' });
  const recFrame = recTab.frames.get(`F${RECTAB}`);
  await record.startRecording(RECTAB, { name: 'twice' });
  const scriptsOf = () => fake.calls('Page.addScriptToEvaluateOnNewDocument', (c) => c.tabId === RECTAB).length;
  const scripts = scriptsOf();
  await assert.rejects(record.startRecording(RECTAB, { name: 'again' }), /already being recorded/);
  // F8: the panel names a recording in another tab; recordingTabs() is where it learns of it.
  assert.ok((await record.recordingTabs()).some((r) => r.tabId === RECTAB && r.name === 'twice'));
  assert.equal(scriptsOf(), scripts, 'nothing new registered by the refused start');

  // A cross-process navigation nobody told world.js about, in which the new
  // document's MAIN world is born with the id the old g9 world had.
  const g9id = recFrame.worlds.get('g9').id;
  fake.navigate(RECTAB, { fireEvent: false, crossProcess: true, reuseId: g9id });
  assert.equal(recFrame.mainCtx.id, g9id);
  await record.recordingStatus(RECTAB); // sweeps the bindings, in the background
  for (let n = 0; n < 40 && typeof recFrame.worlds.get('g9')?.sandbox[record.BINDING] !== 'function'; n++) await sleep(25);
  await sleep(50);
  assert.equal(typeof recFrame.worlds.get('g9').sandbox[record.BINDING], 'function', 'the new g9 world is bound');
  assert.equal(recFrame.mainCtx.sandbox[record.BINDING], undefined, 'the page main world got no binding');
  const bound = fake.calls('Runtime.addBinding', (c) => c.tabId === RECTAB && c.params.executionContextId === g9id);
  assert.equal(bound.length, 1, 'only the original (then-valid) binding ever used that id');
  await record.stopRecording(RECTAB);
});

await test('screencast: a restart the browser refuses gives the other consumers their stream back', async () => {
  const CASTTAB = 15;
  const castTab = fake.addTab(CASTTAB, { url: 'https://example.test/cast' });
  await screencast.start(CASTTAB, 'watch', { quality: 50, everyNthFrame: 1 });
  const watching = { format: 'jpeg', quality: 50, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 };
  assert.deepEqual(castTab.screencast, watching);
  castTab.refuseScreencast = true;
  await assert.rejects(screencast.start(CASTTAB, 'video:x', { quality: 90 }), /Unable to start the screencast/);
  assert.deepEqual(castTab.screencast, watching, 'the watcher is streaming again, with what it had');
  assert.equal(screencast.status(CASTTAB).running, true);
  assert.deepEqual(screencast.consumers(CASTTAB), ['watch']);
  await screencast.stop(CASTTAB, 'watch');
  assert.equal(castTab.screencast, null);
});

await test('screencast: a page between two documents is asked again; anything else fails at once (3.2)', async () => {
  // A replay that opened its own launched tab started its evidence stream while the tab committed its
  // first navigation: "Not attached to an active page", and the run recorded 0 frames.
  const TAB2 = 16;
  const t = fake.addTab(TAB2, { url: 'https://example.test/fresh' });
  t.betweenDocuments = 2;
  const started = await screencast.start(TAB2, 'run:x', { quality: 50, everyNthFrame: 1 });
  assert.deepEqual(started, { attempts: 3 }, 'two refusals, then it streams');
  assert.equal(screencast.status(TAB2).running, true);
  assert.deepEqual(screencast.consumers(TAB2), ['run:x'], 'the consumer stayed registered through the retries');
  await screencast.stop(TAB2, 'run:x');
  // Not a transient: no retry, the error as it came.
  t.refuseScreencast = true;
  const before = fake.calls('Page.startScreencast', (c) => c.tabId === TAB2).length;
  await assert.rejects(screencast.start(TAB2, 'run:y', { quality: 50 }), /Unable to start the screencast/);
  assert.equal(fake.calls('Page.startScreencast', (c) => c.tabId === TAB2).length - before, 1, 'asked once');
  // Still refused after four tries: it gives up, with the browser's reason.
  t.betweenDocuments = 9;
  await assert.rejects(screencast.start(TAB2, 'run:z', { quality: 50 }), /Not attached to an active page/);
  t.betweenDocuments = 0;
});

await test('human scroll without a ref turns the wheel over the DOCUMENT, not an inner scroller under the resting pointer', async () => {
  const PANEL = fake.addNode(TAB, { backendNodeId: 150, tag: 'div', scroller: true, fixed: true, box: { x: 900, y: 150, width: 300, height: 400 } });
  tab.scrollY = 0;
  await pointer.setPosition(TAB, 1000, 300); // resting over the panel
  const mark = since();
  try {
    const res = await interact.scroll(TAB, { direction: 'down', amount: 300, humanize: 'human', seed: 17 });
    const wheel = mouseOf(slice(mark)).filter((c) => c.params.type === 'mouseWheel');
    assert.ok(wheel.length >= 1);
    const inPanel = (p) => p.x >= 900 && p.x <= 1200 && p.y >= 150 && p.y <= 550;
    assert.ok(wheel.every((c) => !inPanel(c.params)), 'no notch over the inner scroller');
    assert.equal(res.moved, true);
    assert.equal(res.delivery, 'delivered');
  } finally {
    tab.nodes.delete(PANEL.backendNodeId);
    tab.scrollY = 0;
  }
});

await test('typing WITHOUT a ref into a focused password field plans no typos', async () => {
  const text = 'the quick brown fox jumps over the lazy dog';
  const human = H.resolveProfile('human');
  let seed = null;
  for (let s = 1; s <= 300 && seed === null; s++) {
    if (H.planType(H.createRng(`${s}:type`), human, { text, field: {} }).meta.typos > 0) seed = s;
  }
  assert.ok(seed !== null, 'a seed whose plan has a typo in an ordinary field');
  SECRET.value = '';
  tab.focused = SECRET;
  const mark = since();
  const res = await interact.type(TAB, { text, humanize: 'human', seed, typos: true });
  assert.ok(!keysOf(slice(mark)).some((c) => c.params.key === 'Backspace'), 'no typo corrections in a password field');
  assert.equal(res.typosCorrected, undefined);
  assert.equal(SECRET.value, text);
  tab.focused = null;
});

await test('levelFor: reads the current input mode (not a stale cache); blank humanize/seed mean "not given"', async () => {
  // The panel switched to stealth (both copies setState writes) in a worker
  // whose synchronous cache has not read state since.
  const liveState = fake.store.session.get('state');
  const setMode = (mode) => {
    fake.store.local.set('settings', { inputMode: mode });
    if (liveState) fake.store.session.set('state', { ...fake.store.session.get('state'), inputMode: mode });
  };
  setMode('stealth');
  try {
    assert.equal((await hzLib.levelFor(TAB, {})).level, 'stealth');
    assert.equal((await hzLib.levelFor(TAB, { humanize: '  ' })).level, 'stealth');
    const blankSeed = await hzLib.levelFor(TAB, { humanize: 'human', seed: '' });
    assert.notEqual(blankSeed.seed, '');
  } finally {
    setMode('off');
    await state.getState();
  }
  assert.equal((await hzLib.levelFor(TAB, {})).level, 'off');
  await assert.rejects(hzLib.saveProfile('Human', H.PROFILES.human), /not a usable profile name/);
});

/** Set the panel's Input (the default level; Stealth is also the floor) the way setState writes it. */
function setInputMode(mode) {
  fake.store.local.set('settings', { ...(fake.store.local.get('settings') ?? {}), inputMode: mode });
  const live = fake.store.session.get('state');
  if (live) fake.store.session.set('state', { ...live, inputMode: mode });
}

await test('D-b: the effective level is the stricter of humanize and the tab\'s stealth level (off < human < stealth)', async () => {
  const team = await hzLib.loadProfile('team-unit');
  assert.ok(team, 'the calibrated profile saved by the recorder test above');
  try {
    setInputMode('stealth');
    for (const asked of ['off', 'human']) {
      const hz = await hzLib.levelFor(TAB, { humanize: asked, seed: 1 });
      assert.equal(hz.level, 'stealth', `${asked} is raised on a stealth tab`);
      assert.equal(hz.raisedFrom, asked);
      assert.equal(hz.stealthLevel, 'stealth');
      assert.equal(hz.profile.name, 'stealth', 'a built-in level becomes the built-in stealth profile');
      assert.equal(hz.profile.direct, false);
    }
    const st = await hzLib.levelFor(TAB, { humanize: 'stealth' });
    assert.equal(st.level, 'stealth');
    assert.equal(st.raisedFrom, undefined, 'asking for the floor itself is no raise');
    // A calibrated profile keeps its fitted numbers and only takes the stricter level.
    const cal = await hzLib.levelFor(TAB, { humanize: 'team-unit' });
    assert.equal(cal.level, 'stealth');
    assert.equal(cal.name, 'team-unit');
    assert.equal(cal.profile.level, 'stealth');
    assert.equal(cal.raisedFrom, 'human');
    assert.deepEqual(cal.profile.keyboard, team.keyboard, 'fitted timing kept');
    // A profile object passed down to a sub-action (interact.js does that) stays stealth.
    assert.equal((await hzLib.levelFor(TAB, { humanize: cal.profile })).level, 'stealth');

    // With nothing asked, the panel's Stealth is also the default.
    const dflt = await hzLib.levelFor(TAB, {});
    assert.equal(dflt.level, 'stealth');
    assert.equal(dflt.raisedFrom, undefined);

    // The panel's Human is a DEFAULT, not a floor: only Stealth raises a call.
    setInputMode('human');
    await state.getState();
    assert.equal(platform.settings.humanizeFor(TAB), 'human');
    assert.equal(platform.settings.stealthFor(TAB), 'off', 'Human is not a stealth level');
    const direct = await hzLib.levelFor(TAB, { humanize: 'off' });
    assert.equal(direct.level, 'off', 'humanize:"off" on a Human panel gives direct input');
    assert.equal(direct.raisedFrom, undefined);
    assert.equal(direct.profile.direct, true);
    assert.equal((await hzLib.levelFor(TAB, {})).level, 'human', "a call that names no level runs at the panel's Human");
    const stricter = await hzLib.levelFor(TAB, { humanize: 'stealth' });
    assert.equal(stricter.level, 'stealth', 'a call may always be stricter than the panel');
    assert.equal(stricter.raisedFrom, undefined);

    setInputMode('off');
    await state.getState();
    assert.equal(platform.settings.stealthFor(TAB), 'off');
    const off = await hzLib.levelFor(TAB, { humanize: 'off' });
    assert.equal(off.level, 'off');
    assert.equal(off.raisedFrom, undefined);
    const human = await hzLib.levelFor(TAB, { humanize: 'human' });
    assert.equal(human.level, 'human', 'Direct is a default too: a call may ask for human');
    assert.equal(human.raisedFrom, undefined);
    assert.equal((await hzLib.levelFor(TAB, {})).level, 'off');
  } finally {
    setInputMode('off');
    await state.getState();
  }
});

await test('D-b: on a stealth tab, humanize:"off" gets stealth\'s rules — no scrollIntoView, no DOM.focus, no insertText', async () => {
  setInputMode('stealth');
  try {
    await pointer.setPosition(TAB, 640, 400);
    let mark = since();
    const click = await interact.click(TAB, { ref: 'e1', humanize: 'off', seed: 99 });
    assert.equal(click.delivery, 'delivered');
    assert.equal(click.humanize.level, 'stealth');
    assert.equal(click.humanize.raisedFrom, 'off');
    assert.equal(click.humanize.stealthLevel, 'stealth');
    let cmds = slice(mark);
    assert.ok(mouseOf(cmds).length > 3, 'a travelled pointer path, not v1\'s three events');
    assert.ok(!cmds.some((c) => c.method === 'Runtime.callFunctionOn' && /scrollIntoView/.test(c.params.functionDeclaration ?? '')), 'no programmatic scroll');
    assert.ok(!cmds.some((c) => c.method === 'DOM.focus'), 'no DOM.focus');

    FIELD.value = '';
    mark = since();
    const typed = await interact.type(TAB, { ref: 'e2', text: 'ok', humanize: 'off', typos: false, seed: 5 });
    cmds = slice(mark);
    assert.equal(typed.humanize.level, 'stealth');
    assert.equal(FIELD.value, 'ok');
    assert.ok(!cmds.some((c) => c.method === 'Input.insertText'), 'no insertText without fast:true');
    assert.ok(!cmds.some((c) => c.method === 'DOM.focus'), 'focus was earned by a click, not DOM.focus');
    assert.ok(keysOf(cmds).length >= 4, 'per-key events');
  } finally {
    setInputMode('off');
    await state.getState();
  }
});

await test("D-b: the panel's Human is only a default — humanize:'off' there is direct input, not raised", async () => {
  setInputMode('human');
  try {
    let mark = since();
    const click = await interact.click(TAB, { ref: 'e1', humanize: 'off' });
    assert.equal(click.delivery, 'delivered');
    assert.deepEqual(click.humanize, { level: 'off' }, 'no raisedFrom: nothing was raised');
    const sent = mouseOf(slice(mark)).map((c) => c.params.type);
    assert.deepEqual(sent, ['mouseMoved', 'mousePressed', 'mouseReleased'], "v1's three events, no pointer path");
    // With no level in the call, the panel's Human is what runs.
    await pointer.setPosition(TAB, 640, 400);
    mark = since();
    const dflt = await interact.click(TAB, { ref: 'e1', seed: 3 });
    assert.equal(dflt.humanize.level, 'human');
    assert.equal(dflt.humanize.raisedFrom, undefined);
    assert.ok(mouseOf(slice(mark)).length > 3, 'a travelled pointer path');
  } finally {
    setInputMode('off');
    await state.getState();
  }
});

await test('contract gap: explicit x/y off screen at human level is refused in the tool\'s own terms, before any input', async () => {
  const mark = since();
  for (const [action, fn] of [
    ['click', () => interact.click(TAB, { x: 100, y: 5000, humanize: 'human' })],
    ['hover', () => interact.hover(TAB, { x: -3, y: 10, humanize: 'human' })],
    ['scroll', () => interact.scroll(TAB, { x: 99999, y: 10, humanize: 'human' })],
  ]) {
    await assert.rejects(fn(), (err) => {
      assert.ok(err.message.startsWith(`${action} at (`), err.message);
      assert.match(err.message, /\) is outside the visible viewport \(1280×800 CSS pixels\)/);
      assert.match(err.message, /browser_interact action:"scroll"/);
      assert.doesNotMatch(err.message, /planScroll/, 'no library internals in an agent-facing error');
      return true;
    });
  }
  assert.equal(mouseOf(slice(mark)).length, 0, 'nothing was dispatched');
});

await test('F2: key steps carry their location (left/right modifier) into Input.dispatchKeyEvent', async () => {
  // As the humanize library plans a shifted character: Shift's steps carry location 1.
  const planned = H.planType(H.createRng(3), H.resolveProfile('human'), { text: 'A', field: { password: false, numericMask: false }, typos: false });
  const withLocation = planned.steps.filter((st) => st.kind === 'key' && st.location);
  assert.ok(withLocation.length >= 2, 'the plan has located Shift steps');
  const hand = {
    steps: [
      { at: 0, kind: 'key', type: 'rawKeyDown', key: 'Shift', code: 'ShiftRight', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, modifiers: 8, location: 2 },
      { at: 2, kind: 'key', type: 'keyUp', key: 'Shift', code: 'ShiftRight', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, modifiers: 0, location: 2 },
      { at: 4, kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, text: 'a', modifiers: 0 },
      { at: 6, kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0 },
    ],
    durationMs: 6,
    end: null,
    meta: { kind: 'test' },
  };
  let mark = since();
  await hzLib.perform(TAB, hand);
  const sent = keysOf(slice(mark)).map((c) => c.params);
  assert.deepEqual(sent.map((p) => p.location), [2, 2, undefined, undefined], 'location only where the step has one');
  mark = since();
  await hzLib.perform(TAB, planned);
  const shiftSent = keysOf(slice(mark)).filter((c) => c.params.key === 'Shift').map((c) => c.params.location);
  assert.deepEqual(shiftSent, withLocation.map((st) => st.location));
});

await test('F3: perform() lasts until plan.durationMs — a trailing pause is waited, and Stop still cuts it short', async () => {
  const gap = H.planGap(H.createRng(8), H.resolveProfile('human'), { after: 'action' });
  assert.ok(gap.durationMs >= 200 && gap.steps.length === 1 && gap.steps[0].kind === 'pause');
  let t0 = performance.now();
  const r = await hzLib.perform(TAB, gap);
  let ms = performance.now() - t0;
  assert.ok(ms >= gap.durationMs - 5, `a pause-only plan took ${Math.round(ms)} ms of its ${gap.durationMs}`);
  assert.equal(r.dispatched, 0, 'a pause sends no input');
  assert.ok(r.durationMs >= gap.durationMs - 5);

  // A key at 0 then 300 ms of trailing time: returns after the 300, not after the key.
  const tail = { steps: [{ at: 0, kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a', modifiers: 0 },
    { at: 5, kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0 }], durationMs: 300, end: null, meta: { kind: 'test' } };
  t0 = performance.now();
  await hzLib.perform(TAB, tail);
  ms = performance.now() - t0;
  assert.ok(ms >= 295, `returned after ${Math.round(ms)} ms, before the plan's 300`);

  // Stop during the trailing pause ends it promptly, as a halt.
  const long = { steps: [{ at: 0, kind: 'pause', ms: 3000, reason: 'think' }], durationMs: 3000, end: null, meta: { kind: 'gap' } };
  setTimeout(() => { state.setState({ halted: true }).catch(() => {}); }, 150);
  t0 = performance.now();
  try {
    await assert.rejects(hzLib.perform(TAB, long), (err) => err.halted === true);
    assert.ok(performance.now() - t0 < 1000, 'Stop cut the pause short');
  } finally {
    await state.setState({ halted: false });
  }
});

// ------------------------------------------------------- main-world cleanliness

await test('a slow SERVER is not a stuck browser: goto gives Page.navigate its own deadline (live round 3)', async () => {
  // Page.navigate answers when the response headers arrive. It had the generic 20 s budget, so a
  // goto with timeoutMs 45000–90000 to a server with a 25 s first byte failed at 20 s as "stuck
  // rather than slow — the browser never answered" (stealth and desktop suites, round 3).
  const navigateTool = await import(extUrl('tools/navigate.js'));
  const cdpLib = await import(extUrl('lib/cdp.js'));
  assert.equal(navigateTool.navigationBudget(90_000), 90_000, 'the call\'s own deadline');
  assert.equal(navigateTool.navigationBudget(10_000), cdpLib.COMMAND_TIMEOUT_MS, 'never less than an ordinary command');
  const saved = await refs.getRefs(TAB);
  tab.navigateDelayMs = cdpLib.COMMAND_TIMEOUT_MS + 1_500; // the "server" answers just after the old cut-off
  try {
    const t0 = Date.now();
    const res = await navigateTool.navigate(TAB, { url: 'https://slow.example.test/', timeoutMs: 30_000, humanize: 'off' });
    const took = Date.now() - t0;
    assert.ok(took >= cdpLib.COMMAND_TIMEOUT_MS + 1_000, `it waited for the server (${took} ms)`);
    assert.equal(res.timedOut, false);
    assert.equal(res.readyState, 'complete');
  } finally {
    tab.navigateDelayMs = 0;
    await refs.saveRefs(TAB, { url: saved?.url ?? URL0, entries: Object.entries(saved?.map ?? {}) });
  }
  // When a navigation does run out of time, the message names the server, not the browser.
  const msg = cdpLib.timeoutMessage('Page.navigate', 20_000);
  assert.match(msg, /did not return after 20s/, 'callers match this phrase');
  assert.match(msg, /server most likely did not answer/);
  assert.doesNotMatch(msg, /stuck rather than slow/);
  assert.match(cdpLib.timeoutMessage('Input.dispatchMouseEvent', 20_000), /stuck rather than slow/, 'other commands keep their wording');
});

await test('a snapshot taken before the renderer rebuilt its accessibility tree asks again (CfT popout, live round 3)', async () => {
  // 1 in 11 CfT popouts: the first snapshot after the move had no page in it, and the next click
  // had no ref. A root-only tree on a document whose body has elements is asked for again.
  const snapshotTool = await import(extUrl('tools/snapshot.js'));
  const saved = await refs.getRefs(TAB);
  tab.axNodes = [
    { nodeId: 'ax1', role: { value: 'RootWebArea' }, name: { value: 'Popout' }, childIds: ['ax2'] },
    { nodeId: 'ax2', parentId: 'ax1', role: { value: 'button' }, name: { value: 'Press me' }, backendDOMNodeId: 101, childIds: [] },
  ];
  tab.bodyElements = 3;
  tab.axEmptyCalls = 2;
  try {
    const snap = await snapshotTool.snapshot(TAB, {});
    assert.match(snap.tree, /button "Press me" \[ref=e1\]/, 'the page is in the tree');
    assert.equal(tab.axEmptyCalls, 0, 'it asked until the tree was there');
    // A page that really is empty is not waited on.
    tab.axNodes = null;
    tab.bodyElements = 0;
    const t0 = Date.now();
    await snapshotTool.snapshot(TAB, {});
    assert.ok(Date.now() - t0 < 200, 'an empty body costs no retries');
  } finally {
    tab.axNodes = null;
    tab.bodyElements = 0;
    tab.axEmptyCalls = 0;
    await refs.saveRefs(TAB, { url: saved?.url ?? URL0, entries: Object.entries(saved?.map ?? {}) });
  }
});

await test('replay waits (bounded) for the page to go quiet after the last step, so a late error is always seen', async () => {
  // Desktop render check, round 3: a page that logs an error and fails a request a few ms after the
  // last step gave 3, 3, 2, 3, 3, 3 surprises over six identical replays.
  const { awaitQuiet } = await import(extUrl('tools/replay.js'));
  for (let run = 0; run < 20; run++) {
    const t0 = Date.now();
    const lateAt = Math.floor(Math.random() * 120); // the page reacts 0–120 ms after the last step
    const read = async () => {
      const late = Date.now() - t0 >= lateAt;
      return { consoleSeq: late ? 8 : 7, requests: late ? 4 : 3, pending: late && Date.now() - t0 < lateAt + 80 ? 1 : 0 };
    };
    const q = await awaitQuiet(read, { quietMs: 200, capMs: 2_000, everyMs: 20 });
    assert.equal(q.quiet, true);
    assert.ok(q.waitedMs >= lateAt + 80 + 150, `run ${run}: returned only after the late request settled (${q.waitedMs} ms, late at ${lateAt} ms)`);
  }
  // A page that never stops costs the cap, no more.
  let n = 0;
  const t1 = Date.now();
  const busy = await awaitQuiet(async () => ({ consoleSeq: ++n, requests: 0, pending: 0 }), { quietMs: 200, capMs: 600, everyMs: 20 });
  assert.equal(busy.quiet, false);
  assert.ok(Date.now() - t1 < 1_000);
});

await test('main-world cleanliness: nothing G9 ran touched the page\'s own world', () => {
  // 1. Every evaluation and every node resolution named G9's world.
  const evals = fake.log.filter((c) => c.method === 'Runtime.evaluate');
  assert.ok(evals.length > 20);
  assert.ok(evals.every((c) => c.params.contextId != null), 'no Runtime.evaluate without a contextId');
  const resolves = fake.log.filter((c) => c.method === 'DOM.resolveNode');
  assert.ok(resolves.every((c) => c.params.executionContextId != null), 'no DOM.resolveNode into the main world');
  const ran = fake.log.filter((c) => c.world);
  assert.ok(ran.length > 20);
  // A cached id that went stale in a cross-process navigation can name the
  // page's main world (the recorder test above makes one). There the world
  // guard refuses: it reads one global and throws a STRING — no Error is
  // constructed with the page's own (replaceable) constructor — and nothing
  // else of G9 runs. Those refusals are the only main-world entries allowed.
  const refusals = ran.filter((c) => c.world === 'main' && /G9_STALE_WORLD/.test(c.threw?.text ?? ''));
  assert.ok(refusals.length > 0, 'the stale-id case was exercised');
  assert.ok(refusals.every((c) => c.threw.type === 'string'), 'the guard throws a primitive in the wrong world');
  const inMain = ran.filter((c) => c.world === 'main' && !refusals.includes(c));
  assert.deepEqual(inMain.map((c) => c.method), [], 'no page-side source ran in the main world');
  // 2. Page-side sources that assign to window (__g9loc, __g9target, the
  //    witness state …) all ran in the g9 world.
  const assigning = ran.filter((c) => /\b(window|globalThis)\.__g9\w*\s*=(?!=)/.test(c.params.expression ?? c.params.functionDeclaration ?? ''));
  assert.ok(assigning.length > 0, 'the scan saw the sources that DO assign');
  assert.ok(assigning.every((c) => c.world === 'g9'));
  // 3. The page's own globals: exactly what the page started with, in every
  //    document of every frame that ever existed.
  const mains = fake.allContexts.filter((ctx) => ctx.world === 'main');
  assert.ok(mains.length >= 3, 'several documents were checked');
  for (const ctx of mains) {
    const now = Object.getOwnPropertyNames(ctx.sandbox);
    const added = now.filter((n) => !ctx.baseline.has(n));
    assert.deepEqual(added, [], `main world ${ctx.id} gained ${added.join(', ')}`);
  }
  assert.equal(tab.bareBinding, undefined, 'no binding was ever added to the main world');
  assert.ok(!fake.log.some((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument' && c.params.worldName !== 'g9'));
});

await test('source scan: interaction tools never evaluate in the page\'s main world', () => {
  const files = ['interact.js', 'record.js', 'snapshot.js', 'qa.js', 'replay.js', 'issues.js'];
  for (const name of files) {
    const src = readFileSync(join(EXT, 'tools', name), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\bevaluate\(\s*tab/.test(code), `${name} calls cdp.evaluate (main world)`);
    assert.ok(!/\bcallOnNode\(/.test(code), `${name} calls cdp.callOnNode (main world)`);
    assert.ok(!/'Runtime\.(evaluate|callFunctionOn)'/.test(code), `${name} sends Runtime.evaluate/callFunctionOn directly`);
    assert.ok(!/addScriptToEvaluateOnNewDocument', \{ source \}\)/.test(code), `${name} registers a main-world script`);
    assert.ok(!/'Runtime\.addBinding', \{ name: BINDING \}\)/.test(code), `${name} adds a bare binding`);
  }
});

console.log('interaction: all passed');
