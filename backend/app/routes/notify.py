from fastapi import APIRouter, Depends

from ..auth import get_username
from ..db import get_conn
from ..schemas import NotifyPrefs, NotifyPrefsRequest

router = APIRouter(prefix="/api", tags=["notify"])


@router.get("/notify-prefs", response_model=NotifyPrefs)
def get_notify_prefs(username: str = Depends(get_username)):
    """查询安全邮件通知开关（登录成功 / 登录失败 / 查看密钥），默认全部开启。"""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT login_success, login_failed, key_view FROM notify_prefs WHERE username=?",
            (username,),
        ).fetchone()
    if row is None:
        return NotifyPrefs()
    return NotifyPrefs(
        login_success=bool(row["login_success"]),
        login_failed=bool(row["login_failed"]),
        key_view=bool(row["key_view"]),
    )


@router.put("/notify-prefs", response_model=NotifyPrefs)
def update_notify_prefs(body: NotifyPrefsRequest, username: str = Depends(get_username)):
    """更新安全邮件通知开关：只更新提交的字段，未提交字段保持不变。"""
    cur = NotifyPrefs().model_dump()
    cur.update(get_notify_prefs(username).model_dump())
    if body.login_success is not None:
        cur["login_success"] = body.login_success
    if body.login_failed is not None:
        cur["login_failed"] = body.login_failed
    if body.key_view is not None:
        cur["key_view"] = body.key_view
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO notify_prefs (username, login_success, login_failed, key_view)
               VALUES (?,?,?,?)
               ON CONFLICT(username) DO UPDATE SET
                   login_success=excluded.login_success,
                   login_failed=excluded.login_failed,
                   key_view=excluded.key_view""",
            (username, 1 if cur["login_success"] else 0,
             1 if cur["login_failed"] else 0,
             1 if cur["key_view"] else 0),
        )
    return NotifyPrefs(**cur)