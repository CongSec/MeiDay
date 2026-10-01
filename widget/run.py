# -*- coding: utf-8 -*-
"""
MeiDay 桌面小组件启动器（Windows 专用）

双窗口架构：
  1. 原生视图窗口（native_widget.NativeWidget，UpdateLayeredWindow 逐像素透明）：
     展示今日未完成任务。半透明白色圆角背景（透明度可调）+ 纯黑文字，
     可真实透出看到桌面 / 其它程序；始终鼠标穿透、常驻最底层、防偷窥。
  2. pywebview 设置窗口（不透明，仅设置 / 登录时显示）：
     登录、显示/隐藏、同步、外观（透明度/宽度）、拖动位置、自启动、退出。

其它职责：
  - 起本机 HTTP 服务（127.0.0.1:5173）托管 widget/dist 构建产物，供设置窗口加载；
  - 托盘（pystray）：左键 = 打开设置；右键菜单 = 打开设置 / 显示 / 隐藏 / 退出；
  - 置底循环：view 模式把原生视图压到所有应用窗口之下（桌面图标之上）；
  - 防偷窥：对两个窗口持续 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)，
    录屏 / 截图 / 屏幕共享时内容不可见（本人屏幕正常显示）；
  - 配置：程序同级目录 config.json（session 登录态 + widget 界面设置），原子写入。

窗口身份说明：设置窗口与视图窗口均为「顶层工具窗口」（WS_EX_TOOLWINDOW），
不进任务栏 / Alt-Tab；点「显示桌面」(Win+D) 不会最小化。视图窗口用 WS_EX_TRANSPARENT
实现鼠标穿透；分层窗口（UpdateLayeredWindow）透明像素天然不拦截鼠标。

使用：
    cd widget
    npm install
    npm run build
    python run.py
"""
import ctypes
import json
import os
import sys
import threading
import time
import winreg
from ctypes import wintypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import webview

from native_widget import NativeWidget

# ---------------------------------------------------------------------------
# 路径：源码运行与 PyInstaller 打包两种形态
#  - ROOT       ：静态资源根（dist 所在目录）。打包时指向 sys._MEIPASS。
#  - CONFIG_DIR ：config.json 所在目录。始终为「程序同级目录」（exe 所在目录）。
# ---------------------------------------------------------------------------
if getattr(sys, "frozen", False):
    ROOT = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    CONFIG_DIR = Path(sys.executable).resolve().parent
else:
    ROOT = Path(__file__).resolve().parent
    CONFIG_DIR = ROOT

DIST = ROOT / "dist"
PORT = 5173
TITLE = "MeiDay 桌面小组件"

# 设置窗口尺寸（视图窗口尺寸由原生渲染器按任务数自适应，宽度来自 config）
SETTINGS_W = 420
SETTINGS_H = 580

# ---------------------------------------------------------------------------
# 窗口/原生渲染器的共享状态。注意：不能把 pywebview 的 window 对象挂到 Api
# 实例属性上——pywebview 会递归遍历 js_api 对象的属性生成 JS 桥，一旦遍历到
# window.native（WebView2 整棵 COM 对象树）会刷屏并触发 RecursionError。
# 因此窗口/句柄/原生渲染器引用都放在模块级 _STATE 里，Api 方法按需读取。
# ---------------------------------------------------------------------------
_STATE = {
    "window": None,      # pywebview 设置窗口
    "hwnd": None,        # 设置窗口句柄
    "native": None,      # NativeWidget 原生视图窗口
    "mode": "view",      # view / settings / hidden
    "pos": None,         # (逻辑像素 x, y)：视图与设置窗口的共享位置
}


def _win():
    return _STATE["window"]


def _native():
    return _STATE["native"]


# ---------------------------------------------------------------------------
# 配置文件（程序同级 config.json，原子写入）
# ---------------------------------------------------------------------------
DEFAULT_CONFIG = {
    "session": {"token": "", "tokenAt": 0, "savedPw": "", "savedPwAt": 0, "username": ""},
    "widget": {"opacity": 0.6, "width": 360, "posX": None, "posY": None, "autoStart": False, "fontSize": 16},
}


def _deep_merge(dst, patch):
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_merge(dst[k], v)
        else:
            dst[k] = v


def _default_config():
    return json.loads(json.dumps(DEFAULT_CONFIG))


def read_config():
    if CONFIG_DIR is None:
        return _default_config()
    path = CONFIG_DIR / "config.json"
    if path.exists():
        try:
            data = json.loads(path.read_text("utf-8"))
            if isinstance(data, dict):
                merged = _default_config()
                _deep_merge(merged, data)
                # 迁移：清理已废弃的旧版字段（blur / anchor 已删除）
                merged.setdefault("widget", {}).pop("blur", None)
                merged["widget"].pop("anchor", None)
                return merged
        except Exception as e:
            print("[widget] 读取配置失败，使用默认配置：", e)
    return _default_config()


def write_config(patch):
    data = read_config()
    _deep_merge(data, patch)
    path = CONFIG_DIR / "config.json"
    try:
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
        os.replace(tmp, path)
    except Exception as e:
        print("[widget] 写入配置失败：", e)
    return data


# ---------------------------------------------------------------------------
# 开机自启动（HKCU\...\Run）
# ---------------------------------------------------------------------------
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_NAME = "MeiDayWidget"


def _autostart_command():
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}"'
    exe = Path(sys.executable)
    pyw = exe.with_name("pythonw.exe")
    if pyw.exists():
        return f'"{pyw}" "{Path(__file__).resolve()}"'
    return f'"{exe}" "{Path(__file__).resolve()}"'


def set_auto_start(enabled):
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE)
    except FileNotFoundError:
        key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY)
    try:
        if enabled:
            winreg.SetValueEx(key, RUN_NAME, 0, winreg.REG_SZ, _autostart_command())
        else:
            try:
                winreg.DeleteValue(key, RUN_NAME)
            except FileNotFoundError:
                pass
    finally:
        winreg.CloseKey(key)
    return True


def get_auto_start():
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY)
    except FileNotFoundError:
        return False
    try:
        winreg.QueryValueEx(key, RUN_NAME)
        return True
    except FileNotFoundError:
        return False
    finally:
        winreg.CloseKey(key)


# ---------------------------------------------------------------------------
# 窗口样式常量
# ---------------------------------------------------------------------------
GWL_EXSTYLE = -20
WS_EX_APPWINDOW = 0x00040000
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_TRANSPARENT = 0x00000020
HWND_BOTTOM = 1
HWND_TOP = 0
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020

WDA_EXCLUDEFROMCAPTURE = 0x00000011


def _user32():
    return ctypes.windll.user32


def find_hwnds_by_pid(pid):
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _cb(hwnd, _lparam):
        if _user32().IsWindowVisible(hwnd):
            win_pid = wintypes.DWORD()
            _user32().GetWindowThreadProcessId(hwnd, ctypes.byref(win_pid))
            if win_pid.value == pid:
                found.append(hwnd)
        return True

    _user32().EnumWindows(_cb, 0)
    return found


def find_main_hwnd():
    hwnd = _user32().FindWindowW(None, TITLE)
    if hwnd:
        return hwnd
    hwnds = find_hwnds_by_pid(os.getpid())
    return hwnds[0] if hwnds else None


def apply_widget_styles(hwnd):
    """去掉任务栏窗口标记、加上工具窗口标记（设置窗口，不进任务栏 / Alt-Tab）。"""
    ex = _user32().GetWindowLongW(hwnd, GWL_EXSTYLE)
    ex = (ex & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW
    _user32().SetWindowLongW(hwnd, GWL_EXSTYLE, ex)
    _refresh_window(hwnd)


def _refresh_window(hwnd):
    """应用窗口扩展样式改动（WS_EX_* 改动后需要触发一次 FRAMECHANGED 刷新）。"""
    _user32().SetWindowPos(
        hwnd, 0, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
    )


def _move_window(hwnd, x, y):
    """原生移动窗口（物理像素）：不动大小/层级、不激活。
    不用 pywebview 的 window.move()：其 WinForms 实现向 SetWindowPos 传
    None 作为 cx/cy，在本机（加载 pythonnet 后）会抛 ArgumentError。"""
    _user32().SetWindowPos(
        hwnd, 0, int(x), int(y), 0, 0,
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
    )


def set_click_through(enabled):
    """设置窗口：settings 模式可交互（取消穿透），view/hidden 穿透（此时窗口隐藏）。"""
    hwnd = _STATE.get("hwnd")
    if not hwnd:
        return False
    ex = _user32().GetWindowLongW(hwnd, GWL_EXSTYLE)
    if enabled:
        ex |= WS_EX_TRANSPARENT
    else:
        ex &= ~WS_EX_TRANSPARENT
    _user32().SetWindowLongW(hwnd, GWL_EXSTYLE, ex)
    _refresh_window(hwnd)
    return True


def _window_size(hwnd):
    rect = wintypes.RECT()
    _user32().GetWindowRect(hwnd, ctypes.byref(rect))
    return rect.right - rect.left, rect.bottom - rect.top


def _dpi_scale(hwnd=None):
    """窗口所在显示器的 DPI 缩放系数（物理像素 / 逻辑像素）。"""
    hwnd = hwnd or _STATE.get("hwnd")
    try:
        dpi = _user32().GetDpiForWindow(hwnd)
        return (dpi / 96.0) if dpi else 1.0
    except Exception:
        return 1.0


def _apply_startup_position():
    """计算窗口位置（逻辑像素）：
    - 若 config 已保存过位置（posX/posY，前端拖动后写入的逻辑像素），使用之；
    - 否则默认贴靠主屏最右侧（顶部留 24px 边距）。
    结果存到 _STATE["pos"]，并应用到原生视图窗口（物理像素）。
    设置窗口在首次打开（apply_mode('settings')）时使用同一位置。
    """
    scale = _dpi_scale() or 1.0
    cfg = read_config().get("widget", {})
    px, py = cfg.get("posX"), cfg.get("posY")
    if isinstance(px, (int, float)) and isinstance(py, (int, float)):
        lx, ly = int(px), int(py)
    else:
        width = int(cfg.get("width") or 360)
        sw = _user32().GetSystemMetrics(0)  # 主屏物理宽
        lx = max(8, int(sw / scale) - width - 24)
        ly = 24
    _STATE["pos"] = (lx, ly)
    native = _native()
    if native is not None:
        native.set_position(int(lx * scale), int(ly * scale))


def apply_mode(mode):
    """切换三模式：
    - view   ：原生视图窗口显示（鼠标穿透、置底），设置窗口隐藏；
    - settings：设置窗口显示（可交互、置前），原生视图隐藏；
    - hidden ：两个窗口都隐藏，仅保留后台同步与托盘。
    """
    mode = mode if mode in ("view", "settings", "hidden") else "view"
    _STATE["mode"] = mode
    win = _win()
    hwnd = _STATE.get("hwnd")
    native = _native()
    if mode == "settings":
        set_click_through(False)
        if win is not None:
            pos = _STATE.get("pos")
            hwnd = _STATE.get("hwnd")
            if pos and hwnd:
                scale = _dpi_scale() or 1.0
                _move_window(hwnd, int(pos[0] * scale), int(pos[1] * scale))
            win.show()
        if native is not None:
            native.set_visible(False)
        if hwnd:
            _user32().SetWindowPos(
                hwnd, HWND_TOP, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
    elif mode == "view":
        set_click_through(True)
        if win is not None:
            win.hide()
        if native is not None:
            native.set_visible(True)
            native.bring_to_bottom()
    else:  # hidden
        if win is not None:
            win.hide()
        if native is not None:
            native.set_visible(False)


def keep_bottom_loop(stop_event):
    """view 模式把原生视图窗口压到所有应用窗口之下（桌面图标之上）。
    settings 模式（可交互）不压底，关闭设置后自动落回最底层。"""
    while not stop_event.is_set():
        try:
            native = _native()
            if native and _STATE.get("mode") == "view":
                native.bring_to_bottom()
        except Exception:
            pass
        time.sleep(1.5)


def set_display_affinity(hwnd):
    try:
        _user32().SetWindowDisplayAffinity(ctypes.c_void_p(hwnd), WDA_EXCLUDEFROMCAPTURE)
        return True
    except Exception:
        return False


def enforce_affinity_loop(stop_event):
    while not stop_event.is_set():
        try:
            native = _native()
            if native is not None:
                native.apply_affinity()
            hwnd = _STATE.get("hwnd")
            if hwnd:
                set_display_affinity(hwnd)
        except Exception:
            pass
        time.sleep(0.5)


# ---------------------------------------------------------------------------
# 托盘（pystray）
# ---------------------------------------------------------------------------
try:
    import pystray
    from PIL import Image, ImageDraw

    HAS_TRAY = True
except Exception:
    HAS_TRAY = False
    pystray = None


def load_tray_icon():
    """优先用项目 logo，找不到则生成一个圆形小图标。"""
    candidates = [
        ROOT / "logo.png",
        ROOT.parent / "frontend" / "public" / "logo.png",
        ROOT / "dist" / "logo.png",
    ]
    for p in candidates:
        try:
            if p.exists():
                img = Image.open(p).convert("RGBA")
                img.thumbnail((64, 64))
                return img
        except Exception:
            continue
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([2, 2, 62, 62], radius=14, fill=(59, 130, 246, 255))
    d.rounded_rectangle([12, 18, 52, 46], radius=6, fill=(255, 255, 255, 255))
    d.rectangle([22, 30, 42, 34], fill=(59, 130, 246, 255))
    return img


def _call_js(script):
    w = _win()
    if w is not None:
        try:
            w.evaluate_js(script)
        except Exception as e:
            print("[widget] 通知前端失败：", e)


def tray_show(_icon=None, _item=None):
    apply_mode("view")
    _call_js("window.__setMode && window.__setMode('view')")


def tray_hide(_icon=None, _item=None):
    apply_mode("hidden")
    _call_js("window.__setMode && window.__setMode('hidden')")


def tray_open_settings(_icon=None, _item=None):
    apply_mode("settings")
    _call_js("window.__setMode && window.__setMode('settings')")


def tray_quit(_icon=None, _item=None):
    w = _win()
    if w is not None:
        try:
            w.destroy()
        except Exception:
            pass


def start_tray():
    if not HAS_TRAY:
        print("[widget] 未安装 pystray，托盘不可用")
        return
    try:
        icon = pystray.Icon(
            "MeiDayWidget",
            load_tray_icon(),
            TITLE,
            pystray.Menu(
                pystray.MenuItem("打开设置", tray_open_settings, default=True),
                pystray.MenuItem("显示小组件", tray_show),
                pystray.MenuItem("隐藏小组件", tray_hide),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("退出", tray_quit),
            ),
        )
        _STATE["tray"] = icon
        icon.run_detached()
    except Exception as e:
        print("[widget] 托盘启动失败：", e)


# ---------------------------------------------------------------------------
# 静态服务器（托管 dist，仅供设置窗口加载）
# ---------------------------------------------------------------------------
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def start_static_server():
    if not (DIST / "index.html").exists():
        print("[widget] 未找到 dist/index.html，请先执行：")
        print("    cd widget && npm install && npm run build")
        sys.exit(1)
    os.chdir(DIST)
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), QuietHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


# ---------------------------------------------------------------------------
# 单实例
# ---------------------------------------------------------------------------
def ensure_single_instance():
    try:
        handle = ctypes.windll.kernel32.CreateMutexW(None, False, "MeiDayDesktopWidgetMutex")
        return ctypes.windll.kernel32.GetLastError() != 183  # ERROR_ALREADY_EXISTS
    except Exception:
        return True


# ---------------------------------------------------------------------------
# JS API（设置窗口前端调用）
# ---------------------------------------------------------------------------
class Api:
    def move(self, x, y):
        """拖动设置窗口时同步移动两个窗口，并更新共享位置（逻辑像素）。
        用原生 SetWindowPos 移动设置窗口（pywebview window.move 在本机会抛错）。"""
        x, y = int(x), int(y)
        scale = _dpi_scale() or 1.0
        _STATE["pos"] = (x, y)
        hwnd = _STATE.get("hwnd")
        if hwnd:
            _move_window(hwnd, int(x * scale), int(y * scale))
        native = _native()
        if native is not None:
            native.set_position(int(x * scale), int(y * scale))
        return True

    def resize(self, width, height):
        """仅设置窗口使用（视图窗口由原生渲染器自适应高度）。"""
        win = _win()
        if win is not None:
            win.resize(int(width), int(height))
        return True

    def quit(self):
        w = _win()
        if w is not None:
            w.destroy()
        return True

    def set_click_through(self, enabled):
        return set_click_through(bool(enabled))

    def set_mode(self, mode):
        apply_mode(mode)
        return True

    def update_view(self, data):
        """前端把今日视图数据（日期/计数/任务标题列表）推给原生视图窗口。"""
        native = _native()
        if native is not None:
            native.set_data(data or {})
            cfg = read_config().get("widget", {})
            native.set_appearance(
                width=cfg.get("width"),
                transparency=cfg.get("opacity"),
                font_size=cfg.get("fontSize"),
            )
        return True

    def read_config(self):
        return read_config()

    def write_config(self, patch):
        if not isinstance(patch, dict):
            return read_config()
        data = write_config(patch)
        if "widget" in patch:
            w = data.get("widget", {})
            native = _native()
            if native is not None:
                native.set_appearance(
                    width=w.get("width"),
                    transparency=w.get("opacity"),
                    font_size=w.get("fontSize"),
                )
                px, py = w.get("posX"), w.get("posY")
                if isinstance(px, (int, float)) and isinstance(py, (int, float)):
                    scale = _dpi_scale() or 1.0
                    native.set_position(int(px * scale), int(py * scale))
        return data

    def set_auto_start(self, enabled):
        return set_auto_start(bool(enabled))

    def get_auto_start(self):
        return get_auto_start()


# ---------------------------------------------------------------------------
def _set_process_dpi_aware():
    """系统 DPI 感知：与 pywebview WinForms 后端保持一致，使 GetSystemMetrics /
    GetWindowRect / SetWindowPos 全部使用物理像素，避免高 DPI 下坐标混用偏移。"""
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def main():
    if not ensure_single_instance():
        print("[widget] 已有实例在运行，本次启动退出")
        return

    _set_process_dpi_aware()

    httpd = start_static_server()
    api = Api()

    # 原生视图窗口：先启动并应用外观（宽 / 透明度），位置在 on_started 里设置
    native = NativeWidget()
    native.start()
    _STATE["native"] = native
    cfg = read_config()
    native.set_appearance(
        width=int(cfg["widget"].get("width") or 360),
        transparency=cfg["widget"].get("opacity", 0.6),
        font_size=cfg["widget"].get("fontSize", 16),
    )

    window = webview.create_window(
        TITLE,
        f"http://127.0.0.1:{PORT}/",
        width=SETTINGS_W,
        height=SETTINGS_H,
        frameless=True,
        transparent=False,   # 设置窗口为不透明面板，不依赖 WebView2 透明
        background_color='#0f172a',  # 不透明深色底，避免白色闪边
        easy_drag=False,
        resizable=False,
        hidden=True,         # 初始隐藏：登录成功前不闪窗口，由前端按模式控制显示
        js_api=api,
    )

    stop_event = threading.Event()

    def on_started():
        _STATE["window"] = window
        hwnd = None
        for _ in range(20):
            hwnd = find_main_hwnd()
            if hwnd:
                break
            time.sleep(0.5)
        if hwnd:
            _STATE["hwnd"] = hwnd
            apply_widget_styles(hwnd)
            # 按前端/托盘的最终模式应用一次（解决启动竞态：若前端 onMounted 在
            # on_started 之前调用了 set_mode，此时 _win() 仍为 None，窗口不会显示，
            # 这里兜底重新应用，确保 settings 窗口正常出现）。
            apply_mode(_STATE["mode"])
            _apply_startup_position()
        else:
            print("[widget] 警告：未找到设置窗口句柄")
        threading.Thread(target=keep_bottom_loop, args=(stop_event,), daemon=True).start()
        threading.Thread(target=enforce_affinity_loop, args=(stop_event,), daemon=True).start()
        start_tray()
        print("[widget] 桌面小组件已启动（托盘左键=设置，右键=菜单）")

    try:
        webview.start(private_mode=False, func=on_started)
    finally:
        stop_event.set()
        native.stop()
        tray = _STATE.get("tray")
        if tray is not None:
            try:
                tray.stop()
            except Exception:
                pass
        httpd.shutdown()


if __name__ == "__main__":
    main()
