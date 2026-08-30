# AIGuide — G9 Browser Agent

**Purpose of this file.** This is the durable record of what exists in this codebase, why it was built this way, and what is deliberately absent. Read it before changing anything. Update it after changing anything — see [Rules for changing this codebase](#rules-for-changing-this-codebase) at the end.

**Status:** v1.0.3 — self-tested (20/20) and live-tested (19/19) against real Edge. Live CDP confirmed end to end. Test-page defect detection still unverified.
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
│   │   └── emulate.js            device/network emulation, JS dialogs
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
│   ├── install.ps1               Node check, self-test, mcp.json generation
│   ├── selftest.mjs              20 assertions, no browser needed
│   ├── livetest.mjs              live CDP test, needs a real attached tab
│   ├── serve.mjs                 static server for the test page
│   ├── testpage.html             6 deliberate defects
│   └── mcp.json                  generated by install.ps1
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

### 4.2 Agents are bad at CSS selectors

**Consequence:** the ref system in `lib/refs.js`.

`browser_snapshot` walks the accessibility tree, assigns `e1`, `e2`… to interactive nodes, and stores `ref -> backendNodeId` keyed by tab. Interaction tools accept refs.

Refs are versioned by snapshot URL. `Page.frameNavigated` clears them. A stale ref throws an error that *names the recovery* ("take a fresh snapshot") instead of clicking the wrong element. Silent misclicks are the worst possible failure here, so this is deliberately strict.

### 4.3 Synthetic events fail on real applications

**Consequence:** everything in `tools/interact.js` uses `Input.dispatch*Event`.

CDP injects at the browser's input pipeline, before the page. Resulting events have `isTrusted === true` and fire the complete native sequence (`pointerdown → mousedown → focus → mouseup → click`). `element.click()` and `dispatchEvent()` produce `isTrusted === false`, which many frameworks and most protected sites reject.

Specific care taken:

- `pointFor()` scrolls into view, then re-reads geometry, then falls back to `getBoundingClientRect` for transformed or zero-size elements.
- `checkObscured()` uses `elementFromPoint` and, when something else would receive the click, **names the covering element** rather than failing vaguely.
- Typing defaults to per-character key events. `fast: true` uses `Input.insertText`. Both are needed — `insertText` is fine for React/Vue controlled inputs but breaks masked, autocomplete, and key-filtered fields.
- Chords (Ctrl+S) must use `rawKeyDown` with no `text`, or the page receives a literal character instead of the shortcut.
- `drag()` interpolates 12 intermediate moves; HTML5 DnD and most drag libraries ignore a single source→target jump.

### 4.4 Tool definitions are re-sent on every request

**Consequence:** 12 grouped tools, not ~50 flat ones.

Each takes an `action` or `what` discriminator. The full toolset is roughly 3k tokens. For comparison, `chrome-devtools-mcp` spends around 18k tokens on definitions alone. Adding a flat tool per capability would be the easy choice and the wrong one.

### 4.5 The user must be able to trust this

**Consequence:** pinned mode, the activity log, and the Stop button are not decoration.

Without pinned mode, switching to your email mid-task hands the agent your inbox. `tools/tabs.js → resolveTarget()` is a **safety boundary**, not a convenience helper — it refuses rather than guessing, and in pinned mode it rejects `tabId` arguments that point elsewhere.

---

## 5. Security model

Read this before changing `ws-server.js`.

| Layer | Mechanism |
|---|---|
| Network exposure | Bridge binds `127.0.0.1` only. **Never** change to `0.0.0.0`. |
| Origin validation | Only `/^(chrome\|edge\|moz)-extension:\/\/[a-z0-9-]+$/i` may complete the WS handshake. A malicious page's `new WebSocket('ws://127.0.0.1:8765')` sends its own `https://` origin → 403. **This is the primary defence.** Asserted by self-test #3. |
| Single client | A second connection displaces the first rather than silently sharing a session. |
| Optional token | `G9_TOKEN` env var + side-panel field, compared with `crypto.timingSafeEqual`. Off by default. |
| Scope | Pinned mode limits the agent to one consented tab. |
| Kill switch | Stop sets `halted`, checked in `cdp.send()` — so it blocks at the lowest level, not just at the router. |
| Auditability | Every tool call is logged with args, result, and duration, visible live in the panel. |
| Supply chain | **Zero dependencies.** Deliberate: nothing with this much access should carry transitive packages. |

Extension permissions and why each is needed:

| Permission | Reason |
|---|---|
| `debugger` | The entire CDP channel. The core of the tool. |
| `tabs` | Tab list, titles, URLs. |
| `activeTab` | Resolving "the current tab" on user gesture. |
| `scripting` | Reserved for content-script injection; not currently used. **Candidate for removal.** |
| `cookies` | Application-panel cookie reads, including HttpOnly. |
| `storage` | Session and local state. |
| `alarms` | Service-worker revival heartbeat. |
| `sidePanel` | The control UI. |
| `downloads` | Reserved for download management; not currently used. **Candidate for removal.** |
| `<all_urls>` | Attaching to arbitrary user pages. |

---

## 6. Component reference

### `bridge/src/server.js` — deliberately dumb

Owns **no** browser logic. Validates nothing about the page, holds no element state, makes no decisions. It only correlates request ids and surfaces transport errors.

Rationale: the extension is the only side that can actually see the browser, so putting logic in the bridge would split truth across a process boundary. If a click misbehaves, it is wrong in the extension — always. Keep it that way.

Environment variables: `G9_HOST` (default `127.0.0.1`), `G9_PORT` (`8765`), `G9_TOKEN` (empty), `G9_TIMEOUT_MS` (`60000`).

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

The `TOOLS` table maps tool name → `{ needsTab, run({ tabId, tab, args }) }`. Adding a capability is one entry here plus one schema in `bridge/src/tools.js`.

Also owns continuous event ingestion. `Runtime.consoleAPICalled`, `Log.entryAdded`, and the `Network.*` lifecycle are buffered as they happen, so the log is already complete when the agent asks. Polling instead would miss everything that happened before the question.

### `extension/tools/snapshot.js` — perception

Accessibility tree, pruned hard. An unpruned tree from a real app is tens of thousands of nodes.

- `INTERACTIVE` roles → always kept, always get a ref
- `STRUCTURAL` roles → kept only when they carry a name (an unnamed `role=group` tells the agent nothing)
- `NOISE` roles (`generic`, `none`, `StaticText`, …) → dropped, children still walked
- Default cap 900 nodes; `truncated: true` when hit

### `extension/tools/diagnose.js` — the opinionated one

`health` deliberately does the correlation the agent would otherwise do across six tools: console errors, failed requests, broken images, unlabelled form controls, nameless interactive elements, horizontal overflow (with the widest offenders named), duplicate IDs, plus load metrics — merged and ranked by severity.

`performance` records a trace and returns **aggregates only**. A raw Chrome trace is megabytes and useless in a context window.

---

## 7. Testing

`node setup/selftest.mjs` — 20 assertions, **no browser required**. Spawns the real bridge, speaks real MCP over stdio, connects a fake extension over a real WebSocket (hand-rolled client, because the built-in `WebSocket` class cannot set an arbitrary `Origin` — which is exactly what needs testing).

Covers: MCP handshake, instruction delivery, tool count and schema validity, resources, missing-extension error quality, **Origin rejection**, end-to-end routing, argument fidelity, keepalive, image content blocks, error propagation, disconnect handling, stdout hygiene.

> The tool-count assertion (`=== 12`) will fail when you add a tool. That is intentional — it forces this file and the README to be updated too.

`setup/testpage.html` + `serve.mjs` provide six deliberate defects: 2 load-time console errors + 1 uncaught `ReferenceError`, a 404 request, a broken image, an unlabelled password input, 2400px horizontal overflow, a duplicate `id`, plus a transparent overlay covering a button (obstruction detection) and a working login form (`admin` / `g9secret`).

**Untested:** everything that requires a live browser — real CDP attach, trusted-event dispatch against real frameworks, service-worker survival over hours, Edge parity. See §8.

---

## 8. Known gaps and deliberate omissions

**Not yet verified against a live browser.** The self-test proves the plumbing, not the CDP calls. First live run should exercise: attach, snapshot, click, type, console read, network body, diagnose.

**Deliberately absent:**

| Not built | Why |
|---|---|
| `Fetch` domain request interception | Powerful (mock responses, inject headers, bypass basic auth) but a large surface. Add when a real need appears. |
| Heap snapshots / memory profiling | `HeapProfiler` availability to extensions is unconfirmed. Verify before promising it. |
| Lighthouse audits | Not a CDP domain; would need to be bundled separately. |
| Multi-browser (Firefox/Safari) | Would mean WebDriver BiDi and a different architecture. Out of scope. |
| Scenario record/replay | Natural next feature — the activity log already contains the data. |
| Content scripts | Not needed so far; `Runtime.evaluate` covers it. This is why `scripting` is unused. |
| Cross-tab coordination in multi mode | Mode exists and works, but has no orchestration helpers. |

**Known rough edges:**

- SPA route changes via `pushState` invalidate all refs even when the DOM is largely unchanged. Strict on purpose — the error is actionable. Revisit if it proves annoying in practice.
- `scripting` and `downloads` permissions are declared but unused. Removing them would reduce the install warning. Left in place for planned features; remove if those do not materialise.
- Edge's `sidePanel` support is assumed (Edge 114+) but unverified. `bootstrap()` catches the failure, so the extension still loads if absent.
- The `diagnose.performance` trace listener attaches a raw `chrome.debugger.onEvent` handler each call. Correct, but would need care if traces ever run concurrently.

---

## 9. Change log

Newest first. **Every change to this repo gets an entry.**

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
