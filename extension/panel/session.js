/**
 * The Session view: is the daemon connected, who is connected through it,
 * which tab is the agent on, how does its input look, and what has it done.
 *
 * This is the trust surface. Everything here answers one of those questions,
 * and the Stop button must work even when the daemon is wedged.
 *
 * ## What v2 took out, and why nothing replaced it
 *
 * The four modes and the workspace allowlist are gone (plan D6): attaching a
 * tab gives agents that tab, fully, and Auto-attach does it for every tab. The
 * modes were a product boundary on a local, trusted deployment; the operational
 * safeguards — Stop and the activity log — stay, because they are how a person
 * stays in charge of what is running in their own browser.
 *
 * Bridge discovery is gone too. There is one daemon per machine on one port,
 * and a list with one entry in it is a question nobody needs to answer.
 *
 * Every command used here is in ARCHITECTURE_V2 §13; setup/unit/panel.test.mjs
 * checks that, so a renamed command fails a test instead of a button.
 */

import { api, el, cmd, node, toast, showPanelError, view, setTitle, VERSION } from './ui.js';
import { renderUpdateNote, noteDaemon } from './about.js';

const DEFAULT_PORT = 8765;
/** How stale the tab list may get before a render asks again. */
const TABS_TTL_MS = 5_000;
/** Daemon info (engines) changes rarely; a person can press "refresh". */
const INFO_TTL_MS = 10_000;
const INPUT_LEVELS = ['off', 'human', 'stealth'];
const INPUT_NAMES = { off: 'Direct', human: 'Human', stealth: 'Stealth' };

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
const busy = { popout: false, handoff: false, input: false, auto: false };

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
  renderDaemon(state);
  renderAgents(state);
  renderEngines(state);
  renderCurrent(state, status);
  renderInput(state);
  renderSessions(state, status);
  el.snippet.textContent = buildSnippet(state);
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
    hint =
      `ws://${address}/g9` +
      (b.engineId ? ` · this browser is ${b.engineId}` : '') +
      (state.project?.found && state.project.path ? ` · ${projectName(state.project.path)}` : '') +
      ' — agents can use this browser now.';
  } else if (b.problem) {
    dot = 'warn';
    label = /v1 bridge/i.test(b.problem) ? 'Port taken by a v1 bridge' : 'Daemon refused this extension';
    hint = b.problem;
  } else if (b.lastError) {
    label = /v1 bridge/i.test(b.lastError) ? 'Port taken by a v1 bridge' : 'Daemon offline';
    // The transport's own short reasons get the fix appended; its long ones
    // (a v1 bridge on the port, a server that never answered) already carry it.
    hint = /^(daemon not reachable|closed \(\d+\))/i.test(b.lastError)
      ? `${capitalise(b.lastError)}. Your AI client starts the daemon when it connects; G9 Desktop keeps it running.`
      : b.lastError;
  } else {
    dot = 'warn';
    label = 'Connecting…';
    hint = `Looking for the G9 daemon on ${address}.`;
  }

  el.daemonDot.className = `dot ${dot}`;
  // The label is a live region and this runs every 2.5s: rewriting the same
  // words would have a screen reader announce "Daemon connected" forever.
  setText(el.daemonLabel, label);
  setText(el.daemonHint, hint);

  el.daemonPill.hidden = !(connected && daemonVersion);
  el.daemonPill.textContent = daemonVersion ? `g9d v${daemonVersion}` : '';

  // Version skew bit this project once already (v1.7.13): two halves that each
  // report a version and never compare them. Here they are compared, visibly.
  const skew = connected && daemonVersion && VERSION && daemonVersion !== VERSION;
  el.daemonWarn.hidden = !skew;
  if (skew) {
    el.daemonWarn.textContent =
      `The daemon is v${daemonVersion} and this extension is v${VERSION}. Update the older one — ` +
      'G9 Desktop updates both.';
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
 * Who is connected through the daemon, and which of this browser's tabs each
 * one owns. The daemon pushes the list (`{type:'agents'}`) and the worker keeps
 * the last one in state; tab ids in it are this browser's own.
 */
function renderAgents(state) {
  const connected = !!state.bridge?.connected;
  el.agentsBlock.hidden = !connected;
  if (!connected) return;

  const agents = chooseAgents(state.agents, view.daemon?.agents, agentsMemo);
  el.agentCount.textContent = agents.length ? `${agents.length} connected` : '';
  el.agentEmpty.hidden = agents.length > 0;

  const needed = agents.flatMap(ownedTabs);
  if (needed.length) ensureTabRows(needed);
  const model = {
    cur: state.currentTabId ?? null,
    agents: agents.map((a) => [a.id, a.name, !!a.halted, ownedTabs(a).map((t) => [t, rowFor(t)?.title, rowFor(t)?.url])]),
  };
  if (!changed('agents', model)) return;
  el.agentList.replaceChildren();

  for (const a of agents) {
    const owned = ownedTabs(a);

    const li = document.createElement('li');
    if (a.halted) li.classList.add('halted');
    const who = node('div', 'who');
    who.append(
      node('div', 'nm', `${a.name || 'agent'}${a.id ? ` · ${a.id}` : ''}${a.halted ? ' · halted' : ''}`),
      node(
        'div',
        'sub',
        owned.length
          ? `owns ${owned.length} tab${owned.length === 1 ? '' : 's'} in this browser`
          : 'owns no tab in this browser',
      ),
    );
    if (owned.length) {
      const chips = node('div', 'tabchips');
      for (const tabId of owned) {
        const r = rowFor(tabId);
        const chip = node('button', `tabchip${tabId === state.currentTabId ? ' cur' : ''}`, r?.title || r?.url || `tab ${tabId}`);
        chip.type = 'button';
        chip.title = `${r?.url || `tab ${tabId}`} — show this tab`;
        chip.addEventListener('click', () => showTab(tabId));
        chips.append(chip);
      }
      who.append(chips);
    }
    li.append(who);
    el.agentList.append(li);
  }
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
  el.engineList.replaceChildren();
  for (const e of engines) {
    const self = !!e.engineId && e.engineId === state.bridge?.engineId;
    const li = document.createElement('li');
    if (self) li.classList.add('self');
    const tabs = Array.isArray(e.tabs) ? e.tabs.length : Number.isFinite(e.tabs) ? e.tabs : null;
    const kind = e.kind === 'launched' ? (e.headless === false ? 'launched, headed' : 'launched, headless') : (e.kind ?? null);
    const who = node('div', 'who');
    who.append(
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
    if (e.versionMismatch) who.append(node('p', 'warn', e.versionMismatch));
    li.append(who);
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

// ------------------------------------------------------------ the current tab

function renderCurrent(state, status) {
  const cur = currentFrom(state, status);
  const attachedCount = Array.isArray(state.attachedTabs) ? state.attachedTabs.length : 0;
  el.attachedCount.textContent = attachedCount ? `${attachedCount} attached` : '';

  if (cur) {
    // Solid green only for a tab G9 really holds; the dashed frame otherwise.
    el.attached.className = cur.attached === false ? 'attached' : 'attached live';
    const parts = [node('div', 'title', cur.title || '(untitled)'), node('div', 'url', cur.url || `tab ${cur.tabId}`)];
    // A minimised window stops rendering, and input sent to it resolves and
    // delivers nothing (plan §2.1); a tab that is not its window's active tab
    // is hidden the same way. The worker says so in `status.warnings`, and it
    // is shown here, where it is broken, rather than in a tooltip nobody reads.
    const warnings = Array.isArray(status?.warnings) ? status.warnings : [];
    for (const w of warnings) parts.push(node('p', 'warn', w));
    if (!warnings.length && cur.windowState === 'minimized') {
      parts.push(
        node('p', 'warn', 'Its window is minimised — the browser stops delivering input to it. Restore the window.'),
      );
    }
    // With nothing attached, the tab a call would act on is simply the one on
    // screen. Its console and network are not being recorded yet, so "0 errors"
    // would be a claim, not a count: say what is true instead.
    if (cur.attached === false) {
      parts.push(
        node(
          'p',
          'muted sm',
          'Not attached yet — an agent attaches it on its first action; console and network are recorded from then on.',
        ),
      );
    } else if (cur.health) {
      parts.push(statsRow(cur.health));
    }
    el.attached.replaceChildren(...parts);
  } else {
    el.attached.className = 'attached empty';
    el.attached.replaceChildren(
      node(
        'p',
        'muted',
        state.autoAttach
          ? 'No tab yet — open or reload a page and it attaches itself.'
          : 'No tab attached yet. Open the page to test and press Attach.',
      ),
    );
  }
  // Only when there is something to detach: the current tab may just be the
  // one on screen, which nothing holds yet.
  el.detach.hidden = !(attachedCount || cur?.attached === true);

  const connected = !!state.bridge?.connected;
  el.popoutTab.disabled = busy.popout;
  el.popoutTab.title = cur
    ? `Move "${cur.title || cur.url || `tab ${cur.tabId}`}" into its own window`
    : 'Move the current tab into its own window';
  el.handoffTab.disabled = busy.handoff || !connected;
  el.handoffTab.title = connected
    ? 'Continue the current tab in a browser the daemon launches in the background'
    : 'Needs the G9 daemon, which is not connected';

  if (!busy.auto) el.autoAttach.checked = !!state.autoAttach;
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

async function showTab(tabId) {
  try {
    const tab = await api.tabs.update(tabId, { active: true });
    if (tab?.windowId != null) await api.windows.update(tab.windowId, { focused: true }).catch(() => {});
  } catch (err) {
    showPanelError(`Could not show tab ${tabId}: ${err?.message ?? err}`);
  }
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

// ------------------------------------------------------------------ input level

function renderInput(state) {
  if (busy.input) return;
  const level = INPUT_LEVELS.includes(state.inputMode) ? state.inputMode : 'human';
  for (const r of document.querySelectorAll('input[name="inputMode"]')) r.checked = r.value === level;
}

// --------------------------------------------------------------- named sessions

/** Named sessions, so a two-tab flow is visible rather than implied. */
function renderSessions(state, status) {
  const sessions = sessionsFrom(state, status);
  el.sessionCard.hidden = sessions.length === 0;
  if (!changed('sessions', sessions)) return;
  el.sessionList.replaceChildren();
  for (const s of sessions) {
    const li = document.createElement('li');
    const who = node('div', 'who');
    who.append(
      node('div', 'nm', `${s.session}${s.active ? ' · on screen' : ''}`),
      node('div', 'sub', s.alive ? (s.url || `tab ${s.tabId}`) : 'tab is gone'),
    );
    const acts = node('div', 'acts');
    if (s.alive) {
      const focus = node('button', '', 'Show');
      focus.type = 'button';
      focus.title = 'A browser only delivers clicks to the tab it is showing.';
      focus.addEventListener('click', async () => {
        await showTab(s.tabId);
        refresh();
      });
      acts.append(focus);
    }
    const end = node('button', 'danger', '✕');
    end.type = 'button';
    end.title = 'Forget this session. The tab stays open.';
    end.setAttribute('aria-label', `Forget the session "${s.session}"`);
    end.addEventListener('click', async () => {
      const res = await cmd({ cmd: 'sessionEnd', name: s.session }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
      if (!res?.ok) showPanelError(res?.error ?? `Could not forget the session "${s.session}".`);
      refresh();
    });
    acts.append(end);
    li.append(who, acts);
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
  if (wasHalted) return 'Resumed in this browser only; the G9 daemon is not connected and may still be stopped';
  const stuck = bridge?.problem || /superseded|another connection/i.test(String(bridge?.lastError ?? ''));
  return 'Stopped in this browser. The G9 daemon is not connected; it will be told when it connects' +
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
  if (!activity.length) {
    el.log.innerHTML = '<li class="muted pad">Nothing yet. Agent actions will appear here in real time.</li>';
    return;
  }
  el.log.replaceChildren();
  for (const e of activity.slice(0, 120)) {
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
 * with "Cannot find module". G9 Desktop writes the same entry for you.
 */
function buildSnippet(state) {
  const root = state.bridge?.repoRoot ? String(state.bridge.repoRoot).replace(/\\/g, '/').replace(/\/+$/, '') : null;
  const port = Number(state.bridge?.port) || DEFAULT_PORT;
  const server = {
    command: 'node',
    args: [root ? `${root}/mcp/shim.mjs` : 'REPLACE_WITH_ABSOLUTE_PATH/mcp/shim.mjs'],
  };
  if (port !== DEFAULT_PORT) server.env = { G9_PORT: String(port) };
  const config = JSON.stringify({ mcpServers: { 'g9-browser': server } }, null, 2);
  if (root) return config;
  return [
    '// The daemon has not connected yet, so the real path is unknown.',
    '// It fills itself in once the daemon is running.',
    config,
  ].join('\n');
}

function projectName(path) {
  const parts = String(path).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : (parts[0] ?? 'project');
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
  el.attachActive.addEventListener('click', async () => {
    el.attachActive.disabled = true;
    const res = await cmd({ cmd: 'attachActive' }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
    el.attachActive.disabled = false;
    const tab = res?.tab ?? res ?? {};
    if (!res?.ok) {
      showPanelError(res?.error ?? 'Could not attach the current tab.');
    } else {
      // Attach after a Stop is the person saying "carry on", and the worker
      // resumes the agents (sw.js clearHalt). That is too big to happen quietly.
      const name = tab.title || tab.url || `tab ${tab.tabId ?? tab.id}`;
      toast(res.resumed ? `Attached ${name} — agents resumed` : `Attached: ${name}`);
    }
    refresh();
  });

  el.detach.addEventListener('click', async () => {
    const res = await cmd({ cmd: 'detach' }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
    if (!res?.ok) showPanelError(res?.error ?? 'Could not detach.');
    else toast(res.warning ?? `Detached${res.ms != null ? ` in ${res.ms}ms` : ''}`);
    refresh();
  });

  el.autoAttach.addEventListener('change', async () => {
    const enabled = el.autoAttach.checked;
    busy.auto = true;
    const res = await cmd({ cmd: 'setAutoAttach', enabled }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
    busy.auto = false;
    if (!res?.ok) {
      el.autoAttach.checked = !enabled;
      showPanelError(res?.error ?? 'Could not change Auto-attach.');
    } else {
      toast(enabled ? 'Auto-attach on — new and reloaded tabs attach themselves' : 'Auto-attach off');
    }
    refresh();
  });

  el.inputModeGroup.addEventListener('change', async (ev) => {
    const input = ev.target.closest('input[name="inputMode"]');
    if (!input) return;
    const mode = input.value;
    const previous = view.state?.inputMode ?? 'human';
    busy.input = true;
    const res = await cmd({ cmd: 'setInputMode', mode }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
    busy.input = false;
    if (!res?.ok) {
      for (const r of document.querySelectorAll('input[name="inputMode"]')) r.checked = r.value === previous;
      showPanelError(res?.error ?? 'Could not change the input level.');
    } else {
      toast(`Input: ${INPUT_NAMES[mode] ?? mode}`);
    }
    refresh();
  });

  el.popoutTab.addEventListener('click', async () => {
    const tabId = currentFrom(view.state ?? {}, lastStatus)?.tabId ?? undefined;
    busy.popout = true;
    el.popoutTab.disabled = true;
    const res = await cmd({ cmd: 'popout', ...(tabId != null ? { tabId } : {}) }).catch((err) => ({
      ok: false,
      error: String(err?.message ?? err),
    }));
    busy.popout = false;
    el.popoutTab.disabled = false;
    if (!res?.ok) {
      showResult('bad', 'Could not pop the tab out', [res?.error ?? 'No reason given.']);
    } else {
      showResult(res.visible === false ? 'bad' : 'good',
        `Tab ${res.tabId ?? tabId ?? ''} is in its own window${res.windowId != null ? ` (${res.windowId})` : ''}`, [
          res.note ?? 'It keeps rendering while that window is on screen. Do not minimise it.',
        ]);
      toast('Tab popped out');
    }
    refresh();
  });

  el.handoffTab.addEventListener('click', async () => {
    const tabId = currentFrom(view.state ?? {}, lastStatus)?.tabId ?? undefined;
    busy.handoff = true;
    el.handoffTab.disabled = true;
    const label = el.handoffTab.textContent;
    el.handoffTab.textContent = 'Sending…';
    showResult('', 'Sending the tab to a background browser…', [
      'Starting it can take a few seconds the first time.',
    ]);
    const res = await cmd({ cmd: 'handoff', ...(tabId != null ? { tabId } : {}) }).catch((err) => ({
      ok: false,
      error: String(err?.message ?? err),
    }));
    busy.handoff = false;
    el.handoffTab.textContent = label;
    el.handoffTab.disabled = !view.state?.bridge?.connected;
    if (!res?.ok) {
      showResult('bad', 'Could not send the tab to the background', [res?.error ?? 'No reason given.']);
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
  });

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

  el.enginesRefresh.addEventListener('click', () => {
    if (view.state) maybeFetchInfo(view.state, { force: true });
  });

  el.clearLog.addEventListener('click', async () => {
    await cmd({ cmd: 'clearLog' });
    refresh();
  });

  el.copyGuide.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.snippet.textContent);
      toast(view.state?.bridge?.repoRoot ? 'MCP config copied' : 'Copied — but the path is still a placeholder');
    } catch (err) {
      showPanelError(`Could not copy: ${err?.message ?? err}`);
    }
  });
}
