/**
 * Side panel bootstrap.
 *
 * Owns four things and nothing else: the version on screen, which tab body is
 * showing, the polling loop, and the message listener that wakes the views
 * when the service worker says something changed. Each view module owns its
 * own rendering and wiring; ui.js holds what they share (the components of the
 * v3 visual system among it).
 *
 * ## Why the panel is split
 *
 * Connecting an agent, recording a regression flow, and filing a defect share
 * nothing but the browser. They were one 657-line file; v1.7.0 roughly doubled
 * the automation half, and splitting after that growth is strictly more
 * expensive than splitting before it.
 */

import { api, el, view, showPanelError, wireErrors, setTitle, toast, VERSION, PRODUCT } from './ui.js';
import * as session from './session.js';
import * as automation from './automation.js';
import * as issues from './issues.js';
import * as about from './about.js';

// The version first, before anything can fail: it is what a person looks for
// right after reloading the extension, and the title is all the detached
// window shows while it sits behind the page under test.
setTitle(null);
el.versionBadge.textContent = `v${VERSION}`;
el.versionBadge.title = `${PRODUCT} v${VERSION} — about this version`;

const TAB_NAMES = [...el.tabs.querySelectorAll('button[data-tab]')].map((b) => b.dataset.tab);

function select(name, { focus = false } = {}) {
  if (!TAB_NAMES.includes(name)) return;
  view.active = name;
  for (const b of el.tabs.querySelectorAll('button[data-tab]')) {
    const on = b.dataset.tab === name;
    b.setAttribute('aria-selected', String(on));
    // Roving tabindex: Tab reaches the strip once, the arrows move within it.
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  for (const body of document.querySelectorAll('.tabbody')) {
    body.hidden = body.dataset.body !== name;
  }
  if (name === 'session') session.refresh();
  if (name === 'automation') {
    automation.refresh();
    automation.syncStatus();
  }
  if (name === 'issues') issues.refresh();
  if (name === 'about') about.refresh({ force: true });
}

el.tabs.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-tab]');
  if (btn) select(btn.dataset.tab);
});

el.tabs.addEventListener('keydown', (ev) => {
  const i = TAB_NAMES.indexOf(view.active);
  const next = {
    ArrowRight: TAB_NAMES[(i + 1) % TAB_NAMES.length],
    ArrowLeft: TAB_NAMES[(i - 1 + TAB_NAMES.length) % TAB_NAMES.length],
    Home: TAB_NAMES[0],
    End: TAB_NAMES[TAB_NAMES.length - 1],
  }[ev.key];
  if (!next) return;
  ev.preventDefault();
  select(next, { focus: true });
});

el.versionBadge.addEventListener('click', () => select('about', { focus: true }));

wireErrors();
session.wire();
automation.wire();
issues.wire();
about.wire();

api.runtime.onMessage.addListener((msg) => {
  if (!msg?.__g9) return;
  switch (msg.type) {
    case 'state':
    case 'activity':
    case 'agents':
      session.refresh();
      break;
    case 'reconnecting':
      session.noteRetry(msg);
      break;
    // (v3, A3) An agent's input could not reach a hidden tab, or that is over:
    // the toast above the tab bar appears or goes at once, not at the next poll.
    case 'agentBlocked':
    case 'agentUnblocked':
      session.onBlockedMessage(msg);
      break;
    case 'dialog':
      showPanelError(`Page opened a ${msg.dialogType}: ${msg.message}`);
      break;
    // (3.2) An agent opened the live view for the person (browser_tabs action:"watch"). The window
    // came up without the keyboard and flashes in the taskbar; this says whose it is.
    case 'watchOpened':
      toast(`${msg.agent?.name ?? 'An agent'} opened a live view of tab #${msg.handle}${msg.engineKind === 'launched' ? ' (a launched browser)' : ''} — in its own window`);
      break;
    case 'detached':
      showPanelError('Debugger detached from the attached tab.');
      break;
    default:
      break;
  }
});

setInterval(() => {
  session.refresh();
  automation.refresh();
  issues.refresh();
  about.refresh();
}, 2500);

// The first read nudges the worker: someone just opened the panel, so a
// connection waiting out a long backoff is retried now instead.
session.refresh({ nudge: true });
