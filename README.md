# MeiDay

**为什么又做了一个任务日记管理工具？**

大多数任务管理软件要么提醒不稳定，要么没有 Web/APP 端，要么不支持买断自搭建。
所以，我做了 MeiDay，并将其完全开源，支持自搭建。
它和市面上的产品不太一样。现在的软件功能太多，反而成了负担。

MeiDay 专注于“当下”——只做好两件事：**稳定的任务提醒，和安全的日记记录**。
不堆砌功能，只追求最纯粹的流畅体验。


**web端体验地址:** https://task.congsec.cn（体验账号：congsec/12345678,请不要修改密码等密钥,每小时清空测试数据）

测试配置(每小时清空一次数据):
OSS AccessKey:qpKs9nm0kUTBB1jcHWa2
OSS SecretKey:ywyuyxdmvQNQbV0pccoNHrsHVm1Ubs6pJzCEyCqD
OSS Bucket名称:meiday
OSS Endpoint:datatest.congsec.cn

![数据同步架构图优化-3b9ec276-8bc2-4175-81df-95bcf3743820](https://assets.b3logfile.com/siyuan/1714493573033/assets/数据同步架构图优化-3b9ec276-8bc2-4175-81df-95bcf3743820-20260828225217-zo7jyz5.jpg)

[部分效果展示视频](https://b3logfile.com/file/2026/08/123-JKKiRDa.mp4)

## 功能特点

### 前后端分离/数据隔离

任务数据不进服务器；后端即使被攻破也只能看到密文和哈希；OSS 对象按 `users/<username>/` 隔离，删除先进回收站，不自动清理。

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260829024746-zi5zb1e.png)

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260828223023-xt3mg3c.png)

### 多端在线秒级同步

web端(https://task.congsec.cn)，APP端(下载地址:[https://github.com/CongSec/MeiDay/releases/download/V0.1.0/MeiDayV0.1.0.apk](https://github.com/CongSec/MeiDay/releases/download/V0.1.0/MeiDayV0.1.0.apk))，思源插件端均是线上OSS数据,无本地数据,秒级同步

‍

### 隐私日记系统

日记数据均加密存放于OSS中,服务器不存储任何数据和账号密码,支持导入导出加密备份,支持删除日记减少OSS成本开销

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260828223458-r3qblml.png)

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260828223506-5jiqbjg.png)

### 动态加载机制

优先本地缓存和 304 条件请求；今日页分批并发，回收站按需加载；刷新时合并冲突

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260829024758-gjsxqi6.png)

### 微信邮箱提醒

任务提醒支持微信邮箱后台提醒,黑客登录,查看密钥,修改配置,爆破密码都会记录到日志中并通过微信/邮件通知用户赶快采取行动

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825234846-wfw4afb.png)

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260823015710-9mkeu8w.png)

### 批量导入任务

支持批量导入任务

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260828223209-7u7yxag.png)

### 重复/提醒任务提醒

支持微信邮箱重复提醒,比如说每天固定上班打卡提醒

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260828223223-oufrbdi.png)

### 项目/任务回收站

所有任务均放进回收站并且查看时候动态加载回收站项目及其任务

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260828223237-25odds4.png)

### 详细的操作日志

用户的各种行为,例如显示密钥,登录日志,操作详细日志都有记载

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260828223303-c9jzlkj.png)

### 数据迁移功能

1. 整个系统数据均存在oss中,可以整个打包迁移
2. 也可以分类迁移,隐私日记系统和回收站均支持导入导出,减少oss的消耗

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260828222815-q3zqnh2.png)

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260828222817-50vouem.png)

## 使用方法

### 配置阿里云存储桶

开通OSS

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825025624-slvn5uo.png)

将鼠标移至产品，找到并单击对象存储OSS，打开OSS产品详情页面。在OSS产品详情页中的单击立即开通。

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825025636-mmfpdje.png)

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825025701-r8coxg6.png)

点击购买,然后直接支付(不需要钱)

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825025710-slrma8t.png)

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825025754-jj2i4ew.png)

按照以下指示创建bucket并进入bucket中,请记住将bucket和Endpoint,于是我们得到了

```python
OSS Bucket: congsec2
OSS Endpoint: oss-cn-beijing.aliyuncs.com
```

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825032031-r49rr6v.png)

头像处点击accesskey,然后选择"使用RAM 用户AccessKey"

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825031746-t81w5i9.png)

点击用户,创建用户,然后完成短信验证

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825031938-mitdz5i.png)

将AccessKey ID和AccessKey Secret复制出来,于是我们得到了

```python
AccessKey ID:LTAI5t7UAgZjp3Yr7W19TvDN
AccessKey Secret:1tVfbvxGYDGrP9iPjkvRqiGZJiJyCo
```

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825032409-5o59u64.png)

给用户配置OSS权限

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825032538-sgpa9lq.png)

回到OSS存储桶界面中,给在存储桶中赋予用户权限

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825032648-ws40kp4.png)

设置存储桶的跨域,框框内分别填写`https://task.congsec.cn,https://localhost`​,`*`​,`Etag`这三个字段,再者记得勾选请求方式(也就是图中第四步)

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260828073139-2ugq2xr.png)

综上,我们得到了以下配置

```python
AccessKey ID:LTAI5t7UAgZjp3Yr7W19TvDN
AccessKey Secret:1tVfbvxGYDGrP9iPjkvRqiGZJiJyCo
bucket: congsec2
Endpoint: oss-cn-beijing
```

### 配置微信邮箱通知

打开你的qq邮箱(建议创建一个新号,以免被其他邮件打扰),进去之后找到设置

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825033337-j816xyd.png)

点击账号与安全

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825033415-omo50fr.png)

找SMTP服务,开启他,并生成授权码,你就会得到SMTP 授权码:xxxxx

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825033507-pw2l7eu.png)

接下来设置微信提醒,在微信设置中直接搜索邮箱,然后进行绑定即可(PS：如果觉得重复提醒,可以把邮箱退出登录,只微信提醒也可以的哦)

![9fc594bf86e133d22f53452fb08ed224](https://assets.b3logfile.com/siyuan/1714493573033/assets/9fc594bf86e133d22f53452fb08ed224-20260825234948-lq9qad3.jpg)

效果如下

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825234846-wfw4afb.png)

### EasyTask注册账号

在这里注册你的账号,注册完成后自动进入

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825033620-hzr2rp1.png)

依次输入刚才的得到的密钥即可,

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825033904-nsa2fyw.png)

然后点击加密保存,没抱错说明成功啦!!!

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825033950-kcvun47.png)

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

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825075856-wju0c4x.png)

创建完存储桶之后,创建一个cdn域名与存储桶进行绑定,这里就以test为例

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825075037-xeyekbr.png)

绑定存储桶,然后点击下一步,域名解析验证身份即可

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825075049-izfqr13.png)

#### 构建前端产物

在frontend文件夹中新建文件,`vi .env.web`,填入如下

```python
VITE_API_BASE_URL=
#下面填你自己的前端cdn加速的oss
VITE_CDN_BASE=https://static.congsec.cn
```

然后使用`npm run build:web`命令构建前端产物

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825074040-s1glnfw.png)

将assert文件夹以及logo.png上传至存储桶中

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825074328-e2u7nnl.png)

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825074322-gcshks6.png)

#### 验证

`cat frontend/index.html`,存在cdn域名则说明构建成功

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260825074444-n6d8agu.png)

访问对应的js,能访问成功则说明上传加速成功,然后你就可以访问你的网站来尝试

如果网站界面返回空白的话,可能是跨域的问题,也有可能是cdn的缓存问题,所以去刷新cdn缓存,再等几分钟再次访问尝试

### APP构建教程

在frontend文件夹中创建`.env.production`文件:填入如下

```python
VITE_CDN_BASE=
VITE_API_BASE_URL=https://task.congsec.cn
```

直接运行:`npm install`​和`npm run apk:debug`

### 思源插件构建教程

将[https://github.com/CongSec/MeiDay](https://github.com/CongSec/MeiDay)这个项目clone下来,在`frontend`​文件夹中构建`npm install`​和`npm run build:plugin`,

将[https://github.com/CongSec/meiday-siyuan-plugin](https://github.com/CongSec/meiday-siyuan-plugin)项目clone下来

![image](https://assets.b3logfile.com/siyuan/1714493573033/assets/image-20260828201841-obn97ww.png)

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

## 常见问题

**Q: 必须用 HTTPS 吗？**

A: 是的。应用依赖 WebCrypto API（`crypto.subtle`），该 API 只在安全上下文（HTTPS 或 localhost）下可用。

**Q: 服务器会存储我的任务数据吗？**

A: 不会。所有任务、项目、附件都存储在你自己的阿里云 OSS 中,直接返回游览器,不经过服务器加载。服务器只存储登录会话和加密后的 OSS 凭证。

**Q: 忘记密码怎么办？**

A: 密码无法恢复。但可以自己将oss的数据导出来重新创建一个新账号重新导入

**Q: 数据怎么备份?**

A: 在阿里云存储桶OSS中设置自动备份即可

‍
