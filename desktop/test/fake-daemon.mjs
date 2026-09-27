/**
 * A fake g9d for the desktop's tests: GET /health and a WebSocket at /g9 speaking the handshake,
 * `call`, `admin`, events and ping of DAEMON_PROTOCOL.md. Only on 127.0.0.1 and a test port.
 */

import http from 'node:http';
import { acceptUpgrade } from '../lib/ws.mjs';

export async function startFakeDaemon({
  port,
  version = '2.0.0',
  admin = {},
  call = null,
  welcome = {},
  refuseUpgrade = null,
  health = null,
} = {}) {
  const received = [];
  const peers = new Set();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(health ?? { ok: true, name: 'g9d', version, pid: process.pid, port, home: 'C:/fake/G9BrowserAgent', engines: 0, agents: 0, extension: false }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (refuseUpgrade) {
      socket.write(`HTTP/1.1 ${refuseUpgrade} Refused\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    if (req.headers.origin && /^https?:/i.test(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const peer = acceptUpgrade(req, socket, head);
    peer.headers = req.headers;
    peers.add(peer);
    peer.on('close', () => peers.delete(peer));
    peer.on('message', async (text) => {
      const msg = JSON.parse(text);
      received.push(msg);
      if (msg.type === 'hello') {
        peer.hello = msg;
        peer.send(JSON.stringify({ type: 'welcome', version, daemonPid: process.pid, id: `ui-${received.length}`, repoRoot: 'C:/repo', project: { found: false }, halted: { global: false }, ...welcome }));
        return;
      }
      if (msg.type === 'ping') {
        peer.send(JSON.stringify({ type: 'pong', at: msg.at }));
        return;
      }
      if (msg.type === 'admin') {
        const fn = admin[msg.op];
        if (!fn) {
          peer.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: `unknown admin op ${msg.op}` }));
          return;
        }
        try {
          const result = await fn(msg);
          if (result === '__never__') return; // simulate a hang
          peer.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result }));
        } catch (err) {
          peer.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: err.message }));
        }
        return;
      }
      if (msg.type === 'call') {
        try {
          const result = call ? await call(msg) : { echo: msg.tool, args: msg.args };
          peer.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result }));
        } catch (err) {
          peer.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: err.message }));
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port,
    received,
    peers,
    /** Push a UI event to every connected client. */
    event(topic, data, opts) {
      for (const p of peers) p.send(JSON.stringify({ type: 'event', topic, data }), opts);
    },
    sendRaw(obj, opts) {
      for (const p of peers) p.send(JSON.stringify(obj), opts);
    },
    dropAll() {
      for (const p of peers) p.socket.destroy();
    },
    close() {
      for (const p of peers) p.socket.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}
