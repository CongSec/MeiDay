# -*- coding: utf-8 -*-
"""图形验证码：防批量注册（IP 轮换批量注册的对抗手段）。

设计要点（纯标准库，不引入 Pillow，服务器无需额外安装依赖）：
- 用 zlib + struct 手写 PNG 编码器输出 RGB 位图，字体为内嵌 5x7 点阵；
- 验证码由服务端内存保存：5 分钟过期、单次使用（校验即作废）、绑定发起 IP；
- 校验时大小写不敏感，去掉易混淆字符（0/O、1/I、L）。
"""

import base64
import secrets
import struct
import time
import zlib

# 验证码有效期 / 内存上限（防止无限增长）
CAPTCHA_TTL_SECONDS = 5 * 60
CAPTCHA_MAX_STORED = 2000

# 去掉易混淆字符：0/O、1/I/L、8/B 保留可用字符集
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

# 5x7 点阵字体（每字符 7 行，每行 5 字符，'#' 为前景像素）
_FONT = {
    "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "B": ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
    "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
    "D": ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
    "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    "F": ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
    "G": [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
    "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "J": ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
    "K": ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
    "M": ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
    "N": ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
    "P": ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
    "Q": [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
    "R": ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
    "S": [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "U": ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "V": ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
    "W": ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
    "X": ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
    "Y": ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
    "Z": ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
    "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
    "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
    "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
    "5": ["#####", "#....", "####.", "....#", "....#", "....#", "####."],
    "6": [".###.", "#....", "####.", "#...#", "#...#", "#...#", ".###."],
    "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
    "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
    "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
}


def _png_bytes(width: int, height: int, pixels) -> bytes:
    """把 RGB 像素矩阵编码为 PNG（8-bit RGB，filter=0）。"""
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # 每行前置 filter type 0（None）
        for r, g, b in row:
            raw += bytes((r, g, b))
    compressed = zlib.compress(bytes(raw), 9)

    def _chunk(typ: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + typ
            + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", compressed)
        + _chunk(b"IEND", b"")
    )


def _render(code: str) -> str:
    """把验证码渲染为 PNG 的 data URL（加入扭曲/噪声/干扰线，防简单 OCR）。"""
    rng = secrets.SystemRandom()
    scale = 4
    font_w, font_h = 5, 7
    char_w = font_w * scale
    char_h = font_h * scale
    pad = scale
    gap = scale
    n = len(code)
    width = pad * 2 + n * char_w + (n - 1) * gap
    height = char_h + pad * 2
    # 随机浅色背景
    bg = (rng.randint(235, 255), rng.randint(235, 255), rng.randint(235, 255))
    # 生成每个字符的颜色与垂直抖动
    char_colors = [
        (rng.randint(20, 160), rng.randint(20, 160), rng.randint(20, 160)) for _ in code
    ]
    y_offs = [rng.randint(-scale // 2, scale // 2) for _ in code]

    canvas = [[list(bg) for _ in range(width)] for _ in range(height)]

    def _blend(x, y, color, alpha=1.0):
        if 0 <= x < width and 0 <= y < height:
            c = canvas[y][x]
            for i in range(3):
                c[i] = int(c[i] * (1 - alpha) + color[i] * alpha)

    # 正弦扭曲相位：让字符横向位置随行波动，破坏整齐网格
    phase = rng.uniform(0, 6.28)
    amp = rng.randint(1, 2)
    for ci, ch in enumerate(code):
        glyph = _FONT.get(ch)
        if not glyph:
            continue
        base_x = pad + ci * (char_w + gap)
        for row in range(font_h):
            wave = int(rng.randint(0, amp * 2) - amp)  # 每行随机横向抖动
            for col in range(font_w):
                if glyph[row][col] != "#":
                    continue
                for dy in range(scale):
                    for dx in range(scale):
                        _blend(
                            base_x + col * scale + dx + wave,
                            pad + row * scale + dy + y_offs[ci],
                            char_colors[ci],
                        )

    # 干扰线（3-5 条随机斜线）
    for _ in range(rng.randint(3, 5)):
        color = (
            rng.randint(120, 200),
            rng.randint(120, 200),
            rng.randint(120, 200),
        )
        x0, y0 = rng.randint(0, width - 1), rng.randint(0, height - 1)
        x1, y1 = rng.randint(0, width - 1), rng.randint(0, height - 1)
        steps = max(abs(x1 - x0), abs(y1 - y0), 1)
        for s in range(steps + 1):
            t = s / steps
            _blend(int(x0 + (x1 - x0) * t), int(y0 + (y1 - y0) * t), color)

    # 噪点（盐粒）
    for _ in range(width * height // 8):
        _blend(
            rng.randint(0, width - 1),
            rng.randint(0, height - 1),
            (rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255)),
            alpha=rng.uniform(0.15, 0.5),
        )

    data = _png_bytes(width, height, canvas)
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:image/png;base64,{b64}"


# ---------- 服务端存储：TTL / 单次使用 / IP 绑定 ----------

_captcha_store: dict[str, dict] = {}


def _now() -> float:
    return time.time()


def _purge() -> None:
    now = _now()
    expired = [k for k, v in _captcha_store.items() if v["expires"] <= now]
    for k in expired:
        _captcha_store.pop(k, None)


def clear_captcha_store() -> None:
    """清空全部验证码（测试用）。"""
    _captcha_store.clear()


def generate(ip: str = "") -> tuple[str, str]:
    """生成一个验证码：返回 (id, data URL)。id 用于注册时回传。"""
    _purge()
    code = "".join(secrets.choice(ALPHABET) for _ in range(4))
    cid = secrets.token_urlsafe(18)
    _captcha_store[cid] = {
        "code": code,
        "ip": (ip or ""),
        "expires": _now() + CAPTCHA_TTL_SECONDS,
    }
    # 内存上限保护：超限时淘汰最旧记录
    if len(_captcha_store) > CAPTCHA_MAX_STORED:
        for k in list(_captcha_store)[: len(_captcha_store) - CAPTCHA_MAX_STORED]:
            _captcha_store.pop(k, None)
    return cid, _render(code)


def verify(captcha_id: str, code: str, ip: str = "") -> bool:
    """校验验证码：单次使用（无论成败都作废）+ 绑定 IP + 过期检查。"""
    if not captcha_id or not code:
        return False
    _purge()
    entry = _captcha_store.pop(captcha_id, None)
    if not entry:
        return False
    if entry["expires"] <= _now():
        return False
    if entry["ip"] and entry["ip"] != (ip or ""):
        return False
    return code.strip().upper() == entry["code"]
