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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_BRIDGE_PORT } from '../../lib/devices.mjs';

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
]);

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
    profile = null, launchTimeoutMs = 45_000, log = () => {},
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
      await this.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
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
    const snap = await this.command('ui.snapshot', { maxNodes: 80 }, { timeoutMs: 8_000 })
      .catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
    if (snap?.ok) {
      if (!this.servingPackage) this.servingPackage = await this.packageOnPort().catch(() => null);
      const prefixes = this.profile?.errorScreens ?? [];
      const ids = (snap.result?.nodes ?? []).map((n) => n.automationId ?? '').filter(Boolean);
      const hit = prefixes.length ? ids.find((id) => prefixes.some((p) => id.startsWith(p))) : null;
      return hit ? `the app is on its error screen (${hit}) — it crashed or failed to initialize` : null;
    }
    const pkg = this.packageName ?? this.servingPackage;
    if (this.serial !== false && pkg) {
      const pid = (await this.shell(`pidof ${pkg}`).catch(() => '')).trim();
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
      const text = await this.shell(`run-as ${pkg} cat ${crashLog}`).catch(() => '');
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
      default:
        throw new Error(
          `Step "${spec.id}" uses action "${spec.action}", which the device driver does not ` +
            `implement. Supported: click, type, dismiss, assert, navigate, tapFeature, zoomToFeature, ` +
            `longPressFeature, selectItem, setValue, popupButton. Refusing rather than skipping.`,
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

  async actuate(command, args) {
    const res = await this.command(command, args);
    if (!res.ok) return res;
    if (ACTUATING.has(command)) {
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
        `The device rejected the automation token${this.profile?.tokenHint ? ` (${this.profile.tokenHint})` : ''}; ` +
          'it changes when the app rotates it.',
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
