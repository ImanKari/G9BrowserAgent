/**
 * The Session view: is the daemon connected, who is connected through it,
 * which tab is the agent on, how does its input look, and what has it done.
 *
 * This is the trust surface. Everything here answers one of those questions,
 * and the Stop button must work even when the daemon is wedged.
 *
 * ## What v2 took out, and why nothing replaced it
 *
 * The four modes and the workspace allowlist are gone (decision D6): attaching a
 * tab gives agents that tab, fully. The modes were a product boundary on a
 * local, trusted deployment; the operational safeguards — Stop and the activity
 * log — stay, because they are how a person stays in charge of what is running
 * in their own browser. Bridge discovery is gone too: one daemon, one port.
 *
 * ## What v3 changed (U1–U5, AIGuide §6.10)
 *
 * - The big "Attach current tab" button is gone (U1): the daemon pins each
 *   agent's tab on its first call, so its only remaining job was to start
 *   console/network capture early. "Record from now" says exactly that.
 * - Auto-attach has three settings, default Project sites (U2): all-tabs
 *   capture shares one storage quota, enables Runtime on every site and keeps
 *   the debugging bar up everywhere.
 * - Pop out and Send to background are offered when they are needed — a toast
 *   when an agent's tab is hidden (U3) — and otherwise are one line each.
 * - Agents can be told apart: project and current tab (U4). The daemon line no
 *   longer names a project: it was whichever session started the daemon.
 * - The current tab's URL is origin plus a truncated path (U5): a signed URL
 *   used to fill a third of the panel.
 *
 * Every command used here is in ARCHITECTURE_V2 §13; setup/unit/panel.test.mjs
 * checks that, so a renamed command fails a test instead of a button.
 */

import { displayUrl } from '../lib/sites.js';
import {
  el, cmd, node, btn, chip, toast, showPanelError, view, setTitle, VERSION, hm, middle, prefs, copyText, keepFocus,
} from './ui.js';
import { renderUpdateNote, noteDaemon } from './about.js';

const DEFAULT_PORT = 8765;

/** (3.2) "Watch": the live view of a tab this browser cannot show (a launched one, often headless). */
function watchButton(handle, agentName) {
  return btn('◉ Watch', 'link', () => openWatch(handle), {
    title: `A live view of ${agentName ?? 'the agent'}'s tab, with its cursor — in its own window, view only`,
    key: `watch:${handle}`,
  });
}

/** Open (or bring up) the live-view window, on a tab or on its picker. */
export async function openWatch(handle = null) {
  const res = await cmd({ cmd: 'openWatch', ...(Number.isInteger(handle) ? { handle } : {}) }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
  if (!res?.ok) showPanelError(res?.error ?? 'Could not open the live view.');
}
/** How stale the tab list may get before a render asks again. */
const TABS_TTL_MS = 5_000;
/** Daemon info (engines) changes rarely; a person can press "refresh". */
const INFO_TTL_MS = 10_000;
const INPUT_LEVELS = ['off', 'human', 'stealth'];
const INPUT_NAMES = { off: 'Direct', human: 'Human', stealth: 'Stealth' };
const AUTO_MODES = ['off', 'project', 'all'];
const AUTO_NAMES = { off: 'Off', project: 'Project sites', all: 'All tabs' };
/** One line per auto-attach setting: what it attaches, and for 'all' what it costs. */
const AUTO_HELP = {
  off: 'Nothing attaches by itself: an agent attaches the tab it works on, or press Record from now.',
  project: 'Attaches tabs on connected agents’ project sites, so their console and network are recorded from the first load.',
  all: 'Attaches every tab you open or load — one shared capture quota, and the debugging bar on every tab.',
};
/** Whether the person unfolded the Engines list. */
const ENGINES_OPEN_KEY = 'g9.enginesOpen';
/** Blocked-tab toasts the person dismissed, by `${tabId}:${at}`, so a reopened panel does not repeat them. */
const DISMISSED_KEY = 'g9.blockedDismissed';

/** `listTabs` rows (§4.1 shape), for titles and window states that state alone does not carry. */
const tabRows = { at: 0, rows: [], pending: null, fromStatus: false };
/** Last `status` from getState, so a late tab list can repaint without another round trip. */
let lastStatus = null;
/** When the transport's next reconnect attempt is due, from its 'reconnecting' broadcast. */
let retryDueAt = null;
let retryTicker = null;
let infoAt = 0;
let infoPending = null;
let wasConnected = null;
/** The pushed agents list as last rendered, and whether `info`'s copy is older. See chooseAgents(). */
const agentsMemo = { key: null, infoStale: false };
/** What each button-bearing list last painted. See changed(). */
const painted = new Map();
/** Buttons whose command is in flight, so a double click is not a second handoff. */
const busy = { popout: false, handoff: false, input: false, auto: false, record: false };

let refreshing = null;
let again = false;

/**
 * Coalesced: every setState in the worker broadcasts 'state', and a burst of
 * those must not become a burst of round trips. One in flight, one queued.
 */
export function refresh({ nudge = false } = {}) {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  refreshing = pull({ nudge }).finally(() => {
    refreshing = null;
    if (again) {
      again = false;
      refresh();
    }
  });
  return refreshing;
}

async function pull({ nudge }) {
  let res;
  try {
    res = await cmd({ cmd: 'getState', nudge });
  } catch (err) {
    // The very first read races the worker waking up; a failure there is not news.
    showPanelError(nudge ? null : `Panel could not reach the extension: ${err?.message ?? err}`, { source: 'refresh' });
    return;
  }

  if (!res?.ok) return showPanelError(res?.error ?? 'The extension returned no state.', { source: 'refresh' });

  try {
    render(res.state ?? {}, res.status ?? null);
    // Clears only what a refresh reported — see ui.js showPanelError.
    showPanelError(null, { source: 'refresh' });
  } catch (err) {
    showPanelError(`Panel failed to render: ${err?.message ?? err}`, { source: 'refresh' });
  }
}

function render(state, status) {
  view.state = state;
  lastStatus = status;
  noteStatusRows(status);
  setTitle(state);
  renderStop(state);
  renderBlocked(state);
  renderDaemon(state);
  renderAgents(state);
  renderEngines(state);
  renderCurrent(state, status);
  renderAutoAttach(state);
  renderInput(state);
  renderSessions(state, status);
  setText(el.snippet, buildSnippet(state));
  renderLog(state.activity);
  renderUpdateNote(state);
  maybeFetchInfo(state);
}

// ------------------------------------------------------------------ the daemon

function renderDaemon(state) {
  const b = state.bridge ?? {};
  const address = `${hostForUrl(b.host || '127.0.0.1')}:${b.port || DEFAULT_PORT}`;
  const connected = !!b.connected;
  const daemonVersion = b.daemonVersion ?? view.daemon?.version ?? null;

  let dot = 'off';
  let label;
  let hint;
  if (connected) {
    dot = 'on';
    label = 'Daemon connected';
    // No project name here (U4): it was the project of whichever session
    // started the daemon, unrelated to this browser. Each agent row names its own.
    hint = `ws://${address}/g9${b.engineId ? ` · ${b.engineId}` : ''}`;
  } else if (b.problem) {
    dot = 'warn';
    label = /v1 bridge/i.test(b.problem) ? 'Port taken by a v1 bridge' : 'Daemon refused this extension';
    hint = b.problem;
  } else if (b.lastError) {
    label = /v1 bridge/i.test(b.lastError) ? 'Port taken by a v1 bridge' : 'Daemon offline';
    // The transport's own short reasons get the fix appended; its long ones
    // (a v1 bridge on the port, a server that never answered) already carry it.
    hint = /^(daemon not reachable|closed \(\d+\))/i.test(b.lastError)
      ? `${capitalise(b.lastError)}. Your AI client starts the daemon when it connects; G9BrowserAgent Desktop keeps it running.`
      : b.lastError;
  } else {
    dot = 'warn';
    label = 'Connecting…';
    hint = `Looking for the G9BrowserAgent daemon on ${address}.`;
  }

  el.daemonDot.className = `dot ${dot}`;
  // The label is a live region and this runs every 2.5s: rewriting the same
  // words would have a screen reader announce "Daemon connected" forever.
  setText(el.daemonLabel, label);
  setText(el.daemonHint, hint);
  el.daemonHint.title = connected && b.engineId ? `This browser is ${b.engineId} to the daemon` : '';

  el.daemonPill.hidden = !(connected && daemonVersion);
  el.daemonPill.textContent = daemonVersion ? `g9d v${daemonVersion}` : '';

  // Version skew bit this project once already (v1.7.13): two halves that each
  // report a version and never compare them. Here they are compared, visibly.
  const skew = connected && daemonVersion && VERSION && daemonVersion !== VERSION;
  el.daemonWarn.hidden = !skew;
  if (skew) {
    el.daemonWarn.textContent =
      `The daemon is v${daemonVersion} and this extension is v${VERSION}. Update the older one — ` +
      'G9BrowserAgent Desktop updates both.';
  }

  el.daemonRetryRow.hidden = connected;
  el.reconnectBtn.textContent = b.problem ? 'Try again' : 'Reconnect now';
  if (connected) retryDueAt = null;
  paintRetry();

  if (document.activeElement !== el.host) el.host.value = b.host || '127.0.0.1';
  if (document.activeElement !== el.port) el.port.value = String(b.port || DEFAULT_PORT);
}

/** From the transport's 'reconnecting' broadcast: when the next attempt is due. */
export function noteRetry(msg) {
  if (!Number.isFinite(msg?.in)) return;
  retryDueAt = (Number.isFinite(msg.at) ? msg.at : Date.now()) + msg.in;
  paintRetry();
  if (!retryTicker) retryTicker = setInterval(paintRetry, 1000);
}

function paintRetry() {
  const due = retryDueAt && !view.state?.bridge?.connected ? retryDueAt - Date.now() : null;
  el.retryNote.textContent = due != null && due > 0 ? `next try in ${Math.ceil(due / 1000)}s` : '';
  if ((due == null || due <= 0) && retryTicker) {
    clearInterval(retryTicker);
    retryTicker = null;
  }
}

/**
 * Who is connected through the daemon: which project each agent works in, and
 * the tab it is on (U4). The daemon pushes the list (`{type:'agents'}`) and the
 * worker keeps the last one in state; tab ids in it are this browser's own.
 * v2 rows carried only `owned`, so three agents rendered as three identical
 * rows — `project`, `current` and `currentEngine` are what tells them apart.
 */
function renderAgents(state) {
  const connected = !!state.bridge?.connected;
  el.agentsBlock.hidden = !connected;
  if (!connected) return;

  const agents = chooseAgents(state.agents, view.daemon?.agents, agentsMemo);
  el.agentCount.textContent = agents.length ? `${agents.length} connected` : '';
  el.agentEmpty.hidden = agents.length > 0;

  const needed = agents.flatMap((a) => [...ownedTabs(a), ...(Number.isFinite(a.current) ? [a.current] : [])]);
  if (needed.length) ensureTabRows(needed);
  const model = agents.map((a) => [
    a.id, a.name, a.project, a.cwd, !!a.halted, a.current, a.currentEngine,
    ownedTabs(a).map((t) => [t, tabTitle(t)]), Number.isFinite(a.current) ? tabTitle(a.current) : null,
  ]);
  if (!changed('agents', model)) return;
  el.agentList.replaceChildren(...agents.map(agentRow));
}

function agentRow(a) {
  const li = node('li', `item agent${a.halted ? ' halted' : ''}`);
  const main = node('div', 'main');

  const top = node('div', 'row');
  const nm = node('div', 'nm', [a.name || 'agent', a.project].filter(Boolean).join(' · '));
  nm.title = [a.id ? `id ${a.id}` : null, a.cwd ? `working in ${a.cwd}` : null].filter(Boolean).join(' · ');
  top.append(nm);
  if (a.halted) top.append(chip('halted', 'err', 'This agent is stopped'));
  main.append(top);

  // Line two: where it works.
  const where = node('div', 'where');
  const owned = ownedTabs(a);
  if (a.currentEngine === 'extension' && Number.isFinite(a.current)) {
    where.append(node('span', null, 'on:'), tabChip(a.current, { cur: true }));
  } else if (a.currentEngine === 'launched') {
    where.append(node('span', null, 'working in a launched browser'));
    // (3.2) A launched tab — often headless — has no window: the live view is how to see it.
    if (Number.isInteger(a.currentHandle)) where.append(watchButton(a.currentHandle, a.name));
  } else if (a.currentEngine === 'elsewhere') {
    where.append(node('span', null, 'working in another browser'));
    if (Number.isInteger(a.currentHandle)) where.append(watchButton(a.currentHandle, a.name));
  } else if (a.currentEngine === null || 'currentEngine' in a) {
    where.append(node('span', null, 'no tab yet'));
  } else {
    // A v2 daemon's row (no currentEngine): what it owns is all there is to say.
    where.append(node('span', null, owned.length ? `owns ${owned.length} tab${owned.length === 1 ? '' : 's'} here` : 'owns no tab here'));
  }
  main.append(where);

  // Tabs it holds besides the one it is on, one chip each: a click shows that tab.
  const others = owned.filter((t) => !(a.currentEngine === 'extension' && t === a.current));
  if (others.length) {
    const also = node('div', 'where');
    const chips = node('div', 'chips');
    for (const t of others) chips.append(tabChip(t));
    also.append(node('span', null, a.currentEngine === 'extension' ? 'also:' : 'owns:'), chips);
    main.append(also);
  }
  li.append(main);
  return li;
}

/** A tab, by title; a click brings it to the front (focusTab: the person's gesture, allowed under Stop). */
function tabChip(tabId, { cur = false } = {}) {
  const r = rowFor(tabId);
  const title = tabTitle(tabId);
  const c = btn(title, `chip${cur ? ' cur' : ''}`, () => focusTab(tabId), {
    title: `${r?.url || `tab ${tabId}`} — show this tab`,
    key: `tab:${tabId}`,
  });
  return c;
}

function tabTitle(tabId) {
  const r = rowFor(tabId);
  const blocked = view.state?.blocked?.[tabId];
  return r?.title || blocked?.title || r?.url || `tab ${tabId}`;
}

/**
 * Repaint a list only when what it shows changed. These lists hold buttons,
 * and rebuilding them on every 2.5s poll threw away the keyboard focus of
 * whoever was on one (and had a screen reader read the list out again).
 */
function changed(name, model) {
  const key = JSON.stringify(model);
  if (painted.get(name) === key) return false;
  painted.set(name, key);
  return true;
}

/**
 * Which agents list to show: the one the daemon pushed, or its `info` answer.
 *
 * The daemon pushes the list on every change; until its first push arrives
 * (state starts at []), the `info` answer — same shape, same tab ids — fills in.
 * But an EMPTY push is news too: the last agent left. Falling back to an `info`
 * answer fetched before that showed departed agents, still owning tabs, for up
 * to INFO_TTL_MS. So once the pushed list changes, the info copy counts as
 * stale until the next info answer arrives (which clears `memo.infoStale`).
 */
export function chooseAgents(pushedList, infoList, memo) {
  const pushed = Array.isArray(pushedList) ? pushedList : [];
  const key = JSON.stringify(pushed);
  if (memo.key !== null && key !== memo.key) memo.infoStale = true;
  memo.key = key;
  if (pushed.length) return pushed;
  return !memo.infoStale && Array.isArray(infoList) ? infoList : [];
}

function ownedTabs(agent) {
  const list = agent?.owned ?? agent?.tabs ?? [];
  return (Array.isArray(list) ? list : [])
    .map((t) => (t && typeof t === 'object' ? (t.tabId ?? t.id) : t))
    .filter((t) => Number.isFinite(t));
}

/** Engines come from `daemonInfo` — every browser the daemon drives, this one included. */
function renderEngines(state) {
  const engines = Array.isArray(view.daemon?.engines) ? view.daemon.engines : [];
  el.enginesBlock.hidden = !state.bridge?.connected || engines.length === 0;
  el.engineCount.textContent = engines.length ? String(engines.length) : '';
  // Folded unless the person opened it — or an engine has something to say.
  const open = prefs.get(ENGINES_OPEN_KEY, false) || engines.some((e) => e.versionMismatch);
  el.enginesToggle.setAttribute('aria-expanded', String(open));
  el.engineList.hidden = !open;
  el.engineList.replaceChildren();
  for (const e of engines) {
    const self = !!e.engineId && e.engineId === state.bridge?.engineId;
    const li = node('li', `item${self ? ' self' : ''}`);
    const tabs = Array.isArray(e.tabs) ? e.tabs.length : Number.isFinite(e.tabs) ? e.tabs : null;
    const kind = e.kind === 'launched' ? (e.headless === false ? 'launched, headed' : 'launched, headless') : (e.kind ?? null);
    const main = node('div', 'main');
    main.append(
      node('div', 'nm', `${e.engineId ?? e.id ?? 'engine'}${self ? ' · this browser' : ''}`),
      node(
        'div',
        'sub',
        [
          engineBrowser(e),
          kind,
          e.profile ? `profile ${e.profile}` : null,
          tabs != null ? `${tabs} tab${tabs === 1 ? '' : 's'}` : null,
          e.pid ? `pid ${e.pid}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    );
    // The daemon compares versions itself and says so; shown where it applies.
    if (e.versionMismatch) main.append(node('p', 'warn', e.versionMismatch));
    li.append(main);
    el.engineList.append(li);
  }
}

function engineBrowser(e) {
  const b = e.browser;
  if (!b) return e.version ? `v${e.version}` : null;
  if (typeof b === 'string') return /^Mozilla\//.test(b) ? uaBrand(b) : (BROWSER_NAMES[b] ?? b);
  const name = b.name ?? BROWSER_NAMES[b.kind] ?? b.kind;
  return [name, b.version ?? e.version].filter(Boolean).join(' ') || null;
}

const BROWSER_NAMES = { edge: 'Edge', chrome: 'Chrome', cft: 'Chrome for Testing' };

function uaBrand(ua) {
  const edge = /Edg\/(\d+)/.exec(ua);
  if (edge) return `Edge ${edge[1]}`;
  const chrome = /Chrome\/(\d+)/.exec(ua);
  return chrome ? `Chrome ${chrome[1]}` : null;
}

/**
 * Ask the daemon (through the worker) for its version, agents and engines —
 * on connect, then at most every INFO_TTL_MS while someone is looking.
 */
function maybeFetchInfo(state, { force = false } = {}) {
  const connected = !!state.bridge?.connected;
  if (!connected) {
    wasConnected = false;
    agentsMemo.key = null;
    agentsMemo.infoStale = false;
    if (view.daemon) {
      view.daemon = null;
      noteDaemon();
    }
    return;
  }
  const justConnected = wasConnected !== true;
  wasConnected = true;
  if (infoPending) return;
  if (!force && !justConnected) {
    if (Date.now() - infoAt < INFO_TTL_MS) return;
    if (view.active !== 'session' && view.active !== 'about') return;
  }
  infoPending = cmd({ cmd: 'daemonInfo' })
    .then((res) => {
      view.daemon = res?.ok ? (res.daemon ?? null) : null;
      agentsMemo.infoStale = false;
    })
    .catch(() => {
      view.daemon = null;
    })
    .finally(() => {
      infoAt = Date.now();
      infoPending = null;
      if (view.state) {
        renderEngines(view.state);
        renderDaemon(view.state);
        renderAgents(view.state);
      }
      noteDaemon();
    });
}

// ------------------------------------------------- an agent blocked by a hidden tab

/**
 * The toast above the tab bar (A3): an agent's input could not reach its tab
 * because the tab is hidden — the one failure Pop out and Send to background
 * exist for. They used to demand foresight; now they are offered in the moment,
 * naming the agent and the tab. Read from `state.blocked`, so a panel opened
 * after the fact still shows it; it goes when the worker says the tab is shown,
 * moved or closed (agentUnblocked), or when the person dismisses it.
 */
function renderBlocked(state) {
  const all = Object.values(state.blocked && typeof state.blocked === 'object' ? state.blocked : {})
    .filter((e) => e && Number.isFinite(e.tabId))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const dismissed = new Set(prefs.get(DISMISSED_KEY, []));
  // Forget dismissals of entries that are gone, so the list cannot grow for ever.
  const live = new Set(all.map(blockKey));
  const kept = [...dismissed].filter((k) => live.has(k));
  if (kept.length !== dismissed.size) prefs.set(DISMISSED_KEY, kept);
  const shown = all.filter((e) => !dismissed.has(blockKey(e)));

  const connected = !!state.bridge?.connected;
  const model = [shown.map((e) => [blockKey(e), e.agent?.name, e.title, e.url, e.tool, e.delivery]), connected, busy.popout, busy.handoff];
  if (!changed('blocked', model)) return;
  el.blockedAlerts.hidden = shown.length === 0;
  const boxes = shown.slice(0, 3).map((e) => blockedAlert(e, connected));
  if (shown.length > 3) boxes.push(node('p', 'more', `and ${shown.length - 3} more tab${shown.length - 3 === 1 ? '' : 's'} waiting`));
  // A press on Pop out repaints this (the button disables): the keyboard stays where it was.
  keepFocus(el.blockedAlerts, () => el.blockedAlerts.replaceChildren(...boxes));
}

function blockKey(e) {
  return `${e.tabId}:${e.at ?? 0}`;
}

function blockedAlert(e, connected) {
  const box = node('div', 'alert');
  box.setAttribute('role', 'alert');
  const who = e.agent?.name || e.agent?.id || 'An agent';
  const tab = e.title || displayUrl(e.url).host || `tab ${e.tabId}`;
  const msg = node('p', 'msg');
  // Strings passed to append() become text nodes: a page title is never markup.
  msg.append(node('b', null, who), ' cannot reach ', node('b', null, `“${tab}”`),
    ' — the tab is hidden, so the browser drops its input.');
  msg.title = [e.url, e.tool, e.delivery ? `delivery: ${e.delivery}` : null, e.at ? `at ${hm(e.at)}` : null]
    .filter(Boolean).join(' · ');
  const acts = node('div', 'btnrow');
  const pop = btn('⧉ Pop out', 'sm primary', () => popout(e.tabId), {
    title: 'Move that tab into its own window, in front, without reloading it. Do not minimise it.',
    key: `bpop:${e.tabId}`,
  });
  pop.disabled = busy.popout;
  const hand = btn('⇢ Send to background', 'sm', () => handoff(e.tabId), {
    title: connected ? 'Continue that tab in a browser G9BrowserAgent launches; the page reloads there' : 'Needs the G9BrowserAgent daemon, which is not connected',
    key: `bhand:${e.tabId}`,
  });
  hand.disabled = busy.handoff || !connected;
  const dismiss = btn('Dismiss', 'sm ghost', () => {
    const now = new Set(prefs.get(DISMISSED_KEY, []));
    now.add(blockKey(e));
    prefs.set(DISMISSED_KEY, [...now]);
    if (view.state) renderBlocked(view.state);
  }, { aria: `Dismiss: ${who} cannot reach ${tab}`, key: `bdis:${e.tabId}` });
  acts.append(pop, hand, dismiss);
  box.append(msg, acts);
  return box;
}

/** The worker's agentBlocked / agentUnblocked broadcasts: shown at once, then confirmed by a refresh. */
export function onBlockedMessage(msg) {
  if (view.state && Number.isFinite(msg?.tabId)) {
    const blocked = { ...(view.state.blocked ?? {}) };
    if (msg.type === 'agentBlocked') {
      const { __g9, type, ...entry } = msg;
      blocked[msg.tabId] = entry;
    } else {
      delete blocked[msg.tabId];
    }
    view.state = { ...view.state, blocked };
    renderBlocked(view.state);
  }
  refresh();
}

// ------------------------------------------------------------ the current tab

function renderCurrent(state, status) {
  const cur = currentFrom(state, status);
  view.current = cur ? { tabId: cur.tabId, title: cur.title ?? '', url: cur.url ?? '' } : null;
  const attachedCount = Array.isArray(state.attachedTabs) ? state.attachedTabs.length : 0;
  el.attachedCount.textContent = attachedCount ? `${attachedCount} attached` : '';
  // Only when there is something to detach: the current tab may just be the
  // one on screen, which nothing holds yet.
  el.detach.hidden = !(attachedCount || cur?.attached === true);

  const connected = !!state.bridge?.connected;
  el.popoutTab.disabled = busy.popout;
  el.handoffTab.disabled = busy.handoff || !connected;
  el.recordNow.disabled = busy.record;

  const warnings = Array.isArray(status?.warnings) ? status.warnings : [];
  const since = cur ? (status?.current?.tabId === cur.tabId ? status.current.attachedSince : null) ?? state.attachedSince?.[cur.tabId] ?? null : null;
  // The path is cut to what fits in two lines at the card's width.
  const width = el.attached.clientWidth || 300;
  const model = cur
    ? [cur.tabId, cur.title, cur.url, cur.attached, cur.windowState, cur.health, warnings, since, Math.round(width / 20)]
    : [null, !!state.autoAttach, state.autoAttach];
  if (!changed('current', model)) return;

  if (!cur) {
    el.attached.className = 'attached empty';
    el.attached.replaceChildren(
      node('p', 'muted', 'No tab yet — open the page to test; an agent takes it on its first action.'),
    );
    return;
  }

  // Solid green only for a tab G9BrowserAgent really holds; the dashed frame otherwise.
  el.attached.className = cur.attached === false ? 'attached' : 'attached live';
  const parts = [node('div', 'title', cur.title || '(untitled)'), ...urlLines(cur.url, cur.tabId, width)];
  // A minimised window stops rendering, and input sent to it resolves and
  // delivers nothing (AIGuide §2.8.1); a tab that is not its window's active tab
  // is hidden the same way. The worker says so in `status.warnings`, and it
  // is shown here, where it is broken, rather than in a tooltip nobody reads.
  for (const w of warnings) parts.push(node('p', 'warn', w));
  if (!warnings.length && cur.windowState === 'minimized') {
    parts.push(node('p', 'warn', 'Its window is minimised — the browser stops delivering input to it. Restore the window.'));
  }
  parts.push(captureLine(cur, since));
  // With nothing attached, "0 errors" would be a claim, not a count: only a
  // captured tab shows its numbers.
  if (cur.attached !== false && cur.health) parts.push(statsRow(cur.health));
  el.attached.replaceChildren(...parts);
}

/**
 * The URL as origin (in full, bold) and path (middle-truncated to about two
 * lines), the query and fragment reduced to a marker (U5). The full URL is in
 * the title and behind the copy button.
 */
function urlLines(url, tabId, width) {
  const d = displayUrl(url);
  if (!d.href) return [node('div', 'path', `tab ${tabId}`)];
  const lines = [];
  if (d.origin) {
    const o = node('div', 'origin');
    const b = node('b', null, d.origin);
    b.title = d.href;
    o.append(b, btn('copy', 'link', () => copyText(d.href, 'URL copied'), { title: 'Copy the full URL', aria: 'Copy the full URL', key: 'copyurl' }));
    lines.push(o);
  }
  const rest = `${d.path}${d.query ? '?…' : ''}${d.hash ? '#…' : ''}`;
  if (rest && rest !== '/') {
    // ~6.4 px per character of the 10.5 px monospace, two lines.
    const max = Math.max(40, Math.floor((width - 16) / 6.4) * 2 - 2);
    const p = node('div', 'path', middle(rest, max));
    p.title = d.href;
    lines.push(p);
  }
  return lines;
}

/** Say honestly whether console and network are being recorded, and since when. */
function captureLine(cur, since) {
  const line = node('div', 'capture');
  const d = node('span', 'dot');
  d.setAttribute('aria-hidden', 'true');
  if (Number.isFinite(since)) {
    d.className = 'dot rec';
    line.append(d, node('span', null, `Recording console and network since ${hm(since)}`));
  } else if (cur.attached === true) {
    d.className = 'dot rec';
    line.append(d, node('span', null, 'Recording console and network'));
  } else {
    line.className = 'capture off';
    line.append(d, node('span', null, 'Not recording — starts on an agent’s first action, or press Record'));
  }
  return line;
}

/**
 * The tab agents act on by default. `status` (the worker's own orientation
 * answer) is preferred because it carries page health; the tab list fills in
 * when the status has no page to describe.
 */
function currentFrom(state, status) {
  const s = status ?? {};
  const c = s.current ?? s.attached ?? s.target ?? null;
  if (c && typeof c === 'object' && (c.url != null || c.title != null)) {
    const tabId = c.tabId ?? c.id ?? state.currentTabId ?? null;
    if (tabId != null) ensureTabRows([tabId]);
    return {
      tabId,
      title: c.title,
      url: c.url,
      windowState: c.windowState ?? rowFor(tabId)?.windowState,
      attached: attachedFlag(state, tabId),
      health: s.health ?? c.health ?? null,
    };
  }
  if (state.currentTabId == null) return null;
  ensureTabRows([state.currentTabId]);
  const r = rowFor(state.currentTabId);
  return {
    tabId: state.currentTabId,
    title: r?.title ?? `Tab ${state.currentTabId}`,
    url: r?.url ?? '',
    windowState: r?.windowState,
    attached: attachedFlag(state, state.currentTabId),
    health: null,
  };
}

/**
 * Is this tab attached? The worker's own list first, then the tab row's
 * `attached`; `null` when neither says (the panel then claims nothing).
 */
function attachedFlag(state, tabId) {
  if (tabId == null) return null;
  if (Array.isArray(state.attachedTabs) && state.attachedTabs.includes(tabId)) return true;
  const r = rowFor(tabId);
  if (typeof r?.attached === 'boolean') return r.attached;
  return Array.isArray(state.attachedTabs) ? false : null;
}

/**
 * Take the tab rows `status` already carries (the first 25), so the common
 * case costs no extra round trip. Returns nothing; rowFor() reads the result.
 */
function noteStatusRows(status) {
  const rows = status?.tabs?.rows;
  if (!Array.isArray(rows)) return;
  const byId = new Map(tabRows.rows.map((r) => [r.tabId ?? r.id, r]));
  for (const r of rows) byId.set(r.tabId ?? r.id, r);
  tabRows.rows = [...byId.values()];
  tabRows.fromStatus = true;
}

/**
 * Fetch the full tab list — only when a tab the panel must name is missing
 * from what it has, and not more often than TABS_TTL_MS.
 */
function ensureTabRows(needed = []) {
  if (tabRows.pending || Date.now() - tabRows.at < TABS_TTL_MS) return;
  if (tabRows.fromStatus && needed.every((id) => rowFor(id))) return;
  tabRows.pending = cmd({ cmd: 'listTabs' })
    .then((res) => {
      if (res?.ok && Array.isArray(res.tabs)) tabRows.rows = res.tabs;
    })
    .catch(() => {})
    .finally(() => {
      tabRows.at = Date.now();
      tabRows.pending = null;
      if (view.state) {
        renderAgents(view.state);
        renderCurrent(view.state, lastStatus);
        renderSessions(view.state, lastStatus);
      }
    });
}

function rowFor(tabId) {
  if (tabId == null) return null;
  return tabRows.rows.find((r) => (r.tabId ?? r.id) === tabId) ?? null;
}

/**
 * Bring a tab to the front of its window, and the window to the front
 * (focusTab, §13). The person's own gesture: it works while Stop is on, and it
 * clears an agent's "blocked" toast, since the tab is visible now.
 */
async function focusTab(tabId) {
  const res = await cmd({ cmd: 'focusTab', tabId }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
  if (!res?.ok) showPanelError(res?.error ?? `Could not show tab ${tabId}.`);
  refresh();
}

function statsRow(h) {
  const wrap = node('div', 'stats');
  const item = (label, value, cls) => {
    const s = document.createElement('span');
    if (cls && value > 0) s.className = cls;
    s.append(node('b', null, String(value)), document.createTextNode(` ${label}`));
    return s;
  };
  wrap.append(
    item('errors', h.consoleErrors ?? 0, 'stat-err'),
    item('warnings', h.consoleWarnings ?? 0, 'stat-warn'),
    item('requests', h.networkRequests ?? 0),
    item('failed', h.failedRequests ?? 0, 'stat-err'),
  );
  // Stealth never enables the Runtime domain, so page console capture is off —
  // "0 errors" there would be a claim, not a count.
  if (h.console) {
    const note = node('span', 'muted', 'console not captured');
    note.title = String(h.console);
    wrap.append(note);
  }
  return wrap;
}

/** A result that has to outlive a toast: where the tab went, and what did not go with it. */
function showResult(kind, title, lines = []) {
  el.tabResult.className = `result ${kind}`;
  el.tabResult.replaceChildren(node('div', 'nm', title), ...lines.filter(Boolean).map((l) => node('div', 'sub', l)));
  el.tabResult.hidden = false;
}

function listText(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length ? value.map(listText).join(', ') : null;
  if (typeof value === 'object') {
    const bits = Object.entries(value)
      .filter(([, v]) => v !== false && v != null)
      .map(([k, v]) => (v === true ? k : `${k}: ${Array.isArray(v) ? v.length : v}`));
    return bits.length ? bits.join(', ') : null;
  }
  return String(value);
}

/** Pop a tab out into its own window — the current tab's, or a blocked agent's. */
async function popout(tabId) {
  if (busy.popout) return;
  busy.popout = true;
  paintBusy();
  const res = await cmd({ cmd: 'popout', ...(tabId != null ? { tabId } : {}) }).catch((err) => ({
    ok: false,
    error: String(err?.message ?? err),
  }));
  busy.popout = false;
  paintBusy();
  if (!res?.ok) {
    showResult('bad', 'Could not pop the tab out', [res?.error ?? 'No reason given.']);
    showPanelError(res?.error ?? 'Could not pop the tab out.');
  } else {
    showResult(res.visible === false ? 'bad' : 'good',
      `Tab ${res.tabId ?? tabId ?? ''} is in its own window${res.windowId != null ? ` (${res.windowId})` : ''}`, [
        res.note ?? 'It keeps rendering while that window is on screen. Do not minimise it.',
      ]);
    toast('Tab popped out');
  }
  refresh();
}

/** Continue a tab in a browser the daemon launches — the current tab's, or a blocked agent's. */
async function handoff(tabId) {
  if (busy.handoff) return;
  busy.handoff = true;
  paintBusy();
  const label = el.handoffTab.textContent;
  el.handoffTab.textContent = 'Sending…';
  showResult('', 'Sending the tab to a background browser…', ['Starting it can take a few seconds the first time.']);
  const res = await cmd({ cmd: 'handoff', ...(tabId != null ? { tabId } : {}) }).catch((err) => ({
    ok: false,
    error: String(err?.message ?? err),
  }));
  busy.handoff = false;
  el.handoffTab.textContent = label;
  paintBusy();
  if (!res?.ok) {
    showResult('bad', 'Could not send the tab to the background', [res?.error ?? 'No reason given.']);
    if (view.active !== 'session') showPanelError(res?.error ?? 'Could not send the tab to the background.');
  } else {
    const r = res.result ?? {};
    showResult('good', `Continuing in ${r.engineId ?? 'a launched browser'}${r.tabId != null ? ` as tab ${r.tabId}` : ''}`, [
      r.url ?? null,
      listText(r.transferred) ? `Carried over: ${listText(r.transferred)}` : null,
      listText(r.notTransferred) ? `Left behind: ${listText(r.notTransferred)}` : 'In-page state that was never saved stays behind.',
    ]);
    toast('Sent to the background');
  }
  refresh();
}

/** The buttons that start a move, as the in-flight flags say. */
function paintBusy() {
  const connected = !!view.state?.bridge?.connected;
  el.popoutTab.disabled = busy.popout;
  el.handoffTab.disabled = busy.handoff || !connected;
  if (view.state) renderBlocked(view.state);
}

// ---------------------------------------------------------------- auto-attach

/** The stored setting as a mode. A v2 worker kept a boolean: true meant every tab. */
function autoMode(state) {
  const v = state.autoAttach;
  if (v === true) return 'all';
  if (v === false) return 'off';
  return AUTO_MODES.includes(v) ? v : 'project';
}

function renderAutoAttach(state) {
  const mode = autoMode(state);
  if (!busy.auto) {
    for (const r of document.querySelectorAll('input[name="autoAttach"]')) r.checked = r.value === mode;
  }
  setText(el.autoAttachHelp, AUTO_HELP[mode]);
  const domains = Array.isArray(state.projectDomains) ? state.projectDomains.filter((d) => typeof d === 'string') : [];
  if (mode !== 'project') {
    el.autoAttachSites.hidden = true;
    return;
  }
  el.autoAttachSites.hidden = false;
  if (!domains.length) {
    // Honest about the default: with no project anywhere it attaches nothing. A daemon older than
    // v3 never sends project sites at all, so say that rather than waiting for an agent.
    el.autoAttachSites.className = 'warn';
    const daemonVersion = state.bridge?.daemonVersion ?? null;
    const oldDaemon = daemonVersion && Number(String(daemonVersion).replace(/^v/, '').split('.')[0]) < 3;
    setText(el.autoAttachSites, oldDaemon
      ? `The running daemon (v${daemonVersion}) is too old to send project sites, so this behaves as Off. Restart the daemon after updating G9BrowserAgent.`
      : 'No project sites known yet, so this behaves as Off until an agent whose g9.project.json lists environments connects.');
    el.autoAttachSites.title = '';
    return;
  }
  el.autoAttachSites.className = 'help';
  const shown = domains.slice(0, 3).join(', ');
  setText(el.autoAttachSites, `Sites: ${shown}${domains.length > 3 ? ` +${domains.length - 3} more` : ''}`);
  const projects = Array.isArray(state.projects) ? state.projects : [];
  el.autoAttachSites.title = projects.length
    ? projects.map((p) => `${p?.name ?? 'project'}: ${(Array.isArray(p?.domains) ? p.domains : []).join(', ')}`).join('\n')
    : domains.join(', ');
}

// ------------------------------------------------------------------ input level

function renderInput(state) {
  const level = INPUT_LEVELS.includes(state.inputMode) ? state.inputMode : 'human';
  if (!busy.input) {
    for (const r of document.querySelectorAll('input[name="inputMode"]')) r.checked = r.value === level;
  }
  paintInputHelp();
}

/** The checked option's own words, one line under the control. */
function paintInputHelp() {
  const checked = document.querySelector('input[name="inputMode"]:checked');
  const words = checked?.parentElement?.querySelector('.muted')?.textContent ?? '';
  setText(el.inputHelp, words);
}

// --------------------------------------------------------------- named sessions

/** Named sessions, so a two-tab flow is visible rather than implied. */
function renderSessions(state, status) {
  const sessions = sessionsFrom(state, status);
  el.sessionCard.hidden = sessions.length === 0;
  if (!changed('sessions', sessions)) return;
  el.sessionList.replaceChildren();
  for (const s of sessions) {
    const li = node('li', 'item');
    const main = node('div', 'main');
    main.append(
      node('div', 'nm', `${s.session}${s.active ? ' · on screen' : ''}`),
      node('div', 'sub', s.alive ? (s.url || `tab ${s.tabId}`) : 'tab is gone'),
    );
    const acts = node('div', 'acts');
    if (s.alive) {
      acts.append(btn('Show', 'sm', () => focusTab(s.tabId), {
        title: 'A browser only delivers clicks to the tab it is showing.',
        key: `sshow:${s.session}`,
      }));
    }
    acts.append(btn('✕', 'sm icon', async () => {
      const res = await cmd({ cmd: 'sessionEnd', name: s.session }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
      if (!res?.ok) showPanelError(res?.error ?? `Could not forget the session "${s.session}".`);
      refresh();
    }, { title: 'Forget this session. The tab stays open.', aria: `Forget the session "${s.session}"` }));
    li.append(main, acts);
    el.sessionList.append(li);
  }
}

function sessionsFrom(state, status) {
  if (Array.isArray(status?.sessions)) return status.sessions;
  const map = state.sessions && typeof state.sessions === 'object' ? state.sessions : {};
  const names = Object.keys(map);
  const idOf = (v) => (v && typeof v === 'object' ? (v.tabId ?? v.id) : v);
  if (names.length) ensureTabRows(names.map((n) => idOf(map[n])));
  return names.map((name) => {
    const tabId = idOf(map[name]);
    const r = rowFor(tabId);
    return {
      session: name,
      tabId,
      // Before the first tab list arrives, "gone" would be a guess.
      alive: !!r || tabRows.at === 0,
      active: !!r?.active,
      url: r?.url ?? null,
    };
  });
}

// ------------------------------------------------------------------- the rest

/**
 * What the Stop/Resume toast says. `daemonInformed` false: the daemon was not connected, so it was
 * NOT told yet — "Agents stopped" promised more than happened (agents on launched engines kept
 * running until the next reconnect). An older worker that does not report it (undefined) keeps
 * the old words.
 */
export function stopToast(wasHalted, daemonInformed, bridge = {}) {
  if (daemonInformed !== false) return wasHalted ? 'Agents resumed' : 'Agents stopped';
  if (wasHalted) return 'Resumed in this browser only; the G9BrowserAgent daemon is not connected and may still be stopped';
  const stuck = bridge?.problem || /superseded|another connection/i.test(String(bridge?.lastError ?? ''));
  return 'Stopped in this browser. The G9BrowserAgent daemon is not connected; it will be told when it connects' +
    (stuck ? ' — press Reconnect' : '');
}

function renderStop(state) {
  const halted = !!state.halted;
  el.stop.textContent = halted ? 'Resume' : 'Stop';
  el.stop.classList.toggle('armed', halted);
  el.stop.setAttribute('aria-pressed', String(halted));
  el.stop.title = halted
    ? 'Agents are stopped. Resume lets them act again.'
    : state.bridge?.connected
      ? 'Immediately block every agent action, in this browser and in the daemon'
      : 'Immediately block every agent action in this browser; the daemon is told when it connects';
}

function renderLog(activity = []) {
  const list = Array.isArray(activity) ? activity.slice(0, 120) : [];
  if (!changed('log', list.map((e) => [e.at, e.detail, e.ok, e.ms, e.kind]))) return;
  if (!list.length) {
    el.log.replaceChildren(node('li', 'pad', 'Nothing yet. Agent actions appear here in real time.'));
    return;
  }
  el.log.replaceChildren();
  for (const e of list) {
    const li = document.createElement('li');
    if (!e.ok) li.classList.add('bad');
    if (e.kind === 'system') li.classList.add('sys');
    li.append(
      node('span', 't', new Date(e.at).toLocaleTimeString([], { hour12: false })),
      node('span', 'd', e.detail ?? `${e.kind}${e.tabId != null ? ` tab ${e.tabId}` : ''}`),
      node('span', 'ms', e.ms != null ? `${e.ms}ms` : ''),
    );
    el.log.append(li);
  }
}

/**
 * The MCP config for a manual setup. The daemon reports where its code lives
 * in the welcome, so this is a path that works, not a placeholder that fails
 * with "Cannot find module". G9BrowserAgent Desktop writes the same entry for you.
 */
function buildSnippet(state) {
  const root = state.bridge?.repoRoot ? String(state.bridge.repoRoot).replace(/\\/g, '/').replace(/\/+$/, '') : null;
  const port = Number(state.bridge?.port) || DEFAULT_PORT;
  const server = {
    command: 'node',
    args: [root ? `${root}/mcp/shim.mjs` : 'REPLACE_WITH_ABSOLUTE_PATH/mcp/shim.mjs'],
  };
  if (port !== DEFAULT_PORT) server.env = { G9_PORT: String(port) };
  const config = JSON.stringify({ mcpServers: { 'g9browseragent': server } }, null, 2);
  if (root) return config;
  return [
    '// The daemon has not connected yet, so the real path is unknown.',
    '// It fills itself in once the daemon is running.',
    config,
  ].join('\n');
}

function capitalise(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Write text only when it changed (live regions announce every write). */
function setText(target, text) {
  if (target && target.textContent !== text) target.textContent = text;
}

/** `::1` is bracketed in an address, as the transport does in the URL. */
function hostForUrl(host) {
  const h = String(host);
  return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
}

/**
 * The daemon address a person typed, made into what the transport can dial.
 *
 * People paste what they have: `ws://127.0.0.1:18765/g9`, `localhost:18765`,
 * a host with a trailing slash. Each of those used to be saved verbatim and
 * retried for ever as "daemon not reachable on http://…". A port inside the
 * host field wins over the port field — it is the more deliberate of the two.
 * Pure, so the unit test can call it without a DOM.
 */
export function parseAddress(hostInput, portInput) {
  let host = String(hostInput ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  host = host.replace(/\/.*$/, '');
  let port = String(portInput ?? '').trim();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
  if (bracketed) {
    host = bracketed[1];
    if (bracketed[2]) port = bracketed[2];
  } else {
    const hostPort = /^([^:]+):(\d+)$/.exec(host);
    if (hostPort) {
      host = hostPort[1];
      port = hostPort[2];
    }
  }
  if (!host) host = '127.0.0.1';
  if (/[\s/@?#[\]]/.test(host)) return { error: `"${String(hostInput).trim()}" is not a host name or address`, field: 'host' };
  const n = Number(port);
  if (!/^\d+$/.test(port) || n < 1 || n > 65535) {
    return { error: 'The port must be a number from 1 to 65535', field: 'port' };
  }
  return { host, port: n };
}

// -------------------------------------------------------------------- wiring

export function wire() {
  // (3.2) The live view: every tab an engine works in, in a window of its own.
  el.liveView.addEventListener('click', () => openWatch());

  // Record from now (A1): start capture on the tab in front of the person, make
  // it current, lift Stop — and, with the box ticked, reload it so the capture
  // holds the page load from its first request. One command, one activity line.
  el.recordNow.addEventListener('click', async () => {
    if (busy.record) return;
    const reload = !!el.recordReload.checked;
    busy.record = true;
    el.recordNow.disabled = true;
    const label = el.recordNow.textContent;
    el.recordNow.textContent = reload ? 'Reloading…' : 'Starting…';
    const res = await cmd({ cmd: 'recordNow', reload }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
    busy.record = false;
    el.recordNow.disabled = false;
    el.recordNow.textContent = label;
    if (!res?.ok) {
      showPanelError(res?.error ?? 'Could not start recording on this tab.');
    } else {
      const name = res.title || res.url || `tab ${res.tabId}`;
      // Capture is on either way; a failed reload is said, not hidden.
      if (res.reloadError) showPanelError(`Recording "${name}", but the reload failed: ${res.reloadError}`);
      // Record after a Stop is the person saying "carry on", and the worker
      // resumes the agents. That is too big to happen quietly.
      toast(`Recording ${name}${res.attachedSince ? ` since ${hm(res.attachedSince)}` : ''}` +
        `${res.reloaded ? ' — page reloaded' : ''}${res.resumed ? ' — agents resumed' : ''}`);
    }
    refresh();
  });

  el.detach.addEventListener('click', async () => {
    const res = await cmd({ cmd: 'detach' }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
    if (!res?.ok) showPanelError(res?.error ?? 'Could not detach.');
    else toast(res.warning ?? `Detached${res.ms != null ? ` in ${res.ms}ms` : ''}`);
    refresh();
  });

  // Arrow keys move through a radio group AND select. Applying that selection meant ArrowLeft from
  // Off wrapped to "All tabs" and attached every open tab, which arrowing back does not undo
  // (v3 review, finding 5). Arrows now only move focus; a click or Space applies.
  let autoArrowAt = -Infinity;
  el.autoAttachGroup.addEventListener('keydown', (ev) => {
    if (/^Arrow(Left|Right|Up|Down)$/.test(ev.key)) autoArrowAt = performance.now();
  }, true);

  el.autoAttachGroup.addEventListener('change', async (ev) => {
    const input = ev.target.closest('input[name="autoAttach"]');
    if (!input) return;
    if (performance.now() - autoArrowAt < 250) {
      const current = autoMode(view.state ?? {});
      for (const r of document.querySelectorAll('input[name="autoAttach"]')) r.checked = r.value === current;
      setText(el.autoAttachHelp, `Press Space to switch to ${AUTO_NAMES[input.value] ?? input.value}.`);
      return;
    }
    const mode = input.value;
    const previous = autoMode(view.state ?? {});
    busy.auto = true;
    setText(el.autoAttachHelp, AUTO_HELP[mode] ?? '');
    const res = await cmd({ cmd: 'setAutoAttach', mode }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
    busy.auto = false;
    if (!res?.ok) {
      for (const r of document.querySelectorAll('input[name="autoAttach"]')) r.checked = r.value === previous;
      showPanelError(res?.error ?? 'Could not change Auto-attach.');
    } else {
      toast(`Auto-attach: ${AUTO_NAMES[res.mode ?? mode] ?? mode}`);
    }
    refresh();
  });

  el.inputModeGroup.addEventListener('change', async (ev) => {
    const input = ev.target.closest('input[name="inputMode"]');
    if (!input) return;
    const mode = input.value;
    const previous = view.state?.inputMode ?? 'human';
    busy.input = true;
    paintInputHelp();
    const res = await cmd({ cmd: 'setInputMode', mode }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
    busy.input = false;
    if (!res?.ok) {
      for (const r of document.querySelectorAll('input[name="inputMode"]')) r.checked = r.value === previous;
      paintInputHelp();
      showPanelError(res?.error ?? 'Could not change the input level.');
    } else {
      toast(`Input: ${INPUT_NAMES[mode] ?? mode}`);
    }
    refresh();
  });

  el.popoutTab.addEventListener('click', () => popout(currentFrom(view.state ?? {}, lastStatus)?.tabId ?? undefined));
  el.handoffTab.addEventListener('click', () => handoff(currentFrom(view.state ?? {}, lastStatus)?.tabId ?? undefined));

  // Pop the panel out into its own window.
  //
  // The side panel is narrow, it sits on top of the page under test, and a long
  // report has nowhere to go in it. A popup window is resizable, can live on a
  // second screen, and stays put while the page being tested scrolls — which is
  // the whole point when you are watching a run and the page is moving.
  //
  // Inside that window the button hides itself: it is already popped out, and a
  // control that spawns a copy of what you are looking at is just confusing.
  if (new URLSearchParams(location.search).get('detached') === '1') {
    el.detachPanel.hidden = true;
    document.body.classList.add('detached');
  } else {
    el.detachPanel.addEventListener('click', async () => {
      const res = await cmd({ cmd: 'detachPanel' }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
      if (!res?.ok) return showPanelError(res?.error ?? 'Could not open the panel window.');
      toast(res.reused ? 'Panel window focused' : 'Panel opened in its own window');
    });
  }

  el.stop.addEventListener('click', async () => {
    const halted = !!view.state?.halted;
    const res = await cmd({ cmd: halted ? 'resume' : 'halt' }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
    if (!res?.ok) showPanelError(res?.error ?? (halted ? 'Could not resume.' : 'Could not stop the agents.'));
    else toast(stopToast(halted, res.daemonInformed, view.state?.bridge));
    refresh();
  });

  el.daemonToggle.addEventListener('click', () => {
    el.daemonSettings.hidden = !el.daemonSettings.hidden;
    el.daemonToggle.setAttribute('aria-expanded', String(!el.daemonSettings.hidden));
    if (!el.daemonSettings.hidden) el.host.focus();
  });

  el.reconnectBtn.addEventListener('click', async () => {
    retryDueAt = null;
    paintRetry();
    await cmd({ cmd: 'reconnect' }).catch(() => {});
    toast('Reconnecting…');
    setTimeout(refresh, 400);
  });

  el.saveDaemon.addEventListener('click', async () => {
    const parsed = parseAddress(el.host.value, el.port.value);
    if (parsed.error) {
      (parsed.field === 'port' ? el.port : el.host).focus();
      return toast(parsed.error);
    }
    const { host, port } = parsed;
    const res = await cmd({ cmd: 'setBridge', host, port }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
    if (!res?.ok) return showPanelError(res?.error ?? 'Could not save the daemon address.');
    el.daemonSettings.hidden = true;
    el.daemonToggle.setAttribute('aria-expanded', 'false');
    toast(`Reconnecting to ${host}:${port}…`);
    setTimeout(refresh, 400);
  });

  el.enginesToggle.addEventListener('click', () => {
    prefs.set(ENGINES_OPEN_KEY, el.enginesToggle.getAttribute('aria-expanded') !== 'true');
    if (view.state) renderEngines(view.state);
  });

  el.enginesRefresh.addEventListener('click', () => {
    if (view.state) maybeFetchInfo(view.state, { force: true });
  });

  el.clearLog.addEventListener('click', async () => {
    await cmd({ cmd: 'clearLog' });
    refresh();
  });

  el.snippetToggle.addEventListener('click', () => {
    el.snippet.hidden = !el.snippet.hidden;
    el.snippetToggle.setAttribute('aria-expanded', String(!el.snippet.hidden));
    el.snippetToggle.textContent = el.snippet.hidden ? 'show' : 'hide';
  });

  el.copyGuide.addEventListener('click', () =>
    copyText(el.snippet.textContent, view.state?.bridge?.repoRoot ? 'MCP config copied' : 'Copied — but the path is still a placeholder'));
}
