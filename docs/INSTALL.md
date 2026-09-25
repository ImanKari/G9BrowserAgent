# Installing and operating G9 3.0.1

This is the operator guide: how G9 gets onto a machine, what it changes there, how to keep it
running with nobody at the keyboard, how to update it and how to take it off again. It covers
the desktop installer (the normal way, no Node needed) and the repository install (developers).

What was checked, and how: every statement about behaviour is from the code in this repository.
Numbers come from G9's own test runs on the owner's workstation (Windows 11 Pro 10.0.26200,
Edge 153.0.4234.32, Chrome 153.0.8010.53, Chrome for Testing 153.0.8010.52, Node 22.15.0) on
2026-09-22, unless another date is given. Some steps could not be carried out there without
changing the owner's own machine: installing the app, writing the browser policies, SmartScreen,
the uninstaller. Each such step is marked **not verified here**, so you know to check it yourself
on the first machine you install.

- [What goes where](#what-goes-where)
- [Desktop install](#desktop-install) — [SmartScreen](#smartscreen-the-installer-is-not-signed), [the setup wizard](#the-setup-wizard)
- [Background policies (HKCU)](#background-policies-hkcu)
- [AI clients (MCP registration)](#ai-clients-mcp-registration)
- [The extension: load once, updated by reload](#the-extension-load-once-updated-by-reload)
- [Windows Firewall and Chrome for Testing](#windows-firewall-and-chrome-for-testing)
- [Edge implicit sign-in](#edge-implicit-sign-in)
- [Upgrading a machine that runs G9 v1](#upgrading-a-machine-that-runs-g9-v1)
- [Unattended machines](#unattended-machines)
- [Updates and update hosting](#updates-and-update-hosting)
- [Repository (developer) install](#repository-developer-install)
- [Uninstall](#uninstall)

---

## What goes where

| What | Where | Notes |
|---|---|---|
| The app (`G9.exe`, Electron 44) and everything it runs | `%LOCALAPPDATA%\Programs\G9` | per user, no administrator rights. `resources\` holds `extension\`, `engine\`, `daemon\`, `mcp\`, `runner\`, `lib\` and the root `package.json`; `G9.exe` with `ELECTRON_RUN_AS_NODE=1` runs them, so the machine needs no Node. The folder is electron-builder's per-user default, and the installer does not let you change it; **not verified here** (the installer was not run on the owner's machine). |
| G9's data: `G9_HOME` | `%LOCALAPPDATA%\G9`, or the `G9_HOME` environment variable | `settings.json` (daemon settings), `extension\` (the folder the browser loads), `engines\` (Chrome for Testing), `profiles\` (launched-browser profiles, with their site logins), `runs\` (evidence: frames, pointer tracks, reports), `logs\` (`daemon.log`, `install.log`, `desktop.log`, `policies.json`), `desktop.json`, `engine-versions.log`. |
| The daemon `g9d` | a process, not a service | listens on `127.0.0.1:8765`, or on `G9_PORT`. The shim and the desktop app always pass `G9_PORT` (default 8765) to a daemon they start, so the `port` setting applies only to a daemon started by hand without it. The first MCP shim or the desktop app starts it when nothing listens. It exits by itself after `idleExitMinutes` (default 60) with no client, no launched browser and no enabled schedule entry. |
| The extension (Engine 1) | `G9_HOME\extension`, loaded unpacked into your Edge or Chrome | optional. It is only needed for agents to drive tabs in **your** browser. Launched browsers (Engine 2) need no extension. |

Requirements: Windows 10 or 11 (only Windows 11 was tested), Edge or Chrome installed, or internet
access once to download Chrome for Testing. No administrator rights, no Node, no git.

---

## Desktop install

The installer is `desktop/dist/G9-Setup-<version>.exe` (`G9-Setup-3.0.0.exe` for this release), built
with `cd desktop && npm run build:win`. The last build, `G9-Setup-3.0.0.exe` of 2026-09-25, is
103,620,667 bytes, and `Get-AuthenticodeSignature` reports `NotSigned` for it (and for
`win-unpacked\G9.exe` and `resources\elevate.exe`).

It is an NSIS installer that installs **per user**: the manifest asks for `asInvoker`, and
electron-builder is set to `perMachine: false`, `allowElevation: false` and
`allowToChangeInstallationDirectory: false`. `build/installer.nsh` forces the current-user mode, so
the "install for all users" page never appears. It creates a desktop and a Start menu shortcut
(`G9`) and starts the app when it finishes. The desktop suite checked the payload file by file:
`extension`, `engine`, `daemon`, `mcp`, `runner` and `lib` in the installer equal the repository,
and the packaged `G9.exe` ran the MCP shim, the daemon and a full `runner run` on headless Edge
**with no `node.exe` on the PATH** (3 of 3 runs, 2026-09-22).

### SmartScreen: the installer is not signed

No code-signing certificate is configured, so the installer carries no publisher. When the file
arrives from the internet or a mail attachment, Windows marks it as downloaded, and Microsoft
Defender SmartScreen may then stop it with "Windows protected your PC". Choose **More info** →
**Run anyway**. A locally built copy carries no download mark (checked: the 2026-09-22 build has no
`Zone.Identifier` stream), so the owner's machine could not show the prompt. **Not verified here.**
For a fleet, sign the installer with the company's certificate (electron-builder's
`win.signtoolOptions`, or `win.azureSignOptions`). Signing it is the only change that removes the
prompt for everyone.

### The setup wizard

The wizard opens on the first start and stays available as the **Setup** view. Each step can be
run again, and every action and its result is written to `G9_HOME\logs\install.log`.

1. **Browsers.** Lists the Edge and Chrome installs the daemon finds (`engines.versions`). When the
   daemon is not up yet, the app looks for them itself. Here you can also install the pinned
   **Chrome for Testing** 153.0.8010.52: a 205,149,043-byte zip, checked against the sha256 in
   `engine/versions.json` and extracted to `G9_HOME\engines\cft-153.0.8010.52\`. Once it is
   installed, `browser:"auto"` (the default setting) picks it over Edge and Chrome. For stealth
   work, choose Edge instead (`docs/STEALTH.md`: CfT's brand is flagged by detectors).
   Network: `storage.googleapis.com` refused this location over IPv4 (HTTP 403) and served the file
   over IPv6. `engine/cft.js` retries over the other address family and honours `HTTPS_PROXY`.
2. **Automation profile.** Creates the `automation` profile and opens it **headed** once
   (`profiles.warm`). Sign in to the **sites** your unattended runs need, then close the window,
   and the profile keeps those logins. Do **not** sign in to the browser itself (the Microsoft or
   Google account in the profile menu). See [Edge implicit sign-in](#edge-implicit-sign-in).
3. **Background policies.** Per-user browser policies for Engine 1. See
   [the next section](#background-policies-hkcu).
4. **AI clients.** Registers the MCP shim with the clients it finds. See
   [AI clients](#ai-clients-mcp-registration).
5. **Browser extension.** Copies the extension to `G9_HOME\extension`, puts that path on the
   clipboard and opens `edge://extensions` (it starts `msedge.exe edge://extensions`) or
   `chrome://extensions`. Then you make three clicks:
   **Developer mode** (on the left side in Edge, top right in Chrome) → **Load unpacked** → paste
   the path (Ctrl+V) → **Select Folder**.

To check the result, start a new session in your AI client and ask it to call `browser_status`.
Without a client, run `G9.exe --smoke` (from the install folder). It connects to the daemon, prints
one line of JSON and exits 0 (or 1 on failure). It never starts a daemon. Add `--launch` to start one
when nothing listens.

---

## Background policies (HKCU)

These are for **Engine 1 only**: your own Edge or Chrome, driven through the extension. Chromium
stops rendering a covered, locked or background page and drops CDP input to it. The policies keep
a covered window rendering and stop background tabs from being frozen, discarded or throttled.
Engine 2 (the browsers G9 launches) needs none of them: it sets the matching launch switches itself
(`engine/README.md`).

G9 writes them **only under `HKCU`**: `HKCU\Software\Policies\Microsoft\Edge` and
`HKCU\Software\Policies\Google\Chrome`. There is no code path that writes `HKLM`. Before
changing anything it records the previous value of every entry, or notes that there was none, in
`G9_HOME\logs\policies.json`. **Undo** puts back exactly that: a value that existed is rewritten
with its original type and data, and a value that did not exist is deleted.

| Value (REG_DWORD) | What it does | Chrome | Edge |
|---|---|---|---|
| `WindowOcclusionEnabled` = 0 | A window that is covered, on a locked screen or on another virtual desktop is no longer treated as hidden, so it keeps painting and input still reaches it. A **minimized** window still stops rendering. This is also what keeps a popped-out tab's window (the panel's **Pop out tab**, `browser_tabs action:"popout"`) rendering while another window covers it completely; the popout's result and note point here. | 90+ (Windows) | Documented by Microsoft, Windows 89+ |
| `HighEfficiencyModeEnabled` = 0 | Memory Saver does not discard tabs that are not in front. | 108+ | **No Microsoft Edge policy of this name** (no page on Microsoft Learn, 2026-09-22). Edge's own settings for this are `SleepingTabsEnabled` (88+) and `EfficiencyModeEnabled` (106+), and G9 does not set either. |
| `IntensiveWakeUpThrottlingEnabled` = 0 | Background tabs keep normal JavaScript timers (instead of at most one wake-up per minute after 5 minutes in the background). | 85+ | Documented by Microsoft, 85+. Microsoft notes that the value is read when a renderer starts, so restart the browser. |
| `BackgroundTabFreezingEnabled` = 0 | Background tabs are not frozen. | **155+**: Chrome 153 does not know it yet and lists it as unknown | **No Microsoft Edge policy of this name** (2026-09-22) |
| `DeveloperToolsAvailability` = 1 | Developer tools and the debugger API are allowed everywhere. The extension cannot work without `chrome.debugger`, and a machine policy that disallows DevTools would stop it. | 68+ | Documented by Microsoft, 77+ (1 = "Allow using the developer tools") |

The Chrome versions come from Chromium's policy definitions (read 2026-09-21). The Edge column is
from Microsoft's Edge policy reference (learn.microsoft.com/deployedge/microsoft-edge-policies, read
2026-09-22). A browser ignores a policy name it does not know and lists it as unknown on
`edge://policy` or `chrome://policy`.

**What was not verified.** The policies were never applied on the owner's machine: that would have
changed the owner's registry. So these were not seen on this machine:
- which of the five names Edge 153 honours (open `edge://policy` after applying; honoured names are
  listed with their value, unknown ones are marked unknown);
- that the running browser changes behaviour.

The launch-switch equivalent of the first policy was measured: an off-screen Engine 1 window of
Edge 153 and Chrome 153 stayed visible (142–143 animation frames per 1.5 s) with
`--disable-features=CalculateNativeWinOcclusion`, and was hidden without it (P8 matrix, 2026-09-22).

**Permissions.** On a default Windows install, `HKCU\Software\Policies` is readable but not writable
for the user; only Administrators may write it (checked on the owner's machine, 2026-09-21). So
**Apply** usually ends in one UAC prompt. The elevated step is a single `.cmd` batch that writes only
the HKCU values, with every argument quoted and `%` doubled. G9 then reads the values back as you. If
the approval came from a different Windows account, that account's `HKCU` was written instead, and G9
reports that rather than success. Restart the browser after Apply or Undo.

---

## AI clients (MCP registration)

The wizard registers one entry, named **`g9-browser`**, in each client it finds:

| Client | File | Key | Entry carries |
|---|---|---|---|
| Claude Code | `%USERPROFILE%\.claude.json` | `mcpServers` | `"type": "stdio"` |
| Cursor | `%USERPROFILE%\.cursor\mcp.json` | `mcpServers` | |
| VS Code | `%APPDATA%\Code\User\mcp.json` | `servers` | `"type": "stdio"` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers` | |

For an installed app, the entry runs the bundled shim with the app itself:

```json
"g9-browser": {
  "command": "C:/Users/<you>/AppData/Local/Programs/G9/G9.exe",
  "args": ["C:/Users/<you>/AppData/Local/Programs/G9/resources/mcp/shim.mjs"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" }
}
```

`G9_PORT` is added to `env` only when it differs from 8765, and `G9_HOME` whenever the app itself
was started with `G9_HOME` set. A development build writes `"command": "node"` with
`<repo>/mcp/shim.mjs`.

How the wizard writes the file:
- It **backs up** the file first (`<file>.g9-backup-<time>`), changes only `g9-browser`, re-reads
  the file just before writing, writes it atomically and reads it back.
- An existing `g9-browser` entry that differs (for example v1's `bridge/src/server.js`) is shown as
  a diff, and replaced only when you confirm.
- A file with comments (VS Code's is JSONC) asks first, because writing it back drops the comments.
- A file that does not parse is never written. The wizard shows the entry for you to paste instead.
- **Remove** in the same step deletes only the `g9-browser` entry, also after a backup.

After registering, restart the client: start a new Claude Code session (or `/mcp`), restart Cursor
or toggle the server in its MCP settings, start the server once from VS Code's *MCP: List Servers*,
or quit Claude Desktop from the tray and start it again. Any other MCP client takes the same entry by
hand. **Not verified here:** registration was tested on temporary files only, and the owner's real
client configurations were never written.

---

## The extension: load once, updated by reload

The browser identifies an unpacked extension by its **folder path**. A new path would be a new
extension, without the old one's recordings and settings. So `G9_HOME\extension` never moves, and
an update replaces its *contents*:

1. The daemon (`extension.install`, `daemon/extension-update.js`) copies the bundled extension to
   `G9_HOME\extension.new`, then swaps it in: `extension` → `extension.old`, `.new` → `extension`,
   and deletes `.old`. If Windows refuses the swap, it overwrites file by file and says so. Either
   way the path never changes. Test-only files (`dev-daemon.json`, `dev-bridge.json`) are never
   copied.
2. It sends `{type:'reload'}` to every connected extension. Before sending, it waits until that
   extension has no call in flight (at most 60 s), and the extension calls `chrome.runtime.reload()`
   once idle.

The desktop app runs this after every app update. You can also run it by hand: **Engines** →
**Update and reload**, shown when the extension reports another version than the daemon, copies the
folder and then reloads; **Reload**, shown otherwise, only sends the reload (step 2).

What the live suites measured about the reload (2026-09-22):
- **Edge 153:** the reload checks passed in every run of the isolated Engine 1 suite (5 reloads
  per run in 5 round-1 runs, and 9/9 final runs in round 3). After a same-version reload, no welcome
  tab opened (0 tabs).
- **Chrome 153 and CfT 153:** results depended on how the extension was loaded.
  - In a probe (headless, temporary profiles, a minimal MV3 extension), neither brought the
    extension back within 21 s of `chrome.runtime.reload()`. `chrome://extensions-internals` showed
    `DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION`.
  - CfT loaded with `--load-extension` failed the same way in the Engine 1 suite. Branded Chrome 153
    ignores `--load-extension` altogether.
  - With the extension installed unpacked over CDP after start-up, the suite passed (Chrome 7/7 full
    runs, CfT 4/5; the one CfT failure was an unrelated pop-out flake).
- **Not driven by any test:** a person's own Chrome with the extension added through the **Load
  unpacked** button. If the extension is off after an update, turn it on again on `chrome://extensions`
  or press **Reload** there.

Edge may show a prompt about extensions in developer mode. Keep them on: G9 is one of them.

On a managed (domain or Entra-joined) machine, IT can install the extension with the
`ExtensionInstallForcelist` policy and a self-hosted CRX and update URL, instead of Load unpacked
(plan §8). G9 3.0.1 ships no CRX or update manifest for that. **Not verified here.**

---

## Windows Firewall and Chrome for Testing

Edge and Chrome come with firewall rules that their installers register. Chrome for Testing is a zip
that G9 extracts to `G9_HOME\engines\cft-<version>\chrome-win64\chrome.exe`, so it has no rule. Windows
Defender Firewall then asks "Allow access?" the first time that program listens for **inbound**
connections. Each new path asks once: a new CfT version, or a new `G9_HOME`.

**Either answer is fine for G9.** The prompt is about inbound connections only. G9 drives the
browser over a private pipe (`--remote-debugging-pipe`), never over a network port, and outbound
traffic is not affected. G9 does not change the firewall itself (that needs administrator rights).
Instead, the first launch of CfT from a new path carries a warning saying all this
(`engine/firewall.js`). The paths already seen are kept in `G9_HOME\engines\firewall-seen.json`, so
the warning appears once per path.

Measured on the owner's workstation (a read-only query of the firewall rules, 2026-09-22):
- Eight CfT copies that the stealth self-test installed into temporary `G9_HOME`s each have a pair
  of inbound rules (TCP and UDP, Public profile). Six pairs **Allow** and two **Block**, which means
  the prompt was shown eight times and answered both ways.
- The CfT copy in `%TEMP%\g9-cft-cache`, used by the unit and Engine 1 suites on local test pages,
  has no rule.
- What exactly makes CfT listen was not isolated. The stealth runs visit public detector pages and
  also run headed.

A rule outlives the folder it names. To see stale rules, an administrator can run this read-only
query:

```powershell
Get-NetFirewallApplicationFilter | Where-Object Program -like '*\engines\cft-*' | Get-NetFirewallRule
```

---

## Edge implicit sign-in

**What happened.** Edge signs the first profile of every new user data folder in to the Windows
user's Microsoft account by itself, and turns full sync on: passwords, history, open tabs and
extensions. The live suites of 2026-09-22 (round 2) found this in the Engine 2 profiles G9 had
created:
- a fresh headless profile had `account_info` set and 137,266 bytes of `Sync Data`;
- `--disable-sync` alone did not keep it signed out;
- synced extensions then injected scripts into every page and slowed a headed engine until input
  stopped arriving;
- sync-confirmation and extension-onboarding tabs opened by themselves.

Test browsing from those runs may be in that account's synced history.

**What G9 does now.** Every launched browser gets three protections:
- `--disable-features=msImplicitSignin`. Given from a profile's first start, it keeps the profile
  signed out: 0 accounts in 6/6 fresh profiles when the fix was made. Chrome and CfT ignore the
  name.
- `--disable-sync`. Nothing syncs even if an account is present.
- A check before every launch (`engine/profile.js signInState`): a profile that is already signed in
  is **refused at stealth "stealth"** and launched with a warning at the other levels. The
  refusal took 7–12 ms in the stealth self-test (5/5 runs, and the run for this guide), and no
  browser started.

After the fix, no profile the suites read was signed in:
- 40 Engine 1 profiles, every Engine 2 profile of the matrix, 16 bench level-runs and 2 endurance
  runs (bench suite);
- 26/26 stealth configurations (stealth suite);
- every Engine 2 live-test profile.

**A profile that was already signed in stays signed in.** The switch prevents a new sign-in; it
does not sign anyone out. Profiles created by v2 builds from before the fix (anything launched for
longer than about 20 s) may be signed in. To check:
- Launch the profile at stealth (`browser_engine action:"launch" profile:"<name>" stealth:"stealth"`).
  A signed-in profile is refused, with the reason. A clean one launches normally; stop it afterwards.
- From a repository checkout, run this. It reads the files only and prints no names:
  ```powershell
  node --input-type=module -e "import { signInState } from './engine/profile.js'; console.log((await signInState('automation')).signedIn)"
  ```
  (set `G9_HOME` first if it is not the default).

To clean up:
- **The profile:** open it headed (`browser_engine action:"warm" profile:"<name>"`, or **Engines** →
  **Warm** in the app), then use the browser's profile menu → **Sign out**. Or delete the profile:
  close every engine that uses it, then delete `G9_HOME\profiles\<name>\` and `<name>.json`.
- **What the test profiles synced**, in your own Edge signed in to the same account: **Settings**
  → **Profiles** → **Sync**. Microsoft documents a cloud reset there: turn off sync for the data
  types you want removed, then **Re-sync data to this device** → "Still having sync problems? Try
  another option" → **Reset sync**. After a reset, every other device has to sign in again to sync,
  which also drops the test profiles (Microsoft Learn, "Reset Microsoft Edge data in the cloud").
  Back up your favorites first. This affects **all** your devices. **Not verified here:** it was
  not done on the owner's account.
- **Which devices synced:** the history page's tabs from other devices, and
  `edge://sync-internals` (device info), should list the test profiles. **Not verified here.**

Edge also has a policy for this, `ImplicitSignInEnabled` = 0 (Windows, Edge 93+, Microsoft Learn).
G9 does not set it: it would also change the person's own Edge, and it was not tested.

---

## Upgrading a machine that runs G9 v1

- v1's bridge and the v2 daemon both use `127.0.0.1:8765` by default. While a v1 bridge holds the
  port, the v2 daemon cannot start there. Every tool then fails with a message that names the
  bridge's pid and the fix. Stop the v1 bridge, or give v2 another port: `G9_PORT` in the MCP entry,
  the same `G9_PORT` in the environment the desktop app starts in, and the same port in the extension
  panel's daemon address. The `port` setting alone does not move a daemon that the shim or the app
  starts, because both pass `G9_PORT`.
- A v2 daemon refuses the v1 extension (close code 4001, "reload the v2 extension"). Load or reload
  the v2 extension from `G9_HOME\extension`.
- The wizard recognises a v1 `g9-browser` MCP entry (`bridge/src/server.js`) and offers to replace
  it. A config that still points at `bridge/src/server.js` keeps working in a repository checkout,
  because that file now starts `mcp/shim.mjs`.

---

## Upgrading from G9 2.x to 3.0

3.0 changed the side panel, the extension's auto-attach setting and issue index, and two messages
from the daemon (V3_UX_PLAN.md). Nothing changed in the MCP entry, the policies, the profiles or the
engines.

- **Installed app.** After the app updates itself it refreshes `G9_HOME\extension` and reloads the
  extension (see [The extension](#the-extension-load-once-updated-by-reload)), and restarts an older
  daemon once it is idle. Quit the AI clients before installing: shims run as `G9.exe`, and the
  installer may close them mid-session.
- **Repository checkout.** Reload the extension on `edge://extensions` or `chrome://extensions`. A
  2.x daemon keeps running until it has been idle for `idleExitMinutes` (60 by default); to switch at
  once, close the AI clients and end the `g9d` node process (the panel's About tab and `/health` name
  its pid), then restart an AI client, whose shim starts the new daemon.
- **Mixed versions.** The daemon refuses only extensions whose major version is below 2, so a 3.0
  extension and a 2.x daemon still connect, and the Session tab warns that the versions differ. A
  2.x daemon sends no project sites, so the new **Project sites** auto-attach setting behaves as Off
  until the daemon is 3.0, and the panel says so.
- **Settings and data.** A stored 2.x auto-attach choice is kept: on becomes **All tabs**, off becomes
  **Off** (one line in the activity log). Only an install that never saved its settings starts at
  **Project sites**. Recorded flows and issues need nothing: the issue index is completed from the
  stored issues the first time it is read.

---

## Unattended machines

**What runs without anyone there.** Launched browsers (Engine 2) run headless by default. They have
no window, so the Windows states that hide a window (covered, minimized, locked, another virtual
desktop) do not apply to them. The owner's machine was never locked for a test, so a locked session
was **not measured**. G9 is made of user-session processes (the daemon, the shim, the runner, the
browsers), so a **logged-off** user runs nothing. Engine 1 and headed launched browsers need a real,
unlocked, un-minimized desktop. In the P8 matrix, a minimized headed Engine 2 window rendered about
1 frame per 1.5 s, and a click on it took 28 s.

**A machine for scheduled or headed runs:**
1. **A dedicated Windows account that signs in by itself.** Use autologon (for example Sysinternals
   Autologon, which stores the password encrypted), turn off the screen lock and the screen saver
   for that account, and never use a person's own desktop. This follows Microsoft's guidance for UI
   test agents (learn.microsoft.com/azure/devops/pipelines/test/ui-testing-considerations), which
   plan §2.5 cites. **Not verified here.**
2. **Leaving an RDP session without locking it.** Disconnecting RDP locks the session — the state
   that was never measured, for headless runs too (the design says a headless browser has no window
   and so cannot be affected; nobody proved it on this machine). For headed runs, move the session
   back to the console instead: from an elevated prompt *inside* the RDP session, run
   `tscon %sessionname% /dest:console`. (`query session` shows the id if `%sessionname%` is not set.)
   Headless runs should not need this. **Not verified here.**
3. **Keep the daemon running.** In the app, **Settings** → "Start G9 when I sign in" adds a login
   item that starts `G9.exe --hidden` in the tray, and the app starts the daemon. In an installed app,
   the Schedule view warns while this is off and at least one entry exists, because after a restart
   nothing else starts the daemon. The daemon does
   not idle-exit while any schedule entry is enabled or a scheduled run is running.
4. **Schedule the suites.** Use either of these:
   - **G9's scheduler** (**Schedule** view, or the daemon's `schedule.*` admin ops). An entry runs
     daily at a local time, or every N minutes (1 minute to 31 days). Every option in the form
     becomes an explicit runner flag, except a browser left at "auto" (the run then follows the
     daemon's `defaultBrowser`). Each run is filed under `G9_HOME\runs\<runId>\`, with the
     runner's reports in `report\`. A due check runs every 30 s and once 2 s after the daemon
     starts, so a run missed while the daemon was down runs **once** when it comes back, not once per
     missed slot. It works only while the daemon runs (step 3).
   - **Windows Task Scheduler.** An installed machine has no `node`: the runner is
     `resources\runner\g9.mjs`, run by `G9.exe` as Node. Task Scheduler cannot set an environment
     variable itself, so wrap the command in `cmd`. Note that there is no space before `&&`:
     ```
     Program:    %SystemRoot%\System32\cmd.exe
     Arguments:  /d /c "set ELECTRON_RUN_AS_NODE=1&& "%LOCALAPPDATA%\Programs\G9\G9.exe" "%LOCALAPPDATA%\Programs\G9\resources\runner\g9.mjs" run suite:nightly --report D:\qa\nightly --quiet"
     Start in:   the folder that holds g9.project.json (or pass --project <file>)
     ```
     This form was run against the built `win-unpacked` copy with `help` (exit 0). A full `run`
     under `G9.exe` passed through the app's own scheduler (3/3 runs, desktop suite). Task Scheduler
     itself was **not exercised**. Choose "Run only when user is logged on": G9 was only ever run in
     an interactive session, and its data, profiles and daemon are per user. The runner's exit code
     is the task's *Last Run Result*: 0 pass, 1 product failure or error, 2 automation failure,
     3 surprise, 4 could not run (`runner/README.md`).
5. **Warm the profile once, by hand** (wizard step 2), so the unattended runs start signed in to your
   application. For stealth-critical suites, use Edge headed on this dedicated desktop
   (`docs/STEALTH.md`).

---

## Updates and update hosting

**The app** (electron-updater, generic provider):
- **Hosting.** Build with the feed URL set:
  ```powershell
  $env:G9_UPDATE_URL = 'https://updates.example.com/g9/'
  cd desktop; npm run build:win
  ```
  The build then writes `latest.yml` beside `G9-Setup-<version>.exe` and its `.blockmap`. Upload all
  three to that folder, on any static http(s) server. Without `G9_UPDATE_URL` the build writes no
  `latest.yml`, as the 2026-09-22 build shows.
- **Client side.** The URL is the daemon setting `updateUrl` (**Settings** → Updates). It must be
  **https** (`http://` is accepted only on `localhost`, `127.0.0.1` or `::1`, for a local test feed; `file://`
  is refused, because electron-updater cannot download over it). With no URL the app shows
  "Updates: not configured" and never checks anywhere.
- **What authenticates an update.** The installer is **unsigned**, so `publisherName` is not in
  `app-update.yml` and electron-updater performs no signer check: the only things that authenticate
  a downloaded installer are TLS to the feed host and the SHA-512 in that host's `latest.yml`. That is
  why plain http is refused, and why the app only updates from the address **saved in this app**: a
  different `updateUrl` arriving from the daemon's settings is applied only after a dialog naming the
  new host (the daemon is a local service several programs can write to). When a signing certificate
  exists, set the signing options so the build writes `publisherName` and Authenticode is checked too.
- **The prompt.** Install now, install when you quit G9, not now, or skip this version. Only the
  first two install; closing the dialog means "not now".
- **Channel.** `updateChannel` is `stable` (reads `latest.yml`) or `beta` (reads `beta.yml`). The
  build script writes only `latest.yml`, so a beta feed needs a `beta.yml` made some other way.
  Nothing in the repository produces one, and it is **not tested**.
- **When it installs.** The app checks on start (and again as soon as the URL or channel changes),
  then every 6 hours. It downloads by itself, then asks (the four choices of "The prompt"). Installing
  restarts the daemon, so it waits until the daemon reports no active run and no launched browser. A
  busy daemon defers the install, and the app checks again every minute.
- **After an update**, the app refreshes `G9_HOME\extension` and reloads the extension (above), and
  restarts an older daemon once it is idle.
- **Before installing, quit the AI clients.** MCP shims run as `G9.exe`, and the installer may close
  them mid-session. Connected agents do not count as "busy" (a known design gap).
- **What was tested.** The updater state machine was tested with a fake `autoUpdater` only. No update
  server existed, so a real download and install is **not verified here**. A build made without
  `G9_UPDATE_URL` now still gets a minimal `resources/app-update.yml` (the build's `afterPack`, and
  the app writes one into its user-data folder when the packaged file is missing): electron-updater
  reads that file before it downloads anything, and without it every install ended as
  `ENOENT … app-update.yml` after the check had said an update was available (desktop review,
  2026-09-22, with a windowless Electron against a local feed).

**Chrome for Testing** is pinned in `engine/versions.json` (153.0.8010.52) and changes only when
someone re-pins it and ships a new G9. The Engines view shows the pinned and installed versions, and
installs the pinned one. Every install is checked against the pin and logged to
`G9_HOME\engine-versions.log`. Installed Edge and Chrome update themselves. Every run records the
browser version it used (`engine.json`).

---

## Repository (developer) install

For working on G9 itself. You need Node 22 or newer. The core has **no npm dependencies**; only
`desktop/` has them (Electron, electron-builder, electron-updater).

```powershell
git clone <repo> g9-browser-agent; cd g9-browser-agent
.\setup\install.ps1                      # checks Node, runs the tests, writes setup\mcp.json
.\setup\install.ps1 -WriteProjectConfig  # also writes .mcp.json in the repo root (Claude Code's project config)
.\setup\install.ps1 -Port 9000 -SkipTests
```

`install.ps1`:
1. checks for Node 22+;
2. runs `setup\unittest.mjs`, `setup\selftest.mjs` and `setup\extensiontest.mjs`, and stops at the
   first failure. Their last recorded run (3.0.1, 2026-09-25) passed 651 tests in 12 suites, 136 and
   82. The unit suites include real headless launches of Edge and the cached CfT;
   `G9_UNIT_NO_BROWSER=1` skips them. That takes about 5 minutes; `npm run check:all` runs the same
   checks 4 at a time in about 2.5 (README, [Tests](../README.md#choosing-what-to-run));
3. writes an MCP entry `g9-browser` → `node <repo>/mcp/shim.mjs` with `G9_HOST`/`G9_PORT`. It goes to
   `setup\mcp.json`, and with `-WriteProjectConfig` also to `.mcp.json`. A v1 `.mcp.json` is backed
   up to `.mcp.json.v1.bak`; any other existing `.mcp.json` is left alone;
4. prints the manual step: load `<repo>\extension` unpacked. This is the repository folder, not
   `G9_HOME\extension`, so in a checkout you update the extension with `git pull` and **Reload** on
   the extensions page.

No service is installed. The first agent call starts the daemon, and it stops after an hour with
nobody connected. To watch it: `node daemon/g9d.mjs --foreground` (it logs to the console and never
idle-exits). A test page: `node setup/serve.mjs` → `http://127.0.0.1:5199/`.

The desktop app from source: `cd desktop; npm install; npm start` (`desktop/README.md`). Some shells
(VS Code's terminal, several agent hosts) export `ELECTRON_RUN_AS_NODE=1`, which makes Electron run
as plain Node. `npm start` removes it; for other commands run from such a shell, remove it first.

---

## Uninstall

Undo what G9 changed outside its own folders **before** removing the app, while the app can still
do it:
1. **Setup** → Background policies → **Undo**. This restores exactly the values recorded in
   `logs\policies.json`, and may ask for the same administrator approval as Apply. Then restart the
   browsers.
2. **Setup** → AI clients → **Remove** for each client. This removes only `g9-browser`, after a backup.
3. **Settings** → turn off "Start G9 when I sign in".
4. In Edge or Chrome, remove the G9 extension on the extensions page. Its local data (recordings,
   settings) goes with it.
5. Stop launched engines (**Engines** → Stop), then **Settings** → **Shut down daemon**. Each browser
   is asked to close cleanly first, so its profile keeps its logins: that usually takes under a second,
   but G9 waits up to 30 s on a busy machine before it kills the browser (measured up to 17.9 s under
   heavy load, 2026-09-24).

Then uninstall **G9** from Windows **Settings** → **Apps**. The uninstaller removes the program
folder only. These stay behind for you to delete by hand when you are sure:
- `G9_HOME` (`%LOCALAPPDATA%\G9`: launched-browser profiles with their site logins, run evidence,
  settings, the extension folder, the Chrome for Testing engines). The uninstaller never touches it;
- Electron's own data folder (`%APPDATA%\G9`), kept because the installer is set to
  `deleteAppDataOnUninstall: false`;
- the updater's download cache (`%LOCALAPPDATA%\g9-desktop-updater`), if an update was ever
  downloaded: nothing in the uninstaller names it;
- the `*.g9-backup-*` copies next to the AI-client configs;
- firewall rules for CfT paths (see above; removing them needs an administrator).

**Not verified here:** the installer was never run on the owner's machine, so neither was its
uninstaller.

A repository install has no uninstaller. Remove the `g9-browser` entries from your MCP configs (and
`.mcp.json` if `-WriteProjectConfig` wrote it), remove the extension from the browser, stop the
daemon (it also exits by itself after an idle hour), and delete `G9_HOME`.
