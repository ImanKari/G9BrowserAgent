/**
 * The renderer's whole view of the machine: two functions and a subscription.
 *
 *   g9.invoke(op, args)  → Promise   one allowlisted operation in the main process (see main.mjs
 *                                      HANDLERS); errors come back as clean Error messages
 *   g9.on(topic, fn)     → unsubscribe  pushes from main: 'state', 'event', 'frame', 'pointer',
 *                                      'updater', 'navigate', 'watch', 'watchStatus', 'toast'
 *
 * Sandboxed preload (CommonJS, contextIsolation on, no Node in the page). Nothing here can reach a
 * file, a process or the daemon except through main's allowlist — and main, not the page, supplies
 * anything that must be trusted (the approver's name, file paths, reg.exe commands).
 */

const { contextBridge, ipcRenderer } = require('electron');

// Every topic main pushes and a view subscribes to. A topic missing here makes g9.on() throw, and a
// view that subscribes in mount() then stops half-mounted: 'watchStatus' was missing once, and the
// real window's Watch view came up with no tab list and no empty state while every fake-DOM test
// passed (test/views.test.mjs now runs this file; test/static.test.mjs checks the list).
const TOPICS = new Set(['state', 'event', 'frame', 'pointer', 'updater', 'navigate', 'watch', 'watchStatus', 'toast']);
const listeners = new Map();

ipcRenderer.on('g9:push', (_event, message) => {
  const set = listeners.get(message?.topic);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(message.data);
    } catch (err) {
      console.error(`g9 listener for ${message.topic} failed`, err);
    }
  }
});

contextBridge.exposeInMainWorld('g9', {
  async invoke(op, args) {
    const reply = await ipcRenderer.invoke('g9', String(op), args ?? {});
    if (reply && reply.ok) return reply.result;
    throw new Error(reply?.error ?? 'The desktop app did not answer.');
  },
  on(topic, fn) {
    if (!TOPICS.has(topic) || typeof fn !== 'function') throw new Error(`Unknown topic ${topic}`);
    if (!listeners.has(topic)) listeners.set(topic, new Set());
    listeners.get(topic).add(fn);
    return () => listeners.get(topic)?.delete(fn);
  },
});
