<#
.SYNOPSIS
  Sets up G9 Browser Agent on this machine.

.DESCRIPTION
  Verifies Node, runs the bridge and extension regression tests, writes an mcp.json with the correct
  absolute path, and prints the two manual steps that cannot be automated
  (loading an unpacked extension is deliberately user-driven in Chrome/Edge).

.EXAMPLE
  .\setup\install.ps1
  .\setup\install.ps1 -Port 9000
#>
[CmdletBinding()]
param(
  [int]$Port = 8765,
  [switch]$SkipSelfTest,
  # Writes .mcp.json into the repo root, which is where Claude Code looks for a
  # project-scoped server. Opt-in, because it puts a file in the user's project
  # rather than under setup/ — but without it, step B below is a manual copy that
  # is the single most-missed part of setup. See the v1.0.7 change-log entry.
  [switch]$WriteProjectConfig
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Write-Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Write-Ok($text)       { Write-Host "    OK  $text" -ForegroundColor Green }
function Write-Warn2($text)    { Write-Host "    !   $text" -ForegroundColor Yellow }

Write-Host "`nG9 Browser Agent — setup" -ForegroundColor White
Write-Host "Repo: $repo" -ForegroundColor DarkGray

# --- 1. Node ----------------------------------------------------------------
Write-Step 1 "Checking Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "    Node.js is not on PATH. Install Node 18 or newer: https://nodejs.org" -ForegroundColor Red
  exit 1
}
$version = (node --version).TrimStart('v')
$major = [int]($version.Split('.')[0])
if ($major -lt 18) {
  Write-Host "    Node $version is too old. Version 18 or newer is required." -ForegroundColor Red
  exit 1
}
Write-Ok "Node $version"
Write-Ok "No npm install needed — the bridge has zero dependencies."

# --- 2. Self-test -----------------------------------------------------------
if (-not $SkipSelfTest) {
  Write-Step 2 "Running tests (bridge/MCP/WebSocket + extension regressions)"
  & node (Join-Path $PSScriptRoot 'selftest.mjs')
  if ($LASTEXITCODE -ne 0) {
    Write-Host "`n    Self-test failed. Fix this before loading the extension." -ForegroundColor Red
    exit 1
  }
  & node (Join-Path $PSScriptRoot 'extensiontest.mjs')
  if ($LASTEXITCODE -ne 0) {
    Write-Host "`n    Extension regression test failed. Fix this before loading the extension." -ForegroundColor Red
    exit 1
  }
} else {
  Write-Step 2 "Skipping the self-test (-SkipSelfTest)"
}

# --- 3. MCP config ----------------------------------------------------------
Write-Step 3 "Writing MCP client config"
$serverPath = (Join-Path $repo 'bridge\src\server.js') -replace '\\', '/'
$config = [ordered]@{
  mcpServers = [ordered]@{
    'g9-browser' = [ordered]@{
      command = 'node'
      args    = @($serverPath)
      env     = [ordered]@{ G9_HOST = '127.0.0.1'; G9_PORT = "$Port" }
    }
  }
}
$outPath = Join-Path $PSScriptRoot 'mcp.json'
$json = $config | ConvertTo-Json -Depth 6
$json | Set-Content -Path $outPath -Encoding utf8
Write-Ok "Wrote $outPath"

if ($WriteProjectConfig) {
  $projectConfig = Join-Path $repo '.mcp.json'
  if (Test-Path $projectConfig) {
    Write-Warn2 "$projectConfig already exists — leaving it alone. Merge setup\mcp.json by hand if needed."
  } else {
    $json | Set-Content -Path $projectConfig -Encoding utf8
    Write-Ok "Wrote $projectConfig (Claude Code reads this; restart the client to pick it up)"
  }
} else {
  Write-Warn2 "Step B below is a manual copy. Re-run with -WriteProjectConfig to have it written for you."
}

# --- 4. Manual steps --------------------------------------------------------
if ($WriteProjectConfig) {
  Write-Step 4 "One manual step remains"

  Write-Host @"

    Load the extension
       Chrome:  chrome://extensions      Edge:  edge://extensions
       - Turn on "Developer mode"
       - Click "Load unpacked"
       - Select:  $repo\extension

    The MCP config is already written to .mcp.json. Restart your MCP client
    (Claude Code, Cursor, VS Code) so it picks the server up.

"@ -ForegroundColor Gray

  Write-Host "    Then: open a page, click the G9 toolbar icon, press 'Attach & Pin current tab'.`n" -ForegroundColor White
  Write-Host "    Want a page to try it on?" -ForegroundColor DarkGray
  Write-Host "      node setup/serve.mjs   ->  http://127.0.0.1:5199/`n" -ForegroundColor DarkGray
  return
}

Write-Step 4 "Two manual steps remain"

Write-Host @"

    A. Load the extension
       Chrome:  chrome://extensions      Edge:  edge://extensions
       - Turn on "Developer mode"
       - Click "Load unpacked"
       - Select:  $repo\extension

    B. Point your agent at the bridge
       Copy the contents of setup\mcp.json into your MCP client config:

       Claude Code    .mcp.json in your project, or  claude mcp add
       Cursor         .cursor/mcp.json
       VS Code        .vscode/mcp.json
       Claude Desktop %APPDATA%\Claude\claude_desktop_config.json

"@ -ForegroundColor Gray

Write-Host "    Then: open a page, click the G9 toolbar icon, press 'Attach & Pin current tab'.`n" -ForegroundColor White

Write-Host "    Want a page to try it on?" -ForegroundColor DarkGray
Write-Host "      node setup/serve.mjs   ->  http://127.0.0.1:5199/`n" -ForegroundColor DarkGray
