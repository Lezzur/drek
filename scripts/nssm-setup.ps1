# Run this script as Administrator to install/reinstall the DREK service.
# Usage: Right-click PowerShell -> Run as Administrator, then:
#   cd F:\claude-code\claude_projects\drek
#   .\scripts\nssm-setup.ps1
#
# Prereq: nssm.exe on PATH, node + npm installed, `npm install` already run.
# DREK is served as `dist/index.js` after `npm run build` — production mode.
# For dev iteration, run `npm run dev` interactively instead of via the service.

$NodeExe = "F:\Program Files\nodejs\node.exe"
$Root    = "F:\claude-code\claude_projects\drek"
$LogsDir = "$Root\logs"

# Ensure logs directory exists
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

# --- DREK (planner + scene cards UI on port 3003) -----------------------------

$svc = "DREK"

$existing = Get-Service -Name $svc -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping and removing existing $svc service..."
    nssm stop $svc
    nssm remove $svc confirm
}

Write-Host "Installing $svc..."
nssm install $svc $NodeExe
nssm set $svc AppParameters         "dist/index.js"
nssm set $svc AppDirectory          $Root
nssm set $svc AppEnvironmentExtra   "NODE_ENV=production`nUSERPROFILE=C:\Users\Ruzzel`nHOMEDRIVE=C:`nHOMEPATH=\Users\Ruzzel"
nssm set $svc AppStdout             "$LogsDir\service.log"
nssm set $svc AppStderr             "$LogsDir\error.log"
nssm set $svc AppRotateFiles        1
nssm set $svc AppRotateBytes        10485760
nssm set $svc AppRestartDelay       5000
nssm set $svc AppStopMethodSkip     6
nssm set $svc AppStopMethodConsole  3000
nssm set $svc AppStopMethodWindow   3000
nssm set $svc AppStopMethodThreads  3000

# --- Start --------------------------------------------------------------------

Write-Host "Starting $svc..."
nssm start $svc

Start-Sleep -Seconds 5

Write-Host ""
Write-Host "Service status:"
nssm status $svc

Write-Host ""
Write-Host "Testing /healthz..."
$response = $null
try {
    $response = Invoke-WebRequest -Uri "http://localhost:3003/healthz" -UseBasicParsing -TimeoutSec 5
} catch {
    $response = $null
}

if ($response -and $response.StatusCode -eq 200) {
    Write-Host "DREK OK - HTTP $($response.StatusCode)"
} elseif ($response) {
    Write-Host "DREK responded HTTP $($response.StatusCode) - check logs\service.log (Firestore creds?)"
} else {
    Write-Host "DREK not responding yet - check logs\service.log"
}
