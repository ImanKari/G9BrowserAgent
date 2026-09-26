# scripts

Standalone automations that drive the extension through the **same MCP
interface an AI agent uses**. They are ordinary scripts — no agent, no editor,
nothing watching. The pattern is the point: once an agent has walked a flow and
learned how a site actually behaves, that knowledge can be frozen into
something schedulable.

**Documentation audited against v1.7.21 on 2026-09-12.** These scripts use the existing browser
connection; they do not provision an isolated profile or make every browser operation background-safe.

**Not updated for v2 (checked against G9 2.0.3 on 2026-09-25, by reading the code; not run).** The
text below describes v1. `Save-TelegramImages.ps1` does not work with v2 as written: it refuses to
start when anything listens on its port (v1's one-bridge rule), and in v2 the shared daemon normally
listens there; and it waits for `browser_status` to report `connected` and `attached`, fields v1 had
and v2's status does not (v2 reports `current`, `engines` and `owned`), so it stops with "No attached
tab". In v2 `bridge/src/server.js` only starts the MCP shim, which shares the one daemon with every
agent; there is no bridge to select and no **Attach & Pin** (the panel's button is **Attach current
tab**).

## Save-TelegramImages.ps1

Archives photos it can load from an open Telegram Web channel, walking backwards through
its history and naming each file after the moment the post was published. Coverage depends on
Telegram's current DOM, available history/media, loading behavior, and the script's round limits.

```powershell
.\Save-TelegramImages.ps1
.\Save-TelegramImages.ps1 -MaxRounds 20 -OutDir D:\archive
```

Files land in `images/` beside the script:

```
2026-08-24_18-30-06_4294971183.jpg
2026-08-21_18-30-05_4294971182.jpg
```

The timestamp comes from Telegram's own `data-timestamp` on the post, converted
to local time — not from when the file was written — so an archive sorts into
the channel's real chronology.

### Before you run it

**Free the script's selected port, or give it a separate port and select that bridge in the panel.**
The extension connects to exactly one bridge at a time. If the editor owns the selected port,
close that MCP client before using the same port. This script explicitly pins `G9_PORT` and checks
for a conflict; automatic port selection in other bridge clients does not make it share a connection.

Then: open the channel in Telegram Web, click the G9 icon, **Attach & Pin**. Keep the browser,
extension and selected bridge running. Images are read as page blobs and saved by PowerShell;
the script does not use the currently broken `browser_network watch_downloads` path.

### What driving it by hand first taught us

Every non-obvious line in the script traces back to something the page did that
a reasonable guess would have got wrong:

| Assumption | What Telegram actually does |
|---|---|
| Scroll the visible list | The scroller is `.bubbles-scrollable`; `.bubbles` does not scroll at all |
| `scrollTop` tracks progress | Telegram restores the position after each load, so it is never 0 for long |
| Collect at the end | Posts are **unmounted** as they leave the viewport — about 30 stay alive no matter how far back you go |
| Stop when the page stops growing | `scrollHeight` plateaus long before the history ends; the honest signal is that no smaller `data-mid` arrives |
| Adverts have no image | Sponsored posts carry a real photo. They are `is-sponsored`, with `data-mid="-1"` and `data-timestamp="2"` — filtering them is not optional |
| Images can be downloaded | They are `blob:` URLs, readable only inside the page, so they are converted to base64 there |

That list is the actual product of the exploration. The script is just what is
left once you know it.

### Notes

- Images cross the bridge as base64, so `-BatchSize` is deliberately small. The
  WebSocket transport drops any frame over 64MB — and the connection with it.
- The script uses page evaluation and direct `scrollTop` changes, so it can work on a background
  tab without trusted mouse/key delivery. It still depends on Telegram loading the next batch and
  the page remaining alive; frozen/discarded pages, changed selectors or a stalled load can stop
  progress. Input and screenshot behavior are separate; see
  [What works in which state (measured)](../docs/REFERENCE.md#what-works-in-which-state-measured).
- Already-saved posts are tracked in the page for the run, so re-collecting the
  same mounted post is free.
