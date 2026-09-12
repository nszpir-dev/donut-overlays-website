@echo off
title Donut Overlays
cd /d "%~dp0"

echo.
echo   Donut Overlays - starting up
echo.

rem Double-clicking a zip opens a window that looks like a folder but is not.
rem Windows copies the files to a temporary place that gets wiped, and nothing
rem installed there survives. Catch it here rather than failing later with a
rem message nobody can act on.
echo %~dp0 | find /i "\AppData\Local\Temp\" >nul
if not errorlevel 1 goto insidezip
echo %~dp0 | find /i ".zip" >nul
if not errorlevel 1 goto insidezip
goto findnode

:insidezip
echo   You are running this from inside the zip file.
echo.
echo   That window looks like a folder but is not one - Windows put these
echo   files somewhere temporary, and it will wipe them.
echo.
echo   Close this, then:
echo     1. Right-click donut-overlays-launcher.zip in Downloads
echo     2. Properties, tick UNBLOCK at the bottom, click OK
echo     3. Right-click it again and choose EXTRACT ALL
echo     4. Open the folder that appears and run this file from there
echo.
pause
exit /b

rem ---------------------------------------------------------------
rem Finding Node. Three places, in order of how little the customer
rem has to do: shipped beside this file, already on the PC, or
rem installed for them now.
rem
rem Deliberately no parentheses around the set commands below - a
rem variable set inside a bracketed block is not readable until the
rem block ends, which is the classic way batch files break.
rem ---------------------------------------------------------------
:findnode
set "NODE=node"

if not exist "node\node.exe" goto nodeonpath
set "NODE=%~dp0node\node.exe"
goto havenode

:nodeonpath
where node >nul 2>nul
if not errorlevel 1 goto havenode

echo   Node.js is missing. It is the free, open-source thing that
echo   actually runs the overlays - made by the OpenJS Foundation,
echo   not by us. It only needs installing once.
echo.

where winget >nul 2>nul
if errorlevel 1 goto manualnode

echo   This PC can install it for you automatically.
echo.
rem Accept "yes", "y", or just Enter. Anything else is a no. Asking for a
rem word people actually type beats making them learn which letter means what.
set "ans="
set /p "ans=  Install Node.js now? (yes / no) "
if /i "%ans%"=="yes" goto doinstall
if /i "%ans%"=="y" goto doinstall
if "%ans%"=="" goto doinstall
goto manualnode

:doinstall

echo.
echo   Installing. Windows may ask you to allow it - say yes.
echo   Give it a couple of minutes.
echo.
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
echo.

rem winget puts Node on the PATH for NEW windows, not for this one,
rem so look where the installer actually put it before giving up.
if not exist "%ProgramFiles%\nodejs\node.exe" goto recheckpath
set "NODE=%ProgramFiles%\nodejs\node.exe"
goto havenode

:recheckpath
where node >nul 2>nul
if not errorlevel 1 goto havenode

echo   Node.js installed, but this window cannot see it yet.
echo   Close this window and double-click START-DONUT-OVERLAYS.bat
echo   again - it will work the second time.
echo.
pause
exit /b

:manualnode
echo   Get it from  https://nodejs.org
echo.
echo     1. Click the big green LTS button
echo     2. Run the installer and click Next through everything
echo     3. Leave "Tools for Native Modules" UNTICKED - not needed
echo     4. Double-click START-DONUT-OVERLAYS.bat again
echo.
echo   Opening the download page for you...
start "" https://nodejs.org/en/download
echo.
pause
exit /b

:havenode
if not exist "donut-royale.html" (
  echo   donut-royale.html is missing. Every file has to stay
  echo   together in this same folder.
  echo.
  pause
  exit /b
)

rem Nothing is installed here any more. The launcher ships with its own
rem websocket code (ws-lite.js), so there is no npm step to go wrong and
rem no wait on first run. If a previous version left the `ws` package in
rem this folder, the relays still prefer it.

echo.
"%NODE%" launcher.js
echo.
echo   Donut Overlays stopped. You can close this window.
pause
