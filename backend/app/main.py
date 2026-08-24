import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .audit import action_label, client_ip, log_action
from .auth import username_from_token
from .db import init_db
from .routes import auth as auth_routes
from .routes import captcha as captcha_routes
from .routes import credentials as cred_routes
from .routes import logs as logs_routes
from .routes import notify as notify_routes
from .routes import sync as sync_routes
from .services.log_cleanup_worker import log_cleanup_worker
from .services.reminder_worker import reminder_worker

# 默认允许本机前后端联调及 Capacitor Android WebView（https://localhost）；
# 可通过环境变量 FRONTEND_ORIGINS 配置局域网访问地址
# （多个用英文逗号分隔），满足 README 声称的局域网设备访问（BUG-25）
_DEFAULT_ORIGINS = "http://localhost:5173,https://localhost:5173,http://localhost,https://localhost"
FRONTEND_ORIGINS = [
    o.strip()
    for o in os.environ.get("FRONTEND_ORIGINS", _DEFAULT_ORIGINS).split(",")
    if o.strip()
]

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
# 同时滚动落盘到 backend/logs/app.log，方便直接查看服务器日志
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
LOG_DIR.mkdir(exist_ok=True)
_file_handler = RotatingFileHandler(
    LOG_DIR / "app.log", maxBytes=2 * 1024 * 1024, backupCount=5, encoding="utf-8"
)
_file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
logging.getLogger().addHandler(_file_handler)

# 这些路径由路由自行写日志（以便带上更细的信息），中间件跳过避免重复
_SKIP_PATHS = {
    "/api/login",
    # 旧账号一次性迁移登录：路由自行写审计日志，中间件跳过避免重复
    "/api/login/legacy",
    # 注册由 register 路由以新用户名写入（归属该用户自己），中间件跳过避免空用户重复记录
    "/api/register",
    "/api/health",
    # 图形验证码图片（注册页每次刷新/点击都请求，跳过审计日志避免刷屏）
    "/api/captcha",
    # 修改密码：由路由自行写入安全审计日志（修改密码/修改密码失败），中间件跳过避免重复
    "/api/change-password",
    # 客户端行为上报：由 /logs/client 路由写入带详情的审计日志
    "/api/logs/client",
    # 手动清理与保留设置：由对应路由/文件日志留痕，避免再记一条冗余请求
    "/api/logs/all",
    "/api/logs/actions",
    "/api/settings/log-retention",
    # 同步协调中心（2 秒轮询）：每次请求都写审计日志会刷爆 LogsView，直接跳过
    "/api/sync/report",
    "/api/sync/state",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    worker = asyncio.create_task(reminder_worker())
    cleanup = asyncio.create_task(log_cleanup_worker())
    yield
    cleanup.cancel()
    worker.cancel()


# 生产环境关闭 Swagger/ReDoc 与 OpenAPI schema，避免暴露接口调试页面
app = FastAPI(
    title="EasyTask",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _is_sourcemap_path(path: str) -> bool:
    """是否请求 sourcemap（构建侧已禁用并清理，这里兜底拦截，防止未来误配静态托管泄露源码）。"""
    return path.rstrip("/").lower().endswith(".map")


@app.middleware("http")
async def audit_middleware(request: Request, call_next):
    """记录用户每一次请求：时间、IP、用户、行为、方法/路径、状态码、耗时。"""
    method = request.method
    path = request.url.path
    if _is_sourcemap_path(path):
        return JSONResponse({"detail": "Forbidden"}, status_code=403)
    if method == "OPTIONS" or path in _SKIP_PATHS:
        return await call_next(request)
    start = time.perf_counter()
    auth_header = request.headers.get("authorization")
    username = ""
    if auth_header and auth_header.startswith("Bearer "):
        username = username_from_token(auth_header[len("Bearer "):].strip()) or ""
    ip = client_ip(request)
    ua = request.headers.get("user-agent", "")
    try:
        response = await call_next(request)
    except Exception:
        log_action(
            action_label(method, path), username=username or None, method=method, path=path,
            status=500, ip=ip, user_agent=ua, detail="服务端异常",
            duration_ms=int((time.perf_counter() - start) * 1000),
        )
        raise
    duration_ms = int((time.perf_counter() - start) * 1000)
    log_action(
        action_label(method, path), username=username or None, method=method, path=path,
        status=response.status_code, ip=ip, user_agent=ua, duration_ms=duration_ms,
    )
    return response


app.include_router(auth_routes.router)
app.include_router(captcha_routes.router)
app.include_router(cred_routes.router)
app.include_router(logs_routes.router)
app.include_router(notify_routes.router)
app.include_router(sync_routes.router)


@app.get("/api/health")
def health():
    return {"ok": True}
