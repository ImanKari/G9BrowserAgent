#!/usr/bin/env node
/**
 * docker/ (3.2): the browser-node image and its compose file, read as files. Building the image
 * needs Docker and 5 GB (docker/README.md says how it was checked); what these tests pin is what must
 * never regress without anyone noticing: nothing published beyond 127.0.0.1, no desktop terminal,
 * no MCP endpoint without a token, the daemon on loopback, the extension loaded, every file the
 * Dockerfile copies present, and scripts a Linux shell can run.
 *
 * Run: node setup/unit/docker.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n${err?.stack ?? err}`);
    process.exit(1);
  }
}

const dockerfile = read('docker/Dockerfile');
const compose = read('docker/compose.yaml');

await test('every path the Dockerfile copies exists, and the base is pinned by digest', () => {
  const copies = [...dockerfile.matchAll(/^COPY\s+(?!--from)(\S+)\s+\S+/gm)].map((m) => m[1]);
  assert.ok(copies.length >= 8, `found ${copies.length} COPY lines`);
  for (const src of copies) assert.ok(fs.existsSync(path.join(ROOT, src)), `COPY ${src}: missing`);
  assert.match(dockerfile, /ARG BASE=lscr\.io\/linuxserver\/chromium@sha256:[0-9a-f]{64}/, 'a base that changes weekly is pinned');
  assert.doesNotMatch(dockerfile, /COPY\s+(setup|desktop|docs)\b/, 'no tests, desktop app or docs in the image');
});

await test('compose publishes nothing beyond 127.0.0.1, hardens the desktop and requires a token', () => {
  const ports = [...compose.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => m[1]).filter((p) => /:\d+$/.test(p) && /^[\d.]+:\d+:\d+$|^\d+:\d+$/.test(p));
  assert.ok(ports.length >= 4, `found ports ${JSON.stringify(ports)}`);
  for (const p of ports) assert.match(p, /^127\.0\.0\.1:\d+:\d+$/, `${p} is published beyond loopback`);
  assert.match(compose, /HARDEN_DESKTOP: "true"/, 'no terminal or sudo in the web desktop');
  assert.match(compose, /SELKIES_UI_SIDEBAR_SHOW_APPS: "false"/, 'no apps panel in the web desktop');
  assert.doesNotMatch(compose, /SELKIES_COMMAND_ENABLED: "true"/, 'desktop commands stay off');
  const tokens = [...compose.matchAll(/G9_MCP_TOKEN: \$\{(\w+):\?/g)].map((m) => m[1]);
  assert.equal(tokens.length, [...compose.matchAll(/^\s{2}browser\d+:\s*$/gm)].length, 'every node\'s token is required (compose fails without it)');
  assert.equal(new Set(tokens).size, tokens.length, 'each node has its own token');
  assert.match(compose, /shm_size: "2gb"/);
  assert.match(compose, /RESTART_APP: "true"/, 'a browser closed in the desktop comes back (it is Engine 1)');
  assert.match(compose, /stop_grace_period: "30s"/, 'time to close Chromium cleanly before the desktop stops');
  const volumes = [...compose.matchAll(/- \.\/data\/(browser\d+):\/config/g)].map((m) => m[1]);
  assert.equal(new Set(volumes).size, volumes.length, 'each node has its own profile folder');
});

await test('the services: the daemon on loopback as abc, the MCP endpoint only with a token', () => {
  const d = 'docker/root/etc/s6-overlay/s6-rc.d';
  for (const svc of ['svc-g9d', 'svc-g9mcp']) {
    assert.equal(read(`${d}/${svc}/type`).trim(), 'longrun');
    assert.ok(fs.existsSync(path.join(ROOT, `${d}/user/contents.d/${svc}`)), `${svc} is in the user bundle`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, `${d}/svc-g9d/dependencies.d/init-services`)));
  assert.ok(fs.existsSync(path.join(ROOT, `${d}/svc-g9mcp/dependencies.d/svc-g9d`)));
  const g9d = read(`${d}/svc-g9d/run`);
  assert.match(g9d, /s6-setuidgid abc node \/opt\/g9\/daemon\/g9d\.mjs --foreground/);
  assert.doesNotMatch(g9d, /G9_HOST|0\.0\.0\.0/, 'the daemon is never told to leave loopback');
  const mcp = read(`${d}/svc-g9mcp/run`);
  assert.match(mcp, /if \[ -z "\$\{G9_MCP_TOKEN\}" \] && \[ -z "\$\{G9_MCP_TOKEN_FILE\}" \]/);
  assert.match(mcp, /exec sleep infinity/, 'no token: the endpoint stays off');
  assert.match(mcp, /s6-setuidgid abc node \/opt\/g9\/mcp\/http\.mjs/);
});

await test('(3.2) a stop closes Chromium before the desktop, and an update reaches an existing node', () => {
  const d = 'docker/root/etc/s6-overlay/s6-rc.d';
  const has = (rel) => fs.existsSync(path.join(ROOT, d, rel));
  // Stop order: the watchdog first (nobody restarts the browser), then svc-g9-quit (Chromium closes
  // while its compositor is up), then svc-de. s6 stops a service before the ones it depends on.
  assert.equal(read(`${d}/svc-g9-quit/type`).trim(), 'longrun');
  assert.ok(has('svc-g9-quit/dependencies.d/svc-de'), 'svc-g9-quit goes down before the desktop');
  // Measured: with only svc-de, D-Bus and PulseAudio went down beside it and Chromium died mid-shutdown.
  for (const dep of ['svc-dbus', 'svc-pulseaudio']) assert.ok(has(`svc-g9-quit/dependencies.d/${dep}`), `and before ${dep}`);
  assert.match(dockerfile, /"welcome": false/, 'the image tells the extension not to open a welcome tab on each start');
  assert.ok(has('svc-watchdog/dependencies.d/svc-g9-quit'), 'the watchdog goes down before svc-g9-quit');
  assert.ok(has('user/contents.d/svc-g9-quit'));
  // The closing happens in run, on s6's TERM: s6-rc does not wait for a finish script before it
  // stops the next service (measured: with a finish script the profile still said "Crashed").
  assert.equal(has('svc-g9-quit/finish'), false, 'no finish script: it would race the desktop\'s stop');
  const quit = read(`${d}/svc-g9-quit/run`);
  assert.match(quit, /trap close_browser TERM/);
  assert.match(quit, /sleep infinity &\nwait \$!/, 'a wait the TERM can interrupt');
  assert.match(quit, /--type=/, 'SIGTERM to the browser process only, not its children');
  assert.match(quit, /kill -TERM/);
  // The autostart comes from the image on every start (LinuxServer copies it only once).
  assert.equal(read(`${d}/init-g9-desktop/type`).trim(), 'oneshot');
  assert.equal(read(`${d}/init-g9-desktop/up`).trim(), '/etc/s6-overlay/s6-rc.d/init-g9-desktop/run');
  assert.ok(has('init-g9-desktop/dependencies.d/init-selkies-config'), "after LinuxServer's own copy");
  assert.ok(has('svc-de/dependencies.d/init-g9-desktop'), 'before the desktop starts');
  assert.ok(has('user/contents.d/init-g9-desktop'));
  const init = read(`${d}/init-g9-desktop/run`);
  assert.match(init, /cp "\$SRC" "\$CONF_DIR\/autostart"/);
  assert.match(init, /RESTART_APP/, "keeps the watchdog's permissions");
});

await test('the desktop\'s Chromium loads the G9BrowserAgent extension without the debugger bar', () => {
  for (const f of ['docker/root/defaults/autostart', 'docker/root/defaults/autostart_wayland']) {
    const s = read(f);
    assert.match(s, /^\/usr\/local\/bin\/g9-chromium$/m, 'the switches live in the image');
    assert.doesNotMatch(s, /^\s*exec\b/m, 'not exec: the watchdog watches the autostart process');
  }
  const s = read('docker/root/usr/local/bin/g9-chromium');
  assert.match(s, /--load-extension=\/opt\/g9\/extension/);
  assert.match(s, /--silent-debugger-extension-api/);
  assert.match(s, /--hide-crash-restore-bubble/);
  // Measured: the node ran the first image's sw.js under a later manifest (Service Worker/ScriptCache).
  assert.match(s, /rm -rf "\$PROFILE\/Service Worker"/, 'a changed extension clears the cached service worker');
  assert.match(s, /\/opt\/g9\/extension\.build/);
  assert.match(dockerfile, /> \/opt\/g9\/extension\.build/, 'the image records a hash of the extension files');
  assert.match(s, /"exit_type":"Crashed"\/"exit_type":"Normal"/, 'a killed container does not ask to restore pages');
  assert.match(s, /\$\{CHROME_CLI\}/, 'the operator can still add switches');
  assert.match(dockerfile, /G9_LAUNCH_ARGS="--no-sandbox --test-type"/, 'Engine 2 launches get the container switches');
});

await test('scripts a Linux shell can run: a shebang, no CR, LF pinned in .gitattributes', () => {
  const scripts = ['docker/root/defaults/autostart', 'docker/root/defaults/autostart_wayland',
    'docker/root/etc/s6-overlay/s6-rc.d/svc-g9d/run', 'docker/root/etc/s6-overlay/s6-rc.d/svc-g9mcp/run',
    'docker/root/etc/s6-overlay/s6-rc.d/svc-g9-quit/run',
    'docker/root/etc/s6-overlay/s6-rc.d/init-g9-desktop/run',
    'docker/root/usr/local/bin/g9-healthcheck', 'docker/root/usr/local/bin/g9-chromium'];
  for (const f of scripts) {
    const s = read(f);
    assert.match(s, /^#!\/(usr\/)?bin\/((with-contenv )?bash|sh)\n/, `${f} has a shebang`);
  }
  // Every s6 service G9BrowserAgent adds is stripped of CR and its scripts made executable.
  for (const svc of ['svc-g9d', 'svc-g9mcp', 'svc-g9-quit', 'init-g9-desktop']) assert.ok(dockerfile.includes(`$S/${svc}`), `the Dockerfile handles ${svc}`);
  assert.ok(dockerfile.includes('/usr/local/bin/g9-chromium'));
  assert.match(read('.gitattributes'), /docker\/root\/\*\* text eol=lf/);
  assert.match(dockerfile, /sed -i 's\/\\r\$\/\/'/, 'the build strips a CR a Windows checkout may still bring');
});
