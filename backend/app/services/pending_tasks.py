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
import threading
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

# ---------------- 「有货」快照（进程内） ----------------
# 目的：省掉客户端每 2 秒一次的空 claim。GET /api/sync/state 每轮只读地带上
# 「该用户有没有待认领的远程任务」，客户端只有标记为真时才去 claim。
#
# - 标记只在 enqueue() 真正写库成功之后置真（写库抛出异常时根本不会走到置位），
#   因此标记不会长期误报；
# - 标记的清除只发生在「本公司已经在库里做过一次读」的地方：
#   ① 客户端 claim/ack/fail 时顺带调用 _clear_if_drained（本来就在同一连接上，
#      不额外增加连接或事务）；
#   ② 进程启动后该用户第一次查询时做一次数据库实查（重启会把集合清零，
#      这一步保证重启不会永久漏掉启动前已入队的任务）。
#   注意：投递失败的行会一直保留（status 从 pending 改成 failed 但不删除），
#   所以不存在「标记来源被删掉、客户端却还在空跑 claim」的长期误报。
# - 多进程/多端互不影响：每台服务器进程各持一份集合，即便两个端同时看到「有货」
#   去 claim，也不会重复写 OSS——行级互斥仍由下面的原子 UPDATE + 租约保证。
_pending_flag: set[str] = set()
_pending_flag_lock = threading.Lock()
# 进程启动后尚未做过数据库实查的用户（重启后首次查询走实查，之后走快照）
_pending_unchecked: set[str] = set()
_pending_unchecked_lock = threading.Lock()


def _mark_pending(username: str) -> None:
    """置该用户的「有货」标记（仅内存，不抛异常）。"""
    with _pending_flag_lock:
        _pending_flag.add(username)


def _clear_pending(username: str) -> None:
    """去掉该用户的「有货」标记。"""
    with _pending_flag_lock:
        _pending_flag.discard(username)


def _flag_present(username: str) -> bool:
    with _pending_flag_lock:
        return username in _pending_flag


def _take_first_check(username: str) -> bool:
    """返回 True 表示这是本进程对该用户的第一次「有货」查询（需要数据库实查）。"""
    with _pending_unchecked_lock:
        if username in _pending_unchecked:
            return False
        _pending_unchecked.add(username)
        return True


def refresh_pending_snapshot(username: str) -> bool:
    """重新读取该用户的「有货」标记（已在 GET /api/sync/state 中调用）。

    - 进程内首次查询该用户：数据库实查一次（覆盖「启动前已入队」的任务），此后走快照；
    - 之后：纯内存读取，不访问数据库——这是「每轮只发一个请求」的前提。
    """
    first = _take_first_check(username)
    if first:
        has = False
        try:
            with get_conn() as conn:
                has = pending_exists(conn, username)
        except (sqlite3.Error, OSError):
            # 读库失败按「有货」处理：宁可让客户端多问一次 claim，也不能漏掉任务
            has = True
        if has:
            _mark_pending(username)
            return True
        return _flag_present(username)
    return _flag_present(username)


def pending_exists(conn: sqlite3.Connection, username: str) -> bool:
    """库里是否还有该用户待认领的记录（纯 SELECT，走 (username,status) 索引）。"""
    row = conn.execute(
        "SELECT 1 FROM pending_tasks WHERE username=? AND status='pending' LIMIT 1",
        (username,),
    ).fetchone()
    return row is not None


def _clear_if_drained(conn: sqlite3.Connection, username: str) -> None:
    """在已有连接上补一次读：库里已无待认领记录时清掉「有货」标记。

    只在 claim / ack / fail 里调用（这几个请求本来就要连库），因此不增加任何连接。
    读库异常时保持标记不变——宁可让客户端多问一次 claim，也不能漏掉任务。
    """
    try:
        if not pending_exists(conn, username):
            _clear_pending(username)
    except (sqlite3.Error, OSError):
        pass


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
    # 写库成功后才置「有货」标记：异常路径（上面的 INSERT 抛出）不会执行到这里，
    # 客户端也就不会被误导去空跑 claim。
    _mark_pending(username)
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
        # 顺带刷新「有货」快照：本轮没抢满（说明库里已无剩余可认领行）就清标记，
        # 下一轮 state 不再让客户端空跑 claim。认领时本来就开了库连接，这里不额外增加连接；
        # 全部行都处于「被别的端租用中」时 cur.rowcount 仍为 0，但库里确实还有 pending 行，
        # _clear_if_drained 不会清标记，租约到期后本端会继续抢。
        _clear_if_drained(conn, username)
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
        # 顺带刷新「有货」快照：删完再看一眼库里还有没有剩余 pending 行。
        if removed:
            _clear_if_drained(conn, username)
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
        # 顺带刷新「有货」快照：判失败会把该行移出 pending，若这是最后一行就立刻清标记
        _clear_if_drained(conn, username)
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
