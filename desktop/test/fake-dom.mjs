/**
 * A small DOM for running the renderer's views under plain node — no window, no Electron, no
 * browser (the desktop's tests never open one). It implements exactly the surface the renderer
 * uses (a survey of renderer/**: createElement(NS), text nodes, attributes, dataset, classList,
 * style, hidden/disabled/checked/value/selected, events, querySelector(All) with simple selectors,
 * <dialog>, <canvas> 2D stubs) and a parser good enough for renderer/index.html.
 *
 * What it proves: every view mounts, renders the daemon's real shapes, reacts to state and
 * events, and calls the main process with the right operations — without a ReferenceError or a
 * TypeError anywhere on those paths. What it does not prove: layout and paint (that needs the
 * integration stage's real window, `main.mjs --check-render`).
 */

const VOID = new Set(['meta', 'link', 'input', 'br', 'img', 'hr', 'col', 'source']);
const BOOL_PROPS = ['hidden', 'disabled', 'checked', 'selected', 'open', 'required', 'multiple'];

export class FakeNode extends EventTarget {
  constructor(ownerDocument) {
    super();
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
  }

  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get children() { return this.childNodes.filter((n) => n instanceof FakeElement); }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get firstElementChild() { return this.children[0] ?? null; }
  get parentElement() { return this.parentNode instanceof FakeElement ? this.parentNode : null; }

  #adopt(node) {
    if (typeof node === 'string') node = this.ownerDocument.createTextNode(node);
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    return node;
  }

  appendChild(node) { this.childNodes.push(this.#adopt(node)); return node; }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  prepend(...nodes) {
    const adopted = nodes.map((n) => this.#adopt(n));
    this.childNodes.unshift(...adopted);
  }
  insertBefore(node, ref) {
    const n = this.#adopt(node);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(n);
    else this.childNodes.splice(i, 0, n);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  remove() { this.parentNode?.removeChild(this); }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }

  dispatchEvent(event) {
    const result = super.dispatchEvent(event);
    const handler = this[`on${event.type}`];
    if (typeof handler === 'function') handler.call(this, event);
    return result;
  }
}

export class FakeText extends FakeNode {
  constructor(doc, text) {
    super(doc);
    this.data = String(text);
  }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class ClassList {
  constructor(el) { this.el = el; }
  #get() { return (this.el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean); }
  #set(list) { this.el.setAttribute('class', list.join(' ')); }
  contains(c) { return this.#get().includes(c); }
  add(...cs) { const l = this.#get(); for (const c of cs) if (!l.includes(c)) l.push(c); this.#set(l); }
  remove(...cs) { this.#set(this.#get().filter((c) => !cs.includes(c))); }
  toggle(c, force) {
    const has = this.contains(c);
    const want = force === undefined ? !has : !!force;
    if (want && !has) this.add(c);
    if (!want && has) this.remove(c);
    return want;
  }
  [Symbol.iterator]() { return this.#get()[Symbol.iterator](); }
}

const toDataAttr = (k) => `data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;

function canvasContext() {
  const noop = () => {};
  return new Proxy({ canvas: null }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return (t) => ({ width: String(t).length * 7 });
      return noop;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

export class FakeElement extends FakeNode {
  constructor(doc, tag, ns = null) {
    super(doc);
    this.tagName = String(tag).toUpperCase();
    this.localName = String(tag).toLowerCase();
    this.namespaceURI = ns;
    this.attributes = new Map();
    this.style = {};
    this.classList = new ClassList(this);
    this._props = {};
    const el = this;
    this.dataset = new Proxy({}, {
      get: (_t, k) => (typeof k === 'string' ? el.getAttribute(toDataAttr(k)) ?? undefined : undefined),
      set: (_t, k, v) => { el.setAttribute(toDataAttr(k), String(v)); return true; },
      has: (_t, k) => el.hasAttribute(toDataAttr(k)),
      ownKeys: () => [...el.attributes.keys()].filter((a) => a.startsWith('data-')).map((a) => a.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
    if (this.localName === 'canvas') {
      this.width = 300;
      this.height = 150;
    }
  }

  getAttribute(n) { return this.attributes.has(n) ? this.attributes.get(n) : null; }
  setAttribute(n, v) { this.attributes.set(String(n).toLowerCase(), String(v)); }
  removeAttribute(n) { this.attributes.delete(String(n).toLowerCase()); }
  hasAttribute(n) { return this.attributes.has(String(n).toLowerCase()); }
  toggleAttribute(n, force) {
    const want = force === undefined ? !this.hasAttribute(n) : !!force;
    if (want) this.setAttribute(n, '');
    else this.removeAttribute(n);
    return want;
  }

  get id() { return this.getAttribute('id') ?? ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v) { this.setAttribute('class', v); }
  get type() { return this.getAttribute('type') ?? (this.localName === 'input' ? 'text' : this.localName === 'button' ? 'submit' : ''); }
  set type(v) { this.setAttribute('type', v); }
  get name() { return this.getAttribute('name') ?? ''; }
  set name(v) { this.setAttribute('name', v); }
  get title() { return this.getAttribute('title') ?? ''; }
  set title(v) { this.setAttribute('title', v); }
  get tabIndex() { return Number(this.getAttribute('tabindex') ?? -1); }
  set tabIndex(v) { this.setAttribute('tabindex', v); }
  get clientWidth() { return this._props.clientWidth ?? 800; }
  get clientHeight() { return this._props.clientHeight ?? 500; }
  get scrollHeight() { return this.clientHeight; }
  get options() { return this.querySelectorAll('option'); }

  get value() {
    if (this.localName === 'select') {
      const opts = this.querySelectorAll('option');
      const chosen = opts.find((o) => o.selected) ?? opts[0];
      return chosen ? chosen.value : '';
    }
    if (this.localName === 'option') return this.getAttribute('value') ?? this.textContent;
    if ('value' in this._props) return this._props.value;
    if (this.localName === 'textarea') return this.textContent;
    return this.getAttribute('value') ?? (this.type === 'checkbox' || this.type === 'radio' ? 'on' : '');
  }
  set value(v) {
    if (this.localName === 'select') {
      for (const o of this.querySelectorAll('option')) o.selected = o.value === String(v);
      return;
    }
    this._props.value = String(v);
  }

  getContext() {
    const ctx = canvasContext();
    ctx.canvas = this;
    return ctx;
  }

  click() {
    if (this.disabled) return;
    this.dispatchEvent(new Event('click', { bubbles: true }));
    const form = this.closest('form');
    if (form && this.localName === 'button' && this.type === 'submit') form.dispatchEvent(new Event('submit', { cancelable: true }));
  }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  showModal() { this.open = true; }
  show() { this.open = true; }
  close() {
    if (this.localName === 'dialog') {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    }
  }
  scrollIntoView() {}
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }; }

  closest(sel) {
    for (let n = this; n instanceof FakeElement; n = n.parentNode) if (matches(n, sel)) return n;
    return null;
  }
  matches(sel) { return matches(this, sel); }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (!(c instanceof FakeElement)) continue;
        if (matches(c, sel, this)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

for (const prop of BOOL_PROPS) {
  Object.defineProperty(FakeElement.prototype, prop, {
    get() { return prop in this._props ? this._props[prop] : this.hasAttribute(prop); },
    set(v) {
      // `hidden`/`disabled` reflect to the attribute (so selectors see them); `checked`/`selected`
      // are live state separate from the default the attribute holds, as in a browser.
      if (prop === 'checked' || prop === 'selected' || prop === 'open') this._props[prop] = !!v;
      else this.toggleAttribute(prop, !!v);
    },
    configurable: true,
  });
}

// ------------------------------------------------------------------ selectors

function parseCompound(s) {
  const c = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([~^$*]?=)"?([^"\]]*)"?)?\]|(\*)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) c.tag = m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4].toLowerCase(), op: m[5] ?? null, value: m[6] ?? null });
  }
  return c;
}

function matchCompound(el, c) {
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.op === '=' && v !== a.value) return false;
  }
  return true;
}

function matches(el, selector, scope = null) {
  return selector.split(',').some((alt) => {
    const parts = alt.trim().split(/\s+/).filter((p) => p && p !== '>').map(parseCompound);
    if (!parts.length || !matchCompound(el, parts.at(-1))) return false;
    let node = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (node instanceof FakeElement && node !== scope && !matchCompound(node, parts[i])) node = node.parentNode;
      if (!(node instanceof FakeElement) || node === scope) return false;
      node = node.parentNode;
    }
    return true;
  });
}

// ------------------------------------------------------------------ document

export class FakeDocument extends FakeNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.documentElement = new FakeElement(this, 'html');
    this.head = new FakeElement(this, 'head');
    this.body = new FakeElement(this, 'body');
    this.documentElement.append(this.head, this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body;
    this.title = '';
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createElementNS(ns, tag) { return new FakeElement(this, tag, ns); }
  createTextNode(text) { return new FakeText(this, text); }
  createDocumentFragment() { return new FakeElement(this, '#fragment'); }
  getElementById(id) { return this.documentElement.querySelector(`#${id}`); }
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
  querySelector(sel) { return this.documentElement.querySelector(sel); }
}

/** Parse the body of an HTML page into `doc.body` (index.html's subset: tags, attributes, text, comments). */
export function parseBodyInto(doc, html) {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const stack = [doc.body];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      while (stack.length > 1 && stack.at(-1).localName !== tag) stack.pop();
      if (stack.length > 1) stack.pop();
    } else if (m[2]) {
      const el = doc.createElement(m[2]);
      for (const a of m[3].matchAll(/([^\s=>]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], a[2] ?? '');
      stack.at(-1).appendChild(el);
      if (!VOID.has(el.localName)) stack.push(el);
    } else if (m[4] && m[4].trim()) {
      stack.at(-1).appendChild(doc.createTextNode(m[4].replace(/\s+/g, ' ')));
    }
  }
  return doc;
}

/**
 * Install the fake as the global browser environment. `bridge` becomes window.g9 (what the
 * preload exposes). Returns { document, window, restore }.
 */
export function installFakeDom({ bridge, html = null } = {}) {
  const document = new FakeDocument();
  if (html) parseBodyInto(document, html);
  const window = new EventTarget();
  Object.assign(window, { document, g9: bridge, devicePixelRatio: 1, innerWidth: 1100, innerHeight: 720 });
  const saved = {};
  const globals = {
    window,
    document,
    Node: FakeNode,
    Element: FakeElement,
    HTMLElement: FakeElement,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    createImageBitmap: async () => ({ width: 1280, height: 800, close() {} }),
    MediaRecorder: class { static isTypeSupported() { return true; } },
  };
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  return {
    document,
    window,
    restore() {
      for (const [k, d] of Object.entries(saved)) {
        if (d) Object.defineProperty(globalThis, k, d);
        else delete globalThis[k];
      }
    },
  };
}
