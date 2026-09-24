# G9 desktop

The G9 v2 desktop app: a tray icon, a window to watch and steer what the agents do, the first-run
setup, the installer and the updater. It is **the shell, never an engine** (plan D4, R5): Electron's
Chromium only ever shows this app's own screens. Pages under test run in real Edge, Chrome or Chrome
for Testing that the daemon (`g9d`) launches; the Watch view shows their screencast frames on a
`<canvas>` and draws the cursor from the pointer track. Nothing you click there reaches the page.

The app talks to the daemon exactly like an agent does, over one WebSocket
(`ws://127.0.0.1:${G9_PORT:-8765}/g9`, role `ui`, [DAEMON_PROTOCOL.md](../docs/DAEMON_PROTOCOL.md)).
If nothing listens it starts the daemon (packaged: `G9.exe` with `ELECTRON_RUN_AS_NODE=1` runs
`resources/daemon/g9d.mjs`; development: `node ../daemon/g9d.mjs`), detached, so the daemon keeps
serving agents after the window closes. If the port is held by something else, such as the v1
bridge, the app names it and leaves it alone.

## Run it

```powershell
cd desktop
npm install        # electron, electron-builder, electron-updater: the only npm dependencies in G9
npm start          # the app (scripts/start.mjs clears ELECTRON_RUN_AS_NODE first, see below)
npm test           # every test/*.test.mjs, plain node, no window, no browser, never port 8765
npm run test:daemon  # the live contract: this repo's real g9d on a temp G9_HOME and a port in 18000-18999
npm run test:packaged  # after build:win: dist/win-unpacked driven as a QA machine would (no Node needed)
npm run test:render  # the real window, off-screen: every view as PNGs in dark and light, for a person to look at
```

Latest recorded state (the dates and versions say which run):
- `npm test`: 14 of 14 files, 181 PASS lines (2.0.3, 2026-09-25; 176 on 2026-09-22);
- `test:daemon`: 15 of 15 (2.0.1, 2026-09-23);
- `test:packaged`: 7 of 7 (2.0.3, 2026-09-25, the build of `G9-Setup-2.0.3.exe`);
- `test:render`: 4 scenarios (empty and populated, dark and light), no problems reported, and no
  window ever on screen or in the foreground (2.0.1, 2026-09-23).

`setup/unittest.mjs` runs `npm test` as its `desktop` suite, and skips it with a message when
`desktop/node_modules` is missing.

`npm test` includes `test/views.test.mjs`: `renderer/app.js` boots on the real `index.html` in a small
fake DOM (`test/fake-dom.mjs`) and every view is clicked through against the daemon's shapes, without
a window. `test:daemon` (`test/daemon-contract.mjs`) starts `daemon/g9d.mjs` itself and drives it with
the app's own client, normalizers and wizard: handshake, settings round-trip, halt/resume events,
schedule add/list/remove, versions/profiles, `extension.install`, `--smoke` under node and under
Electron, restart-when-idle through the app's launcher, and shutdown. It never launches a browser.
`test:packaged` (`test/packaged.mjs`) checks the build itself: `G9.exe --smoke --launch` starts the
daemon from `resources/` as `G9.exe` + `ELECTRON_RUN_AS_NODE=1`, the exact MCP entry the wizard writes
for that build answers `initialize`, `tools/list` and `browser_status`, the runner runs under `G9.exe`,
and `shutdown` frees the port. It removes every directory holding `node.exe` from the PATH it gives the
build, and checks that with nothing listening the packaged shim starts the packaged daemon itself.
`test:render` (`test/render-check.mjs`) runs `main.mjs --check-render` against the real g9d, once on an
empty home and once with a headless engine, flows, runs and a schedule, in both schemes. A poller fails
the run if the window ever reaches the screen or takes the focus. `--out <dir>` keeps the pictures.

`ELECTRON_RUN_AS_NODE=1` is exported by some shells (the VS Code terminal and several agent hosts).
Electron then runs as plain Node and cannot open a window: `npx electron --version` prints Node's
version (v24.x) instead of Electron's (v44.x). `npm start` and `npm run smoke` remove it.

Flags of `main.mjs`:

| flag | what it does |
|---|---|
| `--smoke` | No windows: connect to the daemon at `G9_PORT`, do hello and `admin settings.get`, print one line of JSON, exit 0 or 1. Works under Electron (`npm run smoke`) and plain Node (`node main.mjs --smoke`). It never starts a daemon and never touches a foreign listener. |
| `--smoke --launch` | The same, but start the daemon first when nothing listens. |
| `--hidden` | Start in the tray without opening the window (once setup is complete). |
| `--check-render <dir>` | Diagnostic: an off-screen, transparent, unfocusable window opens every view in turn, collects console errors and writes `<dir>/<view>.png`. Prints JSON, exits. `G9_CHECK_THEME=light\|dark` forces a scheme. |

## What is in the window

| view | what it shows, what it does |
|---|---|
| Agents | Connected agents, the tabs each one owns, Halt/Resume per agent, the live activity log. |
| Engines | Running engines (the extension in your browser and the browsers the daemon launched), with contexts and tabs; a launch form (browser, headless, profile, human input, stealth, locale, time zone, proxy) that starts at the daemon's defaults; Stop for launched engines (asks first); Reload for the extension, or Update and reload when the daemon reports it runs another version; the browsers installed here and the pinned Chrome for Testing with an Install button; profiles with "Warm (open headed)" to sign in once. |
| Watch | Pick a tab, see it live: JPEG frames scaled to fit, a cursor sprite interpolated between pointer samples, a ring on each press. View only. Watching pauses while the window is hidden or minimized. When the daemon could not start the stream (the tab closed or navigated during the start, or an unwatch overtook it), the view says "That tab is not being watched" with the daemon's reason (or, when it gives none, asks you to pick the tab again) instead of waiting for a first frame (2.0.2). |
| Runs | Every run the daemon recorded (replays, calibrations, scheduled suites, watch sessions): verdict, steps (a scheduled run lists each flow of the runner's report, with Open report for its `report.html`, opened by Windows in your default browser), surprises, and a replay of the frames with the cursor. Export video records that replay into `runs/<runId>/video.webm`. |
| Approvals | Flows whose last run has surprises, with what differed. Approve calls `browser_recording action:"approve"` with `by` = your Windows user name, supplied by the main process. Nothing approves on its own; every approval asks once more. |
| Schedule | Suites the daemon runs by itself: daily at a time or every N minutes, with engine options. Every option the form shows becomes an explicit runner flag, so a later change of the defaults never changes a scheduled suite — except a browser left at "auto", which passes no `--browser` and so follows the daemon's `defaultBrowser`. Run now, Remove (addressed by `entryId`). The last result is the suite's worst verdict. In an installed app, a warning appears while there is an entry and G9 does not start at sign-in, because after a restart nothing else starts the daemon. |
| Settings | The daemon's settings (`settings.get` / `settings.set`), the raw JSON for everything else, the updater, the daemon connection, "Start G9 when I sign in" (installed builds: a login item with `--hidden`), and this app's folders. **Shut down daemon** stops it and the app does not start it again by itself: **Reconnect** brings it back (an agent's next call also starts it). |
| Setup | The first-run wizard, runnable again at any time. |

Human input (Settings, the launch form, the schedule form) takes a level (`off`, `human`, `stealth`)
or the name of a calibrated profile (plan §6.7, e.g. `team-qa`); a stored name is shown and kept.

The Agents view's activity log shows each call once: the daemon's record, with the agent's name and
what it did. An engine's own copy of an agent's call is dropped; a person's own action in the side
panel (which only the engine knows about) is kept.

The top bar always shows the connection and the **Stop all** control. When the agents are
stopped the bar turns red, with **Resume**. The same two actions are in the tray menu.
The version of the app is in the window title, the tray tooltip and the badge next to the name.

## Setup (the wizard)

Everything the wizard does is written to `G9_HOME/logs/install.log`.

1. **Browsers.** Edge and Chrome found on this machine (from the daemon's `engines.versions`, or the
   app's own probe when the daemon is down) and the pinned Chrome for Testing, with Install. Once CfT
   is installed, `browser:"auto"` picks it over Edge and Chrome. Windows Firewall may then ask once
   about the new `chrome.exe`; either answer is fine, because G9 uses a pipe, not a port
   (`docs/INSTALL.md`).
2. **Automation profile.** Lists profiles; "Open the automation profile" asks the daemon to open it
   headed (`profiles.warm`) so you can sign in once. Unattended runs then start signed in.
3. **Background policies.** Per-user browser policies that keep a covered or locked window drawing:
   `WindowOcclusionEnabled=0`, `HighEfficiencyModeEnabled=0`, `IntensiveWakeUpThrottlingEnabled=0`,
   `BackgroundTabFreezingEnabled=0`, `DeveloperToolsAvailability=1`, under
   `HKCU\Software\Policies\Microsoft\Edge` and `HKCU\Software\Policies\Google\Chrome`. Never HKLM.
   The current values are recorded in `G9_HOME/logs/policies.json` before anything changes, and
   **Undo** puts back exactly what was there (a value that did not exist is deleted again).
   On a default Windows install `HKCU\Software\Policies` is read-only for the user (only
   Administrators may write it — checked on the owner's machine), so Apply may ask for one
   administrator approval; the result is then verified by reading the values back as you. The
   approval is offered whenever Windows refused a write, whatever language `reg.exe` answered in
   (its messages are localized). The elevated step is one `.cmd` batch in which every argument is
   quoted and `%` doubled, so no value can act as a command in the elevated shell.
   Chromium's policy list says Chrome reads `BackgroundTabFreezingEnabled` only from version 155; an
   unknown name is ignored and shows as unknown on `chrome://policy` / `edge://policy`.
   Microsoft's Edge policy reference (read 2026-09-22) documents `WindowOcclusionEnabled`,
   `IntensiveWakeUpThrottlingEnabled` and `DeveloperToolsAvailability`, but has no
   `HighEfficiencyModeEnabled` or `BackgroundTabFreezingEnabled`. Which names Edge 153 honours was
   **not verified**: the policies were never applied on the owner's machine, and apply/undo were
   tested with a fake `reg` runner. The table in `docs/INSTALL.md` has the details.
4. **AI clients.** Claude Code (`~/.claude.json`, `mcpServers`), Cursor (`~/.cursor/mcp.json`),
   VS Code (`%APPDATA%\Code\User\mcp.json`, `servers`) and Claude Desktop
   (`%APPDATA%\Claude\claude_desktop_config.json`). The entry is `g9-browser`: `G9.exe` with
   `ELECTRON_RUN_AS_NODE=1` and `resources/mcp/shim.mjs` when installed, `node <repo>/mcp/shim.mjs`
   in development. The file is backed up (`<file>.g9-backup-<time>`) before any write; everything
   else in it is kept; a *different* existing `g9-browser` entry (for example v1's
   `bridge/src/server.js`) is shown as a diff and replaced only when you confirm; a file with
   comments asks before they are dropped; a file that does not parse is never written. **Remove**
   takes the `g9-browser` entry out again, after the same backup. Registration was tested on
   temporary files only.
5. **Extension.** The daemon copies the bundled extension to `G9_HOME/extension` (`extension.install`),
   the path goes on the clipboard, and the button opens `edge://extensions` (`msedge.exe
   edge://extensions`) or `chrome://extensions`. Then the three clicks: Developer mode, Load unpacked,
   paste the path. The folder never moves, because the browser knows the extension by its folder.

## Installer and updates

```powershell
$env:G9_UPDATE_URL = 'https://updates.example.com/g9/'   # optional; see below
npm run build:win                                         # → dist/G9-Setup-<version>.exe (2.0.3 now)
```

* NSIS, assisted, **per user**, no administrator rights, fixed folder. `electron-builder.yml`:
  `perMachine: false`, `allowElevation: false`, `allowToChangeInstallationDirectory: false`,
  `requestedExecutionLevel: asInvoker`. `build/installer.nsh` forces the per-user mode, so the
  "install for all users" page never appears. The folder is electron-builder's per-user default,
  `%LOCALAPPDATA%\Programs\G9`. The installer was built and its payload checked, but it was never
  run on the owner's machine.
* The last build, of 2026-09-25 (version 2.0.3): `dist/G9-Setup-2.0.3.exe`, 103,591,675 bytes,
  `NotSigned`, built without a feed (no `latest.yml`). Its payload matched the repository file for
  file.
* The uninstaller removes the program folder only: `G9_HOME` (profiles, runs, settings, the extension
  folder, CfT) is outside it and never touched, and `deleteAppDataOnUninstall: false` keeps
  Electron's own data folder (`%APPDATA%\G9`) too. `docs/INSTALL.md` "Uninstall" lists what to undo
  first (policies, MCP entries, the login item) and what stays behind.
* `resources/` carries `extension/`, `engine/`, `daemon/`, `mcp/`, `runner/`, `lib/` and the root
  `package.json`, so a QA machine needs no Node, no git and no npm.
* The build refuses to run when one of those folders is missing or when `desktop/package.json` and the
  root `package.json` disagree on the version (ARCHITECTURE_V2 §2).
* **Updates** use electron-updater's generic provider. The URL and channel are set in Settings →
  Updates, which writes the daemon settings `updateUrl` and `updateChannel` (stable or beta) and the
  app's own copy in `desktop.json`. The app updates only from its own copy: a different URL that
  arrives through the daemon's settings (any local client can write them) is used only after a dialog
  that names the new host. With no URL the app says
  "Updates: not configured" and never checks anywhere. With a URL it checks on start (as soon as the
  daemon has told it the URL, and again at once when Settings changes the URL or channel) and every
  6 hours, downloads by itself, then asks: install now, install when you quit G9, not now, or skip
  this version. Installing restarts the
  daemon, so it waits until the daemon reports no run in progress and no launched browser open; a
  busy daemon defers it (re-checked every minute), and quitting while busy leaves the update for the
  next quit. When `G9_UPDATE_URL` is set at build time the build also writes `latest.yml`; upload it
  with the installer and its `.blockmap` to that folder. The URL must be `https://` (`http://` only
  on `localhost`, `127.0.0.1` or `::1`, for a test feed): the installer is unsigned, so TLS to the
  feed host is what authenticates it. `file://` URLs are refused too, because electron-updater
  downloads over http(s) only.
* **Channels.** `stable` reads `latest.yml` and `beta` reads `beta.yml`. The build script only ever
  writes `latest.yml`, so nothing in the repository produces a beta feed yet.
* **The updater was tested with a fake `autoUpdater` only.** No update server exists, so a real
  download and install has not been exercised.
* **Known gap:** MCP shims run as `G9.exe`, and connected agents do not count as busy. The installer
  may close them mid-session, so quit the AI clients before installing an update.
* After an update the app refreshes `G9_HOME/extension` (`extension.install`), which makes the
  extension reload, and restarts an older daemon once it is idle.
* Code signing: none configured. When the installer arrives as a download, Windows SmartScreen may
  warn on first run ("More info" → "Run anyway"). A locally built copy has no download mark, so this
  was **not seen** on the owner's machine. Sign the installer for a fleet.

## Files

| file | written by | what |
|---|---|---|
| `G9_HOME/desktop.json` | this app | window size, last view, wizard progress, the version that last ran, the update URL and channel this app updates from |
| `G9_HOME/logs/install.log` | this app | every setup action and its outcome |
| `G9_HOME/logs/desktop.log` | this app | connection, daemon starts, updates |
| `G9_HOME/logs/policies.json` | this app | the previous registry values, for Undo |
| `G9_HOME/runs/<runId>/video.webm` | this app | Export video |

## Code

```
main.mjs            Electron main: lock, tray, window, g9app:// protocol, IPC allowlist, state, flags
preload.cjs         window.g9 = { invoke(op, args), on(topic, fn) } — nothing else reaches the page
renderer/           index.html (CSP), styles.css, app.js (shell), ui.js, views/*.js, lib/*.js (pure:
                    track, runs, schedule, engines, settings-form, activity, format, dom)
lib/ws.mjs          RFC 6455 client (no Origin header; 64 MiB frames) + a server half for tests
lib/daemon-client.mjs   hello/welcome, call/admin with timeouts, events, keep-alive, backoff states
lib/daemon-launch.mjs   start g9d when absent, name a foreign listener, restart only when idle
lib/policies.mjs    HKCU policy apply/undo with a record, elevation batch, read-back verification
lib/mcp-register.mjs    client detection, entry, plan/diff, backup, atomic write, verify
lib/extension-install.mjs, lib/wizard.mjs, lib/updater.mjs, lib/settings.mjs, lib/paths.mjs,
lib/runs-store.mjs (frames and cursor track from disk), lib/icon.mjs (tray/app icon, drawn in code)
scripts/            start.mjs, build-win.mjs, make-icons.mjs
test/               *.test.mjs + run.mjs; fake-daemon.mjs is a fake g9d, fake-dom.mjs a fake DOM for the
                    views; daemon-contract.mjs is the live check against the real g9d (npm run test:daemon);
                    packaged.mjs checks dist/win-unpacked (npm run test:packaged); render-check.mjs drives
                    the real window off-screen (npm run test:render)
```

Security shape: `contextIsolation`, `sandbox`, no Node in the page, a Content-Security-Policy that
allows only the app's own files (`connect-src 'none'`), every permission request denied, no
`<webview>`, no new windows, navigation pinned to `g9app://app/`. The page can call a fixed list of
admin ops and tool actions — the reads, plus `browser_engine` `launch`, `stop` and `context` for the
Engines view; approval goes through main, which adds `by` itself.
