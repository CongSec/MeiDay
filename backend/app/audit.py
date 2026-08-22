import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Request

from .db import get_conn

TZ = timezone(timedelta(hours=8))
logger = logging.getLogger("easytask.audit")

# 日志默认保留天数（可经 settings 表调整，自动清理按此保留）
DEFAULT_LOG_RETENTION_DAYS = 30
RETENTION_KEY = "log_retention_days"

# 常见请求 -> 中文行为标签（未知请求回退为 "METHOD /path"）
ACTION_LABELS = {
    ("POST", "/api/login"): "登录",
    ("POST", "/api/login/legacy"): "登录迁移",
    ("POST", "/api/register"): "注册",
    ("POST", "/api/logout"): "登出",
    ("GET", "/api/me"): "获取用户信息",
    ("PUT", "/api/credentials"): "更新邮箱/存储凭证",
    ("PUT", "/api/reminders/sync"): "同步提醒清单",
    ("GET", "/api/logs"): "查看操作日志",
    ("GET", "/api/logs/actions"): "查询日志行为列表",
}

# 后台邮件操作的行为名（非 HTTP 请求，由 reminder worker 写入）
EMAIL_ACTIONS = ("email_send", "email_fail", "email_suppressed")


def client_ip(request: Request) -> str:
    """取真实客户端 IP。

    不再信任 X-Forwarded-For：该头可被任意客户端伪造，若直接取第一段，
    攻击者可把审计/爆破统计的 IP 污染成任意值（BUG-10）。直接使用 TCP
    连接对端地址（request.client.host）。若部署在受信反向代理后需记录
    真实来源 IP，应改用代理层约定的可信头并在代理侧覆盖。
    """
    client = request.client
    return client.host if client else ""


def action_label(method: str, path: str) -> str:
    return ACTION_LABELS.get((method, path), f"{method} {path}")


def log_action(
    action: str,
    *,
    username: Optional[str] = None,
    method: str = "",
    path: str = "",
    status: Optional[int] = None,
    ip: str = "",
    user_agent: str = "",
    detail: str = "",
    duration_ms: Optional[int] = None,
    is_security: bool = False,
    is_high_risk: bool = False,
) -> None:
    """写入一条审计日志。日志写入失败绝不影响业务请求。

    is_security=True 表示与账号安全相关的记录（如密码登录失败），
    数据库与服务器文件日志都会重点标注，便于排查爆破等安全事件。
    is_high_risk=True 表示更高危的操作（如"显示密钥"），日志使用
    AUDIT-HIGHRISK 前缀与更醒目的标志重点记录，便于安全审计排查。
    """
    try:
        with get_conn() as conn:
            conn.execute(
                """INSERT INTO audit_logs
                   (created_at, username, action, method, path, status, ip, user_agent, detail, duration_ms, is_security, is_high_risk)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    datetime.now(TZ).isoformat(timespec="seconds"),
                    username,
                    action,
                    method,
                    path,
                    status,
                    ip,
                    (user_agent or "")[:512],
                    (detail or "")[:2000],
                    duration_ms,
                    1 if is_security else 0,
                    1 if is_high_risk else 0,
                ),
            )
        # 成功也写一条服务器文件日志（backend/logs/app.log），便于直接 tail 查看；
        # 安全相关记录（is_security）用 WARNING 级别重点记录。
        if is_high_risk:
            prefix = "AUDIT-HIGHRISK"
        elif is_security:
            prefix = "AUDIT-SECURITY"
        else:
            prefix = "AUDIT"
        log = logger.warning if (is_security or is_high_risk) else logger.info
        log(
            "%s action=%s username=%s ip=%s method=%s path=%s status=%s duration=%sms detail=%s",
            prefix, action, username or "-", ip or "-", method or "-", path or "-",
            status if status is not None else "-",
            duration_ms if duration_ms is not None else "-",
            (detail or "")[:200],
        )
    except Exception:
        logger.exception("写入审计日志失败")


def query_logs(
    *,
    username: str = "",
    action: str = "",
    ip: str = "",
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[dict], int]:
    where: list[str] = []
    params: list = []
    if username:
        where.append("username=?")
        params.append(username)
    if action:
        where.append("action=?")
        params.append(action)
    if ip:
        where.append("ip=?")
        params.append(ip)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    with get_conn() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) FROM audit_logs {clause}", params
        ).fetchone()[0]
        rows = conn.execute(
            f"SELECT * FROM audit_logs {clause} ORDER BY id DESC LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
    return [dict(r) for r in rows], total


def _retention_key(username: Optional[str] = None) -> str:
    """保留设置按用户隔离：传 username 用个人 key，否则用全局默认 key。"""
    return RETENTION_KEY if not username else f"{RETENTION_KEY}:{username}"


def get_log_retention_days(username: Optional[str] = None) -> int:
    """读取日志保留天数设置（按用户隔离，BUG-09），未设置或非法时回退默认 30 天。"""
    try:
        with get_conn() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key=?", (_retention_key(username),)
            ).fetchone()
        if row and str(row["value"]).isdigit():
            return max(1, min(365, int(row["value"])))
    except Exception:
        logger.exception("读取日志保留天数失败")
    return DEFAULT_LOG_RETENTION_DAYS


def set_log_retention_days(days: int, username: Optional[str] = None) -> int:
    """保存日志保留天数（1-365 天），仅影响指定用户（传 username 时）或全局默认。"""
    days = max(1, min(365, int(days)))
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (_retention_key(username), str(days)),
        )
    return days


def delete_logs_older_than(days: int) -> int:
    """删除创建时间早于 N 天前的日志，返回删除条数。

    安全留痕：删除前先把过期日志原样复制到 audit_logs_backup 备份表
    （保留原 id，archived_at 记录归档时间；archived_by 为空串表示自动清理触发），
    随后才从 audit_logs 删除，确保自动清理后服务器侧仍保留可审计的备份。
    两步在同一事务中执行：复制失败则整体回滚，绝不清掉日志却丢备份。
    """
    cutoff = (datetime.now(TZ) - timedelta(days=days)).isoformat(timespec="seconds")
    now = datetime.now(TZ).isoformat(timespec="seconds")
    with get_conn() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO audit_logs_backup
               (id, created_at, username, action, method, path, status, ip,
                user_agent, detail, duration_ms, is_security, is_high_risk,
                acknowledged_at, remind_count, archived_at, archived_by)
               SELECT id, created_at, username, action, method, path, status, ip,
                      user_agent, detail, duration_ms, is_security, is_high_risk,
                      acknowledged_at, remind_count, ?, ''
               FROM audit_logs WHERE created_at < ?""",
            (now, cutoff),
        )
        cur = conn.execute(
            "DELETE FROM audit_logs WHERE created_at < ?", (cutoff,)
        )
        return cur.rowcount


def clear_user_logs(username: str) -> int:
    """清空【当前用户自己】的操作日志，返回删除条数（不影响其他用户日志）。

    安全留痕：清理执行前，先把该用户当前的全部日志原样复制到 audit_logs_backup
    备份表（保留原 id，并记录归档时间 archived_at 与触发归档的用户 archived_by），
    随后才从 audit_logs 删除，确保用户手动清理后服务器侧仍保留可审计的备份。
    两步在同一事务中执行：复制失败则整体回滚，绝不清掉日志却丢备份。
    """
    now = datetime.now(TZ).isoformat(timespec="seconds")
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO audit_logs_backup
               (id, created_at, username, action, method, path, status, ip,
                user_agent, detail, duration_ms, is_security, is_high_risk,
                acknowledged_at, remind_count, archived_at, archived_by)
               SELECT id, created_at, username, action, method, path, status, ip,
                      user_agent, detail, duration_ms, is_security, is_high_risk,
                      acknowledged_at, remind_count, ?, ?
               FROM audit_logs WHERE username=?""",
            (now, username, username),
        )
        cur = conn.execute("DELETE FROM audit_logs WHERE username=?", (username,))
        return cur.rowcount
