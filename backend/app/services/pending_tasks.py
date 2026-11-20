"""远程任务投递（服务端侧）：消息通知回调带项目名时，把「要在哪个项目下建什么任务」暂存进
pending_tasks 表，由客户端认领后写入 OSS。

为什么不由服务端直接写 OSS：
  - 项目元数据（projects.json）与任务文件都在用户自己的 OSS 里，服务端不持有 OSS 凭证，
    也不应持有（凭证已加密存于 users.encrypted_creds，只有客户端用密码派生的密钥能解）；
  - 因此服务端只做「投递箱」，真正的落库由客户端完成。

端权限：
  - 只有网页端 / 手机 APP（client="web"）可以认领并写入 OSS；
  - 桌面小组件（exe）为纯只读端，永不认领（client 白名单直接拒绝），保证 exe 端零写入。

一条任务同一时刻只会被一个端认领（原子 UPDATE），因此不会出现两个端同时写同一条任务。

失败口径（与产品约定一致）：
  - 「无此项目」：客户端判定（项目名只在客户端可见），直接判失败，不重试，立即发邮件；
  - OSS 写入失败：计数 +1，不删行，租约到期后可被任意端重新认领；
  - fail_count >= FAIL_LIMIT，或入队满 TIMEOUT_HOURS 小时仍未成功（含没有任何端认领）：
    判失败并发一封失败邮件（只发一次）；
  - 判失败后记录保留、不再重试、不删除，可在网页操作日志里查到。
"""

import asyncio
import sqlite3
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from ..audit import log_action
from ..db import get_conn
from .mailer import send_pending_task_failed_email
from .notifier import make_rcpt

TZ = timezone(timedelta(hours=8))

# 认领租约（秒）：端崩溃/断网后自动过期，供其它端重新认领
CLAIM_LEASE_SEC = 60
# 每次认领最多返回几条（防止首登一次写入过多任务）
CLAIM_BATCH = 10
# 失败次数上限：达到即判失败
FAIL_LIMIT = 5
# 入队后多久仍未成功即判失败（小时），包含「没有任何端认领」的情形
TIMEOUT_HOURS = 24
# 「无此项目」：客户端能判定，重试也不会变对，直接判失败
REASON_NO_PROJECT = "无此项目"

# 允许认领的端类型白名单：只有网页/APP。桌面小组件（exe）只读，永不写入 OSS。
CLIENT_WHITELIST = {"web"}


def now_iso() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def _parse_iso(text: str) -> datetime | None:
    """解析库里的 ISO 时间（带时区）；解析失败返回 None。"""
    try:
        dt = datetime.fromisoformat((text or "").strip())
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return dt


def client_allowed(client: str) -> bool:
    return (client or "").strip().lower() in CLIENT_WHITELIST


def enqueue(
    username: str,
    *,
    project_name: str,
    title: str,
    content: str,
    start_time: str | None = None,
) -> str:
    """入队一条远程任务，返回记录 id。

    消息通知回调先照常发信，发完再调用本函数；邮件发送结果不影响入队。
    """
    rid = uuid.uuid4().hex
    ts = start_time or now_iso()
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO pending_tasks
                   (id, username, project_name, title, content, start_time, status, created_at)
               VALUES (?,?,?,?,?,?,'pending',?)""",
            (rid, username, project_name, title, content or "", ts, ts),
        )
    log_action(
        "远程任务入队",
        username=username,
        method="POST",
        path="/api/callback",
        status=200,
        detail=f"项目：{project_name}；标题：{title[:200]}；开始时间：{ts}",
    )
    return rid


def _is_no_project(reason: str) -> bool:
    return REASON_NO_PROJECT in (reason or "")


def _mark_failed(conn: sqlite3.Connection, rid: str, reason: str) -> None:
    conn.execute(
        "UPDATE pending_tasks SET status='failed', last_error=?, claimed_by=NULL, "
        "claim_expires_at=NULL WHERE id=? AND status='pending'",
        ((reason or "")[:500], rid),
    )


def _sweep_expired(conn: sqlite3.Connection, username: str) -> list[str]:
    """结算「一直失败」的待投递记录（判失败），返回新判失败的记录 id。"""
    rows = conn.execute(
        "SELECT id, fail_count, last_error, created_at FROM pending_tasks "
        "WHERE username=? AND status='pending'",
        (username,),
    ).fetchall()
    deadline = datetime.now(TZ) - timedelta(hours=TIMEOUT_HOURS)
    out: list[str] = []
    for row in rows:
        fail_count = int(row["fail_count"] or 0)
        reason = ""
        if fail_count >= FAIL_LIMIT:
            reason = f"连续失败 {fail_count} 次：{row['last_error'] or '未知原因'}"
        else:
            created = _parse_iso(row["created_at"])
            if created is not None and created <= deadline:
                last = row["last_error"] or ""
                tail = f"，最近原因：{last[:100]}" if last else "，期间可能没有任何端在线"
                reason = f"入队超过 {TIMEOUT_HOURS} 小时仍未写入 OSS（已失败 {fail_count} 次{tail}）"
        if reason:
            _mark_failed(conn, row["id"], reason)
            out.append(row["id"])
    return out


def _send_failed_email(row) -> None:
    """给账号配置的收件邮箱发一封「远程任务投递失败」邮件。发信失败仅记日志，不重试。"""
    username = row["username"]
    with get_conn() as conn:
        # 原子置位：多端并发下同一记录只发一封
        cur = conn.execute(
            "UPDATE pending_tasks SET notified=1 WHERE id=? AND notified=0", (row["id"],)
        )
        if cur.rowcount == 0:
            return
        cred = conn.execute(
            "SELECT smtp_user, smtp_pass, notify_email FROM smtp_creds WHERE username=?",
            (username,),
        ).fetchone()
    if cred is None or not (cred["smtp_user"] and cred["smtp_pass"]):
        log_action(
            "远程任务投递失败通知", username=username, path="/api/pending-tasks/fail",
            status=400, detail="账号未配置可用的发件邮箱，无法发送失败通知",
        )
        return
    rcpt = make_rcpt(dict(cred))
    if not rcpt:
        return

    async def _send() -> None:
        await send_pending_task_failed_email(
            cred["smtp_user"],
            cred["smtp_pass"],
            rcpt,
            project_name=row["project_name"],
            title=row["title"],
            content=row["content"] or "",
            start_time=row["start_time"],
            reason=row["last_error"] or "投递失败",
            fail_count=int(row["fail_count"] or 0),
        )

    def _run() -> None:
        asyncio.run(_send())

    try:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            _run()
        else:
            # 已处在事件循环中（同步路由跑在线程池里）：另起线程跑独立循环，避免嵌套
            with ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(_run).result(timeout=60)
        log_action(
            "远程任务投递失败通知", username=username, path="/api/pending-tasks/fail",
            status=200, detail=f"已发送失败通知 收件 {rcpt}；{row['last_error'] or ''}"[:500],
        )
    except Exception as exc:
        log_action(
            "远程任务投递失败通知", username=username, path="/api/pending-tasks/fail",
            status=500, detail=f"失败通知发送失败：{str(exc)[:300]}",
        )


def notify_failed(username: str, ids: list[str]) -> None:
    """对指定 id 中「已判失败且未通知」的记录发一次失败邮件。"""
    if not ids:
        return
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM pending_tasks WHERE username=? AND status='failed' AND notified=0",
            (username,),
        ).fetchall()
    for row in rows:
        _send_failed_email(row)


def claim(username: str, client: str, claimer: str) -> list[dict]:
    """原子认领最多 CLAIM_BATCH 条待投递任务；只有本端抢到的行会返回。

    先做过期结算（把「一直失败」的记录判失败并发通知），再从剩余的 pending 行里抢占。
    """
    if not client_allowed(client):
        # 只读端（如桌面小组件）或未声明端类型：不发放任何记录，也不占用
        return []
    lease_until = (datetime.now(TZ) + timedelta(seconds=CLAIM_LEASE_SEC)).isoformat(timespec="seconds")
    now = now_iso()
    with get_conn() as conn:
        newly_failed = _sweep_expired(conn, username)
        # 原子抢占：一条 pending 行只能被一个端更新成功（未被认领或租约已过期才可抢）
        cur = conn.execute(
            """UPDATE pending_tasks
                  SET claimed_by=?, claim_expires_at=?
                WHERE rowid IN (
                        SELECT rowid FROM pending_tasks
                         WHERE username=? AND status='pending'
                           AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at < ?)
                         ORDER BY created_at ASC
                         LIMIT ?)
                  AND status='pending'""",
            (claimer, lease_until, username, now, CLAIM_BATCH),
        )
        claimed = []
        if cur.rowcount:
            claimed = conn.execute(
                "SELECT * FROM pending_tasks WHERE username=? AND claimed_by=? "
                "AND claim_expires_at=? AND status='pending' ORDER BY created_at ASC",
                (username, claimer, lease_until),
            ).fetchall()
    notify_failed(username, newly_failed)
    return [
        {
            "id": row["id"],
            "project_name": row["project_name"],
            "title": row["title"],
            "content": row["content"] or "",
            "start_time": row["start_time"],
        }
        for row in claimed
    ]


def ack(username: str, ids: list[str]) -> int:
    """确认写入 OSS 成功：删行。只删属于该账号且仍是 pending 的行。"""
    if not ids:
        return 0
    removed = 0
    with get_conn() as conn:
        for rid in ids[: CLAIM_BATCH * 2]:
            cur = conn.execute(
                "DELETE FROM pending_tasks WHERE id=? AND username=? AND status='pending'",
                (rid, username),
            )
            removed += cur.rowcount
    if removed:
        log_action(
            "远程任务落库", username=username, path="/api/pending-tasks/ack",
            status=200, detail=f"写入 OSS 成功，已清理 {removed} 条待投递记录",
        )
    return removed


def fail(username: str, rid: str, reason: str) -> dict:
    """上报一次投递失败：计数 +1、写日志，并判断是否要判失败/发通知。

    「无此项目」直接判失败（不重试）；其它原因累计到 FAIL_LIMIT 次才判失败。
    """
    reason = (reason or "").strip()[:500] or "未知原因"
    should_fail = False
    count = 0
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM pending_tasks WHERE id=? AND username=? AND status='pending'",
            (rid, username),
        ).fetchone()
        if row is None:
            return {"ok": False, "detail": "记录不存在或已处理"}
        count = int(row["fail_count"] or 0) + 1
        conn.execute(
            "UPDATE pending_tasks SET fail_count=?, last_error=?, claimed_by=NULL, "
            "claim_expires_at=NULL WHERE id=?",
            (count, reason, rid),
        )
        should_fail = _is_no_project(reason) or count >= FAIL_LIMIT
        if should_fail:
            _mark_failed(conn, rid, reason)
        row = conn.execute("SELECT * FROM pending_tasks WHERE id=?", (rid,)).fetchone()
    log_action(
        "远程任务投递失败", username=username, path="/api/pending-tasks/fail", status=200,
        detail=(
            f"项目：{row['project_name']}；标题：{(row['title'] or '')[:200]}；"
            f"第 {count} 次失败；原因：{reason[:300]}"
            f"{'；已判失败' if should_fail else ''}"
        ),
    )
    if should_fail:
        notify_failed(username, [rid])
        return {"ok": True, "failed": True, "fail_count": count}
    return {"ok": True, "failed": False, "fail_count": count}
