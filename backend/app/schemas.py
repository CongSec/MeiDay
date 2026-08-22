import base64
import re
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


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
    服务端对校验子再做 argon2 慢哈希存储，避免明文密码出现在网络中。"""
    username: str
    passwordHash: str
    encrypted_creds: Optional[str] = None
    smtp_plain: Optional["SmtpPlain"] = None

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

    AK/SK 由前端在加载失败时临时提交，后端只在内存中使用 oss2 探活。
    审计中间件只记录请求路径与状态码，不记录请求体。
    """
    oss_ak: str
    oss_sk: str
    bucket: str
    region: str

    @field_validator("oss_ak", "oss_sk", "bucket", "region", mode="before")
    @classmethod
    def _nonempty(cls, v):
        v = _strip(v)
        if not v:
            raise ValueError("OSS 诊断参数不能为空")
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
    """安全邮件通知开关（登录成功 / 登录失败 / 查看密钥）。登录成功默认关闭，其余默认开启。"""
    login_success: bool = False
    login_failed: bool = True
    key_view: bool = True


class NotifyPrefsRequest(BaseModel):
    """更新安全邮件通知开关：只更新提交的字段，未提交字段保持不变。"""
    login_success: Optional[bool] = None
    login_failed: Optional[bool] = None
    key_view: Optional[bool] = None

