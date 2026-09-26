/**
 * The G9 MCP server over one DaemonLink (moved out of mcp/shim.mjs in 3.2, unchanged): the fifteen
 * tool schemas and the instructions (mcp/tools.js), every call forwarded verbatim, plus the two
 * resources. The stdio shim builds one; the HTTP transport (mcp/http.mjs) builds one per session.
 */

import { McpServer } from './mcp.js';
import { TOOLS, INSTRUCTIONS } from './tools.js';
import { VERSION } from '../lib/version.mjs';

/**
 * @param {import('./link.mjs').DaemonLink} link
 * @param {{ transport?: 'stdio'|'http' }} [o]
 */
export function createMcpServer(link, { transport = 'stdio' } = {}) {
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
        shim: { version: VERSION, pid: process.pid, transport },
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

  return mcp;
}
