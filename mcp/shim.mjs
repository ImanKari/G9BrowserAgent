#!/usr/bin/env node
/**
 * The G9BrowserAgent MCP shim — what an AI client launches (ARCHITECTURE §10).
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

import { log } from './mcp.js';
import { DaemonLink } from './link.mjs';
import { createMcpServer } from './server.mjs';

// The daemon link (starts the daemon, names a wrong port holder, heals) is mcp/link.mjs and the tool
// wiring is mcp/server.mjs, shared with the HTTP transport (mcp/http.mjs) since 3.2.
const link = new DaemonLink();
const mcp = createMcpServer(link, { transport: 'stdio' });

mcp.on('end', () => {
  link.close();
  setTimeout(() => process.exit(0), 50);
});
process.on('SIGINT', () => { link.close(); process.exit(0); });
process.on('SIGTERM', () => { link.close(); process.exit(0); });

mcp.start();

// Connect (and start the daemon if needed) early, so the first tool call does not pay for it —
// but only once the MCP client has said who it is (initialize), or after 2 s if it never does.
// The hello carries the client's name: connecting at the very first moment registered the agent
// as "mcp-agent" whenever the daemon answered before initialize arrived (a race a slower CI
// machine lost every time), and the panel and the desktop showed that instead of "claude-code".
// server.mjs names the link on initialize before this listener runs (it registered first).
// Failures here are not fatal: each call retries and reports the reason itself.
let preconnected = false;
const preconnect = () => {
  if (preconnected) return;
  preconnected = true;
  link.ensure().catch((err) => log(`[g9] daemon not reachable yet: ${err.message}`));
};
mcp.on('initialize', () => setImmediate(preconnect));
setTimeout(preconnect, 2000).unref();
