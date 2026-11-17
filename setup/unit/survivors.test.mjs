/**
 * What a daemon restart takes (daemon/survivors.js, 3.10): the launched engines and tabs are written, the next daemon
 * reads them once, and each reconnecting agent is told about ITS tabs — once — with the way to restore them.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Survivors, engineRecord } from '../../daemon/survivors.js';
import { lostNotice } from '../../daemon/router.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-survivors-'));
const file = path.join(dir, 'state', 'launched.json');

const SNAP = {
  engines: [engineRecord({ engineId: 'launched-3', browser: 'chrome', profile: 'gpt-1', headless: true, stealth: 'stealth', argv: ['--x'], pid: 9 })],
  tabs: [
    { tabId: 41, engine: 'launched-3', url: 'https://chat.example/c/1', title: 'Chat 1', owner: 'agent-7', ownerName: 'claude-code', ownerIdentity: null },
    { tabId: 42, engine: 'launched-3', url: 'https://chat.example/c/2', title: 'Chat 2', owner: 'agent-9', ownerName: 'claude-code', ownerIdentity: 'lwa', session: 'review' },
  ],
};

test('engineRecord keeps what a relaunch needs, not the process details', () => {
  assert.deepEqual(SNAP.engines[0], { engineId: 'launched-3', browser: 'chrome', profile: 'gpt-1', headless: true, stealth: 'stealth' });
});

test('a daemon writes what runs; the next one reads it once and tells each agent its own tabs, once', async () => {
  let now = 1_000_000;
  const first = new Survivors({ file, bootId: 'boot-a', snapshot: async () => SNAP, now: () => now });
  first.start();
  await first.stop();
  assert.ok(fs.existsSync(file));

  now += 60_000;
  const second = new Survivors({ file, bootId: 'boot-b', snapshot: async () => ({ engines: [], tabs: [] }), now: () => now });
  second.start();
  assert.equal(second.claimLost({ bootId: 'boot-x', agentId: 'agent-7' }), null, 'another boot id: not ours');
  const mine = second.claimLost({ bootId: 'boot-a', agentId: 'agent-7' });
  assert.deepEqual(mine.tabs.map((t) => t.tabId), [41]);
  assert.deepEqual(mine.engines.map((e) => e.profile), ['gpt-1']);
  assert.equal(second.claimLost({ bootId: 'boot-a', agentId: 'agent-7' }), null, 'each tab is handed out once');
  assert.deepEqual(second.claimLost({ bootId: 'boot-a', agentId: 'agent-1', identity: 'lwa' }).tabs.map((t) => t.tabId), [42], 'by identity too');
  await second.stop();

  const notice = lostNotice(mine);
  assert.deepEqual(notice.lostTabs, [{ previousTabId: 41, url: 'https://chat.example/c/1', title: 'Chat 1', profile: 'gpt-1' }]);
  assert.match(notice.note, /browser_tabs action:"restore"/);
});

test('a record older than a day is not announced; the daemon\'s own record never is', async () => {
  let now = 5_000_000;
  const a = new Survivors({ file, bootId: 'boot-c', snapshot: async () => SNAP, now: () => now });
  a.start();
  await a.stop();
  const same = new Survivors({ file, bootId: 'boot-c', snapshot: async () => SNAP, now: () => now });
  same.start();
  assert.equal(same.previous, null);
  await same.stop();
  now += 25 * 60 * 60_000;
  const late = new Survivors({ file, bootId: 'boot-d', snapshot: async () => SNAP, now: () => now });
  late.start();
  assert.equal(late.previous, null);
  await late.stop();
});

try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  PASS ${name}`);
    } catch (err) {
      console.log(`  FAIL ${name}\n${err?.stack ?? err}`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
