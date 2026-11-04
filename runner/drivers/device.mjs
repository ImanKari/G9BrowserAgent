/**
 * The device driver — replays a FlowSpec against an app on a real phone or tablet over a USB cable (or an
 * emulator), through the app's QA bridge.
 *
 * ## Why a driver rather than a second runner
 *
 * FlowSpec was written from the start to carry `target: { kind, adapter }`, and a QA bridge's semantic
 * snapshot deliberately emits the same shape the browser agent emits for a web page. That was not
 * decoration: it means one flow format, one comparison engine, one baseline format and one report
 * across web and mobile. What was missing was the code that speaks the device's protocol.
 *
 * ## The transport (docs/DEVICE_BRIDGE.md)
 *
 *   node ──HTTP──▶ 127.0.0.1:<port> ──adb forward──▶ device ──▶ the app's QA bridge
 *
 * No server, no operator, no token minted anywhere. A device on a desk with a cable in it is a complete
 * test rig. The app's bridge refuses everything it should refuse; this side only has to speak to it and
 * report honestly.
 *
 * ## Which app — the project says (lib/devices.mjs)
 *
 * Nothing here names a product. A project declares its device apps in `g9.project.json` ("devices"): the
 * package that must own the bridge port, where the flows live, the app's error screen, its crash log.
 * This driver takes one such profile and nothing else.
 *
 * ## What it deliberately does NOT claim
 *
 * Many bridges implement `ui.tap` by actuating a control's own command. That proves the command works;
 * it does not prove a finger could have reached the control. A covered button, a two-pixel hit target
 * and a gesture recogniser that swallows the touch all produce the same result — the command simply never
 * runs — and this driver cannot tell that apart from a working tap. Such runs are labelled `gray-box` in
 * the report for exactly that reason. A bridge that taps for real (a touch injected at the control's
 * measured centre) declares `ui.tap:real-touch` in qa.capabilities, and its runs are labelled
 * `real-touch` (tapFidelity).
 */

import { spawn } from 'node:child_process';
import { signRequest } from './signing.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_BRIDGE_PORT, PACKAGE } from '../../lib/devices.mjs';

/**
 * (3.8.2) What goes into an `adb shell` command line. adb hands the line to the device's shell, so a package
 * id is checked against the application-id grammar and a path is single-quoted: `--package "x; reboot"` or a
 * project's crashLog must never run as a command (and a path with a space must read that file).
 */
export function shellPackage(pkg) {
  if (typeof pkg !== 'string' || !PACKAGE.test(pkg)) throw new Error(`"${pkg}" is not an Android application id (e.g. com.example.app).`);
  return pkg;
}
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * The uids of the sockets LISTENING on `port`, from the text of `/proc/net/tcp` + `/proc/net/tcp6`.
 *
 * Columns: `sl local_address rem_address st … uid …`; `local_address` is `<hex ip>:<hex port>` and state
 * `0A` is LISTEN. Readable by the adb shell user (verified on API 36), unlike `netstat -p`, which needs
 * root to name the process.
 */
export function parseListeningUids(procNetText, port) {
  const wanted = Number(port).toString(16).toUpperCase().padStart(4, '0');
  const uids = new Set();
  for (const line of String(procNetText ?? '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8 || !cols[0].endsWith(':')) continue;
    const localPort = cols[1].split(':').pop()?.toUpperCase();
    if (localPort === wanted && cols[3] === '0A') uids.add(Number(cols[7]));
  }
  return [...uids].filter((uid) => Number.isInteger(uid));
}

/**
 * How much a passing `click` proves on this device. A bridge that actuates the control's own command is
 * `gray-box` (the command works, a finger might still not reach it). A bridge that injects a REAL touch
 * at the control's measured centre says so with the capability `ui.tap:real-touch`, and its runs are
 * labelled `real-touch` — a covered or off-screen control then fails the step.
 */
export function tapFidelity(features) {
  return Array.isArray(features) && features.includes('ui.tap:real-touch') ? 'real-touch' : 'gray-box';
}

/** `cmd package list packages -U` output → Map(package → uid). */
export function parsePackageUids(text) {
  const map = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const m = /^package:(\S+)\s+uid:(\d+)/.exec(line.trim());
    if (m) map.set(m[1], Number(m[2]));
  }
  return map;
}

/** The installed packages that share `pkg`'s organisation prefix (`com.example.*`), for a "not installed" message. */
export function siblingPackages(packages, pkg) {
  const prefix = String(pkg ?? '').split('.').slice(0, 2).join('.');
  if (!prefix.includes('.')) return [];
  return [...packages].filter((name) => name !== pkg && name.startsWith(`${prefix}.`));
}

/**
 * Find `adb`, rather than assuming somebody put it on PATH.
 *
 * It usually is not. The Android SDK installs platform-tools under
 * `%LOCALAPPDATA%\Android\Sdk` or `C:\Program Files (x86)\Android\android-sdk`,
 * and neither is on PATH by default — a fresh Windows machine with a working
 * emulator still fails here. This driver died with "adb is not recognized" on
 * its first real run (2026-09-10) while `adb devices` worked perfectly from a
 * terminal that had the SDK on its PATH.
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

/** The start of every off-path refusal — the bridge's own (docs/DEVICE_BRIDGE.md) and this driver's. */
export const DERAILED_PREFIX = 'DERAILED:';

/**
 * Actions that do not end in a settle wait. Every other action's settle wait already looks for an off-path app
 * (waitInSlices); these are looked at once after they ran.
 */
const UNSETTLED_ACTIONS = new Set(['dismiss']);

/** Commands that change the screen, and therefore must be followed by a settle. */
const ACTUATING = new Set([
  'ui.tap', 'ui.type', 'ui.selectItem', 'ui.setValue', 'ui.tapPopupButton',
  'map.selectFeature', 'map.tapFeature', 'map.longPressFeature', 'map.zoomToFeature',
  'ui.longPress', 'ui.swipe',
]);

/** (3.8.9) `swipe` / `scroll` directions; a scroll moves the finger the other way. */
const SWIPE_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
/** (3.8.10) The keys a flow's `preconditions` may have. */
const PRECONDITION_KEYS = new Set(['net', 'clock', 'seed', 'flags', 'bridge', 'cleanup', 'savepoint', 'permissions', 'os']);
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

export class DeviceDriver {
  /**
   * @param {object} options
   * @param {object|null} [options.profile] the device platform (lib/devices.mjs): error screens, crash log,
   *   hints. Null = a bare bridge with no app-specific knowledge.
   * @param {string|null} [options.packageName] the Android package that must own the device port (`--package`,
   *   or the profile's `package`). null = drive whatever answers.
   * @param {number} [options.launchTimeoutMs] how long to wait for the app's listener after launching it.
   */
  constructor({
    port = DEFAULT_BRIDGE_PORT, host = '127.0.0.1', token = '', serial = null, packageName = null,
    profile = null, launchTimeoutMs = 45_000, log = () => {}, signing = null, artifactsDir = null,
  } = {}) {
    this.port = port;
    this.host = host;
    this.token = token;
    this.serial = serial;
    this.packageName = packageName;
    this.profile = profile;
    this.launchTimeoutMs = launchTimeoutMs;
    this.log = log;
    this.leaseId = null;
    // {key, kid, source} for a bridge that requires signed requests (./signing.mjs); null signs nothing.
    this.signing = signing;
    this.hello = null;
    this.clockOffsetMs = 0;
    // (3.8.9) Where a `screenshot` step writes its picture (the run's report folder); null keeps no file.
    this.artifactsDir = artifactsDir;
    // (3.8.9) The event stream of the current flow (expectEvent), and when the previous and current steps began.
    this.events = null;
    this.stepAt = { previous: 0, current: 0 };
    // (3.9) adb shell commands that put back what preconditions.permissions / os changed.
    this.undoShell = [];
  }

  /**
   * (3.9) A savepoint of the app's data through the device profile's own tool (g9.project.json devices.<id>.savepoint:
   * {save: [cmd…], load: [cmd…]}, with {name}, {package}, {serial}, {port} filled in; run from the project's folder).
   * The runner knows no savepoint format — the app's controller does. After a save or a load the app is started again
   * and the runner waits for its bridge. Returns { ok, output } or { ok: false, error }.
   */
  async savepoint(verb, name) {
    const template = this.profile?.savepoint?.[verb];
    if (!Array.isArray(template) || !template.length) return { ok: false, error: `the device profile names no savepoint.${verb} command (g9.project.json devices.<id>.savepoint)` };
    if (!name || !/^[A-Za-z0-9._-]{1,64}$/.test(String(name))) return { ok: false, error: `a savepoint name is letters, digits, . _ - (got «${name}»)` };
    const fill = (x) => String(x).replace(/\{name\}/g, name).replace(/\{package\}/g, this.packageName ?? '').replace(/\{serial\}/g, this.serial ?? '').replace(/\{port\}/g, String(this.port));
    const [cmd, ...args] = template.map(fill);
    // The tool gets the adb this runner uses (ADB), so it needs no PATH of its own.
    const r = await run(cmd === 'node' ? process.execPath : cmd, args, { cwd: this.profile?.root, env: { ...process.env, ADB: resolveAdb() } });
    if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().split(NL).slice(-2).join(' ').slice(0, 300) || `exit ${r.code}` };
    // A save stops the app too (no database copied half-written): both come back to a running app with its bridge.
    if (this.serial !== false && this.packageName) await this.ensureApp();
    for (const until = Date.now() + this.launchTimeoutMs; Date.now() < until; ) {
      const hello = await this.get('/qa').catch(() => null);
      if (hello?.jsReady) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { ok: true, output: r.stdout.trim().slice(-400) };
  }

  get base() {
    return `http://${this.host}:${this.port}`;
  }

  /**
   * Get a device ready: forward the port, then prove the layer is alive.
   *
   * The self-test is not optional politeness. Every part of a bridge can fail SILENTLY — ids trimmed away
   * by a linker, a tree that is unreachable, a probe naming a table the schema does not have — and none of
   * those throw. They produce nothing, which reads exactly like "the app is idle and the screen is empty".
   * Running it first turns each into a named check with a number, before a flow can misattribute the
   * emptiness to the product.
   */
  async connect() {
    if (this.serial !== false) {
      await this.forward();
      if (this.packageName) await this.ensureApp();
    }

    const hello = await this.get('/qa').catch((err) => {
      throw new Error(
        `Nothing answered on ${this.base}/qa (${err.message}). Check, in order: the cable is in; ` +
          `\`adb forward tcp:${this.port} tcp:${this.port}\` ran; and the app's QA bridge is switched on` +
          `${this.profile?.setupHint ? ` (${this.profile.setupHint})` : ''}.`,
      );
    });

    // A bridge that names its package must name the one we were asked to drive. The /proc/net guard above
    // already proved it for a cabled device; this also covers serial=false (a desktop build on loopback)
    // and a forward that points somewhere unexpected.
    const helloPackage = DeviceDriver.helloPackage(hello);
    if (this.packageName && helloPackage && helloPackage !== this.packageName) {
      throw new Error(
        `The automation bridge on ${this.base} belongs to ${helloPackage}, not ${this.packageName}. ` +
          `Another app holds port ${this.port}: stop it, or point --device-port at the right one.`,
      );
    }

    this.hello = hello;
    if (typeof hello.deviceTime === 'number') this.clockOffsetMs = hello.deviceTime - Date.now();
    if (hello.signatureRequired && !this.signing) {
      throw new Error(
        `This device's bridge requires signed requests (keys ${JSON.stringify(hello.kids ?? [])}), and no signing key ` +
          'was found: set G9_SECRET_DEVICE_SIGNING_KEY, or name a key file / OS store in the device profile ' +
          '(`signing: { kid, key: { file | windows | macos } }`, docs/DEVICE_BRIDGE.md «Signed bridges»).',
      );
    }
    if (this.signing) this.log(`signing as ${this.signing.kid ?? hello.kids?.[0] ?? '?'} (key from ${this.signing.source})`);

    if (hello.tokenRequired && !this.token) {
      throw new Error(
        `This device requires an automation token (environment ${hello.environment}). ` +
          `${this.profile?.tokenHint ? `${this.profile.tokenHint} ` : 'The app shows it on its QA bridge settings. '}Pass it with --token.`,
      );
    }

    const selftest = await this.command('qa.selftest', {}, { timeoutMs: 60_000 });
    if (!selftest.ok || selftest.result?.verdict !== 'PASS') {
      const failed = (selftest.result?.checks ?? []).filter((c) => !c.ok);
      const failures = failed.map((c) => `  ${c.name}: ${c.detail ?? 'failed'}`).join('\n');

      // Name the ordinary causes rather than leaving a tester to guess from a raw check. A project knows
      // which of its own self-test messages are expected states (a first sync still running, nobody signed
      // in) and says so in its profile's `selftestHints`; the first one whose text matches is shown.
      const text = failed.map((c) => `${c.name} ${c.detail ?? ''}`).join(' ');
      const hint = (this.profile?.selftestHints ?? []).find((h) => text.toLowerCase().includes(h.match.toLowerCase()))?.hint;

      throw new Error(
        `qa.selftest did not pass on this device, so nothing else can be trusted:\n${failures || selftest.error}${hint ? `\n\n${hint}` : ''}`,
      );
    }

    this.log(`device ready — ${hello.environment}, ${selftest.result.checks?.length ?? 0} checks passed`);
    return { hello, selftest: selftest.result };
  }

  /** The package a bridge's hello names, if any: `package`, or `app` when it is an application id. */
  static helloPackage(hello) {
    if (typeof hello?.package === 'string' && hello.package) return hello.package;
    return typeof hello?.app === 'string' && /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(hello.app) ? hello.app : null;
  }

  /** The app build a `qa.ping` result reports: `build`, or `versionName`. */
  static pingBuild(result) {
    return result?.build ?? result?.versionName ?? null;
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

  /** `adb [-s serial] shell <command>` → stdout; throws with adb's own words on failure. */
  async shell(command) {
    const args = [...(this.serial ? ['-s', this.serial] : []), 'shell', command];
    const { code, stdout, stderr } = await run(resolveAdb(), args);
    if (code !== 0) throw new Error(`adb shell "${command}" failed: ${stderr.trim() || `exit ${code}`}`);
    return stdout;
  }

  /**
   * Make sure the device port is served by `this.packageName`, launching the app when nothing listens.
   *
   * Three outcomes, each with the sentence a person can act on:
   * - the package is not installed → say so (and which packages of the same organisation ARE installed);
   * - nothing listens on the port → launch the app's launcher activity and wait for its listener
   *   (`launchTimeoutMs`);
   * - another app listens → refuse, naming that app. Two builds of one product often share a bridge port,
   *   and driving the wrong one would produce a report about the wrong app with every step green.
   */
  async ensureApp() {
    const pkg = this.packageName;
    const packages = parsePackageUids(await this.shell('cmd package list packages -U'));
    const uid = packages.get(pkg);
    if (uid == null) {
      const siblings = siblingPackages(packages.keys(), pkg);
      throw new Error(
        `${pkg} is not installed on ${this.serial ?? 'the device'}` +
          `${siblings.length ? ` (installed: ${siblings.join(', ')})` : ''}. Install the build to test, or pass --package.`,
      );
    }

    const owners = async () => parseListeningUids(await this.shell('cat /proc/net/tcp /proc/net/tcp6'), this.port);
    let listening = await owners();
    if (!listening.length) {
      this.log(`nothing listens on device port ${this.port}; launching ${pkg}`);
      await this.shell(`monkey -p ${shellPackage(pkg)} -c android.intent.category.LAUNCHER 1`);
      const deadline = Date.now() + this.launchTimeoutMs;
      while (!listening.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        listening = await owners();
      }
      if (!listening.length) {
        throw new Error(
          `${pkg} was launched but nothing listens on device port ${this.port} after ` +
            `${Math.round(this.launchTimeoutMs / 1000)} s. Is this a build with the QA bridge, ` +
            `and does it use port ${this.port}?`,
        );
      }
    }
    if (!listening.includes(uid)) {
      const holders = listening.map((u) => [...packages].find(([, v]) => v === u)?.[0] ?? `uid ${u}`);
      throw new Error(
        `Device port ${this.port} is held by ${holders.join(', ')}, not ${pkg}. Two apps share the ` +
          `port: force-stop the other one (adb shell am force-stop <package>) or move it to another port.`,
      );
    }
    this.log(`device port ${this.port} is served by ${pkg} (uid ${uid})`);
    return { uid };
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
  async step(spec, { first = false } = {}) {
    // Off-path guard. A flow assumes one path through the app; the moment the app leaves it — its error
    // screen, a dead process — every later step tests nothing, and each used to wait out its own budget
    // first (an error screen is IDLE, so `idle` steps even passed). Checked before a flow's first step,
    // after every action and on every failure; long waits are sliced so a crash mid-wait is seen within seconds.
    if (first) {
      const already = await this.derailment();
      if (already) return this.derailed(already);
    }

    // (3.8.9) An expectEvent step looks at what happened since the step BEFORE it began.
    this.stepAt = { previous: this.stepAt.current, current: Date.now() };
    // A refusal (unknown action, malformed step) stays a throw and reaches no device: the caller's contract.
    const outcome = await this.stepCore(spec);
    if (outcome.derailed) return outcome;
    if (String(outcome.error ?? '').includes(DERAILED_PREFIX)) return this.derailed(outcome.error);
    if (!outcome.ok || UNSETTLED_ACTIONS.has(spec.action)) {
      const after = await this.derailment();
      if (after) return this.derailed(after, outcome.ok ? null : outcome.error);
    }
    return outcome;
  }

  /**
   * Has the app left the path every flow assumes? Null while it has not.
   *
   * Reads the screen rather than trusting a bridge feature, so it works against any build — including an old
   * build under test in an upgrade run, whose bridge predates the DERAILED refusal. The app's error screen is
   * known by the automation-id prefixes of the profile's `errorScreens`.
   */
  async derailment() {
    // (3.9.4) Only the error screens' own controls are measured (`prefixes`; an older bridge ignores it and measures all),
    // and none at all when the profile names no error screen: the check after every step cost ~0.5 s (plan P2-07).
    const prefixes = this.profile?.errorScreens ?? [];
    const snap = prefixes.length
      ? await this.command('ui.snapshot', { maxNodes: 80, prefixes }, { timeoutMs: 8_000 }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }))
      : { ok: true, result: { nodes: [] } };
    if (snap?.ok) {
      if (!this.servingPackage) this.servingPackage = await this.packageOnPort().catch(() => null);
      const ids = (snap.result?.nodes ?? []).map((n) => n.automationId ?? '').filter(Boolean);
      const hit = prefixes.length ? ids.find((id) => prefixes.some((p) => id.startsWith(p))) : null;
      return hit ? `the app is on its error screen (${hit}) — it crashed or failed to initialize` : null;
    }
    const pkg = this.packageName ?? this.servingPackage;
    if (this.serial !== false && pkg) {
      const pid = (await this.shell(`pidof ${shellPackage(pkg)}`).catch(() => '')).trim();
      if (!pid) return `the app process ${pkg} is not running — it crashed or was killed`;
    }
    return null;
  }

  /**
   * The package whose process listens on the bridge port, read while it is alive (a profile may name no
   * package: each build flavour of an app can have its own). Remembered, so a process that died can still
   * be named and its log read.
   */
  async packageOnPort() {
    if (this.serial === false) return null;
    const listening = parseListeningUids(await this.shell('cat /proc/net/tcp /proc/net/tcp6'), this.port);
    if (!listening.length) return null;
    const packages = parsePackageUids(await this.shell('cmd package list packages -U'));
    return [...packages].find(([, uid]) => listening.includes(uid))?.[0] ?? null;
  }

  /**
   * A derailed step: failed, marked, with the app's own last crash record as evidence for whoever takes over
   * (the profile's `crashLog`, an app-private file read with `run-as`, so only a debuggable build has it).
   */
  async derailed(reason, stepError = null) {
    let evidence = null;
    const crashLog = this.profile?.crashLog;
    const pkg = crashLog ? (this.packageName ?? this.servingPackage ?? (await this.packageOnPort().catch(() => null))) : null;
    if (this.serial !== false && pkg) {
      const text = await this.shell(`run-as ${shellPackage(pkg)} cat ${shellQuote(crashLog)}`).catch(() => '');
      evidence = text.split('\n').slice(0, 12).join('\n').trim() || null;
    }
    const why = String(reason).startsWith(DERAILED_PREFIX) ? String(reason) : `${DERAILED_PREFIX} ${reason}`;
    return {
      ok: false,
      derailed: true,
      error: stepError ? `${why} (the step itself said: ${stepError})` : why,
      ...(evidence ? { evidence } : {}),
    };
  }

  /**
   * Wait in slices of at most 5 s, looking for an off-path app between them. `done(res)` says a slice answered
   * what was asked; the last answer is returned when the budget runs out.
   */
  async waitInSlices(command, args, budgetMs, done) {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const slice = Math.max(1_000, Math.min(5_000, deadline - Date.now()));
      const res = await this.command(command, { ...args, timeoutMs: slice }, { timeoutMs: slice });
      if (String(res.error ?? '').includes(DERAILED_PREFIX)) return this.derailed(res.error);
      // Looked at on success too: an error screen is IDLE, so "idle" alone proves nothing.
      const off = await this.derailment();
      if (off) return this.derailed(off, res.ok ? null : res.error ?? null);
      if (done(res) || Date.now() >= deadline) return res;
    }
  }

  /** The step itself, without the off-path guard. */
  async stepCore(spec) {
    const target = spec.target?.automationId ?? spec.target?.id ?? null;

    switch (spec.action) {
      case 'click':
        return this.actuate('ui.tap', { automationId: requireId(target, spec) });
      case 'type':
        // The bridge reads args.value: a `text` argument was read by nothing, so every type step
        // "passed" while typing nothing at all.
        return this.actuate('ui.type', { automationId: requireId(target, spec), value: spec.value ?? '' });
      case 'dismiss':
        // The device can close any dialog or sheet; the flow format could not say so.
        //
        // Without this a flow that opens a bottom sheet has no way to leave it: the tab bar underneath is
        // behind the sheet's scrim, and a popup host that renders its buttons from a description gives the
        // close button no id. The capability existed on the bridge and only the vocabulary was missing.
        return this.actuate('ui.dismissOverlay', {});

      case 'assert':
        return this.assert(spec);
      case 'navigate':
        // A mobile flow has no URL bar. `navigate` on this platform means "wait until this screen
        // is the one on the device", which is what a web navigation means in practice too.
        return this.waitInSlices('ui.waitFor', { automationId: requireId(target ?? spec.url, spec) },
          spec.waitBudgetMs ?? 30_000, (res) => res.ok);

      case 'tapFeature':
        // A tap ON A MAP. In a map-centred app most screens open from a feature, and a flow could not say
        // "tap this feature": the bridge has the command, only the vocabulary was missing, so every
        // map-anchored scenario ended at the map. It runs the app's real tap pipeline (identify → the
        // feature's screen), not a programmatic selection.
        return this.actuate('map.tapFeature', DeviceDriver.mapArgs(spec));
      case 'zoomToFeature':
        // Bring a feature on screen first; a tap on a feature the viewport does not show taps nothing.
        return this.actuate('map.zoomToFeature', DeviceDriver.mapArgs(spec));
      case 'longPressFeature':
        // A HOLD on a feature — what typically starts a multi-selection. Same contract as tapFeature:
        // layer + stable id, through the app's controller, no coordinate.
        return this.actuate('map.longPressFeature', DeviceDriver.mapArgs(spec));
      case 'selectItem': {
        // A row of a virtualized list, chosen by its DATA. Recycled rows have no stable automation id,
        // so `target.automationId` names the LIST and `target.itemId` (+ `idField`, default "Id") or
        // `target.text` names the row. The bridge runs the same activation a tap runs.
        const t = spec.target ?? {};
        return this.actuate('ui.selectItem', {
          automationId: requireId(target, spec),
          ...(t.itemId !== undefined ? { itemId: String(t.itemId) } : {}),
          ...(t.idField ? { idField: t.idField } : {}),
          ...(t.text !== undefined ? { text: String(t.text) } : {}),
        });
      }
      case 'popupButton':
        // A button of the OPEN popup by its caption — a confirm dialog's buttons often have no automation
        // id (the popup host renders them from a description). Never leaves the popup.
        return this.actuate('ui.tapPopupButton', { text: String(spec.value ?? spec.target?.text ?? '') });
      case 'setValue':
        // A picker, wheel, date or switch, set through the property the user's choice would set. A picker
        // that opens its own sheet often has nothing to tap; the bridge sets what the choice would set.
        return this.actuate('ui.setValue', { automationId: requireId(target, spec), value: String(spec.value ?? '') });
      case 'bridge': {
        // (3.8.5) One bridge command as a SETUP step: the start state a flow needs and no person's path leads to
        // (a developer menu, a mock, a feature flag). It is not a user action, so the report marks it `setup`.
        const command = spec.command ?? spec.value;
        if (typeof command !== 'string' || !command) {
          throw new Error(`Step "${spec.id}" (bridge) needs "command" (a bridge command name) and optionally "args".`);
        }
        // (3.9.2) `waitBudgetMs` (at most 120 s) for a command that waits on the app itself (a sync run, a phase).
        const budget = Number(spec.waitBudgetMs) > 0 ? Math.min(Number(spec.waitBudgetMs), 120_000) : undefined;
        const res = await this.actuate(command, spec.args && typeof spec.args === 'object' ? spec.args : {}, budget ? { timeoutMs: budget } : {});
        return { ...res, setup: true };
      }
      case 'longPress':
        // (3.8.9) A finger held on a control (what opens a context menu or starts a selection) — `ui.longPress`.
        return this.actuate('ui.longPress', { automationId: requireId(target, spec), ...(spec.durationMs ? { durationMs: spec.durationMs } : {}) });
      case 'swipe':
      case 'scroll': {
        // (3.8.9) A drag. `swipe` names where the FINGER goes; `scroll` names where the CONTENT should move into view
        // (scroll down = the finger goes up), the way a person says it. Without a target, the screen's centre.
        const direction = String(spec.direction ?? spec.value ?? '');
        if (!SWIPE_DIRECTIONS.has(direction)) {
          throw new Error(`Step "${spec.id}" (${spec.action}) needs "direction": up, down, left or right.`);
        }
        const finger = spec.action === 'scroll' ? OPPOSITE[direction] : direction;
        return this.actuate('ui.swipe', {
          ...(target ? { automationId: target } : {}),
          direction: finger,
          ...(spec.distance ? { distance: spec.distance } : {}),
          ...(spec.durationMs ? { durationMs: spec.durationMs } : {}),
        });
      }
      case 'screenshot':
        return this.screenshot(spec);
      case 'expectEvent':
        return this.expectEvent(spec);
      default:
        throw new Error(
          `Step "${spec.id}" uses action "${spec.action}", which the device driver does not ` +
            `implement. Supported: click, type, dismiss, assert, navigate, tapFeature, zoomToFeature, ` +
            `longPressFeature, selectItem, setValue, popupButton, bridge, longPress, swipe, scroll, screenshot, ` +
            `expectEvent. Refusing rather than skipping.`,
        );
    }
  }

  /**
   * The map-feature arguments of a `tapFeature` / `zoomToFeature` / `longPressFeature` step or a `map` assertion.
   *
   * `{ "target": { "layer": "Parcels", "featureId": "<id>", "idField": "ParcelId" } }` — `idField` matters:
   * the bridge defaults to `Id`, which matches nothing on a layer whose id column has another name.
   * `entityId` is read as an alias of `featureId`, because that is the name the `map` oracle used to send
   * and no bridge accepted — every `map` assertion failed with "featureId is required".
   */
  static mapArgs(spec) {
    const source = spec.target ?? spec.oracle ?? {};
    const layer = source.layer ?? spec.oracle?.layer;
    const featureId = source.featureId ?? source.entityId ?? spec.oracle?.featureId ?? spec.oracle?.entityId;
    if (!layer || !featureId) {
      throw new Error(
        `Step "${spec.id ?? '?'}" (${spec.action}) needs a map feature: ` +
          `{ "target": { "layer": "<layer>", "featureId": "<id>", "idField": "<id column>" } }.`,
      );
    }
    const idField = source.idField ?? spec.oracle?.idField;
    return { layer, featureId: String(featureId), ...(idField ? { idField } : {}) };
  }

  async actuate(command, args, options = {}) {
    const res = await this.command(command, args, options);
    if (!res.ok) return res;
    if (ACTUATING.has(command)) {
      // (3.9.4) The command already waited for the app to settle on the device (its answer says `settled: true`): a
      // second quiet window from here only adds time. The off-path guard is still asked (an error screen is idle too).
      if (res.result?.settled === true) {
        const off = await this.derailment();
        return off ? this.derailed(off, null) : res;
      }
      // Every action ends by waiting for the app to settle. There is no sleep in this driver and
      // there must never be one: a fixed pause is what makes recorded tests flaky, and it hides
      // the very slowness it is compensating for.
      const idle = await this.waitInSlices('ui.waitIdle', {}, 30_000, (res) => res.ok);
      if (idle.derailed) return idle;
      if (!idle.ok) return { ok: false, error: `${command} ran but the app never settled: ${idle.error}` };
    }
    return res;
  }

  /**
   * Which control a `visible` or `value` assertion is about.
   *
   * The id belongs on `target`, the same place every other step carries it. A
   * hand-written flow naturally puts it on the ORACLE instead, and the device
   * then answers `This command needs a "automationId" argument` — true, and
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

  /**
   * The oracles. Two of them (`probe`, `idle`) exist on no web platform and are the reason mobile testing
   * is worth automating at all.
   */
  async assert(spec) {
    const oracle = spec.oracle ?? {};
    switch (oracle.kind) {
      case 'visible': {
        const id = DeviceDriver.requireAssertId(spec);
        if (id.error) return id;
        const res = await this.command('ui.find', { automationId: id.automationId });
        return res.ok
          ? { ok: true, detail: `found ${id.automationId}` }
          : { ok: false, error: res.error };
      }
      case 'value': {
        const id = DeviceDriver.requireAssertId(spec);
        if (id.error) return id;
        const res = await this.command('ui.find', { automationId: id.automationId });
        if (!res.ok) return res;
        const actual = res.result?.value ?? res.result?.text ?? null;
        return compare(actual, oracle, `value of ${id.automationId}`);
      }
      case 'onScreen': {
        // "visible" is a framework's IsVisible: true for a button half under the navigation bar. This asks
        // the device where the control is DRAWN — fully, unclipped, clear of the system bars showing now
        // (a confirm button below the screen edge is the classic defect it catches). `expected: false`
        // asserts the opposite (e.g. scrolled away).
        const id = DeviceDriver.requireAssertId(spec);
        if (id.error) return id;
        // Re-measured until it matches, for a short while: a sheet or a selection bar slides and scales
        // in, and a control read mid-animation is honestly partly clipped (measured: 0.92 visible, then
        // 1.0 a moment later). Capped well below the step budget, so a control that never arrives fails.
        const want = oracle.expected ?? true;
        const deadline = Date.now() + Math.min(spec.waitBudgetMs ?? 5_000, 5_000);
        let res = await this.command('ui.find', { automationId: id.automationId });
        while (res.ok && res.result?.bounds && res.result.bounds.onScreen !== want && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          res = await this.command('ui.find', { automationId: id.automationId });
        }
        if (!res.ok) return res;
        const bounds = res.result?.bounds;
        if (!bounds) {
          return {
            ok: false,
            error: `${id.automationId}: the device returned no screen bounds (platform without a measurement, or the control has no native view yet)`,
          };
        }
        const where = `${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}dp, visible ${bounds.visibleFraction ?? '?'}, screen ${bounds.screenWidth}x${bounds.screenHeight}, safe bottom ${bounds.safeBottom}`;
        return bounds.onScreen === want
          ? { ok: true, detail: `${id.automationId} onScreen=${bounds.onScreen} (${where})` }
          : { ok: false, error: `${id.automationId} onScreen=${bounds.onScreen}, expected ${want} (${where})` };
      }
      case 'probe': {
        // The oracle no UI test has. "The toast said saved" and "the row exists and reached the
        // server" are different claims, and in an offline-first client with a sync queue the gap
        // between them is where the hardest defects live.
        //
        // A step may give it time to settle: with `waitBudgetMs`, a mismatch is re-asked every 500 ms
        // until it matches or the budget (capped at 60 s) runs out. Sync-queue state is eventually
        // consistent — "pending" drops to 0 when an upload's bookkeeping lands, not when its tap returns.
        const what = `probe ${oracle.probe}(${(oracle.args ?? []).join(', ')})`;
        const deadline = Date.now() + Math.min(spec.waitBudgetMs ?? 0, 60_000);
        for (;;) {
          const res = await this.command('db.probe', { name: oracle.probe, args: oracle.args ?? [] });
          if (!res.ok) return res;
          const verdict = compare(res.result?.value, oracle, what);
          if (verdict.ok || Date.now() >= deadline) return verdict;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      case 'idle': {
        // WAIT for quiescence; do not sample it.
        //
        // This used to call `app.busy`, which is an instantaneous snapshot, and fail the moment
        // anything at all was in flight. A smoke suite that asserts `idle` as its very first step was
        // reddened by any background request that happened to overlap the start of the run — found
        // live: a periodic token refresh took ~20 s from an emulator, and the identical suite passed
        // seconds later with nothing changed.
        //
        // `ui.waitIdle` is the same gate every action already waits on: every action waits for app
        // quiescence rather than sleeping, and a timeout names what was still busy. An assertion that
        // the app settles is that sentence, not a coin flip on when the step happened to land.
        const budget = oracle.timeoutMs ?? 30_000;
        const res = await this.waitInSlices('ui.waitIdle', {}, budget, (r) => Boolean(r.result?.idle));
        if (res.derailed) return res;
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
        const args = DeviceDriver.mapArgs(spec);
        const res = await this.command('map.assertFeatureVisible', args);
        return res.ok ? { ok: true, detail: `${args.featureId} visible on ${args.layer}` } : res;
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
          `Assertion kind "${oracle.kind}" is not supported on a device. Supported: visible, onScreen, value, ` +
            `probe, idle, map, aria. (url/text/network/console are web-only.)`,
        );
    }
  }

  // ---------------------------------------------------------------- transport

  async command(command, args = {}, { timeoutMs = 30_000 } = {}, retriedSkew = false) {
    const body = JSON.stringify({
      command,
      args,
      timeoutMs,
      ...(this.leaseId ? { leaseId: this.leaseId } : {}),
    });

    const headers = { 'content-type': 'application/json' };
    if (this.token) headers['x-qa-token'] = this.token;
    if (this.signing && !this.hello) this.hello = await this.get('/qa');
    // (3.8.6) Only a bridge that asks for signatures gets one: a lab hands its key to every device lane, and a protocol-1
    // bridge (no app id to sign for) would otherwise receive headers that mean nothing.
    // (3.9.3) A protocol-2 bridge's command route is `/pilot`; `/qa` is its old name (Deprecation since 2026-11-04,
    // Sunset 2027-02-01). A protocol-1 bridge (an older app) has only `/qa`.
    const route = this.hello?.protocol === 2 ? '/pilot' : '/qa';
    if (this.signing && this.hello?.signatureRequired) {
      Object.assign(headers, signRequest({
        key: this.signing.key,
        kid: this.signing.kid ?? this.hello.kids?.[0],
        app: this.hello.app,
        method: 'POST',
        path: route,
        body,
        now: Date.now() + Math.round(this.clockOffsetMs),
      }));
    }

    const response = await fetch(`${this.base}${route}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    });

    if (response.status === 401) {
      throw new Error(
        `The device rejected the automation token${this.profile?.tokenHint ? ` (${this.profile.tokenHint})` : ''}; ` +
          'it changes when the app rotates it.',
      );
    }

    const answer = await response.json();
    // A device whose clock is off: correct once from the time it reports, then retry.
    if (answer?.code === 'CLOCK_SKEW' && typeof answer.deviceTime === 'number' && !retriedSkew) {
      this.clockOffsetMs = answer.deviceTime - Date.now();
      return this.command(command, args, { timeoutMs }, true);
    }
    return answer;
  }

  /**
   * (3.8.8) The app's always-awake checks (G9AppPilot `oracle.list`): what it noticed without a step asking — a JS error,
   * a nameless control, a key on screen instead of its text. `since` = the number a previous call returned. An app
   * without them (an older build, a protocol-1 bridge) answers null, and nothing changes for it.
   */
  async noticed(since = 0) {
    try {
      const answer = await this.command('oracle.list', { since }, { timeoutMs: 8_000 });
      if (!answer?.ok) return null;
      const r = answer.result ?? {};
      return { last: typeof r.last === 'number' ? r.last : since, violations: Array.isArray(r.violations) ? r.violations : [] };
    } catch {
      return null;
    }
  }

  /**
   * (3.8.9) Called before a flow's steps: a flow with an `expectEvent` step gets the bridge's event stream opened for
   * its whole length (events of the step before an expectEvent arrive while that step runs). Closes the last flow's.
   */
  async prepareFlow(flow) {
    this.endFlow();
    this.stepAt = { previous: 0, current: 0 };
    // (3.8.11) The failure bundle's summary keeps only what happened since this moment.
    this.flowStartedAt = Date.now();
    if (!(flow?.steps ?? []).some((s) => s?.action === 'expectEvent')) return;
    this.events = { list: [], waiters: new Set(), error: null, ctrl: new AbortController() };
    void this.readEvents(this.events);
  }

  endFlow() {
    if (this.events) this.events.ctrl.abort();
    this.events = null;
  }

  /**
   * (3.8.10) A flow's `preconditions`: the start state it builds itself, so one failed flow no longer breaks the next.
   *   net: "offline" | [rules] (net.shape)   clock: { offsetMs | at } (clock.set)   seed: n (state.seed)
   *   flags: { name: value } (flags.set)     bridge: [{ command, args }] (anything else the app's bridge offers),
   *   cleanup: [{ command, args }] (run after the flow, besides the automatic undo)
   *   savepoint: "<name>" (3.9: the app's data from a savepoint, FIRST — it replaces the data and restarts the app; the
   *              command is the device profile's `savepoint.load`, no undo: the next flow names its own start)
   *   permissions: { grant: [..], revoke: [..] } (3.9, Android `pm grant|revoke`; each put back as it was)
   *   os: { appearance: "dark"|"light", fontScale: n } (3.9, Android; each put back as it was)
   * An unknown key is refused, never skipped. Returns { ok, applied } or { ok: false, error } — the first command
   * that failed; what was already set is undone by undoPreconditions all the same.
   */
  async applyPreconditions(pre) {
    this.undo = [];
    if (!pre) return { ok: true, applied: [] };
    if (typeof pre !== 'object' || Array.isArray(pre)) return { ok: false, error: 'preconditions must be an object' };
    const unknown = Object.keys(pre).filter((k) => !PRECONDITION_KEYS.has(k));
    if (unknown.length) return { ok: false, error: `preconditions.${unknown[0]} is not known (known: ${[...PRECONDITION_KEYS].join(', ')}). A runner must refuse, not skip.` };
    const early = [];
    if (pre.savepoint !== undefined) {
      const name = typeof pre.savepoint === 'string' ? pre.savepoint : pre.savepoint?.name;
      const r = await this.savepoint('load', name);
      if (!r.ok) return { ok: false, error: `precondition savepoint ${name ?? ''} failed: ${r.error}`, applied: early };
      early.push(`savepoint ${name}`);
    }
    if (pre.permissions !== undefined || pre.os !== undefined) {
      if (this.serial === false || !this.packageName) return { ok: false, error: 'preconditions.permissions / os need an Android device over adb with a package (this device has none)', applied: early };
      const pkg = shellPackage(this.packageName);
      const granted = async (perm) => new RegExp(`${perm.replace(/\./g, '\\.')}: granted=true`).test(await this.shell(`dumpsys package ${pkg}`));
      for (const [verb, list] of [['grant', pre.permissions?.grant ?? []], ['revoke', pre.permissions?.revoke ?? []]]) {
        for (const perm of list) {
          if (!/^[\w.]+$/.test(String(perm))) return { ok: false, error: `preconditions.permissions: «${perm}» is not a permission name`, applied: early };
          const was = await granted(perm);
          await this.shell(`pm ${verb} ${pkg} ${perm}`).catch(() => null);
          if (was !== (verb === 'grant')) this.undoShell.unshift(`pm ${was ? 'grant' : 'revoke'} ${pkg} ${perm}`);
          early.push(`${verb} ${perm}`);
        }
      }
      if (pre.os?.appearance !== undefined) {
        if (!['dark', 'light'].includes(pre.os.appearance)) return { ok: false, error: 'preconditions.os.appearance is "dark" or "light"', applied: early };
        const was = /yes/.test(await this.shell('cmd uimode night'));
        await this.shell(`cmd uimode night ${pre.os.appearance === 'dark' ? 'yes' : 'no'}`);
        this.undoShell.unshift(`cmd uimode night ${was ? 'yes' : 'no'}`);
        early.push(`appearance ${pre.os.appearance}`);
      }
      if (pre.os?.fontScale !== undefined) {
        const n = Number(pre.os.fontScale);
        if (!(n >= 0.5 && n <= 2)) return { ok: false, error: 'preconditions.os.fontScale is a number from 0.5 to 2', applied: early };
        const was = (await this.shell('settings get system font_scale')).trim();
        await this.shell(`settings put system font_scale ${n}`);
        this.undoShell.unshift(/^[\d.]+$/.test(was) ? `settings put system font_scale ${was}` : 'settings delete system font_scale');
        early.push(`fontScale ${n}`);
      }
    }
    const plan = [];
    if (pre.net !== undefined) {
      const rules = pre.net === 'offline' ? [{ mode: 'offline' }] : pre.net;
      if (!Array.isArray(rules)) return { ok: false, error: 'preconditions.net is "offline" or a list of net.shape rules' };
      plan.push({ command: 'net.shape', args: { rules }, undo: { command: 'net.shape', args: { clear: true } } });
    }
    if (pre.clock !== undefined) plan.push({ command: 'clock.set', args: pre.clock, undo: { command: 'clock.reset', args: {} } });
    if (pre.seed !== undefined) plan.push({ command: 'state.seed', args: { seed: pre.seed }, undo: { command: 'state.seed', args: { off: true } } });
    for (const [name, value] of Object.entries(pre.flags ?? {})) {
      plan.push({ command: 'flags.set', args: { name, value }, undo: { command: 'flags.set', args: { name, value: null } } });
    }
    for (const b of pre.bridge ?? []) plan.push({ command: b?.command, args: b?.args ?? {} });
    for (const c of pre.cleanup ?? []) this.undo.push({ command: c?.command, args: c?.args ?? {} });
    const applied = [...early];
    for (const p of plan) {
      if (typeof p.command !== 'string' || !p.command) return { ok: false, error: 'a preconditions.bridge entry has no "command"' };
      const res = await this.command(p.command, p.args ?? {});
      if (!res?.ok) return { ok: false, error: `precondition ${p.command} failed: ${res?.error ?? 'no answer'}`, applied };
      applied.push(p.command);
      if (p.undo) this.undo.unshift(p.undo);
    }
    if (applied.length) await this.waitInSlices('ui.waitIdle', {}, 15_000, (res) => res.ok);
    return { ok: true, applied };
  }

  /**
   * (3.8.11) The failure bundle: when a flow fails, the app's state AT that moment — a trace from the bridge's black box
   * (`trace.capture`: what was busy, the last commands, log lines and requests, the app's own sections) and the screen
   * (`ui.screenshot`) — written beside the report, with a short summary for the report itself. Taken before the
   * preconditions are undone. A bridge without one or both gives what it has; null when it has neither. Never throws.
   */
  async failureBundle(flowId, reason) {
    if (!this.artifactsDir) return null;
    const dir = path.join(path.dirname(this.artifactsDir), 'failures');
    const base = String(flowId ?? 'flow').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100);
    const bundle = {};
    try {
      const t = await this.command('trace.capture', { reason: String(reason ?? 'flow failed').slice(0, 300) }, { timeoutMs: 20_000 });
      if (t?.ok && t.result) {
        fs.mkdirSync(dir, { recursive: true });
        bundle.trace = path.join(dir, `${base}.trace.json`);
        fs.writeFileSync(bundle.trace, JSON.stringify(t.result, null, 2));
        // the device's clock, corrected by the known skew, with 1 s of slack
        bundle.summary = summarizeTrace(t.result, { since: this.flowStartedAt ? this.flowStartedAt + this.clockOffsetMs - 1_000 : 0 });
      }
    } catch { /* a bridge without a black box */ }
    try {
      const s = await this.command('ui.screenshot', { maxLongEdgePx: 1000 }, { timeoutMs: 20_000 });
      if (s?.ok && typeof s.result?.base64 === 'string') {
        fs.mkdirSync(dir, { recursive: true });
        bundle.screenshot = path.join(dir, `${base}.jpg`);
        fs.writeFileSync(bundle.screenshot, Buffer.from(s.result.base64, 'base64'));
      }
    } catch { /* no screen to show */ }
    return bundle.trace || bundle.screenshot ? bundle : null;
  }

  /** (3.8.10) Puts back what applyPreconditions set (newest first) and runs the flow's own cleanup. Never throws. */
  async undoPreconditions() {
    const undo = this.undo ?? [];
    this.undo = [];
    const problems = [];
    // (3.9) What permissions / os changed on the device itself, newest first.
    for (const command of this.undoShell.splice(0)) {
      await this.shell(command).catch((err) => problems.push(`${command}: ${err?.message ?? err}`));
    }
    for (const u of undo) {
      const res = await this.command(u.command, u.args ?? {}).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
      if (!res?.ok) problems.push(`${u.command}: ${res?.error ?? 'no answer'}`);
    }
    return problems;
  }

  /** Reads `GET /pilot/events?since=0` (protocol 2, Server-Sent Events) into `stream.list` until aborted. */
  async readEvents(stream) {
    try {
      if (!this.hello) this.hello = await this.get('/qa');
      const path = '/pilot/events';
      const headers = { accept: 'text/event-stream' };
      if (this.token) headers['x-qa-token'] = this.token;
      if (this.signing && this.hello?.signatureRequired) {
        Object.assign(headers, signRequest({ key: this.signing.key, kid: this.signing.kid ?? this.hello.kids?.[0], app: this.hello.app, method: 'GET', path, body: '', now: Date.now() + Math.round(this.clockOffsetMs) }));
      }
      const response = await fetch(`${this.base}${path}?since=0`, { headers, signal: stream.ctrl.signal });
      if (!response.ok) throw new Error(`the bridge has no event stream (GET ${path}: HTTP ${response.status}) — a protocol-1 bridge cannot answer expectEvent`);
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true }).split(CR).join('');
        let end;
        while ((end = buffer.indexOf(NL + NL)) >= 0) {
          const event = parseSseBlock(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (!event) continue;
          stream.list.push(event);
          for (const wake of stream.waiters) wake();
        }
      }
    } catch (err) {
      if (stream.ctrl.signal.aborted) return;
      stream.error = String(err?.message ?? err);
      for (const wake of stream.waiters) wake();
    }
  }

  /**
   * (3.8.9) `expectEvent { kind, match?, within? }`: an event of that kind, raised since the step before this one
   * began, whose data holds every `match` field (a string field matches when it contains the expected text). Waits up
   * to `within` ms (default 5 000) for one still to come. Event time is the device's, corrected by the known skew.
   */
  async expectEvent(spec) {
    const kind = spec.kind ?? spec.event?.kind ?? spec.value;
    if (typeof kind !== 'string' || !kind) throw new Error(`Step "${spec.id}" (expectEvent) needs "kind" (an event kind such as "toast").`);
    const match = spec.match ?? spec.event?.match ?? {};
    const within = Number(spec.within ?? spec.event?.within ?? 5_000);
    const stream = this.events;
    if (!stream) return { ok: false, error: 'expectEvent: the event stream was not opened for this flow (prepareFlow)' };
    // 1 s of slack: the two clocks and the batching of events within one turn
    const since = (this.stepAt.previous || this.stepAt.current) - 1_000;
    const fits = (e) => e.kind === kind && e.t - this.clockOffsetMs >= since && eventMatches(e.data, match);
    const deadline = Date.now() + within;
    for (;;) {
      const hit = stream.list.find(fits);
      if (hit) return { ok: true, detail: `${kind} #${hit.seq}`, event: { seq: hit.seq, kind: hit.kind, data: hit.data } };
      if (stream.error) return { ok: false, error: `expectEvent: ${stream.error}` };
      const left = deadline - Date.now();
      if (left <= 0) {
        const seen = [...new Set(stream.list.filter((e) => e.t - this.clockOffsetMs >= since).map((e) => e.kind))];
        return { ok: false, error: `no "${kind}" event${Object.keys(match).length ? ` matching ${JSON.stringify(match)}` : ''} within ${within} ms (seen since the step before: ${seen.join(', ') || 'none'})` };
      }
      await new Promise((resolve) => {
        const wake = () => { clearTimeout(timer); stream.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, left);
        stream.waiters.add(wake);
      });
    }
  }

  /**
   * (3.8.9) `screenshot { name? }`: the app's window as the bridge draws it (`ui.screenshot`, JPEG) — evidence beside
   * the report, not a comparison (a lossless reference check is the app pilot's `visual check`).
   */
  async screenshot(spec) {
    const res = await this.command('ui.screenshot', { maxLongEdgePx: Number(spec.maxLongEdgePx ?? 1400) }, { timeoutMs: 30_000 });
    if (!res.ok) return res;
    const name = String(spec.name ?? spec.value ?? spec.id ?? 'screen').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
    const r = res.result ?? {};
    if (!this.artifactsDir || typeof r.base64 !== 'string') return { ok: true, detail: `${r.width ?? '?'}×${r.height ?? '?'} (not kept)` };
    fs.mkdirSync(this.artifactsDir, { recursive: true });
    const file = path.join(this.artifactsDir, `${Date.now()}-${name}.jpg`);
    fs.writeFileSync(file, Buffer.from(r.base64, 'base64'));
    return { ok: true, detail: `${r.width}×${r.height}`, screenshot: file };
  }

  get(path) {
    return fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json());
  }
}

/**
 * (3.8.11) The few lines of a black-box trace a reader needs first: what was still busy, the warnings and errors the
 * app logged last, the requests that failed. The whole trace stays in its file.
 */
export function summarizeTrace(trace, { since = 0 } = {}) {
  const t = trace ?? {};
  const recent = (e) => !since || typeof e?.t !== 'number' || e.t >= since;
  const text = (v, n) => String(v ?? '').slice(0, n);
  const busy = Array.isArray(t.busy) ? t.busy : Array.isArray(t.busy?.reasons) ? t.busy.reasons : [];
  const logs = (Array.isArray(t.logs) ? t.logs : [])
    .filter(recent)
    .filter((l) => /warn|error|fatal/i.test(String(l?.level ?? '')))
    .slice(-6)
    .map((l) => `${text(l.level, 5)} ${text(l.tag ?? l.source, 24)} ${text(l.message ?? l.text, 220)}`.replace(/\s+/g, ' ').trim());
  const net = (Array.isArray(t.net) ? t.net : [])
    .filter(recent)
    .filter((r) => r?.error || (typeof r?.status === 'number' && r.status >= 400) || r?.status === null)
    .slice(-4)
    .map((r) => `${text(r.method, 6)} ${text(r.url, 120)} → ${r.status ?? text(r.error, 80)}`);
  return {
    ...(t.id ? { id: t.id } : {}),
    busy: busy.slice(0, 6).map((b) => text(typeof b === 'string' ? b : b?.reason ?? b?.name ?? JSON.stringify(b), 120)),
    logs,
    net,
  };
}

/**
 * (3.8.13) `--device-url http://host:port`: a bridge reached directly. Only http(s) with a port; the path is ignored.
 * Null without the option.
 */
export function deviceUrlFor(options) {
  const raw = options['device-url'];
  if (raw === undefined) return null;
  if (raw === true) throw new Error('--device-url needs an address, e.g. --device-url http://127.0.0.1:18797');
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error(`--device-url ${raw}: not an address (http://host:port)`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`--device-url ${raw}: only http(s)`);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return { url: `${u.protocol}//${u.hostname}:${port}`, host: u.hostname, port };
}

/** One Server-Sent Event block → { seq, kind, data, t } (t = the event's own time, else its arrival). */
export function parseSseBlock(block) {
  let id = null;
  let kind = 'message';
  const data = [];
  for (const line of block.split(NL)) {
    if (line.startsWith('id:')) id = Number(line.slice(3).trim());
    else if (line.startsWith('event:')) kind = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (id === null && !data.length) return null;
  let payload = data.join(NL);
  try { payload = JSON.parse(payload); } catch { /* plain text stays text */ }
  const t = payload && typeof payload === 'object' && typeof payload.t === 'number' ? payload.t : Date.now();
  const inner = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
  return { seq: id, kind: payload?.kind ?? kind, data: inner, t };
}

/** Every `match` field is in `data`: equal, or — for text — contained. Nested objects are matched the same way. */
export function eventMatches(data, match) {
  if (!match || typeof match !== 'object') return true;
  return Object.entries(match).every(([key, want]) => {
    const have = data?.[key];
    if (want && typeof want === 'object') return eventMatches(have, want);
    if (typeof want === 'string' && typeof have === 'string') return have.includes(want);
    return have === want;
  });
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
function run(command, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err.message) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * (3.9.2) A step's `capture: {name: "dot.path"}`: values from the step's answer (`result` first) become variables for the
 * LATER steps' {{name}} — an id the app chose while the flow ran (the drawing it just made). A path that finds nothing
 * fails the step: a later step would otherwise run with "{{name}}" literally. Returns null, or the error text.
 */
export function captureInto(variables, capture, outcome) {
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return capture == null ? null : 'capture must be an object: {"name": "dot.path"}';
  for (const [name, at] of Object.entries(capture)) {
    if (!/^[A-Za-z_][\w]*$/.test(name)) return `capture: "${name}" is not a variable name`;
    const walk = (root) => String(at).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), root);
    const value = walk(outcome?.result) ?? walk(outcome);
    if (value === undefined || value === null || typeof value === 'object') return `capture ${name}: the answer has no value at "${at}"`;
    variables[name] = String(value);
  }
  return null;
}

/**
 * (3.9) What a protocol-1 bridge (an older app, a build of another framework) cannot answer is not its failure: a step
 * or a precondition that needs a protocol-2 command it does not have («Unknown command», no event stream) makes the
 * flow SKIPPED with that reason — «needs a protocol-2 bridge» — never FAIL_PRODUCT. A protocol-2 bridge that lacks a
 * command still fails: there it is the app's (or the flow's) problem.
 */
export function needsNewerBridge(steps, protocol) {
  if (!(Number(protocol) < 2)) return null;
  const bad = steps.find((s) => !s.ok);
  const m = String(bad?.error ?? '');
  return /Unknown command|not a command this bridge|has no event stream|protocol-1 bridge/i.test(m) ? `step ${bad.step} (${bad.action}) needs a protocol-2 bridge — this app's bridge is protocol ${protocol}: ${m.slice(0, 160)}` : null;
}
