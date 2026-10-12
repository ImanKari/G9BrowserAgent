/**
 * (3.4) `browser_network action:"fetch"`: fetch a URL AS THE PAGE — with the browser's cookies for
 * that URL — and hand the bytes back.
 *
 * Long automation keeps needing a file the page can reach and the agent cannot: a rendered video,
 * an export behind a login, an image the app serves from a signed URL. Clicking a download link is
 * slow and, in the person's browser, gives only a path. This fetches it directly.
 *
 * - It runs in G9BrowserAgent's isolated world (lib/world.js), which the browser created with universal
 *   access: the request carries the browser's cookies for the URL (`credentials:"include"`) and a
 *   cross-origin response is readable — no CORS refusal for the agent's own read. The page's main
 *   world sees nothing; the server sees an ordinary request from this browser.
 * - The bytes come back to the daemon, which runs on the browser's machine for both engines: it
 *   hashes them and, with `savePath`, writes the file there (daemon/router.js finishFiles). Without
 *   `savePath` the agent gets a bounded body (`maxBytes`, 256 KiB by default): text for a textual
 *   content type, else base64.
 * - At most MAX_FETCH_BYTES (40 MiB): a relayed result travels in one WebSocket frame (64 MiB cap,
 *   base64 adds a third).
 */

import { inWorld } from '../lib/world.js';
import { evaluate } from '../lib/cdp.js';

export const MAX_FETCH_BYTES = 40 * 1024 * 1024;
export const DEFAULT_MAX_BODY = 256 * 1024;

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** The page-side fetch, as an expression. Exported for the unit suite. */
export function fetchExpression({ url, method = 'GET', headers = {}, body = null, bodyBase64 = null, timeoutMs = 60_000, maxBytes = MAX_FETCH_BYTES }) {
  return `(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ${Number(timeoutMs)});
    try {
      const init = { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers ?? {})}, credentials: 'include', redirect: 'follow', signal: ctl.signal };
      const b64 = ${JSON.stringify(bodyBase64)};
      if (b64 != null) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); init.body = u; }
      else if (${JSON.stringify(body)} != null) init.body = ${JSON.stringify(body)};
      const res = await fetch(${JSON.stringify(url)}, init);
      const declared = Number(res.headers.get('content-length'));
      if (declared > ${Number(maxBytes)}) {
        ctl.abort();
        return { tooLarge: true, status: res.status, declared };
      }
      const chunks = []; let size = 0;
      if (res.body && ${JSON.stringify(method)} !== 'HEAD') {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > ${Number(maxBytes)}) { ctl.abort(); return { tooLarge: true, status: res.status, declared: size }; }
          chunks.push(value);
        }
      }
      const all = new Uint8Array(size); let at = 0;
      for (const c of chunks) { all.set(c, at); at += c.length; }
      let bin = '';
      for (let i = 0; i < all.length; i += 0x8000) bin += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000));
      const headers = {}; res.headers.forEach((v, k) => { headers[k] = v; });
      return { status: res.status, statusText: res.statusText, url: res.url, redirected: res.redirected, headers,
        contentType: res.headers.get('content-type'), size, dataBase64: btoa(bin) };
    } catch (err) {
      return { error: String((err && err.message) || err), aborted: ctl.signal.aborted };
    } finally {
      clearTimeout(timer);
    }
  })()`;
}

/** Is this content type text a person (or an agent) can read? */
export function isTextual(contentType) {
  const t = String(contentType ?? '').toLowerCase();
  return /^text\//.test(t) || /json|xml|javascript|ecmascript|csv|yaml|x-www-form-urlencoded|svg/.test(t);
}

/**
 * Fetch `url` as the page. The engine's answer carries the whole body as `bytesBase64` (daemon-only:
 * the daemon hashes it, writes `savePath`, and replaces it with the bounded body the agent sees —
 * see daemon/router.js). → { url, finalUrl, status, statusText, contentType, size, headers, bytesBase64,
 *   savePath?, maxBytes }
 */
export async function fetchResource(tabId, opts = {}) {
  const url = String(opts.url ?? '').trim();
  if (!url) throw new Error('action:"fetch" needs a url.');
  let parsed;
  try {
    parsed = new URL(url, opts.pageUrl || undefined);
  } catch {
    throw new Error(`action:"fetch": ${JSON.stringify(url)} is not a URL.`);
  }
  if (!/^(https?|data|blob):$/.test(parsed.protocol)) throw new Error(`action:"fetch" fetches http(s), data: and blob: URLs only (got ${parsed.protocol}).`);
  const method = String(opts.method ?? 'GET').toUpperCase();
  if (!METHODS.has(method)) throw new Error(`action:"fetch": unknown method ${JSON.stringify(opts.method)}.`);
  const timeoutMs = Math.max(1_000, Math.min(2 * 60 * 60_000, Number(opts.timeoutMs) || 60_000));
  const headers = opts.headers && typeof opts.headers === 'object' && !Array.isArray(opts.headers) ? opts.headers : {};
  const body = opts.body == null ? null : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  const expression = fetchExpression({ url: parsed.href, method, headers, body, bodyBase64: opts.bodyBase64 ?? null, timeoutMs });
  let res = await inWorld(tabId, expression, { timeoutMs: timeoutMs + 5_000, idempotent: false });
  let via = null;
  // (3.5) A blob: URL lives in the page's blob registry; when G9's world cannot read it, the page's
  // own world can (the agent asked for that file, as with browser_console evaluate). Said in `via`.
  if (parsed.protocol === 'blob:' && res?.error) {
    res = await evaluate(tabId, expression, { timeoutMs: timeoutMs + 5_000 }).catch((err) => ({ error: String(err?.message ?? err) }));
    via = 'page';
  }
  if (!res) throw new Error('action:"fetch": the page returned nothing (it may have navigated mid-fetch).');
  if (res.error) {
    throw new Error(`action:"fetch" of ${parsed.href} failed: ${res.aborted ? `no complete answer within ${Math.round(timeoutMs / 1000)} s` : res.error}.`);
  }
  if (res.tooLarge) {
    throw new Error(`action:"fetch": ${parsed.href} is ${res.declared} bytes, more than the ${MAX_FETCH_BYTES / 1048576} MiB a fetch may carry (HTTP ${res.status}). Download it instead (watch_downloads, then click its link).`);
  }
  return {
    url: parsed.href,
    finalUrl: res.url,
    ...(res.redirected ? { redirected: true } : {}),
    status: res.status,
    statusText: res.statusText,
    ok: res.status >= 200 && res.status < 400,
    contentType: res.contentType ?? null,
    size: res.size,
    headers: res.headers,
    bytesBase64: res.dataBase64,
    ...(via ? { via, viaNote: 'A blob: URL the page created was read in the page’s own world.' } : {}),
    ...(opts.savePath ? { savePath: String(opts.savePath) } : {}),
    maxBytes: Math.max(0, Math.min(MAX_FETCH_BYTES, opts.maxBytes != null ? Number(opts.maxBytes) : DEFAULT_MAX_BODY)),
  };
}
