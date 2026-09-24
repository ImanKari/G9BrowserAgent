#!/usr/bin/env node
/**
 * The G9 MCP shim — what an AI client launches (ARCHITECTURE §10).
 *
 *   agent ──stdio MCP──▶ shim ──WS /g9──▶ g9d (one per machine) ──▶ engines
 *
 * One shim per agent process; the daemon outlives them all. The shim is
 * deliberately thin: it serves the tool schemas and instructions (mcp/tools.js),
 * forwards every tool call verbatim, and adds exactly one thing — `caller.name`
 * from the MCP clientInfo — so an ownership refusal can say "owned by agent-2
 * (cursor)" instead of an anonymous id.
 *
 * What it does on its own, and why:
 * - **Starts the daemon.** A refused connection means nobody is listening, so
 *   the shim spawns `daemon/g9d.mjs` detached and hidden (same G9_PORT/G9_HOME)
 *   and retries for 8 s. Nobody has to remember to start a service.
 * - **Names a wrong port holder.** If the port answers but is not g9d — in
 *   practice a still-running v1 bridge — every tool fails with a message naming
 *   the holder's pid and the fix, instead of a generic connection error. MCP
 *   itself keeps working (initialize, tools/list), because a client that sees a
 *   dead server reports only "Connection closed" (the lesson of v1.0.2/1.0.7).
 * - **Heals.** A dropped daemon connection fails the calls in flight with the
 *   reason; the next call reconnects (and restarts the daemon if needed).
 *
 * stdout is the MCP stream: every diagnostic goes to stderr.
 */

import path from 'node:path';
import { spawn } from 'node:child_process';

import { McpServer, log } from './mcp.js';
import { TOOLS, INSTRUCTIONS } from './tools.js';
import { VERSION, REPO_ROOT } from '../lib/version.mjs';
import { WsClient } from '../lib/ws-client.mjs';
import { timeoutFor } from '../daemon/router.js';
import { resolveHome } from '../daemon/paths.js';
import { runningDaemonFor } from '../daemon/home-lock.js';

const HOST = process.env.G9_HOST || '127.0.0.1';
const PORT = (() => {
  const n = Number(process.env.G9_PORT);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : 8765;
})();
const DAEMON = path.join(REPO_ROOT, 'daemon', 'g9d.mjs');
const START_WINDOW_MS = 8_000;
const BASE_TIMEOUT_MS = Number(process.env.G9_TIMEOUT_MS) > 0 ? Number(process.env.G9_TIMEOUT_MS) : 120_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Who is on the port, when it is not a daemon that accepts us. The v1 bridge
 * refuses origin-less WebSocket upgrades with 403 and answers /health with
 * `{ok:true, version:"1.x", pid}` — no `name:"g9d"` — which is how it is told
 * apart from an unrelated program.
 */
async function describePortHolder(err) {
  let body = null;
  try {
    const res = await fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(1_500) });
    body = await res.json();
  } catch {
    body = null;
  }
  if (body?.name === 'g9d') {
    return `The G9 daemon on port ${PORT} (pid ${body.pid}, v${body.version}) refused this connection: ${err.message}.`;
  }
  if (body?.ok === true) {
    return (
      `Port ${PORT} is held by a G9 v1 bridge (pid ${body.pid ?? '?'}, v${body.version ?? '?'}), not the v2 daemon, so no browser ` +
      'tool can work. Close the editor or MCP client that started that bridge (or end node process ' +
      `${body.pid ?? '?'}), then restart this MCP client — the v2 shim starts the daemon by itself. ` +
      'Also reload the G9 extension so it is v2.'
    );
  }
  return (
    `Port ${PORT} is in use by another program (${err.message}), so the G9 daemon cannot run there. ` +
    'Free the port, or set G9_PORT in this MCP config to another port (and the same port as the daemon address in the extension panel).'
  );
}

class DaemonLink {
  constructor() {
    this.ws = null;
    this.welcome = null;
    this.connecting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.name = 'mcp-agent';
  }

  get connected() {
    return !!this.ws?.open && !!this.welcome;
  }

  ensure() {
    if (this.connected) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.#connect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  async #connect() {
    const deadline = Date.now() + START_WINDOW_MS;
    let spawned = false;
    let lastError = null;
    for (;;) {
      let ws;
      try {
        ws = await WsClient.connect(`ws://${HOST}:${PORT}/g9`, { timeoutMs: 3_000 });
      } catch (err) {
        lastError = err;
        if (err.code === 'ECONNREFUSED') {
          if (!spawned) {
            // One daemon per G9_HOME: when this home's daemon runs on ANOTHER port (this config
            // lacks G9_PORT, or names another), a second one here would run every schedule again
            // and fight over the settings — and it now refuses to start (daemon/home-lock.js).
            await this.#refuseOtherPort();
            this.#spawnDaemon();
            spawned = true;
          }
        } else if (err.status != null) {
          throw new Error(await describePortHolder(err));
        }
        if (Date.now() > deadline) break;
        await sleep(200);
        continue;
      }
      await this.#handshake(ws);
      return;
    }
    if (lastError?.code === 'ECONNREFUSED') {
      await this.#refuseOtherPort();
      throw new Error(
        `The G9 daemon did not start on port ${PORT} within ${START_WINDOW_MS / 1000}s. See logs/daemon.log in the G9 data ` +
          `folder, or start it by hand to watch it: node "${DAEMON}" --foreground`,
      );
    }
    throw new Error(await describePortHolder(lastError ?? new Error('no answer')));
  }

  /** Throw the fix when this G9_HOME's daemon is already running on another port. */
  async #refuseOtherPort() {
    const home = resolveHome(process.env.G9_HOME);
    const other = await runningDaemonFor(home).catch(() => null);
    if (other && other.port !== PORT) {
      throw new Error(
        `A G9 daemon for this G9 data folder (${home}) already runs on port ${other.port} (pid ${other.pid}), but this MCP ` +
          `client is set to port ${PORT}. One daemon serves one data folder, so none is started here: set G9_PORT=${other.port} ` +
          'in this MCP config (and use the same daemon address in the extension panel), then restart this MCP client.',
      );
    }
  }

  #spawnDaemon() {
    try {
      const child = spawn(process.execPath, [DAEMON], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: process.cwd(),
        env: { ...process.env, G9_PORT: String(PORT) },
      });
      child.on('error', (err) => log(`[g9] could not start the daemon: ${err.message}`));
      child.unref();
      log(`[g9] no daemon on port ${PORT}; started g9d (pid ${child.pid})`);
    } catch (err) {
      log(`[g9] could not start the daemon: ${err.message}`);
    }
  }

  #handshake(ws) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close(1000, 'no welcome');
        reject(new Error(`The G9 daemon on port ${PORT} accepted the connection but never answered hello.`));
      }, 5_000);
      const onFirst = (msg) => {
        if (msg.type !== 'welcome') return;
        clearTimeout(timer);
        ws.removeListener('message', onFirst);
        if (msg.problem) {
          ws.close(1000, 'problem');
          reject(new Error(msg.problem));
          return;
        }
        this.ws = ws;
        this.welcome = msg;
        ws.on('message', (m) => this.#onMessage(m));
        ws.on('close', (info) => this.#onClose(ws, info));
        resolve();
      };
      ws.on('message', onFirst);
      ws.on('close', () => {
        clearTimeout(timer);
        reject(new Error('The G9 daemon closed the connection during the handshake.'));
      });
      ws.on('error', () => {});
      ws.send({
        type: 'hello',
        role: 'agent',
        version: VERSION,
        client: { name: this.name, pid: process.pid, cwd: process.cwd(), project: process.env.G9_PROJECT || null },
      });
    });
  }

  #onMessage(msg) {
    if (msg.type !== 'result') return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else {
      const error = new Error(String(msg.error ?? 'The daemon reported an error with no message.'));
      // An input error's delivery state (DAEMON_PROTOCOL §3); its text already carries the tag.
      if (typeof msg.delivery === 'string') Object.assign(error, { delivery: msg.delivery, hit: msg.hit ?? null, hidden: msg.hidden === true });
      entry.reject(error);
    }
  }

  #onClose(ws, info) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.welcome = null;
    const reason = info?.reason ? ` (${info.reason})` : '';
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`The connection to the G9 daemon closed mid-call${reason}. Retry the call — the daemon restarts on demand.`));
      this.pending.delete(id);
    }
  }

  async call(tool, args) {
    await this.ensure();
    const ms = timeoutFor(tool, args ?? {}, BASE_TIMEOUT_MS) + 30_000;
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The G9 daemon did not answer "${tool}" within ${Math.round(ms / 1000)}s.`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      // The socket can close between ensure() and here (the daemon restarted);
      // then ws is null, and that must read as a dropped link, not a TypeError.
      const sent = !!this.ws && this.ws.send({ type: 'call', id, tool, args: args ?? {}, caller: { name: this.name } });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('The connection to the G9 daemon dropped. Retry the call.'));
      }
    });
  }

  close() {
    try { this.ws?.close(1000, 'shim exiting'); } catch { /* already closed */ }
  }
}

const link = new DaemonLink();

const mcp = new McpServer({ name: 'g9-browser-agent', version: VERSION, instructions: INSTRUCTIONS });

mcp.on('initialize', (clientInfo) => {
  if (clientInfo?.name) link.name = String(clientInfo.name).slice(0, 80);
});

for (const definition of TOOLS) {
  const { name, ...rest } = definition;
  mcp.tool(name, rest, async (args) => {
    const result = await link.call(name, args);
    if (name !== 'browser_status' || !result || typeof result !== 'object' || Array.isArray(result)) return result;
    // The shim serves the schemas and the daemon serves the behaviour; when
    // they are different versions the agent is working from a tool list that
    // does not match what runs. Say so where the agent orients itself.
    const daemonVersion = link.welcome?.version ?? null;
    return {
      ...result,
      shim: { version: VERSION, pid: process.pid },
      ...(daemonVersion && daemonVersion !== VERSION
        ? {
            shimVersionMismatch:
              `This MCP shim is v${VERSION} but the daemon is v${daemonVersion}. Tool schemas come from the shim and ` +
              'behaviour from the daemon, so they disagree. Stop the old daemon (the desktop app, or end its process) ' +
              'and restart this MCP client.',
          }
        : {}),
    };
  });
}

mcp.resource(
  'g9://guide',
  {
    name: 'G9 Browser Agent guide',
    description: 'How to drive the browsers: two engines, perception, refs, ownership, halts, handoff, regression memory.',
    mimeType: 'text/markdown',
  },
  () => INSTRUCTIONS,
);

mcp.resource(
  'g9://status',
  {
    name: 'Live G9 status',
    description: 'The daemon, engines, agents, and your current tab as JSON (browser_status).',
    mimeType: 'application/json',
  },
  async () => {
    try {
      return JSON.stringify(await link.call('browser_status', {}), null, 2);
    } catch (err) {
      return JSON.stringify({ connected: false, problem: String(err?.message ?? err) }, null, 2);
    }
  },
);

mcp.on('end', () => {
  link.close();
  setTimeout(() => process.exit(0), 50);
});
process.on('SIGINT', () => { link.close(); process.exit(0); });
process.on('SIGTERM', () => { link.close(); process.exit(0); });

mcp.start();

// Connect (and start the daemon if needed) right away, so the first tool call
// does not pay for it. Failures here are not fatal: each call retries and
// reports the reason itself.
link.ensure().catch((err) => log(`[g9] daemon not reachable yet: ${err.message}`));
