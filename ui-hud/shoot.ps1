# Screenshots of the HUD UI in demo mode (needs `npm run dev:ui` running).
#   ./shoot.ps1                      -> every page
#   ./shoot.ps1 -Pages overview,shares -Tag teal -Skin teal
param(
  [string[]]$Pages = @("overview", "shares", "devices", "transfers", "history", "activity", "settings"),
  [string]$Tag = "",
  [string]$Skin = "",
  [string]$Open = "",
  [int]$Width = 1280,
  [int]$Height = 820
)
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$out = Join-Path $PSScriptRoot "shots"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$profileDir = Join-Path $env:TEMP "bifrost-hud-shot"
foreach ($p in $Pages) {
  $name = if ($Tag) { "$p-$Tag.png" } else { "$p.png" }
  $file = Join-Path $out $name
  $q = if ($Open) { "?open=$Open" } elseif ($Skin) { "?skin=$Skin" } else { "" }
  & $edge --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$profileDir" `
    --window-size="$Width,$Height" --virtual-time-budget=6000 `
    --screenshot="$file" "http://localhost:5174/$q#$p" 2>$null | Out-Null
  Write-Output $file
}
