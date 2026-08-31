# G9 Browser Agent

Give an AI agent full, DevTools-level control of the browser you are **already using** — your real profile, your real logins, your real tabs.

The agent can read everything you can read in DevTools (Elements, Computed styles, Console, Network with response bodies, Application storage and cookies, Performance) and do everything you can do with a mouse and keyboard — using **trusted input events**, so frameworks that reject synthetic clicks behave exactly as they do for a human.

```
  AI Agent  ──MCP (stdio)──▶  Bridge  ──WebSocket──▶  Extension  ──CDP──▶  Your tab
                             (Node.js)                (Chrome/Edge)
```

---

## Why this design

Two obvious approaches both fail for this use case:

| Approach | Why it falls short |
|---|---|
| **Selenium / WebDriver** | No DevTools depth. No computed styles, no network bodies, no console, no performance traces. |
| **Playwright / CDP over `--remote-debugging-port`** | Since **Chrome 136** the flag is ignored on the default profile, so you get a blank browser with none of your logins. The Chrome 144 `chrome://inspect` toggle helps, but does not work on Edge. |

A **Manifest V3 extension holding the `debugger` permission** sidesteps both. It talks CDP through `chrome.debugger`, which works on the real default profile with no flags and no port — and it works identically on Chrome and Edge.

---

## Requirements

- **Node.js 18+** — no `npm install`, the bridge has **zero dependencies**
- **Chrome 116+** or **Edge 116+**

## Install

```powershell
git clone <this-repo> g9-browser-agent
cd g9-browser-agent
.\setup\install.ps1
```

The script checks Node, runs the self-test, and writes `setup/mcp.json` with the correct absolute path. Then two manual steps.

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
3. Press **Attach & Pin current tab**.
4. Talk to your agent normally: *"check this page for problems"*, *"log in as admin and confirm the orders list loads"*, *"why is the save button not responding?"*

---

## The three modes

| Mode | Behaviour | Use when |
|---|---|---|
| 📌 **Pinned** *(default)* | Locked to one tab. You can browse anywhere else freely and the agent will not follow. | Almost always. |
| 👁 **Follow** | Acts on whichever tab is focused. | Quick exploration across pages. |
| 🌐 **Multi** | May open, close, and switch tabs itself. | Multi-tab flows, cross-page journeys. |

Pinned is the default deliberately: without it, switching to your email mid-task would hand the agent your inbox.

The side panel shows every action live, and **Stop** halts the agent instantly.

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
| `browser_network` | List requests; fetch one with headers and response body |
| `browser_diagnose` | **health** — correlated defect report; **performance** — trace summary |
| `browser_screenshot` | viewport / fullpage / element |
| `browser_emulate` | Device, viewport, network throttle, CPU, colour scheme, locale, timezone |
| `browser_dialog` | Accept or dismiss `alert` / `confirm` / `prompt` |
| `browser_tabs` | List tabs; open, close, focus, pin — the last four only in multi-tab mode |

Twelve tools rather than fifty: definitions are re-sent on every request, so a wide surface would burn thousands of context tokens before the agent did anything.

### Element refs, not CSS selectors

`browser_snapshot` returns an accessibility tree where every interactive element carries a handle:

```
- button "Sign in" [ref=e7]
- textbox "Username" [ref=e5] (value="admin")
- link "Forgot password?" [ref=e9] (url=/reset)
```

The agent passes `ref: "e7"` to `browser_interact`. Refs are versioned per snapshot — a stale ref produces a clear error telling the agent to re-snapshot, rather than silently clicking the wrong element.

---

## Verifying it works

```powershell
node setup/selftest.mjs
```

Spawns the real bridge, speaks real MCP over stdio, connects a fake extension over a real WebSocket, and checks 26 behaviours including Origin rejection, keepalive, standalone survival, and surviving a malformed frame. **No browser needed** — if this passes, the plumbing is sound and any remaining problem is in browser-side code.

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
diagnose, trusted-event login, obstruction detection, screenshots, and device
emulation, then checks that all six seeded defects were actually found. As of v1.0.9 all six **are** found — verified against Edge.

---

## Security

This tool has full control of your logged-in browser sessions. Treat it as you would an SSH key.

**What protects you:**

- The bridge binds to **127.0.0.1 only** — never `0.0.0.0`
- **Origin validation**: only `chrome-extension://` / `edge-extension://` origins may connect. A malicious web page attempting `new WebSocket('ws://127.0.0.1:8765')` sends its own `https://` origin and is rejected with 403. *(The self-test asserts this.)*
- **Single client** — a second connection displaces the first rather than silently sharing
- **Pinned mode** — the agent reaches exactly one tab, the one you consented to. It also may not open, close, focus, pin, or unpin tabs; outside multi-tab mode `browser_tabs` can only *list*, because pinning a different tab would otherwise be a way around the mode
- **Cookies stay scoped** — `chrome.cookies` can see every domain you are signed in to, so outside multi-tab mode the agent may only read cookies for the attached tab's own origin
- **Other tabs stay private** — outside multi-tab mode the agent sees other tabs by origin only. Titles and URLs carry subject lines, document names, and search queries, so they are withheld
- **Stop button** — blocks every tool call immediately, and **the agent cannot lift it**. Only Resume in the side panel does. (`browser_status` still answers, so the agent can tell you *why* it stopped rather than guessing.)
- **Full activity log** in the side panel; nothing happens invisibly
- **Least privilege** — seven permissions, all of them used. `scripting` and `downloads` were requested by earlier versions and never called, so they were dropped
- **Zero dependencies** — no supply chain under a tool with this much access

**Optional:** set `G9_TOKEN` in the MCP config and enter the same value in the side panel for a shared secret on top of Origin checking.

**Known and unavoidable:** the "browser is being debugged" banner cannot be hidden. Browser-internal pages (`chrome://`, `edge://`, extension stores) can never be controlled. Native OS dialogs (print, basic auth) are outside the browser's reach — but file uploads work via `browser_interact action:"upload"`, which bypasses the picker entirely.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| *"The G9 browser extension is not connected"* | The browser is closed, the extension is disabled, or no tab is attached. Open the side panel and press **Attach & Pin**. |
| `browser_network` returns 0 requests | Capture starts when the tab is **attached**, not when it loaded. Reload the page, then read again. |
| Agent shows no `browser_*` tools | The MCP config path is wrong, or the client was not restarted. MCP servers load at client start — restart it after editing the config. |
| `Cannot find module ...server.js` | The config still has a placeholder path. Use `setup/mcp.json`, which `install.ps1` fills in with the real absolute path. |
| `ERR_CONNECTION_REFUSED` in the extension's **Errors** page | **Expected when no bridge is running.** The browser logs failed WebSocket handshakes itself, below our code, so it cannot be suppressed. The extension retries on a backoff that climbs to 60s, so it stays to about one entry a minute. Start the bridge (or open the side panel) and it connects immediately. |
| Side panel says **Bridge offline** | Nothing is listening on the port — the bridge is not running. Either restart your MCP client (it launches the bridge), or start it yourself: `node bridge/src/server.js`. That command stays up in standalone mode, so you can watch the extension connect. |
| MCP client says **Connection closed / Failed**, but the side panel says **Bridge connected** | Another bridge already holds the port, and the extension connected to *that* one. Usually a second editor window, or a leftover `node` process. Find it with `netstat -ano \| findstr 8765`, stop it, then hit **Reconnect** in your MCP client. The blocked bridge also retries every 5s on its own, and its tool calls now say exactly this. |
| `EADDRINUSE` | Another bridge is running. Stop it, or change `G9_PORT` in **both** the MCP config and the side panel. The bridge no longer exits on this — it stays up and reports the conflict through the agent. |
| *"Another debugger is already attached"* | A DevTools window is open on that tab. Close DevTools, or attach a different tab. |
| Agent clicks the wrong thing | Its snapshot is stale. Ask it to take a fresh `browser_snapshot`. |
| A dialog blocked everything | Handled: the call that opened it now fails immediately naming `browser_dialog`, and later calls fail instantly too rather than each waiting 60s. |
| Tools hang, then time out | A JavaScript dialog is blocking the page. `browser_dialog` clears it. |
| Everything fails with *"halted"* | **Stop** is engaged. Press **Resume** in the side panel — nothing the agent does can clear it, by design. |
| Agent says it cannot open, close, or pin a tab | Correct, and deliberate: outside **Multi** mode `browser_tabs` may only list. Either do it yourself, or switch the side panel to Multi. |
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
├── setup/                  install.ps1 · selftest.mjs · livetest.mjs · serve.mjs · testpage.html
├── README.md               this file
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
> 5. Run `node setup/selftest.mjs` — it asserts the tool count, so it will fail until you have updated everything.
>
> A change that is not in `AIGuide.md` did not happen. This is how we keep an accurate picture of what we have and what we do not.

## License

Internal G9 tooling.
