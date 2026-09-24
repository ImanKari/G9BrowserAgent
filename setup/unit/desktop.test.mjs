#!/usr/bin/env node
/**
 * The desktop app's own unit tests, run from setup/unittest.mjs (F9).
 *
 * desktop/ is the one package with npm dependencies (Electron, electron-builder,
 * electron-updater), so its tests live beside it in desktop/test and run with
 * `node desktop/test/run.mjs` (= `npm test` there). This file only makes the
 * repository-wide `node setup/unittest.mjs` include them.
 *
 * Two environment rules:
 *
 * - ELECTRON_RUN_AS_NODE is removed from the child's environment. Some hosts
 *   (an AI agent's shell, the packaged G9.exe running a Node script) export it,
 *   and with it set `electron` and the Electron-backed parts of the tests run as
 *   plain Node of another version — measured: `npx electron --version` printed
 *   v24.21.0 (the host's Node) instead of Electron 44.
 * - No desktop/node_modules (nobody ran `npm install` in desktop/): the suite is
 *   SKIPPED with a line saying so and exits 0. The rest of G9 has zero npm
 *   dependencies and must stay testable without them; a skip is reported as a
 *   skip, never as a pass.
 *
 * Output is forwarded as is: desktop/test/harness.mjs prints `  PASS <name>` per
 * test, the convention setup/unittest.mjs counts. No window, no browser, never
 * port 8765 (desktop/test's own rule).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'desktop');
const RUNNER = path.join(DESKTOP, 'test', 'run.mjs');

if (!existsSync(RUNNER)) {
  console.log(`  FAIL desktop tests: ${path.relative(ROOT, RUNNER)} is missing`);
  process.exit(1);
}
if (!existsSync(path.join(DESKTOP, 'node_modules'))) {
  console.log('  SKIP desktop tests — desktop/node_modules is absent (run `npm install` in desktop/ to include them)');
  process.exit(0);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [RUNNER], { cwd: DESKTOP, env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
child.on('exit', (code, signal) => {
  if (code !== 0) console.log(`  FAIL desktop tests: node desktop/test/run.mjs exited with ${code ?? signal}`);
  process.exit(code ?? 1);
});
child.on('error', (err) => {
  console.log(`  FAIL desktop tests: could not start node desktop/test/run.mjs (${err.message})`);
  process.exit(1);
});
