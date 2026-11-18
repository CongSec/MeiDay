# -*- coding: utf-8 -*-
"""
MeiDay 桌面小组件启动器（Windows 专用）

双窗口架构：
  1. 原生视图窗口（native_widget.NativeWidget，UpdateLayeredWindow 逐像素透明）：
     展示今日未完成任务。半透明白色圆角背景（透明度可调）+ 纯黑文字，
     可真实透出看到桌面 / 其它程序；始终鼠标穿透、常驻最底层、防偷窥。
  2. pywebview 设置窗口（半透明实时镜像，仅设置 / 登录时显示）：
    登录、显示/隐藏、同步、外观（透明度/宽度/字号）、拖动位置、自启动、退出。
    设置窗口 = 任务显示界面的实时镜像：宽度/透明度/字号/位置与任务显示同步，
    但可交互（不穿透点击）。

其它职责：
  - 起本机 HTTP 服务（127.0.0.1:5173）托管 widget/dist 构建产物，供设置窗口加载；
  - 托盘（pystray）：左键 = 打开设置；右键菜单 = 打开设置 / 退出；
  - 空闲自动隐藏（隐私保护，设置里可开关）：整个系统无鼠标/键盘操作持续 5 秒后
    自动隐藏常驻视图，一旦检测到输入立即恢复显示；手动隐藏优先（不被输入唤醒）；
  - 鼠标悬浮隐藏（设置里可开关）：指针停在任务卡片内 300ms 后整块隐去（完全透视
    背后窗口），移出矩形立即原样恢复；只叠加在 view 可见态之上，不改三模式，
    设置界面（settings）不参与；
  - 置顶循环：view 模式把原生视图置顶（所有应用窗口之上），并杜绝被最小化/隐藏
    （Win+D 显示桌面、Win+M 全部最小化、Aero Shake 等均不消失）；
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
import hashlib
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


def _log(msg):
    """--noconsole 打包后 print 不可见，关键排障信息写到程序同级 meiday-widget.log。"""
    try:
        with open(CONFIG_DIR / "meiday-widget.log", "a", encoding="utf-8") as f:
            f.write(time.strftime("[%Y-%m-%d %H:%M:%S] ") + str(msg) + "\n")
    except Exception:
        pass


PORT = 5173
TITLE = "MeiDay 桌面小组件"

# 设置窗口尺寸：宽度 = 任务显示宽度（随 config.widget.width 实时变，240-520），高度固定。
SETTINGS_H = 580

def _settings_size():
    """设置窗口 = 任务显示实时镜像：宽度取当前任务显示宽度，高度固定。"""
    width = int(read_config().get("widget", {}).get("width") or 360)
    width = min(520, max(240, width))
    return width, SETTINGS_H

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
    "auto_hidden": False,  # 当前 hidden 是否由「空闲自动隐藏」触发（True=可被输入唤醒）
    # 「鼠标悬浮隐藏」状态：只作用于原生视图窗口自身，不动 _STATE["mode"] 与设置窗口。
    "hover_hidden": False,   # 当前是否因指针停留而暂时隐去任务卡片
    "hover_enter_at": None,  # 指针本次进入卡片矩形的 monotonic 时刻（停留判定基准）
    "hover_outside": False,  # 指针是否已被观察到在卡片外（模式切换后需先出区才重新计时）
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
    "widget": {"opacity": 0.6, "width": 360, "posX": None, "posY": None, "autoStart": False, "fontSize": 16, "autoHide": True, "hoverHide": True},
    # 服务器配置镜像（config.json → 前端 localStorage）：旧配置无该键时由 _deep_merge 自动补默认值
    "server": {"servers": [], "active": ""},
}


def _deep_merge(dst, patch):
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_merge(dst[k], v)
        else:
            dst[k] = v


def _default_config():
    return json.loads(json.dumps(DEFAULT_CONFIG))


def widget_ua():
    try:
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography")
        try:
            guid = winreg.QueryValueEx(key, "MachineGuid")[0]
        finally:
            winreg.CloseKey(key)
        if isinstance(guid, str) and guid:
            return "MeiDay/Widget/" + hashlib.sha256(guid.encode("utf-8")).hexdigest()[:16]
    except Exception as e:
        _log(f"[widget_ua] 读取 MachineGuid 失败，回退 unknown：{e!r}")
    return "MeiDay/Widget/unknown"


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
    # 配置文件不存在（或损坏）：原子写一份默认配置，保证“没有就创建、下次直接读取”
    try:
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(_default_config(), ensure_ascii=False, indent=2), "utf-8")
        os.replace(tmp, path)
    except Exception as e:
        print("[widget] 创建默认配置失败：", e)
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
HWND_TOPMOST = -1
HWND_TOP = 0
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020

WDA_EXCLUDEFROMCAPTURE = 0x00000011


def _user32():
    return ctypes.windll.user32


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


def _idle_ms():
    """系统自最后一次鼠标/键盘输入以来的毫秒数（GetLastInputInfo，全系统生效）。
    返回 0（视为活跃）为安全默认：探测失败时不触发自动隐藏。"""
    try:
        lii = LASTINPUTINFO()
        lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
        if not _user32().GetLastInputInfo(ctypes.byref(lii)):
            return 0
        tick = ctypes.windll.kernel32.GetTickCount()
        # 两个 32 位 tick 都可能回绕，按无符号差值计算真实流逝毫秒
        return (tick - lii.dwTime) & 0xFFFFFFFF
    except Exception:
        return 0


def find_hwnds_by_pid(pid):
    """枚举某进程的可见顶层窗口，排除控制台窗口（ConsoleWindowClass）。

    用 `python run.py` 运行时进程会附带一个可见的控制台窗口，它常排在
    EnumWindows 结果最前。若把它当作设置窗口句柄，_settings_phys_width()
    会读到控制台宽度，导致原生视图与设置窗口错位。"""
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _cb(hwnd, _lparam):
        if _user32().IsWindowVisible(hwnd):
            win_pid = wintypes.DWORD()
            _user32().GetWindowThreadProcessId(hwnd, ctypes.byref(win_pid))
            if win_pid.value == pid:
                cls = ctypes.create_unicode_buffer(128)
                _user32().GetClassNameW(hwnd, cls, 128)
                if cls.value == "ConsoleWindowClass":
                    return True  # 跳过控制台窗口
                found.append(hwnd)
        return True

    _user32().EnumWindows(_cb, 0)
    return found


def find_main_hwnd():
    """优先按标题找设置窗口；找不到再退回按 PID 枚举（已排除控制台）。"""
    hwnd = _user32().FindWindowW(None, TITLE)
    if hwnd:
        return hwnd
    hwnds = find_hwnds_by_pid(os.getpid())
    # 尽量选 WebView2 / WinForms 宿主窗口，避免选到托盘 / GDI+ 等辅助窗口
    for h in hwnds:
        cls = ctypes.create_unicode_buffer(128)
        _user32().GetClassNameW(h, cls, 128)
        if "WindowsForms10" in cls.value or "WebView2" in cls.value:
            return h
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



def _restore_settings_transparency():
    """pywebview 的 win.resize() 走 SetWindowPos 改尺寸，会重置 WebView2 的
    逐像素透明合成，导致设置窗口变成不透明白底（Bug3：调宽度时透明消失）。
    原生 SW_HIDE + SW_SHOWNOACTIVATE 可恢复透明且不抢焦点（不会调用 Activate）。
    仅在窗口当前可见时执行，避免把隐藏窗口误显示出来。"""
    hwnd = _STATE.get("hwnd")
    if not hwnd:
        return
    try:
        if not _user32().IsWindowVisible(hwnd):
            return
        _user32().ShowWindow(hwnd, 0)  # SW_HIDE
        _user32().ShowWindow(hwnd, 4)  # SW_SHOWNOACTIVATE
    except Exception:
        pass


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


def _window_rect(hwnd):
    """窗口物理矩形 (left, top, right, bottom)；失败返回 None。
    全部为物理像素（进程已 SetProcessDPIAware，GetCursorPos 同为物理坐标）。"""
    rect = wintypes.RECT()
    if not _user32().GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    return int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)


def _cursor_pos():
    """当前鼠标物理坐标 (x, y)；失败返回 None。"""
    pt = wintypes.POINT()
    if not _user32().GetCursorPos(ctypes.byref(pt)):
        return None
    return int(pt.x), int(pt.y)


def _pointer_in_window(hwnd):
    """指针是否落在窗口矩形内（含边缘内侧；隐藏窗口中位置依旧有效）。"""
    pos = _cursor_pos()
    rect = _window_rect(hwnd)
    if pos is None or rect is None:
        return False
    x, y = pos
    left, top, right, bottom = rect
    return left <= x < right and top <= y < bottom


def _window_size(hwnd):
    rect = _window_rect(hwnd)
    if rect is None:
        return 0, 0
    return rect[2] - rect[0], rect[3] - rect[1]


def _dpi_scale(hwnd=None):
    """窗口所在显示器的 DPI 缩放系数（物理像素 / 逻辑像素）。"""
    hwnd = hwnd or _STATE.get("hwnd")
    try:
        dpi = _user32().GetDpiForWindow(hwnd)
        return (dpi / 96.0) if dpi else 1.0
    except Exception:
        return 1.0



def _settings_phys_width():
    """设置窗口当前物理宽度：设置窗口可见时取实际窗口宽（拖宽度滑块时反映实时值），
    隐藏时取 config 逻辑宽×DPI 推导值。不能无条件取实际窗口——pywebview 隐藏创建
    的透明窗口在首次 resize 前物理尺寸偏小（如 390 逻辑→563 而非 585），会导致
    原生视图顶部中心对齐时向左偏移。"""
    hwnd = _STATE.get("hwnd")
    if hwnd:
        try:
            if _user32().IsWindowVisible(hwnd):
                return _window_size(hwnd)[0]
        except Exception:
            pass
    scale = _dpi_scale() or 1.0
    return round(_settings_size()[0] * scale)


def _native_top_center_xy(lx, ly):
    """由设置窗口逻辑左上角 (lx, ly) 推导原生视图窗口的物理左上角，
    使两者「顶部中间」对齐：原生物理宽与设置窗口物理宽一致时即为同左上角，
    存在取整差异时以顶部中间对齐为准。"""
    scale = _dpi_scale() or 1.0
    sw_phys = _settings_phys_width()
    nw = 0
    native = _native()
    if native is not None:
        try:
            nw = native.measure_size()[0]
        except Exception:
            nw = sw_phys
    if not nw:
        nw = sw_phys
    nx = round(lx * scale + (sw_phys - nw) / 2.0)
    ny = round(ly * scale)
    return nx, ny

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
        nx, ny = _native_top_center_xy(lx, ly)
        native.set_position(nx, ny)


def _hover_reset():
    """清空「鼠标悬浮隐藏」状态（模式切换 / 开关关闭时调用）。
    同时要求指针先被观察到在卡片外，才重新开始「入区停留」计时：设置面板与任务
    卡片几乎完全重叠，点右上角关闭设置后指针往往正落在卡片矩形内，若不做这层
    约束，切回 view 后 300ms 卡片就被隐去，用户会以为小组件没回来。"""
    _STATE["hover_hidden"] = False
    _STATE["hover_enter_at"] = None
    _STATE["hover_outside"] = False


def _hover_apply(hidden):
    """把「悬浮隐藏」结果实际应用到原生视图窗口。
    只在 view 模式可见态下改变可见性：settings / hidden 模式的显隐由模式独占，
    这里绝不让原生卡片在设置面板上「自己冒出来」（浮层与模式切换线程存在竞态）。"""
    native = _native()
    if _STATE.get("mode") != "view":
        _STATE["hover_hidden"] = False
        return
    if native is None:
        return
    _STATE["hover_hidden"] = bool(hidden)
    native.set_visible(not hidden)
    if not hidden:
        native.bring_to_top()


def apply_mode(mode):
    """切换三模式：
    - view   ：原生视图窗口显示（鼠标穿透、置顶），设置窗口隐藏；
    - settings：设置窗口显示（可交互、置前），原生视图隐藏；
    - hidden ：两个窗口都隐藏，仅保留后台同步与托盘。

    模式切换会清空「悬浮隐藏」状态（见 _hover_reset），并要求指针先离开卡片矩形，
    之后重新入区停留才再次触发隐藏：显隐由模式决定，悬浮只叠加在 view 可见态之上。"""
    mode = mode if mode in ("view", "settings", "hidden") else "view"
    _STATE["mode"] = mode
    _hover_reset()
    win = _win()
    hwnd = _STATE.get("hwnd")
    native = _native()
    if mode == "settings":
        set_click_through(False)
        if win is not None:
            # 设置窗口 = 任务显示实时镜像：宽度/位置跟随任务显示，高度固定
            w, h = _settings_size()
            win.resize(w, h)
            pos = _STATE.get("pos")
            hwnd = _STATE.get("hwnd")
            if pos and hwnd:
                scale = _dpi_scale() or 1.0
                _move_window(hwnd, int(pos[0] * scale), int(pos[1] * scale))
            win.show()
            # 原生视图窗口同步到顶部中间对齐位置（当前隐藏，恢复 view 时生效）
            if native is not None and pos:
                nx, ny = _native_top_center_xy(pos[0], pos[1])
                native.set_position(nx, ny)
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
            native.bring_to_top()
    else:  # hidden
        if win is not None:
            win.hide()
        if native is not None:
            native.set_visible(False)


def keep_topmost_loop(stop_event):
    """view 模式把原生视图窗口置顶（所有应用窗口之上），并杜绝被最小化/隐藏。
    Win+D 显示桌面、Win+M 全部最小化、Aero Shake 晃动窗口等任何最小化都不影响
    它；检测到被最小化/隐藏时用 SW_SHOWNOACTIVATE 恢复显示（不抢焦点）。
    settings 模式（可交互）不置顶，关闭设置后自动回到置顶。"""
    while not stop_event.is_set():
        try:
            if _STATE.get("mode") != "view":
                time.sleep(0.5)
                continue
            native = _native()
            hwnd = native.hwnd if native is not None else 0
            if hwnd:
                # 悬浮隐藏期间不得「复活」窗口：这里每 0.5s 的
                # IsWindowVisible → SW_SHOWNOACTIVATE 兜底会与悬浮隐藏打架，
                # 让指针停留 300ms 藏起来的卡片立刻闪回。悬浮隐藏由
                # hover_hide_loop 独占管理，本循环在其生效期间完全让位。
                if _STATE.get("hover_hidden"):
                    time.sleep(0.5)
                    continue
                if _user32().IsIconic(hwnd) or not _user32().IsWindowVisible(hwnd):
                    _user32().ShowWindow(hwnd, 4)  # SW_SHOWNOACTIVATE：恢复且不激活
                native.bring_to_top()
        except Exception as e:
            _log(f"[keep_topmost] {e!r}")
        time.sleep(0.5)


# ---------------------------------------------------------------------------
# 空闲自动隐藏（隐私保护）
# ---------------------------------------------------------------------------
IDLE_HIDE_MS = 5000    # 整个系统无鼠标/键盘操作持续多久后自动隐藏
IDLE_POLL_S = 0.25     # 轮询间隔，也是「检测到输入后立即恢复显示」的响应延迟上限


def idle_hide_loop(stop_event):
    """隐私保护：整个系统无鼠标/键盘操作持续 IDLE_HIDE_MS 后自动隐藏常驻视图，
    一旦检测到新输入立即恢复显示（复用 apply_mode 的 view/hidden 切换）。
    - 仅 view 模式参与；设置窗口（settings 模式）不参与；
    - 手动隐藏优先：_STATE["auto_hidden"] 只由本循环置位，
      前端任何显式 set_mode（手动隐藏/打开设置/登录等）都会清除它，输入不再唤醒；
    - 开关被关闭时若正处于自动隐藏状态，恢复视图显示（避免关了开关窗口仍消失）。"""
    while not stop_event.is_set():
        time.sleep(IDLE_POLL_S)
        try:
            enabled = bool(read_config().get("widget", {}).get("autoHide", True))
            mode = _STATE.get("mode")
            idle_ms = _idle_ms()
            if enabled:
                if mode == "view" and idle_ms >= IDLE_HIDE_MS:
                    _STATE["auto_hidden"] = True
                    apply_mode("hidden")
                    _call_js("window.__setMode && window.__setMode('hidden')")
                elif mode == "hidden" and _STATE.get("auto_hidden") and idle_ms < IDLE_HIDE_MS:
                    _STATE["auto_hidden"] = False
                    apply_mode("view")
                    _call_js("window.__setMode && window.__setMode('view')")
            else:
                if _STATE.get("auto_hidden") and mode == "hidden":
                    _STATE["auto_hidden"] = False
                    apply_mode("view")
                    _call_js("window.__setMode && window.__setMode('view')")
        except Exception as e:
            _log(f"[idle_hide] {e!r}")


# ---------------------------------------------------------------------------
# 鼠标悬浮隐藏
# ---------------------------------------------------------------------------
# 原生视图窗口带 WS_EX_TRANSPARENT（鼠标穿透），收不到 WM_MOUSEMOVE，
# 因此命中判定只能由后台线程轮询 GetCursorPos 与 GetWindowRect 比对完成。
HOVER_POLL_S = 0.04        # 轮询间隔：40ms，恢复「移出即显示」的观感上限
HOVER_HIDE_DELAY_S = 0.3   # 入区停留阈值：≥300ms 才隐藏，瞬时划过不触发（防误触闪烁）
# config.json 读取节流：命中判定 40ms 一次，若每次都 read_config()（文件 IO + JSON 解析）
# 会产生 25 次/秒的无谓磁盘读；开关变化 0.5s 内生效已足够，因此每 N 轮刷新一次。
HOVER_CFG_EVERY = 12       # ≈ 12 × 40ms = 480ms


def hover_hide_loop(stop_event):
    """鼠标悬浮隐藏：指针停在任务卡片矩形内 ≥300ms 时把卡片整块隐去
    （完全透视背后窗口，鼠标本来就不拦截），指针移出矩形立即原样恢复。

    约束（与既有机制的边界）：
    - 仅 view 模式参与：settings（设置界面）与 hidden（手动/空闲隐藏）一律不动；
      设置界面期间原生卡片本就 set_visible(False)，所以「设置界面不隐藏」天然成立；
    - 只改原生窗口自身可见性，不改 _STATE["mode"] / 前端 widget.mode，
      因此不会污染「显示/隐藏小组件」按钮文案与空闲自动隐藏状态机；
    - 开关关闭：view 下立即清除悬浮状态并恢复显示（不能让卡片继续隐着）；
      settings / hidden 下只清状态——显隐由模式独占，绝不在设置面板上冒卡片；
    - 模式切换后要求指针先被观察到在卡片外，重新入区停留才计时：设置面板与卡片
      几乎完全重叠，关闭设置时指针常正好落在卡片上，否则「刚关设置卡片就消失」。"""
    tick = 0
    enabled = True
    while not stop_event.is_set():
        time.sleep(HOVER_POLL_S)
        try:
            tick += 1
            if tick % HOVER_CFG_EVERY == 1:
                enabled = bool(read_config().get("widget", {}).get("hoverHide", True))
            mode = _STATE.get("mode")
            native = _native()
            hwnd = native.hwnd if native is not None else 0
            if not enabled or mode != "view" or not hwnd:
                # 开关关闭：view 下立即恢复显示（不能让卡片继续隐着）；
                # settings / hidden：显隐由模式独占，这里只清状态，绝不 set_visible(True)。
                if _STATE.get("hover_hidden"):
                    _hover_apply(False)
                _hover_reset()
                continue

            now = time.monotonic()
            if _pointer_in_window(hwnd):
                if _STATE.get("hover_hidden"):
                    continue  # 指针仍在卡片内：保持隐藏
                # 模式切换后尚未观察到指针出区：不开始计时（避免「刚回来就消失」）
                if _STATE.get("hover_outside"):
                    t0 = _STATE.get("hover_enter_at")
                    if t0 is None:
                        _STATE["hover_enter_at"] = now
                    elif now - t0 >= HOVER_HIDE_DELAY_S:
                        _hover_apply(True)
                continue

            # 指针在卡片外：标记出区并立即恢复（移出即显示）
            _STATE["hover_outside"] = True
            _STATE["hover_enter_at"] = None
            if _STATE.get("hover_hidden"):
                _hover_apply(False)
        except Exception as e:
            _log(f"[hover_hide] {e!r}")


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
        except Exception as e:
            _log(f"[affinity] {e!r}")
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
            nx, ny = _native_top_center_xy(x, y)
            native.set_position(nx, ny)
        return True

    def resize(self, width, height):
        """仅设置窗口使用（视图窗口由原生渲染器自适应高度）。
        win.resize() 会破坏 WebView2 透明合成（变成不透明白底），随后用原生
        hide/show（不激活、不抢焦点）恢复透明。"""
        win = _win()
        if win is not None:
            win.resize(int(width), int(height))
        _restore_settings_transparency()
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
        # 前端显式切换（手动隐藏 / 打开设置 / 登录等）= 用户接管控制权：
        # 清除自动隐藏标记，此后输入不再自动唤醒（手动隐藏优先）。
        _STATE["auto_hidden"] = False
        return True

    def update_view(self, data):
        """前端把今日视图数据（日期/任务标题列表）推给原生视图窗口。"""
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
                    nx, ny = _native_top_center_xy(int(px), int(py))
                    native.set_position(nx, ny)
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
        width=_settings_size()[0],
        height=SETTINGS_H,
        frameless=True,
        transparent=True,    # 设置窗口真透明（WebView2 逐像素 alpha），由前端 CSS 控制半透明背景
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
        threading.Thread(target=keep_topmost_loop, args=(stop_event,), daemon=True).start()
        threading.Thread(target=enforce_affinity_loop, args=(stop_event,), daemon=True).start()
        threading.Thread(target=idle_hide_loop, args=(stop_event,), daemon=True).start()
        threading.Thread(target=hover_hide_loop, args=(stop_event,), daemon=True).start()

        start_tray()
        print("[widget] 桌面小组件已启动（托盘左键=设置，右键=菜单）")

    try:
        webview.start(private_mode=False, func=on_started, user_agent=widget_ua())
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
