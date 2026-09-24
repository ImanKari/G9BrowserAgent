/**
 * Per-user browser policies that keep Engine 1 (the extension in the QA's own browser) working
 * when its window is covered or its tab is in the background (V2 plan §P0.4, §2.1, §P7.3c).
 *
 * Rules this module keeps, and why:
 *   - HKCU ONLY. Every key is asserted to start with HKCU\ before any command is built; HKLM is
 *     machine-wide and belongs to IT. There is no code path that can write outside HKCU.
 *   - Record before change. The previous value of every entry (or "absent") is written to
 *     G9_HOME/logs/policies.json BEFORE the first `reg add`, so a crash halfway through still leaves
 *     an exact Undo. Re-applying never replaces a recorded previous value with G9's own value —
 *     otherwise Undo would "restore" 0 where the person originally had nothing.
 *   - Undo restores exactly: a value that existed is written back with its original type and data;
 *     a value that did not exist is deleted. Entries are only dropped from the record once the
 *     restore is verified by reading the registry back.
 *   - Honest about permissions. On a default Windows install HKCU\Software\Policies grants the user
 *     READ only (Administrators have Full Control) — measured on the owner's machine 2026-09-21.
 *     So an unelevated `reg add` fails with "Access is denied"; the caller then offers one UAC
 *     approval that runs the same HKCU-only commands elevated, and the result is verified by an
 *     unelevated read. If the approval ran as a DIFFERENT Windows account, that read will not see
 *     the values, and we say so instead of reporting success.
 *   - A browser ignores a policy name it does not know (edge://policy lists it as unknown). The list
 *     is applied to both browsers as the plan specifies; which ones took effect is visible on the
 *     browser's policy page, and the view says so.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './jsonfile.mjs';

export const POLICY_ROOTS = [
  { browser: 'edge', label: 'Microsoft Edge', key: 'HKCU\\Software\\Policies\\Microsoft\\Edge', policyPage: 'edge://policy' },
  { browser: 'chrome', label: 'Google Chrome', key: 'HKCU\\Software\\Policies\\Google\\Chrome', policyPage: 'chrome://policy' },
];

// `chrome`: the first Chrome version that reads the policy, from Chromium's
// components/policy/resources/templates/policy_definitions (read 2026-09-21). Edge publishes its
// own list; which names it honours shows on edge://policy — not guessed here.
export const POLICIES = [
  {
    name: 'WindowOcclusionEnabled', value: 0, chrome: '90 (Windows)',
    why: 'A covered window, a locked screen or another virtual desktop no longer hides the page, so input still reaches it. (Minimized windows still stop rendering.)',
  },
  {
    name: 'HighEfficiencyModeEnabled', value: 0, chrome: '108',
    why: 'Memory Saver does not discard tabs that are not in front.',
  },
  {
    name: 'IntensiveWakeUpThrottlingEnabled', value: 0, chrome: '85',
    why: 'Background tabs keep their normal JavaScript timers.',
  },
  {
    name: 'BackgroundTabFreezingEnabled', value: 0, chrome: '155',
    why: 'Background tabs are not frozen. Chrome reads this policy from version 155; earlier versions list it as unknown and ignore it.',
  },
  {
    name: 'DeveloperToolsAvailability', value: 1, chrome: '68',
    why: 'DevTools and the debugger API stay allowed (1 = allowed everywhere). The extension cannot work without the debugger API.',
  },
];

const HKCU_PREFIX = /^HKCU\\/i;
const FORBIDDEN = /^(HKLM|HKEY_LOCAL_MACHINE|HKU|HKEY_USERS|HKCR|HKEY_CLASSES_ROOT|HKCC)\b/i;

/** Throws unless the key is under HKCU. The only guard between this module and machine policy. */
export function assertHkcu(key) {
  const k = String(key ?? '');
  if (FORBIDDEN.test(k) || !HKCU_PREFIX.test(k) || k.includes('..') || /[\r\n"]/.test(k)) {
    throw new Error(`Refusing to touch a registry key outside HKCU: ${k}`);
  }
  return k;
}

/** Every (key, value) pair G9 manages. */
export function policyEntries(browsers = POLICY_ROOTS.map((r) => r.browser)) {
  const out = [];
  for (const root of POLICY_ROOTS) {
    if (!browsers.includes(root.browser)) continue;
    for (const p of POLICIES) {
      out.push({ browser: root.browser, key: assertHkcu(root.key), name: p.name, type: 'REG_DWORD', data: p.value, why: p.why, chrome: p.chrome });
    }
  }
  return out;
}

const idOf = (e) => `${e.key.toLowerCase()}|${e.name.toLowerCase()}`;
const VALID_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

function checkName(name) {
  if (!VALID_NAME.test(String(name))) throw new Error(`Unexpected registry value name: ${name}`);
  return name;
}

export function queryArgs(e) {
  return ['query', assertHkcu(e.key), '/v', checkName(e.name)];
}

export function addArgs(e, type = e.type, data = e.data) {
  const t = String(type);
  // REG_BINARY too: Undo must be able to put back whatever type the value had before G9, and
  // `reg query` prints binary data as the hex string `reg add /t REG_BINARY /d` takes.
  if (!/^REG_(DWORD|QWORD|SZ|EXPAND_SZ|MULTI_SZ|BINARY)$/.test(t)) throw new Error(`Unsupported registry type ${t}`);
  return ['add', assertHkcu(e.key), '/v', checkName(e.name), '/t', t, '/d', String(data), '/f'];
}

export function deleteArgs(e) {
  return ['delete', assertHkcu(e.key), '/v', checkName(e.name), '/f'];
}

/** The command a person can read (and paste into a terminal). */
export function displayCommand(args) {
  return `reg ${args.map((a) => (a === '' ? '""' : /[\s\\&|<>^%]/.test(a) && !a.startsWith('/') ? `"${a}"` : a)).join(' ')}`;
}

/**
 * One argument for a line of the elevated .cmd batch. EVERY argument is quoted: unquoted, a
 * previous REG_SZ value such as `a&b` or `x|y` would be read by the ELEVATED cmd.exe as a second
 * command. `%` is doubled (cmd expands %VAR% even inside quotes, and a batch file writes a literal
 * % as %%). A value containing `"` or a line break cannot be passed through cmd safely, so it is
 * refused rather than mangled — the unelevated path (execFile, no shell) still handles it.
 */
export function batchQuote(arg) {
  const a = String(arg);
  if (/["\r\n]/.test(a)) throw new Error(`This value cannot be written through the administrator prompt: ${JSON.stringify(a).slice(0, 80)}`);
  return `"${a.replace(/%/g, '%%')}"`;
}

/** The command that puts back what was there before G9 (or removes what G9 added). */
export function restoreArgs(entry) {
  const prev = entry.previous;
  if (!prev?.exists) return deleteArgs(entry);
  let data = prev.data;
  if (prev.type === 'REG_MULTI_SZ' && Array.isArray(data)) data = data.join('\\0');
  return addArgs(entry, prev.type, data);
}

/**
 * Parse `reg query <key> /v <name>` output.
 *   HKEY_CURRENT_USER\Software\Policies\Microsoft\Edge
 *       WindowOcclusionEnabled    REG_DWORD    0x0
 * @returns {{ exists: boolean, type?, data? }}  DWORD/QWORD data as a number
 */
export function parseRegQuery(stdout, name) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s+(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(line) ?? /^\s+(.+?)\s{2,}(REG_[A-Z_]+)\s*$/.exec(line);
    if (!m) continue;
    if (m[1].trim().toLowerCase() !== String(name).toLowerCase()) continue;
    const type = m[2];
    const raw = (m[3] ?? '').trim();
    let data = raw;
    if (type === 'REG_DWORD' || type === 'REG_QWORD') {
      // A QWORD above 2^53 would lose digits as a Number; keep it as a decimal string then, so Undo
      // writes back exactly the value that was there (reg add takes decimal or 0x hex).
      const big = /^0x[0-9a-f]+$/i.test(raw) ? BigInt(raw) : /^\d+$/.test(raw) ? BigInt(raw) : null;
      data = big === null ? raw : big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString();
    }
    else if (type === 'REG_MULTI_SZ') data = raw ? raw.split('\\0') : [];
    return { exists: true, type, data };
  }
  return { exists: false };
}

/** Default executor: reg.exe with an argument array (no shell, no quoting bugs). */
export function execReg(args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') });
    });
  });
}

/**
 * English only: reg.exe's messages are localized ("Zugriff verweigert", "Accès refusé", …). So this
 * only picks the WORDING of a message; whether elevation is offered never depends on it — any
 * unelevated write that failed is offered the administrator prompt (see refusedMessage).
 */
export function isAccessDenied(result) {
  return /access is denied/i.test(`${result?.stderr ?? ''} ${result?.stdout ?? ''} ${result?.output ?? ''}`);
}

/** The first line reg.exe printed for a failed write, in whatever language Windows speaks. */
function firstFailure(results) {
  const r = results.find((x) => x.code !== 0);
  return r ? String(r.output ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? `exit ${r.code}` : null;
}

function refusedMessage(results, verb) {
  if (results.some((r) => r.code !== 0 && isAccessDenied(r))) {
    return `Windows allows only administrators to ${verb} HKCU\\Software\\Policies. Approve the administrator prompt to continue.`;
  }
  return `Windows refused the change (${firstFailure(results)}). On a default install only administrators may ${verb} HKCU\\Software\\Policies; approve the administrator prompt to continue.`;
}

async function runElevatedSafely(runElevated, batch) {
  try {
    return await runElevated(batch);
  } catch (err) {
    return { code: 1, cancelled: false, error: String(err?.message ?? err) };
  }
}

/** Read the current value of every entry. */
export async function readCurrent(entries, { run = execReg } = {}) {
  const out = [];
  for (const e of entries) {
    const r = await run(queryArgs(e));
    out.push({ ...e, current: r.code === 0 ? parseRegQuery(r.stdout, e.name) : { exists: false } });
  }
  return out;
}

function sameValue(cur, type, data) {
  if (!cur?.exists) return false;
  if (cur.type !== type) return false;
  if (Array.isArray(cur.data) || Array.isArray(data)) return JSON.stringify(cur.data) === JSON.stringify(data);
  return String(cur.data) === String(data);
}

export function readRecord(recordFile) {
  const r = readJson(recordFile, null);
  return r && Array.isArray(r.entries) ? r : { version: 1, entries: [], history: [] };
}

/**
 * Status for the Setup view: per entry, the current value, whether it is at G9's value,
 * and what Undo would restore.
 */
export async function policyStatus({ entries = policyEntries(), run = execReg, recordFile }) {
  const record = readRecord(recordFile);
  const recorded = new Map(record.entries.map((e) => [idOf(e), e]));
  const current = await readCurrent(entries, { run });
  const rows = current.map((e) => {
    const rec = recorded.get(idOf(e));
    return {
      browser: e.browser,
      key: e.key,
      name: e.name,
      type: e.type,
      desired: e.data,
      why: e.why,
      chrome: e.chrome,
      current: e.current,
      applied: sameValue(e.current, e.type, e.data),
      recordedPrevious: rec ? rec.previous : null,
      command: displayCommand(addArgs(e)),
      undoCommand: rec ? displayCommand(restoreArgs(rec)) : null,
    };
  });
  return {
    rows,
    appliedCount: rows.filter((r) => r.applied).length,
    total: rows.length,
    canUndo: record.entries.length > 0,
    record: { appliedAt: record.appliedAt ?? null, by: record.by ?? null, entries: record.entries.length },
  };
}

/**
 * Apply every entry. `run` is unelevated reg.exe. When a write is refused for lack of rights and
 * `runElevated` is given (and `elevate` is true), the remaining writes go through ONE elevated batch.
 * @returns {{ ok, applied, failed, needsElevation, verified, results }}
 */
export async function applyPolicies({
  entries = policyEntries(),
  run = execReg,
  runElevated = null,
  elevate = false,
  recordFile,
  log = null,
  by = null,
}) {
  for (const e of entries) assertHkcu(e.key);
  const record = readRecord(recordFile);
  const known = new Map(record.entries.map((e) => [idOf(e), e]));
  const current = await readCurrent(entries, { run });

  // 1. Record previous values FIRST (keeping any earlier-recorded original).
  for (const e of current) {
    if (!known.has(idOf(e))) {
      known.set(idOf(e), { browser: e.browser, key: e.key, name: e.name, type: e.type, applied: e.data, previous: e.current });
    }
  }
  const pendingRecord = {
    version: 1,
    appliedAt: new Date().toISOString(),
    by,
    state: 'applying',
    entries: [...known.values()],
    history: [...(record.history ?? [])].slice(-20),
  };
  writeJsonAtomic(recordFile, pendingRecord);
  log?.info?.('Policies: previous values recorded', { file: recordFile, entries: pendingRecord.entries.length });

  // 2. Write.
  const todo = current.filter((e) => !sameValue(e.current, e.type, e.data));
  const results = [];
  // Every write the unelevated reg.exe refused, whatever language it said it in.
  const refused = [];
  for (const e of todo) {
    const args = addArgs(e);
    const r = await run(args);
    results.push({ key: e.key, name: e.name, command: displayCommand(args), code: r.code, output: (r.stderr || r.stdout).trim() });
    if (r.code !== 0) refused.push(e);
    log?.[r.code === 0 ? 'info' : 'warn']?.(`Policies: ${displayCommand(args)} → ${r.code === 0 ? 'ok' : (r.stderr || r.stdout).trim()}`);
  }

  let elevatedRun = null;
  if (refused.length && elevate && runElevated) {
    const batch = refused.map((e) => addArgs(e));
    log?.info?.('Policies: writing with administrator approval', { count: batch.length });
    elevatedRun = await runElevatedSafely(runElevated, batch);
    log?.[elevatedRun.code === 0 ? 'info' : 'warn']?.('Policies: elevated batch finished', elevatedRun);
  }

  // 3. Verify by reading back, unelevated — the only proof that counts for this account.
  const after = await readCurrent(entries, { run });
  const verified = after.filter((e) => sameValue(e.current, e.type, e.data));
  const failed = after.filter((e) => !sameValue(e.current, e.type, e.data));
  const finalRecord = { ...pendingRecord, state: failed.length ? 'partial' : 'applied' };
  finalRecord.history = [...pendingRecord.history, { at: new Date().toISOString(), action: 'apply', by, verified: verified.length, failed: failed.length }].slice(-20);
  writeJsonAtomic(recordFile, finalRecord);

  // Offered whenever an unelevated write was refused and values are still missing — never decided
  // by matching reg.exe's (localized) wording.
  const needsElevation = !elevate && failed.length > 0 && refused.length > 0;
  let message;
  if (!failed.length) message = `All ${verified.length} policy values are set.`;
  else if (needsElevation) message = refusedMessage(results, 'write');
  else if (elevatedRun && elevatedRun.code === 0) message = 'The administrator prompt ran, but this account still does not see the values. The approval probably ran as a different Windows account; sign in as an administrator of this account, or ask IT to deploy the policies.';
  else if (elevatedRun) message = `The administrator step did not complete: ${elevatedRun.cancelled ? 'the prompt was declined' : elevatedRun.error ?? `exit ${elevatedRun.code}`}.`;
  else message = `${failed.length} value(s) could not be set${refused.length ? ` (${firstFailure(results)})` : ''}.`;
  log?.[failed.length ? 'warn' : 'info']?.(`Policies: ${message}`);
  return {
    ok: failed.length === 0,
    message,
    needsElevation,
    verified: verified.map((e) => `${e.key}\\${e.name}`),
    failed: failed.map((e) => ({ key: e.key, name: e.name, current: e.current })),
    results,
    elevated: elevatedRun,
  };
}

/**
 * Put every recorded entry back as it was. Entries leave the record only after a verified restore.
 */
export async function undoPolicies({ run = execReg, runElevated = null, elevate = false, recordFile, log = null, by = null }) {
  const record = readRecord(recordFile);
  if (!record.entries.length) return { ok: true, message: 'Nothing to undo: G9 has no recorded policy changes.', restored: [], failed: [] };
  for (const e of record.entries) assertHkcu(e.key);

  const results = [];
  const refused = [];
  for (const e of record.entries) {
    const r0 = await run(queryArgs(e));
    const cur = r0.code === 0 ? parseRegQuery(r0.stdout, e.name) : { exists: false };
    // Already as it was (absent and should be absent, or equal to the previous value): nothing to run.
    if ((!e.previous?.exists && !cur.exists) || (e.previous?.exists && sameValue(cur, e.previous.type, e.previous.data))) continue;
    let args;
    try {
      args = restoreArgs(e);
    } catch (err) {
      // A previous value of a type reg add cannot write: it stays recorded (and is reported below)
      // instead of aborting the undo of every other entry halfway through.
      results.push({ key: e.key, name: e.name, command: null, code: -1, output: err.message });
      log?.warn?.(`Policies undo: ${e.key}\\${e.name} → ${err.message}`);
      continue;
    }
    const r = await run(args);
    results.push({ key: e.key, name: e.name, command: displayCommand(args), code: r.code, output: (r.stderr || r.stdout).trim() });
    if (r.code !== 0) refused.push(e);
    log?.[r.code === 0 ? 'info' : 'warn']?.(`Policies undo: ${displayCommand(args)} → ${r.code === 0 ? 'ok' : (r.stderr || r.stdout).trim()}`);
  }
  let elevatedRun = null;
  if (refused.length && elevate && runElevated) {
    elevatedRun = await runElevatedSafely(runElevated, refused.map((e) => restoreArgs(e)));
    log?.[elevatedRun.code === 0 ? 'info' : 'warn']?.('Policies undo: elevated batch finished', elevatedRun);
  }

  const restored = [];
  const failed = [];
  for (const e of record.entries) {
    const r = await run(queryArgs(e));
    const cur = r.code === 0 ? parseRegQuery(r.stdout, e.name) : { exists: false };
    const ok = e.previous?.exists ? sameValue(cur, e.previous.type, e.previous.data) : !cur.exists;
    (ok ? restored : failed).push(e);
  }
  const next = {
    ...record,
    state: failed.length ? 'partial' : 'undone',
    entries: failed,
    history: [...(record.history ?? []), { at: new Date().toISOString(), action: 'undo', by, restored: restored.length, failed: failed.length }].slice(-20),
  };
  writeJsonAtomic(recordFile, next);
  const needsElevation = !elevate && failed.length > 0 && refused.length > 0;
  const message = !failed.length
    ? `Restored ${restored.length} value(s) to what they were before G9.`
    : needsElevation
      ? refusedMessage(results, 'change')
      : `${failed.length} value(s) could not be restored${results.some((r) => r.code !== 0) ? ` (${firstFailure(results)})` : ''}; they stay recorded so Undo can be retried.`;
  log?.[failed.length ? 'warn' : 'info']?.(`Policies undo: ${message}`);
  return { ok: !failed.length, message, needsElevation, restored: restored.map((e) => `${e.key}\\${e.name}`), failed: failed.map((e) => `${e.key}\\${e.name}`), results, elevated: elevatedRun };
}

/**
 * The lines of the elevated .cmd batch. Pure. Every command is re-checked to be an HKCU-only
 * `reg add`/`reg delete` here too — the batch is the last place a wrong key could slip through —
 * and every argument goes through batchQuote (no cmd metacharacter reaches the elevated shell).
 * `chcp 65001` first: the file is UTF-8, and a temp path with non-ASCII letters (a Persian or
 * German user name) would otherwise be read in the OEM code page and the log would go nowhere.
 */
export function elevatedBatchLines(batch, outFile) {
  for (const args of batch) {
    if (!Array.isArray(args) || !['add', 'delete'].includes(args[0])) throw new Error('Only reg add/delete may be elevated');
    assertHkcu(args[1]);
  }
  const out = batchQuote(outFile);
  const lines = ['@echo off', 'chcp 65001 >nul', `type nul > ${out}`];
  for (const args of batch) {
    lines.push(`reg ${args.map(batchQuote).join(' ')} >> ${out} 2>&1`);
    lines.push(`echo G9EXIT %ERRORLEVEL% >> ${out}`);
  }
  return lines;
}

/**
 * Run a batch of HKCU reg commands elevated (one UAC prompt).
 * Output is captured to a file because an elevated process's stdout cannot be read back. Success
 * needs one `G9EXIT 0` per command: a script that did not run, or stopped early, is not reported
 * as having worked (the caller verifies by reading the registry back either way).
 */
/**
 * The PowerShell that runs the batch elevated. Exported for its test.
 *
 * `/d /s /c ""<path>""`: with /s cmd strips only the OUTER pair of quotes, so a path holding a cmd
 * metacharacter survives. Without /s (and with one pair of quotes) cmd falls back to its old rule —
 * it drops the first and last quote and then parses the bare path — so a %TEMP% under "R&D" or
 * "x^y" split the command in two and the batch never ran: "0 of N commands", after the person had
 * answered a UAC prompt (desktop review, 2026-09-22: 3 of 6 directory names). /d also skips the
 * elevated account's AutoRun command.
 */
export function elevatedLaunchCommand(script) {
  const quoted = `""${script.replace(/'/g, "''")}""`;
  return `try { $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/s','/c','${quoted}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } catch { Write-Error $_.Exception.Message; exit 1223 }`;
}

export function elevatedRegBatch(batch, { tmpDir = os.tmpdir(), timeoutMs = 120_000 } = {}) {
  const stamp = `${process.pid}-${Date.now()}`;
  const script = path.join(tmpDir, `g9-policies-${stamp}.cmd`);
  const outFile = path.join(tmpDir, `g9-policies-${stamp}.log`);
  const lines = elevatedBatchLines(batch, outFile);
  fs.writeFileSync(script, `${lines.join('\r\n')}\r\n`, 'utf8');
  const ps = elevatedLaunchCommand(script);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      let output = '';
      try { output = fs.readFileSync(outFile, 'utf8'); } catch { /* the prompt was declined before the script ran */ }
      for (const f of [script, outFile]) fs.rmSync(f, { force: true });
      const exits = [...output.matchAll(/G9EXIT (\d+)/g)].map((m) => Number(m[1]));
      const incomplete = exits.length < batch.length;
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : incomplete || exits.some((c) => c !== 0) ? 1 : 0;
      const cancelled = /canceled by the user|cancelled by the user/i.test(String(stderr)) || code === 1223;
      const error = cancelled
        ? 'The administrator prompt was declined.'
        : err
          ? String(stderr || err.message).trim()
          : incomplete
            ? `the elevated step reported ${exits.length} of ${batch.length} command(s)`
            : null;
      resolve({ code, cancelled, exits, output: output.trim().slice(0, 4000), error });
    });
  });
}
