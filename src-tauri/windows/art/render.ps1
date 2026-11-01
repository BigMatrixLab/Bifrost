# Renders the installer bitmaps from installer-art.html.
#
# Needs the demo server running (npx vite --mode mock --port 5174) so the
# page can load the app's fonts. Writes sidebar.bmp (164 x 314) and
# header.bmp (150 x 57) as 24-bit BMPs, the format NSIS expects, at
# -Scale times those sizes. The default 2 stays sharp on high-DPI screens;
# NSIS scales the bitmaps down to fit at 100%.
param(
  [string]$Server = "http://localhost:5174",
  [int]$Scale = 2
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$edge = @(
  "$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge not found" }

$parts = @(
  @{ Name = "sidebar"; W = 164; H = 314 },
  @{ Name = "header"; W = 150; H = 57 }
)
foreach ($p in $parts) {
  $png = Join-Path $env:TEMP "bifrost-installer-$($p.Name).png"
  $bmp = Join-Path $PSScriptRoot "$($p.Name).bmp"
  Remove-Item $png -ErrorAction SilentlyContinue
  $edgeArgs = @(
    "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=$Scale",
    "--window-size=$($p.W),$($p.H)", "--virtual-time-budget=3000",
    "--user-data-dir=$env:TEMP\bifrost-art-profile",
    "--screenshot=$png", "$Server/src-tauri/windows/art/installer-art.html?part=$($p.Name)"
  )
  Start-Process -Wait -FilePath $edge -ArgumentList $edgeArgs
  if (-not (Test-Path $png)) { throw "Screenshot failed for $($p.Name)" }

  # Re-encode as 24-bit (no alpha), cropped to the exact size.
  $src = [System.Drawing.Image]::FromFile($png)
  $w = $p.W * $Scale; $h = $p.H * $Scale
  $out = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $w, $h), (New-Object System.Drawing.Rectangle 0, 0, $w, $h), [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose(); $src.Dispose()
  $out.Save($bmp, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $out.Dispose()
  Write-Output "wrote $bmp ($w x $h)"
}
