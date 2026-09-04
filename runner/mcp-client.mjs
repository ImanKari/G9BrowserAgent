/**
 * A minimal MCP stdio client, for driving the bridge with no agent present.
 *
 * The bridge already speaks MCP, and an agent is just one kind of MCP client.
 * So the runner is another one — the same interface, the same tools, the same
 * safety boundaries. Nothing here reaches into the extension directly, which is
 * what keeps the runner honest: it can only do what an agent could do.
 *
 * Line-delimited JSON-RPC, matching `bridge/src/mcp.js`. Zero dependencies, on
 * purpose: this repo's whole premise is that a tool with this much access does
 * not carry a supply chain.
 */

import { spawn } from 'node:child_process';

export class McpClient {
  /**
   * @param {string} serverPath  absolute path to bridge/src/server.js
   * @param {object} env         extra environment (G9_PORT, G9_TOKEN, …)
   */
  constructor(serverPath, env = {}) {
    this.child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
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
      // The bridge writes diagnostics to stderr — port conflicts, extension
      // connect/disconnect. Kept so a failure can quote the real reason rather
      // than "the tool call failed".
      this.stderr.push(chunk);
      if (this.stderr.length > 200) this.stderr.shift();
    });
    this.child.on('exit', () => {
      this.closed = true;
      for (const [, entry] of this.pending) {
        entry.reject(new Error(`The bridge exited. stderr:\n${this.stderr.join('').slice(-1200)}`));
      }
      this.pending.clear();
    });
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
    if (this.closed) return Promise.reject(new Error('The bridge is no longer running.'));
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
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'g9-runner', version: '1.0.0' },
    }, 20_000);
    this.notify('notifications/initialized');
    return response.result;
  }

  /**
   * Call a tool and return its parsed payload.
   *
   * The bridge returns tool failures as `isError` results rather than JSON-RPC
   * errors, deliberately — the caller needs the message to adapt. The runner
   * turns that into a thrown Error carrying the same text, because at this
   * layer a failed tool call IS the failure.
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
    try { this.child.kill(); } catch { /* already gone */ }
  }
}
