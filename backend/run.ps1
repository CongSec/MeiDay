# EasyTask 后端启动脚本（局域网可访问）
# 用法：在 backend 目录执行  .\run.ps1
# 与 vite 前端配合时，前端会把 /api 代理到本端口；直接访问本端口可调用 API（仅后端，页面请走 vite 的 https://<本机IP>:5173）。
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "[EasyTask] 未找到虚拟环境，请先: python -m venv .venv 然后 pip install -r requirements.txt"
    exit 1
}

Write-Host "[EasyTask] 后端启动: http://0.0.0.0:8000 （局域网内手机可访问 http://<本机IP>:8000/api/...）"
& ".venv\Scripts\python.exe" -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload --no-proxy-headers
