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
    - 存储值里【个别】条目非法 / 类型损坏 → 只丢掉这些条目，保留其余合法值，
      绝不再因为一条脏数据就把用户整个设置重置成默认；
    - 整个值不是列表（结构彻底损坏，无法判断用户原本选了什么）→ 才回退内置默认。
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key=?", (_settings_key(username),)
        ).fetchone()
    if row is None:
        return DEFAULT_QUICK_DURATIONS
    try:
        data = json.loads(row["value"])
    except Exception:
        logger.exception("读取快捷时长设置失败")
        return DEFAULT_QUICK_DURATIONS
    if not isinstance(data, list):
        # 结构损坏：没有可保留的条目，回退默认
        return DEFAULT_QUICK_DURATIONS
    out = []
    for item in data:
        # 只接受真正的整数（拒绝浮点/字符串/布尔，避免 30.5 被静默吞成 30 或 True 被当成 1）
        if not isinstance(item, int) or isinstance(item, bool):
            logger.warning("忽略非法的快捷时长条目 username=%s value=%r", username, item)
            continue
        if not (QUICK_DURATION_MIN <= item <= QUICK_DURATION_MAX):
            logger.warning("忽略越界的快捷时长条目 username=%s value=%r", username, item)
            continue
        out.append(item)
    return sorted(set(out))


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
