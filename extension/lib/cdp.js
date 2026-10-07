/**
 * The CDP choke point, over `platform.debugger`.
 *
 * Everything the agent can "see" or "do" at DevTools depth funnels through
 * send(). In the extension `platform.debugger` is `chrome.debugger`; in the
 * daemon it is a session on a launched browser's pipe. The API below did not
 * change in v2 — every tool module calls it exactly as before.
 */

import { platform } from './platform.js';
import { getState, updateState, logActivity } from './state.js';
import { sessionForNode } from './refs.js';

/**
 * Domains we enable on attach. Enabling is what makes events start flowing —
 * without Network.enable there are no requests, without Runtime.enable there
 * are no console messages.
 *
 * Except at the `stealth` level (rule R4): enabling Runtime changes how the
 * renderer serialises console arguments and is a known automation signal, so
 * it is never enabled there. The cost is page console capture, and
 * browser_console says so rather than returning an empty log.
 */
const AUTO_ENABLE = ['Page', 'Runtime', 'Log', 'Network', 'DOM'];

/**
 * (3.4) Every step of an attach is bounded. A field incident on a browser node: an evaluate on a
 * background tab Engine 1 had just opened hung for 120 s, and afterwards even `browser_tabs close`
 * timed out until the container was restarted. Nothing before a command had a deadline — the
 * debugger attach, the domain enables, Target.setAutoAttach — so one command a throttled or frozen
 * page never answered held the attach, and every later call on that tab waited behind it.
 * `CSS` left the attach set at the same time: no capture needs it, and it is the enable most likely
 * to block on a background page; `inspect styles` enables it when it is used (ensureDomain).
 */
export const ATTACH_TIMEOUT_MS = 10_000;
export const ENABLE_TIMEOUT_MS = 5_000;

function isStealth(tabId) {
  try {
    return platform.settings.stealthFor(tabId) === 'stealth';
  } catch {
    return false;
  }
}

function autoEnableFor(tabId) {
  return isStealth(tabId) ? AUTO_ENABLE.filter((d) => d !== 'Runtime') : AUTO_ENABLE;
}

const STEALTH_RUNTIME =
  'The Runtime domain is disabled at the "stealth" level (enabling it is a known automation signal). ' +
  'Page console capture is unavailable here; evaluation still works through isolated worlds.';

/** In-memory caches. Rebuilt after a service-worker restart, so never trusted. */
const enabled = new Set();

export class CdpError extends Error {
  constructor(message, { method, tabId } = {}) {
    super(message);
    this.name = 'CdpError';
    this.method = method;
    this.tabId = tabId;
  }
}

/** Is the debugger already attached to this tab (by us or anyone)? */
async function isAttached(tabId) {
  const targets = await bounded(platform.debugger.getTargets(), ENABLE_TIMEOUT_MS, 'debugger.getTargets', tabId);
  return targets.some((t) => t.tabId === tabId && t.attached);
}

/** `promise`, or a CdpError naming `what` once `ms` have passed (the promise is left to settle alone). */
function bounded(promise, ms, what, tabId = null) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CdpError(
        `"${what}" did not return after ${Math.round(ms / 1000)}s — the browser accepted it and never answered.`,
        { method: what, tabId },
      )), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** tabId → the attach in progress: two calls on one tab share it instead of attaching twice. */
const attaching = new Map();

/**
 * (3.4) Domains whose enable did not answer at the last attach, per tab — they are NOT marked
 * enabled, so ensureDomain asks again when a tool needs one. Reported by recoverTab and status.
 */
const attachIssues = new Map();
export function attachIssuesOf(tabId) {
  return attachIssues.get(tabId) ?? null;
}

/**
 * Tab ids the BROWSER reports as being debugged, by anyone.
 *
 * This is the only source of truth for "is the banner still up". Our
 * `attachedTabs` list is bookkeeping and can drift from it — which is exactly
 * the drift that made a failed detach invisible.
 */
export async function attachedTabIds() {
  const targets = await platform.debugger.getTargets();
  return targets.filter((t) => t.attached && t.tabId != null).map((t) => t.tabId);
}

export function attach(tabId, opts = {}) {
  // One attach per tab at a time: a second call while the first is still enabling domains waits for
  // it instead of starting another debugger attach (each would have its own unbounded wait).
  const running = attaching.get(tabId);
  if (running) return running;
  const run = attachOnce(tabId, opts).finally(() => {
    if (attaching.get(tabId) === run) attaching.delete(tabId);
  });
  attaching.set(tabId, run);
  return run;
}

async function attachOnce(tabId, { log = true } = {}) {
  const state = await getState();
  if (state.attachedTabs.includes(tabId) && (await isAttached(tabId))) return;

  // A NEW debugger session starts capture now (attachedSince, below); one found still attached
  // from before a worker restart has been capturing all along and keeps its start time.
  let fresh = true;
  try {
    await bounded(platform.debugger.attach(tabId, { timeoutMs: ATTACH_TIMEOUT_MS }), ATTACH_TIMEOUT_MS, 'debugger.attach', tabId);
  } catch (err) {
    const msg = String(err?.message ?? err);
    // Another client (a real DevTools window, or a previous session we lost
    // track of) already owns this tab. That is recoverable only by the user.
    if (msg.includes('Another debugger') || msg.includes('already attached')) {
      if (!(await isAttached(tabId))) throw new CdpError(msg, { tabId });
      // It's us from before the SW restarted — carry on.
      fresh = false;
    } else {
      throw new CdpError(msg, { tabId });
    }
  }

  // (3.4) Sent together and each bounded: one domain a throttled page does not answer no longer
  // holds the attach (and every call behind it). A domain that did not answer is not marked
  // enabled, so ensureDomain asks for it again when a tool needs it.
  const late = [];
  await Promise.all(autoEnableFor(tabId).map(async (domain) => {
    try {
      await bounded(rawSend(tabId, `${domain}.enable`, {}, null, ENABLE_TIMEOUT_MS), ENABLE_TIMEOUT_MS, `${domain}.enable`, tabId);
      enabled.add(`${tabId}:${domain}`);
    } catch (err) {
      /* some domains are unavailable on some target types; not fatal */
      if (/did not return/.test(String(err?.message))) late.push(domain);
    }
  }));

  // Attach to cross-origin children as they appear.
  //
  // Done here rather than on demand because a frame that loads before anyone
  // asks for a snapshot would otherwise never be attached, and the symptom is
  // the old one: the iframe is right there on screen and has no nodes. Failure
  // is non-fatal — on a browser without flat-session support (before Chrome
  // 125) this simply does nothing and same-origin work is unaffected.
  try {
    await bounded(rawSend(tabId, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }, null, ENABLE_TIMEOUT_MS), ENABLE_TIMEOUT_MS, 'Target.setAutoAttach', tabId);
  } catch (err) {
    /* older Chrome, or a target type that has no children */
    if (/did not return/.test(String(err?.message))) late.push('Target.setAutoAttach');
  }
  if (late.length) attachIssues.set(tabId, { at: Date.now(), unanswered: late });
  else attachIssues.delete(tabId);
  // A tab kept awake (browser_tabs open keepAwake:true) loses its emulation with its debugger
  // session; a re-attach (the watchdog's, a worker restart's) puts it back.
  if (await isKeptAwake(tabId)) await wakeCommands(tabId, true).catch(() => {});

  // One step of the state chain, read and write together: two attaches finishing at the same moment
  // (auto-attach on several loading tabs, two agents on two tabs) each read [] and wrote [itself],
  // and one tab was lost from attachedTabs — Detach then left it debugged while reporting a clean
  // release, and Stealth never reached it (extension review, 2026-09-22: 20/20 stub runs).
  // (3.4) Bounded: a stalled state write must not hold the call that needed the attach.
  await bounded(updateState((s) => noteAttached(s, tabId, fresh)), ENABLE_TIMEOUT_MS, 'state write (attach)', tabId).catch(() => {});
  // `log: false` — the caller writes the one activity line itself (the panel's Record from now,
  // which may reload the page too: one gesture, one line). Not awaited (3.4): the activity log
  // never holds a call.
  if (log) logActivity({ kind: 'attach', tabId, ok: true }).catch(() => {});
}

/**
 * The state patch for "tab N is attached": listed in attachedTabs, and its capture start time
 * (attachedSince, v3 — the panel's "recording since 14:03") set when the session is new or none
 * is known. null when nothing changes. Runs inside updateState: never a read-modify-write of its own.
 */
function noteAttached(s, tabId, fresh) {
  const since = s.attachedSince ?? {};
  const patch = {};
  if (!s.attachedTabs.includes(tabId)) patch.attachedTabs = [...s.attachedTabs, tabId];
  if (fresh || since[tabId] == null) patch.attachedSince = { ...since, [tabId]: Date.now() };
  return Object.keys(patch).length ? patch : null;
}

/** attachedTabs and attachedSince without these tabs (a detach, a closed tab) — for updateState. */
export function forgetAttached(s, tabIds) {
  const gone = new Set(tabIds.map(String));
  const since = Object.fromEntries(Object.entries(s.attachedSince ?? {}).filter(([id]) => !gone.has(id)));
  return { attachedTabs: s.attachedTabs.filter((id) => !gone.has(String(id))), attachedSince: since };
}

// ------------------------------------------------------------------ keep awake (3.4)

const KEEP_AWAKE_KEY = 'g9:keepAwake';

async function keptAwake() {
  try {
    const stored = await platform.storage.session.get(KEEP_AWAKE_KEY);
    return Array.isArray(stored?.[KEEP_AWAKE_KEY]) ? stored[KEEP_AWAKE_KEY] : [];
  } catch {
    return [];
  }
}

async function isKeptAwake(tabId) {
  return (await keptAwake()).includes(tabId);
}

/**
 * What "keep awake" sends, each bounded: focus emulation (the page believes it has focus, as in a
 * window in front: document.hasFocus(), focus/blur, :focus-visible), and the page lifecycle set to
 * active (a frozen background page — Memory Saver, tab freezing — runs its timers and tasks again).
 * Timer throttling of a hidden page is a browser switch, not a command: launched engines start with
 * --disable-background-timer-throttling; in the person's own browser the policy
 * IntensiveWakeUpThrottlingEnabled=0 (the desktop app sets it) keeps a hidden page's timers at least
 * once a second instead of once a minute. → { focusEmulation, lifecycle }
 */
async function wakeCommands(tabId, on) {
  const out = {};
  await bounded(rawSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: !!on }, null, ENABLE_TIMEOUT_MS), ENABLE_TIMEOUT_MS, 'Emulation.setFocusEmulationEnabled', tabId)
    .then(() => { out.focusEmulation = !!on; }, (err) => { out.focusEmulation = `failed: ${err.message}`; });
  if (on) {
    await bounded(rawSend(tabId, 'Page.setWebLifecycleState', { state: 'active' }, null, ENABLE_TIMEOUT_MS), ENABLE_TIMEOUT_MS, 'Page.setWebLifecycleState', tabId)
      .then(() => { out.lifecycle = 'active'; }, (err) => { out.lifecycle = `failed: ${err.message}`; });
  }
  return out;
}

/**
 * Keep a tab working while it is in the background (long in-page work: rendering, uploads). Stored
 * per tab in storage.session and applied again after every re-attach. → what was applied.
 */
export async function keepAwake(tabId, on = true) {
  await attach(tabId);
  const applied = await wakeCommands(tabId, on);
  const list = (await keptAwake()).filter((id) => id !== tabId);
  if (on) list.push(tabId);
  await platform.storage.session.set({ [KEEP_AWAKE_KEY]: list }).catch(() => {});
  return {
    keepAwake: !!on,
    ...applied,
    timerThrottling: platform.name === 'extension'
      ? "a hidden tab's timers are throttled by the browser; with the IntensiveWakeUpThrottlingEnabled=0 policy (the G9BrowserAgent app sets it) at most once a second"
      : 'off (launched with --disable-background-timer-throttling)',
  };
}

/** Forget a closed tab's keep-awake entry. */
export async function forgetKeepAwake(tabId) {
  const list = await keptAwake();
  if (list.includes(tabId)) await platform.storage.session.set({ [KEEP_AWAKE_KEY]: list.filter((id) => id !== tabId) }).catch(() => {});
}

/** Tabs whose Runtime domain this extension enabled (the stealth switch must reach every one). */
export function runtimeEnabledTabs() {
  const out = [];
  for (const key of enabled) {
    const m = /^(\d+):Runtime$/.exec(key);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/**
 * attach() for a launched-engine target that is HELD (waitForDebuggerOnStart) and about to be
 * resumed — engine/manager.js #prepareTab, never the extension.
 *
 * The domains' commands are SENT now, synchronously, and not awaited: a target=_blank tab answers
 * nothing while it is held (Network.enable did not return in 8 s, Edge 153), yet every command sent
 * before Runtime.runIfWaitingForDebugger is applied, in order, before its first document runs —
 * measured on Edge and Chrome 153: its document request, first subresources and failed fetch all
 * captured, and a timezone override seen by its first script. Awaiting them instead held the tab
 * until platform-cdp's budget ran out (3 s later) and then resumed it UNprepared: the first load's
 * network was missed (live round 4). The bookkeeping (attachedTabs, the activity log) follows the
 * answers. → a promise for the answers.
 */
export function attachHeld(tabId) {
  const answers = [];
  for (const domain of autoEnableFor(tabId)) {
    answers.push(rawSend(tabId, `${domain}.enable`).then(() => { enabled.add(`${tabId}:${domain}`); }, () => {}));
  }
  // Cross-origin frames, as attach() does (platform-cdp holds each one until it is prepared).
  answers.push(rawSend(tabId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {}));
  return Promise.all(answers).then(async () => {
    await updateState((s) => noteAttached(s, tabId, true));
    await logActivity({ kind: 'attach', tabId, ok: true });
  });
}

/**
 * Detach from several tabs at once, and check that it worked.
 *
 * Batched deliberately. The first version verified per tab, which meant N
 * `getTargets()` round trips plus N pairs of serialized state writes — and the
 * user is watching the debugger banner the whole time. Detaching is independent
 * per tab, so the calls go out together and one `getTargets()` answers for all
 * of them.
 *
 * The verification is the point: the old code caught the failure with
 * `catch { /* already gone *​/ }`, dropped the tab from `attachedTabs` anyway,
 * and logged `ok: true`. "Already gone" is a guess about why the call failed —
 * the call never says that — and when the guess was wrong the banner stayed up
 * while the extension reported a clean detach.
 */
export async function detachMany(tabIds) {
  const started = Date.now();
  const ids = [...new Set(tabIds)].filter((id) => id != null);
  if (!ids.length) return [];

  const errors = new Map();
  await Promise.all(
    ids.map(async (id) => {
      try {
        await bounded(platform.debugger.detach(id), 5_000, 'debugger.detach', id);
      } catch (err) {
        errors.set(id, String(err?.message ?? err));
      }
    }),
  );

  for (const key of [...enabled]) {
    if (ids.some((id) => key.startsWith(`${id}:`))) enabled.delete(key);
  }

  // A launched engine's tabs stay attached for their whole life — there is no
  // banner, and "detach" only means we stop holding them. Verifying there would
  // report every one of them as stuck behind a DevTools window that does not exist.
  const stillAttached = platform.name === 'cdp'
    ? new Set()
    : new Set(await attachedTabIds().catch(() => []));

  await updateState((s) => forgetAttached(s, ids));

  const results = ids.map((id) => ({
    tabId: id,
    detached: !stillAttached.has(id),
    stillAttached: stillAttached.has(id),
    error: errors.get(id) ?? null,
  }));

  const stuck = results.filter((r) => r.stillAttached);
  await logActivity({
    kind: 'detach',
    ok: !stuck.length,
    ms: Date.now() - started,
    detail: stuck.length
      ? `released ${ids.length - stuck.length}/${ids.length}; ${stuck.length} still debugged by another client (DevTools open on that tab)`
      : `released ${ids.length} tab(s)`,
  });

  return results;
}

export async function detach(tabId) {
  const [result] = await detachMany([tabId]);
  return result ?? { tabId, detached: true, stillAttached: false, error: null };
}

/** Detach from every tab we hold. Returns one result per tab. */
export async function detachAll() {
  const state = await getState();
  return detachMany(state.attachedTabs);
}

/**
 * Send without the attach guard — used during attach itself.
 *
 * `sessionId` routes the command to a CHILD target: a cross-origin iframe, or a
 * worker. Chrome 125 added flat sessions to `chrome.debugger`, which is what
 * makes this a property on the debuggee rather than a second `attach` call per
 * frame. Without it, a cross-origin iframe is visible and untouchable — the tab
 * session simply has no nodes for a document that lives in another process.
 */
function rawSend(tabId, method, params = {}, sessionId = null, timeoutMs = null) {
  return platform.debugger.sendCommand(tabId, method, params, sessionId, timeoutMs ? { timeoutMs } : {});
}

/**
 * How long any single CDP command may take before we stop waiting.
 *
 * Some commands can wedge and never resolve at all. `Input.dispatchMouseEvent`
 * with `mouseWheel` does it reliably while `Page.startScreencast` is running:
 * the promise simply never settles. Without a bound, that consumed the bridge's
 * entire 60s tool budget and then produced a diagnosis that was not merely
 * unhelpful but WRONG — "the page may be blocked by a JavaScript dialog" — and
 * sent whoever read it looking in the wrong place. Bounding it here means one
 * stuck command reports itself, by name, instead of poisoning the call.
 *
 * Comfortably longer than any healthy command, and comfortably shorter than the
 * daemon's call timeout, so this error wins the race and the agent learns
 * something.
 *
 * A few commands are legitimately slow rather than stuck — capturing a large
 * page, or ending a trace — and cutting those off would invent a failure where
 * there was only patience required. They get their own budget. Callers can
 * override per call. The table is exported so engine/pipe-cdp.js applies the
 * same budgets to the launched engine's transport.
 */
export const COMMAND_TIMEOUT_MS = 20_000;

export const SLOW_COMMANDS = new Map([
  ['Page.captureScreenshot', 45_000],
  ['Page.getLayoutMetrics', 30_000],
  ['Tracing.end', 45_000],
  ['IO.read', 45_000],
]);

/** The budget for one command. */
export function timeoutFor(method, override = null) {
  return override ?? SLOW_COMMANDS.get(method) ?? COMMAND_TIMEOUT_MS;
}

/**
 * Commands that answer only when a navigation COMMITS — after the server's response headers. When
 * one of them runs out of time the likely cause is the SERVER, not a stuck browser: "stuck rather
 * than slow — the browser never answered" sent people looking at the browser while a cold server
 * took 25 s to answer (live round 3). navigate.js gives them the call's own deadline.
 */
export const NAVIGATION_COMMANDS = new Set(['Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry']);

/** The sentence for a command that ran out of time. "did not return after" is matched by callers. */
export function timeoutMessage(method, timeoutMs) {
  const s = Math.round(timeoutMs / 1000);
  if (NAVIGATION_COMMANDS.has(method)) {
    return `The CDP command "${method}" did not return after ${s}s. A navigation command answers when the server's ` +
      `response headers arrive, so the server most likely did not answer within ${s} s (slow, overloaded or ` +
      `unreachable) — this is not a stuck browser, and the navigation may still complete in the background. ` +
      `Pass a larger timeoutMs if the server is known to be slow, or check that it is up.`;
  }
  return `The CDP command "${method}" did not return after ${s}s. ` +
    `The command is stuck rather than slow — the browser accepted it and never answered.`;
}

/**
 * (3.4) Every command `send()` is waiting for, per tab: what the watchdog (recoverTab) abandons when
 * a call on that tab ran past its deadline. tabId → Set<{ method, startedAt, reject }>.
 */
const inflight = new Map();

function withTimeout(promise, method, tabId, timeoutMs) {
  let timer;
  let entry;
  const raced = new Promise((resolve, reject) => {
    entry = { method, startedAt: Date.now(), reject };
    let set = inflight.get(tabId);
    if (!set) inflight.set(tabId, (set = new Set()));
    set.add(entry);
    timer = setTimeout(
      () => reject(new CdpError(timeoutMessage(method, timeoutMs), { method, tabId })),
      timeoutMs,
    );
    Promise.resolve(promise).then(resolve, reject);
  });
  return raced.finally(() => {
    clearTimeout(timer);
    const set = inflight.get(tabId);
    set?.delete(entry);
    if (set && !set.size) inflight.delete(tabId);
  });
}

/** (3.4) The CDP commands waiting on a tab right now: [{ method, ms }] (oldest first). */
export function pendingCommands(tabId) {
  const now = Date.now();
  return [...(inflight.get(tabId) ?? [])].map((e) => ({ method: e.method, ms: now - e.startedAt }));
}

/**
 * (3.4) The watchdog: give a tab whose call ran past its deadline a working debugger session again.
 *
 * Every CDP command still waiting on the tab is rejected now (its call fails with the reason, the
 * tab's queue is free again), what was enabled is forgotten, and — in the person's browser — the
 * debugger is DETACHED and attached again (chrome.debugger.detach), which ends whatever the old
 * session was blocked on. A launched engine keeps its page session (there is nothing to detach;
 * platform-cdp's detach is a no-op): its domains are enabled again. Each step is bounded; the
 * re-attach happens in the background unless `wait`. Never throws.
 * → { tabId, recovered:true, abandoned:[method…], detached, reattached, ms, problem? }
 */
export async function recoverTab(tabId, { reason = 'a call on it ran past its deadline', wait = false, reattach = true, detach = true } = {}) {
  const started = Date.now();
  const pending = [...(inflight.get(tabId) ?? [])];
  inflight.delete(tabId);
  const abandoned = pending.map((e) => e.method);
  for (const e of pending) {
    // Worded so send() does not take it for a navigation's detach and retry the command.
    const err = new CdpError(
      `The CDP command "${e.method}" was abandoned: G9BrowserAgent recovered this tab's debugger session (${reason}).`,
      { method: e.method, tabId },
    );
    err.recovered = true;
    e.reject(err);
  }
  attaching.delete(tabId);
  forgetTab(tabId);
  let detached = false;
  let problem = null;
  if (platform.name === 'extension' && detach) {
    try {
      await bounded(platform.debugger.detach(tabId), 3_000, 'debugger.detach', tabId);
      detached = true;
    } catch (err) {
      problem = String(err?.message ?? err);
    }
  }
  // Both engines: without this the re-attach below finds the tab listed as attached and returns at
  // once — on a launched engine the domains (and a keep-awake) were then never applied again.
  await bounded(updateState((s) => forgetAttached(s, [tabId])), 3_000, 'state write (recover)', tabId).catch(() => {});
  const again = reattach
    ? attach(tabId, { log: false }).then(() => true, (err) => { problem = problem ?? String(err?.message ?? err); return false; })
    : Promise.resolve(false);
  const reattached = wait ? await again : null;
  logActivity({ kind: 'recover', tabId, ok: true, detail: `recovered tab ${tabId} (${reason}); abandoned ${abandoned.length ? abandoned.join(', ') : 'nothing'}` }).catch(() => {});
  return {
    tabId, recovered: true, reason, abandoned, detached, ...(reattached != null ? { reattached } : { reattaching: reattach }),
    ms: Date.now() - started, ...(problem ? { problem } : {}),
  };
}

/**
 * The PERSON's own side-panel commands under Stop (asPerson): tabId → how many are running.
 *
 * Stop blocks AGENTS. It used to block the person too: with Stop on, the panel could not save the
 * recording running on the tab, nor capture a screenshot or video for an issue — only Resume,
 * which lets the queued agent calls change the page first (extension review, 2026-09-22).
 * While a person's command runs on a tab, that tab's CDP commands pass the halt — but only these
 * methods: reading, capturing and cleaning up. Never Input.*, never a navigation, never a page
 * script in the main world: an agent call that was in flight when Stop was pressed cannot slip
 * input through the same window.
 */
const personOnTab = new Map();
const PERSON_METHODS = new Set([
  'Page.captureScreenshot', 'Page.getLayoutMetrics', 'Page.removeScriptToEvaluateOnNewDocument', 'Page.startScreencast',
  'Page.stopScreencast', 'Page.screencastFrameAck', 'Page.getFrameTree', 'Page.getNavigationHistory', 'Page.createIsolatedWorld',
  'Runtime.removeBinding', 'Runtime.callFunctionOn', 'Runtime.releaseObject', 'Runtime.getProperties',
  'DOM.getDocument', 'DOM.describeNode', 'DOM.resolveNode', 'DOM.getBoxModel', 'DOM.getContentQuads',
  'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride', 'Emulation.setDefaultBackgroundColorOverride',
  'Target.setAutoAttach',
]);

function personMayPass(tabId, method, params) {
  if (!(personOnTab.get(tabId) > 0)) return false;
  if (PERSON_METHODS.has(method)) return true;
  // G9BrowserAgent's own isolated world only (a contextId): never an expression in the page's main world.
  return method === 'Runtime.evaluate' && params?.contextId != null;
}

/** Run a person's own panel command on `tabId` so it works while Stop is on (see personOnTab). */
export async function asPerson(tabId, fn) {
  personOnTab.set(tabId, (personOnTab.get(tabId) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const left = (personOnTab.get(tabId) ?? 1) - 1;
    if (left > 0) personOnTab.set(tabId, left);
    else personOnTab.delete(tabId);
  }
}

/**
 * Send a CDP command, attaching first if needed.
 * This is the single choke point for every deep browser operation.
 */
export async function send(tabId, method, params = {}, options = {}) {
  const timeoutMs = timeoutFor(method, options.timeoutMs ?? null);
  const sessionId = options.sessionId ?? null;
  const state = await getState();
  if (state.halted && !personMayPass(tabId, method, params)) throw new CdpError('Agent is halted by the user (Stop was pressed)', { method, tabId });
  if (method === 'Runtime.enable' && isStealth(tabId)) throw new CdpError(STEALTH_RUNTIME, { method, tabId });

  await attach(tabId);

  try {
    const result = await withTimeout(rawSend(tabId, method, params, sessionId, timeoutMs), method, tabId, timeoutMs);
    return result ?? {};
  } catch (err) {
    if (err?.recovered) throw err;
    const msg = String(err?.message ?? err);
    // A navigation can tear down the session mid-command. One retry after
    // re-attaching resolves the overwhelming majority of these.
    //
    // A CHILD session is not re-created by re-attaching to the tab, so retrying
    // one would send the command to a session that no longer exists. A frame
    // that went away is reported, and the caller takes a fresh snapshot.
    if (!sessionId && (msg.includes('Detached') || msg.includes('not attached') || msg.includes('Target closed'))) {
      await attach(tabId);
      const result = await withTimeout(rawSend(tabId, method, params, null, timeoutMs), method, tabId, timeoutMs);
      return result ?? {};
    }
    if (sessionId && (msg.includes('Session') || msg.includes('not attached') || msg.includes('Target closed'))) {
      throw new CdpError(
        `${msg} — that cross-origin frame is gone (it navigated or was removed). Take a fresh browser_snapshot.`,
        { method, tabId },
      );
    }
    throw new CdpError(msg, { method, tabId });
  }
}

/**
 * Send a command on a session we already know is live, skipping every guard.
 *
 * `send()` pays for its safety on every call: a halt check, an attach check,
 * and inside `attach()` a `platform.debugger.getTargets()` round trip. That is
 * the right price for a tool call. It is the wrong price for answering a
 * high-frequency event on a session that just proved it exists by DELIVERING
 * that event — the screencast frame ack is the case that matters, and paying
 * full price per frame starved the worker badly enough that an ordinary scroll
 * during a recording timed out after 60s.
 *
 * Use this ONLY to respond to an event from the same tab, never to start work.
 * There is no halt check here, which is safe for an ack and would not be for
 * anything the agent asked for. `sessionId` answers an event from a child.
 */
export function sendOnLiveSession(tabId, method, params = {}, sessionId = null) {
  return rawSend(tabId, method, params, sessionId);
}

/**
 * Forget what was enabled on a tab whose debugger session is gone.
 *
 * A detach (the user closed the banner, DevTools took the tab, a launched
 * page's session died) takes every enabled domain with it. The re-attach turns
 * the AUTO_ENABLE set back on, but anything `ensureDomain` switched on later
 * would still be marked enabled here and never be enabled again. Called by
 * tools/events.js on detach and on tab removal.
 */
export function forgetTab(tabId) {
  const prefix = `${tabId}:`;
  for (const key of [...enabled]) if (key.startsWith(prefix)) enabled.delete(key);
}

/** Ensure a domain is enabled before relying on its events. */
export async function ensureDomain(tabId, domain, params = {}) {
  const key = `${tabId}:${domain}`;
  if (enabled.has(key)) return;
  if (domain === 'Runtime' && isStealth(tabId)) throw new CdpError(STEALTH_RUNTIME, { tabId });
  try {
    await send(tabId, `${domain}.enable`, params);
    enabled.add(key);
  } catch (err) {
    throw new CdpError(`Could not enable ${domain}: ${err.message}`, { tabId });
  }
}

/**
 * Bring an attached tab's Runtime domain in line with its current level.
 *
 * `attach()` decides once, and a tab stays attached for a long time. When the
 * panel switches to `stealth`, Runtime must actually go OFF on the tabs already
 * held — a setting that only applied to the next attach would leave in place
 * the very signal it exists to remove. Switching back re-enables it, so console
 * capture resumes without a re-attach.
 */
export async function applyStealthLevel(tabId) {
  const key = `${tabId}:Runtime`;
  if (isStealth(tabId)) {
    await rawSend(tabId, 'Runtime.disable').catch(() => {});
    enabled.delete(key);
    return { tabId, runtime: 'disabled' };
  }
  if (!enabled.has(key)) {
    await rawSend(tabId, 'Runtime.enable').catch(() => {});
    enabled.add(key);
  }
  return { tabId, runtime: 'enabled' };
}

/**
 * Evaluate an expression in the page's MAIN world and return a plain JS value.
 *
 * This is for `browser_console action:"evaluate"` — the agent asking about the
 * page's own JavaScript. G9BrowserAgent's internal page reads use lib/world.js instead, so
 * nothing G9BrowserAgent runs is visible to (or disturbable by) the page's own globals.
 */
export async function evaluate(tabId, expression, { awaitPromise = true, returnByValue = true, timeoutMs = null } = {}) {
  // (3.4) `timeoutMs`: an awaited promise may legitimately take minutes (a render, an upload); the
  // command budget is the caller's then, not the 20 s meant for a stuck command.
  const res = await send(tabId, 'Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue,
    userGesture: true,
  }, timeoutMs ? { timeoutMs } : {});
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new CdpError(d.exception?.description ?? d.text ?? 'Script threw', { tabId });
  }
  return res.result?.value;
}

/**
 * (3.4) The AGENT's or the FLOW's own expression, in the page's MAIN world — the deliberate exception
 * to "everything G9BrowserAgent evaluates runs in its isolated world" (§4.7), for the same reason as
 * `browser_console evaluate`: the expression is about the page's own JavaScript. FlowSpec evaluate
 * steps use it (the interaction suite's source scan keeps every other main-world call out of the
 * tools). → the raw Runtime.evaluate answer ({ result, exceptionDetails? }), so a caller can read a
 * value CDP could only name (NaN, Infinity, a bigint: `unserializableValue`).
 */
export function evaluateUserExpression(tabId, expression, { awaitPromise = true, timeoutMs = null } = {}) {
  return send(tabId, 'Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  }, timeoutMs ? { timeoutMs } : {});
}

/** Call a function with `this` bound to a specific DOM node (main world). */
export async function callOnNode(tabId, backendNodeId, fnDecl, args = [], sessionId = null) {
  // `sessionId` is the fifth parameter and not the fourth on purpose: `args`
  // was already there and callers pass it positionally, so inserting ahead of
  // it would have silently handed a session string to `args.map`.
  //
  // When the caller does not say, ASK. Every node this extension acts on came
  // from a snapshot, and the snapshot recorded which frame it lives in — so the
  // routing is knowable without a dozen call sites each remembering to pass it.
  const resolved = sessionId ?? await sessionForNode(tabId, backendNodeId);
  const opts = { sessionId: resolved };
  const { object } = await send(tabId, 'DOM.resolveNode', { backendNodeId }, opts);
  if (!object?.objectId) throw new CdpError('Node is no longer in the document', { tabId });
  try {
    const res = await send(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: fnDecl,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, opts);
    if (res.exceptionDetails) {
      throw new CdpError(res.exceptionDetails.exception?.description ?? 'Call threw', { tabId });
    }
    return res.result?.value;
  } finally {
    await send(tabId, 'Runtime.releaseObject', { objectId: object.objectId }, opts).catch(() => {});
  }
}
