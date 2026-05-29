@echo off
title Netwatch Player
echo.
echo  Starting Netwatch Stream Proxy...
echo.

:: Check if Node.js is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found. Install from https://nodejs.org
    echo  The player will still work for streams that don't need a referer.
    pause
    goto :open_player
)

:: Start proxy in background
start "Netwatch Proxy" /min cmd /c "node "%~dp0proxy.js""
timeout /t 1 /nobreak >nul

echo  Proxy started on http://127.0.0.1:9999
echo.

:open_player
echo  Open the Player folder in VS Code and use Live Server,
echo  OR run:  python -m http.server 8080
echo  Then open: http://localhost:8080
echo.
echo  Press any key to exit...
pause >nul
