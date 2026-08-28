# 从零构建思源插件：以 MeiDay（EasyTask）为例

> 本文档回答一个核心问题：**如果把 `EasyTask`（MeiDay）这套代码原样 clone 到一台干净机器上，我该怎么把它变成一个思源笔记插件？**
> 以及更本质的问题：**思源插件到底是怎么做出来的？**
>
> 读完并跟着做一遍，你以后不用再求任何人，自己就能把任何 Web 前端塞进思源。

---

## 0. 先想清楚：你手里的东西长什么样

| 仓库 | 角色 |
|---|---|
| `EasyTask`（本仓库） | 主项目：`frontend/`（Vue 前端）+ `backend/`（FastAPI 后端） |
| `meiday-siyuan-plugin`（**兄弟目录** `D:\desktop\5555\meiday-siyuan-plugin`） | 思源插件外壳：把 MeiDay 前端“包”进思源 |

最终插件的运行链路是：

```
右侧边栏图标 (addDock，停靠在 RightTop)
   │  点击展开
   ▼
侧边栏停靠面板（宽 DOCK_WIDTH，默认 420px）
   │
   ▼
iframe(src=blob:...)
   │  blob URL 指向“单文件打包”出来的 app.html
   ▼
MeiDay Vue 前端（一个自包含 HTML，JS/CSS 全内联）
   │
   ▼
axios → https://task.congsec.cn （远端 FastAPI 后端）
```

一句话概括：**前端用 Vite 打成“单个 HTML”，插件外壳用 iframe 把这个 HTML 装进思源侧边栏**，两者是解耦的。

---

## 1. 前置准备（一次性）

1. **Node.js**（建议 LTS 20+）。命令行里能跑 `node -v`、`npm -v`。
2. **思源笔记桌面版**，并准备好一个**测试工作区**（本文用 `D:\desktop\congsectest`）。
3. 一个能访问到的**后端**（MeiDay 默认 `https://task.congsec.cn`）。
4. **Git**，以及 GitHub 账号（用于 clone 自己的仓库）。

---

## 2. 一键构建：最快路径（30 秒）

前提：你已经有这两个仓库（clone 到同一级目录）：

```powershell
# 克隆主项目
git clone https://github.com/CongSec/EasyTask.git
# 克隆插件外壳（与 EasyTask 平级）
git clone <你的 meiday-siyuan-plugin 仓库地址>
```

**第 1 步：补上被 gitignore 的配置文件**

`frontend/.env.production` 因为含服务器地址，被 `.gitignore` 忽略了，clone 后**不存在**。手动创建它：

```powershell
# 在 frontend 目录下新建 .env.production，内容：
VITE_API_BASE_URL=https://task.congsec.cn
VITE_CDN_BASE=
```

> 如果后端是你自己部署的，就把地址换成你自己的，例如 `http://localhost:8000`。

**第 2 步：跑一键构建脚本**

```powershell
cd D:\desktop\5555\EasyTask
powershell -ExecutionPolicy Bypass -File .\build-plugin.ps1
```

脚本会按顺序完成 4 件事（详见 §4）：

1. Vite 把前端打成单个 `frontend/dist-plugin/index.html`
2. 复制为插件仓库的 `src/assets/app.html`
3. webpack 把插件外壳打成 `dist/`（含 `index.js`、`index.css`、`plugin.json`、`icon.png` 等）
4. 把 `dist/` 复制到思源工作区 `data/plugins/meiday-siyuan-plugin/`

**第 3 步：完全重启思源**

思源**只在启动时读取插件文件，不支持热加载**，所以必须：`文件 → 退出思源` 完全关掉，再重新打开。

重启后，思源**右侧边栏**出现一个“任务清单”图标，点击展开 MeiDay 面板 = 成功。

---

## 3. 失败排查（按出现频率排序）

| 现象 | 原因与解决 |
|---|---|
| 侧栏没有图标 / 图标是空的 | `addIcons` 必须传**裸 `<symbol>`**，不能在外面包 `<svg>`（见 §6 坑 2） |
| 侧栏面板里一片空白 | 多半是 `app.html` 没内联成功 / blob URL 里用了 `new URL('/logo.png')` 之类的相对资源，必须全部内联（见 §6 坑 3） |
| 前端能开但接口报跨域 | 后端 CORS 需允许回环任意端口：`allow_origin_regex=^https?://(127\.0\.0\.1\|localhost)(:\d+)?$`（见 `backend/app/main.py`） |
| 改了插件代码重启也没变化 | 确认真的**完全退出**了思源，不是点关闭窗口（那是最小化到托盘） |
| 面板太窄/太宽 | 见 §5“如何调整侧边栏面板” |

---

## 4. 不跑脚本的话，每一步手动是什么？（理解原理）

`build-plugin.ps1` 只是把下面 4 步串起来。你完全可以在命令行手动执行：

```powershell
# ① 前端 → 单文件 HTML
cd D:\desktop\5555\EasyTask\frontend
npm run build:plugin
#    产物：frontend\dist-plugin\index.html（自包含，约 0.5~1 MB）

# ② 塞进插件外壳
Copy-Item .\dist-plugin\index.html ..\..\meiday-siyuan-plugin\src\assets\app.html -Force

# ③ 构建思源插件（webpack）
cd D:\desktop\5555\meiday-siyuan-plugin
npm install          # 首次
npm run build
#    产物：dist\index.js + dist\index.css + plugin.json + icon.png ...

# ④ 安装到思源工作区
# 把 meiday-siyuan-plugin\dist\ 里的所有文件，复制到
# D:\desktop\congsectest\data\plugins\meiday-siyuan-plugin\
```

> 也可以用另一种安装方式：把 `meiday-siyuan-plugin` 里的 `package.zip`（webpack 已自动生成）通过
> 思源「设置 → 集市/市场 → 导入插件」的方式安装，效果一样。

---

## 5. 如何调整侧边栏面板（大小 / 位置）

打开 `D:\desktop\5555\meiday-siyuan-plugin\src\index.ts`，文件**最顶部**有三个常量：

```ts
const DOCK_POSITION = "RightTop";   // 停靠位置
const DOCK_WIDTH    = 420;          // 面板宽度(px)
const DOCK_SHOW     = false;        // true=启动即展开，false=点图标才展开
```

- `DOCK_POSITION`：可选 `"RightTop"`（右上侧栏，默认）、`"RightBottom"`（右下）、`"LeftTop"`（左上）、`"LeftBottom"`（左下）、`"BottomLeft"` / `"BottomRight"`（底部）
- `DOCK_WIDTH`：面板宽度（像素）。想更宽就调大，比如 `560`。
- `DOCK_SHOW`：`true` = 每次启动思源自动展开面板；`false` = 需要手动点右侧栏的图标。

**注意思源的限制**：右侧边栏总宽度有限，面板太宽会被自动压窄，属正常行为。

改完保存，重新执行 §2 的第 2、3 步（`build-plugin.ps1` + 完全重启思源）即可生效。
如果想改默认打开的后端地址，改 `frontend/.env.production` 里的 `VITE_API_BASE_URL` 后重新构建即可。

> 想改回「顶部图标 + 弹出窗口」的老方式？`src/index.ts` 里注释保留了一份 `openDialog()`（Dialog 版），
> 把注释解开、并把 `onLayoutReady()` 换成 `addTopBar(...)` 即可（文件内注释有完整示例）。

---

## 6. 从空文件夹自己搭一个插件外壳（彻底搞懂）

上面是“复制粘贴现有外壳”，下面告诉你**这个外壳到底是怎么来的**。以后你想做别的插件，照这个做即可。

### 6.1 思源插件 = 一个文件夹

思源插件本质上就是一个目录，里面有：

```
my-plugin/
├── plugin.json          # 插件元信息（名字、作者、图标、入口等）
├── icon.png             # 图标
├── preview.png          # 预览图
├── dist/
│   ├── index.js         # 打包后的入口（CommonJS，导出 Plugin 子类）
│   ├── index.css        # 打包后的样式
│   ├── plugin.json      # 复制过来的元信息
│   └── i18n/            # 多语言
└── src/
    ├── index.ts         # 插件源码（extends Plugin）
    ├── index.css
    └── ...
```

把整个 `my-plugin` 目录放进 `工作区/data/plugins/`，重启思源即可被加载。

### 6.2 需要两个基础文件

**`plugin.json`**（思源靠它识别插件）：

```json
{
  "name": "meiday-siyuan-plugin",
  "author": "congsec",
  "version": "0.1.0",
  "minAppVersion": "3.0.0",
  "backends": ["all"],
  "frontends": ["all"],
  "displayName": { "default": "MeiDay", "zh-CN": "MeiDay（任务管理）" }
}
```

**`src/index.ts`**（核心逻辑，本项目全文就一个文件，很短；下面是“侧边栏版”的精简示意）：

```ts
import {Plugin} from "siyuan";
import "./index.css";
import appHtml from "./assets/app.html";   // 单文件前端，由 webpack 以字符串内联

export default class MeiDayPlugin extends Plugin {
    private objectUrl: string | null = null;

    private ensureObjectUrl(): string {   // 把内联 HTML 包成 blob URL（只建一次）
        if (!this.objectUrl) {
            const blob = new Blob([appHtml], {type: "text/html;charset=utf-8"});
            this.objectUrl = URL.createObjectURL(blob);
        }
        return this.objectUrl;
    }

    async onload() {
        // ① 注册一个自定义图标（必须是裸 <symbol>，不能包 <svg>）
        this.addIcons(`<symbol id="iconMeiDay" viewBox="0 0 24 24">…</symbol>`);
    }
    async onLayoutReady() {
        // ② 把面板注册到右侧边栏（addDock）
        const objectUrl = this.ensureObjectUrl();
        this.addDock({
            config: {
                position: "RightTop",
                size: {width: 420, height: 0},
                icon: "iconMeiDay",
                title: "MeiDay",
                show: false,
                index: 1,
            },
            data: {},
            type: "meiday",
            init() {   // 每次面板展开都会执行，this.element 就是面板容器
                this.element.classList.add("meiday__wrap");
                this.element.innerHTML = `<iframe class="meiday__iframe" src="${objectUrl}"></iframe>`;
            },
            destroy() {},
        });
    }
    async onunload() {
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
    }
}
```

`addDock` 的 `config.position` 可选：`"LeftTop" | "LeftBottom" | "RightTop" | "RightBottom" | "BottomLeft" | "BottomRight"`。
`init` 里 `this` 是思源的 `Custom` 实例，`this.element` 即侧边栏面板容器——你想塞什么 HTML 都行。

### 6.3 打包配置（webpack）

`webpack.config.js` 要点（完整文件见插件仓库）：

- `externals: { siyuan: "siyuan" }` —— `siyuan` 模块由思源在运行时注入，不打包
- `output.libraryTarget: "commonjs2"` —— 思源用 CommonJS 加载插件入口
- `.html` 文件用 `type: "asset/source"` 直接内联成字符串（这样 app.html 才能进 blob）
- `CopyPlugin` 把 `plugin.json / icon.png / preview.png / i18n` 拷进 `dist/`
- `ZipPlugin` 额外生成一个 `package.zip` 供思源市场/导入安装

`package.json` 里只要一个依赖：`"siyuan"`（类型声明），其余都是构建工具。

### 6.4 最小可行流程总结

```
1. npm init + npm i -D typescript webpack webpack-cli esbuild-loader siyuan ...
2. 写好 plugin.json、src/index.ts、src/index.css、webpack.config.js
3. npm run build  → 得到 dist/
4. 整个目录丢进 工作区/data/plugins/你的插件名/
5. 重启思源
```

---

## 7. 本方案踩过的 3 个坑（务必记住）

1. **`addIcons` 传裸 `<symbol>`**：思源会把传入内容插进 `<svg><defs>`，如果你又包了一层 `<svg>`，符号就注册不上，侧栏图标不显示。（曾因此修过一次：`dc104dd` / `4e71218`）
2. **blob iframe 里不能用 `new URL("/logo.png", import.meta.url)` 加载静态资源**：blob URL 没有真实路径，相对资源全挂。解决：把 logo 等小资源**内联成 base64** 或直接写进代码。（`731e8f4`）
3. **思源不热加载**：改了插件文件必须**完全退出**（不是关窗口）再重开。否则 100% 看到旧版本。

---

## 8. 完整命令速查

```powershell
# 前端单文件构建
cd frontend
npm run build:plugin

# 复制前端产物进插件外壳
Copy-Item dist-plugin\index.html ..\..\meiday-siyuan-plugin\src\assets\app.html -Force

# 构建插件
cd ..\..\meiday-siyuan-plugin
npm run build

# 安装到思源工作区（等价于 build-plugin.ps1 第 4 步）
# 把 dist\ 内容复制到 D:\desktop\congsectest\data\plugins\meiday-siyuan-plugin\

# 或者：一句话全搞定
cd ..\EasyTask
powershell -ExecutionPolicy Bypass -File .\build-plugin.ps1

# 完事后：完全退出思源 → 重开
```

---

## 9. 常见问题

**Q：我不想用 https://task.congsec.cn，想用自己的后端？**
改 `frontend/.env.production` 的 `VITE_API_BASE_URL`，重新 `npm run build:plugin` → `build-plugin.ps1`。

**Q：插件能发布给别人用吗？**
能。把 `meiday-siyuan-plugin` 仓库推到 GitHub，README 里说明“先部署好后端、改 `.env.production` 再构建”，即可作为思源集市插件发布（集市需要按思源社区规范提交）。

**Q：为什么前端不直接塞进 webpack？**
可以，但 Vue 全家桶会让 webpack 配置和产物都变得很重，且和主项目的构建体系重复维护。单文件 + iframe 让“前端构建”和“插件构建”完全解耦：前端照常用 Vite 开发，最后只是多产出一个 HTML 而已。

**Q：我想在顶部工具栏放个图标、点它弹窗，而不是侧边栏？**
可以，`src/index.ts` 里保留了 Dialog 版 `openDialog()` 的注释示例，解开注释、把 `addDock` 换成 `addTopBar` 即可。