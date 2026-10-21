/**
 * The daemon's registry: who is connected, which engines exist, which tab is
 * whose, and whether anyone pressed Stop.
 *
 * Everything the protocol promises about sharing (DAEMON_PROTOCOL §7) is decided
 * here, in one object with no I/O, so it can be unit-tested without a socket:
 *
 * - **Handles.** Tab ids are daemon-wide integers shared by all engines. Engine 2
 *   tabs are born with one (`platform-cdp` calls `allocHandle` through
 *   `allocTabId`). Engine 1 tabs are Chrome tab ids inside ONE browser, so they
 *   are mapped `(engineId, chromeTabId) ↔ handle`; two browsers can both have a
 *   tab 1234 and they must not collide.
 * - **Ownership.** The first mutating call on an unowned tab claims it; another
 *   agent's mutating call is refused with the owner's name; reads are never
 *   refused; a disconnect releases every claim; `force` takes over and is logged.
 *   This replaces v1's "one bridge, one extension" exclusivity, which was
 *   exclusive about the wrong thing (the socket, not the tab).
 * - **Queues.** Mutating calls on one tab run strictly one at a time: two agents
 *   typing into one page, or one agent firing two clicks without waiting, would
 *   otherwise interleave input events inside the renderer.
 * - **Halts.** A global halt (desktop Stop, or the panel's Stop reported by the
 *   extension) and per-agent halts. An agent can never clear either — the same
 *   rule v1 learned the hard way when pinning a tab silently cleared Stop (§4.5).
 * - **Extension identity across reconnects (decision D-c).** An MV3 service
 *   worker is torn down and restarted by the browser, and the desktop app
 *   reloads the extension after an update: each time the socket drops and a
 *   new one says hello. v2.0 at first gave the new socket a new engine id and
 *   every tab a new handle, so every agent lost its claims, session names and
 *   current tab mid-task. The extension now sends a random `instanceId` it
 *   generated once (storage.local); an engine that disconnects is PARKED, not
 *   dropped, and the same instanceId saying hello within ENGINE_RESUME_MS gets
 *   the same engine id, handles, claims, sessions and current tabs back. Tabs
 *   that no longer exist are dropped at that moment (see #resume for how a
 *   browser restart, whose Chrome tab ids start over, is told apart).
 */

import { EventEmitter } from 'node:events';

/** How long a disconnected extension engine keeps its identity (decision D-c). */
export const ENGINE_RESUME_MS = 10 * 60_000;

/**
 * (3.5) An owner that is still CONNECTED but has sent nothing for this long, with no call running,
 * loses the right to block others: the next agent's state-changing call takes the tab (logged as a
 * takeover, and said in that agent's result). Connections outlive their agents — an HTTP session
 * stays open 30 idle minutes, a crashed client's socket lingers, a service restart makes a new agent
 * — and their tabs stayed locked (field report). `G9_IDLE_CLAIM_MINUTES` (0 = never).
 */
export const IDLE_CLAIM_MS = (Number.isFinite(Number(process.env.G9_IDLE_CLAIM_MINUTES)) && process.env.G9_IDLE_CLAIM_MINUTES !== ''
  ? Number(process.env.G9_IDLE_CLAIM_MINUTES) : 15) * 60_000;

/**
 * (3.4) How long the tabs a departed agent IDENTITY owned are remembered for its successor. A
 * stateless MCP client (a panel gate, a script) may open a fresh MCP session — so a fresh daemon
 * connection, a new agent-N — for every request. Its tabs and current tab used to stay with the
 * previous agent-N (refused as "owned by agent-N" until that session idled out after 30 minutes).
 * Now an agent that says who it is (`identity`: the MCP client's name, or the X-G9-Agent header)
 * takes over what the previous connection of the same identity owned. Remembering costs nobody
 * anything: a departed owner never blocks another agent (ensureOwnership ignores a disconnected
 * owner), the successor only takes back what is still unclaimed.
 */
export const AGENT_RESUME_MS = 10 * 60_000;

/** The same page, ignoring the fragment (a #hash change is not another document). */
function samePage(a, b) {
  const strip = (u) => String(u ?? '').split('#')[0];
  return strip(a) === strip(b);
}

export class Registry extends EventEmitter {
  constructor({ log = () => {}, resumeMs = ENGINE_RESUME_MS, idleClaimMs = IDLE_CLAIM_MS } = {}) {
    super();
    this.log = log;
    /** (3.5) A connected owner with no call for this long no longer blocks others (0 disables). */
    this.idleClaimMs = Number.isFinite(Number(idleClaimMs)) && Number(idleClaimMs) >= 0 ? Number(idleClaimMs) : IDLE_CLAIM_MS;
    /** 0 disables parking: a disconnected extension drops its tabs at once (the v2.0 behaviour). */
    this.resumeMs = Number.isFinite(Number(resumeMs)) && Number(resumeMs) >= 0 ? Number(resumeMs) : ENGINE_RESUME_MS;
    /** instanceId → { id, instanceId, loadId, parkedAt, timer } — extension engines waiting to reconnect. */
    this.parked = new Map();
    /** (3.4) agent identity → { id, owned:[handle], current, at, timer } — what a departed agent held. */
    this.departed = new Map();
    this.counters = { agent: 0, engine: 0, ui: 0, viewer: 0, launched: 0 };
    this.clients = new Map();

    this.nextHandle = 1;
    this.handles = new Map(); // handle → { engineId, chromeTabId|null, createdAt }
    this.byChrome = new Map(); // `${engineId}\u0000${chromeTabId}` → handle

    this.launched = new Map(); // engineId → info (kept current by EngineManager)
    /**
     * engineId → { holders: Set(clientId), stopWhenReleased } — who is USING a launched engine
     * across tabs (a runner between two flows owns no tab, but still needs the browser). The
     * daemon, not a client, stops an engine launched with stopWhenReleased once the last lease is
     * gone and no connected agent owns a tab there (daemon review, 2026-09-22: a runner stopped the
     * engine another run had reused, between that run's flows).
     */
    this.leases = new Map();

    this.sessions = new Map(); // name → handle
    this.owners = new Map(); // handle → agentId
    this.queues = new Map(); // handle → tail promise

    this.global = { halted: false, by: null, at: null };
  }

  // ------------------------------------------------------------- clients

  /**
   * Register a client after its hello. `role` is 'agent' | 'engine' | 'ui' | 'viewer'
   * (the runner is an agent; a v1 'extension' hello is normalised to 'engine'
   * before it gets here; a viewer — the extension's watch window, 3.1 — may only watch).
   */
  addClient({
    role, name = null, pid = null, version = null, send = () => false, browser = null, cwd = null, project = null, origin = null,
    instanceId = null, loadId = null, tabs = null, identity = null,
  }) {
    if (!['agent', 'engine', 'ui', 'viewer'].includes(role)) throw new Error(`Unknown client role "${role}".`);
    // An extension engine that was here a moment ago (same instanceId) gets its identity back.
    const resumed = role === 'engine' && instanceId ? this.#resume(String(instanceId), { loadId, tabs }) : null;
    let id;
    if (resumed) {
      id = resumed.id;
    } else {
      this.counters[role] += 1;
      id = `${role}-${this.counters[role]}`;
    }
    const client = {
      id,
      role,
      name: name || (role === 'engine' ? 'extension' : role === 'ui' ? 'desktop' : role === 'viewer' ? 'viewer' : 'agent'),
      pid,
      version,
      browser,
      cwd,
      project,
      origin,
      send,
      connectedAt: Date.now(),
      lastCallAt: Date.now(),
      inflight: 0,
      halted: false,
      haltedBy: null,
      current: null,
      ...(role === 'agent' ? { identity: identity ? String(identity).slice(0, 120) : null } : {}),
      ...(role === 'engine' ? { instanceId: instanceId ? String(instanceId) : null, loadId: loadId ? String(loadId) : null, resumed } : {}),
    };
    this.clients.set(id, client);
    this.emit('clients', { added: id, role });
    if (role === 'agent' || role === 'ui') this.emit('agents');
    if (role === 'engine') this.emit('engines');
    return client;
  }

  /**
   * Forget a client: release its claims; for an engine, every tab it had —
   * unless it can come back (an `instanceId`, decision D-c): then it is parked
   * with its tabs, claims and sessions intact for `resumeMs`.
   *
   * `expected` guards a superseded socket: when a reconnect already took this
   * id over, the old socket's late close must not remove the new client.
   */
  removeClient(id, { expected = null } = {}) {
    const client = this.clients.get(id);
    if (!client || (expected && client !== expected)) return { released: [], dropped: [], parked: false };
    this.clients.delete(id);
    // (3.4) What an agent with an identity held is remembered for its successor (AGENT_RESUME_MS).
    const heldCurrent = client.role === 'agent' ? client.current : null;
    const released = this.releaseAll(id);
    if (client.role === 'agent' && client.identity && (released.length || heldCurrent != null)) {
      this.#rememberDeparted(client, released, heldCurrent);
    }
    // A client that goes away (a runner that ended or crashed) holds no engine any more.
    for (const engineId of this.leasesOf(id)) this.releaseLease(engineId, id);
    let dropped = [];
    let parked = false;
    if (client.role === 'engine') {
      if (client.instanceId && this.resumeMs > 0) {
        this.#park(client);
        parked = true;
      } else {
        dropped = this.dropEngine(id, 'the extension disconnected');
      }
    }
    this.emit('clients', { removed: id, role: client.role, parked });
    this.emit('agents');
    if (client.role === 'engine') this.emit('engines');
    return { released, dropped, client, parked };
  }

  /** A connected extension engine with this instanceId (a reconnect racing the old socket's close). */
  engineByInstance(instanceId) {
    if (!instanceId) return null;
    for (const c of this.clients.values()) if (c.role === 'engine' && c.instanceId === String(instanceId)) return c;
    return null;
  }

  #park(client) {
    const previous = this.parked.get(client.instanceId);
    if (previous) clearTimeout(previous.timer);
    const entry = { id: client.id, instanceId: client.instanceId, loadId: client.loadId, parkedAt: Date.now(), timer: null };
    entry.timer = setTimeout(() => this.#expire(entry), this.resumeMs);
    entry.timer.unref?.();
    this.parked.set(client.instanceId, entry);
    this.log(`[engines] ${client.id} disconnected; its ${this.handlesOf(client.id).length} tab handle(s), claims and sessions are kept for ${Math.round(this.resumeMs / 1000)} s in case it reconnects`);
  }

  #expire(entry) {
    if (this.parked.get(entry.instanceId) !== entry) return;
    this.parked.delete(entry.instanceId);
    const minutes = Math.round(this.resumeMs / 60_000);
    const dropped = this.dropEngine(entry.id, `the extension did not reconnect within ${minutes || '<1'} minute(s)`);
    this.log(`[engines] ${entry.id} did not reconnect; dropped ${dropped.length} tab handle(s)`);
    this.emit('engines');
  }

  /**
   * The parked engine for this instanceId, taken back: which of its handles
   * still name the same tab, and which are dropped now.
   *
   * Chrome tab ids are unique within ONE browser session. A worker restart
   * keeps the session (the extension's `loadId`, kept in storage.session, is
   * the same): every tab that still exists keeps its handle. An extension
   * reload, or a browser restart — after which Chrome numbers tabs from the
   * start again, so tab 12 may now be a different page — changes the loadId;
   * then a handle is kept only when its tab id exists AND still shows the page
   * the daemon last saw there (fragment ignored). A tab that navigated during
   * that gap loses its handle: an agent re-listing tabs is a small cost next
   * to acting on the wrong page of someone's browser. Without a tab list and
   * without the same loadId nothing can be verified, so nothing is kept.
   */
  #resume(instanceId, { loadId = null, tabs = null } = {}) {
    const entry = this.parked.get(instanceId);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this.parked.delete(instanceId);
    if (Date.now() - entry.parkedAt > this.resumeMs) {
      this.dropEngine(entry.id, 'the extension did not reconnect in time');
      return null;
    }
    const sameLoad = !!(loadId && entry.loadId && String(loadId) === entry.loadId);
    const present = Array.isArray(tabs)
      ? new Map(tabs.filter((t) => Number.isInteger(t?.tabId)).map((t) => [t.tabId, t.url ?? null]))
      : null;
    const kept = [];
    const dropped = [];
    for (const handle of this.handlesOf(entry.id)) {
      const h = this.handles.get(handle);
      let why = null;
      if (present) {
        if (!present.has(h.chromeTabId)) why = 'the tab closed while the extension was reconnecting';
        else if (!sameLoad && h.url != null && !samePage(h.url, present.get(h.chromeTabId))) {
          why = 'after the extension or the browser restarted, that tab id shows another page; it is treated as a different tab';
        }
      } else if (!sameLoad) {
        why = 'the extension restarted without saying which tabs are open, so the tab could not be verified';
      }
      if (why) {
        this.dropHandle(handle, why);
        dropped.push(handle);
      } else {
        kept.push(handle);
      }
    }
    this.log(`[engines] ${entry.id} reconnected after ${Math.round((Date.now() - entry.parkedAt) / 1000)} s (${sameLoad ? 'same browser session' : 'extension or browser restarted'}): kept ${kept.length} tab handle(s), dropped ${dropped.length}`);
    return { id: entry.id, kept, dropped, sameLoad, parkedMs: Date.now() - entry.parkedAt };
  }

  #rememberDeparted(client, owned, current) {
    const previous = this.departed.get(client.identity);
    if (previous) clearTimeout(previous.timer);
    const entry = { id: client.id, owned: [...owned], current, at: Date.now(), timer: null };
    entry.timer = setTimeout(() => {
      if (this.departed.get(client.identity) === entry) this.departed.delete(client.identity);
    }, AGENT_RESUME_MS);
    entry.timer.unref?.();
    this.departed.set(client.identity, entry);
  }

  /**
   * (3.4) A new connection of an agent identity takes over what the identity held: the tabs owned by
   * another CONNECTED agent of the same identity (an older MCP session the client simply abandoned),
   * else what a departed one owned that nobody has claimed since, and the current tab. The older
   * connection keeps its socket and owns nothing afterwards. → { from:[agentId], tabs:[handle],
   * current } or null when there was nothing to take.
   */
  adoptIdentity(clientId) {
    const client = this.clients.get(clientId);
    if (!client || client.role !== 'agent' || !client.identity) return null;
    const tabs = [];
    const from = [];
    let current = null;
    const others = this.agents()
      .filter((a) => a.id !== clientId && a.identity === client.identity)
      .sort((a, b) => b.connectedAt - a.connectedAt);
    for (const other of others) {
      for (const handle of this.ownedBy(other.id)) {
        this.owners.set(handle, clientId);
        tabs.push(handle);
      }
      if (current == null && other.current != null && this.handles.has(other.current)) current = other.current;
      for (const engineId of this.leasesOf(other.id)) {
        const lease = this.leases.get(engineId);
        lease.holders.delete(other.id);
        lease.holders.add(clientId);
      }
      other.supersededBy = clientId;
      from.push(other.id);
    }
    const gone = this.departed.get(client.identity);
    if (gone) {
      clearTimeout(gone.timer);
      this.departed.delete(client.identity);
      for (const handle of gone.owned) {
        if (!this.handles.has(handle) || tabs.includes(handle)) continue;
        const owner = this.owners.get(handle);
        if (owner && owner !== gone.id && this.clients.has(owner)) continue; // someone else took it meanwhile
        this.owners.set(handle, clientId);
        tabs.push(handle);
      }
      if (current == null && gone.current != null && this.handles.has(gone.current)) current = gone.current;
      from.push(gone.id);
    }
    if (!from.length) return null;
    if (current != null && client.current == null) client.current = current;
    this.log(`[agents] ${this.describe(clientId)} took over identity "${client.identity}" from ${from.join(', ')}: tabs ${tabs.join(', ') || 'none'}${current != null ? `, current tab ${current}` : ''}`);
    this.emit('agents');
    return { from, tabs: tabs.sort((a, b) => a - b), current: client.current ?? null };
  }

  isParked(engineId) {
    for (const p of this.parked.values()) if (p.id === engineId) return true;
    return false;
  }

  parkedEngines() {
    return [...this.parked.values()].map((p) => ({ engineId: p.id, parkedAt: p.parkedAt, resumeUntil: p.parkedAt + this.resumeMs }));
  }

  getClient(id) {
    return this.clients.get(id) ?? null;
  }

  byRole(role) {
    return [...this.clients.values()].filter((c) => c.role === role);
  }

  agents() {
    return this.byRole('agent');
  }

  extensionEngines() {
    return this.byRole('engine');
  }

  /** 'agent-2 (cursor)' — how a client is named in every message a person reads. */
  describe(id) {
    const client = this.clients.get(id);
    if (!client) return String(id);
    return client.name && client.name !== client.id ? `${client.id} (${client.name})` : client.id;
  }

  setName(id, name) {
    const client = this.clients.get(id);
    if (!client || !name || client.name === name) return;
    client.name = String(name).slice(0, 80);
    this.emit('agents');
  }

  // ------------------------------------------------------------- engines

  nextLaunchedId() {
    this.counters.launched += 1;
    return `launched-${this.counters.launched}`;
  }

  addLaunchedEngine(info) {
    this.launched.set(info.engineId, info);
    this.emit('engines');
  }

  updateLaunchedEngine(engineId, patch) {
    const info = this.launched.get(engineId);
    if (info) Object.assign(info, patch);
  }

  removeLaunchedEngine(engineId, reason = 'the engine stopped') {
    this.launched.delete(engineId);
    this.leases.delete(engineId);
    const dropped = this.dropEngine(engineId, reason);
    this.emit('engines');
    return dropped;
  }

  /** 'extension' for an extension engine id (connected or parked), 'launched' for a launched one, null when unknown. */
  engineKind(engineId) {
    if (!engineId) return null;
    if (this.launched.has(engineId)) return 'launched';
    const client = this.clients.get(engineId);
    if (client?.role === 'engine') return 'extension';
    if (this.isParked(engineId)) return 'extension';
    return null;
  }

  // ------------------------------------------------------------- engine leases

  /** `clientId` uses launched engine `engineId`; `stopWhenReleased` is set by the call that launched it. */
  acquireLease(engineId, clientId, { stopWhenReleased = false } = {}) {
    let lease = this.leases.get(engineId);
    if (!lease) {
      lease = { holders: new Set(), stopWhenReleased: false };
      this.leases.set(engineId, lease);
    }
    lease.holders.add(clientId);
    if (stopWhenReleased) lease.stopWhenReleased = true;
    this.emit('engines');
    return { engineId, holders: [...lease.holders], stopWhenReleased: lease.stopWhenReleased };
  }

  /** → true when `clientId` held a lease on it. Emits 'leaseReleased' so the daemon can decide to stop it. */
  releaseLease(engineId, clientId) {
    const lease = this.leases.get(engineId);
    if (!lease?.holders.delete(clientId)) return false;
    this.emit('leaseReleased', { engineId, by: clientId, remaining: lease.holders.size });
    this.emit('engines');
    return true;
  }

  leaseHolders(engineId) {
    return [...(this.leases.get(engineId)?.holders ?? [])];
  }

  leasesOf(clientId) {
    const out = [];
    for (const [engineId, lease] of this.leases) if (lease.holders.has(clientId)) out.push(engineId);
    return out;
  }

  /** Launched engines whose last lease is gone and that asked to be stopped then. */
  releasedEngines() {
    const out = [];
    for (const [engineId, lease] of this.leases) if (lease.stopWhenReleased && lease.holders.size === 0) out.push(engineId);
    return out;
  }

  // ------------------------------------------------------------- handles

  /** A fresh daemon-wide handle. Engine 2 binds it with `bindHandle` once it knows the engine. */
  allocHandle() {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    return handle;
  }

  bindHandle(handle, engineId) {
    const entry = this.handles.get(handle);
    if (entry && entry.engineId === engineId) return;
    this.handles.set(handle, { engineId, chromeTabId: null, createdAt: Date.now() });
  }

  /** Handle for an Engine 1 tab; unknown Chrome ids get a new handle unless create:false. */
  handleForChrome(engineId, chromeTabId, { create = true } = {}) {
    if (!Number.isInteger(chromeTabId)) return null;
    const key = `${engineId}\u0000${chromeTabId}`;
    const existing = this.byChrome.get(key);
    if (existing != null) return existing;
    if (!create) return null;
    const handle = this.allocHandle();
    this.handles.set(handle, { engineId, chromeTabId, createdAt: Date.now() });
    this.byChrome.set(key, handle);
    return handle;
  }

  /** The page the daemon last saw in an Engine 1 tab (from the extension's `tabs` pushes); what #resume compares. */
  noteUrl(handle, url) {
    const entry = this.handles.get(handle);
    if (entry && typeof url === 'string') entry.url = url;
  }

  /** Chrome tab id behind a handle, when the handle belongs to that extension engine. */
  chromeTabOf(handle, engineId = null) {
    const entry = this.handles.get(handle);
    if (!entry || entry.chromeTabId == null) return null;
    if (engineId && entry.engineId !== engineId) return null;
    return entry.chromeTabId;
  }

  engineOf(handle) {
    return this.handles.get(handle)?.engineId ?? null;
  }

  hasHandle(handle) {
    return this.handles.has(handle);
  }

  handlesOf(engineId) {
    const out = [];
    for (const [handle, entry] of this.handles) if (entry.engineId === engineId) out.push(handle);
    return out;
  }

  /**
   * A tab is gone (closed, engine stopped, extension disconnected). Everything
   * that pointed at it goes with it — an ownership claim or a session name that
   * outlives its tab is a promise about something that no longer exists.
   */
  dropHandle(handle, reason = 'the tab closed') {
    const entry = this.handles.get(handle);
    if (!entry) return false;
    this.handles.delete(handle);
    if (entry.chromeTabId != null) this.byChrome.delete(`${entry.engineId}\u0000${entry.chromeTabId}`);
    const owner = this.owners.get(handle);
    this.owners.delete(handle);
    for (const [name, h] of this.sessions) if (h === handle) this.sessions.delete(name);
    for (const client of this.clients.values()) {
      if (client.current !== handle) continue;
      client.current = null;
      // (3.8.1) Said with the next call that acts on a default tab instead (router #takeDefault).
      client.lostCurrent = { tabId: handle, why: reason };
    }
    this.emit('tabGone', { tabId: handle, engineId: entry.engineId, owner: owner ?? null, reason });
    if (owner) this.emit('agents');
    return true;
  }

  dropEngine(engineId, reason) {
    const dropped = this.handlesOf(engineId);
    for (const handle of dropped) this.dropHandle(handle, reason);
    return dropped;
  }

  // ------------------------------------------------------------- sessions

  nameSession(name, handle) {
    if (!name || typeof name !== 'string') throw new Error('A session needs a name, e.g. name:"buyer".');
    if (!this.handles.has(handle)) throw new Error(`Tab ${handle} does not exist (any more). Call browser_tabs action:"list".`);
    this.sessions.set(name, handle);
    this.emit('agents');
    return { session: name, tabId: handle };
  }

  /** Handle behind a session name; throws the fix when the name is unknown. */
  sessionHandle(name) {
    const handle = this.sessions.get(name);
    if (handle == null) {
      const known = [...this.sessions.keys()];
      throw new Error(
        `No session named "${name}".` +
          (known.length ? ` Known sessions: ${known.join(', ')}.` : ' Open one with browser_tabs action:"session" name:"…" url:"…".'),
      );
    }
    return handle;
  }

  endSession(name) {
    const handle = this.sessions.get(name) ?? null;
    this.sessions.delete(name);
    if (handle != null) this.emit('agents');
    return handle;
  }

  sessionOf(handle) {
    for (const [name, h] of this.sessions) if (h === handle) return name;
    return null;
  }

  listSessions() {
    return [...this.sessions.entries()].map(([session, tabId]) => ({
      session,
      tabId,
      engine: this.engineOf(tabId),
      owner: this.owners.get(tabId) ?? null,
    }));
  }

  // ------------------------------------------------------------- ownership

  ownerOf(handle) {
    return this.owners.get(handle) ?? null;
  }

  ownershipMessage(handle, ownerId) {
    return (
      `Tab ${handle} is owned by ${this.describe(ownerId)}. Ask that agent to release it, or call ` +
      `browser_tabs action:"claim" tabId:${handle} force:true to take it over.`
    );
  }

  /**
   * The mutating-call gate: claim an unowned tab for `agentId`, pass if it is
   * already theirs, refuse with the owner's name otherwise.
   */
  ensureOwnership(handle, agentId) {
    const owner = this.owners.get(handle);
    if (owner === agentId) return { tabId: handle, owner: agentId, claimed: false };
    if (owner && this.clients.has(owner)) {
      const idle = this.idleFor(owner);
      if (idle == null) throw Object.assign(new Error(this.ownershipMessage(handle, owner)), { errorCode: 'owned' });
      // (3.5) The owner is connected but has done nothing for idleClaimMs (and has nothing running):
      // an abandoned session, a stateless client's old one, a crashed agent's socket kept open.
      this.log(`[ownership] ${this.describe(agentId)} took tab ${handle} from ${this.describe(owner)}, idle ${Math.round(idle / 60_000)} min`);
      this.emit('takeover', { tabId: handle, from: owner, to: agentId, idleMs: idle });
      this.owners.set(handle, agentId);
      this.emit('agents');
      return { tabId: handle, owner: agentId, claimed: true, fromIdle: owner, idleMs: idle };
    }
    this.owners.set(handle, agentId);
    this.emit('agents');
    return { tabId: handle, owner: agentId, claimed: true };
  }

  /** (3.5) A call of this client starts / ends: its claims count as live while any runs. */
  beginCall(clientId) {
    const c = this.clients.get(clientId);
    if (!c) return;
    c.inflight = (c.inflight ?? 0) + 1;
    c.lastCallAt = Date.now();
  }

  endCall(clientId) {
    const c = this.clients.get(clientId);
    if (!c) return;
    c.inflight = Math.max(0, (c.inflight ?? 1) - 1);
    c.lastCallAt = Date.now();
  }

  /** How long a connected client's claims have been idle, when that is past idleClaimMs; else null. */
  idleFor(clientId) {
    const c = this.clients.get(clientId);
    if (!c || !this.idleClaimMs || (c.inflight ?? 0) > 0) return null;
    const idle = Date.now() - (c.lastCallAt ?? c.connectedAt ?? Date.now());
    return idle >= this.idleClaimMs ? idle : null;
  }

  claim(handle, agentId, { force = false } = {}) {
    if (!this.handles.has(handle)) throw new Error(`Tab ${handle} does not exist (any more). Call browser_tabs action:"list".`);
    const previous = this.owners.get(handle) ?? null;
    if (previous === agentId) return { tabId: handle, owner: agentId, previousOwner: null, changed: false };
    if (previous && this.clients.has(previous) && !force) throw Object.assign(new Error(this.ownershipMessage(handle, previous)), { errorCode: 'owned' });
    this.owners.set(handle, agentId);
    if (previous && this.clients.has(previous)) {
      this.log(`[ownership] ${this.describe(agentId)} took tab ${handle} over from ${this.describe(previous)} (force)`);
      this.emit('takeover', { tabId: handle, from: previous, to: agentId });
    }
    this.emit('agents');
    return { tabId: handle, owner: agentId, previousOwner: previous, changed: true };
  }

  release(handle, agentId) {
    if (this.owners.get(handle) !== agentId) return false;
    this.owners.delete(handle);
    this.emit('agents');
    return true;
  }

  releaseAll(agentId) {
    const released = [];
    for (const [handle, owner] of this.owners) {
      if (owner === agentId) {
        this.owners.delete(handle);
        released.push(handle);
      }
    }
    if (released.length) this.emit('agents');
    return released;
  }

  ownedBy(agentId) {
    const out = [];
    for (const [handle, owner] of this.owners) if (owner === agentId) out.push(handle);
    return out.sort((a, b) => a - b);
  }

  // ------------------------------------------------------------- current tab

  setCurrent(agentId, handle) {
    const client = this.clients.get(agentId);
    if (!client) return;
    // (3.8.2) A current tab chosen (open, attach, focus, a default) ends any "your tab was lost" pending.
    if (handle != null) client.lostCurrent = null;
    if (client.current !== handle) {
      client.current = handle;
      this.emit('agents');
    }
  }

  current(agentId) {
    const client = this.clients.get(agentId);
    if (!client || client.current == null) return null;
    if (!this.handles.has(client.current)) {
      client.lostCurrent = { tabId: client.current, why: 'the tab is gone' };
      client.current = null;
      return null;
    }
    return client.current;
  }

  /** (3.8.1) Another connected, working agent whose current tab this is, or null (one that finished holds nothing). */
  currentOfOther(handle, agentId) {
    for (const c of this.clients.values()) {
      if (c.role === 'agent' && c.id !== agentId && c.working && c.current === handle) return c.id;
    }
    return null;
  }

  // ------------------------------------------------------------- queues

  /**
   * Run `fn` after every earlier queued call on this tab has settled. Failures
   * do not poison the queue; each call gets its own outcome.
   */
  enqueue(handle, fn) {
    const previous = this.queues.get(handle) ?? Promise.resolve();
    const run = previous.then(() => fn());
    const tail = run.then(() => {}, () => {});
    this.queues.set(handle, tail);
    tail.then(() => {
      if (this.queues.get(handle) === tail) this.queues.delete(handle);
    });
    return run;
  }

  // ------------------------------------------------------------- halts

  setGlobalHalt(halted, { by = 'desktop' } = {}) {
    const next = !!halted;
    if (this.global.halted === next) return false;
    this.global = { halted: next, by: next ? by : null, at: Date.now(), resumedBy: next ? null : by };
    this.log(`[halt] global ${next ? 'HALTED' : 'resumed'} by ${by}`);
    this.emit('halt', { global: this.global });
    return true;
  }

  setAgentHalt(agentId, halted, { by = 'desktop' } = {}) {
    const client = this.clients.get(agentId);
    if (!client) throw new Error(`No connected client "${agentId}".`);
    const next = !!halted;
    if (client.halted === next) return false;
    client.halted = next;
    client.haltedBy = next ? by : null;
    this.log(`[halt] ${this.describe(agentId)} ${next ? 'HALTED' : 'resumed'} by ${by}`);
    this.emit('halt', { agentId, halted: next });
    this.emit('agents');
    return true;
  }

  /** Why this caller may not act right now, or null. `browser_status` is exempt at the router. */
  haltError(agentId) {
    if (this.global.halted) {
      const where = this.global.by === 'panel' ? ' in the G9BrowserAgent side panel' : this.global.by === 'desktop' ? ' in the G9BrowserAgent desktop app' : '';
      return (
        `The user pressed Stop${where}. Every browser action is blocked until they press Resume — ` +
        'you cannot lift this yourself. Tell them, and wait.'
      );
    }
    const client = this.clients.get(agentId);
    if (client?.halted) {
      return (
        `The user stopped this agent (${this.describe(agentId)}) from the G9BrowserAgent desktop app. Every browser ` +
        'action from this agent is blocked until they resume it — you cannot lift this yourself. Tell them, and wait.'
      );
    }
    return null;
  }

  // ------------------------------------------------------------- views

  agentRows() {
    return this.agents().map((a) => ({
      id: a.id,
      name: a.name,
      ...(a.identity ? { identity: a.identity } : {}),
      ...(a.supersededBy ? { supersededBy: a.supersededBy } : {}),
      pid: a.pid,
      owned: this.ownedBy(a.id),
      current: this.current(a.id),
      halted: a.halted,
      connectedAt: a.connectedAt,
      // (3.8) Working = it has sent calls since it connected or last said browser_tabs action:"finish".
      working: !!a.working,
      lastCallAt: a.lastCallAt ?? null,
    }));
  }
}
