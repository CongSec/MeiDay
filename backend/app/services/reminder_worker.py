import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone

from ..audit import log_action
from ..db import get_conn
from .mailer import send_reminder_email
from .repeat_calendar import add_days, compute_next_reminder

TZ = timezone(timedelta(hours=8))
FAIL_LIMIT = 5

logger = logging.getLogger("meiday.reminder_worker")

# 发信失败进度（每个提醒 = username + task_id + subtask_id + reminder_time 一条）
# 持久化在 reminder_failures 表：进程重启【不会】清空，避免“重启就绕过失败上限、反复发错误邮件”。
# 内存里的 fail_counts / suppressed 只是本进程的缓存，按需从库里加载。
fail_counts: dict[tuple[str, str, str, str], int] = {}
suppressed: set[tuple[str, str, str, str]] = set()
_failures_loaded = False

# 内存状态上限：超过该数量直接整体清空缓存，避免进程长期运行导致内存无限增长（BUG-34）。
# 注意：只清内存缓存，库里仍保留真实进度，下次访问会重新加载回来。
_MAX_KEYS = 1000


def _load_failures() -> None:
    """从 reminder_failures 表加载失败进度到内存缓存（进程启动后首次使用或缓存被清空时）。"""
    global _failures_loaded
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT username, task_id, subtask_id, reminder_time, fail_count, suppressed "
            "FROM reminder_failures"
        ).fetchall()
    for r in rows:
        key = (r["username"], r["task_id"], r["subtask_id"], r["reminder_time"])
        if r["fail_count"]:
            fail_counts[key] = int(r["fail_count"])
        if r["suppressed"]:
            suppressed.add(key)
    _failures_loaded = True


def _trim_state() -> None:
    """缓存只增不减会无限占用内存；超过阈值时清空内存缓存，下次使用再从库里加载。"""
    global _failures_loaded
    if len(fail_counts) > _MAX_KEYS or len(suppressed) > _MAX_KEYS:
        fail_counts.clear()
        suppressed.clear()
        _failures_loaded = False


def _record_failure(key: tuple[str, str, str, str], count: int) -> None:
    """把失败次数落库（重启后仍生效）；达到上限时同时标记“停止重试”。"""
    username, task_id, subtask_id, reminder_time = key
    is_suppressed = 1 if key in suppressed else 0
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO reminder_failures "
            "(username, task_id, subtask_id, reminder_time, fail_count, suppressed, updated_at) "
            "VALUES (?,?,?,?,?,?,?) "
            "ON CONFLICT(username, task_id, subtask_id, reminder_time) DO UPDATE SET "
            "fail_count=excluded.fail_count, suppressed=excluded.suppressed, updated_at=excluded.updated_at",
            (username, task_id, subtask_id, reminder_time, count, is_suppressed,
             datetime.now(TZ).isoformat(timespec="seconds")),
        )


def _clear_failure(key: tuple[str, str, str, str]) -> None:
    """发送成功（或提醒已推进/删除）后清理该提醒的失败进度。"""
    username, task_id, subtask_id, reminder_time = key
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM reminder_failures WHERE username=? AND task_id=? AND subtask_id=? AND reminder_time=?",
            (username, task_id, subtask_id, reminder_time),
        )


def _parse(t: str) -> datetime:
    dt = datetime.fromisoformat(t)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return dt


def _prune_processed(rule: dict, cur_date: str) -> dict:
    """推进后剪枝：早于/等于当前提醒日的已处理日期不再需要（推进只会向前，不会回退）。"""
    kept = sorted({str(x) for x in (rule.get("processedDates") or []) if x and x > cur_date})
    out = dict(rule)
    if kept:
        out["processedDates"] = kept
    else:
        out.pop("processedDates", None)
    return out


def _advance_or_delete(conn, row: dict, rule: dict | None) -> None:
    """按周期规则把提醒行推进到下一个「未处理」重复日（跳过 processedDates 中已单日完成/删除的日期）；
    规则结束 / 无法推进 / 规则损坏时删除该行（周期提醒停止）。推进时剪掉已过的已处理日期。"""
    if not rule:
        conn.execute(
            "DELETE FROM reminders WHERE username=? AND task_id=? AND subtask_id=? AND reminder_time=?",
            (row["username"], row["task_id"], row["subtask_id"], row["reminder_time"]),
        )
        return
    nxt, offset = compute_next_reminder(rule, row["reminder_time"])
    if nxt:
        shifted_start = add_days(row["start_time"], offset) if row["start_time"] else row["start_time"]
        shifted_end = add_days(row["end_time"], offset) if row["end_time"] else row["end_time"]
        rule = _prune_processed(rule, row["reminder_time"][:10])
        conn.execute(
            "UPDATE reminders SET reminder_time=?, start_time=?, end_time=?, is_reminded=0, repeat_rule=? "
            "WHERE username=? AND task_id=? AND subtask_id=? AND reminder_time=?",
            (nxt, shifted_start, shifted_end, json.dumps(rule, ensure_ascii=False),
             row["username"], row["task_id"], row["subtask_id"], row["reminder_time"]),
        )
    else:
        conn.execute(
            "DELETE FROM reminders WHERE username=? AND task_id=? AND subtask_id=? AND reminder_time=?",
            (row["username"], row["task_id"], row["subtask_id"], row["reminder_time"]),
        )


async def _run_cycle() -> None:
    _trim_state()
    if not _failures_loaded:
        _load_failures()
    now = datetime.now(TZ)
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM reminders WHERE is_reminded=0"
        ).fetchall()
        creds = {
            r["username"]: r
            for r in conn.execute("SELECT * FROM smtp_creds").fetchall()
        }
        # 清理失败进度里已经没有对应提醒行的记录（提醒被删除/推进/完成后不再需要）：
        # 既防表无限增长，也保证同一提醒时间被重新设置时从 0 重新计数。
        conn.execute(
            "DELETE FROM reminder_failures WHERE NOT EXISTS ("
            "SELECT 1 FROM reminders r WHERE r.username=reminder_failures.username "
            "AND r.task_id=reminder_failures.task_id AND r.subtask_id=reminder_failures.subtask_id "
            "AND r.reminder_time=reminder_failures.reminder_time)"
        )

    for row in rows:
        if not row["reminder_time"]:
            continue
        key = (row["username"], row["task_id"], row["subtask_id"], row["reminder_time"])
        if key in suppressed:
            continue
        try:
            rt = _parse(row["reminder_time"])
        except ValueError:
            continue
        if rt > now:
            continue
        cred = creds.get(row["username"])
        if not cred:
            continue
        # 收件邮箱留空时用发件邮箱；发件邮箱/授权码缺失则无法发信，跳过（不报错、不重试）。
        smtp_user = (cred["smtp_user"] or "").strip()
        smtp_pass = (cred["smtp_pass"] or "").strip()
        rcpt = (cred["notify_email"] or "").strip() or smtp_user
        if not (smtp_user and smtp_pass and rcpt):
            continue
        # 路径一修复：该提醒日已被「单日完成/删除」（repeatProcessed，客户端随 repeat_rule
        # 以 processedDates 上报）——不发信，直接把行推进到下一个未处理重复日。
        # 这里也覆盖了「行已停在已处理日、客户端新规则尚未覆盖到」的竞态窗口：
        # 即便推进逻辑已跳过 processedDates，若行恰好落在已处理日上，也绝不能发信。
        if row["repeat_rule"]:
            try:
                rule = json.loads(row["repeat_rule"])
            except Exception:
                rule = None
            if rule:
                processed = {str(x) for x in (rule.get("processedDates") or [])}
                if row["reminder_time"][:10] in processed:
                    with get_conn() as conn:
                        _advance_or_delete(conn, row, rule)
                    continue
        # 原子占位：仅当该提醒仍为“未发送”且提醒时间未被改动时才标记为发送中。
        # rowcount=0 表示本周期内已被处理或行已变化，直接跳过，避免重复发送。
        with get_conn() as conn:
            cur = conn.execute(
                "UPDATE reminders SET is_reminded=1 "
                "WHERE username=? AND task_id=? AND subtask_id=? AND reminder_time=? AND is_reminded=0",
                (row["username"], row["task_id"], row["subtask_id"], row["reminder_time"]),
            )
        if cur.rowcount == 0:
            continue
        try:
            await send_reminder_email(
                smtp_user, smtp_pass, rcpt, dict(row)
            )
        except Exception as exc:
            # 发送失败：回滚占位，下个周期重试；连续失败达上限后停止重试。
            # 失败次数落库（reminder_failures），后端重启后依然生效，不会借重启无限重试。
            with get_conn() as conn:
                conn.execute(
                    "UPDATE reminders SET is_reminded=0 "
                    "WHERE username=? AND task_id=? AND subtask_id=? AND reminder_time=? AND is_reminded=1",
                    (row["username"], row["task_id"], row["subtask_id"], row["reminder_time"]),
                )
            fail_counts[key] = fail_counts.get(key, 0) + 1
            log_action(
                "email_fail", username=row["username"],
                detail=f"收件 {rcpt}；任务ID：{row['task_id']}；子任务ID：{row['subtask_id'] or '-'}；提醒时间 {row['reminder_time']}；第 {fail_counts[key]} 次失败：{exc}",
            )
            if fail_counts[key] >= FAIL_LIMIT:
                suppressed.add(key)
                log_action(
                    "email_suppressed", username=row["username"],
                    detail=f"任务ID：{row['task_id']}；子任务ID：{row['subtask_id'] or '-'}；提醒时间 {row['reminder_time']}；连续失败 {FAIL_LIMIT} 次，停止重试（重启后仍不重试）",
                )
                logger.error(
                    "提醒邮件连续失败 %d 次，停止重试 username=%s task_id=%s reminder_time=%s: %s",
                    FAIL_LIMIT, row["username"], row["task_id"], row["reminder_time"], exc,
                )
            else:
                logger.warning(
                    "发送提醒邮件失败 username=%s task_id=%s reminder_time=%s: %s",
                    row["username"], row["task_id"], row["reminder_time"], exc,
                )
            _record_failure(key, fail_counts[key])
            continue
        # 发送成功：清理该 key 的失败进度（内存 + 库），避免状态无限累积。
        fail_counts.pop(key, None)
        suppressed.discard(key)
        _clear_failure(key)
        # 发送成功：记录审计日志并写入 sent_reminders 历史，防止重复发信。
        log_action(
            "email_send", username=row["username"],
            detail=f"收件 {rcpt}；任务ID：{row['task_id']}；子任务ID：{row['subtask_id'] or '-'}；提醒时间 {row['reminder_time']}",
        )
        with get_conn() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO sent_reminders "
                "(username, task_id, subtask_id, reminder_time, sent_at) VALUES (?,?,?,?,?)",
                (row["username"], row["task_id"], row["subtask_id"], row["reminder_time"],
                 datetime.now(TZ).isoformat(timespec="seconds")),
            )

        # 重复提醒：发完本封邮件后按周期规则把 reminder_time 推进到下一次（跳过已处理日）。
        # 服务器每行只存一条规则（JSON），不预注册未来 N 条提醒；
        # 用户一周不打开 App，worker 每天仍会按时推进并发信。
        # 删除任务 / 去掉重复 / 清除提醒后，同步会删除该行，全部提醒即停止。
        if row["repeat_rule"]:
            try:
                rule = json.loads(row["repeat_rule"])
            except Exception:
                rule = None
            with get_conn() as conn:
                _advance_or_delete(conn, row, rule)
            # 提醒时间已推进到下一次：旧的失败进度不再适用，清理掉，
            # 避免“上一次连续失败被抑制”连累下一次提醒。
            _clear_failure(key)


async def reminder_worker(interval: float = 60.0) -> None:
    while True:
        try:
            await _run_cycle()
        except Exception:
            logger.exception("提醒 worker 循环执行异常")
        # 对齐到每个周期的墙钟起点（默认每分钟的第 1 秒）后再 sleep：
        # 若用固定间隔从启动时刻累计，轮询点会随时间漂移，HH:MM:00 的提醒可能
        # 拖到下一分钟才被发现；按墙钟对齐后，55 分到点的提醒会在 55:00 第 1 秒
        # 被轮询到并立即发信，误差只剩当轮处理耗时本身。
        await asyncio.sleep(max(0.0, interval - datetime.now().second % interval))
