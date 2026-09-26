# README pictures

The screenshots in [README.md](../../README.md) and [README.fa.md](../../README.fa.md) come from a
real run of G9, made by [`setup/docs-screenshots.mjs`](../../setup/docs-screenshots.mjs): a private
daemon, the real extension in headless Chrome, an agent talking to the real MCP shim, and the packaged
Linux desktop app on the same daemon. Nothing is mocked or arranged by hand.

| File | What it shows |
|---|---|
| `demo-shop.png` | The made-up Demo Shop (`setup/fixtures/demo-shop.html`) after the agent placed an order. |
| `panel-session.png`, `panel-automation.png`, `panel-issues.png`, `panel-about.png` | The side panel's four tabs, after the agent attached the tab, recorded a checkout flow and filed an issue. |
| `desktop-agents.png`, `desktop-engines.png`, `desktop-watch.png`, `desktop-runs.png`, `desktop-settings.png`, `desktop-setup.png` | The desktop app's views; Watch shows a launched headless browser live, with the agent's cursor; Runs shows the recorded flow replayed there. |

**Privacy.** They were made in a throwaway Linux container (`node:22-bookworm`) as a user called
`demo`, so every path in them is `/home/demo/…` or `/tmp/…`. The only site visited is the local Demo
Shop on `127.0.0.1`; the names and addresses in it (`Alex Example`, `alex@example.com`) are made up.
No account is signed in anywhere.

**To make them again** (after a UI change), on a machine or container where the user name and paths
are neutral, with Chrome installed:

```bash
cd desktop && npm ci && node scripts/build.mjs --linux && cd ..
xvfb-run -a -s "-screen 0 1440x960x24" \
  node setup/docs-screenshots.mjs --out docs/assets --app desktop/dist/linux-unpacked/g9
```

Without `--app`, only the Demo Shop and the side panel are photographed. Review every picture before
committing it.
