$ErrorActionPreference = 'Stop'
$autoYes = $args -contains '--yes'

function Test-Node22 {
  try {
    $version = (& node -p 'process.versions.node').Trim()
    $parts = $version.Split('.') | ForEach-Object { [int]$_ }
    return ($parts[0] -gt 22) -or (($parts[0] -eq 22) -and ($parts[1] -ge 13))
  } catch {
    return $false
  }
}

if (-not (Test-Node22)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'Node.js 22.13+ is required. Install Node.js or winget, then rerun this script.'
  }
  if (-not $autoYes) {
    $answer = Read-Host 'Node.js 22.13+ is missing. Install Node.js LTS with winget? [y/N]'
    if ($answer -notmatch '^(?i:y(es)?)$') { exit 1 }
  }
  winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
  Write-Host 'Node.js was installed. Open a new PowerShell session and rerun this script.'
  exit 0
}

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
& node (Join-Path $root 'scripts/setup-web.mjs') @args
exit $LASTEXITCODE
