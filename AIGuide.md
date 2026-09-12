# AIGuide — G9 Browser Agent

**Purpose of this file.** This is the durable record of what exists in this codebase, why it was built this way, and what is deliberately absent. Read it before changing anything. Update it after changing anything — see [Rules for changing this codebase](#rules-for-changing-this-codebase) at the end.

**Status:** v1.6.0 — 14 context-efficient browser tools; bridge/MCP 26/26, extension regressions **34/34**, isolated real-Edge **56/56** (v1.6.0, including regression memory and the assertion wizard). **Interaction verifies that the page actually received the event, and a stuck CDP command reports itself instead of timing out the call** — see §4.3a and the v1.4.0/v1.5.1 entries. **v1.6.0 adds regression memory: signatures, the known world, the surprise detector, calibration, layout-mode visual baselines, semantic (aria) baselines, network pinning, FlowSpec, and an unattended runner** — see §8c.
**Created:** 2026-08-31

---

## 1. What this is

An MV3 browser extension plus a zero-dependency Node bridge that gives an AI agent DevTools-level control over the user's **real, already-running** browser — real profile, real cookies, real logins.

```
  AI Agent  ──MCP (stdio JSON-RPC)──▶  Bridge  ──WebSocket──▶  Extension  ──CDP──▶  Tab
                                      (Node)                  (Chrome/Edge)
```

**Independent of any project it inspects.** It sees only the browser. It does not and must not know whether the page is served by ASP.NET, React, or anything else. Keep it in its own repo.

---

## 2. Why this architecture (the decision that shapes everything)

Three approaches were evaluated. The reasoning matters because it constrains every later choice.

### Rejected: WebDriver / Selenium

No DevTools depth. No computed styles, no network response bodies, no console capture, no performance traces. WebDriver BiDi is closing the gap and is now native in Chrome, Edge and Firefox, but as of 2026 the lowest-level Chromium capabilities still require CDP.

### Rejected: external CDP (Playwright / Puppeteer / chrome-devtools-mcp)

Full depth, but it cannot reach the browser the user is actually using:

- **Chrome 136+** ignores `--remote-debugging-port` and `--remote-debugging-pipe` on the **default profile**. The workaround — `--user-data-dir` pointing at a throwaway directory — produces a browser with none of the user's logins, which defeats the purpose.
- **Chrome 144+** added a `chrome://inspect/#remote-debugging` toggle plus `--autoConnect`, which does work on the real profile. But it is Chrome-only: Edge assigns a dynamic port that cannot be discovered.
- Some sites refuse sign-in when the browser reports as WebDriver-controlled.

### Chosen: MV3 extension with the `debugger` permission

`chrome.debugger` opens a full CDP channel to any tab **on the default profile, with no flags and no port**. It sidesteps the Chrome 136 restriction entirely because it never goes through the port mechanism. Identical API on Chrome and Edge.

**CDP domains available to an extension:** `Accessibility`, `Audits`, `CacheStorage`, `Console`, `CSS`, `Database`, `Debugger`, `DOM`, `DOMDebugger`, `DOMSnapshot`, `Emulation`, `Fetch`, `IO`, `Input`, `Inspector`, `Log`, `Network`, `Overlay`, `Page`, `Performance`, `Profiler`, `Runtime`, `Storage`, `Target`, `Tracing`, `WebAudio`, `WebAuthn`.

**Plus extension-only APIs that external CDP has no access to:** `chrome.tabs`, `chrome.windows`, `chrome.cookies` (all domains, including HttpOnly), `chrome.downloads`, `chrome.storage`, `chrome.sidePanel`.

**Accepted costs:** the "being debugged" banner cannot be hidden; browser-internal pages are unreachable; the MV3 service worker lifecycle must be actively managed (see §4).

---

## 3. Repo layout

```
g9-browser-agent/
├── extension/                    ALL browser logic lives here
│   ├── manifest.json             MV3; permissions listed in §5
│   ├── sw.js                     service worker — tool router, event ingestion
│   ├── lib/
│   │   ├── state.js              storage-backed state (SW-restart safe)
│   │   ├── cdp.js                chrome.debugger wrapper — single choke point
│   │   ├── refs.js               element ref registry (eN -> backendNodeId)
│   │   ├── locators.js           MULTI-LOCATOR element identity (recorder core)
│   │   ├── signature.js          journey signature · known world · SURPRISE detector (§8c)
│   │   ├── flowspec.js           canonical, Git-diffable portable flow form (§8c)
│   │   ├── visual.js             fingerprint + structure map + masks + diff image
│   │   ├── store.js              recordings + issues; local for records, IDB for blobs/frames
│   │   └── transport.js          WebSocket client, keepalive, backoff
│   ├── tools/
│   │   ├── tabs.js               tab list + TARGET RESOLUTION (safety boundary)
│   │   ├── snapshot.js           a11y-tree perception, ref assignment
│   │   ├── interact.js           trusted input events
│   │   ├── inspect.js            DOM, computed styles, box, storage, cookies
│   │   ├── observe.js            console + network capture (event-driven)
│   │   ├── navigate.js           navigation + condition-based waiting
│   │   ├── capture.js            screenshots
│   │   ├── diagnose.js           health report + performance trace
│   │   ├── emulate.js            device/network emulation, JS dialogs
│   │   ├── record.js             session recording over a CDP binding
│   │   ├── replay.js             replay engine + failure diagnosis
│   │   ├── qa.js                 assertions (incl. aria), baselines, Playwright export
│   │   ├── netpin.js             serve the network from a HAR (Fetch interception)
│   │   └── issues.js             defect capture, context, attachments
│   └── panel/                    side panel — the trust surface
│       ├── panel.html/.css/.js
│       ├── welcome.html          shown once on install
│       └── icon{16,48,128}.png   generated, not hand-drawn
├── runner/                       the unattended CLI — no agent, no QA present
│   ├── g9.mjs                    run · list · calibrate · approve · spec; exit codes 0-4
│   ├── mcp-client.mjs            minimal MCP stdio client (the runner is just another client)
│   ├── report.mjs                run.json · junit.xml · report.html · qa-automation-status.json
│   └── README.md
├── bridge/
│   ├── package.json              zero dependencies, type: module
│   └── src/
│       ├── server.js             entry point; wires MCP <-> WebSocket
│       ├── mcp.js                minimal MCP server over stdio
│       ├── ws-server.js          minimal RFC 6455 server
│       └── tools.js              tool SCHEMAS + agent INSTRUCTIONS
├── setup/
│   ├── install.ps1               Node check, both non-browser tests, config generation
│   ├── selftest.mjs              26 assertions, no browser needed
│   ├── extensiontest.mjs         15 browser-module regression tests
│   ├── livetest.mjs              live CDP test, needs a real attached tab
│   ├── isolated-livetest.mjs     temporary profile + extension/MCP/panel live run
│   ├── serve.mjs                 static server for the test page
│   ├── testpage.html             6 deliberate defects
│   ├── postcard.html             1080² card, rendered and posted by the agent
│   │                             served with /hang and /slow?ms= endpoints
│   ├── mcp.example.json          committed template, placeholder path
│   └── mcp.json                  generated by install.ps1 (gitignored)
├── README.md
└── AIGuide.md                    this file
```

**Where does new code go?** Browser capability → `extension/tools/`. Schema/description → `bridge/src/tools.js`. The bridge itself should stay dumb (see §6).

---

## 4. The five constraints that shaped the code

Every non-obvious decision traces back to one of these. Do not "simplify" past them.

### 4.1 The MV3 service worker dies after ~30 seconds idle

**Consequence:** no module-level variable is ever a source of truth.

- All state lives in `chrome.storage.session` (in-memory, cleared on browser close, never written to disk — this matters because it holds page data).
- Durable settings (host, port, mode) are mirrored to `chrome.storage.local`.
- `transport.js` pings every **20s**. WebSocket traffic resets the idle timer; Chrome 116+ supports WS in service workers.
- A `chrome.alarms` heartbeat every 30s revives the worker if it died while the bridge was unreachable. Alarms have a 30s floor — too slow to keep the worker alive on its own, which is why the 20s ping exists separately.
- `bootstrap()` runs on module evaluation, not just on `onInstalled`, because a revived worker re-evaluates the module.
- All session-storage mutations are **serialized** through one promise chain,
  exported from `state.js` as `serialize()`. Storage is a read-modify-write
  against a single key from many independent async call sites; without
  serialization, interleaved writes lose updates (see the v1.0.5 and v1.0.7
  change-log entries). The chain covers `state.js` *and* `tools/observe.js` —
  the latter is by far the highest-frequency writer, since one page load pushes
  dozens of `Network.*` events into the same key. A function running inside
  `serialize()` must never call another serialized function, or it deadlocks.

### 4.2 Agents are bad at CSS selectors

**Consequence:** the ref system in `lib/refs.js`.

`browser_snapshot` walks the accessibility tree, assigns `e1`, `e2`… to interactive nodes, and stores `ref -> backendNodeId` keyed by tab. Interaction tools accept refs.

Refs are versioned by snapshot URL. `Page.frameNavigated` clears them. A stale ref throws an error that *names the recovery* ("take a fresh snapshot") instead of clicking the wrong element. Silent misclicks are the worst possible failure here, so this is deliberately strict.

### 4.3 Synthetic events fail on real applications

**Consequence:** everything in `tools/interact.js` uses `Input.dispatch*Event`.

CDP injects at the browser's input pipeline, before the page. Resulting events have `isTrusted === true` and fire the complete native sequence (`pointerdown → mousedown → focus → mouseup → click`). `element.click()` and `dispatchEvent()` produce `isTrusted === false`, which many frameworks and most protected sites reject.

Specific care taken:

- `pointFor()` scrolls into view, then re-reads geometry, then falls back to `getBoundingClientRect` for transformed or zero-size elements.
- `checkObscured()` uses `elementsFromPoint` — the **plural** form, deliberately — and, when something else would receive the click, names the covering element rather than failing vaguely. The singular `elementFromPoint` cannot see pseudo-elements: it reports the element that generated them, so a `::after` click-shield is indistinguishable from a harmless wrapper. It also treats an ancestor on top as an obstruction, not a pass: an event on an ancestor bubbles *away* from the target. A descendant on top is fine, because that bubbles *into* it. `<label>` is the one allowed exception. See the v1.0.9 change-log entry — this function had a false negative for eight versions.
- Typing defaults to per-character key events. `fast: true` uses `Input.insertText`. Both are needed, and v1.0.15 measured the difference on a digit-only field: per-character typing of `12ab34` landed `1234` (the page rejected the letters, as it would for a human); `fast` let `cd` straight through. `insertText` is fine for React/Vue controlled inputs and wrong for masked, autocomplete, and key-filtered fields.
- `clear: true` selects through `this.select()` rather than Ctrl+A, then deletes with a real key event, then VERIFIES the field is empty and throws if it is not. A key chord is blockable by the page; a selection is not an edit, so making it directly costs nothing. See the v1.0.15 entry.
- Chords (Ctrl+S) must use `rawKeyDown` with no `text`, or the page receives a literal character instead of the shortcut.
- `drag()` interpolates 12 intermediate moves; HTML5 DnD and most drag libraries ignore a single source→target jump.
- `pointFor()` returns TOP-LEVEL viewport coordinates. `DOM.getBoxModel` already does; `getBoundingClientRect()` inside `callOnNode` does NOT, because that runs in the frame that owns the node — so the fallback path adds `frameOffset()`, and `checkObscured` subtracts it again before hit-testing. Mixing the two put every click and every obstruction check at the wrong point inside an iframe (v1.4.0).

### 4.3a A dispatched event is not a delivered event

**Consequence:** the input witness in `tools/interact.js`.

**A headed Chromium silently discards `Input.dispatch*Event` for a page that is
not visible.** The command resolves normally, no error is raised, and the page
receives nothing at all — not even a `keydown`. It is Chromium's behaviour, not
ours, and it is invisible from the CDP side.

Three things make this the most dangerous failure mode in the toolset:

1. **It is the headline workflow.** Pinned mode exists so the user can browse
   elsewhere while the agent works (§4.5), and browsing elsewhere is precisely
   what makes the pinned tab hidden. The feature and the bug share a trigger.
2. **It cannot be reproduced headless**, because a headless surface is always
   paintable. Every automated live run in this repo's history has been headless,
   so the suites were green while the product did nothing.
3. **Nothing noticed.** Each action returned an echo of its own arguments —
   `{ typed: text }` built from the input, never read back from the page — so
   the agent proceeded on a login that never happened.

Every dispatching action now goes through `witnessed()`: a capture-phase
listener counts **trusted** events, the action runs, and the count is checked.
On a miss, `explainNoInput()` asks the page for `visibilityState` and returns
the sentence that names the fix.

Two rules to preserve:

- **Never arm a witness inside another witness.** Arming resets the counter, so
  a nested one makes a working action report failure. `dispatchKey()` is the
  unwitnessed primitive that `type()` and `select()` call for exactly this
  reason; only the exported `key()` witnesses.
- **Witness DELIVERY, never the resulting value.** Per-character typing of
  `12ab34` into a digit-only field correctly lands `1234` — the page rejecting
  keys is the page working (v1.0.15). Asserting the value would fail every
  masked, filtered and formatted input in existence. The value is reported so
  the agent can see it; only the arrival of input is enforced.

### 4.4 Tool definitions are re-sent on every request

**Consequence:** 14 grouped tools, not ~50 flat ones.

Each takes an `action` or `what` discriminator. The full toolset is roughly 3k tokens. For comparison, `chrome-devtools-mcp` spends around 18k tokens on definitions alone. Adding a flat tool per capability would be the easy choice and the wrong one.

### 4.5 The user must be able to trust this

**Consequence:** pinned mode, the activity log, and the Stop button are not decoration.

Without pinned mode, switching to your email mid-task hands the agent your inbox. `tools/tabs.js → resolveTarget()` is a **safety boundary**, not a convenience helper — it refuses rather than guessing, and in pinned mode it rejects `tabId` arguments that point elsewhere.

But `resolveTarget()` only guards actions that happen *inside* a tab, and it is reached only by tools declaring `needsTab`. `browser_tabs` deliberately does not declare it — there is no target to resolve — which left the boundary open from the side (v1.0.7). Three rules close it, and all three belong together:

1. **`tools/tabs.js → requireMultiMode()`** is the second half of the boundary. Anything that changes which tabs exist, or which tab the agent controls — `open`, `close`, `focus`, `pin`, `unpin` — goes through it. Only `list` is free.
2. **The halt check lives at the router**, in `sw.js → handleBridgeMessage()`, not only in `cdp.send()`. `chrome.tabs.*` is not CDP, so a check that low cannot see it. `browser_status` is the single exception (`allowWhenHalted: true`), because an agent that cannot ask *why* it is failing will guess.
3. **Pinning does not clear `halted`.** `pinTab()` takes `{ clearHalt }`, passed only by the side panel's own commands. A stop is a user decision and only a user gesture lifts it.

The general shape: a permission check that lives at one layer only is a permission check with a way around it. Ask where else the same capability can be reached.

---

## 5. Security model

Read this before changing `ws-server.js`.

**Project threat-model decision (2026-09-01): this is trusted-local QA tooling.**
The localhost bridge, browser profile, installed extensions, and local users are
inside the current deployment trust boundary. Work whose primary purpose is to
defend against a malicious local extension/user/process, bridge impersonation,
local secret theft, or hostile local software is intentionally out of scope.
Do not repeatedly propose redaction, encrypted evidence, mandatory pairing,
exact extension-ID allowlists, takeover authorization, or another local
permission system unless the deployment model changes. Existing safeguards
below stay because they work and support user control; this decision does not
claim they make localhost a hostile-environment security boundary.

| Layer | Mechanism |
|---|---|
| Network exposure | Bridge binds `127.0.0.1` only. **Never** change to `0.0.0.0`. |
| Origin validation | Only `/^(chrome\|edge\|moz)-extension:\/\/[a-z0-9-]+$/i` may complete the WS handshake. A malicious page's `new WebSocket('ws://127.0.0.1:8765')` sends its own `https://` origin → 403. **This is the primary defence.** Asserted by self-test #3. |
| Single client | A second connection displaces the first rather than silently sharing a session. |
| Protocol robustness | A malformed or oversized frame drops the connection (close 1009), never the process. It throws inside a socket `data` handler, where an uncaught exception would kill the bridge. Asserted by self-test #11. |
| Optional token | `G9_TOKEN` env var + side-panel field, compared with `crypto.timingSafeEqual`. Off by default. |
| Scope | Pinned mode limits the agent to one consented tab — enforced by `resolveTarget()` for in-tab actions **and** `requireMultiMode()` for tab management. See §4.5. |
| Cookie scope | `chrome.cookies` sees every domain in the profile, not just the attached tab. Outside multi mode, `browser_inspect what:"cookies"` refuses a `url` from another origin — otherwise a pinned agent could read live session cookies for any site the user is signed in to (v1.0.14). |
| Disclosure | Outside multi mode, `browser_status` lists other tabs by **origin only**. Titles and full URLs carry subject lines, document names, and search queries; handing over all of them would give back most of what pinned mode protects. |
| Kill switch | Stop sets `halted`, checked in `cdp.send()` *and* at the router in `sw.js`. Only `browser_status` answers while halted. Nothing the agent can call clears it — pinning a tab used to, which made the button self-defeating. |
| Auditability | Every tool call is logged with args, result, and duration, visible live in the panel. |
| Supply chain | **Zero dependencies.** Deliberate: nothing with this much access should carry transitive packages. |

Extension permissions and why each is needed:

| Permission | Reason |
|---|---|
| `debugger` | The entire CDP channel. The core of the tool. |
| `tabs` | Tab list, titles, URLs. |
| `activeTab` | Resolving "the current tab" on user gesture. |
| `cookies` | Application-panel cookie reads, including HttpOnly. |
| `storage` | Session and local state. |
| `alarms` | Service-worker revival heartbeat. |
| `sidePanel` | The control UI. |
| `<all_urls>` | Attaching to arbitrary user pages. |

---

## 6. Component reference

### `bridge/src/server.js` — deliberately dumb

Owns **no** browser logic. Validates nothing about the page, holds no element state, makes no decisions. It only correlates request ids and surfaces transport errors.

Rationale: the extension is the only side that can actually see the browser, so putting logic in the bridge would split truth across a process boundary. If a click misbehaves, it is wrong in the extension — always. Keep it that way.

Environment variables: `G9_HOST` (default `127.0.0.1`), `G9_PORT` (`8765`), `G9_TOKEN` (empty), `G9_TIMEOUT_MS` (`60000`).

**It does not exit when it cannot bind the port.** An MCP client that launched the bridge sees only that the process died and reports "Connection closed"; the reason, written to stderr, lands in a log file nobody opens. The stdio channel does not depend on the WebSocket port, so the bridge stays up, serves MCP normally, and returns `startupFailure` from every tool call — a message naming the port, whether the holder is another G9 bridge or an unrelated program, and how to fix each. It re-attempts the bind every 5s, so closing the other window heals the session without an editor restart. Asserted by self-test #12.

### `bridge/src/mcp.js` — hand-written MCP

Implements `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`. Negotiates protocol version against `['2025-06-18', '2025-03-26', '2024-11-05']`, echoing the client's version when supported.

Two things to preserve:

- **stdout carries protocol frames only.** Any stray `console.log` corrupts the stream and the client disconnects with a parse error. All diagnostics go through `log()` → stderr.
- **Tool failures return `isError: true` results, not JSON-RPC errors.** The agent needs to read the message and adapt; a protocol error looks like a transport fault and gives it nothing to work with.

`normalizeToolResult()` converts a result carrying `dataBase64` into a proper MCP image block, so multimodal models see screenshots instead of a base64 wall.

### `bridge/src/ws-server.js` — hand-written RFC 6455

Full frame codec: FIN/opcode parsing, client unmasking, 16- and 64-bit lengths, continuation frames, ping/pong, close handshake, 64MB frame cap. Server frames are never masked, per spec.

Written by hand so `git clone && node` works with no registry access, and so nothing with this much authority carries a supply chain.

### `bridge/src/tools.js` — schemas and instructions

`INSTRUCTIONS` is returned in the MCP `initialize` response and therefore **loads into the agent's context automatically** — the user never copies anything. It teaches the perception model (a11y first, screenshots as fallback), the ref lifecycle, and the boundaries.

Tool descriptions are written **for the agent**, stating when to reach for a tool and what the common mistake is — not as human-facing documentation.

### `extension/sw.js` — the router

The `TOOLS` table maps tool name → `{ needsTab, allowWhenHalted, run({ tabId, tab, args }) }`. Adding a capability is one entry here plus one schema in `bridge/src/tools.js`.

`handleBridgeMessage()` is also where the halt check runs, before any tool executes. Put policy that must apply to *every* tool here — a check inside `cdp.send()` is invisible to tools that never call CDP (§4.5).

Also owns continuous event ingestion. `Runtime.consoleAPICalled`, `Log.entryAdded`, and the `Network.*` lifecycle are buffered as they happen, so the log is already complete when the agent asks. Polling instead would miss everything that happened before the question. Ingestion failures are reported to the extension console rather than swallowed — a silent capture failure hands the agent an incomplete log it believes is complete.

### `extension/tools/observe.js` — the capture buffers

Ring buffers in `chrome.storage.session`, keyed per tab, written through the shared `serialize()` chain (§4.1). Three details that are not obvious:

- Console text is truncated at **write** time, not only on read. Untruncated text still has to fit in storage first.
- On a quota rejection the buffer drops to its newest quarter and **records that it did**, inside the data the agent reads. Silently shrinking would be worse than the overflow.
- `clearBuffers(tabId)` is called when a tab closes, when it is unpinned, and — via `navigate.js → resetPageState()` — before every `goto`, `reload`, and history move. Nothing else reclaims these keys. Buffers that survive a navigation do not just leak; they make `browser_diagnose` report the previous page's defects as the current page's (v1.0.9).
- A request remains `pending` after response headers arrive and until `loadingFinished`/`loadingFailed`. `browser_network format:"har"` converts the same bounded evidence into HAR 1.2 rather than maintaining a second truth.

### `extension/tools/snapshot.js` — perception

Accessibility tree, pruned hard. An unpruned tree from a real app is tens of thousands of nodes.

- `INTERACTIVE` roles → always kept, always get a ref
- `STRUCTURAL` roles → kept only when they carry a name (an unnamed `role=group` tells the agent nothing)
- `NOISE` roles (`generic`, `none`, `StaticText`, …) → dropped, children still walked
- Default cap 900 **emitted lines**, including structural nodes without refs; `truncated: true` when hit

`mode:"a11y+text"` additionally extracts visible text through injected page code. **Every regex escape in injected code must be doubled** (`\s`, not `s`): the string is a template literal, so it is parsed twice, and a single escape is silently swallowed rather than rejected. Self-test #13 enforces it.

### `extension/lib/locators.js` — element identity

The recorder core. Generates several independent locators per element and
resolves them back, from ONE injected source so the two halves can never
disagree about what a locator means. Ranking, escaping rules and the reasoning
are in §8b. Verified against a real DOM before anything was built on it — the
names it produces match `browser_snapshot` exactly. Discovery walks open Shadow
roots and same-origin iframe documents; closed Shadow DOM and cross-origin
frames are browser boundaries and remain deliberately unavailable.

### `extension/tools/record.js` — capture, and normalisation

The injected half emits raw events and decides nothing. All judgement is here:
collapsing five `input` events into one `type` step, dropping the click pair a
browser fires before `dblclick`, discarding scrolls the browser performed to
reveal a focused field. That split is deliberate — normalisation is where the
interesting mistakes live, and out here it is ordinary code that can be tested
without a browser. Raw writes are serialized and capped at 5,000 events, with a
warning in the saved flow if the cap was reached. Native select mechanics are
collapsed to the final selected values rather than replaying incidental keys.

### `extension/tools/replay.js` — and the failure message

The failure message is the product. Every step waits for the page to be loaded
and the element to be visible, enabled, and no longer moving; each of those
fails with its own sentence. When no locator matches, the fingerprint answers
in human terms and names the nearest element. Recorded gaps are a budget for
waiting, never a blind sleep — but the default mode also honours the pace the
person worked at, because a flow that only works slowly is a finding. Replay
sets a durable per-tab replay guard, acts on recorded key/drag targets, and
verifies click trust/target, typed value, selected options, and checkbox state
before calling a step successful. Assertion steps are executed through
`tools/qa.js`; each run is retained (last 20) and recent mixed outcomes produce
a flaky signal rather than being hidden.

### `extension/tools/qa.js` — observable tests

Creates and executes URL, text, visibility, value/state, network, console,
accessibility, and screenshot-baseline assertions. Variables substitute
recursively from parameter defaults, environment variables, and replay inputs.
Recording metadata supplies suite/folder/tags without creating more MCP tools.
Visual baselines use a compact 32×32 luminance fingerprint: useful for a stable
regression signal without persisting full duplicate screenshots. The same
record can be exported as readable Playwright JavaScript.

### `extension/tools/issues.js` — evidence, captured at the moment

The title and body are the part a QA could write anywhere. The value is what
they would otherwise have to remember to collect and a developer always has to
ask for afterwards — and it is only true while the bug is on screen. Written
out as real attachments, because an agent filing a ticket uploads files. Video
frames are written individually to IndexedDB before acknowledgement; session
storage carries only bounded metadata. Closing/detaching the tab cancels and
reclaims the spool, and an issue owning an active capture cannot be deleted.

### `extension/tools/diagnose.js` — the opinionated one

`health` deliberately does the correlation the agent would otherwise do across six tools: console errors, failed requests, broken images, unlabelled form controls, nameless interactive elements, horizontal overflow (with the widest offenders named), duplicate IDs, plus load metrics — merged and ranked by severity.

The report is capped **per severity** (30/20/10), never by a flat slice of the ranked list. A flat cut looks equivalent and is not: a page with 60+ console errors pushes every warning past it, and the warnings are where the a11y, layout, and duplicate-ID findings live — the only ones this tool produces that no other tool does. `omittedFindings` reports what was cut. Finding messages are capped at 300 chars; a finding is a pointer, and the full text is in `browser_console`.

`performance` records a trace and returns **aggregates only**. A raw Chrome trace is megabytes and useless in a context window. `vitals` collects buffered LCP, CLS, INP, paint/navigation timing, and long tasks. `memory` samples CDP Performance metrics and reports directional heap/DOM/listener/document growth as a leak signal — not proof of a leak. Health also checks document language, image alternatives, iframe titles, and heading-level jumps.

---

## 7. Testing

`node setup/selftest.mjs` — 26 assertions, **no browser required**. Spawns the real bridge, speaks real MCP over stdio, connects a fake extension over a real WebSocket (hand-rolled client, because the built-in `WebSocket` class cannot set an arbitrary `Origin` — which is exactly what needs testing).

Covers: MCP handshake, instruction delivery, tool count and schema validity, resources, missing-extension error quality, **Origin rejection**, end-to-end routing, argument fidelity, keepalive, image content blocks, error propagation, disconnect handling, stdout hygiene, standalone survival, and **oversized-frame survival**.

`node setup/extensiontest.mjs` — 25 assertions, also **no browser required**. It loads real extension modules under a deterministic `chrome` stub and exercises recorder normalisation/races/caps, replay guarding, concurrent network lifecycles and pending semantics, snapshot bounds, modern/fallback emulation, failure reporting, follow targeting, recursive data, visual comparison, schema annotations, and durable video/panel invariants. This catches missing exports and circular imports that `node --check` cannot see.

> The tool-count assertion (`=== 14`) will fail when you add a tool. That is intentional — it forces this file and the README to be updated too.

`setup/testpage.html` + `serve.mjs` provide six deliberate defects: 2 load-time console errors + 1 uncaught `ReferenceError`, a 404 request, a broken image, an unlabelled password input, 2400px horizontal overflow, a duplicate `id`, plus a transparent overlay covering a button (obstruction detection) and a working login form (`admin` / `g9secret`).

`serve.mjs` also exposes **`/hang`** (accepts the connection, never answers) and **`/slow?ms=`**. `/hang` is the only reliable way to observe `browser_network status:"pending"`: an agent round trip outlasts any latency `browser_emulate` can apply, so throttled requests are always finished by the time the query arrives.

`node setup/isolated-livetest.mjs` launches a temporary clean Edge/Chrome profile, loads the unpacked extension, starts private bridge/debug ports, drives the seeded page through real MCP/CDP, opens the side panel at 420×900, interacts with its Automation tab, captures it, and closes/cleans the profile. It is the preferred reproducible live workflow; `livetest.mjs` remains useful against a manually attached browser.

**Live-verified on 2026-09-01** (isolated real Edge): 42/42 checks plus panel render/interaction. Proven live: MCP handshake and discovery, extension transport, snapshot/refs, inspect, console/evaluate, network detail/HAR, health/vitals/memory, all seeded defects, trusted typing/click/select, obstruction refusal, recorder/assertion pass and deliberate failure, run history, Playwright export, stale-ref error, screenshot, IndexedDB video, exact responsive emulation/reset, and connection stability.

**Still untested:** trusted-event dispatch against real frameworks (React/Vue
controlled inputs, masked fields), service-worker survival over hours, Chrome
parity — every live run so far has been Edge. See §8.

`node setup/isolated-livetest.mjs` **works as of v1.5.1** — 41 passed, 0 failed,
1 skipped, verified over three consecutive runs. It copies the extension to a
temp directory with `dev-bridge.json` baked in so it can never collide with a
live session on 8765, wakes an idle MV3 worker instead of waiting for a target
that will not appear, and prints the service worker's own console when it fails.

> **Every automated live run in this repo is HEADLESS, and headless cannot see
> the class of bug that cost v1.4.0.** A headless surface is always paintable, so
> input dispatch always works there; in a headed browser with the tab in the
> background it silently works on nothing (§4.3a). The suites were green through
> the entire audit that found it. If you change perception or interaction, drive
> a HEADED browser with the attached tab both in front and behind — that is the
> axis the harness does not cover.

> **Run the tool against the test page before shipping anything that touches perception or interaction.** Three of the bugs in v1.0.9 were invisible to a full source read and obvious within two minutes of driving a real page. `checkObscured` in particular *reads* correctly; the defect was in the browser API's contract.

---

## 8. Known gaps and deliberate omissions

**Deliberately absent:**

| Not built | Why |
|---|---|
| `Fetch` request interception/fault injection | Powerful, but reliable lifecycle ownership, teardown, auth, redirects, and streaming are a larger subsystem. HAR/assertions landed first; do not add a superficial mock switch. |
| Heap snapshots | Lightweight repeated CDP Performance metrics now provide leak signals. Full snapshots are large and `HeapProfiler` extension behavior remains unverified. |
| Lighthouse audits | Not a CDP domain; would need to be bundled separately. |
| Multi-browser (Firefox/Safari) | Would mean WebDriver BiDi and a different architecture. Out of scope. |
| Content scripts | Not needed so far; `Runtime.evaluate` covers it. This is why `scripting` is unused. |
| Download-file verification | Would require restoring `downloads` permission and a bounded result model. Navigation downloads can still be initiated, but their filesystem result is not asserted. |
| Direct Jira/Azure/Linear integrations | The AI agent consumes structured issues/evidence and files them. Vendor-specific clients would duplicate that ability. |
| Additional local-adversary hardening | Explicitly outside the trusted-local deployment model in §5 unless that model changes. |

**Known rough edges:**

- **Tab video needs a tab that is being painted.** `Page.startScreencast`
  captures composited frames, so a hidden tab and a headless browser both
  produce ZERO — the command succeeds and frames simply never arrive.
  `video_start` warns when the tab is not visible and `video_stop` explains an
  empty capture, but neither can conjure frames. The frame spool is the one
  check `isolated-livetest.mjs` skips, and it needs a headed run.
- **Some CDP commands stall forever rather than failing.**
  `Input.dispatchMouseEvent{mouseWheel}` does it reliably while a screencast is
  running; `Page.captureScreenshot` does it intermittently on identical code.
  `cdp.send()` bounds every command and names the stuck method, `scroll()` falls
  back to a programmatic scroll and says so, and `capture.js` retries a stalled
  capture once. Do not remove those bounds: without them a stall consumes the
  bridge's whole 60s budget and then reports a JavaScript dialog that is not
  there.
- **A hidden tab cannot be interacted with, and that is a browser limit, not a
  bug we can fix.** Chromium discards CDP input for a page that is not visible
  in a headed browser (§4.3a). `browser_interact` now detects it and says so
  instead of claiming success, but detection is all we can offer: `Page.bringToFront`
  does not restore delivery for an occluded window, and stealing focus would
  break the promise pinned mode exists to make. Reading tools are unaffected —
  snapshot, inspect, console, network and screenshot all work on a hidden tab —
  so an agent can still observe a background tab in full; it just cannot act on
  one. Anything that must click or type needs the tab in the foreground.
- SPA route changes that alter the **path** invalidate all refs, even when the DOM is largely unchanged. Strict on purpose — the error is actionable. Hash-only routing (`#/orders/42`) keeps its refs, because `resolveRef` compares URLs with the hash stripped; both behaviours were verified live in v1.0.13.
- The extension asks for seven permissions and uses all seven. `scripting` and `downloads` were dropped in v1.1.0 — re-add either as one manifest line if a feature needs it.
- Edge's `sidePanel` render and Automation-tab interaction are covered by the isolated live test. Chrome parity remains unverified in this environment.
- The `diagnose.performance` trace listener attaches a raw `chrome.debugger.onEvent` handler each call. Correct, but would need care if traces ever run concurrently.
- Capture buffers are pruned by `loaderId` on every committed navigation (v1.0.12), so agent navigation, click-driven navigation, and the internal reload in `diagnose.performance` all behave identically. Same-document `pushState` raises a different event and deliberately keeps its buffers. *(This replaces the limitation recorded in v1.0.9, which is now fixed.)*
- Some Chromium/headless combinations expose a 4x layout viewport in full mobile mode even after a reload. `browser_emulate` verifies `innerWidth/innerHeight`; if Chromium does this, it returns an explicit compatibility warning and uses an exact responsive viewport while retaining mobile UA, DPR and touch. Text autosizing/overlay-scrollbar emulation are absent in that fallback.
- `browser_network` with a `requestId` can return up to 512KB of response body plus full headers. That is a lot of context for one tool result. No limit is imposed beyond the cap because truncating a body the agent asked for by id is worse than a large answer — but it is worth watching.
- `type()` chooses Ctrl+A or Cmd+A from the service worker's `navigator.userAgent`. Correct on both, but untested on macOS since nothing here runs there.
- `install.ps1 -WriteProjectConfig` writes `.mcp.json` at the repo root, which is where Claude Code looks. Opt-in rather than default because it puts a file in the user's project; without it, step B is still a manual copy.

---

## 8b. Recorder, replay, and issue capture

Designed 2026-08-31, built in v1.2 and expanded in the current QA phase. Written down before the
code existed because the decisions are the expensive part; the implementation
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

Gaps between steps are recorded, because a QA session's rhythm is part of what
it reproduces. But replay does **not** sleep blindly — that is exactly what makes
recorded tests flaky. The gap is treated as a budget while the step waits on a
real condition (element present, stable, actionable). Modes: `recorded`,
`fast`, `adaptive`.

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

`Page.addScriptToEvaluateOnNewDocument` + `Runtime.addBinding`, over the
`chrome.debugger` session already open. Injects before the page's own scripts,
survives navigation by construction, and gives the injected listener a direct
channel back — with **no content script and no new permission**. It also keeps
§6's rule intact: all browser logic goes through CDP.

### Storage

`chrome.storage.local` for structured records, **IndexedDB for attachment
bytes**. Screenshots and tab video are the only things that get large, and
`storage.local` is a JSON store — megabytes of base64 there would be
deserialised on every read of any key. The split is what keeps listing issues
fast when one of them has a 20MB video. Adds `unlimitedStorage`; it is the first
thing in this extension that deliberately touches disk, which §4.1 otherwise
forbids, and the exception is the point: a test or a bug report that dies with
the browser session is not one.

Screencast frames themselves also live in IndexedDB, one record per frame and
session. Acknowledgement happens only after that record is durable, which gives
Chromium back-pressure and removes asynchronous read/modify/write loss. Session
storage contains only frame count/bytes/owner metadata; a 40MB recording can no
longer exceed its practical quota before it is turned into an attachment.

Backup and restore is a single self-contained JSON bundle with attachments
inlined — a manifest plus a folder is the kind of backup that arrives
incomplete. Import defaults to `merge`; `replace` has to be asked for by name.

### Media (decided with the user)

Screenshot plus **tab video via `Page.startScreencast`**. No microphone, no
desktop capture: CDP screencast captures exactly the attached tab, needs no
permission, and has no source-picker in the way of a QA who is trying to report
a bug. Audio and full-desktop capture would cost an offscreen document, a
microphone prompt, and a picker dialog on every recording.

### External task systems stay agent-owned

The browser tool produces portable structured issues, attachments, HAR, and
reproducible test steps. The connected AI agent normally already has the right
GitHub/Jira/Azure/Linear connector and should file from that evidence. No
vendor-specific tracker client or token handling is implemented here; keeping
it out preserves the zero-dependency bridge and avoids duplicating the agent.

### MCP surface

Two grouped tools, keeping §4.4's discipline (12 → 14, not 12 → 30):
`browser_recording` (list/get/start/stop/replay/assert/update/delete/export/import/export_test) and
`browser_issue` (list/get/create/update/delete/screenshot/attach/attachment/video start/stop/status).

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
| `runner/` | Drives all of it with no agent present |

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
   smoothing and copy; sharp on things that moved, got clipped or acquired an
   overlay. This is what `mode: "layout"` compares.
3. The full PNG — in IndexedDB as an attachment, for a human. Never compared.

An old baseline has no structure map, and `compareVisual` throws rather than
silently falling back to `strict`: a comparison the caller did not ask for is a
lie about what was verified.

### Semantic (`aria`) baselines

The accessibility tree, refs stripped and values normalised, stored as a line
list. It survives restyling and fails on a button that became a `div` or a
heading that disappeared. Tolerance defaults to zero — a semantic tree that is
allowed to drift is not a baseline.

The Playwright export writes `toMatchAriaSnapshot()` and lets Playwright own its
own snapshot file rather than translating our normalised form into their YAML;
a translated snapshot that never matches is worse than no snapshot.

### Network pinning

`Fetch` interception, matched on **method + normalised URL**, first unconsumed
entry wins. Request bodies are not matched on — that needs a normaliser per API
and is the kind of cleverness that fails silently.

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
how a QA system loses its audience. That regex is a heuristic and will need
extending as new failure sentences are written — keep it beside the messages it
matches.

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

- **No fifteenth tool.** Pinning went into `browser_network` and the known-world
  actions into `browser_recording`. §4.4's budget is spent on tool *definitions*,
  which are re-sent every request; actions are free.
- **No signature in a tool result.** A full signature is kilobytes of normalised
  evidence. `includeSignature` is an internal flag for calibration; the agent
  gets counts and surprises.
- **No automatic approval, no automatic baseline update, no automatic locator
  repair.** Same rule, three places.

## 9. Change log

Newest first. **Every change to this repo gets an entry.**

### 2026-09-10 — v1.7.0: the panel gets the engine, and three real complaints get answered

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
3. Update the affected section of this file (architecture, component reference, gaps).
4. Adding a tool means **four** edits: `extension/sw.js` router, `bridge/src/tools.js` schema, the README table, and §6 here.
5. Run `node setup/selftest.mjs`. It asserts the tool count, so it fails until everything is updated. Update the assertion last, deliberately — not reflexively.
6. If you remove a deliberate omission from §8, say so and explain what changed.

**Do not simplify past the five constraints in §4** without recording why. Each one exists because the obvious approach fails in a specific, non-obvious way.
