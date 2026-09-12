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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { McpServer, log } from './mcp.js';
import { WsServer } from './ws-server.js';
import { TOOLS, INSTRUCTIONS } from './tools.js';
import { loadProject, projectForExtension } from './project.js';
import { FlowLibrary } from './flows.js';
import * as registry from './registry.js';

/**
 * The bridge is the only component that knows where the repo lives on disk, so
 * it tells the extension. Without this the side panel can only show a
 * placeholder path, and a user who copies it gets a config that cannot start.
 */
const SERVER_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SERVER_PATH), '..', '..');

const HOST = process.env.G9_HOST ?? '127.0.0.1';

/**
 * A pinned port is honoured absolutely; an unset one is discovered.
 *
 * If the user wrote `G9_PORT` they also typed that number into the extension's
 * side panel, so a bridge that helpfully moved elsewhere would break the very
 * setup they configured. Without it, taking the next free port is strictly
 * better than failing: two editor windows on two projects is a normal state,
 * not a fault. See registry.js.
 */
const PORT_PINNED = process.env.G9_PORT != null && process.env.G9_PORT !== '';
const PREFERRED_PORT = Number(process.env.G9_PORT ?? registry.PORT_RANGE_START);
const TOKEN = process.env.G9_TOKEN ?? '';
const CALL_TIMEOUT_MS = Number(process.env.G9_TIMEOUT_MS ?? 60_000);

/**
 * The bridge's version, read from package.json so it cannot drift.
 *
 * This was a hand-written string, and it drifted: the constant still said 1.7.4
 * while package.json had moved eight releases past it. Every "VERSION MISMATCH"
 * warning the bridge printed was therefore comparing the extension's real
 * version against a number nobody had updated \u2014 telling people to reload an
 * extension that was already correct, which is the fastest way to teach them to
 * ignore the warning entirely.
 *
 * A version that is announced in two places will be wrong in one of them. Read
 * it, and there is only one place to bump.
 */
const VERSION = readVersion();

function readVersion() {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    // Fall through: a bridge that cannot read its own package.json still works,
    // and saying so is better than refusing to start over a label.
  }
  return '0.0.0-unknown';
}

/**
 * The project adapter, read once at startup.
 *
 * Deliberately not re-read on every call: a flow library path that changes
 * under a running session is a source of confusion, not flexibility. Reconnect
 * to pick up an edit — which is what the panel's "reload project" does.
 */
const PROJECT = loadProject(process.cwd());
const flows = new FlowLibrary(PROJECT.flowsDir);

/** Set once we are actually listening; the discovered port may differ. */
let ACTIVE_PORT = PREFERRED_PORT;

// ---------------------------------------------------------------- transport

const ws = new WsServer({ host: HOST, port: PREFERRED_PORT, token: TOKEN });

/** In-flight tool calls, keyed by request id. */
const pending = new Map();
let nextId = 1;

/**
 * Why the WebSocket listener is not up, in words the agent can relay.
 *
 * Null once we are listening. See the startup block at the bottom for why this
 * exists rather than a `process.exit(1)`.
 */
let startupFailure = null;

ws.on('connect', ({ origin }) => log(`[g9] extension connected (${origin})`));

ws.on('rejected', ({ origin, reason }) =>
  log(`[g9] refused a connection from "${origin}" — ${reason}. Only browser extensions may connect.`),
);

ws.on('protocolError', ({ reason }) =>
  log(`[g9] dropped the extension connection — ${reason}. The bridge itself stays up.`),
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

  // A JavaScript dialog freezes the renderer, so the call that opened it will
  // not return until someone answers the dialog. Failing it now, with the
  // recovery named, replaces a full 60s timeout with an immediate answer. This
  // is transport correlation, not browser logic — the extension decided what
  // happened; the bridge only knows which promise is waiting on it.
  if (msg.type === 'event' && msg.event === 'dialog') {
    const kind = msg.data?.type ?? 'dialog';
    const text = String(msg.data?.message ?? '').slice(0, 200);
    for (const [id, entry] of pending) {
      if (entry.tool === 'browser_dialog') continue; // the call that will fix it
      clearTimeout(entry.timer);
      entry.reject(
        new Error(
          `The page opened a JavaScript ${kind} ("${text}") which blocks it until handled, so this ` +
            `call cannot complete. Call browser_dialog to accept or dismiss it, then retry.`,
        ),
      );
      pending.delete(id);
    }
    return;
  }

  if (msg.type === 'hello') {
    log(`[g9] extension v${msg.version} ready`);

    // Both sides have always exchanged a version and neither has ever compared
    // them. They drift constantly, because the documented workflow drifts them:
    // reloading the extension takes effect immediately, while the bridge only
    // changes when the MCP client is restarted — and the client caches the tool
    // schemas it got at startup. The result is an agent whose tool list does not
    // match the extension behind it: actions the schema forbids, actions the
    // extension no longer implements, and no error anywhere explaining it.
    extensionVersion = msg.version ?? null;
    if (extensionVersion && extensionVersion !== VERSION) {
      log(`[g9] VERSION MISMATCH: bridge v${VERSION}, extension v${extensionVersion}`);
    }

    // Hand the extension the real on-disk path so the side panel can show a
    // copy-pasteable MCP config instead of a placeholder — and the project
    // adapter, which is what Workspace mode's allowlist is built from. The
    // extension has no filesystem, so this handshake is the ONLY way product
    // knowledge reaches it.
    ws.send({
      type: 'welcome',
      serverPath: SERVER_PATH.replace(/\\/g, '/'),
      repoRoot: REPO_ROOT.replace(/\\/g, '/'),
      host: HOST,
      port: ACTIVE_PORT,
      version: VERSION,
      project: projectForExtension(PROJECT),
    });
    return;
  }

  // Flow-library requests travel extension → bridge, the opposite direction to
  // everything else here. The panel needs the filesystem and cannot have it;
  // this is the door. Kept deliberately narrow: five verbs against one rooted
  // directory, no arbitrary paths, no arbitrary reads.
  if (msg.type === 'flowlib') {
    handleFlowLib(msg).then(
      (result) => ws.send({ type: 'flowlibResult', id: msg.id, ok: true, result }),
      (err) => ws.send({ type: 'flowlibResult', id: msg.id, ok: false, error: String(err?.message ?? err) }),
    );
  }
});

/**
 * The flow library's request handler.
 *
 * An unknown op is refused by name rather than ignored. A library that silently
 * does nothing for a verb it does not know reports success for work that never
 * happened — the same failure the whole tool is written against.
 */
async function handleFlowLib(msg) {
  switch (msg.op) {
    case 'list':
      return flows.list();
    case 'read':
      return { spec: await flows.read(msg.id) };
    case 'write':
      return flows.write(msg.spec);
    case 'remove':
      return flows.remove(msg.id);
    case 'status':
      return flows.status(msg.local ?? []);
    case 'suite':
      return flows.resolveSuite(msg.suiteId);
    default:
      throw new Error(
        `Unknown flow-library op "${msg.op}". Known: list, read, write, remove, status, suite.`,
      );
  }
}

/** Version the extension reported on connect, for the skew check below. */
let extensionVersion = null;

/**
 * The skew warning, in the one place the agent cannot miss it.
 *
 * It rides on `browser_status` rather than failing calls, because skew is a
 * degraded state, not a broken one — most tools still work, and refusing them
 * all would be worse than the drift. `browser_status` is the tool the
 * instructions tell the agent to call first, so this is where it will be read.
 */
function versionSkew() {
  if (!extensionVersion || extensionVersion === VERSION) return null;
  return (
    `The bridge is v${VERSION} but the browser extension is v${extensionVersion}. ` +
    `Tool schemas come from the bridge and behaviour comes from the extension, so they now disagree: ` +
    `arguments may be rejected that the extension supports, or accepted that it does not implement. ` +
    `Ask the user to reload the extension (chrome://extensions or edge://extensions) AND restart this ` +
    `MCP client — the client caches tool definitions from bridge startup, so restarting only one side ` +
    `leaves the mismatch in place.`
  );
}

/** Send a tool call to the extension and await its result. */
function call(tool, args) {
  return new Promise((resolve, reject) => {
    if (startupFailure) return reject(new Error(startupFailure));

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

    pending.set(id, { resolve, reject, timer, tool });
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
  mcp.tool(name, rest, async (args) => {
    const result = await call(name, args);
    // Attach the skew warning to browser_status only. Adding it to every result
    // would spend the agent's context repeating itself; browser_status is the
    // orientation tool, and orientation is exactly what skew corrupts.
    if (name !== 'browser_status' || !result || typeof result !== 'object' || Array.isArray(result)) {
      return result;
    }
    const skew = versionSkew();

    // The project adapter rides on browser_status for the same reason the skew
    // warning does: it is the orientation tool, and "which domains am I allowed
    // to touch" is orientation. An agent that learns the allowlist only by
    // being refused wastes a round trip discovering it.
    return {
      ...result,
      ...(skew ? { versionMismatch: skew } : {}),
      bridge: {
        version: VERSION,
        port: ACTIVE_PORT,
        project: PROJECT.found ? PROJECT.path : null,
        workspaceDomains: PROJECT.workspaceDomains,
        flowLibrary: flows.available ? PROJECT.flowsDir : null,
        ...(PROJECT.problems.length ? { projectProblems: PROJECT.problems } : {}),
      },
    };
  });
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
    if (startupFailure) {
      return JSON.stringify({ connected: false, listening: false, problem: startupFailure }, null, 2);
    }
    if (!ws.connected) {
      return JSON.stringify({ connected: false, hint: 'The browser extension is not connected.' }, null, 2);
    }
    return JSON.stringify(await call('browser_status', {}), null, 2);
  },
);

// ------------------------------------------------------------------ startup

/**
 * Turn a bind failure into something the user can act on.
 *
 * EADDRINUSE has two very different causes with two different fixes: another
 * G9 bridge (a second editor window, or a process left behind), or an unrelated
 * program sitting on the port. Probing /health tells them apart, and it is
 * worth the 1.5s because the wrong guess sends the user looking in the wrong
 * place.
 */
async function describeStartupFailure(err) {
  if (err.code !== 'EADDRINUSE') {
    return `The G9 bridge could not start: ${err.message}`;
  }

  let itIsUs = false;
  try {
    const res = await fetch(`http://${HOST}:${ACTIVE_PORT}/health`, { signal: AbortSignal.timeout(1500) });
    itIsUs = res.ok && (await res.json())?.ok === true;
  } catch {
    /* not a G9 bridge, or not speaking HTTP at all */
  }

  const shared =
    `so this bridge has NO connection to the browser extension and no tool will work. `;

  return itIsUs
    ? `Port ${ACTIVE_PORT} is already held by another G9 bridge, ${shared}` +
        `Two bridges cannot share one port. Usually this means a second editor window or MCP ` +
        `client is running, or an earlier bridge was left behind — close it, or stop the stray ` +
        `node process. To run both deliberately, set a different G9_PORT here and the same port ` +
        `in the extension side panel. This bridge retries every 5s, so it recovers on its own ` +
        `once the port is free.`
    : `Port ${ACTIVE_PORT} is in use by another program, ${shared}` +
        `Free the port, or set G9_PORT to something else in both the MCP config and the extension ` +
        `side panel. This bridge retries every 5s.`;
}

/**
 * Bind, or stay up and explain why not.
 *
 * This deliberately does NOT `process.exit(1)` on a bind failure. An MCP client
 * that launched us sees only that the process died and reports "Connection
 * closed"; the real reason, written to stderr, lands in a log file nobody
 * opens. That is the same one-layer-away failure as v1.0.2 and v1.0.4, and it
 * cost a debugging session in v1.0.7.
 *
 * The stdio channel is completely independent of the WebSocket port, so we can
 * still serve MCP, list tools, and answer every call with the actual reason.
 * A visible, accurate error beats a silent exit.
 */
async function listenOrExplain() {
  try {
    // Discovery happens here rather than once at module load, so a retry after
    // a conflict re-scans. The port that was taken thirty seconds ago may be
    // free now, and the one we picked may since have been taken by someone else.
    const picked = await registry.pickPort({
      host: HOST,
      preferred: PREFERRED_PORT,
      pinned: PORT_PINNED,
    });
    ACTIVE_PORT = picked.port;
    ws.port = picked.port;

    await ws.listen();
    if (startupFailure) log(`[g9] port ${ACTIVE_PORT} is free again — bridge listening`);
    startupFailure = null;

    ws.identity = {
      version: VERSION,
      port: ACTIVE_PORT,
      pid: process.pid,
      project: PROJECT.found ? path.basename(PROJECT.root) : null,
      projectPath: PROJECT.path,
      flowsDir: PROJECT.flowsDir,
      cwd: process.cwd().replace(/\\/g, '/'),
    };
    registry.register({ ...ws.identity, serverPath: SERVER_PATH.replace(/\\/g, '/') });

    log(`[g9] bridge listening on ws://${HOST}:${ACTIVE_PORT}`);
    if (picked.scanned && !PORT_PINNED) {
      log(
        `[g9] port ${PREFERRED_PORT} was busy, so this bridge took ${ACTIVE_PORT}. ` +
          `The side panel discovers running bridges automatically — pick this one there.`,
      );
    }
    if (PROJECT.found) {
      log(`[g9] project: ${PROJECT.path} (${PROJECT.workspaceDomains.length} workspace domain(s))`);
    } else {
      log('[g9] no g9.project.json found — Workspace mode will fall back to Pinned.');
    }
    for (const problem of PROJECT.problems) log(`[g9] project warning: ${problem}`);
    log(`[g9] waiting for the browser extension to connect…`);
    return true;
  } catch (err) {
    startupFailure = await describeStartupFailure(err);
    log(`[g9] NOT LISTENING: ${startupFailure}`);
    return false;
  }
}

/**
 * Keep this bridge's registry row warm.
 *
 * Unref'd deliberately: this timer must never be the reason the process stays
 * alive. A bridge whose only remaining job is stamping a file is a bridge that
 * should have exited.
 */
setInterval(() => registry.touch(process.pid, { extensionConnected: ws.connected }), 60_000).unref();

if (!(await listenOrExplain())) {
  // Retry, so closing the other window heals this session without an editor
  // restart. The timer is deliberately NOT unref'd: with no listening socket it
  // is the only thing holding the event loop open, and a bridge that quietly
  // exits is the exact failure this whole block exists to remove.
  const retry = setInterval(async () => {
    if (await listenOrExplain()) clearInterval(retry);
  }, 5_000);
}

// --standalone forces the bridge to stay up even if an MCP client attaches and
// then detaches. Without the flag it is auto-detected (see McpServer.start).
mcp.start({ standalone: process.argv.includes('--standalone') });

const shutdown = async () => {
  registry.unregister(process.pid);
  await ws.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
