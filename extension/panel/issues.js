/**
 * The Issues view: capture evidence while the bug is still on screen.
 *
 * Unchanged in v1.7.0 apart from being lifted out of the one-file panel. The
 * capture-first ordering is the whole design and is documented at its call site
 * below — a form held open while the page moves on underneath it collects a
 * screenshot of the aftermath.
 */

import { el, cmd, node, toast, showPanelError, ago, bytes, row, fileToBase64, view } from './ui.js';

let openIssueId = null;
let saveTimer = null;
let videoState = { recording: false };

const GLYPH = { screenshot: '🖼', video: '🎞', evidence: '📄', file: '📎' };

export async function refresh() {
  if (view.active !== 'issues' || openIssueId) return;
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
        [
          ['Open', '', () => openIssue(i.id)],
          [
            '✕',
            'danger',
            async () => {
              await cmd({ cmd: 'issueDelete', id: i.id });
              refresh();
            },
          ],
        ],
        () => openIssue(i.id),
      ),
    );
  }
}

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

  if (focusTitle) {
    el.dTitle.focus();
    el.dTitle.select();
  }
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
  saveTimer = setTimeout(() => {
    saveIssueNow().catch((err) => showPanelError(err?.message ?? err));
  }, 500);
}

export function wire() {
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

  for (const id of ['dTitle', 'dBody', 'dSeverity', 'dStatus', 'dFiledAs']) {
    el[id].addEventListener('input', queueSave);
    el[id].addEventListener('change', queueSave);
  }

  el.issueBack.addEventListener('click', async () => {
    if (saveTimer && !(await saveIssueNow())) return;
    openIssueId = null;
    el.issueDetailView.hidden = true;
    el.issueListView.hidden = false;
    refresh();
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
    refresh();
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
      toast(res?.frames ? `${res.frames} frames attached` : 'Stopped — nothing captured');
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
}
