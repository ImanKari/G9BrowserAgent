/**
 * (3.5) The call log: every tool call the daemon runs gets a call id, and its outcome is kept for a
 * while — so a call whose CALLER gave up is still answerable.
 *
 * Why. An agent's MCP client has its own timeout (20–90 s in the field report), shorter than many
 * real actions: a "Share" click whose page took longer to publish. The client gave up, the agent
 * logged a failure — and the story HAD been published. Its retry then risked publishing twice (six
 * times in one week). G9's own deadline did not help: the call was fine, only the client was
 * impatient, and nothing could be asked afterwards. Three things fix it, all optional for the agent:
 *
 * - `opId` (an idempotency key the agent chooses, e.g. "share-story-0042"): the same agent sending
 *   the same opId again does NOT act again. A call still running is joined; a finished one returns
 *   its recorded outcome with `deduplicated:true`. A call that failed BEFORE it acted may run again;
 *   one whose outcome is unknown (it ran past its deadline) is refused with the way to check.
 * - `replyWithinMs`: answer within this long whatever happens. A call still running then answers
 *   `{ pending:true, callId }` and goes on; its outcome is recorded when it ends. Set it below the
 *   client's own timeout. `G9_REPLY_WITHIN_MS` sets it for every call of this daemon.
 * - `browser_status callId:"…"` (with `waitMs` to wait for the end), and `browser_status calls:true`:
 *   how a call ended, or this agent's recent calls — by the agent's identity, so a stateless client's
 *   next session can still ask about the previous one's calls.
 *
 * Late outcomes: a call the daemon had to answer at its deadline ("may STILL be running") can still
 * end later in its engine. The router reports that outcome here (`late:true`), so "did it happen in
 * the end?" has an answer.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** The call a piece of router code runs for (relay and #local read it to report late outcomes). */
export const callContext = new AsyncLocalStorage();

export const KEEP_CALLS = 300;
export const KEEP_MS = 60 * 60_000;
export const RESULT_MAX = 16 * 1024;
export const MAX_STATUS_WAIT_MS = 10 * 60_000;

/** An outcome whose effect is unknown: it ran past a deadline and may still be running. */
export const UNKNOWN_OUTCOME = /may STILL be running|did not (finish|respond) within|stopped it:|\[recovered\]|\[delivery: (partial|missed)/i;

/** A result, bounded for the log: images and long fields dropped, the whole cut at RESULT_MAX. */
export function boundResult(result) {
  if (result === undefined) return null;
  let value = result;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const { dataBase64, bytesBase64, tree, text, thumbnail, ...rest } = value;
    value = { ...rest };
    if (dataBase64 || bytesBase64) value.omitted = 'image or file bytes';
    if (typeof tree === 'string') value.tree = tree.length > 2000 ? `${tree.slice(0, 2000)}…` : tree;
    if (typeof text === 'string') value.text = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  }
  let json;
  try { json = JSON.stringify(value); } catch { return { unserializable: true }; }
  if (json == null) return null;
  if (json.length <= RESULT_MAX) return value;
  return { truncated: true, size: json.length, start: json.slice(0, RESULT_MAX) };
}

function identityOf(client) {
  return String(client?.identity ?? client?.name ?? client?.id ?? 'unknown');
}

export class CallLog {
  constructor({ now = () => Date.now(), replyWithinMs = Number(process.env.G9_REPLY_WITHIN_MS) || null } = {}) {
    this.now = now;
    this.defaultReplyWithinMs = replyWithinMs;
    this.calls = new Map(); // callId → record
    this.byOp = new Map(); // identity + opId → callId
    this.waiters = new Map(); // callId → Set<resolve>
    this.next = 1;
  }

  #prune() {
    const cutoff = this.now() - KEEP_MS;
    const ended = [...this.calls.values()].filter((c) => c.state !== 'running');
    let excess = ended.length - KEEP_CALLS;
    for (const c of ended) {
      if (excess <= 0 && c.endedAt >= cutoff) continue;
      this.calls.delete(c.callId);
      if (c.opKey && this.byOp.get(c.opKey) === c.callId) this.byOp.delete(c.opKey);
      excess -= 1;
    }
  }

  get(callId) {
    return this.calls.get(String(callId)) ?? null;
  }

  /** What an agent is shown: the record without internal keys. */
  view(record) {
    if (!record) return null;
    const { opKey, promise, ...out } = record;
    return { ...out, ...(out.state === 'running' ? { runningMs: this.now() - out.startedAt } : { ms: out.endedAt - out.startedAt }) };
  }

  /** The recent calls of this client's identity, newest first. */
  recent(client, limit = 20) {
    const who = identityOf(client);
    return [...this.calls.values()].filter((c) => c.identity === who).sort((a, b) => b.startedAt - a.startedAt).slice(0, limit).map((c) => this.view(c));
  }

  /** Wait until a call ends or `ms` passes. → the record view (null for an unknown id). */
  async wait(callId, ms) {
    const record = this.get(callId);
    if (!record || record.state !== 'running' || !(ms > 0)) return this.view(record);
    await new Promise((resolve) => {
      const set = this.waiters.get(record.callId) ?? new Set();
      set.add(resolve);
      this.waiters.set(record.callId, set);
      const timer = setTimeout(resolve, Math.min(MAX_STATUS_WAIT_MS, ms));
      timer.unref?.();
    });
    return this.view(this.get(callId));
  }

  #settle(record, state, { result, error, late = false } = {}) {
    record.state = state;
    record.endedAt = this.now();
    if (state === 'done') record.result = boundResult(result);
    if (error != null) record.error = String(error?.message ?? error).slice(0, 2000);
    if (error?.delivery) record.delivery = error.delivery;
    if (late) record.late = true;
    for (const resolve of this.waiters.get(record.callId) ?? []) resolve();
    this.waiters.delete(record.callId);
    this.#prune();
  }

  /**
   * A call that the daemon already answered (at its deadline) ended in its engine after all. The
   * first late outcome wins; it replaces the "unknown" the agent was told.
   */
  late(callId, { result, error } = {}) {
    const record = this.get(callId);
    if (!record || record.lateOutcome) return;
    record.lateOutcome = true;
    this.#settle(record, error ? 'failed' : 'done', { result, error, late: true });
  }

  /**
   * Run one call through the log. `fn()` runs it; `opId` and `replyWithinMs` are the caller's.
   * Resolves with fn's result (or a pending answer), rejects with fn's error (its message names the
   * call id when the outcome is unknown).
   */
  async run(client, tool, args, { opId = null, replyWithinMs = null } = {}, fn) {
    const identity = identityOf(client);
    const opKey = opId != null && opId !== '' ? `${identity}\u0000${String(opId).slice(0, 200)}` : null;
    if (opKey && this.byOp.has(opKey)) {
      const prior = this.get(this.byOp.get(opKey));
      if (prior?.state === 'running') return this.#answer(prior, replyWithinMs, { deduplicated: true });
      if (prior?.state === 'done') return { ...(prior.result && typeof prior.result === 'object' && !Array.isArray(prior.result) ? prior.result : { result: prior.result }), deduplicated: true, callId: prior.callId, opId };
      if (prior?.state === 'failed' && UNKNOWN_OUTCOME.test(prior.error ?? '') && !prior.late) {
        throw new Error(
          `opId "${opId}" was already sent as call ${prior.callId}, and its outcome is unknown: ${prior.error} ` +
            `G9BrowserAgent did not run it again. Check the page (browser_snapshot) and browser_status callId:"${prior.callId}" — ` +
            'a late outcome is recorded there — then send it with a new opId only if it did not happen.',
        );
      }
      // Failed before it acted (a refusal, a missing element): running it again is safe.
    }
    const callId = `c${this.next++}`;
    const record = {
      callId, tool, action: args?.action ?? args?.what ?? null, ...(args?.ref ? { ref: args.ref } : {}),
      ...(Number.isInteger(args?.tabId) ? { tabId: args.tabId } : {}), ...(args?.session ? { session: args.session } : {}),
      agentId: client?.id ?? null, identity, ...(opId != null ? { opId: String(opId) } : {}),
      state: 'running', startedAt: this.now(), opKey,
    };
    this.calls.set(callId, record);
    if (opKey) this.byOp.set(opKey, callId);
    record.promise = callContext.run({ callId }, () => Promise.resolve().then(fn)).then(
      (result) => { this.#settle(record, 'done', { result }); return result; },
      (err) => {
        this.#settle(record, 'failed', { error: err });
        if (err instanceof Error && UNKNOWN_OUTCOME.test(err.message) && !/callId/.test(err.message)) {
          err.message += ` [callId ${callId}: browser_status callId:"${callId}" reports how it ended if it finishes later.]`;
        }
        throw err;
      },
    );
    return this.#answer(record, replyWithinMs);
  }

  #answer(record, replyWithinMs, extra = {}) {
    const within = Number(replyWithinMs ?? this.defaultReplyWithinMs);
    const finish = record.promise.then((result) => (extra.deduplicated && result && typeof result === 'object' && !Array.isArray(result) ? { ...result, ...extra, callId: record.callId } : result));
    if (!(within > 0)) return finish;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.promise.catch(() => {}); // the outcome is recorded; nobody awaits it now
        resolve({
          pending: true,
          callId: record.callId,
          tool: record.tool,
          ...(record.action ? { action: record.action } : {}),
          ...(record.opId ? { opId: record.opId } : {}),
          ...extra,
          note: `Still running after ${Math.round(within)} ms; it goes on. Ask browser_status callId:"${record.callId}" (waitMs:… waits for the end) — do not send it again${record.opId ? '' : ' (pass an opId to make a resend safe)'}.`,
        });
      }, Math.max(100, within));
      timer.unref?.();
      finish.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
  }
}
