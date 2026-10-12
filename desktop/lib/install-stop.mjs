/**
 * Clearing the way for an update install (3.6): what still runs from the installed files.
 *
 * Installing replaces the app's files, and on Windows a running program cannot be replaced. Besides
 * the window and the daemon, every AI client's MCP server is this same program (G9BrowserAgent.exe
 * with ELECTRON_RUN_AS_NODE: mcp/shim.mjs), and an agent that called a tool while the daemon was
 * down started the daemon again from those files (mcp/link.mjs). With an agent connected, "Install
 * now" and "Install when I quit" both failed. Before installing, the app now:
 *   1. writes G9_HOME/updating.json, so no MCP server starts the daemon meanwhile (daemon/paths.js);
 *   2. asks the daemon to shut down (it closes its launched browsers and closes open runs as
 *      interrupted), and waits for its port;
 *   3. stops every other process running this program — the MCP servers, and a daemon that did not
 *      exit — never this process, nor its own Electron helpers.
 * An AI client whose MCP server stopped starts it again (or the person reconnects it there); its
 * next call reaches the updated daemon.
 *
 * Every OS call is injected, so the choice of what to stop is tested with plain node.
 */

import { execFile } from 'node:child_process';

/** How long the "updating" marker holds MCP servers back: an install takes well under this. */
export const UPDATING_MARKER_MS = 5 * 60 * 1000;

/** The marker's content. Pure. */
export function updatingMarkerBody({ version, now = Date.now(), pid = process.pid } = {}) {
  return { version: version ?? null, pid, since: new Date(now).toISOString(), until: now + UPDATING_MARKER_MS };
}

const norm = (p, platform) => {
  const s = String(p ?? '').replace(/\\/g, '/');
  return platform === 'win32' ? s.toLowerCase() : s;
};

/**
 * Of the processes listed, the ones to stop. Pure.
 * @param {{pid:number, ppid?:number, exe?:string, cmd?:string}[]} rows
 * @returns the rows running `execPath` that are neither this process nor one of its Electron helpers
 *   (a helper's command line carries `--type=`: renderer, GPU, utility).
 */
export function pickInstallProcesses(rows, { execPath, selfPid = process.pid, platform = process.platform } = {}) {
  const want = norm(execPath, platform);
  if (!want) return [];
  return (rows ?? []).filter((r) => {
    if (!Number.isInteger(r?.pid) || r.pid <= 0 || r.pid === selfPid) return false;
    const exe = r.exe ? norm(r.exe, platform) : null;
    const cmd = norm(r.cmd, platform);
    // Without an executable path (ps), the command line starts with it — quoted or not.
    const runsIt = exe ? exe === want : cmd.replace(/^"/, '').startsWith(want);
    if (!runsIt) return false;
    if (r.ppid === selfPid && /\s--type=/.test(` ${cmd}`)) return false;
    return true;
  });
}

/** Parse `ps -axww -o pid=,ppid=,command=`. Pure. */
export function parsePs(text) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
  }
  return rows;
}

/** Parse the JSON of Get-CimInstance Win32_Process (one object, or an array). Pure. */
export function parseCim(text) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  let v;
  try {
    v = JSON.parse(t);
  } catch {
    return [];
  }
  return (Array.isArray(v) ? v : [v]).map((p) => ({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), exe: p.ExecutablePath ?? null, cmd: p.CommandLine ?? '' }));
}

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

/** Every process running a program named like `execPath`, from the OS. */
export async function listProcesses({ execPath, platform = process.platform, exec = run } = {}) {
  if (platform === 'win32') {
    const name = String(execPath).split(/[\\/]/).pop().replace(/'/g, "''");
    const ps = `Get-CimInstance Win32_Process -Filter "Name='${name}'" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
    return parseCim(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]));
  }
  return parsePs(await exec('ps', ['-axww', '-o', 'pid=,ppid=,command=']));
}

/**
 * Stop every other process running this program, and wait until they are gone.
 * @returns {Promise<{stopped:number[], left:number[]}>}
 */
export async function stopInstallProcesses({ execPath, selfPid = process.pid, platform = process.platform, list = () => listProcesses({ execPath, platform }), kill = (pid) => process.kill(pid), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 8000, log = null } = {}) {
  const stopped = new Set();
  const until = Date.now() + timeoutMs;
  let left = [];
  for (;;) {
    let rows = [];
    try {
      rows = await list();
    } catch (err) {
      log?.warn?.('Could not list the running G9BrowserAgent processes', String(err?.message ?? err));
      return { stopped: [...stopped], left: [] };
    }
    left = pickInstallProcesses(rows, { execPath, selfPid, platform });
    if (!left.length || Date.now() > until) break;
    for (const p of left) {
      try {
        kill(p.pid);
        if (!stopped.has(p.pid)) log?.info?.('Stopped for the update', { pid: p.pid, cmd: String(p.cmd ?? '').slice(0, 200) });
        stopped.add(p.pid);
      } catch (err) {
        if (err?.code !== 'ESRCH') log?.warn?.('Could not stop a process for the update', { pid: p.pid, error: String(err?.message ?? err) });
      }
    }
    await sleep(400);
  }
  return { stopped: [...stopped], left: left.map((p) => p.pid) };
}
