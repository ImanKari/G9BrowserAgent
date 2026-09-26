# g9-browser-node — one browser identity on a server: a desktop you can watch in a web page, the
# desktop's Chromium carrying the G9 extension (Engine 1), the G9 daemon, and G9's MCP endpoint over
# HTTP for agents that are not on this machine (mcp/http.mjs). One container per identity/account.
#
#   docker build -f docker/Dockerfile -t g9-browser-node:<version> .      (from the repository root)
#
# Base: LinuxServer.io's Chromium on their Selkies desktop (Debian 13): the desktop streams to a
# browser over HTTPS/WebSocket, runs as the user `abc` with its home in /config, and starts its
# services with s6-overlay. What G9 adds:
#   /opt/g9                       the daemon, engines, MCP front ends and the extension (read-only)
#   svc-g9d                       the daemon, loopback only (it has no password by design), data in /config/g9
#   svc-g9mcp                     MCP over HTTP on :8931 with a bearer token (off without G9_MCP_TOKEN)
#   /defaults/autostart*          the desktop's Chromium loads the G9 extension, no debugger infobar
#   google-chrome-stable          the browser Engine 2 launches for background (headless) work
#   Persian and emoji fonts
#
# Pinned by digest: the base is 4.7 GB and changes weekly; a rebuild must not change it silently.
ARG BASE=lscr.io/linuxserver/chromium@sha256:cf6200ccdcb224feaf5d3bde4ce45b3783c926a7496c98059cae1e0db78e5b2f
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS node

FROM ${BASE}
ARG G9_VERSION=dev
LABEL org.opencontainers.image.title="g9-browser-node" \
      org.opencontainers.image.description="G9 Browser Agent: a watchable desktop browser with the G9 extension, daemon and MCP over HTTP" \
      org.opencontainers.image.version="${G9_VERSION}"

# Node 22 (the daemon and the MCP endpoint). The bookworm build runs on the trixie base (older glibc).
COPY --from=node /usr/local/bin/node /usr/local/bin/node

# Engine 2's browser, and fonts a Persian page needs. Vazirmatn is optional (not in every mirror).
RUN set -eux; \
    apt-get update; \
    curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; \
    apt-get install -y --no-install-recommends /tmp/chrome.deb fonts-noto-core fonts-noto-color-emoji; \
    (apt-get install -y --no-install-recommends fonts-vazirmatn || true); \
    rm -rf /var/lib/apt/lists/* /tmp/chrome.deb; \
    node --version; google-chrome --version

# G9 itself: only what runs (no tests, desktop app or docs).
COPY package.json /opt/g9/package.json
COPY lib /opt/g9/lib
COPY daemon /opt/g9/daemon
COPY engine /opt/g9/engine
COPY mcp /opt/g9/mcp
COPY runner /opt/g9/runner
COPY extension /opt/g9/extension
COPY docker/root/ /

# A checkout on Windows may carry CRLF: a CR after a shebang (or in an s6 type/up file) breaks it,
# so strip it from everything G9 adds under docker/root.
RUN set -eux; \
    S=/etc/s6-overlay/s6-rc.d; \
    for f in /defaults/autostart /defaults/autostart_wayland /usr/local/bin/g9-healthcheck /usr/local/bin/g9-chromium \
      $(find $S/svc-g9d $S/svc-g9mcp $S/svc-g9-quit $S/init-g9-desktop -type f); do sed -i 's/\r$//' "$f"; done; \
    chmod +x /defaults/autostart /defaults/autostart_wayland /usr/local/bin/g9-healthcheck /usr/local/bin/g9-chromium \
      $S/svc-g9d/run $S/svc-g9mcp/run $S/svc-g9-quit/run $S/init-g9-desktop/run; \
    node -e "process.exit(require('/opt/g9/package.json').version ? 0 : 1)"; \
    # Chromium wipes a command-line extension's storage and installs it again on every start: no
    # welcome tab each time (extension/sw.js readDeployment).
    printf '{ "kind": "browser-node", "welcome": false }\n' > /opt/g9/extension/deployment.json; \
    # What g9-chromium compares to clear Chromium's cached service worker when the extension changed.
    (cd /opt/g9/extension && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64) > /opt/g9/extension.build; \
    cat /opt/g9/extension.build

ENV G9_HOME=/config/g9 \
    G9_PORT=8765 \
    G9_MCP_HTTP_HOST=0.0.0.0 \
    G9_MCP_HTTP_PORT=8931 \
    G9_MCP_AGENT_CWD=/config \
    G9_LAUNCH_ARGS="--no-sandbox --test-type" \
    TITLE="G9 Browser"

# 3000: the desktop (HTTP, to be put behind a TLS reverse proxy); 3001: the same over self-signed
# HTTPS; 8931: MCP over HTTP (bearer token).
EXPOSE 3000 3001 8931
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 CMD /usr/local/bin/g9-healthcheck
