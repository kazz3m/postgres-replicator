@echo off
cd /d "%~dp0backend"
call "%~dp0.venv\Scripts\activate.bat"
set CONFIG_PATH=%~dp0data\config.json
set PROFILES_PATH=%~dp0data\profiles.json
set SECRET_KEY_PATH=%~dp0data\secret.key

:: Enable ANSI/VT100 for this process via Win32 API (no registry change needed)
python -c "import ctypes,sys; k=ctypes.windll.kernel32; k.SetConsoleMode(k.GetStdHandle(-11), 7)" 2>nul

uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
