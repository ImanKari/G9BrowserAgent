# AIGuide — G9 Browser Agent

**Purpose of this file.** This is the durable record of what exists in this codebase, why it was built this way, and what is deliberately absent. Read it before changing anything. Update it after changing anything — see [Rules for changing this codebase](#rules-for-changing-this-codebase) at the end.

**Status:** v1.4.0 — 14 context-efficient browser tools; bridge/MCP 26/26, extension regressions 25/25. **Interaction now verifies that the page actually received the event** — see the v1.4.0 entry, and §4.3a.
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
│   │   ├── visual.js             compact screenshot fingerprint + comparison
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
│   │   ├── qa.js                 assertions, metadata, data, Playwright export
│   │   └── issues.js             defect capture, context, attachments
│   └── panel/                    side panel — the trust surface
│       ├── panel.html/.css/.js
│       ├── welcome.html          shown once on install
│       └── icon{16,48,128}.png   generated, not hand-drawn
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

## 9. Change log

Newest first. **Every change to this repo gets an entry.**

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
