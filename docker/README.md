# G9BrowserAgent browser node — a browser on a server that agents drive and people watch

One container is one browser identity (one account, one profile). Each contains:

| Part | What it does |
|---|---|
| **A web desktop** (LinuxServer.io's Chromium on Selkies) | Shows the browser in a web page: you watch, and step in (sign in, a two-step code). |
| **Chromium with the G9BrowserAgent extension** (Engine 1) | The browser agents drive, with human-paced input and the recorder, issues and live view panel. Started with the extension loaded and no debugger bar. |
| **The G9BrowserAgent daemon** | Loopback only, as the desktop user; its data in `/config/g9`. |
| **MCP over HTTP** (`mcp/http.mjs`, port 8931) | The way in for agents that are not in the container: Claude Code on a laptop, the G9ServerManager assistant. Bearer token required. |
| **Google Chrome** (Engine 2) | For background work: headless tabs the daemon launches. Watch them in the extension's Live view. |

Two accounts means two containers (`compose.yaml` has `browser1` and `browser2`): separate profiles,
logins, desktops, passwords and tokens. One problem cannot touch the other account, and each backs
up and restores on its own.

## Build

From the repository root (Docker, about 5 GB for the base image):

```bash
docker build -f docker/Dockerfile --build-arg G9_VERSION=3.2.0 -t g9-browser-node:3.2.0 .
```

The base image is pinned by digest. To move to a newer one, change `BASE` in the Dockerfile
deliberately. A server that cannot reach the registries can load an image made elsewhere:
`docker save g9-browser-node:3.2.0 | gzip > node.tgz`, then `docker load < node.tgz` there.

## Run

Put `compose.yaml` in a folder with a `.env` beside it:

```env
G9_IMAGE=g9-browser-node:3.2.0
BROWSER1_MCP_TOKEN=<48 random characters: openssl rand -hex 24>
BROWSER2_MCP_TOKEN=<another 48>
TZ=Asia/Tehran
```

Then run `docker compose up -d`. Each node publishes two ports, **on 127.0.0.1 only**:

| Node | Desktop (HTTP) | MCP |
|---|---|---|
| browser1 | 127.0.0.1:9101 | 127.0.0.1:9111 |
| browser2 | 127.0.0.1:9102 | 127.0.0.1:9112 |

## Put it on the internet (nginx)

One name per node, for example `browser1.example.com`:

- `/` goes to the desktop, `127.0.0.1:9101`. It needs **HTTPS** (the desktop's video decoder works
  only in a secure context), **WebSockets**, and **basic auth**: nginx asks for the password.
- `/mcp` goes to the MCP endpoint, `127.0.0.1:9111`. It gets `auth_basic off`, because the bearer
  token is its password, and a long `proxy_read_timeout` (900 s), because a replay keeps its request
  open for minutes.

With G9ServerManager, add a proxy site with basic auth and a certificate, and give it this in its
custom directives:

```nginx
location = /mcp {
    auth_basic off;
    proxy_pass http://127.0.0.1:9111/mcp;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_read_timeout 900s;
    proxy_send_timeout 900s;
    proxy_buffering off;
    proxy_request_buffering off;
    client_max_body_size 64m;
}
```

Keep WebSockets on for the site and the read timeout long (the desktop is one long WebSocket).

## Connect an agent

Claude Code:

```bash
claude mcp add --transport http g9-browser1 https://browser1.example.com/mcp \
  --header "Authorization: Bearer <BROWSER1_MCP_TOKEN>"
```

The G9ServerManager assistant (AI → MCP servers) connects to `http://127.0.0.1:9111/mcp` with the
same token. Its tools then appear as `mcp_<name>_browser_*`, and schedules of kind `ai-task` can give
it recurring work.

Every MCP session is an agent of its own, with its own tabs and ownership. `browser_tabs
action:"open"` opens in the desktop's Chromium, where you can watch.

## Security, in one place

- **The daemon has no password by design.** It never leaves loopback inside the container. The MCP
  endpoint is the only door, and it will not listen beyond loopback without a token of at least 24
  characters.
- **The endpoint refuses** any request carrying a browser `Origin` (DNS rebinding) and bodies over
  64 MiB.
- **`HARDEN_DESKTOP=true`**: the web desktop has no terminal and no sudo. Without it, anyone who
  reached the page would get a root shell in the container. The apps panel (which installs programs
  into the session) is hidden, and desktop commands (`SELKIES_COMMAND_ENABLED`) stay off.
- **Ports are published on 127.0.0.1 only.** Only nginx, with TLS and passwords, reaches them.
- **`--no-sandbox`**: Chromium's own sandbox needs user namespaces a container does not give, so the
  container is the sandbox. Do not add `--privileged`, and do not mount the Docker socket.
- **Your logins live in `data/browserN`** (the Chromium profile and G9BrowserAgent's data). Back that folder up
  and treat it like a password store.

## Operating it

| Task | How |
|---|---|
| Logs | `docker logs g9-browser-1` (the daemon and the MCP endpoint log there) |
| Health | Docker's health check needs the desktop, the daemon's `/health` and the endpoint's `/healthz` |
| Restart | `docker compose restart browser1`. The sign-ins stay (the Chromium profile is in `data/`); open tabs do not come back. |
| Another account | copy a service with the next ports (9103/9113) and a new token |

Update G9BrowserAgent by rebuilding the image with the new version, then `docker compose up -d`. The data folders
are kept, and the new extension code runs from the first start (the launcher clears Chromium's cached
copy of the old one).

**What a restart does (3.2).**
- **The browser closes cleanly first.** `svc-g9-quit` closes Chromium before the desktop and D-Bus
  stop, so the profile ends its session properly and a fresh sign-in is written. Give it time:
  `stop_grace_period: 30s`.
- **A browser closed in the desktop comes back** within about three seconds (`RESTART_APP`, LinuxServer's
  watchdog), and the extension reconnects to the daemon by itself.
- **The desktop's start-up comes from the image every time** (`init-g9-desktop`). LinuxServer copies
  it into `/config` only once, so before this an updated image never changed an existing node's browser.

**The extension's own storage does not survive a browser start.** Chromium installs a
`--load-extension` extension again on every start and wipes its storage. What Engine 1 keeps in the
browser, such as recordings and issues saved there and its panel settings, is gone after a restart.
- **What stays:** everything the daemon keeps in `/config/g9`: flow libraries, launched-engine stores,
  runs and evidence.
- **What to do:** push the flows you want to keep to a repository library, and record on Engine 2 for
  work that must last.
- **Why it isn't fixed:** a policy install would keep the storage, but it needs a signed CRX and an
  update URL, which 3.2.0 does not build.

## How it was checked (2026-09-26)

The server was Ubuntu 24.04 with Docker 29.8, 8 cores and 31 GB. The image was built there from this
folder: 5.55 GB, Chromium 153, Google Chrome 154, Node 22.23. Both nodes ran as a G9ServerManager
panel stack.

- **Both nodes** were healthy with the desktop fixed at 1600×900, and each daemon logged
  `engine connected: engine-1 (extension) v3.2.0`.
- **Each endpoint (127.0.0.1:9111 and 9112):**
  - 401 without the token, 403 with a web `Origin`.
  - `initialize` and 15 tools.
  - `browser_status` reported the extension engine.
  - On Engine 1: a tab opened, a snapshot and a screenshot.
  - On Engine 2: headless Chrome launched with a lease, a page, its snapshot. The engine stopped once
    the session ended.
  - DELETE answered 204.
- **The panel's assistant** listed both servers' tools ("15 tool(s) from g9-browser-agent 3.2.0"),
  and a gate called `mcp_browser1_browser_tabs`.
- **The desktop itself**, seen the way a person sees it: the node's own Engine 2 opened the Selkies
  page on `127.0.0.1:3000` and took a screenshot. It showed Chromium with the G9BrowserAgent welcome page (v3.2.0).
  Then, with a tab attached by an agent in front, it showed that tab and **no debugger bar**.

**Public names (checked the same day, on the final build).**
- **The setup:** A records created through the panel's Cloudflare provider; nginx sites with Let's
  Encrypt certificates (valid to 2026-12-25), basic auth, HSTS and WebSockets.
- **Over the internet, per node:**
  - HTTP is redirected to HTTPS.
  - The desktop answers 401 without the password, 401 with a wrong one, and 200 with the right one.
  - `/mcp` answers 401 without the token; with it: `initialize`, 15 tools, and the extension engine
    connected.
- **The desktop through nginx:** node 2's headless Chrome opened node 1's public desktop (TLS, the
  password, the WebSocket stream) and showed its browser.

**Found on the server and fixed before the release (each measured before and after).**

| Finding | Before | After |
|---|---|---|
| A stop killed Chromium mid-shutdown | profile `exit_type` "Crashed"; "Restore pages?" on the next start | "SessionEnded"; no bubble |
| A closed browser stayed closed | Engine 1 gone until a restart | back in ~3 s, extension reconnected |
| An update never reached an existing node | the autostart in `/config` was the first image's | refreshed from the image on each start |
| Chromium ran the first image's extension code | the service-worker script cache was the first build's, under a later manifest | cleared when the extension in the image changes; the new code runs |
| A welcome tab on every start | the extension is reinstalled on each start | the image says `welcome:false` (`deployment.json`) |

The file-level rules are in `setup/unit/docker.test.mjs`: only 127.0.0.1, a hardened desktop, no
apps panel, a token required, the extension loaded, LF scripts. The transport is covered by
`setup/unit/mcp-http.test.mjs`.
