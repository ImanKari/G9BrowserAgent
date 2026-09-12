/**
 * The Session view: is the bridge connected, which tabs may the agent touch,
 * and what has it actually done.
 *
 * This is the trust surface. Everything here answers one of those three
 * questions, and the Stop button must work even when the bridge is wedged.
 */

import { api, el, cmd, node, toast, showPanelError, view } from './ui.js';

/** Bridges found by the last discovery scan, for the picker. */
let discovered = [];

const MODE_HELP = {
  workspace:
    'Workspace: the agent works on this project’s own sites automatically. Everything else — your ' +
    'email, your tickets — stays invisible to it.',
  pinned: '',
  follow: 'Follow mode: the agent acts on whatever tab is focused. Switching tabs mid-task will redirect it.',
  multi: 'Multi-tab mode: the agent may open, close, and switch tabs on its own.',
};

export async function refresh({ nudge = false } = {}) {
  let res;
  try {
    res = await cmd({ cmd: 'getState', nudge });
  } catch (err) {
    showPanelError(nudge ? null : `Panel could not reach the extension: ${err?.message ?? err}`);
    return;
  }

  if (!res?.ok) return showPanelError(res?.error ?? 'The extension returned no state.');

  try {
    render(res.state, res.status);
    showPanelError(null);
  } catch (err) {
    showPanelError(`Panel failed to render: ${err?.message ?? err}`);
  }
}

function render(state, status) {
  view.state = state;

  const connected = state.bridge.connected;
  el.bridgeDot.className = `dot ${connected ? 'on' : 'off'}`;
  el.bridgeLabel.textContent = connected ? 'Bridge connected' : 'Bridge offline';
  el.bridgeHint.textContent = connected
    ? `ws://${state.bridge.host}:${state.bridge.port}${state.project?.found ? ` — ${projectName(state)}` : ''} — your agent can call tools now.`
    : state.bridge.lastError
      ? `${state.bridge.lastError}. Start it with: node bridge/src/server.js`
      : 'Start the bridge, or let your MCP client launch it automatically.';

  if (document.activeElement !== el.host) el.host.value = state.bridge.host;
  if (document.activeElement !== el.port) el.port.value = state.bridge.port;
  if (document.activeElement !== el.token) el.token.value = state.bridge.token ?? '';

  el.snippet.textContent = buildSnippet(state);
  renderWorkspace(state);

  const a = status?.attached;
  if (a) {
    el.attached.className = 'attached live';
    el.attached.innerHTML = '';
    el.attached.append(
      node('div', 'title', a.title || '(untitled)'),
      node('div', 'url', a.url),
      statsRow(status.health ?? {}),
    );
    el.attachActive.textContent = 'Re-attach current tab';
    el.detach.hidden = false;
  } else {
    el.attached.className = 'attached empty';
    el.attached.innerHTML = `<p class="muted">${emptyTargetHint(state)}</p>`;
    el.attachActive.textContent = 'Attach & Pin current tab';
    el.detach.hidden = true;
  }

  renderSessions(status?.sessions ?? []);

  for (const b of el.modes.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  }
  el.modeWarn.textContent = MODE_HELP[state.mode] ?? '';
  el.modeWarn.hidden = !MODE_HELP[state.mode];

  el.stop.textContent = state.halted ? 'Resume' : 'Stop';
  el.stop.classList.toggle('armed', state.halted);

  renderLog(state.activity);
}

/**
 * What Workspace mode is actually allowing, in the panel rather than in an error.
 *
 * A QA whose tab is being refused needs to see the allowlist, not discover it
 * by reading an agent's complaint. And the "no allowlist" case has to be loud:
 * the mode is selected, it looks active, and it is silently behaving as Pinned.
 */
function renderWorkspace(state) {
  const box = el.workspaceBox;
  if (!box) return;
  const domains = state.project?.workspaceDomains ?? [];

  if (state.mode !== 'workspace') {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = '';

  if (!domains.length) {
    box.className = 'wsbox warn';
    box.append(
      node('div', 'nm', 'No project allowlist — behaving as Pinned'),
      node(
        'div',
        'sub',
        state.project?.found
          ? `${state.project.path} has no "workspaceDomains". Add the sites of the app under test, then press Reconnect.`
          : 'The bridge found no g9.project.json. Create one in the repo under test (copy g9.project.example.json), then press Reconnect.',
      ),
    );
    for (const problem of state.project?.problems ?? []) box.append(node('div', 'sub', `· ${problem}`));
    return;
  }

  box.className = 'wsbox';
  box.append(node('div', 'nm', `Workspace: ${domains.length} site${domains.length === 1 ? '' : 's'}`));
  const list = node('div', 'chips');
  for (const d of domains) list.append(node('span', 'chip', d));
  box.append(list, node('div', 'sub', 'Tabs on these sites are driven automatically. Everything else is invisible to the agent.'));
}

function emptyTargetHint(state) {
  if (state.mode !== 'workspace') return 'No tab attached yet.';
  const domains = state.project?.workspaceDomains ?? [];
  return domains.length
    ? 'No workspace tab is open. Open the app under test and it attaches itself.'
    : 'No tab attached yet, and no workspace allowlist to attach one automatically.';
}

/** Named sessions, so a two-tab flow is visible rather than implied. */
function renderSessions(sessions) {
  const box = el.sessionList;
  if (!box) return;
  el.sessionCard.hidden = sessions.length === 0;
  box.innerHTML = '';
  for (const s of sessions) {
    const li = document.createElement('li');
    const who = node('div', 'who');
    who.append(
      node('div', 'nm', `${s.session}${s.active ? ' · on screen' : ''}`),
      node('div', 'sub', s.alive ? (s.url ?? `tab ${s.tabId}`) : 'tab is gone'),
    );
    const acts = node('div', 'acts');
    if (s.alive) {
      const focus = node('button', '', 'Show');
      focus.title = 'A browser only delivers clicks to the tab it is showing.';
      focus.addEventListener('click', async () => {
        await cmd({ cmd: 'listTabs' });
        await api.tabs.update(s.tabId, { active: true });
        refresh();
      });
      acts.append(focus);
    }
    const end = node('button', 'danger', '✕');
    end.title = 'Forget this session. The tab stays open.';
    end.addEventListener('click', async () => {
      await cmd({ cmd: 'sessionEnd', name: s.session });
      refresh();
    });
    acts.append(end);
    li.append(who, acts);
    box.append(li);
  }
}

function projectName(state) {
  const path = state.project?.path ?? '';
  const parts = path.split('/');
  return parts[parts.length - 2] ?? 'project';
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
  return wrap;
}

function renderLog(activity = []) {
  if (!activity.length) {
    el.log.innerHTML = '<li class="muted pad">Nothing yet. Agent actions will appear here in real time.</li>';
    return;
  }
  el.log.innerHTML = '';
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

function buildSnippet(state) {
  const config = JSON.stringify(
    {
      mcpServers: {
        'g9-browser': {
          command: 'node',
          args: [state.bridge.serverPath ?? 'REPLACE_WITH_ABSOLUTE_PATH/bridge/src/server.js'],
          env: { G9_HOST: state.bridge.host, G9_PORT: String(state.bridge.port) },
        },
      },
    },
    null,
    2,
  );
  if (state.bridge.serverPath) return config;
  return [
    '// The bridge has never connected, so the real path is unknown.',
    '// Run  node bridge/src/server.js  once and this fills itself in.',
    config,
  ].join('\n');
}

// ---------------------------------------------------------- bridge discovery

/**
 * Find every bridge running on this machine and let the user pick one.
 *
 * This replaces the old workflow, which was: read "port in use" in an editor
 * log, guess which of your two windows won, edit a number in two places, and
 * reload. The scan is eleven requests to localhost and answers the question
 * directly — including the one fact that matters most, which is whether some
 * other browser is already holding that bridge.
 */
async function discover() {
  el.discoverBtn.disabled = true;
  el.discoverBtn.textContent = 'scanning…';
  try {
    const res = await cmd({ cmd: 'discoverBridges' });
    discovered = res?.ok ? res.bridges : [];
    renderDiscovered();
  } catch (err) {
    showPanelError(`Could not scan for bridges: ${err?.message ?? err}`);
  } finally {
    el.discoverBtn.disabled = false;
    el.discoverBtn.textContent = 'find bridges';
  }
}

function renderDiscovered() {
  const box = el.bridgeList;
  box.innerHTML = '';
  box.hidden = false;

  if (!discovered.length) {
    box.append(
      node(
        'p',
        'muted',
        'No bridge is running on ports 8765–8775. Start your MCP client, or run: node bridge/src/server.js',
      ),
    );
    return;
  }

  const currentPort = Number(el.port.value);
  for (const b of discovered) {
    const li = document.createElement('li');
    const who = node('div', 'who');
    who.append(
      node('div', 'nm', `:${b.port}${b.project ? ` · ${b.project}` : ''}${b.port === currentPort ? ' · current' : ''}`),
      node(
        'div',
        'sub',
        [
          b.version ? `v${b.version}` : null,
          b.extensionConnected ? 'a browser is already on this one' : 'free',
          b.projectPath ?? b.cwd,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    );
    const acts = node('div', 'acts');
    const use = node('button', b.port === currentPort ? '' : 'primary sm', 'Use');
    if (b.extensionConnected && b.port !== currentPort) {
      use.title = 'Another browser is connected to this bridge. Connecting will displace it.';
    }
    use.addEventListener('click', async () => {
      await cmd({ cmd: 'setBridge', host: b.host, port: b.port, token: el.token.value.trim() });
      toast(`Connecting to bridge on :${b.port}…`);
      box.hidden = true;
      setTimeout(refresh, 400);
    });
    acts.append(use);
    li.append(who, acts);
    box.append(li);
  }
}

// -------------------------------------------------------------------- wiring

export function wire() {
  el.attachActive.addEventListener('click', async () => {
    const res = await cmd({ cmd: 'attachActive' });
    toast(res?.ok ? `Attached: ${res.tab.title || res.tab.url}` : (res?.error ?? 'Could not attach'));
    refresh();
  });

  el.detach.addEventListener('click', async () => {
    const res = await cmd({ cmd: 'detach' });
    toast(res?.warning ?? `Detached${res?.ms != null ? ` in ${res.ms}ms` : ''}`);
    refresh();
  });

  el.modes.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-mode]');
    if (!btn) return;
    await cmd({ cmd: 'setMode', mode: btn.dataset.mode });
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
    el.popout.hidden = true;
    document.body.classList.add('detached');
  } else {
    el.popout.addEventListener('click', async () => {
      const res = await cmd({ cmd: 'detachPanel' });
      if (!res?.ok) return showPanelError(res?.error ?? 'Could not open the panel window.');
      toast(res.reused ? 'Panel window focused' : 'Panel opened in its own window');
    });
  }

  el.stop.addEventListener('click', async () => {
    const halted = view.state?.halted;
    await cmd({ cmd: halted ? 'resume' : 'halt' });
    toast(halted ? 'Agent resumed' : 'Agent stopped');
    refresh();
  });

  el.bridgeToggle.addEventListener('click', () => {
    el.bridgeSettings.hidden = !el.bridgeSettings.hidden;
    if (!el.bridgeSettings.hidden && !discovered.length) discover();
  });

  el.discoverBtn.addEventListener('click', discover);

  el.saveBridge.addEventListener('click', async () => {
    await cmd({
      cmd: 'setBridge',
      host: el.host.value.trim() || '127.0.0.1',
      port: Number(el.port.value) || 8765,
      token: el.token.value.trim(),
    });
    el.bridgeSettings.hidden = true;
    toast('Reconnecting…');
  });

  el.clearLog.addEventListener('click', async () => {
    await cmd({ cmd: 'clearLog' });
    refresh();
  });

  el.copyGuide.addEventListener('click', async () => {
    await navigator.clipboard.writeText(el.snippet.textContent);
    toast(view.state?.bridge?.serverPath ? 'MCP config copied' : 'Copied — but the path is still a placeholder');
  });
}
