# REALM one-command installer for Windows (irm <raw-url> | iex entry point).
#
# Mirrors scripts/install.sh: detect Node 22.13+ (offer a consent-gated winget
# install) -> fetch the REALM source (git clone, or codeload zip when git is
# absent) -> npm ci -> hand off to scripts/setup-web.ps1.
#
# Conservative by design:
# - nothing is installed without an explicit confirmation (or -Yes/--yes);
# - all state lives under %USERPROFILE%\.realm; no elevation, no system changes;
# - re-running updates an existing clone in place.
#
# With -PgArtifact <url|path>, the installer drops the embedded PostgreSQL
# 17 + pgvector bundle (windows-x64) into the user directory, same semantics
# as install.sh --pg-artifact on Linux.
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$EmbeddedPg,
  [string]$PgArtifact
)

$ErrorActionPreference = 'Stop'
$MinNode = '22.13.0'
$RealmHome = if ($env:REALM_HOME) { $env:REALM_HOME } else { Join-Path $HOME '.realm' }
$AppDir = Join-Path $RealmHome 'app'
$Ref = if ($env:REALM_INSTALL_REF) { $env:REALM_INSTALL_REF } else { 'main' }
$SourceUrl = $env:REALM_SOURCE_URL

function Write-RealmLog([string]$Message) {
  Write-Host "[realm] $Message" -ForegroundColor Cyan
}

function Confirm-Realm([string]$Prompt) {
  if ($Yes) { Write-RealmLog "$Prompt (-Yes)"; return $true }
  $answer = Read-Host "$Prompt [y/N]"
  return $answer -match '^(?i:y(es)?)$'
}

function Test-Node22 {
  try {
    $version = (& node -p 'process.versions.node').Trim()
    $parts = $version.Split('.') | ForEach-Object { [int]$_ }
    return ($parts[0] -gt 22) -or (($parts[0] -eq 22) -and ($parts[1] -ge 13))
  } catch {
    return $false
  }
}

# --- 1. Node 22.13+ ------------------------------------------------------------
if (-not (Test-Node22)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Node.js $MinNode+ is required. Install Node.js or winget, then rerun."
  }
  if (-not (Confirm-Realm "Node.js $MinNode+ not found. Install Node.js LTS with winget?")) {
    throw "Node.js $MinNode+ is required; install it and rerun."
  }
  winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
  Write-RealmLog 'Node.js was installed. Open a new PowerShell session and rerun this script.'
  exit 0
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is missing next to node; install Node.js $MinNode+ properly"
}

# --- 2. Source ------------------------------------------------------------------
if (-not $SourceUrl) {
  $gitRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
  if (Test-Path (Join-Path $gitRoot '.git')) {
    try { $SourceUrl = (& git -C $gitRoot remote get-url origin).Trim() } catch { $SourceUrl = $null }
  }
}
if (-not $SourceUrl) { $SourceUrl = 'https://github.com/Silver-Aurora/REALM.git' }

if (Test-Path (Join-Path $AppDir '.git')) {
  Write-RealmLog "updating existing clone at $AppDir ($Ref)"
  & git -C $AppDir fetch --depth 1 origin $Ref | Out-Host
  & git -C $AppDir checkout -q FETCH_HEAD | Out-Host
} elseif ((Test-Path $AppDir) -and (Test-Path (Join-Path $AppDir 'package.json'))) {
  Write-RealmLog "using existing source at $AppDir (not a git clone; skipping update)"
} else {
  $cloneOk = $false
  if (Get-Command git -ErrorAction SilentlyContinue) {
    if (Confirm-Realm "Clone $SourceUrl ($Ref) into $AppDir?") {
      New-Item -ItemType Directory -Force -Path $RealmHome | Out-Null
      & git clone --depth 1 --branch $Ref $SourceUrl $AppDir
      if ($LASTEXITCODE -eq 0) { $cloneOk = $true }
      else { & git clone --depth 1 $SourceUrl $AppDir | Out-Host; $cloneOk = ($LASTEXITCODE -eq 0) }
    } else {
      throw 'aborted'
    }
  }
  if (-not $cloneOk -and -not (Test-Path (Join-Path $AppDir 'package.json'))) {
    # no git (or clone failed): fall back to the codeload zip for a GitHub URL
    if ($SourceUrl -match '^https://github.com/([^/]+/[^/]+?)(\.git)?$') {
      $slug = $Matches[1]
      $zipUrl = "https://codeload.github.com/$slug/zip/refs/heads/$Ref"
      if (Confirm-Realm "Download and extract $zipUrl into $AppDir?") {
        New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
        $zipTmp = Join-Path ([IO.Path]::GetTempPath()) "realm-src-$Ref.zip"
        Invoke-WebRequest -UseBasicParsing -Uri $zipUrl -OutFile $zipTmp
        Expand-Archive -Force -Path $zipTmp -DestinationPath $AppDir
        Get-ChildItem -Path $AppDir -Directory | Select-Object -First 1 |
          ForEach-Object { Get-ChildItem $_.FullName | Move-Item -Destination $AppDir -Force; Remove-Item $_.FullName -Recurse }
        Remove-Item $zipTmp -Force
      } else {
        throw 'aborted'
      }
    } else {
      throw "git is required for this source URL: $SourceUrl"
    }
  }
}

if (-not (Test-Path (Join-Path $AppDir 'package.json'))) {
  throw "no package.json under $AppDir; source fetch looks broken"
}

# --- 3. Dependencies -------------------------------------------------------------
if ($env:REALM_INSTALL_SKIP_NPM -eq '1') {
  Write-RealmLog 'REALM_INSTALL_SKIP_NPM=1 -> stopping before npm ci'
  exit 0
}
Write-RealmLog 'installing npm dependencies (ci)'
Push-Location $AppDir
try {
  & npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
} finally {
  Pop-Location
}

# --- 4. Embedded PostgreSQL（-EmbeddedPg 自动解析 / -PgArtifact 显式指定） ------
# 重跑同一条安装命令即完整升级：源码 fetch 更新（上文）+ 此处构件版本比较。
$pgShaUrl = $null
$pgArtVersion = $env:REALM_PG_VERSION
if ($EmbeddedPg -and -not $PgArtifact) {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($arch -ne 'AMD64') {
    throw "-EmbeddedPg: no prebuilt artifact for Windows/$arch (available: windows-x64; ARM64 请用本地 PostgreSQL 17 + pgvector 或 Docker)"
  }
  # 目标版本：显式 REALM_PG_VERSION > GitHub latest release API（静默失败回落内置）。
  if (-not $pgArtVersion) {
    try {
      $release = Invoke-RestMethod -TimeoutSec 8 -Uri 'https://api.github.com/repos/Silver-Aurora/REALM/releases/latest' -Headers @{ 'User-Agent' = 'realm-installer' }
      if ($release.tag_name -match '^pg-(.+)$') { $pgArtVersion = $Matches[1] }
    } catch { }
    if (-not $pgArtVersion) { $pgArtVersion = '17.10' }
  }
  $pgBase = if ($env:REALM_PG_RELEASE_BASE) { $env:REALM_PG_RELEASE_BASE } else { "https://github.com/Silver-Aurora/REALM/releases/download/embedded-pg-$pgArtVersion" }
  $PgArtifact = "$pgBase/realm-embedded-pg-windows-x64-$pgArtVersion.tar.gz"
  $pgShaUrl = "$pgBase/sha256sums.txt"
  Write-RealmLog "embedded PostgreSQL artifact: $PgArtifact"
}

if ($PgArtifact) {
  $installedVersion = $null
  $versionOut = (& node (Join-Path $AppDir 'scripts/embedded-pg.mjs') version 2>$null)
  if ($LASTEXITCODE -eq 0 -and $versionOut -match '(\d+\.\d+)') { $installedVersion = $Matches[1] }
  if ($installedVersion -and $pgArtVersion -and $installedVersion -eq $pgArtVersion) {
    Write-RealmLog "embedded PostgreSQL $installedVersion already up to date; skipping"
  } else {
    if ($EmbeddedPg) {
      if (-not (Confirm-Realm "Download embedded PostgreSQL $pgArtVersion + pgvector (windows-x64, ~31MB) from GitHub Releases and install it under ~\.local\realm-pgsql?")) {
        throw 'aborted'
      }
    }
    $pgTmp = $PgArtifact
    if ($PgArtifact -like 'http*') {
      $pgTmp = Join-Path ([IO.Path]::GetTempPath()) 'realm-embedded-pg.tar.gz'
      Write-RealmLog "downloading $PgArtifact"
      Invoke-WebRequest -UseBasicParsing -Uri $PgArtifact -OutFile $pgTmp
      if ($pgShaUrl) {
        $sumsTmp = Join-Path ([IO.Path]::GetTempPath()) 'realm-pg-sha256sums.txt'
        Invoke-WebRequest -UseBasicParsing -Uri $pgShaUrl -OutFile $sumsTmp
        $expected = (Select-String -Path $sumsTmp -Pattern " $($PgArtifact.Split('/')[-1])`$").Line.Split(' ')[0]
        $actual = (Get-FileHash -Algorithm SHA256 $pgTmp).Hash.ToLowerInvariant()
        if ($expected -ne $actual) { throw "artifact checksum mismatch (expected $expected, got $actual)" }
      }
    }
    if ($installedVersion) {
      Write-RealmLog "upgrading embedded PostgreSQL $installedVersion -> $pgArtVersion"
      & node (Join-Path $AppDir 'scripts/embedded-pg.mjs') upgrade --artifact $pgTmp
      if ($LASTEXITCODE -ne 0) { throw 'embedded PostgreSQL upgrade failed (rolled back)' }
    } else {
      Write-RealmLog 'installing embedded PostgreSQL 17 + pgvector (user directory)'
      & node (Join-Path $AppDir 'scripts/embedded-pg.mjs') install --artifact $pgTmp
      if ($LASTEXITCODE -ne 0) { throw 'embedded PostgreSQL install failed' }
    }
    if ($PgArtifact -like 'http*') { Remove-Item -Force $pgTmp -ErrorAction SilentlyContinue }
  }
}

# --- 5. Hand off to the interactive web bootstrap --------------------------------
if ($env:REALM_INSTALL_SKIP_SETUP -eq '1') {
  Write-RealmLog 'REALM_INSTALL_SKIP_SETUP=1 -> stopping before setup-web'
  exit 0
}
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $AppDir 'scripts/setup-web.ps1') @($args)
exit $LASTEXITCODE
