# `g9` — the unattended runner

Replays recorded flows with **no agent and no QA present**, and returns a
standard exit code plus a report directory. This is the piece that turns "we
recorded a test" into "it runs every night".

```powershell
node runner/g9.mjs list
node runner/g9.mjs run suite:smoke --env test1 --report ./g9-artifacts
node runner/g9.mjs calibrate rec_abc123          # once per flow
node runner/g9.mjs approve  rec_abc123           # after a human reviewed the run
node runner/g9.mjs spec     rec_abc123 --out flows/task.create.json
```

## It speaks MCP, on purpose

The runner spawns `bridge/src/server.js` and talks to it over stdio — the same
interface an agent uses, the same tools, the same boundaries. It can do nothing
an agent could not do, so pinned mode, the Stop button and cookie scoping still
apply to a scheduled run. There is no private back door into the extension, and
there should never be one.

## The port rule — read this before scheduling anything

The extension connects to **exactly one** bridge, on the port set in its side
panel. If your editor's MCP client already holds 8765, the extension is talking
to *that* bridge and this runner cannot have the port.

So the unattended arrangement is a **second browser profile** with its own copy
of the extension carrying `dev-bridge.json`, which is precisely what
`setup/isolated-livetest.mjs` builds. Point the runner at that port:

```powershell
node runner/g9.mjs run suite:smoke --port 8790
```

Running against your own everyday browser works and is convenient for a one-off.
It is not the thing to put in Task Scheduler — a scheduled run would fight your
editor for the port, and it needs the tab in the foreground anyway (Chromium
does not deliver input to a hidden page).

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

With the backend frozen, any difference left in the run is the client's doing.
A pinned run red while the live run is green is a client regression; the other
way round is the server or the data. That single fact removes most of the
guesswork from triage.
