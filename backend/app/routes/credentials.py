import json
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, Request

from ..audit import client_ip, log_action
from ..auth import get_username
from ..db import get_conn
from ..schemas import CredentialsRequest, OssCheckRequest, RemindersSyncRequest
from ..services.notifier import notify_cred_change_email
from ..services.repeat_calendar import add_days, compute_next_reminder, diff_days_key

router = APIRouter(prefix="/api", tags=["credentials"])


def _parse_reminder_time(value: str):
    """解析提醒时间，兼容带时区/不带时区的 ISO 字符串，解析失败返回 None。"""
    try:
        dt = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone(timedelta(hours=8)))
    return dt


def _iso_gt(a: str, b: str) -> bool:
    """a 的提醒时间是否严格晚于 b（用于判断服务端是否已把重复提醒推进到未来）。"""
    da, db = _parse_reminder_time(a), _parse_reminder_time(b)
    return da is not None and db is not None and da > db


@router.put("/credentials")
def update_credentials(
    body: CredentialsRequest,
    request: Request = None,
    background_tasks: BackgroundTasks = None,
    username: str = Depends(get_username),
):
    """保存（加密）存储凭证与 SMTP 配置。

    安全关键：无论 SMTP 配置是否真的被改动，只要执行到本接口（前端点击「加密保存」），
    就在【写入新配置之前】同步读出旧 SMTP 配置，并用旧配置异步发送一封“临终”安全邮件
    （[{ip}] 正在修改你的账号的密钥配置）。防止攻击者先改掉 SMTP 授权码、再加密保存，
    使通知邮箱失效、安全邮件永远发不出去。首次配置（无旧 SMTP）时提示无法发送，
    但不阻断保存，并记录审计日志。
    """
    ip = client_ip(request) if request else ""
    ua = request.headers.get("user-agent", "") if request else ""
    now = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")
    with get_conn() as conn:
        old = conn.execute(
            "SELECT smtp_user, smtp_pass, notify_email FROM smtp_creds WHERE username=?",
            (username,),
        ).fetchone()
        old_smtp = dict(old) if old else None
        conn.execute(
            "UPDATE users SET encrypted_creds=?, creds_updated_at=? WHERE username=?",
            (body.encrypted_creds, now, username),
        )
        if body.smtp_plain:
            conn.execute(
                """
                INSERT INTO smtp_creds (username, smtp_user, smtp_pass, notify_email, updated_at)
                VALUES (?,?,?,?,?)
                ON CONFLICT(username) DO UPDATE SET
                    smtp_user=excluded.smtp_user,
                    smtp_pass=excluded.smtp_pass,
                    notify_email=excluded.notify_email,
                    updated_at=excluded.updated_at
                """,
                (username, body.smtp_plain.smtp_user, body.smtp_plain.smtp_pass, body.smtp_plain.notify_email, now),
            )
    if old_smtp and old_smtp.get("notify_email"):
        # 用修改前的旧 SMTP 配置发“临终”邮件（响应后异步发送，不影响保存响应速度）
        background_tasks.add_task(notify_cred_change_email, username, old_smtp, ip, ua)
    else:
        # 首次配置：没有旧发件邮箱可用来发通知，不阻断保存，仅记录审计日志
        log_action(
            "email_suppressed", username=username,
            detail="加密保存：尚未配置发件邮箱，本次无法发送安全通知邮件",
        )
    return {"ok": True}


@router.put("/reminders/sync")
def sync_reminders(body: RemindersSyncRequest, username: str = Depends(get_username)):
    """按“当前已加载的项目”增量替换待提醒清单，并结合 sent_reminders 历史避免重复发送。

    - 仅替换 body.projectIds 内项目的提醒行：未加载项目的行保留不动，
      防止“部分同步”把已发送/待发送的提醒误删，导致稍后加载时重新发信；
    - is_reminded 由 sent_reminders 历史（已发送过的 task_id+subtask_id+reminder_time）
      或当前行状态决定；提醒时间变更视为新提醒，重新发送；
    - 提醒时间已过（新建时把提醒设到过去，或把提醒时间改成过去）直接标记为已过期，
      不再补发邮件，避免“添加/编辑一个提醒时间已过的任务”立刻触发邮件提醒。"""
    with get_conn() as conn:
        old = conn.execute(
            "SELECT task_id, subtask_id, project_id, start_time, end_time, reminder_time, is_reminded, repeat_rule "
            "FROM reminders WHERE username=?",
            (username,),
        ).fetchall()
        old_map = {(r["task_id"], r["subtask_id"], r["reminder_time"]): r["is_reminded"] for r in old}
        old_by_key = {(r["task_id"], r["subtask_id"]): r for r in old}
        sent = {
            (r["task_id"], r["subtask_id"], r["reminder_time"])
            for r in conn.execute(
                "SELECT task_id, subtask_id, reminder_time FROM sent_reminders WHERE username=?",
                (username,),
            ).fetchall()
        }
        if body.projectIds:
            # 逐项删除（而非 IN 拼接）：语义等价且无 SQL 拼接/空串歧义；
            # projectIds 含 '' 时仅删除未分类提醒行（该键表示未分类已加载），
            # 未加载的项目不会被误删（BUG-33）
            for pid in body.projectIds:
                conn.execute(
                    "DELETE FROM reminders WHERE username=? AND project_id=?",
                    (username, pid),
                )
        else:
            # 兼容旧客户端：未提供 projectIds 时全量替换
            conn.execute("DELETE FROM reminders WHERE username=?", (username,))
        # 同一 (task_id, subtask_id) 只能有一行（主键 username+task_id+subtask_id），
        # 取最后一次出现的状态，避免前端/客户端误发重复 id 时因唯一约束直接 500。
        dedup: dict[tuple[str, str], object] = {}
        for t in body.tasks:
            dedup[(t.id, t.subtaskId)] = t
        now = datetime.now(timezone(timedelta(hours=8)))
        for task in dedup.values():
            if not task.reminderTime or task.status != "pending":
                continue
            # 重复任务：服务器只存这一条周期规则（JSON），不预注册未来 N 条提醒；
            # 发完邮件后由 worker 按周期自行推进 reminder_time。
            rule_json = json.dumps(task.repeatRule, ensure_ascii=False) if task.repeatRule else None
            reminder_time = task.reminderTime
            start_time = task.startTime
            end_time = task.endTime
            is_reminded = 0
            if rule_json:
                # 客户端可能带着旧的提醒时间同步（服务器已把重复提醒推进到未来），
                # 若服务器侧的提醒时间严格晚于客户端提交的，说明是“回退同步”，
                # 保留服务器侧的推进状态（时间/起止/is_reminded），避免被客户端覆盖回去。
                prev = old_by_key.get((task.id, task.subtaskId))
                prev_rt = prev["reminder_time"] if prev else None
                if prev_rt and _iso_gt(prev_rt, task.reminderTime):
                    reminder_time = prev_rt
                    start_time = prev["start_time"]
                    end_time = prev["end_time"]
                    is_reminded = prev["is_reminded"]
                else:
                    rt = _parse_reminder_time(task.reminderTime)
                    if rt is not None and rt <= now:
                        # 提醒时间已过（新建时设到过去 / 改成过去）：按规则推进到
                        # 下一个未来时间点，避免刚同步进来就立刻发一封过期邮件。
                        nxt = None
                        cur = task.reminderTime
                        for _ in range(400):
                            n2, _off = compute_next_reminder(task.repeatRule, cur)
                            if not n2:
                                break
                            cur = n2
                            if _parse_reminder_time(cur) > now:
                                nxt = cur
                                break
                        if nxt:
                            reminder_time = nxt
                            offset = diff_days_key(task.reminderTime[:10], nxt[:10])
                            if task.startTime:
                                start_time = add_days(task.startTime, offset)
                            if task.endTime:
                                end_time = add_days(task.endTime, offset)
                        else:
                            # 规则已结束（endAfter 已过）或无法推进：不注册该提醒行
                            continue
            else:
                # 非重复任务：is_reminded 由已发送历史或当前行状态决定；
                # 提醒时间已过（新建时设到过去）直接标记为已过期，不再补发邮件。
                key3 = (task.id, task.subtaskId, task.reminderTime)
                is_reminded = 1 if (key3 in sent or old_map.get(key3, 0)) else 0
                if not is_reminded:
                    rt = _parse_reminder_time(task.reminderTime)
                    if rt is not None and rt <= now:
                        is_reminded = 1
            conn.execute(
                """
                INSERT OR REPLACE INTO reminders
                (username, task_id, subtask_id, project_id, name, description,
                 start_time, end_time, reminder_time, is_reminded, repeat_rule)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """,
                (username, task.id, task.subtaskId, task.projectId, task.name, task.description,
                 start_time, end_time, reminder_time, is_reminded, rule_json),
            )
    return {"ok": True, "count": len([t for t in dedup.values() if t.reminderTime and t.status == "pending"])}


def _oss_guess_region(endpoint: str) -> str:
    """从 endpoint 域名推断 S3 签名 Region（与前端 oss.ts 的 guessRegion 一致）。"""
    m = re.match(r"^https?://([^/]+)", endpoint or "")
    host = (m.group(1) if m else (endpoint or "")).lower()
    m = re.match(r"^cos\.([^.]+)\.myqcloud\.com$", host)
    if m:
        return m.group(1)
    m = re.match(r"^obs\.([^.]+)\.myhuaweicloud\.com$", host)
    if m:
        return m.group(1)
    m = re.match(r"^s3-([^.]+)\.qiniucs\.com$", host)
    if m:
        return m.group(1)
    m = re.match(r"^oss-([^.]+)\.aliyuncs\.com$", host)
    if m:
        return m.group(1)
    if host.endswith(".r2.cloudflarestorage.com"):
        return "auto"
    return "us-east-1"


def _oss_host_is_safe(host: str) -> tuple[bool, str]:
    """V-002 纵深防御：解析 endpoint 的 host，拒绝解析到非公网地址。

    schemas.py 已拦第一道（只允许 HTTPS + 公网域名），这里再兜底拦截 DNS 被
    解析到私网/回环/链路本地/保留/多播地址（如内网端点或分域 DNS 指向内网），
    防止后端向内网地址发起出站探测。
    """
    import ipaddress
    import socket

    try:
        infos = socket.getaddrinfo(host, 443, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except (socket.gaierror, OSError):
        return False, "无法解析 OSS 域名"
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if not ip.is_global:
            return False, "OSS 域名解析到非公网地址，已拒绝连接"
    return True, ""


def _xml_tag(xml: str, tag: str):
    """从 S3 错误 XML 响应中提取 <Tag> 文本（无则返回 None）。"""
    m = re.search(r"<%s>(.*?)</%s>" % (tag, tag), xml or "", re.S)
    return m.group(1).strip() if m else None


def _s3_sigv4(method: str, url: str, ak: str, sk: str, region: str, payload: bytes = b"") -> dict:
    """用 AWS SigV4 对 S3 兼容请求签名（Virtual-Hosted / Path-Style 均可，与前端 aws4fetch 一致）。"""
    import hashlib
    import hmac as _hmac
    from urllib.parse import quote, urlparse

    parsed = urlparse(url)
    now = datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    host = parsed.netloc
    path = parsed.path or "/"
    query = parsed.query

    payload_hash = hashlib.sha256(payload).hexdigest()

    query_items = []
    for part in query.split("&"):
        if not part:
            continue
        k, _, v = part.partition("=")
        query_items.append((quote(k, safe="-_.~"), quote(v, safe="-_.~")))
    query_items.sort(key=lambda kv: kv[0])
    canonical_query = "&".join("%s=%s" % (k, v) for k, v in query_items)

    canonical_headers = "host:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n" % (
        host,
        payload_hash,
        amz_date,
    )
    signed_headers = "host;x-amz-content-sha256;x-amz-date"

    canonical_request = "%s\n%s\n%s\n%s\n%s\n%s" % (
        method,
        quote(path, safe="/"),
        canonical_query,
        canonical_headers,
        signed_headers,
        payload_hash,
    )
    scope = "%s/%s/s3/aws4_request" % (date_stamp, region)
    string_to_sign = "AWS4-HMAC-SHA256\n%s\n%s\n%s" % (
        amz_date,
        scope,
        hashlib.sha256(canonical_request.encode()).hexdigest(),
    )

    def _hmac_sig(key: bytes, msg: str) -> bytes:
        return _hmac.new(key, msg.encode(), hashlib.sha256).digest()

    k_date = _hmac_sig(("AWS4" + sk).encode(), date_stamp)
    k_region = _hmac_sig(k_date, region)
    k_service = _hmac_sig(k_region, "s3")
    k_signing = _hmac_sig(k_service, "aws4_request")
    signature = _hmac.new(k_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()

    return {
        "Authorization": "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s"
        % (ak, scope, signed_headers, signature),
        "X-Amz-Date": amz_date,
        "X-Amz-Content-Sha256": payload_hash,
    }


@router.post("/credentials/oss-check")
def oss_check(body: OssCheckRequest, username: str = Depends(get_username)):
    """后端直连 OSS 诊断（S3 兼容），绕过浏览器 CORS，返回真实错误码。

    浏览器里请求被 CORS 拦截时拿不到真实错误；后端用 requests + SigV4 从服务器
    侧直连可拿到 NoSuchBucket / AccessDenied 等真实 code/status/message。
    AK/SK 仅在本函数内存中使用，不写入日志、不落库、不返回给前端之外的部分。
    """
    import re
    import requests
    from urllib.parse import quote, urlparse

    def _fail(code, status, message, request_id=None):
        return {
            "ok": False,
            "cors_configured": None,
            "code": code,
            "status": status,
            "message": message,
            "request_id": request_id,
        }

    # V-002：服务端二次校验（schema 已拦第一道，此处兜底防绕过）。
    endpoint = (body.endpoint or "").strip()
    if not endpoint.lower().startswith("https://"):
        endpoint = "https://" + endpoint
    parsed = urlparse(endpoint)
    host = (parsed.hostname or "").lower()
    ok, why = _oss_host_is_safe(host)
    if not ok:
        return _fail(None, None, "OSS 连接被拒绝：" + why)

    # 访问样式自动选择：
    #  - 公网厂商域名（阿里云/腾讯云/华为云/七牛等）用 Virtual-Hosted Style
    #    （https://bucket.endpoint），阿里云 OSS 对 Path-Style 直接拒绝
    #    （SecondLevelDomainForbidden）；
    #  - endpoint 是 IP / localhost / 内网域名，或 bucket 名含点号时回退 Path-Style
    #    （覆盖 MinIO 自建等无通配符 DNS 的场景）。
    bucket = (body.bucket or "").strip()
    is_ip = bool(re.match(r"^\d{1,3}(\.\d{1,3}){3}$", host) or
                 (":" in host and re.match(r"^[0-9a-fA-F:]+$", host)))
    is_local = host == "localhost" or host.endswith(".local") or host.endswith(".internal")
    if not (is_ip or is_local or "." in bucket):
        url = "%s://%s/?max-keys=1" % (parsed.scheme, bucket + "." + parsed.netloc)
    else:
        url = "%s/%s?max-keys=1" % (endpoint.rstrip("/"), quote(bucket, safe=""))

    region = _oss_guess_region(endpoint)
    headers = _s3_sigv4("GET", url, body.oss_ak, body.oss_sk, region)

    try:
        # timeout=10：限制单次出站连接/请求时长，避免连到不可达地址时长时间挂起
        resp = requests.get(url, headers=headers, timeout=10)
    except requests.exceptions.RequestException:
        # V-002：不回显底层连接/解析细节，避免把探测结果反馈给调用方
        return _fail(None, None, "无法连接 OSS 服务，请检查网络或配置")

    if resp.status_code >= 400:
        return _fail(
            _xml_tag(resp.text, "Code"),
            resp.status_code,
            _xml_tag(resp.text, "Message") or resp.reason,
            _xml_tag(resp.text, "RequestId"),
        )

    return {
        "ok": True,
        "cors_configured": None,
        "code": None,
        "status": None,
        "message": "OSS 连接正常",
        "request_id": None,
    }
