/**
 * The AgriPad driver — replays a FlowSpec against a real device over a USB cable.
 *
 * ## Why a driver rather than a second runner
 *
 * FlowSpec was written from the start to carry `target: { kind, adapter }`, and the app's semantic
 * snapshot deliberately emits the same shape the browser agent emits for a web page. That was not
 * decoration: it means one flow format, one comparison engine, one baseline format and one report
 * across web and mobile. What was missing was the twenty lines that speak the device's protocol.
 *
 * ## The transport
 *
 *   node ──HTTP──▶ 127.0.0.1:8799 ──adb forward──▶ device ──▶ QaLocalListener ──▶ QaBridge
 *
 * No Diagnostic server, no operator, no token minted anywhere. A tablet on a desk with a cable in
 * it is a complete test rig. The device end refuses everything it should refuse; this side only
 * has to speak to it and report honestly.
 *
 * ## What it deliberately does NOT claim
 *
 * `ui.tap` actuates a control's own command. That proves the command works; it does not prove a
 * finger could have reached the control. A covered button, a two-pixel hit target and a gesture
 * recogniser that swallows the touch all produce the same result — the command simply never runs —
 * and this driver cannot tell that apart from a working tap. Runs are labelled `gray-box` in the
 * report for exactly that reason, so nobody reads a green suite as proof the UI is reachable.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_PORT = 8799;

/**
 * Find `adb`, rather than assuming somebody put it on PATH.
 *
 * It usually is not. The Android SDK installs platform-tools under
 * `%LOCALAPPDATA%\Android\Sdk` or `C:\Program Files (x86)\Android\android-sdk`,
 * and neither is on PATH by default — a fresh Windows machine with a working
 * emulator still fails here. This driver died with "adb is not recognized" on
 * the first real run (2026-09-10) while `adb devices` worked perfectly from the
 * project's own scripts, which resolve it the same way.
 *
 * A runner that gives up because of PATH is a runner QA stops using, and the
 * fix is ten lines of looking in the places it actually lives.
 */
let cachedAdb = null;

export function resolveAdb() {
  if (cachedAdb) return cachedAdb;
  if (process.env.G9_ADB && fs.existsSync(process.env.G9_ADB)) {
    cachedAdb = process.env.G9_ADB;
    return cachedAdb;
  }

  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null,
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Android\\android-sdk' : null,
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : null,
    path.join(os.homedir(), 'Android', 'Sdk'),
  ].filter(Boolean);

  for (const root of roots) {
    const candidate = path.join(root, 'platform-tools', exe);
    if (fs.existsSync(candidate)) {
      cachedAdb = candidate;
      return cachedAdb;
    }
  }

  // Fall back to the bare name so a PATH install still works, and so the error
  // the OS produces is the one the user sees.
  cachedAdb = exe;
  return cachedAdb;
}

/** Commands that change the screen, and therefore must be followed by a settle. */
const ACTUATING = new Set(['ui.tap', 'ui.type', 'map.selectFeature', 'map.tapFeature', 'map.zoomToFeature']);

export class AgriPadDriver {
  constructor({ port = DEFAULT_PORT, host = '127.0.0.1', token = '', serial = null, log = () => {} } = {}) {
    this.port = port;
    this.host = host;
    this.token = token;
    this.serial = serial;
    this.log = log;
    this.leaseId = null;
  }

  get base() {
    return `http://${this.host}:${this.port}`;
  }

  /**
   * Get a device ready: forward the port, then prove the layer is alive.
   *
   * The self-test is not optional politeness. Every part of this layer can fail SILENTLY — ids
   * trimmed away by the linker, a tree that is unreachable, an allowlist naming a table the schema
   * does not have — and none of those throw. They produce nothing, which reads exactly like "the
   * app is idle and the screen is empty". Running it first turns each into a named check with a
   * number, before a flow can misattribute the emptiness to the product.
   */
  async connect() {
    if (this.serial !== false) {
      await this.forward();
    }

    const hello = await this.get('/qa').catch((err) => {
      throw new Error(
        `Nothing answered on ${this.base}/qa (${err.message}). Check, in order: the cable is in; ` +
          `\`adb forward tcp:${this.port} tcp:${this.port}\` ran; and QA Automation is switched ON ` +
          `on the device under Admin Diagnostics.`,
      );
    });

    if (hello.tokenRequired && !this.token) {
      throw new Error(
        `This device requires an automation token (environment ${hello.environment}). It is shown ` +
          `on the device under Admin Diagnostics → QA Automation. Pass it with --token.`,
      );
    }

    const selftest = await this.command('qa.selftest', {}, { timeoutMs: 60_000 });
    if (!selftest.ok || selftest.result?.verdict !== 'PASS') {
      const failed = (selftest.result?.checks ?? []).filter((c) => !c.ok);
      const failures = failed.map((c) => `  ${c.name}: ${c.detail ?? 'failed'}`).join('\n');

      // Name the ordinary causes rather than leaving a tester to guess from SQL.
      //
      // "no such table" after a fresh install is not a defect and not a broken tool: the
      // device simply has not finished its first sync and the table arrives on its own.
      // Seen live. Without this line it reads like a database bug, which is the exact
      // wrong conclusion to hand somebody who is about to file it.
      const text = failed.map((c) => `${c.name} ${c.detail ?? ''}`).join(' ');
      const hint = /no such table/i.test(text)
        ? '\n\nThis is usually NOT a defect: the device has not finished its first sync, so the '
          + 'table does not exist yet. Give it a few minutes and run again. If it never arrives, '
          + 'open the Sync tab on the device.'
        : /no active database/i.test(text)
          ? '\n\nNobody is logged in on the device. Each user has their own database, so there is '
            + 'nothing to query until somebody signs in. Log in and run again.'
          : '';

      throw new Error(
        `qa.selftest did not pass on this device, so nothing else can be trusted:\n${failures || selftest.error}${hint}`,
      );
    }

    this.log(`device ready — ${hello.environment}, ${selftest.result.checks?.length ?? 0} checks passed`);
    return { hello, selftest: selftest.result };
  }

  /** `adb forward`, with the error a person can act on rather than a stack trace. */
  async forward() {
    const args = [...(this.serial ? ['-s', this.serial] : []), 'forward', `tcp:${this.port}`, `tcp:${this.port}`];
    const { code, stderr } = await run(resolveAdb(), args);
    if (code !== 0) {
      throw new Error(
        `adb forward failed: ${stderr.trim() || `exit ${code}`}. ` +
          `Run \`adb devices\` — if it is empty, the cable or USB debugging is the problem.`,
      );
    }
  }

  /**
   * Take the device for the duration of a run.
   *
   * Mutual exclusion is the one guarantee whose failure is completely silent: two runners
   * interleave, every command succeeds, and the report describes a scenario nobody performed.
   */
  async acquire(owner = 'g9-runner', ttlSeconds = 1800) {
    const res = await this.command('lease.acquire', { owner, ttlSeconds });
    if (!res.ok) throw new Error(`Could not lease the device: ${res.error}`);
    this.leaseId = res.result?.leaseId ?? null;
    return this.leaseId;
  }

  async release() {
    if (!this.leaseId) return;
    await this.command('lease.release', { leaseId: this.leaseId }).catch(() => {});
    this.leaseId = null;
  }

  // --------------------------------------------------------------- flow steps

  /**
   * Execute one FlowSpec step.
   *
   * An unknown action is refused, never skipped. A harness that silently ignores what it does not
   * understand returns green for a test that never ran — the single worst outcome this whole
   * system can produce.
   */
  async step(spec) {
    const target = spec.target?.automationId ?? spec.target?.id ?? null;

    switch (spec.action) {
      case 'click':
        return this.actuate('ui.tap', { automationId: requireId(target, spec) });
      case 'type':
        // The bridge reads args.value (QaBridge): a `text` argument was read by
        // nothing, so every type step "passed" while typing nothing at all.
        return this.actuate('ui.type', { automationId: requireId(target, spec), value: spec.value ?? '' });
      case 'dismiss':
        // The device can close any dialog or sheet; the flow format could not say so.
        //
        // Without this a flow that opens a bottom sheet has no way to leave it: the tab bar
        // underneath is behind the sheet's scrim, and there is no id for a dismiss button because
        // the popup host renders it from a description rather than as a control. The capability
        // existed on the bridge and only the vocabulary was missing.
        return this.actuate('ui.dismissOverlay', {});

      case 'assert':
        return this.assert(spec);
      case 'navigate':
        // A mobile flow has no URL bar. `navigate` on this platform means "wait until this screen
        // is the one on the device", which is what a web navigation means in practice too.
        return this.command('ui.waitFor', { automationId: requireId(target ?? spec.url, spec) });
      default:
        throw new Error(
          `Step "${spec.id}" uses action "${spec.action}", which the AgriPad driver does not ` +
            `implement. Supported: click, type, assert, navigate. Refusing rather than skipping.`,
        );
    }
  }

  async actuate(command, args) {
    const res = await this.command(command, args);
    if (!res.ok) return res;
    if (ACTUATING.has(command)) {
      // Every action ends by waiting for the app to settle. There is no sleep in this driver and
      // there must never be one: a fixed pause is what makes recorded tests flaky, and it hides
      // the very slowness it is compensating for.
      const idle = await this.command('ui.waitIdle', { timeoutMs: 30_000 });
      if (!idle.ok) return { ok: false, error: `${command} ran but the app never settled: ${idle.error}` };
    }
    return res;
  }

  /**
   * The oracles. Two of them exist on no web platform and are the reason mobile testing is worth
   * automating at all.
   */
  /**
   * Which control a `visible` or `value` assertion is about.
   *
   * The id belongs on `target`, the same place every other step carries it. A
   * hand-written flow naturally puts it on the ORACLE instead, and the device
   * then answers `This command needs a "automationId" argument` \u2014 true, and
   * about the command rather than about the flow, which sends the reader to
   * read the bridge instead of their own file.
   *
   * Both shapes are read, because refusing the second one helps nobody, but the
   * error when neither is present names the step and the expected shape.
   */
  static requireAssertId(spec) {
    const automationId = spec.target?.automationId ?? spec.oracle?.automationId ?? null;
    if (automationId) return { automationId };
    return {
      error:
        `step "${spec.id ?? '?'}" asserts ${spec.oracle?.kind} but names no control. ` +
        `Put the id on the step's target: { "target": { "automationId": "Page.Control" } }.`,
    };
  }

  async assert(spec) {
    const oracle = spec.oracle ?? {};
    switch (oracle.kind) {
      case 'visible': {
        const id = AgriPadDriver.requireAssertId(spec);
        if (id.error) return id;
        const res = await this.command('ui.find', { automationId: id.automationId });
        return res.ok
          ? { ok: true, detail: `found ${id.automationId}` }
          : { ok: false, error: res.error };
      }
      case 'value': {
        const id = AgriPadDriver.requireAssertId(spec);
        if (id.error) return id;
        const res = await this.command('ui.find', { automationId: id.automationId });
        if (!res.ok) return res;
        const actual = res.result?.value ?? res.result?.text ?? null;
        return compare(actual, oracle, `value of ${id.automationId}`);
      }
      case 'probe': {
        // The oracle no UI test has. "The toast said saved" and "the row exists and reached the
        // server" are different claims, and in an offline-first client with a sync queue the gap
        // between them is where the hardest defects live.
        const res = await this.command('db.probe', { name: oracle.probe, args: oracle.args ?? [] });
        if (!res.ok) return res;
        return compare(res.result?.value, oracle, `probe ${oracle.probe}(${(oracle.args ?? []).join(', ')})`);
      }
      case 'idle': {
        // WAIT for quiescence; do not sample it.
        //
        // This used to call `app.busy`, which is an instantaneous snapshot, and fail
        // the moment anything at all was in flight. `agripad.smoke` runs an `idle`
        // assertion as its very first step, so any background request that happened
        // to overlap the start of the run reddened the whole suite. Found live: a
        // periodic `GET /api/NewAuth` token refresh takes ~20s from the emulator, and
        // the identical suite passed seconds later with nothing changed.
        //
        // `ui.waitIdle` is the same gate every action already waits on, and the
        // bridge's own notes say so: "Every action waits for app quiescence rather
        // than sleeping; a timeout names what was still busy." An assertion that the
        // app settles is that sentence, not a coin flip on when the step happened to
        // land.
        const budget = oracle.timeoutMs ?? 30_000;
        const res = await this.command('ui.waitIdle', { timeoutMs: budget }, { timeoutMs: budget + 5_000 });
        if (res.result?.idle) return { ok: true, detail: 'app is idle' };

        // Only now ask what is holding it, so the failure names something instead of
        // reporting a bare timeout.
        const busy = await this.command('app.busy', {}).catch(() => null);
        const reasons = (busy?.result?.reasons ?? []).join(', ');
        return {
          ok: false,
          error: `still busy after ${budget}ms${reasons ? `: ${reasons}` : ''}`,
        };
      }
      case 'map': {
        const res = await this.command('map.assertFeatureVisible', {
          layer: oracle.layer,
          entityId: oracle.entityId,
        });
        return res.ok ? { ok: true, detail: `${oracle.entityId} visible on ${oracle.layer}` } : res;
      }
      case 'aria':
      case 'snapshot': {
        const res = await this.command('ui.snapshot', {});
        return res.ok
          ? { ok: true, detail: `${res.result?.nodeCount ?? 0} nodes`, signature: res.result?.tree }
          : res;
      }
      default:
        throw new Error(
          `Assertion kind "${oracle.kind}" is not supported on AgriPad. Supported: visible, value, ` +
            `probe, idle, map, aria. (url/text/network/console are web-only.)`,
        );
    }
  }

  // ---------------------------------------------------------------- transport

  async command(command, args = {}, { timeoutMs = 30_000 } = {}) {
    const body = JSON.stringify({
      command,
      args,
      timeoutMs,
      ...(this.leaseId ? { leaseId: this.leaseId } : {}),
    });

    const headers = { 'content-type': 'application/json' };
    if (this.token) headers['x-qa-token'] = this.token;

    const response = await fetch(`${this.base}/qa`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    });

    if (response.status === 401) {
      throw new Error(
        'The device rejected the automation token. It is shown on the device under ' +
          'Admin Diagnostics → QA Automation; it changes if somebody pressed Rotate.',
      );
    }

    return response.json();
  }

  get(path) {
    return fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json());
  }
}

/**
 * Every device adb can see, with enough detail to pick one.
 *
 * Offline and unauthorised devices are reported rather than filtered out: "adb sees your tablet but
 * it says unauthorized" is the answer to the question somebody is about to ask, and silently
 * showing an empty list sends them looking at the cable instead of at the screen.
 */
export async function listDevices() {
  const { code, stdout, stderr } = await run(resolveAdb(), ['devices', '-l']);
  if (code !== 0) {
    throw new Error(
      `adb is not available at "${resolveAdb()}" (${stderr.trim() || `exit ${code}`}). ` +
        'Install Android platform-tools, or point G9_ADB at the adb executable.',
    );
  }
  return stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      const model = rest.find((part) => part.startsWith('model:'))?.slice(6) ?? null;
      return { serial, state, model };
    });
}

function requireId(value, spec) {
  if (value == null || value === '') {
    throw new Error(
      `Step "${spec.id}" (${spec.action}) has no automationId. A mobile flow addresses controls by ` +
        `automation id — coordinates are not an addressing scheme here and must not become one.`,
    );
  }
  return value;
}

/** Compare an observed value against an oracle, with the message a human needs. */
function compare(actual, oracle, what) {
  const expected = oracle.expected;
  const operator = oracle.operator ?? 'eq';
  const pass =
    operator === 'eq' ? String(actual) === String(expected)
    : operator === 'ne' ? String(actual) !== String(expected)
    : operator === 'gt' ? Number(actual) > Number(expected)
    : operator === 'gte' ? Number(actual) >= Number(expected)
    : operator === 'lt' ? Number(actual) < Number(expected)
    : operator === 'lte' ? Number(actual) <= Number(expected)
    : operator === 'contains' ? String(actual ?? '').includes(String(expected))
    : null;

  if (pass === null) {
    throw new Error(`Unknown comparison operator "${operator}". Refusing rather than guessing.`);
  }
  return pass
    ? { ok: true, detail: `${what} = ${actual}` }
    : { ok: false, error: `${what} is ${actual}, expected ${operator} ${expected}` };
}

/**
 * Spawn a tool and collect its output.
 *
 * ## Why `shell` is off
 *
 * It used to be `shell: process.platform === 'win32'`, which runs the command
 * through cmd.exe by string concatenation. `adb` resolves to
 * `C:\Program Files (x86)\Android\android-sdk\platform-tools\adb.exe` on a
 * normal machine, and cmd then reads that as the program `C:\Program` with
 * arguments — so the driver reported "adb is not available" while pointing at a
 * path that plainly existed. Node warns about this exact hazard (DEP0190).
 *
 * Spawning directly passes the path and each argument as separate values, so
 * spaces are simply not a syntax any more. Nothing here needs a shell: there is
 * no pipe, no glob, no redirection.
 */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err.message) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
