import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from argon2 import PasswordHasher
from fastapi import Header, HTTPException

from .db import get_conn

TZ = timezone(timedelta(hours=8))
SESSION_TTL_DAYS = 7
LOCKOUT_THRESHOLD = 5
LOCKOUT_MINUTES = 30
FAIL_WINDOW_MINUTES = 30

ph = PasswordHasher()


def _now() -> datetime:
    return datetime.now(TZ)


def verify_password(password: str, hashed: str) -> bool:
    try:
        ph.verify(hashed, password)
        return True
    except Exception:
        return False


def sha256_b64(s: str) -> str:
    """SHA-256(password) 摘要的 base64（客户端与服务端一致的登录校验子，不可逆）。"""
    return base64.b64encode(hashlib.sha256(s.encode("utf-8")).digest()).decode("ascii")


def hash_verifier(verifier: str) -> str:
    """对客户端发送的 SHA-256(password) 校验子再做 argon2 慢哈希后存储。"""
    return ph.hash(verifier)


def verify_verifier(verifier: str, stored: str) -> bool:
    """校验客户端发送的 verifier 是否与存储的 argon2(verifier) 匹配。"""
    try:
        ph.verify(stored, verifier)
        return True
    except Exception:
        return False


def is_account_locked(row) -> bool:
    """账号是否处于锁定期（locked_until 晚于当前时间）。"""
    locked_until = row["locked_until"]
    if not locked_until:
        return False
    try:
        return datetime.fromisoformat(locked_until) > _now()
    except (TypeError, ValueError):
        return False


def remaining_lock_seconds(row) -> int:
    """账号剩余锁定秒数（未锁定返回 0）。"""
    locked_until = row["locked_until"]
    if not locked_until:
        return 0
    try:
        return max(0, int((datetime.fromisoformat(locked_until) - _now()).total_seconds()))
    except (TypeError, ValueError):
        return 0


def register_failed_attempt(username: str) -> bool:
    """记录一次密码错误：窗口内连续失败达到阈值后锁定 30 分钟。返回是否刚触发锁定。

    - 距上次失败超过 FAIL_WINDOW_MINUTES 则重新计数（30 分钟窗口）；
    - 触发锁定时把计数清零，锁定结束后从头计数；
    - 锁定期间由路由直接拒绝（423），不再调用本函数计数。
    """
    now = _now()
    with get_conn() as conn:
        current = conn.execute(
            "SELECT failed_attempts, last_failed_at FROM users WHERE username=?",
            (username,),
        ).fetchone()
        if current is None:
            return False
        attempts = current["failed_attempts"] or 0
        last = current["last_failed_at"]
        if last:
            try:
                if (now - datetime.fromisoformat(last)).total_seconds() > FAIL_WINDOW_MINUTES * 60:
                    attempts = 0
            except (TypeError, ValueError):
                attempts = 0
        attempts += 1
        if attempts >= LOCKOUT_THRESHOLD:
            locked_until = (now + timedelta(minutes=LOCKOUT_MINUTES)).isoformat(timespec="seconds")
            conn.execute(
                "UPDATE users SET failed_attempts=0, last_failed_at=?, locked_until=? WHERE username=?",
                (now.isoformat(timespec="seconds"), locked_until, username),
            )
            return True
        conn.execute(
            "UPDATE users SET failed_attempts=?, last_failed_at=? WHERE username=?",
            (attempts, now.isoformat(timespec="seconds"), username),
        )
        return False


def clear_failed_attempts(username: str) -> None:
    """登录成功后清零连续失败计数与锁定状态。"""
    with get_conn() as conn:
        conn.execute(
            "UPDATE users SET failed_attempts=0, last_failed_at=NULL, locked_until=NULL WHERE username=?",
            (username,),
        )


# 每账号最多允许的并发会话数：超出后踢掉最旧会话（BUG-11）
MAX_SESSIONS_PER_USER = 5


def _hash_token(token: str) -> str:
    """会话 token 的不可逆摘要：DB 只存摘要，不存明文（BUG-26）。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(username: str) -> str:
    token = secrets.token_urlsafe(32)
    expires = (_now() + timedelta(days=SESSION_TTL_DAYS)).isoformat(timespec="seconds")
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM sessions WHERE username=? AND expires_at < ?",
            (username, _now().isoformat(timespec="seconds")),
        )
        conn.execute(
            "INSERT INTO sessions (token, username, expires_at) VALUES (?,?,?)",
            (_hash_token(token), username, expires),
        )
        # 会话数上限：插入后再只保留最新 MAX_SESSIONS_PER_USER 条，踢掉更旧的会话，
        # 保证任意时刻最多 MAX_SESSIONS_PER_USER 条（BUG-11）
        conn.execute(
            "DELETE FROM sessions WHERE username=? AND rowid NOT IN ("
            "  SELECT rowid FROM sessions WHERE username=? ORDER BY rowid DESC LIMIT ?"
            ")",
            (username, username, MAX_SESSIONS_PER_USER),
        )
    return token


def destroy_session(token: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM sessions WHERE token=?", (_hash_token(token),))

def destroy_other_sessions(username: str, keep_token: str) -> None:
    """改密后吊销该账号除当前会话外的所有其它会话。

    多端旧会话里保持着用“旧密码”派生的 userKey，若继续有效，
    可能在其它设备上用旧密钥重新加密/覆写 OSS 凭证密文，
    导致改密后凭证密文与当前密码失配（“孤儿”凭证）和数据同步冲突。
    """
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM sessions WHERE username=? AND token<>?",
            (username, _hash_token(keep_token)),
        )



def username_from_token(token: str) -> Optional[str]:
    """由会话 token 解析用户名；无效或过期返回 None（供中间件审计使用）。"""
    now = _now().isoformat(timespec="seconds")
    with get_conn() as conn:
        row = conn.execute(
            "SELECT username, expires_at FROM sessions WHERE token=?", (_hash_token(token),)
        ).fetchone()
        if row and row["expires_at"] < now:
            conn.execute("DELETE FROM sessions WHERE token=?", (_hash_token(token),))
            row = None
    return row["username"] if row else None


def get_username(
    authorization: Optional[str] = Header(None, alias="Authorization"),
) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    username = username_from_token(authorization[len("Bearer "):].strip())
    if not username:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return username