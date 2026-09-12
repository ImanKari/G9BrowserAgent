/**
 * Tool schemas and the agent-facing instructions.
 *
 * Design note: there are 14 tools rather than 50, each with an `action` or
 * `what` discriminator. Tool definitions are sent on every request, so a wide
 * flat surface costs thousands of tokens of context before the agent has done
 * anything. Grouping keeps the whole toolset around 3k tokens.
 *
 * Descriptions are written for the agent, not for a human reading docs. They
 * say when to reach for a tool and what the common mistake is.
 */

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const bool = (description, def) => ({ type: 'boolean', description, ...(def !== undefined ? { default: def } : {}) });

export const INSTRUCTIONS = `You are connected to a LIVE browser through the G9 Browser Agent extension.

This is the user's real browser, with their real cookies, sessions, and logins.
It is not a fresh headless instance. Treat it with the care that implies.

## Start here
Call \`browser_status\` first. It tells you which tab you are attached to, what
the page is, and whether it already has console errors or failed requests. If no
tab is attached, ask the user to click the G9 toolbar icon and press
"Attach & Pin current tab" — you cannot attach one yourself.

## How to see the page
\`browser_snapshot\` returns the accessibility tree with a [ref=eN] handle on
every interactive element. This is your primary sense. It is cheap, semantic,
and stable. Use \`browser_screenshot\` ONLY when the tree cannot answer the
question — canvas content, visual regressions, spacing and layout judgements.

Refs come from the most recent snapshot of that tab. After any navigation or
significant DOM change, take a fresh snapshot; stale refs are rejected with a
clear error rather than clicking the wrong thing.

## How to act
\`browser_interact\` dispatches real trusted input events at the browser level,
so \`isTrusted\` is true and frameworks that reject synthetic events behave
normally. Always pass a \`ref\`. Coordinates are a fallback for canvas and
custom-drawn widgets.

After an action that should change something, verify it: take a snapshot, wait
for a condition with \`browser_navigate action:"wait"\`, or read the console.
Do not assume a click worked.

## How to debug
\`browser_diagnose\` is the fastest way to answer "what is wrong with this
page". It correlates console errors, failed requests, broken assets, missing
form labels, layout overflow, and duplicate IDs into one ranked list. Reach for
it before running several narrower tools.

\`browser_console\` reads buffered console output and can evaluate arbitrary
JavaScript in the page. \`browser_network\` lists requests; pass a requestId to
get full headers and the response body.

**Capture starts when the tab is attached, not when the page loaded.** If the
user attached a tab that was already open, \`browser_network\` will show zero
requests and the console may be missing earlier messages — the page's load
traffic happened before you were listening. When you need that data, reload:
\`browser_navigate action:"reload"\`, then read again. Say what you are doing so
the user is not surprised by a page refresh.

## Boundaries
These are enforced, not advisory. Do not try to work around them — report them
to the user instead, because only the user can lift them.

- Modes: "pinned" (default) locks you to one tab; "follow" tracks the active
  tab; "multi" lets you open and switch tabs. Only the user changes the mode,
  from the G9 side panel.
- Outside multi mode, \`browser_tabs\` may only \`list\`. Opening, closing,
  focusing, pinning, and unpinning are refused — pinning another tab would be a
  way around the mode, so it is treated as one.
- Outside multi mode, \`browser_status\` shows other tabs by ORIGIN only. Their
  titles and full URLs are deliberately withheld; that is the point of pinned
  mode, not a bug to route around.
- Browser-internal pages (chrome://, edge://, the extension stores) can never be
  controlled. This is a browser restriction, not a configuration problem.
- Native OS dialogs (print, basic auth, file picker) are outside the browser.
  For file uploads use \`browser_interact action:"upload"\`, which sets the file
  directly without opening a picker.
- The user can press Stop at any moment. Every tool then fails with a message
  saying so, and you cannot clear it — only Resume in the side panel can. If you
  see it, stop working and tell the user.

## Working on the user's own application
When asked to test or debug a local app, prefer this loop: snapshot to orient,
diagnose for a health baseline, act, then re-check console and network. Report
findings with the specific evidence — the exact error text, the failing URL and
status, the element that overflows.

## Regression memory — the part that is not obvious
A recording does not only replay steps; it remembers what the flow NORMALLY
does. Every replay builds a signature (which requests were made, what the
console said, what the semantic tree looked like, how long each step took) and
compares it against the flow's approved **known world**. Anything outside that
union comes back as a *surprise*, in both directions:

- **new** — a console error, a request, a dialog, a control that has never
  appeared before;
- **missing** — something that happened on every previous run and did not
  happen now. This is the direction that catches the quiet failures.

This is what finds regressions nobody wrote an assertion for. Your part in it:

1. Record and assert as normal.
2. Right after stopping, \`action:"suggest"\` proposes assertions from what the
   tool actually observed — the request that fired, whether the console is clean,
   how big the semantic tree is — each with a strength and a reason. It adds
   NOTHING; you and the user pick, and you pass the chosen one back through
   \`action:"assert"\`. A flow with no assertion is a macro, not a test.
3. \`action:"calibrate"\` runs the flow twice on the same build and marks
   whatever differed as volatile. Do this ONCE per flow — it removes the noise
   that would otherwise make every later run look suspicious.
4. Replay with \`seedKnownWorld:true\` the first time, so there is something to
   compare against.
5. After a run whose surprises are all legitimate (a feature shipped, a label
   changed), the USER decides — tell them what changed and let them call
   \`action:"approve"\`. **Never approve on your own initiative.** Approving is
   how a real regression gets written into the baseline as normal.

A verdict comes back with every replay: PASS, PASS_WITH_WARNING, SURPRISE,
FAIL_PRODUCT, or FAIL_AUTOMATION. FAIL_AUTOMATION means the test broke, not the
product — say which one you are reporting.`;

export const TOOLS = [
  {
    name: 'browser_status',
    description:
      'Live session state: bridge connection, which tab is attached, its URL and title, current console-error and failed-request counts, and the other tabs available. CALL THIS FIRST in any browser task to orient yourself. Outside multi-tab mode, other tabs are listed by origin only — their titles and URLs are withheld on purpose. This is also the one tool that still answers while the user has pressed Stop, so use it to find out why everything else is failing.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },

  {
    name: 'browser_snapshot',
    description:
      'PRIMARY PERCEPTION TOOL. Returns the accessibility tree of the attached tab, with a [ref=eN] handle on every interactive element. Use these refs with browser_interact. Take a fresh snapshot after navigation or any significant DOM change.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: str('"a11y" (default) or "a11y+text" to also include all visible page text.', {
          enum: ['a11y', 'a11y+text'],
          default: 'a11y',
        }),
        maxNodes: num('Cap on emitted nodes. Default 900. Raise for very large pages.', { default: 900 }),
        tabId: num('Only in multi-tab mode. Defaults to the pinned tab.'),
      },
    },
    annotations: { readOnlyHint: true },
  },

  {
    name: 'browser_interact',
    description:
      'Perform a real user action using trusted input events (isTrusted === true). Pass a ref from browser_snapshot. Verify the outcome afterwards — do not assume the action worked.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: str('What to do.', {
          enum: ['click', 'double_click', 'right_click', 'hover', 'type', 'key', 'scroll', 'drag', 'select', 'upload'],
        }),
        ref: str('Element handle from browser_snapshot, e.g. "e12". Required for most actions.'),
        text: str('For action:"type" — the text to enter.'),
        clear: bool('For action:"type" — select-all and delete before typing.', false),
        fast: bool('For action:"type" — insert the whole string at once. Faster, but masked or key-filtered inputs may need the default per-character mode.', false),
        pressEnter: bool('For action:"type" — press Enter afterwards.', false),
        key: str('For action:"key" — a named key (Enter, Tab, Escape, ArrowDown, Home, PageDown, Space, F1-F12) or a single character. Digits and punctuation get their correct physical key code, so key-filtered inputs behave as they do for a human.'),
        modifiers: {
          type: 'array',
          description: 'Modifier keys held during the action, e.g. ["Control"] for Ctrl+click or Ctrl+S.',
          items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
        },
        repeat: num('For action:"key" — press this many times.', { default: 1 }),
        direction: str('For action:"scroll".', { enum: ['up', 'down', 'left', 'right'], default: 'down' }),
        amount: num('For action:"scroll" — pixels.', { default: 400 }),
        from: str('For action:"drag" — source ref.'),
        to: str('For action:"drag" — target ref.'),
        values: {
          description: 'For action:"select" — option value(s), label(s), or visible text.',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        selector: str('CSS selector, for action:"upload" when the file input is hidden and has no ref — which is the usual case on real sites. Try "input[type=file]".'),
        files: {
          description: 'For action:"upload" — absolute local file path(s). No native picker is opened. Pair with selector when the input is hidden behind a styled button.',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        x: num('Fallback X coordinate when no ref exists (canvas, custom widgets).'),
        y: num('Fallback Y coordinate.'),
        force: bool('Click even when another element covers the target. Use only after reading the obstruction error.', false),
        tabId: num('Only in multi-tab mode.'),
      },
    },
  },

  {
    name: 'browser_navigate',
    description:
      'Navigate, reload, move through history, or wait for a condition. Waiting is condition-based with a deadline — never sleep and hope.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('Default "goto".', { enum: ['goto', 'reload', 'back', 'forward', 'wait'], default: 'goto' }),
        url: str('For action:"goto".'),
        hard: bool('For action:"reload" — bypass the cache.', false),
        steps: num('For back/forward.', { default: 1 }),
        text: str('For action:"wait" — wait until this text appears in the page.'),
        selector: str('For action:"wait" — wait until this CSS selector matches.'),
        gone: bool('For action:"wait" — invert: wait until it DISAPPEARS. Useful for spinners.', false),
        idle: bool('For action:"wait" — wait until both the DOM is mutation-free for 500ms and no captured network request remains in flight.', false),
        waitUntil: str('Load condition for goto/reload.', {
          enum: ['load', 'domcontentloaded', 'idle'],
          default: 'load',
        }),
        timeoutMs: num('Deadline in milliseconds. Defaults to 30000 for goto/reload and 15000 for wait.'),
        tabId: num('Only in multi-tab mode.'),
      },
    },
  },

  {
    name: 'browser_inspect',
    description:
      'DevTools-panel inspection. what:"dom" = Elements, "styles" = Computed styles, "box" = layout geometry and visibility, "storage" = Application storage, "cookies" = Application cookies (includes HttpOnly), "frames" = the iframe tree.',
    inputSchema: {
      type: 'object',
      properties: {
        what: str('Which panel.', {
          enum: ['dom', 'styles', 'box', 'storage', 'cookies', 'frames'],
          default: 'dom',
        }),
        ref: str('Element handle from browser_snapshot.'),
        selector: str('CSS selector, as an alternative to ref.'),
        properties: {
          type: 'array',
          description: 'For what:"styles" — return only these CSS properties.',
          items: { type: 'string' },
        },
        all: bool('For what:"styles" — include every property, not just non-default ones.', false),
        depth: num('For what:"dom" with no ref/selector — how many levels of structure to show. Deeper subtrees collapse to a comment. Pass a ref or selector instead when you want one element in full.', { default: 3 }),
        kind: str('For what:"storage".', {
          enum: ['all', 'local', 'session', 'indexeddb', 'cache', 'serviceworker'],
          default: 'all',
        }),
        url: str('For what:"cookies" — override the URL whose cookies to read. Outside multi-tab mode this must be the attached tab\'s own origin: chrome.cookies can see every site the user is signed in to, so cross-origin reads are refused.'),
        limit: num('For what:"cookies" — max cookies to return.', { default: 40 }),
        tabId: num('Only in multi-tab mode.'),
      },
    },
    annotations: { readOnlyHint: true },
  },

  {
    name: 'browser_console',
    description:
      'Read buffered console output (log, warn, error, uncaught exceptions with stack frames) or evaluate JavaScript in the page. Messages are captured continuously, so this returns everything since the tab was attached.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('"read" (default) or "evaluate".', { enum: ['read', 'evaluate'], default: 'read' }),
        expression: str('For action:"evaluate" — JavaScript to run in the page. Async expressions are awaited.'),
        level: {
          description: 'Filter by level, e.g. "error" or ["error","warning"].',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        contains: str('Only messages containing this substring.'),
        since: num('Only messages with seq greater than this. Use lastSeq from a previous call to poll for new output.'),
        limit: num('Max entries.', { default: 100 }),
        clear: bool('Empty the buffer instead of reading. Useful before reproducing a bug.', false),
        tabId: num('Only in multi-tab mode.'),
      },
    },
  },

  {
    name: 'browser_network',
    description:
      'List network requests, or pass a requestId to get one request in full — headers, timing, POST body, and the response body. Capture begins when the tab is ATTACHED, not when the page loaded — if this returns 0 requests on an already-open page, reload it first (browser_navigate action:"reload") and read again.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str(
          'Default "list". \n\nRECORD AND FREEZE: "record_har" captures the tab\'s traffic as a HAR. "pin" then serves every matching request from that HAR, so the backend is frozen and any remaining difference in a run is the client\'s doing — this is how you tell a UI regression from a server one. "unpin" restores live traffic; "pin_status" reports how many requests were served, passed through, or blocked.\n\nBREAK IT ON PURPOSE: "intercept" takes `rules` and makes chosen requests fail, stall or return a body you pick — the way to test what the UI does on a 500, a 429 or a timeout without waiting for one to happen. "intercept_status" shows each rule and how often it fired; "clear_intercept" removes them. Rules are applied BEFORE a pinned HAR, so a flow can be pinned for determinism and still have one endpoint forced to fail.\n\nDOWNLOADS: "watch_downloads" must be called BEFORE the click that starts a download — a download cannot be observed after the fact. Then "wait_download" blocks until one completes and returns its filename and byte count, and "downloads" lists everything seen. This is what proves an export produced a real file rather than an empty one, which a 200 response cannot tell you. "stop_downloads" ends the watch.',
          {
            enum: [
              'list', 'record_har', 'pin', 'unpin', 'pin_status',
              'intercept', 'intercept_status', 'clear_intercept',
              'watch_downloads', 'downloads', 'wait_download', 'stop_downloads',
            ],
            default: 'list',
          },
        ),
        har: { type: 'object', description: 'For action:"pin" — a HAR from action:"record_har" or format:"har".' },
        rules: {
          type: 'array',
          description:
            'For action:"intercept". Each rule needs "match" (a substring of the URL) and one outcome: ' +
            '"status" (+ optional "body" and "headers") to answer it yourself, "abort" to fail it at the ' +
            'network level ("TimedOut", "ConnectionRefused", "Failed", …), or "delayMs" alone to just make ' +
            'it slow. Optional "method" narrows it to one verb, "times" makes it fire only N times — which ' +
            'is how "the first save fails, the retry succeeds" is written — and "label" names it in the ' +
            'response header the rule adds, so an injected 500 is never mistaken for a real one. ' +
            'Example: [{ "match": "/api/farm", "method": "POST", "status": 500, "times": 1, "label": "first save fails" }]',
          items: { type: 'object' },
        },
        contains: {
          type: 'string',
          description:
            'For action:"wait_download" — wait for a download whose filename or URL contains this. ' +
            'Omit to wait for any download. Matching on what the flow asked for is safer than an index, ' +
            'because a page may fetch other things while the export is being built.',
        },
        timeoutMs: {
          type: 'number',
          description: 'For action:"wait_download" — how long to wait. Default 30000.',
        },
        filter: {
          type: 'string',
          description:
            'For action:"pin" and action:"intercept" — only intercept URLs containing this. Narrowing the ' +
            'pattern keeps every unrelated request off the interception path, which matters on a page that ' +
            'loads hundreds of assets.',
        },
        strict: bool('For action:"pin" — fail requests the HAR does not contain instead of letting them through. The honest setting for a test that claims to be hermetic.', false),
        requestId: str('Fetch full detail including the response body for this request.'),
        filter: str('Substring match on the URL.'),
        method: str('Filter by HTTP method.'),
        status: {
          description: '"failed" (network error or 4xx/5xx), "pending", or an exact status code.',
          anyOf: [{ type: 'string' }, { type: 'number' }],
        },
        includeBody: bool('When fetching one request, include the response body.', true),
        format: str('Return a HAR 1.2 document instead of the compact request list.', { enum: ['list', 'har'], default: 'list' }),
        limit: num('Max requests to list.', { default: 50 }),
        clear: bool('Empty the buffer instead of reading.', false),
        tabId: num('Only in multi-tab mode.'),
      },
    },
    annotations: { readOnlyHint: true },
  },

  {
    name: 'browser_diagnose',
    description:
      'FASTEST PATH TO "what is wrong with this page". health correlates actionable defects; performance records a trace and may reload; vitals measures Core Web Vitals and long tasks; memory samples heap, DOM nodes, documents and listeners for leak signals.',
    inputSchema: {
      type: 'object',
      properties: {
        what: str('Which analysis.', { enum: ['health', 'performance', 'vitals', 'memory'], default: 'health' }),
        durationMs: num('For what:"performance" — how long to record.', { default: 4000 }),
        reload: bool('For what:"performance" — reload the page so the trace covers page load.', false),
        samples: num('For what:"memory" — 2..10 metric samples.', { default: 3 }),
        intervalMs: num('For what:"memory" — delay between samples.', { default: 500 }),
        tabId: num('Only in multi-tab mode.'),
      },
    },
  },

  {
    name: 'browser_screenshot',
    description:
      'Capture an image. Use SPARINGLY — browser_snapshot is cheaper and more precise for anything structural. Reach for this only for visual questions: rendering, spacing, canvas content, or confirming what the user is describing. Oversized captures are scaled down, never cropped, so a fullpage shot of a horizontally overflowing page still shows the overflow; the result reports the `scale` applied.',
    inputSchema: {
      type: 'object',
      properties: {
        area: str('"viewport" (default), "fullpage", or "element" (needs ref).', {
          enum: ['viewport', 'fullpage', 'element'],
          default: 'viewport',
        }),
        ref: str('For area:"element".'),
        format: str('Image format.', { enum: ['jpeg', 'png'], default: 'jpeg' }),
        quality: num('JPEG quality 0-100.', { default: 70 }),
        tabId: num('Only in multi-tab mode.'),
      },
    },
    annotations: { readOnlyHint: true },
  },

  {
    name: 'browser_emulate',
    description:
      'Emulate a device, viewport, network condition, CPU throttle, colour scheme, locale, or timezone. Emulation lasts until reset or until the debugger detaches. Essential for responsive and slow-network testing.',
    inputSchema: {
      type: 'object',
      properties: {
        device: str('Preset device.', { enum: ['iphone-15', 'pixel-8', 'ipad', 'laptop', 'desktop'] }),
        width: num('Explicit viewport width.'),
        height: num('Explicit viewport height.'),
        network: str('Network throttling preset.', { enum: ['slow-3g', 'fast-3g', '4g', 'offline', 'none'] }),
        cpuThrottle: num('CPU slowdown multiplier, e.g. 4 for a mid-range phone.'),
        colorScheme: str('Emulate prefers-color-scheme.', { enum: ['light', 'dark'] }),
        locale: str('BCP-47 locale, e.g. "fa-IR".'),
        timezone: str('IANA timezone, e.g. "Asia/Tehran".'),
        reloadIfNeeded: bool('For mobile devices — reload once only if Chromium keeps the old desktop layout viewport.', true),
        reset: bool('Clear all emulation overrides.', false),
        tabId: num('Only in multi-tab mode.'),
      },
    },
  },

  {
    name: 'browser_dialog',
    description:
      'Accept or dismiss a JavaScript dialog (alert, confirm, prompt, beforeunload). An open dialog blocks the page, so every other tool will hang until this is called.',
    inputSchema: {
      type: 'object',
      properties: {
        accept: bool('Accept (OK) or dismiss (Cancel).', true),
        promptText: str('Text to enter for a prompt() dialog.'),
        tabId: num('Only in multi-tab mode.'),
      },
    },
  },

  {
    name: 'browser_recording',
    description:
      'Recorded user flows, replayable as tests WITH MEMORY. A QA presses Record in the side panel, works through a flow, and stops; the result is a list of steps that can be replayed later. Each element is stored with several independent locators (test id, role+accessible name, label, text, CSS, XPath) so a step still finds its element after a redeploy. Replay reports WHICH locator matched — a step matching only by "xpath" still passes but is one refactor from breaking, and comes back as a warning. When a step fails you get what it looked for, what it tried, and the closest thing on the page now. Beyond the steps, every replay compares what the flow ACTUALLY did against its approved known world and reports anything new or newly missing as a surprise — see the Regression memory section of the instructions. "export_spec"/"import_spec" move a flow in and out as a canonical, Git-diffable G9 FlowSpec.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('What to do. "list" and "get" work with no tab attached.', {
          enum: [
            'list', 'get', 'status', 'start', 'stop', 'replay', 'assert', 'update', 'delete',
            'export', 'import', 'export_test', 'export_spec', 'import_spec',
            'calibrate', 'approve', 'known_world', 'signature', 'suggest',
          ],
          default: 'list',
        }),
        id: str('Recording id, for get/replay/assert/update/delete/export_test.'),
        atStep: {
          type: 'number',
          description:
            'For action:"assert" — insert the check AFTER this step number (1-based, the numbers ' +
            'action:"stop" prints in its outline) instead of appending at the end. A long flow needs ' +
            'this: "search, assert it filtered, clear, assert it came back" is three checks at three ' +
            'moments, and appending them all describes the final moment three times — which looks ' +
            'thorough and tests less. Out of range is refused, never clamped.',
        },
        name: str('For action:"start" — a name for the recording.'),
        timing: str(
          'For action:"replay". "recorded" (DEFAULT) reproduces the pace the person worked at — a ten-second session replayed in 200ms never lets a debounce fire or an animation finish, so it is not the same test. "adaptive" waits only as long as each step needs. "fast" barely waits. Every mode gates each step on the page being loaded and the element being visible, enabled, and no longer moving — the recorded gap is a budget for that wait, never a blind sleep.',
          { enum: ['recorded', 'adaptive', 'fast'], default: 'recorded' },
        ),
        dryRun: bool('For action:"replay" — resolve every element and change nothing. The cheapest way to find out whether a recording has rotted.', false),
        stopOnFailure: bool('For action:"replay" — stop at the first failing step.', true),
        variables: { type: 'object', description: 'For replay — data values substituted into {{name}} placeholders.' },
        signature: str(
          'For action:"replay" — how much of the run\'s own behaviour to record for the surprise detector. "lite" (default) captures network and console for every step and the UI shape at assertions and the final step. "full" captures the UI shape at every step and is what calibration uses. "off" skips it.',
          { enum: ['off', 'lite', 'full'], default: 'lite' },
        ),
        compare: bool('For action:"replay" — compare this run against the approved known world and report surprises. Turn it off only when deliberately producing a reference run.', true),
        seedKnownWorld: bool('For action:"replay" — if this flow has no known world yet, create one from this run. Only ever seeds; it can never overwrite an approved one.', false),
        by: str('For action:"approve" — who approved it. Recorded in the known world.'),
        note: str('For action:"approve" — why. Recorded in the known world.'),
        spec: { type: 'object', description: 'For action:"import_spec" — a G9 FlowSpec document.' },
        assertion: str(
          'For action:"assert". "aria" stores a SEMANTIC baseline (roles, names, states) and is the one to prefer for regression: it survives restyling and copy edits, and fails when a button becomes a div or a control disappears. "screenshot" defaults to comparing layout structure rather than pixels.',
          { enum: ['url', 'text', 'visible', 'value', 'state', 'network', 'console', 'a11y', 'screenshot', 'aria'] },
        ),
        visualMode: str('For a screenshot assertion. "layout" (default) compares structure and ignores colour, fonts and copy. "strict" compares luminance and notices everything. "off" records the baseline without judging it.', { enum: ['off', 'layout', 'strict'], default: 'layout' }),
        masks: {
          type: 'array',
          description: 'For a screenshot assertion — normalised 0..1 rectangles {x,y,w,h} excluded from comparison. Prefer action:"calibrate", which finds volatile regions without anybody guessing.',
          items: { type: 'object' },
        },
        maxNodes: num('For an aria assertion — how much of the semantic tree to baseline.', { default: 400 }),
        expected: { description: 'Expected string, number, boolean, or value for an assertion.' },
        operator: str('Text comparison.', { enum: ['exact', 'contains', 'absent', 'matches'] }),
        contains: str('Substring used by text, network, and console assertions.'),
        absent: bool('Assert that matching text or console entries are absent.', false),
        state: str('Element state.', { enum: ['checked', 'selected', 'disabled', 'enabled', 'expanded', 'pressed', 'focused', 'readonly'] }),
        status: { description: 'Network assertion status filter.', anyOf: [{ type: 'string' }, { type: 'number' }] },
        method: str('Network assertion HTTP method.'),
        minCount: num('Minimum matching network/console entries.'),
        maxCount: num('Maximum matching network/console entries.'),
        maxViolations: num('Maximum actionable accessibility findings.', { default: 0 }),
        threshold: num('Screenshot baseline difference threshold 0..1.', { default: 0.08 }),
        level: { description: 'Console assertion level(s).', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        ref: str('Element ref for visible/value/state assertions.'),
        selector: str('CSS alternative to ref for element assertions.'),
        suite: str('Suite name for action:"update".'),
        folder: str('Folder path for action:"update".'),
        tags: { type: 'array', items: { type: 'string' }, description: 'Recording tags for action:"update".' },
        environment: { type: 'object', description: 'Named environment profile with an optional variables object.' },
        parameters: { type: 'object', description: 'Data parameter defaults or descriptors.' },
        includeAttachments: bool('For action:"export" — inline attachment bytes.', true),
        mode: str('For action:"import".', { enum: ['merge', 'replace'], default: 'merge' }),
        bundle: { type: 'object', description: 'For action:"import" — a bundle from action:"export".' },
        tabId: num('Only in multi-tab mode.'),
      },
    },
  },

  {
    name: 'browser_issue',
    description:
      'Defects captured in the browser, with the context a developer always has to ask for afterwards: the URL, the page before it, the console tail, the failed requests, the viewport — all recorded at the moment the bug was visible rather than reconstructed later. Attachments (screenshots, tab video, arbitrary files) belong to an issue and travel with it. Read these to file tickets: you have the full body and context, so write the ticket from them rather than asking the user to repeat what is already here.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('What to do. list/get/update/delete/attach/attachment work with no tab attached; page evidence and video actions need one.', {
          enum: ['list', 'get', 'create', 'update', 'delete', 'screenshot', 'attach', 'attachment', 'video_start', 'video_stop', 'video_status'],
          default: 'list',
        }),
        id: str('Issue id.'),
        title: str('For create/update.'),
        body: str('For create/update — what happened, and what was expected.'),
        severity: str('For create/update.', { enum: ['blocker', 'major', 'normal', 'minor'], default: 'normal' }),
        status: str('For update.', { enum: ['open', 'filed', 'closed'] }),
        tags: { type: 'array', description: 'Free-form labels.', items: { type: 'string' } },
        filedAs: str('For update — the tracker key once filed, e.g. "PROJ-1234". Record it so the issue is not filed twice.'),
        withScreenshot: bool('For action:"create" — capture the viewport now.', true),
        area: str('For action:"screenshot".', { enum: ['viewport', 'fullpage', 'element'], default: 'viewport' }),
        ref: str('For action:"screenshot" with area:"element".'),
        note: str('A caption for the attachment.'),
        name: str('For action:"attach" — file name.'),
        mime: str('For action:"attach" — content type.'),
        dataBase64: str('For action:"attach" — the file bytes, base64.'),
        attachmentId: str('For action:"attachment" — which attachment to read.'),
        includeBytes: bool('For action:"attachment" — include the bytes, not just metadata.', true),
        quality: num('For video_start — JPEG frame quality 0..100.', { default: 60, minimum: 0, maximum: 100 }),
        everyNthFrame: num('For video_start — capture every Nth screencast frame.', { default: 2, minimum: 1 }),
        tabId: num('Only in multi-tab mode.'),
      },
    },
  },

  {
    name: 'browser_tabs',
    description:
      'List, open, close, focus, or pin tabs, and manage NAMED SESSIONS for multi-tab flows. Tab visibility follows the mode: in workspace mode every tab inside the project allowlist is shown in full and drivable, everything else by ORIGIN only; in pinned/follow mode only the tab you are driving is shown in full. action:"list" and action:"sessions" are always allowed; the rest need multi-tab mode, or workspace mode with the target URL inside the allowlist. Only the user changes the mode, from the side panel. SESSIONS: action:"session" with a name and a url opens (or re-points) a named tab; with a name and a tabId it names one already open. Pass that name as `session` to any other tool to act on it — that is how a two-user scenario is expressed. NOTE: a browser only delivers input to the tab it is SHOWING, so a session in the background can be read (snapshot, console, network, screenshot) but not clicked or typed into; focus it first.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('What to do.', {
          enum: ['list', 'open', 'close', 'focus', 'pin', 'unpin', 'wait', 'session', 'sessions', 'end_session'],
          default: 'list',
        }),
        url: str('For action:"open"/"session", or a URL substring for action:"wait".'),
        tabId: num('For close/focus/pin, or for action:"session" to name a tab already open.'),
        name: str('For action:"session"/"end_session" — the session name, e.g. "buyer".'),
        focus: bool('For action:"open"/"session" — bring the new tab to the front.', false),
        pin: bool('For action:"open" — attach and pin the new tab immediately.', false),
        title: str('For action:"wait" — title substring for a popup/new tab.'),
        openerTabId: num('For action:"wait" — require this opener tab id.'),
        timeoutMs: num('For action:"wait" — deadline.', { default: 15000 }),
      },
    },
  },
];

/**
 * `session` is accepted by every tool that takes a tab, added here in one pass.
 *
 * Writing it into fourteen schemas by hand guarantees that the fifteenth tool
 * is added without it, and the failure is silent: the argument is accepted by
 * the router, ignored by the schema, and the agent quietly acts on the wrong
 * tab. Deriving it from the same condition the router uses — "does this tool
 * take a tabId" — keeps the two in step by construction.
 */
for (const tool of TOOLS) {
  const properties = tool.inputSchema?.properties;
  if (!properties || !('tabId' in properties) || tool.name === 'browser_tabs') continue;
  properties.session = str(
    'Act on a named session instead of the default target. Open one with browser_tabs action:"session". ' +
      'Background sessions can be read but not clicked — focus the tab first.',
  );
}
