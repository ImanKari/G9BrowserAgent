/**
 * Watch: pick a tab, see it live. The daemon streams JPEG frames (Page.startScreencast) and
 * pointer samples for a watched tab; this view draws the latest frame scaled to fit and a cursor
 * sprite interpolated between pointer samples — the cursor is data (D9), never an element in
 * the page, so the page cannot see it and neither can a detector.
 *
 * View only, deliberately: there is no input path from this canvas to the page. A click here
 * does nothing to the tab (it only says so, once). Agents act; people watch and press Stop.
 */

import { h, replace, icon } from '../lib/dom.js';
import { TrackBuffer, fitRect, viewportToCanvas, cursorPoints } from '../lib/track.js';
import { groupTabs } from '../lib/engines.js';
import { shortUrl } from '../lib/format.js';
import { api, store, toast, toastError, viewHead, notConnected, busy, base64ToBytes } from '../ui.js';

let root = null;
let pickerEl = null;
let watchBtn = null;
let canvas = null;
let ctx2d = null;
let emptyEl = null;
let hudEl = null;
let statusEl = null;
let resizeObs = null;
let raf = 0;
let offFrame = null;
let offPointer = null;
let offWatch = null;
let offStatus = null;

const live = {
  tabId: null,
  bitmap: null,
  meta: null,
  frameAt: 0,
  frames: [], // arrival times, for the fps figure
  track: new TrackBuffer(6000),
  decoding: false,
  pending: null,
  paused: false,
  // Is the picture live? The daemon says so (watchStatus: 'hidden' | 'idle' | 'live'):
  // a hidden tab renders no frames, and its last picture must not pass for a live one.
  status: null,
};
let hintShown = false;

export function mount(el) {
  root = el;
  pickerEl = h('select', { 'aria-label': 'Tab to watch' });
  watchBtn = h('button', { type: 'button', class: 'btn primary' }, 'Watch');
  const refresh = h('button', { type: 'button', class: 'btn', title: 'Reload the tab list' }, icon('refresh', { size: 15 }), 'Tabs');
  canvas = h('canvas', { 'aria-label': 'Live view of the watched tab (view only)', role: 'img' });
  ctx2d = canvas.getContext('2d', { alpha: false });
  emptyEl = h('div', { class: 'stage-empty' });
  hudEl = h('div', { class: 'stage-hud', hidden: true });
  statusEl = h('div', { class: 'stage-status', role: 'status', hidden: true });
  const stage = h('div', { class: 'stage' }, canvas, emptyEl, statusEl, hudEl);

  watchBtn.addEventListener('click', () => (live.tabId === null ? start() : stop()));
  refresh.addEventListener('click', () => busy(refresh, loadTabs));
  // A click on the picture must never reach the page. It does nothing — and says so once.
  canvas.addEventListener('click', () => {
    if (hintShown) return;
    hintShown = true;
    toast('View only: nothing you click here reaches the page. Agents act; you watch, and Stop is at the top.');
  });

  replace(el,
    viewHead('Watch', 'A live picture of any tab an engine is working in, with the cursor drawn where the agent moves it.'),
    h('div', { class: 'watch-bar' },
      h('label', { class: 'field inline' }, h('span', null, 'Tab'), pickerEl),
      watchBtn,
      refresh,
      h('span', { class: 'view-only', style: { marginLeft: 'auto' } }, 'View only: clicks here never reach the page.')),
    stage);

  resizeObs = new ResizeObserver(() => sizeCanvas(stage));
  resizeObs.observe(stage);
  sizeCanvas(stage);

  offFrame = api.on('frame', onFrame);
  offPointer = api.on('pointer', onPointer);
  offWatch = api.on('watch', onWatchPush);
  offStatus = api.on('watchStatus', onWatchStatus);

  // The picker above is a new, empty <select>: fill it even when the state has not changed since
  // the last visit. The key is module-level, so a second visit with the same tabs used to match it
  // and leave the picker empty ("No tabs" greyed out while tabs existed) until a tab changed.
  lastPickerKey = '';
  renderPicker(store.state);
  renderEmpty();
  if (live.tabId !== null) loop();
  loadTabs().catch(() => {});
}

export function unmount() {
  // Leaving the view stops the stream: frames nobody looks at still cost the browser.
  if (live.tabId !== null) stop({ quiet: true });
  cancelAnimationFrame(raf);
  raf = 0;
  resizeObs?.disconnect();
  offFrame?.();
  offPointer?.();
  offWatch?.();
  offStatus?.();
  root = null;
}

export function update(s) {
  if (!root) return;
  renderPicker(s);
  if (live.tabId === null && emptyKind === 'default' && defaultEmptyKey(s) !== emptyKey) renderEmpty();
  if (s.connection?.status !== 'connected' && live.tabId !== null) {
    live.paused = true;
    renderEmpty('Reconnecting to the daemon', 'The picture resumes when the connection is back.');
  }
  if (live.tabId !== null && s.tabs.length && !s.tabs.some((t) => t.tabId === live.tabId)) {
    renderEmpty('The tab is gone', `Tab #${live.tabId} was closed.`);
    stop({ quiet: true });
  }
}

async function loadTabs() {
  if (!store.connected) return;
  try {
    await api.call('browser_tabs', { action: 'list' });
  } catch {
    /* the state snapshot keeps the last known list */
  }
}

let lastPickerKey = '';
function renderPicker(s) {
  if (!pickerEl || !s) return;
  const key = JSON.stringify([s.connection?.status, s.tabs.map((t) => [t.tabId, t.title, t.url, t.engineId]), s.engines.map((e) => e.engineId), live.tabId]);
  if (key === lastPickerKey) return;
  lastPickerKey = key;
  const current = live.tabId ?? Number(pickerEl.value);
  const groups = groupTabs(s.tabs, s.engines);
  const options = [];
  if (!groups.length) options.push(h('option', { value: '' }, s.connection?.status === 'connected' ? 'No tabs to watch' : 'Not connected'));
  for (const g of groups) {
    const e = g.engine;
    const label = e.kind === 'launched' ? `${e.engineId}${e.browser ? ` (${e.browser}${e.headless === false ? ', headed' : ''})` : ''}` : e.kind === 'extension' ? `${e.engineId} (extension)` : 'Other tabs';
    options.push(h('optgroup', { label }, g.tabs.map((t) => h('option', { value: String(t.tabId), selected: t.tabId === current },
      `#${t.tabId}  ${t.title || 'Untitled'}  (${shortUrl(t.url, 40)})`))));
  }
  replace(pickerEl, ...options);
  pickerEl.disabled = live.tabId !== null || !groups.length;
  watchBtn.disabled = live.tabId === null && !groups.length;
}

async function start() {
  // The "No tabs to watch" option has the value '' and Number('') is 0: without this check a click
  // that lands before the picker is disabled asks the daemon to watch "tab 0" (render check, round 3).
  if (pickerEl.value === '') return;
  const tabId = Number(pickerEl.value);
  if (!Number.isFinite(tabId)) return;
  await busy(watchBtn, async () => {
    // The daemon answers {watching:false, problem} when the stream could not be
    // started — the tab closed or navigated during the start, or an unwatch
    // overtook it (daemon.js #watch, after the launched-engine ordering fix).
    // Ignoring the body left the viewer on "Waiting for the first frame"
    // forever for a stream that was never going to arrive.
    const reply = await api.admin('watch', { tabId });
    if (reply && reply.watching === false) {
      renderEmpty('That tab is not being watched',
        reply.problem || 'The daemon refused the live view; pick the tab again, or another one.');
      return;
    }
    live.tabId = tabId;
    live.bitmap?.close?.();
    live.bitmap = null;
    live.meta = null;
    live.frames = [];
    live.track.clear();
    live.paused = false;
    live.status = null;
    renderStatus();
    renderEmpty('Waiting for the first frame', 'A tab that is not painting (nothing changes on screen) sends no frames; the last one stays up.');
    loop();
  });
  renderControls();
}

/**
 * (3.2) An agent asked to show the person this tab (browser_tabs action:"watch", the daemon's
 * `watchRequest` event): pick it and start, replacing what was being watched. Called after the view
 * is mounted; a tab that is not in the list (yet) is said, not guessed at.
 */
export async function watchTab(tabId, agent = null) {
  if (!root || !Number.isInteger(tabId)) return;
  if (live.tabId === tabId) return;
  if (live.tabId !== null) await stop({ quiet: true });
  await loadTabs().catch(() => {});
  lastPickerKey = '';
  renderPicker(store.state);
  if (![...pickerEl.options].some((o) => Number(o.value) === tabId)) {
    toast(`${agent?.name ?? 'An agent'} asked you to watch tab #${tabId}, which is not in the list any more.`);
    return;
  }
  pickerEl.value = String(tabId);
  await start();
  toast(`${agent?.name ?? 'An agent'} asked you to watch tab #${tabId}.`);
}

async function stop({ quiet = false } = {}) {
  const tabId = live.tabId;
  live.tabId = null;
  cancelAnimationFrame(raf);
  raf = 0;
  if (tabId !== null) {
    try {
      await api.admin('unwatch', { tabId });
    } catch (err) {
      if (!quiet) toastError(err);
    }
  }
  live.bitmap?.close?.();
  live.bitmap = null;
  live.status = null;
  if (root) {
    clearCanvas();
    renderEmpty();
    renderStatus();
    renderControls();
  }
}

/** The daemon's word on whether the watched picture is live (engine side: lib/screencast.js watchdog). */
function onWatchStatus(d) {
  if (!d || live.tabId === null || d.tabId !== live.tabId) return;
  live.status = d;
  renderStatus();
}

/**
 * 'idle' on a page that says it is visible is the normal state of a page that is not changing
 * (screencast.watchdog: "a static page sends none — normal"): the picture IS the page. An amber
 * banner there sat over every static page after 2 s and read as a fault (render check, round 3),
 * so it is shown in the HUD (IDLE, last frame N s ago) instead. The banner is for a picture that
 * may not be the page: hidden, or a visibility nobody could read.
 */
const quietButVisible = (s) => s?.state === 'idle' && s.visibility === 'visible';

function renderStatus() {
  if (!statusEl) return;
  const s = live.status;
  if (!s || s.state === 'live' || live.tabId === null || quietButVisible(s)) {
    statusEl.hidden = true;
    return;
  }
  const title = s.state === 'hidden' ? 'Tab hidden: this picture is not live' : 'No new frames';
  replace(statusEl, h('strong', null, title), s.reason ? h('span', null, ` ${s.reason}`) : null);
  statusEl.hidden = false;
}

function renderControls() {
  if (!watchBtn) return;
  watchBtn.textContent = live.tabId === null ? 'Watch' : 'Stop watching';
  watchBtn.className = live.tabId === null ? 'btn primary' : 'btn';
  lastPickerKey = '';
  renderPicker(store.state);
}

// Which placeholder is up when nothing is watched: the default one follows the tab list (a tab
// that opens later must turn "No tab to watch yet" into "Pick a tab"); a specific one ("Watching
// stopped", "The tab is gone") stays until the next action.
let emptyKind = null;
let emptyKey = '';
const defaultEmptyKey = (s) => `${s?.connection?.status === 'connected'}|${!!s?.tabs?.length}`;

function renderEmpty(title, text) {
  if (!emptyEl) return;
  if (live.tabId !== null && live.bitmap && !title) {
    emptyEl.hidden = true;
    return;
  }
  const s = store.state;
  emptyKind = title ? 'specific' : 'default';
  emptyKey = title ? '' : defaultEmptyKey(s);
  if (!title) {
    if (s?.connection?.status !== 'connected') {
      replace(emptyEl, notConnected('The picture'));
      emptyEl.hidden = false;
      return;
    }
    // With no tab at all, "Pick a tab" contradicted the picker's own "No tabs to watch" (render
    // check, round 3): say where a tab comes from instead.
    if (!(s?.tabs?.length)) {
      title = 'No tab to watch yet';
      text = 'A tab appears here when an engine opens one: launch an engine in Engines, let an agent open a tab, or connect the extension in your own browser.';
    } else {
      title = 'Pick a tab and press Watch';
      text = 'Frames come from the browser itself (a screencast), so a headless engine can be watched as easily as a visible one.';
    }
  }
  replace(emptyEl, h('div', null, h('strong', null, title), text ? h('p', null, text) : null));
  emptyEl.hidden = false;
}

function onWatchPush(d) {
  if (!d || live.tabId === null) return;
  if (d.paused?.includes(live.tabId)) {
    live.paused = true;
  } else if (d.resumed?.includes(live.tabId)) {
    live.paused = false;
  } else if (d.stopped?.includes(live.tabId)) {
    live.tabId = null;
    renderControls();
    renderEmpty('Watching stopped', d.reason === 'quit'
      ? 'G9BrowserAgent is closing.'
      : d.reason === 'daemon-restarted'
        // Handles are per daemon instance: the same number is another tab now (desktop review).
        ? 'The daemon restarted, so tab numbers start again. Pick the tab again.'
        : 'Press Watch to start again.');
  }
}

function onFrame(d) {
  if (!d || d.tabId !== live.tabId || !d.data) return;
  live.frames.push(Date.now());
  if (live.frames.length > 60) live.frames.shift();
  // Decode one at a time; if frames arrive faster than we decode, keep only the newest.
  live.pending = d;
  if (!live.decoding) decodeNext();
}

async function decodeNext() {
  const d = live.pending;
  live.pending = null;
  if (!d) return;
  live.decoding = true;
  try {
    const bitmap = await createImageBitmap(new Blob([base64ToBytes(d.data)], { type: 'image/jpeg' }));
    if (d.tabId === live.tabId) {
      live.bitmap?.close?.();
      live.bitmap = bitmap;
      live.meta = d.metadata ?? null;
      live.frameAt = d.at ?? Date.now();
      live.paused = false;
      emptyEl.hidden = true;
    } else {
      bitmap.close?.();
    }
  } catch {
    /* a corrupt frame: skip it, the next one replaces it */
  } finally {
    live.decoding = false;
    if (live.pending) decodeNext();
  }
}

function onPointer(d) {
  if (!d || d.tabId !== live.tabId) return;
  live.track.push(d.sample ?? d);
}

function sizeCanvas(stage) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(stage.clientWidth * dpr));
  const hgt = Math.max(1, Math.round(stage.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== hgt) {
    canvas.width = w;
    canvas.height = hgt;
  }
  if (!raf) draw();
}

function clearCanvas() {
  if (!ctx2d) return;
  ctx2d.fillStyle = '#0f141b';
  ctx2d.fillRect(0, 0, canvas.width, canvas.height);
}

function loop() {
  cancelAnimationFrame(raf);
  const tick = () => {
    draw();
    raf = live.tabId !== null ? requestAnimationFrame(tick) : 0;
  };
  raf = requestAnimationFrame(tick);
}

function draw() {
  if (!ctx2d) return;
  clearCanvas();
  const bmp = live.bitmap;
  if (!bmp) {
    hudEl.hidden = true;
    return;
  }
  const fitted = fitRect(bmp.width, bmp.height, canvas.width, canvas.height);
  ctx2d.imageSmoothingQuality = 'high';
  ctx2d.drawImage(bmp, fitted.x, fitted.y, fitted.width, fitted.height);
  const p = live.track.at(Date.now(), 100);
  if (p) drawCursor(ctx2d, viewportToCanvas(p, live.meta, bmp.width, bmp.height, fitted), p, window.devicePixelRatio || 1);
  // HUD: live marker, frame rate, frame age, pointer position.
  const now = Date.now();
  const recent = live.frames.filter((t) => now - t < 2000).length / 2;
  const age = now - live.frameAt;
  replace(hudEl,
    live.status?.state === 'hidden' ? h('span', { class: 'live' }, 'HIDDEN')
      : live.paused ? h('span', { class: 'live' }, 'PAUSED')
        : quietButVisible(live.status) ? h('span', { class: 'idle' }, 'IDLE')
          : h('span', { class: 'live' }, 'LIVE'),
    h('span', null, `#${live.tabId}`),
    h('span', null, `${recent.toFixed(recent < 10 ? 1 : 0)} fps`),
    h('span', null, age > 2000 ? `last frame ${Math.round(age / 1000)} s ago` : `${bmp.width}×${bmp.height}`),
    p ? h('span', null, `cursor ${Math.round(p.x)}, ${Math.round(p.y)}`) : null);
  hudEl.hidden = false;
}

/** The cursor sprite: white arrow, dark outline, a ring for a press in the last 400 ms. */
export function drawCursor(g, at, sample, dpr = 1) {
  const size = 20 * dpr;
  if (sample.pressAge != null && sample.pressAge < 400) {
    const k = sample.pressAge / 400;
    g.beginPath();
    g.arc(at.x, at.y, (6 + 14 * k) * dpr, 0, Math.PI * 2);
    g.strokeStyle = `rgba(255, 196, 64, ${0.9 * (1 - k)})`;
    g.lineWidth = 2.5 * dpr;
    g.stroke();
  }
  const pts = cursorPoints(at.x, at.y, size);
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
  g.fillStyle = sample.buttons ? '#ffd166' : '#ffffff';
  g.strokeStyle = '#11151c';
  g.lineWidth = 1.4 * dpr;
  g.lineJoin = 'round';
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 3 * dpr;
  g.fill();
  g.shadowBlur = 0;
  g.stroke();
}

export function onEvent() {}
