# `g9` — the unattended runner

Replays recorded flows with **no agent and no QA present**, and returns a
standard exit code plus a report directory. This is the piece that turns "we
recorded a test" into "it runs every night".

**Documentation audited against v1.7.21 on 2026-09-12.** Browser runs still need a connected
extension and an execution environment suitable for their interactions. Scheduling the CLI does
not launch/configure a browser or guarantee background input delivery. See the
[current implementation limits](../AIGuide.md#8-known-gaps-and-deliberate-omissions).

```powershell
node runner/g9.mjs list
node runner/g9.mjs run suite:smoke --env test1 --report ./g9-artifacts
node runner/g9.mjs calibrate rec_abc123          # once per flow
node runner/g9.mjs approve  rec_abc123           # after a human reviewed the run
node runner/g9.mjs spec     rec_abc123 --out flows/task.create.json
node runner/g9.mjs ab       rec_abc123 --a https://released.example --b https://candidate.example
```

## It speaks MCP, on purpose

For browser flows, the runner spawns `bridge/src/server.js` and talks to it over stdio — the same
interface an agent uses, the same tools, the same boundaries. It can do nothing
an agent could not do, so pinned mode, the Stop button and cookie scoping still
apply to a scheduled run. There is no private back door into the extension, and
there should never be one.

The runner also has an AgriPad adapter (`drivers/agripad.mjs`) selected with `--platform agripad`.
It uses adb and the device's automation endpoint rather than browser tabs. A working browser flow
does not imply that adapter/device is configured, and device results are labeled `gray-box`.

## The port rule — read this before scheduling anything

The extension connects to **exactly one** bridge at a time. Without an explicit port, bridges can
discover an available port in 8765–8775; `--port` pins the runner's port. A second free port does
not connect the extension automatically. Select the intended bridge in the panel, or use a separate
profile/extension instance. If the editor owns a pinned port, the runner cannot own that same port.

So the unattended arrangement is a **second browser profile** with its own copy
of the extension carrying `dev-bridge.json`, which is precisely what
`setup/isolated-livetest.mjs` builds. Point the runner at that port:

```powershell
node runner/g9.mjs run suite:smoke --port 8790
```

An everyday profile is convenient for one-off runs, but scheduled interaction shares its tabs,
logins, focus and bridge ownership with the user. A dedicated browser/profile and coordinated
bridge port make those dependencies explicit; the CLI does not provision them for you.

Background reads and screenshots can work, and headless background typing succeeded in the latest
targeted audit. This does not certify minimized/occluded windows or a locked desktop. The current
generic input witness also has an unresolved defect. Verify action outcomes and test the actual
scheduled environment before relying on unattended interaction. The isolated harness uses headless
mode and Node.js 22+; it is not evidence for every headed state.

Named browser sessions are tab aliases, not separate login contexts. Same-origin normal tabs in one
profile share cookies/localStorage. Separate accounts need an appropriate isolation arrangement.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | everything passed (warnings allowed) |
| 1 | **product** failure — an assertion or oracle failed |
| 2 | **automation** failure — the test broke, not the product |
| 3 | a confirmed **surprise** — the flow did something it has never done |
| 4 | the runner could not run at all |

`--fail-on failure` keeps the gate where a normal suite would put it while you
learn to trust the surprise detector; `--fail-on surprise` (the default) treats
an unexplained change as a reason to look.

Separating 1 from 2 is the whole point of the classification. A pipeline that
reports a rotted locator as a product regression teaches people to ignore it.

## Reports

Four files, because four audiences read them:

| File | For |
|---|---|
| `run.json` | machines — the complete record, including every surprise |
| `junit.xml` | CI — surprises appear as their own test cases, not a footnote |
| `report.html` | a QA, by double-clicking. Self-contained, no CDN |
| `qa-automation-status.json` | the manual QA suite: `{ "TC-06-01": { "status": "PASS", … } }` |

That last file is the cheap, high-value one: it is what lets an existing manual
test suite show which scenarios are already covered automatically, so a tester
knows what they can skip today.

## Pinning the backend

```powershell
# once, against the real server
node runner/g9.mjs run rec_abc --report ./art        # (record a HAR from the panel or the agent)
# thereafter
node runner/g9.mjs run rec_abc --pin har/task-create.har --strict-pin
```

HAR pinning serves stored responses for matching requests. Matching uses method, origin/path and
query keys, ignores query values and request bodies, and consumes duplicate entries in order.
Without `--strict-pin`, unmatched requests still reach the live server. Stored bodies are bounded.
Use this comparison to narrow a diagnosis; it does not prove a fully frozen backend or attribute
every remaining difference to the client.
