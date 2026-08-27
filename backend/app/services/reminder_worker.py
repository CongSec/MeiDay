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

fail_counts: dict[tuple[str, str, str, str], int] = {}
suppressed: set[tuple[str, str, str, str]] = set()

# 内存状态上限：超过该数量直接整体清空，避免进程长期运行导致内存无限增长（BUG-34）
_MAX_KEYS = 1000


def _trim_state() -> None:
    """fail_counts / suppressed 只增不减会无限占用内存；超过阈值时整体重置。"""
    if len(fail_counts) > _MAX_KEYS or len(suppressed) > _MAX_KEYS:
        fail_counts.clear()
        suppressed.clear()


def _parse(t: str) -> datetime:
    dt = datetime.fromisoformat(t)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return dt


async def _run_cycle() -> None:
    _trim_state()
    now = datetime.now(TZ)
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM reminders WHERE is_reminded=0"
        ).fetchall()
        creds = {
            r["username"]: r
            for r in conn.execute("SELECT * FROM smtp_creds").fetchall()
        }

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
                cred["smtp_user"], cred["smtp_pass"], cred["notify_email"], dict(row)
            )
        except Exception as exc:
            # 发送失败：回滚占位，下个周期重试；连续失败达上限后本次运行内抑制。
            with get_conn() as conn:
                conn.execute(
                    "UPDATE reminders SET is_reminded=0 "
                    "WHERE username=? AND task_id=? AND subtask_id=? AND reminder_time=? AND is_reminded=1",
                    (row["username"], row["task_id"], row["subtask_id"], row["reminder_time"]),
                )
            fail_counts[key] = fail_counts.get(key, 0) + 1
            log_action(
                "email_fail", username=row["username"],
                detail=f"收件 {cred.get('notify_email')}；任务ID：{row['task_id']}；子任务ID：{row['subtask_id'] or '-'}；提醒时间 {row['reminder_time']}；第 {fail_counts[key]} 次失败：{exc}",
            )
            if fail_counts[key] >= FAIL_LIMIT:
                suppressed.add(key)
                log_action(
                    "email_suppressed", username=row["username"],
                    detail=f"任务ID：{row['task_id']}；子任务ID：{row['subtask_id'] or '-'}；提醒时间 {row['reminder_time']}；连续失败 {FAIL_LIMIT} 次，本次运行内停止重试",
                )
                logger.error(
                    "提醒邮件连续失败 %d 次，本次运行内停止重试 username=%s task_id=%s reminder_time=%s: %s",
                    FAIL_LIMIT, row["username"], row["task_id"], row["reminder_time"], exc,
                )
            else:
                logger.warning(
                    "发送提醒邮件失败 username=%s task_id=%s reminder_time=%s: %s",
                    row["username"], row["task_id"], row["reminder_time"], exc,
                )
            continue
        # 发送成功：清理该 key 的失败计数，避免状态无限累积。
        fail_counts.pop(key, None)
        suppressed.discard(key)
        # 发送成功：记录审计日志并写入 sent_reminders 历史，防止重复发信。
        log_action(
            "email_send", username=row["username"],
            detail=f"收件 {cred['notify_email']}；任务ID：{row['task_id']}；子任务ID：{row['subtask_id'] or '-'}；提醒时间 {row['reminder_time']}",
        )
        with get_conn() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO sent_reminders "
                "(username, task_id, subtask_id, reminder_time, sent_at) VALUES (?,?,?,?,?)",
                (row["username"], row["task_id"], row["subtask_id"], row["reminder_time"],
                 datetime.now(TZ).isoformat(timespec="seconds")),
            )

        # 重复提醒：发完本封邮件后按周期规则把 reminder_time 推进到下一次。
        # 服务器每行只存一条规则（JSON），不预注册未来 N 条提醒；
        # 用户一周不打开 App，worker 每天仍会按时推进并发信。
        # 删除任务 / 去掉重复 / 清除提醒后，同步会删除该行，全部提醒即停止。
        if row["repeat_rule"]:
            try:
                rule = json.loads(row["repeat_rule"])
                nxt, offset = compute_next_reminder(rule, row["reminder_time"])
            except Exception:
                nxt, offset = None, 0
            with get_conn() as conn:
                if nxt:
                    shifted_start = add_days(row["start_time"], offset) if row["start_time"] else row["start_time"]
                    shifted_end = add_days(row["end_time"], offset) if row["end_time"] else row["end_time"]
                    conn.execute(
                        "UPDATE reminders SET reminder_time=?, start_time=?, end_time=?, is_reminded=0 "
                        "WHERE username=? AND task_id=? AND subtask_id=? AND reminder_time=?",
                        (nxt, shifted_start, shifted_end,
                         row["username"], row["task_id"], row["subtask_id"], row["reminder_time"]),
                    )
                else:
                    # 规则结束（endAfter 已过）或无法推进：删除该提醒行，周期提醒停止
                    conn.execute(
                        "DELETE FROM reminders WHERE username=? AND task_id=? AND subtask_id=? AND reminder_time=?",
                        (row["username"], row["task_id"], row["subtask_id"], row["reminder_time"]),
                    )


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
