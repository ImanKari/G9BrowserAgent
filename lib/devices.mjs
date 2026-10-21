/**
 * Device platforms — the apps a project tests on a phone or tablet, read from its `g9.project.json`.
 *
 * The runner drives a device app through its QA bridge (docs/DEVICE_BRIDGE.md) the same way for every
 * app. What differs from one app to the next is data: which Android package must be on the other end,
 * which port its bridge listens on, where its flows live, what its error screen is called. That data
 * belongs to the project under test, never to this tool — so this module only READS it:
 *
 *   "devices": {
 *     "shop-android": {
 *       "flowsFolder": "shop-android",      // <flowsDir>/<flowsFolder>/**   (default: the name)
 *       "flowKind": "shop-android",         // FlowSpec target.kind of its flows (default: the name)
 *       "label": "shop-android",            // the report's platform label (default: the name)
 *       "framework": "react-native",        // the report's app.framework (optional)
 *       "package": "com.example.shop",      // the package that must own the bridge port (optional)
 *       "port": 8799,                       // the bridge port on the device (default 8799)
 *       "errorScreens": ["ErrorPage."],     // automation-id prefixes of the app's crash/error screen
 *       "crashLog": "files/logs/last-crash.log", // app-private file read with run-as when a run derails
 *       "setupHint": "…",                   // what to check when nothing answers on the port
 *       "tokenHint": "…",                   // where the app shows its automation token
 *       "selftestHints": [{ "match": "no such table", "hint": "…" }]
 *     }
 *   }
 *
 * Every key is optional; a name with an empty object is a valid platform. Problems are collected, not
 * thrown: one malformed entry must not take the others (or the daemon) down.
 */

/** The bridge's default port (docs/DEVICE_BRIDGE.md). A profile's `port` overrides it. */
export const DEFAULT_BRIDGE_PORT = 8799;

/** Platform names are folder and CLI names: lower-case letters, digits, dots, dashes, underscores. */
const NAME = /^[a-z0-9][a-z0-9._-]*$/;
/** An Android application id. Exported: the driver puts it into `adb shell` command lines (3.8.2). */
export const PACKAGE = /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/;

/**
 * `raw` is the `devices` value of g9.project.json. Returns `{ platforms, problems }`, `platforms` keyed by
 * name, each profile frozen and complete (no undefined fields), so callers never write `?? default` twice.
 */
export function normalizeDevicePlatforms(raw) {
  const platforms = {};
  const problems = [];
  if (raw == null) return { platforms, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('"devices" must be an object of named device platforms; it was ignored.');
    return { platforms, problems };
  }
  for (const [name, value] of Object.entries(raw)) {
    if (name.startsWith('//')) continue; // comment keys, the convention g9.project.json uses
    if (!NAME.test(name) || name === 'web') {
      problems.push(`devices.${name}: a platform name is lower-case letters, digits, ".", "-" or "_" (and not "web"); it was ignored.`);
      continue;
    }
    const v = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    if (!v) {
      problems.push(`devices.${name} must be an object (an empty one is fine); it was ignored.`);
      continue;
    }
    const pkg = str(v.package);
    if (pkg && !PACKAGE.test(pkg)) {
      problems.push(`devices.${name}.package "${pkg}" is not an application id (e.g. com.example.app); it was ignored.`);
      continue;
    }
    const port = v.port == null ? DEFAULT_BRIDGE_PORT : Number(v.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push(`devices.${name}.port must be a TCP port number; it was ignored.`);
      continue;
    }
    // (3.8.2) flowsFolder is a folder INSIDE flowsDir: no absolute path, no "..", no empty segment.
    const flowsFolder = str(v.flowsFolder) ?? name;
    if (/^[\\/]/.test(flowsFolder) || /^[A-Za-z]:/.test(flowsFolder) || flowsFolder.split(/[\\/]/).some((seg) => !seg || seg === '.' || seg === '..')) {
      problems.push(`devices.${name}.flowsFolder "${flowsFolder}" must be a folder inside flowsDir (no absolute path, no ".."); it was ignored.`);
      continue;
    }
    // (3.8.2) crashLog is read with `run-as <package> cat <crashLog>` in the device's shell: a path, nothing else.
    const crashLog = str(v.crashLog);
    if (crashLog && !/^[\w./@+-]+$/.test(crashLog)) {
      problems.push(`devices.${name}.crashLog "${crashLog}" must be a plain file path (letters, digits, . / _ - @ +); it was ignored.`);
      continue;
    }
    platforms[name] = Object.freeze({
      id: name,
      label: str(v.label) ?? name,
      framework: str(v.framework),
      flowsFolder,
      flowKind: str(v.flowKind) ?? name,
      package: pkg,
      port,
      errorScreens: Object.freeze(arr(v.errorScreens).map(str).filter(Boolean)),
      crashLog,
      setupHint: str(v.setupHint),
      tokenHint: str(v.tokenHint),
      selftestHints: Object.freeze(
        arr(v.selftestHints)
          .filter((h) => h && typeof h.match === 'string' && h.match && typeof h.hint === 'string' && h.hint)
          .map((h) => Object.freeze({ match: h.match, hint: h.hint })),
      ),
    });
  }
  return { platforms, problems };
}

/** FlowSpec `target.kind` → the folder its flows live in, for every declared device platform. */
export function flowFoldersByKind(platforms) {
  const map = {};
  for (const p of Object.values(platforms ?? {})) map[p.flowKind] ??= p.flowsFolder;
  return map;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const arr = (v) => (Array.isArray(v) ? v : []);
