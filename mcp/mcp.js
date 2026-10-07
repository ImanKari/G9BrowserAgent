/**
 * Minimal MCP server over stdio — no dependencies.
 *
 * Moved from `bridge/src/mcp.js`. MCP is JSON-RPC 2.0 with newline-delimited
 * JSON on stdin/stdout. The subset implemented here is everything a
 * tool-providing server needs:
 *   initialize, notifications/initialized, ping,
 *   tools/list, tools/call, resources/list, resources/read
 *
 * Two rules to preserve (AIGuide §6):
 * - **stdout carries protocol frames ONLY.** Any stray console.log corrupts the
 *   stream and the client disconnects with a parse error. Diagnostics → `log()`
 *   → stderr.
 * - **Tool failures are `isError: true` results, not JSON-RPC errors.** The
 *   agent needs to read the message and adapt; a protocol error looks like a
 *   transport fault and gives it nothing to work with.
 *
 * v2 change: the server remembers the client's `clientInfo` from `initialize`,
 * because the shim forwards `clientInfo.name` to the daemon as the agent's name
 * — "agent-2 (cursor)" in an ownership refusal is the difference between a
 * message someone can act on and one they cannot.
 */

import { EventEmitter } from 'node:events';

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export class McpServer extends EventEmitter {
  /**
   * `compact` (3.4, default on; G9_MCP_COMPACT=0 turns it off): tool results as JSON without
   * indentation, and a result's `tree`/`text` as a plain-text block of its own — see normalizeToolResult.
   */
  constructor({ name, version, instructions, compact = process.env.G9_MCP_COMPACT !== '0' }) {
    super();
    this.name = name;
    this.version = version;
    this.instructions = instructions;
    this.compact = compact !== false;
    this.tools = new Map();
    this.resources = new Map();
    this.initialized = false;
    this.clientInfo = null;
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
   * Read newline-delimited JSON-RPC from stdin and dispatch it. 'end' on stdin
   * means the client went away; the owner decides what that means (the shim
   * exits — it hosts nothing that must outlive its agent; the daemon does).
   */
  start({ input = process.stdin } = {}) {
    let buffer = '';
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.#dispatch(line);
      }
    });
    input.on('end', () => this.emit('end'));
    // A client that closed our stdout has gone away; an EPIPE here must end the
    // process quietly, not as an unhandled 'error' event with a stack trace.
    process.stdout.on('error', (err) => {
      if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') this.emit('end');
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
    const response = await this.handle(msg);
    if (response) this.#write(response);
  }

  /**
   * One JSON-RPC message in, its response out — or null for a notification, which gets none. The
   * transport-independent core: stdio writes the response as a line, the HTTP transport (3.2,
   * mcp/http.mjs) sends it as the body of the POST that carried the request.
   */
  async handle(msg) {
    let out = null;
    const reply = (id, result) => { out = { jsonrpc: '2.0', id, result }; };
    const fail = (id, code, message, data) => { out = { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }; };
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      fail(null, -32600, 'Invalid Request');
      return out;
    }

    // Notifications carry no id and expect no response.
    const { id, method, params = {} } = msg;
    const isNotification = id === undefined || id === null;

    try {
      await this.#route(method, params, id, isNotification, reply, fail);
    } catch (err) {
      if (!isNotification) fail(id, -32603, String(err?.message ?? err));
    }
    return isNotification && !out?.error ? null : out;
  }

  async #route(method, params, id, isNotification, reply, fail) {
    {
      switch (method) {
        case 'initialize': {
          const requested = params.protocolVersion;
          const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
          this.clientInfo = params.clientInfo ?? null;
          this.emit('initialize', this.clientInfo);
          return reply(id, {
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
          return reply(id, {});

        case 'tools/list':
          return reply(id, {
            tools: [...this.tools.values()].map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.annotations ? { annotations: t.annotations } : {}),
            })),
          });

        case 'tools/call': {
          const tool = this.tools.get(params.name);
          if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
          try {
            const output = await tool.handler(params.arguments ?? {});
            return reply(id, normalizeToolResult(output, { compact: this.compact }));
          } catch (err) {
            // Tool failures are results, not protocol errors — the agent needs
            // to read the message and adapt rather than see a transport fault.
            return reply(id, {
              isError: true,
              content: [{ type: 'text', text: String(err?.message ?? err) }],
            });
          }
        }

        case 'resources/list':
          return reply(id, {
            resources: [...this.resources.values()].map((r) => ({
              uri: r.uri,
              name: r.name,
              description: r.description,
              mimeType: r.mimeType ?? 'text/markdown',
            })),
          });

        case 'resources/read': {
          const resource = this.resources.get(params.uri);
          if (!resource) return fail(id, -32602, `Unknown resource: ${params.uri}`);
          const text = await resource.reader();
          return reply(id, {
            contents: [{ uri: resource.uri, mimeType: resource.mimeType ?? 'text/markdown', text }],
          });
        }

        default:
          if (isNotification) return;
          return fail(id, -32601, `Method not found: ${method}`);
      }
    }
  }
}

/** Image types an MCP image block can carry. */
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * The image type of a result that carries `dataBase64`, or null when it is not
 * an image. A screenshot says `format`; an issue attachment says `mime`. A
 * PDF or a CSV attachment must reach the agent as data it can decode — sent as
 * an image block it became a broken picture labelled image/jpeg.
 */
export function imageMimeOf(output) {
  const declared = String(output.mime ?? output.mimeType ?? '').toLowerCase();
  if (declared) return IMAGE_MIMES.has(declared) ? declared : null;
  const format = String(output.format ?? '').toLowerCase();
  if (format === 'png') return 'image/png';
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return null;
}

/** Top-level string fields that read better as text of their own than escaped inside JSON (3.4). */
const TEXT_FIELDS = ['tree', 'text'];

/**
 * Split a result into its JSON part and its long text fields. A snapshot's `tree` inside JSON is one
 * string full of `\n` and `\"` — longer, and harder to read, than the same lines as plain text.
 */
function liftText(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return { rest: output, texts: [] };
  const rest = { ...output };
  const texts = [];
  for (const key of TEXT_FIELDS) {
    const value = rest[key];
    if (typeof value === 'string' && (value.includes('\n') || value.length > 120)) {
      delete rest[key];
      texts.push({ key, value });
    }
  }
  return { rest, texts };
}

/**
 * Accept either a rich content array or a plain object, and always produce a
 * valid MCP tool result. Images become image content blocks so multimodal
 * models actually see them rather than receiving a base64 wall of text.
 *
 * (3.4) `compact` (the default): JSON without indentation (a third fewer characters on a typical
 * result), and long `tree`/`text` fields as plain-text blocks after the JSON, each introduced by its
 * name (`tree:`). `compact:false` is the pre-3.4 shape: indented JSON with everything inside it.
 */
export function normalizeToolResult(output, { compact = true } = {}) {
  if (output && Array.isArray(output.content)) return output;
  const json = (value) => (compact ? JSON.stringify(value ?? null) : JSON.stringify(value ?? null, null, 2));

  if (output && typeof output === 'object' && output.dataBase64) {
    const mimeType = imageMimeOf(output);
    if (mimeType) {
      const { dataBase64, ...rest } = output;
      return {
        content: [
          { type: 'text', text: json(rest) },
          { type: 'image', data: dataBase64, mimeType },
        ],
      };
    }
  }

  if (typeof output === 'string') return { content: [{ type: 'text', text: output }] };
  if (!compact) return { content: [{ type: 'text', text: json(output) }] };
  const { rest, texts } = liftText(output);
  return {
    content: [
      { type: 'text', text: json(rest) },
      ...texts.map(({ key, value }) => ({ type: 'text', text: `${key}:\n${value}` })),
    ],
  };
}

/** Diagnostics must never touch stdout. */
export function log(...args) {
  process.stderr.write(`${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
}

/**
 * (3.4) The inverse of a compact normalizeToolResult, for MCP clients of G9BrowserAgent's own (the runner,
 * the test harnesses): the first text block's JSON with every lifted `tree:`/`text:` block put back
 * under its name. A first block that is not JSON is returned as the string itself.
 */
export function resultFromContent(content = []) {
  const texts = (content ?? []).filter((c) => c?.type === 'text').map((c) => String(c.text ?? ''));
  if (!texts.length) return null;
  let value;
  try {
    value = JSON.parse(texts[0]);
  } catch {
    return texts.join('\n');
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const block of texts.slice(1)) {
      const m = /^(tree|text):\n([\s\S]*)$/.exec(block);
      if (m && !(m[1] in value)) value[m[1]] = m[2];
    }
  }
  return value;
}
