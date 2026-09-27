<#
.SYNOPSIS
  Writes the extension's icons (extension/panel/icon16/32/48/128.png) from one square artwork PNG.

.DESCRIPTION
  The artwork is the owner's (U9, AIGuide §6.10): a detailed scene, a browser window with "G9BrowserAgent", a
  robot, a cursor and an orbit, on a transparent background. 32, 48 and 128 px show all of it,
  cropped to the drawing. At 16 px (the toolbar at 100 % display scaling) that scene is a blur, so
  16 px shows only the browser window with "G9BrowserAgent" (-SmallCrop), the one part that stays readable.

  Downscaling halves the image step by step, then does one final high-quality bicubic resize,
  in premultiplied alpha so that transparent edges do not turn dark. Windows only (System.Drawing),
  like install.ps1. It writes nothing outside extension/panel/.

.EXAMPLE
  .\setup\make-icons.ps1 -Source "$env:USERPROFILE\Downloads\g9-icon.png"

.PARAMETER Crop
  x, y, size of the square to use for 32/48/128, in source pixels. The default fits the
  2026-09-25 artwork (1254x1254, drawing inside 50..1178 x 96..1124, plus a small margin).

.PARAMETER SmallCrop
  x, y, size of the square to use for 16 px: the browser window with "G9BrowserAgent" in the same artwork.
#>
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [int[]]$Crop = @(38, 34, 1152),
  [int[]]$SmallCrop = @(190, 300, 780)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot '..\extension\panel' | Resolve-Path

function Resize-Square([System.Drawing.Image]$img, [System.Drawing.Rectangle]$from, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CompositingMode = 'SourceCopy'
  $g.CompositingQuality = 'HighQuality'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $attr = New-Object System.Drawing.Imaging.ImageAttributes
  $attr.SetWrapMode('TileFlipXY') # no dark fringe from sampling outside the source
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)), $from.X, $from.Y, $from.Width, $from.Height, 'Pixel', $attr)
  $g.Dispose()
  $attr.Dispose()
  return $bmp
}

function New-Icon([System.Drawing.Image]$img, [int[]]$square, [int]$target) {
  $cur = Resize-Square $img (New-Object System.Drawing.Rectangle($square[0], $square[1], $square[2], $square[2])) $square[2]
  while ($cur.Width / 2 -ge $target * 2) {
    $next = Resize-Square $cur (New-Object System.Drawing.Rectangle(0, 0, $cur.Width, $cur.Height)) ([int]($cur.Width / 2))
    $cur.Dispose()
    $cur = $next
  }
  $final = Resize-Square $cur (New-Object System.Drawing.Rectangle(0, 0, $cur.Width, $cur.Height)) $target
  $cur.Dispose()
  # PNG is written straight (not premultiplied) alpha.
  $icon = New-Object System.Drawing.Bitmap($target, $target, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($icon)
  $g.CompositingMode = 'SourceCopy'
  $g.DrawImage($final, 0, 0, $target, $target)
  $g.Dispose()
  $final.Dispose()
  return $icon
}

$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Source))
try {
  foreach ($c in @($Crop, $SmallCrop)) {
    if ($c.Count -ne 3 -or $c[0] -lt 0 -or $c[1] -lt 0 -or $c[0] + $c[2] -gt $src.Width -or $c[1] + $c[2] -gt $src.Height) {
      throw "Crop $($c -join ',') does not fit the $($src.Width)x$($src.Height) source."
    }
  }
  foreach ($size in 16, 32, 48, 128) {
    $icon = New-Icon $src ($(if ($size -eq 16) { $SmallCrop } else { $Crop })) $size
    $file = Join-Path $out "icon$size.png"
    $icon.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $icon.Dispose()
    Write-Output ("{0,-12} {1,6} bytes" -f "icon$size.png", (Get-Item $file).Length)
  }
} finally {
  $src.Dispose()
}
