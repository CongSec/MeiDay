import asyncio
import logging

from ..audit import (
    delete_logs_older_than,
    get_all_usernames,
    get_log_retention_days,
    log_action,
)
from ..db import delete_sync_changes_older_than

logger = logging.getLogger("meiday.log_cleanup")

# 自动清理周期：每 6 小时一次（启动时立即执行一次）
CLEANUP_INTERVAL_HOURS = 6
# 同步协调中心事件保留期：7 天（离线设备用 full_sync 补拉；保留期内设备按增量对齐，
# 避免超期后所有设备登录即全量下载）
SYNC_CHANGES_RETENTION_HOURS = 7 * 24


async def _run_cleanup_once() -> None:
    """按每用户各自的保留天数清理过期日志（未设置的用户回退全局默认）。

    清理留痕：仅在有删除时才写一条汇总审计日志，detail 列出“哪个用户按多少天
    清了多少条”，避免周期性噪音，同时保留用户粒度的可观测性。
    """
    try:
        global_days = get_log_retention_days()  # 全局默认（系统日志与未设置用户兜底）
        details: list[str] = []
        total = 0

        # 逐用户独立保留：每个用户按自己设置的保留天数清理自己的日志
        for uname in get_all_usernames():
            days = get_log_retention_days(uname)
            deleted = delete_logs_older_than(days, username=uname)
            if deleted:
                details.append(f"{uname}({days}天):{deleted}条")
                total += deleted

        # 无用户名的系统日志（如登录失败等）按全局默认保留期清理
        deleted = delete_logs_older_than(global_days, null_only=True)
        if deleted:
            details.append(f"系统日志(无用户名,{global_days}天):{deleted}条")
            total += deleted

        # 同步协调中心的事件保留 7 天：离线设备靠 full_sync 全量补拉
        delete_sync_changes_older_than(SYNC_CHANGES_RETENTION_HOURS)

        if total:
            detail = "; ".join(details) + f"; 共删除 {total} 条"
            log_action("自动清理过期日志", detail=detail)
            logger.info("日志自动清理完成: %s", detail)
    except Exception:
        logger.exception("日志自动清理执行异常")


async def log_cleanup_worker() -> None:
    """后台自动清理任务：启动立即执行一次，之后每 6 小时清理一次过期日志。"""
    await _run_cleanup_once()
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_HOURS * 3600)
        await _run_cleanup_once()
