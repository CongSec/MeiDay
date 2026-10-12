from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import get_username
from ..db import get_conn, get_unread_announcements
from ..schemas import AnnouncementItem

router = APIRouter(prefix="/api/announcements", tags=["announcements"])


class AnnouncementListResponse(BaseModel):
    items: List[AnnouncementItem]


class ReadBody(BaseModel):
    """标记已读：把该用户的公告游标推进到 announcement_id（只前进不后退）。"""
    announcement_id: int


@router.get("/unread", response_model=AnnouncementListResponse)
def get_unread(username: str = Depends(get_username)):
    """返回该用户未读公告列表（id 升序，旧→新，供逐条弹窗）。

    说明：同步轮询客户端已通过 /api/sync/state 的 announcements 字段拿到未读公告，
    本接口保留供一次性查询/其它客户端使用。
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM users WHERE username=?", (username,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="用户不存在")
        return AnnouncementListResponse(
            items=[AnnouncementItem(**a) for a in get_unread_announcements(conn, username)]
        )


@router.post("/read")
def mark_read(body: ReadBody, username: str = Depends(get_username)):
    """把已读游标推进到 announcement_id（只前进不后退）。

    客户端逐条弹窗时，每看完一条调一次本接口；乱序/并发提交以最大值为准，
    保证多设备间的已读状态一致（任何设备都不会回退已读进度）。
    """
    if body.announcement_id <= 0:
        raise HTTPException(status_code=400, detail="无效的公告 id")
    with get_conn() as conn:
        # 只前进：即使旧设备乱序提交也不会把游标拉回去
        conn.execute(
            "UPDATE users SET last_seen_announcement_id = MAX(last_seen_announcement_id, ?) "
            "WHERE username=?",
            (body.announcement_id, username),
        )
    return {"ok": True}
