/**
 * G9BrowserAgent's icon, drawn in code — the ONE source of every icon the product shows: the
 * extension's toolbar icons (setup/make-icons.mjs writes extension/panel/icon16/32/48/128.png), the
 * app window, the installer and the .icns/.ico (scripts/make-icons.mjs writes build/icon.png), and
 * the tray, which recolours it by state. No binary artwork outside what these scripts write.
 *
 * The design (3.5.0): "an agent at work inside a real browser". A frosted browser window on an aurora
 * tile (cyan → violet → pink), and a faceted pointer that reaches into the window from outside it —
 * the agent's hand in the person's own page. Around the pointer's tip, at 32 px and up, a click
 * ripple; the window's three dots at 48 px and up. At 24 px and below a pixel-tuned variant: a
 * larger window and pointer, no dots, no ripple (they are a blur that small). Designed and checked
 * at 16, 24, 32, 48 and 128 px on light and dark toolbars.
 *
 * Rendering: each shape is a signed distance field in a 0..1 unit square, anti-aliased analytically
 * (coverage = 0.5 − distance in pixels), composited back to front. One evaluation per pixel and
 * shape, so the 256 px window icon and the tray images draw in milliseconds at start-up. A tiny PNG
 * encoder (zlib is in Node) writes the result.
 */

import zlib from 'node:zlib';

// ------------------------------------------------------------------ colours

const AURORA = [[34, 211, 238], [139, 92, 246], [244, 114, 182]]; // cyan-400, violet-500, pink-400

/**
 * The tile's gradient stops per state. The tray recolours the tile: aurora when connected, red when
 * agents are stopped, slate when the daemon is offline, amber when the port is held by something else.
 */
export const ICON_GRADIENTS = {
  connected: AURORA,
  halted: [[251, 113, 133], [225, 29, 72], [159, 18, 57]],
  offline: [[148, 163, 184], [100, 116, 139], [71, 85, 105]],
  attention: [[252, 211, 77], [245, 158, 11], [217, 119, 6]],
};

/** One representative colour per state (the gradient's middle stop). */
export const ICON_COLORS = Object.fromEntries(Object.entries(ICON_GRADIENTS).map(([k, v]) => [k, v[1]]));

const INK = [17, 16, 42];
const INK_LIT = [46, 42, 96];
const DOTS = [139, 92, 246];

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function gradientAt(stops, t) {
  const u = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(u));
  return mix(stops[i], stops[i + 1], u - i);
}

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

const sdPolygon = (pts) => (x, y) => {
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    d = Math.min(d, segDist(x, y, xj, yj, xi, yi));
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? -d : d;
};

const sdPolyline = (pts, width) => (x, y) => {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  return d - width / 2;
};

const grow = (sd, by) => (x, y) => sd(x, y) - by;
const union = (...sds) => (x, y) => Math.min(...sds.map((f) => f(x, y)));

const arc = (cx, cy, r, a0, a1, n = 16) => Array.from({ length: n + 1 }, (_, i) => {
  const a = a0 + ((a1 - a0) * i) / n;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
});

// ------------------------------------------------------------------ the design

/**
 * The pointer, tip at the origin, one unit tall: a slightly stockier arrow than the live view's
 * cursor (renderer/lib/track.js), so its tail survives at 16 px. Points 0-1-2 and 5 bound its lit
 * left facet.
 */
export const POINTER = [[0, 0], [0, 0.8], [0.21, 0.61], [0.33, 0.92], [0.5, 0.85], [0.38, 0.57], [0.62, 0.57]];

const place = (pts, s, dx, dy) => pts.map(([x, y]) => [x * s + dx, y * s + dy]);

/** Geometry for a size: the pixel-tuned small variant at 24 px and below. */
function geometry(size) {
  if (size <= 24) {
    return {
      window: [0.125, 0.125, 0.625, 0.5625, 0.1],
      bar: 0.16,
      pointer: { s: 0.5, x: 0.465, y: 0.42 },
      gap: 0.055,
      dots: false,
      ripple: false,
    };
  }
  return {
    window: [0.11, 0.14, 0.62, 0.55, 0.09],
    bar: 0.13,
    pointer: { s: 0.47, x: 0.47, y: 0.44 },
    gap: 0.04,
    dots: size >= 48,
    ripple: true,
  };
}

/**
 * The layers, back to front: { sd, color(x, y) → [r, g, b, a 0..1] }.
 * @param {number} size
 * @param {number[][]} stops the tile's gradient
 */
function layers(size, stops) {
  const g = geometry(size);
  const [wx, wy, ww, wh, wr] = g.window;
  const p = place(POINTER, g.pointer.s, g.pointer.x, g.pointer.y);
  const tip = p[0];
  const facet = [p[0], p[1], p[2], p[5]];
  const solid = (rgb, a = 1) => () => [rgb[0], rgb[1], rgb[2], a];
  const out = [
    // The tile: a diagonal gradient, more vertical than 45° so the pink gathers at the bottom.
    { sd: sdRoundRect(0, 0, 1, 1, 0.23), color: (x, y) => [...gradientAt(stops, x * 0.45 + y * 0.55), 1] },
    // A soft sheen from the top-left: light falling on the tile.
    {
      sd: sdRoundRect(0, 0, 1, 1, 0.23),
      color: (x, y) => [255, 255, 255, 0.28 * Math.max(0, 1 - Math.hypot(x - 0.18, y - 0.1) / 0.75) ** 2],
    },
    // The browser window: a frosted body and a solid title bar.
    { sd: sdRoundRect(wx, wy, ww, wh, wr), color: solid([255, 255, 255], 0.92) },
    { sd: sdRoundRect(wx, wy, ww, g.bar, Math.min(wr, g.bar / 2)), color: solid([255, 255, 255]) },
  ];
  if (g.dots) {
    const y = wy + g.bar / 2;
    out.push({ sd: union(sdCircle(wx + 0.08, y, 0.022), sdCircle(wx + 0.145, y, 0.022), sdCircle(wx + 0.21, y, 0.022)), color: solid(DOTS, 0.8) });
  }
  if (g.ripple) {
    // Three short arcs around the tip, up and to the left of it: the click.
    const arcs = [-0.75, -1.25, -1.75].map((a) => sdPolyline(arc(tip[0], tip[1], 0.1, a * Math.PI - 0.25, a * Math.PI + 0.25), 0.03));
    out.push({ sd: union(...arcs), color: solid(DOTS, 0.9) });
  }
  // The pointer: a white outline that cuts it out of the window, an ink body, a lit left facet.
  out.push({ sd: grow(sdPolygon(p), g.gap), color: solid([255, 255, 255]) });
  out.push({ sd: sdPolygon(p), color: solid(INK) });
  out.push({ sd: sdPolygon(facet), color: solid(INK_LIT) });
  return out;
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
  return { width: size, height: size, rgba: rasterize(size, layers(size, stops)) };
}

export function iconPng(size, color) {
  const { width, height, rgba } = drawIcon(size, color);
  return encodePng(width, height, rgba);
}

/**
 * The macOS menu-bar image: the same window and pointer in black on transparent, for
 * `nativeImage.setTemplateImage(true)` — macOS recolours a template for a light or dark menu bar,
 * and a coloured tile there is out of place. The pointer is cut out of the window by a clear gap.
 */
export function templatePng(size) {
  const g = geometry(size);
  const [wx, wy, ww, wh, wr] = [0.04, 0.1, 0.74, 0.62, 0.12];
  const p = place(POINTER, 0.56, 0.42, 0.4);
  const black = () => [0, 0, 0, 1];
  const list = [
    { sd: sdRoundRect(wx, wy, ww, wh, wr), color: () => [0, 0, 0, 0.55] },
    { sd: sdRoundRect(wx, wy, ww, 0.17, 0.085), color: black },
    { sd: grow(sdPolygon(p), g.gap * 1.2), color: () => [0, 0, 0, 0], erase: true },
    { sd: sdPolygon(p), color: black },
  ];
  // The cut-out: clear what lies under the pointer's outline before drawing the pointer.
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / size;
      const y = (py + 0.5) / size;
      let a = 0;
      for (const layer of list) {
        const cov = Math.max(0, Math.min(1, 0.5 - layer.sd(x, y) * size));
        if (layer.erase) a *= 1 - cov;
        else a = layer.color()[3] * cov + a * (1 - layer.color()[3] * cov);
      }
      rgba[(py * size + px) * 4 + 3] = a * 255;
    }
  }
  return encodePng(size, size, rgba);
}
