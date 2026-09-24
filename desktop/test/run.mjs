/**
 * `npm test` in desktop/: every test/*.test.mjs in its own node process (the same shape as
 * setup/unittest.mjs), then a one-line summary. Exit code 1 if any file failed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs') && (!only.length || only.some((o) => f.includes(o)))).sort();
let failed = 0;
let passed = 0;
const started = Date.now();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit', env });
  if (r.status === 0) passed++;
  else {
    failed++;
    console.error(`✗ ${f} exited with ${r.status ?? r.signal}`);
  }
}
console.log(`\ndesktop tests: ${passed} file(s) passed, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
