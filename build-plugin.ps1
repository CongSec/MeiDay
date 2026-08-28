# ============================================================================
# MeiDay -> 思源插件 一键构建脚本
#
# 原理：把 Vue 前端打成单个自包含 HTML（app.html），塞进思源插件外壳
#       （iframe blob URL 加载），再用 webpack 打成思源插件 dist，
#       最后安装到思源工作区。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\build-plugin.ps1
#   可选参数：-Workspace "D:\desktop\congsectest\data\plugins\meiday-siyuan-plugin"
#
# 注意：改完源码跑完本脚本后，必须【完全退出并重启思源】才能生效
#       （思源只在启动时读取插件文件，不支持热加载）。
# ============================================================================
[CmdletBinding()]
param(
    [string]$Workspace = "D:\desktop\congsectest\data\plugins\meiday-siyuan-plugin"
)

$ErrorActionPreference = "Stop"
$root       = $PSScriptRoot
$frontend   = Join-Path $root "frontend"
$plugin     = (Resolve-Path (Join-Path $root "..\meiday-siyuan-plugin")).Path
$htmlSrc    = Join-Path $frontend "dist-plugin\index.html"
$htmlDst    = Join-Path $plugin "src\assets\app.html"
$pluginDist = Join-Path $plugin "dist"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# ---------- 0. 前置检查 ----------
Step "0/4 前置检查"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "未找到 node，请先安装 Node.js" }
if (-not (Test-Path "$frontend\node_modules")) { Write-Host "首次运行：安装前端依赖…"; Push-Location $frontend; npm install; Pop-Location }
if (-not (Test-Path "$plugin\node_modules"))   { Write-Host "首次运行：安装插件依赖…"; Push-Location $plugin;  npm install; Pop-Location }

# ---------- 1. 前端 -> 单文件 app.html ----------
Step "1/4 构建前端单文件 (vite build:plugin)"
Push-Location $frontend
npm run build:plugin
Pop-Location
if (-not (Test-Path $htmlSrc)) { throw "前端构建失败：未生成 $htmlSrc" }

# ---------- 2. app.html 拷进插件仓库 ----------
Step "2/4 复制 app.html 到插件仓库"
Copy-Item $htmlSrc $htmlDst -Force
Write-Host "  已复制: $htmlDst ($((Get-Item $htmlDst).Length) bytes)"

# ---------- 3. 构建思源插件 (webpack) ----------
Step "3/4 构建思源插件 (webpack)"
Push-Location $plugin
npm run build
Pop-Location
if (-not (Test-Path (Join-Path $pluginDist "index.js"))) { throw "插件构建失败：未生成 index.js" }

# ---------- 4. 安装到思源工作区 ----------
Step "4/4 安装到思源工作区: $Workspace"
New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
$files = Get-ChildItem $pluginDist -Recurse -File
foreach ($f in $files) {
    $rel  = $f.FullName.Substring($pluginDist.Length + 1)
    $dest = Join-Path $Workspace $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Copy-Item $f.FullName $dest -Force
}
Write-Host "  已安装 $($files.Count) 个文件"

# ---------- 摘要 ----------
Write-Host "`n===== 构建完成 =====" -ForegroundColor Green
Write-Host "app.html  : $htmlDst"
Write-Host "插件 dist : $pluginDist"
Write-Host "已安装到 : $Workspace"
Write-Host ""
Write-Host "【重要】请【完全退出思源再重新打开】才能加载新插件（思源不支持热加载）。" -ForegroundColor Yellow
Write-Host "重启后右上角点 MeiDay 图标 -> 弹出登录页 = 成功。"