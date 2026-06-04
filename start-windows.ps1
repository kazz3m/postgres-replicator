#Requires -Version 5.1
<#
.SYNOPSIS
    Starts PG Replication Manager locally on Windows (no Docker).
.NOTES
    Requirements: Python 3.10+, Node.js 18+
    Run via: powershell -ExecutionPolicy Bypass -File .\start-windows.ps1
    Or:      double-click start.bat
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root         = $PSScriptRoot
$BackendDir   = Join-Path $Root 'backend'
$FrontendDir  = Join-Path $Root 'frontend'
$VenvDir      = Join-Path $Root '.venv'
$DataDir      = Join-Path $Root 'data'
$BackendPort  = 8000
$FrontendPort = 3000

function Write-Step { param([string]$msg, [string]$col = 'Cyan')   Write-Host "  $msg" -ForegroundColor $col }
function Write-Ok   { param([string]$msg) Write-Host "  [OK]    $msg" -ForegroundColor Green }
function Write-Fail { param([string]$msg) Write-Host "  [ERROR] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  PG Replication Manager - local start" -ForegroundColor Blue
Write-Host "  ========================================="
Write-Host ""

# -- 1. Python ------------------------------------------------
$python = $null
foreach ($candidate in @('py', 'python', 'python3')) {
    try {
        $verOutput = & $candidate --version 2>&1
        $verStr = "$verOutput"   # coerce to string in case it's an object
        if ($verStr -match 'Python 3\.(\d+)') {
            $minor = [int]$Matches[1]
            if ($minor -ge 10) {
                $python = $candidate
                break
            }
        }
    } catch {}
}
if (-not $python) {
    Write-Fail "Python 3.10+ not found."
    Write-Host "    Install from https://python.org (check 'Add to PATH' during install)" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Ok "$( & $python --version 2>&1 )"

# -- 2. Node --------------------------------------------------
try {
    $nodeVer = "$(node --version 2>&1)"
    Write-Ok "Node.js $nodeVer"
} catch {
    Write-Fail "Node.js not found."
    Write-Host "    Install from https://nodejs.org" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# -- 3. Data directory ----------------------------------------
if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir | Out-Null
    Write-Ok "Created data directory: $DataDir"
} else {
    Write-Ok "Data directory: $DataDir"
}

# -- 4. Python venv -------------------------------------------
$activatePs1 = Join-Path $VenvDir 'Scripts\Activate.ps1'
$activateBat = Join-Path $VenvDir 'Scripts\activate.bat'
if (-not (Test-Path $activatePs1)) {
    Write-Step "Creating Python virtual environment..."
    & $python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to create venv."; exit 1 }
    Write-Ok "Virtual environment created."
} else {
    Write-Ok "Virtual environment exists."
}

# -- 5. Python deps -------------------------------------------
Write-Step "Checking Python dependencies..."
& $activatePs1
pip install -q -r (Join-Path $BackendDir 'requirements.txt')
if ($LASTEXITCODE -ne 0) { Write-Fail "pip install failed."; exit 1 }
Write-Ok "Python dependencies ready."

# -- 6. Node deps ---------------------------------------------
$nmDir = Join-Path $FrontendDir 'node_modules'
if (-not (Test-Path $nmDir)) {
    Write-Step "Installing Node dependencies (first run, may take a minute)..."
    Push-Location $FrontendDir
    npm install --silent
    $npmExit = $LASTEXITCODE
    Pop-Location
    if ($npmExit -ne 0) { Write-Fail "npm install failed."; exit 1 }
    Write-Ok "Node dependencies installed."
} else {
    Write-Ok "Node dependencies already present."
}

# -- 7. Start backend -----------------------------------------
Write-Host ""
Write-Step "Starting backend  ->  http://localhost:$BackendPort" 'Blue'

$configPath   = Join-Path $DataDir 'config.json'
$profilesPath = Join-Path $DataDir 'profiles.json'

$backendCmd = "cd /d `"$BackendDir`" && " +
              "call `"$activateBat`" && " +
              "set CONFIG_PATH=$configPath && " +
              "set PROFILES_PATH=$profilesPath && " +
              "uvicorn app.main:app --host 127.0.0.1 --port $BackendPort --reload"

$backendProc = Start-Process -PassThru -FilePath 'cmd.exe' `
    -ArgumentList '/k', $backendCmd `
    -WindowStyle Normal

# -- 8. Wait for backend --------------------------------------
Write-Step "Waiting for backend to start..."
$tries = 0; $ready = $false
do {
    Start-Sleep -Seconds 1
    $tries++
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$BackendPort/health" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ready = $true }
    } catch {}
} while (-not $ready -and $tries -lt 30)

if (-not $ready) {
    Write-Fail "Backend did not start within 30 seconds."
    Write-Host "    Check the backend window for error details." -ForegroundColor Yellow
    Stop-Process -Id $backendProc.Id -Force -ErrorAction SilentlyContinue
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Ok "Backend ready."

# -- 9. Start frontend -----------------------------------------
Write-Step "Starting frontend ->  http://localhost:$FrontendPort" 'Blue'

$frontendCmd = "cd /d `"$FrontendDir`" && " +
               "set VITE_BACKEND_URL=http://localhost:$BackendPort && " +
               "npm run dev -- --port $FrontendPort"

$frontendProc = Start-Process -PassThru -FilePath 'cmd.exe' `
    -ArgumentList '/k', $frontendCmd `
    -WindowStyle Normal

# -- 10. Open browser -----------------------------------------
Start-Sleep -Seconds 3
Start-Process "http://localhost:$FrontendPort"

# -- Summary --------------------------------------------------
Write-Host ""
Write-Host "  ========================================="
Write-Host "  App is running!" -ForegroundColor Green
Write-Host "  Frontend : http://localhost:$FrontendPort"
Write-Host "  Backend  : http://localhost:$BackendPort"
Write-Host "  API docs : http://localhost:$BackendPort/docs"
Write-Host "  Data dir : $DataDir"
Write-Host "  ========================================="
Write-Host ""
Write-Host "  Both services run in separate cmd windows." -ForegroundColor Yellow
Write-Host "  Press Enter HERE to stop both and exit." -ForegroundColor Yellow
Write-Host ""

try {
    Read-Host "Press Enter to stop"
} finally {
    Write-Step "Stopping services..."
    foreach ($proc in @($backendProc, $frontendProc)) {
        if ($null -ne $proc -and -not $proc.HasExited) {
            taskkill /PID $proc.Id /T /F 2>$null | Out-Null
        }
    }
    Write-Ok "All services stopped."
}
