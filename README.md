# G9 Browser Agent

**Let your AI agent use a real browser — your own, or one it starts in the background — to test,
debug and automate web apps. Every click is visible, recorded and replayable.**

[فارسی](README.fa.md) · [Download](https://github.com/ImanKari/G9BrowserAgent/releases/latest) ·
[Technical reference](docs/REFERENCE.md) · [Operator guide](docs/INSTALL.md) · MIT license

![The G9 side panel next to the Demo Shop, after an agent recorded a checkout flow](docs/assets/panel-session.png)

---

## Contents

- [What G9 is](#what-g9-is)
- [How the parts fit together](#how-the-parts-fit-together)
- [Supported systems](#supported-systems)
- [Install](#install)
- [First-time setup](#first-time-setup)
- [Add the extension to your browser](#add-the-extension-to-your-browser)
- [Connect your AI client (MCP)](#connect-your-ai-client-mcp)
- [Your first session](#your-first-session)
- [The side panel](#the-side-panel)
- [The desktop app](#the-desktop-app)
- [How an agent drives the browser](#how-an-agent-drives-the-browser)
- [Browser profiles](#browser-profiles)
- [Updates](#updates)
- [Troubleshooting](#troubleshooting)
- [Uninstall and reset](#uninstall-and-reset)
- [For developers](#for-developers)
- [Security and privacy](#security-and-privacy)
- [Known limitations](#known-limitations)

---

## What G9 is

AI coding agents (Claude Code, Cursor, VS Code, Claude Desktop and others) can write a web app, but
they cannot *see* it. G9 gives them a browser they can use the way a person does: open a page, read
it, click, type, scroll, check the console and the network, take screenshots, and record what they
did so it can be replayed later as a test.

What makes it different:

- **Your own browser, or a background one.** An agent can work in the Edge or Chrome you are using
  (with your logins), through a small extension. Or it can start its own browser in the background —
  no window, nothing on your screen to disturb — for long or unattended runs.
- **Input like a person's.** Mouse paths curve, clicks have a natural rhythm, typing has a pace. Pages
  react as they would to a real user, and a seed makes a run repeatable.
- **Tests that survive a redeploy.** A recorded flow remembers every element in several ways, so a
  changed CSS class does not break it. A replay says *which* way still matched, and what was new or
  missing compared with the last approved run.
- **Evidence.** Screenshots, console, failed requests, the DOM, and a frame-by-frame replay with the
  cursor drawn in. Filing an issue captures all of it in one click.
- **Many agents, one browser layer.** One small background service (the *daemon*) serves every agent
  on the machine. Each tab has one owner at a time, and a **Stop** button halts everything at once.

G9 runs entirely on your machine. It sends nothing anywhere; the only network access it needs is to
the pages you test (and, when you ask for it, the Chrome for Testing download and the update check).

## How the parts fit together

```
 Your AI client (Claude Code, Cursor, …)
        │  MCP (the standard way AI clients use tools)
        ▼
 G9 MCP shim ──────┐
 G9 desktop app ───┤  WebSocket, on this machine only (127.0.0.1:8765)
 G9 runner (CLI) ──┤
                   ▼
            G9 daemon (g9d) ─────────────► Engine 2: a browser G9 starts itself
                   │                        (Edge, Chrome or Chrome for Testing; headless by default)
                   └─────────────────────► Engine 1: the G9 extension in YOUR Edge or Chrome
```

| Part | What it is | Do you need it? |
|---|---|---|
| **Desktop app** | The G9 program you install. It sets everything up, shows what agents are doing, and keeps G9 up to date. | Recommended. It carries its own runtime: no Node.js needed. |
| **Daemon** | A background process that owns every browser and tab. Starts by itself when needed, stops by itself after an hour of doing nothing. | Always — but you never start it by hand. |
| **MCP shim** | The small program your AI client launches to get G9's 15 browser tools. It starts the daemon if it is not running. | Yes, for AI agents. The desktop app registers it for you. |
| **Extension** | Lets agents work in the browser you use (Engine 1), with your logins. Also gives you the side panel. | Optional. Without it, agents use a browser G9 starts (Engine 2). |
| **Runner** | A command-line tool that replays recorded flows unattended, e.g. on a schedule or in CI. | Optional. |

## Supported systems

| System | Package | Updates |
|---|---|---|
| Windows 10 / 11 (x64) | `G9-Setup-<version>.exe` — installs for your user only, no administrator rights | **Automatic** |
| macOS 12 or newer, Apple silicon | `G9-<version>-mac-arm64.dmg` | G9 tells you, you install ([why](#updates)) |
| macOS 12 or newer, Intel | `G9-<version>-mac-x64.dmg` | G9 tells you, you install |
| Linux x64, any distribution with a desktop | `G9-x86_64.AppImage` | **Automatic** |
| Debian / Ubuntu x64 | `G9_<version>_amd64.deb` | G9 tells you, you install |

Browsers: **Microsoft Edge** or **Google Chrome** 125 or newer, or the pinned **Chrome for Testing**
that G9 can download for you. Firefox and Safari are not supported.

G9 was built and measured mostly on Windows 11. The macOS and Linux packages are built, tested and
update-tested automatically on every release (see [Known limitations](#known-limitations)).

---

## Install

Download the file for your system from the **[latest release](https://github.com/ImanKari/G9BrowserAgent/releases/latest)**.

> The packages are **not code-signed** yet, so Windows and macOS ask once before the first start.
> That is expected; the steps below say what to click. Each release lists the SHA-256 of every
> file, if you want to check your download.

### Windows

1. Run `G9-Setup-<version>.exe`.
2. If **"Windows protected your PC"** appears: click **More info**, then **Run anyway**.
3. G9 installs to `%LOCALAPPDATA%\Programs\G9` and starts. No administrator rights are needed.

### macOS

1. Open the `.dmg` for your Mac (`arm64` for Apple silicon — M1 and newer — `x64` for Intel).
2. Drag **G9** into **Applications**. Start it from Applications, not from the disk image — otherwise
   macOS runs it from a temporary copy, and your AI clients could not find it later.
3. The first time, macOS says it *"cannot check G9 for malicious software"*. Right-click (or
   Control-click) G9 in Applications → **Open** → **Open**. (Or: System Settings → Privacy & Security
   → **Open Anyway**.)
4. If macOS says G9 *"is damaged"*, the download was quarantined. Run this once in Terminal:
   `xattr -dr com.apple.quarantine /Applications/G9.app`

### Linux — AppImage (any distribution)

1. Put `G9-x86_64.AppImage` wherever you keep programs (for example `~/Applications`).
   **Keep the file name as it is**: updates replace this exact file, and your AI clients point at it.
2. Make it executable and start it:
   ```bash
   chmod +x G9-x86_64.AppImage
   ./G9-x86_64.AppImage
   ```
3. If it says *"AppImages require FUSE to run"*: `sudo apt install libfuse2` (on Ubuntu 24.04:
   `sudo apt install libfuse2t64`).

### Linux — .deb (Debian, Ubuntu)

```bash
sudo apt install ./G9_<version>_amd64.deb
```

G9 appears in your applications menu; it installs to `/opt/G9`, and the command is `g9`.

---

## First-time setup

On its first start, G9 opens **Setup**: five steps, each with **Mark as done** and **Skip**, and you
can come back to it any time from the sidebar.

![The Setup view](docs/assets/desktop-setup.png)

1. **Browsers** — lists the Edge and Chrome G9 found. **Install Chrome for Testing** downloads the
   pinned version G9 was tested with (about 200 MB, checked against a known SHA-256). A pinned
   browser never updates under you, so today's run and next month's run use the same browser.
   Optional: G9 works with the Edge or Chrome you already have.
2. **Automation profile** — background runs use their own browser profile, never yours. Open it
   once, sign in to the app you test, and close the window: later runs start signed in.
3. **Background policies** (Windows only) — a browser stops drawing a window that is covered, and then
   quietly drops input. These optional per-user settings keep your own browser drawing, so agents can
   work in it while you do something else. G9 records the old values first, and **Undo** restores
   them. On macOS and Linux there is nothing to set; the step says so.
4. **AI clients** — registers G9 with the AI clients it finds (Claude Code, Cursor, VS Code, Claude
   Desktop). It shows the change first, backs up each settings file, and can **Remove** it again.
5. **Browser extension** — copies the extension to G9's data folder and walks you through loading it
   once (next section).

After Setup, **restart your AI client** so it loads the new tools.

## Add the extension to your browser

This is optional — agents can always use a browser G9 starts — but it is what lets an agent work in
**your** browser, with your logins, and it gives you the side panel.

1. Open `edge://extensions` (Edge) or `chrome://extensions` (Chrome).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the folder G9 prepared (Setup put the path on your clipboard):

   | System | Folder |
   |---|---|
   | Windows | `%LOCALAPPDATA%\G9\extension` |
   | macOS, Linux | `~/.g9/extension` |
   | From the source code | `<repository>/extension` |

4. Pin the G9 icon to the toolbar, and click it to open the side panel.

Leave the folder where it is: the browser knows the extension by its folder. G9 refreshes that
folder when it updates, and the extension reloads itself, so you do this only once. (Browsers do not
allow extensions outside their store to install themselves; that is why this one step is manual.)

## Connect your AI client (MCP)

**Setup → AI clients** does this for you. To do it by hand, add an MCP server called `g9-browser`
to your client's settings. From the desktop app, the entry runs G9's own executable in Node mode:

```json
{
  "mcpServers": {
    "g9-browser": {
      "command": "C:/Users/<you>/AppData/Local/Programs/G9/G9.exe",
      "args": ["C:/Users/<you>/AppData/Local/Programs/G9/resources/mcp/shim.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

| System | `command` | `args` |
|---|---|---|
| Windows | `…/Programs/G9/G9.exe` | `…/Programs/G9/resources/mcp/shim.mjs` |
| macOS | `/Applications/G9.app/Contents/MacOS/G9` | `/Applications/G9.app/Contents/Resources/mcp/shim.mjs` |
| Linux .deb | `/opt/G9/g9` | `/opt/G9/resources/mcp/shim.mjs` |
| Linux AppImage | the `.AppImage` file | `~/.g9/bin/g9-run.mjs`, `mcp/shim.mjs`, `--no-sandbox` (Setup writes this for you) |
| From source | `node` | `<repository>/mcp/shim.mjs` (no `env` needed) |

Where each client keeps its settings: Claude Code `~/.claude.json` (or `claude mcp add`), Cursor
`~/.cursor/mcp.json`, VS Code `Code/User/mcp.json` in your user settings folder (the key there is
`servers`), Claude Desktop `Claude/claude_desktop_config.json` in the same folder. The side panel's
**Connect your agent → copy config** gives you the entry too.

Restart the AI client afterwards: clients load MCP servers only when they start.

---

## Your first session

1. Open the page you want to test in Edge or Chrome, and open the G9 side panel.
2. Ask your agent, in plain words. For example:
   - *"Check this page for problems."*
   - *"Log in as the test user and confirm the orders list loads."*
   - *"Why does the Save button do nothing?"*
   - *"Record a checkout flow on the Demo Shop, and add a check that the order number appears."*
3. The agent takes the tab you are looking at, and you watch it work. The panel shows each action as
   it happens.

No extension? Ask the agent to open a URL: G9 starts a browser in the background and works there.
The desktop app's **Watch** view shows you what it sees.

![The Demo Shop, after the agent placed an order](docs/assets/demo-shop.png)

*The Demo Shop used for these pictures is a made-up page in this repository
(`setup/fixtures/demo-shop.html`); `node setup/serve.mjs` also serves a test page full of
deliberate bugs to find.*

---

## The side panel

Click the G9 icon in the toolbar. The header always shows the version badge (click it for
**About**), **↗** (open the panel in its own window) and **Stop**, which immediately blocks every
agent action — in this browser and in the daemon — until you press **Resume**.

### Session

<img src="docs/assets/panel-session.png" alt="Session tab" width="320" align="right">

- **Daemon status**, with a coloured dot:
  - **Daemon connected** (green) — the address, and which engine this browser is (`engine-1`).
    A `g9d vX` pill shows the daemon's version; if it differs from the extension's, a warning says
    which one to update.
  - **Connecting…** (amber) — looking for the daemon.
  - **Daemon offline** — nothing is running yet. That is normal: your AI client starts the daemon
    when it connects, and the desktop app keeps it running. The extension retries by itself
    (*"next try in N s"*); **Reconnect now** tries at once.
  - **Daemon refused this extension** / **Port taken by a v1 bridge** — with the reason and the fix;
    **Try again** after fixing it.
  - **settings** changes the daemon address, if you moved it off port 8765.
- **Agents** — every connected agent, its project, and the tab it is on (click to bring it forward).
  **Engines** lists the browsers G9 is driving.
- **Current tab** — its title and address, whether console and network are being recorded, and the
  error / warning / request counts. **Record from now** starts capturing on this tab before any agent
  does; tick **reload to capture page load** to catch problems during loading. **Detach all** releases
  every tab.
- **Auto-attach** — which tabs are captured from their first load: **Off**, **Project sites** (the
  default: the sites in the connected agents' `g9.project.json`) or **All tabs**.
- **Keep working elsewhere** — **Pop out tab** moves the tab into its own window (keep that window
  visible), **Send to background** continues it in a browser G9 starts (the page reloads there with
  its cookies).
- **Input** — **Direct** (instant and exact), **Human** (the default: curved mouse paths, natural
  clicks and typing) or **Stealth** (human input with no scripted shortcuts).
- **Connect your agent** — the MCP entry to copy. **Activity** — every agent action, live.

<br clear="right">

### Automation

<img src="docs/assets/panel-automation.png" alt="Automation tab" width="320" align="right">

- **Start recording** — do the flow yourself; every click, entry and selection is stored with
  several ways to find the element again.
- **Flows** — grouped by site, then suite, with filters (site, suite, tag, last verdict, flaky, text).
  **Run N flows** replays what the filter shows, one tab at a time (`@manual` flows are skipped).
- Open a flow for replay, dry run, adding checks, approving its "known world", history, export (a
  Playwright test or a Git-friendly FlowSpec), and its name, suite and tags.
- **Repository** — **Pull from repo** / **Push all to repo** keep flows in your project's folder.

<br clear="right">

### Issues

<img src="docs/assets/panel-issues.png" alt="Issues tab" width="320" align="right">

- **New issue** captures the screenshot, address, console, failed requests and the DOM *the moment
  you press it* — while the bug is on screen. You write it up afterwards.
- Issues are grouped by site, then Open / Filed / Closed, with severity, age, tracker key and chips
  for the evidence they hold. Agents can file issues too (`browser_issue`).

<br clear="right">

### About

<img src="docs/assets/panel-about.png" alt="About tab" width="320" align="right">

The extension's version (and the one before it), the browser, the daemon's version and process, the
connection, and this browser's engine id. **Copy details** puts all of it on the clipboard for a bug
report; **What's new** shows the change notes. After an update, a notice at the top of the panel says
so once.

<br clear="right">

---

## The desktop app

The top bar always shows the daemon's status and **Stop all**; the tray icon has **Stop all** and
**Resume** too. The sidebar footer shows the update status.

![Agents](docs/assets/desktop-agents.png)

| View | What it is for |
|---|---|
| **Agents** | Who is connected, which tabs each one owns, **Halt** / **Resume** per agent, and a live log of every tool call. |
| **Engines** | Your browser (the extension) and the browsers G9 started, with their tabs. Launch a new one (browser, profile, human input, stealth, language, time zone, proxy, headless), **Stop** one, **Reload** (or **Update and reload**) the extension, and see every browser installed. |
| **Watch** | A live, view-only picture of any tab, with the agent's cursor drawn in. Works for headless browsers too. |
| **Runs** | Every replay: verdict, each step and which locator matched, warnings, "surprises" compared with the approved run, and a frame-by-frame replay you can export as a video. |
| **Approvals** | Runs that found something new. Approve it as the new normal, or leave it for a person. |
| **Schedule** | Run a suite daily or every N minutes, unattended. |
| **Settings** | Defaults for new runs, evidence limits, the daemon, updates, and "Start G9 when I sign in". |
| **Setup** | The first-time setup, any time. |

![Engines](docs/assets/desktop-engines.png)

![Watch](docs/assets/desktop-watch.png)

![Runs](docs/assets/desktop-runs.png)

![Settings](docs/assets/desktop-settings.png)

---

## How an agent drives the browser

Agents get **15 tools**. The ones they use most:

| Tool | What it does |
|---|---|
| `browser_status` | Where am I? The current tab and its health, engines, agents, and whether Stop is pressed. Agents call it first. |
| `browser_tabs` | List, open, close, focus, attach or claim tabs; pop out; hand off to a background browser. |
| `browser_snapshot` | Read the page as an accessibility tree, with a `ref` for each element to act on. |
| `browser_interact` | Click, double-click, right-click, hover, type, press keys, scroll, drag, select, upload — on a `ref`. |
| `browser_navigate` | Go to a URL, reload, back, forward, wait for a load state. |
| `browser_console`, `browser_network` | Read console messages and requests; record HAR; pin or intercept responses. |
| `browser_screenshot`, `browser_inspect`, `browser_diagnose` | Pictures, DOM / styles / storage / cookies, and health, performance and memory checks. |
| `browser_recording`, `browser_issue` | Record, replay and approve flows; file issues with evidence. |
| `browser_engine`, `browser_emulate`, `browser_dialog` | Start background browsers; emulate devices, networks and color schemes; answer dialogs. |

The full list, with every argument, is in the [technical reference](docs/REFERENCE.md#the-15-tools).

**Mouse and keyboard.** Input goes through the browser's own input pipeline (Chrome DevTools
Protocol), not through JavaScript events, so the page sees trusted events. At the default **Human**
level the pointer moves along a curved path with natural speed, a click has a press and a release,
wheel scrolling comes in notches, and typing has a rhythm. **Direct** sends exact, instant input.
**Stealth** adds rules for pages that look for automation. Every run has a seed, so the same seed
replays the same motion. Details: [docs/HUMANIZE.md](docs/HUMANIZE.md).

**Hidden tabs.** A browser does not deliver mouse input to a tab you cannot see (a background tab or
a minimized window). G9 notices, refuses the action instead of pretending, and the side panel offers
**Pop out** or **Send to background**. Background browsers (Engine 2) are headless and never have
this problem — use them for anything unattended.

**Sharing.** Each tab has one owner; changes on a tab run one at a time; other agents get a clear
"owned by" message. **Stop** blocks everything, and only a person can resume.

## Browser profiles

- **Your own profile** is used only by the extension, in your own browser. G9 never opens it from
  outside: Chrome and Edge protect it, and G9 refuses to launch on it.
- **Background browsers** use G9's own profiles, in `G9_HOME/profiles/<name>` (the default one is
  `automation`). Sign in there once (Setup step 2, or **Warm (open headed)** in **Engines**), and later runs
  start signed in. A profile keeps its logins on this machine only: browsers encrypt cookies per
  machine.
- G9 turns off browser sync and sign-in in its profiles, and warns if a profile is signed in to a
  browser account.

---

## Updates

| System | What happens |
|---|---|
| Windows, Linux AppImage | G9 checks the official releases when it starts and every 6 hours, downloads a new version in the background, verifies its SHA-512, and asks: **Install now**, **Install when I quit G9**, **Not now**, or **Skip this version**. |
| macOS, Linux .deb | G9 checks the same way and tells you a new version is out; **Open the release page** takes you to the download. (macOS installs updates by itself only into apps signed with an Apple Developer ID, which G9 is not yet; a .deb needs your password to replace.) |

- Nothing is interrupted: G9 installs only when no run is in progress and no background browser is
  open, and re-checks every minute until then.
- **The extension updates with the app.** After an update, G9 refreshes its extension folder and the
  extension reloads itself once no agent call is in flight. The side panel's badge shows the new
  version. If it ever does not, press **Reload** on the extension (or **Engines → Update and reload**).
- **Settings → Updates** has **Check now** and the update source: **official** (the default, nothing
  to set up), **custom** (your own `https://` folder with the same files), or **off**.
- Updating from source: `git pull`, then reload the extension in the browser.

## Troubleshooting

| Problem | What to do |
|---|---|
| The agent has no `browser_*` tools | Restart the AI client. Check its MCP settings (see [Connect your AI client](#connect-your-ai-client-mcp)). On macOS, make sure G9 runs from Applications. |
| The panel says **Daemon offline** | Normal until an agent connects or the desktop app runs. Start the desktop app, or send your agent any request. |
| The panel warns the daemon and extension versions differ | Press **Reload** on the G9 extension, or **Engines → Update and reload** in the desktop app. |
| Everything fails with *"The user pressed Stop"* | Press **Resume** in the side panel or the desktop app. Agents cannot resume on their own. |
| *"not delivered; tab hidden"* | The tab is in the background or minimized. Bring it forward, **Pop out** it, or **Send to background**. |
| *"Tab N is owned by another agent"* | Another agent is using it. Ask that agent to release it, or tell your agent it may take it over. |
| No requests in `browser_network` | Capture starts when the tab is attached. Use **Record from now** with **reload to capture page load**. |
| Windows Firewall asks about Chrome for Testing | Either answer is fine: G9 talks to the browser over a pipe, not the network. |
| macOS: *"cannot be opened"* or *"damaged"* | See [Install → macOS](#macos). |
| Linux AppImage does not start, or stops updating | Install `libfuse2`, `chmod +x` the file, and keep its name `G9-x86_64.AppImage`. |
| Settings → Updates shows an error | The check could not reach GitHub (offline, or a proxy or firewall in the way). G9 tries again in 6 hours; **Check now** tries at once. The status line says what failed. |

More, with the causes: [technical reference → Troubleshooting](docs/REFERENCE.md#troubleshooting).
G9's logs are in `G9_HOME/logs` (`daemon.log`, `desktop.log`, `install.log`).

## Uninstall and reset

Undo what G9 changed outside its own folders first, while G9 is still installed:

1. **Setup → Background policies → Undo** (Windows, only if you applied them).
2. **Setup → AI clients → Remove** for each client.
3. **Settings** → turn off **Start G9 when I sign in**.
4. Remove the G9 extension on your browser's extensions page.
5. **Engines → Stop** any running browser, then **Settings → Shut down daemon**.

Then remove the app:

- **Windows:** Settings → Apps → **G9** → Uninstall.
- **macOS:** drag **G9** from Applications to the Trash.
- **Linux AppImage:** delete the file (and `~/.config/autostart/g9.desktop`, if you enabled start at sign-in).
- **Linux .deb:** `sudo apt remove g9-desktop`.

Your data stays, on purpose — delete it by hand when you are sure (it holds your recordings, run
evidence and the background browsers' logins):

| System | G9's data (`G9_HOME`) | App settings |
|---|---|---|
| Windows | `%LOCALAPPDATA%\G9` | `%APPDATA%\G9`, and the update cache `%LOCALAPPDATA%\g9-desktop-updater` |
| macOS | `~/.g9` | `~/Library/Application Support/G9`, `~/Library/Caches/g9-desktop-updater` |
| Linux | `~/.g9` | `~/.config/G9`, `~/.cache/g9-desktop-updater` |

**To reset G9** without uninstalling it: shut down the daemon (step 5), then delete or rename
`G9_HOME`. The next start is a fresh install, and Setup runs again.

---

## For developers

G9's core is plain Node.js with **no npm dependencies**; only the desktop app (Electron) has any.

```bash
git clone https://github.com/ImanKari/G9BrowserAgent.git
cd G9BrowserAgent
npm test                    # unit tests, self-test and extension suite (Node 22+)
node setup/check.mjs        # only the checks your change needs
```

- **Use it from source:** point your MCP client at `node <repo>/mcp/shim.mjs`, and load
  `<repo>/extension` unpacked. On Windows, `setup\install.ps1` checks Node, runs the tests, and writes
  the MCP config for you. There is no service to start; `npm run daemon` runs the daemon in the
  foreground with its log on screen.
- **The desktop app from source:** `cd desktop && npm ci && npm start`.
- **Build the packages:** `cd desktop && npm run build:win` (or `build:mac`, `build:linux`) — each on
  its own system. The output, with its `latest*.yml` update metadata, is in `desktop/dist`, and
  `npm run verify:artifacts` checks every file against it.
- **Test the update end to end:** `node desktop/test/update-e2e.mjs --old <older build> --new desktop/dist`
  installs the older build, serves the new one from a local feed, and walks through download,
  corruption, interruption, skip, busy daemon, install on quit, restart and the extension refresh.

**Development vs. installed:**

| | From source | Installed app |
|---|---|---|
| Runs G9's scripts with | your `node` | the app's own executable (`ELECTRON_RUN_AS_NODE=1`) — no Node needed |
| Extension folder | `<repo>/extension` | `G9_HOME/extension`, refreshed on every update |
| Updates | `git pull`, reload the extension | automatic (see [Updates](#updates)) |
| The updater | shows *development build* and never checks | checks the official releases |

**Releases** come from the Azure DevOps pipeline (`azure-pipelines.yml`), the source of truth: it
runs every offline check on Windows and the portable suites on Linux and macOS, builds the packages
on each system, runs the real update test on each, verifies every file, and only then — from `main` —
tags the version, mirrors the repository to GitHub and publishes the GitHub Release.

Before changing the code, read [AIGuide.md](AIGuide.md) (design decisions and the change log) and
the [technical reference](docs/REFERENCE.md#changing-this-codebase). Every change is recorded in
AIGuide.md and bumps the version.

More documentation:
[technical reference](docs/REFERENCE.md) ·
[operator guide](docs/INSTALL.md) ·
[architecture](docs/ARCHITECTURE_V2.md) ·
[daemon protocol](docs/DAEMON_PROTOCOL.md) ·
[human input](docs/HUMANIZE.md) ·
[stealth](docs/STEALTH.md) ·
[desktop app](desktop/README.md) ·
[engine](engine/README.md)

---

## Security and privacy

G9 gives agents **full control of the browser tabs they use** — every page, cookie and login in that
browser. Treat it like an SSH key, and use it on machines whose users and software you trust.

- **Local only.** The daemon listens on `127.0.0.1`, never on your network. Web pages are refused:
  a page cannot connect to it, even one served from your own machine.
- **No token.** Any program running as a user on this machine can connect to the daemon. That is a
  deliberate choice for a trusted QA machine.
- **Nothing leaves your machine.** No telemetry, no accounts. Recordings, issues and evidence stay in
  `G9_HOME` and in the extension's storage. The only outside connections are the pages you test, the
  update check (GitHub) and, if you choose it, the Chrome for Testing download (Google).
- **Background browsers are separate.** They never open your profile, have sync turned off, and are
  driven over a pipe (no debugging port is open).
- **Stop is always there**, and agents cannot undo it.
- While the extension controls a tab, the browser shows *"started debugging this browser"*. That bar
  is the browser's own warning and cannot be hidden.
- The packages are not code-signed yet. Check the SHA-256 in the release notes if in doubt.

Details: [technical reference → Security and trust model](docs/REFERENCE.md#security-and-trust-model).

## Known limitations

- **Unsigned packages.** Windows SmartScreen and macOS Gatekeeper ask once. **macOS updates are
  installed by hand**, and so are .deb updates (G9 tells you when one is out).
- **Measured on Windows.** The detailed measurements (window states, timing, stealth) were taken on
  Windows 11. On macOS and Linux the automated suites and the update test run on every release, but
  the long live measurements were not repeated.
- **Windows-only extras.** The background policies that keep your own browser drawing when covered
  exist on Windows only. Everywhere, a minimized window or a background tab stops receiving input —
  use a background browser (headless) for unattended work.
- **x64 only** on Windows and Linux (no ARM builds there); macOS has both Apple silicon and Intel.
- **Edge and Chrome only.** No Firefox or Safari. Device emulation is not a real device.
- **Headless can be detected** by determined bot detectors; stealth reduces what G9 adds, but a
  headless browser still differs from a visible one.
- **Browser pages you cannot control:** `chrome://` / `edge://` pages, the web stores, and native
  dialogs (print, the file picker — use `upload` instead).
- **Updating while an AI client is using G9** may end that client's G9 tools until its next call.
- Not measured at all: a locked screen, another virtual desktop, display scaling above 100%, runs
  longer than 10 minutes.

The complete list: [technical reference → Limits and known gaps](docs/REFERENCE.md#limits-and-known-gaps).

---

## License

[MIT](LICENSE) © Iman Kari
