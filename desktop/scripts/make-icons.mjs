/**
 * Writes build/icon.png (256×256) for electron-builder, drawn by lib/icon.mjs — the same code that
 * draws the tray icon at runtime. electron-builder turns the PNG into the .ico for G9.exe and the
 * installer. Generated, not committed (desktop/.gitignore).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconPng } from '../lib/icon.mjs';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
fs.mkdirSync(dir, { recursive: true });
const png = iconPng(256, 'connected');
fs.writeFileSync(path.join(dir, 'icon.png'), png);
console.log(`Wrote ${path.join(dir, 'icon.png')} (${png.length} bytes)`);
