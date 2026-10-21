/**
 * The device driver (runner/drivers/device.mjs), the device platforms a project declares (lib/devices.mjs) and
 * the device path of runner/g9.mjs.
 *
 * The apps here are fictional: a project declares two builds of one shop app in g9.project.json "devices" —
 * `shop` (flows in `shop/`, `target.kind: "classic"`, report label `classic`, no package guard) and `shop-next`
 * (flows in `shop-next/`, package com.example.shop.next) — both answering the QA bridge protocol
 * (docs/DEVICE_BRIDGE.md). What is tested is everything that can be proven WITHOUT a device: the profiles,
 * the /proc/net port-owner guard, each FlowSpec step's wire command, the hello/package check, the off-path
 * guard, and the CLI refusing bad input before it ever runs adb.
 *
 * The bridge is a fake HTTP server on 127.0.0.1 (a random port in 18000-18999) that records what it is
 * sent. No device, no adb (the CLI tests point G9_ADB at node itself), no network beyond loopback, never 8765.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DeviceDriver, parseListeningUids, parsePackageUids, siblingPackages, tapFidelity,
} from '../../runner/drivers/device.mjs';
import { normalizeDevicePlatforms, flowFoldersByKind, DEFAULT_BRIDGE_PORT } from '../../lib/devices.mjs';
import { relativePathFor } from '../../daemon/flows.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const G9 = path.join(ROOT, 'runner', 'g9.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** The `devices` section of the fictional project. */
const DEVICES = {
  '//': 'two builds of one app',
  shop: { flowKind: 'classic', label: 'classic', framework: 'classic-ui', errorScreens: ['ErrorPage.'] },
  'shop-next': {
    package: 'com.example.shop.next', framework: 'next-ui', errorScreens: ['ErrorPage.', 'FatalScreen.'],
    crashLog: 'files/logs/last-crash.log',
    selftestHints: [{ match: 'no such table', hint: 'The first sync has not finished yet.' }],
  },
};
const PLATFORMS = normalizeDevicePlatforms(DEVICES).platforms;

// ------------------------------------------------------------------ fake bridge

/** A QA bridge stand-in: GET /qa → `hello`; POST /qa → `answer(command, args)`; every request is kept. */
async function fakeBridge({ hello = { ok: true, service: 'fake', environment: 'Development', tokenRequired: false }, answer } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') return res.end(JSON.stringify(hello));
      const msg = JSON.parse(body || '{}');
      calls.push(msg);
      const result = answer ? answer(msg.command, msg.args ?? {}) : null;
      res.end(JSON.stringify(result ?? { ok: true, result: msg.command === 'ui.waitIdle' ? { idle: true } : {} }));
    });
  });
  // A random port in 18000-18999 (AIGuide rule 7: tests never use 8765 or an OS-chosen port), retried when taken.
  for (let attempt = 0; ; attempt++) {
    const candidate = 18000 + Math.floor(Math.random() * 1000);
    const bound = await new Promise((resolve) => {
      server.once('error', (err) => resolve(err.code === 'EADDRINUSE' && attempt < 20 ? false : Promise.reject(err)));
      server.listen(candidate, '127.0.0.1', () => resolve(true));
    });
    if (bound) break;
  }
  const { port } = server.address();
  return { port, calls, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A driver on the fake bridge: serial=false skips adb entirely (the loopback / desktop path). */
const driverOn = (bridge, extra = {}) => new DeviceDriver({ port: bridge.port, serial: false, profile: PLATFORMS['shop-next'], ...extra });

// ---------------------------------------------------------------- the project's device platforms

test('normalizeDevicePlatforms: defaults, explicit fields, frozen profiles, comment keys skipped', () => {
  const classic = PLATFORMS.shop;
  assert.equal(classic.label, 'classic', 'a project can keep an older report label');
  assert.equal(classic.flowsFolder, 'shop', 'the folder defaults to the name');
  assert.equal(classic.flowKind, 'classic');
  assert.equal(classic.package, null, 'no package = no port guard');
  assert.equal(classic.port, DEFAULT_BRIDGE_PORT);

  const next = PLATFORMS['shop-next'];
  assert.equal(next.label, 'shop-next');
  assert.equal(next.flowKind, 'shop-next', 'the kind defaults to the name, so kind == folder');
  assert.equal(next.package, 'com.example.shop.next');
  assert.deepEqual([...next.errorScreens], ['ErrorPage.', 'FatalScreen.']);
  assert.equal(next.crashLog, 'files/logs/last-crash.log');
  assert.ok(Object.isFrozen(next) && Object.isFrozen(next.errorScreens) && Object.isFrozen(next.selftestHints));

  assert.deepEqual(Object.keys(PLATFORMS), ['shop', 'shop-next'], 'the "//" comment key is not a platform');
  assert.ok(!Object.hasOwn(PLATFORMS, 'constructor'), 'no prototype keys leak through');
});

test('normalizeDevicePlatforms: a bad entry is reported and kept out, the others survive', () => {
  const { platforms, problems } = normalizeDevicePlatforms({
    Good: {}, web: {}, ok: {}, 'bad-package': { package: 'not a package' }, 'bad-port': { port: 70000 }, list: [],
  });
  assert.deepEqual(Object.keys(platforms), ['ok']);
  assert.equal(problems.length, 5, problems.join('\n'));
  assert.deepEqual(normalizeDevicePlatforms(undefined), { platforms: {}, problems: [] });
  assert.equal(normalizeDevicePlatforms(['x']).problems.length, 1);
});

test('flowFoldersByKind and relativePathFor: a kind the project maps goes to its folder, any other kind to its own', () => {
  const kinds = flowFoldersByKind(PLATFORMS);
  assert.deepEqual(kinds, { classic: 'shop', 'shop-next': 'shop-next' });
  const rel = (kind, map) => relativePathFor({ id: 'x', name: 'Language', folder: 'settings', target: { kind } }, map).replace(/\\/g, '/');
  assert.equal(rel('classic', kinds), 'shop/settings/language.flow.json');
  assert.equal(rel('shop-next', kinds), 'shop-next/settings/language.flow.json');
  assert.equal(rel('classic', {}), 'classic/settings/language.flow.json', 'unmapped: the kind is the folder');
  assert.equal(rel(undefined, kinds), 'web/settings/language.flow.json');
});

test('tapFidelity: real-touch only when the device declares it', () => {
  assert.equal(tapFidelity(['ui.tap', 'ui.tap:real-touch']), 'real-touch');
  assert.equal(tapFidelity(['ui.tap']), 'gray-box');
  assert.equal(tapFidelity(null), 'gray-box', 'an app that does not answer qa.capabilities is not assumed real');
});

// ---------------------------------------------------------------- /proc/net guard

const PROC_NET = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:225F 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10250        0 51234 1 0000000000000000 100 0 0 10 0
   1: 0100007F:225F 0100007F:9C40 01 00000000:00000000 00:00000000 00000000 10250        0 51299 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:225E 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10215        0 51111 1 0000000000000000 100 0 0 10 0
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:15B3 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  2000        0 8482 1 0000000000000000 100 0 0 10 0
`;

test('parseListeningUids: only LISTEN sockets on the port, tcp and tcp6', () => {
  assert.deepEqual(parseListeningUids(PROC_NET, 8799), [10250], 'the ESTABLISHED (01) row on 8799 is not a listener');
  assert.deepEqual(parseListeningUids(PROC_NET, 8798), [10215]);
  assert.deepEqual(parseListeningUids(PROC_NET, 5555), [2000], 'tcp6 rows parse too (adbd on 5555 = 0x15B3)');
  assert.deepEqual(parseListeningUids(PROC_NET, 1234), []);
  assert.deepEqual(parseListeningUids('', 8799), []);
});

test('parsePackageUids: package → uid; siblingPackages: the same organisation only', () => {
  const map = parsePackageUids('package:com.example.shop uid:10215\r\npackage:com.example.shop.next uid:10250\npackage:org.other.app uid:10300\njunk\n');
  assert.equal(map.get('com.example.shop'), 10215);
  assert.equal(map.get('com.example.shop.next'), 10250);
  assert.equal(map.size, 3);
  assert.deepEqual(siblingPackages(map.keys(), 'com.example.shop.next'), ['com.example.shop']);
  assert.deepEqual(siblingPackages(map.keys(), 'single'), []);
});

/** A driver whose `adb shell` answers from a script, so ensureApp's decisions can be tested. */
function scriptedDriver(script, packageName = 'com.example.shop.next') {
  const driver = new DeviceDriver({ serial: 'emulator-5554', port: 8799, packageName, launchTimeoutMs: 1_500 });
  driver.shellCalls = [];
  driver.shell = async (command) => {
    driver.shellCalls.push(command);
    return script(command, driver.shellCalls);
  };
  return driver;
}
const PACKAGES = 'package:com.example.shop uid:10215\npackage:com.example.shop.next uid:10250\n';
const listenerOf = (uid) => `  sl  local_address rem_address   st\n   0: 0100007F:225F 00000000:0000 0A 00000000:00000000 00:00000000 00000000 ${uid}        0 1 1\n`;

test('ensureApp: the right app on the port passes without launching anything', async () => {
  const driver = scriptedDriver((cmd) => (cmd.startsWith('cmd package') ? PACKAGES : listenerOf(10250)));
  assert.deepEqual(await driver.ensureApp(), { uid: 10250 });
  assert.ok(!driver.shellCalls.some((c) => c.startsWith('monkey')), 'no launch when the listener is already up');
});

test('ensureApp: another app on the port is refused BY NAME', async () => {
  const driver = scriptedDriver((cmd) => (cmd.startsWith('cmd package') ? PACKAGES : listenerOf(10215)));
  await assert.rejects(driver.ensureApp(), /held by com\.example\.shop, not com\.example\.shop\.next/);
});

test('ensureApp: a package that is not installed says which apps of the same organisation are', async () => {
  const driver = scriptedDriver(() => 'package:com.example.shop uid:10215\n');
  await assert.rejects(driver.ensureApp(), /com\.example\.shop\.next is not installed.*installed: com\.example\.shop\)/);
});

test('ensureApp: nothing listening → launches the app and waits for its listener', async () => {
  let launched = false;
  const driver = scriptedDriver((cmd) => {
    if (cmd.startsWith('cmd package')) return PACKAGES;
    if (cmd.startsWith('monkey')) { launched = true; return 'Events injected: 1'; }
    return launched ? listenerOf(10250) : '';
  });
  assert.deepEqual(await driver.ensureApp(), { uid: 10250 });
  assert.ok(driver.shellCalls.some((c) => c === 'monkey -p com.example.shop.next -c android.intent.category.LAUNCHER 1'));
});

test('ensureApp: launched but never listening fails with a reason, inside the budget', async () => {
  const driver = scriptedDriver((cmd) => (cmd.startsWith('cmd package') ? PACKAGES : ''));
  const started = Date.now();
  await assert.rejects(driver.ensureApp(), /launched but nothing listens on device port 8799/);
  assert.ok(Date.now() - started < 5_000);
});

// ---------------------------------------------------------------- hello / connect

test('connect: a bridge that names ANOTHER package is refused before any command', async () => {
  const bridge = await fakeBridge({ hello: { ok: true, package: 'com.example.shop', tokenRequired: false } });
  try {
    await assert.rejects(
      driverOn(bridge, { packageName: 'com.example.shop.next' }).connect(),
      /belongs to com\.example\.shop, not com\.example\.shop\.next/,
    );
    assert.equal(bridge.calls.length, 0, 'not even qa.selftest reached the wrong app');
  } finally { await bridge.close(); }
});

test('connect: the right package (or a bridge that names none) runs the self-test', async () => {
  for (const hello of [{ ok: true, package: 'com.example.shop.next' }, { ok: true }]) {
    const bridge = await fakeBridge({
      hello,
      answer: (command) => (command === 'qa.selftest' ? { ok: true, result: { verdict: 'PASS', checks: [{ name: 'x', ok: true }] } } : null),
    });
    try {
      const ready = await driverOn(bridge, { packageName: 'com.example.shop.next' }).connect();
      assert.equal(ready.selftest.verdict, 'PASS');
      assert.deepEqual(bridge.calls.map((c) => c.command), ['qa.selftest']);
    } finally { await bridge.close(); }
  }
});

test('connect: a failing self-test shows the profile\'s hint for a message it recognises, and only then', async () => {
  const failing = (detail) => ({ ok: true, result: { verdict: 'FAIL', checks: [{ name: 'db.read', ok: false, detail }] } });
  for (const [detail, hinted] of [['SQLite: no such table: Orders', true], ['disk full', false]]) {
    const bridge = await fakeBridge({ answer: (command) => (command === 'qa.selftest' ? failing(detail) : null) });
    try {
      const error = await driverOn(bridge).connect().then(() => null, (err) => err.message);
      assert.match(error, /qa\.selftest did not pass/);
      assert.equal(/first sync has not finished/.test(error), hinted, error);
    } finally { await bridge.close(); }
  }
});

test('helloPackage / pingBuild read both hello shapes (package or app; build or versionName)', () => {
  assert.equal(DeviceDriver.helloPackage({ app: 'com.example.shop.next' }), 'com.example.shop.next');
  assert.equal(DeviceDriver.helloPackage({ package: 'a.b', app: 'c.d' }), 'a.b');
  assert.equal(DeviceDriver.helloPackage({ app: 'Shop' }), null, 'a display name is not a package id');
  assert.equal(DeviceDriver.helloPackage({ service: 'shop-qa-local' }), null);
  assert.equal(DeviceDriver.pingBuild({ build: '2.4.0 (2400)' }), '2.4.0 (2400)');
  assert.equal(DeviceDriver.pingBuild({ versionName: '3.0.0-next.1' }), '3.0.0-next.1');
  assert.equal(DeviceDriver.pingBuild(null), null);
});

test('connect: the app-id hello shape (app = package id) is checked too', async () => {
  const bridge = await fakeBridge({ hello: { ok: true, service: 'shop-qa-local', app: 'com.example.shop' } });
  try {
    await assert.rejects(driverOn(bridge, { packageName: 'com.example.shop.next' }).connect(), /belongs to com\.example\.shop,/);
  } finally { await bridge.close(); }
});

// ---------------------------------------------------------------- steps → wire

test('the six map/list/picker steps send the documented bridge commands, then settle', async () => {
  const bridge = await fakeBridge();
  try {
    const d = driverOn(bridge);
    const cases = [
      [{ id: 'a', action: 'zoomToFeature', target: { layer: 'Parcels', featureId: 'p1', idField: 'ParcelId' } },
        'map.zoomToFeature', { layer: 'Parcels', featureId: 'p1', idField: 'ParcelId' }],
      [{ id: 'b', action: 'tapFeature', target: { layer: 'Parcels', featureId: 'p1', idField: 'ParcelId' } },
        'map.tapFeature', { layer: 'Parcels', featureId: 'p1', idField: 'ParcelId' }],
      [{ id: 'c', action: 'longPressFeature', target: { layer: 'Roads', entityId: 'r1' } },
        'map.longPressFeature', { layer: 'Roads', featureId: 'r1' }],
      [{ id: 'd', action: 'selectItem', target: { automationId: 'Stores.List', itemId: 42, idField: 'Id' } },
        'ui.selectItem', { automationId: 'Stores.List', itemId: '42', idField: 'Id' }],
      [{ id: 'e', action: 'setValue', target: { automationId: 'Form.Age' }, value: '365.00:00:00' },
        'ui.setValue', { automationId: 'Form.Age', value: '365.00:00:00' }],
      [{ id: 'f', action: 'popupButton', value: 'تأیید' }, 'ui.tapPopupButton', { text: 'تأیید' }],
    ];
    for (const [step, command, args] of cases) {
      bridge.calls.length = 0;
      const out = await d.step(step);
      assert.equal(out.ok, true, `${step.action}: ${out.error ?? ''}`);
      assert.equal(bridge.calls[0].command, command, step.action);
      assert.deepEqual(bridge.calls[0].args, args, step.action);
      assert.equal(bridge.calls[1]?.command, 'ui.waitIdle', `${step.action} must wait for quiescence, never sleep`);
    }
  } finally { await bridge.close(); }
});

test('a map step without a feature, and an unknown action, are refused — never skipped', async () => {
  const bridge = await fakeBridge();
  try {
    const d = driverOn(bridge);
    await assert.rejects(d.step({ id: 'x', action: 'tapFeature', target: { layer: 'Parcels' } }), /needs a map feature/);
    await assert.rejects(d.step({ id: 'y', action: 'swipe' }), /does not implement.*Refusing rather than skipping/);
    assert.equal(bridge.calls.length, 0);
  } finally { await bridge.close(); }
});

test('the map oracle asks map.assertFeatureVisible with featureId (entityId still read)', async () => {
  const bridge = await fakeBridge();
  try {
    const out = await driverOn(bridge).step({ id: 'm', action: 'assert', oracle: { kind: 'map', layer: 'Zones', entityId: 'z9' } });
    assert.equal(out.ok, true);
    assert.deepEqual(bridge.calls[0], { command: 'map.assertFeatureVisible', args: { layer: 'Zones', featureId: 'z9' }, timeoutMs: 30_000 });
  } finally { await bridge.close(); }
});

test('the lease travels with every command once acquired', async () => {
  const bridge = await fakeBridge({ answer: (command) => (command === 'lease.acquire' ? { ok: true, result: { leaseId: 'L1' } } : null) });
  try {
    const d = driverOn(bridge);
    await d.acquire('unit');
    await d.step({ id: 'c', action: 'click', target: { automationId: 'Login.Submit' } });
    // tap, settle, then the off-path look (ui.snapshot): every one carries the lease.
    assert.deepEqual(bridge.calls.slice(1).map((c) => c.command), ['ui.tap', 'ui.waitIdle', 'ui.snapshot']);
    assert.deepEqual(bridge.calls.slice(1).map((c) => c.leaseId), ['L1', 'L1', 'L1']);
  } finally { await bridge.close(); }
});

// ---------------------------------------------------------------- off the path

/** A bridge whose screen is the app's error screen (a profile `errorScreens` prefix). */
const crashedScreen = { ok: true, result: { nodes: [{ automationId: 'FatalScreen.Message' }] } };

test('off path: an idle crashed app does not pass an idle step — it is derailed at once', async () => {
  const bridge = await fakeBridge({ answer: (command) => (command === 'ui.snapshot' ? crashedScreen : null) });
  try {
    const d = driverOn(bridge);
    const started = Date.now();
    const out = await d.step({ id: 'i', action: 'assert', oracle: { kind: 'idle', timeoutMs: 120_000 } });
    assert.equal(out.ok, false);
    assert.equal(out.derailed, true);
    assert.match(out.error, /^DERAILED: .*error screen \(FatalScreen\.Message\)/);
    assert.ok(Date.now() - started < 10_000, 'must not wait out the 120 s budget');
  } finally { await bridge.close(); }
});

test('off path: without errorScreens in the profile, the same screen is just a screen', async () => {
  const bridge = await fakeBridge({ answer: (command) => (command === 'ui.snapshot' ? crashedScreen : null) });
  try {
    const out = await driverOn(bridge, { profile: PLATFORMS.shop }).step({ id: 'c', action: 'click', target: { automationId: 'Login.Submit' } }, { first: true });
    assert.equal(out.ok, true, 'FatalScreen. is shop-next\'s error screen, not shop\'s');
  } finally { await bridge.close(); }
});

test('off path: a click that crashes the app is reported as derailed, not as a pass', async () => {
  const bridge = await fakeBridge({ answer: (command) => (command === 'ui.snapshot' ? crashedScreen : null) });
  try {
    const out = await driverOn(bridge).step({ id: 'c', action: 'click', target: { automationId: 'Login.Submit' } });
    assert.equal(out.ok, false);
    assert.equal(out.derailed, true);
  } finally { await bridge.close(); }
});

test('off path: a bridge refusal that says DERAILED stops the step as derailed', async () => {
  const refusal = { ok: false, error: 'DERAILED: the app is on its error page' };
  const bridge = await fakeBridge({ answer: (command) => (command === 'ui.waitFor' ? refusal : null) });
  try {
    const out = await driverOn(bridge).step({ id: 'n', action: 'navigate', target: { automationId: 'MainPage.Root' } });
    assert.equal(out.derailed, true);
    assert.match(out.error, /^DERAILED:/);
  } finally { await bridge.close(); }
});

test('off path: a long wait is sliced and stops within seconds when the app crashes mid-wait', async () => {
  let crashed = false;
  setTimeout(() => { crashed = true; }, 1_500);
  const bridge = await fakeBridge({
    answer: (command) => {
      if (command === 'ui.snapshot') return crashed ? crashedScreen : { ok: true, result: { nodes: [] } };
      if (command === 'ui.waitFor') return { ok: false, error: 'No visible control with AutomationId "Never.There".' };
      return null;
    },
  });
  try {
    const started = Date.now();
    const out = await driverOn(bridge).step({ id: 'w', action: 'navigate', target: { automationId: 'Never.There' }, waitBudgetMs: 60_000 });
    assert.equal(out.derailed, true);
    assert.ok(Date.now() - started < 15_000, `stopped after ${Date.now() - started} ms, not the 60 s budget`);
  } finally { await bridge.close(); }
});

test('off path: a healthy app passes through the guard unchanged', async () => {
  const bridge = await fakeBridge({ answer: (command) => (command === 'ui.snapshot' ? { ok: true, result: { nodes: [{ automationId: 'MainPage.Root' }] } } : null) });
  try {
    const out = await driverOn(bridge).step({ id: 'c', action: 'click', target: { automationId: 'Login.Submit' } }, { first: true });
    assert.equal(out.ok, true, out.error ?? '');
    assert.equal(out.derailed, undefined);
  } finally { await bridge.close(); }
});

// ---------------------------------------------------------------- the CLI, before adb

/** A throwaway project declaring the two device platforms; returns { dir, write(rel, json) }. */
function tempProject(devices = DEVICES) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'g9-device-'));
  writeFileSync(path.join(dir, 'g9.project.json'), JSON.stringify({ flowsDir: 'Flows', devices }));
  return {
    dir,
    write(rel, json) {
      const file = path.join(dir, 'Flows', rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(json));
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const g9 = (cwd, ...args) => spawnSync(process.execPath, [G9, ...args], {
  cwd, encoding: 'utf8', timeout: 30_000,
  // G9_ADB is node itself: `node devices -l` exits non-zero, so if the CLI ever reached adb in these tests
  // it fails loudly ("adb is not available") instead of finding the machine's real adb (resolveAdb also
  // probes the SDK's fixed install path) and listing — or touching — the devices plugged into it.
  env: { ...process.env, G9_ADB: process.execPath, G9_PROJECT: '' },
});
const flow = (id, kind) => ({
  format: 'g9/flowspec', schemaVersion: 1, id, name: id, target: { kind, adapter: 'x' },
  steps: [{ id: 's1', action: 'assert', oracle: { kind: 'idle' } }],
});

test('cli: an unknown --platform is refused (it used to fall through to the web suite), naming the declared ones', () => {
  const p = tempProject();
  try {
    const out = g9(p.dir, 'run', 'all', '--platform', 'shop_next');
    assert.notEqual(out.status, 0);
    assert.match(out.stderr + out.stdout, /--platform "shop_next" is not a known platform\. Known: web, shop, shop-next\./);
  } finally { p.cleanup(); }
});

test('cli: a project that declares no devices knows only web, and says where devices are declared', () => {
  const p = tempProject(null);
  try {
    const out = g9(p.dir, 'run', 'all', '--platform', 'shop');
    assert.match(out.stderr + out.stdout, /Known: web\. A device platform is declared by the project under test, in g9\.project\.json "devices"/);
  } finally { p.cleanup(); }
});

test('cli: shop-next reads Flows/shop-next/ and refuses a flow of the other app placed there', () => {
  const p = tempProject();
  try {
    p.write('shop/classic.flow.json', flow('classic.only', 'classic'));
    let out = g9(p.dir, 'run', 'all', '--platform', 'shop-next');
    assert.match(out.stderr + out.stdout, /No shop-next flows found under .*shop-next/, 'the other app\'s folder is not this library');

    p.write('shop-next/misplaced.flow.json', flow('misplaced', 'classic'));
    out = g9(p.dir, 'run', 'all', '--platform', 'shop-next');
    assert.match(out.stderr + out.stdout, /target\.kind is "classic", but shop-next\/ holds "shop-next" flows/);
  } finally { p.cleanup(); }
});

test('cli: ${secrets.X} in a device flow is refused with the {{secret:X}} fix', () => {
  const p = tempProject();
  try {
    const f = flow('next.login', 'shop-next');
    f.steps = [{ id: 's1', action: 'type', target: { automationId: 'LoginForm.Password' }, value: '${secrets.SHOP_PASSWORD}' }];
    p.write('shop-next/login.flow.json', f);
    const out = g9(p.dir, 'run', 'all', '--platform', 'shop-next');
    assert.notEqual(out.status, 0);
    assert.match(out.stderr + out.stdout, /"\$\{secrets\.SHOP_PASSWORD\}" is not resolved by this runner\. Write "\{\{secret:SHOP_PASSWORD\}\}"/);
    assert.match(out.stderr + out.stdout, /G9_SECRET_SHOP_PASSWORD/);
  } finally { p.cleanup(); }
});

test('cli: a valid library gets as far as device selection on both platforms', () => {
  const p = tempProject();
  try {
    p.write('shop-next/smoke.flow.json', flow('next.smoke', 'shop-next'));
    p.write('shop/smoke.flow.json', flow('classic.smoke', 'classic'));
    for (const platform of ['shop-next', 'shop']) {
      const out = g9(p.dir, 'run', 'all', '--platform', platform);
      // Past flow loading and validation, stopped at adb (deliberately absent here).
      assert.match(out.stderr + out.stdout, /adb is not available/, `${platform}: ${out.stderr}${out.stdout}`);
    }
    const unknownTarget = g9(p.dir, 'run', 'nope', '--platform', 'shop-next');
    assert.match(unknownTarget.stderr + unknownTarget.stdout, /Known shop-next flows:\s+next\.smoke/);
  } finally { p.cleanup(); }
});

test('cli: --package without a value is an error, not "no guard"', () => {
  const p = tempProject();
  try {
    p.write('shop-next/smoke.flow.json', flow('next.smoke', 'shop-next'));
    for (const command of ['run', 'harvest']) {
      const out = command === 'run'
        ? g9(p.dir, 'run', 'all', '--platform', 'shop-next', '--package')
        : g9(p.dir, 'harvest', '--platform', 'shop-next', '--package');
      assert.notEqual(out.status, 0);
      assert.match(out.stderr + out.stdout, /--package needs a value/, `${command}: checked before adb is asked anything`);
    }
  } finally { p.cleanup(); }
});

test('(3.8.2) a profile\'s flowsFolder stays inside flowsDir, and its crashLog is a plain path', () => {
  for (const flowsFolder of ['shop', 'android/shop']) {
    assert.ok(normalizeDevicePlatforms({ x: { flowsFolder } }).platforms.x, flowsFolder);
  }
  for (const flowsFolder of ['../x', '/abs', 'C:/x', 'a//b', 'a/../b', 'a\\..\\b']) {
    const { platforms, problems } = normalizeDevicePlatforms({ x: { flowsFolder } });
    assert.equal(platforms.x, undefined, flowsFolder);
    assert.match(problems.join('\n'), /must be a folder inside flowsDir/);
  }
  assert.ok(normalizeDevicePlatforms({ x: { crashLog: 'files/crash-last.log' } }).platforms.x);
  for (const crashLog of ['x; reboot', 'a b', '$(id)']) {
    assert.equal(normalizeDevicePlatforms({ x: { crashLog } }).platforms.x, undefined, crashLog);
  }
});

test('(3.8.2) the device shell gets a checked package id and a quoted crash-log path', async () => {
  const { shellPackage, shellQuote } = await import('../../runner/drivers/device.mjs');
  assert.equal(shellPackage('com.example.shop'), 'com.example.shop');
  assert.throws(() => shellPackage('com.x; rm -rf /sdcard/Download'), /not an Android application id/);
  assert.equal(shellQuote("files/my crash.log"), "'files/my crash.log'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  // A profile path that predates the validation (or a value set in code) still reaches the shell quoted.
  const driver = new DeviceDriver({ serial: 's1', packageName: 'com.example.shop.next', profile: { crashLog: "files/my crash.log" } });
  const sent = [];
  driver.shell = async (command) => { sent.push(command); return 'line 1\nline 2\n'; };
  const out = await driver.derailed('the app is on its error screen');
  assert.deepEqual(sent, ["run-as com.example.shop.next cat 'files/my crash.log'"]);
  assert.equal(out.evidence, 'line 1\nline 2');
});

test('(3.8.2) the platform folder of a pushed flow cannot leave the library', () => {
  const at = (kind, kindFolders) => relativePathFor({ target: { kind }, name: 'Smoke', folder: 'a' }, kindFolders).split(path.sep).join('/');
  assert.equal(at('classic', { classic: 'shop' }), 'shop/a/smoke.flow.json');
  assert.equal(at('../../../../Users/x/evil'), 'Users/x/evil/a/smoke.flow.json', 'no ".." survives');
  assert.equal(at({ not: 'a string' }), 'web/a/smoke.flow.json', 'a kind that is not a string is web, not a TypeError');
  assert.equal(at('Classic'), 'Classic/a/smoke.flow.json', 'case is kept: existing folders stay where they are');
});

test('(3.8.2) a derailed flow: its report text is masked and its verdict is not FAIL_PRODUCT', () => {
  const runner = readFileSync(G9, 'utf8');
  const loop = runner.slice(runner.indexOf('let derailed = null;'), runner.indexOf('const passed = steps.filter'));
  assert.ok(loop.indexOf('maskSecretsDeep(outcome') < loop.indexOf('derailed = { step'), 'masked before the derail record is built');
  assert.match(runner, /verdict: derailed \? 'FAIL_AUTOMATION' : verdictForDevice\(steps, failed\)/);
  assert.match(runner, /pushNotRun\(run, flows\.slice\(flowIndex \+ 1\), flow, options, \{ cause: 'derailed' \}\)/);
});

test('cli: (3.8.2) --package that is not an application id is refused before adb', () => {
  const p = tempProject();
  try {
    p.write('shop-next/smoke.flow.json', flow('next.smoke', 'shop-next'));
    const out = g9(p.dir, 'run', 'all', '--platform', 'shop-next', '--package', 'com.x;reboot');
    assert.notEqual(out.status, 0);
    assert.match(out.stderr + out.stdout, /--package "com\.x;reboot" is not an Android application id/);
  } finally { p.cleanup(); }
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
