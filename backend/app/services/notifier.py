import logging
import time

from ..audit import log_action
from ..db import get_conn
from .mailer import send_security_email

logger = logging.getLogger("meiday.notifier")

# 安全邮件发送节流：同一账号同一种事件至少间隔 N 秒才发一封，
# 避免暴力破解时按每次失败狂发邮件淹没 SMTP 邮箱；仅内存态，重启即清空。
# 注意：cred_change（加密保存临终邮件）不受节流限制，见 notify_cred_change_email。
SECURITY_EMAIL_MIN_INTERVAL = 60
_last_sent: dict[tuple[str, str], float] = {}


def _get_prefs(username: str) -> dict:
    """读取该用户的安全邮件通知开关（登录成功/失败、隐私日记解锁默认开启；查看密钥不可关闭）。

    日记改密/导出/导入/删除通知不可关闭，不设开关列：notify_security_event 里
    prefs.get(kind, True) 对未定义 key 会回退 True，天然恒开启。
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT login_success, login_failed, key_view, "
            "diary_unlock_success, diary_unlock_failed FROM notify_prefs WHERE username=?",
            (username,),
        ).fetchone()
    if row is None:
        return {
            "login_success": True, "login_failed": True, "key_view": True,
            "diary_unlock_success": True, "diary_unlock_failed": True,
        }
    return {
        "login_success": bool(row["login_success"]),
        "login_failed": bool(row["login_failed"]),
        "key_view": bool(row["key_view"]),
        "diary_unlock_success": bool(row["diary_unlock_success"]),
        "diary_unlock_failed": bool(row["diary_unlock_failed"]),
    }


def _get_smtp(username: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT smtp_user, smtp_pass, notify_email FROM smtp_creds WHERE username=?",
            (username,),
        ).fetchone()
    return dict(row) if row else None


async def notify_security_event(username: str, kind: str, ip: str = "", ua: str = "") -> None:
    """按用户设置发送一条安全邮件（登录成功/失败、查看密钥、隐私日记相关）。

    全程 try/except：发送失败绝不影响登录/查看密钥/日记等业务请求。
    - 未配置 SMTP / 该事件开关关闭 → 直接跳过；节流窗口内 → 写 email_suppressed 日志；
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
            # 节流窗口内静默跳过会让人误以为“没收到邮件”，写一条审计日志便于排查。
            # 同一账号同一事件 60 秒内只发一封，避免暴力破解时按每次失败狂发邮件。
            log_action(
                "email_suppressed",
                username=username,
                detail=f"安全通知[{kind}] 距上次发送不足 {SECURITY_EMAIL_MIN_INTERVAL} 秒，节流跳过",
            )
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


async def notify_cred_change_email(username: str, old_smtp: dict, ip: str = "", ua: str = "") -> None:
    """加密保存时的“临终”安全邮件：用【修改前】的 SMTP 配置发送。

    - old_smtp 为路由在写入新配置前同步读出的旧 smtp_creds；
    - 关键：必须用旧配置发送，否则攻击者刚改掉 SMTP 授权码后通知即失效；
    - 只要用户点击「加密保存」就发（不判断 SMTP 是否真的变了）；
    - 不受开关/节流限制，始终尝试发送（本次动作本身即是最高优先级安全事件）；
    - 发送成功/失败均写审计日志，不暴露密钥明文。
    """
    try:
        if not old_smtp or not old_smtp.get("notify_email"):
            return
        await send_security_email(
            old_smtp["smtp_user"], old_smtp["smtp_pass"], old_smtp["notify_email"],
            "cred_change", ip or "未知IP", ua,
        )
        log_action("email_send", username=username, detail=f"安全通知[cred_change] 收件 {old_smtp['notify_email']}；来源IP {ip or '-'}")
    except Exception as exc:
        log_action("email_fail", username=username, detail=f"安全通知[cred_change] 发送失败：{exc}")
        logger.warning("发送临终安全邮件失败 username=%s: %s", username, exc)
