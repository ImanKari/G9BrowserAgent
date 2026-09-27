# `g9` — the unattended runner (v2)

The runner replays recorded flows with **no agent and no QA present**. It returns a standard exit
code and writes a report directory. This is the piece that turns "we recorded a test" into "it runs
every night".

```powershell
node runner/g9.mjs list
node runner/g9.mjs run suite:smoke --env test1 --report ./g9-artifacts
node runner/g9.mjs run tag:checkout --headed --browser edge --profile qa-checkout
node runner/g9.mjs calibrate flow_login          # once per flow (per environment)
node runner/g9.mjs approve  flow_login --by alice --note "new banner is expected"
node runner/g9.mjs spec     flow_login --out QA/Flows/web/auth/login.flow.json
node runner/g9.mjs ab       flow_login --a https://released.example --b https://candidate.example
node runner/g9.mjs harvest  --platform agripad --device R52T80XXXX
node runner/g9.mjs help
```

On a machine with only the desktop app installed there is no `node`. Run the same file with the
app itself: `G9BrowserAgent.exe` with `ELECTRON_RUN_AS_NODE=1` and `resources\runner\g9.mjs` (see
[Scheduling](#scheduling)).

## Where it runs: a launched browser, by default

`--engine launched` (the default) runs every flow in a browser that the G9BrowserAgent daemon **launches**: real
Edge, Chrome or Chrome for Testing, headless by default (the daemon setting `headless`) or headed
with `--headed`, with its own profile under
`G9_HOME\profiles`. It never touches the person's own browser. A headless launched browser has no
window, so a minimised or covered window, or someone working in their own browser, does not affect
it. That is the reason Engine 2 exists (AIGuide §2.8.1, D3). By the same design a locked session
should not affect it either — and disconnecting RDP puts the session in exactly that state (see
docs/INSTALL.md, "Unattended machines"). **That was not measured.** A logged-off user runs nothing,
because every G9BrowserAgent process lives in the user's session.

The engine is **held** for the run (`browser_engine action:"acquire"`, or `lease:true` on the launch)
and released at the end; the daemon stops an engine that was launched for a run once the last run
holding it has released it and no agent owns a tab in it. Two overlapping runs on one profile
therefore share one browser safely: neither stops it under the other.

| Engine option | Meaning |
|---|---|
| `--engine launched\|extension` | where to run (default `launched`) |
| `--browser auto\|edge\|chrome\|cft` | `auto` = the pinned Chrome for Testing if it is installed, else Edge, else Chrome. Name the browser for stealth suites, since detectors flag CfT's brand (`docs/STEALTH.md`). |
| `--headless` / `--headed` | window mode of an engine this run launches (default: the daemon setting `headless`, which is `true`) |
| `--profile <name>` | the launched engine's profile (default `automation`). Sign in to your sites in it once, with the desktop app or `browser_engine action:"warm"`; its cookies persist between runs. |
| `--humanize off\|human\|stealth\|<profile>` | input style (default: the engine's setting, normally `human`). A calibrated profile name works too (`docs/HUMANIZE.md`). |
| `--humanize-seed <n>` | reproduce a run's exact pointer and keyboard motion |
| `--stealth off\|human\|stealth` | stealth level of an engine this run launches (default: the daemon setting, `off`) |
| `--keep-engine` | leave an engine this run launched running afterwards |
| `--port <n>` | the G9BrowserAgent daemon's port. It is passed to the shim as `G9_PORT`; without it the shim uses `G9_PORT` from the environment, else 8765. |

**Engine reuse.** An engine already running on the same `--profile` is reused, because a profile can
be open in only one browser at a time. If it does not match the run's `--headed`/`--headless` or
`--browser`, the run stops and says so; stop that engine or use another profile. If another client is
launching the same profile at that moment, the runner waits for that launch (up to 2 minutes) and
reuses it. Otherwise it launches an engine, named `g9 runner`, holding it with a lease; at the end
it releases the lease, and the daemon stops that engine once no other run holds it and no agent owns
a tab in it. With `--keep-engine` it keeps running. (Against a daemon without leases, the runner
stops what it launched itself.)

**Each flow gets a fresh tab:**
1. the tab opens on `about:blank`;
2. a pinned HAR, if any, is applied;
3. the tab goes to the flow's start URL. The whole goto has 110 s, which covers a cold server's first
   byte;
4. the flow replays;
5. the tab closes.

`--engine extension` is the v1 behaviour. Flows come from the extension's own store and replay on
the tab that the person's browser has current. It needs the v2 extension connected, and it shares
that browser (its tabs, focus and window state) with the person, so it is not the mode to schedule.

## Flows come from the repository

For launched runs, the flow library on disk is the source of truth:
- Every `*.flow.json` FlowSpec under the project's `flowsDir` is validated, then imported into the
  launched engine's store before it runs. `flowsDir` comes from `g9.project.json` and defaults to
  `QA/Flows`; `agripad/` and `suites/` are excluded.
- A file that is not valid JSON or not a valid FlowSpec stops the run and names the file. A file
  whose `target.kind` names another platform than `web` is skipped before validation.
- Re-importing never erases what the store learned about a flow: its **known world**, run history and
  flakiness stay, so the surprise detector works across nightly runs.

`g9.project.json` is found by walking up from the working directory, the way git finds `.git`, or
you can name it with `--project <file>`.

Without a `g9.project.json` (or with an empty library), the runner falls back to the recordings the
browser stores hold (`browser_recording action:"list"`). A recording that only exists in the person's
browser is copied into the launched engine by the daemon when it replays.

**Targets:**
- `<flowId>` or the flow's name;
- `suite:<name>`: a query in `QA/Flows/suites/<name>.json`;
- `tag:<name>`;
- `all` (the default).

A bare name that is no flow's id or name is tried as a suite name (the desktop's Schedule form sends
one); on `--platform agripad` only ids and names match. A selection that matches nothing is an error
that lists the known flows, never an empty PASS.

## Run options

| Option | Meaning |
|---|---|
| `--env <name>` | run against this `g9.project.json` environment (must be declared there when any are): flow URLs whose origin is any known environment's origin are rewritten onto its `baseUrl`, `{{baseUrl}}` resolves to it, the flow's **known world is keyed by the environment**, and the name appears in every report. Without `--env`, the project's `defaultEnvironment` is used as the label (and for `{{baseUrl}}`), but URLs are **not** re-pointed. |
| `--data <file.json>` | variables substituted into `{{placeholders}}`; also the first source for `{{secret:NAME}}` values — then `G9_SECRET_<NAME>` environment variables (NAME uppercased, non-alphanumerics → `_`). A flow whose required secret has neither is **SKIPPED**, and secret values are masked in run.json and every report. |
| `--report <dir>` | where the reports go (default `./g9-artifacts`) |
| `--timing recorded\|adaptive\|fast` | replay pacing (default `recorded`) |
| `--signature lite\|full\|off` | how much of the page's behaviour is fingerprinted for the known world (default `lite`) |
| `--seed` | seed the known world when a flow has none yet |
| `--no-compare` | skip the known-world comparison (produces a reference run) |
| `--pin <file.har>` / `--strict-pin` | serve the network from a HAR; strict fails any request the HAR does not contain |
| `--project <file>` | the project adapter |
| `--platform web\|agripad` | `agripad` drives a real device over adb (below) |
| `--device <serial>`, `--device-port <n>` | AgriPad only: which device, and its automation port (default 8799; on this path `--port` is still read as the device port when `--device-port` is not given, as in v1) |
| `--token <token>` | AgriPad only: the device's automation token, when the device requires one (shown on the device under Admin Diagnostics → QA Automation) |
| `--fail-on warning\|surprise\|failure` | the lowest verdict that makes the exit code non-zero (default `surprise`) |
| `--quiet` | only the closing lines: the summary, the humanize seed and where the reports are |

## It speaks MCP, on purpose

The runner spawns `mcp/shim.mjs`, the same shim an AI agent's client launches. The shim talks to
the one G9BrowserAgent daemon on this machine and starts it if needed. So the runner can do nothing an agent
could not do: ownership, the Stop button (side panel or desktop app) and every refusal apply to a
scheduled run exactly as they do to an agent. If Stop is engaged when the run starts, it exits 4 with
"Stop is engaged". There is no private back door, and there should never be one. (`--platform
agripad` is the exception: it talks to a device over adb and never contacts the daemon, so Stop does
not reach it.)

**The v1 "port rule" is gone.** v1 needed a second browser profile with its own extension copy,
because the extension talked to exactly one bridge. In v2, any number of agents, runners and the
desktop app share one daemon, and each tab has one owner at a time. `--port` only says where that
daemon listens.

## Scheduling

**G9BrowserAgent's scheduler.** The desktop app's **Schedule** view (or the daemon's `schedule.*` admin ops) runs
`runner/g9.mjs run <target> …` as a child process, daily at a local time or every N minutes:
- The child is started with the daemon's own executable, so on an installed machine it is `G9BrowserAgent.exe`,
  with no Node needed.
- Every engine option in the form becomes an explicit flag, except a browser left at "auto": no
  `--browser` is passed, so that entry follows the daemon's `defaultBrowser` setting.
- Each run is filed under `G9_HOME\runs\<runId>\`, with the reports in `report\`.
- An entry may name its project (`project`: the path of a `g9.project.json`). Otherwise the daemon's
  default project is passed as `--project`, and the run starts in that project's folder.
- A run missed while the daemon was down runs once when it comes back.
- It only fires while the daemon runs, so turn on "Start G9BrowserAgent when I sign in" (`docs/INSTALL.md`,
  "Unattended machines").

The desktop suite ran a desktop-shaped schedule entry through the packaged `G9BrowserAgent.exe`, with no Node on
the PATH: 3 of 3 runs passed (2026-09-22).

**Windows Task Scheduler** works as well. Set the task's "Start in" folder to the folder that holds
`g9.project.json`, or pass `--project <file>`: the runner looks for the project upwards from its
working directory, and a task starts in `System32` by default. From a repository checkout:

```powershell
node G:\path\to\G9BrowserAgent\runner\g9.mjs run suite:nightly --report D:\qa\nightly --quiet
```

On an installed machine, wrap the command in `cmd` so the environment variable is set (there is no
space before `&&`):

```
cmd.exe /d /c "set ELECTRON_RUN_AS_NODE=1&& "%LOCALAPPDATA%\Programs\G9BrowserAgent\G9BrowserAgent.exe" "%LOCALAPPDATA%\Programs\G9BrowserAgent\resources\runner\g9.mjs" run suite:nightly --report D:\qa\nightly --quiet"
```

That form was run against the built `win-unpacked` copy with `help`, and it exited 0. Task Scheduler
itself was not exercised. For stealth-critical suites, run headed Edge on a dedicated desktop that
nobody minimises (`docs/STEALTH.md`).

## Preflight: `requires`, secrets, and SKIPPED

A flow may declare, at its top level:

```json
"requires": { "minBuild": "5.9.2", "features": ["map-drawings"], "environments": ["test1", "test2"] }
```

Before a tab is opened (or a device command sent), the runner checks it:
- `environments`: the current `--env` must be one of them;
- on `--platform agripad`: `qa.ping` (build) and `qa.capabilities` (features/commands) are asked
  once per device per run; `minBuild` uses a lenient numeric-dotted compare, and every entry of
  `features` must be present;
- on web: build/features come from the environment's **object form** in `g9.project.json`
  (`{ "baseUrl", "features", "build" }`). A requirement the environment does not declare is a
  SKIP that says "cannot evaluate … — declare it in g9.project.json", never a silent pass.

A flow that fails preflight — or whose required `{{secret:NAME}}` has no value (see `--data`) —
gets the verdict **SKIPPED** with the reason. Skips never make a run red; they appear in run.json
(`skipReason`), as `<skipped>` in junit.xml, in a distinct section of report.html, and as
`"SKIPPED"` in qa-automation-status.json. `<reportDir>/skips.json` tracks how long each
(flow + environment) has been skipped; an entry older than **14 days** produces a loud warning in
the summary and the report — coverage that quietly evaporates is the failure `requires` invites.

## Suites: `order` and `stopOn`

A suite file may add, next to `select`:
- `"order": "risk-desc"` — run critical > high > medium > low (missing risk = medium; stable
  within a rank);
- `"stopOn": "failure"` — stop the suite after a flow whose verdict is `FAIL_PRODUCT`,
  `FAIL_AUTOMATION` or `ERROR` (not `SURPRISE`, not `SKIPPED`). The remaining flows are reported
  as **NOT_RUN**, naming the flow that stopped the suite — distinct from SKIPPED on purpose.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | everything passed (warnings allowed, unless `--fail-on warning`; SKIPPED/NOT_RUN alone never redden a run) |
| 1 | **product** failure: an assertion or oracle failed (`FAIL_PRODUCT`) |
| 2 | **automation** failure: the test broke, not the product (`FAIL_AUTOMATION`) |
| 3 | a confirmed **surprise**: the flow did something it has never done. With `--fail-on warning`, `PASS_WITH_WARNING` also gives 3. |
| 4 | the runner could not run at all (no daemon, no engine, no flows, bad arguments, Stop engaged) |
| 5 | a **runner-internal error** (`ERROR`): a driver exception or engine failure mid-run — the tool's fault, not the product's |

When results are mixed, precedence is **1 > 2 > 5 > 3 > 0**. `--fail-on failure` ignores
surprises, which keeps the gate where a normal suite would put it while you learn to trust the
surprise detector. `--fail-on surprise` (the default) treats an unexplained change as a reason to
look.

Separating 1 from 2 is the whole point of the classification. A pipeline that reports a rotted
locator as a product regression teaches people to ignore it — and 5 is split from 1 for the same
reason: a crash of this tool is not a product regression.

## Reports

Four files, because four audiences read them:

| File | For |
|---|---|
| `run.json` | machines: the complete record, including every surprise, the daemon version, the engine (id, browser, version, headless, profile, stealth, humanize, and whether this run launched it), the humanize seed, `provenance` (`gitCommit`/`gitBranch` from the repo holding g9.project.json, `appBuild` from the device's qa.ping or the web environment's declared `build`), each skipped flow's `skipReason`, and `staleSkips` (14+ days) |
| `junit.xml` | CI: surprises appear as their own test cases; SKIPPED/NOT_RUN flows as `<skipped message="…"/>`; engine, daemon version, seed and provenance as `<properties>` |
| `report.html` | a QA, by double-clicking. It is self-contained, with no CDN, and shows the engine, the seed, the provenance, a distinct section for skipped flows with their reasons, and a loud warning for skips older than 14 days. |
| `qa-automation-status.json` | the manual QA suite: `{ "format": "g9/qa-automation-status", "version": 1, "at", "environment", "cases": { "TC-06-01": { "status": "PASS", "flowId", "flowName", "at", "durationMs" } } }` — the worst verdict wins when two flows cover one case; a skipped flow records `"SKIPPED"` |
| `skips.json` | the runner itself: `(flowId + environment) → { firstSkippedAt, lastReason }`, updated every run — an executed flow drops out, a 14-day-old entry becomes the warning above |

Each launched-engine replay also leaves an evidence run under `G9_HOME\runs\<runId>\` (screencast
frames, the pointer track, `engine.json`, and `result.json` with the verdict, steps and warnings).
The flow's `evidence` field in `run.json` refers to it.

A humanized run is reproducible: the line after the summary prints the seed, and `--humanize-seed <n>` replays
the same pointer paths and typing rhythm.

## Other commands

| Command | What it does |
|---|---|
| `list` | the flows in the repository library and in each browser store |
| `calibrate <flowId>` | replays the flow twice on one build and marks what differs as volatile noise, so it never counts as a surprise. Run it once per flow — per environment: with `--env`, the mask lands in that environment's known world. |
| `approve <flowId> [--by <name>] [--note <text>] [--env <name>]` | folds the last run into the flow's approved known world — the one belonging to the environment the reviewed run ran on (an `--env` that disagrees is refused). The desktop's Approvals view does the same with your Windows user name. (3.2) When the flow is in a project repository, the approval is written beside it (`<name>.approved.json`; per-environment worlds under its `knownWorlds`), ready to commit. |
| `harvest --platform agripad [--device <serial>] [--out <dir>]` | drains the device's passive flow recorder (`flow.record.harvest`) and writes each candidate to `<flowsDir>/agripad/candidates/<yyyyMMdd-HHmm>-<n>.candidate.json` (`format: "g9/flow-candidate"`, tagged `@candidate`, device steps passed through untouched, plus capture time, device serial and provenance). Candidates are raw material, **not** flows: no loader ever runs one. An app build without the command gets a friendly message naming the build. |
| `spec <flowId> [--out <file>]` | exports a canonical, Git-diffable FlowSpec (to stdout without `--out`). (3.2) With `--out x.flow.json` it also writes what was approved beside it: `x.approved.json` and `x.baselines/*.png`. |
| `ab <flowId> --a <url> --b <url> [--timing <mode>] [--report <dir>]` | runs the flow against two builds and diffs their full signatures. It reports differences, not verdicts: a shipped feature and a regression look the same. It exits 0 unless a side failed to run (2), and writes `ab.json` with `--report`. |

## Pinning the backend

```powershell
# once, against the real server (record a HAR from the panel or an agent)
# thereafter
node runner/g9.mjs run flow_task_create --pin har/task-create.har --strict-pin
```

HAR pinning serves stored responses for requests that match:
- matching uses the method, origin and path, and the query keys; it ignores query values and request
  bodies;
- duplicate entries are consumed in order;
- without `--strict-pin`, unmatched requests still reach the live server.

Use the comparison to narrow a diagnosis; it does not prove a fully frozen backend.

## AgriPad devices

`--platform agripad` drives a real device over adb through `drivers/agripad.mjs` instead of a
browser. Flows come from `QA/Flows/agripad/**` and are validated like web flows (the device also
accepts the `dismiss` action; an invalid file stops the run and is named); `candidates/` files
(`*.candidate.json`, from `g9 harvest`) are never loaded as flows. Choose the device with
`--device <serial>` and its port with `--device-port <n>` (default 8799). `--data` variables and
`{{secret:…}}` values are substituted into device steps too. It shares the flow format, the
verdicts and the reports, and its results are labelled `gray-box`.
