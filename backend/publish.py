#!/usr/bin/env python3
"""发布 MeiDay 中心公告：直接写入服务器 SQLite（兼容 MEIDAY_DATA_DIR）。

用法（在服务器上运行，无需安装任何第三方依赖，仅标准库 sqlite3）：
    python publish.py --title "系统更新" --content "v1.8.0 已上线，修复了同步问题"
    python publish.py --title "维护通知" --content-file notice.txt   # 正文从 UTF-8 文件读取（支持多行）

公告发布后：所有已登录用户下次登录（重新进入主界面）时弹出；
未读游标在用户端逐条弹窗后推进，多设备同步。
"""
import argparse
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# 北京时间（与业务日志口径一致）
TZ = timezone(timedelta(hours=8))


def resolve_db_path() -> Path:
    """与 backend/app/db.py 保持一致：
    - 设置了 MEIDAY_DATA_DIR（Docker 部署）→ 该目录下的 dev.db；
    - 未设置（本地开发）→ 本脚本所在目录（backend/）下的 dev.db。
    脚本放在 backend/ 目录下，Path(__file__).resolve().parent 即为 backend/。
    """
    base = Path(os.environ.get("MEIDAY_DATA_DIR", str(Path(__file__).resolve().parent)))
    return base / "dev.db"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="发布 MeiDay 中心公告（直接写数据库，纯文本标题+内容，无 Markdown 渲染）"
    )
    parser.add_argument("--title", required=True, help="公告标题")
    content_group = parser.add_mutually_exclusive_group(required=True)
    content_group.add_argument("--content", help="公告正文（纯文本；多行请用引号包裹或用 --content-file）")
    content_group.add_argument("--content-file", help="从 UTF-8 文件读取公告正文（支持多行）")
    args = parser.parse_args()

    title = args.title.strip()
    if not title:
        print("公告标题不能为空", file=sys.stderr)
        return 1

    content = args.content
    if args.content_file:
        try:
            # utf-8-sig：自动剥离 Windows 编辑器（记事本等）写入的 UTF-8 BOM
            content = Path(args.content_file).read_text(encoding="utf-8-sig")
        except OSError as e:
            print(f"读取内容文件失败：{e}", file=sys.stderr)
            return 1
    if not content or not content.strip():
        print("公告内容不能为空", file=sys.stderr)
        return 1
    content = content.strip()

    db_path = resolve_db_path()
    if not db_path.exists():
        print(f"数据库不存在：{db_path}", file=sys.stderr)
        print("请确认脚本放在 backend/ 目录下，或已设置 MEIDAY_DATA_DIR 环境变量。", file=sys.stderr)
        return 1

    created_at = datetime.now(TZ).isoformat(timespec="seconds")
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        conn.execute(
            "INSERT INTO announcements (title, content, created_at) VALUES (?, ?, ?)",
            (title, content, created_at),
        )
        conn.commit()
        new_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    except sqlite3.Error as e:
        print(f"写入数据库失败：{e}", file=sys.stderr)
        return 1
    finally:
        conn.close()

    print(f"✅ 公告已发布：id={new_id} 标题=《{title}》 时间={created_at}")
    print("用户下次登录时会看到这条公告（仅未读用户，历史公告不会补弹）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
