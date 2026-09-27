// engine/stealth.js — what each stealth level changes in Engine 2, and what it deliberately does not.
//
// Decision D10 (AIGuide §2.0): stealth is a per-profile level, not a global mode. `off` / `human` / `stealth`.
//   off      direct CDP input (v1 behaviour), every convenience domain enabled
//   human    human-like input (extension/humanize/), same domains as off
//   stealth  human input AND an environment a detector cannot tell from a person's browser:
//            the Runtime domain is never enabled (rule R4, AIGuide §2.9), nothing lives in the main world
//
// The one rule this file encodes above all: consistency beats spoofing (§6.4). A real Chrome/Edge
// binary with a real profile is already a real browser. Every "stealth switch" people pass to
// Puppeteer changes the fingerprint away from what that same browser looks like on a person's
// desktop — which is exactly what a fingerprinting detector compares against.

export const LEVELS = ['off', 'human', 'stealth'];

/** Validate a level name → the level, or throw naming the valid ones. */
export function normalizeLevel(level = 'off') {
  const l = String(level ?? 'off').toLowerCase();
  if (!LEVELS.includes(l)) throw new Error(`Unknown stealth level "${level}". Use one of: ${LEVELS.join(', ')}.`);
  return l;
}

const BASE_DOMAINS = ['Page', 'Runtime', 'Log', 'Network', 'DOM', 'CSS'];

/**
 * CDP domains the engine may enable automatically on every page of a context at this level.
 *
 * `Runtime` is absent in stealth: enabling it makes the renderer report and serialise every console
 * call's arguments to the client, which pages can observe (a getter on a logged object fires; the
 * classic `console.debug(errorWithStackGetter)` probe). Consequences, stated in the tool results:
 * no page console capture in stealth (`Log` still gives browser-side entries), and evaluation runs
 * in isolated worlds whose context ids come from Page.createIsolatedWorld, not from
 * Runtime.executionContextCreated.
 */
export function autoEnableDomains(level) {
  const l = normalizeLevel(level);
  return l === 'stealth' ? BASE_DOMAINS.filter((d) => d !== 'Runtime') : [...BASE_DOMAINS];
}

/** Domains that must never be enabled at this level (a tool asking for one fails, naming the level). */
export function forbiddenDomains(level) {
  return normalizeLevel(level) === 'stealth' ? ['Runtime'] : [];
}

export function isDomainAllowed(level, domain) {
  return !forbiddenDomains(level).includes(domain);
}

/**
 * The one switch that clears navigator.webdriver on a pipe-driven browser (owner decision D-a below).
 * Exported so launch.js can tell "the level added it" from "a caller smuggled it in via extraArgs".
 */
export const WEBDRIVER_SWITCH = '--disable-blink-features=AutomationControlled';

/**
 * Launch switches a level adds on top of the designed list (engine/README.md).
 *
 * off / human: nothing. stealth: exactly one switch, WEBDRIVER_SWITCH.
 *
 * OWNER DECISION D-a (2026-09-22, made under the owner's explicit requirement that stealth runs must
 * be undetectable; supersedes the designed list's ban for the `stealth` level only):
 * MEASURED on Edge 153.0.4234.32, Chrome 153.0.8010.50 and CfT 153.0.8010.52: `--remote-debugging-pipe`
 * ITSELF turns Blink's AutomationControlled runtime feature on, so every Engine 2 page reports
 * navigator.webdriver === true — headless or headed, with no --enable-automation anywhere. Headless
 * without the pipe: false. Pipe + `--disable-blink-features=AutomationControlled`: false. The CDP
 * command Emulation.setAutomationOverride({enabled:false}) does NOT clear it. A stealth run that
 * answers `navigator.webdriver` with `true` is detected by the cheapest check there is, so stealth
 * passes the switch. It is the ONLY switch stealth adds, and only stealth adds it: at off/human the
 * page tells the truth (webdriver true; launchWarnings says so) and launch.js keeps refusing the
 * switch in extraArgs there.
 *
 * Why stealth still adds nothing else:
 * * `--enable-automation` shows the "controlled by automated test software" bar and sets
 *   navigator.webdriver. G9BrowserAgent never passes it, at any level; launch.js refuses it always.
 * * `--disable-features=AutomationControlled`: there is no such Chromium *feature*; the flag is
 *   folklore (AutomationControlled is a Blink runtime feature, see above). Useless.
 * * UA / Client Hints / platform / WebGL / languages overrides by switch: each one creates a
 *   mismatch between what the browser claims and what it is (JS engine features, fonts, GPU,
 *   TLS/HTTP2 fingerprints are not changed by a switch). Detectors look for exactly those
 *   contradictions. A stock binary telling the truth has none.
 * * `--headless` identifies automation (the UA and userAgentData say HeadlessChrome — measured).
 *   It is chosen by the caller, not by this level; launchWarnings() says so. The headless screen
 *   (800×600 whatever --window-size says — measured) is fixed at EVERY level by launch.js, which
 *   gives every headless launch `--screen-info={W×H workAreaBottom=48}` and a window that fills
 *   that work area (decision D-a, and live round 2: a screen without a taskbar is itself a tell).
 *   The GPU is NOT a headless tell on a machine that has one: headless Edge and CfT 153 reported
 *   the real "ANGLE (NVIDIA … Direct3D11 …)" renderer in 30/30 headless runs (live round 2).
 */
export function launchArgsFor(level) {
  return normalizeLevel(level) === 'stealth' ? [WEBDRIVER_SWITCH] : [];
}

/**
 * Human-readable warnings for a launch configuration (not errors: the caller may know better).
 *
 * off/human: one honest fact — navigator.webdriver is true there (the pipe sets it; only stealth
 * clears it). stealth: the environment signals no level can remove — headless, and the Chrome for
 * Testing build itself (`kind: 'cft'`).
 *
 * The headless text names what was MEASURED to give headless away (live round 2, Edge and CfT 153,
 * public detectors: sannysoft, creepjs, browserscan, pixelscan, Fingerprint, rebrowser all flagged
 * headless stealth; headed stealth passed four of six): the HeadlessChrome brand in the user agent
 * and userAgentData, and a window whose outer size reads 0×0 at the load event on some navigations.
 * A software GL renderer is only a tell on machines without a GPU — this one reported its real GPU.
 */
export function launchWarnings({ level = 'off', headless = true, kind = null } = {}) {
  const l = normalizeLevel(level);
  const out = [];
  if (l !== 'stealth') {
    out.push(
      `stealth "${l}": navigator.webdriver is true on every page of this browser, because ` +
      '--remote-debugging-pipe enables Blink\'s AutomationControlled feature (measured; see engine/README.md ' +
      '"navigator.webdriver"). Only stealth "stealth" clears it (decision D-a).',
    );
    return out;
  }
  if (headless) {
    out.push(
      'stealth with headless=true: headless leaves signals no level can remove — the user agent and ' +
      'userAgentData say HeadlessChrome, and the window\'s outer size can read 0×0 at the load event. ' +
      'Public detectors flagged every headless stealth run in G9BrowserAgent\'s own test (docs/STEALTH.md). On a ' +
      'machine without a GPU, a software GL renderer string is a further tell. Run stealth-critical ' +
      'suites headed on a dedicated desktop (docs/STEALTH.md).',
    );
  }
  if (kind === 'cft') {
    out.push(
      'stealth on Chrome for Testing: detectors read its brand ("Google Chrome for Testing" is a red flag ' +
      'on rebrowser\'s bot detector, headed runs included) and the Chromium build ships no Widevine key ' +
      'system, which detectors also read. Its renderer also ran at 10 Hz on the machine G9BrowserAgent was measured ' +
      'on (100 ms between frames and between the page\'s mousemove events, re-confirmed 2026-09-23 in an ' +
      'interleaved A/B against Edge); G9BrowserAgent passes --disable-frame-rate-limit to CfT for that (measured ' +
      '~57 Hz with it — engine/launch.js KIND_SWITCHES), which Edge and Chrome do not need. Prefer Edge ' +
      'or Chrome for stealth (docs/STEALTH.md).',
    );
  }
  return out;
}

// ─── locale / timezone / Accept-Language consistency (STEALTH.md) ────────────────────────────

function hostTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; }
}

/** ICU's canonical id for a zone ('Asia/Kolkata' and 'Asia/Calcutta' compare equal), or null if invalid. */
function canonicalZone(tz) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone; } catch { return null; }
}

function regionZones(region) {
  try {
    const loc = new Intl.Locale(`und-${region}`);
    const zones = typeof loc.getTimeZones === 'function' ? loc.getTimeZones() : loc.timeZones;
    return Array.isArray(zones) && zones.length ? zones : null;
  } catch {
    return null;
  }
}

/** Parse an Accept-Language header → [{ tag, q }] in header order; bad items are reported. */
export function parseAcceptLanguage(header) {
  const items = [];
  const problems = [];
  for (const raw of String(header).split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const [tag, ...params] = part.split(';').map((s) => s.trim());
    let q = 1;
    for (const p of params) {
      // RFC 9110 §12.4.2: qvalue = ( "0" [ "." 0*3DIGIT ] ) / ( "1" [ "." 0*3("0") ] ) — 1.5 is not a q.
      const m = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.exec(p);
      if (m) q = Number(m[1]);
      else problems.push(`Accept-Language item "${part}" has an invalid parameter "${p}".`);
    }
    if (tag === '*') { items.push({ tag, q }); continue; }
    try {
      items.push({ tag: Intl.getCanonicalLocales(tag)[0], q });
    } catch {
      problems.push(`Accept-Language item "${tag}" is not a valid language tag.`);
    }
  }
  return { items, problems };
}

/**
 * Do locale, timezone and Accept-Language tell one consistent story? → string[] of problems ([] = fine).
 *
 * Whatever is NOT set comes from the host, because that is what the launched browser will report:
 * a context with locale 'de-DE' on a machine in Asia/Tehran says "German speaker in Iran", which is
 * possible for a person and a classic mismatch for a detector. Pass `hostTimezone: null` to skip
 * that comparison.
 */
export function checkConsistency({ locale, timezone, acceptLanguage, hostTimezone: host = hostTimezone() } = {}) {
  const problems = [];

  let loc = null;
  if (locale) {
    try {
      loc = new Intl.Locale(Intl.getCanonicalLocales(locale)[0]);
    } catch {
      problems.push(`Locale "${locale}" is not a valid BCP 47 language tag (use e.g. "en-US", "de-DE", "fa-IR").`);
    }
  }

  let zone = null;
  if (timezone) {
    zone = canonicalZone(timezone);
    if (!zone) problems.push(`Timezone "${timezone}" is not an IANA time zone (use e.g. "Europe/Berlin", "America/New_York").`);
  }

  if (acceptLanguage) {
    const { items, problems: headerProblems } = parseAcceptLanguage(acceptLanguage);
    problems.push(...headerProblems);
    if (!items.length) {
      problems.push(`Accept-Language "${acceptLanguage}" names no language.`);
    } else {
      const qs = items.map((i) => i.q);
      if (qs.some((q, i) => i > 0 && q > qs[i - 1])) {
        problems.push(`Accept-Language "${acceptLanguage}" lists a language after one it prefers less (q-values must not increase); browsers never send that.`);
      }
      if (loc) {
        const first = items[0].tag === '*' ? null : new Intl.Locale(items[0].tag);
        if (first && first.language !== loc.language) {
          problems.push(`Accept-Language starts with "${items[0].tag}" but the locale is "${loc.baseName}": a browser sends its UI language first.`);
        } else if (first && loc.region && first.region && first.region !== loc.region) {
          problems.push(`Accept-Language starts with "${items[0].tag}" but the locale is "${loc.baseName}" (same language, different region).`);
        }
      }
    }
  }
  // No Accept-Language given is not an error: the browser derives it from --lang /
  // intl.accept_languages, which the launcher sets from the same locale.

  // Region ↔ timezone. The zone that the page will see is the explicit one, else the host's.
  const effectiveZone = zone ?? (timezone ? null : (host ? canonicalZone(host) : null));
  if (loc?.region && effectiveZone) {
    const zones = regionZones(loc.region);
    if (zones) {
      const canon = new Set(zones.map((z) => canonicalZone(z) ?? z));
      if (!canon.has(effectiveZone) && !zones.includes(effectiveZone)) {
        const source = zone ? 'timezone' : 'host timezone (no timezone was set)';
        const sample = zones.slice(0, 4).join(', ') + (zones.length > 4 ? ', …' : '');
        problems.push(`Locale "${loc.baseName}" is region ${loc.region}, but the ${source} "${effectiveZone}" is not used there (${loc.region}: ${sample}). Set a timezone that matches, or a locale that matches the zone.`);
      }
    }
  }

  // A zone without a locale: the host language shows through. That is only a problem when the host
  // language's region contradicts the zone, which cannot be known reliably here, so it is not flagged.
  return problems;
}
