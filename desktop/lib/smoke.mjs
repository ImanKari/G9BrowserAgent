/**
 * `--smoke`: the main process without windows. Connect to g9d at G9_PORT as role 'ui', do the
 * hello/welcome handshake and one `admin settings.get`, print ONE line of JSON, exit 0 or 1.
 *
 * It never starts a daemon unless `--launch` is also given, and it never fights for the port: a
 * foreign listener (a v1 bridge) is reported, not touched. Runs the same under Electron
 * (`electron . --smoke`) and plain Node (`node main.mjs --smoke`), so the integration stage can
 * use whichever it has.
 */

import { DaemonClient } from './daemon-client.mjs';
import { DaemonLauncher, probeHealth, describeForeign } from './daemon-launch.mjs';

export async function runSmoke({ port, version, launch = false, commandOptions = null, timeoutMs = 15_000 }) {
  const started = Date.now();
  const launcher = launch && commandOptions ? new DaemonLauncher({ commandOptions, port, cooldownMs: 0 }) : null;
  const client = new DaemonClient({
    port,
    version,
    clientName: 'g9-desktop-smoke',
    onRefused: launcher ? () => launcher.onRefused() : async () => {
      const health = await probeHealth(port);
      return health.status === 'foreign' ? { foreign: describeForeign(health, port) } : { launched: false };
    },
    onUpgradeRefused: async () => {
      const health = await probeHealth(port);
      return health.status === 'foreign' ? describeForeign(health, port) : null;
    },
    backoff: { initialMs: 250, maxMs: 1000 },
  });

  const out = { ok: false, smoke: 'g9-desktop', version, port, launched: false };
  const failFast = new Promise((_, reject) => {
    client.on('state', (s) => {
      if (s.status === 'foreign' || s.status === 'refused') reject(new Error(s.error ?? s.status));
      // Without --launch, nothing listening is a definite answer; do not sit in backoff.
      if (!launch && s.status === 'waiting' && /Nothing is listening/.test(s.error ?? '')) reject(new Error(s.error));
    });
  });
  failFast.catch(() => {});

  client.start();
  try {
    const welcome = await Promise.race([client.whenConnected(timeoutMs), failFast]);
    out.launched = !!launcher?.lastPid;
    out.welcome = {
      id: welcome.id ?? null,
      version: welcome.version ?? null,
      daemonPid: welcome.daemonPid ?? null,
      repoRoot: welcome.repoRoot ?? null,
      halted: welcome.halted ?? null,
      project: welcome.project ? { found: !!welcome.project.found, path: welcome.project.path ?? null } : null,
    };
    out.settings = await client.admin('settings.get', {}, { timeoutMs: 10_000 });
    out.ok = true;
  } catch (err) {
    out.error = String(err?.message ?? err);
    out.state = client.state;
  } finally {
    client.stop();
  }
  out.ms = Date.now() - started;
  return out;
}
