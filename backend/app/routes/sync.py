from fastapi import APIRouter, Depends, Query

from ..auth import get_username
from ..db import add_sync_changes, get_conn, get_sync_version
from ..schemas import SyncReportRequest, SyncStateItem, SyncStateResponse

router = APIRouter(prefix="/api/sync", tags=["sync"])

# 每次轮询最多返回多少条变更事件。客户端 2 秒轮询，正常单次间隔内不会超过几十条；
# 上限防止异常（如长时间离线后连发）时一次拉爆响应。
_STATE_LIMIT = 200


@router.post("/report")
def report(body: SyncReportRequest, username: str = Depends(get_username)):
    """客户端在某类资源 OSS 写入成功后上报变更事件。

    后端只记录"谁的数据变了"（res_type + project_id），不接触任何业务数据。
    返回该用户最新的总版本号，供上报方本地对齐。
    """
    events = [(e.res_type, e.project_id) for e in body.events]
    version = add_sync_changes(username, events)
    return {"ok": True, "version": version}


@router.get("/state", response_model=SyncStateResponse)
def state(
    since: int = Query(0, ge=0),
    username: str = Depends(get_username),
):
    """轮询接口：返回该用户的总版本号与 since 之后新增的变更事件。

    - 客户端以版本号判断是否有变化（version > 本地已同步版本 → 拉数据）；
    - changes 列出需要拉取的资源（res_type + project_id），客户端按需只拉变化部分；
    - full_sync=true 表示本地版本号落后过多（超出服务端事件保留窗口），
      应放弃增量、做一次全量同步，避免漏掉保留窗口之前的变化。
    """
    with get_conn() as conn:
        version = get_sync_version(conn, username)
        oldest = conn.execute(
            "SELECT COALESCE(MIN(id), 0) AS m FROM sync_changes WHERE username=?", (username,)
        ).fetchone()["m"]
        # 全新设备（since=0）：本地没有任何缓存/游标，由登录后的视图按需加载权威数据
        # （今日视图只拉今日相关项目、项目详情按需拉），不重放历史事件，避免登录即
        # 全量下载几十上百个项目的 tasks/trash/repeats 数据包造成 OSS 请求风暴。
        if since == 0:
            rows = []
        else:
            rows = conn.execute(
                "SELECT id, res_type, project_id, ts FROM sync_changes "
                "WHERE username=? AND id>? ORDER BY id ASC LIMIT ?",
                (username, since, _STATE_LIMIT),
            ).fetchall()
    # 服务端保留窗口内的最早事件 id。客户端 since 若指向已不存在的事件（早于 oldest，
    # 或事件已被全部清理、oldest 回到 0），说明中间有事件被删过，只给增量会漏数据，
    # 必须让客户端全量同步。全新设备（since=0）由登录/bootstrap 加载权威数据，无需强制全量。
    full_sync = since > 0 and (oldest == 0 or since < oldest)
    changes = [
        SyncStateItem(id=r["id"], res_type=r["res_type"], project_id=r["project_id"], ts=r["ts"])
        for r in rows
    ]
    return SyncStateResponse(version=version, full_sync=full_sync, changes=changes)
