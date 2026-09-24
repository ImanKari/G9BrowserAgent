#!/usr/bin/env node
/**
 * The platform seam (ARCHITECTURE_V2 §3, rule R2), checked two ways.
 *
 * (a) SOURCE: nothing under extension/tools/, extension/humanize/ or the shared
 *     extension/lib files may reference `chrome.`, `browser.`,
 *     `globalThis.chrome`, `indexedDB`, `OffscreenCanvas`, `createImageBitmap`,
 *     `FileReader`, or import a Node built-in. Comments are ignored, and so is
 *     code that runs IN THE PAGE: string literals passed to
 *     evaluate/callOnNode/inWorld/callInWorld, or given as an `expression`,
 *     `functionDeclaration` or `source` property. A string preceded by a
 *     `/* page-side *\/` comment is page code too. The files that ARE the
 *     extension side of the seam are exempt: platform-extension.js,
 *     transport.js, and platform.js — whose single feature test is checked
 *     separately.
 *
 * (b) NODE SMOKE: in this process there is no `chrome`. Importing
 *     extension/tools/index.js must select platform-cdp, and a full
 *     runTool('browser_snapshot', {}) against a fake launched engine must work
 *     — the whole Engine 2 premise (decision D2) in one call. If a module owned
 *     by another package has not landed yet, the smoke part reports which one
 *     and SKIPS rather than failing (the integration stage re-runs it).
 *
 * Run: node setup/unit/seam.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = join(ROOT, 'extension');

/** Modules another package writes concurrently; until they land, the smoke parts skip. */
const OTHER_PACKAGE = [
  'extension/lib/world.js',
  'extension/lib/screencast.js',
  'extension/lib/pointer.js',
  'extension/lib/humanize.js',
  'extension/humanize/index.js',
];

// Part (c) runs in a child process of its own: it needs a `chrome` global,
// which must never exist in the process that runs part (b).
if (process.argv.includes('--extension-side')) {
  await extensionSide();
  process.exit(0);
}

async function test(name, fn) {
  try {
    const out = await fn();
    if (out && out.skipped) console.log(`  SKIP ${name} — ${out.skipped}`);
    else console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n${err?.stack ?? err}`);
    process.exit(1);
  }
}

// ======================================================= (a) the source check

const PAGE_CALLS = new Set(['evaluate', 'callOnNode', 'inWorld', 'callInWorld']);
const PAGE_KEYS = new Set(['expression', 'functionDeclaration', 'source']);
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events', 'fs', 'fs/promises', 'http',
  'http2', 'https', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'querystring', 'readline', 'stream',
  'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);
const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await',
]);

/** Forbidden in extension-agnostic CODE (comments and strings already blanked). */
const CODE_RULES = [
  { what: 'chrome.*', re: /(?<![\w$.])chrome(?:\?\.|\.)/g },
  { what: 'browser.*', re: /(?<![\w$.])browser(?:\?\.|\.)[A-Za-z_$]/g },
  { what: 'globalThis.chrome/browser', re: /\b(?:globalThis|self|window)(?:\?\.|\.)(?:chrome|browser)\b/g },
  { what: 'indexedDB', re: /(?<![\w$.])indexedDB\b(?!\s*:)/g },
  { what: 'OffscreenCanvas', re: /(?<![\w$.])OffscreenCanvas\b(?!\s*:)/g },
  { what: 'createImageBitmap', re: /(?<![\w$.])createImageBitmap\b(?!\s*:)/g },
  { what: 'FileReader', re: /(?<![\w$.])FileReader\b(?!\s*:)/g },
  { what: 'global browser API', re: /\b(?:globalThis|self|window)(?:\?\.|\.)(?:indexedDB|OffscreenCanvas|createImageBitmap|FileReader)\b/g },
];

/** Forbidden inside strings that do NOT run in the page (a string only matters if something executes it). */
const STRING_RULES = [
  { what: 'chrome.* in a string', re: /(?<![\w$.])(?:chrome|browser)\.(?:debugger|tabs|windows|cookies|storage|runtime|downloads|scripting|alarms|sidePanel|action|webRequest)\b/g },
  { what: 'globalThis.chrome in a string', re: /\bglobalThis(?:\?\.|\.)(?:chrome|browser)\b/g },
];

/**
 * A small JavaScript tokenizer: enough to tell code from comments, strings,
 * template text and regex literals, and to know which call or property a
 * string literal sits in. It does not need to parse JavaScript — only to never
 * mistake one of those four for another.
 */
export function scanSource(src) {
  const blank = src.split('');
  const strings = []; // { text, line, page, specifier }
  const stack = []; // contexts: { kind: 'paren'|'brace'|'bracket'|'tpl', page, key }
  const tokens = []; // significant tokens: { type, value }
  let i = 0;
  let line = 1;
  let markPage = false;

  const lineAt = (pos) => {
    let n = 1;
    for (let k = 0; k < pos; k++) if (src[k] === '\n') n++;
    return n;
  };
  const blankRange = (a, b) => {
    for (let k = a; k < b; k++) if (blank[k] !== '\n' && blank[k] !== '\r') blank[k] = ' ';
  };
  const prev = (n = 1) => tokens[tokens.length - n] ?? null;
  const inPage = () => stack.some((c) => c.page);
  const regexAllowed = () => {
    const p = prev();
    if (!p) return true;
    if (p.type === 'punct') return !/^[)\]}]$/.test(p.value);
    if (p.type === 'ident') return KEYWORDS_BEFORE_REGEX.has(p.value);
    return false;
  };
  const specifierContext = () => {
    const p1 = prev();
    const p2 = prev(2);
    if (p1?.type === 'ident' && (p1.value === 'from' || p1.value === 'import')) return true;
    return p1?.value === '(' && p2?.type === 'ident' && (p2.value === 'import' || p2.value === 'require');
  };
  const recordString = (text, start, page) => {
    strings.push({ text, line: lineAt(start), page: page || inPage(), specifier: specifierContext() ? text : null });
    tokens.push({ type: 'string', value: text });
  };

  function readQuoted(q) {
    const start = i;
    i++;
    let text = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') { text += src[i + 1]; i += 2; continue; }
      if (src[i] === '\n') break;
      text += src[i++];
    }
    i++;
    const page = markPage;
    markPage = false;
    blankRange(start + 1, i - 1);
    recordString(text, start, page);
  }

  /** Template text runs until the closing backtick or a `${`, whose code is scanned as code. */
  function readTemplateText(ctx) {
    let text = '';
    const start = i;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { text += src[i + 1]; i += 2; continue; }
      if (c === '`') {
        blankRange(start, i);
        i++;
        stack.pop();
        ctx.parts.push(text);
        strings.push({ text: ctx.parts.join('${…}'), line: ctx.line, page: ctx.page, specifier: null });
        tokens.push({ type: 'string', value: '`…`' });
        return;
      }
      if (c === '$' && src[i + 1] === '{') {
        blankRange(start, i);
        ctx.parts.push(text);
        i += 2;
        ctx.inExpr = true;
        ctx.depth = 0;
        tokens.push({ type: 'punct', value: '${' });
        return;
      }
      text += c;
      i++;
    }
  }

  while (i < src.length) {
    const top = stack[stack.length - 1];
    if (top?.kind === 'tpl' && !top.inExpr) {
      readTemplateText(top);
      continue;
    }
    const c = src[i];
    const d = src[i + 1];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    // comments
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      blankRange(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      if (/^\/\*\s*page-side\s*\*\/$/.test(src.slice(i, stop))) markPage = true;
      blankRange(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") { readQuoted(c); continue; }
    if (c === '`') {
      const page = markPage || inPage();
      markPage = false;
      stack.push({ kind: 'tpl', page, parts: [], line: lineAt(i), inExpr: false, depth: 0 });
      i++;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      const start = i;
      i++;
      let inClass = false;
      while (i < src.length) {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '\n') break;
        if (inClass) { if (r === ']') inClass = false; }
        else if (r === '[') inClass = true;
        else if (r === '/') break;
        i++;
      }
      i++;
      while (/[a-z]/i.test(src[i] ?? '')) i++;
      blankRange(start, i);
      tokens.push({ type: 'regex', value: '/…/' });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (/[\w$]/.test(src[j] ?? '')) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (/[\w.]/.test(src[j] ?? '')) j++;
      tokens.push({ type: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    // punctuation, with the context stack
    if (c === '(') {
      const callee = prev();
      stack.push({ kind: 'paren', page: callee?.type === 'ident' && PAGE_CALLS.has(callee.value) });
    } else if (c === '{') {
      if (top?.kind === 'tpl' && top.inExpr) top.depth++;
      else stack.push({ kind: 'brace', page: false });
    } else if (c === '[') {
      stack.push({ kind: 'bracket', page: false });
    } else if (c === ')' || c === ']') {
      if (stack.length && stack[stack.length - 1].kind !== 'tpl') stack.pop();
    } else if (c === '}') {
      if (top?.kind === 'tpl' && top.inExpr) {
        if (top.depth === 0) {
          top.inExpr = false;
          i++;
          continue;
        }
        top.depth--;
      } else if (stack.length) {
        stack.pop();
      }
    } else if (c === ':' && top?.kind === 'brace') {
      const key = prev();
      const before = prev(2);
      if ((key?.type === 'ident' || key?.type === 'string') && (before?.value === '{' || before?.value === ',')) {
        top.page = PAGE_KEYS.has(key.value);
      }
    } else if (c === ',' && top?.kind === 'brace') {
      top.page = false;
    }
    tokens.push({ type: 'punct', value: c });
    i++;
  }
  return { code: blank.join(''), strings };
}

function violationsIn(file, { exempt = false } = {}) {
  const src = readFileSync(file, 'utf8');
  const { code, strings } = scanSource(src);
  const found = [];
  if (!exempt) {
    for (const rule of CODE_RULES) {
      for (const m of code.matchAll(rule.re)) {
        const lineNo = code.slice(0, m.index).split('\n').length;
        found.push(`${relative(ROOT, file)}:${lineNo} ${rule.what} — ${src.split('\n')[lineNo - 1].trim().slice(0, 120)}`);
      }
    }
    for (const s of strings) {
      if (s.page) continue;
      for (const rule of STRING_RULES) {
        rule.re.lastIndex = 0;
        if (rule.re.test(s.text)) found.push(`${relative(ROOT, file)}:${s.line} ${rule.what} — "${s.text.slice(0, 80)}"`);
      }
    }
  }
  for (const s of strings) {
    if (!s.specifier) continue;
    const spec = s.specifier;
    if (spec.startsWith('node:') || NODE_BUILTINS.has(spec)) {
      found.push(`${relative(ROOT, file)}:${s.line} imports the Node built-in "${spec}"`);
    }
  }
  return found;
}

function jsFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (/\.m?js$/.test(name)) out.push(full);
  }
  return out;
}

/** The extension side of the seam: allowed to touch chrome.* by definition. */
const EXEMPT_LIB = new Set(['platform-extension.js', 'transport.js', 'platform.js']);

await test('tokenizer: comments, page-side strings and regexes are told apart from code', () => {
  const sample = [
    '// chrome.tabs.query in a comment',
    '/* indexedDB in a block comment */',
    "const a = evaluate(tabId, 'navigator.userAgent + chrome.runtime.id');",
    'const b = inWorld(tabId, `${JSON.stringify(x)} indexedDB.databases()`);',
    "const c = { expression: 'createImageBitmap(x)', other: 'fine' };",
    'const d = /chrome\\.tabs/g;',
    "const e = out.indexedDB;",
    "const f = { indexedDB: 1 };",
    'const g = /* page-side */ `OffscreenCanvas`;',
  ].join('\n');
  const { code, strings } = scanSource(sample);
  for (const rule of CODE_RULES) {
    rule.re.lastIndex = 0;
    assert.equal(rule.re.test(code), false, `false positive for ${rule.what}`);
  }
  assert.equal(strings.find((s) => s.text.includes('navigator')).page, true);
  assert.equal(strings.find((s) => s.text.includes('databases')).page, true);
  assert.equal(strings.find((s) => s.text.includes('createImageBitmap')).page, true);
  assert.equal(strings.find((s) => s.text === 'fine').page, false);
  assert.equal(strings.find((s) => s.text === 'OffscreenCanvas').page, true);

  const bad = scanSource("const t = chrome.tabs;\nconst u = globalThis.browser?.runtime;\nx(`${indexedDB.open()}`);\nimport fs from 'node:fs';");
  const hits = CODE_RULES.filter((rule) => { rule.re.lastIndex = 0; return rule.re.test(bad.code); }).map((r) => r.what);
  assert.ok(hits.includes('chrome.*'), 'code use of chrome.* is caught');
  assert.ok(hits.includes('globalThis.chrome/browser'), 'globalThis.browser is caught');
  assert.ok(hits.includes('indexedDB'), 'code inside ${} of a non-page template is code');
  assert.equal(bad.strings.find((s) => s.text === 'node:fs').specifier, 'node:fs', 'import specifiers are recognised');
});

await test('R2: tools/, humanize/ and shared lib/ files reference no browser-only or Node-only API', () => {
  const files = [
    ...jsFiles(join(EXT, 'tools')),
    ...jsFiles(join(EXT, 'humanize')),
    ...readdirSync(join(EXT, 'lib')).filter((n) => /\.js$/.test(n) && !EXEMPT_LIB.has(n)).map((n) => join(EXT, 'lib', n)),
  ];
  assert.ok(files.length >= 20, `expected the tool and lib files, found ${files.length}`);
  const found = files.flatMap((f) => violationsIn(f));
  assert.deepEqual(found, [], `R2 violations:\n${found.join('\n')}`);
});

await test('R2: platform.js touches chrome/browser only in its one feature test', () => {
  const src = readFileSync(join(EXT, 'lib', 'platform.js'), 'utf8');
  const { code } = scanSource(src);
  const lines = code.split('\n').filter((l) => /\b(?:chrome|browser)\b/.test(l));
  assert.equal(lines.length, 1, `expected exactly one feature-test line, got:\n${lines.join('\n')}`);
  assert.match(lines[0], /const hasChrome = !!\(globalThis\.chrome\?\.debugger \|\| globalThis\.browser\?\.debugger\);/);
  assert.match(src, /import \{ platform as extensionPlatform \} from '\.\/platform-extension\.js';/, 'static import of the extension side');
  assert.match(src, /import \{ platform as cdpPlatform \} from '\.\/platform-cdp\.js';/, 'static import of the CDP side');
  assert.doesNotMatch(code, /\bawait\b/, 'the selector is synchronous: no await at all');
});

await test('no top-level await anywhere under extension/ (MV3 service workers forbid it)', () => {
  const offenders = [];
  for (const file of jsFiles(EXT)) {
    const { code } = scanSource(readFileSync(file, 'utf8'));
    // Top level = brace depth 0 in blanked code.
    let depth = 0;
    const re = /[{}]|\bawait\b/g;
    for (const m of code.matchAll(re)) {
      if (m[0] === '{') depth++;
      else if (m[0] === '}') depth--;
      else if (depth === 0) offenders.push(`${relative(ROOT, file)}:${code.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(offenders, [], `top-level await:\n${offenders.join('\n')}`);
});

// ======================================================= (b) the Node smoke

/** A launched browser in miniature: one page, auto-attach, and a page that answers what a snapshot asks. */
class FakeEngine {
  constructor() {
    this.handlers = { event: new Set(), close: new Set() };
    this.sent = [];
    this.n = 0;
    this.targets = new Map();
    this.sessions = new Map();
    this.autoAttach = false;
    this.discover = false;
    this.add({ targetId: 'PAGE-1', url: 'https://shop.example.test/', title: 'Shop', browserContextId: 'DEFAULT' });
  }
  on(evt, fn) { this.handlers[evt].add(fn); }
  off(evt, fn) { this.handlers[evt].delete(fn); }
  emit(method, params, sessionId = null) { for (const fn of [...this.handlers.event]) fn(method, params, sessionId); }
  close() { for (const fn of [...this.handlers.close]) fn(); }
  add(t) { const target = { type: 'page', attached: false, ...t }; this.targets.set(target.targetId, target); return target; }
  info(t) { return { targetId: t.targetId, type: t.type, url: t.url, title: t.title ?? '', attached: t.attached, browserContextId: t.browserContextId }; }
  /**
   * What the engine's hidden image page would answer. "A" decodes to an image
   * split black|white down the middle, anything else to plain white; a 40x20
   * source unless a size was asked for. Encoding records the pixels it was given.
   */
  imagePage(params) {
    const fn = String(params.functionDeclaration ?? '');
    const args = (params.arguments ?? []).map((a) => a.value);
    if (fn.includes('createImageBitmap')) {
      const [b64, , opts] = args;
      const w = opts?.width ?? 40;
      const h = opts?.height ?? 20;
      const px = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = b64 === 'A' && x < w / 2 ? 0 : 255;
          px.set([v, v, v, 255], (y * w + x) * 4);
        }
      }
      return { result: { value: { width: w, height: h, sourceWidth: 40, sourceHeight: 20, rgba: Buffer.from(px).toString('base64') } } };
    }
    if (fn.includes('convertToBlob')) {
      this.encoded = { width: args[0], height: args[1], rgba: Buffer.from(args[2], 'base64') };
      return { result: { value: 'UE5HIQ==' } };
    }
    return null;
  }
  attach(t) {
    const sessionId = `S${++this.n}`;
    this.sessions.set(sessionId, t.targetId);
    t.attached = true;
    this.emit('Target.attachedToTarget', { sessionId, targetInfo: this.info(t), waitingForDebugger: false });
    return sessionId;
  }
  async send(method, params = {}, sessionId = null) {
    this.sent.push({ method, params, sessionId });
    const target = sessionId ? this.targets.get(this.sessions.get(sessionId)) : null;
    switch (method) {
      case 'Target.getBrowserContexts': return { browserContextIds: [], defaultBrowserContextId: 'DEFAULT' };
      case 'Target.createBrowserContext': return { browserContextId: `CTX${++this.n}` };
      case 'Target.setDiscoverTargets':
        this.discover = true;
        for (const t of this.targets.values()) this.emit('Target.targetCreated', { targetInfo: this.info(t) });
        return {};
      case 'Target.setAutoAttach':
        if (!sessionId) {
          this.autoAttach = true;
          for (const t of this.targets.values()) if (!t.attached) this.attach(t);
        }
        return {};
      case 'Target.createTarget': {
        const t = this.add({ targetId: `T${++this.n}`, url: params.url, browserContextId: params.browserContextId ?? 'DEFAULT' });
        if (this.discover) this.emit('Target.targetCreated', { targetInfo: this.info(t) });
        if (this.autoAttach) this.attach(t);
        return { targetId: t.targetId };
      }
      case 'Target.attachToTarget': return { sessionId: this.attach(this.targets.get(params.targetId)) };
      case 'Accessibility.getFullAXTree':
        return {
          nodes: [
            { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Shop' }, childIds: ['2', '3'] },
            { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Welcome to the shop' }, childIds: [], backendDOMNodeId: 11 },
            { nodeId: '3', parentId: '1', role: { value: 'button' }, name: { value: 'Buy now' }, childIds: [], backendDOMNodeId: 12 },
          ],
        };
      case 'DOM.getDocument': return { root: { nodeId: 1, backendNodeId: 1, documentURL: target?.url ?? '' } };
      case 'Page.getFrameTree': return { frameTree: { frame: { id: target?.targetId, loaderId: 'L1', url: target?.url, securityOrigin: 'https://shop.example.test' }, childFrames: [] } };
      case 'Page.createIsolatedWorld': return { executionContextId: 77 };
      case 'Runtime.evaluate':
        if (params.expression === 'globalThis') return { result: { type: 'object', objectId: 'G' } };
        if (String(params.expression).includes('document.readyState')) return { result: { type: 'string', value: 'complete' } };
        if (String(params.expression).includes('location.href')) return { result: { type: 'string', value: target?.url ?? '' } };
        return { result: { type: 'undefined' } };
      case 'Runtime.callFunctionOn':
        return this.imagePage(params) ?? { result: { type: 'undefined' } };
      case 'Storage.getCookies':
        return {
          cookies: [
            { name: 'sid', value: 's1', domain: 'shop.example.test', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: -1, session: true },
            { name: 'pref', value: 'p', domain: '.example.test', path: '/account', secure: false, httpOnly: false, expires: -1, session: true },
            { name: 'api', value: 'a', domain: 'api.shop.example.test', path: '/', secure: true, httpOnly: false, expires: -1, session: true },
            { name: 'elsewhere', value: `eyJhbGciOiJIUzI1NiJ9.${'x'.repeat(900)}.sig-end`, domain: 'other.test', path: '/', secure: false, httpOnly: false, expires: -1, session: true },
          ],
        };
      case 'Browser.setDownloadBehavior':
        this.downloadBehavior = params;
        return {};
      case 'Browser.getWindowForTarget':
        return { windowId: 1, bounds: { left: 0, top: 0, width: 1920, height: 1032, windowState: this.windowState ?? 'normal' } };
      default: return {};
    }
  }
}

/** Shared by the Node tests after the smoke; null when the smoke skipped. */
let smoke = null;
const needsSmoke = () => (smoke ? null : { skipped: 'the Node smoke above did not run' });

await test('Node smoke: no chrome here, tools/index.js runs browser_snapshot on a launched engine', async () => {
  const missing = OTHER_PACKAGE.filter((p) => !existsSync(join(ROOT, p)));
  if (missing.length) return { skipped: `not landed yet: ${missing.join(', ')} (integration re-runs this)` };

  delete globalThis.chrome;
  delete globalThis.browser;
  assert.equal(globalThis.chrome, undefined);

  let seam;
  let runtime;
  let cdpPlatform;
  try {
    seam = await import(pathToFileURL(join(EXT, 'lib', 'platform.js')).href);
    cdpPlatform = await import(pathToFileURL(join(EXT, 'lib', 'platform-cdp.js')).href);
    runtime = await import(pathToFileURL(join(EXT, 'tools', 'index.js')).href);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      return { skipped: `an import is missing: ${String(err.message).split('\n')[0]}` };
    }
    throw err;
  }
  assert.equal(seam.isExtension, false);
  assert.equal(seam.platform.name, 'cdp', 'platform.js selected platform-cdp');

  let handle = 500;
  cdpPlatform.configure({
    allocTabId: () => ++handle,
    version: '2.0.0',
    // The daemon's hook: file facts from disk. Here, facts about a pretend file.
    fileInfo: async (path) => ({ exists: true, size: 10, sha256: 'c0ffee'.padEnd(64, '0'), magicHex: '49442c6e', mime: 'text/csv', path }),
  });
  const engine = new FakeEngine();
  await cdpPlatform.registerEngine('smoke', engine);
  smoke = { runtime, cdpPlatform, engine };

  const snap = await runtime.runTool('browser_snapshot', {});
  const text = JSON.stringify(snap);
  assert.match(text, /Buy now/, 'the snapshot shows the button');
  assert.match(text, /e1/, 'and gives it a ref');

  const [tabId] = cdpPlatform.tabsOf('smoke');
  const pageSession = cdpPlatform.tabInfo(tabId).sessionId;
  assert.ok(engine.sent.some((s) => s.method === 'Accessibility.getFullAXTree' && s.sessionId === pageSession),
    'the AX tree was read on the tab\'s page session');
  assert.ok(engine.sent.some((s) => s.method === 'Runtime.enable' && s.sessionId === pageSession),
    'Runtime is enabled at the default (non-stealth) level');

  const status = await runtime.runTool('browser_status', {});
  assert.equal(status.engine, 'launched');
  assert.equal(status.version, '2.0.0');
  assert.equal(status.current?.tabId, tabId);
  assert.ok(!(status.warnings ?? []).some((w) => /minimized/.test(w)), 'a normal window: nothing to warn about');
  // P8 matrix, round 2: a minimized headed Engine 2 window reported "visible" but rendered ~1 frame
  // per 1.5 s (a humanized click took 89 s). browser_status reads the REAL window and says so.
  engine.windowState = 'minimized';
  const minimized = await runtime.runTool('browser_status', {});
  engine.windowState = 'normal';
  assert.ok((minimized.warnings ?? []).some((w) => /window is minimized/.test(w) && /one frame per/.test(w)), JSON.stringify(minimized.warnings));

  const listed = await runtime.runTool('browser_tabs', { action: 'list' });
  assert.equal(listed.tabs[0].tabId, tabId, 'tab rows are keyed tabId');
  assert.equal(listed.tabs[0].url, 'https://shop.example.test/', 'no redaction in v2');

  await assert.rejects(runtime.runTool('browser_tabs', { action: 'claim', tabId }), /handled by the G9 daemon/);
  await assert.rejects(runtime.runTool('browser_tabs', { action: 'pin', tabId }), /removed in v2/);
  await assert.rejects(runtime.runTool('browser_nope', {}), /Unknown tool/);

  assert.equal(runtime.isReadOnly('browser_snapshot', {}), true);
  assert.equal(runtime.isReadOnly('browser_console', { action: 'evaluate', expression: '1' }), false);
  assert.equal(runtime.isReadOnly('browser_network', { action: 'downloads' }), true);
  assert.equal(runtime.isReadOnly('browser_network', { action: 'watch_downloads' }), false);
  assert.equal(runtime.isReadOnly('browser_recording', { action: 'known_world' }), true);
  assert.equal(runtime.isReadOnly('browser_recording', { action: 'replay' }), false);
  assert.equal(runtime.isReadOnly('browser_tabs', {}), true);
  assert.equal(runtime.isReadOnly('browser_interact', { action: 'click' }), false);
  // A screenshot is a read only for the viewport: an element capture scrolls the page to the
  // element (wheel notches at the human levels) and a full-page capture resizes the viewport, so
  // both claim the tab and are queued (daemon/docs review, 2026-09-22).
  assert.equal(runtime.isReadOnly('browser_screenshot', {}), true);
  assert.equal(runtime.isReadOnly('browser_screenshot', { area: 'viewport' }), true);
  assert.equal(runtime.isReadOnly('browser_screenshot', { area: 'element', ref: 'e1' }), false);
  assert.equal(runtime.isReadOnly('browser_screenshot', { area: 'fullpage' }), false);
  assert.equal(runtime.holdsSlot('browser_screenshot', { area: 'element', ref: 'e1' }), true);
  assert.equal(runtime.holdsSlot('browser_screenshot', { area: 'viewport' }), false);

  // P8 bench, round 2: a wait held a maxParallel slot for its whole timeout (another agent's click
  // took 7.6 s instead of 67 ms). Waits stay MUTATING (ownership, halt, dialogs) but hold no slot.
  assert.equal(runtime.holdsSlot('browser_navigate', { action: 'wait', text: 'x' }), false);
  assert.equal(runtime.isReadOnly('browser_navigate', { action: 'wait', text: 'x' }), false, 'still mutating');
  assert.equal(runtime.holdsSlot('browser_network', { action: 'wait_download' }), false);
  assert.equal(runtime.holdsSlot('browser_tabs', { action: 'wait' }), false);
  assert.equal(runtime.holdsSlot('browser_navigate', { action: 'goto', url: 'https://x.test/' }), true);
  assert.equal(runtime.holdsSlot('browser_interact', { action: 'click' }), true);
  assert.equal(runtime.holdsSlot('browser_network', { action: 'watch_downloads' }), true);
  assert.equal(runtime.holdsSlot('browser_snapshot', {}), false, 'reads never did');

  // Stealth: a tab in a stealth context never gets Runtime.enable (rule R4),
  // and the console read says why it is empty instead of looking complete.
  const ctx = (await engine.send('Target.createBrowserContext', {})).browserContextId;
  cdpPlatform.registerContext('smoke', ctx, { stealth: 'stealth', humanize: 'stealth' });
  const stealthTab = await cdpPlatform.createTab('smoke', ctx, 'https://shop.example.test/quiet');
  const console1 = await runtime.runTool('browser_console', { tabId: stealthTab.id });
  assert.equal(console1.unavailable, 'Runtime domain disabled by stealth level');
  const stealthSession = cdpPlatform.tabInfo(stealthTab.id).sessionId;
  assert.ok(!engine.sent.some((s) => s.method === 'Runtime.enable' && s.sessionId === stealthSession),
    'Runtime.enable never sent to a stealth tab');

  // F4: status about a given tab — its row and its health, the engine's own current tab aside,
  // and the host's connection() hook told which tab (the daemon names that tab's engine).
  const hookSaw = [];
  runtime.setHooks({ connection: (arg) => { hookSaw.push(arg); return { hooked: true }; } });
  try {
    const about = await runtime.runTool('browser_status', { tabId: stealthTab.id });
    assert.equal(about.current.tabId, stealthTab.id, 'current is the asked tab');
    assert.equal(about.health.console, 'Runtime domain disabled by stealth level', 'health is the asked tab\'s own');
    assert.equal(about.engineCurrent?.tabId, tabId, 'the engine\'s own current tab is named apart');
    assert.equal(about.hooked, true);
    assert.deepEqual(hookSaw.at(-1), { tabId: stealthTab.id });
    const own = await runtime.runTool('browser_status', {});
    assert.equal(own.current.tabId, tabId);
    assert.equal(own.engineCurrent, undefined, 'no engineCurrent when nothing else was asked');
    const missing = await runtime.runTool('browser_status', { tabId: 987654 });
    assert.equal(missing.current, null, 'a tab that does not exist is never replaced by another');
    assert.match(missing.targetError, /does not exist/);
    assert.equal(missing.health, null);
  } finally {
    runtime.setHooks({ connection: null });
  }
  return undefined;
});

await test('Node: store.js keeps attachments and frames in platform.blobs, base64 without FileReader', async () => {
  if (needsSmoke()) return needsSmoke();
  const store = await import(pathToFileURL(join(EXT, 'lib', 'store.js')).href);
  const issue = await store.saveIssue({ title: 'Checkout total is wrong' });
  const att = await store.putAttachment({ owner: issue.id, name: 'note.txt', mime: 'text/plain', bytes: new TextEncoder().encode('hello') });
  assert.equal(att.size, 5);
  const back = await store.getAttachment(att.id);
  assert.equal(back.dataBase64, Buffer.from('hello').toString('base64'));
  const listed = await store.listAttachments(issue.id);
  assert.equal(listed.length, 1);
  assert.equal('blob' in listed[0], false, 'listing never carries bytes');
  assert.equal((await store.getIssue(issue.id)).attachments.length, 1);

  await store.putVideoFrame({ sessionId: 'v1', seq: 1, at: 40, dataBase64: Buffer.from('jpg-2').toString('base64'), pointer: { x: 3, y: 4, buttons: 0 } });
  await store.putVideoFrame({ sessionId: 'v1', seq: 0, at: 0, dataBase64: Buffer.from('jpg-1').toString('base64') });
  const frames = await store.listVideoFrames('v1');
  assert.deepEqual(frames.map((f) => f.at), [0, 40], 'ordered by seq');
  assert.deepEqual(frames[1].pointer, { x: 3, y: 4, buttons: 0 }, 'the cursor sample rides with its frame');
  assert.equal(Buffer.from(frames[0].data, 'base64').toString(), 'jpg-1');
  assert.equal(await store.deleteVideoFrames('v1'), 2);

  const usage = await store.usage();
  assert.equal(usage.attachments, 1);
  assert.equal(usage.attachmentBytes, 5);
  const removed = await store.deleteIssue(issue.id);
  assert.equal(removed.attachmentsRemoved, 1, 'an issue takes its attachments with it');
  return undefined;
});

await test('Node: visual.js fingerprints, structure maps and diff images through platform.image', async () => {
  if (needsSmoke()) return needsSmoke();
  const visual = await import(pathToFileURL(join(EXT, 'lib', 'visual.js')).href);
  const a = await visual.captureVisual('A');
  const b = await visual.captureVisual('B');
  assert.equal(a.fingerprint.algorithm, 'luma-32x32-v1');
  assert.equal(a.fingerprint.values.length, 1024);
  assert.equal(a.structure.edges.length, 4096);
  assert.equal(a.structure.sourceWidth, 40, 'source size reported by the decoder');
  assert.ok(a.structure.edges.some((e) => e === 1), 'the black|white split is an edge');
  assert.ok(b.structure.edges.every((e) => e === 0), 'plain white has no edges');
  const cmp = visual.compareVisual(a, b, { mode: 'layout' });
  assert.equal(cmp.changedCells.length, 64, 'exactly the one column where the edge is');
  assert.equal(cmp.pass, true, 'one edge column (1.6%) is under the default 3% layout threshold');
  assert.equal(visual.compareVisual(a, b, { mode: 'layout', threshold: 0.01 }).pass, false);
  const strict = visual.compareVisual(a, b, { mode: 'strict' });
  assert.ok(strict.difference > 0.3);

  const png = await visual.diffImage('B', cmp);
  assert.equal(png, 'UE5HIQ==', 'encoded by the utility page');
  const enc = smoke.engine.encoded;
  assert.equal(enc.width, 40);
  assert.equal(enc.height, 20);
  const cell = cmp.changedCells[0];
  const x = Math.floor(((cell % 64) + 0.5) * (40 / 64));
  const y = Math.floor((Math.floor(cell / 64) + 0.5) * (20 / 64));
  const i = ((y * 40) + x) * 4;
  assert.ok(enc.rgba[i] > enc.rgba[i + 2], 'a changed cell is painted red');
  assert.equal(await visual.diffImage('B', { changedCells: [] }), null, 'no difference, no image');
  return undefined;
});

await test('Node: downloads through runTool — watch on the browser session, exact attribution, disk facts', async () => {
  if (needsSmoke()) return needsSmoke();
  const { runtime, cdpPlatform, engine } = smoke;
  const ctx = (await engine.send('Target.createBrowserContext', {})).browserContextId;
  cdpPlatform.registerContext('smoke', ctx, { downloadPath: '/tmp/g9-smoke/downloads', humanize: 'off' });
  const tab = await cdpPlatform.createTab('smoke', ctx, 'https://shop.example.test/export');

  await assert.rejects(runtime.runTool('browser_network', { action: 'wait_download', tabId: tab.id, timeoutMs: 200 }), /not being watched/);
  const watching = await runtime.runTool('browser_network', { action: 'watch_downloads', tabId: tab.id });
  assert.equal(watching.watching, true);
  assert.equal(watching.mode, 'cdp');
  assert.equal(watching.downloadPath, '/tmp/g9-smoke/downloads');
  assert.equal(engine.downloadBehavior.behavior, 'allowAndName');
  assert.equal(engine.downloadBehavior.browserContextId, ctx);

  const frameId = cdpPlatform.tabInfo(tab.id).targetId;
  engine.emit('Browser.downloadWillBegin', { frameId, guid: 'G-1', url: 'https://shop.example.test/report.csv', suggestedFilename: 'report.csv' });
  engine.emit('Browser.downloadProgress', { guid: 'G-1', totalBytes: 10, receivedBytes: 10, state: 'completed' });
  const done = await runtime.runTool('browser_network', { action: 'wait_download', tabId: tab.id, contains: 'report', timeoutMs: 3000 });
  assert.equal(done.state, 'complete');
  assert.equal(done.attribution, 'exact');
  assert.equal(done.path, '/tmp/g9-smoke/downloads/G-1');
  assert.equal(done.empty, false);
  assert.equal(done.file.verified, true);
  assert.equal(done.file.source, 'disk');
  assert.equal(done.file.size, 10);

  const list = await runtime.runTool('browser_network', { action: 'downloads', tabId: tab.id });
  assert.equal(list.completed, 1);
  assert.equal(list.downloads[0].file.sha256.length, 64);

  engine.emit('Browser.downloadWillBegin', { frameId, guid: 'G-2', url: 'https://shop.example.test/big.zip', suggestedFilename: 'big.zip' });
  engine.emit('Browser.downloadProgress', { guid: 'G-2', totalBytes: 99, receivedBytes: 3, state: 'canceled' });
  await assert.rejects(runtime.runTool('browser_network', { action: 'wait_download', tabId: tab.id, contains: 'big', timeoutMs: 3000 }), /canceled/);

  const stopped = await runtime.runTool('browser_network', { action: 'stop_downloads', tabId: tab.id });
  assert.equal(stopped.watching, false);
  assert.equal(stopped.seen, 2);
  return undefined;
});

await test('Node: re-watch starts a fresh window; unwatched-tab downloads are listed aside; a missing file is said', async () => {
  if (needsSmoke()) return needsSmoke();
  const { runtime, cdpPlatform, engine } = smoke;
  const ctx = (await engine.send('Target.createBrowserContext', {})).browserContextId;
  cdpPlatform.registerContext('smoke', ctx, { downloadPath: '/tmp/g9-smoke/dl2', humanize: 'off' });
  const tab = await cdpPlatform.createTab('smoke', ctx, 'https://shop.example.test/export2');
  const other = await cdpPlatform.createTab('smoke', ctx, 'https://shop.example.test/other');
  const frameOf = (t) => cdpPlatform.tabInfo(t.id).targetId;

  await runtime.runTool('browser_network', { action: 'watch_downloads', tabId: tab.id });
  const emitted = [];
  runtime.setHooks({ emit: (event, data) => { if (event === 'download') emitted.push(data.state); } });
  try {
    engine.emit('Browser.downloadWillBegin', { frameId: frameOf(tab), guid: 'R-1', url: 'https://shop.example.test/report.csv', suggestedFilename: 'report.csv' });
    for (let i = 1; i < 6; i++) engine.emit('Browser.downloadProgress', { guid: 'R-1', totalBytes: 10, receivedBytes: i, state: 'inProgress' });
    engine.emit('Browser.downloadProgress', { guid: 'R-1', totalBytes: 10, receivedBytes: 10, state: 'completed' });
  } finally {
    runtime.setHooks({ emit: null });
  }
  assert.deepEqual(emitted, ['in_progress', 'complete'], 'the host hears the start and the end, not every progress tick');
  assert.equal((await runtime.runTool('browser_network', { action: 'wait_download', tabId: tab.id, contains: 'report', timeoutMs: 3000 })).id, 'R-1');

  // The second export of a flow: watch again BEFORE clicking. The first file
  // must not answer the second wait.
  await runtime.runTool('browser_network', { action: 'watch_downloads', tabId: tab.id });
  await assert.rejects(
    runtime.runTool('browser_network', { action: 'wait_download', tabId: tab.id, contains: 'report', timeoutMs: 300 }),
    /No completed download matching "report"/,
  );

  // A download from a tab nobody watches is listed aside, with its tab, never claimed.
  engine.emit('Browser.downloadWillBegin', { frameId: frameOf(other), guid: 'O-1', url: 'https://shop.example.test/o.bin', suggestedFilename: 'o.bin' });
  engine.emit('Browser.downloadProgress', { guid: 'O-1', totalBytes: 1, receivedBytes: 1, state: 'completed' });
  const listed = await (async () => {
    for (let i = 0; i < 50; i++) {
      const l = await runtime.runTool('browser_network', { action: 'downloads', tabId: tab.id });
      if (l.unattributed?.length) return l;
      await new Promise((r) => setTimeout(r, 20));
    }
    return runtime.runTool('browser_network', { action: 'downloads', tabId: tab.id });
  })();
  assert.equal(listed.downloads.length, 0, 'not claimed for the watched tab');
  assert.equal(listed.unattributed[0].id, 'O-1');
  assert.equal(listed.unattributed[0].tabId, other.id, 'the tab it came from is named');

  // Completed in the browser, absent on disk: says so; never "empty", never cached.
  let exists = false;
  cdpPlatform.configure({
    fileInfo: async (path) => (exists
      ? { exists: true, size: 7, sha256: 'd'.repeat(64), magicHex: '00', mime: 'text/plain', path }
      : { exists: false, size: 0, sha256: null, magicHex: null, mime: null }),
  });
  try {
    engine.emit('Browser.downloadWillBegin', { frameId: frameOf(tab), guid: 'M-1', url: 'https://shop.example.test/gone.txt', suggestedFilename: 'gone.txt' });
    engine.emit('Browser.downloadProgress', { guid: 'M-1', totalBytes: 7, receivedBytes: 7, state: 'completed' });
    const gone = await runtime.runTool('browser_network', { action: 'wait_download', tabId: tab.id, contains: 'gone', timeoutMs: 500 });
    assert.equal(gone.state, 'complete');
    assert.equal(gone.missing, true);
    assert.equal(gone.empty, false, 'a missing file is not an empty one');
    assert.match(gone.note, /not on disk/);
    exists = true;
    const again = await runtime.runTool('browser_network', { action: 'downloads', tabId: tab.id });
    const row = again.downloads.find((d) => d.id === 'M-1');
    assert.equal(row.missing, undefined, 'the negative check was not cached; the file is there now');
    assert.equal(row.file.size, 7);
  } finally {
    cdpPlatform.configure({
      fileInfo: async (path) => ({ exists: true, size: 10, sha256: 'c0ffee'.padEnd(64, '0'), magicHex: '49442c6e', mime: 'text/csv', path }),
    });
  }
  await runtime.runTool('browser_network', { action: 'stop_downloads', tabId: tab.id });
  return undefined;
});

await test('Node: paused requests are answered while Stop is on; rules, pins, frames and dialogs hold under parallel events', async () => {
  if (needsSmoke()) return needsSmoke();
  const { runtime, cdpPlatform, engine } = smoke;
  const events = await import(pathToFileURL(join(EXT, 'tools', 'events.js')).href);
  const state = await import(pathToFileURL(join(EXT, 'lib', 'state.js')).href);
  const frames = await import(pathToFileURL(join(EXT, 'lib', 'frames.js')).href);
  const cdp = await import(pathToFileURL(join(EXT, 'lib', 'cdp.js')).href);
  const off = cdpPlatform.platform.debugger.onEvent(events.onCdpEvent);
  const until = async (fn, what, ms = 3000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    const tab = await cdpPlatform.createTab('smoke', null, 'https://shop.example.test/net');
    const page = cdpPlatform.tabInfo(tab.id).sessionId;
    const answers = (id) => engine.sent.filter((s) => s.params?.requestId === id && /^Fetch\.(fulfill|continue|fail)Request$/.test(s.method));
    const pause = (requestId, url, method = 'GET') => engine.emit('Fetch.requestPaused', { requestId, request: { url, method } }, page);

    // A times:1 rule and two parallel requests: it fires ONCE.
    await runtime.runTool('browser_network', { tabId: tab.id, action: 'intercept', rules: [{ match: '/api/save', status: 500, times: 1 }] });
    pause('P1', 'https://shop.example.test/api/save', 'POST');
    pause('P2', 'https://shop.example.test/api/save', 'POST');
    await until(() => answers('P1').length && answers('P2').length, 'both pauses answered');
    assert.deepEqual([answers('P1')[0].method, answers('P2')[0].method].sort(), ['Fetch.continueRequest', 'Fetch.fulfillRequest'],
      'a times:1 rule fails the first request, not every parallel one');
    assert.equal((await runtime.runTool('browser_network', { tabId: tab.id, action: 'intercept_status' })).rules[0].fired, 1);

    // Stop is on: the page is still answered, never frozen.
    await state.setState({ halted: true });
    try {
      pause('P3', 'https://shop.example.test/api/other');
      await until(() => answers('P3').length, 'a pause answered while halted');
      assert.equal(answers('P3')[0].method, 'Fetch.continueRequest');
    } finally {
      await state.setState({ halted: false });
    }
    await runtime.runTool('browser_network', { tabId: tab.id, action: 'clear_intercept' });

    // A pinned HAR with two recorded pages and two parallel requests: one each.
    const entry = (n) => ({
      request: { method: 'GET', url: `https://shop.example.test/api/page?n=${n}` },
      response: { status: 200, headers: [], content: { mimeType: 'application/json', text: `{"page":${n}}` } },
    });
    await runtime.runTool('browser_network', { tabId: tab.id, action: 'pin', har: { log: { entries: [entry(1), entry(2)] } } });
    pause('P4', 'https://shop.example.test/api/page?n=1');
    pause('P5', 'https://shop.example.test/api/page?n=1');
    await until(() => answers('P4').length && answers('P5').length, 'both pinned pauses answered');
    const bodies = ['P4', 'P5'].map((id) => Buffer.from(answers(id)[0].params.body, 'base64').toString()).sort();
    assert.deepEqual(bodies, ['{"page":1}', '{"page":2}'], 'each parallel request got its own recorded response');
    await until(async () => (await runtime.runTool('browser_network', { tabId: tab.id, action: 'pin_status' })).served === 2, 'served counted');
    // Rules still set while pinned survive the unpin: Fetch stays on for them.
    await runtime.runTool('browser_network', { tabId: tab.id, action: 'intercept', rules: [{ match: '/api/x', status: 503 }] });
    const disablesBefore = engine.sent.filter((s) => s.method === 'Fetch.disable').length;
    const unpinned = await runtime.runTool('browser_network', { tabId: tab.id, action: 'unpin' });
    assert.equal(unpinned.served, 2);
    assert.equal(engine.sent.filter((s) => s.method === 'Fetch.disable').length, disablesBefore, 'unpin keeps Fetch on for the rules');
    assert.equal((await runtime.runTool('browser_network', { tabId: tab.id, action: 'pin_status' })).pinned, false);
    pause('P6', 'https://shop.example.test/api/x');
    await until(() => answers('P6').length, 'rule still applies after unpin');
    assert.equal(answers('P6')[0].params.responseCode, 503);
    await runtime.runTool('browser_network', { tabId: tab.id, action: 'clear_intercept' });

    // Two cross-origin frames attaching in one burst: both are in the table.
    engine.emit('Target.attachedToTarget', { sessionId: 'IF-1', targetInfo: { targetId: 'IFR-1', type: 'iframe', url: 'https://pay.test/' } }, page);
    engine.emit('Target.attachedToTarget', { sessionId: 'IF-2', targetInfo: { targetId: 'IFR-2', type: 'iframe', url: 'https://map.test/' } }, page);
    const both = await until(async () => {
      const list = await frames.list(tab.id);
      return list.length === 2 ? list : null;
    }, 'both frames recorded');
    assert.deepEqual(both.map((f) => f.sessionId).sort(), ['IF-1', 'IF-2']);

    // A dialog blocks its own tab's calls — but closing that tab stays possible.
    const dlg = await cdpPlatform.createTab('smoke', null, 'https://shop.example.test/alert');
    engine.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Hi' }, cdpPlatform.tabInfo(dlg.id).sessionId);
    await until(async () => (await state.getState()).dialogOpen?.tabId === dlg.id, 'dialog recorded');
    await assert.rejects(runtime.runTool('browser_snapshot', { tabId: dlg.id }), /blocked by a JavaScript alert dialog/);
    assert.deepEqual(await runtime.runTool('browser_tabs', { action: 'close', tabId: dlg.id }), { closed: dlg.id });
    await events.onTabRemoved(dlg.id); // what the host wires to tabs.onRemoved
    assert.equal((await state.getState()).dialogOpen, null, 'a closed tab takes its dialog along');

    // Two tabs, two alerts at once: handling one keeps the other blocked.
    const t1 = await cdpPlatform.createTab('smoke', null, 'https://shop.example.test/a1');
    const t2 = await cdpPlatform.createTab('smoke', null, 'https://shop.example.test/a2');
    engine.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'one' }, cdpPlatform.tabInfo(t1.id).sessionId);
    engine.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'two' }, cdpPlatform.tabInfo(t2.id).sessionId);
    await until(async () => Object.keys((await state.getState()).dialogs).length === 2, 'both dialogs recorded');
    assert.equal((await runtime.runTool('browser_status', {})).dialogs.length, 2, 'status lists every open dialog');
    await runtime.runTool('browser_dialog', { tabId: t2.id, accept: true });
    await assert.rejects(runtime.runTool('browser_snapshot', { tabId: t1.id }), /alert dialog: "one"/,
      'the other tab is still blocked after one dialog was handled');
    assert.equal((await state.getState()).dialogOpen?.tabId, t1.id, 'the panel now shows the one still open');
    engine.emit('Page.javascriptDialogClosed', { result: true }, cdpPlatform.tabInfo(t1.id).sessionId);
    await until(async () => {
      const s = await state.getState();
      return !Object.keys(s.dialogs).length && s.dialogOpen === null;
    }, 'every dialog cleared');
    assert.match(JSON.stringify(await runtime.runTool('browser_snapshot', { tabId: t1.id })), /Buy now/);

    // A detach forgets the frames and what ensureDomain enabled; the next use re-enables.
    const enables = () => engine.sent.filter((s) => s.method === 'Accessibility.enable' && s.sessionId === cdpPlatform.tabInfo(tab.id).sessionId).length;
    await cdp.ensureDomain(tab.id, 'Accessibility');
    await cdp.ensureDomain(tab.id, 'Accessibility');
    assert.equal(enables(), 1, 'enabled once while the session lives');
    await events.onDetach({ tabId: tab.id }, 'target_closed');
    assert.deepEqual(await frames.list(tab.id), [], 'dead child sessions are not kept');
    await cdp.ensureDomain(tab.id, 'Accessibility');
    assert.equal(enables(), 2, 'enabled again after the detach');
  } finally {
    if (typeof off === 'function') off();
  }
  return undefined;
});

await test('Node: inspect reads a cross-origin frame\'s node on that frame\'s session', async () => {
  if (needsSmoke()) return needsSmoke();
  const { runtime, cdpPlatform, engine } = smoke;
  const refs = await import(pathToFileURL(join(EXT, 'lib', 'refs.js')).href);
  const tab = await cdpPlatform.createTab('smoke', null, 'https://shop.example.test/checkout');
  await refs.saveRefs(tab.id, {
    url: 'https://shop.example.test/checkout',
    entries: [['e9', { backendNodeId: 99, sessionId: 'PAY-1', role: 'button', name: 'Pay' }]],
  });
  engine.sent.length = 0;
  const out = await runtime.runTool('browser_inspect', { what: 'dom', ref: 'e9', tabId: tab.id });
  assert.equal(out.ref, 'e9');
  const call = engine.sent.find((s) => s.method === 'DOM.getOuterHTML');
  assert.equal(call.sessionId, 'PAY-1', 'the page session does not know a node that lives in the payment frame');
  assert.equal(call.params.backendNodeId, 99);
  return undefined;
});

await test("Node: another agent's snapshots never age out this agent's refs (live round 4)", async () => {
  if (needsSmoke()) return needsSmoke();
  const { runtime, cdpPlatform } = smoke;
  const refs = await import(pathToFileURL(join(EXT, 'lib', 'refs.js')).href);
  const A = { agentId: 'agent-A', name: 'A' };
  const B = { agentId: 'agent-B', name: 'B' };
  const tab = await cdpPlatform.createTab('smoke', null, 'https://shop.example.test/refs');
  const mine = await runtime.runTool('browser_snapshot', { tabId: tab.id }, A);
  const ref = Object.keys((await refs.getRefs(tab.id)).map)[0];
  assert.ok(ref, 'the snapshot handed out a ref');
  assert.equal((await refs.getRefs(tab.id)).by, A.agentId, 'the table records who took it');
  assert.ok(mine.generation > 0);

  // B reads the same tab the way a watcher does: far more than KEEP_GENERATIONS times.
  for (let i = 0; i < refs.KEEP_GENERATIONS + 3; i++) await runtime.runTool('browser_snapshot', { tabId: tab.id }, B);
  const still = await runtime.runTool('browser_inspect', { what: 'dom', ref, tabId: tab.id });
  assert.equal(still.ref, ref, "A's ref survives B's reads");

  // A's own newer snapshots still retire it, exactly as documented.
  for (let i = 0; i < refs.KEEP_GENERATIONS; i++) await runtime.runTool('browser_snapshot', { tabId: tab.id }, A);
  await assert.rejects(runtime.runTool('browser_inspect', { what: 'dom', ref, tabId: tab.id }),
    /Unknown element ref/, 'the fifth snapshot of your own retires your first');
  return undefined;
});

await test('Node: the ref table is capped, so a crowd of agents cannot grow it without bound', async () => {
  if (needsSmoke()) return needsSmoke();
  const refs = await import(pathToFileURL(join(EXT, 'lib', 'refs.js')).href);
  const tabId = 90210;
  for (let i = 0; i < 40; i++) {
    await refs.saveRefs(tabId, {
      url: 'https://shop.example.test/cap',
      entries: [[`e${i + 1}`, { backendNodeId: 1000 + i, role: 'button', name: `n${i}` }]],
      by: `agent-${i % 8}`,
    });
  }
  const table = await refs.getRefs(tabId);
  assert.equal(1 + table.history.length, refs.MAX_GENERATIONS, 'never more than MAX_GENERATIONS kept');
  const perOwner = new Map();
  for (const g of [{ by: table.by }, ...table.history]) perOwner.set(g.by, (perOwner.get(g.by) ?? 0) + 1);
  for (const [who, n] of perOwner) assert.ok(n <= refs.KEEP_GENERATIONS, `${who} keeps at most KEEP_GENERATIONS (${n})`);
  return undefined;
});

await test('Node: goto waits a human-scale idle after load at "human", none at "off", Stop cuts it short', async () => {
  if (needsSmoke()) return needsSmoke();
  const { runtime, cdpPlatform, engine } = smoke;
  const state = await import(pathToFileURL(join(EXT, 'lib', 'state.js')).href);
  const human = await cdpPlatform.createTab('smoke', null, 'https://shop.example.test/a');
  const t0 = Date.now();
  const went = await runtime.runTool('browser_navigate', { tabId: human.id, url: 'https://shop.example.test/b', seed: 7 });
  assert.equal(went.readyState, 'complete');
  assert.ok(went.humanIdleMs >= 600 && went.humanIdleMs <= 1500, `idle ${went.humanIdleMs}ms is the profile's afterNavigationMs`);
  assert.ok(Date.now() - t0 >= went.humanIdleMs - 20, 'and it was actually waited');
  assert.equal(went.seed, 7, 'seeded, so a rerun waits the same');

  const ctx = (await engine.send('Target.createBrowserContext', {})).browserContextId;
  cdpPlatform.registerContext('smoke', ctx, { humanize: 'off' });
  const direct = await cdpPlatform.createTab('smoke', ctx, 'https://shop.example.test/c');
  const fast = await runtime.runTool('browser_navigate', { tabId: direct.id, url: 'https://shop.example.test/d' });
  assert.equal('humanIdleMs' in fast, false, 'level off returns at load, as v1 did');

  const pending = runtime.runTool('browser_navigate', { tabId: human.id, url: 'https://shop.example.test/e' });
  await new Promise((r) => setTimeout(r, 150));
  await state.setState({ halted: true });
  const cut = await pending;
  await state.setState({ halted: false });
  assert.equal(cut.humanIdleInterrupted, true);
  assert.ok(cut.humanIdleMs < 600);
  return undefined;
});

await test('Node: handoff_export, unscoped cookies, and popout refused on a launched engine', async () => {
  if (needsSmoke()) return needsSmoke();
  const { runtime, cdpPlatform } = smoke;
  const [tabId] = cdpPlatform.tabsOf('smoke');
  const exported = await runtime.runTool('browser_tabs', { action: 'handoff_export', tabId });
  assert.equal(exported.url, 'https://shop.example.test/');
  assert.equal(exported.origin, 'https://shop.example.test');
  assert.deepEqual(exported.cookies.map((c) => c.name).sort(), ['pref', 'sid'],
    'the host\'s own cookies and parent-domain cookies (all paths); not a sibling host\'s, not another site\'s');
  assert.ok(Array.isArray(exported.localStorage) && Array.isArray(exported.sessionStorage));

  const cookies = await runtime.runTool('browser_inspect', { what: 'cookies', tabId, url: 'https://other.test/' });
  assert.equal(cookies.cookies[0].name, 'elsewhere', 'any domain, no mode boundary');
  assert.equal(cookies.cookies[0].value, `eyJhbGciOiJIUzI1NiJ9.${'x'.repeat(900)}.sig-end`, 'a JWT-sized value comes back whole (it was cut to 77 characters + "…")');

  await assert.rejects(runtime.runTool('browser_tabs', { action: 'popout', tabId }), /launched engines have no windows/);
  return undefined;
});

// ================================================ (c) the extension side

await test('extension side (child process, stubbed chrome): sw.js boots on platform-extension', async () => {
  const missing = OTHER_PACKAGE.filter((p) => !existsSync(join(ROOT, p)));
  if (missing.length) return { skipped: `not landed yet: ${missing.join(', ')} (integration re-runs this)` };
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--extension-side'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const out = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  if (child.status !== 0) throw new Error(`child failed (status ${child.status}):\n${out}`);
  const skipped = /^SKIP (.*)$/m.exec(out);
  if (skipped) return { skipped: skipped[1] };
  for (const line of out.split('\n').filter((l) => l.startsWith('    ok '))) console.log(`    ${line.trim()}`);
  assert.match(out, /EXTENSION-SIDE OK/);
  return undefined;
});

console.log('\nseam: done');
process.exit(0);

// ------------------------------------------------------------------ the child

/**
 * Runs in its own process. Stubs `chrome` (in memory), `fetch` (answers the
 * dev-override files and /health as a g9d would) and `WebSocket` (a fake the
 * test drives), then imports sw.js exactly as the browser would. Nothing here
 * can reach a real port: the stubs are installed before any extension module
 * is evaluated, and the configured daemon port is a random 18000-18999 one.
 */
async function extensionSide() {
  const PORT = 18000 + Math.floor(Math.random() * 1000);
  const ok = (msg) => console.log(`    ok ${msg}`);
  const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(fn, what, ms = 3000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await tick(10);
    }
  }

  const makeEvent = () => {
    const fns = new Set();
    return { addListener: (f) => fns.add(f), removeListener: (f) => fns.delete(f), hasListener: (f) => fns.has(f), fire: (...a) => [...fns].map((f) => f(...a)) };
  };
  const makeArea = () => {
    const data = new Map();
    const clone = (v) => structuredClone(v);
    return {
      data,
      async get(keys) {
        if (keys == null) return Object.fromEntries([...data].map(([k, v]) => [k, clone(v)]));
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const k of list) if (data.has(k)) out[k] = clone(data.get(k));
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, clone(v)); },
      async remove(keys) { for (const k of [].concat(keys)) data.delete(k); },
      async getKeys() { return [...data.keys()]; },
    };
  };

  const calls = {
    setTitle: [], created: [], updated: [], reloaded: [], removed: [], attached: [], commands: [], runtimeReload: 0,
    sidePanel: 0, alarms: [], windowUpdates: [], windowsCreated: [], windowCreateAttempts: [], rejectWindowCreates: 0,
  };
  const dlItems = new Map();
  const tabs = [
    { id: 11, url: 'https://shop.example.test/', title: 'Shop', windowId: 1, active: true, status: 'complete' },
    { id: 12, url: 'edge://newtab/', title: 'New tab', windowId: 1, active: false, status: 'complete' },
  ];
  let nextTab = 100;
  const debuggerAttached = new Set();
  // What document.visibilityState answers in G9's world (the live-watch watchdog reads it).
  let pageVisibility = 'visible';
  const ev = {
    startup: makeEvent(), installed: makeEvent(), message: makeEvent(), alarm: makeEvent(),
    dbgEvent: makeEvent(), dbgDetach: makeEvent(), tabRemoved: makeEvent(), tabCreated: makeEvent(), tabUpdated: makeEvent(),
    focus: makeEvent(), dlCreated: makeEvent(), dlChanged: makeEvent(),
  };
  const session = makeArea();
  const local = makeArea();
  // What a v1 user has on disk: a mode, the migration marker, a token.
  await local.set({ settings: { mode: 'workspace', modeDefaultMigrated: true, bridge: { host: '127.0.0.1', port: PORT, token: 'x', serverPath: 'C:/old' } } });

  globalThis.chrome = {
    runtime: {
      id: 'g9test',
      onStartup: ev.startup, onInstalled: ev.installed, onMessage: ev.message,
      getManifest: () => ({ version: '2.0.0' }),
      getURL: (p) => `chrome-extension://g9test/${p}`,
      reload: () => { calls.runtimeReload += 1; },
      sendMessage: () => Promise.resolve(),
    },
    debugger: {
      onEvent: ev.dbgEvent, onDetach: ev.dbgDetach,
      async attach({ tabId }) { calls.attached.push(tabId); debuggerAttached.add(tabId); },
      async detach({ tabId }) { debuggerAttached.delete(tabId); },
      async getTargets() { return tabs.map((t) => ({ tabId: t.id, attached: debuggerAttached.has(t.id) })); },
      async sendCommand(debuggee, method, params) {
        calls.commands.push({ ...debuggee, method, params });
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `F${debuggee.tabId}`, loaderId: 'L1', url: 'https://shop.example.test/' } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
        if (method === 'Runtime.evaluate' && String(params.expression).includes('sessionStorage')) {
          return { result: { type: 'object', value: { localStorage: [['cart', '3 items']], sessionStorage: [['step', '2']], viewport: { width: 1280, height: 720, dpr: 1 }, userAgent: 'Edg/153 test' } } };
        }
        if (method === 'Runtime.evaluate' && /document\.visibilityState\s*$/.test(String(params.expression))) {
          return { result: { type: 'string', value: pageVisibility } };
        }
        return {};
      },
    },
    tabs: {
      onRemoved: ev.tabRemoved, onCreated: ev.tabCreated, onUpdated: ev.tabUpdated,
      async get(id) { const t = tabs.find((x) => x.id === id); if (!t) throw new Error(`No tab with id: ${id}.`); return { ...t }; },
      async query(info = {}) {
        let list = tabs;
        if (info.active) list = list.filter((t) => t.active);
        if (info.windowId != null) list = list.filter((t) => t.windowId === info.windowId);
        return list.map((t) => ({ ...t }));
      },
      async create({ url, active }) {
        const t = { id: nextTab++, url, title: '', windowId: 1, active: !!active, status: 'loading' };
        tabs.push(t);
        calls.created.push(url);
        ev.tabCreated.fire({ ...t });
        return { ...t };
      },
      async update(id, patch) { calls.updated.push({ id, ...patch }); const t = tabs.find((x) => x.id === id); Object.assign(t, patch); return { ...t }; },
      async reload(id) { calls.reloaded.push(id); },
      async remove(id) { calls.removed.push(id); tabs.splice(tabs.findIndex((x) => x.id === id), 1); ev.tabRemoved.fire(id, {}); },
    },
    windows: {
      WINDOW_ID_NONE: -1, onFocusChanged: ev.focus,
      async get(id) { return { id, type: 'normal', state: 'normal', focused: true }; },
      async getAll({ populate } = {}) { return [{ id: 1, type: 'normal', state: 'normal', focused: true, ...(populate ? { tabs: tabs.map((t) => ({ ...t })) } : {}) }]; },
      async update(id, patch) { calls.windowUpdates.push({ id, ...patch }); return { id, ...patch }; },
      async create(opts) {
        calls.windowCreateAttempts.push(opts);
        // Chromium's real refusal, for the popout fallback test (measured in the isolated live test).
        if (calls.rejectWindowCreates > 0) {
          calls.rejectWindowCreates -= 1;
          throw new Error('Invalid value for bounds. Bounds must be at least 50% within visible screen space.');
        }
        calls.windowsCreated.push(opts);
        return { id: 2, ...opts };
      },
    },
    storage: { session, local },
    alarms: { create: (name, opts) => calls.alarms.push({ name, opts }), onAlarm: ev.alarm },
    sidePanel: { setPanelBehavior: async () => { calls.sidePanel += 1; } },
    action: { setTitle: async ({ title }) => { calls.setTitle.push(title); } },
    cookies: {
      async getAll(filter) {
        assert.equal('tabId' in filter, false, 'chrome.cookies never sees the tabId hint');
        const jar = [
          { name: 'sid', value: '1', domain: 'shop.example.test', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: true, storeId: '0' },
          { name: 'pref', value: '2', domain: '.example.test', hostOnly: false, path: '/', secure: false, httpOnly: false, sameSite: 'unspecified', session: true, storeId: '0' },
          { name: 'x', value: '3', domain: 'cdn.example.test', hostOnly: true, path: '/', secure: false, httpOnly: false, sameSite: 'unspecified', session: true, storeId: '0' },
        ];
        return jar.filter((c) => !filter.domain || c.domain.replace(/^\./, '') === filter.domain || c.domain.replace(/^\./, '').endsWith(`.${filter.domain}`));
      },
    },
    downloads: { onCreated: ev.dlCreated, onChanged: ev.dlChanged, search: async ({ id }) => (dlItems.has(id) ? [{ ...dlItems.get(id) }] : []) },
  };

  // No real network: the dev-override file points at a random test port, and
  // /health answers as a g9d would, so the transport proceeds to the fake socket.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/dev-daemon.json')) return new Response(JSON.stringify({ host: '127.0.0.1', port: PORT }), { status: 200 });
    if (u.startsWith('chrome-extension://')) return new Response('not found', { status: 404 });
    if (u === `http://127.0.0.1:${PORT}/health`) return new Response(JSON.stringify({ ok: true, name: 'g9d', version: '2.0.0' }), { status: 200 });
    throw new TypeError(`unexpected fetch in the test: ${u}`);
  };
  const sockets = [];
  globalThis.WebSocket = class FakeSocket {
    constructor(url) {
      if (!url.includes(`:${PORT}/`)) throw new Error(`the extension tried to open ${url}`);
      this.url = url;
      this.readyState = 0;
      this.listeners = {};
      this.sent = [];
      sockets.push(this);
      setTimeout(() => { this.readyState = 1; this.fire('open', {}); }, 0);
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close(code = 1000, reason = '') { this.readyState = 3; this.fire('close', { code, reason }); }
    fire(type, e) { for (const fn of this.listeners[type] ?? []) fn(e); }
    deliver(msg) { this.fire('message', { data: JSON.stringify(msg) }); }
  };

  const missing = OTHER_PACKAGE.filter((p) => !existsSync(join(ROOT, p)));
  if (missing.length) {
    console.log(`SKIP not landed yet: ${missing.join(', ')}`);
    return;
  }
  const { platform, isExtension } = await import(pathToFileURL(join(EXT, 'lib', 'platform.js')).href);
  assert.equal(isExtension, true);
  assert.equal(platform.name, 'extension');
  ok('platform.js selected platform-extension when chrome.debugger exists');

  await import(pathToFileURL(join(EXT, 'sw.js')).href);
  const state = await import(pathToFileURL(join(EXT, 'lib', 'state.js')).href);

  await until(() => calls.setTitle.length, 'bootstrap');
  assert.deepEqual(calls.setTitle, ['G9 Browser Agent v2.0.0']);
  ok('bootstrap puts the version on the toolbar button');
  assert.equal(calls.sidePanel, 1);
  await until(() => calls.alarms.length, 'heartbeat alarm');
  assert.equal(calls.alarms[0].name, 'g9-heartbeat');

  const settings = (await local.get('settings')).settings;
  assert.equal('mode' in settings, false, 'v1 mode removed');
  assert.equal('modeDefaultMigrated' in settings, false);
  assert.deepEqual(settings.bridge, { host: '127.0.0.1', port: PORT }, 'host/port kept, token and paths dropped');
  const s0 = await state.getState();
  assert.ok(s0.activity.some((a) => /Removed the v1 control mode \("workspace"\)/.test(a.detail ?? '')), 'migration logged');
  assert.equal(s0.inputMode, 'human');
  assert.equal(s0.autoAttach, false);
  assert.equal(s0.version, '2.0.0');
  ok('v1 settings.mode removed once, logged; durable settings are host/port/inputMode/autoAttach');

  // --- install / update / same-version reload ---------------------------------
  ev.installed.fire({ reason: 'install' });
  await until(() => calls.created.includes('chrome-extension://g9test/panel/welcome.html'), 'welcome tab on install');
  ok('install opens panel/welcome.html');
  const beforeUpdate = calls.created.length;
  ev.installed.fire({ reason: 'update', previousVersion: '1.7.21' });
  await until(() => calls.updated.some((u) => u.url === 'chrome-extension://g9test/panel/welcome.html?updated=1'), 'welcome reused on update');
  assert.equal(calls.created.length, beforeUpdate, 'no second welcome tab');
  const about = await new Promise((resolve) => ev.message.fire({ __g9cmd: true, cmd: 'about' }, {}, resolve));
  assert.equal(about.version, '2.0.0');
  assert.equal(about.previousVersion, '1.7.21');
  assert.ok(about.updatedAt > 0);
  ok('update to a new version reuses the welcome tab with ?updated=1 and records previousVersion');
  const updatesSoFar = calls.updated.length + calls.reloaded.length;
  ev.installed.fire({ reason: 'update', previousVersion: '2.0.0' });
  await tick(100);
  assert.equal(calls.updated.length + calls.reloaded.length, updatesSoFar, 'same version: nothing opened');
  assert.equal(calls.created.length, beforeUpdate);
  ok('a reload of the same version opens nothing');

  // --- the daemon connection -------------------------------------------------
  const ws = await until(() => sockets.find((s) => s.readyState === 1 && s.sent.some((m) => m.type === 'hello')), 'hello');
  assert.equal(ws.url, `ws://127.0.0.1:${PORT}/g9`);
  const hello = ws.sent.find((m) => m.type === 'hello');
  assert.equal(hello.role, 'engine');
  ws.deliver({ type: 'welcome', version: '2.0.0', id: 'engine-1', daemonPid: 1, halted: { global: false } });
  await until(async () => (await state.getState()).bridge.connected, 'welcome');
  ok('connects to the dev-override port only, as role engine');

  const reply = async (id) => until(() => ws.sent.find((m) => m.type === 'result' && m.id === id), `result ${id}`);
  ws.deliver({ type: 'call', id: 1, tool: 'browser_status', args: {}, caller: { agentId: 'agent-1', name: 'test' } });
  const status = await reply(1);
  assert.equal(status.ok, true);
  assert.equal(status.result.engine, 'extension');
  assert.equal(status.result.version, '2.0.0');
  assert.equal(status.result.current.tabId, 11);
  assert.equal(status.result.connected, true, 'connection() hook merged into status');
  ok('a daemon call runs through runTool and answers {type:"result"}');
  await until(() => ws.sent.some((m) => m.type === 'event' && m.event === 'activity'), 'activity event');
  ok('the tool call was logged and forwarded as an activity event');

  ws.deliver({ type: 'agents', agents: [{ id: 'agent-1', name: 'test', owned: [11] }] });
  await until(async () => (await state.getState()).agents.length === 1, 'agents');
  ok('agents pushed by the daemon land in state');

  ws.deliver({ type: 'halt', halted: true });
  await until(async () => (await state.getState()).halted, 'halt');
  ws.deliver({ type: 'call', id: 2, tool: 'browser_tabs', args: { action: 'list' } });
  const refused = await reply(2);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /pressed Stop/);
  ws.deliver({ type: 'call', id: 3, tool: 'browser_status', args: {} });
  assert.equal((await reply(3)).ok, true, 'browser_status still answers while halted');
  assert.ok(!ws.sent.some((m) => m.type === 'event' && m.event === 'halt'), 'a daemon halt is not echoed back');
  ws.deliver({ type: 'halt', halted: false });
  await until(async () => !(await state.getState()).halted, 'resume');
  ok('daemon halt blocks every tool but browser_status, and is not echoed');

  const cmd = (payload) => new Promise((resolve) => ev.message.fire({ __g9cmd: true, ...payload }, {}, resolve));
  assert.equal((await cmd({ cmd: 'halt' })).ok, true);
  assert.ok(ws.sent.some((m) => m.type === 'event' && m.event === 'halt' && m.data.halted === true && m.data.by === 'panel'));
  await cmd({ cmd: 'resume' });
  assert.ok(ws.sent.some((m) => m.type === 'event' && m.event === 'halt' && m.data.halted === false));
  ok('the panel\'s Stop/Resume are reported to the daemon');

  // --- input mode and stealth -------------------------------------------------
  assert.equal((await cmd({ cmd: 'setInputMode', mode: 'stealth' })).ok, true);
  assert.equal(platform.settings.stealthFor(11), 'stealth');
  assert.equal((await local.get('settings')).settings.inputMode, 'stealth', 'durable');
  assert.equal((await cmd({ cmd: 'setInputMode', mode: 'turbo' })).ok, false);
  calls.commands.length = 0;
  const attachedNow = await cmd({ cmd: 'attachTab', tabId: 11 });
  assert.equal(attachedNow.ok, true, attachedNow.error);
  assert.ok(!calls.commands.some((c) => c.method === 'Runtime.enable'), 'attach at stealth never enables Runtime');
  assert.ok(calls.commands.some((c) => c.method === 'Page.enable'), 'the other domains are enabled');
  ws.deliver({ type: 'call', id: 4, tool: 'browser_console', args: {} });
  const consoleRead = await reply(4);
  assert.equal(consoleRead.ok, true);
  assert.equal(consoleRead.result.unavailable, 'Runtime domain disabled by stealth level');
  ws.deliver({ type: 'call', id: 41, tool: 'browser_console', args: { action: 'evaluate', expression: '1' } });
  await reply(41);
  assert.ok(!calls.commands.some((c) => c.method === 'Runtime.enable'), 'still never enabled after an evaluate');
  await cmd({ cmd: 'setInputMode', mode: 'human' });
  assert.ok(calls.commands.some((c) => c.method === 'Runtime.enable' && c.tabId === 11), 'leaving stealth re-enables Runtime on held tabs');
  ok('input mode: stealth keeps Runtime off (console says so), human turns it back on');

  // --- auto-attach and tab events --------------------------------------------
  calls.attached.length = 0;
  await cmd({ cmd: 'detach' });
  assert.equal((await cmd({ cmd: 'setAutoAttach', enabled: true })).ok, true);
  await until(() => calls.attached.includes(11), 'auto-attach of the open web tab');
  assert.ok(!calls.attached.includes(12), 'edge://newtab is never attached');
  const s1 = await state.getState();
  assert.ok(s1.activity.some((a) => /Auto-attach skipped edge:\/\/newtab/.test(a.detail ?? '')), 'ineligible page reported');
  const eventsBefore = ws.sent.filter((m) => m.event === 'tabs').length;
  const created = await chrome.tabs.create({ url: 'https://shop.example.test/cart', active: false });
  await until(() => calls.attached.includes(created.id), 'auto-attach of a new tab');
  await until(() => ws.sent.filter((m) => m.event === 'tabs').length > eventsBefore, 'tabs event', 2000);
  const tabsEvent = ws.sent.filter((m) => m.event === 'tabs').at(-1);
  assert.ok(tabsEvent.data.tabs.some((t) => t.tabId === created.id && t.url === 'https://shop.example.test/cart'));
  ok('auto-attach attaches web tabs on enable and on creation; tab changes reach the daemon');

  // --- dialogs ----------------------------------------------------------------
  ev.dbgEvent.fire({ tabId: 11 }, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Saved!' });
  await until(() => ws.sent.some((m) => m.event === 'dialog' && m.data.tabId === 11 && m.data.message === 'Saved!'), 'dialog event');
  await until(async () => (await state.getState()).dialogOpen?.tabId === 11, 'dialogOpen');
  ws.deliver({ type: 'call', id: 5, tool: 'browser_snapshot', args: { tabId: 11 } });
  assert.match((await reply(5)).error, /blocked by a JavaScript alert dialog/);
  ws.deliver({ type: 'call', id: 6, tool: 'browser_snapshot', args: { tabId: created.id } });
  const other = await reply(6);
  assert.doesNotMatch(String(other.error ?? ''), /dialog/, 'a dialog on one tab does not block another tab');
  ev.dbgEvent.fire({ tabId: 11 }, 'Page.javascriptDialogClosed', {});
  await until(async () => (await state.getState()).dialogOpen === null, 'dialog cleared');
  ok('a dialog is surfaced to the daemon and blocks only its own tab');

  // --- closing a tab forgets it -------------------------------------------------
  await cmd({ cmd: 'attachTab', tabId: created.id });
  assert.equal((await state.getState()).currentTabId, created.id);
  await chrome.tabs.remove(created.id);
  await until(async () => (await state.getState()).currentTabId === null, 'current forgotten on close');
  ok('closing the current tab forgets it');

  // --- popout -----------------------------------------------------------------
  calls.windowUpdates.length = 0;
  ev.focus.fire(1); // the user's ordinary window
  await tick(20);
  // The PERSON's button: the window they asked for comes up in front, on screen, and their own
  // window is NOT raised over it. v2.0.2 created it unfocused, full size, 40 px lower, and then
  // raised the person's window — burying it (reported: "the tab disappears, no window opens").
  const popped = await cmd({ cmd: 'popout', tabId: 11 });
  assert.equal(popped.ok, true, popped.error);
  assert.equal(popped.windowId, 2);
  const made = calls.windowsCreated.at(-1);
  assert.equal(made.tabId, 11);
  assert.equal(made.focused, true, 'the panel\'s Pop out brings the new window to the front');
  assert.equal(made.state, 'normal');
  assert.ok(!calls.windowUpdates.some((u) => u.id === 1 && u.focused === true), 'the person\'s window is not raised over the popout');
  assert.equal(popped.focused, true);
  assert.ok('visible' in popped, 'the result reports what the page says about its visibility');
  assert.match(popped.note, /minimise/);
  assert.equal((await cmd({ cmd: 'halt' })).ok, true);
  const poppedWhileStopped = await cmd({ cmd: 'popout' });
  await cmd({ cmd: 'resume' });
  assert.equal(poppedWhileStopped.ok, true, `the panel's own button works while Stop is on: ${poppedWhileStopped.error}`);
  assert.equal(poppedWhileStopped.tabId, 11, 'the tab the panel shows');
  ok('the panel\'s popout opens the tab\'s own window in front, without raising the person\'s window over it (also while stopped)');

  // Geometry: never an exact copy of a maximised window sitting on top of it.
  const { popoutGeometry } = await import('../../extension/tools/tabs.js');
  const g = popoutGeometry({ left: -8, top: -8, width: 1936, height: 1048 });
  assert.ok(g.width < 1936 && g.width >= 640, `narrower than the source (${g.width})`);
  assert.ok(g.height < 1048 && g.height >= 480, `shorter than the source (${g.height})`);
  assert.ok(g.left + g.width <= -8 + 1936, 'inside the source window horizontally');
  assert.deepEqual(popoutGeometry(null, { width: 800, height: 600, left: 10, top: 20 }),
    { width: 800, height: 600, left: 10, top: 20 }, 'explicit geometry wins');
  ok('popout geometry: a smaller window at the source\'s top-right; explicit values win');

  // An AGENT's popout: unfocused (the person keeps the keyboard), and — the person's window still
  // having focus, as the stub's windows.get reports — nothing raises that window over the popout.
  calls.windowUpdates.length = 0;
  ws.deliver({ type: 'call', id: 91, tool: 'browser_tabs', args: { action: 'popout', tabId: 11 } });
  const agentPop = await reply(91);
  assert.equal(agentPop.ok, true, agentPop.error);
  assert.equal(calls.windowsCreated.at(-1).focused, false, 'an agent\'s popout never takes the keyboard');
  assert.ok(!calls.windowUpdates.some((u) => u.id === 1 && u.focused === true),
    'focus is handed back only if the browser moved it; raising the person\'s window buried the popout');
  assert.equal(agentPop.result.focused, false);
  ok('an agent\'s popout is created unfocused and is not buried under the person\'s window');

  // The browser refuses a placement it considers off-screen: fall back instead of failing.
  calls.windowCreateAttempts.length = 0;
  calls.rejectWindowCreates = 1;
  const fallback = await cmd({ cmd: 'popout', tabId: 11 });
  assert.equal(fallback.ok, true, fallback.error);
  assert.equal(calls.windowCreateAttempts.length, 2, 'one refused placement, then the fallback');
  const [refusedPlace, usedPlace] = calls.windowCreateAttempts;
  assert.notDeepEqual([refusedPlace.left, refusedPlace.top], [usedPlace.left, usedPlace.top], 'the fallback is a different placement');
  assert.equal(usedPlace.width, refusedPlace.width, 'same size, safer place');
  calls.windowCreateAttempts.length = 0;
  calls.rejectWindowCreates = 2;
  const lastResort = await cmd({ cmd: 'popout', tabId: 11 });
  assert.equal(lastResort.ok, true, lastResort.error);
  assert.equal(calls.windowCreateAttempts.length, 3);
  assert.equal(calls.windowCreateAttempts[2].left, undefined, 'the last attempt lets the browser choose');
  ok('a popout whose placement the browser refuses falls back to a safer place, then to the browser\'s own choice');

  // --- downloads over chrome.downloads ---------------------------------------
  ws.deliver({ type: 'call', id: 7, tool: 'browser_network', args: { action: 'watch_downloads', tabId: 11 } });
  const watched = await reply(7);
  assert.equal(watched.ok, true, watched.error);
  assert.equal(watched.result.mode, 'extension');
  // The tab's own capture saw the request, so attribution is exact.
  ev.dbgEvent.fire({ tabId: 11 }, 'Network.requestWillBeSent', {
    requestId: 'R9', loaderId: 'L1', type: 'Document', timestamp: 1, wallTime: Date.now() / 1000,
    request: { url: 'https://shop.example.test/export.csv', method: 'GET', headers: {} },
  });
  await until(async () => Object.keys((await session.get('network:11'))['network:11'] ?? {}).length, 'network capture');
  const item = { id: 7, url: 'https://shop.example.test/export.csv', finalUrl: 'https://shop.example.test/export.csv', referrer: 'https://shop.example.test/', filename: '', state: 'in_progress', startTime: new Date().toISOString(), bytesReceived: 0, totalBytes: 10, mime: 'text/csv' };
  dlItems.set(7, item);
  ev.dlCreated.fire({ ...item });
  dlItems.set(7, { ...item, state: 'complete', filename: 'C:\\Users\\qa\\Downloads\\export.csv', bytesReceived: 10, fileSize: 10, exists: true, endTime: new Date().toISOString() });
  await tick(50);
  ev.dlChanged.fire({ id: 7, state: { previous: 'in_progress', current: 'complete' } });
  ws.deliver({ type: 'call', id: 8, tool: 'browser_network', args: { action: 'wait_download', tabId: 11, contains: 'export', timeoutMs: 3000 } });
  const got = await reply(8);
  assert.equal(got.ok, true, got.error);
  assert.equal(got.result.state, 'complete');
  assert.equal(got.result.attribution, 'exact');
  assert.equal(got.result.filename, 'export.csv');
  assert.equal(got.result.file.verified, true);
  assert.equal(got.result.file.source, 'browser', 'the browser\'s record, not a disk read');
  assert.equal(got.result.file.size, 10);
  ok('chrome.downloads: exact attribution from the tab\'s network capture, browser-record file facts');

  // A small file can finish before its "created" attribution does: the
  // completion must still land (it used to be dropped as "not watched").
  ws.deliver({ type: 'call', id: 71, tool: 'browser_network', args: { action: 'watch_downloads', tabId: 11 } });
  assert.equal((await reply(71)).ok, true);
  const quick = { id: 8, url: 'https://shop.example.test/quick.csv', finalUrl: 'https://shop.example.test/quick.csv', referrer: 'https://shop.example.test/', filename: '', state: 'in_progress', startTime: new Date().toISOString(), bytesReceived: 0, totalBytes: 3, mime: 'text/csv' };
  dlItems.set(8, { ...quick, state: 'complete', filename: 'C:\\Users\\qa\\Downloads\\quick.csv', bytesReceived: 3, fileSize: 3, exists: true, endTime: new Date().toISOString() });
  ev.dlCreated.fire({ ...quick });
  ev.dlChanged.fire({ id: 8, state: { previous: 'in_progress', current: 'complete' } });
  ws.deliver({ type: 'call', id: 72, tool: 'browser_network', args: { action: 'wait_download', tabId: 11, contains: 'quick', timeoutMs: 3000 } });
  const fast = await reply(72);
  assert.equal(fast.ok, true, fast.error);
  assert.equal(fast.result.state, 'complete');
  assert.equal(fast.result.filename, 'quick.csv');
  ok('chrome.downloads: a completion that beats its own attribution is still recorded');

  // A download whose ORIGIN evidence points somewhere else is not this tab's, however alone it is.
  // The single-watcher time rule used to claim it: the person's own PDF from another site came back
  // from wait_download as the export under test (extension review, 2026-09-22).
  ws.deliver({ type: 'call', id: 74, tool: 'browser_network', args: { action: 'watch_downloads', tabId: 11 } });
  assert.equal((await reply(74)).ok, true);
  const theirs = { id: 10, url: 'https://news.example/paper.pdf', finalUrl: 'https://news.example/paper.pdf', referrer: 'https://news.example/', filename: '', state: 'in_progress', startTime: new Date().toISOString(), bytesReceived: 0, totalBytes: 4 };
  dlItems.set(10, { ...theirs, state: 'complete', filename: 'C:\\Users\\qa\\Downloads\\paper.pdf', bytesReceived: 4, fileSize: 4, exists: true, endTime: new Date().toISOString() });
  ev.dlCreated.fire({ ...theirs });
  ev.dlChanged.fire({ id: 10, state: { previous: 'in_progress', current: 'complete' } });
  await tick(100);
  ws.deliver({ type: 'call', id: 75, tool: 'browser_network', args: { action: 'downloads', tabId: 11 } });
  const listed = await reply(75);
  assert.equal(listed.ok, true, listed.error);
  assert.equal(listed.result.downloads.some((d) => d.filename === 'paper.pdf'), false, 'never claimed as this tab\'s');
  assert.ok((listed.result.unattributed ?? []).some((d) => d.filename === 'paper.pdf'), 'listed aside, with its attribution unknown');
  // …and wait_download does not pass on it.
  ws.deliver({ type: 'call', id: 76, tool: 'browser_network', args: { action: 'wait_download', tabId: 11, timeoutMs: 400 } });
  const waited = await reply(76);
  assert.equal(waited.ok, false);
  assert.match(waited.error, /No download completed within/);
  ok('chrome.downloads: a download whose referrer belongs to another site is never claimed by the watched tab');

  // Nothing watched: the person's own downloads are not G9's to report.
  ws.deliver({ type: 'call', id: 73, tool: 'browser_network', args: { action: 'stop_downloads', tabId: 11 } });
  assert.equal((await reply(73)).ok, true);
  const mine = { id: 9, url: 'https://elsewhere.test/holiday.jpg', finalUrl: 'https://elsewhere.test/holiday.jpg', referrer: '', filename: '', state: 'in_progress', startTime: new Date().toISOString(), bytesReceived: 0, totalBytes: 5 };
  dlItems.set(9, { ...mine, state: 'complete', filename: 'C:\\Users\\qa\\Downloads\\holiday.jpg', bytesReceived: 5, fileSize: 5, exists: true });
  ev.dlCreated.fire({ ...mine });
  ev.dlChanged.fire({ id: 9, state: { previous: 'in_progress', current: 'complete' } });
  await tick(100);
  assert.ok(!ws.sent.some((m) => m.event === 'download' && m.data?.id === '9'), 'no download event for an unwatched browser');
  assert.equal(Object.keys(await session.get(null)).some((k) => k === 'g9:dl:item:9'), false, 'and nothing stored for it');
  ok('chrome.downloads: nothing is reported while no tab is watched');

  // --- handoff export ----------------------------------------------------------
  ws.deliver({ type: 'call', id: 9, tool: 'browser_tabs', args: { action: 'handoff_export', tabId: 11 } });
  const handoff = await reply(9);
  assert.equal(handoff.ok, true, handoff.error);
  assert.deepEqual(handoff.result.cookies.map((c) => c.name).sort(), ['pref', 'sid'], 'host + parent-domain cookies, not a sibling host\'s');
  assert.deepEqual(handoff.result.localStorage, [['cart', '3 items']]);
  assert.deepEqual(handoff.result.sessionStorage, [['step', '2']]);
  assert.equal(handoff.result.origin, 'https://shop.example.test');
  const storageRead = calls.commands.find((c) => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('sessionStorage'));
  assert.equal(storageRead.params.contextId, 5, 'storage read in G9\'s isolated world');
  ok('handoff_export: cookies for the host and its parents, storage read in the isolated world');

  // --- live watch: frames and the pointer track go to the daemon --------------
  const pointer = await import(pathToFileURL(join(EXT, 'lib', 'pointer.js')).href);
  calls.commands.length = 0;
  ws.deliver({ type: 'watch', tabId: 11, on: true });
  await until(() => calls.commands.some((c) => c.method === 'Page.startScreencast' && c.tabId === 11), 'screencast start');
  ev.dbgEvent.fire({ tabId: 11 }, 'Page.screencastFrame', { data: 'SlBFRw==', metadata: { deviceWidth: 1280, deviceHeight: 720 }, sessionId: 41 });
  await until(() => ws.sent.some((m) => m.event === 'frame' && m.data.tabId === 11 && m.data.data === 'SlBFRw=='), 'frame event');
  await until(() => calls.commands.some((c) => c.method === 'Page.screencastFrameAck' && c.params.sessionId === 41), 'frame ack');
  pointer.record(11, { at: Date.now(), x: 10, y: 20, buttons: 0, type: 'mouseMoved' });
  pointer.record(99, { at: Date.now(), x: 1, y: 1, buttons: 0, type: 'mouseMoved' });
  await until(() => ws.sent.some((m) => m.event === 'pointer' && m.data.tabId === 11 && m.data.sample.x === 10), 'pointer event');
  assert.ok(!ws.sent.some((m) => m.event === 'pointer' && m.data.tabId === 99), 'only the watched tab streams');
  ws.deliver({ type: 'watch', tabId: 11, on: false });
  await until(() => calls.commands.some((c) => c.method === 'Page.stopScreencast' && c.tabId === 11), 'screencast stop');
  ok('watch streams screencast frames (acked) and pointer samples for that tab only, and stops cleanly');

  // --- live watch of a HIDDEN tab: the viewer is told the picture is not live ---
  // P8 matrix, round 2: a hidden tab sent one frame and then nothing, and no event said why.
  pageVisibility = 'hidden';
  try {
    ws.deliver({ type: 'watch', tabId: 11, on: true });
    await until(() => ws.sent.some((m) => m.event === 'watchStatus' && m.data.tabId === 11 && m.data.state === 'hidden'), 'watchStatus hidden');
    const status = ws.sent.find((m) => m.event === 'watchStatus' && m.data.state === 'hidden');
    assert.match(status.data.reason, /NOT live/);
    // A hidden page still hands over a frame now and then (P8 matrix, round 3: hidden → live → hidden
    // from a single one): that is not "live" while the page says it is hidden…
    ev.dbgEvent.fire({ tabId: 11 }, 'Page.screencastFrame', { data: 'SlBFRw==', metadata: {}, sessionId: 42 });
    await tick(1300);
    assert.ok(!ws.sent.some((m) => m.event === 'watchStatus' && m.data.state === 'live'), 'one frame from a hidden page is not live');
    // …and it is live again once the page is visible and frames arrive.
    pageVisibility = 'visible';
    ev.dbgEvent.fire({ tabId: 11 }, 'Page.screencastFrame', { data: 'SlBFRw==', metadata: {}, sessionId: 42 });
    await until(() => ws.sent.some((m) => m.event === 'watchStatus' && m.data.tabId === 11 && m.data.state === 'live'), 'watchStatus live');
    ws.deliver({ type: 'watch', tabId: 11, on: false });
    await until(() => calls.commands.filter((c) => c.method === 'Page.stopScreencast' && c.tabId === 11).length >= 2, 'second screencast stop');
    const statuses = ws.sent.filter((m) => m.event === 'watchStatus').length;
    await tick(1200);
    assert.equal(ws.sent.filter((m) => m.event === 'watchStatus').length, statuses, 'the watchdog stops with the watch');
  } finally {
    pageVisibility = 'visible';
  }
  ok('watch of a hidden tab emits watchStatus {state:"hidden"} and stops checking when the watch ends');

  // --- reload waits for the call in flight -----------------------------------
  ws.deliver({ type: 'call', id: 10, tool: 'browser_navigate', args: { action: 'wait', selector: '#never', timeoutMs: 600, tabId: 11 } });
  await tick(50);
  ws.deliver({ type: 'reload' });
  await tick(250);
  assert.equal(calls.runtimeReload, 0, 'not while a call is in flight');
  const slow = await reply(10);
  assert.match(slow.error, /Timed out after 600ms/);
  await until(() => calls.runtimeReload === 1, 'runtime.reload after the call');
  ok('{type:"reload"} waits for the call in flight, then reloads the extension');

  // --- a reload never throws away a recording ---------------------------------
  // chrome.runtime.reload() CLEARS storage.session: the steps of a recording in progress, an issue
  // video session, download watches and the activity log go with it (measured, Edge 153,
  // 2026-09-22). Waiting only for daemon calls lost a QA's recording to an app update.
  const reloadsBefore = calls.runtimeReload;
  await session.set({ 'g9:recording-session:11': { name: 'checkout', startedAt: Date.now(), steps: [{ type: 'click' }] } });
  ws.deliver({ type: 'reload' });
  await tick(300);
  assert.equal(calls.runtimeReload, reloadsBefore, 'not while a tab is recording');
  assert.ok(ws.sent.some((m) => m.type === 'event' && m.event === 'reloadDeferred' && /recording/.test(String(m.data?.reasons ?? ''))),
    'the daemon is told why the update waits');
  // Saving the recording (here: it ends) lets the deferred reload go ahead.
  await session.remove('g9:recording-session:11');
  await new Promise((resolve) => ev.message.fire({ __g9cmd: true, cmd: 'recStatus' }, {}, resolve));
  await until(() => calls.runtimeReload === reloadsBefore + 1, 'the reload happens once the recording is over');
  // …and it is written where the reload cannot erase it, for the new worker to log.
  assert.equal(typeof (await local.get('about')).about?.lastReload?.at, 'number');
  ok('an update reload waits for an unsaved recording, says so, and is announced in the next session');

  console.log('EXTENSION-SIDE OK');
}
