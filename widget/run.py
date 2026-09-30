"""
MeiDay 桌面小组件启动器（pywebview 薄壳，Windows 专用）

职责：
1. 起一个本机 HTTP 服务（127.0.0.1:5173）托管 widget/dist 构建产物；
2. 用 pywebview 打开「透明 + 无边框」窗口，通过 JS 端 js_api 控制移动/折叠/隐藏；
3. 防偷窥：对窗口反复调用 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)，
   使录屏 / 截图 / 屏幕共享时窗口内容不可见（屏幕上正常显示）。

使用：
    cd widget
    npm install
    npm run build
    python run.py
"""

import ctypes
import os
import sys
import threading
import time
from ctypes import wintypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import webview

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
PORT = 5173
TITLE = "MeiDay 桌面小组件"
WIDTH = 360
HEIGHT = 540


# ---------------------------------------------------------------------------
# JS 可调用的 Api：move/resize/hide/show 全部委托给 pywebview 窗口对象
# （pywebview 默认只暴露 js_api 类的方法，不能直接调 window.*）
#
# 注意：不能把 pywebview 的 window 对象挂到 Api 实例属性上——
# pywebview 启动时会递归遍历 js_api 对象的所有属性来生成 JS 桥，
# 一旦遍历到 window.native（WebView2 的整棵 COM 对象树），会刷屏报错
# 并触发 RecursionError，进而卡死 GIL，连本地静态服务器都不再响应。
# 因此窗口引用放在模块级可变容器 _STATE 里，Api 方法按需读取。
# ---------------------------------------------------------------------------
_STATE = {"window": None}


def _win():
    return _STATE["window"]


class Api:
    def hide(self):
        w = _win()
        if w is not None:
            w.hide()
        return True

    def show(self):
        w = _win()
        if w is not None:
            w.show()
        return True

    def move(self, x, y):
        # 输入为逻辑像素，pywebview 内部会按 DPI 缩放换算成物理像素
        w = _win()
        if w is not None:
            w.move(int(x), int(y))
        return True

    def resize(self, width, height):
        w = _win()
        if w is not None:
            w.resize(int(width), int(height))
        return True

    def quit(self):
        w = _win()
        if w is not None:
            w.destroy()
        return True


# ---------------------------------------------------------------------------
# 静态服务器（托管 dist，避免 file:// 下 fetch/IndexedDB/localStorage 受限）
# ---------------------------------------------------------------------------
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 静默访问日志
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
# 防偷窥：SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
#   0x11 = 17：窗口内容不出现在任何屏幕采集（录屏/截图/屏幕共享）中，
#   但用户本人屏幕上正常显示。定时重复设置，防止被其它进程临时改回。
# ---------------------------------------------------------------------------
WDA_EXCLUDEFROMCAPTURE = 0x00000011


def set_display_affinity(hwnd):
    try:
        ctypes.windll.user32.SetWindowDisplayAffinity(
            ctypes.c_void_p(hwnd), WDA_EXCLUDEFROMCAPTURE
        )
        return True
    except Exception:
        return False


def find_hwnds_by_pid(pid):
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _cb(hwnd, _lparam):
        if ctypes.windll.user32.IsWindowVisible(hwnd):
            win_pid = wintypes.DWORD()
            ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(win_pid))
            if win_pid.value == pid:
                found.append(hwnd)
        return True

    ctypes.windll.user32.EnumWindows(_cb, 0)
    return found


def find_main_hwnd():
    # 优先按标题精确匹配
    hwnd = ctypes.windll.user32.FindWindowW(None, TITLE)
    if hwnd:
        return hwnd
    # 兜底：枚举本进程的可见顶层窗口
    hwnds = find_hwnds_by_pid(os.getpid())
    return hwnds[0] if hwnds else None


def enforce_affinity_loop(stop_event):
    applied = set()
    while not stop_event.is_set():
        try:
            hwnd = find_main_hwnd()
            if hwnd and hwnd not in applied:
                if set_display_affinity(hwnd):
                    applied.add(hwnd)
        except Exception:
            pass
        time.sleep(0.5)


# ---------------------------------------------------------------------------
def main():
    httpd = start_static_server()
    api = Api()

    window = webview.create_window(
        TITLE,
        f"http://127.0.0.1:{PORT}/",
        width=WIDTH,
        height=HEIGHT,
        frameless=True,
        transparent=True,
        easy_drag=False,
        resizable=False,
        js_api=api,
    )

    stop_event = threading.Event()

    def on_started():
        # 把窗口对象放进模块级容器，JS 端 move/resize/hide 才生效
        _STATE["window"] = window
        threading.Thread(
            target=enforce_affinity_loop, args=(stop_event,), daemon=True
        ).start()

    try:
        webview.start(private_mode=False, func=on_started)
    finally:
        stop_event.set()
        httpd.shutdown()


if __name__ == "__main__":
    main()
