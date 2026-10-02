![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20261002173954-hukfm5q.png)

## 前言

**为什么又做一个任务日记工具？**

因为目前任务管理软件，要么提醒渠道不顺手，要么不支持买断/自搭建，要么数据不在自己手里  
所以，我做了 MeiDay，并将其开源、可自搭建，并补上 GitHub/Gitee、文档、部署教程  
它和市面上的产品不太一样。现在的软件功能太多，反而成了负担。

MeiDay 专注于“当下”——只做好一件事：**稳定流畅安全的任务日记记录**。

不堆砌功能，只追求最纯粹的流畅体验。

> **web端体验地址:**  https://task.congsec.cn
>
> **体验测试账号(只读):**  congsec/1234578  
> **压力测试账号(只读):**  test/12345678
>
> OSS AccessKey:LTAI5t88s2Wq3vrhS71vKru2  
> OSS SecretKey:JfkgheFQRRN7InfV4wR0rZY3NqdLIy  
> OSS Bucket名称:congsec2  
> OSS Endpoint:oss-cn-shenzhen.aliyuncs.com

## 功能特点

### 时间胶囊

完成任务自动封存进「时间胶囊」，像翻开日历一样回看每一天的成果。支持**日历视图**（完成/未完成任务按天归属、跨天任务横条可视化）、**年度热力图**和**工作量趋势图**，让成长轨迹一目了然；重复任务自动枚举所有发生日，回顾不遗漏。

![PixPin_2026-10-02_15-54-38](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/PixPin_2026-10-02_15-54-38-20261002171405-rb81p01.gif)

### 数据安全与性能安全

任务和日记加密后直接存入你自己的 OSS，服务端不存储任何数据；**前端**在存储桶中,攻击者无任何修改途径,断绝js被篡改修改密码的可能性,**后端**即使被攻破也只能看到密文和哈希,账号密码不上传至服务器,无法解密；OSS 对象按 `users/<username>/` 隔离，删除先进时间胶囊，不自动清理。

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20260829024746-zi5zb1e.png)

**大数据量优化：十年数据也不卡**

优先本地缓存和 304 条件请求；今日页分批并发，时间胶囊按需加载；刷新时合并冲突

性能压力测试(test/12345678),模拟十年数据,每天150个任务,仍可流畅使用

![recording](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/recording-20260917221055-9cl9zh6.gif)

### 任务添加与修改

极简流畅的添加/编辑体验，支持批量导入任务、任务拖拽排序、项目分组管理，重复任务和提醒时间随手设置，指定日期到点重复自动微信提醒、支持拖拽或粘贴添加附件

![PixPin_2026-10-02_14-38-45](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/PixPin_2026-10-02_14-38-45-20261002144006-u36ynpm.gif)

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20260828223209-7u7yxag.png)

### 多端实时同步

Web 端(https://task.congsec.cn)、Android App、思源笔记插件、Windows 桌面小组件共用同一份云端数据，**无本地数据、秒级同步**，任何一端改动，其他端即刻更新。

<video controls="controls" src="https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/bandicam_2026-10-02_15-23-55-198-20261002152929-ocgcdov.mp4"></video>

**思源笔记插件端**

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20261002153104-tpborni.png)

**windows桌面端**

Windows 桌面可置顶显示今日未完成任务，截图或视频会议时自动隐藏防泄露；支持鼠标穿透、透明度调节，不遮挡屏幕内容。

![6fd63525b500b537f41ec96321e58cf7](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/6fd63525b500b537f41ec96321e58cf7-20261002153012-l9bepb2.jpg)

**APP端**

支持app端和通知栏显示今日任务,支持小组件

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20261002145208-d7etu03.png)

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20261002153206-5r8r5l4.png)

**网页端**

支持网页端登录显示,方便在游览器中随时查看

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20261002153222-erulnmb.png)

### 隐私日记系统

日记数据**加密存放**于你的 OSS 中，服务器不存任何数据与账号密码；支持加密备份导入导出，可单独删除日记节省存储成本。

![PixPin_2026-10-02_17-24-28](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/PixPin_2026-10-02_17-24-28-20261002172506-xjukbo6.gif)

### 微信/邮箱提醒

任务提醒支持微信邮箱后台提醒，打卡不漏。账号有异常——异地登录、密钥被翻、配置被改、密码被爆破——秒级微信/邮件告警。

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20260825234846-wfw4afb.png)

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20260823015710-9mkeu8w.png)

### 详细的操作日志

显示密钥、登录记录、每一项增删改操作全部留痕，关键操作有据可查，任何风吹草动尽在掌握。

![PixPin_2026-10-01_23-23-02](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/PixPin_2026-10-01_23-23-02-20261001232330-fisegvg.gif)

### 数据迁移备份功能

全部数据都在 OSS，可**整体打包迁移**换环境；隐私日记与时间胶囊支持**分类导入导出**，灵活备份、按需迁移，配合 OSS 自动备份，数据永不丢失。

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20260828222815-q3zqnh2.png)

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20260828222817-50vouem.png)

## 自搭建教程

### 前置要求

- Node.js 20+
- Python 3.10+
- 阿里云 OSS 账号和 AccessKey
- QQ 邮箱或其他 SMTP 服务

### 后端

windows

```python
cd backend
# 创建虚拟环境
python -m venv .venv
# 激活虚拟环境
.venv\Scripts\activate
# 安装依赖
pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-proxy-headers
```

Linux:

```python
cd backend
# 创建虚拟环境
python3 -m venv .venv
# 激活虚拟环境
source .venv/bin/activate
# 安装依赖
pip install -r requirements.txt
# 后台运行
nohup .venv/bin/python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-proxy-headers > backend.log 2>&1 &
```

### 前端

```bash
cd frontend

# 安装依赖
npm install
# 启动前端,如果使用web端的话,请使用npm run build:web
npm run dev
```

### CDN搭建教程

#### cdn与存储桶绑定

存储桶创建请参考上述教程(存储桶记得设置为公开,跨域设置记得设置为你的访问域名,**其他跨域字段和上述一致**)

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260825075856-wju0c4x.png)

创建完存储桶之后,创建一个cdn域名与存储桶进行绑定,这里就以test为例

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260825075037-xeyekbr.png)

绑定存储桶,然后点击下一步,域名解析验证身份即可

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260825075049-izfqr13.png)

#### 构建前端产物

在frontend文件夹中新建文件,`vi .env.web`,填入如下

```python
VITE_API_BASE_URL=
#下面填你自己的前端cdn加速的oss
VITE_CDN_BASE=https://static.congsec.cn
```

然后使用`npm run build:web`命令构建前端产物

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260825074040-s1glnfw.png)

将assert文件夹以及logo.png上传至存储桶中

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260825074328-e2u7nnl.png)

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260825074322-gcshks6.png)

#### 验证

`cat frontend/index.html`,存在cdn域名则说明构建成功

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260825074444-n6d8agu.png)

访问对应的js,能访问成功则说明上传加速成功,然后你就可以访问你的网站来尝试

如果网站界面返回空白的话,可能是跨域的问题,也有可能是cdn的缓存问题,所以去刷新cdn缓存,再等几分钟再次访问尝试

### APP构建教程

在frontend文件夹中创建`.env.production`文件:填入如下

```python
VITE_CDN_BASE=
VITE_API_BASE_URL=https://task.congsec.cn
```

直接运行:`npm install`​和`npm run apk:debug`

成功后就会在 frontend\android\app\build\outputs\apk\debug 输出apk文件

### 桌面组件构建教程

直接一键运行`python `

### 思源插件构建教程

将[https://github.com/CongSec/MeiDay](https://github.com/CongSec/MeiDay)这个项目clone下来,在`frontend`​文件夹中构建`npm install`​和`npm run build:plugin`

将[https://github.com/CongSec/meiday-siyuan-plugin](https://github.com/CongSec/meiday-siyuan-plugin)项目clone下来

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260828201841-obn97ww.png)

然后将以下内容构建并复制到对应文件中

```python
# ① 第一步的产物拷进外壳
Copy-Item ".\frontend\dist-plugin\index.html" `
          ".\meiday-siyuan-plugin\src\assets\app.html" -Force

# ② 构建外壳(插件文件夹)
cd .\meiday-siyuan-plugin
npm install
npm run build

# ③ 复制进思源笔记插件的文件夹中
Copy-Item ".\meiday-siyuan-plugin\dist\*" `
          "D:\desktop\congsectest\data\plugins\meiday-siyuan-plugin\" -Recurse -Force

# ④ 完全退出思源再打开 ← 必须重启，思源不热加载
```
