@echo off
chcp 65001 >nul
setlocal
set "BRIDGE_NODE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined BRIDGE_NODE set "BRIDGE_NODE=%%N"
if not defined BRIDGE_NODE set "BRIDGE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%BRIDGE_NODE%" (
 echo Node.js 24 or later is required. Open Codex once, or install Node.js.
 pause
 exit /b 1
)
"%BRIDGE_NODE%" "%~dp0..\scripts\launch.mjs" %*
set "BRIDGE_EXIT=%ERRORLEVEL%"
pause
exit /b %BRIDGE_EXIT%
