#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MeiDay 一键构建脚本 (Windows)
==============================
一键产出 (默认输出到 <脚本目录>/output/):
    - MeiDay.apk     Android 客户端 (frontend -> Capacitor -> Gradle debug APK)
    - package.zip    思源插件     (frontend build:plugin -> meiday-siyuan-plugin -> webpack)
    - MeiDay.exe     桌面小组件   (widget -> PyInstaller)

设计约定（按需求确认）:
    1. Windows 专用，但换电脑/换目录都能构建：所有路径相对脚本目录解析，
       可在 build.config.json 中覆盖；路径留空则自动探测。
    2. 仓库不存在时自动 git clone（地址在 build.config.json 中，可改）。
    3. 构建环境只检测不自动安装：缺失时打印缺失清单 + 安装指引并停止。
    4. 依赖已存在则跳过安装：node_modules 存在跳过 npm install；
       pip 所需包齐全则跳过 pip install（默认官方源）。
    5. 思源插件版本号：构建前交互提示当前版本，询问是否修改；
       确认修改则同步写 meiday-siyuan-plugin 的 plugin.json 与 package.json。
    6. 只产出 output 文件夹，不自动部署到思源。
用法:
    python build.py           # 完整一键构建
    python build.py --check   # 只做环境/配置/仓库检查，不构建
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# 常量（仅在创建默认配置文件时使用一次；运行期一切以配置为准）
# ---------------------------------------------------------------------------
DEFAULT_CONFIG = {
    "repos": {
        "meiday": "https://github.com/CongSec/MeiDay.git",
        "plugin": "https://github.com/CongSec/meiday-siyuan-plugin.git",
    },
    "paths": {
        # 留空 = 自动探测：
        #   meiday_dir   默认脚本所在目录（即 EasyTask/MeiDay 仓库本身）
        #   plugin_dir   依次探测 <脚本目录>/meiday-siyuan-plugin、<脚本目录>/../meiday-siyuan-plugin
        #   output_dir   默认 <脚本目录>/output
        "meiday_dir": "",
        "plugin_dir": "",
        "output_dir": "output",
    },
    "frontend": {
        "api_base_url": "https://task.congsec.cn",
        "cdn_base": "",
    },
}

CONFIG_NAME = "build.config.json"
OUTPUT_ARTIFACTS = ("MeiDay.apk", "package.zip", "MeiDay.exe")


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def log(msg: str) -> None:
    print(msg, flush=True)


def run(cmd: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess:
    log("  $ " + " ".join(str(x) for x in cmd))
    env = dict(os.environ)
    # 子进程输出统一 UTF-8，避免 Windows 管道/控制台下中文乱码
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")
    return subprocess.run([str(x) for x in cmd], cwd=str(cwd), check=check, env=env)


def npm_cmd() -> str:
    """Windows 上 subprocess 需要 npm.cmd。"""
    return "npm.cmd" if os.name == "nt" else "npm"


def python_cmd() -> str:
    return sys.executable


def try_get_output(cmd: list[str]) -> str | None:
    try:
        out = subprocess.run(
            [str(x) for x in cmd],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=30,
        )
        if out.returncode == 0:
            return (out.stdout or "").strip()
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
def load_config(root: Path) -> dict:
    cfg_path = root / CONFIG_NAME
    if not cfg_path.exists():
        log(f"[配置] 未找到 {CONFIG_NAME}，正在创建默认配置：{cfg_path}")
        cfg_path.write_text(
            json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return json.loads(json.dumps(DEFAULT_CONFIG))
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        log(f"[配置] 解析失败：{cfg_path}\n      {e}\n请修复后重试。")
        sys.exit(1)
    # 合并缺省值，保证结构完整
    merged = json.loads(json.dumps(DEFAULT_CONFIG))
    for section, values in cfg.items():
        if isinstance(values, dict) and section in merged:
            merged[section].update(values)
        else:
            merged[section] = values
    return merged


def resolve_meiday_dir(root: Path, cfg_path_val: str) -> Path:
    if cfg_path_val.strip():
        p = Path(cfg_path_val.strip())
        return p if p.is_absolute() else (root / p).resolve()
    # 自动探测：脚本所在目录即仓库；否则找同级 MeiDay
    if (root / "frontend").is_dir() and (root / "widget").is_dir():
        return root
    for cand in (root / "MeiDay", root.parent / "MeiDay"):
        if (cand / "frontend").is_dir() and (cand / "widget").is_dir():
            return cand
    return root / "MeiDay"


def resolve_plugin_dir(root: Path, cfg_path_val: str) -> Path:
    if cfg_path_val.strip():
        p = Path(cfg_path_val.strip())
        return p if p.is_absolute() else (root / p).resolve()
    for cand in (root / "meiday-siyuan-plugin", root.parent / "meiday-siyuan-plugin"):
        if (cand / "plugin.json").is_file():
            return cand
    return root / "meiday-siyuan-plugin"


def resolve_output_dir(root: Path, cfg_path_val: str) -> Path:
    if cfg_path_val.strip():
        p = Path(cfg_path_val.strip())
        return p if p.is_absolute() else (root / p).resolve()
    return root / "output"


# ---------------------------------------------------------------------------
# 环境检测（只检测，不安装）
# ---------------------------------------------------------------------------
def detect_android_sdk() -> str | None:
    for var in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        v = os.environ.get(var)
        if v and Path(v).is_dir():
            return v
    for cand in (
        Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk",
        Path("C:/Android/Sdk"),
        Path("D:/Android/Sdk"),
        Path.home() / "AppData" / "Local" / "Android" / "Sdk",
    ):
        if cand.is_dir():
            return str(cand)
    return None


def check_env() -> bool:
    log("==> [1/4] 检测构建环境")
    missing: list[tuple[str, str]] = []  # (名称, 安装指引)

    def need(name: str, probe: list[str], guide: str) -> None:
        out = try_get_output(probe)
        if out:
            log(f"  [OK] {name}: {out.splitlines()[0]}")
        else:
            missing.append((name, guide))

    need("git", ["git", "--version"], "https://git-scm.com/download/win")
    need("node", ["node", "--version"], "https://nodejs.org/ (LTS 版本，建议 20+)")
    need("npm", [npm_cmd(), "--version"], "随 Node.js 一起安装，请重装 Node.js")

    # Python（优先当前解释器，其次系统 python / py）
    py = sys.executable
    need("python", [py, "--version"], "https://www.python.org/downloads/ (3.10+，安装时勾选 Add to PATH)")
    need("pip", [py, "-m", "pip", "--version"], "随 Python 安装；若缺失运行: python -m ensurepip --upgrade")

    need("JDK (java)", ["java", "-version"], "https://adoptium.net/ (推荐 JDK 21，Capacitor 8 需要 17+)")

    sdk = detect_android_sdk()
    if sdk:
        log(f"  [OK] Android SDK: {sdk}")
    else:
        missing.append(
            ("Android SDK",
             "安装 Android Studio (https://developer.android.com/studio) 或设置环境变量 ANDROID_HOME 指向 SDK 目录")
        )

    if missing:
        log("\n[失败] 以下环境项缺失，请先安装后再运行：\n")
        for name, guide in missing:
            log(f"  - {name}：{guide}")
        log("\n提示：安装完成后，重新打开终端/双击 build.bat 再试。")
        return False
    return True


# ---------------------------------------------------------------------------
# 仓库就绪
# ---------------------------------------------------------------------------
def ensure_meiday_repo(meiday_dir: Path, url: str) -> None:
    log("==> [2/4] 检查 MeiDay 主仓库")
    marker = (meiday_dir / "frontend").is_dir() and (meiday_dir / "widget").is_dir()
    if marker:
        log(f"  [OK] 已存在: {meiday_dir}")
        return
    if meiday_dir.exists() and any(meiday_dir.iterdir()):
        log(f"[失败] {meiday_dir} 不是 MeiDay 仓库（缺少 frontend/widget），"
            f"且目录非空，无法自动 clone。\n"
            f"请将该目录清空，或在 {CONFIG_NAME} 的 paths.meiday_dir 指定正确位置。")
        sys.exit(1)
    log(f"  [clone] {url} -> {meiday_dir}")
    meiday_dir.mkdir(parents=True, exist_ok=True)
    run(["git", "clone", url, str(meiday_dir)], cwd=meiday_dir.parent)


def ensure_plugin_repo(plugin_dir: Path, url: str) -> None:
    log("==> [2/4] 检查 meiday-siyuan-plugin 插件仓库")
    marker = (plugin_dir / "plugin.json").is_file()
    if marker:
        log(f"  [OK] 已存在: {plugin_dir}")
        return
    if plugin_dir.exists() and any(plugin_dir.iterdir()):
        log(f"[失败] {plugin_dir} 不是 meiday-siyuan-plugin 仓库（缺少 plugin.json），"
            f"且目录非空，无法自动 clone。\n"
            f"请将该目录清空，或在 {CONFIG_NAME} 的 paths.plugin_dir 指定正确位置。")
        sys.exit(1)
    log(f"  [clone] {url} -> {plugin_dir}")
    plugin_dir.mkdir(parents=True, exist_ok=True)
    run(["git", "clone", url, str(plugin_dir)], cwd=plugin_dir.parent)


# ---------------------------------------------------------------------------
# 依赖安装（已存在则跳过）
# ---------------------------------------------------------------------------
def ensure_npm_deps(project_dir: Path, label: str) -> None:
    if (project_dir / "node_modules").is_dir():
        log(f"  [skip] {label} node_modules 已存在，跳过 npm install")
        return
    log(f"  [npm] 安装 {label} 依赖（首次较慢）...")
    run([npm_cmd(), "install"], cwd=project_dir)


def pip_required_packages(requirements_txt: Path) -> list[str]:
    """从 requirements.txt 提取顶层包名（忽略注释、选项行）。"""
    names: list[str] = []
    pat = re.compile(r"^\s*([A-Za-z0-9_.\-]+)")
    for line in requirements_txt.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        m = pat.match(line)
        if m:
            names.append(m.group(1).replace("_", "-").lower())
    return names


def ensure_python_deps(requirements_txt: Path, label: str) -> None:
    pkgs = pip_required_packages(requirements_txt)
    if not pkgs:
        log(f"  [skip] {label} requirements.txt 无有效包，跳过")
        return
    out = try_get_output([python_cmd(), "-m", "pip", "show"] + pkgs)
    # pip show 全部存在时返回 0；输出非空即可认为齐全
    if out is not None and out:
        log(f"  [skip] {label} Python 依赖已齐全，跳过 pip install")
        return
    log(f"  [pip] 安装 {label} Python 依赖（官方源）...")
    run([python_cmd(), "-m", "pip", "install", "-r", str(requirements_txt)], cwd=requirements_txt.parent)


# ---------------------------------------------------------------------------
# 各产物构建
# ---------------------------------------------------------------------------
def clean_old_artifacts(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for name in OUTPUT_ARTIFACTS:
        f = output_dir / name
        if f.exists():
            f.unlink()
            log(f"  [clean] 移除旧产物 {f.name}")


def write_env_production(frontend_dir: Path, api_base_url: str, cdn_base: str) -> None:
    env_file = frontend_dir / ".env.production"
    content = f"VITE_API_BASE_URL={api_base_url}\nVITE_CDN_BASE={cdn_base}\n"
    env_file.write_text(content, encoding="utf-8")
    log(f"  [env] 已写入 {env_file.name}: API={api_base_url or '(空)'}, CDN={cdn_base or '(空)'}")


def build_apk(frontend_dir: Path, output_dir: Path) -> None:
    log("==> [3/4] 构建 Android APK (frontend -> Capacitor -> Gradle)")
    write_env_production(frontend_dir, os.environ["__CFG_API"], os.environ["__CFG_CDN"])
    run([npm_cmd(), "run", "apk:debug"], cwd=frontend_dir)
    apk_dir = frontend_dir / "android" / "app" / "build" / "outputs" / "apk" / "debug"
    apks = sorted(apk_dir.glob("*.apk")) if apk_dir.is_dir() else []
    if not apks:
        log(f"[失败] 未在 {apk_dir} 找到 APK 产物")
        sys.exit(1)
    target = output_dir / "MeiDay.apk"
    shutil.copy2(apks[0], target)
    log(f"  [OK] APK -> {target}  ({apks[0].name})")


def ask_plugin_version(plugin_dir: Path) -> None:
    plugin_json = plugin_dir / "plugin.json"
    pkg_json = plugin_dir / "package.json"
    try:
        pj = json.loads(plugin_json.read_text(encoding="utf-8"))
        pjv = pj.get("version", "")
    except Exception:
        pjv = "?"
    try:
        pk = json.loads(pkg_json.read_text(encoding="utf-8"))
        pkv = pk.get("version", "")
    except Exception:
        pkv = "?"
    log(f"\n  当前插件版本：plugin.json = {pjv}，package.json = {pkv}")
    try:
        sys.stdout.write("  是否修改版本号？输入 y 修改，直接回车跳过 [y/N]: ")
        sys.stdout.flush()
        answer = sys.stdin.readline().strip().lower()
        if not answer and not sys.stdin.isatty():
            log("  [提示] 非交互环境，跳过版本号修改（保持原版本）。")
            return
    except (EOFError, KeyboardInterrupt):
        log("  [提示] 无法读取输入，跳过版本号修改（保持原版本）。")
        return
    if answer not in ("y", "yes"):
        log("  保持原版本号不变。")
        return
    try:
        sys.stdout.write("  请输入新版本号（例如 1.2.1，直接回车则放弃修改）: ")
        sys.stdout.flush()
        new_ver = sys.stdin.readline().strip()
    except (EOFError, KeyboardInterrupt):
        new_ver = ""
    if not new_ver:
        log("  未输入版本号，保持原版本号不变。")
        return
    for path, data, key in ((plugin_json, pj, "version"), (pkg_json, pk, "version")):
        data[key] = new_ver
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        log(f"  [版本] {path.name} version -> {new_ver}")


def build_plugin(frontend_dir: Path, plugin_dir: Path, output_dir: Path) -> None:
    log("==> [3/4] 构建思源插件 (frontend build:plugin -> meiday-siyuan-plugin)")
    log("  [前端] npm run build:plugin ...")
    run([npm_cmd(), "run", "build:plugin"], cwd=frontend_dir)
    src = frontend_dir / "dist-plugin" / "index.html"
    dst = plugin_dir / "src" / "assets" / "app.html"
    if not src.is_file():
        log(f"[失败] 未找到前端插件产物：{src}")
        sys.exit(1)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    log(f"  [拷贝] {src.name} -> {dst}")

    ask_plugin_version(plugin_dir)

    ensure_npm_deps(plugin_dir, "meiday-siyuan-plugin")
    log("  [webpack] npm run build ...")
    run([npm_cmd(), "run", "build"], cwd=plugin_dir)
    pkg_zip = plugin_dir / "package.zip"
    if not pkg_zip.is_file():
        log(f"[失败] 未找到插件产物：{pkg_zip}")
        sys.exit(1)
    target = output_dir / "package.zip"
    shutil.copy2(pkg_zip, target)
    log(f"  [OK] package.zip -> {target}")


def build_widget(widget_dir: Path, output_dir: Path) -> None:
    log("==> [3/4] 构建桌面组件 (widget -> PyInstaller)")
    ensure_python_deps(widget_dir / "requirements.txt", "widget")
    ensure_npm_deps(widget_dir, "widget")
    log("  [pyinstaller] python build.py ...")
    run([python_cmd(), "build.py"], cwd=widget_dir)
    # onefile 产物在 distpath 根目录；onedir 产物在 MeiDayWidget 子目录（兼容旧版）
    candidates = [
        widget_dir / "build" / "dist" / "MeiDayWidget.exe",
        widget_dir / "build" / "dist" / "MeiDayWidget" / "MeiDayWidget.exe",
    ]
    exe = next((c for c in candidates if c.is_file()), None)
    if exe is None:
        log("[失败] 未找到组件可执行文件（已查找：widget/build/dist/MeiDayWidget.exe 及其旧版子目录）")
        sys.exit(1)
    target = output_dir / "MeiDay.exe"
    shutil.copy2(exe, target)
    log(f"  [OK] MeiDay.exe -> {target}")


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    root = Path(__file__).resolve().parent
    cfg = load_config(root)
    meiday_dir = resolve_meiday_dir(root, cfg["paths"]["meiday_dir"])
    plugin_dir = resolve_plugin_dir(root, cfg["paths"]["plugin_dir"])
    output_dir = resolve_output_dir(root, cfg["paths"]["output_dir"])

    log(f"[配置] 脚本目录    : {root}")
    log(f"[配置] MeiDay 目录 : {meiday_dir}")
    log(f"[配置] 插件目录    : {plugin_dir}")
    log(f"[配置] 输出目录    : {output_dir}")

    # 1. 环境检测
    if not check_env():
        sys.exit(1)

    # 2. 仓库就绪
    ensure_meiday_repo(meiday_dir, cfg["repos"]["meiday"])
    ensure_plugin_repo(plugin_dir, cfg["repos"]["plugin"])

    frontend_dir = meiday_dir / "frontend"
    widget_dir = meiday_dir / "widget"

    # 供子步骤读取的配置值（避免函数签名太长）
    os.environ["__CFG_API"] = cfg["frontend"].get("api_base_url", "")
    os.environ["__CFG_CDN"] = cfg["frontend"].get("cdn_base", "")

    if "--check" in sys.argv:
        log("\n[--check] 环境、配置、仓库检查全部通过，未执行构建。")
        return

    clean_old_artifacts(output_dir)

    # 3. 依赖 + 构建
    ensure_npm_deps(frontend_dir, "frontend")
    build_apk(frontend_dir, output_dir)
    build_plugin(frontend_dir, plugin_dir, output_dir)
    build_widget(widget_dir, output_dir)

    # 4. 汇总
    log("\n==> [4/4] 构建完成，产物如下：")
    for name in OUTPUT_ARTIFACTS:
        f = output_dir / name
        if f.is_file():
            size_kb = f.stat().st_size / 1024
            size_str = f"{size_kb/1024:.2f} MB" if size_kb >= 1024 else f"{size_kb:.1f} KB"
            log(f"  [OK] {f}  ({size_str})")
        else:
            log(f"  [!!] {name} 缺失！")


if __name__ == "__main__":
    main()
