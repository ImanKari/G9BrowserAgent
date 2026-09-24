/**
 * Desktop-local settings: G9_HOME/desktop.json.
 *
 * The daemon's settings (settings.get/set) are the source of truth for everything that affects a
 * run. This file only holds what belongs to the shell itself: the wizard's progress, the last
 * view, window size, the version that last ran (to detect "just updated"), and a cached copy of
 * the update URL/channel — so the updater still knows where to look while the daemon is down.
 */

import { readJson, writeJsonAtomic, deepMerge } from './jsonfile.mjs';

export { SETTINGS_FIELDS, readField, buildSettingsPatch, pickUpdateConfig, validateUpdateUrl } from '../renderer/lib/settings-form.js';

export const DESKTOP_DEFAULTS = Object.freeze({
  schema: 1,
  lastView: 'agents',
  window: { width: 1100, height: 720 },
  lastRunVersion: null,
  update: { url: '', channel: 'stable' },
  wizard: { completedAt: null, steps: {} },
  startDaemon: true,
});

export class DesktopSettings {
  constructor(file) {
    this.file = file;
    this.value = deepMerge(structuredClone(DESKTOP_DEFAULTS), readJson(file, {}) ?? {});
  }

  get() {
    return structuredClone(this.value);
  }

  /** Deep-merge a patch and persist. Returns the new value. */
  patch(p) {
    this.value = deepMerge(this.value, p ?? {});
    writeJsonAtomic(this.file, this.value);
    return this.get();
  }

  /** Record one wizard step's outcome ({ok, summary}); marks the wizard complete when all five are done. */
  recordStep(stepId, outcome, allStepIds) {
    const steps = { ...(this.value.wizard?.steps ?? {}), [stepId]: { ...outcome, at: new Date().toISOString() } };
    const complete = allStepIds?.length ? allStepIds.every((id) => steps[id]?.ok || steps[id]?.skipped) : false;
    return this.patch({ wizard: { steps, completedAt: complete ? this.value.wizard?.completedAt ?? new Date().toISOString() : null } });
  }
}

/**
 * Did the app version change since the last start? The first start ever is not an update
 * (lastRunVersion is null) — the wizard installs the extension then.
 */
export function detectUpdate(lastRunVersion, currentVersion) {
  if (!lastRunVersion) return { updated: false, from: null, to: currentVersion };
  return { updated: lastRunVersion !== currentVersion, from: lastRunVersion, to: currentVersion };
}
