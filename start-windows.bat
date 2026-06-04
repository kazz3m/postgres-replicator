@echo off
setlocal EnableDelayedExpansion

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
echo   [DBG] step 1: finding python
set "PYTHON="
py --version >nul 2>&1
if not errorlevel 1 set "PYTHON=py"
if not defined PYTHON (
    python --version >nul 2>&1
    if not errorlevel 1 set "PYTHON=python"
)
if not defined PYTHON (
    echo   [ERROR] Python not found. Install from https://python.org
    goto :fail
)
for /f "tokens=*" %%V in ('%PYTHON% --version 2^>^&1') do echo   [OK]    %%V

:: -- 2. Node --------------------------------------------------
echo   [DBG] step 2: node
node --version >nul 2>&1
if errorlevel 1 (
    echo   [ERROR] Node.js not found. Install from https://nodejs.org
    goto :fail
)
for /f "tokens=*" %%V in ('node --version 2^>^&1') do echo   [OK]    Node.js %%V

:: -- 3. Data directory ----------------------------------------
echo   [DBG] step 3: data dir
if not exist "%DATA_DIR%\" mkdir "%DATA_DIR%"
echo   [OK]    Data directory: %DATA_DIR%

:: -- 4. Python venv -------------------------------------------
echo   [DBG] step 4: venv
if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo   [SETUP] Creating virtual environment...
    %PYTHON% -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo   [ERROR] venv failed.
        goto :fail
    )
    echo   [OK]    Virtual environment created.
) else (
    echo   [OK]    Virtual environment exists.
)

:: -- 5. Python deps -------------------------------------------
echo   [DBG] step 5: pip
call "%VENV_DIR%\Scripts\activate.bat"
echo   [DBG] step 5b: activated
pip install -q -r "%BACKEND_DIR%\requirements.txt"
if errorlevel 1 (
    echo   [WARN]  Retrying with --trusted-host...
    pip install -q -r "%BACKEND_DIR%\requirements.txt" --trusted-host pypi.org --trusted-host files.pythonhosted.org --trusted-host pypi.python.org
    if errorlevel 1 (
        echo   [ERROR] pip install failed.
        goto :fail
    )
)
echo   [OK]    Python dependencies ready.

:: -- 6. Node deps ---------------------------------------------
echo   [DBG] step 6: npm
if exist "%FRONTEND_DIR%\node_modules\" goto :npm_done
echo   [SETUP] Installing Node dependencies...
pushd "%FRONTEND_DIR%"
npm install --silent >"%DATA_DIR%\npm-install.log" 2>&1
set "NPM_EXIT=%errorlevel%"
popd
if %NPM_EXIT% NEQ 0 (
    echo   [ERROR] npm install failed. See %DATA_DIR%\npm-install.log
    goto :fail
)
echo   [OK]    Node dependencies installed.
:npm_done
if exist "%FRONTEND_DIR%\node_modules\" echo   [OK]    Node dependencies already present.

:: -- 7. Start backend -----------------------------------------
echo   [DBG] step 7: start backend
echo.
echo   [START] Backend  -> http://localhost:%BACKEND_PORT%
start "PG-Sync Backend" cmd /k "%ROOT%\run-backend.cmd"

:: -- 8. Wait for backend --------------------------------------
echo   [DBG] step 8: wait backend
echo   [WAIT]  Waiting for backend...
set /a TRIES=0
:wait_loop
timeout /t 1 /nobreak >nul
set /a TRIES+=1
curl -sf "http://localhost:%BACKEND_PORT%/health" >nul 2>&1
if not errorlevel 1 goto :backend_ready
if !TRIES! GEQ 30 (
    echo   [ERROR] Backend did not start in 30s. Check backend window.
    goto :fail
)
goto :wait_loop

:backend_ready
echo   [OK]    Backend ready.

:: -- 9. Start frontend ----------------------------------------
echo   [DBG] step 9: start frontend
start "PG-Sync Frontend" cmd /k "%ROOT%\run-frontend.cmd"

:: -- 10. Open browser -----------------------------------------
timeout /t 3 /nobreak >nul
start "" "http://localhost:%FRONTEND_PORT%"

echo.
echo   =========================================
echo   App is running!
echo   Frontend : http://localhost:%FRONTEND_PORT%
echo   Backend  : http://localhost:%BACKEND_PORT%
echo   API docs : http://localhost:%BACKEND_PORT%/docs
echo   =========================================
echo.
pause
goto :eof

:fail
echo.
pause
exit /b 1
