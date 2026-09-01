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

import { send, callOnNode, evaluate } from '../lib/cdp.js';
import { resolveRef } from '../lib/refs.js';

/** Modifier bitmask used by CDP: Alt=1, Ctrl=2, Meta=4, Shift=8 */
export const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export function modifierMask(list = []) {
  return list.reduce((m, name) => m | (MODIFIERS[name] ?? 0), 0);
}

/**
 * Select-all is Cmd+A on macOS and Ctrl+A everywhere else. The service worker
 * has a navigator, so ask rather than assume — a hardcoded Control silently
 * fails to clear a field on a Mac, and type({clear:true}) then appends instead
 * of replacing.
 */
const SELECT_ALL_MODIFIER = /Mac/i.test(globalThis.navigator?.userAgent ?? '')
  ? MODIFIERS.Meta
  : MODIFIERS.Control;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ input witness

/**
 * Proof that an input event actually reached the page.
 *
 * Chromium SILENTLY DISCARDS `Input.dispatch*Event` for a page that is not
 * visible in a headed browser. No error is raised, the CDP command resolves
 * normally, and nothing happens. Every action here used to return an echo of
 * its own arguments — `{ typed: "admin" }` for a field that stayed empty —
 * which is the worst failure this toolset can produce: the agent proceeds,
 * builds on a login that never happened, and reports success to the user.
 *
 * It is not reproducible headless (a headless surface is always paintable), so
 * the automated live suite could never catch it. It IS the normal case for the
 * product's own headline workflow: pinned mode exists so the user can browse
 * elsewhere, and browsing elsewhere is exactly what makes the pinned tab
 * hidden.
 *
 * So every dispatching action now witnesses its own event. The witness is a
 * capture-phase listener installed once per document; it counts only trusted
 * events, so it cannot be satisfied by the page's own synthetic ones.
 *
 * Note what is deliberately NOT verified: the resulting VALUE. Per-character
 * typing of "12ab34" into a digit-only field correctly lands "1234" — a page
 * rejecting keys is the page behaving, not a failure (see the v1.0.15 entry).
 * The honest question is "did the input reach the page at all", and that is
 * what this answers. The value that resulted is reported, never asserted.
 */
// 'wheel' is deliberately absent: Chromium may handle it entirely on the
// compositor, so its absence proves nothing. scroll() checks its outcome.
/**
 * Watch, from inside the page, for a trusted event of the given kinds.
 *
 * Armed and read in a SINGLE evaluate, deliberately. The first version
 * installed a counting listener in one call and read the counter in a later
 * one, which quietly assumes both land in the same JavaScript execution
 * context. On a single-page application they do not: Instagram swaps context
 * as its router moves, so the listener that was watching is simply GONE by the
 * time the counter is read, the count is zero, and a caption that typed
 * perfectly is reported as a failure.
 *
 * That is the exact inverse of the bug this mechanism exists to prevent, and it
 * is just as damaging — an agent that believes a working action failed will
 * retry it, and retrying a click is how you post something twice.
 *
 * A promise that lives entirely inside one evaluate cannot be split that way.
 * If the context does disappear the evaluate rejects, which resolves to `null`
 * — "cannot tell" — and `null` never accuses anyone.
 *
 * Do NOT await the returned promise before dispatching. Arm, act, then await.
 */
async function watchForInput(tabId, types, timeoutMs) {
  // Two CDP calls, and the split is the whole point.
  //
  // `Runtime.evaluate` with awaitPromise:false returns as soon as the
  // expression has RUN — which is after addEventListener, because everything
  // up to the first await is synchronous. So by the time this function
  // returns, the page is definitely listening, and the caller can dispatch
  // knowing nothing can slip past.
  //
  // Awaiting the promise itself here instead would be a race the other way:
  // the listener would go in, but the caller could not act until the event it
  // is waiting for had already happened.
  let handle;
  try {
    handle = await send(tabId, 'Runtime.evaluate', {
      expression: `new Promise((resolve) => {
         const kinds = ${JSON.stringify(types)};
         let settled = false;
         const finish = (value) => {
           if (settled) return;
           settled = true;
           for (const kind of kinds) removeEventListener(kind, onEvent, true);
           resolve(value);
         };
         // Only trusted events count: a page firing its own synthetic input
         // must not be able to vouch for us.
         const onEvent = (event) => { if (event.isTrusted) finish(true); };
         for (const kind of kinds) addEventListener(kind, onEvent, { capture: true, passive: true });
         setTimeout(() => finish(false), ${timeoutMs});
       })`,
      awaitPromise: false,
      returnByValue: false,
    });
  } catch {
    return () => Promise.resolve(null); // cannot watch: never accuse
  }

  const promiseObjectId = handle?.result?.objectId;
  if (!promiseObjectId) return () => Promise.resolve(null);

  return async () => {
    try {
      const settled = await send(tabId, 'Runtime.awaitPromise', {
        promiseObjectId,
        returnByValue: true,
      });
      return settled?.result?.value ?? null;
    } catch {
      // The context went away — a navigation, a router move. We genuinely
      // cannot tell what the page saw, and `null` never accuses anyone.
      return null;
    } finally {
      send(tabId, 'Runtime.releaseObject', { objectId: promiseObjectId }).catch(() => {});
    }
  };
}

/**
 * Turn "nothing happened" into the sentence that names the fix.
 *
 * Visibility is asked for only on the failure path, so the common case pays
 * nothing for it.
 */
async function explainNoInput(tabId, action) {
  const page = await evaluate(
    tabId,
    '({ hidden: document.hidden, state: document.visibilityState })',
  ).catch(() => null);

  if (page?.hidden) {
    return (
      `The ${action} was dispatched but the page never received it: the attached tab is HIDDEN ` +
      `(document.visibilityState="${page.state}"). A headed Chromium silently discards CDP input ` +
      `events for a page that is not visible — no error is raised, so nothing was done even though ` +
      `the command succeeded. Ask the user to bring that tab to the foreground, and make sure its ` +
      `window is neither minimised nor fully covered by another window. Reading tools ` +
      `(browser_snapshot, browser_inspect, browser_console, browser_network) keep working while hidden.`
    );
  }
  return (
    `The ${action} was dispatched but the page never received a trusted event for it, although the ` +
    `page reports it is visible. Something is intercepting input before the document — a native ` +
    `dialog, a modal the browser owns, or a devtools overlay. Take a browser_screenshot to see the ` +
    `current state.`
  );
}

/**
 * How long the page waits for the event before giving up.
 *
 * Generous, because the wait runs INSIDE the page and in parallel with the
 * action — a successful dispatch resolves it immediately and pays nothing, so
 * the only thing a larger budget costs is a slower answer in the failing case.
 * A long `Input.insertText` on a heavy editor needs more than a few hundred
 * milliseconds to come back through the event loop.
 */
const WITNESS_TIMEOUT_MS = 1500;

/**
 * Dispatch, then require proof the page saw it.
 *
 * `verify` is an optional last word: some actions can observe their own OUTCOME
 * directly, and an outcome outranks any opinion about events. Typing uses it,
 * because a field that now holds the text is not open to argument.
 */
async function witnessed(tabId, expect, action, run, verify = null) {
  const kinds = Array.isArray(expect) ? expect : [expect];
  // Awaited: this only installs the listener, it does not wait for the event.
  const settled = await watchForInput(tabId, kinds, WITNESS_TIMEOUT_MS);
  const result = await run();
  const saw = await settled();

  if (saw === false) {
    if (verify && (await verify().catch(() => false))) return result;
    throw new Error(await explainNoInput(tabId, action));
  }
  return result; // true, or null meaning "cannot tell" — never accuse on null
}

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
      // DOM.getBoxModel answers in TOP-LEVEL viewport coordinates, already
      // including any frame offset. That is the space Input.dispatch*Event
      // wants, and it is NOT the space an in-page getBoundingClientRect()
      // answers in when the element lives in an iframe. See frameOffset().
      space: 'viewport',
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
  // This one came from inside the element's own frame, so it is frame-relative.
  const offset = await frameOffset(tabId, backendNodeId);
  return { ...rect, x: rect.x + offset.x, y: rect.y + offset.y, space: 'viewport' };
}

/**
 * Where this element's frame sits in the top-level viewport.
 *
 * `Runtime.callFunctionOn` runs in the realm that owns the node, so for an
 * element inside a same-origin iframe every in-page measurement is relative to
 * THAT frame's viewport — while `Input.dispatch*Event` and
 * `document.elementsFromPoint` on the top document both speak top-level
 * coordinates. Mixing the two put clicks, and the obstruction check, at the
 * wrong point for anything inside an iframe. v1.3.0 taught the locators to walk
 * same-origin iframes, which is what made that reachable.
 *
 * Walking `frameElement` up to the top window keeps this correct for nested
 * frames too, and returns {0,0} for the common case of a top-level element.
 */
function frameOffset(tabId, backendNodeId) {
  return callOnNode(
    tabId,
    backendNodeId,
    `function () {
       let x = 0, y = 0;
       let view = this.ownerDocument && this.ownerDocument.defaultView;
       for (let depth = 0; view && view !== view.parent && depth < 10; depth++) {
         let frame = null;
         try { frame = view.frameElement; } catch (e) { break; } // cross-origin
         if (!frame) break;
         const r = frame.getBoundingClientRect();
         x += r.left;
         y += r.top;
         view = view.parent;
       }
       return { x, y };
     }`,
  ).catch(() => ({ x: 0, y: 0 }));
}

/**
 * Warn when a different element would actually receive the click.
 *
 * The obvious implementation — `elementFromPoint(x,y)`, pass if it is the
 * target, a descendant, *or an ancestor* — has a false negative that matters,
 * because the ancestor case is not symmetric with the descendant one:
 *
 *   - a DESCENDANT on top (a <span> inside the button) is fine: the event
 *     fires on it and bubbles up to the target.
 *   - an ANCESTOR on top means the target is covered. The event fires on the
 *     ancestor and bubbles *away* from the target, which never sees it.
 *
 * An ancestor lands on top most often because of a `::before`/`::after`
 * overlay. `elementFromPoint` never returns a pseudo-element — it returns the
 * element that generated it — so a click-swallowing `.cover::after { inset:0 }`
 * looked exactly like a harmless wrapper, and the click was allowed through.
 * That is the silent misclick this function exists to prevent.
 *
 * `elementsFromPoint` (plural) gives the whole hit-test stack, so we can ask
 * the real question: will a click at this point reach the target? The only
 * ancestor that legitimately forwards activation is a <label>, so that stays
 * allowed explicitly rather than by accident.
 */
async function checkObscured(tabId, backendNodeId, x, y) {
  const verdict = await callOnNode(
    tabId,
    backendNodeId,
    `function (px, py) {
       // px/py arrive in TOP-LEVEL viewport coordinates (see pointFor), but
       // this function runs in the realm that owns the node, so a hit test has
       // to be done in THIS frame's coordinates. Undo the frame offset.
       const doc = this.ownerDocument;
       let view = doc && doc.defaultView;
       for (let depth = 0; view && view !== view.parent && depth < 10; depth++) {
         let frame = null;
         try { frame = view.frameElement; } catch (e) { break; }
         if (!frame) break;
         const fr = frame.getBoundingClientRect();
         px -= fr.left;
         py -= fr.top;
         view = view.parent;
       }

       const stack = doc.elementsFromPoint(px, py);
       if (!stack.length) return { ok: false, reason: 'the point is outside the viewport' };

       const top = stack[0];
       if (top === this || this.contains(top)) return { ok: true };

       // A <label> hands its activation to the control it labels.
       if (top.tagName === 'LABEL' && (top.control === this || (this.id && top.htmlFor === this.id))) {
         return { ok: true };
       }

       const describe = (el) => {
         let s = el.tagName.toLowerCase();
         if (el.id) s += '#' + el.id;
         if (typeof el.className === 'string' && el.className.trim()) {
           s += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
         }
         return s;
       };

       // Naming the ancestor alone reads as nonsense ("covered by its own
       // container"), so say what is actually painting over it.
       if (top.contains(this)) {
         const pseudo = ['::after', '::before'].find((p) => {
           const s = getComputedStyle(top, p);
           return s && s.content !== 'none' && s.position === 'absolute' && s.pointerEvents !== 'none';
         });
         return {
           ok: false,
           reason:
             'it is covered by its ancestor <' + describe(top) + '>' +
             (pseudo
               ? ', whose ' + pseudo + ' pseudo-element is painted over it (a click-shield overlay)'
               : ', which paints something over it'),
         };
       }

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

  await witnessed(tabId, 'mousedown', `${clickCount > 1 ? 'double ' : ''}click`, async () => {
    await mouse(tabId, 'mouseMoved', point.x, point.y, { button: 'none', modifiers });
    for (let i = 1; i <= clickCount; i++) {
      await mouse(tabId, 'mousePressed', point.x, point.y, { button, clickCount: i, modifiers });
      await mouse(tabId, 'mouseReleased', point.x, point.y, { button, clickCount: i, modifiers });
    }
  });

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
  await witnessed(tabId, 'mousemove', 'hover', () =>
    mouse(tabId, 'mouseMoved', point.x, point.y, { button: 'none' }),
  );
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

  let node = null;
  if (ref) {
    node = await resolveRef(tabId, ref, url);
    const point = await pointFor(tabId, node.backendNodeId);
    await mouse(tabId, 'mouseMoved', point.x, point.y, { button: 'none' });
    await mouse(tabId, 'mousePressed', point.x, point.y, {});
    await mouse(tabId, 'mouseReleased', point.x, point.y, {});
    await send(tabId, 'DOM.focus', { backendNodeId: node.backendNodeId }).catch(() => {});
  }

  if (clear) {
    if (node) {
      // Select through the DOM, not Ctrl+A.
      //
      // Key-filtered fields — numeric inputs are full of them — commonly do
      // `if (e.key.length === 1 && !/[0-9]/.test(e.key)) e.preventDefault()`,
      // which swallows the "a" of the chord and leaves the old value selected
      // by nothing. The typing that followed then APPENDED to the old value
      // while the result still claimed `cleared: true`.
      //
      // Selecting is not an edit, so doing it directly costs nothing the
      // framework needs to observe: the Delete below is still a real trusted
      // key event, and that is what produces the input/change events.
      await callOnNode(
        tabId,
        node.backendNodeId,
        `function () {
           if (typeof this.select === 'function') return this.select();
           const r = document.createRange();
           r.selectNodeContents(this);
           const s = getSelection();
           s.removeAllRanges();
           s.addRange(r);
         }`,
      ).catch(() => {});
    } else {
      await key(tabId, { key: 'a', modifiers: SELECT_ALL_MODIFIER });
    }
    await key(tabId, { key: 'Delete' });

    // Verify, rather than assume. A clear that silently fails turns "replace"
    // into "append", and the agent has no way to see it in the result.
    if (node) {
      const left = await readValue(tabId, node.backendNodeId);
      if (left) {
        throw new Error(
          `Could not clear "${node.name || ref}" — it still contains ${JSON.stringify(truncateValue(left))}. ` +
            `The page is intercepting the deletion. Nothing was typed, because typing now would append ` +
            `to the old value instead of replacing it.`,
        );
      }
    }
  }

  // Only the typing itself is witnessed, and only when there is something to
  // type: an empty string legitimately produces no events, and accusing the
  // page of swallowing input it was never sent would be its own false report.
  const emit = async () => {
  if (fast) {
    await send(tabId, 'Input.insertText', { text });
  } else {
    for (const ch of [...text]) {
      if (ch === '\n') {
        await dispatchKey(tabId, { key: 'Enter' });
        continue;
      }
      // code and keyCode matter as much as text here: key-filtered numeric
      // inputs and masked fields read event.code / event.keyCode, and sending
      // the character alone is exactly what per-character mode exists to avoid.
      const def = keyDefinition(ch);
      await send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: ch,
        key: def.key,
        unmodifiedText: ch,
        ...physicalKey(def),
      });
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, ...physicalKey(def) });
      if (delayMs) await sleep(delayMs);
    }
  }
  };

  if (text.length) {
    // insertText raises `input` with no keydown; per-character mode raises
    // both. Either one proves the page is receiving input.
    //
    // The `verify` arm is what makes this safe on a single-page app: if the
    // field's contents changed, the typing plainly landed, whatever the event
    // watcher managed to observe. Reading the value is cheap and it is the
    // outcome the caller actually cares about.
    const before = node ? await readValue(tabId, node.backendNodeId) : null;
    await witnessed(
      tabId,
      ['keydown', 'input'],
      'typing',
      emit,
      node ? async () => (await readValue(tabId, node.backendNodeId)) !== before : null,
    );
  } else {
    await emit();
  }

  if (pressEnter) await key(tabId, { key: 'Enter' });

  // What actually landed. Reported, never asserted: a digit-only field that
  // rejects the letters of "12ab34" and keeps "1234" is the page working
  // correctly, and the agent needs to see the difference rather than have it
  // called a failure. See the v1.0.15 change-log entry.
  const value = node ? await readValue(tabId, node.backendNodeId) : null;

  return {
    typed: text.length > 60 ? `${text.slice(0, 57)}…` : text,
    cleared: clear,
    pressedEnter: pressEnter,
    ...(node ? { value: truncateValue(value) } : {}),
    ...(node && String(value ?? '') !== text && !pressEnter
      ? { note: 'The field does not hold exactly what was typed — the page filtered or reformatted it.' }
      : {}),
  };
}

/** Current text of a field, for verifying an edit actually happened. */
function readValue(tabId, backendNodeId) {
  return callOnNode(
    tabId,
    backendNodeId,
    `function () { return this.value != null ? this.value : (this.textContent || ''); }`,
  ).catch(() => '');
}

function truncateValue(s) {
  const str = String(s);
  return str.length > 40 ? `${str.slice(0, 39)}…` : str;
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

/** Physical `code` and legacy keyCode for the printable US-layout keys. */
const PUNCTUATION = {
  '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219],
  ']': ['BracketRight', 221], '\\': ['Backslash', 220], ';': ['Semicolon', 186],
  "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190],
  '/': ['Slash', 191], '`': ['Backquote', 192], ' ': ['Space', 32],
};

/**
 * Build a CDP key descriptor for an arbitrary key name.
 *
 * `code` is the PHYSICAL key, and it does not follow from the character the
 * obvious way: '1' is Digit1 (not Key1) and F5 is F5 (not KeyF5). The previous
 * `Key${name.toUpperCase()}` produced garbage for every digit, symbol, and
 * function key — and pages that filter numeric input read exactly event.code
 * and event.keyCode, so it silently broke the inputs that most need real key
 * events. Where a value cannot be known honestly, it is omitted: a fabricated
 * keyCode is worse than none.
 */
function keyDefinition(name) {
  if (KEY_MAP[name]) return KEY_MAP[name];
  const s = String(name);

  if (/^F([1-9]|1[0-2])$/.test(s)) {
    return { key: s, code: s, keyCode: 111 + Number(s.slice(1)) };
  }

  if (s.length === 1) {
    if (/[a-zA-Z]/.test(s)) {
      return { key: s, code: `Key${s.toUpperCase()}`, keyCode: s.toUpperCase().charCodeAt(0), text: s };
    }
    if (/[0-9]/.test(s)) {
      return { key: s, code: `Digit${s}`, keyCode: s.charCodeAt(0), text: s };
    }
    const punct = PUNCTUATION[s];
    if (punct) return { key: s, code: punct[0], keyCode: punct[1], text: s };
    // Shifted symbols and non-ASCII (Persian, emoji): send the character with
    // no physical code rather than inventing one.
    return { key: s, text: s };
  }

  // An unknown multi-character name — "F13", "AudioVolumeUp". Pass it through.
  return { key: s, code: s };
}

/** Only emit code/keyCode when they are actually known. */
function physicalKey(def) {
  return {
    ...(def.code ? { code: def.code } : {}),
    ...(def.keyCode != null
      ? { windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode }
      : {}),
  };
}

/**
 * Named keys and chords: Enter, Tab, Escape, ArrowDown, Control+s …
 *
 * Witnessed at this level only. `dispatchKey` is the unwitnessed primitive,
 * because `type()` and `select()` already run inside their own witness or their
 * own verification — and arming a nested witness would RESET the counter the
 * outer one is about to read, turning a working action into a false failure.
 */
export async function key(tabId, opts = {}) {
  return witnessed(tabId, 'keydown', `key "${opts.key}"`, () => dispatchKey(tabId, opts));
}

async function dispatchKey(tabId, { key: name, modifiers = 0, repeat = 1 } = {}) {
  const def = keyDefinition(name);

  for (let i = 0; i < repeat; i++) {
    await send(tabId, 'Input.dispatchKeyEvent', {
      // A chord (Ctrl+S) must be rawKeyDown with no text, or the page receives
      // a literal character instead of the shortcut.
      type: !modifiers && def.text ? 'keyDown' : 'rawKeyDown',
      key: def.key,
      ...physicalKey(def),
      text: modifiers ? undefined : def.text,
      modifiers,
    });
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      ...physicalKey(def),
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

  // Scroll checks its OUTCOME, not a `wheel` event.
  //
  // Wheel is the one input Chromium may handle entirely on the compositor
  // thread, so a scroll that works perfectly can produce no DOM `wheel` event
  // for a listener to see. Witnessing it reported working scrolls as failures,
  // and the retry loop that hid that made it worse: during an active screencast
  // the extra round trips competed with frame ingestion until the call timed
  // out. The scroll position is the honest signal and costs two evaluates.
  const before = await evaluate(tabId, '({ x: scrollX, y: scrollY })').catch(() => null);

  // A wheel dispatch can wedge, and does so reproducibly while a screencast is
  // running: `Page.startScreencast` is active, `Input.dispatchMouseEvent` with
  // `mouseWheel` is accepted, and the promise never settles. Recording a bug
  // while scrolling through it is not an exotic thing to do — it is the
  // ordinary way someone reports a scrolling bug — so this falls back rather
  // than failing, and says which one it used.
  let via = 'wheel';
  try {
    await send(
      tabId,
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: px, y: py, deltaX, deltaY, pointerType: 'mouse' },
      { timeoutMs: 4000 },
    );
  } catch (err) {
    if (!/did not return after/.test(String(err?.message ?? err))) throw err;
    await evaluate(tabId, `scrollBy(${Number(deltaX) || 0}, ${Number(deltaY) || 0})`);
    via = 'programmatic';
  }

  const after = await evaluate(
    tabId,
    '({ x: scrollX, y: scrollY, hidden: document.hidden })',
  ).catch(() => null);

  const moved = !!before && !!after && (after.x !== before.x || after.y !== before.y);

  // Only accuse the browser when the page also could not have received it.
  // A page already at its edge legitimately does not move.
  if (!moved && after?.hidden) throw new Error(await explainNoInput(tabId, 'scroll'));

  return {
    scrolled: direction,
    amount,
    moved,
    via,
    ...(after ? { position: { x: after.x, y: after.y } } : {}),
    ...(via === 'programmatic'
      ? {
          note: 'The browser stopped answering wheel events — this happens while a tab video ' +
            'recording is running — so the page was scrolled programmatically instead. The page ' +
            'moved, but no wheel event was fired, so anything driven by wheel (custom zoom, ' +
            'carousels, infinite-scroll hooks) will not have reacted.',
        }
      : moved
        ? {}
        : {
            note: 'The page did not move. It may already be at that edge, or the thing that scrolls ' +
              'is an inner container rather than the document — pass a ref inside it.',
          }),
  };
}

export async function drag(tabId, { from, to, url, steps = 12 } = {}) {
  const a = await resolveRef(tabId, from, url);
  const b = await resolveRef(tabId, to, url);
  const pa = await pointFor(tabId, a.backendNodeId);
  const pb = await pointFor(tabId, b.backendNodeId);

  await witnessed(tabId, 'mousedown', 'drag', async () => {
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
  });
  return { dragged: `${a.name || from} -> ${b.name || to}` };
}

/** Select <option>s by value, label, or visible text. */
export async function select(tabId, { ref, values, url } = {}) {
  const node = await resolveRef(tabId, ref, url);
  const wanted = (Array.isArray(values) ? values : [values]).map(String);
  const plan = await callOnNode(
    tabId,
    node.backendNodeId,
    `function (wanted) {
       if (this.tagName !== 'SELECT') return { ok: false, reason: 'the element is not a <select>' };
       const options = [...this.options];
       const indices = options.map((opt, index) =>
         wanted.includes(opt.value) || wanted.includes(opt.label) || wanted.includes(opt.textContent.trim()) ? index : -1
       ).filter(index => index >= 0);
       if (!indices.length) {
         return {
           ok: false,
           reason: 'no option matched',
           available: options.map((o) => o.textContent.trim()).slice(0, 25),
         };
       }
       if (!this.multiple && indices.length !== 1) {
         return { ok: false, reason: 'multiple requested values matched a single-select control' };
       }
       const view = this.ownerDocument.defaultView;
       const proof = { target: this, trusted: false };
       // NOT { once: true }. A once-listener is consumed by the FIRST input or
       // change event on the page, whoever fired it — an unrelated autosave, a
       // sibling field, anything — and the real event for this select then
       // arrives with nobody listening, which reported a working selection as
       // an untrusted one. Filter by target instead, and detach explicitly.
       const observe = (event) => {
         if (event.target === proof.target && event.isTrusted) proof.trusted = true;
       };
       proof.detach = () => {
         view.removeEventListener('input', observe, true);
         view.removeEventListener('change', observe, true);
         if (view.__g9SelectProof === proof) delete view.__g9SelectProof;
       };
       view.addEventListener('input', observe, { capture: true });
       view.addEventListener('change', observe, { capture: true });
       view.__g9SelectProof = proof;
       return {
         ok: true,
         multiple: this.multiple,
         indices,
         selected: options.map((o, index) => o.selected ? index : -1).filter(index => index >= 0),
         chosen: indices.map(index => options[index].textContent.trim() || options[index].value),
       };
     }`,
    [wanted],
  );

  if (!plan?.ok) {
    throw new Error(
      `Could not select ${JSON.stringify(wanted)}: ${plan?.reason}.` +
        (plan?.available ? ` Available options: ${plan.available.join(' | ')}` : ''),
    );
  }

  await send(tabId, 'DOM.focus', { backendNodeId: node.backendNodeId });
  const focused = await callOnNode(
    tabId,
    node.backendNodeId,
    `function () { return this.ownerDocument.activeElement === this; }`,
  );
  if (!focused) throw new Error('Could not focus the <select>; no selection keys were sent.');

  // Watch the whole run of selection keys, so the verification below can tell
  // "the page refused the selection" from "the keys never arrived at all".
  const sawKeys = await watchForInput(tabId, ['keydown'], WITNESS_TIMEOUT_MS);

  if (!plan.multiple) {
    // These are browser input-pipeline key events. Unlike assigning
    // option.selected and dispatching Event(), the resulting input/change
    // events are trusted and controlled components see a real user gesture.
    await dispatchKey(tabId, { key: 'Home' });
    if (plan.indices[0]) await dispatchKey(tabId, { key: 'ArrowDown', repeat: plan.indices[0] });
  } else {
    const navModifier = /Mac/i.test(globalThis.navigator?.userAgent ?? '') ? MODIFIERS.Meta : MODIFIERS.Control;
    const desired = new Set(plan.indices);
    const selected = new Set(plan.selected);
    const toggles = [];
    const max = Math.max(...plan.indices, ...plan.selected, 0);
    for (let index = 0; index <= max; index++) {
      if (desired.has(index) !== selected.has(index)) toggles.push(index);
    }
    for (const index of toggles) {
      await dispatchKey(tabId, { key: 'Home', modifiers: navModifier });
      if (index) await dispatchKey(tabId, { key: 'ArrowDown', modifiers: navModifier, repeat: index });
      await dispatchKey(tabId, { key: 'Space', modifiers: navModifier });
    }
  }

  const verified = await callOnNode(
    tabId,
    node.backendNodeId,
    `function (wantedIndices) {
       const actual = [...this.options].map((o, index) => o.selected ? index : -1).filter(index => index >= 0);
       const proof = this.ownerDocument.defaultView.__g9SelectProof;
       const trusted = !!proof?.trusted;
       proof?.detach?.();
       return {
         actual,
         values: [...this.selectedOptions].map(o => o.value),
         labels: [...this.selectedOptions].map(o => o.textContent.trim()),
         trusted,
       };
     }`,
    [plan.indices],
  );
  const actual = [...(verified?.actual ?? [])].sort((a, b) => a - b);
  const expected = [...plan.indices].sort((a, b) => a - b);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    // "The page intercepted it" was a guess, and for the most common cause it
    // was the wrong one: a hidden tab receives no input at all, so the keys
    // were never delivered and the page is blameless. Ask before accusing.
    if ((await sawKeys()) === false) {
      throw new Error(await explainNoInput(tabId, 'selection'));
    }
    throw new Error(
      `Selection keys were issued, but selected option indexes are ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}. ` +
        `The page or platform intercepted the native selection, so success is not being reported.` ,
    );
  }
  const changed = JSON.stringify([...plan.selected].sort((a, b) => a - b)) !== JSON.stringify(expected);
  if (changed && !verified.trusted) {
    throw new Error('The selection changed, but the page did not observe a trusted input/change event. Success is not being reported.');
  }
  return { selected: verified.labels, values: verified.values, trustedEvent: changed ? true : 'not-needed' };
}

/**
 * Set files on an <input type=file> without opening the native picker.
 *
 * Accepts a `selector` as well as a `ref`, and on real sites the selector is
 * the one that works. Every upload UI worth the name hides its file input
 * behind a styled button — Instagram, Gmail, GitHub all do — and a hidden input
 * is not in the accessibility tree, so `browser_snapshot` never gives it a ref.
 * Requiring one made this tool usable only on pages that had not bothered to
 * style their upload control.
 *
 * Clicking the visible button instead is not an option: that opens the OS file
 * picker, which is outside the browser and outside anything CDP can reach.
 * Setting the input directly is the whole reason this tool exists.
 */
export async function upload(tabId, { ref, selector, files, url } = {}) {
  let backendNodeId;

  if (ref) {
    backendNodeId = (await resolveRef(tabId, ref, url)).backendNodeId;
  } else if (selector) {
    const { root } = await send(tabId, 'DOM.getDocument', { depth: 0 });
    const { nodeId } = await send(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) {
      throw new Error(
        `No element matches ${JSON.stringify(selector)}. For a hidden upload control, ` +
          `'input[type=file]' usually finds it — check with browser_console action:"evaluate".`,
      );
    }
    ({ node: { backendNodeId } } = await send(tabId, 'DOM.describeNode', { nodeId }));
  } else {
    throw new Error(
      'upload needs a ref or a selector. File inputs are usually hidden behind a styled button, ' +
        'so they have no ref — pass selector:"input[type=file]" instead.',
    );
  }

  const list = Array.isArray(files) ? files : [files];
  await send(tabId, 'DOM.setFileInputFiles', { backendNodeId, files: list });
  return { uploaded: list, via: ref ? `ref ${ref}` : `selector ${selector}` };
}
