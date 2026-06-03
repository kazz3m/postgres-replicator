@echo off
setlocal EnableDelayedExpansion

:: ============================================================
::  PG Replication Manager — Windows local runner (no Docker)
::  Requirements: Python 3.10+, Node.js 18+
::  Usage: double-click or run from cmd/PowerShell in repo root
:: ============================================================

set "ROOT=%~dp0"
set "BACKEND_DIR=%ROOT%backend"
set "FRONTEND_DIR=%ROOT%frontend"
set "VENV_DIR=%ROOT%.venv"
set "DATA_DIR=%ROOT%data"
set "BACKEND_PORT=8000"
set "FRONTEND_PORT=3000"

:: ── Colour helpers ───────────────────────────────────────────
:: (uses ANSI — works in Windows Terminal and modern cmd)
set "C_RESET=[0m"
set "C_GREEN=[92m"
set "C_YELLOW=[93m"
set "C_RED=[91m"
set "C_BLUE=[94m"
set "C_BOLD=[1m"

echo.
echo %C_BLUE%%C_BOLD%  PG Replication Manager — local start%C_RESET%
echo  ─────────────────────────────────────────
echo.

:: ── 1. Check Python ─────────────────────────────────────────
where python >nul 2>&1
if errorlevel 1 (
    where python3 >nul 2>&1
    if errorlevel 1 (
        echo %C_RED%[ERROR]%C_RESET% Python not found. Install Python 3.10+ from https://python.org
        goto :fail
    )
    set "PYTHON=python3"
) else (
    set "PYTHON=python"
)

for /f "tokens=*" %%v in ('!PYTHON! --version 2^>^&1') do set "PY_VER=%%v"
echo %C_GREEN%[OK]%C_RESET%    !PY_VER!

:: ── 2. Check Node ────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo %C_RED%[ERROR]%C_RESET% Node.js not found. Install Node 18+ from https://nodejs.org
    goto :fail
)
for /f "tokens=*" %%v in ('node --version') do set "NODE_VER=%%v"
echo %C_GREEN%[OK]%C_RESET%    Node.js !NODE_VER!

:: ── 3. Create data directory ─────────────────────────────────
if not exist "%DATA_DIR%" (
    mkdir "%DATA_DIR%"
    echo %C_GREEN%[OK]%C_RESET%    Created data directory: %DATA_DIR%
) else (
    echo %C_GREEN%[OK]%C_RESET%    Data directory: %DATA_DIR%
)

:: ── 4. Python venv ───────────────────────────────────────────
if not exist "%VENV_DIR%\Scripts\activate.bat" (
    echo %C_YELLOW%[SETUP]%C_RESET% Creating Python virtual environment...
    !PYTHON! -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo %C_RED%[ERROR]%C_RESET% Failed to create venv.
        goto :fail
    )
    echo %C_GREEN%[OK]%C_RESET%    Virtual environment created.
)

:: ── 5. Install / upgrade Python deps ────────────────────────
echo %C_YELLOW%[SETUP]%C_RESET% Checking Python dependencies...
call "%VENV_DIR%\Scripts\activate.bat"
pip install -q -r "%BACKEND_DIR%\requirements.txt"
if errorlevel 1 (
    echo %C_RED%[ERROR]%C_RESET% pip install failed.
    goto :fail
)
echo %C_GREEN%[OK]%C_RESET%    Python dependencies ready.

:: ── 6. Install Node deps ─────────────────────────────────────
if not exist "%FRONTEND_DIR%\node_modules" (
    echo %C_YELLOW%[SETUP]%C_RESET% Installing Node dependencies (first run)...
    pushd "%FRONTEND_DIR%"
    npm install --silent
    if errorlevel 1 (
        echo %C_RED%[ERROR]%C_RESET% npm install failed.
        popd
        goto :fail
    )
    popd
    echo %C_GREEN%[OK]%C_RESET%    Node dependencies installed.
) else (
    echo %C_GREEN%[OK]%C_RESET%    Node dependencies already present.
)

:: ── 7. Launch backend in a new window ────────────────────────
echo.
echo %C_BLUE%[START]%C_RESET% Launching backend on http://localhost:%BACKEND_PORT% ...
set "CONFIG_PATH=%DATA_DIR%\config.json"
set "PROFILES_PATH=%DATA_DIR%\profiles.json"
start "PG-Sync Backend" cmd /k ^
    "cd /d "%BACKEND_DIR%" && call "%VENV_DIR%\Scripts\activate.bat" && ^
    set CONFIG_PATH=%CONFIG_PATH% && ^
    set PROFILES_PATH=%PROFILES_PATH% && ^
    uvicorn app.main:app --host 127.0.0.1 --port %BACKEND_PORT% --reload"

:: ── 8. Wait for backend to be ready ─────────────────────────
echo %C_YELLOW%[WAIT]%C_RESET%  Waiting for backend...
set /a TRIES=0
:wait_loop
    timeout /t 1 /nobreak >nul
    set /a TRIES+=1
    curl -sf http://localhost:%BACKEND_PORT%/health >nul 2>&1
    if not errorlevel 1 goto :backend_ready
    if !TRIES! geq 20 (
        echo %C_RED%[ERROR]%C_RESET% Backend did not start within 20 seconds.
        echo        Check the "PG-Sync Backend" window for errors.
        goto :fail
    )
    goto :wait_loop

:backend_ready
echo %C_GREEN%[OK]%C_RESET%    Backend ready.

:: ── 9. Launch frontend in a new window ───────────────────────
echo %C_BLUE%[START]%C_RESET% Launching frontend on http://localhost:%FRONTEND_PORT% ...
start "PG-Sync Frontend" cmd /k ^
    "cd /d "%FRONTEND_DIR%" && ^
    set VITE_BACKEND_URL=http://localhost:%BACKEND_PORT% && ^
    npm run dev -- --port %FRONTEND_PORT%"

:: ── 10. Open browser ─────────────────────────────────────────
timeout /t 3 /nobreak >nul
echo %C_BLUE%[INFO]%C_RESET%  Opening browser...
start http://localhost:%FRONTEND_PORT%

:: ── Done ─────────────────────────────────────────────────────
echo.
echo  ─────────────────────────────────────────
echo  %C_GREEN%%C_BOLD%App is running%C_RESET%
echo  Frontend : http://localhost:%FRONTEND_PORT%
echo  Backend  : http://localhost:%BACKEND_PORT%
echo  API docs : http://localhost:%BACKEND_PORT%/docs
echo  Data dir : %DATA_DIR%
echo.
echo  Both services run in separate windows.
echo  Close those windows (or press Ctrl+C in each) to stop.
echo  ─────────────────────────────────────────
echo.
pause
goto :eof

:fail
echo.
echo %C_RED%Startup failed. See error above.%C_RESET%
pause
exit /b 1
