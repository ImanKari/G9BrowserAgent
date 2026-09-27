/**
 * Tool schemas and the agent-facing instructions (v2).
 *
 * Design note, unchanged from v1: fifteen grouped tools rather than fifty, each
 * with an `action` or `what` discriminator. Tool definitions are re-sent on
 * every request, so a wide flat surface costs thousands of tokens of context
 * before the agent has done anything (AIGuide §4.4).
 *
 * Descriptions are written for the agent, not for a human reading docs: when to
 * reach for a tool and what the common mistake is. Every sentence must describe
 * behaviour that exists (EXT-17) — a description that promises an argument
 * nobody implements is a bug that reads like documentation.
 *
 * v2 changes: `browser_engine` is new (launched browsers); `browser_tabs` gains
 * attach/claim/release/popout/handoff and loses pin/unpin; every tab tool takes
 * `tabId` (a G9BrowserAgent handle, shared by all engines) or `session`; modes and the
 * workspace allowlist are gone; input is humanized and reports delivery.
 */

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const bool = (description, def) => ({ type: 'boolean', description, ...(def !== undefined ? { default: def } : {}) });

const TAB_ID = num('Which tab: a G9BrowserAgent tab handle from browser_tabs action:"list" (shared by every engine). Default: your current tab.');
const HUMANIZE = str(
  'Input style for this call: "off" (direct, instant events — v1 behaviour), "human" (curved pointer paths, ' +
    'human timing, wheel notches, per-key rhythm), "stealth" (human, plus nothing that needs the page\'s JS runtime), ' +
    'or the name of a calibrated profile. Default: the tab\'s engine/context setting (in the user\'s own browser, the ' +
    'side panel\'s Input). The tab\'s stealth level is a floor: you can ask for stricter input, never looser (a ' +
    'stealth tab always gets stealth input; the result then reports humanize.raisedFrom). On a launched engine that ' +
    'is the context\'s stealth setting; in the user\'s own browser only the panel\'s Stealth is one, and its Human ' +
    'and Direct are just defaults.',
);
const SEED = {
  description:
    'Seed for the humanize random generator. The same seed reproduces the same motion FROM THE SAME POINTER POSITION and ' +
    'viewport: every path starts where the last action left the pointer on that tab. A replay homes the pointer first and ' +
    'reports it as pointerStart, so replaying with the reported humanizeSeed does reproduce the run.',
  anyOf: [{ type: 'number' }, { type: 'string' }],
};

export const INSTRUCTIONS = `You are connected to G9BrowserAgent: real browsers you can drive, through a local daemon.

## Two engines, one set of tools
- **Engine 1 — the extension** runs inside the user's OWN browser (their real
  cookies, sessions and logins). Use it to explore, author and debug with them.
- **Engine 2 — launched browsers** are real Chrome/Edge processes G9BrowserAgent starts
  itself, headless by default, with their own profiles. Use them for long or
  unattended runs, parallel work, and work that must keep going while the user
  minimises or covers their windows — a HEADLESS one has no window of its own
  (a locked screen has not been measured). \`browser_engine\` manages them.

Every tool works the same on both. Tabs are addressed by a **G9BrowserAgent tab handle**
(\`tabId\` from \`browser_tabs action:"list"\`), shared by all engines, or by a
**session** name. Without either, a call acts on YOUR current tab.

## Start here
Call \`browser_status\` first: your current tab, its page health, which engines
exist, which agents are connected, what you own, whether Stop is pressed.
No tab yet? \`browser_tabs action:"open" url:"…"\` (opens in the user's browser if
the extension is connected, otherwise launches a headless browser), or
\`browser_tabs action:"attach"\` to take the tab the user is looking at.
In the user's own browser \`open\` creates a BACKGROUND tab: readable (snapshot,
console, network, viewport screenshot) but not clickable, because a browser
delivers input only to the tab it is showing. Pass \`focus:true\` when you will
act on it, or \`action:"focus"\` before the first click. A launched engine gives
every tab its own window, so nothing is needed there.

## Seeing the page
\`browser_snapshot\` returns the accessibility tree with a [ref=eN] handle on every
interactive element — your primary sense: cheap, semantic, stable. Use
\`browser_screenshot\` only when the tree cannot answer (canvas, layout, visual
judgement). Refs belong to the TAB, not to you, and a ref keeps naming the
element the snapshot that returned it showed: numbering continues across
snapshots of a page (e1…e30, then e31…), and each caller's last four snapshots of
that page stay usable, so another agent's snapshot never renumbers yours. A ref from an
older snapshot, from another page, or for an element the page has since removed
is refused — take a fresh snapshot. After navigation or a big DOM change, take
one anyway: a page that re-renders replaces the elements you saw.

## Acting
\`browser_interact\` sends real, trusted browser input (isTrusted === true) —
by default with human-like pointer paths, timing and typing. Always pass a ref;
coordinates are a fallback for canvas widgets. **A dispatched action is not a
delivered action**: every result carries \`delivery\` —
"delivered" or "indeterminate". "not-delivered" (nothing reached the page),
"missed" (it reached the page but a different element — the error names which)
and "partial" (the tab became hidden part-way: some of the input arrived) are
errors whose text starts with a tag such as \`[delivery: missed; hit <div#x>]\`.
Treat anything but
"delivered" as unproven, and verify the effect (snapshot, \`browser_navigate
action:"wait"\`, console) before relying on it. Never blindly repeat a
state-changing action whose outcome is unknown — check first.

## Sharing: ownership, not modes
There are no modes and no allowlists: attach means full access, and every tab's
title and URL is visible. Other agents may be connected to the same browsers.
- Your first state-changing call on a tab CLAIMS it. A state-changing call on a
  tab another agent owns is refused with that agent's name. Reads (snapshot,
  console/network reads, inspect, \`browser_screenshot area:"viewport"\`) are
  always allowed. \`area:"element"\` and \`area:"fullpage"\` are NOT reads: they
  scroll the page to the element (with the wheel, at the human levels) or resize
  the viewport, so they claim the tab and queue like any action.
- \`browser_tabs action:"release"\` when you are done with a tab. Take one over
  only when the user asks: \`action:"claim" force:true\`.
- State-changing calls on one tab run one at a time, yours included; reads run
  at once. A call that hits its deadline is asked to stop and the tab's queue is
  held until it has — but if it does not stop in time, the error says so: it may
  still be running, and the next thing you send that tab could land in the middle
  of it. Take a \`browser_snapshot\` first when you see that message.

## Stop
The user can press Stop (side panel or desktop app), for everyone or just for
you. Every tool except \`browser_status\` then fails with that reason. You cannot
lift it — only the user can. Stop working and tell them.

## Background work: handoff and popout
- \`browser_tabs action:"handoff"\` moves a tab from the user's browser into a
  launched browser: cookies and local/session storage travel, the PAGE RELOADS
  there, and in-memory page state, IndexedDB and service-worker state do not
  travel. The result is a new tab handle; continue there. The user's own tab is
  untouched.
- \`browser_tabs action:"popout"\` (extension only) moves a tab into its own
  window without reloading it, so the user can keep working elsewhere. It is
  created unfocused (pass \`focus:true\` to bring it to the front) and the result
  says whether the page is \`visible\`. That window must not be minimised, and on
  Windows a window that is COMPLETELY covered also stops rendering unless the
  WindowOcclusionEnabled policy is off; when \`visible\` is false, "focus" it.
- A HEADLESS launched engine has no window, so minimising or covering the user's
  windows does not affect it (a locked session has not been measured). A HEADED
  one (\`launch headless:false\`, \`warm\`, or the headless:false setting) must not
  be minimised: measured, a click then takes about 28 s and a screenshot 33–46 s.
  \`browser_status\` warns when that is the case.

## Humanize and stealth
Input defaults to "human". \`humanize:"off"\` gives instant direct events (fast
but obviously scripted). \`stealth\` has two halves. The ENVIRONMENT half belongs
to the browser and comes from \`browser_engine action:"launch" stealth:"stealth"\`:
only that clears \`navigator.webdriver\` (the debugging pipe turns Chromium's
automation flag on) and leaves Widevine in place. A CONTEXT's stealth adds the
rest — the page's JS runtime domain is never enabled, so \`browser_console\`
cannot read page console output there and says so, and input keeps the stealth
floor; in an engine launched below stealth such a context still reports
\`navigator.webdriver\` true, and its result says so. A tab's stealth level is a floor for
input: \`humanize\` can make a call stricter, never looser — on a stealth tab
every action uses stealth input, and the result's \`humanize.raisedFrom\` says
when it was raised. In the user's own browser the side panel's Input setting
is the default level; only its Stealth setting is also a floor, so with the
panel at Human \`humanize:"off"\` still gives direct input. G9BrowserAgent never overrides the
user agent on its own — \`browser_emulate\` device presets do, and at stealth they
are refused. Pass a \`seed\` to reproduce a run's motion from the same pointer
position (a replay homes the pointer and reports \`pointerStart\`).

## Debugging
\`browser_diagnose\` answers "what is wrong with this page" in one call. Capture
starts when a tab is attached, not when it loaded: if \`browser_network\` shows
nothing on a page that was already open, \`browser_navigate action:"reload"\`
and read again — say so first, a reload surprises people.

## Regression memory — the part that is not obvious
A recording does not only replay steps; it remembers what the flow NORMALLY
does. Every replay builds a signature (requests, console, the semantic tree,
step timings) and compares it with the flow's approved **known world**.
Anything outside it comes back as a *surprise*, in both directions: **new**
(an error, request, dialog or control never seen before) and **missing**
(something that happened on every previous run and not now — the quiet failures).
1. Record and assert as normal.
2. Right after stopping, \`action:"suggest"\` proposes assertions from what was
   observed. It adds NOTHING; you and the user choose, then \`action:"assert"\`.
   A flow with no assertion is a macro, not a test.
3. \`action:"calibrate"\` once per flow: two runs on one build, differences marked volatile.
4. Replay with \`seedKnownWorld:true\` the first time.
5. After a run whose surprises are all legitimate, the USER decides and calls
   \`action:"approve"\`. **Never approve on your own initiative** — that is how a
   real regression becomes the baseline.
Verdicts: PASS, PASS_WITH_WARNING, SURPRISE, FAIL_PRODUCT, FAIL_AUTOMATION.
FAIL_AUTOMATION means the test broke, not the product — say which you report.
\`browser_recording action:"replay" engine:"launched"\` runs a flow in a launched
browser (the recording is copied there if it only exists in the user's browser).

## Boundaries that remain
Browser-internal pages (chrome://, edge://, the web stores, other extensions)
cannot be controlled — a browser rule, not a setting. Native OS dialogs (print,
basic auth, file picker) are outside the page; upload files with
\`browser_interact action:"upload"\`.`;

export const TOOLS = [
  {
    name: 'browser_status',
    description:
      'Orientation — CALL THIS FIRST. Your current tab (URL, title, console-error and failed-request counts), the daemon, every engine (the extension in the user\'s browser, launched browsers), connected agents and what each owns, your own claims, sessions, whether Stop is pressed (globally or for you), and capabilities. The one tool that still answers while Stop is pressed — use it to learn why everything else fails.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: num('Report on this tab instead of your current one.'),
      },
    },
    annotations: { readOnlyHint: true },
  },

  {
    name: 'browser_engine',
    description:
      'Launched browsers (Engine 2): real Chrome, Edge or Chrome for Testing started and driven by G9BrowserAgent, headless by default — a headless one is unaffected by the user minimising or covering their windows (a locked screen has not been measured); a headed one must never be minimised. "launch" starts one with a named profile; "list" shows every engine; "stop" closes a launched one (refused while another agent owns a tab in it, or holds it with "acquire", unless force:true); "context" creates an isolated context (own cookies, optional proxy/locale/timezone/stealth — note that navigator.webdriver follows the ENGINE\'s launch level, not the context\'s); "acquire"/"release" hold an engine across your tabs so a long run is not stopped by another agent finishing first (the daemon stops an engine launched with lease+stopWhenReleased once the last holder releases it); "versions" lists installed browsers and the pinned Chrome for Testing (download:true fetches it); "warm" opens a profile HEADED so the user can sign in once. You rarely need launch: browser_tabs action:"open" launches the default engine on demand.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('What to do.', { enum: ['launch', 'list', 'stop', 'context', 'versions', 'warm', 'acquire', 'release'], default: 'list' }),
        lease: bool('For launch: hold this engine for your session (release it with action:"release"; a disconnect releases it too).', false),
        stopWhenReleased: bool('For launch with lease:true: the daemon stops this engine once every holder has released it and no agent owns a tab in it.', false),
        browser: str('For launch/warm: which browser. "auto" = pinned Chrome for Testing if installed, else Edge, else Chrome.', { enum: ['auto', 'edge', 'chrome', 'cft'] }),
        headless: bool('For launch: run with no window (default from settings, normally true). Headed needs a desktop that nobody minimises.'),
        profile: str('For launch/warm: profile name under the G9BrowserAgent data folder (default "automation"). A profile holds cookies and history between runs; one browser at a time per profile.'),
        stealth: str('For launch/context: "off", "human" or "stealth". Stealth never enables the page JS runtime domain (no page console capture) and adds no automation switches.', { enum: ['off', 'human', 'stealth'] }),
        humanize: HUMANIZE,
        proxy: str('For launch/context: proxy server, e.g. "http://proxy:8080".'),
        proxyBypass: str('For context: proxy bypass list, e.g. "localhost;*.internal".'),
        locale: str('For launch/context: BCP-47 locale, e.g. "fa-IR". Keep locale, timezone and language consistent.'),
        timezone: str('For launch/context: IANA timezone, e.g. "Asia/Tehran".'),
        windowSize: {
          type: 'object',
          description: 'For launch: window size (default 1920x1080; headless defaults to 800x600, which is itself a tell).',
          properties: { width: { type: 'number' }, height: { type: 'number' } },
        },
        name: str('For launch: a label shown in lists.'),
        engineId: str('For stop/context/acquire/release: which launched engine (from action:"list"). context defaults to the first running one, launching the default engine if none runs.'),
        downloadPath: str('For context: folder downloads land in (default: the G9BrowserAgent data folder).'),
        download: bool('For versions: download and verify the pinned Chrome for Testing if it is not installed.', false),
        version: str('For versions with download:true: a specific Chrome for Testing version instead of the pinned one.'),
        url: str('For warm: the page to open for the one-time sign-in.'),
        force: bool('For stop: close the engine even though other agents own tabs in it. Only when the user asked; it is logged.', false),
      },
    },
  },

  {
    name: 'browser_tabs',
    description:
      'Tabs across ALL engines, with full titles and URLs. "list" every tab (engine, owner, session); "open" a URL (in the user\'s browser when the extension is connected, else a launched browser — or choose with engine) and make it your current tab (in the user\'s browser it opens in the BACKGROUND: readable, not clickable, unless focus:true; a launched engine gives it its own window); "close"/"focus" a tab; "attach" the tab the user is on (extension) and make it current; "claim"/"release" ownership (force:true takes over — only when the user asks); "popout" an extension tab into its own window without reloading it (never minimise that window); "handoff" an extension tab into a launched browser (cookies + local/session storage travel, the page reloads, in-memory state/IndexedDB/service workers do not); "session" names a tab (with url: opens or re-points it); "sessions"/"end_session" list or forget names (the tab stays open); "wait" for a popup/new tab by url/title/opener; "watch" opens a LIVE VIEW of a tab for the user (frames and your cursor, view only) — the way to let them see a headless launched tab, which has no window: the watch window opens in their browser without taking the keyboard (focus:true brings it to the front), on:false closes it. NOTE (the user\'s browser): a browser only delivers input to the tab it is SHOWING, so a background tab or session can be read (snapshot, console, network, screenshot) but not clicked or typed into — "focus" it first, or "popout"/"handoff" it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('What to do.', {
          enum: ['list', 'open', 'close', 'focus', 'attach', 'claim', 'release', 'popout', 'handoff', 'session', 'sessions', 'end_session', 'wait', 'watch'],
          default: 'list',
        }),
        on: bool('For watch: false closes the live view again.', true),
        url: str('For open/session: the URL. For wait: a URL substring.'),
        tabId: num('For close/focus/attach/claim/release/popout/handoff/watch, or session (name a tab already open). A G9BrowserAgent handle. watch without one: your current tab.'),
        session: str('Instead of tabId: a session name.'),
        name: str('For session/end_session: the session name, e.g. "buyer". For open: also name the new tab.'),
        engine: str('For open/session/attach: "extension", "launched", or an engineId from browser_engine. For handoff: the launched engine to receive the tab. Default for open: the extension if connected, else a launched browser (launched on demand).'),
        context: str('For open/handoff: a contextId from browser_engine action:"context" (launched engines only). Handoff defaults to a fresh isolated context.'),
        focus: bool('For open/session: bring the tab to the front in its window. For popout/watch: create the new window in front and focused (default: unfocused, so the user keeps the keyboard).', false),
        force: bool('For claim: take the tab over from another agent. Only when the user asked for it; it is logged.', false),
        includeStorage: bool('For handoff: also carry localStorage/sessionStorage of the page\'s origin.', true),
        launch: bool('For handoff: launch the default engine if none runs.', true),
        matchViewport: bool('For handoff: give the new tab the same viewport size as the original.', false),
        width: num('For popout: window width.'),
        height: num('For popout: window height.'),
        left: num('For popout: window left position.'),
        top: num('For popout: window top position.'),
        title: str('For wait: title substring of the popup/new tab.'),
        openerTabId: num('For wait: require this opener tab (a G9BrowserAgent handle).'),
        timeoutMs: num('For wait: deadline.', { default: 15000 }),
      },
    },
  },

  {
    name: 'browser_snapshot',
    description:
      'PRIMARY PERCEPTION TOOL. The accessibility tree of the tab, with a [ref=eN] handle on every interactive element; pass those refs to browser_interact. Take a fresh snapshot after navigation or any significant DOM change.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: str('"a11y" (default) or "a11y+text" to also include all visible page text.', { enum: ['a11y', 'a11y+text'], default: 'a11y' }),
        maxNodes: num('Cap on emitted nodes. Default 900. Raise for very large pages.', { default: 900 }),
        tabId: TAB_ID,
      },
    },
    annotations: { readOnlyHint: true },
  },

  {
    name: 'browser_interact',
    description:
      'Real user input: trusted browser events (isTrusted === true), human-like by default (curved pointer paths, human timing, wheel notches, per-key typing with rare corrected typos; never in password fields). Pass a ref from browser_snapshot. The result reports delivery ("delivered" | "indeterminate"; "not-delivered", "missed" — the input reached a different element than the ref — and "partial" — the tab became hidden part-way — are errors whose text starts with a [delivery: …] tag and names the cause) and the pointer position — anything but "delivered" is unproven: verify the effect before relying on it, and never blindly repeat a state-changing action.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: str('What to do.', {
          enum: ['click', 'double_click', 'right_click', 'hover', 'type', 'key', 'scroll', 'drag', 'select', 'upload'],
        }),
        ref: str('Element handle from browser_snapshot, e.g. "e12". Required for most actions.'),
        text: str('For action:"type" — the text to enter.'),
        clear: bool('For action:"type" — empty the field first (verified).', false),
        fast: bool('For action:"type" — insert the whole string at once. Not human; masked or key-filtered inputs may need the default per-character typing.', false),
        typos: bool('For action:"type" — allow the humanized typist\'s occasional corrected typo (default: the profile\'s rate; never in password fields). false = no typos.'),
        pressEnter: bool('For action:"type" — press Enter afterwards.', false),
        key: str('For action:"key" — a named key (Enter, Tab, Escape, ArrowDown, Home, PageDown, Space, F1-F12) or a single character.'),
        modifiers: {
          type: 'array',
          description: 'Modifier keys held during the action, e.g. ["Control"] for Ctrl+click or Ctrl+S.',
          items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
        },
        repeat: num('For action:"key" — press this many times.', { default: 1 }),
        direction: str('For action:"scroll".', { enum: ['up', 'down', 'left', 'right'], default: 'down' }),
        amount: num('For action:"scroll" — pixels (humanized scrolling rounds to wheel notches).', { default: 400 }),
        from: str('For action:"drag" — source ref.'),
        to: str('For action:"drag" — target ref.'),
        values: {
          description: 'For action:"select" — option value(s), label(s), or visible text.',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        selector: str('CSS selector, for action:"upload" when the file input is hidden and has no ref — the usual case. Try "input[type=file]".'),
        files: {
          description: 'For action:"upload" — absolute local file path(s). No native picker opens.',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        x: num('Fallback X coordinate when no ref exists (canvas, custom widgets).'),
        y: num('Fallback Y coordinate.'),
        force: bool('Click even when another element covers the target. Only after reading the obstruction error.', false),
        humanize: HUMANIZE,
        seed: SEED,
        tabId: TAB_ID,
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
        idle: bool('For action:"wait" — wait until the DOM is mutation-free for 500ms and no captured request is in flight.', false),
        waitUntil: str('Load condition for goto/reload.', { enum: ['load', 'domcontentloaded', 'idle'], default: 'load' }),
        timeoutMs: num('Deadline in milliseconds. Defaults to 30000 for goto/reload and 15000 for wait.'),
        tabId: TAB_ID,
      },
    },
  },

  {
    name: 'browser_inspect',
    description:
      'DevTools-panel inspection. what:"dom" = Elements, "styles" = Computed styles, "box" = layout geometry and visibility, "storage" = Application storage, "cookies" = cookies of any site in that browser (HttpOnly included), "frames" = the iframe tree.',
    inputSchema: {
      type: 'object',
      properties: {
        what: str('Which panel.', { enum: ['dom', 'styles', 'box', 'storage', 'cookies', 'frames'], default: 'dom' }),
        ref: str('Element handle from browser_snapshot.'),
        selector: str('CSS selector, as an alternative to ref.'),
        properties: { type: 'array', description: 'For what:"styles" — return only these CSS properties.', items: { type: 'string' } },
        all: bool('For what:"styles" — include every property, not just non-default ones.', false),
        depth: num('For what:"dom" with no ref/selector — levels of structure to show; deeper subtrees collapse.', { default: 3 }),
        kind: str('For what:"storage".', { enum: ['all', 'local', 'session', 'indexeddb', 'cache', 'serviceworker'], default: 'all' }),
        url: str('For what:"cookies" — read the cookies for this URL instead of the tab\'s own.'),
        limit: num('For what:"cookies" — max cookies to return.', { default: 40 }),
        tabId: TAB_ID,
      },
    },
    annotations: { readOnlyHint: true },
  },

  {
    name: 'browser_console',
    description:
      'Read buffered console output (log, warn, error, uncaught exceptions with stack frames), or evaluate JavaScript. "evaluate" runs in the PAGE\'s own main world — you are asking about the page\'s JavaScript, and the page can see what you run. In a stealth context the page runtime is never enabled, so "read" reports page console capture as unavailable instead of pretending the page was silent.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('"read" (default) or "evaluate".', { enum: ['read', 'evaluate'], default: 'read' }),
        expression: str('For action:"evaluate" — JavaScript to run in the page. Async expressions are awaited.'),
        level: { description: 'Filter by level, e.g. "error" or ["error","warning"].', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        contains: str('Only messages containing this substring.'),
        since: num('Only messages with seq greater than this. Use lastSeq from a previous call to poll.'),
        limit: num('Max entries.', { default: 100 }),
        clear: bool('Empty the buffer instead of reading. Useful before reproducing a bug.', false),
        tabId: TAB_ID,
      },
    },
  },

  {
    name: 'browser_network',
    description:
      'Network: list requests, or pass a requestId for one in full (headers, timing, POST body, response body). Capture begins when the tab is attached — if an already-open page shows 0 requests, reload it (browser_navigate action:"reload") and read again. RECORD AND FREEZE: "record_har", then "pin" serves matching requests from that HAR (strict:true fails the rest) so a remaining difference is the client\'s; "unpin"; "pin_status". BREAK IT ON PURPOSE: "intercept" with rules makes chosen requests fail, stall or return your body (test the UI on a 500/429/timeout); "intercept_status"; "clear_intercept". Rules apply before a pinned HAR. DOWNLOADS: "watch_downloads" BEFORE the click that starts one (each watch starts a fresh list), then "wait_download" returns the finished file (name, bytes; in launched engines also sha256 and the type sniffed from its content), "downloads" lists them, "stop_downloads" ends the watch — proof an export produced a real file, which a 200 response cannot give.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('Default "list".', {
          enum: ['list', 'record_har', 'pin', 'unpin', 'pin_status', 'intercept', 'intercept_status', 'clear_intercept',
            'watch_downloads', 'downloads', 'wait_download', 'stop_downloads'],
          default: 'list',
        }),
        har: { type: 'object', description: 'For action:"pin" — a HAR from action:"record_har" or format:"har".' },
        rules: {
          type: 'array',
          description:
            'For action:"intercept". Each rule needs "match" (URL substring) and one outcome: "status" (+ optional "body", "headers"), ' +
            '"abort" ("TimedOut", "ConnectionRefused", "Failed", …) or "delayMs" alone. Optional "method", "times" (fire N times — ' +
            '"the first save fails, the retry succeeds"), "label" (named in a response header so an injected 500 is never mistaken ' +
            'for a real one). Example: [{ "match": "/api/orders", "method": "POST", "status": 500, "times": 1, "label": "first save fails" }]',
          items: { type: 'object' },
        },
        contains: str('For action:"wait_download" — a download whose filename or URL contains this. Omit for any.'),
        timeoutMs: num('For action:"wait_download" — how long to wait. Default 30000.'),
        strict: bool('For action:"pin" — fail requests the HAR does not contain instead of letting them through.', false),
        requestId: str('Fetch full detail including the response body for this request.'),
        filter: str('Substring match on the URL (list), or the URL filter for pin/intercept.'),
        method: str('Filter by HTTP method.'),
        status: { description: '"failed" (network error or 4xx/5xx), "pending", or an exact status code.', anyOf: [{ type: 'string' }, { type: 'number' }] },
        includeBody: bool('When fetching one request, include the response body.', true),
        format: str('Return a HAR 1.2 document instead of the compact list.', { enum: ['list', 'har'], default: 'list' }),
        limit: num('Max requests to list.', { default: 50 }),
        clear: bool('Empty the buffer instead of reading.', false),
        tabId: TAB_ID,
      },
    },
  },

  {
    name: 'browser_diagnose',
    description:
      'FASTEST PATH TO "what is wrong with this page". health correlates actionable defects (console errors, failed requests, broken assets, unlabeled controls, overflow, duplicate ids); performance records a trace and may reload; vitals measures Core Web Vitals and long tasks; memory samples heap, DOM nodes, documents and listeners for leak signals.',
    inputSchema: {
      type: 'object',
      properties: {
        what: str('Which analysis.', { enum: ['health', 'performance', 'vitals', 'memory'], default: 'health' }),
        durationMs: num('For what:"performance" — how long to record.', { default: 4000 }),
        reload: bool('For what:"performance" — reload so the trace covers page load.', false),
        samples: num('For what:"memory" — 2..10 samples.', { default: 3 }),
        intervalMs: num('For what:"memory" — delay between samples.', { default: 500 }),
        tabId: TAB_ID,
      },
    },
  },

  {
    name: 'browser_screenshot',
    description:
      'Capture an image. Use SPARINGLY — browser_snapshot is cheaper and more precise for anything structural. For visual questions only: rendering, spacing, canvas content. Oversized FULL-PAGE captures are scaled down, never cropped; the result reports the scale applied. area:"element" and area:"fullpage" are ACTIONS, not reads: the first scrolls the element into view (with the wheel at the human and stealth levels, a programmatic scroll at "off") and captures it as far as it shows on screen (the result\'s `cropped` gives the element\'s full size — take several viewport shots for the whole of it); the second resizes the viewport when the page is taller (the page can see that), so at stealth it is refused. Both therefore claim the tab and queue behind its other actions, and are refused on a tab another agent owns. area:"viewport" is a plain read and always allowed.',
    inputSchema: {
      type: 'object',
      properties: {
        area: str('"viewport" (default), "fullpage", or "element" (needs ref).', { enum: ['viewport', 'fullpage', 'element'], default: 'viewport' }),
        ref: str('For area:"element".'),
        format: str('Image format.', { enum: ['jpeg', 'png'], default: 'jpeg' }),
        quality: num('JPEG quality 0-100.', { default: 70 }),
        humanize: HUMANIZE,
        tabId: TAB_ID,
      },
    },
  },

  {
    name: 'browser_emulate',
    description:
      'Emulate a device, viewport, network condition, CPU throttle, colour scheme, locale or timezone. Lasts until reset or until the tab is detached. For responsive and slow-network testing. NOT stealth-safe: a device preset overrides the user agent (and its Client Hints), and a locale here changes Intl only while navigator.languages and Accept-Language stay the profile\'s — the contradiction detectors look for. Both are refused on a stealth tab; use a launched engine with that locale instead. reset:true gives the browser its own user agent and Client Hints back.',
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
        tabId: TAB_ID,
      },
    },
  },

  {
    name: 'browser_dialog',
    description:
      'Accept or dismiss a JavaScript dialog (alert, confirm, prompt, beforeunload). An open dialog freezes the page; every other call on that tab fails fast, naming the dialog, until this is called.',
    inputSchema: {
      type: 'object',
      properties: {
        accept: bool('Accept (OK) or dismiss (Cancel).', true),
        promptText: str('Text to enter for a prompt() dialog.'),
        tabId: TAB_ID,
      },
    },
  },

  {
    name: 'browser_recording',
    description:
      'Recorded user flows, replayable as tests WITH MEMORY. A QA records in the side panel (or you call start/stop); each element is stored with several independent locators so a step survives a redeploy, and replay reports WHICH locator matched (a step that matched only by xpath passes with a warning). A failing step says what it looked for, what it tried and the closest thing on the page. Every replay also compares what the flow did against its approved known world and reports surprises — see Regression memory in the instructions. replay engine:"launched" runs in a launched browser (copying the recording there if needed); humanize/seed control input style and reproduce motion. "calibrate_humanize" fits a humanize profile from the raw pointer/keyboard events a recording captured and saves it under name (then use humanize:"<name>"). "export_spec"/"import_spec" move a flow in and out as a Git-diffable FlowSpec, with what a person approved beside it (approved: the known world and the screenshot/aria baselines). approve also writes that approval next to the flow in the project repository when the flow is there. Without a tab, list shows the recordings of every engine\'s store (engine field), and id-based actions use the store that has the id.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('What to do. list/get/update/delete/export/import/export_spec/import_spec/approve/known_world/signature/calibrate_humanize work with no tab.', {
          enum: ['list', 'get', 'status', 'start', 'stop', 'replay', 'assert', 'update', 'delete', 'export', 'import', 'export_test',
            'export_spec', 'import_spec', 'calibrate', 'approve', 'known_world', 'signature', 'suggest', 'calibrate_humanize'],
          default: 'list',
        }),
        id: str('Recording id, for get/replay/assert/update/delete/export_test/calibrate_humanize/…'),
        engine: str('Which engine: for replay, "launched" runs it in a launched browser (opening the recording\'s start URL); for tab-free actions, which store ("extension" or "launched"). Default: your current tab\'s engine.'),
        context: str('For replay engine:"launched": the context to open the tab in.'),
        atStep: num('For action:"assert" — insert the check AFTER this step number (1-based, as action:"stop" printed). Out of range is refused, never clamped.'),
        name: str('For action:"start" — a name for the recording. For calibrate_humanize — the profile name to save (e.g. "team-qa"); saved for the launched engines.'),
        base: str('For calibrate_humanize — the built-in profile the fit starts from.', { enum: ['off', 'human', 'stealth'], default: 'human' }),
        timing: str(
          'For replay. "recorded" (DEFAULT) reproduces the person\'s pace — a 10 s session replayed in 200 ms never lets a debounce fire. "adaptive" waits only as long as each step needs. "fast" barely waits. Every mode gates each step on load, visibility, enabled and settled; the recorded gap is a budget, never a blind sleep.',
          { enum: ['recorded', 'adaptive', 'fast'], default: 'recorded' },
        ),
        humanize: HUMANIZE,
        seed: SEED,
        dryRun: bool('For replay — resolve every element and change nothing. The cheapest check that a recording has rotted.', false),
        stopOnFailure: bool('For replay — stop at the first failing step.', true),
        variables: { type: 'object', description: 'For replay — values substituted into {{name}} placeholders.' },
        signature: str('For replay — evidence for the surprise detector: "lite" (default), "full" (UI shape every step; used by calibration), "off".', { enum: ['off', 'lite', 'full'], default: 'lite' }),
        compare: bool('For replay — compare against the approved known world. Off only for a deliberate reference run.', true),
        seedKnownWorld: bool('For replay — if the flow has no known world yet, create one from this run. Never overwrites an approved one.', false),
        environment: str('For replay/calibrate/known_world — which environment\'s known world this run compares against and files under (known worlds are kept per environment; default: the flow\'s own environment, else the default world). For approve — must name the environment the reviewed run ran on, or the approval is refused.'),
        urlNormalizers: { type: 'array', items: { type: 'object' }, description: 'For replay/calibrate — the project\'s url rules ([{match, as}] regex → replacement), applied when the network signature is built AND to the stored known world at comparison, so /api/orders/<id> collapses to /api/orders/{id} on both sides. The runner passes g9.project.json\'s.' },
        by: str('For approve — who approved it.'),
        note: str('For approve — why.'),
        expectLastRunAt: num('For approve — the `lastRun.at` of the run that was reviewed. The approval is refused when a newer run arrived since, instead of folding that run\'s surprises into the known world unseen.'),
        spec: { type: 'object', description: 'For import_spec — a G9BrowserAgent FlowSpec document.' },
        approved: { type: 'object', description: 'For import_spec — the flow\'s approval sidecar (format "g9-approved": the approved known world and the screenshot/aria baselines), as export_spec returns it or <name>.approved.json holds it. The later human approval wins; without it the store keeps the baselines it has.' },
        images: { type: 'object', description: 'For import_spec — baseline screenshots named in approved, { "<step>.png": base64 }.' },
        includeImages: bool('For export_spec — also return the baseline screenshots as base64 (they can be large).', false),
        assertion: str('For assert. "aria" stores a SEMANTIC baseline and is the one to prefer for regression; "screenshot" compares layout structure by default.', { enum: ['url', 'text', 'visible', 'value', 'state', 'network', 'console', 'a11y', 'screenshot', 'aria'] }),
        visualMode: str('For a screenshot assertion: "layout" (default), "strict", or "off" (record only).', { enum: ['off', 'layout', 'strict'], default: 'layout' }),
        masks: { type: 'array', description: 'For a screenshot assertion — normalised 0..1 rectangles {x,y,w,h} excluded. Prefer calibrate.', items: { type: 'object' } },
        maxNodes: num('For an aria assertion — how much of the semantic tree to baseline.', { default: 400 }),
        expected: { description: 'Expected value for an assertion.' },
        operator: str('Text comparison.', { enum: ['exact', 'contains', 'absent', 'matches'] }),
        contains: str('Substring used by text, network and console assertions.'),
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
        suite: str('Suite name for update.'),
        folder: str('Folder path for update.'),
        tags: { type: 'array', items: { type: 'string' }, description: 'Recording tags for update.' },
        startUrl: str('For update: the http(s) URL the flow starts on; its origin is the flow\'s site in the panel. An empty string clears it.'),
        qaTestCaseIds: { type: 'array', items: { type: 'string' }, description: 'For update: the manual test-case ids this flow covers (they appear in qa-automation-status.json).' },
        environment: { type: 'object', description: 'Named environment profile with an optional variables object.' },
        parameters: { type: 'object', description: 'Data parameter defaults or descriptors.' },
        includeAttachments: bool('For export — inline attachment bytes.', true),
        mode: str('For import.', { enum: ['merge', 'replace'], default: 'merge' }),
        bundle: { type: 'object', description: 'For import — a bundle from action:"export".' },
        tabId: TAB_ID,
      },
    },
  },

  {
    name: 'browser_issue',
    description:
      'Defects captured in the browser with the context a developer always asks for afterwards — URL, previous page, console tail, failed requests, viewport — recorded at the moment the bug was visible. Attachments (screenshots, tab video, files) travel with the issue. Read these to file tickets: write the ticket from them instead of asking the user to repeat what is here. Without a tab, list shows the issues of every engine\'s store (engine field).',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('What to do. list/get/update/delete/attach/attachment work with no tab; page evidence and video actions need one.', {
          enum: ['list', 'get', 'create', 'update', 'delete', 'screenshot', 'attach', 'attachment', 'video_start', 'video_stop', 'video_status'],
          default: 'list',
        }),
        id: str('Issue id.'),
        engine: str('For tab-free actions: which store ("extension" or "launched"). Default: your current tab\'s engine, then the other.'),
        title: str('For create/update.'),
        body: str('For create/update — what happened, and what was expected.'),
        severity: str('For create/update.', { enum: ['blocker', 'major', 'normal', 'minor'], default: 'normal' }),
        status: str('For update.', { enum: ['open', 'filed', 'closed'] }),
        tags: { type: 'array', description: 'Free-form labels.', items: { type: 'string' } },
        filedAs: str('For update — the tracker key once filed, e.g. "PROJ-1234", so it is not filed twice.'),
        withScreenshot: bool('For create — capture the viewport now.', true),
        area: str('For screenshot.', { enum: ['viewport', 'fullpage', 'element'], default: 'viewport' }),
        ref: str('For screenshot with area:"element".'),
        note: str('A caption for the attachment.'),
        name: str('For attach — file name.'),
        mime: str('For attach — content type.'),
        dataBase64: str('For attach — the file bytes, base64.'),
        attachmentId: str('For attachment — which attachment to read.'),
        includeBytes: bool('For attachment — include the bytes, not just metadata.', true),
        quality: num('For video_start — JPEG frame quality 0..100.', { default: 60, minimum: 0, maximum: 100 }),
        everyNthFrame: num('For video_start — keep every Nth screencast frame.', { default: 2, minimum: 1 }),
        tabId: TAB_ID,
      },
    },
  },
];

/**
 * `session` is accepted by every tool that takes a tab, added in one pass.
 *
 * Writing it into fourteen schemas by hand guarantees the fifteenth is added
 * without it, and the failure is silent: the router would accept the argument,
 * the schema would not advertise it, and the agent would act on the wrong tab.
 * Deriving it from "does this tool take a tabId" keeps the two in step.
 */
for (const tool of TOOLS) {
  const properties = tool.inputSchema?.properties;
  if (!properties || !('tabId' in properties) || tool.name === 'browser_tabs' || 'session' in properties) continue;
  properties.session = str('Act on a named session (browser_tabs action:"session") instead of your current tab.');
}

export const TOOL_NAMES = TOOLS.map((t) => t.name);
