# G9 Browser Agent

Give an AI agent page inspection and automation through DevTools APIs in the browser you are **already using** — your real profile, your real logins, your real tabs.

The agent can inspect DOM and computed styles, capture Console and Network/HAR data, read supported storage information and cookies, collect performance signals, and interact using **trusted input events**. QA flows support assertions, visual baselines, data parameters, run history, and Playwright exports. This is page automation: it does not expose every DevTools domain or control arbitrary browser/OS dialogs.

**Current implementation: v1.7.21. Documentation audited 2026-09-12.** The audit found unresolved input-verification and download-watching defects; see [Current capabilities and limits](#current-capabilities-and-limits). Updating this documentation did not fix those defects.

```
  AI Agent  ──MCP (stdio)──▶  Bridge  ──WebSocket──▶  Extension  ──CDP──▶  Your tab
                             (Node.js)                (Chrome/Edge)
```

---

## Why this design

The project chooses an extension to reach an existing logged-in browser without launching a separate automation profile:

| Approach | Why it falls short |
|---|---|
| **Selenium / WebDriver** | A different session/control architecture; the project's reason for choosing an extension is access to the user's existing profile. Do not interpret this as a claim that WebDriver tooling cannot inspect styles or capture diagnostic data. |
| **External CDP clients** | Need an exposed debugging endpoint. Chrome 136+ restricts the remote-debugging flags on the default data directory; using a separate data directory does not inherit the user's existing session. Other connection mechanisms depend on the browser and version. |

A **Manifest V3 extension holding the `debugger` permission** talks CDP through `chrome.debugger` on eligible tabs in the real profile, without enabling a remote-debugging port. Chrome and Edge share this API, but browser/version parity must be tested. The extension transport exposes only [permitted CDP domains](https://developer.chrome.com/docs/extensions/reference/api/debugger#restricted-domains). See also [Chrome's remote-debugging change](https://developer.chrome.com/blog/remote-debugging-port).

---

## Requirements

- **Node.js 18+** for the bridge — no `npm install`, **zero dependencies**. Use Node.js 22+ for the live harness, which uses the [global `WebSocket` API](https://nodejs.org/download/release/v22.15.0/docs/api/globals.html#websocket).
- The manifest permits **Chrome/Edge 116+**. Cross-origin iframe control uses flat debugger sessions, available from **Chromium 125**; use a current browser for that capability.

## Install

```powershell
git clone <this-repo> g9-browser-agent
cd g9-browser-agent
.\setup\install.ps1
```

The script checks Node, runs the bridge/MCP and extension regression suites, and writes `setup/mcp.json` with the correct absolute path when checks succeed. The current extension suite has an external QA-fixture dependency; see [Verifying it works](#verifying-it-works) if installation stops with `ENOENT`. Then two manual steps.

Add **`-WriteProjectConfig`** and it also writes `.mcp.json` at the repo root — the location Claude Code reads — which turns step 2 below into "restart your client". It never overwrites an existing `.mcp.json`.

**1. Load the extension**

| | |
|---|---|
| Chrome | `chrome://extensions` |
| Edge | `edge://extensions` |

Turn on **Developer mode** → **Load unpacked** → select the `extension/` folder.

**2. Point your agent at the bridge**

Copy `setup/mcp.json` into your MCP client config:

| Client | Location |
|---|---|
| Claude Code | `.mcp.json` in the project, or `claude mcp add` |
| Cursor | `.cursor/mcp.json` |
| VS Code | `.vscode/mcp.json` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` |

You do **not** need to start the bridge yourself — the MCP client launches it.

## Use

1. Open the page you want worked on.
2. Click the **G9 toolbar icon** → the side panel opens.
3. Confirm the panel shows your project's sites under **Workspace** — if it does, there is nothing
   to attach. (No project file yet? Press **Attach & Pin current tab** instead, or add one: copy
   `g9.project.example.json` into the repo under test.)
4. Talk to your agent normally: *"check this page for problems"*, *"log in as admin and confirm the orders list loads"*, *"why is the save button not responding?"*

---

## The four control modes

| Mode | Behaviour | Use when |
|---|---|---|
| 🧪 **Workspace** *(default)* | Acts on, opens, closes and focuses tabs inside `workspaceDomains` in your project's `g9.project.json` — **no Attach click**. Other tabs expose origin only, with no title or full URL. | Almost always. |
| 📌 **Pinned** | Locked to one attached tab, including while you browse elsewhere. Background interaction reliability is a separate concern; see below. | A one-off on a site the project does not declare. |
| 👁 **Follow** | Acts on whichever tab is focused. | Quick exploration across pages. |
| 🌐 **Multi** | May open, close, and switch tabs itself. | Multi-tab flows, cross-page journeys. |

Workspace is the default deliberately, and it keeps the reasoning Pinned was built on: without some
boundary, switching to your email mid-task would hand the agent your inbox. An allowlist enforces
that without charging a click for it — your email host is not in the project file, so it never
enters the tool's world.

**The rule that makes it safe: an empty allowlist denies everything, never allows everything.** With
no `g9.project.json`, or none that declares `workspaceDomains`, Workspace behaves exactly as Pinned
and says so in the panel. Accepted patterns include `example.com`, `*.example.com`,
`localhost:5173`, and the explicit whole-browser wildcard `"*"`. Paths and regexes are refused.
`["*"]` allows every eligible site; `[]` still allows none.

### Two pages at once

`browser_tabs action:"session" name:"buyer" url:"…"` names a tab; pass `session:"buyer"` to any
other tool to act on it. `chrome.debugger` always supported several tabs at once — what was missing
was a way to address them.

Sessions are **names for tabs, not isolated users**. Same-origin tabs in the same normal profile
share cookies and localStorage. Separate logins require an appropriate isolation arrangement,
such as separate profiles; naming two tabs does not create one.

Multiple tabs can be observed without switching. Interactive flows should run sequentially and
verify their outcomes; background input is not guaranteed across window states.

The side panel shows activity and replay progress. **Stop** prevents further work at the next
guard/step boundary; it does not undo a click or cancel every command already in flight.
The panel's **↗** control opens it in a separate resizable window. Target resolution remembers the
last ordinary browser window so focusing the detached panel does not make the target disappear.

### Background tabs, focus, and capture

An active tab, a visible page, and a page with input focus are different states. A hidden page
is also different from a frozen or discarded one. DOM/Accessibility reads, JavaScript evaluation,
and buffered Console/Network reads generally work in the background while the target remains alive.

**Screenshots do not generally require focus.** This project uses `Page.captureScreenshot`,
whose `fromSurface` default is true, not `chrome.tabs.captureVisibleTab`, which captures the active
tab. In the 2026-09-12 isolated Edge 152.0.4191.66 **headless** audit, a tab reporting
`visibilityState: "hidden"` and `hasFocus(): false` returned a valid screenshot. That result does
not certify minimized/occluded windows, a locked desktop, or fresh animation frames in every state.

**Input requires verification.** Background typing also worked in that headless audit. Historical
headed runs reported lost input, so neither "background input is always impossible" nor "it always
works" is supported. Keep the target visible for ordinary interactive runs and check observable
outcomes. In v1.7.21, `watchForInput()` injects an undefined `sessionId` into page JavaScript,
causing `ReferenceError` and bypassing its delivery check. A successful tool reply alone is not proof
that input arrived; see the unresolved defects in [AIGuide §8](AIGuide.md#8-known-gaps-and-deliberate-omissions).

**Tab video needs produced frames.** `Page.startScreencast` may yield no frames depending on rendering
and visibility. `video_start` warns and `video_stop` explains empty captures, but headless is not a
universal zero-frame condition: historical live runs include both PASS and SKIP.

References: [page lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api),
[CDP screenshot](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot),
[captureVisibleTab](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab).

---

## Tools the agent gets

| Tool | What it does |
|---|---|
| `browser_status` | Orientation: connection, attached tab, error and request counts |
| `browser_snapshot` | Accessibility tree with `[ref=eN]` handles — **primary perception** |
| `browser_interact` | click / double / right / hover / type / key / scroll / drag / select / upload |
| `browser_navigate` | goto / reload / back / forward / **wait for a condition** |
| `browser_inspect` | dom · styles · box · storage · cookies · frames |
| `browser_console` | Read buffered console output, or evaluate JavaScript |
| `browser_network` | Requests and bounded bodies; HAR 1.2; HAR pinning; request interception/fault rules. Download-watching actions exist but are currently broken; see limits below. |
| `browser_diagnose` | **health** · **performance** trace · Core Web **vitals**/long tasks · **memory** leak signals |
| `browser_screenshot` | viewport / fullpage / element |
| `browser_emulate` | Device, viewport, network throttle, CPU, colour scheme, locale, timezone |
| `browser_dialog` | Accept or dismiss `alert` / `confirm` / `prompt` |
| `browser_tabs` | List/open/close/focus/pin tabs; **named sessions** for multi-tab flows; wait for popups by URL, title, or opener |
| `browser_recording` | Record/replay flows; assertions, suites/tags/data, history/flaky signal, backup, Playwright export, **the assertion wizard, FlowSpec export/import, calibration, and the known world** |
| `browser_issue` | Defects with screenshot, durable tab video, console, failed requests and page context attached |

Fourteen tools rather than fifty: definitions are re-sent on every request, so a wide surface would burn thousands of context tokens before the agent did anything.

### Element refs, not CSS selectors

`browser_snapshot` returns an accessibility tree where every interactive element carries a handle:

```
- button "Sign in" [ref=e7]
- textbox "Username" [ref=e5] (value="admin")
- link "Forgot password?" [ref=e9] (url=/reset)
```

The agent passes `ref: "e7"` to `browser_interact`. Use refs only from the **latest snapshot of that
tab**. Missing refs and changed non-hash URLs produce errors, but generation checking is incomplete:
each snapshot reuses `e1`, `e2`, etc., and callers do not supply a generation for validation. A ref
retained across a newer snapshot can resolve to a different element without a stale-ref error.

---

## Record a flow, replay it as a test

Side panel → **Automation** → *Start recording*. Use the page exactly as you would when testing it,
then stop. The recorder captures supported DOM interactions, with a 5,000-raw-event cap. Browser/OS
dialogs and every custom widget or frame configuration are not covered automatically.

The question that decides whether a recorded test is worth keeping is how it finds the same input after a redeploy. One selector cannot: a CSS path breaks on a refactor, an id breaks when the framework regenerates it, text breaks on a copy edit. So each element is recorded with **several independent locators**, tried in order of how well they survive change:

| # | Locator | Survives |
|---|---|---|
| 1 | `data-testid` / `-test` / `-qa` / `-cy` | anything — it is a promise not to move |
| 2 | **role + accessible name** | restyling, DOM restructuring, class churn |
| 3 | bound `<label>` text | everything but a copy change |
| 4 | shortest unique visible text | buttons and links |
| 5 | CSS from stable attributes only | refactors that keep `name` / `type` |
| 6 | XPath | last resort |

Anything machine-generated is refused outright — CSS Modules, styled-components, emotion, React `useId`, Radix, `ng-tns`, hashes. Those are stable within one build and different in the next, and they are the largest single source of flaky recorded tests.

**Replay tells you when a flow is rotting, before it breaks.** A step that used to match on `testid` and now matches only on `xpath` still passes — and is one refactor away from not. That comes back as a warning.

**When a step does fail, you get the sentence you need:**

```
Could not find textbox "Username" under "Billing details".
Tried 4 recorded locators: role (0 matches), label (0), css (0), xpath (0).
The closest thing on the page now is textbox "User name (email)" —
this usually means it was renamed.
```

Replay waits for page/element readiness and uses recorded timing to derive wait budgets. In
`timing: "recorded"` it also preserves remaining pauses, capped at ten seconds per step.
`timing: "fast"` removes that pacing. Assertions retry within their declared budget.

Recorded flows can become tests. `browser_recording action:"assert"` adds URL, text, visibility,
element value/state, network, console-absence, accessibility, semantic (`aria`) or screenshot-baseline
checks; `atStep` inserts a check at a chosen point. `action:"update"` adds suite/folder/tags, an
environment profile, and `{{parameter}}` defaults. Replay checks supported action outcomes, saves
the last 20 runs and flags mixed pass/fail outcomes. Open Shadow DOM and same-origin iframe elements
participate in locator discovery. `action:"export_test"` generates Playwright JavaScript; review
the export's unsupported-assertion notes because it does not reproduce every G9 check or signature.

## The part assertions cannot do: remembering what normal looks like

An assertion only ever finds what somebody thought to look for. The regressions
that reach users are the ones nobody predicted — a console error that appeared
this sprint, a request that quietly started failing, a control that vanished
from a screen nobody wrote an assertion about.

So every replay also builds a **signature** of what the flow actually did
(requests made, console output, the semantic shape of the screen, how long each
step took) and compares it against that flow's approved **known world**.
Anything outside it is a *surprise*, in both directions:

```
+ [fail] console: error: Cannot read properties of undefined
− [fail] network: POST /api/task 2xx
         This request happened on all 7 previous runs and did not happen now.
+ [warn] ui: s4 :: 2|button "Archive"
```

The second one is the direction people forget. A request that *always* happened
and now does not is a button that no longer does anything — and no assertion
was ever written for it.

**Three rules keep it from becoming noise:**

- **Calibrate once.** `browser_recording action:"calibrate"` runs the flow twice
  on the same build and marks everything that differed as volatile. Whatever
  changes when nothing changed is noise by definition. This replaces hand-written
  masks, which is the mechanism that quietly blinds most visual suites — teams
  mask until the tool only watches the parts nobody masked.
- **Confirmation before escalation.** A surprise seen once is reported as a
  note; the same surprise in a majority of recent runs becomes a finding.
- **Only a human approves.** `action:"approve"` folds the last run into the
  known world. Nothing else can, ever — an automatic merge would write a real
  regression into the baseline as normal, which is the silent-self-healing
  failure in another costume.

Every replay returns a verdict: `PASS`, `PASS_WITH_WARNING`, `SURPRISE`,
`FAIL_PRODUCT`, or `FAIL_AUTOMATION`. The last two are separated deliberately:
a rotted locator is a broken test, not a broken product, and a pipeline that
conflates them teaches people to ignore it.

### Freeze the backend and the remaining difference is yours

```
browser_network action:"record_har"     → capture once against the real server
browser_network action:"pin"  har:…     → serve every matching request from it
```

Matched requests receive the stored responses. Matching uses method, origin/path and query **keys**;
query values and request bodies are ignored, and duplicate matches consume entries in order.
Unmatched requests reach the live server unless `strict: true` is set. Bodies are bounded, so this
helps compare runs but does not by itself prove that every remaining difference is a client bug.

### The wizard proposes the oracles you cannot see

A recorded flow with no assertion is a macro: it proves the steps could be performed, never that
they did anything. `action:"suggest"` looks at what the tool actually observed — which request
fired, whether the console is clean, how big the semantic tree is — and proposes assertions, each
with a strength and a reason:

```
url      strong   The flow ends here. If a later build routes elsewhere, everything else still passes.
network  strong   The flow performed POST /api/task. Asserts the business effect, so it survives a redesign.
console  blocked  The page ALREADY has 3 console errors, so this would fail immediately.
aria     strong   180 semantic nodes — small enough to be a stable structural baseline.
text     weak     Offered last: easiest to write, first to break on a copy edit.
```

**It adds nothing.** You pick. A weak assertion somebody consciously accepted is a decision; one a
tool added quietly is a blind spot.

### Compare two builds directly

```powershell
node runner/g9.mjs ab rec_abc123 --a https://released.example --b https://candidate.example
```

Both sides run minutes apart on the same machine with the same data, so almost everything that
would be noise cancels and what is left is attributable to the build. It reports *differences*, not
verdicts — a shipped feature and a regression look the same from here.

### Semantic baselines beat pixel baselines

`action:"assert" assertion:"aria"` stores the accessibility tree — roles, names,
states — instead of an image. It is less sensitive to styling and theme changes, but accessible-name
or copy edits can still change it. Balanced numeric-only substitutions are reported as data-change
warnings; added/removed structure remains significant. Screenshot assertions default to comparing
**layout structure** rather than pixels for the same reason, with `strict` still
available when colour genuinely matters.

## Run it without an agent, on a schedule

```powershell
node runner/g9.mjs run suite:smoke --env test1 --report ./g9-artifacts
```

Exit code 0/1/2/3/4, plus `run.json`, `junit.xml`, a self-contained `report.html`,
and `qa-automation-status.json` — a per-test-case status file an existing manual
QA suite can read to show which scenarios are already automated. Full details,
including the port rule that decides whether a scheduled run is even possible,
are in [`runner/README.md`](runner/README.md).

## Report a defect while it is still on screen

Side panel → **Issues** → *New issue*. It captures first and asks questions second, because the evidence is only true at that instant:

- screenshot of the viewport
- the console tail and every failed request
- URL, referring page, viewport, user agent
- the DOM around the element under suspicion — impossible to recover once the tab moves on

All of it is written as **real attachments** (`console.log`, `failed-requests.log`, `page-context.json`, `page-fragment.html`), so an agent filing to Jira or Azure DevOps uploads files a developer can open, rather than pasting a truncated blob into a description.

Then enrich it: more screenshots, a tab video, the file you were testing an upload with, edits, re-capture. `browser_issue` gives the agent the whole thing.

---

## Verifying it works

```powershell
node setup/selftest.mjs
node setup/extensiontest.mjs
```

The first command spawns the real bridge, speaks MCP over stdio, and connects a fake extension over a
real WebSocket. The second exercises extension modules with a browser-API harness and source checks.
**Neither requires a browser**, and neither alone proves a capability works through `chrome.debugger`.

Latest audit (2026-09-12): **bridge 26/26 passed**. The extension suite stopped at an external fixture
read: `../../../../QA/Flows/web/tasks/tasks-browse-and-open.flow.json` relative to
`setup/extensiontest.mjs` (resolved to `G:\QA\Flows\web\tasks\tasks-browse-and-open.flow.json` in the
audited checkout). Without that fixture it is not a self-contained suite and installation can stop
before generating config. This remains an unresolved test dependency, not a passing full run.
For manual MCP configuration, the committed [setup/mcp.example.json](setup/mcp.example.json) is
available; replace its placeholder with the absolute path to `bridge/src/server.js`. Manual setup
does not resolve the missing fixture or certify the extension suite.

A test page with six deliberate defects is included:

```powershell
node setup/serve.mjs      # http://127.0.0.1:5199/
```

Then, with that page open and attached, run the **live** test — it drives real
CDP against your browser and acts as the MCP client itself, so it needs no
agent configured:

```powershell
node setup/livetest.mjs
```

It exercises snapshot, computed styles, storage, cookies, console, network,
diagnose, trusted-event login/select, obstruction detection, assertions and their
failure paths, run history, Playwright export, screenshots, IndexedDB video, and
device emulation. It then checks that all seeded defects were actually found.

For a run isolated from the everyday browser profile, let the harness launch a temporary clean
Edge/Chrome profile, load the unpacked extension, connect the real bridge over
MCP, drive the page, exercise the side panel, and clean up:

```powershell
node setup/isolated-livetest.mjs
```

The isolated browser harness uses headless mode; `livetest.mjs` uses the browser you attach.
Older full-suite pass counts in AIGuide are historical, not certification of v1.7.21. The latest
audit ran targeted real-Edge probes, not the full isolated suite. Headed interaction needs separate
checks for a visible unfocused window, a hidden tab, minimization, occlusion and desktop locking.

## Current capabilities and limits

| Area | Current behavior and boundary |
|---|---|
| Browser/OS UI | Page tools cannot automate arbitrary native dialogs or browser-internal pages. JavaScript dialogs and DOM file-input upload are supported. |
| Input verification | Broken in v1.7.21 by an injected `sessionId` reference; this is a fixable implementation defect. |
| Download verification | `watch_downloads` calls unavailable `Browser.setDownloadBehavior` and failed in the real-Edge audit. A replacement using `chrome.downloads` would need its permission and implementation; neither is present. File-content verification is not built. |
| Frames and Shadow DOM | Cross-origin snapshot/input support uses Chromium 125+ sessions. Recorder/replay and inspection coverage are not equivalent to that path. Closed Shadow DOM is reachable through privileged APIs; existing locators primarily traverse open roots. |
| Evidence budgets | 500 Console entries, 400 Network requests, roughly 512KB of text per response body, 8MB of HAR bodies. Capture starts at attach; navigation prunes buffers. Binary bodies are omitted by direct request-detail output. |
| Screenshots and video | Fullpage/element clips are scaled to the configured 2,000-wide/8,000-high budget. Unloaded or unmounted content is not materialized. Video is a bounded screencast, capped at 600 frames or 40MiB, not desktop/audio recording. |
| Storage inspection | Web Storage is bounded; IndexedDB inspection lists database names/versions, CacheStorage lists cache names. It is not a complete Application-panel data browser. |
| Lifetime and connection | One bridge connection per extension instance. Worker revival is handled, but browser closure/reload and target loss still interrupt operations. |
| Test isolation | Named sessions share their profile's storage. Device emulation is not a real device or another browser engine; Firefox/Safari and Lighthouse are not implemented. |

Some limits are configurable budgets, some need implementation changes, and some are browser/OS
boundaries. See [AIGuide §8](AIGuide.md#8-known-gaps-and-deliberate-omissions) for evidence, unresolved
defects and the distinction between extension-only changes and work requiring another component.
The English [Extension Fix and Improvement Backlog](EXTENSION_FIX_BACKLOG.md) tracks 17 planned
items with evidence, implementation directions and acceptance criteria. Those proposals are not
implemented capabilities.

---

## Security

This tool has full control of your logged-in browser sessions. Treat it as you would an SSH key.

**Deployment decision:** G9 Browser Agent currently targets a trusted, controlled local development/QA environment. The localhost bridge, browser profile, local users, and installed extensions are inside the trust boundary. Additional hardening against a malicious local user/extension, bridge impersonation, local secret theft, or hostile local software is intentionally out of scope unless that deployment model changes. Existing safeguards below remain in place; this is a scope decision, not a claim that localhost is a hostile-environment security boundary.

**What protects you:**

- The bridge binds to **127.0.0.1 only** — never `0.0.0.0`
- **Origin validation**: only `chrome-extension://` / `edge-extension://` origins may connect. A malicious web page attempting `new WebSocket('ws://127.0.0.1:8765')` sends its own `https://` origin and is rejected with 403. *(The self-test asserts this.)*
- **Single client** — a second connection displaces the first rather than silently sharing
- **Workspace / Pinned mode** — the agent reaches only what you consented to: in Workspace, the hosts your project declares; in Pinned, the single tab you attached. Outside multi-tab mode it may not open, close, focus, pin, or unpin arbitrary tabs — `browser_tabs` can only *list*, because pinning a different tab would otherwise be a way around the mode. Workspace may open a tab, but only after the URL is checked against the allowlist, and the check happens **before** the tab exists
- **Cookies stay scoped** — `chrome.cookies` can see every domain you are signed in to, so outside multi-tab mode the agent may only read cookies for the attached tab's own origin
- **An empty allowlist denies everything** — a missing or empty `workspaceDomains` makes Workspace behave as Pinned. It never means "allow all"; that inversion would be the single most dangerous line in this codebase
- **Other tabs stay private** — outside multi-tab mode the agent sees other tabs by origin only. Titles and URLs carry subject lines, document names, and search queries, so they are withheld
- **Stop button** — blocks every tool call immediately, and **the agent cannot lift it**. Only Resume in the side panel does. (`browser_status` still answers, so the agent can tell you *why* it stopped rather than guessing.)
- **Full activity log** in the side panel; nothing happens invisibly
- **Least privilege** — eight permissions, all of them used. `scripting` and `downloads` were requested by earlier versions and never called, so they were dropped
- **Zero dependencies** — no supply chain under a tool with this much access

**Optional:** set `G9_TOKEN` in the MCP config and enter the same value in the side panel for a shared secret on top of Origin checking.

**The "browser is being debugged" banner CAN be removed** — this used to say it could not, and that
was wrong. Two documented ways: launch the browser with `--silent-debugger-extension-api` (global,
covers every extension, and depends on how the browser is started), or **install this extension
through the `ExtensionInstallForcelist` enterprise policy** — policy-installed extensions never
raise the bar. For a QA fleet the second is the right one: one setup, survives restarts, scoped to
this extension, and it removes the manual "Load unpacked" and the manual update on every machine.

**Known and unavoidable:** Browser-internal pages (`chrome://`, `edge://`, extension stores) can never be controlled. Native OS dialogs (print, basic auth) are outside the browser's reach — but file uploads work via `browser_interact action:"upload"`, which bypasses the picker entirely.

**Intentional capability limits:** request interception/mocking and download-file verification are not implemented yet; cross-origin iframes and closed Shadow DOM remain browser boundaries; full Lighthouse audits and heap snapshots are not bundled. The automated live suite currently proves Edge; Chrome parity, long-running service-worker endurance, and controlled-input behavior across large React/Vue applications still need dedicated live runs.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| *"The G9 browser extension is not connected"* | Check that the browser and extension are running and the panel selects this client's bridge/port. Transport connection and attachment to a page are separate states. |
| `browser_network` returns 0 requests | Capture starts when the tab is **attached**, not when it loaded. Reload the page, then read again. |
| Agent shows no `browser_*` tools | The MCP config path is wrong, or the client was not restarted. MCP servers load at client start — restart it after editing the config. |
| `Cannot find module ...server.js` | The config still has a placeholder path. Use `setup/mcp.json`, which `install.ps1` fills in with the real absolute path. |
| `ERR_CONNECTION_REFUSED` in the extension's **Errors** page | **Expected when no bridge is running.** The browser logs failed WebSocket handshakes itself, below our code, so it cannot be suppressed. The extension retries on a backoff that climbs to 60s, so it stays to about one entry a minute. Start the bridge (or open the side panel) and it connects immediately. |
| Side panel says **Bridge offline** | Nothing is listening on the port — the bridge is not running. Either restart your MCP client (it launches the bridge), or start it yourself: `node bridge/src/server.js`. That command stays up in standalone mode, so you can watch the extension connect. |
| MCP client cannot reach a browser, but the side panel says **Bridge connected** | The panel may be connected to a different client's bridge. Compare the project identity/port, use **find bridges**, and select the intended one. An explicitly pinned occupied port remains blocked; an unpinned bridge can choose another port. |
| `EADDRINUSE` | Since v1.7.0 the bridge takes the next free port from 8765–8775 instead, and logs which one it took. You should only see this when `G9_PORT` is pinned — an explicit port is honoured absolutely, because you also typed it into the side panel. In the panel: **settings → find bridges** lists every bridge running on this machine, with its project name and whether a browser is already on it. |
| *"Another debugger is already attached"* | A DevTools window is open on that tab. Close DevTools, or attach a different tab. |
| *"the page never received it: the attached tab is HIDDEN"* | Bring the target into view and verify the outcome before retrying a state-changing action. The diagnostic's categorical Chromium explanation is too broad; see Background tabs above. |
| Agent says it typed or clicked, but nothing changed | Still possible in v1.7.21: the input witness has a known defect. Check the page's actual result and version mismatch; a successful tool reply or matched versions do not prove delivery. |
| Agent clicks the wrong thing | Its snapshot is stale. Ask it to take a fresh `browser_snapshot`. |
| A dialog blocked everything | Handled: the call that opened it now fails immediately naming `browser_dialog`, and later calls fail instantly too rather than each waiting 60s. |
| Tools hang, then time out | Check for a JavaScript dialog, a stalled CDP command, target loss or transport failure. The generic bridge timeout mentions dialogs but does not establish that cause. Screenshot retry can also exceed the default bridge budget. |
| Everything fails with *"halted"* | **Stop** is engaged. Press **Resume** in the side panel — nothing the agent does can clear it, by design. |
| Agent says it cannot open, close, or pin a tab | Pinned/Follow restrict tab management. Workspace permits management within its allowlist; Multi permits broader tab control. An empty Workspace allowlist falls back to Pinned behavior. |
| Agent only sees other tabs as bare origins | Also deliberate. Pinned and Follow mode withhold other tabs' titles and URLs. Switch to Multi if you want the agent to see them. |

---

## Repo layout

```
g9-browser-agent/
├── extension/              MV3 extension — all browser logic lives here
│   ├── manifest.json
│   ├── sw.js               service worker: tool router
│   ├── lib/                state · cdp · refs · transport
│   ├── tools/              one module per capability group
│   └── panel/              side panel UI (the trust surface)
├── bridge/                 zero-dependency Node bridge
│   └── src/                server · mcp · ws-server · tools (schemas)
├── runner/                 the unattended CLI — g9 · mcp-client · report
├── setup/                  install · bridge/extension tests · live/isolated live harness · seeded page
├── g9.project.example.json the project adapter template (belongs in YOUR repo, not this one)
├── README.md               this file
├── EXTENSION_FIX_BACKLOG.md planned extension improvements and acceptance criteria
└── AIGuide.md              build log + architecture reference
```

This tool is **completely independent of any project it inspects**. It sees only the browser — never whether the page behind it is ASP.NET, React, or PHP. Keep it as its own repo and use it across all your projects.

---

## ⚠️ Changing this codebase

> **Every change must also update [`AIGuide.md`](AIGuide.md).**
>
> `AIGuide.md` is the durable record of *what exists, why it was built that way, and what is deliberately absent*. It is what an AI agent (or a new teammate) reads before touching this code.
>
> When you change anything:
> 1. Make the change.
> 2. Add an entry to the **Change log** in `AIGuide.md` — date, what changed, why.
> 3. Update the affected architecture or tool section in the same file.
> 4. If you added a tool: update the schema in `bridge/src/tools.js`, the router in `extension/sw.js`, the table above, **and** the tool reference in `AIGuide.md`.
> 5. Run `node setup/selftest.mjs`, `node setup/extensiontest.mjs`, and the isolated live test when browser behavior changed.
>
> A change that is not in `AIGuide.md` did not happen. This is how we keep an accurate picture of what we have and what we do not.

## License

Internal G9 tooling.
