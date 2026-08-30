#!/usr/bin/env node
/**
 * G9 Browser Agent — bridge.
 *
 * Sits between an MCP client (the agent) and the browser extension:
 *
 *   agent  --stdio/JSON-RPC-->  bridge  --WebSocket-->  extension  --CDP-->  tab
 *
 * The bridge is deliberately dumb. It owns no browser logic: it validates
 * nothing about the page, holds no element state, and makes no decisions. All
 * of that lives in the extension, which is the only side that can actually see
 * the browser. This keeps the trust boundary small and the failure modes
 * obvious — if something is wrong with a click, it is wrong in the extension.
 *
 * Usage:
 *   node bridge/src/server.js            # started by the MCP client, usually
 *   G9_PORT=9000 node bridge/src/server.js
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer, log } from './mcp.js';
import { WsServer } from './ws-server.js';
import { TOOLS, INSTRUCTIONS } from './tools.js';

/**
 * The bridge is the only component that knows where the repo lives on disk, so
 * it tells the extension. Without this the side panel can only show a
 * placeholder path, and a user who copies it gets a config that cannot start.
 */
const SERVER_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SERVER_PATH), '..', '..');

const HOST = process.env.G9_HOST ?? '127.0.0.1';
const PORT = Number(process.env.G9_PORT ?? 8765);
const TOKEN = process.env.G9_TOKEN ?? '';
const CALL_TIMEOUT_MS = Number(process.env.G9_TIMEOUT_MS ?? 60_000);

const VERSION = '1.0.0';

// ---------------------------------------------------------------- transport

const ws = new WsServer({ host: HOST, port: PORT, token: TOKEN });

/** In-flight tool calls, keyed by request id. */
const pending = new Map();
let nextId = 1;

ws.on('connect', ({ origin }) => log(`[g9] extension connected (${origin})`));

ws.on('rejected', ({ origin, reason }) =>
  log(`[g9] refused a connection from "${origin}" — ${reason}. Only browser extensions may connect.`),
);

ws.on('disconnect', () => {
  log('[g9] extension disconnected');
  // Fail fast rather than letting the agent sit on a dead promise.
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error('The browser extension disconnected mid-call. Check that the browser is still open.'));
    pending.delete(id);
  }
});

ws.on('message', (msg) => {
  if (msg.type === 'result') {
    const entry = pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error));
    return;
  }

  if (msg.type === 'hello') {
    log(`[g9] extension v${msg.version} ready`);
    // Hand the extension the real on-disk path so the side panel can show a
    // copy-pasteable MCP config instead of a placeholder.
    ws.send({
      type: 'welcome',
      serverPath: SERVER_PATH.replace(/\\/g, '/'),
      repoRoot: REPO_ROOT.replace(/\\/g, '/'),
      host: HOST,
      port: PORT,
      version: VERSION,
    });
  }
});

/** Send a tool call to the extension and await its result. */
function call(tool, args) {
  return new Promise((resolve, reject) => {
    if (!ws.connected) {
      return reject(
        new Error(
          'The G9 browser extension is not connected. Ask the user to: (1) open Chrome or Edge, ' +
            '(2) confirm the G9 extension is installed and enabled, (3) click the G9 toolbar icon ' +
            'and press "Attach & Pin current tab".',
        ),
      );
    }

    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(
          `"${tool}" did not respond within ${CALL_TIMEOUT_MS / 1000}s. The page may be blocked by a ` +
            `JavaScript dialog (try browser_dialog) or stuck loading.`,
        ),
      );
    }, CALL_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });
    ws.send({ type: 'call', id, tool, args });
  });
}

// --------------------------------------------------------------------- MCP

const mcp = new McpServer({
  name: 'g9-browser-agent',
  version: VERSION,
  instructions: INSTRUCTIONS,
});

for (const definition of TOOLS) {
  const { name, ...rest } = definition;
  mcp.tool(name, rest, (args) => call(name, args));
}

// A readable capability guide the agent can pull on demand, and that a human
// can `resources/read` when wiring up a new client.
mcp.resource(
  'g9://guide',
  {
    name: 'G9 Browser Agent guide',
    description: 'How to drive the live browser: perception model, refs, safety boundaries.',
    mimeType: 'text/markdown',
  },
  () => INSTRUCTIONS,
);

mcp.resource(
  'g9://status',
  {
    name: 'Live browser status',
    description: 'Current bridge, mode, attached tab, and page health as JSON.',
    mimeType: 'application/json',
  },
  async () => {
    if (!ws.connected) {
      return JSON.stringify({ connected: false, hint: 'The browser extension is not connected.' }, null, 2);
    }
    return JSON.stringify(await call('browser_status', {}), null, 2);
  },
);

// ------------------------------------------------------------------ startup

try {
  await ws.listen();
  log(`[g9] bridge listening on ws://${HOST}:${PORT}`);
  log(`[g9] waiting for the browser extension to connect…`);
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    log(
      `[g9] FATAL: port ${PORT} is already in use. Another bridge is probably running. ` +
        `Stop it, or set G9_PORT to a different port in both the MCP config and the extension side panel.`,
    );
  } else {
    log(`[g9] FATAL: ${err.message}`);
  }
  process.exit(1);
}

// --standalone forces the bridge to stay up even if an MCP client attaches and
// then detaches. Without the flag it is auto-detected (see McpServer.start).
mcp.start({ standalone: process.argv.includes('--standalone') });

const shutdown = async () => {
  await ws.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
