/**
 * The platform seam (ARCHITECTURE_V2 §3, rule R2).
 *
 * Every tool module and every shared lib file reaches "the browser it runs in"
 * through this one export, never through `chrome.*` or `node:` directly. Inside
 * the extension that is `chrome.*` (platform-extension.js); inside the daemon it
 * is raw CDP to a launched browser (platform-cdp.js). The tool code is the same
 * module either way — which is the whole point of Engine 2 (decision D2).
 *
 * Both implementations are imported statically and both are browser-safe: a
 * service worker forbids top-level `await`, so the choice cannot be a dynamic
 * import, and a static import of a file that touched `chrome` at load time
 * would break the daemon. The feature test below is the only place outside the
 * extension-only files that is allowed to look for `chrome`.
 */
import { platform as extensionPlatform } from './platform-extension.js';
import { platform as cdpPlatform } from './platform-cdp.js';

const hasChrome = !!(globalThis.chrome?.debugger || globalThis.browser?.debugger);

export const platform = hasChrome ? extensionPlatform : cdpPlatform;
export const isExtension = hasChrome;
