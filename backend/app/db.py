import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "dev.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    argon2_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    encrypted_creds TEXT,
    creds_updated_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- 认证方案版本：0=旧版 argon2(明文密码)，1=argon2(SHA-256(password)) 校验子
    auth_version INTEGER NOT NULL DEFAULT 1,
    -- 登录防爆破：连续密码错误计数 / 最近一次失败时间 / 锁定截止时间
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    last_failed_at TEXT,
    locked_until TEXT
);

CREATE TABLE IF NOT EXISTS smtp_creds (
    username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
    smtp_user TEXT NOT NULL,
    smtp_pass TEXT NOT NULL,
    notify_email TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notify_prefs (
    username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
    login_success INTEGER NOT NULL DEFAULT 1,
    login_failed INTEGER NOT NULL DEFAULT 1,
    key_view INTEGER NOT NULL DEFAULT 1,
    -- 隐私日记通知：进入成功/失败默认开启，可进入日记后在日记设置里开关（仅前端隐藏入口）
    diary_unlock_success INTEGER NOT NULL DEFAULT 1,
    diary_unlock_failed INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS reminders (
    username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    subtask_id TEXT NOT NULL DEFAULT '',
    project_id TEXT,
    name TEXT NOT NULL,
    description TEXT,
    start_time TEXT,
    end_time TEXT,
    reminder_time TEXT,
    is_reminded INTEGER DEFAULT 0,
    -- 重复任务提醒规则（JSON）：服务器只存这一条规则，发完邮件后自行按周期推进提醒时间
    repeat_rule TEXT,
    PRIMARY KEY (username, task_id, subtask_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sent_reminders (
    username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    subtask_id TEXT NOT NULL DEFAULT '',
    reminder_time TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (username, task_id, subtask_id, reminder_time)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    username TEXT,
    action TEXT NOT NULL,
    method TEXT,
    path TEXT,
    status INTEGER,
    ip TEXT,
    user_agent TEXT,
    detail TEXT,
    duration_ms INTEGER,
    is_security INTEGER DEFAULT 0,
    is_high_risk INTEGER DEFAULT 0,
    acknowledged_at TEXT,
    remind_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_username ON audit_logs(username);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

-- 备份日志表：用户手动清空自己的操作日志、或后台按保留天数自动清理过期日志时，
-- 都先把这些记录原样复制到本表留存（保留原 audit_logs.id，并记录归档时间
-- archived_at 与触发归档的来源 archived_by；archived_by 为空串表示自动清理），
-- 随后才从 audit_logs 删除，保证清理后服务器侧仍有可审计留痕。
CREATE TABLE IF NOT EXISTS audit_logs_backup (
    id INTEGER PRIMARY KEY,            -- 原 audit_logs.id（同一记录不会重复归档）
    created_at TEXT NOT NULL,
    username TEXT,
    action TEXT NOT NULL,
    method TEXT,
    path TEXT,
    status INTEGER,
    ip TEXT,
    user_agent TEXT,
    detail TEXT,
    duration_ms INTEGER,
    is_security INTEGER DEFAULT 0,
    is_high_risk INTEGER DEFAULT 0,
    acknowledged_at TEXT,
    remind_count INTEGER DEFAULT 0,
    archived_at TEXT,                  -- 归档（备份）时间
    archived_by TEXT                   -- 触发备份的来源：手动清空者用户名；空串=自动清理
);
CREATE INDEX IF NOT EXISTS idx_audit_backup_username ON audit_logs_backup(username);
CREATE INDEX IF NOT EXISTS idx_audit_backup_archived ON audit_logs_backup(archived_at);
-- 同步协调中心：每个用户最近发生的资源变更事件（res_type + project_id）。
-- 客户端在 OSS 写入成功后上报；其它设备轮询 /api/sync/state 按版本号增量拉取。
-- 只记录"谁的数据变了"，不存任何业务数据本身。
CREATE TABLE IF NOT EXISTS sync_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    res_type TEXT NOT NULL,
    project_id TEXT,
    ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_changes_user ON sync_changes(username, id);
"""


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _migrate_reminders(conn: sqlite3.Connection) -> None:
    """旧版 reminders 表以 (username, task_id) 为主键、无 subtask_id 列。
    子任务提醒需要 (username, task_id, subtask_id) 三元主键，重建表迁移。"""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(reminders)").fetchall()]
    if "subtask_id" in cols:
        return
    conn.executescript(
        """
        ALTER TABLE reminders RENAME TO reminders_old;
        CREATE TABLE reminders (
            username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
            task_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL DEFAULT '',
            project_id TEXT,
            name TEXT NOT NULL,
            description TEXT,
            start_time TEXT,
            end_time TEXT,
            reminder_time TEXT,
            is_reminded INTEGER DEFAULT 0,
            PRIMARY KEY (username, task_id, subtask_id)
        );
        INSERT INTO reminders (username, task_id, subtask_id, project_id, name, description,
                               start_time, end_time, reminder_time, is_reminded)
        SELECT username, task_id, '', project_id, name, description,
               start_time, end_time, reminder_time, is_reminded
        FROM reminders_old;
        DROP TABLE reminders_old;
        """
    )

def _migrate_reminders_repeat_rule(conn: sqlite3.Connection) -> None:
    """旧库 reminders 表没有 repeat_rule 列，启动时补齐（重复任务提醒的周期规则）。"""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(reminders)").fetchall()]
    if "repeat_rule" not in cols:
        conn.execute("ALTER TABLE reminders ADD COLUMN repeat_rule TEXT")


def _migrate_users_v2(conn: sqlite3.Connection) -> None:
    """安全改造：去掉 users.email 列；新增 auth_version / failed_attempts / last_failed_at / locked_until。

    - email 从未用于登录或通知（通知收件人走 smtp_creds.notify_email），直接删除；
    - 历史账号 argon2 存的是明文密码哈希（legacy），auth_version 置 0，
      首次登录时经一次性 /api/login/legacy 迁移到 verifier 校验方案；
    - 新库 SCHEMA 默认 auth_version=1（新注册直接用 verifier）。
    """
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
    if "email" not in cols:
        return
    old = conn.isolation_level
    conn.isolation_level = None  # 自动提交模式，PRAGMA foreign_keys 才生效
    conn.execute("PRAGMA foreign_keys=OFF")
    try:
        conn.execute(
            """
            CREATE TABLE users_new (
                username TEXT PRIMARY KEY,
                argon2_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                encrypted_creds TEXT,
                creds_updated_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                auth_version INTEGER NOT NULL DEFAULT 0,
                failed_attempts INTEGER NOT NULL DEFAULT 0,
                last_failed_at TEXT,
                locked_until TEXT
            )
            """
        )
        conn.execute(
            """
            INSERT INTO users_new (username, argon2_hash, salt, encrypted_creds, creds_updated_at, created_at, auth_version)
            SELECT username, argon2_hash, salt, encrypted_creds, creds_updated_at, created_at, 0 FROM users
            """
        )
        conn.execute("DROP TABLE users")
        conn.execute("ALTER TABLE users_new RENAME TO users")
        conn.execute("PRAGMA foreign_keys=ON")
    finally:
        conn.isolation_level = old


def _migrate_audit_is_security(conn: sqlite3.Connection) -> None:
    """旧库 audit_logs 表没有 is_security 列，启动时补齐（登录失败等重点记录标记）。"""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(audit_logs)").fetchall()]
    if "is_security" not in cols:
        conn.execute("ALTER TABLE audit_logs ADD COLUMN is_security INTEGER DEFAULT 0")


def _migrate_audit_logs_v2(conn: sqlite3.Connection) -> None:
    """旧库 audit_logs 表没有 is_high_risk 列，启动时补齐。

    - is_high_risk：高危操作（如显示密钥）的显眼标志。
    说明：acknowledged_at / remind_count 为历史“安全弹窗确认”遗留列，
    新版本改为邮件通知后不再使用，仅保留列避免破坏旧库结构。
    """
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(audit_logs)").fetchall()]
    if "is_high_risk" not in cols:
        conn.execute("ALTER TABLE audit_logs ADD COLUMN is_high_risk INTEGER DEFAULT 0")
    if "acknowledged_at" not in cols:
        conn.execute("ALTER TABLE audit_logs ADD COLUMN acknowledged_at TEXT")
    if "remind_count" not in cols:
        conn.execute("ALTER TABLE audit_logs ADD COLUMN remind_count INTEGER DEFAULT 0")


def _migrate_notify_prefs_diary(conn: sqlite3.Connection) -> None:
    """旧库 notify_prefs 表没有隐私日记通知开关列，启动时补齐（默认开启）。

    改密/导出/导入/删除日记通知为安全保护，不可关闭，不设开关列、恒为开启。
    """
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(notify_prefs)").fetchall()]
    if "diary_unlock_success" not in cols:
        conn.execute("ALTER TABLE notify_prefs ADD COLUMN diary_unlock_success INTEGER NOT NULL DEFAULT 1")
    if "diary_unlock_failed" not in cols:
        conn.execute("ALTER TABLE notify_prefs ADD COLUMN diary_unlock_failed INTEGER NOT NULL DEFAULT 1")


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        _migrate_reminders(conn)
        _migrate_reminders_repeat_rule(conn)
        _migrate_audit_is_security(conn)
        _migrate_audit_logs_v2(conn)
        _migrate_users_v2(conn)
        _migrate_notify_prefs_diary(conn)
        # 登录成功通知默认开启、查看密钥通知不可关闭：强制存量行也置为开启
        conn.execute("UPDATE notify_prefs SET login_success=1, key_view=1")
        # 清理已删除用户遗留的孤儿提醒数据（可能来自外键关闭时期写入的旧库），
        # 否则向 sent_reminders 回填会触发外键约束失败，导致启动报错。
        conn.execute(
            "DELETE FROM reminders WHERE username NOT IN (SELECT username FROM users)"
        )
        conn.execute(
            "DELETE FROM sent_reminders WHERE username NOT IN (SELECT username FROM users)"
        )
        # 迁移历史：把已发送(is_reminded=1)的行回填到 sent_reminders，
        # 避免老数据在下次同步时被当作“未发送”而重新发信。
        now = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")
        conn.execute(
            """
            INSERT OR IGNORE INTO sent_reminders (username, task_id, subtask_id, reminder_time, sent_at)
            SELECT username, task_id, subtask_id, reminder_time, ?
            FROM reminders
            WHERE is_reminded=1 AND reminder_time IS NOT NULL AND reminder_time != ''
              AND username IN (SELECT username FROM users)
            """,
            (now,),
        )

# ---------- 同步协调中心（/api/sync） ----------

def get_sync_version(conn: sqlite3.Connection, username: str) -> int:
    """该用户当前的总版本号 = 最近一条 sync_changes 的 id；无记录返回 0。"""
    row = conn.execute(
        "SELECT COALESCE(MAX(id), 0) AS v FROM sync_changes WHERE username=?", (username,)
    ).fetchone()
    return int(row["v"])


def add_sync_changes(username: str, events) -> int:
    """写入一批变更事件并返回该用户最新的总版本号。events: [(res_type, project_id), ...]"""
    if not events:
        with get_conn() as conn:
            return get_sync_version(conn, username)
    with get_conn() as conn:
        ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
        conn.executemany(
            "INSERT INTO sync_changes (username, res_type, project_id, ts) VALUES (?,?,?,?)",
            [(username, res_type, project_id, ts) for (res_type, project_id) in events],
        )
        return get_sync_version(conn, username)


def delete_sync_changes_older_than(hours: int) -> int:
    """删除超过保留时长的同步变更事件，返回删除条数（离线设备靠 full_sync 全量补拉）。"""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat(timespec="seconds")
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM sync_changes WHERE ts < ?", (cutoff,))
        return cur.rowcount
