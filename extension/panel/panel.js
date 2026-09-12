/**
 * Side panel bootstrap.
 *
 * Owns three things and nothing else: which tab body is on screen, the polling
 * loop, and the message listener that wakes the views when the service worker
 * says something changed. Each view module owns its own rendering and wiring.
 *
 * ## Why the panel is split
 *
 * Connecting an agent, recording a regression flow, and filing a defect share
 * nothing but the browser. They were one 657-line file; v1.7.0 roughly doubles
 * the automation half, and splitting after that growth is strictly more
 * expensive than splitting before it.
 */

import { api, el, view, showPanelError } from './ui.js';
import * as session from './session.js';
import * as automation from './automation.js';
import * as issues from './issues.js';

let firstRefresh = true;

el.tabs.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-tab]');
  if (!btn) return;
  view.active = btn.dataset.tab;
  for (const b of el.tabs.querySelectorAll('button')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === view.active));
  }
  for (const body of document.querySelectorAll('.tabbody')) {
    body.hidden = body.dataset.body !== view.active;
  }
  if (view.active === 'automation') {
    automation.refresh();
    automation.syncStatus();
  }
  if (view.active === 'issues') issues.refresh();
});

session.wire();
automation.wire();
issues.wire();

api.runtime.onMessage.addListener((msg) => {
  if (!msg?.__g9) return;
  if (msg.type === 'state' || msg.type === 'activity') session.refresh();
  else if (msg.type === 'dialog') showPanelError(`Page opened a ${msg.dialogType}: ${msg.message}`);
  else if (msg.type === 'detached') showPanelError('Debugger detached from the attached tab.');
});

setInterval(() => {
  session.refresh();
  automation.refresh();
  issues.refresh();
}, 2500);

session.refresh({ nudge: firstRefresh });
firstRefresh = false;
