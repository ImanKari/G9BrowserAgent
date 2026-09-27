#!/usr/bin/env node
/**
 * P8 background-state matrix — what really reaches a page, per window/tab state, and whether G9BrowserAgent's
 * delivery report tells the truth about it.
 *
 *   node setup/matrix.mjs [--engines 1,2] [--browsers edge,chrome] [--repeat 1]
 *                         [--states active,background,minimized,offscreen,hidemid]   (Engine 1)
 *                         [--e2-states active,background,popup,minimized,offscreen]  (Engine 2)
 *                         [--occlusion off,on] [--out <file.json>] [--keep]
 *
 * Labels: "<browser>-<state>-noswitch" ran without --disable-features=CalculateNativeWinOcclusion,
 * "<browser>-<state>-switch" with it. Exit 0 = every cell agrees with the page; 1 = a WRONG/STALE
 * cell or a state that could not be set up; 2 = the harness itself failed.
 *
 * ENGINE 1 — the real extension. For every state, a fresh temporary profile is launched with a COPY
 * of extension/ that carries dev-daemon.json (this run's private daemon port), so the worker's very
 * first connect goes to our daemon (sw.js applyDevOverride). The agent works through an MCP shim and
 * that private daemon exactly as in the product; the harness keeps its own CDP pipe to the browser
 * only to set the state up (activate a tab through the extension's own chrome.tabs, never by
 * focusing a window) and to read the page's own record of what it received (ground truth).
 *
 * States (each with and without --disable-features=CalculateNativeWinOcclusion, the switch the
 * WindowOcclusionEnabled=false policy is equivalent to):
 *   active      headless (--headless=new), the test tab is the active tab — the baseline
 *   background  headless, another tab is active in the same window
 *   minimized   HEADED, minimized without ever being shown (see "Headed windows" below)
 *   offscreen   HEADED at --window-position=-32000,-32000 (off every monitor: occluded)
 * Operations per state: click (Sign in), type (Username), wheel (scroll 300 px), screenshot
 * (viewport PNG: non-blank AND showing a marker painted just before — a stale frame is caught),
 * screencast (UI watch; at least 3 frames must arrive while the page animates — one first frame is
 * not a stream). Branded Chrome 137+ ignores --load-extension, so Chrome gets the same extension
 * copy through Extensions.loadUnpacked over the pipe (--enable-unsafe-extension-debugging).
 *
 * ENGINE 1, extra states "hidemid" (headless) and "hidemidheaded" (HEADED, off-screen at
 * -32000,-32000 with the occlusion switch, so it is visible until the tab switch — the way a person's
 * own headed browser is) (round 3): the test tab active, and the tab is made
 * HIDDEN (another tab activated in its window, as a person switching tabs would) WHILE a humanized
 * type, click or wheel is under way. The page's own log — including events that arrive only after
 * the tab is shown again — is compared with what the product reported, including partial delivery.
 *
 * ENGINE 2 — daemon-launched Edge: headless active tab, headless background tab (a second tab
 * opened through the product in the same context — since round 3 the product gives every page it
 * opens a window of its own, so this tab is no longer behind anything), "popup": the agent's tab
 * after the PAGE opened a tab (target=_blank), which joins the opener's window in front of it —
 * the one way a G9BrowserAgent tab still ends up behind another tab in its own window —, headed minimized and
 * headed off-screen (the product always passes CalculateNativeWinOcclusion off, so "without" does
 * not exist there). Every Engine 2 row also records browser_status's warnings for the tested tab.
 *
 * Verdict per cell: the product's report (delivered / not-delivered / indeterminate / error)
 * against the page's own trusted-event log. A report that disagrees with the page is WRONG.
 *
 * NOT measured, on purpose (disruptive for the person at this workstation): a locked session and
 * another virtual desktop.
 *
 * Headed windows. --start-minimized is NOT a Chromium switch: measured on Edge 153 and Chrome 153,
 * a window launched with it opens NORMAL (Browser.getWindowForTarget windowState "normal"). The
 * minimized state still passes it (the P8 plan asks for it) and records its measured effect
 * (row.atLaunch, row.startMinimizedHonored), but never relies on it: every headed browser this
 * file starts is spawned with windowsHide (its first ShowWindow is SW_HIDE: created, never shown)
 * and at --window-position=-32000,-32000, and is then shown through Win32 without activation:
 * ShowWindowAsync(SW_SHOWMINNOACTIVE) for "minimized", ShowWindowAsync(SW_SHOWNOACTIVATE) for
 * "offscreen" — never on a monitor, never the foreground window (both checked and recorded).
 * Engine 2's headed launches cannot be spawned hidden (the product spawns them), so they get only
 * --window-position=-32000,-32000 (+ --start-minimized for "minimized"), verified headless first;
 * "minimized" is then applied the same non-activating way to the browser pid the launch reports.
 *
 * Diagnostics recorded per state: a paint probe (first animation frame, frames in 1.5 s, timer
 * lateness — visibilityState alone does not say whether a page is being painted), and for Engine 1
 * a trace of every chrome.debugger command that took 200 ms or more or failed (the extension's
 * service worker is instrumented through the harness pipe), attached to the operation it belongs
 * to, plus bare Input/screenshot commands timed on the harness's own page session at the end.
 *
 * SAFETY: after every headed launch the window's real bounds are read, and a window found on a
 * monitor is minimized at once and the state aborted. Every browser this file starts goes through
 * a local guard proxy that refuses every destination except this run's own ports, so even a
 * failed dev override could never reach 8765.
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { PipeCdp } from '../engine/pipe-cdp.js';
import { resolveBrowser } from '../engine/find.js';
import {
  ROOT, SETUP, assertSafePort, freePort, makeRoot, log, delay, startServe, startDaemon, callTool, cleanupRoot,
  refsFrom, pidAlive, killTreeSync, processesMatching, startGuard, guardedLaunch, profileSignIn, homeProfilesSignIn,
} from './bench.mjs';

export { startGuard };
import { VERSION } from '../lib/version.mjs';

// ─────────────────────────────────────────────────────────────── Win32: show a window without activating it

const WIN_PS1 = String.raw`param([int]$BrowserPid, [int]$Cmd = -1)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class P8Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<IntPtr> Of(uint pid) { var list = new List<IntPtr>(); EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) list.Add(h); return true; }, IntPtr.Zero); return list; }
}
"@
$fg = [P8Win]::GetForegroundWindow()
$out = @()
foreach ($h in [P8Win]::Of([uint32]$BrowserPid)) {
  $c = New-Object System.Text.StringBuilder 256; [void][P8Win]::GetClassName($h, $c, 256)
  $t = New-Object System.Text.StringBuilder 256; [void][P8Win]::GetWindowText($h, $t, 256)
  if ($c.ToString() -ne 'Chrome_WidgetWin_1' -or $t.Length -eq 0) { continue }
  $r = New-Object P8Win+RECT; [void][P8Win]::GetWindowRect($h, [ref]$r)
  if ($Cmd -ge 0) { [void][P8Win]::ShowWindowAsync($h, $Cmd) }
  $out += [pscustomobject]@{ hwnd = [int64]$h; title = $t.ToString(); left = $r.L; top = $r.T; visible = [P8Win]::IsWindowVisible($h); iconic = [P8Win]::IsIconic($h); foreground = ($h -eq $fg) }
}
ConvertTo-Json -Compress -InputObject @($out)
`;
export const SW_SHOWNOACTIVATE = 4;
export const SW_SHOWMINNOACTIVE = 7;

/**
 * List the browser windows of `pid` (top-level Chrome_WidgetWin_1 with a title) and optionally
 * ShowWindowAsync(cmd) them. Returns [{hwnd, title, left, top, visible, iconic, foreground}].
 */
export async function winShow(root, pid, cmd = -1) {
  const file = path.join(root, 'p8-win.ps1');
  if (!fs.existsSync(file)) await fsp.writeFile(file, WIN_PS1);
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-BrowserPid', String(pid), '-Cmd', String(cmd)], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  try { return JSON.parse(String(r.stdout).trim() || '[]'); } catch { return { error: (r.stdout || r.stderr || '').trim().slice(0, 300) }; }
}

async function winShowUntil(root, pid, cmd, ok, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let applied = false;
  while (Date.now() < deadline) {
    last = await winShow(root, pid, applied ? -1 : cmd);
    if (Array.isArray(last) && last.length) applied = true;
    if (applied) {
      await delay(300);
      last = await winShow(root, pid, -1);
      if (Array.isArray(last) && last.length && last.every(ok)) return { ok: true, windows: last };
    }
    await delay(300);
  }
  return { ok: false, windows: last };
}

// ─────────────────────────────────────────────────────────────── PNG check (is the capture blank?)

/** Decode an 8-bit RGB/RGBA PNG and count distinct colours on a sparse grid. null when not decodable. */
export function pngStats(buf, probes = []) {
  try {
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    let off = 8;
    let width = 0; let height = 0; let depth = 0; let ctype = 0;
    const idat = [];
    while (off < buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; }
      if (type === 'IDAT') idat.push(data);
      if (type === 'IEND') break;
      off += 12 + len;
    }
    if (depth !== 8 || (ctype !== 2 && ctype !== 6)) return { width, height, colors: null };
    const bpp = ctype === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * bpp;
    const out = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y += 1) {
      const f = raw[y * (stride + 1)];
      const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let x = 0; x < stride; x += 1) {
        const a = x >= bpp ? out[y * stride + x - bpp] : 0;
        const b = y > 0 ? out[(y - 1) * stride + x] : 0;
        const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
        let v = line[x];
        if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        out[y * stride + x] = v & 0xff;
      }
    }
    const colors = new Set();
    for (let y = 0; y < height; y += 7) for (let x = 0; x < width; x += 7) {
      const i = y * stride + x * bpp;
      colors.add((out[i] << 16) | (out[i + 1] << 8) | out[i + 2]);
    }
    const pixels = probes.map(({ x, y }) => {
      if (x >= width || y >= height) return null;
      const i = y * stride + x * bpp;
      return [out[i], out[i + 1], out[i + 2]];
    });
    return { width, height, colors: colors.size, pixels };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────── page ground truth

/** Installed in the page's MAIN world by the harness (never by G9BrowserAgent): what the page itself received. */
const LOGGER = `(() => {
  if (window.p8log) return 'already';
  const log = window.p8log = [];
  for (const t of ['pointerdown','mousedown','mouseup','click','keydown','keyup','input','wheel','scroll']) {
    addEventListener(t, (e) => log.push({ t: e.type, trusted: e.isTrusted, id: (e.target && e.target.id) || null, at: Math.round(performance.now()) }), true);
  }
  return 'installed';
})()`;
const READ = `(() => ({
  vis: document.visibilityState, hidden: document.hidden, focus: document.hasFocus(), sy: Math.round(scrollY),
  user: (document.getElementById('user') || {}).value, status: (document.getElementById('status') || {}).textContent,
  n: (window.p8log || []).length,
}))()`;
const readSince = (n) => `(window.p8log || []).slice(${Number(n)})`;
// A vivid block the capture must contain if it shows the page as it is NOW (not a stale frame).
const MARK_ON = `(() => { const d = document.createElement('div'); d.id = 'p8mark';
  d.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:90px;z-index:99999;pointer-events:none;background:rgb(1,254,3)';
  document.documentElement.appendChild(d); return 'on'; })()`;
const MARK_OFF = `(() => { const d = document.getElementById('p8mark'); if (d) d.remove(); return 'off'; })()`;
const ANIMATE_ON = `(() => { if (window.p8anim) return 'on'; const d = document.createElement('div'); d.id = 'p8anim';
  d.style.cssText = 'position:fixed;left:0;top:0;width:220px;height:120px;z-index:99999;pointer-events:none';
  document.documentElement.appendChild(d); let i = 0;
  window.p8anim = setInterval(() => { i += 1; d.style.background = 'hsl(' + ((i * 47) % 360) + ',80%,50%)'; d.textContent = String(i); }, 80); return 'on'; })()`;
const ANIMATE_OFF = `(() => { clearInterval(window.p8anim); window.p8anim = null; const d = document.getElementById('p8anim'); if (d) d.remove(); return 'off'; })()`;
/**
 * Is the page being PAINTED? visibilityState alone does not say: a headed window that is minimized
 * with occlusion tracking off (Engine 2 always runs that way) reports "visible" and gets no
 * animation frames, and Chromium aligns continuous input (mouse moves, wheel) to those frames.
 * rafMs: when the first requestAnimationFrame callback ran (null = none within 1.5 s);
 * timer1500Ms: when a 1500 ms timer actually fired (throttling shows here).
 */
const PROBE = `new Promise((resolve) => {
  const t0 = performance.now(); let raf = null; let frames = 0;
  const tick = () => { if (raf === null) raf = Math.round(performance.now() - t0); frames += 1; if (performance.now() - t0 < 1500) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setTimeout(() => resolve({ vis: document.visibilityState, focus: document.hasFocus(), rafMs: raf, framesIn1500ms: frames,
    timer1500Ms: Math.round(performance.now() - t0), inner: innerWidth + 'x' + innerHeight }), 1500);
})`;

/**
 * Installed in the G9BrowserAgent extension's service worker (Engine 1) through the harness pipe: wraps
 * chrome.debugger.sendCommand to record every command that took 200 ms or more, or failed, so a
 * slow or stuck operation can be traced to the CDP command that held it. Nothing else changes.
 */
const SW_TRACE_ON = `(() => {
  if (globalThis.__p8trace) return 'already';
  const log = globalThis.__p8trace = { slow: [], counts: {} };
  const d = chrome.debugger;
  const orig = d.sendCommand.bind(d);
  d.sendCommand = function (target, method, params, cb) {
    const t0 = Date.now();
    const key = method + (params && params.type ? ':' + params.type : '');
    log.counts[key] = (log.counts[key] || 0) + 1;
    const p = orig(target, method, params);
    p.then(() => { const ms = Date.now() - t0; if (ms >= 200 && log.slow.length < 3000) log.slow.push({ at: t0, ms, m: key }); },
      (e) => { if (log.slow.length < 3000) log.slow.push({ at: t0, ms: Date.now() - t0, m: key, err: String((e && e.message) || e).slice(0, 140) }); });
    if (typeof cb === 'function') p.then((r) => cb(r), () => cb());
    return p;
  };
  return chrome.debugger.sendCommand === d.sendCommand ? 'patched' : 'not patched';
})()`;
const SW_TRACE_READ = 'globalThis.__p8trace || null';

/** The slow/failed commands of one operation's time span, grouped by command. */
function traceOf(trace, span) {
  if (!trace || !span) return null;
  const inSpan = trace.slow.filter((e) => e.at >= span[0] - 50 && e.at <= span[1]);
  const byCmd = {};
  for (const e of inSpan) {
    const k = e.err ? `${e.m} ERR ${e.err.slice(0, 60)}` : e.m;
    const g = (byCmd[k] ??= { n: 0, totalMs: 0, maxMs: 0 });
    g.n += 1; g.totalMs += e.ms; g.maxMs = Math.max(g.maxMs, e.ms);
  }
  return byCmd;
}

/** Page access for ground truth: Engine 1 through the harness pipe, Engine 2 through browser_console evaluate. */
function pageViaCdp(conn, sessionId) {
  return async (expression) => {
    const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId, { timeoutMs: 10_000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };
}
function pageViaProduct(agent, tabId) {
  return async (expression) => {
    const r = await callTool(agent, 'browser_console', { action: 'evaluate', expression, tabId }, 30_000);
    if (!r.ok) throw new Error(r.error);
    return r.json?.value ?? r.json?.result ?? r.json;
  };
}

// ─────────────────────────────────────────────────────────────── one state, five operations

function classifyInteract(res) {
  if (res.ok) return res.json?.delivery ?? 'unknown';
  // Round 4: an input error's text starts with its delivery state, "[delivery: missed; …]".
  const tagged = /^\[delivery: ([a-z-]+)/.exec(String(res.error ?? ''));
  if (tagged) return tagged[1];
  if (/never received|not-delivered|HIDDEN/i.test(res.error ?? '')) return 'not-delivered';
  if (/stopped answering wheel events/i.test(res.error ?? '')) return 'error:wheel-stall';
  if (/timed out|did not respond within/i.test(res.error ?? '')) return 'error:timeout';
  return 'error';
}

function verdictOf(report, received) {
  if (report === 'delivered') return received ? 'ok' : 'WRONG: reported delivered, page received nothing';
  if (report === 'not-delivered') return received ? 'WRONG: reported not-delivered, page received it' : 'ok';
  if (report === 'indeterminate') return `indeterminate (page ${received ? 'received it' : 'received nothing'})`;
  return `${report} (page ${received ? 'received it' : 'received nothing'})`;
}

/**
 * Run the five operations on one tab. `page(expr)` evaluates in the page's main world.
 * `ui` is a UiClient for the screencast. Returns a cell per operation.
 */
async function runOperations({ agent, ui, tabId, page, label }) {
  const cells = {};
  const spanCall = async (...a) => { const t = Date.now(); const r = await callTool(...a); r.span = [t, Date.now()]; return r; };
  await page(LOGGER);
  const before = await page(READ);
  const snap = await callTool(agent, 'browser_snapshot', { tabId }, 60_000);
  const refs = refsFrom(snap.json?.tree);
  const truthSince = async (n, settleMs = 700) => { await delay(settleMs); return page(readSince(n)); };

  // click
  {
    const s = await page(READ);
    const res = refs.login
      ? await spanCall(agent, 'browser_interact', { action: 'click', ref: refs.login, humanize: 'human', seed: `${label}-click`, tabId }, 300_000)
      : { ok: false, ms: 0, error: `no ref (snapshot: ${snap.ok ? 'ok' : snap.error})` };
    const ev = await truthSince(s.n);
    const after = await page(READ);
    const received = ev.some((e) => e.t === 'click' && e.trusted && e.id === 'login');
    const report = classifyInteract(res);
    cells.click = { report, received, verdict: verdictOf(report, received), ms: Math.round(res.ms), trustedEvents: ev.filter((e) => e.trusted).length,
      statusAfter: after.status, humanize: res.json?.humanize?.level ?? null, error: res.ok ? null : String(res.error).slice(0, 300), note: res.json?.deliveryNote ?? null, vis: after.vis, span: res.span ?? null, scrolled: res.json?.scrolled ?? null };
  }
  // type
  {
    const s = await page(READ);
    const res = refs.user
      ? await spanCall(agent, 'browser_interact', { action: 'type', ref: refs.user, text: 'abc', typos: false, humanize: 'human', seed: `${label}-type`, tabId }, 300_000)
      : { ok: false, ms: 0, error: 'no ref' };
    const ev = await truthSince(s.n);
    const after = await page(READ);
    const keys = ev.filter((e) => e.trusted && e.t === 'keydown' && e.id === 'user').length;
    const received = keys > 0 || after.user === 'abc';
    const report = classifyInteract(res);
    cells.type = { report, received, verdict: verdictOf(report, received), ms: Math.round(res.ms), trustedKeydowns: keys, valueAfter: after.user,
      humanize: res.json?.humanize?.level ?? null, error: res.ok ? null : String(res.error).slice(0, 300), note: res.json?.deliveryNote ?? null, vis: after.vis, span: res.span ?? null, scrolled: res.json?.scrolled ?? null };
  }
  // wheel
  {
    const s = await page(READ);
    const res = await spanCall(agent, 'browser_interact', { action: 'scroll', direction: 'down', amount: 300, humanize: 'human', seed: `${label}-wheel`, tabId }, 300_000);
    const ev = await truthSince(s.n);
    const after = await page(READ);
    const wheels = ev.filter((e) => e.trusted && e.t === 'wheel').length;
    const received = wheels > 0;
    const report = classifyInteract(res);
    cells.wheel = { report, received, verdict: verdictOf(report, received), ms: Math.round(res.ms), trustedWheels: wheels, scrollDelta: after.sy - s.sy,
      humanize: res.json?.humanize?.level ?? null, error: res.ok ? null : String(res.error).slice(0, 300), note: res.json?.deliveryNote ?? null, vis: after.vis, span: res.span ?? null, scrolled: res.json?.scrolled ?? null };
  }
  // screenshot - must be non-blank AND current: a marker painted just before must be in it
  {
    await page(MARK_ON);
    await delay(150);
    const res = await spanCall(agent, 'browser_screenshot', { area: 'viewport', format: 'png', tabId }, 120_000);
    await page(MARK_OFF).catch(() => {});
    const img = res.images?.[0]?.data ? Buffer.from(res.images[0].data, 'base64') : null;
    const stats = img ? pngStats(img, [{ x: 40, y: 30 }, { x: 120, y: 60 }]) : null;
    const nonBlank = !!stats && (stats.colors == null || stats.colors > 8);
    const isMark = (px) => !!px && px[0] < 40 && px[1] > 210 && px[2] < 50;
    const fresh = !!stats?.pixels && stats.pixels.every(isMark);
    const report = res.ok && img ? 'delivered' : res.ok ? 'no-image' : 'error';
    cells.screenshot = {
      report, received: nonBlank && fresh,
      verdict: report === 'delivered' ? (nonBlank ? (fresh ? 'ok' : 'STALE: image does not show the page as it is now') : 'WRONG: image is blank') : `error: ${String(res.error ?? 'no image').slice(0, 200)}`,
      ms: Math.round(res.ms), span: res.span ?? null, note: res.json?.note ?? null, pageSaw: res.json?.pageSaw ?? null, bytes: img?.length ?? 0, png: stats ? { width: stats.width, height: stats.height, colors: stats.colors, marker: stats.pixels } : null, fresh, vis: (await page(READ)).vis,
    };
  }
  // screencast - frames must keep coming while the page changes (a single first frame is not a stream)
  {
    let frames = 0;
    let live = 0;
    let firstAt = null;
    let mark = Infinity;
    const statuses = [];
    const t0 = Date.now();
    const onEvent = (topic, data) => {
      // The daemon's word on whether the picture is live (round 2 defect: a hidden tab's watch sent
      // one frame and then nothing, and nothing told the viewer).
      if (topic === 'watchStatus' && data?.tabId === tabId) { statuses.push(data.state); return; }
      if (topic !== 'frame' || data?.tabId !== tabId) return;
      frames += 1;
      firstAt ??= Date.now() - t0;
      if (Date.now() >= mark) live += 1;
    };
    ui.on('event', onEvent);
    let watch = null;
    let error = null;
    try {
      watch = await ui.admin('watch', { tabId }, 20_000);
      await delay(1000);
      await page(ANIMATE_ON);
      mark = Date.now() + 200;
      await delay(3200);
    } catch (err) {
      error = String(err?.message ?? err);
    } finally {
      await page(ANIMATE_OFF).catch(() => {});
      await ui.admin('unwatch', { tabId }, 20_000).catch(() => {});
      ui.off('event', onEvent);
    }
    const streaming = live >= 3;
    const vis = (await page(READ)).vis;
    const toldHidden = statuses.includes('hidden');
    const toldNotLive = toldHidden || statuses.includes('idle');
    // Round 3 fix under test: once "hidden", the status leaves it only when the page is visible
    // again (hysteresis). A hidden tab whose status says "live" at any point after "hidden" flapped.
    const flapped = vis === 'hidden' && statuses.indexOf('live') > statuses.indexOf('hidden') && statuses.indexOf('hidden') >= 0;
    cells.screencast = {
      report: streaming ? 'delivered' : error ? 'error' : 'not-delivered', received: streaming, frames, liveFrames: live, firstFrameMs: firstAt,
      watchStatus: statuses,
      verdict: streaming ? 'ok' : error ? `error: ${error.slice(0, 200)}`
        : vis === 'hidden' && !toldHidden ? `WRONG: ${live} frame(s) in 3 s of animation on a hidden tab, and no watchStatus "hidden" told the viewer the picture is stale`
          : flapped ? `FLAP: watchStatus ${JSON.stringify(statuses)} — it went back to "live" while the tab stayed hidden (${live} live frame(s))`
            : live === 0 && !toldNotLive ? `WRONG: no frame in 3 s of animation on a ${vis} tab, and no watchStatus ("hidden"/"idle") told the viewer`
              : `${live} frame(s) in 3 s of animation (${frames} in total)${statuses.length ? `; the viewer was told: watchStatus ${JSON.stringify(statuses)}` : ''}`,
      runId: watch?.runId ?? null, vis,
    };
  }
  // An error is a report too: on a hidden page, one that blames a screencast (none runs while these
  // three operations run) or a dialog (there is none) sends the agent after the wrong cause.
  for (const k of ['click', 'type', 'wheel']) {
    const c = cells[k];
    if (!c || c.received || c.vis !== 'hidden') continue;
    if (c.report === 'error:wheel-stall') c.verdict = 'WRONG REASON: blames a running screencast; the tab is hidden (no screencast ran)';
    else if (c.report === 'error:timeout' || /did not respond within/.test(c.error ?? '')) c.verdict = `WRONG REASON: ${Math.round(c.ms / 1000)} s then a timeout that blames a dialog; the tab is hidden`;
  }
  return { visBefore: before.vis, focusBefore: before.focus, cells, refsFound: Object.values(refs).filter(Boolean).length };
}

// ─────────────────────────────────────────────────────────────── hidden in the middle of an action

const HIDEMID_TEXT = 'the quick brown fox jumps over';

/**
 * Engine 1: the tab is hidden WHILE an action runs — the person whose browser it is switches to
 * another tab mid-way (chrome.tabs.create active:true in the same window, headless). What the page
 * received is read twice: while hidden, and again after the tab is shown (input queued while hidden
 * and delivered late would make a "not delivered" report wrong — and an agent that retries would
 * then act twice). Verdicts:
 *   ok             the report matches the page (including a partial delivery the report names);
 *   MISLEADING     the report is "delivered" but only part arrived and nothing says the tab was hidden;
 *   PARTIAL-WRONG  the report is "not-delivered" but part of the input did arrive;
 *   WRONG          as in runOperations.
 */
async function runHideMidway({ agent, tabId, page, sw, chromeTab, label }) {
  const cells = {};
  await page(LOGGER);
  const snap = await callTool(agent, 'browser_snapshot', { tabId }, 60_000);
  const refs = refsFrom(snap.json?.tree);
  const hideIn = (ms) => delay(ms)
    .then(() => sw(`chrome.tabs.create({ url: 'about:blank', active: true, windowId: ${chromeTab.windowId} }).then((t) => t.id)`))
    .then((id) => ({ id, at: Date.now() }), (err) => ({ id: null, at: Date.now(), error: String(err?.message ?? err) }));
  const restore = async (extra) => {
    if (extra?.id != null) await sw(`chrome.tabs.update(${chromeTab.id}, { active: true }).then(() => chrome.tabs.remove(${extra.id})).then(() => true)`).catch(() => {});
    await waitFor(async () => ((await page(READ)).vis === 'visible' ? true : null), 5000);
  };
  const run = async (args, hideAfterMs) => {
    const s = await page(READ);
    const t0 = Date.now();
    const hid = hideIn(hideAfterMs);
    const res = await callTool(agent, 'browser_interact', { ...args, tabId }, 300_000);
    const callMs = Date.now() - t0;
    const extra = await hid;
    await delay(700);
    const whileHidden = await page(readSince(s.n));
    const hiddenRead = await page(READ);
    await restore(extra);
    await delay(1500);
    const all = await page(readSince(s.n));
    const after = await page(READ);
    return {
      res, s, whileHidden, all, late: all.slice(whileHidden.length), hiddenRead, after, callMs,
      hiddenAtMs: extra.at - t0,
      base: {
        report: res.ok ? (res.json?.delivery ?? 'unknown') : classifyInteract(res), ms: callMs, hiddenAtMs: extra.at - t0,
        hideError: extra.error ?? null, visWhileHidden: hiddenRead.vis, error: res.ok ? null : String(res.error).slice(0, 400),
        note: res.json?.note ?? null, deliveryNote: res.json?.deliveryNote ?? null, humanize: res.json?.humanize?.level ?? null,
      },
    };
  };
  const saysHidden = (r) => /hidden/i.test([r.res.error, r.res.json?.note, r.res.json?.deliveryNote].filter(Boolean).join(' '));

  // type: ~5 s of humanized typing, hidden 1.5 s in. The field is focused first (a click that is
  // not interrupted), so the typing starts at once and the tab goes hidden mid-word.
  if (refs.user) {
    await callTool(agent, 'browser_interact', { action: 'click', ref: refs.user, humanize: 'human', seed: `${label}-hm-focus`, tabId }, 120_000);
    const r = await run({ action: 'type', ref: refs.user, text: HIDEMID_TEXT, typos: false, humanize: 'human', seed: `${label}-hm-type` }, 1500);
    const keys = r.all.filter((e) => e.trusted && e.t === 'keydown' && e.id === 'user').length;
    const lateKeys = r.late.filter((e) => e.trusted && e.t === 'keydown').length;
    const value = r.after.user ?? '';
    const full = value === HIDEMID_TEXT;
    const some = keys > 0 || value.length > 0;
    let verdict;
    if (r.base.report === 'delivered') {
      verdict = full ? 'ok' : !some ? 'WRONG: reported delivered, page received nothing'
        : saysHidden(r) ? 'ok (partial, and the report says the tab was hidden)'
          : `MISLEADING: reported delivered; ${value.length} of ${HIDEMID_TEXT.length} characters arrived (tab hidden ${r.hiddenAtMs} ms in) and nothing says the tab was hidden${r.base.note ? `; note: "${r.base.note}"` : ''}`;
    } else if (r.base.report === 'not-delivered') {
      verdict = some ? `PARTIAL-WRONG: reported not-delivered, but ${value.length} of ${HIDEMID_TEXT.length} characters arrived` : 'ok';
    } else verdict = `${r.base.report} (page got ${value.length} of ${HIDEMID_TEXT.length} characters)`;
    cells.type = { ...r.base, received: some, verdict, trustedKeydowns: keys, lateKeydowns: lateKeys, valueAfter: value, reportedValue: r.res.json?.value ?? null };
  }
  // click: hidden 400 ms into the pointer's approach
  if (refs.login) {
    const r = await run({ action: 'click', ref: refs.login, humanize: 'human', seed: `${label}-hm-click` }, 400);
    const clicked = r.all.some((e) => e.t === 'click' && e.trusted && e.id === 'login');
    const lateClick = r.late.some((e) => e.t === 'click' && e.trusted);
    const verdict = verdictOf(r.base.report, clicked) + (lateClick ? ' — the click reached the page only AFTER the tab was shown again' : '');
    cells.click = { ...r.base, received: clicked, verdict, lateClick, trustedEvents: r.all.filter((e) => e.trusted).length, lateEvents: r.late.filter((e) => e.trusted).length, statusAfter: r.after.status };
  }
  // wheel: a long scroll, hidden 500 ms in
  {
    const r = await run({ action: 'scroll', direction: 'down', amount: 2000, humanize: 'human', seed: `${label}-hm-wheel` }, 500);
    const wheels = r.all.filter((e) => e.trusted && e.t === 'wheel').length;
    const lateWheels = r.late.filter((e) => e.trusted && e.t === 'wheel').length;
    const moved = r.after.sy - r.s.sy;
    let verdict;
    // What the report says the page scrolled (round 4: a partial delivery names it), against what the
    // page had scrolled by the time the report came (read while still hidden) and in the end.
    const said = /The page scrolled (\d+) px (down|up)/.exec(String(r.res.error ?? ''));
    const saidPx = said ? Number(said[1]) * (said[2] === 'up' ? -1 : 1) : null;
    const movedWhileHidden = (r.hiddenRead?.sy ?? r.after.sy) - r.s.sy;
    if (r.base.report === 'delivered') verdict = wheels === 0 ? 'WRONG: reported delivered, page received nothing' : 'ok';
    else if (r.base.report === 'not-delivered') verdict = wheels > 0 ? `PARTIAL-WRONG: reported not-delivered, but ${wheels} wheel event(s) arrived and the page scrolled ${moved} px` : 'ok';
    else if (r.base.report === 'partial') {
      verdict = wheels === 0 && moved === 0 ? 'WRONG: reported partial, the page received nothing'
        : saidPx != null && saidPx !== movedWhileHidden ? `WRONG: reported the page scrolled ${saidPx} px, it had scrolled ${movedWhileHidden} px`
          : `ok (partial: ${wheels} wheel event(s), the report says ${saidPx ?? '?'} px, the page ${movedWhileHidden} px while hidden, ${moved} px in the end)`;
    } else verdict = `${r.base.report} (page got ${wheels} wheel event(s), scrolled ${moved} px)`;
    cells.wheel = { ...r.base, received: wheels > 0, verdict, trustedWheels: wheels, lateWheels, scrollDelta: moved, scrollWhileHidden: movedWhileHidden, reportedScrollPx: saidPx, reportedScroll: r.res.json?.scrolled ?? null };
  }
  return { visBefore: 'visible', cells, refsFound: Object.values(refs).filter(Boolean).length };
}

// ─────────────────────────────────────────────────────────────── Engine 1: the real extension

const OCCLUSION_SWITCH = '--disable-features=CalculateNativeWinOcclusion';
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const OFFSCREEN = '--window-position=-32000,-32000';
/** Asked for by the P8 plan for the minimized state. Always combined with OFFSCREEN and a hidden first show. */
const START_MINIMIZED = '--start-minimized';

/**
 * Branded Chrome 137+ ignores --load-extension (measured on 153: no worker, no request to the
 * daemon). It still loads an unpacked extension over the debugging pipe with
 * Extensions.loadUnpacked, which needs --enable-unsafe-extension-debugging. Edge 153 honours
 * --load-extension. Either way the extension is the same copy with the same dev-daemon.json.
 */
async function launchEngine1({ exe, kind, root, label, state, occlusionOff, ext, guard }) {
  const prof = path.join(root, `prof-${label}`);
  const loadArgs = kind === 'chrome' ? ['--enable-unsafe-extension-debugging'] : [`--load-extension=${ext}`, `--disable-extensions-except=${ext}`];
  const args = [
    '--remote-debugging-pipe', `--user-data-dir=${prof}`, ...loadArgs,
    '--no-first-run', '--no-default-browser-check', '--disable-component-update',
    `--proxy-server=http://127.0.0.1:${assertSafePort(guard.port, 'guard port')}`, '--proxy-bypass-list=<-loopback>',
    '--window-size=1280,800',
    // Live round 2: every fresh Edge profile signed itself in to the Windows account and turned
    // sync on (13/13 of this harness's Engine 1 profiles). The product's own launches now carry
    // these (engine/launch.js); this harness spawns Engine 1 itself, so it carries them too. One
    // --disable-features switch only: Chromium honours the LAST one.
    '--disable-sync',
  ];
  let headed = false;
  if (state === 'active' || state === 'background' || state === 'hidemid') args.push('--headless=new');
  else if (state === 'minimized' || state === 'offscreen' || state === 'hidemidheaded') { args.push(OFFSCREEN); if (state === 'minimized') args.push(START_MINIMIZED); headed = true; }
  else throw new Error(`unknown state ${state}`);
  args.push(occlusionOff ? `${OCCLUSION_SWITCH},msImplicitSignin` : '--disable-features=msImplicitSignin');
  // The one rule that is never relaxed: a headed window never on a monitor.
  if (headed && !args.includes(OFFSCREEN)) throw new Error('refusing an on-screen headed launch');
  args.push('about:blank');
  // windowsHide for EVERY launch: a headed window is created hidden (SW_HIDE) and only then shown,
  // off-screen, without activation (winShow) — it can neither appear on a monitor nor take focus.
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.resume();
  child.stderr.resume();
  child.on('error', () => {});
  const conn = new PipeCdp(child.stdio[3], child.stdio[4], { name: `e1-${label}`, child });
  const version = await conn.send('Browser.getVersion', {}, null, { timeoutMs: 30_000 });
  if (kind === 'chrome') await conn.send('Extensions.loadUnpacked', { path: ext }, null, { timeoutMs: 30_000 });
  // The window as the browser made it, BEFORE this file shows it (it was created hidden). For
  // "minimized" this is the measured effect of --start-minimized by itself.
  let atLaunch = null;
  if (headed) {
    const first = await waitFor(async () => (await conn.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page'), 10_000);
    const bounds = first ? await conn.send('Browser.getWindowForTarget', { targetId: first.targetId }).then((w) => w.bounds, (e) => ({ error: e.message })) : null;
    const win32 = await winShow(root, child.pid, -1);
    atLaunch = { bounds, win32 };
    // Belt and braces: a window already shown on a monitor is minimized at once, without activation.
    if (Array.isArray(win32) && win32.some((w) => w.visible && !w.iconic && w.left > -10000)) {
      await winShow(root, child.pid, SW_SHOWMINNOACTIVE);
      atLaunch.onScreenAtLaunch = true;
    }
  }
  let shown = null;
  if (headed) {
    const cmd = state === 'minimized' ? SW_SHOWMINNOACTIVE : SW_SHOWNOACTIVATE;
    const want = state === 'minimized' ? (w) => w.iconic && !w.foreground : (w) => w.visible && !w.iconic && w.left <= -10000 && !w.foreground;
    shown = await winShowUntil(root, child.pid, cmd, want);
  }
  return { child, conn, pid: child.pid, prof, headed, args, product: version.product, shown, atLaunch };
}

/** A headed window must be off every monitor or minimized. Minimize at once if not. */
async function checkWindow(conn, targetId) {
  try {
    const { bounds } = await conn.send('Browser.getWindowForTarget', { targetId });
    const offscreen = bounds.left <= -10000 || bounds.top <= -10000;
    const safe = bounds.windowState === 'minimized' || offscreen;
    if (!safe) await conn.send('Browser.setWindowBounds', { windowId: (await conn.send('Browser.getWindowForTarget', { targetId })).windowId, bounds: { windowState: 'minimized' } }).catch(() => {});
    return { ...bounds, safe };
  } catch (err) {
    return { error: String(err?.message ?? err), safe: true };
  }
}

async function waitFor(fn, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) return null;
    await delay(stepMs);
  }
}

/** Time one bare Input command on the page session (the harness's own pipe), 5 s budget each. */
async function rawInputProbe(conn, sessionId) {
  const time = async (method, params) => {
    const t0 = Date.now();
    try {
      await conn.send(method, params, sessionId, { timeoutMs: 5000 });
      return Date.now() - t0;
    } catch (err) {
      return /did not return after/.test(String(err?.message)) ? 'no answer in 5 s' : `error: ${String(err?.message ?? err).slice(0, 120)}`;
    }
  };
  const out = {};
  out.mouseMovedMs = await time('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3, button: 'none', buttons: 0, pointerType: 'mouse' });
  out.keyShiftDownMs = await time('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, location: 1 });
  out.keyShiftUpMs = await time('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, location: 1 });
  out.screenshotMs = await time('Page.captureScreenshot', { format: 'jpeg', quality: 30 });
  // Does a bare KEY event reach this page? The product refuses to type into a hidden page ("a
  // headed Chromium silently discards CDP input events"); the hidemid rows saw 30/30 keydowns land
  // on a tab hidden mid-typing. Focus the field from the page itself, send one "z", read it back.
  try {
    const ev = (expression) => conn.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId, { timeoutMs: 5000 }).then((r) => r.result?.value);
    out.fieldFocused = await ev("(() => { const u = document.getElementById('user'); u.value = ''; u.focus(); return document.activeElement === u; })()");
    out.keyZMs = await time('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', text: 'z', unmodifiedText: 'z', windowsVirtualKeyCode: 90 });
    await time('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
    await delay(300);
    out.keyReachedPage = (await ev("document.getElementById('user').value")) === 'z';
    out.visAtKeyProbe = await ev('document.visibilityState');
  } catch (err) {
    out.keyReachedPage = `error: ${String(err?.message ?? err).slice(0, 120)}`;
  }
  return out;
}

async function engine1State({ exe, kind, browserName, root, daemon, agent, ui, guard, serve, ext, state, occlusionOff, rep }) {
  const label = `${browserName}-${state}-${occlusionOff ? 'switch' : 'noswitch'}-r${rep}`;
  const row = { engine: 1, browser: browserName, state, occlusionSwitch: occlusionOff, rep, label };
  const t0 = Date.now();
  const known = new Set(((await callTool(agent, 'browser_engine', { action: 'list' })).json?.engines ?? []).map((e) => e.engineId));
  let b = null;
  try {
    b = await launchEngine1({ exe, kind, root, label, state, occlusionOff, ext, guard });
    row.product = b.product;
    row.args = b.args.filter((a) => !a.startsWith('--user-data-dir') && !a.startsWith('--load-extension') && !a.startsWith('--disable-extensions-except') && !a.startsWith('--proxy'));
    const { conn } = b;
    await conn.send('Target.setDiscoverTargets', { discover: true });
    // Every headed state: check the window before anything else happens in it.
    if (b.headed) {
      row.atLaunch = b.atLaunch;
      if (state === 'minimized') row.startMinimizedHonored = b.atLaunch?.bounds?.windowState === 'minimized';
      if (b.atLaunch?.onScreenAtLaunch) throw new Error(`window was on a monitor at launch (minimized it): ${JSON.stringify(b.atLaunch.win32)}`);
      row.win32 = b.shown;
      if (!b.shown?.ok) throw new Error(`the headed window did not reach the ${state} state: ${JSON.stringify(b.shown?.windows)}`);
      const first = (await conn.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page');
      row.windowAtStart = first ? await checkWindow(conn, first.targetId) : null;
      if (row.windowAtStart && !row.windowAtStart.safe) throw new Error(`window was on screen at start: ${JSON.stringify(row.windowAtStart)} (minimized it)`);
    }
    const worker = await waitFor(async () => (await conn.send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && /\/sw\.js$/.test(t.url)), 30_000);
    if (!worker) throw new Error('the G9BrowserAgent extension worker never started');
    const { sessionId: swSession } = await conn.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    const sw = pageViaCdp(conn, swSession);
    const engineRow = await waitFor(async () => {
      const list = await callTool(agent, 'browser_engine', { action: 'list' });
      return (list.json?.engines ?? []).find((e) => e.kind === 'extension' && !known.has(e.engineId));
    }, 30_000);
    if (!engineRow) throw new Error('the extension never connected to the private daemon');
    row.engineId = engineRow.engineId;
    row.extensionVersion = engineRow.version;
    const open = await callTool(agent, 'browser_tabs', { action: 'open', url: serve.url, engine: engineRow.engineId }, 60_000);
    if (!open.ok) throw new Error(`open failed: ${open.error}`);
    const tabId = open.json.tabId;
    // Find the Chrome tab and the page target of our test page.
    const chromeTab = await waitFor(async () => {
      const tabs = await sw(`chrome.tabs.query({}).then((t) => t.map((x) => ({ id: x.id, url: x.url || x.pendingUrl, active: x.active, status: x.status, windowId: x.windowId })))`);
      return tabs.find((t) => String(t.url).startsWith(serve.url) && t.status === 'complete');
    }, 20_000);
    if (!chromeTab) throw new Error('the test tab never finished loading');
    if (state === 'background') {
      await sw(`chrome.tabs.create({ url: 'about:blank', active: true, windowId: ${chromeTab.windowId} }).then(() => true)`);
    } else {
      // Make the test tab the active one IN its window — chrome.tabs.update never focuses a window.
      await sw(`chrome.tabs.update(${chromeTab.id}, { active: true }).then(() => true)`);
    }
    await delay(600);
    const target = await waitFor(async () => (await conn.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.url.startsWith(serve.url)), 10_000);
    const { sessionId: pageSession } = await conn.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const page = pageViaCdp(conn, pageSession);
    if (b.headed) {
      row.window = await checkWindow(conn, target.targetId);
      if (!row.window.safe) throw new Error(`window on screen: ${JSON.stringify(row.window)} (minimized it)`);
    }
    row.tabs = await sw(`chrome.tabs.query({ windowId: ${chromeTab.windowId} }).then((t) => t.map((x) => ({ active: x.active, test: String(x.url).startsWith(${JSON.stringify(serve.url)}) })))`);
    row.probe = await page(PROBE).catch((e) => ({ error: String(e?.message ?? e) }));
    row.swTraceInstalled = await sw(SW_TRACE_ON).catch((e) => `error: ${e.message}`);
    const ops = state === 'hidemid' || state === 'hidemidheaded'
      ? await runHideMidway({ agent, tabId, page, sw, chromeTab, label })
      : await runOperations({ agent, ui, tabId, page, label });
    Object.assign(row, ops);
    const trace = await sw(SW_TRACE_READ).catch(() => null);
    if (trace) {
      row.swCommandCounts = trace.counts;
      for (const c of Object.values(row.cells)) if (c?.span) c.slowCdp = traceOf(trace, c.span);
    }
    row.probeAfter = await page(PROBE).catch((e) => ({ error: String(e?.message ?? e) }));
    // Ground truth about the browser itself, after the product is done with the tab: does a bare
    // CDP input command on this page come back at all? (Run last: a stuck one could queue others.)
    row.rawInput = await rawInputProbe(conn, pageSession);
    if (b.headed) {
      row.windowAtEnd = await checkWindow(conn, target.targetId);
      row.win32AtEnd = await winShow(root, b.pid, -1);
    }
    await callTool(agent, 'browser_tabs', { action: 'release', tabId }).catch(() => {});
  } catch (err) {
    row.error = String(err?.message ?? err).slice(0, 500);
  } finally {
    if (b) {
      try { await b.conn.send('Browser.close', {}, null, { timeoutMs: 5000 }); } catch { /* closing */ }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && b.child.exitCode === null) await delay(200);
      if (b.child.exitCode === null) killTreeSync(b.pid);
      b.conn.close?.();
      const left = processesMatching(path.basename(b.prof));
      for (const p of left) killTreeSync(p.pid);
      row.leftoverProcs = left.length;
      row.signIn = profileSignIn(b.prof);
    }
    row.ms = Date.now() - t0;
  }
  return row;
}

// ─────────────────────────────────────────────────────────────── Engine 2: daemon-launched

/** The extraArgs a headed Engine 2 launch carries for a state (verified headless first). */
const e2ExtraArgs = (state) => (state === 'minimized' ? [OFFSCREEN, START_MINIMIZED] : state === 'offscreen' ? [OFFSCREEN] : []);

async function engine2State({ root, agent, ui, serve, guard, state, rep, verified }) {
  const label = `e2-edge-${state}-r${rep}`;
  const row = { engine: 2, browser: 'edge', state, occlusionSwitch: true, rep, label };
  const t0 = Date.now();
  let engineId = null;
  try {
    const headed = state === 'minimized' || state === 'offscreen';
    const extraArgs = e2ExtraArgs(state);
    if (headed && !verified.has(extraArgs.join(' '))) throw new Error('extraArgs pass-through not verified headless first; refusing a headed launch');
    const launch = await callTool(agent, 'browser_engine', { action: 'launch', browser: 'edge', headless: !headed, extraArgs, profile: `p8-${label}`, windowSize: { width: 1280, height: 800 }, humanize: 'human', stealth: 'off', ...guardedLaunch(guard) }, 120_000);
    if (!launch.ok) throw new Error(`launch failed: ${launch.error}`);
    engineId = launch.json.engineId;
    row.product = `Edg/${launch.json.version}`;
    row.args = (launch.json.argv ?? []).slice(1).filter((a) => !a.startsWith('--user-data-dir'));
    if (headed && !extraArgs.every((a) => row.args.includes(a))) throw new Error('the headed launch lost its off-screen switch');
    if (headed) {
      // The product spawns headed browsers shown (not hidden): read the window as launched first.
      row.atLaunch = { win32: await winShow(root, launch.json.pid, -1) };
      if (state === 'minimized') row.startMinimizedHonored = Array.isArray(row.atLaunch.win32) && row.atLaunch.win32.length > 0 && row.atLaunch.win32.every((w) => w.iconic);
      const cmd = state === 'minimized' ? SW_SHOWMINNOACTIVE : -1;
      const want = state === 'minimized' ? (w) => w.iconic : (w) => w.left <= -10000 || w.iconic;
      row.win32 = cmd >= 0 ? await winShowUntil(root, launch.json.pid, cmd, want) : { ok: true, windows: await winShow(root, launch.json.pid, -1) };
      const onScreen = Array.isArray(row.win32.windows) && row.win32.windows.some((w) => w.visible && !w.iconic && w.left > -10000);
      if (onScreen) {
        await winShow(root, launch.json.pid, SW_SHOWMINNOACTIVE);
        throw new Error(`Engine 2 window on screen: ${JSON.stringify(row.win32.windows)} (minimized it)`);
      }
      if (!row.win32.ok) throw new Error(`the Engine 2 window did not reach the ${state} state: ${JSON.stringify(row.win32.windows)}`);
    }
    // The first open in the default context reuses the start-up tab: no new window is ever made.
    const open = await callTool(agent, 'browser_tabs', { action: 'open', url: serve.url, engine: engineId }, 60_000);
    if (!open.ok) throw new Error(`open failed: ${open.error}`);
    let tabId = open.json.tabId;
    if (state === 'background') {
      // A second tab opened through the product in the same context. Round 2: the product put later
      // tabs of a context IN ITS WINDOW, and the earlier tab, now behind, rendered ~1 frame per
      // 1.5 s (a click took 85 s). Since round 3 every page G9BrowserAgent opens gets a window of its own
      // (platform-cdp createTabIn, newWindow:true; the list marks it ownWindow), so this row checks
      // that the earlier tab — the one the synthetic window lists as not active — is still driven
      // at full speed. A tab behind another tab in its window is the "popup" state below.
      const second = await callTool(agent, 'browser_tabs', { action: 'open', url: serve.url, engine: engineId }, 60_000);
      if (!second.ok) throw new Error(`second open failed: ${second.error}`);
      row.secondTabId = second.json.tabId;
      await delay(800);
      const list = await callTool(agent, 'browser_tabs', { action: 'list' }, 30_000);
      const ours = (list.json?.tabs ?? []).filter((t) => t.tabId === tabId || t.tabId === second.json.tabId)
        .map((t) => ({ tabId: t.tabId, which: t.tabId === tabId ? 'first' : 'second', active: t.active, windowId: t.windowId, windowState: t.windowState }));
      row.tabsList = ours;
      const probeOf = async (id) => pageViaProduct(agent, id)(PROBE).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
      row.probes = { first: await probeOf(tabId), second: await probeOf(second.json.tabId) };
      const inactive = ours.find((t) => t.active === false);
      row.sameWindow = ours.length === 2 && ours[0].windowId != null && ours[0].windowId === ours[1].windowId;
      tabId = inactive ? inactive.tabId : second.json.tabId;
      row.testedTab = tabId === second.json.tabId ? 'second (opened last)' : 'first';
      row.testedTabActive = inactive ? false : null;
      row.ownWindows = (list.json?.tabs ?? []).filter((t) => t.tabId === open.json.tabId || t.tabId === second.json.tabId).map((t) => !!t.ownWindow);
    }
    if (state === 'popup') {
      // The PAGE opens a tab (a target=_blank link, clicked through the product). It joins the
      // opener's window in front of it (platform-cdp createTabIn: only pages G9BrowserAgent opens get a window
      // of their own) — so the agent's tab is now behind another tab in its own window.
      const opener = pageViaProduct(agent, tabId);
      const popUrl = `${serve.url}?p8popup=1`;
      await opener(`(() => { const a = document.createElement('a'); a.id = 'p8pop'; a.href = ${JSON.stringify(popUrl)}; a.target = '_blank';
        a.textContent = 'P8 popup'; a.style.cssText = 'position:fixed;right:24px;top:24px;z-index:99999;font:16px sans-serif;background:#fff;padding:8px';
        document.body.appendChild(a); return true; })()`);
      const before = new Set(((await callTool(agent, 'browser_tabs', { action: 'list' }, 30_000)).json?.tabs ?? []).map((t) => t.tabId));
      const snap = await callTool(agent, 'browser_snapshot', { tabId }, 60_000);
      const m = /link "P8 popup"[^\n]*?\[ref=(e\d+)\]/.exec(String(snap.json?.tree ?? ''));
      if (!m) throw new Error('the injected target=_blank link is not in the snapshot');
      const click = await callTool(agent, 'browser_interact', { action: 'click', ref: m[1], humanize: 'human', seed: `${label}-open`, tabId }, 120_000);
      row.popupClick = { ok: click.ok, delivery: click.json?.delivery ?? null, ms: Math.round(click.ms), error: click.ok ? null : String(click.error).slice(0, 200) };
      const popup = await waitFor(async () => {
        const l = await callTool(agent, 'browser_tabs', { action: 'list' }, 30_000);
        return (l.json?.tabs ?? []).find((t) => !before.has(t.tabId) && String(t.url ?? '').includes('p8popup=1')) ?? null;
      }, 15_000);
      if (!popup) throw new Error(`the page's target=_blank link opened no tab the product lists (click: ${JSON.stringify(row.popupClick)})`);
      row.popupTabId = popup.tabId;
      await delay(800);
      const l2 = await callTool(agent, 'browser_tabs', { action: 'list' }, 30_000);
      row.tabsList = (l2.json?.tabs ?? []).filter((t) => t.tabId === tabId || t.tabId === popup.tabId).map((t) => ({
        tabId: t.tabId, which: t.tabId === tabId ? 'opener (tested)' : 'popup', active: t.active, ownWindow: !!t.ownWindow, windowId: t.windowId, openerTabId: t.openerTabId ?? null,
      }));
      const probeOf = async (id) => pageViaProduct(agent, id)(PROBE).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
      row.probes = { opener: await probeOf(tabId), popup: await probeOf(popup.tabId) };
    }
    await delay(500);
    const page = pageViaProduct(agent, tabId);
    row.probe = await page(PROBE).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
    // What the product tells an agent about this tab before it acts (round 3: a minimized launched
    // window is warned about here).
    const st = await callTool(agent, 'browser_status', { tabId }, 30_000);
    row.statusWarnings = st.ok ? (st.json?.warnings ?? []) : [`error: ${String(st.error).slice(0, 200)}`];
    const ops = await runOperations({ agent, ui, tabId, page, label });
    Object.assign(row, ops);
    // Round 3 findings, kept as checks: a stalled capture on a MINIMIZED launched window must not
    // be explained as "visible and in front … a browser-side compositor stall" (capture.js reads
    // the synthetic window, never minimized); and a tab that takes over 15 s per click or capture
    // must not be one browser_status had nothing to say about.
    const shot = row.cells?.screenshot;
    if (state === 'minimized' && shot?.note && /visible and its tab in front|compositor stall/.test(shot.note)) {
      shot.verdict = `WRONG CAUSE: the capture stalled ${Math.round(shot.ms / 1000)} s on a minimized window and the note blames a compositor stall on a visible, front tab`;
    }
    const slowest = Math.max(row.cells?.click?.ms ?? 0, row.cells?.type?.ms ?? 0, shot?.ms ?? 0);
    row.unwarnedSlow = slowest > 15_000 && !(row.statusWarnings ?? []).length
      ? `${Math.round(slowest / 1000)} s for one operation, and browser_status gave no warning for this tab` : null;
    row.probeAfter = await page(PROBE).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
  } catch (err) {
    row.error = String(err?.message ?? err).slice(0, 500);
  } finally {
    if (engineId) {
      const stop = await callTool(agent, 'browser_engine', { action: 'stop', engineId, force: true }, 60_000);
      row.stopped = stop.ok ? true : stop.error;
    }
    row.ms = Date.now() - t0;
  }
  return row;
}

// ─────────────────────────────────────────────────────────────── main

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split('=', 2);
    const next = argv[i + 1];
    if (inline !== undefined) out[k] = inline;
    else if (next !== undefined && !next.startsWith('--')) { out[k] = next; i += 1; } else out[k] = true;
  }
  return out;
}

function cellText(c) {
  if (!c) return '—';
  const ok = c.verdict === 'ok';
  return `${c.report}${ok ? '' : ` [${c.verdict}]`}`;
}

function printMatrix(rows) {
  console.log('\nengine | browser | state | occl.switch | vis | rAF ms | click | type | wheel | screenshot | screencast | ms click/type/wheel/shot');
  for (const r of rows) {
    if (r.error) { console.log(`${r.engine} | ${r.browser} | ${r.state} | ${r.occlusionSwitch ? 'on' : 'off'} | ERROR ${r.error}`); continue; }
    const c = r.cells ?? {};
    console.log([r.engine, r.browser, r.state, r.occlusionSwitch ? 'on' : 'off', r.visBefore, r.probe?.rafMs ?? 'none',
      cellText(c.click), cellText(c.type), cellText(c.wheel), cellText(c.screenshot), `${cellText(c.screencast)} (${c.screencast?.frames ?? 0} fr)`,
      [c.click?.ms, c.type?.ms, c.wheel?.ms, c.screenshot?.ms].join('/')].join(' | '));
  }
  for (const r of rows.filter((x) => x.statusWarnings)) {
    console.log(`status warnings ${r.label}: ${r.statusWarnings.length ? r.statusWarnings.map((w) => w.slice(0, 90)).join(' || ') : '(none)'}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // A stray socket error must cost one measurement, never the cleanup of everything we started.
  process.on('uncaughtException', (err) => log(`uncaught (kept running): ${err?.stack ?? err}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection (kept running): ${err?.stack ?? err}`));
  const engines = String(args.engines ?? '1,2').split(',').map(Number);
  const repeat = Number(args.repeat ?? 1);
  const states = String(args.states ?? 'active,background,minimized,offscreen,hidemid,hidemidheaded').split(',');
  const e2States = String(args['e2-states'] ?? 'active,background,popup,minimized,offscreen').split(',');
  const occl = String(args.occlusion ?? 'off,on').split(',');
  const root = await makeRoot('matrix');
  const edge = await resolveBrowser('edge');
  const browsers = String(args.browsers ?? 'edge,chrome').split(',');
  const chrome = browsers.includes('chrome') ? await resolveBrowser('chrome').catch(() => null) : null;
  const report = {
    date: new Date().toISOString(), g9: VERSION, node: process.version, os: `${os.type()} ${os.release()}`,
    browsers: { edge: edge.version, chrome: chrome?.version ?? null }, notMeasured: ['locked session (disruptive: would lock the owner\'s workstation)', 'another virtual desktop (disruptive)'],
    testpageSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(SETUP, 'testpage.html'))).digest('hex').slice(0, 16),
    rows: [],
  };
  log(`P8 matrix — root ${root}, Edge ${edge.version}, Chrome ${chrome?.version ?? 'n/a'}, engines ${engines.join(',')}, E1 states ${states.join(',')}, E2 states ${e2States.join(',')}, repeat ${repeat}`);
  let serve = null;
  let guard = null;
  let daemon = null;
  let ui = null;
  let exitCode = 0;
  try {
    serve = await startServe(await freePort());
    daemon = await startDaemon({
      root,
      settings: { humanize: 'human', stealth: 'off', headless: true, idleExitMinutes: 0, maxParallel: 8 },
      env: { G9_ENGINE_RESUME_MS: '0' },
      name: 'p8-matrix',
    });
    guard = await startGuard([serve.port, daemon.port]);
    ui = await daemon.ui();
    const agent = daemon.first;
    log(`daemon ${daemon.pid} on ${daemon.port}, serve ${serve.port}, guard ${guard.port}`);

    if (engines.includes(1)) {
      const ext = path.join(root, 'ext');
      await fsp.cp(path.join(ROOT, 'extension'), ext, { recursive: true });
      await fsp.writeFile(path.join(ext, 'dev-daemon.json'), JSON.stringify({ host: '127.0.0.1', port: assertSafePort(daemon.port) }));
      const targets = [['edge', edge], ['chrome', chrome]].filter(([k, b]) => browsers.includes(k) && b);
      for (let rep = 1; rep <= repeat; rep += 1) for (const [kind, bin] of targets) {
        for (const state of states) {
          // hidemid is headless (the switch changes nothing there); hidemidheaded needs the switch,
          // or its off-screen window is hidden before anything starts.
          for (const o of (state === 'hidemid' ? ['off'] : state === 'hidemidheaded' ? ['on'] : occl)) {
            const row = await engine1State({ exe: bin.path, kind, browserName: kind, root, daemon, agent, ui, guard, serve, ext, state, occlusionOff: o === 'on', rep });
            report.rows.push(row);
            log(`E1 ${row.label}: ${row.error ? `ERROR ${row.error}` : `vis ${row.visBefore} | ${Object.entries(row.cells).map(([k, c]) => `${k} ${c.report}${c.verdict === 'ok' ? '' : ` [${c.verdict}]`}`).join(' | ')}`} (${row.ms} ms)`);
          }
        }
      }
    }
    if (engines.includes(2)) {
      // Prove extraArgs reach the browser HEADLESS before any headed Engine 2 launch.
      const verified = new Set();
      for (const extra of [e2ExtraArgs('offscreen'), e2ExtraArgs('minimized')]) {
        const l = await callTool(agent, 'browser_engine', { action: 'launch', browser: 'edge', headless: true, extraArgs: extra, profile: `p8-verify-${verified.size}-${extra.length}`, ...guardedLaunch(guard) }, 120_000);
        if (l.ok && extra.every((a) => (l.json.argv ?? []).includes(a))) verified.add(extra.join(' '));
        if (l.ok) await callTool(agent, 'browser_engine', { action: 'stop', engineId: l.json.engineId, force: true });
      }
      report.e2ExtraArgsVerified = [...verified];
      // Engine 2 "without the switch": the product always disables CalculateNativeWinOcclusion
      // (engine/launch.js DISABLED_FEATURES). Asking it to enable the feature is the only way to get
      // the other half of the pair through the product; record what it says.
      {
        const l = await callTool(agent, 'browser_engine', { action: 'launch', browser: 'edge', headless: true, extraArgs: ['--enable-features=CalculateNativeWinOcclusion'], profile: 'p8-verify-occl', ...guardedLaunch(guard) }, 120_000);
        report.e2WithoutSwitch = l.ok ? { launched: true, argv: (l.json.argv ?? []).filter((a) => /features/i.test(a)) } : { launched: false, refusal: String(l.error).slice(0, 300) };
        if (l.ok) await callTool(agent, 'browser_engine', { action: 'stop', engineId: l.json.engineId, force: true });
      }
      for (let rep = 1; rep <= repeat; rep += 1) {
        for (const state of e2States) {
          const row = await engine2State({ root, agent, ui, serve, guard, state, rep, verified });
          report.rows.push(row);
          log(`E2 ${row.label}: ${row.error ? `ERROR ${row.error}` : `vis ${row.visBefore} | ${Object.entries(row.cells).map(([k, c]) => `${k} ${c.report}${c.verdict === 'ok' ? '' : ` [${c.verdict}]`}`).join(' | ')}`} (${row.ms} ms)`);
        }
      }
    }
    report.guard = { blocked: guard.hits.filter((h) => !h.ok).length, allowed: guard.hits.filter((h) => h.ok).length, attempts8765: guard.attempts8765(),
      blockedHosts: [...new Set(guard.hits.filter((h) => !h.ok).map((h) => `${h.host}:${h.port}`))].slice(0, 40) };
    const wrong = report.rows.flatMap((r) => Object.entries(r.cells ?? {}).filter(([, c]) => /^(WRONG|STALE|FLAP|MISLEADING|PARTIAL-WRONG)/.test(String(c.verdict))).map(([k, c]) => `${r.label} ${k}: ${c.verdict}`));
    for (const r of report.rows) if (r.unwarnedSlow) wrong.push(`${r.label}: UNWARNED ${r.unwarnedSlow}`);
    report.wrongReports = wrong;
    if (wrong.length || report.rows.some((r) => r.error)) exitCode = 1;
    printMatrix(report.rows);
    for (const w of wrong) log(`not ok: ${w.slice(0, 300)}`);
    log(`guard: ${JSON.stringify({ attempts8765: report.guard.attempts8765, blocked: report.guard.blocked, allowed: report.guard.allowed })}`);
  } catch (err) {
    exitCode = 2;
    report.error = String(err?.stack ?? err);
    console.error('MATRIX ERROR', err);
  } finally {
    try { ui?.close(); } catch { /* gone */ }
    if (daemon) report.daemonStopped = await daemon.stop();
    if (daemon) report.e2Profiles = homeProfilesSignIn(daemon.home);
    await guard?.close();
    await serve?.stop();
    if (!args.keep) report.cleanup = await cleanupRoot(root, { pids: [serve?.pid, daemon?.pid].filter(Boolean) });
    const out = args.out ? path.resolve(String(args.out)) : null;
    if (out) await fsp.writeFile(out, JSON.stringify(report, null, 2));
    log(`cleanup: ${JSON.stringify(report.cleanup ?? 'kept')}`);
  }
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
