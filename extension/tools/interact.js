/**
 * User-grade interaction.
 *
 * Every action here goes through Input.dispatch*Event, which injects at the
 * browser's input pipeline — *before* the page sees anything. The resulting
 * events carry isTrusted === true and fire the complete native sequence
 * (pointerdown -> mousedown -> focus -> mouseup -> click). This is the
 * difference between automation that works on real apps and automation that
 * silently fails on any framework that checks isTrusted.
 *
 * ## Input levels (v2)
 *
 * Every pointer, wheel and keyboard action runs at one of three levels
 * (lib/humanize.js `levelFor`: the call's `humanize` argument, else the
 * engine's per-tab default):
 *
 * - `off`     — v1's direct dispatch, event for event: one mouseMoved at the
 *               target, press, release; per-character keyDown/keyUp; one wheel
 *               event; scrollIntoView before acting. Kept exactly, because a
 *               flow recorded and debugged against it must behave the same.
 * - `human`   — the pointer lives somewhere and travels (curved, Fitts-timed
 *               paths from extension/humanize), aims at a sampled point inside
 *               the element rather than its centre, reaches off-screen targets
 *               with the WHEEL instead of scrollIntoView, types with human
 *               rhythm and the odd corrected typo. Seeded: the result carries
 *               the seed, and passing it back reproduces the motion.
 * - `stealth` — `human`, minus every shortcut a page could notice: no
 *               DOM.focus (focus is earned by clicking), no programmatic scroll
 *               fallback (fail and say why), no Input.insertText unless
 *               `fast:true` was explicitly asked for.
 *
 * Humanized pointer events are dispatched on the PAGE session in top-level
 * viewport coordinates, even for a node inside a cross-origin frame: the
 * browser's own hit test routes them into the frame, exactly as it routes a
 * real mouse (verified on Edge 153: a click at owner-offset + child-offset on
 * the page session landed in the out-of-process frame at the right client
 * coordinates). That keeps one pointer per tab, in one coordinate space, which
 * is what the cursor track needs. `off` keeps v1's routing (the frame's own
 * session, in its own coordinates).
 *
 * Every action result carries `delivery` ('delivered' | 'indeterminate'; a
 * 'not-delivered' action throws, see the witness) and pointer actions carry
 * `pointer` {x, y}: where the cursor is now, in top-level CSS pixels.
 */

import { send, sendOnLiveSession } from '../lib/cdp.js';
import { platform } from '../lib/platform.js';
import { resolveRef, sessionForNode } from '../lib/refs.js';
import * as frames from '../lib/frames.js';
import { inWorld, callInWorld, callOnObject } from '../lib/world.js';
import * as pointer from '../lib/pointer.js';
import { levelFor, perform, hiddenInputMessage, hiddenInputError, visibilityOf, MOUSE_PRESSURE, HIDDEN_REMEDY } from '../lib/humanize.js';
import {
  createRng, keyDefinition, directDefinition, isKnownKey, parseKeySpec,
  planClick, planHover, planDrag, planMove, planScroll, planType, planKeyPress,
  planGap, sequence,
} from '../humanize/index.js';

/** Modifier bitmask used by CDP: Alt=1, Ctrl=2, Meta=4, Shift=8 */
export const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export function modifierMask(list = []) {
  if (typeof list === 'number') return list & 15;
  return (Array.isArray(list) ? list : [list]).reduce((m, name) => m | (MODIFIERS[name] ?? 0), 0);
}

function modifierNames(mask = 0) {
  return ['Control', 'Meta', 'Alt', 'Shift'].filter((name) => (mask | 0) & MODIFIERS[name]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Select-all is Cmd+A on macOS and Ctrl+A everywhere else. Ask the PAGE's
 * platform rather than assume — a hardcoded Control silently fails to clear a
 * field on a Mac, and type({clear:true}) then appends instead of replacing.
 * (v1 asked the service worker's navigator, which is the same browser; on a
 * launched engine the tool code runs in the daemon, whose navigator is Node's.)
 */
async function selectAllModifier(tabId, sessionId = null) {
  const mac = await inWorld(tabId, '/Mac/i.test(navigator.platform || navigator.userAgent || "")', { sessionId })
    .catch(() => /Mac/i.test(globalThis.navigator?.userAgent ?? ''));
  return mac ? MODIFIERS.Meta : MODIFIERS.Control;
}

/**
 * The level an action ran at, for its result. `raisedFrom`/`stealthLevel` say when
 * the tab's stealth level made it stricter than asked (decision D-b, see
 * lib/humanize.js levelFor) — an agent that passed humanize:"off" must be able
 * to see why its input took human time.
 */
function hzInfo(hz) {
  if (hz.level === 'off') return { level: 'off' };
  return {
    level: hz.level,
    profile: hz.name,
    seed: hz.seed,
    ...(hz.raisedFrom ? { raisedFrom: hz.raisedFrom, stealthLevel: hz.stealthLevel } : {}),
  };
}

/** A derived, still deterministic seed for a sub-action of one call. */
const subSeed = (hz, label) => `${hz.seed}:${label}`;

// ------------------------------------------------------------ input witness

/**
 * Proof that an input event actually reached the page.
 *
 * Chromium SILENTLY DISCARDS `Input.dispatch*Event` for a page that is not
 * visible in a headed window: no error is raised, and nothing happens. Key
 * events and most mouse events come back at once, as if they had worked; a
 * WHEEL event never comes back at all (130 s measured), and every mouse event
 * queued behind it then waits ~5 s (P8 matrix, round 2, Edge and Chrome 153).
 * Every action here used to return an echo of its own arguments —
 * `{ typed: "admin" }` for a field that stayed empty — which is the worst
 * failure this toolset can produce: the agent proceeds, builds on a login that
 * never happened, and reports success to the user.
 *
 * It IS reproducible headless: a headless BACKGROUND tab (another tab of the
 * window active) is hidden too, and the matrix reproduces it on Edge and
 * Chrome. And it is the normal case for the product's own headline workflow:
 * the person keeps working in another tab, and that is exactly what makes the
 * attached tab hidden. So every input action first asks the page whether it is
 * visible (requireVisible — one round trip) and sends nothing to a hidden one;
 * the witness below still catches a page that becomes hidden mid-action.
 *
 * So every dispatching action witnesses its own event. The witness is a
 * capture-phase listener that counts only trusted events, so it cannot be
 * satisfied by the page's own synthetic ones.
 *
 * Note what is deliberately NOT verified: the resulting VALUE. Per-character
 * typing of "12ab34" into a digit-only field correctly lands "1234" — a page
 * rejecting keys is the page behaving, not a failure (see the v1.0.15 entry).
 * The honest question is "did the input reach the page at all", and that is
 * what this answers. The value that resulted is reported, never asserted.
 *
 * ## EXT-01: what was wrong, and what the witness is now
 *
 * v1 put `}, { sessionId })` INSIDE the page-side expression, so every arming
 * threw `ReferenceError: sessionId is not defined`; the missing promise handle
 * was read as "cannot tell", and "cannot tell" was accepted as success. The
 * witness had been verifying nothing. Now:
 *
 * - the expression is built by `witnessExpression()` and has no free
 *   identifiers besides page globals (a unit test executes it in node:vm);
 * - it is armed in G9's ISOLATED world (lib/world.js), so the listener and its
 *   promise are invisible to the page; `sessionId` is only CDP routing;
 * - it listens in the frame's own window AND every same-process descendant
 *   frame, because a click inside a same-origin iframe is delivered to THAT
 *   document and a top-level-only witness would accuse a click that worked;
 * - arming that fails is an ERROR ("nothing was dispatched"), never a pass;
 * - the verdict has three values: delivered, not-delivered (throws, naming the
 *   likely cause), indeterminate (the document went away before it could
 *   answer — typically the action navigated; reported, NEVER retried, because
 *   retrying a click is how you post something twice);
 * - the promise handle is released after every use.
 *
 * ## Armed and read as one promise, deliberately
 *
 * The first version installed a counting listener in one call and read the
 * counter in a later one, which quietly assumes both land in the same
 * JavaScript execution context. On a single-page application they do not:
 * Instagram swaps context as its router moves, so the listener that was
 * watching is simply GONE by the time the counter is read, and a caption that
 * typed perfectly was reported as a failure. A promise that lives entirely
 * inside one context cannot be split that way.
 *
 * Do NOT await the returned promise before dispatching. Arm, act, then settle.
 */
// 'wheel' is only ever a POSITIVE signal: Chromium may handle a wheel entirely
// on the compositor, so its absence proves nothing. scroll() checks its outcome.
//
// The promise carries `extend(ms, dispatchEnded)`: re-time the verdict to `ms`
// from NOW (0 ends the witness and removes its listeners at once);
// `dispatchEnded` says G9 has sent everything. See armWitness for why the
// verdict is timed from the end of dispatch, not from arming.
//
// ## What the page answers
//
// - `true` — a trusted event of the watched kinds arrived (and, for a witness
//   armed ON AN ELEMENT, it arrived at that element);
// - `false` — dispatch ended and the grace period passed with no such event;
// - `{ missed, x, y }` — armed on an element, and the event went to ANOTHER
//   element (`missed` describes it). Before, any trusted mousedown anywhere in
//   the page counted: a click that landed on the spacer the button had just
//   scrolled away from was "delivered" (live round 2: 22/22 CfT runs), and the
//   agent proceeded on a click that never reached its target;
// - `'expired'` — the safety ceiling fired while G9 was still dispatching. It
//   says nothing about the page, so it is never read as "not delivered".
//
// `mode:'last'` (hover) judges where the pointer ENDS: a humanized path crosses
// other elements on its way, so the first move proves nothing; the verdict is
// the element under the last move, with a hit after dispatch answering at once.
//
// Self-contained on purpose: this function's SOURCE is sent to the page
// (Function.prototype.toString), so it may use nothing but its arguments,
// `this` (the element, when targeted), `window` and timers — a unit test runs
// it in node:vm with exactly those.
function witnessInPage(kindList, timeoutMs, opts) {
  const options = opts || {};
  const target = options.targeted ? this : null;
  const lastMode = options.mode === 'last';
  let extend = null;
  const promise = new Promise((resolve) => {
    const kinds = [].concat(kindList);
    const views = [];
    const collect = (view, depth) => {
      views.push(view);
      if (depth >= 6) return;
      let count = 0;
      try { count = view.frames.length; } catch (e) { return; }
      for (let i = 0; i < count && views.length < 40; i++) {
        try {
          const child = view.frames[i];
          void child.document;
          collect(child, depth + 1);
        } catch (e) { /* another process: its own session has its own witness */ }
      }
    };
    collect(window, 0);
    // Shadow hosts of CLOSED roots above the target: an event inside a closed
    // tree is retargeted to its host for every listener outside it, so the
    // host is as precise as a window-level listener can ever be there.
    const coarse = [];
    if (target) {
      let root = null;
      try { root = target.getRootNode ? target.getRootNode() : null; } catch (e) { root = null; }
      for (let d = 0; root && root.host && d < 20; d++) {
        if (root.mode === 'closed') coarse.push(root.host);
        try { root = root.host.getRootNode ? root.host.getRootNode() : null; } catch (e) { root = null; }
      }
    }
    const describe = (el) => {
      if (!el || !el.tagName) return el && el.nodeType === 9 ? 'the document itself' : 'the page';
      let s = String(el.tagName).toLowerCase();
      if (el.id) s += '#' + el.id;
      if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
      return '<' + s + '>';
    };
    const innermost = (event) => {
      let path = [];
      try { path = typeof event.composedPath === 'function' ? event.composedPath() : []; } catch (e) { path = []; }
      return { path, first: path[0] || event.target };
    };
    // What the target IS, recorded when armed: a page that re-renders (a polling refresh, a list
    // without keys, an innerHTML swap) replaces the element with an identical one while the
    // humanized pointer is on its way, and the press lands on the replacement. Compared on a miss
    // once the armed element has left the document (see missOf).
    const identity = (el) => {
      if (!el || el.nodeType !== 1) return null;
      try {
        const attr = (k) => (typeof el.getAttribute === 'function' ? el.getAttribute(k) || '' : '');
        return [String(el.tagName || ''), el.id || '', attr('type'), attr('name'), attr('role'), attr('aria-label'),
          String(el.textContent || '').trim().slice(0, 200)].join('|');
      } catch (e) { return null; }
    };
    const boxOf = (el) => {
      try {
        const r = el.getBoundingClientRect();
        return { l: r.left, t: r.top, r: r.right, b: r.bottom };
      } catch (e) { return null; }
    };
    const targetIdentity = target ? identity(target) : null;
    const targetBox = target ? boxOf(target) : null;
    // At the target: in its composed path, inside it (through open shadow
    // roots and same-origin frame boundaries — clicking an <iframe> lands in
    // its document), on its closed-shadow host, or on a <label> that forwards
    // activation to it (checkObscured allows that label too).
    const within = (event) => {
      const { path, first } = innermost(event);
      if (path.indexOf(target) >= 0) return true;
      let n = first;
      for (let depth = 0; n && depth < 500; depth++) {
        if (n === target || coarse.indexOf(n) >= 0) return true;
        if (n.tagName === 'LABEL') {
          try { if (n.control === target) return true; } catch (e) { /* not a form label */ }
        }
        let next = n.parentNode || null;
        if (!next && n.host) next = n.host;
        if (!next && n.nodeType === 9) {
          try { next = n.defaultView ? n.defaultView.frameElement : null; } catch (e) { next = null; }
        }
        n = next;
      }
      return false;
    };
    let settled = false;
    let ended = false;
    let timer = null;
    let seen = 0;
    let lastHit = false;
    let lastMiss = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const view of views) {
        for (const kind of kinds) {
          try { view.removeEventListener(kind, onEvent, true); } catch (e) { /* frame gone */ }
        }
      }
      resolve(value);
    };
    const missOf = (event) => {
      const first = innermost(event).first;
      const x = Math.round(event.clientX || 0);
      const y = Math.round(event.clientY || 0);
      // The armed element left the document: the page re-rendered it. `=== false`, so a harness
      // element without isConnected keeps the plain verdict.
      if (target && target.isConnected === false) {
        let n = first;
        let match = null;
        for (let d = 0; n && d < 6; d++) {
          if (n.nodeType === 1 && targetIdentity != null && identity(n) === targetIdentity) { match = n; break; }
          n = n.parentNode || n.host || null;
        }
        const cx = event.clientX || 0;
        const cy = event.clientY || 0;
        const inBox = (b) => !!b && cx >= b.l - 1 && cx <= b.r + 1 && cy >= b.t - 1 && cy <= b.b + 1;
        if (match && (inBox(targetBox) || inBox(boxOf(match)))) return { replaced: true, same: true, hit: describe(match), x, y };
        return { missed: describe(first), replaced: true, x, y };
      }
      return { missed: describe(first), x, y };
    };
    const onEvent = (event) => {
      if (!event.isTrusted) return;
      if (!target) { finish(true); return; }
      seen += 1;
      const hit = within(event);
      if (!lastMode) { finish(hit ? true : missOf(event)); return; }
      lastHit = hit;
      lastMiss = hit ? null : missOf(event);
      if (hit && ended) finish(true);
    };
    const expire = () => {
      if (!ended) { finish('expired'); return; }
      if (lastMode && seen) { finish(lastHit ? true : lastMiss); return; }
      finish(false);
    };
    for (const view of views) {
      for (const kind of kinds) {
        try { view.addEventListener(kind, onEvent, { capture: true, passive: true }); } catch (e) { /* frame gone */ }
      }
    }
    timer = setTimeout(expire, Math.max(0, Number(timeoutMs) || 0));
    extend = (ms, dispatchEnded) => {
      if (settled) return;
      if (dispatchEnded) {
        ended = true;
        if (lastMode && lastHit) { finish(true); return; }
      }
      clearTimeout(timer);
      timer = setTimeout(expire, Math.max(0, Number(ms) || 0));
    };
  });
  promise.extend = extend;
  return promise;
}

/** The page-side witness as a function declaration (for callInWorld on an element; exported for its unit test). */
export const WITNESS_FN = witnessInPage.toString();

/**
 * The page-side witness as an expression, not tied to an element: the first
 * trusted event of `kinds` anywhere in the frame (and its same-process
 * descendants) answers.
 */
export function witnessExpression(kinds, timeoutMs) {
  return `(${WITNESS_FN})(${JSON.stringify(kinds)}, ${Math.max(0, Math.round(timeoutMs))}, { targeted: false })`;
}

/**
 * How long the page waits for the event before giving up.
 *
 * Generous, because the wait runs INSIDE the page and in parallel with the
 * action — a successful dispatch resolves it immediately and pays nothing, so
 * the only thing a larger budget costs is a slower answer in the failing case.
 * A long `Input.insertText` on a heavy editor needs more than a few hundred
 * milliseconds to come back through the event loop. A humanized action adds
 * its own plan duration on top.
 */
const WITNESS_TIMEOUT_MS = 1500;

/**
 * The in-page safety net of an armed witness: long enough that it can only
 * matter when G9 never comes back to settle it (settle re-times the verdict to
 * WITNESS_TIMEOUT_MS from the end of dispatch). It used to be 2 × (grace +
 * plan) + 5 s, and a dispatch slower than that — ~1 s per mouse event on a
 * throttled tab, 64 moves and 19 notches before the press — let it fire
 * first: the witness settled `false`, every later extend() was ignored, and a
 * click the page had received (38 trusted events, the form answered) was
 * reported "not delivered" after 85 s (P8 matrix, round 2, 3/3 runs). An agent
 * told that clicks again. When it does fire now, the page answers 'expired',
 * which is read as "cannot tell" — never as "not delivered".
 */
const WITNESS_CEILING_MS = 10 * 60_000;

/**
 * How long G9 waits for the page's answer AFTER settle() re-timed it. The
 * page answers within WITNESS_TIMEOUT_MS unless its event loop is stuck; past
 * this, the verdict is "cannot tell", not a hang for the length of the ceiling.
 */
const SETTLE_WAIT_MS = WITNESS_TIMEOUT_MS + 10_000;

/** Page-side (G9's world): re-time a witness promise; see witnessInPage. */
const RETIME_FN = 'function (ms, ended) { if (typeof this.extend === "function") this.extend(ms, ended); }';

const GONE = /Execution context was destroyed|Inspected target navigated or closed|Cannot find context|Could not find object with given id|no longer in the document|frame is gone|Target closed|Session with given id not found|detached/i;

function isHalt(err) {
  return err?.halted === true || /halted by the user|Stop was pressed|pressed Stop/i.test(String(err?.message ?? err));
}

/** How long a cleanup command sent after Stop may take before G9 stops waiting for it. */
const HALTED_CLEANUP_MS = 2000;

/**
 * Ending and releasing G9's OWN witness, also after Stop. send() refuses every
 * command while the user's Stop is on, so a witness armed when Stop was
 * pressed stayed listening in G9's world until its safety net, up to 10
 * minutes later (live round 2). Taking G9's listener away is not the agent
 * acting on the page (like netpin answering a paused request), so after Stop
 * it goes out on the live session, bounded so a silent browser cannot hold
 * the call. Without Stop it takes the normal, guarded path.
 */
async function cleanupSend(tabId, method, params = {}, options = {}) {
  try {
    return await send(tabId, method, params, options);
  } catch (err) {
    if (!isHalt(err)) throw err;
    let timer;
    try {
      return await Promise.race([
        sendOnLiveSession(tabId, method, params, options.sessionId ?? null),
        new Promise((resolve) => { timer = setTimeout(resolve, HALTED_CLEANUP_MS); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The sessions a witness should listen in: the node's own frame process when
 * the target is known, else the page and every attached cross-origin frame
 * (a key goes wherever focus is, which may be an out-of-process frame).
 */
async function witnessSessions(tabId, node) {
  if (node) return [node.sessionId ?? null];
  const children = await frames.list(tabId).catch(() => []);
  return [null, ...children.map((f) => f.sessionId).filter(Boolean).slice(0, 10)];
}

/**
 * Arm the witness. Throws when the primary session cannot be armed: nothing
 * has been dispatched at that point, and an action whose delivery cannot be
 * checked must not be reported as delivered.
 *
 * ## The verdict is timed from the END of dispatch
 *
 * `timeoutMs` is what the action expects to take (grace + plan duration). A
 * timer started at arming assumes the events go out on the plan's schedule,
 * and in the extension they need not: every command pays a state read and an
 * attach check, so a long humanized move can put its mousedown a second or
 * more behind plan. A click that landed would then time out as
 * "not-delivered" — and an agent told a click did not happen clicks again.
 * So the page is armed with a high ceiling (it only matters if G9 never comes
 * back), and settle() re-times the verdict to WITNESS_TIMEOUT_MS from the
 * moment dispatch finished; release() ends it at once, listeners and all.
 */
async function armWitness(tabId, kinds, timeoutMs, sessions = [null], { target = null, mode = 'first' } = {}) {
  // `timeoutMs` (what the action expects to take) only sizes the safety net;
  // the verdict itself is timed by settle().
  const ceiling = Math.round(Math.max(WITNESS_CEILING_MS, timeoutMs * 2 + 5000));
  const expression = witnessExpression(kinds, ceiling);
  // Armed ON the element when there is one: `this` is the element in G9's
  // world, so the page can say WHERE the event landed, not only that it did.
  // The element's own frame process is the only session it listens in.
  if (target) sessions = [target.sessionId ?? null];
  const arm = (sessionId) => (target
    ? callInWorld(tabId, target.backendNodeId, WITNESS_FN, [kinds, ceiling, { targeted: true, mode }], sessionId, { returnByValue: false, awaitPromise: false })
    : inWorld(tabId, expression, { sessionId, awaitPromise: false, returnByValue: false }));
  /** The promise handle, or null (anything else that came back is released). */
  const handleOf = (handle, sessionId) => {
    if (handle?.objectId && handle.subtype === 'promise') return { sessionId, objectId: handle.objectId };
    if (handle?.objectId) send(tabId, 'Runtime.releaseObject', { objectId: handle.objectId }, { sessionId }).catch(() => {});
    return null;
  };

  // The primary session first, alone: when it cannot be armed nothing may be
  // dispatched, so its failure has to be known before anything else happens.
  const [primarySession = null, ...children] = sessions;
  let handle;
  try {
    handle = await arm(primarySession);
  } catch (err) {
    if (isHalt(err)) throw err;
    const e = new Error(
      `Could not arm the input witness, so nothing was dispatched: ${String(err?.message ?? err)}. ` +
        `G9 does not act without a way to tell whether the page received the input.`,
    );
    e.cause = err;
    throw e;
  }
  const primary = handleOf(handle, primarySession);
  if (!primary) {
    throw new Error(
      'Could not arm the input witness, so nothing was dispatched: the page returned no promise handle ' +
        `(got ${handle?.type ?? 'nothing'}${handle?.subtype ? '/' + handle.subtype : ''}).`,
    );
  }
  // The other frame processes in parallel: a key goes wherever focus is, and
  // arming up to ten cross-origin frames one after another put a round trip
  // per frame in front of every key press. A child frame that went away is
  // simply not watched.
  const others = await Promise.all(children.map((sessionId) =>
    arm(sessionId).then((h) => handleOf(h, sessionId), () => null)));
  const armed = [{ ...primary, primary: true }, ...others.filter(Boolean).map((w) => ({ ...w, primary: false }))];

  /**
   * Re-time every witness to `ms` from now (0 = end it); `ended` tells it that
   * dispatch is over. A witness already answered ignores it.
   */
  const retime = (ms, ended = false) => Promise.all(armed.map((w) =>
    callOnObject(tabId, w.objectId, RETIME_FN, [ms, ended], w.sessionId).catch(() => {})));

  let released = null;
  const release = () => {
    released = released ?? (async () => {
      // End the witnesses first — listeners and timers go at once, not at the
      // ceiling — then let go of the handles. Also after Stop: cleanupSend.
      await Promise.all(armed.map((w) =>
        callOnObject(tabId, w.objectId, RETIME_FN, [0, false], w.sessionId, { via: cleanupSend }).catch(() => {})));
      await Promise.all(armed.map((w) =>
        cleanupSend(tabId, 'Runtime.releaseObject', { objectId: w.objectId }, { sessionId: w.sessionId }).catch(() => {})));
    })();
    return released;
  };

  const settleOne = async (w) => {
    try {
      const out = await send(tabId, 'Runtime.awaitPromise', {
        promiseObjectId: w.objectId,
        returnByValue: true,
      }, { sessionId: w.sessionId, timeoutMs: SETTLE_WAIT_MS });
      if (out?.exceptionDetails) {
        return { delivery: 'indeterminate', reason: out.exceptionDetails.exception?.description ?? out.exceptionDetails.text };
      }
      const v = out?.result?.value;
      if (v === true) return { delivery: 'delivered' };
      if (v === false) return { delivery: 'not-delivered' };
      const at = v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : null;
      if (v && v.replaced === true && v.same === true) {
        // The page swapped the element for an identical one mid-approach and the press landed on
        // that. NOT "delivered": a swap between down and up loses the click (measured) — and NOT
        // "missed", which invited a second click on a press that took effect (daemon review,
        // 2026-09-22: the page counted the click, the result said missed).
        return {
          delivery: 'indeterminate',
          replaced: true,
          hit: v.hit,
          at,
          note: `The page re-rendered the element while the pointer was on its way; the press landed on an identical ` +
            `replacement ${v.hit}${at ? ` at (${at.x}, ${at.y})` : ''}. It was NOT repeated — check the outcome before acting again.`,
        };
      }
      if (v && typeof v.missed === 'string') {
        return { delivery: 'missed', hit: v.missed, at, ...(v.replaced ? { replaced: true } : {}) };
      }
      if (v === 'expired') {
        return {
          delivery: 'indeterminate',
          reason: `sending the input took longer than the witness's ${Math.round(ceiling / 60_000)}-minute safety limit, so the page's answer was lost`,
        };
      }
      return { delivery: 'indeterminate', reason: 'the witness returned no verdict' };
    } catch (err) {
      return { delivery: 'indeterminate', reason: String(err?.message ?? err), gone: GONE.test(String(err?.message ?? err)) };
    }
  };

  const settle = async () => {
    try {
      // Dispatch is over: the page now has the grace period, from this moment.
      await retime(WITNESS_TIMEOUT_MS, true);
      // The first "delivered" answers the question. Waiting for every frame
      // instead held each key press on a page with cross-origin iframes (ads,
      // widgets — most real pages) for the full witness timeout of the frames
      // that did NOT get the key, although the page had it at once. The
      // witnesses still pending clean up after themselves in the page.
      const verdicts = await firstDeliveredOrAll(armed.map(settleOne));
      if (verdicts.some((v) => v?.delivery === 'delivered')) return { delivery: 'delivered' };
      const primary = verdicts[0];
      // The event reached the page, at the wrong element: its own verdict.
      if (primary?.delivery === 'missed') return primary;
      // …or at an identical element the page put in the target's place: said, never repeated.
      if (primary?.replaced && primary.delivery === 'indeterminate') return primary;
      if (primary?.delivery === 'not-delivered' && verdicts.every((v) => v.delivery !== 'indeterminate' || !v.gone)) {
        return { delivery: 'not-delivered' };
      }
      const gone = verdicts.find((v) => v.gone);
      return {
        delivery: 'indeterminate',
        note: gone
          ? 'The page replaced its document (a navigation or a frame reload) before the witness could report. ' +
            'That usually means the action took effect. It was NOT repeated — check the page before acting again.'
          : `Delivery could not be confirmed: ${primary?.reason ?? 'no verdict'}. The action was not repeated.`,
      };
    } finally {
      // Awaited: a handle is only "released" once the browser has let go of it.
      await release();
    }
  };

  return { settle, release };
}

/**
 * Resolve with every verdict, or as soon as one of them is "delivered" (the
 * array then has holes for the ones still pending). The promises never reject:
 * settleOne turns every failure into a verdict.
 */
function firstDeliveredOrAll(promises) {
  return new Promise((resolve) => {
    const out = new Array(promises.length);
    let left = promises.length;
    if (!left) resolve(out);
    promises.forEach((p, i) => {
      p.then((v) => {
        out[i] = v;
        left -= 1;
        if (v?.delivery === 'delivered' || left === 0) resolve(out);
      });
    });
  });
}

/**
 * Turn "nothing happened" into the sentence that names the fix.
 *
 * Visibility is asked for again on the failure path: a page can become hidden
 * after requireVisible said it was not (the person switched tabs mid-action).
 */
async function explainNoInput(tabId, action, sessionId = null) {
  const page = await inWorld(
    tabId,
    '({ hidden: document.hidden, state: document.visibilityState })',
    { sessionId },
  ).catch(() => null);

  if (page?.hidden) return hiddenInputMessage(action, page.state);
  return (
    `The ${action} was dispatched but the page never received a trusted event for it, although the ` +
    `page reports it is visible. Something is intercepting input before the document — a native ` +
    `dialog, a modal the browser owns, or a devtools overlay. Take a browser_screenshot to see the ` +
    `current state.`
  );
}

/**
 * The error for input the page never received, marked `hidden` when the page reports it is hidden.
 *
 * Five paths built this message with `new Error(await explainNoInput(…))` and none set `hidden`,
 * so a tab hidden DURING delivery produced the hidden-tab sentence with `hidden:false` on the wire
 * and no alert in the side panel (v3 review, finding 6). The flag is what sw.js keys the alert on.
 */
async function noInputError(tabId, action, sessionId = null) {
  const page = await inWorld(
    tabId,
    '({ hidden: document.hidden, state: document.visibilityState })',
    { sessionId },
  ).catch(() => null);
  const error = new Error(await explainNoInput(tabId, action, sessionId));
  if (page?.hidden) error.hidden = true;
  return error;
}

/**
 * Dispatch, then require proof the page saw it.
 *
 * `verify` is an optional last word: some actions can observe their own OUTCOME
 * directly, and an outcome outranks any opinion about events. Typing uses it,
 * because a field that now holds the text is not open to argument.
 *
 * `target` (a resolved ref) arms the witness ON that element, so an event that
 * reached the page at a DIFFERENT element is reported as such (`mode:'last'`
 * for a hover: judged by where the pointer ends). `label` names the element in
 * that report.
 *
 * Returns `{ result, delivery, note? }`; throws for not-delivered and for
 * missed (err.delivery says which) — neither is a success, and neither is
 * ever retried here.
 */
async function witnessed(tabId, expect, action, run, { verify = null, node = null, sessions = null, extraMs = 0, target = null, mode = 'first', label = null } = {}) {
  const kinds = Array.isArray(expect) ? expect : [expect];
  const list = target ? [target.sessionId ?? null] : sessions ?? await witnessSessions(tabId, node);
  // Awaited: this only installs the listener, it does not wait for the event.
  const witness = await armWitness(tabId, kinds, WITNESS_TIMEOUT_MS + Math.max(0, extraMs), list, { target, mode });
  let result;
  try {
    result = await run();
  } catch (err) {
    witness.release();
    throw err;
  }
  const seen = await witness.settle();

  if (seen.delivery === 'delivered') return { result, delivery: 'delivered' };
  if (verify && (await verify().catch(() => false))) return { result, delivery: 'delivered', note: 'Confirmed by its outcome.' };
  if (seen.delivery === 'missed') {
    const error = new Error(missedMessage(action, label ?? describeNode(target, null), seen, mode));
    error.delivery = 'missed';
    error.hit = seen.hit;
    throw error;
  }
  if (seen.delivery === 'not-delivered') {
    const error = (await noInputError(tabId, action, list[0] ?? null));
    error.delivery = 'not-delivered';
    throw error;
  }
  return { result, delivery: 'indeterminate', note: seen.note };
}

/** The report for input that reached the page at the wrong element. */
function missedMessage(action, label, seen, mode) {
  const at = seen.at ? ` at (${seen.at.x}, ${seen.at.y})` : '';
  if (seen.replaced) {
    return `"${label}" was removed from the page (re-rendered) before the ${action}; it landed on ${seen.hit}${at} in its ` +
      `place. The ${action} was NOT repeated` +
      (mode === 'last' ? '.' : ` — whatever ${seen.hit} does on a ${action} may have happened.`) +
      ' Take a fresh browser_snapshot before acting again.';
  }
  const where = mode === 'last'
    ? `The ${action} reached the page, but the pointer ended over ${seen.hit}${at}, not over "${label}".`
    : `The ${action} reached the page, but not "${label}": it landed on ${seen.hit}${at}.`;
  return `${where} "${label}" moved, or something covered it, between G9 measuring it and the input arriving ` +
    `(a page still scrolling or animating, an overlay that appeared). The ${action} was NOT repeated` +
    (mode === 'last' ? '.' : ` — whatever ${seen.hit} does on a ${action} may have happened.`) +
    ' Take a fresh browser_snapshot before acting again.';
}

/**
 * Refuse input to a page that cannot receive it, BEFORE anything is sent.
 *
 * A hidden page (a background tab, a minimized or covered window in a headed
 * browser, and a headless background tab) does not get pointer or wheel input:
 * a mouse event to it is never even answered, a wheel event hangs. Without this
 * check the first error an agent saw was the wheel's 4 s timeout blamed on a
 * screencast nobody was running, then a 120 s "JavaScript dialog" relay timeout
 * for the typing — 30/30 hidden-tab cells in the P8 matrix (round 2), and
 * HIDDEN, the actual cause, was never reached. KEY events do reach a hidden page
 * (P8 matrix, round 3: a bare keyDown landed in the focused field on 10/10
 * hidden pages) — typing and keys are refused here as G9's policy (nobody can
 * see what they do, and a type's focus click would be lost), not because the
 * browser drops them; hiddenInputMessage says so. One round trip per action;
 * nothing is dispatched when it fails. A page whose state cannot be read is not
 * refused (the witness still judges the outcome).
 *
 * → the page's scroll position at the start, `{ state, x, y }` (null when unreadable), so an
 * action the tab hides in the middle of can say how far the page moved (hiddenMidAction).
 */
async function requireVisible(tabId, action) {
  // A launched HEADLESS engine's tab behind a page-opened tab is brought to the front first
  // (platform-cdp tabs.ensureFront; P8 matrix, round 3: 20.9 s clicks behind, 4.4 s in front). The
  // extension never rearranges a person's tabs (no-op there).
  await platform.tabs.ensureFront?.(tabId)?.catch?.(() => null);
  const page = await inWorld(tabId, '({ state: document.visibilityState, x: scrollX, y: scrollY })', { timeoutMs: 5000 })
    .catch(() => null);
  const state = typeof page?.state === 'string' ? page.state : await visibilityOf(tabId);
  if (state === 'hidden') throw hiddenInputError(action, state, { dispatched: false });
  return page && Number.isFinite(page.x) && Number.isFinite(page.y) ? page : null;
}

/**
 * The report for a pointer action whose tab became HIDDEN part-way — the person switched tabs while
 * it ran (Engine 1), or a window was minimized.
 *
 * Measured (P8 matrix, round 3, 9/9 hidemid rows, Edge and Chrome): a 2000 px scroll hidden 0.55 s
 * in had delivered 3–6 wheel notches and scrolled the page 300–600 px, and one more notch arrived
 * after the tab was shown again — yet the report was "not-delivered … the page never received it".
 * A click hidden while its target was being scrolled into view said "The scroll wheel was
 * dispatched but the page never received it" (7/9) about a click whose scroll had partly landed.
 * An agent that trusts either report scrolls twice. Now: what the action is (a click with no press
 * is a click NOT made), how many input events went out before, how far the page actually moved
 * (read in G9's world — reading works on a hidden page), and that one still in flight may land
 * later. `before` is requireVisible's reading.
 */
async function hiddenMidAction(tabId, action, before, err) {
  const now = await inWorld(tabId, '({ x: scrollX, y: scrollY })', { timeoutMs: 5000 }).catch(() => null);
  const dx = before && now ? Math.round(now.x - before.x) : 0;
  const dy = before && now ? Math.round(now.y - before.y) : 0;
  const scrolled = dx !== 0 || dy !== 0;
  const sent = Number.isFinite(err?.sent) ? err.sent : null;
  const of = Number.isFinite(err?.of) ? err.of : null;
  const pressed = Number(err?.pressed) > 0;
  const where = scrolled
    ? ` The page scrolled ${[dy ? `${Math.abs(dy)} px ${dy > 0 ? 'down' : 'up'}` : '', dx ? `${Math.abs(dx)} px ${dx > 0 ? 'right' : 'left'}` : ''].filter(Boolean).join(' and ')} ` +
      `(scroll position ${before.x},${before.y} → ${now.x},${now.y}) before that.`
    : '';
  const counted = sent ? ` ${sent}${of ? ` of ${of}` : ''} input events (pointer moves, wheel notches) were sent and accepted by the browser first; the rest were not sent.` : '';
  const late = ' An accepted event can still be waiting in the browser and may arrive when the tab is shown again (measured: one wheel notch did) — check the page before repeating anything.';
  const hid = 'the tab became HIDDEN (document.visibilityState="hidden") part-way';
  let delivery;
  let message;
  if (action === 'scroll') {
    if (!scrolled && !sent) return err;
    delivery = 'partial';
    message = `The scroll was interrupted: ${hid}.${counted}${where || ' The page had not moved.'}${late} ${HIDDEN_REMEDY}`;
  } else if (pressed) {
    delivery = 'partial';
    message = `The ${action} was interrupted after the mouse button went down: ${hid}, and a button may still be held ` +
      `down in the page.${counted}${where}${late} ${HIDDEN_REMEDY}`;
  } else {
    delivery = 'not-delivered';
    message = (action === 'hover'
      ? `The hover did not reach its target: ${hid}, while the pointer was on its way.`
      : `The ${action} was not made — no mouse button was pressed: ${hid}, while the pointer was on its way` +
        `${scrolled ? ' and its target was being scrolled into view' : ''}.`) + `${counted}${where}${late} ${HIDDEN_REMEDY}`;
  }
  const out = new Error(message);
  Object.assign(out, { delivery, hidden: true, cause: err, ...(sent != null ? { sent } : {}), ...(of != null ? { of } : {}), ...(scrolled ? { scrolled: { dx, dy } } : {}) });
  return out;
}

function deliveryOf(w) {
  return { delivery: w.delivery, ...(w.note && w.delivery !== 'delivered' ? { deliveryNote: w.note } : {}) };
}

// ----------------------------------------------------------------- geometry

/**
 * Scroll into view, then return viewport-relative interaction coordinates (level off).
 *
 * `align` is scrollIntoView's block/inline: 'center' (v1, the default) or 'nearest', which leaves
 * an element that is already on screen where it is — what a drag's second end needs, so that
 * bringing the drop target in does not scroll the grip away (see directDrag).
 */
async function pointFor(tabId, backendNodeId, sessionId = null, { align = 'center' } = {}) {
  // Same rule as callInWorld: if the caller did not say which frame owns this
  // node, ask the snapshot that produced it rather than assuming the main
  // document. Threading it through every call site is what left ten of them
  // behind the first time.
  sessionId = sessionId ?? await sessionForNode(tabId, backendNodeId);

  await callInWorld(
    tabId,
    backendNodeId,
    `function (align) { this.scrollIntoView({ block: align, inline: align, behavior: 'instant' }); }`,
    [align === 'nearest' ? 'nearest' : 'center'],
    sessionId,
  );

  // NO coordinate translation for an out-of-process frame at this level.
  //
  // Two attempts at translating failed in opposite directions — a stale
  // snapshot-time offset put the point off-screen, a live one still missed —
  // so `off` dispatches to the frame's own session, which accepts `Input`
  // commands in ITS OWN space. (The humanized levels do translate, freshly,
  // with DOM.getFrameOwner on the parent session and dispatch on the page
  // session — see measureBox. That is Puppeteer's method, and it was verified
  // live before being adopted.)
  let box = null;
  try {
    ({ model: box } = await send(tabId, 'DOM.getBoxModel', { backendNodeId }, { sessionId }));
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
      // including any same-process frame offset. That is the space
      // Input.dispatch*Event wants, and it is NOT the space an in-page
      // getBoundingClientRect() answers in when the element lives in an
      // iframe. See frameOffset().
      space: 'viewport',
      // Carried with the point so the input witness listens in the realm the
      // event will land in. One less thing for a call site to remember.
      sessionId,
    };
  }

  // Fallback for zero-size, transformed, or CSS-clipped elements.
  const rect = await callInWorld(
    tabId,
    backendNodeId,
    `function () {
       const r = this.getBoundingClientRect();
       return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
     }`,
    [],
    sessionId,
  );
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    throw new Error('Element has zero size or is not rendered — it may be inside a collapsed or hidden parent.');
  }
  // This one came from inside the element's own frame, so it is frame-relative.
  const offset = await frameOffset(tabId, backendNodeId, sessionId);
  return { ...rect, x: rect.x + offset.x, y: rect.y + offset.y, space: 'viewport', sessionId };
}

/**
 * Where this element's frame sits in the top-level viewport.
 *
 * A function called on a node runs in the realm that owns the node, so for an
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
async function frameOffset(tabId, backendNodeId, sessionId = null) {
  sessionId = sessionId ?? await sessionForNode(tabId, backendNodeId);
  return callInWorld(
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
         x += r.left + frame.clientLeft;
         y += r.top + frame.clientTop;
         view = view.parent;
       }
       return { x, y };
     }`,
    [],
    sessionId,
  ).catch(() => ({ x: 0, y: 0 }));
}

/**
 * Where an out-of-process frame's viewport sits in the top-level viewport:
 * `{x, y, width, height}`, or null when it cannot be established.
 *
 * `DOM.getFrameOwner(frameId)` answers only in the process that holds the
 * `<iframe>` element: the page session for a first-level frame, another child
 * session for a frame nested inside one — so each candidate parent is asked
 * in turn, and a nested frame adds its parent's origin. Measured fresh every
 * time: the parent scrolling moves the frame.
 */
async function frameOrigin(tabId, sessionId, depth = 0) {
  if (!sessionId) return { x: 0, y: 0, width: null, height: null };
  if (depth > 5) return null;
  let frameId = null;
  try {
    frameId = (await send(tabId, 'Page.getFrameTree', {}, { sessionId }))?.frameTree?.frame?.id ?? null;
  } catch {
    return null;
  }
  if (!frameId) return null;
  const others = (await frames.list(tabId).catch(() => []))
    .map((f) => f.sessionId)
    .filter((s) => s && s !== sessionId);
  for (const parent of [null, ...others]) {
    try {
      const owner = await send(tabId, 'DOM.getFrameOwner', { frameId }, { sessionId: parent });
      if (!owner?.backendNodeId) continue;
      const { model } = await send(tabId, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, { sessionId: parent });
      const q = model?.content;
      if (!Array.isArray(q) || q.length < 8) continue;
      const base = parent ? await frameOrigin(tabId, parent, depth + 1) : { x: 0, y: 0 };
      if (!base) return null;
      const r = quadRect(q);
      return { x: base.x + r.x, y: base.y + r.y, width: r.width, height: r.height };
    } catch {
      /* not this parent */
    }
  }
  return null;
}

function quadRect(q) {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * The element's border box in TOP-LEVEL viewport coordinates, plus `origin`,
 * the top-left of the frame process it lives in (0,0 for the page session).
 * `{unmapped:true}` when an out-of-process frame's position is unknown; null
 * when the element has no size.
 */
async function measureBox(tabId, node) {
  const sessionId = node.sessionId ?? null;
  let origin = { x: 0, y: 0 };
  if (sessionId) {
    origin = await frameOrigin(tabId, sessionId);
    if (!origin) return { unmapped: true };
  }
  let rect = null;
  try {
    const { model } = await send(tabId, 'DOM.getBoxModel', { backendNodeId: node.backendNodeId }, { sessionId });
    const q = Array.isArray(model?.border) && model.border.length >= 8 ? model.border : model?.content;
    if (Array.isArray(q) && q.length >= 8 && model.width > 0 && model.height > 0) rect = quadRect(q);
  } catch {
    rect = null;
  }
  if (!rect) {
    const r = await callInWorld(
      tabId,
      node.backendNodeId,
      `function () { const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }`,
      [],
      sessionId,
    ).catch(() => null);
    if (!r || (r.width <= 0 && r.height <= 0)) return null;
    const off = await frameOffset(tabId, node.backendNodeId, sessionId);
    rect = { x: r.x + off.x, y: r.y + off.y, width: r.width, height: r.height };
  }
  return {
    x: rect.x + origin.x,
    y: rect.y + origin.y,
    width: rect.width,
    height: rect.height,
    origin: { x: origin.x, y: origin.y, width: origin.width ?? null, height: origin.height ?? null },
  };
}

/**
 * What of the element can actually be seen: its box intersected with every
 * ancestor that clips it (overflow other than visible — an inner scroll
 * container, a clipped card), across same-process frames, in TOP-document
 * coordinates of the frame process. Null when nothing clips it.
 *
 * Only the viewport used to count, and it was not enough: a button inside an
 * `overflow:auto` panel, scrolled out of the panel, sits inside the viewport
 * while being invisible. It was judged "on screen", the click aimed at a point
 * the panel hides, and the obstruction check (rightly) refused it.
 */
const CLIP_FN = `function () {
  const offsetOf = (doc) => {
    let x = 0, y = 0;
    let view = doc && doc.defaultView;
    for (let depth = 0; view && view !== view.parent && depth < 10; depth++) {
      let frame = null;
      try { frame = view.frameElement; } catch (e) { break; }
      if (!frame) break;
      const r = frame.getBoundingClientRect();
      x += r.left + frame.clientLeft;
      y += r.top + frame.clientTop;
      view = view.parent;
    }
    return { x, y };
  };
  const inner = (el) => {
    const r = el.getBoundingClientRect();
    const o = offsetOf(el.ownerDocument);
    return { x: r.left + el.clientLeft + o.x, y: r.top + el.clientTop + o.y, width: el.clientWidth, height: el.clientHeight };
  };
  let clip = null;
  const cut = (c) => {
    if (!clip) { clip = c; return; }
    const x = Math.max(clip.x, c.x), y = Math.max(clip.y, c.y);
    const r = Math.min(clip.x + clip.width, c.x + c.width), b = Math.min(clip.y + clip.height, c.y + c.height);
    clip = { x, y, width: Math.max(0, r - x), height: Math.max(0, b - y) };
  };
  let node = this;
  for (let depth = 0; node && depth < 200; depth++) {
    let parent = node.parentElement;
    if (!parent) {
      const root = node.getRootNode && node.getRootNode();
      parent = root && root.host ? root.host : null;
    }
    if (!parent) {
      // Out of this document: into the <iframe> that holds it, when reachable.
      const doc = node.ownerDocument || node;
      let frame = null;
      try { frame = doc.defaultView && doc.defaultView.frameElement; } catch (e) { frame = null; }
      if (!frame) break;
      cut(inner(frame));
      node = frame;
      continue;
    }
    const doc = parent.ownerDocument;
    if (parent !== doc.documentElement && parent !== doc.body) {
      const style = doc.defaultView.getComputedStyle(parent);
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') cut(inner(parent));
    }
    node = parent;
  }
  return clip;
}`;

function intersectRect(a, b) {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  return r > x && btm > y ? { x, y, width: r - x, height: btm - y } : null;
}

/**
 * The element's box plus where it can be seen: `region` (viewport ∩ clipping
 * ancestors ∩ its cross-origin frame's rect; null when nothing of it shows),
 * `needRegion` (what to scroll it toward — the clipping container when that
 * is itself on screen, else the viewport, so the page brings the container
 * into view first), and `aim` (the visible part of the box, where a pointer
 * can land).
 */
async function visibleBox(tabId, node, viewport) {
  const box = await measureBox(tabId, node);
  if (!box || box.unmapped) return box;
  const screen = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  let bounds = screen;
  if (node.sessionId && box.origin?.width) {
    bounds = intersectRect(bounds, { x: box.origin.x, y: box.origin.y, width: box.origin.width, height: box.origin.height });
  }
  const clip = await callInWorld(tabId, node.backendNodeId, CLIP_FN, [], node.sessionId ?? null).catch(() => null);
  const clipTop = clip ? { x: clip.x + box.origin.x, y: clip.y + box.origin.y, width: clip.width, height: clip.height } : null;
  const region = clipTop ? intersectRect(bounds, clipTop) : bounds;
  const needRegion = region && region.width >= 24 && region.height >= 24 ? region : (bounds ?? screen);
  const aim = region ? intersectRect(box, region) : null;
  return { box, region, needRegion, aim };
}

/** The top-level viewport in CSS pixels. */
async function layoutViewport(tabId) {
  const m = await send(tabId, 'Page.getLayoutMetrics').catch(() => null);
  const v = m?.cssVisualViewport ?? m?.cssLayoutViewport ?? m?.layoutViewport ?? null;
  let width = Math.floor(v?.clientWidth ?? 0);
  let height = Math.floor(v?.clientHeight ?? 0);
  if (width < 1 || height < 1) {
    const inner = await inWorld(tabId, '({ width: innerWidth, height: innerHeight })').catch(() => null);
    width = Math.floor(inner?.width ?? 1280);
    height = Math.floor(inner?.height ?? 720);
  }
  return { width, height };
}

/**
 * Explicit coordinates for a humanized pointer must be on screen. The humanize
 * planners refuse an off-screen point (a hand cannot reach it without leaving
 * the page) with a RangeError written for the library's caller — "scroll it
 * into view first (planScroll)" — which is not something an agent can call.
 * This says the same in the tool's own terms, before anything is planned.
 * Level `off` keeps v1's behaviour and never gets here.
 */
function requireOnScreen(x, y, viewport, action) {
  if (x >= 0 && y >= 0 && x < viewport.width && y < viewport.height) return;
  throw new Error(
    `${action} at (${Math.round(x)}, ${Math.round(y)}) is outside the visible viewport ` +
      `(${viewport.width}×${viewport.height} CSS pixels). A humanized pointer cannot reach it without leaving the ` +
      'page: scroll first (browser_interact action:"scroll"), or act by ref (browser_snapshot), which reaches the ' +
      'element for you. Coordinates are viewport CSS pixels.',
  );
}

const clampPoint = (p, vp) => ({
  x: Math.min(Math.max(0, p.x), Math.max(0, vp.width - 1)),
  y: Math.min(Math.max(0, p.y), Math.max(0, vp.height - 1)),
});

/**
 * Where the pointer starts: where the last action left it, or — the first time
 * on a tab — a random point in the middle 60% of the viewport (plan §6.1).
 * "Never teleport": the first path starts there, as if the hand had been
 * resting on the mouse.
 */
async function startPoint(tabId, hz, viewport) {
  const known = await pointer.position(tabId);
  if (known) return clampPoint(known, viewport);
  const rng = createRng(subSeed(hz, 'pointer-init'));
  const p = {
    x: Math.round(viewport.width * (0.2 + 0.6 * rng())),
    y: Math.round(viewport.height * (0.2 + 0.6 * rng())),
  };
  await pointer.setPosition(tabId, p.x, p.y);
  return p;
}

/**
 * Bring the pointer to a point fixed by `seed` and the viewport, the way a hand gets there (one
 * humanized move with its own sub-seed; never a jump), so everything planned after it starts from
 * the same place on every run with this seed. A replay does this first: its step 1 used to start
 * wherever the PREVIOUS run left the pointer, so the same seed gave another path, another press
 * point and another timing (interaction review, 2026-09-22: identical press point 225/500 seeds
 * from two starts). A tab with no pointer yet simply starts there. → the home point.
 */
export async function homePointer(tabId, hz, seed) {
  const viewport = await layoutViewport(tabId);
  const rng = createRng(`${seed}:pointer-home`);
  const home = {
    x: Math.round(viewport.width * (0.2 + 0.6 * rng())),
    y: Math.round(viewport.height * (0.2 + 0.6 * rng())),
  };
  const known = await pointer.position(tabId);
  if (!known || hz.level === 'off') {
    await pointer.setPosition(tabId, home.x, home.y);
    return home;
  }
  const from = clampPoint(known, viewport);
  if (Math.hypot(from.x - home.x, from.y - home.y) >= 1) {
    await perform(tabId, planMove(createRng(`${seed}:home-move`), hz.profile, { from, to: home, targetSize: { w: 24, h: 24 }, viewport }));
  }
  return home;
}

const visibleSpan = (start, size, limit) => Math.max(0, Math.min(start + size, limit) - Math.max(start, 0));

/**
 * Enough of the element is visible — in `region` (a rect; a viewport-like
 * {width,height} is the viewport) — that a person would simply point at it.
 */
function mostlyVisible(box, region) {
  if (!box || !region) return false;
  const rx = region.x ?? 0;
  const ry = region.y ?? 0;
  const w = visibleSpan(box.x - rx, box.width, region.width);
  const h = visibleSpan(box.y - ry, box.height, region.height);
  return w > 0 && h > 0
    && w >= Math.min(box.width, region.width) * 0.7 - 0.5
    && h >= Math.min(box.height, region.height) * 0.7 - 0.5;
}

/** How far to scroll so the element lands in the middle of `region`. */
function scrollNeed(box, region) {
  const rx = region.x ?? 0;
  const ry = region.y ?? 0;
  const axis = (start, size, limit) => {
    const seen = visibleSpan(start, size, limit);
    if (seen > 0 && seen >= Math.min(size, limit) * 0.7 - 0.5) return 0;
    return size > limit * 0.6 ? Math.round(start - limit * 0.2) : Math.round(start + size / 2 - limit / 2);
  };
  return { dx: axis(box.x - rx, box.width, region.width), dy: axis(box.y - ry, box.height, region.height) };
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
 *
 * x/y are in the coordinate space of the node's own frame PROCESS: top-level
 * coordinates for the page session (same-process frame offsets are undone
 * below), the frame's own viewport for a cross-origin child session.
 */
async function checkObscured(tabId, backendNodeId, x, y, sessionId = null) {
  sessionId = sessionId ?? await sessionForNode(tabId, backendNodeId);
  const verdict = await callInWorld(
    tabId,
    backendNodeId,
    `function (px, py) {
       // Re-rendered away since the snapshot: nothing to aim at, and nothing "covers" it — the
       // old advice to pass force:true would press whatever replaced it.
       if (this.isConnected === false) return { ok: false, gone: true, reason: 'it is no longer in the page (re-rendered or removed)' };
       // px/py arrive in the top-level coordinates of this frame process, but
       // this function runs in the realm that owns the node, so a hit test has
       // to be done in THIS frame's coordinates. Undo the frame offset.
       const doc = this.ownerDocument;
       let view = doc && doc.defaultView;
       for (let depth = 0; view && view !== view.parent && depth < 10; depth++) {
         let frame = null;
         try { frame = view.frameElement; } catch (e) { break; }
         if (!frame) break;
         const fr = frame.getBoundingClientRect();
         px -= fr.left + frame.clientLeft;
         py -= fr.top + frame.clientTop;
         view = view.parent;
       }

       const stack = doc.elementsFromPoint(px, py);
       if (!stack.length) return { ok: false, reason: 'the point is outside the viewport' };

       const top = stack[0];
       if (top === this || this.contains(top)) return { ok: true };

       // Is the point still INSIDE the element? One that moved since G9 measured it (an animation,
       // a script reacting to the pointer) is not "covered": whatever is under the point now is simply
       // what took its place — often its own container, which used to be blamed for "painting over
       // it", with advice to click through it with force:true (live round 3). Judged on the
       // element's own boxes (an inline element has several); an element with no box is not judged.
       const rects = typeof this.getClientRects === 'function' ? [...this.getClientRects()] : [];
       const inside = rects.some((r) => px >= r.left - 1 && px <= r.right + 1 && py >= r.top - 1 && py <= r.bottom + 1);
       if (rects.length && !inside) {
         return { ok: false, moved: true, reason: 'it is no longer at the point G9 measured — it moved (an animation, or a script reacting to the pointer)' };
       }

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
    sessionId,
  );
  return verdict ?? { ok: true };
}

// ------------------------------------------------------- direct (level off)

async function mouse(tabId, type, x, y, { button = 'left', clickCount = 1, modifiers = 0, sessionId = null, origin = null } = {}) {
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
    // A held button has a real mouse's pressure (0.5), as in lib/humanize.js
    // dispatchMouse; CDP's default of 0 is a tell on pointerdown.
    ...(buttons ? { force: MOUSE_PRESSURE } : {}),
  }, { sessionId });
  // The cursor track speaks top-level coordinates; a frame-space event is
  // recorded only when the frame's origin is known.
  if (!sessionId || origin) {
    pointer.record(tabId, { at: Date.now(), x: x + (origin?.x ?? 0), y: y + (origin?.y ?? 0), buttons, type });
  }
}

/** Remember where a direct action left the pointer, in top-level coordinates. */
async function settlePointer(tabId, x, y, origin) {
  if (origin === null) return null;
  const p = { x: x + (origin?.x ?? 0), y: y + (origin?.y ?? 0) };
  await pointer.setPosition(tabId, p.x, p.y);
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** Origin of a frame process for the direct level's cursor track: {0,0}, a point, or null. */
async function directOrigin(tabId, sessionId) {
  if (!sessionId) return { x: 0, y: 0 };
  return frameOrigin(tabId, sessionId).catch(() => null);
}

/** Only emit code/keyCode when they are actually known. */
function physicalKey(def) {
  return {
    ...(def.code ? { code: def.code } : {}),
    ...(def.keyCode ? { windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode } : {}),
  };
}

/**
 * The key tables live in extension/humanize/keys.js now (one copy for both
 * engines). The direct level sends what v1 sent: a shifted symbol ('!', '@')
 * goes out with NO physical code, because this level sends no Shift, and
 * Digit1/keyCode 49 without Shift describes a different key (directDefinition).
 * Where a value cannot be sent honestly it is omitted: a fabricated keyCode is
 * worse than none.
 */
function directKeyDefinition(ch) {
  return directDefinition(keyDefinition(ch));
}

/**
 * A key name the tables do not know ("Ctrl+Shit+K", "two words") used to go out
 * as a key event carrying that string, which Chromium ignores or rejects —
 * and the agent learned nothing. Refused here, with the fix named. A chord
 * written in the key ("Control+s") is split into key and modifiers.
 */
function keySpec(name, modifiers = 0) {
  const spec = parseKeySpec(String(name ?? ''));
  const key = spec.mods.length ? spec.key : String(name ?? '');
  const mask = modifierMask(modifiers) | modifierMask(spec.mods);
  if (!key || !isKnownKey(keyDefinition(key))) {
    throw new Error(
      `Unknown key ${JSON.stringify(String(name))}. Use a DOM key name (Enter, Tab, Escape, ArrowDown, ` +
        `PageDown, F5 …) or one character; for a shortcut pass key:"s" with modifiers:["Control"].`,
    );
  }
  return { key, modifiers: mask };
}

/**
 * Named keys and chords, v1's primitive: Enter, Tab, Escape, ArrowDown, Control+s …
 *
 * Unwitnessed on purpose: `type()` and `select()` already run inside their own
 * witness or their own verification, and arming a nested witness would race the
 * outer one for the same event.
 */
async function dispatchKey(tabId, { key: name, modifiers = 0, repeat = 1 } = {}) {
  // v1's table, not the humanized one: a shifted symbol ('!', '@') has no
  // physical key at this level, because this level presses no Shift and
  // Digit1/keyCode 49 without Shift is the '1' key (directDefinition).
  const def = directKeyDefinition(name);
  const count = Math.max(1, Math.round(Number(repeat) || 1));
  for (let i = 0; i < count; i++) {
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
  return { pressed: name, modifiers, repeat: count };
}

/**
 * A run of key presses at a human level as ONE plan: each press planned by
 * planKeyPress, separated by the short gap a person leaves between the keys
 * of one form (plan §6.1, 80–250 ms). Back-to-back plans with no gap put the
 * next keydown on the very millisecond the previous keyup went out. Null at
 * level off (v1 dispatches directly).
 */
function keyRunPlan(hz, list, label) {
  if (hz.level === 'off' || !list.length) return null;
  const rng = createRng(subSeed(hz, label));
  const parts = [];
  list.forEach((k, i) => {
    if (i) parts.push(planGap(rng, hz.profile, { after: 'formKey' }));
    parts.push(planKeyPress(rng, hz.profile, { key: k.key, modifiers: k.modifiers ?? 0, repeat: k.repeat ?? 1 }));
  });
  return sequence(parts);
}

/** Key presses at the action's level: direct, or the humanized run (see keyRunPlan). */
async function pressKeys(tabId, hz, list, label, plan = keyRunPlan(hz, list, label)) {
  if (hz.level === 'off') {
    for (const k of list) await dispatchKey(tabId, k);
    return;
  }
  if (plan) await perform(tabId, plan);
}

// ----------------------------------------------------- humanized reaching

const MAX_WHEEL_ROUNDS = 6;

class UnmappedFrame extends Error {}

function describeNode(node, ref) {
  return node?.name || ref || 'the element';
}

const boxMoved = (a, b) => !a || !b || Math.abs(a.x - b.x) >= 0.5 || Math.abs(a.y - b.y) >= 0.5;

/**
 * Re-measure until the element stops moving.
 *
 * A wheel notch's scroll lands a frame or more AFTER its dispatch returns
 * (~100 ms on Chrome for Testing's 10 Hz renderer, a few ms on Edge — live
 * round 2, re-confirmed 2026-09-23). This used to take the first read that matched the box from BEFORE
 * the scroll as "settled" — i.e. the scroll that had not started yet — and
 * then aim at geometry that was about to move: 22/22 CfT hovers and clicks
 * after a scroll missed, and several Edge clicks were refused as "covered by
 * its ancestor" because the point had become the spacer's.
 *
 * - `expectMoveFrom` (the box before a wheel scroll): first wait until the
 *   element has moved at all (up to `moveWithinMs`; one that never moves is
 *   returned as is — the caller counts it as stuck);
 * - then until two consecutive re-measures, 60 ms apart, agree — a quiet
 *   window of ≥ 120 ms, longer than one frame at 10 Hz;
 * - `from`: a measurement already in hand to start the quiet window with.
 * Capped at `capMs`; the last measurement is returned either way.
 */
async function settledBox(tabId, node, { expectMoveFrom = null, from = null, moveWithinMs = 700, capMs = 1500 } = {}) {
  const started = Date.now();
  let last = from;
  if (expectMoveFrom) {
    for (;;) {
      await sleep(60);
      const next = await measureBox(tabId, node);
      if (!next || next.unmapped) return next;
      last = next;
      if (boxMoved(expectMoveFrom, next)) break;
      if (Date.now() - started >= moveWithinMs) return next;
    }
  }
  if (!last) {
    last = await measureBox(tabId, node);
    if (!last || last.unmapped) return last;
  }
  let agree = 0;
  while (Date.now() - started < capMs) {
    await sleep(60);
    const next = await measureBox(tabId, node);
    if (!next || next.unmapped) return next;
    if (boxMoved(last, next)) agree = 0;
    else if (++agree >= 2) return next;
    last = next;
  }
  return last;
}

/**
 * Where a wheel has to be turned to scroll this element toward the viewport,
 * and how much room that scroller has left (so a planned overshoot never runs
 * into the end of the page). The innermost ancestor that can still scroll the
 * needed way wins; when the element sits in no such container, or that
 * container is itself off screen, the top document is scrolled from a point
 * that is not over some other scroller or frame.
 */
async function wheelAnchor(tabId, rng, node, viewport, from, need, box) {
  const info = await callInWorld(tabId, node.backendNodeId, `function (dx, dy) {
    const scrollsWay = (el) => {
      const s = el.ownerDocument.defaultView.getComputedStyle(el);
      const oy = /(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
      const ox = /(auto|scroll|overlay)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
      const canY = oy && (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : dy < 0 ? el.scrollTop > 0 : false);
      const canX = ox && (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : dx < 0 ? el.scrollLeft > 0 : false);
      return canY || canX;
    };
    const up = (el) => {
      if (el.parentElement) return el.parentElement;
      const root = el.getRootNode && el.getRootNode();
      return root && root.host ? root.host : null;
    };
    const doc = this.ownerDocument;
    for (let el = up(this), depth = 0; el && depth < 80; el = up(el), depth++) {
      if (el === doc.body || el === doc.documentElement) break;
      if (scrollsWay(el)) {
        const r = el.getBoundingClientRect();
        return {
          kind: 'element', x: r.x, y: r.y, width: r.width, height: r.height,
          room: { up: el.scrollTop, down: el.scrollHeight - el.clientHeight - el.scrollTop,
                  left: el.scrollLeft, right: el.scrollWidth - el.clientWidth - el.scrollLeft },
        };
      }
    }
    const view = doc.defaultView;
    const se = doc.scrollingElement || doc.documentElement;
    const room = { up: se.scrollTop, down: se.scrollHeight - se.clientHeight - se.scrollTop,
                   left: se.scrollLeft, right: se.scrollWidth - se.clientWidth - se.scrollLeft };
    let framed = false;
    try { framed = view !== view.top; } catch (e) { framed = true; }
    const can = (dy > 0 && room.down > 0) || (dy < 0 && room.up > 0) || (dx > 0 && room.right > 0) || (dx < 0 && room.left > 0);
    return { kind: framed ? 'frame' : 'document', room, can, width: view.innerWidth, height: view.innerHeight };
  }`, [need.dx, need.dy], node.sessionId ?? null).catch(() => ({ kind: 'document' }));

  const origin = box?.origin ?? { x: 0, y: 0 };
  let rect = null;
  if (info.kind === 'element' || (info.kind === 'frame' && info.can)) {
    if (node.sessionId && info.kind === 'frame') {
      // An out-of-process frame's own document: its viewport is where it sits.
      const o = await frameOrigin(tabId, node.sessionId);
      if (o?.width) rect = { x: o.x, y: o.y, width: o.width, height: o.height };
    } else {
      const off = await frameOffset(tabId, node.backendNodeId, node.sessionId ?? null);
      rect = info.kind === 'element'
        ? { x: info.x + off.x + origin.x, y: info.y + off.y + origin.y, width: info.width, height: info.height }
        : { x: off.x + origin.x, y: off.y + origin.y, width: info.width, height: info.height };
    }
  }

  if (rect) {
    const vx = Math.max(rect.x, 0);
    const vy = Math.max(rect.y, 0);
    const vis = { x: vx, y: vy, width: Math.min(rect.x + rect.width, viewport.width) - vx, height: Math.min(rect.y + rect.height, viewport.height) - vy };
    if (vis.width >= 24 && vis.height >= 24) {
      const inside = from.x >= vis.x + 4 && from.x <= vis.x + vis.width - 4 && from.y >= vis.y + 4 && from.y <= vis.y + vis.height - 4;
      const point = inside ? from : {
        x: Math.round(vis.x + vis.width * (0.2 + 0.6 * rng())),
        y: Math.round(vis.y + vis.height * (0.2 + 0.6 * rng())),
      };
      return { point, size: { w: vis.width, h: vis.height }, room: info.room ?? null };
    }
    // The container itself is off screen: scroll the page to it first.
  }
  return documentAnchor(tabId, rng, viewport, from, need);
}

/** A point over the top document that no inner scroller or frame would claim the wheel at. */
async function documentAnchor(tabId, rng, viewport, from, need) {
  const candidates = [clampPoint(from, viewport)];
  for (let i = 0; i < 6; i++) {
    candidates.push({
      x: Math.round(viewport.width * (0.2 + 0.6 * rng())),
      y: Math.round(viewport.height * (0.2 + 0.6 * rng())),
    });
  }
  const pick = await inWorld(tabId, `(() => {
    const points = ${JSON.stringify(candidates)};
    const dx = ${Number(need.dx) || 0}, dy = ${Number(need.dy) || 0};
    const claims = (x, y) => {
      let el = document.elementFromPoint(x, y);
      if (!el) return true;
      if (/^(IFRAME|FRAME|EMBED|OBJECT)$/.test(el.tagName)) return true;
      for (let depth = 0; el && el !== document.body && el !== document.documentElement && depth < 80; depth++) {
        const s = getComputedStyle(el);
        const oy = /(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
        const ox = /(auto|scroll|overlay)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
        if ((dy && oy) || (dx && ox)) return true;
        const root = el.parentElement ? null : (el.getRootNode && el.getRootNode());
        el = el.parentElement || (root && root.host) || null;
      }
      return false;
    };
    const se = document.scrollingElement || document.documentElement;
    const room = { up: se.scrollTop, down: se.scrollHeight - se.clientHeight - se.scrollTop,
                   left: se.scrollLeft, right: se.scrollWidth - se.clientWidth - se.scrollLeft };
    for (let i = 0; i < points.length; i++) if (!claims(points[i].x, points[i].y)) return { index: i, room };
    return { index: 0, room };
  })()`).catch(() => ({ index: 0, room: null }));
  const point = candidates[pick?.index ?? 0] ?? candidates[0];
  return { point, size: { w: viewport.width * 0.6, h: viewport.height * 0.6 }, room: pick?.room ?? null };
}

/**
 * Bring an element into view the way a person does: with the wheel.
 *
 * No scrollIntoView at the human levels (plan §6.1) — a page can see a scroll
 * that no wheel produced. If the wheel cannot get there (a container that does
 * not scroll under the wheel, a page at its end), `human` falls back to a
 * programmatic scroll and SAYS so in the result; `stealth` refuses and says
 * why. A wheel that stalls (the screencast wedge) is reported, never replaced.
 */
async function reachByWheel(tabId, hz, rng, node, label, { beforeInput = null } = {}) {
  const viewport = await layoutViewport(tabId);
  let from = await startPoint(tabId, hz, viewport);
  let seen = await visibleBox(tabId, node, viewport);
  if (!seen) throw new Error('Element has zero size or is not rendered — it may be inside a collapsed or hidden parent.');
  if (seen.unmapped) throw new UnmappedFrame(label);
  // The page may still be moving before this action even starts — a scroll
  // an earlier action began, the page's own smooth scroll, an animation. Aim
  // only at geometry that has stopped (settledBox); re-measure if it moved.
  const still = await settledBox(tabId, node, { from: seen.box });
  if (still && !still.unmapped && boxMoved(still, seen.box)) {
    seen = await visibleBox(tabId, node, viewport);
    if (!seen) throw new Error('Element has zero size or is not rendered — it may be inside a collapsed or hidden parent.');
    if (seen.unmapped) throw new UnmappedFrame(label);
  }

  let rounds = 0;
  let stuck = 0;
  let via = 'none';
  let note = null;
  let wheelDelta = 0;
  while (!mostlyVisible(seen.box, seen.region) && rounds < MAX_WHEEL_ROUNDS) {
    const need = scrollNeed(seen.box, seen.needRegion);
    if (!need.dx && !need.dy) break;
    // A caller that did not check visibility up front checks it here, before the first input —
    // only when input is actually needed (bringIntoView: an element already on screen needs none).
    if (rounds === 0 && beforeInput) await beforeInput();
    rounds += 1;
    const anchor = await wheelAnchor(tabId, rng, node, viewport, from, need, seen.box);
    if (Math.hypot(anchor.point.x - from.x, anchor.point.y - from.y) >= 1) {
      await perform(tabId, planMove(rng, hz.profile, { from, to: anchor.point, targetSize: anchor.size, viewport }));
      from = anchor.point;
    }
    // Whole notches, as a notched wheel turns: the exact pixel need ended every reach on a partial
    // notch (deltaY 47, 88) that no mouse wheel produces, at stealth too (interaction review,
    // 2026-09-22). Rounded to the NEAREST notch, never to none (plain snap:true rounds a small need
    // to 0 — an empty plan, "stuck" twice, then a fallback); centring tolerates half a notch, and the
    // loop measures again.
    const notch = Number(hz.profile?.wheel?.notchPx) > 0 ? Number(hz.profile.wheel.notchPx) : 100;
    const whole = (d) => (d ? Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / notch)) * notch : 0);
    const dy = whole(need.dy);
    const dx = whole(need.dx);
    const plan = planScroll(rng, hz.profile, { at: from, deltaY: dy, deltaX: dx, viewport, room: anchor.room });
    const done = await perform(tabId, plan);
    if (done.end) from = done.end;
    wheelDelta += Math.abs(dy) + Math.abs(dx);
    via = 'wheel';
    const settled = await settledBox(tabId, node, { expectMoveFrom: seen.box });
    if (!settled || settled.unmapped) break;
    const next = await visibleBox(tabId, node, viewport);
    if (!next || next.unmapped) break;
    const moved = Math.abs(next.box.x - seen.box.x) >= 1 || Math.abs(next.box.y - seen.box.y) >= 1;
    seen = next;
    if (!moved && (stuck += 1) >= 2) break;
    if (moved) stuck = 0;
  }

  if (!seen || seen.unmapped) {
    throw new Error(`"${label}" disappeared while it was being scrolled into view. Take a fresh browser_snapshot.`);
  }

  if (!mostlyVisible(seen.box, seen.region) && rounds > 0) {
    // A wheel that moved nothing may simply not have been delivered: a hidden
    // tab in a headed window drops input. Blaming the scroll would send
    // somebody looking at the page for a problem that is the window's.
    // (`hidden`: the action that asked — a click, a scroll — words it, hiddenMidAction.)
    const hidden = await inWorld(tabId, 'document.hidden', { sessionId: node.sessionId ?? null }).catch(() => false);
    if (hidden) {
      const error = (await noInputError(tabId, 'scroll wheel', node.sessionId ?? null));
      error.delivery = 'not-delivered';
      error.hidden = true;
      throw error;
    }
  }

  if (!mostlyVisible(seen.box, seen.region)) {
    if (hz.level === 'stealth') {
      throw new Error(
        `"${label}" is outside the visible page, and ${rounds} round(s) of wheel scrolling did not bring it ` +
          `into view. At the stealth level G9 does not fall back to a programmatic scroll: the page could see a ` +
          `scroll that no wheel produced. Scroll the container that holds it first (browser_interact ` +
          `action:"scroll" with a ref inside that container), or run this step with humanize:"human".`,
      );
    }
    await callInWorld(
      tabId,
      node.backendNodeId,
      `function () { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }`,
      [],
      node.sessionId ?? null,
    );
    seen = await visibleBox(tabId, node, viewport);
    if (!seen || seen.unmapped) throw new Error(`"${label}" could not be scrolled into view.`);
    via = 'programmatic';
    note = 'Wheel scrolling could not bring the element into view (it may sit in a container that does not ' +
      'scroll under the wheel), so it was scrolled into view programmatically. A page listening for wheel ' +
      'events did not see this scroll.';
  }
  // The planners aim inside `box`: hand them the part that can be seen, so a
  // partly clipped element is pointed at where it shows.
  const box = seen.aim ? { ...seen.aim, origin: seen.box.origin } : seen.box;
  return { viewport, from, box, fullBox: seen.box, scroll: { via, rounds, ...(wheelDelta ? { wheelPx: wheelDelta } : {}), ...(note ? { note } : {}) } };
}

/**
 * Bring a resolved element into view the way the tab's input level does, for
 * a tool that needs it ON SCREEN without acting on it (an element screenshot).
 *
 * → `{ level: 'off' }` at level off (the caller keeps v1's own scrollIntoView),
 * else `{ level, humanize, scroll, box, viewport }` with `box` the element's
 * border box in top-level viewport CSS pixels once the page has settled, after
 * the wheel (never scrollIntoView at stealth; human falls back to it only when
 * the wheel cannot get there, and says so in `scroll.note`). An element in a
 * cross-origin frame whose position is unknown is refused at stealth.
 */
export async function bringIntoView(tabId, node, opts = {}) {
  const hz = await levelFor(tabId, opts);
  if (hz.level === 'off') return { level: 'off' };
  // Visibility is checked only if the element must be SCROLLED to: an element shot of something
  // already on screen sends no input and works on a hidden tab, as a viewport shot does. It used to
  // be refused up front with "The scroll was not sent … browser_screenshot keeps working"
  // (interaction review, 2026-09-22).
  const beforeInput = async () => {
    await platform.tabs.ensureFront?.(tabId)?.catch?.(() => null);
    const state = await inWorld(tabId, 'document.visibilityState', { timeoutMs: 5000 }).catch(() => null) ?? await visibilityOf(tabId);
    if (state !== 'hidden') return;
    const error = new Error(
      'The element is off screen and the tab is HIDDEN, so G9 cannot wheel it into view (a browser delivers no wheel ' +
        'input to a hidden page). Nothing was scrolled or captured. Show the tab (browser_tabs action:"focus"), move it ' +
        'out of the way with action:"popout" or "handoff", or take area:"viewport", which works while the tab is hidden' +
        (hz.level === 'human' ? '; at human, humanize:"off" scrolls programmatically instead (the page can see that).' : '.'),
    );
    error.delivery = 'not-delivered';
    error.hidden = true;
    throw error;
  };
  const rng = createRng(subSeed(hz, 'bring-into-view'));
  try {
    const reach = await reachByWheel(tabId, hz, rng, node, describeNode(node, null), { beforeInput });
    return { level: hz.level, humanize: hzInfo(hz), scroll: reach.scroll, box: reach.fullBox, viewport: reach.viewport };
  } catch (err) {
    if (err instanceof UnmappedFrame) {
      if (hz.level === 'stealth') throw unmappedError(err.message);
      return { level: 'off', humanize: hzInfo(hz), note: unmappedNote() };
    }
    throw err;
  }
}

/**
 * Plan a pointer action and re-check obstruction where the button will
 * actually go down (plan.meta.press — the aim point after any settle drift),
 * not at the element's centre. A partly covered element gets a few more aims
 * before the action is refused.
 */
async function aimedPlan(tabId, node, reach, { force, label, makePlan, pressOf }) {
  const tries = force ? 1 : 5;
  let last = null;
  for (let i = 0; i < tries; i++) {
    const plan = makePlan();
    const press = pressOf(plan);
    if (force || !press) return { plan, press };
    const v = await checkObscured(tabId, node.backendNodeId, press.x - reach.box.origin.x, press.y - reach.box.origin.y, node.sessionId ?? null);
    if (v.ok) return { plan, press };
    if (v.gone) throw goneError(label);
    last = v;
  }
  if (last?.moved) throw movedError(label);
  throw new Error(
    `"${label}" is not clickable at the points G9 aimed at inside it — ${last?.reason ?? 'something covers it'}. ` +
      `Close the overlay first, or pass force:true to click through it.`,
  );
}

/** The target left the document (checkObscured `gone`): re-rendered or removed. Never "covered". */
function goneError(label) {
  const error = new Error(
    `"${label}" is no longer in the page — it was re-rendered or removed since the snapshot — so nothing was pressed. ` +
      'Take a fresh browser_snapshot and use the new ref.',
  );
  error.delivery = 'not-delivered';
  return error;
}

/**
 * The target MOVED between G9 measuring it and the press (checkObscured `moved`). Not an overlay,
 * so no "close the overlay / force:true" advice: forcing would press whatever took its place.
 */
function movedError(label) {
  return new Error(
    `"${label}" is no longer where G9 measured it: it moved (an animation, or a script reacting to the pointer) ` +
      'between the measurement and the press, so nothing was pressed. Take a fresh browser_snapshot and try again ' +
      '— if it keeps moving away from the pointer, the page is doing that on purpose.',
  );
}

/**
 * What a press is witnessed by: pointerdown OR mousedown, whichever comes
 * first. When a page cancels pointerdown (its own listener calls
 * preventDefault — drag libraries, canvas apps, many UI kits, anti-bot scripts
 * do), the Pointer Events spec suppresses the compatibility mousedown and
 * mouseup; pointerdown, pointerup and click still arrive. Watching mousedown
 * alone called such a click lost (live round 2: 22/22 runs, the page had
 * received pointerdown, pointerup and click), and an agent told that clicks
 * again. A move is witnessed the same way.
 */
const PRESS_KINDS = Object.freeze(['pointerdown', 'mousedown']);
const MOVE_KINDS = Object.freeze(['pointermove', 'mousemove']);

const firstStep = (plan, type) => plan.steps.find((s) => s.kind === 'mouse' && s.type === type) ?? null;
const pressPoint = (plan) => plan.meta?.press ?? firstStep(plan, 'mousePressed') ?? plan.end;

async function pointerNow(tabId) {
  const p = await pointer.position(tabId);
  return p ? { x: Math.round(p.x), y: Math.round(p.y) } : null;
}

// -------------------------------------------------------------------- click

export async function click(tabId, opts = {}) {
  const hz = await levelFor(tabId, opts);
  const page = await requireVisible(tabId, 'click');
  if (hz.level !== 'off') {
    try {
      return await humanClick(tabId, opts, hz);
    } catch (err) {
      if (err?.hidden) throw await hiddenMidAction(tabId, `${(opts.clickCount ?? 1) > 1 ? 'double ' : ''}click`, page, err);
      if (!(err instanceof UnmappedFrame)) throw err;
      if (hz.level === 'stealth') throw unmappedError(err.message);
      const out = await directClick(tabId, opts);
      return { ...out, humanize: hzInfo(hz), note: unmappedNote() };
    }
  }
  return directClick(tabId, opts);
}

function unmappedError(label) {
  return new Error(
    `"${label}" is inside a cross-origin frame whose position on the page could not be established, so a ` +
      `human-like path to it cannot be planned. At the stealth level G9 does not fall back to direct input. ` +
      `Take a fresh browser_snapshot and try again, or run this step with humanize:"human".`,
  );
}

function unmappedNote() {
  return 'The element is inside a cross-origin frame whose position could not be established, so this action ' +
    'used direct input (no pointer path) inside the frame.';
}

async function directClick(tabId, opts = {}) {
  const { ref, x, y, button = 'left', clickCount = 1, modifiers = 0, force = false, url } = opts;
  let point;
  let target = 'coordinates';
  let node = null;

  if (ref) {
    node = await resolveRef(tabId, ref, url);
    point = await pointFor(tabId, node.backendNodeId, node.sessionId);
    target = `${node.role} "${node.name}"`;
    if (!force) {
      const v = await checkObscured(tabId, node.backendNodeId, point.x, point.y, node.sessionId);
      if (!v.ok) {
        if (v.gone) throw goneError(node.name || ref);
        if (v.moved) throw movedError(node.name || ref);
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

  const ses = point.sessionId ?? null;
  const origin = await directOrigin(tabId, ses);
  const w = await witnessed(tabId, PRESS_KINDS, `${clickCount > 1 ? 'double ' : ''}click`, async () => {
    await mouse(tabId, 'mouseMoved', point.x, point.y, { button: 'none', modifiers, sessionId: ses, origin });
    for (let i = 1; i <= clickCount; i++) {
      await mouse(tabId, 'mousePressed', point.x, point.y, { button, clickCount: i, modifiers, sessionId: ses, origin });
      await mouse(tabId, 'mouseReleased', point.x, point.y, { button, clickCount: i, modifiers, sessionId: ses, origin });
    }
  }, { node, target: node, label: node ? describeNode(node, ref) : null });
  const at = await settlePointer(tabId, point.x, point.y, origin);

  return {
    clicked: target,
    at: { x: Math.round(point.x), y: Math.round(point.y) },
    button,
    clickCount,
    ...deliveryOf(w),
    ...(at ? { pointer: at } : {}),
    humanize: { level: 'off' },
  };
}

async function humanClick(tabId, opts, hz) {
  const { ref, x, y, button = 'left', clickCount = 1, modifiers = 0, force = false, url } = opts;
  const rng = createRng(hz.seed);
  let node = null;
  let target = 'coordinates';
  let reach;
  let label;

  if (ref) {
    node = await resolveRef(tabId, ref, url);
    target = `${node.role} "${node.name}"`;
    label = describeNode(node, ref);
    reach = await reachByWheel(tabId, hz, rng, node, label);
  } else if (x != null && y != null) {
    // Exact coordinates are exact: a one-pixel target, which Fitts' law says
    // takes a careful, slower approach — as it would for a person.
    const viewport = await layoutViewport(tabId);
    requireOnScreen(x, y, viewport, 'click');
    reach = {
      viewport,
      from: await startPoint(tabId, hz, viewport),
      box: { x: x - 0.5, y: y - 0.5, width: 1, height: 1, origin: { x: 0, y: 0 } },
      scroll: { via: 'none', rounds: 0 },
    };
  } else {
    throw new Error('click needs either a ref (from browser_snapshot) or explicit x/y coordinates.');
  }

  const makePlan = () => planClick(rng, hz.profile, {
    from: reach.from, box: reach.box, viewport: reach.viewport, button, clickCount, modifiers,
  });
  const { plan, press } = node
    ? await aimedPlan(tabId, node, reach, { force, label, makePlan, pressOf: pressPoint })
    : { plan: makePlan(), press: null };

  const w = await witnessed(
    tabId,
    PRESS_KINDS,
    `${clickCount > 1 ? 'double ' : ''}click`,
    () => perform(tabId, plan),
    { node, extraMs: plan.durationMs, target: node, label },
  );
  const at = press ?? pressPoint(plan) ?? { x, y };

  return {
    clicked: target,
    at: { x: Math.round(at.x), y: Math.round(at.y) },
    button,
    clickCount,
    ...deliveryOf(w),
    pointer: await pointerNow(tabId),
    durationMs: w.result?.durationMs,
    ...(reach.scroll.via !== 'none' ? { scrolled: reach.scroll } : {}),
    humanize: hzInfo(hz),
  };
}

// -------------------------------------------------------------------- hover

export async function hover(tabId, opts = {}) {
  const hz = await levelFor(tabId, opts);
  const page = await requireVisible(tabId, 'hover');
  if (hz.level !== 'off') {
    try {
      return await humanHover(tabId, opts, hz);
    } catch (err) {
      if (err?.hidden) throw await hiddenMidAction(tabId, 'hover', page, err);
      if (!(err instanceof UnmappedFrame)) throw err;
      if (hz.level === 'stealth') throw unmappedError(err.message);
      return { ...(await directHover(tabId, opts)), humanize: hzInfo(hz), note: unmappedNote() };
    }
  }
  return directHover(tabId, opts);
}

async function directHover(tabId, { ref, x, y, url } = {}) {
  let point;
  let node = null;
  if (ref) {
    node = await resolveRef(tabId, ref, url);
    point = await pointFor(tabId, node.backendNodeId, node.sessionId);
  } else if (x != null && y != null) {
    point = { x, y };
  } else {
    throw new Error('hover needs a ref or x/y coordinates.');
  }
  const ses = point.sessionId ?? null;
  const origin = await directOrigin(tabId, ses);
  const w = await witnessed(tabId, MOVE_KINDS, 'hover', () =>
    mouse(tabId, 'mouseMoved', point.x, point.y, { button: 'none', sessionId: ses, origin }),
  { node, target: node, mode: 'last', label: node ? describeNode(node, ref) : null });
  const at = await settlePointer(tabId, point.x, point.y, origin);
  return {
    hovered: { x: Math.round(point.x), y: Math.round(point.y) },
    ...deliveryOf(w),
    ...(at ? { pointer: at } : {}),
    humanize: { level: 'off' },
  };
}

async function humanHover(tabId, { ref, x, y, url } = {}, hz) {
  const rng = createRng(hz.seed);
  let node = null;
  let plan;
  let reach = null;
  if (ref) {
    node = await resolveRef(tabId, ref, url);
    reach = await reachByWheel(tabId, hz, rng, node, describeNode(node, ref));
    plan = planHover(rng, hz.profile, { from: reach.from, box: reach.box, viewport: reach.viewport });
  } else if (x != null && y != null) {
    const viewport = await layoutViewport(tabId);
    requireOnScreen(x, y, viewport, 'hover');
    const from = await startPoint(tabId, hz, viewport);
    plan = planMove(rng, hz.profile, { from, to: { x, y }, targetSize: { w: 24, h: 24 }, viewport });
  } else {
    throw new Error('hover needs a ref or x/y coordinates.');
  }
  const w = await witnessed(tabId, MOVE_KINDS, 'hover', () => perform(tabId, plan), {
    node, extraMs: plan.durationMs, target: node, mode: 'last', label: node ? describeNode(node, ref) : null,
  });
  const end = plan.end ?? { x, y };
  return {
    hovered: { x: Math.round(end.x), y: Math.round(end.y) },
    ...deliveryOf(w),
    pointer: await pointerNow(tabId),
    ...(reach && reach.scroll.via !== 'none' ? { scrolled: reach.scroll } : {}),
    humanize: hzInfo(hz),
  };
}

// --------------------------------------------------------------------- type

/**
 * What the page says about a field, for the typing planner and the stealth
 * focus check. A typo is never planned into a password field or a masked
 * numeric field (plan §6.3): a person's slip there is corrected, but a masked
 * field reformats as you go and a wrong key can re-shuffle the whole value.
 */
/** Page-side: the typing facts of one element (`el`), shared by both callers below. */
const FIELD_FACTS = `(el) => {
    const attr = (name) => (el.getAttribute && el.getAttribute(name)) || '';
    const type = String(el.type || '').toLowerCase();
    const autocomplete = attr('autocomplete').toLowerCase();
    const inputMode = String(el.inputMode || attr('inputmode')).toLowerCase();
    const password = type === 'password' || /(^|\\s)(current-password|new-password)(\\s|$)/.test(autocomplete);
    const numeric = inputMode === 'numeric' || inputMode === 'decimal' || inputMode === 'tel' || type === 'number' || type === 'tel';
    const placeholder = String(el.placeholder || '');
    const masked = ['data-mask', 'data-inputmask', 'data-format', 'data-pattern', 'mask'].some((a) => el.hasAttribute && el.hasAttribute(a))
      || !!attr('pattern')
      || (typeof el.maxLength === 'number' && el.maxLength > 0 && el.maxLength < 64)
      || /[_#]{2,}|9{3,}|\\d[\\s\\-\\/.]\\d/.test(placeholder);
    return {
      password,
      numericMask: numeric && masked,
      editable: !!el.isContentEditable || (('value' in el) && !el.readOnly && !el.disabled),
      tag: String(el.tagName || '').toLowerCase(),
    };
  }`;

/**
 * Facts that could not be read. `unknown` makes the typist plan NO typos: a
 * field G9 cannot see may be a password field, and "never in a password
 * field" (plan §6.3) does not become "unless the read failed".
 */
const UNKNOWN_FIELD = Object.freeze({ focused: false, password: false, numericMask: false, editable: true, unknown: true });

async function fieldFacts(tabId, node) {
  return callInWorld(tabId, node.backendNodeId, `function () {
    const el = this;
    const doc = el.ownerDocument;
    let active = doc.activeElement;
    for (let depth = 0; active && active.shadowRoot && active.shadowRoot.activeElement && depth < 20; depth++) {
      active = active.shadowRoot.activeElement;
    }
    return Object.assign({ focused: active === el || (!!active && el.contains(active)) }, (${FIELD_FACTS})(el));
  }`, [], node.sessionId ?? null).catch(() => ({ ...UNKNOWN_FIELD }));
}

/**
 * The facts of whatever has keyboard focus — for typing without a ref, where
 * the keys land in the focused element. Followed through open shadow roots
 * and same-origin frames; focus inside a frame G9 cannot read from the top
 * document (another process) is `unknown`.
 */
async function focusedFieldFacts(tabId) {
  return inWorld(tabId, `(() => {
    let el = document.activeElement;
    for (let depth = 0; el && depth < 30; depth++) {
      if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
      if (/^(IFRAME|FRAME)$/.test(el.tagName || '')) {
        let inner = null;
        try { inner = el.contentDocument; } catch (e) { inner = null; }
        if (!inner) return { unknown: true, password: false, numericMask: false };
        el = inner.activeElement;
        continue;
      }
      break;
    }
    if (!el) return { password: false, numericMask: false };
    return (${FIELD_FACTS})(el);
  })()`).catch(() => ({ ...UNKNOWN_FIELD }));
}

async function isFocused(tabId, node) {
  return (await fieldFacts(tabId, node)).focused;
}

/**
 * Type into an element.
 *
 * `fast` uses Input.insertText — a single IME-style insertion that React and
 * Vue controlled inputs handle correctly. Per-character key events are the
 * default because masked fields, autocompletes, and key-filtered numeric
 * inputs only behave correctly with a real keydown/keyup per glyph. At the
 * human levels the per-character events follow a planned rhythm (log-normal
 * intervals, Shift around capitals, rare corrected typos); `typos:false`
 * turns the typos off for one call.
 */
export async function type(tabId, opts = {}) {
  const hz = await levelFor(tabId, opts);
  await requireVisible(tabId, 'typing');
  const { ref, text = '', clear = false, fast = false, pressEnter = false, delayMs = 12, url, typos } = opts;
  const str = String(text ?? '');

  let node = null;
  let facts = null;
  let focusNote = null;
  // Did G9's own click put the caret there? Then it is wherever the click landed.
  let clickedHere = false;
  if (ref) {
    node = await resolveRef(tabId, ref, url);
    if (hz.level === 'off') {
      clickedHere = true;
      const point = await pointFor(tabId, node.backendNodeId, node.sessionId);
      const ses = point.sessionId ?? null;
      const origin = await directOrigin(tabId, ses);
      await mouse(tabId, 'mouseMoved', point.x, point.y, { button: 'none', sessionId: ses, origin });
      await mouse(tabId, 'mousePressed', point.x, point.y, { sessionId: ses, origin });
      await mouse(tabId, 'mouseReleased', point.x, point.y, { sessionId: ses, origin });
      await settlePointer(tabId, point.x, point.y, origin);
      await send(tabId, 'DOM.focus', { backendNodeId: node.backendNodeId }, { sessionId: node.sessionId ?? null }).catch(() => {});
    } else {
      facts = await fieldFacts(tabId, node);
      if (!facts.focused) {
        clickedHere = true;
        // Focus is earned the way a person earns it: by clicking the field.
        const clickHz = { ...hz, seed: subSeed(hz, 'focus') };
        try {
          await humanClick(tabId, { ref, url, force: opts.force === true }, clickHz);
        } catch (err) {
          if (!(err instanceof UnmappedFrame)) throw err;
          if (hz.level === 'stealth') throw unmappedError(err.message);
          await directClick(tabId, { ref, url, force: opts.force === true });
          focusNote = unmappedNote();
        }
        if (!(await isFocused(tabId, node))) {
          if (hz.level === 'stealth') {
            throw new Error(
              `Clicking "${describeNode(node, ref)}" did not give it keyboard focus, and at the stealth level G9 ` +
                `does not focus it programmatically (DOM.focus). Something may cover it, or the page moves focus ` +
                `elsewhere on click. Nothing was typed.`,
            );
          }
          // human: v1's safety net, a direct focus after the click.
          await send(tabId, 'DOM.focus', { backendNodeId: node.backendNodeId }, { sessionId: node.sessionId ?? null }).catch(() => {});
        }
      }
    }
  }

  if (clear) await clearField(tabId, hz, node, ref);
  // Appending: G9's focus click left the caret wherever it landed, which in a non-empty field is
  // often INSIDE the text — " epsilon" typed into "alpha beta gamma delta" became
  // "alpha beta gamma d epsilonelta" at human and stealth (the click aims at a random point),
  // and at off whenever the text reached past the box's centre (interaction review, 2026-09-22).
  // A person appending presses End first; G9 does the same. A caret the agent placed itself (the
  // field was already focused, G9 did not click) is left alone.
  let caretNote = null;
  if (!clear && clickedHere && node && str.length && !fast) caretNote = await caretToEnd(tabId, hz, node);

  // Only the typing itself is witnessed, and only when there is something to
  // type: an empty string legitimately produces no events, and accusing the
  // page of swallowing input it was never sent would be its own false report.
  let plan = null;
  let emit;
  if (fast) {
    // Explicitly asked for, at any level; documented as non-human.
    emit = () => send(tabId, 'Input.insertText', { text: str });
  } else if (hz.level === 'off') {
    emit = async () => {
      for (const ch of [...str]) {
        if (ch === '\n') {
          await dispatchKey(tabId, { key: 'Enter' });
          continue;
        }
        // code and keyCode matter as much as text here: key-filtered numeric
        // inputs and masked fields read event.code / event.keyCode, and sending
        // the character alone is exactly what per-character mode exists to avoid.
        const def = directKeyDefinition(ch);
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
    };
  } else {
    const rng = createRng(subSeed(hz, 'type'));
    facts = facts ?? (node ? await fieldFacts(tabId, node) : await focusedFieldFacts(tabId));
    plan = planType(rng, hz.profile, {
      text: str,
      field: { password: !!facts.password, numericMask: !!facts.numericMask },
      // A field whose facts could not be read gets no typos, whatever was asked.
      ...(facts.unknown ? { typos: false } : typos === false || typos === true ? { typos } : {}),
    });
    emit = () => perform(tabId, plan);
  }

  let w = null;
  // What the field held before the typing: the expected result is this plus the text.
  const before = node && str.length ? await readValue(tabId, node) : '';
  if (str.length) {
    // insertText raises `input` with no keydown; per-character mode raises
    // both. Either one proves the page is receiving input.
    //
    // The `verify` arm is what makes this safe on a single-page app: if the
    // field's contents changed, the typing plainly landed, whatever the event
    // watcher managed to observe. Reading the value is cheap and it is the
    // outcome the caller actually cares about.
    w = await witnessed(
      tabId,
      ['keydown', 'input'],
      'typing',
      emit,
      {
        verify: node ? async () => (await readValue(tabId, node)) !== before : null,
        node,
        extraMs: plan?.durationMs ?? 0,
      },
    );
  } else {
    await emit();
  }

  let enter = null;
  if (pressEnter) enter = await key(tabId, { key: 'Enter', humanize: hz.level === 'off' ? 'off' : hz.profile, seed: subSeed(hz, 'enter') });

  // What actually landed. Reported, never asserted: a digit-only field that
  // rejects the letters of "12ab34" and keeps "1234" is the page working
  // correctly, and the agent needs to see the difference rather than have it
  // called a failure. See the v1.0.15 change-log entry.
  const value = node ? await readValue(tabId, node) : null;
  const typoCount = plan?.meta?.typos ?? 0;
  // Compared with what the field held before plus the text — not with the text alone, which blamed
  // the page for every append to a non-empty field, a perfect one included.
  const expected = `${before ?? ''}${str}`;
  let valueNote = null;
  if (node && !pressEnter && String(value ?? '') !== expected) {
    valueNote = String(value ?? '').includes(str) && String(before ?? '').length
      ? 'The text went in at the caret, not at the end of what the field held: the field holds ' +
        `"${truncateValue(value)}". Check it; pass clear:true to replace the value instead.`
      : 'The field does not hold exactly what was typed — the page filtered or reformatted it.';
  }

  return {
    typed: str.length > 60 ? `${str.slice(0, 57)}…` : str,
    cleared: clear,
    pressedEnter: pressEnter,
    ...(node ? { value: truncateValue(value) } : {}),
    ...(valueNote ? { note: valueNote } : {}),
    ...(caretNote ? { caretNote } : {}),
    delivery: w ? w.delivery : enter ? enter.delivery : 'delivered',
    ...(w?.delivery === 'indeterminate' && w.note ? { deliveryNote: w.note } : {}),
    ...(typoCount ? { typosCorrected: typoCount } : {}),
    ...(fast && hz.level !== 'off' ? { fast: 'Input.insertText was used as asked: one insertion, no key events — not human-like.' } : {}),
    ...(focusNote ? { focusNote } : {}),
    ...(node ? { pointer: await pointerNow(tabId) } : {}),
    humanize: hzInfo(hz),
  };
}

/**
 * Empty a field before typing, and PROVE it is empty.
 *
 * `off`/`human` select through the DOM, not Ctrl+A. Key-filtered fields —
 * numeric inputs are full of them — commonly do
 * `if (e.key.length === 1 && !/[0-9]/.test(e.key)) e.preventDefault()`,
 * which swallows the "a" of the chord and leaves the old value selected by
 * nothing. The typing that followed then APPENDED to the old value while the
 * result still claimed `cleared: true`. Selecting is not an edit, so doing it
 * directly costs nothing the framework needs to observe: the Delete below is
 * still a real trusted key event, and that is what produces input/change.
 *
 * `stealth` uses only keys a person would press: the select-all chord and
 * Backspace, then — for a field that swallowed the chord — End and one
 * Backspace per remaining character.
 */
async function clearField(tabId, hz, node, ref) {
  // Each clearing key is a witnessed key() at this action's level, as v1's
  // were: a clear whose keys never arrived must say so, not report cleared.
  const as = (label) => ({ humanize: hz.level === 'off' ? 'off' : hz.profile, seed: subSeed(hz, label) });

  if (hz.level === 'stealth' && node) {
    const mod = await selectAllModifier(tabId, node.sessionId ?? null);
    await key(tabId, { key: 'a', modifiers: mod, ...as('clear-all') });
    await key(tabId, { key: 'Backspace', ...as('clear-backspace') });
    let left = await readValue(tabId, node);
    if (left) {
      const count = [...String(left)].length;
      await key(tabId, { key: 'End', ...as('clear-end') });
      await key(tabId, { key: 'Backspace', repeat: Math.min(count, 500), ...as('clear-rest') });
      left = await readValue(tabId, node);
    }
    if (left) throw notCleared(node, ref, left);
    return;
  }

  if (node) {
    await callInWorld(
      tabId,
      node.backendNodeId,
      `function () {
         if (typeof this.select === 'function') return this.select();
         const doc = this.ownerDocument;
         const r = doc.createRange();
         r.selectNodeContents(this);
         const s = doc.defaultView.getSelection();
         s.removeAllRanges();
         s.addRange(r);
       }`,
      [],
      node.sessionId ?? null,
    ).catch(() => {});
  } else {
    await key(tabId, { key: 'a', modifiers: await selectAllModifier(tabId), ...as('clear-all') });
  }
  await key(tabId, { key: 'Delete', ...as('clear-delete') });

  // Verify, rather than assume. A clear that silently fails turns "replace"
  // into "append", and the agent has no way to see it in the result.
  if (node) {
    const left = await readValue(tabId, node);
    if (left) throw notCleared(node, ref, left);
  }
}

function notCleared(node, ref, left) {
  return new Error(
    `Could not clear "${node.name || ref}" — it still contains ${JSON.stringify(truncateValue(left))}. ` +
      `The page is intercepting the deletion. Nothing was typed, because typing now would append ` +
      `to the old value instead of replacing it.`,
  );
}

/** Current text of a field, for verifying an edit actually happened. */
/**
 * Put the caret at the end of a non-empty field before appending. Stealth presses a real key at
 * the action's level — End (Control+End in a textarea or contenteditable; Meta+ArrowDown on a
 * Mac); off and human collapse the selection in the DOM (as clearField selects), falling back to
 * the key where the DOM cannot (type=email/number refuse setSelectionRange). → a note when the
 * caret could not be confirmed at the end, else null.
 */
async function caretToEnd(tabId, hz, node) {
  const sessionId = node.sessionId ?? null;
  const facts = await callInWorld(tabId, node.backendNodeId, `function () {
    const el = this;
    const value = el.value != null ? String(el.value) : String(el.textContent || '');
    const multiline = el.tagName === 'TEXTAREA' || !!el.isContentEditable;
    return { length: value.length, multiline, editable: !!el.isContentEditable };
  }`, [], sessionId).catch(() => null);
  if (!facts || !facts.length) return null;
  const atEnd = () => callInWorld(tabId, node.backendNodeId, `function () {
    const el = this;
    try {
      if (typeof el.selectionStart === 'number' && el.value != null) return el.selectionStart === String(el.value).length && el.selectionEnd === el.selectionStart;
    } catch (e) { /* type=email/number: no selection API */ }
    return null;
  }`, [], sessionId).catch(() => null);
  let moved = false;
  if (hz.level !== 'stealth') {
    moved = await callInWorld(tabId, node.backendNodeId, `function () {
      const el = this;
      try {
        if (el.isContentEditable) {
          const doc = el.ownerDocument;
          const range = doc.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          const sel = doc.defaultView.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          return true;
        }
        if (typeof el.setSelectionRange === 'function' && el.value != null) {
          const n = String(el.value).length;
          el.setSelectionRange(n, n);
          return true;
        }
      } catch (e) { /* email/number inputs: the key below */ }
      return false;
    }`, [], sessionId).catch(() => false);
  }
  if (!moved) {
    const mac = (await selectAllModifier(tabId, sessionId)) === MODIFIERS.Meta;
    const chord = facts.multiline
      ? (mac ? { key: 'ArrowDown', modifiers: MODIFIERS.Meta } : { key: 'End', modifiers: MODIFIERS.Control })
      : { key: 'End' };
    await key(tabId, { ...chord, humanize: hz.level === 'off' ? 'off' : hz.profile, seed: subSeed(hz, 'append-end') });
  }
  const end = await atEnd();
  return end === false
    ? 'G9 moved the caret to the end of the field before typing, but the field reports it elsewhere (the page moves it).'
    : null;
}

function readValue(tabId, node) {
  return callInWorld(
    tabId,
    node.backendNodeId,
    `function () { return this.value != null ? this.value : (this.textContent || ''); }`,
    [],
    node.sessionId ?? null,
  ).catch(() => '');
}

function truncateValue(s) {
  const str = String(s ?? '');
  return str.length > 40 ? `${str.slice(0, 39)}…` : str;
}

// ---------------------------------------------------------------------- key

/**
 * Named keys and chords: Enter, Tab, Escape, ArrowDown, Control+s …
 *
 * Witnessed at this level only (see dispatchKey). The witness listens in the
 * page and every attached cross-origin frame, because a key goes wherever
 * focus is.
 */
export async function key(tabId, opts = {}) {
  const { key: name, modifiers } = keySpec(opts.key, opts.modifiers ?? 0);
  const hz = await levelFor(tabId, opts);
  await requireVisible(tabId, `key "${opts.key}"`);
  const repeat = Math.max(1, Math.round(Number(opts.repeat) || 1));
  if (hz.level === 'off') {
    const w = await witnessed(tabId, 'keydown', `key "${opts.key}"`, () => dispatchKey(tabId, { key: name, modifiers, repeat }));
    return { ...w.result, ...deliveryOf(w), humanize: { level: 'off' } };
  }
  const rng = createRng(hz.seed);
  const plan = planKeyPress(rng, hz.profile, { key: name, modifiers: modifierNames(modifiers), repeat });
  const w = await witnessed(tabId, 'keydown', `key "${opts.key}"`, () => perform(tabId, plan), { extraMs: plan.durationMs });
  return { pressed: name, modifiers, repeat, ...deliveryOf(w), humanize: hzInfo(hz) };
}

// ------------------------------------------------------------------- scroll

/** Document scroll position (and, with a node, its scroll container's). */
async function scrollState(tabId, node) {
  const doc = await inWorld(tabId, '({ x: scrollX, y: scrollY, hidden: document.hidden })').catch(() => null);
  let inner = null;
  if (node) {
    inner = await callInWorld(tabId, node.backendNodeId, `function () {
      const up = (el) => {
        if (el.parentElement) return el.parentElement;
        const root = el.getRootNode && el.getRootNode();
        return root && root.host ? root.host : null;
      };
      const doc = this.ownerDocument;
      for (let el = this, depth = 0; el && depth < 80; el = up(el), depth++) {
        if (el === doc.body || el === doc.documentElement) break;
        const s = getComputedStyle(el);
        if ((/(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1)
          || (/(auto|scroll|overlay)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1)) {
          return { x: el.scrollLeft, y: el.scrollTop };
        }
      }
      const se = doc.scrollingElement || doc.documentElement;
      return { x: se.scrollLeft, y: se.scrollTop, frame: doc.defaultView !== doc.defaultView.top };
    }`, [], node.sessionId ?? null).catch(() => null);
  }
  return doc ? { ...doc, inner } : null;
}

function scrollMoved(before, after) {
  if (!before || !after) return false;
  if (after.x !== before.x || after.y !== before.y) return true;
  return !!before.inner && !!after.inner && (after.inner.x !== before.inner.x || after.inner.y !== before.inner.y);
}

/**
 * Read the scroll position until the page has STOPPED scrolling.
 *
 * Wheel scrolling runs on the compositor: the CDP command resolves when the
 * event is queued and the position updates afterwards — so first wait until it
 * moves at all (up to `moveWithinMs`: a page already at its edge legitimately
 * never does). This used to stop there, at the FIRST read that differed:
 * a mid-scroll position was reported as the result, and the next action aimed
 * at geometry still in motion. Measured (live round 2): in 50/50 runs a scroll
 * returned while a notch's scroll was still to land (95–97 ms later on Chrome
 * for Testing, 4–7 ms on Edge), e.g. "y=500" with y=600 arriving 99 ms after
 * the return — then the following click pressed where the button had been.
 * Now it keeps reading, `everyMs` apart, until the position has not changed
 * for `quietMs` (longer than a frame at 10 Hz), capped at `capMs`.
 *
 * → { after, moved (net, before → after), movedAtAll, settled }
 */
async function settledScroll(tabId, node, before, { moveWithinMs = 600, quietMs = 160, everyMs = 80, capMs = 1500 } = {}) {
  const started = Date.now();
  let last = await scrollState(tabId, node);
  let movedAtAll = scrollMoved(before, last);
  while (!movedAtAll && Date.now() - started < moveWithinMs) {
    await sleep(60);
    last = await scrollState(tabId, node);
    movedAtAll = scrollMoved(before, last);
  }
  if (!movedAtAll) return { after: last, moved: false, movedAtAll: false, settled: true };
  let quietSince = Date.now();
  let settled = false;
  while (Date.now() - started < capMs) {
    await sleep(everyMs);
    const next = await scrollState(tabId, node);
    if (!next) break;
    if (scrollMoved(last, next)) quietSince = Date.now();
    last = next;
    if (Date.now() - quietSince >= quietMs) { settled = true; break; }
  }
  return { after: last, moved: scrollMoved(before, last), movedAtAll: true, settled };
}

const STILL_SCROLLING_NOTE =
  'The page was still scrolling when G9 stopped waiting (1.5 s after the last notch), so the position above may ' +
  'not be final. Take a browser_snapshot before acting on geometry.';

export async function scroll(tabId, opts = {}) {
  const hz = await levelFor(tabId, opts);
  const page = await requireVisible(tabId, 'scroll');
  if (hz.level !== 'off') {
    try {
      return await humanScroll(tabId, opts, hz);
    } catch (err) {
      if (err?.hidden) throw await hiddenMidAction(tabId, 'scroll', page, err);
      if (!(err instanceof UnmappedFrame)) throw err;
      if (hz.level === 'stealth') throw unmappedError(err.message);
      return { ...(await directScroll(tabId, opts)), humanize: hzInfo(hz), note: unmappedNote() };
    }
  }
  return directScroll(tabId, opts);
}

async function directScroll(tabId, { ref, direction = 'down', amount = 400, x, y, url } = {}) {
  let px = x ?? 400;
  let py = y ?? 300;
  let node = null;
  if (ref) {
    node = await resolveRef(tabId, ref, url);
    const p = await pointFor(tabId, node.backendNodeId, node.sessionId);
    px = p.x;
    py = p.y;
  }
  const deltas = { down: [0, amount], up: [0, -amount], right: [amount, 0], left: [-amount, 0] };
  const [deltaX, deltaY] = deltas[direction] ?? deltas.down;

  // Scroll checks its OUTCOME, not only a `wheel` event.
  //
  // Wheel is the one input Chromium may handle entirely on the compositor
  // thread, so a scroll that works perfectly can produce no DOM `wheel` event
  // for a listener to see. Witnessing it alone reported working scrolls as
  // failures, and the retry loop that hid that made it worse: during an active
  // screencast the extra round trips competed with frame ingestion until the
  // call timed out. The scroll position is the honest signal; a seen `wheel`
  // is accepted as a positive one.
  const before = await scrollState(tabId, node);
  const sessionId = node?.sessionId ?? null;
  const origin = await directOrigin(tabId, sessionId);
  const witness = await armWitness(tabId, ['wheel'], WITNESS_TIMEOUT_MS, node ? [sessionId] : [null]);

  // A wheel dispatch can wedge, and does so reproducibly while a screencast is
  // running: `Page.startScreencast` is active, `Input.dispatchMouseEvent` with
  // `mouseWheel` is accepted, and the promise never settles. Recording a bug
  // while scrolling through it is not an exotic thing to do — it is the
  // ordinary way someone reports a scrolling bug — so at this level it falls
  // back rather than failing, and says which one it used.
  let via = 'wheel';
  try {
    await send(
      tabId,
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: px, y: py, deltaX, deltaY, pointerType: 'mouse' },
      { timeoutMs: 4000, sessionId },
    );
    if (!sessionId || origin) pointer.record(tabId, { at: Date.now(), x: px + (origin?.x ?? 0), y: py + (origin?.y ?? 0), buttons: 0, type: 'mouseWheel' });
  } catch (err) {
    if (!/did not return after/.test(String(err?.message ?? err))) {
      witness.release();
      throw err;
    }
    try {
      await inWorld(tabId, `scrollBy(${Number(deltaX) || 0}, ${Number(deltaY) || 0})`, { idempotent: false });
    } catch (fallbackErr) {
      witness.release();
      throw fallbackErr;
    }
    via = 'programmatic';
  }
  const pointerAt = await settlePointer(tabId, px, py, origin);

  // Poll for the movement instead of reading it once, and until it has
  // stopped (settledScroll).
  //
  // Wheel scrolling is handled on the COMPOSITOR thread: the CDP command
  // resolves as soon as the event is queued, and the scroll position updates
  // afterwards. Reading immediately therefore caught the old position and
  // reported `moved: false` for a scroll that worked perfectly — on Instagram,
  // scrollY was already 300 by the time anyone looked.
  const { after, moved, movedAtAll, settled } = await settledScroll(tabId, node, before);
  const saw = movedAtAll ? (witness.release(), { delivery: 'delivered' }) : await witness.settle();

  // Only accuse the browser when the page also could not have received it.
  // A page already at its edge legitimately does not move.
  if (!movedAtAll && saw.delivery !== 'delivered' && after?.hidden) {
    const error = (await noInputError(tabId, 'scroll', sessionId));
    error.delivery = 'not-delivered';
    throw error;
  }

  return {
    scrolled: direction,
    amount,
    moved,
    via,
    delivery: movedAtAll || saw.delivery === 'delivered' || via === 'programmatic' ? 'delivered' : 'indeterminate',
    ...(after ? { position: { x: after.x, y: after.y } } : {}),
    ...(settled ? {} : { settled: false, settleNote: STILL_SCROLLING_NOTE }),
    ...(pointerAt ? { pointer: pointerAt } : {}),
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
    humanize: { level: 'off' },
  };
}

async function humanScroll(tabId, { ref, direction = 'down', amount = 400, x, y, url, snap = false } = {}, hz) {
  const rng = createRng(hz.seed);
  const deltas = { down: [0, amount], up: [0, -amount], right: [amount, 0], left: [-amount, 0] };
  const [deltaX, deltaY] = deltas[direction] ?? deltas.down;
  let node = null;
  let viewport;
  let from;
  let reach = null;
  let room = null;

  // Put the hand where the wheel must turn: over the element (a ref inside an
  // inner container scrolls that container), over the given point, or where
  // the pointer already rests.
  if (ref) {
    node = await resolveRef(tabId, ref, url);
    reach = await reachByWheel(tabId, hz, rng, node, describeNode(node, ref));
    viewport = reach.viewport;
    const hoverPlan = planHover(rng, hz.profile, { from: reach.from, box: reach.box, viewport });
    await perform(tabId, hoverPlan);
    from = hoverPlan.end ?? reach.from;
  } else {
    viewport = await layoutViewport(tabId);
    from = await startPoint(tabId, hz, viewport);
    let to = null;
    if (x != null && y != null) {
      requireOnScreen(x, y, viewport, 'scroll');
      to = { x, y };
    } else {
      // No element named means the DOCUMENT scrolls (the tool's contract: "pass
      // a ref inside" an inner container). A wheel turned wherever the pointer
      // last rested can land on an inner scroller — a sidebar, a code block —
      // and scroll that instead, which is also how a replayed page scroll went
      // to the wrong place. The resting point is kept when nothing claims it.
      const anchor = await documentAnchor(tabId, rng, viewport, from, { dx: deltaX, dy: deltaY });
      to = anchor.point;
      // How far the document can still go: a planned overshoot into the end
      // of the page would scroll nothing, and its scroll-back would then move
      // the page BACK by that much.
      room = anchor.room;
    }
    if (Math.hypot(to.x - from.x, to.y - from.y) >= 1) {
      await perform(tabId, planMove(rng, hz.profile, { from, to, targetSize: { w: 24, h: 24 }, viewport }));
      from = to;
    }
  }

  const before = await scrollState(tabId, node);
  // snap: whole notches only (replay's scroll to a recorded resting place). An explicit agent
  // amount is kept exact, so one that is not a multiple of a notch ends on a partial notch.
  const plan = planScroll(rng, hz.profile, { at: from, deltaY, deltaX, viewport, room, snap: snap === true });
  const witness = await armWitness(tabId, ['wheel'], WITNESS_TIMEOUT_MS + plan.durationMs, node ? [node.sessionId ?? null] : [null]);
  try {
    // A stalled wheel throws here and is REPORTED: at these levels it is never
    // replaced by a programmatic scroll (plan §6.2).
    await perform(tabId, plan);
  } catch (err) {
    witness.release();
    throw err;
  }

  // The result is the position the page SETTLED at, not the first one that
  // differed (settledScroll says why).
  const { after, moved, movedAtAll, settled } = await settledScroll(tabId, node, before);
  const saw = movedAtAll ? (witness.release(), { delivery: 'delivered' }) : await witness.settle();
  if (!movedAtAll && saw.delivery !== 'delivered' && after?.hidden) {
    const error = (await noInputError(tabId, 'scroll', node?.sessionId ?? null));
    error.delivery = 'not-delivered';
    error.hidden = true;
    throw error;
  }

  const notches = plan.steps.filter((s) => s.kind === 'mouse' && s.type === 'mouseWheel').length;
  return {
    scrolled: direction,
    amount,
    moved,
    via: 'wheel',
    notches,
    delivery: movedAtAll || saw.delivery === 'delivered' ? 'delivered' : 'indeterminate',
    ...(after ? { position: { x: after.x, y: after.y } } : {}),
    ...(settled ? {} : { settled: false, settleNote: STILL_SCROLLING_NOTE }),
    pointer: await pointerNow(tabId),
    ...(reach && reach.scroll.via !== 'none' ? { reached: reach.scroll } : {}),
    ...(moved
      ? {}
      : {
          note: 'The page did not move. It may already be at that edge, or the thing that scrolls ' +
            'is an inner container rather than the document — pass a ref inside it.',
        }),
    humanize: hzInfo(hz),
  };
}

// --------------------------------------------------------------------- drag

export async function drag(tabId, opts = {}) {
  const hz = await levelFor(tabId, opts);
  const page = await requireVisible(tabId, 'drag');
  if (hz.level !== 'off') {
    try {
      return await humanDrag(tabId, opts, hz);
    } catch (err) {
      if (err?.hidden) throw await hiddenMidAction(tabId, 'drag', page, err);
      if (!(err instanceof UnmappedFrame)) throw err;
      if (hz.level === 'stealth') throw unmappedError(err.message);
      return { ...(await directDrag(tabId, opts)), humanize: hzInfo(hz), note: unmappedNote() };
    }
  }
  return directDrag(tabId, opts);
}

async function directDrag(tabId, { from, to, url, steps = 12 } = {}) {
  const a = await resolveRef(tabId, from, url);
  const b = await resolveRef(tabId, to, url);
  // Both ends must be on screen AT THE SAME TIME, measured after the last scroll. v1 centred the
  // grip, then centred the drop target — which on a wide page scrolled the grip away (Engine 2
  // live test: scroll(844,1305), the grip at x=-794, and the press landed on the track under
  // it; the witness, then blind to where a press landed, said "delivered"). The drop target is
  // brought in only as far as needed ('nearest'), and the grip is re-measured where it is now.
  await pointFor(tabId, a.backendNodeId, a.sessionId);
  const pb = await pointFor(tabId, b.backendNodeId, b.sessionId, { align: 'nearest' });
  const pa = await pointFor(tabId, a.backendNodeId, a.sessionId, { align: 'nearest' });
  const pbNow = await pointFor(tabId, b.backendNodeId, b.sessionId, { align: 'nearest' });
  if (Math.abs(pbNow.x - pb.x) >= 1 || Math.abs(pbNow.y - pb.y) >= 1) {
    throw new Error(
      `"${describeNode(a, from)}" and "${describeNode(b, to)}" cannot both be on screen at once, so a drag between them ` +
        'would need the page to auto-scroll while the button is held. Nothing was dragged. Resize the viewport ' +
        '(browser_emulate) or move the item in smaller drags.',
    );
  }
  // Both ends must be addressed in one coordinate space: the frame's own when
  // both live in the same cross-origin frame, else the page's.
  const ses = pa.sessionId && pa.sessionId === pb.sessionId ? pa.sessionId : null;
  const origin = await directOrigin(tabId, ses);

  const w = await witnessed(tabId, PRESS_KINDS, 'drag', async () => {
    await mouse(tabId, 'mouseMoved', pa.x, pa.y, { button: 'none', sessionId: ses, origin });
    await mouse(tabId, 'mousePressed', pa.x, pa.y, { sessionId: ses, origin });
    // Intermediate moves matter: HTML5 drag-and-drop and most JS drag libraries
    // ignore a single jump from source to target.
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await mouse(tabId, 'mouseMoved', pa.x + (pb.x - pa.x) * t, pa.y + (pb.y - pa.y) * t, { sessionId: ses, origin });
      await sleep(16);
    }
    await mouse(tabId, 'mouseReleased', pb.x, pb.y, { sessionId: ses, origin });
  }, { sessions: [ses], target: a, label: describeNode(a, from) });
  const at = await settlePointer(tabId, pb.x, pb.y, origin);
  return { dragged: `${a.name || from} -> ${b.name || to}`, ...deliveryOf(w), ...(at ? { pointer: at } : {}), humanize: { level: 'off' } };
}

async function humanDrag(tabId, { from, to, url, force = false } = {}, hz) {
  const a = await resolveRef(tabId, from, url);
  const b = await resolveRef(tabId, to, url);
  const rng = createRng(hz.seed);
  const reach = await reachByWheel(tabId, hz, rng, a, describeNode(a, from));
  const toSeen = await visibleBox(tabId, b, reach.viewport);
  if (!toSeen) throw new Error(`The drop target "${describeNode(b, to)}" has zero size or is not rendered.`);
  if (toSeen.unmapped) throw new UnmappedFrame(describeNode(b, to));
  const toBox = toSeen.aim ?? toSeen.box;
  if (!mostlyVisible(toSeen.box, toSeen.region)) {
    throw new Error(
      `The drop target "${describeNode(b, to)}" is not on screen while the source "${describeNode(a, from)}" is. ` +
        `A person could not drag between them without the page auto-scrolling. Scroll so both are visible, ` +
        `or move the item in smaller drags.`,
    );
  }
  const { plan } = await aimedPlan(tabId, a, reach, {
    force,
    label: describeNode(a, from),
    makePlan: () => planDrag(rng, hz.profile, { from: reach.from, fromBox: reach.box, toBox, viewport: reach.viewport }),
    pressOf: (p) => firstStep(p, 'mousePressed'),
  });
  // The press lands in the source's frame process; that is where to listen —
  // on the source itself, so a press that landed elsewhere is not a drag.
  const w = await witnessed(tabId, PRESS_KINDS, 'drag', () => perform(tabId, plan), {
    node: a, extraMs: plan.durationMs, target: a, label: describeNode(a, from),
  });
  return {
    dragged: `${a.name || from} -> ${b.name || to}`,
    ...deliveryOf(w),
    pointer: await pointerNow(tabId),
    ...(reach.scroll.via !== 'none' ? { scrolled: reach.scroll } : {}),
    humanize: hzInfo(hz),
  };
}

// ------------------------------------------------------------------- select

/**
 * The page-side planner of a selection, as a function declaration (exported for its unit test, as
 * WITNESS_FN is). It decides WHICH keys will be needed: which options can be selected at all, and
 * how far the selection has to move from where it is now.
 */
export const SELECT_PLAN_FN = `function (wanted) {
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
       // The keys move between SELECTABLE options only: Chromium's arrows and Home skip a disabled
       // option, one in a disabled optgroup, and one that is not rendered. Counted on the full list,
       // every target after the usual disabled "Choose…" placeholder was off by one — Apple gave
       // Banana, and the page blamed (interaction review, 2026-09-22).
       const view0 = this.ownerDocument.defaultView;
       const shown = (el) => { try { return view0.getComputedStyle(el).display !== 'none'; } catch (e) { return true; } };
       const selectable = options.map((opt) => {
         const group = opt.parentElement && opt.parentElement.tagName === 'OPTGROUP' ? opt.parentElement : null;
         return !opt.disabled && !(group && (group.disabled || !shown(group))) && shown(opt) && !opt.hidden;
       });
       const blocked = indices.filter((i) => !selectable[i]);
       if (blocked.length) {
         return {
           ok: false,
           reason: 'the option ' + blocked.map((i) => JSON.stringify(options[i].textContent.trim() || options[i].value)).join(', ') +
             ' cannot be selected (disabled, in a disabled group, or not shown); nothing was sent',
         };
       }
       const count = (from, to) => { let n = 0; for (let i = from; i <= to; i++) if (i >= 0 && selectable[i]) n += 1; return n; };
       const current = this.selectedIndex;
       // Single select: from the CURRENT option, never from the top (Home walked every option
       // above the target, firing a trusted change for each — an onchange-submitting select
       // submitted the first one — and re-selecting the current value fired three).
       let move = null;
       if (!this.multiple) {
         const target = indices[0];
         if (target === current) move = { key: null, repeat: 0 };
         else if (target > current) move = { key: 'ArrowDown', repeat: count(current + 1, target) };
         else move = { key: 'ArrowUp', repeat: count(target, current - 1) };
       }
       // Multi select: Ctrl+Arrow moves from the list's focused option, which a page cannot read,
       // so each toggle starts at Ctrl+Home (the first selectable option) and counts selectable
       // options above the one it wants.
       const rank = options.map((_, i) => count(0, i - 1));
       const view = this.ownerDocument.defaultView;
       const proof = { target: this, trusted: false, changes: 0 };
       // NOT { once: true }. A once-listener is consumed by the FIRST input or
       // change event on the page, whoever fired it — an unrelated autosave, a
       // sibling field, anything — and the real event for this select then
       // arrives with nobody listening, which reported a working selection as
       // an untrusted one. Filter by target instead, and detach explicitly.
       const observe = (event) => {
         if (event.target === proof.target && event.isTrusted) {
           proof.trusted = true;
           if (event.type === 'change') proof.changes += 1;
         }
       };
       proof.detach = () => {
         view.removeEventListener('input', observe, true);
         view.removeEventListener('change', observe, true);
         if (view.__g9SelectProof === proof) delete view.__g9SelectProof;
       };
       if (view.__g9SelectProof && view.__g9SelectProof.detach) view.__g9SelectProof.detach();
       view.addEventListener('input', observe, { capture: true });
       view.addEventListener('change', observe, { capture: true });
       view.__g9SelectProof = proof;
       return {
         ok: true,
         multiple: this.multiple,
         indices,
         move,
         rank,
         selected: options.map((o, index) => o.selected ? index : -1).filter(index => index >= 0),
         chosen: indices.map(index => options[index].textContent.trim() || options[index].value),
       };
     }`;

/** A select whose planned keys take longer than this is refused before any key (the call deadline is 120 s). */
const SELECT_MAX_MS = 90_000;

/** Select <option>s by value, label, or visible text. */
export async function select(tabId, opts = {}) {
  const { ref, values, url } = opts;
  const hz = await levelFor(tabId, opts);
  await requireVisible(tabId, 'selection');
  const node = await resolveRef(tabId, ref, url);
  const sessionId = node.sessionId ?? null;
  const wanted = (Array.isArray(values) ? values : [values]).map(String);
  // The proof object lives on the select's window IN G9'S WORLD: invisible to
  // the page, and still told about the page's own input/change events.
  const plan = await callInWorld(
    tabId,
    node.backendNodeId,
    SELECT_PLAN_FN,
    [wanted],
    sessionId,
  );

  if (!plan?.ok) {
    throw new Error(
      `Could not select ${JSON.stringify(wanted)}: ${plan?.reason}.` +
        (plan?.available ? ` Available options: ${plan.available.join(' | ')}` : ''),
    );
  }

  const detachProof = () => callInWorld(tabId, node.backendNodeId, `function () {
    const p = this.ownerDocument.defaultView.__g9SelectProof;
    if (p && p.detach) p.detach();
  }`, [], sessionId).catch(() => {});

  // Already selected: nothing to do, and nothing is sent — no focus, no click, no key. Every key
  // on a closed select is a trusted change the page acts on.
  const alreadyThere = !plan.multiple
    ? plan.move?.key == null
    : JSON.stringify([...plan.selected].sort((a, b) => a - b)) === JSON.stringify([...plan.indices].sort((a, b) => a - b));
  if (alreadyThere) {
    await detachProof();
    return {
      selected: plan.chosen,
      trustedEvent: 'not-needed',
      changeEvents: 0,
      note: 'Already selected: no input was sent.',
      delivery: 'delivered',
      humanize: hzInfo(hz),
    };
  }

  const presses = [];
  if (!plan.multiple) {
    // These are browser input-pipeline key events. Unlike assigning
    // option.selected and dispatching Event(), the resulting input/change
    // events are trusted and controlled components see a real user gesture.
    // Relative to the current option, over selectable options only (see the plan above).
    if (plan.move?.key && plan.move.repeat > 0) presses.push({ key: plan.move.key, repeat: plan.move.repeat });
  } else {
    const navModifier = await selectAllModifier(tabId, sessionId);
    const desired = new Set(plan.indices);
    const selected = new Set(plan.selected);
    const max = Math.max(...plan.indices, ...plan.selected, 0);
    for (let index = 0; index <= max; index++) {
      if (desired.has(index) === selected.has(index)) continue;
      presses.push({ key: 'Home', modifiers: navModifier });
      const steps = plan.rank?.[index] ?? index;
      if (steps) presses.push({ key: 'ArrowDown', modifiers: navModifier, repeat: steps });
      presses.push({ key: 'Space', modifiers: navModifier });
    }
  }
  // Planned before focusing, so a refusal below sends nothing at all.
  const keyPlan = keyRunPlan(hz, presses, 'select');
  {
    // A move that long would run past the call's deadline (the humanized typist presses about
    // 4 keys a second): refused BEFORE any key, with the fix, instead of being cut off mid-way.
    if ((keyPlan?.durationMs ?? 0) > SELECT_MAX_MS) {
      await detachProof();
      throw new Error(
        `Selecting ${JSON.stringify(plan.chosen)} needs ${presses.reduce((n, p) => n + (p.repeat ?? 1), 0)} key presses from ` +
          `the current option — about ${Math.round(keyPlan.durationMs / 1000)} s of human typing, past the call's deadline. ` +
          'Nothing was sent. Pass humanize:"off" (direct keys, a few seconds), or type the option\'s first letters into the ' +
          'focused select (browser_interact action:"key") to jump near it first.',
      );
    }
  }

  try {
    if (hz.level === 'stealth') {
      // No DOM.focus at this level: focus is earned by clicking, and the popup
      // the click opens is closed with Escape, as a keyboard user would.
      if (!(await isFocused(tabId, node))) {
        await humanClick(tabId, { ref, url }, { ...hz, seed: subSeed(hz, 'focus') });
        await pressKeys(tabId, hz, [{ key: 'Escape' }], 'close-popup');
      }
    } else {
      await send(tabId, 'DOM.focus', { backendNodeId: node.backendNodeId }, { sessionId });
    }
  } catch (err) {
    await detachProof();
    throw err;
  }
  const focused = await callInWorld(
    tabId,
    node.backendNodeId,
    `function () { return this.ownerDocument.activeElement === this; }`,
    [],
    sessionId,
  );
  if (!focused) {
    await detachProof();
    throw new Error(
      hz.level === 'stealth'
        ? 'Clicking the <select> did not give it focus, and at the stealth level G9 does not focus it programmatically; no selection keys were sent.'
        : 'Could not focus the <select>; no selection keys were sent.',
    );
  }

  // Watch the whole run of selection keys, so the verification below can tell
  // "the page refused the selection" from "the keys never arrived at all".
  let sawKeys;
  try {
    sawKeys = await armWitness(tabId, ['keydown'], WITNESS_TIMEOUT_MS + (keyPlan?.durationMs ?? 0), [sessionId]);
  } catch (err) {
    await detachProof();
    throw err;
  }
  try {
    await pressKeys(tabId, hz, presses, 'select', keyPlan);
  } catch (err) {
    sawKeys.release();
    await detachProof();
    throw err;
  }

  const verified = await callInWorld(
    tabId,
    node.backendNodeId,
    `function (wantedIndices) {
       const actual = [...this.options].map((o, index) => o.selected ? index : -1).filter(index => index >= 0);
       const proof = this.ownerDocument.defaultView.__g9SelectProof;
       const trusted = !!(proof && proof.trusted);
       const changes = proof && typeof proof.changes === 'number' ? proof.changes : null;
       if (proof && proof.detach) proof.detach();
       return {
         actual,
         values: [...this.selectedOptions].map(o => o.value),
         labels: [...this.selectedOptions].map(o => o.textContent.trim()),
         trusted,
         changes,
       };
     }`,
    [plan.indices],
    sessionId,
  );
  const actual = [...(verified?.actual ?? [])].sort((a, b) => a - b);
  const expected = [...plan.indices].sort((a, b) => a - b);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    // "The page intercepted it" was a guess, and for the most common cause it
    // was the wrong one: a hidden tab receives no input at all, so the keys
    // were never delivered and the page is blameless. Ask before accusing.
    const seen = await sawKeys.settle();
    if (seen.delivery === 'not-delivered') {
      const error = (await noInputError(tabId, 'selection', sessionId));
      error.delivery = 'not-delivered';
      throw error;
    }
    throw new Error(
      `Selection keys were issued, but selected option indexes are ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}. ` +
        `The page or platform intercepted the native selection, so success is not being reported.`,
    );
  }
  sawKeys.release();
  const changed = JSON.stringify([...plan.selected].sort((a, b) => a - b)) !== JSON.stringify(expected);
  if (changed && !verified.trusted) {
    throw new Error('The selection changed, but the page did not observe a trusted input/change event. Success is not being reported.');
  }
  // How many change events the page saw: a closed select fires one per option the arrows pass.
  // Never "not-needed" when any fired (it said so while three had fired — interaction review).
  const changeEvents = Number.isInteger(verified.changes) ? verified.changes : null;
  return {
    selected: verified.labels,
    values: verified.values,
    trustedEvent: changed || changeEvents ? true : 'not-needed',
    ...(changeEvents != null ? { changeEvents } : {}),
    ...(changeEvents > 1 && !plan.multiple
      ? { intermediateChanges: changeEvents - 1, changeNote: `The page saw ${changeEvents - 1} change event(s) for options passed on the way; a select that acts on every change (submits, fetches) acted on those too.` }
      : {}),
    // The selected option is the outcome, and it was read back.
    delivery: 'delivered',
    ...(hz.level === 'stealth' ? { pointer: await pointerNow(tabId) } : {}),
    humanize: hzInfo(hz),
  };
}

// ------------------------------------------------------------------- upload

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
  let sessionId = null;

  if (ref) {
    const node = await resolveRef(tabId, ref, url);
    backendNodeId = node.backendNodeId;
    sessionId = node.sessionId ?? null;
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
  await send(tabId, 'DOM.setFileInputFiles', { backendNodeId, files: list }, { sessionId });
  // The outcome is readable: the input now holds that many files, or not.
  const held = await callInWorld(
    tabId,
    backendNodeId,
    `function () { return this.files ? this.files.length : null; }`,
    [],
    sessionId,
  ).catch(() => null);
  return {
    uploaded: list,
    via: ref ? `ref ${ref}` : `selector ${selector}`,
    delivery: held === list.length ? 'delivered' : 'indeterminate',
    ...(held != null && held !== list.length ? { deliveryNote: `The input reports ${held} file(s) after setting ${list.length}.` } : {}),
  };
}
