import json
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from ..auth import get_username
from ..db import get_conn
from ..schemas import CredentialsRequest, OssCheckRequest, RemindersSyncRequest
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
def update_credentials(body: CredentialsRequest, username: str = Depends(get_username)):
    now = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")
    with get_conn() as conn:
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
            # 重复任务：服务器只存这一条周期规则（JSON），发完邮件后由 worker 自行推进，
            # 不预注册未来 N 条提醒，取消/删除任务后下次同步即全部移除。
            rule_json = json.dumps(task.repeatRule, ensure_ascii=False) if task.repeatRule else None
            reminder_time = task.reminderTime
            start_time = task.startTime
            end_time = task.endTime
            is_reminded = 0
            if rule_json:
                prev = old_by_key.get((task.id, task.subtaskId))
                prev_rt = prev["reminder_time"] if prev else None
                # 服务端已把提醒时间推进到未来（当前周期的邮件已发，前端上报的还是旧时间）：
                # 保留服务端的推进结果，只更新名称/描述/起止/规则，避免旧时间打断周期推进。
                if prev_rt and _iso_gt(prev_rt, task.reminderTime):
                    reminder_time = prev_rt
                    start_time = prev["start_time"]
                    end_time = prev["end_time"]
                    is_reminded = prev["is_reminded"]
                else:
                    rt = _parse_reminder_time(task.reminderTime)
                    if rt is not None and rt <= now:
                        # 当前周期提醒时间已过：不补发今天，但按规则推进到下一个“未来”周期继续提醒
                        # （用户一周不打开 App，服务器仍会每天按时发提醒邮件；
                        #  跨过多个已过期周期，避免把过期时间注册后立即补发旧邮件）。
                        nxt = None
                        try:
                            cur = task.reminderTime
                            for _ in range(400):
                                n2, _off = compute_next_reminder(task.repeatRule, cur)
                                if not n2:
                                    break
                                cur = n2
                                if _parse_reminder_time(cur) > now:
                                    nxt = cur
                                    break
                        except Exception:
                            nxt = None
                        if nxt:
                            reminder_time = nxt
                            offset = diff_days_key(task.reminderTime[:10], nxt[:10])
                            if task.startTime:
                                start_time = add_days(task.startTime, offset)
                            if task.endTime:
                                end_time = add_days(task.endTime, offset)
                        else:
                            # endAfter 已过或规则无法推进：不再注册任何提醒
                            continue
            else:
                # 一次性提醒：已发送不重发、过期不补发（历史逻辑）
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

def _norm_oss_region(region: str) -> str:
    """兼容前端误填完整 OSS 域名：去掉协议与 .aliyuncs.com 后缀。"""
    return (region or "").strip().replace("https://", "").replace("http://", "").replace(".aliyuncs.com", "")


def _oss_endpoint_is_safe(region: str) -> tuple[bool, str]:
    """V-002 纵深防御：解析最终 host（<region>.aliyuncs.com），拒绝解析到非公网地址。

    region 白名单校验（schemas.py + 本路由）已保证 host 一定是 aliyuncs.com 子域，
    这里再兜底拦截 DNS 被解析到私网/回环/链路本地/保留/多播地址（如 -internal
    端点、恶意或分域 DNS 指向内网），防止后端向内网地址发起出站探测。
    """
    import ipaddress
    import socket

    host = "%s.aliyuncs.com" % region
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


@router.post("/credentials/oss-check")
def oss_check(body: OssCheckRequest, username: str = Depends(get_username)):
    """后端直连 OSS 诊断，绕过浏览器 CORS，返回真实错误码（如 NoSuchBucket）。

    浏览器里 ali-oss 请求被 CORS 拦截时拿不到真实错误；后端用 oss2 从服务器
    侧直连可拿到 NoSuchBucket / AccessDenied 等真实 code/status/message。
    AK/SK 仅在本函数内存中使用，不写入日志、不落库、不返回给前端之外的部分。
    """
    import oss2

    # V-002：服务端二次校验（schema 已拦第一道，此处兜底防绕过）。
    # 规范化后的 region 只允许字母/数字/连字符，最终 host 固定为 <region>.aliyuncs.com，
    # 杜绝把任意 host:port / IP 字形拼进 endpoint 造成 SSRF / 内网探测。
    region = _norm_oss_region(body.region)
    if not re.fullmatch(r"[A-Za-z0-9-]{1,63}", region):
        return {
            "ok": False,
            "cors_configured": None,
            "code": None,
            "status": None,
            "message": "OSS region 配置无效",
            "request_id": None,
        }
    ok, why = _oss_endpoint_is_safe(region)
    if not ok:
        return {
            "ok": False,
            "cors_configured": None,
            "code": None,
            "status": None,
            "message": "OSS 连接被拒绝：" + why,
            "request_id": None,
        }

    try:
        auth = oss2.Auth(body.oss_ak, body.oss_sk)
        # connect_timeout=10：限制单次出站连接/请求时长，避免连到不可达地址时长时间挂起
        bucket = oss2.Bucket(auth, "https://%s.aliyuncs.com" % region, body.bucket, connect_timeout=10)
        bucket.list_objects("", max_keys=1)
    except oss2.exceptions.OssError as exc:
        return {
            "ok": False,
            "cors_configured": None,
            "code": getattr(exc, "code", None),
            "status": getattr(exc, "status", None),
            "message": getattr(exc, "message", str(exc)),
            "request_id": getattr(exc, "request_id", None),
        }
    except Exception:  # DNS/网络不可达等非 OSS 标准错误
        # V-002：不回显底层连接/解析细节，避免把探测结果反馈给调用方
        return {
            "ok": False,
            "cors_configured": None,
            "code": None,
            "status": None,
            "message": "无法连接 OSS 服务，请检查网络或配置",
            "request_id": None,
        }

    try:
        bucket.get_bucket_cors()
        cors_configured = True
    except oss2.exceptions.NoSuchCORSConfiguration:
        cors_configured = False
    except oss2.exceptions.OssError:
        cors_configured = None
    except Exception:
        cors_configured = None

    return {
        "ok": True,
        "cors_configured": cors_configured,
        "code": None,
        "status": None,
        "message": "OSS 连接正常",
        "request_id": None,
    }

