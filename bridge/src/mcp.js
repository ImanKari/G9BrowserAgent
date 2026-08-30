/**
 * Minimal MCP server over stdio — no dependencies.
 *
 * MCP is JSON-RPC 2.0 with newline-delimited JSON on stdin/stdout. The subset
 * implemented here is everything a tool-providing server needs:
 *   initialize, notifications/initialized, ping,
 *   tools/list, tools/call, resources/list, resources/read
 *
 * Critical stdio rule: stdout carries protocol frames ONLY. Anything logged to
 * stdout corrupts the stream and the client disconnects with a parse error.
 * All diagnostics go to stderr.
 */

import { EventEmitter } from 'node:events';

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export class McpServer extends EventEmitter {
  constructor({ name, version, instructions }) {
    super();
    this.name = name;
    this.version = version;
    this.instructions = instructions;
    this.tools = new Map();
    this.resources = new Map();
    this.initialized = false;
  }

  tool(name, definition, handler) {
    this.tools.set(name, { name, ...definition, handler });
    return this;
  }

  resource(uri, definition, reader) {
    this.resources.set(uri, { uri, ...definition, reader });
    return this;
  }

  /**
   * Read newline-delimited JSON-RPC from stdin and dispatch it.
   *
   * stdin handling is subtler than it looks. An MCP client launches this
   * process and holds stdin open for the session, so 'end' genuinely means
   * "the client went away" and exiting is right. But when a human runs the
   * bridge directly — `node bridge/src/server.js`, or with output redirected —
   * stdin has no writer and 'end' fires immediately, which would kill the
   * process a few milliseconds after it bound the port.
   *
   * So: exit on 'end' only if we ever saw MCP traffic. Otherwise stay up in
   * standalone mode, which is exactly what you want when debugging the
   * extension without an MCP client attached.
   */
  start({ standalone = false } = {}) {
    let buffer = '';
    this.sawTraffic = false;

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          this.sawTraffic = true;
          this.#dispatch(line);
        }
      }
    });

    process.stdin.on('end', () => {
      if (standalone || !this.sawTraffic) {
        log('[g9] No MCP client on stdin — running in STANDALONE mode.');
        log('[g9] The WebSocket bridge stays up, so the extension can connect and');
        log('[g9] you can watch it attach. Agent tool calls need a real MCP client.');
        log('[g9] Ctrl+C to stop.');
        this.emit('standalone');
        return;
      }
      process.exit(0);
    });

    return this;
  }

  #write(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  #reply(id, result) {
    this.#write({ jsonrpc: '2.0', id, result });
  }

  #fail(id, code, message, data) {
    this.#write({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
  }

  async #dispatch(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return this.#fail(null, -32700, 'Parse error');
    }

    // Notifications carry no id and expect no response.
    const { id, method, params = {} } = msg;
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case 'initialize': {
          const requested = params.protocolVersion;
          const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOLS[0];
          return this.#reply(id, {
            protocolVersion,
            capabilities: {
              tools: { listChanged: false },
              resources: { listChanged: false, subscribe: false },
            },
            serverInfo: { name: this.name, version: this.version },
            instructions: this.instructions,
          });
        }

        case 'notifications/initialized':
          this.initialized = true;
          this.emit('initialized');
          return;

        case 'ping':
          return this.#reply(id, {});

        case 'tools/list':
          return this.#reply(id, {
            tools: [...this.tools.values()].map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.annotations ? { annotations: t.annotations } : {}),
            })),
          });

        case 'tools/call': {
          const tool = this.tools.get(params.name);
          if (!tool) return this.#fail(id, -32602, `Unknown tool: ${params.name}`);
          try {
            const output = await tool.handler(params.arguments ?? {});
            return this.#reply(id, normalizeToolResult(output));
          } catch (err) {
            // Tool failures are results, not protocol errors — the agent needs
            // to read the message and adapt rather than see a transport fault.
            return this.#reply(id, {
              isError: true,
              content: [{ type: 'text', text: String(err?.message ?? err) }],
            });
          }
        }

        case 'resources/list':
          return this.#reply(id, {
            resources: [...this.resources.values()].map((r) => ({
              uri: r.uri,
              name: r.name,
              description: r.description,
              mimeType: r.mimeType ?? 'text/markdown',
            })),
          });

        case 'resources/read': {
          const resource = this.resources.get(params.uri);
          if (!resource) return this.#fail(id, -32602, `Unknown resource: ${params.uri}`);
          const text = await resource.reader();
          return this.#reply(id, {
            contents: [{ uri: resource.uri, mimeType: resource.mimeType ?? 'text/markdown', text }],
          });
        }

        default:
          if (isNotification) return;
          return this.#fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      if (!isNotification) this.#fail(id, -32603, String(err?.message ?? err));
    }
  }
}

/**
 * Accept either a rich content array or a plain object, and always produce a
 * valid MCP tool result. Images become image content blocks so multimodal
 * models actually see them rather than receiving a base64 wall of text.
 */
function normalizeToolResult(output) {
  if (output && Array.isArray(output.content)) return output;

  if (output && typeof output === 'object' && output.dataBase64) {
    const { dataBase64, format, ...rest } = output;
    return {
      content: [
        { type: 'text', text: JSON.stringify(rest, null, 2) },
        { type: 'image', data: dataBase64, mimeType: format === 'png' ? 'image/png' : 'image/jpeg' },
      ],
    };
  }

  const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  return { content: [{ type: 'text', text }] };
}

/** Diagnostics must never touch stdout. */
export function log(...args) {
  process.stderr.write(`${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
}
