# -*- coding: utf-8 -*-
"""图形验证码接口：GET /api/captcha 返回验证码图片（注册页使用）。"""

from fastapi import APIRouter, Request

from ..audit import client_ip
from ..captcha import generate

router = APIRouter(prefix="/api", tags=["captcha"])


@router.get("/captcha")
def get_captcha(request: Request):
    """生成并返回一个图形验证码：{ id, image }，image 为 PNG 的 data URL。

    id 用于注册时回传；验证码绑定当前 IP、5 分钟过期、校验后即作废（单次使用）。
    """
    cid, image = generate(client_ip(request))
    return {"id": cid, "image": image}
