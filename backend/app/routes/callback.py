"""消息通知回调（Webhook）：外部系统调用本接口触发邮件通知。

- GET  /api/callback?id=<10位随机数>&title=xxx&content=xxx&dst=xxx
- POST /api/callback               （JSON body 或表单：id/title/content/dst）
  公开接口，无需登录，凭 id 鉴权到对应账号；用该账号的 SMTP 配置发信。
  - title 作邮件主题、content 作邮件正文；
  - dst 可选：合法则发往 dst，缺省/留空发往账号配置的收件邮箱；
  - dst 非法或发送失败：给账号配置的收件邮箱发一封「报错回显」邮件；
    回显邮件发送失败则仅记录日志，不重试、不影响响应。

账号侧接口（需登录，供设置页展示/刷新 ID）：
- GET  /api/callback/info    查询当前账号回调 ID（无则自动生成并落库）
- POST /api/callback/refresh 重新随机生成并落库（旧 ID 立即作废）
"""

import secrets
from email.utils import parseaddr

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse

from ..audit import client_ip, log_action
from ..auth import get_username
from ..db import get_conn
from ..services.mailer import send_callback_email, send_callback_error_email

router = APIRouter(prefix="/api", tags=["callback"])


def _is_valid_email(addr: str) -> bool:
    """宽松邮箱校验：必须有 @，且 @ 后域名含点，供回调 dst 使用。"""
    addr = (addr or "").strip()
    if not addr or "@" not in addr:
        return False
    _, real = parseaddr(addr)
    if not real or "@" not in real:
        return False
    domain = real.rsplit("@", 1)[1]
    return bool(domain) and "." in domain


def _smtp_dns_hint(exc: Exception) -> str:
    """SMTP 域名解析失败（如 getaddrinfo / Name or service not known）时给出自查提示。"""
    text = str(exc).lower()
    keywords = (
        "getaddrinfo", "name or service not known", "gaierror",
        "temporary failure in name resolution", "nodename nor servname",
    )
    if any(k in text for k in keywords):
        return "（提示：服务器无法解析 SMTP 域名，多为服务器本机网络/DNS 问题；请在服务器上执行 nslookup smtp.qq.com 检查，或设置环境变量 MEIDAY_SMTP_HOST 指向可解析的 SMTP 地址）"
    return ""


def _gen_callback_id(conn) -> str:
    """生成全账号唯一的 10 位纯数字随机 ID（与既有任意账号冲突则重抽）。"""
    while True:
        candidate = f"{secrets.randbelow(10 ** 10):010d}"
        row = conn.execute(
            "SELECT 1 FROM smtp_creds WHERE callback_id=?", (candidate,)
        ).fetchone()
        if not row:
            return candidate


def _ensure_callback_id(conn, username: str) -> str:
    """返回该账号的回调 ID，不存在则生成并落库（smtp 字段保持原值）。"""
    row = conn.execute(
        "SELECT callback_id FROM smtp_creds WHERE username=?", (username,)
    ).fetchone()
    if row and row["callback_id"]:
        return row["callback_id"]
    cid = _gen_callback_id(conn)
    conn.execute(
        """INSERT INTO smtp_creds (username, smtp_user, smtp_pass, notify_email, callback_id)
           VALUES (?, '', '', '', ?)
           ON CONFLICT(username) DO UPDATE SET callback_id=excluded.callback_id""",
        (username, cid),
    )
    return cid


async def _parse_post_body(request: Request) -> dict:
    """POST 请求体解析：兼容 JSON body 与表单（application/x-www-form-urlencoded）。"""
    ctype = (request.headers.get("content-type") or "").lower()
    try:
        if "application/json" in ctype:
            data = await request.json()
            return data if isinstance(data, dict) else {}
        form = await request.form()
        return {k: str(v) for k, v in form.items()}
    except Exception:
        return {}


async def _echo_error(
    cred: dict,
    *,
    title: str,
    content: str,
    target: str,
    reason: str,
    ip: str,
    ua: str,
    username: str,
    method: str,
    path: str,
) -> None:
    """报错回显：把失败原因发往账号配置的收件邮箱；回显本身失败仅记日志。"""
    try:
        await send_callback_error_email(
            cred["smtp_user"],
            cred["smtp_pass"],
            cred["notify_email"],
            title=title,
            content=content,
            target=target,
            reason=reason,
            ip=ip,
        )
        log_action(
            "email_send", username=username, method=method, path=path, status=200,
            ip=ip, user_agent=ua, detail=f"回调报错回显 收件 {cred['notify_email']}：{reason[:120]}",
        )
    except Exception as exc:
        log_action(
            "email_fail", username=username, method=method, path=path, status=500,
            ip=ip, user_agent=ua, detail=f"回调报错回显发送失败：{exc}",
        )


async def _handle_callback(
    request: Request,
    method: str,
    path: str,
    id: str,
    title: str,
    content: str,
    dst: str,
) -> JSONResponse:
    ip = client_ip(request)
    ua = request.headers.get("user-agent", "")

    with get_conn() as conn:
        cred = conn.execute(
            "SELECT username, smtp_user, smtp_pass, notify_email FROM smtp_creds WHERE callback_id=?",
            (id,),
        ).fetchone()
    if cred is None:
        return JSONResponse(status_code=403, content={"ok": False, "detail": "无效的回调 ID"})
    username = cred["username"]
    if not (cred["smtp_user"] and cred["smtp_pass"] and cred["notify_email"]):
        return JSONResponse(
            status_code=400,
            content={"ok": False, "detail": "该账号未配置邮件发送（请先在设置页配置发件邮箱/授权码/收件邮箱）"},
        )

    target = (dst or "").strip()
    if target and not _is_valid_email(target):
        # dst 非法：不发送正文邮件，向账号收件邮箱回显报错
        await _echo_error(
            cred, title=title, content=content, target=target,
            reason="dst 邮箱格式不正确", ip=ip, ua=ua, username=username,
            method=method, path=path,
        )
        return JSONResponse(status_code=400, content={"ok": False, "detail": "dst 邮箱格式不正确"})

    to = target or cred["notify_email"]
    try:
        await send_callback_email(cred["smtp_user"], cred["smtp_pass"], to, title, content)
    except Exception as exc:
        log_action(
            "email_fail", username=username, method=method, path=path, status=500,
            ip=ip, user_agent=ua, detail=f"回调发送失败 收件 {to}：{exc}",
        )
        reason = f"邮件发送失败：{exc}{_smtp_dns_hint(exc)}"
        await _echo_error(
            cred, title=title, content=content, target=to,
            reason=reason, ip=ip, ua=ua, username=username,
            method=method, path=path,
        )
        return JSONResponse(status_code=500, content={"ok": False, "detail": "邮件发送失败"})

    log_action(
        "email_send", username=username, method=method, path=path, status=200,
        ip=ip, user_agent=ua, detail=f"回调通知 收件 {to}",
    )
    return JSONResponse(content={"ok": True, "sent_to": to})


@router.get("/callback")
async def callback_get(
    request: Request,
    id: str = Query(default=""),
    title: str = Query(default=""),
    content: str = Query(default=""),
    dst: str = Query(default=""),
):
    """公开回调入口（GET）：?id=随机数&title=主题&content=正文&dst=可选收件邮箱"""
    return await _handle_callback(request, "GET", "/api/callback", id, title, content, dst)


@router.post("/callback")
async def callback_post(request: Request):
    """公开回调入口（POST）：JSON body 或表单，字段 id/title/content/dst"""
    data = await _parse_post_body(request)
    return await _handle_callback(
        request,
        "POST",
        "/api/callback",
        str(data.get("id", "")),
        str(data.get("title", "")),
        str(data.get("content", "")),
        str(data.get("dst", "")),
    )


@router.get("/callback/info")
def get_callback_info(response: Response, username: str = Depends(get_username)):
    """查询当前账号回调 ID（无则自动生成并落库）；敏感配置，禁止缓存。"""
    response.headers["Cache-Control"] = "no-store"
    with get_conn() as conn:
        cid = _ensure_callback_id(conn, username)
    return {"id": cid}


@router.post("/callback/refresh")
def refresh_callback(response: Response, username: str = Depends(get_username)):
    """重新随机生成回调 ID 并落库：旧 ID 立即作废。"""
    response.headers["Cache-Control"] = "no-store"
    with get_conn() as conn:
        cid = _gen_callback_id(conn)
        conn.execute(
            """INSERT INTO smtp_creds (username, smtp_user, smtp_pass, notify_email, callback_id)
               VALUES (?, '', '', '', ?)
               ON CONFLICT(username) DO UPDATE SET callback_id=excluded.callback_id""",
            (username, cid),
        )
    log_action("更新回调设置", username=username, method="POST", path="/api/callback/refresh", status=200)
    return {"id": cid}
