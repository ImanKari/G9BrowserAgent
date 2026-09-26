/**
 * The live view (3.2): the tabs the engines work in, streamed by the daemon, with the cursor drawn
 * where the agent moves it — a headless launched tab above all, which has no window a person could
 * look at. Several tabs at once, one tile each; one can be enlarged.
 *
 * It connects to the daemon itself, as a "viewer" (DAEMON_PROTOCOL §7): the frames go straight to
 * this page instead of through the service worker, which may sleep, and a viewer can do nothing but
 * list and watch tabs. The stream is the desktop app's (JPEG screencast frames, pointer samples,
 * watchStatus), and so is the drawing (track.js is the desktop's renderer/lib/track.js, kept
 * identical by setup/unit/panel.test.mjs).
 *
 * View only, deliberately: nothing clicked here reaches the page. The cursor is data (D9), never an
 * element in the page, so neither the page nor a detector can see it.
 */

import { TrackBuffer, fitRect, viewportToCanvas, cursorPoints } from './track.js';
import { cmd, node, btn, toast, setOptions, downloadBlob, middle } from './ui.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const el = {
  dot: $('wDot'), conn: $('wConn'), picker: $('wPicker'), add: $('wAdd'), refresh: $('wRefresh'),
  banner: $('wBanner'), grid: $('wGrid'), empty: $('wEmpty'),
};

const REQUEST_MS = 15_000;
/** handle → stream (one tile). */
const streams = new Map();
let socket = null;
let welcomed = false;
/** The daemon run the handles belong to (its welcome's bootId). */
let bootId = null;
let nextId = 1;
const pending = new Map();
let watchables = [];
let retryMs = 1000;
let retryTimer = null;
let focused = null; // the enlarged tile's handle
let raf = 0;
let clickHint = false;

// ------------------------------------------------------------------ the daemon link

async function connect() {
  clearTimeout(retryTimer);
  let where;
  try {
    where = await cmd({ cmd: 'watchAddress' });
  } catch (err) {
    where = { ok: false, error: String(err?.message ?? err) };
  }
  if (!where?.ok) {
    setConn('warn', where?.error ?? 'The G9 daemon is not connected.');
    return scheduleRetry();
  }
  let ws;
  try {
    ws = new WebSocket(`ws://${where.address}/g9`);
  } catch (err) {
    setConn('err', `Could not reach the daemon: ${err?.message ?? err}`);
    return scheduleRetry();
  }
  socket = ws;
  welcomed = false;
  setConn('warn', 'Connecting…');
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', role: 'viewer', version: where.version, client: { name: 'watch window', pid: null } }));
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onMessage(msg);
  });
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    socket = null;
    welcomed = false;
    for (const [, p] of pending) p.reject(new Error('the daemon connection closed'));
    pending.clear();
    for (const s of streams.values()) setStatus(s, { state: 'reconnecting' });
    setConn('warn', 'Reconnecting to the daemon — the picture resumes when it is back.');
    scheduleRetry();
  });
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryMs);
  retryMs = Math.min(10_000, retryMs * 2);
}

function onMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      if (msg.problem || !msg.id) {
        // A daemon older than 3.2 has no viewer role: say what fixes it, not the protocol's words.
        setConn('err', /Unknown role/i.test(msg.problem ?? '')
          ? `The running daemon (v${msg.version ?? '?'}) is older than 3.2 and has no live view. Restart it after updating G9.`
          : msg.problem ?? 'The daemon refused the live view.');
        return;
      }
      welcomed = true;
      retryMs = 1000;
      setConn('ok', `Connected to g9d v${msg.version}`);
      // Handles belong to one daemon run (DAEMON_PROTOCOL §2): after a RESTART the same number is
      // another tab, so the tiles go instead of silently showing someone else's page.
      if (bootId && msg.bootId && msg.bootId !== bootId && streams.size) {
        for (const h of [...streams.keys()]) removeStream(h, { tell: false });
        showBanner('The daemon restarted, so tab numbers start again. Pick the tabs to watch again.');
      }
      bootId = msg.bootId ?? bootId;
      loadWatchables().then(() => {
        // After a reconnect to the same daemon: every tile asks again.
        for (const s of streams.values()) startStream(s);
      });
      return;
    case 'viewerResult': {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? 'the daemon refused'));
      return;
    }
    case 'event':
      if (msg.topic === 'frame') onFrame(msg.data);
      else if (msg.topic === 'pointer') onPointer(msg.data);
      else if (msg.topic === 'watchStatus') onWatchStatus(msg.data);
      return;
    default:
  }
}

function request(op, extra = {}) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !welcomed) return reject(new Error('The daemon is not connected.'));
    const id = `w${nextId++}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The daemon did not answer "${op}" within ${REQUEST_MS / 1000} s.`));
    }, REQUEST_MS);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ type: 'viewer', id, op, ...extra }));
  });
}

function setConn(kind, text) {
  el.dot.className = `dot ${{ ok: 'on', err: 'off' }[kind] ?? 'warn'}`;
  el.conn.textContent = text;
}

// ------------------------------------------------------------------ what can be watched

async function loadWatchables() {
  try {
    watchables = (await request('watchables')).tabs ?? [];
  } catch (err) {
    watchables = [];
    showBanner(`Could not list the tabs: ${err.message}`);
    return;
  }
  hideBanner();
  paintPicker();
  for (const s of streams.values()) {
    const w = watchables.find((t) => t.tabId === s.handle);
    if (w) { s.info = { ...s.info, ...w }; paintHead(s); }
  }
}

/** A tab's label in the picker: launched tabs first, since they are what nobody can see otherwise. */
export function tabLabel(t) {
  const where = t.engineKind === 'launched' ? `${t.headless ? 'headless ' : ''}${t.browser ?? 'launched'}` : 'your browser';
  const who = t.owner?.name ?? t.agents?.[0]?.name ?? null;
  return `#${t.tabId} ${middle(t.title || t.url || 'untitled', 48)} — ${where}${who ? ` · ${who}` : ''}`;
}

function paintPicker() {
  const open = watchables
    .filter((t) => !streams.has(t.tabId))
    .sort((a, b) => (a.engineKind === 'launched' ? 0 : 1) - (b.engineKind === 'launched' ? 0 : 1) || a.tabId - b.tabId);
  const options = open.length ? open.map((t) => [String(t.tabId), tabLabel(t)]) : [['', welcomed ? 'No other tab to watch' : 'Connecting…']];
  setOptions(el.picker, options, open.length ? (open.some((t) => String(t.tabId) === el.picker.value) ? el.picker.value : String(open[0].tabId)) : '');
  el.add.disabled = !open.length;
}

// ------------------------------------------------------------------ streams (tiles)

function addStream(handle, { agent = null, announce = false } = {}) {
  if (!Number.isInteger(handle)) return;
  let s = streams.get(handle);
  if (s) {
    s.tile.classList.add('flash');
    setTimeout(() => s.tile.classList.remove('flash'), 1200);
    return;
  }
  const info = watchables.find((t) => t.tabId === handle) ?? { tabId: handle };
  s = {
    handle,
    info: { ...info, ...(agent ? { requestedBy: agent } : {}) },
    bitmap: null,
    meta: null,
    frameAt: 0,
    arrivals: [],
    track: new TrackBuffer(6000),
    decoding: false,
    next: null,
    status: { state: 'starting' },
    problem: null,
  };
  buildTile(s);
  streams.set(handle, s);
  el.grid.append(s.tile);
  paintLayout();
  paintPicker();
  startStream(s);
  if (announce) toast(`${agent?.name ?? 'An agent'} opened a live view of tab #${handle}`);
}

async function startStream(s) {
  if (!welcomed) return;
  setStatus(s, { state: 'starting' });
  try {
    const r = await request('watch', { tabId: s.handle });
    if (r?.watching === false) {
      s.problem = r.problem ?? 'The daemon could not start the stream for this tab.';
      setStatus(s, { state: 'stopped' });
    } else {
      s.problem = null;
    }
  } catch (err) {
    s.problem = err.message;
    setStatus(s, { state: 'stopped' });
  }
  paintHead(s);
}

function removeStream(handle, { tell = true } = {}) {
  const s = streams.get(handle);
  if (!s) return;
  streams.delete(handle);
  if (tell) request('unwatch', { tabId: handle }).catch(() => {});
  s.bitmap?.close?.();
  s.resize?.disconnect();
  s.tile.remove();
  if (focused === handle) focused = null;
  paintLayout();
  paintPicker();
}

function buildTile(s) {
  const tile = node('section', 'watch-tile');
  tile.setAttribute('aria-label', `Live view of tab ${s.handle}`);
  const head = node('div', 'watch-tile-hd');
  const title = node('div', 'watch-title');
  const meta = node('div', 'watch-meta help');
  const titles = node('div', 'grow');
  titles.append(title, meta);
  const pill = node('span', 'chip watch-state');
  const actions = node('div', 'watch-actions');
  actions.append(
    btn('⤢', 'sm', () => toggleFocus(s.handle), { title: 'Enlarge this tile (Esc: back to all)', aria: 'Enlarge' }),
    btn('⤓', 'sm', () => saveFrame(s), { title: 'Save the current picture, cursor included, as a PNG', aria: 'Save picture' }),
    btn('✕', 'sm', () => removeStream(s.handle), { title: 'Stop watching this tab', aria: 'Stop watching' }),
  );
  head.append(titles, pill, actions);
  const stage = node('div', 'watch-stage');
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Tab ${s.handle}, live (view only)`);
  const hud = node('div', 'watch-hud');
  const note = node('div', 'watch-problem');
  note.hidden = true;
  stage.append(canvas, hud, note);
  canvas.addEventListener('click', () => {
    if (clickHint) return;
    clickHint = true;
    toast('View only: nothing you click here reaches the page.');
  });
  canvas.addEventListener('dblclick', () => toggleFocus(s.handle));
  tile.append(head, stage);
  Object.assign(s, { tile, title, meta, pill, canvas, ctx: canvas.getContext('2d', { alpha: false }), hud, note, stage });
  s.resize = new ResizeObserver(() => sizeCanvas(s));
  s.resize.observe(stage);
  paintHead(s);
}

function paintHead(s) {
  const i = s.info ?? {};
  s.title.textContent = i.title || i.url || `Tab #${s.handle}`;
  s.title.title = i.url ?? '';
  const where = i.engineKind === 'launched'
    ? `${i.headless ? 'headless ' : ''}${i.browser ?? 'launched browser'} (${i.engineId ?? '?'})`
    : i.engineKind === 'extension' ? 'your browser' : '';
  const who = [i.owner?.name ? `owned by ${i.owner.name}` : null, i.agents?.length ? `current tab of ${i.agents.map((a) => a.name ?? a.id).join(', ')}` : null,
    i.requestedBy?.name && !i.owner ? `opened by ${i.requestedBy.name}` : null].filter(Boolean);
  s.meta.textContent = [`#${s.handle}`, where, ...who].filter(Boolean).join(' · ');
  s.note.hidden = !s.problem;
  s.note.textContent = s.problem ?? '';
}

function setStatus(s, status) {
  s.status = { ...status };
  const state = status?.state ?? 'live';
  const label = { starting: 'starting', live: 'LIVE', idle: 'IDLE', hidden: 'HIDDEN', stopped: 'stopped', reconnecting: 'reconnecting' }[state] ?? state;
  s.pill.textContent = label;
  s.pill.className = `chip watch-state ${state === 'live' ? 'ok' : state === 'hidden' || state === 'stopped' ? 'err' : 'warn'}`;
  s.pill.title = state === 'hidden'
    ? 'The tab renders no frames (a background tab or a minimised window): the picture is the last one it drew.'
    : state === 'idle' ? 'Nothing on the page changed lately, so no new frames: the picture is current.' : '';
}

function toggleFocus(handle) {
  focused = focused === handle ? null : handle;
  paintLayout();
}

function paintLayout() {
  el.empty.hidden = streams.size > 0;
  el.grid.dataset.count = String(Math.min(streams.size, 4));
  el.grid.classList.toggle('focused', focused != null);
  for (const [h, s] of streams) s.tile.classList.toggle('is-focused', h === focused);
  if (streams.size && !raf) loop();
}

function saveFrame(s) {
  if (!s.bitmap) return toast('No picture yet');
  s.canvas.toBlob((blob) => {
    if (!blob) return;
    const saved = downloadBlob(`g9-tab-${s.handle}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`, blob);
    toast(`Saved ${saved}`);
  }, 'image/png');
}

// ------------------------------------------------------------------ frames, cursor, drawing

function onFrame(d) {
  const s = streams.get(d?.tabId);
  if (!s || !d.data) return;
  s.arrivals.push(Date.now());
  if (s.arrivals.length > 60) s.arrivals.shift();
  if (s.status.state === 'starting' || s.status.state === 'reconnecting') setStatus(s, { state: 'live' });
  // Decode one at a time; frames that arrive meanwhile are replaced by the newest.
  s.next = d;
  if (!s.decoding) decodeNext(s);
}

async function decodeNext(s) {
  const d = s.next;
  s.next = null;
  if (!d) return;
  s.decoding = true;
  try {
    const bytes = base64ToBytes(d.data);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    if (streams.get(s.handle) === s) {
      s.bitmap?.close?.();
      s.bitmap = bitmap;
      s.meta = d.metadata ?? null;
      s.frameAt = d.at ?? Date.now();
    } else {
      bitmap.close?.();
    }
  } catch {
    /* a corrupt frame: the next one replaces it */
  } finally {
    s.decoding = false;
    if (s.next) decodeNext(s);
  }
}

function onPointer(d) {
  const s = streams.get(d?.tabId);
  if (s) s.track.push(d.sample ?? d);
}

function onWatchStatus(d) {
  const s = streams.get(d?.tabId);
  if (s) setStatus(s, d);
}

function sizeCanvas(s) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(s.stage.clientWidth * dpr));
  const h = Math.max(1, Math.round(s.stage.clientHeight * dpr));
  if (s.canvas.width !== w || s.canvas.height !== h) {
    s.canvas.width = w;
    s.canvas.height = h;
  }
}

function loop() {
  const tick = () => {
    for (const s of streams.values()) draw(s);
    raf = streams.size ? requestAnimationFrame(tick) : 0;
  };
  raf = requestAnimationFrame(tick);
}

function draw(s) {
  const g = s.ctx;
  if (!g) return;
  g.fillStyle = '#0f141b';
  g.fillRect(0, 0, s.canvas.width, s.canvas.height);
  const bmp = s.bitmap;
  if (!bmp) {
    s.hud.textContent = s.problem ? '' : 'Waiting for the first frame…';
    return;
  }
  const fitted = fitRect(bmp.width, bmp.height, s.canvas.width, s.canvas.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, fitted.x, fitted.y, fitted.width, fitted.height);
  const p = s.track.at(Date.now(), 100);
  const dpr = window.devicePixelRatio || 1;
  if (p) drawCursor(g, viewportToCanvas(p, s.meta, bmp.width, bmp.height, fitted), p, dpr);
  const now = Date.now();
  const fps = s.arrivals.filter((t) => now - t < 2000).length / 2;
  const age = now - s.frameAt;
  s.hud.textContent = [
    `${fps.toFixed(fps < 10 ? 1 : 0)} fps`,
    age > 2000 ? `last frame ${Math.round(age / 1000)} s ago` : `${bmp.width}×${bmp.height}`,
    p ? `cursor ${Math.round(p.x)}, ${Math.round(p.y)}` : null,
  ].filter(Boolean).join('  ·  ');
}

/** The cursor sprite: white arrow, dark outline, a ring for a press in the last 400 ms (as the desktop's). */
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

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function showBanner(text) {
  el.banner.textContent = text;
  el.banner.hidden = false;
}
function hideBanner() {
  el.banner.hidden = true;
}

// ------------------------------------------------------------------ wiring

el.add.addEventListener('click', () => {
  const handle = Number(el.picker.value);
  if (Number.isInteger(handle)) addStream(handle);
});
el.refresh.addEventListener('click', () => loadWatchables());
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && focused != null) {
    focused = null;
    paintLayout();
  }
});
// The service worker: an agent asked for another tab while this window is open, or took one back.
api?.runtime?.onMessage?.addListener?.((msg) => {
  if (!msg?.__g9) return;
  if (msg.type === 'watchAdd') addStream(Number(msg.handle), { agent: msg.agent ?? null, announce: true });
  if (msg.type === 'watchRemove') removeStream(Number(msg.handle));
});
window.addEventListener('pagehide', () => {
  for (const h of streams.keys()) request('unwatch', { tabId: h }).catch(() => {});
});

const params = new URLSearchParams(location.search);
const first = Number(params.get('tab'));
paintLayout();
paintPicker();
if (Number.isInteger(first) && params.get('tab') !== null) {
  addStream(first, { agent: params.get('agent') ? { name: params.get('agent') } : null, announce: !!params.get('agent') });
}
connect();
