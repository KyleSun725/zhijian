@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   纸间 Zhijian
echo   正在启动本地服务...
echo.

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
  if exist "%LOCALAPPDATA%\hermes\node\node.exe" set "NODE=%LOCALAPPDATA%\hermes\node\node.exe"
)

"%NODE%" server.js
if errorlevel 1 (
  echo.
  echo   启动失败：没有找到 Node.js 18 以上版本。
  echo   下载：https://nodejs.org
  pause
)
