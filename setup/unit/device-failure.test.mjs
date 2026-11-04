/**
 * The failure bundle (runner/drivers/device.mjs `failureBundle`, 3.8.11): when a device flow fails, the app's black-box
 * trace and its screen are kept beside the report with a short summary. A fake protocol-2 bridge on 127.0.0.1.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { DeviceDriver, summarizeTrace } from '../../runner/drivers/device.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const NL = String.fromCharCode(10);

const TRACE = {
  id: 'T-4',
  reason: 'flow failed',
  busy: { idle: false, reasons: ['sync:site (31.0s) — suspected leak'] },
  logs: [
    { seq: 1, t: 1, level: 'info', text: 'shell: tab map' },
    { seq: 2, t: 2, level: 'warn', text: 'sync: automatic sync failed: NET' },
    { seq: 3, t: 3, level: 'error', text: 'Uncaught TypeError: x is undefined' },
  ],
  net: [
    { seq: 1, t: 1, method: 'GET', url: 'https://api.example/ok', status: 200, ms: 20 },
    { seq: 2, t: 2, method: 'POST', url: 'https://api.example/save', status: 500, ms: 80 },
    { seq: 3, t: 3, method: 'GET', url: 'https://api.example/x', status: null, ms: 5, error: 'offline' },
  ],
  sections: { screen: 'a long tree' },
};

async function bridge({ knows = true } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') return res.end(JSON.stringify({ ok: true, protocol: 2, app: 'com.example.app', signatureRequired: false }));
      const msg = JSON.parse(body || '{}');
      if (!knows) return res.end(JSON.stringify({ ok: false, error: `Unknown command "${msg.command}".` }));
      if (msg.command === 'trace.capture') return res.end(JSON.stringify({ ok: true, result: { ...TRACE, reason: msg.args.reason } }));
      if (msg.command === 'ui.screenshot') return res.end(JSON.stringify({ ok: true, result: { base64: Buffer.from('jpeg').toString('base64'), width: 4, height: 8 } }));
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  // A random port in 18000-18999 (AIGuide rule 7: never 8765, never an OS-chosen port), retried when taken.
  for (let attempt = 0; ; attempt++) {
    const candidate = 18000 + Math.floor(Math.random() * 1000);
    const bound = await new Promise((resolve, reject) => {
      server.once('error', (err) => (err.code === 'EADDRINUSE' && attempt < 20 ? resolve(false) : reject(err)));
      server.listen(candidate, '127.0.0.1', () => resolve(true));
    });
    if (bound) break;
  }
  return { port: server.address().port, close: () => server.close() };
}

test('a failed flow keeps the trace and the screen beside the report, with a summary', async () => {
  const b = await bridge();
  const report = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-fail-'));
  try {
    const d = new DeviceDriver({ port: b.port, serial: false, artifactsDir: path.join(report, 'screens') });
    const bundle = await d.failureBundle('shop.order/save', 'step 3: not found');
    assert.equal(path.dirname(bundle.trace), path.join(report, 'failures'));
    assert.equal(path.basename(bundle.trace), 'shop.order-save.trace.json');
    assert.equal(JSON.parse(fs.readFileSync(bundle.trace, 'utf8')).reason, 'step 3: not found');
    assert.equal(fs.readFileSync(bundle.screenshot, 'utf8'), 'jpeg');
    assert.deepEqual(bundle.summary.busy, ['sync:site (31.0s) — suspected leak']);
    assert.equal(bundle.summary.logs.length, 2, 'warnings and errors only');
  } finally {
    b.close();
  }
});

test('a bridge without a black box or a screen gives nothing; without a report folder nothing is asked', async () => {
  const b = await bridge({ knows: false });
  try {
    const report = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-fail-'));
    assert.equal(await new DeviceDriver({ port: b.port, serial: false, artifactsDir: path.join(report, 'screens') }).failureBundle('f', 'x'), null);
    assert.equal(fs.existsSync(path.join(report, 'failures')), false);
    assert.equal(await new DeviceDriver({ port: b.port, serial: false }).failureBundle('f', 'x'), null);
  } finally {
    b.close();
  }
});

test('summarizeTrace: busy, the last warnings/errors, the failed requests', () => {
  const s = summarizeTrace(TRACE);
  assert.equal(s.id, 'T-4');
  assert.deepEqual(s.logs, ['warn sync: automatic sync failed: NET', 'error Uncaught TypeError: x is undefined']);
  assert.deepEqual(s.net, ['POST https://api.example/save → 500', 'GET https://api.example/x → offline']);
  assert.deepEqual(summarizeTrace(null), { busy: [], logs: [], net: [] });
  const fresh = summarizeTrace(TRACE, { since: 3 });
  assert.deepEqual(fresh.logs, ['error Uncaught TypeError: x is undefined'], 'what came before the flow is left out');
  assert.deepEqual(fresh.net, ['GET https://api.example/x → offline']);
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}${NL}${err?.stack ?? err}`);
    process.exit(1);
  }
}
