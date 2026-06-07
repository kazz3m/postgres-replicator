@echo off
:: Enable ANSI/VT100 colour codes in this CMD window (Windows 10+)
reg add HKCU\Console /v VirtualTerminalLevel /t REG_DWORD /d 1 /f >nul 2>&1

cd /d "%~dp0backend"
call "%~dp0.venv\Scripts\activate.bat"
set CONFIG_PATH=%~dp0data\config.json
set PROFILES_PATH=%~dp0data\profiles.json
set SECRET_KEY_PATH=%~dp0data\secret.key
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
