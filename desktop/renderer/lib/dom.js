/**
 * A tiny DOM builder. Text always goes in as text nodes: page titles, URLs, agent names and error
 * messages all come from outside this app, and none of them is ever parsed as HTML.
 */

export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'text') el.textContent = String(v);
      else if (v === true) el.setAttribute(k, '');
      else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

/** An inline SVG icon from a small fixed set (drawn here; no icon font, no external file). */
const ICONS = {
  agents: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM2.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M14 14.2c.6-.2 1.3-.2 2-.2 2.4 0 4.3 1.6 4.8 5',
  engines: 'M4 5h16v11H4zM8 20h8M12 16v4M7.5 9.5l2 1.5-2 1.5M11.5 12.5h4',
  watch: 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  runs: 'M5 4.5v15l13-7.5z',
  approvals: 'M4.5 12.5l4.5 4.5 10.5-10.5',
  schedule: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l3 2',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  setup: 'M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7L12 3.5Zm0 0v8.5m0 0 7.3-4.1M12 12l-7.3-4.1',
  stop: 'M7 7h10v10H7z',
  play: 'M8 5.5v13l10.5-6.5z',
  pause: 'M8 5.5h3v13H8zm5 0h3v13h-3z',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  folder: 'M3.5 6.5h6l2 2h9v10h-17z',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 4 2.8 19.5h18.4L12 4Zm0 6v4.5m0 2.5v.5',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
};

export function icon(name, { size = 18, label = null } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('icon');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', ICONS[name] ?? ICONS.alert);
  svg.append(p);
  return svg;
}
