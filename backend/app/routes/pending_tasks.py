"""远程任务投递的客户端接口（需登录）：网页端 / 手机 APP 认领、回执、上报失败。

- POST /api/pending-tasks/claim   认领（只发放给 client="web"；桌面小组件只读，永远领不到）
- POST /api/pending-tasks/ack     写入 OSS 成功后回执（删行）
- POST /api/pending-tasks/fail    上报失败（计数 + 日志；「无此项目」直接判失败）

新任务从哪来：外部系统调用 /api/callback 时带了 project（项目名），
后端在发完通知邮件之后把「项目名 + 标题 + 描述 + 开始时间」投递到 pending_tasks 表。
"""

from typing import List

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator

from ..audit import log_action
from ..auth import get_username
from ..services import pending_tasks as pending_svc

router = APIRouter(prefix="/api/pending-tasks", tags=["pending-tasks"])

# 单次 ack/fail 最多处理多少条，防止异常请求批量刷写
_MAX_IDS = 50


class ClaimRequest(BaseModel):
    """认领请求：client 为端类型，只有白名单内的端（web = 网页/APP）才会被发放任务。"""
    client: str = "web"

    @field_validator("client", mode="before")
    @classmethod
    def _client(cls, v):
        return (str(v or "")).strip()[:32]


class AckRequest(BaseModel):
    ids: List[str] = []

    @field_validator("ids", mode="before")
    @classmethod
    def _ids(cls, v):
        if not isinstance(v, list):
            return []
        out = []
        for item in v:
            s = str(item or "").strip()
            if s and len(s) <= 64 and s not in out:
                out.append(s)
        return out[:_MAX_IDS]


class FailRequest(BaseModel):
    id: str
    reason: str = ""

    @field_validator("id", mode="before")
    @classmethod
    def _id(cls, v):
        return str(v or "").strip()[:64]

    @field_validator("reason", mode="before")
    @classmethod
    def _reason(cls, v):
        return str(v or "").strip()[:500]


@router.post("/claim")
def claim(
    body: ClaimRequest,
    username: str = Depends(get_username),
):
    """认领待投递的远程任务。

    只有 client="web"（网页端 / 手机 APP）能认领；桌面小组件等只读端一律返回空列表，
    从接口层保证 exe 端不会写 OSS。同一行同一时刻只会被一个端拿到（原子 UPDATE + 租约）。
    """
    if not pending_svc.client_allowed(body.client):
        log_action(
            "远程任务认领被拒", username=username, path="/api/pending-tasks/claim",
            status=403, detail=f"不支持的客户端类型：{body.client}（只读端不参与投递）",
        )
        return JSONResponse(
            status_code=403,
            content={"ok": False, "detail": "该客户端不支持写入任务数据（只读端）", "items": []},
        )
    # 认领端标识：用户名 + 进程级随机串，仅用于日志与租约归属，不含任何凭证
    import uuid

    claimer = f"{username}:{uuid.uuid4().hex[:12]}"
    items = pending_svc.claim(username, body.client, claimer)
    return {"ok": True, "items": items}


@router.post("/ack")
def ack(body: AckRequest, username: str = Depends(get_username)):
    """回执：任务已写入 OSS，删除对应投递记录。返回清理条数。"""
    removed = pending_svc.ack(username, body.ids)
    return {"ok": True, "removed": removed}


@router.post("/fail")
def fail(body: FailRequest, username: str = Depends(get_username)):
    """上报一次投递失败。「无此项目」直接判失败并邮件通知；其它原因累计到上限才判失败。"""
    return pending_svc.fail(username, body.id, body.reason)
