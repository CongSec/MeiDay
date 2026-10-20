"""消息通知回调（Webhook）：外部系统调用本接口触发邮件通知。

- GET  /api/callback?id=<10位随机数>&title=xxx&content=xxx&dst=xxx
- POST /api/callback?id=<10位随机数>  （id 放 URL；title/content/dst 放请求体：JSON 或表单）
- POST /api/callback                 （id/title/content/dst 全放请求体：JSON 或表单）
  公开接口，无需登录，凭 id 鉴权到对应账号；用该账号的 SMTP 配置发信。
  - title 作邮件主题、content 作邮件正文；
  - dst 可选：合法则发往 dst，缺省/留空发往账号配置的收件邮箱；
  - dst 非法或发送失败：给账号配置的收件邮箱发一封「报错回显」邮件；
    回显邮件发送失败则仅记录日志，不重试、不影响响应。

字段别名归一化（外部系统字段名可不同，无需改造对方）：
  - content 也认 body/text/message/msg/description/summary/detail/data/payload 等；
  - title 也认 subject/heading/name/event/msg_type 等；
  - dst 也认 to/email/target/recipient 等；
  - 自动递归下探嵌套对象（如企业微信 {"text":{"content":...}}、飞书 {"content":{"text":...}}，最多 3 层）；
  - POST 未命中任何内容字段时，把整个请求体序列化作为正文兜底，保证邮件内容不为空。
  想增加识别的字段名：在下方 _TITLE_KEYS / _CONTENT_KEYS / _DST_KEYS 元组里追加即可。

账号侧接口（需登录，供设置页展示/刷新 ID）：
- GET  /api/callback/info    查询当前账号回调 ID（无则自动生成并落库）
- POST /api/callback/refresh 重新随机生成并落库（旧 ID 立即作废）
"""

import json
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


def _clip(text: str, limit: int) -> str:
    """压缩为单行并按长度截断（detail 字段整体还有 2000 字符上限）。"""
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[:limit] + "…"


def _callback_params(title: str, content: str) -> str:
    """回调请求携带的原始参数摘要，用于「外部回调触发」请求级日志（原样呈现，空值标 '(空)'）。"""
    t = _clip(title, 200)
    c = _clip(content, 600)
    return f"参数标题：{t or '(空)'}；参数正文：{c or '(空)'}"


# =====================================================================
# 字段别名归一化（方案1）
# ---------------------------------------------------------------------
# 外部系统的字段名和本系统语义不一致（如正文用 body 而非 content），
# 这里按【优先级顺序】认领别名：排在前面的字段名优先，取第一个非空值。
#
# 【想增加识别的字段名】→ 在下方对应元组里追加即可，例如：
#   _CONTENT_KEYS = (... "msg_content", "notification_text", ...)
# 追加后，外部系统用该字段名传参也会被识别为邮件正文/主题/收件人。
# 注意：越靠前优先级越高；原标准字段（content/title/dst）永远最优先。
# =====================================================================
_TITLE_KEYS = (
    "title",          # 标准字段
    "subject", "heading", "header", "headline", "name",
    "event", "event_type", "msgtype", "msg_type", "type",
)
_CONTENT_KEYS = (
    "content",        # 标准字段
    "body", "text", "message", "msg", "description",
    "summary", "detail", "data", "payload", "remark", "notice",
    "content_text", "content_plain", "plain",
)
_DST_KEYS = (
    "dst",            # 标准字段
    "to", "to_email", "email", "target", "recipient",
    "send_to", "notify_email", "mail", "mail_to", "address",
)
# 嵌套对象最多下探层数（如 data.payload.content 这种三层包裹）
_NEST_DEPTH = 3


def _first_string(data, keys: tuple, depth: int = 0) -> str:
    """按 keys 优先级取第一个非空值：先查当前层直接键，再按值顺序递归下探嵌套（最多 _NEST_DEPTH 层）。"""
    if data is None or depth > _NEST_DEPTH:
        return ""
    if isinstance(data, dict):
        for k in keys:
            v = data.get(k)
            if isinstance(v, str):
                if v.strip():
                    return v
            elif isinstance(v, (int, float)) and not isinstance(v, bool):
                return str(v)
        for v in data.values():
            found = _first_string(v, keys, depth + 1)
            if found:
                return found
    elif isinstance(data, list):
        for item in data[:5]:
            found = _first_string(item, keys, depth + 1)
            if found:
                return found
    return ""


def _payload_fallback(data) -> str:
    """兜底（方案3）：未命中任何内容字段时，把整个请求体序列化为文本，保证邮件正文非空。"""
    try:
        text = json.dumps(data, ensure_ascii=False)
    except Exception:
        text = str(data)
    return _clip(text, 1500)


def _extract_callback_params(data, *, fallback_content: bool = True) -> tuple[str, str, str]:
    """从请求体/查询参数中按别名提取 (title, content, dst)。

    - 请求体本身是字符串（如 JSON 字符串 body）：直接当作正文；
    - POST 默认开启兜底（方案3）：未命中 content 且请求体非空时，整个请求体序列化作为正文；
    - GET 关闭兜底（查询参数不该整包进正文），仍支持别名提取。
    """
    if isinstance(data, str):
        return "", data, ""
    if not isinstance(data, dict):
        return "", "", ""
    title = _first_string(data, _TITLE_KEYS)
    content = _first_string(data, _CONTENT_KEYS)
    dst = _first_string(data, _DST_KEYS)
    if fallback_content and not content and data:
        content = _payload_fallback(data)
    return title, content, dst


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


async def _parse_post_body(request: Request) -> "dict | str":
    """POST 请求体解析：兼容 JSON body 与表单（application/x-www-form-urlencoded）。

    JSON 顶层可能是对象、字符串（整包即正文）或其它标量，原样返回，交给 _extract_callback_params 归一化。
    """
    ctype = (request.headers.get("content-type") or "").lower()
    try:
        if "application/json" in ctype:
            data = await request.json()
            return data if isinstance(data, (dict, str)) else {}
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
            ip=ip,
            detail=f"回调报错回显 收件 {cred['notify_email']}：{reason[:120]}；邮件标题：{_clip(title,200)}；正文预览：{_clip(content,300)}",
        )
    except Exception as exc:
        log_action(
            "email_fail", username=username, method=method, path=path, status=500,
            ip=ip,
            detail=f"回调报错回显发送失败：{_clip(str(exc),300)}；邮件标题：{_clip(title,200)}；正文预览：{_clip(content,300)}",
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
    try:
        return await _handle_callback_impl(
            request, method, path, id, title, content, dst, ip
        )
    except Exception:
        # /api/callback 已加入中间件 _SKIP_PATHS，这里兜底补一条 500 请求日志，
        # 避免未预期异常在网页日志/服务器日志里完全不可见
        log_action(
            "外部回调触发", username=None, method=method, path=path, status=500,
            ip=ip, detail="服务端异常",
        )
        raise


async def _handle_callback_impl(
    request: Request,
    method: str,
    path: str,
    id: str,
    title: str,
    content: str,
    dst: str,
    ip: str,
) -> JSONResponse:
    with get_conn() as conn:
        cred = conn.execute(
            "SELECT username, smtp_user, smtp_pass, notify_email FROM smtp_creds WHERE callback_id=?",
            (id,),
        ).fetchone()
    if cred is None:
        # 无效 ID：无法归属到任何账号，保留一条匿名请求日志（仅服务器/数据库可见），
        # 与旧行为一致，网页操作日志页不展示（username 为空）
        log_action(
            "外部回调触发", username=None, method=method, path=path, status=403,
            ip=ip, detail="无效的回调 ID",
        )
        return JSONResponse(status_code=403, content={"ok": False, "detail": "无效的回调 ID"})
    username = cred["username"]

    # 实际发信时的邮件主题/正文（含空值兜底），与收件人收到的邮件一致；
    # raw 则是请求携带的原始参数，便于对照"调用方传了什么"与"邮件发出了什么"
    subject = (title or "").strip() or "【MeiDay 通知】"
    body = (content or "").strip() or "（无内容）"
    raw = _callback_params(title, content)

    def _log_trigger(status: int, detail: str) -> None:
        """请求级日志：归属到该回调 ID 所属账号，网页操作日志可见。"""
        log_action(
            "外部回调触发", username=username, method=method, path=path, status=status,
            ip=ip, detail=detail,
        )

    if not (cred["smtp_user"] and cred["smtp_pass"] and cred["notify_email"]):
        _log_trigger(400, f"该账号未配置邮件发送（未发信）；{raw}")
        return JSONResponse(
            status_code=400,
            content={"ok": False, "detail": "该账号未配置邮件发送（请先在设置页配置发件邮箱/授权码/收件邮箱）"},
        )

    target = (dst or "").strip()
    if target and not _is_valid_email(target):
        # dst 非法：不发送正文邮件，向账号收件邮箱回显报错
        _log_trigger(400, f"dst 收件邮箱格式不正确，未发送；{raw}")
        await _echo_error(
            cred, title=title, content=content, target=target,
            reason="dst 邮箱格式不正确", ip=ip, username=username,
            method=method, path=path,
        )
        return JSONResponse(status_code=400, content={"ok": False, "detail": "dst 邮箱格式不正确"})

    to = target or cred["notify_email"]
    try:
        await send_callback_email(cred["smtp_user"], cred["smtp_pass"], to, title, content)
    except Exception as exc:
        log_action(
            "email_fail", username=username, method=method, path=path, status=500,
            ip=ip,
            detail=f"回调发送失败 收件 {to}；邮件标题：{_clip(subject,200)}；邮件正文：{_clip(body,600)}；错误：{_clip(str(exc),300)}",
        )
        _log_trigger(500, f"回调发送失败 收件 {to}；{raw}")
        reason = f"邮件发送失败：{exc}{_smtp_dns_hint(exc)}"
        await _echo_error(
            cred, title=title, content=content, target=to,
            reason=reason, ip=ip, username=username,
            method=method, path=path,
        )
        return JSONResponse(status_code=500, content={"ok": False, "detail": "邮件发送失败"})

    _log_trigger(200, f"回调通知 收件 {to}；{raw}")
    log_action(
        "email_send", username=username, method=method, path=path, status=200,
        ip=ip,
        detail=f"回调通知 收件 {to}；邮件标题：{_clip(subject,200)}；邮件正文：{_clip(body,600)}",
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
    """公开回调入口（GET）：?id=随机数&title=主题&content=正文&dst=可选收件邮箱；
    title/content/dst 支持常见别名（如 ?body=正文&subject=主题&to=收件邮箱）"""
    # 读取全部查询参数（含未声明的别名键，如 body/subject/to），再按别名提取
    params = dict(request.query_params)
    params.setdefault("title", title)
    params.setdefault("content", content)
    params.setdefault("dst", dst)
    t, c, d = _extract_callback_params(params, fallback_content=False)
    return await _handle_callback(request, "GET", "/api/callback", id, t, c, d)


@router.post("/callback")
async def callback_post(
    request: Request,
    id: str = Query(default=""),
):
    """公开回调入口（POST）：id 可放 URL（?id=）或请求体（JSON/表单，URL 优先）；
    title/content/dst 从请求体提取，支持常见字段别名（如 body/text/message/subject），
    可自动下探嵌套对象；未命中内容字段时兜底为整个请求体文本（方案3）。"""
    data = await _parse_post_body(request)
    body_id = str(data.get("id", "")) if isinstance(data, dict) else ""
    title, content, dst = _extract_callback_params(data)
    return await _handle_callback(
        request,
        "POST",
        "/api/callback",
        id or body_id,
        title,
        content,
        dst,
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
