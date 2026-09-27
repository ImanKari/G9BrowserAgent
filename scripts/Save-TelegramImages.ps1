<#
.SYNOPSIS
    Archive every photo in an open Telegram Web channel, scrolling backwards
    through its history.

.DESCRIPTION
    Drives the G9BrowserAgent extension through the same MCP interface an AI
    agent uses. It scrolls the channel upwards — which in Telegram means older —
    and writes each photo it finds to a folder beside this script, named after
    the moment the post was published.

    Sponsored posts are skipped. Telegram gives them `data-mid="-1"` and
    `data-timestamp="2"` alongside the class `is-sponsored`, and they DO carry a
    real image, so filtering them is not optional — without it the archive fills
    up with adverts.

    What was learned by driving this channel by hand first, and what the loop
    below is built on:

      * The scrolling element is `.bubbles-scrollable`, not `.bubbles`.
      * Setting `scrollTop = 0` makes Telegram fetch the next older batch. It
        then RESTORES the scroll position itself so the content does not jump,
        so scrollTop is never 0 for long and cannot be used as a progress mark.
      * Telegram virtualises the list: posts scrolled past are REMOVED from the
        DOM. Roughly 30 stay mounted no matter how far back you go, so images
        must be captured as they pass, never collected at the end.
      * `scrollHeight` stops growing well before the history ends. The honest
        end-of-channel signal is that no SMALLER `data-mid` arrives.
      * Images are `blob:` URLs, so they cannot be fetched from outside the
        page. They are read in-page and returned as base64.

.PARAMETER OutDir
    Where to write images. Defaults to an `images` folder beside this script.

.PARAMETER MaxRounds
    Safety stop on the number of scroll-and-collect rounds. 0 means run until
    the channel ends.

.PARAMETER BatchSize
    How many images to carry back per call. Kept small deliberately: every image
    crosses the bridge as base64, and the WebSocket transport drops any frame
    over 64MB — along with the connection.

.PARAMETER Port
    The bridge port the extension is configured for. Must match the side panel.

.EXAMPLE
    .\Save-TelegramImages.ps1
    .\Save-TelegramImages.ps1 -MaxRounds 20 -OutDir D:\archive
#>

[CmdletBinding()]
param(
    [string] $OutDir,
    [int]    $MaxRounds = 0,
    [int]    $BatchSize = 3,
    [int]    $Port = 8765,
    [int]    $LoadTimeoutMs = 8000
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Here       = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerPath = Join-Path (Split-Path -Parent $Here) 'bridge\src\server.js'
if (-not $OutDir) { $OutDir = Join-Path $Here 'images' }

function Write-Step   { param($m) Write-Host "  $m" -ForegroundColor Gray }
function Write-Good   { param($m) Write-Host "  $m" -ForegroundColor Green }
function Write-Warn2  { param($m) Write-Host "  $m" -ForegroundColor Yellow }

# ─────────────────────────────────────────────────────────── preconditions

if (-not (Test-Path $ServerPath)) {
    throw "Cannot find the bridge at $ServerPath. Run this from inside the repo."
}

# The extension connects to ONE bridge, on the port set in its side panel. If
# something already holds that port — an editor's MCP client, usually — then the
# extension is talking to that one, and a second bridge here would sit alone
# with no browser behind it. Say so rather than timing out later.
$portBusy = $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
if ($portBusy) {
    Write-Host ""
    Write-Host "Port $Port is already in use." -ForegroundColor Red
    Write-Host "The browser extension can only be attached to one bridge at a time, and that"
    Write-Host "port already has one — normally your editor's MCP client."
    Write-Host ""
    Write-Host "Close the MCP client (or stop the stray bridge) and run this again." -ForegroundColor Yellow
    Write-Host ""
    exit 2
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ─────────────────────────────────────────────────────── minimal MCP client

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName               = 'node'
$psi.Arguments              = "`"$ServerPath`""
$psi.RedirectStandardInput  = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError  = $true
$psi.UseShellExecute        = $false
$psi.CreateNoWindow         = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardInputEncoding  = [System.Text.Encoding]::UTF8
$psi.EnvironmentVariables['G9_PORT'] = "$Port"

$bridge = [System.Diagnostics.Process]::Start($psi)

# The bridge writes diagnostics to stderr and protocol frames to stdout. Drain
# stderr in the background: a full pipe buffer would block the whole process.
$drainErr = $bridge.StandardError.ReadToEndAsync()

$script:NextId = 0
function Invoke-Mcp {
    param([string] $Method, [hashtable] $Params = @{}, [int] $TimeoutSec = 90)

    $script:NextId++
    $id = $script:NextId
    $payload = @{ jsonrpc = '2.0'; id = $id; method = $Method; params = $Params }
    $bridge.StandardInput.WriteLine(($payload | ConvertTo-Json -Depth 20 -Compress))
    $bridge.StandardInput.Flush()

    # Read until the reply with OUR id arrives; anything else is a notification.
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $line = $bridge.StandardOutput.ReadLine()
        if ($null -eq $line) { throw 'The bridge closed its output stream.' }
        if (-not $line.Trim()) { continue }
        $msg = $line | ConvertFrom-Json
        if (-not ($msg.PSObject.Properties.Name -contains 'id')) { continue }
        if ($msg.id -ne $id) { continue }
        if ($msg.PSObject.Properties.Name -contains 'error') {
            throw "MCP error on ${Method}: $($msg.error.message)"
        }
        return $msg.result
    }
    throw "Timed out waiting for a reply to $Method."
}

function Invoke-Tool {
    param([string] $Name, [hashtable] $Arguments = @{}, [int] $TimeoutSec = 90)

    $result = Invoke-Mcp -Method 'tools/call' -Params @{ name = $Name; arguments = $Arguments } -TimeoutSec $TimeoutSec
    $text = ($result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text

    # A tool failure comes back as a RESULT carrying isError, not as a protocol
    # error — the message is meant to be read and acted on.
    if ($result.PSObject.Properties.Name -contains 'isError' -and $result.isError) {
        throw "$Name failed: $text"
    }
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return $text | ConvertFrom-Json
}

# The page-side collector. Kept in one place so the script and the browser can
# never disagree about what counts as a post worth saving.
$CollectScript = @'
(async () => {
  window.__g9saved = window.__g9saved || new Set();
  const LIMIT = __LIMIT__;
  const out = [];
  for (const b of document.querySelectorAll('.bubble[data-mid]:not(.is-sponsored)')) {
    if (out.length >= LIMIT) break;
    const mid = +b.dataset.mid, ts = +b.dataset.timestamp;
    // Sponsored posts use mid -1 and timestamp 2, and they do carry an image.
    if (!(mid > 0) || !(ts > 100000) || window.__g9saved.has(mid)) continue;
    const img = b.querySelector('img.media-photo');
    if (!img || !img.complete || !img.naturalWidth) continue;
    try {
      const blob = await (await fetch(img.src)).blob();
      if (!blob.type.startsWith('image/')) continue;
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
      window.__g9saved.add(mid);
      out.push({ mid, ts, mime: blob.type, data: dataUrl.slice(dataUrl.indexOf(',') + 1) });
    } catch (e) { /* one unreadable image is not a reason to stop */ }
  }
  const live = [...document.querySelectorAll('.bubble[data-mid]:not(.is-sponsored)')]
    .map(b => +b.dataset.mid).filter(n => n > 0);
  return { items: out, savedTotal: window.__g9saved.size,
           oldestLoaded: live.length ? Math.min(...live) : null };
})()
'@

# Scroll to the top and wait for OLDER posts, not merely for more height.
$ScrollScript = @'
(async () => {
  const sc = document.querySelector('.bubbles-scrollable');
  if (!sc) return { error: 'Telegram scroll container not found' };
  const oldest = () => {
    const ids = [...document.querySelectorAll('.bubble[data-mid]:not(.is-sponsored)')]
      .map(b => +b.dataset.mid).filter(n => n > 0);
    return ids.length ? Math.min(...ids) : null;
  };
  const before = oldest();
  sc.scrollTop = 0;
  // scrollHeight stops growing well before the history ends, so the signal is
  // a SMALLER message id arriving, not a taller page.
  const deadline = Date.now() + __TIMEOUT__;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    const now = oldest();
    if (now !== null && before !== null && now < before) {
      await new Promise(r => setTimeout(r, 700)); // let the images decode
      return { grew: true, before, after: now };
    }
  }
  return { grew: false, before, after: oldest() };
})()
'@

# ───────────────────────────────────────────────────────────────── run

$saved = 0
$rounds = 0
$exitCode = 0

try {
    Write-Host ""
    Write-Host "G9BrowserAgent — Telegram channel image archive" -ForegroundColor Cyan
    Write-Host "  output: $OutDir"
    Write-Host ""

    Invoke-Mcp -Method 'initialize' -Params @{
        protocolVersion = '2025-06-18'
        capabilities    = @{}
        clientInfo      = @{ name = 'Save-TelegramImages.ps1'; version = '1.0.0' }
    } | Out-Null
    $bridge.StandardInput.WriteLine((@{ jsonrpc = '2.0'; method = 'notifications/initialized' } | ConvertTo-Json -Compress))
    $bridge.StandardInput.Flush()

    Write-Step 'Waiting for the browser extension…'
    $status = $null
    foreach ($attempt in 1..30) {
        try {
            $status = Invoke-Tool -Name 'browser_status'
            if ($status.connected -and $status.attached) { break }
        } catch { }
        Start-Sleep -Milliseconds 1000
        $status = $null
    }
    if (-not $status -or -not $status.attached) {
        throw 'No attached tab. Open the G9BrowserAgent side panel and press "Attach & Pin current tab".'
    }
    Write-Good "Attached: $($status.attached.title)"

    if ($status.attached.url -notmatch 'web\.telegram\.org') {
        throw "The attached tab is $($status.attached.url), not Telegram Web."
    }

    # Interaction needs a visible tab; reading does not. This script only reads
    # and sets scrollTop, so a hidden tab is fine — but say so if it is, because
    # a user watching a blank screen will wonder.
    $vis = Invoke-Tool -Name 'browser_console' -Arguments @{ action = 'evaluate'; expression = 'document.visibilityState' }
    if ($vis.value -ne 'visible') { Write-Warn2 "Tab is '$($vis.value)'. Reading still works." }

    Write-Host ""
    while ($true) {
        $rounds++
        if ($MaxRounds -gt 0 -and $rounds -gt $MaxRounds) {
            Write-Warn2 "Reached the -MaxRounds limit of $MaxRounds."
            break
        }

        # Drain everything currently mounted before scrolling further: Telegram
        # unmounts posts as they leave the viewport, so anything not taken now
        # is gone.
        $roundSaved = 0
        while ($true) {
            $batch = Invoke-Tool -Name 'browser_console' -Arguments @{
                action = 'evaluate'
                expression = $CollectScript.Replace('__LIMIT__', "$BatchSize")
            }
            $items = @($batch.value.items)
            if ($items.Count -eq 0) { break }

            foreach ($item in $items) {
                $stamp = [DateTimeOffset]::FromUnixTimeSeconds([int64]$item.ts).ToLocalTime().ToString('yyyy-MM-dd_HH-mm-ss')
                $ext   = switch ($item.mime) {
                    'image/png'  { 'png' }
                    'image/webp' { 'webp' }
                    'image/gif'  { 'gif' }
                    default      { 'jpg' }
                }
                $path = Join-Path $OutDir "$stamp`_$($item.mid).$ext"
                [System.IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($item.data))
                $saved++; $roundSaved++
            }
        }

        $scroll = Invoke-Tool -Name 'browser_console' -Arguments @{
            action = 'evaluate'
            expression = $ScrollScript.Replace('__TIMEOUT__', "$LoadTimeoutMs")
        }
        if ($scroll.value.PSObject.Properties.Name -contains 'error') { throw $scroll.value.error }

        Write-Step ("round {0,-3} saved {1,-3} total {2,-4} oldest-id {3}" -f $rounds, $roundSaved, $saved, $scroll.value.after)

        if (-not $scroll.value.grew) {
            Write-Good 'No older posts arrived — reached the start of the channel.'
            break
        }
    }

    Write-Host ""
    Write-Good "Done. $saved image(s) in $OutDir"
    Write-Host ""
}
catch {
    Write-Host ""
    Write-Host "  FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    $exitCode = 1
}
finally {
    if ($bridge -and -not $bridge.HasExited) {
        try { $bridge.StandardInput.Close() } catch { }
        if (-not $bridge.WaitForExit(3000)) { $bridge.Kill() }
    }
    if ($VerbosePreference -eq 'Continue' -and $drainErr) {
        Write-Verbose ($drainErr.Result)
    }
}

exit $exitCode
