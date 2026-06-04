@echo off
cd /d "%~dp0frontend"
set VITE_BACKEND_URL=http://localhost:8000
npm run dev -- --port 3000
