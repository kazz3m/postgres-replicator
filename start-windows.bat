@echo off
setlocal EnableDelayedExpansion

:: ============================================================
::  PG Replication Manager - Windows local runner (no Docker)
::  Requirements: Python 3.10-3.12, Node.js 18+
::  Usage: double-click or run from cmd in repo root
:: ============================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "BACKEND_DIR=%ROOT%\backend"
set "FRONTEND_DIR=%ROOT%\frontend"
set "VENV_DIR=%ROOT%\.venv"
set "DATA_DIR=%ROOT%\data"
set "BACKEND_PORT=8000"
set "FRONTEND_PORT=3000"

echo.
echo   PG Replication Manager - local start
echo   =========================================
echo.

:: -- 1. Python ------------------------------------------------
set "PYTHON="
for %%C in (py python python3) do (
    if not defined PYTHON (
        for /f "tokens=2 delims= " %%V in ('%%C --version 2^>^&1') do (
            for /f "tokens=1,2 delims=." %%A in ("%%V") do (
                if "%%A"=="3" (
                    set /a MINOR=%%B
                    if !MINOR! GEQ 10 if !MINOR! LEQ 12 set "PYTHON=%%C"
                )
            )
        )
    )
)
if not defined PYTHON (
    echo   [ERROR] Python 3.10-3.12 not found.
    echo           Install from https://python.org
    echo           During install check "Add Python to PATH"
    goto :fail
)
for /f "tokens=*" %%V in ('%PYTHON% --version 2^>^&1') do echo   [OK]    %%V

:: -- 2. Node --------------------------------------------------
node --version >nul 2>&1
if errorlevel 1 (
    echo   [ERROR] Node.js not found. Install from https://nodejs.org
    goto :fail
)
for /f "tokens=*" %%V in ('node --version 2^>^&1') do echo   [OK]    Node.js %%V

:: -- 3. Data directory ----------------------------------------
if not exist "%DATA_DIR%\" (
    mkdir "%DATA_DIR%"
    echo   [OK]    Created data directory: %DATA_DIR%
) else (
    echo   [OK]    Data directory: %DATA_DIR%
)

:: -- 4. Check venv Python version -----------------------------
set "NEED_VENV=1"
if exist "%VENV_DIR%\Scripts\python.exe" (
    set "NEED_VENV=0"
    for /f "tokens=2 delims= " %%V in ('%VENV_DIR%\Scripts\python.exe --version 2^>^&1') do (
        for /f "tokens=1,2 delims=." %%A in ("%%V") do (
            if not "%%A"=="3" set "NEED_VENV=1"
        )
    )
    for /f "tokens=2 delims= " %%V in ('%PYTHON% --version 2^>^&1') do set "WANT_VER=%%V"
    for /f "tokens=2 delims= " %%V in ('%VENV_DIR%\Scripts\python.exe --version 2^>^&1') do set "HAVE_VER=%%V"
    if not "!WANT_VER!"=="!HAVE_VER!" (
        echo   [INFO]  Venv version mismatch - recreating...
        rmdir /s /q "%VENV_DIR%"
        set "NEED_VENV=1"
    )
)

:: -- 5. Create venv -------------------------------------------
if "!NEED_VENV!"=="1" (
    echo   [SETUP] Creating Python virtual environment...
    %PYTHON% -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo   [ERROR] Failed to create virtual environment.
        goto :fail
    )
    echo   [OK]    Virtual environment created.
) else (
    echo   [OK]    Virtual environment exists.
)

:: -- 6. Python deps -------------------------------------------
echo   [SETUP] Checking Python dependencies...
call "%VENV_DIR%\Scripts\activate.bat"
pip install -q -r "%BACKEND_DIR%\requirements.txt"
if errorlevel 1 (
    echo   [WARN]  pip failed - retrying with --trusted-host...
    pip install -q -r "%BACKEND_DIR%\requirements.txt" ^
        --trusted-host pypi.org ^
        --trusted-host files.pythonhosted.org ^
        --trusted-host pypi.python.org
    if errorlevel 1 (
        echo   [ERROR] pip install failed.
        goto :fail
    )
)
echo   [OK]    Python dependencies ready.

:: -- 7. Node deps ---------------------------------------------
if not exist "%FRONTEND_DIR%\node_modules\" (
    echo   [SETUP] Installing Node dependencies (first run)...
    pushd "%FRONTEND_DIR%"
    npm install --silent
    if errorlevel 1 (
        popd
        echo   [ERROR] npm install failed.
        goto :fail
    )
    popd
    echo   [OK]    Node dependencies installed.
) else (
    echo   [OK]    Node dependencies already present.
)

:: -- 8. Start backend -----------------------------------------
echo.
echo   [START] Backend  -> http://localhost:%BACKEND_PORT%

start "PG-Sync Backend" cmd /k "%ROOT%\run-backend.cmd"

:: -- 9. Wait for backend --------------------------------------
echo   [WAIT]  Waiting for backend...
set /a TRIES=0
:wait_loop
    timeout /t 1 /nobreak >nul
    set /a TRIES+=1
    curl -sf "http://localhost:%BACKEND_PORT%/health" >nul 2>&1
    if not errorlevel 1 goto :backend_ready
    if !TRIES! GEQ 30 (
        echo   [ERROR] Backend did not start within 30 seconds.
        echo           Check the backend window for errors.
        goto :fail
    )
    goto :wait_loop

:backend_ready
echo   [OK]    Backend ready.

:: -- 10. Start frontend ---------------------------------------
echo   [START] Frontend -> http://localhost:%FRONTEND_PORT%

start "PG-Sync Frontend" cmd /k "%ROOT%\run-frontend.cmd"

:: -- 11. Open browser -----------------------------------------
timeout /t 3 /nobreak >nul
start "" "http://localhost:%FRONTEND_PORT%"

:: -- Done -----------------------------------------------------
echo.
echo   =========================================
echo   App is running!
echo   Frontend : http://localhost:%FRONTEND_PORT%
echo   Backend  : http://localhost:%BACKEND_PORT%
echo   API docs : http://localhost:%BACKEND_PORT%/docs
echo   Data dir : %DATA_DIR%
echo   =========================================
echo.
echo   Both services run in separate windows.
echo   Close those windows to stop them.
echo.
pause
goto :eof

:fail
echo.
pause
exit /b 1
