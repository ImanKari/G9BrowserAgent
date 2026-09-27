/**
 * The welcome page: the version, big, and — after an update — what it replaced.
 *
 * The service worker opens `welcome.html` on install and `welcome.html?updated=1`
 * after an update. The version comes from the manifest, never from the HTML,
 * so this page cannot disagree with the build that is running. What it
 * REPLACED only the worker knows (it records `previousVersion` when the update
 * lands), so that part is asked for.
 */

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

const version = (() => {
  try {
    return api?.runtime?.getManifest?.().version ?? '';
  } catch {
    return '';
  }
})();
const params = new URLSearchParams(location.search);
const updated = params.get('updated') === '1';

$('ver').textContent = `v${version}`;
$('ver').setAttribute('aria-label', `Version ${version}`);
document.title = `G9BrowserAgent v${version} — ${updated ? 'updated' : 'installed'}`;
$('status').textContent = updated ? 'is updated in this browser.' : 'is installed in this browser.';
$('footer').textContent = `G9BrowserAgent v${version}${api?.runtime?.id ? ` · extension id ${api.runtime.id}` : ''}`;

if (updated) showUpdate();

async function ask(cmd) {
  try {
    const res = await api.runtime.sendMessage({ __g9cmd: true, cmd });
    return res?.ok ? res : null;
  } catch {
    return null; // the worker is still starting; the banner falls back below
  }
}

async function showUpdate() {
  // `about` is the v2 command for exactly this; getState carries the same
  // previousVersion and is the fallback.
  const about = await ask('about');
  let prev = about?.previousVersion ?? null;
  let at = about?.updatedAt ?? null;
  if (!prev) {
    const st = await ask('getState');
    prev = st?.state?.previousVersion ?? null;
    at = at ?? st?.state?.updatedAt ?? null;
  }
  prev = prev ?? params.get('from');
  const to = about?.version ?? version;

  const banner = $('updated');
  if (prev && prev !== to) {
    $('fromVer').textContent = `v${String(prev).replace(/^v/, '')}`;
    $('toVer').textContent = `v${to}`;
  } else {
    // Nothing on record to name. Say what is known rather than invent a "from".
    const line = banner.firstElementChild;
    line.replaceChildren(document.createTextNode('Updated to '), strong(`v${to}`));
  }
  const ms = typeof at === 'string' ? Date.parse(at) : at;
  if (Number.isFinite(ms)) $('updatedWhen').textContent = new Date(ms).toLocaleString();
  banner.hidden = false;
}

function strong(text) {
  const s = document.createElement('strong');
  s.textContent = text;
  return s;
}

// ---------------------------------------------------------- open the panel

/**
 * `sidePanel.open()` needs the user's click, and an `await` before it would
 * spend that gesture — so the window id is looked up now, ahead of the click,
 * and the call is made synchronously inside the handler.
 */
let windowId = null;
api?.tabs
  ?.getCurrent?.()
  .then((tab) => {
    windowId = tab?.windowId ?? null;
  })
  .catch(() => {});

$('openPanel').addEventListener('click', () => {
  const fallback = () => ask('detachPanel');
  if (api?.sidePanel?.open && windowId != null) {
    try {
      api.sidePanel.open({ windowId }).catch(fallback);
    } catch {
      fallback();
    }
  } else {
    fallback();
  }
});
