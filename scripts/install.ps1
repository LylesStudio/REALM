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
  [switch]$NoStart,
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

# Windows players rarely have a local PostgreSQL; default to embedded PG.
if (-not $PgArtifact -and -not $EmbeddedPg) {
  $EmbeddedPg = $true
  Write-RealmLog 'Windows: defaulting to embedded PostgreSQL 17 + pgvector'
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

function Resolve-NpmCommand {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    $nodePath = if ($nodeCommand.Source) { $nodeCommand.Source } else { $nodeCommand.Path }
    $candidate = Join-Path (Split-Path -Parent $nodePath) 'npm.cmd'
    if (Test-Path $candidate) { return $candidate }
  }
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($npmCommand) {
    if ($npmCommand.Source) { return $npmCommand.Source }
    return $npmCommand.Path
  }
  throw 'npm.cmd is missing next to node; install Node.js 22.13+ properly'
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

$NpmCommand = Resolve-NpmCommand

# --- 2. Source ------------------------------------------------------------------
if (-not $SourceUrl) {
  # When invoked via iex, $MyInvocation.MyCommand.Path is $null (no file path).
  # Only a file-based invocation can infer origin from local git context.
  $scriptPath = $MyInvocation.MyCommand.Path
  if ($scriptPath) {
    $gitRoot = Split-Path -Parent (Split-Path -Parent $scriptPath)
    if (Test-Path (Join-Path $gitRoot '.git')) {
      try { $SourceUrl = (& git -C $gitRoot remote get-url origin).Trim() } catch { $SourceUrl = $null }
    }
  }
}
if (-not $SourceUrl) { $SourceUrl = 'https://github.com/Silver-Aurora/REALM.git' }

if (Test-Path (Join-Path $AppDir '.git')) {
  Write-RealmLog "updating existing clone at $AppDir ($Ref)"
  & git -C $AppDir fetch --depth 1 origin $Ref | Out-Host
  & git -C $AppDir checkout -q FETCH_HEAD | Out-Host
} elseif ((Test-Path $AppDir) -and (Test-Path (Join-Path $AppDir 'package.json'))) {
  # codeload fallback installs have no .git. Refresh them instead of freezing
  # forever at the first downloaded version. Local config/data is preserved.
  if ($SourceUrl -match '^https://github\.com/([^/]+/[^/]+?)(\.git)?$') {
    $slug = $Matches[1]
    $zipUrl = "https://codeload.github.com/$slug/zip/refs/heads/$Ref"
    $sourceTmp = Join-Path ([IO.Path]::GetTempPath()) ("realm-src-refresh-" + [Guid]::NewGuid().ToString('N'))
    $zipTmp = Join-Path $sourceTmp 'source.zip'
    $extractTmp = Join-Path $sourceTmp 'extract'
    $preserveTmp = Join-Path $sourceTmp 'preserve'
    try {
      New-Item -ItemType Directory -Force -Path $extractTmp, $preserveTmp | Out-Null
      Write-RealmLog "refreshing existing non-git source from $zipUrl (max 5 min)"
      Invoke-WebRequest -UseBasicParsing -Uri $zipUrl -OutFile $zipTmp -TimeoutSec 300
      Expand-Archive -Force -Path $zipTmp -DestinationPath $extractTmp
      $sourceDir = Get-ChildItem -Path $extractTmp -Directory -Force | Select-Object -First 1
      if (-not $sourceDir -or -not (Test-Path (Join-Path $sourceDir.FullName 'package.json'))) {
        throw 'downloaded source archive has no package.json'
      }
      foreach ($preserve in @('.env.local', '.env.owner.local', '.local')) {
        $sourcePath = Join-Path $AppDir $preserve
        if (Test-Path $sourcePath) {
          Move-Item -Force -Path $sourcePath -Destination $preserveTmp
        }
      }
      Get-ChildItem -Path $AppDir -Force | Remove-Item -Recurse -Force
      Get-ChildItem -Path $sourceDir.FullName -Force | Copy-Item -Destination $AppDir -Recurse -Force
      foreach ($preserve in @('.env.local', '.env.owner.local', '.local')) {
        $preservedPath = Join-Path $preserveTmp $preserve
        if (Test-Path $preservedPath) {
          Move-Item -Force -Path $preservedPath -Destination $AppDir
        }
      }
    } finally {
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $sourceTmp
    }
  } else {
    Write-RealmLog "using existing source at $AppDir (custom non-git source; skipping refresh)"
  }
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
# Older installers may leave a corrupted local npm in node_modules. npm ci cannot
# delete its own directory while running, so remove it explicitly first.
$nodeModules = Join-Path $AppDir 'node_modules'
if (Test-Path $nodeModules) {
  Write-RealmLog 'cleaning stale node_modules before npm ci'
  Remove-Item -Recurse -Force $nodeModules
}
Write-RealmLog 'installing npm dependencies (ci); this may take a few minutes'
Push-Location $AppDir
try {
  & $NpmCommand ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
} finally {
  Pop-Location
}

# --- 4. Embedded PostgreSQL (-EmbeddedPg auto / -PgArtifact explicit) ------------
# Re-running the same installer performs a full upgrade: source fetch (above) +
# artifact version comparison below.
$pgShaUrl = $null
$pgArtVersion = $env:REALM_PG_VERSION
if ($EmbeddedPg -and -not $PgArtifact) {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($arch -ne 'AMD64') {
    throw "-EmbeddedPg: no prebuilt artifact for Windows/$arch (available: windows-x64; use a local PostgreSQL 17 + pgvector or Docker on ARM64)"
  }
  # Target version: explicit REALM_PG_VERSION > latest embedded-pg-* tag from releases.
  # releases/latest may be a code release vX.Y.Z, so do not rely on it for pg- prefixes.
  if (-not $pgArtVersion) {
    try {
      $releases = Invoke-RestMethod -TimeoutSec 15 -Uri 'https://api.github.com/repos/Silver-Aurora/REALM/releases?per_page=30' -Headers @{ 'User-Agent' = 'realm-installer' }
      $pgRelease = $releases | Where-Object { $_.tag_name -match '^embedded-pg-' } | Sort-Object { [DateTime]$_.created_at } -Descending | Select-Object -First 1
      if ($pgRelease -and $pgRelease.tag_name -match '^embedded-pg-(.+)$') { $pgArtVersion = $Matches[1] }
    } catch { }
    if (-not $pgArtVersion) { $pgArtVersion = '17.10' }
  }
  $pgBase = if ($env:REALM_PG_RELEASE_BASE) { $env:REALM_PG_RELEASE_BASE } else { "https://github.com/Silver-Aurora/REALM/releases/download/embedded-pg-$pgArtVersion" }
  $PgArtifact = "$pgBase/realm-embedded-pg-windows-x64-$pgArtVersion.tar.gz"
  $pgShaUrl = "$pgBase/sha256sums.txt"
  Write-RealmLog "embedded PostgreSQL artifact: $PgArtifact"
}

if ($PgArtifact) {
  # Probe the install directory before invoking version: when not installed the
  # command writes to stderr, and $ErrorActionPreference='Stop' would turn that
  # into a terminating error.
  $pgRoot = Join-Path $env:USERPROFILE '.local\realm-pgsql'
  $installedBin = Get-ChildItem -Path $pgRoot -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'bin' } |
    Where-Object { Test-Path (Join-Path $_ 'postgres.exe') } |
    Select-Object -First 1
  $installedVersion = $null
  if ($installedBin) {
    # Stop semantics promote native stderr to NativeCommandError. Probing must be
    # catchable; any failure is treated as "not installed / broken" and handled
    # by the install path below.
    try {
      $versionOut = (& node (Join-Path $AppDir 'scripts/embedded-pg.mjs') version 2>$null)
      if ($LASTEXITCODE -eq 0 -and $versionOut -match '(\d+\.\d+)') { $installedVersion = $Matches[1] }
    } catch {
      $installedVersion = $null
    }
  }
  # shim health check: an installed artifact of the same version may come from an
  # old build (e.g. 17.10 before the shim fix). pg_config --sharedir must exit 0
  # with non-empty output, otherwise treat as needing a reinstall (upgrade path).
  $pgHealthy = $false
  $pgRequiredBinaries = @('postgres.exe', 'initdb.exe', 'pg_ctl.exe', 'psql.exe', 'pg_isready.exe', 'pg_config.cmd')
  if ($installedVersion) {
    $pgConfigBin = Join-Path $installedBin 'pg_config.cmd'
    if (Test-Path $pgConfigBin) {
      try {
        $sharedir = (& $pgConfigBin --sharedir 2>$null)
        $pgHealthy = ($LASTEXITCODE -eq 0 -and $sharedir -match 'share')
      } catch {
        $pgHealthy = $false
      }
    }
    foreach ($bin in $pgRequiredBinaries) {
      if (-not (Test-Path (Join-Path $installedBin $bin))) { $pgHealthy = $false }
    }
  }
  $pgTargetDir = Join-Path (Join-Path $env:USERPROFILE '.local\realm-pgsql') $pgArtVersion
  $pgTargetIncomplete = (-not $installedVersion) -and (Test-Path $pgTargetDir) -and ((Get-ChildItem $pgTargetDir -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
  if ($installedVersion -and $pgHealthy -and $pgArtVersion -and $installedVersion -eq $pgArtVersion) {
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
      Write-RealmLog "downloading $PgArtifact (max 5 min)"
      Invoke-WebRequest -UseBasicParsing -Uri $PgArtifact -OutFile $pgTmp -TimeoutSec 300
      if ($pgShaUrl) {
        $sumsTmp = Join-Path ([IO.Path]::GetTempPath()) 'realm-pg-sha256sums.txt'
        Invoke-WebRequest -UseBasicParsing -Uri $pgShaUrl -OutFile $sumsTmp -TimeoutSec 60
        $expected = (Select-String -Path $sumsTmp -Pattern " $($PgArtifact.Split('/')[-1])`$").Line.Split(' ')[0]
        $actual = (Get-FileHash -Algorithm SHA256 $pgTmp).Hash.ToLowerInvariant()
        if ($expected -ne $actual) { throw "artifact checksum mismatch (expected $expected, got $actual)" }
      }
    }
    if ($installedVersion -or $pgTargetIncomplete) {
      Write-RealmLog "upgrading embedded PostgreSQL $(if ($installedVersion) { $installedVersion } else { 'incomplete' }) -> $pgArtVersion"
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

# --- 5. Create a user-discoverable launcher entry --------------------------------
if ($env:REALM_INSTALL_SKIP_SETUP -eq '1') {
  Write-RealmLog 'REALM_INSTALL_SKIP_SETUP=1 -> stopping before launcher entry creation'
  exit 0
}

$nodeBin = (Get-Command node.exe).Source
$batPath = Join-Path $RealmHome 'Launch REALM.bat'
$batContent = @"
@echo off
REM REALM service console (generated by installer): open the browser console to
REM view status, start/stop/restart, and logs. Closing this window stops local services.
REM Clean up leftover REALM service processes first to free ports.
powershell -WindowStyle Hidden -Command "Get-CimInstance Win32_Process | Where-Object { `$_.CommandLine -match 'realm-console\.mjs|realm-service-host\.mjs|vinext start|next start' } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }"
REM Clean up a stale lock file left by a crashed instance.
if exist "%LOCALAPPDATA%\REALM\realm.lock" del /f "%LOCALAPPDATA%\REALM\realm.lock"
cd /d "$($AppDir)"
"$($nodeBin)" launcher\realm-console.mjs
"@
Set-Content -Path $batPath -Value $batContent -Encoding UTF8
Write-RealmLog "created launcher entry: $batPath"

$startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcutPath = Join-Path $startMenuDir 'REALM.lnk'
try {
  $wsh = New-Object -ComObject WScript.Shell
  $shortcut = $wsh.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $batPath
  $shortcut.WorkingDirectory = $AppDir
  $shortcut.Description = 'REALM service console (status, start/stop, logs)'
  $shortcut.Save()
  Write-RealmLog "created Start Menu shortcut: $shortcutPath"
} catch {
  Write-RealmLog "could not create Start Menu shortcut: $_"
}

Write-RealmLog 'Install complete. Double-click "Launch REALM.bat" in the .realm folder or open REALM from the Start Menu.'

if ($NoStart -or $env:REALM_INSTALL_SKIP_START -eq '1') {
  Write-RealmLog 'REALM_INSTALL_SKIP_START=1 / -NoStart -> not starting the service console'
  exit 0
}

Write-RealmLog 'starting REALM service console...'
Start-Process -FilePath $batPath

Write-RealmLog 'Install complete. Double-click "Launch REALM.bat" in the .realm folder or open REALM from the Start Menu.'
