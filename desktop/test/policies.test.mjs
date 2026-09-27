import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite, tmpDir, rmrf } from './harness.mjs';
import {
  POLICIES, POLICY_ROOTS, policyEntries, assertHkcu, addArgs, deleteArgs, queryArgs, displayCommand, parseRegQuery,
  restoreArgs, applyPolicies, undoPolicies, policyStatus, elevatedRegBatch, readRecord, elevatedLaunchCommand,
} from '../lib/policies.mjs';

const t = suite('desktop: HKCU browser policies (apply / undo)');
const dir = tmpDir();
t.cleanup(() => rmrf(dir));

/**
 * An in-memory registry that answers like reg.exe (same exit codes, same output shape).
 * `denyWrites` reproduces the default ACL of HKCU\Software\Policies (read-only for the user).
 */
function fakeReg(initial = {}, { denyWrites = false, denyText = 'ERROR: Access is denied.' } = {}) {
  const values = new Map(Object.entries(initial)); // "KEY|name" → { type, data }
  const log = [];
  const run = async (args) => {
    log.push(args);
    const [verb, key, , name] = args;
    const k = `${key.toLowerCase()}|${name.toLowerCase()}`;
    if (verb === 'query') {
      const v = values.get(k);
      if (!v) return { code: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' };
      const shown = v.type === 'REG_DWORD' ? `0x${Number(v.data).toString(16)}` : String(v.data);
      return { code: 0, stdout: `\r\nHKEY_CURRENT_USER${key.slice(4)}\r\n    ${name}    ${v.type}    ${shown}\r\n\r\n`, stderr: '' };
    }
    if (denyWrites) return { code: 1, stdout: '', stderr: denyText };
    if (verb === 'add') {
      const type = args[args.indexOf('/t') + 1];
      const data = args[args.indexOf('/d') + 1];
      values.set(k, { type, data: type === 'REG_DWORD' ? Number(data) : data });
      return { code: 0, stdout: 'The operation completed successfully.', stderr: '' };
    }
    if (verb === 'delete') {
      if (!values.has(k)) return { code: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' };
      values.delete(k);
      return { code: 0, stdout: 'The operation completed successfully.', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'bad verb' };
  };
  return { run, values, log };
}

const EDGE = 'HKCU\\Software\\Policies\\Microsoft\\Edge';
const CHROME = 'HKCU\\Software\\Policies\\Google\\Chrome';
const key = (k, n) => `${k.toLowerCase()}|${n.toLowerCase()}`;

t.test('the list: five policies for Edge and for Chrome, all REG_DWORD, all under HKCU', () => {
  assert.deepEqual(POLICIES.map((p) => [p.name, p.value]), [
    ['WindowOcclusionEnabled', 0], ['HighEfficiencyModeEnabled', 0], ['IntensiveWakeUpThrottlingEnabled', 0],
    ['BackgroundTabFreezingEnabled', 0], ['DeveloperToolsAvailability', 1],
  ]);
  assert.deepEqual(POLICY_ROOTS.map((r) => r.key), [EDGE, CHROME]);
  const e = policyEntries();
  assert.equal(e.length, 10);
  assert.ok(e.every((x) => x.key.startsWith('HKCU\\') && x.type === 'REG_DWORD'));
});

t.test('HKLM (and every other hive) is refused before any command is built', () => {
  for (const k of ['HKLM\\Software\\Policies\\Google\\Chrome', 'HKEY_LOCAL_MACHINE\\Software\\x', 'HKU\\S-1-5\\x', 'Software\\x', 'HKCU\\..\\HKLM', 'HKCU\\x"y']) {
    assert.throws(() => assertHkcu(k), /outside HKCU/, k);
    assert.throws(() => addArgs({ key: k, name: 'X', type: 'REG_DWORD', data: 0 }), /outside HKCU/);
  }
  assert.throws(() => elevatedRegBatch([['add', 'HKLM\\Software\\Policies\\Google\\Chrome', '/v', 'X', '/t', 'REG_DWORD', '/d', '0', '/f']]), /outside HKCU/);
  assert.throws(() => elevatedRegBatch([['query', EDGE, '/v', 'X']]), /Only reg add\/delete/);
});

t.test('commands are argument arrays (no shell) and read like what a person would type', () => {
  const e = { key: EDGE, name: 'WindowOcclusionEnabled', type: 'REG_DWORD', data: 0 };
  assert.deepEqual(addArgs(e), ['add', EDGE, '/v', 'WindowOcclusionEnabled', '/t', 'REG_DWORD', '/d', '0', '/f']);
  assert.deepEqual(deleteArgs(e), ['delete', EDGE, '/v', 'WindowOcclusionEnabled', '/f']);
  assert.deepEqual(queryArgs(e), ['query', EDGE, '/v', 'WindowOcclusionEnabled']);
  assert.equal(displayCommand(addArgs(e)), 'reg add "HKCU\\Software\\Policies\\Microsoft\\Edge" /v WindowOcclusionEnabled /t REG_DWORD /d 0 /f');
  assert.throws(() => addArgs({ ...e, name: 'bad name; rm' }), /Unexpected registry value name/);
});

t.test('parseRegQuery reads reg.exe output (DWORD in hex, strings, absent)', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Software\\Policies\\Microsoft\\Edge\r\n    WindowOcclusionEnabled    REG_DWORD    0x1\r\n    HomepageLocation    REG_SZ    https://intra.example/a b\r\n\r\n';
  assert.deepEqual(parseRegQuery(out, 'WindowOcclusionEnabled'), { exists: true, type: 'REG_DWORD', data: 1 });
  assert.deepEqual(parseRegQuery(out, 'homepagelocation'), { exists: true, type: 'REG_SZ', data: 'https://intra.example/a b' });
  assert.deepEqual(parseRegQuery(out, 'Missing'), { exists: false });
  assert.deepEqual(parseRegQuery('', 'X'), { exists: false });
});

t.test('apply records the previous values FIRST, then sets all ten; undo restores exactly', async () => {
  const recordFile = path.join(dir, 'a', 'logs', 'policies.json');
  // The person already had two of these values, one of them with a different type.
  const reg = fakeReg({
    [key(EDGE, 'WindowOcclusionEnabled')]: { type: 'REG_DWORD', data: 1 },
    [key(CHROME, 'DeveloperToolsAvailability')]: { type: 'REG_SZ', data: 'legacy' },
  });
  const r = await applyPolicies({ run: reg.run, recordFile, by: 'qa' });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.verified.length, 10);
  for (const e of policyEntries()) assert.deepEqual(reg.values.get(key(e.key, e.name)), { type: 'REG_DWORD', data: e.data });

  const rec = readRecord(recordFile);
  assert.equal(rec.state, 'applied');
  assert.equal(rec.by, 'qa');
  const prevEdge = rec.entries.find((e) => e.key === EDGE && e.name === 'WindowOcclusionEnabled').previous;
  assert.deepEqual(prevEdge, { exists: true, type: 'REG_DWORD', data: 1 });
  const prevChrome = rec.entries.find((e) => e.key === CHROME && e.name === 'DeveloperToolsAvailability').previous;
  assert.deepEqual(prevChrome, { exists: true, type: 'REG_SZ', data: 'legacy' });
  assert.equal(rec.entries.filter((e) => !e.previous.exists).length, 8);

  // Re-applying must not overwrite the recorded originals with G9BrowserAgent's own values.
  await applyPolicies({ run: reg.run, recordFile, by: 'qa' });
  assert.deepEqual(readRecord(recordFile).entries.find((e) => e.key === EDGE && e.name === 'WindowOcclusionEnabled').previous, prevEdge);

  const u = await undoPolicies({ run: reg.run, recordFile, by: 'qa' });
  assert.equal(u.ok, true, u.message);
  assert.equal(u.restored.length, 10);
  assert.deepEqual([...reg.values.entries()].sort(), [
    [key(EDGE, 'WindowOcclusionEnabled'), { type: 'REG_DWORD', data: 1 }],
    [key(CHROME, 'DeveloperToolsAvailability'), { type: 'REG_SZ', data: 'legacy' }],
  ].sort(), 'exactly what was there before: two values, original types and data; the other eight deleted');
  const after = readRecord(recordFile);
  assert.equal(after.entries.length, 0);
  assert.equal(after.state, 'undone');
  assert.ok(after.history.some((h) => h.action === 'undo'));
  assert.ok(!reg.log.some((a) => /HKLM|HKEY_LOCAL_MACHINE/i.test(a[1])), 'never touched HKLM');
});

t.test('a crash in the middle of apply still leaves an exact undo record', async () => {
  const recordFile = path.join(dir, 'b', 'policies.json');
  const reg = fakeReg();
  let adds = 0;
  const crashing = async (args) => {
    if (args[0] === 'add' && ++adds === 3) throw new Error('power cut');
    return reg.run(args);
  };
  await assert.rejects(applyPolicies({ run: crashing, recordFile }), /power cut/);
  const rec = readRecord(recordFile);
  assert.equal(rec.state, 'applying');
  assert.equal(rec.entries.length, 10, 'every previous value was recorded before the first write');
  const u = await undoPolicies({ run: reg.run, recordFile });
  assert.equal(u.ok, true);
  assert.equal(reg.values.size, 0, 'the two values that were written are removed again');
});

t.test('Access is denied → needsElevation; the elevated batch (HKCU only) finishes the job and is verified', async () => {
  const recordFile = path.join(dir, 'c', 'policies.json');
  const reg = fakeReg({}, { denyWrites: true });
  const r1 = await applyPolicies({ run: reg.run, recordFile });
  assert.equal(r1.ok, false);
  assert.equal(r1.needsElevation, true);
  assert.match(r1.message, /only administrators/);

  let batchSeen = null;
  const unlocked = fakeReg();
  unlocked.values = reg.values; // same hive, as it is for the same Windows account
  const runElevated = async (batch) => {
    batchSeen = batch;
    for (const args of batch) {
      assert.ok(args[1].startsWith('HKCU\\'));
      const type = args[args.indexOf('/t') + 1];
      reg.values.set(key(args[1], args[3]), { type, data: Number(args[args.indexOf('/d') + 1]) });
    }
    return { code: 0, exits: batch.map(() => 0) };
  };
  const r2 = await applyPolicies({ run: reg.run, runElevated, elevate: true, recordFile });
  assert.equal(r2.ok, true, r2.message);
  assert.equal(batchSeen.length, 10);
});

t.test('an approval that ran as another Windows account is detected, not reported as success', async () => {
  const recordFile = path.join(dir, 'd', 'policies.json');
  const reg = fakeReg({}, { denyWrites: true });
  const r = await applyPolicies({ run: reg.run, runElevated: async () => ({ code: 0 }), elevate: true, recordFile });
  assert.equal(r.ok, false);
  assert.match(r.message, /different Windows account/);
});

t.test('status: current values, what is set, and what Undo would run', async () => {
  const recordFile = path.join(dir, 'e', 'policies.json');
  const reg = fakeReg({ [key(EDGE, 'WindowOcclusionEnabled')]: { type: 'REG_DWORD', data: 0 } });
  const s0 = await policyStatus({ run: reg.run, recordFile });
  assert.equal(s0.appliedCount, 1);
  assert.equal(s0.canUndo, false);
  await applyPolicies({ run: reg.run, recordFile });
  const s1 = await policyStatus({ run: reg.run, recordFile });
  assert.equal(s1.appliedCount, 10);
  assert.equal(s1.canUndo, true);
  const row = s1.rows.find((x) => x.key === CHROME && x.name === 'HighEfficiencyModeEnabled');
  assert.equal(row.undoCommand, 'reg delete "HKCU\\Software\\Policies\\Google\\Chrome" /v HighEfficiencyModeEnabled /f');
  const kept = s1.rows.find((x) => x.key === EDGE && x.name === 'WindowOcclusionEnabled');
  assert.equal(kept.undoCommand, 'reg add "HKCU\\Software\\Policies\\Microsoft\\Edge" /v WindowOcclusionEnabled /t REG_DWORD /d 0 /f');
});

t.test('restoreArgs: absent → delete; existing → add with the original type', () => {
  assert.equal(restoreArgs({ key: EDGE, name: 'X', previous: { exists: false } })[0], 'delete');
  assert.deepEqual(restoreArgs({ key: EDGE, name: 'X', previous: { exists: true, type: 'REG_SZ', data: 'v' } }), ['add', EDGE, '/v', 'X', '/t', 'REG_SZ', '/d', 'v', '/f']);
});

t.test('a localized Windows ("Zugriff verweigert") still gets the administrator offer — never decided by English wording', async () => {
  const recordFile = path.join(dir, 'de', 'policies.json');
  const reg = fakeReg({}, { denyWrites: true, denyText: 'FEHLER: Zugriff verweigert' });
  const r = await applyPolicies({ run: reg.run, recordFile });
  assert.equal(r.ok, false);
  assert.equal(r.needsElevation, true, 'offered although reg.exe did not say "Access is denied"');
  assert.match(r.message, /Zugriff verweigert/, 'says what Windows said');
  let seen = 0;
  const r2 = await applyPolicies({
    run: reg.run,
    elevate: true,
    recordFile,
    runElevated: async (batch) => {
      seen = batch.length;
      for (const args of batch) reg.values.set(key(args[1], args[3]), { type: 'REG_DWORD', data: Number(args[args.indexOf('/d') + 1]) });
      return { code: 0, exits: batch.map(() => 0) };
    },
  });
  assert.equal(seen, 10, 'every refused write went to the elevated batch');
  assert.equal(r2.ok, true, r2.message);
  // Undo on the same localized machine: offered as well.
  const u = await undoPolicies({ run: reg.run, recordFile });
  assert.equal(u.ok, false);
  assert.equal(u.needsElevation, true);
});

t.test('an elevated step that throws (a value cmd cannot carry) is reported, never an exception mid-apply', async () => {
  const recordFile = path.join(dir, 'throw', 'policies.json');
  const reg = fakeReg({}, { denyWrites: true });
  const r = await applyPolicies({ run: reg.run, elevate: true, recordFile, runElevated: () => { throw new Error('cannot be written through the administrator prompt'); } });
  assert.equal(r.ok, false);
  assert.match(r.message, /did not complete: cannot be written/);
  assert.equal(readRecord(recordFile).entries.length, 10, 'the previous values stay recorded for Undo');
});

t.test('the elevated batch: every argument quoted, % doubled, cmd metacharacters inert, quotes refused', async () => {
  const { elevatedBatchLines, batchQuote } = await import('../lib/policies.mjs');
  const lines = elevatedBatchLines([['add', EDGE, '/v', 'HomepageLocation', '/t', 'REG_SZ', '/d', 'a&b|c %PATH% ^x', '/f']], 'C:\\Temp\\out.log');
  assert.equal(lines[1], 'chcp 65001 >nul');
  assert.equal(lines[3], 'reg "add" "HKCU\\Software\\Policies\\Microsoft\\Edge" "/v" "HomepageLocation" "/t" "REG_SZ" "/d" "a&b|c %%PATH%% ^x" "/f" >> "C:\\Temp\\out.log" 2>&1');
  assert.throws(() => batchQuote('say "hi"'), /cannot be written through the administrator prompt/);
  assert.throws(() => batchQuote('two\nlines'), /cannot be written/);
  assert.equal(batchQuote(''), '""', 'an empty REG_SZ stays an argument (unquoted, reg would read /f as the data)');
  assert.throws(() => elevatedBatchLines([['add', 'HKLM\\Software\\X', '/v', 'X', '/t', 'REG_DWORD', '/d', '0', '/f']], 'x'), /outside HKCU/);
  // The real cmd.exe reads those lines back as exactly the arguments meant — checked with a
  // harmless program in place of reg.exe (no registry is touched).
  if (process.platform !== 'win32') return;
  const { execFileSync } = await import('node:child_process');
  const probeJs = path.join(dir, 'argv.js');
  fs.writeFileSync(probeJs, 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");');
  const outLog = path.join(dir, 'argv.log');
  const args = ['add', EDGE, '/v', 'HomepageLocation', '/t', 'REG_SZ', '/d', 'a&b|c %PATH% ^x <y> 100%', '/f'];
  const batchText = elevatedBatchLines([args, ['delete', CHROME, '/v', 'X', '/f']], outLog)
    .map((l) => l.replace(/^reg /, `${batchQuote(process.execPath)} ${batchQuote(probeJs)} `))
    .join('\r\n');
  const cmdFile = path.join(dir, 'probe.cmd');
  fs.writeFileSync(cmdFile, `${batchText}\r\n`, 'utf8');
  execFileSync('cmd.exe', ['/d', '/c', cmdFile], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const got = fs.readFileSync(outLog, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.deepEqual(JSON.parse(got[0]), args, 'cmd passed every argument through unchanged');
  assert.equal(got[1].trim(), 'G9EXIT 0');
  assert.deepEqual(JSON.parse(got[2]), ['delete', CHROME, '/v', 'X', '/f']);
});

t.test('the elevated launch survives a %TEMP% path with a cmd metacharacter (R&D, x^y)', async () => {
  // cmd's quote-preserving rule needs /s: without it, cmd drops the outer quotes and splits the
  // line at & or ^, so the batch never ran and Apply reported "0 of N commands" after the person
  // had answered a UAC prompt (desktop review, 2026-09-22: 3 of 6 directory names failed).
  const script = path.join(dir, 'R&D Team', 'g9-policies-1.cmd');
  const ps = elevatedLaunchCommand(script);
  assert.match(ps, /'\/d','\/s','\/c'/, 'cmd /d /s /c');
  assert.ok(ps.includes(`""${script}""`), 'the path keeps its own pair of quotes inside the PowerShell string');
  assert.match(ps, /-Verb RunAs -Wait -PassThru/);

  // It really runs, without elevation: the same string minus -Verb RunAs.
  const { execFile } = await import('node:child_process');
  if (process.platform !== 'win32') return;
  for (const name of ['plain', 'R&D Team', 'x^y', 'Jo (Work)']) {
    const folder = path.join(dir, 'launch', name);
    fs.mkdirSync(folder, { recursive: true });
    const cmdFile = path.join(folder, 'g9-check.cmd');
    const marker = path.join(folder, 'ran.txt');
    fs.writeFileSync(cmdFile, `@echo off\r\n> "${marker}" echo ran\r\n`, 'utf8');
    const command = elevatedLaunchCommand(cmdFile).replace(' -Verb RunAs', '');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 30_000 }, () => resolve()));
    assert.equal(fs.existsSync(marker), true, `the batch ran from a folder named "${name}"`);
  }
  // Four real PowerShell starts: ~1 s each here, over 5 s each on a cold CI agent.
}, { timeoutMs: 120_000 });

t.test('parseRegQuery keeps a QWORD above 2^53 exact, and REG_BINARY can be restored', () => {
  const out = `\r\nHKEY_CURRENT_USER\\Software\\Policies\\Microsoft\\Edge\r\n    Big    REG_QWORD    0xffffffffffffffff\r\n    Bin    REG_BINARY    0100FF\r\n\r\n`;
  assert.deepEqual(parseRegQuery(out, 'Big'), { exists: true, type: 'REG_QWORD', data: '18446744073709551615' });
  const bin = parseRegQuery(out, 'Bin');
  assert.deepEqual(restoreArgs({ key: EDGE, name: 'Bin', previous: bin }), ['add', EDGE, '/v', 'Bin', '/t', 'REG_BINARY', '/d', '0100FF', '/f']);
  assert.deepEqual(restoreArgs({ key: EDGE, name: 'Big', previous: parseRegQuery(out, 'Big') }).slice(5, 8), ['REG_QWORD', '/d', '18446744073709551615']);
});

t.test('undo with nothing recorded is a clear no-op', async () => {
  const r = await undoPolicies({ run: fakeReg().run, recordFile: path.join(dir, 'none', 'policies.json') });
  assert.equal(r.ok, true);
  assert.match(r.message, /Nothing to undo/);
  assert.equal(fs.existsSync(path.join(dir, 'none', 'policies.json')), false);
});

t.run();
