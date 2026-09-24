/**
 * Agents: who is connected, which tabs each one owns, and a per-agent Halt/Resume.
 * Plus the activity log — every tool call the daemon reports, newest first.
 */

import { h, replace } from '../lib/dom.js';
import { fmtAgo, fmtClock, fmtDuration, plural } from '../lib/format.js';
import { describeActivity } from '../lib/activity.js';
import { api, toast, viewHead, sectionHead, empty, chip, notConnected, go, busy } from '../ui.js';

let root = null;
let listEl = null;
let activityEl = null;
let lastKey = '';

export function mount(el) {
  root = el;
  listEl = h('div', { class: 'surface table-wrap' });
  activityEl = h('div', { class: 'surface activity' });
  replace(el,
    viewHead('Agents', 'AI agents connected to the daemon. Each tab has one owner at a time; a stopped agent keeps its tabs but can do nothing until you resume it.'),
    h('div', { class: 'section' }, listEl),
    h('div', { class: 'section' }, sectionHead('Activity', 'Every tool call, newest first.'), activityEl));
  lastKey = '';
  lastActivityKey = '';
}

export function unmount() {
  root = null;
}

export function update(s) {
  if (!root) return;
  const key = JSON.stringify([s.connection?.status, s.agents, s.tabs.map((t) => [t.tabId, t.title]), s.halted]);
  if (key !== lastKey) {
    lastKey = key;
    renderAgents(s);
  }
  renderActivity(s);
}

function renderAgents(s) {
  if (s.connection?.status !== 'connected') {
    replace(listEl, notConnected('The agent list'));
    return;
  }
  if (!s.agents.length) {
    replace(listEl, empty(
      'No agent is connected',
      'An AI client connects the first time one of its agents uses a browser tool. If your client never shows up here, register G9 with it in Setup.',
      [h('button', { type: 'button', class: 'btn', onclick: () => go('setup') }, 'Open Setup')],
    ));
    return;
  }
  const tabsById = new Map(s.tabs.map((t) => [t.tabId, t]));
  const rows = s.agents.map((a) => {
    const halted = a.halted || s.halted?.global;
    const toggle = h('button', { type: 'button', class: ['btn', 'small', a.halted ? 'primary' : 'danger'] }, a.halted ? 'Resume' : 'Halt');
    toggle.addEventListener('click', () => busy(toggle, async () => {
      await api.admin(a.halted ? 'resumeAgent' : 'haltAgent', { agentId: a.id });
      toast(a.halted ? `${a.name} resumed.` : `${a.name} halted. Its tabs stay owned; it cannot act until you resume it.`);
    }));
    return h('tr', null,
      h('td', null, h('div', { class: 'agent-name ellipsis' }, a.name), h('div', { class: 'mono muted' }, a.id, a.pid ? `, pid ${a.pid}` : '')),
      h('td', null, a.owned.length
        ? h('div', { class: 'tabs-cell' }, a.owned.map((id) => {
          const t = tabsById.get(id);
          return chip(`#${id}${t?.title ? ` ${t.title.slice(0, 28)}` : ''}`, 'tab-chip', t ? `${t.title}\n${t.url}` : `Tab ${id}`);
        }))
        : h('span', { class: 'muted' }, 'No tabs')),
      h('td', { class: 'nowrap muted' }, a.connectedAt ? fmtAgo(a.connectedAt) : '—'),
      h('td', null, halted ? chip(a.halted ? 'Halted' : 'Stopped (all)', 'fail') : chip('Active', 'ok')),
      h('td', { class: 'actions-cell' }, toggle));
  });
  replace(listEl, h('table', { class: 'grid' },
    h('colgroup', null, h('col', { style: { width: '26%' } }), h('col'), h('col', { style: { width: '120px' } }), h('col', { style: { width: '120px' } }), h('col', { style: { width: '96px' } })),
    h('thead', null, h('tr', null, h('th', null, 'Agent'), h('th', null, 'Tabs it owns'), h('th', null, 'Connected'), h('th', null, 'State'), h('th', null, h('span', { class: 'muted' }, '')))),
    h('tbody', null, rows)));
}

let lastActivityKey = '';
function renderActivity(s) {
  const items = s.activity ?? [];
  // The list is capped, so its length stops changing; the newest entry's arrival time does not.
  const key = `${s.connection?.status}|${items.length}|${items.at(-1)?.receivedAt ?? ''}`;
  if (key === lastActivityKey) return;
  lastActivityKey = key;
  if (!items.length) {
    replace(activityEl, h('p', { class: 'pad muted' }, s.connection?.status === 'connected' ? 'No tool calls yet in this session.' : 'Activity appears here while the daemon is connected.'));
    return;
  }
  const list = [...items].reverse().slice(0, 200).map((e) => {
    const row = describeActivity(e);
    return h('li', { class: row.ok ? '' : 'err', title: row.what },
      h('span', { class: 'muted mono' }, fmtClock(row.at ?? e.receivedAt)),
      h('span', { class: 'ellipsis', title: row.whoTitle ?? row.who }, row.who),
      h('span', { class: 'ellipsis' }, row.what),
      h('span', { class: 'muted nowrap' }, row.ms != null ? fmtDuration(row.ms) : ''));
  });
  replace(activityEl, h('ul', { 'aria-label': plural(items.length, 'tool call') }, list));
}

export function onEvent() {
  /* state snapshots carry everything this view shows */
}

