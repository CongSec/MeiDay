import logging

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request

from ..audit import (
    clear_user_logs,
    client_ip,
    get_log_retention_days,
    log_action,
    query_logs,
    set_log_retention_days,
)
from ..services.notifier import notify_security_event
from ..auth import get_username
from ..db import get_conn
from ..schemas import ClientLogRequest, LogRetentionRequest

router = APIRouter(prefix="/api", tags=["logs"])

logger = logging.getLogger("easytask.audit")


@router.get("/logs")
def get_logs(
    username: str = Depends(get_username),
    action: str = Query(default="", description="按行为过滤"),
    ip: str = Query(default="", description="按 IP 过滤"),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    """按时间倒序返回【当前登录用户自己】的操作日志，支持 行为/IP 过滤与分页。

    权限隔离：强制以当前会话用户过滤，其他用户（含其注册/登录等）的日志不可见。
    """
    rows, total = query_logs(username=username, action=action, ip=ip, limit=limit, offset=offset)
    return {"total": total, "offset": offset, "limit": limit, "items": rows}


@router.get("/logs/actions")
def get_log_actions(username: str = Depends(get_username)):
    """【当前登录用户自己】出现过的行为及次数（用于前端筛选下拉）。"""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT action, COUNT(*) AS cnt FROM audit_logs "
            "WHERE username=? GROUP BY action ORDER BY cnt DESC",
            (username,),
        ).fetchall()
    return {"items": [{"action": r["action"], "count": r["cnt"]} for r in rows]}


@router.post("/logs/client")
def log_client_action(
    body: ClientLogRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    username: str = Depends(get_username),
):
    """记录前端行为（任务/项目增删改、打开回收站/设置、显示密钥等）。

    由客户端在操作发生时调用；写入带用户/IP/UA 的审计日志，失败静默不影响业务。
    "显示密钥"属于高危操作（is_high_risk=True），日志中带显眼安全标志，
    并参与后续连续 3 次登录的"确认高危操作"提醒。
    """
    is_high_risk = body.action.startswith("显示密钥")
    log_action(
        body.action,
        username=username,
        method="CLIENT",
        path="/api/logs/client",
        status=200,
        ip=client_ip(request),
        user_agent=request.headers.get("user-agent", ""),
        detail=body.detail,
        is_security=is_high_risk,
        is_high_risk=is_high_risk,
    )
    if is_high_risk:
        # 查看密钥改为邮件提醒（响应后异步发送），不再弹窗
        background_tasks.add_task(
            notify_security_event, username, "key_view",
            client_ip(request), request.headers.get("user-agent", ""),
        )
    return {"ok": True}


@router.delete("/logs/all")
def delete_all_logs(username: str = Depends(get_username), request: Request = None):
    """手动清空【当前登录用户自己】的操作日志（不影响其他用户日志）。

    清空动作本身落盘到服务器文件日志 app.log 留痕。
    """
    deleted = clear_user_logs(username)
    logger.warning(
        "手动清空操作日志 username=%s ip=%s deleted=%d（仅本用户）",
        username, client_ip(request) if request else "-", deleted,
    )
    return {"ok": True, "deleted": deleted}


@router.get("/settings/log-retention")
def get_log_retention(username: str = Depends(get_username)):
    """查询日志保留天数设置（按用户隔离，默认 30 天）。"""
    return {
        "days": get_log_retention_days(username),
        "defaultDays": 30,
        "minDays": 1,
        "maxDays": 365,
    }


@router.put("/settings/log-retention")
def update_log_retention(
    body: LogRetentionRequest,
    username: str = Depends(get_username),
    request: Request = None,
):
    """修改日志保留天数（自动清理按此保留）。"""
    days = set_log_retention_days(body.days, username)
    log_action(
        "修改日志保留设置",
        username=username,
        method="PUT",
        path="/api/settings/log-retention",
        status=200,
        ip=client_ip(request) if request else "",
        user_agent=request.headers.get("user-agent", "") if request else "",
        detail=f"日志保留天数调整为 {days} 天",
    )
    return {"ok": True, "days": days}
