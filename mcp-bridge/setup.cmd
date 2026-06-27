@echo off
REM One-time setup for the realvirtual WEB MCP bridge (double-click to run).
cd /d "%~dp0"
echo === Installing dependencies ===
call npm install || goto :err
echo === Building ===
call npm run build || goto :err
echo.
echo Done. Next:
echo   1) In Unity: Tools ^> realvirtual ^> Settings ^> Configure Claude Desktop MCP
echo   2) Restart Claude Desktop / Claude Code
echo   3) In realvirtual WEB settings, turn the AI Bridge on
echo.
pause
goto :eof
:err
echo.
echo Setup FAILED. Make sure Node.js (https://nodejs.org) is installed and on PATH.
pause
