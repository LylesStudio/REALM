# pgvector MSVC 编译（windows-latest only；不接受第三方二进制）。
# 用法：powershell -File installer/windows/build-pgvector.ps1 -WorkDir <dir>
param(
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [string]$PgRoot
)

$ErrorActionPreference = "Stop"
$inventory = Get-Content (Join-Path $PSScriptRoot "inventory.json") | ConvertFrom-Json
$vector = $inventory.pgvector
if (-not $PgRoot) { $PgRoot = Join-Path $WorkDir "pgsql" }

$cloneDir = Join-Path $WorkDir "pgvector-src"
if (Test-Path $cloneDir) { Remove-Item -Recurse -Force $cloneDir }
git clone --depth 1 --branch $vector.tag $vector.repository $cloneDir
$head = (git -C $cloneDir rev-parse HEAD).Trim()
if ($head -ne $vector.commit) {
  throw "pgvector commit mismatch: expected $($vector.commit), got $head"
}

# MSVC 环境（windows-latest 预装 Visual Studio）。
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsPath = & $vswhere -latest -property installationPath
$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found at $vcvars" }

Push-Location $cloneDir
cmd /c "call `"$vcvars`" && nmake /F Makefile.win PGROOT=`"$PgRoot`""
if ($LASTEXITCODE -ne 0) { throw "nmake failed with exit $LASTEXITCODE" }

$outDir = Join-Path $WorkDir "vector"
New-Item -ItemType Directory -Force -Path (Join-Path $outDir "extension") | Out-Null
Copy-Item (Join-Path $cloneDir "vector.dll") (Join-Path $outDir "vector.dll")
Copy-Item (Join-Path $cloneDir "sql\*.sql") (Join-Path $outDir "extension")
Copy-Item (Join-Path $cloneDir "vector.control") (Join-Path $outDir "extension")
Pop-Location

if (-not (Test-Path (Join-Path $outDir "vector.dll"))) { throw "vector.dll not produced" }
Write-Host "pgvector $($vector.tag) built at $outDir"
