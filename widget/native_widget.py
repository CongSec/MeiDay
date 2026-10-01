# -*- coding: utf-8 -*-
"""native_widget.py - 桌面小组件原生渲染窗口（Windows per-pixel alpha）

用 Win32 分层窗口(UpdateLayeredWindow, 32bpp BGRA premultiplied)实现真正的
逐像素透明：圆角半透明背景 + 不透明黑色文字，背景透明度可调、可透出桌面/
其它程序。独立线程 + 消息泵，由主进程通过 set_* 线程安全接口驱动重绘。

透明语义：
  state["transparency"] ∈ [0.05, 1.0]，越大背景越透明（后面程序越清楚）。
  渲染时 panel_alpha = round((1 - transparency) * 255)。
"""
import ctypes
import threading
import time
from ctypes import wintypes

from PIL import Image, ImageDraw, ImageFont

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32

# --- 常量 ---
WS_POPUP = 0x80000000
WS_VISIBLE = 0x10000000
WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
WS_EX_TOPMOST = 0x00000008
SW_SHOWNOACTIVATE = 4
SW_HIDE = 0
ULW_ALPHA = 0x2
AC_SRC_OVER = 0x0
AC_SRC_ALPHA = 0x1
DIB_RGB_COLORS = 0
BI_RGB = 0
WDA_EXCLUDEFROMCAPTURE = 0x00000011
GWL_EXSTYLE = -20
WM_CLOSE = 0x0010

FONT_CANDIDATES_BOLD = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\msyh.ttc",
]
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\msyhbd.ttc",
]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class SIZE(ctypes.Structure):
    _fields_ = [("cx", ctypes.c_long), ("cy", ctypes.c_long)]


class BLENDFUNCTION(ctypes.Structure):
    _fields_ = [
        ("BlendOp", ctypes.c_byte),
        ("BlendFlags", ctypes.c_byte),
        ("SourceConstantAlpha", ctypes.c_byte),
        ("AlphaFormat", ctypes.c_byte),
    ]

# ---------------------------------------------------------------------------
# 显式声明全部 Win32/GDI 函数签名（restype/argtypes）。
# 关键：HDC/HBITMAP/HWND 是 64 位指针，若保持 ctypes 默认的 c_int(32 位有符号)
# 返回类型，高 32 位会被截断成负数，导致 GDI 句柄损坏、分层窗口渲染成不透明
# 白色或完全不显示。这里统一声明，保证 64 位下正确。
# ---------------------------------------------------------------------------
user32.RegisterClassW.restype = wintypes.ATOM
user32.RegisterClassW.argtypes = [ctypes.c_void_p]
user32.CreateWindowExW.restype = wintypes.HWND
user32.CreateWindowExW.argtypes = [
    wintypes.DWORD, wintypes.ATOM, wintypes.LPCWSTR, wintypes.DWORD,
    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, ctypes.c_void_p,
]
user32.SetWindowDisplayAffinity.restype = wintypes.BOOL
user32.SetWindowDisplayAffinity.argtypes = [wintypes.HWND, wintypes.DWORD]
user32.GetWindowLongW.restype = wintypes.LONG
user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.SetWindowLongW.restype = wintypes.LONG
user32.SetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.LONG]
user32.SetWindowPos.restype = wintypes.BOOL
user32.SetWindowPos.argtypes = [
    wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
    ctypes.c_int, ctypes.c_int, wintypes.UINT,
]
user32.ShowWindow.restype = wintypes.BOOL
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.UpdateLayeredWindow.restype = wintypes.BOOL
user32.UpdateLayeredWindow.argtypes = [
    wintypes.HWND, wintypes.HDC, ctypes.POINTER(POINT), ctypes.POINTER(SIZE),
    wintypes.HDC, ctypes.POINTER(POINT), wintypes.COLORREF,
    ctypes.POINTER(BLENDFUNCTION), wintypes.DWORD,
]
user32.GetDC.restype = wintypes.HDC
user32.GetDC.argtypes = [wintypes.HWND]
user32.ReleaseDC.restype = ctypes.c_int
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.DestroyWindow.restype = wintypes.BOOL
user32.DestroyWindow.argtypes = [wintypes.HWND]
user32.PeekMessageW.restype = wintypes.BOOL
user32.PeekMessageW.argtypes = [ctypes.c_void_p, wintypes.HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
user32.TranslateMessage.restype = wintypes.BOOL
user32.TranslateMessage.argtypes = [ctypes.c_void_p]
user32.DispatchMessageW.restype = wintypes.LPARAM
user32.DispatchMessageW.argtypes = [ctypes.c_void_p]
user32.IsWindowVisible.restype = wintypes.BOOL
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.GetWindowRect.restype = wintypes.BOOL
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.c_void_p]

gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateDIBSection.restype = wintypes.HBITMAP
gdi32.CreateDIBSection.argtypes = [
    wintypes.HDC, ctypes.c_void_p, wintypes.UINT,
    ctypes.POINTER(ctypes.c_void_p), ctypes.c_ulong, wintypes.DWORD,
]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.DeleteObject.restype = wintypes.BOOL
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.restype = wintypes.BOOL
gdi32.DeleteDC.argtypes = [wintypes.HDC]

kernel32.GetModuleHandleW.restype = wintypes.HMODULE
kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
kernel32.GetLastError.restype = wintypes.DWORD


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", ctypes.c_long),
        ("biHeight", ctypes.c_long),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


class MSG(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("message", wintypes.UINT),
        ("wParam", wintypes.WPARAM),
        ("lParam", wintypes.LPARAM),
        ("time", wintypes.DWORD),
        ("pt", POINT),
    ]


WNDPROC = ctypes.WINFUNCTYPE(
    wintypes.LPARAM, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
)


def _wndproc(hwnd, msg, wparam, lparam):
    if msg == WM_CLOSE:
        user32.DestroyWindow(hwnd)
        return 0
    return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

# 显式声明参数类型，避免 64 位指针/长整型在默认 c_int 下溢出
user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.DefWindowProcW.restype = wintypes.LPARAM

_WNDPROC_REF = WNDPROC(_wndproc)  # 保持引用，防止被 GC


class WNDCLASSW(ctypes.Structure):
    _fields_ = [
        ("style", wintypes.UINT),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON),
        ("hCursor", wintypes.HANDLE),
        ("hbrBackground", wintypes.HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
    ]





def _load_font(size, bold=False):
    for path in (FONT_CANDIDATES_BOLD if bold else FONT_CANDIDATES):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


class NativeWidget:
    """桌面小组件原生窗口。所有状态修改线程安全，重绘在窗口线程执行。"""

    H_MIN = 110
    H_MAX = 640
    ROUND_RADIUS = 12
    PAD_X = 14
    PAD_TOP = 12
    HEADER_H = 24
    TASK_ROW_H = 28
    PAD_BOTTOM = 12
    EMPTY_H = 92

    def __init__(self, anti_capture=True):
        self._lock = threading.Lock()
        self._anti_capture = anti_capture
        self._stop = threading.Event()
        self._render_pending = threading.Event()
        self._hwnd = None
        self._thread = None
        # 默认状态（物理像素坐标）
        self._state = {
            "visible": False,
            "x": 0,
            "y": 0,
            "width": 360,
            "transparency": 0.6,   # 背景透明度：越大越透明
            "font_size": 16,      # 任务文字基准字号（px），日期/计数按比例缩放
            "date": "",
            "count": "",
            "tasks": [],           # list[str]
            "ready": False,        # 是否已有真实数据
        }

    # ------------------------------------------------------------------
    # 对外接口（线程安全）
    # ------------------------------------------------------------------
    def start(self):
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="native-widget", daemon=True)
            self._thread.start()

    def stop(self):
        self._stop.set()
        self._render_pending.set()
        if self._thread is not None:
            self._thread.join(timeout=3)

    @property
    def hwnd(self):
        with self._lock:
            return self._hwnd

    def set_state(self, **kw):
        with self._lock:
            for k, v in kw.items():
                if k in self._state:
                    self._state[k] = v
        self._render_pending.set()

    def set_visible(self, visible):
        self.set_state(visible=bool(visible))
        # 让窗口线程尽快处理
        self._render_pending.set()

    def set_position(self, x, y):
        self.set_state(x=int(x), y=int(y))

    def set_data(self, data):
        """data: {ready, date, count, tasks}"""
        self.set_state(
            ready=bool(data.get("ready")),
            date=str(data.get("date") or ""),
            count=str(data.get("count") or ""),
            tasks=list(data.get("tasks") or []),
        )

    def set_appearance(self, width=None, transparency=None, font_size=None):
        kw = {}
        if width is not None:
            kw["width"] = int(width)
        if transparency is not None:
            kw["transparency"] = max(0.05, min(1.0, float(transparency)))
        if font_size is not None:
            kw["font_size"] = max(12, min(40, int(font_size)))
        if kw:
            self.set_state(**kw)

    def render_preview(self, width=None, transparency=None, font_size=None):
        """按当前任务数据 + 给定外观，离线合成一张与任务显示完全一致的预览图（RGBA）。

        供设置面板实时预览使用：不依赖窗口可见，直接用与 _render 相同的
        _measure/_compose 逻辑合成，保证预览所见即任务显示所见。
        """
        st = self._snapshot()
        if width is not None:
            st["width"] = int(width)
        if transparency is not None:
            st["transparency"] = max(0.05, min(1.0, float(transparency)))
        if font_size is not None:
            st["font_size"] = max(12, min(40, int(font_size)))
        w, h = self._measure(st)
        return self._compose(st, w, h)

    def apply_affinity(self):
        if not self._anti_capture:
            return
        hwnd = self.hwnd
        if hwnd:
            try:
                user32.SetWindowDisplayAffinity(ctypes.c_void_p(hwnd), WDA_EXCLUDEFROMCAPTURE)
            except Exception:
                pass

    def bring_to_bottom(self):
        hwnd = self.hwnd
        if hwnd:
            user32.SetWindowPos(hwnd, 1, 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010)  # HWND_BOTTOM, NOMOVE|NOSIZE|NOACTIVATE

    # ------------------------------------------------------------------
    # 窗口线程
    # ------------------------------------------------------------------
    def _snapshot(self):
        with self._lock:
            return dict(self._state)

    def _run(self):
        wc = WNDCLASSW()
        wc.lpfnWndProc = _WNDPROC_REF
        wc.hInstance = kernel32.GetModuleHandleW(None)
        wc.lpszClassName = "MeiDayNativeWidgetWnd"
        atom = user32.RegisterClassW(ctypes.byref(wc))
        # 防偷窥：必须在加上 WS_EX_LAYERED 之前设置亲和。
        # 原因：直接以分层窗口(ULW 逐像素透明)创建时，
        # SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) 会失败(ret=0)，
        # 防偷窥亲和无法生效。先创建非分层窗口并设置
        # 亲和，再动态加上 WS_EX_LAYERED 用 UpdateLayeredWindow
        # 逐像素渲染，两者可以兼容。
        hwnd = user32.CreateWindowExW(
            WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            atom,
            "MeiDayNativeWidget",
            WS_POPUP,  # 不先显示，由 render 控制
            0, 0, 1, 1,
            0, 0, wc.hInstance, 0,
        )
        with self._lock:
            self._hwnd = hwnd

        if self._anti_capture:
            # 防偷窥：录屏/截图时该窗口内容不可见
            try:
                user32.SetWindowDisplayAffinity(ctypes.c_void_p(hwnd), WDA_EXCLUDEFROMCAPTURE)
            except Exception:
                pass

        # 加上 WS_EX_LAYERED 启用逐像素透明渲染（亲和已设置，不会丢失）
        try:
            _ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE) | WS_EX_LAYERED
            user32.SetWindowLongW(hwnd, GWL_EXSTYLE, _ex)
        except Exception:
            pass

        while not self._stop.is_set():
            # 泵消息
            msg = MSG()
            while user32.PeekMessageW(ctypes.byref(msg), 0, 0, 0, 1):  # PM_REMOVE
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
            if self._render_pending.is_set():
                self._render_pending.clear()
                st = self._snapshot()
                if st["visible"]:
                    self._render(hwnd, st)
                else:
                    user32.ShowWindow(hwnd, SW_HIDE)
            else:
                time.sleep(0.02)

        user32.DestroyWindow(hwnd)
        with self._lock:
            self._hwnd = None

    # ------------------------------------------------------------------
    # 渲染
    # ------------------------------------------------------------------
    def _layout(self, st):
        """按基准字号(font_size)推导各区域尺寸（物理像素）。"""
        fs = int(st.get("font_size") or 16)
        fs = max(12, min(40, fs))
        return {
            "fs": fs,
            "pad_x": self.PAD_X,
            "pad_top": round(fs * 0.75),          # 12 @ fs=16
            "pad_bottom": round(fs * 0.75),       # 12 @ fs=16
            "header_h": max(20, round(fs * 1.5)), # 24 @ fs=16
            "task_row_h": max(24, round(fs * 1.75)),  # 28 @ fs=16
            "empty_h": round(fs * 5.75),          # 92 @ fs=16
            "font_date": max(12, fs + 1),
            "font_count": max(10, fs - 2),
            "font_task": fs,
            "font_empty": fs,
            "font_hint": max(10, fs - 2),
        }

    def _measure(self, st):
        """按任务数量计算高度（物理像素），并裁剪超出最大高度的行。"""
        w = int(st["width"])
        L = self._layout(st)
        tasks = st["tasks"]
        if not tasks:
            h = L["pad_top"] + L["header_h"] + L["empty_h"] + L["pad_bottom"]
            return w, min(self.H_MAX, max(self.H_MIN, h))
        h = L["pad_top"] + L["header_h"] + len(tasks) * L["task_row_h"] + L["pad_bottom"]
        h = min(self.H_MAX, max(self.H_MIN, h))
        return w, h

    def _compose(self, st, w, h):
        img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        alpha = int(round(max(0.0, min(1.0, 1.0 - st["transparency"])) * 255))
        if alpha > 0:
            d.rounded_rectangle(
                [0, 0, w - 1, h - 1], radius=self.ROUND_RADIUS, fill=(255, 255, 255, alpha)
            )
        L = self._layout(st)
        # 文字：纯黑，不透明；字号随 font_size 缩放
        font_date = _load_font(L["font_date"], bold=True)
        font_count = _load_font(L["font_count"])
        font_task = _load_font(L["font_task"])
        font_empty = _load_font(L["font_empty"], bold=True)
        font_hint = _load_font(L["font_hint"])

        txt_color = (0, 0, 0, 255)
        sub_color = (60, 60, 60, 255)
        c_off = max(1, round(L["fs"] * 3 / 16))    # 计数在日期行内的垂直偏移
        e_off = round(L["fs"] * 10 / 16)           # 空状态主文案偏移
        e_hint_off = round(L["fs"] * 34 / 16)      # 空状态提示偏移

        y = L["pad_top"]
        if st["date"]:
            d.text((L["pad_x"], y), st["date"], font=font_date, fill=txt_color)
        if st["count"]:
            cw = d.textlength(st["count"], font=font_count)
            d.text((w - L["pad_x"] - cw, y + c_off), st["count"], font=font_count, fill=sub_color)
        y += L["header_h"]

        tasks = st["tasks"]
        if not tasks:
            if st["ready"]:
                empty = "今日没有待办任务"
                hint = "到网页端创建今日任务后会自动同步"
            else:
                empty = "正在同步…"
                hint = ""
            ew = d.textlength(empty, font=font_empty)
            d.text(((w - ew) / 2, y + e_off), empty, font=font_empty, fill=txt_color)
            if hint:
                hw_ = d.textlength(hint, font=font_hint)
                d.text(((w - hw_) / 2, y + e_hint_off), hint, font=font_hint, fill=sub_color)
            return img

        avail_w = w - L["pad_x"] * 2
        for name in tasks:
            if y > h - 8:
                break
            lines = self._wrap(d, name, font_task, avail_w)
            for ln in lines[:2]:  # 每行最多两行，避免超高
                if y > h - 8:
                    break
                d.text((L["pad_x"], y), ln, font=font_task, fill=txt_color)
                y += L["task_row_h"]
        return img

    @staticmethod
    def _wrap(d, text, font, max_w):
        if d.textlength(text, font=font) <= max_w:
            return [text]
        lines, cur = [], ""
        for ch in text:
            if d.textlength(cur + ch, font=font) <= max_w:
                cur += ch
            else:
                lines.append(cur)
                cur = ch
        if cur:
            lines.append(cur)
        return lines

    def _render(self, hwnd, st):
        w, h = self._measure(st)
        img = self._compose(st, w, h)
        raw = img.tobytes()  # R,G,B,A
        n = w * h
        buf = bytearray(n * 4)
        src = bytes(raw)
        for i in range(n):
            o = i * 4
            a = src[o + 3]
            if a == 255:
                buf[o] = src[o + 2]
                buf[o + 1] = src[o + 1]
                buf[o + 2] = src[o]
                buf[o + 3] = 255
            elif a:
                buf[o] = src[o + 2] * a // 255
                buf[o + 1] = src[o + 1] * a // 255
                buf[o + 2] = src[o] * a // 255
                buf[o + 3] = a
            # a==0 保持 0

        hdc_screen = user32.GetDC(0)
        hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
        bmi = BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = w
        bmi.bmiHeader.biHeight = -h  # top-down
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 32
        bmi.bmiHeader.biCompression = BI_RGB
        bits = ctypes.c_void_p()
        hbmp = gdi32.CreateDIBSection(hdc_screen, ctypes.byref(bmi), DIB_RGB_COLORS, ctypes.byref(bits), 0, 0)
        old = gdi32.SelectObject(hdc_mem, hbmp)
        if bits.value:
            ctypes.memmove(bits, bytes(buf), len(buf))
        blend = BLENDFUNCTION(AC_SRC_OVER, 0, 255, AC_SRC_ALPHA)
        pt_dst = POINT(int(st["x"]), int(st["y"]))
        size = SIZE(w, h)
        pt_src = POINT(0, 0)
        user32.UpdateLayeredWindow(
            hwnd, hdc_screen, ctypes.byref(pt_dst), ctypes.byref(size),
            hdc_mem, ctypes.byref(pt_src), 0, ctypes.byref(blend), ULW_ALPHA,
        )
        # 确保显示且不激活
        user32.ShowWindow(hwnd, SW_SHOWNOACTIVATE)
        user32.SetWindowPos(
            hwnd, 1, 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010  # HWND_BOTTOM NOMOVE|NOSIZE|NOACTIVATE
        )
        gdi32.SelectObject(hdc_mem, old)
        gdi32.DeleteObject(hbmp)
        gdi32.DeleteDC(hdc_mem)
        user32.ReleaseDC(0, hdc_screen)




