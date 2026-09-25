/**
 * Sites: what a URL's "site" is, and whether it belongs to a project (v3, ARCHITECTURE §13).
 *
 * Pure: no `chrome.*`, no Node built-ins, only the `URL` global both engines have (rule R2).
 * Three callers, one rule each:
 *   - auto-attach "Project sites" (sw.js): does this tab's URL belong to a connected agent's
 *     project? A CAPTURE FILTER only — never an access boundary (v2 D6/D7 stand: hand attach and
 *     agents reach every tab);
 *   - the issue index (store.js): which site an issue was filed on, to group the list by it;
 *   - the side panel: the parts of a URL it shows (origin in full, the path truncated), so a
 *     signed URL no longer fills a third of the panel (V3_UX_PLAN U5).
 */

/** Parse without throwing; null for anything that is not an absolute URL. */
function parse(url) {
  if (url == null || url === '') return null;
  try {
    return new URL(String(url));
  } catch {
    return null;
  }
}

/**
 * The URL's origin ("https://admin.example.test:8443"), or null. An opaque origin
 * (about:blank, data:, file: in most engines) is null too: `URL.origin` spells it as the
 * string "null", which would group every such page under one bogus site.
 */
export function siteOf(url) {
  const u = parse(url);
  if (!u || !u.origin || u.origin === 'null') return null;
  return u.origin;
}

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' };

/**
 * One project domain as the daemon sends it — "host" or "host:port" — as { hostname, port|null }.
 * Forgiving about what a person may have typed into g9.project.json by hand: a scheme or a
 * path is dropped, case is ignored. null when nothing usable is left.
 */
export function parseDomain(domain) {
  const raw = String(domain ?? '').trim().toLowerCase();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
  const u = parse(withScheme);
  if (!u || !u.hostname) return null;
  return { hostname: u.hostname, port: u.port || null };
}

/**
 * Does `url` belong to one of `domains`? Its host must BE the domain's host or a subdomain of it
 * ("app.example.test" matches "example.test"; "example.test" does not match "app.example.test",
 * and "badexample.test" never matches "example.test"). A domain with a port matches only that
 * port (the URL's default port counts: "example.test:443" matches https://example.test/); one
 * without a port matches any. Only http(s) pages match — there is nothing to capture elsewhere.
 */
export function hostMatches(url, domains) {
  const u = parse(url);
  if (!u || !/^https?:$/.test(u.protocol) || !u.hostname) return false;
  const host = u.hostname.toLowerCase();
  const port = u.port || DEFAULT_PORTS[u.protocol] || '';
  for (const entry of Array.isArray(domains) ? domains : []) {
    const d = parseDomain(entry);
    if (!d) continue;
    if (host !== d.hostname && !host.endsWith(`.${d.hostname}`)) continue;
    if (d.port && d.port !== port) continue;
    return true;
  }
  return false;
}

/**
 * The parts of a URL the panel shows: `origin` (null when opaque) and `path` (the pathname),
 * with the `query` and `hash` kept apart so the panel can leave them out of the line and put
 * the full URL in a tooltip. A string that is not a URL comes back whole as `path`.
 */
export function displayUrl(url) {
  const u = parse(url);
  if (!u) return { origin: null, host: null, path: String(url ?? ''), query: '', hash: '', href: String(url ?? '') };
  const origin = siteOf(u.href);
  return {
    origin,
    host: origin ? u.host : null,
    // An opaque URL (about:blank, data:…) has no origin to show apart: the whole thing is its path.
    path: origin ? u.pathname : u.href,
    query: origin ? u.search : '',
    hash: origin ? u.hash : '',
    href: u.href,
  };
}
