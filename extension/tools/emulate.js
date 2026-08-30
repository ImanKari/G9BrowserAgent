/**
 * Device, network, and dialog emulation.
 *
 * Emulation state is per-attached-session: it disappears when the debugger
 * detaches, which means a crashed service worker leaves no lasting damage to
 * the user's browser. That is intentional.
 */

import { send } from '../lib/cdp.js';

const DEVICES = {
  'iphone-15': { width: 393, height: 852, deviceScaleFactor: 3, mobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'pixel-8': { width: 412, height: 915, deviceScaleFactor: 2.6, mobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  'ipad': { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'laptop': { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
  'desktop': { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false },
};

const NETWORKS = {
  'slow-3g': { downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8, latency: 400 },
  'fast-3g': { downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 },
  '4g': { downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (9 * 1024 * 1024) / 8, latency: 60 },
  offline: { offline: true, downloadThroughput: 0, uploadThroughput: 0, latency: 0 },
  none: null,
};

export async function emulate(tabId, opts = {}) {
  const { device, width, height, network, cpuThrottle, colorScheme, locale, timezone, reset = false } = opts;
  const applied = {};

  if (reset) {
    await send(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    await send(tabId, 'Network.emulateNetworkConditions', {
      offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0,
    }).catch(() => {});
    await send(tabId, 'Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    await send(tabId, 'Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
    return { reset: true };
  }

  if (device || width || height) {
    const preset = device ? DEVICES[device] : null;
    if (device && !preset) {
      throw new Error(`Unknown device "${device}". Available: ${Object.keys(DEVICES).join(', ')}.`);
    }
    const metrics = {
      width: width ?? preset?.width ?? 1280,
      height: height ?? preset?.height ?? 800,
      deviceScaleFactor: preset?.deviceScaleFactor ?? 1,
      mobile: preset?.mobile ?? false,
    };
    await send(tabId, 'Emulation.setDeviceMetricsOverride', metrics);
    if (preset?.userAgent) {
      await send(tabId, 'Emulation.setUserAgentOverride', { userAgent: preset.userAgent }).catch(() => {});
    }
    if (preset?.mobile) {
      await send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {});
    }
    applied.device = device ?? `${metrics.width}x${metrics.height}`;
  }

  if (network) {
    const preset = NETWORKS[network];
    if (preset === undefined) {
      throw new Error(`Unknown network preset "${network}". Available: ${Object.keys(NETWORKS).join(', ')}.`);
    }
    await send(tabId, 'Network.emulateNetworkConditions', {
      offline: preset?.offline ?? false,
      downloadThroughput: preset ? preset.downloadThroughput : -1,
      uploadThroughput: preset ? preset.uploadThroughput : -1,
      latency: preset?.latency ?? 0,
    });
    applied.network = network;
  }

  if (cpuThrottle) {
    await send(tabId, 'Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
    applied.cpuThrottle = `${cpuThrottle}x slowdown`;
  }

  if (colorScheme) {
    await send(tabId, 'Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: colorScheme }],
    });
    applied.colorScheme = colorScheme;
  }

  if (locale) {
    await send(tabId, 'Emulation.setLocaleOverride', { locale }).catch(() => {});
    applied.locale = locale;
  }

  if (timezone) {
    await send(tabId, 'Emulation.setTimezoneOverride', { timezoneId: timezone }).catch(() => {});
    applied.timezone = timezone;
  }

  return { applied };
}

/**
 * Handle the next JavaScript dialog (alert / confirm / prompt / beforeunload).
 * Without this, a dialog blocks the page and every subsequent tool call hangs.
 */
export async function handleDialog(tabId, { accept = true, promptText } = {}) {
  try {
    await send(tabId, 'Page.handleJavaScriptDialog', {
      accept,
      ...(promptText != null ? { promptText } : {}),
    });
    return { handled: true, accept, promptText };
  } catch (err) {
    if (String(err.message).includes('No dialog')) {
      return { handled: false, reason: 'No dialog is currently open.' };
    }
    throw err;
  }
}

export const deviceNames = Object.keys(DEVICES);
export const networkNames = Object.keys(NETWORKS);
