# DREK deploy -- pull, rebuild, restart, verify.
#
# Why this exists: DREK runs `node dist/index.js` under NSSM. A bare
# `git pull` + `nssm restart DREK` does NOT pick up source changes --
# the dist/ has to be rebuilt or the service keeps serving the old
# compiled JS. We've burned hours on that more than once. Three
# commands is two too many to remember; this is one.
#
# Usage (from anywhere):
#   F:\claude-code\claude_projects\drek\scripts\deploy.ps1
#
# Or with the repo as PWD:
#   .\scripts\deploy.ps1
#
# Flags:
#   -SkipPull       Skip git pull (use when iterating on local edits)
#   -SkipBuild      Skip npm run build (use when only restarting)
#   -SkipRestart    Skip nssm restart (use when only rebuilding)

param(
  [switch]$SkipPull,
  [switch]$SkipBuild,
  [switch]$SkipRestart
)

# Anchor to the repo root regardless of where the user invokes from.
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "DREK deploy" -ForegroundColor Cyan
Write-Host "Repo: $RepoRoot" -ForegroundColor DarkGray
Write-Host ""

if (-not $SkipPull) {
  Write-Host "[1/4] git pull" -ForegroundColor Yellow
  git pull
  if ($LASTEXITCODE -ne 0) {
    Write-Host "git pull failed -- resolve conflicts, then re-run." -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "[1/4] git pull   SKIPPED (--SkipPull)" -ForegroundColor DarkGray
}

if (-not $SkipBuild) {
  Write-Host ""
  Write-Host "[2/4] npm run build" -ForegroundColor Yellow
  npm run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host "npm run build failed -- fix errors, then re-run." -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "[2/4] npm run build   SKIPPED (--SkipBuild)" -ForegroundColor DarkGray
}

if (-not $SkipRestart) {
  Write-Host ""
  Write-Host "[3/4] nssm restart DREK" -ForegroundColor Yellow
  nssm stop DREK
  Start-Sleep -Seconds 2
  nssm start DREK
  Start-Sleep -Seconds 3
} else {
  Write-Host "[3/4] nssm restart DREK   SKIPPED (--SkipRestart)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "[4/4] Verifying /healthz" -ForegroundColor Yellow
try {
  $resp = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3003/healthz' -TimeoutSec 10
  if ($resp.StatusCode -eq 200) {
    Write-Host "OK  $($resp.StatusCode)  $($resp.Content)" -ForegroundColor Green
  } else {
    Write-Host "DEGRADED  $($resp.StatusCode)  $($resp.Content)" -ForegroundColor Yellow
  }
} catch {
  Write-Host "FAIL  $_" -ForegroundColor Red
  Write-Host "Service may still be starting. Re-check in 10s with:" -ForegroundColor DarkGray
  Write-Host "  Invoke-WebRequest http://localhost:3003/healthz | Select-Object StatusCode, Content" -ForegroundColor DarkGray
  exit 1
}

Write-Host ""
Write-Host "Done." -ForegroundColor Cyan
