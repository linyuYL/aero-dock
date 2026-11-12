# Package only the executable, portable marker, license and usage instructions.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root "src-tauri\target"
if ($env:CARGO_TARGET_DIR) {
    $target = $env:CARGO_TARGET_DIR
    if (-not [IO.Path]::IsPathRooted($target)) {
        $target = Join-Path $root $target
    }
}
$release = Join-Path $target "release"
$exe = Join-Path $release "aero-dock.exe"
$license = Join-Path $root "LICENSE"
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "aero-dock.exe not found. Run pnpm tauri build first."
}
if (-not (Test-Path -LiteralPath $license -PathType Leaf)) {
    throw "LICENSE not found. The portable package must include the MIT license."
}

$config = Get-Content -LiteralPath (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$version = $config.version
$outDir = Join-Path $release "bundle\portable"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$zip = Join-Path $outDir "Aero.Dock_${version}_x64-portable.zip"
$temporaryZip = Join-Path $outDir ("portable-" + [guid]::NewGuid().ToString("N") + ".tmp")
$folder = "Aero Dock $version"
$utf8 = New-Object Text.UTF8Encoding($false)
$texts = @{
    "portable.txt" = "Aero Dock stores its settings and icon cache in the data folder beside this file."
    "README.txt" = @"
Aero Dock $version - Simplified Chinese portable edition

Extract this archive, keep its files together and run "Aero Dock.exe".
Keep portable.txt beside the executable to enable portable mode.
Settings, pinned items, icons and the WebView2 profile are created in data.

Requires Windows 10 1809 or later / Windows 11, x64, and Microsoft WebView2.
WebView2: https://developer.microsoft.com/microsoft-edge/webview2/

Use the tray icon to open settings or quit.
Enabling launch at sign-in creates a Windows startup entry. Disable that
option before moving the portable folder to another location.

Original author: Ryan Panda
Simplified Chinese fork: linyuYL
License: MIT (see LICENSE)
Source and issues: https://github.com/linyuYL/aero-dock
Upstream: https://github.com/TheAgencyMGE/aero-dock
"@
}

$stream = [IO.File]::Open($temporaryZip, [IO.FileMode]::CreateNew)
try {
    $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $exe, "$folder/Aero Dock.exe", [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $license, "$folder/LICENSE", [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        foreach ($name in $texts.Keys) {
            $entry = $archive.CreateEntry("$folder/$name", [IO.Compression.CompressionLevel]::Optimal)
            $writer = New-Object IO.StreamWriter($entry.Open(), $utf8)
            try {
                $writer.Write($texts[$name])
            } finally {
                $writer.Dispose()
            }
        }
    } finally {
        $archive.Dispose()
    }
} finally {
    $stream.Dispose()
}

if (Test-Path -LiteralPath $zip) {
    # Windows PowerShell requires a typed null for the optional backup path.
    [IO.File]::Replace($temporaryZip, $zip, [System.Management.Automation.Language.NullString]::Value)
} else {
    [IO.File]::Move($temporaryZip, $zip)
}
$size = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 2)
Write-Output "Built $zip ($size MB)"
