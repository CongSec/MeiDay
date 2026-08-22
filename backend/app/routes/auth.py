import asyncio
import sqlite3
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request

from ..audit import (
    client_ip,
    log_action,
)
from ..auth import (
    clear_failed_attempts,
    create_session,
    destroy_other_sessions,
    destroy_session,
    get_username,
    hash_verifier,
    is_account_locked,
    register_failed_attempt,
    remaining_lock_seconds,
    sha256_b64,
    verify_password,
    verify_verifier,
)
from ..db import get_conn
from ..services.notifier import notify_security_event
from ..schemas import (
    ChangePasswordRequest,
    LegacyLoginRequest,
    LoginRequest,
    LoginResponse,
    MeResponse,
    RegisterRequest,
)

router = APIRouter(prefix="/api", tags=["auth"])


def _ua(request: Request) -> str:
    return request.headers.get("user-agent", "") if request else ""


def _ip(request: Request) -> str:
    return client_ip(request) if request else ""


# 安全通知邮件任务引用集：持有 asyncio.Task 引用，防止任务被事件循环提前回收。
# 关键：BackgroundTasks 只在端点正常返回时才执行；登录失败会 raise HTTPException，
# 异常路径下 background tasks 不会运行（这就是此前登录失败不触发邮件的根因）。
# 因此失败/成功路径统一用 asyncio.create_task 主动调度（notifier 内部全 try/except，绝不抛错）。
_notify_tasks: set["asyncio.Task"] = set()


def _spawn_security_notification(username: str, kind: str, ip: str, ua: str) -> None:
    """在事件循环中异步调度安全通知邮件（fire-and-forget，不影响业务响应）。"""
    task = asyncio.create_task(notify_security_event(username, kind, ip, ua))
    _notify_tasks.add(task)
    task.add_done_callback(_notify_tasks.discard)


# BUG-07: 注册频率限制（简单进程内滑动窗口：每 IP 每分钟最多 10 次）
_REGISTER_WINDOW_SECONDS = 60
_REGISTER_MAX_PER_WINDOW = 10
_register_attempts: dict[str, list[float]] = {}


def _check_register_rate_limit(ip: str) -> None:
    now = time.monotonic()
    arr = _register_attempts.setdefault(ip, [])
    arr[:] = [t for t in arr if now - t < _REGISTER_WINDOW_SECONDS]
    if len(arr) >= _REGISTER_MAX_PER_WINDOW:
        raise HTTPException(status_code=429, detail="注册过于频繁，请稍后再试")
    arr.append(now)


@router.post("/register", status_code=201)
def register(body: RegisterRequest, request: Request = None):
    username = body.username.strip()
    if not username or not body.passwordHash:
        raise HTTPException(status_code=400, detail="用户名/密码校验值不能为空")
    _check_register_rate_limit(_ip(request))
    with get_conn() as conn:
        if conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            raise HTTPException(status_code=409, detail="用户名已存在")
        try:
            # 存储 argon2(SHA-256(password))：明文密码不落地、不传输
            conn.execute(
                "INSERT INTO users (username, argon2_hash, salt, encrypted_creds, auth_version) VALUES (?,?,?,?,?)",
                (username, hash_verifier(body.passwordHash), username, body.encrypted_creds, 1),
            )
            if body.smtp_plain:
                conn.execute(
                    "INSERT INTO smtp_creds (username, smtp_user, smtp_pass, notify_email) VALUES (?,?,?,?)",
                    (username, body.smtp_plain.smtp_user, body.smtp_plain.smtp_pass, body.smtp_plain.notify_email),
                )
        except sqlite3.IntegrityError:
            # BUG-06: 并发注册同名的唯一约束兜底：SELECT 检查非原子，INSERT 冲突时返回 409 而非 500
            raise HTTPException(status_code=409, detail="用户名已存在")
    # 注册动作保留在服务器日志中，归属新用户自己（其他用户看不到）
    log_action(
        "注册", username=username, method="POST", path="/api/register",
        status=201, ip=_ip(request), user_agent=_ua(request),
        detail="新用户注册",
    )
    return {"ok": True}


def _build_login_response(
    username: str, row, token: str, request: Request,
    action: str = "login", path: str = "/api/login",
) -> LoginResponse:
    """构造成功登录响应。旧账号迁移登录可传独立 action/path 以便审计区分。

    安全通知（登录成功）邮件由路由在响应后异步发送，不再弹窗提示。
    """
    log_action(
        action, username=username, method="POST", path=path,
        status=200, ip=_ip(request), user_agent=_ua(request),
    )
    return LoginResponse(
        sessionToken=token,
        encrypted_creds=row["encrypted_creds"],
    )


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest, request: Request):
    username = body.username.strip()
    ip = _ip(request)
    ua = _ua(request)
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if not row:
        # 不存在的用户名不触发锁定，仅记录登录失败（爆破提醒）；无账号无法邮件通知
        log_action(
            "login_failed", username=username, method="POST", path="/api/login",
            status=401, ip=ip, user_agent=ua,
            detail=f"⚠️ 密码登录失败（重点关注）：用户名或密码错误，来自 {ip or '未知IP'}",
            is_security=True,
        )
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    # 防爆破：锁定期间直接拒绝（423），不递增失败计数；账号存在，邮件通知本人
    if is_account_locked(row):
        log_action(
            "login_locked", username=username, method="POST", path="/api/login",
            status=423, ip=ip, user_agent=ua,
            detail=f"🔒 账号因连续密码错误已被临时锁定，剩余 {remaining_lock_seconds(row)} 秒",
            is_security=True,
        )
        _spawn_security_notification(username, "login_failed", ip, ua)
        mins = max(1, int(remaining_lock_seconds(row) / 60) + (1 if remaining_lock_seconds(row) % 60 else 0))
        raise HTTPException(status_code=423, detail=f"密码错误次数过多，账号已锁定，请约 {mins} 分钟后再试")
    # 旧账号（auth_version=0）：存储为 argon2(明文密码)，无法用 verifier 校验，
    # 返回 428 让前端用用户刚输入的原始密码走一次性 /api/login/legacy 迁移。
    if row["auth_version"] == 0:
        raise HTTPException(
            status_code=428,
            detail="账号需要升级密码校验方式，请重试",
        )
    if not verify_verifier(body.passwordHash, row["argon2_hash"]):
        locked_now = register_failed_attempt(username)
        log_action(
            "login_failed", username=username, method="POST", path="/api/login",
            status=401, ip=ip, user_agent=ua,
            detail=(
                f"⚠️ 密码登录失败（重点关注）：用户名或密码错误，来自 {ip or '未知IP'}"
                + ("，已触发账号临时锁定" if locked_now else "")
            ),
            is_security=True,
        )
        _spawn_security_notification(username, "login_failed", ip, ua)
        if locked_now:
            raise HTTPException(status_code=423, detail="密码错误次数过多，账号已锁定 30 分钟")
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    clear_failed_attempts(username)
    token = create_session(username)
    _spawn_security_notification(username, "login_success", ip, ua)
    return _build_login_response(username, row, token, request)


@router.post("/login/legacy", response_model=LoginResponse)
async def legacy_login(body: LegacyLoginRequest, request: Request):
    """旧账号一次性迁移登录：历史账号 argon2 存的是明文密码哈希，
    无法用 verifier 校验。此端点接收一次明文密码完成校验，并立即把存储
    升级为 argon2(SHA-256(password))（auth_version 置 1），此后只走 verifier。
    登录成功/失败的安全邮件通知与 /api/login 一致（响应后异步发送）。
    """
    username = body.username.strip()
    ip = _ip(request)
    ua = _ua(request)
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    # BUG-03: 锁定期间必须拒绝（与 /login 一致），不能绕过锁定
    if row is not None and is_account_locked(row):
        log_action(
            "login_locked", username=username, method="POST", path="/api/login/legacy",
            status=423, ip=ip, user_agent=ua,
            detail=f"🔒 账号因连续密码错误已被临时锁定，剩余 {remaining_lock_seconds(row)} 秒",
            is_security=True,
        )
        _spawn_security_notification(username, "login_failed", ip, ua)
        mins = max(1, int(remaining_lock_seconds(row) / 60) + (1 if remaining_lock_seconds(row) % 60 else 0))
        raise HTTPException(status_code=423, detail=f"密码错误次数过多，账号已锁定，请约 {mins} 分钟后再试")
    if not row or not verify_password(body.password, row["argon2_hash"]):
        if row is not None:
            locked_now = register_failed_attempt(username)
            if locked_now:
                log_action(
                    "login_failed", username=username, method="POST", path="/api/login/legacy",
                    status=423, ip=ip, user_agent=ua,
                    detail=f"⚠️ 密码登录失败（重点关注）：来自 {ip or '未知IP'}，已触发账号临时锁定",
                    is_security=True,
                )
                _spawn_security_notification(username, "login_failed", ip, ua)
                raise HTTPException(status_code=423, detail="密码错误次数过多，账号已锁定 30 分钟")
        log_action(
            "login_failed", username=username, method="POST", path="/api/login/legacy",
            status=401, ip=ip, user_agent=ua,
            detail=f"⚠️ 密码登录失败（重点关注）：用户名或密码错误，来自 {ip or '未知IP'}",
            is_security=True,
        )
        if row is not None:
            _spawn_security_notification(username, "login_failed", ip, ua)
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    # 迁移到 verifier 方案：argon2(SHA-256(password))
    verifier = sha256_b64(body.password)
    with get_conn() as conn:
        conn.execute(
            "UPDATE users SET argon2_hash=?, auth_version=1 WHERE username=?",
            (hash_verifier(verifier), username),
        )
        row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    clear_failed_attempts(username)
    token = create_session(username)
    _spawn_security_notification(username, "login_success", ip, ua)
    return _build_login_response(
        username, row, token, request,
        action="登录迁移", path="/api/login/legacy",
    )


@router.post("/change-password")
def change_password(
    body: ChangePasswordRequest,
    username: str = Depends(get_username),
    request: Request = None,
):
    """修改密码：校验旧密码校验子（verifier）后，用 argon2 慢哈希存储新校验子。

    - 只接收 SHA-256(password) 校验子，明文密码不出浏览器、不出服务器内存；
    - 原密码错误时计入防爆破失败计数（达到阈值锁定 30 分钟），并记录安全日志；
    - 已登录账号必然已完成 legacy 迁移（auth_version=1），此处仅作防御性校验；
    - 修改成功后记录"修改密码"安全日志（不含任何密码/密钥明文）。
    """
    ip = _ip(request)
    ua = _ua(request)
    # 提取当前会话 token，用于改密后吊销其它多端会话
    auth_hdr = request.headers.get("authorization", "") if request else ""
    current_token = auth_hdr[len("Bearer "):].strip() if auth_hdr.startswith("Bearer ") else ""
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="用户不存在")
    # BUG-04: 锁定期间拒绝改密，与登录一致
    if is_account_locked(row):
        log_action(
            "修改密码失败", username=username, method="POST", path="/api/change-password",
            status=423, ip=ip, user_agent=ua,
            detail=f"🔒 账号因连续密码错误已被临时锁定，剩余 {remaining_lock_seconds(row)} 秒",
            is_security=True,
        )
        mins = max(1, int(remaining_lock_seconds(row) / 60) + (1 if remaining_lock_seconds(row) % 60 else 0))
        raise HTTPException(status_code=423, detail=f"密码错误次数过多，账号已锁定，请约 {mins} 分钟后再试")
    if row["auth_version"] == 0:
        # 防御性分支：正常情况下登录后即为 1；若为 0 则提示先登录完成升级
        raise HTTPException(status_code=400, detail="账号尚未完成密码校验升级，请退出后重新登录一次")
    if not verify_verifier(body.oldPasswordHash, row["argon2_hash"]):
        locked_now = register_failed_attempt(username)
        log_action(
            "修改密码失败", username=username, method="POST", path="/api/change-password",
            status=400, ip=ip, user_agent=ua,
            detail=f"⚠️ 原密码校验失败（重点关注），来自 {ip or '未知IP'}"
            + ("，已触发账号临时锁定" if locked_now else ""),
            is_security=True,
        )
        if locked_now:
            raise HTTPException(status_code=423, detail="原密码错误次数过多，账号已锁定 30 分钟")
        raise HTTPException(status_code=400, detail="原密码不正确")
    # 关键一致性守卫：账号已保存过 OSS 凭证（encrypted_creds 非空）时，改密必须
    # 同时提交用“新密码派生密钥”重新加密后的凭证密文。否则后端仅轮换密码哈希、
    # 却保留旧密码密钥加密的凭证密文，改密后该凭证永远无法用新密码解密（成为“孤儿”凭证）。
    # 放在旧密码校验通过之后，避免向未掌握密码者泄露“该账号是否已配置凭证”这一信息。
    if row["encrypted_creds"] and body.newEncryptedCreds is None:
        raise HTTPException(
            status_code=400,
            detail="账号已保存 OSS 凭证，修改密码必须同时重新加密凭证；请先在「设置」确认凭证可用后重试",
        )
    now = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")
    with get_conn() as conn:
        if body.newEncryptedCreds is not None:
            # 与密码哈希在同一事务内更新凭证密文，保证改密与凭证重加密原子完成
            conn.execute(
                "UPDATE users SET argon2_hash=?, auth_version=1, encrypted_creds=?, creds_updated_at=?, failed_attempts=0, last_failed_at=NULL, locked_until=NULL WHERE username=?",
                (hash_verifier(body.newPasswordHash), body.newEncryptedCreds, now, username),
            )
        else:
            conn.execute(
                "UPDATE users SET argon2_hash=?, auth_version=1, failed_attempts=0, last_failed_at=NULL, locked_until=NULL WHERE username=?",
                (hash_verifier(body.newPasswordHash), username),
            )
    log_action(
        "修改密码", username=username, method="POST", path="/api/change-password",
        status=200, ip=ip, user_agent=ua,
        detail="密码修改成功（原密码校验通过）",
        is_security=True,
    )
    # 改密后吊销该账号其余多端会话：旧会话持有“旧密码”派生密钥，
    # 若仍有效 token，可能用旧密钥覆写 OSS 凭证/数据，导致改密后解密失败或同步冲突。
    if current_token:
        destroy_other_sessions(username, current_token)
    return {"ok": True}


@router.post("/logout")
def logout(username: str = Depends(get_username), authorization: str = Header(...), request: Request = None):
    token = authorization[len("Bearer "):].strip()
    destroy_session(token)
    log_action(
        "logout", username=username, method="POST", path="/api/logout",
        status=200, ip=_ip(request), user_agent=_ua(request),
    )
    return {"ok": True}


@router.get("/me", response_model=MeResponse)
def me(username: str = Depends(get_username)):
    with get_conn() as conn:
        row = conn.execute("SELECT username, encrypted_creds FROM users WHERE username=?", (username,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="用户不存在")
    return MeResponse(
        username=row["username"],
        hasCreds=bool(row["encrypted_creds"]),
    )
