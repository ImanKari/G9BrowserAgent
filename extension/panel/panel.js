/**
 * Side panel.
 *
 * This is the trust surface. Its job is to make three things obvious at a
 * glance: is the bridge connected, which tab is the agent allowed to touch, and
 * what has it actually done. The Stop button must always work, even when the
 * bridge is wedged.
 *
 * ## Three tabs, because they are three jobs
 *
 * Connecting an agent, recording a regression flow, and filing a defect share
 * nothing but the browser. Stacked in one column they buried each other — the
 * connection settings a person reads once sat above the buttons they press
 * every day. Each tab now owns its own body and nothing else.
 *
 * ## Errors are shown, never swallowed
 *
 * `refresh()` used to end in a bare `catch {}`. Any lasting failure left the
 * panel frozen mid-render, showing stale state about a live session — the worst
 * thing a trust surface can do. Every failure path now writes to the error
 * strip instead. It is how the `import()` bug in replay.js was found.
 */

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

/** el.foo is document.getElementById('foo'), resolved late so order is free. */
const el = new Proxy({}, { get: (_, id) => $(String(id)) });

let current = null;
let recording = false;
let videoState = { recording: false };
let openIssueId = null;
let saveTimer = null;
let activeTab = 'session';
let firstRefresh = true;

function cmd(payload) {
  return api.runtime.sendMessage({ __g9cmd: true, ...payload });
}

// ------------------------------------------------------------------- helpers

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function toast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.toast.hidden = true; }, 2400);
}

function showPanelError(message) {
  el.panelError.hidden = !message;
  if (message) {
    el.panelError.textContent = message;
    console.error('[G9 panel]', message);
  }
}

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
};

const bytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/** A row in one of the lists: name, subtitle, and a few actions. */
function row(name, sub, actions, onOpen) {
  const li = document.createElement('li');
  const who = node('div', 'who');
  who.append(node('div', 'nm', name), node('div', 'sub', sub));
  if (onOpen) {
    who.style.cursor = 'pointer';
    who.addEventListener('click', onOpen);
  }
  const acts = node('div', 'acts');
  for (const [label, cls, fn] of actions) {
    const b = node('button', cls, label);
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    acts.append(b);
  }
  li.append(who, acts);
  return li;
}

// ---------------------------------------------------------------------- tabs

el.tabs.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-tab]');
  if (!btn) return;
  activeTab = btn.dataset.tab;
  for (const b of el.tabs.querySelectorAll('button')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === activeTab));
  }
  for (const body of document.querySelectorAll('.tabbody')) {
    body.hidden = body.dataset.body !== activeTab;
  }
  if (activeTab === 'automation') refreshAutomation();
  if (activeTab === 'issues') refreshIssues();
});

// ------------------------------------------------------------- session view

async function refresh() {
  let res;
  try {
    res = await cmd({ cmd: 'getState', nudge: firstRefresh });
  } catch (err) {
    showPanelError(firstRefresh ? null : `Panel could not reach the extension: ${err?.message ?? err}`);
    return;
  }
  firstRefresh = false;

  if (!res?.ok) return showPanelError(res?.error ?? 'The extension returned no state.');

  try {
    render(res.state, res.status);
    showPanelError(null);
  } catch (err) {
    showPanelError(`Panel failed to render: ${err?.message ?? err}`);
  }
}

function render(state, status) {
  current = state;

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
    el.attached.innerHTML = '<p class="muted">No tab attached yet.</p>';
    el.attachActive.textContent = 'Attach & Pin current tab';
    el.detach.hidden = true;
  }

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

  el.stop.textContent = state.halted ? 'Resume' : 'Stop';
  el.stop.classList.toggle('armed', state.halted);

  renderLog(state.activity);
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

// ---------------------------------------------------------- automation view

async function refreshAutomation() {
  if (activeTab !== 'automation') return;
  let res;
  try {
    res = await cmd({ cmd: 'recStatus' });
  } catch (err) {
    el.recCount.textContent = 'refresh failed';
    return showPanelError('Automation refresh failed: ' + (err?.message ?? err));
  }
  if (!res?.ok) return showPanelError(res?.error ?? 'Automation refresh failed.');

  recording = !!res.status?.recording;
  el.recToggle.textContent = recording ? '■ Stop and save' : '● Start recording';
  el.recToggle.classList.toggle('stop', recording);
  el.recLive.hidden = !recording;
  if (recording) {
    const st = res.status;
    el.recLive.textContent =
      `Recording "${st.name}" — ${st.steps} step${st.steps === 1 ? '' : 's'}` +
      (st.lastStep ? ` · last: ${st.lastStep}` : ' · go and use the page');
  }

  const list = res.recordings ?? [];
  el.recCount.textContent = list.length ? `${list.length} saved` : '';
  el.recEmpty.hidden = list.length > 0;
  el.recList.innerHTML = '';
  for (const r of list) {
    const last = r.lastRun
      ? ` · last run ${r.lastRun.failed ? `${r.lastRun.failed} failed` : 'all passed'}`
      : '';
    const suite = r.suite ? `${r.suite} · ` : '';
    const flaky = r.flaky?.detected ? ' · possibly flaky' : '';
    el.recList.append(
      row(r.name, `${suite}${r.stepCount} steps · ${ago(r.createdAt)}${last}${flaky}`, [
        ['Replay', '', () => runReplay(r.id, false)],
        ['Check', '', () => runReplay(r.id, true)],
        ['✕', 'danger', async () => {
          await cmd({ cmd: 'recDelete', id: r.id });
          refreshAutomation();
        }],
      ]),
    );
  }
}

/**
 * Show the whole outcome, not a verdict.
 *
 * The failing step's message is the product of this feature — which element,
 * what it looked for, what is on the page instead. A toast saying "failed"
 * throws away the only part worth reading, so it goes on screen and stays
 * there until the next run.
 */
function renderReplayReport(res) {
  const box = el.replayReport;
  box.hidden = false;
  box.className = `report ${res.failed ? 'bad' : 'good'}`;
  box.innerHTML = '';

  const bad = res.steps.find((s) => !s.ok);
  box.append(
    node(
      'div',
      'nm',
      bad
        ? `Failed at step ${bad.step} of ${res.total}`
        : `${res.dryRun ? 'All steps resolve' : 'Passed'} — ${res.passed}/${res.total} in ${res.durationMs}ms`,
    ),
  );
  if (bad) box.append(node('div', null, bad.error));
  for (const w of res.warnings ?? []) box.append(node('div', 'warn', w));
}

async function runReplay(id, dryRun) {
  el.replayReport.hidden = true;
  toast(dryRun ? 'Checking every step…' : 'Replaying…');
  let res;
  try {
    res = await cmd({ cmd: 'recReplay', id, dryRun });
  } catch (err) {
    return showPanelError(`Replay could not run: ${err?.message ?? err}`);
  }
  if (!res?.ok) return showPanelError(res?.error ?? 'Replay could not start.');
  renderReplayReport(res);
  refreshAutomation();
}

el.recToggle.addEventListener('click', async () => {
  const wasRecording = recording;
  const res = await cmd({ cmd: wasRecording ? 'recStop' : 'recStart' });
  if (!res?.ok) return showPanelError(res?.error ?? 'Recording command failed.');
  toast(wasRecording ? `Saved "${res.name}" — ${res.steps} steps` : 'Recording — go and use the page');
  refreshAutomation();
});

// -------------------------------------------------------------- issues view

async function refreshIssues() {
  if (activeTab !== 'issues' || openIssueId) return;
  let res;
  try {
    res = await cmd({ cmd: 'issueList' });
  } catch (err) {
    el.issueUsage.textContent = 'refresh failed';
    return showPanelError('Issue refresh failed: ' + (err?.message ?? err));
  }
  if (!res?.ok) return showPanelError(res?.error ?? 'Issue refresh failed.');

  const list = res.issues ?? [];
  el.issueUsage.textContent = res.usage?.attachments
    ? `${list.length} · ${res.usage.attachmentMB}MB of evidence`
    : '';
  el.issueEmpty.hidden = list.length > 0;
  el.issueList.innerHTML = '';
  for (const i of list) {
    el.issueList.append(
      row(
        i.title,
        `${i.severity ?? 'normal'} · ${i.status ?? 'open'} · ${ago(i.createdAt)}${i.filedAs ? ` · ${i.filedAs}` : ''}`,
        [['Open', '', () => openIssue(i.id)],
         ['✕', 'danger', async () => { await cmd({ cmd: 'issueDelete', id: i.id }); refreshIssues(); }]],
        () => openIssue(i.id),
      ),
    );
  }
}

/**
 * Creating an issue captures first and asks questions second.
 *
 * The evidence is only true at the instant the bug is on screen — the console
 * tail, the failed requests, the screenshot. A title can be written any time
 * after. So the button files immediately with a placeholder name and opens the
 * editor, rather than holding a form open while the page moves on underneath
 * it and the evidence goes stale.
 */
el.issueNew.addEventListener('click', async () => {
  el.issueNew.disabled = true;
  const res = await cmd({
    cmd: 'issueCreate',
    title: `Issue ${new Date().toLocaleTimeString([], { hour12: false })}`,
    body: '',
    severity: 'normal',
  });
  el.issueNew.disabled = false;

  if (!res?.ok) return showPanelError(res?.error ?? 'Could not capture the issue.');
  toast('Captured — screenshot, console, requests and context saved');
  openIssue(res.id, { focusTitle: true });
});

async function openIssue(id, { focusTitle = false } = {}) {
  const res = await cmd({ cmd: 'issueGet', id });
  if (!res?.ok) return showPanelError(res?.error ?? 'Could not open that issue.');

  openIssueId = id;
  el.issueListView.hidden = true;
  el.issueDetailView.hidden = false;

  const i = res.issue;
  el.dTitle.value = i.title ?? '';
  el.dBody.value = i.body ?? '';
  el.dSeverity.value = i.severity ?? 'normal';
  el.dStatus.value = i.status ?? 'open';
  el.dFiledAs.value = i.filedAs ?? '';
  el.dContext.textContent = summariseContext(i.context);
  renderAttachments(i.attachments ?? []);
  el.issueSaved.textContent = `saved ${ago(i.updatedAt)}`;
  const video = await cmd({ cmd: 'videoStatus' }).catch(() => null);
  setVideoState(video?.ok ? video.status : { recording: false });

  if (focusTitle) { el.dTitle.focus(); el.dTitle.select(); }
}

function setVideoState(status) {
  videoState = status ?? { recording: false };
  const forThisIssue = videoState.recording && videoState.issueId === openIssueId;
  el.dVideo.textContent = forThisIssue ? '■ Stop recording' : '● Record tab';
  el.dVideo.classList.toggle('stop', forThisIssue);
  el.dVideo.disabled = videoState.recording && !forThisIssue;
  el.dDelete.disabled = forThisIssue;
  el.dVideo.title = el.dVideo.disabled
    ? 'This tab is recording video for another issue. Open that issue to stop it.'
    : '';
}

function summariseContext(c) {
  if (!c) return '(no context captured)';
  return [
    `url        ${c.url ?? '?'}`,
    `title      ${c.title ?? '?'}`,
    `came from  ${c.referrer || '(direct)'}`,
    `viewport   ${c.viewport?.width}×${c.viewport?.height} @${c.viewport?.dpr}x`,
    `captured   ${c.at ?? '?'}`,
    `console    ${c.console?.total ?? 0} entries, ${c.console?.counts?.error ?? 0} errors`,
    `failed req ${c.failedRequestCount ?? 0}`,
  ].join('\n');
}

const GLYPH = { screenshot: '🖼', video: '🎞', evidence: '📄', file: '📎' };

function renderAttachments(list) {
  el.dAttCount.textContent = list.length ? `${list.length} files` : 'nothing attached yet';
  el.dAttachments.innerHTML = '';
  for (const a of list) {
    const li = document.createElement('li');
    if (a.kind === 'screenshot') {
      const img = document.createElement('img');
      img.alt = a.name;
      // Bytes are fetched only for images, one at a time. A 40MB frame capture
      // has no business being pulled into the panel to draw an icon.
      cmd({ cmd: 'issueAttachment', attachmentId: a.id }).then((r) => {
        if (r?.ok && r.attachment?.dataBase64) img.src = `data:${a.mime};base64,${r.attachment.dataBase64}`;
      });
      li.append(img);
    } else {
      li.append(node('div', 'glyph', GLYPH[a.kind] ?? '📎'));
    }
    li.append(node('div', 'cap', `${a.name} · ${bytes(a.size)}`));

    const rm = node('button', 'rm', '✕');
    rm.title = 'Remove';
    rm.addEventListener('click', async () => {
      await cmd({ cmd: 'issueDetach', attachmentId: a.id });
      openIssue(openIssueId);
    });
    li.append(rm);
    el.dAttachments.append(li);
  }
}

/** Debounced, so typing a body does not write on every keystroke. */
async function saveIssueNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!openIssueId) return true;
  el.issueSaved.textContent = 'saving…';
  const res = await cmd({
    cmd: 'issueUpdate',
    id: openIssueId,
    title: el.dTitle.value.trim() || '(untitled)',
    body: el.dBody.value,
    severity: el.dSeverity.value,
    status: el.dStatus.value,
    filedAs: el.dFiledAs.value.trim(),
  });
  el.issueSaved.textContent = res?.ok ? 'saved just now' : 'not saved';
  if (!res?.ok) {
    showPanelError(res?.error ?? 'Could not save the issue.');
    return false;
  }
  return true;
}

function queueSave() {
  clearTimeout(saveTimer);
  el.issueSaved.textContent = 'saving…';
  saveTimer = setTimeout(() => { saveIssueNow().catch((err) => showPanelError(err?.message ?? err)); }, 500);
}

for (const id of ['dTitle', 'dBody', 'dSeverity', 'dStatus', 'dFiledAs']) {
  el[id].addEventListener('input', queueSave);
  el[id].addEventListener('change', queueSave);
}

el.issueBack.addEventListener('click', async () => {
  if (saveTimer && !(await saveIssueNow())) return;
  openIssueId = null;
  el.issueDetailView.hidden = true;
  el.issueListView.hidden = false;
  refreshIssues();
});

el.dDelete.addEventListener('click', async () => {
  const id = openIssueId;
  clearTimeout(saveTimer);
  saveTimer = null;
  openIssueId = null;
  el.issueDetailView.hidden = true;
  el.issueListView.hidden = false;
  await cmd({ cmd: 'issueDelete', id });
  toast('Deleted');
  refreshIssues();
});

const shoot = (area) => async () => {
  const res = await cmd({ cmd: 'issueShot', id: openIssueId, area });
  if (!res?.ok) return showPanelError(res?.error ?? 'Could not capture.');
  toast('Screenshot attached');
  openIssue(openIssueId);
};
el.dShot.addEventListener('click', shoot('viewport'));
el.dShotFull.addEventListener('click', shoot('fullpage'));

el.dRecapture.addEventListener('click', async () => {
  const res = await cmd({ cmd: 'issueRecapture', id: openIssueId });
  if (!res?.ok) return showPanelError(res?.error ?? 'Could not re-capture.');
  toast('Context, console and requests re-captured');
  openIssue(openIssueId);
});

el.dVideo.addEventListener('click', async () => {
  if (videoState.recording && videoState.issueId === openIssueId) {
    const res = await cmd({ cmd: 'videoStop', id: openIssueId });
    if (!res?.ok) return showPanelError(res?.error ?? 'Could not stop recording.');
    setVideoState({ recording: false });
    toast(res?.frames ? (res.frames + ' frames attached') : 'Stopped — nothing captured');
    openIssue(openIssueId);
  } else {
    const res = await cmd({ cmd: 'videoStart', id: openIssueId });
    if (!res?.ok) return showPanelError(res?.error ?? 'Could not start recording.');
    setVideoState({ recording: true, issueId: openIssueId, startedAt: res.startedAt });
    toast('Recording this tab — reproduce the bug, then stop');
  }
});

el.dFile.addEventListener('click', () => el.dFileInput.click());

el.dFileInput.addEventListener('change', async () => {
  const files = [...el.dFileInput.files];
  el.dFileInput.value = '';
  for (const file of files) {
    const res = await cmd({
      cmd: 'issueAttach',
      id: openIssueId,
      name: file.name,
      mime: file.type || 'application/octet-stream',
      dataBase64: await fileToBase64(file),
    });
    if (!res?.ok) showPanelError(res?.error ?? `Could not attach ${file.name}.`);
  }
  toast(`${files.length} file${files.length === 1 ? '' : 's'} attached`);
  openIssue(openIssueId);
});

function fileToBase64(file) {
  return file.arrayBuffer().then((buf) => {
    const b = new Uint8Array(buf);
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < b.length; i += CHUNK) s += String.fromCharCode.apply(null, b.subarray(i, i + CHUNK));
    return btoa(s);
  });
}

// ------------------------------------------------------------ session wiring

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
  toast(current?.bridge?.serverPath ? 'MCP config copied' : 'Copied — but the path is still a placeholder');
});

api.runtime.onMessage.addListener((msg) => {
  if (!msg?.__g9) return;
  if (msg.type === 'state' || msg.type === 'activity') refresh();
  else if (msg.type === 'dialog') toast(`Page opened a ${msg.dialogType}: ${msg.message}`);
  else if (msg.type === 'detached') toast('Debugger detached from the pinned tab');
});

setInterval(() => {
  refresh();
  refreshAutomation();
  refreshIssues();
}, 2500);

refresh();
