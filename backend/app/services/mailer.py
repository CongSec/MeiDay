import html
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import aiosmtplib

SMTP_HOST = "smtp.qq.com"
SMTP_PORT = 465

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<body style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color:#dc2626;">🔔 任务提醒</h2>
  <table style="border-collapse: collapse; width: 100%;">
    <tr><td style="padding:6px 0;color:#666;width:100px;">任务名称</td><td style="padding:6px 0;font-weight:600;">{name}</td></tr>
    <tr><td style="padding:6px 0;color:#666;">描述</td><td style="padding:6px 0;white-space:pre-wrap;">{description}</td></tr>
    <tr><td style="padding:6px 0;color:#666;">开始时间</td><td style="padding:6px 0;">{start_time}</td></tr>
    <tr><td style="padding:6px 0;color:#666;">截止时间</td><td style="padding:6px 0;">{end_time}</td></tr>
    <tr><td style="padding:6px 0;color:#666;">提醒时间</td><td style="padding:6px 0;color:#dc2626;font-weight:600;">{reminder_time}</td></tr>
  </table>
  <p style="color:#999;font-size:12px;margin-top:24px;">本邮件由 MeiDay 自动发送，请勿回复。</p>
</body>
</html>"""


def _esc(value: str) -> str:
    return html.escape(value or "", quote=True)


def _subject(task: dict) -> str:
    name = " ".join((task["name"] or "").splitlines()).strip()
    return f"【MeiDay 提醒】{name}"


def _html(task: dict) -> str:
    return HTML_TEMPLATE.format(
        name=_esc(task["name"]),
        description=_esc(task.get("description") or ""),
        start_time=_esc(task.get("start_time") or "-"),
        end_time=_esc(task.get("end_time") or "-"),
        reminder_time=_esc(task["reminder_time"]),
    )


async def send_reminder_email(smtp_user: str, smtp_pass: str, to: str, task: dict) -> None:
    msg = EmailMessage()
    msg["From"] = smtp_user
    msg["To"] = to
    msg["Subject"] = _subject(task)
    msg.set_content(
        f"任务：{task['name']}\n描述：{task.get('description') or ''}\n"
        f"起止：{task.get('start_time') or '-'} ~ {task.get('end_time') or '-'}\n"
        f"提醒时间：{task['reminder_time']}"
    )
    msg.add_alternative(_html(task), subtype="html")
    await aiosmtplib.send(
        msg,
        hostname=SMTP_HOST,
        port=SMTP_PORT,
        use_tls=True,
        username=smtp_user,
        password=smtp_pass,
        timeout=30,
    )

# ---- 安全通知邮件（登录 / 密钥 / 隐私日记相关） ----
# 文案与主题按类型区分；仅含 IP 与时间，绝不包含任何密钥/凭证明文。
# cred_change 为“临终邮件”：在加密保存动作发生前用【修改前】的 SMTP 配置发送，
# 提示可能有攻击者正在修改你的密钥配置，防止 SMTP 被改掉后通知失去意义。
SECURITY_SUBJECTS = {
    "login_success": "【MeiDay 安全通知】登录成功",
    "login_failed": "【MeiDay 安全通知】登录失败",
    "key_view": "【MeiDay 安全通知】查看密钥",
    "cred_change": "【MeiDay 安全通知】密钥配置被修改",
    "diary_unlock_success": "【MeiDay 安全通知】隐私日记已解锁",
    "diary_unlock_failed": "【MeiDay 安全通知】隐私日记密码输入失败",
    "diary_password_change": "【MeiDay 安全通知】隐私日记密码被修改",
    "diary_export": "【MeiDay 安全通知】隐私日记被导出",
    "diary_import": "【MeiDay 安全通知】隐私日记被导入",
    "diary_delete": "【MeiDay 安全通知】隐私日记被删除",
}

SECURITY_BODIES = {
    "login_success": "[{ip}] 登录了你的账号",
    "login_failed": "[{ip}] 尝试爆破你的账号，请注意修改密码",
    "key_view": "[{ip}] 尝试查看你的设置密钥",
    "cred_change": "[{ip}] 正在修改你的账号的密钥配置",
    "diary_unlock_success": "[{ip}] 解锁了你的隐私日记",
    "diary_unlock_failed": "[{ip}] 尝试输入你的隐私日记密码失败",
    "diary_password_change": "[{ip}] 修改了你的隐私日记密码",
    "diary_export": "[{ip}] 导出了你的隐私日记",
    "diary_import": "[{ip}] 导入了你的隐私日记",
    "diary_delete": "[{ip}] 删除了你的隐私日记",
}

SECURITY_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<body style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color:#dc2626;">🔔 MeiDay 安全通知</h2>
  <p style="font-size:15px;color:#1f2937;line-height:1.7;">{body}</p>
  <table style="border-collapse: collapse; width: 100%; margin-top: 12px;">
    <tr><td style="padding:6px 0;color:#666;width:100px;">时间</td><td style="padding:6px 0;font-weight:600;">{time}</td></tr>
    <tr><td style="padding:6px 0;color:#666;">IP 地址</td><td style="padding:6px 0;font-weight:600;font-family:monospace;">{ip}</td></tr>
  </table>
  <p style="color:#999;font-size:12px;margin-top:24px;">如非本人操作，请及时修改密码保护账号。本邮件由 MeiDay 自动发送，请勿回复。</p>
</body>
</html>"""


async def send_security_email(
    smtp_user: str,
    smtp_pass: str,
    to: str,
    kind: str,
    ip: str,
    ua: str = "",
) -> None:
    """发送安全通知邮件（登录成功 / 登录失败 / 查看密钥 / 密钥配置变更）。

    文案仅含 IP 与事件时间，绝不包含密钥/凭证等明文。发送失败由调用方记录。
    """
    subject = SECURITY_SUBJECTS.get(kind, "【MeiDay 安全通知】")
    body = SECURITY_BODIES.get(kind, "[{ip}] 触发安全事件").format(ip=ip or "未知IP")
    now = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds").replace("T", " ")

    msg = EmailMessage()
    msg["From"] = smtp_user
    msg["To"] = to
    msg["Subject"] = subject
    text = (
        f"{body}\n\n时间：{now}\nIP：{ip or '未知IP'}"
        + (f"\nUser-Agent：{ua[:200]}" if ua else "")
        + "\n\n如非本人操作，请及时修改密码保护账号。"
    )
    msg.set_content(text)
    msg.add_alternative(
        SECURITY_TEMPLATE.format(body=_esc(body), time=_esc(now), ip=_esc(ip or "未知IP")),
        subtype="html",
    )
    await aiosmtplib.send(
        msg,
        hostname=SMTP_HOST,
        port=SMTP_PORT,
        use_tls=True,
        username=smtp_user,
        password=smtp_pass,
        timeout=30,
    )
