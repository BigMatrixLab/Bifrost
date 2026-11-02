# Regenerates every app icon from the SVG sources in this folder:
#   app-icon.svg            the Bifrost mark on the dark plate (large sizes)
#   app-icon-small.svg      a simplified, bolder mark for 16 to 48 px
#   android-foreground.svg  the mark alone, for Android's adaptive icon
# Run from the repository root:  powershell -File src-tauri/icons/generate.ps1
# Then rebuild the app (build.rs re-embeds icon.ico when this folder changes).
$ErrorActionPreference = "Stop"
$icons = $PSScriptRoot
$root = Resolve-Path (Join-Path $icons "..\..")
$tmp = Join-Path $env:TEMP "bifrost-icons"
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Push-Location $root
try {
  # Desktop, macOS and Android icons from the manifest.
  npx --no-install tauri icon src-tauri/icons/icon-manifest.json -o "$tmp\full" | Out-Null
  # Small sizes from the simplified mark.
  npx --no-install tauri icon src-tauri/icons/app-icon-small.svg -p 16,24,32,48 -o "$tmp\small" | Out-Null
} finally {
  Pop-Location
}

foreach ($f in "128x128.png", "128x128@2x.png", "icon.icns", "icon.png") {
  Copy-Item "$tmp\full\$f" (Join-Path $icons $f) -Force
}
Copy-Item "$tmp\small\32x32.png" (Join-Path $icons "32x32.png") -Force

# Android launcher icons. The adaptive icon keeps its existing XML, whose
# background is the #121212 colour resource.
$res = Join-Path $root "src-tauri\gen\android\app\src\main\res"
if (Test-Path $res) {
  foreach ($d in "mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi") {
    foreach ($f in "ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png") {
      Copy-Item "$tmp\full\android\mipmap-$d\$f" "$res\mipmap-$d\$f" -Force
    }
  }
}

# icon.ico (exe, window, tray, installer): the simplified mark at 16 to 48 px,
# full detail at 64 and 256. Every entry is a PNG, as Windows Vista+ reads.
$frames = @(16, 24, 32, 48 | ForEach-Object { @{ Size = $_; Path = "$tmp\small\${_}x$_.png" } })
$frames += @{ Size = 64; Path = "$tmp\full\64x64.png" }
$frames += @{ Size = 256; Path = "$tmp\full\icon.png" }
Add-Type -AssemblyName System.Drawing
$frames[5].Path = "$tmp\big256.png"
$src = [System.Drawing.Image]::FromFile("$tmp\full\icon.png")
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = "HighQualityBicubic"
$g.DrawImage($src, 0, 0, 256, 256)
$g.Dispose(); $src.Dispose()
$bmp.Save($frames[5].Path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()

$data = $frames | ForEach-Object { , [IO.File]::ReadAllBytes($_.Path) }
$ms = New-Object IO.MemoryStream
$bw = New-Object IO.BinaryWriter $ms
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$frames.Count)
$offset = 6 + 16 * $frames.Count
for ($k = 0; $k -lt $frames.Count; $k++) {
  $d = $frames[$k].Size % 256  # 0 means 256
  $bw.Write([byte]$d); $bw.Write([byte]$d); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$data[$k].Length); $bw.Write([uint32]$offset)
  $offset += $data[$k].Length
}
foreach ($d in $data) { $bw.Write($d) }
$bw.Flush()
[IO.File]::WriteAllBytes((Join-Path $icons "icon.ico"), $ms.ToArray())
Write-Output "icons written; rebuild the app to embed them"
