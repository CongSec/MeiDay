# 启动 MeiDay 后端（开发/局域网测试用）
# 输出重定向到文件，避免 stdout/stderr 管道或控制台缓冲阻塞导致服务假死（HTTP 全部超时）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$py = 'C:\Users\congs\AppData\Local\Programs\Python\Python312\python.exe'
$pyArgs = @('-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', '8000', '--no-proxy-headers')

if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) {
    Write-Warning '端口 8000 已被占用，请先停止旧进程后再启动。'
    exit 1
}

$outLog = Join-Path $logDir 'uvicorn.out.log'
$errLog = Join-Path $logDir 'uvicorn.err.log'
$p = Start-Process -FilePath $py -ArgumentList $pyArgs -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
Write-Host "后端已启动 PID=$($p.Id) 端口 8000"
Write-Host "stdout 日志: $outLog"
Write-Host "stderr 日志: $errLog"
