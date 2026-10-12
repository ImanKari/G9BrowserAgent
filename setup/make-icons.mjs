#!/usr/bin/env node
/**
 * Writes the extension's toolbar icons (extension/panel/icon16/32/48/128.png) from the one icon
 * design in desktop/lib/icon.mjs — the same code that draws the app, the installer and the tray, so
 * the browser and the desktop show one mark. Run it after changing the design:
 *
 *   node setup/make-icons.mjs
 *
 * setup/unit/panel.test.mjs decodes the committed PNGs and fails when they differ from what this
 * script would write, so a design change cannot reach only half of the product.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconPng } from '../desktop/lib/icon.mjs';

export const EXTENSION_ICON_SIZES = [16, 32, 48, 128];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'extension', 'panel');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const size of EXTENSION_ICON_SIZES) {
    const file = path.join(out, `icon${size}.png`);
    const png = iconPng(size, 'connected');
    fs.writeFileSync(file, png);
    console.log(`Wrote ${path.relative(root, file)} (${png.length} bytes)`);
  }
}
