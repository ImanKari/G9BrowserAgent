# G9BrowserAgent v2 — Architecture and internal contracts

This file is the **binding contract** between the modules of G9BrowserAgent v2. It refines
the design recorded in [AIGuide.md](../AIGuide.md) §2 (decisions D1–D12, rules R1–R9): where the two disagree, this file wins for
module boundaries, function signatures, message formats and file locations. Every implementer codes
against the signatures below; if a signature has to change, change it here in the same change set.

Version for everything in this release: **3.2.0**, read from the root `package.json`. (2.0.0 was the first complete build, 2.0.1 added the
adversarial review's 40 fixes, 2.0.2 fixed three defects that flaky tests uncovered and sized the browser close budget from a
measurement, 2.0.3 fixed the side panel's popout, 3.0.0 is the side-panel redesign (U1–U10, AIGuide §6.10),
marked ***(v3)*** below, and 3.2.0 adds the live view, repositories per project, MCP over HTTP and the
browser node image (`docker/`), marked ***(3.2)***.)

**Synced with the code on 2026-09-26 (v3.2.0: the live view, repositories per project and site, approvals beside flows, MCP over HTTP, `G9_LAUNCH_ARGS`, the browser node image; 3.1.x changed no contract here; 3.0.0 was the side panel, U1–U10 in AIGuide §6.10).** Signatures, messages, fields
and defaults below were re-read from the implementation. Text marked ***(as built)*** records something
the code has that the original contract did not (an addition, or a behaviour that changed after the
contract was written); everything else was already accurate or has been corrected in place. The wire
protocol is in [DAEMON_PROTOCOL.md](DAEMON_PROTOCOL.md), synced the same day.

---

## 0. Deviations from the design (and why)

| The design said | v2 does | Why |
|---|---|---|
| `humanize/` at the repo root | **`extension/humanize/`** | An unpacked extension cannot import a file outside its own folder. The daemon imports it from there, exactly as it imports `extension/tools/*`. One copy, two consumers. |
| `bridge/` deleted | `bridge/` deleted **except** `bridge/src/server.js`, a 9-line forwarder to `mcp/shim.mjs` | Every QA machine's MCP config written by v1's `install.ps1` points at `bridge/src/server.js`. The forwarder keeps those configs working; nothing else lives there. |
| Seven intermediate versions 1.8.0 … 1.14.0 | One release, **2.0.0**, then 2.0.1 the review fixes, 2.0.2 the flaky-test round, 2.0.3 the popout fix; now **3.0.0**, the side panel (U1–U10) | The owner asked for the whole design in one release; every change after it bumps the version (D12). |
| "No origin games beyond 127.0.0.1" | The daemon still refuses WebSocket upgrades whose `Origin` is `http(s)://…` | A web page in the QA's own browser is not local; without this any site could drive every tab. Extension origins and origin-less native clients (shim, desktop, runner) are accepted with no token. This restricts nothing the owner asked for. |
| `visual.js` decodes screenshots with OffscreenCanvas | Image work goes through `platform.image` | Node has no image decoder and v2 has no dependencies. Engine 2 decodes inside the launched browser itself. |
| §P2.2: no `AutomationControlled` switch, ever | **Decision D-a.** At stealth level `stealth` only, `stealth.launchArgsFor('stealth')` = `['--disable-blink-features=AutomationControlled']`; `launchBrowser` accepts it there and still refuses it in `extraArgs` at `off`/`human`, and refuses `--enable-automation` always. Every **headless** launch, at every level, also gets `--screen-info={W×H workAreaBottom=48}` — the screen is `windowSize`, with a Windows taskbar — and a `--window-size` that fills the work area, W×(H−48) ***(as built: the taskbar was added after live round 2)***. | Measured on Edge 153, Chrome 153 and CfT 153: `--remote-debugging-pipe` itself makes `navigator.webdriver === true`; only this switch clears it (`Emulation.setAutomationOverride` does not). Headless otherwise reports an 800×600 screen inside a 1920×1080 window, and no work area (`availHeight === height`, 30/30 headless runs). The owner requires stealth runs to be undetectable. `off`/`human` keep telling the truth, and `launchWarnings()` says so. |
| Input level = the call's `humanize` (else the default) | **Decision D-b.** The effective level is the STRICTER of the humanize level and the tab's `platform.settings.stealthFor(tabId)` (off < human < stealth). | A stealth context with `humanize:"human"` fell back to `DOM.focus` and programmatic scrolling — the shortcuts stealth promises never to use. ***(as built)*** In the extension `humanizeFor` is the panel's Input setting (the DEFAULT level) and `stealthFor` is `'stealth'` only when the panel says Stealth, else `'off'`: only Stealth is a floor there — at Human or Direct an agent's `humanize:"off"` gives direct input. |
| An engine is its socket | **Decision D-c.** The extension sends a random `instanceId` (generated once, `storage.local`); the daemon keeps a disconnected extension's engine id, handles, claims, sessions and current tabs for 10 minutes and gives them back when the same `instanceId` reconnects. | MV3 restarts the worker when it likes and the desktop reloads the extension after every update: each reshuffled every handle, and agents lost their tabs mid-task. |
| Launch switches: exactly the designed list | ***(as built)*** Also `msImplicitSignin` in `--disable-features` and `--disable-sync`; `--disable-component-update` is left out at stealth `stealth` and when a profile is warmed; `--disable-frame-rate-limit` for Chrome for Testing only (`engine/launch.js` `DISABLED_FEATURES`, `FIXED_SWITCHES`, `fixedSwitchesFor`, `KIND_SWITCHES`). | Measured on Edge 153: fresh profiles signed themselves into the Windows account and synced it (passwords, history, extensions); `--disable-component-update` removed Widevine, a classic automation tell; CfT 153's renderer ran at 10 Hz (100 ms between frames and mouse events), re-confirmed 2026-09-23 in an interleaved A/B (100.5 ms in 8/8 launches without the switch, 17.4 ms in 12/12 with it). |
| Browser-level auto-attach with `waitForDebuggerOnStart:false` | ***(as built)*** `waitForDebuggerOnStart:true`: every new target is held, prepared (`prepareTab`/`prepareChild`, §3.2) and then resumed. | A `window.open()` popup under browser-level auto-attach wedged its opener (18/18, Edge and Chrome 153); a page-opened tab and a cross-site iframe need the persona and the tool layer's domains before their first script. |
| Later tabs of a context join its window, as a person's would (F1) | ***(as built)*** Every page G9BrowserAgent opens (`createTab`) gets a window of its own; a page the PAGE opens still joins its opener's window, and a tab left behind another in its real window is brought forward on a headless engine (`tabs.ensureFront`). | A tab behind another in its window is rendered about once per 1.5 s even headless: a humanized click took 85 s, a screenshot 46 s (P8 matrix, round 2); after the change, 4.3 s and 83–115 ms (round 3). |

---

## 1. Runtime topology

```
AI agent ──stdio MCP──▶ mcp/shim.mjs ──WS /g9──▶ daemon/g9d.mjs ──(in-process)──▶ Engine 2 runtime
AI agent ──stdio MCP──▶ mcp/shim.mjs ──WS /g9──┘      │   ▲                          engine/manager.js
runner/g9.mjs ────────▶ mcp/shim.mjs ──WS /g9──┘      │   │                          extension/tools/index.js (platform-cdp)
desktop (Electron) ───────────────────WS /g9──────────┘   │                          ──pipe CDP──▶ Edge/Chrome/CfT
                                                          │
extension/sw.js (Engine 1) ───────────WS /g9──────────────┘   tools run INSIDE the extension (platform-extension)

(3.2) remote agent ──HTTPS──▶ reverse proxy ──HTTP /mcp──▶ mcp/http.mjs ──WS /g9 (one link per MCP session)──▶ g9d
```

* **One daemon per machine** on `127.0.0.1:${G9_PORT:-8765}`. It owns engines, contexts, tab handles,
  ownership, halts, evidence and the scheduler.
* **Engine 1** = the extension. Tool calls for its tabs are relayed to it and run inside the service
  worker, as in v1.
* **Engine 2** = browsers the daemon launched. Tool calls run **inside the daemon process**, using the
  very same `extension/tools/*.js` modules with `platform-cdp`.
* Data home: `G9_HOME` env, default `%LOCALAPPDATA%\G9BrowserAgent` (Windows) / `~/.g9browseragent` (other). Layout in §9.

---

## 2. Root package and version

* `package.json` at the repo root: `{ "name": "g9browseragent", "version": "3.3.0", "private": true,
  "type": "module", "engines": { "node": ">=22" }, "scripts": { … } }`. No dependencies.
* `extension/manifest.json.version` **must equal** it; `desktop/package.json.version` **must equal** it.
  `setup/unit/version.test.mjs` enforces both ***(as built)*** and also compares the version in
  `desktop/package-lock.json` (`npm ci` in `desktop/` installs from it).
* Node code reads the version with `import { VERSION } from '<root>/lib/version.mjs'`
  (`lib/version.mjs` reads `../package.json` once, synchronously). The extension reads
  `chrome.runtime.getManifest().version` (via `platform.runtime.version()`).

---

## 3. The platform seam — `extension/lib/platform.js`

Rule R2: nothing under `extension/tools/`, `extension/humanize/` or the shared parts of
`extension/lib/` may reference `chrome.`, `browser.`, `globalThis.chrome`, `indexedDB`,
`OffscreenCanvas`, `createImageBitmap`, `FileReader`, or import `node:` modules. Allowed exceptions:
`extension/lib/platform-extension.js` (chrome, indexedDB, OffscreenCanvas), `extension/sw.js`,
`extension/lib/transport.js`, `extension/panel/**`. Page-side code inside template strings that is
evaluated **in the page** (e.g. `navigator.userAgent` in an evaluate expression) is not a violation;
the source check skips string literals that are passed to `evaluate`/`callOnNode`/`inWorld`.

```js
// extension/lib/platform.js — no top-level await, static imports only
import { platform as extensionPlatform } from './platform-extension.js';
import { platform as cdpPlatform } from './platform-cdp.js';
const hasChrome = !!(globalThis.chrome?.debugger || globalThis.browser?.debugger);
export const platform = hasChrome ? extensionPlatform : cdpPlatform;
export const isExtension = hasChrome;
```

Both implementations export an object with **this exact surface** (Promise-returning unless noted):

```ts
platform.name: 'extension' | 'cdp'

platform.debugger = {
  attach(tabId): Promise<void>,                 // idempotent
  detach(tabId): Promise<void>,
  sendCommand(tabId, method, params = {}, sessionId = null, { timeoutMs }? = {}): Promise<object>,
      // sessionId = CHILD session (iframe) or null. timeoutMs = cdp.js's budget for this command:
      // platform-cdp forwards it +2 s to conn.send so cdp.js's own (named) timeout wins; the extension ignores it.
  getTargets(): Promise<Array<{ tabId, attached: boolean }>>,
  onEvent(fn: (source: { tabId, sessionId?: string }, method, params) => void): () => void,   // add listener → unsubscribe
  onDetach(fn: (source: { tabId }, reason: string) => void): () => void,                       // → unsubscribe
}

platform.tabs = {
  get(tabId): Promise<Tab>,                      // rejects if the tab does not exist
  query(info = {}): Promise<Tab[]>,              // supports {}, {active:true, lastFocusedWindow:true}, {active:true, windowId}
  create({ url, active = false, windowId? }): Promise<Tab>,
  update(tabId, { url?, active? }): Promise<Tab>,
  remove(tabId): Promise<void>,
  ensureFront(tabId): Promise<{ front: true, activated?: true } | { front: false, behind: true, headless } | null>,
      // (as built) cdp: a tab behind another in its REAL window is brought forward (Target.activateTarget) on a
      // headless engine and only reported on a headed one; extension: null (it never rearranges a person's tabs).
      // Called by interact.js before input and by capture.js before a screenshot.
  onRemoved(fn: (tabId) => void): void,
  onCreated(fn: (tab: Tab) => void): void,
  onUpdated(fn: (tabId, changeInfo, tab: Tab) => void): void,
}
// Tab = { id, url, title, windowId, active, status: 'loading'|'complete', openerTabId?: number }
//       platform-cdp Tabs (and its synthetic windows) also carry { engineId, contextId }; (as built) a page G9BrowserAgent
//       opened carries ownWindow: true, and `active` means "in front of its REAL window" (Browser.getWindowForTarget).
// cdp: tabs.get re-reads url/title (Target.getTargetInfo, ≤3 s) and tabs.query does one Target.getTargets
// per engine — measured: headless Edge 153 does not push Target.targetInfoChanged for <title> changes.

platform.windows = {
  WINDOW_ID_NONE: -1,
  get(windowId, opts?): Promise<Window>, getAll(opts?): Promise<Window[]>,
  create(opts): Promise<Window>,                 // cdp: rejects: "Popping a tab into its own window is an Engine 1 (extension) action; launched engines have no windows."
  update(windowId, opts): Promise<Window>,       // cdp: no-op, returns the synthetic window
  onFocusChanged(fn): void,
}
// Window = { id, type: 'normal'|'popup', state: 'normal'|'minimized'|'maximized'|'fullscreen', focused, tabs?: Tab[] }

platform.cookies = {
  getAll(filter: { url?, domain?, name?, tabId? }): Promise<Cookie[]>,   // chrome.cookies shape (below), HttpOnly included
  set(details: chrome.cookies.SetDetails-shape & { tabId? }): Promise<Cookie|null>,
  remove({ url, name, tabId? }): Promise<void>,
}
// `tabId` (not a chrome field): platform-cdp uses that tab's engine and browser context (without it, the
// focused tab's); platform-extension strips it before calling chrome.cookies.
// Cookie = { name, value, domain, hostOnly, path, secure, httpOnly, sameSite: 'no_restriction'|'lax'|'strict'|'unspecified',
//            session, expirationDate? }

platform.storage = {
  session: { get(keys), set(obj), remove(keys) },   // chrome.storage.session semantics (get returns an object)
  local:   { get(keys), set(obj), remove(keys) },   // chrome.storage.local semantics
}

platform.blobs = {                                   // replaces direct IndexedDB use in store.js
  put(storeName, record: { id, ...fields, blob?: Blob|Uint8Array }): Promise<void>,
  get(storeName, id): Promise<record|null>,
  delete(storeName, id): Promise<void>,
  byIndex(storeName, field, value): Promise<record[]>,        // e.g. ('blobs','owner',issueId), ('video-frames','sessionId',sid)
  deleteByIndex(storeName, field, value): Promise<number>,
  stats?(storeName): Promise<{ count, bytes }>,               // optional; bytes = Σ record.size. store.usage() falls back to
                                                              // per-owner metadata without it. The extension (IndexedDB cursor),
                                                              // platform-cdp's memory store and the daemon's FileBlobs all have it.
}
// store names used: 'blobs' (indexed by 'owner'), 'video-frames' (indexed by 'sessionId').

platform.image = {
  // Decode a PNG/JPEG and return RGBA pixels, optionally scaled to fit `fit` (square box) — used by visual.js.
  decode(dataBase64, mime, { fit?: number, width?: number, height?: number } = {}):
    Promise<{ width, height, rgba: Uint8ClampedArray, sourceWidth, sourceHeight }>,
    // width+height stretch to exactly that size (how v1's stored fingerprints were computed); fit keeps the aspect ratio.
  // Encode RGBA back to a PNG (visual diff output). Returns base64.
  encodePng({ width, height, rgba }): Promise<string>,
}

platform.runtime = {
  version(): string,                 // sync
  getURL(path): string|null,         // sync; cdp returns null
  reload(): void,                    // extension: chrome.runtime.reload(); cdp: no-op
  broadcast(message): void,          // extension: runtime.sendMessage to the panel (errors swallowed); cdp: hook (see configure)
}

platform.settings = {
  // Per-tab behaviour defaults that differ between engines. Sync.
  humanizeFor(tabId): 'off'|'human'|'stealth'|string,   // string = named/calibrated profile
  stealthFor(tabId): 'off'|'human'|'stealth',           // also the FLOOR of the input level (decision D-b, §5)
  noteInputMode(mode): void,   // state.js calls it on every getState/setState to keep the extension's sync cache; cdp: no-op
}

platform.downloads = {
  available: boolean,
  // Start/stop reporting downloads for a tab. cdp: Browser.setDownloadBehavior({behavior:'allowAndName',
  // browserContextId, downloadPath, eventsEnabled:true}) on the BROWSER session (tool code cannot reach
  // the Browser domain through a page session). extension: chrome.downloads listeners.
  begin(tabId, { downloadPath? } = {}): Promise<{ mode: 'extension'|'cdp', downloadPath: string|null }>,
  end(tabId): Promise<void>,
  onEvent(fn: (evt: DownloadEvent) => void): void,
  // File facts. cdp: via the injected fileInfo hook (daemon: size, sha256, first 16 bytes, sniffed mime).
  // extension: chrome.downloads.search → { exists, size } only (no content access).
  // Results carry source: 'disk'|'browser' (the extension's also `path`). cdp REJECTS when the fileInfo
  // hook throws (tools/downloads.js reports verified:false with that reason — never "no way to check").
  inspect(evt: DownloadEvent): Promise<{ exists, size, sha256?, magicHex?, mime?, source, path? } | null>,
}
// DownloadEvent = { id, tabId|null, url, filename, path|null, state: 'in_progress'|'complete'|'interrupted'|'canceled',
//                   receivedBytes, totalBytes, error?, mime?, startedAt, endedAt?, attribution: 'exact'|'probable'|'unknown',
//                   viaTabId? }
// cdp maps Browser.downloadWillBegin.frameId to the tab whose page target id equals it ('exact'); a download
// from a popup the watched tab opened is attributed to the opener with viaTabId = the popup ('exact').
// extension attributes by URL seen in that tab's Network events ('exact') or referrer/origin ('probable'),
// and reports nothing while no tab is watched.
```

`platform-cdp.configure()` additionally accepts `fileInfo?: (path) => Promise<{exists,size,sha256,magicHex,mime}>`
and `downloadPath?: string | (engineId, contextId) => string` (the folder for contexts registered without one).

### 3.1 `platform-extension.js`

Thin wrappers over `chrome.*`. `debugger.sendCommand` builds `{tabId}` or `{tabId, sessionId}`.
`blobs` is the IndexedDB code moved out of `store.js` verbatim (DB `g9-attachments`, version 2, same
store names and indexes, so existing data survives the upgrade). `image` uses `createImageBitmap` +
`OffscreenCanvas` in the worker (moved from `visual.js`). `settings.humanizeFor/stealthFor` read a
**synchronous cache** of `state.inputMode` (`'off'|'human'|'stealth'`, default `'human'`) that
`state.js` keeps current on every `getState`/`setState` (through `noteInputMode`). ***(as built, D-b)***
`humanizeFor` returns that mode; `stealthFor` returns `'stealth'` only when it is `'stealth'`, else `'off'`.
Additive export: `targetSize(sourceWidth, sourceHeight, { fit, width, height })` (the image scaling rule).

### 3.2 `platform-cdp.js`

Browser-safe (no `node:` imports). Supports **several launched browsers at once**.

```ts
configure({
  allocTabId?: () => number,                 // daemon supplies global handles; default: local counter from 1
  storageLocal?: StorageArea,                // daemon injects a file-backed one; default in-memory
  storageSession?: StorageArea,              // default in-memory
  blobs?: typeof platform.blobs,             // daemon injects file-backed; default in-memory
  version?: string,
  onBroadcast?: (message) => void,           // runtime.broadcast target (daemon → UI clients)
  defaults?: { humanize: string, stealth: string },
  // Round 4: run while a NEW target is held (see Behaviour); they SEND commands, never await answers.
  prepareTab?: (tabId, { targetInfo, waitingForDebugger }) => void,
  prepareChild?: (tabId, { sessionId, targetInfo, parentSessionId }) => void,
}): void

registerEngine(engineId: string, conn: CdpConnection, opts?: { imageContextId?: string, headless?: boolean }): Promise<void>
unregisterEngine(engineId): void               // marks its tabs gone, emits onRemoved + onDetach('target_closed')
registerContext(engineId, browserContextId, { humanize?, stealth?, downloadPath? }): void
setDefaultContext(engineId, browserContextId|null): void       // where tabs.create() opens by default
createTab(engineId, browserContextId|null, url): Promise<Tab>   // explicit placement (daemon `open`)
tabInfo(tabId): { engineId, targetId, sessionId, browserContextId } | null
tabsOf(engineId): number[]

// CdpConnection (implemented by engine/pipe-cdp.js):
//   send(method, params = {}, sessionId = null, { timeoutMs } = {}): Promise<object>
//   on('event', (method, params, sessionId) => void); on('close', () => void); close(): void

// (as built) configure() also takes fileInfo and downloadPath (above §3.1); later calls merge.
// Additive exports: PREPARE_BUDGET_MS (3000: the longest a new target is held for its preparation),
// NAVIGATE_COMMIT_MS (60000: how long tabs.update({url}) waits for the navigation to commit),
// toChromeCookie, domainMatches, pathMatches, cookieMatches, createMemoryStorageArea, createMemoryBlobStore.
```

Behaviour:

* On `registerEngine`: `Target.setDiscoverTargets({discover:true})` and browser-level
  `Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:true, flatten:true})`. Every
  **page** target becomes a tab with a handle from `allocTabId()`; its page session id is stored.
  Service workers, iframes attached at browser level, and the engine's hidden image context are not tabs.
* **Held targets (round 4).** Every target that attaches — browser-level, and the children the tool
  layer's page-level auto-attach brings (`debugger.sendCommand` turns its `waitForDebuggerOnStart` on) —
  is resumed with `Runtime.runIfWaitingForDebugger` right after `prepareTab`/`prepareChild` has SENT its
  commands (bounded: `PREPARE_BUDGET_MS`, 3 s), non-tabs at once; nothing is ever left paused. Why: a
  `window.open()` popup under browser-level auto-attach is held until that command arrives (its opener
  wedged: 18/18, Edge and Chrome 153), a tab the page opens must get its persona and the tool layer's
  domains before its first document, and a cross-site iframe (a renderer process of its own) needs the
  timezone/locale overrides on its own session. A held target=_blank tab answers nothing but applies,
  in order, what was sent before the resume.
* `tabs.ensureFront(tabId)` (platform-cdp only; the extension's is a no-op returning null): a tab
  behind another in its REAL window (a page-opened tab joins its opener's window in front of it) is
  brought forward with `Target.activateTarget` on a headless engine, and reported on a headed one.
  `Tab.active` is "in front of its real window" (learned with `Browser.getWindowForTarget`).
* `debugger.sendCommand(tabId, m, p, child)` → `conn.send(m, p, child ?? tab.pageSessionId)`.
* Events: a CDP event on a page session → `source {tabId}`; on a known child session → `source
  {tabId, sessionId: child}` (child → tab map learned from `Target.attachedToTarget` arriving on the
  page or on another child of that tab). Browser-level `Target.*` events maintain the registry.
* `debugger.attach` is a no-op when the page session exists; otherwise `Target.attachToTarget({flatten:true})`.
  `detach` is a no-op (Engine 2 tabs are always attached). `getTargets` lists every page tab, `attached` while its
  page session exists ***(as built: a tab whose session died reports `attached:false`)***.
* `tabs.create` → `Target.createTarget({url, browserContextId, newWindow:true, background:!active, focus:false,
  left?, top?, width?, height?})`, waits for its attach (and its preparation and resume), returns the Tab.
  **F1, as built:** EVERY page G9BrowserAgent opens gets a window of its own. Chrome/Edge refuse `newWindow:false` for the
  first page of a fresh context ("Failed to open new tab - no browser is open", headless Edge 153), and a later
  page that joined the context's window left the earlier tab behind it, rendered about once per 1.5 s even
  headless (P8 matrix, round 2). A new window copies the bounds of an existing window of that engine (so a
  headed engine's window opens where the engine lives), never takes OS focus, and is retried without the
  bounds if a browser refuses them. `createTab()` (the daemon's `open`, handoff, `context`) is the same code,
  so EngineManager has no workaround of its own. `update({url})` → `Page.navigate`, given `NAVIGATE_COMMIT_MS`
  (60 s) because it answers only when the server's response headers arrive; `update({active:true})` →
  `Target.activateTarget`. `remove` → `Target.closeTarget`. Title/url tracked from `Target.targetInfoChanged`.
  ***(as built)*** `query({active:true, lastFocusedWindow|currentWindow})` returns the most recently
  created/activated tab of the default context (else of any context); `query({active:true})` alone, or with a
  `windowId`, returns every tab that is in front of its own real window — usually several, because every page
  G9BrowserAgent opens has a window of its own.
* `windows`: one synthetic window per browser context (`id` = stable small integer), `type:'normal'`,
  `state:'normal'`, `focused:true`. `create` rejects: `"Popping a tab into its own window is an Engine 1
  (extension) action; launched engines have no windows."` ***(as built)*** These synthetic windows are what
  `platform.windows` answers; a tab's REAL window (`Browser.getWindowForTarget`) is used only for `Tab.active`,
  `tabs.ensureFront` and `tools/tabs.js realWindowState(tabId)` (a minimized headed window is reported by
  `browser_status` and by a stalled capture's note).
* `cookies`: `Storage.getCookies({browserContextId})` filtered by url/domain/name with RFC 6265 domain
  and path matching; converted to the chrome shape. `set` → `Storage.setCookies`. `remove` →
  `Storage.setCookies` with an expiry in the past for the matching cookie.
* `image.decode/encodePng`: evaluated in a **hidden utility page** per engine (`about:blank` in a
  dedicated browser context created at register time and never reported as a tab), with
  `createImageBitmap`/`OffscreenCanvas` in page JS; RGBA crosses as base64.
* `settings.humanizeFor/stealthFor(tabId)`: from the tab's context registration, else `configure().defaults`.

---

## 4. Shared tool runtime — `extension/tools/index.js` and `extension/tools/events.js`

The flat `TOOLS` table leaves `sw.js`. Both engines run it.

```ts
// extension/tools/index.js
export const TOOLS: Record<string, {
  needsTab?: boolean,            // default true
  allowWhenHalted?: boolean,     // default false
  run: (ctx: { tabId, tab, args, caller }) => Promise<any>,
}>

export function setHooks(h: {
  connection?: ({ tabId }: { tabId: number|null }) => object,   // extra fields for browser_status; tabId = the tab the
                                                                // status is about, so a host with several browsers names ITS engine
  emit?: (event: string, data: object) => void,   // e.g. 'dialog', 'download', 'frame', 'pointer', 'activity'
}): void
export const hooks: { connection, emit }          // read-only view, for tools/events.js

// The whole pipeline that used to be sw.js handleBridgeMessage, minus the socket:
// halted check → target resolution → dialog check (scoped to the call's own tab) → run → activity log.
export async function runTool(tool: string, args: object, caller?: { agentId?, name?, relayed? }): Promise<any>  // throws Error on failure
export function isReadOnly(tool: string, args: object): boolean
export async function status(args?: { tabId? }): Promise<object>   // browser_status's engine-local part (F4, below)
export function summarize(tool, args): string                      // the activity log's one-line description
// (as built)
export function holdsSlot(tool: string, args: object): boolean     // does the call take one of Engine 2's maxParallel
      // slots? Every mutating call EXCEPT the waits (browser_navigate "wait", browser_network "wait_download",
      // browser_tabs "wait"): they stay mutating for ownership, halt and dialogs, but hold no slot (P8 bench).
export function tagDelivery(error: Error): Error                    // runTool calls it on every error: an input error's
      // state is put at the START of its message, "[delivery: missed; hit <div#x>]", "[delivery: not-delivered;
      // tab hidden]", "[delivery: partial; 3 of 12 input events sent; tab hidden]" — every relay keeps only text.
```

* **Order:** halted → resolve → dialog. Resolution never touches CDP, and knowing the tab first scopes a
  JavaScript dialog to ITS tab: one agent's `alert` does not block other agents' tabs. Tools without a tab
  are blocked only when they are mutating calls aimed at the dialog's tab. `browser_dialog` and
  `browser_tabs action:"close"` always pass (the browser closes a tab without the blocked renderer's help).
* **`isReadOnly`** is stricter than a plain read list in four cases: `browser_console` with `clear:true`,
  `browser_network` with `clear:true`, `browser_diagnose what:"performance"` with `reload:true`, and
  ***(as built, 2026-09-22)*** `browser_screenshot` with `area:"element"` or `"fullpage"` — the first
  scrolls the element into view (trusted wheel notches at the human levels, `scrollIntoView` at `off`),
  the second resizes the viewport, so both change the page under whoever is driving it; only
  `area:"viewport"` is a read. Classified by the ARGUMENT, not by level or page size: the router
  decides before the page is measured. (So is `browser_console action:"evaluate"`, which runs the
  agent's code in the page.)
* **Activity (F7):** each call is logged `{ kind:'tool', tool, tabId, ok, detail, ms, by?, relayed? }` —
  `by` = the caller's name; `relayed:true` when `caller.relayed` (the daemon sends it on every call it relays
  or runs, `daemon/router.js #caller`). The daemon does not forward `relayed` records to the desktop (it
  reported that call itself); records without it (the side panel's own actions) are forwarded.
* **`status(args)` (F4):** with `args.tabId`, `current` and `health` describe THAT tab; the engine's own
  current tab, when different, is `engineCurrent`; a tab that does not exist gives `current:null` and a
  `targetError` (never another tab in its place). Without it, the engine's own current tab. Other fields:
  `engine`, `version`, `browser` (extension: the user agent), connection hook fields, `halted`, `dialogOpen`,
  `dialogs` (when more than one is open), `tabs:{count, rows}` (at most 25 rows), `sessions`, `inputMode`,
  `autoAttach`, `attachedCount`, `warnings?`, `hint`. ***(v3)*** `current.attachedSince` (epoch ms, or null),
  `autoAttachMode` (`'off'|'project'|'all'`, extension only); `autoAttach` stays a boolean (§13). The daemon passes the tab its status is about (§8).
  ***(as built)*** `warnings` name a minimized window, an extension tab that is not the active tab of its window
  (hidden: reads work, input may not), and a launched tab that is BEHIND another tab in its real window. The
  connection hook adds `{connected, reconnecting}` in the extension and `{engine:'launched', engineId,
  browser:{kind, version, headless}, daemon:{version}}` on Engine 2.

```ts
// extension/tools/events.js — the CDP event fan-out that used to live in sw.js
export function onCdpEvent(source: { tabId, sessionId? }, method, params): void
export function onDetach(source: { tabId }, reason): Promise<void>
export function onTabRemoved(tabId): Promise<void>
```

`sw.js` wires `platform.debugger.onEvent(onCdpEvent)`, `onDetach`, `platform.tabs.onRemoved(onTabRemoved)`,
keeps lifecycle, panel commands and the transport, and calls `runTool` for `call` messages. The daemon's
Engine 2 runtime wires the same three functions against `platform-cdp`.

### 4.1 Target resolution (both engines, v2 — no modes)

`tools/tabs.js` `resolveTarget(explicitTabId, sessionName)`:

1. `explicitTabId` → that tab; must exist and be attachable (not `chrome://`, `edge://`, `about:` other
   than `about:blank`, `devtools://`, `view-source:`, `chrome-extension://`, the web stores).
2. `sessionName` → `state.sessions[name]`.
3. `state.currentTabId` if that tab still exists (set by the panel's Attach, by `browser_tabs attach`,
   and by `open`/`session` with `focus` or when nothing is current).
4. The active tab of the last normal window (`getActiveTab()`, unchanged).
5. Otherwise: `"No tab to act on. Open one with browser_tabs action:\"open\", or attach one."`

There is no mode, no allowlist, no redaction: `listTabs()` returns full `title` and `url` for every
tab, `inspect.cookies` reads any domain, `requireTabControl()` is deleted, `lib/workspace.js` is
deleted, `state.mode`/`pinnedTabId`/`project.workspaceDomains` are deleted (`migrateModeDefault` too;
a one-time cleanup removes `settings.mode` from `storage.local`).

`listTabs()` rows: `{ tabId, title, url, active, windowId, windowState, current, attached, attachable,
status, openerTabId, session? }` — tab identity is always the key **`tabId`**, never `id`.

### 4.1b Additive exports and result fields (recorded from the build)

* `lib/cdp.js`: `timeoutFor(method, override?)`, `applyStealthLevel(tabId)`, `forgetTab(tabId)` (clears the
  ensureDomain cache; events.js calls it on detach and tab removal), `sendOnLiveSession(..., sessionId?)`.
  ***(as built)*** `attachHeld(tabId)` (the tool layer's attach for a target platform-cdp is holding),
  `COMMAND_TIMEOUT_MS` (20 s), `SLOW_COMMANDS` (`Page.captureScreenshot` 45 s, `Page.getLayoutMetrics` 30 s,
  `Tracing.end` 45 s, `IO.read` 45 s), `NAVIGATION_COMMANDS` (`Page.navigate`, `Page.reload`,
  `Page.navigateToHistoryEntry`) and `timeoutMessage(method, ms)`: a navigation command that runs out of time
  names the SERVER (it answers when the response headers arrive), any other command "stuck rather than slow".
  `engine/pipe-cdp.js` uses the same table and wording.
* ***(as built)*** `tools/navigate.js`: `timeoutMs` of `goto`/`reload` (default 30 s) is the deadline of the
  whole call; the navigation command gets `navigationBudget(timeoutMs)` = max(timeoutMs, 20 s), the load wait
  what is left. `tools/tabs.js`: `realWindowState(tabId)` → `'normal'|'minimized'|'maximized'|'fullscreen'|null`.
  `tools/interact.js` also exports `WITNESS_FN`, `MODIFIERS`, `modifierMask`, `bringIntoView`.
* `lib/state.js`: `migrateLegacySettings()`, `getAbout()`/`setAbout()` (storage.local `about` =
  `{previousVersion, updatedAt, lastSeenVersion, installedAt}`), `updateState(fn)`, `noteDialog(dialog)`,
  `forgetDialog(tabId)`; state field `dialogs` (§13).
* `tools/tabs.js`: `attachTab`, `detachAllTabs`, `peekTarget`, `popout`, `handoffExport`; `pinTab`,
  `unpinTab`, `requireTabControl` are gone. ***(as built, 2.0.3)*** `popout(tabId, { width, height, left,
  top, focus = false })` and `popoutGeometry(source, { width, height, left, top })` → `{ width, height,
  left, top }` (§4.2).
* ***(v3)*** `lib/sites.js` (new, pure, R2): `siteOf(url)` → origin or null (opaque origins are null),
  `parseDomain(domain)`, `hostMatches(url, domains)` (exact host or subdomain; a domain's port must match
  when given; http(s) only), `displayUrl(url)` → `{ origin, host, path, query, hash, href }`. `lib/cdp.js`:
  `attach(tabId, { log = true })` (`log:false` leaves the activity line to the caller), `forgetAttached(state,
  tabIds)` (the `attachedTabs`/`attachedSince` patch without those tabs). `tools/tabs.js`: `attachTab(tabId,
  { clearHalt, log })`. `lib/state.js`: `AUTO_ATTACH_MODES`, `autoAttachMode(value)`. `lib/store.js`:
  `issueIndexEntry(record, attachments)`, `issueEvidence(record, attachments)`.
* ***(3.2)*** `lib/approved.js` (new, pure, R2) — what a person approved, as a sidecar beside the flow file
  (format `g9-approved`, schemaVersion 1): `approvedDocFor(recording)` → `{ doc, images:[{name, stepId,
  attachmentId}] }` or null (the known world only when a PERSON approved it — `isApproved(kw)`: `approvedAt`
  set and `approvedBy !== 'seed'`; screenshot baselines `{kind:'screenshot', fingerprint, structure,
  visualMode, masks, image}`, aria baselines `{kind:'aria', lines, maxNodes}`, keyed by the FlowSpec step id
  `stepIdOf(step, i)`), `approvedJson(doc)` (canonical bytes), `validateApproved(doc, flowId)`,
  `applyApproved(recording, doc, local)` → `{ recording, knownWorld:'repo'|'local'|null, localNewer,
  baselines:{fromRepo, kept}, images }` (per step: the sidecar's baseline, else the local one; known world:
  the later human approval), `setBaselineImage`, `approvedAtFor`, `imageNameFor`.
  `lib/flowsync.js` (new, R2; store-backed): `findByFlowId(flowId)`, `approvedBundle(recordingOrId)` →
  `{ flowId, approved, images:{name: base64} }`, `importFlow(spec, { approved, images, id })` → `{ id, name,
  steps, created, knownWorld, localNewer, baselines, images }` — the ONE way a FlowSpec enters a store (the
  panel's Pull, `browser_recording import_spec`, the runner): finds the local copy by flow id (Pull used to
  save every repo flow again under a new id), keeps run history, flakiness, surprise history and the last
  signature, applies the sidecar, stores a baseline image once per content. `lib/store.js`: the recording
  index carries `flowId`. `tools/replay.js`: `onApproved(fn)` — `approveKnownWorld` awaits the listener
  (15 s at most) and returns what it did as `repo`; a failing listener never fails the approval (the worker
  writes through the daemon's flow library, the engine manager through the daemon). `browser_recording`:
  `import_spec` takes `approved` and `images`; `export_spec` returns `approved` and, with `includeImages`,
  `images` (else `imageNames`). `browser_tabs`: `watch` (§4.2). `lib/transport.js`: `connectedAddress()`.
  `panel/report.js`: `summarizeHistory(recordings)`, `buildHistoryReport(summary, {scope, at, product,
  version})` (a DOM document serialised once), `reportFileName(scope, at)`. `panel/watch.js` + `watch.html`:
  the live view (§8, DAEMON_PROTOCOL §10); `panel/track.js` is `desktop/renderer/lib/track.js`, byte for byte.
* `tools/record.js`: `recordingTabs()` (every tab recording now), `inputSamplesOf`, `calibrateFromRecording`;
  `startRecording` REFUSES a tab that is already recording (v1 silently replaced the session and leaked the
  first one's scripts). `interact.witnessExpression` is exported for the tests.
* Result fields: `browser_navigate` may add `humanIdleMs`, `seed`, `humanIdleInterrupted` (the post-load
  human idle at human/stealth); screenshots add `pointer`; `browser_status` adds `warnings` and, on the
  extension, `browser` (the user agent); `browser_tabs open` accepts `name`; `browser_recording
  calibrate_humanize` takes `id` or `ids`, `base` and `name`; replay passes `humanize`/`seed` and reports
  `humanize {level, profile, raisedFrom?, stealthLevel?}` and `humanizeSeed`; download rows may carry
  `tabId`, `viaTabId`, `missing`, `note`; `watch_downloads` starts a fresh list each time.
  ***(as built)*** Screenshots: a capture that stalled (and was retried once) or took over 10 s carries
  `note` with the cause when the page or its window can tell (hidden, behind another tab, minimized); a
  full-page capture at `human` carries `pageSaw` (the page saw its viewport resized) and is refused at
  `stealth`, where an element is reached with the wheel and captured with a viewport clip. Replay reports
  `settledAfterLastStep` (it waits, at most 2 s, for the page to go quiet before building the signature: no
  request in flight and no new console entry or request for 500 ms; `replay.awaitQuiet` starts that window
  only once a poll has seen `pending === 0`, since 2.0.2) and
  `surpriseCount`; `handoff_export` also returns `exportedAt`.

### 4.2 New/changed `browser_tabs` actions inside the extension

| action | Engine 1 behaviour |
|---|---|
| `attach` | attach `tabId` (or the active tab), make it current, return `{tabId, title, url}` |
| `popout` | ***(as built, 2.0.3)*** `chrome.windows.create({tabId, focused: !!focus, state:'normal', …popoutGeometry(sourceWindow, {width, height, left, top})})`; the tab keeps its renderer (no reload). Two callers: the side panel's button passes `focus:true` (the window comes up in front, nothing is re-focused); an agent's call defaults to `focus:false`, and the window the user was in is re-focused only if it lost focus. Default geometry: half the source window's width and three quarters of its height, clamped to 640–1280 × 480–1000, right edge 24 px inside the source's, top 72 px below the source's; explicit values win. Then waits (≤ 2 s) until the tab lists with its title and its renderer answers, and reads `document.visibilityState` about 600 ms later. Returns `{tabId, windowId, focused, visible: true\|false\|null, title?, note}`; the note says a completely covered window stops rendering on Windows unless `WindowOcclusionEnabled` is off, and when `visible` is false, that the window is not visible now |
| `handoff_export` | internal (daemon-only): `{ url, title, origin, cookies: Cookie[], localStorage: [[k,v]…], sessionStorage: [[k,v]…], viewport: {width,height,dpr}, userAgent }` — cookies for the tab's host and every parent domain; storage read in the isolated world |
| `open` | `{url, focus?, name?}` — `name` also makes it a named session (`session` in the result) |
| `pin`/`unpin` | removed |
| `watch` | ***(3.2)*** daemon-level, both engines: `{ tabId?, on = true, focus = false }` → `{ tabId, on, shown, shownIn, note }` (DAEMON_PROTOCOL §10). Read-only (`isReadOnly`): no ownership, no queue. The extension opens `panel/watch.html` in a popup window (`chrome.windows.create({type:'popup', focused: focus})`, then `drawAttention` when unfocused) or adds the tab to the open one; its id is kept in `storage.session` `g9:watchWindow` |

---

## 5. Isolated worlds, witness, pointer, screencast — `extension/lib/{world,pointer,screencast,humanize}.js`

```ts
// world.js — G9BrowserAgent's private JavaScript world in a page (never the page's own globals)
export const WORLD = 'g9';
export async function contextFor(tabId, { sessionId = null, frameId = null } = {}): Promise<number>
  // Page.createIsolatedWorld({frameId: frameId ?? main frame, worldName: WORLD, grantUniveralAccess: true})
  // cached per (tabId, sessionId, frameId, loaderId); invalidated on Page.frameNavigated and on
  // "Cannot find context" errors (one transparent retry).
export async function inWorld(tabId, expression, { sessionId, awaitPromise = true, returnByValue = true, frameId,
                                                  idempotent = true, userGesture = false, timeoutMs } = {}): Promise<any>
  // returnByValue:false → the RemoteObject { objectId, type, subtype }; the caller releases it.
  // idempotent:false disables the transparent retry on "context destroyed".
export async function callInWorld(tabId, backendNodeId, fnDecl, args = [], sessionId = null,
                                  { returnByValue, awaitPromise, userGesture } = {}): Promise<any>
  // DOM.resolveNode({backendNodeId, executionContextId: contextFor(...)}) + Runtime.callFunctionOn;
  // sessionId null → resolved through refs.sessionForNode, like cdp.callOnNode
export function invalidate(tabId, sessionId = null): void
// additive: verifiedContextFor(tabId, { sessionId, frameId }) (an id the world guard proved, for
// Runtime.addBinding by id), callOnObject(tabId, objectId, fnDecl, args, sessionId) (a function on a guarded
// remote object G9BrowserAgent holds), framesOf(tabId, { sessionId, limit = 30 }), guardExpression, guardFunction
```

* The input witness, the recorder's injected script and binding, snapshot text extraction, `qa.js`
  page helpers, handoff storage reads, and every *internal* evaluation move into the world. The
  recorder uses `Page.addScriptToEvaluateOnNewDocument({source, worldName: WORLD})` and
  `Runtime.addBinding({name, executionContextName: WORLD})`.
* `browser_console action:"evaluate"` stays in the **main** world — the agent is asking about the
  page's own JavaScript. Its description says so.
* Acceptance: after any tool ran, `Object.getOwnPropertyNames(window)` in the main world contains no
  name starting with `__g9` and no binding name.

```ts
// pointer.js — per-tab pointer state and the cursor track (the cursor is never drawn in the page)
export async function position(tabId): Promise<{ x, y } | null>        // persisted in platform.storage.session 'pointer:<tabId>'
export async function setPosition(tabId, x, y): Promise<void>
export function record(tabId, sample: { at, x, y, buttons, type }): void // in-memory ring buffer (10 000 samples/tab)
export function trackSince(tabId, sinceMs): Array<sample>
export function subscribe(fn: (tabId, sample) => void): () => void      // watch streams
// additive: sampleAt(tabId, atMs), forget(tabId)
```

```ts
// screencast.js — one Page.startScreencast per tab, shared by the video recorder and live watchers
export async function start(tabId, consumerId, { format='jpeg', quality=60, maxWidth=1280, maxHeight=800, everyNthFrame=1,
                                                backpressure=false } = {}): Promise<void>
  // backpressure:true (the issue video): that consumer's frame is acked only when its handler's promise settles
  // (5 s cap), so a frame is written BEFORE its ack; every other consumer is acked before fan-out.
export async function stop(tabId, consumerId, { sendStop = true } = {}): Promise<void>   // stops the screencast when the last consumer leaves
export async function onFrame(tabId, params): Promise<void>             // called by events.js for Page.screencastFrame; acks, fans out
export function subscribe(tabId, consumerId, fn: (frame: { data, metadata, at }) => void): void
export function consumers(tabId): string[]
// additive: adopt, onRevive, forget, status, effectiveParams, DEFAULTS; issues.ingestFrame is an alias of onFrame
// (as built)
export function watchdog(tabId, { onStatus, idleMs = 2000, everyMs = 1000 }): () => void   // → stop()
  // Is a live view really live? Calls onStatus on every CHANGE with { state:'hidden', visibility, reason,
  // lastFrameAt, at } (the page is hidden: the picture is the last one it drew), { state:'idle', … } (visible,
  // no frame for idleMs — normal for a static page) or { state:'live', at }. After 'hidden', 'live' needs the
  // page to say it is visible (a hidden page still hands over a stray frame). The daemon forwards it to
  // watching UIs as the topic `watchStatus`.
export function lastFrameAt(tabId): number | null
```

`issues.js` video becomes a screencast consumer; each stored frame record carries
`pointer: {x, y, buttons}` sampled at frame time, and `stopVideo` stores the full track as an
attachment `pointer-track.json` so every viewer can draw the cursor.

```ts
// humanize.js (extension/lib) — the dispatcher that turns plans into Input.dispatch* calls
export async function perform(tabId, plan, { sessionId = null, signal, origin = null, track = true } = {}):
  Promise<{ dispatched, merged?, lateMs?, durationMs, end: {x,y} | null }>
  // Steps go out at their `at` (absolute schedule). F3: returns only at plan.durationMs — a trailing pause
  // (planGap, a dwell, a key's hold) is waited, in slices, with Stop checked between them (a halt throws an
  // Error with .halted). F2: a key step's `location` (1 left, 2 right) is passed to Input.dispatchKeyEvent.
  // origin = the frame's top-left, for the cursor track of events sent to a child session; track:false skips it.
  // (as built) When the dispatcher falls behind: an interval that ends in a DECISIVE step (press, release,
  // key, wheel notch) keeps at least 80 % of its planned length (a press hold never collapses); an overdue
  // mouseMoved followed by another overdue one is skipped (`merged`); `lateMs` = the most a decisive step
  // started behind plan. Every event with a button held carries `force: MOUSE_PRESSURE` (0.5, a real mouse's
  // pressure) at every level. A page that becomes hidden mid-plan throws `delivery:'partial'` with `sent`,
  // `of`, `pressed` (or `not-delivered` when nothing was sent).
export async function levelFor(tabId, args): Promise<{ level: 'off'|'human'|'stealth', profile, seed, name,
                                                      raisedFrom?, stealthLevel? }>
  // Decision D-b: level = the STRICTER of the requested level (args.humanize, else humanizeFor(tabId)) and
  // platform.settings.stealthFor(tabId), order off < human < stealth. A raised built-in level becomes the
  // built-in profile of the effective level; a calibrated profile keeps its numbers and takes the level.
  // raisedFrom/stealthLevel say when that happened; interact.js and replay.js put them in `humanize`.
  // state is read first, so the extension's sync inputMode cache is current for the default AND the floor.
// additive: nextSeed(tabId), saveProfile(name, profile), loadProfile(name) — calibrated profiles live in
// platform.storage.local under 'humanize:profile:<name>' — LEVELS, WHEEL_TIMEOUT_MS
// (as built): SLOW_INPUT_MS, MOUSE_PRESSURE (0.5), HIDDEN_REMEDY, hiddenInputMessage(action, state,
// { dispatched }), hiddenInputError(action, state, opts) (delivery 'not-delivered', hidden: true),
// visibilityOf(tabId, sessionId) (document.visibilityState read in world g9)
```

* Input levels, as every interaction reads them from `levelFor`: `off` = v1's direct dispatch; `human` =
  humanized paths and timing; `stealth` = human minus every shortcut a page can see — no `DOM.focus` (focus
  is earned by a click), no programmatic scroll fallback (fail and say why), no `Input.insertText` unless
  `fast:true`. `select` at stealth: focus by a humanized click, Escape to close the native popup, then
  keyboard selection.
* ***(as built)*** **A hidden page gets no input.** Before dispatching, an input action reads
  `document.visibilityState` in world `g9`; on a hidden page (a background tab, a minimized or covered window)
  every input action — pointer, wheel AND keys — is refused as `not-delivered` with `hidden:true` and
  nothing is sent. Measured: pointer and wheel events never reach a hidden page; key events do, so refusing
  keys is G9BrowserAgent's policy (nobody can see what they would do). The message names the agent's remedies
  (`browser_tabs` `focus`, `popout`, `handoff`).
* **Delivery (the witness).** A dispatching action arms a trusted-events-only listener in world `g9` first;
  the verdict is timed from the END of dispatch (grace `WITNESS_TIMEOUT_MS`, 1.5 s; in-page safety ceiling
  max(10 min, 2 × expected + 5 s)), and the witness promise carries `extend(ms)`. Results carry `delivery: 'delivered'|'indeterminate'` (+`deliveryNote`); `'not-delivered'` is
  thrown (Error with `.delivery='not-delivered'`), never returned as success — as are `'missed'` (it reached another
  element, `.hit` names it) and `'partial'` (the tab became hidden part-way; `.sent`/`.of` count the input events).
  `runTool` puts the state at the start of the message (`[delivery: missed; hit <div#x>] …`), because every relay
  keeps only the text; the daemon protocol also carries it as fields (DAEMON_PROTOCOL §3). Pointer actions also return
  `pointer {x,y}`; humanized ones `humanize {level, profile, seed, raisedFrom?, stealthLevel?}`.
* Explicit `x`/`y` for a humanized pointer must be inside the viewport; outside it the action is refused in
  the tool's terms (scroll first, or act by ref) before anything is dispatched. `off` keeps v1's behaviour.

---

## 6. Human input library — `extension/humanize/`

Pure functions. No I/O, no timers, no globals. Deterministic for a given seed.

```ts
// extension/humanize/index.js re-exports all of:
createRng(seed: number|string): Rng          // mulberry32; rng() → [0,1); rng.int(a,b); rng.range(a,b); rng.normal(mu,sigma); rng.logNormal(median,sigma); rng.pick(arr); rng.chance(p)
PROFILES: { off, human, stealth }           // loaded from ./profiles/*.json via static import-free objects (JSON inlined in profiles.js)
resolveProfile(nameOrObject, overrides?): Profile   // validates; unknown name throws
validateProfile(obj): string[]              // problems, [] when valid

planMove(rng, profile, { from:{x,y}, to:{x,y}, targetSize:{w,h}, buttons=0, modifiers=0, viewport? }): Plan
pickTargetPoint(rng, profile, box:{x,y,width,height}, viewport:{width,height}): {x,y}
planClick(rng, profile, { from, box, viewport, button='left', clickCount=1, modifiers=0 }): Plan
planHover(rng, profile, { from, box, viewport }): Plan
planDrag(rng, profile, { from, fromBox, toBox, viewport }): Plan
planScroll(rng, profile, { at:{x,y}, deltaY, deltaX=0, viewport, modifiers?, overshoot?, room?, snap? }): Plan  // wheel notches, bursts, drift
planType(rng, profile, { text, field: { password:boolean, numericMask:boolean }, typos?:boolean, from?, delayMs? }): Plan
planKeyPress(rng, profile, { key, modifiers=[], repeat?, from? }): Plan      // key may be a chord string ("Control+s");
                                                                           // modifiers a list or a CDP mask; unknown key → TypeError
planGap(rng, profile, { after: 'action'|'navigation'|'formKey' }): Plan   // one pause step (think time)
keyDefinition(char|keyName): { key, code, keyCode, text?, shift:boolean }   // US QWERTY; moved here from interact.js
fitProfile(rawEvents: RecorderRawEvent[], base='human', { name }?): { profile, samples, report }   // calibration §6.7
resolveProfile(nameOrObject, overrides?, library?): Profile   // library = name → stored profile
validateProfile(obj): string[]                                // also: level and direct must agree (off is the one direct level)

// Plan = { steps: Step[], durationMs, end:{x,y} | null, meta:{ kind, seed?, profile:name } }
//        end is null (or the `from` passed in) for keyboard plans and planGap: they never move the pointer.
// Step = { at /*ms from plan start*/, kind:'mouse', type:'mouseMoved'|'mousePressed'|'mouseReleased'|'mouseWheel',
//          x, y, button, buttons, clickCount, modifiers, deltaX?, deltaY? }
//      | { at, kind:'key', type:'rawKeyDown'|'keyDown'|'keyUp'|'char', key, code?, windowsVirtualKeyCode?,
//          nativeVirtualKeyCode?, text?, unmodifiedText?, modifiers, autoRepeat:false, location? }
//          code/virtual key codes are omitted when unknown (non-ASCII, shifted symbols at off);
//          location (1 left, 2 right) on modifier keys — a real Input.dispatchKeyEvent parameter.
//      | { at, kind:'pause', ms, reason }
// viewport may carry dpr (aliases devicePixelRatio, deviceScaleFactor): coordinates then snap to 1/dpr.
// Human/stealth planners throw a RangeError for a target, drop point or wheel position outside the viewport.
// Chords: command chords are rawKeyDown without text; Shift alone gives keyDown WITH the shifted text.
// RecorderRawEvent: v1 raw events, the v2 recorder's input-samples shape (tools/record.js) and generic
// pointer/key/wheel events are all read.
// additive exports: effectiveText, validatePlan, sequence, initialPointer, fittsDuration, minimumJerk,
// physicalKey, modifierMask, modifierList, MODIFIERS (as built), parseKeySpec, isKnownKey, directDefinition, KEY_TEXT_CAP,
// QWERTY_NEIGHBOURS, MIN_SAMPLES, PROFILE_SCHEMA, LEVELS, notchesFor, hashSeed, BUTTONS, buttonName, shiftedOf
```

Profile values are the defaults of [HUMANIZE.md](HUMANIZE.md), stored in `extension/humanize/profiles.js`
(`off` = single-event plans that reproduce v1's direct dispatch exactly — including v1's 12 ms
per-character typing delay, `keyboard.directDelayMs`, and its 12-move drag; `delayMs:0` for none).

---

## 7. Engine 2 — `engine/`

```ts
// engine/find.js
findBrowsers({ home, env, includeRegistry = true } = {}): Promise<Array<{ kind: 'edge'|'chrome'|'cft', path, version,
                                                                      channel, source, versionSource }>>
resolveBrowser(kind = 'auto', { home, env } = {}): Promise<{ kind, path, version, channel, source }>
                                         // auto: pinned CfT if installed, else Edge, else Chrome; kind may also be
                                         // a path or { path, kind?, version? }
g9Home(env = process.env): string        // G9_HOME, else %LOCALAPPDATA%\G9BrowserAgent (or <home>\AppData\Local\G9BrowserAgent), else ~/.g9browseragent —
                                         // daemon/paths.js resolveHome and desktop/lib/paths.mjs follow the same rule
// additive: realPathOf, manifestVersion; appPathsFromRegistry is async. findBrowsers, resolveBrowser and kindFromPath
// also take { home } (as built: the other functions take env or a path, not home).
// (as built) also KINDS, systemBinary, peVersion, compareVersions, versionDirs, exeVersionInfo, exeVersion,
// candidatePaths, kindFromPath, defaultUserDataDirs, isDefaultUserDataDir (a launch on a browser's default
// user-data dir, or inside one, is refused)

// engine/cft.js
pinned({ platform = 'win64' } = {}): { version, platform, sha256?: string, size, url, revision, channel, pinnedAt }   // from engine/versions.json
installed({ home, platform } = {}): Promise<Array<{ version, path }>>
ensure({ version = pinned().version, onProgress, trigger } = {}): Promise<{ version, path, … }>   // download, verify, extract (tar -xf, JS fallback), log
appendVersionLog({ home, event, kind, version, sha256?, trigger?, ...key=value }): Promise<void>
  // the ONE line format of G9_HOME/engine-versions.log: "ISO<TAB>event<TAB>kind version<TAB>key=value…";
  // EngineManager logs its launches through it (event 'launch', engineId, path, daemon, headless, stealth)
// additive: status({ checkLatest }), acquireLock, LOCK_TIMING, crc32, crc32Js; (as built) also pin, uninstall,
// latestStable, downloadUrl, download (ranged resume; the other address family is retried on HTTP 403),
// hashFile, systemTar, listZip, extractZip, extractZipJs, cachedZipPath, ENDPOINTS. versions.json is richer than
// the design's sketch: { 'chrome-for-testing': { channel, version, revision, pinnedAt, trust, source,
// downloads: { win64: { url, size, sha256, serverMd5 } } } }

// engine/pipe-cdp.js
class PipeCdp extends EventEmitter implements CdpConnection {
  constructor(writeStream, readStream, { name = 'browser', child = null, defaultTimeoutMs = 20000, maxMessageBytes } = {}) }
// additive: MAX_TIMER_MS, EXIT_DRAIN_MS; waitForEvent(method, { sessionId, predicate, timeoutMs })
// (as built) DEFAULT_TIMEOUT_MS (20 s), SLOW_COMMANDS, NAVIGATION_COMMANDS, timeoutFor, MAX_MESSAGE_BYTES (256 MiB),
// CdpProtocolError; the default export is PipeCdp

// engine/launch.js
launchBrowser({ browser='auto', headless=true, profileDir, windowSize={width:1920,height:1080}, proxy, proxyBypass, lang,
                extraArgs=[], stealth='off', startUrl='about:blank', timeoutMs=30000, env, home, name,
                componentUpdate=null /* (as built) null = only at stealth; profile.warm passes true */ }):
  Promise<{ pid, conn: PipeCdp, argv, args, browser:{ kind, path, version, fileVersion, product, userAgent,
            protocolVersion, revision, jsVersion, channel }, profileDir, tempProfile, headless, stealth, windowSize,
            startedAt, warnings, exited, hasExited(), stderrTail(), child,
            close({ timeoutMs = GRACEFUL_EXIT_MS /* 30000 */, removeTempProfile = true }?):
              Promise<{ exit, killed, leftovers, profileRemoved, gracefulMs, closeMs }> }>
      // (as built, 2.0.2) timeoutMs is how long Browser.close may take before the tree is killed (measured: 0.4–0.5 s
      // idle, up to 17.9 s under load); exit is { code, signal }, or { code:null, signal:null, gone:true } when the
      // process is gone before its exit event arrived — never null once it is gone
buildArgs({ profileDir, headless, windowSize, proxy, proxyBypass, lang, extraArgs, stealth, startUrl,
            kind /* (as built) browser kind, for KIND_SWITCHES */, componentUpdate }): string[]
      // pure. Order (as built): --remote-debugging-pipe, --user-data-dir, --headless=new (headless), then
      // headless: --window-size=W,H−48 and --screen-info={WxH workAreaBottom=48} (headlessGeometry; an explicit
      // --screen-info in extraArgs wins and the window is then exactly windowSize) / headed: --window-size=W,H;
      // then the fixed switches (fixedSwitchesFor), KIND_SWITCHES[kind], ONE merged --disable-features
      // (DISABLED_FEATURES + extraArgs), --enable-features, --disable-blink-features (launchArgsFor(stealth) +
      // extraArgs), --enable-blink-features, --lang, --proxy-server/--proxy-bypass-list, the other extraArgs,
      // then startUrl. A fixed switch passed again is dropped; a feature both enabled and disabled is refused.
screenInfoSwitch({ width, height }, { workAreaBottom = 0 } = {}): '--screen-info={WxH}' | '--screen-info={WxH workAreaBottom=N}'
// (3.2) The manager prepends launchArgsFromEnv() — G9_LAUNCH_ARGS as a JSON array or a space-separated
// list, only entries starting with "--" — to every launch's extraArgs; the refusals below still apply.
// Refused in extraArgs, case-insensitively: --enable-automation (always), --remote-debugging-port/-address/-pipe/
// -io-pipes, and the switches owned by an option (--user-data-dir, --headless, --window-size, --lang, --proxy-server,
// --proxy-bypass-list — as built, other --proxy-* switches such as --proxy-pac-url pass through);
// --disable-blink-features naming AutomationControlled at off/human (decision D-a: accepted, and merged, at stealth).
// additive: commandLineUsesProfile, findProfileProcesses, killTree, normalizeProxy, parseProduct; (as built, 2.0.2)
// GRACEFUL_EXIT_MS (30 000)
// (as built) DISABLED_FEATURES (designed list + 'msImplicitSignin'), FIXED_SWITCHES (designed list + '--disable-sync'),
// COMPONENT_UPDATE_SWITCH, fixedSwitchesFor({ componentUpdate }), DEFAULT_WINDOW (1920×1080),
// KIND_SWITCHES ({ cft: ['--disable-frame-rate-limit'] }), HEADLESS_TASKBAR (48 on Windows, else 0),
// headlessGeometry(size) → { screen, window, workAreaBottom }

// engine/profile.js
profilesDir(), list(), ensure(name, { home, locale?, timezone?, notes? }) → { name, dir, meta, created }, remove(name),
applyPreferences(name, prefs) (browser must be closed),
warm(name, url, { home, browser, windowSize, lang, extraArgs, signal, timeoutMs = 0, onLaunched, headless = false })
  → { name, dir, url, warmed, reason?, warmedAt, exit, browser, argv } (headed; headless only for tests; launched with
  componentUpdate:true so the profile fetches Widevine once, and — as built — at stealth 'stealth', so the sign-in
  window does not report navigator.webdriver)
// meta carries acceptLanguage (from intl.accept_languages); (as built) also locale/timezone: a profile is a PERSONA
// (a launch-time locale/timezone is saved and reused by later launches that give none)
// (as built) additive: DEFAULT_PROFILE ('automation'), validateName, profileDir, profileInUse, updateMeta,
// readPreferences, expandPrefs, deepMerge, signInState(name) → booleans only (is a browser account signed in?
// never the name or id), clearSessionRestore(name) (the previous session's tabs are not reopened)

// engine/stealth.js
LEVELS = ['off','human','stealth']
autoEnableDomains(level): string[]       // off/human: Page,Runtime,Log,Network,DOM,CSS ; stealth: Page,Log,Network,DOM,CSS (never Runtime)
WEBDRIVER_SWITCH = '--disable-blink-features=AutomationControlled'
launchArgsFor(level): string[]           // off/human: []; stealth: [WEBDRIVER_SWITCH] — decision D-a, the only switch any level adds
launchWarnings({ level, headless, kind }): string[]
  // off/human: "navigator.webdriver is true" (measured: the pipe sets it; only stealth clears it);
  // stealth + headless: the HeadlessChrome user agent and userAgentData, an outer size that can read 0×0 at the
  // load event, a software GL string only on machines without a GPU; (as built) stealth on kind 'cft': a public
  // detector flags its brand, and its renderer ran at 10 Hz (launch.js adds --disable-frame-rate-limit for it).
  // (The headless screen is fixed by launch.js.)
checkConsistency({ locale, timezone, acceptLanguage, hostTimezone? }): string[]   // problems
// (as built) additive: normalizeLevel(level), forbiddenDomains(level) (stealth: ['Runtime']), isDomainAllowed(level, domain),
// parseAcceptLanguage(header)

// engine/manager.js — owned by the daemon; wraps platform-cdp and the shared tool runtime
class EngineManager {
  constructor({ home, registry, log, emit, settings?, evidence?, storage?, version?, fileInfo? })
  launch(opts): Promise<EngineInfo>        // opts as launchBrowser + { name?, profile='automation', humanize, stealth, locale, timezone,
                                           //   reuse? } — reuse:true waits for an in-flight launch of the same profile
  stop(engineId): Promise<void>
  list(): EngineInfo[]
  createContext(engineId, { proxy, proxyBypass, locale, timezone, humanize, stealth, downloadPath }): Promise<ContextInfo>
  openTab(engineId, contextId|null, url): Promise<{ tabId, engineId, contextId, url }>
  runTool(tool, args, caller): Promise<any>          // extension/tools/index.js runTool with platform-cdp
  owns(tabId): boolean
  handoffImport(payload, { engineId?, contextId?, launch = true, includeStorage = true, matchViewport = false, caller? }):
    Promise<{ tabId, engineId, contextId, url, title, transferred, notTransferred, storageCheck?, cookiesNotSet?,
              navigationError?, warnings? }>
  shutdown(): Promise<void>
  // additive: init, available, unavailableReason, isReadOnlyFn/isReadOnly, engineOfTab, currentTab, listTabs, versions,
  // profiles, warm, watch, setHalted, getRecording, saveRecording, saveHumanizeProfile, reconfigure
  // (as built) isControllable(tabId) (false for browser-internal pages such as edge://downloads-hub/, which are
  // never a default tab), holdsSlot(tool, args) (tools/index.js holdsSlot: the maxParallel gate)
  // (as built, 2.0.2) watch(tabId, on, consumerId, { onFrame, onPointer, onStatus, runId }?): Promise — the changes
  // for one (tabId, consumerId) run one at a time, in the order asked, so the last request wins for the whole watch
  // (map, pointer subscription, watchdog, screencast); a start that fails undoes itself and rejects
}
// Its tool-runtime hook connection({ tabId }) names the engine of the tab a status is about (F4).
// openTab/createContext create pages through platform-cdp createTab (F1) — no newWindow workaround of their own.
// EngineInfo = { engineId, kind:'launched', browser, version, headless, profile, pid, argv, contexts:[ContextInfo], tabs:number[] , startedAt }
//   (as built) also: name, browserPath, profileDir, stealth, humanize, locale, timezone, acceptLanguage?, warnings?,
//   window? (a headed window fitted to its screen's work area)
// ContextInfo = { contextId, engineId, humanize, stealth, locale, timezone, proxy, downloadPath }
//   (as built) also isDefault and environmentStealth (the ENGINE's launch level: a context's stealth cannot add the
//   launch switch); createContext returns it with warnings?
// (as built) Launch behaviour: one launch per profile at a time (a second is refused, or joins it with reuse:true);
// a profile signed in to a browser account is refused at stealth "stealth" and warned about otherwise; a
// locale's languages are written into the profile (intl.accept_languages/selected_languages) so navigator.languages
// and Accept-Language agree with Intl; Edge's downloads-hub popup preference is turned off; the previous session's
// tabs are cleared; a headed launch without windowSize is fitted to its screen's work area (position untouched).
// A context whose locale is in another LANGUAGE than the profile's is refused at stealth and warned about
// otherwise (only Intl could follow it). Mutating calls hold one of settings.maxParallel slots (default 8),
// except the waits (holdsSlot).
```

***(as built)*** Launch switches are the designed list ([engine/README.md](../engine/README.md)) with the changes of §0: `msImplicitSignin` added to
`--disable-features`, `--disable-sync` added, `--disable-component-update` omitted at stealth `stealth` and
when warming, `--disable-frame-rate-limit` for CfT only, the headless geometry (`--window-size` = the work
area, `--screen-info={W×H workAreaBottom=48}`), and `stealth.launchArgsFor(level)` (decision D-a).
Every launch writes `G9_HOME/engines/log/<engineId>.json`
(argv, versions, timestamps) and appends a `launch` line to `G9_HOME/engine-versions.log` through
`cft.appendVersionLog`.

---

## 8. Daemon — `daemon/`, protocol — see [DAEMON_PROTOCOL.md](DAEMON_PROTOCOL.md)

Files: `daemon/g9d.mjs` (entry), `daemon/ws-server.js` (moved from bridge, origin rule §0),
`daemon/registry.js` (agents, engines, tab handles, ownership, sessions, per-tab queues, halts),
`daemon/router.js` (tool routing), `daemon/handoff.js`, `daemon/storage.js` (file-backed
`StorageArea` and `blobs` for platform-cdp), `daemon/evidence.js` (runs dir, frame/pointer spool,
downloads verification), `daemon/scheduler.js`, `daemon/project.js` + `daemon/flows.js` (moved from
bridge), `daemon/settings.js`, `daemon/extension-update.js`.

***(3.2)*** `daemon/flows.js` `FlowLibrary`: `list({site})` (rows add `startUrl`, `approvedAt`, `approvedBy`,
`baselines`), `status(local, {site})` (adds `approvalNewerInRepo`, `approvalNewerHere`), `writeApproved(flowId,
doc, images)`, `readApproved(flowId)`; `remove` takes the sidecar with the flow; the walk skips
`*.approved.json` and `*.baselines/`; `siteMatches(startUrl, site)` exported. `Daemon`: one library per known
project (`#libraryRows`: its own and each connected agent's `g9.project.json`; the flowlib `project` path must
be one of them), `writeApprovedAnywhere(flowId, approved, images)`, `requestWatch({handle, caller, on, focus})`,
`watchables()`, the `viewer` role (`#viewerMessage`). `engine/manager.js`: `approvedBundle(id)` and the
`onApproved` hook (the launched store's approvals go to the repository through the daemon).
`registry.js` knows the role `viewer`. `router.js`: `browser_tabs action:"watch"` → `onWatchRequest`;
an `import_spec` that took a later approval from the sidecar (`result.knownWorld === 'repo'`) does not get the
old known world restored.

Summary of the protocol (full text in DAEMON_PROTOCOL.md):

* `ws://127.0.0.1:PORT/g9` (also `/agent` for v1 extensions, which then get a clear version error).
  `GET /health` → `{ ok:true, name:'g9d', version, pid, port, home, engines, agents, extension, launched,
  activeRuns:[{runId, kind, label, startedAt}], startedAt, uptimeMs }` (F6: `launched` and `activeRuns` let
  the desktop judge a daemon it is not connected to before an update).
* First frame from a client: `{type:'hello', role:'agent'|'engine'|'ui', version, client:{name, pid, …}}`.
  An extension's `client` also carries `browser`, `extensionId` and (decision D-c) `instanceId` (random,
  generated once, storage.local), `loadId` (storage.session: the same across worker restarts, new after an
  extension reload or browser restart) and `tabs:[{tabId, url}]`.
  Reply `{type:'welcome', version, daemonPid, id /*agentId|engineId|uiId*/, repoRoot, project, halted, port, home}`.
* **Engine identity (D-c).** An extension engine with an `instanceId` that disconnects is PARKED for
  `G9_ENGINE_RESUME_MS` (default 10 min): its handles, claims, session names and agents' current tabs stay.
  The same `instanceId` saying hello again gets the same engine id back; a handle survives when its Chrome
  tab still exists and — unless `loadId` is unchanged (a worker restart) — still shows the page last seen
  there (a browser restart numbers tabs anew). A hello that races the old socket's close supersedes it.
  Calls on a parked tab fail with "reconnecting"; `browser_tabs list` shows those tabs `reconnecting:true`.
* Calls: `{type:'call', id, tool, args}` → `{type:'result', id, ok, result|error}` (agents and UI).
  Daemon → engine(extension): `{type:'call', id, tool, args, caller:{agentId, name, relayed:true}}`
  (F7: `relayed` — the engine's activity record of that call is not forwarded to UIs).
* Events: engine → daemon `{type:'event', event, data}` (`dialog`, `halt`, `tabs`, `activity`, `download`,
  `frame`, `pointer`, ***(as built)*** `watchStatus`); daemon → UI `{type:'event', topic, data}` (`activity`,
  `agents`, `engines`, `tabs`, `frame`, `pointer`, ***(as built)*** `watchStatus`, `run`, `halt`, `schedule`).
* Extension requests: `{type:'request', id, op:'handoff'|'info'|'flowlib', …}` → `{type:'response', id, ok, …}`;
  flow library `{type:'flowlib', id, op, flowId?, …}` → `{type:'flowlibResult', id, ok, …}` — F5: `id` is only
  the sender's correlation id; the flow an op is about is `flowId` (a v1 message without it named the flow in `id`).
* Admin (UI only): `{type:'admin', id, op, ...}` ops `halt`, `resume`, `haltAgent`, `resumeAgent`,
  `watch`, `unwatch`, `settings.get`, `settings.set`, `extension.install`, `extension.reload`,
  `schedule.list|add|remove|runNow`, `runs.list {limit?, active?}` (F6: `active:true` = every open run,
  however old), `runs.get`, `engines.versions|installCft`, `profiles.list|warm`, `state` (with `activeRuns`),
  `shutdown`. ***(as built, 2.0.2)*** `watch` answers `{watching:true, tabId, runId}`, or `{watching:false, tabId,
  problem}` when a launched engine's stream did not start, or `{watching:false, tabId}` when an unwatch overtook
  the start; the watcher and its run are undone first (DAEMON_PROTOCOL §6).
* Daemon → extension: `{type:'halt', halted}`, `{type:'reload'}`, `{type:'agents', agents}`, `{type:'watch', tabId, on}`
  (re-sent for watched tabs when a parked extension comes back), ***(as built)*** `{type:'cancel', id}` (stop a
  relayed call: its deadline, a dialog on its tab, or the user stopping that agent), ***(v3)*** `{type:'projects',
  domains, projects}` (the connected agents' project sites; the `agents` rows also carry `project`, `cwd`,
  `current`, `currentEngine` — DAEMON_PROTOCOL §5). The extension also sends the
  event `reloadDeferred` `{reasons}` when a `reload` has to wait (an agent call, a panel operation, a recording,
  an issue video or a replay still running).
  `/health` and the welcome also carry `bootId` (the welcome `startedAt` too) — DAEMON_PROTOCOL §2.
* `browser_status` (F4): the daemon passes the tab the status is about (the asked `tabId`/`session`, else
  the caller's current tab) to the engine as `tabId`, so `current` and `health` are that tab's; a guard
  withholds the health figures (with `healthNote`) only if an engine ignored `tabId` and reported another tab.

Tab handles: daemon-wide integers. Engine 2 tabs use them natively (`allocTabId`). Engine 1 tabs are
mapped `(engineId, chromeTabId) ↔ handle`; the router rewrites every numeric `tabId`/`openerTabId`
and every `tabIds[]` in **arguments going to** and **results coming from** the extension.

Ownership: first mutating call on an unowned tab claims it; a mutating call on another agent's tab
fails with the owner's name; reads (`isReadOnly`) are always allowed; claims are released when the
agent disconnects; `browser_tabs claim force:true` takes over and logs it. Mutating calls are
serialized per tab.

***(as built, 2026-09-22)*** Liveness, the halt and ownership are re-checked at the moment a queued
call's TURN comes (and again when a launched-engine call gets its maxParallel slot): a call queued
behind a long one no longer runs after its agent disconnected or after another agent took the tab
over. A call that reaches its deadline is cancelled — its input stops between steps — and the tab's
queue is held until it stops, up to 5 s; if it does not, the answer says it may still be running.
A launched engine can be HELD across tabs (`browser_engine acquire`/`release`, or `lease:true` on a
launch): the daemon stops an engine launched with `stopWhenReleased` once the last holder releases it
and no agent owns a tab there, so two overlapping runs on one profile cannot stop each other's browser.

Halt: global (desktop Stop, or the extension panel Stop which the extension reports) and per agent.
While halted every tool except `browser_status` fails with the reason. Only the UI (or the panel)
resumes the global halt; an agent cannot resume any halt.

---

## 9. `G9_HOME` layout

```
G9_HOME/
  daemon.json               { pid, port, version, startedAt, home }   (written while running)
  daemon.lock               { pid, port }  one daemon per G9_HOME (as built, 2026-09-22)
  settings.json             daemon/settings.js DEFAULTS: port 8765, defaultBrowser 'auto', headless true,
                            humanize 'human', stealth 'off', maxParallel 8, evidence { maxFrames 3000,
                            maxBytes 300 MiB, keepRuns 200, quality 60, maxWidth 1280, maxHeight 800 },
                            idleExitMinutes 60, updateMode 'official', updateUrl '', updateChannel 'stable',
                            schedule [] (3.1.0: updateMode 'official'|'custom'|'off', 'custom' needs updateUrl;
                            a file with updateUrl and no updateMode loads as 'custom'. F6: updateChannel
                            'stable'|'beta'; updateUrl https:// (http:// only on localhost, 127.0.0.1 or ::1) or
                            empty — a file:// feed is refused: electron-updater cannot use it). Unknown keys
                            are kept.
  desktop.json              the desktop app's own state (window, wizard, the update source it updates from)
  bin/g9-run.mjs            (3.1.0, Linux AppImage only) the stable bootstrap lib/runtime.mjs writes: MCP
                            entries, the daemon and scheduled runs start `$APPIMAGE bin/g9-run.mjs <script>`
  engine-versions.log
  engines/cft-<version>/    Chrome for Testing
  engines/log/<engineId>.json
  engines/firewall-seen.json  CfT executable paths already warned about (engine/firewall.js)
  profiles/<name>/          browser user-data-dir      profiles/<name>.json  metadata
  store/kv-local.json       platform-cdp storage.local (recordings, issues index)
  store/blobs/<store>/<id>.bin + <id>.json
  runs/<runId>/             engine.json, frames/<seq>.jpg, frames.jsonl, pointer.jsonl, downloads.jsonl, result.json
                            (runId = YYYYMMDD-HHMMSS-<kind>-<hex>; the downloaded files stay in downloads/;
                            the newest evidence.keepRuns are kept, an active run never pruned; prune passes
                            run one at a time — as built, 2.0.2)
  downloads/<contextId>/    one folder per launched browser context
  extension/                desktop-managed unpacked extension (stable path → stable extension id)
  logs/daemon.log (rotated at 5 MB), logs/install.log, logs/desktop.log, logs/policies.json (the desktop's record
                            for policy Undo)
```

---

## 10. MCP shim — `mcp/`

`mcp/shim.mjs` (stdio MCP server; `mcp/mcp.js` moved from bridge; `mcp/tools.js` = v2 schemas and
`INSTRUCTIONS`). On start: connect `ws://127.0.0.1:${G9_PORT||8765}/g9`; on `ECONNREFUSED` spawn
`daemon/g9d.mjs` detached (`windowsHide:true`, same `G9_PORT`/`G9_HOME`) and retry for 8 s; if the port
answers `/health` with a non-g9d body (a v1 bridge), every tool fails with a message naming the pid and
the fix. Tool calls are forwarded verbatim; the shim adds nothing but `caller.name` from the MCP
`clientInfo`. `resources`: `g9://guide`, `g9://status`. The shim speaks WebSocket through the
zero-dependency `lib/ws-client.mjs`, not Node's global `WebSocket`: it also runs as `G9BrowserAgent.exe` with
`ELECTRON_RUN_AS_NODE` (whose Node is Electron's), and it must never send an `Origin` header.

***(3.2)*** The shim is split so a second front end shares it:

| Module | Exports | Contract |
|---|---|---|
| `mcp/link.mjs` | `DaemonLink`, `HOST`, `PORT`, `describePortHolder` | `new DaemonLink({ name='mcp-agent', cwd=process.cwd(), project=G9_PROJECT })`; `ensure()` connects (spawning the daemon as above), `call(tool, args)` → result or throws, `close(reason='shim exiting')` (the daemon logs the reason). The hello carries `client: { name, pid, cwd, project }`. |
| `mcp/server.mjs` | `createMcpServer(link, { transport='stdio' })` | an `McpServer` with the 15 tools and the two resources; `initialize` sets `link.name` from `clientInfo.name`; `browser_status` adds `shim: { version, pid, transport }` and a note when shim and daemon versions differ. |
| `mcp/mcp.js` | `McpServer.handle(msg)` | answers one parsed JSON-RPC message: the response object, or `null` for a notification; a non-object is `-32600`, a throw `-32603`. stdio's `#dispatch` and HTTP both use it. |
| `mcp/http.mjs` | `createGateway({ token, makeLink, idleMs=30 min, allowedOrigins=[], maxSessions=32, now })` → `{ handler, sessions, sweep, close }`; `main(env)`; `tokenMatches`, `isLoopback`, `MAX_BODY_BYTES` (64 MiB), `MAX_SESSIONS`, `MIN_TOKEN_LENGTH` (24) | MCP Streamable HTTP, JSON responses only (no server-initiated stream: GET 405). Order of refusals: path (`/healthz` → 200 "ok"; not `…/mcp` → 404), Origin not allowed → 403, bearer wrong → 401 + `WWW-Authenticate`, content type → 415, body → 413/parse error. `initialize` (alone or in a batch) creates a session: `Mcp-Session-Id` header, a `DaemonLink` of its own named after the client. Other requests need a live session id (none 400, unknown 404). DELETE ends one (204). Notifications only → 202. `main` listens on `G9_MCP_HTTP_HOST:G9_MCP_HTTP_PORT` (127.0.0.1:8931) and refuses a non-loopback host without a token of ≥ 24 characters (`G9_MCP_TOKEN`, or `G9_MCP_TOKEN_FILE`). |

---

## 11. Desktop — `desktop/`

Electron shell, never an engine (no `BrowserView`/`webview` of pages under test; the watch window
shows JPEG frames from the daemon on a `<canvas>` with the cursor drawn from pointer samples).
Talks to the daemon as role `ui` over the same WebSocket. Owns: packages (3.1.0: electron-builder NSIS
per-user on Windows, DMG + ZIP on macOS, AppImage + .deb on Linux), first-run wizard, MCP client
registration, HKCU policy apply/undo (Windows only), extension folder management + reload, update
check (electron-updater: `updateMode` 'official' → the `github` provider on the official repository,
'custom' → the `generic` provider on `updateUrl`, 'off' → none; install mode 'auto' on Windows and an
AppImage, 'manual' — check and notify, never download — on macOS and a .deb), scheduler
UI, runs/evidence/approvals views. An update restarts the daemon, so it waits until the daemon is idle:
connected, `runs.list {active:true}` + the engine list; not connected, `/health` `activeRuns` + `launched`
(F6) — an open `watch` run (the app's own live view) never blocks. The activity view shows each agent call
once (the daemon drops engines' `relayed` echoes, F7). Its tests live in `desktop/test` (`npm test` there);
`setup/unit/desktop.test.mjs` runs them from `setup/unittest.mjs`. Its per-call timeouts mirror
DAEMON_PROTOCOL §3 (`desktop/lib/daemon-client.mjs callTimeoutMs`); `setup/unit/daemon.test.mjs` checks that
they never end a call before the daemon's own deadline.
Packaged resources: `extension/`, `engine/`, `daemon/`, `mcp/`, `runner/`, `lib/`, `package.json`.
The app's executable (`G9BrowserAgent.exe`, `G9BrowserAgent.app/Contents/MacOS/G9BrowserAgent`, `g9browseragent`) with `ELECTRON_RUN_AS_NODE=1` runs
Node scripts (daemon, shim, runner) so a QA machine needs no Node; how a script is started — node, the
app, or a Linux AppImage through `G9_HOME/bin/g9-run.mjs` — is `lib/runtime.mjs scriptCommand`, shared by
the shim, the desktop launcher and the MCP registration.

---

## 12. File ownership for the parallel implementation

| Work package | Owns (creates or edits) | Must not edit |
|---|---|---|
| WP-core | `extension/lib/{platform,platform-extension,platform-cdp,cdp,state,store,frames,refs,visual}.js`, delete `extension/lib/workspace.js`, `extension/tools/{index,events,tabs,observe,inspect,emulate,netpin,netrules,diagnose,capture,navigate,downloads}.js`, `extension/sw.js`, `setup/unit/platform-cdp.test.mjs`, `setup/unit/seam.test.mjs` | panel, transport, interact/record/snapshot/qa/replay/issues |
| WP-humanize | `extension/humanize/**`, `setup/unit/humanize.test.mjs`, `docs/HUMANIZE.md` | everything else |
| WP-engine | `engine/**` except `engine/manager.js`, `setup/unit/engine.test.mjs` | everything else |
| WP-desktop | `desktop/**` | everything else |
| WP-panel | `extension/panel/**`, `extension/lib/transport.js`, `extension/manifest.json` | sw.js (uses the panel command list in §13) |
| WP-interaction | `extension/lib/{world,pointer,screencast,humanize}.js`, `extension/tools/{interact,record,snapshot,qa,replay,issues}.js`, `setup/unit/world.test.mjs` | core files |
| WP-daemon | `daemon/**`, `mcp/**`, `lib/**`, `package.json`, `bridge/**` (delete + forwarder), `runner/**`, `engine/manager.js`, `setup/selftest.mjs`, `setup/unit/daemon.test.mjs`, `docs/DAEMON_PROTOCOL.md` | extension files |
| WP-integration (later) | tests, live harnesses, docs, fixes across files after every package above has landed | — |

Downloads are part of WP-core (`platform.downloads` + `tools/downloads.js`); the daemon supplies the
`fileInfo` hook.

### 12.1 Unit-test convention

Each package adds its tests as `setup/unit/<area>.test.mjs`: a standalone Node script using
`node:assert/strict`, printing `  PASS <name>` per test (`  SKIP <name> — why` for one it cannot run),
exiting non-zero on the first failure, and never touching the network or port 8765. `setup/unittest.mjs`
runs every `setup/unit/*.test.mjs` in its own child process and summarises. A test that needs
`globalThis.chrome` stubs it itself **before** importing extension modules, in its own process.

Exceptions, deliberate: `engine.test.mjs` and `platform-cdp.test.mjs` have `live:` tests that launch the
installed Edge/Chrome/CfT **headless** on a temporary profile (the pipe, decision D-a and F1 are measured
facts and are checked where they live); `G9_UNIT_NO_BROWSER=1` skips them, and unittest.mjs passes it
through. `desktop.test.mjs` runs `node desktop/test/run.mjs` with `ELECTRON_RUN_AS_NODE` removed from the
environment, and SKIPs (exit 0) when `desktop/node_modules` is absent.

---

## 13. Extension panel ⇄ service worker commands (v2)

Kept: `getState`, `attachActive`, `attachTab`, `detach`, `setBridge` (now "daemon address"),
`reconnect`, `halt`, `resume`, `detachPanel`, `clearLog`, all `rec*`, `flow*`, `issue*`, `video*`,
`session*`, `listTabs`, `shutdown`.
Removed: `setMode`, `discoverBridges` (one daemon, one port).
Added:

| cmd | request | response |
|---|---|---|
| `setInputMode` | `{ mode: 'off'\|'human'\|'stealth' }` | `{ ok }` |
| `setAutoAttach` | ***(v3)*** `{ mode: 'off'\|'project'\|'all' }`; the v2 form `{ enabled: boolean }` still works (`true` → `'all'`, `false` → `'off'`) | `{ ok, mode }`; an unknown mode → `{ ok:false, error }`. Logs one line ("Auto-attach: Project sites"); with a mode other than `'off'` every open tab is judged again after the answer |
| `recordNow` | ***(v3)*** `{ tabId?, reload?: boolean }` — no `tabId`: the active tab, as `attachActive` | `{ ok, tabId, title, url, attachedSince, reloaded, reloadError?, resumed? }`. "Record from now": exactly `attachActive`/`attachTab` (`tools/tabs.js attachTab(tabId, {clearHalt:true})` — capture starts, the tab becomes current, Stop is lifted and the resume reported to the daemon as `{type:'event', event:'halt', data:{halted:false, by:'panel'}}`), then with `reload:true` `tools/navigate.js reload(tabId)` — `browser_navigate action:"reload"`'s own path, load wait and post-load idle included. ONE activity line (`kind:'attach'`, detail "Record from now[ — page reloaded to capture its load][; Stop lifted]"). A failed reload leaves capture on: `reloaded:false`, `reloadError`, the line `ok:false`. An internal page (`edge://…`) is refused as `attachTab` refuses it |
| `focusTab` | ***(v3)*** `{ tabId }` (Chrome id, required) | `{ ok, tabId, windowId }` — `tools/tabs.js focusTab`: the tab becomes the active tab of its window and the window is focused (an agent's tab chip in the Agents list). The person's own gesture: it works while Stop is on. A tab that does not exist → `{ ok:false, error }` |
| `popout` | `{ tabId? }` | `{ ok, tabId, windowId, focused, visible, title?, note }` — ***(as built, 2.0.3)*** the person's own button: `tools/tabs.js popout(tab, {focus:true})`, so the window comes up in front; it works while Stop is on. ***(v3)*** clears `blocked[tabId]` |
| `handoff` | `{ tabId? }` | `{ ok, result }` — asks the daemon (`{type:'request', op:'handoff', tabId}`). ***(v3)*** clears `blocked[tabId]` once it succeeded |
| `daemonInfo` | — | `{ ok, daemon: { version, port, agents:[…], engines:[…] } \| null }` |
| `about` | — | `{ ok, version, previousVersion, updatedAt, browser }` |
| `openWatch` | ***(3.2)*** `{ handle? }` — a daemon tab handle (an agent row's `currentHandle`); none: the picker | `{ ok, windowId, reused }` — opens `panel/watch.html` in a popup window, focused (the person's own press), or raises the one already open and adds that tab to it (`{type:'watchAdd', handle}` broadcast). The same window an agent's `browser_tabs action:"watch"` opens (`{type:'openWatch'}` from the daemon, unfocused and flashing in the taskbar) |
| `watchAddress` | ***(3.2)*** — | `{ ok, address: "host:port", version }` of the daemon this worker is connected to, or `{ ok:false, error }`: the watch page dials it itself as a `viewer` (DAEMON_PROTOCOL §7) |
| `flowProjects` | ***(3.2)*** — | `{ ok, default, projects:[{ name, path, root, flowsDir, own, agents, domains }] }` — every flow library the daemon can reach (flowlib `projects`). `flowStatus`/`flowPull`/`flowPush` take `{ project?, site? }` (a path from here; an origin or `'none'`); `flowPull` answers `{ imported, created, approvals, baselines, newerHere, problems }`, `flowPush` adds `approvals` |
| `recHistory` | ***(3.2)*** `{ ids? }` | `{ ok, recordings:[{ id, flowId, name, startUrl, suite, tags, qaTestCaseIds, environment, runHistory, flaky, steps:[{type}], knownWorld:{approvedAt, approvedBy} }] }` — the run-history report's data (`panel/report.js`) |

`getState().state` carries: `currentTabId`, `attachedTabs`, `sessions`, `inputMode`, `autoAttach`,
`halted`, `dialogOpen`, `dialogs` (`{[tabId]: {tabId,type,message,at}}` — every open dialog; `dialogOpen` is
the newest), `bridge` (renamed in the UI to "daemon": host, port, connected, lastError, daemonVersion,
engineId, daemonPid, connectedAt, problem), `activity`, `version`, `previousVersion`, `agents` (last list
pushed by the daemon), `updatedAt`, ***(as built)*** `project` (the project adapter from the daemon's welcome:
found, path, environments, defaultEnvironment, flowsDir, problems — not persisted). `getState()` also returns
`status` (tools/index.js `status()`).

***(v3)*** State fields added for the v3 panel (all in `storage.session` except `autoAttach`, a durable setting):

* `autoAttach`: `'off' | 'project' | 'all'` (was a boolean). Default `'project'` for an install that never
  stored the setting. A stored v2 boolean is read as `true` → `'all'`, `false` → `'off'` and rewritten once
  as the string by `migrateLegacySettings()` (logged), so an existing install keeps its choice
  (`lib/state.js autoAttachMode`, `AUTO_ATTACH_MODES`). `'all'` attaches every attachable tab (v2's `true`);
  `'project'` only tabs whose URL matches `projectDomains` (`lib/sites.js hostMatches`: the host or a
  subdomain of it, and the port when the domain names one), judged on startup, on creation, on every
  navigation and whenever `projectDomains` changes — and with no project domains, nothing. Auto-attach
  never detaches anything and is never an access boundary (D6/D7: a tab attached by hand or by an agent
  stays attached; every tab stays reachable). `status()` (so `browser_status`) keeps `autoAttach` a
  boolean — `true` for `'all'`, or `'project'` with project domains known — and adds `autoAttachMode`
  (the extension only; a launched engine attaches every tab it has).
* `projectDomains: string[]`, `projects: [{name, path, domains, agents}]`: the daemon's last
  `{type:'projects'}` (DAEMON_PROTOCOL §5), re-sent on every connect; kept across a disconnect, as `agents` is.
* `attachedSince: { [tabId]: epochMs }`: when the debugger session capturing that tab's console and
  network began (`lib/cdp.js attach`, only when a session really starts; a session found still attached
  after a worker restart keeps its time). Removed on detach (`detachMany`, `events.onDetach`) and on tab
  close (`events.onTabRemoved`), each inside the one serialized `updateState` step that already edits
  `attachedTabs`. Also on `status().current.attachedSince` (null when that tab is not captured) and in
  `recordNow`'s answer.
* `blocked: { [tabId]: { tabId, agent:{id, name}, reason:'hidden', at, title, url, tool, delivery } }`: an
  agent's input could not reach that tab because it is hidden. Set by `sw.js` when a call the daemon
  relayed (`caller.relayed`) fails with `hidden === true` (the `[delivery: not-delivered|partial; …; tab
  hidden]` errors of `lib/humanize.js`/`interact.js`) — unless the tab is by then the active tab of a
  focused window. Cleared when the tab closes, becomes the active tab of a focused, non-minimized window
  (`tabs.onActivated`, `windows.onFocusChanged`, the `focusTab` command), is popped out or handed off
  (panel commands, or an agent's relayed `browser_tabs` `popout`/`focus`/`handoff_export`), when a later
  relayed `browser_interact` on it succeeds, and when the daemon's `agents` push no longer lists its agent.

***(v3)*** Broadcasts to the panel (`platform.runtime.broadcast`, besides `state`/`activity`/`dialog`/
`detached`): `{ type:'agentBlocked', tabId, agent:{id, name}, reason:'hidden', at, title, url, tool,
delivery }` when `blocked[tabId]` is set, and `{ type:'agentUnblocked', tabId }` when it is cleared.

`recStatus` answers `{ ok, status, elsewhere:[{tabId, name, startedAt}], recordings }` — `elsewhere` = the
other tabs recording now (F8: the panel's Record button is disabled, with the reason shown, while the
current tab records, because `startRecording` refuses a tab that is already recording; "Stop and save" is
a separate button).

***(v3)*** `issueList` answers `{ ok, issues, usage }`; each `issues` row is the issue index entry
(`lib/store.js issueIndexEntry`): `{ id, title, url, site, status, severity, tags, filedAs, evidence:{
screenshots, videos, files, console, network, dom }, createdAt, updatedAt }` — `site` is the origin of the
page it was filed on (`lib/sites.js siteOf`, null for an opaque URL), `severity` defaults to `'normal'`,
`evidence` counts attachments by kind (`screenshot`, `video`, `file`) and says whether console errors,
failed requests (the captured context, or its `console.log`/`failed-requests.log` evidence files) and a DOM
fragment (`page-fragment.html`) are held. The entry is rewritten, as one serialized step from the stored
record, on every save and whenever an attachment is added to or removed from the issue. Entries written
before v3 lack `severity`: the first `listIssues()` that finds one rebuilds each such entry from its record
(attachment metadata, never the bytes) and rewrites the index once; an entry whose record is gone is kept,
with the defaults.

---

## 14. Extension transport API — `extension/lib/transport.js` (used by `sw.js`)

```ts
export const DEFAULT_PORT = 8765
export function onMessage(fn: (msg) => Promise<void>|void): void   // every daemon message except pong/welcome/response/flowlibResult
export async function connect({ force = false } = {}): Promise<void>
export function connectNow(): Promise<void>                          // reset backoff, connect immediately
export function disconnect(): Promise<void>                           // (as built) resolves when the state is written
export function send(payload): boolean
export function isConnected(): boolean
export function connectedAddress(): string|null               // (3.2) "host:port" while connected; the watch window dials it
export function isReconnectPending(): boolean
export function request(op: 'handoff'|'info'|string, payload = {}, { timeoutMs = 15000 (handoff: 185000) } = {}): Promise<any>
      // sends {type:'request', id, op, ...payload}; resolves on {type:'response', id, ok, result|error}.
      // A handoff waits on a browser launch; the daemon allows it 3 min, so its default is 185 s.
export function flowLib(op, payload = {}, { timeoutMs = 15000 } = {}): Promise<any>
      // F5: sends {type:'flowlib', id /*the transport's own number*/, op, flowId?, ...rest}; the flow is
      // payload.flowId (or, as before, payload.id). Any number of requests may be in flight, the same flow's too.
```

* Before the socket: `GET /health` (preflight). A positively identified v1 bridge (`ok:true`, major
  version 1, no `name:'g9d'`) stops the attempt — no socket is opened, so its client is not displaced.
  ***(as built)*** So does a refused connection (nothing listens: `bridge.lastError` "daemon not reachable",
  then the normal backoff); a preflight that times out lets the socket try.
* Connects to `ws://{state.bridge.host}:{state.bridge.port}/g9`; first frame
  `{type:'hello', role:'engine', version, client:{name:'extension', browser: navigator.userAgent, extensionId,
  instanceId, loadId, tabs:[{tabId, url}]}}` (decision D-c; `instanceId` from storage.local key
  `g9:instanceId`, `loadId` from storage.session key `g9:loadId`, both created on first use).
* `isConnected()` is true only after the daemon's welcome, not at socket open. Daemon pings are answered here
  (`pong`) and not forwarded to `onMessage`.
* On `welcome`: `setState({ bridge: { connected:true, daemonVersion, daemonPid, engineId, connectedAt, repoRoot,
  lastError:null, problem:null }, project })`. If `welcome.problem` is set (or the socket closes 4001), store it
  in `bridge.lastError` and `bridge.problem` (persisted) and stop reconnecting until `connectNow()`. A Stop
  pressed while disconnected is re-asserted after the welcome (`{type:'event', event:'halt', …}`) when the
  daemon is not halted.
* A close whose reason starts with "superseded" (the daemon gave this `instanceId` to a newer connection,
  D-c) stops reconnecting until `connectNow()`, in memory only (never `bridge.problem`: a dying worker must
  not block its replacement).
* Backoff (0.5, 1, 2, 5, 10, 20, 40, 60 s) and the 20 s ping are unchanged from v1. `discoverBridges` and
  `PORT_RANGE` are removed. ***(as built)*** The welcome must arrive within 10 s of the socket opening, and the
  `/health` preflight is bounded at 3 s.
* Dev override files read by `sw.js` before the first connect: `dev-daemon.json` (preferred) or
  `dev-bridge.json` (v1 name), shape `{host, port}`.
