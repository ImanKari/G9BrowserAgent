/**
 * Side panel.
 *
 * This is the trust surface. Its job is to make three things obvious at a
 * glance: is the bridge connected, which tab is the agent allowed to touch,
 * and what has it actually done. The Stop button must always work, even when
 * the bridge is wedged.
 */

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

const el = {
  bridgeDot: $('bridgeDot'),
  bridgeLabel: $('bridgeLabel'),
  bridgeHint: $('bridgeHint'),
  bridgeToggle: $('bridgeToggle'),
  bridgeSettings: $('bridgeSettings'),
  host: $('host'),
  port: $('port'),
  token: $('token'),
  saveBridge: $('saveBridge'),
  attached: $('attached'),
  attachActive: $('attachActive'),
  detach: $('detach'),
  modes: $('modes'),
  modeWarn: $('modeWarn'),
  stop: $('stop'),
  log: $('log'),
  clearLog: $('clearLog'),
  snippet: $('snippet'),
  copyGuide: $('copyGuide'),
  toast: $('toast'),
};

let current = null;

function cmd(payload) {
  return api.runtime.sendMessage({ __g9cmd: true, ...payload });
}

async function refresh() {
  try {
    const res = await cmd({ cmd: 'getState' });
    if (res?.ok) render(res.state, res.status);
  } catch {
    // The worker may be starting up; the next event or poll will catch it.
  }
}

function render(state, status) {
  current = state;

  // --- bridge ---------------------------------------------------------------
  const connected = state.bridge.connected;
  el.bridgeDot.className = `dot ${connected ? 'on' : 'off'}`;
  el.bridgeLabel.textContent = connected ? 'Bridge connected' : 'Bridge offline';
  el.bridgeHint.textContent = connected
    ? `ws://${state.bridge.host}:${state.bridge.port} — your agent can call tools now.`
    : state.bridge.lastError
      ? `${state.bridge.lastError}. Start it with: node bridge/src/server.js`
      : 'Start the bridge, or let your MCP client launch it automatically.';

  if (document.activeElement !== el.host) el.host.value = state.bridge.host;
  if (document.activeElement !== el.port) el.port.value = state.bridge.port;
  if (document.activeElement !== el.token) el.token.value = state.bridge.token ?? '';

  el.snippet.textContent = buildSnippet(state);

  // --- attached tab ---------------------------------------------------------
  const a = status?.attached;
  if (a) {
    const h = status.health ?? {};
    el.attached.className = 'attached live';
    el.attached.innerHTML = '';
    el.attached.append(
      node('div', 'title', a.title || '(untitled)'),
      node('div', 'url', a.url),
      statsRow(h),
    );
    el.attachActive.textContent = 'Re-attach current tab';
    el.detach.hidden = false;
  } else {
    el.attached.className = 'attached empty';
    el.attached.innerHTML = '<p class="muted">No tab attached yet.</p>';
    el.attachActive.textContent = 'Attach & Pin current tab';
    el.detach.hidden = true;
  }

  // --- mode -----------------------------------------------------------------
  for (const b of el.modes.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  }
  const warnings = {
    follow: 'Follow mode: the agent acts on whatever tab is focused. Switching tabs mid-task will redirect it.',
    multi: 'Multi-tab mode: the agent may open, close, and switch tabs on its own.',
    pinned: '',
  };
  el.modeWarn.textContent = warnings[state.mode] ?? '';
  el.modeWarn.hidden = !warnings[state.mode];

  // --- stop -----------------------------------------------------------------
  el.stop.textContent = state.halted ? 'Resume' : 'Stop';
  el.stop.classList.toggle('armed', state.halted);
  el.stop.title = state.halted
    ? 'Agent actions are blocked. Click to allow them again.'
    : 'Immediately block all agent actions';

  renderLog(state.activity);
}

function statsRow(h) {
  const wrap = document.createElement('div');
  wrap.className = 'stats';
  const item = (label, value, cls) => {
    const s = document.createElement('span');
    if (cls && value > 0) s.className = cls;
    s.innerHTML = `<b>${value}</b> ${label}`;
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
  for (const e of activity.slice(0, 120)) el.log.append(logRow(e));
}

function logRow(e) {
  const li = document.createElement('li');
  if (!e.ok) li.classList.add('bad');
  if (e.kind === 'system') li.classList.add('sys');
  li.append(
    node('span', 't', new Date(e.at).toLocaleTimeString([], { hour12: false })),
    node('span', 'd', e.detail ?? `${e.kind}${e.tabId != null ? ` tab ${e.tabId}` : ''}`),
    node('span', 'ms', e.ms != null ? `${e.ms}ms` : ''),
  );
  return li;
}

function node(tag, cls, text) {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
}

/**
 * The bridge reports its own absolute path on connect, so once we have ever
 * connected this snippet is directly pasteable. Before that we cannot know
 * where the repo lives, so say so plainly rather than emitting a placeholder
 * that looks valid and fails with "Cannot find module".
 */
function buildSnippet(state) {
  const known = !!state.bridge.serverPath;
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

  if (known) return config;

  return [
    '// The bridge has never connected, so the real path is unknown.',
    '// Run  node bridge/src/server.js  once and this fills itself in.',
    config,
  ].join('\n');
}

function toast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => {
    el.toast.hidden = true;
  }, 1900);
}

// ------------------------------------------------------------------- wiring

el.attachActive.addEventListener('click', async () => {
  const res = await cmd({ cmd: 'attachActive' });
  if (res?.ok) toast(`Attached: ${res.tab.title || res.tab.url}`);
  else toast(res?.error ?? 'Could not attach');
  refresh();
});

el.detach.addEventListener('click', async () => {
  await cmd({ cmd: 'detach' });
  toast('Detached');
  refresh();
});

el.modes.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-mode]');
  if (!btn) return;
  await cmd({ cmd: 'setMode', mode: btn.dataset.mode });
  refresh();
});

el.stop.addEventListener('click', async () => {
  const halted = current?.halted;
  await cmd({ cmd: halted ? 'resume' : 'halt' });
  toast(halted ? 'Agent resumed' : 'Agent stopped');
  refresh();
});

el.bridgeToggle.addEventListener('click', () => {
  el.bridgeSettings.hidden = !el.bridgeSettings.hidden;
});

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
  toast(
    current?.bridge?.serverPath
      ? 'MCP config copied'
      : 'Copied — but you must fix the path first (bridge never connected)',
  );
});

// Push updates from the worker; poll as a safety net for missed messages.
api.runtime.onMessage.addListener((msg) => {
  if (!msg?.__g9) return;
  if (msg.type === 'state') refresh();
  else if (msg.type === 'activity') refresh();
  else if (msg.type === 'dialog') toast(`Page opened a ${msg.dialogType}: ${msg.message}`);
  else if (msg.type === 'detached') toast('Debugger detached from the pinned tab');
});

setInterval(refresh, 2500);
refresh();
