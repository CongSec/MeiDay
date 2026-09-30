"""
MeiDay 桌面小组件启动器（pywebview 薄壳，Windows 专用）

职责：
1. 起一个本机 HTTP 服务（127.0.0.1:5173）托管 widget/dist 构建产物；
2. 用 pywebview 打开「透明 + 无边框」的顶层窗口，通过 JS 端 js_api
   控制移动 / 折叠 / 退出（不做最小化，只做折叠）；
3. 桌面小组件化（不置顶，位于所有应用窗口之下，类似 360 桌面助手）：
   - WS_EX_TOOLWINDOW：不进任务栏、不进 Alt-Tab；
   - 点「显示桌面」(Win+D) 时小组件不会被最小化，始终留在桌面上；
   - 置底循环：不交互时把窗口压到所有应用窗口之下（桌面图标之上）；
     点击小组件时正常激活置前以便操作，点击别处后自动落回最底层。
4. 防偷窥：对窗口反复调用 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)，
   使录屏 / 截图 / 屏幕共享时窗口内容不可见（屏幕上正常显示）。

注意：窗口保持「顶层窗口」身份——一旦 SetParent 到桌面层（Progman/WorkerW），
SetWindowDisplayAffinity 会失效（ERROR_INVALID_FUNCTION），防偷窥就没了。
因此这里用「工具窗口 + 置底循环」实现桌面小组件效果，而不是重父化。

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
# JS 可调用的 Api：move/resize/quit 全部委托给 pywebview 窗口对象
# （pywebview 默认只暴露 js_api 类的方法，不能直接调 window.*）
#
# 注意：不能把 pywebview 的 window 对象挂到 Api 实例属性上——
# pywebview 启动时会递归遍历 js_api 对象的所有属性来生成 JS 桥，
# 一旦遍历到 window.native（WebView2 的整棵 COM 对象树），会刷屏报错
# 并触发 RecursionError，进而卡死 GIL，连本地静态服务器都不再响应。
# 因此窗口/句柄引用放在模块级可变容器 _STATE 里，Api 方法按需读取。
# ---------------------------------------------------------------------------
_STATE = {"window": None, "hwnd": None}


def _win():
    return _STATE["window"]


class Api:
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
# 窗口句柄查找（只在启动时用一次：找到后把句柄固定存入 _STATE，
# 置底 / 防偷窥循环都用这个固定句柄，不再依赖 FindWindow 动态查找）
# ---------------------------------------------------------------------------
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


# ---------------------------------------------------------------------------
# 桌面小组件样式：工具窗口（不进任务栏/Alt-Tab、Win+D 不最小化）+ 置底
# ---------------------------------------------------------------------------
GWL_EXSTYLE = -20
WS_EX_APPWINDOW = 0x00040000
WS_EX_TOOLWINDOW = 0x00000080
HWND_BOTTOM = 1
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOACTIVATE = 0x0010


def apply_widget_styles(hwnd):
    """去掉任务栏窗口标记、加上工具窗口标记，并放到底层 + 主屏右上角默认位置。"""
    user32 = ctypes.windll.user32
    ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    ex = (ex & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW
    user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex)
    # 默认位置：主屏右上角（物理像素；GetWindowRect 取当前实际物理尺寸）
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w = rect.right - rect.left
    h = rect.bottom - rect.top
    sw = user32.GetSystemMetrics(0)  # SM_CXSCREEN（主屏物理宽）
    x = max(8, sw - w - 24)
    y = 24
    user32.SetWindowPos(
        hwnd, HWND_BOTTOM, x, y, w, h, SWP_NOACTIVATE,
    )


def keep_bottom_loop(stop_event):
    """不交互时把小组件压到所有应用窗口之下（桌面之上）。
    正在被用户操作（前台窗口=小组件本身）时不做处理，保证可正常点击/拖拽。"""
    user32 = ctypes.windll.user32
    while not stop_event.is_set():
        try:
            hwnd = _STATE.get("hwnd")
            if hwnd and user32.GetForegroundWindow() != hwnd:
                user32.SetWindowPos(
                    hwnd, HWND_BOTTOM, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                )
        except Exception:
            pass
        time.sleep(1.5)


# ---------------------------------------------------------------------------
# 防偷窥：SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
#   0x11 = 17：窗口内容不出现在任何屏幕采集（录屏/截图/屏幕共享）中，
#   但用户本人屏幕上正常显示。定时重复设置，防止被其它进程临时改回。
#   仅对顶层窗口有效——所以小组件绝不能重父化到桌面层。
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


def enforce_affinity_loop(stop_event):
    while not stop_event.is_set():
        try:
            hwnd = _STATE.get("hwnd")
            if hwnd:
                set_display_affinity(hwnd)
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
        # 把窗口对象放进模块级容器，JS 端 move/resize 才生效
        _STATE["window"] = window
        # on_started 可能在窗口真正可见之前触发，这里最多重试 20 次（~10 秒）
        hwnd = None
        for _ in range(20):
            hwnd = find_main_hwnd()
            if hwnd:
                break
            time.sleep(0.5)
        if hwnd:
            _STATE["hwnd"] = hwnd
            apply_widget_styles(hwnd)
        else:
            print("[widget] 警告：未找到窗口句柄，跳过置底/防偷窥")
        threading.Thread(
            target=keep_bottom_loop, args=(stop_event,), daemon=True
        ).start()
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
