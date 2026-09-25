#!/usr/bin/env node
/**
 * extension/lib/sites.js (v3): what a URL's site is, whether it is one of a project's sites, and the
 * parts of a URL the side panel shows. Pure — no chrome, no network (ARCHITECTURE §12.1).
 *
 * Run: node setup/unit/sites.test.mjs
 */
import assert from 'node:assert/strict';
import { siteOf, parseDomain, hostMatches, displayUrl } from '../../extension/lib/sites.js';

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n${err?.stack ?? err}`);
    process.exit(1);
  }
}

await test('siteOf: the origin, or null for what has none (opaque origins are not one site)', () => {
  assert.equal(siteOf('https://Admin.Example.test:8443/orders?id=7#x'), 'https://admin.example.test:8443');
  assert.equal(siteOf('http://localhost:3000/'), 'http://localhost:3000');
  assert.equal(siteOf('https://example.test:443/'), 'https://example.test', 'a default port is not part of the origin');
  for (const opaque of ['about:blank', 'data:text/html,hi', 'not a url', '', null, undefined]) {
    assert.equal(siteOf(opaque), null, String(opaque));
  }
});

await test('parseDomain: host or host:port, forgiving about a scheme, a path or capitals', () => {
  assert.deepEqual(parseDomain('Example.TEST'), { hostname: 'example.test', port: null });
  assert.deepEqual(parseDomain('localhost:3000'), { hostname: 'localhost', port: '3000' });
  assert.deepEqual(parseDomain('https://shop.test/path'), { hostname: 'shop.test', port: null });
  assert.equal(parseDomain(''), null);
  assert.equal(parseDomain(null), null);
});

await test('hostMatches: the exact host or a subdomain of it, never a look-alike or a parent', () => {
  const domains = ['example.test'];
  assert.equal(hostMatches('https://example.test/', domains), true);
  assert.equal(hostMatches('https://app.example.test/x', domains), true);
  assert.equal(hostMatches('https://a.b.example.test/', domains), true);
  assert.equal(hostMatches('https://badexample.test/', domains), false, 'a look-alike suffix is not a subdomain');
  assert.equal(hostMatches('https://example.test.evil.test/', domains), false);
  assert.equal(hostMatches('https://test/', domains), false, 'a parent is not a subdomain');
  assert.equal(hostMatches('https://example.test/', ['app.example.test']), false, 'nor is the parent of a domain');
  assert.equal(hostMatches('https://EXAMPLE.test/', ['Example.Test']), true, 'case never matters');
});

await test('hostMatches: a domain with a port matches only that port; one without matches any', () => {
  assert.equal(hostMatches('http://localhost:3000/', ['localhost:3000']), true);
  assert.equal(hostMatches('http://localhost:3001/', ['localhost:3000']), false);
  assert.equal(hostMatches('http://localhost:3001/', ['localhost']), true);
  assert.equal(hostMatches('https://example.test/', ['example.test:443']), true, 'the default port counts');
  assert.equal(hostMatches('http://example.test/', ['example.test:443']), false);
});

await test('hostMatches: only http(s) pages, and nothing without domains', () => {
  assert.equal(hostMatches('edge://settings', ['settings']), false);
  assert.equal(hostMatches('chrome-extension://abc/panel.html', ['abc']), false);
  assert.equal(hostMatches('about:blank', ['blank']), false);
  assert.equal(hostMatches('https://example.test/', []), false);
  assert.equal(hostMatches('https://example.test/', undefined), false);
  assert.equal(hostMatches('https://example.test/', ['', null, 'example.test']), true, 'a bad entry does not spoil the rest');
});

await test('displayUrl: origin and path apart, the query and hash kept aside, the full URL for a tooltip', () => {
  const signed = 'https://files.example.test/download/report.pdf?X-Amz-Signature=abc&X-Amz-Expires=300#page=2';
  assert.deepEqual(displayUrl(signed), {
    origin: 'https://files.example.test',
    host: 'files.example.test',
    path: '/download/report.pdf',
    query: '?X-Amz-Signature=abc&X-Amz-Expires=300',
    hash: '#page=2',
    href: signed,
  });
  assert.deepEqual(displayUrl('about:blank'), { origin: null, host: null, path: 'about:blank', query: '', hash: '', href: 'about:blank' });
  assert.equal(displayUrl('not a url').path, 'not a url');
  assert.equal(displayUrl('not a url').origin, null);
});

await test('sites.js is pure: no chrome, no Node built-ins (rule R2)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../extension/lib/sites.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bchrome\s*\.|\bimport\b/, 'no chrome.*, no imports at all');
});

console.log('\nsites: done');
process.exit(0);
