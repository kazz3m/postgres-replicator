@echo off
cd /d "%~dp0backend"
call "%~dp0.venv\Scripts\activate.bat"
set CONFIG_PATH=%~dp0data\config.json
set PROFILES_PATH=%~dp0data\profiles.json
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
