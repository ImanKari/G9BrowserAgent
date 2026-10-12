/**
 * (3.5) `browser_interact action:"set_value"` and `drag` to a position: set a control to a value
 * and PROVE it changed.
 *
 * Why. A slider ("Audio Influence") and a video cover scrubber did not move for clicks and keys,
 * and nothing said so: the agent learned it when the exported cover came out black (field report).
 * Setting a value is the outcome an agent wants; how to get there depends on the control:
 *
 * | Control | How (trusted input first) | Verified by |
 * |---|---|---|
 * | `<input type=range>` | a click at the value's point on the track, then arrow keys to the exact step | `.value` |
 * | ARIA slider (`role=slider`) | a drag of the thumb to the value's point on its track, then arrow keys (3.6: focused by a real click on the thumb first, sent a few at a time) | `aria-valuenow` |
 * | text field, textarea, contenteditable | `type` with `clear:true` | the field's value |
 * | checkbox, radio, switch | a click when the state differs | `checked` / `aria-checked` |
 * | `<select>` | `select` | the selected option |
 *
 * Only for a native range input, and never at stealth, a value the trusted input could not reach is
 * set by script as a last resort (the native setter + input/change events, which React and Vue
 * observe) — and the result says `via` includes "script", with events that are not trusted.
 *
 * `drag` with `toPercent` (0–100 along the control's track) or `toX`/`toY` (viewport CSS pixels)
 * moves a thumb, a scrubber or any draggable to a position; the result carries the value before and
 * after when the control has one.
 */

import { resolveRef } from '../lib/refs.js';
import { callInWorld } from '../lib/world.js';
import { levelFor } from '../lib/humanize.js';
import * as interact from './interact.js';

const FACTS_FN = `function () {
    const el = this;
    const tag = el.tagName.toLowerCase();
    const type = String(el.type || '').toLowerCase();
    const role = String(el.getAttribute('role') || '').toLowerCase();
    const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
    const box = (r) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
    const r = el.getBoundingClientRect();
    const range = tag === 'input' && type === 'range';
    let track = r;
    if (!range && r.width < 3 * Math.max(r.height, 1) && r.height < 3 * Math.max(r.width, 1)) {
      let p = el.parentElement;
      for (let i = 0; i < 4 && p; i += 1, p = p.parentElement) {
        const pr = p.getBoundingClientRect();
        if (pr.width >= Math.max(3 * r.width, 40) || pr.height >= Math.max(3 * r.height, 40)) { track = pr; break; }
      }
    }
    const toggle = (tag === 'input' && (type === 'checkbox' || type === 'radio')) || ['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio'].includes(role);
    const text = !toggle && (tag === 'textarea' || el.isContentEditable || role === 'textbox' || role === 'searchbox' ||
      (tag === 'input' && !['button', 'submit', 'reset', 'file', 'image', 'color', 'range', 'checkbox', 'radio', 'hidden'].includes(type)));
    const kind = range ? 'range' : role === 'slider' ? 'slider' : toggle ? 'toggle' : tag === 'select' ? 'select' : text ? 'text' : 'other';
    let value = null;
    if (kind === 'range') value = num(el.value);
    else if (kind === 'slider') value = num(el.getAttribute('aria-valuenow'));
    else if (kind === 'toggle') value = tag === 'input' ? !!el.checked : el.getAttribute('aria-checked') === 'true';
    else if (kind === 'select') value = el.multiple ? [...el.selectedOptions].map((o) => o.value) : el.value;
    else if (kind === 'text') value = el.isContentEditable ? el.innerText : el.value;
    const min = range ? (num(el.min) ?? 0) : (num(el.getAttribute('aria-valuemin')) ?? 0);
    const max = range ? (num(el.max) ?? 100) : (num(el.getAttribute('aria-valuemax')) ?? 100);
    const step = range ? (el.step === 'any' ? null : (num(el.step) ?? 1)) : null;
    const vertical = el.getAttribute('aria-orientation') === 'vertical' || (track.height > track.width * 2);
    return { kind, tag, type, role, value, min, max, step, vertical, el: box(r), track: box(track), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' };
  }`;

/** The script fallback for a native range input: the prototype setter (frameworks track the instance one) + events. */
const SCRIPT_SET_FN = `function (v) {
    const proto = Object.getPrototypeOf(this);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    desc.set.call(this, String(v));
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return this.value;
  }`;

/**
 * (3.6) Is focus on this control (or inside it)? And where is it, in words, for the error when it
 * is not — keys go to whatever has focus, and "the slider did not move" said nothing about why.
 */
const FOCUS_FN = `function () {
    const d = this.ownerDocument;
    let a = d.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    const focused = !!a && (a === this || (typeof this.contains === 'function' && this.contains(a)));
    let where = 'nothing';
    if (a === d.body || !a) where = 'the page itself (no element had focus)';
    else {
      const label = String(a.getAttribute && (a.getAttribute('aria-label') || a.getAttribute('title')) || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
      const role = a.getAttribute && a.getAttribute('role');
      where = '<' + String(a.tagName || '?').toLowerCase() + (a.id ? '#' + a.id : '') + (role ? ' role=' + role : '') + '>' + (label ? ' "' + label + '"' : '');
    }
    return { focused, where };
  }`;

/** How many arrow keys an ARIA slider gets before its value is read again. */
const KEY_BATCH = 5;

/** Range input thumb width in CSS px (Chromium's default track thumb). */
const RANGE_THUMB = 16;
const MAX_KEYS = 200;

/** Bring the control on screen first: a wheel reach at human/stealth, a plain scroll at "off". */
async function reach(tabId, node, opts) {
  const r = await interact.bringIntoView(tabId, node, opts).catch(() => null);
  if (r?.level === 'off' || !r) {
    await callInWorld(tabId, node.backendNodeId, 'function () { this.scrollIntoView({ block: "center", inline: "center" }); }').catch(() => {});
  }
}

async function facts(tabId, node) {
  if (node.sessionId) throw new Error('set_value and drag-to-a-position work on elements of the top document, not inside a cross-origin frame. Use click/type/key there.');
  const f = await callInWorld(tabId, node.backendNodeId, FACTS_FN);
  if (!f) throw new Error('Could not read the element (it may have been removed). Take a fresh browser_snapshot.');
  return f;
}

/** Where on the track a fraction 0..1 lies, in viewport CSS pixels. */
function pointAt(f, fraction) {
  const t = Math.max(0, Math.min(1, fraction));
  const inset = f.kind === 'range' ? Math.min(RANGE_THUMB, f.track.w, f.track.h * 2) / 2 : 0;
  if (f.vertical) {
    // Vertical sliders grow upwards.
    const usable = Math.max(1, f.track.h - 2 * inset);
    return { x: f.track.x + f.track.w / 2, y: f.track.y + f.track.h - inset - t * usable };
  }
  const usable = Math.max(1, f.track.w - 2 * inset);
  return { x: f.track.x + inset + t * usable, y: f.track.y + f.track.h / 2 };
}

const fractionOf = (f, v) => (f.max > f.min ? (Number(v) - f.min) / (f.max - f.min) : 0);

function closeEnough(f, value, target) {
  if (value == null) return false;
  const tolerance = f.step ? f.step / 2 : Math.max(1e-9, (f.max - f.min) * 0.005);
  return Math.abs(Number(value) - Number(target)) <= tolerance + 1e-9;
}

/** Arrow keys towards the target: one key measures the step, the rest follow. → the value after. */
async function keyToward(tabId, ref, f, target, read, opts) {
  let now = await read();
  if (closeEnough(f, now, target)) return now;
  const up = f.vertical ? 'ArrowUp' : 'ArrowRight';
  const down = f.vertical ? 'ArrowDown' : 'ArrowLeft';
  const dir = Number(target) > Number(now) ? up : down;
  await interact.key(tabId, { ...opts, ref, key: dir });
  const after = await read();
  const step = Math.abs(Number(after) - Number(now));
  now = after;
  if (closeEnough(f, now, target) || !(step > 0)) return now;
  const n = Math.min(MAX_KEYS, Math.round(Math.abs(Number(target) - Number(now)) / step));
  if (n > 0) {
    await interact.key(tabId, { ...opts, ref, key: Number(target) > Number(now) ? up : down, repeat: n });
    now = await read();
  }
  return now;
}

/**
 * (3.6) Focus a custom (ARIA) slider the way a person does: a real click on its thumb where it is
 * now — so the value does not jump — and, when even that leaves focus elsewhere, element.focus().
 * → { focused, how, where }
 */
async function focusSlider(tabId, node, f, current, opts) {
  const now = await callInWorld(tabId, node.backendNodeId, FOCUS_FN).catch(() => null);
  if (now?.focused) return { focused: true, how: null, where: now.where };
  // The element is the thumb when it is smaller than its track; otherwise click the track where
  // the value already is.
  const isThumb = f.el.w * f.el.h > 0 && (f.el.w < f.track.w * 0.6 || f.el.h < f.track.h * 0.6);
  const at = isThumb ? { x: f.el.x + f.el.w / 2, y: f.el.y + f.el.h / 2 } : pointAt(f, fractionOf(f, current ?? f.min));
  await interact.click(tabId, { ...opts, x: at.x, y: at.y }).catch(() => {});
  let after = await callInWorld(tabId, node.backendNodeId, FOCUS_FN).catch(() => null);
  if (after?.focused) return { focused: true, how: 'click on the thumb', where: after.where };
  await callInWorld(tabId, node.backendNodeId, 'function () { this.focus && this.focus(); }').catch(() => {});
  after = await callInWorld(tabId, node.backendNodeId, FOCUS_FN).catch(() => null);
  return { focused: !!after?.focused, how: after?.focused ? 'focus()' : null, where: after?.where ?? 'unknown' };
}

/**
 * (3.6) Arrow keys to an ARIA slider a few at a time, its value read again after each batch: a
 * custom slider's step can change along the track, keys can accelerate, and a value that stops
 * moving ends the attempt instead of sending the remaining 200 keys into the void. → the value after.
 */
async function keyInBatches(tabId, f, target, read, opts) {
  const up = f.vertical ? 'ArrowUp' : 'ArrowRight';
  const down = f.vertical ? 'ArrowDown' : 'ArrowLeft';
  let now = await read();
  let step = null;
  let stalls = 0;
  let turns = 0;
  let lastDir = null;
  for (let sent = 0; sent < MAX_KEYS && !closeEnough(f, now, target);) {
    const dir = Number(target) > Number(now) ? up : down;
    if (lastDir && dir !== lastDir && ++turns > 3) break; // it overshoots back and forth: stop
    const n = step ? Math.max(1, Math.min(KEY_BATCH, Math.round(Math.abs(Number(target) - Number(now)) / step))) : 1;
    await interact.key(tabId, { ...opts, key: dir, repeat: n });
    sent += n;
    const after = await read();
    const moved = Math.abs(Number(after) - Number(now));
    if (after == null || !(moved > 0)) {
      if (++stalls >= 2) { now = after; break; }
    } else {
      stalls = 0;
      step = moved / n;
    }
    lastDir = dir;
    now = after;
  }
  return now;
}

/**
 * browser_interact action:"set_value" { ref, value }.
 * → { set, kind, before, after, target, verified, via:[…], note? }
 */
export async function setValue(tabId, opts = {}) {
  const { ref, url } = opts;
  if (!ref) throw new Error('set_value needs a target: ref, role (+ name), or selector.');
  if (opts.value === undefined) throw new Error('set_value needs a value (a number for a slider, true/false for a checkbox or switch, text for a field, an option for a select).');
  const node = await resolveRef(tabId, ref, url);
  await reach(tabId, node, opts);
  let f = await facts(tabId, node);
  if (f.disabled) throw new Error(`The ${f.kind === 'other' ? f.tag : f.kind} is disabled; nothing was changed.`);
  const before = f.value;
  const via = [];
  const pass = { humanize: opts.humanize, seed: opts.seed, url };
  const read = async () => (await facts(tabId, node)).value;

  if (f.kind === 'text') {
    await interact.type(tabId, { ...pass, ref, text: String(opts.value), clear: true });
    const after = await read();
    return done({ kind: f.kind, before, after, target: String(opts.value), verified: String(after ?? '') === String(opts.value), via: ['type'] });
  }
  if (f.kind === 'select') {
    await interact.select(tabId, { ...pass, ref, values: opts.value });
    const after = await read();
    const wanted = (Array.isArray(opts.value) ? opts.value : [opts.value]).map(String);
    const got = (Array.isArray(after) ? after : [after]).map(String);
    return done({ kind: f.kind, before, after, target: opts.value, verified: wanted.every((w) => got.includes(w)), via: ['select'] });
  }
  if (f.kind === 'toggle') {
    const want = opts.value === true || opts.value === 'true' || opts.value === 1 || opts.value === 'on';
    if (before !== want) {
      await interact.click(tabId, { ...pass, ref });
      via.push('click');
    }
    const after = await read();
    return done({ kind: f.kind, before, after, target: want, verified: after === want, via });
  }
  if (f.kind !== 'range' && f.kind !== 'slider') {
    throw new Error(`set_value does not know how to set this element (<${f.tag}${f.role ? ` role=${f.role}` : ''}>): it is not a field, select, checkbox, switch or slider. Use type, click or drag (drag takes toPercent).`);
  }

  // Sliders.
  const target = Number(opts.value);
  if (!Number.isFinite(target)) throw new Error(`A slider takes a number; got ${JSON.stringify(opts.value)}.`);
  if (target < f.min || target > f.max) throw new Error(`${target} is outside this slider's range (${f.min}..${f.max}); nothing was changed.`);
  const hz = await levelFor(tabId, opts);
  const point = pointAt(f, fractionOf(f, target));
  if (!closeEnough(f, before, target)) {
    if (f.kind === 'range') {
      await interact.click(tabId, { ...pass, x: point.x, y: point.y });
      via.push('click on the track');
    } else {
      await interact.drag(tabId, { ...pass, from: ref, toPoint: point });
      via.push('drag');
    }
    f = await facts(tabId, node);
  }
  let after = f.value;
  let focus = null;
  if (!closeEnough(f, after, target)) {
    if (f.kind === 'slider') {
      // Keys go to whatever has focus, and a drag does not focus every custom slider (3.6).
      focus = await focusSlider(tabId, node, f, after, pass);
      if (focus.how) via.push(focus.how);
      after = await keyInBatches(tabId, f, target, read, pass);
    } else {
      after = await keyToward(tabId, ref, f, target, read, pass);
    }
    via.push('arrow keys');
  }
  if (!closeEnough(f, after, target) && f.kind === 'range' && hz.level !== 'stealth') {
    after = Number(await callInWorld(tabId, node.backendNodeId, SCRIPT_SET_FN, [target]));
    via.push('script');
  }
  const verified = closeEnough(f, after, target);
  // Unverified: where focus was when the keys went out — the first thing to know (3.6).
  const focusNow = !verified && f.kind === 'slider' ? await callInWorld(tabId, node.backendNodeId, FOCUS_FN).catch(() => null) : null;
  return done({
    kind: f.kind, before, after, target, verified, via,
    ...(focusNow ? { focus: focusNow.focused ? 'on the slider' : focusNow.where } : {}),
    ...(via.includes('script') ? { note: 'Trusted input did not reach the value, so it was set by script: the page saw input/change events that are not trusted (isTrusted false).' } : {}),
  });
}

function done(r) {
  if (!r.verified) {
    const err = new Error(
      `The ${r.kind} did not take the value: wanted ${JSON.stringify(r.target)}, it is ${JSON.stringify(r.after)} (was ${JSON.stringify(r.before)}) after ${r.via.join(', ') || 'nothing'}. ` +
        `${r.focus ? `Keyboard focus was on ${r.focus} when the keys were sent. ` : ''}The control may ignore this kind of input, or clamp or round the value.`,
    );
    err.result = r;
    err.errorCode = 'not_verified';
    throw err;
  }
  return { set: true, ...r };
}

/**
 * browser_interact action:"drag" with `toPercent` (0..100 along the control's track) or `toX`/`toY`
 * (viewport CSS pixels): drag the element there. → the drag's result + { before, after, changed } when
 * the control has a value.
 */
export async function dragTo(tabId, opts = {}) {
  const ref = opts.from ?? opts.ref;
  if (!ref) throw new Error('drag needs from (or ref): the element to drag.');
  const node = await resolveRef(tabId, ref, opts.url);
  await reach(tabId, node, opts);
  const f = await facts(tabId, node);
  let point;
  if (opts.toPercent != null) {
    const pct = Number(opts.toPercent);
    if (!(pct >= 0 && pct <= 100)) throw new Error('toPercent is 0..100.');
    point = pointAt(f, pct / 100);
  } else {
    if (opts.toX == null || opts.toY == null) throw new Error('drag needs to (a ref), toPercent, or toX and toY.');
    point = { x: Number(opts.toX), y: Number(opts.toY) };
  }
  const { toPercent, toX, toY, ref: _r, ...rest } = opts;
  const out = await interact.drag(tabId, { ...rest, from: ref, toPoint: point });
  const after = await callInWorld(tabId, node.backendNodeId, FACTS_FN).then((x) => x?.value ?? null, () => null);
  return {
    ...out,
    to: { x: Math.round(point.x), y: Math.round(point.y), ...(toPercent != null ? { percent: Number(toPercent) } : {}) },
    ...(f.value != null || after != null ? { before: f.value, after, changed: JSON.stringify(f.value) !== JSON.stringify(after) } : {}),
  };
}
