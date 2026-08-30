/**
 * User-grade interaction.
 *
 * Every action here goes through Input.dispatch*Event, which injects at the
 * browser's input pipeline — *before* the page sees anything. The resulting
 * events carry isTrusted === true and fire the complete native sequence
 * (pointerdown -> mousedown -> focus -> mouseup -> click). This is the
 * difference between automation that works on real apps and automation that
 * silently fails on any framework that checks isTrusted.
 */

import { send, callOnNode } from '../lib/cdp.js';
import { resolveRef } from '../lib/refs.js';

/** Modifier bitmask used by CDP: Alt=1, Ctrl=2, Meta=4, Shift=8 */
export const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export function modifierMask(list = []) {
  return list.reduce((m, name) => m | (MODIFIERS[name] ?? 0), 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Scroll into view, then return viewport-relative interaction coordinates. */
async function pointFor(tabId, backendNodeId) {
  await callOnNode(
    tabId,
    backendNodeId,
    `function () { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }`,
  );

  let box = null;
  try {
    ({ model: box } = await send(tabId, 'DOM.getBoxModel', { backendNodeId }));
  } catch {
    box = null;
  }

  if (box && Array.isArray(box.content) && box.content.length >= 8 && box.width > 0 && box.height > 0) {
    const q = box.content;
    return {
      x: (q[0] + q[2] + q[4] + q[6]) / 4,
      y: (q[1] + q[3] + q[5] + q[7]) / 4,
      width: box.width,
      height: box.height,
    };
  }

  // Fallback for zero-size, transformed, or CSS-clipped elements.
  const rect = await callOnNode(
    tabId,
    backendNodeId,
    `function () {
       const r = this.getBoundingClientRect();
       return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
     }`,
  );
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    throw new Error('Element has zero size or is not rendered — it may be inside a collapsed or hidden parent.');
  }
  return rect;
}

/** Warn when a different element would actually receive the click. */
async function checkObscured(tabId, backendNodeId, x, y) {
  const verdict = await callOnNode(
    tabId,
    backendNodeId,
    `function (px, py) {
       const top = document.elementFromPoint(px, py);
       if (!top) return { ok: false, reason: 'the point is outside the viewport' };
       if (top === this || this.contains(top) || top.contains(this)) return { ok: true };
       const describe = (el) => {
         let s = el.tagName.toLowerCase();
         if (el.id) s += '#' + el.id;
         if (typeof el.className === 'string' && el.className.trim()) {
           s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
         }
         return s;
       };
       return { ok: false, reason: 'it is covered by <' + describe(top) + '>' };
     }`,
    [x, y],
  );
  return verdict ?? { ok: true };
}

async function mouse(tabId, type, x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
  const buttons = type === 'mouseReleased' || button === 'none'
    ? 0
    : button === 'left' ? 1 : button === 'right' ? 2 : 4;
  await send(tabId, 'Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button,
    clickCount,
    modifiers,
    buttons,
    pointerType: 'mouse',
  });
}

export async function click(tabId, opts = {}) {
  const { ref, x, y, button = 'left', clickCount = 1, modifiers = 0, force = false, url } = opts;
  let point;
  let target = 'coordinates';

  if (ref) {
    const node = await resolveRef(tabId, ref, url);
    point = await pointFor(tabId, node.backendNodeId);
    target = `${node.role} "${node.name}"`;
    if (!force) {
      const v = await checkObscured(tabId, node.backendNodeId, point.x, point.y);
      if (!v.ok) {
        throw new Error(
          `"${node.name || ref}" is not clickable at its centre — ${v.reason}. ` +
            `Close the overlay first, or pass force:true to click through it.`,
        );
      }
    }
  } else if (x != null && y != null) {
    point = { x, y };
  } else {
    throw new Error('click needs either a ref (from browser_snapshot) or explicit x/y coordinates.');
  }

  await mouse(tabId, 'mouseMoved', point.x, point.y, { button: 'none', modifiers });
  for (let i = 1; i <= clickCount; i++) {
    await mouse(tabId, 'mousePressed', point.x, point.y, { button, clickCount: i, modifiers });
    await mouse(tabId, 'mouseReleased', point.x, point.y, { button, clickCount: i, modifiers });
  }

  return { clicked: target, at: { x: Math.round(point.x), y: Math.round(point.y) }, button, clickCount };
}

export async function hover(tabId, { ref, x, y, url } = {}) {
  let point;
  if (ref) {
    const node = await resolveRef(tabId, ref, url);
    point = await pointFor(tabId, node.backendNodeId);
  } else if (x != null && y != null) {
    point = { x, y };
  } else {
    throw new Error('hover needs a ref or x/y coordinates.');
  }
  await mouse(tabId, 'mouseMoved', point.x, point.y, { button: 'none' });
  return { hovered: { x: Math.round(point.x), y: Math.round(point.y) } };
}

/**
 * Type into an element.
 *
 * `fast` uses Input.insertText — a single IME-style insertion that React and
 * Vue controlled inputs handle correctly. Per-character key events are the
 * default because masked fields, autocompletes, and key-filtered numeric
 * inputs only behave correctly with a real keydown/keyup per glyph.
 */
export async function type(tabId, opts = {}) {
  const { ref, text = '', clear = false, fast = false, pressEnter = false, delayMs = 12, url } = opts;

  if (ref) {
    const node = await resolveRef(tabId, ref, url);
    const point = await pointFor(tabId, node.backendNodeId);
    await mouse(tabId, 'mouseMoved', point.x, point.y, { button: 'none' });
    await mouse(tabId, 'mousePressed', point.x, point.y, {});
    await mouse(tabId, 'mouseReleased', point.x, point.y, {});
    await send(tabId, 'DOM.focus', { backendNodeId: node.backendNodeId }).catch(() => {});
  }

  if (clear) {
    // Select-all then delete, so the framework observes a real edit rather
    // than a value assignment it never hears about.
    await key(tabId, { key: 'a', modifiers: MODIFIERS.Control });
    await key(tabId, { key: 'Delete' });
  }

  if (fast) {
    await send(tabId, 'Input.insertText', { text });
  } else {
    for (const ch of [...text]) {
      if (ch === '\n') {
        await key(tabId, { key: 'Enter' });
        continue;
      }
      await send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: ch,
        key: ch,
        unmodifiedText: ch,
      });
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      if (delayMs) await sleep(delayMs);
    }
  }

  if (pressEnter) await key(tabId, { key: 'Enter' });

  return {
    typed: text.length > 60 ? `${text.slice(0, 57)}…` : text,
    cleared: clear,
    pressedEnter: pressEnter,
  };
}

const KEY_MAP = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

/** Named keys and chords: Enter, Tab, Escape, ArrowDown, Control+s … */
export async function key(tabId, { key: name, modifiers = 0, repeat = 1 } = {}) {
  const def = KEY_MAP[name] ?? {
    key: name,
    code: `Key${String(name).toUpperCase()}`,
    keyCode: String(name).toUpperCase().charCodeAt(0),
    text: String(name).length === 1 ? name : undefined,
  };

  for (let i = 0; i < repeat; i++) {
    await send(tabId, 'Input.dispatchKeyEvent', {
      // A chord (Ctrl+S) must be rawKeyDown with no text, or the page receives
      // a literal character instead of the shortcut.
      type: !modifiers && def.text ? 'keyDown' : 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      text: modifiers ? undefined : def.text,
      modifiers,
    });
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      modifiers,
    });
  }
  return { pressed: name, modifiers, repeat };
}

export async function scroll(tabId, { ref, direction = 'down', amount = 400, x, y, url } = {}) {
  let px = x ?? 400;
  let py = y ?? 300;
  if (ref) {
    const node = await resolveRef(tabId, ref, url);
    const p = await pointFor(tabId, node.backendNodeId);
    px = p.x;
    py = p.y;
  }
  const deltas = { down: [0, amount], up: [0, -amount], right: [amount, 0], left: [-amount, 0] };
  const [deltaX, deltaY] = deltas[direction] ?? deltas.down;
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: px,
    y: py,
    deltaX,
    deltaY,
    pointerType: 'mouse',
  });
  return { scrolled: direction, amount };
}

export async function drag(tabId, { from, to, url, steps = 12 } = {}) {
  const a = await resolveRef(tabId, from, url);
  const b = await resolveRef(tabId, to, url);
  const pa = await pointFor(tabId, a.backendNodeId);
  const pb = await pointFor(tabId, b.backendNodeId);

  await mouse(tabId, 'mouseMoved', pa.x, pa.y, { button: 'none' });
  await mouse(tabId, 'mousePressed', pa.x, pa.y, {});
  // Intermediate moves matter: HTML5 drag-and-drop and most JS drag libraries
  // ignore a single jump from source to target.
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await mouse(tabId, 'mouseMoved', pa.x + (pb.x - pa.x) * t, pa.y + (pb.y - pa.y) * t, {});
    await sleep(16);
  }
  await mouse(tabId, 'mouseReleased', pb.x, pb.y, {});
  return { dragged: `${a.name || from} -> ${b.name || to}` };
}

/** Select <option>s by value, label, or visible text. */
export async function select(tabId, { ref, values, url } = {}) {
  const node = await resolveRef(tabId, ref, url);
  const wanted = Array.isArray(values) ? values : [values];
  const result = await callOnNode(
    tabId,
    node.backendNodeId,
    `function (wanted) {
       if (this.tagName !== 'SELECT') return { ok: false, reason: 'the element is not a <select>' };
       const chosen = [];
       for (const opt of this.options) {
         const hit = wanted.includes(opt.value) || wanted.includes(opt.label) || wanted.includes(opt.textContent.trim());
         opt.selected = hit;
         if (hit) chosen.push(opt.textContent.trim() || opt.value);
       }
       if (!chosen.length) {
         return {
           ok: false,
           reason: 'no option matched',
           available: [...this.options].map((o) => o.textContent.trim()).slice(0, 25),
         };
       }
       this.dispatchEvent(new Event('input', { bubbles: true }));
       this.dispatchEvent(new Event('change', { bubbles: true }));
       return { ok: true, chosen };
     }`,
    [wanted],
  );

  if (!result?.ok) {
    throw new Error(
      `Could not select ${JSON.stringify(wanted)}: ${result?.reason}.` +
        (result?.available ? ` Available options: ${result.available.join(' | ')}` : ''),
    );
  }
  return { selected: result.chosen };
}

/** Set files on an <input type=file> without opening the native picker. */
export async function upload(tabId, { ref, files, url } = {}) {
  const node = await resolveRef(tabId, ref, url);
  const list = Array.isArray(files) ? files : [files];
  await send(tabId, 'DOM.setFileInputFiles', {
    backendNodeId: node.backendNodeId,
    files: list,
  });
  return { uploaded: list };
}
