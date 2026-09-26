/**
 * The desktop's test convention, matching ARCHITECTURE_V2 §12.1: plain node, node:assert/strict,
 * one "  PASS <name>" line per test, exit non-zero on the first failure. Never the network beyond
 * 127.0.0.1, never a real browser, never port 8765 (test ports are random in 18000-18999).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

export function suite(title) {
  const tests = [];
  const cleanups = [];
  return {
    /** `timeoutMs`: for a test that starts real processes (default 20 s). */
    test(name, fn, { timeoutMs = 20_000 } = {}) {
      tests.push([name, fn, timeoutMs]);
    },
    cleanup(fn) {
      cleanups.push(fn);
    },
    async run() {
      console.log(title);
      let failed = false;
      for (const [name, fn, timeoutMs] of tests) {
        try {
          await withTimeout(fn(), timeoutMs, name);
          console.log(`  PASS ${name}`);
        } catch (err) {
          console.error(`  FAIL ${name}\n${err?.stack ?? err}`);
          failed = true;
          break;
        }
      }
      for (const fn of cleanups.reverse()) {
        try {
          await fn();
        } catch {
          /* best effort */
        }
      }
      process.exit(failed ? 1 : 0);
    },
  };
}

function withTimeout(p, ms, name) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`Test "${name}" timed out after ${ms} ms`)), ms);
    }),
  ]);
}

export function tmpDir(prefix = 'g9-desktop-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** A port in 18000-18999 that is free right now (never 8765). */
export async function freePort() {
  for (let i = 0; i < 50; i++) {
    const port = 18000 + Math.floor(Math.random() * 1000);
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error('No free port in 18000-18999');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() is truthy. */
export async function until(fn, { timeoutMs = 5000, intervalMs = 20, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}
