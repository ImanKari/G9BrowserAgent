/**
 * Signed device bridges (runner/drivers/signing.mjs, docs/DEVICE_BRIDGE.md «Signed bridges»): the profile keeps WHERE the
 * key is (never the key), the driver refuses a bridge that requires signatures when it has none, every command it sends
 * verifies against the public key, a skewed device clock is corrected once, and an unsigned bridge gets no signature.
 *
 * The bridge is a fake HTTP server on 127.0.0.1 (a random port in 18000-18999) that verifies like a device does.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import { DeviceDriver } from '../../runner/drivers/device.mjs';
import { signRequest, signingFor } from '../../runner/drivers/signing.mjs';
import { normalizeDevicePlatforms } from '../../lib/devices.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PRIVATE_B64 = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const APP = 'com.example.shop.next';

function verify(req, body) {
  const h = req.headers;
  const text = ['g9p2', APP, h['x-g9p-ts'], h['x-g9p-nonce'], req.method, req.url.split('?')[0], crypto.createHash('sha256').update(body).digest('hex')].join('\n');
  const sig = Buffer.from(String(h['x-g9p-sig'] ?? '').replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  try {
    return crypto.verify('sha256', Buffer.from(text), pair.publicKey, sig);
  } catch {
    return false;
  }
}

async function signedBridge({ signatureRequired = true, skewOnce = false } = {}) {
  const seen = [];
  let skewed = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') {
        return res.end(JSON.stringify({ ok: true, service: 'fake', protocol: 2, app: APP, kids: ['k1'], signatureRequired, deviceTime: Date.now(), tokenRequired: false }));
      }
      const msg = JSON.parse(body || '{}');
      const signed = !!req.headers['x-g9p-sig'];
      seen.push({ command: msg.command, signed, valid: signed && verify(req, body), kid: req.headers['x-g9p-kid'] });
      if (skewOnce && !skewed) {
        skewed = true;
        return res.end(JSON.stringify({ ok: false, code: 'CLOCK_SKEW', error: 'skew', deviceTime: Date.now() + 120_000 }));
      }
      if (signatureRequired && !(signed && verify(req, body))) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ ok: false, code: 'SIG_INVALID', error: 'bad signature' }));
      }
      if (msg.command === 'qa.selftest') return res.end(JSON.stringify({ ok: true, result: { verdict: 'PASS', checks: [] } }));
      res.end(JSON.stringify({ ok: true, result: { echo: msg.command } }));
    });
  });
  for (let attempt = 0; ; attempt++) {
    const candidate = 18000 + Math.floor(Math.random() * 1000);
    const bound = await new Promise((resolve) => {
      server.once('error', (err) => resolve(err.code === 'EADDRINUSE' && attempt < 20 ? false : Promise.reject(err)));
      server.listen(candidate, '127.0.0.1', () => resolve(true));
    });
    if (bound) break;
  }
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

const PROFILE = normalizeDevicePlatforms({
  next: { package: APP, signing: { kid: 'k1', key: { windows: 'example:target', macos: { service: 'svc', account: 'acct' }, file: 'x.key' } } },
  plain: { package: APP },
}).platforms;

test('a profile keeps where the signing key is, never a key', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(PROFILE.next.signing)), { kid: 'k1', key: { file: 'x.key', windows: 'example:target', macos: { service: 'svc', account: 'acct' } } });
  assert.equal(PROFILE.plain.signing, null);
});

test('the environment key wins and its source is named, not its value', () => {
  const s = signingFor(PROFILE.next, { G9_SECRET_DEVICE_SIGNING_KEY: PRIVATE_B64 });
  assert.equal(s.kid, 'k1');
  assert.equal(s.source, 'env:G9_SECRET_DEVICE_SIGNING_KEY');
  assert.equal(s.key.type, 'private');
  assert.equal(signingFor(PROFILE.plain, {}), null);
});

test('(3.8.4) the environment key names its own kid; the profile kid is for the profile key', () => {
  const s = signingFor(PROFILE.next, { G9_SECRET_DEVICE_SIGNING_KEY: PRIVATE_B64, G9_DEVICE_SIGNING_KID: 'lab-node' });
  assert.equal(s.kid, 'lab-node');
  assert.equal(s.source, 'env:G9_SECRET_DEVICE_SIGNING_KEY');
});

test('a bridge that requires signatures is refused without a key, with the way to provide one', async () => {
  const bridge = await signedBridge();
  try {
    const driver = new DeviceDriver({ port: bridge.port, serial: false, profile: PROFILE.next });
    await assert.rejects(() => driver.connect(), /requires signed requests.*G9_SECRET_DEVICE_SIGNING_KEY/s);
  } finally { await bridge.close(); }
});

test('every command is signed and verifies; the kid is the profile\'s', async () => {
  const bridge = await signedBridge();
  try {
    const driver = new DeviceDriver({ port: bridge.port, serial: false, profile: PROFILE.next, signing: signingFor(PROFILE.next, { G9_SECRET_DEVICE_SIGNING_KEY: PRIVATE_B64 }) });
    await driver.connect();
    const r = await driver.command('ui.snapshot', {});
    assert.deepEqual(r, { ok: true, result: { echo: 'ui.snapshot' } });
    assert.ok(bridge.seen.length >= 2);
    assert.ok(bridge.seen.every((s) => s.signed && s.valid && s.kid === 'k1'), JSON.stringify(bridge.seen));
  } finally { await bridge.close(); }
});

test('a skewed device clock is corrected once from the time it reports', async () => {
  const bridge = await signedBridge({ skewOnce: true });
  try {
    const driver = new DeviceDriver({ port: bridge.port, serial: false, profile: PROFILE.next, signing: signingFor(PROFILE.next, { G9_SECRET_DEVICE_SIGNING_KEY: PRIVATE_B64 }) });
    const r = await driver.command('qa.ping', {});
    assert.deepEqual(r, { ok: true, result: { echo: 'qa.ping' } });
    assert.equal(bridge.seen.length, 2);
    assert.ok(driver.clockOffsetMs > 100_000);
  } finally { await bridge.close(); }
});

test('an unsigned bridge gets no signature (a bridge of protocol 1 is unchanged)', async () => {
  const bridge = await signedBridge({ signatureRequired: false });
  try {
    const driver = new DeviceDriver({ port: bridge.port, serial: false, profile: PROFILE.plain });
    await driver.connect();
    await driver.command('ui.snapshot', {});
    assert.ok(bridge.seen.every((s) => !s.signed));
  } finally { await bridge.close(); }
});

test('(3.8.6) a key from the environment signs only a bridge that asks: an unsigned bridge gets no signature', async () => {
  const bridge = await signedBridge({ signatureRequired: false });
  try {
    const driver = new DeviceDriver({ port: bridge.port, serial: false, profile: PROFILE.plain, signing: signingFor(PROFILE.plain, { G9_SECRET_DEVICE_SIGNING_KEY: PRIVATE_B64, G9_DEVICE_SIGNING_KID: 'lab' }) });
    await driver.connect();
    await driver.command('ui.snapshot', {});
    assert.ok(bridge.seen.length > 0 && bridge.seen.every((s) => !s.signed));
  } finally { await bridge.close(); }
});

test('(3.8.5) a bridge step sends one command as setup and says so; without a command it is refused', async () => {
  const bridge = await signedBridge({ signatureRequired: false });
  try {
    const driver = new DeviceDriver({ port: bridge.port, serial: false, profile: PROFILE.plain });
    await driver.connect();
    const res = await driver.stepCore({ id: 's0', action: 'bridge', command: 'dev.menu', args: {} });
    assert.equal(res.ok, true);
    assert.equal(res.setup, true);
    assert.ok(bridge.seen.some((s) => s.command === 'dev.menu'));
    await assert.rejects(() => driver.stepCore({ id: 's1', action: 'bridge' }), /needs "command"/);
  } finally { await bridge.close(); }
});

test('the signature covers the app: a header made for another app does not verify', () => {
  const headers = signRequest({ key: pair.privateKey, kid: 'k1', app: 'other.app', method: 'POST', path: '/qa', body: '{}' });
  const req = { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), method: 'POST', url: '/qa' };
  assert.equal(verify(req, '{}'), false);
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}\n${err?.stack ?? err}`);
    process.exit(1);
  }
}
