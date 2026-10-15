/**
 * The agent guides (3.8) — the second and third layer under the MCP instructions.
 *
 * Why layers. A client sends the server instructions with every request and cuts them (Claude Code: 4,096
 * characters, 2,048 before v2.1.296; mcp/tools.js INSTRUCTIONS stays under 2,048), and a deferred tool's
 * description is read only when the agent searches for it. So the always-sent text is a short core — what
 * this server is for, the rules that must never be missed, and this index — and everything an agent needs
 * for one kind of work is a topic guide it reads when that work starts:
 *
 *   layer 1  mcp/tools.js INSTRUCTIONS             always sent; < 2,048 characters
 *   layer 2  GUIDES[topic].text                    one task area: workflow, recipes, pitfalls
 *   layer 3  toolReference(name)                   every action and argument of one tool, generated from
 *                                                  its schema so it can never drift from the code
 *
 * Reached two ways, because not every MCP client lets the model read resources: the resources
 * `g9://guide`, `g9://guide/<topic>` and `g9://tool/<name>` (mcp/server.mjs), and
 * `browser_status guide:"<topic>"` / `guide:"tool:<name>"`, answered by the MCP server itself — no daemon
 * or browser needed.
 *
 * Every sentence must describe behaviour that exists (EXT-17); setup/unit/guides.test.mjs checks that every
 * tool, action and argument a guide names is real.
 */

import { TOOLS } from './tools.js';

const G = (title, summary, text) => ({ title, summary, text: text.trim() });

export const GUIDES = {
  start: G('Start here: engines, tabs, sessions', 'Which browser you are in, how tabs are named, background vs front tabs.', `
# Start here

## Two engines, one set of tools
- **Engine 1 — the extension**: the user's OWN browser, with their real cookies, sessions and logins. Use it
  to explore, author and debug with them.
- **Engine 2 — launched browsers**: real Chrome/Edge processes G9BrowserAgent starts, headless by default,
  with their own profiles. Use them for long or unattended runs, parallel work, and work that must go on while
  the user minimises or covers their windows. \`browser_engine\` manages them (guide "background").
Every tool works the same on both.

## Orientation
\`browser_status\` first: your current tab (URL, title, console-error and failed-request counts), the engines,
the connected agents (who is \`working\`) and what each owns, your claims and sessions, whether Stop is pressed.
It is the one tool that answers while Stop is pressed.

## Tabs
- A tab is addressed by a **G9BrowserAgent tab handle** (\`tabId\` from \`browser_tabs action:"list"\`), shared
  by all engines — not a Chrome tab id — or by a **session** name. Without either, a call acts on YOUR current tab.
- \`browser_tabs action:"open" url:"…"\` opens a tab (in the user's browser when the extension is connected,
  else a launched browser; \`engine\` chooses) and makes it your current tab. \`action:"attach"\` takes the tab
  the user is looking at.
- **Background tabs in the user's browser**: \`open\` creates a BACKGROUND tab there. It can be read (snapshot,
  console, network, viewport screenshot) but not clicked or typed into, because a browser delivers input only
  to the tab it is showing. Pass \`focus:true\` to \`open\`, call \`action:"focus"\` before the first click, or let
  \`browser_interact ifHidden:"focus"\` (or "popout") do it. A launched engine gives every tab its own window.
- \`action:"session" name:"buyer" url:"…"\` names a tab (opens it with url); every tab tool then takes
  \`session:"buyer"\`. \`sessions\` lists the names, \`end_session\` forgets one (the tab stays open).
- \`action:"wait"\` waits for a popup or new tab by \`url\`/\`title\`/\`openerTabId\`.

## When you are done
\`browser_tabs action:"finish"\` — guide "sharing".

Next: "perceive" (reading a page), "act" (input), "debug" (what is wrong with a page).
`),

  perceive: G('Reading a page cheaply', 'Snapshots and refs, finding one control, screenshots only when needed.', `
# Reading a page

## browser_snapshot — your primary sense
The accessibility tree with a \`[ref=eN]\` handle on every interactive element: cheap, semantic, stable. Pass
the refs to \`browser_interact\`. Refs belong to the TAB, not to you: numbering continues across snapshots of a
page (e1…e30, then e31…), and each caller's last four snapshots of that page stay usable, so another agent's
snapshot never renumbers yours. A ref from an older snapshot, from another page, or of an element the page has
removed is refused — take a fresh snapshot. After a navigation or a big DOM change, take one anyway.

## Read less (tokens)
- \`scope\`: only a subtree (a ref like "e12", or a CSS selector).
- \`roles:["button","link"]\`, \`name\` (a case-insensitive regex; \`exact:true\` compares literally,
  \`matchCase:true\`), \`interactiveOnly:true\` — flat lines, each with a ref.
- \`includeText:false\` drops named content beyond controls; \`maxNodes\` caps the output (default 900).
- \`diff:true\`: only what changed since YOUR previous diff snapshot of that page with the same options
  ("+" added, "~" changed, "-" removed). The first one returns the full tree.
- \`mode:"a11y+text"\` adds all visible text when you need prose.

## One control on a big page
\`browser_inspect what:"find" role:"button" name:"save"\` returns just the matching lines with refs —
cheaper than any snapshot. Or skip refs entirely: \`browser_interact\` takes role+name or a selector.

## Screenshots — sparingly
\`browser_screenshot\` only for what the tree cannot answer: rendering, spacing, canvas, visual judgement.
\`area:"viewport"\` (default) is a read. \`area:"element"\` (with ref) and \`area:"fullpage"\` are ACTIONS:
they scroll or resize the page, so they claim the tab and queue (and fullpage is refused at stealth). An element
capture shows the element as far as it is on screen; the result's \`cropped\` gives its full size.
\`savePath\` writes the image on the browser's machine instead of returning it (\`thumbnail:true\` for a small
look). Oversized full pages are scaled down, never cropped.

## Inside the page (DevTools panels)
\`browser_inspect what:\` "dom" (\`depth\`), "styles" (\`properties\`, \`all\`), "box" (geometry, visibility),
"storage" (\`kind\`: local/session/indexeddb/cache/serviceworker), "cookies" (HttpOnly included; \`url\` for
another site), "frames" (the iframe tree). Target with \`ref\` or \`selector\`.
`),

  act: G('Acting on a page: input, waits, dialogs', 'Clicking and typing reliably, proving delivery, waiting on conditions.', `
# Acting on a page

## browser_interact
Real, trusted browser input (isTrusted === true), human-like by default.
- **Target**: \`ref\` from a snapshot, or without one \`role\` (+ \`name\` regex) or \`selector\`; \`nth\` picks one
  when several match (several without nth are refused, never guessed). \`waitMs\` waits (max 60000) for a
  control that appears late; a covered or moving target is tried again until clickable — nothing is pressed
  meanwhile. Coordinates (\`x\`,\`y\`) only for canvas widgets.
- **Actions**: click, double_click, right_click, hover, type (\`text\`, \`clear\`, \`pressEnter\`, \`fast\`,
  \`typos\`), key (\`key\`, \`modifiers\`, \`repeat\`), scroll (\`direction\`, \`amount\`), drag (\`from\` + \`to\`,
  or \`toPercent\` along a slider/scrubber track, or \`toX\`/\`toY\`), select (\`values\`), upload, set_value.
- **set_value** sets a slider, checkbox, switch, radio, field or select to \`value\` and proves it
  (before, after, verified).
- **upload**: \`files\` (absolute paths on the BROWSER's machine), or the bytes: \`fileData:[{name, base64}]\`
  (up to 40 MiB a call), or \`fileUrls\`. No native picker opens; \`selector:"input[type=file]"\` names a hidden input.
- \`expectSamePage:true\` fails (code "navigated") when the action takes the page elsewhere.
- \`ifHidden:"focus"\`/\`"popout"\` brings a background tab of the user's browser forward instead of refusing.

## A dispatched action is not a delivered action
Every result carries \`delivery\`: "delivered" or "indeterminate". "not-delivered" (nothing reached the page),
"missed" (it reached a different element — the error names which) and "partial" (the tab became hidden
part-way) are errors whose text starts with a tag such as \`[delivery: missed; hit <div#x>]\`. Treat anything but
"delivered" as unproven: verify the effect (snapshot, a wait, the console) before relying on it, and never
blindly repeat a state-changing action whose outcome is unknown — check first.

## Navigation and waiting — never sleep
\`browser_navigate\`: goto (\`url\`, \`waitUntil\`), reload (\`hard\`), back/forward (\`steps\`), and **wait**:
\`text\`, \`selector\`, \`predicate\` (a page expression polled until truthy), \`ref\` + \`state\`
(visible/hidden/enabled/disabled/checked/unchecked/gone/present), \`idle\` (DOM quiet 500 ms, no request in
flight), \`gone:true\` to wait for something to disappear (spinners). \`timeoutMs\` up to 2 h for a wait.
\`leaveWithoutAsking:true\` passes a "Leave site?" prompt.

## Dialogs
An open alert/confirm/prompt/beforeunload freezes ITS tab: calls on it fail fast, naming the dialog, until
\`browser_dialog accept:true|false\` (\`promptText\` for prompt). Other tabs are unaffected.

## Many steps in one call
\`browser_recording action:"batch" steps:[…]\` — guide "recording".
`),

  console: G('Console: reading logs and running JavaScript', 'Read and filter console output, evaluate in the page, long jobs, debugging recipes.', `
# The console

## Reading
\`browser_console\` (action "read", the default) returns buffered console output: log, warn, error and uncaught
exceptions with stack frames. Capture starts when the tab is ATTACHED, not when it loaded.
- Filter: \`level:"error"\` or \`level:["error","warning"]\`, \`contains:"…"\`, \`limit\` (default 100).
- **Poll without re-reading**: each answer gives \`lastSeq\`; pass it as \`since\` next time to get only newer entries.
- **Before reproducing a bug**: \`clear:true\` empties the buffer, so what you read next belongs to your repro.
- A **stealth** context never enables the page runtime, so "read" reports page console capture as UNAVAILABLE
  there — it does not pretend the page was silent.

## Running JavaScript: action "evaluate"
\`expression\` runs in the PAGE's own main world: you are asking about the page's JavaScript, and the page can
see what you run. Async expressions are awaited. \`timeoutMs\` bounds the wait (default 20000; up to 4 h).
Return small values (\`JSON.stringify\` of what you need), not whole objects.

## Long work: jobs
\`evaluate job:true\` answers at once with a \`jobId\`; the job runs on in the page and survives your session
ending (not a navigation). Inside it, \`__g9job.progress(fraction, note)\` reports progress and
\`__g9job.signal\` is aborted by \`job_cancel\`. \`job_status jobId:"…" waitMs:…\` reads state, progress and the
bounded result (waiting up to 10 min); \`jobs\` lists them. For long in-page work in a background tab of the
user's browser, keep it awake: \`browser_tabs action:"keep_awake"\` (or \`open keepAwake:true\`).

## Debugging recipes
- **"It throws somewhere"**: \`browser_console clear:true\` → reproduce (interact) → \`browser_console
  level:"error"\`; the stack frames name the file and line. Read the state behind it with \`evaluate\`.
- **Page already open, console empty**: capture began at attach — \`browser_navigate action:"reload"\` and read
  again (say so first; a reload surprises people).
- **Watch something over time**: read once, keep \`lastSeq\`, then read with \`since\` after each step.
- **An error that only shows on load**: \`clear:true\`, reload, then read.
- Pair it with the network: guide "network"; the one-call overview is \`browser_diagnose\` (guide "debug").
`),

  network: G('Network: requests, failures, HAR, downloads, fetch', 'Read requests and bodies, break requests on purpose, freeze the network, prove downloads.', `
# The network

## Reading
\`browser_network\` (action "list", the default) lists requests: filter with \`filter\` (URL substring),
\`method\`, \`status\` ("failed" = network error or 4xx/5xx, "pending", or an exact code), \`limit\` (default 50).
Pass \`requestId\` for one request in full — headers, timing, POST body and response body (\`includeBody\`).
\`format:"har"\` returns a HAR 1.2 document. \`clear:true\` empties the buffer before a repro.
Capture begins when the tab is attached: an already-open page showing 0 requests needs a reload
(\`browser_navigate action:"reload"\`) and a second read.

## Break it on purpose: intercept
\`action:"intercept" rules:[…]\` makes chosen requests fail, stall or return your body — test the UI on a
500, a 429 or a timeout. Each rule: \`match\` (URL substring) and one outcome — \`status\` (+ \`body\`,
\`headers\`), \`abort\` ("TimedOut", "ConnectionRefused", "Failed", …) or \`delayMs\` alone; optional \`method\`,
\`times\` (fire N times: "the first save fails, the retry succeeds") and \`label\` (named in a response header,
so an injected 500 is never mistaken for a real one). Example:
\`[{ "match": "/api/orders", "method": "POST", "status": 500, "times": 1, "label": "first save fails" }]\`.
\`intercept_status\` shows the rules, \`clear_intercept\` removes them. Rules apply before a pinned HAR.

## Freeze the backend: record and pin
\`record_har\`, then \`pin har:{…}\` serves matching requests from that HAR (\`strict:true\` fails the rest), so a
remaining difference is the client's; \`unpin\`, \`pin_status\`.

## Downloads — proof a file was produced
\`watch_downloads\` BEFORE the click that starts one (each watch starts a fresh list), then \`wait_download\`
(\`contains\`, \`timeoutMs\`) returns the finished file: name, bytes (launched engines also sha256 and the type
sniffed from the content). \`downloads\` lists them, \`stop_downloads\` ends the watch. A download that fails
ends the wait at once with the reason.

## Fetch with the browser's cookies
\`action:"fetch" url:"…"\` (\`method\`, \`headers\`, \`body\`/\`bodyBase64\`) returns a bounded body (\`maxBytes\`,
default 262144) — or with \`savePath\` writes it on the BROWSER's machine and returns path, size, sha256 and
content type (up to 40 MiB). \`read_file path:"…"\` returns the bytes of a file G9BrowserAgent saved or downloaded
there, base64, in chunks (\`offset\`, \`length\`) — how to get a file off a remote browser node.
`),

  debug: G('Debugging a page end to end', 'The order to look in, and recipes for common defects.', `
# Debugging a page

## The order
1. \`browser_diagnose\` (what "health", the default) — one call that correlates actionable defects: console
   errors, failed requests, broken assets, unlabeled controls, overflow, duplicate ids.
2. The console for the errors behind it — guide "console".
3. The network for the failed or slow requests — guide "network".
4. The page itself: \`browser_inspect\` dom / styles / box / storage / cookies / frames — guide "perceive".
5. Performance when it is slow: \`browser_diagnose what:"performance"\` records a trace (\`durationMs\`,
   \`reload:true\` to cover page load); \`what:"vitals"\` Core Web Vitals and long tasks; \`what:"memory"\`
   samples heap, DOM nodes, documents and listeners (\`samples\` 2–10, \`intervalMs\`) for leak signals.

## Recipes
- **"The button does nothing"**: \`browser_console clear:true\` → click → \`browser_console level:"error"\` and
  \`browser_network status:"failed"\`. Check the click was delivered (\`delivery\`), and that the control is
  enabled and visible: \`browser_inspect what:"box" ref:"…"\`.
- **"The layout is broken"**: \`browser_inspect what:"styles" ref:"…" properties:["display","width",…]\` and
  \`what:"box"\`; \`browser_screenshot\` to see it; responsive sizes with \`browser_emulate device:"iphone-15"\`
  or \`width\`/\`height\`.
- **"It fails only on a slow or broken network"**: \`browser_emulate network:"slow-3g"\` (or "offline"),
  \`cpuThrottle:4\`; or one request failing: \`browser_network action:"intercept"\`. \`browser_emulate reset:true\`
  clears every override.
- **"The page leaks"**: \`browser_diagnose what:"memory"\` before and after repeating the flow several times.
- **"Data is wrong"**: \`browser_network requestId:"…"\` for the response body; \`browser_console
  action:"evaluate"\` for the page's state; \`browser_inspect what:"storage"\` for what the page stored.

## Things that look like bugs but are not
- An empty console or network list on a page that was open before you attached: reload and read again.
- A stealth context cannot read page console output (it says so).
- \`browser_emulate\` device presets change the user agent and are refused on a stealth tab.
`),

  sharing: G('Sharing the browser: ownership, Stop, finishing', 'Claims and queues between agents, Stop, calls that outlive the client, and finish.', `
# Sharing the browser

There are no modes and no allowlists: attach means full access, and every tab's title and URL is visible.
Other agents may be connected to the same browsers.

## Ownership
- Your first state-changing call on a tab CLAIMS it. A state-changing call on a tab another agent owns is
  refused with that agent's name. Reads (snapshot, console/network reads, inspect, a viewport screenshot) are
  always allowed.
- \`browser_tabs action:"release"\` frees a tab you are done with (in the user's browser it also detaches the
  debugger; \`detach:false\` keeps it). Take a tab over only when the user asks: \`action:"claim" force:true\`.
- A claim whose owner sent nothing for 15 minutes lapses for the next agent.
- State-changing calls on one tab run one at a time, yours included; reads run at once. A call that hits its
  deadline is asked to stop and the tab's queue is held until it has; if it does not stop in time the error
  says it may still be running — take a snapshot before sending that tab anything else.

## Stop
The user can press Stop (side panel or desktop app), for everyone or just for you. Every tool except
\`browser_status\` then fails with that reason. You cannot lift it: stop working and tell the user.

## Finishing — browser_tabs action:"finish"
Call it when your task is done. It releases every tab you own and marks you as no longer working. When no
OTHER agent is working, it also detaches the debugger from every tab of the user's browser, so its "started
debugging this browser" bar goes (a tab the user watches live, one another agent owns and one with a recording
running stay attached). While another agent still works, the debugger stays for it and the result names who;
the last agent to finish lets go. Nothing is closed, and any later call attaches again where it needs to. An
agent counts as working from its first call (other than \`browser_status\`) until it finishes, or until it
has been idle for 15 minutes. If the last working agent disconnects without finishing, the daemon detaches
the user's browser after a one-minute grace (a new call within it cancels that).

## Calls that outlive your client
- \`opId\` (any tool): your idempotency key, e.g. "publish-post-42" — the same opId is never acted on twice; a
  resend returns the first outcome.
- \`replyWithinMs\`: answer \`{pending:true, callId}\` by then while the call goes on. Set it below your
  client's own timeout for slow actions.
- \`browser_status callId:"…" waitMs:…\` says how a call ended (also one answered "may still be running" that
  finished later); \`browser_status calls:true\` lists your recent calls. Check before you repeat an action.
- A call stuck past its deadline is ended and its tab RECOVERED (the error starts with [recovered]): take a
  snapshot first. \`browser_tabs action:"close"\` never waits behind a stuck call.
- Stateless HTTP clients: a new MCP session with the same client name (or X-G9-Agent header) takes over the
  previous session's tabs; current tab and session names keep working.
`),

  background: G('Background work: launched browsers, handoff, popout', 'Work that goes on while the user uses their computer; engines, profiles, live view.', `
# Background work

## Launched browsers (Engine 2) — browser_engine
- \`launch\` (\`browser\` auto/edge/chrome/cft, \`headless\`, \`profile\`, \`stealth\`, \`proxy\`, \`locale\`,
  \`timezone\`, \`windowSize\`) — you rarely need it: \`browser_tabs action:"open"\` launches the default engine
  on demand. \`list\` shows every engine; \`stop\` closes one (refused while another agent owns a tab in it or
  holds it, unless \`force:true\` — only when the user asked).
- A **profile** keeps cookies and history between runs (one browser at a time per profile). \`warm\` opens a
  profile HEADED so the user can sign in once.
- \`context\` makes an isolated context (own cookies; optional proxy, locale, timezone, stealth).
- \`acquire\`/\`release\` hold an engine across your tabs, so a long run is not stopped by another agent finishing
  first (\`launch lease:true stopWhenReleased:true\` stops it once the last holder releases it).
- \`versions\` lists installed browsers and the pinned Chrome for Testing (\`download:true\` fetches it).
- A HEADLESS engine has no window, so minimising or covering the user's windows does not affect it (a locked
  session has not been measured). A HEADED one must not be minimised: a click then takes about 28 s.

## Moving a tab out of the user's way
- \`browser_tabs action:"handoff"\` moves a tab from the user's browser into a launched browser: cookies and
  local/session storage travel (\`includeStorage\`), the PAGE RELOADS there, and in-memory state, IndexedDB and
  service workers do not. The result is a new tab handle; continue there. With \`profile\` the cookies are
  written into that profile, so the login stays for later runs. The user's own tab is untouched.
- \`browser_tabs action:"popout"\` (user's browser only) moves a tab into its own window without reloading it,
  unfocused unless \`focus:true\`; the result says whether the page is \`visible\`. That window must not be
  minimised; when \`visible\` is false, "focus" it.
- \`keep_awake\` keeps a background tab working (focus emulation, page lifecycle active).

## Letting the user watch
\`browser_tabs action:"watch"\` opens a LIVE VIEW of a tab in the user's browser (frames and your cursor, view
only) — the way to show a headless tab; \`on:false\` closes it.
`),

  stealth: G('Human input and stealth', 'Humanize levels, the two halves of stealth, reproducible motion, emulation caveats.', `
# Human input and stealth

## humanize (per call)
Input defaults to "human": curved pointer paths, human timing, wheel notches, per-key typing with rare
corrected typos (never in password fields). \`humanize:"off"\` gives instant direct events (fast, obviously
scripted). \`humanize:"stealth"\` is human plus nothing that needs the page's JS runtime. A calibrated profile
name also works (guide "recording": calibrate_humanize).
A tab's stealth level is a FLOOR: a call can ask for stricter input, never looser; the result's
\`humanize.raisedFrom\` says when it was raised. In the user's browser the side panel's Input setting is the
default level; only its Stealth setting is also a floor.

## Stealth has two halves
- The ENVIRONMENT half belongs to the browser: \`browser_engine action:"launch" stealth:"stealth"\`. Only that
  clears \`navigator.webdriver\` and leaves Widevine in place.
- A CONTEXT's stealth adds the rest: the page's JS runtime domain is never enabled (so \`browser_console\`
  cannot read page console output there, and says so) and input keeps the stealth floor. In an engine launched
  below stealth such a context still reports \`navigator.webdriver\` true, and its result says so.

## Reproducible motion
\`seed\` reproduces a run's motion from the same pointer position and viewport; a replay homes the pointer and
reports \`pointerStart\`, so replaying with the reported seed reproduces it.

## Emulation is not stealth-safe
G9BrowserAgent never overrides the user agent on its own. \`browser_emulate\` device presets do (with Client
Hints), and an emulated locale changes Intl while navigator.languages stays the profile's — both are refused on
a stealth tab; use a launched engine with that locale instead. \`reset:true\` restores the browser's own.
`),

  recording: G('Recording, replay and regression memory', 'Record flows, batch steps, replay as tests, known world and surprises, approvals.', `
# Recording, replay and regression memory

## Many steps in one call: batch
\`browser_recording action:"batch" steps:[…]\` runs steps in order and stops at the first failure with an
excerpt of the page there (\`continueOnError:true\` runs on). Steps: "navigate" {url}; "click", "double_click",
"right_click", "hover", "type", "key", "select", "scroll" with a ref or role + name (and the browser_interact
options); "wait" with the browser_navigate wait options; "evaluate" {expression}; "extract" {ref | selector |
role+name} → the element's text. \`saveAs:"x"\` keeps a value for {{x}} in later steps.

## Recording a flow
A person records in the side panel, or you call \`start\` (\`name\`) / \`stop\`. Each element is stored with several
independent locators, so a step survives a redeploy; replay reports WHICH locator matched (a step that matched
only by xpath passes with a warning), and a failing step says what it looked for, what it tried and the closest
thing on the page. Without a tab, \`list\` shows the recordings of every engine's store (\`engine\` field), and
id-based actions use the store that has the id.
Then make it a test:
1. Right after stopping, \`action:"suggest"\` proposes assertions from what was observed. It adds NOTHING — you
   and the user choose, then \`action:"assert"\` (\`atStep\`, \`assertion\`: url, text, visible, value, state,
   network, console, a11y, screenshot, aria — prefer "aria" for regression). A flow with no assertion is a
   macro, not a test.
2. \`action:"calibrate"\` once per flow: two runs on one build, the differences marked volatile.
3. \`action:"replay"\` (\`id\`) with \`seedKnownWorld:true\` the first time. \`timing\`: "recorded" (default, the
   person's pace), "adaptive", "fast". \`dryRun:true\` only resolves elements — the cheapest rot check.
   \`engine:"launched"\` runs it in a launched browser.

## Regression memory — the part that is not obvious
Every replay builds a signature (requests, console, the semantic tree, step timings) and compares it with the
flow's approved **known world**. Anything outside it is a *surprise*, both ways: **new** (an error, request,
dialog or control never seen before) and **missing** (something that happened on every previous run and not
now — the quiet failures). Verdicts: PASS, PASS_WITH_WARNING, SURPRISE, FAIL_PRODUCT, FAIL_AUTOMATION.
FAIL_AUTOMATION means the test broke, not the product — say which you report.
After a run whose surprises are all legitimate, the USER decides and calls \`action:"approve"\` (\`by\`, \`note\`,
\`expectLastRunAt\`). **Never approve on your own initiative** — that is how a real regression becomes the baseline.
When the flow lives in the project repository, approve also writes the approval next to it.

## Moving flows
\`export_spec\` / \`import_spec\` move a flow as a Git-diffable FlowSpec with its approval beside it; \`export\` /
\`import\` move bundles. \`calibrate_humanize\` fits a humanize profile from a recording's raw input.
`),

  issues: G('Capturing defects and suggestions', 'Issues with evidence, attachments and video; feedback about G9BrowserAgent itself.', `
# Defects and suggestions

## browser_issue — a defect with its evidence
\`create\` (\`title\`, \`body\`, \`severity\`, \`withScreenshot\`) records the URL, previous page, console tail,
failed requests and viewport at the moment the bug is visible. \`screenshot\` and \`attach\` (\`name\`, \`mime\`,
\`dataBase64\`) add attachments; \`video_start\`/\`video_stop\`/\`video_status\` record the tab. \`list\`/\`get\` read
them back (\`attachment\` with \`attachmentId\` for the bytes); \`update\` (\`status\`, \`filedAs\` once it is in a
tracker, so it is not filed twice). Without a tab, \`list\` shows the issues of every engine's store. Write the
ticket from the issue instead of asking the user to repeat it.

## Feedback about G9BrowserAgent itself (this version)
When a tool gets in your way, is missing, behaves unexpectedly, or a workaround costs you time, send it right
away: \`browser_issue action:"feedback" title:"…" body:"…"\` (optional \`category\`: feature, bug, improvement,
docs, other; \`tool\`). Say what you were doing, what you needed, what happened and what would have helped — no
site names, secrets or personal data. One suggestion per point, as it happens; at most 5000 characters each.
`),

  limits: G('What cannot be done', 'Browser-internal pages, native dialogs, and other hard boundaries.', `
# Boundaries

- Browser-internal pages (chrome://, edge://, the web stores, other extensions) cannot be controlled — a
  browser rule, not a setting.
- Native OS dialogs (print, basic auth, the file picker) are outside the page; upload files with
  \`browser_interact action:"upload"\`.
- In the user's browser a background tab can be read but not clicked (guide "start").
- A stealth context cannot read the page's console output (guide "stealth").
- An argument a tool does not take is refused with the closest real one ("did you mean scope?").
`),
};

/** The topics in reading order. */
export const GUIDE_TOPICS = Object.keys(GUIDES);

/** The index: one line per topic and the per-tool reference. */
export function guideIndex() {
  return [
    '# G9BrowserAgent guides',
    '',
    'Read the guide for the work you are about to do: `browser_status guide:"<topic>"` (or the resource `g9://guide/<topic>`).',
    '',
    ...GUIDE_TOPICS.map((key) => `- **${key}** — ${GUIDES[key].summary}`),
    '',
    `Per-tool reference (every action and argument): \`browser_status guide:"tool:<name>"\` (or \`g9://tool/<name>\`), for ${TOOLS.map((t) => t.name).join(', ')}.`,
  ].join('\n');
}

/** Layer 3: every action and argument of one tool, generated from its schema. Null for an unknown tool. */
export function toolReference(name) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const typeOf = (p) => {
    if (p.enum) return p.enum.map((v) => JSON.stringify(v)).join(' | ');
    if (p.anyOf) return p.anyOf.map((a) => (a.type === 'array' ? `${a.items?.type ?? 'any'}[]` : a.type)).join(' | ');
    if (p.type === 'array') return `${p.items?.type ?? 'any'}[]`;
    return p.type ?? 'any';
  };
  const lines = [`# ${tool.name}`, '', tool.description, '', '| Argument | Type | Default | Meaning |', '|---|---|---|---|'];
  for (const [key, p] of Object.entries(props)) {
    const def = p.default !== undefined ? JSON.stringify(p.default) : '';
    lines.push(`| \`${key}\`${required.has(key) ? ' (required)' : ''} | ${typeOf(p)} | ${def} | ${String(p.description ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  }
  if (tool.annotations?.readOnlyHint) lines.push('', 'Read-only: never claims a tab.');
  return lines.join('\n');
}

/**
 * What `browser_status guide:"…"` and the g9:// resources return: "index" (or ""), a topic, or "tool:<name>".
 * An unknown name is answered with the index and what was asked, never an error an agent has to recover from.
 */
export function readGuide(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key || key === 'index') return guideIndex();
  if (key.startsWith('tool:')) {
    const ref = toolReference(key.slice(5).trim());
    if (ref) return ref;
  } else if (Object.hasOwn(GUIDES, key)) {
    return GUIDES[key].text;
  }
  return `No guide named "${name}".\n\n${guideIndex()}`;
}
