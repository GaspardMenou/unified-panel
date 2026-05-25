@echo off
REM Stoppe Unified Panel (tue les process node server.js du dossier).
taskkill /f /im node.exe 2>nul
echo Unified Panel arrete.
