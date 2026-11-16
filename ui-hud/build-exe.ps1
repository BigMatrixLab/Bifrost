# Builds the experimental HUD app as ui-hud/release/Bifrost-HUD.exe.
# The main app is untouched: the Rust shell in ../src-tauri is compiled as-is
# with ui-hud/tauri.hud.conf.json layered on top (HUD frontend, own exe name,
# own identifier = own data folder), into its own target dir (ui-hud/target).
$ErrorActionPreference = "Stop"
$hud = $PSScriptRoot
$root = Split-Path $hud -Parent

Push-Location $hud
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }
} finally { Pop-Location }

$env:CARGO_TARGET_DIR = Join-Path $hud "target"
Push-Location $root
try {
  node node_modules/@tauri-apps/cli/tauri.js build --config ui-hud/tauri.hud.conf.json --no-bundle
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
} finally { Pop-Location }

$exe = Join-Path $hud "target\release\Bifrost-HUD.exe"
if (-not (Test-Path $exe)) { throw "expected $exe" }
$out = Join-Path $hud "release"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item $exe $out -Force
Write-Output "Built $(Join-Path $out 'Bifrost-HUD.exe')"
