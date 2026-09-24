/**
 * Engines, contexts, tabs and agents as the daemon reports them, normalised for display.
 * Pure and browser-safe; the main process uses the same functions for its state store.
 *
 * Contract shapes (ARCHITECTURE_V2 §7): EngineInfo = { engineId, kind:'launched', browser, version,
 * headless, profile, pid, argv, contexts:[ContextInfo], tabs:number[], startedAt };
 * ContextInfo = { contextId, engineId, humanize, stealth, locale, timezone, proxy, downloadPath }.
 * Extension engines (Engine 1) appear with kind 'extension'.
 */

export const pickList = (v, ...keys) => {
  if (Array.isArray(v)) return v;
  for (const k of keys) if (Array.isArray(v?.[k])) return v[k];
  return [];
};

/** An extension engine reports its browser as a user-agent string; name it. */
export function browserKind(b) {
  if (!b) return null;
  if (typeof b === 'object') return b.kind ?? null;
  const s = String(b);
  if (['edge', 'chrome', 'cft', 'auto'].includes(s)) return s;
  if (/\bEdg\//.test(s)) return 'edge';
  if (/\bChrome\//.test(s)) return 'chrome';
  return s;
}

function uaVersion(b) {
  // Edge's UA carries both Chrome/x (a frozen 153.0.0.0) and Edg/x (the real version): prefer Edg/.
  const s = String(b ?? '');
  const m = /\bEdg\/([\d.]+)/.exec(s) ?? /\bChrome\/([\d.]+)/.exec(s);
  return m ? m[1] : null;
}

export function normalizeEngine(e) {
  const x = e ?? {};
  return {
    engineId: String(x.engineId ?? x.id ?? ''),
    kind: x.kind ?? (String(x.engineId ?? x.id ?? '').startsWith('engine-') ? 'extension' : 'launched'),
    browser: browserKind(x.browser),
    // An extension row's `version` is the EXTENSION's version; the browser's comes from its UA.
    browserVersion: x.browser?.version ?? uaVersion(x.browser) ?? (x.kind === 'extension' ? null : x.version ?? null),
    version: x.version ?? x.browser?.version ?? null,
    versionMismatch: x.versionMismatch ?? null,
    headless: x.headless ?? null,
    profile: x.profile ?? null,
    pid: x.pid ?? null,
    startedAt: x.startedAt ?? null,
    contexts: pickList(x.contexts).map((c) => ({
      contextId: String(c.contextId ?? c.id ?? ''),
      humanize: c.humanize ?? null,
      stealth: c.stealth ?? null,
      locale: c.locale ?? null,
      timezone: c.timezone ?? null,
      proxy: c.proxy ?? null,
    })),
    tabs: pickList(x.tabs).map((t) => (typeof t === 'object' ? Number(t.tabId ?? t.id) : Number(t))).filter(Number.isFinite),
    name: x.name ?? null,
  };
}

export function normalizeTab(t) {
  const x = t ?? {};
  return {
    tabId: Number(x.tabId ?? x.id),
    title: x.title ?? '',
    url: x.url ?? '',
    engineId: x.engineId ?? (typeof x.engine === 'string' ? x.engine : x.engine?.engineId) ?? null,
    engineKind: x.engineKind ?? null,
    contextId: x.contextId ?? null,
    owner: x.owner ?? x.ownerId ?? null,
    ownerName: x.ownerName ?? null,
    active: !!x.active,
    session: x.session ?? x.name ?? null,
  };
}

export function normalizeAgent(a) {
  const x = a ?? {};
  return {
    id: String(x.id ?? x.agentId ?? ''),
    name: x.name ?? x.client?.name ?? 'agent',
    pid: x.pid ?? x.client?.pid ?? null,
    owned: pickList(x.owned, 'tabs').map((t) => (typeof t === 'object' ? Number(t.tabId ?? t.id) : Number(t))).filter(Number.isFinite),
    halted: !!(x.halted ?? false),
    connectedAt: x.connectedAt ?? x.since ?? null,
    current: x.current ?? x.currentTabId ?? null,
  };
}

/**
 * `engines.versions` → { browsers:[{kind,path,version}], cft:{ pinned, installed:[{version,path}], pinnedInstalled } }.
 * Accepts the likely envelopes (see the contract gap note in desktop/README.md).
 */
export function normalizeVersions(v) {
  const all = pickList(v, 'browsers', 'installed', 'found');
  const browsers = all.filter((b) => b && b.kind !== 'cft').map((b) => ({ kind: b.kind, path: b.path ?? null, version: b.version ?? null }));
  let cftList = [];
  if (Array.isArray(v?.cft)) cftList = v.cft;
  else if (v?.cft && typeof v.cft === 'object') cftList = pickList(v.cft, 'installed');
  if (!cftList.length) cftList = pickList(v, 'cftInstalled', 'installedCft');
  if (!cftList.length) cftList = all.filter((b) => b?.kind === 'cft');
  const pinnedRaw = v?.pinned ?? v?.cft?.pinned ?? null;
  const pinned = typeof pinnedRaw === 'string' ? pinnedRaw : pinnedRaw?.version ?? null;
  const installed = cftList.map((c) => ({ version: c.version ?? null, path: c.path ?? null })).filter((c) => c.version);
  return { browsers, cft: { pinned, installed, pinnedInstalled: !!pinned && installed.some((c) => c.version === pinned) } };
}

/** Tabs grouped by engine, for the Watch picker. */
export function groupTabs(tabs, engines) {
  const groups = new Map();
  for (const e of engines) groups.set(e.engineId, { engine: e, tabs: [] });
  for (const t of tabs) {
    const key = t.engineId ?? engines.find((e) => e.tabs.includes(t.tabId))?.engineId ?? 'unknown';
    if (!groups.has(key)) groups.set(key, { engine: { engineId: key, kind: t.engineKind ?? (key === 'unknown' ? 'unknown' : 'extension') }, tabs: [] });
    groups.get(key).tabs.push(t);
  }
  return [...groups.values()].filter((g) => g.tabs.length);
}

/**
 * What `engines.installCft` installed. g9d answers with the whole versions report and the result
 * under `cft.downloaded: { version, path }` (engine/manager.js versions({download:true})).
 */
export function installedCft(result, fallbackVersion = null) {
  const d = result?.cft?.downloaded ?? result?.downloaded ?? null;
  return { version: d?.version ?? result?.version ?? fallbackVersion ?? null, path: d?.path ?? result?.path ?? null };
}
