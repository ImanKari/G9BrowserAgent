/**
 * Tool schemas and the agent-facing instructions (v2).
 *
 * Design note, unchanged from v1: fifteen grouped tools rather than fifty, each
 * with an `action` or `what` discriminator. Tool definitions are re-sent on
 * every request, so a wide flat surface costs thousands of tokens of context
 * before the agent has done anything (AIGuide §4.4).
 *
 * Descriptions are written for the agent, not for a human reading docs: when to
 * reach for a tool and what the common mistake is. (3.8) They are the FIRST layer only — what the tool is for,
 * its one pitfall, and which guide (mcp/guides.js) has the rest; clients cut long descriptions and send
 * them with every request, and the long tail lives in the guides and the per-tool reference. Every sentence must describe
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

const TAB_ID = num('A tab handle from browser_tabs action:"list" (shared by every engine). Default: your current tab.');
const HUMANIZE = str(
  'Input style for this call: "off" (direct, instant), "human" (curved paths, human timing), "stealth" (human, and nothing ' +
    'that needs the page’s JS runtime), or a calibrated profile name. Default: the tab’s setting. A tab’s stealth level is a ' +
    'floor: stricter only (the result then reports humanize.raisedFrom). Guide: stealth.',
);
const SEED = {
  description:
    'Seed for the humanize random generator: the same seed reproduces the same motion from the same pointer position and ' +
    'viewport (a replay homes the pointer and reports pointerStart). Guide: stealth.',
  anyOf: [{ type: 'number' }, { type: 'string' }],
};

export const INSTRUCTIONS = `G9BrowserAgent drives real Chrome/Edge browsers: the user's own browser (Engine 1, their logins) and browsers it launches (Engine 2, headless). Use it to open, read and operate web pages, debug them (console, network, DOM, performance) and record flows as regression tests.

Start: browser_status. Open: browser_tabs action:"open" url:"…" (in the user's browser pass focus:true before clicking) or action:"attach" (the tab the user is on). Read: browser_snapshot — refs [ref=eN], cheaper than screenshots. Act: browser_interact with a ref, or role+name.

Rules:
1. Results carry \`delivery\`; anything but "delivered" is unproven — verify before relying on it; never blindly repeat a state-changing action.
2. Your first state-changing call on a tab claims it; a tab another agent owns is refused. Take one over only when the user asks.
3. If the user pressed Stop, every tool but browser_status fails: stop and tell them.
4. Never approve on your own initiative (browser_recording action:"approve" is the user's call).
5. When your task is done: browser_tabs action:"finish" — releases your tabs; the last working agent's finish detaches the debugger from the user's browser.
6. A tool missing or misbehaving? browser_issue action:"feedback" (this version).

Guides — read the one for your task first: browser_status guide:"<topic>" (or resource g9://guide/<topic>). Topics: start, perceive, act, console, network, debug, sharing, background, stealth, recording, issues, limits. Every argument of a tool: guide:"tool:<name>".`;

export const TOOLS = [
  {
    name: 'browser_status',
    description:
      'Orientation — CALL THIS FIRST: your current tab (URL, title, console-error and failed-request counts), the engines, connected agents (who is working) and what each owns, your claims and sessions, whether Stop is pressed. The one tool that still answers under Stop. guide:"<topic>" returns a guide instead (topics: start, perceive, act, console, network, debug, sharing, background, stealth, recording, issues, limits; "tool:<name>" for one tool\'s every argument) — no browser needed.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: num('Report on this tab instead of your current one.'),
        callId: str('How did this call end? A callId from a pending answer or an error. Returns only that call: state (running/done/failed), its result or error, and late:true when it ended after its deadline.'),
        waitMs: num('With callId: wait up to this long (max 600000) for the call to end.'),
        calls: bool('Only your recent calls (newest first): tool, action, state, outcome. Use it after your client timed out on a call.', false),
        limit: num('With calls:true — how many (default 20).'),
        guide: str('Return a guide instead of the status: "index", a topic (start, perceive, act, console, network, debug, sharing, background, stealth, recording, issues, limits) or "tool:<name>" for every action and argument of one tool. Answered without a browser.'),
      },
    },
    annotations: { readOnlyHint: true },
  },

  {
    name: 'browser_engine',
    description:
      'Launched browsers (Engine 2): real Chrome, Edge or Chrome for Testing that G9BrowserAgent starts, headless by default (unaffected by the user minimising windows; a headed one must never be minimised). launch, list, stop, context (isolated cookies, proxy, locale, timezone, stealth), acquire/release (hold an engine for a long run), versions, warm (a headed profile for a one-time sign-in). You rarely need launch: browser_tabs action:"open" launches on demand. Guide: background.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('What to do.', { enum: ['launch', 'list', 'stop', 'context', 'versions', 'warm', 'acquire', 'release'], default: 'list' }),
        lease: bool('For launch: hold this engine for your session (release it with action:"release"; a disconnect releases it too).', false),
        stopWhenReleased: bool('For launch with lease:true: the daemon stops this engine once every holder has released it and no agent owns a tab in it.', false),
        browser: str('For launch/warm: which browser. "auto" = pinned Chrome for Testing if installed, else Edge, else Chrome.', { enum: ['auto', 'edge', 'chrome', 'cft'] }),
        headless: bool('For launch: run with no window (default from settings, normally true). Headed needs a desktop that nobody minimises.'),
        profile: str('For launch/warm: profile name under the G9BrowserAgent data folder (default "automation"). A profile holds cookies and history between runs; one browser at a time per profile.'),
        keepSessionCookies: bool('For launch: keep the profile’s session cookies (no expiry) across a stop and the next launch, so a sign-in kept partly in them (Google, YouTube…) survives; the old tabs still do not come back. false = a fresh session each launch.', true),
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
      'Tabs across ALL engines: list, open (makes it your current tab), close, focus, attach (the tab the user is on), claim/release ownership, finish (your task is done: releases your tabs; the last working agent detaches the debugger from the user\'s browser), detach, popout, handoff (to a launched browser), session names, wait for a popup, watch (a live view for the user), keep_awake. In the user\'s browser a tab opens in the BACKGROUND: the browser only delivers input to the tab it is SHOWING, so a background tab can be read but not clicked — focus it first, or popout/handoff it. Guides: start, sharing, background.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('What to do.', {
          enum: ['list', 'open', 'close', 'focus', 'attach', 'detach', 'claim', 'release', 'finish', 'popout', 'handoff', 'session', 'sessions', 'end_session', 'wait', 'watch', 'keep_awake'],
          default: 'list',
        }),
        on: bool('For watch: false closes the live view again. For keep_awake: false ends it.', true),
        keepAwake: bool('For open/session: keep the new tab working in the background (focus emulation, page lifecycle kept active) — for long in-page work such as rendering. keep_awake does the same for a tab already open.', false),
        url: str('For open/session: the URL. For wait: a URL substring.'),
        tabId: num('For close/focus/attach/claim/release/popout/handoff/watch, or session (name a tab already open). A G9BrowserAgent handle. watch without one: your current tab.'),
        session: str('Instead of tabId: a session name. For open: names the new tab (as name does).'),
        name: str('For session/end_session: the session name, e.g. "buyer". For open: also name the new tab.'),
        engine: str('For open/session/attach: "extension", "launched", or an engineId from browser_engine. For handoff: the launched engine to receive the tab. Default for open: the extension if connected, else a launched browser (launched on demand).'),
        context: str('For open/handoff: a contextId from browser_engine action:"context" (launched engines only). Handoff defaults to a fresh isolated context.'),
        focus: bool('For open/session: bring the tab to the front in its window. For popout/watch: create the new window in front and focused (default: unfocused, so the user keeps the keyboard).', false),
        force: bool('For claim: take the tab over from another agent. Only when the user asked for it; it is logged.', false),
        detach: bool('For release (the user’s browser): also end G9’s debugger session on the released tabs, so the page no longer has a debugger attached (captcha and bot checks look for one). false keeps it attached.', true),
        leaveWithoutAsking: bool('For close: accept the page’s "Leave site?" (beforeunload) prompt instead of stopping at it.', false),
        includeStorage: bool('For handoff: also carry localStorage/sessionStorage of the page\'s origin.', true),
        profile: str('For handoff: hand the tab into this G9BrowserAgent profile (launched, or reused when it already runs). The cookies are written INTO the profile, so the login stays for later runs. Without it a handoff uses a fresh, temporary context.'),
        proxy: str('For handoff: the proxy the receiving browser uses (with profile: launched with it; without: a fresh context with it), e.g. "http://proxy:8080".'),
        proxyBypass: str('For handoff with proxy: hosts that skip the proxy, e.g. "localhost;*.internal".'),
        headless: bool('For handoff with profile: false launches it headed (a window a person can see; never minimise it).'),
        stealth: str('For handoff: the receiving browser\'s stealth level.', { enum: ['off', 'human', 'stealth'] }),
        locale: str('For handoff with profile: the persona\'s locale, e.g. "fa-IR".'),
        timezone: str('For handoff with profile: the persona\'s IANA time zone.'),
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
      'PRIMARY PERCEPTION TOOL: the accessibility tree with a [ref=eN] on every interactive element, for browser_interact. Take a fresh one after navigation or a big DOM change. Read less: scope, roles/name filters, interactiveOnly, maxNodes, diff:true (only changes since your previous diff snapshot). Works on background tabs. Guide: perceive.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: str('"a11y" (default) or "a11y+text" to also include all visible page text.', { enum: ['a11y', 'a11y+text'], default: 'a11y' }),
        maxNodes: num('Cap on emitted nodes. Default 900. Raise for very large pages.', { default: 900 }),
        scope: str('Only this element\'s subtree: a ref ("e12") or a CSS selector.'),
        roles: { type: 'array', items: { type: 'string' }, description: 'Only nodes with these roles (e.g. ["button","link"]), as flat lines; every match gets a ref.' },
        name: str('Only nodes whose accessible name matches this regular expression (case-insensitive), as flat lines.'),
        matchCase: bool('With name: case-sensitive.', false),
        exact: bool('With name: the whole name, compared literally (no regex; case-insensitive unless matchCase).', false),
        interactiveOnly: bool('Only the controls (buttons, links, fields…), as flat lines.', false),
        includeText: bool('false = no named content beyond controls and named structure.', true),
        diff: bool('Only what changed since YOUR previous diff:true snapshot of this page with the same options: "+" added, "~" changed (with what it was), "-" removed. The first one returns the full tree. Refs are stable per element.', false),
        tabId: TAB_ID,
      },
    },
    annotations: { readOnlyHint: true },
  },

  {
    name: 'browser_interact',
    description:
      'Real user input (trusted events, human-like by default): click, type, key, scroll, drag, select, upload, set_value (proves the value). Target a ref from browser_snapshot, or role+name / selector (nth when several match), waitMs for a late control. The result carries delivery: anything but "delivered" is unproven — verify the effect, and never blindly repeat a state-changing action. Guide: act.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: str('What to do.', {
          enum: ['click', 'double_click', 'right_click', 'hover', 'type', 'key', 'scroll', 'drag', 'select', 'upload', 'set_value'],
        }),
        ref: str('Element handle from browser_snapshot, e.g. "e12". Or name the target without a snapshot: role (+ name), or selector.'),
        role: str('Instead of ref: the element’s role ("button", "link", "textbox", "slider", "checkbox"…), with name to narrow it. Several matches are refused with the list unless nth picks one.'),
        name: str('Instead of ref: a regular expression the accessible name must match (case-insensitive), with or without role.'),
        matchCase: bool('With name: case-sensitive ("Save" does not match "save").', false),
        exact: bool('With name: the whole name, compared literally — no regex, so "Save (2)" needs no escaping; case-insensitive unless matchCase.', false),
        nth: num('With role/name or selector: which match (1-based) when several match.'),
        waitMs: num('Wait up to this long (max 60000) for the target to appear, and for a covered or moving target to become clickable (tried again; nothing is pressed until it is). Without it, a covered or moving target gets 1.5 s.'),
        expectSamePage: bool('Fail (code "navigated") when the action takes the page to another URL — a "button" that was a link. Without it, such a result just carries navigated: {url, sameDocument}. The action itself still happened either way.', false),
        ifHidden: str('The user’s browser only: when the tab is in the background, "focus" brings it to the front of its window and "popout" moves it into a window of its own, then acts (instead of refusing).', { enum: ['refuse', 'focus', 'popout'], default: 'refuse' }),
        value: { description: 'For action:"set_value" — the value: a number for a slider or range input, true/false for a checkbox/switch/radio, text for a field, an option (or several) for a select. The result proves it (before, after, verified).', anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } }] },
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
        from: str('For action:"drag" — source ref (or the role/name/selector target).'),
        to: str('For action:"drag" — target ref.'),
        toPercent: num('For action:"drag" instead of to — a position 0..100 along the control’s track (a slider thumb, a scrubber). The result has the value before and after.'),
        toX: num('For action:"drag" instead of to — a viewport x (CSS pixels) to drop at, with toY.'),
        toY: num('For action:"drag" — the viewport y to drop at.'),
        values: {
          description: 'For action:"select" — option value(s), label(s), or visible text.',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        selector: str('Instead of ref: a CSS selector (visible matches only; nth picks one). For action:"upload" it names the file input, hidden or not — try "input[type=file]".'),
        files: {
          description: 'For action:"upload" — absolute file path(s) on the BROWSER’s machine. No native picker opens. Or hand the bytes over with fileData / fileUrls.',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        fileData: {
          description: 'For action:"upload" — files to upload, as bytes: [{ name, base64 }] (up to 40 MiB per call). They are written on the browser’s machine first; the result lists them (path, size, sha256) and what the input then holds.',
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' }, base64: { type: 'string' } } },
        },
        fileUrls: {
          description: 'For action:"upload" — files to upload from URLs, fetched as the page would (the browser’s cookies), then set on the input.',
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
      'Navigate (goto, reload, back, forward) or WAIT for a condition — text, selector, page predicate, a ref\'s state, network idle, or something to disappear. Waiting is condition-based with a deadline: never sleep and hope. Guide: act.',
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
        predicate: str('For action:"wait" — a JavaScript expression evaluated in the PAGE (main world; a promise is awaited), polled until truthy. Returns the final value and the time it took.'),
        ref: str('For action:"wait" — an element from browser_snapshot to wait on, with state.'),
        state: str('For action:"wait" with ref.', { enum: ['visible', 'hidden', 'enabled', 'disabled', 'checked', 'unchecked', 'gone', 'present'], default: 'visible' }),
        pollMs: num('For action:"wait" — how often to look (default: 250 ms, slowing to 1-2 s on long waits).'),
        waitUntil: str('Load condition for goto/reload.', { enum: ['load', 'domcontentloaded', 'idle'], default: 'load' }),
        leaveWithoutAsking: bool('For goto/reload/back/forward — accept the page’s own "Leave site?" (beforeunload) prompt for this navigation instead of stopping at it.', false),
        timeoutMs: num('Deadline in milliseconds. Defaults to 30000 for goto/reload and 15000 for wait; a wait may take up to 7200000 (2 h).'),
        tabId: TAB_ID,
      },
    },
  },

  {
    name: 'browser_inspect',
    description:
      'DevTools-panel inspection: what:"dom", "styles" (computed), "box" (geometry, visibility), "storage", "cookies" (any site, HttpOnly included), "frames", and "find" — only the elements with a role and/or name (regex), with refs: the cheapest way to the ref of one control on a big page. Guides: perceive, debug.',
    inputSchema: {
      type: 'object',
      properties: {
        what: str('Which panel.', { enum: ['dom', 'styles', 'box', 'storage', 'cookies', 'frames', 'find'], default: 'dom' }),
        role: str('For what:"find" — the role, e.g. "button", "link", "textbox", "heading".'),
        roles: { type: 'array', items: { type: 'string' }, description: 'For what:"find" — several roles.' },
        name: str('For what:"find" — a regular expression the accessible name must match (case-insensitive).'),
        matchCase: bool('For what:"find" with name: case-sensitive.', false),
        exact: bool('For what:"find" with name: the whole name, compared literally (no regex).', false),
        interactiveOnly: bool('For what:"find" — only controls.', false),
        scope: str('For what:"find" — search only inside this ref or CSS selector.'),
        ref: str('Element handle from browser_snapshot.'),
        selector: str('CSS selector, as an alternative to ref.'),
        properties: { type: 'array', description: 'For what:"styles" — return only these CSS properties.', items: { type: 'string' } },
        all: bool('For what:"styles" — include every property, not just non-default ones.', false),
        depth: num('For what:"dom" with no ref/selector — levels of structure to show; deeper subtrees collapse.', { default: 3 }),
        kind: str('For what:"storage".', { enum: ['all', 'local', 'session', 'indexeddb', 'cache', 'serviceworker'], default: 'all' }),
        url: str('For what:"cookies" — read the cookies for this URL instead of the tab\'s own.'),
        limit: num('For what:"cookies" — max cookies to return (default 40). For what:"find" — max matches (default 50).'),
        tabId: TAB_ID,
      },
    },
    annotations: { readOnlyHint: true },
  },

  {
    name: 'browser_console',
    description:
      'Console: read buffered output (log, warn, error, uncaught exceptions with stack frames; filter by level/contains, poll with since), clear it before a repro, or evaluate JavaScript in the PAGE\'s main world (the page can see it). Long work: job:true runs on in the page (job_status, job_cancel, jobs). In a stealth context page console capture is unavailable and says so. Guides: console, debug.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('"read" (default), "evaluate", "job_status", "job_cancel" or "jobs".', { enum: ['read', 'evaluate', 'job_status', 'job_cancel', 'jobs'], default: 'read' }),
        expression: str('For action:"evaluate" — JavaScript to run in the page. Async expressions are awaited. In a job, __g9job is the job (progress, signal, cancelled).'),
        job: bool('For action:"evaluate" — run it as a job: answer at once with a jobId.', false),
        jobId: str('For job_status/job_cancel.'),
        timeoutMs: num('For action:"evaluate" — how long an awaited result may take (default 20000; up to 14400000 = 4 h). For a job: its budget before it is reported overdue.'),
        waitMs: num('For job_status — wait up to this long (max 600000) for the job to finish, then answer.'),
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
      'Network: list requests (filter by URL, method, status:"failed") or one in full by requestId (headers, timing, bodies). Capture starts when the tab is attached — reload an already-open page. Also: intercept (make requests fail, stall or return your body), record_har + pin (serve from a HAR), downloads (watch_downloads BEFORE the click, then wait_download), fetch with the browser\'s cookies, read_file. Guide: network.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('Default "list".', {
          enum: ['list', 'record_har', 'pin', 'unpin', 'pin_status', 'intercept', 'intercept_status', 'clear_intercept',
            'watch_downloads', 'downloads', 'wait_download', 'stop_downloads', 'fetch', 'read_file'],
          default: 'list',
        }),
        url: str('For action:"fetch" — the URL (relative to the page is fine).'),
        headers: { type: 'object', description: 'For action:"fetch" — request headers.' },
        body: { description: 'For action:"fetch" — the request body (a string, or JSON).', anyOf: [{ type: 'string' }, { type: 'object' }] },
        bodyBase64: str('For action:"fetch" — a binary request body, base64.'),
        savePath: str('For action:"fetch" — write the response body to this path on the BROWSER\'s machine (relative = under the G9BrowserAgent data folder\'s files/); the result gives path, size, sha256, content type and no body.'),
        maxBytes: num('For action:"fetch" without savePath — how much of the body to return (default 262144).'),
        path: str('For action:"read_file" — a file G9BrowserAgent wrote or saw on the browser’s machine: a download’s path, a fetch or screenshot savePath (relative = under its files/ folder). Other files are refused.'),
        offset: num('For action:"read_file" — where to start, in bytes (default 0; the result gives next.offset while there is more).'),
        length: num('For action:"read_file" — how many bytes (default 4 MiB, at most 8 MiB).'),
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
        timeoutMs: num('For action:"wait_download" — how long to wait. Default 30000. For action:"fetch" — the whole fetch\'s deadline (default 60000).'),
        strict: bool('For action:"pin" — fail requests the HAR does not contain instead of letting them through.', false),
        requestId: str('Fetch full detail including the response body for this request.'),
        filter: str('Substring match on the URL (list), or the URL filter for pin/intercept.'),
        method: str('Filter by HTTP method. For action:"fetch": the method to send (default GET).'),
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
      'FASTEST PATH TO "what is wrong with this page": health correlates actionable defects (console errors, failed requests, broken assets, unlabeled controls, overflow, duplicate ids); performance records a trace (may reload); vitals measures Core Web Vitals and long tasks; memory samples heap, DOM nodes and listeners for leaks. Guide: debug.',
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
      'Capture an image — SPARINGLY: browser_snapshot is cheaper and more precise for anything structural; use this for rendering, spacing, canvas. area:"viewport" (default) is a plain read. area:"element" and area:"fullpage" are ACTIONS, not reads: they scroll or resize the page, so they claim the tab and queue (fullpage is refused at stealth). savePath writes the file on the browser\'s machine. Guide: perceive.',
    inputSchema: {
      type: 'object',
      properties: {
        area: str('"viewport" (default), "fullpage", or "element" (needs ref).', { enum: ['viewport', 'fullpage', 'element'], default: 'viewport' }),
        ref: str('For area:"element".'),
        format: str('Image format.', { enum: ['jpeg', 'png'], default: 'jpeg' }),
        quality: num('JPEG quality 0-100.', { default: 70 }),
        savePath: str('Write the image to this path on the BROWSER\'s machine (relative = under the G9BrowserAgent data folder\'s files/) and return path, bytes and sha256 instead of the image.'),
        thumbnail: bool('With savePath: also return a small JPEG of the viewport to look at.', false),
        thumbnailWidth: num('With thumbnail: its width in CSS pixels.', { default: 320 }),
        humanize: HUMANIZE,
        tabId: TAB_ID,
      },
    },
  },

  {
    name: 'browser_emulate',
    description:
      'Emulate a device, viewport, network condition, CPU throttle, colour scheme, locale or timezone until reset:true or the tab is detached — for responsive and slow-network testing. NOT stealth-safe: device presets override the user agent, and both they and locale are refused on a stealth tab. Guides: debug, stealth.',
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
      'Accept or dismiss a JavaScript dialog (alert, confirm, prompt, beforeunload). An open dialog freezes ITS tab — calls on it fail fast, naming the dialog — until this is called; other tabs are unaffected. To leave a page without its "Leave site?" prompt, navigate or close with leaveWithoutAsking:true. Guide: act.',
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
      'Recorded flows replayable as tests WITH MEMORY, and batch: many steps (navigate, click/type by ref or role+name, wait, evaluate, extract) in ONE call, stopping at the first failure. start/stop, suggest/assert, calibrate, replay (compares with the approved known world and reports surprises), approve (the USER\'s decision, never yours), export_spec/import_spec (Git-diffable FlowSpec). Guide: recording.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('What to do. list/get/update/delete/export/import/export_spec/import_spec/approve/known_world/signature/calibrate_humanize work with no tab.', {
          enum: ['list', 'get', 'status', 'start', 'stop', 'replay', 'assert', 'update', 'delete', 'export', 'import', 'export_test',
            'export_spec', 'import_spec', 'calibrate', 'approve', 'known_world', 'signature', 'suggest', 'calibrate_humanize', 'batch'],
          default: 'list',
        }),
        steps: {
          type: 'array',
          items: { type: 'object' },
          description: 'For action:"batch" — steps run in order in ONE call, each { action, … }: "navigate" {url}; "click"|"double_click"|"right_click"|"hover"|"type"|"key"|"select"|"scroll" with ref, or role + name (regex; nth when several match) and the browser_interact options (text, clear, pressEnter, key, values…); "wait" with the browser_navigate wait options (text, selector, predicate, ref+state, idle, timeoutMs); "evaluate" {expression, timeoutMs?}; "extract" {ref | selector | role+name} → the element\'s text. saveAs:"x" keeps a value for {{x}} in later steps. Stops at the first failure with an excerpt of the page there.',
        },
        continueOnError: bool('For action:"batch" — run every step even after one fails.', false),
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
        variables: { type: 'object', description: 'For replay and batch — values substituted into {{name}} placeholders.' },
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
      'Defects captured with the context a developer asks for afterwards — URL, previous page, console tail, failed requests, viewport — plus screenshots, files and tab video; write the ticket from them instead of asking the user to repeat it. feedback (no tab) sends a suggestion for G9BrowserAgent itself. Guide: issues.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('What to do. list/get/update/delete/attach/attachment work with no tab; page evidence and video actions need one.', {
          enum: ['list', 'get', 'create', 'update', 'delete', 'screenshot', 'attach', 'attachment', 'video_start', 'video_stop', 'video_status', 'feedback'],
          default: 'list',
        }),
        id: str('Issue id.'),
        engine: str('For tab-free actions: which store ("extension" or "launched"). Default: your current tab\'s engine, then the other.'),
        title: str('For create/update, and feedback (a short summary).'),
        category: str('For feedback.', { enum: ['feature', 'bug', 'improvement', 'docs', 'other'] }),
        tool: str('For feedback: the G9BrowserAgent tool it is about, e.g. "browser_interact".'),
        body: str('For create/update — what happened, and what was expected. For feedback — what you needed from G9BrowserAgent, what happened, and what would have helped (at most 5000 characters).'),
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

// ------------------------------------------------------------------ argument names (3.5)

/**
 * Keys every tool accepts whatever its schema says: where a call goes (the daemon's routing —
 * `engine` is how the runner's --engine extension reaches a page tool) and what the transports add.
 */
export const ROUTING_KEYS = new Set(['tabId', 'session', 'engine', 'context', 'opId', 'replyWithinMs']);

/** Names agents reach for that mean something else here. */
const ALIASES = {
  selector: { browser_snapshot: 'scope' },
  css: 'selector',
  query: 'name',
  timeout: 'timeoutMs',
  wait: 'waitMs',
  waitFor: 'waitMs',
  tab: 'tabId',
  tab_id: 'tabId',
  id: 'tabId',
  js: 'expression',
  script: 'expression',
  code: 'expression',
  value: 'text',
  path: 'savePath',
  file: 'files',
  max: 'maxNodes',
  limitNodes: 'maxNodes',
  element: 'ref',
};

function editDistance(a, b) {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const d = Array.from({ length: s.length + 1 }, (_, i) => [i, ...Array(t.length).fill(0)]);
  for (let j = 1; j <= t.length; j++) d[0][j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
  }
  return d[s.length][t.length];
}

/** The closest known argument for an unknown one, or null. */
export function suggestArgument(tool, key, known) {
  const alias = ALIASES[key];
  const aliased = typeof alias === 'string' ? alias : alias?.[tool];
  if (aliased && known.includes(aliased)) return aliased;
  let best = null;
  let bestD = Infinity;
  for (const k of known) {
    const dist = editDistance(key, k);
    const near = dist <= Math.max(1, Math.floor(k.length / 4)) || k.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(k.toLowerCase());
    if (near && dist < bestD) {
      best = k;
      bestD = dist;
    }
  }
  return best;
}

/**
 * Argument names a call passes that its tool does not take. → [{ key, suggestion }] (empty = fine).
 *
 * Unknown names used to be ignored without a word: `browser_snapshot selector:"#chat"` returned the
 * whole page — the agent read that as "the selector matched everything" and spent its context on it
 * (field report). An argument the tool does not read is now refused, with the closest real one.
 */
export function unknownArguments(tool, args) {
  const definition = TOOLS.find((t) => t.name === tool);
  const properties = definition?.inputSchema?.properties;
  if (!properties || !args || typeof args !== 'object') return [];
  const known = Object.keys(properties);
  const out = [];
  for (const key of Object.keys(args)) {
    if (key in properties || ROUTING_KEYS.has(key)) continue;
    out.push({ key, suggestion: suggestArgument(tool, key, known) });
  }
  return out;
}

/** The refusal for unknownArguments(), naming every unknown key, its suggestion and the tool's real ones. */
export function unknownArgumentsMessage(tool, unknown) {
  const definition = TOOLS.find((t) => t.name === tool);
  const known = Object.keys(definition?.inputSchema?.properties ?? {});
  const parts = unknown.map(({ key, suggestion }) => `"${key}"${suggestion ? ` (did you mean "${suggestion}"?)` : ''}`);
  return `${tool} does not take ${parts.join(', ')}; nothing was done. Its arguments are: ${known.join(', ')}.`;
}
