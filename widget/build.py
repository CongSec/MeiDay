#!/usr/bin/env python3
"""
MeiDay 桌面小组件 打包脚本（PyInstaller，Windows 专用）

产物：widget/build/dist/MeiDayWidget.exe（onefile 单文件，拷到任意 64 位 Win10/11 双击即运行）
  - onefile 单文件：无需携带 _internal 目录；config.json 仍落在「程序同级目录」——
    run.py 用 Path(sys.executable).parent 解析 CONFIG_DIR，onefile 下同样成立
    （sys.executable 指向真实 exe 路径，而非 _MEIPASS 临时目录）；
  - --noconsole：后台托盘程序，不弹控制台窗口；
  - 前端 widget/dist 作为数据打进 bundle（_MEIPASS/dist），运行时由内置 HTTP 服务托管；
  - logo.png 同时打进 bundle 根（_MEIPASS/logo.png），供托盘图标使用；
  - WebView2 运行时与 .NET Framework 由操作系统提供，无需捆绑；
  - pythonnet(clr) 通过 --collect-all 完整收集，保证 WinForms 后端可用。

用法：
    pip install -r requirements.txt
    python build.py
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FRONTEND_PUBLIC = ROOT.parent / "frontend" / "public"
FRONTEND_DIST = ROOT / "dist"
ICON = ROOT / "logo.ico"
BUILD_DIR = ROOT / "build"
OUTPUT_DIR = BUILD_DIR / "dist"
WORK_DIR = BUILD_DIR / "work"
NAME = "MeiDayWidget"


def run(cmd, cwd=None):
    print("[build] " + " ".join(str(x) for x in cmd))
    subprocess.run([str(x) for x in cmd], cwd=str(cwd or ROOT), check=True)


def build_frontend():
    print("==> 构建前端")
    # Windows 上 subprocess 无法直接解析 npm（需 npm.cmd）
    npm = "npm.cmd" if sys.platform == "win32" else "npm"
    run([npm, "run", "build"])


def make_icon():
    print("==> 生成 logo.ico")
    from PIL import Image
    img = Image.open(FRONTEND_PUBLIC / "logo.png").convert("RGBA")
    img.save(ICON, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("    icon:", ICON)


def package():
    print("==> PyInstaller 打包（onefile 单文件）")
    sep = ";" if sys.platform == "win32" else ":"
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean",
        "--noconsole", "--onefile",
        "--name", NAME,
        "--icon", str(ICON),
        "--distpath", str(OUTPUT_DIR),
        "--workpath", str(WORK_DIR),
        "--add-data", f"{FRONTEND_DIST}{sep}dist",
        "--add-data", f"{FRONTEND_PUBLIC / 'logo.png'}{sep}.",
        "--collect-all", "webview",
        "--collect-all", "clr",
        "--collect-all", "pystray",
        "--hidden-import", "webview.platforms.winforms",
        "--hidden-import", "webview.platforms.edgechromium",
        "--hidden-import", "webview.platforms.win32",
        "--hidden-import", "native_widget",
        str(ROOT / "run.py"),
    ]
    run(cmd)


def main():
    build_frontend()
    make_icon()
    package()
    print()
    print("完成！可执行文件位于：")
    print("  ", OUTPUT_DIR / f"{NAME}.exe")


if __name__ == "__main__":
    main()
