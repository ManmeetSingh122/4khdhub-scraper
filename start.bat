@echo off
title 4KHDHub Automation
echo.
echo  Starting 4KHDHub Automation...
echo.

:: Use Brave for the resolver when it is installed. Configure trusted domains
:: for your own multi-domain flow before launching, for example:
:: set "DIRECT_RESOLVER_TRUSTED_DOMAINS=example.com,files.example.com,video-downloads.googleusercontent.com"
set "DIRECT_RESOLVER_USE_BRAVE=1"

:: Backend-only TMDB key. It is no longer sent in frontend JavaScript.
:: For hosting, set TMDB_API_KEY in the host environment instead of this file.
if "%TMDB_API_KEY%"=="" set "TMDB_API_KEY=e04a7390c63382a724d5a56b6b7139a8"

:: Optional local FFmpeg bundle. Required for selectable embedded MKV
:: audio/subtitle tracks because the browser cannot expose them directly.
if exist "%~dp0tools\ffmpeg\bin\ffmpeg.exe" (
    set "FFMPEG_PATH=%~dp0tools\ffmpeg\bin\ffmpeg.exe"
    set "FFPROBE_PATH=%~dp0tools\ffmpeg\bin\ffprobe.exe"
) else if exist "%~dp0..\tools\ffmpeg\bin\ffmpeg.exe" (
    set "FFMPEG_PATH=%~dp0..\tools\ffmpeg\bin\ffmpeg.exe"
    set "FFPROBE_PATH=%~dp0..\tools\ffmpeg\bin\ffprobe.exe"
)

:: Start Netwatch proxy (for referer-locked streams)
where node >nul 2>&1
if %errorlevel% equ 0 (
    start "Netwatch Proxy" /min cmd /c "node "%~dp0..\Player\proxy.js""
    timeout /t 1 /nobreak >nul
    echo  [OK] Netwatch proxy started on http://127.0.0.1:9999
) else (
    echo  [WARN] Node.js not found - proxy not started. Streams may need referer.
)

echo.
echo  Opening browser...
start "" http://localhost:5000/app/
echo.

:: Start Flask
python "%~dp0app.py"
pause
