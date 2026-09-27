<#
.SYNOPSIS
  Sets up G9BrowserAgent v2 on this machine from a clone of the repository (the Node path).

.DESCRIPTION
  Verifies Node 22+, runs the unit tests, the daemon/MCP self-test and the
  extension regression test, writes an MCP config that points at mcp/shim.mjs
  (the shim starts the g9d daemon on demand — there is no service to install),
  and prints the one step that cannot be automated: loading the unpacked
  extension in Chrome/Edge.

  No Node on the machine? Use the desktop installer (G9BrowserAgent-Setup.exe) instead: it
  carries its own runtime, registers the MCP shim for the AI clients it finds,
  and manages the extension folder and updates.

.EXAMPLE
  .\setup\install.ps1
  .\setup\install.ps1 -WriteProjectConfig
  .\setup\install.ps1 -Port 9000 -SkipTests
#>
[CmdletBinding()]
param(
  # The daemon port. Leave it at 8765 unless something else owns that port;
  # the extension panel's "daemon address" must then use the same number.
  [int]$Port = 8765,
  [switch]$SkipTests,
  # Kept for v1 muscle memory: same as -SkipTests.
  [switch]$SkipSelfTest,
  # Writes .mcp.json into the repo root, which is where Claude Code looks for a
  # project-scoped server. Opt-in, because it puts a file in the user's project
  # rather than under setup/ — but without it, step B below is a manual copy
  # that is the single most-missed part of setup (v1.0.7).
  [switch]$WriteProjectConfig
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Write-Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Write-Ok($text)       { Write-Host "    OK  $text" -ForegroundColor Green }
function Write-Warn2($text)    { Write-Host "    !   $text" -ForegroundColor Yellow }

# UTF-8 WITHOUT a byte-order mark. Set-Content -Encoding utf8 writes a BOM under
# Windows PowerShell 5.1 (the powershell.exe every Windows machine has), and a
# BOM in front of an MCP config is a JSON parse error for strict readers.
function Write-Utf8NoBom($path, $text) { [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false)) }

$version = '?'
try { $version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version } catch { }

Write-Host "`nG9 v$version - setup" -ForegroundColor White
Write-Host "Repo: $repo" -ForegroundColor DarkGray

# --- 1. Node -----------------------------------------------------------------
Write-Step 1 "Checking Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "    Node.js is not on PATH. Install Node 22 or newer (https://nodejs.org)," -ForegroundColor Red
  Write-Host "    or use the desktop installer (G9BrowserAgent-Setup.exe), which needs no Node." -ForegroundColor Red
  exit 1
}
$nodeVersion = (node --version).TrimStart('v')
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 22) {
  Write-Host "    Node $nodeVersion is too old. G9BrowserAgent v2 needs Node 22 or newer," -ForegroundColor Red
  Write-Host "    or use the desktop installer (G9BrowserAgent-Setup.exe), which needs no Node." -ForegroundColor Red
  exit 1
}
Write-Ok "Node $nodeVersion"
Write-Ok "No npm install needed - the core has zero dependencies."

# --- 2. Tests ----------------------------------------------------------------
if (-not ($SkipTests -or $SkipSelfTest)) {
  Write-Step 2 "Running tests (unit, daemon/MCP self-test, extension regressions)"
  $suites = @(
    @{ Name = 'Unit tests';                 Script = 'unittest.mjs' },
    @{ Name = 'Daemon + MCP self-test';     Script = 'selftest.mjs' },
    @{ Name = 'Extension regression test';  Script = 'extensiontest.mjs' }
  )
  foreach ($suite in $suites) {
    & node (Join-Path $PSScriptRoot $suite.Script)
    if ($LASTEXITCODE -ne 0) {
      Write-Host "`n    $($suite.Name) failed. Fix this before loading the extension." -ForegroundColor Red
      exit 1
    }
    Write-Ok $suite.Name
  }
} else {
  Write-Step 2 "Skipping the tests (-SkipTests)"
}

# --- 3. MCP config -----------------------------------------------------------
Write-Step 3 "Writing MCP client config"
$shimPath = (Join-Path $repo 'mcp\shim.mjs') -replace '\\', '/'
$config = [ordered]@{
  mcpServers = [ordered]@{
    'g9browseragent' = [ordered]@{
      command = 'node'
      args    = @($shimPath)
      env     = [ordered]@{ G9_HOST = '127.0.0.1'; G9_PORT = "$Port" }
    }
  }
}
$outPath = Join-Path $PSScriptRoot 'mcp.json'
$json = $config | ConvertTo-Json -Depth 6
Write-Utf8NoBom $outPath $json
Write-Ok "Wrote $outPath"

if ($WriteProjectConfig) {
  $projectConfig = Join-Path $repo '.mcp.json'
  $existing = $null
  if (Test-Path $projectConfig) {
    try { $existing = Get-Content $projectConfig -Raw | ConvertFrom-Json } catch { $existing = $null }
  }
  $existingArgs = @()
  if ($existing -and $existing.mcpServers -and $existing.mcpServers.'g9browseragent') { $existingArgs = @($existing.mcpServers.'g9browseragent'.args) }
  $isOldBridge = $existingArgs | Where-Object { $_ -match 'bridge[\\/]+src[\\/]+server\.js' }
  if ((Test-Path $projectConfig) -and -not $isOldBridge) {
    Write-Warn2 "$projectConfig already exists - leaving it alone. Merge setup\mcp.json by hand if needed."
  } else {
    if ($isOldBridge) {
      Copy-Item $projectConfig "$projectConfig.v1.bak" -Force
      Write-Ok "Backed up the v1 config to .mcp.json.v1.bak (it pointed at bridge/src/server.js)"
    }
    Write-Utf8NoBom $projectConfig $json
    Write-Ok "Wrote $projectConfig (Claude Code reads this; restart the client to pick it up)"
  }
} else {
  Write-Warn2 "Step B below is a manual copy. Re-run with -WriteProjectConfig to have .mcp.json written for you."
}

Write-Ok "Configs that still point at bridge/src/server.js keep working: it now starts mcp/shim.mjs."

# --- 4. Manual steps ---------------------------------------------------------
$extensionSteps = @"
       Chrome:  chrome://extensions      Edge:  edge://extensions
       - Turn on "Developer mode"
       - Click "Load unpacked"  (or "Reload" if an older G9BrowserAgent extension is already loaded)
       - Select:  $repo\extension
"@

if ($WriteProjectConfig) {
  Write-Step 4 "One manual step remains"
  Write-Host "`n    Load the extension (Engine 1 - lets agents drive tabs in YOUR browser)" -ForegroundColor Gray
  Write-Host $extensionSteps -ForegroundColor Gray
  Write-Host @"

    The MCP config is already written to .mcp.json. Restart your MCP client
    (Claude Code, Cursor, VS Code) so it picks the server up.
"@ -ForegroundColor Gray
} else {
  Write-Step 4 "Two manual steps remain"
  Write-Host "`n    A. Load the extension (Engine 1 - lets agents drive tabs in YOUR browser)" -ForegroundColor Gray
  Write-Host $extensionSteps -ForegroundColor Gray
  Write-Host @"

    B. Point your agent at the MCP shim
       Copy the contents of setup\mcp.json into your MCP client config:

       Claude Code    .mcp.json in your project, or  claude mcp add
       Cursor         .cursor/mcp.json
       VS Code        .vscode/mcp.json
       Claude Desktop %APPDATA%\Claude\claude_desktop_config.json
"@ -ForegroundColor Gray
}

Write-Host @"

    How it runs: the first agent that calls a G9BrowserAgent tool starts the daemon (g9d) on
    127.0.0.1:$Port by itself; it stops on its own after an hour with nobody
    connected. Launched browsers (Engine 2) need no extension at all - an agent
    can call browser_tabs action:"open" and G9BrowserAgent starts a headless Edge/Chrome.
    To watch the daemon:  node daemon/g9d.mjs --foreground

    No Node on a QA machine? Use the desktop installer (G9BrowserAgent-Setup.exe) - it bundles
    the runtime, registers the shim with the AI clients it finds, and keeps the
    extension folder up to date.
"@ -ForegroundColor DarkGray

Write-Host "    Want a page to try it on?" -ForegroundColor DarkGray
Write-Host "      node setup/serve.mjs   ->  http://127.0.0.1:5199/`n" -ForegroundColor DarkGray
