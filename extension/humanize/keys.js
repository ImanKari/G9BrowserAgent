/**
 * Keyboard: the US-QWERTY key tables, and the typing and key-press planners.
 *
 * The tables moved here from tools/interact.js (keyDefinition/physicalKey) so
 * one copy serves both engines and every level. Two rules carried over from
 * v1, both learned the hard way:
 *
 * - `code` is the PHYSICAL key and does not follow from the character the
 *   obvious way: '1' is Digit1 (not Key1), '!' is Shift+Digit1, F5 is F5.
 *   Key-filtered numeric inputs and masked fields read event.code and
 *   event.keyCode, so a wrong one silently breaks exactly the inputs that
 *   most need real key events (the v1.0.15 entry).
 * - Where a value cannot be known honestly it is omitted: a fabricated
 *   keyCode is worse than none. A character with no US key (Persian, emoji)
 *   has no code and no virtual key code.
 *
 * Non-ASCII characters are typed as rawKeyDown(key) → char(text) → keyUp: no
 * code, no key code. That is the same event shape Windows produces for Unicode
 * injected with KEYEVENTF_UNICODE (the VK_PACKET path used by on-screen
 * keyboards and remote tools) — keydown, keypress, input, keyup, with no
 * physical key — and it is what a page can honestly be shown without guessing
 * the person's layout. Text is always split by CODE POINT, never grapheme:
 * Chromium caps a key event's text at 4 UTF-16 units, so a ZWJ emoji sequence
 * sent as one event would be truncated; sent per code point it assembles in
 * the field exactly as typed.
 */

import { PlanBuilder, clamp, finite } from './plan.js';

/** CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8 (same as interact.js). */
export const MODIFIERS = Object.freeze({ Alt: 1, Control: 2, Meta: 4, Shift: 8 });
const SHIFT = MODIFIERS.Shift;

const MODIFIER_ALIASES = {
  alt: 'Alt', option: 'Alt', opt: 'Alt',
  control: 'Control', ctrl: 'Control', ctl: 'Control',
  meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta', windows: 'Meta', os: 'Meta', super: 'Meta',
  shift: 'Shift',
};

/** Order a person presses modifiers in: Control first, Shift last (Ctrl+Shift+T). */
const PRESS_ORDER = ['Control', 'Meta', 'Alt', 'Shift'];

/**
 * Table lookup by OWN property only. Key names come from agents and stored
 * flows; "constructor" or "__proto__" must be an unknown key, not a hit on
 * Object.prototype (which made keyDefinition('constructor') return an object
 * with no `key` at all).
 */
const own = (table, k) => (Object.prototype.hasOwnProperty.call(table, k) ? table[k] : undefined);

/** The canonical modifier name, or null. */
export function modifierName(name) {
  return own(MODIFIER_ALIASES, String(name).toLowerCase()) ?? null;
}

/** ['Control', 'Shift'] | 'Control' | 10 → 10. Unknown names are ignored, as in v1. */
export function modifierMask(list = []) {
  if (typeof list === 'number') return Number.isFinite(list) ? list & 15 : 0;
  const arr = Array.isArray(list) ? list : [list];
  return arr.reduce((m, n) => m | (own(MODIFIERS, modifierName(n)) ?? 0), 0);
}

/** A mask or a list → canonical names, deduped, in press order (a list keeps its own order). */
export function modifierList(mods) {
  if (typeof mods === 'number') return PRESS_ORDER.filter((n) => mods & MODIFIERS[n]);
  const arr = Array.isArray(mods) ? mods : mods ? [mods] : [];
  const out = [];
  for (const n of arr) {
    const c = modifierName(n);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

// ------------------------------------------------------------------ tables

const NAMED = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
  CapsLock: { key: 'CapsLock', code: 'CapsLock', keyCode: 20 },
  NumLock: { key: 'NumLock', code: 'NumLock', keyCode: 144 },
  ScrollLock: { key: 'ScrollLock', code: 'ScrollLock', keyCode: 145 },
  Pause: { key: 'Pause', code: 'Pause', keyCode: 19 },
  PrintScreen: { key: 'PrintScreen', code: 'PrintScreen', keyCode: 44 },
  ContextMenu: { key: 'ContextMenu', code: 'ContextMenu', keyCode: 93 },
};

const NAME_ALIASES = {
  esc: 'Escape', return: 'Enter', del: 'Delete', ins: 'Insert',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  pgup: 'PageUp', pgdn: 'PageDown', pgdown: 'PageDown', spacebar: 'Space',
  ctrl: 'Control', ctl: 'Control', cmd: 'Meta', command: 'Meta', win: 'Meta', windows: 'Meta', os: 'Meta', super: 'Meta',
  option: 'Alt', opt: 'Alt', apps: 'ContextMenu', menu: 'ContextMenu', prtsc: 'PrintScreen', break: 'Pause',
};

// Case-insensitive lookup for named keys ("enter", "PAGEDOWN" and "Esc" all work).
const NAMED_LOWER = {};
for (const name of Object.keys(NAMED)) NAMED_LOWER[name.toLowerCase()] = name;
for (const [alias, name] of Object.entries(NAME_ALIASES)) NAMED_LOWER[alias] = name;

/** Unshifted punctuation on the US layout: character → [code, keyCode]. */
const PUNCTUATION = {
  '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219],
  ']': ['BracketRight', 221], '\\': ['Backslash', 220], ';': ['Semicolon', 186],
  "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190],
  '/': ['Slash', 191], '`': ['Backquote', 192], ' ': ['Space', 32],
};

/** Shifted symbols: character → the unshifted character on the same key. */
const SHIFTED = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8',
  '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'",
  '<': ',', '>': '.', '?': '/',
};
const UNSHIFTED_TO_SHIFTED = Object.fromEntries(Object.entries(SHIFTED).map(([s, u]) => [u, s]));

/** Keys a touch typist hits with the LEFT hand; the other hand then holds Shift. */
const LEFT_HAND = new Set(['Backquote', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG',
  'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB']);

const SHIFT_LEFT = { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 };
const SHIFT_RIGHT = { key: 'Shift', code: 'ShiftRight', keyCode: 16, location: 2 };

function printable(ch) {
  if (/^[a-z]$/.test(ch)) return { key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.toUpperCase().charCodeAt(0), text: ch, shift: false };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: 'Key' + ch, keyCode: ch.charCodeAt(0), text: ch, shift: true };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: 'Digit' + ch, keyCode: ch.charCodeAt(0), text: ch, shift: false };
  const p = PUNCTUATION[ch];
  if (p) return { key: ch, code: p[0], keyCode: p[1], text: ch, shift: false };
  const base = SHIFTED[ch];
  if (base !== undefined) {
    const u = printable(base);
    return { key: ch, code: u.code, keyCode: u.keyCode, text: ch, shift: true };
  }
  return null;
}

/** One code point (a surrogate pair counts as one character). */
function isSingleCodePoint(s) {
  return s.length > 0 && [...s].length === 1;
}

// Grapheme segmentation is part of the language (ECMA-402), not a platform
// API; a fixed locale keeps it independent of the machine.
const GRAPHEMES = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : null;

/** One user-perceived character ("é" as e + ◌́, a flag, a skin-toned emoji). */
function isSingleGrapheme(s) {
  if (GRAPHEMES) {
    const first = GRAPHEMES.segment(s)[Symbol.iterator]().next();
    return !first.done && first.value.segment.length === s.length;
  }
  return /^.\p{M}*$/su.test(s); // no Intl.Segmenter: a base character and its combining marks
}

/**
 * Chromium refuses Input.dispatchKeyEvent text longer than this many UTF-16
 * units (blink::WebKeyboardEvent::kTextLengthCap) with "Invalid 'text' parameter".
 */
export const KEY_TEXT_CAP = 4;

/**
 * keyDefinition(char | keyName) → { key, code, keyCode, text?, shift, location? }
 *
 *   printable ASCII   'a' → KeyA/65, 'A' → KeyA/65 shift, '!' → Digit1/49 shift, ' ' → Space/32
 *   line breaks       '\n' and '\r' → Enter (text "\r"), '\t' → Tab
 *   named keys        Enter, Tab, Escape, Backspace, Delete, Insert, Arrow*, Home, End, PageUp,
 *                     PageDown, Space, F1–F24, Shift, Control, Alt, Meta, CapsLock, … —
 *                     case-insensitive, with aliases (Esc, Return, Del, Up, PgDn, Ctrl, Cmd, …)
 *   any other char    Persian, emoji, accented letters — one grapheme of at most 4 UTF-16
 *                     units (Chromium's cap): { key: ch, code: '', keyCode: 0, text: ch }
 *   unknown name      a DOM-style name ("AudioVolumeUp", "BrowserBack") passes through with
 *                     code = name
 *   anything else     "Ctrl+Shit+K", "hello": { key, code: '', keyCode: 0 } with no text —
 *                     isKnownKey() is false for it and planKeyPress refuses it
 *
 * `code: ''` and `keyCode: 0` mean "unknown" (the DOM's own values for it);
 * physicalKey() leaves them out of the CDP event. Returns a fresh object.
 */
export function keyDefinition(name) {
  const s = typeof name === 'string' ? name : String(name ?? '');
  if (!s.length) throw new TypeError('keyDefinition needs a key name or a character.');

  if (isSingleCodePoint(s)) {
    if (s === '\n' || s === '\r') return { ...NAMED.Enter, shift: false };
    if (s === '\t') return { ...NAMED.Tab, shift: false };
    const def = printable(s);
    if (def) return def;
    return { key: s, code: '', keyCode: 0, text: s, shift: false };
  }

  const named = own(NAMED, s) ?? own(NAMED, own(NAMED_LOWER, s.toLowerCase()));
  if (named) return { ...named, shift: false };

  const f = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(s);
  if (f) return { key: 'F' + f[1], code: 'F' + f[1], keyCode: 111 + Number(f[1]), shift: false };

  // A DOM key name we do not tabulate ("AudioVolumeUp", "BrowserBack"): pass it
  // through, as v1 did — the DOM code name is the same string for these.
  if (/^[A-Z][A-Za-z0-9]+$/.test(s)) return { key: s, code: s, keyCode: 0, shift: false };

  // One character written as several code points (a combining sequence such
  // as "é" = e + ◌́, a flag, a skin-toned emoji) is text, within Chromium's cap.
  if (s.length <= KEY_TEXT_CAP && isSingleGrapheme(s)) return { key: s, code: '', keyCode: 0, text: s, shift: false };

  // Anything else is not a key: no text, no code. (It used to be text, so a
  // mistyped chord such as "Ctrl+Shit+K" became an 11-character key event,
  // which Chromium rejects.) isKnownKey() says no to it; planKeyPress refuses it.
  return { key: s, code: '', keyCode: 0, shift: false };
}

/** Is this a definition keyDefinition() actually knows (a key, or one character of text)? */
export function isKnownKey(def) {
  return !!def && (!!def.code || !!def.text);
}

/**
 * v1's key for the DIRECT level: a shifted symbol ('!', '@', '{') had no
 * physical key at all. That level presses no Shift, and Digit1/keyCode 49
 * without Shift describes a different key ('1'), so the honest event carries
 * none. Letters keep KeyA/65, as they did in v1. (tools/interact.js sends the
 * same on its own direct path.)
 */
export function directDefinition(def) {
  return def.shift && !/^[A-Za-z]$/.test(def.key) ? { key: def.key, code: '', keyCode: 0, text: def.text, shift: true } : def;
}

/** Only emit code/keyCode when they are actually known (v1 rule). */
export function physicalKey(def) {
  return {
    ...(def.code ? { code: def.code } : {}),
    ...(def.keyCode ? { windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode } : {}),
  };
}

/** The shifted character on the same key ('1' → '!', 'a' → 'A'), or null. */
export function shiftedOf(ch) {
  if (/^[a-z]$/.test(ch)) return ch.toUpperCase();
  return own(UNSHIFTED_TO_SHIFTED, ch) ?? null;
}

// ------------------------------------------------------- QWERTY adjacency

const ROWS = [
  ['1234567890', 0],
  ['qwertyuiop', 0.5],
  ['asdfghjkl', 0.75],
  ['zxcvbnm', 1.25],
];

/**
 * Keys physically next to each key (lower-case letters and digits), derived
 * from the staggered row geometry: same row ±1, or an adjacent row within
 * 0.8 key widths. Letters only neighbour letters and digits only digits — a
 * typo lands where a finger slips, and a slip from a letter onto the number
 * row is rare enough to leave out.
 */
export const QWERTY_NEIGHBOURS = (() => {
  const pos = {};
  ROWS.forEach(([keys, offset], row) => [...keys].forEach((k, i) => { pos[k] = { x: offset + i, y: row }; }));
  const out = {};
  for (const [k, p] of Object.entries(pos)) {
    const digit = /[0-9]/.test(k);
    out[k] = Object.entries(pos)
      .filter(([o, q]) => o !== k && /[0-9]/.test(o) === digit
        && ((q.y === p.y && Math.abs(q.x - p.x) === 1) || (Math.abs(q.y - p.y) === 1 && Math.abs(q.x - p.x) <= 0.8)))
      .map(([o]) => o)
      .join('');
  }
  return Object.freeze(out);
})();

/** A plausible wrong key for `ch`, with the same case; null if it has none. */
export function typoFor(rng, ch) {
  const lower = ch.toLowerCase();
  const near = own(QWERTY_NEIGHBOURS, lower);
  if (!near) return null;
  const wrong = rng.pick([...near]);
  return ch !== lower ? wrong.toUpperCase() : wrong;
}

// ---------------------------------------------------------- step helpers

/** The fields of one key step (PlanBuilder.key drops the undefined ones). */
export function keyFields(type, def, { modifiers = 0, text, unmodifiedText, key } = {}) {
  const phys = physicalKey(def);
  return {
    type,
    key: key ?? def.key,
    code: phys.code,
    windowsVirtualKeyCode: phys.windowsVirtualKeyCode,
    nativeVirtualKeyCode: phys.nativeVirtualKeyCode,
    location: def.location || undefined,
    text: type === 'keyUp' || type === 'rawKeyDown' ? undefined : text,
    unmodifiedText: type === 'keyUp' || type === 'rawKeyDown' ? undefined : unmodifiedText,
    modifiers,
    autoRepeat: false,
  };
}

/**
 * Press the modifier keys of a chord, one after another, each keydown carrying
 * the modifiers held so far (a real Control keydown already has ctrlKey set).
 * Returns the time the last one went down. Used by planKeyPress and by the
 * mouse planners for Ctrl+click.
 */
export function pressModifiers(b, rng, profile, names, at = b.t) {
  let t = at;
  let mask = 0;
  names.forEach((n, i) => {
    if (i > 0) t += rng.int(...profile.keyboard.chordGapMs);
    mask |= MODIFIERS[n];
    b.key(keyFields('rawKeyDown', NAMED[n], { modifiers: mask }), t);
  });
  return t;
}

/** Release them in reverse order; each keyup no longer carries its own bit. */
export function releaseModifiers(b, rng, profile, names, at = b.t) {
  let t = at;
  let mask = modifierMask(names);
  [...names].reverse().forEach((n, i) => {
    if (i > 0) t += rng.int(...profile.keyboard.chordGapMs);
    mask &= ~MODIFIERS[n];
    b.key(keyFields('keyUp', NAMED[n], { modifiers: mask }), t);
  });
  return t;
}

// ------------------------------------------------------------------ typing

/** Code points, with every line break (\r\n, \r, \n) as one '\n'. */
function tokenize(text) {
  const out = [];
  const cps = [...text];
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (c === '\r') {
      if (cps[i + 1] === '\n') i++;
      out.push('\n');
    } else {
      out.push(c);
    }
  }
  return out;
}

const isSpaceOrPunct = (ch) => /^[\p{P}\p{S}\p{Z}\s]$/u.test(ch);
const isTypoable = (ch) => /^[A-Za-z0-9]$/.test(ch);

/**
 * The Backspace of a typo correction. A Symbol, not '\b': a literal U+0008 in
 * the text to type is a character like any other, and treating it as
 * Backspace deleted the character before it (effectiveText of 'ab\bc' was "ac").
 */
const BACKSPACE = Symbol('Backspace');

/** How a token is typed, which decides Shift, rollover and pauses. */
function classify(token, def) {
  if (token === BACKSPACE) return 'special';
  if (def.key === 'Enter' || def.key === 'Tab') return 'special';
  if (!def.code) return 'unicode';
  if (def.shift) return 'shifted';
  return 'plain';
}

/**
 * planType(rng, profile, { text, field:{password, numericMask}, typos?, from?, delayMs? }) → Plan
 *
 * Human levels (plan §6.3): a think pause, then per-character key events with
 * log-normal inter-key intervals (×1.6 after space/punctuation, ×2.0 before a
 * character that needs a fresh Shift press), Shift pressed and released around
 * shifted characters (held across a run of them, on the opposite hand's side),
 * natural key-hold overlap on plain characters, and — at the profile's rate — a
 * typo: a QWERTY neighbour, 1–2 more correct characters, a pause, Backspaces,
 * the retype. Never in a password field, never in a masked numeric field,
 * never with `typos:false`.
 *
 * Invariant: effectiveText(plan) === text (line breaks normalised to '\n').
 *
 * Direct (off): v1 exactly — keyDown(text)/keyUp per character, `delayMs`
 * (default profile.keyboard.directDelayMs = 12, v1's) after each character
 * except after a line break, which v1 pressed as Enter with no delay.
 */
export function planType(rng, profile, { text = '', field = {}, typos, from = null, delayMs } = {}) {
  const tokens = tokenize(String(text ?? ''));
  const b = new PlanBuilder('type', profile, rng, { from });
  const K = profile.keyboard;

  if (profile.direct) {
    const delay = Math.max(0, Math.round(finite(delayMs, K.directDelayMs)));
    let t = 0;
    for (const ch of tokens) {
      if (ch === '\n') {
        const enter = keyDefinition('Enter');
        b.key(keyFields('keyDown', enter, { modifiers: 0, text: enter.text }), t);
        b.key(keyFields('keyUp', enter, { modifiers: 0 }), t);
        continue;
      }
      // v1: no modifiers on any character (this level presses no Shift), and
      // a shifted symbol with no physical key — see directDefinition.
      const def = directDefinition(keyDefinition(ch));
      b.key(keyFields('keyDown', def, { modifiers: 0, text: ch, unmodifiedText: ch }), t);
      b.key(keyFields('keyUp', def, { modifiers: 0 }), t);
      t += delay;
    }
    b.t = t;
    return b.finish({ chars: tokens.length, typos: 0 }, { end: from ?? null });
  }

  const allowTypos = typos !== false && !field?.password && !field?.numericMask && K.typoRate > 0;
  const holdFor = () => Math.round(clamp(rng.logNormal(K.holdMedianMs, K.holdSigma), K.holdMs[0], K.holdMs[1]));

  if (tokens.length) b.pause(rng.int(...K.thinkMs), 'think');

  const st = {
    lastDown: null,   // keyDown time of the previous keystroke
    lastUp: b.t,      // latest key release so far (a non-rollover key waits for it)
    charUp: b.t,      // release time of the last character key (Shift is released after it)
    prev: null,       // previous token, for the ×1.6 after space/punctuation
    prevPlain: false, // may the next key overlap the previous one?
    shift: null,      // the Shift key currently held (SHIFT_LEFT/RIGHT), or null
    held: new Map(),  // physical key (code) → its planned keyUp time
  };
  let keystrokes = 0;
  let typoCount = 0;

  const releaseShift = () => {
    if (!st.shift) return;
    const upAt = st.charUp + rng.int(...K.shiftTrailMs);
    b.key(keyFields('keyUp', st.shift, { modifiers: 0 }), upAt);
    st.shift = null;
    st.lastUp = Math.max(st.lastUp, upAt);
  };

  // One keystroke. `at` forces its keyDown time (the first Backspace after a
  // noticed typo); otherwise it follows the previous keyDown by a sampled
  // inter-key interval.
  const strike = (token, { factor = 1, at } = {}) => {
    const def = token === BACKSPACE ? keyDefinition('Backspace') : keyDefinition(token);
    const kind = classify(token, def);
    const needShift = kind === 'shifted';

    let down;
    if (at !== undefined) {
      down = at;
    } else if (st.lastDown === null) {
      down = b.t;
    } else {
      let iki = clamp(rng.logNormal(K.ikiMedianMs, K.ikiSigma), K.ikiMs[0], K.ikiMs[1]);
      if (typeof st.prev === 'string' && isSpaceOrPunct(st.prev)) iki *= K.afterSpaceOrPunct;
      if (needShift && !st.shift) iki *= K.beforeShifted;
      down = st.lastDown + Math.max(1, Math.round(iki * factor));
    }

    if (!needShift && st.shift) {
      releaseShift();
      down = Math.max(down, st.lastUp + 1);
    }
    if (needShift && !st.shift) {
      const lead = rng.int(...K.shiftLeadMs);
      const shiftAt = Math.max(down - lead, st.lastUp + 1, st.lastDown === null ? b.t : st.lastDown + 1);
      st.shift = LEFT_HAND.has(def.code) ? SHIFT_RIGHT : SHIFT_LEFT;
      b.key(keyFields('rawKeyDown', st.shift, { modifiers: SHIFT }), shiftAt);
      down = shiftAt + lead;
    }

    const mayOverlap = K.rollover && st.prevPlain && kind === 'plain';
    if (!mayOverlap) down = Math.max(down, st.lastUp + 1);
    // Rollover is between DIFFERENT keys. A key still held cannot go down again: "ll", "ee", "00"
    // (and a typo followed by the same key, or A-B-A with B overlapping A) planned a second
    // keydown of one code before its keyup — keydown, keydown, keyup, keyup with repeat:false,
    // which no keyboard produces and a keystroke-dynamics script pairs by code (interaction review,
    // 2026-09-22: 36% of 'committee' plans at human, 24% at stealth).
    const phys = def.code || def.key;
    const heldUntil = st.held.get(phys);
    if (heldUntil !== undefined) down = Math.max(down, heldUntil + 1);
    if (st.lastDown !== null) down = Math.max(down, st.lastDown + 1);

    const mods = st.shift ? SHIFT : 0;
    const up = down + holdFor();
    if (kind === 'unicode') {
      b.key(keyFields('rawKeyDown', def, { modifiers: mods }), down);
      b.key(keyFields('char', def, { modifiers: mods, text: def.text, unmodifiedText: def.text }), down);
    } else if (def.text) {
      b.key(keyFields('keyDown', def, { modifiers: mods, text: def.text, unmodifiedText: def.text }), down);
    } else {
      b.key(keyFields('rawKeyDown', def, { modifiers: mods }), down);
    }
    b.key(keyFields('keyUp', def, { modifiers: mods }), up);

    keystrokes++;
    st.held.set(phys, up);
    st.lastDown = down;
    st.charUp = up;
    st.lastUp = Math.max(st.lastUp, up);
    st.prev = token;
    st.prevPlain = kind === 'plain';
  };

  let corrected = -1; // index just retyped after a typo: no second typo on it
  for (let i = 0; i < tokens.length; i++) {
    const ch = tokens[i];
    if (allowTypos && corrected !== i && isTypoable(ch) && rng.chance(K.typoRate)) {
      const wrong = typoFor(rng, ch);
      if (wrong) {
        typoCount++;
        strike(wrong);
        // Keep going for a character or two before noticing — only over
        // printable ASCII: a line break or Tab would submit the form or leave
        // the field, and Chrome's Backspace removes a whole grapheme (👍🏽 is
        // two code points, one Backspace), so past an emoji the planned
        // Backspaces would delete a correct character too many.
        const want = rng.int(...K.typoContinue);
        let typedOn = 0;
        while (typedOn < want && i + 1 + typedOn < tokens.length && /^[\x20-\x7e]$/.test(tokens[i + 1 + typedOn])) {
          strike(tokens[i + 1 + typedOn]);
          typedOn++;
        }
        releaseShift();
        const noticeAt = st.lastUp;
        const notice = rng.int(...K.typoNoticeMs);
        b.steps.push({ at: noticeAt, kind: 'pause', ms: notice, reason: 'notice-typo' });
        for (let n = 0; n <= typedOn; n++) {
          strike(BACKSPACE, n === 0 ? { at: noticeAt + notice } : { factor: K.backspaceFactor });
        }
        corrected = i;
        i--; // retype from the wrong character on
        continue;
      }
    }
    strike(ch);
  }
  releaseShift();

  b.t = Math.max(b.t, st.lastUp);
  return b.finish({ chars: tokens.length, keystrokes, typos: typoCount }, { end: from ?? null });
}

// --------------------------------------------------------------- key press

/** 'Control+Shift+K' → { key: 'K', mods: ['Control', 'Shift'] }; 'Control++' → key '+'. */
export function parseKeySpec(spec) {
  const s = String(spec ?? '');
  if (s.length < 2 || !s.includes('+')) return { key: s, mods: [] };
  let main;
  let prefix;
  if (s.endsWith('++')) {
    main = '+';
    prefix = s.slice(0, -2);
  } else {
    const i = s.lastIndexOf('+');
    main = s.slice(i + 1);
    prefix = s.slice(0, i);
  }
  const parts = prefix.split('+');
  if (!main || !parts.every((p) => modifierName(p))) return { key: s, mods: [] };
  return { key: main, mods: parts.map(modifierName) };
}

/**
 * planKeyPress(rng, profile, { key, modifiers=[], repeat=1, from? }) → Plan
 *
 * `key` is a named key, a single character, or a chord string ("Control+s");
 * `modifiers` a list of names or a CDP mask. In a chord the Shift state comes
 * ONLY from the modifiers: "Control+S" is Ctrl+s, never Ctrl+Shift+s. A key
 * this library does not know ("Ctrl+Shit+K", "hello") is a TypeError, never
 * sent: pressing a key that does not exist and reporting it pressed is the
 * silent success this codebase forbids. Text goes through planType.
 *
 * Human levels: modifiers go down one by one (Control first, Shift last), each
 * keydown carrying the modifiers held so far, then the main key, then
 * everything is released in reverse. Under a COMMAND modifier (Control, Alt,
 * Meta) the main key is a rawKeyDown with NO text — or the page receives a
 * literal character instead of the shortcut. Under Shift alone it still types:
 * Shift+a is keyDown "A", Shift+Enter a line break, as on a real keyboard. A
 * modifier as the main key ("Control+Shift") carries its own bit on its
 * keydown, as a real one does. A plain key is keyDown (with text when it has
 * one) → hold → keyUp; a shifted character on its own ('!') is typed with
 * Shift as planType would.
 *
 * Direct (off): v1's dispatchKey exactly — the main key only, with the
 * modifier mask, rawKeyDown without text under any modifier, no delays.
 */
export function planKeyPress(rng, profile, { key, modifiers = [], repeat = 1, from = null } = {}) {
  const spec = parseKeySpec(key);
  const names = modifierList([...spec.mods, ...modifierList(modifiers)]);
  const mask = modifierMask(names);
  let def = keyDefinition(spec.key);
  if (!isKnownKey(def)) {
    throw new TypeError('planKeyPress: ' + JSON.stringify(String(key)) + ' is not a key. Use a key name (Enter, Tab, '
      + 'ArrowDown, F5 …), one character, or a chord such as "Control+Shift+K" (modifiers: Control/Ctrl, Shift, '
      + 'Alt/Option, Meta/Cmd/Win). To type text, use planType.');
  }
  const times = clamp(Math.round(finite(repeat, 1)), 1, 1000);
  const b = new PlanBuilder('key', profile, rng, { from });
  const K = profile.keyboard;
  const meta = { key: def.key, modifiers: mask, repeat: times };

  if (profile.direct) {
    const d = directDefinition(def);
    for (let r = 0; r < times; r++) {
      b.key(keyFields(!mask && d.text ? 'keyDown' : 'rawKeyDown', d, { modifiers: mask, text: mask ? undefined : d.text }), 0);
      b.key(keyFields('keyUp', d, { modifiers: mask }), 0);
    }
    return b.finish(meta, { end: from ?? null });
  }

  const holdFor = () => Math.round(clamp(rng.logNormal(K.holdMedianMs, K.holdSigma), K.holdMs[0], K.holdMs[1]));
  const ikiFor = () => Math.round(clamp(rng.logNormal(K.ikiMedianMs, K.ikiSigma), K.ikiMs[0], K.ikiMs[1]));

  // A modifier as the main key ("Shift", "Control+Shift") is pressed last, so
  // it is not also one of the held modifiers.
  const selfName = modifierName(def.key);
  const selfBit = own(MODIFIERS, selfName) ?? 0;
  const held = names.filter((n) => n !== selfName);
  const heldMask = modifierMask(held);

  // A modifier on its own ("Shift", "Control").
  if (selfBit && !heldMask) {
    let t = 0;
    for (let r = 0; r < times; r++) {
      if (r) t += ikiFor();
      b.key(keyFields('rawKeyDown', def, { modifiers: selfBit }), t);
      t += holdFor();
      b.key(keyFields('keyUp', def, { modifiers: 0 }), t);
    }
    b.t = t;
    return b.finish(meta, { end: from ?? null });
  }

  if (heldMask) {
    // Letters follow the Shift in the chord, not the case they were written in.
    if (/^[A-Za-z]$/.test(def.key)) def = keyDefinition(heldMask & SHIFT ? def.key.toUpperCase() : def.key.toLowerCase());
    else if (heldMask & SHIFT && shiftedOf(def.key)) def = keyDefinition(shiftedOf(def.key));
    // Only a command modifier makes a shortcut; under Shift alone the key still
    // types its shifted character (Chromium's own rule, and Puppeteer's).
    const text = heldMask & ~SHIFT || selfBit ? undefined : def.text;
    let t = pressModifiers(b, rng, profile, held, 0);
    for (let r = 0; r < times; r++) {
      t += r ? ikiFor() : rng.int(...K.chordGapMs);
      b.key(keyFields(text ? 'keyDown' : 'rawKeyDown', def, { modifiers: heldMask | selfBit, text, unmodifiedText: text }), t);
      t += holdFor();
      b.key(keyFields('keyUp', def, { modifiers: heldMask }), t);
    }
    t = releaseModifiers(b, rng, profile, held, t + rng.int(...K.chordGapMs));
    b.t = t;
    return b.finish(meta, { end: from ?? null });
  }

  if (def.shift && def.text) {
    // '!' or 'A' on its own: typed, with Shift, no think pause.
    const typed = planType(rng, profile, { text: def.text.repeat(times), field: {}, typos: false, from });
    const steps = typed.steps.filter((s) => !(s.kind === 'pause' && s.reason === 'think'));
    const shiftBy = steps.length ? steps[0].at : 0;
    for (const s of steps) b.steps.push({ ...s, at: s.at - shiftBy });
    b.t = typed.durationMs - shiftBy;
    return b.finish(meta, { end: from ?? null });
  }

  let t = 0;
  for (let r = 0; r < times; r++) {
    if (r) t += ikiFor();
    if (def.text && !def.code) {
      // A character with no US key: the same no-physical-key shape planType uses.
      b.key(keyFields('rawKeyDown', def, { modifiers: 0 }), t);
      b.key(keyFields('char', def, { modifiers: 0, text: def.text, unmodifiedText: def.text }), t);
    } else {
      b.key(keyFields(def.text ? 'keyDown' : 'rawKeyDown', def, { modifiers: 0, text: def.text, unmodifiedText: def.text }), t);
    }
    t += holdFor();
    b.key(keyFields('keyUp', def, { modifiers: 0 }), t);
  }
  b.t = t;
  return b.finish(meta, { end: from ?? null });
}
