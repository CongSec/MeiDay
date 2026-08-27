from fastapi import APIRouter, Depends

from ..auth import get_username
from ..db import get_conn
from ..schemas import NotifyPrefs, NotifyPrefsRequest

router = APIRouter(prefix="/api", tags=["notify"])


@router.get("/notify-prefs", response_model=NotifyPrefs)
def get_notify_prefs(username: str = Depends(get_username)):
    """查询安全邮件通知开关（登录成功/失败、隐私日记解锁），默认全部开启。"""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT login_success, login_failed, diary_unlock_success, diary_unlock_failed "
            "FROM notify_prefs WHERE username=?",
            (username,),
        ).fetchone()
    if row is None:
        return NotifyPrefs()
    return NotifyPrefs(
        login_success=bool(row["login_success"]),
        login_failed=bool(row["login_failed"]),
        diary_unlock_success=bool(row["diary_unlock_success"]),
        diary_unlock_failed=bool(row["diary_unlock_failed"]),
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
    if body.diary_unlock_success is not None:
        cur["diary_unlock_success"] = body.diary_unlock_success
    if body.diary_unlock_failed is not None:
        cur["diary_unlock_failed"] = body.diary_unlock_failed
    # 查看密钥、日记改密/导出/导入/删除通知不支持关闭：后端始终强制开启。
    # 前端只在隐私日记系统内暴露“进入成功/进入失败”两个开关（仅藏入口，不强制服务端）。
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO notify_prefs (username, login_success, login_failed, key_view,
                                         diary_unlock_success, diary_unlock_failed)
               VALUES (?,?,?,1,?,?)
               ON CONFLICT(username) DO UPDATE SET
                   login_success=excluded.login_success,
                   login_failed=excluded.login_failed,
                   key_view=1,
                   diary_unlock_success=excluded.diary_unlock_success,
                   diary_unlock_failed=excluded.diary_unlock_failed""",
            (username,
             1 if cur["login_success"] else 0,
             1 if cur["login_failed"] else 0,
             1 if cur["diary_unlock_success"] else 0,
             1 if cur["diary_unlock_failed"] else 0),
        )
    return NotifyPrefs(**cur)