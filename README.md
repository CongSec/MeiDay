# EasyTask

一个支持任务管理、提醒、审计日志与本地部署的轻量应用。后端使用 FastAPI，前端使用 Vue 3 + Vite，Android 端通过 Capacitor 打包。

## 目录结构

- `backend/`：FastAPI 后端
- `frontend/`：Vue 3 + Vite 前端（含 Capacitor Android 工程）

## 后端启动

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\run.ps1
```

后端默认监听 `http://0.0.0.0:8000`，前端开发服务器会把 `/api` 代理到该端口。

## 前端环境变量

本地部署配置不会提交到 GitHub，`frontend/.env.example` 是唯一需要提交的模板。新环境先复制模板再填写：

```powershell
cd frontend
Copy-Item .env.example .env.production
Copy-Item .env.example .env.web
```

Vite 按构建模式读取 env 文件：`npm run build:web` 使用 `--mode web`，所以网页版配置必须命名为 `.env.web`；`.env.web.production` 这种组合不会被读取。

| 文件 | 何时读取 | 用途 |
| --- | --- | --- |
| `frontend/.env.production` | `npm run build` / `npm run apk:sync` | APK 打包时手机访问后端用的地址 |
| `frontend/.env.web` | `npm run build:web` | 网页版 API 地址与可选 CDN 域名 |

常用变量：

- `VITE_API_BASE_URL`：APK 内手机访问后端用的地址，例如 `http://192.168.1.10:8000`；网页版留空走 Nginx 同源反代。
- `VITE_CDN_BASE`：网页版构建时把 JS/CSS 等静态资源指到 CDN，例如 `https://static.example.com`；APK 打包请留空。

## 前端构建

```powershell
cd frontend
npm install
npm run build       # 生产构建（APK 打包用）
npm run build:web   # 网页版构建，支持 CDN
npm run apk:debug   # 生成调试 APK
```

## 部署与安全

- 生产环境后端已关闭 Swagger/ReDoc/OpenAPI，`/docs`、`/redoc`、`/openapi.json` 均不可访问。
- 前端生产构建关闭 sourcemap，避免源码映射泄露。
- `.env.*`、签名密钥、证书、构建产物等均已加入 `.gitignore`，不要用 `git add -f` 强制提交。

### 客户端 IP 记录（审计日志 / 安全邮件）

- 后端默认用 TCP 连接对端地址记录 IP；网页版经 Nginx 同源反代访问时，对端恒为本机回环
  127.0.0.1。为记录真实外网 IP，后端在【确认对端是受信代理】后才解析代理透传的
  `X-Forwarded-For`（取最右侧条目，防客户端伪造），否则一律使用 TCP 对端地址。
- Nginx 需透传真实 IP（本机反代默认生效）：`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
  或 `proxy_set_header X-Real-IP $remote_addr;`（任一即可，优先 X-Forwarded-For）。
- 默认信任本机回环（127.0.0.1/::1）；若反向代理部署在其它主机/网段，为后端设置环境变量
  `TRUSTED_PROXIES`（英文逗号分隔的 IP 或 CIDR），如 `TRUSTED_PROXIES=10.0.0.0/8,192.168.1.10`。

