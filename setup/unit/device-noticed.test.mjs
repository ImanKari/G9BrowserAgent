/**
 * What the app's own checks noticed during a device flow (runner/drivers/device.mjs `noticed`, 3.8.8): the number before
 * the flow, the new violations after it, and an app without them (an unknown command, a broken bridge) answers null —
 * nothing changes for it. A fake bridge on 127.0.0.1 answers `oracle.list` like an app does.
 */

import assert from 'node:assert/strict';
import http from 'node:http';

import { DeviceDriver } from '../../runner/drivers/device.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function bridge({ knows = true } = {}) {
  const all = [
    { seq: 1, rule: 'a11y.unlabeled', severity: 'finding', key: 'Save', message: 'Save has no name', count: 1 },
    { seq: 2, rule: 'js.error', severity: 'finding', key: 'TypeError: x', message: 'Uncaught: TypeError: x', count: 2 },
  ];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') return res.end(JSON.stringify({ ok: true, protocol: 2, app: 'com.example.app', signatureRequired: false, tokenRequired: false }));
      const msg = JSON.parse(body || '{}');
      if (msg.command !== 'oracle.list' || !knows) return res.end(JSON.stringify({ ok: false, code: 'NOT_FOUND', error: `Unknown command "${msg.command}".` }));
      const since = msg.args?.since ?? 0;
      res.end(JSON.stringify({ ok: true, result: { violations: all.filter((v) => v.seq > since), last: 2, findings: 2 } }));
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

test('before a flow: the number and nothing listed; after: only what is new', async () => {
  const b = await bridge();
  try {
    const driver = new DeviceDriver({ port: b.port, serial: false });
    const before = await driver.noticed(Number.MAX_SAFE_INTEGER);
    assert.deepEqual(before, { last: 2, violations: [] });
    const after = await driver.noticed(1);
    assert.deepEqual(after.violations.map((v) => v.rule), ['js.error']);
  } finally {
    b.close();
  }
});

test('an app without the checks answers null, so the runner adds nothing', async () => {
  const b = await bridge({ knows: false });
  try {
    const driver = new DeviceDriver({ port: b.port, serial: false });
    assert.equal(await driver.noticed(0), null);
  } finally {
    b.close();
  }
  const gone = new DeviceDriver({ port: 1, serial: false });
  assert.equal(await gone.noticed(0), null, 'a bridge that is not there');
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
