# The device QA bridge protocol

What an app implements so that `runner/g9.mjs --platform <device>` can replay FlowSpec flows on a phone or
tablet. The runner side is `runner/drivers/device.mjs`; which apps exist is the project's data
(`g9.project.json` `devices`, read by `lib/devices.mjs`, described in runner/README.md "Devices").

The bridge belongs in **test builds only**. It can tap, type and read the app's data; a production build
must not contain it.

## Transport

An HTTP/1.1 listener inside the app, bound to the device's loopback on one port (default **8799**, a
platform's `port` overrides it). The runner reaches it with `adb forward tcp:<port> tcp:<port>`, so nothing
is exposed to the network.

| Request | Body | Answer |
|---|---|---|
| `GET /qa` | — | the hello (below), within 5 s |
| `POST /qa` | `{ "command", "args": {}, "timeoutMs", "leaseId"? }` (JSON) | `{ "ok": true, "result": {…} }` or `{ "ok": false, "error": "…" }` |

- `timeoutMs` is on the request ROOT: it is the command's own budget. The runner waits `timeoutMs + 5 s` for
  the HTTP answer.
- When the hello says `tokenRequired`, every POST carries `x-qa-token: <token>`; a wrong token is HTTP 401.
- Once a lease is taken (`lease.acquire`), every command carries its `leaseId`; a command without the current
  lease is refused while another runner holds the device.
- An unknown command answers `ok: false` with an error that contains `unknown command`.

### The hello

```json
{ "ok": true, "service": "shop-qa-local", "environment": "Development", "tokenRequired": false,
  "package": "com.example.shop.next" }
```

`package` (or `app`, when it is an application id) names the app. When the runner was told which package must
own the port, a hello naming another one is refused before any command.

### Off the path: `DERAILED:`

An error that starts with `DERAILED:` means the app has left the path every flow assumes (its crash screen,
a fatal error popup). The runner stops the flow at once instead of waiting out step budgets. A bridge may
also refuse actions while such a screen is up. The runner independently checks the screen for the
platform's `errorScreens` prefixes and checks that the app's process is alive.

## Commands

| Command | Args | Result | Used for |
|---|---|---|---|
| `qa.selftest` | — | `{ verdict: "PASS"\|"FAIL", checks: [{ name, ok, detail? }] }` | run before anything else; every check that fails silently in production code should be a named check here |
| `qa.ping` | — | `{ build? , versionName? }` | the report's provenance; `requires.minBuild` |
| `qa.capabilities` | — | `{ features: [], commands: [] }` | `requires.features`; `ui.tap:real-touch` marks a bridge whose taps are real touches |
| `lease.acquire` | `{ owner, ttlSeconds }` | `{ leaseId }` | one runner per device |
| `lease.release` | `{ leaseId }` | — | |
| `ui.snapshot` | `{ maxNodes? }` | `{ nodes: [{ automationId, … }], nodeCount, tree }` | the `aria` oracle; the off-path check |
| `ui.find` | `{ automationId }` | `{ value?, text?, bounds? }` | `visible`, `value`, `onScreen` |
| `ui.waitFor` | `{ automationId, timeoutMs }` | — | `navigate` (wait until that screen is shown) |
| `ui.waitIdle` | `{ timeoutMs }` | `{ idle }` | after every action; the `idle` oracle |
| `app.busy` | — | `{ reasons: [] }` | names what kept the app busy when `idle` failed |
| `ui.tap` | `{ automationId }` | — | `click` |
| `ui.type` | `{ automationId, value }` | — | `type` |
| `ui.dismissOverlay` | — | — | `dismiss` (close the top dialog or sheet) |
| `ui.selectItem` | `{ automationId, itemId?, idField?, text? }` | — | `selectItem`: a row of a virtualized list by its data |
| `ui.setValue` | `{ automationId, value }` | — | `setValue`: a picker, date, wheel or switch |
| `ui.tapPopupButton` | `{ text }` | — | `popupButton`: a button of the open popup by its caption |
| `map.tapFeature` | `{ layer, featureId, idField? }` | — | `tapFeature` (the app's real tap pipeline) |
| `map.zoomToFeature` | `{ layer, featureId, idField? }` | — | `zoomToFeature` |
| `map.longPressFeature` | `{ layer, featureId, idField? }` | — | `longPressFeature` |
| `map.assertFeatureVisible` | `{ layer, featureId, idField? }` | — | the `map` oracle |
| `db.probe` | `{ name, args: [] }` | `{ value }` | the `probe` oracle: a named, read-only question about the app's data |
| `flow.record.harvest` | — | `{ candidates: [] }` | `g9 harvest`: drain the app's passive flow recorder |

`idField` defaults to `Id`. `bounds` is `{ x, y, width, height, visibleFraction, onScreen, screenWidth,
screenHeight, safeBottom }` in dp, where `onScreen` means fully drawn, unclipped and clear of the system bars
showing now.

A bridge implements what its app needs: the map commands only in a map app, `flow.record.harvest` only with a
recorder. A step whose command the bridge does not know fails with the bridge's own `unknown command`, and a
flow can declare what it needs (`requires.features`) so that it is SKIPPED, not failed, on an older build.

## Addressing

Controls are addressed by a stable **automation id** (`Page.Control`), never by coordinates or text. A list's
recycled rows have no stable id: `selectItem` names the list and the row's data. A popup host that renders its
buttons from a description gives them no id: `popupButton` names the caption.

## Honesty

A bridge that actuates a control's command instead of touching the screen proves the command works, not that a
finger could reach the control. Its runs are labelled `gray-box`. A bridge that injects a real touch at the
control's measured centre says so (`ui.tap:real-touch`), and a covered or off-screen control then fails the
step.
