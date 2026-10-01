@echo off
chcp 65001 >nul
title MeiDay 一键构建
setlocal
cd /d "%~dp0"
echo ============================================
echo   MeiDay 一键构建脚本 (Windows)
echo ============================================
python "%~dp0build.py" %*
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" (
  echo [错误] 构建失败，退出码 %EXITCODE%。请查看上方日志。
  pause
  exit /b %EXITCODE%
)
echo [完成] 按任意键关闭窗口...
pause >nul
exit /b 0