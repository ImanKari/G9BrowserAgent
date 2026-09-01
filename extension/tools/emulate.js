/**
 * Device, network, and dialog emulation.
 *
 * Emulation state is per-attached-session: it disappears when the debugger
 * detaches, which means a crashed service worker leaves no lasting damage to
 * the user's browser. That is intentional.
 */

import { send, evaluate } from '../lib/cdp.js';
import { setState } from '../lib/state.js';
import { clearRefs } from '../lib/refs.js';
import { clearBuffers } from './observe.js';

const api = globalThis.browser ?? globalThis.chrome;

/**
 * CDP has no "clear user-agent override" command — you can only set another
 * one — so the real one has to be captured before the first override, or it is
 * gone for the life of the session. Kept in session storage because the
 * service worker may restart between the override and the reset.
 */
const UA_KEY = (tabId) => `emulate-ua:${tabId}`;

async function rememberUserAgent(tabId) {
  const key = UA_KEY(tabId);
  const stored = await api.storage.session.get(key);
  if (stored[key]) return;
  const userAgent = await evaluate(tabId, 'navigator.userAgent').catch(() => null);
  if (userAgent) await api.storage.session.set({ [key]: userAgent });
}

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

/** Modern CDP first; the legacy command remains the compatibility path. */
async function applyNetwork(tabId, preset) {
  const conditions = {
    offline: preset?.offline ?? false,
    downloadThroughput: preset ? preset.downloadThroughput : -1,
    uploadThroughput: preset ? preset.uploadThroughput : -1,
    latency: preset?.latency ?? 0,
  };
  try {
    await send(tabId, 'Network.emulateNetworkConditionsByRule', {
      matchedNetworkConditions: preset ? [{ urlPattern: '', ...conditions }] : [],
    });
    await send(tabId, 'Network.overrideNetworkState', conditions);
    return 'modern-rule+state';
  } catch (modernError) {
    try {
      await send(tabId, 'Network.emulateNetworkConditions', conditions);
      return 'legacy-fallback';
    } catch (legacyError) {
      throw new Error(
        `Network emulation failed with both the modern and compatibility CDP paths. ` +
          `Modern: ${modernError?.message ?? modernError}. Legacy: ${legacyError?.message ?? legacyError}.`,
      );
    }
  }
}

export async function emulate(tabId, opts = {}) {
  const {
    device, width, height, network, cpuThrottle, colorScheme, locale, timezone,
    reset = false, reloadIfNeeded = true,
  } = opts;
  const applied = {};

  if (reset) {
    // Reset every override this tool can apply. It used to clear four of the
    // seven, so a page emulated as an iPhone in Tehran kept reporting an iPhone
    // user agent and Asia/Tehran afterwards — and reported `reset: true` while
    // doing it, which is the part that makes it a real bug rather than a gap.
    const cleared = [];
    const failed = [];
    const step = async (label, method, params = {}) => {
      try {
        await send(tabId, method, params);
        cleared.push(label);
      } catch (err) {
        failed.push({ override: label, error: String(err?.message ?? err) });
      }
    };

    await step('viewport', 'Emulation.clearDeviceMetricsOverride');
    try {
      const engine = await applyNetwork(tabId, null);
      cleared.push(`network (${engine})`);
    } catch (err) {
      failed.push({ override: 'network', error: String(err?.message ?? err) });
    }
    await step('cpu', 'Emulation.setCPUThrottlingRate', { rate: 1 });
    await step('media', 'Emulation.setEmulatedMedia', { features: [] });
    await step('touch', 'Emulation.setTouchEmulationEnabled', { enabled: false });
    // Empty values disable these two and restore the host's own settings.
    await step('timezone', 'Emulation.setTimezoneOverride', { timezoneId: '' });
    await step('locale', 'Emulation.setLocaleOverride', {});

    const key = UA_KEY(tabId);
    const stored = await api.storage.session.get(key);
    if (stored[key]) {
      const failuresBeforeUa = failed.length;
      await step('userAgent', 'Emulation.setUserAgentOverride', { userAgent: stored[key] });
      // Retain the real UA when reset failed so a later retry can still
      // restore it. Removing it here made a partial failure irreversible.
      if (failed.length === failuresBeforeUa) await api.storage.session.remove(key);
    }

    return { reset: failed.length === 0, cleared, failed };
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
    await send(tabId, 'Emulation.setDeviceMetricsOverride', {
      ...metrics,
      screenWidth: metrics.width,
      screenHeight: metrics.height,
      positionX: 0,
      positionY: 0,
      dontSetVisibleSize: false,
    });
    if (metrics.mobile) {
      // A tab that was loaded in desktop mode can retain Chromium's automatic
      // mobile fit-to-width scale (often 0.25), yielding a 4x layout viewport
      // even though the device metrics command succeeded. Force the page scale
      // to one so CSS media queries see the requested CSS-pixel viewport.
      await send(tabId, 'Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    }
    if (preset?.userAgent) {
      // Capture the real one first — reset has no other way to get it back.
      await rememberUserAgent(tabId);
      await send(tabId, 'Emulation.setUserAgentOverride', { userAgent: preset.userAgent });
      applied.userAgent = true;
    }
    if (preset?.mobile) {
      await send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      applied.touch = true;
    }
    let viewport = await evaluate(tabId, '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })');
    if (metrics.mobile && reloadIfNeeded &&
        (viewport?.width !== metrics.width || viewport?.height !== metrics.height)) {
      // Chromium applies the device screen immediately, but a document first
      // parsed in desktop mode can keep its old fit-to-width layout viewport
      // until navigation. Reload only when verification proves it is needed,
      // and clear document-scoped evidence before doing so.
      await Promise.all([clearRefs(tabId), clearBuffers(tabId)]);
      await send(tabId, 'Page.reload');
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const state = await evaluate(tabId, 'document.readyState').catch(() => 'loading');
        if (state === 'complete') break;
      }
      viewport = await evaluate(tabId, '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })');
      applied.reloadedForViewport = true;
    }
    if (metrics.mobile &&
        (viewport?.width !== metrics.width || viewport?.height !== metrics.height)) {
      // Some Chromium/headless combinations ignore the document's viewport
      // meta state when mobile mode is enabled through chrome.debugger and
      // expose a 4x layout viewport. Keep the requested CSS viewport exact and
      // retain the mobile UA/touch overrides. Surface the compatibility mode
      // so callers know text autosizing/overlay-scrollbar emulation is absent.
      await send(tabId, 'Emulation.setDeviceMetricsOverride', {
        ...metrics,
        mobile: false,
        screenWidth: metrics.width,
        screenHeight: metrics.height,
        positionX: 0,
        positionY: 0,
        dontSetVisibleSize: false,
      });
      viewport = await evaluate(tabId, '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })');
      applied.mobileCompatibilityMode = 'exact-responsive-viewport-with-mobile-UA-and-touch';
      applied.warning = 'Chromium rejected an exact layout viewport in full mobile mode; responsive dimensions, mobile user agent, DPR, and touch remain emulated.';
    }
    if (viewport?.width !== metrics.width || viewport?.height !== metrics.height) {
      throw new Error(
        'Device metrics command completed, but the page viewport is ' + viewport?.width + 'x' + viewport?.height +
          '; expected ' + metrics.width + 'x' + metrics.height + '. The override was not reported as applied.' +
          (!reloadIfNeeded ? ' Retry with reloadIfNeeded:true.' : ''),
      );
    }
    applied.device = device ?? `${metrics.width}x${metrics.height}`;
    applied.viewport = viewport;
  }

  if (network) {
    const preset = NETWORKS[network];
    if (preset === undefined) {
      throw new Error(`Unknown network preset "${network}". Available: ${Object.keys(NETWORKS).join(', ')}.`);
    }
    applied.network = { preset: network, engine: await applyNetwork(tabId, preset) };
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
    await send(tabId, 'Emulation.setLocaleOverride', { locale });
    applied.locale = locale;
  }

  if (timezone) {
    await send(tabId, 'Emulation.setTimezoneOverride', { timezoneId: timezone });
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
    await setState({ dialogOpen: null });
    return { handled: true, accept, promptText };
  } catch (err) {
    if (String(err.message).includes('No dialog')) {
      // Self-healing, and the reason this tool is exempt from the dialog guard.
      // The guard rejects every other tool while `dialogOpen` is set, so if that
      // flag ever outlived its dialog — a missed `javascriptDialogClosed`, a
      // service-worker restart at the wrong moment — the agent would be locked
      // out with no way back. Clearing it here means the recovery the error
      // message already names always works, whether or not a dialog was real.
      await setState({ dialogOpen: null });
      return { handled: false, reason: 'No dialog is currently open. Cleared the blocked state; retry your call.' };
    }
    throw err;
  }
}

export const deviceNames = Object.keys(DEVICES);
export const networkNames = Object.keys(NETWORKS);
