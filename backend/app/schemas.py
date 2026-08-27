import base64
import re
from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, field_validator


def _strip(v: str) -> str:
    return (v or "").strip()


# BUG-05: 用户名必须是安全的“字母/数字/下划线/连字符”，长度 2-32。
# 禁止 /、..、空格、Unicode 等，避免拼接 OSS 存储键时出现路径穿越。
USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]{2,32}$")


def _is_valid_verifier(v: str) -> bool:
    """校验子必须是真实 SHA-256 摘要的 base64（解码后恰为 32 字节）。

    历史实现只检查长度 >=16，导致 "A"*16 这类任意字符串也能当“新密码校验子”
    通过（BUG-08）。要求 base64 可解码且字节数为 32，能可靠拒绝这类伪校验子。
    """
    try:
        return len(base64.b64decode(v, validate=True)) == 32
    except Exception:
        return False


class RegisterRequest(BaseModel):
    """注册：客户端只发送 SHA-256(password) 的 base64 校验子（不可逆密文），
    服务端对校验子再做 argon2 慢哈希存储，避免明文密码出现在网络中。

    同时要求点击式验证码（captchaId + captchaAnswer，单次使用、绑定 IP），
    对抗换 IP 批量注册。"""
    username: str
    passwordHash: str
    encrypted_creds: Optional[str] = None
    smtp_plain: Optional["SmtpPlain"] = None
    captchaId: str = ""
    captchaAnswer: List[int] = []

    @field_validator("captchaId", mode="before")
    @classmethod
    def _captcha_id(cls, v):
        return _strip(v)[:128]

    @field_validator("captchaAnswer", mode="before")
    @classmethod
    def _captcha_answer(cls, v):
        if not isinstance(v, list):
            raise ValueError("验证码答案格式错误")
        if len(v) > 9:
            raise ValueError("验证码答案格式错误")
        return v

    @field_validator("username", mode="before")
    @classmethod
    def _username(cls, v):
        v = _strip(v)
        if not USERNAME_RE.match(v):
            raise ValueError("用户名仅允许 2-32 位字母、数字、下划线或连字符")
        return v

    @field_validator("passwordHash")
    @classmethod
    def _password_hash(cls, v):
        v = _strip(v)
        if not v:
            raise ValueError("密码校验值不能为空")
        if len(v) < 16 or not _is_valid_verifier(v):
            raise ValueError("密码校验值无效")
        return v


class LoginRequest(BaseModel):
    """登录：客户端只发送 SHA-256(password) 的 base64 校验子，不发送明文密码。"""
    username: str
    passwordHash: str

    @field_validator("username", mode="before")
    @classmethod
    def _username(cls, v):
        return _strip(v)

    @field_validator("passwordHash")
    @classmethod
    def _password_hash(cls, v):
        v = _strip(v)
        if not v:
            raise ValueError("密码校验值不能为空")
        return v


class LegacyLoginRequest(BaseModel):
    """旧账号一次性迁移登录：历史账号（auth_version=0）首次登录时，
    为了把存储从 argon2(明文密码) 升级为 argon2(SHA-256(password))，
    需发送一次明文密码（仅此一次、仅旧账号），之后全部走 verifier。"""
    username: str
    password: str

    @field_validator("username", mode="before")
    @classmethod
    def _username(cls, v):
        return _strip(v)


class LoginResponse(BaseModel):
    sessionToken: str
    encrypted_creds: Optional[str]


class ChangePasswordRequest(BaseModel):
    """修改密码：客户端只发送 SHA-256(password) 的 base64 校验子（不可逆密文），
    明文密码不出浏览器。服务端校验旧校验子后，用 argon2 慢哈希存储新校验子。

    newEncryptedCreds 为客户端用“新密码派生密钥”重新加密后的 OSS 凭证密文，
    在同一个数据库事务里与密码哈希一起更新，保证“改密 + 凭证重加密”原子完成，
    避免中途失败导致修改密码后旧凭证无法解密。"""
    oldPasswordHash: str
    newPasswordHash: str
    newEncryptedCreds: Optional[str] = None

    @field_validator("oldPasswordHash", "newPasswordHash")
    @classmethod
    def _hash(cls, v):
        v = _strip(v)
        if not v:
            raise ValueError("密码校验值不能为空")
        if len(v) < 16 or not _is_valid_verifier(v):
            raise ValueError("密码校验值无效")
        return v


class MeResponse(BaseModel):
    username: str
    hasCreds: bool


class SmtpPlain(BaseModel):
    smtp_user: str
    smtp_pass: str
    notify_email: str

    @field_validator("smtp_user", "smtp_pass", "notify_email", mode="before")
    @classmethod
    def _nonempty(cls, v):
        v = _strip(v)
        if not v:
            raise ValueError("SMTP 字段不能为空")
        return v


class OssCheckRequest(BaseModel):
    """后端直连 OSS 诊断参数（仅用于本次诊断，不落库、不打印）：

    AK/SK 由前端在加载失败时临时提交，后端只在内存中使用 S3 兼容探活。
    审计中间件只记录请求路径与状态码，不记录请求体。
    """
    oss_ak: str
    oss_sk: str
    bucket: str
    endpoint: str

    @field_validator("oss_ak", "oss_sk", "bucket", "endpoint", mode="before")
    @classmethod
    def _nonempty(cls, v):
        v = _strip(v)
        if not v:
            raise ValueError("OSS 诊断参数不能为空")
        return v

    @field_validator("bucket", mode="after")
    @classmethod
    def _bucket_len(cls, v):
        if len(v) > 63:
            raise ValueError("bucket 名称不能超过 63 字符")
        return v

    @field_validator("endpoint", mode="before")
    @classmethod
    def _endpoint(cls, v):
        """校验 OSS S3 兼容 endpoint（V-002）：只允许 HTTPS + 公网域名。

        兼容腾讯云 COS / 华为云 OBS / 七牛 Kodo / 阿里云 OSS S3 / MinIO / R2
        等厂商的 S3 兼容地址，但拒绝 http 明文、IP 字形、端口、路径与内网域名，
        杜绝后端向任意 host:port 发起出站连接（SSRF 面 / 内网探测）。
        路由层还会做 DNS 公网解析兜底。
        """
        v = _strip(v)
        if not v:
            raise ValueError("OSS endpoint 不能为空")
        lower = v.lower()
        if "http://" in lower:
            raise ValueError("OSS endpoint 仅允许 HTTPS")
        host = lower.replace("https://", "").split("/", 1)[0]
        if not host:
            raise ValueError("OSS endpoint 格式无效")
        if ":" in host:
            raise ValueError("OSS endpoint 不能包含端口")
        try:
            import ipaddress
            ipaddress.ip_address(host)  # 命中即 IP 字形（IPv4/IPv6），拒绝
        except ValueError:
            pass
        else:
            raise ValueError("OSS endpoint 不能是 IP 地址")
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*", host):
            raise ValueError("OSS endpoint 格式无效（仅允许域名）")
        if host == "localhost" or host.endswith(".local") or host.endswith(".internal"):
            raise ValueError("OSS endpoint 不能是内网/本地地址")
        return v

class CredentialsRequest(BaseModel):
    encrypted_creds: str
    smtp_plain: Optional[SmtpPlain] = None

    @field_validator("encrypted_creds")
    @classmethod
    def _creds(cls, v):
        if not (v or "").strip():
            raise ValueError("凭证密文不能为空")
        return v

# ---------- 重复任务提醒规则（V-001）----------

# 合法重复类型（与前端 repeat.ts / TaskModal.vue 保持一致）
REPEAT_TYPES = ("daily", "weekly", "workday", "monthly", "legalWorkday")
# interval 上限：与前端输入框 max=365 对齐；超大 interval 会让
# repeat_calendar.next_repeat_date 的 weekly 分支循环约 7n 次（CPU 放大 / DoS）。
REPEAT_INTERVAL_MAX = 365
# 可选星期几：0=周日 … 6=周六（与前端 JS getDay 一致）
REPEAT_WEEKDAY_SET = frozenset(range(7))


class ReminderTask(BaseModel):
    id: str
    name: str
    description: str = ""
    startTime: Optional[str] = None
    endTime: Optional[str] = None
    reminderTime: Optional[str] = None
    projectId: str
    status: str
    isReminded: bool = False
    # 子任务 id：主任务为空字符串 ""，子任务为子任务自身的 uuid
    subtaskId: str = ""
    # 重复任务提醒规则（可选）：服务器 reminders 行只存这一条规则（JSON），
    # 不预注册未来 N 条提醒；发完邮件后由 worker 按周期自行推进 reminder_time。
    repeatRule: Optional[dict] = None

    @field_validator("repeatRule", mode="before")
    @classmethod
    def _repeat_rule(cls, v):
        """校验重复提醒规则（V-001）：type / interval / weekdays / monthDay / endAfter。

        此前 repeatRule 只声明为 Optional[dict]、无任何字段级约束，攻击者可绕过前端
        直接提交超大 interval（如 300000），使 next_repeat_date 的 weekly 分支循环约 7n 次，
        单请求即可阻塞后端 ~47s（CPU 放大 / 拒绝服务）。此处按前端合法取值范围收紧，
        并做类型归一化（interval/monthDay 转 int、weekdays 排序去重），避免把字符串等
        畸形类型写入 reminders 表 JSON。
        """
        if v is None:
            return v
        if not isinstance(v, dict):
            raise ValueError("重复规则必须是对象")
        rtype = v.get("type")
        if rtype not in REPEAT_TYPES:
            raise ValueError("重复类型无效")
        interval = v.get("interval")
        if interval is not None:
            try:
                interval = int(interval)
            except (TypeError, ValueError):
                raise ValueError("重复间隔必须是整数")
            if not (1 <= interval <= REPEAT_INTERVAL_MAX):
                raise ValueError(f"重复间隔需在 1-{REPEAT_INTERVAL_MAX} 之间")
        weekdays = v.get("weekdays")
        if weekdays is not None:
            if not isinstance(weekdays, list) or not weekdays:
                raise ValueError("每周重复需至少选择一个星期几")
            if len(weekdays) > 7:
                raise ValueError("星期几不能超过 7 个")
            seen = set()
            for w in weekdays:
                try:
                    w = int(w)
                except (TypeError, ValueError):
                    raise ValueError("星期几必须是整数")
                if w not in REPEAT_WEEKDAY_SET:
                    raise ValueError("星期几需在 0-6 之间")
                seen.add(w)
            if len(seen) != len(weekdays):
                raise ValueError("星期几不能重复")
        month_day = v.get("monthDay")
        if month_day is not None:
            try:
                month_day = int(month_day)
            except (TypeError, ValueError):
                raise ValueError("每月日期必须是整数")
            if not (1 <= month_day <= 31):
                raise ValueError("每月日期需在 1-31 之间")
        end_after = v.get("endAfter")
        if end_after is not None:
            if not isinstance(end_after, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end_after):
                raise ValueError("结束日期格式须为 YYYY-MM-DD")
            try:
                datetime.strptime(end_after, "%Y-%m-%d")
            except ValueError:
                raise ValueError("结束日期无效")
        out = dict(v)
        if interval is not None:
            out["interval"] = interval
        if weekdays is not None:
            out["weekdays"] = sorted(seen)
        if month_day is not None:
            out["monthDay"] = month_day
        return out


class RemindersSyncRequest(BaseModel):
    tasks: List[ReminderTask]
    # 前端当前已加载的项目 id 列表；后端仅替换这些项目的提醒行，
    # 未加载项目的提醒保留不动，避免“部分同步”误删导致已发送提醒重发。
    projectIds: List[str] = []


class ClientLogRequest(BaseModel):
    """前端（客户端）行为上报：如任务/项目增删改、打开回收站/设置、显示密钥等。"""
    action: str
    detail: str = ""

    @field_validator("action", mode="before")
    @classmethod
    def _action(cls, v):
        return _strip(v)[:50]

    @field_validator("detail", mode="before")
    @classmethod
    def _detail(cls, v):
        return _strip(v)[:500]


class LogRetentionRequest(BaseModel):
    days: int

    @field_validator("days")
    @classmethod
    def _days(cls, v):
        if not (1 <= v <= 365):
            raise ValueError("保留天数需在 1-365 之间")
        return v

class NotifyPrefs(BaseModel):
    """安全邮件通知开关（登录成功 / 登录失败 / 隐私日记解锁）。

    - 登录成功、登录失败默认开启；
    - 查看密钥通知不可关闭（恒 True）；
    - 隐私日记「进入成功 / 进入失败」默认开启，可进入日记后在日记设置里开关；
    - 日记改密/导出/导入/删除通知为安全保护，不可关闭（后端恒开启、不设开关）。
    """
    login_success: bool = True
    login_failed: bool = True
    key_view: bool = True
    diary_unlock_success: bool = True
    diary_unlock_failed: bool = True


class NotifyPrefsRequest(BaseModel):
    """更新安全邮件通知开关：只更新提交的字段，未提交字段保持不变。

    key_view 及日记改密/导出/导入/删除通知不可关闭，后端恒强制开启。
    """
    login_success: Optional[bool] = None
    login_failed: Optional[bool] = None
    diary_unlock_success: Optional[bool] = None
    diary_unlock_failed: Optional[bool] = None


# ---------- 同步协调中心 ----------

# 客户端可上报的资源类型（与前端 store 一一对应）
SYNC_RES_TYPES = ("profile", "tasks", "trash", "repeats", "stats", "today_order")


class SyncChangeItem(BaseModel):
    """客户端上报的一次变更事件：哪类资源、哪个项目（profile/stats 无项目）。"""
    res_type: str
    project_id: Optional[str] = None

    @field_validator("res_type", mode="before")
    @classmethod
    def _res_type(cls, v):
        v = _strip(v)
        if v not in SYNC_RES_TYPES:
            raise ValueError("无效的资源类型")
        return v

    @field_validator("project_id", mode="before")
    @classmethod
    def _project_id(cls, v):
        if v is None:
            return None
        v = _strip(v)
        if len(v) > 200:
            raise ValueError("project_id 过长")
        return v


class SyncReportRequest(BaseModel):
    events: List[SyncChangeItem] = []


class SyncStateItem(BaseModel):
    id: int
    res_type: str
    project_id: Optional[str] = None
    ts: str


class SyncStateResponse(BaseModel):
    version: int
    full_sync: bool
    changes: List[SyncStateItem]
