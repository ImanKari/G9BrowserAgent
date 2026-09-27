/**
 * The first-run wizard (docs/INSTALL.md, "The setup wizard") — five steps, each re-runnable from the Setup view:
 *
 *   1. browsers   detect Edge/Chrome; offer the pinned Chrome for Testing (admin engines.installCft)
 *   2. profile    ensure the 'automation' profile and open it headed once for sign-in (profiles.warm)
 *   3. policies   the HKCU policy list with Apply and Undo (policies.mjs)
 *   4. mcp        detect AI clients and register the shim (mcp-register.mjs)
 *   5. extension  copy the extension to G9_HOME/extension, path on the clipboard, open the
 *                 browser's extensions page, show the three clicks
 *
 * Every action and its outcome goes to G9_HOME/logs/install.log. The class holds no UI; main.mjs
 * exposes its methods over IPC, and every dependency with a side effect is injected, so the tests
 * drive it with fakes (no daemon, no registry, no clipboard, no browser).
 */

import os from 'node:os';
import { policyEntries, policyStatus, applyPolicies, undoPolicies } from './policies.mjs';
import { mcpClients, detectClients, shimEntry, inspectClient, applyRegistration, removeRegistration, unstableExecReason, migrateRegistrations } from './mcp-register.mjs';
import { findBrowserExecutables, installExtension, openExtensionsPage, threeClicks, manifestVersion, EXTENSIONS_PAGE } from './extension-install.mjs';
import { normalizeVersions, pickList } from '../renderer/lib/engines.js';

export const WIZARD_STEPS = [
  { id: 'browsers', title: 'Browsers', summary: 'Find Edge and Chrome on this machine, and optionally install the pinned Chrome for Testing.' },
  { id: 'profile', title: 'Automation profile', summary: 'Create the automation profile and sign in to your app once, so unattended runs start signed in.' },
  { id: 'policies', title: 'Background policies', summary: 'Keep your own browser rendering when its window is covered, so the extension can act in the background.' },
  { id: 'mcp', title: 'AI clients', summary: 'Register G9BrowserAgent with the AI clients installed here, so their agents get the browser tools.' },
  { id: 'extension', title: 'Browser extension', summary: 'Add the G9BrowserAgent extension to your own browser once.' },
];
export const STEP_IDS = WIZARD_STEPS.map((s) => s.id);

const list = pickList;

export class Wizard {
  /**
   * @param {object} o
   * @param {import('./daemon-client.mjs').DaemonClient} o.client
   * @param {import('./settings.mjs').DesktopSettings} o.settings
   * @param {{info,warn,error}} o.log       install.log logger
   * @param {object} o.layout               homeLayout(G9_HOME)
   * @param {object} o.resources            resourcePaths(root)
   * @param {object} o.app                  { isPackaged, execPath, resourceRoot, port, homeOverride }
   * @param {object} [o.deps]               injectable side effects
   */
  constructor({ client, settings, log, layout, resources, app, deps = {} }) {
    this.client = client;
    this.settings = settings;
    this.log = log;
    this.layout = layout;
    this.resources = resources;
    this.app = app;
    this.deps = {
      clipboardWrite: deps.clipboardWrite ?? (() => { throw new Error('No clipboard in this context'); }),
      spawn: deps.spawn,
      regRun: deps.regRun,
      regRunElevated: deps.regRunElevated ?? null,
      findBrowsers: deps.findBrowsers ?? (() => findBrowserExecutables()),
      clients: deps.clients ?? (() => mcpClients()),
      exists: deps.exists,
      user: deps.user ?? (() => os.userInfo().username),
      // The folder the daemon's extension.install writes: G9_HOME/extension of the DAEMON's home,
      // which main follows from welcome.home (it can differ from this app's own G9_HOME).
      extensionDir: deps.extensionDir ?? (() => this.layout.extension),
    };
  }

  state() {
    const s = this.settings.get().wizard ?? {};
    return { steps: WIZARD_STEPS.map((st) => ({ ...st, outcome: s.steps?.[st.id] ?? null })), completedAt: s.completedAt ?? null };
  }

  mark(stepId, outcome) {
    if (!STEP_IDS.includes(stepId)) throw new Error(`Unknown setup step ${stepId}`);
    this.log.info(`Setup step "${stepId}": ${outcome.ok ? 'done' : outcome.skipped ? 'skipped' : 'not done'}${outcome.summary ? ` — ${outcome.summary}` : ''}`);
    this.settings.recordStep(stepId, outcome, STEP_IDS);
    return this.state();
  }

  #requireDaemon(what) {
    if (!this.client?.connected) throw new Error(`${what} needs the G9BrowserAgent daemon, which is not connected. Wait for it to start, or press Reconnect.`);
  }

  // ---------------------------------------------------------------- 1. browsers

  async browsers() {
    const local = await this.deps.findBrowsers();
    let versions = null;
    let daemonError = null;
    if (this.client?.connected) {
      try {
        versions = await this.client.admin('engines.versions', {});
      } catch (err) {
        daemonError = err.message;
      }
    }
    const norm = normalizeVersions(versions ?? {});
    const merged = [...norm.browsers];
    // The daemon's engine/find.js is authoritative; the desktop's own probe fills gaps (daemon down).
    for (const b of local) if (!merged.some((m) => m.kind === b.kind)) merged.push({ ...b, version: null });
    const result = { browsers: merged, cft: norm.cft, source: versions ? 'daemon' : 'desktop', daemonError };
    this.log.info('Setup: browsers detected', { browsers: result.browsers.map((b) => `${b.kind} ${b.version ?? ''}`.trim()), cft: result.cft });
    return result;
  }

  async installCft(version) {
    this.#requireDaemon('Installing Chrome for Testing');
    this.log.info('Setup: installing Chrome for Testing', { version: version ?? 'pinned' });
    try {
      const r = await this.client.admin('engines.installCft', version ? { version } : {});
      this.log.info('Setup: Chrome for Testing installed', r);
      return r;
    } catch (err) {
      this.log.error('Setup: Chrome for Testing install failed', err.message);
      throw err;
    }
  }

  // ---------------------------------------------------------------- 2. profile

  async profile() {
    this.#requireDaemon('Checking profiles');
    const profiles = list(await this.client.admin('profiles.list', {}), 'profiles', 'items').map((p) => (typeof p === 'string' ? { name: p } : p));
    return { profiles, automation: profiles.find((p) => p.name === 'automation') ?? null };
  }

  async warmProfile({ name = 'automation', url = '' } = {}) {
    this.#requireDaemon('Opening the profile');
    const target = String(url ?? '').trim();
    if (target && !/^https?:\/\//i.test(target)) throw new Error('The sign-in page must be an http(s) address.');
    this.log.info('Setup: opening the profile headed for sign-in', { name, url: target || null });
    const r = await this.client.admin('profiles.warm', { name, url: target || undefined });
    return r ?? { ok: true };
  }

  // ---------------------------------------------------------------- 3. policies

  /**
   * The background policies are Windows registry values (HKCU\Software\Policies); the native
   * occlusion tracker `WindowOcclusionEnabled` turns off is Chromium's Windows one. G9BrowserAgent writes no
   * policies on macOS or Linux, and the step says so instead of failing on reg.exe.
   */
  #policiesApply() {
    return (this.app.platform ?? process.platform) === 'win32';
  }

  async policies() {
    if (!this.#policiesApply()) {
      return {
        applicable: false,
        reason: 'Nothing to set here: these are Windows registry policies, and G9BrowserAgent sets no browser policies on macOS or Linux. There too, a background tab or a minimized window stops rendering, so keep the tab an agent works in visible — or hand it to a launched browser (headless, which no window state affects).',
        rows: [], appliedCount: 0, total: 0, canUndo: false,
      };
    }
    return { applicable: true, ...(await policyStatus({ entries: policyEntries(), run: this.deps.regRun, recordFile: this.layout.policiesJson })) };
  }

  async applyPolicies({ elevate = false } = {}) {
    if (!this.#policiesApply()) throw new Error('Background policies are Windows-only; nothing to apply on this operating system.');
    this.log.info(`Setup: applying HKCU policies${elevate ? ' with administrator approval' : ''}`);
    const r = await applyPolicies({
      entries: policyEntries(),
      run: this.deps.regRun,
      runElevated: this.deps.regRunElevated,
      elevate,
      recordFile: this.layout.policiesJson,
      log: this.log,
      by: this.deps.user(),
    });
    if (r.ok) this.mark('policies', { ok: true, summary: r.message });
    return r;
  }

  async undoPolicies({ elevate = false } = {}) {
    if (!this.#policiesApply()) throw new Error('Background policies are Windows-only; nothing to undo on this operating system.');
    this.log.info(`Setup: undoing HKCU policies${elevate ? ' with administrator approval' : ''}`);
    const r = await undoPolicies({ run: this.deps.regRun, runElevated: this.deps.regRunElevated, elevate, recordFile: this.layout.policiesJson, log: this.log, by: this.deps.user() });
    if (r.ok) this.mark('policies', { ok: false, skipped: true, summary: 'Policies undone.' });
    return r;
  }

  // ---------------------------------------------------------------- 4. MCP clients

  entry() {
    return shimEntry({
      isPackaged: this.app.isPackaged,
      execPath: this.app.execPath,
      resourceRoot: this.app.resourceRoot,
      port: this.app.port,
      homeOverride: this.app.homeOverride,
      appImage: this.app.appImage ?? null,
    });
  }

  /** A packaged app running from a path that will not exist next time must not be registered. */
  #unstableReason() {
    if (!this.app.isPackaged || this.app.appImage) return null;
    return unstableExecReason({ execPath: this.app.execPath, platform: this.app.platform ?? process.platform });
  }

  mcp() {
    const entry = this.entry();
    const clients = detectClients(this.deps.clients(), this.deps.exists ? { exists: this.deps.exists } : undefined);
    return {
      entry,
      blocked: this.#unstableReason(),
      clients: clients.map((c) => {
        // nextText is the whole rewritten file (~/.claude.json can be large); the page needs only the plan.
        const { nextText, ...plan } = inspectClient(c, entry);
        return { id: c.id, label: c.label, file: c.file, installed: c.installed, fileExists: c.fileExists, restartHint: c.restartHint, ...plan };
      }),
    };
  }

  registerMcp(clientId, { confirmReplace = false, confirmDropComments = false } = {}) {
    const client = this.deps.clients().find((c) => c.id === clientId);
    if (!client) throw new Error(`Unknown AI client ${clientId}`);
    const unstable = this.#unstableReason();
    if (unstable) throw new Error(unstable);
    const r = applyRegistration(client, this.entry(), { confirmReplace, confirmDropComments, log: this.log });
    return r;
  }

  /**
   * At the installed app's start: move entries under the old name and repoint entries whose
   * executable is gone (mcp-register.mjs migrateRegistrations). Never from a development build (its
   * entry names the repository) or from a place that will not exist next time.
   */
  migrateMcp() {
    if (!this.app.isPackaged || this.#unstableReason()) return [];
    const rows = migrateRegistrations(this.deps.clients(), this.entry(), { log: this.log, ...(this.deps.exists ? { exists: this.deps.exists } : {}) });
    for (const r of rows) this.log[r.ok ? 'info' : 'warn']?.(`AI client entry ${r.status} at start: ${r.client}`, { file: r.file, message: r.message });
    return rows;
  }

  removeMcp(clientId, { confirmDropComments = false } = {}) {
    const client = this.deps.clients().find((c) => c.id === clientId);
    if (!client) throw new Error(`Unknown AI client ${clientId}`);
    return removeRegistration(client, { confirmDropComments, log: this.log });
  }

  // ---------------------------------------------------------------- 5. extension

  async extension() {
    const browsers = await this.deps.findBrowsers();
    return {
      source: this.resources.extension,
      sourceVersion: manifestVersion(this.resources.extension),
      target: this.deps.extensionDir(),
      installedVersion: manifestVersion(this.deps.extensionDir()),
      browsers: browsers.map((b) => ({ ...b, page: EXTENSIONS_PAGE[b.kind] })),
      clicks: { edge: threeClicks('edge', this.app.platform ?? process.platform), chrome: threeClicks('chrome', this.app.platform ?? process.platform) },
    };
  }

  async installExtension() {
    const target = this.deps.extensionDir();
    this.log.info('Setup: installing the extension folder', { from: this.resources.extension, to: target });
    const r = await installExtension({ client: this.client, from: this.resources.extension, target, log: this.log });
    let clipboard = false;
    try {
      this.deps.clipboardWrite(r.path);
      clipboard = true;
      this.log.info('Setup: extension path copied to the clipboard', { path: r.path });
    } catch (err) {
      this.log.warn('Setup: could not use the clipboard', err.message);
    }
    return { ...r, clipboard };
  }

  async openExtensionsPage(kind) {
    const browsers = await this.deps.findBrowsers();
    const b = browsers.find((x) => x.kind === kind);
    const cmd = openExtensionsPage(kind, b?.path, this.deps.spawn ? { spawn: this.deps.spawn } : undefined);
    this.log.info('Setup: opened the extensions page', { kind, command: cmd.command, args: cmd.args });
    return { ...cmd, clicks: threeClicks(kind, this.app.platform ?? process.platform) };
  }
}
