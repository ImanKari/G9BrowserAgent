// Unit tests for G9's isolated world (extension/lib/world.js).
//
// Standalone (ARCHITECTURE_V2 §12.1): node:assert/strict, prints "  PASS <name>"
// per test, exits non-zero on the first failure. No network, no browser, no
// port. globalThis.chrome is stubbed with a FAKE BROWSER before any extension
// module is imported, so the real lib/platform.js → platform-extension.js →
// cdp.js path carries every command.
//
// The fake browser executes what G9 sends: every execution context is a real
// node:vm context, so an expression that would throw in a page throws here
// too (that is how EXT-01's `sessionId is not defined` would have been caught).
// It models the facts world.js depends on, as measured on Edge 153:
//   - Page.createIsolatedWorld is idempotent per (frame, worldName) and needs
//     no Runtime.enable;
//   - context ids are reused by a new renderer process after a cross-process
//     navigation (a stale id can name the page's MAIN world);
//   - a stale id fails Runtime.evaluate with "Cannot find context with
//     specified id" and DOM.resolveNode with "Node with given id does not
//     belong to the document";
//   - a binding added by executionContextName is installed only while Runtime
//     is enabled; by executionContextId it always is.
//
// This file also EXPORTS the fake (createFakeBrowser / installChrome) for
// setup/unit/interaction.test.mjs; its own tests run only when it is the
// entry point.
//
//   node setup/unit/world.test.mjs

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const EXT = join(here, '..', '..', 'extension');
export const extUrl = (rel) => pathToFileURL(join(EXT, rel)).href;

// ======================================================================
// The fake browser
// ======================================================================

// With the pointer events a browser fires first. A node with `cancelsPointerdown`
// behaves like a page whose pointerdown listener calls preventDefault(): the
// Pointer Events spec then suppresses the compatibility mousedown and mouseup,
// while pointerdown, pointerup and click still arrive (live round 2).
const DOM_EVENTS = {
  mouseMoved: ['pointermove', 'mousemove'],
  mousePressed: ['pointerdown', 'mousedown'],
  mouseReleased: ['pointerup', 'mouseup', 'click'],
  mouseWheel: ['wheel'],
};
const COMPAT_MOUSE = new Set(['mousedown', 'mouseup']);

/** chrome.storage-like area with chrome's get() semantics. */
function storageArea(map) {
  return {
    async get(keys) {
      if (keys == null) return Object.fromEntries(map);
      if (typeof keys === 'string') return map.has(keys) ? { [keys]: clone(map.get(keys)) } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => map.has(k)).map((k) => [k, clone(map.get(k))]));
      const out = {};
      for (const [k, dflt] of Object.entries(keys)) out[k] = map.has(k) ? clone(map.get(k)) : dflt;
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, clone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}
const clone = (v) => {
  const text = v === undefined ? undefined : JSON.stringify(v);
  return text === undefined ? undefined : JSON.parse(text);
};

/** Anything the stub does not model is a harmless no-op (a listener registry, a resolved promise). */
function autoStub() {
  const fn = function () { return Promise.resolve(undefined); };
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.toPrimitive) return () => '';
      if (!(prop in target)) target[prop] = autoStub();
      return target[prop];
    },
    apply() { return Promise.resolve(undefined); },
  });
}

/**
 * A minimal IndexedDB: enough for platform-extension's blob store (open with
 * upgrade, one-store transactions, put/get/delete, index getAll/getAllKeys,
 * cursors). `onWrite(storeName, record)` observes every put, so a test can
 * order writes against CDP commands.
 */
export function fakeIndexedDB({ onWrite = () => {} } = {}) {
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  function makeDb() {
    const stores = new Map();
    const db = {
      objectStoreNames: { contains: (n) => stores.has(n) },
      createObjectStore(name, { keyPath }) {
        const store = { keyPath, rows: new Map(), indexes: new Map() };
        stores.set(name, store);
        return { createIndex: (index, field) => store.indexes.set(index, field) };
      },
      transaction(name, mode) {
        const store = stores.get(Array.isArray(name) ? name[0] : name);
        const txn = { oncomplete: null, onerror: null, onabort: null, error: null };
        const request = (fn) => { const r = { result: undefined, onsuccess: null }; r.result = fn(); return r; };
        const cursorRequest = (rows) => {
          const r = { result: null, onsuccess: null };
          let i = 0;
          const step = () => queueMicrotask(() => {
            r.result = i < rows.length ? { value: rows[i], continue: () => { i += 1; step(); } } : null;
            r.onsuccess?.();
          });
          step();
          return r;
        };
        txn.objectStore = () => ({
          put: (record) => request(() => { store.rows.set(record[store.keyPath], record); onWrite(name, record); return record[store.keyPath]; }),
          get: (id) => request(() => store.rows.get(id)),
          delete: (id) => request(() => { store.rows.delete(id); }),
          openCursor: () => cursorRequest([...store.rows.values()]),
          index: (index) => {
            const field = store.indexes.get(index);
            return {
              getAll: (v) => request(() => [...store.rows.values()].filter((r) => r[field] === v)),
              getAllKeys: (v) => request(() => [...store.rows.values()].filter((r) => r[field] === v).map((r) => r[store.keyPath])),
            };
          },
        });
        later(() => later(() => txn.oncomplete?.()));
        void mode;
        return txn;
      },
    };
    return db;
  }
  return {
    open(name) {
      const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      later(() => {
        let db = dbs.get(name);
        const fresh = !db;
        if (fresh) dbs.set(name, (db = makeDb()));
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

export function createFakeBrowser({ viewport = { width: 1280, height: 800 } } = {}) {
  const log = [];              // every command: { tabId, sessionId, method, params, t }
  const eventListeners = new Set();
  const detachListeners = new Set();
  const contexts = new Map();  // id → ctx (alive)
  const allContexts = [];      // every context ever created, dead ones included
  const objects = new Map();   // objectId → { ctx, value }
  const released = [];
  const tabs = new Map();
  let nextCtx = 1;
  let nextObj = 1;
  const store = { session: new Map(), local: new Map() };

  let seq = 0;
  const fake = {
    log, contexts, allContexts, objects, released, tabs, store, viewport,
    /** One clock for CDP commands and anything else a test wants to order. */
    nextSeq: () => ++seq,
    /** Commands of one method, optionally filtered. */
    calls(method, pred = () => true) { return log.filter((c) => c.method === method && pred(c)); },
    emit(tabId, sessionId, method, params) {
      const source = sessionId ? { tabId, sessionId } : { tabId };
      for (const fn of eventListeners) fn(source, method, params);
    },
    setNextContextId(id) { nextCtx = id; },
  };

  // ------------------------------------------------------------- frames
  function newFrame(tab, { id, parentId = null, url, session = null }) {
    const frame = {
      id, parentId, url, session, tab,
      loaderId: `L-${id}-1`,
      loads: 1,
      listeners: [],           // { type, fn, capture, ctx }
      mainCtx: null,
      worlds: new Map(),       // worldName → ctx (current document)
    };
    frame.document = {
      hidden: false,
      visibilityState: 'visible',
      readyState: 'complete',
      title: 'Fake page',
    };
    tab.frames.set(id, frame);
    return frame;
  }

  fake.addTab = (tabId, { url = 'https://example.test/', frames = [] } = {}) => {
    const tab = {
      tabId, url, frames: new Map(), nodes: new Map(), scrollX: 0, scrollY: 0,
      pageHeight: 3000, focused: null, hidden: false, wheelScrolls: true,
      runtimeEnabled: new Set(),  // sessions (null = page) with Runtime enabled
      scripts: [],                // { session, source, worldName, identifier }
      nameBindings: [],           // { session, name, contextName }
    };
    tabs.set(tabId, tab);
    const main = newFrame(tab, { id: `F${tabId}`, url });
    tab.mainFrameId = main.id;
    for (const f of frames) {
      const frame = newFrame(tab, f);
      if (f.owner) {
        // The <iframe> element, in the parent's document; its content box is
        // where the frame's viewport sits.
        frame.ownerNodeId = f.owner.backendNodeId;
        tab.nodes.set(f.owner.backendNodeId, { tab, frame: tab.frames.get(f.parentId), tag: 'iframe', value: '', box: f.owner.box, backendNodeId: f.owner.backendNodeId, isFrameOwner: true });
      }
    }
    for (const frame of tab.frames.values()) createMainWorld(frame);
    return tab;
  };

  /** The root frame of a CDP session: its frame whose parent lives in another session (or none). */
  function frameOfSession(tab, session) {
    const s = session ?? null;
    return [...tab.frames.values()].find((f) => (f.session ?? null) === s
      && (!f.parentId || (tab.frames.get(f.parentId)?.session ?? null) !== s)) ?? null;
  }

  function frameTree(tab, session) {
    const root = frameOfSession(tab, session);
    const build = (f) => ({
      frame: { id: f.id, parentId: f.parentId ?? undefined, loaderId: f.loaderId, url: f.url },
      childFrames: [...tab.frames.values()]
        .filter((c) => c.parentId === f.id && (c.session ?? null) === (session ?? null))
        .map(build),
    });
    return { frameTree: build(root) };
  }

  // ----------------------------------------------------------- contexts
  function createContext(frame, world) {
    const id = nextCtx++;
    if (contexts.has(id)) throw new Error(`fake: context id ${id} already in use`);
    const tab = frame.tab;
    const sandbox = {};
    const context = vm.createContext(sandbox);
    // A top-level window is its own parent and top, as in a browser.
    vm.runInContext('globalThis.window = globalThis; globalThis.self = globalThis; globalThis.parent = globalThis; globalThis.top = globalThis;', context);
    const ctx = { id, frame, world, vm: context, sandbox, global: vm.runInContext('globalThis', context), alive: true, pending: new Set(), timers: new Set() };
    const win = sandbox;
    Object.assign(win, {
      addEventListener(type, fn, options) {
        const capture = typeof options === 'boolean' ? options : !!options?.capture;
        frame.listeners.push({ type, fn, capture, ctx });
      },
      removeEventListener(type, fn, options) {
        const capture = typeof options === 'boolean' ? options : !!options?.capture;
        const i = frame.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
        if (i >= 0) frame.listeners.splice(i, 1);
      },
      // A page's timers die with its document, as in a browser: a context the fake destroys
      // (fake.navigate) clears the ones still pending — a witness's long safety net among them.
      setTimeout: (fn, ms, ...rest) => {
        const t = setTimeout((...a) => { ctx.timers.delete(t); fn(...a); }, ms, ...rest);
        ctx.timers.add(t);
        return t;
      },
      clearTimeout: (t) => { clearTimeout(t); ctx.timers.delete(t); },
      performance: { now: () => performance.now(), timeOrigin: performance.timeOrigin },
      navigator: { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0) FakeChrome/153', language: 'en-US' },
      frames: { length: 0 },
      innerWidth: fake.viewport.width,
      innerHeight: fake.viewport.height,
      devicePixelRatio: 1,
      // Per element: a node declared `scroller` is an overflow:auto container.
      getComputedStyle: (el) => ({ overflowX: 'visible', overflowY: 'visible', content: 'none', position: 'static', pointerEvents: 'auto', display: 'block', visibility: 'visible', ...(el && el.__fakeStyle) }),
      NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
      scrollBy: (dx, dy) => { tab.scrollX += Number(dx) || 0; tab.scrollY = clampScroll(tab, tab.scrollY + (Number(dy) || 0)); },
      scrollTo: (x, y) => { tab.scrollX = Number(x) || 0; tab.scrollY = clampScroll(tab, Number(y) || 0); },
    });
    Object.defineProperty(win, 'scrollX', { get: () => tab.scrollX, enumerable: true, configurable: true });
    Object.defineProperty(win, 'scrollY', { get: () => tab.scrollY, enumerable: true, configurable: true });
    Object.defineProperty(win, 'location', { get: () => ({ href: frame.url }), enumerable: true, configurable: true });
    Object.defineProperty(win, 'document', { get: () => documentFor(frame, ctx), enumerable: true, configurable: true });
    ctx.baseline = new Set(Object.getOwnPropertyNames(sandbox));
    contexts.set(id, ctx);
    allContexts.push(ctx);
    return ctx;
  }

  function createMainWorld(frame) {
    frame.mainCtx = createContext(frame, 'main');
    return frame.mainCtx;
  }

  function worldFor(frame, name) {
    let ctx = frame.worlds.get(name);
    if (ctx?.alive) return ctx;
    ctx = createContext(frame, name);
    frame.worlds.set(name, ctx);
    // A world born while Runtime is enabled gets the name-scoped bindings.
    const tab = frame.tab;
    for (const b of tab.nameBindings) {
      if ((b.session ?? null) === (frame.session ?? null) && b.contextName === name && tab.runtimeEnabled.has(frame.session ?? null)) {
        installBinding(ctx, b.name);
      }
    }
    return ctx;
  }

  function installBinding(ctx, name) {
    ctx.sandbox[name] = (payload) => {
      fake.emit(ctx.frame.tab.tabId, ctx.frame.session, 'Runtime.bindingCalled', { name, payload: String(payload), executionContextId: ctx.id });
    };
  }

  function clampScroll(tab, y) {
    return Math.max(0, Math.min(y, Math.max(0, tab.pageHeight - fake.viewport.height)));
  }

  // ---------------------------------------------------------------- DOM
  const wrappers = new WeakMap(); // ctx → Map(nodeId → wrapper)
  function wrap(node, ctx) {
    if (!node) return null;
    let m = wrappers.get(ctx);
    if (!m) wrappers.set(ctx, (m = new Map()));
    if (m.has(node.backendNodeId)) return m.get(node.backendNodeId);
    const tab = node.tab;
    const w = {
      __fakeNode: node.backendNodeId,
      nodeType: 1,
      tagName: node.tag.toUpperCase(),
      id: node.attrs?.id ?? '',
      className: '',
      type: node.type ?? '',
      placeholder: node.attrs?.placeholder ?? '',
      maxLength: -1,
      inputMode: node.attrs?.inputmode ?? '',
      isContentEditable: false,
      readOnly: false,
      disabled: false,
      parentElement: null,
      get value() { return node.value; },
      set value(v) { node.value = String(v); },
      // The caret, as a field has one: browser_interact type without `clear` puts it at the end
      // before appending (interaction review, 2026-09-22).
      get selectionStart() { return node.selection ? node.selection[0] : String(node.value ?? '').length; },
      get selectionEnd() { return node.selection ? node.selection[1] : String(node.value ?? '').length; },
      setSelectionRange: (a, b) => { node.selection = [a, b]; node.selectionCalls = (node.selectionCalls ?? 0) + 1; },
      // `isConnected` is what tells a re-rendered element from one that merely moved.
      get isConnected() { return node.removed !== true; },
      get checked() { return !!node.checked; },
      get files() { return node.files ?? null; },
      get textContent() { return node.text ?? ''; },
      get ownerDocument() { return documentFor(node.frame, ctx); },
      getAttribute: (n) => node.attrs?.[n] ?? null,
      hasAttribute: (n) => node.attrs != null && n in node.attrs,
      contains: (other) => other === w,
      closest: () => w,
      getRootNode: () => documentFor(node.frame, ctx),
      getBoundingClientRect: () => {
        const b = viewBox(node);
        return { x: b.x, y: b.y, left: b.x, top: b.y, width: b.width, height: b.height, right: b.x + b.width, bottom: b.y + b.height };
      },
      getClientRects: () => {
        const b = viewBox(node);
        return [{ x: b.x, y: b.y, left: b.x, top: b.y, width: b.width, height: b.height, right: b.x + b.width, bottom: b.y + b.height }];
      },
      scrollIntoView: (opts) => {
        node.scrolledIntoView = (node.scrolledIntoView ?? 0) + 1;
        if (node.fixed) return;
        // block:'nearest', as a browser does: an element already fully on screen stays put.
        const top = node.box.y - tab.scrollY;
        if (opts?.block === 'nearest' && top >= 0 && top + node.box.height <= fake.viewport.height) return;
        tab.scrollY = clampScroll(tab, node.box.y + node.box.height / 2 - fake.viewport.height / 2);
      },
      select: () => { node.selectedAll = true; },
      focus: () => { tab.focused = node; },
    };
    if (node.scroller) {
      // An inner scroll container with room left both ways.
      Object.assign(w, {
        __fakeStyle: { overflowY: 'auto', overflowX: 'hidden' },
        scrollTop: 200, scrollLeft: 0, scrollHeight: 2000, clientHeight: node.box.height,
        scrollWidth: node.box.width, clientWidth: node.box.width,
      });
    }
    m.set(node.backendNodeId, w);
    return w;
  }

  const docs = new WeakMap();
  function documentFor(frame, ctx) {
    let m = docs.get(ctx);
    if (!m) docs.set(ctx, (m = new Map()));
    if (m.has(frame.id)) return m.get(frame.id);
    const tab = frame.tab;
    const body = { tagName: 'BODY', nodeType: 1, parentElement: null, getRootNode: () => doc, outerHTML: '<body></body>', closest: () => body, contains: () => true, get childElementCount() { return tab.bodyElements ?? 0; } };
    const doc = {
      // `noBody`: a document still parsing (or a frameset): no <body> yet.
      get body() { return tab.noBody ? null : body; },
      documentElement: { tagName: 'HTML', scrollTop: 0 },
      get defaultView() { return ctx.frame === frame ? ctx.global : worldFor(frame, ctx.world).global; },
      get hidden() { return tab.hidden; },
      get visibilityState() { return tab.hidden ? 'hidden' : 'visible'; },
      get readyState() { return frame.document.readyState; },
      get title() { return frame.document.title; },
      get activeElement() { return tab.focused && tab.focused.frame === frame ? wrap(tab.focused, ctx) : body; },
      get scrollingElement() {
        return {
          scrollTop: tab.scrollY, scrollLeft: tab.scrollX,
          scrollHeight: tab.pageHeight, clientHeight: fake.viewport.height,
          scrollWidth: fake.viewport.width, clientWidth: fake.viewport.width,
        };
      },
      elementsFromPoint: (x, y) => nodesAt(tab, frame, x, y).map((n) => wrap(n, ctx)),
      elementFromPoint: (x, y) => { const n = nodesAt(tab, frame, x, y)[0]; return n ? wrap(n, ctx) : body; },
      createRange: () => ({ selectNodeContents() {} }),
      createTreeWalker: (root) => {
        if (!root || typeof root !== 'object') {
          throw new TypeError("Failed to execute 'createTreeWalker' on 'Document': parameter 1 is not of type 'Node'.");
        }
        return { nextNode: () => null };
      },
    };
    m.set(frame.id, doc);
    return doc;
  }

  function viewBox(node) {
    const tab = node.tab;
    const b = node.box;
    return node.fixed ? { ...b } : { x: b.x - tab.scrollX, y: b.y - tab.scrollY, width: b.width, height: b.height };
  }

  function nodesAt(tab, frame, x, y) {
    return [...tab.nodes.values()]
      .filter((n) => n.frame === frame)
      .filter((n) => { const b = viewBox(n); return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height; })
      .sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
  }

  fake.addNode = (tabId, spec) => {
    const tab = tabs.get(tabId);
    const frame = tab.frames.get(spec.frameId ?? tab.mainFrameId);
    const node = { tab, frame, tag: 'button', value: '', ...spec };
    tab.nodes.set(spec.backendNodeId, node);
    return node;
  };

  function deliver(tab, frame, type, init) {
    for (const l of [...frame.listeners]) {
      if (l.type !== type || !l.ctx.alive) continue;
      const target = init.node ? wrap(init.node, l.ctx) : documentFor(frame, l.ctx).body;
      const event = { type, isTrusted: true, timeStamp: performance.now(), target, composedPath: () => [target], ...init.fields };
      try { l.fn(event); } catch { /* a page listener that throws does not stop dispatch */ }
    }
  }

  // --------------------------------------------------------- navigation
  /**
   * Commit a new document in a frame. `crossProcess` restarts context ids at
   * `reuseId` (or 1), as a new renderer's inspector does.
   */
  fake.navigate = (tabId, { frameId = null, url = null, crossProcess = false, reuseId = 1, fireEvent = true } = {}) => {
    const tab = tabs.get(tabId);
    const frame = tab.frames.get(frameId ?? tab.mainFrameId);
    const affected = frame.parentId ? [frame] : [...tab.frames.values()].filter((f) => (f.session ?? null) === (frame.session ?? null));
    for (const f of affected) {
      for (const ctx of [f.mainCtx, ...f.worlds.values()]) {
        if (!ctx) continue;
        ctx.alive = false;
        for (const t of ctx.timers) clearTimeout(t);
        ctx.timers.clear();
        contexts.delete(ctx.id);
        for (const reject of ctx.pending) reject(new Error('Inspected target navigated or closed'));
        ctx.pending.clear();
      }
      f.worlds.clear();
      f.listeners = [];
    }
    for (const [id, obj] of objects) if (!obj.ctx.alive) objects.delete(id);
    if (crossProcess) nextCtx = reuseId;
    frame.loads += 1;
    frame.loaderId = `L-${frame.id}-${frame.loads}`;
    if (url) frame.url = url;
    createMainWorld(frame);
    // Ids are per process in a browser; this fake keeps one table, so after a
    // deliberate reuse it moves on past every id still alive.
    nextCtx = Math.max(nextCtx, ...[...contexts.keys()].map((k) => k + 1));
    for (const other of affected) if (other !== frame) createMainWorld(other);
    // Scripts registered for new documents run in their world at document start.
    for (const s of tab.scripts) {
      if ((s.session ?? null) !== (frame.session ?? null)) continue;
      const ctx = s.worldName ? worldFor(frame, s.worldName) : frame.mainCtx;
      try { vm.runInContext(s.source, ctx.vm); } catch (err) { s.error = String(err); }
    }
    if (fireEvent) {
      fake.emit(tabId, frame.session, 'Page.frameNavigated', {
        frame: { id: frame.id, parentId: frame.parentId ?? undefined, loaderId: frame.loaderId, url: frame.url },
      });
    }
    return frame;
  };

  // ------------------------------------------------------------ commands
  const fail = (msg) => { throw new Error(msg); };

  function registerObject(ctx, value) {
    const id = `obj-${nextObj++}`;
    objects.set(id, { ctx, value });
    return id;
  }

  function remote(ctx, value, returnByValue) {
    const thenable = value && typeof value.then === 'function';
    if (returnByValue) return { result: { type: typeof value, value: clone(value) } };
    if (value === undefined) return { result: { type: 'undefined' } };
    if (value === null || typeof value !== 'object' && typeof value !== 'function') return { result: { type: typeof value, value } };
    return { result: { type: 'object', ...(thenable ? { subtype: 'promise' } : {}), objectId: registerObject(ctx, value) } };
  }

  async function settle(ctx, value) {
    if (!value || typeof value.then !== 'function') return value;
    return new Promise((resolveP, rejectP) => {
      ctx.pending.add(rejectP);
      value.then((v) => { ctx.pending.delete(rejectP); resolveP(v); }, (e) => { ctx.pending.delete(rejectP); rejectP(e); });
    });
  }

  const exception = (err) => ({ exceptionDetails: { text: 'Uncaught', exception: { description: String(err?.stack ?? err) } } });

  async function handle(tabId, sessionId, method, params, entry = {}) {
    const tab = tabs.get(tabId);
    if (!tab) fail(`No tab with given id ${tabId}`);
    const session = sessionId ?? null;
    switch (method) {
      case 'Runtime.enable': tab.runtimeEnabled.add(session); return {};
      case 'Runtime.disable': tab.runtimeEnabled.delete(session); return {};
      case 'Page.getFrameTree': return frameTree(tab, session);
      case 'Page.createIsolatedWorld': {
        const frame = tab.frames.get(params.frameId);
        if (!frame || (frame.session ?? null) !== session) fail('No frame for given id found');
        return { executionContextId: worldFor(frame, params.worldName ?? '').id };
      }
      case 'Page.getLayoutMetrics': {
        const v = { clientWidth: fake.viewport.width, clientHeight: fake.viewport.height };
        return {
          cssVisualViewport: { ...v, pageX: tab.scrollX, pageY: tab.scrollY, scale: 1, zoom: 1 },
          cssLayoutViewport: { ...v },
          cssContentSize: { x: 0, y: 0, width: fake.viewport.width, height: tab.pageHeight },
        };
      }
      case 'Page.captureScreenshot':
        return { data: Buffer.from(`png ${JSON.stringify(params.clip ?? null)}`).toString('base64') };
      case 'Page.addScriptToEvaluateOnNewDocument': {
        const identifier = String(tab.scripts.length + 1);
        tab.scripts.push({ session, source: params.source, worldName: params.worldName ?? null, identifier });
        return { identifier };
      }
      case 'Page.removeScriptToEvaluateOnNewDocument':
        tab.scripts = tab.scripts.filter((s) => s.identifier !== params.identifier);
        return {};
      case 'Runtime.addBinding': {
        if (params.executionContextId != null) {
          const ctx = contexts.get(params.executionContextId);
          if (!ctx) fail('Cannot find execution context with given executionContextId');
          installBinding(ctx, params.name);
          return {};
        }
        if (params.executionContextName != null) {
          tab.nameBindings.push({ session, name: params.name, contextName: params.executionContextName });
          if (tab.runtimeEnabled.has(session)) {
            for (const ctx of contexts.values()) {
              if (ctx.frame.tab === tab && (ctx.frame.session ?? null) === session && ctx.world === params.executionContextName) installBinding(ctx, params.name);
            }
          }
          return {};
        }
        // A bare binding lands in EVERY context, the page's main world included.
        tab.bareBinding = params.name;
        for (const ctx of contexts.values()) if (ctx.frame.tab === tab) installBinding(ctx, params.name);
        return {};
      }
      case 'Runtime.removeBinding': return {};
      case 'Runtime.evaluate': {
        let ctx;
        if (params.contextId != null) {
          ctx = contexts.get(params.contextId);
          if (!ctx) fail('Cannot find context with specified id');
        } else {
          ctx = frameOfSession(tab, session).mainCtx;
        }
        entry.world = ctx.world;
        entry.contextId = ctx.id;
        if (tab.loseNextMark && /__g9world/.test(params.expression)) {
          // The document is replaced between Page.createIsolatedWorld and the
          // marker write: the id just handed out already names nothing.
          tab.loseNextMark = false;
          fake.navigate(tabId, { frameId: ctx.frame.id, fireEvent: false });
          fail('Cannot find context with specified id');
        }
        if (ctx.destroyOnce) {
          ctx.destroyOnce = false;
          fail('Execution context was destroyed.');
        }
        if (tab.breakWitness && /const kinds = /.test(params.expression)) {
          return exception(new Error('witness arming broken on purpose'));
        }
        let value;
        try {
          value = vm.runInContext(params.expression, ctx.vm);
          if (params.awaitPromise) value = await settle(ctx, value);
        } catch (err) {
          if (/Inspected target navigated/.test(String(err?.message))) throw err;
          entry.threw = { type: typeof err, text: String(err?.message ?? err) };
          return exception(err);
        }
        return remote(ctx, value, params.returnByValue);
      }
      case 'Runtime.awaitPromise': {
        const obj = objects.get(params.promiseObjectId);
        if (!obj) fail('Could not find object with given id');
        const value = await settle(obj.ctx, obj.value);
        return remote(obj.ctx, value, params.returnByValue);
      }
      case 'Runtime.releaseObject':
        released.push(params.objectId);
        objects.delete(params.objectId);
        return {};
      case 'DOM.resolveNode': {
        const node = tab.nodes.get(params.backendNodeId);
        let ctx;
        if (params.executionContextId != null) {
          ctx = contexts.get(params.executionContextId);
          if (!ctx) fail('Node with given id does not belong to the document');
        } else {
          ctx = frameOfSession(tab, session).mainCtx;
        }
        if (!node) fail('No node with given id found');
        entry.world = ctx.world;
        return { object: { type: 'object', subtype: 'node', objectId: registerObject(ctx, wrap(node, ctx)) } };
      }
      case 'Runtime.callFunctionOn': {
        const obj = objects.get(params.objectId);
        if (!obj) fail('Could not find object with given id');
        if (!obj.ctx.alive) fail('Cannot find context with specified id');
        entry.world = obj.ctx.world;
        entry.contextId = obj.ctx.id;
        // A witness armed ON an element arrives as a function, not an expression.
        if (tab.breakWitness && /const kinds = /.test(params.functionDeclaration)) {
          return exception(new Error('witness arming broken on purpose'));
        }
        let value;
        try {
          const fn = vm.runInContext(`(${params.functionDeclaration})`, obj.ctx.vm);
          value = fn.apply(obj.value, (params.arguments ?? []).map((a) => a.value));
          if (params.awaitPromise) value = await settle(obj.ctx, value);
        } catch (err) {
          entry.threw = { type: typeof err, text: String(err?.message ?? err) };
          return exception(err);
        }
        return remote(obj.ctx, value, params.returnByValue);
      }
      case 'DOM.describeNode': {
        const obj = objects.get(params.objectId);
        return { node: { backendNodeId: obj?.value?.__fakeNode ?? null } };
      }
      case 'DOM.getBoxModel': {
        const node = tab.nodes.get(params.backendNodeId);
        if (!node) fail('Could not compute box model.');
        const b = viewBox(node);
        const q = [b.x, b.y, b.x + b.width, b.y, b.x + b.width, b.y + b.height, b.x, b.y + b.height];
        // `moveAfterMeasure`: the element moves away right after G9 measured it (an animation, a
        // script reacting to the pointer) — live round 3's runaway button.
        if (node.moveAfterMeasure) { node.box = { ...node.box, ...node.moveAfterMeasure }; node.moveAfterMeasure = null; }
        return { model: { content: q, padding: q, border: q, margin: q, width: b.width, height: b.height } };
      }
      case 'DOM.focus': {
        const node = tab.nodes.get(params.backendNodeId);
        if (node) tab.focused = node;
        return {};
      }
      case 'DOM.getFrameOwner': {
        // Answered only by the process that holds the <iframe> element.
        const frame = tab.frames.get(params.frameId);
        const parent = frame && tab.frames.get(frame.parentId);
        if (!frame || !parent || (parent.session ?? null) !== session || !frame.ownerNodeId) fail('Frame with the given id was not found.');
        return { backendNodeId: frame.ownerNodeId, nodeId: frame.ownerNodeId };
      }
      case 'Input.dispatchMouseEvent': {
        // `hideOnInput`: the person switches tabs just as the input goes out (after G9's
        // visibility check said visible). `dropInput`: input vanishes while the page reports
        // visible (a native dialog or overlay the browser owns).
        if (tab.hideOnInput) { tab.hidden = true; tab.hideOnInput = false; }
        // `hiddenInputHangs`: as measured on real hidden pages (P8 matrix, round 3), pointer and wheel
        // input to a hidden page is never answered, rather than answered and dropped.
        if (tab.hidden && tab.hiddenInputHangs) return new Promise(() => {});
        if (tab.hidden || tab.dropInput) return {};
        // `wheelHangs`: a wheel event the browser accepts and never answers (the v1.5.1 wedge).
        if (params.type === 'mouseWheel' && tab.wheelHangs) return new Promise(() => {});
        // A slow transport: this event reaches the page only after a delay
        // (the extension's per-command overhead adding up over a long path).
        const lag = tab.inputDelay?.[params.type];
        if (lag) await new Promise((r) => setTimeout(r, lag));
        // One slow event (a hiccup in the transport): the move at this x takes `ms` to arrive.
        if (tab.inputDelayAt && params.type === 'mouseMoved' && params.x === tab.inputDelayAt.x) {
          await new Promise((r) => setTimeout(r, tab.inputDelayAt.ms));
        }
        const frame = frameOfSession(tab, session);
        const target = nodesAt(tab, frame, params.x, params.y)[0] ?? null;
        if (params.type === 'mousePressed' && target?.navigatesOnPress) {
          // A link whose handler navigates before anything else sees the press.
          target.navigatesOnPress = false;
          fake.navigate(tab.tabId, { url: target.navigatesOnPress === false ? 'https://example.test/next' : frame.url });
          return {};
        }
        if (params.type === 'mousePressed' && target) tab.focused = target;
        if (params.type === 'mouseWheel' && tab.wheelScrolls) {
          // `scrollLag`: the scroll lands that long AFTER the dispatch returned, as a real
          // compositor applies it a frame or more later (~100 ms on CfT's 10 Hz renderer).
          const delta = params.deltaY ?? 0;
          if (tab.scrollLag) setTimeout(() => { tab.scrollY = clampScroll(tab, tab.scrollY + delta); }, tab.scrollLag);
          else tab.scrollY = clampScroll(tab, tab.scrollY + delta);
        }
        // `hideAfterWheels`: the person switches tabs after N notches have landed (P8 matrix 'hidemid').
        if (params.type === 'mouseWheel' && tab.hideAfterWheels > 0 && ++tab.wheelsSeen >= tab.hideAfterWheels) tab.hidden = true;
        for (const type of DOM_EVENTS[params.type] ?? []) {
          if (target?.cancelsPointerdown && COMPAT_MOUSE.has(type)) continue;
          deliver(tab, frame, type, {
            node: target,
            fields: { clientX: params.x, clientY: params.y, screenX: params.x, screenY: params.y, button: params.button === 'right' ? 2 : 0, buttons: params.buttons ?? 0, detail: params.clickCount ?? 0, deltaX: params.deltaX ?? 0, deltaY: params.deltaY ?? 0, deltaMode: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false },
          });
        }
        return {};
      }
      case 'Input.dispatchKeyEvent': {
        if (tab.hideOnInput) { tab.hidden = true; tab.hideOnInput = false; }
        if (tab.hidden || tab.dropInput) return {};
        const frame = tab.focused?.frame ?? frameOfSession(tab, session);
        const fields = { key: params.key, code: params.code ?? '', repeat: false, ctrlKey: !!(params.modifiers & 2), shiftKey: !!(params.modifiers & 8), altKey: !!(params.modifiers & 1), metaKey: !!(params.modifiers & 4) };
        if (params.type === 'keyDown' || params.type === 'rawKeyDown') {
          deliver(tab, frame, 'keydown', { node: tab.focused, fields });
          const n = tab.focused;
          if (n && params.type === 'keyDown' && typeof params.text === 'string' && params.text.length && params.text !== '\r' && !(n.rejects && n.rejects.test(params.text))) {
            n.value = (n.selectedAll ? '' : n.value) + params.text;
            n.selectedAll = false;
            deliver(tab, frame, 'input', { node: n, fields: {} });
          } else if (n && (params.key === 'Backspace' || params.key === 'Delete')) {
            n.value = n.selectedAll ? '' : params.key === 'Backspace' ? [...n.value].slice(0, -1).join('') : n.value;
            n.selectedAll = false;
            deliver(tab, frame, 'input', { node: n, fields: {} });
          } else if (n && params.modifiers && (params.key === 'a' || params.key === 'A')) {
            n.selectedAll = true;
          }
        } else if (params.type === 'keyUp') {
          deliver(tab, frame, 'keyup', { node: tab.focused, fields });
        }
        return {};
      }
      case 'Input.insertText': {
        if (tab.hidden) return {};
        const n = tab.focused;
        if (n) { n.value = (n.selectedAll ? '' : n.value) + params.text; n.selectedAll = false; deliver(tab, n.frame, 'input', { node: n, fields: {} }); }
        return {};
      }
      case 'Page.startScreencast':
        if (tab.refuseScreencast) {
          tab.refuseScreencast = false;
          fail('Unable to start the screencast');
        }
        // `betweenDocuments`: the page is committing a navigation — refused this many times (3.2).
        if (tab.betweenDocuments > 0) {
          tab.betweenDocuments -= 1;
          fail('Not attached to an active page');
        }
        tab.screencast = { ...params };
        return {};
      case 'Accessibility.getFullAXTree': {
        const root = { nodeId: 'ax1', role: { value: 'RootWebArea' }, name: { value: frameOfSession(tab, session).document.title }, childIds: [] };
        // `axEmptyCalls`: the renderer has not (re)built its tree yet — right after a window move.
        if (tab.axEmptyCalls > 0) { tab.axEmptyCalls -= 1; return { nodes: [root] }; }
        if (tab.axNodes) return { nodes: tab.axNodes };
        return { nodes: [root] };
      }
      case 'DOM.getDocument':
        return { root: { nodeId: 1, backendNodeId: 1, documentURL: frameOfSession(tab, session).url } };
      case 'Page.stopScreencast':
        tab.screencast = null;
        return {};
      case 'Page.screencastFrameAck':
        (tab.acks ??= []).push(params.sessionId);
        return {};
      case 'Page.navigate':
        // `navigateDelayMs`: a server slow to send its response headers (Page.navigate answers on commit).
        if (tab.navigateDelayMs) await new Promise((r) => setTimeout(r, tab.navigateDelayMs));
        return { frameId: frameOfSession(tab, session).id, loaderId: 'L-fake' };
      case 'Target.setAutoAttach':
      case 'Page.enable': case 'DOM.enable': case 'Log.enable': case 'Network.enable': case 'CSS.enable': case 'Accessibility.enable':
        return {};
      default:
        return {};
    }
  }

  // --------------------------------------------------------- chrome stub
  const debuggerApi = {
    attach: async () => {},
    detach: async () => {},
    getTargets: async () => [...tabs.keys()].map((tabId) => ({ tabId, attached: true, type: 'page' })),
    sendCommand: async (debuggee, method, params = {}) => {
      const entry = { tabId: debuggee.tabId, sessionId: debuggee.sessionId ?? null, method, params: clone(params) ?? {}, t: performance.now(), seq: fake.nextSeq() };
      log.push(entry);
      return handle(debuggee.tabId, debuggee.sessionId ?? null, method, params, entry);
    },
    onEvent: { addListener: (fn) => eventListeners.add(fn), removeListener: (fn) => eventListeners.delete(fn) },
    onDetach: { addListener: (fn) => detachListeners.add(fn), removeListener: (fn) => detachListeners.delete(fn) },
  };

  const chrome = new Proxy({
    debugger: debuggerApi,
    storage: { session: storageArea(store.session), local: storageArea(store.local), onChanged: autoStub() },
    runtime: {
      id: 'fakeextensionid',
      getManifest: () => ({ version: '2.0.0', name: 'G9 (fake)' }),
      getURL: (p) => `chrome-extension://fakeextensionid/${p}`,
      sendMessage: () => Promise.resolve(),
      onMessage: autoStub(),
      reload: () => {},
    },
    tabs: {
      get: async (tabId) => ({ id: tabId, url: tabs.get(tabId)?.url ?? '', title: 'Fake', windowId: 1, active: true, status: 'complete' }),
      query: async () => [...tabs.keys()].map((id) => ({ id, url: tabs.get(id).url, windowId: 1, active: true, status: 'complete' })),
      onRemoved: autoStub(), onCreated: autoStub(), onUpdated: autoStub(),
    },
  }, {
    get(target, prop) {
      if (!(prop in target)) target[prop] = autoStub();
      return target[prop];
    },
  });
  fake.chrome = chrome;
  return fake;
}

/** Install the fake as globalThis.chrome. Must run before any extension module is imported. */
export function installChrome(fake) {
  globalThis.chrome = fake.chrome;
  return fake;
}

// ======================================================================
// Tests
// ======================================================================

let passed = 0;
export async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  PASS ' + name);
  } catch (err) {
    console.error('  FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

async function main() {
  const fake = installChrome(createFakeBrowser());
  // The stealth level: the Runtime domain is never enabled, not even by
  // cdp.attach. Everything below must work regardless.
  fake.store.local.set('settings', { inputMode: 'stealth' });
  const TAB = 7;
  fake.addTab(TAB, {
    url: 'https://example.test/',
    frames: [
      { id: 'SAME', parentId: `F${TAB}`, url: 'https://example.test/child' },
      { id: 'OOP', parentId: `F${TAB}`, url: 'https://other.test/', session: 'S-OOP' },
    ],
  });
  const tab = fake.tabs.get(TAB);
  fake.addNode(TAB, { backendNodeId: 42, tag: 'input', value: 'hello', box: { x: 10, y: 10, width: 100, height: 20 } });
  fake.addNode(TAB, { backendNodeId: 77, tag: 'input', value: 'in-frame', frameId: 'OOP', box: { x: 5, y: 5, width: 50, height: 20 } });

  const world = await import(extUrl('lib/world.js'));
  const MAIN = `F${TAB}`;
  const creates = (pred = () => true) => fake.calls('Page.createIsolatedWorld', pred);

  await test('world name is g9', () => {
    assert.equal(world.WORLD, 'g9');
  });

  let firstId;
  await test('contextFor creates the g9 world on the main frame (frame tree, createIsolatedWorld, marker)', async () => {
    firstId = await world.contextFor(TAB);
    const trees = fake.calls('Page.getFrameTree', (c) => c.tabId === TAB && !c.sessionId);
    assert.ok(trees.length >= 1, 'Page.getFrameTree was asked');
    const made = creates();
    assert.equal(made.length, 1);
    assert.deepEqual(made[0].params, { frameId: MAIN, worldName: 'g9', grantUniveralAccess: true });
    assert.equal(fake.contexts.get(firstId).world, 'g9');
    assert.equal(fake.contexts.get(firstId).frame.id, MAIN);
    // The marker went into the new world, not the page's.
    const marker = fake.calls('Runtime.evaluate', (c) => c.params.contextId === firstId);
    assert.ok(marker.length >= 1 && /__g9world/.test(marker[0].params.expression));
  });

  await test('never enables the Runtime domain to find its context', () => {
    assert.equal(fake.calls('Runtime.enable').length, 0);
  });

  await test('cached: a second contextFor and inWorld reuse the id without creating again', async () => {
    const before = creates().length;
    assert.equal(await world.contextFor(TAB), firstId);
    assert.equal(await world.inWorld(TAB, '1 + 2'), 3);
    assert.equal(creates().length, before);
    const last = fake.calls('Runtime.evaluate').at(-1);
    assert.equal(last.params.contextId, firstId);
    assert.equal(last.params.userGesture, false, 'no user activation by default');
  });

  await test('inWorld evaluates in the isolated world only: the page main world gains nothing', async () => {
    await world.inWorld(TAB, 'globalThis.__g9probe = 1; window.__g9loc = { ok: true }; 5');
    const main = tab.frames.get(MAIN).mainCtx.sandbox;
    assert.equal(main.__g9probe, undefined);
    assert.equal(main.__g9loc, undefined);
    assert.equal(fake.contexts.get(firstId).sandbox.__g9probe, 1);
    const leaked = Object.getOwnPropertyNames(main).filter((n) => n.startsWith('__g9'));
    assert.deepEqual(leaked, []);
  });

  await test('inWorld surfaces a page exception as an Error with its text', async () => {
    await assert.rejects(world.inWorld(TAB, 'throw new TypeError("boom")'), /boom/);
  });

  await test('inWorld awaits promises and returnByValue:false hands back the RemoteObject', async () => {
    assert.equal(await world.inWorld(TAB, 'Promise.resolve(41).then((v) => v + 1)'), 42);
    const handle = await world.inWorld(TAB, 'new Promise(() => {})', { awaitPromise: false, returnByValue: false });
    assert.equal(handle.subtype, 'promise');
    assert.ok(handle.objectId);
    assert.equal(fake.objects.get(handle.objectId).ctx.id, firstId);
  });

  await test('invalidated by Page.frameNavigated: the next call creates a fresh world', async () => {
    const before = creates().length;
    fake.navigate(TAB, { fireEvent: true });
    const id = await world.contextFor(TAB);
    assert.notEqual(id, firstId);
    assert.equal(creates().length, before + 1);
    assert.equal(await world.inWorld(TAB, '"alive"'), 'alive');
    firstId = id;
  });

  await test('missed navigation: "Cannot find context" is retried once, transparently', async () => {
    const before = creates().length;
    fake.navigate(TAB, { fireEvent: false });
    const evalsBefore = fake.calls('Runtime.evaluate').length;
    assert.equal(await world.inWorld(TAB, '6 * 7'), 42);
    assert.equal(creates().length, before + 1, 'one new world');
    const evals = fake.calls('Runtime.evaluate').slice(evalsBefore);
    // stale attempt, marker in the new world, the real attempt
    assert.equal(evals.length, 3);
    firstId = await world.contextFor(TAB);
  });

  await test('cross-process navigation that REUSES the id for the main world: the guard refuses and retries', async () => {
    const stale = firstId;
    // No event, new process, and the page's main world is born with the old id.
    fake.navigate(TAB, { fireEvent: false, crossProcess: true, reuseId: stale });
    const main = tab.frames.get(MAIN).mainCtx;
    assert.equal(main.id, stale, 'the stale id now names the MAIN world');
    const namesBefore = Object.getOwnPropertyNames(main.sandbox);
    const out = await world.inWorld(TAB, 'globalThis.__g9secret = "x"; document.title');
    assert.equal(out, 'Fake page');
    assert.deepEqual(Object.getOwnPropertyNames(main.sandbox), namesBefore, 'nothing was written into the main world');
    const now = await world.contextFor(TAB);
    assert.notEqual(now, stale);
    assert.equal(fake.contexts.get(now).world, 'g9');
    firstId = now;
  });

  await test('"Execution context was destroyed" is retried once for an idempotent read', async () => {
    const ctx = fake.contexts.get(await world.contextFor(TAB));
    ctx.destroyOnce = true;
    const before = fake.calls('Runtime.evaluate').length;
    assert.equal(await world.inWorld(TAB, '"again"'), 'again');
    // failed attempt, re-mark of the (same, idempotent) world, the real attempt
    assert.equal(fake.calls('Runtime.evaluate').length - before, 3);
  });

  await test('...but NOT for an expression declared non-idempotent', async () => {
    const ctx = fake.contexts.get(await world.contextFor(TAB));
    ctx.destroyOnce = true;
    await assert.rejects(world.inWorld(TAB, 'scrollBy(0, 10)', { idempotent: false }), /destroyed/);
  });

  await test('callInWorld resolves the node WITH the world context id and calls in that world', async () => {
    const id = await world.contextFor(TAB);
    const before = fake.log.length;
    const value = await world.callInWorld(TAB, 42, 'function (suffix) { window.__g9mark = 1; return this.value + suffix; }', ['!']);
    assert.equal(value, 'hello!');
    const cmds = fake.log.slice(before);
    const resolveCmd = cmds.find((c) => c.method === 'DOM.resolveNode');
    assert.deepEqual(resolveCmd.params, { backendNodeId: 42, executionContextId: id });
    const call = cmds.find((c) => c.method === 'Runtime.callFunctionOn');
    assert.equal(fake.contexts.get(id).sandbox.__g9mark, 1, 'side effects land in the g9 world');
    assert.equal(tab.frames.get(MAIN).mainCtx.sandbox.__g9mark, undefined);
    assert.equal(call.params.returnByValue, true);
    const releasedId = cmds.find((c) => c.method === 'Runtime.releaseObject');
    assert.ok(releasedId, 'the node handle is released');
    assert.ok(fake.released.includes(releasedId.params.objectId));
  });

  await test('callInWorld retries once when a CACHED id reads as "does not belong to the document"', async () => {
    const stale = await world.contextFor(TAB);
    fake.navigate(TAB, { fireEvent: false });
    assert.ok(!fake.contexts.has(stale));
    const before = creates().length;
    assert.equal(await world.callInWorld(TAB, 42, 'function () { return this.value; }'), 'hello');
    assert.equal(creates().length, before + 1);
  });

  await test('callInWorld: a genuinely missing node fails without a retry loop', async () => {
    const before = fake.calls('DOM.resolveNode').length;
    await assert.rejects(world.callInWorld(TAB, 999, 'function () { return 1; }'), /No node/);
    assert.equal(fake.calls('DOM.resolveNode').length - before, 1);
  });

  await test('callInWorld refuses to run in a context that is not G9\'s (guarded function)', async () => {
    // Simulate a stale cached id that now names the main world, for resolveNode.
    const stale = await world.contextFor(TAB);
    fake.navigate(TAB, { fireEvent: false, crossProcess: true, reuseId: stale });
    const main = tab.frames.get(MAIN).mainCtx;
    assert.equal(main.id, stale);
    const out = await world.callInWorld(TAB, 42, 'function () { window.__g9oops = 1; return this.tagName; }');
    assert.equal(out, 'INPUT');
    assert.equal(main.sandbox.__g9oops, undefined, 'the function did not run in the main world');
  });

  await test('frameId: a world per frame; an unknown frame is a clear error', async () => {
    const child = await world.contextFor(TAB, { frameId: 'SAME' });
    assert.equal(fake.contexts.get(child).frame.id, 'SAME');
    assert.notEqual(child, await world.contextFor(TAB));
    assert.equal(await world.inWorld(TAB, 'location.href', { frameId: 'SAME' }), 'https://example.test/child');
    await assert.rejects(world.contextFor(TAB, { frameId: 'NOPE' }), /no longer in this page/);
  });

  await test('child session: frame tree and world are asked ON that session', async () => {
    const id = await world.contextFor(TAB, { sessionId: 'S-OOP' });
    const tree = fake.calls('Page.getFrameTree', (c) => c.sessionId === 'S-OOP');
    assert.ok(tree.length >= 1);
    const made = creates((c) => c.sessionId === 'S-OOP');
    assert.equal(made.at(-1).params.frameId, 'OOP');
    assert.equal(fake.contexts.get(id).frame.id, 'OOP');
    assert.equal(await world.callInWorld(TAB, 77, 'function () { return this.value; }', [], 'S-OOP'), 'in-frame');
  });

  await test('invalidate(tab, session) drops only that session; invalidate(tab) drops all', async () => {
    const pageId = await world.contextFor(TAB);
    const childId = await world.contextFor(TAB, { sessionId: 'S-OOP' });
    const before = creates().length;
    world.invalidate(TAB, 'S-OOP');
    assert.equal(await world.contextFor(TAB), pageId);
    assert.equal(creates().length, before);
    await world.contextFor(TAB, { sessionId: 'S-OOP' });
    assert.equal(creates().length, before + 1, 'child re-created');
    world.invalidate(TAB);
    await world.contextFor(TAB);
    assert.equal(creates().length, before + 2, 'page re-created after a full invalidate');
    assert.ok(childId);
  });

  await test('Target.detachedFromTarget drops the detached child session', async () => {
    await world.contextFor(TAB, { sessionId: 'S-OOP' });
    const before = creates().length;
    fake.emit(TAB, null, 'Target.detachedFromTarget', { sessionId: 'S-OOP' });
    await world.contextFor(TAB, { sessionId: 'S-OOP' });
    assert.equal(creates().length, before + 1);
  });

  await test('concurrent callers share ONE world creation', async () => {
    world.invalidate(TAB);
    const before = creates().length;
    const ids = await Promise.all([world.contextFor(TAB), world.contextFor(TAB), world.inWorld(TAB, '1').then(() => world.contextFor(TAB))]);
    assert.equal(new Set(ids).size, 1);
    assert.equal(creates().length, before + 1);
  });

  await test('a navigation between creating the world and marking it is retried, not surfaced', async () => {
    world.invalidate(TAB);
    tab.loseNextMark = true;
    const before = creates().length;
    // Before the fix the creation step sat outside the retry, so this failed
    // with "the page replaced its document…" although nothing had run yet.
    assert.equal(await world.inWorld(TAB, '"marked"'), 'marked');
    assert.equal(tab.loseNextMark, false, 'the lost marker write really happened');
    assert.equal(creates().length, before + 2, 'one world lost to the navigation, one that stuck');
    assert.equal(fake.contexts.get(await world.contextFor(TAB)).world, 'g9');
  });

  await test('verifiedContextFor never hands out a cached id that now names the main world', async () => {
    const stale = await world.contextFor(TAB);
    fake.navigate(TAB, { fireEvent: false, crossProcess: true, reuseId: stale });
    const main = tab.frames.get(MAIN).mainCtx;
    assert.equal(main.id, stale, 'the stale id now names the MAIN world');
    assert.equal(await world.contextFor(TAB), stale, 'the plain cache cannot know');
    const id = await world.verifiedContextFor(TAB);
    assert.notEqual(id, stale);
    assert.equal(fake.contexts.get(id).world, 'g9');
    const leaked = Object.getOwnPropertyNames(main.sandbox).filter((n) => !main.baseline.has(n));
    assert.deepEqual(leaked, [], 'the check itself wrote nothing into the main world');
  });

  await test('framesOf lists the session\'s frame tree', async () => {
    const list = await world.framesOf(TAB);
    assert.deepEqual(list.map((f) => f.id), [MAIN, 'SAME']);
    const child = await world.framesOf(TAB, { sessionId: 'S-OOP' });
    assert.deepEqual(child.map((f) => f.id), ['OOP']);
  });

  await test('guard helpers: expressions keep their completion value; functions keep `this` and arguments', () => {
    const ctx = vm.createContext({});
    const src = world.guardExpression('({ a: 1 })');
    assert.throws(() => vm.runInContext(src, ctx), /G9_STALE_WORLD/);
    const token = /!== ("[^"]+")/.exec(src)[1];
    vm.runInContext(`globalThis.__g9world = ${token};`, ctx);
    assert.deepEqual(clone(vm.runInContext(src, ctx)), { a: 1 });
    const fn = vm.runInContext(`(${world.guardFunction('function (x, y) { return this.v + x + y; }')})`, ctx);
    assert.equal(fn.call({ v: 1 }, 2, 3), 6);
  });

  await test("D-b in the extension: the panel's Input is the default level, and only its Stealth is a stealth level (a floor)", async () => {
    const { platform } = await import(extUrl('lib/platform.js'));
    const state = await import(extUrl('lib/state.js'));
    // mode → [humanizeFor, stealthFor]. Human and Direct are defaults an agent's
    // `humanize` may loosen or tighten; Stealth is also the floor.
    const expected = { off: ['off', 'off'], human: ['human', 'off'], stealth: ['stealth', 'stealth'] };
    try {
      for (const [mode, [dflt, floor]] of Object.entries(expected)) {
        await state.setState({ inputMode: mode });
        assert.equal(platform.settings.humanizeFor(TAB), dflt, `panel ${mode}: default level`);
        assert.equal(platform.settings.stealthFor(TAB), floor, `panel ${mode}: stealth level`);
      }
    } finally {
      await state.setState({ inputMode: 'stealth' });
    }
    assert.equal(platform.settings.stealthFor(TAB), 'stealth', 'restored for the rest of the suite');
  });

  console.log(`world: ${passed} passed`);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  await main();
}
