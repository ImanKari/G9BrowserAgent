/**
 * (3.6) A machine-readable code on the tool errors an agent acts on.
 *
 * Agents told "two elements matched" from "nothing matched" from "the click landed elsewhere" by
 * parsing English (field report). Now each such error carries a code: as `err.errorCode` in the
 * process that threw it, as `code` in the daemon's result message (DAEMON_PROTOCOL §3), and — the
 * one form that survives every hop, the MCP text included — as a fixed tag at the start of the
 * message, after a [delivery: …] / [recovered] tag when there is one:
 *
 *   [delivery: not-delivered] [code: ambiguous] role "button" name /save/i matched 3 elements: …
 *
 * Not `err.code`: Node's own errors use that field (ECONNREFUSED, ENOENT …).
 */

/** Every code, and what an agent does about it (REFERENCE.md lists the same). */
export const ERROR_CODES = Object.freeze({
  not_found: 'no element matched role/name/selector; nothing was sent — check the name with browser_inspect what:"find", or pass waitMs',
  ambiguous: 'several elements matched and no nth was given; nothing was sent — pass nth or a stricter name (exact:true)',
  bad_argument: 'an argument is out of range or malformed (nth beyond the matches, …); nothing was sent',
  unknown_argument: 'the tool does not take an argument that was passed; nothing was run',
  no_snapshot: 'a ref was used before any browser_snapshot of the tab',
  stale_ref: 'the ref is unknown or from another page; take a fresh browser_snapshot',
  not_delivered: 'the input was not sent (covered, moving, out of view …); nothing happened on the page',
  tab_hidden: 'the tab is in the background of the user\'s browser; pass ifHidden or focus it',
  missed: 'the input reached a different element than the target: it may have done something — verify before retrying',
  partial: 'part of the input was sent before the tab became hidden: verify before retrying',
  not_verified: 'set_value acted but the control does not show the value asked for',
  navigated: 'the action took the page to another URL while expectSamePage was set',
  dialog: 'a JavaScript dialog blocks the page; handle it with browser_dialog',
  timeout: 'the call did not finish in time and was stopped; its effect is unknown — verify before retrying',
  halted: 'the user pressed Stop; wait for Resume',
  owned: 'another agent owns the tab',
});

/** The code an error carries, from its own field or its delivery state. Pure. */
export function codeFor(err) {
  if (typeof err?.errorCode === 'string' && err.errorCode) return err.errorCode;
  switch (err?.delivery) {
    case 'missed': return 'missed';
    case 'partial': return 'partial';
    case 'not-delivered': return err.hidden === true ? 'tab_hidden' : 'not_delivered';
    default: return null;
  }
}

/** The code tagged in a message, or null. Pure. */
export function codeOfMessage(text) {
  return /\[code: ([a-z_]+)\]/.exec(String(text ?? '').slice(0, 400))?.[1] ?? null;
}

/** Put `[code: X]` into the message (once, after any leading [...] tags) and on the error. */
export function tagCode(error, code = codeFor(error)) {
  if (!error || !code) return error;
  error.errorCode = error.errorCode || code;
  const msg = String(error.message ?? '');
  if (codeOfMessage(msg)) return error;
  const lead = /^(?:\[[^\]]*\]\s*)*/.exec(msg)[0];
  const sep = lead && !/\s$/.test(lead) ? ' ' : '';
  error.message = `${lead}${sep}[code: ${code}] ${msg.slice(lead.length)}`;
  return error;
}

/** An Error with a code (for throw sites). */
export function codedError(code, message) {
  const err = new Error(message);
  err.errorCode = code;
  return err;
}
