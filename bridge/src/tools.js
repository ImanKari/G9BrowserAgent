/**
 * Tool schemas and the agent-facing instructions.
 *
 * Design note: there are 12 tools rather than 50, each with an `action` or
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
status, the element that overflows.`;

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
        files: {
          description: 'For action:"upload" — absolute local file path(s). No native picker is opened.',
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
        idle: bool('For action:"wait" — wait until the DOM stops mutating for 500ms.', false),
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
        requestId: str('Fetch full detail including the response body for this request.'),
        filter: str('Substring match on the URL.'),
        method: str('Filter by HTTP method.'),
        status: {
          description: '"failed" (network error or 4xx/5xx), "pending", or an exact status code.',
          anyOf: [{ type: 'string' }, { type: 'number' }],
        },
        includeBody: bool('When fetching one request, include the response body.', true),
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
      'FASTEST PATH TO "what is wrong with this page". what:"health" correlates console errors, failed requests, broken images, unlabelled form controls, horizontal overflow, and duplicate IDs into one ranked list with page metrics. what:"performance" records a trace and returns a timing breakdown.',
    inputSchema: {
      type: 'object',
      properties: {
        what: str('Which analysis.', { enum: ['health', 'performance'], default: 'health' }),
        durationMs: num('For what:"performance" — how long to record.', { default: 4000 }),
        reload: bool('For what:"performance" — reload the page so the trace covers page load.', false),
        tabId: num('Only in multi-tab mode.'),
      },
    },
    annotations: { readOnlyHint: true },
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
    name: 'browser_tabs',
    description:
      'List, open, close, focus, or pin tabs. Outside multi-tab mode, list shows every tab by ORIGIN only except the one you are driving — titles and URLs are withheld on purpose. Also outside multi-tab mode, ONLY action:"list" is allowed — open/close/focus/pin/unpin are refused, because pinning a different tab would otherwise be a way around the mode. Only the user changes the mode, from the side panel.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('What to do.', { enum: ['list', 'open', 'close', 'focus', 'pin', 'unpin'], default: 'list' }),
        url: str('For action:"open".'),
        tabId: num('For close/focus/pin.'),
        focus: bool('For action:"open" — bring the new tab to the front.', false),
        pin: bool('For action:"open" — attach and pin the new tab immediately.', false),
      },
    },
  },
];
