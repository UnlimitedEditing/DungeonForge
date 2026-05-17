@echo off
setlocal enabledelayedexpansion

:: Find pythonw.exe (suppresses this console window entirely)
set PYW=

where pythonw >nul 2>&1
if %errorlevel% == 0 ( set PYW=pythonw & goto :run )

for /d %%d in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
    if exist "%%d\pythonw.exe" ( set PYW=%%d\pythonw.exe & goto :run )
)

:: Fall back to python.exe (console stays visible — still fine)
where python >nul 2>&1
if %errorlevel% == 0 ( set PYW=python & goto :run )

for /d %%d in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
    if exist "%%d\python.exe" ( set PYW=%%d\python.exe & goto :run )
)

echo Python not found. Download it from https://www.python.org/downloads/
echo Check "Add Python to PATH" during install, then try again.
pause
exit /b 1

:run
"%PYW%" "%~dp0launcher.py"
