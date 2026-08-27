# -*- coding: utf-8 -*-
"""点击式验证码接口：GET /api/captcha 返回验证码图片（注册页使用）。"""

import time

from fastapi import APIRouter, HTTPException, Request

from ..audit import client_ip
from ..captcha import generate

router = APIRouter(prefix="/api", tags=["captcha"])

# 验证码生成限流：每 IP 每分钟最多 30 次（防脚本高频拉图耗尽资源/内存）
_CAPTCHA_WINDOW_SECONDS = 60
_CAPTCHA_MAX_PER_WINDOW = 30
_captcha_requests: dict[str, list[float]] = {}


def _check_captcha_rate_limit(ip: str) -> None:
    now = time.monotonic()
    # 定期清理过期记录，防止内存无限增长
    if len(_captcha_requests) > 10000:
        for k, arr in list(_captcha_requests.items()):
            if not arr or now - arr[-1] >= _CAPTCHA_WINDOW_SECONDS:
                _captcha_requests.pop(k, None)
    arr = _captcha_requests.setdefault(ip, [])
    arr[:] = [t for t in arr if now - t < _CAPTCHA_WINDOW_SECONDS]
    if len(arr) >= _CAPTCHA_MAX_PER_WINDOW:
        raise HTTPException(status_code=429, detail="验证码请求过于频繁，请稍后再试")
    arr.append(now)


@router.get("/captcha")
def get_captcha(request: Request):
    """生成并返回一个点击式验证码：{ id, target, image }。

    target 是需要点击的目标符号（如 ★）；image 是 3×3 网格 PNG 的 data URL，
    用户需点击图中所有 target 格子。注册时回传点击的格子索引数组（0-8）。
    验证码绑定当前 IP、5 分钟过期、校验后即作废（单次使用）。
    """
    ip = client_ip(request)
    _check_captcha_rate_limit(ip)
    cid, image, target = generate(ip)
    return {"id": cid, "target": target, "image": image}
