/**
 * A minimal MCP stdio client, for driving G9BrowserAgent with no agent present.
 *
 * The runner is just another MCP client: it spawns `mcp/shim.mjs` — the same
 * shim an AI agent's client launches — and the shim connects to the one daemon
 * on this machine (starting it if needed). Same interface, same tools, same
 * rules: ownership, the Stop button and every refusal apply to a scheduled run
 * exactly as to an agent. Nothing here reaches into an engine directly, which
 * is what keeps the runner honest: it can only do what an agent could do.
 *
 * v2: the v1 "port rule" is gone. There is one daemon per machine and any
 * number of clients; `G9_PORT` only says which port that daemon is on.
 *
 * Line-delimited JSON-RPC, matching mcp/mcp.js. Zero dependencies.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../lib/version.mjs';

export const SHIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'shim.mjs');

export class McpClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.shimPath]  defaults to mcp/shim.mjs of this checkout
   * @param {object} [opts.env]       extra environment (G9_PORT, G9_HOME, …)
   * @param {string} [opts.name]      clientInfo.name — how the daemon names this agent
   */
  constructor({ shimPath = SHIM, env = {}, name = 'g9-runner' } = {}) {
    this.name = name;
    this.child = spawn(process.execPath, [shimPath], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.stderr = [];
    this.closed = false;

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#ingest(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      // The shim writes diagnostics to stderr (daemon start, port holder).
      // Kept so a failure can quote the real reason rather than "the call failed".
      this.stderr.push(chunk);
      if (this.stderr.length > 200) this.stderr.shift();
    });
    this.child.on('exit', () => {
      this.closed = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`The G9BrowserAgent MCP shim exited. stderr:\n${this.stderr.join('').slice(-1200)}`));
      }
      this.pending.clear();
    });
    this.child.stdin.on('error', () => {}); // a shim that died leaves an EPIPE; the exit handler reports it
  }

  #ingest(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // stdout carries protocol frames only; anything else is noise
      }
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    }
  }

  request(method, params = {}, timeoutMs = 180_000) {
    if (this.closed) return Promise.reject(new Error('The G9BrowserAgent MCP shim is no longer running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: this.name, version: VERSION },
    }, 20_000);
    this.notify('notifications/initialized');
    return response.result;
  }

  /**
   * Call a tool and return its parsed payload.
   *
   * Tool failures come back as `isError` results rather than JSON-RPC errors,
   * deliberately — the caller needs the message to adapt. At this layer a failed
   * tool call IS the failure, so it becomes a thrown Error carrying that text.
   */
  async call(name, args = {}, timeoutMs = 180_000) {
    const response = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (response.error) throw new Error(`${name}: ${response.error.message ?? 'protocol error'}`);
    const result = response.result ?? {};
    const text = (result.content ?? [])
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    if (result.isError) throw new Error(`${name}: ${text || 'tool reported an error with no message'}`);
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  close() {
    try { this.child.stdin.end(); } catch { /* already gone */ }
    // Give the shim a moment to close its daemon socket cleanly (so the daemon
    // releases this run's claims at once), then make sure it is gone.
    setTimeout(() => { try { this.child.kill(); } catch { /* already gone */ } }, 300).unref?.();
  }
}
