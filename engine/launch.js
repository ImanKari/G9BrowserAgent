// engine/launch.js — start a real Edge/Chrome/CfT with a private CDP pipe, and stop it cleanly.
//
// Engine 2 (decisions D2/D3, AIGuide §2.0) is a stock browser process that G9BrowserAgent starts and owns. It is driven over
// --remote-debugging-pipe: the browser's fd 3/4 carry CDP, so there is no debugging port for
// anything else on the machine to find, and the browser identifies no differently from one a person
// started (no --enable-automation, ever). Headless by default: `--headless=new` is the full browser
// with no platform window, so none of the states that make Chromium stop rendering and silently
// drop input on a person's desktop — minimized, covered, locked, another virtual desktop — exist
// (AIGuide §2.8.1).
//
// launchBrowser(opts) → { pid, conn, argv, args, browser, profileDir, …, exited, close() }
// Every switch and why it is there: engine/README.md.

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveBrowser, findBrowsers, isDefaultUserDataDir, systemBinary } from './find.js';
import { PipeCdp } from './pipe-cdp.js';
import { launchArgsFor, launchWarnings, normalizeLevel } from './stealth.js';
import { profileInUse } from './profile.js';
import { noteFirewallLaunch } from './firewall.js';
import { cleanChildEnv } from '../lib/runtime.mjs';

/**
 * The designed list (engine/README.md), plus ONE deliberate addition: `msImplicitSignin`. Features merged with any
 * --disable-features in extraArgs (Chrome keeps only the LAST such switch).
 *
 * Why msImplicitSignin (live round 2, 2026-09-22, Edge 153.0.4234.32 on the owner's Windows
 * account): Edge signs the first profile of every NEW user-data-dir into the Windows primary
 * account (WAM single sign-on) within ~6 s of its first start, and turns full sync on — passwords,
 * history, open tabs, extensions (Local State info_cache user_name/gaia_id set, Preferences
 * account_info 1 entry, `sync.has_setup_completed` true). Measured on 7/7 automation profiles,
 * 13/13 test profiles, every Edge launch longer than ~20 s. Consequences: the owner's passwords
 * and history flowed into agent-driven browsers, agent browsing flowed back into the owner's
 * account, and the synced extensions injected content scripts (globals, DOM nodes, main-world
 * calls) into every page a stealth run opened — then derailed a headed engine until input stopped
 * arriving. `--no-first-run` does not prevent it; `signin.allowed=false` pre-seeded in Preferences
 * is rewritten to true by Edge (measured). Disabling this feature from a profile's FIRST start
 * leaves it signed out (measured 0 accounts in 6/6 fresh profiles). It does NOT sign out a profile
 * that is already signed in — manager.js checks for that before launching (profile.signInState).
 * Chrome and Chrome for Testing ignore a feature name they do not know, so it is passed to every
 * browser; the binary carries the name (strings in msedge.dll 153.0.4234.32).
 */
export const DISABLED_FEATURES = Object.freeze([
  'CalculateNativeWinOcclusion', 'Translate', 'MediaRouter', 'GlobalMediaControls',
  'PaintHolding', 'HttpsUpgrades', 'AutoDeElevate', 'OptimizationHints',
  'msImplicitSignin',
]);

/**
 * The designed fixed switches, plus `--disable-sync`: the second barrier behind msImplicitSignin
 * above. Measured on Edge 153: with it, a profile that is (or becomes) signed in never sets up
 * sync — no passwords, history, tabs or extensions arrive, nothing is uploaded, and no
 * sync-confirmation dialog opens (without it, edge://sync-confirmation-dialog/ and two extension
 * onboarding tabs appeared ~75 s after launch and cost ~1.7 GB). Nothing about it is visible to a
 * page. An automation browser has no business syncing a person's account in either direction.
 */
export const FIXED_SWITCHES = Object.freeze([
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-component-update',
  '--disable-background-mode',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-sync',
]);

/**
 * `--disable-component-update` is left out at stealth "stealth" (and for a profile being warmed) —
 * a deviation from the designed list, recorded like msImplicitSignin and --disable-sync above.
 *
 * Edge and Chrome get the Widevine CDM through the component updater. With the switch, no
 * G9BrowserAgent-launched Edge or Chrome ever had Widevine — not even on a warmed profile that had already
 * downloaded it: `requestMediaKeySystemAccess('com.widevine.alpha', …)` rejected while PlayReady
 * worked (stealth suite, round 3: 9/9 Edge runs; raw probe on Edge and Chrome 153: without the
 * switch the CDM lands in the profile within ~60 s of its first launch and is reported from then on;
 * with the switch again it is not, although it is on disk). Every real Edge and Chrome reports
 * Widevine, so its absence is a classic automation tell — and DRM players (streaming, some banking
 * and training sites) will not play. Below stealth the switch stays: those levels make no claim
 * about the environment, and a component fetched mid-run is a change the test did not ask for.
 * Chrome for Testing has no Widevine with or without it (the binary; measured).
 *
 * Measured side effect (Edge 153, round 4): with component updates on, Edge records this machine's
 * EXTERNAL extension registrations in the profile, disabled "awaiting approval" (reason 8192), never
 * installed; on the profile's next launch (any level) they become permission-only stubs with no
 * location, no manifest and no files. Nothing of them can run in a page.
 */
export const COMPONENT_UPDATE_SWITCH = '--disable-component-update';

/** The fixed switches for one launch: all of FIXED_SWITCHES, less the component-update switch when components may update. */
export function fixedSwitchesFor({ componentUpdate = false } = {}) {
  return FIXED_SWITCHES.filter((s) => !(componentUpdate && s === COMPONENT_UPDATE_SWITCH));
}

export const DEFAULT_WINDOW = Object.freeze({ width: 1920, height: 1080 });

/**
 * How long close() lets Browser.close finish before it kills the process tree.
 *
 * A clean exit is worth waiting for: the browser flushes cookies and preferences to the profile on
 * its way out, and a killed browser can lose the last minutes of a warmed login. The budget used to
 * be 10 s. Measured on 2026-09-24 (headless Edge 153, i9-10900X): 0.4-0.5 s idle, but up to 17.9 s
 * with 24 CPU-bound processes running, and one of four loaded closes was killed at the 10 s mark and
 * exited with code 1. 30 s covers the worst measured exit with room. A browser that is truly hung
 * still dies — only later — and callers that need a fast shutdown pass their own timeoutMs.
 */
export const GRACEFUL_EXIT_MS = 30_000;

/**
 * Switches for one browser KIND only.
 *
 * Chrome for Testing: `--disable-frame-rate-limit`. Measured on the owner's machine (live round 2
 * and a controlled probe, 2026-09-22, headless, temp profiles, the same G9BrowserAgent switches): CfT
 * 153.0.8010.52 ran requestAnimationFrame at a steady 100.5 ms — 10 frames per second, headless and
 * headed — while Chrome 153.0.8010.53 and Edge 153.0.4234.32 ran at 10.5 ms. A renderer's input is
 * frame-aligned, so every mouse event reached the page on a 100 ms beat and each CDP dispatch took
 * 85 ms: humanized paths arrived as 10 Hz jumps and press holds collapsed (lib/humanize.js perform).
 * Not the cause (each measured, still 100.5 ms): --disable-gpu-vsync, disabling the SkiaGraphite and
 * TreesInViz features (on in CfT, off in Chrome), restored tabs. What removes it: this switch
 * (rAF 17.4 ms, p10–p90 17–18 ms, dispatch 7.7 ms) or --disable-gpu (a software GL renderer — a
 * worse tell). With the switch Chrome and Edge also run at 17.4 ms rather than 10.5, so it is passed
 * to CfT ONLY, where it turns a 10 Hz page into an ordinary ~57 Hz one.
 *
 * ### Re-checked 2026-09-23, after the owner allowed the pending Windows Firewall prompt for the
 * ### newly installed chrome.exe — the switch STAYS.
 *
 * Two sequential runs of the cadence probe that night read CfT *without* the switch at 10.1 ms, as
 * fast as Edge, which looked like the 10 Hz having been an artefact of the pending prompt. It was
 * not. An interleaved A/B (4 rounds, each launching CfT+switch, CfT alone and Edge alone back to
 * back, fresh temp profile each time, same GPU — ANGLE/NVIDIA in all 12 launches) is unambiguous:
 *
 * | 4 rounds, one line each        | rAF          | page mousemove | press hold  | per dispatch |
 * |--------------------------------|--------------|----------------|-------------|--------------|
 * | CfT + --disable-frame-rate-limit | 17.3–17.4 ms | 17.2–17.4 ms   | 25.7–59.3 ms| 17.3 ms      |
 * | CfT, nothing added             | 100.5–100.6 ms| 100.5 ms      | 1.4–3.1 ms  | 100.5 ms     |
 * | Edge, nothing added            | 10.5 ms      | 10.6–10.9 ms   | 106–108 ms  | 10.3–10.4 ms |
 *
 * So CfT's 10 Hz reproduces 8 launches out of 8 in a quiet machine state, and the switch pins the
 * cadence to 17.4 ms in 12 observations out of 12. The two 10.1 ms readings came from a window in
 * which the machine had been running browser suites continuously for half an hour; whatever put
 * CfT's frame sink at 100 Hz there was not reproducible, and a switch is not removed on a reading
 * that cannot be reproduced. The press hold under the switch is short on this raw-schedule probe
 * (25–59 ms) because each dispatch costs 17.3 ms; the product's own planner (`perform` rule 1, the
 * 80 % rule) is what brings it back to 60–151 ms in the stealth suite.
 */
export const KIND_SWITCHES = Object.freeze({
  cft: Object.freeze(['--disable-frame-rate-limit']),
  // (3.8.1) Edge 155.0.4283.62 (Windows, 2026-10-16) starts a SECOND browser process through its
  // "compat layer" and exits 0: the relaunched one carries --edge-skip-compat-layer-relaunch but not
  // our CDP pipe, so every Edge launch failed with "the browser closed its end of the pipe" and left a
  // headless Edge running. Measured on 155.0.4283.62: without the switch 3 of 3 launches failed (exit 0,
  // nothing printed); with it the browser answers in ~0.8 s. Not a page-visible switch.
  edge: Object.freeze(['--edge-skip-compat-layer-relaunch']),
});

// Switches extraArgs may not carry, and why. The first group would identify automation or open the
// browser to other clients; the second is owned by launchBrowser's own options so that the argv
// recorded in engine.json has exactly one source for each of them.
//
// Every pattern is case-insensitive: on Windows Chromium lowercases switch NAMES when it parses the
// command line (base/command_line.cc), so "--ENABLE-AUTOMATION" is --enable-automation to the
// browser and must be refused just the same.
const REFUSED = [
  [/^--enable-automation(=|$)/i, 'it sets navigator.webdriver and the "controlled by automated test software" bar; G9BrowserAgent never identifies as automation'],
  [/^--remote-debugging-port(=|$)/i, 'a debugging port lets any local process drive this browser; Engine 2 uses the private pipe'],
  [/^--remote-debugging-address(=|$)/i, 'Engine 2 has no debugging port'],
  [/^--remote-debugging-pipe(=|$)/i, 'launchBrowser always passes it'],
  [/^--remote-debugging-io-pipes(=|$)/i, 'it moves CDP off fd 3/4, so the browser would never answer on the pipe G9BrowserAgent reads'],
  [/^--user-data-dir(=|$)/i, 'use the profileDir option'],
  [/^--headless(=|$)/i, 'use the headless option'],
  [/^--window-size(=|$)/i, 'use the windowSize option'],
  [/^--lang(=|$)/i, 'use the lang option'],
  [/^--proxy-server(=|$)/i, 'use the proxy option'],
  [/^--proxy-bypass-list(=|$)/i, 'use the proxy option ({ server, bypass }) or proxyBypass'],
];

/**
 * `--disable-blink-features=…AutomationControlled…` is the one switch whose verdict depends on the
 * level (owner decision D-a, engine/stealth.js launchArgsFor): stealth passes it itself, because
 * the pipe alone makes navigator.webdriver true (measured). At off/human it stays refused in
 * extraArgs — those levels make no claim about the environment, and a caller that wants webdriver
 * hidden asks for stealth, which also brings the input and domain rules that go with it.
 */
const AUTOMATION_CONTROLLED = /(^|,)\s*AutomationControlled\s*(,|$)/i;
const WEBDRIVER_REFUSAL = 'it hides navigator.webdriver, which only stealth "stealth" does (decision D-a: --remote-debugging-pipe itself makes navigator.webdriver true, measured; see engine/README.md "navigator.webdriver"). Launch with stealth:"stealth" instead';

/**
 * The taskbar a headless screen gets, in CSS pixels: Windows 11's at 100 % scaling (measured on the
 * owner's machine: headed Edge reports availHeight 1032 on a 1080 screen). Without it a headless
 * screen has no work area at all — `screen.availHeight === screen.height`, which no Windows desktop
 * reports and a detector reads as headless (live round 2: 30/30 headless runs). Other OSes: 0 (v2.0
 * ships for Windows; a macOS menu bar sits at the TOP and would need workAreaTop instead).
 */
export const HEADLESS_TASKBAR = process.platform === 'win32' ? 48 : 0;

/**
 * The headless screen (decision D-a; measured: headless otherwise reports 800×600), with a work
 * area when `workAreaBottom` is given. The syntax `{WxH workAreaBottom=N}` was measured on Edge and
 * CfT 153: availHeight = H − N.
 */
export function screenInfoSwitch({ width, height }, { workAreaBottom = 0 } = {}) {
  return `--screen-info={${width}x${height}${workAreaBottom > 0 ? ` workAreaBottom=${workAreaBottom}` : ''}}`;
}

/**
 * Headless geometry for a `windowSize`: the SCREEN is that size, its bottom `HEADLESS_TASKBAR`
 * pixels are the taskbar, and the window fills the rest — a maximized window, which is what a
 * person's browser on that screen looks like (outer size = the work area). A size too small to lose
 * a taskbar keeps no work area rather than becoming a sliver.
 */
export function headlessGeometry(size) {
  const taskbar = size.height - HEADLESS_TASKBAR >= 100 ? HEADLESS_TASKBAR : 0;
  return { screen: { width: size.width, height: size.height }, window: { width: size.width, height: size.height - taskbar }, workAreaBottom: taskbar };
}

/** Normalise `proxy` → { server, bypass } or null. Accepts 'host:port', a URL, or { server, bypass }. */
export function normalizeProxy(proxy, proxyBypass) {
  if (!proxy) return null;
  const server = typeof proxy === 'string' ? proxy : proxy.server;
  if (!server || typeof server !== 'string' || /\s/.test(server)) throw new Error(`Invalid proxy "${JSON.stringify(proxy)}". Use "host:port", "http://host:port", "socks5://host:port" or { server, bypass }.`);
  let bypass = proxyBypass ?? (typeof proxy === 'object' ? proxy.bypass : undefined);
  if (Array.isArray(bypass)) bypass = bypass.join(';');
  return { server, bypass: bypass ? String(bypass) : null };
}

function checkWindowSize(ws) {
  const w = Number(ws?.width);
  const h = Number(ws?.height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 100 || h < 100 || w > 16384 || h > 16384) {
    throw new Error(`Invalid windowSize ${JSON.stringify(ws)}: width and height must be integers between 100 and 16384.`);
  }
  return { width: w, height: h };
}

/**
 * The first tab's URL. It must carry a scheme ("about:blank", "https://…", "data:…", "file:…"):
 * anything starting with "-" (or "/" on Windows) is parsed by Chromium as a SWITCH, not a URL, so
 * a start URL could otherwise smuggle in a switch the list above refuses.
 */
function checkStartUrl(url) {
  const s = String(url);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    throw new Error(`Invalid startUrl "${s}": use an absolute URL with a scheme, such as "about:blank" or "https://example.test/".`);
  }
  return s;
}

function checkLang(lang) {
  try {
    return Intl.getCanonicalLocales(lang)[0];
  } catch {
    throw new Error(`Invalid lang "${lang}": use a BCP 47 tag such as "en-US" or "de-DE".`);
  }
}

/**
 * The exact argument list (without the executable) for a launch. Pure; exported for tests and for
 * the daemon's engine.json. Order: the designed list (+ `--screen-info` for headless, decision D-a), then
 * stealth.launchArgsFor(level) and extraArgs (feature lists merged), then the start URL.
 */
export function buildArgs({
  profileDir, headless = true, windowSize = DEFAULT_WINDOW, proxy, proxyBypass, lang,
  extraArgs = [], stealth = 'off', startUrl = 'about:blank', kind = null, componentUpdate = null,
  noSandbox = false,
} = {}) {
  if (!profileDir) throw new Error('buildArgs: profileDir is required.');
  const level = normalizeLevel(stealth);
  // Components (Widevine) update at stealth, and when a profile is warmed (COMPONENT_UPDATE_SWITCH).
  const fixed = fixedSwitchesFor({ componentUpdate: componentUpdate ?? level === 'stealth' });
  // Options arrive from JSON (the daemon, the desktop): null means "the default", never "none".
  // A null `headless` in particular must not become a headed window on someone's desktop.
  headless = headless ?? true;
  const size = checkWindowSize(windowSize ?? DEFAULT_WINDOW);
  if (extraArgs != null && !Array.isArray(extraArgs)) throw new Error(`extraArgs must be an array of switches (got ${JSON.stringify(extraArgs)}).`);
  const disabled = [...DISABLED_FEATURES];
  const enabled = [];
  const blinkDisabled = [];
  const blinkEnabled = [];
  const passthrough = [];
  let screenInfoGiven = false;
  // Blink runtime feature names are compared case-insensitively here so that "automationcontrolled"
  // cannot slip past the level check below, nor land twice in the merged switch.
  const merge = (list, value, { fold = false } = {}) => {
    for (const f of String(value).split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!list.some((x) => (fold ? x.toLowerCase() === f.toLowerCase() : x === f))) list.push(f);
    }
  };
  const levelArgs = launchArgsFor(level);
  for (const [i, arg] of [...levelArgs, ...(extraArgs ?? [])].entries()) {
    const fromLevel = i < levelArgs.length;
    if (typeof arg !== 'string' || !arg) throw new Error(`extraArgs must be non-empty strings (got ${JSON.stringify(arg)}).`);
    if (!arg.startsWith('--')) throw new Error(`extraArgs may only carry switches ("--name[=value]"); pass the page to open as startUrl (got "${arg}").`);
    // A bare "--" ends switch parsing in Chromium: every switch after it (ours included) would be
    // opened as a URL instead of applied.
    if (arg === '--' || /^--=/.test(arg)) throw new Error(`Refusing launch argument "${arg}": it is not a switch ("--" ends Chromium's switch parsing).`);
    for (const [re, why] of REFUSED) {
      if (re.test(arg)) throw new Error(`Refusing launch switch "${arg}": ${why}.`);
    }
    // Case-insensitive for the same reason as REFUSED: "--Disable-Features=X" left unmerged would
    // be the LAST --disable-features on Windows and silently drop the whole plan list above. The
    // same holds for --disable-blink-features: a caller's copy would otherwise replace stealth's.
    const disable = /^--disable-features=(.*)$/i.exec(arg);
    const enable = /^--enable-features=(.*)$/i.exec(arg);
    const blinkOff = /^--disable-blink-features=(.*)$/i.exec(arg);
    const blinkOn = /^--enable-blink-features=(.*)$/i.exec(arg);
    if (blinkOff) {
      if (!fromLevel && level !== 'stealth' && AUTOMATION_CONTROLLED.test(blinkOff[1])) {
        throw new Error(`Refusing launch switch "${arg}" at stealth "${level}": ${WEBDRIVER_REFUSAL}.`);
      }
      merge(blinkDisabled, blinkOff[1], { fold: true });
    } else if (blinkOn) {
      merge(blinkEnabled, blinkOn[1], { fold: true });
    } else if (disable) merge(disabled, disable[1]);
    else if (enable) merge(enabled, enable[1]);
    else {
      if (/^--screen-info(=|$)/i.test(arg)) screenInfoGiven = true;
      // A fixed switch passed again (a harness adding --disable-sync for safety) is already there.
      // (--disable-component-update asked for at stealth is the caller's choice, and passes.)
      if (fixed.some((s) => s.toLowerCase() === arg.toLowerCase())) continue;
      passthrough.push(arg);
    }
  }
  const conflict = enabled.filter((f) => disabled.includes(f));
  if (conflict.length) throw new Error(`Features both enabled and disabled: ${conflict.join(', ')}.`);
  const blinkConflict = blinkEnabled.filter((f) => blinkDisabled.some((d) => d.toLowerCase() === f.toLowerCase()));
  if (blinkConflict.length) throw new Error(`Blink features both enabled and disabled: ${blinkConflict.join(', ')}.`);

  const args = ['--remote-debugging-pipe', `--user-data-dir=${profileDir}`];
  if (noSandbox) args.push('--no-sandbox');
  if (headless) args.push('--headless=new');
  // Headless reports an 800×600 screen inside whatever window it has (measured on Edge/Chrome/CfT
  // 153): `screen.width < outerWidth`, a classic headless tell. At EVERY level the screen is made
  // `windowSize` (decision D-a), with a Windows taskbar at its bottom, and the window fills the
  // rest of it (headlessGeometry: a maximized window). An explicit --screen-info in extraArgs wins
  // (it is the caller's, and Chromium would keep only the last copy anyway); the window is then
  // exactly `windowSize`. Headed browsers report the real monitor, which is already the truth.
  if (headless && !screenInfoGiven) {
    const geo = headlessGeometry(size);
    args.push(`--window-size=${geo.window.width},${geo.window.height}`);
    args.push(screenInfoSwitch(geo.screen, { workAreaBottom: geo.workAreaBottom }));
  } else {
    args.push(`--window-size=${size.width},${size.height}`);
  }
  args.push(...fixed);
  for (const s of KIND_SWITCHES[kind] ?? []) if (!passthrough.some((p) => p.toLowerCase() === s)) args.push(s);
  args.push(`--disable-features=${disabled.join(',')}`);
  if (enabled.length) args.push(`--enable-features=${enabled.join(',')}`);
  if (blinkDisabled.length) args.push(`--disable-blink-features=${blinkDisabled.join(',')}`);
  if (blinkEnabled.length) args.push(`--enable-blink-features=${blinkEnabled.join(',')}`);
  if (lang) args.push(`--lang=${checkLang(lang)}`);
  const px = normalizeProxy(proxy, proxyBypass);
  if (px) {
    args.push(`--proxy-server=${px.server}`);
    if (px.bypass) args.push(`--proxy-bypass-list=${px.bypass}`);
  }
  args.push(...passthrough);
  if (startUrl) args.push(checkStartUrl(startUrl));
  return args;
}

// ─── process tree ────────────────────────────────────────────────────────────────────────────

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** Kill a process and its descendants, synchronously. Windows: taskkill /T /F — the last resort. */
/**
 * Linux only, and only when asked (G9_BROWSER_NO_SANDBOX=1 in the daemon's environment): launched
 * browsers start without Chromium's sandbox. For a container or a CI machine that cannot run the
 * sandbox at all; never a default, because the sandbox is what keeps a compromised page in its tab.
 */
export function noSandboxWanted({ platform = process.platform, env = process.env } = {}) {
  return platform === 'linux' && env.G9_BROWSER_NO_SANDBOX === '1';
}

/**
 * What to do when a Linux browser died because it could not start its sandbox: Chromium falls back
 * to the setuid helper when unprivileged user namespaces are off (Ubuntu 24.04's AppArmor default,
 * containers), and aborts when that helper is not root-owned with mode 4755 (seen on a hosted
 * Ubuntu 24.04 CI machine with Edge 153). '' when the output shows nothing of the kind.
 */
export function sandboxHint(output) {
  const text = String(output ?? '');
  if (/Running as root without --no-sandbox is not supported/i.test(text)) {
    return '\nThe browser refuses to run as root with its sandbox (Chromium\'s own rule). Run G9BrowserAgent as a normal user; in a disposable container, G9_BROWSER_NO_SANDBOX=1 in the daemon\'s environment starts launched browsers without the sandbox.';
  }
  const helper = /make sure that (\S+) is owned by root and has mode 4755/.exec(text)?.[1];
  if (!helper && !/No usable sandbox|SUID sandbox helper/i.test(text)) return '';
  return '\nThis Linux system cannot start the browser\'s sandbox. ' +
    (helper
      ? `Its helper must be owned by root with mode 4755: sudo chown root:root ${helper} && sudo chmod 4755 ${helper} (reinstalling the browser's package also does it).`
      : 'Allow unprivileged user namespaces, or install the browser from its official package (which sets up its sandbox helper).') +
    ' Only on a disposable machine or container: G9_BROWSER_NO_SANDBOX=1 in the daemon\'s environment starts launched browsers without the sandbox.';
}

/** (3.8.1) Is this process the Windows SYSTEM account (a service, a scheduled task, an agent run by one)? */
export function runsAsWindowsSystem({ platform = process.platform, user = null, home = os.homedir() } = {}) {
  if (platform !== 'win32') return false;
  let name = user;
  if (name == null) { try { name = os.userInfo().username; } catch { name = ''; } }
  return /^system$/i.test(String(name)) || /[\\/]config[\\/]systemprofile$/i.test(String(home ?? ''));
}

/**
 * (3.8.1) What an early exit means, when we know (field reports, 2026-10-13 and -15: "Edge exited with
 * code 1002, printed nothing"). Measured on 155.0.4283.62: Edge exits 1002 at once under SYSTEM, with
 * or without --edge-skip-compat-layer-relaunch, while Chrome starts there.
 */
export function startFailureHint({ kind = null, exit = null, system = runsAsWindowsSystem() } = {}) {
  if (system) {
    return '\nThis G9BrowserAgent daemon runs as the Windows SYSTEM account (a service or scheduled task started the MCP ' +
      'client that started it). ' + (kind === 'edge' ? 'Microsoft Edge does not run as SYSTEM (it exits with code 1002); Chrome and Chrome for Testing do: pass browser:"chrome" or browser:"cft". ' : '') +
      'Better: run the MCP client as the signed-in user, so the daemon and its browsers are that user\'s.';
  }
  if (kind === 'edge' && exit?.code === 1002) {
    return '\nEdge exits with code 1002 when it refuses the account or session it was started in (measured: the Windows ' +
      'SYSTEM account). Check which account the daemon runs as (browser_status: daemon.home), or pass browser:"chrome".';
  }
  return '';
}

export function killTree(pid) {
  if (!pid) return false;
  if (process.platform === 'win32') {
    const res = spawnSync(systemBinary('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000, encoding: 'utf8' });
    return res.status === 0;
  }
  try { process.kill(-pid, 'SIGKILL'); return true; } catch {}
  try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
}

const USER_DATA_SWITCH = '--user-data-dir=';

/**
 * Does this command line run with --user-data-dir = `profileDir` EXACTLY? A plain substring test is
 * not enough: G9BrowserAgent profiles are siblings under one folder, so the dir of profile "qa" is a prefix of
 * the dir of profile "qa-2", and a substring sweep after stopping "qa" would kill the browser of an
 * unrelated, running engine. The dir must be the switch's whole value, and where the value ends
 * depends on its quoting: Node quotes the whole argument (`"--user-data-dir=C:\a b"`), Chromium
 * quotes the value (`--user-data-dir="C:\a b"`) — in both a quoted value ends only at the quote,
 * so "C:\a b" is not a match inside "C:\a b 2" — and an unquoted value ends at whitespace or the
 * end of the line.
 */
export function commandLineUsesProfile(commandLine, profileDir) {
  if (!commandLine || !profileDir) return false;
  const win = process.platform === 'win32';
  const fold = (s) => (win ? s.toLowerCase() : s);
  const hay = fold(String(commandLine));
  const needle = fold(path.resolve(profileDir).replace(/[\\/]+$/, ''));
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    let quoted;
    if (hay.slice(0, at).endsWith(`${USER_DATA_SWITCH}"`)) quoted = true;                 // --user-data-dir="…"
    else if (hay.slice(0, at).endsWith(USER_DATA_SWITCH)) quoted = hay[at - USER_DATA_SWITCH.length - 1] === '"';   // "--user-data-dir=…"
    else continue;
    const after = hay.slice(at + needle.length);
    // A trailing separator is allowed, doubled too (Windows quoting doubles a backslash before a quote).
    if ((quoted ? /^[\\/]*"/ : /^[\\/]*(?:\s|$)/).test(after)) return true;
  }
  return false;
}

/**
 * Processes launched with `profileDir` as their --user-data-dir → [{ pid, name }]. Every Chromium
 * child process (renderer, GPU, utility, crashpad) is started with the browser's --user-data-dir,
 * so a unique profile dir identifies exactly the processes of one launch and never anyone else's
 * browser (commandLineUsesProfile says what "exactly" means).
 */
export async function findProfileProcesses(profileDir) {
  const needle = path.resolve(profileDir);
  if (process.platform === 'win32') {
    // PowerShell only pre-filters (cheap substring); the exact test runs here, in one place. The
    // command line crosses as base64 UTF-8 so a non-ASCII profile path (a user name in Persian,
    // say) is not mangled by the console code page on the way.
    const script =
      "$d = $env:G9_PROFILE_NEEDLE; " +
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe' OR Name='chrome_crashpad_handler.exe' OR Name='msedge_crashpad_handler.exe'\" | " +
      "Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | " +
      "ForEach-Object { \"$($_.ProcessId)`t$($_.Name)`t$([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.CommandLine)))\" }";
    return new Promise((resolve) => {
      const child = spawn(systemBinary('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, G9_PROFILE_NEEDLE: needle },
      });
      let out = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, 20_000);
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', () => { clearTimeout(timer); resolve([]); });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(out.split(/\r?\n/).filter(Boolean).map((line) => {
          const [pid, name, cmd64 = ''] = line.split('\t');
          return { pid: Number(pid), name, commandLine: Buffer.from(cmd64, 'base64').toString('utf8') };
        }).filter((p) => p.pid && p.pid !== process.pid && commandLineUsesProfile(p.commandLine, needle))
          .map(({ pid, name }) => ({ pid, name })));
      });
    });
  }
  const res = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return (res.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => commandLineUsesProfile(l, needle)).map((l) => {
    const [pid, ...cmd] = l.split(/\s+/);
    return { pid: Number(pid), name: path.basename(cmd[0] ?? '') };
  }).filter((p) => p.pid && p.pid !== process.pid);
}

// Browsers still running when this Node process exits are killed with it: an orphaned engine would
// hold its profile lock (and a person's login) until someone found it in Task Manager.
const live = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const h of live) {
      try { if (!h.hasExited()) killTree(h.pid); } catch {}
    }
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keep the last `limit` characters of a stream (the browser's stderr, for error messages). */
function tailBuffer(limit = 32 * 1024) {
  let text = '';
  return {
    push(chunk) { text = (text + chunk.toString('utf8')).slice(-limit); },
    get(lines = 40) { return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n'); },
  };
}

/**
 * (3.5) Headless at stealth: the user agent a headed window of the same browser sends.
 *
 * Measured 2026-10-12 on Edge 154 headless at stealth (a page, a cross-origin iframe, a dedicated
 * worker, and the request headers the server received): only the user-agent STRING gave headless
 * away ("… HeadlessChrome/154.0.0.0 … Edg/154.0.0.0"), everywhere. navigator.userAgentData's
 * brands and the Sec-CH-UA header were already the real ones ("Chromium", "Microsoft Edge",
 * "Not A(Brand"). A `--user-agent` switch with only HeadlessChrome → Chrome fixed the page, the
 * iframe, the worker and every header, and left the brands untouched. A CDP override had to restate
 * the brand list and got its GREASE brand wrong — one tell swapped for another — so it is not used.
 * This removes the one headless-only mismatch; it invents nothing (decision D-a's rule).
 *
 * The browser's own user agent is learned from a first start (Browser.getVersion) and cached per
 * executable and version, so only the first stealth headless launch of a browser pays a restart.
 */
const HEADLESS_UA = new Map(); // `${path}|${version}` → user agent

export function headedUserAgent(userAgent) {
  return /HeadlessChrome\//.test(String(userAgent ?? '')) ? String(userAgent).replace(/HeadlessChrome\//g, 'Chrome/') : null;
}

/** Parse Browser.getVersion's product ("HeadlessChrome/153.0.8010.52", "Chrome/…", "Edg/…"). */
export function parseProduct(product) {
  const m = /\/(\d+\.\d+\.\d+\.\d+)/.exec(product ?? '');
  return m ? m[1] : null;
}

/**
 * Start a browser.
 *
 * opts:
 *   browser      'auto'|'edge'|'chrome'|'cft', an executable path, or a resolveBrowser() result
 *   headless     default true (→ --headless=new)
 *   profileDir   the user-data-dir; default: a fresh temp dir, deleted by close(). A browser's
 *                default user-data dir (or anything inside one) is refused.
 *   windowSize   { width, height } default 1920×1080 (headless's own default, 800×600, is itself a signal).
 *                Headed: the window. Headless: the SCREEN (--screen-info, decision D-a) with a taskbar
 *                work area, and the window fills that work area (headlessGeometry) — unless extraArgs
 *                carry their own --screen-info, when the window is exactly windowSize
 *   proxy        'host:port' | 'scheme://host:port' | { server, bypass }; proxyBypass: string|string[]
 *                (a per-context proxy via Target.createBrowserContext is preferred — engine manager)
 *   lang         UI language / default Accept-Language, e.g. 'de-DE'
 *   extraArgs    more switches (validated: nothing that identifies automation, nothing owned above)
 *   stealth      'off'|'human'|'stealth' — adds stealth.launchArgsFor(level): nothing at off/human,
 *                --disable-blink-features=AutomationControlled at stealth (decision D-a)
 *   startUrl     the first tab's URL (default 'about:blank'; null = the browser's own choice)
 *   timeoutMs    how long the browser has to answer Browser.getVersion (default 30 s)
 *   env          extra environment variables for the browser process
 *   home         G9_HOME (for resolving an installed Chrome for Testing)
 *   name         label for error messages (default "<kind> <version>")
 *
 * → { pid, conn, argv, args, browser: { kind, path, version, fileVersion, product, userAgent,
 *     protocolVersion, revision, jsVersion, channel }, profileDir, tempProfile, headless, stealth,
 *     windowSize, startedAt, warnings, exited: Promise<{ code, signal }>, hasExited(),
 *     stderrTail(lines?), close(opts?) }
 */
export async function launchBrowser({
  browser = 'auto', headless = true, profileDir, windowSize = DEFAULT_WINDOW, proxy, proxyBypass, lang,
  extraArgs = [], stealth = 'off', startUrl = 'about:blank', timeoutMs = 30_000, env, home, name,
  componentUpdate = null, headlessUserAgent = null,
} = {}) {
  const original = arguments[0] ?? {};
  // JSON callers send null for "not set"; null must mean the default (see buildArgs).
  headless = headless ?? true;
  windowSize = windowSize ?? DEFAULT_WINDOW;
  extraArgs = extraArgs ?? [];
  timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000;
  const level = normalizeLevel(stealth);
  const target = typeof browser === 'object' && browser?.path
    ? await resolveBrowser(browser, { home })
    : await resolveBrowser(browser ?? 'auto', { home });

  let dir;
  let tempProfile = false;
  if (profileDir) {
    dir = path.resolve(profileDir);
    if (isDefaultUserDataDir(dir)) {
      throw new Error(`Refusing to launch on ${dir}: that is (or is inside) a browser's default user-data directory. Engine 2 only uses G9BrowserAgent profiles (engine/profile.js) or temporary directories.`);
    }
    await mkdir(dir, { recursive: true });
    const use = await profileInUse(dir);
    if (use.inUse) {
      // A second browser on the same user-data-dir does not start: it hands its command line to the
      // running one and exits, and this launch would fail later with a confusing "pipe closed".
      throw new Error(`The profile ${dir} is already in use by a running browser (${use.how}). Stop that engine or use another profile.`);
    }
  } else {
    dir = await mkdtemp(path.join(os.tmpdir(), 'g9-engine-'));
    tempProfile = true;
  }

  // Build (and validate) before spawning anything.
  let args;
  // (3.5) headedUserAgent: at stealth, headless, unless the caller set a user agent itself.
  const uaKey = `${target.path}|${target.version ?? ''}`;
  const ownUserAgent = (extraArgs ?? []).some((a) => /^--user-agent=/i.test(String(a)));
  const fixUserAgent = level === 'stealth' && !!headless && !ownUserAgent;
  const knownUserAgent = fixUserAgent ? (headlessUserAgent ?? HEADLESS_UA.get(uaKey) ?? null) : null;
  try {
    args = buildArgs({ profileDir: dir, headless, windowSize, proxy, proxyBypass, lang, extraArgs: knownUserAgent ? [...(extraArgs ?? []), `--user-agent=${knownUserAgent}`] : extraArgs, stealth: level, startUrl, kind: target.kind, componentUpdate, noSandbox: noSandboxWanted() });
  } catch (err) {
    if (tempProfile) await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  const argv = [target.path, ...args];
  const label = name ?? `${target.kind} ${target.version ?? ''}`.trim();
  const warnings = launchWarnings({ level, headless, kind: target.kind });

  const stderr = tailBuffer();
  const startedAt = new Date().toISOString();
  let child;
  try {
    child = spawn(target.path, args, {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
      // Hiding a HEADED browser's start-up window would pass SW_HIDE to its first ShowWindow — a
      // hidden window, the very state that stops rendering. Headless has no window; hide nothing.
      windowsHide: !!headless,
      // POSIX: its own process group, so killTree can signal the whole group.
      detached: process.platform !== 'win32',
      // Never the runtime's own variables: from a Linux AppImage, LD_LIBRARY_PATH into its mount
      // breaks a system Chrome, and ELECTRON_RUN_AS_NODE must not reach anything the browser starts.
      env: env ? { ...cleanChildEnv(process.env), ...env } : cleanChildEnv(process.env),
    });
  } catch (err) {
    // Windows throws synchronously for a file that is not an executable ("spawn UNKNOWN").
    if (tempProfile) await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Could not start ${label} (${target.path}): ${err.code ?? err.message}. Is it a browser executable?`);
  }
  child.stdout?.on('data', (d) => stderr.push(d));
  child.stderr?.on('data', (d) => stderr.push(d));
  // The once('error') handlers below are consumed by the first error; a later one (a failed kill,
  // say) with no listener left would be an uncaught exception in the daemon.
  child.on('error', () => {});

  let exitInfo = null;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => { exitInfo = { code, signal }; resolve(exitInfo); });
    child.once('error', (err) => { if (!exitInfo) { exitInfo = { code: null, signal: null, error: err.message }; resolve(exitInfo); } });
  });
  const hasExited = () => exitInfo !== null;

  const spawnFailed = new Promise((_, reject) => child.once('error', (err) => reject(new Error(
    `Could not start ${label} (${target.path}): ${err.code ?? err.message}.`,
  ))));
  spawnFailed.catch(() => {});

  const conn = new PipeCdp(child.stdio[3], child.stdio[4], { name: label, child });

  const cleanupFailedStart = async ({ exitedEarly = false } = {}) => {
    if (!hasExited()) killTree(child.pid);
    await Promise.race([exited, delay(5000)]);
    conn.close('launch failed');
    // (3.8.1) A browser that relaunched itself (Edge's compat layer) is not in our process tree, but
    // it runs on OUR profile: end it, or every failed start leaves a headless browser behind.
    // Only when it exited by itself: one we killed after a timeout went with its own tree.
    if (exitedEarly) for (const p of await findProfileProcesses(dir).catch(() => [])) killTree(p.pid);
    if (tempProfile) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  };

  let version;
  try {
    version = await Promise.race([conn.send('Browser.getVersion', {}, null, { timeoutMs }), spawnFailed]);
  } catch (err) {
    await delay(200);   // let the exit code and the last stderr lines arrive
    // (3.8.2) Taken BEFORE the cleanup: it kills a browser that is still running, after which exitInfo is
    // always set, and a hung browser read as one that "exited before it was ready" (the auto fallback).
    const earlyExit = exitInfo;
    const exit = earlyExit ? ` The browser exited (${earlyExit.signal ? `signal ${earlyExit.signal}` : `code ${earlyExit.code}`}).` : '';
    const tail = stderr.get();
    await cleanupFailedStart({ exitedEarly: !!earlyExit });
    const failure = new Error(
      `${label} did not become ready: ${err.message}${exit}` + sandboxHint(tail) + startFailureHint({ kind: target.kind, exit: earlyExit }) +
      (tail ? `\nLast browser output:\n${tail}` : '\n(The browser printed nothing.)'),
    );
    // (3.8.1) "auto" chose this browser, and it exited before it was ready: another installed one
    // may well start (Edge does not run as SYSTEM; Chrome does). Once, and said in the warnings.
    const auto = original.browser == null || original.browser === 'auto';
    if (auto && earlyExit) {
      const order = ['chrome', 'cft', 'edge'];
      const next = (await findBrowsers({ home }).catch(() => []))
        .filter((b) => b.path !== target.path && order.includes(b.kind))
        .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0];
      if (next) {
        const nextLabel = `${next.kind}${next.version ? ` ${next.version}` : ''}`;
        const retried = await launchBrowser({ ...original, browser: { kind: next.kind, path: next.path, version: next.version, channel: next.channel ?? null } })
          .catch((again) => { throw new Error(`${failure.message}\n\n${nextLabel} was tried instead and did not start either: ${again.message}`); });
        retried.warnings = [
          `${label} exited before it was ready (${earlyExit.signal ? `signal ${earlyExit.signal}` : `code ${earlyExit.code}`}), so ${nextLabel} was launched instead (browser "auto").` +
            (profileDir ? ' Sign-ins this profile kept for the other browser may not be readable by this one.' : ''),
          ...(retried.warnings ?? []),
        ];
        return retried;
      }
    }
    throw failure;
  }

  const info = {
    kind: target.kind,
    path: target.path,
    version: parseProduct(version.product) ?? target.version,
    fileVersion: target.version ?? null,
    product: version.product,
    userAgent: version.userAgent,
    protocolVersion: version.protocolVersion,
    revision: version.revision,
    jsVersion: version.jsVersion,
    channel: target.channel ?? null,
  };

  // Chrome for Testing has no firewall rule of its own, so Windows may ask about it once per exe
  // path. Said on the first launch from a path (G9_HOME/engines/firewall-seen.json), never again;
  // noted only once the browser really started. engine/firewall.js.
  const firewall = await noteFirewallLaunch({ home: home ?? undefined, exePath: target.path, kind: target.kind });
  if (firewall.warning) warnings.push(firewall.warning);

  // Child process ids, for the leftover check in close(). Best effort: not every build answers.
  let knownPids = [];
  const refreshPids = async () => {
    try {
      const { processInfo } = await conn.send('SystemInfo.getProcessInfo', {}, null, { timeoutMs: 5000 });
      knownPids = [...new Set((processInfo ?? []).map((p) => p.id).filter((id) => id && id !== child.pid))];
    } catch {}
  };

  const handle = {
    pid: child.pid,
    conn,
    argv,
    args,
    browser: info,
    profileDir: dir,
    tempProfile,
    headless: !!headless,
    stealth: level,
    windowSize: checkWindowSize(windowSize),
    startedAt,
    warnings,
    exited,
    child,
    hasExited,
    stderrTail: (lines) => stderr.get(lines),
    close: null,
  };

  let closing = null;
  /**
   * Stop the browser: Browser.close (a clean shutdown writes cookies and prefs to disk — a killed
   * browser can lose the last minutes of a warmed login), wait, then kill the tree as the last
   * resort. Then make sure nothing launched with this profile is still running, and delete a
   * temporary profile. Idempotent. → { exit, killed, leftovers, profileRemoved, gracefulMs, closeMs }
   * (`exit` is { code, signal }, or { code:null, signal:null, gone:true } when the process is gone
   * but its exit event has not arrived yet; null only while it is still running.)
   */
  handle.close = ({ timeoutMs: closeTimeoutMs = GRACEFUL_EXIT_MS, removeTempProfile = true } = {}) => {
    if (closing) return closing;
    closing = (async () => {
      let killed = false;
      const closeStarted = Date.now();
      if (!hasExited()) {
        await refreshPids();
        conn.send('Browser.close', {}, null, { timeoutMs: 5000 }).catch(() => {});
        await Promise.race([exited, delay(closeTimeoutMs)]);
      }
      const gracefulMs = Date.now() - closeStarted;
      if (!hasExited()) {
        killed = killTree(child.pid);
        await Promise.race([exited, delay(5000)]);
      }
      conn.close(`${label}: closed by G9BrowserAgent`);
      live.delete(handle);

      // Children normally exit with the browser; a GPU or utility process can lag by a moment.
      let leftovers = [];
      const stragglers = async () => knownPids.filter(alive);
      for (let i = 0; i < 10 && (await stragglers()).length; i++) await delay(200);
      if ((await stragglers()).length) {
        leftovers = await findProfileProcesses(dir);
        for (const p of leftovers) killTree(p.pid);
        if (leftovers.length) await delay(500);
      }

      let profileRemoved = false;
      if (tempProfile && removeTempProfile) {
        for (let attempt = 0; attempt < 6 && !profileRemoved; attempt++) {
          try {
            await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
            profileRemoved = true;
          } catch {
            await delay(300 * (attempt + 1));
          }
        }
      }
      // `exitInfo` is written by the child's 'exit' event. A browser that goes away while the OS is
      // busy can leave that event a moment behind, and a caller reading `exit.code` on null crashes
      // for a shutdown that actually worked. When the pid is gone, say so rather than nothing.
      const exit = exitInfo ?? (alive(child.pid) ? null : { code: null, signal: null, gone: true });
      return { exit, killed, leftovers, profileRemoved, gracefulMs, closeMs: Date.now() - closeStarted };
    })();
    return closing;
  };

  live.add(handle);
  installExitHook();
  exited.then(() => live.delete(handle));

  // (3.5) The first stealth headless start of this browser: it said HeadlessChrome. Learn its
  // user agent, and start it again with the headed one (see headedUserAgent).
  if (fixUserAgent && !knownUserAgent) {
    const ua = headedUserAgent(info.userAgent);
    if (ua) {
      HEADLESS_UA.set(uaKey, ua);
      await handle.close().catch(() => {});
      return launchBrowser({ ...original, headlessUserAgent: ua });
    }
  }
  if (knownUserAgent) handle.browser.headedUserAgent = knownUserAgent;
  return handle;
}
