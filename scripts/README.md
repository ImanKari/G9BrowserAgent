# scripts

Standalone automations that drive the extension through the **same MCP
interface an AI agent uses**. They are ordinary scripts — no agent, no editor,
nothing watching. The pattern is the point: once an agent has walked a flow and
learned how a site actually behaves, that knowledge can be frozen into
something schedulable.

## Save-TelegramImages.ps1

Archives every photo in an open Telegram Web channel, walking backwards through
its history and naming each file after the moment the post was published.

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

**Close your editor's MCP client first.** The extension attaches to exactly one
bridge, on the port set in its side panel. If your editor already holds that
port, the extension is talking to *that* bridge and this script would sit alone
with no browser behind it. The script checks and refuses rather than hanging.

Then: open the channel in Telegram Web, click the G9 icon, **Attach & Pin**.

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
- The script only reads and sets `scrollTop`, so it works on a background tab.
  Anything that clicks or types would need the tab in the foreground; see
  **The tab has to be visible** in the root README.
- Already-saved posts are tracked in the page for the run, so re-collecting the
  same mounted post is free.
