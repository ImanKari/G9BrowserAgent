/**
 * A flow's `preconditions` (runner/drivers/device.mjs, 3.8.10): the start state is built from bridge commands before the
 * first step and put back after the flow — newest first, failed flow or not. An unknown key is refused, never skipped.
 * A fake protocol-2 bridge on 127.0.0.1 records what it was asked.
 */

import assert from 'node:assert/strict';
import http from 'node:http';

import { DeviceDriver } from '../../runner/drivers/device.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const NL = String.fromCharCode(10);

async function bridge({ refuse = [] } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') return res.end(JSON.stringify({ ok: true, protocol: 2, app: 'com.example.app', signatureRequired: false }));
      const msg = JSON.parse(body || '{}');
      calls.push({ command: msg.command, args: msg.args });
      if (refuse.includes(msg.command)) return res.end(JSON.stringify({ ok: false, error: `Unknown command "${msg.command}".` }));
      res.end(JSON.stringify({ ok: true, result: msg.command === 'ui.waitIdle' ? { idle: true } : {} }));
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
  return { port: server.address().port, calls, close: () => server.close() };
}

const names = (calls) => calls.filter((c) => c.command !== 'ui.waitIdle').map((c) => c.command);

test('every kind is applied in order, then undone newest first with the flow\'s own cleanup', async () => {
  const b = await bridge();
  try {
    const d = new DeviceDriver({ port: b.port, serial: false });
    const r = await d.applyPreconditions({
      net: 'offline',
      clock: { offsetMs: 86_400_000 },
      seed: 7,
      flags: { reduceMotion: true },
      bridge: [{ command: 'app.theme', args: { theme: 'dark' } }],
      cleanup: [{ command: 'app.theme', args: { theme: 'system' } }],
    });
    assert.deepEqual(r, { ok: true, applied: ['net.shape', 'clock.set', 'state.seed', 'flags.set', 'app.theme'] });
    assert.deepEqual(b.calls[0], { command: 'net.shape', args: { rules: [{ mode: 'offline' }] } });
    assert.ok(b.calls.some((c) => c.command === 'ui.waitIdle'), 'the app settles before the first step');
    b.calls.length = 0;
    assert.deepEqual(await d.undoPreconditions(), []);
    assert.deepEqual(b.calls, [
      { command: 'flags.set', args: { name: 'reduceMotion', value: null } },
      { command: 'state.seed', args: { off: true } },
      { command: 'clock.reset', args: {} },
      { command: 'net.shape', args: { clear: true } },
      { command: 'app.theme', args: { theme: 'system' } },
    ]);
    b.calls.length = 0;
    assert.deepEqual(await d.undoPreconditions(), [], 'a second undo has nothing left');
    assert.equal(b.calls.length, 0);
  } finally {
    b.close();
  }
});

test('an unknown key is refused before anything is sent; a malformed net too', async () => {
  const b = await bridge();
  try {
    const d = new DeviceDriver({ port: b.port, serial: false });
    const r = await d.applyPreconditions({ seed: 1, savepoint: 'clean' });
    assert.equal(r.ok, false);
    assert.match(r.error, /preconditions\.savepoint is not known.*refuse, not skip/);
    assert.equal(b.calls.length, 0);
    assert.match((await d.applyPreconditions({ net: 'slow' })).error, /"offline" or a list/);
    assert.deepEqual(await d.applyPreconditions(undefined), { ok: true, applied: [] });
  } finally {
    b.close();
  }
});

test('a refused command stops there, and what was already set is still undone', async () => {
  const b = await bridge({ refuse: ['state.seed'] });
  try {
    const d = new DeviceDriver({ port: b.port, serial: false });
    const r = await d.applyPreconditions({ clock: { offsetMs: 1000 }, seed: 3, flags: { x: 1 } });
    assert.equal(r.ok, false);
    assert.match(r.error, /^precondition state\.seed failed: Unknown command/);
    assert.deepEqual(names(b.calls), ['clock.set', 'state.seed'], 'flags.set was never sent');
    b.calls.length = 0;
    await d.undoPreconditions();
    assert.deepEqual(names(b.calls), ['clock.reset'], 'only what was set comes back');
  } finally {
    b.close();
  }
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
