/**
 * (3.10) Scripts kept on a tab across reloads: browser_console action:"inject" | "injected" | "uninject".
 *
 * Why (suggestions box, 2026-11-07): a full-site UI review injects its helpers (measure, visit, words) with
 * evaluate; every full reload — a translation file under hot reload, a sign-in redirect — dropped them, and pasting
 * 5–7 KB again cost ~2,000 tokens of the model's context each time. An injected script runs in the page's MAIN world
 * (the page can see it, like evaluate) before the page's own scripts, on every load of this tab, and — runNow, the
 * default — once in the page that is open now.
 *
 * `Page.addScriptToEvaluateOnNewDocument` belongs to the CDP session: a script lasts while G9BrowserAgent stays
 * attached to the tab (a launched engine's tab: its life; the person's browser: until the debugger detaches — a
 * finish, a detach, the browser closing). The list of what is injected is kept per tab in session storage.
 */

import { platform } from '../lib/platform.js';
import { send, evaluate } from '../lib/cdp.js';
import { codedError } from '../lib/errcode.js';

const KEY = (tabId) => `inject:${tabId}`;
/** One script's size cap (characters). */
export const MAX_INJECT_CHARS = 512 * 1024;
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

async function readList(tabId) {
  const stored = await platform.storage.session.get(KEY(tabId));
  return Array.isArray(stored?.[KEY(tabId)]) ? stored[KEY(tabId)] : [];
}

const writeList = (tabId, list) => (list.length
  ? platform.storage.session.set({ [KEY(tabId)]: list })
  : platform.storage.session.remove(KEY(tabId)));

/** Inject `expression` under `name` (a script of the same name is replaced). */
export async function inject(tabId, { expression, name = null, runNow = true } = {}) {
  if (!expression || typeof expression !== 'string') {
    throw codedError('bad_argument', 'action:"inject" needs expression (or expressionFile): the script to keep on this tab.');
  }
  if (expression.length > MAX_INJECT_CHARS) {
    throw codedError('bad_argument', `The script is ${expression.length} characters; one injected script may be at most ${MAX_INJECT_CHARS}.`);
  }
  const list = await readList(tabId);
  const label = name == null || name === '' ? `script-${list.length + 1}` : String(name);
  if (!NAME_RE.test(label)) throw codedError('bad_argument', `name must be 1-64 letters, digits, "_", "." or "-" (got ${JSON.stringify(label)}).`);
  const replaced = list.find((s) => s.name === label);
  if (replaced) await send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: replaced.identifier }).catch(() => {});
  const { identifier } = await send(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source: expression });
  const entry = { name: label, identifier, chars: expression.length, addedAt: Date.now() };
  await writeList(tabId, [...list.filter((s) => s.name !== label), entry]);
  const out = { injected: label, chars: expression.length, ...(replaced ? { replaced: true } : {}) };
  if (runNow !== false) {
    try {
      await evaluate(tabId, expression);
      out.ranNow = true;
    } catch (err) {
      out.ranNow = false;
      out.nowError = String(err?.message ?? err).slice(0, 500);
    }
  }
  out.note = 'Runs in the page\'s main world before its own scripts on every load of this tab, while G9BrowserAgent stays attached to it. browser_console action:"injected" lists, action:"uninject" removes.';
  return out;
}

/** What is injected on this tab. */
export async function injected(tabId) {
  const list = await readList(tabId);
  return { scripts: list.map(({ name, chars, addedAt }) => ({ name, chars, addedAt })) };
}

/** Remove one script (name) or all of them (all:true). */
export async function uninject(tabId, { name = null, all = false } = {}) {
  const list = await readList(tabId);
  const gone = all === true ? list : list.filter((s) => s.name === name);
  if (!gone.length) {
    throw codedError('not_found', all === true ? 'Nothing is injected on this tab.' : `No script named ${JSON.stringify(name)} is injected on this tab (action:"injected" lists them).`);
  }
  for (const s of gone) await send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: s.identifier }).catch(() => {});
  await writeList(tabId, list.filter((s) => !gone.includes(s)));
  return { removed: gone.map((s) => s.name), note: 'Removed for the next loads; what already ran in the open page stays until it reloads.' };
}
