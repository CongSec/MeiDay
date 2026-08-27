# -*- coding: utf-8 -*-
"""重复任务提醒的后端周期推进模块（与前端 repeat.ts / legalWorkday.ts 语义保持一致）。

服务器 reminders 表每行只存一条 repeat_rule（JSON），worker 发完一封邮件后
自行按规则把 reminder_time 推进到下一次；到 endAfter 或无法推进时删除该行。
本模块是纯函数，不含数据库访问。
"""
import calendar
from datetime import datetime, timedelta, timezone

TZ = timezone(timedelta(hours=8))

# 中国法定节假日 / 调休安排（按国务院公布整理，来源：timor.tech 假日 API）。
# 仅收录已有官方安排的年份；未收录年份退回“周一至周五为工作日、周六周日休息”的标准判断。
# holidays：法定休息日（含调休补休，即使落在工作日也休息）；
# makeup：调休上班日（即使落在周末也要上班）。
LEGAL_CALENDAR: dict[int, dict[str, list[str]]] = {
    2025: {
        "holidays": [
            "2025-01-01",
            "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31",
            "2025-02-01", "2025-02-02", "2025-02-03", "2025-02-04",
            "2025-04-04", "2025-04-05", "2025-04-06",
            "2025-05-01", "2025-05-02", "2025-05-03", "2025-05-04", "2025-05-05",
            "2025-05-31", "2025-06-01", "2025-06-02",
            "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-04", "2025-10-05",
            "2025-10-06", "2025-10-07", "2025-10-08",
        ],
        "makeup": ["2025-01-26", "2025-02-08", "2025-04-27", "2025-09-28", "2025-10-11"],
    },
    2026: {
        "holidays": [
            "2026-01-01", "2026-01-02", "2026-01-03",
            "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
            "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
            "2026-04-04", "2026-04-05", "2026-04-06",
            "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
            "2026-06-19", "2026-06-20", "2026-06-21",
            "2026-09-25", "2026-09-26", "2026-09-27",
            "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
            "2026-10-06", "2026-10-07",
        ],
        "makeup": ["2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10"],
    },
}


# V-001 纵深防御：与前端 TaskModal.vue 输入上限一致。DB 中可能残留历史脏数据/
# 被篡改的 repeat_rule（如超大 interval），会让 weekly 分支循环约 7n 次、或让
# daily/monthly 分支日期溢出（年份超出 strptime 范围），此处直接按“无法推进”处理。
_REPEAT_INTERVAL_MAX = 365
# weekly 分支迭代预算：合法规则最坏 7*n+7 次（n<=365 时 <2563），预算 20000 留足余量；
# 即使未来放宽 interval 上限，单次计算也始终有界。
_REPEAT_MAX_ITER = 20000


def add_days_key(date_key: str, days: int) -> str:
    dt = datetime.strptime(date_key, "%Y-%m-%d") + timedelta(days=days)
    return dt.strftime("%Y-%m-%d")


def diff_days_key(from_key: str, to_key: str) -> int:
    a = datetime.strptime(from_key, "%Y-%m-%d")
    b = datetime.strptime(to_key, "%Y-%m-%d")
    return (b - a).days


def add_days(iso: str, days: int) -> str:
    """给带 +08:00 后缀的 ISO 时间增加 N 天（保留时分秒），用于重复提醒日期顺延。

    纯日期（YYYY-MM-DD）输入保持纯日期输出，不补 T00:00:00，与前端语义一致。
    """
    dt = datetime.fromisoformat(iso)
    out = dt + timedelta(days=days)
    if "T" in iso:
        return out.isoformat(timespec="seconds")
    return out.strftime("%Y-%m-%d")


def weekday_of(date_key: str) -> int:
    """与前端 JS getDay 一致：0=周日 … 6=周六。"""
    return (datetime.strptime(date_key, "%Y-%m-%d").weekday() + 1) % 7


def add_months_key(date_key: str, months: int, day: int | None = None) -> str:
    """月份加 N 个月（YYYY-MM-DD），day 用于指定日期并自动收敛到月末。"""
    y, m, d = (int(x) for x in date_key.split("-"))
    tm = m - 1 + months
    ty = y + tm // 12
    tm %= 12
    days_in_month = calendar.monthrange(ty, tm + 1)[1]
    dd = min(day if day is not None else d, days_in_month)
    return f"{ty:04d}-{tm + 1:02d}-{dd:02d}"


def is_legal_workday(date_key: str) -> bool:
    year = int(date_key[:4])
    cal = LEGAL_CALENDAR.get(year)
    if cal:
        if date_key in cal["holidays"]:
            return False
        if date_key in cal["makeup"]:
            return True
    wd = weekday_of(date_key)
    return 1 <= wd <= 5


def next_legal_workday(date_key: str) -> str:
    cur = date_key
    for _ in range(400):
        cur = add_days_key(cur, 1)
        if is_legal_workday(cur):
            return cur
    return cur


def next_repeat_date(rule: dict, anchor: str) -> str | None:
    """计算严格晚于 anchor（YYYY-MM-DD）的下一个重复日期；无后续日期返回 None。"""
    n = max(1, int(rule.get("interval") or 1))
    if n > _REPEAT_INTERVAL_MAX:
        # V-001：超大 interval 会放大 weekly 循环次数/引发日期溢出，按“无法推进”处理
        return None
    rtype = rule.get("type")
    if rtype == "daily":
        return add_days_key(anchor, n)
    if rtype == "weekly":
        wds = sorted({int(w) for w in (rule.get("weekdays") or []) if w is not None})
        if not wds:
            return add_days_key(anchor, 7 * n)
        anchor_week = diff_days_key("1970-01-01", anchor) // 7
        for i in range(1, min(7 * n + 8, _REPEAT_MAX_ITER + 1)):
            d = add_days_key(anchor, i)
            if weekday_of(d) not in wds:
                continue
            week = diff_days_key("1970-01-01", d) // 7
            if (week - anchor_week) % n == 0:
                return d
        return None
    if rtype == "workday":
        d = add_days_key(anchor, 1)
        for _ in range(14):
            wd = weekday_of(d)
            if 1 <= wd <= 5:
                return d
            d = add_days_key(d, 1)
        return None
    if rtype == "monthly":
        day = int(rule.get("monthDay") or anchor[8:10])
        d = add_months_key(anchor, n, day)
        # 若某月天数不足被收敛到 <= anchor 的同一天，再推一个周期
        if d <= anchor:
            d = add_months_key(anchor, n * 2, day)
        return d
    if rtype == "legalWorkday":
        return next_legal_workday(anchor)
    return None


def compute_next_reminder(rule: dict, current_iso: str):
    """计算下一次提醒时间（保时刻顺延）与天数偏移；无下一次返回 (None, 0)。

    current_iso 为当前提醒行的时间（东八区 ISO），规则含 type/interval/weekdays/
    monthDay/endAfter。endAfter 已过或无法推进时返回 (None, 0)。
    """
    cur_date = current_iso[:10]
    nxt_date = next_repeat_date(rule, cur_date)
    if nxt_date is None:
        return None, 0
    end_after = rule.get("endAfter")
    if end_after and nxt_date > str(end_after):
        return None, 0
    offset = diff_days_key(cur_date, nxt_date)
    return add_days(current_iso, offset), offset
