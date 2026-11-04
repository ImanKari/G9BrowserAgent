/**
 * The device steps of 3.8.9 (runner/drivers/device.mjs): longPress, swipe, scroll, screenshot and expectEvent, against
 * a fake protocol-2 bridge on 127.0.0.1 that answers commands and serves `GET /pilot/events` as Server-Sent Events.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { DeviceDriver, eventMatches, parseSseBlock } from '../../runner/drivers/device.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const NL = String.fromCharCode(10);

/** `emitOn[command]` = events the bridge raises when that command runs; `history` = events from before the flow. */
async function bridge({ history = [], emitOn = {}, events = true } = {}) {
  const calls = [];
  const streams = new Set();
  let seq = history.length;
  const all = history.map((e, i) => ({ seq: i + 1, ...e }));
  const frame = (e) => `id: ${e.seq}${NL}event: ${e.kind}${NL}data: ${JSON.stringify(e)}${NL}${NL}`;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/pilot/events')) {
      if (!events) { res.statusCode = 404; return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const e of all) res.write(frame(e));
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') return res.end(JSON.stringify({ ok: true, protocol: 2, app: 'com.example.app', signatureRequired: false, tokenRequired: false }));
      const msg = JSON.parse(body || '{}');
      calls.push(msg);
      for (const e of emitOn[msg.command] ?? []) {
        const event = { seq: ++seq, t: Date.now(), ...e };
        all.push(event);
        setTimeout(() => { for (const s of streams) s.write(frame(event)); }, 30);
      }
      if (msg.command === 'ui.screenshot') return res.end(JSON.stringify({ ok: true, result: { base64: Buffer.from('jpeg-bytes').toString('base64'), width: 10, height: 20 } }));
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
  return {
    port: server.address().port,
    calls,
    close: () => { for (const s of streams) s.end(); server.close(); },
  };
}

test('longPress, swipe and scroll send ui.longPress / ui.swipe and then settle; scroll moves the finger the other way', async () => {
  const b = await bridge();
  try {
    const d = new DeviceDriver({ port: b.port, serial: false });
    const cases = [
      [{ id: 'a', action: 'longPress', target: { automationId: 'List.Row.1' } }, 'ui.longPress', { automationId: 'List.Row.1' }],
      [{ id: 'b', action: 'swipe', target: { automationId: 'Cards' }, direction: 'left', distance: 200 }, 'ui.swipe', { automationId: 'Cards', direction: 'left', distance: 200 }],
      [{ id: 'c', action: 'scroll', target: { automationId: 'Tasks.List' }, direction: 'down' }, 'ui.swipe', { automationId: 'Tasks.List', direction: 'up' }],
      [{ id: 'd', action: 'scroll', value: 'right' }, 'ui.swipe', { direction: 'left' }],
    ];
    for (const [step, command, args] of cases) {
      b.calls.length = 0;
      const out = await d.step(step);
      assert.equal(out.ok, true, `${step.id}: ${out.error ?? ''}`);
      assert.equal(b.calls[0].command, command, step.id);
      assert.deepEqual(b.calls[0].args, args, step.id);
      assert.equal(b.calls[1]?.command, 'ui.waitIdle', `${step.id} must settle, never sleep`);
    }
    await assert.rejects(d.step({ id: 'e', action: 'swipe', direction: 'sideways' }), /needs "direction"/);
    await assert.rejects(d.step({ id: 'f', action: 'longPress' }), /automationId|target/);
  } finally {
    b.close();
  }
});

test('screenshot keeps the picture beside the report, or only says its size without a folder', async () => {
  const b = await bridge();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-shots-'));
  try {
    const kept = await new DeviceDriver({ port: b.port, serial: false, artifactsDir: dir }).step({ id: 's1', action: 'screenshot', name: 'after save/ok' });
    assert.equal(kept.ok, true);
    assert.match(path.basename(kept.screenshot), /^[0-9]+-after-save-ok\.jpg$/);
    assert.equal(fs.readFileSync(kept.screenshot, 'utf8'), 'jpeg-bytes');
    const bare = await new DeviceDriver({ port: b.port, serial: false }).step({ id: 's2', action: 'screenshot' });
    assert.equal(bare.ok, true);
    assert.equal(bare.screenshot, undefined);
  } finally {
    b.close();
  }
});

test('expectEvent: an event the step before raised is found; one from before the flow is not', async () => {
  const b = await bridge({
    history: [{ kind: 'toast', t: Date.now() - 60_000, data: { text: 'ذخیره شد', kind: 'success' } }],
    emitOn: { 'ui.tap': [{ kind: 'toast', data: { text: 'سفارش ذخیره شد', kind: 'success' } }] },
  });
  const d = new DeviceDriver({ port: b.port, serial: false });
  try {
    const flow = { steps: [{ id: 'save', action: 'click' }, { id: 'toast', action: 'expectEvent' }] };
    await d.prepareFlow(flow);
    // Nothing tapped yet: the old toast (a minute ago) must not count.
    const early = await d.step({ id: 'toast0', action: 'expectEvent', kind: 'toast', within: 300 });
    assert.equal(early.ok, false, 'the toast from before the flow counted');
    assert.match(early.error, /no "toast" event within 300 ms/);
    assert.equal((await d.step({ id: 'save', action: 'click', target: { automationId: 'Order.Save' } })).ok, true);
    const hit = await d.step({ id: 'toast', action: 'expectEvent', kind: 'toast', match: { text: 'ذخیره', kind: 'success' }, within: 2_000 });
    assert.equal(hit.ok, true, hit.error);
    assert.equal(hit.event.kind, 'toast');
    const miss = await d.step({ id: 'toast2', action: 'expectEvent', kind: 'toast', match: { kind: 'error' }, within: 200 });
    assert.equal(miss.ok, false);
    assert.match(miss.error, /matching \{"kind":"error"\}.*seen since the step before: toast/);
  } finally {
    d.endFlow();
    b.close();
  }
});

test('expectEvent on a bridge without an event stream fails with the reason; without a kind it is refused', async () => {
  const b = await bridge({ events: false });
  const d = new DeviceDriver({ port: b.port, serial: false });
  try {
    await d.prepareFlow({ steps: [{ id: 'x', action: 'expectEvent' }] });
    const out = await d.step({ id: 'x', action: 'expectEvent', kind: 'toast', within: 2_000 });
    assert.equal(out.ok, false);
    assert.match(out.error, /no event stream.*protocol-1/);
    await assert.rejects(d.step({ id: 'y', action: 'expectEvent' }), /needs "kind"/);
  } finally {
    d.endFlow();
    b.close();
  }
  const plain = new DeviceDriver({ port: 1, serial: false });
  await plain.prepareFlow({ steps: [{ id: 'z', action: 'click' }] });
  assert.equal(plain.events, null, 'a flow without expectEvent opens no stream');
});

test('parseSseBlock and eventMatches: the whole event in data, text contained, nested fields', () => {
  const e = parseSseBlock(['id: 7', 'event: sync.done', 'data: {"seq":7,"t":5,"kind":"sync.done","data":{"site":{"name":"North"},"rows":3}}'].join(NL));
  assert.deepEqual(e, { seq: 7, kind: 'sync.done', data: { site: { name: 'North' }, rows: 3 }, t: 5 });
  assert.equal(parseSseBlock(': keep-alive'), null);
  assert.equal(eventMatches(e.data, { site: { name: 'Nor' }, rows: 3 }), true);
  assert.equal(eventMatches(e.data, { rows: 4 }), false);
  assert.equal(eventMatches(e.data, {}), true);
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
