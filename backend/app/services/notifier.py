import logging
import time

from ..audit import log_action
from ..db import get_conn
from .mailer import send_security_email

logger = logging.getLogger("easytask.notifier")

# 安全邮件发送节流：同一账号同一种事件至少间隔 N 秒才发一封，
# 避免暴力破解时按每次失败狂发邮件淹没 SMTP 邮箱；仅内存态，重启即清空。
SECURITY_EMAIL_MIN_INTERVAL = 60
_last_sent: dict[tuple[str, str], float] = {}


def _get_prefs(username: str) -> dict:
    """读取该用户的安全邮件通知开关（默认全部开启）。"""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT login_success, login_failed, key_view FROM notify_prefs WHERE username=?",
            (username,),
        ).fetchone()
    if row is None:
        return {"login_success": False, "login_failed": True, "key_view": True}
    return {
        "login_success": bool(row["login_success"]),
        "login_failed": bool(row["login_failed"]),
        "key_view": bool(row["key_view"]),
    }


def _get_smtp(username: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT smtp_user, smtp_pass, notify_email FROM smtp_creds WHERE username=?",
            (username,),
        ).fetchone()
    return dict(row) if row else None


async def notify_security_event(username: str, kind: str, ip: str = "", ua: str = "") -> None:
    """按用户设置发送一条安全邮件（登录成功 / 登录失败 / 查看密钥）。

    全程 try/except：发送失败绝不影响登录/查看密钥等业务请求。
    - 未配置 SMTP / 该事件开关关闭 / 处于节流窗口内 → 直接跳过；
    - 发送成功/失败均写审计日志（email_send / email_fail），不暴露密钥明文。
    """
    try:
        prefs = _get_prefs(username)
        if not prefs.get(kind, True):
            return
        cred = _get_smtp(username)
        if not cred or not cred.get("notify_email"):
            return
        key = (username, kind)
        now = time.monotonic()
        last = _last_sent.get(key)
        if last is not None and now - last < SECURITY_EMAIL_MIN_INTERVAL:
            return
        _last_sent[key] = now
        await send_security_email(
            cred["smtp_user"], cred["smtp_pass"], cred["notify_email"],
            kind, ip or "未知IP", ua,
        )
        log_action("email_send", username=username, detail=f"安全通知[{kind}] 收件 {cred['notify_email']}；来源IP {ip or '-'}")
    except Exception as exc:  # 邮件发送失败不影响业务
        log_action(
            "email_fail", username=username,
            detail=f"安全通知[{kind}] 发送失败：{exc}",
        )
        logger.warning("发送安全通知邮件失败 username=%s kind=%s: %s", username, kind, exc)