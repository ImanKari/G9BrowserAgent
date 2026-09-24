# engine/ — Engine 2: a real browser G9 launches and drives

Engine 2 (plan D2/D3) is a **stock** Microsoft Edge, Google Chrome or Chrome for Testing process that
the daemon starts, owns and drives over a private CDP pipe. The tool modules under
`extension/tools/` run against it in the daemon process through `extension/lib/platform-cdp.js`; this
folder only knows how to find, fetch, start, talk to and stop the browser. No npm dependencies.

| File | What it does |
|---|---|
| `find.js` | Locates installed browsers and reads their versions: `findBrowsers()`, `resolveBrowser(kind)`, `exeVersion(path)`, `g9Home()`, the default-profile guard. |
| `cft.js` + `versions.json` | Chrome for Testing: the pin, `ensure()` (download → verify → extract → atomic install → log), `installed()`, `latestStable()`, `uninstall()`, `appendVersionLog()`. CLI: `node engine/cft.js status [--latest] \| ensure \| pin`. |
| `pipe-cdp.js` | `PipeCdp`, the `CdpConnection` of ARCHITECTURE_V2 §3.2: NUL-framed JSON over fd 3/4, ids, flat `sessionId` routing, per-command timeouts (clamped to setTimeout's 2³¹−1 ms limit), `event`/`close` (a throwing listener of either is contained). When the process exits, the reader drains fd 4 for up to 250 ms first: Node may report `exit` before the last reply was read, and a reply already written is not a failure. |
| `launch.js` | `launchBrowser(opts)`: the switch list, spawn, readiness, `close()` (Browser.close → wait up to `GRACEFUL_EXIT_MS`, 30 s → kill tree), leftover sweep. |
| `profile.js` | G9 profiles under `G9_HOME/profiles/`: `ensure/list/remove`, `applyPreferences`, `warm` (headed one-time login), `profileInUse`, `signInState` (is a browser account signed in? — booleans only), `clearSessionRestore` (the previous run's tabs are not reopened). |
| `stealth.js` | Levels `off`/`human`/`stealth`: CDP domain sets, launch switches (one, at stealth — see below), launch warnings, locale/timezone/Accept-Language `checkConsistency`. |
| `firewall.js` | Chrome for Testing has no Windows Firewall rule of its own, so Windows may ask about it once per executable path. The first launch from a new path adds a warning saying so, and that the answer does not matter to G9 (it drives the browser over a pipe, not a port). Paths already seen: `G9_HOME/engines/firewall-seen.json`. Edge and Chrome are not tracked (their installers register rules). |
| `manager.js` | `EngineManager`, the daemon's side of Engine 2. It launches and stops engines (one launch per profile at a time), creates browser contexts, applies each context's persona (locale, time zone, Accept-Language) and stealth level to every new tab **before its first document runs**, limits parallel mutating calls (`maxParallel`), writes the evidence runs of replays, and imports handoffs. Before every launch it checks `profile.signInState`, writes the downloads-hub preference, clears the saved session, and closes any start-up page it did not open. Details are in the entries below. |

Tests: `node setup/unit/engine.test.mjs`. On 2026-09-22 it passed 55 tests in 28.1 s, including real
headless launches of the installed Edge and of the cached Chrome for Testing; in the unit run of 2.0.2
(2026-09-24) it passed 56. `G9_UNIT_NO_BROWSER=1` skips the real launches.

---

## Launching

```js
import { launchBrowser } from './engine/launch.js';
const b = await launchBrowser({ browser: 'auto', headless: true, profileDir, stealth: 'off' });
await b.conn.send('Target.createTarget', { url: 'https://example.test/' });
await b.close();   // → { exit, killed, leftovers, profileRemoved, gracefulMs, closeMs }
```

`browser` is `'auto'` (the pinned CfT if installed, else Edge, else Chrome), `'edge'`, `'chrome'`,
`'cft'`, an executable path, or a `findBrowsers()` row. The result carries `pid`, `conn` (a
`PipeCdp`), `argv` (executable + arguments, exactly as spawned — record it in the run's
`engine.json`), `browser` (`kind, path, version, fileVersion, product, userAgent, …`), `profileDir`,
`warnings`, `exited` (a promise) and `close()`.

The first tab is `about:blank` (`startUrl`), so the browser starts with exactly one page target. Edge
also reports several `background_page` targets for its built-in component extensions (measured: 5 on
Edge 153); anything that maps targets to tabs must only count `type: 'page'`.

### The switch list (plan §P2.2, plus the Edge sign-in guards and one CfT switch) and why each switch is there

| Switch | Why |
|---|---|
| `--remote-debugging-pipe` | CDP over the child's fd 3/4. No port: no other process on the machine can find or drive this browser. |
| `--user-data-dir=<dir>` | Always a G9 profile or a temp dir, never a person's. Chrome 136+ ignores remote debugging on the default dir anyway, and App-Bound Encryption (127+) makes a person's cookies undecryptable by another process (plan §2.1). `launchBrowser` refuses every browser's default user-data dir and anything inside it. |
| `--headless=new` (omitted when headed) | The full browser with no platform window. Chromium's occlusion tracker marks minimized/covered/locked/other-desktop windows hidden, and hidden pages stop rendering and silently drop CDP input (plan §2.1). Headless has no window, so none of those states exist; the tracker is off under `--headless`. |
| `--window-size=1920,1080` (headed) / `1920,1032` (headless) | The headless default is 800×600, which is itself a signal. Headless: the window fills the screen's work area (a maximized window) — see the next row. Headed: after launch the engine manager fits a window that was given no explicit `windowSize` to its screen's work area (`Emulation.getScreenInfos`, then `Browser.setWindowBounds` with width and height only, so an off-screen window stays off-screen and nothing is activated). Measured: a 1920×1080 window on a screen with a 1920×1032 work area became 1920×1032, and the page saw outer = avail. |
| `--screen-info={1920x1080 workAreaBottom=48}` (headless only; the `windowSize` option's size) | **Decision D-a.** Headless reports an 800×600 `screen` inside whatever window it has (measured on Edge/Chrome/CfT 153): `screen.width < outerWidth`, a classic headless tell. The screen is `windowSize`, with a Windows taskbar's work area at its bottom (live round 2: without it `availHeight === height` in 30/30 headless runs — no Windows desktop reports that; the syntax was measured: availHeight 1032), and the window takes the work area. Added at every level; a `--screen-info` in `extraArgs` replaces it (Chromium keeps only the last copy), and the window is then exactly `windowSize`. Headed browsers report the real monitor. |
| `--no-first-run`, `--no-default-browser-check` | No welcome pages or prompts on a fresh profile. |
| `--disable-component-update` (off/human only) | The browser does not fetch components mid-run; the environment under test stays fixed. **Not passed at stealth "stealth", nor when a profile is warmed** (a deviation from §P2.2): Edge and Chrome get the Widevine CDM through the component updater, and with this switch no launched Edge/Chrome ever reported Widevine — not even on a warmed profile that had it on disk (stealth suite, round 3: 9/9 Edge runs; raw probe on Edge and Chrome 153: without the switch the CDM arrives within ~60 s of a profile's first launch). A browser without Widevine is an automation tell, and DRM players do not play. Chrome for Testing has no Widevine either way (the binary). Measured side effect (Edge 153): with updates on, Edge records this machine's external extension registrations in the profile, disabled "awaiting approval" (8192) and never installed; on the next launch of the profile (any level) they become permission-only stubs with no location, manifest or files — nothing that can run. |
| `--disable-background-mode` | The browser exits when its last window closes, instead of staying resident (this is what makes `warm()` finish when the person closes the window). |
| `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` | The switches Playwright and Puppeteer both pass: timers and renderers of background/occluded pages are not throttled. `--disable-backgrounding-occluded-windows` maps OCCLUDED→VISIBLE only, not minimized (plan §2.1). They do NOT keep a tab that sits behind another tab of its window at full rate (P8 matrix, round 2: ~1 frame per 1.5 s) — which is why every page G9 opens gets a window of its own (`extension/lib/platform-cdp.js` createTabIn). |
| `--disable-sync` (not in §P2.2) | **Edge sign-in guard, second barrier.** Measured on Edge 153 (live round 2): a profile that is or becomes signed in never sets sync up with it — nothing is downloaded from or uploaded to the account, and no sync-confirmation dialog or extension onboarding tab opens (without it: `edge://sync-confirmation-dialog/` and two onboarding tabs after ~75 s, +1.7 GB). Invisible to pages. |
| `--disable-features=CalculateNativeWinOcclusion,…,msImplicitSignin` | `CalculateNativeWinOcclusion` turns the Windows occlusion tracker off (covered, locked and other-desktop windows stay visible; minimized still hides) — this matters for **headed** runs. `Translate`, `MediaRouter`, `GlobalMediaControls`, `OptimizationHints`: no UI or background fetches the test did not ask for. `PaintHolding`: the first paint after a navigation is not held back, so screenshots and screencast frames show the current document (Playwright disables it too). `HttpsUpgrades`: an `http://` test URL is loaded as given, not upgraded. `AutoDeElevate`: a browser started from an elevated process would otherwise try to relaunch itself de-elevated — and a relaunched process no longer has the pipe. **`msImplicitSignin` (not in §P2.2): Edge signs the first profile of every new user-data-dir into the Windows account and turns full sync on within seconds (live round 2: 7/7 automation profiles, 13/13 test profiles); disabling the feature from a profile's first start leaves it signed out (6/6 measured). It does not sign out a profile that already is — the engine manager checks `profile.signInState` before every launch (refused at stealth, warned otherwise).** Chrome and CfT ignore the unknown name. Any `--disable-features`/`--enable-features` in `extraArgs` is **merged** into one switch, because Chrome honours only the last occurrence. |
| `--disable-frame-rate-limit` (Chrome for Testing only, `KIND_SWITCHES`) | Measured (live round 2 + probe): CfT 153.0.8010.52 ran requestAnimationFrame at 100.5 ms — 10 frames per second, headless and headed — where Chrome 153 and Edge 153 ran at 10.5 ms; input is frame-aligned, so mouse events reached pages on a 100 ms beat and each dispatch took 85 ms. `--disable-gpu-vsync` and turning off SkiaGraphite/TreesInViz did not change it; this switch did (17.4 ms, p10–p90 17–18 ms, 7.7 ms per dispatch). Not passed to Edge/Chrome: it would slow them from 10.5 to 17.4 ms. **Re-checked 2026-09-23** with the machine's pending firewall prompt for `chrome.exe` now answered — an interleaved A/B, 4 rounds of CfT+switch / CfT / Edge back to back on fresh profiles: CfT **100.5 ms in 8/8 launches without the switch** (press hold 1.4–3.1 ms) and **17.4 ms in 12/12 with it**, Edge 10.5 ms. Two earlier sequential runs that night read CfT at 10.1 ms without the switch and could not be reproduced; the switch stays. |
| `--lang=<locale>` (when given) | UI language and default `Accept-Language`. |
| `--proxy-server`, `--proxy-bypass-list` (when given) | A browser-wide proxy. A per-context proxy (`Target.createBrowserContext`) is preferred; that is the engine manager's job. |

Then `stealth.launchArgsFor(level)` — nothing at `off`/`human`; at `stealth` exactly
`--disable-blink-features=AutomationControlled` (decision D-a, below) — and `extraArgs`. Every
`--disable-features`, `--enable-features` and `--disable-blink-features` is merged into one switch.

**Never passed, and refused in `extraArgs`:** `--enable-automation` (at every level), `--remote-debugging-port`,
`--remote-debugging-address`, `--remote-debugging-io-pipes` (it would move CDP off fd 3/4),
`--disable-blink-features=…AutomationControlled…` at `off`/`human` (at `stealth` the level passes it
itself, and a caller's copy is merged — decision D-a), and the switches owned by an option
(`--user-data-dir`, `--headless`, `--window-size`, `--lang`, `--proxy-*`, `--remote-debugging-pipe`) so
that the recorded argv has one source for each.

- **Case does not help.** On Windows Chromium lowercases switch names when it parses its command line
  (`base/command_line.cc`), so `--ENABLE-AUTOMATION` is `--enable-automation`. Refusals and the
  `--disable-features`/`--enable-features` merge are case-insensitive for that reason; an unmerged
  `--Disable-Features=X` would otherwise be the last copy and silently drop the whole list above.
- A bare `--` is refused: it ends Chromium's switch parsing, turning every later switch into a URL.
- `startUrl` must be an absolute URL with a scheme (`about:blank`, `https://…`, `data:…`, `file:…`).
  Anything starting with `-` (or `/` on Windows) is parsed by Chromium as a switch.
- Options that arrive as JSON `null` mean the default. A `null` `headless` is headless, never a
  headed window on someone's desktop.

### Measured facts (Edge 153.0.4234.32, Chrome 153.0.8010.50 and .53, CfT 153.0.8010.52, Windows 11, 2026-09-21/22)

| Fact | Consequence |
|---|---|
| **`navigator.webdriver` is `true` on every page of a browser started with `--remote-debugging-pipe`**, headless or headed, with no `--enable-automation`. Headless *without* the pipe: `false`. Pipe + `--disable-blink-features=AutomationControlled`: `false`. `Emulation.setAutomationOverride({enabled:false})` does **not** clear it. Measured on Edge 153, Chrome 153 and CfT 153. | The pipe itself enables Blink's AutomationControlled feature. **Owner decision D-a (2026-09-22):** stealth runs must be undetectable, so `launchArgsFor('stealth')` = `['--disable-blink-features=AutomationControlled']` (the one switch any level adds); `off`/`human` tell the truth (webdriver `true`) and `launchWarnings()` says so on every such launch; `launchBrowser` refuses the switch in `extraArgs` there. `setup/unit/engine.test.mjs` measures it live: `false` only at stealth, on Edge, Chrome and the cached CfT. |
| The page user agent says `HeadlessChrome/153.0.0.0` in headless Edge and CfT; headed Edge says `Chrome/153.0.0.0 … Edg/153.0.0.0`. `Browser.getVersion().product` is `Edg/153.0.4234.32` (Edge) and `Chrome/153.0.8010.52` (CfT, even headless). | Stealth-critical suites run headed (plan §6.4). `launchBrowser` takes the version from `product`. |
| Headless reports `screen` 800×600 inside a 1920×1080 window unless `--screen-info={1920x1080}` is also passed (then 1920×1080). With `{1920x1080 workAreaBottom=48}`, `availHeight` is 1032 (live round 2). | Decision D-a: every headless launch passes `--screen-info` with the `windowSize` and a 48 px taskbar work area, and a window the size of the work area (measured live in engine.test.mjs: `screen` = `windowSize`, `availHeight` = height − 48, `outerHeight` ≤ `availHeight`, at off, human and stealth). |
| Ready (Browser.getVersion answered) ≈0.7 s after spawn (Engine 2 live test: headless Edge launched in 737–1046 ms); `Browser.close` → process exit ≈0.4 s; closing the last tab of a **headed** browser → exit in 0.5–3.7 s **with exit code 0**. Closing the last tab of a **headless** browser does **not** end it (still running after 10 s). | 30 s ready timeout; `close()` waits 30 s (`GRACEFUL_EXIT_MS`) before killing: exit took 0.4-0.5 s idle but up to 17.9 s under heavy CPU load (2026-09-24), and the old 10 s budget killed one loaded browser mid-shutdown. `warm()` counts only exit code 0 as a person closing the window. |
| **Closing the pipe makes the browser exit by itself** (0.4–8 s measured). | A daemon that dies cannot leave an orphaned engine behind holding its profile. `launch.js` also kills live browsers on Node's `exit`. |
| Headless Edge: `document.visibilityState` `visible`, `document.hasFocus()` `true`, `navigator.languages` from `--lang`/the OS. | |
| While a browser runs, `<profile>\lockfile` is held with `FILE_SHARE_READ` + delete-on-close: a **read** open succeeds, a **write** open fails `EBUSY`; after a clean exit the file is gone. | `profileInUse()` opens it for writing (never writes). A read-only probe wrongly called a running profile free. |
| **A fresh Edge profile signs itself in to the Windows (Microsoft) account and turns sync on**, within ~6 s of its first start, for any launch longer than ~20 s (Local State `info_cache.*.user_name`/`gaia_id`/`edge_account_cid` set, Preferences `account_info` 1 entry, `sync.has_setup_completed` true; synced passwords, history, tabs and extensions). Measured on the owner's machine in live round 2 (7/7 automation profiles, 13/13 test profiles; Chrome 0/8). `signin.allowed=false` seeded into Preferences was rewritten to `true` by Edge. The earlier entry here ("did not sign in … checked once") was wrong: that check ran for less time than the sign-in takes. | `--disable-features=msImplicitSignin` from a profile's first start prevents it (0 accounts, 6/6); `--disable-sync` keeps sync off even if an account is present. A profile signed in before this fix (v2.0 before live round 2) **stays** signed in: sign out in it (warm, then the profile menu) or use a new profile — `browser_engine launch` refuses it at stealth and warns otherwise. Test browsing done before the fix may appear in that account's synced history. |
| Chrome for Testing reopens the previous session's tabs on every relaunch of a reused profile (exit_type Normal, no session prefs); a restored tab ended up in front of the agent's in 4/5 runs. Edge did not. | The manager deletes `<profile>/Default/Sessions` before each launch (`profile.clearSessionRestore`; the startup pref itself is MAC-protected and would be reverted) and closes any start-up page other than its own `about:blank`, naming it in the launch result (`closedAtLaunch`). Stealth suite, live round 3: exactly one tab (the agent's) at the end of 26/26 configuration runs, CfT included. |
| Headless Edge opens its own `edge://downloads-hub/` tab after a download (Chrome does not). The `browser.show_hub_popup_on_download_start: false` preference, written before launch, suppresses it. Measured over 8 raw launches each: without the preference, 1 hub tab every time; with it, 0; with only the "completed" preference, still 1 (Engine 2 live test). | The manager writes that preference before every launch; a browser-internal tab that appears anyway is listed `attachable:false` and is never an agent's default tab. |
| A tab that sits behind another tab of its window is rendered ~1 frame per 1.5 s and each input event on it takes ~1 s, headless too, while `visibilityState` still says "visible" (P8 matrix, round 2); a minimized headed window behaves the same. | Every page G9 opens gets a real window of its own, with an existing window's bounds and without taking OS focus (`platform-cdp.js createTabIn`). A tab the PAGE opens (target=_blank, `window.open`) joins its opener's window in front of it. On a headless engine, `tabs.ensureFront` brings the agent's tab to the front before input and screenshots; a headed engine only reports it, so the person's focus is never taken. `browser_status` warns "BEHIND another tab" and names a minimized window. P8 matrix after the fix: a click on the tab behind a page-opened tab took 4.9 s (was 20.9 s) and a type 5.1 s (was 22.6–23.6 s). A minimized headed window is still rendered at about 1 frame per 1.5 s (a click took 28 s, correctly reported delivered); the only fix is not to minimize, or to run headless. |
| A page's `window.open()` froze the opener and never loaded while the browser auto-attached with `waitForDebuggerOnStart:false` (Edge 153 and Chrome 153, raw CDP too: the click did not return in 15 s). With `waitForDebuggerOnStart:true` plus `Runtime.runIfWaitingForDebugger` on attach, it returned in 46 ms. An out-of-process iframe kept the HOST's time zone and locale when the overrides went to the page session only. | `platform-cdp.js` auto-attaches with `waitForDebuggerOnStart:true`: every new target (tab, popup, cross-site frame, worker) is held, prepared by the manager (persona, domains), then resumed. Non-page targets are resumed at once, and nothing is left paused beyond `PREPARE_BUDGET_MS` (3 s). A held tab answers nothing, but commands sent before the resume apply before its first document runs. Stealth suite, final passes: popups load, and cross-site frames report the persona in every configuration. |

### Stopping

`close()`: `SystemInfo.getProcessInfo` (remember the child pids) → `Browser.close` (a clean shutdown
flushes cookies and prefs — a killed browser can lose a warmed login) → wait up to 30 s → `taskkill
/PID <pid> /T /F` as the last resort (POSIX: SIGKILL to the process group) → if any remembered child
pid is still alive after 2 s, list processes whose `--user-data-dir` is **exactly** this profile dir
(`findProfileProcesses`, via CIM) and kill exactly those — every Chromium child carries the
browser's `--user-data-dir`, so a unique profile dir identifies one launch and never anyone else's
browser → release the pipe's stream handles (also when the browser had already exited on its own) →
delete a temporary profile (with retries; Windows holds file locks briefly after exit).
Idempotent: a second call returns the same result.

The 30 s is `GRACEFUL_EXIT_MS` (exported); a caller that needs a faster shutdown passes
`close({ timeoutMs })`. It was 10 s until 2.0.2. Measured on 2026-09-24 (headless Edge 153, i9-10900X):
a close took 0.4–0.5 s idle but up to 17.9 s with 24 CPU-bound processes running, and one of four
loaded closes was killed at the 10 s mark and exited with code 1; with 30 s, 0 of 12 loaded and idle
closes needed a kill. The result says what happened: `killed` (the tree had to be killed),
`gracefulMs` (how long the clean exit took, or the whole budget), `closeMs` (the whole close),
`leftovers`, `profileRemoved`, and `exit` = `{ code, signal }` — or `{ code: null, signal: null,
gone: true }` when the process is gone but its exit event has not arrived yet, so `exit` is never null
once the browser is gone.

"Exactly" matters: G9 profiles are siblings, so `profiles\qa` is a prefix of `profiles\qa-2`, and a
substring match would kill another running engine. `commandLineUsesProfile()` requires the dir to be
the switch's whole value, whether Node quoted the whole argument (`"--user-data-dir=C:\a b"`),
Chromium quoted the value (`--user-data-dir="C:\a b"`) or nothing is quoted. The command lines cross
from PowerShell as base64 UTF-8, so a non-ASCII profile path survives the console code page.

A failed start (no `Browser.getVersion` answer in 30 s, the process exited, or it is not a browser)
throws with the exit code and the last lines the browser printed, then cleans up.

---

## Versions: read from the executable

`exeVersion()` reads the **PE version resource** of the exe (anchored on the `VS_VERSION_INFO` key,
not on the bare `0xFEEF04BD` signature, which also occurs in code sections). On Windows the obvious
shortcuts lie while an update is staged: measured on this machine, Edge's Application folder held
`153.0.4234.32` and `153.0.4234.48`, `new_msedge.exe` was waiting, and
`msedge.VisualElementsManifest.xml` already said `.48` — but `msedge.exe`, the binary that starts, is
`.32` (and `Browser.getVersion` confirmed `.32`). Fallbacks: the single version-named directory next
to the exe; the single `<version>.manifest` next to it (the CfT zip has no version directory: a flat
`chrome-win64/` with `153.0.8010.52.manifest`); `--version` last, only for CfT on Windows (and every
browser elsewhere). On Windows chrome.exe has no `--version` handler (it is POSIX-only): the switch is
ignored and the browser starts on its default profile. The Windows probe therefore carries a
throwaway `--user-data-dir` and `--headless=new`, and is killed as a tree when it ends.

The default-profile guard compares both the path as written and its real path (junctions, symlinks,
8.3 short names such as `MICROS~1` resolved through the deepest existing ancestor), so none of those
can walk around it.

Windows system tools are called by full path (`%SystemRoot%\System32\…`): under Git Bash, `PATH`
puts GNU `tar` first, which cannot read a zip.

## Chrome for Testing: pinned, verified, installed once

- **Pin:** `versions.json` → `chrome-for-testing.version` (153.0.8010.52, Stable on 2026-09-21) and
  `downloads.win64 { url, size: 205149043, sha256: df4854428c50…94fbe1, serverMd5 }`.
- **Trust on first use.** Google publishes no sha256 for CfT. The pinned hash was computed by
  `node engine/cft.js pin` from the first download; that transfer was checked against the MD5 Google
  storage declares in `x-goog-hash` (the same `zpBayjQjVXGHNOpRyiRcpw==` a separate `HEAD` returned),
  and independently with `certutil -hashfile … SHA256`. Every later install must match the pin byte
  for byte, or nothing is installed. Re-pin deliberately: `node engine/cft.js pin [--channel Stable]
  [--version V] [--cache DIR]`, review the diff, commit. A version that is not pinned installs
  trust-on-first-use and its hash is written to the log.
- **`ensure({ version, onProgress, cacheDir, trigger })`**, idempotent (a verified install returns
  `source: 'installed'` without touching the network):
  1. zip: `cacheDir/chrome-win64-<version>.zip` if present and it verifies (a cached zip that does not
     verify is renamed `.bad-<time>`, not trusted, not silently deleted); else download.
  2. download: `node:https`, redirects, `HTTPS_PROXY` (CONNECT tunnel) / `NO_PROXY`, an idle timeout,
     **resume** with `Range` + `If-Range` after a dropped connection (up to 8 retries with backoff —
     the first pin attempt died at 95% after six minutes; a resume whose `Content-Range` names another
     start or another total restarts from zero instead of splicing), `Content-Length` and `x-goog-hash` MD5
     checks, sha256 and size computed from the finished file. **If the request is refused over one
     address family it is retried over the other:** on this network `storage.googleapis.com`
     answers `403 "this service is not available in your location"` over IPv4 and 200 over IPv6.
  3. extract into `engines/.cft-<v>.tmp-…` with `%SystemRoot%\System32\tar.exe -xf` (bsdtar reads
     zip); if tar fails or does not produce `chrome-win64/chrome.exe`, the pure-JS reader takes over
     (stored + deflate via `zlib.createInflateRaw`, streamed, CRC-32 and size checked per entry — with a
     pure-JS CRC-32 where `zlib.crc32` is missing, before Node 22.2 — zip64, zip-slip refused, and on
     Windows any `:` in a name refused: an NTFS alternate data stream or a drive-relative path). On
     the real 205 MB zip the whole `ensure()` from the cache (sha256 + bsdtar +
     install) took 2.4 s; the JS reader alone 3.8 s for 308 entries / 453 MB, byte-identical to tar's output.
  4. the extracted `chrome.exe` must report that version (PE resource).
  5. write `.g9-install.json`, then **rename** into `engines/cft-<version>/` (atomic on one volume).
     A cross-process lock (`engines/.cft-<v>.lock`) keeps the desktop wizard and the daemon from
     installing the same build twice; in-process callers share one promise. The holder touches the
     lock's mtime every 30 s, so a slow download is never taken for a dead holder, and a lock is
     only taken over when its pid is gone or its heartbeat stopped 3 min ago. An empty lock (another
     process between `open('wx')` and writing its pid) is left alone for 10 s rather than stolen.
     Right before the rename the installer looks again: if someone else finished the same build
     meanwhile, theirs is kept. A directory without a marker (a broken earlier attempt) is moved
     aside and deleted; if it cannot be moved, a browser runs from it and the install fails saying so.
  6. append to `G9_HOME/engine-versions.log`, tab-separated:
     `2026-09-21T18:14:36.132Z  install  cft 153.0.8010.52  sha256=…  trigger=cli  platform=win64  size=…  source=cache  extractor=tar  pinned=yes`.
     `appendVersionLog()` is exported for the engine manager's launch lines.
- **Local cache for tests:** `%TEMP%\g9-cft-cache\` holds `chrome-win64-153.0.8010.52.zip` and an
  installed copy (`engines\cft-153.0.8010.52\chrome-win64\chrome.exe`; the folder doubles as a
  `G9_HOME`). Live tests reuse it with `ensure({ cacheDir })` or `G9_CFT_CACHE`; recreate it with
  `node engine/cft.js ensure --cache "%TEMP%\g9-cft-cache" --home "%TEMP%\g9-cft-cache"`.
- **Windows Firewall.** An installed CfT is a new program to Windows, so the firewall may ask once
  per path. `firewall.js` warns on the first launch from each path. On the owner's machine, eight CfT
  copies in the stealth self-test's temporary homes each left a pair of inbound rules (6 Allow,
  2 Block), while the cached copy the unit and Engine 1 suites use has none (read-only query,
  2026-09-22). The answer does not matter to G9. `docs/INSTALL.md` has the details.
- **Versions log:** every install, uninstall and engine launch appends one line to
  `G9_HOME/engine-versions.log`, in one format written by `cft.appendVersionLog`:
  `ISO<TAB>event<TAB>kind version<TAB>key=value…`. The manager's launch lines carry `engineId=`,
  `path=`, `daemon=`, `headless=` and `stealth=`.

## Profiles

```
G9_HOME/profiles/<name>/        the user-data-dir (Default/Preferences, Cookies, lockfile while running, …)
G9_HOME/profiles/<name>.json    { name, createdAt, warmedAt, locale, timezone, notes, acceptLanguage?, warmedWith?, warmedUrl? }
```

- Names: 1–64 of `A–Z a–z 0–9 . _ -`, not a Windows device name. Default profile: `automation`.
- `applyPreferences(name, prefs)` deep-merges into `Default/Preferences` (dotted keys such as
  `'intl.accept_languages'` are expanded) **only while no browser uses the profile** — a running
  browser rewrites the file on exit. Useful: `intl.accept_languages`, `download.default_directory`,
  `download.prompt_for_download`, `spellcheck.dictionaries`,
  `profile.default_content_setting_values.notifications`, `credentials_enable_service`,
  `translate.enabled`. Prefs Chrome protects with a MAC in *Secure Preferences* (homepage, startup
  URLs, search engine, extensions) are reset by the browser if edited here. When the merged
  Preferences hold `intl.accept_languages`, it is copied into the metadata as `acceptLanguage`:
  the engine manager's locale/timezone/Accept-Language check reads the metadata, because it cannot
  read Preferences while a browser runs.
- `warm(name, url)` opens the profile **headed** at `url` with the same switches the runs use, so a
  person can sign in once; it resolves when they close the window and stamps `warmedAt`. A window G9
  closed (abort signal, timeout) is not a login and stamps nothing. Neither is a browser that ended
  with anything but exit code 0 (a crash code or a kill may have lost the sign-in before it reached
  the disk): the result says `warmed: false` with the reason. G9 sends nothing to the page.
- Profiles are per machine: App-Bound Encryption means a copied profile loses its cookies.
- `remove(name)` refuses while the profile is in use. `list()` never reports what a crashed
  `remove()` or an atomic write leaves behind (`<name>.removing-…`, `….tmp-…`) as a profile.

## Stealth levels (plan D10, §6)

| Level | Auto-enabled CDP domains | Launch switches | Notes |
|---|---|---|---|
| `off` | Page, Runtime, Log, Network, DOM, CSS | none | v1 direct input; `navigator.webdriver` true (the truth) |
| `human` | Page, Runtime, Log, Network, DOM, CSS | none | humanized input only; `navigator.webdriver` true |
| `stealth` | Page, Log, Network, DOM, CSS — **never Runtime** | `--disable-blink-features=AutomationControlled` | no page console capture; isolated worlds via `Page.createIsolatedWorld`; `navigator.webdriver` false (D-a) |

The level is also the FLOOR of the input level (decision D-b, `extension/lib/humanize.js levelFor`): a
tab in a stealth context always gets stealth input rules, whatever `humanize` a call asks for.

Why no other switches: a stock binary telling the truth has no contradictions to find; every UA / Client
Hints / WebGL / language switch creates one. `--disable-features=AutomationControlled` is folklore
(AutomationControlled is a Blink *runtime* feature, not a `base::Feature`). The one stealth switch undoes
what the pipe itself turned on (the measured `navigator.webdriver` fact above) and changes nothing else.

`checkConsistency({ locale, timezone, acceptLanguage })` returns human-readable problems: an invalid
tag or zone, an `Accept-Language` whose first language is not the locale's, increasing q-values, and
a locale region whose time zones do not include the effective zone. The effective zone is the host's
when none is set: `de-DE` on a machine in `Asia/Tehran` is reported. Zone aliases compare equal
(`Asia/Kolkata` = `Asia/Calcutta`).
