# Builds the bifrost_ui NSIS plugin and copies it to ..\plugins\x86-unicode,
# where installer-hooks.nsh picks it up. NSIS is 32-bit, so the DLL is too.
# Run again after changing src\lib.rs; the built DLL is committed so a
# normal `npx tauri build` doesn't need this step.
$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
  rustup target add i686-pc-windows-msvc | Out-Null
  # .cargo\config.toml selects the target and a static CRT.
  cargo build --release
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
  $out = Join-Path $PSScriptRoot "..\plugins\x86-unicode"
  New-Item -ItemType Directory -Force $out | Out-Null
  Copy-Item "target\i686-pc-windows-msvc\release\bifrost_ui.dll" $out -Force
  Write-Output "copied bifrost_ui.dll to $((Resolve-Path $out).Path)"
} finally {
  Pop-Location
}
