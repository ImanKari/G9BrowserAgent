/**
 * (3.5) "Leave without asking": a navigation or close that G9BrowserAgent itself makes with
 * `leaveWithoutAsking:true` accepts the page's own beforeunload prompt ("Leave site? Changes you
 * made may not be saved") at once, for that tab and for that call only.
 *
 * Without it the prompt froze the page, failed the navigation that raised it, and — through a
 * guard that was not scoped to its tab — kept another agent from opening a new tab (field report:
 * a whole image step stalled behind one "Leave site?"). The person's own beforeunload prompts, and
 * an agent's navigation without the flag, are untouched: they still surface as a dialog to handle.
 *
 * Worker memory on purpose: the arming lasts one call, and a worker restart mid-call ends the call.
 */

const armed = new Map(); // tabId → count of calls that armed it

export function armLeave(tabId) {
  armed.set(tabId, (armed.get(tabId) ?? 0) + 1);
}

export function disarmLeave(tabId) {
  const n = (armed.get(tabId) ?? 0) - 1;
  if (n > 0) armed.set(tabId, n);
  else armed.delete(tabId);
}

export function leaveArmed(tabId) {
  return (armed.get(tabId) ?? 0) > 0;
}

/** Run `fn` with the tab armed when `on` (a beforeunload prompt it raises is accepted). */
export async function withLeave(tabId, on, fn) {
  if (!on) return fn();
  armLeave(tabId);
  try {
    return await fn();
  } finally {
    disarmLeave(tabId);
  }
}
