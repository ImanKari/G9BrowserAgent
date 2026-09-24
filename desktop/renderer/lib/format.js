/** Display formatting. Pure and browser-safe. */

export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const v = Math.max(0, Number(ms));
  if (v < 999.5) return `${Math.round(v)} ms`;
  if (v < 9950) return `${(v / 1000).toFixed(1)} s`;
  // Round once, at the unit shown, then split: rounding the remainder separately printed
  // "1 min 60 s" for 119.6 s and "60 s" for 59.6 s.
  const total = Math.round(v / 1000);
  if (total < 60) return `${total} s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const rs = total % 60;
    return rs ? `${m} min ${rs} s` : `${m} min`;
  }
  const minutes = Math.round(v / 60_000);
  const h = Math.floor(minutes / 60);
  const rm = minutes % 60;
  return rm ? `${h} h ${rm} min` : `${h} h`;
}

export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '—';
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${units[i]}`;
}

export function fmtClock(t) {
  if (t == null) return '—';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDateTime(t, now = Date.now()) {
  if (t == null) return '—';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '—';
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })} ${time}`;
}

export function fmtAgo(t, now = Date.now()) {
  if (t == null) return '—';
  const s = Math.round((now - Number(t)) / 1000);
  if (!Number.isFinite(s)) return '—';
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** A URL shortened for a narrow column: host + path, no scheme, ellipsis in the middle. */
export function shortUrl(u, max = 64) {
  let s = String(u ?? '');
  try {
    const url = new URL(s);
    s = `${url.host}${url.pathname === '/' ? '' : url.pathname}${url.search}`;
  } catch {
    /* not a URL; show as is */
  }
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.6);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}
