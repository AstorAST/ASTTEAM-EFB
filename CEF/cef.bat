@echo off
title C919X EFB Browser Stream
cd /d "%~dp0"

set "CEF_EXE=cef_binary\Release\cefclient.exe"

if not exist "%CEF_EXE%" (
    echo [ERROR] cefclient.exe not found
    pause
    exit /b 1
)

echo ========================================
echo   C919X EFB Browser
echo ========================================
echo.

echo [1/4] Setting up CEF profile...

set "PROFILE_DIR=%USERPROFILE%\.astteamefb\cef_profile"
if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

set "CEF_CACHE=%PROFILE_DIR%\Cache"
if not exist "%CEF_CACHE%" mkdir "%CEF_CACHE%"

echo   Profile: %PROFILE_DIR%

echo.
echo [2/4] Starting CEF browser...

set "EFB_BROWSER_FRAME_MS=16"
set "EFB_BROWSER_JPEG_QUALITY=60"

set CEF_ARGS=--url=https://www.bilibili.com
set CEF_ARGS=%CEF_ARGS% --remote-debugging-port=9222
set CEF_ARGS=%CEF_ARGS% --remote-allow-origins=*
set CEF_ARGS=%CEF_ARGS% --no-sandbox
set CEF_ARGS=%CEF_ARGS% --enable-gpu
set CEF_ARGS=%CEF_ARGS% --enable-accelerated-2d-canvas
set CEF_ARGS=%CEF_ARGS% --enable-accelerated-video-decode
set CEF_ARGS=%CEF_ARGS% --disable-frame-rate-limit
set CEF_ARGS=%CEF_ARGS% --disable-background-timer-throttling
set CEF_ARGS=%CEF_ARGS% --disable-backgrounding-occluded-windows
set CEF_ARGS=%CEF_ARGS% --disable-renderer-backgrounding
set CEF_ARGS=%CEF_ARGS% --disable-ipc-flooding-protection
set CEF_ARGS=%CEF_ARGS% --disable-context-menu
set CEF_ARGS=%CEF_ARGS% --disable-default-apps
set CEF_ARGS=%CEF_ARGS% --disable-extensions
set CEF_ARGS=%CEF_ARGS% --disable-smooth-scrolling
set CEF_ARGS=%CEF_ARGS% --force-paint
set CEF_ARGS=%CEF_ARGS% --enable-begin-frame-scheduling
set CEF_ARGS=%CEF_ARGS% --disable-throttle-iframe
set CEF_ARGS=%CEF_ARGS% --autoplay-policy=no-user-gesture-required
set CEF_ARGS=%CEF_ARGS% --disable-background-networking
set CEF_ARGS=%CEF_ARGS% --disable-backgrounding-occluded-pages
set CEF_ARGS=%CEF_ARGS% --disable-best-effort-tasks
set CEF_ARGS=%CEF_ARGS% --disable-component-update
set CEF_ARGS=%CEF_ARGS% --disable-domain-reliability
set CEF_ARGS=%CEF_ARGS% --disable-speech-api
set CEF_ARGS=%CEF_ARGS% --disable-file-system
set CEF_ARGS=%CEF_ARGS% --disable-hang-monitor
set CEF_ARGS=%CEF_ARGS% --disable-prompt-on-repost
set CEF_ARGS=%CEF_ARGS% --disable-sync
set CEF_ARGS=%CEF_ARGS% --disable-web-security
set CEF_ARGS=%CEF_ARGS% --high-dpi-support=1
set CEF_ARGS=%CEF_ARGS% --force-device-scale-factor=1
set CEF_ARGS=%CEF_ARGS% --disk-cache-dir="%CEF_CACHE%"
set CEF_ARGS=%CEF_ARGS% --disk-cache-size=524288000
set CEF_ARGS=%CEF_ARGS% --user-data-dir="%PROFILE_DIR%"
set CEF_ARGS=%CEF_ARGS% --disable-blink-features=AutomationControlled
set CEF_ARGS=%CEF_ARGS% --disable-features=ChromeWhatsNewUI,OptimizationGuideModelDownloading,SitePerProcess
set CEF_ARGS=%CEF_ARGS% --disable-site-isolation-trials

start "" "%CEF_EXE%" %CEF_ARGS%

timeout /t 3 /nobreak >nul

echo.
echo [3/4] Checking Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo [4/4] Starting WebSocket server...
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)

start "EFB Browser Stream" cmd /c "node ws-server.js"

timeout /t 2 /nobreak >nul

echo.
echo ========================================
echo   CEF + EFB Stream Started
echo ========================================
echo.
echo   Stream: http://localhost:2333
echo   Profile: %PROFILE_DIR%
echo   Press any key to stop...
echo ========================================

pause >nul

taskkill /f /im cefclient.exe >nul 2>&1
taskkill /f /im node.exe >nul 2>&1
exit /b 0