import ipaddress
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Request

from .db import get_conn

TZ = timezone(timedelta(hours=8))
logger = logging.getLogger("meiday.audit")

# 日志默认保留天数（可经 settings 表调整，自动清理按此保留）
DEFAULT_LOG_RETENTION_DAYS = 30
RETENTION_KEY = "log_retention_days"

# 受信反向代理网段（配合 client_ip 取真实来源 IP，BUG-10 安全加固）。
# 默认仅信任本机回环 127.0.0.1/::1，覆盖 README 描述的「网页版走 Nginx 同源反代」部署；
# 若代理部署在其他主机/网段，可用环境变量 TRUSTED_PROXIES 追加（英文逗号分隔的 IP 或 CIDR）。
_TRUSTED_PROXY_NETWORKS = [
    ipaddress.ip_network(net.strip())
    for net in os.environ.get("TRUSTED_PROXIES", "").split(",")
    if net.strip()
]

# 中间件会审计的请求 -> 中文行为标签（未知请求回退为 "METHOD /path"）。
# 登录/注册/验证码/清理等路径被中间件跳过（见 main._SKIP_PATHS），由各路由自行留痕。
ACTION_LABELS = {
    ("POST", "/api/logout"): "登出",
    ("GET", "/api/me"): "获取用户信息",
    ("PUT", "/api/credentials"): "更新邮箱/存储凭证",
    ("POST", "/api/credentials/oss-check"): "测试 OSS 连接",
    ("PUT", "/api/reminders/sync"): "同步提醒清单",
    ("GET", "/api/logs"): "查看操作日志",
    ("GET", "/api/notify-prefs"): "查询通知设置",
    ("PUT", "/api/notify-prefs"): "更新通知设置",
}

# 后台邮件操作的行为名（非 HTTP 请求，由 reminder worker 写入）
EMAIL_ACTIONS = ("email_send", "email_fail", "email_suppressed")


def client_ip(request: Request) -> str:
    """取真实客户端 IP（审计日志、爆破统计、安全邮件均依赖此值）。

    默认使用 TCP 连接对端地址（request.client.host），它由内核给出、不可伪造；
    但部署在受信反向代理（如 README 描述的 Nginx 同源反代）后，对端恒为代理
    地址（本机通常是 127.0.0.1），直接记录将永远拿不到真实来源 IP。

    处理方式（BUG-10 安全加固：既防伪造，又能记录真实外网 IP）：
    - 仅当 TCP 对端是受信代理（本机回环或 TRUSTED_PROXIES 指定网段）时，
      才解析代理透传的 X-Forwarded-For / X-Real-IP；
    - X-Forwarded-For 取【最右侧】的合法 IP：该条目由最后一个受信代理追加，
      客户端只能伪造左侧条目、无法覆盖右侧追加项，因此拿到真实 IP 的同时防伪造；
    - 对端不是受信代理时（客户端直连后端，如 APK 直连局域网 IP），
      一律忽略转发头、用 TCP 对端地址，杜绝伪造头污染审计/爆破统计。
    """
    client = request.client
    if not client:
        return ""
    peer = _normalize_ip(client.host) or client.host
    if _is_trusted_proxy(peer):
        xff = request.headers.get("x-forwarded-for", "")
        if xff:
            for cand in reversed([s.strip() for s in xff.split(",") if s.strip()]):
                cleaned = _normalize_ip(cand)
                if cleaned:
                    return cleaned
        xri = _normalize_ip(request.headers.get("x-real-ip", ""))
        if xri:
            return xri
    return peer


def _is_trusted_proxy(host: str) -> bool:
    """判断 TCP 对端是否属于受信反向代理（本机回环或 TRUSTED_PROXIES 网段）。"""
    if not host:
        return False
    h = host.split("%")[0].strip()  # 去掉 IPv6 zone 后缀（如 fe80::1%eth0）
    if h in ("127.0.0.1", "::1", "localhost"):
        return True
    try:
        addr = ipaddress.ip_address(h)
    except ValueError:
        return False
    return any(addr in net for net in _TRUSTED_PROXY_NETWORKS)


def _normalize_ip(entry: str) -> str:
    """清洗/规范化一个 IP 条目：去掉可能的端口、校验合法、并把 IPv4-mapped IPv6
    （如 ::ffff:10.240.4.186，uvicorn/反代可能上报这种形式）统一成普通 IPv4；
    非法则返回空串（调用方回退对端地址）。"""
    s = (entry or "").strip()
    if not s:
        return ""
    # IPv6 形如 [::1]:port 或 ::1；IPv4 形如 1.2.3.4:port 或 1.2.3.4
    if s.startswith("["):
        s = s.lstrip("[").split("]")[0]
    elif s.count(":") == 1 and s.rsplit(":", 1)[1].isdigit():
        s = s.rsplit(":", 1)[0]
    try:
        addr = ipaddress.ip_address(s)
    except ValueError:
        return ""
    # ::ffff:1.2.3.4 归一化为 1.2.3.4
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        return str(addr.ipv4_mapped)
    return s

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


def _escape_like(text: str) -> str:
    """转义 LIKE 通配符，让用户输入按字面匹配（百分号 % 与下划线 _ 不再生效）。"""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _normalize_end(end: str) -> str:
    """把起止输入规范化，保证时间范围按【闭区间】命中。

    created_at 存储为秒级 ISO（如 2026-10-08T09:30:00+08:00），字符串直接可比；
    前端 datetime-local 只给到分钟（2026-10-08T09:30），若不做处理，
    `created_at <= '...T09:30'` 会漏掉该分钟内 09:30:00 之后的日志。
    因此按输入精度自动补到该区间末尾（分钟补 :59.999，秒补 .999），
    使结束值大于该时刻内任意秒级时间戳。无法识别时原样返回。
    """
    e = end.strip()
    if not e:
        return ""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", e):
        return e + ".999"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", e):
        return e + ":59.999"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", e):
        return e + "T23:59:59.999"
    return e


def query_logs(
    *,
    username: str = "",
    action: str = "",
    ip: str = "",
    security: str = "",
    start: str = "",
    end: str = "",
    keyword: str = "",
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """按时间倒序返回操作日志，支持 行为/IP/安全/时间段/关键词 过滤与分页。

    - start/end：对 created_at 闭区间过滤（end 自动补秒/毫秒保证含末区间整条日志）；
    - keyword：对 时间(含空格显示形态)/用户/行为/方式/路径/状态/IP/行为详情(detail)
      做包含匹配（LIKE，按字面匹配），任一命中即返回。
    """
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
    if security in ("0", "1"):
        where.append("is_security=?")
        params.append(int(security))
    start = start.strip()
    end = end.strip()
    if start:
        where.append("created_at >= ?")
        params.append(start)
    if end:
        where.append("created_at <= ?")
        params.append(_normalize_end(end))
    keyword = keyword.strip()
    if keyword:
        like = f"%{_escape_like(keyword)}%"
        # 时间同时匹配原始 ISO 与前端显示形态（T→空格）；状态按文本匹配（如搜 200）
        where.append(
            "("
            "username LIKE ? ESCAPE '\\' "
            "OR action LIKE ? ESCAPE '\\' "
            "OR method LIKE ? ESCAPE '\\' "
            "OR path LIKE ? ESCAPE '\\' "
            "OR ip LIKE ? ESCAPE '\\' "
            "OR detail LIKE ? ESCAPE '\\' "
            "OR created_at LIKE ? ESCAPE '\\' "
            "OR replace(created_at, 'T', ' ') LIKE ? ESCAPE '\\' "
            "OR CAST(status AS TEXT) LIKE ? ESCAPE '\\'"
            ")"
        )
        params.extend([like] * 9)
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


def get_all_usernames() -> list[str]:
    """返回全部用户名，供自动清理按用户独立保留遍历。"""
    with get_conn() as conn:
        rows = conn.execute("SELECT username FROM users ORDER BY username").fetchall()
    return [r["username"] for r in rows]


def _retention_key(username: Optional[str] = None) -> str:
    """保留设置按用户隔离：传 username 用个人 key，否则用全局默认 key。"""
    return RETENTION_KEY if not username else f"{RETENTION_KEY}:{username}"


def get_log_retention_days(username: Optional[str] = None) -> int:
    """读取日志保留天数设置（按用户隔离），未设置时回退全局默认，再回退硬编码 30 天。

    查找顺序（settings 表）：
    1. 传了 username 时先读个人 key log_retention_days:{username}；
    2. 个人未设置 → 读全局 key log_retention_days；
    3. 全局也未设置或值非法 → DEFAULT_LOG_RETENTION_DAYS（30）。
    所有取值夹在 1-365 之间。
    """
    keys = []
    if username:
        keys.append(_retention_key(username))  # 个人 key 优先
    keys.append(RETENTION_KEY)  # 全局 key 兜底
    try:
        with get_conn() as conn:
            for key in keys:
                row = conn.execute(
                    "SELECT value FROM settings WHERE key=?", (key,)
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


def delete_logs_older_than(
    days: int,
    *,
    username: Optional[str] = None,
    null_only: bool = False,
) -> int:
    """删除创建时间早于 N 天前的日志，返回删除条数。

    安全留痕：删除前先把过期日志原样复制到 audit_logs_backup 备份表
    （保留原 id，archived_at 记录归档时间；archived_by 为空串表示自动清理触发），
    随后才从 audit_logs 删除，确保自动清理后服务器侧仍保留可审计的备份。
    两步在同一事务中执行：复制失败则整体回滚，绝不清掉日志却丢备份。

    清理范围（按用户独立保留后由清理 worker 逐用户调用）：
    - username="alice"               → 只清该用户超过其保留期的日志；
    - username=None + null_only=True → 只清无用户名的系统日志（IS NULL 或空串）；
    - username=None + null_only=False → 不限定用户，按同一 cutoff 全量清理（兼容旧行为）。
    """
    cutoff = (datetime.now(TZ) - timedelta(days=days)).isoformat(timespec="seconds")
    now = datetime.now(TZ).isoformat(timespec="seconds")
    if username is not None:
        scope_sql, scope_params = "username = ?", [username]
    elif null_only:
        scope_sql, scope_params = "(username IS NULL OR username = '')", []
    else:
        scope_sql, scope_params = "1 = 1", []
    with get_conn() as conn:
        conn.execute(
            f"""INSERT OR IGNORE INTO audit_logs_backup
               (id, created_at, username, action, method, path, status, ip,
                user_agent, detail, duration_ms, is_security, is_high_risk,
                acknowledged_at, remind_count, archived_at, archived_by)
               SELECT id, created_at, username, action, method, path, status, ip,
                      user_agent, detail, duration_ms, is_security, is_high_risk,
                      acknowledged_at, remind_count, ?, ''
               FROM audit_logs WHERE {scope_sql} AND created_at < ?""",
            # 注意绑定顺序:SELECT 列里的 ?(archived_at)先于 WHERE 里的占位符,
            # 所以 now 必须排在 scope 参数之前,否则 archived_at 会被绑成 scope 值。
            [now, *scope_params, cutoff],
        )
        cur = conn.execute(
            f"DELETE FROM audit_logs WHERE {scope_sql} AND created_at < ?",
            [*scope_params, cutoff],
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
