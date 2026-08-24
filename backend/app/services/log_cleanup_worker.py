import asyncio
import logging

from ..audit import delete_logs_older_than, get_log_retention_days, log_action
from ..db import delete_sync_changes_older_than

logger = logging.getLogger("easytask.log_cleanup")

# 自动清理周期：每 6 小时一次（启动时立即执行一次）
CLEANUP_INTERVAL_HOURS = 6
# 同步协调中心事件保留期：7 天（离线设备用 full_sync 补拉；保留期内设备按增量对齐，
# 避免超期后所有设备登录即全量下载）
SYNC_CHANGES_RETENTION_HOURS = 7 * 24


async def _run_cleanup_once() -> None:
    """按当前保留设置清理过期日志；仅在有删除时才写审计日志，避免周期性噪音。"""
    try:
        days = get_log_retention_days()
        deleted = delete_logs_older_than(days)
        # 同步协调中心的事件保留 7 天：离线设备靠 full_sync 全量补拉
        delete_sync_changes_older_than(SYNC_CHANGES_RETENTION_HOURS)
        if deleted:
            log_action(
                "自动清理过期日志",
                detail=f"按保留 {days} 天自动清理 {days} 天前的日志，共删除 {deleted} 条",
            )
            logger.info("自动清理 %d 天前的日志，删除 %d 条", days, deleted)
    except Exception:
        logger.exception("日志自动清理执行异常")


async def log_cleanup_worker() -> None:
    """后台自动清理任务：启动立即执行一次，之后每 6 小时清理一次过期日志。"""
    await _run_cleanup_once()
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_HOURS * 3600)
        await _run_cleanup_once()
