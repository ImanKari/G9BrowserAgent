/**
 * `npm run test:render` — the real window, looked at: `main.mjs --check-render` against the real g9d
 * of this repository, once with nothing in it and once with real data, in dark and in light.
 *
 * Why this exists: the unit tests render the views into a fake DOM. That proves the logic and says
 * nothing about pixels — layout at 1100×720, contrast in both schemes, what an empty view looks like,
 * whether a long name overflows. This drives the real Electron window against a real daemon and a
 * real headless browser and writes one PNG per view (and per extra screenful, up to six) for a
 * person to LOOK at, plus watch-hidden.png (the "not live" banner over a real frame) and
 * watch-again.png (Watch on a later visit). It prints where they are; it cannot judge them.
 *
 * It also proves what the check promises the person running it: the window never reaches the
 * screen and never takes the keyboard focus. A PowerShell poller samples, several times a second for
 * the whole check, every visible top-level window of our processes (its rect against the virtual
 * screen) and the foreground window. One sample on screen, or one sample of ours in the foreground,
 * fails the run.
 *
 * Scenarios (--scenario empty|populated|all, default all):
 *   empty      a fresh G9_HOME; the app starts the daemon itself (the launcher path it uses at sign-in).
 *   populated  a daemon started here with a headless launched engine, an agent holding a tab on a
 *              small lab page served here, a flow seeded and replayed twice (the second run, on a
 *              changed page, has surprises: a new console error and a new failing request), a flow
 *              that fails its assertion, and a schedule entry run once through the runner.
 * Other options: --themes dark,light (default both), --browser edge|chrome|cft|auto (default edge),
 * --out <dir> (copy the PNGs and the window samples there; otherwise they go with the temp folder),
 * --packaged (the window of dist/win-unpacked/G9BrowserAgent.exe instead of the repo's app: its renderer comes
 * out of app.asar over g9app://, and on the empty home it starts the daemon from resources/ as
 * G9BrowserAgent.exe + ELECTRON_RUN_AS_NODE — only the build shows whether those still work).
 *
 * Safety: everything lives in one temp folder (both G9_HOMEs, the Electron profile, the project);
 * ports are random in 18000-18999, never 8765; the browsers are headless; the Electron window is at
 * -32000,-32000, transparent and not focusable. Electron is spawned with windowsHide:false on
 * purpose: a GUI child started with SW_HIDE in its STARTUPINFO gets its first ShowWindow corrected
 * by Chromium to SW_SHOWNORMAL, which ACTIVATES the window. At the end every process whose command
 * line names the temp folder is stopped (only those), plus every pid this script started, and each
 * daemon is shut down through admin `shutdown` once /health confirms its home is ours.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { freePort, tmpDir, rmrf, until, sleep } from './harness.mjs';
import { DaemonClient } from '../lib/daemon-client.mjs';
import { probeHealth, waitForPortFree } from '../lib/daemon-launch.mjs';
import { buildScheduleEntry } from '../renderer/lib/schedule.js';

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(APP_DIR, '..');
const G9D = path.join(REPO, 'daemon', 'g9d.mjs');
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;

// This script's own children (the shim, the daemon, the runner the daemon spawns) must run as
// plain Node; an agent host's ELECTRON_RUN_AS_NODE would otherwise make Electron a Node, too.
delete process.env.ELECTRON_RUN_AS_NODE;

const ARGV = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = ARGV.indexOf(`--${name}`);
  return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : fallback;
};
const SCENARIOS = opt('scenario', 'all') === 'all' ? ['empty', 'populated'] : opt('scenario', 'all').split(',');
const THEMES = opt('themes', 'dark,light').split(',').filter((t) => ['dark', 'light'].includes(t));
const BROWSER = opt('browser', 'edge');
const OUT = opt('out', null);
const PACKAGED = ARGV.includes('--packaged');
const PACKAGED_EXE = path.join(APP_DIR, 'dist', 'win-unpacked', process.platform === 'win32' ? 'G9BrowserAgent.exe' : 'G9BrowserAgent');

if (!fs.existsSync(G9D)) {
  console.log(`desktop: render check — SKIPPED: ${G9D} does not exist`);
  process.exit(0);
}
let ELECTRON;
if (PACKAGED) {
  if (!fs.existsSync(PACKAGED_EXE)) {
    console.log(`desktop: render check — SKIPPED: ${PACKAGED_EXE} does not exist (npm run build:win first)`);
    process.exit(0);
  }
} else {
  try {
    ELECTRON = require('electron'); // under plain Node: the binary's path
  } catch {
    console.log('desktop: render check — SKIPPED: electron is not installed (npm install in desktop/)');
    process.exit(0);
  }
}

const root = tmpDir('g9-desktop-render-');
const FRAG = path.basename(root); // in the command line of every process that belongs to this run
const ours = new Set();
const failures = [];
const report = { root, checks: [], fixture: {} };

function note(line) {
  console.log(`  ${line}`);
}
function check(ok, what, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

// ------------------------------------------------------------------ the window poller

// The WMI query costs ~200 ms, so it runs every 2 s; the Electron main process (the owner of every
// top-level window the app makes) is known at once from the pid file, read on every sample.
const WATCH_PS1 = path.join(root, 'window-watch.ps1');
fs.writeFileSync(WATCH_PS1, String.raw`
param([string]$Fragment, [string]$StopFile, [string]$OutFile, [string]$ReadyFile, [string]$PidFile)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class G9Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  public static List<IntPtr> Top() { var l = new List<IntPtr>(); EnumWindows((h, x) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static string Text(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
}
'@
[void][G9Win]::SetProcessDPIAware()
$vx = [G9Win]::GetSystemMetrics(76); $vy = [G9Win]::GetSystemMetrics(77); $vw = [G9Win]::GetSystemMetrics(78); $vh = [G9Win]::GetSystemMetrics(79)
$pids = @{}; $allPids = @{}; $last = [datetime]::MinValue; $samples = 0
$focus = New-Object System.Collections.ArrayList; $onScreen = New-Object System.Collections.ArrayList; $seen = @{}
Set-Content -LiteralPath $ReadyFile -Value 'ready'
while (-not (Test-Path -LiteralPath $StopFile)) {
  if (([datetime]::Now - $last).TotalMilliseconds -gt 2000) {
    foreach ($p in (Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%$Fragment%'")) { $pids[[uint32]$p.ProcessId] = $p.Name; $allPids[[uint32]$p.ProcessId] = $p.Name }
    $last = [datetime]::Now
  }
  if (Test-Path -LiteralPath $PidFile) {
    foreach ($x in (Get-Content -LiteralPath $PidFile)) {
      if ($x -match '^[0-9]+$' -and -not $pids.ContainsKey([uint32]$x)) { $pids[[uint32]$x] = 'electron.exe'; $allPids[[uint32]$x] = 'electron.exe' }
    }
  }
  $samples++
  $fg = [G9Win]::GetForegroundWindow(); $fgPid = [uint32]0; [void][G9Win]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  if ($pids.ContainsKey($fgPid)) { [void]$focus.Add([pscustomobject]@{ at = [datetime]::Now.ToString('HH:mm:ss.fff'); pid = $fgPid; title = [G9Win]::Text($fg); class = [G9Win]::Cls($fg) }) }
  foreach ($h in [G9Win]::Top()) {
    $wp = [uint32]0; [void][G9Win]::GetWindowThreadProcessId($h, [ref]$wp)
    if (-not $pids.ContainsKey($wp)) { continue }
    if (-not [G9Win]::IsWindowVisible($h)) { continue }
    $r = New-Object G9Win+RECT; [void][G9Win]::GetWindowRect($h, [ref]$r)
    $ex = [int64][G9Win]::GetWindowLongPtr($h, -20)
    $info = [pscustomobject]@{ hwnd = "$h"; pid = $wp; process = $pids[$wp]; title = [G9Win]::Text($h); class = [G9Win]::Cls($h); rect = @($r.L, $r.T, $r.R, $r.B); iconic = [G9Win]::IsIconic($h); noActivate = (($ex -band 0x08000000) -ne 0); layered = (($ex -band 0x80000) -ne 0); toolWindow = (($ex -band 0x80) -ne 0) }
    $seen["$h"] = $info
    $inter = ($r.R -gt $vx) -and ($r.L -lt ($vx + $vw)) -and ($r.B -gt $vy) -and ($r.T -lt ($vy + $vh)) -and ($r.R -gt $r.L) -and ($r.B -gt $r.T)
    if ($inter -and -not $info.iconic -and $onScreen.Count -lt 50) { [void]$onScreen.Add($info) }
  }
  Start-Sleep -Milliseconds 100
}
$out = [pscustomobject]@{ samples = $samples; virtualScreen = @($vx, $vy, $vw, $vh); processes = @($allPids.GetEnumerator() | ForEach-Object { "$($_.Key) $($_.Value)" }); windows = @($seen.Values); onScreen = @($onScreen); focus = @($focus | Select-Object -First 50); focusCount = $focus.Count }
$out | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutFile -Encoding UTF8
`);

async function startWatcher(label) {
  const files = {
    stop: path.join(root, `watch-${label}.stop`),
    out: path.join(root, `watch-${label}.json`),
    ready: path.join(root, `watch-${label}.ready`),
    pids: path.join(root, `watch-${label}.pids`),
  };
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WATCH_PS1,
    '-Fragment', FRAG, '-StopFile', files.stop, '-OutFile', files.out, '-ReadyFile', files.ready, '-PidFile', files.pids],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  ours.add(child.pid);
  let err = '';
  child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  const exited = new Promise((r) => child.on('exit', (code) => { ours.delete(child.pid); r(code); }));
  await until(() => fs.existsSync(files.ready), { timeoutMs: 60_000, intervalMs: 100, what: `the window poller (${err})` });
  return {
    watchPid(pid) {
      fs.appendFileSync(files.pids, `${pid}\n`);
    },
    async stop() {
      fs.writeFileSync(files.stop, '');
      const code = await Promise.race([exited, sleep(30_000).then(() => 'timeout')]);
      if (!fs.existsSync(files.out)) throw new Error(`the window poller wrote nothing (exit ${code}): ${err}`);
      return JSON.parse(fs.readFileSync(files.out, 'utf8').replace(/^﻿/, ''));
    },
  };
}

// ------------------------------------------------------------------ one check-render run

async function runCheck(label, { home, port, theme }) {
  const dir = path.join(root, 'shots', label);
  const watcher = await startWatcher(label);
  const env = { ...process.env, G9_HOME: home, G9_PORT: String(port), G9_CHECK_THEME: theme, G9_IDLE_EXIT_MS: '120000' };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  const [cmd, args] = PACKAGED ? [PACKAGED_EXE, ['--check-render', dir]] : [ELECTRON, [APP_DIR, '--check-render', dir]];
  const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  ours.add(child.pid);
  watcher.watchPid(child.pid);
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { killTree(child.pid); resolve('timeout'); }, 240_000);
    child.on('exit', (c) => { clearTimeout(timer); ours.delete(child.pid); resolve(c); });
  });
  const ms = Date.now() - started;
  const win = await watcher.stop();
  let result = null;
  try {
    result = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).at(-1));
  } catch { /* reported below */ }
  const row = { label, theme, code, ms, result, windows: win };
  report.checks.push(row);

  console.log(`\n[${label}] check-render, ${theme}, ${(ms / 1000).toFixed(1)} s, exit ${code}`);
  check(code === 0 && result?.ok === true, `${label}: --check-render exits 0 with ok:true`,
    result ? `problems: ${JSON.stringify(result.problems).slice(0, 600)}` : `no JSON: ${out.slice(-300)} ${err.slice(-600)}`);
  const shots = result?.shots ?? [];
  const missing = shots.filter((s) => !fs.existsSync(s.file));
  check(shots.length >= 8 && !missing.length, `${label}: one PNG per view at least`, `${shots.length} shot(s): ${shots.map((s) => s.view).join(', ')}`);
  // Populated: a tab is up, so the Watch picker offers it on every visit, and the hidden-tab banner
  // is pictured over a real frame (watch-hidden.png).
  if (label.startsWith('populated')) {
    const po = result?.pickerOptions ?? {};
    check(po.first >= 1 && po.second === po.first, `${label}: the Watch picker offers the tab on the first and on later visits`, JSON.stringify(po));
    check(shots.some((s) => s.view === 'watch-hidden'), `${label}: the hidden-tab banner was pictured (watch-hidden.png)`);
  }
  const sizes = [...new Set(shots.map((s) => `${s.size?.width}x${s.size?.height}`))];
  note(`picture size(s): ${sizes.join(', ')}`);
  const warnings = (result?.problems ?? []).filter((p) => !(p.level === 'error' || p.level === 3));
  if (warnings.length) note(`console warnings: ${JSON.stringify(warnings).slice(0, 600)}`);
  const mine = win.windows ?? [];
  note(`window samples: ${win.samples}; visible top-level windows of ours: ${mine.length ? mine.map((w) => `${w.process}#${w.pid} "${w.title}" [${w.rect.join(',')}] noActivate=${w.noActivate} layered=${w.layered}`).join('; ') : 'none'}`);
  check(win.samples >= Math.floor(ms / 250), `${label}: the poller sampled the whole run`, `${win.samples} samples in ${ms} ms`);
  check((win.onScreen ?? []).length === 0, `${label}: no window of ours ever intersected the screen`,
    win.onScreen?.length ? JSON.stringify(win.onScreen.slice(0, 3)) : `virtual screen ${win.virtualScreen.join(',')}`);
  check(win.focusCount === 0, `${label}: no window of ours was ever the foreground window`, win.focusCount ? JSON.stringify(win.focus.slice(0, 3)) : '');
  return row;
}

// ------------------------------------------------------------------ processes

function killTree(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

/** Every process whose command line names the temp folder: pid + name. Only ours can match. */
function processesOfThisRun() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${FRAG}%'" | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`],
  { encoding: 'utf8', windowsHide: true });
  return (r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => ({ pid: Number(l.split(' ')[0]), name: l.split(' ').slice(1).join(' ') }));
}

/** Shut a daemon down through admin, but only one whose /health says it lives in our temp folder. */
async function shutdownDaemon(port) {
  const h = await probeHealth(port);
  if (h.status !== 'g9d') return 'none';
  if (!String(h.body.home ?? '').includes(FRAG)) return `not ours (${h.body.home})`;
  const c = new DaemonClient({ port, version: VERSION, clientName: 'render-check-cleanup' });
  c.start();
  try {
    await c.whenConnected(10_000);
    await c.admin('shutdown').catch(() => {});
  } catch {
    try { process.kill(h.body.pid); } catch { /* gone */ }
  } finally {
    c.stop();
  }
  const free = await waitForPortFree(port, { timeoutMs: 20_000 });
  if (!free) try { process.kill(h.body.pid); } catch { /* gone */ }
  return free ? 'stopped' : 'killed';
}

// ------------------------------------------------------------------ the lab page (populated)

function startLab() {
  let changed = false;
  const hits = {};
  const page = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>G9BrowserAgent render lab</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #1c2230; }
  header { background: #274c77; color: #fff; padding: 14px 28px; font-weight: 600; letter-spacing: .02em; }
  main { max-width: 560px; margin: 36px auto; background: #fff; border-radius: 10px; padding: 28px 32px; box-shadow: 0 2px 10px #0001; }
  label { display: block; margin: 12px 0 4px; font-size: 13px; color: #56607a; }
  input { width: 100%; box-sizing: border-box; padding: 9px 11px; border: 1px solid #c9cfdb; border-radius: 6px; font: inherit; }
  button { margin-top: 18px; padding: 9px 20px; border: 0; border-radius: 6px; background: #274c77; color: #fff; font: inherit; cursor: pointer; }
  #status { margin-top: 16px; color: #3a6f3a; }
</style></head>
<body><header id="lab">Acme Field Ops — sign in</header>
<main>
  <h1 style="margin:0 0 6px;font-size:22px">Welcome back</h1>
  <p style="margin:0;color:#56607a">Use admin / g9secret.</p>
  <label for="user">Username</label><input id="user" autocomplete="off">
  <label for="pass">Password</label><input id="pass" type="password" autocomplete="off">
  <button id="login">Sign in</button>
  <p id="status">Not signed in.</p>
</main>
<script>
  const CHANGED = ${changed ? 'true' : 'false'};
  document.getElementById('login').addEventListener('click', async () => {
    const u = document.getElementById('user').value;
    const p = document.getElementById('pass').value;
    await fetch('/api/login', { method: 'POST', body: JSON.stringify({ u }) }).catch(() => {});
    document.getElementById('status').textContent = u === 'admin' && p === 'g9secret' ? 'Signed in as admin.' : 'Wrong user name or password.';
    if (CHANGED) {
      console.error('Widget failed to load: token expired');
      fetch('/api/widget-config').catch(() => {});
    }
  });
</script></body></html>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits[u.pathname] = (hits[u.pathname] ?? 0) + 1;
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page());
    }
    if (u.pathname === '/api/login') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (u.pathname === '/api/widget-config') {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"error":"token expired"}');
    }
    res.writeHead(404);
    return res.end();
  });
  return new Promise((resolve) => {
    freePort().then((port) => server.listen(port, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${port}/`,
      hits,
      setChanged: (v) => { changed = !!v; },
      close: () => new Promise((r) => server.close(r)),
    })));
  });
}

function signInSpec(id, url, { password = 'g9secret', expect = 'Signed in as admin.', name = 'Lab — sign in' } = {}) {
  const css = (sel) => ({ locators: [{ kind: 'css', css: sel }] });
  return {
    format: 'g9/flowspec',
    schemaVersion: 1,
    id,
    name,
    startUrl: url,
    tags: ['smoke', 'render-check'],
    steps: [
      { id: 's1', action: 'navigate', url, waitBudgetMs: 15_000 },
      { id: 's2', action: 'type', target: css('#user'), value: 'admin', waitBudgetMs: 5_000 },
      { id: 's3', action: 'type', target: css('#pass'), value: password, waitBudgetMs: 5_000 },
      { id: 's4', action: 'click', target: css('#login'), waitBudgetMs: 5_000 },
      { id: 's5', action: 'assert', oracle: { kind: 'text', contains: expect }, waitBudgetMs: 4_000 },
    ],
  };
}

async function populate({ home, port }) {
  const { McpClient } = await import('../../runner/mcp-client.mjs');
  const lab = await startLab();
  report.fixture.lab = lab.url;
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(path.join(projectDir, 'QA', 'Flows'), { recursive: true });
  const projectFile = path.join(projectDir, 'g9.project.json');
  fs.writeFileSync(projectFile, JSON.stringify({ flowsDir: 'QA/Flows' }, null, 2));
  fs.writeFileSync(path.join(projectDir, 'QA', 'Flows', 'lab-sign-in.flow.json'),
    JSON.stringify(signInSpec('render.lab.scheduled', lab.url, { name: 'Lab — scheduled sign-in' }), null, 2));

  const env = { ...process.env, G9_HOME: home, G9_PORT: String(port), G9_PROJECT: projectFile, G9_IDLE_EXIT_MS: '600000' };
  const daemon = spawn(process.execPath, [G9D, '--foreground', '--port', String(port), '--home', home],
    { cwd: projectDir, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  ours.add(daemon.pid);
  let daemonErr = '';
  daemon.stderr.on('data', (d) => { daemonErr = (daemonErr + d).slice(-6000); });
  await until(async () => (await probeHealth(port)).status === 'g9d', { timeoutMs: 20_000, intervalMs: 100, what: `the daemon (${daemonErr})` });

  const agent = new McpClient({ env: { G9_HOME: home, G9_PORT: String(port) }, name: 'qa-agent' });
  ours.add(agent.child.pid);
  await agent.initialize();
  const t0 = Date.now();
  const engine = await agent.call('browser_engine', { action: 'launch', browser: BROWSER, headless: true, profile: 'render-lab' }, 240_000);
  report.fixture.engine = { engineId: engine.engineId, browser: engine.browser, version: engine.version, headless: engine.headless, ms: Date.now() - t0 };
  check(engine.headless === true && /^launched-/.test(engine.engineId ?? ''), 'fixture: a headless launched engine', JSON.stringify(report.fixture.engine));
  const tab = await agent.call('browser_tabs', { action: 'open', url: lab.url });
  await agent.call('browser_navigate', { action: 'wait', selector: '#lab', tabId: tab.tabId, timeoutMs: 20_000 });

  const imp = await agent.call('browser_recording', { action: 'import_spec', spec: signInSpec('render.lab.sign-in', lab.url), engine: 'launched' });
  const r1 = await agent.call('browser_recording', { action: 'replay', id: imp.id, tabId: tab.tabId, seedKnownWorld: true, humanize: 'human', seed: 'render-1' }, 300_000);
  lab.setChanged(true);
  await agent.call('browser_navigate', { action: 'goto', url: lab.url, tabId: tab.tabId });
  const r2 = await agent.call('browser_recording', { action: 'replay', id: imp.id, tabId: tab.tabId, humanize: 'human', seed: 'render-2' }, 300_000);
  lab.setChanged(false);
  const bad = await agent.call('browser_recording', { action: 'import_spec', engine: 'launched',
    spec: signInSpec('render.lab.wrong-password', lab.url, { password: 'nope', name: 'Lab — sign in with an old password' }) });
  const r3 = await agent.call('browser_recording', { action: 'replay', id: bad.id, tabId: tab.tabId, humanize: 'off', seed: 'render-3' }, 300_000);
  await agent.call('browser_navigate', { action: 'goto', url: lab.url, tabId: tab.tabId });
  const surprises = (r) => r?.surprises?.length ?? r?.surpriseCount?.total ?? r?.knownWorld?.surprises?.length ?? null;
  report.fixture.replays = [r1, r2, r3].map((r) => ({ verdict: r?.verdict, passed: r?.passed, total: r?.total, surprises: surprises(r), frames: r?.evidence?.frames, runId: r?.evidence?.runId }));
  note(`fixture replays: ${JSON.stringify(report.fixture.replays)}`);
  check(/^PASS/.test(r1?.verdict ?? ''), 'fixture: the seeded replay passes', r1?.verdict);
  check(!/^PASS$/.test(r2?.verdict ?? ''), 'fixture: the replay on the changed page is not a plain PASS', r2?.verdict);
  check(!/^PASS/.test(r3?.verdict ?? ''), 'fixture: the wrong-password flow fails', r3?.verdict);

  // The schedule, exactly as the Schedule view builds it (every option an explicit runner flag).
  const ui = new DaemonClient({ port, version: VERSION, clientName: 'render-check-fixture' });
  ui.start();
  await ui.whenConnected(10_000);
  const entry = {
    ...buildScheduleEntry({ target: 'render.lab.scheduled', name: 'Lab smoke (every 12 h)', mode: 'every', everyMinutes: 720, browser: BROWSER, headless: true, humanize: 'off', stealth: 'off', profile: 'render-sched' }),
    project: projectFile,
  };
  const saved = await ui.admin('schedule.add', { entry });
  await ui.admin('schedule.add', { entry: buildScheduleEntry({ target: 'suite:nightly-regression', name: 'Nightly regression — every flow in the suite, on the release candidate build', mode: 'daily', at: '06:30', browser: 'auto', headless: true }) });
  const t1 = Date.now();
  await ui.admin('schedule.runNow', { entryId: saved.id });
  await until(async () => ((await ui.admin('runs.list', { active: true })).runs ?? []).filter((r) => r.kind === 'schedule').length === 0,
    { timeoutMs: 300_000, intervalMs: 1000, what: 'the scheduled run to finish' });
  const list = (await ui.admin('schedule.list')).entries ?? [];
  const last = list.find((e) => e.id === saved.id)?.lastRun;
  report.fixture.scheduled = { ...last, ms: Date.now() - t1 };
  note(`fixture scheduled run: ${JSON.stringify(report.fixture.scheduled)}`);
  check(last?.exitCode != null, 'fixture: the scheduled run finished', JSON.stringify(last));
  const runs = (await ui.admin('runs.list', { limit: 50 })).runs ?? [];
  report.fixture.runs = runs.map((r) => `${r.kind}:${r.verdict ?? r.state ?? ''}`);
  note(`fixture runs: ${report.fixture.runs.join(', ')}`);
  ui.stop();
  return { lab, agent, engine, tab, daemon };
}

// ------------------------------------------------------------------ scenarios

async function scenarioEmpty() {
  console.log('\n== empty: a fresh G9_HOME, the app starts the daemon itself');
  const home = path.join(root, 'home-empty');
  fs.mkdirSync(home);
  const port = await freePort();
  try {
    for (const theme of THEMES) await runCheck(`empty-${theme}`, { home, port, theme });
    const h = await probeHealth(port);
    check(h.status === 'g9d' && String(h.body.home).includes(FRAG), 'empty: the daemon the app started runs on the temp home', `${h.status} ${h.body?.home ?? ''}`);
  } finally {
    note(`empty: daemon ${await shutdownDaemon(port)}`);
  }
}

async function scenarioPopulated() {
  console.log(`\n== populated: a real daemon, a headless ${BROWSER}, an agent, flows, a schedule`);
  const home = path.join(root, 'home-populated');
  fs.mkdirSync(home);
  const port = await freePort();
  let fx = null;
  try {
    fx = await populate({ home, port });
    for (const theme of THEMES) await runCheck(`populated-${theme}`, { home, port, theme });
  } finally {
    if (fx?.agent) {
      await fx.agent.call('browser_engine', { action: 'list' }).then(async ({ engines = [] }) => {
        for (const e of engines.filter((x) => x.kind === 'launched')) {
          await fx.agent.call('browser_engine', { action: 'stop', engineId: e.engineId, force: true }, 60_000).catch(() => {});
        }
      }).catch(() => {});
      fx.agent.close();
    }
    note(`populated: daemon ${await shutdownDaemon(port)}`);
    await fx?.lab?.close();
  }
}

// ------------------------------------------------------------------ main

let exitCode = 0;
console.log(`desktop: render check (real ${PACKAGED ? `packaged ${PACKAGED_EXE}` : 'Electron'} window off-screen, real g9d, temp ${root})`);
try {
  if (SCENARIOS.includes('empty')) await scenarioEmpty();
  if (SCENARIOS.includes('populated')) await scenarioPopulated();
} catch (err) {
  check(false, 'the render check ran to the end', err?.stack ?? String(err));
} finally {
  if (OUT && fs.existsSync(path.join(root, 'shots'))) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.cpSync(path.join(root, 'shots'), OUT, { recursive: true, filter: (src) => !src.includes('.electron-user-data') });
    fs.writeFileSync(path.join(OUT, 'render-check.json'), JSON.stringify(report, null, 2));
    for (const f of fs.readdirSync(root).filter((x) => /^watch-.*\.json$/.test(x))) fs.copyFileSync(path.join(root, f), path.join(OUT, f));
    console.log(`\nPictures copied to ${OUT}`);
  }
  for (const pid of ours) killTree(pid);
  await sleep(500);
  let left = processesOfThisRun();
  for (const p of left) killTree(p.pid);
  if (left.length) await sleep(1500);
  left = processesOfThisRun();
  check(left.length === 0, 'cleanup: no process of this run is left', left.map((p) => `${p.pid} ${p.name}`).join(', '));
  try { rmrf(root); } catch (err) { note(`could not remove ${root}: ${err.message}`); }
  check(!fs.existsSync(root), 'cleanup: the temp folder is gone', root);
  console.log(`\ndesktop: render check ${failures.length ? `FAILED (${failures.length})` : 'passed'}`);
  exitCode = failures.length ? 1 : 0;
}
process.exit(exitCode);
