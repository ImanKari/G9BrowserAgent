# Stealth — what G9BrowserAgent can hide, what it cannot, and how to check

This is the owner-facing guide to the stealth levels (decision D10, AIGuide §2.0), and their
specification. The code is:
- `engine/stealth.js` and `engine/launch.js`: the environment;
- `extension/lib/humanize.js` and `extension/humanize/`: behaviour (see `docs/HUMANIZE.md`);
- `setup/stealthtest.mjs`: the self-test.

Detectors change. Re-measure before you rely on anything below.

**Where the numbers come from.** Everything was measured on the owner's workstation on 2026-09-22,
except the final pass and the CfT frame-rate A/B of 2026-09-23: Windows 11 Pro 10.0.26200, Edge
153.0.4234.32, Chrome 153.0.8010.53, and Chrome for Testing (CfT) 153.0.8010.52, which is G9BrowserAgent's pinned
build. 2.0.2, 2.0.3, 3.0.0, 3.0.1 and 3.1.0 changed no launch switch, stealth rule or input dispatch since that
final pass (they changed replay, evidence pruning, watch ordering, the browser close budget, the
Engine 1 popout, whose effect on a page is noted [below](#what-the-tools-do-differently-at-stealth),
and in 3.0.0 the side panel). One 3.0.0 change matters in the person's own browser: Engine 1's
auto-attach now defaults to **Project sites** on a new install, so a tab on the site of a connected
agent's `g9.project.json` environment has G9BrowserAgent attached from its first load, as **All tabs** did for
every site. An install upgraded from 2.x keeps its setting.

| Name used below | What ran |
|---|---|
| **live round 2** | The stealth suite on the code before the stealth fixes: the whole matrix 3 times, 50 local-page runs and 96 public-page evaluations. |
| **fix round 2** | The fixer's re-measurement after round 2: one matrix pass with the public pages (7 local runs, 36 public evaluations), then local-page passes of 21 runs and, on the final code of that round, 14 runs. |
| **live round 3** | The stealth suite again, extended: 54 local-page runs, 59 public-page evaluations, 20 sweeps of every read tool (520 calls), 18 popup tests, 5 sign-in-refusal checks. |
| **final** | The fixes after round 3, re-measured on the local page: 3 passes over Edge headless/headed/`de-DE` stealth, the human control and CfT. The public pages were **not** re-run on this code. |
| **this guide's run** | `node setup/stealthtest.mjs --local-only --browser edge`: 1 run of `edge-headless-stealth` on the final code, 14:51–14:53 UTC. |
| **final pass (2.0.1)** | 2026-09-23, on the 2.0.1 code: `setup/stealthtest.mjs --matrix` over all 7 configurations, twice — once on the local page alone, once with the public pages — with the same verdicts both times (AIGuide §9, the 2.0.1 entry). |

## First, the five things to know

1. **Behaviour can be made indistinguishable; environment can only be made consistent. Both are
   needed.** A human-like mouse in a browser that says "HeadlessChrome" is still caught.
2. **This is an arms race.** Vendors change their signals. Run the self-test before you trust a run,
   and never assume yesterday's pass still holds.
3. **Do not fight your own product's detector in ordinary suites.** Give the runner a legitimate
   identification (a header, a token, an environment flag), and test the detector separately with
   dedicated cases. For third-party captcha or fraud widgets, use the vendor's test keys or staging
   mode where they exist. Stealth is for widgets that have no test mode.
4. **`stealth` costs something.** You get no page console capture, slower runs, and you need a
   headed desktop for the strict cases.
5. **Nothing here works on a person's own desktop while they use it.** That is why Engine 2 (a
   browser G9BrowserAgent launches) exists. Engine 1 (the extension in the person's browser) is for authoring;
   see [Engine 1 and stealth](#engine-1-the-extension-and-stealth-input-rules-only).

## The three levels

A level is set per launched engine or context (`browser_engine action:"launch" stealth:"…"`). It is
also a floor for input (decision D-b, `lib/humanize.js levelFor`): a stealth context gets stealth
input rules even when a call asks for less. The result then says `humanize.raisedFrom`.

**Stealth has two halves, and only one of them is per context.** The ENVIRONMENT half is set by the
launch: `--disable-blink-features=AutomationControlled` (so `navigator.webdriver` is false) and
component updates left on (so Widevine is present on Edge and Chrome). A switch cannot be applied to
a context, so a stealth context inside an engine launched at `off` or `human` gets only the rest —
the Runtime rule and the input floor — and every page in it still reports `navigator.webdriver`
true. `createContext` says so in the context's `warnings`, and the tab's status reports
`environmentStealth`. For a stealth run, launch the engine at stealth on its own profile.

| | `off` | `human` | `stealth` |
|---|---|---|---|
| Input | v1's direct CDP events | human paths, timing, wheel and typing | as `human`, with no shortcut a page can see: no `DOM.focus`, no programmatic scroll (G9BrowserAgent fails and says why instead), no `Input.insertText` unless `fast:true` |
| `navigator.webdriver` | `true` (the pipe sets it; G9BrowserAgent warns at launch) | `true` | `false` **when the ENGINE was launched at stealth**. This is the one switch stealth adds, `--disable-blink-features=AutomationControlled` (decision D-a), and a launch switch cannot be applied per context: a stealth context inside an engine launched at `off`/`human` still reports `true`, and says so in its `warnings`. The same switch is now used for `browser_engine action:"warm"`, so the one-time sign-in window does not announce itself as automated |
| `Runtime` domain | on | on | **never enabled**: page `console.*` is not captured (`browser_console` says so), and G9BrowserAgent's own evaluation runs in its isolated world |
| Main world | G9BrowserAgent's own helpers stay out of it at every level (the witness, recorder and text extraction live in an isolated world). The one deliberate exception is `browser_console action:"evaluate"`, which runs in the page's main world, where the page can see it. | same | same |

## The environment checklist

Before a stealth-critical suite, check each point:

1. **Engine 2, not Engine 1.** Launch with `browser_engine action:"launch" stealth:"stealth"`, or
   hand a tab over with `browser_tabs action:"handoff"`. Engine 1 cannot hide the debugger infobar
   ([below](#engine-1-the-extension-and-stealth-input-rules-only)).
2. **Edge or Chrome, not Chrome for Testing.** Detectors read CfT's brand
   ([The browser matters](#the-browser-matters)). `browser:"auto"` picks CfT once it is installed, so
   name the browser explicitly.
3. **Headed, on a dedicated desktop.** Headless is detected by its user agent at every level. Use a
   VM, Windows Sandbox, or a QA machine with autologon and no screen lock (`docs/INSTALL.md`,
   "Unattended machines"). Never minimize the window. A window that appears on a person's desk
   takes their keyboard.
4. **A warm persona profile that is not signed in to a browser account.** Keep one profile per
   persona, warmed once by a person (`browser_engine action:"warm"`) with logins to the **sites**
   only. G9BrowserAgent refuses a signed-in profile at stealth.
5. **Locale, time zone and network tell one story.** Give `locale` and `timezone` at launch, so they
   are saved with the profile. Keep the egress where such a person would be; do not use a datacenter
   proxy unless the scenario needs one. G9BrowserAgent's consistency check warns about a mismatch, but it cannot
   change the host: on this workstation, en-US with Asia/Tehran was flagged in every run, and the
   public IP was classed as "hosting".
6. **Tools that stay invisible.** Do not use `browser_console action:"evaluate"` (it runs in the
   page's main world). Do not take full-page screenshots of tall pages (refused at stealth). Do not
   use `browser_emulate` device presets (they override the user agent and leave
   `navigator.userAgentData` empty) or a `browser_emulate` locale in another language (it changes
   `Intl` only, while `navigator.languages` and Accept-Language stay the profile's) — both are
   refused at stealth; emulate width/height instead, and launch a profile with the locale you want.
   Do not pass `--extra-arg` switches (they are for experiments).
7. **Run `setup/stealthtest.mjs` with the run's profile and level first** (see
   [Running the self-test](#running-the-self-test)), and treat a detection as a failed gate.

## What a detector sees, per configuration

### The local detector page (`setup/fixtures/stealth-local.html`)

This page was written against G9BrowserAgent itself. Each check names who could fix a failure:
- **g9**: a G9BrowserAgent leak or broken promise;
- **headless**, **cdp** or **browser**: inherent to headless Chromium, to CDP input, or to the binary;
- **host** or **harness**: this machine, or how the test launched the browser.

| Configuration | Verdict on the final code | What detected it |
|---|---|---|
| `edge-headed-stealth` | **undetected** (every final pass) | nothing |
| `edge-headless-stealth` | detected | only `ua-headless` (class headless): the user agent says `HeadlessChrome/153.0.0.0`. In this guide's run: 65 checks passed, 1 failed, 0 G9BrowserAgent-class. |
| `edge-headless-stealth-de` (`de-DE`, Europe/Berlin) | detected | the headless user agent only; the locale checks pass (below) |
| `cft-headless-stealth` | detected | the headless user agent (0 G9BrowserAgent-class failures) |
| `cft-headed-stealth` | undetected in live round 3 (run B, before the Widevine and popup checks existed); not in the final passes of 2026-09-22. Final pass (2.0.1): detected | the missing Widevine only (63 checks passed, 1 failed, 0 G9BrowserAgent-class) |
| `edge-headless-human`, `cft-headless-human` (controls) | detected, **as intended** | `navigator.webdriver` true, and the Runtime console probe hit |

Every final pass had **0 G9BrowserAgent-class failures** in every stealth configuration. The controls prove the
page can see a bot: `navigator.webdriver` was true in 14/14 of them in live round 3, and the Runtime
probe hit 55–63 times per run.

The final pass of 2026-09-23 (2.0.1) agreed: `edge-headed-stealth` undetected (65 passed, 0 failed,
2 warnings); `edge-headless-stealth` and `edge-headless-stealth-de` detected by the headless user agent
only; `cft-headless-stealth` by the user agent and the missing Widevine; `cft-headed-stealth` by the
missing Widevine only; 0 G9BrowserAgent-class failures in any stealth configuration; both human controls detected.

What stealth gets right, measured in live round 3:
- **`navigator.webdriver`** is `false` in 40/40 stealth runs, from the native getter (not an own
  property), and also inside a cross-site frame.
- **The Runtime side channel** (a `console.debug` of an Error with a `name` getter) had 0 hits in
  40/40 stealth runs, in dedicated workers, and in the cross-site frame in all 54 runs.
- **Main world:** 0 G9BrowserAgent globals, 0 foreign DOM nodes, 0 main-world DOM calls, 0 listener stacks and 0
  untrusted events in every stealth run, the cross-site frame included.
- **Read tools:** the sweep of every read tool at stealth made 520 calls in 20 sweeps with 0 page-visible
  changes. This guide's run: 26 calls, 0. A main-world evaluate is the control that proves the page
  can see such changes.
- **Launch argv**, checked in 26/26 runs: `msImplicitSignin` is in `--disable-features`,
  `--disable-sync` appears once, `--disable-blink-features=AutomationControlled` appears only at
  stealth, and there is no `--enable-automation` and no remote-debugging port. Headless adds
  `--window-size=1920,1032 --screen-info={1920x1080 workAreaBottom=48}`.
- **Geometry:** the headless screen is 1920×1080 with an available area of 1920×1032, and the
  window is 1920×1032 (54/54 runs).
- **Input:** press holds of 60.1–151.1 ms across the configurations, `pointerdown` pressure 0.5 (0
  on idle moves), and the click order pointerover > enter > move > down > up > click. Key codes and
  the left/right Shift location are correct, every event is trusted, and wheel notches of 100 px come
  82–123 ms apart (median). Bringing an element into view, and a replay's scroll to a recorded
  resting place, now round to WHOLE notches — the exact pixel need used to end every reach on a
  partial notch (deltaY 47, 88) that no notched wheel produces (interaction review, 2026-09-22); an
  explicit `amount` an agent passes is still sent exactly, so a value that is not a multiple of 100
  ends on a partial notch. Numbers per browser are in `docs/HUMANIZE.md`, "Delivered timing".
- **Persona `de-DE`:** `navigator.languages` is `de-DE,de`, Accept-Language `de-DE,de;q=0.9`, and
  Intl `de-DE` with Europe/Berlin. The dedicated worker says the same, and on the final code so do
  cross-site frames and popups.
- **Nothing is left over:** exactly one tab (the agent's) at the end of 26/26 configuration runs,
  and 0 signed-in accounts in 26/26 profiles.

### Public detector pages (`setup/stealth-pages.json`)

The table is live round 3, before the final fixes. The public pages were evaluated again in the final
pass of 2026-09-23 (2.0.1), over the whole matrix, with the same picture: headless stealth was flagged
by sannysoft, creepjs (headless 67 %), browserscan, pixelscan and Fingerprint on Edge and CfT, and on
CfT by rebrowser too (its user agent); headed Edge stealth passed sannysoft, creepjs, browserscan,
Fingerprint and rebrowser, and pixelscan alone said "Automated behavior detected"; headed CfT stealth
passed all but rebrowser, which flagged its brand; both human controls were detected. The README's
public-detector table is that run.

| | sannysoft | creepjs | browserscan | pixelscan | Fingerprint | rebrowser |
|---|---|---|---|---|---|---|
| Headless stealth (Edge, CfT) | flagged: User Agent (Old), HEADCHR_UA, CHR_MEMORY | headless 67 % | "Robot" (every sub-test Normal) | "Automated behavior detected" | bot: bad (3/3 in live round 3; it passed in fix round 2's single pass) | not in the round summaries this guide was written from |
| Headed stealth, Edge (off-screen) | pass | pass (like-headless 19 %) | pass | **"Automated behavior detected"** | pass | pass (Edge does not present "Google Chrome" in userAgentData: a brand note it shows for every Edge) |
| Headed stealth, CfT (off-screen) | pass | pass | pass | pass | pass | flagged: brand (Google Chrome not presented; "Chrome for Testing") |
| Human-level controls | detected ("WebDriver (New)") | headless 67–100 % | Robot | automated | bad | `navigatorWebdriver` red |

The pixelscan verdict on headed Edge is **not traced to G9BrowserAgent**:
- through the harness it was flagged 4/4, twice with interaction and twice with `--no-interact`;
- headed Chrome passed 2/2;
- in raw probes on headed off-screen Edge with **nothing attached until 30 s after the load**, it was
  still flagged 2/2.

Host facts that show on every run and are not G9BrowserAgent's:
- the time zone (Asia/Tehran) does not match the public IP (a Netherlands hosting range), so
  pixelscan reports "Timezone spoofed" and "Proxy detected";
- `navigator.connection` varied between slow-2g and 4g.

**So headless is detected by every public detector; run stealth-critical suites headed**, on a
dedicated desktop ([the environment checklist](#the-environment-checklist)). The measured headed windows were parked off-screen at −32000, so
`screenX/Y` read −32000. That is the harness's choice, not something to copy into a real run.

### What no level removes (inherent)

- **The headless user agent.** `navigator.userAgent` and the `User-Agent` header say
  `HeadlessChrome/153.0.0.0` in headless Edge and CfT. This is the only thing that detected headless
  Edge stealth on the local page in the final passes and in this guide's run (headless CfT was also
  detected by its missing Widevine in the 2026-09-23 pass, a property of the binary). In this guide's
  run Edge's userAgentData brands were `Microsoft Edge 153, Not_A Brand 8, Chromium 153`, and that
  check passed.
- **Outer size 0×0 at the load event.** A document that `Page.navigate` loads while a CDP session is
  attached can read `outerWidth`/`outerHeight` (and `screenX/Y`) as 0 until just after `load`. The
  same document loaded with no session attached reads the real window. How often:
  - Live round 2: Edge headless stealth 8/8 runs, headed 5/8, human 3/6, `de-DE` 2/6; CfT headed
    6/8, headless 0/8.
  - Since then: 0 of 54 local runs in live round 3, none in the final passes, and none in this
    guide's run (`1920x1032` at 123 ms).
  - It was not shown to be in G9BrowserAgent's control. The launch warning still mentions it.
- **Weak CDP-input signals:**
  - `pointerrawupdate` fires exactly as often as `pointermove`, and `getCoalescedEvents()` always has
    length 1: one dispatched event per frame, never coalesced (14/14 runs in live round 3);
  - live round 2 saw mixed `screenY − clientY` offsets within one page (Edge headless 1/8, headed
    off-screen 2/8).

  No public detector was seen using either.
- **A software GL renderer** is a tell only on a machine without a GPU. This workstation reported its
  real NVIDIA renderer in headless too (30/30 headless runs in live round 2).

## What the rounds fixed

**Live round 2 → fix round 2** (fix round 2 numbers, and live round 3 where it re-measured):

| | Live round 2 | After the fixes |
|---|---|---|
| Headless screen work area | `availHeight === height` (30/30 headless runs) | 1032 on a 1080 screen, window 1920×1032 (54/54) |
| `pointerdown.pressure` | 0 (50/50) | 0.5 (every run since) |
| Press hold, CfT | 1.9–8.1 ms (20/22 runs) | 59–106 ms (fix round 2, final code); 60.5–151.1 ms (live round 3) |
| Page's mousemove cadence (median), CfT | 100.4–100.6 ms (10 Hz) | 17.0–17.3 ms (fix round 2); 16.8–17.2 ms (live round 3); 17.2–17.4 ms with the switch and 100.5 ms without it (2026-09-23 A/B) |
| Page's mousemove cadence (median), Edge | 10.9–11.8 ms | 11.2–11.8 ms (fix round 2); 11.1–12.2 ms (live round 3); 11 ms (this guide's run); 10.6–10.9 ms (2026-09-23) |
| A scroll that returns while a notch is still to land | in all 50 runs, at least one of 4 scroll calls | 0 scroll events after any return, across all 216 scroll calls (live round 3) |
| Hover or click right after a scroll, CfT | 22/22 missed, each reported "delivered" | hit, 54/54 local runs |
| Click on a page that cancels `pointerdown` | reported as not delivered (22/22) | delivered (54/54) |
| Screenshot side effects at stealth (full page, off-screen element) | resize events, a transient 1×1 viewport in 27/50 runs, a programmatic scroll | 0 in 40/40 stealth runs: a tall full page is refused, and an element is reached by the wheel |
| `locale:"de-DE"`: navigator.languages / Accept-Language | `en-US,en` / `en-US,en;q=0.9` (6/6) | `de-DE,de` / `de-DE,de;q=0.9` |
| CfT tabs at the end of a relaunched persona | up to 4, restored ones in front | only the agent's tab (26/26) |
| Edge profile signed in to the Windows account | every fresh Edge profile that ran more than about 20 s | 0 accounts (26/26) |

**Live round 3 → final:**

| | Live round 3 | Final |
|---|---|---|
| A page's `window.open()` (OAuth, payment popups) | the click never returned, the popup stayed blank and the opener froze (18/18) | the click returns and the popup loads (15/15 popup runs; this guide's run: click delivered in 1995 ms) |
| Cross-site iframe time zone and locale with a persona | the host's (7/7 `de-DE` runs) | the persona's: the frame matches the top page (every configuration, 3 passes) |
| A tab the page opens (target=_blank, `window.open`): persona and first-load network | applied after its first document ran (Engine 2 live test, 3/3) | applied before it runs (Engine 2 live test: 366/366 checks) |
| Widevine (`com.widevine.alpha`) at stealth, Edge | absent in 9/9 runs, because of `--disable-component-update` | present in every Edge stealth run (the switch is omitted at stealth only). `human` keeps the switch and has no Widevine; CfT has none (the binary) |
| Headed window against the screen's work area | 1920×1080 on a 1032-high work area (16/16) | 1920×1032, position untouched (3/3) |
| A `goto` to a server that is slow to answer | cut at 20 s as "stuck", whatever `timeoutMs` said | waits for the goto's own deadline: a 25 s time-to-first-byte with `timeoutMs:90000` returned after 26,085 ms |

How the popup and frame fixes work:
- **Held until prepared.** Every new target (popup, page-opened tab, cross-site frame, worker) is
  held by the browser until G9BrowserAgent has sent it its settings. G9BrowserAgent then resumes it with
  `Runtime.runIfWaitingForDebugger`. That is a command, not `Runtime.enable`, so the console probe
  stayed at 0 hits at stealth, in popups and frames too.
- **Cross-site popups.** A cross-site `window.open()` popup starts in its opener's renderer, where a
  second locale override is refused, so G9BrowserAgent sets its locale again when the popup's own document
  commits. Its very first script can still see the browser's default: with `--lang=de-DE` that is
  Intl `de`, which is what a German Edge reports anyway.
- **External extensions.** With component updates on (stealth), Edge records this machine's
  external extension registrations in the profile: disabled, awaiting approval, never installed. On
  the next launch it leaves permission-only stubs of them, with no files and nothing that runs in a
  page.

## The browser matters

- **Edge** is the best-measured choice. Its one caveat: rebrowser notes that Edge does not present
  "Google Chrome" in userAgentData. That is Edge telling the truth, and no switch can change it
  without creating a worse contradiction.
- **Chrome** behaved like Edge in every G9BrowserAgent measurement: mousemove cadence 13.9 ms and a humanized
  click in 1,022 ms in live round 2, and it passed pixelscan headed (2/2).
- **Chrome for Testing** is pinned and reproducible, but detectors read its brand (a red flag on
  rebrowser, headed runs included) and the Chromium build ships no Widevine key system, which they
  read too. Its renderer also ran at **10 frames per second** on this machine: `requestAnimationFrame`
  every 100.5 ms, headless and headed, against 10.5 ms for Edge and Chrome. Every mouse event
  therefore reached pages on a 100 ms beat. G9BrowserAgent passes `--disable-frame-rate-limit` to CfT only; with
  it, frames came every 17.4 ms and the page saw mousemove every 16.8–17.3 ms. The cause of the
  10 Hz renderer was not isolated, and it is not the Windows Firewall prompt that was pending when it
  was first measured: with that prompt answered, an interleaved A/B on 2026-09-23 (4 rounds of
  CfT+switch / CfT / Edge, back to back) still read CfT at 100.5 ms in every launch without the
  switch and 17.4 ms in every launch with it, against Edge's 10.5 ms. Prefer Edge or Chrome for
  stealth; `launchWarnings` says the same at launch.

## Profiles: warm, per persona, and NOT signed in to a browser account

- **Never start a stealth run on a fresh profile** (the environment checklist, point 4). Warm it once:
  `browser_engine action:"warm" profile:"<name>"` opens it headed, and a person signs in to the
  **sites** the runs need and closes the window.
- **One profile per persona.**
  - A `locale` or `timezone` given at launch is saved in the profile's metadata and applied to every
    later launch of it.
  - The locale also becomes the profile's languages (`intl.accept_languages`), so `navigator.languages`
    and Accept-Language follow. Before this fix, a `de-DE` launch changed Intl only while navigator
    stayed `en-US`: a contradiction detectors look for.
  - A **context** cannot speak another language than its profile. A per-tab override was measured to
    reach the page but not its dedicated workers. So `browser_engine action:"context"` with a locale
    in another language is refused at stealth (5/5 checks in live round 3) and warned about
    otherwise. Launch a profile with that locale instead.
- **Edge signed new profiles in to the Windows account by itself** and turned on full sync
  (passwords, history, open tabs, extensions). This was measured in live round 2 on every fresh Edge
  profile that ran for more than about 20 s. Synced extensions then injected scripts into every page
  (globals, a custom element, main-world `dispatchEvent` calls, all visible to detectors), and in one
  headed run they slowed input until it stopped arriving.
  - **What G9BrowserAgent does now:** it launches every browser with `--disable-features=msImplicitSignin` (new
    profiles stay signed out; 0 accounts in every profile checked since) and `--disable-sync`.
  - **A profile that is already signed in stays signed in.** Launching it is refused at stealth
    (7–12 ms, before any browser starts) and warned about otherwise. Sign out in it (warm it, then
    the browser's profile menu → Sign out) or make a new profile. `docs/INSTALL.md` says how to check
    a profile, and how to clean up what an account already synced.
- **Chrome for Testing reopened the previous run's tabs** on every relaunch of a reused profile.
  G9BrowserAgent now clears the saved session before each launch and closes any start-up page it did not open;
  the launch result names them.

## Engine 1 (the extension) and stealth: input rules only

The extension drives the person's own browser through `chrome.debugger`. While any debugger session
exists, the browser shows its "started debugging this browser" infobar in every window, and lays it
out again at every cross-document navigation. Measured in live round 3 on headless Edge 153, comparing
the browser with the G9BrowserAgent extension against the same browser without it:

- **The viewport is shorter:** `innerHeight` was 760–761 px with the extension and 808 px without.
- **Every cross-document load in that browser sees 2 transient `resize` events 148–301 ms in.** This
  holds for the tab G9BrowserAgent drives and for any other, whether G9BrowserAgent, the page's own script or another CDP
  client navigated it. The height moves by +1…+40 px and back, for example
  `155ms:1256x763, 165ms:1256x760`. All 15 G9BrowserAgent-driven loads showed it.

This is the browser's doing, not a G9BrowserAgent command, and G9BrowserAgent cannot remove it. A person's browser does not
run with the switch that hides the infobar (`--silent-debugger-extension-api`). A
policy-installed (`ExtensionInstallForcelist`) extension should avoid the infobar (AIGuide §2.8.2); that was **not
measured**.

So **`stealth` on Engine 1 means stealth INPUT rules and not a clean environment**:
- **What you get:** no `DOM.focus`, no programmatic scroll, no `Input.insertText`, no Runtime
  domain. With the side panel's Input at **Stealth**, every action gets stealth input whatever the
  call asks for. At Human or Direct, the panel setting is only the default level.
- **What you do not get:** a detector that watches `resize` at load, or compares the viewport with
  the screen, sees the infobar.

For detector-sensitive pages, use a launched engine (`browser_engine action:"launch"
stealth:"stealth"`), or hand the tab over (`browser_tabs action:"handoff"`; measured 1.8–3.0 s,
carrying cookies, HttpOnly included, and storage). Headed Engine 1 windows were not measured.

Two more Engine 1 facts:
- In a person's CfT, which gets no frame-rate switch, a humanized path reached the page as only 4–5
  mousemoves, against 17–23 on Edge.
- Engine 1 input to a hidden tab (a background tab or a minimized window) is refused before anything
  is sent: all 8 input kinds were refused in 0.0–0.1 s, with nothing reaching the page.

## What the tools do differently at stealth

- **`browser_console`:** no page `console.*` capture, because Runtime stays off, and the result says
  so. Browser-side entries (the Log domain) still arrive. `action:"evaluate"` runs in the page's
  main world; do not use it in a stealth run.
- **`browser_screenshot`:**
  - A viewport capture is invisible to the page.
  - An element off screen is brought into view with the **wheel** (never `scrollIntoView`), in whole
    100 px notches, and captured as far as it shows on screen. The capture is an ACTION, not a read:
    it claims the tab and is queued behind its other actions.
  - A full-page capture of a page taller than the viewport is **refused** at stealth, because
    Chromium resizes the viewport for such a capture. In live round 2 the page saw `resize` events,
    and a viewport as small as 1×1 in 27 of 50 runs.
  - At `human` the full-page capture is taken, and the result's `pageSaw` says what the page saw. At
    `off`, v1's behaviour is kept and reported the same way.
- **`browser_interact`:** every result reports `delivery`. A press that reached a different element
  than the ref is an error (`delivery:"missed"`) and is never repeated. An error message starts with
  a tag such as `[delivery: not-delivered; tab hidden]`.
- **Input to a hidden tab** is refused before anything is sent. Pointer and wheel input would not
  reach it (measured: never even answered). Key input would, but nobody could see what it does, so G9BrowserAgent
  refuses it too. The error names the remedies an agent has: `browser_tabs action:"focus"`,
  `"popout"` or `"handoff"`. A popout moves the tab into a window of another size (by default half
  the source window's width and three quarters of its height, unless `width`/`height` are given), so
  the page sees its viewport resized; no detector was measured against that. A tab that becomes
  hidden part-way through an action reports what arrived first (`delivery:"partial"`, the number of
  input events, how far the page scrolled), never "the page never received it" when part of it did.

## Running the self-test

```
node setup/stealthtest.mjs                          one run: Edge (auto), headless, stealth
node setup/stealthtest.mjs --headed                 headed, window parked off-screen
node setup/stealthtest.mjs --matrix                 Edge + CfT, headless/headed, human controls, de-DE
node setup/stealthtest.mjs --matrix --configs edge-headed-stealth,edge-headless-human
node setup/stealthtest.mjs --local-only             only the local detector page (no public pages)
node setup/stealthtest.mjs --only sannysoft,creepjs
```

**What it does:**
- It runs through the product path only: a private daemon on a random port in 18000–18999 (never
  8765), a temporary `G9_HOME`, and the real MCP shim. Every browser action is a tool call an agent
  could make.
- It warms a persona profile first, on three public pages, unless you pass `--no-warm`.
- It drives the local detector page and the public pages in `setup/stealth-pages.json`.
- It checks the launch argv, the tabs left at the end, a cross-site frame, a popup, every read tool,
  the context-locale guard and the sign-in refusal.
- It writes `results.json`, `report.html` and the screenshots to the run directory (`--out`,
  default `%TEMP%\g9-stealthtest-<stamp>`). That directory is kept. Everything else is removed, and
  a process sweep by the temporary home's path makes sure nothing is left running.

**Exit codes:**
- `0`: every stealth configuration came through undetected, **and** every control configuration
  was detected (proof that the checks can see a bot);
- `1`: anything else, which includes every headless stealth run, because of its user agent;
- `2`: the harness could not run.

A broken extractor for a public page is a warning, while a detected verdict is a failure.

**Options:**

| Option | What it does |
|---|---|
| `--browser auto\|edge\|chrome\|cft` | which browser to launch |
| `--headed` | a headed window, parked off-screen |
| `--stealth stealth\|human\|off` | anything other than `stealth` is a control that must be detected |
| `--locale de-DE --timezone Europe/Berlin` | a persona |
| `--repeat N` | the local page N times per configuration, to measure flake rates |
| `--local-only` / `--public-only` | only one kind of detector |
| `--profile NAME` / `--home DIR` | an existing profile, used as-is |
| `--extra-arg <switch>` | repeatable, for controlled experiments only |
| `--no-interact` | public pages are loaded and read only; tells a behaviour verdict from an environment one |
| `--no-sweep`, `--no-popup`, `--no-children`, `--no-product-checks` | skip those checks |
| `--allow-sync` | do not add the harness's own `--disable-sync` (G9BrowserAgent passes it anyway) |
| `--keep-home`, `--verbose` | keep the temporary home; print more |

**How long it takes:** this guide's run (one local configuration, including a 48 s warm-up) took about
2 minutes. A full matrix pass with the public pages took 25–62 minutes per browser in live round 2.

**Chrome for Testing and the firewall:** each CfT run installs CfT into a new temporary `G9_HOME`,
and Windows Firewall may ask about each new path. On this workstation it did so eight times; see
`docs/INSTALL.md`, "Windows Firewall and Chrome for Testing". Either answer leaves the test working.

Rules the harness keeps, and you should too:
- never touch the owner's browser profiles;
- never use port 8765;
- open headed windows only off-screen or on a dedicated desktop (a window that appears steals the
  keyboard from whoever is typing);
- clean up every temporary profile afterwards.
