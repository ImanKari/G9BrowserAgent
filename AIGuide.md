# AIGuide — G9 Browser Agent

**Purpose of this file.** This is the durable record of what exists in this codebase, why it was built this way, and what is deliberately absent. Read it before changing anything. Update it after changing anything — see [Rules for changing this codebase](#rules-for-changing-this-codebase) at the end.

**Status:** v3.0.2, 2026-09-26. Two engines (the extension in the person's own browser, and real
Edge/Chrome/Chrome for Testing that the daemon launches), one local daemon `g9d`, one MCP shim per
agent, fifteen tools, a pure human-input library, three stealth levels, an Electron desktop shell and a
per-user installer that is **not code-signed**. 3.0.0 is the side-panel redesign (decisions U1–U10,
§6.10; §9): agents per project, project-scoped auto-attach, a
blocked-agent alert, Automation and Issues grouped by site, one visual system. 3.0.1 adds the owner's
icon and `setup/check.mjs`, which runs only the checks a change needs, several at a time (§7). 3.0.2
prepares the repository for publication: the planning documents are gone and what they held that still
matters is in this file (§2, §6.10, §8.5, §8.6) and the guides (§9, the 3.0.2 entry). On
2026-09-25, on 3.0.1: every offline check through `check.mjs --all` (unit 651 in 12 suites, self-test,
extension suite, panel render, links) in 142 s. On 3.0.0: unit 638/638 in 11 suites, self-test 136/136, extension suite 82/82, desktop 14/14 files, the
packaged build 7/7 (`G9-Setup-3.0.0.exe`), Engine 2 live test 366/0, the isolated Engine 1 live test
198/0 on Edge with the real popout, and the panel render check clean. On 2026-09-24, on 2.0.2, the
unit suite passed three times in a row.
On 2026-09-23, on 2.0.1 (the final pass): daemon contract 15/15, render check 4/4 scenarios, the
isolated Engine 1 live test 196/0 on Chrome, the background-state matrix exit 0, bench 0 failures at
1/4/8/16 contexts, 10-minute endurance 93 iterations 0 failures, and the stealth matrix over 7
configurations with the public detector pages. The measured numbers are in §7 and in the §9 entries
for 2.0.1 and 2.0.2. What is still open is in §8; nothing there is fixed by being listed.
**Created:** 2026-08-31

**Reading order:** §§1–8c describe v3.0.0 as built (v2.0.0, plus the review fixes and final pass of 2.0.1, the three
flaky-test defects and the browser close budget of 2.0.2, the popout fix of 2.0.3, and the side panel of 3.0.0). §9 is history: entries dated before 2026-09-21
describe v1 (a bridge, four control modes, a workspace allowlist) and are superseded wherever §§1–8
say otherwise. The binding module contracts are [docs/ARCHITECTURE_V2.md](docs/ARCHITECTURE_V2.md)
(signatures, message shapes, file locations) and [docs/DAEMON_PROTOCOL.md](docs/DAEMON_PROTOCOL.md)
(the wire); the design and its reasons are §2 here: the twelve decisions D1–D12 (§2.0), the
verified Chromium facts and their sources (§2.8) and the standing rules R1–R9 (§2.9). The v3 side-panel
decisions U1–U10 are in §6.10, the v1 backlog items EXT-01 … EXT-17 in §8.5.
Where this file and ARCHITECTURE_V2 disagree about a signature, ARCHITECTURE_V2 wins and this file is
wrong — fix it. Owner-facing guides: [docs/STEALTH.md](docs/STEALTH.md), [docs/HUMANIZE.md](docs/HUMANIZE.md),
[docs/INSTALL.md](docs/INSTALL.md), [engine/README.md](engine/README.md) (every launch switch and why),
[desktop/README.md](desktop/README.md), [runner/README.md](runner/README.md).

---

## 1. What this is

G9 lets any number of AI agents drive real Chromium browsers at DevTools depth through MCP, with
human-like input and evidence a person can review afterwards. v2 has two engines behind one tool layer:

- **Engine 1 — the extension.** An MV3 extension in the QA person's own Edge or Chrome: their profile,
  cookies and logins. For authoring (recording), exploring and attended runs.
- **Engine 2 — a launched browser.** A stock Edge, Chrome or Chrome for Testing (CfT) that the daemon
  starts on a G9-owned profile and drives over `--remote-debugging-pipe`, headless by default. For
  unattended runs, parallel agents and long flows. Headless, it has no window on the person's desktop,
  so the states that stop a window rendering (minimized, covered, locked, another virtual desktop) do
  not exist for it — a fact from Chromium's source (§2.8.1); a locked session was not measured (§8.2).

```
AI agent ──stdio MCP──▶ mcp/shim.mjs ──WS /g9──▶ daemon/g9d.mjs ──(in-process)──▶ Engine 2 runtime
AI agent ──stdio MCP──▶ mcp/shim.mjs ──WS /g9──┘      │   ▲                          engine/manager.js
runner/g9.mjs ────────▶ mcp/shim.mjs ──WS /g9──┘      │   │                          extension/tools/index.js (platform-cdp)
desktop (Electron) ───────────────────WS /g9──────────┘   │                          ──pipe CDP──▶ Edge/Chrome/CfT
                                                          │
extension/sw.js (Engine 1) ───────────WS /g9──────────────┘   tools run INSIDE the extension (platform-extension)
```

- **One daemon per machine**, `g9d`, on `127.0.0.1:${G9_PORT:-8765}`. It owns engines, browser
  contexts, tab handles, tab ownership, halts, evidence runs and the scheduler. Nobody has to start it:
  the first MCP shim that finds no daemon spawns it (detached, hidden), and it exits after
  `settings.idleExitMinutes` (default 60) with no client, no launched browser and no schedule.
- **One shim per agent.** Every AI client launches `mcp/shim.mjs` (stdio MCP). The shim serves the
  schemas and instructions and forwards calls verbatim, adding only `caller.name`.
- **The same tool code in both engines.** `extension/tools/*.js` run inside the extension's service
  worker over `chrome.debugger` (Engine 1) and inside the daemon over a CDP pipe (Engine 2). The
  difference is one seam, `extension/lib/platform.js` (§4.6).
- **The runner is an agent.** `runner/g9.mjs` speaks MCP through the same shim; ownership, Stop and
  every refusal apply to it. The scheduler starts it as a child process.
- **The desktop app is a client and an installer**, never an engine (§2.5).

**Browser operations are independent of the site's framework.** Product knowledge lives as data in
the project under test (`g9.project.json`, the FlowSpec library under its `flowsDir`); the runner has a
separate AgriPad device adapter (`runner/drivers/agripad.mjs`, adb). None of that puts
framework-specific behaviour into the browser tools. Keep this repo separate from projects under test.

---

## 2. Why this architecture (the decisions that shape everything)

v2 was designed around twelve decisions (D1–D12, §2.0), taken with the owner on 2026-09-21 before any
v2 code was written. ARCHITECTURE_V2 §0 records where the build deviated and three decisions taken
during the build (D-a, D-b, D-c, see §4.8 and §4.10). The reasoning below is the part that constrains
later choices.

### 2.0 The twelve decisions (D1–D12)

These are settled. Do not reopen one silently: if one turns out to be impossible, stop and say so
rather than choosing another path.

| # | Decision | Why (short) |
|---|---|---|
| D1 | **No Chromium fork.** The execution engine is stock Chrome, Edge or Chrome for Testing, launched and driven by G9 over CDP. | Everything needed is reachable through launch switches, profile preferences, policies and full CDP. A fork costs a permanent build/rebase/sign/distribute cycle (Chrome ships a major every two weeks since 153) and its results are not results on the customer's browser. A two-week fork spike (§8.4) would measure that cost; it was not run. |
| D2 | **Two engines, one tool layer.** Engine 1 = the extension in the QA's own browser (authoring, exploration, attended runs). Engine 2 = a browser process the daemon launches (unattended runs, parallel agents, long flows). Both run the same tool modules and the same FlowSpec. | The tool modules were already pure CDP (`interact`, `snapshot`, `record`, `replay`, `capture`, `navigate`, `qa`, `issues` contained no `chrome.*` call). Only the transport and a few platform calls differ (§4.6). |
| D3 | **Engine 2 is unaffected by the desktop.** Default: `--headless=new`, no platform window at all. Optional: headed on a dedicated VM or session for stealth-critical scenarios. | Chromium stops rendering and silently drops CDP input for hidden, minimized, occluded, locked-screen or other-virtual-desktop windows (§2.8.1). Headless has no window, so none of those states exist. |
| D4 | **Electron is the shell, never the engine.** The desktop app (UI, daemon, installer, updater) is Electron. Pages under test never load inside Electron's Chromium. | Third-party components fingerprint the browser identity; Electron is not Chrome. The shell only launches and watches real browsers (§2.5). |
| D5 | **One daemon, many agents.** A local daemon (`g9d`) owns every engine, context and tab. Each AI agent connects through a thin MCP stdio shim. Any number of agents; each tab has exactly one owner at a time. | v1's one-bridge limit and the runner's "port rule" go away. CDP is multi-client since Chrome 63. |
| D6 | **Extension: no modes, attach = full access.** Workspace / Pinned / Follow / Multi and the workspace allowlist are removed. Attach (manual or automatic) gives every tab, every title/URL, every cookie. | Owner decision. The deployment is local and trusted; the modes were a product safety boundary, not a technical one. |
| D7 | **Local trust model, fully.** No token, no origin games beyond binding to 127.0.0.1, no cookie scoping, no title withholding. The Stop button and the activity log stay as operational features. | Owner decision. Binding to loopback costs nothing and prevents an accidental LAN exposure (§5 records the one addition: web origins are refused). |
| D8 | **Human input engine, shared.** Every pointer, wheel and keyboard action in both engines goes through `extension/humanize/`, which plans human-like paths and timings and dispatches trusted CDP input. A seeded PRNG makes each run reproducible. | The owner requires human-indistinguishable behaviour, including for third-party components that detect bots. The model and its defaults are [docs/HUMANIZE.md](docs/HUMANIZE.md). |
| D9 | **The cursor is rendered in the evidence, never in the DOM.** The pointer position is a timestamped track stored beside screencast frames; the watch window and the exporter draw it. | A DOM overlay is visible to the page and to MutationObservers. A track is invisible to the page and shows a moving cursor in every video and screenshot. |
| D10 | **Stealth is a per-profile level, not a global mode.** `off` / `human` / `stealth`. `stealth` changes which CDP domains may be enabled and where scripts may live (§4.8). | Console capture and some conveniences are incompatible with undetectability; the trade-off must be explicit per run ([docs/STEALTH.md](docs/STEALTH.md)). |
| D11 | **Zero dependencies stay in the core.** `extension/`, `engine/`, `daemon/`, `mcp/`, `runner/` have no npm dependencies. Only `desktop/` (Electron, electron-builder, electron-updater) has them. | The core is what has the browser access; the shell is replaceable. |
| D12 | **Every change bumps the version and lands in this file's change log.** One version string for the whole product (extension, daemon, desktop, shim). | Version skew has already bitten this project (v1.7.13). The rule as practised is in [Rules for changing this codebase](#rules-for-changing-this-codebase). |

### 2.1 What v1 was, and what it could not do

v1 was an MV3 extension with the `debugger` permission plus a zero-dependency Node bridge: one
bridge, one extension, one agent. The extension was chosen over WebDriver/Playwright/Puppeteer
because `chrome.debugger` reaches the person's **default** profile with no remote-debugging switch —
Chrome 136+ ignores `--remote-debugging-port/-pipe` on the default user-data-dir, and a throwaway
`--user-data-dir` has none of the person's logins. That reason still holds and is why Engine 1 exists.

What v1 could not do, and no extension can (§2.8.1, §2.8.2; Chromium sources in §2.8.6):

- **Input to a page that is not visible.** A background tab is always hidden; a minimized window is
  hidden; a covered window, a locked session or another virtual desktop is "occluded". Hidden or
  occluded pages stop rendering and pointer input does not reach them. `--disable-backgrounding-occluded-windows`
  and `--disable-features=CalculateNativeWinOcclusion` (policy `WindowOcclusionEnabled=0`) fix
  occluded, never minimized — and an extension cannot set switches at all.
- **The Browser domain, launch switches, relaunching, or avoiding the debugger infobar** (only a
  policy install or `--silent-debugger-extension-api` removes it).
- **More than one client.** One bridge per extension meant a second agent, a second editor window or
  the runner fought over one port and one browser (v1's "port rule").

### 2.2 Two engines, one tool layer (D2, D3)

Engine 2 is a real browser process the daemon launches, headless (`--headless=new`: the full browser,
no platform window, so none of the hidden states exist). Engine 1 stays for authoring. The tool
modules were already pure CDP, so the only thing that differs between engines is the platform seam
(§4.6), not the tools. A tab moves from Engine 1 to Engine 2 with `browser_tabs action:"handoff"`
(cookies and storage travel, the page reloads; §6 daemon/handoff.js).

### 2.3 Why no Chromium fork (D1)

Everything v2 needs is reachable through launch switches, profile preferences, policies and full CDP
over the pipe. A fork is a permanent build/rebase/sign/distribute cycle — Chrome ships a major every
two weeks since 153 — and a result on a fork is not a result on the customer's browser. The one thing
the original design forbade that stealth turned out to need (the `AutomationControlled` switch) was solved by a
decision taken during the build (D-a, §4.8, because the owner requires stealth runs to be
undetectable), not by a fork. §8.4 describes a two-week fork spike if the owner wants the
cost measured; it was not run.

### 2.4 Why the extension stays (Engine 1)

- It is the only way to act in the person's own signed-in browser: Chrome 136+ refuses remote
  debugging on the default user-data-dir, and App-Bound Encryption (Chrome 127+) makes a person's
  cookies undecryptable by any other binary or copied profile. Engine 2 therefore never reuses a
  person's profile; it has its own (`G9_HOME/profiles/<name>`), warmed once by a person (`warm`).
- Authoring happens where the person works: recording, exploring, filing issues from what is on screen.
- It carries its costs knowingly: the debugger infobar (measured 2026-09-22 on headless Edge
  153.0.4234.32: the viewport is 760/761 px instead of 808 px, and every cross-document load in the
  browser — including tabs G9 never attached — sees two `resize` events 148–301 ms in), refused input
  to hidden tabs (§4.3a), and the MV3 worker lifetime (§4.1). For stealth, Engine 1 applies the input
  rules only (docs/STEALTH.md, "Engine 1 (the extension) and stealth").

### 2.5 Why Electron is the shell only (D4)

Pages under test never load inside Electron's Chromium. Electron is not Chrome: its identity and
fingerprint differ from the customer's browser and its Chromium lags. WebView2 was ruled out as an
engine too (§2.8.4: needs an HWND and a UI thread, no headless mode, pauses rendering when not
visible, does not run in non-interactive sessions, cannot use the person's Edge profile). So Electron
hosts only G9's own screens, served from the private `g9app://app/` scheme: tray, Watch (the daemon's
JPEG frames on a `<canvas>`, the cursor drawn from the pointer track), Runs, Approvals, Engines,
Agents, Schedule, Settings, Setup. It also packages the product: `G9.exe` run with
`ELECTRON_RUN_AS_NODE=1` executes the daemon, the shim and the runner, so a QA machine needs no Node.

### 2.6 One daemon, many agents (D5), no modes (D6), local trust (D7)

The daemon owns every engine and decides per **tab**, not per socket, who may act: the first mutating
call claims a tab, reads are never refused, mutating calls on one tab are serialized (§4.10). The four
v1 control modes, the workspace allowlist, cookie scoping and title withholding are removed by owner
decision: attach means full access, because the deployment is local and trusted (§5).

### 2.7 Facts the design rests on — and what v2 measured

The verified facts of §2.8 (sources in §2.8.6) stand. v2 added these measurements, all
on the owner's workstation on 2026-09-21/22 (Windows 11 Pro 10.0.26200, Edge 153.0.4234.32, Chrome
153.0.8010.50–.53, CfT 153.0.8010.52), each now encoded in code with its reason:

| Fact (measured) | Where it is handled |
|---|---|
| `--remote-debugging-pipe` itself makes `navigator.webdriver === true`, headless and headed; only `--disable-blink-features=AutomationControlled` clears it (`Emulation.setAutomationOverride` does not) | D-a, `engine/stealth.js`, `engine/launch.js` |
| Headless reports an 800×600 screen inside a 1920×1080 window, and a screen with no work area (`availHeight === height`) | `--screen-info={W×H workAreaBottom=48}` + a maximized-size window, `launch.js headlessGeometry` |
| Edge signs every NEW user-data-dir into the Windows account and turns sync on | `msImplicitSignin` disabled + `--disable-sync` on every launch; `profile.signInState` checked before launch (§9 v2.0.0 entry) |
| Under browser-level auto-attach with `waitForDebuggerOnStart:false`, a `window.open()` popup is held until someone resumes it, and its opener wedges | every target held and resumed (§4.11) |
| CfT 153.0.8010.52 renders at 10 fps (rAF every 100.5 ms) where Chrome/Edge run at 10.5 ms — re-confirmed 2026-09-23 with the firewall prompt answered (100.5 ms in 8/8 launches without the switch) | `--disable-frame-rate-limit` for CfT only (`launch.js KIND_SWITCHES`); 17.4 ms in 12/12 launches with it |
| `--disable-component-update` removes the Widevine CDM from Edge and Chrome | switch omitted at stealth and for `warm` |
| Mouse events to a hidden page are not delivered (often not even answered within 5 s); key events DO reach a hidden page's focused field (10/10) | input to hidden pages refused before dispatch (§4.3a) |
| `--start-minimized` is not honoured by Edge/Chrome 153 (window state stays `normal`) | the matrix minimizes with `SW_SHOWMINNOACTIVE` |
| A headed window parked at −32000,−32000 is occluded (hidden) unless `CalculateNativeWinOcclusion` is disabled; Engine 2 always disables it | `launch.js DISABLED_FEATURES` |
| `Page.createIsolatedWorld` works with Runtime disabled and is idempotent per frame; `Runtime.addBinding` by `executionContextName` installs only while Runtime is enabled (by context id it works without) | `lib/world.js`, `tools/record.js` |
| Headless Edge does not push `Target.targetInfoChanged` for `<title>` changes | `platform-cdp` re-reads url/title on `tabs.get`/`query` |
| `Target.createTarget({newWindow:false})` is refused for the first page of a fresh browser context | `platform-cdp createTab` (F1) |
| Headless Edge opens `edge://downloads-hub/` after a download unless `browser.show_hub_popup_on_download_start` is false (8/8 A/B runs) | profile preference set by `manager.js` |
| A locale override per tab changes `Intl` only; `navigator.languages` and `Accept-Language` come from the profile's `intl.accept_languages`, and a UA-override approach left dedicated workers on the old language | launch locale written into the profile; a context locale in another language refused at stealth |

### 2.8 Verified facts the design rests on (checked 2026-09-21)

Each claim below was checked against Chromium source, Chrome/Microsoft/Electron documentation or a real
GitHub issue on 2026-09-21, before v2 was built; the sources are in §2.8.6. Do not re-research them. If
a browser update contradicts one, record the new evidence here and in §9.

#### 2.8.1 Why the extension fails when the tab is not visible (Chromium behaviour, Windows)

- Chromium's occlusion tracker (`ui/aura/native_window_occlusion_tracker_win.cc`) marks a window **HIDDEN** when minimized (`IsIconic`) and **OCCLUDED** when fully covered, on another virtual desktop, when the session is locked (`WTS_SESSION_LOCK`) or when the display is off. Occluded/hidden → `WebContents` hidden → the renderer stops producing frames, rAF pauses, JS is throttled. Minimize also goes through `DesktopWindowTreeHostWin::HandleWindowMinimizedOrRestored → window()->Hide()`, independently of the tracker.
- A non-active tab in a window is always hidden.
- In that state `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` **resolve normally and deliver nothing**. Reproduced by this project (the v1.4.0 change-log entry) and independently (OpenCLI #2520). Reads, `Runtime.evaluate` and `Page.captureScreenshot` keep working. (v2 measured the finer detail: key events do reach a hidden page's focused field — §2.7.)
- `--disable-backgrounding-occluded-windows` rewrites OCCLUDED → VISIBLE (covers "covered" and "locked"), **not** HIDDEN (minimized). `--disable-features=CalculateNativeWinOcclusion` turns the tracker off entirely (covered, locked, other-desktop all become visible); minimized still hides. The policy `WindowOcclusionEnabled=false` does the same as the feature flag without touching the shortcut.
- `--headless=new` (Chrome 112+; the only headless since 132, old headless is the separate `chrome-headless-shell`) is the full browser that "creates but doesn't display any platform windows"; `native_window_occlusion_enabled_` is false under `--headless`, and headless HWNDs never get native focus. Extensions load in it.
- Playwright and Puppeteer both pass `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`. Playwright also enables `Emulation.setFocusEmulationEnabled` on every main frame; Puppeteer does not by default.
- A tab with a `chrome.debugger` client attached is `kProtected` from Memory Saver discarding (`discard_eligibility_policy.cc`).
- Chrome 136+ ignores `--remote-debugging-port/-pipe` on the **default** user data dir; both work with a non-default `--user-data-dir`. Chrome for Testing is exempt.
- Chrome 127+ App-Bound Encryption: cookies in a Chrome profile cannot be decrypted by another binary or a copied profile. Reusing a person's Chrome profile from Engine 2 is impossible by design and is not attempted.

#### 2.8.2 What a Manifest V3 extension can never do

- Set launch switches, relaunch the browser, or run after it exits (`runtime.restart()` is ChromeOS kiosk only).
- Use the CDP `Browser` domain (untrusted client), or attach to `chrome://`, the Web Store, other extensions' pages or DevTools.
- Avoid the "is debugging this browser" infobar, except when installed by policy (`ExtensionInstallForcelist`) or when the browser runs with `--silent-debugger-extension-api`. DevTools and `chrome.debugger` coexist since Chrome 63.
- Move the real OS cursor or read the desktop. Native Messaging can launch a local exe that can, but such input takes over the person's mouse and never reaches a locked session (secure desktop).
- Stop a window from being hidden when the person minimizes it or switches tabs.

What it can do, and v2 uses: attach to every tab, `chrome.windows.create({tabId})` to pop a tab into its own window **without reloading it**, `chrome.cookies.getAll` (HttpOnly included), `chrome.downloads` (needs the permission), `chrome.runtime.reload()` to reload an unpacked extension after its folder was updated, and `Runtime.addBinding` scoped to an isolated world.

#### 2.8.3 CDP input is real input

`Input.dispatch*` in `content/browser/devtools/protocol/input_handler.cc` builds a `WebMouseEvent`, hit-tests and forwards it through `RenderWidgetHostImpl::ForwardMouseEvent`. Events are `isTrusted === true`, pointer type `mouse`, delivered on the same rAF-aligned queue as real mouse input. Nothing touches the OS cursor. What differs from a person is only the trajectory and the timing, which `extension/humanize/` supplies.

#### 2.8.4 Embedding options, and why they are not the engine

- **WebView2** (under .NET MAUI BlazorWebView): full CDP and Playwright support, but it needs an HWND and a UI thread, has no headless mode, pauses rendering when `IsVisible=false`, does not run in non-interactive sessions, cannot use the person's Edge profile, and is not Edge's identity. Strictly worse than launching Edge itself.
- **Electron**: `offscreen: true` rendering, `webContents.debugger` (full CDP), `sendInputEvent` (documented as requiring a focused window). Fine as a shell; wrong as an engine (identity, version lag).
- **CefSharp.OffScreen**: the .NET way to own an engine with no window; off-screen rendering has no accelerated compositing. Not needed.

#### 2.8.5 Real OS input

`SendInput` and libraries built on it (nut.js) require the target on the active input desktop; nothing reaches applications while the session is locked. Microsoft's guidance for UI test agents is an interactive session with autologon, screen lock disabled, and `tscon <id> /dest:console` when leaving RDP. Windows Sandbox (Windows 11 Pro+) or a Hyper-V VM gives a desktop that is independent of the host being locked. This matters only for the optional real-cursor "showroom" driver, which is not built (§8.4).

#### 2.8.6 Sources

Chromium behaviour
- Occlusion tracking design: https://chromium.googlesource.com/chromium/src/+/main/docs/windows_native_window_occlusion_tracking.md
- Tracker source (lock, display off, minimized, virtual desktops): https://chromium.googlesource.com/chromium/src/+/main/ui/aura/native_window_occlusion_tracker_win.cc
- Minimize hides independently of the tracker: https://chromium.googlesource.com/chromium/src/+/main/ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc
- `--disable-backgrounding-occluded-windows` only maps OCCLUDED→VISIBLE: https://chromium.googlesource.com/chromium/src/+/main/content/browser/web_contents/web_contents_impl.cc and https://chromium.googlesource.com/chromium/src/+/main/content/public/common/content_switches.cc
- Feature flag: https://chromium.googlesource.com/chromium/src/+/main/ui/base/ui_base_features.cc ; headless disables the tracker: https://chromium.googlesource.com/chromium/src/+/main/ui/aura/window_tree_host.cc
- CDP input path: https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/protocol/input_handler.cc
- Discard protection with a debugger attached: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/performance_manager/policies/discard_eligibility_policy.cc
- Independent report of dropped input on hidden pages: https://github.com/jackwener/OpenCLI/issues/2520 ; hangs when minimized: https://github.com/puppeteer/puppeteer/issues/3156 , https://github.com/puppeteer/puppeteer/issues/4131
- New headless: https://developer.chrome.com/docs/chromium/new-headless ; headless shell split: https://developer.chrome.com/blog/chrome-headless-shell
- Chrome 136 remote debugging rule: https://developer.chrome.com/blog/remote-debugging-port
- App-Bound Encryption: https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html
- Release cycle (two-week milestones since 153): https://chromium.googlesource.com/chromium/src/+/main/docs/process/release_cycle.md
- Windows build requirements: https://chromium.googlesource.com/chromium/src/+/main/docs/windows_build_instructions.md
- Chrome for Testing downloads: https://googlechromelabs.github.io/chrome-for-testing/ (JSON: `known-good-versions-with-downloads.json`)

Playwright / Puppeteer
- Launch switches: https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts , https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/node/ChromeLauncher.ts
- Focus emulation default: https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/crPage.ts
- `isTrusted` test: https://github.com/microsoft/playwright/blob/main/tests/page/page-mouse.spec.ts

Extension APIs and policies
- `chrome.debugger` (domains, restrictions, policies): https://developer.chrome.com/docs/extensions/reference/api/debugger ; attach rules in source: https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/extensions/api/debugger/debugger_api.cc
- Service-worker lifetime: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Native messaging: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- `chrome.windows`: https://developer.chrome.com/docs/extensions/reference/api/windows ; `chrome.tabCapture`: https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- Policy definitions (WindowOcclusionEnabled, IntensiveWakeUpThrottlingEnabled, BackgroundTabFreezingEnabled, HighEfficiencyModeEnabled, TabDiscardingExceptions, DeveloperToolsAvailability, ExtensionInstallForcelist): https://source.chromium.org/chromium/chromium/src/+/main:components/policy/resources/templates/policy_definitions/
- Timer throttling: https://developer.chrome.com/blog/timer-throttling-in-chrome-88 ; page lifecycle: https://developer.chrome.com/docs/web-platform/page-lifecycle-api

Embedding
- WebView2 CDP: https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/chromium-devtools-protocol ; browser arguments: https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2environmentoptions.additionalbrowserarguments ; visibility: https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controller.isvisible ; user data folder: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder ; Playwright: https://playwright.dev/docs/webview2 ; headless request: https://github.com/MicrosoftEdge/WebView2Feedback/issues/1927 ; non-interactive: https://github.com/MicrosoftEdge/WebView2Feedback/issues/4259
- Electron: https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering , https://www.electronjs.org/docs/latest/api/debugger , https://www.electronjs.org/docs/latest/api/web-contents , https://www.electronjs.org/docs/latest/tutorial/electron-timelines
- CefSharp: https://github.com/cefsharp/CefSharp/blob/master/CefSharp/IBrowserHost.cs , https://chromiumembedded.github.io/cef/general_usage

Human input and OS input
- ghost-cursor (Bézier + Fitts + overshoot over `Input.dispatchMouseEvent`): https://github.com/Xetera/ghost-cursor ; WindMouse: https://ben.land/post/2021/04/25/windmouse-human-mouse-movement/
- `SendInput`: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput ; desktops/input desktop: https://learn.microsoft.com/en-us/windows/win32/winstation/desktops
- UI test agents (autologon, `tscon`): https://learn.microsoft.com/en-us/azure/devops/pipelines/test/ui-testing-considerations
- Windows Sandbox: https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/

### 2.9 Standing rules (R1–R9)

The rules v2 was built under. The code cites them by number; §4 explains the constraints behind R2
and R4, and [Rules for changing this codebase](#rules-for-changing-this-codebase) is how R7 is practised.

- **R1. Read before you write.** §§1–5 and §8 of this file first. Do not start with a rewrite; every change keeps the product working at its end.
- **R2. No `chrome.*`, `browser.*`, `globalThis.chrome` or `node:` imports anywhere under `extension/tools/` or `extension/humanize/`.** Everything platform-specific goes through `extension/lib/platform.js` (§4.6). A source check in `setup/unit/seam.test.mjs` fails on a violation.
- **R3. Shared code is imported from its home, not copied.** The daemon imports `extension/tools/*.js` directly. `extension/lib/platform.js` selects the implementation at module load with plain static imports of both (both are browser-safe); the daemon calls `setTransport()` on the CDP implementation before any tool runs. No top-level `await` in any module under `extension/` (service workers forbid it).
- **R4. Never enable `Runtime` at the `stealth` level; never add a binding to the main world at any level; never put the cursor or any helper element in the page DOM** (§4.7, §4.8).
- **R5. No fork, no Electron engine, no `tabCapture` keep-alive as a foundation, no modes, no allowlists.** The `tabCapture` and virtual-desktop ideas are spikes only (§8.4).
- **R6. A dispatched action is not a delivered action.** Keep the input witness (EXT-01, §4.3a); never auto-retry a state-changing action whose outcome is unknown.
- **R7. Every change** bumps the version, adds a change-log entry here and updates the affected sections, and runs the checks the change needs (§7.0).
- **R8. Do not claim a capability the tests did not exercise.** Background-state behaviour in particular is reported from the measured matrix (§8.2), never inferred.
- **R9. Numbers are defaults, not laws.** Every humanize timing and threshold lives in the profiles (`extension/humanize/profiles.js`, a calibrated profile per team), not in the planners' code.

---

## 3. Repo layout

```
g9-browser-agent/
├── package.json                  the ONE version (3.0.0) for the whole product; no dependencies; node >=22
├── extension/                    Engine 1 (MV3), and the HOME of the shared tool code
│   ├── manifest.json             3.0.1; minimum_chrome_version 125; permissions in §5
│   ├── sw.js                     service worker: lifecycle, transport to g9d, panel commands; calls tools/index.js
│   ├── lib/
│   │   ├── platform.js           THE SEAM: exports platform-extension or platform-cdp (rule R2)
│   │   ├── platform-extension.js chrome.* implementation (debugger, tabs, cookies, storage, IndexedDB blobs, image, downloads)
│   │   ├── platform-cdp.js       the same surface over CDP pipes to launched browsers (browser-safe, no node:)
│   │   ├── cdp.js                the CDP choke point: send/evaluate/ensureDomain, halt check, timeouts, stealth domains
│   │   ├── state.js              platform.storage-backed state, serialize() chain, activity log
│   │   ├── store.js              recordings + issues (storage.local) and attachment bytes (platform.blobs)
│   │   ├── refs.js               element refs (eN → backendNodeId, child sessionId)
│   │   ├── frames.js             cross-origin child sessions (flat auto-attach, recursive)
│   │   ├── world.js              G9's isolated world 'g9' — every internal evaluation runs here
│   │   ├── pointer.js            per-tab pointer position + cursor track (never drawn in the page)
│   │   ├── screencast.js         one Page.startScreencast per tab, shared by video and live watch
│   │   ├── humanize.js           the dispatcher: humanize plans → Input.dispatch*, levelFor, hidden checks
│   │   ├── locators.js           multi-locator element identity (recorder core, §8b)
│   │   ├── signature.js          journey signature, known world, surprise detector (§8c)
│   │   ├── flowspec.js           canonical, Git-diffable FlowSpec
│   │   ├── visual.js             fingerprint + structure map + diff image (through platform.image)
│   │   ├── sites.js              (v3) pure URL helpers: siteOf (origin), parseDomain, hostMatches, displayUrl
│   │   └── transport.js          WebSocket client to g9d (extension only)
│   ├── humanize/                 PURE human-input library (no I/O, no timers, seeded): prng, profiles, profile,
│   │                             plan, mouse, wheel, keys, calibrate, index
│   ├── tools/                    18 modules behind the 15 tools; NO chrome.* / node: (rule R2)
│   │   ├── index.js              TOOLS table + runTool pipeline + status() — shared by both engines
│   │   ├── events.js             CDP event fan-out (console, network, recorder, dialogs, frames)
│   │   ├── tabs.js               target resolution, listTabs, attach, popout, handoffExport, ensureFront
│   │   ├── snapshot.js  interact.js  inspect.js  observe.js  navigate.js  capture.js  diagnose.js
│   │   ├── emulate.js   record.js    replay.js   qa.js       netpin.js   netrules.js  downloads.js
│   │   └── issues.js
│   └── panel/                    side panel (v3): Session (daemon, agents + their tabs, current tab and capture,
│                                 auto-attach, keep working elsewhere, input level, Stop, activity), Automation
│                                 (site → suite → flow), Issues (site → status), About; welcome.html/.js
├── engine/                       Engine 2 (Node): find.js, cft.js, launch.js, pipe-cdp.js, profile.js,
│                                 stealth.js, firewall.js, manager.js (EngineManager, owned by the daemon), versions.json,
│                                 README.md
├── daemon/                       g9d: g9d.mjs (CLI), daemon.js (composition), ws-server.js, registry.js,
│                                 router.js, handoff.js, storage.js, evidence.js, scheduler.js, settings.js,
│                                 paths.js, home-lock.js, project.js, flows.js, extension-update.js
├── mcp/                          shim.mjs (what an AI client launches), mcp.js (stdio MCP), tools.js (schemas + INSTRUCTIONS)
├── lib/                          version.mjs (reads package.json), ws-client.mjs, ws-codec.mjs (RFC 6455, shared)
├── runner/                       g9.mjs (run · list · calibrate · approve · spec · ab; exit 0–4), mcp-client.mjs,
│                                 report.mjs, drivers/agripad.mjs, README.md
├── bridge/src/server.js          v1 entry point kept as a 9-line forwarder to mcp/shim.mjs (v1 MCP configs)
├── desktop/                      Electron shell (the ONLY npm dependencies): main.mjs, preload.cjs, lib/, renderer/,
│                                 test/, build/, scripts/, electron-builder.yml, dist/ (built installer)
├── docs/                         ARCHITECTURE_V2.md, DAEMON_PROTOCOL.md, STEALTH.md, HUMANIZE.md, INSTALL.md (operators)
├── setup/
│   ├── check.mjs + check-plan.mjs (3.0.1) only the checks a change reaches, several at a time (§7.0)
│   ├── doclinks.mjs              (3.0.1) relative links and anchors in the Markdown files
│   ├── unittest.mjs + unit/      12 unit suites (§7), one child process each
│   ├── selftest.mjs              real daemon + two real shims + a fake extension, no browser
│   ├── extensiontest.mjs         extension modules through the real seam over a chrome stub
│   ├── engine2-livetest.mjs      Engine 2 through the product path, real headless Edge
│   ├── isolated-livetest.mjs     Engine 1: private daemon + temp profile + extension copy; runs livetest.mjs
│   ├── livetest.mjs              the Engine 1 live checks (an MCP client)
│   ├── panel-render.mjs          (v3) the side panel over a stubbed chrome, rendered to PNGs by headless Edge (a dev harness)
│   ├── stealthtest.mjs           stealth self-test / pre-suite gate (+ stealth-pages.json, fixtures/stealth-local.html)
│   ├── matrix.mjs  bench.mjs  endurance.mjs   P8 background-state matrix, parallelism, endurance
│   ├── serve.mjs  testpage.html  crossframe.html  fixtures/
│   ├── install.ps1               install from a clone: Node 22 check, unit/self/extension tests, MCP config → mcp/shim.mjs
│   ├── make-icons.ps1            (3.0.1) extension/panel/icon16/32/48/128.png from the owner's artwork
│   └── mcp.example.json          committed template (mcp.json is generated, gitignored)
├── scripts/                      standalone MCP automations and their README
├── g9.project.example.json       project adapter template
├── README.md  AIGuide.md
```

`G9_HOME` (default `%LOCALAPPDATA%\G9`, else `~/.g9`) holds `daemon.json`, `daemon.lock`, `settings.json`,
`engine-versions.log`, `engines/cft-<version>/`, `engines/log/`, `engines/firewall-seen.json`, `profiles/<name>/`, `store/`,
`runs/<runId>/`, `downloads/<contextId>/`, `extension/` (the desktop-managed unpacked copy) and `logs/`
(ARCHITECTURE_V2 §9).

**Where does new code go?** Browser capability → `extension/tools/` (and nothing platform-specific —
extend `platform.*` instead). Schema/description → `mcp/tools.js`. Routing, ownership, evidence,
scheduling → `daemon/`. Launching and profiles → `engine/`. Human motion → `extension/humanize/`
(pure) and `extension/lib/humanize.js` (dispatch). The daemon stays "deliberately dumb" about pages:
it never clicks or reads a page itself.

---

## 4. The constraints that shaped the code

Every non-obvious decision traces back to one of these. Do not "simplify" past them.

### 4.1 The MV3 service worker can be suspended (Engine 1)

**Consequence:** no module-level variable in the extension is a source of truth.

- Transient state (refs, capture buffers, pointer position, per-tab tool state) lives in
  `platform.storage.session` (`chrome.storage.session` in the extension: cleared when the browser
  closes). Settings, recordings and issues use `storage.local`; attachment bytes and video frames use
  `platform.blobs` (IndexedDB `g9-attachments`). In the daemon the same calls go to a file-backed
  `storage.local`, an in-memory `storage.session` and file blobs (`daemon/storage.js`).
- `transport.js` pings every **20 s**; an active WebSocket keeps the worker alive while messages flow.
  A 30 s `chrome.alarms` heartbeat revives a worker after an offline period.
- Every listener that must be able to wake the worker is registered synchronously at top level
  (`sw.js`, and the `chrome.downloads` listeners in `platform-extension.js`).
- State mutations go through one promise chain, `state.js serialize()`; `observe.js`, `store.js` and
  `downloads.js` use it too. A function inside `serialize()` must never call another serialized
  function, or it deadlocks (v1.0.5, v1.0.7).
- **A restart must not cost agents their tabs (D-c).** The extension sends a random `instanceId`
  (generated once, `storage.local`) and a `loadId` (`storage.session`: same across worker restarts, new
  after an extension reload or browser restart) plus its open tabs in every hello. The daemon parks a
  disconnected extension for `G9_ENGINE_RESUME_MS` (default 10 min) and gives the same engine id,
  handles, claims and session names back (§4.10). It re-sends `watch` for watched tabs, because live
  streams lived in the old worker. The pointer track (`pointer.js`) is worker memory and is lost on a
  restart; the persisted position survives.

### 4.2 Agents are bad at CSS selectors

**Consequence:** the ref system in `lib/refs.js`.

`browser_snapshot` walks the accessibility tree, assigns `e1`, `e2`… to interactive nodes, and stores
`ref → {backendNodeId, sessionId?}` per tab. `resolveRef` rejects unknown refs and a URL change
(hash ignored); navigation clears refs. A node inside a cross-origin frame carries its child
`sessionId`, and `sessionForNode` looks it up from the table so no call site has to thread it.

**A ref names one element for good (EXT-03, fixed 2026-09-22).** v1 renumbered from `e1` on every
snapshot, so an old ref could silently resolve to another element of a newer snapshot, another agent's
included. Now a snapshot continues the page's numbering (`e1…e30`, then `e31…`), numbers are never
reused on a page, and the last `KEEP_GENERATIONS` (4) snapshots EACH caller took of a page stay
resolvable (`MAX_GENERATIONS`, 16, caps the table across callers). A ref from an older snapshot of your
own, from another page (numbering and history start over when the URL changes) or for a removed element
is refused with "take a fresh snapshot". Retention is per caller because reads are never queued: a
second agent snapshotting every 100 ms used to evict the working agent's refs mid-action (live round 4).
Replay's reserved refs live apart (`withPrivateRefs`).

### 4.3 Synthetic events fail on real applications — and machine-timed ones are a tell

**Consequence:** all input is trusted CDP input (`Input.dispatchMouseEvent/KeyEvent`, `isTrusted ===
true`, the browser's own hit test), at one of three input levels (`lib/humanize.js levelFor`):

- `off` — v1's direct dispatch, event for event (one move, press, release; `scrollIntoView` first;
  12 ms per typed character; a 12-move drag). Kept exactly so flows debugged against it behave the same.
- `human` — curved, Fitts-timed paths from the pointer's last position to a sampled point inside the
  element (never the exact centre), minimum-jerk timing, 8–16 ms sampling, hover dwell, a 60–140 ms
  press hold, **pressure 0.5 while a button is down** (CDP's default 0 was a one-property tell in 50/50
  runs), off-screen targets reached with **wheel notches**, per-key rhythm with the odd corrected typo
  (never in password fields). Humanized pointer events go to the PAGE session in top-level
  coordinates, even for a node in a cross-origin frame — the browser routes them, as it routes a real
  mouse — so there is one pointer per tab. `off` keeps v1's routing through the frame's session.
- `stealth` — `human` minus every shortcut a page can see: no `DOM.focus` (focus is earned by a
  click), no programmatic scroll fallback (fail and say why), no `Input.insertText` unless
  `fast:true`; `clear:true` uses only keys a person would press (select-all chord, Backspace, then End
  and one Backspace per remaining character); `select` = a humanized click, Escape to close the native popup,
  then keyboard selection.

Kept from v1, and still load-bearing:

- `checkObscured()` uses `elementsFromPoint` (plural, so `::after` shields are seen) and treats an
  ancestor on top as an obstruction; `<label>` is the one exception. v2 first compares the point with
  the element's own `getClientRects()`: an element that simply MOVED gets "no longer where G9 measured
  it … nothing was pressed", not an overlay accusation (round-3 fix).
- Typing defaults to per-character key events; `fast:true` uses `Input.insertText` (fine for
  controlled inputs, wrong for masked/filtered fields — v1.0.15). `off`/`human` `clear:true` select
  through the DOM, then delete with a real key, then **verify** the field is empty and throw if not.
- Command chords use `rawKeyDown` without `text`; Shift alone gives `keyDown` with the shifted text.
  Modifier keys carry `location` (1 left, 2 right).
- Explicit `x`/`y` for a humanized pointer must be inside the viewport; outside it the call is refused
  before anything is dispatched (scroll first, or act by ref).
- `perform()` (the dispatcher) keeps an absolute schedule, but an interval that ends in a press,
  release, key or wheel notch keeps at least **80 %** of its planned length, and overdue pointer moves
  are merged instead. Without that, a slow transport (CfT: 35–54 ms per `mouseMoved`) collapsed 60–140
  ms press holds to 1.9–8.1 ms (20/22 CfT runs, live round 2).
- Scrolls return only once the page has stopped moving (a hover or click right after a scroll used to
  aim at stale geometry), and a reach settles before aiming.

### 4.3a A dispatched event is not a delivered event

**Consequence:** the input witness in `tools/interact.js` (v1's EXT-01 defect is fixed; the v1
`ReferenceError` account in §9 is history).

- **Armed first, in G9's world.** Before any input goes out, a trusted-events-only capture listener is
  armed in the isolated world `g9` — ON the target element when there is one (`callInWorld`), so the
  page can say *where* the event landed, else on the frame (and attached cross-origin frames, for keys).
  If it cannot be armed, nothing is dispatched: "G9 does not act without a way to tell".
- **Timed from the end of dispatch.** The page is armed with a 10-minute safety net; after dispatch
  `settle()` re-times the verdict to `WITNESS_TIMEOUT_MS` (1.5 s) from that moment. v2.0's first
  witness timed out from arming: an Engine 2 click whose dispatch took ~64 s on a throttled tab was
  reported "not delivered" after 85 s although the page had it (live round 2, 3/3). If the safety net
  does fire, the page answers `expired`, which reads as "cannot tell", never as "not delivered".
- **Presses are witnessed by `pointerdown` OR `mousedown`**: a page that cancels `pointerdown` gets no
  `mousedown` by the Pointer Events spec, and that delivered click used to be reported lost.
- **An outcome outranks events:** typing verifies the field's value (`verify`).

The delivery states, and how each reaches the agent:

| State | Meaning | Returned or thrown |
|---|---|---|
| `delivered` | the target (or, untargeted, the frame) received a trusted event of the expected kind, or the outcome was verified | result `delivery:"delivered"` |
| `indeterminate` | no verdict (the document was replaced mid-action — usually the action took effect; a lost handle; the safety net) | result `delivery:"indeterminate"` + `deliveryNote`; the action is NOT repeated |
| `missed` | the event reached the page at ANOTHER element (`hit` names it, with coordinates) | thrown; never retried — whatever that element does may have happened |
| `not-delivered` | nothing reached the page; or the tab is HIDDEN and nothing was sent | thrown |
| `partial` | the tab became hidden part-way: `sent`/`of` input events went out, the page's measured scroll delta is reported, an accepted event may still land later; a click whose button went down is `partial`, one with no press is `not-delivered` ("a click NOT made") | thrown |

`runTool` puts the state at the start of the error text — `[delivery: missed; hit <div#x>] …`,
`[delivery: not-delivered; tab hidden] …`, `[delivery: partial; 3 of 12 input events sent; tab hidden] …`
— because every relay keeps only the text; the daemon protocol also carries `delivery`, `hit`,
`hidden` as fields (DAEMON_PROTOCOL §3/§4), and the shim's MCP error shows the tagged text.

**Hidden pages.** Every input action first asks the page's `visibilityState` (one round trip, in G9's
world). A hidden page gets nothing: pointer and wheel input measurably does not arrive; key events
would (10/10 hidden pages, live round 3), and refusing them is G9's **policy** — nobody can see what
they do, and a type's focus click would be lost. The message names the agent's own remedies:
`browser_tabs action:"focus"`, `"popout"` (keep it un-minimized) or `"handoff"`. Reads keep working on
hidden tabs; screenshots of a background or off-screen tab took 44–487 ms, but on a minimized window
`Page.captureScreenshot` gave no answer within 5 s (matrix, live round 3). On a launched **headless** engine, a tab behind a page-opened tab is first
brought to the front (`platform.tabs.ensureFront`); headed engines and the extension never rearrange
windows, they report.

### 4.4 Tool definitions are re-sent on every request

**Consequence:** 15 grouped tools, not ~50 flat ones: `browser_status`, `browser_engine` (new in v2),
`browser_tabs`, `browser_snapshot`, `browser_interact`, `browser_navigate`, `browser_inspect`,
`browser_console`, `browser_network`, `browser_diagnose`, `browser_screenshot`, `browser_emulate`,
`browser_dialog`, `browser_recording`, `browser_issue`. Each takes an `action`/`what` discriminator;
new capabilities become actions, not tools. `setup/selftest.mjs` asserts 15 (`tools/list`, and through
the v1 forwarder). Token counts depend on the schemas, model and client; no benchmark is maintained.

### 4.5 The person must stay in charge: Stop, activity, ownership

v2 removed the modes that v1 treated as a safety boundary (D6). What remains is operational, and it
must work everywhere a capability can be reached:

1. **Stop is checked at every layer that can act.** Global halt (the panel's Stop, reported by the
   extension; or the desktop's Stop) and per-agent halts live in the daemon registry. The daemon
   refuses every tool except `browser_status` while halted (including tools it answers itself, such as
   `browser_engine`); a call waiting in a tab queue is checked again at its turn; the halt is mirrored
   into the extension (`{type:'halt'}`) and into launched engines, so in-flight Engine 2 work stops at
   its next CDP command. Inside each engine `runTool` checks it at the router (tab management is not
   CDP) **and** `cdp.send()` checks it; the dispatcher checks it between steps, so humanized typing
   stops mid-word (measured: 37–94 ms after Stop, live round 3).
2. **Only a person resumes.** Admin ops (`resume`, `resumeAgent`) are UI-only; an agent gets "Admin
   operations are for the G9 desktop app" — and since 2026-09-22 the `ui` role itself is only accepted
   from a NATIVE connection (no Origin header), so a browser extension cannot say hello as the
   desktop and rewrite the settings the desktop's updater reads. A Stop pressed while the extension
   was disconnected is re-asserted after the welcome; the extension now also tries to connect at once
   when the Stop could not be sent (instead of waiting out a backoff of up to 60 s), and the panel
   says "Stopped in this browser. The G9 daemon is not connected; it will be told when it connects"
   rather than "Agents stopped".
   Stop blocks AGENTS, not the person: the side panel's own Stop-and-save, issue screenshot and tab
   video keep working while Stop is on (`lib/cdp.js asPerson` — reads, captures and clean-up on that
   tab only, never input and never a navigation), and the panel shows the recording that is still
   running instead of calling the tab "another tab".
3. **Activity is logged once per call.** Every call is recorded (tool, tab, ok, detail, duration,
   caller); the daemon reports agent calls itself and drops the engines' `relayed:true` echoes, so the
   desktop and the panel show each call once and the side panel's own actions still appear (F7).
4. **Ownership.** A tab another connected agent owns is refused to your mutating calls with the owner's
   name; `claim force:true` takes it over and is logged as `takeover`. `browser_engine stop` refuses an
   extension engine (G9 never closes the person's browser) and a launched engine where another agent
   owns a tab or that another client holds with `acquire`, unless `force`.

Stop acts at guards and step boundaries; it cannot undo side effects. After Stop, G9 still ends and
releases its own witness listener: `interact.js cleanupSend` sends that clean-up on the live session,
bounded at 2 s, because taking G9's listener away is not acting on the page; only if that fails does
it stay armed until its 10-minute safety net (§8). The general rule from v1
still applies: a check that lives at one layer only has a way around it.

### 4.6 The platform seam (rule R2)

Nothing under `extension/tools/`, `extension/humanize/` or the shared parts of `extension/lib/` may
reference `chrome.`, `browser.`, `globalThis.chrome`, `indexedDB`, `OffscreenCanvas`,
`createImageBitmap`, `FileReader`, or import `node:` modules. Everything platform-specific goes through
`extension/lib/platform.js`, which statically imports BOTH implementations and exports one:
`platform-extension.js` (chrome.*, IndexedDB, OffscreenCanvas) when `chrome.debugger` exists, else
`platform-cdp.js`. Allowed exceptions: `platform-extension.js`, `sw.js`, `lib/transport.js`,
`panel/**`. No top-level `await` anywhere under `extension/` (service workers forbid it), and
`platform-extension.js` must evaluate cleanly where `chrome` does not exist (the daemon imports it).
Page-side code inside strings passed to `evaluate`/`callOnNode`/`inWorld` is not a violation.
`setup/unit/seam.test.mjs` enforces the rule with a tokenizer-based source scan plus a Node smoke
test; extending `platform.*` means changing both implementations and ARCHITECTURE_V2 §3.

### 4.7 Isolated worlds only (rule R4)

Everything G9 evaluates for itself — the witness, the recorder and its binding, the locator engine,
snapshot text extraction, `qa.js` reads, replay's element resolution, the navigation idle watcher,
handoff storage reads, emulation reads — runs in the isolated world `g9` (`lib/world.js`), never in
the page's main world. v1 left `__g9loc`, `__g9target`, `__g9rec` and the recorder binding on
`window`, where any MutationObserver or bot detector could see them. Context ids restart per renderer
process, so a cached id can point at a different context (even the main world) after a cross-process
navigation: every evaluation carries a guard (`__g9world` token) instead of trusting the cache, with
one transparent retry. `browser_console action:"evaluate"` is the one deliberate main-world call — the
agent is asking about the page's own JavaScript. Measured after the whole live suites: no `__g9*` or
binding names in the main world (Engine 1: 1233 own-property names unchanged after recording + replay;
Engine 2: 0 names beyond a pristine window). The cursor is never drawn in the page either (D9).

### 4.8 Stealth levels, and the Runtime rule

A stealth level (`off` / `human` / `stealth`) is set per launched engine or browser context (D10); in
the extension it is the panel's Input setting. `docs/STEALTH.md` is the owner's guide.

- **Runtime is never enabled at `stealth`** (`cdp.js AUTO_ENABLE`, `engine/stealth.js
  autoEnableDomains`), in page sessions and in child sessions. Enabling it makes the renderer serialise
  console arguments, which a page can observe (a getter on a logged `Error` is read twice with Runtime
  enabled — the probe the stealth self-test uses). Costs, stated in results: no page console capture
  (`browser_console` says so; `Log` still gives browser-side entries), evaluation only through
  isolated worlds, the recorder's binding added by context id.
- **Decision D-a: the `AutomationControlled` switch at stealth only.** `launchArgsFor('stealth')`
  = `['--disable-blink-features=AutomationControlled']`; `launchBrowser` refuses it in `extraArgs` at
  `off`/`human` (those levels make no claim about the environment and say "navigator.webdriver is
  true" in `launchWarnings`), and refuses `--enable-automation` always. Measured: webdriver `false` in
  40/40 stealth runs (a native getter, not an own property) and `true` in 14/14 human controls (live
  round 3).
- **Environment at stealth** (Engine 2): headless screen with a work area; a warm persona profile
  whose languages follow its locale; timezone/locale overrides applied to held targets before their
  first script, including cross-site iframes and popups (§4.11); Widevine kept (no
  `--disable-component-update`); a signed-in profile refused; a context locale in another language than
  the profile refused; screenshots that would resize the viewport refused (a full page taller than the
  viewport; elements are brought in with the wheel and clipped inside the viewport).
- **Decision D-b: the stricter level wins.** The effective input level is the stricter of the
  call's `humanize` (else the tab's default) and `platform.settings.stealthFor(tabId)`, order off <
  human < stealth. In the extension `stealthFor` is `'stealth'` only when the panel says Stealth, else
  `'off'` — so **only Stealth is a floor**: with the panel at Human or Direct an agent's
  `humanize:"off"` gets direct input; with the panel at Stealth every action gets stealth input.
  Results carry `humanize {level, profile, seed, raisedFrom?, stealthLevel?}` when a level was raised.
- Consistency beats spoofing: G9 never overrides the UA, Client Hints, platform, plugins or WebGL.
  What stays detectable (the HeadlessChrome UA, the Engine 1 infobar, …) is in §8.

### 4.9 Humanize is pure and deterministic

`extension/humanize/` decides WHAT a hand would do and WHEN, as a timed list of steps, from a seed:
no I/O, no timers, no globals, no platform (R2 applies). `createRng` is mulberry32; every planner takes
the RNG first. Every humanized result carries its `seed`; passing it back (`seed`, the runner's
`--humanize-seed`) reproduces the identical plan FROM THE SAME POINTER POSITION and viewport — a
plan's first step starts where the last action left the pointer on that tab, so a replay homes the
pointer to a seed-derived point before step 1 and reports it as `pointerStart` (2026-09-22), and
replay records `humanizeSeed`. Only
`extension/lib/humanize.js` turns plans into `Input.dispatch*`, adding the three things a pure library
cannot have: time (`performance.now()` against the plan's absolute `at`), Stop between steps, and the
pointer track. So delivered timing is the plan plus transport latency, bounded by the 80 % rule
(§4.3). Profile values live in `extension/humanize/profiles.js` (`off`, `human`, `stealth`), not in
code paths; calibrated profiles are stored under `humanize:profile:<name>`. `setup/unit/humanize.test.mjs`
checks determinism per seed, every distribution's bounds over 2000 random plans, no teleports, ≤ 1 px
press/release drift and no typos in password fields.

### 4.10 One daemon; handles and ownership are the daemon's

- **Handles.** Tab ids an agent sees are daemon-wide integers. Engine 2 tabs are born with one
  (`platform-cdp` `allocTabId` → registry). Engine 1 tabs are Chrome tab ids mapped `(engineId,
  chromeTabId) ↔ handle`; the router rewrites every numeric `tabId`, `openerTabId` and `tabIds[]`, at
  any depth, both ways (never inside data keys such as `value`, `har`, `spec`, `variables`). A handle of
  another engine is refused before anything is sent.
- **Resolution.** `args.tabId` → `args.session` → the caller's current tab → the default engine's
  current tab. Every agent has its own current tab (set by open, attach, focus, handoff, session). A
  default is never a tab another connected agent owns. Inside an engine, `tools/tabs.js resolveTarget`
  follows ARCHITECTURE_V2 §4.1 and refuses rather than guesses.
- **Ownership and queues.** First mutating call claims; reads (`isReadOnly`) are never refused and
  never queued — and `browser_screenshot` is a read only for `area:"viewport"`: an element or
  full-page capture scrolls or resizes the page, so it claims the tab and queues like any action
  (2026-09-22). Mutating calls on one tab run one at a time in arrival order (`browser_dialog` is
  exempt, it is how a queue stuck behind a dialog is freed); a disconnect releases claims; a dialog
  fails every pending call on its tab at once, scoped to that tab. At a queued call's turn — and at
  the moment it gets its maxParallel slot — liveness, the halt and ownership are checked again, so a
  call queued behind a long one never runs for an agent that left or on a tab that changed hands.
- **Parallelism.** `settings.maxParallel` (default 8) limits concurrent MUTATING Engine 2 calls; waits
  (`navigate wait`, `wait_download`, `tabs wait`) hold no slot (a waiting agent used to block others:
  7.6 s for a 67 ms click, live round 2).
- **Identity across reconnects (D-c)**, as in §4.1. A hello that races the old socket supersedes it;
  an extension closed as "superseded" does not reconnect by itself (two browsers sharing a copied
  profile would otherwise displace each other in turn).

### 4.11 Engine 2 holds every new target until it is prepared

`platform-cdp` runs browser-level `Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:true,
flatten:true})`, and forces `waitForDebuggerOnStart:true` on the tool layer's page-level auto-attach
too. Every target that attaches is resumed with `Runtime.runIfWaitingForDebugger` right after the
daemon's `prepareTab`/`prepareChild` hooks have SENT their commands (bounded by `PREPARE_BUDGET_MS`,
3 s); non-tabs are resumed at once; nothing is ever left paused. Why (all measured on Edge and Chrome
153, live round 3):

- With `waitForDebuggerOnStart:false` (the original design's setting) Chromium still held a
  `window.open()` popup until somebody resumed it, and the opener wedged: the click that opened it
  never returned (raw probe: 15 s; product: failed after 21–25 s in 18/18 stealth runs and 7/7 Engine 2
  runs), the popup stayed at `url ''`, and the opener's next goto timed out. Resuming held targets:
  the click returns in 36–48 ms.
- A tab the page opens must get its persona (timezone, locale) and the tool layer's domains before its
  first document, or its first load's network is missed and its first script reads the host's time
  zone. A held target answers nothing while held (`Network.enable` did not return in 8 s) but applies,
  in order, every command sent before the resume — so the hooks SEND and never await.
- A cross-site iframe runs in its own renderer: per-page `Emulation.setTimezoneOverride` does not reach
  it (it reported the host's time zone and `de` under a de-DE/Europe/Berlin persona, 7/7 runs), so the overrides
  go to the held child's own session. A cross-site popup starts in the opener's renderer (a second
  locale override there is refused) and gets its locale again when its own document commits.

---

## 5. Security model: the local trust decision (D7)

**Owner decision (D6/D7, §2.0, 2026-09-21): the deployment is local and trusted.** Attaching a tab gives
full access to every tab, title, URL and cookie; there is no token, no pairing, no mode, no allowlist,
no cookie scoping and no title withholding. v1's 2026-09-01 decision still applies: work whose purpose
is defending against a malicious local extension, user or process (bridge impersonation, local secret
theft, redaction, encrypted evidence, exact extension-id allowlists) is out of scope unless the
deployment model changes. Do not re-propose it.

What is still refused, and why each costs the owner nothing:

| Refusal | Why it stays |
|---|---|
| The daemon binds `127.0.0.1` only. **Never** `0.0.0.0`. | Prevents an accidental LAN exposure; loopback costs nothing. |
| WebSocket upgrades whose `Origin` is `http(s)://…`, the literal `null` (a sandboxed frame or a `file://` page) or any unknown scheme get 403 — pages on `127.0.0.1`/`localhost` included. Extension origins and a MISSING Origin (shim, runner, desktop) are accepted. | A web page in the person's own browser is not local: without this any site could `new WebSocket('ws://127.0.0.1:8765/g9')` and drive every tab. A page cannot forge its Origin; native clients send none. (A deviation from D7's wording, recorded in ARCHITECTURE_V2 §0.) |
| `/health` CORS header only for extension origins. | A blanket `*` would let any page probe for the daemon and read its home path. |
| A v1 extension is refused (close 4001, "reload the v2 extension"); a v1 bridge on the port is named by pid, never displaced. | Mixed versions fail loudly instead of half-working. |
| Admin ops (halt/resume, settings, schedule, extension install, shutdown) are UI-only. | An agent can never resume a Stop or reconfigure the machine. |
| Malformed/oversized frames (64 MiB cap) close that connection (1009), never the daemon. | A crash inside a socket handler would look like a daemon that never started. |
| `launchBrowser` refuses `--enable-automation` (always), `--remote-debugging-port/-address/-pipe/-io-pipes`, the switches owned by an option, `AutomationControlled` below stealth, and a default user-data-dir (or one inside it, junctions resolved). | Engine 2 has no debugging port anything else could reach; it never identifies as automation; it never touches a person's browser profile (Chrome 136 rule, App-Bound Encryption). |
| A profile signed in to a browser account is refused at stealth and warned otherwise. | Its synced passwords, history and extensions would enter agent runs (§9 v2.0.0 entry). |
| `browser_engine stop` refuses an extension engine, and a launched engine with another agent's tab or another client's `acquire` hold (unless `force`). | G9 never closes the person's browser; one agent does not end another's run silently. |

Supply chain: **zero npm dependencies** in `extension/`, `engine/`, `daemon/`, `mcp/`, `lib/`,
`runner/` (D11); the WebSocket server, client and MCP are hand-written. Only `desktop/` has
dependencies (electron, electron-builder, electron-updater). The installer is **not code-signed**
(no certificate available; SmartScreen warns on first run).

Extension permissions (manifest 3.0.1, `minimum_chrome_version` 125 — flat child sessions):

| Permission | Reason |
|---|---|
| `debugger` | The CDP channel. The core of Engine 1. |
| `tabs`, `activeTab` | Tab list, full titles/URLs, attach, popout. |
| `cookies` | Cookie reads (HttpOnly included) and the handoff export. |
| `storage`, `unlimitedStorage` | State, recordings, issues; attachment bytes in IndexedDB. |
| `alarms` | Service-worker revival heartbeat. |
| `sidePanel` | The control UI. |
| `downloads` | Engine 1 download tracking (EXT-02; `Browser.setDownloadBehavior` is not reachable through `chrome.debugger`). |
| `<all_urls>` | Attaching to arbitrary pages. |

---

## 6. Component reference

Signatures are in ARCHITECTURE_V2 §3–§11; this section says what each module is for and what must
not be broken.

### 6.1 Extension — host and seam

- **`extension/sw.js` — Engine 1's host.** Lifecycle (install/update, the welcome tab once per
  version, heartbeat, auto-attach), the transport to g9d (`call` → `runTool`, halts, `reload` when
  idle, `watch` streams frames and pointer samples), and the panel commands (ARCHITECTURE_V2 §13). It
  reads `dev-daemon.json` (or v1's `dev-bridge.json`) before the first connect — the isolated live
  test's private daemon address. No tool logic lives here any more.
- **`lib/platform.js`, `platform-extension.js`, `platform-cdp.js` — the seam (§4.6).** The extension
  side is thin wrappers over `chrome.*`; its `settings` cache the panel's Input level synchronously
  (D-b semantics, §4.8). `platform-cdp` supports several launched browsers at once: tab handles from
  the daemon, page sessions from browser-level flat auto-attach, the child → tab map updated
  synchronously before any listener runs, held targets (§4.11), `ensureFront`, real window state via
  `Browser.getWindowForTarget`, cookies over `Storage.*` per browser context, downloads over the
  BROWSER session (`Browser.setDownloadBehavior allowAndName`, attribution by frame id; a popup's
  download is attributed to its watched opener with `viaTabId`), and `platform.image` decoded inside a
  hidden utility page of the launched browser (Node has no image decoder and v2 has no dependencies).
- **`lib/cdp.js` — the choke point.** `send()` with the halt check, attach check, per-command
  timeouts (`timeoutFor`; slow commands such as `Page.captureScreenshot` 45 s), named timeout errors
  (a navigation timeout names the server, not "stuck"), the auto-enable set per stealth level, and
  `sendOnLiveSession` for per-frame acks. v1's functions kept their signatures; v2 added exports
  (`timeoutFor`, `COMMAND_TIMEOUT_MS`, `SLOW_COMMANDS`, `NAVIGATION_COMMANDS`, `timeoutMessage`, `asPerson`,
  `attachHeld`, `forgetTab`, `applyStealthLevel`, `runtimeEnabledTabs`), and `sendOnLiveSession` takes a
  `sessionId` (ARCHITECTURE_V2 §4.1b).
- **`lib/state.js`** — state over `platform.storage` (no modes: `currentTabId`, `attachedTabs`,
  `sessions`, `inputMode`, `autoAttach`, `dialogs`, daemon link state, activity), `serialize()`,
  `migrateLegacySettings()` (removes v1 `settings.mode` once), `getAbout/setAbout`.
- **`lib/store.js`** — recordings and issues in `storage.local`, attachment bytes and video frames in
  `platform.blobs` (extension: IndexedDB `g9-attachments` v2, unchanged schema; daemon:
  `G9_HOME/store/blobs`). Writes go through `serialize()`.
- **`lib/transport.js`** (extension only) — one daemon, one port, path `/g9`; `/health` preflight so a
  still-running v1 bridge is never displaced; "connected" means welcomed; stale-socket guard; a refusal
  (`welcome.problem`, 4001) stops retrying until a person presses Reconnect; `instanceId`/`loadId`/tabs
  in the hello (D-c); handoff requests default to 185 s.

### 6.2 Extension — shared libraries

- **`lib/world.js`** — the isolated world `g9` (§4.7): `contextFor`, `inWorld`, `callInWorld`,
  `verifiedContextFor` (an id proven by the guard, for `Runtime.addBinding` by id), `callOnObject`.
- **`lib/humanize.js`** — the dispatcher (§4.3, §4.9): `perform()`, `levelFor()` (D-b), per-tab seeds,
  calibrated profile storage, the hidden-page checks and messages (`HIDDEN_REMEDY`), `MOUSE_PRESSURE`.
- **`lib/pointer.js`** — the pointer position per tab (persisted) and the cursor track (10 000
  samples/tab ring, in memory), in top-level CSS pixels on the `Date.now` clock that frames use.
- **`lib/screencast.js`** — one `Page.startScreencast` per tab shared by consumers (`video:<issueId>`,
  `watch`): the most demanding parameters win; frames are acked before fan-out, except for
  `backpressure:true` consumers (the issue video: ack only after the frame is written, 5 s cap). An
  orphan stream after a worker restart is acked and stopped.
- **`lib/refs.js`, `lib/frames.js`** — refs (§4.2) and cross-origin child sessions: flat auto-attach
  repeated on each child so nested frames are reachable; `browser_inspect frames` includes
  out-of-process frames (a round-2 fix).
- **`lib/locators.js`, `lib/signature.js`, `lib/flowspec.js`, `lib/visual.js`** — recorder identity,
  regression memory and FlowSpec (§8b, §8c); `visual.js` decodes through `platform.image`.

### 6.3 Extension — tools

- **`tools/index.js` — the shared runtime.** The `TOOLS` table and `runTool`: halted → resolve →
  dialog (scoped to the call's own tab) → run → activity log; `isReadOnly` (stricter for
  `console clear`, `network clear`, `diagnose performance reload`); `status({tabId})` reports THAT tab
  (F4); the delivery tag on input errors (§4.3a). The extension and the daemon both call it: an agent
  must never get a different result from the same call on another engine.
- **`tools/events.js`** — the CDP event fan-out moved out of `sw.js`: console/network ingestion,
  recorder bindings, dialogs, screencast frames, world invalidation, per-tab cleanup. Every handler
  reports its own failure and never throws into the event source.
- **`tools/tabs.js`** — target resolution without modes, `listTabs` (full titles/URLs, keyed by
  `tabId`), attach, sessions, `waitForTab`, `popout` (Engine 1: `chrome.windows.create({tabId})`, the
  renderer is kept; waits until the tab lists with its title, then reports `visible` from the page's
  `visibilityState` about 600 ms later. Two callers, two rules since 2.0.3: the side panel's button
  passes `focus:true` and its window comes up in front; an agent's is created unfocused and focus goes
  back to the person's window only if the browser moved it. Default geometry: `popoutGeometry()`),
  `handoffExport` (daemon-only), `realWindowState`.
- **`tools/interact.js`** — click/double/right/hover/type/key/scroll/drag/select/upload at three
  levels, the witness and delivery states, obstruction checks, hidden-page refusal, wheel-based reach.
- **`tools/snapshot.js`** — accessibility tree, pruned (interactive roles always kept, unnamed
  structure dropped, 900 emitted lines); `a11y+text` extracts text in G9's world; a tree with only
  its root while the body has elements is asked for again (a CfT flake mitigation). Every regex escape
  in injected code is doubled (self-test section 17).
- **`tools/navigate.js`** — goto/reload/back/forward/wait with real conditions; at human/stealth a
  post-load human idle (600–1500 ms, `humanIdleMs`). `timeoutMs` is the whole goto's deadline and
  `Page.navigate` gets it (at least 20 s): v2.0 cut `Page.navigate` at a fixed 20 s and called a slow
  server "stuck" (round-3 fix; measured: a 25 s time-to-first-byte now returns after 26 s).
- **`tools/capture.js`** — screenshots; at human/stealth an element is brought in with the wheel and
  clipped inside the viewport (no `captureBeyondViewport` resize, no `scrollIntoView`); full page
  refused at stealth when taller than the viewport, taken with a `pageSaw` note at human; results carry
  `pointer`; a capture over 10 s gets a cause (hidden, background, behind another tab, minimized).
- **`tools/observe.js`** — console/network ring buffers (500 console entries, 400 requests, 512 KB per
  text body, 8 MB of bodies per HAR, 4 000 characters per console entry at write time), cleared before
  every navigation; on quota rejection the buffer keeps its newest quarter and says so. At stealth
  `read` reports that page console capture is unavailable.
- **`tools/inspect.js`** — dom/styles/box/storage/cookies/frames; any domain's cookies, full values
  (a 929-character JWT comes back whole — v2.0 cut values to 77 characters, a round-2 fix).
- **`tools/downloads.js`** — Engine 1 via `chrome.downloads` (attribution `exact`/`probable`/`unknown`,
  file facts = the browser's record, no hash); Engine 2 via the browser session with file facts from
  disk (size, sha256, magic bytes, sniffed type, `source:'disk'`). `verified:false` with the reason
  when nothing could be checked; `watch_downloads` starts a fresh list.
- **`tools/record.js`** — the recorder in world `g9` (script by `worldName`, binding by name and by
  context id), raw input samples for calibration (`input-samples.json`: key classes and timing, never
  text; nothing from password fields), a second start on a recording tab refused, `calibrateFromRecording`.
- **`tools/replay.js`, `tools/qa.js`, `tools/netpin.js`, `tools/netrules.js`, `tools/issues.js`,
  `tools/diagnose.js`, `tools/emulate.js`** — as in §8b/§8c and v1, moved onto the seam. Replay passes
  `humanize`/`seed` and waits (500 ms quiet, 2 s cap) for late evidence after the last step
  (`settledAfterLastStep`); `awaitQuiet` starts the quiet window only once a poll has seen no request
  in flight (2.0.2). Issue video is a screencast consumer and stores `pointer-track.json`
  (`g9-pointer/1`). `diagnose health` caps findings per severity (30/20/10); `performance` returns
  aggregates only.

### 6.4 `extension/humanize/` — the pure library

`prng.js` (mulberry32 + normal/log-normal), `profiles.js` (built-in `off`/`human`/`stealth`),
`profile.js` (resolve/validate; `off` is the only direct level), `plan.js` (pointer start, target point
sampling, `sequence`, `planGap`), `mouse.js` (Bézier path, Fitts duration, minimum-jerk, overshoot and
correction, jittered sampling, tremor, clicks, drags), `wheel.js` (100 px notches in bursts, drift,
optional overshoot), `keys.js` (US QWERTY key definitions, shifted characters, chords, `location`,
typos from an adjacency table), `calibrate.js` (`fitProfile` from v1 raw events or the v2 recorder's
samples), `index.js` (re-exports). Planners throw a `RangeError` for an off-screen target ("scroll it
into view first"). Model limits are in §8.

### 6.5 `engine/` — Engine 2

- **`find.js`** — installed Edge/Chrome/CfT and their versions, read from the executable's PE version
  resource (a staged update makes directories and manifests lie); `g9Home()`; the default-profile
  guard (realpath, junctions).
- **`cft.js`** — Chrome for Testing: pinned in `versions.json` (153.0.8010.52, sha256 trust-on-first-use
  cross-checked with Google's MD5), downloaded with Range resume and an IPv4/IPv6 retry
  (`storage.googleapis.com` answered HTTP 403 over IPv4 from this location; `HTTPS_PROXY` honoured),
  extracted with `tar -xf` (pure-JS zip reader fallback, byte-identical on the real 205 MB zip),
  installed atomically under a cross-process lock, one line per event in `engine-versions.log`.
- **`launch.js`** — `launchBrowser`/`buildArgs`: the designed switch list plus the recorded deviations
  (`msImplicitSignin` in `--disable-features`, `--disable-sync`, `--disable-component-update` omitted
  at stealth and for warm, `--disable-frame-rate-limit` for CfT only, headless `--screen-info` with a
  48 px taskbar and a maximized-size window), `--disable-features`/`--enable-features`/
  `--disable-blink-features` merged into one switch each, the refusals of §5, argv recorded, a
  profile already in use refused, `close()` → `{exit, killed, leftovers, profileRemoved, gracefulMs,
  closeMs}`: `Browser.close`, up to `GRACEFUL_EXIT_MS` (30 s, sized from a measurement in 2.0.2) for a
  clean exit, then a process-tree kill and sweep; `exit` is never null once the process is gone
  (`{code:null, signal:null, gone:true}` when its exit event is late). `engine/README.md` explains
  every switch.
- **`pipe-cdp.js`** — CDP over fd 3/4: NUL-framed JSON decoded from raw Buffers (split UTF-8 and 24 MB
  replies in 64 KB chunks are tested), ids, `sessionId` routing, 20 s default timeout with the
  `SLOW_COMMANDS` table, every pending call failed at once by name when the browser exits.
- **`profile.js`** — `G9_HOME/profiles/<name>/` + `<name>.json`; preferences merged only while no
  browser uses the profile; `warm()` (a headed window for a one-time login); `signInState()` (booleans
  only); `clearSessionRestore()` (CfT reopened the previous session's tabs on every relaunch).
- **`stealth.js`** — levels, `autoEnableDomains`, `launchArgsFor` (D-a), `launchWarnings`,
  `checkConsistency` (locale/timezone/Accept-Language).
- **`firewall.js`** — Chrome for Testing has no Windows Firewall rule of its own, so the first launch
  from each new executable path carries a warning that Windows may ask and that either answer is fine
  (G9 uses a pipe, not a port); the paths already seen are kept in `G9_HOME/engines/firewall-seen.json`.
- **`manager.js` — `EngineManager`, owned by the daemon.** Configures `platform-cdp` (handles, file
  storage and blobs, the downloads `fileInfo` hook, broadcasts), wires `tools/events.js` as `sw.js`
  does, imports every shared module lazily (a broken Engine 2 must not stop the daemon serving the
  extension). Launch: sign-in check, persona (locale → profile languages, timezone), session-restore
  cleared, the downloads-hub preference, one launch per profile at a time (`reuse`), stray start-up
  pages closed and reported (`closedAtLaunch`), a headed window fitted to its screen's work area (size
  only, never moved or activated). `#prepareTab`/`#prepareChild` (§4.11), contexts, tabs, the
  parallelism gate, evidence runs for replays (`result.json` keeps warnings, steps, surprise count),
  handoff import, `warm`, versions. `watch(tabId, on, consumerId)` runs the changes for one (tab,
  consumer) through a chain of its own, in the order they were asked for, so the last request wins for
  the whole watch: map, pointer subscription, watchdog and screencast (2.0.2).

### 6.6 `daemon/` — g9d

- **`g9d.mjs`** — the CLI (`--port`, `--home`, `--foreground`); a port held by another g9d exits 0
  (two shims raced), held by anything else logs the holder and exits 1; a home another live g9d
  already serves (`home-lock.js`, `G9_HOME/daemon.lock`) exits 0, naming that daemon's port
  (DAEMON_PROTOCOL §8).
- **`daemon.js`** — composition: WsServer → Registry → Router → extension relay | EngineManager;
  admin ops; `daemon.json`; idle exit; the log (`G9_HOME/logs/daemon.log`, rotated at 5 MB). The
  `watch` admin op answers `{watching:false, tabId, problem}` when a launched engine's stream did not
  start, and `{watching:false, tabId}` when an unwatch overtook the start; the watcher and its run are
  undone first (2.0.2).
- **`ws-server.js`** — hand-written RFC 6455 (codec in `lib/ws-codec.mjs`), many clients, the Origin
  rule (§5), inline ping answers, `/health`.
- **`registry.js`** — clients, engines, handles, ownership, sessions, per-tab queues, halts, parked
  extension engines (D-c). No I/O, unit-tested without sockets.
- **`router.js`** — every call: halt → target → ownership → queue → relay (ids rewritten) or Engine 2;
  what the daemon answers itself (`browser_status` overlay, `browser_engine`, `browser_tabs`
  list/open/claim/release/popout/handoff/sessions, store-level recording/issue actions across both
  stores); per-tool timeouts (`G9_TIMEOUT_MS`, default 120 s, as a floor raised per tool — replay 30
  min, handoff 3 min, …; DAEMON_PROTOCOL §3); `deliveryFields`.
- **`handoff.js`** — cookie conversion (Chrome → CDP shapes; expired skipped), the one-shot storage
  seed script (world `g9`, top frame of that origin only), `NOT_TRANSFERRED` (in-memory state,
  IndexedDB, service workers). The result's `storageCheck` counts what actually holds after load.
- **`storage.js`** — `chrome.storage` semantics exactly (file-backed `local` written atomically and
  coalesced; in-memory `session`) and `FileBlobs`.
- **`evidence.js`** — `runs/<runId>/` (`engine.json`, `frames/`, `frames.jsonl`, `pointer.jsonl`,
  `downloads.jsonl`, `result.json`), caps from `settings.evidence` (counted, not written, beyond them),
  and `fileInfo` (size, sha256, magic bytes, sniffed mime) for downloads. `prune()` keeps the newest
  `keepRuns` run folders and never touches an active one; its passes run one at a time through a
  chain, and the delete retries Windows' EPERM/EBUSY (2.0.2).
- **`scheduler.js`** — entries in `settings.schedule` (daily or every N minutes); a due entry runs the
  runner as a child with the daemon's own `process.execPath` (under the desktop: G9.exe as Node);
  accepts the runner's and the desktop's entry shapes. Enabled entries hold off idle exit.
- **`settings.js`** — `G9_HOME/settings.json`: port, defaultBrowser, headless, humanize, stealth,
  maxParallel (8), evidence caps, idleExitMinutes (60), updateUrl (`https://`, or `http://` only on
  localhost/127.0.0.1/::1; `file://` refused),
  updateChannel (stable|beta), schedule. Unknown keys kept; bad values refused by name.
- **`paths.js`, `project.js`, `flows.js`, `extension-update.js`** — the home rule; the project adapter
  (`g9.project.json`, `workspaceDomains` ignored in v2); the FlowSpec library on disk; the desktop's
  extension updater (copy to `extension.new`, swap, `{type:'reload'}` when no relayed call is in
  flight — the folder path, and so the unpacked extension id, never changes).

### 6.7 `mcp/`, `lib/`, `bridge/`

- **`mcp/shim.mjs`** — connects to `ws://127.0.0.1:${G9_PORT||8765}/g9`; on `ECONNREFUSED` spawns
  `daemon/g9d.mjs` detached and hidden and retries for 8 s; a non-g9d `/health` (a v1 bridge) makes
  every tool fail naming its pid and the fix while MCP itself keeps working; a dropped daemon fails the
  calls in flight and the next call reconnects. Resources `g9://guide`, `g9://status`. stdout is MCP
  only; diagnostics go to stderr.
- **`mcp/mcp.js`** — hand-written MCP (`initialize`, `ping`, `tools/*`, `resources/*`; protocol
  versions 2025-06-18, 2025-03-26, 2024-11-05); tool failures are `isError:true` results, never
  JSON-RPC errors; `dataBase64` results become image blocks; remembers `clientInfo.name`.
- **`mcp/tools.js`** — the 15 schemas and `INSTRUCTIONS` (loaded into the agent's context by
  `initialize`). Every sentence must describe behaviour that exists (EXT-17).
- **`lib/version.mjs`** — the one version, read from `package.json`; `setup/unit/version.test.mjs`
  fails when the manifest or `desktop/package.json` disagree. **`lib/ws-client.mjs`** — the shim's
  WebSocket (not Node's global one: under `ELECTRON_RUN_AS_NODE` the Node is Electron's, and a native
  client must send no Origin). **`lib/ws-codec.mjs`** — the shared frame codec, 64 MiB cap.
- **`bridge/src/server.js`** — prints a note to stderr and imports `mcp/shim.mjs`, so MCP configs
  written by v1's `install.ps1` keep working (self-test section 14).

### 6.8 `runner/`

`g9.mjs`: `list`, `run <flowId|suite:<name>|tag:<name>|all>`, `calibrate`, `approve`, `spec`, `ab`.
Default `--engine launched` (headless, own profile, flows imported from the repository's FlowSpec
library into the launched store); `--engine extension` runs on the person's browser's current tab.
`--browser`, `--headed/--headless`, `--profile`, `--humanize`, `--humanize-seed`, `--stealth`,
`--keep-engine`, `--port`, plus v1's run options (`--env`, `--data`, `--report`, `--timing`,
`--signature`, `--pin`, `--strict-pin`, `--seed`, `--no-compare`, `--project`, `--platform agripad`,
`--fail-on`). Exit codes: 0 pass (warnings allowed), 1 product failure, 2 automation failure, 3
confirmed surprise, 4 could not run. `report.mjs` writes `run.json`, `junit.xml`, `report.html`,
`qa-automation-status.json`; the report records every humanize seed. `mcp-client.mjs` spawns the shim.

### 6.9 `desktop/` — the Electron shell

`main.mjs` (single-instance lock, tray, one `ui` connection to g9d, starting the daemon detached when
nothing listens, IPC allowlist, updater, wizard side effects; flags `--smoke [--launch]`, `--hidden`,
`--check-render <dir>` which renders every view off-screen at −32000,−32000 without activation),
`preload.cjs`, `renderer/` (views: agents, engines, watch, runs, approvals, schedule, settings, setup;
Watch draws frames on a canvas with the cursor from the pointer track, says "not live" for a hidden
tab, and shows the daemon's `problem` when a watch did not start), `lib/` (daemon-client with per-call
timeouts mirroring DAEMON_PROTOCOL §3 — a copy, checked by
`daemon.test.mjs`; daemon-launch; extension-install; mcp-register for Claude Code, Cursor, VS Code and
Claude Desktop, backing up first and never overwriting a `g9-browser` entry silently; policies — HKCU
`WindowOcclusionEnabled=0`, `HighEfficiencyModeEnabled=0`, `IntensiveWakeUpThrottlingEnabled=0`,
`BackgroundTabFreezingEnabled=0`, `DeveloperToolsAvailability=1`, recorded first for Undo, one UAC
prompt when HKCU\Software\Policies is not user-writable; updater — electron-updater generic feed from
the daemon's `updateUrl`/`updateChannel`, restarting the daemon only when no run is active and no
launched engine is open; wizard). Packaging: `electron-builder.yml` (NSIS, per-user,
`asInvoker`), `scripts/build-win.mjs`. Versions installed: electron 44.4.3, electron-builder 26.15.3,
electron-updater 6.8.9. Pages under test are never loaded here.

---

### 6.10 `extension/panel/` — the side panel (v3)

The panel is a client of the same service-worker commands an agent's calls end in (ARCHITECTURE_V2
§13): a QA and an agent must never get different results from one button. v3 (decisions U1–U10, below) changed
what it shows, not what the engine does.

- **No Attach button.** The daemon pins each agent's tab on its first call (`daemon/router.js`
  `#defaultTab` → `registry.setCurrent`), so the v1 button's job no longer exists. What was left —
  starting console/network capture before the agent's first action — is **Record from now**
  (`recordNow`: `attachTab` with `clearHalt`, optionally a reload, ONE activity line). The card
  reads `attachedSince` to say "Recording … since HH:MM".
- **Auto-attach is three-state** (`autoAttach: 'off'|'project'|'all'`, fresh installs `'project'`; a
  stored boolean migrates once, `true→'all'`, `false→'off'`, preserving existing installs' choice).
  *Project sites* matches tabs against `projectDomains`, the union of connected agents' project
  environment hosts the daemon pushes as `{type:'projects'}`. It is a CAPTURE filter only: it never
  detaches a tab attached by hand or by an agent and never refuses access (D6/D7). *All tabs* is not
  the default because it shares one 10 MB `storage.session` quota across every site browsed, enables
  `Runtime` everywhere (a debugger any site can detect), and keeps every tab out of Memory Saver.
  `browser_status.autoAttach` stays a boolean for agent code; the string is `autoAttachMode`.
- **Agents are told apart.** `#agentsFor` rows carry `project`, `cwd`, `current` (this browser's
  Chrome tab id) and `currentEngine` (`extension`/`launched`/`elsewhere`/null); the tab chip calls
  `focusTab`, the person's own gesture, allowed while Stop is on. The daemon line no longer shows a
  project name: it was the folder of whichever session started the daemon.
- **Popout/handoff in the moment of need.** A relayed call refused because its tab is hidden records
  `blocked[tabId]` and broadcasts `agentBlocked`; the panel shows an alert above the tabs with Pop
  out / Send to background / Dismiss. It clears on `agentUnblocked` (tab closed, focused, popped out,
  handed off, a later delivered call, or the agent gone).
- **Automation** groups by site (origin of `startUrl`, with a "No start URL" bucket) then suite; the
  filter row (site, suite, tag, verdict, flaky, search) is built from values already in the index and
  persists in `localStorage` (wrapped in try/catch); "Run N flows in <scope>" runs only the filtered
  set. The drawer keeps every per-flow action and edits section, suite, tags, covered test cases and
  start URL (`qa.updateRecording` validates http(s); `qaTestCaseIds` was silently dropped before v3).
- **Issues** group by site then status; the issue index now carries `site`, `severity`, `tags` and an
  `evidence` summary, backfilled once and serialized for issues saved before v3.
- **Rendering rule:** the panel shows strings from arbitrary pages (titles, URLs, flow and issue names,
  agent names). Build DOM with `createElement`/`textContent` only; `innerHTML` is allowed solely to
  clear (`''`) or with a static literal, and `panel.test.mjs` scans for it. Links validate http(s)
  and carry `rel="noopener noreferrer"`.
- **Looking at it:** `node setup/panel-render.mjs --out <dir>` serves the panel with a stubbed `chrome`
  and realistic fixtures (hostile titles included), screenshots every tab at 360 and 1000 px in light
  and dark, and fails on any page exception, console error or horizontal overflow at 360 px.

**The decisions behind v3 (U1–U10, approved by the owner on 2026-09-25).** Every item had to be
justified by observed behaviour — a measured cost, a reported confusion, or a code path that makes a
control redundant — never by taste. Non-goals: no UI framework, no build step, no telemetry, no change to
tool semantics, to the daemon's ownership or halt model, or to the desktop app.

| # | Decision | Evidence | As built, where it differs |
|---|---|---|---|
| U1 | The big **Attach current tab** button goes; a small **Record from now** control replaces it | The daemon pins each agent's tab on its first call and consults the extension's current tab only when the agent has none, so the button's v1 job was gone; only early console/network capture remained | A new `recordNow` panel command does attach and the optional reload, so the activity log shows one entry |
| U2 | **Auto-attach** becomes three-state: Off / **Project sites (default)** / All tabs | All-tabs capture shares one 10 MB `storage.session` quota (`observe.js` MAX_CONSOLE/MAX_NETWORK and the quota-drop path), enables `Runtime` on every site (detected 12/12 in v2 stealth runs), exempts every tab from Memory Saver, and keeps the debugger bar up | `browser_status.autoAttach` stays a boolean (an agent testing `if (status.autoAttach)` would read `'off'` as true); the mode is `autoAttachMode`. Project sites is the default for a new install only; a stored v2 value maps on → All tabs, off → Off. Project domains are the hosts of the `environments` URLs in each connected agent's `g9.project.json` (a project file has no separate domain list) |
| U3 | Pop out / Send to background stay, but are offered in the moment of need (an alert when an agent's tab is hidden) and otherwise folded into one group | The two buttons exist to prevent one failure, `[delivery: not-delivered; tab hidden]`; they demanded foresight and carried four lines of copy each | As decided (`agentBlocked` / `agentUnblocked`, above) |
| U4 | The **Agents** list shows who each agent is (project folder) and which tab it is on (a chip that focuses it); the daemon line drops the misleading project name | `daemon/daemon.js #agentsFor` sent only `owned`, so three agents rendered as identical rows; the daemon line showed the project of whichever session started the daemon | `currentEngine` also takes `'elsewhere'` (a tab in another browser's extension), shown as "working in another browser" rather than a wrong "no tab yet"; a launched-engine agent shows "working in a launched browser" with no title or URL |
| U5 | The current tab's URL shows the origin plus a truncated path, never many wrapped lines | A real-use screenshot: a signed URL filled a third of the panel | As decided (`extension/lib/sites.js`) |
| U6 | **Automation** is organised site → suite → flow, with filters and a per-flow drawer | The store index already carried `startUrl`, `suite`, `folder`, `tags`, `lastRun`, `flaky`, `assertionCount`, `environment`; the list rendered flat and used none of it | `recUpdate` also accepts `startUrl` (http(s) only) and `qaTestCaseIds`, and the drawer has a Start URL field (the ids the panel sent were being dropped, and nothing could give an old flow a start URL). Verdict labels are short ("Product fail", "Test fail", "Surprise", "Warnings") to fit one row at 360 px |
| U7 | **Issues** are organised by site and status, with severity and tags shown and filterable | The issue index carried only id, title, url, status, filedAs and dates; severity and tags lived in the record, so the list could not show or filter them | The index also carries `site` and an `evidence` summary, backfilled once for issues saved before v3 |
| U8 | One visual system: tokens, components, density, accessibility — still zero-dependency vanilla JS/CSS | `panel.css` defined tokens but applied them unevenly, and helper prose was always expanded | The dark theme's accent is `#9d97f5`, for a contrast of at least 4.5:1 on the dark card |
| U9 | The icon is replaced with one generated elsewhere from a prompt; G9's work is wiring only | Owner decision | Built in 3.0.1 from the owner's artwork (`setup/make-icons.ps1`, §9). At 16 px the whole drawing is a blur, so that size is a crop of the browser window with "G9" — a deviation from "one design at every size" that the toolbar at 100 % scaling needs |
| U10 | The panel stays a client of the same commands agents use | Existing repo rule: a QA and an agent must never get different results from one button | As decided |

The icon prompt (U9) asked for a toolbar icon for "G9 Browser Agent" that reads at 16 px and looks
good at 128 px: automation meeting a real browser (a cursor with a browser or tab shape, a stylised
"G9", or a pointer that doubles as a play or test glyph), no robot face and no gears; flat, geometric,
two or three colours with deep indigo or violet (around `#4f46e5`) as the primary, on a transparent
background; PNG at 16, 48 and 128 px plus a 512 px master, correct on light and dark toolbars.

## 7. Testing

Every harness uses a fresh temp `G9_HOME`, temp browser profiles and random ports in 18000–18999,
never port 8765 (the owner's v1 bridge lives there), and ends with a leftover-process and temp-dir
check. Headed windows, where a harness uses them at all, are created at −32000,−32000 without
activation. Unset `ELECTRON_RUN_AS_NODE` in the shell before running (`env -u ELECTRON_RUN_AS_NODE …`):
some agent hosts export it, and it turns `npx electron` into Node.

### 7.0 Choosing what to run (since 3.0.1)

Run what the change needs, not everything. Measured on the owner's machine on 2026-09-25 (20
threads):

| Tier | Command | Time | When |
|---|---|---|---|
| What changed | `npm run check` (`node setup/check.mjs`) | a docs edit ~0.2 s; a panel change ~20 s; a shared-module change up to ~2.5 min | after every change, while working |
| Every offline check | `npm run check:all` | **142 s** (4 at a time; the same checks one after another take ~300 s: unit 240 s, of which interaction 141 s, self-test 10 s, extension suite 30 s, panel render 15 s) | before handing over a change that touched several areas |
| Live suites | `node setup/check.mjs --live`, or `npm run test:engine2` (~5.5 min) / `npm run test:live` (~3.5 min) | ~9 min together | when `check` names them: input, perception, launching, the seam, the suites' own pages. Before a release |
| Release | `npm run check:release`, then `cd desktop && npm run build:win && npm run test:packaged` | ~12 min, plus the build | a build the owner will install, or a change in `desktop/` |
| Measurement | `stealthtest`, `matrix`, `bench`, `endurance` | minutes to hours | only when the change is about what they measure |

How `check.mjs` decides (`setup/check-plan.mjs`): a check runs when a changed file is among the files
it imports, followed transitively, plus file names in its string literals (tests load modules
through helpers such as `extUrl('tools/interact.js')`), plus the globs it reads or spawns, listed by
hand (`reads`: the seam suite's source scan, the panel suite's text reads, the self-test's spawned
daemon). This over-approximates, which only runs a check too many. A changed file no check
reaches runs **every** offline check. Files nothing automated covers (PowerShell, the measurement
harnesses, templates) are named in `NO_CHECK` with the reason, and the run says so. Markdown counts only
for the checks that read it: the link check (`setup/doclinks.mjs`), and the panel suite for
ARCHITECTURE_V2.md. `setup/unit/check.test.mjs` keeps this honest. It fails when a unit suite has no
check, and when a tracked file is reached by nothing and not named in NO_CHECK (or FULL_RUN, the unit
runner). While checks run, a line every 15 s names each running check, its time and its PASS count,
and flags one silent for 90 s, so a slow check and a stuck one look different. `unittest.mjs` prints
the same kind of line for a suite running past 15 s.

Why this exists: the v3 task took about 5 hours. About 37 minutes of that was tests; the rest was
sub-agents writing the change. For a small change, though, the full battery was the whole wait:
about 4 min of unit suites, 9 min of live suites and an installer build, for a README edit or an
icon. The interaction suite is slow on purpose: its tests wait on real, human-paced timers and
real deadlines (the slowest, a slow server against `goto`'s deadline, takes 21 s). Faking the clock
would test less, so it runs in parallel with the rest instead.

| Command | What it covers | Latest recorded (marked 3.0.0: 2026-09-25, on the 3.0.0 tree; marked 2.0.2: 2026-09-24; the rest 2026-09-23, on 2.0.1 — the final pass) |
|---|---|---|
| `node setup/unittest.mjs` | every `setup/unit/*.test.mjs` in its own process (suites stub `chrome` before importing, and `platform.js` chooses at load). `G9_UNIT_NO_BROWSER=1` skips the `live:` tests; a filter argument runs matching files only. | **651 passed, 12 suites** (3.0.1, 2026-09-25, three runs through `check.mjs --all`; 638 in 11 on 3.0.0; 620 three times in a row on 2.0.2). One after another: 240 s, interaction 141 s of it |
| · `daemon.test.mjs` | registry, router, handles/rewrites, ownership, queues, halts, D-c parking, settings, scheduler, storage, evidence, handoff helpers, the desktop timeout table cross-check, launched-engine watch ordering; (v3) environmentHosts/projectLabel, the `{type:"projects"}` push (after each welcome, coalesced on agent connect/disconnect), agent rows with project and current tab | 100 (3.0.0; 97 on 2.0.3) |
| · `desktop.test.mjs` | runs `desktop/test/run.mjs` without `ELECTRON_RUN_AS_NODE`; SKIPs when `desktop/node_modules` is absent | 181 |
| · `engine.test.mjs` | pipe framing, launch args and refusals, CfT zip/lock/versions, profiles, find; `live:` Edge, system Chrome and cached CfT headless (D-a webdriver per level, the headless screen with its taskbar) | 56 |
| · `humanize.test.mjs` | determinism, bounds over 2000 random plans, every planner, calibration round trip | 51 |
| · `interaction.test.mjs` | the witness expression in `node:vm`, delivery states, re-timing, hidden checks, dispatcher timing (80 % rule), levels | 77 |
| · `panel.test.mjs` | panel/welcome source checks, every §13 command, transport with fake socket/fetch/clock; (v3) no Attach button and Record from now, the three auto-attach settings, the blocked toast above the tab bar and agent rows, the no-HTML-from-strings scan (and http(s)-only links with `noopener noreferrer`), the pure helpers (flow filter and run scope, issue filter, evidence chips, `NO_SUITE`/`NO_SITE`), a lost daemon link forgetting project sites and blocked alerts | 82 (3.0.0; 75 on 2.0.3) |
| · `platform-cdp.test.mjs` | registration, sessions, held targets, F1, tabs, cookies, downloads attribution; `live:` headless Edge | 34 |
| · `seam.test.mjs` | R2 source scan, no top-level await, Node smoke through platform-cdp, `sw.js` boot and its panel and daemon commands over a stubbed `chrome` — since 2.0.3 also the popout's two callers (the panel's window focused and not buried, an agent's unfocused) and its default geometry; since 3.0.0 the auto-attach modes and their migration, Project sites attaching only project tabs, `focusTab` under Stop, `recordNow`, `attachedSince`, and the blocked-agent bookkeeping (set only by a relayed hidden refusal; cleared when shown, reached, popped out, disconnected or closed) | 16 (3.0.0: the v3 checks sit inside the existing tests) |
| · `world.test.mjs` | isolated world guard and invalidation over a vm-based fake browser | 26 |
| · `version.test.mjs` | one version in package.json, manifest, desktop, `lib/version.mjs` — compared, never pinned | 8 (3.0.0; 7 on 2.0.1) |
| · `check.test.mjs` | (3.0.1) `setup/check-plan.mjs` and `setup/doclinks.mjs` on the real repository: globs, the import graph through test helpers, docs-only / panel / input / unknown / NO_CHECK / live-only changes, `--all`, every unit suite has a check, every tracked file is reached or named, the estimate, GitHub slugs and broken links, `check.mjs --plan` running nothing | 13 (3.0.1) |
| · `sites.test.mjs` | (v3) `extension/lib/sites.js`: siteOf (origin, none for opaque), parseDomain, hostMatches (exact host or subdomain, port rules, http(s) only), displayUrl, and a purity scan (rule R2) | 7 (3.0.0) |
| `node setup/selftest.mjs` | a real daemon, two real shims (two agents), a fake extension over a real WebSocket: /health, Origin rule and version refusal, status composition, relay and id rewriting, ownership, queues, Stop from panel and desktop, extension requests/watch/update, dialogs, delivery tags, disconnects, D-c reconnect, protocol robustness, the v1 forwarder, shim auto-start, a v1 bridge named, idle exit, escaping in injected code | **136/136** (3.0.0) |
| `node setup/extensiontest.mjs` | extension modules through the real seam over an asynchronous `chrome` stub with a tab/window model; recording, replay, network, downloads, video (write-chain deadlock as behaviour), tab resolution, legacy cleanup, flow library, `/health` CORS, one daemon port, version skew, runner selection; fixture `setup/fixtures/tasks-browse-and-open.flow.json` (EXT-16); (v3) the issue index's severity/tags/site/evidence following the attachments, the one-time serialized completion of a pre-v3 index, `recUpdate` storing TC ids and only an http(s) start URL, an environment indexed only as a name | **82/82** (3.0.0; 78 on 2.0.2) |
| `cd desktop && node test/run.mjs` / `node test/daemon-contract.mjs` / `npm run build:win` + `npm run test:packaged` / `npm run test:render` | renderer in a fake DOM, main process against a fake Electron API, updater/policies/registration with fakes (never the real registry or configs); the real daemon's admin contract; the built `win-unpacked` with no `node` on PATH (shim starts the packaged daemon); the real window off-screen | **14/14 files (3.0.0; 22.6 s on 2.0.1); contract 15/15 (2.0.1); build OK (`G9-Setup-3.0.0.exe`, 103,620,667 bytes, 2026-09-25, unsigned, `resources/app-update.yml` present, payload identical to the repository); packaged 7/7 (3.0.0); render check PASS (2.0.1)** — 4 scenarios (empty and populated × dark and light), 23 pictures per populated run, 171 window samples in the last one, 0 ever on screen, 0 ever in the foreground |
| `node setup/engine2-livetest.mjs [--only …]` | Engine 2 through the product path (daemon + shims + headless Edge), every check against what the page, server or disk saw: tabs, snapshot, interact at three levels, frames, console, inspect, screenshots, emulate, dialogs, downloads (sha256), popups, HAR, recording/replay, video, agents/ownership, reads during actions, slots, 4 parallel contexts, watch, halt, handoff (fake Engine 1 payload), stealth, locale persona, downloads hub, stop | **366 passed, 0 failed** (3.0.0: 327 s; 2.0.3: 322 s; 2.0.2: 325 s; on 2.0.1: 330 s) |
| `node setup/isolated-livetest.mjs` | Engine 1 in a real headless browser: private daemon, temp profile, extension copy with `dev-daemon.json` and a tripwire in place of its built-in default port; runs `setup/livetest.mjs` (27 sections: tabs, snapshot, levels, hidden tabs, witness, scroll settle, stealth screenshots, recording, regression memory, issue video, watch, cross-origin frame, popout, handoff, auto-attach in its three settings, version/welcome, Stop, main-world diff) and renders the panel. `G9_BROWSER` picks Chrome/CfT; `G9_LIVE_SECTIONS` narrows | **198 passed, 0 failed** on Edge 153.0.4234.32 (3.0.0, daemon, extension and shim all reporting 3.0.0; 196 on 2.0.2 and 2.0.3) **and 196 passed, 0 failed on system Chrome 153.0.8010.53** (2.0.1, `G9_BROWSER=chrome`), each with the harness checks (tripwire 0 hits, profile never signed in); CfT sections 12+16 ×20: 20/20 (earlier round) |
| `node setup/stealthtest.mjs [--matrix] [--local-only] [--configs …] [--repeat N]` | the pre-suite gate ([docs/STEALTH.md](docs/STEALTH.md), "Running the self-test"): local detector page (webdriver, Runtime probe, main-world globals/nodes/calls, listener stacks, untrusted events, cross-site frame, popup, worker, read-tool sweep, press/typing/wheel timing, screen, locale, EME, tabs at end, profile sign-in) + public pages (`stealth-pages.json`); human-level controls must be detected | 2026-09-23, both runs: **0 G9 leaks in every stealth configuration**, both human controls detected. Local page, final tree, 7 configurations: **edge-headed-stealth UNDETECTED**; the rest detected only by browser-inherent signals (the HeadlessChrome UA; CfT's missing Widevine). With the public pages (one full matrix): headed Edge stealth flagged by pixelscan alone (“Automated behavior detected”) and passed by sannysoft, creepjs, browserscan, fingerprint-bot-detection and rebrowser; headed CfT stealth flagged by rebrowser (its brand) alone; every headless stealth run flagged by sannysoft, creepjs, browserscan, pixelscan and fingerprint-bot-detection. Exit 1 by design while headless is detectable |
| `node setup/matrix.mjs` | P8 background-state matrix, Engine 1 (real extension) and Engine 2, per state: does input/screenshot/screencast reach the page, and does G9's report agree | **exit 0, every cell agrees** (2026-09-23, the full default set: Engine 1 × Edge and Chrome × active/background/minimized/offscreen/hidemid/hidemidheaded, with and without the occlusion switch, and Engine 2 × active/background/popup/minimized/offscreen). The partial-delivery cells report themselves as partial and match the page |
| `node setup/bench.mjs` / `node setup/endurance.mjs --minutes N` | parallelism (1–24 contexts, CPU/RAM per process tree, per-step latency, maxParallel rule) / the flow in a loop with memory and listener sampling after `gc()` | **2026-09-23: 0 failures at every level.** Bench 1/4/8/16 contexts × 5 iterations, flow p50/p95 11,599/12,211 → 12,668/14,233 ms, recommendation maxParallel 8; endurance 10 min, 93 iterations, 0 failures, daemon +0.39 MB/min, browser +1.79 MB/min, listeners flat. Full tables in §9 2.0.1 |
| `node setup/panel-render.mjs --out <dir>` | (v3) a dev harness, not a suite: the panel served over local http with a stubbed `chrome` and realistic fixtures (three agents in two projects, flows on three sites, issues with evidence, a blocked agent, a malformed stored flow, markup in titles), rendered by headless Edge at 360 and 1000 px, light and dark. Fails on a page error, console error, dialog, horizontal overflow at 360 px, fixture text turned into markup, `[object Object]` or `NaN` on screen, the toast not leaving on `agentUnblocked`, the malformed flow not opening, or ArrowLeft switching Auto-attach | **PASS, 26 pictures** (3.0.0) |
| `node setup/check.mjs [--all] [--live] [--release] [--plan] [--since ref] [--files …]` | (3.0.1) runs the checks above that the changed files reach, 4 at a time, longest first; live suites one at a time after them and only when asked; progress every 15 s; full output in a temp log (§7.0) | `--all`: **16/16 checks in 142 s**, three runs (3.0.1) |
| `node setup/doclinks.mjs [files]` | (3.0.1) every relative link and `#anchor` in the Markdown files git knows, with GitHub slugs | 14 files, 0 broken (3.0.1) |
| `node setup/livetest.mjs` by hand | against your own daemon and browser (`G9_PORT=…`); without the `G9_LIVE_*` variables the browser-level checks SKIP | — |

`setup/testpage.html` + `serve.mjs` keep v1's deliberate defects (2 load-time console errors + an
uncaught `ReferenceError`, a 404, a broken image, an unlabelled password input, 2400 px overflow, a
duplicate `id`, a transparent overlay over a button, a login form `admin`/`g9secret`) and `/hang`,
`/slow?ms=`; v2 added a runaway button, a pointerdown-cancelling page, popups, cross-origin frames
(`crossframe.html`) and the stealth page (`fixtures/stealth-local.html`).

> **The tool-count assertion (`=== 15`) will fail when you add a tool.** That is intentional — it forces
> this file and the README to be updated too.

> **Run the live suites before shipping anything that touches perception, input, launching or the
> seam.** Every v2 live round found defects the unit suites could not see (§9 v2.0.0): the popup wedge,
> the sign-in, the witness timing and the CfT frame rate were all invisible to a source read.

---

## 8. Known gaps and deliberate omissions

Re-audited 2026-09-22 against the live measurements and the fixers' open lists. Nothing here is fixed
by being written down.

### 8.1 Detectability (stealth)

| Gap | Evidence | Status |
|---|---|---|
| Headless is detected by its user agent (`HeadlessChrome` in the UA and `userAgentData`) | every headless stealth run; public pages round 3: sannysoft (User Agent (Old), HEADCHR_UA, CHR_MEMORY), creepjs headless 67 %, browserscan "Robot", pixelscan, Fingerprint bot 3/3 | inherent; G9 does not spoof the UA (consistency beats spoofing). Use headed stealth for strict cases |
| Headed Edge stealth: pixelscan "Automated behavior detected" | round 3: 4/4 via the harness (with and without interaction); headed Chrome passes 2/2; no field attributable | unexplained. The final local self-test is UNDETECTED; public pages were not re-run after the round-3 fixes |
| Brand checks: rebrowser flags Edge ("no Google Chrome brand", a warning) and CfT ("Chrome for Testing") | round 3 | inherent to the binary |
| `outerWidth/outerHeight` 0×0 at the load event (a CDP-class signal) | live round 2: Edge headless stealth 8/8, headed 5/8, CfT headless 0/8; live round 3: 0/54 local runs | launch warning and STEALTH.md still mention it; not attributable to G9 code |
| Engine 1 debugger infobar: shorter viewport, two `resize` events per load in every tab | §2.4 | only a policy install (`ExtensionInstallForcelist`) or `--silent-debugger-extension-api` removes it; Engine 1 does "input rules only" at stealth; the panel's Stealth option says so |
| Human-level full-page screenshots resize the viewport (a transient 1×1 the page can see) | live round 3: in 14/14 stealth-suite human controls, and 1/8 Engine 2 suite runs | deliberate at human (default level); disclosed in `pageSaw`; refused at stealth |
| Context locale in another language than its profile | a per-tab override does not reach dedicated workers; the UA-override approach left the worker on the old language | refused at stealth, warned otherwise; use a profile whose persona has that locale |
| A cross-site `window.open` popup's very first script can read the browser default locale | the locale is re-sent when its document commits; stealth popup-vs-top passed 2/2 but is timing-dependent | open |
| Widevine absent below stealth (by design) and always on CfT (the binary) | round 3 EME probe | by design / inherent |
| Humanize model limits | uniform ranges, one log-normal, one Bézier with at most one overshoot, white-noise tremor (not 8–12 Hz), 8–16 ms jittered sampling, no pointer-acceleration curve; US QWERTY only, no IME; notched wheel only; one dispatched event per frame (`getCoalescedEvents().length` 1, a weak CDP-class signal) | calibration narrows the gap, does not close it. Calibration bounds: settle rate a lower bound, typo rate an upper bound, the recorder's 16 ms throttle hides the mouse report rate, v1 recordings have no pointer data |
| Coordinates are whole CSS pixels | `interact.js layoutViewport` passes no `dpr` to the planners | right only at 100 % display scaling; changing it touches replay determinism and unit baselines |
| CfT's 10 fps root cause | ruled out: `--disable-gpu-vsync`, SkiaGraphite/TreesInViz off, restored tabs, and (2026-09-23) the pending Windows Firewall prompt for the new `chrome.exe` | workaround only (`--disable-frame-rate-limit`, CfT only). Engine 1 on a person's CfT is not given it: a humanized path reached the page as 4–5 mousemoves (Edge 17–23) |

### 8.2 Engines, background states and delivery

| Gap | Evidence | Status |
|---|---|---|
| Input to a hidden Engine 1 tab is refused | pointer/wheel do not arrive (physics); keys would arrive (10/10) but are refused by policy (b) | agent remedies in the message (focus, popout, handoff); allowing typing into an already-focused hidden field (option a) was not built |
| A headed Engine 2 window that is minimized renders about 1 frame per 1.5 s | matrix: click delivered after 28–29 s, screenshots 33–46 s | warned in `browser_status` and the capture note; the fix is not minimizing, or headless |
| A popped-out Engine 1 window renders only while it is on screen | on Windows a window that another window covers completely is occluded, and Chromium stops rendering it unless the `WindowOcclusionEnabled` policy is off; a minimized one always stops. Reported from real use before 2.0.3: the side panel's Pop out put the new window behind the person's maximized window, and the tab seemed to vanish | **fixed for the panel in 2.0.3** (the window is created focused and in front, smaller than the source, and the person's window is not raised over it). An agent's popout stays unfocused so the person keeps the keyboard, and can still open behind another window: its result reports `visible:false` and the remedy. Checked against a stubbed browser only (`seam.test.mjs`); no harness puts a window on screen |
| Locked session, another virtual desktop | not measured — both would disrupt the owner's workstation (the Engine 2 phase, P2, asked for a locked-session run) | open |
| A call that reaches its deadline may still be running | live round 1; `daemon/router.js`. **Fixed 2026-09-22:** the call is cancelled (an `AbortSignal` into `lib/humanize.js perform` on Engine 2, a `{type:'cancel'}` frame to the extension) and the tab's queue is held until it stops, up to 5 s; only if it does not stop does the answer say it may still be running. `browser_interact`'s deadline also grows with the text it types (450 ms per character), which is what used to make a long humanized type hit the deadline and keep typing into the next call's target | mitigated; a call stuck outside `perform` (a wedged CDP command) can still overlap after the grace |
| A per-agent halt does not interrupt an Engine 2 call already running | only the global halt is mirrored into launched engines. **Fixed 2026-09-22:** `router.cancelFor(agentId)` aborts that agent's running calls and sends `cancel` for relayed ones | closed |
| A witness listener may stay armed after Stop | `cdp.send` refuses every command while halted, so the release waited for the 10-minute safety net (live round 2) | mitigated: `interact.js cleanupSend` ends and releases G9's own witness on the live session after Stop, bounded at 2 s; only if that fails does it stay armed until the safety net. It lives in G9's world and reacts only to trusted events |
| D-c limits | after an extension reload/browser restart a tab that navigated during the gap loses its handle (checked by URL on purpose); two browsers sharing a copied profile share one `instanceId` (the newer wins; the other waits for Reconnect); parked 10 min | by design |
| Handoff moves cookies + local/session storage only; the page reloads | IndexedDB, service-worker state and in-memory state do not travel (listed in every result); a recording's screenshot-baseline attachments are not copied when it is relayed to the launched store | by design (v2.0) |
| Engine 1 downloads | attribution inferred (`exact`/`probable`/`unknown`), no file hash or content | inherent to `chrome.downloads`; Engine 2 hashes from disk |
| Smaller known limits | a prerender activation gives the tab a new handle; `tabs.remove` on a page with a `beforeunload` prompt can re-register it under a new handle; netpin's HAR entry stays consumed when a fulfil fails and the request then goes to the live server (it is put back only when the request was cancelled); `verifiedContextFor` checks then uses a context in two commands (a cross-process navigation exactly between them is not excluded); `select` at stealth untested against a headed real popup | open, recorded |
| Ref generations are not enforced | §4.2. **Fixed 2026-09-22 (EXT-03):** ref numbers are never reused on a page (a snapshot continues the page's numbering) and the last four snapshots each caller took stay resolvable (16 per page in all; per caller since live round 4), so a ref always names the element ITS snapshot showed — another agent's snapshot cannot renumber yours. A ref from an evicted snapshot, another page or a removed element is refused | closed |
| Engine 1 downloads were attributed to a watched tab against contrary evidence | a download whose referrer origin belongs to no watched tab was claimed by the single watcher, and two tabs that had both requested the URL gave a false `exact`. **Fixed 2026-09-22:** `exact` needs exactly one watched tab that requested that URL since its own watch began; origin evidence (referrer, blob creator) is matched against the tab, its cross-origin frames and the tabs it opened, and evidence pointing elsewhere gives `unknown` instead of a time-based guess | closed |
| Calibrated profiles from a launched engine are not installed into the extension's store | no daemon → extension message for it | open |
| CfT-only flakes in live round 3: popout listed an empty title (1 in 11); an identical second replay failed (1 in 14, cause not captured) | mitigations (popout waits for title + renderer; snapshot re-asks on a root-only tree); 20/20 clean runs after them — also ≈15 % / 23 % likely by chance at those rates | not proven fixed; replay flake cause unknown |
| Extension reload on Chrome/CfT | with `--load-extension` on CfT, `chrome.runtime.reload()` left the extension disabled (`DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION`); with CDP `Extensions.loadUnpacked` the full suite passed (branded Chrome 7/7). Branded Chrome 153 ignores `--load-extension`. A person's Developer-mode "Load unpacked" followed by the desktop's reload was not measured on Chrome | open on Chrome; Edge reloads work (5 per isolated run) |

### 8.3 Product, installer, measurement coverage

- **Installer and updates.** Unsigned (SmartScreen warns). Not exercised: a real install on this
  machine, the real UAC prompt, an update server (the updater is tested with a fake), and installing an
  update while AI clients run shims as `G9.exe` — the installer may close those shims mid-session and a
  shim may respawn the old daemon while files are replaced (design-level, not fixed). `docs/INSTALL.md` is the operator guide; policies are also applied and documented by the
  desktop (`desktop/README.md`, `lib/policies.mjs`); `BackgroundTabFreezingEnabled` is read by Chrome only from
  155 (an unknown name is ignored).
- **maxParallel default is 8.** Live round 3's data put the rule at 12 on this machine class (§9
  v2.0.0); the default was not changed.
- **Not measured:** an 8-hour endurance run (only 10-minute runs), macOS/Linux (not in v2.0; POSIX
  paths untested), the `HTTPS_PROXY` tunnel, zip64, two real processes racing one CfT install, new
  headed Engine 2 windows copying bounds, headed CfT after the round-3 fixes, a full clone + `install.ps1`
  on another directory (EXT-16's last criterion).
- **Re-run on the 2.0.1 tree (2026-09-23, the final pass):** every suite. Unit, self-test, extension, desktop
  (files, contract, packaged, render), Engine 2 live, isolated Engine 1 live on Edge and Chrome, the
  stealth matrix including the public pages, the background-state matrix, bench and a 10-minute
  endurance run. Numbers in the §9 2.0.1 entry. **Re-run on 2.0.2 (2026-09-24):** unit, self-test,
  extension, desktop files, the packaged build, Engine 2 live and isolated Engine 1 live on Edge (§7).
  2.0.3 changed only the popout; its checks are in the seam suite. **Re-run on 3.0.0 (2026-09-25):**
  unit, self-test, extension, desktop files, the packaged build, Engine 2 live, isolated Engine 1 live
  on Edge, and the new panel render harness. Not re-run on 3.0.0: the daemon contract, the desktop
  render check, isolated Engine 1 on Chrome, the stealth and background-state matrices, bench and
  endurance — 3.0.0 changed no launch switch, stealth rule, input path or desktop code, only the side
  panel and what the daemon and the extension tell it.
- **The v3 panel (3.0.0).** Checked by source scans, the seam and extension suites, the isolated live
  test's panel section and `setup/panel-render.mjs` (a stubbed `chrome`, looked at in pictures). Not
  checked: a screen reader, high-contrast or forced-colors mode, right-to-left page titles, and a
  real Windows desktop with the panel detached. **Project sites** depends on the connected agents'
  `g9.project.json` environments; with no agent connected it attaches nothing, which the panel says.
- **The icon (3.0.1).** The extension's icons come from the owner's artwork through
  `setup/make-icons.ps1`; the source PNG is not in the repository (keep it to regenerate). The 16 px
  size is a crop, the browser window with "G9", because the whole drawing is a blur at 16 px; not
  looked at in a real toolbar here (the harnesses are headless). The desktop app's icons (tray,
  window, installer) are still drawn in code by `desktop/lib/icon.mjs`, coloured by state.
- **What `check.mjs` does not know (3.0.1).** It maps a change to checks by the files each check
  imports or reads, not by behaviour. A change that alters behaviour only through data a check never
  loads, or through the browser (Chromium, Edge) itself, is not detected — the live suites and the
  matrices are for that. Its guard test only keeps every tracked file reachable or named; it cannot
  prove the `reads` lists complete.
- **Version rule.** The owner's standing rule is "bump on every change". 2.0.0 was released under a
  fixed-2.0.0 contract; the first change after it — the 40 review fixes and the final pass — is
  **2.0.1**, then **2.0.2** (three flaky-test defects and the close budget), **2.0.3** (the
  popout) and **3.0.0** (the side panel, U1–U10 in §6.10; a major bump because the panel, the
  auto-attach setting and the issue index changed shape — a 3.x extension and a 2.x daemon still
  connect to each other). No test pins a literal version any more: `version.test.mjs`, `panel.test.mjs`,
  `desktop/test/static.test.mjs` and `desktop/test/smoke.test.mjs` all compare the files with each
  other and with `lib/version.mjs`, so a bump is one edit in each of four JSON files: `package.json`,
  `extension/manifest.json`, `desktop/package.json` and `desktop/package-lock.json` (the lock file is
  compared too, since `npm ci` in `desktop/` installs from it).
- **Desktop duplication.** The per-call timeout table is copied into `desktop/lib/daemon-client.mjs`
  (the packaged app cannot import the repo's `lib/`); `daemon.test.mjs` checks the copy never ends a
  call before the daemon does.

### 8.4 Platform boundaries and things not built

| Boundary | What can and cannot change |
|---|---|
| Restricted `chrome.debugger` domains (Engine 1) | No `Browser` domain, no `HeapProfiler`, no `chrome://`/store/other-extension pages. Engine 2 has full CDP; a task needing more moves there (handoff). |
| Native dialogs, desktop input, general filesystem | Tools operate on pages. The optional real-cursor "showroom" driver is not built (below). |
| Person's own profile in Engine 2 | Impossible by design (Chrome 136 rule, App-Bound Encryption); Engine 2 profiles are per machine (a copied profile loses its cookies). |
| Browser/enterprise policy | Policy can deny debugger attachment; changing code does not grant an exemption. |
| Finite capture/history | Buffers are bounded; uncaptured requests cannot be recovered by a larger buffer. |

**Not implemented:** full heap snapshots, Lighthouse, Firefox/Safari, desktop/audio recording,
vendor-specific Jira/Azure/Linear clients, IndexedDB transfer on handoff, the showroom driver and the
spikes below, a
published extension (store or forcelist CRX). Local-adversary hardening remains outside the deployment
model (§5).

**Described, never run.** Each is optional and off the critical path; none blocks anything.

- **The showroom driver (real OS cursor).** Only for demos or a rendering bug that needs the real
  cursor: humanize plans dispatched by a small native driver (`SendInput` through a Node addon or a
  small C# helper) on a dedicated desktop — a VM, Windows Sandbox or a QA PC with autologon and `tscon`
  — never on a person's own desktop (§2.8.5). Same path generator, same profiles; the dispatcher's
  interface (`perform(tabId, plan)` in `extension/lib/humanize.js`) leaves room for it without touching
  `extension/humanize/`.
- **`tabCapture` keep-alive for Engine 1.** An active tab capture prevents `WasHidden` (the capturer
  count), so a captured background tab may stay rendered and accept input. It needs a user gesture,
  shows the "sharing" indicator, and is unproven for minimized windows. A two-day spike; R5 keeps it out
  of the foundation.
- **A second virtual desktop for popped-out windows.** With `WindowOcclusionEnabled=0` the tracker is
  off, so a non-minimized window on another virtual desktop should keep rendering. A one-day spike on
  the matrix machine.
- **Playwright as the launch/transport adapter** for Engine 2 instead of `engine/launch.js` and
  `pipe-cdp.js`: allowed only in `desktop/` (D11), and only if the zero-dependency implementation proved
  inadequate. It has not.
- **The fork spike (D1).** Two weeks, one engineer: build Chromium on a build machine; apply one small
  patch (a cursor overlay in the compositor); move to the next milestone, rebase and rebuild; produce a
  signed installer and install it on one QA machine — recording the wall-clock time of each step, the
  size of the toolchain and the conflicts met. The rule agreed with the owner: if all four steps were
  comfortable, a fork is realistic for this team; if any was painful, D1 stands. Everything v2 built
  (daemon, CDP transport, humanize, evidence) would be reused unchanged, because a fork is still driven
  over CDP.

### 8.5 The v1 backlog (EXT-01 … EXT-17)

A capability audit of v1.7.21 (2026-09-12, temporary headless Edge 152 profile) produced seventeen
work items; the code and the tests cite them by number. The v2 phases absorbed them (§9, the v2.0.0
entry). An item counts as done only when every one of its acceptance criteria has evidence, so none is
checked off. Status as of 2026-09-22 (v2.0.0); re-checked on 2026-09-25, and no release since changed
any item's status.

| ID | Work | Status | What remains |
|---|---|---|---|
| EXT-01 | Repair input-delivery verification | **Partly done** — the defect is fixed and verified live. The witness is armed in G9's isolated world before dispatch, hears trusted events only, is timed from the end of dispatch, and results carry `delivery`; `not-delivered`, `missed` and `partial` are errors (§4.3a) | The injected-checker-error and navigation-during-click cases are proven against the `node:vm` fake browser only; a frame removed mid-operation has no test; after Stop a witness can stay armed until its safety ceiling (mitigated, §8.2) |
| EXT-02 | Replace unsupported download tracking | **Partly done** — `chrome.downloads` on Engine 1 (attribution `exact`/`probable`/`unknown`, never guessed), `Browser.setDownloadBehavior` plus a size/sha256/magic-bytes check from disk on Engine 2 | Live-verified on Engine 2 only; cancelled or interrupted transfers, repeated file names and concurrent unrelated downloads not exercised live |
| EXT-03 | Enforce snapshot generation and frame identity | **Done for renumbering** (2026-09-22): ref numbers are never reused on a page and each caller's last four snapshots stay resolvable (§4.2) | Child-session node identity |
| EXT-04 | Align screenshot retry and request deadlines | **Partly done** — deadlines follow the call (120 s floor), a stalled capture names its cause, a call that reaches its deadline is cancelled and its tab's queue held until it stops | Attempts are not budgeted from the time left in the call; a call stuck outside `perform` can still overlap after the grace; the relay-timeout text still names a JavaScript dialog as a possible cause; both-attempts-stall and late-reply cases untested |
| EXT-05 | Complete cross-origin frame routing and lifecycle | **Partly done** — snapshot, typing and clicking inside an out-of-process frame verified live; frames listed with `crossProcess`; Engine 2 holds every child target until the persona reaches it | The operation-by-operation coverage matrix; the recorder does not arm cross-origin frames that attach after recording starts; element screenshots in frames, nested/transformed frames, frame navigation, removal and reinsertion |
| EXT-06 | Extend closed Shadow DOM locator and recorder support | **Open** — locators and the recorder still rely on `element.shadowRoot` | Everything; no test covers a closed root |
| EXT-07 | Establish background-operation support by experiment | **Partly done** — `setup/matrix.mjs` measured headless and off-screen/minimized headed windows on both engines; every cell agrees with the page (§8.2) | A locked session and another virtual desktop; separate key, drag and DOM-read columns; headed CfT after the round-3 fixes |
| EXT-08 | Improve screenshot resolution, regions and incremental capture | **Open** — captures still scale by `min(1, 2000/width, 8000/height)`; v2 changed only how a capture is taken at the human levels | Resolution, region, tiled and file-backed options |
| EXT-09 | Improve video capture state, duration and export | **Partly done** — one shared screencast per tab, write-before-ack, the pointer track, `live`/`idle`/`hidden` watch status, capped run spools, WebM export in the desktop | The issue video keeps v1's 600-frame / 40 MiB caps and reports no recording state; its pointer track does not survive a worker restart; the export is checked for format only; `report.html` has no frame player |
| EXT-10 | Add bounded, pageable and exportable evidence | **Open** — console (500), network (400) and text-body (512 KB) caps unchanged | Cursor-based network reads, chunked export, binary artifact files |
| EXT-11 | Make HAR matching and replay completeness explicit | **Open** — matching unchanged (method, origin/path, query keys); pin state is consistent under parallel requests and Stop | A HAR entry is still used up when its fulfil fails |
| EXT-12 | Expand storage inspection with bounded reads | **Open** — IndexedDB/CacheStorage names only; reads moved to the isolated world; cookies unscoped and whole | Bounded IndexedDB and Cache reads |
| EXT-13 | Verify version capabilities and worker recovery | **Partly done** — `minimum_chrome_version` 125; versions, `versionMismatch` and a `capabilities` block in `browser_status`; D-c resume across a worker restart or reload | The probed per-feature capability set; a real MV3 worker restart measured in a browser; `chrome.runtime.reload()` on CfT with `--load-extension` (§8.2) |
| EXT-14 | Improve multi-client bridge routing and ownership | **Superseded** by the daemon (D5, §4.10) | A call that times out while its engine still runs it can overlap the next queued call on that tab (mitigated, §8.2) |
| EXT-15 | Expose and improve Playwright export fidelity | **Open** — `export_test` generates Playwright code as in v1 | An export coverage report and executed-export fixtures |
| EXT-16 | Make the regression suite portable and meaningful | **Partly done** — the fixture is in the repository and the suite passed from a copy outside the checkout; real-extension coverage through `setup/isolated-livetest.mjs` | A full clone plus `install.ps1` in another directory; no real-extension download case |
| EXT-17 | Synchronize runtime guidance and capability reporting | **Partly done** — `mcp/tools.js` and the error texts describe measured behaviour and name the agent's remedy | The probed capability model (EXT-13); the relay-timeout text (EXT-04) |

### 8.6 Owner decisions still open

Recorded on 2026-09-25; none blocks a release.

1. **Primary browser, Edge or Chrome.** v2 was built and measured mostly on Edge 153; `defaultBrowser`
   is `auto` (the pinned CfT if installed, else Edge, else Chrome). Branded Chrome 153 ignores
   `--load-extension`, and CfT's brand is flagged by a public detector, so stealth runs prefer Edge or
   Chrome.
2. **A code-signing certificate** for the installer and `G9.exe` (§8.3).
3. **Where updates are hosted** — an http(s) URL for `updateUrl` ([docs/INSTALL.md](docs/INSTALL.md),
   "Updates and update hosting").
4. **Whether `runner/drivers/agripad.mjs` is still needed.** Kept as is.
5. **The stealth-critical third-party components.** `setup/stealth-pages.json` lists only the six
   public detector pages; the product's own widgets would join them.
6. **A dedicated VM or desktop for headed stealth runs.** Headed runs were measured only off-screen on
   the owner's workstation.
7. **Human vs Stealth defaults.** The daemon defaults to `humanize:"human"`, `stealth:"off"`,
   `headless:true`, and the extension's Input setting to Human. Stealth gives up page console capture
   and full-page screenshots and asks for a warm persona profile; choose which suites run at which level.
8. **Headed stealth by default?** Headless stealth is always detectable by its user agent; headed Edge
   stealth was undetected, but a headed engine needs a desktop that nobody minimizes or locks (a
   minimized headed Engine 2 window renders about once per 1.5 s).
9. **D-b as built:** a launched context's `stealth` level and the side panel's Stealth choice are floors
   an agent's `humanize` cannot loosen; the panel's Human and Direct are only defaults. Confirm.
10. **D-a as built:** stealth passes `--disable-blink-features=AutomationControlled`, against the
    designed switch list, because stealth runs must be undetectable. Confirm.
11. **The version cadence.** Every change bumps the version (D12); confirm that cadence for releases.
12. **`maxParallel` default:** 8 (live round 2) or 12 (round 3's data) on this machine class (§8.3).
13. **Keys to a hidden page:** G9 refuses them by policy; typing into an already-focused field would be
    delivered (§8.2).
14. **Full-page screenshots at human** resize the viewport (a transient 1×1 the page can see, disclosed
    as `pageSaw`); keep it, or build stitched viewport captures.
15. **Owner action, not a decision:** profiles signed in by early v2 builds stay signed in until someone
    signs them out (launches refuse them at stealth and warn otherwise), and test browsing from the
    early live rounds may already be in the owner's synced Edge history.

---

## 8b. Recorder, replay, and issue capture

Designed 2026-08-31, built in v1.2, expanded through v1.7, moved onto the platform seam in v2. Written
down before the code existed because the decisions are the expensive part; the implementation
followed from them, and the record of *why* is worth more than the diff.

### The problem that shapes it

A recorded test is only worth keeping if it still finds the same input next
month. No single selector does that — a CSS path breaks on a refactor, an id
breaks when the framework regenerates it, text breaks on a copy edit. So each
element gets **several independent locators**, ranked by durability, and replay
tries them in order:

| # | Locator | Survives |
|---|---|---|
| 1 | `data-testid` / `-test` / `-qa` / `-cy` | anything — it is a promise not to move |
| 2 | **role + accessible name** | restyling, DOM restructuring, class churn |
| 3 | bound `<label>` text | everything but a copy change |
| 4 | shortest unique visible text | good for buttons and links |
| 5 | CSS from stable attributes only | refactors that keep `name`/`type` |
| 6 | XPath | nothing much — last resort |

Priority 2 is the one that makes this ours rather than a copy of Chrome's
Recorder: the extension already perceives pages as an accessibility tree, so the
recorder and the agent address elements the same way. Role+name is also the best
answer to "how do I not lose an input", because it is derived from what the
control *means* rather than where it sits.

`lib/locators.js` also refuses to build a locator from anything
machine-generated — CSS Modules, styled-components, emotion, React `useId`,
Radix, Angular `ng-tns`, raw hashes, bare digits. Those are the single largest
source of recorded-test flakiness: stable within one build, different in the
next.

**A locator only counts when it matches exactly one visible element.** Two
matches is not a near miss, it is ambiguity, and resolving it by picking the
first is how a replay silently does the wrong thing.

**Replay reports which locator won.** Matching on `testid` means the page is
behaving; falling through to `xpath` means every durable identity has changed
and the step is one refactor from breaking. That is a warning worth having
before the failure, not after.

**When nothing matches, the fingerprint answers.** Tag, type, role, name, label,
placeholder, nearest heading, ordinal — none of it used to find the element, all
of it used to explain the miss: *"looked for a textbox labelled 'Email' under
'Billing details'; the nearest match is a textbox labelled 'E-mail address'"*
instead of "selector not found".

### Timing

Gaps between steps contribute readiness budgets (present, stable, actionable).
Modes are `recorded`, `fast`, `adaptive`; recorded mode also preserves the remaining pause after
readiness, capped at ten seconds per step. Assertions have their own bounded retry behavior.

### Assertions, data, and results

An action step is not a test unless its result is observable. Assertions are
ordinary recording steps, so backup/import, replay ordering, stop-on-failure,
history, and Playwright export all share one model. Element assertions persist
the same multi-locator target as actions. Screenshot baselines store a compact
fingerprint and normalized threshold, not an opaque pass bit. Parameter defaults
merge with environment variables and per-run values; unresolved placeholders
fail with the missing name. The last 20 summaries are retained, and mixed recent
pass/fail results are exposed as a flaky signal.

### Recording transport

`Page.addScriptToEvaluateOnNewDocument({worldName:'g9'})` + `Runtime.addBinding`, over the CDP
session already open, in either engine. Injects before the page's own scripts, survives navigation by
construction, and gives the injected listener a direct channel back — with **no content script and no
new permission**; all browser logic still goes through CDP. v2 moved it into G9's isolated world
(§4.7): v1 left `window.__g9rec`, `window.__g9loc` and the `__g9emit` binding where the page could see
them. The binding is added by `executionContextName` AND by context id, because a binding by name is
installed only while Runtime is enabled and stealth never enables it (measured on Edge 153); the script
buffers events emitted before its binding exists. Alongside the steps it samples the person's hand
(pointer ≈60 Hz, presses with the target's size, wheel notches, key timing by class — never text, and
nothing in password fields) into `input-samples.json` for humanize calibration. A second recording on
a tab that is already recording is refused (v1 silently replaced the session and leaked the first
one's scripts). Cross-origin frames that attach after recording starts are not armed.

### Storage

`platform.storage.local` for structured records, **`platform.blobs` for attachment bytes**: in the
extension `chrome.storage.local` + IndexedDB (`g9-attachments`, the v1 schema, so existing data
survives), in the daemon `G9_HOME/store/kv-local.json` + `store/blobs/<store>/<id>.bin`. Screenshots
and tab video are the only things that get large, and a JSON store would deserialise megabytes of
base64 on every read of any key. The split is what keeps listing issues fast when one of them has a
20MB video. `unlimitedStorage` is requested for durable data; transient page state still uses session
storage, so §4.1 is a transient/durable distinction, not a blanket ban on persistence.

**Two stores in v2.** The extension's store (Engine 1) and the launched-engine store (Engine 2) are
separate. The daemon merges `list` across both (each row labelled `engine`), tries the caller's current
engine first for id-based actions, copies a recording from the extension store before replaying it on a
launched tab, and keeps the launched store's local truth (known world, run history, flakiness) on
`import_spec`. The runner imports the repository's FlowSpec files into the launched store before a run:
the repository is the source of truth.

Screencast frames are written one record per frame and acknowledged only after the record is durable
(`lib/screencast.js` `backpressure:true`), which gives Chromium back-pressure and removes asynchronous
read/modify/write loss; each frame record carries the pointer sample of that moment. Session storage
holds only frame count/bytes/owner metadata.

Backup and restore is a single self-contained JSON bundle with attachments
inlined — a manifest plus a folder is the kind of backup that arrives
incomplete. Import defaults to `merge`; `replace` has to be asked for by name.

### Media (decided with the user)

Screenshot plus **tab video via `Page.startScreencast`**, in v2 one stream per tab shared by the issue
video and the live watch (`lib/screencast.js`). No microphone, no desktop capture: the screencast
captures exactly the tab, needs no permission beyond `debugger`, and has no source picker. The cursor
is a **track, not a picture** (D9): every dispatched mouse event is recorded (`lib/pointer.js`), each
frame record carries the pointer, the video stores `pointer-track.json` (`g9-pointer/1`), and the
desktop's Watch view and the reports draw the cursor from it — a DOM cursor would be visible to the
page. On Engine 2, replays and UI watches spool frames and `pointer.jsonl` into
`G9_HOME/runs/<runId>/`, capped by `settings.evidence` (3000 frames per run by default; beyond a cap
frames are counted, not written). Audio/desktop capture would need another implementation and consent
model; do not assume every capture API has the same lifetime or visibility rules.

### External task systems stay agent-owned

The browser tool produces portable structured issues, attachments, HAR, and
reproducible test steps. The connected AI agent normally already has the right
GitHub/Jira/Azure/Linear connector and should file from that evidence. No
vendor-specific tracker client or token handling is implemented here; keeping
it out preserves the zero-dependency core and avoids duplicating the agent.

### MCP surface

Two grouped tools, keeping §4.4's discipline: `browser_recording` (list/get/status/start/stop/replay/
assert/update/delete/export/import/export_test/export_spec/import_spec/calibrate/approve/known_world/
signature/suggest/calibrate_humanize) and `browser_issue` (list/get/create/update/delete/screenshot/
attach/attachment/video_start/video_stop/video_status). v2 added `engine` and `humanize`/`seed` to
replay — `engine:"launched"` opens the recording's start URL in a launched engine when needed and
reports `ranOn` — and `calibrate_humanize`, which fits a profile from one or more recordings' input
samples; with `name` it is saved where unattended runs look it up (a profile fitted on a launched
engine is not installed into the extension's store, §8.2).

## 8c. Regression memory — signatures, the known world, and surprises

Added in v1.6.0. This is the largest single addition since the recorder, and the
reasoning matters more than the code.

### The problem it answers

Everything in §8b makes a recorded flow *survive* change. None of it notices
change that nobody wrote an assertion for — and that is where real regressions
live. A flow can pass every assertion it has while the page starts throwing a
console error, stops making a request, or loses a control from a screen the
assertions do not mention.

So the question is inverted: instead of "did the expected thing happen?", each
run also asks **"did anything happen that has never happened before?"**

### The pieces

| File | Role |
|---|---|
| `lib/signature.js` | Build a run's signature; merge approved runs into a known world; detect surprises; calibrate volatility |
| `lib/flowspec.js` | The portable, canonical, Git-diffable form of a flow |
| `tools/netpin.js` | Serve the network from a HAR so the backend stops being a variable |
| `tools/replay.js` | Collects the evidence, builds the signature, runs the comparison, classifies the verdict |
| `daemon/evidence.js`, `engine/manager.js` | On Engine 2: the replay's evidence run (`engine.json`, frames, pointer track, `result.json` with verdict, warnings, steps and surprise count) |
| `runner/` | Drives all of it with no agent present — through the shim and the daemon, like any agent; a launched engine by default |

### Normalisation is the whole game

A signature containing a GUID, a timestamp or a row id differs on every run, so
everything is a surprise and the feature is noise. `normalizeText` and
`normalizeUrl` reduce run-specific values to visible placeholders *before*
anything is compared — `POST /api/task/{uuid} 2xx`, not the raw URL. Both
failure modes here are silent (too little normalisation → noise, too much →
blindness), which is why the placeholders appear in the output a human reads.

Two deliberate non-decisions:

- **Query VALUES are dropped, query KEYS are kept.** `?page=2` and `?page=3` are
  the same operation; `?page=2&debug=1` is not.
- **Small numbers are NOT normalised.** Collapsing every digit would also hide
  `level=2` becoming `level=3`. A live counter therefore *does* differ between
  runs — and that is exactly what calibration is for, rather than something to
  paper over in the normaliser.

### Both directions, and the one people forget

- **new** — something appeared that never appeared. Usually a regression.
- **missing** — something that happened on EVERY previous run did not happen.
  A request that always fired and now does not is a button that no longer does
  anything, and there was never an assertion for it.

Severity is opinionated: a new error (console error, 4xx/5xx, unexpected dialog)
is a failure; a universally-missing operation is a failure; a new or missing UI
node is a *warning* by default, because real products add and remove controls
constantly and treating that as a failure trains people to ignore the tool.
`sensitivity.surprise: "fail"` raises it per flow.

### Confirmation, because one sighting is not drift

The accepted rule in drift detection is that a single new failure is not drift —
a pattern of them is. `classifySurprises` requires the same surprise in 2 of the
last 3 runs before it reaches its declared severity; below that it is reported
at warning strength with its evidence attached. Without this, every transient
blip files a ticket and the tool is muted within a fortnight.

### Calibration replaces hand-written masks

`action:"calibrate"` runs the flow twice on the same build and marks everything
that differed as volatile. Whatever changes when nothing changed is noise by
definition, and this is the cheapest correct mask there is.

This matters because hand-masking is the documented way visual suites die:
teams tighten thresholds and mask dynamic regions until the tool only catches
regressions in the parts nobody masked. A calibrated mask only ever excludes
what was *proven* unstable.

Calibration refuses to run on a failing flow. Calibrating a broken run would
mark the breakage itself as noise — the single worst thing this feature could do.

### Only a human approves

`approveKnownWorld` is the one path that grows the known world, and nothing
calls it automatically. The single exception is `seedKnownWorld`, which creates
a first known world where there is none — it can never overwrite an approved
one. An automatic merge would write a real regression into the baseline as
normal, which is silent self-healing wearing a different hat.

### Visual: three levels, and why `layout` is the default

1. `luma-32x32-v1` fingerprint — 1KB, inline, a prefilter. Unchanged, because
   every existing recording carries one.
2. `edge-64x64-v1` structure map — a binarised gradient. Blind to colour, font
   smoothing and copy is the design goal, not a guarantee: changed contrast or text can alter
   edges too. This is what `mode: "layout"` compares to detect movement, clipping and overlays.
3. The full PNG — an attachment (IndexedDB in the extension, a blob file under `G9_HOME/store/blobs/` on
   a launched engine), for a human. Never compared.

An old baseline has no structure map, and `compareVisual` throws rather than
silently falling back to `strict`: a comparison the caller did not ask for is a
lie about what was verified.

### Semantic (`aria`) baselines

The accessibility tree, refs stripped and values normalised, stored as a line
list. It is less sensitive to restyling, but role, accessible-name, copy and state changes can alter
the tree. Balanced numeric-only substitutions are paired as data changes and reported as warnings;
the paired counts must match, so adding/removing rows is still structural. Tolerance defaults to zero.

The Playwright export writes `toMatchAriaSnapshot()` and lets Playwright own its
own snapshot file rather than translating our normalised form into their YAML;
a translated snapshot that never matches is worse than no snapshot.

### Network pinning

`Fetch` interception, matched on **method + normalised URL**, first unconsumed
entry wins. Request bodies are not matched on — that needs a normaliser per API
and is the kind of cleverness that fails silently.

The normalised URL retains origin/path and sorted query **keys**, but ignores query values.
Different payloads or query values can therefore consume the same ordered response queue. Body and
entry caps also apply. Live-versus-pinned comparison narrows a diagnosis; it is not proof that all
remaining variation belongs to the frontend.

Every path in `onRequestPaused` ends in exactly one of `fulfillRequest`,
`continueRequest` or `failRequest`, including the catch-all: a paused request
that is never answered hangs the tab forever, so a bug in that file must not be
able to freeze the page.

Unmatched requests pass through by default and fail under `strict: true`. Strict
is the honest setting for a test claiming to be hermetic, and it is opt-in
because one un-recorded font should not look like a product bug.

### The verdict

`PASS` · `PASS_WITH_WARNING` · `SURPRISE` · `FAIL_PRODUCT` · `FAIL_AUTOMATION`.

`FAIL_AUTOMATION` is decided from the *wording* of the step error
(`AUTOMATION_FAILURE` in `replay.js`) because those two outcomes have different
owners: one is a bug, one is a broken test, and filing the second as the first is
how a QA system loses its audience. That pattern list (`AUTOMATION_FAILURE_PATTERNS`) is a heuristic and
will need extending as new failure sentences are written — keep it beside the messages it
matches.

### Late evidence after the last step (v2)

The same replay on an unchanged page used to count 3, 3, 2, 3, 3, 3 surprises in six identical runs
(desktop render check, live round 3): the page logged an error and fired a failing request just after
the final click, sometimes before the signature was built and sometimes after. Replay now waits,
bounded (500 ms of quiet, 2 s cap), for new console entries and requests after the last step, attaches
what arrived to that step, and reports `settledAfterLastStep`. A page that never goes quiet costs only
the cap. The quiet window opens only once a poll has seen no request in flight (`pending === 0`):
`pending` is a level, not an edge, and until 2.0.2 the window could open from the last poll that still
saw a request running, so a late response and its status could be missed (§9 2.0.2).

### Evidence attribution is by identity, never by clock

Console entries carry a monotonic `seq` and requests carry an id, so "what
happened during this step" is a set difference against a watermark taken at the
start of the run. Filtering by timestamp quietly mis-assigns everything on a
slow page. The watermark is *recorded*, not cleared — a replay must not destroy
the console history a human is reading.

### Cost control

`signature: "lite"` (the default) captures network and console for every step
and the accessibility tree only at assertion steps and the final step.
`getFullAXTree` is the most expensive thing replay can ask for, and taking one
after every step of a forty-step flow doubles the run for evidence nobody reads.
`"full"` is what calibration uses, because calibration needs the UI layer.

### What deliberately did NOT happen

- **No new tool for regression memory.** Pinning went into `browser_network` and the
  known-world actions into `browser_recording`. §4.4's budget is spent on tool
  *definitions*, which are re-sent every request; actions are free. (v2's fifteenth
  tool, `browser_engine`, exists because launched browsers are a new noun, not a new
  action on an old one.)
- **No signature in a tool result.** A full signature is kilobytes of normalised
  evidence. `includeSignature` is an internal flag for calibration; the agent
  gets counts and surprises.
- **No automatic approval, no automatic baseline update, no automatic locator
  repair.** Same rule, three places.

## 9. Change log

Entries below describe what was believed or tested at the time. Current capability claims and
unresolved findings are in §§4, 7 and 8, which supersede historical assertions. Entries dated before
2026-09-21 describe v1 (the bridge, the four control modes, the workspace allowlist).

### 2026-09-26 — v3.0.2: ready for a public repository

**Why.** The repository is to be published and mirrored automatically, so it has to hold nothing
private and nothing that only made sense while v2 and v3 were being planned.

**The planning documents are gone.** The v2 implementation plan, the v3 UX plan and the v1 extension
backlog were removed, from this tree and from the history. What they held that still matters moved
into the guides before they went:
- the twelve decisions D1–D12 → §2.0; the verified Chromium facts and their sources → §2.8; the
  standing rules R1–R9 → §2.9;
- the phases P0–P8 and what each shipped → the v2.0.0 entry below;
- the v3 decisions U1–U10 with their evidence and the as-built differences, and the icon prompt → §6.10;
- the backlog items EXT-01 … EXT-17 and what each still lacks → §8.5; the owner decisions still open → §8.6;
  the spikes that were described but never run (showroom driver, `tabCapture`, virtual desktop, the fork) → §8.4;
- the humanize and stealth specification was already in [docs/HUMANIZE.md](docs/HUMANIZE.md) and
  [docs/STEALTH.md](docs/STEALTH.md); HUMANIZE gained the one rule it lacked (where the pointer starts);
  the update and install design was already in [docs/INSTALL.md](docs/INSTALL.md), which gained the store option.

Every citation of a plan section in code, tests and docs (about 150) now names the guide section that
holds the content.

**Nothing private.** Test fixtures used a real product domain and a real admin site; they are now
`acme.example` and `contoso.example`, with the same shape, so the tests still exercise what they did.
Two personal showcase pages in `setup/` (not used by any test) were removed. A scan of every blob in
the history for keys, tokens, passwords, connection strings, private keys and local paths found no
credential; the few matches are documented test values (AWS's example key, `g9secret`, `v1-token`).

No runtime behaviour changed. Version 3.0.2 in `package.json`, `extension/manifest.json` and
`desktop/package.json`.

### 2026-09-25 — v3.0.1: the owner's icon, and checks that fit the change

**The icon (U9, §6.10).** The owner generated the artwork (1254×1254, transparent: a browser
window with "G9", a robot, a cursor, an orbit). The new `setup/make-icons.ps1 -Source <png>` writes
`extension/panel/icon16/32/48/128.png`. It crops to the drawing, halves the image step by step, and
finishes with one bicubic resize in premultiplied alpha, so transparent edges stay clean. Looked at
in a preview sheet on light and dark: 128, 48 and 32 px read well. At 16 px the whole scene was a blur,
so 16 px uses a crop of the browser window with "G9" (three crops were compared). The manifest gained
a 32 px icon, which the toolbar uses on high-DPI screens. The desktop app's icons, drawn in code and
coloured by state, are unchanged.

**Why a change waited so long, measured.** The owner asked why tasks take hours with no sign of
progress. The session log answered it (tool calls against their results' timestamps, and the
sub-agents' own logs). The v3 task ran about 5 hours: stage 1 (daemon and worker) 42 min, stage 2
(the panel) 94 min, the review 35 min, then fixes, full test rounds and the docs. Only about 37 minutes
of it was tests. Inside the sub-agents, 7, 3 and 2 minutes of tool time against 35, 91 and 33 minutes
of writing code. So tests were not the main cost of a large task. They were the whole cost of a small
one, because every change got the full battery: unit 240 s (interaction 141 s of it, one suite after
another), self-test 10 s, extension suite 30 s, desktop, 9 minutes of live suites, and an installer
build. Nothing said what was running: the unit runner printed nothing during a suite, and a live suite
redirected to a file looked the same as a hang.

**What changed.**
- `setup/check.mjs` and `setup/check-plan.mjs` (§7.0): only the checks the changed files reach, 4
  at a time, longest first, with a progress line every 15 s and a warning after 90 s of silence. Live
  suites are only named unless asked for. `--plan` shows the plan and an estimate. npm scripts `check`,
  `check:all`, `check:release`.
- `setup/doclinks.mjs`: the link check a documentation-only change runs (0.2 s for 14 files).
- `setup/unittest.mjs` prints a progress line every 15 s while a suite runs.
- New unit suite `setup/unit/check.test.mjs` (13): the plan never skips what a change reaches, and a
  new module no check reaches fails the suite instead of silently running everything each time.
- AIGuide rule 6 and §7.0 say what to run when; the README's Tests section says the same.
- Not changed, on purpose: the interaction suite's real timers (faking the clock would test less) and
  `npm test` (install.ps1 and the docs name it; it keeps running everything, one suite after another).

**Found while building it.** File names in comments are written in backticks, so the first literal
scan counted every comment that named a file as a dependency, and a test page pulled in half the
extension. Literals are now quotes only. The planner's own test names paths as strings, so the planner
counts those as references too. The tests look past that one-second over-approximation instead of
hiding it.

**Runs on 3.0.1 (2026-09-25).** `check.mjs --all` three times: 16 of 16 checks, 651 unit tests in
12 suites, in 142 s. The same checks one after another take ~300 s. The interaction suite took
142 s in parallel and 141 s alone, so no timing test felt the load. Not re-run for 3.0.1: live
suites, the installer build (the last one is still `G9-Setup-3.0.0.exe`), because the change touched
icons, test tooling and docs only.

Version 3.0.1 in `package.json`, `extension/manifest.json`, `desktop/package.json` and
`desktop/package-lock.json`.

### 2026-09-25 — v3.0.0: the side panel earns its place (U1–U10)

**Why.** The owner asked what Attach current tab, Auto-attach, Pop out tab and Send to background do,
and whether the panel could be better. Reading the code answered most of it: the daemon pins each
agent's tab at its first call, so **Attach** had no job left but early capture; three agents showed as
three identical rows; Pop out and Send to background prevent one failure, a hidden tab, but asked the
person to foresee it; Automation and Issues were flat lists that used none of the index fields already
stored. A UX plan set ten decisions (U1–U10, now in §6.10); the owner approved all of them. No
engine capability, tool semantics, ownership or halt rule changed.

**Daemon and protocol.** `daemon/daemon.js` pushes `{type:'projects', domains, projects}` to extension
engines (DAEMON_PROTOCOL §5): the hosts of the `environments` URLs in each CONNECTED agent's
`g9.project.json`, one row per project file naming its agents, sent after each engine's welcome and
coalesced (≤ 100 ms) on agent connect and disconnect. `#agentsFor` rows now carry `project`, `cwd`,
`current` (this browser's Chrome tab id) and `currentEngine` (`'extension'`, `'launched'`, or
`'elsewhere'` for a tab in another browser's extension), pushed again when an agent's current tab
changes. The daemon line in the panel no longer names a project.

**Extension.** `extension/lib/sites.js` (new, pure): `siteOf` (origin), `parseDomain`, `hostMatches`
(the exact host or a subdomain, never a look-alike; a port only when the domain names one; http(s)
only), `displayUrl`. `state.js`: `autoAttach` is `'off' | 'project' | 'all'`, default `'project'`; a
stored v2 boolean becomes `'all'` or `'off'` once, with one activity line, so an existing install
keeps its choice. `sw.js`: Project sites attaches only tabs on `projectDomains` and never detaches a
tab; new panel commands `focusTab` (allowed while Stop is on: the person's own gesture), `recordNow`
(attach, optionally reload to capture the load, one activity line) and `setAutoAttach {mode}` (the
legacy `{enabled}` still accepted); an agent's input refused because its tab is hidden is recorded in
`state.blocked` and broadcast as `agentBlocked`, cleared (`agentUnblocked`) when the tab is shown, a
later call reaches it, it is popped out, handed off or closed, or its agent disconnects. `cdp.js`
records `attachedSince`. `store.js`: the issue index carries `site`, `severity`, `tags` and `evidence`
counts (from attachment metadata, never bytes) and follows each attachment added or removed; an index
written before v3 is completed once, serialized, the first time it is read, and never loses an
entry. `browser_status.autoAttach` stays a boolean (true only when auto-attach captures something), and
the mode is the new `autoAttachMode`, so `if (status.autoAttach)` in an agent keeps meaning what it did.

**Panel** (`extension/panel/`, rewritten; §6.10). Session: no Attach button, **Record from now** with
*reload to capture page load*; Auto-attach as three radios; agents per project with a clickable tab
chip; the current tab as origin plus a middle-truncated path; Pop out and Send to background folded
into one **Keep working elsewhere** row and offered in a toast above the tab bar when an agent is
blocked. Automation: site → suite → flow, an affinity header for the site in front of the person,
filters (site, suite, tag, verdict, flaky, text), **Run N flows in** *scope* over exactly what the
filter shows, and a drawer per flow with its run history and editable section, suite, tags, test
cases and start URL. Issues: site → status, severity, age, tracker key and evidence chips, filters,
the editor restyled. One token and component system in `panel.css`, light and dark. No script builds
HTML from strings; links are http(s) only and open with `noopener noreferrer`.

**Independent review, then fixes.** A read-only review of the finished change found no security
problem and eight defects, all fixed with a test each:
1. The version had not been bumped (now 3.0.0, and the manifest's `default_title` names v3).
2. Project sites outlived the daemon, and 3. blocked-agent alerts outlived their agents after a daemon
   restart (agent ids restart at `agent-1`): `transport.js forgetDaemonState()` clears
   `projectDomains`, `projects` and `blocked` when the link closes or is dropped, and tells the panel.
4. One malformed flow froze the Automation list: `recUpdate` now requires lists of strings for `tags`
   and `qaTestCaseIds` (a comma string becomes a list, anything else is refused), and the panel reads
   stored strings as lists.
5. Arrow keys in the Auto-attach group switched the mode (native radios): an arrow key now only
   moves focus, and the panel says to press Space to switch.
6. Some hidden-tab refusals raised no alert: `interact.js noInputError()` marks every such error
   `hidden = true`, including the witnessed and `select` paths.
7. An environment with variables but no name showed as `[object Object]`: the recording index keeps
   an environment only as a name.
8. A suite named "none" merged into "No suite": the panel's no-suite key is now a value no suite can
   have (`NO_SUITE`).

Found while fixing: `recUpdate` dropped the `qaTestCaseIds` the panel sent (it was missing from the
allow-list), and a flow had no way to get a start URL, so it could never leave "No start URL". Both
fixed: `qaTestCaseIds` and `startUrl` (http(s) only; an empty value clears it) are accepted, the MCP
schema of `browser_recording` lists them, and the drawer has a Start URL field.

**Deviations from the approved decisions, on purpose.** `browser_status.autoAttach` stays a boolean beside the new
`autoAttachMode` (above). `currentEngine` has a third value, `'elsewhere'`. An agent working in a
launched engine is shown as "working in a launched browser", with no title or URL, as U4 asked. The migration keeps a v2 install's
choice (off → Off) instead of moving everyone to Project sites; only an install that never saved its
settings gets the new default. Verdict labels are short ("Product fail", "Test fail"). The dark
theme's accent is `#9d97f5` for contrast. **U9 (the icon) is not done:** it waits for the owner's
artwork (the prompt is in §6.10); the v2 icons are unchanged.

**Tests.** New suite `setup/unit/sites.test.mjs` (7). Daemon 97 → 100 (projects push, agent rows,
environment hosts), panel 75 → 82 (v3 structure, the no-HTML scan, pure helpers, the transport
forgetting daemon state), extension suite 78 → 82 (issue index and its one-time completion, `recUpdate`
lists and start URL, environment as a name), seam checks inside the existing tests (auto-attach modes
and migration, project-only attach, `focusTab` under Stop, `recordNow`, `attachedSince`, the blocked
bookkeeping), interaction (the `hidden` flag), and the isolated live test's section 18 now drives the
three settings. New dev harness `setup/panel-render.mjs`: the panel with a stubbed `chrome` and
realistic fixtures, 26 pictures at 360 and 1000 px in light and dark, failing on page errors, overflow,
injected markup, `[object Object]`/`NaN`, a malformed flow that will not open, or an arrow key that
switches Auto-attach. Looking at those pictures is how the "none" and malformed-flow defects were
confirmed fixed.

**Runs on 3.0.0 (2026-09-25).** `unittest.mjs` 638 in 11 suites, `selftest.mjs` 136, `extensiontest.mjs`
82, desktop 14 files, `engine2-livetest.mjs` 366/0 (327 s), `isolated-livetest.mjs` 198/0 on Edge
(daemon, extension and shim all report 3.0.0), `panel-render.mjs` clean, and the installer
`G9-Setup-3.0.0.exe` (103,620,667 bytes, unsigned) with `test:packaged` 7/7 and a payload identical to
the repository.

Version 3.0.0 in `package.json`, `extension/manifest.json`, `desktop/package.json` and
`desktop/package-lock.json`; the docs that name the release moved with it.

### 2026-09-25 — v2.0.3: the popped-out window that opened behind the person's own

**Reported from real use.** The owner pressed **⧉ Pop out tab** in the side panel: the tab disappeared
from its window and no new window appeared.

**Cause (`extension/tools/tabs.js` `popout`).** The window was created unfocused, the size of the source
window (usually maximised) and 40 px lower, and then the person's window was raised again. The new
window therefore landed entirely behind the person's window. That is worse than confusing: on Windows a
window that another window covers completely is occluded, and Chromium stops rendering it unless the
`WindowOcclusionEnabled` policy is off (§2.8.1) — the opposite of what popping out is for. The
Engine 1 live test pops out through an agent's call, with an explicit size, in a headless browser
where no window can cover another, so it could not see this.

**Fix: two callers, two rules.**
- **The person** asked to see the window. The panel command `popout` (`extension/sw.js`, sent by
  `extension/panel/session.js`) calls `popout(tab, {focus:true})`: the window is created focused, in
  front, and nothing is handed back. As before, the panel's own button works while Stop is on.
- **An agent** (`browser_tabs action:"popout"`) must not take the person's keyboard. Its window is
  created unfocused, and focus goes back to the person's window only if the browser moved it (that
  window no longer reports `focused`): raising it unconditionally is exactly what buried the popout.
  The tool's `focus` argument now also applies to popout (`mcp/tools.js`): `focus:true` creates the
  window in front and focused.
- **Default geometry** (`popoutGeometry(source, {width, height, left, top})`, exported): half the
  source window's width and three quarters of its height, clamped to 640–1280 × 480–1000, at the
  source's top-right: its right edge 24 px inside the source window's, its top 72 px below the source's
  top. It is visibly a separate window, never an exact copy of a maximised one. Explicit
  `width`/`height`/`left`/`top` win.
- **The result says what the page says.** It carries `focused`, and `visible`: `document.visibilityState`
  read in G9's world about 600 ms after the move (`POPOUT_VISIBILITY_SETTLE_MS`; occlusion is computed a
  moment after the window settles), `null` when it could not be read. The note says that a window
  another window covers completely stops rendering on Windows unless the policy is off (docs/INSTALL.md);
  when `visible` is false it says the window is not visible now and names the remedies
  (`browser_tabs action:"focus"`, or the policy). The panel shows a `visible:false` result as a failure,
  with that note, and the help text under its button says the same (`extension/panel/panel.html`).

**Tests.** `setup/unit/seam.test.mjs` drives `sw.js` over its stubbed `chrome`. The panel's popout
creates the window with `focused:true` and `state:'normal'`, never raises the person's window over it,
and reports `focused:true`, a `visible` field and a note that says not to minimise the window; it also
works while Stop is on. The default geometry for a maximised 1936×1048 source is narrower and shorter
than the source and inside it, and explicit geometry comes back unchanged. An agent's popout (a relayed
`browser_tabs` call) is created with `focused:false`, does not raise the person's window, and reports
`focused:false`. The seam suite's count grows with these checks. **Not measured:** no harness puts a
window on screen, so the reported case, a real maximised window in front, has not been driven in a real
browser. The isolated Engine 1 live test's popout section (16) checks the move itself: headless, with
an explicit size, no reload, the same tab handle, input delivered.

**Found while testing the fix, and fixed in the same release.**
- **The browser refused the new placement outright.** The first run of the Engine 1 live test on the
  fix failed at section 16 with `Invalid value for bounds. Bounds must be at least 50% within visible
  screen space`: headless Edge there runs a window larger than its virtual screen, so the top-right
  placement fell off-screen and the tab stayed where it was. The extension cannot see the screen (that
  needs the `system.display` permission), so `createPopoutWindow` now tries the preferred placement,
  then the same size at the source window's top-left plus 40 px, then the size alone, then the
  browser's own choice. Only an explicit `left`/`top` from the caller is kept as given; a size alone
  still gets the fallbacks (the live test asks for 900x700 and no position). The seam suite's stub now
  answers Chromium's real refusal on demand and checks each step of that chain.
- **An agent's `focus:true` never reached the extension.** `daemon/router.js` forwarded only
  `width`/`height`/`left`/`top` for popout (found by the 2.0.3 documentation audit), so the
  argument the tool description advertises silently did nothing. It now travels, and a new router test
  in `setup/unit/daemon.test.mjs` checks that focus and geometry reach the extension with the Chrome tab
  id and that the result comes back as a handle.
- Smaller corrections the same audit found: the agent instructions said "the last four snapshots of a
  page" stay usable where `refs.js` keeps four **per caller**; the hidden-tab refusal now also says a
  completely covered popout stops rendering without the policy; the desktop's Setup view said the CfT
  download is about 150 MB (it is 205 MB); `runner/g9.mjs` help now states the real defaults of
  `--browser` and `--port` and lists `--token`; `engine/launch.js` documents close()'s full result.

**Runs on 2.0.3 (2026-09-25).** `unittest.mjs` 621 in 10 suites, `selftest.mjs` 136,
`extensiontest.mjs` 78, desktop 14 files, `engine2-livetest.mjs` 366/0, `isolated-livetest.mjs` 196/0 on
Edge with the real popout (a new window, no reload, the same handle, input delivered, not minimised),
and the installer `G9-Setup-2.0.3.exe` (103,591,675 bytes, unsigned) with `test:packaged` 7/7 and a
payload identical to the repository.

Version 2.0.3 in `package.json`, `extension/manifest.json`, `desktop/package.json` and
`desktop/package-lock.json`; the docs that name the release moved with it.

### 2026-09-24 — v2.0.2: three defects that only a flaky test could find

A full re-run of the suites on the untouched 2.0.1 tree failed where the same suites had passed twice
the day before. Three tests were flaky. Chasing each to its root found **three real product defects**
and six tests that measured the machine instead of the product. Nothing here was visible in a single
green run, which is the point worth remembering: on this codebase a flaky test has twice now been a
defect wearing a disguise.

**Defect 1 — replay could miss a late error (`extension/tools/replay.js`, `awaitQuiet`).** The quiet
window after the last step treated `pending` — a LEVEL, the count of requests still in flight — as if it
were an edge, and stamped the clock from the last poll that still saw one. `observe.js` moves no counter
when a request FINISHES, so nothing reset that clock afterwards: with a slipped poll, replay returned a
quiet verdict from a moment when the page demonstrably was not quiet, before the late response existed.
That is exactly the surprise-attribution race the function was added to close. The clock now cannot start
until a poll has observed `pending === 0`. Measured: `setTimeout(20)` on this machine lands at 21–168 ms
under load; a paired A/B of old against new, 30 blocks of 20 runs each under load, reproduced the
reported failure almost verbatim on the old code (29/30 blocks) and 30/30 clean on the new.

**Defect 2 — the evidence prune raced itself (`daemon/evidence.js`).** `startRun()` fired `prune()`
without awaiting it, so an explicit `prune()` or another run starting overlapped it and two recursive
deletes walked the same run directory. Measured under load: 16 of 80 concurrent pairs had the first
`rm` fail with EPERM, and in 5 of 80 the directory was still on disk when that call returned — so
`await prune()` did not mean pruned, and `settings.evidence.keepRuns` was silently not honoured.
Prune is now serialised through a chain, and the delete carries the same short Windows EPERM/EBUSY
retry that `paths.js` already uses for renames. A/B under load: 16/80 → 0/80 failures.

**Defect 3 — a launched-engine watch could be overtaken by its own stop (`engine/manager.js`,
`daemon/daemon.js`).** `#watch` awaited `engines.watch(handle, true, …)` after its cancel guard, and an
unwatch arriving during that await reached `EngineManager` first. `EngineManager.watch` had no ordering
of its own: every guarantee came from `extension/lib/screencast.js`'s private per-tab chain, a module it
imports optionally and treats as absent-able. Driving a real daemon with a gated screencast layer left a
tab `running=true` with zero consumers and zero watchers. `watch()` is now a thin wrapper over a
per-(tab, consumer) chain, so the last request wins for the whole of a watch — the map, the pointer
subscription, the watchdog and the screencast — not just the CDP calls. The opposite state needed no race
at all: when the start rejected, the daemon logged it and still answered `{watching:true}`. It now undoes
the watcher and answers `{watching:false, problem}`; `desktop/renderer/views/watch.js` shows that reason
instead of waiting forever for a first frame, and DAEMON_PROTOCOL §6 documents the field.

**Also in 2.0.2 — the browser close budget, sized from a measurement (`engine/launch.js`).** `close()`
sends `Browser.close` and waits for a clean exit before it kills the process tree, because a clean exit
is what flushes cookies and preferences to the profile: a killed browser can lose the last minutes of a
warmed login. The wait was 10 s. Measured on 2026-09-24 on headless Edge 153 (i9-10900X): a close took
0.4–0.5 s idle but up to 17.9 s with 24 CPU-bound processes running, and one of four loaded closes was
killed at the 10 s mark and exited with code 1. The budget is now the exported `GRACEFUL_EXIT_MS` =
30 000 ms; with it, 12 closes, loaded and idle, needed 0 kills. A browser that is truly hung still
dies, only later, and a caller that needs a fast shutdown passes its own `timeoutMs`. `close()` now also
reports `gracefulMs` (the clean-exit wait) and `closeMs` (the whole close), and its `exit` is never
null once the process is gone: when the child's exit event has not arrived yet it is `{code:null,
signal:null, gone:true}`, because a caller reading `exit.code` would crash on null for a shutdown that
worked. `setup/unit/engine.test.mjs` reports the wait when it asserts that no kill was needed, and
checks both new fields.

**Six tests that measured the machine.** Two in `daemon.test.mjs` hid `evidence.startRun/finishRun` file
I/O behind fixed sleeps of 20 and 60 ms; measured worst case under load was 806 ms. They now wait for the
admin reply, which the daemon sends only after the op completes. Four in `interaction.test.mjs` anchored
a humanized click's schedule at the first SENT event (absorbing its own lateness, so later events looked
early), assumed a saturated dispatcher would never merge (merging when behind is the design), assumed the
first sent sample is the first planned one, and assumed a Stop or a scroll settle inside a fixed window.
Each now asserts the invariant instead of the clock: no event before its due time, every merge justified
by the documented lateness threshold, every sent event a step of the replanned path, and the settle
bounded by the product's own cap. Three budget assertions in `daemon.test.mjs` were rewritten the same
way; one 500 ms poll was replaced by the file's bounded `waitUntil` after a 446 ms worst case was measured.

**Every changed test was proved to still have teeth**: the behaviour it covers was broken on purpose, the
test was shown to fail, and the product file was restored byte-for-byte (hashes verified). One of the new
interaction assertions catches an accumulating-delay regression that no previous assertion caught.

**Runs.** `daemon.test.mjs` 32/32 including 11 under load it generated itself, then 96/96 with the new
launched-watch test. `interaction.test.mjs` 11/11 (6 idle, 5 under 32 CPU hogs on 20 cores) against 0/3
before. `unittest.mjs`, `selftest.mjs`, `extensiontest.mjs`, the desktop suites and the live suites were
re-run for this release; the counts are in §7.

Version 2.0.2 in `package.json`, `extension/manifest.json`, `desktop/package.json` and
`desktop/package-lock.json`; the docs that name the release or the installer moved with it.

### 2026-09-23 — v2.0.1: the final pass, every suite re-run, and a measurement that nearly cost a switch

The 40 findings of the adversarial review were fixed under the frozen 2.0.0 number. This entry is the
pass that ran **every** suite on the tree that carries those fixes, and the bump the owner's standing
rule asks for: **2.0.1** in `package.json`, `extension/manifest.json`, `desktop/package.json` and
`desktop/package-lock.json`.

**No test pins a version any more.** Three did — `panel.test.mjs` (`assert.equal(manifest.version,
'2.0.0')`), `desktop/test/static.test.mjs` and `desktop/test/smoke.test.mjs` — and the bump failed all
three, which is exactly the cost the rule exists to avoid. They now read `package.json` (or
`desktop/package.json`) and compare; `version.test.mjs` already compared the three files and
`lib/version.mjs`. The desktop static test also lost its "the extension has not landed 2.x yet" escape
clause, which would have hidden a stale manifest. The version shows where it must: the panel header
badge and the About tab (from the manifest at runtime), the desktop window title (`G9 2.0.1` in the
render check's window samples), the daemon's `/health`, the shim's handshake, and the packaged
`G9.exe` (ProductVersion 2.0.1.0).

**Offline, on this tree:** unit **618/618** in 10 suites (daemon 95, desktop 181, engine 56, humanize
51, interaction 77, panel 75, platform-cdp 34, seam 16, version 7, world 26); self-test **136/136**;
extension suite **78/78**; `desktop/test/run.mjs` **14/14 files** in 22.6 s; `daemon-contract.mjs`
**15/15**.

**Installer, rebuilt from the final tree:** `G9-Setup-2.0.1.exe`, **103,585,971 bytes**, unsigned,
with `dist/win-unpacked/resources/app-update.yml` present; `npm run test:packaged` **7/7** (no `node`
on the PATH, the packaged shim starts the packaged daemon). `npm run test:render` **passed**: 4
scenarios (empty and populated x dark and light), 23 pictures per populated run, **0 samples on screen
and 0 in the foreground** out of 171 in the last run alone. The pictures were looked at, not only
counted — Runs with its steps, warnings and replay; Watch with a live frame and its LIVE/fps badge;
Setup's five steps; Approvals with a real surprise list; and the empty states. Nothing visibly broken
in either theme.

**Live, on this tree:** Engine 2 live test **366/0** in 330 s; isolated Engine 1 live test **196/0 on
Edge 153.0.4234.32** and **196/0 on system Chrome 153.0.8010.53**, each with its tripwire at 0 hits and
no profile signed in to a browser account; and the stealth matrix **twice** — once over the local
detector page alone and once including the public detector pages — with identical verdicts both times:
**edge-headed-stealth UNDETECTED on the local page**, **0 G9 leaks in any stealth configuration**, and
both human controls detected as they must be.

*Stealth, the full matrix including the public pages (run twice on 2026-09-23, before and after the
version bump, same verdicts):*

| configuration | local page | public detectors |
|---|---|---|
| edge-headless-stealth | 65 pass, 1 fail (0 G9): the HeadlessChrome UA | flagged by sannysoft, creepjs (headless 67 %), browserscan, pixelscan, fingerprint-bot-detection |
| edge-headless-human (control) | 60 pass, 6 fail (5 G9) — must be detected, and was | all of the above plus rebrowser (navigatorWebdriver) |
| edge-headed-stealth | 65 pass, 0 fail, 2 warn | **passed sannysoft, creepjs, browserscan, fingerprint-bot-detection and rebrowser; pixelscan alone said "Automated behavior detected"** |
| edge-headless-stealth-de | 68 pass, 1 fail (0 G9): the UA | local only by design |
| cft-headless-stealth | 63 pass, 2 fail (0 G9): the UA, no Widevine | the five above plus rebrowser (useragent) |
| cft-headed-stealth | 63 pass, 1 fail (0 G9): no Widevine | passed sannysoft, creepjs, browserscan, pixelscan and fingerprint-bot-detection; **rebrowser flagged the brand** |
| cft-headless-human (control) | 59 pass, 6 fail (4 G9) — detected, as it must be | all six |

Headless detection through the `HeadlessChrome` user agent is inherent and not a G9 leak. The run
exits 1 while any configuration is detected, by design.

**Live, on the tree as it stood an hour earlier — identical product behaviour, only the version string
and comments differ (the machine had to be quiet for the timing runs, so they were not repeated):**

*Background-state matrix:* **exit 0** over the full default set — Engine 1 x Edge and Chrome x
active/background/minimized/offscreen/hidemid/hidemidheaded, with and without
`--disable-features=CalculateNativeWinOcclusion`, and Engine 2 x active/background/popup/minimized/
offscreen. Every cell agrees with what the page recorded, including the partial deliveries, which
report themselves as partial.

*Bench (`setup/bench.mjs`, default levels, 5 iterations, shared seeds):*

| contexts | wall s | flow p50/p95 ms | interact p50/p95 ms | click overhead p50/p95 ms | browser priv peak | daemon priv peak | failures |
|---|---|---|---|---|---|---|---|
| 1 | 54.8 | 11,599 / 12,211 | 1,456 / 4,859 | 160 / 165 | 554.5 MB | 69.9 MB | 0 |
| 4 | 55.9 | 11,398 / 12,096 | 1,441 / 4,897 | 157 / 182 | 964.9 MB | 99.8 MB | 0 |
| 8 | 57.7 | 11,618 / 12,588 | 1,477 / 4,975 | 191 / 260 | 1,512.8 MB | 104.7 MB | 0 |
| 16 | 64.1 | 12,668 / 14,233 | 1,544 / 5,208 | 249 / 471 | 2,528.1 MB | 108.4 MB | 0 |
| 16, gated to 8 | 120.0 | 21,880 / 24,730 | 3,408 / 8,969 | 2,572 / 5,183 | 2,505.5 MB | 106.3 MB | 0 |

Recommendation: **maxParallel 8** (16 trips the rule on `select_env` p95 x3.44, +398 ms). The default
stays 8.

*Endurance (`--minutes 10`):* **93 iterations, 0 failures**, iteration p50 11,976 ms / p95 14,465 ms.
Slopes after warm-up: daemon **+0.39 MB/min** private (+0.5 working set), handles **-0.15/min**;
browser **+1.79 MB/min** private (+3.29 working set), process count flat at 20. Listener counts flat
(48 before and after, delta 0 over 47 samples); the single-page-app view flat at 48 listeners with
nodes +2 per pass; `gc()` collected in every sample. Spool: 4,085 frames seen by the UI, 300 on disk.

**Chrome for Testing's 10 Hz renderer: still real, and the switch stays.** The owner allowed the
Windows Firewall prompt for the newly installed `chrome.exe` that had been pending during live round 2
— the leading suspect for CfT's 100 ms frame interval. Two sequential probe runs then read CfT
*without* `--disable-frame-rate-limit` at 10.1 ms, as fast as Edge, and the switch was on its way out
of `KIND_SWITCHES`, tests and documents with it. An interleaved A/B put it back: 4 rounds, each
launching CfT+switch, CfT alone and Edge alone back to back on fresh temp profiles, the same GPU
(ANGLE/NVIDIA) in all 12 launches.

| 4 rounds, one line each | rAF | page mousemove | press hold | per dispatch |
|---|---|---|---|---|
| CfT + `--disable-frame-rate-limit` | 17.3–17.4 ms | 17.2–17.4 ms | 25.7–59.3 ms | 17.3 ms |
| CfT, nothing added | 100.5–100.6 ms | 100.5 ms | 1.4–3.1 ms | 100.5 ms |
| Edge, nothing added | 10.5 ms | 10.6–10.9 ms | 106–108 ms | 10.3–10.4 ms |

8 launches out of 8 at 10 Hz without the switch; 12 out of 12 at 17.4 ms with it. The two 10.1 ms
readings came from a window in which the machine had been running browser suites continuously for half
an hour, and could not be reproduced afterwards. **The lesson is the method, not the number:** a
sequential probe cannot tell a per-binary effect from a per-hour one, and a switch is not removed on a
reading that has not been reproduced against its own control in the same minutes. The removal was
reverted in full — `engine/launch.js`, `engine/stealth.js`, `setup/stealthtest.mjs`,
`setup/unit/engine.test.mjs` and the six documents that describe the switch — and each of them now
carries the A/B table instead of a bare assertion. The press hold in that table is short under the
switch because the probe dispatches on the plan's raw schedule at 17.3 ms per dispatch; it is
`perform` rule 1 (the 80 % rule) that brings the product's own hold back to 60–151 ms.

**Hygiene.** Every run used a fresh temp `G9_HOME`, temp profiles and a random port in 18000–18999;
each suite reported its own cleanup (`leftovers: []`, temp root removed). Port **8765 was never bound,
connected to or probed**: it is still held by the owner's v1 bridge (pid 71076, listening since
2026-09-21), and `setup/matrix.mjs`'s own guard counted `attempts8765: 0`.

### 2026-09-22 — v2.0.0: two engines, one daemon, human input — and what three live rounds found

**The release.** The whole v2 design (§2; phases P0–P8, below) was built as
one release, 2.0.0, by parallel work packages against the contracts in
[docs/ARCHITECTURE_V2.md](docs/ARCHITECTURE_V2.md) (§12 lists who owned which files), then integrated
and driven through three rounds of live suites and fixes on the owner's workstation. §§1–8 above
describe the result; this entry records how it got there. The two 2026-09-22 entries below are earlier
steps of the same release (the round-2 fixes, and the extension suite's migration). Round numbers here
are the live suites' rounds; some code comments call the final fix round's own measurements "round 4".

**The phases (P0–P8), as shipped.** The design split v2 into nine phases, each meant to end with a
working product; the owner asked for all of them in one release instead of 1.8.0 … 2.0.0-rc.

| Phase | Planned | Shipped, and the deviations |
|---|---|---|
| P0 | Relief now: the EXT-01 witness fix, EXT-16 portable tests, fleet policies documented, `minimum_chrome_version` 125 | The witness in G9's isolated world, timed from the end of dispatch; the fixture in `setup/fixtures/`; the browser version in `browser_status`; `docs/INSTALL.md`. The policies are written per user by the desktop wizard (HKCU only, never HKLM, with an undo); `ExtensionInstallForcelist` is described, not set up (no CRX is shipped); `BackgroundTabFreezingEnabled` is read by Chrome only from 155 |
| P1 | The platform seam (R2/R3), no behaviour change | `platform.js`, `platform-extension.js`, `platform-cdp.js`; the flat TOOLS table and pipeline in `extension/tools/index.js`; the CDP event fan-out in `tools/events.js`. Images decode through `platform.image` inside the launched browser (Node has no decoder and D11 forbids one); the R2 check is in `setup/unit/seam.test.mjs` |
| P2 | Engine 2: launcher, pipe CDP, the CfT fetcher, in-process tools, a first headless live test | `engine/cft.js` (pinned, hash-verified, `tar` with a JS zip fallback, IPv6 retry, ranged resume), `find.js`, `launch.js`, `pipe-cdp.js`, `profile.js`, `stealth.js`; `setup/engine2-livetest.mjs`. Contexts live in `engine/manager.js`. The switch list differs from the design, each change measured ([engine/README.md](engine/README.md), D-a above). The locked-session run was not done: locking the owner's workstation is not allowed |
| P3 | Daemon and shim: many agents, ownership, tab registry, handoff, popout; the runner through the daemon; the bridge deleted | `daemon/` (registry, ownership, per-tab queues, global and per-agent halt, handoff, popout, scheduler, evidence, extension update), `mcp/shim.mjs`. `bridge/src/server.js` stays as a forwarder so v1 MCP configs keep working; the shim retries 8 s, not 5; web origins are refused (403); D-c. Schedules run inside the daemon, so they fire without the desktop app. The popout was fixed in 2.0.3 (§8.2) |
| P4 | Extension v2: modes removed, attach = full access, `chrome.downloads`, isolated-world witness and recorder, popout button | As planned, plus D-b (the stricter level wins; in the extension only the panel's Stealth is a floor) |
| P5 | Humanize engine, stealth levels, stealth self-test, calibration | `extension/humanize/` (an unpacked extension cannot import outside its folder), the dispatcher `extension/lib/humanize.js`, `engine/stealth.js`, `setup/stealthtest.mjs`, `calibrate_humanize`, [docs/HUMANIZE.md](docs/HUMANIZE.md), [docs/STEALTH.md](docs/STEALTH.md). On Engine 1 stealth applies the input rules only (the debugger infobar changes the viewport on every load) |
| P6 | Evidence v2: screencast spool with the pointer track, watch stream, WebM export, download verification, bounded evidence | All but the `report.html` frame player and bounded/pageable console and network evidence (EXT-10) |
| P7 | Desktop shell, installer, updater, MCP registration, extension updater | Electron 44.4.3, electron-builder 26.15.3, electron-updater 6.8.9; the per-user NSIS installer. Unsigned (§8.6); no update feed exists, so the updater is tested with a fake; a real install, UAC prompt, update and MCP registration against real client configs were not exercised |
| P8 | Background-state matrix, endurance, parallelism limits, docs sync | `setup/matrix.mjs`, `bench.mjs`, `endurance.mjs`; versions, `versionMismatch` and `capabilities` in `browser_status`. Endurance ran 10 minutes per run, not 8 hours; the locked-session and virtual-desktop states were not measured; `capabilities` is configuration, not a probed per-feature set; `maxParallel` stays 8 |

**What was built.**

- **The platform seam** (`extension/lib/platform.js`, `platform-extension.js`, `platform-cdp.js`), and the
  tool runtime moved out of `sw.js` into `tools/index.js` (`runTool`, `status`) and `tools/events.js`,
  so the same tool modules run in the extension and in the daemon (§4.6).
- **Engine 2** (`engine/`): browser discovery by PE version, the Chrome for Testing fetcher (pinned
  153.0.8010.52, sha256 trust-on-first-use, Range resume, IPv4/IPv6 retry — Google's storage answered
  HTTP 403 over IPv4 from this location), `launchBrowser` over `--remote-debugging-pipe`, `PipeCdp`,
  G9 profiles with `warm`, stealth levels, and `EngineManager` in the daemon.
- **The daemon and shim** (`daemon/`, `mcp/`, `lib/`): one `g9d` per machine, many agents, daemon-wide
  tab handles, ownership, per-tab queues, global and per-agent halts, handoff, evidence runs, the
  scheduler, settings, the extension updater; the shim that starts the daemon on demand; the version
  in one place. `bridge/` was deleted except a forwarder for v1 MCP configs; the runner now talks to the
  daemon through the shim with `--engine launched` as the default, and v1's port rule is gone.
- **Extension v2**: modes, workspace allowlist, cookie scoping and title withholding removed; attach =
  full access; auto-attach; `chrome.downloads`; every internal evaluation in the isolated world `g9`;
  popout; handoff ("Send to background"); the panel rewritten around the daemon, agents, input level,
  Stop and activity; the version in the panel title, badge, About tab and welcome page.
- **Human input**: `extension/humanize/` (pure, seeded) and the dispatcher `extension/lib/humanize.js`,
  `pointer.js` (cursor track), `screencast.js` (shared), the rebuilt witness with delivery states,
  calibration from recordings (`calibrate_humanize`).
- **Evidence v2**: `G9_HOME/runs/<runId>/` with frames, `pointer.jsonl`, downloads verified on disk, the
  live watch stream to UI clients.
- **The desktop** (`desktop/`, Electron 44.4.3): tray, Watch, Runs, Approvals, Engines, Agents, Schedule,
  Settings, Setup wizard (browsers, CfT, profile warm, HKCU policies with Undo, MCP registration, the
  extension step), updater (generic feed), per-user NSIS installer.
- **Tests**: ten unit suites under `setup/unit/` run by `setup/unittest.mjs`; `selftest.mjs` rewritten
  around a real daemon and two shims; `extensiontest.mjs`, `livetest.mjs` and `isolated-livetest.mjs`
  migrated; new `engine2-livetest.mjs`, `stealthtest.mjs`, `matrix.mjs`, `bench.mjs`, `endurance.mjs`.
  Docs: ARCHITECTURE_V2, DAEMON_PROTOCOL, STEALTH, HUMANIZE, engine/README, desktop/README.

**Decisions taken during the build** (ARCHITECTURE_V2 §0; D-a answers the owner's requirement that stealth runs be undetectable):

- **D-a — the `AutomationControlled` switch, at stealth only.** Measured on Edge 153.0.4234.32, Chrome
  153 and CfT 153.0.8010.52: `--remote-debugging-pipe` itself makes `navigator.webdriver === true` on every
  Engine 2 page, headless or headed, with no `--enable-automation`; only
  `--disable-blink-features=AutomationControlled` clears it, and `Emulation.setAutomationOverride({enabled:false})`
  does not. The designed switch list (P2) forbade it. Decision: `stealth.launchArgsFor('stealth')` passes it;
  `off`/`human` refuse it in `extraArgs` and warn that webdriver is true; `--enable-automation` is refused
  always. Also every headless launch gets `--screen-info` (headless otherwise reports an 800×600 screen).
  Result (live round 3): webdriver `false` in 40/40 stealth runs, a native getter, not an own property;
  `true` in 14/14 human controls.
- **D-b — the stricter level wins.** The effective input level is the stricter of the call's `humanize`
  and the tab's `stealthFor`: a stealth context with `humanize:"human"` had fallen back to `DOM.focus` and
  programmatic scrolling. In the extension the first reading made the panel's Input setting (default
  Human) a floor, so an agent's `humanize:"off"` became human input; the converge stage flagged it for
  the owner. The shipped semantics, as `platform-extension.js` documents them: **only Stealth is a floor** in the extension (`stealthFor` is
  `'stealth'` only when the panel says Stealth), the panel's setting is otherwise the default level.
- **D-c — `instanceId` resume.** MV3 restarts the worker when it likes and the desktop reloads the
  extension after every update; each reconnect reshuffled every handle and agents lost their tabs
  mid-task. The extension now says which extension it is (`instanceId`, `loadId`, open tabs); the
  daemon parks a disconnected one for 10 minutes and gives its engine id, handles, claims and names back.

**Deviations from the design, and why** (all recorded in ARCHITECTURE_V2 §0 or in the code that carries them):

- `humanize/` lives under **`extension/humanize/`**: an unpacked extension cannot import outside its
  folder; the daemon imports it from there.
- **`bridge/src/server.js` stays as a forwarder** to `mcp/shim.mjs`: every QA machine's MCP config written
  by v1's `install.ps1` points there.
- **One release, 2.0.0**, instead of 1.8.0 … 1.14.0: the owner asked for the whole design in one release.
- **Web origins are refused** (403 on an `http(s)://` Origin): a page in the person's own browser is not
  local; without it any site could drive every tab (§5).
- **`platform.image`** instead of OffscreenCanvas in `visual.js`: Node has no image decoder and v2 has no
  dependencies, so Engine 2 decodes inside a hidden page of the launched browser.
- Launch switches beyond the designed list ([engine/README.md](engine/README.md)), each with its measurement in `engine/launch.js`: `msImplicitSignin`
  disabled, `--disable-sync`, `--disable-component-update` omitted at stealth and for warm,
  `--disable-frame-rate-limit` for CfT only, `--screen-info` with a taskbar work area.
- Auto-attach with **`waitForDebuggerOnStart:true`** (the design said `false`), resuming every held target (§4.11).
- Humanize profiles inlined as import-free objects in `extension/humanize/profiles.js` rather than
  `profiles/*.json` (ARCHITECTURE_V2 §6); calibrated profiles in `platform.storage.local`.

**Defects the live suites found, and what was done.** Live round 1: the Engine 1 suite (5 full runs,
Edge 153.0.4234.32 headless). Round 2: the stealth self-test (3 matrix passes, 50 local runs, 96 public
evaluations) and the P8 bench/matrix/endurance. Round 3: all five live suites again (Engine 1 on Edge,
branded Chrome and CfT; Engine 2; stealth; bench/matrix/endurance; desktop). Fixes followed rounds 2 and 3;
the round-2 fixes have their own entry below.

- **Blocker — Edge signed every new G9 profile into the owner's Windows account and synced it.** Edge
  153.0.4234.32 signed the first profile of every NEW user-data-dir into the Windows primary account
  (WAM single sign-on) within seconds of its first start and turned full sync on: passwords, history,
  open tabs, extensions (7/7 automation profiles, 13/13 test profiles, every launch longer than ~20 s;
  Local State `info_cache.user_name` set, `consented_to_sync` and `sync.has_setup_completed` true).
  `--no-first-run` did not prevent it, and a pre-seeded `signin.allowed=false` was rewritten to true by
  Edge. Consequences measured: synced extensions injected scripts (globals, DOM nodes, main-world calls)
  into stealth pages and then degraded a headed engine until input stopped arriving (hovers 30–62 s);
  without `--disable-sync` a sync-confirmation dialog and two onboarding tabs appeared ~75 s after
  launch and cost ~1.7 GB. Fix: every launch of every browser disables `msImplicitSignin` (measured: fresh profiles stay signed out, 6/6) and passes
  `--disable-sync`; `profile.signInState` (booleans only, no identity read) is checked before every
  launch — refused at stealth, warned otherwise; the harnesses that spawn Edge themselves carry the same
  switches. Round 3: 0 signed-in profiles across 40 Engine 1 profiles, every Engine 2 profile of the
  matrix, 16 bench level-runs, 2 endurance runs, the Engine 2 suite's profiles and 26 stealth
  configurations. **What it means for the owner:** the profiles involved were temporary and were deleted
  by the harnesses, but what synced *into the owner's Microsoft account* from those sessions cannot be
  undone from code — pages the round-1 and round-2 suites opened (the 127.0.0.1 fixtures, public
  detector pages) may be in the owner's synced Edge history; checking it is the owner's call. Any G9
  profile that an earlier v2 build launched stays signed in until someone signs it out; the launch check
  says how (`browser_engine action:"warm"`, then the browser's profile menu → Sign out).
- **Hidden-tab input hung, then was misreported.** Round 1: human/stealth input to a hidden background
  tab ran until the daemon's 120 s deadline (5/5 runs; a diagnostic was still dispatching at 330 s with 66
  trusted mousemoves and 0 clicks), and the error blamed a "JavaScript dialog"; round 2 found the first
  error blamed a screencast nobody was running (30/30 hidden-tab cells). Raw CDP: `mouseMoved` to a
  hidden page returned after ~5 s or not at all; key events DID reach its focused field (10/10, round 3).
  Fix: every input action asks for visibility first and sends nothing to a hidden page (policy (b) for
  keys), naming the agent's own remedies (focus, popout, handoff) — the round-3 wording no longer says
  "ask the user" or "headed Chromium"; a tab hidden part-way reports `partial` with the events sent and
  the page's measured scroll delta (round 3: a 2000 px scroll hidden 0.55 s in had delivered 3–6 notches
  and 300–600 px, yet said "never received"). Round 3 re-check: 20/20 hidden rows refused in 7–42 ms with
  nothing reaching the page; after the partial fix, reported px = page px 4/4. The relay-timeout text
  still guesses a dialog (open, §8.2).
- **The witness called delivered input lost, and lost input delivered.** Round 1/2: the verdict was
  timed from arming, so a slow dispatch outran it — an Engine 2 CDP trace showed the witness armed at
  t=20.7 s, ~64 moves and 19 notches at ~1 s each, the press at t=84.4 s, and the click reported
  not-delivered although the page had it (3/3). Round 2 also found presses on a page that cancels
  `pointerdown` reported lost (it gets no `mousedown`), and hovers/clicks that landed on another element
  after a scroll reported delivered (CfT 22/22 misses). Fix (§4.3a): timed from the end of dispatch,
  10-minute safety net answering `expired`, pressed by `pointerdown` OR `mousedown`, armed on the element
  to report `missed` with what was hit; the delivery state tagged into the error text and carried as
  protocol fields (round 3 found it was not machine-visible). Re-check: a minimized-window Engine 2 click
  reported delivered after 28–29 s, matching the page; cancelled pointerdown delivered at every level; a
  runaway button reported `missed` naming the track, 16/16, never repeated.
- **`window.open()` wedged its opener on Engine 2.** Round 3: the click that opened a popup failed after
  21–25 s ("Input.dispatchMouseEvent did not return after 20s") in 18/18 stealth runs and 7/7 Engine 2
  runs, the popup stayed at `url ''`, the opener's next goto timed out. Raw probe on Edge and Chrome 153:
  under browser-level auto-attach with `waitForDebuggerOnStart:false` the click did not return within
  15 s; with no auto-attach, 51 ms; resuming held targets, 37–46 ms. Fix: every target attached with
  `waitForDebuggerOnStart:true` and resumed after its preparation hook has SENT its commands (§4.11) —
  36–48 ms in the fixer's probes; the same mechanism made page-opened tabs capture their first load's
  network and carry the persona from their first script. Final: popup checks passed in all 15 stealth
  popup runs; Engine 2 suite 366/0.
- **CfT ran at 10 fps.** CfT 153.0.8010.52 ran `requestAnimationFrame` every 100.5 ms (Chrome
  153.0.8010.53 and Edge 10.5 ms), headless and headed; input is frame-aligned, so humanized paths reached
  pages as 100 ms jumps (mousemove median 100.4–100.6 ms) and each dispatch took ~85 ms; CfT press holds
  collapsed to 1.9–8.1 ms (20/22 runs). Ruled out: `--disable-gpu-vsync`, SkiaGraphite/TreesInViz off,
  restored tabs. Fix: `--disable-frame-rate-limit` for CfT only (rAF 17.4 ms; on Chrome/Edge it would
  slow them to 17.4 ms) plus the dispatcher's 80 % interval rule. Measured after: CfT mousemove median
  16.8–17.3 ms, stealth press holds 60–151 ms (Edge and CfT, round 3). Root cause not isolated (§8.1).
- **Cross-site iframes ignored the persona.** Round 3: under a de-DE/Europe/Berlin persona the
  out-of-process frame reported locale `de` and the host's own time zone (7/7 runs). Fix: overrides and a
  nested auto-attach sent to the held child's own session (`#prepareChild`); a cross-site popup gets its
  locale again at commit. oopif-vs-top then passed in every configuration of 3 local passes. Round 2 had
  also found a launch locale changed only `Intl` (navigator.languages and Accept-Language stayed en-US,
  6/6): the locale now becomes the profile's `intl.accept_languages` and is saved with the timezone as
  the profile's persona.
- **Pointer pressure 0.** Every CDP press read `pressure 0` (50/50 runs, round 2); a real mouse reports
  0.5 while a button is down. Fix: CDP `force: 0.5` on every mouse event while a button is held (`MOUSE_PRESSURE`). Round 3: 0.5 at
  every level in every run, both engines.
- **Screenshots were visible to the page.** Round 2: a full-page capture made the page see 1–2 resizes
  and a transient 1×1 viewport in 27/50 runs; an element capture `scrollIntoView`ed and left the page
  scrolled. Fix (§6.3 `capture.js`): wheel reach + viewport clip; full page refused at stealth, disclosed
  at human. Round 3: 0 resizes and 0 scrolls at stealth (520 read-tool calls in the sweep with 0
  page-visible change).
- **Widevine was missing.** Round 3: `requestMediaKeySystemAccess('com.widevine.alpha')` rejected in
  9/9 Edge runs (PlayReady worked). Raw probe on Edge and Chrome 153: `--disable-component-update`
  prevents the CDM from ever loading, even when already in the profile. Fix: the switch is omitted at
  stealth and for warm; eme-widevine then passed in every Edge stealth run. Side effect measured: with
  updates on, Edge records the machine's external-extension registrations as disabled permission-only
  stubs (no files; nothing runs in a page).
- **Also fixed in these rounds:** `goto` cut `Page.navigate` at a fixed 20 s and called a slow server
  "stuck" (4 public gotos failed at 20.01 s while 8 others took 20.1–49.3 s; a 25 s time-to-first-byte
  now returns after 26 s); headed windows 1920×1080 on a 1032 px work area (now fitted to the work
  area, position untouched, never activated); an Engine 2 tab behind a page-opened tab took 20.9 s per
  click (now brought to the front on headless engines: 4.9 s; warned on headed); a minimized window's
  stalled capture blamed "a compositor stall" (now names the minimized window); CfT restored previous
  tabs on every relaunch (session restore cleared, strays closed and reported); headless screen with no
  work area; Edge's `edge://downloads-hub/` tab; cookie values cut to 77 characters; `inspect frames`
  missing out-of-process frames; waits holding a `maxParallel` slot; the obstruction check blaming an
  ancestor for an element that had moved; replay `result.json` dropping warnings; surprise counts varying
  between identical replays (3, 3, 2, 3, 3, 3 → late evidence now awaited); a watch on a hidden tab
  freezing with no signal (`watchStatus`); the Watch picker empty on a second visit (desktop).
- **A regression the fixers introduced and caught:** moving the tool layer's attach earlier made the
  Runtime console probe hit in every stealth run (the attach ran before the context's stealth level was
  registered); the stealth self-test caught it and the attach moved to `openTab` only.
- **Incidents, recorded honestly.** One build agent's leftover check made a bare TCP connect to
  127.0.0.1:8765 (no bytes sent) against the test rule; a v1 bridge replaces its client only on a
  completed WebSocket upgrade, so it could not have affected the owner's session. Every run since used
  18000–18999; the matrix/bench guard proxy recorded 0 attempts on 8765 and the isolated test's tripwire 0
  connections. A daemon build report states the repository's `.mcp.json` was pointed at `mcp/shim.mjs`;
  that was not re-verified here (MCP configs are not touched by these runs). While a v1 bridge holds 8765,
  a v2 shim fails every tool naming the bridge's pid; a v1 extension is refused by a v2 daemon (4001)
  until the v2 extension is loaded.

**Measurements** (2026-09-22; Windows 11 Pro 10.0.26200, Intel i9-10900X with 20 logical CPUs, 63.7 GB,
Node 22.15.0, G9 2.0.0, Edge 153.0.4234.32, Chrome 153.0.8010.53, CfT 153.0.8010.52; other suites shared
the machine, 27–57 % busy):

- **Bench** (live round 3, three passes 07:59–08:59 UTC; Engine 2 headless Edge, human input, 5
  iterations, shared seeds, maxParallel 64): 815 humanized flows, 0 failures, every interaction
  delivered. One context: flow p50/p95 11.6–12.0 s / 12.4–12.5 s, humanized click p50 ~1.4 s of which
  143–149 ms is G9's overhead, screenshot p50 54–68 ms. Throughput (flows/min): 1 context 5.2–5.3, 4:
  20.6–20.7, 8: 39.8–40.5, 12: 57.9–58.2, 16: 73.4–74.4, 24: 101.1; 16 contexts gated to 8 give 39.8–40.3
  (the gate caps exactly). Browser ≈395 MB idle + ≈128 MB per loaded context; daemon 104–112 MB
  private, flat. The maxParallel rule gives **12** on this machine class (16 failed only on the select
  step's p95 in 2 of 3 passes; 24 failed flow p95 ×1.27; 16 contexts used ~1.9 cores). The default
  stays 8. Engine 2 launch: 737–1046 ms. Round 2 → after fixes: a gated `wait_signed_in` p50 535–700
  ms → 19 ms (waits no longer hold a slot).
- **Matrix** (live round 3, 2 full passes, Engine 1 real extension on Edge and Chrome; Engine 2
  daemon-launched Edge): Engine 1 visible states (active headless; off-screen headed with occlusion
  disabled) delivered every operation (142–147 animation frames per 1.5 s in round 2); hidden
  states (background tab ±switch, minimized ±switch, off-screen without the switch) — 20/20 rows `hidden`, every input refused in 7–42 ms, nothing reached
  the page, `watchStatus` exactly `["hidden"]`. Ground truth on the harness's own pipe: `mouseMoved` no
  answer within 5 s on every hidden page, a bare `keyDown` landed 10/10, `captureScreenshot` no answer
  within 5 s on a minimized window but 44–487 ms on background/off-screen tabs. Type hidden 1.55 s in:
  30/30 keydowns landed, reported delivered (correct). `--start-minimized` not honoured (8/8). Engine 2
  active headless click/type/wheel/screenshot 5408/4505/1407/91 ms and 5442/4511/1400/69 ms; minimized
  headed: delivered, click 28–29 s. After the round-3 fixes (hidemid and Engine 2 active/popup/minimized
  only): exit 0 — popup state click 4.9 s, type 5.1 s, screenshot 100 ms with a BEHIND warning. Not
  measured: a locked session, another virtual desktop.
- **Endurance** (live round 3, 2 × 10 min, 2 contexts of which one a single-page app, live watch on,
  30 s samples): 90 and 89 iterations, 766 and 757 steps, 0 failures; iteration p50/p95 12.4/15.0 s.
  JS listeners read after `gc()`: flow minus fresh load = 0 in 46/46 and 45/45 readings; the SPA stayed at
  exactly 47 and 48 listeners. A humanized `type` with `clear:true` keeps 1 DOM node alive per call
  (as does `clear` alone). Round-2-fixed code, 2 × 10 min: 0 failures, daemon +0.58/+0.43 MB/min,
  browser +3.0/+1.0 MB/min. No 8-hour run.
- **Stealth.** Round 3 (54 local runs, 59 public evaluations, before the round-3 fixes): Runtime probe 0
  hits in 40/40 stealth runs (every control hit, 55–63 per run); main world: 0 G9 globals, nodes,
  main-world calls, listener stacks or untrusted events, cross-site frame included; press hold 60–151 ms,
  pressure 0.5, keydown-interval medians 123.7–201 ms, wheel-notch interval medians 82–123 ms; headless
  screen 1920×1080 with avail 1920×1032; exactly one tab at the end 26/26; 0 signed-in profiles 26/26.
  Public pages: headless stealth detected by the user agent on every page; headed Edge passed sannysoft,
  creepjs, browserscan, Fingerprint and rebrowser and failed pixelscan (unexplained; headed Chrome passes
  2/2); headed CfT 5/6 (rebrowser brand). Final, after the round-3 fixes (local page only): 0 G9-class
  leaks in every stealth configuration, **headed Edge stealth UNDETECTED**, headless stealth detected
  only by the HeadlessChrome UA, controls detected. Host facts, not G9: the machine's time zone does
  not match where its public IP geolocates (a hosting range), which pixelscan flags on every run.
- **Engine 1** (live round 3): 204/0 (195 + 9 harness) on the final files; full runs passed 9/9 on Edge,
  7/7 on branded Chrome, 4/5 on CfT (a popout flake). Handoff 1.8–3.0 s (2 cookies incl. HttpOnly, 1
  localStorage item seen by the Engine 2 page); popout kept `timeOrigin` and JS state (no reload); a
  929-character JWT cookie came back whole; Stop mid-typing ended the call 37–94 ms later; issue
  video 72–87 frames with `pointer-track.json`.
- **Desktop** (live round 3): unit 14/14 files in 9 runs (176 checks on the final tree), contract
  15/15 ×8, installer built 3×, `test:packaged` 10× with no `node` on PATH, render check 6 runs / 24 off-screen windows / 0 on screen;
  the payload equalled the repo file for file. The final installer was rebuilt after the round-3 fixes
  (103,541,901 bytes, unsigned; `platform-cdp.js` and `manager.js` in it checked byte-identical).

**Final validation** (after the round-3 fixes): unit 580 in 10 suites, self-test 130/130, extension
suite 71/71, desktop 14/14 files + contract 15/15 + packaged 7/7, Engine 2 live 366/0 (348 s), isolated
Engine 1 live 195/0 twice, CfT Engine 1 sections 12+16 ×20 PASS, stealth local matrix as above, matrix
(hidemid + Engine 2 subset) exit 0. Mutation checks: each fixer re-introduced its defects in scratch
copies (19 mutants in round 2, 11 in the interaction review, 18 for the extension suite, 8 for the
panel); each failed the intended test. The version stayed 2.0.0 throughout (the release contract,
enforced by `version.test.mjs`); the reports record no commits.

**What remains open** is §8: headless detectability by UA, pixelscan on headed Edge, the Engine 1
infobar, hidden-tab keys as policy, minimized headed Engine 2 at ~1 frame per 1.5 s, the relay-timeout
wording and overlap, locked-session/virtual-desktop/8-hour runs not measured, bench/endurance/public
stealth/full matrix/render check not re-run on the final tree, the unsigned installer and never-exercised
update server/UAC path, maxParallel 8 vs a measured 12, and the version-bump rule after the release.

### 2026-09-22 — v2 live round 2 fixed: Edge stops signing itself in, the witness says where input landed, a slow browser keeps its rhythm

Two live suites (the stealth self-test, and the P8 bench/matrix/endurance) measured the v2 build and
found 19 defects. Every one is fixed or answered below; version stays 2.0.0 (release contract).

- **Blocker — Edge signed every new profile into the Windows account** and turned full sync on
  (passwords, history, open tabs, extensions); synced extensions then injected scripts into every
  stealth page. Every launch now carries `--disable-features=msImplicitSignin` (measured: new
  profiles stay signed out) and `--disable-sync`; `profile.signInState` (booleans only, no identity)
  is checked before every launch — refused at stealth, warned otherwise, because a profile already
  signed in stays signed in. engine/README.md's "did not sign in … checked once" was wrong and says so.
  The harnesses that spawn Edge themselves (isolated live test, matrix) carry the same switches.
- **The input witness** is armed ON the element for ref actions and answers where the event landed:
  `delivery:"missed"` (an error naming the element hit) instead of "delivered" when a press or hover
  reached another element; presses are witnessed by pointerdown OR mousedown (a page that cancels
  pointerdown gets no mousedown — a delivered click used to be called lost); the in-page safety net is
  10 minutes and answers "expired", never "not delivered" (a slow dispatch outran the old ceiling and a
  received click was reported lost after 85 s).
- **Hidden tabs**: every input action asks for visibility first and sends nothing to a hidden page (the
  first error used to be a wheel "screencast" stall with no screencast running, then a 120 s "dialog"
  timeout); a wheel stall names the cause actually present; a live watch of a hidden tab tells the
  viewer (`watchStatus`), and the desktop's Watch view says "not live".
- **Timing**: `perform()` keeps at least 80 % of every interval that ends in a press, release, key or
  notch, and merges overdue pointer moves instead (CfT press holds were 2–8 ms); presses carry pressure 0.5;
  scrolls return only once the page has stopped moving, and a reach settles before aiming (hovers and
  clicks after a scroll missed); Chrome for Testing gets `--disable-frame-rate-limit` (its renderer ran
  at 10 fps on this machine: requestAnimationFrame every 100.5 ms, measured 17.4 ms with the switch).
- **Environment**: the headless screen has a 48 px taskbar work area and a maximized-size window; a launch
  locale becomes the profile's languages (`intl.accept_languages`/`selected_languages`) and is saved with
  its timezone as the profile's persona; a context locale in another language than the profile is
  refused at stealth (measured: a per-tab override does not reach workers); CfT's restored tabs are
  cleared before launch and stray start-up pages closed; the headless launch warning names what was
  measured; docs/STEALTH.md is written.
- **Screenshots** at the human levels bring an element in with the wheel and clip inside the viewport
  (no resize, no scrollIntoView); a full page taller than the viewport is refused at stealth and taken
  with a `pageSaw` note at human; a stalled capture names a hidden, background or minimized cause.
- **Engine 2**: every page G9 opens gets a real window of its own (a second tab in the same window put
  the first one behind it at ~1 frame per 1.5 s); `browser_status` warns about a minimized launched
  window; waits (`navigate wait`, `wait_download`, `tabs wait`) hold no maxParallel slot; the tool
  layer's attach happens before a new tab's first navigation (the first load's requests and its
  cross-origin iframe were missed); Edge's own `edge://downloads-hub/` tab is suppressed by a
  preference and never an agent's default tab.
- Found on the way by the re-run live suites and fixed: `browser_inspect cookies` cut values to 77
  characters (a JWT-sized session cookie came back unusable); `browser_inspect frames` left out
  cross-origin (out-of-process) iframes; the off-level drag centred its drop target and scrolled the
  grip away (the new witness reported that press as missed). The Engine 2 live test went from 289
  passed / 6 failed to 297 / 0; the isolated Engine 1 live test from 1 failure to none.

Regression tests in `setup/unit/` (interaction, engine, daemon, seam, platform-cdp, desktop views); 19
re-introduced defects each failed them. Live: the stealth self-test (both browsers, all
configurations), the Engine 2 and isolated live tests, the P8 matrix and bench — results in the
round's report.

### 2026-09-22 — v2: the extension regression suite migrated and made self-contained (EXT-16)

`setup/extensiontest.mjs` was still v1: it imported `bridge/src/*` and `extension/lib/workspace.js`
(both deleted in v2) and read a FlowSpec from a QA tree outside the repository. Now:

- It runs over the real platform seam (`lib/platform.js` → `platform-extension.js`): the `chrome`
  stub gained a tab/window model, debugger events and `chrome.downloads`, IndexedDB is the fake from
  `setup/unit/world.test.mjs`, and tool calls go through `tools/index.js runTool` as `sw.js` sends them.
- Tests of removed features went with them: the workspace allowlist and its refusals, the redaction
  rule, `requireTabControl`, Follow mode's target, `migrateModeDefault`, bridge port discovery and
  `normaliseDomains`. Tested in their place: a full-access listing keyed by `tabId`, attach making a
  tab current, the §4.1 resolution order, `migrateLegacySettings`, one daemon port (the real `g9d` on a
  held private port exits and names the holder), `/health` CORS for extension origins only, version
  skew through the daemon's router, and a project adapter that still lists `workspaceDomains`.
- Text greps became behaviour where the code allowed it: video capture on a detached tab (the v1
  write-chain deadlock), the HAR body budget, the flow library (no history on disk, a hash that agrees
  with `sw.js specHash`, suites as queries), runner selection and `assertWithin` (lifted from their
  source and run), the witness expression in `node:vm`, watch-before-download, a broadcast with no
  receiver, and the popped-out panel never being taken for the page under test.
- EXT-16: `setup/fixtures/tasks-browse-and-open.flow.json`, written by `toFlowSpec` + `canonicalJson`
  in the shape the test asserts (19 steps, 10 interleaved assertions, each with a wait budget). The
  test also validates it, checks its bytes are canonical, and that the budgets survive `fromFlowSpec`.
- Fixed on the way: the ES-module parse check left a `g9-parse-*` folder in `%TEMP%` on every run;
  the `browser_tabs` schema had lost v1's note that a browser only delivers input to the tab it is
  SHOWING (still true of Engine 1), which the old test pinned — restored in `mcp/tools.js`.

Validation: unit 531 tests in 10 suites, self-test 126/126, extension suite 71/71, `desktop/test` 14
files, all passed. In a scratch copy of the repo, 18 re-introduced defects each failed the extension
suite (one more mutation changed nothing observable). No version bump: the release contract fixes
2.0.0 everywhere.

### 2026-09-21 — the v2 design: two engines, one flow (no runtime change)

Wrote the design and phase plan for G9 v2 (a planning document, retired in 3.0.2 once its lasting
content was in §2), after a research and design discussion with the owner. It fixes twelve decisions: no
Chromium fork; the extension stays for authoring (Engine 1) and a launched real Chrome/Edge/Chrome
for Testing driven over a CDP pipe becomes the execution engine (Engine 2, headless by default); one
local daemon that any number of agents connect to through an MCP stdio shim; the four control modes,
the workspace allowlist, cookie scoping and title withholding are removed (attach = full access,
local trust model); Electron is the desktop shell and installer, never the engine; a shared human
input engine with seeded, reproducible pointer/wheel/keyboard behaviour; the cursor rendered in the
evidence as a pointer track, never in the DOM; stealth as a per-profile level with a self-test.

It recorded the verified Chromium facts behind it (now §2.8): a hidden, minimized, occluded, locked-screen
or other-virtual-desktop window stops rendering and silently drops `Input.dispatch*`;
`--disable-backgrounding-occluded-windows` covers occluded and locked but not minimized; new headless
creates no platform window; Chrome 136+ needs a non-default `--user-data-dir` for remote debugging;
App-Bound Encryption prevents any other binary from reading the cookies of a Chrome profile. Sources
are in §2.8.6. Nothing in the runtime changed and no version was bumped; the backlog items
were absorbed into the phases (their status is §8.5).

### 2026-09-12 — extension improvement backlog (no runtime change)

Wrote an English implementation backlog for the capability audit (retired in 3.0.2; the items
and their status are §8.5). Its 17 open items cover input
verification, downloads, ref/frame identity, capture deadlines, frame/shadow coverage, background
experiments, capture/evidence budgets, HAR fidelity, storage, recovery, multi-client routing,
Playwright export, portable tests and runtime guidance. Each item includes evidence, source links,
implementation direction and acceptance criteria. Extension-only changes, coordinated component
work and platform boundaries are distinguished. No defect was fixed and no version was bumped.

Validation: bridge/MCP 26/26 passed. The extension suite still stops on the missing external QA
fixture documented in §7; it is not a full pass. Local Markdown links and diff whitespace were
checked. Browser behavior was unchanged, so the isolated live suite was not rerun for this document.

### 2026-09-12 — documentation audit of v1.7.21 (no runtime change)

Updated README, this architecture reference, runner/README and scripts/README against current code,
official Chrome/CDP documentation and the targeted Edge audit. No version bump or executable-code
change: the defects below remain open.

- Corrected the unconditional bans on background screenshot/input and closed Shadow DOM. Recorded
  the successful hidden-page screenshot/typing and closed-root read, explicitly limited to the
  headless Edge environment tested. Headed/minimized/occluded/locked behavior remains unverified.
- Documented the live input-witness `sessionId` error and rejected `Browser.setDownloadBehavior`,
  plus source-level ref-generation and screenshot/bridge timeout defects. Did not call them fixed.
- Updated Workspace tab management and wildcard support, session/profile distinction, one-bridge
  ownership, cross-origin version requirement, restricted CDP domains and worker lifetime notes.
- Removed interception/fault injection from the absent-feature list because `netrules.js` and its
  router actions already exist. Download actions exist but fail in the audited transport; file
  content checks remain absent. Distinguished configurable budgets from platform limits.
- Updated the repo/component references, replay pacing, semantic baselines, runner commands/exit
  codes, fixture dependency and test evidence. Historical suite counts remain history rather than
  being copied into current status. Runtime comments and tool instruction strings are outside this
  documentation change and still contain some superseded claims.

Validation evidence from this audit: bridge/MCP 26/26 passed; extension suite stopped on the missing
external QA flow (§7). Documentation links, stale current-reference claims and diff whitespace were
checked. No full isolated-browser suite was rerun for documentation-only edits.

Newest first. **Every change to this repo gets an entry.**

### 2026-09-10 — v1.7.0: the panel gets the engine, and three real complaints get answered

> Historical entry. The input/visibility claims below are superseded by §4.3a and the 2026-09-12
> audit. Named sessions support addressing, not independent cookie stores or universally reliable
> background interaction.

The engine had been complete for a release and a half; the side panel exposed five of its nineteen
actions. So a QA working alone could produce a **macro** — proof that the steps could be performed —
and never a **test**, which is proof that they did something. The assertion wizard, calibration, the
known world and the five verdicts were reachable only over MCP, by the agent. `approve` in
particular: the whole surprise-detection design rests on a human, and only a human, folding a run
into the known world — and it was callable only by the one caller it was written to exclude.

Three complaints came back from the first team to use this, and all three were real:

**1. "Why do we have to Attach a tab every time?"** — It was never a technical requirement.
`send()` already attaches whatever tab it is given, which is how follow and multi mode work, so the
extension has always attached without a user gesture. The Attach button existed to make the DEFAULT
"one tab", so that glancing at your inbox mid-task did not hand the agent your inbox. That reasoning
is right and the click was the wrong price for it.

**Workspace mode** (`lib/workspace.js`, now the default) keeps the protection and drops the
ceremony: tabs whose host is in the project's `workspaceDomains` are driven automatically, and every
other tab is not merely un-clickable but unlisted — origin only, no title, no URL. The rule that
makes it safe is one line and it is the line to never get backwards: **an empty allowlist denies
everything, never allows everything.** With no `g9.project.json`, Workspace behaves exactly as
Pinned. Three shapes are accepted (`example.com`, `*.example.com`, `localhost:5173`); paths and
regexes are refused by name, because this list is a security boundary a QA edits by hand and a
pattern language rich enough to be subtly wrong is the wrong tool for that.

Existing installs are migrated once, `pinned → workspace`. That is only acceptable because it cannot
widen anyone's exposure — with no allowlist the new mode is the old one — and it is written to the
activity log rather than done silently.

**2. "The port is always in use."** — Every MCP client launches its own bridge and every one of them
wanted 8765. The second got EADDRINUSE and said so every five seconds, correctly and uselessly;
meanwhile the extension was talking to whichever process won the race, and the others were alive,
listening on nothing, and timing out with no clue why.

Bridges now take the next free port from 8765–8775 (`bridge/src/registry.js`), publish their
identity on `/health`, and register in `~/.g9/bridges.json`. The panel scans the range and shows a
picker — including the fact that decides everything, which is whether a browser is already on that
bridge. An explicit `G9_PORT` is still honoured absolutely: if somebody pinned a port they also
typed it into the side panel, and a bridge that helpfully moved would break the setup they
configured. Verified live: with the developer's own bridge on 8765, a second one took 8766 and
explained itself in one line.

⚠️ `/health` gained CORS, and it is **conditional** — echoed only to extension origins. A blanket
`*` would hand a malicious page a way to probe for a bridge and read the project path off it,
defeating the Origin check the entire security model rests on.

**3. "We want to test two pages at once."** — Always possible at the CDP layer; `chrome.debugger`
attaches to many tabs and `attachedTabs` has been an array from the start. What was missing was an
ADDRESS. `browser_tabs action:"session"` names a tab, and `session` is accepted by every tool that
takes a tabId — injected in one pass over the schema rather than written into twelve of them, so the
thirteenth tool cannot be added without it. A session is a name for a tab and never a grant of
access to one: `resolveSession` re-checks the mode, so naming a tab cannot route around Workspace.

The honest limit is documented in the tool description itself, because it will otherwise be
discovered as a bug: a browser delivers input only to the tab it is SHOWING. Two sessions can be
READ simultaneously — snapshot, console, network, screenshot — but a click into a background one
does nothing. A two-user flow switches; it does not run in parallel.

**Also in this release:**

- **The panel is four modules** (`ui` / `session` / `automation` / `issues`). It was 657 lines
  covering three unrelated jobs, and this release roughly doubles the automation half. Splitting
  after that growth is strictly more expensive than splitting before it.
- **The verdict and the surprises are rendered.** They were computed on every panel replay and
  thrown away — so the most original thing in the tool had no user interface at all. Each verdict
  now carries what to DO about it, because separating `FAIL_PRODUCT` from `FAIL_AUTOMATION` only
  pays off if the reader is told the difference.
- **The flow library** (`bridge/src/flows.js`, `bridge/src/project.js`). Recordings lived in
  `chrome.storage.local`: invisible to every other QA, absent from review, missing from Git, gone
  with the browser profile. They now sync to FlowSpec files on disk through the bridge — the
  extension has no filesystem and must not get one. Run history deliberately does **not** travel:
  committing it would dirty the working tree on every replay, which trains people to
  `git checkout .` and eventually to discard a real edit.
- **Suites are queries, not lists.** A hand-maintained array shrinks the first time somebody forgets
  to add their flow, and the Full test still reports green.
- **An AgriPad driver** (`runner/drivers/agripad.mjs`). FlowSpec always carried
  `target: { kind, adapter }`; this fills it in. `node runner/g9.mjs run suite:agripad.full
  --platform agripad` drives a real device over `adb forward` with no server, no operator and no
  browser. Runs are labelled `gray-box`, stated rather than implied: actuating a control's own
  command proves the command works, not that a finger could have reached the control.

**Tests: 26/26 bridge, 48/48 extension** (34 existing plus 14 written for this release, covering the
empty-allowlist rule, domain matching, session-is-not-a-grant, the before-the-tab-exists URL check,
and the two-sided hash agreement that stops the sync indicator lying).

A note on that last one, because it was nearly a silent bug: the two sides must hash the *same
bytes*. The bridge hashes what it wrote to disk; the extension hashes `canonicalJson(spec)`. Those
are the same string by construction — and had they drifted, every flow would have reported as
"differs" forever, which is an indicator people stop reading.

The consumer-facing QA documentation moved with this work: it is now `QA/` at the root of the
AgriPad repo (guides, the flow library, an experience log, and a tool-gap ledger), not
`Agriculture.AgriPad.App/AiGuides/`. It is written against the behaviour recorded here, so a change
to this tool still needs an edit there.

### 2026-09-12 (latest) — v1.7.21: three things that were wrong in ways tests could not see

All three came from somebody using the thing and describing what they saw.

**The progress bar was a lie, twice over.** First, no progress ever reached the panel: the
broadcast object set `type` twice —

```js
type: 'replayProgress',   // overwritten
type: step.type,          // wins
```

— so every message went out labelled `click` or `assert` and no listener recognised one. A duplicate
key is not an error in JavaScript, it is a silent last-one-wins, and the only symptom was a panel
reading `step 0/5` for a whole run. Second, the bar was driven by `max(byStep, byTime)`, so on a
five-step flow it slid to the end in seconds while the label still said step 0. Steps are now the
skeleton — floor is steps finished, ceiling is the step running, time only interpolates between
them — and the whole bar is capped at 98% until the run actually ends, because the last step is
usually the longest and a full bar sitting still is exactly when somebody decides it has hung.

**The agent lost its target whenever anybody touched the agent's own window.** `lastFocusedWindow`
means whichever window the OS focused last, and the popped-out panel is a window. Reported from real
use: with the panel detached, every call came back "9 workspace tabs are open and none is focused"
while a tab was plainly focused. A window whose `type` is not `normal` no longer counts as the
user's place; the last ordinary window is remembered in `storage.session` as it happens, because
`windows.getAll` has no ordering and the worker dies between events. And a pinned tab now outranks
every guess — it is the user saying "this one", and it should not be overruled by where the mouse
went.

**Another extension's traffic dominated the surprise detector.** The agent drives the user's REAL
browser, so Grammarly fetching its bundles lands in the same capture as the product's API calls. A
17-step flow came back with 103 surprises, 8 of them at `fail`, and every single one was somebody
else's asset. A detector whose loudest findings are never about the product is one nobody reads, and
the real regression arrives in the middle of that list. Foreign schemes are now excluded from the
signature — matched on the SCHEME, never a list of known extension ids, because a list of other
people's extensions is wrong the day it is written. The same rule also applies to keys ALREADY
stored in a known world, since otherwise every flow approved before this reports those bundles as
missing forever: not because the request stopped happening, but because we stopped looking, and
asking everyone to re-approve to silence that would be fixing it in the wrong place.

Also: a long flow's `Tasks` recording had an assertion that could never fail — it looked for the text
"لیست کارها", which is the left-menu entry present on every page, so it passed on `/sites` just as
happily. Replaced with the route. It now runs 17/17 twice in a row.

### 2026-09-11 — v1.7.20: a run you can watch, and a baseline that knows data from structure

Everything here came from one person running the thing and saying what was wrong with it. None of
it was found by a test.

**A replay showed nothing until it finished.** One message went out, one came back when it was all
over; on a twenty-step flow that is half a minute of a motionless panel, and the honest question
that follows is whether the button worked at all. `replay` now announces each step at its START —
after, not before, is useless: the announcement you need is the one that arrives while the slow step
is still running. The panel turns ▶ into ■, draws a bar, and labels it `step 7/20 · ~12s left`. The
step count is a fact and the time is an estimate from the last run, and they are worded differently
on purpose: a guess presented in the same voice as a measurement is how a progress bar loses its
audience the first time it is wrong. The bar advances on whichever of steps-or-time is further
along, so it keeps creeping through a long step instead of sitting still exactly when somebody is
wondering if it has hung. ■ sets the same halt flag the agent honours, so a run stops AFTER the
current step — stopping mid-click leaves the page in a state nobody can describe.

**Text ran out of the panel.** A surprise line carries a full URL, a URL has no spaces, and the
browser had nowhere to break it. `overflow-wrap: anywhere` (not `break-word`, which respects tokens
and therefore loses to a 200-character path) plus a scroll cap on the report, so a long failure
scrolls inside itself instead of shoving the flow list off screen.

**The panel had nowhere to go.** It is narrow, it sits on top of the page under test, and it moves
when that page scrolls. `detachPanel` opens the same document in a popup window — resizable,
movable to a second screen, and still. Same file, so there is no second implementation to keep in
step; inside it the ↗ button hides itself, because a control that spawns a copy of what you are
already looking at is just confusing. The id `detach` was already taken by the detach-the-debugger
button, and a duplicate id would have silently rerouted that one — the new button is `popout`.

**A semantic baseline could not tell live data from a structural change.** The first real page
`assertion:"aria"` met was a site list where every row carries a temperature, a humidity and a wind
speed. Every replay reported a hundred changed nodes and the flow went red seven runs out of seven
with nothing wrong. The fix is not a tolerance — a tree allowed to drift is not a baseline. A
vanished line and a new line are paired as the same row carrying new data only when BOTH hold: they
are identical once numbers are masked, AND that masked shape lost exactly as many lines as it
gained. The second condition is the one doing the work: on a list of sites named NL1, NL2, NL3 every
row masks to the same shape, so rule one alone would shrug at a search box that stopped filtering —
the very thing the flow exists to catch. A set that grew or shrank is always structural; only a
one-for-one swap can be data. And whatever is paired off is reported as a warning on the run, with
a sample: an assertion that silently ignored a hundred nodes is not an assertion.

### 2026-09-11 — v1.7.19: the first LONG flows, and the four things they broke

One long flow per platform, written against real screens rather than the seeded test page. Writing
them found four gaps that short flows had never touched — which is the argument for writing long
ones.

**Assertions could only be appended.** `addAssertion` always pushed to the end, so
"search, check it filtered, clear, check it came back" put all three checks after the last step,
where they describe the same final moment three times. That looks thorough and tests less.
`atStep` now inserts after a given step, refusing an out-of-range position rather than clamping it —
a silently relocated assertion checks the wrong thing and still passes.

**Assertions ignored their wait budget.** They ran the instant their turn came, so the first check
after a navigation raced the SPA's first paint: page text still `""`, verdict `FAIL_PRODUCT`, for an
app that was merely rendering. An assertion is *eventually* true; it now retries inside its declared
budget and rethrows the real error when the budget runs out. Dry runs deliberately do not wait —
"resolve everything, change nothing" must not become a slow partial execution.

**A flow could enter a bottom sheet and not leave it.** The tab bar underneath is behind the sheet's
scrim and the dismiss button has no id, so the FlowSpec had no way to express the exit the bridge
already supported. `dismiss` is now an action.

**The active tab carries no tappable id.** The bar offers only the tabs you are *not* on, so a flow
that opens by clicking its own end state passes once and fails on every rerun. The AgriPad flow
therefore starts on Tasks and ends on Map, and is verified by running it three times in a row rather
than once: **11.1s / 10.6s / 11.6s, 20/20 each time.**

A fifth thing was not a gap but a message: a `visible` assertion missing its id produced the
device's own complaint, which is about the command rather than the flow. It now names the step and
the shape to use.

The flows: `agripad.navigation.site-and-tabs` (20 steps — probes, every tab, the map, the site
sheet and its search) and `web.tasks.browse-and-open` (17 steps — the grid, the toolbar search,
clearing it, opening a task and closing it, with nine checks interleaved).

Tests: **26/26 bridge, 70/70 extension.** Both suites now resolve two flows per platform, so none of
the four is the empty-suite green the design exists to prevent.

### 2026-09-11 — v1.7.18: the flaky check was in the harness that checks for flakiness

Three consecutive runs of the live suite returned **PASS, SKIP and FAIL** from identical code. The
video-spool check did `sleep(600)` and then asked whether any frames had been captured, which made
it a race with the compositor — and keyed its SKIP branch on a `reason` string that is only set in
one of the two zero-frame cases, so the same environment reported SKIP when the wording matched and
FAIL when it did not.

Noticed only because the failure moved: re-running had made it green, and re-running until green is
exactly the habit this system exists to remove. It would have been easy to take the second result
and move on.

It now **waits for a frame rather than for a duration** — polling `video_status` to a bounded
deadline — and treats zero frames after that deadline as the environment, not a defect. Verified by
running it three times: `58 passed, 0 failed, 1 skipped` / `59 passed, 0 failed` /
`59 passed, 0 failed`. It still varies between PASS and SKIP depending on whether the browser
composited anything, which is honest; it can no longer report FAIL for a limitation of the harness.

Tests: **26/26 bridge, 68/68 extension, live CDP green three runs running.**

### 2026-09-11 — v1.7.17: the first thing a user sees after reloading the extension

Reported from actual use, and the timing is the whole point. Reloading the extension leaves you
standing on `edge://extensions`, so the very next thing anybody does is press **Attach & Pin** — on
a page no debugger is allowed to touch. The refusal said:

> Cannot attach to edge://extensions/ — browser-internal pages are off limits.

Accurate, and it reads as *the tool* refusing. The user asked what the error was, which is the
clearest possible signal that a message has failed: it named a rule without naming whose rule it is
or what to do about it. Now it says the **browser** forbids it and that this is not a setting, that
switching to the page under test is the entire fix, and — in Workspace mode — that attaching by
hand is usually unnecessary because focusing a project tab does it.

The page is also named properly. `originOf()` renders these as `(edge)`, because browser-internal
URLs carry the opaque origin — useless to somebody trying to work out which page they are on. The
naive fix, scheme + host, turns `about:blank` into `about://blank`; these schemes are not all
hierarchical. Both shapes are handled, and both are asserted, because **a message that renders its
own subject wrongly is one people stop believing.**

Tests: **26/26 bridge, 68/68 extension, 59/59 live CDP.**

### 2026-09-11 — v1.7.16: deleting the measurement nothing read

Housekeeping on v1.7.15, and worth its own entry because of what was deleted rather than added.

Getting a click into a cross-origin frame took four attempts, and three of them assumed the
coordinates needed translating into the top-level page. That machinery — `frames.offsetOf`, an
`offset` stored on every ref, a `frameContextForNode` that returned two facts instead of one —
survived into the working version even though the fix that actually worked made all of it dead:
input is dispatched into the frame's own session, in the frame's own space, so there is nothing to
convert.

It was not free. Every snapshot of a page with a cross-origin frame paid two extra CDP round trips
per frame to measure a number no code read. **And the real cost was the reading**: a future
maintainer finds `offset` on a ref and reasonably concludes it matters.

So it is gone, and `frames.js` carries a short note saying it is deliberately absent and why —
because the deleted code looked obviously necessary, and the next person to debug a mis-aimed click
in a frame will reach for it again.

Tests: **26/26 bridge, 66/66 extension, 59/59 live CDP** — including both cross-origin frame checks.

### 2026-09-11 — v1.7.15: cross-origin iframes, and a `wontfix` that was wrong

> Correction from the 2026-09-12 audit: the closed-Shadow-DOM conclusion at the end of this entry
> was also wrong. Privileged DOM access exposed a closed root in the real-Edge probe (§7).
> Existing locator/recorder coverage is a separate implementation question (§8).

The QA ledger said a cross-origin iframe was `wontfix — a browser limit, no amount of development
removes it`. **That was wrong, and it sat in the ledger for a day because nobody checked it.** The
premise was right — an out-of-process frame's nodes are genuinely not in the tab's session — and
the conclusion did not follow: CDP has always reached those child targets, and since **Chrome 125**
`chrome.debugger` can too, through flat sessions. Checking took ten minutes. Believing it cost a
capability.

A payment page, an SSO form, a map widget, a help chat — anything an app embeds from another
origin — is now readable and clickable instead of being where a flow stops.

**Three wrong turns, and they share one lesson.** Getting the click to land took four attempts:

1. Threading `sessionId` from `resolveRef` down through every caller. interact.js has a dozen places
   that act on a node; two got patched and ten did not, so reading inside a frame worked and
   clicking did not. Replaced with a lookup — **`sessionForNode` asks the snapshot that produced
   the node**. A rule every new call site must remember is a rule that will be broken.
2. Adding the frame's offset, measured at snapshot time. `scrollIntoView` then moved the frame, so
   the offset was stale by exactly the scroll distance and the point landed off-screen. The error
   said "outside the viewport — close the overlay first", about an overlay that did not exist.
3. Measuring the offset live, after the scroll. Still missed.
4. **Not translating coordinates at all.** The frame's session accepts `Input` commands in its own
   space, so the answer was to dispatch where the numbers already made sense. *The arithmetic that
   is not done cannot be done wrong.*

Two more things had to be told which realm they were in: the child session needs its own
`DOM.enable` + `DOM.getDocument` (without them `DOM.resolveNode` says "Node with given id does not
belong to the document" — the nodes are real, the agent has just never been told about their
document), and the **input witness** has to listen in the frame, or a click that worked is reported
as "the page never received a trusted event", which is an accusation rather than a diagnosis.

**Proven live, not argued.** `setup/livetest.mjs` section 14 serves the page from `127.0.0.1` and
its frame from `localhost` — same server, different origin, genuinely out-of-process — then types
a card number, clicks Pay, and asserts the frame reports **PAID**.

One honest limit stays: a **closed** Shadow DOM. That one is a real boundary — the page has chosen
not to expose the tree and no protocol hands it over.

Tests: **26/26 bridge, 66/66 extension, 59/59 live CDP.**

### 2026-09-11 — v1.7.14: break the network on purpose, and prove the file downloaded

> Correction from the 2026-09-12 audit: interception exists, but the download implementation below
> calls a `Browser` command unavailable through `chrome.debugger`. Its live watch failed (§7).
> Earlier source/stub checks did not prove that downloads could be observed through the extension.

The last two open gaps in the QA ledger are closed. Both were things a tester could describe and
the tool could not do.

**GAP-0002 — forcing a failure.** `browser_network action:"intercept"` takes rules that match a URL
substring and then answer the request yourself (`status`, `body`, `headers`), fail it at the network
level (`abort: "TimedOut"`, `"ConnectionRefused"`, …), or just make it slow (`delayMs`). `times: 1`
fires once and steps aside, which is how "the first save fails, the retry succeeds" gets written.

The interception machinery already existed for HAR pinning, so this is a rules layer on the same
`Fetch` session rather than a second interceptor — two of those on one tab would fight over the same
paused request and one would lose. **Rules are consulted before the pinned HAR**, which is the order
that lets a flow be pinned for determinism and still have one endpoint forced to fail; the other way
round makes a rule unreachable for anything the HAR covers, which is most of it. Every injected
response carries `x-g9-intercepted`, so a fake 500 is never mistaken for a real one.

Validation is strict and loud, because the failure mode here is silent: a rule that never matches
means the test passes, the error path was never exercised, and nobody finds out.

**GAP-0001 — downloads.** `watch_downloads` → `wait_download` → `downloads`. Built on
`Browser.setDownloadBehavior` with `eventsEnabled` rather than the `downloads` permission, so no QA
machine is asked for new trust at install time for one assertion. The result reports filename, URL,
byte count, and a computed **`empty`** flag — which is the actual defect this exists for: "the
export button produces a zero-byte file" is something a 200 response reports as success. Honest
limit, stated in the module and in the ledger: the bytes are what the browser reports, not what is
read back off disk, so asserting on file CONTENT is still outside this.

**And a bug in my own wiring, caught by the safety net rather than by me.** The new actions needed
`await`, and the `browser_network` handler was not `async` — so `sw.js` stopped parsing and the
extension loaded with a **dead service worker**. `node --check` passed it: given a `.js` file it
parses as CommonJS, where the enclosing structure differs. The only symptom anywhere was the
isolated live test refusing to start with "bridge port null" — a message about configuration, for a
syntax error two layers away. That guard did its job; nothing else in the suite would have noticed.

So the suite now parses **every** extension source as a real ES module (copied to `.mjs`, which
forces module parsing). Parsing rather than importing on purpose: importing needs a chrome stub
complete enough to survive every listener the worker registers, and a stub that drifts turns a guard
into a source of false failures.

Tests: **26/26 bridge, 66/66 extension, 57/57 live CDP**, plus a real-browser check that the worker
starts with the new modules loaded.

### 2026-09-11 — v1.7.13: the bridge had been lying about its own version

`"*"` went live and the first thing it revealed was a bug in the reporting around it. The bridge
announced **v1.7.4** while `bridge/package.json` said **1.7.12** — because `VERSION` was a
hand-typed constant in `server.js` that had not been touched in eight releases.

That is worse than a cosmetic slip. The bridge compares that constant against the extension's real
version and prints VERSION MISMATCH, so the warning had been measured against a number nobody
maintained: it told people to reload an extension that was already correct, repeatedly, all
session. A warning that is wrong often enough stops being read, and then it is worth less than no
warning at all.

`VERSION` is now read from `package.json`. **A version announced in two places will be wrong in one
of them**, so there is one place to bump and the test asserts both that the constant is gone and
that the extension manifest and the bridge package agree.

**`"*"` is confirmed live**, and two things that had never worked now do:

- `browser_tabs action:"open"` on a host nowhere near the allowlist — example.com opened,
  snapshotted, and closed.
- `file://` — the QA guide was driven in the real browser rather than parsed: 22 sections, 22 nav
  entries, no broken links. Every check that had been static is now a live one.

One operational note worth keeping: restarting the editor does **not** free the bridge port if a
second Claude session is still running. Two sessions were up, the older one held 8765, and the new
bridge sat with no extension. The registry says exactly who holds the port, which is what made it a
thirty-second diagnosis instead of a guess — and the bridge then took the port on its own, as its
own error message promises.

Tests: **26/26 bridge, 62/62 extension.**

### 2026-09-11 — v1.7.12: the isolated live test, and a third assertion pinned to copy

`setup/isolated-livetest.mjs` had not been run this session. It is the only check that drives a
**real Chrome** — its own profile, its own bridge, the user's browser untouched — so everything
Phase 2 changed had been verified against a stub and against the user's live session, but never
against a clean browser from cold. It passes: **57/57**, plus the panel render and the Automation
tab interaction.

It did not pass the first time, and the reason is now familiar. The harness asserted that the panel
contained the literal words **"Attached tab"**. Splitting `panel.js` into `session` / `automation` /
`issues` changed that label to "Re-attach current tab", so a panel that was rendering perfectly was
reported as broken. That is the **third** assertion in this repository to fail for this exact
reason — after the FAIL_AUTOMATION advice in v1.7.3 and the `app.busy` comment in v1.7.7.

Three times is a pattern, not bad luck, so the fix names it: the check now reads ids and counts
(`button[data-tab]`, `[data-body="session"]`, `#attachActive`) instead of prose. **A refactor is
supposed to keep ids and free to change wording.** An assertion that reads copy is testing the
wrong artefact, and it fails exactly when someone improves the thing it was meant to protect.

The screenshot it captures confirms the panel work end to end: Session / Automation / Issues tabs,
"Record a flow", "Saved flows", and the **Repository** bar with Pull / Push and an honest empty
state explaining that the bridge is not connected in this isolated profile.

Tests: **26/26 bridge, 61/61 extension, 57/57 live CDP.**

### 2026-09-11 — v1.7.11: `"*"` — a workspace that is the whole browser

Workspace mode could only ever be as wide as a host list. On a machine dedicated to QA that is
friction with nothing on the other side of it: the agent should be able to open a new tab, type any
address, and drive it. `"workspaceDomains": ["*"]` now means exactly that, `file://` included.

**It does not weaken the empty-list rule, and keeping the two apart is the whole design.** An empty
list is what a MISTAKE looks like — a missing file, a typo, a project nobody set up — and
guessing "allow everything" there would hand over a browser nobody decided to hand over. `"*"` is a
sentence somebody typed into a reviewed file. Silence is not consent; a line that says so is.

Two things caught during the change, both worth more than the feature:

**The bridge silently ate it.** `normaliseDomains` rejected `"*"` as "not host-shaped", so the
extension received an EMPTY list — which it correctly reads as deny-everything. A config line
saying *allow all* would have meant *allow nothing*: the worst possible direction for a rule about
permissions to fail, and invisible from the config file. Caught by checking what the bridge actually
produced rather than assuming the extension's half was the whole story.

**The existing test caught me breaking a real guarantee.** My first version returned `true` for
`chrome://settings` under `"*"`. The suite had pinned that as "never a browser-internal page,
whatever the list says", and it was right — not as policy but as fact: Chrome lets no debugger
attach to those, so answering "yes, that is in your workspace" is a promise the tool cannot keep,
and the caller gets an obscure CDP error instead of a sentence. `"*"` now means *every host the
debugger can actually reach*.

**The config keeps the real hosts listed under the `"*"`.** A bridge older than this version drops
the `"*"` and would be left with an empty list — deny-everything — the moment somebody edits the
file before restarting their client. With the hosts still there, an old bridge falls back to exactly
its previous behaviour and a new one allows everything. A config file should never be a trap for the
version that is currently running.

Tests: **26/26 bridge, 61/61 extension.** The two new ones assert that `"*"` and `[]` never
converge, and that the bridge stops stripping the entry.

### 2026-09-11 — v1.7.10: the last two unproven paths, both now driven end to end

**Remote execution works.** The one path that had never been run: server → SignalR → device. A
`qa.ping` through `/api/automation/devices/{id}/command` came back in **111ms**, and the whole
`agripad.smoke.device-health` flow ran remotely with **PASS, 4/4, 552ms**, persisted to the run
history and picked up by the coverage board. Everything about that path had been argued from code
until now.

Worth recording why it took so long to reach: the device was reporting "متصل شد" in the app while
`/api/fleet` showed it offline for four hours. Both were true. An `adb uninstall` earlier in the
session had given the emulator a **new client id**, so the device I kept checking was the old
identity, sitting where it was abandoned. The fleet had the new one, online and consented, the
whole time. When two sources disagree about the same device, check that they are talking about the
same device.

**The web flow library is no longer empty.** `web.smoke.sites-search` is recorded, replayed
(**5/5 PASS**), exported as a FlowSpec and saved to `QA/Flows/web/smoke/`. All four suites now
select at least one flow, so none of them is a vacuous green any more — which was the failure
v1.7.5's `requireSelection` was built to catch, now closed from the other end as well.

The first attempt at that flow is the more useful half of the story. Its `aria` assertion captured
the whole page **after** the weather widgets had loaded, so on replay it failed with
`7 node(s) gone, 9 new` — all of them `Loading...`. A baseline taken at one load stage and compared
at another is a coin flip, not a test. `calibrate` refused to paper over it, correctly: *"calibrating
a broken run would mark the breakage itself as noise."* The flow was rebuilt around two assertions
that cannot drift — a match that must appear and a non-match that must disappear — because a search
test that only checks what remained never tested the filter at all.

**`g9 run` now names the bridge that holds the extension.** A bridge owns its port exclusively, so
with an editor or MCP client running, the runner starts its own and nothing joins it. The old error
listed three things to check that were all fine. It now reads the registry and says which port and
pid actually has the extension, and what to do about it.

Tests: **26/26 bridge, 59/59 extension**, plus the AgriPad suite green through the QA launcher.

### 2026-09-11 — v1.7.9: dialogs are automatable, and the report is written for the reader

**GAP-0006 is closed: a dialog no longer freezes quiescence.** `G9SafeCommand` keeps a handler
registered as running until it returns, and a handler awaiting a modal does not return until the
user chooses — so `AppQuiescence` reported a `cmd:` reason for as long as any dialog was open
(341s, measured), and every step after that timed out. `QaModalWatch` now answers "is a blocking
overlay up?" and a bare `cmd:` entry stops counting while one is. **Only `cmd:`**: `http:`, `ui:`
and explicit `Busy` scopes are untouched, because those are work whether or not a dialog is open.

Proof on the device: opening the diagnostics chooser went from `settled:false` plus a 30s timeout
to `ok:true settled:true busy:[]`, with `app.busy` reporting `idle:true` while the dialog was up.

**The first version of that fix was worse than the bug**, and it is worth recording why. It matched
on the TYPE NAME of every element — anything containing "Popup" or "Sheet". On a completely clean
screen it reported a dialog every time, because `DeveloperDebugOverlay._devPopup` is a `G9PopupView`
that lives in the tree permanently and is merely closed. A permanently-true answer there would have
suppressed every `cmd:` reason forever, so quiescence would never have waited for anything: a wait
that was too long traded for results that are quietly wrong. It now asks the controls for their
STATE — `G9PopupView.IsOpen`, `G9BottomSheetHelper.GetOpenSheetCount()` — instead of inferring
it from a name. Asking beats guessing, and the guess was available the whole time.

**GAP-0007 is closed too.** The chooser's three options carry ids now
(`DiagnosticsChooser.LiveDiagnostic` and friends) — set by hand, because the popup is built in
code and there is no `x:Name` to derive from. The dismiss button cannot carry one at all
(`G9PopupButton` is a description, not a control), so instead there is a new bridge command
**`ui.dismissOverlay`** that closes any popup or sheet and needs no id — a better answer than
naming one button, because it works for every dialog rather than this one. Verified end to end:
open the chooser, tap "Live diagnostics", land on the Live Diagnostic screen, all through
automation. That path could not be driven at all this morning.

**Written for the person reading it.** The audience for `report.html` is a tester, not the person
who wrote the runner, so it is now Persian, RTL, and each verdict carries **one sentence saying what
to do next** — most importantly that `FAIL_AUTOMATION` must NOT be filed as a bug. A report that
names a category and stops has not told anybody anything they can act on.

The same reasoning produced `QA/Run-Tests.ps1` (one command: finds the device, launches the app,
waits for it to be genuinely ready, runs, opens the report) and a precondition message that now
explains the two ordinary causes instead of printing SQL: "no such table" is an unfinished first
sync, "no active database" is nobody logged in. Both were hit live, and both read like defects
without the sentence.

Tests: **26/26 bridge, 59/59 extension**, and a clean end-to-end run through the launcher.

### 2026-09-11 — v1.7.8: the wait budget was being sent where nothing reads it

The v1.7.7 fix made the `idle` oracle wait. This one makes the wait it asks for actually arrive.

`QaLocalRequest` reads `TimeoutMs` off the **request root** and defaults it to 30000. A `timeoutMs`
inside the `args` object is never looked at. The runner's driver was already correct — it passes
the budget through `command(cmd, args, { timeoutMs })`, which lands at the root — but the server's
`TranslateAssertion` put it in `Args`, so every remote `idle` assertion silently got the default no
matter what the flow asked for. An oracle that promises a longer wait and does not take one is a
flake with a delayed fuse.

Proven on the device rather than argued: `ui.waitIdle` with a root-level `timeoutMs: 45000` ran
**30.3s and returned `idle: true`**; the same value inside `args` had been cut off at exactly 30s.
The server now threads a per-step budget through `CommandBody`, and the translator tuple carries it.

Found while trying to complete the one path that had never been driven end to end — remote
execution through the Diagnostic server. That attempt also turned up two AgriPad blockers, both now
in the QA gap ledger rather than quietly fixed:

- **GAP-0006** — a handler that awaits a modal stays registered as running, so `AppQuiescence`
  reports busy for as long as any dialog is open (measured: 341s). Every step after a flow opens a
  dialog times out. The app is not working; it is waiting for a human.
- **GAP-0007** — the dialog's own options carry no `AutomationId`, so even a fixed quiescence
  could not tap them.

One thing did get fixed on the app: the "Live Diagnostic" card on the Profile page was a `Border`
with a tap handler and no name, which made the only route to the live-access screen invisible to
automation. It now has `x:Name="LiveDiagnosticCard"`, verified on the emulator after a full
rebuild — and the rebuild is worth noting too, because an incremental Android build reported
success twice without repackaging the APK. `--no-incremental` was what actually produced it.

Tests: **26/26 bridge, 59/59 extension**, plus three consecutive green device runs.

### 2026-09-11 — v1.7.7: the `idle` oracle never actually waited

The v1.7.6 verdict fix was the right fix for the wrong layer. It correctly stopped filing
`still busy: …` as a product regression — but the run should not have been failing at all.

`case 'idle'` in the AgriPad driver called `app.busy`, which is an **instantaneous snapshot**, and
failed if anything whatsoever was in flight at that microsecond. It never waited. `agripad.smoke`
asserts `idle` as its very first step, so the entire suite's colour depended on whether a background
request happened to overlap the moment the run started.

The background request is real and measurable: a periodic `GET /api/NewAuth` token refresh that
takes **~20 seconds** from this emulator — `ui.waitIdle` returned `idle: true` after 22.9s of
genuine waiting. So the suite was a coin flip weighted by a 20-second window.

Every action in this driver already waits on `ui.waitIdle`, and the bridge's own capability notes
say "Every action waits for app quiescence rather than sleeping; a timeout names what was still
busy." An assertion that the app settles is that sentence. It now calls `ui.waitIdle` with a
per-flow-overridable 30s budget, and only asks `app.busy` **after** the wait fails, so the error
still names what was holding it.

Three consecutive runs after the fix: **21.5s, 0.6s, 0.6s — all green.** The first waited the
refresh out instead of failing on it, which is the whole point.

Worth recording that this is the second test in two versions to break on its own explanatory
comment: the new test compared the position of `ui.waitIdle` against `app.busy`, and the comment
above the fix names `app.busy` first. It now strips comment lines before comparing. A test that
reads prose is testing the wrong artefact.

Tests: **26/26 bridge, 58/58 extension**.

### 2026-09-11 — v1.7.6: the same verdict rule, written three times, had drifted

Found by running the AgriPad smoke suite once more after the v1.7.5 fixes: it came back
**FAIL_PRODUCT**, with `still busy: http:GET /api/NewAuth`. `app.busy` reported `idle: true`
seconds later and the identical suite passed. A background token refresh happened to be in flight
when the flow started — nothing was wrong with the product, and a readiness gate declining to
proceed is that gate working.

The cause was not the message but the classifier. `verdictForDevice` was four alternations inline
(`not found|no such|could not find|automationId`) while the browser had twenty documented patterns
in `AUTOMATION_FAILURE_PATTERNS` and the server ten in `AutomationFailurePhrases`. One rule, three
copies, and the copy with no documentation was the one that drifted: the browser list names
"readiness gates that never opened" as automation failures explicitly, and the device path filed
exactly that as a product regression.

The device rule is now a named list with the same categories and the same stated rule for adding to
it. This is the third defect of this exact shape (v1.7.2 browser, then the server, now the device),
which is the signal that three copies of one rule is itself the defect. Until they are merged, the
comment on each says to keep the others in step.

Tests: **26/26 bridge, 57/57 extension**. The new one classifies five real messages in both
directions rather than pinning the pattern list, because pinning copy is what broke the suite in
v1.7.3.

### 2026-09-11 — v1.7.5: the runner could only be run from one directory, and an empty suite passed

Three defects in `runner/g9.mjs`, all found by auditing the finished work rather than by using it,
and all in the same area: how a run decides *what to run*.

**1. The project file was only ever looked for in the working directory.** `loadProject` resolved
`g9.project.json` against `process.cwd()` and returned `null` on a miss — silently, because a
missing project file is a legitimate state for the browser path. `flowsDir` then fell back to a
cwd-relative default, and the run died with `No AgriPad flows found under
...(tool dir)/QA/Flows/agripad`, naming a directory that has never existed. The flows were
fine; only the search was wrong. Running from the tool's own folder — the most natural place for
QA to be — was the failing case, and the error blamed the flow library for it.

It now climbs to the filesystem root the way git finds `.git` and tsc finds `tsconfig.json`, and a
malformed file at the right path is an error instead of a reason to keep climbing and then blame a
missing file three directories up. The second half of the same bug: relative paths in the file now
resolve against **the file's own directory**, not the cwd, via `flowsRoot(project)`.

**2. A selector that matched nothing reported PASS.** Zero flows selected gave `failed === 0`,
verdict `PASS`, exit 0 — indistinguishable, in `run.json`, `junit.xml` and the exit code, from a
suite whose flows all really passed. `web.smoke` and `web.full` select zero flows *today*, because
no web flow has been recorded yet, so this was not hypothetical: a release gate wired to either
would have been green forever and loudest at exactly the wrong moment — a renamed tag, a wrong
`flowsDir`, a suite defined before anything was recorded for it.

The suite files carry a comment explaining that a suite is a query precisely so nobody can forget to
add a flow. That protects against a shrinking list and did nothing about an empty result.
`requireSelection` now refuses, naming the selector that emptied the run and listing what was
available. The one guard covers both platforms.

**3. A suite meant two different things depending on the platform.** The device path read
`QA/Flows/suites/*.json` and applied `select`; the browser path only matched a literal `suite`
field on the recording. Same id, two semantics, and a "Full-Test" that covered different things on
web than on AgriPad. The browser path now reads the same suite files and applies the same query,
keeping the literal-field match as a fallback so recordings made before the suite files still run.

Also in this version: `bridge/package.json` was still 1.6.0 while the extension was at 1.7.4,
despite the bridge gaining `project.js`, `flows.js` and `registry.js`. Both are 1.7.5 now.

Tests: **26/26 bridge, 56/56 extension**. The three new ones assert behaviour, not phrasing —
that `loadProject` climbs and stops, that a non-empty selection passes through untouched while an
empty one throws, that *both* platform paths route through the guard, and that the browser path
reads the suite file.

### 2026-09-10 — v1.7.3: two more, both about honesty rather than function

**The self-test's port collided with AgriPad's.** `setup/selftest.mjs` used 8799, which is exactly
the port the AgriPad QA guide tells people to `adb forward`. Anyone with a device plugged in got
three failures reading "Port 8799 is in use by another program" — a true sentence about an
irrelevant collision, and one that reads like a broken bridge. Moved to 8859, outside the discovery
range as well so a running bridge cannot wander into it either.

**The FAIL_AUTOMATION advice named a cause the verdict no longer implies.** It said "An element
moved or was renamed" — correct when that verdict only covered locator rot, wrong now that it also
covers input the browser never delivered and a device that never answered. Someone reading it would
go re-record a flow when the real answer was "bring the tab to the front". Reworded on both
platforms to state what the verdict actually means and leave the cause to the step message.

Worth a note on the test that broke while fixing this: it asserted the exact sentence, so correcting
the copy failed the suite. That is a test guarding the phrasing instead of the behaviour. It now
asserts the meaning — that the advice says this is not the product — and that it does NOT claim a
single cause.

Tests: **26/26 bridge, 51/51 extension**, both now passing with a device cable attached.

### 2026-09-10 (later) — v1.7.2: three defects the first live run found

v1.7.0 was written, tested (26/26 + 48/48) and shipped without a browser ever having driven it.
The first real session found three things no offline suite could have, and each one is the kind
this project keeps a change log to avoid repeating.

**1. A refusal leaked the URL it was refusing.** `browser_tabs action:"session"` with a tabId
reached `requireTabControl` carrying a URL read off the BROWSER, and the refusal echoed it in
full — handing back `https://chatgpt.com/c/<conversation-id>` for a tab the agent was being told
it may not touch. Titles and URLs are precisely what pinned and workspace mode withhold, so a
refusal must never become the way to read them. It now names the origin. An agent that supplied
the URL itself already knows it; redacting costs nothing and closes the case where it did not.
`refusalFor` had the same shape in its fallback (`host ?? url`) and was tightened with it.

**2. Two harness failures were reported as product regressions.** Both live replays came back
`FAIL_PRODUCT`:

    "The click was dispatched but the page never received it: the attached tab is HIDDEN…"
    "Found textbox …, but it never stopped moving…"

The first is Chromium refusing to deliver input to a tab nobody is showing. The second is the
stability gate declining to click into a running animation — the gate WORKING. `AUTOMATION_FAILURE`
was a single regex anchored to `^Could not find |^Lost the resolved |…`, so anything phrased
differently fell through to "the product is broken". It is now a list of fifteen patterns with a
stated rule for extending it, and a test that asserts BOTH directions — because the worse error is
excusing a real defect as "just the test", and that is the direction that loses defects rather than
trust.

**3. One replay returned 103,553 characters.** A page with a live data list produced 180+ surprise
lines — every row counted as a new UI node — and the result exceeded the agent's token budget
outright. From a tool whose own README explains that it ships fourteen tools rather than fifty
precisely to protect context. `surpriseLines` is now ranked (failures, then warnings, then notes),
capped at twelve, and reports how many it is not showing; `summary.surprises` stays complete for
the panel and the report, which render locally and pay nothing for volume. A truncation that hid
its own existence would have been the same silent-omission bug in a new place.

Worth recording plainly: all three were invisible to 48 passing tests, and all three appeared
within twenty minutes of a real browser. The suites are not the problem — they are checks on
reasoning that has already happened. Only a live run produces the sentences nobody thought to write
an assertion about.

Tests: **26/26 bridge, 51/51 extension** (three added, one per defect).

### 2026-09-04 (later) — README figures corrected against a re-run

No code changed. Three numbers in `README.md` had gone stale while the suites grew and were
corrected after actually re-running them rather than trusting the file: the extension regression
suite is **34**, not 25 (it says so in its own output); the isolated Edge run is **57/57**, not
42/42; and `manifest.json` declares **eight** permissions, not seven — `unlimitedStorage` was added
for the IndexedDB video store and the sentence was never updated.

Worth stating because it is the failure mode this file exists to prevent: a count in prose is a
claim, and a claim that nobody re-checks quietly becomes wrong. When a suite grows, the number in
the README is part of the change.

A consumer-facing QA manual now also documents this tool end to end for non-engineers —
`Agriculture.AgriPad.App/AiGuides/QAAutomationGuide.html` in the AgriPad repo. It is written against
the behaviour recorded here, so a change to the tool's behaviour needs an edit there too.

### 2026-09-04 — v1.6.0 completion: the wizard, A/B, and two normalisation bugs

Three additions that close the remaining gaps in the plan, plus the fixes the live run forced.

**`action:"suggest"` — the assertion wizard.** A recorded flow with no assertion is a macro: it
proves the steps could be performed, never that they did anything, and that is how a recorded suite
goes green for months while the feature underneath is broken. Asking a QA to hand-write oracles does
not fix it either, because the useful ones are the ones they cannot see — which request fired,
whether the console is clean, how big the semantic tree is. The tool watched all of that.

It proposes and adds **nothing**. Each suggestion carries a `strength` and a `why`, including
`blocked` for one that would fail immediately (offering a console-absence assertion on a page that
already has three errors is handing somebody a red test). The research on LLM-generated oracles is
blunt that the common defect is not a WRONG assertion but a WEAK one — it passes forever and catches
nothing — so a weak assertion a person consciously accepted is a decision, and one a tool added
quietly is a blind spot.

**`action:"signature"` and `g9 ab`.** An approved baseline answers "has this changed since somebody
blessed it"; in a product shipping several times a week that goes stale between blessings. A/B asks
the sharper question — what does THIS build do differently from THAT one, right now — with both
sides minutes apart on the same machine, so nearly all the noise cancels.

It reuses `calibrateVolatile` unchanged: that function already answers "what differed between two
signatures", written for two runs of the same build to find noise. Point it at two builds and the
identical computation answers "what changed". One implementation, two readings. The runner imports
`extension/lib/signature.js` **directly** — it is a plain ES module with no browser APIs — so there
is no second copy to drift.

`g9 ab` exits 0 on differences, and only fails when a side could not run. A difference is not a
verdict: a shipped feature and a regression look identical from here, and only a human can say which.

**Two normalisation bugs the live run found**, both of which would have produced constant false
surprises:

1. A request captured mid-flight produced a spurious PAIR — `GET /x pending` on one run,
   `GET /x 4xx` on the next, so one "new" key and one "missing" key against a page that had not
   changed. An unfinished request is not an observation; `buildSignature` now skips it.
2. Excluding pending was not enough alone: a request that had not finished when its step's evidence
   was collected stayed out of the known world, then appeared brand-new the next time it completed
   in time. `settleNetworkEvidence` re-reads the buffer once at the end of a run and patches every
   request to its FINAL status by `requestId`.

**The lesson worth keeping:** a detector has to be tested against an UNCHANGED world before it is
tested against a changed one. Both bugs were invisible while only checking whether real changes were
caught; they surfaced only in the "nothing changed, so nothing should be reported" assertion.

**Live suite: 56 passed, 0 failed** in isolated Edge (was 42 at v1.5.4). Section 9b now covers aria
baselines, known-world seeding, the quiet-run check, both surprise directions via offline emulation,
network pinning end to end, the wizard, and the FlowSpec round trip.

A third finding was about the TEST rather than the code: the wizard block initially ran straight
after the pinning block, so it saw a page served from a HAR and a console buffer pruned by that
navigation — and asserted against the previous section's leftovers. It now navigates first. Test
ordering is a fixture, not an accident.

### 2026-09-04 — v1.6.0, the tests grew a memory

Everything in §8c. The short version: a recorded flow now remembers what it
normally does, and reports anything new or newly missing even when every
assertion passes.

**Version bumped to 1.6.0 in all THREE places** — `extension/manifest.json`,
`bridge/package.json` and `bridge/src/server.js`'s `VERSION`. They must move together: the bridge
compares them and reports `versionSkew` to the agent, so bumping one is worse than bumping none.
(This was missed on the first pass and caught by the user reloading the extension and seeing 1.5.4.)

New files: `extension/lib/signature.js`, `extension/lib/flowspec.js`,
`extension/tools/netpin.js`, `runner/g9.mjs`, `runner/mcp-client.mjs`,
`runner/report.mjs`, `runner/README.md`, `g9.project.example.json`.

Changed: `extension/lib/visual.js` (structure maps, masks, diff image, three
comparison modes), `extension/tools/qa.js` (`aria` assertion, layout-mode
screenshots, baseline PNGs as attachments), `extension/tools/replay.js`
(evidence collection, signature, surprise detection, calibration, verdicts),
`extension/sw.js` (`Fetch.requestPaused` routing, seven new actions),
`bridge/src/tools.js` (schemas + a Regression-memory section in INSTRUCTIONS),
`setup/extensiontest.mjs` (+9 tests), `README.md`.

Nine regressions added to `extensiontest.mjs`, covering normalisation, both
surprise directions, seeding, confirmation, calibration (including that a
volatile key is then excluded even at the strictest sensitivity), FlowSpec
canonicalisation and its refusal to carry a secret, layout comparison with
masks, pinned-network answering, and schema/router parity. **34 passed.**

Three things were harder than they looked and are worth not rediscovering:

1. **The first test written was wrong about normalisation.** It assumed
   "3 users" and "4 users" collapse to the same string. They do not, and they
   should not — collapsing every digit would hide `level=2` → `level=3`. The
   right answer was that calibration catches a live counter, not the normaliser.
   The test now asserts that, which documents the boundary between the two
   mechanisms.
2. **`publicStep` had to exist.** The step record carries the whole accessibility
   tree and every request — that is the signature's input, and it is far too
   much for a tool result. Stripping it at the boundary, while keeping counts so
   a reader can see the evidence existed, is the difference between a usable
   result and a context-window flood.
3. **Calibration needed the raw signature back from `replay`.** The summary
   only carries `publicStep` output, so comparing two summaries would have
   compared two empty signatures and reported "fully deterministic" for
   everything. `includeSignature` is internal for exactly this reason.

**Live-verified on 2026-09-04** — `setup/livetest.mjs` gained section **9b**, which drives the new
paths against the real seeded page in isolated Edge: **53 passed, 0 failed** (was 42).

It proves the parts that module tests cannot:

- an aria baseline replays and seeds a known world;
- **an unchanged page produces no surprises** — the check that catches a noisy signature;
- offline emulation makes the flow do something it has never done, and the *missing* direction
  catches traffic that always happened and now does not, with **no assertion written for it**;
- a broken run is not reported as `PASS` (`FAIL_PRODUCT`, 61 surprises);
- the known world stays at its approved size — nothing grows it but an approval;
- `record_har` → `pin` → reload actually **serves** recorded responses (`served: 1`), then unpins;
- a FlowSpec round-trips through canonical JSON with every step intact.

**Two real defects that only a live run could find**, both in signature normalisation, both of
which would have produced constant false surprises in production use:

1. **A request captured mid-flight produced a spurious pair.** The same request recorded as
   `GET /x pending` on one run and `GET /x 4xx` on the next generated one "new" key and one
   "missing" key — against a page that had not changed at all. An unfinished request is not an
   observation, so `buildSignature` now skips any request with no status.
2. **Excluding pending was not enough on its own.** A request that had not finished when its step's
   evidence was collected stayed absent from the known world, then appeared as brand-new the next
   time it happened to complete in time. `settleNetworkEvidence` now re-reads the buffer once at
   the end of a run and patches every request to its FINAL status by `requestId`. Requests still
   unfinished then keep a null status and stay out of the signature.

The general lesson is the one this repo keeps relearning: **a detector has to be tested against an
unchanged world before it is tested against a changed one.** Both bugs were invisible while only
looking at whether real changes were caught — they only showed up in the "nothing changed, so
nothing should be reported" check.

### 2026-09-01 — v1.5.4, a script that drives the extension without an agent

`scripts/Save-TelegramImages.ps1` walks a Telegram Web channel backwards and
archives every photo, named from the post's own `data-timestamp`. It speaks MCP
over stdio to a bridge it spawns itself — the same interface the agent uses, no
agent present.

The pattern is worth naming, because it is what this toolset is FOR beyond
answering questions: an agent drives a flow once and learns how the site really
behaves, and that knowledge is then frozen into something schedulable. The
script is small; the exploration that produced it is the expensive part, so it
is written down in `scripts/README.md` as a table of assumption versus reality.

Six things a reasonable guess gets wrong about Telegram, all found by driving
it: the scroller is `.bubbles-scrollable` and `.bubbles` does not scroll;
Telegram restores `scrollTop` after each load so it cannot mark progress; posts
are UNMOUNTED as they leave the viewport (about 30 stay alive at any depth), so
images must be taken as they pass; `scrollHeight` plateaus long before the
history ends and the honest end signal is that no smaller `data-mid` arrives;
sponsored posts carry a real photo and must be filtered by `is-sponsored` /
`mid = -1` / `timestamp = 2`; and the images are `blob:` URLs, readable only
inside the page.

**A limitation worth stating plainly.** The extension attaches to ONE bridge, on
the port in its side panel, so a script cannot run while an editor's MCP client
holds that port — the extension is talking to that one. The script detects this
and refuses with an explanation rather than hanging. Giving the bridge an HTTP
endpoint for tool calls would remove the restriction and was deliberately NOT
done: any web page can POST to localhost, and §5's Origin check is the primary
defence precisely because pages must not be able to issue commands.

Verified: PowerShell's MCP layer (spawn, initialize, notifications/initialized,
tools/call, error surfacing, clean shutdown) drives a real bridge end to end;
the port guard refuses correctly; and every page-side query in the script was
run against the live channel through the agent before being written into it.
The full run needs the MCP client closed, so it is the user's to make.

### 2026-09-01 — v1.5.3, the scroll that worked and said it had not

Asked "so is it done, are there no bugs left?" — and the honest way to answer
that is to go and look. A scroll on a real Instagram profile came back
`moved: false` with a note guessing about inner containers. The page had in
fact scrolled: `scrollY` was already 300 by the time anyone checked.

Wheel scrolling is handled on the COMPOSITOR thread. The CDP command resolves
once the event is queued, and the scroll position updates afterwards, so
reading it once immediately catches the old value. `scroll()` now polls for
movement with a 600ms budget and returns as soon as it sees any.

This is the same family of lie the whole 1.4/1.5 line exists to remove, pointing
the other way: not "it says it worked when it did not", but "it says it failed
when it did". Both send the agent somewhere untrue.

Worth recording WHY no suite caught it: `livetest.mjs` only exercises the plain
scroll path when it is NOT on the seeded test page, so in the isolated run that
branch never executes, and the one scroll that does run (during the video
capture) never asserts that the page moved. A check that never runs is not
coverage.

### 2026-09-01 — v1.5.2, the witness accused a working action

Found by using the tool for something real: posting a birthday carousel to
Instagram. The caption typed perfectly and `browser_interact` reported a
failure — the exact inverse of the v1.4.0 bug, and just as damaging, because an
agent that believes a working action failed will RETRY it, and retrying a click
is how you post something twice.

The witness kept its state in the page across two separate `evaluate` calls:
one installed a counting listener, a later one read the counter. That quietly
assumes both calls land in the same JavaScript execution context. On a
single-page application they do not — Instagram swaps context as its router
moves, so `window.__g9witness` was simply GONE by the time the count was read,
and a zero count was read as "the page received nothing".

It is now armed and read as ONE promise: `Runtime.evaluate` with
`awaitPromise:false` returns the moment the listener is installed (everything
before the first await is synchronous, so the page is definitely listening
before the caller dispatches), and `Runtime.awaitPromise` collects the answer
afterwards. If the context disappears in between, that rejects and resolves to
`null` — "cannot tell" — and null never accuses anyone. Typing additionally
passes a `verify` callback that compares the field's value before and after: an
observable outcome outranks any opinion about events.

**The harness was hiding its own test tab.** Waking an idle MV3 worker opens a
page from the extension's own origin, which pushed the test page into the
background — the one state where a browser stops delivering input. Every
interaction check then failed with a perfectly correct explanation about a
hidden tab, and the harness was testing its own side effect. It now brings the
test page back to the front, which is also what a real user's tab looks like.

**With that fixed, the live suite is fully green for the first time: 42 passed,
0 failed, over three consecutive runs — including the tab-video frame spool,
which needed a tab that is actually being painted and so had been skipped.**

### 2026-09-01 — v1.5.1, the live test runs, and three browser stalls it found

> Historical environment observations. The later live suite sometimes receives screencast frames
> in headless mode; zero frames is not universal. Current capture/input evidence is in §§4.3a and 7.

`setup/isolated-livetest.mjs` had never once passed. Making it work took fixing
why it could not connect, and then the real browser told us three things no
amount of source reading would have.

**It was driving the wrong browser.** A freshly loaded extension has no stored
settings, so `bootstrap()` connects to the default 8765 on its first line —
before any harness can configure it — and the bridge lets the newest client win.
The throwaway profile therefore took over whatever real session was on that port
and answered its tool calls. Nothing the harness does after launch can close
that window, so the address is now baked in ahead of it: the harness copies
`extension/` to a temp directory, writes `dev-bridge.json` beside the manifest,
and `sw.js` reads it before `transport.connect()`. Absent from the real
extension, where it is one failed fetch at startup. `assertPrivateBridge()`
verifies it took effect rather than trusting it.

**`Input.dispatchMouseEvent{mouseWheel}` never returns while a screencast is
running.** Not slow — stuck. The promise does not settle, which consumed the
bridge's whole 60s budget and then reported "the page may be blocked by a
JavaScript dialog": a diagnosis that was not merely unhelpful but WRONG, and
sent three debugging runs in the wrong direction. So `cdp.send()` now bounds
every command (20s; 45s for genuinely slow ones like capture and tracing), and
names the stuck method. `scroll()` falls back to a programmatic scroll when the
wheel wedges and SAYS it did, because scrolling while recording a bug is the
ordinary way someone reports a scrolling bug — but a programmatic scroll fires
no wheel event, so anything driven by wheel will not have reacted.

**`Page.captureScreenshot` intermittently never returns either**, on identical
code that passed the run before. `capture.js` retries a stall once and reports
that it did; a second failure is still a failure.

**Tab video needs a tab that is actually being painted.** `Page.startScreencast`
captures composited frames, so a hidden tab and a headless browser both deliver
ZERO — the command succeeds, frames never arrive, and the only symptom was an
empty video discovered long after the bug had gone. `video_start` now warns
immediately when the tab is not visible, and `video_stop` explains an empty
capture instead of returning a bare zero. This is the same shape as the input
problem in §4.3a: the browser accepts the request and quietly does nothing.

**The harness can hear the extension now.** A failing run prints the service
worker's own console and exceptions. Three runs were spent guessing at a hang
the worker could have explained, except nothing was listening.

Also in this range: the overflow finding scores evidence that an element's width
came from the element rather than the layout (v1.4.1); the scroll witness was
removed because `wheel` may never reach the renderer, and every version bump
since v1.4.0 is its own entry in this range because a hand-reloaded unpacked
extension has no other way to confirm the reload took.

**Result: bridge/MCP 26/26, extension 25/25, isolated real-Edge 41 passed /
0 failed / 1 skipped, three consecutive runs.** The skip is the video frame
spool, which headless cannot produce; it needs a headed run.

### 2026-09-01 — v1.4.1, the overflow finding, finished

Live verification of v1.4.0 caught its own overflow fix only half working, so
this is the second half plus the version discipline that should have carried it.

Ranking suspects by how far each exceeded its own container found NOTHING on the
seeded page. The reason is the same trap in a new costume: once a document
overflows, its containing block grows and every auto-width block inside stretches
to match, so the 2400px culprit and thirty-one innocent ancestors and siblings
all measured 2400–2434px and none of them exceeded its parent. The message fell
back to listing victims by width, honestly labelled and still useless.

Width cannot separate cause from effect here, so `pageAudit` now scores evidence
that an element's width came from the element rather than from the layout around
it: an empty box that is nonetheless wider than the viewport (+3), content that
does not fit inside its own element (+2), an intrinsically sized tag (+2), no
child accounting for the width (+1). Measured against the live page that scores
`div.too-wide` **4** and everything else **1**, and the finding now reads
"Most likely cause: div.too-wide at 2400px — an empty box this wide was given an
explicit width."

**Every change to this repo bumps the version, including this one.** The
extension is loaded unpacked and reloaded by hand, and the version in
`edge://extensions` is the only confirmation the reload took. v1.4.0 shipped the
first overflow fix without a bump, and the user reloaded with no way to tell
whether the new code was in. Small changes take the patch segment.

### 2026-09-01 — v1.4.0, the tools were reporting work they had not done

> Historical diagnosis, not current certification. The generic input witness is broken again in
> v1.7.21, and the audit found working background input in headless Edge. See §§4.3a and 8 for the
> actual defect and the headed states that still need testing.

A full audit — every source file read, all three suites run, and the tool driven
against a real browser through MCP. The suites were green and the product was
not, which is the finding that matters most here.

**`browser_interact` succeeded at nothing, repeatedly.** Typing `admin` into a
field returned `{"typed":"admin"}` and left the field empty. Clicks returned a
target and dispatched nothing. An armed recorder captured one step across four
interactions, because there were no events to record.

The cause is Chromium's, not ours: **a headed browser silently discards
`Input.dispatch*Event` for a page that is not visible.** No error, no event, the
CDP command resolves normally. Reproduced with raw CDP and no extension
involved, and it does NOT reproduce headless — a headless surface is always
paintable — which is why `isolated-livetest.mjs` never caught it and never
could.

Two things made it ours. First, `pinned` mode exists so the user can browse
elsewhere while the agent works, and browsing elsewhere is exactly what makes
the pinned tab hidden: the headline workflow is the trigger. Second, every
action returned an echo of its own arguments instead of checking anything —
`{ typed: text }` was built from the input, never from the page.

So `tools/interact.js` now **witnesses** every dispatch: a capture-phase
listener counts trusted events, and click/hover/type/key/scroll/drag each prove
the page received theirs. When it did not, the error names visibility as the
cause and the foreground as the fix. What is deliberately NOT asserted is the
resulting VALUE — a digit-only field keeping `1234` out of `12ab34` is the page
working (v1.0.15) — so the value is reported and the delivery is verified. This
is the rule the codebase already applied in `select` and `clear`, and `select`
was the only action that refused to lie about this bug; the audit found it
because `select` reported it.

**`browser_issue` video could deadlock the whole extension, permanently.**
`startVideo`, `ingestFrame` and `stopVideo` each called `cdp.send()` inside
`serialize()`. `send()` is not serialized — until the tab is missing from
`attachedTabs`, at which point `attach()` calls `setState()` and
`logActivity()`, and the one shared chain waits on itself forever. Every later
state write, activity entry, console line and network record in the extension
hangs behind it. The trigger is one click: the "browser is being debugged"
infobar's Cancel button fires `onDetach`. All three now reserve state under the
lock and talk to CDP outside it. §4.1's rule is now enforced by a test.

**Connection status was overwriting configuration.** `setState` mirrored the
whole `bridge` object to `storage.local` whenever a patch mentioned `bridge` —
including `{connected:false, lastError}`, which every failed reconnect sends. On
a machine with no bridge that is a disk write per backoff tick, forever. It also
made `isolated-livetest.mjs` impossible to pass: the harness seeds a private
port, and the next status write put 8765 back, so the isolated browser connected
to whatever was on the default port. In this audit that was the developer's own
live session, which it displaced silently — running the test suite broke the
work it exists to protect. Only genuine setting changes mirror now.

**Version skew is now visible.** Both sides have always exchanged a version and
neither compared them, while the documented workflow drifts them every time:
reloading the extension is immediate, the bridge only changes when the MCP
client restarts, and the client caches tool schemas from startup. During this
audit the extension was v1.3.0 and the bridge v1.2.3, so `browser_diagnose` was
missing `vitals` and `memory` with nothing anywhere saying why.
`browser_status` now carries a `versionMismatch` explaining that both sides must
be restarted.

**Evidence that could not be delivered.** `browser_network format:"har"
includeBody:true` had no aggregate cap — 400 requests × 512KB in one frame,
against `ws-server.js`'s 64MB limit, which drops the CONNECTION rather than
truncating. `browser_inspect what:"storage"` dumped Web Storage unbounded. Both
are budgeted now, and both say what they left out.

**Smaller, all live-confirmed or read from the code:**

- `browser_snapshot` returned `title: ""` on every page since v1.0.0. It read
  `docInfo.root.title`; CDP's `Node` type has no such field. The RootWebArea's
  accessible name is the title, and it was already in hand.
- The overflow finding said "Widest offenders" and listed the first five
  elements in DOCUMENT ORDER. Once a page overflows, every centred ancestor is
  dragged past the viewport too, so it named five victims and never the cause —
  on the seeded page, `div, h1, p.lede, section, h2` while the 2400px block went
  unmentioned. It now ranks by how far an element exceeds its own container.
- `checkObscured` and `pointFor` mixed coordinate spaces for anything in an
  iframe: `DOM.getBoxModel` answers in top-level viewport coordinates,
  `getBoundingClientRect` inside `callOnNode` answers in the frame's. v1.3.0
  taught the locators to walk same-origin iframes, which made it reachable.
- Replay called a navigating click a failure. The proof lives on the node and
  the navigation destroys the node, so "did not observe the expected trusted
  event" was reported for exactly the steps whose job was to navigate —
  non-deterministically, since a slow server left the old document alive.
- `select`'s trust proof used `{once:true}` window listeners, which the first
  unrelated `input`/`change` on the page consumed.
- `uniqueText` could return text matching a DIFFERENT element, because the
  element being described need not be in the candidate set.
- `waitForIdle` left a MutationObserver on `documentElement` forever — and
  `diagnose.memory` reports node/listener growth as a leak signal, so the tool
  was contaminating the number it was asked to interpret.
- `locators.js` recomputed the full root walk on every `queryAll`; it is now
  cached for one microtask.
- `store.js usage()` did `getAll()` over every attachment record on every panel
  poll; it walks a cursor now. `deleteIssue` did `storage.session.get(null)`,
  deserialising every capture buffer to read a handful of small records.
- `resolveTarget` said "locks the agent to tab null" in follow mode.
  `originOf('about:blank')` rendered as the literal `null`; `sameOrigin` now
  refuses opaque origins explicitly rather than by accident.

**Tests and harness.** `extensiontest.mjs` goes from 15 to **25** assertions; the
ten new ones pin each defect above, including a brace-matching check that no CDP
call re-enters `serialize()`. `isolated-livetest.mjs` starts its private
bridge BEFORE pointing the extension at it, seeds session as well as local
storage (session outranks local in `getState`), and wakes an idle MV3 worker by
opening a page from its own origin instead of waiting for a target that will
never appear. It also **refuses to run while a bridge holds 8765**: a fresh
extension connects to the default port on its first line, before any seeding is
possible, so the takeover window cannot be closed from the harness — only
declined. `--force` overrides. Bridge/MCP **26/26**, extension **25/25**.

**Note for whoever next reads a green suite.** Both non-browser suites passed
throughout, before and after. They were not wrong; they were testing the layers
where the bugs were not. The interaction bug needed a headed browser and a
background tab, and nothing automated here has ever run in one.

### 2026-09-01 — v1.3.0, QA tests must prove outcomes

One deliberately combined phase: repair every non-security correctness finding
from the review, add the QA capabilities that fit the grouped-tool architecture,
and prove the result through the real browser boundary. No new MCP tools were
needed; the surface remains 14.

**Replay now earns a pass.** Drag executes the recorded source-to-target drag;
keys focus their recorded target; checkbox/select/type outcomes are read back;
click-like actions validate a trusted event on the intended element. Stability
includes element identity, so a replacement node at the same rectangle is not
called stable. The existing replay marker is now set in both session state and
the page for the entire run, including navigation, so an armed recorder cannot
record its own replay. Recursive `{{data}}` substitution fails by name when a
value is missing. Every run persists a summary and the recent window exposes a
mixed-result flaky signal.

**Recorder and select correctness.** Raw event ingestion is serialized, capped
at 5,000, and records truncation. `composedPath()` captures open-shadow targets.
Native select interactions now use CDP keyboard input, verify final selection,
and require trusted input/change when state changed; normalisation discards the
incidental click/key/change machinery and keeps the final values. Intermediate
checkbox/radio/file input events are likewise not mistaken for text entry.

**Evidence is bounded and durable.** Snapshot `maxNodes` now caps every emitted
line, not only ref-bearing nodes. Network pending status lasts until finish/fail,
idle waits require both zero filtered pending requests and 500ms DOM quiet, and
HAR 1.2 exports the captured lifecycle. Impossible history moves no longer erase
refs/evidence. Video frames spool one-by-one to an IndexedDB v2 store before
acknowledgement; session storage holds only metadata. Capture ownership prevents
mis-attribution/deletion and detach/tab-close cleanup reclaims incomplete spools.
Panel recording/issue refresh failures are visible, issue Back flushes edits,
and delete no longer races a pending save.

**Targeting and emulation.** Follow mode returns no target for an unattachable
active page instead of silently controlling the pinned tab. Locators traverse
open Shadow DOM and same-origin iframe documents. Multi mode can wait for a
popup/tab by URL, title, or opener. Network emulation uses
`Network.emulateNetworkConditionsByRule` + `Network.overrideNetworkState`, with
the deprecated command only as a capability fallback. Device/locale/timezone
failures are no longer swallowed; reset reports partial failure. Viewport
application is verified and, for Chromium's headless 4x mobile-layout anomaly,
returns an explicit compatibility warning while preserving exact responsive
dimensions plus mobile UA/DPR/touch.

**QA features.** Recording assertions now cover URL, text, visibility,
value/state, network, console presence/absence, accessibility findings, and a
32×32 normalized visual baseline. Recordings carry suite/folder/tags,
environment variables, data defaults, last-20 run history, and a flaky signal;
they export readable Playwright JavaScript. Diagnose gained actionable language,
image-alt, iframe-title and heading-order checks, buffered Web Vitals/long tasks,
and repeated memory/DOM/listener/document metrics for leak signals.

**Tests and operations.** `extensiontest.mjs` adds 15 extension-side regressions,
including concurrency and deliberate failure cases. `isolated-livetest.mjs`
launches an unpacked extension in a disposable real Edge profile and proves the
actual MCP/WS/CDP/panel chain. `install.ps1` and package scripts run both
non-browser suites. Final pre-release results: bridge/MCP **26/26**, extension
**15/15**, isolated Edge **42/42**, plus panel render and Automation interaction.

**Scope recorded, not rediscovered.** §5 now makes the trusted-local deployment
decision explicit. Request interception/fault injection and download verification
were not added superficially; their reliable lifecycle/permission work remains
documented in §8. Direct tracker integrations remain agent-owned and generic
evidence/export is the integration surface.

### 2026-09-01 — v1.2.3, upload only worked on pages nobody had styled

Found by using the tool for something real rather than testing it: posting to
Instagram end to end. Everything else held — the design was rendered in the
page, written to disk, uploaded, cropped, captioned and shared without a manual
click — and one thing did not.

**`browser_interact action:"upload"` accepted only a `ref`.**

Every upload UI worth the name hides its file input behind a styled button.
Instagram sets `display: none !important` on it; Gmail and GitHub do the
equivalent. A hidden input is not in the accessibility tree, so
`browser_snapshot` never gives it a ref, so `upload` could not address it.

The tool worked on `setup/testpage.html` because the probe input there was
created visible. It would have failed on essentially every real site. A fixture
that is easier than reality tests the fixture.

Clicking the visible button is not the fallback: that opens the OS file picker,
which is outside the browser and outside anything CDP can reach. Setting the
input directly is the entire reason this tool exists.

`upload` now takes `selector` as well, and the error names
`input[type=file]` when neither is given. The workaround used for the live post
— forcing the input visible with `!important` so the AX tree would expose it —
is exactly the friction the fix removes.

**Not yet verified live:** the fix landed after the Instagram session, so it has
been read and not run. First thing to prove next session.

### 2026-09-01 — v1.2.2, replay at the pace it was recorded

Three corrections from the first real use of the recorder, all reported by the
user watching it replay.

**1. A ten-second session replayed in 200ms.** The default was `adaptive`,
which waits only as long as each step needs. That is the wrong default: a flow
compressed to a fifth of a second never lets a debounce fire, an animation
finish, or an autosave race. Those are the bugs a QA is looking for. The default
is now `recorded` — the pace the person worked at — and speed is something you
opt into once you trust the flow, not something that happens to you.

**2. Nothing checked that the page was ready.** A step could run against a
document still loading, which is not the page that was recorded: the element may
exist and be about to move, or its section may not have arrived. Every step now
waits for `readyState === "complete"`, for the element to be visible and
enabled, and — the one that matters most — for **its box to be identical twice
in a row**. An element mid-animation is still moving, and clicking where it
*was* is precisely how a replay hits the wrong thing.

Each condition fails with its own message, because "still loading", "hidden",
"disabled" and "never stopped moving" are four problems with four fixes.

On a fast connection none of this ever shows up, which is exactly why it had to
be checked rather than assumed.

**3. A horizontal scroll the user never performed.** Focusing a field on a page
wider than the viewport makes the browser scroll to reveal it, and the recorder
saw that as an event. A scroll now earns a step only when no element-bound step
follows it — every element-bound step scrolls its own target into view anyway.
What survives is the case that meant something: the user scrolled to look at
something and stopped there.

### 2026-09-01 — v1.2.1, three jobs in three places, and an old mistake repeated

**Replay was broken from the moment it shipped.** `await import()` inside the
service worker — disallowed on `ServiceWorkerGlobalScope` by spec — so every
element-bound step threw. The v1.0.0 entry in this very file records the same
mistake ("dynamic `import()` inside a hot path in sw.js — hoisted to a static
import") and I made it again. Hoisted; the extension has no dynamic imports
left.

It was found by the panel error strip added in v1.0.11, which printed the spec
violation verbatim. Before that it would have surfaced as a replay that silently
did nothing.

**Three tabs.** Connecting an agent, recording a flow, and filing a defect share
nothing but the browser. Stacked in one column they buried each other, with
connection settings a person reads once sitting above the buttons they press
every day.

**Issue capture rebuilt around the right order.** "New issue" now captures
FIRST and asks questions second. The evidence — console tail, failed requests,
screenshot, surrounding DOM — is only true while the bug is on screen; a title
can be written any time after. The old form held itself open while the page
moved on underneath it. The issue then opens in its own editor: screenshot,
full page, tab video, file attach, re-capture, live-saving fields, delete.

**Context is written as real attachments**, not only as a nested object. An
agent filing to Jira uploads *files*: `console.log`, `failed-requests.log`,
`page-context.json` and `page-fragment.html` on a ticket are things a developer
opens and reads, while the same bytes in a JSON field are something the agent
must paste into a description and truncate. `page-fragment.html` is the one that
cannot be recovered later — the DOM around the element under suspicion, gone the
moment the tab moves on.

### 2026-09-01 — v1.2.0, recorder, replay, and issue capture

The three subsystems designed in §8b, built. 12 tools → 14: `browser_recording`
and `browser_issue`, grouped rather than flat, keeping §4.4's budget (~4.7k
tokens of definitions, against the 18k `chrome-devtools-mcp` spends).

`lib/locators.js` is the core, and §8b explains why. Verified live before
anything was built on top of it: the names it generates match `browser_snapshot`
exactly on all five controls of the test page, and all three recorded elements
survived a simulated redeploy that regenerated every id, replaced every class
with framework hashes, and moved the DOM — matched by `role`, first try, correct
element.

Two bugs that only a real DOM could have shown:

- A wrapping `<label>` made the accessible name of a `<select>` include every
  `<option>`, so the recorder called it *"Environment Development Staging
  Production"* where the AX tree says *"Environment"*. Recorder and agent would
  have disagreed about element identity — the exact failure the file exists to
  prevent.
- Name similarity was word-overlap first. "Username" and "User name" share no
  words, and splitting or joining words is the commonest label edit there is.
  Now character-bigram Dice.

`tools/record.js` keeps all judgement out of the page: the injected script emits
raw events, the extension decides what is one step. That is where the
interesting mistakes live — a double click arrives as click, click, dblclick,
and typing "admin" arrives as five input events — and keeping it in the
extension makes it ordinary code that can be tested without a browser.

### 2026-08-31 — v1.1.0, the stable base

Nineteen patch versions of finding and fixing, driven by actually running the
tool rather than reading it. All twelve tools have now been exercised live
against Edge, on both the seeded test page and a real heavy application. This is
the baseline that feature work starts from — hence the minor bump.

**Two deliberate omissions closed, both flagged in §8 since v1.0.0.**

- `scripting` and `downloads` are gone from the manifest. Neither was ever
  called; grep confirms no reference in any module. They cost the user two extra
  lines in the install warning for capabilities that did not exist. Either is
  one manifest line to restore when a feature needs it — which is cheaper than
  asking for access that goes unused.
- `install.ps1 -WriteProjectConfig` writes `.mcp.json` at the repo root. Opt-in,
  because the installer is then writing into the user's project rather than
  under `setup/`; it refuses to overwrite an existing file, and the closing
  instructions drop to one manual step when it is used. This is the step that
  cost a full debugging session in v1.0.7 — the config was never installed, the
  bridge was never launched, and the side panel's honest "Bridge offline" read
  like a defect.

**One thing worth recording for whoever edits `install.ps1` next.** Editing it
produced a file that *tokenized* clean and did not *parse*: fourteen cascading
errors, the first pointing at a line that was fine in isolation. The cause was
mixed line endings — this repo is CRLF on disk under `core.autocrlf`, and
inserted LF-only text breaks the PowerShell parser in ways that report far from
the actual damage. Two lessons: **normalise line endings after editing the
`.ps1`**, and **`PSParser::Tokenize` is not a parse check** — use
`Language.Parser::ParseFile`, which is what caught it.

### 2026-08-31 — v1.0.19, follow mode, and the fourth door

First test in **follow** mode. The boundary held — `browser_tabs action:"open"`
was refused with the mode named — and two bugs showed up that only exist in that
mode or only show when two tools are compared.

**1. `browser_tabs action:"list"` disclosed every title and URL, in every
mode.**

`browser_status` redacts other tabs to their origin outside multi mode
(v1.0.7). `browser_tabs list` returned full titles and URLs — including, in the
test, the title of a YouTube video the user was watching. Same boundary, same
information, opposite behaviour.

The cause is not subtle: **the disclosure rule was written in two places, so it
drifted.** `inspect cookies` (v1.0.14) was a third place with no rule at all.
There is now one — `listTabs()` in `tabs.js`, the safety-boundary module — and
`browser_status` consumes its output instead of re-deriving it. `originOf` had
also been copy-pasted into three files; it is now exported from one.

That makes four doors on this boundary found one at a time: `browser_tabs`
actions, the `browser_status` tab list, `inspect cookies`, and now the
`browser_tabs` listing itself. The lesson has been recorded twice and is worth
sharpening: **a rule enforced in more than one place is a rule that will drift.**
Not "check every path" — *have one path*.

**2. `browser_status` reported the wrong tab in follow mode.**

`status()` described `pinnedTabId`. `resolveTarget()` acts on the *active* tab
when the mode is follow. So after the user switched tabs, the orientation tool
would report page A while every other tool operated on page B — and the health
counts belonged to A as well. Both now ask `currentTargetId()`, the same
question `resolveTarget()` asks, and the listing marks the effective target with
`target: true`.

For the tool whose entire job is "tell the agent where it is", describing the
wrong page is the only error that matters.

### 2026-08-31 — v1.0.18, detach batched, and made measurable

v1.0.17 fixed the banner; the user reported it now clears but takes 5–10
seconds. Part of that was mine.

`unpinTab()` detached tab by tab, and each `detach()` did its own
`getTargets()` verification plus its own `getState`/`setState`/`logActivity`
pair through the serialized write chain. For N held tabs that is N round trips
and 2N serialized writes, in sequence, while the user watches the banner.

`detachMany()` replaces it: the `debugger.detach` calls go out together (they
are independent), one `getTargets()` answers for all of them, and there is one
state write and one log entry. `unpinTab` also releases first and does the ref
and buffer cleanup afterwards — nothing behind the banner needs to block it.

**The rest of the delay may well be the browser's, and rather than guess, the
path is now timed.** `detachMany` records `ms` in the activity log and the
panel's Detach toast reports it. If that reads ~50ms while the banner lingers
for seconds, the remaining time is Chromium tearing the session down and there
is nothing here to fix; if it reads seconds, it is ours. Measuring cost one
line, and the alternative was another round of speculation about a component
whose timing we had never observed.

### 2026-08-31 — v1.0.17, "the banner didn't go away when I detached"

Reported by the user, and the right thing to notice: they could see the "browser
is being debugged" banner while the panel showed nothing attached. Two real bugs
behind it, both of the family this log keeps recording.

**1. `detach()` swallowed its own failure and reported success.**

```js
try { await api.debugger.detach({ tabId }); } catch { /* already gone */ }
…
await logActivity({ kind: 'detach', tabId, ok: true });
```

The catch assumed the only failure mode was "already gone". If the detach did
not take — another client holding the target is the common case — the tab was
still removed from `attachedTabs` and the activity log recorded a clean detach.
The user was then looking at a banner the extension insisted did not exist.
`detach()` now checks `chrome.debugger.getTargets()` afterwards and returns
`{ detached, stillAttached, error }`, logging the failure with the likely cause.

**2. `unpinTab()` detached only the pinned tab.**

`attachedTabs` accumulates — `send()` attaches whatever tab it is handed, so
follow mode picks up every tab the user visits and multi mode every tab the
agent touches. Detach released one of them. The banner is per attached tab, so
the rest kept theirs, on tabs the panel no longer even listed. It now detaches
everything held and returns a per-tab result.

**Made visible, since the user can see the banner and the tool could not.**
`browser_status` gained `debuggedTabs`, counted from what the *browser* reports
rather than from our own bookkeeping — a drift between the two is precisely what
made this invisible. The panel's Detach now toasts the warning instead of an
unconditional "Detached".

Worth naming, because it is the same shape as v1.0.15's `cleared: true` and
v1.0.12's `reset: true`, and because a `catch {}` with a reassuring comment is
how all three got written: **"already gone" is a guess about why a call failed.**
The call does not say that. Checking costs one API call and turns an invisible
wrong state into a reported one.

**Also this round.** `browser_snapshot` was exercised on a real heavy page
(Instagram: 1546 DOM nodes, 1.6MB of markup, 167 interactive elements) — the AX
tree came back clean and legible, `truncated: true` honest, names and refs
intact. Deliberately kept small: it is the user's live logged-in account, not a
fixture, and there is no reason to page their feed into a transcript.

### 2026-08-31 — v1.0.16, a parameter that read as working and did nothing

Both v1.0.15 fixes verified on the fields that defeated the old code: `clear`
now replaces (`123456cd78` → `9090`) on the key-filtered input, and on a field
that blocks `Delete` it throws — *"still contains \"STUCK VALUE\" … Nothing was
typed"* — leaving the value untouched rather than appending to it.

**Two design claims measured, both hold.** `browser_network status:"pending"`
returns a genuinely in-flight request (`status: null`, `durationMs: null`). And
§4.3's drag claim: dragging a `draggable="true"` button produced the full native
sequence — `dragstart`, seven `drag`, `dragenter`, `dragover`, `drop`,
`dragend`. Chromium promotes the interpolated mouse moves into a real HTML5
drag; a single source→target jump would not. `mouseup: 0` on the page's own
listener is correct, because the browser stops delivering mouse events once a
native drag begins.

**The bug: `browser_inspect what:"dom"`'s `depth` did nothing.**

`depth` was passed to `DOM.getDocument`, which only controls how much of the
node tree CDP puts in its *response*. `DOM.getOuterHTML` then serialised the
whole document regardless, so `depth: 1` returned the same 15KB as `depth: 10` —
including the page's entire `<style>` block and every script. An agent asking
for a shallow overview got the opposite.

Depth is now applied where it has to be, in the page: a real walk that collapses
subtrees past the limit into `<!-- N child elements elided at depth D -->`. The
output is still HTML, so it stays recognisable, and one element's full markup is
a `ref` or `selector` away.

**Test harness:** `setup/serve.mjs` gained `/hang` (accepts the connection and
never answers) and `/slow?ms=` (answers after a delay). `pending` cannot be
observed any other way — network throttling does not help, because an agent's
round trip is slower than any latency you can emulate. Four attempts with
`slow-3g` all came back with the requests already finished.

Related to v1.0.15's lesson and worth stating separately, because it is a
different failure: **a parameter that is accepted, documented, and ignored is
indistinguishable from one that works** until someone compares two values of it.
`emulate reset` and `cleared: true` over-claimed an *effect*; this over-claimed
a *control*. Both are only visible if you check the result against the request.

### 2026-08-31 — v1.0.15, "cleared: true" was not true

Both v1.0.14 fixes verified: the cross-origin cookie read is refused with the
mode named, and `screenshot area:"element"` now returns the actual Sign in
button instead of a blank rectangle. Also confirmed live: `emulate` offline
(`navigator.onLine: false`, fetch failed) and manual `width`/`height`,
`key` with `repeat: 3` (three keydowns), and `F2` → `code: "F2"`, `keyCode: 113`.

**§4.3's central claim, measured for the first time.** A field with a
`keydown` filter that rejects non-digits:

| mode | typed | landed |
|---|---|---|
| per-character (default) | `12ab34` | `1234` — filter respected |
| `fast: true` | `56cd78` | `cd` got through — filter bypassed |

That is exactly the trade-off §4.3 describes, and it is now evidence rather
than reasoning. `insertText` is one IME-style insertion; the page never sees
per-key events and never gets to reject anything.

**The bug it exposed: `clear: true` did nothing and reported success.**

`clear` sent Ctrl+A then Delete. The field's own filter checks
`e.key.length === 1 && !/[0-9]/.test(e.key)` — which matches the "a" of the
chord and calls `preventDefault()`. Select-all never happened, Delete deleted
nothing, and the subsequent typing **appended**: `1234` became `123456cd78`
while the result said `cleared: true`.

Two changes, and the second matters more than the first:

- Selection now goes through the DOM (`this.select()`), not a key chord.
  Selecting is not an edit, so doing it directly costs nothing a framework needs
  to observe — the Delete that follows is still a real trusted key event, and
  that is what raises `input`/`change`. This is not a retreat from §4.3: the
  edit stays trusted, only the selection stops being blockable.
- The clear is **verified**. If the field still holds text, the tool throws and
  names what is left, and types nothing — because typing after a failed clear
  silently turns "replace" into "append", which the agent cannot detect from
  the result.

This is the third instance of one pattern in nine versions: `emulate reset`
returned `reset: true` having cleared four of seven overrides (v1.0.12), the
element screenshot returned a valid image of the wrong region (v1.0.14), and now
`cleared: true` on a field that was never cleared. **A tool that reports success
it did not verify is worse than one that fails**, because the failure moves
downstream and arrives as a wrong result rather than an error. Where a tool
claims an effect, check the effect.

*(The filter in the probe was deliberately naive — real ones test `e.ctrlKey`
first and would not have swallowed the chord. The fix is worth having anyway:
it makes clearing independent of whatever the page does with keydown.)*

### 2026-08-31 — v1.0.14, the safety boundary had a third door

All v1.0.13 fixes verified live. Extracted text is intact — *"G9 Agent Test
Page"*, *"/api/missing"*, *"browser_interact"*, every "s" present. `inspect
styles` returned 7 declarations for the button rule instead of 60. Calling
`browser_dialog` with no dialog open self-healed and said so. Also confirmed:
`waitUntil:"idle"`, `console` level+contains filters, `network` method+status
filters (2 seeded 404s out of 15 requests), `inspect dom` by selector, and
`navigate back`/`forward`.

**1. `browser_inspect what:"cookies"` read any origin, in any mode.**

Pinned to `127.0.0.1:5199`, one call returned 39 live cookies for
`whatismyipaddress.com` — a domain the agent was not attached to and the user
never consented to. `chrome.cookies` is not scoped to the debugger session; it
reads every domain in the profile. So `url: "https://mail.google.com"` would
have handed over live session cookies for it.

This is the same hole as `browser_tabs` and the `browser_status` tab list, both
closed in v1.0.7 — and it was in the same file I was reading at the time. The
mode boundary is now enforced for the `url` override too: outside multi mode it
must match the attached tab's origin.

Three doors on one boundary, found one at a time, is the argument for asking
**"where else can this capability be reached?"** rather than "is this path
guarded?". The remaining answer for `chrome.*` privileges: `chrome.downloads`
and `chrome.storage` are declared but unused, and `chrome.tabs` is covered.

Also capped at 40 cookies with a `truncated` count. 39 cookies × 9 fields is a
large answer to a question the agent usually asks about one session cookie.

**2. `browser_screenshot area:"element"` captured the wrong region on any
scrolled page — and returned a blank image rather than an error.**

`DOM.getBoxModel` returns **viewport** coordinates. `Page.captureScreenshot`'s
`clip` is in **page** coordinates. They agree only at scroll offset zero, which
is exactly the condition every casual test runs under. On the test page — 2780px
wide, scrolled 1269px right by `scrollIntoView` — the Sign in button sat at
viewport x=1422 and page x=2691, and the capture took x=1422: a blank stretch of
background, returned as a valid 72×38 PNG.

Now measured in one page call that returns page coordinates directly
(`getBoundingClientRect()` plus `scrollX/scrollY`), with
`captureBeyondViewport: true`. Simpler than `getBoxModel` and the coordinate
space cannot drift again.

Worth noting what made this hard to see: **the failure produced a plausible
artifact.** A thrown error would have been found in v1.0.0. An image of the
wrong thing looks like a working tool with a boring subject.

**Not a bug:** `browser_network` returned 0 requests while the console held 22
entries, right after an extension reload. `Runtime.enable`/`Log.enable` replay
the messages a page has already produced; `Network.enable` does not replay past
requests. That asymmetry is real, is already documented for the agent in
`INSTRUCTIONS`, and explains a confusing pair of numbers.

### 2026-08-31 — v1.0.13, a regex that ate every letter "s"

Second full sweep. The v1.0.12 fixes all held — navigating from the noisiest
site available to the test page produced **6 console errors and 1 warning**
where the same navigation produced 29 and 469 before, with no `undefined
undefined` findings, no residue, all six seeded defects present, and nothing
omitted. `emulate reset` cleared all eight overrides (`Asia/Tehran` turned out
to be the host's real timezone, checked before reporting it as a bug). The
dialog guard rejected a blocked call instantly, naming the alert and its text.

Newly verified live: `upload` via `DOM.setFileInputFiles` (file set, `change`
fired, no picker), `drag` (1 mousedown, 13 moves along a real interpolated path,
1 mouseup), `right_click` (real `contextmenu`, button 2), `double_click`
(`detail: 2`), `hover`, `scroll`, `console since` polling, `inspect frames` and
`styles`, and ref behaviour across `pushState`.

**1. `browser_snapshot mode:"a11y+text"` corrupted every letter "s". Since
v1.0.0.**

The extracted text came back as *"G9 Agent Te t Page"*, *"U ername"*,
*"/api/mi ing"*, *"brow er_interact"*. The cause is one character in
`snapshot.js`:

```js
expression: `… .replace(/\s+/g, ' ') …`
```

That is a **template literal**, so the escape is parsed twice. `\s` is not a
valid JavaScript string escape, so the template literal quietly reduces it to a
bare `s`, and the page ran `/s+/g` — replacing runs of the letter "s" with a
space. Two other injected regexes in the codebase (`diagnose.js`,
`interact.js`) were already correctly written `\\s`; this one was not.

Nothing failed. No error, no exception, no empty result — just text that looked
like text and was wrong. It survived thirteen versions because `a11y+text` had
never been called.

**Guard added, because the bug class matters more than the bug.** Self-test
section 13 (**25 → 26**) extracts every template literal from `extension/lib`
and `extension/tools` and fails on any single-escaped regex class. It strips
comments first — the comment explaining this bug quotes `` `\s` `` in backticks,
and a checker that fires on its own documentation is a checker people learn to
ignore. Verified both ways: green on the fixed tree, and red with
`snapshot.js: \s` when the bug is reintroduced.

**2. `inspect styles` returned 60 declarations for a 7-declaration rule.**

CDP's `cssProperties` includes every longhand a shorthand expands into,
alongside what the author wrote. Most of the expansions had empty values
(`"border-top-color: "`) because the value lives in the shorthand, and
`box-sizing` appeared twice. Only authored declarations carry a `range` — their
span in the stylesheet text — so that is now the filter. The tool answers "what
does the CSS say", and it should answer with the CSS.

**3. A lockout I introduced in v1.0.12 and had to close.**

The new dialog guard rejects every tool while `dialogOpen` is set. If that flag
ever outlived its dialog — a missed `javascriptDialogClosed`, a worker restart
at the wrong moment — the agent would be permanently locked out, which is worse
than the 60s timeout the guard replaced. `handleDialog` now clears the flag both
when it handles a dialog and when CDP reports there is none, so the recovery the
error message already names always works. `browser_dialog` being exempt from the
guard is what makes it the escape hatch.

**Correction to §8:** it claimed "SPA route changes via `pushState` invalidate
all refs". Only path changes do. `resolveRef` compares URLs with the hash
stripped, so hash routing — `#/orders/42`, the common SPA case — keeps its refs,
which is the correct behaviour and better than documented. Verified both ways.

**Not a bug, recorded so it is not chased again:** clicking `confirm()` did not
always block. Whether Chromium surfaces or auto-answers a dialog depends on
window focus and prior dialogs on that page. The guard was verified instead with
a `setTimeout`-scheduled `alert`, which blocks deterministically.

### 2026-08-31 — v1.0.12, a full sweep of every tool, and the five it broke on

First systematic pass over the whole toolset against the test page rather than
one tool at a time. Everything below was found in a single sweep.

**Confirmed working, live, for the first time:** `select` (value became `prd`),
physical key codes (`5`→`Digit5`/53, `-`→`Minus`/189, `Ctrl+b`→`KeyB`/66, all
`isTrusted`), full-page screenshot scaling (2780px page at `scale: 0.719`, the
whole overflow visible where the old crop cut it at 2000px), `inspect` box /
storage / cookies, `emulate` applying all six overrides, `navigate wait` in both
directions, `network` detail with response body, the stale-ref error, and a
14382-event performance trace rolled into a readable summary.

**1. `undefined undefined` findings in the health report.**

Seven of them. `upsertRequest` created a record for *any* `Network.*` event, so
a `loadingFailed` for a request whose `requestWillBeSent` we never saw produced
a record with a status and no method or URL — rendered as
`undefined undefined -> FAILED: net::ERR_CONNECTION_CLOSED`. Only
`requestWillBeSent` may create a record now; every other event updates one or is
dropped. A finding that names nothing is worse than no finding: the agent cannot
act on it and cannot tell that it is meaningless.

**2. The v1.0.9 buffer reset was necessary and not sufficient.**

Clearing before `Page.navigate` still left hundreds of the previous page's
entries. The outgoing page keeps running until the new document commits, and its
dying ad scripts, aborted requests, and tracking-prevention warnings all land
*after* the clear. The test page — three seeded console errors — reported 29
errors and 469 warnings, nearly all belonging to the site we had left.

Fixed with `loaderId`, which is the honest key: every request of a document
carries the same one, including the document request itself. On main-frame
`Page.frameNavigated`, `pruneToLoader()` keeps exactly the new document's
requests and drops the console. This also closes the §8 limitation recorded in
v1.0.9 — **click-driven navigation is now handled too**, since it commits
through the same event, as is the internal reload in `diagnose.performance`.
Same-document `pushState` raises `Page.navigatedWithinDocument` instead, so SPA
route changes correctly keep their buffers.

**3. `browser_emulate reset:true` cleared four of seven overrides** — and
returned `reset: true` regardless, which is what makes it a bug rather than a
gap. After resetting an iPhone/Tehran emulation the page still reported an
iPhone user agent and `Asia/Tehran`. Touch emulation, timezone, and locale were
never cleared, and the user agent *cannot* be: CDP has no clear command for it,
only another set. So the real one is now captured before the first override and
restored on reset. `reset` returns the list of what it actually cleared.

**4. A JavaScript dialog cost a full 60-second timeout.**

`confirm()` freezes the renderer, so the call that opened it never returns. The
extension knew immediately — it already broadcast the dialog to the panel *and*
sent it to the bridge — and nothing acted on either. Two fixes, because there
are two distinct victims:

- The bridge fails the in-flight call the moment the dialog event arrives,
  naming `browser_dialog` as the recovery. It skips a pending `browser_dialog`,
  which is the call that would fix it. This is transport correlation, not
  browser logic: the extension decided what happened, the bridge only knows
  which promise is waiting.
- The extension tracks `dialogOpen` in state and rejects every later non-dialog
  tool call instantly, instead of each one burning its own 60s.

**5. Not a bug, recorded so it is not re-investigated:** under mobile emulation
on a horizontally overflowing page, `innerWidth` reports the zoomed-out layout
width (1572) while `clientWidth`, `screen.width`, `visualViewport.width`, and
`outerWidth` all correctly report 393. That is Chromium behaviour. An agent
checking `innerWidth` alone will misread it.

### 2026-08-31 — v1.0.11, the trust surface was lying

Reported by the user: pressing "Attach & Pin current tab" no longer showed the
tab in the panel. `browser_status` at the same moment returned a fully attached
tab, so the agent side was correct and only the panel was wrong — the panel was
showing "No tab attached yet" about a tab the agent was actively driving.

That is the worst possible thing for this particular component. §4.5 makes the
panel the trust surface: the user's evidence of what the agent is allowed to
touch and what it has done. A panel that silently shows stale state is worse
than one that shows an error, because it invites exactly the wrong conclusion.

**Root cause: `refresh()` swallowed every failure in a bare `catch {}`.** The
comment defending it ("the worker may be starting up; the next poll will catch
it") is true for the first second and wrong forever after. `render()` mutates
the DOM section by section, so anything that throws part-way leaves the panel
half-updated with no clue — which matches the report exactly: the bridge card
and the MCP snippet were current, everything below them was the initial HTML.

- `panel.js` — `refresh()` now separates three failures that used to look
  identical: the message never reached the worker, the worker answered
  `ok:false`, and `render()` threw. Each surfaces in a new error strip, and
  clears when the next poll succeeds. A missing receiver on the very first poll
  is still tolerated silently, because that one really is normal.
- `panel.html` / `panel.css` — the `#panelError` strip.

**Also fixed, and visible in the user's screenshot:** the empty activity log
wrapped one word per line. `.log li` is a three-column grid, and the empty-state
`<li class="muted pad">` has a single text child, so its text landed in the 52px
time column. `.log li.pad` opts out of the grid.

**Also:** `getState` was shipping the whole 200-entry activity log on every poll
— every 2.5 seconds, for as long as the panel is open — when `renderLog()` draws
at most 120. Now sliced worker-side, with `PANEL_ACTIVITY_LIMIT` next to the
router so the two stay in step.

The underlying failure is the same one this change log has now recorded five
times: **a component reported a state that was not true, and the reason was
discarded at the point where it was known.** v1.0.2 exited without saying why,
v1.0.4 logged to a console nobody reads, v1.0.8 died before it could speak, and
here the panel caught the exception and dropped it. The pattern to watch for is
not a missing message — it is a `catch` with nothing in it.

### 2026-08-31 — v1.0.10, the fix for #3 moved the bug instead of removing it

Found by re-testing v1.0.9 live rather than by reading the diff. The v1.0.9
per-severity budget was a real improvement and did not solve the problem it was
written for.

`browser_diagnose health` on a heavy ad-tech page returned a report that
**contradicted itself in the same response**:

```
"formIssues": 7          <- the summary counted them
findings: [ … ]          <- and not one finding had kind:"a11y"
```

Findings are pushed console → network → page audit, and the sort is stable, so
within the warning severity the console entries all come first. The page had 60+
console warnings, which consumed the entire budget of 20 before a single audit
finding was reached. Same outcome as the flat `slice(60)`, reached by a
different route.

The lesson is about the shape of the fix, not the numbers. A *quantity* cap was
never the right tool, because the problem was never quantity — it was that
unrelated findings compete for one budget on equal terms. The fix is priority:
audit findings (`a11y`, `layout`, `dom`, `asset`) now outrank capture noise at
the same severity. They are the only findings this tool produces that no other
tool does — an agent can read the console and the request list directly, but
nothing else reports an unlabelled input or a horizontally overflowing layout —
and they are bounded by construction, so the priority costs nothing.

Verified against the exact live shape (14 console errors, 60 console warnings,
20 network errors, 9 audit findings): all 9 audit findings survive.

**Worth stating, because it nearly did not get caught:** this bug was found by
the *fix* for the previous one. Had the v1.0.9 diagnose fix not been re-run
against a noisy page, `slice()` would have been replaced with a budget that
reads more correct and behaves identically. **Re-test the fix, not just the
bug** — a fix that changes the mechanism without changing the outcome is the
easiest kind to ship.

### 2026-08-31 — v1.0.9, the first real live run, and what it caught

The first session where an agent actually drove this tool against the test page.
It closed the oldest open gap and immediately found three bugs that no amount of
re-reading the source had surfaced — including one in the exact function whose
entire purpose is to prevent the failure it was allowing.

**The gap is closed.** `setup/testpage.html` has carried six deliberate defects
since v1.0.0, and every version since has said "test-page defect detection still
unverified" because every live run happened to be against a third-party site.
`browser_diagnose health` on the page now finds all six: both seeded console
messages plus the uncaught `ReferenceError`, the 404, the broken image, the
unlabelled password input, `2780px content in 1511px viewport`, and
`Duplicate element IDs: dupe`.

**1. `checkObscured()` had a false negative — the worst class of bug this
codebase has.**

§4.3 says silent misclicks are the worst possible failure and the check is
"deliberately strict". It was not. Clicking the deliberately-covered button
succeeded, and returned a cheerful `clicked: button "You cannot click me"`.

The overlay in the test page is `.cover::after { position:absolute; inset:0 }`.
`document.elementFromPoint()` **never returns a pseudo-element** — it returns
the element that generated it. So the hit came back as `section.cover`, which is
the button's own ancestor, and the guard clause

```js
if (top === this || this.contains(top) || top.contains(this)) return { ok: true };
```

waved it through on `top.contains(this)`.

The clause was not arbitrary; it was covering a real case. But it conflated two
opposite situations, and the asymmetry is the whole point:

- a **descendant** on top (a `<span>` inside the button) is fine — the event
  fires on it and bubbles *up* to the target;
- an **ancestor** on top means the target is covered — the event fires on the
  ancestor and bubbles *away*, and the target never sees it.

Now uses `elementsFromPoint` (plural) and asks the real question: will a click
here reach the target? The one ancestor that legitimately forwards activation is
`<label>`, so that is allowed explicitly rather than as a side effect of
`contains()`. The error also names the actual cause — "covered by its ancestor
`<section.cover>`, whose ::after pseudo-element is painted over it (a
click-shield overlay)" — because naming the ancestor alone reads as nonsense.

Verified live against five controls: the covered button is refused, and the two
inputs, the button, and the select all still pass.

**2. Capture buffers were never cleared on navigation, which made
`browser_diagnose` actively misleading.**

Navigating from a busy site to the test page produced a health report that was
roughly 90% the *previous* page's ad-tech noise — findings stamped
`"where": "https://whatismyipaddress.com/"` while that page was no longer
loaded, presented as defects of the page now open. That is worse than missing
data: an agent reads it and confidently reports a defect that does not exist.

`navigate`, `reload`, and `history` cleared refs and not the buffers. They now
share a `resetPageState()` that does both. Clearing happens **before**
`Page.navigate`, not after — the main document request is issued by the
navigation itself, so a clear afterwards would throw away the single most
useful record.

Still open, and recorded in §8: navigation caused by a *click* goes through
`Page.frameNavigated`, which does not reset the buffers. Doing it there is not a
one-line change, because the document request arrives before the event.

**3. `findings.slice(0, 60)` silently dropped every warning.**

Findings are sorted by severity and then cut at 60. On the dirty run there were
~69 error-level findings, so the cut landed inside the errors and **all**
warnings were discarded — which is exactly where the accessibility, layout, and
duplicate-ID checks live. Those three are the only findings nothing else in the
toolset produces, and they are the reason to call `browser_diagnose` instead of
just reading the console. Any site carrying ad tech clears 60 errors easily, so
this was not an edge case.

Replaced with per-severity budgets (30 error / 20 warning / 10 info) and an
`omittedFindings` count so the agent knows something was cut.

Also: finding messages are now capped at 300 characters. One "Tracking
Prevention blocked access to storage" entry ran 2000 characters of encoded
tracking URL, and forty of those is 80KB of the agent's context spent on
nothing. The full text is still there via `browser_console`.

**What this run says about the review that preceded it.** The v1.0.7 audit read
every line of this codebase and found seven real problems. It did not find any
of these three, because all three are only visible when the tool is pointed at a
page that exercises them. `checkObscured` in particular reads correctly — the
bug is in the browser API's contract, not in the logic. **Reading code finds
different bugs than running it, and neither substitutes for the other.**

### 2026-08-31 — v1.0.8, a taken port looked like a broken server

Found immediately after v1.0.7, and **caused by me**: while verifying that the
configured path started a working bridge, I ran one in a background shell and
"killed" it with `kill $PID`. In Git Bash on Windows that killed the job wrapper,
not the `node.exe`. The orphan kept port 8765.

What the user then saw was a genuinely confusing pair of signals:

- the side panel said **Bridge connected** — true, the extension had connected to
  my orphan
- Claude Code said **`g9-browser` — Connection closed, Failed**

Both were accurate, and together they pointed nowhere. The actual chain was:
orphan holds 8765 → the client's own bridge hits `EADDRINUSE` → `process.exit(1)`
→ the client reports only that the process died. The bridge had written a
perfectly good `FATAL: port 8765 is already in use` to stderr, where nobody was
looking.

Diagnosis took one command, `netstat -ano | grep 8765` plus a parent-process
lookup, which named `bash.exe` and a creation time matching my own test to the
second. Recording that because the instinct in the moment is to re-read
extension code.

**The fix is not a better message — it already had one. It is not exiting.**
The stdio channel is completely independent of the WebSocket port, so the bridge
can serve MCP perfectly well while unable to reach the browser:

- `server.js` — `listenOrExplain()` replaces the `process.exit(1)`. On failure it
  records `startupFailure` and stays up. `call()` rejects every tool with that
  text, and `g9://status` reports it.
- `describeStartupFailure()` probes `/health` on the contested port to tell the
  two causes apart. "Another G9 bridge is already there, close the other editor
  window" and "some unrelated program has the port, free it or change G9_PORT"
  send the user to completely different places, and guessing wrong wastes the
  session.
- It retries the bind every 5s, so closing the other window heals this bridge
  without an editor restart. The retry timer is deliberately not `unref`'d: with
  no listening socket it is the only thing holding the loop open, and a bridge
  that quietly exits is the exact failure being removed.

`setup/selftest.mjs` — section 12, three assertions (**22 → 25**): a second
bridge on a taken port still answers `initialize`, still returns an error that
names the port, and identifies the holder as another G9 bridge. Self-healing was
verified by hand (kill the holder, watch the blocked bridge bind and start
answering) but left out of the self-test, which would have to sit through a 5s
retry for it.

**This is the fourth time the same shape has appeared** — v1.0.2 (bridge bound
the port then exited), v1.0.4 (`ERR_CONNECTION_REFUSED` in the extension
console), v1.0.7 item 8 (missing MCP config), and now this. Stated once, plainly,
because it keeps costing sessions: **the component that reports a failure is
usually not the component that caused it, and it is usually not wrong.** Before
changing the reporter, prove the thing it is reporting is false. `curl /health`
and a process list beat reading source code, every time so far.

### 2026-08-31 — v1.0.7, the safety boundary had a side door

A full read-through of the codebase against this file, at the user's request,
before starting a round of feature work. Seven findings, all fixed here. Two of
them are real defects; the rest are drift between what this file claims and what
the code does, which is the same thing one step earlier.

**1. `browser_tabs` bypassed both the mode boundary and the Stop button.**

The tool table marks it `needsTab: false` — correctly, it has no target to
resolve — and `resolveTarget()` was the only place `mode` and `halted` were
checked. So in pinned mode an agent could call
`browser_tabs {action:"pin", tabId: <any tab>}` and then work on that tab
entirely legitimately. Pinned mode exists precisely to stop that.

Worse, `pinTab()` ended with `setState({ pinnedTabId, halted: false })`. A halted
agent could therefore un-halt itself with one pin call. The kill switch was
documented as blocking "at the lowest level, not just at the router" — true for
`cdp.send()`, and irrelevant to `chrome.tabs.*`, which is not CDP and never
passes through it.

- `tools/tabs.js` — new `requireMultiMode(action)`, the second half of the
  boundary. `open`/`close`/`focus`/`pin`/`unpin` go through it; `list` stays
  free.
- `sw.js` — the halt check moved up to `handleBridgeMessage()`, so it covers
  every tool. `browser_status` is the one exception (`allowWhenHalted: true`):
  an agent that cannot ask why it is failing will guess instead.
- `tools/tabs.js` — `pinTab(tabId, { clearHalt })`. Only the panel's own
  `attachActive` / `attachTab` commands pass it. A stop is a user decision.

The general lesson, recorded in §4.5: a permission check that lives at one layer
only is a permission check with a way around it. The question to ask is not "is
this checked" but "where else can this capability be reached".

**2. The v1.0.5 race was still live in `observe.js` — in the busiest writer.**

`state.js` was serialized in v1.0.5. `pushConsole()` and `upsertRequest()` were
not, and they are read-modify-write against a single storage key driven by
`chrome.debugger.onEvent`, which delivers in bursts: one page load fires dozens
of `Network.*` events in the same tick. So the module with by far the highest
write rate was the one left unguarded.

A stub reproducing the same read-modify-write against 40 concurrent events kept
**1 of 40**. Real `chrome.storage` timing differs, so the live loss rate will be
lower — but the mechanism is identical, and the symptom is the worst kind: a
network log that looks complete and is not. An agent reading it concludes "this
page makes no such request" and reports a wrong finding confidently.

`serialize()` is now exported from `state.js` and shared. Verified by driving 40
concurrent network events, 30 console events, and 50 activity writes through the
real modules under a stubbed `chrome` API: all survive.

**3. Capture could die silently, and leaked.**

Three separate problems in the same area:

- `console:<tabId>` and `network:<tabId>` were never removed. Closing a tab left
  them in session storage until the browser shut down. Now cleared on tab close
  and on unpin, alongside the refs that were already being cleared there.
- Console text was truncated on read but not on write, so the untruncated text
  still had to fit in storage. A page logging large strings could reach the
  quota.
- On a quota rejection, `set()` rejected, and `sw.js` swallowed it with
  `.catch(() => {})`. Capture simply stopped, with no signal anywhere. Now the
  buffer drops to its newest quarter and **says so in the data the agent reads**,
  and the failure is reported to the extension console.

**4. `browser_status` handed over every tab title and URL in pinned mode.**

Up to 25 of them, regardless of mode. Titles and full URLs carry subject lines,
document names, order numbers, and search queries — most of what pinned mode is
protecting. Outside multi mode the list is now origins only, with a note saying
so, which still supports "you also have localhost:5173 open, want me to use it?"

**5. Versions had drifted.** `manifest.json`, `bridge/package.json`, and
`server.js` all still said `1.0.0` while this file said v1.0.6. All three now say
`1.0.7` and move together.

**6. An oversized WebSocket frame killed the bridge.** `decodeFrame()` throws
past the 64MB cap, and it throws inside a socket `data` handler, where an
uncaught exception takes the process with it. From the agent's side a bridge that
dies mid-session is indistinguishable from one that never started — the same
two-layers-away failure as v1.0.2. The decode loop now catches, emits
`protocolError`, and drops the connection with close code 1009. Self-test
section 11 sends a header claiming a 1TB payload (ten bytes, no body needed —
the length is read before the payload is awaited) and asserts the process is
still serving `/health`. **20 assertions → 22.**

**7. Smaller corrections.**

- `interact.js` built `code: 'Key' + name.toUpperCase()` for any key not in
  `KEY_MAP`. That is wrong for every digit (`Digit1`, not `Key1`), symbol, and
  function key — and `keyCode` came from `charCodeAt(0)`, which is meaningless
  for a multi-character name. Pages that filter numeric input read exactly
  `event.code` and `event.keyCode`, so this silently broke the inputs that most
  need real key events. New `keyDefinition()` handles letters, digits,
  punctuation, and F1-F12, and **omits** what it cannot know honestly — a
  fabricated keyCode is worse than none. Per-character typing now sends
  `code`/`keyCode` too, which it never did.
- `type({clear:true})` hardcoded Ctrl+A. Now Cmd+A on macOS, read from the
  worker's `navigator`.
- `capture.js` clamped width and height to 2000px, which **cropped**. A
  full-page screenshot is usually taken to find content running off the side of
  the page; cropping removed the evidence and said nothing. Now it scales, and
  reports the `scale` applied.
- `snapshot.js` listed `searchbox` twice in `INTERACTIVE` (harmless, it is a
  Set).
- `tools.js` header said "11 tools"; there are 12. `browser_navigate`'s
  `timeoutMs` schema advertised a 15000 default while `goto`/`reload` use 30000.
- README's repo-layout block omitted `livetest.mjs`; §3 here omitted
  `setup/mcp.example.json`. `.gitignore` did not cover `.vs/`.

`INSTRUCTIONS` and the affected tool descriptions now state the enforced
boundaries plainly, including that the agent cannot lift a stop itself. An agent
that knows a limit is deliberate reports it; one that thinks it hit a bug retries
around it.

**8. The install still has a manual step that fails silently** — found minutes
later, on the user's own machine, exactly the way v1.0.1 and v1.0.4 were found.

The side panel said "Bridge offline" after a client restart. That report was
correct: nothing was listening on 8765 and there was no `node` process at all.
The cause was that **no MCP config existed anywhere** — no `.mcp.json`, no
`.vscode/mcp.json`, and an empty `mcpServers` for this project in
`~/.claude.json`. `install.ps1` writes `setup/mcp.json` and then asks the user to
copy it into their client config by hand, and that step had not happened.

Added `.mcp.json` at the repo root (the location Claude Code actually reads for
project scope) and gitignored it beside `setup/mcp.json` — both carry an
absolute, per-machine path, so committing either just confuses the next machine.

The pattern is worth naming, because this is now the third time: **the failure
appeared one layer away from its cause and looked like a defect in the layer
that reported it.** The panel is not wrong when it says the bridge is offline,
any more than `ERR_CONNECTION_REFUSED` was wrong in v1.0.4. Before changing
anything that reports a problem, confirm the problem is not real. Here the first
useful command was `curl /health` plus a process check, not reading extension
code.

Left as a rough edge rather than fixed: `install.ps1` could write `.mcp.json`
directly instead of asking for a copy-paste. That is the real fix for the class,
but it writes into the user's project root, so it should be a deliberate choice
rather than a side effect. See §8.

### 2026-08-31 — v1.0.6, livetest ergonomics

Both changes come from the user asking "why does it say Bridge offline right
after your tests pass — is that normal?" It is normal, and that it needed
asking is the defect.

`livetest.mjs` spawns its own bridge (it has to: it speaks MCP over that
process's stdio and cannot attach to a bridge someone else started), then kills
it on exit so no stray process is left behind. The side panel therefore flips to
"Bridge offline" a second after a fully green run, which reads as though the
test broke something.

- The test now prints an explicit closing note saying the bridge it started has
  stopped, that the panel will say "Bridge offline", and that an MCP client
  keeps its own bridge up for the whole session.
- Added a port pre-flight. Previously, running livetest while another bridge
  held 8765 let the child die with EADDRINUSE and surfaced ~70s later as an
  opaque "initialize timed out". It now probes `/health` first and exits
  immediately with instructions for stopping the other bridge.

Latest live run: **20 passed, 0 failed, 2 skipped** — one better than v1.0.3,
because the page had accumulated real traffic by then and `request detail`
exercised `Network.getResponseBody` against a live request for the first time.

Still skipped, and still the one real gap: the six seeded defects in
`setup/testpage.html`, plus trusted-event login and obstruction detection. Every
live run so far has been against `time.ir`, which cannot exercise them.

### 2026-08-31 — v1.0.5, serialized state writes

Found while re-reading `state.js` during the v1.0.4 follow-up, not from a
reported symptom — but it is a genuine correctness bug, so it is recorded here.

`getState()` + `storage.session.set()` is a read-modify-write against a single
key, and there are ~24 call sites firing from independent async contexts: tool
calls, `chrome.debugger` events, connection state changes, and every
`logActivity()`. Two that interleave both read the same base state, and the
second write silently discards the first.

Observable consequences were: activity-log entries vanishing under concurrent
tool calls, and — more seriously — `pinnedTabId` or `attachedTabs` reverting to
an older value, which would let a later `resolveTarget()` refuse a tab that was
genuinely attached, or lose track of a debugger session.

`setState`, `logActivity`, and `clearActivity` now run through a single
`serialize()` promise chain, making every mutation atomic with respect to the
others. The chain survives a throwing mutation (`writeQueue = run.catch(...)`),
so one failure cannot wedge all later writes. Cost is negligible — these writes
are small and infrequent.

This is the kind of bug that would have surfaced later as rare, unreproducible
state corruption under a busy agent session. Worth fixing before that happened.

### 2026-08-31 — v1.0.4, two bugs from the user's own install

Both surfaced from screenshots of the Edge extensions page after a reload.

**1. The side panel forgot the bridge path.** `serverPath` arrives in the
`welcome` handshake and was written only to `chrome.storage.session`, which is
cleared on every extension reload and browser restart. So the panel reverted to
`REPLACE_WITH_ABSOLUTE_PATH` even though the bridge had connected successfully
minutes earlier. The repo does not move between sessions, so the path belongs in
`chrome.storage.local` alongside host/port/token. `state.js` now persists
`serverPath` and `repoRoot`, and both are declared in `DEFAULTS`.

**2. `ERR_CONNECTION_REFUSED` accumulating in the extension error console.**
The error itself is honest — it means no bridge is listening — and it cannot be
suppressed: the browser logs failed WebSocket handshakes below our JavaScript,
before any handler runs. So the only lever is *attempting less often*, and two
independent retry sources were competing:

- `transport.scheduleReconnect()` with a 15s backoff ceiling, and
- the `g9-heartbeat` alarm in `sw.js` firing every 30s and calling `connect()`
  regardless of whether a backoff was already pending.

Together they produced roughly four console entries a minute, indefinitely,
whenever the bridge was not running. Changes:

- Backoff ceiling raised from 15s to 60s (`[0.5, 1, 2, 5, 10, 20, 40, 60]`).
- `reconnectTimer` tracked, with `isReconnectPending()` exported. The alarm now
  stands down when a backoff is already queued — it exists only to revive a
  worker that was torn down mid-backoff, since the worker's timers die with it.
- `connectNow()` added for user-initiated retries: cancels the pending backoff,
  resets the attempt counter, connects immediately. Wired to the panel's
  Reconnect button, to Save-and-reconnect, and to the panel's first poll after
  it opens — when the user is looking at the problem, a 60s wait reads as broken.

Net effect: about one console entry a minute while idle, and an instant
connection the moment the user opens the panel or starts the bridge.

Worth stating plainly for future readers: **a red entry in the extension error
console does not mean the extension is broken.** When the bridge is not running
it is the correct, expected report. Do not "fix" it by swallowing the error.

### 2026-08-31 — v1.0.3, first live CDP run

`setup/livetest.mjs` added: a live counterpart to the self-test that acts as the MCP client itself, so real CDP can be exercised without configuring any agent. First run was against **Edge** on `https://www.time.ir/` — a heavy production Next.js site with RTL Persian content, which is a far better stress test than the synthetic test page.

**19 passed, 0 failed, 3 skipped.** Confirmed working against a real browser:

| Capability | Evidence |
|---|---|
| a11y snapshot + refs | 46-line tree, 30 interactive refs, Persian names intact |
| Computed styles | 941 non-default properties on `body` |
| Storage + cookies | localStorage, IndexedDB, CacheStorage, service workers, 2 cookies |
| Console capture | 3 entries, correct level counts |
| JS evaluation | returned title/url/form count |
| Screenshot | 95 KB JPEG as a proper MCP image block |
| Device emulation | iPhone viewport 393x852 applied and reset |
| Error quality | bogus ref rejected with the list of valid refs |
| Stability | zero disconnects |

`browser_diagnose` found four genuine accessibility defects on time.ir (unlabelled form controls including `provinceId` and `cityId`) — the health report works on real third-party code, not just the seeded test page.

**Gap found and fixed:** the run reported `networkRequests: 0`. Not a bug — `Network.enable` starts capture at attach time, and the tab had loaded long before. But an agent would have concluded "this page makes no requests", which is wrong and actionable in the worst way. Both the `INSTRUCTIONS` and the `browser_network` tool description now state that capture begins at attach and tell the agent to reload when it needs load-time traffic.

Also fixed: `livetest.mjs` was spreading its internal `__image` handle into every parsed result, so it appeared as a key in printed output (visible in the storage assertion). Now attached non-enumerably.

**Correction to the v1.0.2 diagnosis.** The connect/disconnect cycling seen in that session's log was caused by my own repeated bridge restarts, not by the MV3 idle timeout. A clean measurement showed the extension connected once and stayed up **1m44s with zero disconnects**, well past the 30s idle limit — the 20s keepalive ping works as designed.

**Still unverified:** the six deliberate defects in `setup/testpage.html`, because the attached tab was time.ir. Attach the test page and re-run `livetest.mjs` to close that gap.

### 2026-08-31 — v1.0.2, the bridge killed itself on startup

Reported as a WebSocket error in the extension console:

```
WebSocket connection to 'ws://127.0.0.1:8765/agent' failed: net::ERR_CONNECTION_REFUSED
```

That error was the extension behaving **correctly** — nothing was listening. The real bug was in the bridge: `mcp.js` had `process.stdin.on('end', () => process.exit(0))`. An MCP client holds stdin open for the session, so 'end' legitimately means "client went away". But run standalone — `node bridge/src/server.js`, or with output redirected — stdin has no writer, EOF arrives immediately, and the process exited a few milliseconds after binding the port.

Observed sequence:

```
[g9] bridge listening on ws://127.0.0.1:8765
[g9] waiting for the browser extension to connect…
[exited with code 0]
```

This made the exact command that README troubleshooting and the side panel hint both recommend for debugging silently impossible.

- `bridge/src/mcp.js` — `start()` now takes `{ standalone }` and tracks `sawTraffic`. On stdin 'end': exit only if MCP traffic was actually seen; otherwise announce STANDALONE mode and stay up. Debugging the extension without an MCP client now works, which is genuinely useful in its own right.
- `bridge/src/server.js` — passes `--standalone` through from argv.
- `setup/selftest.mjs` — section 10, three new assertions (now **20**): the bridge survives stdin EOF, announces standalone mode, and still serves `/health`. Spawned with `stdio: ['ignore', …]` to reproduce the exact condition.

**First live confirmation.** With the fix in place, the real extension connected:

```
[g9] extension connected (chrome-extension://nohpfobbcnbbeogifeahejmejlbihcgb)
[g9] extension v1.0.0 ready
{"ok":true,"extensionConnected":true}
```

Origin validation accepted a genuine extension origin — the security model works against a real browser, not just the test's synthetic origin.

Lesson: a process that binds a port and then exits looks identical, from the client side, to a process that never started. The error surfaced two layers away from its cause.

### 2026-08-31 — v1.0.1, first-connection path fix

Found on the user's first real install attempt: **the side panel's "copy guide" button emitted a literal `<path-to>` placeholder** (`panel.js` `buildSnippet`). It is the most convenient copy path in the whole UI, so it is what the user actually used — and Node failed with "Cannot find module", so the MCP server never started and no tools appeared.

Root cause: the extension cannot know where the repo lives on disk. Rather than document a manual edit, the bridge now reports its own location.

- `bridge/src/server.js` — derives `SERVER_PATH` from `import.meta.url` and replies to the extension's `hello` with a `welcome` message carrying `serverPath`, `repoRoot`, host, port, and version.
- `extension/lib/transport.js` — handles `welcome`, storing the path in bridge state.
- `extension/panel/panel.js` — `buildSnippet()` renders the real absolute path once the bridge has connected. Before first connection it says so explicitly and uses `REPLACE_WITH_ABSOLUTE_PATH`, which cannot be mistaken for something that works. The copy toast also warns when the path is still unresolved.
- `setup/mcp.json` — regenerated with the real absolute path.
- `setup/selftest.mjs` — two new assertions (now **17**): the bridge reports its own path, and that path is absolute. Regression guard.

Lesson worth keeping: a placeholder that *looks* like a path is worse than one that shouts. The failure surfaced at the point of highest user trust — the copy button — and cost a whole install cycle.

### 2026-08-31 — v1.0.0, initial build

Complete implementation in one pass.

- Researched and chose the extension + `debugger` architecture over WebDriver and external CDP (§2).
- Extension: manifest, service worker router, 4 lib modules, 9 tool modules, side panel, welcome page, generated icons.
- Bridge: zero-dependency MCP server, RFC 6455 WebSocket server, 12 tool schemas, agent instructions.
- Setup: `install.ps1`, 15-assertion self-test, static server, test page with 6 deliberate defects.
- Self-test: 15/15 passing. All 20 JS modules parse clean.

Bugs found and fixed during review, before any live run:

1. **Token model was incoherent** — the extension generated a random token the bridge could never know. Replaced with Origin validation, which is both stronger and frictionless.
2. **`slice(-0)` returns the whole array** — `browser_status` calls `consoleLog({ limit: 0 })` for counts only and would have dumped the entire buffer into every status response. Now special-cased.
3. **Double `pushNodesByBackendIdsToFrontend`** in `inspect.styles()` — called twice in a `Promise.all`, wasteful and able to return different nodeIds for the same node. Resolved once.
4. **Dynamic `import()` inside a hot path** in `sw.js` — hoisted to a static import.
5. **`chrome.*` used directly** in `transport.js` instead of the `api` alias, breaking the cross-browser wrapper convention.
6. Self-test had two false failures from handler-registration order; replaced with a single dispatcher plus a responder map.

---

## Rules for changing this codebase

**A change that is not recorded here did not happen.**

When you change anything:

1. Make the change.
2. Add a **Change log** entry above — date, what changed, why. Include bugs found and fixed; that history is more valuable than the diff.
3. Update the affected section of this file (architecture, component reference, gaps). When a signature or a message changes, update [docs/ARCHITECTURE_V2.md](docs/ARCHITECTURE_V2.md) or [docs/DAEMON_PROTOCOL.md](docs/DAEMON_PROTOCOL.md) in the same change.
4. The version is one string, in `package.json`, mirrored in `extension/manifest.json` and `desktop/package.json` (and `desktop/package-lock.json`); `setup/unit/version.test.mjs` fails when they disagree. Bump it on every change — that is how the owner knows a reload took effect. No test pins a literal number: they all compare the files with each other and with `lib/version.mjs`, so a bump is four JSON edits and nothing else (the lock file is compared too, since `npm ci` in desktop/ installs from it).
5. Adding a tool means **four** edits: `extension/tools/index.js` (`TOOLS`), `mcp/tools.js` (schema; and `daemon/router.js` if the daemon answers it itself), the README table, and §4.4/§6 here. Prefer a new action on an existing tool.
6. Run what the change needs (§7.0): `npm run check` runs the offline checks the changed files reach and names the live suites the change calls for. Run those live suites (`--live`) when it names them for input, perception, launching or the seam, and before a release; `npm run check:all` before handing over a change that touched several areas; the installer build (`cd desktop && npm run build:win && npm run test:packaged`) only for a change in `desktop/` or a build the owner will install. A new module a check cannot reach makes `check.test.mjs` fail: add it to that check's `reads` or to NO_CHECK in `setup/check-plan.mjs`. The self-test asserts the tool count, so it fails until everything is updated. Update the assertion last, deliberately — not reflexively. Before a step that takes more than a minute, say what it is and how long it should take.
7. Test safely: a temp `G9_HOME`, temp profiles, random ports in 18000–18999, never port 8765, never a person's browser profile, registry or MCP client config, no on-screen windows, and kill only processes the test started.
8. If you remove a deliberate omission from §8, say so and explain what changed.

**Do not simplify past the constraints in §4** without recording why. Each one exists because the obvious approach fails in a specific, non-obvious way.
