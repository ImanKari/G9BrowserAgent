/**
 * `npm start` / `npm run smoke`: run Electron on this folder with ELECTRON_RUN_AS_NODE removed.
 *
 * Some shells (VS Code's terminal, several agent hosts) export ELECTRON_RUN_AS_NODE=1. Electron
 * then starts as plain Node, `require('electron')` returns a path string, and the app cannot open
 * a window. Measured on the owner's machine 2026-09-21: `npx electron --version` printed Node's
 * v24.21.0 instead of Electron's v44.4.3 until the variable was cleared.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = require('electron'); // under plain Node: the binary's path
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [appDir, ...process.argv.slice(2)], { stdio: 'inherit', env, windowsHide: false });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', (err) => {
  console.error(`Could not start Electron: ${err.message}`);
  process.exit(1);
});
