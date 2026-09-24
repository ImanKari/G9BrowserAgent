/**
 * The app and tray icons, drawn in code: a rounded square with the cursor arrow — the one thing
 * G9 draws that the page never sees (D9). No binary assets in the repo; the installer icon is
 * written by scripts/make-icons.mjs from the same function, and the tray recolours it by state.
 *
 * A tiny PNG encoder (zlib is in Node) with 4×4 supersampling for anti-aliased edges.
 */

import zlib from 'node:zlib';
import { CURSOR_POLYGON } from '../renderer/lib/track.js';

export const ICON_COLORS = {
  connected: [47, 91, 234],   // signal blue
  halted: [200, 55, 45],      // stop red
  offline: [122, 132, 148],   // slate grey
  attention: [196, 132, 18],  // amber: port held by something else
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** Encode straight RGBA as a PNG. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function insidePolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideRoundRect(x, y, s, r) {
  const cx = Math.min(Math.max(x, r), s - r);
  const cy = Math.min(Math.max(y, r), s - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/**
 * Draw the icon at `size` px. Returns { width, height, rgba }.
 * @param {keyof ICON_COLORS | number[]} color
 */
export function drawIcon(size, color = 'connected') {
  const [cr, cg, cb] = Array.isArray(color) ? color : ICON_COLORS[color] ?? ICON_COLORS.connected;
  const rgba = new Uint8ClampedArray(size * size * 4);
  const radius = size * 0.22;
  // Arrow: ~62% of the icon, hot spot up-left of centre, nudged so the glyph looks centred.
  const glyph = size * 0.62;
  const ox = size * 0.33;
  const oy = size * 0.17;
  const arrow = CURSOR_POLYGON.map(([px, py]) => [ox + px * glyph, oy + py * glyph]);
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (insideRoundRect(px, py, size, radius)) {
            bg++;
            if (insidePolygon(px, py, arrow)) fg++;
          }
        }
      }
      const a = bg / (SS * SS);
      const f = bg ? fg / bg : 0;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(cr + (255 - cr) * f);
      rgba[i + 1] = Math.round(cg + (255 - cg) * f);
      rgba[i + 2] = Math.round(cb + (255 - cb) * f);
      rgba[i + 3] = Math.round(255 * a);
    }
  }
  return { width: size, height: size, rgba };
}

export function iconPng(size, color) {
  const { width, height, rgba } = drawIcon(size, color);
  return encodePng(width, height, rgba);
}
