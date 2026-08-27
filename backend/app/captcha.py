# -*- coding: utf-8 -*-
"""点击式验证码：防批量注册（IP 轮换批量注册的对抗手段）。

设计要点：
- 服务端渲染一张 3×3 网格图，每格一个大号几何符号（★▲●■◆✚），
  随机选一个目标符号，图中恰好 3 个目标，其余 6 格为干扰符号；
- 接口只返回图片 + 目标符号文本，不返回“哪些格子是目标”。
  脚本要得到答案必须做图像识别（与 OCR 数字验证码难度相当），真人却一眼可辨；
- 服务端内存保存“目标格子索引集合”：5 分钟过期、单次使用（校验即作废）、绑定发起 IP；
- 校验时比较“用户点击的格子索引集合”与“目标格子索引集合”是否完全一致。
"""

import base64
import io
import math
import secrets
import time

from PIL import Image, ImageDraw

# 验证码有效期 / 内存上限（防止无限增长）
CAPTCHA_TTL_SECONDS = 5 * 60
CAPTCHA_MAX_STORED = 2000

# 符号集：目标符号从这些里随机选，其余符号做干扰
SYMBOLS = ["★", "▲", "●", "■", "◆", "✚"]

# 网格配置：3×3，每张图恰好 3 个目标符号
GRID_SIZE = 3
CELL_COUNT = GRID_SIZE * GRID_SIZE
TARGET_COUNT = 3

# 每格像素尺寸（整图为 3×3 的方形图）
_CELL_PX = 120
_BG = (250, 250, 250)
_GRID_LINE = (205, 205, 205)

# 深色高对比调色板（浅底深图，真人可读性优先）
_PALETTE = [
    (214, 69, 65),   # 红
    (41, 128, 185),  # 蓝
    (39, 174, 96),   # 绿
    (142, 68, 173),  # 紫
    (211, 84, 0),    # 橙
    (0, 148, 136),   # 青
    (44, 62, 80),    # 深蓝灰
    (155, 89, 182),  # 洋紫
]


def _draw_star(draw, cx, cy, r, color):
    """五角星（外接半径 r，内切半径 0.45r）。"""
    pts = []
    for i in range(10):
        angle = -math.pi / 2 + i * math.pi / 5
        radius = r if i % 2 == 0 else r * 0.45
        pts.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    draw.polygon(pts, fill=color)


def _render_symbol_layer(symbol: str, color, cell_px: int) -> Image.Image:
    """在透明图层上居中绘制单个符号（RGBA，尺寸 = 单格大小）。"""
    layer = Image.new("RGBA", (cell_px, cell_px), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    margin = int(cell_px * 0.18)
    cx = cy = cell_px // 2
    r = (cell_px - 2 * margin) // 2
    if symbol == "★":
        _draw_star(draw, cx, cy, r, color)
    elif symbol == "▲":
        draw.polygon([(cx, cy - r), (cx - r, cy + r), (cx + r, cy + r)], fill=color)
    elif symbol == "●":
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    elif symbol == "■":
        draw.rectangle([cx - r, cy - r, cx + r, cy + r], fill=color)
    elif symbol == "◆":
        draw.polygon([(cx, cy - r), (cx - r, cy), (cx, cy + r), (cx + r, cy)], fill=color)
    elif symbol == "✚":
        t = max(2, r // 2)
        draw.rectangle([cx - t, cy - r, cx + t, cy + r], fill=color)
        draw.rectangle([cx - r, cy - t, cx + r, cy + t], fill=color)
    return layer


def _render_grid():
    """生成一局点击验证码：返回 (目标格子集合, 目标符号, 图片 data URL)。"""
    rng = secrets.SystemRandom()
    target = rng.choice(SYMBOLS)
    others = [s for s in SYMBOLS if s != target]
    cell_symbols = [target] * TARGET_COUNT + [
        rng.choice(others) for _ in range(CELL_COUNT - TARGET_COUNT)
    ]
    rng.shuffle(cell_symbols)
    targets = frozenset(i for i, s in enumerate(cell_symbols) if s == target)

    size = _CELL_PX * GRID_SIZE
    img = Image.new("RGB", (size, size), _BG)
    draw = ImageDraw.Draw(img)
    # 网格分隔线
    for i in range(1, GRID_SIZE):
        pos = i * _CELL_PX
        draw.line([(pos, 0), (pos, size)], fill=_GRID_LINE, width=1)
        draw.line([(0, pos), (size, pos)], fill=_GRID_LINE, width=1)
    # 每格绘制符号：随机颜色 + 随机旋转（对称符号旋转不可见，无副作用）
    for idx, sym in enumerate(cell_symbols):
        row, col = divmod(idx, GRID_SIZE)
        color = rng.choice(_PALETTE)
        layer = _render_symbol_layer(sym, color, _CELL_PX)
        layer = layer.rotate(
            rng.uniform(-25, 25),
            resample=Image.BICUBIC,
            expand=False,
            fillcolor=(0, 0, 0, 0),
        )
        img.paste(layer, (col * _CELL_PX, row * _CELL_PX), layer)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return targets, target, f"data:image/png;base64,{b64}"


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


def generate(ip: str = "") -> tuple[str, str, str]:
    """生成一个点击验证码：返回 (id, image data URL, 目标符号)。"""
    _purge()
    targets, target, image = _render_grid()
    cid = secrets.token_urlsafe(18)
    _captcha_store[cid] = {
        "targets": targets,
        "ip": (ip or ""),
        "expires": _now() + CAPTCHA_TTL_SECONDS,
    }
    # 内存上限保护：超限时淘汰最旧记录
    if len(_captcha_store) > CAPTCHA_MAX_STORED:
        for k in list(_captcha_store)[: len(_captcha_store) - CAPTCHA_MAX_STORED]:
            _captcha_store.pop(k, None)
    return cid, image, target


def verify(captcha_id: str, answer, ip: str = "") -> bool:
    """校验点击验证码：单次使用（无论成败都作废）+ 绑定 IP + 过期检查 + 格子集合一致。

    answer 为前端点击的格子索引数组（0-8），与目标格子集合完全一致才算通过。
    """
    if not captcha_id or answer is None:
        return False
    _purge()
    entry = _captcha_store.pop(captcha_id, None)
    if not entry:
        return False
    if entry["expires"] <= _now():
        return False
    if entry["ip"] and entry["ip"] != (ip or ""):
        return False
    if not isinstance(answer, (list, tuple, set, frozenset)):
        return False
    try:
        clicked = {int(x) for x in answer if isinstance(x, int)}
    except (TypeError, ValueError):
        return False
    # 拒绝重复点击、越界索引或混入非数字：这些都不可能是合法答案
    if len(clicked) != len(answer) or any(x < 0 or x >= CELL_COUNT for x in clicked):
        return False
    return clicked == entry["targets"]
