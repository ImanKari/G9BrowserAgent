/**
 * Unit tests for the daemon's pure parts (ARCHITECTURE §12.1): registry
 * (handles, mapping, ownership, queues, halts), tab-id rewriting in both
 * directions, the origin rule, storage.js semantics, settings, handoff cookie
 * conversion, scheduler next-run computation, evidence sniffing, the frame
 * codec, and the router's relay/status composition against an in-process fake
 * extension. No sockets, no browser, no port 8765 — the self-test covers the
 * wire.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { Registry } from '../../daemon/registry.js';
import { Router, rewriteTabIds, fallbackIsReadOnly, timeoutFor, pickStatusTarget, interactInputMs, INPUT_MS_PER_CHAR } from '../../daemon/router.js';
import { classifyOrigin, isExtensionOrigin } from '../../daemon/ws-server.js';
import { MemoryStorageArea, FileStorageArea, FileBlobs, MemoryBlobs, selectKeys, encodeId, decodeId } from '../../daemon/storage.js';
import { Settings, DEFAULTS, mergeSettings, validateSettings } from '../../daemon/settings.js';
import { chromeCookiesToCdp, seedStorageScript, storageEntries, originOf, NOT_TRANSFERRED, handoffNote } from '../../daemon/handoff.js';
import { nextRunAt, validateEntry, runnerArgv, normalizeEntry, overallVerdict, Scheduler } from '../../daemon/scheduler.js';
import { sniffMime, fileInfo, Evidence, newRunId } from '../../daemon/evidence.js';
import { loadProject, projectForClient } from '../../daemon/project.js';
import { FlowLibrary } from '../../daemon/flows.js';
import { encodeFrame, decodeFrame, FrameReader, OP, closeBody, parseCloseBody } from '../../lib/ws-codec.mjs';
import { resolveHome, parsePort, layout } from '../../daemon/paths.js';
import { TOOLS, TOOL_NAMES, INSTRUCTIONS } from '../../mcp/tools.js';
import { adminArgs, summarize, Daemon } from '../../daemon/daemon.js';
import { EventEmitter } from 'node:events';
import { EngineManager } from '../../engine/manager.js';
import { normalizeToolResult } from '../../mcp/mcp.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-daemon-unit-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition (or throw). For tests over real child processes and file I/O. */
async function waitUntil(fn, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > until) throw new Error('timed out waiting for a condition');
    await sleep(25);
  }
}

function agent(reg, name) {
  return reg.addClient({ role: 'agent', name, send: () => true });
}

// ------------------------------------------------------------------ registry

test('registry: client ids per role, describe names the client', () => {
  const reg = new Registry();
  const a = agent(reg, 'cursor');
  const b = agent(reg, 'claude-code');
  const e = reg.addClient({ role: 'engine', version: '2.0.0' });
  const u = reg.addClient({ role: 'ui' });
  assert.deepEqual([a.id, b.id, e.id, u.id], ['agent-1', 'agent-2', 'engine-1', 'ui-1']);
  assert.equal(reg.describe(a.id), 'agent-1 (cursor)');
  assert.equal(reg.nextLaunchedId(), 'launched-1');
  assert.equal(reg.nextLaunchedId(), 'launched-2');
  assert.throws(() => reg.addClient({ role: 'extension' }), /Unknown client role/);
});

test('registry: Chrome tab ids map to daemon-wide handles per engine', () => {
  const reg = new Registry();
  const e1 = reg.addClient({ role: 'engine' });
  const e2 = reg.addClient({ role: 'engine' });
  const h1 = reg.handleForChrome(e1.id, 1234);
  const h2 = reg.handleForChrome(e2.id, 1234); // same Chrome id, another browser
  assert.notEqual(h1, h2);
  assert.equal(reg.handleForChrome(e1.id, 1234), h1, 'stable');
  assert.equal(reg.chromeTabOf(h1), 1234);
  assert.equal(reg.chromeTabOf(h1, e1.id), 1234);
  assert.equal(reg.chromeTabOf(h1, e2.id), null, 'a handle never resolves through another engine');
  assert.equal(reg.engineOf(h2), e2.id);
  assert.equal(reg.handleForChrome(e1.id, 999, { create: false }), null);
  assert.equal(reg.handleForChrome(e1.id, 'x'), null);
  // Engine 2 handles come from the same counter.
  const h3 = reg.allocHandle();
  reg.bindHandle(h3, 'launched-1');
  assert.ok(h3 > h2);
  assert.equal(reg.engineOf(h3), 'launched-1');
  assert.equal(reg.chromeTabOf(h3), null);
  assert.deepEqual(reg.handlesOf(e1.id), [h1]);
});

test('registry: ownership — first mutating call claims, others refused with the owner named', () => {
  const reg = new Registry();
  const a = agent(reg, 'cursor');
  const b = agent(reg, 'claude-code');
  const e = reg.addClient({ role: 'engine' });
  const h = reg.handleForChrome(e.id, 7);
  assert.equal(reg.ensureOwnership(h, a.id).claimed, true);
  assert.equal(reg.ensureOwnership(h, a.id).claimed, false, 'idempotent for the owner');
  assert.throws(() => reg.ensureOwnership(h, b.id), (err) => {
    assert.equal(err.message, `Tab ${h} is owned by agent-1 (cursor). Ask that agent to release it, or call browser_tabs action:"claim" tabId:${h} force:true to take it over.`);
    return true;
  });
  assert.throws(() => reg.claim(h, b.id), /owned by agent-1/);
  let takeover = null;
  reg.on('takeover', (t) => { takeover = t; });
  const forced = reg.claim(h, b.id, { force: true });
  assert.equal(forced.previousOwner, a.id);
  assert.deepEqual(takeover, { tabId: h, from: a.id, to: b.id });
  assert.equal(reg.ownerOf(h), b.id);
  assert.equal(reg.release(h, a.id), false, 'a non-owner cannot release');
  assert.equal(reg.release(h, b.id), true);
  assert.equal(reg.ownerOf(h), null);
});

test('registry: a disconnect releases every claim; an engine disconnect drops its handles', () => {
  const reg = new Registry();
  const a = agent(reg, 'a');
  const e = reg.addClient({ role: 'engine' });
  const h1 = reg.handleForChrome(e.id, 1);
  const h2 = reg.handleForChrome(e.id, 2);
  reg.ensureOwnership(h1, a.id);
  reg.ensureOwnership(h2, a.id);
  assert.deepEqual(reg.ownedBy(a.id), [h1, h2]);
  const { released } = reg.removeClient(a.id);
  assert.deepEqual(released.sort(), [h1, h2]);
  assert.equal(reg.ownerOf(h1), null);
  const b = agent(reg, 'b');
  reg.ensureOwnership(h1, b.id);
  reg.nameSession('buyer', h1);
  reg.setCurrent(b.id, h1);
  const gone = [];
  reg.on('tabGone', (g) => gone.push(g.tabId));
  const out = reg.removeClient(e.id);
  assert.deepEqual(out.dropped.sort(), [h1, h2]);
  assert.deepEqual(gone.sort(), [h1, h2]);
  assert.equal(reg.hasHandle(h1), false);
  assert.equal(reg.ownerOf(h1), null, 'a claim does not outlive its tab');
  assert.throws(() => reg.sessionHandle('buyer'), /No session named "buyer"/);
  assert.equal(reg.current(b.id), null);
});

test('registry: an ownership claim by a disconnected agent does not block others', () => {
  const reg = new Registry();
  const a = agent(reg, 'a');
  const b = agent(reg, 'b');
  const h = reg.allocHandle();
  reg.bindHandle(h, 'launched-1');
  reg.ensureOwnership(h, a.id);
  reg.clients.delete(a.id); // a vanished without removeClient
  assert.equal(reg.ensureOwnership(h, b.id).claimed, true);
});

test('registry: sessions resolve names to handles and die with their tab', () => {
  const reg = new Registry();
  const h = reg.allocHandle();
  reg.bindHandle(h, 'launched-1');
  assert.deepEqual(reg.nameSession('seller', h), { session: 'seller', tabId: h });
  assert.equal(reg.sessionHandle('seller'), h);
  assert.equal(reg.sessionOf(h), 'seller');
  assert.equal(reg.listSessions()[0].engine, 'launched-1');
  assert.throws(() => reg.nameSession('x', 99999), /does not exist/);
  assert.throws(() => reg.nameSession('', h), /needs a name/);
  assert.equal(reg.endSession('seller'), h);
  assert.equal(reg.endSession('seller'), null);
});

test('registry: per-tab queue runs mutating calls strictly one at a time, in order', async () => {
  // Every job ends when the TEST releases it, never on a timer. What is checked here is the
  // queue's ordering, and reading that off sleeps of 30 ms against 1 ms only reproduces it while
  // the machine is idle.
  const reg = new Registry();
  let running = 0;
  let max = 0;
  const order = [];
  const started = new Set();
  const release = new Map(); // label -> resolve
  const job = (label, fail = false) => async () => {
    running += 1;
    max = Math.max(max, running);
    started.add(label);
    await new Promise((r) => release.set(label, r));
    order.push(label);
    running -= 1;
    if (fail) throw new Error(`${label} failed`);
    return label;
  };
  const settling = Promise.allSettled([
    reg.enqueue(1, job('a')),
    reg.enqueue(1, job('b', true)),
    reg.enqueue(1, job('c')),
    reg.enqueue(2, job('other-tab')),
  ]);
  await waitUntil(() => started.has('a') && started.has('other-tab'));
  assert.deepEqual([...started].sort(), ['a', 'other-tab'], 'b and c wait behind a; another tab waits for nothing');
  assert.equal(max, 2, 'only different tabs overlapped');
  release.get('other-tab')(); // ends while a is still running
  await waitUntil(() => order.includes('other-tab'));
  release.get('a')();
  await waitUntil(() => started.has('b'));
  release.get('b')(); // and fails
  await waitUntil(() => started.has('c'));
  release.get('c')();
  const results = await settling;
  assert.equal(results[0].value, 'a');
  assert.equal(results[1].status, 'rejected', 'a failure is its own');
  assert.equal(results[2].value, 'c', 'and does not poison the queue');
  assert.deepEqual(order, ['other-tab', 'a', 'b', 'c'], 'one at a time per tab, in order; the other tab was never blocked');
  assert.equal(max, 2, 'never two jobs of one tab at once');
  await waitUntil(() => reg.queues.size === 0);
  assert.equal(reg.queues.size, 0, 'drained queues are forgotten');
});

test('registry: global halt blocks everyone, an agent halt only that agent', () => {
  const reg = new Registry();
  const a = agent(reg, 'a');
  const b = agent(reg, 'b');
  assert.equal(reg.haltError(a.id), null);
  assert.equal(reg.setGlobalHalt(true, { by: 'panel' }), true);
  assert.equal(reg.setGlobalHalt(true, { by: 'panel' }), false, 'idempotent');
  assert.match(reg.haltError(a.id), /pressed Stop in the G9 side panel/);
  assert.match(reg.haltError(b.id), /cannot lift this yourself/);
  reg.setGlobalHalt(false, { by: 'desktop' });
  assert.equal(reg.haltError(a.id), null);
  reg.setAgentHalt(a.id, true);
  assert.match(reg.haltError(a.id), /stopped this agent \(agent-1 \(a\)\)/);
  assert.equal(reg.haltError(b.id), null);
  reg.setAgentHalt(a.id, false);
  assert.equal(reg.haltError(a.id), null);
  assert.throws(() => reg.setAgentHalt('agent-99', true), /No connected client/);
});

// ------------------------------------------------------------------ id rewriting

test('rewriteTabIds: tabId, openerTabId and tabIds[] at any depth; nothing else; input untouched', () => {
  const input = {
    tabId: 1,
    openerTabId: 2,
    tabIds: [1, 2, 'x'],
    windowId: 1,
    nested: { deeper: [{ tabId: 2, id: 2 }, { tabs: [{ tabId: 1, title: 'tabId' }] }] },
    list: [1, 2],
    notInt: { tabId: 1.5 },
    text: 'tabId: 1',
  };
  const snapshot = JSON.stringify(input);
  const out = rewriteTabIds(input, (n) => n * 100);
  assert.equal(out.tabId, 100);
  assert.equal(out.openerTabId, 200);
  assert.deepEqual(out.tabIds, [100, 200, 'x']);
  assert.equal(out.windowId, 1);
  assert.equal(out.nested.deeper[0].tabId, 200);
  assert.equal(out.nested.deeper[0].id, 2);
  assert.equal(out.nested.deeper[1].tabs[0].tabId, 100);
  assert.deepEqual(out.list, [1, 2]);
  assert.equal(out.notInt.tabId, 1.5);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(rewriteTabIds(null, () => 0), null);
  assert.equal(rewriteTabIds('s', () => 0), 's');
});

test('rewriteTabIds: both directions through the registry, unknown Chrome ids get a new handle', () => {
  const reg = new Registry();
  const e = reg.addClient({ role: 'engine' });
  const h = reg.handleForChrome(e.id, 555);
  const toEngine = rewriteTabIds({ tabId: h, tabIds: [h] }, (n) => reg.chromeTabOf(n, e.id));
  assert.deepEqual(toEngine, { tabId: 555, tabIds: [555] });
  const fromEngine = rewriteTabIds({ tabs: [{ tabId: 555 }, { tabId: 777, openerTabId: 555 }] }, (n) => reg.handleForChrome(e.id, n));
  assert.equal(fromEngine.tabs[0].tabId, h);
  const popup = fromEngine.tabs[1].tabId;
  assert.ok(Number.isInteger(popup) && popup !== h);
  assert.equal(fromEngine.tabs[1].openerTabId, h);
  assert.equal(reg.chromeTabOf(popup), 777);
});

// ------------------------------------------------------------------ router (in-process)

/** A fake extension engine: records what the router sends and answers via the router. */
function fakeExtension(reg, router, responder) {
  const sent = [];
  const client = reg.addClient({ role: 'engine', version: '2.0.0', send: (msg) => {
    sent.push(msg);
    if (msg.type === 'call') {
      queueMicrotask(async () => {
        try {
          const result = await responder(msg);
          router.onRelayResult(client, { type: 'result', id: msg.id, ok: true, result });
        } catch (err) {
          router.onRelayResult(client, { type: 'result', id: msg.id, ok: false, error: err.message });
        }
      });
    }
    return true;
  } });
  return { client, sent };
}

function stubEngines() {
  return {
    list: () => [],
    available: () => false,
    unavailableReason: () => 'stub',
    currentTab: () => null,
    isReadOnlyFn: () => null,
    getRecording: async () => null,
    runTool: async () => { throw new Error('Engine 2 is a stub here'); },
  };
}

function makeRouter(reg) {
  return new Router({
    registry: reg,
    engines: stubEngines(),
    settings: { get: () => ({ ...DEFAULTS }) },
    version: '2.0.0',
    info: () => ({ pid: 1, port: 18001, home: '/tmp/g9', startedAt: Date.now() }),
    timeoutMs: 2_000,
  });
}

test('router: relay rewrites ids both ways and forwards the caller', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'cursor');
  const { client: ext, sent } = fakeExtension(reg, router, (msg) => {
    if (msg.tool === 'browser_tabs') return { tabs: [{ tabId: 41, title: 'A', url: 'https://a/' }, { tabId: 42, openerTabId: 41 }] };
    return { echoedTabId: msg.args.tabId, tabIds: [41, 42], tabId: msg.args.tabId };
  });
  const list = await router.call(a, 'browser_tabs', { action: 'list' });
  assert.equal(list.tabs.length, 2);
  const [h41, h42] = list.tabs.map((t) => t.tabId);
  assert.equal(list.tabs[0].engine, ext.id);
  assert.equal(list.tabs[1].openerTabId, h41);
  const snap = await router.call(a, 'browser_snapshot', { tabId: h42 });
  const call = sent.filter((m) => m.type === 'call').at(-1);
  assert.equal(call.args.tabId, 42, 'the extension receives the Chrome id');
  assert.deepEqual(call.caller, { agentId: a.id, name: 'cursor', relayed: true }, 'relayed calls are tagged (F7)');
  assert.equal(snap.echoedTabId, 42);
  assert.equal(snap.tabId, h42, 'results come back as handles');
  assert.deepEqual(snap.tabIds, [h41, h42]);
});

test('router: ownership refusal between agents, reads always allowed, unknown tabs refused', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  const b = agent(reg, 'b');
  fakeExtension(reg, router, (msg) => (msg.tool === 'browser_tabs' ? { tabs: [{ tabId: 5 }] } : { ok: true, tool: msg.tool }));
  const { tabs } = await router.call(a, 'browser_tabs', { action: 'list' });
  const h = tabs[0].tabId;
  await router.call(a, 'browser_interact', { action: 'click', ref: 'e1', tabId: h });
  assert.equal(reg.ownerOf(h), a.id);
  await assert.rejects(router.call(b, 'browser_interact', { action: 'click', ref: 'e1', tabId: h }), /owned by agent-1 \(a\)/);
  assert.equal((await router.call(b, 'browser_snapshot', { tabId: h })).tool, 'browser_snapshot');
  await assert.rejects(router.call(a, 'browser_snapshot', { tabId: 424242 }), /does not exist/);
  await assert.rejects(router.call(a, 'browser_nope', {}), /Unknown tool/);
  const claimed = await router.call(b, 'browser_tabs', { action: 'claim', tabId: h, force: true });
  assert.equal(claimed.previousOwner, a.id);
  await router.call(b, 'browser_interact', { action: 'click', ref: 'e1', tabId: h });
});

test('router: halts block every tool but browser_status; status composes daemon and engine views', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  const { client: ext } = fakeExtension(reg, router, (msg) => {
    if (msg.tool === 'browser_status') return { engine: 'extension', current: { tabId: 9, title: 'T', url: 'https://t/' }, health: { consoleErrors: 2 } };
    return { ok: true };
  });
  reg.setGlobalHalt(true, { by: 'panel' });
  await assert.rejects(router.call(a, 'browser_snapshot', {}), /pressed Stop/);
  await assert.rejects(router.call(a, 'browser_tabs', { action: 'list' }), /pressed Stop/);
  const status = await router.call(a, 'browser_status', {});
  assert.equal(status.halted.global, true);
  assert.equal(status.halted.by, 'panel');
  assert.equal(status.daemon.version, '2.0.0');
  assert.equal(status.engines[0].engineId, ext.id);
  assert.equal(status.agents[0].id, a.id);
  assert.equal(status.health.consoleErrors, 2, 'engine-local status is carried');
  const handle = reg.handleForChrome(ext.id, 9, { create: false });
  assert.equal(status.current.tabId, handle, 'engine status ids are handles');
  assert.equal(status.you.current, handle, 'the engine target becomes the agent\'s current tab');
  assert.match(status.hint, /Stop/);
  reg.setGlobalHalt(false, { by: 'panel' });
  assert.equal((await router.call(a, 'browser_snapshot', {})).ok, true);
});

test('router: a dialog fails pending calls on that tab, never browser_dialog', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  const never = new Set(['browser_interact', 'browser_dialog']);
  const { client: ext } = fakeExtension(reg, router, (msg) => (never.has(msg.tool) ? new Promise(() => {}) : { tabs: [{ tabId: 3 }] }));
  const { tabs } = await router.call(a, 'browser_tabs', { action: 'list' });
  const h = tabs[0].tabId;
  const click = router.call(a, 'browser_interact', { action: 'click', ref: 'e1', tabId: h });
  const dialogCall = router.call(a, 'browser_dialog', { accept: true, tabId: h });
  await sleep(10);
  router.onEngineEvent(ext.id, 'dialog', { tabId: 3, type: 'alert', message: 'Saved!' });
  await assert.rejects(click, /JavaScript alert \("Saved!"\).*browser_dialog/);
  let settled = false;
  dialogCall.then(() => { settled = true; }, () => { settled = true; });
  await sleep(20);
  assert.equal(settled, false, 'browser_dialog is still waiting for its answer');
  router.failEngine(ext.id, 'gone');
  await assert.rejects(dialogCall, /gone/);
});

test('router: an extension disconnect fails in-flight calls at once', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  const { client: ext } = fakeExtension(reg, router, (msg) => (msg.tool === 'browser_tabs' ? { tabs: [{ tabId: 3 }] } : new Promise(() => {})));
  const { tabs } = await router.call(a, 'browser_tabs', { action: 'list' });
  const pending = router.call(a, 'browser_snapshot', { tabId: tabs[0].tabId });
  await sleep(5);
  const started = Date.now();
  router.failEngine(ext.id, 'The browser extension disconnected mid-call.');
  await assert.rejects(pending, /disconnected mid-call/);
  assert.ok(Date.now() - started < 500);
});

test('router: a tabs push reconciles closed Chrome tabs (after a grace period)', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const e = reg.addClient({ role: 'engine', send: () => true });
  const old = reg.handleForChrome(e.id, 1);
  reg.handles.get(old).createdAt -= 10_000;
  const fresh = reg.handleForChrome(e.id, 2);
  router.onEngineEvent(e.id, 'tabs', { tabs: [{ tabId: 3 }] });
  assert.equal(reg.hasHandle(old), false, 'an old tab missing from the list is gone');
  assert.equal(reg.hasHandle(fresh), true, 'a handle learned a moment ago survives a stale push');
});

test('router: popout relays focus and geometry to the extension (an agent\'s focus:true was dropped before 2.0.3)', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  const { sent } = fakeExtension(reg, router, (msg) => (msg.tool === 'browser_tabs' && msg.args.action === 'list'
    ? { tabs: [{ tabId: 7 }] }
    : { tabId: msg.args.tabId, windowId: 99, focused: msg.args.focus === true, visible: true }));
  const { tabs } = await router.call(a, 'browser_tabs', { action: 'list' });
  const h = tabs[0].tabId;
  const res = await router.call(a, 'browser_tabs', { action: 'popout', tabId: h, focus: true, width: 900, height: 700 });
  const relayed = sent.filter((m) => m.type === 'call' && m.args.action === 'popout').at(-1);
  assert.equal(relayed.args.focus, true, 'focus reaches the extension');
  assert.equal(relayed.args.width, 900);
  assert.equal(relayed.args.height, 700);
  assert.equal(relayed.args.tabId, 7, 'the extension receives the Chrome id');
  assert.equal(res.focused, true);
  assert.equal(res.tabId, h, 'the result comes back as a handle');
});

test('router: popout/handoff refuse launched tabs with the documented reason; no engine → actionable error', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  await assert.rejects(router.call(a, 'browser_snapshot', {}), /No browser engine is available/);
  const h = reg.allocHandle();
  reg.bindHandle(h, 'launched-1');
  reg.addLaunchedEngine({ engineId: 'launched-1' });
  await assert.rejects(router.call(a, 'browser_tabs', { action: 'popout', tabId: h }), /Engine 1 \(extension\) action; launched engines have no windows/);
  await assert.rejects(router.call(a, 'browser_tabs', { action: 'handoff', tabId: h }), /already runs in a launched engine/);
  await assert.rejects(router.call(a, 'browser_tabs', { action: 'close' }), /needs a tabId/);
  await assert.rejects(router.call(a, 'browser_tabs', { action: 'bogus' }), /Unknown tabs action "bogus"/);
});

test('router helpers: timeouts follow the call, fallback read-only is conservative, status target', () => {
  assert.equal(timeoutFor('browser_snapshot', {}, 120_000), 120_000);
  assert.ok(timeoutFor('browser_recording', { action: 'replay' }, 120_000) >= 30 * 60_000);
  assert.equal(timeoutFor('browser_navigate', { action: 'wait', timeoutMs: 200_000 }, 120_000), 215_000);
  assert.equal(timeoutFor('browser_diagnose', { what: 'performance', durationMs: 90_000 }, 120_000), 150_000);
  assert.ok(timeoutFor('browser_engine', { action: 'versions', download: true }) >= 30 * 60_000);
  assert.equal(fallbackIsReadOnly('browser_snapshot', {}), true);
  assert.equal(fallbackIsReadOnly('browser_console', { action: 'evaluate' }), false);
  assert.equal(fallbackIsReadOnly('browser_console', { clear: true }), false);
  assert.equal(fallbackIsReadOnly('browser_network', {}), true);
  assert.equal(fallbackIsReadOnly('browser_network', { action: 'intercept' }), false);
  assert.equal(fallbackIsReadOnly('browser_interact', { action: 'hover' }), false);
  assert.equal(fallbackIsReadOnly('browser_recording', { action: 'replay' }), false);
  assert.equal(fallbackIsReadOnly('browser_recording', {}), true);
  assert.equal(pickStatusTarget({ current: { tabId: 4 } }), 4);
  assert.equal(pickStatusTarget({ attached: { tabId: 5 } }), 5);
  assert.equal(pickStatusTarget({ current: null }), null);
  assert.equal(pickStatusTarget(null), null);
});

test('admin args: spread or enveloped, and a schedule entry id never collides with the request id', () => {
  assert.deepEqual(adminArgs({ type: 'admin', id: 5, op: 'watch', tabId: 3 }), { tabId: 3 });
  assert.deepEqual(adminArgs({ type: 'admin', id: 5, op: 'watch', args: { tabId: 4 } }), { tabId: 4 }, 'args wins');
  assert.deepEqual(adminArgs({ type: 'admin', id: 5, op: 'schedule.remove', entryId: 'sch_1' }), { id: 'sch_1' });
  assert.deepEqual(adminArgs({ type: 'admin', id: 5, op: 'schedule.runNow', args: { id: 'sch_2' } }), { id: 'sch_2' });
  assert.deepEqual(adminArgs({ type: 'admin', id: 'sch_x', op: 'schedule.remove' }), {}, 'the request id is never read as an entry id');
  // The desktop's builder sends both forms at once (desktop/lib/daemon-client.mjs buildAdminMessage).
  assert.deepEqual(
    adminArgs({ type: 'admin', id: 9, op: 'schedule.add', target: 'all', daily: '02:00', args: { target: 'all', daily: '02:00', args: ['--env', 'x'] } }),
    { target: 'all', daily: '02:00', args: ['--env', 'x'] },
  );
  assert.deepEqual(
    adminArgs({ type: 'admin', id: 9, op: 'schedule.add', target: 'all', everyMinutes: 5, args: ['--quiet'] }),
    { target: 'all', everyMinutes: 5, args: ['--quiet'] },
    'an array args is the entry\'s own runner arguments',
  );
  assert.equal(summarize('browser_interact', { action: 'click', ref: 'e1', tabId: 3 }), 'browser_interact(click e1 tab 3)');
  assert.equal(summarize('browser_status', {}), 'browser_status');
});

test('router: sessions name tabs across tools; end_session keeps the tab', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  const { sent } = fakeExtension(reg, router, (msg) => (msg.tool === 'browser_tabs' && msg.args.action === 'open'
    ? { tabId: 88, url: msg.args.url }
    : msg.tool === 'browser_tabs' ? { tabs: [{ tabId: 88, title: 'Buyer', url: 'https://shop/' }] } : { tool: msg.tool, tabId: msg.args.tabId }));
  const opened = await router.call(a, 'browser_tabs', { action: 'session', name: 'buyer', url: 'https://shop/' });
  assert.equal(opened.session, 'buyer');
  const h = opened.tabId;
  const snap = await router.call(a, 'browser_snapshot', { session: 'buyer' });
  assert.equal(snap.tabId, h);
  assert.equal(sent.filter((m) => m.type === 'call').at(-1).args.session, undefined, 'routing args are not forwarded');
  const again = await router.call(a, 'browser_tabs', { action: 'session', name: 'buyer', url: 'https://shop/cart' });
  assert.equal(again.reused, true, 'a session with a url re-points its tab instead of opening another');
  assert.equal(again.tabId, h);
  const rows = (await router.call(a, 'browser_tabs', { action: 'sessions' })).sessions;
  assert.equal(rows[0].session, 'buyer');
  assert.equal(rows[0].alive, true);
  const ended = await router.call(a, 'browser_tabs', { action: 'end_session', name: 'buyer' });
  assert.equal(ended.ended, true);
  assert.equal(reg.hasHandle(h), true, 'the tab is still there');
  await assert.rejects(router.call(a, 'browser_snapshot', { session: 'buyer' }), /No session named "buyer"/);
});

test('router: tab-free store actions merge lists and fall through to the store that has the id', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  router.engines = {
    ...stubEngines(),
    available: () => true,
    runTool: async (tool, args) => {
      if (args.action === 'list') return { recordings: [{ id: 'rec_L', name: 'launched one' }] };
      if (args.action === 'get' && args.id === 'rec_L') return { id: 'rec_L', steps: [] };
      throw new Error(`No recording with id "${args.id}".`);
    },
  };
  const a = agent(reg, 'a');
  fakeExtension(reg, router, (msg) => {
    if (msg.args.action === 'list') return { recordings: [{ id: 'rec_E', name: 'extension one' }] };
    if (msg.args.action === 'get' && msg.args.id === 'rec_E') return { id: 'rec_E', steps: [] };
    throw new Error(`No recording with id "${msg.args.id}".`);
  });
  const list = await router.call(a, 'browser_recording', { action: 'list' });
  assert.deepEqual(list.recordings.map((r) => `${r.id}@${r.engine}`).sort(), ['rec_E@extension', 'rec_L@launched']);
  assert.equal((await router.call(a, 'browser_recording', { action: 'get', id: 'rec_L' })).engine, 'launched');
  assert.equal((await router.call(a, 'browser_recording', { action: 'get', id: 'rec_E' })).engine, 'extension');
  await assert.rejects(router.call(a, 'browser_recording', { action: 'get', id: 'nope' }), /No recording with id "nope"/);
  await assert.rejects(router.call(a, 'browser_recording', { action: 'get', id: 'rec_L', engine: 'bogus' }), /Unknown engine/);
});

test('engine manager: maxParallel caps concurrent MUTATING Engine 2 calls; reads are never held', async () => {
  const reg = new Registry();
  const m = new EngineManager({ home: TMP, registry: reg, settings: { get: () => ({ ...DEFAULTS, maxParallel: 2 }) } });
  let running = 0;
  let max = 0;
  let readsRunning = 0;
  let maxWithReads = 0;
  // Stand in for the shared tool runtime, as init() would have loaded it.
  m.ready = Promise.resolve();
  m.cdp = { tabInfo: () => null };
  m.tools = {
    isReadOnly: (tool) => tool === 'browser_snapshot',
    runTool: async (tool) => {
      if (tool === 'browser_snapshot') {
        readsRunning += 1;
        maxWithReads = Math.max(maxWithReads, running + readsRunning);
        await sleep(20);
        readsRunning -= 1;
        return { read: true };
      }
      running += 1;
      max = Math.max(max, running);
      await sleep(30);
      running -= 1;
      return { ok: true };
    },
  };
  const writes = Array.from({ length: 6 }, () => m.runTool('browser_interact', { action: 'click' }));
  await sleep(5);
  const reads = Array.from({ length: 3 }, () => m.runTool('browser_snapshot', {}));
  const results = await Promise.all([...writes, ...reads]);
  assert.equal(results.length, 9);
  assert.equal(max, 2, 'never more than maxParallel mutating calls at once');
  assert.ok(maxWithReads > 2, 'reads ran alongside the capped writes');
  assert.equal(m.active, 0, 'every slot handed back');
  assert.deepEqual(m.list(), []);
  assert.equal(m.owns(123), false);
  const cold = new EngineManager({ home: TMP, registry: reg });
  cold.ready = Promise.resolve();
  cold.initError = new Error('module missing');
  await assert.rejects(cold.runTool('browser_snapshot', {}), /Launched browsers \(Engine 2\) are unavailable.*module missing/);
  assert.equal(cold.available(), false);
});

test('engine manager: a profile signed in to a browser account is refused at stealth, BEFORE any browser starts', async () => {
  // Live round 2: Edge signed new profiles into the Windows account and synced passwords, history,
  // tabs and extensions; synced extensions injected scripts into every stealth page. launch.js now
  // prevents it for new profiles; a profile already signed in is caught here.
  const home = fs.mkdtempSync(path.join(TMP, 'signin-'));
  const reg = new Registry();
  const m = new EngineManager({ home, registry: reg, settings: { get: () => ({ ...DEFAULTS }) } });
  m.ready = Promise.resolve();
  m.cdp = { tabInfo: () => null };
  const dir = path.join(home, 'profiles', 'persona');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { user_name: 'owner@live.example', edge_account_cid: 'c1' } } } }));
  await assert.rejects(
    m.launch({ profile: 'persona', stealth: 'stealth', browser: { kind: 'chrome', path: path.join(home, 'no-such-browser.exe') } }),
    (err) => /signed in to a browser account/.test(err.message) && /Refused at stealth/.test(err.message) && !err.message.includes('owner@live.example'),
  );
  assert.deepEqual(m.list(), [], 'nothing was launched');
  // Below stealth it is a warning, and the launch goes on (here it then fails on the missing browser, by design of the test).
  await assert.rejects(
    m.launch({ profile: 'persona', stealth: 'off', browser: { kind: 'chrome', path: path.join(home, 'no-such-browser.exe') } }),
    (err) => !/signed in to a browser account/.test(err.message),
  );
});

test('engine manager: a launch locale becomes the profile\'s languages and persona; the previous session is cleared', async () => {
  // Live round 2: locale de-DE gave Intl de-DE but navigator.languages ['en-US','en'] and
  // Accept-Language en-US (6/6); CfT reopened the previous run's tabs on every relaunch.
  const home = fs.mkdtempSync(path.join(TMP, 'locale-'));
  const reg = new Registry();
  const m = new EngineManager({ home, registry: reg, settings: { get: () => ({ ...DEFAULTS }) } });
  m.ready = Promise.resolve();
  m.cdp = { tabInfo: () => null };
  const dir = path.join(home, 'profiles', 'de');
  fs.mkdirSync(path.join(dir, 'Default', 'Sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Default', 'Sessions', 'Tabs_1'), 'old tabs');
  // A warmed profile that already has languages (an existing profile ignores --lang).
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ intl: { accept_languages: 'en-US,en', selected_languages: 'en-US,en' }, keep: 1 }));
  const missing = { kind: 'chrome', path: path.join(home, 'no-such-browser.exe') };
  await assert.rejects(m.launch({ profile: 'de', locale: 'de-DE', timezone: 'Europe/Berlin', browser: missing }));
  const prefs = JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'));
  assert.equal(prefs.intl.accept_languages, 'de-DE,de', 'navigator.languages / Accept-Language follow the locale');
  assert.equal(prefs.intl.selected_languages, 'de-DE,de', 'and the list Chrome recomputes them from');
  assert.equal(prefs.keep, 1, 'other preferences untouched');
  const meta = JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'de.json'), 'utf8'));
  assert.equal(meta.locale, 'de-DE', 'the persona keeps its locale');
  assert.equal(meta.timezone, 'Europe/Berlin');
  assert.equal(meta.acceptLanguage, 'de-DE,de');
  assert.equal(fs.existsSync(path.join(dir, 'Default', 'Sessions')), false, 'the previous session will not be restored');
  // Edge's own edge://downloads-hub/ tab after a download is suppressed by this preference (measured).
  assert.equal(prefs.browser.show_hub_popup_on_download_start, false);
});

test('engine manager: a new tab gets the tool layer\'s attach BEFORE its first navigation; browser-internal tabs are never a default', async () => {
  // Engine 2 live test: openTab navigated before lib/cdp.js attach (domains, auto-attach), so the
  // first load's requests were missing from browser_network/diagnose and a cross-origin iframe was
  // never attached; and Edge's own edge://downloads-hub/ tab became an agent's default tab.
  const reg = new Registry();
  const m = new EngineManager({ home: TMP, registry: reg, settings: { get: () => ({ ...DEFAULTS }) } });
  const order = [];
  const tabs = new Map([[501, { url: 'about:blank' }], [502, { url: 'edge://downloads-hub/' }]]);
  m.ready = Promise.resolve();
  m.cdp = {
    tabInfo: (id) => (tabs.has(id) ? { engineId: 'launched-7', browserContextId: null, url: tabs.get(id).url } : null),
    createTab: async () => ({ id: 501 }),
    platform: {
      debugger: { attach: async () => {}, sendCommand: async () => ({}) },
      tabs: {
        get: async (id) => ({ id, ...tabs.get(id), active: true }),
        update: async (id, { url }) => { order.push(`navigate ${url}`); tabs.get(id).url = url; },
      },
    },
  };
  m.optional.cdpLayer = { attach: async (id) => { order.push(`tool attach ${id}`); } };
  m.optional.tabsTool = { isAttachable: (url) => !/^edge:/.test(url) };
  m.engines.set('launched-7', { info: { engineId: 'launched-7', stealth: 'off', humanize: 'human' }, conn: { send: async () => ({}) }, contexts: new Map(), defaultContextId: 'D', initialBlank: null });
  reg.addLaunchedEngine({ engineId: 'launched-7' });
  const opened = await m.openTab('launched-7', null, 'http://127.0.0.1:18001/page');
  assert.equal(opened.tabId, 501);
  // Exactly once, from openTab — never from #applyTabDefaults, which also runs for the start-up tab
  // before its context (its stealth level) is registered: lib/cdp.js then enabled Runtime at
  // stealth (live round 3, the self-test's console probe, every stealth run).
  assert.deepEqual(order, ['tool attach 501', 'navigate http://127.0.0.1:18001/page'], 'domains are on before the first document loads');
  // The downloads hub (opened by Edge, newest handle) is listed as not attachable and never the default.
  reg.bindHandle(502, 'launched-7');
  m.lastTabId = 502;
  assert.equal(m.isControllable(502), false);
  assert.equal(m.currentTab(), 501, 'the newest CONTROLLABLE tab');
  const rows = await m.listTabs();
  assert.equal(rows.find((r) => r.tabId === 502)?.attachable, false);
  assert.equal(rows.find((r) => r.tabId === 501)?.attachable, true);
});

test('engine manager: a NEW target is prepared while platform-cdp holds it — defaults then tool layer, once; frames get the persona', async () => {
  // Live round 3: a tab the PAGE opened got its defaults only after its first document ran (the
  // persona's timezone arrived late, the first load's network was missing) and a window.open()
  // popup wedged its opener; a cross-site iframe kept the host's time zone. platform-cdp now holds
  // every new target and calls these hooks before resuming it.
  const reg = new Registry();
  const m = new EngineManager({ home: TMP, registry: reg, settings: { get: () => ({ ...DEFAULTS }) } });
  const order = [];
  let hooks = null;
  const tabs = new Map([[601, { url: '' }], [602, { url: 'edge://downloads-hub/' }], [603, { url: '' }]]);
  m.ready = Promise.resolve();
  m.cdp = {
    configure: (opts) => { hooks = opts; },
    tabInfo: (id) => (tabs.has(id) ? { engineId: id === 603 ? 'launched-9' : 'launched-8', browserContextId: 'D', url: tabs.get(id).url } : null),
    platform: {
      debugger: {
        attach: async () => {},
        sendCommand: async (tabId, method, params, sessionId) => { order.push(`${tabId}${sessionId ? `/${sessionId}` : ''} ${method}${params?.timezoneId ? ` ${params.timezoneId}` : ''}${params?.locale ? ` ${params.locale}` : ''}`); return {}; },
      },
    },
  };
  m.optional.cdpLayer = {
    attach: async (id) => { order.push(`${id} tool attach (awaited)`); },
    attachHeld: (id) => { order.push(`${id} tool attach`); return new Promise((r) => setTimeout(r, 30)); },
  };
  m.optional.tabsTool = { isAttachable: (url) => !/^edge:/.test(url) };
  const ctx = { contextId: 'D', isDefault: true, locale: 'de-DE', timezone: 'Europe/Berlin', stealth: 'stealth', humanize: 'stealth' };
  m.engines.set('launched-8', { info: { engineId: 'launched-8', stealth: 'stealth' }, contexts: new Map([['D', ctx]]), defaultContextId: 'D', ready: true });
  m.engines.set('launched-9', { info: { engineId: 'launched-9', stealth: 'stealth' }, contexts: new Map([['D', ctx]]), defaultContextId: 'D', ready: false });
  m.reconfigure();
  assert.equal(typeof hooks?.prepareTab, 'function', 'the hooks are handed to platform-cdp');
  // Live round 4: a target=_blank tab answers NOTHING while held, so the commands are SENT before
  // the resume and their answers are not waited for (they are applied in order before it runs).
  const returned = hooks.prepareTab(601);
  assert.equal(returned, undefined, 'returns at once: platform-cdp may resume the page right after');
  assert.deepEqual(order, [
    '601 Emulation.setFocusEmulationEnabled',
    '601 Emulation.setLocaleOverride de-DE',
    '601 Emulation.setTimezoneOverride Europe/Berlin',
    '601 tool attach',
  ], 'the persona and the tool layer, in that order, on the wire before the resume');
  assert.ok(m.prepared.get(601) instanceof Promise, 'the answers are kept for openTab to wait on');
  await m.prepared.get(601);
  order.length = 0;
  await hooks.prepareTab(601);
  assert.deepEqual(order, [], 'once per tab');
  await hooks.prepareTab(602);
  assert.ok(!order.includes('602 tool attach'), 'a browser-internal page gets no tool layer');
  order.length = 0;
  await hooks.prepareTab(603);
  assert.deepEqual(order, [], 'an engine still being registered: its start-up tab is left to the launch (its stealth level is not known yet)');
  // A cross-site iframe: the persona on ITS session, and its own frames held too.
  assert.equal(hooks.prepareChild(601, { sessionId: 'C1', targetInfo: { type: 'iframe' } }), undefined);
  assert.deepEqual(order, [
    '601/C1 Emulation.setLocaleOverride de-DE',
    '601/C1 Emulation.setTimezoneOverride Europe/Berlin',
    '601/C1 Target.setAutoAttach',
  ]);
  order.length = 0;
  await hooks.prepareChild(601, { sessionId: 'W1', targetInfo: { type: 'worker' } });
  assert.deepEqual(order, [], 'a worker shares its page\'s process settings');
});

test('engine manager: a replay\'s evidence result keeps its WARNINGS (why it passed with warnings)', async () => {
  // Desktop render check, round 3 (every replay): result.json had the verdict PASS_WITH_WARNING and
  // not the warnings, so the Runs view could only say "their text was not kept".
  const reg = new Registry();
  const finished = [];
  const evidence = {
    startRun: async () => ({ runId: 'r1', dir: path.join(TMP, 'runs', 'r1') }),
    finishRun: async (runId, result) => { finished.push({ runId, result }); return { frames: 0 }; },
  };
  const m = new EngineManager({ home: TMP, registry: reg, evidence, settings: { get: () => ({ ...DEFAULTS }) } });
  m.ready = Promise.resolve();
  m.cdp = { tabInfo: (id) => (id === 701 ? { engineId: 'launched-3', browserContextId: null, url: 'https://x.test/' } : null) };
  m.tools = {
    isReadOnly: () => false,
    runTool: async () => ({
      verdict: 'PASS_WITH_WARNING', passed: 5, failed: 0, total: 5,
      warnings: ['step 2/5 (type) matched only by css. Its stable identifiers no longer work.'],
      steps: [{ step: 1, ok: true }, { step: 2, ok: true, matchedBy: 'css' }],
      surpriseCount: { total: 1, fail: 0, warn: 1, info: 0 },
    }),
  };
  const out = await m.runTool('browser_recording', { action: 'replay', id: 'f1', tabId: 701 });
  assert.equal(out.evidence.runId, 'r1');
  const kept = finished.find((f) => f.runId === 'r1')?.result;
  assert.deepEqual(kept.warnings, ['step 2/5 (type) matched only by css. Its stable identifiers no longer work.']);
  assert.equal(kept.verdict, 'PASS_WITH_WARNING');
  assert.equal(kept.steps.length, 2);
  assert.deepEqual(kept.surpriseCount, { total: 1, fail: 0, warn: 1, info: 0 });
});

test('engine manager: a context locale in another language than the profile is refused at stealth, warned otherwise', async () => {
  // Measured (Edge 153): a per-tab acceptLanguage override reaches the page but not its dedicated
  // worker (still en-US) — so a context cannot honestly speak another language than its profile.
  const reg = new Registry();
  const m = new EngineManager({ home: TMP, registry: reg, settings: { get: () => ({ ...DEFAULTS }) } });
  m.ready = Promise.resolve();
  m.cdp = { tabInfo: () => null, registerContext: () => {} };
  let n = 0;
  m.engines.set('launched-9', {
    info: { engineId: 'launched-9', stealth: 'stealth', humanize: 'stealth', acceptLanguage: 'en-US,en' },
    conn: { send: async () => ({ browserContextId: `CTX${++n}` }) },
    contexts: new Map(),
  });
  await assert.rejects(m.createContext('launched-9', { locale: 'de-DE', timezone: 'Europe/Berlin' }), (err) =>
    /Accept-Language starts with "en-US" but the locale is "de-DE"/.test(err.message) && /Refused at stealth/.test(err.message) && /launch a profile with this locale/.test(err.message));
  const warned = await m.createContext('launched-9', { locale: 'de-DE', timezone: 'Europe/Berlin', stealth: 'off' });
  assert.ok(warned.warnings.some((w) => /stay the profile's \(en-US,en\)/.test(w)));
  const same = await m.createContext('launched-9', { locale: 'en-US', timezone: 'America/New_York' });
  assert.equal(same.warnings, undefined, 'the profile\'s own language: nothing to say');
  const region = await m.createContext('launched-9', { locale: 'en-GB', timezone: 'Europe/London' });
  assert.ok(region.warnings.some((w) => /same language, different region/.test(w)), 'another region of the same language is a warning, not a refusal');
});

test('engine manager: a WAIT holds no maxParallel slot — another agent\'s click is not queued behind it (P8 bench)', async () => {
  // Round 2: maxParallel 1, agent A waiting 8 s for text that never appears; agent B's click took
  // 7633 ms instead of 67 ms. The manager asks tools/index.js holdsSlot (seam.test checks the predicate).
  //
  // What is checked is the ORDER, not a millisecond budget: the wait ends when this test says so
  // and not before, so a click that finishes first cannot have been queued behind it. The old form
  // asked for clickMs < 200 against a 400 ms sleep, which says the same thing only on an idle
  // machine — it was seen at 320 ms under load. The 10 s below is no budget on the click (its whole
  // body is one 10 ms sleep): it is what makes a click that IS queued behind the wait fail this
  // test instead of hanging it for ever.
  const reg = new Registry();
  const m = new EngineManager({ home: TMP, registry: reg, settings: { get: () => ({ ...DEFAULTS, maxParallel: 1 }) } });
  m.ready = Promise.resolve();
  m.cdp = { tabInfo: () => null };
  let waitingNow = false;
  let endTheWait;
  m.tools = {
    isReadOnly: (tool) => tool === 'browser_snapshot',
    holdsSlot: (tool, args) => !(tool === 'browser_snapshot' || (tool === 'browser_navigate' && args.action === 'wait')),
    runTool: async (tool, args) => {
      if (tool === 'browser_navigate' && args.action === 'wait') {
        waitingNow = true;
        await new Promise((r) => { endTheWait = r; });
        waitingNow = false;
        return { waited: true };
      }
      await sleep(10);
      return { ok: true };
    },
  };
  const waiting = m.runTool('browser_navigate', { action: 'wait', text: 'never' });
  await waitUntil(() => waitingNow);
  assert.equal(m.active, 0, 'the wait took no maxParallel slot');
  const wedged = (ms, value) => new Promise((r) => { const t = setTimeout(() => r(value), ms); t.unref?.(); });
  const first = await Promise.race([
    m.runTool('browser_interact', { action: 'click' }).then(() => 'click'),
    waiting.then(() => 'the wait finished first'),
    wedged(10_000, 'neither finished in 10 s: the click was queued behind the wait'),
  ]);
  assert.equal(first, 'click', 'the click ran and finished while the wait was still waiting');
  endTheWait();
  await waiting;
  assert.equal(m.active, 0);
  // Without the predicate (an older tool runtime), every mutating call is gated, as before.
  delete m.tools.holdsSlot;
  assert.equal(m.holdsSlot('browser_navigate', { action: 'wait' }), true);
  assert.equal(m.holdsSlot('browser_snapshot', {}), false);
});

// ------------------------------------------------------------------ origin rule

test('origin rule: extensions and native clients in, web pages and unknown schemes out', () => {
  for (const o of [undefined, null, '']) assert.deepEqual(classifyOrigin(o), { ok: true, kind: 'native' });
  // A sandboxed iframe or a file:// page sends the literal "null" (desktop review, 2026-09-22):
  // a web page, refused — native clients send no Origin header at all.
  for (const o of ['null', 'NULL', ' null ']) assert.deepEqual(classifyOrigin(o), { ok: false, kind: 'opaque' }, o);
  for (const o of ['chrome-extension://abcdefghijklmnop', 'edge-extension://abc', 'moz-extension://1234-5678', 'extension://abc', 'chrome-extension://test']) {
    assert.deepEqual(classifyOrigin(o), { ok: true, kind: 'extension' }, o);
    assert.equal(isExtensionOrigin(o), true);
  }
  for (const o of ['http://evil.example', 'https://evil.example', 'HTTPS://X', 'http://127.0.0.1:8765']) {
    assert.deepEqual(classifyOrigin(o), { ok: false, kind: 'web' }, o);
  }
  for (const o of ['file://', 'vscode-webview://x', 'chrome-extension://', 'data:text/html,x', 'chrome://newtab']) {
    assert.equal(classifyOrigin(o).ok, false, o);
  }
  assert.equal(isExtensionOrigin('https://x'), false);
});

// ------------------------------------------------------------------ storage

test('storage: chrome.storage get/set/remove semantics', async () => {
  const s = new MemoryStorageArea();
  await s.set({ a: 1, b: { c: [1, 2] }, u: undefined });
  assert.deepEqual(await s.get(null), { a: 1, b: { c: [1, 2] } });
  assert.deepEqual(await s.get(), { a: 1, b: { c: [1, 2] } });
  assert.deepEqual(await s.get('a'), { a: 1 });
  assert.deepEqual(await s.get('missing'), {});
  assert.deepEqual(await s.get(['a', 'missing']), { a: 1 });
  assert.deepEqual(await s.get({ a: 0, z: 'fallback' }), { a: 1, z: 'fallback' });
  const got = await s.get('b');
  got.b.c.push(3);
  assert.deepEqual((await s.get('b')).b.c, [1, 2], 'get returns a copy');
  const value = { x: 1 };
  await s.set({ v: value });
  value.x = 2;
  assert.equal((await s.get('v')).v.x, 1, 'set stores a copy');
  await s.remove('a');
  await s.remove(['v', 'nope']);
  assert.deepEqual(await s.getKeys(), ['b']);
  await s.clear();
  assert.deepEqual(await s.get(null), {});
  await assert.rejects(s.set('x'), /object/);
  assert.throws(() => selectKeys({}, 42), /keys must be/);
});

test('storage: file-backed area persists atomically and survives a corrupt file', async () => {
  const file = path.join(TMP, 'kv', 'kv-local.json');
  const a = new FileStorageArea(file);
  await Promise.all([a.set({ one: 1 }), a.set({ two: 2 }), a.set({ three: [3] })]);
  await a.remove('two');
  const b = new FileStorageArea(file);
  assert.deepEqual(await b.get(null), { one: 1, three: [3] });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp-')), [], 'no temp files left behind');
  fs.writeFileSync(file, '{broken');
  const logs = [];
  const c = new FileStorageArea(file, { log: (m) => logs.push(m) });
  assert.deepEqual(await c.get(null), {});
  assert.ok(fs.readdirSync(path.dirname(file)).some((n) => n.includes('.corrupt-')), 'the bad file is kept for a human');
  assert.match(logs[0], /unreadable/);
});

test('storage: file blobs — put/get/byIndex/deleteByIndex, ids with ":" are file-safe', async () => {
  const dir = path.join(TMP, 'blobs');
  const blobs = new FileBlobs(dir);
  await blobs.put('video-frames', { id: 'sess1:000001', sessionId: 'sess1', seq: 1, blob: new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/jpeg' }) });
  await blobs.put('video-frames', { id: 'sess1:000002', sessionId: 'sess1', seq: 2, blob: Uint8Array.from([4, 5]) });
  await blobs.put('video-frames', { id: 'sess2:000001', sessionId: 'sess2', seq: 1 });
  await blobs.put('blobs', { id: 'att_1', owner: 'iss_1', name: 'a.txt', mime: 'text/plain', blob: new Blob(['hello'], { type: 'text/plain' }) });
  const one = await blobs.get('video-frames', 'sess1:000001');
  assert.equal(one.sessionId, 'sess1');
  assert.ok(one.blob instanceof Blob);
  assert.equal(one.blob.type, 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await one.blob.arrayBuffer())], [1, 2, 3]);
  const reopened = new FileBlobs(dir);
  const frames = await reopened.byIndex('video-frames', 'sessionId', 'sess1');
  assert.deepEqual(frames.map((f) => f.seq).sort(), [1, 2]);
  assert.equal((await reopened.get('video-frames', 'sess2:000001')).blob, undefined, 'a record without bytes has no blob');
  assert.equal(await (await reopened.get('blobs', 'att_1')).blob.text(), 'hello');
  assert.equal(await reopened.deleteByIndex('video-frames', 'sessionId', 'sess1'), 2);
  assert.equal(await reopened.get('video-frames', 'sess1:000001'), null);
  await reopened.delete('blobs', 'att_1');
  assert.equal(await new FileBlobs(dir).get('blobs', 'att_1'), null);
  assert.ok(!fs.readdirSync(path.join(dir, 'video-frames')).some((n) => n.includes(':')), 'no ":" in file names');
  await assert.rejects(blobs.put('../evil', { id: 'x' }), /Invalid blob store/);
  assert.equal(decodeId(encodeId('a:b/c d')), 'a:b/c d');
  const mem = new MemoryBlobs();
  await mem.put('blobs', { id: 'm', owner: 'o', blob: Uint8Array.from([9]) });
  assert.equal((await mem.byIndex('blobs', 'owner', 'o')).length, 1);
  assert.equal(await mem.deleteByIndex('blobs', 'owner', 'o'), 1);
});

// ------------------------------------------------------------------ settings

test('settings: defaults, validated patches, partial evidence merge, unknown keys kept', () => {
  const file = path.join(TMP, 'settings', 'settings.json');
  const s = new Settings(file);
  assert.deepEqual(s.get(), JSON.parse(JSON.stringify(DEFAULTS)));
  assert.equal(DEFAULTS.port, 8765);
  assert.equal(DEFAULTS.defaultBrowser, 'auto');
  assert.equal(DEFAULTS.headless, true);
  assert.equal(DEFAULTS.humanize, 'human');
  assert.equal(DEFAULTS.stealth, 'off');
  assert.equal(DEFAULTS.maxParallel, 8);
  assert.equal(DEFAULTS.idleExitMinutes, 60);
  assert.equal(DEFAULTS.updateUrl, '');
  assert.deepEqual(DEFAULTS.schedule, []);
  s.set({ headless: false, evidence: { keepRuns: 5 }, futureKey: { a: 1 } });
  const reread = new Settings(file).get();
  assert.equal(reread.headless, false);
  assert.equal(reread.evidence.keepRuns, 5);
  assert.equal(reread.evidence.maxFrames, DEFAULTS.evidence.maxFrames, 'a partial evidence patch keeps the other caps');
  assert.deepEqual(reread.futureKey, { a: 1 });
  assert.throws(() => s.set({ stealth: 'ninja', maxParallel: 0 }), (err) => /stealth/.test(err.message) && /maxParallel/.test(err.message));
  assert.equal(new Settings(file).get().stealth, 'off', 'nothing written on failure');
  s.set({ headless: null });
  assert.equal(s.get().headless, true, 'null resets to the default');
  assert.throws(() => s.set('nope'), /patch object/);
  assert.throws(() => s.set({ updateUrl: 'ftp://x' }), /updateUrl/);
  assert.deepEqual(validateSettings(mergeSettings(DEFAULTS, {})), []);
});

test('settings: a broken or partly invalid file starts with defaults and says so', () => {
  const file = path.join(TMP, 'settings-broken', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ nope');
  const logs = [];
  const s = new Settings(file, { log: (m) => logs.push(m) });
  assert.equal(s.get().port, 8765);
  assert.equal(s.loadProblems.length, 1);
  fs.writeFileSync(file, JSON.stringify({ port: 9000, stealth: 'bogus' }));
  const t = new Settings(file);
  assert.equal(t.get().port, 9000, 'valid values survive');
  assert.equal(t.get().stealth, 'off', 'the invalid one is reset');
  assert.ok(t.loadProblems.some((p) => /stealth/.test(p)));
});

// ------------------------------------------------------------------ handoff

test('handoff: chrome cookies convert to CDP cookie params faithfully', () => {
  const now = 1_800_000_000;
  const { cookies, skipped } = chromeCookiesToCdp([
    { name: 'host', value: 'v', domain: 'app.example.com', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: true },
    { name: 'dom', value: 'w', domain: '.example.com', hostOnly: false, path: '/x', secure: false, httpOnly: false, sameSite: 'strict', session: false, expirationDate: now + 3600 },
    { name: 'bare', value: 'b', domain: 'example.com', hostOnly: false, path: '/', secure: true, sameSite: 'no_restriction', session: true },
    { name: 'none-insecure', value: 'n', domain: 'example.com', hostOnly: true, path: '/', secure: false, sameSite: 'no_restriction', session: true },
    { name: 'unspec', value: 'u', domain: 'example.com', hostOnly: true, path: '/', secure: false, sameSite: 'unspecified', session: true },
    { name: 'old', value: 'o', domain: 'example.com', hostOnly: true, path: '/', session: false, expirationDate: now - 1 },
    { name: 'part', value: 'p', domain: 'example.com', hostOnly: true, path: '/', secure: true, sameSite: 'no_restriction', session: true, partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: false } },
    null,
  ], { nowSeconds: now });
  const byName = Object.fromEntries(cookies.map((c) => [c.name, c]));
  assert.deepEqual(byName.host, { name: 'host', value: 'v', path: '/', secure: true, httpOnly: true, url: 'https://app.example.com/', sameSite: 'Lax' });
  assert.equal(byName.host.domain, undefined, 'host-only stays host-only (url, no domain)');
  assert.equal(byName.dom.domain, '.example.com');
  assert.equal(byName.dom.url, undefined);
  assert.equal(byName.dom.sameSite, 'Strict');
  assert.equal(byName.dom.expires, now + 3600);
  assert.equal(byName.bare.domain, '.example.com', 'a domain cookie always gets its leading dot');
  assert.equal(byName.bare.sameSite, 'None');
  assert.equal(byName.bare.expires, undefined, 'session cookies get no expiry');
  assert.equal(byName['none-insecure'].sameSite, undefined, 'SameSite=None without Secure would be rejected; sent as default');
  assert.equal(byName['none-insecure'].url, 'http://example.com/');
  assert.equal(byName.unspec.sameSite, undefined);
  assert.deepEqual(byName.part.partitionKey, { topLevelSite: 'https://top.example', hasCrossSiteAncestor: false });
  assert.deepEqual(skipped.map((s) => s.reason).sort(), ['expired', 'not a cookie']);
  assert.deepEqual(chromeCookiesToCdp(undefined), { cookies: [], skipped: [] });
});

test('handoff: storage seeding script is origin-scoped, top-frame only, and carries the data', () => {
  assert.deepEqual(storageEntries({ a: 1, b: null }), [['a', '1'], ['b', '']]);
  assert.deepEqual(storageEntries([['k', 'v'], ['bad'], null]), [['k', 'v']]);
  assert.deepEqual(storageEntries(null), []);
  const src = seedStorageScript('https://app.example.com', [['token', 'a"b</script>']], { s: 'x' });
  assert.match(src, /location\.origin !== seed\.origin/);
  assert.match(src, /window\.top !== window/);
  assert.match(src, /localStorage\.setItem/);
  // Run it against fake globals to prove the behaviour, not just the text.
  const run = (origin, top = true) => {
    const store = { local: {}, session: {} };
    const win = {};
    win.top = top ? win : {};
    const fn = new Function('window', 'location', 'localStorage', 'sessionStorage', src);
    fn(win, { origin },
      { setItem: (k, v) => { store.local[k] = v; } },
      { setItem: (k, v) => { store.session[k] = v; } });
    return store;
  };
  assert.deepEqual(run('https://app.example.com'), { local: { token: 'a"b</script>' }, session: { s: 'x' } });
  assert.deepEqual(run('https://login.other.com'), { local: {}, session: {} }, 'another origin receives nothing');
  assert.deepEqual(run('https://app.example.com', false), { local: {}, session: {} }, 'iframes receive nothing');
  assert.equal(originOf('https://a.example:8443/x?y'), 'https://a.example:8443');
  assert.equal(originOf('about:blank'), null);
  assert.equal(originOf('garbage'), null);
  assert.deepEqual(NOT_TRANSFERRED, ['in-memory page state', 'IndexedDB', 'service worker state']);
});

// ------------------------------------------------------------------ scheduler

test('scheduler: next run for daily HH:MM and every-N-minutes entries', () => {
  const base = new Date(2026, 8, 21, 10, 0, 0, 0).getTime(); // local 10:00
  const at = (h, m, dayOffset = 0) => new Date(2026, 8, 21 + dayOffset, h, m, 0, 0).getTime();
  assert.equal(nextRunAt({ daily: '14:30' }, base), at(14, 30));
  assert.equal(nextRunAt({ daily: '09:15' }, base), at(9, 15, 1), 'a time already past today is tomorrow');
  assert.equal(nextRunAt({ daily: '10:00' }, base), at(10, 0, 1), 'strictly after "from"');
  assert.equal(nextRunAt({ daily: '0:05' }, base), at(0, 5, 1));
  assert.equal(nextRunAt({ daily: '25:00' }, base), null);
  assert.equal(nextRunAt({ everyMinutes: 30, lastRunAt: base }, base), base + 30 * 60_000);
  assert.equal(nextRunAt({ everyMinutes: 30, createdAt: base - 10 * 60_000 }, base), base + 20 * 60_000);
  assert.equal(nextRunAt({ everyMinutes: 30, lastRunAt: base - 5 * 3600_000 }, base), base, 'overdue runs once, now — not five times');
  assert.equal(nextRunAt({ everyMinutes: 30, enabled: false }, base), null);
  assert.equal(nextRunAt(null, base), null);
});

test('scheduler: entry validation and the runner command line', () => {
  assert.deepEqual(validateEntry({ target: 'suite:smoke', daily: '02:30' }), []);
  assert.deepEqual(validateEntry({ target: 'all', everyMinutes: 60, args: ['--env', 'test1'] }), []);
  assert.ok(validateEntry({ daily: '02:30' }).some((p) => /target/.test(p)));
  assert.ok(validateEntry({ target: 'x', daily: '02:30', everyMinutes: 5 }).some((p) => /exactly one/.test(p)));
  assert.ok(validateEntry({ target: 'x' }).some((p) => /exactly one/.test(p)));
  assert.ok(validateEntry({ target: 'x', daily: '2pm' }).some((p) => /HH:MM/.test(p)));
  assert.ok(validateEntry({ target: 'x', everyMinutes: 0 }).some((p) => /everyMinutes/.test(p)));
  assert.ok(validateEntry({ target: 'x', everyMinutes: 5, args: [1] }).some((p) => /args/.test(p)));
  assert.ok(validateEntry({ target: 'x', everyMinutes: 5, args: ['--report', 'y'] }).some((p) => /--report/.test(p)));
  assert.deepEqual(
    runnerArgv({ runnerPath: '/r/g9.mjs', entry: { target: 'suite:s', args: ['--env', 'e'] }, reportDir: '/runs/x/report' }),
    ['/r/g9.mjs', 'run', 'suite:s', '--env', 'e', '--report', '/runs/x/report', '--quiet'],
  );
});

// ------------------------------------------------------------------ evidence

test('evidence: MIME sniffing reads content, not names', () => {
  const b = (...bytes) => Uint8Array.from(bytes);
  assert.equal(sniffMime(Buffer.from('%PDF-1.7\n'), 'x.pdf'), 'application/pdf');
  assert.equal(sniffMime(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), 'image/png');
  assert.equal(sniffMime(b(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffMime(b(0x50, 0x4b, 0x03, 0x04, 0), 'report.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(sniffMime(b(0x50, 0x4b, 0x03, 0x04, 0), 'a.bin'), 'application/zip');
  assert.equal(sniffMime(Buffer.from('<!DOCTYPE html><html>error</html>'), 'report.pdf'), 'text/html', 'an HTML error page named .pdf is caught');
  assert.equal(sniffMime(Buffer.from('{"a":1}')), 'application/json');
  assert.equal(sniffMime(Buffer.from('name,qty\nx,1\n'), 'export.csv'), 'text/csv');
  assert.equal(sniffMime(Buffer.from('hello there')), 'text/plain');
  assert.equal(sniffMime(Buffer.alloc(0)), 'application/x-empty');
  assert.equal(sniffMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'image/webp');
  assert.equal(sniffMime(b(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), 'old.xls'), 'application/vnd.ms-excel');
  assert.equal(sniffMime(b(0, 1, 2, 3, 200, 7)), 'application/octet-stream');
});

test('evidence: fileInfo — exists, size, sha256, first 16 bytes, sniffed mime', async () => {
  const file = path.join(TMP, 'download.pdf');
  const body = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(5000)]);
  fs.writeFileSync(file, body);
  const info = await fileInfo(file);
  assert.equal(info.exists, true);
  assert.equal(info.size, body.length);
  assert.equal(info.sha256, crypto.createHash('sha256').update(body).digest('hex'));
  assert.equal(info.magicHex, body.subarray(0, 16).toString('hex'));
  assert.equal(info.mime, 'application/pdf');
  assert.deepEqual(await fileInfo(path.join(TMP, 'nope.bin')), { exists: false, size: 0, sha256: null, magicHex: null, mime: null });
  assert.equal((await fileInfo(TMP)).exists, false, 'a directory is not a downloaded file');
});

test('evidence: a run spools frames and the pointer track within caps, then lists and prunes', async () => {
  let caps = { maxFrames: 2, maxBytes: 1_000_000, keepRuns: 2 };
  const evidence = new Evidence({ runsDir: path.join(TMP, 'runs'), settings: { get: () => ({ evidence: caps }) } });
  const { runId, dir } = await evidence.startRun({ kind: 'replay', label: 'flow-1', tabId: 3, engine: { engineId: 'launched-1' }, meta: { humanize: { seed: 7 } } });
  assert.match(runId, /^\d{8}-\d{6}-replay-[0-9a-f]{6}$/);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString('base64');
  assert.equal(evidence.frame(runId, { data: jpeg, metadata: { offsetTop: 0 }, at: 1 }), true);
  assert.equal(evidence.frame(runId, { data: jpeg, at: 2 }), true);
  assert.equal(evidence.frame(runId, { data: jpeg, at: 3 }), false, 'the cap drops, it does not queue');
  evidence.pointer(runId, { at: 1, x: 10, y: 20, buttons: 0, type: 'mouseMoved' });
  const summary = await evidence.finishRun(runId, { ok: true, verdict: 'PASS' });
  assert.equal(summary.frames, 2);
  assert.equal(summary.framesDropped, 1);
  assert.match(summary.truncated, /frame cap/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'frames')), ['000001.jpg', '000002.jpg']);
  assert.equal(fs.readFileSync(path.join(dir, 'frames.jsonl'), 'utf8').trim().split('\n').length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'pointer.jsonl'), 'utf8')), { at: 1, x: 10, y: 20, buttons: 0, type: 'mouseMoved' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'engine.json'), 'utf8')).humanize.seed, 7);
  const got = await evidence.get(runId);
  assert.equal(got.result.verdict, 'PASS');
  assert.equal((await evidence.list())[0].runId, runId);
  await assert.rejects(evidence.get('../../etc'), /Invalid run id/);
  // Pruning keeps the newest keepRuns.
  caps = { ...caps, keepRuns: 1 };
  await sleep(1100);
  const second = await evidence.startRun({ kind: 'watch' });
  await evidence.finishRun(second.runId, {});
  await evidence.prune();
  const left = fs.readdirSync(path.join(TMP, 'runs'));
  assert.deepEqual(left, [second.runId]);
  assert.notEqual(newRunId('x'), newRunId('x'));
});

// ------------------------------------------------------------------ frame codec, paths, project, flows, tools

test('ws codec: masked/unmasked round trips, 16/64-bit lengths, oversize refused early, fragments', () => {
  for (const size of [0, 5, 125, 126, 65_535, 65_536, 200_000]) {
    const payload = crypto.randomBytes(size);
    for (const mask of [false, true]) {
      const frame = decodeFrame(encodeFrame(OP.TEXT, payload, { mask }));
      assert.equal(frame.fin, true);
      assert.equal(frame.opcode, OP.TEXT);
      assert.ok(frame.payload.equals(payload), `size ${size} mask ${mask}`);
    }
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0x7f;
  header.writeBigUInt64BE(1n << 40n, 2);
  assert.throws(() => decodeFrame(header), /exceeds/);
  assert.equal(decodeFrame(Buffer.from([0x81])), null, 'partial header waits');
  const messages = [];
  const reader = new FrameReader({ onMessage: (op, p) => messages.push([op, p.toString()]), onControl: () => true });
  const first = encodeFrame(OP.TEXT, Buffer.from('hel'), { mask: true });
  first[0] &= 0x7f; // FIN off
  const cont = encodeFrame(OP.CONT, Buffer.from('lo'), { mask: true });
  const both = Buffer.concat([first, cont]);
  reader.push(both.subarray(0, 3));
  reader.push(both.subarray(3));
  assert.deepEqual(messages, [[OP.TEXT, 'hello']]);
  assert.deepEqual(parseCloseBody(closeBody(4001, 'reload the v2 extension')), { code: 4001, reason: 'reload the v2 extension' });
});

test('paths: G9_HOME resolution, ports, layout', () => {
  assert.equal(resolveHome('C:/x/y'), path.resolve('C:/x/y'));
  assert.ok(resolveHome('').length > 0);
  assert.equal(parsePort('8765'), 8765);
  assert.equal(parsePort('0'), null);
  assert.equal(parsePort('70000'), null);
  assert.equal(parsePort('abc'), null);
  assert.equal(parsePort(undefined), null);
  const l = layout('/h');
  assert.equal(path.basename(l.kvLocal), 'kv-local.json');
  assert.equal(path.basename(path.dirname(l.daemonLog)), 'logs');
});

test('project: the adapter is found upwards; workspaceDomains no longer matters', () => {
  const root = path.join(TMP, 'proj');
  const deep = path.join(root, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(root, 'g9.project.json'), JSON.stringify({ flowsDir: 'QA/Flows', environments: { t: 'https://t' } }));
  const project = loadProject(deep, { explicit: null });
  assert.equal(project.found, true);
  assert.deepEqual(project.problems, [], 'no workspaceDomains is no longer a problem');
  assert.equal(project.flowsDir, path.join(root, 'QA', 'Flows').replace(/\\/g, '/'));
  assert.equal('workspaceDomains' in projectForClient(project), false);
  fs.writeFileSync(path.join(root, 'g9.project.json'), '{bad');
  assert.match(loadProject(deep, { explicit: null }).problems[0], /not valid JSON/);
  assert.equal(loadProject(os.tmpdir() === root ? '/' : path.parse(TMP).root, { explicit: null }).found, false);
});

test('flows: library write/read/list/status round trip (unchanged v1 behaviour)', async () => {
  const lib = new FlowLibrary(path.join(TMP, 'flows'));
  const spec = { format: 'g9/flowspec', version: 1, id: 'flow_1', name: 'Log in', folder: 'auth', target: { kind: 'web' }, steps: [], knownWorld: { secret: 1 } };
  const w = await lib.write(spec);
  assert.equal(w.file, 'web/auth/log-in.flow.json');
  assert.equal(w.changed, true);
  assert.equal((await lib.write(spec)).changed, false);
  const read = await lib.read('flow_1');
  assert.equal(read.knownWorld, undefined, 'local truth never lands on disk');
  const { flows } = await lib.list();
  assert.equal(flows.length, 1);
  const status = await lib.status([{ id: 'flow_1', hash: 'different' }, { id: 'local_only', name: 'L' }]);
  assert.equal(status.differing.length, 1);
  assert.equal(status.onlyLocal[0].id, 'local_only');
  await assert.rejects(new FlowLibrary(null).list(), /No flow library is configured/);
});

test('mcp tools: fifteen tools, valid schemas, session on every tab tool, v2 instructions', () => {
  assert.equal(TOOLS.length, 15);
  assert.equal(new Set(TOOL_NAMES).size, 15);
  for (const name of ['browser_status', 'browser_engine', 'browser_tabs', 'browser_snapshot', 'browser_interact', 'browser_navigate',
    'browser_inspect', 'browser_console', 'browser_network', 'browser_diagnose', 'browser_screenshot', 'browser_emulate',
    'browser_dialog', 'browser_recording', 'browser_issue']) assert.ok(TOOL_NAMES.includes(name), name);
  for (const tool of TOOLS) {
    assert.ok(tool.description && tool.description.length > 40, `${tool.name} description`);
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    for (const [key, prop] of Object.entries(tool.inputSchema.properties ?? {})) {
      assert.ok(prop && typeof prop === 'object', `${tool.name}.${key}`);
      assert.ok(prop.type || prop.anyOf || prop.description, `${tool.name}.${key} has a type or description`);
      if (prop.enum) assert.ok(Array.isArray(prop.enum) && prop.enum.length, `${tool.name}.${key} enum`);
    }
    const props = tool.inputSchema.properties ?? {};
    if ('tabId' in props && tool.name !== 'browser_tabs') assert.ok('session' in props, `${tool.name} accepts session`);
  }
  const tabs = TOOLS.find((t) => t.name === 'browser_tabs');
  assert.deepEqual(tabs.inputSchema.properties.action.enum,
    ['list', 'open', 'close', 'focus', 'attach', 'claim', 'release', 'popout', 'handoff', 'session', 'sessions', 'end_session', 'wait']);
  const engine = TOOLS.find((t) => t.name === 'browser_engine');
  // acquire/release: a run HOLDS a launched engine across its tabs (engine leases, 2026-09-22).
  assert.deepEqual(engine.inputSchema.properties.action.enum, ['launch', 'list', 'stop', 'context', 'versions', 'warm', 'acquire', 'release']);
  assert.ok('lease' in engine.inputSchema.properties && 'stopWhenReleased' in engine.inputSchema.properties);
  const shot = TOOLS.find((t) => t.name === 'browser_screenshot');
  // An element/full-page capture is an action: no read-only hint, and the description says so.
  assert.equal(shot.annotations?.readOnlyHint, undefined);
  assert.match(shot.description, /ACTIONS, not reads/);
  const interact = TOOLS.find((t) => t.name === 'browser_interact').inputSchema.properties;
  for (const key of ['humanize', 'seed', 'typos']) assert.ok(key in interact, `browser_interact.${key}`);
  const recording = TOOLS.find((t) => t.name === 'browser_recording').inputSchema.properties;
  assert.ok(recording.action.enum.includes('calibrate_humanize'));
  for (const key of ['engine', 'humanize', 'seed']) assert.ok(key in recording, `browser_recording.${key}`);
  for (const phrase of ['Two engines', 'owns', 'Stop', 'handoff', 'popout', 'delivered', 'known world', 'Never approve']) {
    assert.ok(INSTRUCTIONS.includes(phrase), `instructions mention "${phrase}"`);
  }
  for (const gone of ['pinned mode', 'workspace mode', 'multi mode', '"pin"']) {
    assert.ok(!INSTRUCTIONS.toLowerCase().includes(gone.toLowerCase()), `instructions no longer mention ${gone}`);
  }
});

// ------------------------------------------------------------------ review fixes (regressions)

test('review: storage keys are own keys — prototype names are absent, "__proto__" is an ordinary key', async () => {
  const s = new MemoryStorageArea();
  assert.deepEqual(await s.get('toString'), {}, 'Object.prototype is not the store');
  assert.deepEqual(await s.get(['constructor', 'hasOwnProperty']), {});
  assert.deepEqual(await s.get({ valueOf: 'fallback' }), { valueOf: 'fallback' });
  await s.set(JSON.parse('{"__proto__":{"polluted":true},"k":1}'));
  assert.equal(({}).polluted, undefined, 'no prototype pollution');
  assert.deepEqual(Object.keys(await s.get(null)).sort(), ['__proto__', 'k']);
  assert.equal((await s.get('__proto__')).__proto__.polluted, true, 'stored and read back as data');
  await s.remove('__proto__');
  assert.deepEqual(await s.getKeys(), ['k']);
  const file = path.join(TMP, 'kv-proto', 'kv.json');
  const f = new FileStorageArea(file);
  await f.set({ constructor: 'mine' });
  assert.deepEqual(await new FileStorageArea(file).get('constructor'), { constructor: 'mine' });
});

test('review: file blobs — a first get and a first put racing share ONE index', async () => {
  const dir = path.join(TMP, 'blobs-race');
  await new FileBlobs(dir).put('video-frames', { id: 's:000001', sessionId: 's', seq: 1, blob: Uint8Array.from([1]) });
  for (let round = 0; round < 5; round += 1) {
    const fresh = new FileBlobs(dir);
    const id = `s:${String(100 + round).padStart(6, '0')}`;
    await Promise.all([
      fresh.byIndex('video-frames', 'sessionId', 's'),
      fresh.put('video-frames', { id, sessionId: 's', seq: 100 + round, blob: Uint8Array.from([2]) }),
      fresh.get('video-frames', 's:000001'),
    ]);
    const seqs = (await fresh.byIndex('video-frames', 'sessionId', 's')).map((r) => r.seq);
    assert.ok(seqs.includes(100 + round), `round ${round}: the racing put is in the index (${seqs})`);
  }
});

test('review: MIME sniffing — UTF-16 text is not audio, letters that look like magic are text', () => {
  assert.equal(sniffMime(Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00]), 'export.csv'), 'text/plain; charset=utf-16');
  assert.equal(sniffMime(Buffer.from([0xfe, 0xff, 0x00, 0x61]), 'x.txt'), 'text/plain; charset=utf-16');
  assert.equal(sniffMime(Buffer.from('BMW,Audi,VW\n1,2,3\n4,5,6\n7,8,9\n'), 'cars.csv'), 'text/csv');
  assert.equal(sniffMime(Buffer.from('BZh is where the notes start\n'), 'notes.txt'), 'text/plain');
  assert.equal(sniffMime(Buffer.from(`MZ ${'x'.repeat(80)}\n`), 'notes.txt'), 'text/plain');
  const bmp = Buffer.alloc(64); bmp.write('BM'); bmp.writeUInt32LE(40, 14);
  assert.equal(sniffMime(bmp, 'a.bmp'), 'image/bmp');
  const exe = Buffer.alloc(128); exe.write('MZ'); exe[2] = 0x90;
  assert.equal(sniffMime(exe, 'setup.exe'), 'application/x-msdownload');
  assert.equal(sniffMime(Buffer.from('BZh91AY&SY'), 'a.bz2'), 'application/x-bzip2');
  assert.equal(sniffMime(Buffer.from([0xff, 0xfb, 0x90, 0x64]), 'a.mp3'), 'audio/mpeg', 'a real MPEG frame still is audio');
  assert.equal(sniffMime(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), 'r.pdf'), 'application/pdf', 'a plain Uint8Array works');
});

test('review: ws codec — a 20 MB message in 64 KB chunks is joined once; a message inside a fragmented one is refused', () => {
  const big = Buffer.alloc(20 * 1024 * 1024, 0x61);
  const wire = Buffer.concat([encodeFrame(OP.TEXT, Buffer.from('a'), { mask: true }), encodeFrame(OP.TEXT, big, { mask: true }), encodeFrame(OP.TEXT, Buffer.from('z'), { mask: true })]);
  const got = [];
  const reader = new FrameReader({ onMessage: (op, p) => got.push(p.length), onControl: () => true });
  const started = Date.now();
  for (let i = 0; i < wire.length; i += 65_536) reader.push(wire.subarray(i, i + 65_536));
  assert.deepEqual(got, [1, big.length, 1]);
  assert.ok(Date.now() - started < 2_000, `linear, not quadratic (${Date.now() - started} ms)`);
  const bad = new FrameReader({ onMessage: () => {}, onControl: () => true });
  const first = encodeFrame(OP.TEXT, Buffer.from('par'));
  first[0] &= 0x7f; // FIN off: a fragment
  assert.throws(() => bad.push(Buffer.concat([first, encodeFrame(OP.TEXT, Buffer.from('new'))])), /before the fragmented one finished/);
});

test('review: id rewriting leaves user data alone (variables, bundles, evaluate values)', async () => {
  const out = rewriteTabIds({ tabId: 1, variables: { tabId: 999 }, bundle: { recordings: [{ tabId: 3 }] }, rules: [{ tabId: 4 }] }, (n) => n * 10);
  assert.equal(out.tabId, 10);
  assert.deepEqual(out.variables, { tabId: 999 });
  assert.deepEqual(out.bundle, { recordings: [{ tabId: 3 }] });
  assert.deepEqual(out.rules, [{ tabId: 4 }]);
  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  const { sent } = fakeExtension(reg, router, (msg) => (msg.tool === 'browser_tabs'
    ? { tabs: [{ tabId: 5 }] }
    : { value: { tabId: 777, rows: [{ tabId: 5 }] }, tabId: msg.args.tabId }));
  const h = (await router.call(a, 'browser_tabs', { action: 'list' })).tabs[0].tabId;
  const handlesBefore = reg.handles.size;
  const res = await router.call(a, 'browser_console', { action: 'evaluate', expression: 'x', tabId: h });
  assert.deepEqual(res.value, { tabId: 777, rows: [{ tabId: 5 }] }, 'page data comes back as the page returned it');
  assert.equal(res.tabId, h);
  assert.equal(reg.handles.size, handlesBefore, 'no handle minted for a number in page data');
  await router.call(a, 'browser_recording', { action: 'replay', id: 'r1', tabId: h, variables: { tabId: 424242 } });
  assert.deepEqual(sent.filter((m) => m.type === 'call').at(-1).args.variables, { tabId: 424242 }, 'a variable named tabId is not a tab');
});

test('review: the desktop\'s first-render state lists tabs (a null caller must not throw)', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  fakeExtension(reg, router, (msg) => ({ tabs: [{ tabId: 11, title: 'T', url: 'https://t/' }], caller: msg.caller }));
  const rows = await router.listTabs(null);
  assert.equal(rows.length, 1);
  assert.ok(Number.isInteger(rows[0].tabId));
  assert.equal(rows[0].error, undefined);
  assert.equal(rows[0].current, false);
});

test('review: a queued call re-checks the halt when its turn comes', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  let release;
  const gate = new Promise((r) => { release = r; });
  const { sent } = fakeExtension(reg, router, async (msg) => {
    if (msg.tool === 'browser_tabs') return { tabs: [{ tabId: 6 }] };
    if (msg.args.ref === 'slow') await gate;
    return { ok: true, ref: msg.args.ref };
  });
  const h = (await router.call(a, 'browser_tabs', { action: 'list' })).tabs[0].tabId;
  const first = router.call(a, 'browser_interact', { action: 'click', ref: 'slow', tabId: h });
  await sleep(5);
  const second = router.call(a, 'browser_interact', { action: 'click', ref: 'queued', tabId: h });
  await sleep(5);
  reg.setAgentHalt(a.id, true);
  release();
  assert.equal((await first).ref, 'slow', 'the call already running finishes');
  await assert.rejects(second, /stopped this agent/);
  assert.ok(!sent.some((m) => m.type === 'call' && m.args.ref === 'queued'), 'the queued call never reached the engine');
});

test('F4: browser_status passes the tab it is about to the engine, which reports THAT tab\'s current and health', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  // An engine as extension/tools/index.js status(args) is now: it answers about args.tabId.
  const rows = [{ tabId: 1, title: 'Engine current', url: 'https://one/' }, { tabId: 2, title: 'Mine', url: 'https://two/', active: true }];
  const health = { 1: { consoleErrors: 9 }, 2: { consoleErrors: 1 } };
  const { client: ext, sent } = fakeExtension(reg, router, (msg) => {
    if (msg.tool === 'browser_status') {
      const asked = msg.args.tabId ?? 1;
      const row = rows.find((r) => r.tabId === asked);
      if (!row) return { current: null, targetError: 'The tab this status was asked about does not exist (any more).', health: null, tabs: { count: 2, rows } };
      return { current: row, health: health[asked], tabs: { count: 2, rows },
        ...(asked !== 1 ? { engineCurrent: { tabId: 1, title: 'Engine current', url: 'https://one/' } } : {}) };
    }
    return { ok: true };
  });
  const mine = reg.handleForChrome(ext.id, 2);
  const theirs = reg.handleForChrome(ext.id, 1);
  reg.setCurrent(a.id, mine);
  const status = await router.call(a, 'browser_status', {});
  const relayed = sent.filter((m) => m.type === 'call' && m.tool === 'browser_status').at(-1);
  assert.equal(relayed.args.tabId, 2, 'the caller\'s current handle went to the extension as its Chrome id');
  assert.equal(status.current.tabId, mine);
  assert.equal(status.current.title, 'Mine');
  assert.equal(status.health.consoleErrors, 1, 'the health figures are this tab\'s own');
  assert.equal(status.healthNote, undefined, 'no workaround note any more');
  assert.equal(status.engineCurrent.tabId, theirs, 'the engine\'s own current tab, rewritten to a handle');

  const same = await router.call(a, 'browser_status', { tabId: theirs });
  assert.equal(same.current.tabId, theirs);
  assert.equal(same.health.consoleErrors, 9);
  const unknown = await router.call(a, 'browser_status', { tabId: 424242 });
  assert.match(unknown.targetError, /does not exist/, 'an unknown tabId is reported, not replaced silently');

  // The engine lost the tab the daemon still maps: its targetError passes through, current stays empty.
  rows.splice(1, 1);
  const gone = await router.call(a, 'browser_status', { tabId: mine });
  assert.equal(gone.current, null);
  assert.match(gone.targetError, /does not exist/);
});

test('F4 guard: an engine that ignores tabId never has its own tab\'s health shown as the asked one\'s', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  const { client: ext } = fakeExtension(reg, router, (msg) => {
    if (msg.tool === 'browser_status') return { current: { tabId: 1, title: 'Engine current' }, health: { consoleErrors: 9 } };
    return { ok: true };
  });
  const mine = reg.handleForChrome(ext.id, 2);
  reg.setCurrent(a.id, mine);
  const status = await router.call(a, 'browser_status', {});
  assert.equal(status.current.tabId, mine);
  assert.equal(status.health, null);
  assert.equal(status.engineCurrent.health.consoleErrors, 9);
  assert.match(status.healthNote, /browser_diagnose/);
});

test('review: stopping a launched engine refuses other agents\' tabs unless forced', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const stopped = [];
  router.engines = { ...stubEngines(), list: () => [{ engineId: 'launched-1', kind: 'launched' }], stop: async (id) => { stopped.push(id); } };
  reg.addLaunchedEngine({ engineId: 'launched-1' });
  const a = agent(reg, 'a');
  const b = agent(reg, 'b');
  const h = reg.allocHandle();
  reg.bindHandle(h, 'launched-1');
  reg.ensureOwnership(h, a.id);
  await assert.rejects(router.call(b, 'browser_engine', { action: 'stop', engineId: 'launched-1' }), new RegExp(`tab ${h} \\(agent-1 \\(a\\)\\)`));
  assert.deepEqual(stopped, []);
  const forced = await router.call(b, 'browser_engine', { action: 'stop', engineId: 'launched-1', force: true });
  assert.deepEqual(forced.closedOthersTabs, [h]);
  const own = await router.call(a, 'browser_engine', { action: 'stop', engineId: 'launched-1' });
  assert.equal(own.stopped, 'launched-1', 'the owner itself may stop it');
  assert.deepEqual(stopped, ['launched-1', 'launched-1']);
});

test('review: calibrate_humanize reports where the profile was really saved', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const savedLaunched = [];
  router.engines = { ...stubEngines(), available: () => false, saveHumanizeProfile: async (name) => { savedLaunched.push(name); return { name }; } };
  const a = agent(reg, 'a');
  fakeExtension(reg, router, (msg) => ({ saved: msg.args.name, profile: { name: msg.args.name }, samples: 10 }));
  const res = await router.call(a, 'browser_recording', { action: 'calibrate_humanize', id: 'r', name: 'team-qa' });
  assert.deepEqual(res.saved, { name: 'team-qa', engines: ['extension', 'launched'] });
  assert.match(res.note, /the extension and on launched engines/);
  assert.deepEqual(savedLaunched, ['team-qa']);
});

test('review: engine:"extension" on a page tool acts in the extension even when the current tab is launched', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  router.engines = { ...stubEngines(), available: () => true, runTool: async () => ({ where: 'launched' }) };
  reg.addLaunchedEngine({ engineId: 'launched-1' });
  const a = agent(reg, 'a');
  const { client: ext } = fakeExtension(reg, router, (msg) => (msg.tool === 'browser_status'
    ? { current: { tabId: 30 } }
    : { where: 'extension', tabId: msg.args.tabId }));
  const launchedTab = reg.allocHandle();
  reg.bindHandle(launchedTab, 'launched-1');
  reg.setCurrent(a.id, launchedTab);
  const res = await router.call(a, 'browser_snapshot', { engine: 'extension' });
  assert.equal(res.where, 'extension');
  assert.equal(reg.engineOf(res.tabId), ext.id);
  assert.equal((await router.call(a, 'browser_snapshot', {})).where, 'extension', 'and that tab is now current');
});

test('review: engine manager — one launch per profile at a time; a failed watch leaves nothing behind', async () => {
  const reg = new Registry();
  const m = new EngineManager({ home: TMP, registry: reg });
  m.ready = Promise.resolve();
  m.cdp = { tabInfo: () => null };
  let finish;
  const pending = new Promise((r) => { finish = r; });
  m.launching.set('automation', pending);
  const reused = m.launch({ reuse: true });
  await assert.rejects(m.launch({}), /being launched right now/);
  finish({ engineId: 'launched-9' });
  assert.deepEqual(await reused, { engineId: 'launched-9' }, 'reuse waits for the launch in progress');
  let stops = 0;
  let unsubscribed = 0;
  m.optional.pointer = { subscribe: () => () => { unsubscribed += 1; } };
  m.optional.screencast = { subscribe: () => {}, start: async () => { throw new Error('no page'); }, stop: async () => { stops += 1; } };
  await assert.rejects(m.watch(5, true, 'ui-watch'), /no page/);
  assert.equal(m.watches.size, 0, 'no stale "watching" entry');
  assert.equal(unsubscribed, 1, 'the pointer subscription is released');
  assert.equal(stops, 1, 'the screencast consumer is released');
});

test('review: scheduler accepts the desktop\'s entry shape and reports the last run for its list', async () => {
  const desktop = { suite: 'smoke', env: 'staging', at: '06:30', everyMinutes: null, enabled: true,
    engine: { browser: 'edge', headless: false, humanize: 'stealth', stealth: 'human', profile: 'qa' } };
  const n = normalizeEntry(desktop);
  assert.equal(n.target, 'smoke');
  assert.equal(n.daily, '06:30');
  assert.equal('everyMinutes' in n, false);
  assert.deepEqual(n.args, ['--env', 'staging', '--browser', 'edge', '--headed', '--humanize', 'stealth', '--stealth', 'human', '--profile', 'qa']);
  assert.deepEqual(validateEntry(n), []);
  assert.deepEqual(normalizeEntry(n), n, 'idempotent');
  assert.deepEqual(normalizeEntry({ target: 'all', everyMinutes: 5, args: ['--env', 'x'], env: 'y' }).args, ['--env', 'x'], 'explicit args win');
  const settings = new Settings(path.join(TMP, 'sched-desktop', 'settings.json'));
  const sch = new Scheduler({ settings, evidence: null, repoRoot: TMP, port: () => 18001, home: TMP, project: () => null });
  const saved = sch.add({ ...desktop, entry: undefined });
  assert.match(saved.id, /^sch_/);
  assert.equal(saved.suite, 'smoke');
  assert.equal(saved.env, 'staging');
  assert.deepEqual(saved.engine, desktop.engine);
  const listed = sch.list()[0];
  assert.equal(listed.at, '06:30', 'the desktop reads "at"');
  assert.ok(listed.nextRunAt > Date.now());
  const plain = sch.add({ target: 'suite:nightly', daily: '02:00' });
  assert.equal(sch.list().find((e) => e.id === plain.id).suite, 'suite:nightly', 'runner-shaped entries get the display alias');
  assert.throws(() => sch.add({ suite: 'x', at: '25:00' }), /daily must be "HH:MM"/);
  assert.deepEqual(runnerArgv({ runnerPath: 'g9.mjs', entry: n, reportDir: 'r', project: 'C:/p/g9.project.json' }).slice(-5),
    ['--project', 'C:/p/g9.project.json', '--report', 'r', '--quiet']);
  assert.ok(!runnerArgv({ runnerPath: 'g9.mjs', entry: { target: 'all', args: ['--project', 'mine'] }, reportDir: 'r', project: 'other' }).includes('other'),
    'an entry\'s own --project wins');
  assert.equal(overallVerdict({ flows: [{ verdict: 'PASS' }, { verdict: 'SURPRISE' }] }, 3), 'SURPRISE');
  assert.equal(overallVerdict(null, 2), 'FAIL_AUTOMATION');
  assert.equal(overallVerdict(null, 4), 'ERROR');
});

test('review: settings drop a broken schedule entry, not the whole schedule', () => {
  const file = path.join(TMP, 'sched-broken', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schedule: [
    { id: 'good', target: 'all', daily: '02:00', args: [] },
    { target: 'no-id', daily: '03:00' },
    { id: 'bad-time', target: 'all', daily: '99:99' },
    { id: 'good', target: 'dup', everyMinutes: 5 },
  ] }));
  const s = new Settings(file);
  assert.deepEqual(s.get().schedule.map((e) => e.id), ['good']);
  assert.equal(s.loadProblems.filter((p) => /ignored schedule entry/.test(p)).length, 3);
  assert.throws(() => s.set({ schedule: [{ id: 'x', target: 'all' }] }), /schedule entry 1 \(x\)/);
});

test('review: the handoff note says what happened, not what was meant to', () => {
  assert.match(handoffNote({ tabId: 3 }), /^The page reloaded in the launched engine with the cookies and local\/session storage/);
  assert.match(handoffNote({ tabId: 3, navigationError: 'timeout' }), /did not finish loading/);
  assert.match(handoffNote({ tabId: 3, storageCheck: { sameOrigin: false, origin: 'https://login.example' } }), /ended on https:\/\/login\.example/);
  assert.match(handoffNote({ tabId: 3 }, { includeStorage: false }), /with the cookies of the original tab/);
  assert.match(handoffNote({ tabId: 3, warnings: ['x'] }), /See warnings/);
});

test('review: MCP results — screenshots and image attachments are image blocks, other files stay data', () => {
  const shot = normalizeToolResult({ format: 'png', area: 'viewport', dataBase64: 'iVBOR' });
  assert.deepEqual(shot.content[1], { type: 'image', data: 'iVBOR', mimeType: 'image/png' });
  assert.equal(JSON.parse(shot.content[0].text).dataBase64, undefined, 'the bytes are not repeated as text');
  assert.equal(normalizeToolResult({ format: 'jpeg', dataBase64: '/9j/' }).content[1].mimeType, 'image/jpeg');
  assert.equal(normalizeToolResult({ mime: 'image/webp', dataBase64: 'UklG' }).content[1].mimeType, 'image/webp');
  const pdf = normalizeToolResult({ id: 'att_1', name: 'r.pdf', mime: 'application/pdf', dataBase64: 'JVBERi0=' });
  assert.equal(pdf.content.length, 1);
  assert.equal(pdf.content[0].type, 'text');
  assert.equal(JSON.parse(pdf.content[0].text).dataBase64, 'JVBERi0=', 'a PDF attachment reaches the agent as decodable data');
  assert.equal(normalizeToolResult({ dataBase64: 'eA==' }).content[0].type, 'text', 'unknown bytes are not guessed to be a JPEG');
  assert.equal(normalizeToolResult('plain').content[0].text, 'plain');
  assert.equal(normalizeToolResult(undefined).content[0].text, 'null');
});

test('review: a default current tab is never another agent\'s tab', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  const b = agent(reg, 'b');
  fakeExtension(reg, router, (msg) => (msg.tool === 'browser_status' ? { current: { tabId: 1 } } : { ok: true, tabId: msg.args.tabId }));
  const first = await router.call(a, 'browser_interact', { action: 'click', ref: 'e1' });
  assert.equal(reg.ownerOf(first.tabId), a.id, 'a took the extension\'s current tab');
  await assert.rejects(router.call(b, 'browser_snapshot', {}), /No tab to act on/);
  const st = await router.call(b, 'browser_status', {});
  assert.equal(st.you.current, null, 'status does not adopt a\'s tab for b either');
  assert.equal((await router.call(b, 'browser_snapshot', { tabId: first.tabId })).tabId, first.tabId, 'an explicit read is still allowed');

  const reg2 = new Registry();
  const r2 = makeRouter(reg2);
  const c = agent(reg2, 'c');
  const d = agent(reg2, 'd');
  const older = reg2.allocHandle();
  const newer = reg2.allocHandle();
  for (const h of [older, newer]) reg2.bindHandle(h, 'launched-1');
  reg2.addLaunchedEngine({ engineId: 'launched-1' });
  reg2.ensureOwnership(newer, c.id);
  r2.engines = { ...stubEngines(), available: () => true, list: () => [{ engineId: 'launched-1', tabs: [older, newer] }], currentTab: () => newer,
    runTool: async (tool, args) => ({ tabId: args.tabId }) };
  assert.equal((await r2.call(d, 'browser_snapshot', {})).tabId, older, 'the launched fallback skips c\'s tab');
  assert.equal((await r2.call(c, 'browser_snapshot', {})).tabId, newer, 'the owner itself gets its own tab as the default');
});

test('review: runs still open when the daemon stops are closed with the reason', async () => {
  const ev = new Evidence({ runsDir: path.join(TMP, 'runs-stop'), settings: null });
  const { runId, dir } = await ev.startRun({ kind: 'schedule', label: 'nightly' });
  ev.pointer(runId, { at: 1, x: 2, y: 3 });
  assert.deepEqual(await ev.finishAll({ error: 'the daemon stopped (SIGTERM) before this run finished', interrupted: true }), [runId]);
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  assert.equal(result.ok, false, 'an interrupted run is not a success');
  assert.equal(result.interrupted, true);
  assert.match(result.error, /daemon stopped/);
  assert.equal(result.pointerSamples, 1);
  assert.equal(ev.isActive(runId), false);
  assert.equal(await ev.finishRun(runId, { ok: true }), null, 'a late finish does not overwrite it');
});

// ------------------------------------------------------------------ integration decisions (D-c) and fixes (F5–F7)

test('D-c: an extension engine with an instanceId is parked on disconnect and resumed with its id, handles, claims, sessions and current tab', () => {
  const reg = new Registry({ resumeMs: 60_000 });
  const a = agent(reg, 'cursor');
  const e = reg.addClient({ role: 'engine', version: '2.0.0', instanceId: 'inst-aaaaaaaa', loadId: 'load-1111' });
  assert.equal(e.id, 'engine-1');
  const [h11, h12, h13] = [11, 12, 13].map((n) => reg.handleForChrome(e.id, n));
  reg.noteUrl(h11, 'https://a.test/');
  reg.noteUrl(h12, 'https://b.test/');
  reg.ensureOwnership(h11, a.id);
  reg.nameSession('buyer', h12);
  reg.setCurrent(a.id, h11);

  const gone = [];
  reg.on('tabGone', (g) => gone.push(g));
  const out = reg.removeClient(e.id);
  assert.equal(out.parked, true);
  assert.deepEqual(out.dropped, [], 'nothing dropped on a disconnect that may come back');
  assert.equal(reg.isParked(e.id), true);
  assert.equal(reg.engineKind(e.id), 'extension', 'a parked engine is still an extension engine');
  assert.equal(reg.hasHandle(h11) && reg.hasHandle(h12) && reg.hasHandle(h13), true);
  assert.equal(reg.ownerOf(h11), a.id, 'the claim waits with its tab');
  assert.equal(reg.current(a.id), h11);
  assert.deepEqual(reg.parkedEngines().map((p) => p.engineId), [e.id]);

  // A worker restart: same loadId. Tab 13 closed meanwhile; tab 11 navigated (same browser session: still tab 11).
  const back = reg.addClient({ role: 'engine', version: '2.0.0', instanceId: 'inst-aaaaaaaa', loadId: 'load-1111',
    tabs: [{ tabId: 11, url: 'https://a.test/next' }, { tabId: 12, url: 'https://b.test/' }] });
  assert.equal(back.id, e.id, 'the same engine id');
  assert.deepEqual(back.resumed.kept.sort(), [h11, h12].sort());
  assert.deepEqual(back.resumed.dropped, [h13]);
  assert.equal(back.resumed.sameLoad, true);
  assert.equal(reg.handleForChrome(e.id, 11, { create: false }), h11, 'the same handle for the same Chrome tab');
  assert.equal(reg.ownerOf(h11), a.id);
  assert.equal(reg.sessionHandle('buyer'), h12);
  assert.equal(reg.current(a.id), h11);
  assert.equal(reg.isParked(e.id), false);
  assert.deepEqual(gone.map((g) => g.tabId), [h13]);
  assert.match(gone[0].reason, /closed while the extension was reconnecting/);
  // A brand-new extension still gets a new id.
  assert.equal(reg.addClient({ role: 'engine', instanceId: 'inst-bbbbbbbb' }).id, 'engine-2');
});

test('D-c: after an extension reload or a browser restart (new loadId) a handle survives only where its tab shows the same page', () => {
  const reg = new Registry({ resumeMs: 60_000 });
  const e = reg.addClient({ role: 'engine', instanceId: 'inst-cccccccc', loadId: 'load-A' });
  const h = Object.fromEntries([11, 12, 13].map((n) => [n, reg.handleForChrome(e.id, n)]));
  reg.noteUrl(h[11], 'https://shop.test/cart');
  reg.noteUrl(h[12], 'https://bank.test/home');
  reg.noteUrl(h[13], 'https://c.test/');
  reg.removeClient(e.id);
  // Chrome numbered tabs from the start again: id 12 is now another page; 11 shows the same page (a #hash aside).
  const back = reg.addClient({ role: 'engine', instanceId: 'inst-cccccccc', loadId: 'load-B',
    tabs: [{ tabId: 11, url: 'https://shop.test/cart#top' }, { tabId: 12, url: 'https://mail.test/' }, { tabId: 14, url: 'https://new.test/' }] });
  assert.equal(back.id, e.id);
  assert.equal(back.resumed.sameLoad, false);
  assert.deepEqual(back.resumed.kept, [h[11]]);
  assert.deepEqual(back.resumed.dropped.sort(), [h[12], h[13]].sort());
  assert.equal(reg.handleForChrome(e.id, 12, { create: false }), null, 'the old handle of id 12 is gone: a new one is minted on first sight');

  // No tab list and another loadId: nothing can be verified, nothing is kept.
  reg.removeClient(e.id);
  const blind = reg.addClient({ role: 'engine', instanceId: 'inst-cccccccc', loadId: 'load-C' });
  assert.equal(blind.id, e.id);
  assert.deepEqual(blind.resumed.kept, []);
  assert.deepEqual(blind.resumed.dropped, [h[11]]);
});

test('D-c: a parked engine that does not return in time is dropped; resumeMs 0 or no instanceId drops at once; a superseded client is not removed twice', async () => {
  const reg = new Registry({ resumeMs: 60 });
  const a = agent(reg, 'a');
  const e = reg.addClient({ role: 'engine', instanceId: 'inst-dddddddd', loadId: 'load-1' });
  const h = reg.handleForChrome(e.id, 5);
  reg.ensureOwnership(h, a.id);
  reg.removeClient(e.id);
  assert.equal(reg.hasHandle(h), true);
  await sleep(150);
  assert.equal(reg.hasHandle(h), false, 'dropped once the grace period is over');
  assert.equal(reg.ownerOf(h), null);
  assert.equal(reg.isParked(e.id), false);
  assert.equal(reg.addClient({ role: 'engine', instanceId: 'inst-dddddddd' }).id, 'engine-2', 'too late: a new engine');

  const now = new Registry({ resumeMs: 0 });
  const e0 = now.addClient({ role: 'engine', instanceId: 'inst-eeeeeeee' });
  const h0 = now.handleForChrome(e0.id, 1);
  assert.deepEqual(now.removeClient(e0.id).dropped, [h0], 'resumeMs 0: the v2.0 behaviour');
  const plain = new Registry();
  const p = plain.addClient({ role: 'engine' });
  const hp = plain.handleForChrome(p.id, 1);
  assert.deepEqual(plain.removeClient(p.id).dropped, [hp], 'no instanceId (an older extension): dropped at once');

  // `expected`: the old socket's late close names a client object the id no longer belongs to.
  const r = new Registry({ resumeMs: 60_000 });
  const old = r.addClient({ role: 'engine', instanceId: 'inst-ffffffff', loadId: 'L' });
  r.removeClient(old.id, { expected: old });
  const fresh = r.addClient({ role: 'engine', instanceId: 'inst-ffffffff', loadId: 'L', tabs: [] });
  assert.equal(fresh.id, old.id);
  assert.deepEqual(r.removeClient(old.id, { expected: old }), { released: [], dropped: [], parked: false }, 'a stale close changes nothing');
  assert.equal(r.getClient(old.id), fresh);
});

test('D-c: the router says "reconnecting" for a parked tab, lists it as such, and does not claim the extension is connected', async () => {
  const reg = new Registry({ resumeMs: 60_000 });
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  const ext = reg.addClient({ role: 'engine', version: '2.0.0', instanceId: 'inst-gggggggg', loadId: 'L1', send: () => true });
  const h = reg.handleForChrome(ext.id, 7);
  router.onEngineEvent(ext.id, 'tabs', { tabs: [{ tabId: 7, url: 'https://seven.test/' }] });
  assert.equal(reg.handles.get(h).url, 'https://seven.test/', 'the tabs push records the page each tab shows');
  reg.setCurrent(a.id, h);
  reg.removeClient(ext.id);
  await assert.rejects(router.call(a, 'browser_snapshot', {}), /reconnecting/);
  await assert.rejects(router.call(a, 'browser_interact', { action: 'click', ref: 'e1', tabId: h }), /reconnecting[\s\S]*claim on it and its session name are kept/);
  const listed = await router.call(a, 'browser_tabs', { action: 'list' });
  assert.deepEqual(listed.tabs.filter((t) => t.reconnecting).map((t) => [t.tabId, t.url]), [[h, 'https://seven.test/']]);
  const rows = router.engineRows();
  assert.equal(rows.find((r) => r.engineId === ext.id)?.reconnecting, true);
  const status = await router.call(a, 'browser_status', {});
  assert.equal(status.capabilities.extension, false, 'a reconnecting extension is not a connected one');
  assert.match(status.engineError ?? '', /not connected \(it may be reconnecting\)/);
});

/** A WsConnection-shaped fake for driving a real Daemon in-process: no socket, no port. */
function fakeConn() {
  const c = new EventEmitter();
  c.sent = [];
  c.closed = null;
  c.send = (obj) => { c.sent.push(obj); return true; };
  c.sendDroppable = c.send;
  c.close = (code = 1000, reason = '') => { if (!c.closed) c.closed = { code, reason }; };
  c.say = (msg) => c.emit('message', msg);
  c.drop = (code = 1006) => c.emit('close', { code, reason: '' });
  c.of = (type) => c.sent.filter((m) => m.type === type);
  return c;
}

/** A Daemon constructed but never started: its WsServer is never listening. */
function inProcessDaemon(label, { cwd = null } = {}) {
  const home = fs.mkdtempSync(path.join(TMP, `${label}-`));
  const d = new Daemon({ home, port: 18999, log: () => {}, timeoutMs: 2_000, cwd: cwd ?? home, engineResumeMs: 60_000 });
  const connect = (hello) => {
    const conn = fakeConn();
    d.ws.emit('connection', conn, { origin: hello.role === 'engine' ? 'chrome-extension://test' : null, path: '/g9' });
    conn.say(hello);
    return conn;
  };
  return { d, home, connect };
}

/**
 * Wait for the daemon's answer to one admin op. #admin replies only once the op
 * has fully finished, so the reply — not a fixed number of milliseconds — is the
 * moment the op's effects are all visible.
 *
 * It matters for `watch`: that op awaits evidence.startRun() (mkdir plus an
 * atomic engine.json write) before it tells the extension to stream, and a
 * cancelled one awaits finishRun() (the run's write chain plus an atomic
 * result.json) before it closes its run. Measured on this machine, the gap
 * between the admin message and the extension being told `on:true` is ~6 ms
 * idle but exceeded 20 ms in 12 of 30 samples under load, with a worst case of
 * 806 ms; a cancelled run was still open 307 ms later. The old fixed
 * sleep(20)/sleep(60) therefore failed whenever the machine was busy.
 */
async function adminDone(conn, id, timeoutMs = 15_000) {
  const find = () => conn.of('result').find((m) => m.id === id);
  await waitUntil(() => !!find(), timeoutMs);
  const res = find();
  assert.equal(res.ok, true, `admin op #${id} failed: ${res.error}`);
  return res.result;
}

test('D-c over the protocol: a reconnect takes its identity back; one that races the old socket supersedes it; live views are asked again', async () => {
  const { d, connect } = inProcessDaemon('dc');
  const hello = (tabs) => ({ type: 'hello', role: 'engine', version: '2.0.0',
    client: { name: 'extension', instanceId: 'inst-hhhhhhhh', loadId: 'load-1', tabs } });
  const first = connect(hello([{ tabId: 101, url: 'https://a.test/' }]));
  assert.equal(first.of('welcome')[0].id, 'engine-1');
  first.say({ type: 'event', event: 'tabs', data: { tabs: [{ tabId: 101, url: 'https://a.test/' }] } });
  const handle = d.registry.handleForChrome('engine-1', 101, { create: false });
  assert.ok(Number.isInteger(handle));
  const ui = connect({ type: 'hello', role: 'ui', version: '2.0.0', client: { name: 'test-ui' } });
  ui.say({ type: 'admin', id: 1, op: 'watch', tabId: handle });
  await adminDone(ui, 1);
  assert.equal(first.of('watch').at(-1)?.on, true);

  // The worker restarts: the old socket closes, a new one says hello with the same identity.
  first.drop();
  assert.equal(d.registry.isParked('engine-1'), true);
  const second = connect(hello([{ tabId: 101, url: 'https://a.test/' }]));
  assert.equal(second.of('welcome')[0].id, 'engine-1', 'the same engine id');
  assert.equal(d.registry.handleForChrome('engine-1', 101, { create: false }), handle, 'the same handle');
  assert.deepEqual(second.of('watch').map((m) => [m.tabId, m.on]), [[101, true]], 'the live view is asked for again');

  // An extension reload whose new socket beats the old one's close: the old one is superseded.
  const third = connect(hello([{ tabId: 101, url: 'https://a.test/' }]));
  assert.equal(third.of('welcome')[0].id, 'engine-1');
  assert.match(second.closed?.reason ?? '', /superseded/);
  second.say({ type: 'event', event: 'tabs', data: { tabs: [] } }); // a stale list from the old socket…
  second.drop(); // …and its late close
  assert.equal(d.registry.getClient('engine-1')?.conn, third, 'the new connection stays registered');
  assert.equal(d.registry.hasHandle(handle), true, 'the stale list dropped nothing');
  await d.stop('test over').catch(() => {});
});

test('review: watch then unwatch (or a UI that closes) leaves no stream and no open run', async () => {
  // startRun does file I/O, and admin messages are not serialised: #stopWatching used to find no run
  // yet, send on:false, and then #watch sent on:true — the tab was screencast and spooled with
  // nobody watching, until the daemon stopped (daemon review, 2026-09-22).
  const { d, connect } = inProcessDaemon('watchrace');
  const ext = connect({ type: 'hello', role: 'engine', version: '2.0.0', client: { name: 'extension', instanceId: 'inst-watchrace', loadId: 'l1', tabs: [{ tabId: 101, url: 'https://a.test/' }] } });
  ext.say({ type: 'event', event: 'tabs', data: { tabs: [{ tabId: 101, url: 'https://a.test/' }] } });
  const handle = d.registry.handleForChrome('engine-1', 101, { create: false });
  assert.ok(Number.isInteger(handle));

  const ui = connect({ type: 'hello', role: 'ui', version: '2.0.0', client: { name: 'test-ui' } });
  ui.say({ type: 'admin', id: 1, op: 'watch', tabId: handle });
  ui.say({ type: 'admin', id: 2, op: 'unwatch', tabId: handle }); // inside the startRun window
  await adminDone(ui, 1); // both ops answered: whatever either was going to do, it has done
  await adminDone(ui, 2);
  assert.equal(ext.of('watch').at(-1)?.on, false, 'the extension is not left streaming');
  assert.deepEqual(d.evidence.activeRuns(), [], 'no watch run is left open');
  assert.equal(d.watchers.has(handle), false);
  assert.equal(d.watchRuns.has(handle), false);

  // The same when the UI simply goes away (the desktop quitting, or its socket dropping).
  const ui2 = connect({ type: 'hello', role: 'ui', version: '2.0.0', client: { name: 'test-ui-2' } });
  ui2.say({ type: 'admin', id: 1, op: 'watch', tabId: handle });
  ui2.drop();
  await adminDone(ui2, 1); // the answer still reaches the dead socket's buffer, and marks the op done
  assert.equal(ext.of('watch').at(-1)?.on, false);
  assert.deepEqual(d.evidence.activeRuns(), []);

  // A watch nobody cancels still works, and its run is closed when it ends.
  const ui3 = connect({ type: 'hello', role: 'ui', version: '2.0.0', client: { name: 'test-ui-3' } });
  ui3.say({ type: 'admin', id: 1, op: 'watch', tabId: handle });
  await adminDone(ui3, 1);
  assert.equal(ext.of('watch').at(-1)?.on, true);
  assert.equal(d.evidence.activeRuns().length, 1);
  ui3.say({ type: 'admin', id: 2, op: 'unwatch', tabId: handle });
  await adminDone(ui3, 2);
  assert.equal(ext.of('watch').at(-1)?.on, false);
  assert.deepEqual(d.evidence.activeRuns(), []);
  await d.stop('test over').catch(() => {});
});

test('review: a LAUNCHED watch and the unwatch that overtakes it are serialised — the last request wins', async () => {
  // The Engine 2 counterpart of the watch/unwatch race above. On a launched engine the stream is
  // started over CDP, so #watch waits a SECOND time — after the cancel guard is already spent —
  // and an unwatch that arrives inside that wait used to be handed straight to
  // EngineManager.watch(false) while the start was still in flight. Nothing in this daemon put
  // those two in order: extension/lib/screencast.js keeps a per-tab chain of its own (Engine 1's
  // fix, which stops a stop overtaking the start it follows), but EngineManager imports it in a
  // try/catch as an OPTIONAL module and it knows nothing of the pointer subscription, the watchdog
  // or `watches` — the state the manager itself owns. Measured on the daemon before the fix: the
  // stop reached the screencast layer while the start was still open, the start then landed on top
  // of it, and the tab was left streaming with no consumer and no watcher. And a start the browser
  // REFUSED was logged and answered "watching: true", leaving the desktop a live view that was not
  // live and a watch run open until the daemon stopped.
  const { d, connect } = inProcessDaemon('watchrace2');
  d.registry.addLaunchedEngine({ engineId: 'launched-1' });
  const handle = d.registry.allocHandle();
  d.registry.bindHandle(handle, 'launched-1');

  // A screencast layer of the plainest kind — no chain of its own, which is the point: it records
  // what it is asked to do, and the test decides when each start lands or refuses.
  let order = [];
  const consumers = new Set();
  let streaming = false;
  let hold = null; // the NEXT start waits for this, so a start can be held open with no sleep
  const holdNextStart = () => {
    let land;
    let refuse;
    const promise = new Promise((res, rej) => { land = res; refuse = rej; });
    promise.catch(() => {}); // settled by the test; never an unhandled rejection
    hold = { promise, land, refuse };
    return hold;
  };
  d.engines.optional.pointer = { subscribe: () => () => {} };
  d.engines.optional.screencast = {
    subscribe: () => {},
    watchdog: () => () => {},
    start: async (tabId, id) => {
      order.push(`start ${id}`);
      consumers.add(id);
      const held = hold;
      hold = null;
      if (held) await held.promise;
      streaming = true;
      order.push(`streaming ${id}`);
    },
    stop: async (tabId, id) => {
      order.push(`stop ${id}`);
      consumers.delete(id);
      if (!consumers.size) streaming = false;
    },
  };

  const ui = connect({ type: 'hello', role: 'ui', version: '2.0.0', client: { name: 'test-ui' } });

  // 1. Unwatch while the browser is still answering the start.
  const first = holdNextStart();
  ui.say({ type: 'admin', id: 1, op: 'watch', tabId: handle });
  await waitUntil(() => order.includes(`start ui-watch`)); // the start is in flight — no sleep
  ui.say({ type: 'admin', id: 2, op: 'unwatch', tabId: handle });
  await waitUntil(() => !d.watchers.has(handle)); // the unwatch has reached #stopWatching
  assert.deepEqual(order, ['start ui-watch'], 'the stop is not handed to the screencast while the start is still open');
  first.land();
  await adminDone(ui, 1);
  await adminDone(ui, 2);
  assert.deepEqual(order, ['start ui-watch', 'streaming ui-watch', 'stop ui-watch'], 'both, in the order they were asked for');
  assert.equal(streaming, false, 'the launched tab is not left streaming with nobody watching');
  assert.deepEqual([...consumers], []);
  assert.equal(d.engines.watches.size, 0, 'no stale "watching" entry in the manager');
  assert.equal(d.watchRuns.has(handle), false);
  assert.deepEqual(d.evidence.activeRuns(), [], 'no watch run is left open');
  assert.deepEqual(ui.of('result').find((m) => m.id === 1).result, { watching: false, tabId: handle }, 'and the answer says so');

  // 2. The opposite state: a stream the browser refuses is never reported as a live view.
  order = [];
  holdNextStart().refuse(new Error('the page is gone'));
  ui.say({ type: 'admin', id: 3, op: 'watch', tabId: handle });
  const refused = await adminDone(ui, 3);
  assert.equal(refused.watching, false);
  assert.match(refused.problem ?? '', /the page is gone/);
  assert.equal(d.watchers.has(handle), false, 'nobody is left watching a tab that never streamed');
  assert.equal(d.watchRuns.has(handle), false);
  assert.deepEqual(d.evidence.activeRuns(), [], 'and its run is closed, not left open until the daemon stops');

  // 3. A start that fails LATE must not tear down the watch that replaced it: same tab, same
  //    consumer id, one call later. Held open, cancelled, watched again, and only then refused.
  order = [];
  const stale = holdNextStart();
  ui.say({ type: 'admin', id: 4, op: 'watch', tabId: handle });
  await waitUntil(() => order.includes('start ui-watch'));
  ui.say({ type: 'admin', id: 5, op: 'unwatch', tabId: handle });
  await waitUntil(() => !d.watchers.has(handle));
  ui.say({ type: 'admin', id: 6, op: 'watch', tabId: handle });
  await waitUntil(() => d.watchRuns.has(handle)); // the second watch has asked the manager to start
  stale.refuse(new Error('the page is gone'));
  await adminDone(ui, 4);
  await adminDone(ui, 5);
  const live = await adminDone(ui, 6);
  assert.equal(live.watching, true);
  assert.equal(streaming, true, 'the watch that replaced the failed one is still streaming');
  assert.deepEqual([...consumers], ['ui-watch']);
  assert.equal(d.engines.watches.size, 1);
  assert.equal(d.watchers.get(handle)?.size, 1);
  assert.equal(d.evidence.activeRuns().length, 1);
  await d.stop('test over').catch(() => {});
  assert.equal(streaming, false, 'and the shutdown stops it');
});

test('review: the "ui" role (admin) is only accepted from a native connection, and the welcome names the daemon instance', async () => {
  // A browser extension that said hello as "ui" could rewrite settings.updateUrl, which the desktop's
  // updater then followed (desktop review, 2026-09-22). And handles restart at 1 in every daemon, so
  // a client must be able to tell one daemon instance from another (welcome.bootId).
  const { d } = inProcessDaemon('uiorigin');
  const hello = (origin) => {
    const conn = fakeConn();
    d.ws.emit('connection', conn, { origin, path: '/g9', originKind: classifyOrigin(origin).kind });
    conn.say({ type: 'hello', role: 'ui', version: '2.0.0', client: { name: 'pretender' } });
    return conn;
  };
  const fromExtension = hello('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
  assert.match(fromExtension.of('welcome')[0].problem ?? '', /only for native clients/);
  assert.equal(fromExtension.closed?.code, undefined, 'closed on a timer, after the welcome');
  const native = hello(null);
  const welcome = native.of('welcome')[0];
  assert.equal(welcome.problem, undefined);
  assert.equal(welcome.id, 'ui-1');
  assert.ok(typeof welcome.bootId === 'string' && welcome.bootId.length >= 8, 'the welcome names this daemon instance');
  assert.equal(welcome.startedAt, d.startedAt);
  assert.equal(d.health().bootId, welcome.bootId);
  await d.stop('test over').catch(() => {});
});

test('F5: flowlib reads the flow from flowId (the correlation id is only echoed); a v1 message falls back to id', async () => {
  const project = fs.mkdtempSync(path.join(TMP, 'flows-'));
  fs.writeFileSync(path.join(project, 'g9.project.json'), JSON.stringify({ flowsDir: 'flows' }));
  fs.mkdirSync(path.join(project, 'flows'), { recursive: true });
  fs.writeFileSync(path.join(project, 'flows', 'checkout.json'), JSON.stringify({ id: 'checkout', name: 'Checkout', steps: [] }));
  const { d, connect } = inProcessDaemon('f5', { cwd: project });
  const ext = connect({ type: 'hello', role: 'engine', version: '2.0.0', client: { name: 'extension' } });
  // waitUntil's bound (10 s), not a hand-rolled 500 ms one: these ops read flow files off disk, and
  // adminDone above records what a few-hundred-millisecond wait is worth on a busy machine — the
  // gap between an admin message and its effect exceeded 20 ms in 12 of 30 samples, worst case
  // 806 ms. Nothing here measures speed; the answer arriving at all is the assertion.
  const answer = async (id) => {
    const find = () => ext.sent.find((x) => (x.type === 'flowlibResult' || x.type === 'response') && x.id === id);
    await waitUntil(() => !!find());
    return find();
  };
  ext.say({ type: 'flowlib', id: 7, op: 'read', flowId: 'checkout' });
  const read = await answer(7);
  assert.equal(read.ok, true, read.error);
  assert.equal(read.result.spec.id, 'checkout');
  ext.say({ type: 'flowlib', id: 8, op: 'read', flowId: 'checkout' }); // the same flow twice at once is fine
  ext.say({ type: 'flowlib', id: 9, op: 'read', flowId: 'checkout' });
  assert.equal((await answer(8)).ok && (await answer(9)).ok, true);
  ext.say({ type: 'flowlib', id: 'checkout', op: 'read' }); // v1 shape: the flow in `id`
  assert.equal((await answer('checkout')).result.spec.id, 'checkout');
  ext.say({ type: 'request', id: 12, op: 'flowlib', flowOp: 'read', flowId: 'checkout' });
  assert.equal((await answer(12)).result.spec.id, 'checkout', 'as a request, too');
  ext.say({ type: 'request', id: 13, op: 'flowlib', flowOp: 'read' });
  assert.match((await answer(13)).error, /needs a flowId/, 'a request never reads its correlation id as a flow');
  ext.say({ type: 'flowlib', id: 14, op: 'read', flowId: 'nope' });
  assert.match((await answer(14)).error, /No flow with id "nope"/);
  await d.stop('test over').catch(() => {});
});

test('F7: an engine\'s record of a call the daemon relayed is not forwarded to the desktop; the panel\'s own actions are', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const ui = [];
  router.emitUi = (topic, data) => ui.push({ topic, data });
  const a = agent(reg, 'cursor');
  const { client: ext, sent } = fakeExtension(reg, router, (msg) => ({ ok: true, echoedCaller: msg.caller }));
  const h = reg.handleForChrome(ext.id, 3);
  const res = await router.call(a, 'browser_snapshot', { tabId: h });
  const relayed = sent.filter((m) => m.type === 'call').at(-1);
  assert.equal(relayed.caller.relayed, true, 'relayed calls are tagged');
  assert.equal(res.echoedCaller.agentId, a.id);
  router.onEngineEvent(ext.id, 'activity', { kind: 'tool', tool: 'browser_snapshot', by: 'cursor', relayed: true, ok: true });
  assert.equal(ui.filter((u) => u.topic === 'activity').length, 0, 'the echo is dropped');
  router.onEngineEvent(ext.id, 'activity', { kind: 'tool', tool: 'browser_recording', ok: true, detail: 'panel replay' });
  assert.equal(ui.filter((u) => u.topic === 'activity').length, 1, 'a panel action is kept');
  assert.equal(ui.at(-1).data.engine, ext.id);
});

test('F7: the shared runtime tags the activity record of a relayed call (and only that)', async () => {
  const runtime = await import('../../extension/tools/index.js');
  const events = [];
  runtime.setHooks({ emit: (event, data) => events.push({ event, data }) });
  try {
    await runtime.runTool('browser_tabs', { action: 'pin' }, { agentId: 'agent-1', name: 'cursor', relayed: true }).catch(() => {});
    await runtime.runTool('browser_tabs', { action: 'pin' }, null).catch(() => {});
  } finally {
    runtime.setHooks({ emit: null });
  }
  const acts = events.filter((e) => e.event === 'activity').map((e) => e.data);
  assert.equal(acts.length, 2);
  assert.equal(acts[0].relayed, true);
  assert.equal(acts[0].by, 'cursor');
  assert.equal(acts[1].relayed, undefined, 'a call nobody relayed carries no tag');
});

test('F6: settings — updateChannel (stable|beta, default stable); a file:// updateUrl is refused with the reason', () => {
  assert.equal(DEFAULTS.updateChannel, 'stable');
  const file = path.join(TMP, 'settings-f6.json');
  const s = new Settings(file);
  assert.equal(s.get().updateChannel, 'stable');
  assert.equal(s.set({ updateChannel: 'beta' }).updateChannel, 'beta');
  assert.throws(() => s.set({ updateChannel: 'nightly' }), /updateChannel must be one of stable, beta/);
  assert.throws(() => s.set({ updateUrl: 'file:///C:/updates' }), /cannot be a file:\/\/ URL[\s\S]*electron-updater[\s\S]*http\(s\)/);
  assert.throws(() => s.set({ updateUrl: 'FILE://server/share' }), /file:\/\//);
  assert.throws(() => s.set({ updateUrl: 'https://' }), /https:\/\/ URL/);
  // https only over the network: the installer is unsigned, so TLS to the feed host is all that
  // authenticates what the app downloads (desktop review, 2026-09-22). A local test feed may be http.
  assert.throws(() => s.set({ updateUrl: 'http://updates.example.test/g9' }), /authenticated\s+by TLS|must be https/);
  assert.equal(s.set({ updateUrl: 'http://127.0.0.1:18080/g9' }).updateUrl, 'http://127.0.0.1:18080/g9');
  assert.equal(s.set({ updateUrl: 'https://updates.example.test/g9' }).updateUrl, 'https://updates.example.test/g9');
  assert.equal(s.set({ updateChannel: null }).updateChannel, 'stable', 'null resets to the default');
  // A settings file that already holds a file:// feed loads with the feed ignored, and says so.
  fs.writeFileSync(file, JSON.stringify({ updateUrl: 'file:///D:/feed', updateChannel: 'weekly' }));
  const loaded = new Settings(file);
  assert.equal(loaded.get().updateUrl, '');
  assert.equal(loaded.get().updateChannel, 'stable');
  assert.ok(loaded.loadProblems.some((p) => /file:\/\//.test(p)));
});

test('F6: runs.list {active:true} lists every open run however old; /health and admin state report activeRuns', async () => {
  const { d, connect } = inProcessDaemon('f6');
  // 'calibrate' sorts before 'replay', so within one second the old run is still the oldest name.
  const old = await d.evidence.startRun({ kind: 'calibrate', label: 'a long calibration' });
  for (let i = 0; i < 4; i++) {
    const r = await d.evidence.startRun({ kind: 'replay', label: `short ${i}` });
    await d.evidence.finishRun(r.runId, { ok: true });
  }
  const ui = connect({ type: 'hello', role: 'ui', version: '2.0.0', client: { name: 'test-ui' } });
  const admin = async (id, op, extra = {}) => {
    ui.say({ type: 'admin', id, op, ...extra });
    for (let i = 0; i < 100; i++) {
      const m = ui.sent.find((x) => x.type === 'result' && x.id === id);
      if (m) return m;
      await sleep(10);
    }
    throw new Error(`no result for ${op}`);
  };
  const windowed = (await admin(1, 'runs.list', { limit: 2 })).result.runs;
  assert.ok(!windowed.some((r) => r.runId === old.runId), 'the newest-2 window misses the old open run…');
  const active = (await admin(2, 'runs.list', { active: true, limit: 2 })).result.runs;
  assert.deepEqual(active.map((r) => [r.runId, r.active]), [[old.runId, true]], '…active:true finds it');
  const health = d.health();
  assert.deepEqual(health.activeRuns.map((r) => [r.runId, r.kind]), [[old.runId, 'calibrate']]);
  assert.equal(health.launched, 0);
  const state = (await admin(3, 'state')).result;
  assert.deepEqual(state.activeRuns.map((r) => r.runId), [old.runId]);
  await d.evidence.finishRun(old.runId, { ok: true });
  assert.deepEqual(d.health().activeRuns, []);
  await d.stop('test over').catch(() => {});
});

test('contract gap: the launched-engine blob store answers stats() like the extension\'s (store.usage no longer walks every owner)', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'blobstats-'));
  for (const Store of [FileBlobs, MemoryBlobs]) {
    const b = Store === FileBlobs ? new FileBlobs(dir) : new MemoryBlobs();
    await b.put('blobs', { id: 'a1', owner: 'bug_1', size: 3, blob: Uint8Array.from([1, 2, 3]) });
    await b.put('blobs', { id: 'a2', owner: 'bug_2', size: 5, blob: new Uint8Array(5) });
    await b.put('video-frames', { id: 's:1', sessionId: 's', size: 7, blob: new Uint8Array(7) });
    assert.deepEqual(await b.stats('blobs'), { count: 2, bytes: 8 }, Store.name);
    await b.delete('blobs', 'a1');
    assert.deepEqual(await b.stats('blobs'), { count: 1, bytes: 5 }, Store.name);
  }
  assert.deepEqual(await new FileBlobs(dir).stats('blobs'), { count: 1, bytes: 5 }, 'read back from disk');
});

// ------------------------------------------------- 2026-09-22 review fixes

test('review: an engine is not handed out before its setup finished, nor while it is stopping', async () => {
  // It is in this.engines from the moment the browser answers (its own setup looks it up there), but
  // until `ready` its default context — and so every tab's stealth level — is unknown: a second
  // agent's open in that window got a tab the start-up stray sweep then closed, or a stealth tab
  // with Runtime enabled (engine review, 2026-09-22).
  const reg = new Registry();
  const m = new EngineManager({ home: TMP, registry: reg, settings: { get: () => ({ ...DEFAULTS }) } });
  m.ready = Promise.resolve();
  const opened = [];
  m.cdp = {
    tabInfo: (id) => ({ engineId: 'launched-1', browserContextId: 'D', url: 'about:blank', createdByG9: true }),
    createTab: async () => { opened.push(Date.now()); return { id: 501 }; },
    platform: {
      debugger: { attach: async () => {}, sendCommand: async () => ({}) },
      tabs: { get: async (id) => ({ id, url: 'about:blank', active: true }), update: async () => {} },
    },
  };
  let markReady;
  const readyPromise = new Promise((r) => { markReady = r; });
  const engine = {
    info: { engineId: 'launched-1', stealth: 'stealth', humanize: 'human', profile: 'automation' },
    conn: { send: async () => ({}) }, contexts: new Map(), defaultContextId: 'D', initialBlank: null,
    ready: false, readyPromise, closing: false,
  };
  m.engines.set('launched-1', engine);
  reg.addLaunchedEngine({ engineId: 'launched-1' });
  m.launching.set('automation', readyPromise);
  let openedTab = null;
  const open = m.openTab('launched-1', null, 'https://x.test/').then((r) => { openedTab = r; });
  await sleep(30);
  assert.equal(openedTab, null, 'the open waits for the engine to be ready');
  assert.equal(m.list()[0].starting, true, 'and it is listed as starting');
  assert.equal(m.currentTab(), null, 'its tabs are not handed out as a default either');
  engine.ready = true;
  m.launching.delete('automation');
  markReady();
  await open;
  assert.equal(openedTab.tabId, 501);
  assert.equal(await m.defaultEngineId(), 'launched-1');
  // A stopping engine is never handed out: it would fail with "Unknown engine" a moment later.
  engine.closing = true;
  await assert.rejects(m.openTab('launched-1', null, 'https://x.test/'), /is stopping/);
  assert.equal(m.list()[0].stopping, true);
  assert.equal(m.currentTab(), null);
});

test('review: every context sends its downloads to G9\'s own folder, from the moment it exists', async () => {
  // Without watch_downloads the browser used the PROFILE's default directory — the owner's own
  // Downloads — and G9 had no record of the file (engine review, 2026-09-22).
  const reg = new Registry();
  const home = fs.mkdtempSync(path.join(TMP, 'dl-'));
  const m = new EngineManager({ home, registry: reg, settings: { get: () => ({ ...DEFAULTS }) } });
  m.ready = Promise.resolve();
  const configured = [];
  m.cdp = {
    tabInfo: () => null,
    registerContext: () => {},
    configureContextDownloads: async (engineId, ctx, opts) => { configured.push({ engineId, ctx, ...opts }); },
  };
  m.engines.set('launched-1', {
    info: { engineId: 'launched-1', stealth: 'off', humanize: 'human' },
    conn: { send: async () => ({ browserContextId: 'CTX-9' }) },
    contexts: new Map(), defaultContextId: 'D', initialBlank: null, ready: true, closing: false,
  });
  reg.addLaunchedEngine({ engineId: 'launched-1' });
  const ctx = await m.createContext('launched-1', {});
  assert.equal(configured.length, 1);
  assert.equal(configured[0].ctx, 'CTX-9');
  assert.equal(configured[0].downloadPath, ctx.downloadPath);
  assert.ok(ctx.downloadPath.includes(path.join(home, 'downloads')), 'inside G9_HOME, not the profile folder');
  assert.equal(fs.existsSync(ctx.downloadPath), true, 'the folder exists before the browser needs it');
});

test('review: a stealth CONTEXT in an engine launched below stealth says navigator.webdriver is still true', async () => {
  const reg = new Registry();
  const m = new EngineManager({ home: TMP, registry: reg, settings: { get: () => ({ ...DEFAULTS }) } });
  m.ready = Promise.resolve();
  m.cdp = { tabInfo: () => null, registerContext: () => {}, configureContextDownloads: async () => {} };
  m.engines.set('launched-1', {
    info: { engineId: 'launched-1', stealth: 'off', humanize: 'human' },
    conn: { send: async () => ({ browserContextId: 'CTX-1' }) },
    contexts: new Map(), defaultContextId: 'D', initialBlank: null, ready: true, closing: false,
  });
  reg.addLaunchedEngine({ engineId: 'launched-1' });
  const ctx = await m.createContext('launched-1', { stealth: 'stealth' });
  assert.equal(ctx.stealth, 'stealth');
  assert.equal(ctx.environmentStealth, 'off', 'the browser\'s own level travels with the context');
  assert.match(ctx.warnings.join(' '), /navigator\.webdriver true[\s\S]*launch/);
  // In an engine launched at stealth there is nothing to warn about.
  m.engines.get('launched-1').info.stealth = 'stealth';
  const clean = await m.createContext('launched-1', { stealth: 'stealth' });
  assert.equal(clean.warnings, undefined);
  assert.equal(clean.environmentStealth, 'stealth');
});

test('review: an element or full-page screenshot is NOT a read — it is owned, queued, and refused to others', async () => {
  // It scrolls the element into view (wheel notches at the human levels) or resizes the viewport, so
  // as a "read" it ran on another agent's tab, unqueued, under their click in flight.
  assert.equal(fallbackIsReadOnly('browser_screenshot', {}), true);
  assert.equal(fallbackIsReadOnly('browser_screenshot', { area: 'viewport' }), true);
  assert.equal(fallbackIsReadOnly('browser_screenshot', { area: 'element', ref: 'e4' }), false);
  assert.equal(fallbackIsReadOnly('browser_screenshot', { area: 'fullpage' }), false);

  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  const b = agent(reg, 'b');
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  fakeExtension(reg, router, async (msg) => {
    if (msg.tool === 'browser_tabs') return { tabs: [{ tabId: 9 }] };
    order.push(`${msg.tool}:${msg.args.area ?? msg.args.action ?? ''}`);
    if (msg.args.ref === 'slow') await gate;
    return { ok: true };
  });
  const h = (await router.call(a, 'browser_tabs', { action: 'list' })).tabs[0].tabId;
  const click = router.call(a, 'browser_interact', { action: 'click', ref: 'slow', tabId: h });
  await sleep(5);
  // B may still read the page…
  assert.ok(await router.call(b, 'browser_screenshot', { area: 'viewport', tabId: h }));
  // …but not scroll it with an element capture.
  await assert.rejects(router.call(b, 'browser_screenshot', { area: 'element', ref: 'e2', tabId: h }), /owned by agent-1/);
  await assert.rejects(router.call(b, 'browser_screenshot', { area: 'fullpage', tabId: h }), /owned by agent-1/);
  // A's own element capture waits for its own click instead of scrolling under it.
  const shot = router.call(a, 'browser_screenshot', { area: 'element', ref: 'e2', tabId: h });
  await sleep(10);
  assert.deepEqual(order, ['browser_interact:click', 'browser_screenshot:viewport'], 'the element shot is queued');
  release();
  await click;
  await shot;
  assert.deepEqual(order, ['browser_interact:click', 'browser_screenshot:viewport', 'browser_screenshot:element']);
});

test('review: a tab opened in the person\'s browser says it is in the BACKGROUND (readable, not clickable)', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  fakeExtension(reg, router, (msg) => (msg.tool === 'browser_tabs' && msg.args.action === 'open'
    ? { tabId: 21, url: msg.args.url }
    : { tabs: [] }));
  const opened = await router.call(a, 'browser_tabs', { action: 'open', url: 'https://shop.test/' });
  assert.equal(opened.background, true);
  assert.match(opened.hint, /but not clicked or typed into/);
  const focused = await router.call(a, 'browser_tabs', { action: 'open', url: 'https://shop.test/2', focus: true });
  assert.equal(focused.background, undefined, 'focus:true opens it in front, so there is nothing to warn about');
});

test('review: a queued call fails at its turn when its agent disconnected or another agent took the tab', async () => {
  const reg = new Registry();
  const router = makeRouter(reg);
  const a = agent(reg, 'a');
  const b = agent(reg, 'b');
  const ran = [];
  const gates = { release: null };
  const newGate = () => { gates.current = new Promise((r) => { gates.release = r; }); };
  newGate();
  fakeExtension(reg, router, async (msg) => {
    if (msg.tool === 'browser_tabs') return { tabs: [{ tabId: 4 }] };
    ran.push(msg.args.ref);
    if (String(msg.args.ref).startsWith('slow')) await gates.current;
    return { ok: true };
  });
  const h = (await router.call(a, 'browser_tabs', { action: 'list' })).tabs[0].tabId;
  const first = router.call(a, 'browser_interact', { action: 'click', ref: 'slow', tabId: h });
  await sleep(5);
  const queued = router.call(a, 'browser_interact', { action: 'click', ref: 'delete-account', tabId: h });
  await sleep(5);
  reg.removeClient(a.id); // the agent's MCP client exited: its claims are released
  const other = agent(reg, 'b2');
  reg.claim(h, other.id, { force: true });
  gates.release();
  await first;
  await assert.rejects(queued, /disconnected before its turn/);
  assert.ok(!ran.includes('delete-account'), 'it never reached the engine');

  // The same at a takeover, with the agent still connected.
  const c = agent(reg, 'c');
  reg.claim(h, c.id, { force: true });
  newGate();
  const slow = router.call(c, 'browser_interact', { action: 'click', ref: 'slow-again', tabId: h });
  await sleep(5);
  const queued2 = router.call(c, 'browser_interact', { action: 'click', ref: 'after-takeover', tabId: h });
  await sleep(5);
  reg.claim(h, b.id, { force: true });
  gates.release();
  await slow;
  await assert.rejects(queued2, /owned by agent-2 \(b\)/);
  assert.ok(!ran.includes('after-takeover'));
});

test('review: a call that waits for a maxParallel slot past its deadline is dropped, not run later', async () => {
  // It used to stay parked: the click the agent was told had failed ran minutes later, beside its
  // own retry on the same tab — and the message blamed a JavaScript dialog.
  const reg = new Registry();
  const started = [];
  const m = new EngineManager({ home: TMP, registry: reg, settings: { get: () => ({ ...DEFAULTS, maxParallel: 1 }) } });
  m.ready = Promise.resolve();
  m.cdp = { tabInfo: () => ({ engineId: 'launched-1', browserContextId: null, url: 'https://x/' }) };
  let releaseHolder;
  const holder = new Promise((r) => { releaseHolder = r; });
  m.tools = {
    isReadOnly: () => false,
    runTool: async (tool, args) => {
      started.push(args.ref);
      if (args.ref === 'holder') await holder;
      return { ok: true };
    },
  };
  reg.addLaunchedEngine({ engineId: 'launched-1', kind: 'launched' });
  reg.bindHandle(7, 'launched-1');
  reg.bindHandle(8, 'launched-1');
  const router = new Router({
    registry: reg, engines: m, settings: { get: () => ({ ...DEFAULTS, maxParallel: 1 }) }, version: '2.0.0',
    info: () => ({ pid: 1, port: 18001, home: TMP, startedAt: Date.now() }), timeoutMs: 300,
  });
  const a = agent(reg, 'a');
  const b = agent(reg, 'b');
  // The daemon's own timers are unref'd (a real daemon is kept alive by its socket): keep this
  // process awake while they run.
  const keepAlive = setInterval(() => {}, 20);
  try {
    const long = router.call(a, 'browser_interact', { action: 'click', ref: 'holder', tabId: 7 });
    await sleep(20);
    const waiting = router.call(b, 'browser_interact', { action: 'click', ref: 'waits', tabId: 8 });
    await assert.rejects(waiting, /maxParallel=1[\s\S]*nothing was sent to the page/);
    await assert.rejects(waiting, /not-delivered/);
    releaseHolder();
    await long;
    await sleep(50);
    assert.deepEqual(started, ['holder'], 'the abandoned call never ran');
    assert.equal(m.active, 0, 'its slot was not leaked');
  } finally {
    clearInterval(keepAlive);
  }
});

test('review: a call that hits its deadline is CANCELLED, and the tab\'s queue waits until it has stopped', async () => {
  // The deadline used to reject and move on while the engine kept going: the rest of a long
  // humanized type went into whatever the next call focused, and its spaces pressed the button that
  // call had clicked (docs review, 2026-09-22: 24 extra activations after a 15 s deadline).
  const reg = new Registry();
  const started = [];
  let longStoppedAt = 0;
  const m = new EngineManager({ home: TMP, registry: reg, settings: { get: () => ({ ...DEFAULTS }) } });
  m.ready = Promise.resolve();
  m.cdp = { tabInfo: () => ({ engineId: 'launched-1', browserContextId: null, url: 'https://x/' }) };
  m.tools = {
    isReadOnly: () => false,
    runTool: async (tool, args, caller) => {
      started.push({ ref: args.ref, at: Date.now() });
      if (args.ref !== 'long') return { ok: true };
      // As lib/humanize.js perform does: stop between steps once the signal fires, and say what
      // was sent.
      await new Promise((resolve, reject) => {
        caller.signal.addEventListener('abort', () => setTimeout(() => {
          longStoppedAt = Date.now();
          reject(new Error('3 of 12 input events of this type were sent; the rest were not.'));
        }, 40));
      });
      return { ok: true };
    },
  };
  reg.addLaunchedEngine({ engineId: 'launched-1', kind: 'launched' });
  reg.bindHandle(5, 'launched-1');
  const router = new Router({
    registry: reg, engines: m, settings: { get: () => ({ ...DEFAULTS }) }, version: '2.0.0',
    info: () => ({ pid: 1, port: 18001, home: TMP, startedAt: Date.now() }), timeoutMs: 600,
  });
  const a = agent(reg, 'a');
  const keepAlive = setInterval(() => {}, 20);
  try {
    const long = router.call(a, 'browser_interact', { action: 'type', text: 'x', ref: 'long', tabId: 5 });
    await sleep(20);
    const next = router.call(a, 'browser_interact', { action: 'click', ref: 'next', tabId: 5 });
    await assert.rejects(long, /did not finish within 1s, so G9 stopped it: 3 of 12 input events/);
    await next;
    assert.deepEqual(started.map((s) => s.ref), ['long', 'next']);
    assert.ok(longStoppedAt > 0 && started[1].at >= longStoppedAt,
      'the queued call started only after the cancelled one had really stopped (not when the agent was told)');
  } finally {
    clearInterval(keepAlive);
  }
});

test('review: browser_interact\'s deadline grows with the text it types', () => {
  // A flat 120 s ran out at roughly 650 characters of humanized typing, and the call kept typing
  // into whatever the next call focused.
  const base = 120_000;
  assert.equal(timeoutFor('browser_interact', { action: 'click' }, base), base);
  assert.equal(timeoutFor('browser_interact', { action: 'type', text: 'x'.repeat(200) }, base), base + 200 * INPUT_MS_PER_CHAR);
  assert.equal(timeoutFor('browser_interact', { action: 'type', text: 'x'.repeat(200), fast: true }, base), base);
  assert.equal(timeoutFor('browser_interact', { action: 'key', key: 'ArrowDown', repeat: 11 }, base), base + 10 * INPUT_MS_PER_CHAR);
  assert.ok(interactInputMs({ action: 'type', text: 'abc' }) > 0);
});

test('review: a launched engine is HELD across a run and stopped by the daemon, not by whoever finishes first', async () => {
  // Two overlapping scheduled suites on one profile: the run that launched the engine used to stop
  // it at its end — between the other run's flows, which then failed with "Unknown engine".
  const reg = new Registry();
  const stopped = [];
  const engines = {
    ...stubEngines(),
    available: () => true,
    list: () => (reg.launched.has('launched-1') ? [{ engineId: 'launched-1', kind: 'launched', profile: 'automation' }] : []),
    launch: async () => {
      reg.addLaunchedEngine({ engineId: 'launched-1', kind: 'launched', profile: 'automation' });
      return { engineId: 'launched-1', kind: 'launched', profile: 'automation' };
    },
    stop: async (id) => { stopped.push(id); reg.removeLaunchedEngine(id, 'stopped'); },
  };
  const router = new Router({
    registry: reg, engines, settings: { get: () => ({ ...DEFAULTS }) }, version: '2.0.0',
    info: () => ({ pid: 1, port: 18001, home: TMP, startedAt: Date.now() }), timeoutMs: 2_000,
  });
  const a = agent(reg, 'runner-A');
  const b = agent(reg, 'runner-B');
  const launched = await router.call(a, 'browser_engine', { action: 'launch', lease: true, stopWhenReleased: true });
  assert.deepEqual(launched.lease.holders, [a.id]);
  await router.call(b, 'browser_engine', { action: 'acquire', engineId: 'launched-1' });
  // B is between two flows: it owns no tab, but the engine is still its.
  const aReleased = await router.call(a, 'browser_engine', { action: 'release', engineId: 'launched-1' });
  assert.equal(aReleased.stopped, false);
  assert.deepEqual(stopped, [], 'the engine another run holds is not stopped');
  // A plain stop by a third agent is refused by name.
  const c = agent(reg, 'c');
  await assert.rejects(router.call(c, 'browser_engine', { action: 'stop', engineId: 'launched-1' }), /in use by agent-2 \(runner-B\)/);
  // B's tab keeps it alive even after its release; closing the tab lets the daemon stop it.
  reg.bindHandle(3, 'launched-1');
  reg.ensureOwnership(3, b.id);
  const bReleased = await router.call(b, 'browser_engine', { action: 'release', engineId: 'launched-1' });
  assert.equal(bReleased.stopped, false, 'not while an agent owns a tab there');
  reg.dropHandle(3, 'closed');
  assert.deepEqual(await router.stopReleasedEngines(), ['launched-1']);
  assert.deepEqual(stopped, ['launched-1']);
});

test('review: a flow whose name slugs to another flow\'s file is written beside it, never over it', async () => {
  // "Checkout" and "checkout!", or two recordings both named "Login": the second write replaced the
  // first flow, which then vanished from the library and from every suite that selected it.
  const lib = new FlowLibrary(path.join(TMP, 'flows-collide'));
  const spec = (id, name) => ({ format: 'g9/flowspec', version: 1, id, name, folder: 'shop', target: { kind: 'web' }, steps: [] });
  const first = await lib.write(spec('rec_aaa111', 'Checkout'));
  assert.equal(first.file, 'web/shop/checkout.flow.json');
  const second = await lib.write(spec('rec_bbb222', 'checkout!'));
  assert.notEqual(second.file, first.file);
  assert.equal(second.file, 'web/shop/checkout-rec-bbb222.flow.json');
  assert.deepEqual(second.collidedWith, { id: 'rec_aaa111', name: 'Checkout', file: 'web/shop/checkout.flow.json' });
  assert.equal((await lib.read('rec_aaa111')).name, 'Checkout', 'the first flow is still there');
  assert.equal((await lib.read('rec_bbb222')).name, 'checkout!');
  // Pushing again is idempotent: each flow is found by its id.
  assert.equal((await lib.write(spec('rec_aaa111', 'Checkout'))).changed, false);
  assert.equal((await lib.write(spec('rec_bbb222', 'checkout!'))).changed, false);
  assert.equal((await lib.list()).flows.length, 2);
});

test('review: one daemon per G9_HOME — a second one on another port is refused, a stale lock is taken over', async () => {
  const { acquireHomeLock, checkHolder } = await import('../../daemon/home-lock.js');
  const home = fs.mkdtempSync(path.join(TMP, 'homelock-'));
  const health = (port, body) => async (url) => {
    if (url !== `http://127.0.0.1:${port}/health`) throw new Error('refused');
    return { json: async () => body };
  };
  const first = await acquireHomeLock(home, { pid: process.pid, fetchImpl: health(18111, {}) });
  assert.equal(first.ok, true);
  first.setPort(18111);
  // A second daemon on another port, while the first answers /health as g9d for this home.
  const second = await acquireHomeLock(home, { pid: process.pid + 1, fetchImpl: health(18111, { name: 'g9d', home, pid: process.pid, version: '2.0.0' }) });
  assert.equal(second.ok, false);
  assert.equal(second.holder.port, 18111);
  // A lock whose holder does not answer as g9d for this home is stale and taken over.
  const third = await acquireHomeLock(home, { pid: process.pid + 2, fetchImpl: health(18111, { ok: true, version: '1.7.21' }), waitMs: 0 });
  assert.equal(third.ok, true);
  third.release();
  assert.equal(fs.existsSync(path.join(home, 'daemon.lock')), false, 'the lock is removed on release');
  // A dead pid is never taken for a running daemon.
  fs.writeFileSync(path.join(home, 'daemon.lock'), JSON.stringify({ pid: 0x7ffffff0, port: 18112 }));
  const verdict = await checkHolder({ pid: 0x7ffffff0, port: 18112 }, home, { fetchImpl: health(18112, {}), waitMs: 0 });
  assert.equal(verdict.live, false);
});

test('review: two "Run now" for one schedule entry start ONE runner, and every run is finished', async () => {
  // The check and the reservation were separated by evidence.startRun (file I/O): both passed, two
  // runners started, and the first run stayed "active" until the daemon restarted.
  const home = fs.mkdtempSync(path.join(TMP, 'sched-race-'));
  const settings = new Settings(path.join(home, 'settings.json'));
  const evidence = new Evidence({ runsDir: path.join(home, 'runs'), settings });
  const sch = new Scheduler({ settings, evidence, repoRoot: TMP, port: () => 18001, home, project: () => null });
  // The "runner" is node itself, exiting at once.
  sch.runnerArgvFor = null;
  const entry = sch.add({ target: 'all', everyMinutes: 60 });
  const results = await Promise.allSettled([sch.runNow(entry.id), sch.runNow(entry.id)]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'exactly one runner started');
  assert.equal(refused.length, 1);
  assert.match(String(refused[0].reason?.message ?? ''), /already running/);
  await waitUntil(() => !sch.running.size, 20_000);
  await waitUntil(async () => (await evidence.activeRuns()).length === 0, 20_000);
  assert.deepEqual(await evidence.activeRuns(), [], 'the run it started was finished');
  sch.stop();
});

test('contract gap: the desktop\'s per-call timeouts never end a call before the daemon would (DAEMON_PROTOCOL §3)', async () => {
  const { callTimeoutMs } = await import('../../desktop/lib/daemon-client.mjs');
  const F = 120_000;
  const cases = [
    ['browser_status', {}], ['browser_snapshot', {}],
    ['browser_recording', { action: 'replay' }], ['browser_recording', { action: 'calibrate' }], ['browser_recording', { action: 'list' }],
    ['browser_navigate', {}], ['browser_navigate', { action: 'wait' }], ['browser_navigate', { timeoutMs: 200_000 }],
    ['browser_tabs', { action: 'wait' }], ['browser_tabs', { action: 'wait', timeoutMs: 400_000 }],
    ['browser_tabs', { action: 'open' }], ['browser_tabs', { action: 'session' }], ['browser_tabs', { action: 'handoff' }],
    ['browser_network', { action: 'wait_download' }], ['browser_network', { action: 'wait_download', timeoutMs: 900_000 }],
    ['browser_diagnose', { what: 'performance' }], ['browser_diagnose', { what: 'performance', durationMs: 120_000 }],
    ['browser_engine', { action: 'launch' }], ['browser_engine', { action: 'warm' }], ['browser_engine', { action: 'versions', download: true }],
  ];
  for (const [tool, args] of cases) {
    const daemonMs = timeoutFor(tool, args, F);
    const desktopMs = callTimeoutMs(tool, args, F);
    assert.ok(desktopMs >= daemonMs, `${tool} ${JSON.stringify(args)}: desktop ${desktopMs} < daemon ${daemonMs}`);
  }
});

test('contract gap: G9_HOME falls back like engine/find.js g9Home() on Windows without LOCALAPPDATA', async () => {
  const { g9Home } = await import('../../engine/find.js');
  const saved = { G9_HOME: process.env.G9_HOME, LOCALAPPDATA: process.env.LOCALAPPDATA };
  try {
    delete process.env.G9_HOME;
    assert.equal(resolveHome(undefined), g9Home(process.env));
    delete process.env.LOCALAPPDATA;
    assert.equal(resolveHome(undefined), g9Home(process.env), 'the same folder with LOCALAPPDATA unset');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('contract gap: launch lines in engine-versions.log use cft.js\'s one format', async () => {
  const home = fs.mkdtempSync(path.join(TMP, 'verlog-'));
  const { appendVersionLog } = await import('../../engine/cft.js');
  await appendVersionLog({ home, event: 'launch', kind: 'edge', version: '153.0.4234.32', engineId: 'launched-1', path: 'C:/Edge/msedge.exe', daemon: '2.0.0' });
  const line = fs.readFileSync(path.join(home, 'engine-versions.log'), 'utf8').trim();
  assert.match(line, /^\d{4}-\d\d-\d\dT[^\t]+\tlaunch\tedge 153\.0\.4234\.32\tengineId=launched-1\tpath=C:\/Edge\/msedge\.exe\tdaemon=2\.0\.0$/);
  const manager = fs.readFileSync(new URL('../../engine/manager.js', import.meta.url), 'utf8');
  assert.match(manager, /appendVersionLog\(\{[\s\S]*event: 'launch'/, 'EngineManager logs launches through it');
  assert.doesNotMatch(manager, /\\tlaunch\\t/, 'no second hand-rolled line format');
});

// ------------------------------------------------------------------ v3: projects push, agent rows

/** A folder with a g9.project.json holding these environments (none: no file at all). */
function projectDir(root, name, environments) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (environments !== undefined) fs.writeFileSync(path.join(dir, 'g9.project.json'), JSON.stringify({ environments }));
  return dir;
}

const engineHello = (instanceId, tabs) => ({ type: 'hello', role: 'engine', version: '2.0.3', client: { name: 'extension', instanceId, loadId: 'load-1', tabs } });
const agentHello = (name, cwd) => ({ type: 'hello', role: 'agent', version: '2.0.3', client: { name, ...(cwd ? { cwd } : {}) } });

test('v3: environmentHosts and projectLabel — hosts of http(s) environment URLs; the project folder, else the cwd folder', async () => {
  const { environmentHosts, projectLabel } = await import('../../daemon/daemon.js');
  assert.deepEqual(environmentHosts({
    test1: 'https://Test1.Shop.test/app',
    dev: { baseUrl: 'http://localhost:3000/', api: 'https://api.shop.test:443/', label: 'not a url', nested: { url: 'https://deep.test/' } },
    ftp: 'ftp://files.shop.test/',
    dup: 'https://test1.shop.test/other',
    list: ['https://listed.test/'],
  }), ['test1.shop.test', 'localhost:3000', 'api.shop.test'], 'one level deep, http(s) only, de-duplicated, default port omitted');
  assert.deepEqual(environmentHosts(undefined), []);
  assert.deepEqual(environmentHosts({}), []);
  assert.equal(projectLabel({ found: true, root: 'G:/work/shop' }, 'G:/work/shop/sub'), 'shop');
  assert.equal(projectLabel({ found: false, root: null }, 'C:\\work\\plain\\'), 'plain', 'Windows separators and a trailing one');
  assert.equal(projectLabel(null, null), null);
});

test('v3: {type:"projects"} — the CONNECTED agents\' project sites, after each welcome and coalesced on connect/disconnect', async () => {
  const root = fs.mkdtempSync(path.join(TMP, 'projects-'));
  const shop = projectDir(root, 'shop', { test1: 'https://Test1.Shop.test/', dev: { baseUrl: 'http://localhost:3000/app', note: 'not a url' } });
  const admin = projectDir(root, 'admin', { staging: 'https://admin.shop.test', same: 'https://test1.shop.test/x' });
  const bare = projectDir(root, 'bare', {});
  const { d, connect } = inProcessDaemon('projects', { cwd: projectDir(root, 'home') });
  const ext = connect(engineHello('inst-projects-1', []));
  assert.deepEqual(ext.of('projects'), [{ type: 'projects', domains: [], projects: [] }], 'sent right after the welcome, empty without agents');

  const a1 = connect(agentHello('claude-code', shop));
  const a2 = connect(agentHello('cursor', shop));
  const a3 = connect(agentHello('codex', admin));
  connect(agentHello('bare-agent', bare));
  const id = (c) => c.of('welcome')[0].id;
  await waitUntil(() => ext.of('projects').length === 2);
  await sleep(250);
  assert.equal(ext.of('projects').length, 2, 'four agents connecting together cost one push');
  const msg = ext.of('projects')[1];
  assert.deepEqual([...msg.domains].sort(), ['admin.shop.test', 'localhost:3000', 'test1.shop.test'], 'the de-duplicated union');
  const shopRow = msg.projects.find((p) => p.name === 'shop');
  assert.deepEqual(shopRow.domains, ['test1.shop.test', 'localhost:3000']);
  assert.deepEqual(shopRow.agents, [id(a1), id(a2)], 'one row per project file, naming its agents');
  assert.match(shopRow.path, /\/shop\/g9\.project\.json$/);
  assert.deepEqual(msg.projects.find((p) => p.name === 'admin').agents, [id(a3)]);
  assert.equal(msg.projects.some((p) => p.name === 'bare'), false, 'a project without environment URLs contributes nothing');

  a3.drop();
  await waitUntil(() => ext.of('projects').length === 3);
  assert.deepEqual([...ext.of('projects')[2].domains].sort(), ['localhost:3000', 'test1.shop.test'], 'a disconnected agent\'s sites leave the union');

  // A second browser gets the list as it stands, right after its welcome.
  const ext2 = connect(engineHello('inst-projects-2', []));
  assert.deepEqual([...ext2.of('projects')[0].domains].sort(), ['localhost:3000', 'test1.shop.test']);
  assert.equal(d.projectsPayload().projects.length, 1);
  await d.stop('test over').catch(() => {});
});

test('v3: agent rows name each agent\'s project and its current tab — this browser\'s Chrome id, or where it is instead', async () => {
  const root = fs.mkdtempSync(path.join(TMP, 'agentrows-'));
  const shop = projectDir(root, 'shop', { test1: 'https://test1.shop.test/' });
  const plain = projectDir(root, 'plain-folder');
  const { d, connect } = inProcessDaemon('agentrows', { cwd: projectDir(root, 'home') });
  const tabs = [{ tabId: 101, url: 'https://a.test/' }, { tabId: 102, url: 'https://b.test/' }];
  const ext = connect(engineHello('inst-rows-one', tabs));
  ext.say({ type: 'event', event: 'tabs', data: { tabs } });
  const other = connect(engineHello('inst-rows-two', [{ tabId: 101, url: 'https://c.test/' }]));
  other.say({ type: 'event', event: 'tabs', data: { tabs: [{ tabId: 101, url: 'https://c.test/' }] } });
  const extId = ext.of('welcome')[0].id;
  const otherId = other.of('welcome')[0].id;
  const a = connect(agentHello('claude-code', shop));
  const b = connect(agentHello('cursor', plain));
  const c = connect(agentHello('runner', null));
  const [aId, bId, cId] = [a, b, c].map((x) => x.of('welcome')[0].id);
  await waitUntil(() => d.registry.handleForChrome(extId, 101, { create: false }) != null && d.registry.handleForChrome(otherId, 101, { create: false }) != null);
  const here = d.registry.handleForChrome(extId, 101, { create: false });
  const there = d.registry.handleForChrome(otherId, 101, { create: false });
  d.registry.addLaunchedEngine({ engineId: 'launched-9' });
  const launched = d.registry.allocHandle();
  d.registry.bindHandle(launched, 'launched-9');
  await sleep(250); // every push the connections caused has gone out

  const before = ext.of('agents').length;
  for (let i = 0; i < 20; i++) d.registry.setCurrent(aId, i % 2 ? here : there); // a busy agent
  d.registry.setCurrent(aId, here);
  d.registry.setCurrent(bId, launched);
  d.registry.setCurrent(cId, there);
  await waitUntil(() => ext.of('agents').length > before);
  await sleep(250);
  const pushes = ext.of('agents').slice(before);
  assert.equal(pushes.length, 1, 'a burst of current-tab changes costs one push');
  const row = (list, agentId) => list.find((r) => r.id === agentId);
  const rows = pushes[0].agents;
  assert.deepEqual(row(rows, aId), {
    id: aId, name: 'claude-code', owned: [], halted: false, project: 'shop', cwd: shop, current: 101, currentEngine: 'extension',
  }, 'every v2 field kept; the project folder; this browser\'s Chrome tab id');
  assert.deepEqual([row(rows, bId).project, row(rows, bId).current, row(rows, bId).currentEngine], ['plain-folder', null, 'launched'],
    'no project file: the cwd folder; an Engine 2 tab has no Chrome id here');
  assert.deepEqual([row(rows, cId).project, row(rows, cId).cwd, row(rows, cId).current, row(rows, cId).currentEngine], [null, null, null, 'elsewhere'],
    'a tab in ANOTHER browser is not shown as a tab of this one');
  // The other browser sees the same agents from its side.
  await waitUntil(() => row(other.of('agents').at(-1).agents, cId)?.current === 101);
  assert.equal(row(other.of('agents').at(-1).agents, aId).currentEngine, 'elsewhere');

  // A tab that closes takes the agent's current pointer with it, and the rows say so.
  d.registry.dropHandle(here, 'the tab closed');
  await waitUntil(() => row(ext.of('agents').at(-1).agents, aId).current === null);
  assert.equal(row(ext.of('agents').at(-1).agents, aId).currentEngine, null);

  // The panel's `info` request carries the same rows.
  ext.say({ type: 'request', id: 77, op: 'info' });
  await waitUntil(() => ext.of('response').some((m) => m.id === 77));
  const info = ext.of('response').find((m) => m.id === 77);
  assert.equal(info.ok, true, info.error);
  assert.equal(row(info.result.agents, bId).project, 'plain-folder');
  assert.equal(row(info.result.agents, bId).currentEngine, 'launched');
  await d.stop('test over').catch(() => {});
});

// ------------------------------------------------------------------ run

try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  PASS ${name}`);
    } catch (err) {
      console.log(`  FAIL ${name}\n${err?.stack ?? err}`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
