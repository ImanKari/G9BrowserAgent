/**
 * G9BrowserAgent's icon, drawn in code — the ONE source of every icon the product shows: the
 * extension's toolbar icons (setup/make-icons.mjs writes extension/panel/icon16/32/48/128.png), the
 * app window, the installer and the .icns/.ico (scripts/make-icons.mjs writes build/icon.png), and
 * the tray, which recolours it by state. No binary artwork outside what these scripts write.
 *
 * The design ("Human Wave", chosen by the owner from 80 candidates): the curved path a person's
 * pointer takes — what G9BrowserAgent's humanized input draws for every agent action — as one white
 * stroke on an ocean-blue tile, from a faint start point to the point it arrives at. One stroke and
 * two dots, so it stays legible at 16 px on light and dark toolbars alike.
 *
 * Rendering: each shape is a signed distance field in a 0..1 unit square, anti-aliased analytically
 * (coverage = 0.5 − distance in pixels), composited back to front. One evaluation per pixel and
 * shape, so the 256 px window icon and the tray images draw in milliseconds at start-up. A tiny PNG
 * encoder (zlib is in Node) writes the result.
 */

import zlib from 'node:zlib';

// ------------------------------------------------------------------ colours

/**
 * The tile's gradient (top-left → bottom-right) per state. The tray recolours the tile: ocean blue
 * when connected, red when agents are stopped, slate when the daemon is offline, amber when the port
 * is held by something else.
 */
export const ICON_GRADIENTS = {
  connected: [[0, 119, 182], [0, 180, 216]],
  halted: [[190, 18, 60], [251, 113, 133]],
  offline: [[71, 85, 105], [148, 163, 184]],
  attention: [[180, 83, 9], [245, 158, 11]],
};

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function gradientAt(stops, t) {
  const u = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(u));
  return mix(stops[i], stops[i + 1], u - i);
}

/** One representative colour per state (the middle of its gradient). */
export const ICON_COLORS = Object.fromEntries(Object.entries(ICON_GRADIENTS).map(([k, v]) => [k, gradientAt(v, 0.5).map(Math.round)]));

// ------------------------------------------------------------------ PNG

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

// ------------------------------------------------------------------ distance fields (unit square)

const sdRoundRect = (x0, y0, w, h, r) => (x, y) => {
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  const qx = Math.abs(x - cx) - (w / 2 - r);
  const qy = Math.abs(y - cy) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

const sdCircle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const sdPolyline = (pts, width) => (x, y) => {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  return d - width / 2;
};


// ------------------------------------------------------------------ the design

/** A cubic Bézier as a polyline. */
const cubic = (p0, p1, p2, p3, n = 28) => Array.from({ length: n + 1 }, (_, i) => {
  const t = i / n;
  const u = 1 - t;
  return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]);
});

/**
 * The wave on the 32-unit design grid, as the SVG it was designed as:
 * `M5.5 20 c4-10 8-10 10.5-4 s7 6 10.5-4` (start dot r 1.8, end dot r 3, stroke 2.8, tile radius 8).
 */
export const WAVE = [...cubic([5.5, 20], [9.5, 10], [13.5, 10], [16, 16]), ...cubic([16, 16], [18.5, 22], [23, 22], [26.5, 12]).slice(1)];
const unit = (v) => v / 32;
const waveUnits = WAVE.map(([x, y]) => [unit(x), unit(y)]);

/** The layers, back to front: { sd, color(x, y) → [r, g, b, a 0..1] }. */
function layers(stops) {
  const white = (a = 1) => () => [255, 255, 255, a];
  return [
    { sd: sdRoundRect(0, 0, 1, 1, 0.25), color: (x, y) => [...gradientAt(stops, (x + y) / 2), 1] },
    { sd: sdCircle(unit(5.5), unit(20), unit(1.8)), color: white(0.75) },
    { sd: sdPolyline(waveUnits, unit(2.8)), color: white() },
    { sd: sdCircle(unit(26.5), unit(12), unit(3)), color: white() },
  ];
}

/** Composite layers at `size` px into straight RGBA. */
function rasterize(size, list) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / size;
      const y = (py + 0.5) / size;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const layer of list) {
        const cov = Math.max(0, Math.min(1, 0.5 - layer.sd(x, y) * size));
        if (cov <= 0) continue;
        const c = layer.color(x, y);
        const ca = c[3] * cov;
        if (ca <= 0) continue;
        // "over", in premultiplied form
        r = c[0] * ca + r * (1 - ca);
        g = c[1] * ca + g * (1 - ca);
        b = c[2] * ca + b * (1 - ca);
        a = ca + a * (1 - ca);
      }
      const i = (py * size + px) * 4;
      rgba[i] = a ? r / a : 0;
      rgba[i + 1] = a ? g / a : 0;
      rgba[i + 2] = a ? b / a : 0;
      rgba[i + 3] = a * 255;
    }
  }
  return rgba;
}

/**
 * Draw the icon at `size` px. Returns { width, height, rgba }.
 * @param {number} size
 * @param {keyof ICON_GRADIENTS | number[]} color a state, or one colour for a flat tile
 */
export function drawIcon(size, color = 'connected') {
  const stops = Array.isArray(color) ? [color, color] : ICON_GRADIENTS[color] ?? ICON_GRADIENTS.connected;
  return { width: size, height: size, rgba: rasterize(size, layers(stops)) };
}

export function iconPng(size, color) {
  const { width, height, rgba } = drawIcon(size, color);
  return encodePng(width, height, rgba);
}

/**
 * The macOS menu-bar image: the wave alone, black on transparent, for
 * `nativeImage.setTemplateImage(true)` — macOS recolours a template for a light or dark menu bar,
 * and a coloured tile there is out of place. A little bolder than on the tile, which it has no more.
 */
export function templatePng(size) {
  const list = [
    { sd: sdCircle(unit(5.5), unit(20), unit(2.2)), a: 0.6 },
    { sd: sdPolyline(waveUnits, unit(3.4)), a: 1 },
    { sd: sdCircle(unit(26.5), unit(12), unit(3.4)), a: 1 },
  ];
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / size;
      const y = (py + 0.5) / size;
      let a = 0;
      for (const layer of list) {
        const ca = layer.a * Math.max(0, Math.min(1, 0.5 - layer.sd(x, y) * size));
        a = ca + a * (1 - ca);
      }
      rgba[(py * size + px) * 4 + 3] = a * 255;
    }
  }
  return encodePng(size, size, rgba);
}
