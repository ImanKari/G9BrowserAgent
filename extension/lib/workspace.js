/**
 * Workspace mode — the allowlist that replaces "press Attach every time".
 *
 * ## Why this mode exists
 *
 * Pinned mode was the default because the alternative was worse: without it,
 * switching to your inbox mid-task handed the agent your inbox. That reasoning
 * is correct and this module keeps it — it just stops charging a click for it.
 *
 * A QA opens the browser, goes to the app under test, and the agent can work.
 * They switch to their email and the agent cannot see it, because the email
 * host is not in the project's `workspaceDomains`. Same protection, no
 * ceremony.
 *
 * ## The rule that makes it safe
 *
 * **An empty allowlist means NOTHING is allowed, never EVERYTHING.**
 *
 * If `g9.project.json` is missing, unreadable, or declares no domains, this
 * mode degrades to Pinned and says so. The opposite default — "no list, so
 * allow all" — is the single most dangerous line that could be written in this
 * file, and it is the shape a tired refactor reaches for.
 *
 * ## Why hosts and not URL patterns
 *
 * The list decides which tabs an agent may touch unasked. A pattern language
 * expressive enough to be subtly wrong (regex, paths, globs over the whole URL)
 * is the wrong tool for a security boundary that a QA edits by hand. Three
 * shapes only:
 *
 *   example.com        exact host
 *   *.example.com      host and any subdomain
 *   localhost:5173     host with an explicit port
 *
 * A pattern with a port matches only that port. A pattern without one matches
 * any port, because dev servers move and nobody wants to edit the list for it.
 *
 * ## `"*"` — the whole browser, on purpose
 *
 * A project may declare `"workspaceDomains": ["*"]`. That allows every tab the
 * debugger can attach to at all, including `file://`, and it is the right answer
 * for a machine dedicated to QA where the agent is meant to drive anything.
 *
 * It does NOT contradict the empty-list rule above, and the difference is the
 * whole point: an empty list is what a MISCONFIGURATION looks like — a missing
 * file, a typo, a project that was never set up — and guessing "allow all" there
 * would hand over a browser nobody decided to hand over. `"*"` is a sentence
 * somebody typed into a file that gets reviewed. One is an accident, the other
 * is a decision, and a security boundary should tell them apart rather than
 * treating silence as consent.
 *
 * Two things `"*"` still cannot reach, and neither is this tool's policy:
 * `chrome://`-style internal pages and the extension gallery, which Chrome
 * itself refuses to let any debugger attach to.
 */

/**
 * Does this URL fall inside the workspace?
 *
 * Returns false for everything unparseable, for browser-internal pages, and for
 * an empty allowlist. Every "no" here is a refusal to act, so the failure
 * direction is always toward doing less.
 */
/**
 * Addresses no debugger can attach to, so no allowlist can grant them.
 *
 * Kept in step with `isAttachable` in tools/tabs.js, which is the enforcement
 * point; this copy exists so `inWorkspace` cannot answer "yes" to something the
 * layer below will then refuse.
 */
const INTERNAL = /^(chrome|edge|about|devtools|chrome-extension|edge-extension|view-source):/i;

export function inWorkspace(url, domains) {
  if (!Array.isArray(domains) || domains.length === 0) return false;

  // The explicit everything-grant. Checked before parsing, because it also
  // covers the addresses a host/port rule cannot describe — file:// above all,
  // which has no host to match and is exactly what somebody opening a local
  // report or a saved page is working with.
  //
  // Browser-internal pages stay out even here. Not as policy — as fact: Chrome
  // refuses to let any debugger attach to them, so answering "yes, that is in
  // your workspace" would be a promise this tool cannot keep, and the caller
  // would get an obscure CDP error instead of a sentence explaining why.
  if (domains.some((pattern) => String(pattern).trim() === '*')) return !INTERNAL.test(url);

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');

  return domains.some((pattern) => matches(host, port, pattern));
}

/** Is this project's workspace the whole browser? */
export function isUnrestricted(domains) {
  return Array.isArray(domains) && domains.some((pattern) => String(pattern).trim() === '*');
}

function matches(host, port, pattern) {
  const [patternHost, patternPort] = splitPort(String(pattern).toLowerCase());

  if (patternPort && patternPort !== port) return false;

  if (patternHost.startsWith('*.')) {
    const base = patternHost.slice(2);
    // "*.example.com" covers example.com itself as well. A QA who allowlists a
    // product's subdomains and then finds the apex refused would reasonably
    // call that a bug, and the apex is not a wider grant than its children.
    return host === base || host.endsWith(`.${base}`);
  }
  return host === patternHost;
}

/**
 * Split "host:port", leaving bare IPv6 alone.
 *
 * IPv6 literals contain colons, so a naive split turns `[::1]:5173` into
 * nonsense that silently matches nothing — a workspace entry that looks right
 * and never fires.
 */
function splitPort(pattern) {
  if (pattern.startsWith('[')) {
    const close = pattern.indexOf(']');
    if (close === -1) return [pattern, null];
    const rest = pattern.slice(close + 1);
    return [pattern.slice(0, close + 1), rest.startsWith(':') ? rest.slice(1) : null];
  }
  const colon = pattern.lastIndexOf(':');
  if (colon === -1) return [pattern, null];
  const maybePort = pattern.slice(colon + 1);
  return /^\d{1,5}$/.test(maybePort) ? [pattern.slice(0, colon), maybePort] : [pattern, null];
}

/**
 * The sentence a refused tab gets.
 *
 * It names the allowlist and both ways out, because "not allowed" without a
 * remedy is the message that makes people uninstall a tool. The two remedies
 * are deliberately different in kind: edit the project file (durable, shared,
 * reviewed) or switch to Multi (immediate, personal, temporary).
 */
export function refusalFor(url, domains, { projectPath } = {}) {
  const host = safeHost(url);
  if (!domains?.length) {
    return (
      `Workspace mode has no allowlist, so it is behaving as Pinned mode and no tab is attached. ` +
      `The bridge found no "workspaceDomains" in a g9.project.json${projectPath ? ` (${projectPath})` : ''}. ` +
      `Add the domains of the app under test, or press "Attach & Pin current tab" in the side panel, ` +
      `or switch the panel to Multi-tab mode.`
    );
  }
  // `host ?? url` would fall back to the FULL url when parsing fails, which is
  // the one case where the string is least likely to be something we should be
  // handing back. A tab the agent may not act on is a tab whose address it may
  // not read; an unparseable one is described, not quoted.
  if (isUnrestricted(domains)) {
    // With "*" nothing is refused for being outside the workspace, so a refusal
    // that reaches here is about the address itself. Saying "outside the
    // workspace" would send the reader to edit a list that already allows
    // everything — the most frustrating kind of wrong answer.
    return (
      `The tab at ${host ?? '(an unparseable address)'} cannot be driven. This project allows every ` +
      `host ("workspaceDomains": ["*"]), so this is not an allowlist refusal: the browser itself ` +
      `refuses to let any debugger attach to internal pages (chrome://, edge://, about:, devtools://, ` +
      `view-source:) and to the extension gallery. Open the page on a normal http(s) or file:// ` +
      `address instead.`
    );
  }

  return (
    `The tab at ${host ?? '(an unparseable address)'} is outside this project's workspace, so the agent may not act on it. ` +
    `Allowed: ${domains.join(', ')}. Either add this host to "workspaceDomains" in ` +
    `${projectPath ?? 'g9.project.json'} and reconnect the bridge, or add "*" to allow every host, ` +
    `or ask the user to switch the side panel to Multi-tab mode for a one-off.`
  );
}

export function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
