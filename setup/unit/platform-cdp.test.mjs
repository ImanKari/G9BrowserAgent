#!/usr/bin/env node
/**
 * Unit tests for extension/lib/platform-cdp.js — the Engine 2 side of the
 * platform seam — against a FAKE CDP connection that behaves like a small
 * browser: targets, browser contexts, flat sessions, auto-attach, cookies and
 * download events. No network, no port (ARCHITECTURE §12.1). One `live:` test
 * at the end checks F1 against a real headless Edge (temp profile, closed and
 * checked), as engine.test.mjs's live tests do; G9_UNIT_NO_BROWSER=1 skips it.
 *
 * Run: node setup/unit/platform-cdp.test.mjs
 */
import assert from 'node:assert/strict';

// This process must look like the daemon, not the extension.
delete globalThis.chrome;
delete globalThis.browser;

const cdp = await import('../../extension/lib/platform-cdp.js');
const { platform } = cdp;

let failures = 0;
/** A test that cannot run here says so (`  SKIP`), and never counts as a pass. */
const skip = (reason) => { const e = new Error(reason); e.skip = true; throw e; };
async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    if (err?.skip) {
      console.log(`  SKIP ${name} — ${err.message}`);
      return;
    }
    failures += 1;
    console.error(`  FAIL ${name}\n${err?.stack ?? err}`);
    process.exit(1);
  }
}

// --------------------------------------------------------------- fake browser

/**
 * A browser-shaped CdpConnection: send(method, params, sessionId, opts),
 * on('event'|'close'), off(), close(). Events are emitted synchronously BEFORE
 * a command's response resolves — the harsher ordering for the code under test.
 */
class FakeBrowser {
  constructor(name, { pages = [] } = {}) {
    this.name = name;
    this.handlers = { event: new Set(), close: new Set() };
    this.sent = [];
    this.targets = new Map(); // targetId -> { targetId, type, url, title, browserContextId }
    this.sessions = new Map(); // sessionId -> { targetId, parent }
    this.contexts = new Set();
    this.autoAttach = false;
    this.discover = false;
    this.cookies = new Map(); // contextKey -> CDP cookie[]
    this.downloadBehavior = [];
    this.counter = 0;
    this.imageCalls = [];
    for (const p of pages) this.addTarget({ type: 'page', browserContextId: 'DEFAULT', ...p });
  }
  on(evt, fn) { this.handlers[evt].add(fn); }
  off(evt, fn) { this.handlers[evt].delete(fn); }
  emit(method, params, sessionId = null) {
    for (const fn of [...this.handlers.event]) fn(method, params, sessionId);
  }
  close() { for (const fn of [...this.handlers.close]) fn(); }
  id(prefix) { this.counter += 1; return `${this.name}-${prefix}${this.counter}`; }
  addTarget(info) {
    const t = { targetId: info.targetId ?? this.id('T'), type: info.type ?? 'page', url: info.url ?? 'about:blank', title: info.title ?? '', browserContextId: info.browserContextId ?? 'DEFAULT', attached: false, ...(info.openerId ? { openerId: info.openerId } : {}), ...(info.subtype ? { subtype: info.subtype } : {}) };
    // Real windows, as Chrome has them: a page the PAGE opens joins its opener's window; others say.
    t.windowId = info.windowId ?? (info.openerId ? this.targets.get(info.openerId)?.windowId : null) ?? 1;
    this.targets.set(t.targetId, t);
    return t;
  }
  info(t) { return { targetId: t.targetId, type: t.type, url: t.url, title: t.title, attached: t.attached, browserContextId: t.browserContextId, ...(t.openerId ? { openerId: t.openerId } : {}), ...(t.subtype ? { subtype: t.subtype } : {}) }; }
  attach(t, parent = null, waiting = false) {
    const sessionId = this.id('S');
    this.sessions.set(sessionId, { targetId: t.targetId, parent });
    t.attached = true;
    this.emit('Target.attachedToTarget', { sessionId, targetInfo: this.info(t), waitingForDebugger: waiting }, parent);
    return sessionId;
  }
  async send(method, params = {}, sessionId = null, opts = {}) {
    this.sent.push({ method, params, sessionId, opts });
    switch (method) {
      case 'Target.getBrowserContexts':
        return { browserContextIds: [...this.contexts], defaultBrowserContextId: 'DEFAULT' };
      case 'Target.createBrowserContext': {
        const id = this.id('CTX');
        this.contexts.add(id);
        return { browserContextId: id };
      }
      case 'Target.setDiscoverTargets':
        this.discover = true;
        for (const t of this.targets.values()) this.emit('Target.targetCreated', { targetInfo: this.info(t) });
        return {};
      case 'Target.setAutoAttach':
        if (!sessionId) {
          this.autoAttach = true;
          // As Chrome does: targets that already exist attach RUNNING; only new ones wait.
          this.waitOnStart = !!params.waitForDebuggerOnStart;
          for (const t of this.targets.values()) if (t.type === 'page' && !t.attached) this.attach(t);
        }
        return {};
      case 'Target.createTarget': {
        const context = params.browserContextId ?? 'DEFAULT';
        // As Chrome/Edge do (measured on headless Edge 153): a tab needs a window to join, and a
        // context with no page has none. `refuseTabIn` forces the refusal once (a racing close).
        const hasPage = [...this.targets.values()].some((t) => t.type === 'page' && t.browserContextId === context && !t.hidden);
        if (params.newWindow === false && (!hasPage || this.refuseTabIn === context)) {
          if (this.refuseTabIn === context) this.refuseTabIn = null;
          throw new Error('Failed to open new tab - no browser is open');
        }
        const t = this.addTarget({ type: 'page', url: params.url, browserContextId: context, windowId: params.newWindow ? 100 + this.counter : 1 });
        t.hidden = !!params.hidden;
        t.background = !!params.background;
        if (this.discover) this.emit('Target.targetCreated', { targetInfo: this.info(t) });
        if (this.autoAttach) this.attach(t, null, !!this.waitOnStart);
        return { targetId: t.targetId };
      }
      case 'Target.attachToTarget': {
        const t = this.targets.get(params.targetId);
        if (!t) throw new Error('No target with given id found');
        return { sessionId: this.attach(t) };
      }
      case 'Target.closeTarget': {
        const t = this.targets.get(params.targetId);
        for (const [sid, s] of this.sessions) {
          if (s.targetId === params.targetId) {
            this.sessions.delete(sid);
            this.emit('Target.detachedFromTarget', { sessionId: sid, targetId: params.targetId });
          }
        }
        this.targets.delete(params.targetId);
        if (t) this.emit('Target.targetDestroyed', { targetId: params.targetId });
        return { success: true };
      }
      case 'Target.activateTarget':
        return {};
      case 'Browser.getWindowForTarget': {
        if (!this.targets.has(params.targetId)) throw new Error('No target with given id found');
        // A headed engine launched off-screen: new windows must open where it lives.
        return { windowId: this.targets.get(params.targetId).windowId ?? 1, bounds: { ...(this.windowBounds ?? { left: 0, top: 0, width: 1920, height: 1032 }), windowState: 'normal' } };
      }
      case 'Target.getTargetInfo': {
        const t = this.targets.get(params.targetId);
        if (!t) throw new Error('No target with given id found');
        return { targetInfo: this.info(t) };
      }
      case 'Target.getTargets':
        return { targetInfos: [...this.targets.values()].map((t) => this.info(t)) };
      case 'Page.navigate': {
        const s = this.sessions.get(sessionId);
        const t = this.targets.get(s.targetId);
        t.url = params.url;
        this.emit('Target.targetInfoChanged', { targetInfo: this.info(t) });
        return { frameId: t.targetId, loaderId: this.id('L') };
      }
      case 'Storage.getCookies':
        return { cookies: structuredClone(this.cookies.get(params.browserContextId ?? 'DEFAULT') ?? []) };
      case 'Storage.setCookies': {
        const key = params.browserContextId ?? 'DEFAULT';
        const jar = this.cookies.get(key) ?? [];
        for (const c of params.cookies) {
          const host = c.url ? new URL(c.url).hostname : null;
          const domain = c.domain ?? host;
          const path = c.path ?? '/';
          const i = jar.findIndex((x) => x.name === c.name && x.domain === domain && x.path === path);
          if (i >= 0) jar.splice(i, 1);
          if (c.expires != null && c.expires > 0 && c.expires < Date.now() / 1000) continue; // expired = deleted
          jar.push({ name: c.name, value: c.value, domain, path, secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite, expires: c.expires ?? -1, session: c.expires == null });
        }
        this.cookies.set(key, jar);
        return {};
      }
      case 'Browser.setDownloadBehavior':
        this.downloadBehavior.push({ params, sessionId });
        return {};
      case 'Runtime.evaluate':
        return { result: { type: 'object', objectId: `global-${sessionId}` } };
      case 'Runtime.callFunctionOn': {
        this.imageCalls.push({ sessionId, params });
        // A 2x1 RGBA image, as the utility page would return it.
        const rgba = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]).toString('base64');
        if (String(params.functionDeclaration).includes('convertToBlob')) return { result: { value: 'iVBORw0KGgo=' } };
        return { result: { value: { width: 2, height: 1, sourceWidth: 40, sourceHeight: 20, rgba } } };
      }
      default:
        return {};
    }
  }
}

function pageSessionOf(browser, targetId) {
  for (const [sid, s] of browser.sessions) if (s.targetId === targetId && !s.parent) return sid;
  return null;
}

// Global handles, as the daemon supplies them.
let nextHandle = 100;
cdp.configure({
  allocTabId: () => ++nextHandle,
  version: '2.0.0',
  defaults: { humanize: 'human', stealth: 'off' },
  fileInfo: async (path) => ({ exists: true, size: 42, sha256: 'ab'.repeat(32), magicHex: '504b0304', mime: 'application/zip', path }),
});

const events = [];
const detaches = [];
const removed = [];
const created = [];
const updated = [];
const downloads = [];
platform.debugger.onEvent((source, method, params) => events.push({ source, method, params }));
platform.debugger.onDetach((source, reason) => detaches.push({ source, reason }));
platform.tabs.onRemoved((tabId) => removed.push(tabId));
platform.tabs.onCreated((tab) => created.push(tab));
platform.tabs.onUpdated((tabId, change) => updated.push({ tabId, change }));
platform.downloads.onEvent((evt) => downloads.push(evt));

const b1 = new FakeBrowser('b1', { pages: [{ url: 'https://app.example.com/', title: 'App' }] });
let tabA;

// ------------------------------------------------------------------- tests

await test('platform-cdp reports its name and a runtime without chrome', async () => {
  assert.equal(platform.name, 'cdp');
  assert.equal(platform.runtime.version(), '2.0.0');
  assert.equal(platform.runtime.getURL('x'), null);
  assert.doesNotThrow(() => platform.runtime.reload());
  assert.equal(platform.windows.WINDOW_ID_NONE, -1);
});

await test('registerEngine: discovery, browser-level auto-attach, existing page becomes a tab', async () => {
  await cdp.registerEngine('e1', b1);
  const methods = b1.sent.map((s) => s.method);
  assert.ok(methods.includes('Target.setDiscoverTargets'), 'setDiscoverTargets sent');
  const auto = b1.sent.find((s) => s.method === 'Target.setAutoAttach');
  assert.equal(auto.sessionId, null, 'auto-attach on the BROWSER session');
  // New targets are HELD until prepared, then resumed (live round 3: window.open wedged its opener).
  assert.deepEqual(auto.params, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const startup = cdp.tabInfo((await platform.tabs.query({}))[0].id).sessionId;
  assert.ok(b1.sent.some((s) => s.method === 'Runtime.runIfWaitingForDebugger' && s.sessionId === startup),
    'even the page that attached running is resumed (a held popup reports waitingForDebugger:false)');
  const tabs = await platform.tabs.query({});
  assert.equal(tabs.length, 1, 'only the real page is a tab');
  tabA = tabs[0];
  assert.equal(tabA.url, 'https://app.example.com/');
  assert.equal(tabA.title, 'App');
  assert.ok(tabA.id > 100, 'handle came from allocTabId');
  const info = cdp.tabInfo(tabA.id);
  assert.equal(info.engineId, 'e1');
  assert.ok(info.sessionId, 'page session stored');
  assert.deepEqual(cdp.tabsOf('e1'), [tabA.id]);
  assert.ok(created.some((t) => t.id === tabA.id), 'onCreated fired');
});

await test('the hidden image page lives in its own context and is never a tab', async () => {
  const create = b1.sent.find((s) => s.method === 'Target.createTarget' && s.params.hidden === true);
  assert.ok(create, 'utility page created hidden');
  assert.equal(create.params.url, 'about:blank');
  assert.ok(b1.contexts.has(create.params.browserContextId), 'in a dedicated browser context');
  const all = await platform.tabs.query({});
  assert.equal(all.length, 1);
  assert.ok(!all.some((t) => t.url === 'about:blank'));
});

await test('image.decode/encodePng run in the utility page, RGBA crosses as base64', async () => {
  const out = await platform.image.decode('AAAA', 'image/png', { width: 2, height: 1 });
  assert.equal(out.width, 2);
  assert.equal(out.height, 1);
  assert.equal(out.sourceWidth, 40);
  assert.ok(out.rgba instanceof Uint8ClampedArray);
  assert.deepEqual([...out.rgba], [255, 0, 0, 255, 0, 0, 255, 255]);
  const call = b1.imageCalls.at(-1);
  const imageTarget = [...b1.targets.values()].find((t) => t.hidden);
  assert.equal(b1.sessions.get(call.sessionId).targetId, imageTarget.targetId, 'sent on the image session');
  assert.deepEqual(call.params.arguments.map((a) => a.value).slice(1), ['image/png', { fit: null, width: 2, height: 1 }]);
  const png = await platform.image.encodePng({ width: 2, height: 1, rgba: out.rgba });
  assert.equal(png, 'iVBORw0KGgo=');
});

await test('events: page session → {tabId}; child sessions (nested) → {tabId, sessionId}', async () => {
  const page = cdp.tabInfo(tabA.id).sessionId;
  events.length = 0;
  b1.emit('Network.requestWillBeSent', { requestId: 'r1' }, page);
  assert.deepEqual(events[0].source, { tabId: tabA.id });

  // A cross-origin iframe attaches from the PAGE session, a nested one from the child.
  b1.emit('Target.attachedToTarget', { sessionId: 'C1', targetInfo: { targetId: 'F1', type: 'iframe', url: 'https://pay.example/' } }, page);
  b1.emit('Target.attachedToTarget', { sessionId: 'C2', targetInfo: { targetId: 'F2', type: 'iframe', url: 'https://inner.example/' } }, 'C1');
  assert.deepEqual(events.find((e) => e.method === 'Target.attachedToTarget').source, { tabId: tabA.id });
  b1.emit('Runtime.consoleAPICalled', { type: 'log', args: [] }, 'C1');
  b1.emit('Runtime.consoleAPICalled', { type: 'log', args: [] }, 'C2');
  const child = events.filter((e) => e.method === 'Runtime.consoleAPICalled');
  assert.deepEqual(child[0].source, { tabId: tabA.id, sessionId: 'C1' });
  assert.deepEqual(child[1].source, { tabId: tabA.id, sessionId: 'C2' });

  // Commands route to the child when asked, to the page otherwise.
  b1.sent.length = 0;
  await platform.debugger.sendCommand(tabA.id, 'DOM.getDocument', {}, 'C1');
  await platform.debugger.sendCommand(tabA.id, 'DOM.getDocument', {});
  assert.equal(b1.sent[0].sessionId, 'C1');
  assert.equal(b1.sent[1].sessionId, page);

  // Detaching C1 forgets it and the frame nested beneath it.
  b1.emit('Target.detachedFromTarget', { sessionId: 'C1' }, page);
  events.length = 0;
  b1.emit('Runtime.consoleAPICalled', { type: 'log', args: [] }, 'C1');
  b1.emit('Runtime.consoleAPICalled', { type: 'log', args: [] }, 'C2');
  assert.equal(events.length, 0, 'events from forgotten child sessions are dropped');

  // Unknown sessions (workers attached at browser level) are not tab events.
  b1.emit('Runtime.consoleAPICalled', { type: 'log', args: [] }, 'nobody');
  assert.equal(events.length, 0);
});

await test('sendCommand forwards the timeout budget with headroom for cdp.js', async () => {
  b1.sent.length = 0;
  await platform.debugger.sendCommand(tabA.id, 'Page.captureScreenshot', {}, null, { timeoutMs: 45_000 });
  assert.equal(b1.sent[0].opts.timeoutMs, 47_000);
});

let tabB;
await test('tabs.create/update/remove, onUpdated from Target events, onRemoved once', async () => {
  created.length = 0;
  b1.windowBounds = { left: -32000, top: -32000, width: 1280, height: 752 };
  tabB = await platform.tabs.create({ url: 'https://app.example.com/two', active: true });
  b1.windowBounds = null;
  const createCall = b1.sent.find((s) => s.method === 'Target.createTarget' && s.params.url === 'https://app.example.com/two');
  assert.equal(createCall.params.background, false, 'active:true creates a foreground target');
  // P8 matrix, round 2: a second page joining the first one's window put the first one behind it
  // (~1 frame per 1.5 s, ~1 s per mouse event, an 85 s click). Every page has a window of its own,
  // placed where the engine's existing window is.
  assert.equal(createCall.params.newWindow, true, 'a window of its own');
  assert.deepEqual([createCall.params.left, createCall.params.top, createCall.params.width, createCall.params.height], [-32000, -32000, 1280, 752], 'the existing window\'s bounds');
  assert.ok(!('windowState' in createCall.params), 'never a copied minimized state');
  assert.equal(createCall.params.focus, false, 'a new window never takes the OS keyboard focus');
  assert.ok(!('browserContextId' in createCall.params), 'default context is omitted');
  assert.equal((await platform.tabs.get(tabB.id)).ownWindow, true);
  assert.ok(created.some((t) => t.id === tabB.id));
  assert.ok(cdp.tabInfo(tabB.id).sessionId, 'waited for the page session');

  const [focused] = await platform.tabs.query({ active: true, lastFocusedWindow: true });
  assert.equal(focused.id, tabB.id, 'the newest tab is the focused one');
  // `active` is "in front of its REAL window" (P8 matrix, round 3): tabB has a window of its own,
  // so tabA is still the one in front of ITS window.
  assert.equal((await platform.tabs.get(tabA.id)).active, true, 'each page G9 opens is in front of its own window');
  assert.equal((await platform.tabs.get(tabB.id)).active, true);

  updated.length = 0;
  b1.sent.length = 0;
  await platform.tabs.update(tabB.id, { url: 'https://app.example.com/three' });
  const nav = b1.sent.find((s) => s.method === 'Page.navigate');
  assert.equal(nav.sessionId, cdp.tabInfo(tabB.id).sessionId, 'navigates on the page session');
  assert.ok(updated.some((u) => u.tabId === tabB.id && u.change.url === 'https://app.example.com/three'));
  const t = b1.targets.get(cdp.tabInfo(tabB.id).targetId);
  t.title = 'Three';
  b1.emit('Target.targetInfoChanged', { targetInfo: b1.info(t) });
  assert.equal((await platform.tabs.get(tabB.id)).title, 'Three');

  await platform.tabs.update(tabA.id, { active: true });
  assert.equal((await platform.tabs.query({ active: true, lastFocusedWindow: true }))[0].id, tabA.id, 'activation moves focus');

  removed.length = 0;
  detaches.length = 0;
  await platform.tabs.remove(tabB.id);
  assert.deepEqual(removed, [tabB.id], 'onRemoved exactly once');
  assert.deepEqual(detaches, [{ source: { tabId: tabB.id }, reason: 'target_closed' }]);
  await assert.rejects(platform.tabs.get(tabB.id), /No tab with id/);
});

await test('title/url are re-read on get/query when the browser has not pushed an event yet', async () => {
  // Measured on headless Edge 153: a <title> change arrived as targetInfoChanged
  // only after someone called Target.getTargets. Reads must not serve the stale value.
  const target = b1.targets.get(cdp.tabInfo(tabA.id).targetId);
  target.title = 'Silently retitled';
  updated.length = 0;
  assert.equal((await platform.tabs.get(tabA.id)).title, 'Silently retitled', 'get refreshes via Target.getTargetInfo');
  assert.deepEqual(updated.at(-1), { tabId: tabA.id, change: { title: 'Silently retitled' } }, 'and tells onUpdated');
  target.title = 'Again';
  const listed = await platform.tabs.query({});
  assert.equal(listed.find((t) => t.id === tabA.id).title, 'Again', 'query refreshes via Target.getTargets');
  target.title = 'App';
  await platform.tabs.get(tabA.id);
});

await test('a page opened BY the page (window.open) becomes a tab with openerTabId', async () => {
  const opener = cdp.tabInfo(tabA.id).targetId;
  const popup = b1.addTarget({ type: 'page', url: 'https://app.example.com/popup', openerId: opener });
  b1.emit('Target.targetCreated', { targetInfo: b1.info(popup) });
  b1.attach(popup);
  const tabs = await platform.tabs.query({ url: '*popup*' });
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].openerTabId, tabA.id);
  removed.length = 0;
  await b1.send('Target.closeTarget', { targetId: popup.targetId });
  assert.equal(removed.length, 1, 'closed by the page itself: onRemoved from targetDestroyed');
});

await test('a prerendered page is not a tab until it is activated, then it adopts its session', async () => {
  // Speculation rules (search result pages use them) create hidden 'page'
  // targets. Reported as tabs they were also the NEWEST, so "the active tab"
  // became a page nobody had opened.
  const before = (await platform.tabs.query({})).map((t) => t.id);
  const pre = b1.addTarget({ type: 'page', url: 'https://app.example.com/next', subtype: 'prerender' });
  b1.emit('Target.targetCreated', { targetInfo: b1.info(pre) });
  const sid = b1.attach(pre);
  assert.deepEqual((await platform.tabs.query({})).map((t) => t.id), before, 'a prerender is not a tab');
  assert.equal((await platform.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url === 'https://app.example.com/next', false,
    'and never "the active tab"');
  events.length = 0;
  b1.emit('Page.loadEventFired', {}, sid);
  assert.equal(events.length, 0, 'its events are not tab events');

  // Activation: the browser drops the subtype.
  delete pre.subtype;
  created.length = 0;
  b1.emit('Target.targetInfoChanged', { targetInfo: b1.info(pre) });
  const tab = created.find((t) => t.url === 'https://app.example.com/next');
  assert.ok(tab, 'activation makes it a tab');
  assert.equal(cdp.tabInfo(tab.id).sessionId, sid, 'the session it already had becomes its page session');
  b1.emit('Page.loadEventFired', {}, sid);
  assert.deepEqual(events.at(-1).source, { tabId: tab.id });
  removed.length = 0;
  await platform.tabs.remove(tab.id);
  assert.deepEqual(removed, [tab.id]);
});

await test('debugger.attach re-attaches a detached page; sendCommand says "not attached" meanwhile', async () => {
  const info = cdp.tabInfo(tabA.id);
  detaches.length = 0;
  b1.emit('Target.detachedFromTarget', { sessionId: info.sessionId, targetId: info.targetId });
  assert.deepEqual(detaches, [{ source: { tabId: tabA.id }, reason: 'target_closed' }]);
  await assert.rejects(platform.debugger.sendCommand(tabA.id, 'DOM.enable'), /not attached/);
  assert.deepEqual(await platform.debugger.getTargets(), [{ tabId: tabA.id, attached: false }]);
  const sentBefore = b1.sent.length;
  await platform.debugger.attach(tabA.id);
  assert.ok(cdp.tabInfo(tabA.id).sessionId, 'attached again');
  // The explicit attach (its attachedToTarget) is also resumed — harmless on a running page.
  assert.deepEqual(b1.sent.slice(sentBefore).map((s) => s.method).filter((m) => m !== 'Browser.getWindowForTarget').sort(), ['Runtime.runIfWaitingForDebugger', 'Target.attachToTarget'], 'an explicit attach');
  await platform.debugger.attach(tabA.id); // idempotent
  assert.equal(b1.sent.filter((s) => s.method === 'Target.attachToTarget').length, 1);
  await platform.debugger.detach(tabA.id); // a no-op on launched engines
  assert.ok(cdp.tabInfo(tabA.id).sessionId);
});

await test('cookies: CDP → chrome shape (sameSite, hostOnly, session/expirationDate)', async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  b1.cookies.set('DEFAULT', [
    { name: 'host', value: '1', domain: 'app.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: future, session: false },
    { name: 'wide', value: '2', domain: '.example.com', path: '/', secure: false, httpOnly: false, sameSite: 'None', expires: -1, session: true },
    { name: 'deep', value: '3', domain: '.example.com', path: '/app', secure: false, httpOnly: false, expires: -1, session: true },
    { name: 'other', value: '4', domain: 'other.test', path: '/', secure: false, httpOnly: false, sameSite: 'Strict', expires: -1, session: true },
  ]);
  const all = await platform.cookies.getAll({ tabId: tabA.id });
  assert.equal(all.length, 4);
  const host = all.find((c) => c.name === 'host');
  assert.deepEqual(host, {
    name: 'host', value: '1', domain: 'app.example.com', hostOnly: true, path: '/', secure: true, httpOnly: true,
    sameSite: 'lax', session: false, expirationDate: future,
  });
  const wide = all.find((c) => c.name === 'wide');
  assert.equal(wide.hostOnly, false);
  assert.equal(wide.sameSite, 'no_restriction');
  assert.equal(wide.session, true);
  assert.ok(!('expirationDate' in wide));
  assert.equal(all.find((c) => c.name === 'deep').sameSite, 'unspecified');
  assert.equal(all.find((c) => c.name === 'other').sameSite, 'strict');
});

await test('cookies: url filter is RFC 6265 domain-match + path-match + Secure', async () => {
  const names = async (filter) => (await platform.cookies.getAll({ ...filter, tabId: tabA.id })).map((c) => c.name).sort();
  assert.deepEqual(await names({ url: 'https://app.example.com/app/x' }), ['deep', 'host', 'wide']);
  assert.deepEqual(await names({ url: 'https://app.example.com/apple' }), ['host', 'wide'], '/app does not path-match /apple');
  assert.deepEqual(await names({ url: 'https://app.example.com/app' }), ['deep', 'host', 'wide']);
  assert.deepEqual(await names({ url: 'http://app.example.com/' }), ['wide'], 'Secure cookies stay off plain http');
  assert.deepEqual(await names({ url: 'https://sub.app.example.com/' }), ['wide'], 'host-only cookies do not reach subdomains');
  assert.deepEqual(await names({ url: 'https://example.com/' }), ['wide']);
  assert.deepEqual(await names({ url: 'https://notexample.com/' }), [], 'suffix is not a domain match');
  assert.deepEqual(await names({ domain: 'example.com' }), ['deep', 'host', 'wide'], 'domain filter includes subdomains');
  assert.deepEqual(await names({ name: 'other' }), ['other']);
  assert.equal(cdp.pathMatches('/', '/'), true);
  assert.equal(cdp.pathMatches('/a/b', '/a/'), true);
  assert.equal(cdp.domainMatches('localhost', { domain: 'localhost', hostOnly: true }), true);
  assert.ok(cdp.cookieMatches({ name: 's', domain: 'localhost', hostOnly: true, path: '/', secure: true }, { url: 'http://localhost:8080/' }),
    'loopback is potentially trustworthy: Secure cookies are sent');
});

await test('cookies.set/remove go through Storage.setCookies with chrome semantics', async () => {
  b1.sent.length = 0;
  const set = await platform.cookies.set({ tabId: tabA.id, url: 'https://app.example.com/login', name: 'sid', value: 'xyz', sameSite: 'lax', httpOnly: true, secure: true });
  const call = b1.sent.find((s) => s.method === 'Storage.setCookies');
  assert.equal(call.sessionId, null, 'browser session');
  assert.deepEqual(call.params.cookies[0], { name: 'sid', value: 'xyz', url: 'https://app.example.com/login', path: '/login', secure: true, httpOnly: true, sameSite: 'Lax' });
  assert.ok(!('browserContextId' in call.params), 'default context omitted');
  assert.equal(set.name, 'sid');
  assert.equal(set.hostOnly, true);
  assert.equal(set.path, '/login');

  b1.sent.length = 0;
  await platform.cookies.remove({ tabId: tabA.id, url: 'https://app.example.com/login', name: 'sid' });
  const del = b1.sent.find((s) => s.method === 'Storage.setCookies');
  assert.equal(del.params.cookies[0].expires, 1, 'expired in the past');
  assert.equal(del.params.cookies[0].url, 'https://app.example.com/login', 'host-only cookie addressed by url');
  assert.equal((await platform.cookies.getAll({ tabId: tabA.id, name: 'sid' })).length, 0);

  await platform.cookies.remove({ tabId: tabA.id, url: 'https://app.example.com/', name: 'wide' });
  const delWide = b1.sent.filter((s) => s.method === 'Storage.setCookies').at(-1);
  assert.equal(delWide.params.cookies[0].domain, '.example.com', 'domain cookie addressed by domain');
});

let ctx;
let tabC;
await test('contexts: registered context is passed explicitly; settings come from it', async () => {
  ({ browserContextId: ctx } = await b1.send('Target.createBrowserContext', {}));
  cdp.registerContext('e1', ctx, { humanize: 'stealth', stealth: 'stealth', downloadPath: 'C:\\G9\\downloads\\c1' });
  tabC = await cdp.createTab('e1', ctx, 'https://shop.example.net/');
  const createCall = b1.sent.filter((s) => s.method === 'Target.createTarget').at(-1);
  assert.equal(createCall.params.browserContextId, ctx);
  assert.equal(createCall.params.background, false, 'explicit placement is a foreground tab');
  assert.equal(platform.settings.humanizeFor(tabC.id), 'stealth');
  assert.equal(platform.settings.stealthFor(tabC.id), 'stealth');
  assert.equal(platform.settings.humanizeFor(tabA.id), 'human', 'default from configure()');
  assert.equal(platform.settings.stealthFor(tabA.id), 'off');
  assert.notEqual(tabC.windowId, tabA.windowId, 'one synthetic window per context');

  b1.sent.length = 0;
  await platform.cookies.getAll({ tabId: tabC.id });
  assert.equal(b1.sent[0].params.browserContextId, ctx, 'cookies read from the tab\'s own context');

  cdp.setDefaultContext('e1', ctx);
  const plain = await platform.tabs.create({ url: 'https://shop.example.net/2' });
  assert.equal(b1.sent.filter((s) => s.method === 'Target.createTarget').at(-1).params.browserContextId, ctx);
  assert.equal(b1.sent.filter((s) => s.method === 'Target.createTarget').at(-1).params.background, true, 'active:false → background');
  await platform.tabs.remove(plain.id);
  cdp.setDefaultContext('e1', null);
});

await test('F1 + P8: every page G9 opens gets a real window of its own — the first of a fresh context and every later one', async () => {
  // F1: Chrome/Edge refuse newWindow:false for the first page of a fresh context ("no browser is
  // open"). P8 matrix, round 2: a later page that JOINED the first one's window left the first one
  // behind it, throttled to ~1 frame per 1.5 s. So no page ever joins another's window.
  const { browserContextId: fresh } = await b1.send('Target.createBrowserContext', {});
  cdp.registerContext('e1', fresh, {});
  b1.sent.length = 0;
  const first = await cdp.createTab('e1', fresh, 'https://first.example/');
  const creates = () => b1.sent.filter((x) => x.method === 'Target.createTarget');
  assert.equal(creates().length, 1, 'no refused attempt first');
  assert.equal(creates()[0].params.newWindow, true, 'the context had no page, so no window to join');
  assert.equal(creates()[0].params.browserContextId, fresh);
  const second = await cdp.createTab('e1', fresh, 'https://second.example/');
  assert.equal(creates().at(-1).params.newWindow, true, 'the second page does NOT join the first one\'s window');
  assert.equal(creates().at(-1).params.background, false);
  assert.equal(second.windowId, first.windowId, 'still one synthetic window per context');
  assert.equal(second.ownWindow, true);
  assert.equal(first.ownWindow, true);
  // Its bounds come from the context's existing page.
  const bounds = b1.sent.filter((x) => x.method === 'Browser.getWindowForTarget');
  assert.ok(bounds.length >= 1, 'asked where the existing window is');
  // A browser that refuses the bounds still gets its window, without them.
  const original = b1.send.bind(b1);
  const attempts = [];
  b1.send = async (method, params, ...rest) => {
    if (method === 'Target.createTarget') attempts.push('left' in params);
    if (method === 'Target.createTarget' && 'left' in params) throw new Error('Target.createTarget: bounds not supported');
    return original(method, params, ...rest);
  };
  try {
    const third = await cdp.createTab('e1', fresh, 'https://third.example/');
    assert.deepEqual(attempts, [true, false], 'retried without the bounds');
    assert.ok(cdp.tabInfo(third.id).sessionId);
  } finally {
    b1.send = original;
  }
  // Any other failure (no bounds to blame) is not retried.
  for (const id of cdp.tabsOf('e1').filter((h) => cdp.tabInfo(h)?.browserContextId === fresh)) await platform.tabs.remove(id);
  b1.send = async (method, params, ...rest) => {
    if (method === 'Target.createTarget') throw new Error('Target.createTarget: some other refusal');
    return original(method, params, ...rest);
  };
  try {
    attempts.length = 0;
    b1.send = async (method, params, ...rest) => {
      if (method === 'Target.createTarget') { attempts.push(1); throw new Error('Target.createTarget: some other refusal'); }
      return original(method, params, ...rest);
    };
    await assert.rejects(cdp.createTab('e1', fresh, 'https://fifth.example/'), /some other refusal/);
    assert.equal(attempts.length, 1, 'a refusal that is not about the bounds is not retried');
  } finally {
    b1.send = original;
  }
});

await test('windows are synthetic: one per context, focused, create refuses clearly', async () => {
  const wins = await platform.windows.getAll({ populate: true });
  assert.ok(wins.length >= 2);
  for (const w of wins) {
    assert.equal(w.type, 'normal');
    assert.equal(w.state, 'normal');
    assert.equal(w.focused, true);
  }
  const w = await platform.windows.get(tabA.windowId, { populate: true });
  assert.ok(w.tabs.some((t) => t.id === tabA.id));
  await assert.rejects(platform.windows.create({ tabId: tabA.id }), /Engine 1 \(extension\) action; launched engines have no windows/);
  assert.equal((await platform.windows.update(tabA.windowId, { focused: true })).id, tabA.windowId);
});

await test('downloads: begin on the BROWSER session; frameId == page target → exact; path = folder/guid', async () => {
  const began = await platform.downloads.begin(tabC.id);
  assert.deepEqual(began, { mode: 'cdp', downloadPath: 'C:\\G9\\downloads\\c1' });
  const call = b1.downloadBehavior.at(-1);
  assert.equal(call.sessionId, null, 'Browser domain is only reachable on the browser session');
  assert.deepEqual(call.params, { behavior: 'allowAndName', downloadPath: 'C:\\G9\\downloads\\c1', eventsEnabled: true, browserContextId: ctx });

  downloads.length = 0;
  const frameId = cdp.tabInfo(tabC.id).targetId;
  b1.emit('Browser.downloadWillBegin', { frameId, guid: 'g-1', url: 'https://shop.example.net/report.xlsx', suggestedFilename: 'report.xlsx' });
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].tabId, tabC.id);
  assert.equal(downloads[0].attribution, 'exact');
  assert.equal(downloads[0].path, 'C:\\G9\\downloads\\c1\\g-1');
  assert.equal(downloads[0].state, 'in_progress');
  assert.equal(downloads[0].filename, 'report.xlsx');

  b1.emit('Browser.downloadProgress', { guid: 'g-1', totalBytes: 42, receivedBytes: 21, state: 'inProgress' });
  b1.emit('Browser.downloadProgress', { guid: 'g-1', totalBytes: 42, receivedBytes: 42, state: 'completed' });
  const done = downloads.at(-1);
  assert.equal(done.state, 'complete');
  assert.equal(done.receivedBytes, 42);
  assert.ok(done.endedAt >= done.startedAt);

  const facts = await platform.downloads.inspect(done);
  assert.equal(facts.size, 42);
  assert.equal(facts.source, 'disk');
  assert.equal(facts.path, done.path, 'the daemon hook was asked about the event\'s path');
  assert.equal(await platform.downloads.inspect({ ...done, path: null }), null, 'no path → no claim');
});

await test('downloads: subframe → exact via its frame; unknown frame → probable (one watcher) / unknown (two)', async () => {
  const page = cdp.tabInfo(tabC.id).sessionId;
  b1.emit('Page.frameAttached', { frameId: 'SUB-1', parentFrameId: cdp.tabInfo(tabC.id).targetId }, page);
  downloads.length = 0;
  b1.emit('Browser.downloadWillBegin', { frameId: 'SUB-1', guid: 'g-2', url: 'https://x/a.csv', suggestedFilename: 'a.csv' });
  assert.equal(downloads[0].tabId, tabC.id);
  assert.equal(downloads[0].attribution, 'exact');

  b1.emit('Browser.downloadWillBegin', { frameId: 'NOPE', guid: 'g-3', url: 'https://x/b.csv', suggestedFilename: 'b.csv' });
  assert.equal(downloads[1].tabId, tabC.id, 'the only watched tab');
  assert.equal(downloads[1].attribution, 'probable');

  cdp.registerContext('e1', 'DEFAULT', {}); // harmless: the default context is recognised and omitted
  await platform.downloads.begin(tabA.id, { downloadPath: '/tmp/g9-dl' });
  assert.ok(!('browserContextId' in b1.downloadBehavior.at(-1).params), 'default context omitted');
  b1.emit('Browser.downloadWillBegin', { frameId: 'NOPE', guid: 'g-4', url: 'https://x/c.csv', suggestedFilename: 'c.csv' });
  assert.equal(downloads[2].tabId, null);
  assert.equal(downloads[2].attribution, 'unknown');

  await platform.downloads.end(tabA.id);
  b1.emit('Browser.downloadProgress', { guid: 'g-3', totalBytes: 0, receivedBytes: 0, state: 'canceled' });
  assert.equal(downloads.at(-1).state, 'canceled');
});

await test('downloads: a popup opened by the watched tab downloads → the opener, exact, via the popup', async () => {
  // <a target=_blank> to a file: a new tab starts the download and goes away.
  const opener = cdp.tabInfo(tabC.id).targetId;
  const popup = b1.addTarget({ type: 'page', url: 'about:blank', openerId: opener, browserContextId: ctx });
  b1.emit('Target.targetCreated', { targetInfo: b1.info(popup) });
  b1.attach(popup);
  const popupTab = (await platform.tabs.query({})).find((t) => t.openerTabId === tabC.id);
  assert.ok(popupTab);
  downloads.length = 0;
  b1.emit('Browser.downloadWillBegin', { frameId: popup.targetId, guid: 'g-5', url: 'https://shop.example.net/x.pdf', suggestedFilename: 'x.pdf' });
  assert.equal(downloads[0].tabId, tabC.id, 'attributed to the watched opener');
  assert.equal(downloads[0].attribution, 'exact', 'the opener link is the browser\'s own fact');
  assert.equal(downloads[0].viaTabId, popupTab.id, 'and it says which tab it came from');
  assert.equal(downloads[0].path, 'C:\\G9\\downloads\\c1\\g-5', 'saved in the popup\'s context folder');
  await b1.send('Target.closeTarget', { targetId: popup.targetId });

  // A tab nobody watches whose opener is not watched either keeps its own exact id.
  downloads.length = 0;
  b1.emit('Browser.downloadWillBegin', { frameId: cdp.tabInfo(tabA.id).targetId, guid: 'g-6', url: 'https://x/d.csv', suggestedFilename: 'd.csv' });
  assert.equal(downloads[0].tabId, tabA.id);
  assert.equal(downloads[0].attribution, 'exact');
  assert.ok(!('viaTabId' in downloads[0]));
});

await test('downloads.inspect: a failing file check rejects instead of passing for "no way to check"', async () => {
  cdp.configure({ fileInfo: async () => { throw new Error('EBUSY: resource busy'); } });
  await assert.rejects(platform.downloads.inspect({ path: 'C:\\G9\\downloads\\c1\\g-1' }), /EBUSY/);
  cdp.configure({ fileInfo: async (path) => ({ exists: true, size: 42, sha256: 'ab'.repeat(32), magicHex: '504b0304', mime: 'application/zip', path }) });
  assert.equal((await platform.downloads.inspect({ path: 'C:\\G9\\downloads\\c1\\g-1' })).source, 'disk');
});

let b2;
let tabD;
await test('two engines at once: distinct handles, events and commands stay on their own connection', async () => {
  b2 = new FakeBrowser('b2', { pages: [{ url: 'https://second.example/', title: 'Second' }] });
  await cdp.registerEngine('e2', b2);
  const [d] = cdp.tabsOf('e2');
  tabD = await platform.tabs.get(d);
  assert.equal(tabD.url, 'https://second.example/');
  assert.equal(tabD.engineId, 'e2');
  const all = await platform.tabs.query({});
  assert.ok(all.some((t) => t.id === tabA.id) && all.some((t) => t.id === tabD.id), 'one registry spans both browsers');
  assert.equal(new Set(all.map((t) => t.id)).size, all.length, 'handles are unique across engines');

  events.length = 0;
  b2.emit('Page.loadEventFired', {}, cdp.tabInfo(tabD.id).sessionId);
  assert.deepEqual(events[0].source, { tabId: tabD.id });

  b1.sent.length = 0;
  b2.sent.length = 0;
  await platform.debugger.sendCommand(tabD.id, 'DOM.enable');
  await platform.debugger.sendCommand(tabA.id, 'DOM.enable');
  assert.equal(b2.sent.filter((s) => s.method === 'DOM.enable').length, 1);
  assert.equal(b1.sent.filter((s) => s.method === 'DOM.enable').length, 1);

  // Session ids are per browser; the same id on the other browser means nothing.
  events.length = 0;
  b1.emit('Page.loadEventFired', {}, cdp.tabInfo(tabD.id).sessionId);
  assert.equal(events.length, 0);
});

await test('unregisterEngine: its tabs detach and disappear, the other engine is untouched', async () => {
  detaches.length = 0;
  removed.length = 0;
  cdp.unregisterEngine('e2');
  assert.deepEqual(detaches, [{ source: { tabId: tabD.id }, reason: 'target_closed' }]);
  assert.deepEqual(removed, [tabD.id]);
  assert.deepEqual(cdp.tabsOf('e2'), []);
  assert.equal(cdp.tabInfo(tabD.id), null);
  await assert.rejects(platform.tabs.get(tabD.id), /No tab/);
  assert.equal(b2.handlers.event.size, 0, 'listeners removed from the dead connection');
  events.length = 0;
  b2.emit('Page.loadEventFired', {}, 'anything');
  assert.equal(events.length, 0);
  assert.ok(await platform.tabs.get(tabA.id), 'e1 still works');
  cdp.unregisterEngine('e2'); // idempotent
});

await test('a closed connection unregisters its engine by itself', async () => {
  const b3 = new FakeBrowser('b3', { pages: [{ url: 'https://third.example/' }] });
  await cdp.registerEngine('e3', b3);
  const [t] = cdp.tabsOf('e3');
  removed.length = 0;
  b3.close();
  assert.deepEqual(removed, [t]);
  await assert.rejects(cdp.registerEngine('e1', b3), /already registered/);
});

// ------------------------------------------------ held targets (live round 3)

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Index of the first command matching `pred` in `list`, or -1. */
const indexOf = (list, pred) => list.findIndex(pred);

await test('held targets: a page the PAGE opens (window.open) is prepared BEFORE it runs, then resumed', async () => {
  // Live round 3 (Engine 2 and stealth suites, Edge and Chrome 153): under browser-level flat
  // auto-attach a window.open() popup is held until Runtime.runIfWaitingForDebugger is sent on its
  // session — nobody sent it, window.open() never returned and the opener's click timed out after
  // 20 s. And its context defaults arrived after its first document had run.
  const prepared = [];
  cdp.configure({
    prepareTab: async (tabId, { targetInfo }) => {
      prepared.push({ tabId, url: targetInfo?.url });
      await tick(5);
      await platform.debugger.sendCommand(tabId, 'Emulation.setTimezoneOverride', { timezoneId: 'Europe/Berlin' });
    },
  });
  try {
    b1.sent.length = 0;
    const opener = cdp.tabInfo(tabA.id).targetId;
    const popup = b1.addTarget({ type: 'page', url: '', openerId: opener });
    b1.emit('Target.targetCreated', { targetInfo: b1.info(popup) });
    const sid = b1.attach(popup, null, true);
    const [tab] = (await platform.tabs.query({})).filter((t) => cdp.tabInfo(t.id)?.targetId === popup.targetId);
    assert.ok(tab, 'the popup is a tab');
    assert.equal(tab.openerTabId, tabA.id);
    await tick(30);
    assert.deepEqual(prepared.map((p) => p.tabId), [tab.id], 'prepareTab ran once, for the popup');
    const onPopup = b1.sent.filter((s) => s.sessionId === sid);
    const tz = indexOf(onPopup, (s) => s.method === 'Emulation.setTimezoneOverride');
    const run = indexOf(onPopup, (s) => s.method === 'Runtime.runIfWaitingForDebugger');
    assert.ok(tz >= 0, 'the preparation reached the popup\'s own session');
    assert.ok(run > tz, 'resumed only AFTER its preparation');
    assert.equal(onPopup.filter((s) => s.method === 'Runtime.runIfWaitingForDebugger').length, 1, 'resumed exactly once');
    assert.ok(!b1.sent.some((s) => s.method === 'Runtime.enable'), 'resuming is not Runtime.enable (stealth rule R4)');
    await b1.send('Target.closeTarget', { targetId: popup.targetId });
  } finally {
    cdp.configure({ prepareTab: null });
  }
});

await test('held targets: a preparation that fails or never ends still lets the target run (never a wedged page)', async () => {
  const opener = cdp.tabInfo(tabA.id).targetId;
  // Fails at once → resumed at once.
  cdp.configure({ prepareTab: async () => { throw new Error('boom'); } });
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    b1.sent.length = 0;
    const p1 = b1.addTarget({ type: 'page', url: '', openerId: opener });
    const s1 = b1.attach(p1, null, true);
    await tick(20);
    assert.ok(b1.sent.some((s) => s.method === 'Runtime.runIfWaitingForDebugger' && s.sessionId === s1), 'a failed preparation still resumes');
    assert.ok(errors.some((e) => /preparing tab/.test(e)), 'and the failure is reported, not swallowed');
    await b1.send('Target.closeTarget', { targetId: p1.targetId });

    // Never settles → resumed when the budget runs out.
    cdp.configure({ prepareTab: () => new Promise(() => {}) });
    b1.sent.length = 0;
    const p2 = b1.addTarget({ type: 'page', url: '', openerId: opener });
    const t0 = Date.now();
    const s2 = b1.attach(p2, null, true);
    await tick(200);
    assert.ok(!b1.sent.some((s) => s.method === 'Runtime.runIfWaitingForDebugger' && s.sessionId === s2), 'held while its preparation runs');
    while (!b1.sent.some((s) => s.method === 'Runtime.runIfWaitingForDebugger' && s.sessionId === s2) && Date.now() - t0 < cdp.PREPARE_BUDGET_MS + 2_000) await tick(50);
    const waited = Date.now() - t0;
    assert.ok(b1.sent.some((s) => s.method === 'Runtime.runIfWaitingForDebugger' && s.sessionId === s2), 'resumed after the budget');
    assert.ok(waited >= cdp.PREPARE_BUDGET_MS - 50 && waited < cdp.PREPARE_BUDGET_MS + 1_500, `after about PREPARE_BUDGET_MS (${waited} ms)`);
    await b1.send('Target.closeTarget', { targetId: p2.targetId });
  } finally {
    console.error = origError;
    cdp.configure({ prepareTab: null });
  }
});

await test('held targets: workers and other non-tab targets are resumed at once; so is a child nobody owns', async () => {
  b1.sent.length = 0;
  const sw = b1.addTarget({ type: 'service_worker', url: 'https://app.example.com/sw.js' });
  const s1 = b1.attach(sw, null, true);
  assert.ok(b1.sent.some((s) => s.method === 'Runtime.runIfWaitingForDebugger' && s.sessionId === s1), 'a service worker is resumed synchronously');
  // A child that attaches under the service worker's session (not a tab): resumed too.
  b1.emit('Target.attachedToTarget', { sessionId: 'SWCHILD', targetInfo: { targetId: 'W9', type: 'worker', url: '' }, waitingForDebugger: true }, s1);
  assert.ok(b1.sent.some((s) => s.method === 'Runtime.runIfWaitingForDebugger' && s.sessionId === 'SWCHILD'));
  await b1.send('Target.closeTarget', { targetId: sw.targetId });
});

await test('held targets: the tool layer\'s frame auto-attach is HELD, and each child is prepared before it runs', async () => {
  // Stealth suite, round 3: a cross-site iframe kept the HOST's time zone (7/7 de-DE runs) —
  // Emulation's overrides are per renderer process and went to the page session only.
  const page = cdp.tabInfo(tabA.id).sessionId;
  const children = [];
  cdp.configure({
    prepareChild: async (tabId, child) => {
      children.push({ tabId, ...child });
      if (child.targetInfo?.type !== 'iframe') return;
      await platform.debugger.sendCommand(tabId, 'Emulation.setTimezoneOverride', { timezoneId: 'Europe/Berlin' }, child.sessionId);
    },
  });
  try {
    b1.sent.length = 0;
    // lib/cdp.js and lib/frames.js ask for waitForDebuggerOnStart:false — both engines share them.
    await platform.debugger.sendCommand(tabA.id, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    assert.equal(b1.sent.at(-1).params.waitForDebuggerOnStart, true, 'held on a launched engine: platform-cdp resumes every child');
    await platform.debugger.sendCommand(tabA.id, 'Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    assert.equal(b1.sent.at(-1).params.waitForDebuggerOnStart, false, 'turning auto-attach OFF is passed through unchanged');

    b1.sent.length = 0;
    b1.emit('Target.attachedToTarget', { sessionId: 'XF1', targetInfo: { targetId: 'XF1T', type: 'iframe', url: 'https://widget.example/' }, waitingForDebugger: true }, page);
    b1.emit('Target.attachedToTarget', { sessionId: 'XF2', targetInfo: { targetId: 'XF2T', type: 'iframe', url: 'https://inner.example/' }, waitingForDebugger: true }, 'XF1');
    b1.emit('Target.attachedToTarget', { sessionId: 'XW1', targetInfo: { targetId: 'XW1T', type: 'worker', url: '' }, waitingForDebugger: true }, page);
    await tick(20);
    assert.deepEqual(children.map((c) => [c.tabId, c.sessionId, c.parentSessionId]), [[tabA.id, 'XF1', page], [tabA.id, 'XF2', 'XF1'], [tabA.id, 'XW1', page]]);
    for (const sid of ['XF1', 'XF2']) {
      const on = b1.sent.filter((s) => s.sessionId === sid);
      const tz = indexOf(on, (s) => s.method === 'Emulation.setTimezoneOverride');
      const run = indexOf(on, (s) => s.method === 'Runtime.runIfWaitingForDebugger');
      assert.ok(tz >= 0 && run > tz, `${sid}: the override reached the frame's own session before it was resumed`);
    }
    assert.ok(b1.sent.some((s) => s.method === 'Runtime.runIfWaitingForDebugger' && s.sessionId === 'XW1'), 'the worker was resumed');
    b1.emit('Target.detachedFromTarget', { sessionId: 'XF1' }, page);
    b1.emit('Target.detachedFromTarget', { sessionId: 'XW1' }, page);
  } finally {
    cdp.configure({ prepareChild: null });
  }
});

await test('held targets: createTab returns only once the new page was prepared and resumed', async () => {
  let done = false;
  cdp.configure({ prepareTab: async () => { await tick(60); done = true; } });
  try {
    b1.sent.length = 0;
    const t = await cdp.createTab('e1', null, 'about:blank');
    assert.equal(done, true, 'the caller never sees an unprepared tab');
    const sid = cdp.tabInfo(t.id).sessionId;
    assert.ok(b1.sent.some((s) => s.method === 'Runtime.runIfWaitingForDebugger' && s.sessionId === sid), 'and it has been resumed');
    await platform.tabs.remove(t.id);
  } finally {
    cdp.configure({ prepareTab: null });
  }
});

await test('a tab behind a page-opened tab is reported behind; ensureFront brings it forward on a HEADLESS engine only', async () => {
  // P8 matrix, round 3 (4/4): the opener behind a target=_blank tab took 20.9 s per humanized click
  // and 24–46 s per screenshot; browser_status said nothing and every G9-opened tab listed active:false.
  const b4 = new FakeBrowser('b4', { pages: [{ url: 'https://app.example.org/' }] });
  await cdp.registerEngine('e4', b4, { headless: true });
  try {
    const [opener] = cdp.tabsOf('e4');
    await tick(10);
    assert.equal((await platform.tabs.get(opener)).active, true, 'alone in its window: in front');
    const pop = b4.addTarget({ type: 'page', url: 'https://app.example.org/docs', openerId: cdp.tabInfo(opener).targetId });
    b4.emit('Target.targetCreated', { targetInfo: b4.info(pop) });
    b4.attach(pop, null, true);
    await tick(20);
    const popTab = (await platform.tabs.query({})).find((t) => t.openerTabId === opener);
    assert.equal(popTab.active, true, 'the page-opened tab is in front of the shared window');
    assert.equal((await platform.tabs.get(opener)).active, false, 'the opener is BEHIND it — and says so');
    b4.sent.length = 0;
    assert.deepEqual(await platform.tabs.ensureFront(opener), { front: true, activated: true }, 'headless: brought to the front');
    assert.ok(b4.sent.some((s) => s.method === 'Target.activateTarget' && s.params.targetId === cdp.tabInfo(opener).targetId));
    assert.equal((await platform.tabs.get(opener)).active, true);
    assert.equal((await platform.tabs.get(popTab.id)).active, false);
    b4.sent.length = 0;
    assert.deepEqual(await platform.tabs.ensureFront(opener), { front: true }, 'already in front: nothing sent');
    assert.ok(!b4.sent.some((s) => s.method === 'Target.activateTarget'));
  } finally {
    cdp.unregisterEngine('e4');
  }
  // A HEADED engine's tabs are where the person sees them: reported, never moved.
  const b5 = new FakeBrowser('b5', { pages: [{ url: 'https://app.example.org/' }] });
  await cdp.registerEngine('e5', b5, { headless: false });
  try {
    const [opener] = cdp.tabsOf('e5');
    const pop = b5.addTarget({ type: 'page', url: 'https://app.example.org/docs', openerId: cdp.tabInfo(opener).targetId });
    b5.emit('Target.targetCreated', { targetInfo: b5.info(pop) });
    b5.attach(pop, null, true);
    await tick(20);
    b5.sent.length = 0;
    assert.deepEqual(await platform.tabs.ensureFront(opener), { front: false, behind: true, headless: false });
    assert.ok(!b5.sent.some((s) => s.method === 'Target.activateTarget'), 'a headed window is never rearranged behind the person\'s back');
  } finally {
    cdp.unregisterEngine('e5');
  }
});

await test('memory storage has chrome.storage semantics and copies values', async () => {
  const area = cdp.createMemoryStorageArea();
  await area.set({ a: { n: 1 }, b: 2 });
  assert.deepEqual(await area.get('a'), { a: { n: 1 } });
  assert.deepEqual(await area.get(['a', 'zz']), { a: { n: 1 } });
  assert.deepEqual(await area.get({ b: 0, c: 'dflt' }), { b: 2, c: 'dflt' });
  assert.deepEqual(await area.get(null), { a: { n: 1 }, b: 2 });
  const got = (await area.get('a')).a;
  got.n = 99;
  assert.equal((await area.get('a')).a.n, 1, 'a mutated read does not change the store');
  await area.remove(['a']);
  assert.deepEqual(await area.getKeys(), ['b']);
  // configure() swaps the area platform.storage hands out.
  cdp.configure({ storageSession: area });
  assert.equal(platform.storage.session, area);
});

await test('memory blob store: put/get/byIndex/deleteByIndex/stats', async () => {
  await platform.blobs.put('blobs', { id: 'x1', owner: 'bug_1', size: 3, blob: new Uint8Array([1, 2, 3]) });
  await platform.blobs.put('blobs', { id: 'x2', owner: 'bug_1', size: 5, blob: new Uint8Array(5) });
  await platform.blobs.put('video-frames', { id: 's:000001', sessionId: 's', seq: 1, size: 1, blob: new Uint8Array(1) });
  assert.equal((await platform.blobs.get('blobs', 'x1')).owner, 'bug_1');
  assert.equal((await platform.blobs.byIndex('blobs', 'owner', 'bug_1')).length, 2);
  assert.deepEqual(await platform.blobs.stats('blobs'), { count: 2, bytes: 8 });
  assert.equal(await platform.blobs.deleteByIndex('blobs', 'owner', 'bug_1'), 2);
  assert.equal(await platform.blobs.get('blobs', 'x1'), null);
  assert.equal((await platform.blobs.byIndex('video-frames', 'sessionId', 's')).length, 1);
});

// ------------------------------------------------------------------ live (F1)

/**
 * F1 against a REAL browser: the fake above refuses the way Chrome does, but
 * the refusal itself is a measured fact (headless Edge 153), so it is checked
 * where it lives. Headless Edge, temp profile, closed at the end; skipped with
 * G9_UNIT_NO_BROWSER=1 or when Edge is not installed (engine.test.mjs's rule).
 */
await test('live: headless Edge — createTab opens every page of a fresh context in a real window of its own', async () => {
  if (process.env.G9_UNIT_NO_BROWSER === '1') skip('G9_UNIT_NO_BROWSER=1');
  const { launchBrowser } = await import('../../engine/launch.js');
  let h;
  try {
    h = await launchBrowser({ browser: 'edge' });
  } catch (err) {
    if (/No edge browser was found|not installed/i.test(String(err?.message))) skip(err.message.split('\n')[0]);
    throw err;
  }
  try {
    // First the browser's own answer to the old request, so the test proves the premise.
    const { browserContextId: probe } = await h.conn.send('Target.createBrowserContext', { disposeOnDetach: true });
    await assert.rejects(
      h.conn.send('Target.createTarget', { url: 'about:blank', newWindow: false, browserContextId: probe }),
      /no browser is open/i,
      'Edge still refuses newWindow:false for the first page of a fresh context',
    );

    await cdp.registerEngine('live', h.conn);
    const { browserContextId: fresh } = await h.conn.send('Target.createBrowserContext', { disposeOnDetach: true });
    cdp.registerContext('live', fresh, {});
    const first = await cdp.createTab('live', fresh, 'data:text/html,<title>one</title>');
    const second = await cdp.createTab('live', fresh, 'data:text/html,<title>two</title>');
    assert.notEqual(first.id, second.id);
    // P8 matrix, round 2: every page in a window of its own — so neither is behind the other.
    const win1 = await h.conn.send('Browser.getWindowForTarget', { targetId: cdp.tabInfo(first.id).targetId });
    const win2 = await h.conn.send('Browser.getWindowForTarget', { targetId: cdp.tabInfo(second.id).targetId });
    assert.notEqual(win1.windowId, win2.windowId, 'two real windows');
    assert.equal(win2.bounds.width, win1.bounds.width, 'the second window took the first one\'s size');
    const visible = async (tabId) => (await platform.debugger.sendCommand(tabId, 'Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true })).result.value;
    assert.equal(await visible(first.id), 'visible');
    assert.equal(await visible(second.id), 'visible');
    assert.equal(cdp.tabInfo(first.id).browserContextId, fresh);
    assert.equal(cdp.tabInfo(second.id).browserContextId, fresh);
    // createTab returns once the page session exists, not once the document loaded.
    let title = '';
    for (let i = 0; i < 50 && title !== 'two'; i++) {
      const r = await platform.debugger.sendCommand(second.id, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      title = r.result.value;
      if (title !== 'two') await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal(title, 'two', 'the second page is a working tab');
    // The default context (it has the start-up about:blank) still opens plain tabs.
    const plain = await cdp.createTab('live', null, 'about:blank');
    assert.ok(cdp.tabInfo(plain.id)?.sessionId);
  } finally {
    cdp.unregisterEngine('live');
    const pid = h.pid;
    const res = await h.close();
    assert.equal(res.profileRemoved, true, 'the temporary profile is gone');
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, false, `browser pid ${pid} is gone`);
  }
});

/**
 * The window.open() wedge against a REAL browser (live round 3, Edge and Chrome 153): under
 * browser-level auto-attach the popup was held, window.open() never returned and the click's
 * Input.dispatchMouseEvent hung. Now the popup is prepared while held (here: a timezone, as the
 * daemon's persona does) and resumed. A local page server on a random 18000-18999 port.
 */
await test('live: headless Edge — a click that calls window.open() returns, the opener runs on, the popup loads prepared', async () => {
  if (process.env.G9_UNIT_NO_BROWSER === '1') skip('G9_UNIT_NO_BROWSER=1');
  const http = await import('node:http');
  const pages = {
    '/opener': '<!doctype html><title>opener</title><button id="b" style="position:fixed;left:10px;top:10px;width:200px;height:60px" ' +
      'onclick="window.__clicked = true; window.__w = window.open(\'/popup\', \'_blank\'); window.__opened = !!window.__w">open</button>' +
      '<a id="nl" target="_blank" href="/newtab" style="position:fixed;left:10px;top:100px;width:200px;height:60px;display:block">new tab</a>',
    '/popup': '<!doctype html><title>popup</title><script>window.tzAtLoad = Intl.DateTimeFormat().resolvedOptions().timeZone;</script>',
    '/newtab': '<!doctype html><title>newtab</title><script>window.tzAtLoad = Intl.DateTimeFormat().resolvedOptions().timeZone; fetch("/api/missing").catch(() => {});</script>',
  };
  const server = http.createServer((req, res) => {
    const body = pages[new URL(req.url, 'http://x').pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'nope');
  });
  let port = 0;
  for (let i = 0; i < 20 && !port; i++) {
    const p = 18000 + Math.floor(Math.random() * 1000);
    port = await new Promise((resolve) => {
      server.once('error', () => resolve(0));
      server.listen(p, '127.0.0.1', () => resolve(p));
    });
  }
  assert.ok(port, 'a free port in 18000-18999');
  const { launchBrowser } = await import('../../engine/launch.js');
  let h;
  try {
    try {
      h = await launchBrowser({ browser: 'edge' });
    } catch (err) {
      if (/No edge browser was found|not installed/i.test(String(err?.message))) skip(err.message.split('\n')[0]);
      throw err;
    }
    const prepared = [];
    const requests = new Map();
    const requestTimes = new Map();
    const offEvents = platform.debugger.onEvent((source, method, params) => {
      if (method !== 'Network.requestWillBeSent' || source.sessionId) return;
      if (!requests.has(source.tabId)) requests.set(source.tabId, []);
      requests.get(source.tabId).push(new URL(params.request.url).pathname);
      requestTimes.set(new URL(params.request.url).pathname, Date.now());
    });
    cdp.configure({
      // As the daemon does (engine/manager.js #prepareTab): commands SENT, answers not awaited — a
      // target=_blank tab answers nothing while held, and applies what was sent before it runs.
      prepareTab: (tabId) => {
        if (cdp.tabInfo(tabId)?.engineId !== 'live2') return;
        prepared.push(tabId);
        platform.debugger.sendCommand(tabId, 'Network.enable', {}).catch(() => {});
        platform.debugger.sendCommand(tabId, 'Emulation.setTimezoneOverride', { timezoneId: 'Europe/Berlin' }).catch(() => {});
      },
    });
    await cdp.registerEngine('live2', h.conn);
    const opener = await cdp.createTab('live2', null, `http://127.0.0.1:${port}/opener`);
    const evalIn = async (tabId, expression) => (await platform.debugger.sendCommand(tabId, 'Runtime.evaluate', { expression, returnByValue: true }, null, { timeoutMs: 8_000 })).result.value;
    for (let i = 0; i < 50 && (await evalIn(opener.id, 'document.readyState')) !== 'complete'; i++) await tick(100);
    // Input is hit-tested against what was painted: on a slow machine (a hosted CI agent) the first
    // frame can come after 'complete', and a click before it reaches nothing. Wait for the button
    // to be what (100, 40) hits, two frames after it is, and record what the page receives.
    const hitTest = 'JSON.stringify({ hit: document.elementFromPoint(100, 40)?.id ?? null, w: innerWidth, h: innerHeight })';
    await evalIn(opener.id, "addEventListener('mousedown', () => { window.__down = (window.__down ?? 0) + 1; }, true); addEventListener('mouseup', () => { window.__up = (window.__up ?? 0) + 1; }, true); true");
    let hit = null;
    for (let i = 0; i < 50; i++) {
      hit = await evalIn(opener.id, hitTest);
      if (JSON.parse(hit).hit === 'b') break;
      await tick(100);
    }
    await platform.debugger.sendCommand(opener.id, 'Runtime.evaluate', { expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', awaitPromise: true, returnByValue: true }, null, { timeoutMs: 8_000 });
    const click = async (type) => platform.debugger.sendCommand(opener.id, 'Input.dispatchMouseEvent', { type, x: 100, y: 40, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, null, { timeoutMs: 8_000 });
    const t0 = Date.now();
    await click('mouseMoved');
    await click('mousePressed');
    await click('mouseReleased');
    const clickMs = Date.now() - t0;
    assert.ok(clickMs < 5_000, `the click returned (${clickMs} ms; the wedge was a 15-20 s hang)`);
    // The click's handler runs in the task that handles mouseup: poll briefly, and say what was seen.
    let state = null;
    for (let i = 0; i < 30; i++) {
      state = await evalIn(opener.id, 'JSON.stringify({ clicked: !!window.__clicked, opened: window.__opened ?? null, down: window.__down ?? 0, up: window.__up ?? 0, focus: document.hasFocus(), visibility: document.visibilityState })');
      if (JSON.parse(state).opened === true) break;
      await tick(100);
    }
    assert.equal(JSON.parse(state).opened, true, `window.open() returned the popup, and the opener's script ran on (${state}; before the click: ${hit})`);
    let popup = null;
    for (let i = 0; i < 50 && !popup; i++) {
      popup = (await platform.tabs.query({})).find((t) => t.openerTabId === opener.id && /\/popup$/.test(t.url)) ?? null;
      if (!popup) await tick(100);
    }
    assert.ok(popup, 'the popup is a tab on its page, with its opener');
    assert.ok(prepared.includes(popup.id), 'it was prepared');
    let tz = null;
    for (let i = 0; i < 50 && tz == null; i++) {
      tz = await evalIn(popup.id, 'window.tzAtLoad ?? null');
      if (tz == null) await tick(100);
    }
    assert.equal(tz, 'Europe/Berlin', 'its FIRST script already saw the preparation (it was held until then)');

    // A target=_blank link: the browser creates this tab itself, and it answers nothing while held.
    // (The popup is closed first: in front of the opener in its window, it would slow the opener's input.)
    await platform.tabs.remove(popup.id);
    const t1 = Date.now();
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await platform.debugger.sendCommand(opener.id, 'Input.dispatchMouseEvent', { type, x: 100, y: 130, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, null, { timeoutMs: 8_000 });
    }
    let fresh = null;
    for (let i = 0; i < 50 && !fresh; i++) {
      fresh = (await platform.tabs.query({})).find((t) => /\/newtab$/.test(t.url)) ?? null;
      if (!fresh) await tick(100);
    }
    assert.ok(fresh, 'the target=_blank tab is a tab');
    let tz2 = null;
    for (let i = 0; i < 50 && tz2 == null; i++) {
      tz2 = await evalIn(fresh.id, 'window.tzAtLoad ?? null').catch(() => null);
      if (tz2 == null) await tick(100);
    }
    assert.ok(prepared.includes(fresh.id), 'it was prepared');
    assert.equal(tz2, 'Europe/Berlin', 'its first script saw what was SENT while it was held');
    for (let i = 0; i < 30 && !(requests.get(fresh.id) ?? []).includes('/api/missing'); i++) await tick(100);
    assert.deepEqual((requests.get(fresh.id) ?? []).filter((p) => p === '/newtab' || p === '/api/missing'), ['/newtab', '/api/missing'],
      'its FIRST load\'s requests were captured (the document and its fetch)');
    const loadMs = requestTimes.get('/newtab') - t1;
    assert.ok(loadMs < cdp.PREPARE_BUDGET_MS, `not held until the budget ran out (${loadMs} ms from the click to its document request)`);
    offEvents();
  } finally {
    cdp.configure({ prepareTab: null });
    cdp.unregisterEngine('live2');
    server.close();
    if (h) {
      const pid = h.pid;
      const res = await h.close();
      assert.equal(res.profileRemoved, true, 'the temporary profile is gone');
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      assert.equal(alive, false, `browser pid ${pid} is gone`);
    }
  }
});

console.log(failures ? `\n${failures} failed` : '\nplatform-cdp: all passed');
process.exit(failures ? 1 : 0);
