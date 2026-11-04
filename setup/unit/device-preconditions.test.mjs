/**
 * A flow's `preconditions` (runner/drivers/device.mjs, 3.8.10): the start state is built from bridge commands before the
 * first step and put back after the flow — newest first, failed flow or not. An unknown key is refused, never skipped.
 * A fake protocol-2 bridge on 127.0.0.1 records what it was asked.
 */

import assert from 'node:assert/strict';
import http from 'node:http';

import { captureInto, DeviceDriver, needsNewerBridge } from '../../runner/drivers/device.mjs';

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
    const r = await d.applyPreconditions({ seed: 1, teleport: 'clean' });
    assert.equal(r.ok, false);
    assert.match(r.error, /preconditions\.teleport is not known.*refuse, not skip/);
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

// (3.9) A savepoint through the device profile's own tool: the runner fills the template and runs it from the
// project's folder, and knows no format; a profile without one, a bad name, and permissions/os without adb are refused.
test('a savepoint precondition runs the profile\'s load command from the project folder, first', async () => {
  const b = await bridge();
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-sp-'));
  fs.writeFileSync(path.join(dir, 'tool.mjs'), "import fs from 'node:fs'; fs.writeFileSync('called.txt', process.argv.slice(2).join(' '));");
  try {
    const profile = { savepoint: { load: ['node', 'tool.mjs', 'load', '{name}', '--package', '{package}'], save: ['node', 'tool.mjs', 'save', '{name}'] }, root: dir };
    const d = new DeviceDriver({ port: b.port, serial: false, packageName: 'com.example.app', profile, launchTimeoutMs: 300 });
    const r = await d.applyPreconditions({ savepoint: 'signed-in', seed: 1 });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.applied, ['savepoint signed-in', 'state.seed'], 'the savepoint first, then the bridge');
    assert.equal(fs.readFileSync(path.join(dir, 'called.txt'), 'utf8'), 'load signed-in --package com.example.app');
    const saved = await d.savepoint('save', 'x.before');
    assert.equal(saved.ok, true);
    assert.equal(fs.readFileSync(path.join(dir, 'called.txt'), 'utf8'), 'save x.before');
    assert.match((await d.savepoint('save', '../etc')).error, /savepoint name/);
    const none = new DeviceDriver({ port: b.port, serial: false, profile: { root: dir } });
    assert.match((await none.applyPreconditions({ savepoint: 'a' })).error, /names no savepoint\.load/);
    assert.match((await none.applyPreconditions({ permissions: { grant: ['android.permission.CAMERA'] } })).error, /need an Android device over adb/);
    assert.match((await none.applyPreconditions({ os: { appearance: 'dark' } })).error, /need an Android device over adb/);
  } finally {
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// (3.9) A protocol-1 bridge cannot answer a protocol-2 command: SKIPPED with the reason, never a product failure; a
// protocol-2 bridge without the command still fails.
test('a step a protocol-1 bridge cannot answer makes the flow skipped, not failed', async () => {
  const steps = [{ step: 1, action: 'tap', ok: true }, { step: 2, action: 'bridge', ok: false, error: 'Unknown command "screen.model".' }];
  assert.match(needsNewerBridge(steps, 1), /step 2 \(bridge\) needs a protocol-2 bridge/);
  assert.equal(needsNewerBridge(steps, 2), null);
  assert.match(needsNewerBridge([{ step: 0, action: 'preconditions', ok: false, error: 'precondition net.shape failed: Unknown command "net.shape".' }], 1), /needs a protocol-2 bridge/);
  assert.equal(needsNewerBridge([{ step: 1, action: 'tap', ok: false, error: 'No visible control' }], 1), null, 'a real failure stays one');
});
test('capture: a value from a bridge answer becomes a variable; nothing there, a bad name or an object fails the step', () => {
  const vars = { siteId: 's1' };
  assert.equal(captureInto(vars, { drawingId: 'items.0.id', n: 'count' }, { ok: true, result: { items: [{ id: 'd-42' }], count: 3 } }), null);
  assert.deepEqual(vars, { siteId: 's1', drawingId: 'd-42', n: '3' });
  assert.match(captureInto(vars, { x: 'missing.path' }, { ok: true, result: {} }), /no value at "missing.path"/);
  assert.match(captureInto(vars, { x: 'items' }, { ok: true, result: { items: [] } }), /no value/, 'an object is not a value');
  assert.match(captureInto(vars, { 'bad-name': 'a' }, { ok: true, result: { a: 1 } }), /not a variable name/);
  assert.match(captureInto(vars, ['a'], { ok: true }), /must be an object/);
  assert.equal(captureInto(vars, undefined, { ok: true }), null);
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
