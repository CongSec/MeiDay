# MeiDay 桌面小组件

MeiDay 任务的 Windows **桌面小组件**：半透明、无边框的小窗，常驻桌面右侧，
仅展示**今日未完成任务**。网页端、Android 端与本小组件共用同一套云端数据，操作实时双向同步。

## 功能

- **实时同步**：2 秒轮询云端版本，网页端新建/完成/排序后小组件 ≤2s 自动更新。
- **完全只读**：小组件只读云端数据，**绝不写回**——不排序、不完成/取消、不物化重复任务，
  也不会把本地缓存合并结果写回云端（这是重复任务显示 bug 的根因修复）；重复任务到期由
  App/网页端物化后，小组件同步展示物化结果。
- **仅显示今日未完成任务**：只展示任务标题；完成后立即移出列表，无任务时显示空态。
- **全透明背景**：背景完全透明，可直接透出看到桌面与其他应用界面；
  透明度可在设置中调整（10%–100%），作用于任务文字内容。
- **鼠标穿透**：默认（view）模式下窗口不拦截鼠标——看得见但点不到，不遮挡操作；
  所有交互都在设置面板中完成。
- **常驻桌面最底层**：位于所有应用窗口之下（桌面图标之上）；
  点「显示桌面」(Win+D) 时**不会最小化**，始终留在桌面；不进任务栏 / Alt-Tab。
- **自由拖动位置**：在设置面板拖动标题栏即可任意调整小组件位置，松开后自动保存，下次启动恢复；
  首次启动默认贴靠屏幕最右侧。
- **三模式**：
  - **显示**（view）：展示今日任务列表，高度随任务数自适应（96–620px），宽度可调（240–520px）；
  - **设置**（settings）：登录 / 显示隐藏 / 同步 / 外观 / 位置 / 自启动 / 退出，面板可拖拽调整位置；
  - **隐藏**（hidden）：整个小组件完全透明 + 穿透，仅保留后台同步。
- **托盘图标**：左键打开设置，右键菜单提供 打开设置 / 显示小组件 / 隐藏小组件 / 退出。
- **防偷窥**：持续对窗口设置 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`，
  录屏 / 截图 / 屏幕共享时窗口内容不可见，本人屏幕正常显示。
- **自动登录**：登录态持久化到配置文件，重启后自动恢复并加载今日任务。
- **开机自启动**：可在设置中开关（HKCU\...\Run，键名 MeiDayWidget）。

## 运行环境

- Windows 10/11（WebView2 运行时，系统自带或 Edge 自动提供）
- Python 3.10+（运行 pywebview 薄壳）
- Node.js 18+（仅构建前端时使用）

## 安装与启动（源码运行）

```powershell
cd widget
npm install          # 首次
npm run build        # 构建前端（产物在 dist/）
python run.py        # 启动桌面小组件（开发模式）
```

## 打包为独立可执行文件

```powershell
cd widget
pip install -r requirements.txt
python build.py
```

产物位于 `widget/build/dist/MeiDayWidget/MeiDayWidget.exe`（onedir 目录，需整体分发）。
打包后 `config.json` 生成在 **exe 同级目录**，托盘图标、前端资源均已内置，无需额外文件。

## 配置文件

- 位置：`config.json`，固定存放于**程序同级目录**（源码运行时为 `widget/config.json`，
  打包运行时为 exe 所在目录）。
- 结构（与思源笔记无关，不兼容旧配置）：

```json
{
  "session": { "token": "", "tokenAt": 0, "savedPw": "", "savedPwAt": 0, "username": "" },
  "widget":  { "opacity": 0.6, "width": 360, "posX": null, "posY": null, "autoStart": false }
}
```

- 登录后会自动写入 `session`；在设置中改动外观 / 拖动位置 / 自启动时自动写入 `widget`（`posX`/`posY` 为拖动后保存的屏幕位置，未拖动过为 `null`）。

## 目录

```
widget/
  run.py              # pywebview 薄壳：窗口 + 托盘 + 置底 + 防偷窥 + 配置读写
  build.py            # PyInstaller 打包脚本（onedir，config.json 落 exe 同级）
  src/App.vue         # 主界面：view / settings / hidden 三模式
  src/stores/         # auth / tasks / projects / stats / widget
  src/composables/useSyncPoll.ts   # 2s 轮询 + 引导加载 + version=0 兜底
  src/api/client.ts   # 后端 REST 客户端
  src/utils/config.ts # config.json 桥（localStorage ↔ Python 壳）
  dist/               # npm run build 产物（不提交）
```

## 常见问题

- **任务不出现**：确认已在网页端登录过同一账号、账号下有今日任务；托盘→设置→「同步」。
- **录屏 / 截图看不到小组件是正常的**：这是防偷窥特性（WDA_EXCLUDEFROMCAPTURE）。
- **小组件点不到**：view / hidden 模式是鼠标穿透的（设计如此）；要操作请通过托盘左键打开设置。
- **config.json 在哪里**：打包版在 exe 同级目录；源码版在 `widget/config.json`。