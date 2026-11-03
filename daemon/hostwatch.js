/**
 * (3.8.7) Host watch: the memory of the local servers the agents are testing, and of this daemon.
 *
 * Why (field report, 2026-11-03): after one to five hours of agent work the owner's workstation
 * slowed down and applications crashed; Task Manager showed a "Node.js JavaScript Runtime" at 7 to
 * 20 GB, and Windows' low-memory diagnosis named node.exe at 51–109 GB of commit on four days. It was
 * not G9BrowserAgent: it was a Vite dev server an agent had started for the project under test. A
 * `vite build` had rewritten the build folder that dev server watched, and from then on Windows
 * reported ~2,000 rename events a second for that folder (the event's file name was the folder's own
 * `\\?\` path, so the watcher never settled); the server grew ~6 GB an hour with no client connected.
 *
 * The daemon cannot fix another program, but it knows which local servers its agents use: every
 * `http(s)://localhost|127.x|[::1]:port` an agent opens or lands on. Every two minutes (only while such
 * a port is known) it finds the process listening on that port and reads its memory — netstat +
 * tasklist on Windows, ss + /proc on Linux, lsof + ps on macOS; no PowerShell, nothing installed — and
 * its own. A process over `settings.hostWatch.limitMb`, or growing faster than `growthMbPerHour` over at
 * least ten minutes, becomes a warning: logged once, in browser_status (`hostWarnings`), and attached
 * once to the next result of every agent (`hostWarning`). Nothing is stopped: the agent or the person
 * decides. Both thresholds 0 turn the watch off.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';

const MB = 1024 * 1024;
const INTERVAL_MS = 120_000;
/** A growth rate is judged over at least this long, from samples at most WINDOW_MS old. */
const MIN_SPAN_MS = 10 * 60_000;
const WINDOW_MS = 30 * 60_000;
/** A process smaller than this is never "growing too fast": a dev server warming up is not a leak. */
const GROWTH_FLOOR_MB = 1024;
/** A port nobody opened again for this long is forgotten. */
const FORGET_MS = 6 * 60 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

/** The port of a loopback http(s) URL, or null. */
export function loopbackPort(url) {
  if (typeof url !== 'string' || !/^https?:/i.test(url)) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!LOOPBACK.test(u.hostname)) return null;
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/** MB per hour between the oldest sample of the window and the newest, or null when the span is too short. */
export function growthPerHour(samples, now) {
  const recent = samples.filter((s) => now - s.at <= WINDOW_MS);
  if (recent.length < 2) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const span = last.at - first.at;
  if (span < MIN_SPAN_MS) return null;
  return ((last.mb - first.mb) / span) * 3_600_000;
}

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * MB }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });

const portOf = (address) => {
  const m = /[:.](\d+)$/.exec(String(address).trim());
  return m ? Number(m[1]) : null;
};

/** Windows: `netstat -ano` listening sockets (foreign address *:0, so no localized state word) → pid. */
export function parseNetstat(text, ports) {
  const out = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'TCP' || cols.length < 5) continue;
    if (!/^(0\.0\.0\.0|\[::\]):0$/.test(cols[2])) continue;
    const port = portOf(cols[1]);
    const pid = Number(cols[cols.length - 1]);
    if (ports.has(port) && Number.isInteger(pid) && pid > 0 && !out.has(port)) out.set(port, pid);
  }
  return out;
}

/** Windows: `tasklist /FO CSV /NH` → pid → { name, mb } (working set; the digits of "1,706,123 K" in any locale). */
export function parseTasklist(text) {
  const out = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cols = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (cols.length < 5) continue;
    const pid = Number(cols[1]);
    const kb = Number(cols[cols.length - 1].replace(/\D/g, ''));
    if (Number.isInteger(pid) && Number.isFinite(kb)) out.set(pid, { name: cols[0], mb: Math.round(kb / 1024) });
  }
  return out;
}

/** Linux: `ss -ltnpH` → port → { pid, name }. */
export function parseSs(text, ports) {
  const out = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const port = portOf(cols[3]);
    const m = /\("([^"]+)",pid=(\d+)/.exec(line);
    if (m && ports.has(port) && !out.has(port)) out.set(port, { pid: Number(m[2]), name: m[1] });
  }
  return out;
}

/** macOS: `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` → port → { pid, name }. */
export function parseLsof(text, ports) {
  const out = new Map();
  let pid = null;
  let name = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c')) name = line.slice(1);
    else if (line.startsWith('n')) {
      const port = portOf(line.slice(1));
      if (ports.has(port) && pid && !out.has(port)) out.set(port, { pid, name });
    }
  }
  return out;
}

/** Port → { pid, name, mb } for the processes listening on `ports`, on this machine. Unknown → absent. */
export async function probeListeners(ports, platform = process.platform) {
  const out = new Map();
  if (!ports.size) return out;
  if (platform === 'win32') {
    const pids = parseNetstat(await run('netstat', ['-ano']), ports);
    if (!pids.size) return out;
    const procs = parseTasklist(await run('tasklist', ['/FO', 'CSV', '/NH']));
    for (const [port, pid] of pids) {
      const p = procs.get(pid);
      if (p) out.set(port, { pid, name: p.name, mb: p.mb });
    }
    return out;
  }
  const found = platform === 'darwin'
    ? parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']), ports)
    : parseSs(await run('ss', ['-ltnpH']), ports);
  for (const [port, { pid, name }] of found) {
    let mb = null;
    if (platform === 'darwin') {
      const kb = Number(String(await run('ps', ['-o', 'rss=', '-p', String(pid)]) ?? '').trim());
      if (Number.isFinite(kb) && kb > 0) mb = Math.round(kb / 1024);
    } else {
      try {
        const m = /VmRSS:\s+(\d+)\s*kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
        if (m) mb = Math.round(Number(m[1]) / 1024);
      } catch { /* gone, or not ours to read */ }
    }
    if (mb != null) out.set(port, { pid, name, mb });
  }
  return out;
}

export class HostWatch {
  /**
   * @param {object} o
   * @param {() => object} o.settings   returns settings.hostWatch ({ limitMb, growthMbPerHour })
   * @param {(...a) => void} [o.log]
   * @param {typeof probeListeners} [o.probe]
   * @param {() => number} [o.selfMb]   this daemon's memory
   * @param {() => number} [o.now]
   */
  constructor({ settings, log = () => {}, probe = probeListeners, selfMb = () => Math.round(process.memoryUsage().rss / MB), now = Date.now, intervalMs = INTERVAL_MS }) {
    this.settingsOf = settings;
    this.log = log;
    this.probe = probe;
    this.selfMb = selfMb;
    this.now = now;
    this.intervalMs = intervalMs;
    this.ports = new Map(); // port → last time an agent used it
    this.tracked = new Map(); // key ('self' | 'port:N') → { pid, name, port, samples, warned }
    this.current = [];
    /** Grows when a warning appears that was not there before; agents are told once per generation. */
    this.generation = 0;
    this.timer = null;
    this.ticking = null;
  }

  #limits() {
    const s = this.settingsOf?.() ?? {};
    return { limitMb: Number(s.limitMb) || 0, growthMbPerHour: Number(s.growthMbPerHour) || 0 };
  }

  get enabled() {
    const { limitMb, growthMbPerHour } = this.#limits();
    return limitMb > 0 || growthMbPerHour > 0;
  }

  /** An agent used this URL: remember its port when it is a local server. */
  note(url) {
    const port = loopbackPort(url);
    if (port != null) this.ports.set(port, this.now());
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch((err) => this.log(`[hostwatch] ${err.message}`)); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** One sample of every watched process; at most one at a time. */
  tick() {
    this.ticking ??= this.#tick().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  async #tick() {
    if (!this.enabled) {
      this.current = [];
      return this.current;
    }
    const now = this.now();
    for (const [port, at] of this.ports) if (now - at > FORGET_MS) this.ports.delete(port);
    const seen = new Map([['self', { pid: process.pid, name: 'the G9BrowserAgent daemon', port: null, mb: this.selfMb() }]]);
    if (this.ports.size) {
      const found = await this.probe(new Set(this.ports.keys()));
      // The daemon's own port is not a server under test.
      for (const [port, p] of found) if (p.pid !== process.pid) seen.set(`port:${port}`, { ...p, port });
    }
    for (const key of [...this.tracked.keys()]) if (!seen.has(key)) this.tracked.delete(key);
    for (const [key, p] of seen) {
      let t = this.tracked.get(key);
      // Another process on the port (the server was restarted): its history starts again.
      if (!t || t.pid !== p.pid) {
        t = { pid: p.pid, name: p.name, port: p.port, samples: [], warned: null };
        this.tracked.set(key, t);
      }
      t.samples.push({ at: now, mb: p.mb });
      t.samples = t.samples.filter((s) => now - s.at <= WINDOW_MS);
    }
    this.current = this.#judge(now);
    return this.current;
  }

  #judge(now) {
    const { limitMb, growthMbPerHour } = this.#limits();
    const out = [];
    for (const t of this.tracked.values()) {
      const mb = t.samples[t.samples.length - 1]?.mb ?? 0;
      const rate = growthPerHour(t.samples, now);
      const over = limitMb > 0 && mb >= limitMb;
      const growing = growthMbPerHour > 0 && rate != null && rate >= growthMbPerHour && mb >= GROWTH_FLOOR_MB;
      if (!over && !growing) {
        t.warned = null;
        continue;
      }
      const level = over ? 'over' : 'growing';
      const who = t.port != null ? `${t.name} (pid ${t.pid}), the server on port ${t.port}` : `${t.name} (pid ${t.pid})`;
      const warning = {
        pid: t.pid,
        name: t.name,
        ...(t.port != null ? { port: t.port } : {}),
        memoryMb: mb,
        ...(rate != null ? { growthMbPerHour: Math.round(rate) } : {}),
        level,
        note:
          `${who} uses ${(mb / 1024).toFixed(1)} GB` +
          (rate != null && rate > 0 ? `, growing ${(rate / 1024).toFixed(1)} GB an hour` : '') +
          '. Left alone it can exhaust this machine\'s memory and make other programs crash. ' +
          (t.port != null
            ? 'A dev server that grows with nobody calling it is usually its file watcher in a loop — on Windows, after a ' +
              'build rewrote a folder it watches (exclude the build output from its watch, e.g. Vite server.watch.ignored). ' +
              'Restart it, and tell the person.'
            : 'Tell the person; restarting the G9BrowserAgent app (or the daemon) releases it.'),
      };
      if (t.warned !== level) {
        t.warned = level;
        this.generation += 1;
        this.log(`[hostwatch] ${warning.note}`);
      }
      out.push(warning);
    }
    return out;
  }

  warnings() {
    return this.current;
  }
}
