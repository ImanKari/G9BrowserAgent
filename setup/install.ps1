<#
.SYNOPSIS
  Sets up G9 Browser Agent on this machine.

.DESCRIPTION
  Verifies Node, runs the self-test, writes an mcp.json with the correct
  absolute path, and prints the two manual steps that cannot be automated
  (loading an unpacked extension is deliberately user-driven in Chrome/Edge).

.EXAMPLE
  .\setup\install.ps1
  .\setup\install.ps1 -Port 9000
#>
[CmdletBinding()]
param(
  [int]$Port = 8765,
  [switch]$SkipSelfTest
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
  Write-Step 2 "Running the self-test (bridge + MCP + WebSocket)"
  & node (Join-Path $PSScriptRoot 'selftest.mjs')
  if ($LASTEXITCODE -ne 0) {
    Write-Host "`n    Self-test failed. Fix this before loading the extension." -ForegroundColor Red
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
$config | ConvertTo-Json -Depth 6 | Set-Content -Path $outPath -Encoding utf8
Write-Ok "Wrote $outPath"

# --- 4. Manual steps --------------------------------------------------------
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
