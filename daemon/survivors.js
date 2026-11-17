/**
 * (3.10) What a daemon restart takes with it: the launched browsers and their tabs.
 *
 * Why (suggestions box, 2026-11-07, and the 2026-11-17 restarts): when the daemon was replaced, every launched
 * browser and its signed-in tabs disappeared, and an agent found out from a failing call — with no idea which page
 * it had been on. The daemon now writes, every 15 s and when it stops, which launched engines run (browser, profile,
 * headless, stealth) and which tabs they hold (url, title, owner). The next daemon reads that file once: an agent
 * that reconnects (its link says which agentId it had) is told on its next result what it lost, and
 * `browser_tabs action:"restore"` launches the same profiles again and reopens its pages, old tab id → new.
 *
 * Only launched (Engine 2) tabs: the person's own browser keeps its tabs across a daemon restart (the extension
 * reconnects). A tab in an isolated context (browser_engine action:"context") comes back in its profile's default
 * context — the isolated context's cookies lived only in that browser.
 */

import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomicSync } from './paths.js';

const SAVE_EVERY_MS = 15_000;
/** A record older than this is not announced: the agents that held those tabs are long gone. */
const MAX_AGE_MS = 24 * 60 * 60_000;

export class Survivors {
  /**
   * @param {object} o
   * @param {string} o.file            G9_HOME/state/launched.json
   * @param {string} o.bootId          this daemon instance
   * @param {() => Promise<object>} o.snapshot  { engines: [...], tabs: [...] } of what runs now
   * @param {(...a) => void} [o.log]
   */
  constructor({ file, bootId, snapshot, log = () => {}, now = Date.now }) {
    this.file = file;
    this.bootId = bootId;
    this.snapshot = snapshot;
    this.log = log;
    this.now = now;
    this.previous = null;
    this.lastText = null;
    this.timer = null;
  }

  /** Read the previous daemon's record (once), then keep this one's. */
  start() {
    this.previous = this.#readPrevious();
    if (this.previous?.tabs?.length) {
      this.log(`[survivors] the previous daemon (${this.previous.bootId}) had ${this.previous.engines.length} launched engine(s) and ${this.previous.tabs.length} tab(s); their agents are told on reconnect`);
    }
    this.timer = setInterval(() => { this.save().catch((err) => this.log(`[survivors] ${err.message}`)); }, SAVE_EVERY_MS);
    this.timer.unref?.();
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    await this.save().catch(() => {});
  }

  #readPrevious() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
    if (!data || data.bootId === this.bootId || !Array.isArray(data.tabs) || !Array.isArray(data.engines)) return null;
    if (!(this.now() - Number(data.at) < MAX_AGE_MS)) return null;
    return data;
  }

  /** Write what runs now, when it changed. */
  async save() {
    const snap = await this.snapshot();
    const text = JSON.stringify({ engines: snap.engines, tabs: snap.tabs });
    if (text === this.lastText) return;
    this.lastText = text;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomicSync(this.file, `${JSON.stringify({ bootId: this.bootId, at: this.now(), engines: snap.engines, tabs: snap.tabs }, null, 2)}\n`);
  }

  /**
   * What an agent that held `previousAgentId` in the previous daemon (or has `identity`) lost; null when nothing.
   * Each tab is handed out once: a second connection claiming the same id gets nothing.
   */
  claimLost({ bootId, agentId = null, identity = null }) {
    const prev = this.previous;
    if (!prev || bootId !== prev.bootId) return null;
    const mine = prev.tabs.filter((t) => !t.claimed && ((agentId && t.owner === agentId) || (identity && t.ownerIdentity === identity)));
    if (!mine.length) return null;
    for (const t of mine) t.claimed = true;
    const engineIds = new Set(mine.map((t) => t.engine));
    return {
      at: prev.at,
      engines: prev.engines.filter((e) => engineIds.has(e.engineId)),
      tabs: mine.map(({ claimed, ...t }) => t),
    };
  }
}

/** The fields of a launched engine worth bringing back. */
export function engineRecord(info) {
  return {
    engineId: info.engineId,
    browser: info.browser ?? null,
    profile: info.profile ?? null,
    headless: info.headless !== false,
    stealth: info.stealth ?? null,
    ...(info.locale ? { locale: info.locale } : {}),
    ...(info.timezone ? { timezone: info.timezone } : {}),
  };
}
