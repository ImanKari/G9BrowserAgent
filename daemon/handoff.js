/**
 * Handoff: move a tab from the person's browser (Engine 1) to a launched
 * browser (Engine 2) so the run continues while they minimise, lock the screen
 * or go home (ARCHITECTURE_V2 §7, D3).
 *
 * What travels, and what honestly cannot:
 *
 *   1. The extension exports the tab (`browser_tabs action:"handoff_export"`,
 *      daemon-only): URL, cookies for the host and every parent domain
 *      (HttpOnly included, via chrome.cookies), localStorage and sessionStorage
 *      read in G9BrowserAgent's isolated world, viewport, user agent.
 *   2. The daemon puts the cookies into a FRESH Engine 2 context with
 *      `Storage.setCookies` — a new context, so the person's session never
 *      leaks into the automation profile and two handoffs never share state.
 *   3. A one-shot `Page.addScriptToEvaluateOnNewDocument({worldName:'g9'})`
 *      seeds local/session storage for that ORIGIN ONLY before the page's own
 *      scripts run, the tab navigates, and the script is removed after load.
 *
 * The page RELOADS. In-memory state (a half-typed form, a JS variable, a
 * WebSocket), IndexedDB and service-worker state do not travel; every result
 * lists them under `notTransferred` so nobody discovers it by surprise.
 */

/** Chrome's sameSite vocabulary → CDP's. 'unspecified' is omitted (browser default). */
const SAME_SITE = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' };

export const NOT_TRANSFERRED = Object.freeze(['in-memory page state', 'IndexedDB', 'service worker state']);

/**
 * Convert `chrome.cookies.Cookie[]` to CDP `Network.CookieParam[]`.
 *
 * The subtle one is host-only vs domain cookies. chrome reports a host-only
 * cookie with `hostOnly:true` and a bare `domain` ("app.example.com"); passing
 * that `domain` to CDP would turn it into a DOMAIN cookie (visible to every
 * subdomain) — a different cookie. CDP makes a host-only cookie when given a
 * `url` and no `domain`, so that is what a host-only cookie becomes.
 *
 * Returns { cookies, skipped: [{ name, domain, reason }] }.
 */
export function chromeCookiesToCdp(cookies, { nowSeconds = Date.now() / 1000 } = {}) {
  const out = [];
  const skipped = [];
  for (const c of Array.isArray(cookies) ? cookies : []) {
    if (!c || typeof c.name !== 'string' || c.domain == null) {
      skipped.push({ name: c?.name ?? null, domain: c?.domain ?? null, reason: 'not a cookie' });
      continue;
    }
    if (!c.session && typeof c.expirationDate === 'number' && c.expirationDate <= nowSeconds) {
      skipped.push({ name: c.name, domain: c.domain, reason: 'expired' });
      continue;
    }
    const domain = String(c.domain);
    const bareHost = domain.replace(/^\./, '');
    const cookiePath = c.path || '/';
    const param = {
      name: c.name,
      value: String(c.value ?? ''),
      path: cookiePath,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
    };
    if (c.hostOnly) {
      param.url = `${c.secure ? 'https' : 'http'}://${bareHost}${cookiePath.startsWith('/') ? cookiePath : `/${cookiePath}`}`;
    } else {
      param.domain = domain.startsWith('.') ? domain : `.${domain}`;
    }
    const sameSite = SAME_SITE[c.sameSite];
    // SameSite=None without Secure is rejected by every current Chrome; the
    // cookie would silently not be set. Sending it without the attribute gives
    // the browser default (Lax), which is what that cookie effectively was.
    if (sameSite && !(sameSite === 'None' && !param.secure)) param.sameSite = sameSite;
    if (!c.session && typeof c.expirationDate === 'number') param.expires = c.expirationDate;
    if (c.partitionKey && typeof c.partitionKey === 'object' && c.partitionKey.topLevelSite) {
      param.partitionKey = {
        topLevelSite: c.partitionKey.topLevelSite,
        hasCrossSiteAncestor: !!c.partitionKey.hasCrossSiteAncestor,
      };
    }
    out.push(param);
  }
  return { cookies: out, skipped };
}

/** Normalise [[k,v]…] or {k:v} into [[string,string]…]. */
export function storageEntries(value) {
  if (!value) return [];
  const pairs = Array.isArray(value) ? value : Object.entries(value);
  const out = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length < 2 || pair[0] == null) continue;
    out.push([String(pair[0]), String(pair[1] ?? '')]);
  }
  return out;
}

/**
 * The page-side seeding script. Runs in G9BrowserAgent's isolated world (same storage as
 * the page, none of its globals), only in the top frame, only when the document
 * is on the handed-off origin — so a redirect through a login host cannot
 * receive another site's storage. Evaluated in the PAGE, never in Node.
 */
export function seedStorageScript(origin, localEntries = [], sessionEntries = []) {
  const payload = JSON.stringify({ origin, local: storageEntries(localEntries), session: storageEntries(sessionEntries) });
  return `(() => {
  try {
    const seed = ${payload};
    if (window.top !== window || location.origin !== seed.origin) return;
    for (const [k, v] of seed.local) { try { localStorage.setItem(k, v); } catch (e) {} }
    for (const [k, v] of seed.session) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  } catch (e) {}
})();`;
}

/** The origin of a URL, or null for about:, data:, file: and garbage. */
export function originOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Orchestrate a handoff for the router (and the panel's "Send to background").
 *
 * @param {object} p
 * @param {import('./router.js').Router} p.router  relays to the extension
 * @param {object} p.engineClient     the extension engine holding the source tab
 * @param {number} p.sourceHandle     daemon handle of the source tab
 * @param {object} p.args             tool args: engine?, context?, includeStorage?, launch?, matchViewport?
 * @param {object} p.caller           { agentId, name }
 */
export async function handoff({ router, engines, registry, engineClient, sourceHandle, args = {}, caller = {} }) {
  const chromeTabId = registry.chromeTabOf(sourceHandle, engineClient.id);
  if (chromeTabId == null) throw new Error(`Tab ${sourceHandle} is not a tab of the connected extension, so there is nothing to hand off.`);

  const exported = await router.relay(engineClient, 'browser_tabs', { action: 'handoff_export', tabId: sourceHandle }, caller);
  if (!exported?.url) throw new Error('The extension did not return the tab state to hand off (no url). Is the extension v2?');
  if (!originOf(exported.url)) {
    throw new Error(`Only http(s) pages can be handed off; this tab is on ${exported.url}.`);
  }

  let engineArg = args.engine && args.engine !== 'launched' ? args.engine : null;
  let contextId = args.context ?? null;
  // (3.5) A handoff that STAYS: into a named profile's own (persistent) context, launched with the
  // proxy, persona, stealth level and window it should have — or reused when it already runs. Until
  // 3.5 a handoff always went into a fresh in-memory context: the login lived only as long as that
  // context, and no proxy was applied (field report: a site that needed both was finished in a
  // separate headed window set up by hand).
  let profile = null;
  if (args.profile) {
    if (engineArg) throw new Error('handoff takes engine or profile, not both: profile launches (or reuses) the engine on that profile.');
    const info = await engines.launch({
      profile: String(args.profile), reuse: true,
      ...(args.headless != null ? { headless: args.headless } : {}),
      ...(args.stealth ? { stealth: args.stealth } : {}),
      ...(args.proxy ? { proxy: args.proxy } : {}),
      ...(args.proxyBypass ? { proxyBypass: args.proxyBypass } : {}),
      ...(args.locale ? { locale: args.locale } : {}),
      ...(args.timezone ? { timezone: args.timezone } : {}),
    });
    engineArg = info.engineId;
    contextId = 'default';
    const differs = (want, have) => want != null && String(want) !== String(have ?? '');
    const own = (info.contexts ?? []).find((c) => c.isDefault) ?? {};
    profile = {
      name: String(args.profile), engineId: info.engineId,
      ...((differs(args.proxy, own.proxy) || differs(args.headless, info.headless) || differs(args.stealth, own.stealth ?? info.stealth))
        ? { note: `Profile "${args.profile}" was already open in ${info.engineId}; it kept the proxy, window and stealth it was launched with. Stop that engine to change them.` }
        : {}),
    };
  } else if (args.proxy && !contextId) {
    // A proxy without a profile: a fresh context of its own with that proxy.
    contextId = (await engines.createContext(engineArg ?? (await engines.defaultEngineId({ launch: args.launch !== false })), {
      proxy: args.proxy, ...(args.proxyBypass ? { proxyBypass: args.proxyBypass } : {}),
      ...(args.locale ? { locale: args.locale } : {}), ...(args.timezone ? { timezone: args.timezone } : {}),
      ...(args.stealth ? { stealth: args.stealth } : {}),
    })).contextId;
  }
  const result = await engines.handoffImport(exported, {
    engineId: engineArg,
    contextId,
    launch: args.launch !== false,
    includeStorage: args.includeStorage !== false,
    matchViewport: args.matchViewport === true,
    caller,
  });
  return {
    ...result,
    ...(profile ? { profile, persisted: true } : {}),
    from: { tabId: sourceHandle, engine: engineClient.id, url: exported.url, title: exported.title ?? null },
    note: handoffNote(result, { includeStorage: args.includeStorage !== false, persisted: !!profile }),
  };
}

/**
 * The sentence an agent reads first. It states what HAPPENED: a page that did
 * not load, or that landed on another origin (a sign-in redirect), was not
 * "reloaded with its session", and saying so is the difference between an
 * agent that checks and one that carries on against a login page.
 */
export function handoffNote(result, { includeStorage = true, persisted = false } = {}) {
  const what = `the cookies${includeStorage ? ' and local/session storage' : ''} of the original tab` +
    (persisted ? ' (written into the profile, so they stay for later runs)' : '');
  const tail =
    ' In-memory page state, IndexedDB and service-worker state did not transfer. ' +
    `Act on the new tab with tabId:${result.tabId}; the original tab is untouched in the person's browser.`;
  if (result.navigationError) {
    return `The launched tab received ${what}, but the page did not finish loading there — check it (browser_snapshot) before relying on it.${tail}`;
  }
  if (result.storageCheck?.sameOrigin === false) {
    return `The page reloaded in the launched engine with ${what}, but it ended on ${result.storageCheck.origin} (a redirect, often a sign-in page) — the session may not have carried. Check it before continuing.${tail}`;
  }
  return `The page reloaded in the launched engine with ${what}.${result.warnings?.length ? ' See warnings.' : ''}${tail}`;
}
