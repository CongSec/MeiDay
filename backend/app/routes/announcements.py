from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import get_username
from ..db import get_conn

router = APIRouter(prefix="/api/announcements", tags=["announcements"])


class AnnouncementItem(BaseModel):
    id: int
    title: str
    content: str
    created_at: str


class AnnouncementListResponse(BaseModel):
    items: List[AnnouncementItem]


class ReadBody(BaseModel):
    """标记已读：把该用户的公告游标推进到 announcement_id（只前进不后退）。"""
    announcement_id: int


@router.get("/unread", response_model=AnnouncementListResponse)
def get_unread(username: str = Depends(get_username)):
    """返回该用户未读公告列表（id 升序，旧→新，供前端逐条弹窗）。

    未读 = 公告 id 大于用户的已读游标（last_seen_announcement_id）。
    新注册用户游标初始化为注册时的最新公告 id，因此不会收到历史公告。
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT last_seen_announcement_id FROM users WHERE username=?", (username,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="用户不存在")
        last_seen = row["last_seen_announcement_id"] or 0
        rows = conn.execute(
            "SELECT id, title, content, created_at FROM announcements "
            "WHERE id > ? ORDER BY id ASC",
            (last_seen,),
        ).fetchall()
        return AnnouncementListResponse(
            items=[AnnouncementItem(id=r["id"], title=r["title"], content=r["content"], created_at=r["created_at"]) for r in rows]
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
