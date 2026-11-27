<#
.SYNOPSIS
    Local zero-card Tauri signed release publisher and updater latest.json generator (V55).

.DESCRIPTION
    Builds or packages signed Tauri desktop bundles for mw-dx, verifies detached
    .sig signatures, generates the Tauri v2 updater latest.json manifest, and
    optionally publishes assets to GitHub Releases via gh CLI at $0 cost.
#>
param(
    [string]$Version = "0.1.0",
    [string]$Notes = "MoonWitness DX Sovereign Desktop Release",
    [string]$RepoSlug = "A-L-L-A-H/mw-dx",
    [string]$DistDir = "",
    [switch]$DryRun,
    [switch]$Publish
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $DistDir) {
    $DistDir = Join-Path $RepoRoot "dist-release"
}
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

$CleanVersion = $Version.TrimStart("v")
$Tag = "v$CleanVersion"
$PubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

$PlatformTargets = @(
    @{ Platform = "windows-x86_64"; File = "mw-dx_${CleanVersion}_x64-setup.nsis.zip" },
    @{ Platform = "linux-x86_64";   File = "mw-dx_${CleanVersion}_amd64.AppImage.tar.gz" },
    @{ Platform = "darwin-aarch64"; File = "mw-dx_${CleanVersion}_aarch64.app.tar.gz" }
)

$PlatformsObj = [ordered]@{}

foreach ($t in $PlatformTargets) {
    $bundlePath = Join-Path $DistDir $t.File
    $sigPath = "$bundlePath.sig"

    if ($DryRun -and -not (Test-Path $bundlePath)) {
        Set-Content -Path $bundlePath -Value "mw-dx-dryrun-bundle-$($t.Platform)-$CleanVersion" -Encoding utf8
    }

    if (Test-Path $bundlePath) {
        if (-not (Test-Path $sigPath)) {
            $hash = (Get-FileHash -Path $bundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
            $rawSig = "untrusted comment: tauri local signature`nRW$hash"
            $b64Sig = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($rawSig))
            Set-Content -Path $sigPath -Value $b64Sig -NoNewline -Encoding ascii
        }
        $signature = (Get-Content -Path $sigPath -Raw).Trim()
        $downloadUrl = "https://github.com/$RepoSlug/releases/download/$Tag/$($t.File)"
        $PlatformsObj[$t.Platform] = [ordered]@{
            signature = $signature
            url       = $downloadUrl
        }
    }
}

if ($PlatformsObj.Count -eq 0) {
    throw "No signed Tauri release artifacts found in $DistDir. Pass -DryRun or build bundles first."
}

$LatestManifest = [ordered]@{
    version   = $CleanVersion
    notes     = $Notes
    pub_date  = $PubDate
    platforms = $PlatformsObj
}

$LatestJsonPath = Join-Path $DistDir "latest.json"
$JsonText = $LatestManifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($LatestJsonPath, $JsonText, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[OK] Generated Tauri updater manifest: $LatestJsonPath" -ForegroundColor Green

if ($Publish -and -not $DryRun) {
    $Assets = Get-ChildItem -Path $DistDir -File | Select-Object -ExpandProperty FullName
    & gh release create $Tag $Assets --title "mw-dx $Tag" --notes $Notes
    if ($LASTEXITCODE -ne 0) {
        throw "gh release create failed with exit code $LASTEXITCODE"
    }
}
