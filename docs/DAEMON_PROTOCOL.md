# g9d protocol (v2)

The local daemon `g9d` listens on `127.0.0.1:${G9_PORT:-8765}`. Everything that talks to it — MCP
shims (one per AI agent), the runner, the desktop app and the extension — uses this protocol over one
WebSocket each. Messages are single JSON objects in text frames. Maximum frame (and reassembled
message): 64 MiB. Implementation: `daemon/` (entry `daemon/g9d.mjs`), shim `mcp/shim.mjs`, Node client
`lib/ws-client.mjs`.

***(3.2)*** The daemon never leaves loopback. Agents on other machines reach it through
`mcp/http.mjs` (MCP over HTTP, with a bearer token; see ARCHITECTURE_V2 §10). To the daemon, each MCP
session there is an ordinary `agent` connection: its own WebSocket, hello and name. Nothing on this
wire changed for it. The close reason of an agent's socket is logged ("MCP session ended", "…idle",
"shim exiting").

**Synced with the code on 2026-09-26 (v3.2.0: the HTTP front end above, viewers and the watch window §10, flow libraries per project and site, approvals beside flows §5; 3.1.0 added the reload-on-connect note; 3.0.0 was the side panel, U1–U10 in AIGuide §6.10).** Every message, field and
default below was re-read from `daemon/`, `mcp/shim.mjs`, `extension/sw.js` and `extension/lib/transport.js`.
Text marked ***(as built)*** records something the implementation has that this document did not say;
the rest was already accurate or has been corrected in place. Text marked ***(v3)*** was added for the
v3 side panel (U1–U10, AIGuide §6.10): the `projects` message and the richer `agents` rows (§5).

## 1. Transport

* `GET /health` → `200 {"ok":true,"name":"g9d","version":"3.2.0","installId":"…","pid":123,"port":8765,"home":"…",
  "engines":2,"agents":3,"extension":true,"launched":1,"activeRuns":[{"runId":"…","kind":"schedule",
  "label":"…","startedAt":…}],"startedAt":…,"uptimeMs":…}`. `engines` counts extension and launched
  engines; `launched` only launched ones (a restart would close them); `activeRuns` is every evidence run
  still open (replays, calibrations, scheduled runs, UI watches) — what the desktop checks before restarting
  a daemon it is not connected to for an update. ***(3.1.0)*** `installId` names the installation the
  daemon runs from (`lib/runtime.mjs installId`: the `.AppImage` file for a Linux AppImage, else the
  resource root, with forward slashes), so the desktop app can tell "same version, other install"
  (two copies of G9BrowserAgent) from its own daemon. CORS header only for extension origins. Any other HTTP
  path answers 426.
* `GET /g9` (or legacy `/agent`) with `Upgrade: websocket`. Any other path → 404; an upgrade without a
  `Sec-WebSocket-Key` → 400. ***(as built)*** A body that `/health` cannot build is answered `{ok:false, error}`
  (still 200).
* **Origin rule:** refuse `Origin: http://…` and `https://…` (a web page) with 403 — including pages
  served from `127.0.0.1`/`localhost`, and any scheme not listed here. ***(as built, 2026-09-22)***
  the literal `Origin: null` is refused too (`kind: 'opaque'`): a sandboxed iframe on a loopback page
  and a `file://` page send it, and native clients send no Origin header at all. Accept
  `chrome-extension://…`, `edge-extension://…`, `extension://…`, `moz-extension://…`, and a MISSING
  Origin (native clients: shim, runner, desktop main process). No token.
* **The `ui` role needs a native connection** ***(as built, 2026-09-22)***: a hello with `role:"ui"`
  on a connection that carried any Origin header is refused with `welcome.problem` and close code
  4003. Admin ops configure the daemon — the desktop's update feed among them — and a browser
  extension is an engine or an agent, never the desktop.
* ***(3.2)*** **The `viewer` role** (the extension's watch window, `panel/watch.html`) is accepted from an
  extension origin or a native connection. It may send only `{type:'viewer'}` messages (§10): list
  tabs and watch them. Any other message from a viewer — `call`, `admin`, `flowlib`, `request` — is
  answered `{type:'viewerResult', id, ok:false, error}` and does nothing.
* Keep-alive: either side may send `{"type":"ping","at":n}`; the other answers `{"type":"pong","at":n}`.
  The daemon answers pings immediately, ahead of any queued work. The extension pings every 20 s (MV3
  worker lifetime).
* A malformed or oversized frame closes that connection (1009); the daemon keeps running.
  ***(as built)*** A well-formed text frame that is not a JSON object is ignored, and the connection
  stays open.

Close codes the daemon uses:

| code | meaning |
|---|---|
| 1000 | normal |
| 1001 | daemon shutting down |
| 1009 | protocol error (malformed/oversized frame) |
| 4000 | the first message was not `hello` (or none within 10 s) |
| 4001 | wrong client version (a v1 extension) — reload the v2 extension |
| 4002 | unknown role |
| 4003 | `role:"ui"` from a connection with an Origin header (admin is for native clients) |

## 2. Handshake

First frame from the client, within 10 s:

```json
{ "type": "hello", "role": "agent" | "engine" | "ui" | "viewer", "version": "3.2.0",
  "client": { "name": "claude-code", "pid": 4242, "browser": "Edg/153.0…", "cwd": "G:/proj", "project": null } }
```

An extension (role `engine`) also sends, in `client`: `extensionId`, and — decision D-c —
`instanceId` (random, generated once and kept in `storage.local`), `loadId` (kept in `storage.session`:
the same across service-worker restarts, new after an extension reload or a browser restart) and
`tabs: [{ tabId, url }]` (its open tabs, Chrome ids).

**Engine identity across reconnects (D-c).** An extension engine that disconnects and has an
`instanceId` is *parked*, not dropped, for `G9_ENGINE_RESUME_MS` (default 600 000 = 10 min; 0 drops at
once, as does an extension without `instanceId`): its tab handles, the agents' claims on them, session
names and agents' current tabs stay. When the same `instanceId` says hello within that time it gets the
**same engine id** (`welcome.id`) and handles back. Each parked handle is checked against `client.tabs`: a
tab that no longer exists is dropped; when `loadId` changed (an extension reload or a browser restart —
Chrome numbers tabs anew after a restart) a handle is also dropped unless its tab still shows the page the
daemon last saw there (fragment ignored); without a tab list and with another `loadId`, nothing is kept.
Dropped handles take their claims and names with them, as any closed tab does. A hello that arrives while
the old socket of the same `instanceId` is still registered **supersedes** it: its pending calls fail now,
and it is closed (1000, "superseded by a new connection from the same extension"); anything it still sends
is ignored. An extension whose socket is closed with that reason does not reconnect by itself (it would
take the identity back — two browsers sharing a copied profile would displace each other in turn); the
panel's Reconnect does. After a resume, the daemon re-sends `{type:'watch', on:true}` for every watched tab of that
engine (live views lived in the old worker). While parked, a call on its tab fails with "Tab N is in a
browser whose G9BrowserAgent extension is reconnecting …"; `browser_tabs list` lists its tabs with `reconnecting:true`
(and the last URL seen), and `engines` rows carry `reconnecting:true, parkedAt, resumeUntil`.

* `role: "runner"` is accepted as an alias of `agent` (the runner is an agent like any other).
* An agent's `client.cwd` (and optional `client.project`, the value of `G9_PROJECT`) selects the
  project adapter (`g9.project.json`) reported to that agent in `welcome` and `browser_status` — one
  daemon serves agents working in different repositories. ***(v3)*** Its environments' hosts reach
  the extensions in the `projects` push, and its folder name in the `agents` rows (§5).

A v1 extension sends `{"type":"hello","role":"extension",…}`; the daemon treats `extension` as
`engine`, and if the version major is < 2 it answers `{"type":"welcome", …, "problem":"…"}` and closes
the socket with code 4001 and a reason naming the fix (reload the v2 extension).

Reply:

```json
{ "type": "welcome", "version": "3.2.0", "installId": "…", "daemonPid": 123, "bootId": "4f2c…", "startedAt": 1758…,
  "id": "agent-3",
  "repoRoot": "G:/…", "project": { "found": true, "path": "…", "environments": {}, "flowsDir": "…" },
  "halted": { "global": false }, "port": 8765, "home": "C:/Users/…/AppData/Local/G9BrowserAgent" }
```

`id` is `agent-N`, `engine-N` (extension engines; launched engines are `launched-N`) or `ui-N`.
***(as built, 2026-09-22)*** `bootId` (random per daemon process, with `startedAt`) names the daemon
INSTANCE. Tab handles are only meaningful within one: every daemon numbers them from 1 again, so a
client that kept handles across a restart must drop them. The desktop compares `daemonPid:bootId` and
drops its watches when it changes — it used to re-watch handle 3 of the old daemon and stream
whatever tab the new one had numbered 3.
When the global halt is on, `halted` also carries `by` (`"panel"` | `"desktop"`), and an engine
receives `{type:'halt', halted:true}` right after the welcome.

## 3. Calls (agent, ui → daemon)

```json
{ "type": "call", "id": 17, "tool": "browser_snapshot", "args": { "tabId": 5 }, "caller": { "name": "cursor" } }
{ "type": "result", "id": 17, "ok": true, "result": { … } }
{ "type": "result", "id": 17, "ok": false, "error": "Tab 5 is owned by agent-2 (cursor) …" }
```

`caller` is optional; the shim adds `caller.name` from the MCP `clientInfo` and the daemon uses it as
the agent's display name ("agent-2 (cursor)"). Engines do not make calls.

An input action that failed with a delivery state (`browser_interact`: `"not-delivered"`, `"missed"`,
`"partial"`) carries it twice: its `error` text starts with a tag — `[delivery: missed; hit <div#veil>] …`,
`[delivery: not-delivered; tab hidden] …`, `[delivery: partial; 3 of 12 input events sent; tab hidden] …`
— which is what an MCP client shows the agent, and the result carries the fields for programs:

```json
{ "type": "result", "id": 18, "ok": false, "error": "[delivery: missed; hit <div#veil>] The click reached the page, but not …",
  "delivery": "missed", "hit": "<div#veil>", "hidden": false }
```

Timeout per call: `G9_TIMEOUT_MS` (default 120 000 ms) as a floor, raised for calls that ask for more:
`browser_recording` replay/calibrate 30 min; `browser_navigate` its `timeoutMs` (default 30 s goto, 15 s
wait) + 15 s; `browser_tabs` wait its `timeoutMs` + 15 s, open/session/handoff 3 min; `browser_network`
wait_download its `timeoutMs` + 15 s; `browser_diagnose` performance its `durationMs` + 60 s;
`browser_engine` launch/warm 3 min, versions with `download:true` 30 min; ***(as built, 2026-09-22)***
`browser_interact` the base plus its own typing time (450 ms per character of a `type` that is not
`fast`, and per repeat of a `key` beyond the first) — a flat 120 s ran out at roughly 650 characters of
humanized typing, and the call then kept typing into whatever the next call focused. A call whose
engine disconnects fails immediately with the reason.

***(as built, checked 2026-09-25)*** Where the daemon enforces this table: on every call it relays to an
extension (§4) and every call it runs on a launched engine's tab. What the daemon answers itself runs
without a daemon deadline — `browser_engine`, a `browser_tabs open` or `session` that opens in a
launched engine, and the import half of a handoff — and so is not cancelled; the shim stops waiting
for any call at this table's value + 30 s (`mcp/shim.mjs`). Internal relays set their own: a handoff's
`handoff_export` gets the base, `browser_status` gives the extension 20 s and `browser_tabs list` 15 s
per extension.

***(as built, 2026-09-22)*** **A call that reaches its deadline is CANCELLED, not abandoned.** The
daemon aborts it (Engine 2: an `AbortSignal` the tool layer binds to the tab, so `lib/humanize.js
perform` stops between input steps, exactly as Stop does; Engine 1: a `{type:'cancel', id}` frame,
§4) and holds that tab's queue for up to 5 s more, until it has stopped. An answer within that grace
says what was sent (`"browser_interact" did not finish within 120s, so G9BrowserAgent stopped it: …`); if it does
not stop, the answer says the call may STILL be running and the next call on that tab could overlap
it. A call still waiting for a maxParallel slot when its deadline passes is removed from the queue
and answered `[delivery: not-delivered] … waited Ns for one of maxParallel=K slots … nothing was sent
to the page` — it never runs later.

### 3.1 What the daemon answers itself

* `browser_status` — the daemon's view (`daemon`, `you`, `owned`, `halted{global,by?,mine}`,
  `agents[]`, `engines[]`, `sessions[]`, `engine`, `capabilities{}`, `hint`) laid over the relevant
  engine's own status (its `current` tab, `health`, …; tab ids rewritten). ***(as built)*** Exact shape:
  `daemon {version, pid, port, home, uptimeMs, project, flowLibrary, projectProblems?}`, `you {agentId, name,
  current}`, `owned [handles]`, `halted {global, by?, since?, mine}`, `engine {engineId, kind} | null`,
  `capabilities {…the engine's own, extension, launch, launchUnavailable?, handoff, popout, maxParallel,
  humanizeDefault, stealthDefault}` (configuration, not a probe), and when they apply `engineError`,
  `targetError`, `versionMismatch` (extension and daemon versions differ). `engines[]` rows: an extension
  `{engineId, kind:'extension', browser, version, connectedAt, tabs, versionMismatch?}`, a parked one
  `{engineId, kind:'extension', reconnecting:true, parkedAt, resumeUntil, tabs}`, a launched one its
  `EngineInfo` (ARCHITECTURE §7). The relevant engine is the
  engine of `args.tabId`/`args.session`, else of the caller's current tab, else the extension, else the
  first launched engine. When the caller has no current tab, the tab that engine reports as `current`
  becomes it. Answers while halted. `current` always describes the tab the status is ABOUT (the asked
  tab, else the caller's current tab): the daemon passes that handle to the engine as `tabId` (a Chrome
  id after the relay's rewrite), and the engine (`extension/tools/index.js status(args)`, F4) reports that
  tab's `current` and `health`, and its own current tab, when different, as `engineCurrent`. A tab the
  engine no longer has gives `current:null` and the engine's `targetError`. Only if an engine ignored
  `tabId` (a mismatched build) and reported another tab does the daemon withhold that tab's `health`
  (`null`, with a `healthNote`) rather than show it as this one's. An unknown `tabId`/`session` is
  reported as `targetError`, never replaced silently by another tab.
* `browser_engine` — launch/list/stop/context/versions/warm on launched engines (EngineManager).
  ***(as built)*** Results: `list` → `{engines}` (the rows above); `launch` → `EngineInfo`; `stop` →
  `{stopped, closedOthersTabs?}`; `context {engineId?, proxy, proxyBypass, locale, timezone, humanize,
  stealth, downloadPath}` → `ContextInfo` + `warnings?` (a locale in another language than the profile's is
  refused at stealth); `versions {download?, version?}` → as admin `engines.versions`; `warm {profile =
  'automation', url?, browser?}` → as admin `profiles.warm`.
  `stop` refuses an extension engine (G9BrowserAgent never closes the person's browser), and refuses a launched
  engine in which another connected agent owns a tab (the refusal names them) unless `force:true`
  (logged, reported to UIs as `takeover` activity). One launch per profile at a time: a launch the
  daemon starts on demand (`open`, handoff, replay `engine:"launched"`) reuses the default engine,
  including one still starting.
* `browser_tabs`:
  * `list` — every tab of every engine, full titles/URLs, each row with `engine`, `engineKind`,
    `owner`, `ownerName`, `session`, `current` (the caller's current tab).
  * `open {url, engine?, context?, name?, focus?}` — default engine: the extension when one is connected
    and `engine` is not given, else a launched engine (the default one is launched, headless per
    settings, if none runs). The opened tab is claimed by and becomes the current tab of the caller.
    ***(as built)*** Result `{tabId, engine, contextId?, url, session?, current:true}` — and, in the
    person's browser without `focus:true`, `background:true` with a `hint`: the tab can be read but not
    clicked or typed into, because a browser delivers input only to the tab it shows (2026-09-22).
  * `close`/`focus` need an explicit `tabId` or `session`; ownership-checked and queued. ***(as built)***
    Results `{closed: tabId}` / `{…engine result, focused: tabId}`; `focus` also makes it the caller's current tab.
  * `attach` — the extension's current/active tab (or `tabId`), claimed and made current.
  * `claim {force?}` / `release` (no tabId: all of the caller's claims).
  * `popout {tabId|session, focus?, width?, height?, left?, top?}` — extension tabs only (a launched tab is
    refused: "launched engines have no windows"); ownership-checked and queued, then relayed as
    `browser_tabs {action:"popout", tabId, …}`. ***(as built, 2.0.3)*** An agent's popout window is created
    unfocused unless `focus:true`, and the person's window gets focus back only if the browser moved it;
    without `width`/`height`/`left`/`top` the window is half the source window's width and three quarters of
    its height, at its top-right. Result `{tabId, windowId, focused, visible, title?, note}`: `visible` is the
    page's `document.visibilityState` about 600 ms after the move (`null` when unreadable), and the note says
    that a completely covered window stops rendering on Windows unless the `WindowOcclusionEnabled` policy is
    off. The side panel's own Pop out is a panel command, not this call (ARCHITECTURE §13).
  * `handoff` — extension → launched engine (see §3.2).
  * `session {name, url|tabId}` / `sessions` / `end_session` — names live in the daemon and resolve to
    handles on every tool (`args.session`). A session with a url re-points its existing tab instead of
    opening a second one. `end_session` forgets the name; the tab stays open.
  * `wait` — routed to the engine of `openerTabId`, else of the current tab, else the extension.
* `browser_recording` / `browser_issue` without a page (`list`, `get`, `update`, `delete`, `export`,
  `import`, `export_spec`, `import_spec`, `approve`, `known_world`, `signature`, `calibrate_humanize`,
  `attach`, `attachment`, …) — `list` merges the extension store and the launched-engine store, each row
  labelled `engine: "extension" | "launched"` (***(as built)*** plus `usage` from the extension store and
  `problems` naming a store that could not be read); id-based actions try the store of the caller's current
  tab first, then the other (`args.engine` pins one); `import`/`import_spec` write to one store only.
  `import_spec` into the launched store keeps the recording's local truth (known world, run history,
  flakiness, last signature) when the id already exists — ***(as built)*** the result's `keptLocal` names the
  fields kept. `calibrate_humanize` with `name` saves the
  fitted profile in the store of the engine that fitted it and in the launched-engine store (where
  unattended runs look it up); the result's `saved:{name, engines}` and `note` say where it landed.
* `browser_recording action:"replay" engine:"launched"` on a non-launched target opens a tab on the
  recording's `startUrl` in a launched engine (launching one if needed); the result then carries
  `ranOn:{tabId, engine, openedForThisReplay:true}`. Any replay on a launched tab first copies the
  recording from the extension store (relay `get`) if the launched store lacks it.
* `engine:"extension"` on any page tool without `tabId`/`session` acts on the extension's tab (the
  caller's current tab when it is there, else the extension's current tab), even when the caller's
  current tab is a launched one.

Every other tool: target handle (`args.tabId` → `args.session` → the caller's current tab → the
default engine's current tab) → halt → ownership (mutating calls) → per-tab queue (mutating calls;
`browser_dialog` is exempt, it is how a queue stuck behind a dialog is freed) → Engine 1 relay (§4) or
Engine 2 in-process. The routing arguments `session`, `engine`, `context` are not forwarded.

### 3.2 Handoff

`browser_tabs action:"handoff" {tabId|session, engine?, context?, includeStorage=true, launch=true,
matchViewport=false}`: the daemon relays `browser_tabs {action:"handoff_export", tabId}` to the
extension (daemon-only action; result `{url, title, origin, cookies, localStorage, sessionStorage,
viewport, userAgent}`), then in a launched engine: a fresh browser context (unless `context`),
`Storage.setCookies` with the Chrome cookies converted (host-only cookies as `url`, domain cookies
with a leading dot, `sameSite` mapped, `SameSite=None` without `Secure` sent without the attribute,
expired cookies skipped), a one-shot `Page.addScriptToEvaluateOnNewDocument({worldName:'g9'})` that
seeds local/session storage in the top frame of that origin only, navigation, and removal of the
script after load. Result: `{tabId, engineId, contextId, url, title, transferred:{cookies,
localStorage, sessionStorage}, notTransferred:['in-memory page state','IndexedDB','service worker
state'], cookiesNotSet?, storageCheck?, warnings?, navigationError?, from, note}`. `storageCheck`
(`{sameOrigin, origin, localStorage, sessionStorage}`) counts, after load and in world `g9`, the seeded
entries that hold their value; a page that ended on another origin (a sign-in redirect) or did not load
is named in `warnings` and in `note`, which states what happened rather than what was intended. The
new tab is claimed by and current for the caller; the caller's claim on the source tab is released. The
user agent is never overridden.

## 4. Relay (daemon → extension engine)

```json
{ "type": "call", "id": 901, "tool": "browser_interact", "args": { "action": "click", "ref": "e7", "tabId": 1234 /* Chrome tab id */ },
  "caller": { "agentId": "agent-3", "name": "claude-code", "relayed": true } }
{ "type": "cancel", "id": 901 }
{ "type": "result", "id": 901, "ok": true, "result": { … } }
```

***(as built, 2026-09-22)*** `{type:'cancel', id}` asks the extension to stop a call it is running:
its humanized input stops between steps and the call answers with what was sent. The daemon sends it
when the call reaches its deadline, when a dialog blocks that tab, and when the user stops that
agent. An extension that does not know the message ignores it, as the protocol says for unknown types.

An engine's `ok:false` result for an input error carries the same `delivery`, `hit` and `hidden` fields
as §3, and the daemon passes them on to the caller.

`caller.relayed: true` (F7) marks every call the daemon sends to an engine (relayed to Engine 1 or run
in-process on Engine 2). The engine's activity record of such a call carries `relayed: true`, and the
daemon does not forward it to UIs: it reported the agent's call itself, so the desktop shows each call
once. The engine's records without the tag (the person acting in the side panel) are forwarded.

The daemon rewrites every numeric `tabId`, `openerTabId` and every element of `tabIds` — at any depth
— from daemon handles to Chrome tab ids on the way in, and back on the way out (unknown Chrome ids get
a new handle). A handle that belongs to another engine is refused before anything is sent. Store
actions are relayed without a `tabId`. Values under these keys are data and are never rewritten, in
either direction: `variables`, `bundle`, `spec`, `har`, `rules`, `expected`, `environment`,
`parameters`, `value` (e.g. `browser_console evaluate`), `json`, `dataBase64`.

## 5. Events

Engine (extension) → daemon `{type:'event', event, data}`:

| event | data |
|---|---|
| `dialog` | `{ tabId, type, message }` — the daemon fails every pending call on that tab with the dialog text, except `browser_dialog`. The v1 shape (`tabId` beside `data`) is accepted too; without a tabId, every pending call to that engine fails |
| `halt` | `{ halted: boolean, by: 'panel' }` — the panel's Stop/Resume; the daemon applies it globally and mirrors it to other extensions and to launched engines |
| `tabs` | `{ tabs: listTabs() rows }` — pushed on tab create/remove/update (debounced 250 ms). Treated as the complete list: handles of Chrome tabs missing from it are dropped (after a 3 s grace for handles the daemon learned a moment ago) |
| `activity` | one activity entry (for the desktop's activity view); an entry with `relayed:true` is the echo of a call the daemon sent and is not forwarded (F7) |
| `pointer` | `{ tabId, sample }` — only while a UI client watches that tab |
| `frame` | `{ tabId, data, metadata, at }` — only while a UI client watches that tab |
| `watchStatus` | ***(as built)*** `{ tabId, state: 'live'\|'idle'\|'hidden', visibility?, reason?, lastFrameAt?, at }` — is the watched picture live (`extension/lib/screencast.js watchdog`)? Sent on every change while a UI client watches that tab; forwarded to those UIs as the topic `watchStatus` |
| `download` | ***(as built)*** a `DownloadEvent` (ARCHITECTURE §3) — forwarded to UIs as `activity` `{kind:'download', engine, …}`; progress at most once a second per download |

***(as built)*** Any other event is forwarded to UIs as `activity` `{kind: <event>, engine, …}`. The
extension also sends a `tabs` list 250 ms after each `agents` message (the first moment after its welcome
that the daemon can take it).

Extension → daemon requests (answered with `{type:'response', id, ok, result|error}`):

| op | payload | purpose |
|---|---|---|
| `flowlib` | `{ op: projects\|list\|read\|write\|remove\|status\|suite\|readApproved\|writeApproved, flowId?, project?, site?, … }` | the flow library on disk — sent as `{type:'flowlib', id, op, flowId?, …}` → `{type:'flowlibResult', id, ok, result\|error}`. F5: `id` is only the sender's correlation id, echoed on the result; the flow `read`/`remove` are about is `flowId`. A v1-shaped message without `flowId` named the flow in `id`, and only then is `id` read as the flow. As a request the sub-op travels as `flowOp` (***(as built)*** `sub` is accepted too) and the flow as `flowId` (never `id`); an unknown op is refused by name. ***(3.2)*** **Which library:** `project` is the path of a `g9.project.json` from `projects` (the daemon's own project, the folder it was started in, and each CONNECTED agent's); without it, the daemon's own, as before — a path the daemon does not know is refused. `projects` → `{ default, projects:[{ name, path, root, flowsDir, own, agents, domains }] }`. **Which flows:** `site` (an origin, or `'none'` for flows with no http(s) start URL) narrows `list` and `status` to the flows whose `startUrl` is on it. `list` rows carry `startUrl`, `approvedAt`, `approvedBy`, `baselines` (from the sidecar); `status` also returns `approvalNewerInRepo` and `approvalNewerHere` (the local rows may carry `approvedAt`). **What a person approved** travels beside a flow file as a sidecar (`login.flow.json` → `login.approved.json` + `login.baselines/<step>.png`; format `g9-approved`, extension/lib/approved.js): `readApproved {flowId}` → `{ approved | null, images:{name: base64} }`; `writeApproved {flowId, approved, images}` writes it (canonical bytes; images no longer named are removed) and answers `{ written:true, file, changed, images, approvedAt }`, or `{ written:false, reason }` when the flow is not in that library — without `project` it goes to whichever library holds the flow (the daemon's own first). A sidecar is never listed as a flow; `remove` removes it with the flow |
| `handoff` | `{ tabId }` (Chrome id) | the panel's "Send to background" (caller: `side panel`, refused while halted) |
| `info` | — | `{ version, port, pid, agents:[…], engines, halted }` for the panel (***(as built)*** `engines` are the rows of §3.1 without `argv`; `halted` is the global `{halted, by, at}`; `agents` are the rows of the `agents` push below, v3 fields included) |

Daemon → extension:

| message | meaning |
|---|---|
| `{type:'halt', halted}` | mirror the global halt into the panel |
| `{type:'reload'}` | the extension folder was updated; call `chrome.runtime.reload()` when idle. Sent only when no relayed call is in flight (waits up to 60 s). ***(3.1.0)*** Also sent once, unasked, when an extension whose `hello` version is older than the daemon's connects while `G9_HOME/extension/manifest.json` already holds the daemon's version — the browser reconnected before an app update's refresh could reach it. Once per extension instance and version, never in a loop |
| `{type:'agents', agents:[{id,name,owned:[tabId…],halted,project,cwd,current,currentEngine}]}` | for the panel's agent list (Chrome tab ids of that browser); pushed on every change — a connect or disconnect, a claim or release, a rename, a halt, ***(v3)*** a change of an agent's current tab and a closed tab — at most once per 100 ms. ***(v3)*** `project`: the folder name of the agent's project (the folder holding its `g9.project.json`), else of its `client.cwd`, else `null`; `cwd`: `client.cwd` or `null`; `current`: the agent's current tab as THIS browser's Chrome tab id, or `null`; `currentEngine`: `'extension'` (that tab is in this browser), `'launched'` (an Engine 2 tab — `current` is `null`, and no title or URL is sent: engine rows carry none), `'elsewhere'` (a tab of another browser's extension — `current` is `null`) or `null` (no current tab). ***(3.2)*** `currentHandle`: the daemon's handle of that current tab when this browser cannot name it (`launched`, `elsewhere`) — what the panel's Watch opens the live view on |
| `{type:'projects', domains:[host…], projects:[{name, path, domains:[host…], agents:[agentId…]}]}` | ***(v3)*** the connected agents' project sites, for the panel's auto-attach "Project sites". Each project is one `g9.project.json` (`path`; `name` = its folder name) with the agents working in it; its `domains` are the hosts (`host[:port]`, lower case, default ports omitted) of its `environments` URLs — a string per environment, or the string values of an object per environment (`{dev:{baseUrl:"https://…"}}`); anything not an `http(s)` URL is ignored, and a project with no such URL is not listed. `domains` is the de-duplicated union over CONNECTED agents only (an agent without `cwd`/`project` has the daemon's default project, as in its `welcome`). Sent right after the welcome and whenever an agent connects or disconnects (at most once per 100 ms). A capture filter in the extension, never an access boundary |
| `{type:'watch', tabId, on:boolean}` | start/stop streaming frames + pointer for a tab; re-sent (`on:true`) for every watched tab when a parked extension resumes (D-c) |
| `{type:'openWatch', handle, engineKind, url, agent:{id,name}, focus}` | ***(3.2)*** an agent's `browser_tabs action:"watch"`: open the watch window (`panel/watch.html`) on that daemon tab handle, or add it to the one already open. Sent to the NEWEST connected extension only. Opened without focus (flashing in the taskbar) unless `focus` |
| `{type:'closeWatch', handle}` | ***(3.2)*** `watch` with `on:false`: take that tab out of the watch window. Sent to every connected extension |

Daemon → UI: `{type:'event', topic, data}`:

| topic | data |
|---|---|
| `activity` | `{ kind:'tool', agentId, name, tool, detail, ok, ms, at }`, engine activity (`{engine, …}`; Engine 2's carry `engine:'launched'`), `takeover`, `dialog`, `download`, `cft-download`, `profile-warm`, ***(as built)*** `engine2` (a launched engine's `runtime.broadcast`) |
| `agents` | `{ agents:[{ id, name, pid, owned, current, halted, connectedAt }] }` |
| `engines` | `{ engines:[…] }` (extension rows and launched `EngineInfo`) |
| `tabs` | `{ engine, tabs }` (extension push) or `{ gone: tabId, reason }` |
| `frame` | `{ tabId, data, metadata, at }` — only to UIs watching that tab; dropped, never queued, when the UI is more than 8 MiB behind |
| `pointer` | `{ tabId, sample:{ at, x, y, buttons, type } }` — same rule (2 MiB) |
| `watchStatus` | ***(as built)*** `{ tabId, state:'live'\|'idle'\|'hidden', visibility?, reason?, lastFrameAt?, at }` — only to UIs watching that tab, never dropped (small and rare); from the extension's event or Engine 2's own watchdog |
| `run` | `{ runId, kind, state:'started'\|'finished', scheduleId?, exitCode?, summary? }` |
| `halt` | `{ global:{halted,by,at}, agentId?, halted? }` |
| `schedule` | `{ entries }` |
| `watchRequest` | ***(3.2)*** `{ tabId, on, engineKind?, url?, agent:{id,name} }` — an agent's `browser_tabs action:"watch"`; the desktop's Watch view opens on that tab (`on:false`: the agent closed it) |

## 6. Admin (ui → daemon)

`{type:'admin', id, op, …}` → `{type:'result', id, ok, result|error}`. Agents get
`ok:false` ("Admin operations are for the G9BrowserAgent desktop app") — an agent can never resume a halt.

**Arguments.** They may be spread at the top level of the message or sent as `args:{…}` (both are
read; `args` wins). The message's own `id` is ALWAYS the request id. An op that is about a schedule
entry takes that entry's id as `entryId` (or `args.id`) — never `id`.

| op | args | result |
|---|---|---|
| `halt` / `resume` | — (global) | `{ halted }` |
| `haltAgent` / `resumeAgent` | `{ agentId }` | `{ changed }` |
| `watch` / `unwatch` | `{ tabId }` (daemon handle) | `{ watching, tabId, runId }` / `{ watching:false, tabId }` — frames, pointer samples and `watchStatus` arrive as UI events; frames and pointer are spooled into a `watch` run, which ends when the last watcher leaves. ***(as built)*** `watch` answers `{ watching:false, tabId, problem }` when a launched engine's stream did not start (the browser refused the screencast: the tab closed or navigated during the start, or Engine 2's tool runtime is not loaded), and `{ watching:false, tabId }` without a `problem` when an `unwatch`, the UI disconnecting or the tab closing overtook the start; the watcher and its run are undone first, so a caller must read `watching` rather than assume a live view. For an extension tab `watching:true` means the daemon sent `{type:'watch', on:true}`; whether frames flow shows in `watchStatus`. Starts and stops for one launched tab and consumer are serialised in `EngineManager.watch`, so the last request wins |
| `settings.get` / `settings.set` | `{ patch }` (validated; `null` resets a key; `evidence` merges one level deep). F6: `updateChannel` is `'stable'` (default) or `'beta'`; `updateUrl` is an `https://` URL (`http://` only on `localhost`, `127.0.0.1` or `::1`, for a test feed) or empty — a `file://` feed is refused by name (electron-updater's generic provider downloads over http(s) only; a settings file holding one loads with the feed ignored and says so) | settings |
| `extension.install` | `{ from? }` copy the bundled extension to `G9_HOME/extension` via `extension.new` + rename, then `reload` | `{ path, version, previousVersion, files, bytes, method:'swap'\|'overwrite', reloadSent }` |
| `extension.reload` | — | `{ reloadSent }` |
| `schedule.list` | — | `{ entries:[{…, suite, at, nextRunAt, running, lastRun:{runId, at, finishedAt, exitCode, verdict}\|null}] }` (`suite`/`at` alias `target`/`daily` for runner-shaped entries) |
| `schedule.add` | `{ entry }` or the entry's fields: `{ target, daily:"HH:MM" \| everyMinutes:N, args?, name?, enabled?, project?, cwd? }` — or the desktop's words `{ suite, at, env, everyMinutes, engine:{browser, headless, humanize, stealth, profile} }`, normalised to `target`/`daily`/`args` (`--env`, `--browser`, `--headed`/`--headless`, `--humanize`, `--stealth`, `--profile`; explicit `args` win) | the stored entry (display fields kept) |
| `schedule.remove` / `schedule.runNow` | `{ entryId }` (***(as built)*** `scheduleId` or `args.id` also) | `{ removed: entryId }` / `{ runId, dir }` |
| `runs.list` / `runs.get` | `{ limit?, active? }` / `{ runId }` | `{ runs:[{ runId, kind, label, startedAt, finishedAt, active, ok, verdict, exitCode, frames, dir }] }` / `{ runId, dir, engine, result, files, active }`. F6: `active:true` lists every run still open, however old (no newest-`limit` window: a long scheduled run older than fifty short ones is still found); otherwise the newest `limit` (default 50) |
| `engines.versions` / `engines.installCft` | `{ version? }` | `{ running:[{engineId, browser, version, path}], browsers:[{kind, path, version, channel, source, versionSource}] \| {error}, cft:{ pinned:{version, platform, sha256, …}, installed:[{version, path}], downloaded?:{version, path, …} } \| {…, error}, log }` (engine/manager.js `versions()`; `installCft` fails when the download fails) |
| `profiles.list` / `profiles.warm` | — / `{ name, url?, browser? }` | `{ profiles:[…] }` (engine/profile.js `list()`) / `{ profile, warming:true, pid, browser:{kind, version}, url, note }` (returns once the headed window is up; refused while a launched engine uses that profile) |
| `state` | — | `{ daemon, halted, agents, engines, sessions, tabs, schedule, activeRuns, watching }` for a first render (`activeRuns` as in `/health`) |
| `shutdown` | — stops engines, closes sockets, exits | `{ stopping:true }`, then the socket closes |

## 7. Ownership, queues, halts

* Handles are daemon-wide integers shared by all engines.
* A mutating call (`!isReadOnly(tool,args)`, the table in `extension/tools/index.js`) on an unowned tab
  claims it for the calling client. On another client's tab it fails: `Tab 7 is owned by agent-2
  (cursor). Ask that agent to release it, or call browser_tabs action:"claim" tabId:7 force:true to take
  it over.` A forced takeover is logged and reported to UIs as `takeover` activity.
* ***(as built, 2026-09-22)*** `browser_screenshot` is a read only for `area:"viewport"`. An element
  capture scrolls the element into view (trusted wheel notches at the human levels, `scrollIntoView`
  at `off`) and a full-page capture resizes the viewport, so both are mutating: they claim the tab,
  they are queued, and they take a maxParallel slot. As reads they scrolled another agent's page
  under a click in flight.
* Mutating calls on one tab run strictly one at a time, in arrival order; reads are not queued. A
  call that reached its deadline is cancelled first and the queue is held until it stops (§3).
* ***(as built, 2026-09-22)*** At the moment a queued call's turn comes — and again when a launched
  engine call gets its maxParallel slot — the daemon re-checks that the caller is still connected
  ("The agent that sent this call disconnected before its turn came, so it was not run."), the halt,
  and, for a mutating call, ownership (an unowned tab is claimed again; a tab another connected agent
  now owns gives the ownership error). Before, only the halt was re-checked, and a queued click ran
  on a tab that had changed hands.
* An agent's claims are released when its socket closes. A tab that disappears (closed, its engine
  stopped, or its extension gone for good) takes its claim, its session names and every agent's "current"
  pointer to it along. An extension that disconnects with an `instanceId` is parked first (§2, D-c): its
  tabs, and every claim, name and current pointer on them, wait for its reconnect.
* Each agent has a current tab: set by `open`, `attach`, `focus`, `handoff`, `session` (with `focus`,
  or when it has none), and — when it has none — by the first call that resolves the default engine's
  current tab (or by `browser_status` reporting one). A default is never a tab another connected agent
  owns (launched engines then fall back to the newest tab the caller may take; otherwise the call says
  "No tab to act on" and names open/attach). ***(as built)*** Nor is it a browser-internal page (Edge's own
  `edge://downloads-hub/` tab): `browser_tabs list` shows such tabs `attachable:false`, and every tool refuses
  them. It stays until the agent changes it or the tab goes.
* Global halt blocks every tool except `browser_status`. An agent halt blocks that agent only.
  Agents cannot resume. A call waiting in a tab's queue is checked again when its turn comes: a Stop
  pressed while it waited fails it, and it never reaches the engine. The global halt is also mirrored into launched engines, so in-flight Engine 2
  work stops at its next CDP command; ***(as built, 2026-09-22)*** an agent halt cancels that
  agent's calls already running, the same way (§4 `cancel`).
* ***(as built, 2026-09-22)*** **Engine leases.** `browser_engine action:"acquire" {engineId}` and
  `action:"release" {engineId}` record that a client is USING a launched engine across its tabs (a
  runner between two flows owns no tab but still needs the browser). `action:"launch"` takes one with
  `lease:true`, and `stopWhenReleased:true` asks the daemon to stop that engine once the last lease is
  released and no connected agent owns a tab in it. A plain `stop` on an engine other clients hold is
  refused by name unless `force:true`. A disconnect releases that client's leases.

## 8. Lifetime

The shim starts the daemon on demand: on a refused connection it spawns `daemon/g9d.mjs` detached and
hidden with the same `G9_PORT`/`G9_HOME` and retries for 8 s. A daemon that finds its port held by
another g9d exits 0 (two shims raced; the other won); held by anything else, it logs the holder and
exits 1. If the port answers `/health` with a non-g9d body (a v1 bridge), the shim fails every tool
with a message naming that process's pid and the fix.

***(as built, 2026-09-22)*** **One daemon per G9_HOME, not only per port.** Before it touches the
home, g9d takes `G9_HOME/daemon.lock` (`open(..., 'wx')`, holding `{pid, port}`; the port is written
once it listens). A second g9d whose lock-holder is alive and answers `/health` as g9d for the same
home logs `G9_HOME <home> already has g9d pid N on port P; this one exits.` and exits 0; a lock whose
pid is dead, or whose port does not answer as g9d for this home, is taken over. The lock is removed
on a clean exit. The shim checks `G9_HOME/daemon.json` before it spawns: a live g9d for this home on
another port makes every tool fail with `set G9_PORT=<that port>` instead of starting a second
daemon. Two daemons on one home ran every schedule entry twice and each rewrote settings.json from
its own memory.

`G9_ENGINE_RESUME_MS` (default 600 000) is how long a disconnected extension keeps its engine identity (§2).

The daemon exits after `settings.idleExitMinutes` (default 60; 0 = never; the environment variable
`G9_IDLE_EXIT_MS` overrides it, for tests) with no client of any role,
no launched engine, no enabled schedule entry and no scheduled run in progress; it never exits while
an engine runs or a client is connected, and never when started with `--foreground`. On exit it closes
launched browsers — each gets `Browser.close` and up to 30 s for a clean exit before its process tree is
killed (`engine/launch.js GRACEFUL_EXIT_MS`, 2.0.2; measured up to 17.9 s under heavy load) — and removes
`G9_HOME/daemon.json` (`{pid, port, version, startedAt, home}`), which it
wrote when it started listening. It logs to `G9_HOME/logs/daemon.log` (rotated at 5 MB).

## 9. Evidence runs

`G9_HOME/runs/<runId>/` (`runId` = `YYYYMMDD-HHMMSS-<kind>-<hex>`) is written for every Engine 2
`browser_recording` replay/calibrate (kind `replay`/`calibrate`: `engine.json` with the browser, argv,
stealth and humanize seed; screencast `frames/<seq>.jpg` + `frames.jsonl`; `pointer.jsonl`;
`downloads.jsonl`; `result.json`), for every UI watch (kind `watch`), and for every scheduled run (kind
`schedule`, the runner's reports in `report/`; `result.json` carries `exitCode` and the worst `verdict`). A
scheduled run gets `--project <entry.project, else the daemon's default g9.project.json>` and starts in
`entry.cwd`, else that project's folder, else the G9BrowserAgent install. Caps come from `settings.evidence` (`maxFrames`,
`maxBytes`, `keepRuns`); frames beyond a cap are counted, not written, and `result.json` says so. The
replay result carries `evidence: { runId, dir, frames }`. Every new run starts a prune that keeps the newest
`keepRuns` run folders and never removes an active run; ***(as built, 2.0.2)*** prune passes run one at a
time, and a delete that Windows refuses for a moment (EPERM/EBUSY) is retried.

## 10. Viewers: the watch window ***(3.2)***

A viewer (`role:"viewer"`, §1) is the extension's live view, `panel/watch.html`. It connects to the
daemon itself — the address comes from the service worker's `watchAddress` panel command — so frames
reach the page directly rather than through a service worker that may sleep. Its only messages:

```json
{ "type": "viewer", "id": "w1", "op": "watchables" }
{ "type": "viewer", "id": "w2", "op": "watch", "tabId": 3 }
{ "type": "viewer", "id": "w3", "op": "unwatch", "tabId": 3 }
```

answered `{type:'viewerResult', id, ok, result|error}`:

| op | result |
|---|---|
| `watchables` | `{ tabs:[{ tabId, title, url, engineId, engineKind:'extension'\|'launched', headless, browser, owner:{id,name}\|null, agents:[{id,name}], watched }] }` — every tab of every engine (the extension's by a relayed `browser_tabs list`); `agents` are those whose current tab it is |
| `watch` | as the admin `watch` (§6): `{ watching:true, tabId, runId }`, or `{ watching:false, tabId, problem }` when no stream could start. The same stream, the same evidence run and the same `frame`/`pointer`/`watchStatus` events as a `ui` watcher |
| `unwatch` | `{ watching:false, tabId }` |

A viewer that disconnects stops every stream only it was watching. An agent opens the window through
`browser_tabs action:"watch"` (read-only: it needs no ownership and no turn): the daemon sends
`openWatch` to the newest connected extension and `watchRequest` to the desktop app, and answers the
agent `{ tabId, on:true, shown, shownIn:[…], note }` — `shown:false` with a note naming where a person
could look when neither is connected. `on:false` sends `closeWatch` and `watchRequest {on:false}`.
