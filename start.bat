@echo off
REM Lanceur Windows pour Unified Panel.

cd /d "%~dp0"

if exist .env (
    for /f "tokens=1,2 delims==" %%a in (.env) do (
        set "%%a=%%b"
    )
)

if "%PORT%"=="" set PORT=3020
if "%TIKTOK_URL%"=="" set TIKTOK_URL=http://localhost:3010
if "%YOUTUBE_URL%"=="" set YOUTUBE_URL=http://localhost:3000

echo.
echo === Unified Panel — Lanceur Windows ===
echo Port              : %PORT%
echo TikTok backend    : %TIKTOK_URL%
echo YouTube backend   : %YOUTUBE_URL%
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Node.js n'est pas installe.
    echo          Telecharge le LTS sur https://nodejs.org/
    pause
    exit /b 1
)

if not exist node_modules (
    echo Premiere execution : installation des dependances...
    call npm install
)

start "Unified Panel" cmd /k "npm start"
timeout /t 3 /nobreak >nul
start "" "http://localhost:%PORT%"
