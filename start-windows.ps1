#Requires -Version 5.1
<#
.SYNOPSIS
    Starts PG Replication Manager locally on Windows (no Docker).
.DESCRIPTION
    - Creates a Python venv and installs backend deps
    - Runs npm install if node_modules is missing
    - Starts backend (uvicorn) and frontend (vite dev) as background jobs
    - Opens the browser when both are ready
    - Ctrl+C cleanly stops both processes
.NOTES
    Requirements: Python 3.10+, Node.js 18+
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root        = $PSScriptRoot
$BackendDir  = Join-Path $Root 'backend'
$FrontendDir = Join-Path $Root 'frontend'
$VenvDir     = Join-Path $Root '.venv'
$DataDir     = Join-Path $Root 'data'
$BackendPort = 8000
$FrontendPort = 3000

function Write-Step([string]$msg, [string]$colour = 'Cyan') {
    Write-Host "  $msg" -ForegroundColor $colour
}
function Write-Ok([string]$msg)    { Write-Host "  [OK]    $msg" -ForegroundColor Green }
function Write-Warn([string]$msg)  { Write-Host "  [WARN]  $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg)  { Write-Host "  [ERROR] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  PG Replication Manager — local start" -ForegroundColor Blue
Write-Host "  ─────────────────────────────────────────"
Write-Host ""

# ── 1. Python ────────────────────────────────────────────────
$python = $null
foreach ($candidate in @('python', 'python3', 'py')) {
    try {
        $ver = & $candidate --version 2>&1
        if ($ver -match '3\.(1[0-9]|[2-9]\d)') {
            $python = $candidate; break
        }
    } catch {}
}
if (-not $python) {
    Write-Fail "Python 3.10+ not found. Install from https://python.org"
    Read-Host "Press Enter to exit"; exit 1
}
Write-Ok "$(& $python --version 2>&1)"

# ── 2. Node ──────────────────────────────────────────────────
try {
    $nodeVer = node --version 2>&1
    Write-Ok "Node.js $nodeVer"
} catch {
    Write-Fail "Node.js not found. Install from https://nodejs.org"
    Read-Host "Press Enter to exit"; exit 1
}

# ── 3. Data directory ────────────────────────────────────────
if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir | Out-Null
    Write-Ok "Created data directory: $DataDir"
} else {
    Write-Ok "Data directory: $DataDir"
}

# ── 4. Python venv ───────────────────────────────────────────
$activate = Join-Path $VenvDir 'Scripts\Activate.ps1'
if (-not (Test-Path $activate)) {
    Write-Step "Creating Python virtual environment..."
    & $python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { Write-Fail "venv creation failed"; exit 1 }
    Write-Ok "Virtual environment created."
}

# ── 5. Python deps ───────────────────────────────────────────
Write-Step "Checking Python dependencies..."
& $activate
pip install -q -r (Join-Path $BackendDir 'requirements.txt')
if ($LASTEXITCODE -ne 0) { Write-Fail "pip install failed"; exit 1 }
Write-Ok "Python dependencies ready."

# ── 6. Node deps ─────────────────────────────────────────────
$nmDir = Join-Path $FrontendDir 'node_modules'
if (-not (Test-Path $nmDir)) {
    Write-Step "Installing Node dependencies (first run)..."
    Push-Location $FrontendDir
    npm install --silent
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Fail "npm install failed"; exit 1 }
    Pop-Location
    Write-Ok "Node dependencies installed."
} else {
    Write-Ok "Node dependencies already present."
}

# ── 7. Start backend ─────────────────────────────────────────
Write-Host ""
Write-Step "Starting backend on http://localhost:$BackendPort ..." 'Blue'

$backendEnv = @{
    CONFIG_PATH   = Join-Path $DataDir 'config.json'
    PROFILES_PATH = Join-Path $DataDir 'profiles.json'
}

$backendProc = Start-Process -PassThru -FilePath 'cmd.exe' -ArgumentList @(
    '/k',
    "cd /d `"$BackendDir`" && " +
    "call `"$VenvDir\Scripts\activate.bat`" && " +
    "set CONFIG_PATH=$($backendEnv.CONFIG_PATH) && " +
    "set PROFILES_PATH=$($backendEnv.PROFILES_PATH) && " +
    "uvicorn app.main:app --host 127.0.0.1 --port $BackendPort --reload"
) -WindowStyle Normal

# ── 8. Wait for backend ──────────────────────────────────────
Write-Step "Waiting for backend..."
$tries = 0
$ready = $false
do {
    Start-Sleep -Seconds 1
    $tries++
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$BackendPort/health" -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $ready = $true }
    } catch {}
} while (-not $ready -and $tries -lt 20)

if (-not $ready) {
    Write-Fail "Backend did not start within 20 seconds. Check the backend window."
    $backendProc | Stop-Process -Force -ErrorAction SilentlyContinue
    Read-Host "Press Enter to exit"; exit 1
}
Write-Ok "Backend ready."

# ── 9. Start frontend ─────────────────────────────────────────
Write-Step "Starting frontend on http://localhost:$FrontendPort ..." 'Blue'

$frontendProc = Start-Process -PassThru -FilePath 'cmd.exe' -ArgumentList @(
    '/k',
    "cd /d `"$FrontendDir`" && " +
    "set VITE_BACKEND_URL=http://localhost:$BackendPort && " +
    "npm run dev -- --port $FrontendPort"
) -WindowStyle Normal

# ── 10. Open browser ─────────────────────────────────────────
Start-Sleep -Seconds 3
Write-Step "Opening browser..."
Start-Process "http://localhost:$FrontendPort"

# ── Summary ──────────────────────────────────────────────────
Write-Host ""
Write-Host "  ─────────────────────────────────────────"
Write-Host "  App is running" -ForegroundColor Green
Write-Host "  Frontend : http://localhost:$FrontendPort"
Write-Host "  Backend  : http://localhost:$BackendPort"
Write-Host "  API docs : http://localhost:$BackendPort/docs"
Write-Host "  Data dir : $DataDir"
Write-Host ""
Write-Host "  Both services run in separate windows."
Write-Host "  Close those windows to stop, or press Enter here to"
Write-Host "  stop both and exit." -ForegroundColor Yellow
Write-Host "  ─────────────────────────────────────────"
Write-Host ""

# Wait for user; clean up on exit
try {
    Read-Host "Press Enter to stop all services"
} finally {
    Write-Step "Stopping services..."
    foreach ($proc in @($backendProc, $frontendProc)) {
        if ($proc -and -not $proc.HasExited) {
            # Kill the cmd window and its children
            taskkill /PID $proc.Id /T /F 2>$null | Out-Null
        }
    }
    Write-Ok "Stopped."
}
