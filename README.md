# G9 Browser Agent

G9 lets AI agents, and suites that run on a schedule, drive real Chrome and Edge browsers for QA
work. They can inspect a page the way DevTools does, act on it with trusted input that moves like a
person's, record flows, and replay those flows as regression tests that remember what normal looks
like. Everything runs on the local machine.

**Version 3.0.1**: the extension's new icon, and `npm run check`, which runs only the tests a change
needs, several at a time, and says what it is running ([Tests](#choosing-what-to-run)). This README was written on 2026-09-23 against the code in this repository and
the v2 live rounds. It was revised on 2026-09-24 for 2.0.2, which fixed three defects that flaky
tests uncovered (the replay quiet window, the evidence prune race, and watch ordering on a launched
engine) and gave a closing browser 30 s instead of 10 s, and on 2026-09-25 for 2.0.3, which fixed
the side panel's **Pop out tab**: the new window used to open behind the person's own window, where
Windows stops rendering it. It was revised again on 2026-09-25 for **3.0.0**, the side-panel
redesign (decisions U1–U10, [AIGuide.md](AIGuide.md) §6.10): agents are shown per project, Auto-attach follows the
project's sites by default, a blocked agent raises an alert with **Pop out** on it, Automation and
Issues are grouped by site, and the panel has one visual system (see
[The side panel (v3)](#the-side-panel-v3)). Those rounds ran on Windows 11 Pro 10.0.26200 with
Edge 153.0.4234.32, Chrome 153.0.8010.53, Chrome for Testing 153.0.8010.52 and Node 22.15.0.

On the 3.0.1 tree (2026-09-25), `npm run check:all` ran every offline check (unit 651 tests in 12
suites, self-test, extension suite, panel render, links) three times: 16 of 16 each time, in 142 s.
The live suites and the installer were not rebuilt for 3.0.1 (icons, test tooling and docs only).

Latest recorded results. Run on the 3.0.0 tree on 2026-09-25:

- unit: 638 tests in 11 suites
- self-test: 136/136
- extension suite: 82/82
- desktop: 14 test files and the packaged build at 7/7
- Engine 2 live test: 366 passed, 0 failed (327 s)
- isolated Engine 1 live test on Edge: 198 passed, 0 failed, the real popout included
- panel render check (`setup/panel-render.mjs`): every tab at 360 and 1000 px wide, light and dark,
  no fixture text turned into markup, no `[object Object]` or `NaN` shown

On 2.0.2 (2026-09-24) the unit suite also passed three times in a row.

Run on the 2.0.1 tree on 2026-09-23 and not repeated for 2.0.2, whose changes are correctness fixes
in replay, evidence pruning, launched-engine watch ordering and browser shutdown:

- the daemon contract at 15/15 and the render check over four scenarios with no window ever on
  screen or in the foreground
- isolated Engine 1 live test on Chrome: 196 passed, 0 failed
- background-state matrix: exit 0, every cell agrees with the page
- bench 1/4/8/16 contexts and a 10-minute endurance run: 0 failures
- stealth matrix, 7 configurations including the public detector pages: 0 G9 leaks at stealth,
  headed Edge undetected on the local page, both human controls detected

The installer is not code-signed. `npm run build:win` in `desktop/` writes it as
`desktop/dist/G9-Setup-<version>.exe`; the last one built and tested is `G9-Setup-3.0.0.exe`
(2026-09-25). For what does not work yet, see [Limits and known gaps](#limits-and-known-gaps).

- [What G9 is](#what-g9-is)
- [Requirements](#requirements)
- [Install](#install)
- [First use](#first-use)
- [The 15 tools](#the-15-tools)
- [Sharing: ownership, queues and Stop](#sharing-ownership-queues-and-stop)
- [Human input](#human-input)
- [Recording, replay and the known world](#recording-replay-and-the-known-world)
- [Evidence: screencast frames and the pointer track](#evidence-screencast-frames-and-the-pointer-track)
- [Unattended runs: the runner and the scheduler](#unattended-runs-the-runner-and-the-scheduler)
- [The desktop app](#the-desktop-app)
- [Configuration](#configuration)
- [Security and trust model](#security-and-trust-model)
- [What works in which state (measured)](#what-works-in-which-state-measured)
- [Measured performance](#measured-performance)
- [Stealth: what was measured](#stealth-what-was-measured)
- [Limits and known gaps](#limits-and-known-gaps)
- [Troubleshooting](#troubleshooting)
- [Tests](#tests)
- [Repo layout](#repo-layout)
- [Changing this codebase](#changing-this-codebase)

---

## What G9 is

```
AI agent ──MCP (stdio)──▶ mcp/shim.mjs ─┐
AI agent ──MCP (stdio)──▶ mcp/shim.mjs ─┤
runner/g9.mjs ──────────▶ mcp/shim.mjs ─┼──WebSocket──▶ g9d (daemon) ──▶ Engine 2: Edge / Chrome / Chrome for Testing
desktop app (Electron) ─────────────────┤ 127.0.0.1:8765     │           launched by G9, CDP over a pipe,
                                        │                    │           headless by default
extension in your browser (Engine 1) ───┘                    └──▶ Engine 1: relayed to the extension,
                                                                   chrome.debugger in your own browser
```

### Two engines, one flow

| | Engine 1: the extension | Engine 2: launched browsers |
|---|---|---|
| Runs in | Your own Edge or Chrome, with your profile, cookies and logins. | A stock Edge, Chrome or Chrome for Testing process that the daemon starts. It uses its own profile under `G9_HOME\profiles`. |
| Use it for | Exploring, authoring, recording and debugging, with a person present. | Unattended and scheduled runs, several agents in parallel, long flows, and anything that must keep going while the person minimizes, switches tabs or works elsewhere. |
| Window | The person's own window. | None: `--headless=new` is the default. Headed on request. |
| Input to a tab that is not showing | Refused before anything is sent, with `[delivery: not-delivered; tab hidden]`. A browser does not deliver pointer input to a hidden tab ([measured](#what-works-in-which-state-measured)). | Headless has no window, so the case does not arise. |
| Setup | Load the extension once (the [one manual step](#the-one-manual-step-load-the-extension)). | An installed Edge or Chrome, or the pinned Chrome for Testing. |

Both engines run the same tool modules (`extension/tools/*`). The daemon runs them in-process for
Engine 2, through `extension/lib/platform-cdp.js`. Recordings, FlowSpecs and results are the same
on both. To keep a tab's work going while the person does something else:

- `browser_tabs action:"handoff"` moves it to Engine 2. Cookies and local/session storage travel,
  and the page reloads in a launched browser.
- `browser_tabs action:"popout"` keeps it in Engine 1 and moves it into its own window, without
  reloading.

### One daemon, many agents

`g9d` listens on `127.0.0.1:8765` and owns every engine, browser context and tab. You do not start
it: the first MCP shim that finds no daemon starts it, detached and hidden. It exits after 60 minutes
with no client, no launched browser and no enabled schedule. Any number of agents, the runner and
the desktop app share it.

Tab handles are daemon-wide numbers, the same for both engines. Each tab has one owner at a time,
and state-changing calls on a tab run one after another. The v1 limits of one bridge per browser,
bridge port hunting and the runner's "port rule" are gone.

### Human input, stealth and the cursor

- **Human input.** By default, pointer paths, clicks, wheel notches and typing are planned the way a
  hand produces them. The random generator is seeded, so a seed replays the same motion. See
  [Human input](#human-input) and [docs/HUMANIZE.md](docs/HUMANIZE.md).
- **Cursor in the evidence, never in the page.** The pointer position is stored as a timestamped
  track beside the screencast frames. The desktop's Watch view, run replays and issue videos draw
  the cursor from it. Nothing is drawn into the DOM, so the page cannot see it.
- **Stealth levels.** Each launched engine or context has a level: `off`, `human` or `stealth`.
  `stealth` never enables the page's JavaScript runtime domain and keeps G9's own scripts out of the
  page's main world. The environment half — `navigator.webdriver` false, and Widevine still in
  place on Edge and Chrome — belongs to the **engine's launch**: only
  `browser_engine action:"launch" stealth:"stealth"` adds the switch that clears it. A stealth
  *context* inside an engine launched below stealth gets the Runtime and input rules and says, in
  its own result, that `navigator.webdriver` is still true there. See
  [Stealth: what was measured](#stealth-what-was-measured) and [docs/STEALTH.md](docs/STEALTH.md).

### Why it is built this way

- **Hidden windows.** Chromium stops rendering a window that is minimized, covered (occluded) or on
  a hidden tab, and pointer input sent to it over CDP does not arrive. The v2 matrix measured this
  for background tabs, minimized windows and occluded windows ([table](#what-works-in-which-state-measured)).
  So an extension in a person's browser cannot run unattended. Engine 2 exists for that.
- **Stock browsers.** Engine 2 is a stock browser (decision D1: no Chromium fork), and Electron
  is only the desktop shell (D4). A result on Engine 2 is therefore a result on the browser your
  users run.
- **Your own profile stays yours.** Chrome 136+ ignores remote debugging on the default profile, and
  App-Bound Encryption stops another process from reading a person's cookies. Engine 2 therefore
  never uses a person's profile: `launchBrowser` refuses the default user-data folders. Handoff
  copies cookies instead.

The design, its twelve decisions (D1–D12) and the verified facts they rest on are in
[AIGuide.md](AIGuide.md) §2.
The binding module contracts are in [docs/ARCHITECTURE_V2.md](docs/ARCHITECTURE_V2.md), and the wire
protocol in [docs/DAEMON_PROTOCOL.md](docs/DAEMON_PROTOCOL.md).

---

## Requirements

- **Windows.** v2.0 was built and measured on Windows 11 Pro only. The macOS and Linux code paths
  in `engine/` exist but are untested.
- **Engine 1:** Edge or Chrome 125 or newer (the manifest's `minimum_chrome_version`).
- **Engine 2:** an installed Edge or Chrome, or Chrome for Testing. The pinned version is
  153.0.8010.52, about 205 MB, and its sha256 is checked against `engine/versions.json` before
  install.
- **Repository path:** Node.js 22 or newer. The core (`extension/`, `engine/`, `daemon/`, `mcp/`,
  `lib/`, `runner/`) has no npm dependencies. Only `desktop/` has any: Electron, electron-builder
  and electron-updater.
- **Installer path:** nothing else is needed. `G9.exe` carries its own runtime, so a QA machine
  needs no Node, git or npm.

---

## Install

The operator guide, [docs/INSTALL.md](docs/INSTALL.md), covers the rest: what goes where, the
background policies, MCP registration, unattended machines, update hosting and uninstall. This
section is the short version.

### A. Desktop installer (QA machines)

1. Run `G9-Setup-<version>.exe` (`G9-Setup-3.0.0.exe` for this release). It is built by
   `npm run build:win` in `desktop/` and written to `desktop/dist/`.
   - It installs per user into `%LOCALAPPDATA%\Programs\G9` and needs no administrator rights.
   - It is not code-signed, so SmartScreen warns on first run ([Troubleshooting](#troubleshooting)).
2. The first-run wizard (full detail in [desktop/README.md](desktop/README.md)):
   - lists the Edge and Chrome it found, and can install the pinned Chrome for Testing;
   - offers to open the `automation` profile headed, so you can sign in to your sites once;
   - optionally writes per-user background policies (`HKCU` only, recorded first, with Undo). This
     may need one administrator approval.
   - registers the MCP shim, as `g9-browser`, with Claude Code, Cursor, VS Code and Claude Desktop.
     Each config file is backed up before it is written.
   - copies the extension to `%LOCALAPPDATA%\G9\extension`, puts that path on the clipboard, and
     opens the browser's extensions page.
3. Do [the one manual step](#the-one-manual-step-load-the-extension).
4. Restart your AI client.

How the installer was checked:

- Its payload was compared file for file with the repository.
- The unpacked build (`desktop/dist/win-unpacked`) passed the packaged tests with no Node on PATH.
  In those tests the packaged shim started the packaged daemon, and a full `runner run` passed on
  headless Edge.
- The installer itself was not run on the build machine.

### B. From the repository (developers)

```powershell
git clone <this-repo> g9-browser-agent
cd g9-browser-agent
.\setup\install.ps1                      # Node 22+, then unit + self-test + extension suite, then writes setup\mcp.json
.\setup\install.ps1 -WriteProjectConfig  # also writes .mcp.json at the repo root (Claude Code reads it)
.\setup\install.ps1 -Port 9000 -SkipTests
```

Copy `setup\mcp.json` into your MCP client's config:

| Client | Location |
|---|---|
| Claude Code | `.mcp.json` in the project, or `claude mcp add` |
| Cursor | `.cursor/mcp.json` |
| VS Code | `.vscode/mcp.json` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` |

The entry it writes:

```json
{ "mcpServers": { "g9-browser": {
    "command": "node",
    "args": ["C:/path/to/g9-browser-agent/mcp/shim.mjs"],
    "env": { "G9_HOST": "127.0.0.1", "G9_PORT": "8765" } } } }
```

There is no service to install or start. To watch the daemon's log live, run it yourself with
`npm run daemon` (`node daemon/g9d.mjs --foreground`, which never exits on idle).

### The one manual step: load the extension

This step is needed for Engine 1 only. Agents can use Engine 2 without it.

1. Open `edge://extensions` or `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the folder:
   - installer: `%LOCALAPPDATA%\G9\extension` (the wizard put this path on the clipboard);
   - repository: `<repo>\extension`.
5. Leave the folder where it is. The browser identifies an unpacked extension by its folder.

On first install, a welcome page opens once. The side panel's title then reads
`G9 Browser Agent v3.0.1`, and its badge `v3.0.1`.

A browser can skip this step only when the extension is installed by enterprise policy
(`ExtensionInstallForcelist`). G9 does not set that policy up.

### Upgrading from v1

- **Old MCP configs keep working.** A config that points at `bridge/src/server.js` still works:
  that file now only starts `mcp/shim.mjs`, and prints a note on stderr. Point new configs at
  `mcp/shim.mjs`.
- **A v1 bridge on port 8765 blocks the v2 daemon.** The shim's error names the bridge's pid. Close
  the editor or MCP client that started the bridge, then restart your AI client. To keep v1 running
  alongside, give v2 another port instead: set `G9_PORT` in the MCP entry (the shim starts the
  daemon on that port), and enter the same port in the side panel's daemon address.
- **Reload the extension so it is v2.** The daemon refuses a v1 extension (close code 4001, "reload
  the v2 extension"). The v2 extension recognises a v1 bridge by its `/health` answer and does not
  connect to it, which leaves that bridge's session alone.
- **Removed in v2** (decisions D5–D7):
  - the four control modes (Workspace, Pinned, Follow, Multi) and the `workspaceDomains` allowlist;
  - title/URL withholding and cookie scoping;
  - `G9_TOKEN`;
  - the 8765–8775 port range and "find bridges";
  - the runner's port rule.

### Upgrading from 2.x to 3.0

- **Reload the extension and restart the daemon.** 3.0 changed both. Reload the extension on the
  browser's extensions page (or **Update and reload** in the desktop app's Engines page). A 2.x
  daemon keeps running until it has been idle for `idleExitMinutes` (60 by default); to switch at
  once, use **Shut down daemon** then **Reconnect** in the desktop app's Settings, or close your AI
  clients and end the `g9d` node process, then restart your AI client. The panel's Session tab warns
  while the daemon and the extension report different versions.
- **Mixed versions still connect.** The daemon refuses only extensions older than 2.0, so a 3.0
  extension works with a 2.x daemon and the other way round. What a 2.x daemon cannot do is send the
  project sites: while it runs, **Project sites** behaves as Off, and the panel says the
  daemon is too old.
- **Your Auto-attach choice is kept.** 2.x stored it as on or off. On becomes **All tabs** and off
  becomes **Off**, and the activity log says so once. Only an install that never saved its settings
  starts with the new default, **Project sites**.
- **Stored flows and issues need nothing done to them.** The issue index gains site, severity, tags
  and evidence counts. The first time the list is read, entries written by 2.x are completed from
  their issue records and attachment metadata in one pass, and later reads find nothing left to do.

---

## First use

**In your own browser (Engine 1):**

1. Open the page to test.
2. Click the G9 toolbar icon. The side panel opens.
3. Nothing to attach: an agent takes the tab you are on at its first call and stays on it, even if you
   switch tabs afterwards. Press **Record from now** only when you want console and network captured
   before the agent starts; tick **reload to capture page load** to catch errors during the load.
4. Talk to your agent normally. For example:
   - *"check this page for problems"*
   - *"log in as admin and confirm the orders list loads"*
   - *"why does Save do nothing?"*

The panel shows **Daemon offline** until the daemon runs. An agent's first call starts the daemon,
and the extension reconnects by itself, with backoff. **Reconnect now** retries immediately.

**Without the extension (Engine 2):** ask the agent to open a URL. When no extension is connected,
`browser_tabs action:"open"` launches the default engine headless. That is Chrome for Testing if it
is installed, otherwise Edge, otherwise Chrome.

**A page to try it on:**

```powershell
node setup/serve.mjs      # http://127.0.0.1:5199/
```

The test page has deliberate defects to find:

- console errors and an uncaught exception
- a 404 request and a broken image
- an unlabelled password input
- 2400 px of horizontal overflow
- a duplicate `id`
- a transparent overlay over a button

It also has a working login (`admin` / `g9secret`).

Agents are told to call `browser_status` first. It reports:

- the caller's current tab and its health;
- every engine and every connected agent;
- what the caller owns;
- whether Stop is pressed.

### The side panel (v3)

- **Session** — the daemon link; each connected agent with its project folder and the tab it is on
  (click the tab to bring it to the front); the current tab with its origin and whether console and
  network are being recorded; **Auto-attach** as *Off*, *Project sites* (the default on a new install: tabs on the
  sites of connected agents' `g9.project.json` environments are captured from their first load) or
  *All tabs*; **Keep working elsewhere** (Pop out, Send to background); the input level; Stop.
- When an agent's input is refused because its tab is hidden, an alert above the tabs names the agent
  and the tab and offers **Pop out** or **Send to background** on the spot.
- **Automation** — flows grouped by site (the origin of the flow's start URL), then suite. A header
  says how many flows exist for the site you are on. Filter by site, suite, tag, last verdict, flaky
  or text. **Run N flows in** *scope* runs only what the filter shows (`@manual` flows are skipped).
  Each flow opens into a drawer with replay, dry run, the assertion wizard, calibrate, approve,
  history, push, Playwright export, delete, and its section, suite, tags, covered test cases and
  start URL.
- **Issues** — grouped by site, then Open, Filed and Closed; each row shows severity, age, the tracker
  key and chips for the evidence it holds (screenshots, video, files, console, network, DOM). Filter
  by site, status, severity, tag or text.
- Auto-attach *All tabs* is not the default on purpose: it captures every site you browse into one
  10 MB buffer, turns on the debugger domain every site can detect, and keeps all tabs out of Memory
  Saver.

---

## The 15 tools

| Tool | What it does |
|---|---|
| `browser_status` | Orientation: current tab, page health, engines, agents, ownership, halts, capabilities. The daemon answers it, and it still answers while Stop is pressed. |
| `browser_engine` | **New in v2.** Launched browsers: `launch`, `list`, `stop`, `context`, `versions`, `warm`, `acquire`, `release`. |
| `browser_tabs` | Tabs across all engines: `list`, `open`, `close`, `focus`, `attach`, `claim`, `release`, `popout`, `handoff`, `session`, `sessions`, `end_session`, `wait`. |
| `browser_snapshot` | Accessibility tree with a `[ref=eN]` handle on every interactive element. This is the **primary perception** tool. |
| `browser_interact` | `click`, `double_click`, `right_click`, `hover`, `type`, `key`, `scroll`, `drag`, `select`, `upload`. Trusted input, humanized by default; every result reports `delivery`. |
| `browser_navigate` | `goto`, `reload`, `back`, `forward`, and `wait` for text, a selector, its disappearance, or idle. |
| `browser_inspect` | `dom`, `styles`, `box`, `storage`, `cookies` (any site in that browser, HttpOnly included), `frames` (cross-origin frames included). |
| `browser_console` | Read buffered console output, or `evaluate` in the page's **main** world (the page can see what you run). |
| `browser_network` | Requests and bodies, HAR 1.2, `record_har` / `pin` (HAR pinning), `intercept` rules (fail, stall or replace chosen requests), and downloads (`watch_downloads`, `wait_download`, `downloads`, `stop_downloads`). |
| `browser_diagnose` | `health` (correlated defects), `performance` trace, Core Web `vitals` and long tasks, `memory` leak signals. |
| `browser_screenshot` | `viewport` (a read), `fullpage` or `element` (actions: they resize the viewport or scroll the element into view, so they claim the tab and are queued). Oversized full-page captures are scaled to fit, never cropped; at the human and stealth levels an element taller or wider than the viewport is captured as far as it shows on screen and the result's `cropped` gives its full size (take several viewport shots for all of it). |
| `browser_emulate` | Device, viewport, network throttle, CPU throttle, colour scheme, locale, timezone. |
| `browser_dialog` | Accept or dismiss `alert`, `confirm`, `prompt` or `beforeunload`. |
| `browser_recording` | Recorded flows: record and replay, assertions, the suggestion wizard, calibration, the known world and approvals, FlowSpec export/import, Playwright export, `calibrate_humanize`. |
| `browser_issue` | Defects captured with screenshot, tab video with pointer track, console, failed requests and page context attached. |

There are fifteen grouped tools rather than dozens, because tool definitions are re-sent on every
request. Every tool that acts on a tab takes:

- `tabId`: a G9 handle from `browser_tabs action:"list"`, the same for every engine; or
- `session`: a name you gave a tab.

Without either, the call acts on the caller's **current tab**.

### `browser_engine`

- **`launch`** starts an engine. Options: `browser` (`auto`, `edge`, `chrome`, `cft`), `headless`,
  `profile` (default `automation`), `stealth`, `humanize`, `proxy`, `locale`, `timezone`,
  `windowSize` and `name`. A profile can be open in one browser at a time, so a second `launch` of
  a profile that is already running is refused, naming the engine that has it: use that engine,
  stop it, or launch another profile. The daemon's own on-demand launches (`open`, handoff, replay
  `engine:"launched"`) reuse the running default engine instead. `lease:true` holds the engine for
  your session.
- **`context`** creates an isolated browser context inside an engine: its own cookies, with an
  optional proxy, locale, timezone, humanize or stealth level, and download folder. Use a context
  per simulated user.
- **`stop`** closes a launched engine. It refuses the extension, because G9 never closes a person's
  browser. It also refuses an engine where another connected agent owns a tab, or that another
  client holds with `acquire` (a runner between two flows owns no tab), unless `force:true`, which
  is logged. A stop waits up to 30 s for the browser to close cleanly before it kills it.
- **`acquire`** / **`release`** hold a launched engine across tabs, and let go of it. A disconnect
  releases the hold.
- **`versions`** lists the installed browsers and the pinned Chrome for Testing. `download:true`
  fetches and verifies it.
- **`warm`** opens a profile **headed** so a person can sign in to the sites once. Later runs start
  signed in.

You rarely call `launch` directly: `browser_tabs action:"open"` starts the default engine on demand.

### `browser_tabs`

| Action | Behaviour |
|---|---|
| `list` | Every tab of every engine, with full title and URL. Each row carries `engine`, `owner`, `session`, `current` and `attachable`. Tabs of a reconnecting extension show `reconnecting:true`. |
| `open` | `{url, engine?, context?, name?, focus?}`. The default engine is the extension when it is connected, otherwise a launched browser, started headless if none runs. The new tab is claimed by the caller and becomes its current tab. **In the person's browser it opens in the BACKGROUND** (`focus:false` by default): it can be read — snapshot, console, network, viewport screenshot — but not clicked or typed into, because a browser delivers input only to the tab it shows. Pass `focus:true`, or `action:"focus"` first. A launched engine gives every tab its own window, so nothing is needed there. |
| `attach` | Takes the tab the person is on in the extension (or `tabId`), claims it and makes it current. |
| `claim` / `release` | Ownership. `claim force:true` takes a tab from another agent, only when the user asks; it is logged. `release` without `tabId` releases every tab the caller holds. |
| `focus` | Brings the tab to the front and focuses its window. On Engine 1 this takes the screen from the person. |
| `close` | Closes a tab. It needs an explicit `tabId` or `session`. |
| `popout` | **Engine 1 only.** `{tabId?, focus?, width?, height?, left?, top?}`. Moves the tab into its own window without reloading it (same renderer). An agent's popout opens that window **unfocused**, so the person keeps the keyboard, and gives focus back to the person's window only if the browser moved it; `focus:true` brings the new window to the front. The side panel's **⧉ Pop out tab** always opens it in front, focused. Without explicit geometry the window is half the source window's width and three quarters of its height (clamped to 640–1280 × 480–1000), at the source window's top-right. The result carries `focused`, and `visible`: what the page's `document.visibilityState` says about 600 ms after the move. Do not minimize that window, and do not let another window cover it completely: on Windows a completely covered window also stops rendering, unless the `WindowOcclusionEnabled` policy is off ([docs/INSTALL.md](docs/INSTALL.md#background-policies-hkcu)). When `visible` is false, `focus` it. |
| `handoff` | **Engine 1 → Engine 2.** Carries cookies (HttpOnly included) and the origin's localStorage and sessionStorage into a fresh launched context. The page **reloads** there. In-memory page state, IndexedDB and service-worker state do not travel. `storageCheck` and `warnings` say what actually arrived, for example a sign-in redirect. The new tab is claimed and becomes current; the caller's claim on the source tab is released; the user agent is never overridden. |
| `session`, `sessions`, `end_session` | Names for tabs, stored in the daemon. `end_session` forgets the name; the tab stays open. |
| `wait` | Waits for a popup or new tab by `url`, `title` or `openerTabId`. |

Measured on Edge, headless:

- **Popout:** the page's `timeOrigin` and JavaScript state were unchanged afterwards, and a click in
  the new window was delivered.
- **Handoff:** took 1.8–3.0 s. Two cookies (HttpOnly included) and a localStorage item arrived and
  were seen by the page.

In Engine 1, sessions are **names for tabs, not separate users**: same-origin tabs in one profile
share cookies and storage. For separate users on Engine 2, use a `browser_engine` context per user.
In the Engine 2 live test, 4 contexts each saw only their own cookie.

### Delivery: a dispatched action is not a delivered action

Before it dispatches anything, every input action arms a listener that counts only trusted events,
in G9's isolated world. The verdict is timed from the end of dispatch.

A successful result carries one of:

- `delivery: "delivered"`
- `delivery: "indeterminate"`, with a `deliveryNote`

Anything else is an **error**. The error text starts with a tag, because MCP clients show agents
only the text:

```
[delivery: not-delivered; tab hidden] The click was not sent: the attached tab is HIDDEN …
[delivery: missed; hit <div#veil>] The click reached the page, but not "Save" … The click was NOT repeated …
[delivery: partial; 3 of 12 input events sent; tab hidden] …
```

- **`missed`**: the input reached the page but hit a different element, and the error names it.
- **`partial`**: the tab became hidden part-way. For a scroll, the error gives how far the page
  actually scrolled.

The daemon protocol also carries `delivery`, `hit` and `hidden` as fields, for programs. Agents are
told to treat anything but `delivered` as unproven, and never to blindly repeat a state-changing
action.

Measured in the Engine 2 live test and the Engine 1 live test:

- **Cancelled pointerdown.** On a page that cancels `pointerdown`, the click is still reported
  delivered, at every level.
- **A button that moves away from the pointer.** At human and stealth, 16 of 16 runs reported
  `missed` and named the element hit. The page saw exactly one press, on that element, and the
  click was not repeated.

### `humanize` and `seed`

- **`humanize`** is `off`, `human`, `stealth` or the name of a calibrated profile. It is accepted by
  `browser_interact`, `browser_screenshot`, `browser_recording` replay, and `browser_engine` launch
  and context.
- **The default** is the tab's engine or context setting. For launched engines that is
  `settings.humanize`, which is `human`. For the extension it is the side panel's **Input** choice,
  which defaults to Human.
- **Stricter, never looser.** A tab's stealth level is a floor.
  - In a launched context, the context's `stealth` level is the floor.
  - In the extension, only the panel's **Stealth** choice is a floor. With the panel at Human, an
    agent may still ask for `off`.
  - When the level was raised, the result's `humanize.raisedFrom` says so.
- **`seed`** reproduces the exact pointer paths and typing rhythm **from the same pointer position
  and viewport**: every path starts where the last action left the pointer on that tab. A replay
  therefore homes the pointer to a point fixed by the run seed before step 1 and reports it as
  `pointerStart`, so replaying with the reported `humanizeSeed` does reproduce the run. Every result
  reports the seed it used, and so does the runner's report.

### Element refs

`browser_snapshot` returns a tree like:

```
- button "Sign in" [ref=e7]
- textbox "Username" [ref=e5] (value="admin")
- link "Forgot password?" [ref=e9] (url=/reset)
```

The agent passes `ref: "e7"` to `browser_interact`. A ref belongs to the **tab**, not to the agent
that took the snapshot — but it keeps naming the element **that** snapshot showed: numbering
continues across snapshots of a page (`e1…e30`, then `e31…`), and the last four snapshots **each
caller** took of the page stay resolvable (up to 16 per page in all), so another agent's snapshots
neither renumber nor evict yours (EXT-03). A ref from an older snapshot of your own, from another
page (numbering and history start over when the URL changes), or for
an element the page has since removed produces an error naming the fix.

Take a fresh snapshot after navigation or a large DOM change anyway: a page that re-renders replaces
the elements you saw, and the old refs are then refused rather than resolved elsewhere. When a page
re-renders an element while a humanized click is on its way, the press lands on the identical
replacement: that is reported as `indeterminate` (not `delivered`, not `missed`) and is never
repeated automatically.

---

## Sharing: ownership, queues and Stop

- **Ownership.** The first state-changing call on an unowned tab claims it. A state-changing call on
  a tab that another agent owns fails with that agent's name, for example
  `Tab 7 is owned by agent-2 (cursor)`. Reads are always allowed: snapshot, inspect, console or
  network reads, and `browser_screenshot area:"viewport"`. An element or full-page screenshot is
  **not** a read — it scrolls the page to the element (with the wheel at the human levels) or
  resizes the viewport — so it claims the tab and is queued like any action. An agent's claims are
  released when it disconnects.
- **Queues.** State-changing calls on one tab run strictly one at a time, in arrival order, so two
  agents never interleave input. Reads are not queued. Ownership, the halt and the caller still
  being connected are checked again at the moment a queued call's turn comes, so a call queued
  behind a long one never runs on a tab that has since changed hands (or for an agent that has left).
- **A call that hits its deadline** is cancelled (its input stops between steps, as Stop does) and
  the tab's queue is held until it has stopped, up to 5 s more. If it has not stopped by then the
  error says so — it may still be running — and the next call on that tab can overlap it. Take a
  snapshot before sending that tab more input when you see that message.
- **`maxParallel`.** This setting (default 8) caps how many state-changing Engine 2 calls run at
  once across all tabs. Reads and waits (`navigate wait`, `wait_download`, `tabs wait`) hold no
  slot. In the Engine 2 live test, a click during another agent's 6 s wait took 26–63 ms.
- **Stop.** Stop can be global (the side panel's **Stop**, or the desktop's **Stop all**) or per
  agent (desktop, Agents view). While it is on, every tool except `browser_status` fails with the
  reason. **Only the person can resume.** Agents cannot, because admin operations are refused to
  them. A call waiting in a tab's queue is checked again when its turn comes. The global Stop is
  mirrored into launched engines, so running Engine 2 work stops at its next CDP command.

What Stop did when measured:

- **Engine 2:** Stop pressed during typing left 5–6 of 59 characters in the field.
- **Engine 1:** a panel Stop during a 176-character humanized typing action ended the call 37–94 ms
  later. The panel title then read `Stopped · G9 Browser Agent v2.0.0` (the version of the run; it is the current version at any time).

Stop does not undo input that already arrived. A per-agent halt cancels that agent's calls that are
already running, on both engines, the way a call that reaches its deadline is cancelled: the input
stops between steps.

The side panel and the desktop's Agents view show the activity log: each agent call, and the
person's own panel actions. The panel's **↗** opens it in a separate window.

---

## Human input

A pure, seeded library in `extension/humanize/` plans each action. `extension/lib/humanize.js`
dispatches the plan as trusted CDP input: `isTrusted === true`, `pointerType` mouse, and nothing
moves the OS cursor.

| Level | What the page receives |
|---|---|
| `off` | v1's direct dispatch: one move onto the target, press and release back to back, 12 ms between typed characters. Fast and obviously scripted. |
| `human` | Curved pointer paths with human timing, press holds, wheel notches, a per-key typing rhythm, and occasional corrected typos. Typos are never made in password fields, and `typos:false` turns them off. |
| `stealth` | `human` without any shortcut a page can notice: no `DOM.focus` (focus is earned by a click), no programmatic scroll (G9 fails and says why instead), and no `Input.insertText` unless `fast:true`. |

What this costs, measured in the round-3 Engine 2 live test on headless Edge (8 full runs; the
click-call time is from the last 3):

| Measure | `human` | `stealth` | `off` |
|---|---|---|---|
| A whole click call | 4.5–4.9 s | | |
| Press hold | 77–138 ms | 61–139 ms | 1.5–2.6 ms |
| Median gap between keydowns (26 characters) | 121–154 ms | 139–170 ms | 30 ms |
| A click 2952 px below the fold (human and stealth reach it with 27–30 trusted wheel events) | 5.7–7.6 s | 5.8–7.7 s | 22–42 ms |

Every press carries `pointerdown.pressure` 0.5. Choose `off` for speed when bot detection does not
matter.

**Calibration.** `browser_recording action:"calibrate_humanize"` fits a profile from the raw pointer
and keyboard samples that a recording captured, and saves it under a name. Use it afterwards as
`humanize:"<name>"`.

Limits of the model are listed in [docs/HUMANIZE.md](docs/HUMANIZE.md#honest-limits):

- uniform ranges and one Bézier path per move, with at most one overshoot;
- white-noise tremor;
- US QWERTY only, and no IME;
- a notched wheel only (no touchpad).

A detector trained on many sessions could still separate it.

---

## Recording, replay and the known world

**To record:** open the side panel's **Automation** tab and press **Start recording**. Use the page
exactly as you would when testing it, then stop.

- The recorder lives in G9's isolated world. After recording and replay, the page's own `window`
  had exactly the same property names as before (1233 in the Engine 1 live test).
- It captures DOM interactions up to a 5,000-event safety cap, plus the raw input samples that
  calibration uses.
- A second recording on a tab that is already recording is refused.

### How a step finds its element after a redeploy

One selector is not enough to survive a redeploy: a CSS path breaks on a refactor, an id breaks when
the framework regenerates it, and text breaks on a copy edit. So each element is recorded with
**several independent locators**, tried in order of how well they survive change:

| # | Locator | Survives |
|---|---|---|
| 1 | `data-testid` / `-test-id` / `-test` / `-qa` / `-cy` | anything: a test id is a promise not to move |
| 2 | **role + accessible name** | restyling, DOM restructuring, class churn |
| 3 | bound `<label>` text | everything except a copy change |
| 4 | shortest unique visible text | buttons and links |
| 5 | CSS from stable attributes only | refactors that keep `name` / `type` |
| 6 | XPath | last resort |

Machine-generated values are refused outright: CSS Modules, styled-components, emotion, React
`useId`, Radix, `ng-tns` and raw hashes. They are stable within one build and different in the next.

**Replay warns before a flow breaks.** Suppose a step used to match on `testid` and now matches only
on `xpath`. It still passes, but with a warning, because it is one refactor away from failing.
When a step does fail, the message says what was looked for, what was tried, and what is closest:

```
Could not find textbox "Username" under "Billing details".
Tried 4 recorded locators: role (0 matches), label (0), css (0), xpath (0).
The closest thing on the page now is textbox "User name (email)" —
this usually means it was renamed.
```

**Timing.** Replay gates every step on load, visibility, enabled state and settling.

- `timing:"recorded"` (the default) keeps the person's pace, capping each remaining pause at 10 s.
  A 10-second session replayed in 200 ms never lets a debounce fire.
- `adaptive` waits only as long as each step needs.
- `fast` barely waits.
- `dryRun:true` resolves every element without changing anything. It is the cheapest check that a
  recording has rotted.

**On a launched browser.** `replay engine:"launched"` runs the flow in a launched browser. The
recording is copied there if it exists only in your browser. `humanize` and `seed` apply to replays
too.

### Turning a recording into a test

- **`assert`** adds checks: URL, text, visible, value, state, network, console absence, a11y,
  `aria` (a semantic baseline) or `screenshot`. `atStep` places a check after a chosen step.
- **`update`** sets suite, folder, tags, an environment profile and `{{parameter}}` defaults.
- Replay keeps the last 20 runs and flags flows with mixed pass/fail results.
- **`export_test`** writes Playwright JavaScript. Check its notes: it does not reproduce every G9
  check.
- **`export_spec` / `import_spec`** move a flow in and out as a canonical, Git-diffable FlowSpec.

**The wizard proposes the checks you cannot see.** A flow with no assertion is a macro: it proves
the steps could be performed, not that they did anything. `action:"suggest"` looks at what was
observed and proposes assertions, each with a strength and a reason:

```
url      strong   The flow ends here. If a later build routes elsewhere, everything else still passes.
network  strong   The flow performed POST /api/task. Asserts the business effect, so it survives a redesign.
console  blocked  The page ALREADY has 3 console errors, so this would fail immediately.
aria     strong   180 semantic nodes — small enough to be a stable structural baseline.
text     weak     Offered last: easiest to write, first to break on a copy edit.
```

It adds nothing by itself; you pick. A weak assertion someone chose on purpose is a decision; one a
tool added quietly is a blind spot.

### Remembering what normal looks like

An assertion only finds what somebody thought to look for. So every replay also builds a
**signature** of what the flow actually did: requests made, console output, the semantic shape of
each screen, and step timings. The signature is compared with that flow's approved **known world**.
Anything outside it is a *surprise*, in either direction:

```
+ [fail] console: error: Cannot read properties of undefined
− [fail] network: POST /api/task 2xx
         This request happened on all 7 previous runs and did not happen now.
+ [warn] ui: s4 :: 2|button "Archive"
```

The second kind is easy to forget. A request that *always* happened and now does not usually means
a button that no longer does anything, and no assertion was ever written for it. Replay also waits
briefly after the last step, so late evidence is counted consistently: until no request is in flight
and no new console entry or request has arrived for 500 ms, at most 2 s in all. The quiet period
starts only once a check has seen no request in flight (since 2.0.2: before, a response that arrived
late could be missed). The result reports `settledAfterLastStep`.

Three rules keep it from becoming noise:

- **Calibrate once.** `action:"calibrate"` (or `g9 calibrate <flow>`) runs the flow twice on the
  same build and marks everything that differed as volatile. Whatever changes when nothing changed
  is noise. This replaces hand-written masks.
- **Confirm before escalating.** A surprise seen once is reported as a note. The same surprise in
  most recent runs becomes a finding.
- **Only a human approves.** `action:"approve"` (with `by` and `note`) folds the last run into the
  known world, and nothing else can. An automatic merge would write a real regression into the
  baseline as normal. Agents are told never to approve on their own initiative.

Every replay returns a verdict: `PASS`, `PASS_WITH_WARNING`, `SURPRISE`, `FAIL_PRODUCT` or
`FAIL_AUTOMATION`. The last two are kept apart on purpose: a rotted locator is a broken test, not a
broken product.

### Semantic baselines, HAR pinning and A/B

- **Semantic baselines.** `assertion:"aria"` stores the accessibility tree (roles, names, states)
  instead of an image, so it ignores styling and theme changes. Screenshot assertions compare
  **layout structure** by default (`visualMode:"layout"`); `strict` compares pixels.
- **Freeze the backend.** `browser_network action:"record_har"` captures a run once against the
  real server. Then `action:"pin"` serves matching requests from that HAR, or use the runner's
  `--pin file.har`.
  - Matching uses method, origin/path and query **keys**. Query values and request bodies are
    ignored, and duplicate entries are served in order.
  - Unmatched requests reach the live server unless `strict:true` (`--strict-pin`).
  - Pinning narrows a diagnosis. It does not prove the backend was fully frozen.
- **Compare two builds.** Run the same flow against both, minutes apart, on one machine:

  ```powershell
  node runner/g9.mjs ab <flowId> --a https://released.example --b https://candidate.example
  ```

  It reports *differences*, not verdicts: a shipped feature and a regression look the same from
  here.

---

## Evidence: screencast frames and the pointer track

**Issues (both engines).** In the side panel, open **Issues** and press **New issue**, or call
`browser_issue create`. G9 captures first and asks questions second, because the evidence is only
true at that moment:

- a viewport screenshot;
- the console tail and failed requests;
- URL, referrer, viewport and user agent;
- the DOM around the suspect element.

These are stored as real attachments: `console.log`, `failed-requests.log`, `page-context.json` and
`page-fragment.html`. An agent filing to Jira or Azure DevOps uploads files rather than pasting a
blob.

A tab video (`video_start` / `video_stop`, **Record tab** in the panel) consumes the shared
screencast, up to 600 frames or 40 MiB. Each stored frame carries the pointer position at that
moment, and the full track is attached as `pointer-track.json` (format `g9-pointer/1`). Measured:

- **Engine 1:** 72–87 frames, with the press in the track.
- **Engine 2:** 18–35 frames over 4.7–7.0 s, with 124–164 pointer samples, all inside the viewport.

**Evidence runs.** Each of these writes a folder `G9_HOME\runs\<runId>\`: every Engine 2 replay
and calibration, every desktop watch (of either engine's tab), and every scheduled run. A scheduled
run's folder holds the runner's reports in `report\`. A replay's folder contains:

- `engine.json`: browser, argv, stealth level and humanize seed;
- `frames/<seq>.jpg` and `frames.jsonl`;
- `pointer.jsonl`: the cursor track `{at, x, y, buttons, type}`;
- `downloads.jsonl`;
- `result.json`: verdict, steps, warnings and surprise count.

Limits come from `settings.evidence`: `maxFrames` 3000, `maxBytes` 300 MB and `keepRuns` 200.
Frames past a limit are counted, not written, and `result.json` says so.

**Live watch.** The desktop's Watch view shows a tab's screencast with the cursor drawn from the
pointer samples. It is view only: nothing you click there reaches the page. A hidden tab produces no
frames, and the viewer is told so (a `watchStatus` event with `state:"hidden"`) instead of seeing a
frozen picture.
The Runs view replays a run's frames with the cursor. **Export video** writes
`runs\<runId>\video.webm`, though the export itself was not exercised in the recorded test rounds.

**Other budgets:**

| Item | Limit |
|---|---|
| Console entries | 500 |
| Network requests | 400 |
| One response body | about 512 KB of text |
| HAR bodies in total | 8 MB |
| Full-page and element screenshots | scaled to fit 2000 px wide by 8000 px high (at human and stealth an element is first limited to its on-screen part) |

Capture starts when a tab is attached. For a page that was already open, reload it to see its
requests.

**Downloads.**

- Engine 2 reports each file's size, sha256, first bytes and sniffed type. In the live test these
  equalled the bytes the server sent.
- Engine 1 cannot read file contents. It reports the browser's record (exists, size) and an
  attribution labelled `exact`, `probable` or `unknown`.

---

## Unattended runs: the runner and the scheduler

`runner/g9.mjs` replays flows with no agent and no QA present. Full reference:
[runner/README.md](runner/README.md).

```powershell
node runner/g9.mjs list
node runner/g9.mjs run suite:smoke --env test1 --report .\g9-artifacts
node runner/g9.mjs run tag:checkout --headed --profile qa-checkout --humanize-seed 42
node runner/g9.mjs calibrate <flowId>
node runner/g9.mjs approve   <flowId>          # after a human reviewed the run
node runner/g9.mjs spec      <flowId> --out QA/Flows/web/auth/login.flow.json
```

From an installed desktop app, with no Node on the machine:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& "$env:LOCALAPPDATA\Programs\G9\G9.exe" "$env:LOCALAPPDATA\Programs\G9\resources\runner\g9.mjs" run suite:smoke
```

**Engines.**

- `--engine launched` is the default. It runs in a browser the daemon launches, headless by default
  (the daemon setting `headless`) or headed with `--headed`, with its own profile (`--profile`,
  default `automation`). It does not touch the
  person's browser.
- `--engine extension` replays on the tab the person's browser has current. It shares that browser,
  so do not schedule it.

**Flows** come from the repository. Every `*.flow.json` FlowSpec under the project's `flowsDir`
(from `g9.project.json`, default `QA/Flows`) is imported into the launched store before the run.
Re-importing keeps what the store learned: the known world, run history and flakiness.

**Targets:**

- `<flowId>` or its name
- `suite:<name>`
- `tag:<name>`
- `all`

A selection that matches nothing is an error, never an empty PASS.

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | Everything passed (warnings allowed). |
| 1 | Product failure: an assertion or oracle failed. |
| 2 | Automation failure: the test broke, not the product. |
| 3 | A confirmed surprise. |
| 4 | The runner could not run at all. |

`--fail-on failure` keeps the gate where a normal suite puts it while you learn to trust the
surprise detector.

**Reports:**

| File | For |
|---|---|
| `run.json` | Machines: every surprise, the engine, the seed. |
| `junit.xml` | CI. |
| `report.html` | People. Self-contained, no CDN. |
| `qa-automation-status.json` | A manual QA suite, which reads which cases are automated. |

The runner speaks MCP through the same shim as any agent. Ownership, Stop and every refusal apply to
it exactly as to an agent; there is no back door.

**Scheduling.** The desktop's Schedule view, or the daemon's `schedule.*` admin operations, runs
`runner/g9.mjs run <target>` daily at a set time or every N minutes. Each run is filed under
`G9_HOME\runs\<runId>\` with its reports.

- Enabled schedule entries keep the daemon from exiting on idle. After a reboot, however, nothing
  starts the daemon unless the desktop app starts at sign-in (Settings → **Start G9 when I sign
  in**). An agent's first call also starts it.
- Windows Task Scheduler can call `runner/g9.mjs` instead. The exact command for an installed
  machine is in [docs/INSTALL.md](docs/INSTALL.md#unattended-machines). Task Scheduler itself was
  not exercised.
- **Not measured in v2:** a scheduled or launched run while the Windows session is **locked**, or
  on **another virtual desktop**. Headless Engine 2 has no window, so by design neither state
  applies to it (AIGuide §2.8.1, D3). A logged-off session runs nothing.

`--platform agripad` drives an AgriPad device over adb instead of a browser, with the same flow
format, verdicts and reports.

---

## The desktop app

The Electron shell (`desktop/`) is never an engine: pages under test run only in real Edge, Chrome
or Chrome for Testing. The app talks to the daemon as a UI client over the same WebSocket, and
starts it if nothing is listening. Full reference: [desktop/README.md](desktop/README.md).

| View | What it does |
|---|---|
| **Agents** | Connected agents, the tabs each owns, Halt/Resume per agent, and the activity log. |
| **Engines** | The extension and launched engines, with their contexts and tabs. A launch form, Stop, Reload (or Update and reload) for the extension, installed browsers, Chrome for Testing install, and profile warm-up. |
| **Watch** | A live tab with the cursor drawn in. View only. |
| **Runs** | Every run: verdict, steps, surprises, a frame replay with the cursor, and Export video. |
| **Approvals** | Flows with surprises. Approve calls `browser_recording approve` with `by` set to your Windows user name, and asks once more. |
| **Schedule** | Daily or every N minutes. Every engine option becomes an explicit runner flag, so later default changes never alter a scheduled suite — except a browser left at "auto", which passes no `--browser` and so follows the daemon's `defaultBrowser`. |
| **Settings** | Daemon settings, the updater, sign-in start, and folders. |
| **Setup** | The first-run wizard, runnable again at any time. |

**Always visible.** The top bar and the tray menu carry **Stop all** and **Resume**. The version
appears in the window title, the tray tooltip and a badge.

**Updates.** Updates use electron-updater's generic provider.

- The feed is set in Settings → Updates: the daemon setting `updateUrl` (`https://`, or `http://`
  only on the local machine for a test feed), on the channel `updateChannel` (`stable` or `beta`).
  The app keeps its own copy and updates only from it: a different URL that arrives through the
  daemon's settings is used only after a dialog naming the new host. With no URL, the app never
  checks anywhere.
- An update restarts the daemon, so it waits until the daemon reports no run in progress and no
  launched browser.
- After an update, the app refreshes `G9_HOME\extension`, and the extension reloads itself.
- The updater was tested with an injected fake only; no update server exists yet.

**How it was checked.** The render check (`npm run test:render`) opened the real window off-screen
and captured every view, empty and populated, in dark and light. The tray, notifications and the
UAC path of the policy page were not exercised on a real desktop.

---

## Configuration

**Daemon settings.** Edit `G9_HOME\settings.json`, or use the desktop's Settings view. Unknown keys
are kept; invalid values are refused by name.

| Key | Default | Meaning |
|---|---|---|
| `port` | 8765 | The daemon's port. |
| `defaultBrowser` | `auto` | `auto` (pinned CfT if installed, else Edge, else Chrome), `edge`, `chrome` or `cft`. |
| `headless` | `true` | Window mode of engines the daemon launches on demand. |
| `humanize` | `human` | Default input level, or a calibrated profile name. |
| `stealth` | `off` | Default stealth level for launched engines. |
| `maxParallel` | 8 | Concurrent state-changing Engine 2 calls ([measured](#measured-performance)). |
| `evidence` | `{maxFrames:3000, maxBytes:300 MB, keepRuns:200, quality:60, maxWidth:1280, maxHeight:800}` | Evidence-run limits. |
| `idleExitMinutes` | 60 | Idle time before the daemon exits; 0 means never. |
| `updateUrl`, `updateChannel` | `''`, `stable` | The desktop app's update feed. |

**Environment variables.**

| Variable | Used by | Effect |
|---|---|---|
| `G9_PORT` | shim, daemon | The daemon's port. |
| `G9_HOME` | shim, daemon | The data folder. Default `%LOCALAPPDATA%\G9`. |
| `G9_HOST` | shim | The address it connects to. |
| `G9_TIMEOUT_MS` | shim, daemon | Per-call base deadline, default 120000. Long calls get more (DAEMON_PROTOCOL §3). |
| `G9_PROJECT` | shim, daemon | The project adapter. Otherwise the agent's working folder decides. |
| `G9_ENGINE_RESUME_MS` | daemon | How long a disconnected extension keeps its tab handles. Default 10 minutes. |
| `G9_IDLE_EXIT_MS` | daemon | Idle-exit time, for tests. |

**`G9_HOME` layout:**

```
G9_HOME\  (default %LOCALAPPDATA%\G9)
  settings.json  daemon.json  daemon.lock  desktop.json  engine-versions.log
  engines\cft-<version>\      Chrome for Testing        engines\log\<engineId>.json  (argv, versions)
  engines\firewall-seen.json  CfT paths already warned about
  profiles\<name>\            browser profiles           profiles\<name>.json         (persona: locale, timezone)
  store\                      launched-engine recordings, issues, attachments
  runs\<runId>\               evidence runs              downloads\<contextId>\
  extension\                  desktop-managed extension  logs\daemon.log, install.log, desktop.log
```

**Project adapter.** Copy `g9.project.example.json` into the repository of the app under test, as
`g9.project.json`. It holds environments, the flow library folder, URL normalizers, secret *names*,
operation aliases and a report sink. One daemon serves agents working in different repositories:
each agent's working folder selects its project.

---

## Security and trust model

G9 has full control of the browser sessions it is attached to. Treat it as you would an SSH key.

**Decision D7: local trust.** G9 v2 targets a trusted local QA machine. There is:

- no token;
- no allowlist;
- no cookie scoping;
- no title or URL withholding.

Attaching gives every tab, every title and URL, and every cookie of any domain, HttpOnly included.
The Stop button and the activity log remain as operational features, not security boundaries.

**What protects you:**

- **Loopback only.** The daemon binds to `127.0.0.1`, never `0.0.0.0`.
- **Web pages are refused.** A WebSocket upgrade whose `Origin` is `http://` or `https://` gets 403.
  That includes pages served from `127.0.0.1` or `localhost`, and any scheme G9 does not recognise.
  This is the one deliberate exception to D7's "no origin checks" (ARCHITECTURE_V2 §0). Without it,
  any site open in the QA's browser could call `new WebSocket('ws://127.0.0.1:8765/g9')` and drive
  every tab. The self-test asserts the refusal. Extension origins, and native clients that send no
  Origin (shim, runner, desktop), are accepted.
- **Narrow CORS.** `/health` echoes a CORS header only for extension origins.
- **Agents cannot resume a Stop.** Admin operations (resume, settings, schedule, extension
  install) are refused to agents.
- **Engine 2 isolation.**
  - It never opens a person's browser profile.
  - It is driven over a pipe, so no debugging port is open for other processes to find.
  - Every launch passes `--disable-sync` and `--disable-features=msImplicitSignin`, because a
    fresh Edge profile otherwise signed itself in to the Windows Microsoft account and turned sync
    on. That was measured before the fix.
  - A profile that is already signed in is refused at stealth and warned about otherwise.
- **No supply chain in the core.** The core has zero npm dependencies. The desktop's only runtime
  dependency is electron-updater.
- **A locked-down desktop window.** The renderer runs with `contextIsolation`, `sandbox`, a CSP of
  `connect-src 'none'`, no `<webview>`, and a fixed list of operations. Approvals go through the
  main process.

**What is not protected:**

- **Local processes.** Any local process or user can connect to the daemon without a token and
  drive every attached tab. Use G9 only on machines whose local users and software you trust.
- **The installer is unsigned.**
- **The debugging bar.** While `chrome.debugger` is attached, the browser shows a "started
  debugging this browser" bar. Per Chromium, only a policy-installed extension or
  `--silent-debugger-extension-api` removes it. G9 sets up neither, and that removal was not
  measured.

**Extension permissions:** `debugger`, `tabs`, `activeTab`, `cookies`, `storage`, `alarms`,
`sidePanel`, `unlimitedStorage`, `downloads`, and host access to `<all_urls>`.

**Browser boundaries that no setting changes:**

- Browser-internal pages (`chrome://`, `edge://`, the web stores, other extensions) cannot be
  controlled.
- Native OS dialogs (print, basic auth, the file picker) are outside the page. Upload files with
  `browser_interact action:"upload"` instead.

---

## What works in which state (measured)

Source: the P8 matrix (`setup/matrix.mjs`). Last full run 2026-09-23 with G9 2.0.1: exit 0, every cell below still agrees with what the page recorded.

- **Engine 1:** the real extension in Edge 153.0.4234.32 and Chrome 153.0.8010.53. Two full passes,
  plus a re-run of the hidden-part-way states after the last fix.
- **Engine 2:** Edge 153.0.4234.32 launched by the daemon.
- **Every cell** compares G9's report with the page's own log of trusted events. A screenshot
  counts only if it shows a marker painted just before, so a stale image fails.
- **The occlusion switch** is `--disable-features=CalculateNativeWinOcclusion`. Chromium documents
  the `WindowOcclusionEnabled=0` policy, which the desktop wizard can apply, as equivalent; the
  policy itself was not measured.
- **Headed windows** were parked off-screen at -32000,-32000 without activation.
  `--start-minimized` was not honoured by Edge or Chrome 153 (the window opened `normal`), so
  minimized windows were minimized without activation instead.

### Engine 1 (the extension)

| State | Switch | Page reports | Click / type / wheel | Screenshot | Live watch |
|---|---|---|---|---|---|
| Active tab (headless browser) | off, on | visible (142–147 frames per 1.5 s) | delivered | fresh | streams |
| Headed window, off-screen (occluded) | **on** | visible (142–143 frames per 1.5 s) | delivered | fresh | streams |
| Headed window, off-screen (occluded) | off | **hidden** | refused as `not-delivered` in 6–42 ms; the page received nothing | fresh | no frames; viewer told `hidden` |
| Background tab (another tab active in its window) | off, on | **hidden** | refused, as above | fresh | no frames; viewer told `hidden` |
| Minimized window | off, on | **hidden** | refused, as above | fresh | no frames; viewer told `hidden` |
| Tab hidden part-way through an action | on (headed), off (headless) | becomes hidden | see below | — | — |
| On-screen headed window, focused or unfocused | — | **not measured**: the harness never put a window on screen | | | |
| Locked session | — | **not measured** | | | |
| Another virtual desktop | — | **not measured** | | | |

Notes:

- **Hidden-row counts.** Every hidden row was refused in 6–42 ms, with nothing received and a watch
  status of exactly `["hidden"]`. That is 20 rows across the two round-3 passes, plus 10 in the
  earlier full pass.
- **The remedies** are `browser_tabs action:"focus"`, `"popout"` or `"handoff"`. After `focus`,
  the same click was delivered exactly once.
- **Hidden part-way through an action:**
  - Typing completes: all 30 keydowns arrived while hidden, and it was reported delivered (8 of 8).
  - A scroll reports `partial`, with the page's own scroll distance (4 of 4).
  - A click that never pressed reports `not-delivered` (4 of 4).
- **Why refusal is safe.** With bare CDP on hidden pages in round 3, `mouseMoved` got no answer
  within 5 s (10 of 10 per pass). A key event did reach a focused field on a hidden page (10 of
  10). G9 still refuses keys to a hidden page by policy, because nobody can see what they do.

### Engine 2 (launched browsers)

The product always turns native occlusion off, and asking it to turn occlusion on is refused.

| State | Page reports | Click / type / wheel / screenshot | Notes |
|---|---|---|---|
| Headless, agent's tab in front | visible | delivered. Human-level click about 5.4 s, type about 4.5 s, wheel about 1.4 s; screenshot 69–91 ms. | |
| Headless, a second tab G9 opened | visible | delivered. Click 4.3 s, screenshot 83–115 ms. | Every page G9 opens gets a window of its own. |
| Headless, agent's tab behind a tab the **page** opened (`target=_blank`) | visible | delivered. Click 4.9 s, type 5.1 s, screenshot 100 ms. | `browser_status` warns `BEHIND`, and a headless engine brings the tab to the front before input. Before this fix: click 20.9 s, screenshots 24–46 s. |
| Headed, off-screen | visible | delivered | |
| Headed, **minimized** | "visible", but rendered at about 1 frame per 1.5 s | delivered but slow: click 28–29 s, screenshot 33–46 s | `browser_status` warns (3 of 3), and the capture note names "minimized". Do not minimize headed engines. |
| Locked session, other virtual desktop | **not measured** | | Headless has no window, so by design these states do not apply (AIGuide §2.8.1). |

---

## Measured performance

**Conditions.**

- **Date and versions:** 2026-09-22; G9 2.0.0; Windows 11 Pro 10.0.26200; Node 22.15.0; Edge
  153.0.4234.32 headless (Engine 2).
- **Machine:** Intel i9-10900X (20 logical CPUs), 63.7 GB RAM. Other live suites were running at
  the same time, and the machine was 27–57% busy.
- **Input:** `human` level, with shared seeds.
- **Setup:** one browser context per simulated agent, each through its own MCP shim.
- **The flow:** goto → snapshot → type user → type password → click Sign in → wait for text →
  select → wheel 400 px → viewport screenshot.

**The final pass, 2026-09-23 (G9 2.0.1, the tree that shipped then).** `setup/bench.mjs` at its default
levels, 5 iterations each, shared seeds, on an otherwise idle machine:

| Contexts | Wall s | Flow p50 / p95 ms | Interaction p50 / p95 ms | Click overhead p50 / p95 ms | Browser private peak | Daemon private peak | Failures |
|---|---|---|---|---|---|---|---|
| 1 | 54.8 | 11,599 / 12,211 | 1,456 / 4,859 | 160 / 165 | 554.5 MB | 69.9 MB | 0 |
| 4 | 55.9 | 11,398 / 12,096 | 1,441 / 4,897 | 157 / 182 | 964.9 MB | 99.8 MB | 0 |
| 8 | 57.7 | 11,618 / 12,588 | 1,477 / 4,975 | 191 / 260 | 1,512.8 MB | 104.7 MB | 0 |
| 16 | 64.1 | 12,668 / 14,233 | 1,544 / 5,208 | 249 / 471 | 2,528.1 MB | 108.4 MB | 0 |
| 16, gated to 8 | 120.0 | 21,880 / 24,730 | 3,408 / 8,969 | 2,572 / 5,183 | 2,505.5 MB | 106.3 MB | 0 |

The rule gave **maxParallel 8** on this run: 16 contexts tripped it on the select step (p95 ×3.44,
+398 ms) while the whole flow was only ×1.17. Daemon plus browser used 9% of the machine at 16
contexts — the limit is latency, not CPU. Gating 16 to 8 doubled the wall time, exactly as the cap
promises.

The numbers below come from the live rounds before the fix rounds, and are kept for comparison.

**One context** (bench, round 3, pass 2), p50 / p95 in ms:

| Measure | p50 / p95 |
|---|---|
| Whole flow | 11989 / 12403 |
| Click | 1404 / 1601 |
| of which G9 overhead beyond the humanized motion | 143 / 159 |
| Type password | 4546 / 6266 |
| Wheel scroll | 911 / 1819 |
| Screenshot | 68 / 122 |
| Goto | 1465 / 1592 |

**Throughput** (815 humanized flows across 3 passes, 0 failures):

| Contexts | 1 | 4 | 8 | 12 | 16 | 24 |
|---|---|---|---|---|---|---|
| Flows per minute | 5.2–5.3 | 20.6–20.7 | 39.8–40.5 | 57.9–58.2 | 73.4–74.4 | 101.1 (1 pass) |

Four agents with human input on four contexts finished together in 7.2–8.8 s, against 26.7–30.6 s
for the sum of their call times (Engine 2 live test). Snapshots taken by another agent every 100 ms
did not slow a seeded click: 938–964 ms alone against 941–1016 ms with the reads.

**Recommended `maxParallel`.** The default stays **8**. The bench's rule takes the largest level
before any of these happens:

- flow p95 exceeds 1.25× the single-context p95;
- a step's p95 is both more than 1.5× and more than 250 ms above its single-context p95;
- anything fails;
- daemon plus browser CPU exceeds 60% of the machine.

What the rule gave on this workstation:

- **Round 2** (three runs) and a confirmation run after its fixes: **8**.
- **Round 3** (three full passes): **12**.
  - 12 passed the rule in 2 of 2 passes that measured it.
  - 16 passed in 1 of 3 (it failed only on the select step's p95).
  - 24 failed (flow p95 ×1.27).
- **The limit is latency, not CPU.** At 16 contexts, daemon plus browser used 1.9 cores, 9% of the
  machine.
- **The gate caps throughput exactly.** 16 contexts gated to 8 gave 39.8–40.3 flows per minute, the
  same as 8 ungated.

Raise the setting only after running `npm run bench` on your own machine class.

**Memory and startup:**

- **Browser:** about 395 MB idle, plus about 128 MB per loaded context (round 3). Round 2 measured
  129–135 MB per extra context.
- **Daemon:** 104–112 MB private, flat as contexts were added (round 3).
- **MCP shim:** about 49 MB each (round 2).
- **Engine 2 launch:** 737–1046 ms from spawn to ready.

**Endurance** (10-minute runs only; longer runs were not measured):

- **The final pass, 2026-09-23.** One 10-minute run on the 2.0.1 tree: **93 iterations, 0
  failures**, iteration p50 / p95 11,976 / 14,465 ms. Daemon private memory grew **0.39 MB/min**
  (working set 0.5) and its handle count fell 0.15/min; browser private memory grew **1.79 MB/min**
  (working set 3.29) with the process count flat at 20. Listener counts were flat after `gc()` — 48
  before and 48 after, delta 0 across 47 samples — and the single-page app stayed at 48 listeners
  with 2 nodes added per pass. The UI saw 4,085 watch frames; 300 were kept on disk.
- **Round 3, two runs.** 2 contexts (one navigating flow, one single-page app that never
  navigates) and a live watch on one of them.
  - 90 and 89 iterations, 0 failures.
  - Iteration p50 / p95: 12398 / 14964 ms and 12477 / 15010 ms.
  - After `gc()`, JavaScript listeners added by a pass: 0 in 46 of 46 and 45 of 45 readings. The
    single-page app's listener count stayed flat.
- **After round 2's fixes, two runs.** 0 failures.
  - Daemon private memory grew 0.58 and 0.43 MB/min; browser private memory grew 3.0 and
    1.0 MB/min.
  - One run flagged a rising listener count, judged to be uncollected garbage. That is why round 3
    reads after `gc()`.

---

## Stealth: what was measured

The full guide is [docs/STEALTH.md](docs/STEALTH.md). Its first rule: behaviour can be made
indistinguishable, but the environment can only be made **consistent**. A human-looking mouse in a
browser that says `HeadlessChrome` is still caught.

**What `stealth` changes (Engine 2):**

- `--disable-blink-features=AutomationControlled`, the one switch any level adds (decision D-a).
  The debugging pipe itself sets `navigator.webdriver` true, and `off` and `human` keep that true
  and say so at launch.
- The `Runtime` domain is never enabled. As a result, `browser_console` cannot read the page's
  `console.*` output and says so.
- The input rules above: no `DOM.focus`, no programmatic scroll, no `insertText`.
- Full-page screenshots of a page taller than the viewport are refused, because Chromium resizes the
  viewport for them and the page can see that. At `human` the capture is taken, and `pageSaw` in the
  result discloses the resize.
- A context locale in a different language from its profile is refused, because a per-tab override
  did not reach the page's workers. Launch a profile with that locale instead.
- G9 never overrides the user agent, Client Hints, WebGL or platform strings on its own: consistency
  beats spoofing. `browser_emulate` device presets do override the user agent (and leave
  `navigator.userAgentData` empty), and a `browser_emulate` locale changes `Intl` only — both are
  refused on a stealth tab, and `reset:true` gives the browser's own user agent and Client Hints back.

**Local detector page** (`setup/fixtures/stealth-local.html`), on the final code: no G9-class
failure in any stealth configuration. **Headed Edge at stealth was undetected.** Headless
configurations were detected only by the `HeadlessChrome` user agent. The human-level controls were
detected, as intended.

Across the 40 stealth local-page runs of live round 3:

- `navigator.webdriver` was false in 40 of 40 (from the native getter).
- The Runtime-enable console probe got 0 hits in 40 of 40.
- G9 left no globals, DOM nodes or main-world calls in the page, including in cross-site frames.
- A sweep of 520 read-tool calls at stealth caused no change the page could see.
- Press holds were 60–151 ms, and `pointerdown.pressure` was 0.5.
- Mouse-move cadence was 11.1–12.2 ms on Edge and 16.8–17.2 ms on Chrome for Testing.

**Public detectors.** Last run on 2026-09-23, over the whole matrix, on the 2.0.1 code.

| Configuration | sannysoft | creepjs | browserscan | pixelscan | Fingerprint | rebrowser |
|---|---|---|---|---|---|---|
| Headless stealth, Edge | flagged (User Agent, HEADCHR_UA, CHR_MEMORY) | headless 67% | "Robot" | "Automated behavior detected" | bot: bad | pass |
| Headless stealth, CfT | flagged (same three) | headless 67% | "Robot" | "Automated behavior detected" | bot: bad | flags the user agent |
| Headed stealth, Edge (off-screen) | pass | pass (like-headless 19% warning) | pass | "Automated behavior detected" | pass | pass |
| Headed stealth, CfT (off-screen) | pass | pass (like-headless 19%) | pass | pass (timezone/proxy warnings) | pass | flags the "Chrome for Testing" brand |
| Human-level controls (Edge and CfT) | detected | headless 100% | "Robot", WebDriver | detected | detected | navigatorWebdriver |

Every flag above is a property of the browser or of headless mode. **No G9-class leak was found in
any stealth configuration in either run** (local page or public pages).

**What G9 cannot remove:**

- **Headless user agent.** `HeadlessChrome` appears in the user agent and in userAgentData. So
  **headless is detectable**: run stealth-critical suites **headed**, on a dedicated desktop (a VM,
  Windows Sandbox, or a QA machine with autologon), not on someone's desk.
- **Brands.** Edge does not present "Google Chrome" in userAgentData, and Chrome for Testing names
  itself.
- **pixelscan on headed Edge.** It flagged headed Edge in every run, including raw probes where
  nothing was attached until 30 s after load. Headed Chrome passed pixelscan 2 of 2. No field could
  be attributed.
- **Engine 1 is not a clean environment.** The debugging bar shortens the viewport: on headless
  Edge, `innerHeight` was 760–761 px with the extension against 808 px without it. Every
  cross-document load in that browser also fires 2 transient `resize` events 148–301 ms in. So
  `stealth` on Engine 1 means stealth *input rules* only. For detector-sensitive pages, use a
  launched engine or `handoff`.
- **Coalescing.** One dispatched pointer event arrives per frame and is never coalesced: the
  `pointerrawupdate` count equals the `pointermove` count. This is a weak CDP-class signal.
- **Widevine.** It is absent at `off` and `human` by design (`--disable-component-update` keeps the
  environment fixed), and Chrome for Testing has none at all.

**Which browser.** Edge is the best measured. Chrome for Testing is pinned and reproducible, but
detectors read its brand and its missing Widevine, and its renderer runs at 10 frames per second on
this machine unless G9 passes `--disable-frame-rate-limit` to it (re-confirmed 2026-09-23 with the
machine's firewall prompt for `chrome.exe` answered: 100.5 ms between frames in every launch without
the switch, 17.4 ms in every launch with it, against Edge's 10.5 ms).

**Profiles.**

- Warm a profile once with `browser_engine action:"warm"`, and use one profile per persona.
- A launch `locale` and `timezone` are saved in the profile and become its languages.
- Never use a profile that is signed in to a browser account.

---

## Limits and known gaps

**Input and delivery**

- **Whole-pixel coordinates.** Humanized coordinates are whole CSS pixels: `interact.js` passes no
  device pixel ratio to the planners. That matches a real mouse only at 100% display scaling. It
  was left as is on purpose, because changing it affects replay determinism.
- **Keys to hidden pages.** Key input to a hidden Engine 1 tab is refused by policy, even though
  Chromium delivers it.
- **The timeout guesses a cause.** When a call runs out of time (120 s by default) and does not stop
  within the 5 s grace, the error says it may still be running and names likely causes: the page is
  stuck loading, a JavaScript dialog G9 did not see is open, or (on Engine 1) the tab is hidden. That
  is a guess. The next call on that tab can overlap the one still running.
- **Witness listener after Stop.** After Stop mid-action, G9 still ends and releases its own witness
  listener (a clean-up command it sends on the live session, bounded at 2 s). Only if that command
  fails does the listener stay armed in G9's isolated world, for up to 10 minutes. It reacts only to
  trusted events.
- **`select` at stealth** (click, Escape, then keyboard) was not tested against a headed browser's
  native popup.
- **Refs** can go stale across snapshots ([Element refs](#element-refs)).

**Engines and tabs**

- **Headed and minimized is slow.** A minimized headed Engine 2 window renders about 1 frame per
  1.5 s, so actions take tens of seconds. G9 warns but cannot speed it up.
- **A popped-out window must stay on screen.** On Windows, a popped-out Engine 1 window that another
  window covers completely stops rendering unless the `WindowOcclusionEnabled` policy is off, and a
  minimized one always does. An agent's popout is created unfocused, so it can open behind the window
  the person is using; its result's `visible` says so. The 2.0.3 fix is checked against a stubbed
  browser (`setup/unit/seam.test.mjs`); the harnesses never put a window on screen, so no test has
  shown it on a real desktop.
- **Not measured:** a second window on a headed engine copies an existing window's bounds, and
  Chromium may move off-screen bounds back on screen.
- **Tab handles after a reconnect.** After an extension reload or a browser restart, a tab that
  navigated during the gap loses its handle. Two browsers sharing a copied profile share one
  instance id: the newer connection wins, and the other waits for **Reconnect**.
- **Other new handles.** A prerender activation gives the tab a new handle. A `tabs.remove` that
  races a `beforeunload` prompt can re-register the tab under a new handle.
- **HAR entries.** A pinned HAR entry stays used up when its fulfilment failed and the request then
  went to the live server; it is put back only when the request was cancelled.
- **Popup locale.** A cross-site `window.open` popup gets its locale when its document commits, so
  its very first script can see the browser's default.
- **Calibrated profiles do not flow back.** A profile fitted by `calibrate_humanize` on a launched
  engine is not installed into the extension's store.
- **Handoff reloads the page.** In-memory state, IndexedDB and service-worker state do not travel.
- **Chrome for Testing flakes.** In round 3, the first snapshot right after `popout` came back
  without the page once in 11 runs, and an identical signature replay failed once in 14. Both have
  mitigations, and a later 20 of 20 runs were clean, but neither is proven fixed.

**Stealth**

- Headless is detectable ([above](#stealth-what-was-measured)).
- Engine 1 is stealth input rules only.
- A `human`-level full-page screenshot visibly resizes the viewport. The result discloses it
  (`pageSaw`), and `stealth` refuses the capture.

**Platform and delivery**

- Measured on Windows 11 only.
- The HTTPS proxy tunnel for the Chrome for Testing download is untested, and so is the zip64 path.
- No Firefox, Safari or Lighthouse. Device emulation is not a real device.
- The installer is unsigned. The updater has been tested only against a fake.
- Installing an app update while AI clients run shims as `G9.exe` may close those shims
  mid-session. This is an open design issue.

**Re-run on the 2.0.1 tree (2026-09-23):** every suite above, including bench, the
10-minute endurance run, the full matrix state set, the stealth matrix with the public detector
pages, headed Chrome for Testing and the desktop render check. The timing suites (bench, matrix,
endurance and the cadence A/B) ran on the tree as it stood about ninety minutes before the end; only
the version string and comments changed after them.

**Not measured at all:**

- a locked session;
- another virtual desktop;
- on-screen headed windows;
- display scaling above 100%;
- runs longer than 10 minutes.

What is still open — the v1 backlog items EXT-01 … EXT-17 and the owner's open decisions — is in
[AIGuide.md](AIGuide.md) §8.5 and §8.6. The full architecture record is [AIGuide.md](AIGuide.md).

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Every tool fails with *"Port 8765 is held by a G9 v1 bridge (pid N)"*, or the panel says the address *"is held by a G9 v1 bridge"* | A v1 bridge from before the upgrade is still running. Close the editor or MCP client that started it (or end node process N), then restart your AI client; the v2 shim starts the daemon itself. Then press **Reconnect now** in the panel. Or give v2 another port: `G9_PORT` in the MCP entry, and the same port in the panel's daemon address. G9 never connects to or closes the v1 bridge for you. |
| Panel says the daemon refused the extension, or `browser_status` reports a version mismatch | The browser still runs an older extension build. Press **Reload** on the G9 card in `edge://extensions` or `chrome://extensions`, or use Engines → **Reload** / **Update and reload** in the desktop app. The panel badge shows the running version. After `git pull`, always reload. |
| Refused at stealth, or warned, because *the profile is signed in to a browser account* | This profile was signed in, usually by an early v2 build that did not yet block Edge's implicit sign-in. G9 cannot sign it out. Warm it (`browser_engine action:"warm"`) and sign out from the profile menu, or delete the profile and use a new one. **Test browsing done in such a profile may already be in that Microsoft account's synced Edge history.** How to check and clean up: [docs/INSTALL.md](docs/INSTALL.md#edge-implicit-sign-in). |
| Windows Defender Firewall asks "Allow access?" for a `chrome.exe` under `G9_HOME\engines\cft-<version>\` | Chrome for Testing is an unpacked zip, so no installer registered a firewall rule for it. Windows may ask once per new path (a new CfT version or a new `G9_HOME`). **Either answer is fine:** G9 drives the browser over a pipe, not a port, and the prompt concerns inbound connections only. The first launch from a new path carries a launch warning that says so (`engine/firewall.js`). The rules found on the test workstation, and how to list stale ones: [docs/INSTALL.md](docs/INSTALL.md#windows-firewall-and-chrome-for-testing). |
| Windows Defender Firewall asks about `node.exe` | Probably `node setup/serve.mjs`: the test-page server listens on all interfaces (`0.0.0.0`), so `localhost` and `127.0.0.1` can serve as two origins for the cross-origin frame fixture. The daemon itself binds `127.0.0.1` only and needs no exception. Declining keeps other machines out. |
| SmartScreen: "Windows protected your PC" on `G9-Setup-<version>.exe` | The installer is not code-signed. Choose **More info** → **Run anyway** if you trust the build's source. For a fleet, sign the installer. |
| Agent shows no `browser_*` tools | The MCP config path is wrong, or the client was not restarted. MCP servers load at client start. |
| *"No tab to act on"* | Open one (`browser_tabs action:"open"`), attach one (`browser_tabs action:"attach"`), or press **Record from now** in the panel on the tab you want. |
| *"Tab 7 is owned by agent-2 (cursor)"* | Another agent claimed it. Ask it to release the tab, or use `browser_tabs action:"claim" force:true` when the user asks (logged). |
| Everything fails with *"The user pressed Stop…"* | Stop is engaged. Press **Resume** in the side panel or the desktop app. Agents cannot. |
| `[delivery: not-delivered; tab hidden]` | The Engine 1 tab is not showing: a background tab, a minimized window, or an occluded window without the occlusion policy. Use `browser_tabs action:"focus"` (it takes the screen), `"popout"`, or `"handoff"`. |
| **Pop out tab** or `browser_tabs action:"popout"` moved the tab, but no window is on screen, or the result says `visible:false` | The new window is behind another window. An agent's popout opens unfocused so that you keep the keyboard, and on Windows a window that is covered completely stops rendering (unless the `WindowOcclusionEnabled` policy is off, [docs/INSTALL.md](docs/INSTALL.md#background-policies-hkcu)). Bring it forward: click it in the taskbar, or `browser_tabs action:"focus"`. The side panel's **⧉ Pop out tab** opens the window in front; before 2.0.3 it opened it behind your own window. |
| `[delivery: missed; hit <…>]` | Something covered the element or moved it. The action was not repeated. Take a new snapshot and check the page before retrying. |
| `browser_network` shows 0 requests | Capture starts when the tab is attached. Reload the page and read again, or press **Record from now** with **reload to capture page load** ticked. |
| Auto-attach is on **Project sites** but a tab on your site shows no capture, and the panel says *"No project sites known yet"* | Project sites are the hosts of the `environments` URLs in the `g9.project.json` of a CONNECTED agent. No agent is connected, or its project folder has no `g9.project.json`, or that file names no environment URL. Start the agent in the project folder, or add the environment, or switch to **All tabs** for now. If the panel says *"The running daemon (v2.x) is too old"*, restart the daemon ([Upgrading from 2.x to 3.0](#upgrading-from-2x-to-30)). |
| An alert above the panel tabs says an agent *"cannot reach"* a tab | The agent's input was refused because that tab is hidden (a background tab or a minimized window). **Pop out** gives it its own window in front; **Send to background** continues it in a browser G9 launches, headless by default (the page reloads there with its cookies and storage; in-page state that was never saved stays behind); **Dismiss** only hides the alert. The alert also goes by itself when the tab is shown again, the agent's input gets through, the tab closes, the agent disconnects or the daemon link drops. |
| A call fails after 120 s: *"… may STILL be running on this tab … Likely causes: the page is stuck loading, … or a JavaScript dialog G9 did not see is open"* | Take a `browser_snapshot` before sending that tab more input. Check `browser_status` for dialogs (`browser_dialog` clears them), for a hidden tab, and whether the page is still loading. The causes are a guess, and the action may still have run: verify before repeating it. |
| *"Tab N is in a browser whose G9 extension is reconnecting"* | The extension's service worker restarted or the extension reloaded. Its tabs are kept for 10 minutes; wait for the reconnect. |
| A headed launched browser is extremely slow | Its window is minimized (`browser_status` warns). Restore it, or run headless. |
| `ERR_CONNECTION_REFUSED` in the extension's Errors page | Expected while no daemon runs. The browser logs failed WebSocket attempts itself, and the extension retries with backoff. An agent call or the desktop app starts the daemon. |
| Page console is "unavailable" in `browser_console` | The tab is at stealth, where the Runtime domain is never enabled. This is by design. |
| Full-page screenshot refused | At stealth, a page taller than the viewport cannot be captured without a visible resize. Take viewport shots. |
| The desktop app opens no window from a terminal | The shell exports `ELECTRON_RUN_AS_NODE=1`. Use `npm start`, which clears it. |
| Chrome for Testing download fails with HTTP 403 | `storage.googleapis.com` refused this location over IPv4 on the build network. `cft.js` retries over the other address family. Otherwise set `HTTPS_PROXY` or pre-seed the cache. |

---

## Tests

### Choosing what to run

Run what the change needs. `npm run check` finds the changed files (`git status`), runs only the
checks that load or read them, 4 at a time, and prints a line every 15 s saying what is running, so
a slow check and a stuck one look different:

```powershell
npm run check                      # what the working tree's changes need
node setup/check.mjs --plan        # the plan and an estimate; runs nothing
node setup/check.mjs --since HEAD~3 # what the last three commits need
npm run check:all                  # every offline check, 4 at a time
npm run check:release              # every offline check and both live suites
```

Measured on 2026-09-25 (20 threads):

| Change | What runs | Time |
|---|---|---|
| a guide (`*.md`) | the link check | ~0.2 s |
| the side panel's HTML, CSS or scripts | the panel suite and the panel render | ~20 s |
| a module the tools share (`extension/lib`, `extension/tools`) | every offline suite that loads it; the output names the live suites to run | up to ~2.5 min |
| a file no check reaches | every offline check, and it says which file caused that | ~2.5 min |
| `--all` | every offline check | 142 s (the same checks one after another: ~300 s) |
| live suites (`--live`, or `npm run test:engine2` / `test:live`) | only when `check` names them (input, perception, launching, the seam) and before a release | ~5.5 min + ~3.5 min |

Build the installer (`cd desktop; npm run build:win; npm run test:packaged`) only for a change in
`desktop/` or a build someone will install. How the plan is made, and what it cannot know:
[AIGuide §7.0](AIGuide.md#70-choosing-what-to-run-since-301).

### Every suite

```powershell
npm test                  # = setup/unittest.mjs + setup/selftest.mjs + setup/extensiontest.mjs, one after another
npm run test:engine2      # Engine 2 end to end through the product path (headless Edge)
npm run test:live         # isolated Engine 1 live test: private daemon, temp profile, extension copy, headless Edge
npm run test:stealth      # stealth self-test (add -- --local-only for no network, -- --matrix for the full matrix)
npm run matrix            # the window-state matrix (opens headed windows off-screen only)
npm run bench             # parallelism benchmark; recommends maxParallel
npm run endurance -- --minutes 10
cd desktop; npm test; npm run test:daemon; npm run test:render; npm run build:win; npm run test:packaged
```

What each test does:

- **`unittest.mjs`** runs every `setup/unit/*.test.mjs` in its own process. A few `live:` tests
  launch the installed Edge, Chrome or Chrome for Testing headless on a temporary profile;
  `G9_UNIT_NO_BROWSER=1` skips them. It also runs `desktop/test` when `desktop/node_modules`
  exists.
- **`selftest.mjs`** starts the real `g9d` on a random private port with a temporary `G9_HOME`. It
  speaks MCP to the real shim, and connects a fake extension over a real WebSocket.
- **`extensiontest.mjs`** runs the extension's modules through the real platform seam over a
  `chrome` stub.
- **The live harnesses** check what the page, the server or the disk actually saw, never only the
  tool's own report.

**Safety rules every harness follows:**

- random ports in 18000–18999, never 8765;
- a temporary `G9_HOME` and temporary profiles;
- headed windows only off-screen, without activation;
- cleanup of every process they started.

`setup/serve.mjs` also serves `/hang` (accepts, never answers) and `/slow?ms=`.

**Latest recorded results.** Rows marked 3.0.0 were run on 2026-09-25 on the 3.0.0 tree. The
others were run on 2026-09-23 on the 2.0.1 tree and not repeated since: 2.0.2 changed replay,
evidence pruning, launched-engine watch ordering and browser shutdown, 2.0.3 the popout, and 3.0.0
the side panel and what the daemon and extension tell it, none of which those rows measure
differently.

| Suite | Result |
|---|---|
| `unittest.mjs` (3.0.0) | 638 tests in 11 suites passed (desktop 181, daemon 100, panel 82, interaction 77, engine 56, humanize 51, platform-cdp 34, world 26, seam 16, version 8, sites 7) |
| `selftest.mjs` (3.0.0) | 136/136 |
| `extensiontest.mjs` (3.0.0) | 82/82 |
| `panel-render.mjs` (3.0.0) | passed: 26 screenshots (every tab, empty states, an issue's detail; 360 and 1000 px; light and dark), no page error, no horizontal overflow at 360 px, no fixture text turned into markup, no `[object Object]` or `NaN`, a malformed stored flow opens, ArrowLeft in Auto-attach does not switch the mode |
| `desktop`: `test/run.mjs`, `daemon-contract.mjs`, `test:packaged`, `test:render` | 14/14 files (3.0.0), 15/15 (2.0.1), 7/7 (3.0.0, on `G9-Setup-3.0.0.exe`), render check passed (2.0.1; 4 scenarios, 0 windows on screen, 0 in the foreground) |
| `engine2-livetest.mjs` (3.0.0) | 366 passed, 0 failed (327 s) |
| `isolated-livetest.mjs` (headless) | Edge 198 passed, 0 failed (3.0.0, the real popout included; daemon, extension and shim all report 3.0.0); Chrome 196 passed, 0 failed (2.0.1). Harness checks all pass: the tripwire recorded 0 connections to the default port, and neither test profile was ever signed in. |
| `matrix.mjs` | exit 0 — every cell of both engines, both browsers, every state agrees with the page |
| `bench.mjs` / `endurance.mjs --minutes 10` | 0 failures at 1/4/8/16 contexts, recommendation maxParallel 8; 93 iterations, 0 failures, listeners flat |
| `stealthtest.mjs --matrix` | 7 configurations, 0 G9 leaks at stealth, headed Edge undetected on the local page, both human controls detected (exit 1 by design while headless is detectable) |

On the round before the final one, the Engine 1 live test also passed:

- Edge: 9 of 9 runs;
- branded Chrome 153.0.8010.53: 7 of 7;
- Chrome for Testing: 4 of 5 (the popout flake).

After the final fixes, the Chrome for Testing popout and replay sections passed 20 of 20.

---

## Repo layout

```
g9-browser-agent/
├── extension/                Engine 1 (MV3 extension) and the home of the shared tool layer
│   ├── manifest.json         version 3.0.0, Chrome/Edge 125+
│   ├── sw.js                 service worker: daemon link, panel commands, tool calls via tools/index.js
│   ├── tools/                the tool modules BOTH engines run; index.js = TOOLS + runTool, events.js = CDP fan-out
│   ├── humanize/             pure human-input library: plans, profiles, seeded PRNG, calibration
│   ├── lib/                  platform seam (platform.js → platform-extension.js | platform-cdp.js), cdp, world
│   │                         (isolated world), pointer, screencast, humanize (dispatcher), refs, locators,
│   │                         flowspec, signature, visual, store, state, transport
│   └── panel/                side panel, welcome page, About
├── engine/                   Engine 2: find, cft (+ versions.json pin), launch, pipe-cdp, profile, stealth, firewall, manager
├── daemon/                   g9d: ws-server, registry (agents, handles, ownership, queues, halts), router,
│                             handoff, evidence, scheduler, storage, settings, paths, home-lock (one daemon per
│                             G9_HOME), project, flows, extension-update
├── mcp/                      shim.mjs (what AI clients launch), mcp.js, tools.js (the 15 schemas + agent instructions)
├── lib/                      version.mjs, ws-client.mjs, ws-codec.mjs — shared, zero-dependency
├── runner/                   g9.mjs (unattended CLI), mcp-client.mjs, report.mjs, drivers/ (AgriPad)
├── desktop/                  Electron shell: views, wizard, installer, updater; its own tests in desktop/test
├── bridge/src/server.js      v1 entry point, kept only as a forwarder to mcp/shim.mjs
├── setup/                    install.ps1; unittest.mjs + unit/, selftest, extensiontest; live harnesses
│                             (isolated-livetest + livetest, engine2-livetest, stealthtest, matrix, bench,
│                             endurance); panel-render (the v3 panel in pictures); check + check-plan (only the
│                             checks a change needs), doclinks, make-icons.ps1; serve.mjs, testpage.html, fixtures/
├── docs/                     ARCHITECTURE_V2 (binding contracts), DAEMON_PROTOCOL, HUMANIZE, STEALTH, INSTALL (operators)
├── scripts/                  standalone example automations (documented against v1.7.21, not re-verified on v2)
├── g9.project.example.json   project adapter template — belongs in the repo under test, not this one
├── package.json              the one version for the whole product; npm scripts
├── AIGuide.md                design decisions, build log and architecture reference
└── README.md                 this file
```

G9 is independent of any project it tests. It sees only the browser, never whether the page behind
it is ASP.NET, React or PHP. Keep it as its own repository and use it across projects.

---

## Changing this codebase

> **Every change must also update [`AIGuide.md`](AIGuide.md).** It is the durable record of what
> exists, why it was built that way, and what is deliberately absent. An AI agent or a new teammate
> reads it before touching this code. A change that is not recorded there did not happen.

1. **Make the change.**
2. **Log it.** Add an entry to the **Change log** in AIGuide.md
   ([§9](AIGuide.md#9-change-log)): the date, what changed, why, and the bugs found on the way.
3. **Update the documents it touches, in the same change set:**
   - the affected AIGuide sections;
   - [docs/ARCHITECTURE_V2.md](docs/ARCHITECTURE_V2.md) for module boundaries and signatures (it is
     binding);
   - [docs/DAEMON_PROTOCOL.md](docs/DAEMON_PROTOCOL.md) for anything on the wire;
   - [docs/STEALTH.md](docs/STEALTH.md) and [docs/HUMANIZE.md](docs/HUMANIZE.md) when their
     behaviour changes;
   - this README.
4. **Bump the version.** There is one version string, the root `package.json` version.
   `extension/manifest.json`, `desktop/package.json` and `desktop/package-lock.json` must equal it;
   `setup/unit/version.test.mjs` fails otherwise. Every change that ships bumps it (decision D12).
   The side panel's badge is how a person confirms the reload took.
5. **Adding a tool** takes all of these:
   - its entry in `TOOLS` in `extension/tools/index.js`, or in `daemon/router.js` for a
     daemon-answered tool such as `browser_engine`;
   - its schema in `mcp/tools.js`;
   - its read-only classification (`isReadOnly`), which ownership and queues depend on;
   - its deadline in `timeoutFor` if it can run long. `desktop/lib/daemon-client.mjs` mirrors that
     table, and `daemon.test` checks the two agree.
   - the tools table in this README, and AIGuide's tool reference;
   - the count in `setup/selftest.mjs` (`=== 15`). Update the assertion last, on purpose.
6. **Rules to keep:**
   - Code in `extension/tools/`, `extension/humanize/` and the shared `extension/lib/` files uses
     no `chrome.*`, no `node:` imports and no other platform API (IndexedDB, OffscreenCanvas, …).
     It goes through `platform.js`, and `seam.test.mjs` checks this.
   - No npm dependencies outside `desktop/`.
   - G9's own page code runs only in the isolated world `g9`, the one exception being
     `browser_console evaluate`. The live tests compare the page's main world before and after.
   - No test touches port 8765 or a person's profile.
7. **Run the tests for what you changed:**

| You changed | Run at least |
|---|---|
| anything | `npm test` |
| `daemon/`, `mcp/`, `lib/`, `engine/` | + `npm run test:engine2` |
| `extension/` (tools, lib, panel, `sw.js`) | + `npm run test:live` and `npm run test:engine2` |
| input, humanize, stealth, `engine/launch.js` | + `npm run test:stealth -- --local-only` and `npm run matrix` |
| the gate, queues, evidence, watch | + `npm run bench` and `npm run endurance -- --minutes 10` |
| `desktop/` | `cd desktop; npm test; npm run test:daemon; npm run test:render` |
| anything the installer packages (`extension/`, `engine/`, `daemon/`, `mcp/`, `runner/`, `lib/`, `package.json`) | `cd desktop; npm run build:win; npm run test:packaged` |

**Do not simplify past a measured fact without recording why.** Many of the rules above were learned
the hard way:

- a hidden tab silently drops input;
- a fresh Edge profile signs itself in;
- a page-opened popup wedges its opener unless targets are held.

Each is written down in AIGuide.md, STEALTH.md or engine/README.md with its numbers.

## License

Internal G9 tooling.
