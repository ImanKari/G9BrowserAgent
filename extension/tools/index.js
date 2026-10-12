/**
 * The shared tool runtime (ARCHITECTURE_V2 §4): the flat TOOLS table and the
 * pipeline every call goes through, in both engines.
 *
 * Moved out of sw.js in v2. The extension calls `runTool` for every daemon
 * `call` message; the daemon's Engine 2 runtime imports this very file and
 * calls `runTool` against a launched browser (platform-cdp). One table, one
 * behaviour — an agent must never get a different result from the same call on
 * a different engine.
 *
 * The pipeline: halted check → target resolution → dialog check → run →
 * activity log. The halt check lives HERE, at the router, as well as inside
 * cdp.send(): tab management (`platform.tabs.*`) is not CDP, so a check that
 * low cannot see it — a halted agent could still open, close and focus tabs.
 * `browser_status` is the single exception (`allowWhenHalted`), because an
 * agent that cannot ask *why* it is failing will guess.
 */

import { platform } from '../lib/platform.js';
import { getState, logActivity, forgetDialog } from '../lib/state.js';
import { inWorld } from '../lib/world.js';
import { evaluate, send as cdpSend, attachedTabIds, recoverTab, keepAwake, attachIssuesOf, pendingCommands, detach as detachDebugger } from '../lib/cdp.js';
import { bindCallSignal, bindCallDeadline, callSignalFor } from '../lib/humanize.js';
import * as store from '../lib/store.js';
import { toFlowSpec, canonicalJson } from '../lib/flowspec.js';
import { envKeyOf, knownWorldFor } from '../lib/signature.js';
import { importFlow, approvedBundle } from '../lib/flowsync.js';

import * as tabsTool from './tabs.js';
import { snapshot, find } from './snapshot.js';
import * as jobs from './jobs.js';
import { fetchResource } from './fetch.js';
import { runBatch } from './batch.js';
import * as interact from './interact.js';
import * as target from './target.js';
import * as setvalue from './setvalue.js';
import * as inspect from './inspect.js';
import * as observe from './observe.js';
import * as nav from './navigate.js';
import { screenshot, viewportThumbnail } from './capture.js';
import * as diagnose from './diagnose.js';
import * as emulate from './emulate.js';
import * as record from './record.js';
import * as replay from './replay.js';
import * as issues from './issues.js';
import * as qa from './qa.js';
import * as netpin from './netpin.js';
import * as netrules from './netrules.js';
import * as downloads from './downloads.js';

// ------------------------------------------------------------------- hooks

/**
 * What the host (sw.js, or the daemon's engine runtime) plugs in.
 * `connection({ tabId })` adds transport facts to browser_status — `tabId` is
 * the tab the status is about (or null), so a host running several browsers
 * (the daemon's launched engines) can name the one that tab lives in rather
 * than whichever it used last; `emit(event, data)`
 * carries 'dialog', 'download', 'activity' (and whatever else a module emits)
 * to wherever the host sends events. Exported read-only for tools/events.js.
 */
export const hooks = { connection: null, emit: null };

export function setHooks(h = {}) {
  if ('connection' in h) hooks.connection = h.connection ?? null;
  if ('emit' in h) hooks.emit = h.emit ?? null;
}

function emit(event, data) {
  try {
    hooks.emit?.(event, data);
  } catch {
    /* a host hook must never fail a tool call */
  }
}

// Downloads are reported by the browser, not the page, so they arrive through
// the platform rather than the CDP event stream. Registered at import time —
// in the extension this module is evaluated synchronously while the worker
// starts, which is what lets a download event wake it.
//
// The host hears every state change, but progress at most once a second per
// download: a large file reports progress many times a second, and each one
// became a socket message, a UI activity row and an evidence line.
const DOWNLOAD_PROGRESS_EMIT_MS = 1_000;
const lastDownloadEmit = new Map();
platform.downloads.onEvent((evt) => {
  downloads.ingest(evt).catch((err) => console.error('[G9BrowserAgent] download capture failed', err));
  if (evt?.state === 'in_progress' && lastDownloadEmit.has(evt.id)) {
    if (Date.now() - lastDownloadEmit.get(evt.id) < DOWNLOAD_PROGRESS_EMIT_MS) return;
  }
  if (evt?.state === 'in_progress') lastDownloadEmit.set(evt.id, Date.now());
  else lastDownloadEmit.delete(evt?.id);
  emit('download', evt);
});

// ------------------------------------------------------------------- helpers

function requireId(args) {
  if (!args.id) throw new Error('This action needs an id. Use action:"list" to see what exists.');
  return args.id;
}

function requireTabId(args) {
  if (args.tabId == null) throw new Error('This action needs a tabId. Call browser_tabs with action:"list" first.');
  return args.tabId;
}

const HALTED =
  'The user pressed Stop. Every browser action is blocked until they press Resume (in the G9BrowserAgent side panel ' +
  'or the G9BrowserAgent app) — you cannot lift this yourself. Tell them, and wait.';

/** One-line human description for the activity log. */
export function summarize(tool, args = {}) {
  const bits = [];
  if (args.action) bits.push(args.action);
  if (args.what) bits.push(args.what);
  if (args.ref) bits.push(args.ref);
  if (args.selector) bits.push(args.selector);
  if (args.url) bits.push(args.url);
  if (args.text) bits.push(JSON.stringify(String(args.text).slice(0, 40)));
  if (args.expression) bits.push(String(args.expression).slice(0, 60));
  return bits.length ? `${tool}(${bits.join(' ')})` : tool;
}

// --------------------------------------------------------------- the table

/**
 * Each entry receives ({ tabId, tab, args, caller }) and returns a
 * JSON-serializable result. Keeping this flat and declarative means adding a
 * capability is one entry here plus one schema in mcp/tools.js.
 */
export const TOOLS = {
  // --- session -------------------------------------------------------------
  // Orientation is the one thing that must still work while halted — otherwise
  // the agent cannot discover *why* everything else is failing.
  browser_status: { needsTab: false, allowWhenHalted: true, run: ({ args }) => status(args) },

  browser_tabs: {
    needsTab: false,
    run: async ({ args }) => {
      const action = args.action ?? 'list';
      switch (action) {
        case 'list':
          return { tabs: await tabsTool.listTabs() };
        case 'open': {
          if (!args.url) throw new Error('action:"open" needs a url.');
          const opened = await tabsTool.openTab(args.url, { active: args.focus ?? false });
          if (args.name) await tabsTool.nameSession(args.name, opened.tabId);
          return { ...opened, ...(args.name ? { session: args.name } : {}) };
        }
        case 'close':
          return tabsTool.closeTab(requireTabId(args), { leaveWithoutAsking: args.leaveWithoutAsking === true });
        case 'focus':
          return { focused: (await tabsTool.focusTab(requireTabId(args))).id };
        case 'attach':
          return tabsTool.attachTab(args.tabId ?? null);
        case 'popout':
          return tabsTool.popout(args.tabId ?? null, args);
        case 'handoff_export':
          return tabsTool.handoffExport(args.tabId ?? null);
        case 'wait':
          return tabsTool.waitForTab(args);
        case 'keep_awake':
          // (3.4) Keep a background tab working: focus emulation + lifecycle active (lib/cdp.js).
          return { tabId: requireTabId(args), ...(await keepAwake(requireTabId(args), args.on !== false)) };
        case 'detach':
          return detachTab(requireTabId(args));

        // --- named sessions ----------------------------------------------
        // Several tabs at once was always possible at the CDP layer; these
        // actions are the addressing that was missing. See tools/tabs.js.
        case 'session': {
          if (!args.name) throw new Error('action:"session" needs a name, e.g. name:"buyer".');
          return args.url
            ? tabsTool.openSession(args.name, args.url, { active: args.focus ?? false })
            : tabsTool.nameSession(args.name, requireTabId(args));
        }
        case 'sessions':
          return { sessions: await tabsTool.listSessions() };
        case 'end_session':
          if (!args.name) throw new Error('action:"end_session" needs a name.');
          return tabsTool.closeSession(args.name);

        case 'pin':
        case 'unpin':
          throw new Error(
            `action:"${action}" was removed in v2 — there are no modes. Use action:"attach" to make a tab the ` +
              'current one, or pass tabId/session on each call.',
          );
        case 'claim':
        case 'release':
        case 'handoff':
          throw new Error(
            `action:"${action}" is handled by the G9BrowserAgent daemon (tab ownership and hand-off span every engine) and ` +
              'reached an engine directly. Call it through the daemon — the MCP shim does that — not on the engine.',
          );
        default:
          throw new Error(
            `Unknown tabs action "${action}". Known: list, open, close, focus, attach, popout, wait, session, ` +
              'sessions, end_session, keep_awake (and, through the daemon: claim, release, handoff).',
          );
      }
    },
  },

  // --- perception ----------------------------------------------------------
  browser_snapshot: { run: ({ tabId, args, caller }) => snapshot(tabId, args, caller) },

  browser_screenshot: {
    run: async ({ tabId, tab, args }) => {
      const shot = await screenshot(tabId, { ...args, url: tab.url });
      // (3.4) With savePath the daemon writes the image on the browser's machine; thumbnail:true
      // adds a small viewport JPEG that the agent sees instead of the full image.
      if (args.savePath && args.thumbnail === true) {
        try {
          shot.thumbnail = await viewportThumbnail(tabId, args.thumbnailWidth ?? 320, shot);
        } catch (err) {
          shot.thumbnailError = String(err?.message ?? err);
        }
      }
      return shot;
    },
  },

  browser_inspect: {
    run: ({ tabId, tab, args, caller }) => {
      const withUrl = { ...args, url: tab.url };
      switch (args.what ?? 'dom') {
        // (3.4) role and/or name regex → only the matching lines, with refs.
        case 'find': return find(tabId, withUrl, caller);
        case 'dom': return inspect.dom(tabId, withUrl);
        case 'styles': return inspect.styles(tabId, withUrl);
        case 'box': return inspect.box(tabId, withUrl);
        case 'storage': return inspect.storage(tabId, args);
        case 'cookies': return inspect.cookies(tabId, args);
        case 'frames': return inspect.frames(tabId);
        default: throw new Error(`Unknown inspect target "${args.what}".`);
      }
    },
  },

  // --- action --------------------------------------------------------------
  browser_interact: {
    // humanize / seed / typos / fast ride through untouched: interact.js and
    // lib/humanize.js decide the input level (the tab's context, else the
    // panel's setting, else the explicit argument).
    run: ({ tabId, tab, args, caller }) => interactWithRetry(tabId, tab, args, caller),
  },

  browser_navigate: {
    run: ({ tabId, tab, args }) => {
      switch (args.action ?? 'goto') {
        case 'goto': return nav.navigate(tabId, args);
        case 'reload': return nav.reload(tabId, args);
        case 'back': return nav.history(tabId, { ...args, delta: -(args.steps ?? 1) });
        case 'forward': return nav.history(tabId, { ...args, delta: args.steps ?? 1 });
        case 'wait': return nav.waitFor(tabId, { ...args, url: tab?.url ?? null });
        default: throw new Error(`Unknown navigate action "${args.action}".`);
      }
    },
  },

  browser_dialog: { run: ({ tabId, args }) => emulate.handleDialog(tabId, args) },

  browser_emulate: { run: ({ tabId, args }) => emulate.emulate(tabId, args) },

  // --- observation ---------------------------------------------------------
  browser_console: {
    run: async ({ tabId, args }) => {
      if (args.action === 'evaluate') {
        // The MAIN world, deliberately: the agent is asking about the page's own
        // JavaScript, which G9BrowserAgent's isolated world cannot see.
        if (!args.expression) throw new Error('action:"evaluate" needs an expression.');
        // (3.4) job:true answers at once with a jobId; the work runs on in the page (tools/jobs.js).
        if (args.job === true) return jobs.startJob(tabId, args.expression, { timeoutMs: args.timeoutMs });
        // (3.4) timeoutMs: an awaited promise may take minutes, up to 4 h.
        const timeoutMs = args.timeoutMs != null ? Math.max(1_000, Math.min(jobs.MAX_JOB_MS, Number(args.timeoutMs) || 30_000)) : null;
        const value = await evaluate(tabId, args.expression, timeoutMs ? { timeoutMs } : {});
        return { value: value === undefined ? '(undefined)' : value };
      }
      if (args.action === 'job_status') return jobs.jobStatus(tabId, args);
      if (args.action === 'job_cancel') return jobs.cancelJob(tabId, args);
      if (args.action === 'jobs') return jobs.listJobs();
      return observe.consoleLog(tabId, args);
    },
  },

  browser_network: {
    // async because the interception actions have to ask whether a HAR is
    // already pinned before touching the shared Fetch session.
    run: async ({ tabId, args }) => {
      // Pinning lives here rather than in a fifteenth tool: it is the network
      // tool doing a network thing, and §4.4's budget is spent on definitions,
      // not on actions.
      switch (args.action) {
        case 'record_har': return netpin.record(tabId, args);
        case 'pin': return netpin.pin(tabId, args);
        case 'unpin': return netpin.unpin(tabId);
        case 'pin_status': return netpin.status(tabId);

        // --- deliberate failure injection (GAP-0002) ---------------------
        case 'intercept': {
          // Rules and a pinned HAR share one Fetch session, so only enable it
          // here when pinning has not already done so — a second Fetch.enable
          // would reset the patterns the pin is relying on.
          if (!(await netpin.isPinned(tabId))) await netpin.enableForRules(tabId, args);
          return netrules.setRules(tabId, args.rules);
        }
        case 'intercept_status': return netrules.rulesStatus(tabId);
        case 'clear_intercept': {
          const cleared = await netrules.clearRules(tabId);
          // Leave Fetch on if a HAR is still pinned; it owns the session then.
          if (!(await netpin.isPinned(tabId))) {
            await cdpSend(tabId, 'Fetch.disable').catch(() => {});
          }
          return cleared;
        }

        // --- fetch as the page (3.4) ---------------------------------------
        case 'fetch': return fetchResource(tabId, { ...args, pageUrl: (await platform.tabs.get(tabId).catch(() => null))?.url });

        // --- downloads (GAP-0001, EXT-02) ---------------------------------
        case 'watch_downloads': return downloads.watch(tabId, args);
        case 'downloads': return downloads.list(tabId);
        case 'wait_download': return downloads.waitFor(tabId, args);
        case 'stop_downloads': return downloads.stop(tabId);
        default: break;
      }
      if (args.format === 'har') return observe.har(tabId, args);
      return args.requestId ? observe.networkDetail(tabId, args) : observe.network(tabId, args);
    },
  },

  // --- automation ----------------------------------------------------------
  browser_recording: {
    // list/get/delete/export/import touch no page, so they must keep working
    // when nothing is attached — that is when someone reviews their library.
    needsTab: false,
    run: async ({ args, caller }) => {
      const action = args.action ?? 'list';
      const needsPage = ['start', 'stop', 'replay', 'assert', 'suggest', 'calibrate', 'batch'].includes(action);
      const tab = needsPage ? await tabsTool.resolveTarget(args.tabId, args.session ?? null) : null;

      switch (action) {
        case 'list': return { recordings: await store.listRecordings() };
        case 'get': {
          const rec = await store.getRecording(requireId(args));
          if (!rec) throw new Error(`No recording with id "${args.id}".`);
          return { ...rec, outline: rec.steps.map(record.summarize) };
        }
        case 'status': return record.recordingStatus(
          (await tabsTool.resolveTarget(args.tabId, args.session ?? null)).id,
        );
        case 'start': return record.startRecording(tab.id, { name: args.name });
        // (3.4) A list of steps in one call (tools/batch.js).
        case 'batch': return runBatch(tab.id, args, caller);
        case 'stop': return record.stopRecording(tab.id);
        case 'replay': return replay.replay(tab.id, {
          id: requireId(args), timing: args.timing, dryRun: args.dryRun,
          stopOnFailure: args.stopOnFailure !== false, variables: args.variables,
          signature: args.signature, compare: args.compare !== false,
          seedKnownWorld: args.seedKnownWorld === true,
          ...(args.humanize !== undefined ? { humanize: args.humanize } : {}),
          ...(args.seed !== undefined ? { seed: args.seed } : {}),
          ...(args.environment !== undefined ? { environment: args.environment } : {}),
          ...(args.urlNormalizers !== undefined ? { urlNormalizers: args.urlNormalizers } : {}),
        });
        case 'calibrate': return replay.calibrate(tab.id, {
          id: requireId(args), timing: args.timing, variables: args.variables,
          ...(args.environment !== undefined ? { environment: args.environment } : {}),
          ...(args.urlNormalizers !== undefined ? { urlNormalizers: args.urlNormalizers } : {}),
        });
        case 'approve': return replay.approveKnownWorld(requireId(args), {
          by: args.by, note: args.note, expectLastRunAt: args.expectLastRunAt ?? null,
          ...(args.environment !== undefined ? { environment: args.environment } : {}),
        });
        case 'signature': {
          // The full signature of the LAST run. Not returned by replay itself — it is kilobytes of
          // normalised evidence and would flood an agent's context — but a runner doing an A/B
          // comparison needs both sides in full, and it is the only consumer that does.
          const rec = await store.getRecording(requireId(args));
          if (!rec) throw new Error(`No recording with id "${args.id}".`);
          if (!rec.lastSignature) throw new Error('This flow has not been replayed yet, so it has no signature.');
          return rec.lastSignature;
        }
        case 'known_world': {
          const rec = await store.getRecording(requireId(args));
          if (!rec) throw new Error(`No recording with id "${args.id}".`);
          // Per environment (lib/signature.js): the default world without an
          // environment argument, so every existing caller keeps its answer.
          const kw = knownWorldFor(rec, args.environment ?? rec.environment);
          if (!kw?.runs) {
            return {
              runs: 0,
              environment: envKeyOf(args.environment ?? rec.environment),
              note: 'No approved known world yet for this environment. Replay once, then action:"approve".',
              ...(Object.keys(rec.knownWorlds ?? {}).length || rec.knownWorld?.runs
                ? { environmentsWithWorlds: [...(rec.knownWorld?.runs ? ['default'] : []), ...Object.keys(rec.knownWorlds ?? {})] }
                : {}),
            };
          }
          return {
            runs: kw.runs, approvedAt: kw.approvedAt, approvedBy: kw.approvedBy,
            environment: envKeyOf(args.environment ?? rec.environment),
            networkOperations: Object.keys(kw.network), consoleSignatures: Object.keys(kw.console),
            dialogs: Object.keys(kw.dialogs), steps: Object.keys(kw.steps).length,
            volatile: kw.volatile,
          };
        }
        case 'assert': return qa.addAssertion(tab.id, { ...args, id: requireId(args) });
        case 'suggest': return qa.suggestAssertions(tab.id, requireId(args));
        case 'update': return qa.updateRecording(requireId(args), args);
        case 'export_test': return qa.exportPlaywright(requireId(args));
        case 'export_spec': {
          const rec = await store.getRecording(requireId(args));
          if (!rec) throw new Error(`No recording with id "${args.id}".`);
          const spec = toFlowSpec(rec);
          // (3.2) What a person approved travels beside the spec (lib/approved.js): the known world
          // and the baselines, with the baseline screenshots only when asked for (they are large).
          const bundle = await approvedBundle(rec);
          return {
            id: rec.id, spec, json: canonicalJson(spec),
            ...(bundle ? { approved: bundle.approved, ...(args.includeImages ? { images: bundle.images } : { imageNames: Object.keys(bundle.images) }) } : {}),
          };
        }
        case 'import_spec': {
          if (!args.spec) throw new Error('action:"import_spec" needs a spec.');
          // (3.2) With the flow's sidecar (`approved`, `images`): baselines and a later approval
          // come with it; what this store learned stays (lib/flowsync.js importFlow).
          return importFlow(args.spec, { approved: args.approved ?? null, images: args.images ?? {}, id: args.id ?? null });
        }
        case 'delete': return store.deleteRecording(requireId(args));
        case 'export': return store.exportBundle({ includeAttachments: args.includeAttachments !== false });
        case 'import': {
          if (!args.bundle) throw new Error('action:"import" needs a bundle.');
          return store.importBundle(args.bundle, { mode: args.mode ?? 'merge' });
        }
        case 'calibrate_humanize':
          // Fit a human-input profile from the raw pointer/key samples a person
          // produced while recording (docs/HUMANIZE.md, Calibration); with `name` it is saved and
          // usable as humanize:"<name>". One recording (id) or several (ids).
          return record.calibrateFromRecording(
            Array.isArray(args.ids) && args.ids.length ? args.ids : requireId(args),
            { base: args.base ?? 'human', name: args.name ?? null },
          );
        default: throw new Error(`Unknown recording action "${action}".`);
      }
    },
  },

  browser_issue: {
    needsTab: false,
    run: async ({ args }) => {
      const action = args.action ?? 'list';
      const needsPage = ['create', 'screenshot', 'video_start', 'video_stop', 'video_status'].includes(action);
      const tab = needsPage ? await tabsTool.resolveTarget(args.tabId, args.session ?? null) : null;

      switch (action) {
        case 'list': return { issues: await store.listIssues(), usage: await store.usage() };
        case 'get': {
          const issue = await issues.getIssue(requireId(args));
          if (!issue) throw new Error(`No issue with id "${args.id}".`);
          return issue;
        }
        case 'create': return issues.createIssue(tab.id, args);
        case 'update': return issues.updateIssue(requireId(args), args);
        case 'delete': return issues.deleteIssue(requireId(args));
        case 'screenshot': return issues.attachScreenshot(tab.id, requireId(args), args);
        case 'attach': return issues.attachFile(requireId(args), args);
        case 'attachment': {
          if (!args.attachmentId) throw new Error('action:"attachment" needs an attachmentId.');
          return store.getAttachment(args.attachmentId, { includeBytes: args.includeBytes !== false });
        }
        case 'video_start': return issues.startVideo(tab.id, args);
        case 'video_stop': return issues.stopVideo(tab.id, args.id);
        case 'video_status': return issues.videoStatus(tab.id);
        default: throw new Error(`Unknown issue action "${action}".`);
      }
    },
  },

  // --- diagnosis -----------------------------------------------------------
  browser_diagnose: {
    run: ({ tabId, args }) => {
      const what = args.what ?? 'health';
      if (what === 'performance') return diagnose.performance(tabId, args);
      if (what === 'vitals') return diagnose.vitals(tabId, args);
      if (what === 'memory') return diagnose.memory(tabId, args);
      return diagnose.health(tabId);
    },
  },
};

// ------------------------------------------------------------------ interact (3.5)

/** One browser_interact action on a resolved target. */
function interactOnce(tabId, a) {
  switch (a.action) {
    case 'click': return interact.click(tabId, a);
    case 'double_click': return interact.click(tabId, { ...a, clickCount: 2 });
    case 'right_click': return interact.click(tabId, { ...a, button: 'right' });
    case 'hover': return interact.hover(tabId, a);
    case 'type': return interact.type(tabId, a);
    case 'key': return interact.key(tabId, a);
    case 'scroll': return interact.scroll(tabId, a);
    case 'drag':
      return a.to == null && (a.toPercent != null || a.toX != null) ? setvalue.dragTo(tabId, a) : interact.drag(tabId, a);
    case 'select': return interact.select(tabId, a);
    case 'upload': return interact.upload(tabId, a);
    case 'set_value': return setvalue.setValue(tabId, a);
    default: throw new Error(`Unknown interact action "${a.action}".`);
  }
}

/** Without waitMs, how long a covered or moving target is given to become clickable. */
export const DEFAULT_RETRY_MS = 1_500;
const RETRY_GAP_MS = 300;

/**
 * (3.5) browser_interact around interactOnce:
 * - the target may be named by role (+ name, nth) or selector instead of a ref (tools/target.js),
 *   found again on every attempt, waiting up to `waitMs` for it to appear;
 * - a refusal made BEFORE anything was pressed — covered by an overlay, moved, re-rendered (gone,
 *   for a target found by role or selector) — is tried again until it works or `waitMs` (else
 *   DEFAULT_RETRY_MS) runs out. Nothing reached the element, so this repeats no action (rule R6);
 *   "missed", "partial" and every error after input went out are never retried;
 * - `ifHidden:"focus"|"popout"`: in the person's browser a background tab gets no input; instead of
 *   refusing, bring it to the front of its window or move it into a window of its own, then act.
 *   The refusal sent nothing, so acting after it is safe.
 */
async function interactWithRetry(tabId, tab, args, caller) {
  const base = { ...args, url: tab.url };
  if (Array.isArray(args.modifiers)) base.modifiers = interact.modifierMask(args.modifiers);
  const lookup = target.wantsLookup(args);
  const waitMs = Math.max(0, Math.min(target.MAX_WAIT_MS, Number(args.waitMs) || 0));
  const signal = callSignalFor(tabId);
  const started = Date.now();
  let unhid = null;
  for (let attempt = 0; ; attempt += 1) {
    let found = null;
    const a = { ...base };
    if (lookup) {
      found = await target.lookupRef(tabId, { ...args, waitMs: Math.max(0, waitMs - (Date.now() - started)) }, caller, { url: tab.url, signal });
      a.ref = found.ref;
      if (args.action === 'drag' && a.from == null) a.from = found.ref;
    }
    try {
      const out = await interactOnce(tabId, a);
      const extra = {
        ...(found ? { ref: found.ref, matched: found.matched } : {}),
        ...(attempt ? { retried: attempt } : {}),
        ...(unhid ? { unhid } : {}),
      };
      return Object.keys(extra).length && out && typeof out === 'object' ? { ...out, ...extra } : out;
    } catch (err) {
      // A background tab, refused before anything was sent: bring it forward once, as asked.
      if (err?.hidden && err.delivery === 'not-delivered' && !unhid && (args.ifHidden === 'focus' || args.ifHidden === 'popout') && platform.name === 'extension') {
        unhid = args.ifHidden === 'focus'
          ? { how: 'focus', ...(await tabsTool.focusTab(tabId).then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message }))) }
          : { how: 'popout', ...(await tabsTool.popout(tabId, { focus: false }).catch((e) => ({ error: e.message }))) };
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      const p = err?.predispatch;
      const retryable = p === 'covered' || p === 'moved' || (p === 'gone' && lookup);
      const budget = waitMs || DEFAULT_RETRY_MS;
      if (!retryable || signal?.aborted || Date.now() - started + RETRY_GAP_MS > budget) {
        if (retryable && attempt) err.message += ` (tried ${attempt + 1} times over ${Math.round((Date.now() - started) / 100) / 10} s)`;
        if (err?.hidden && !args.ifHidden && platform.name === 'extension' && err.delivery === 'not-delivered') {
          err.message += ' Or pass ifHidden:"popout" (its own window) or ifHidden:"focus" to let this call bring the tab forward itself.';
        }
        throw err;
      }
      await new Promise((r) => setTimeout(r, RETRY_GAP_MS));
    }
  }
}

// ------------------------------------------------------------------ detach (3.5)

/**
 * End G9BrowserAgent's debugger session on a tab of the person's browser: the page no longer has a
 * debugger attached, and the browser's "started debugging this browser" bar goes once no tab is
 * attached. `release` used to drop only the claim and leave the debugger on — and captcha and bot
 * checks (hCaptcha, Cloudflare) kept seeing it (field report). A tab with a recording running is
 * left attached: the recorder lives on that session. Launched engines are always attached.
 */
async function detachTab(tabId) {
  if (platform.name !== 'extension') return { tabId, detached: false, note: 'A launched browser’s tabs are always attached (it has no debugger bar); nothing to detach.' };
  const rec = await record.recordingStatus(tabId).catch(() => null);
  if (rec?.recording) return { tabId, detached: false, note: 'A recording is running on this tab; it stays attached until the recording stops.' };
  const held = await attachedTabIds().catch(() => []);
  if (!held.includes(tabId)) return { tabId, detached: false, wasAttached: false };
  const result = await detachDebugger(tabId);
  return { ...result, tabId, note: 'The debugger is detached from this tab: console and network capture stop, and the debugging bar goes once no tab is attached. The next agent call on it attaches again.' };
}

// ------------------------------------------------------------------ status

/**
 * Engine-local orientation: what this engine holds and what a call without a
 * tabId would act on. The daemon wraps it with engines, agents and ownership.
 *
 * `args.tabId` (F4): report on THAT tab — its `current` row and its `health`
 * counters — instead of the engine's own current tab. The daemon passes the
 * tab its status is about (the asked tab, else the calling agent's current
 * tab; a Chrome id after the relay's rewrite on Engine 1): with several agents
 * each on its own tab, the engine-wide "current tab" is somebody else's, and
 * its console/network counters used to be shown as this agent's. When the
 * engine's own current tab differs, it is reported as `engineCurrent`; a tab
 * that no longer exists gives `current:null` and a `targetError` — never
 * another tab in its place.
 */
export async function status(args = {}) {
  const state = await getState();
  const tabs = await tabsTool.listTabs().catch(() => []);
  const own = await tabsTool.peekTarget(state);

  const asked = args?.tabId != null && args.tabId !== '' ? Number(args.tabId) : null;
  let target = own;
  let targetError = null;
  if (asked != null) {
    target = await platform.tabs.get(asked).catch(() => null);
    if (!target) targetError = 'The tab this status was asked about does not exist (any more). Call browser_tabs action:"list".';
  }

  let health = null;
  if (target) {
    const [logs, net] = await Promise.all([
      observe.consoleLog(target.id, { limit: 0 }).catch(() => null),
      observe.network(target.id, { limit: 0 }).catch(() => null),
    ]);
    health = {
      consoleErrors: logs?.counts?.error ?? 0,
      consoleWarnings: logs?.counts?.warning ?? 0,
      consoleTotal: logs?.total ?? 0,
      networkRequests: net?.total ?? 0,
      failedRequests: net?.failedCount ?? 0,
      ...(logs?.unavailable ? { console: logs.unavailable } : {}),
    };
  }

  // What the browser says, not only what we think we hold. A drift between
  // the two is exactly what makes a stuck debugger banner invisible.
  const reallyAttached = await attachedTabIds().catch(() => []);
  const held = platform.name === 'extension'
    ? state.attachedTabs.filter((id) => reallyAttached.includes(id))
    : reallyAttached;

  const sessions = await tabsTool.listSessions().catch(() => []);
  const row = target ? tabs.find((t) => t.tabId === target.id) : null;
  const warnings = [];
  if (row?.windowState === 'minimized') {
    warnings.push(
      `The current tab's window is minimized. Chromium hides minimized windows and delivers no input to ` +
        `them — restore the window (covered is fine) before driving it.`,
    );
  }
  if (target && platform.name === 'extension' && !target.active) {
    warnings.push(
      'The current tab is not the active tab of its window, so the browser treats it as hidden: reads and ' +
        'screenshots work, input may not be delivered. Focus it, or pop it out into its own window.',
    );
  }
  // A launched engine's REAL window (platform-cdp's windows are synthetic). A headed Engine 2
  // window that is minimized still reports visibilityState "visible", but Chromium renders it at
  // about one frame per 1.5 s: every mouse event took ~1 s, a humanized click 89 s, the first
  // screenshot stalled 45 s (P8 matrix, round 2). Headless windows are never minimized.
  if (target && platform.name !== 'extension') {
    if ((await tabsTool.realWindowState(target.id)) === 'minimized') {
      warnings.push(
        'The current tab\'s window is minimized. A minimized launched window is rendered at about one frame per ' +
          '1.5 s, so each input event takes about a second (a humanized click well over a minute) and the first ' +
          'screenshot can stall. Restore the window (covered is fine), or run this engine headless.',
      );
    }
    // Behind a tab the PAGE opened (target=_blank, window.open joins the opener's window in front of
    // it): P8 matrix, round 3 — a humanized click 20.9 s, typing 16–23 s, screenshots 24–46 s, and
    // this said nothing. `active` is "in front of its real window" (platform-cdp isActive).
    if (target.active === false) {
      warnings.push(
        'The current tab is BEHIND another tab in its browser window (one the page opened — a target=_blank link or ' +
          'window.open). A tab behind another is rendered a frame at a time: a humanized click took about 21 s and a ' +
          'screenshot 24–46 s there, against about 4 s and under 0.1 s in front. On a headless engine G9BrowserAgent brings it to ' +
          'the front before input and screenshots; on a headed one, browser_tabs action:"focus" restores full speed ' +
          '(or close the tab in front).',
      );
    }
  }

  let connection = {};
  try {
    connection = hooks.connection?.({ tabId: target?.id ?? null }) ?? {};
  } catch {
    connection = {};
  }

  return {
    engine: platform.name === 'extension' ? 'extension' : 'launched',
    version: platform.runtime.version(),
    ...(platform.name === 'extension' && globalThis.navigator?.userAgent ? { browser: globalThis.navigator.userAgent } : {}),
    ...connection,
    halted: state.halted,
    dialogOpen: state.dialogOpen ?? null,
    ...(Object.keys(state.dialogs ?? {}).length > 1 ? { dialogs: Object.values(state.dialogs) } : {}),
    // attachedSince (v3): when this tab's console/network capture began (lib/cdp.js attach), null when
    // it is not captured — the panel's "recording since 14:03", read from here.
    current: target
      ? { tabId: target.id, title: target.title ?? '', url: target.url ?? '', active: !!target.active, attachedSince: state.attachedSince?.[target.id] ?? null }
      : null,
    ...(asked != null && own && own.id !== target?.id
      ? { engineCurrent: { tabId: own.id, title: own.title ?? '', url: own.url ?? '', active: !!own.active } }
      : {}),
    ...(targetError ? { targetError } : {}),
    health,
    ...debuggerHealth(target?.id ?? null),
    tabs: { count: tabs.length, rows: tabs.slice(0, 25) },
    sessions,
    inputMode: state.inputMode,
    // (v3) Still a boolean for agents — "does auto-attach capture anything": the mode 'all', or
    // 'project' with project sites known. The mode itself ('off'|'project'|'all') is autoAttachMode
    // (the extension's only: a launched engine attaches every tab it has); as `autoAttach` the string
    // 'off' would read as true to any `if (status.autoAttach)`.
    autoAttach: state.autoAttach === 'all' || (state.autoAttach === 'project' && (state.projectDomains ?? []).length > 0),
    ...(platform.name === 'extension' ? { autoAttachMode: state.autoAttach } : {}),
    attachedCount: held.length,
    ...(warnings.length ? { warnings } : {}),
    hint: state.halted
      ? 'Stopped by the user. Everything except browser_status is blocked until they press Resume.'
      : target
        ? 'Ready. Start with browser_snapshot to see the page, then use the refs it returns.'
        : 'No tab to act on. Open one with browser_tabs action:"open", or ask the user to attach one ' +
          '(the G9BrowserAgent side panel, or auto-attach).',
  };
}

/**
 * (3.4) The tab's debugger session as the watchdog sees it: commands waiting longer than 5 s, and
 * domains whose enable did not answer at the last attach. Empty when all is well (nothing is added).
 */
function debuggerHealth(tabId) {
  if (tabId == null) return {};
  const slow = pendingCommands(tabId).filter((c) => c.ms > 5_000);
  const issues = attachIssuesOf(tabId);
  if (!slow.length && !issues) return {};
  return {
    debugger: {
      ...(slow.length ? { waitingCommands: slow } : {}),
      ...(issues ? { unansweredAtAttach: issues.unanswered } : {}),
      note: 'Commands on this tab are slow to answer (a throttled background page, or a stuck renderer). A call that runs past its deadline is ended and the tab recovered; browser_tabs action:"close" always works.',
    },
  };
}

// ------------------------------------------------------------- read-only

const READ_ONLY_RECORDING = new Set(['list', 'get', 'status', 'signature', 'known_world', 'export_spec', 'export', 'export_test']);
const READ_ONLY_ISSUE = new Set(['list', 'get', 'attachment']);
const READ_ONLY_NETWORK_ACTIONS = new Set(['downloads', 'pin_status', 'intercept_status']);
/** (3.4) Console actions that only read: a job's status and the job list. */
const READ_ONLY_CONSOLE_ACTIONS = new Set(['read', 'job_status', 'jobs']);

/**
 * Does this call only READ? The daemon lets any agent read any tab, and claims
 * a tab for the caller on its first mutating call (DAEMON_PROTOCOL §7), so the
 * answer decides ownership. When in doubt the answer is "mutating": a wrong
 * "read-only" would let two agents drive one tab at once.
 */
export function isReadOnly(tool, args = {}) {
  const a = args ?? {};
  switch (tool) {
    case 'browser_status':
    case 'browser_snapshot':
    case 'browser_inspect':
      return true;
    case 'browser_screenshot':
      // Only a viewport shot is a read. An element shot brings its element into view (trusted
      // wheel notches at human/stealth, scrollIntoView at off) and a full-page shot resizes the
      // viewport (captureBeyondViewport): both change the page under whoever is driving it. As
      // "reads" they skipped ownership and the per-tab queue, and another agent's element shot
      // scrolled the page under a humanized click in flight, whose press then landed on another
      // button (daemon review, 2026-09-22: 143-187 trusted wheel events, the wrong onclick ran).
      // Classified by the argument, not by level or page size: the router decides before the page
      // is measured, and both areas change the page at every level.
      return (a.area ?? 'viewport') === 'viewport';
    case 'browser_console':
      return READ_ONLY_CONSOLE_ACTIONS.has(a.action ?? 'read') && !a.clear;
    case 'browser_network':
      if (a.clear) return false;
      if (a.action == null || a.action === 'list') return true;
      // (3.4) A GET/HEAD fetch changes nothing in the page or on the server; anything else may.
      if (a.action === 'fetch') return ['GET', 'HEAD'].includes(String(a.method ?? 'GET').toUpperCase());
      return READ_ONLY_NETWORK_ACTIONS.has(a.action);
    case 'browser_diagnose':
      // A performance trace with reload:true reloads the page — that is not a read.
      return !(a.what === 'performance' && a.reload);
    case 'browser_recording':
      return READ_ONLY_RECORDING.has(a.action ?? 'list');
    case 'browser_issue':
      return READ_ONLY_ISSUE.has(a.action ?? 'list');
    case 'browser_tabs':
      // 'watch' (3.2) opens a live view for the person; nothing reaches the page.
      return ['list', 'sessions', 'watch'].includes(a.action ?? 'list');
    default:
      return false;
  }
}

/**
 * Does this call hold one of the daemon's maxParallel slots while it runs?
 *
 * Every mutating call does — except the waits. `browser_navigate action:"wait"`,
 * `browser_network action:"wait_download"` and `browser_tabs action:"wait"` only
 * poll the page (or the download list) until something appears, for up to their
 * timeoutMs. They stay MUTATING for ownership, the halt and the dialog rule —
 * an agent waiting on a tab is still driving it — but a slot is a share of the
 * machine's input and CPU budget, and a wait uses neither. Measured (P8 bench,
 * round 2): with maxParallel 1, another agent's click took 7.6 s instead of
 * 67 ms while one agent waited 8 s for text that never came; at 16 contexts
 * gated to 8, a wait queued 535–700 ms for a slot versus 15–23 ms ungated.
 */
export function holdsSlot(tool, args = {}) {
  if (isReadOnly(tool, args)) return false;
  const a = args ?? {};
  if (tool === 'browser_navigate' && a.action === 'wait') return false;
  if (tool === 'browser_network' && a.action === 'wait_download') return false;
  if (tool === 'browser_tabs' && a.action === 'wait') return false;
  return true;
}

// ---------------------------------------------------------------- pipeline

/**
 * Is a JavaScript dialog blocking THIS call's tab?
 *
 * A blocked renderer answers nothing, so without this every call on that tab
 * sits until its timeout before the agent learns why. Scoped to the dialog's
 * tab: with several agents on several tabs, one alert must not stop the rest.
 * `browser_dialog` is exempt — it is the way out.
 */
async function dialogBlocks(tool, args, state, tabId) {
  const dialogs = state.dialogs ?? {};
  if (!state.dialogOpen && !Object.keys(dialogs).length) return null;
  if (tool === 'browser_dialog') return null;
  // Tab management does not run in the blocked page: listing, opening, waiting for, naming,
  // focusing, closing and popping out tabs are the browser's own work. Only keep_awake talks to a
  // page. (3.5) This used to fall back to the engine's CURRENT tab, so a "Leave site?" there
  // stopped every agent from opening a new tab (field report).
  if (tool === 'browser_tabs' && args.action !== 'keep_awake') return null;
  // A dialog of unknown origin (state written by an older build) blocks everything, as before.
  if (state.dialogOpen && state.dialogOpen.tabId == null) return state.dialogOpen;
  const openOn = (id) => (id == null
    ? null
    : dialogs[id] ?? (state.dialogOpen?.tabId === id ? state.dialogOpen : null));
  // Tools without a target of their own: block only a mutating call aimed at a dialog's tab.
  if (tabId == null && isReadOnly(tool, args)) return null;
  const aimed = tabId ?? args.tabId ?? (args.session ? state.sessions?.[args.session] : null) ??
    (await tabsTool.peekTarget(state))?.id ?? null;
  const dialog = openOn(aimed);
  return dialog ? stillOpen(aimed, dialog) : null;
}

/**
 * (3.5) Is a recorded dialog really still open? A dialog the person answered in the browser, or one
 * a navigation took away, can leave its record behind when its "closed" event is missed (a worker
 * restart, a re-attach) — and the tab then refused every call although nothing was blocking it
 * (field report: browser_dialog's state "did not match reality"). A page frozen by a dialog cannot
 * evaluate anything, so a one-expression probe in G9's world answers it: it returns → the record is
 * stale and is forgotten. A dialog younger than DIALOG_TRUST_MS is taken as it is (it is real).
 */
export const DIALOG_TRUST_MS = 1_500;
const DIALOG_PROBE_MS = 700;

async function stillOpen(tabId, dialog) {
  if (tabId == null || Date.now() - (dialog.at ?? 0) < DIALOG_TRUST_MS) return dialog;
  // Raced as well: making G9's world on a frozen page can itself wait on the renderer.
  const alive = await Promise.race([
    inWorld(tabId, '1', { timeoutMs: DIALOG_PROBE_MS }).then(() => true, () => false),
    new Promise((resolve) => { setTimeout(() => resolve(false), DIALOG_PROBE_MS + 100).unref?.(); }),
  ]);
  if (!alive) return dialog;
  await forgetDialog(tabId).catch(() => {});
  void log({ kind: 'system', tabId, ok: true, detail: 'A recorded dialog was no longer open (the page answered); its record was cleared.' });
  return null;
}

/**
 * Run one tool call: halted → target → dialog → run → activity log.
 * Throws an Error on failure; the host turns that into its own reply shape.
 */
/**
 * (3.4) How long a call that was cancelled (its deadline passed, a per-agent Stop, a dialog) may
 * keep running before the watchdog recovers its tab (lib/cdp.js recoverTab): every CDP command still
 * waiting there is abandoned — so the call ends now, with the reason — and the tab's debugger session
 * is detached and attached again. Input that honours the cancel stops well inside this
 * (lib/humanize.js perform checks it between steps); only a call stuck in a command waits it out.
 */
export const WATCHDOG_GRACE_MS = 1_500;

export async function runTool(tool, args = {}, caller = null) {
  const started = Date.now();
  const callArgs = args ?? {};
  let tabId = null;
  let settled = false;
  let watchdog = null;
  let recovery = null;
  const by = caller ? (caller.name ?? caller.agentId ?? null) : null;
  // A call the daemon relayed (F7): the daemon reports it to the desktop itself,
  // so the host must not forward this record as a second copy. The panel's own
  // activity log still shows it.
  const tag = { ...(by ? { by } : {}), ...(caller?.relayed === true ? { relayed: true } : {}) };
  // The daemon's cancel for this call (deadline, dialog, a per-agent Stop): perform() stops its
  // input at the next step once it fires (lib/humanize.js bindCallSignal).
  const signal = caller?.signal && typeof caller.signal.aborted === 'boolean' ? caller.signal : null;
  let unbindSignal = () => {};

  try {
    const entry = TOOLS[tool];
    if (!entry) throw new Error(`Unknown tool "${tool}".`);
    if (signal?.aborted) throw new Error('This call was cancelled before it started; nothing was sent to the page.');

    const state = await getState();
    if (entry.allowWhenHalted !== true && state.halted) throw new Error(HALTED);

    let tab = null;
    if (entry.needsTab !== false) {
      // `session` is accepted on EVERY tab-taking tool, which is what makes a
      // two-tab flow expressible without a second protocol: the same click,
      // type and snapshot calls, addressed by name.
      tab = await tabsTool.resolveTarget(callArgs.tabId, callArgs.session ?? null);
      tabId = tab.id;
    }
    const unbindDeadline = bindCallDeadline(tabId ?? (Number.isInteger(callArgs.tabId) ? callArgs.tabId : null), caller?.deadlineAt);
    const priorUnbind = unbindSignal;
    unbindSignal = () => { priorUnbind(); unbindDeadline(); };
    if (signal) {
      const watched = tabId ?? (Number.isInteger(callArgs.tabId) ? callArgs.tabId : null);
      const unbind = bindCallSignal(watched, signal);
      const onAbort = () => {
        if (watched == null || watchdog) return;
        watchdog = setTimeout(() => {
          if (settled) return;
          recovery = recoverTab(watched, { reason: `"${tool}" ran past its deadline and did not stop` });
        }, WATCHDOG_GRACE_MS);
        watchdog.unref?.();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      unbindSignal = () => { unbind(); unbindDeadline(); signal.removeEventListener?.('abort', onAbort); };
    }

    if (entry.allowWhenHalted !== true) {
      const dialog = await dialogBlocks(tool, callArgs, state, tabId);
      if (dialog) {
        throw new Error(
          `The page is blocked by a JavaScript ${dialog.type} dialog: ` +
            `"${String(dialog.message ?? '').slice(0, 200)}". Nothing else will run on that tab until it is ` +
            `handled — call browser_dialog to accept or dismiss it, then retry this.`,
        );
      }
    }

    const result = await entry.run({ tabId, tab, args: callArgs, caller });

    // Not awaited (3.4): the activity log is written after the reply, never before it — a stalled
    // state write must not hold the answer (lib/state.js serialize).
    void log({ kind: 'tool', tool, tabId, ok: true, detail: summarize(tool, callArgs), ms: Date.now() - started, ...tag });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err?.message ?? err));
    tagDelivery(error);
    if (recovery || err?.recovered) {
      // The watchdog ended this call: say so, and what it did (bounded — the detach takes ≤ 3 s).
      const info = recovery ? await Promise.race([recovery, new Promise((r) => setTimeout(() => r(null), 4_000))]).catch(() => null) : null;
      error.recovered = info ?? { recovered: true };
      if (!/^\[recovered\]/.test(error.message)) {
        error.message = `[recovered] ${error.message} — the tab's debugger session was ${info?.detached ? 'detached and attached again' : 'reset'}` +
          `${info?.abandoned?.length ? ` (abandoned: ${info.abandoned.join(', ')})` : ''}; the tab is usable again. Take a browser_snapshot before acting on it.`;
      }
    }
    void log({
      kind: 'tool',
      tool,
      tabId,
      ok: false,
      detail: `${summarize(tool, callArgs)} — ${error.message}`,
      ms: Date.now() - started,
      ...tag,
    });
    throw error;
  } finally {
    settled = true;
    clearTimeout(watchdog);
    unbindSignal();
  }
}

/**
 * Put an input error's delivery state INTO its message: `[delivery: missed; hit <div#x>] …`.
 *
 * interact.js throws "not-delivered", "missed" (and "partial") with `err.delivery` / `err.hit` set,
 * and the agent guide promises every input result names its delivery state. But every relay keeps
 * only the message — the extension's WebSocket result, the daemon's reply, the MCP text — so the
 * agent received prose and could tell a click that landed ELSEWHERE (it may have done something)
 * from one that was never sent only by parsing English (live round 3, both engines). A fixed-format
 * tag at the start survives every hop; the fields stay on the Error for in-process callers and are
 * also carried as structured fields by the daemon protocol (DAEMON_PROTOCOL §3/§4).
 */
export function tagDelivery(error) {
  const state = typeof error?.delivery === 'string' ? error.delivery : null;
  if (!state || /^\[delivery: /.test(String(error.message ?? ''))) return error;
  const parts = [state];
  if (error.hit) parts.push(`hit ${error.hit}`);
  if (Number.isFinite(error.sent) && Number.isFinite(error.of)) parts.push(`${error.sent} of ${error.of} input events sent`);
  if (error.hidden === true) parts.push('tab hidden');
  error.message = `[delivery: ${parts.join('; ')}] ${error.message}`;
  return error;
}

/** The activity log is the trust surface; a failure to write it must not change a tool's result. */
async function log(entry) {
  try {
    const record = await logActivity(entry);
    emit('activity', record);
  } catch (err) {
    console.error('[G9BrowserAgent] activity log failed', err);
  }
}
