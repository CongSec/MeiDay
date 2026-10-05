# ============================================================
# MeiDay 后端镜像（仅 FastAPI 后端；前端由 OSS/CDN 托管，不在镜像内）
# 本地开发环境为 Python 3.12，基础镜像保持一致
# 构建上下文：backend/（docker build -t meiday . 需在此目录执行）
# ============================================================
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # 数据目录：SQLite dev.db + logs/，运行时挂载卷持久化（见 docker-compose.yml）
    MEIDAY_DATA_DIR=/data

WORKDIR /app/backend

# 先只拷贝依赖清单并安装，充分利用 Docker 构建缓存
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 拷贝后端代码
COPY app ./app

# 数据目录与代码目录交给运行用户（uid 10001）
RUN mkdir -p /data \
    && chown -R 10001:10001 /data /app

# 以非 root 用户运行，降低容器被攻破后的影响面
USER 10001

EXPOSE 8000

# 健康检查：探测 /api/health（slim 镜像无 curl，用 python urllib）
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers"]
