/**
 * The activity log, as data: every `activity` UI event the daemon sends, reduced to one row
 * { at, who, whoTitle, what, ok, ms, kind }. Pure and browser-safe (main filters with it, the
 * Agents view renders with it).
 *
 * Shapes on the wire (DAEMON_PROTOCOL §5, daemon/daemon.js, daemon/router.js):
 *   agent tool call   { kind:'tool', agentId, name, tool, detail, ok, ms, at }        (the daemon's own record;
 *                                                                                    on failure `detail` ends "— <error>")
 *   engine activity   { engine:<engineId>|'launched', kind:'tool', tool, tabId, ok, detail, ms, by?, at }
 *                     the engine's copy of a call it ran; `by` = the calling agent's name
 *   takeover          { kind:'takeover', by, engine, tabs, detail, at }
 *   dialog            { kind:'dialog', engine, tabId, type, message, at }
 *   download          { kind:'download', engine, filename?, url?, state?, … }
 *   cft-download      { engine:'launched', kind:'cft-download', phase?, percent?, receivedBytes?, totalBytes?, version? }
 *   profile-warm      { engine:'launched', kind:'profile-warm', profile, warmed, reason }
 */

/**
 * An engine's own record of a call an AGENT made repeats the daemon's record of the same call, so
 * it is not shown twice. Since g9d 2.0.0 (F7) the daemon does not forward those at all — it tags
 * the calls it relays and drops their echo (`relayed:true`); this filter stays as the backstop for
 * a daemon that does. An engine record without `by`/`relayed` is the person acting in their own
 * browser (the side panel), which only the engine knows about — that one is kept.
 */
export function isDuplicateEngineActivity(e) {
  return !!(e && e.engine && e.kind === 'tool' && (e.relayed === true || e.by) && !e.agentId);
}

/**
 * Engine 2 (engine/manager.js) forwards EVERY side-panel broadcast of a launched browser to the
 * daemon as one activity record { engine:'launched', kind:'engine2', message }, and the daemon
 * passes it on. Measured 2026-09-22 against g9d 2.0.0: 77 of 126 activity events in a short session
 * were these wrappers — `state` snapshots (the whole panel state), `replayProgress` ticks, and the
 * engine's own copy of every call ({type:'activity', entry:{…, by, relayed:true}}), whose F7 tag
 * the daemon cannot see inside the wrapper. Each rendered as "engine2 [object Object]".
 *
 * Returns what belongs in the log: a non-wrapper unchanged; for a wrapper, the tool entry it
 * carries (tagged with its engine, so isDuplicateEngineActivity can drop an agent's echo), or null
 * for panel traffic (state, progress, attach/detach bookkeeping), which is not a tool call.
 */
export function unwrapEngineActivity(e) {
  if (!e || typeof e !== 'object' || e.kind !== 'engine2') return e ?? null;
  const m = e.message;
  if (!m || m.type !== 'activity' || !m.entry || typeof m.entry !== 'object' || m.entry.kind !== 'tool') return null;
  return { ...m.entry, engine: m.entry.engine ?? e.engine ?? 'launched' };
}

/**
 * The desktop's own reads (the lists and gets its views refresh with) are recorded by the daemon
 * like any client's calls. They are how this window stays current, not something an agent did, and
 * they would otherwise fill the log (a dozen browser_recording(list) in a minute of Runs). The
 * desktop's own changes (launch, stop, approve) stay in the log.
 */
const OWN_READS = new Set(['browser_status', 'browser_recording:list', 'browser_recording:get', 'browser_engine:list', 'browser_engine:versions', 'browser_tabs:list']);
export function isOwnReadActivity(e, ownClientId) {
  if (!e || e.kind !== 'tool' || !ownClientId || e.agentId !== ownClientId) return false;
  const action = String(e.detail ?? '').match(/^[\w.-]+\((\w+)/)?.[1] ?? null;
  return OWN_READS.has(e.tool) || OWN_READS.has(`${e.tool}:${action}`);
}

/** The daemon's detail is `tool(args…)` (daemon.js summarize): shown as it is, not after the tool name again. */
function toolWhat(x) {
  const detail = x.detail ?? x.summary ?? x.action ?? x.args?.action ?? null;
  if (detail != null && x.tool && (String(detail) === x.tool || String(detail).startsWith(`${x.tool}(`))) return String(detail);
  return [x.tool, detail].filter(Boolean).join(' ');
}

/** Anything the log shows as text: an object is summarised, never "[object Object]". */
function asText(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'object') return String(v);
  if (typeof v.message === 'string') return v.message;
  if (typeof v.type === 'string') return v.type;
  try {
    return JSON.stringify(v).slice(0, 120);
  } catch {
    return null;
  }
}

function pct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n)}%` : null;
}

export function describeActivity(e) {
  const x = e && typeof e === 'object' ? e : {};
  const at = x.at ?? x.receivedAt ?? null;
  const ms = x.ms ?? x.durationMs ?? null;
  const failed = x.ok === false || !!x.error;
  const engineName = x.engine ? (x.engine === 'launched' ? 'launched engine' : String(x.engine)) : null;
  let who = x.name ?? x.caller?.name ?? x.agentName ?? x.by ?? null;
  let whoTitle = x.agentId ?? null;
  let what;
  switch (x.kind) {
    case 'tool':
      what = toolWhat(x);
      if (!who) who = x.engine ? `${engineName} (you, in the side panel)` : x.agentId ?? '';
      break;
    case 'takeover':
      what = x.detail ?? `took over ${Array.isArray(x.tabs) ? `tab(s) ${x.tabs.join(', ')}` : 'tabs'}${engineName ? ` in ${engineName}` : ''}`;
      who = who ?? x.by ?? '';
      break;
    case 'dialog':
      what = `A ${x.type ?? 'JavaScript'} dialog blocks tab ${x.tabId ?? '?'}${x.message ? `: "${String(x.message).slice(0, 160)}"` : ''}`;
      who = engineName ?? '';
      break;
    case 'download': {
      const file = x.filename ?? x.path ?? x.url ?? 'a file';
      what = `Download ${String(file).split(/[\\/]/).pop()}${x.state ? ` (${x.state})` : ''}${x.tabId != null ? ` from tab ${x.tabId}` : ''}`;
      who = engineName ?? '';
      break;
    }
    case 'cft-download': {
      const share = pct(x.percent) ?? (x.totalBytes ? pct((100 * (x.receivedBytes ?? 0)) / x.totalBytes) : null);
      what = `Chrome for Testing${x.version ? ` ${x.version}` : ''}: ${x.phase ?? x.stage ?? 'downloading'}${share ? ` ${share}` : ''}`;
      who = 'daemon';
      break;
    }
    case 'profile-warm':
      what = `Profile ${x.profile ?? '?'} ${x.warmed ? 'signed in and closed' : `closed${x.reason ? ` (${x.reason})` : ''}`}`;
      who = 'daemon';
      break;
    default: {
      const parts = [x.kind, x.tool, asText(x.detail ?? x.summary ?? x.message ?? x.action)].filter(Boolean);
      what = parts.length ? parts.join(' ') : JSON.stringify(x).slice(0, 120);
      who = who ?? engineName ?? '';
    }
  }
  if (x.error && !String(what).includes(String(x.error))) what = `${what} — ${String(x.error).slice(0, 200)}`;
  if (!whoTitle && x.engine) whoTitle = String(x.engine);
  return { at, who: String(who ?? ''), whoTitle, what: String(what ?? ''), ok: !failed, ms, kind: x.kind ?? null };
}
