// engine/pipe-cdp.js — the Chrome DevTools Protocol over --remote-debugging-pipe.
//
// A browser started with --remote-debugging-pipe reads commands from its fd 3 and writes replies
// and events to its fd 4. Each message is one JSON object followed by a single NUL byte. There is
// no HTTP endpoint, no port, no WebSocket: nothing else on the machine can reach this browser, and
// nothing has to be allocated or cleaned up besides the process itself.
//
// This is the `CdpConnection` of ARCHITECTURE_V2 §3.2:
//   send(method, params = {}, sessionId = null, { timeoutMs } = {}): Promise<object>
//   on('event', (method, params, sessionId) => void); on('close', (reason) => void); close()
//
// Why the framing code is careful:
// * A pipe delivers bytes, not messages. One `data` chunk may hold half a message, three whole
//   messages, or the tail of one and the head of the next. A full-page screenshot is tens of MB and
//   arrives in 64 KB pieces. The reader therefore keeps raw Buffers until it sees a NUL and decodes
//   only whole messages — decoding per chunk would split multi-byte UTF-8 characters (any
//   non-ASCII page title) at chunk edges and corrupt them.
// * Only the NEW chunk is searched for the delimiter, so a 50 MB message costs one concat, not a
//   rescan of everything buffered on every chunk.
// * A pending call whose connection dies must fail at once, naming its method. Otherwise the tool
//   that sent it waits out its whole budget and then blames the page (see the long comment on
//   COMMAND_TIMEOUT_MS in extension/lib/cdp.js — the same lesson, learned in v1).

import { EventEmitter } from 'node:events';

/**
 * Comfortably longer than any healthy command, and shorter than the daemon's per-call budget, so a
 * stuck command reports itself by name instead of poisoning the whole call. Same numbers as the
 * SLOW_COMMANDS table in extension/lib/cdp.js: those commands are slow rather than stuck (a large
 * page capture, the end of a trace) and cutting them off would invent a failure.
 */
export const DEFAULT_TIMEOUT_MS = 20_000;

export const SLOW_COMMANDS = new Map([
  ['Page.captureScreenshot', 45_000],
  ['Page.getLayoutMetrics', 30_000],
  ['Tracing.end', 45_000],
  ['IO.read', 45_000],
]);

/**
 * The longest delay setTimeout honours (2^31-1 ms, ~24.8 days). A larger value is not "wait
 * longer": Node replaces it with 1 ms, so a caller asking for a very long budget would get an
 * immediate, invented timeout. Budgets are clamped to it instead.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Commands that answer only when a navigation commits, i.e. once the SERVER's response headers
 * arrived: their timeout names the server, not a stuck browser (the same wording as
 * extension/lib/cdp.js timeoutMessage — live round 3, a 25 s time to first byte reported as "stuck").
 */
export const NAVIGATION_COMMANDS = new Set(['Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry']);

function timeoutText(method, budget) {
  const s = Math.round(budget / 1000);
  if (NAVIGATION_COMMANDS.has(method)) {
    return `The CDP command "${method}" did not return after ${s}s. A navigation command answers when the server's ` +
      `response headers arrive, so the server most likely did not answer within ${s} s (slow, overloaded or ` +
      `unreachable) — this is not a stuck browser, and the navigation may still complete in the background.`;
  }
  return `The CDP command "${method}" did not return after ${s}s. ` +
    `The command is stuck rather than slow — the browser accepted it and never answered.`;
}

/** The budget a command gets when the caller does not say otherwise. */
export function timeoutFor(method, override) {
  if (Number.isFinite(override) && override > 0) return Math.min(override, MAX_TIMER_MS);
  return SLOW_COMMANDS.get(method) ?? DEFAULT_TIMEOUT_MS;
}

/**
 * A single message larger than this is treated as a broken stream rather than buffered forever.
 * 256 MiB is far above any legitimate reply (a 16k-pixel-tall PNG screenshot is ~60 MB of base64)
 * and far below the ~512 MiB where V8 can no longer hold the string at all.
 */
export const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

/**
 * How long the reader may keep draining fd 4 after the browser process exited. Node documents that
 * 'exit' can fire while the child's stdio is still open, i.e. before the last bytes the browser
 * wrote have been read. A reply that is already in the pipe is a reply, not a failure; normally the
 * pipe's own end arrives within milliseconds and closes the connection first.
 */
export const EXIT_DRAIN_MS = 250;

export class CdpProtocolError extends Error {
  constructor(message, { method, sessionId = null, code, data } = {}) {
    super(message);
    this.name = 'CdpProtocolError';
    this.method = method;
    this.sessionId = sessionId;
    if (code !== undefined) this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export class PipeCdp extends EventEmitter {
  /**
   * @param {import('node:stream').Writable} writeStream  the browser's fd 3 (we write commands)
   * @param {import('node:stream').Readable} readStream   the browser's fd 4 (we read replies/events)
   * @param {object} [opts]
   * @param {string} [opts.name]              label used in error messages ("edge 153.0…", "launched-2")
   * @param {import('node:child_process').ChildProcess} [opts.child]  close the connection when it exits
   * @param {number} [opts.defaultTimeoutMs]  default per-command budget (20 s)
   * @param {number} [opts.maxMessageBytes]
   */
  constructor(writeStream, readStream, { name = 'browser', child = null, defaultTimeoutMs = DEFAULT_TIMEOUT_MS, maxMessageBytes = MAX_MESSAGE_BYTES } = {}) {
    super();
    // Tool code attaches one listener per tab/session subsystem; the default cap of 10 would print
    // a leak warning on an ordinary run with a dozen tabs.
    this.setMaxListeners(0);
    this.name = name;
    this._write = writeStream;
    this._read = readStream;
    this._child = child;
    this._defaultTimeoutMs = defaultTimeoutMs;
    this._maxMessageBytes = maxMessageBytes;
    this._nextId = 1;
    this._pending = new Map();          // id → { method, sessionId, resolve, reject, timer }
    this._chunks = [];                  // Buffers of the message being assembled
    this._chunkBytes = 0;
    this._closed = false;
    this._closeReason = null;
    this._streamsDestroyed = false;
    this.stats = { sent: 0, received: 0, events: 0, malformed: 0, lateReplies: 0, bytesIn: 0, bytesOut: 0 };

    this._exitReason = null;
    this._exitTimer = null;
    this._onData = (chunk) => this._ingest(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    // Once the process is known to have exited, that is the better reason to give (it has the code).
    this._onReadEnd = () => this._shutdown(this._exitReason ?? `${this.name}: the browser closed its end of the pipe`);
    this._onReadError = (err) => this._shutdown(`${this.name}: reading the pipe failed (${err?.code ?? err?.message ?? err})`);
    this._onWriteError = (err) => this._shutdown(`${this.name}: writing to the pipe failed (${err?.code ?? err?.message ?? err})`);
    this._onChildExit = (code, signal) => {
      this._exitReason = `${this.name}: the browser process exited (${signal ? `signal ${signal}` : `code ${code}`})`;
      if (this._closed || this._exitTimer) return;
      // Drain what is already in the pipe (see EXIT_DRAIN_MS), then close with the exit as the reason.
      this._exitTimer = setTimeout(() => this._shutdown(this._exitReason), EXIT_DRAIN_MS);
      this._exitTimer.unref?.();
    };

    readStream.on('data', this._onData);
    readStream.on('end', this._onReadEnd);
    readStream.on('close', this._onReadEnd);
    readStream.on('error', this._onReadError);
    writeStream.on('error', this._onWriteError);
    // A write end can also close on its own (the browser exited); a later write would then throw
    // EPIPE asynchronously. Treat the close as the end of the connection.
    writeStream.on('close', this._onReadEnd);
    if (child) child.once('exit', this._onChildExit);
  }

  /** True once the connection is unusable. */
  get closed() { return this._closed; }
  /** Why it closed, or null. */
  get closeReason() { return this._closeReason; }
  /** Commands sent and not yet answered. */
  get pendingCount() { return this._pending.size; }
  /** The methods still waiting — useful in a "stuck" diagnosis. */
  pendingMethods() { return [...this._pending.values()].map((p) => p.method); }

  /**
   * Send a command. `sessionId` routes it to an attached target (flat mode); null = the browser.
   * Rejects with the browser's own error text (tool code matches substrings such as
   * "Cannot find context" or "No node with given id", exactly as with chrome.debugger), with
   * `.method`, `.code` and `.data` set.
   */
  send(method, params = {}, sessionId = null, { timeoutMs } = {}) {
    if (this._closed) {
      return Promise.reject(new CdpProtocolError(
        `Cannot send "${method}": the connection to ${this.name} is closed (${this._closeReason}).`,
        { method, sessionId },
      ));
    }
    const id = this._nextId++;
    const message = { id, method, params: params ?? {} };
    if (sessionId) message.sessionId = sessionId;
    let payload;
    try {
      payload = JSON.stringify(message) + '\0';
    } catch (err) {
      return Promise.reject(new CdpProtocolError(`Cannot send "${method}": its parameters are not JSON (${err.message}).`, { method, sessionId }));
    }
    // Per-call override, else the slow-command budget, else this connection's default.
    const budget = Math.min(MAX_TIMER_MS, Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : (SLOW_COMMANDS.get(method) ?? this._defaultTimeoutMs));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this._pending.delete(id)) return;
        reject(new CdpProtocolError(timeoutText(method, budget), { method, sessionId, code: 'TIMEOUT' }));
      }, budget);
      this._pending.set(id, { method, sessionId, resolve, reject, timer });
      try {
        this._write.write(payload);
        this.stats.sent++;
        this.stats.bytesOut += Buffer.byteLength(payload, 'utf8');
      } catch (err) {
        // A synchronous throw means the stream is already destroyed.
        this._shutdown(`${this.name}: writing to the pipe failed (${err?.code ?? err?.message ?? err})`);
      }
    });
  }

  /**
   * Resolve with the params of the next event `method` (optionally on `sessionId`, optionally
   * matching `predicate`). Rejects on timeout or when the connection closes.
   */
  waitForEvent(method, { sessionId, predicate, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      if (this._closed) {
        reject(new CdpProtocolError(`Cannot wait for "${method}": the connection to ${this.name} is closed (${this._closeReason}).`, { method }));
        return;
      }
      const cleanup = () => {
        clearTimeout(timer);
        this.off('event', onEvent);
        this.off('close', onClose);
      };
      const onEvent = (m, params, sid) => {
        if (m !== method) return;
        if (sessionId !== undefined && (sid ?? null) !== (sessionId ?? null)) return;
        try {
          if (predicate && !predicate(params, sid)) return;
        } catch (err) {
          cleanup();
          reject(err);
          return;
        }
        cleanup();
        resolve(params);
      };
      const onClose = (reason) => {
        cleanup();
        reject(new CdpProtocolError(`The connection to ${this.name} closed while waiting for "${method}" (${reason}).`, { method }));
      };
      // null/0/NaN (a JSON caller's "not set") means the default budget, never "time out at once".
      const budget = Number(timeoutMs) > 0 ? Math.min(MAX_TIMER_MS, Number(timeoutMs)) : DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        cleanup();
        reject(new CdpProtocolError(`No "${method}" event within ${Math.round(budget / 1000)}s.`, { method, code: 'TIMEOUT' }));
      }, budget);
      this.on('event', onEvent);
      this.on('close', onClose);
    });
  }

  /**
   * Stop using the pipe: reject every pending call and emit 'close'. Does not ask the browser to
   * quit — launch.js close() does that with Browser.close first. (Closing our write end is still a
   * signal the browser sees; see engine/README.md for what a browser does when its pipe closes.)
   */
  close(reason = `${this.name}: connection closed by G9BrowserAgent`) {
    this._shutdown(reason, { destroy: true });
    // The connection may already have closed from the browser's side (pipe end, process exit),
    // which does not destroy our streams. Release them now either way: the fd-3 socket is a
    // readable stream nobody reads, and left alone it keeps its handle open for the life of the
    // process that launched the browser.
    this._destroyStreams();
  }

  // ─── internals ────────────────────────────────────────────────────────────────────────────

  _ingest(chunk) {
    if (this._closed || !chunk?.length) return;
    this.stats.bytesIn += chunk.length;
    let start = 0;
    let nul = chunk.indexOf(0);
    while (nul !== -1) {
      const piece = chunk.subarray(start, nul);
      let whole;
      if (this._chunks.length === 0) {
        whole = piece;
      } else {
        this._chunks.push(piece);
        whole = Buffer.concat(this._chunks, this._chunkBytes + piece.length);
        this._chunks = [];
        this._chunkBytes = 0;
      }
      if (whole.length) this._dispatch(whole);
      if (this._closed) return;             // a handler closed us mid-chunk
      start = nul + 1;
      nul = chunk.indexOf(0, start);
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this._chunks.push(rest);
      this._chunkBytes += rest.length;
      if (this._chunkBytes > this._maxMessageBytes) {
        this._shutdown(`${this.name}: a single CDP message exceeded ${Math.round(this._maxMessageBytes / 1048576)} MiB without a terminator — the stream is not CDP`, { destroy: true });
      }
    }
  }

  _dispatch(buffer) {
    let message;
    try {
      message = JSON.parse(buffer.toString('utf8'));
    } catch (err) {
      // One corrupt frame must not take down every tab on this browser. Count it and move on; the
      // command it answered (if any) times out by name.
      this.stats.malformed++;
      if (this.listenerCount('protocolError')) this.emit('protocolError', { error: err.message, sample: buffer.subarray(0, 200).toString('utf8') });
      return;
    }
    this.stats.received++;
    if (typeof message.id === 'number') {
      const pending = this._pending.get(message.id);
      if (!pending) {
        // The reply to a command that already timed out. Nothing is waiting for it any more.
        this.stats.lateReplies++;
        return;
      }
      this._pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const { code, message: text, data } = message.error;
        pending.reject(new CdpProtocolError(
          `${text ?? 'CDP error'}${data ? ` (${data})` : ''}`,
          { method: pending.method, sessionId: pending.sessionId, code, data },
        ));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method === 'string') {
      this.stats.events++;
      const params = message.params ?? {};
      const sessionId = message.sessionId ?? null;
      // Listeners are called one by one so that a throwing listener (a bug in that subsystem) can
      // neither starve the listeners after it nor escape into the stream and kill the daemon.
      // rawListeners() so that once() wrappers still remove themselves.
      for (const listener of this.rawListeners('event')) {
        try {
          listener.call(this, message.method, params, sessionId);
        } catch (err) {
          if (this.listenerCount('listenerError')) this.emit('listenerError', err, message.method);
          else console.error(`[pipe-cdp] an 'event' listener threw on ${message.method}:`, err);
        }
      }
    }
  }

  _shutdown(reason, { destroy = false } = {}) {
    if (this._closed) return;
    this._closed = true;
    this._closeReason = reason;
    if (this._exitTimer) { clearTimeout(this._exitTimer); this._exitTimer = null; }
    this._chunks = [];
    this._chunkBytes = 0;
    this._read.off('data', this._onData);
    this._read.off('end', this._onReadEnd);
    this._read.off('close', this._onReadEnd);
    this._write.off('close', this._onReadEnd);
    this._child?.off('exit', this._onChildExit);
    // Keep swallowing stream errors after close: a late EPIPE must not become an uncaught exception.
    this._read.on('error', () => {});
    this._write.on('error', () => {});
    if (destroy) this._destroyStreams();
    const pending = [...this._pending.values()];
    this._pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(new CdpProtocolError(
        `The connection to ${this.name} closed before "${p.method}" answered (${reason}).`,
        { method: p.method, sessionId: p.sessionId, code: 'CLOSED' },
      ));
    }
    // Like 'event': a throwing 'close' listener must not escape. _shutdown runs inside stream and
    // child-process callbacks, where a throw is an uncaught exception that kills the daemon and
    // every other engine with it — and the listeners after it would never learn of the close.
    for (const listener of this.rawListeners('close')) {
      try {
        listener.call(this, reason);
      } catch (err) {
        if (this.listenerCount('listenerError')) this.emit('listenerError', err, 'close');
        else console.error(`[pipe-cdp] a 'close' listener threw:`, err);
      }
    }
  }

  _destroyStreams() {
    if (this._streamsDestroyed) return;
    this._streamsDestroyed = true;
    try { this._write.end?.(); } catch {}
    try { this._write.destroy?.(); } catch {}
    try { this._read.destroy?.(); } catch {}
  }
}

export default PipeCdp;
