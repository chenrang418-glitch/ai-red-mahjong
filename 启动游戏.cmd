@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)

if not exist "dist\index.html" (
  if not exist "node_modules" (
    echo 首次运行需要先在本目录执行 npm install。
    pause
    exit /b 1
  )
  echo 正在生成本地网页...
  call npm run build
  if errorlevel 1 (
    echo 网页构建失败，请查看上方错误信息。
    pause
    exit /b 1
  )
)

powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory '%CD%' -WindowStyle Hidden -RedirectStandardOutput '.local-server.log' -RedirectStandardError '.local-server-error.log'"
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:4173"
exit /b 0
