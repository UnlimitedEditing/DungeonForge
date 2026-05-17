@echo off
setlocal enabledelayedexpansion

title DungeonForge Launcher

echo.
echo   +======================================+
echo   ^|      D U N G E O N  F O R G E       ^|
echo   +======================================+
echo.

:: Change to the folder containing this script
cd /d "%~dp0"

:: ── 1. Find Python 3.10+ ──────────────────────────────────────────────────────
echo   [*] Checking Python...

set "PYTHON="
for %%C in (python python3 python3.13 python3.12 python3.11 python3.10) do (
    if "!PYTHON!"=="" (
        where %%C >nul 2>&1
        if !errorlevel! == 0 (
            %%C -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
            if !errorlevel! == 0 set "PYTHON=%%C"
        )
    )
)

if "!PYTHON!"=="" (
    echo.
    echo   [!] Python 3.10+ not found.
    echo.

    :: Check if an old Python exists and show its version
    set "OLD_PY="
    for %%C in (python python3) do (
        if "!OLD_PY!"=="" (
            where %%C >nul 2>&1
            if !errorlevel! == 0 set "OLD_PY=%%C"
        )
    )
    if not "!OLD_PY!"=="" (
        for /f "tokens=*" %%V in ('!OLD_PY! -c "import sys; v=sys.version_info; print(str(v.major)+chr(46)+str(v.minor))" 2^>nul') do set "OLD_VER=%%V"
        echo   Found Python !OLD_VER! but DungeonForge requires 3.10 or newer.
        echo.
    )

    echo   Attempting automatic install via winget...
    echo.
    winget install --id Python.Python.3.12 --source winget ^
        --accept-package-agreements --accept-source-agreements --silent
    if !errorlevel! == 0 (
        echo.
        echo   [OK] Python installed!
        echo.
        echo   ACTION REQUIRED:
        echo   Close this window and reopen it so Windows can find Python,
        echo   then double-click launch.bat again.
        echo.
        pause
        exit /b 0
    )

    echo.
    echo   Automatic install failed. Please install Python manually:
    echo.
    echo   1. Visit: https://www.python.org/downloads/windows/
    echo   2. Download the latest Python 3.x installer
    echo   3. Run it and CHECK the box "Add Python to PATH"
    echo   4. Close this window and run launch.bat again
    echo.
    start https://www.python.org/downloads/windows/
    pause
    exit /b 1
)

for /f "tokens=*" %%V in ('!PYTHON! -c "import sys; v=sys.version_info; print(str(v.major)+chr(46)+str(v.minor)+chr(46)+str(v.micro))"') do set "PY_VER=%%V"
echo   [OK] Python !PY_VER!  ^(!PYTHON!^)

:: ── 2. Virtual environment ────────────────────────────────────────────────────
if not exist ".venv\" (
    echo   [*] Creating virtual environment...
    !PYTHON! -m venv .venv
    if !errorlevel! neq 0 (
        echo.
        echo   [X] Failed to create virtual environment.
        pause
        exit /b 1
    )
    echo   [OK] Virtual environment created
)

call ".venv\Scripts\activate.bat"
if !errorlevel! neq 0 (
    echo.
    echo   [X] Failed to activate virtual environment.
    pause
    exit /b 1
)
echo   [OK] Virtual environment active

:: ── 3. Install / verify dependencies ─────────────────────────────────────────
echo   [*] Checking dependencies...
python -c "import fastapi" >nul 2>&1
if !errorlevel! neq 0 (
    echo.
    echo   [!] Installing packages -- this takes a minute on first run.
    echo   [!] rembg will download a ~170 MB model the first time a prop is processed.
    echo.
    pip install --quiet --upgrade pip
    pip install --quiet -r requirements.txt
    if !errorlevel! neq 0 (
        echo.
        echo   [X] Dependency install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo.
    echo   [OK] Dependencies installed
) else (
    echo   [OK] Dependencies up to date
)

:: ── 4. API key (.env) ─────────────────────────────────────────────────────────
if not exist ".env" (
    echo.
    echo   ======================================================
    echo     First-time setup
    echo   ======================================================
    echo.
    echo   Your Graydient API key is needed to render sprites.
    echo   It will be saved to .env in this folder and never shared.
    echo.
    set /p "GRAYDIENT_KEY=  Paste your Graydient API key and press Enter: "

    if "!GRAYDIENT_KEY!"=="" (
        echo.
        echo   [X] No key entered. Create a .env file with:
        echo       GRAYDIENT_KEY=your-key-here
        pause
        exit /b 1
    )

    echo GRAYDIENT_KEY=!GRAYDIENT_KEY!> .env
    echo   [OK] .env created
) else (
    findstr /c:"GRAYDIENT_KEY" .env >nul 2>&1
    if !errorlevel! neq 0 (
        echo.
        echo   [X] .env found but GRAYDIENT_KEY is missing.
        echo       Add this line to .env:  GRAYDIENT_KEY=your-key-here
        pause
        exit /b 1
    )
    echo   [OK] .env found
)

:: ── 5. Port check ─────────────────────────────────────────────────────────────
set "PORT=8000"
set "URL=http://127.0.0.1:!PORT!"
set "SKIP_SERVER=0"

netstat -ano 2>nul | findstr ":!PORT! " >nul 2>&1
if !errorlevel! == 0 (
    echo   [!] Port !PORT! is already in use -- the Forge may already be running.
    set "SKIP_SERVER=1"
)

:: ── 6. Start forge.py in its own window ──────────────────────────────────────
if "!SKIP_SERVER!"=="0" (
    echo   [*] Starting DungeonForge server...
    start /d "%~dp0" "DungeonForge Server" cmd /k ".venv\Scripts\activate.bat && python forge.py"
    echo   [*] Server window opened  ^(close it to stop DungeonForge^)
    echo.
)

:: ── 7. Wait for server to respond ────────────────────────────────────────────
echo   [*] Waiting for server
set /a WAITED=0
set /a MAX_WAIT=60

:wait_loop
    :: Try curl (built-in on Windows 10 1803+)
    curl -sf "!URL!" -o nul 2>nul
    if !errorlevel! == 0 goto server_ready

    :: Fallback: PowerShell Invoke-WebRequest
    powershell -NoProfile -Command ^
        "try{Invoke-WebRequest -Uri '!URL!' -UseBasicParsing -TimeoutSec 1|Out-Null;exit 0}catch{exit 1}" ^
        >nul 2>&1
    if !errorlevel! == 0 goto server_ready

    if !WAITED! geq !MAX_WAIT! (
        echo.
        echo   [X] Server didn't respond within !MAX_WAIT! seconds.
        echo       Check the "DungeonForge Server" window for error messages.
        echo       You can also try running: python forge.py
        pause
        exit /b 1
    )

    set /p "DOT=." <nul
    timeout /t 1 /nobreak >nul
    set /a WAITED+=1
goto wait_loop

:server_ready
echo.
echo   [OK] Server ready -- !URL!

:: ── 8. Open browser ───────────────────────────────────────────────────────────
echo   [*] Opening browser...
start !URL!
echo   [OK] Browser opened

:: ── 9. Done ───────────────────────────────────────────────────────────────────
echo.
echo   +======================================+
echo   ^|      DungeonForge is running!        ^|
echo   ^|                                      ^|
echo   ^|  Close the "DungeonForge Server"     ^|
echo   ^|  window to stop the server.          ^|
echo   +======================================+
echo.
pause
