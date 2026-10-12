import json
import logging

from fastapi import APIRouter, Depends, Response

from ..auth import get_username
from ..db import get_conn
from ..schemas import (
    DEFAULT_QUICK_DURATIONS,
    QUICK_DURATION_MAX,
    QUICK_DURATION_MIN,
    QuickDurations,
    QuickDurationsRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["quick-durations"])

# settings 表里按用户隔离的 key：quick_durations:{username}
# （照 audit.py 里 log_retention_days:{username} 的写法，个人配置存个人 key）
SETTINGS_KEY_PREFIX = "quick_durations"


def _settings_key(username: str) -> str:
    return f"{SETTINGS_KEY_PREFIX}:{username}"


def _load_durations(username: str) -> list:
    """读取某账号的快捷时长列表（分钟，升序去重）。

    - settings 表没有该账号的 key → 返回内置默认 [10, 30, 60]；
    - 已保存过但值为空数组 → 返回空数组（用户清空后不回退默认）；
    - 存储值损坏（非列表 / 含非法条目）→ 防御性回退内置默认。
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key=?", (_settings_key(username),)
        ).fetchone()
    if row is None:
        return DEFAULT_QUICK_DURATIONS
    try:
        data = json.loads(row["value"])
        if not isinstance(data, list):
            return DEFAULT_QUICK_DURATIONS
        out = []
        for item in data:
            # 只接受真正的整数（拒绝浮点/字符串截断，避免 30.5 被静默吞成 30）
            if not isinstance(item, int) or isinstance(item, bool):
                return DEFAULT_QUICK_DURATIONS
            if not (QUICK_DURATION_MIN <= item <= QUICK_DURATION_MAX):
                return DEFAULT_QUICK_DURATIONS
            out.append(item)
        return sorted(set(out))
    except Exception:
        logger.exception("读取快捷时长设置失败")
        return DEFAULT_QUICK_DURATIONS


@router.get("/quick-durations", response_model=QuickDurations)
def get_quick_durations(response: Response, username: str = Depends(get_username)):
    """查询当前账号的提醒时间快捷时长列表（分钟）；未设置时返回内置默认。"""
    # 账号级配置，禁止浏览器/CDN 缓存，避免重新进入后读到旧值
    response.headers["Cache-Control"] = "no-store"
    return QuickDurations(durations=_load_durations(username))


@router.put("/quick-durations", response_model=QuickDurations)
def update_quick_durations(body: QuickDurationsRequest, response: Response, username: str = Depends(get_username)):
    """保存当前账号的提醒时间快捷时长列表（整体覆盖，升序去重，允许清空）。"""
    response.headers["Cache-Control"] = "no-store"
    durations = body.durations
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (_settings_key(username), json.dumps(durations)),
        )
    return QuickDurations(durations=durations)
