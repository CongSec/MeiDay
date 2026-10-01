<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import { useStatsStore } from '@/stores/stats'
import { useWidgetStore, type WidgetMode } from '@/stores/widget'
import { isTaskVisibleToday } from '@/utils/todayFilter'
import { pinOverdueFirst } from '@/utils/task'
import { todayKey } from '@/utils/time'
import { bootstrapLoad, startSyncPoll, stopSyncPoll, syncNow } from '@/composables/useSyncPoll'
import { persistSessionToConfig } from '@/utils/config'
import type { Task } from '@/types'

const auth = useAuthStore()
const projects = useProjectsStore()
const tasks = useTasksStore()
const stats = useStatsStore()
const widget = useWidgetStore()

/* ---------------- 窗口控制（pywebview 薄壳，浏览器调试时自动降级为 no-op） ---------------- */
// 设置窗口高度固定；宽度 = 任务显示宽度（widget.width），实时镜像任务显示
const SETTINGS_H = 580

function pvApi(): any {
  return (window as any).pywebview?.api
}
function resizeWidget(w: number, h: number) {
  pvApi()?.resize(w, h)
}
/** 宽度/字号等设置实时同步到设置窗口本身：设置窗口 = 任务显示实时镜像。
    宽度滑块 @input 时调用，高度固定，仅宽度跟随任务显示。 */
function resizeSettings() {
  resizeWidget(widget.width, SETTINGS_H)
}
function quitWidget() {
  pvApi()?.quit()
}

/* 托盘/Python 通知：全局 setMode 入口（Python 端 evaluate_js 调用） */
;(window as any).__setMode = (mode: string) => {
  widget.setMode(mode as WidgetMode)
}

/** 等待 pywebview JS 桥就绪：Vue 挂载可能早于桥注入，导致 set_mode / update_view 静默丢失。
    轮询直至可用（默认 3s 上限）；浏览器调试时无桥，超时返回 false 直接继续。 */
function whenBridgeReady(timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const check = () => {
      if (pvApi()?.set_mode) return resolve(true)
      if (Date.now() - t0 > timeoutMs) return resolve(false)
      setTimeout(check, 50)
    }
    check()
  })
}

/* 标题栏 JS 拖拽：用 window.screenX + 鼠标位移计算绝对坐标，交给 Python 端 move()。
   仅 settings 模式可交互，因此拖拽只发生在设置面板（view 为鼠标穿透）。 */
let dragState: { sx: number; sy: number; wx: number; wy: number } | null = null
let dragMoved = false
let rafPending = false
let pendingX = 0
let pendingY = 0
function onTitlebarDown(e: MouseEvent) {
  if (e.button !== 0) return
  const target = e.target as HTMLElement | null
  if (target && typeof target.closest === 'function' && target.closest('button, a, input')) return
  dragState = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY }
  dragMoved = false
  e.preventDefault()
}
function onWindowMouseMove(e: MouseEvent) {
  if (!dragState) return
  pendingX = dragState.wx + (e.screenX - dragState.sx)
  pendingY = dragState.wy + (e.screenY - dragState.sy)
  dragMoved = true
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    pvApi()?.move(pendingX, pendingY)
  })
}
function onWindowMouseUp() {
  if (dragState && dragMoved) {
    // 拖动结束：保存窗口位置（逻辑像素）到 config.json，下次启动恢复
    widget.posX = Math.round(pendingX)
    widget.posY = Math.round(pendingY)
    void widget.persist()
  }
  dragState = null
  dragMoved = false
}

/* ---------------- 登录 / 登出 ---------------- */
const loginUser = ref('')
const loginPw = ref('')
const loginErr = ref('')
const loginBusy = ref(false)

async function bootAfterLogin() {
  // 首登先引导加载（等同网页端 TodayView 挂载）：version=0 的账号（如测试号）
  // 没有同步日志，轮询拿不到 changes，必须显式拉取一次数据再进入 2s 轮询。
  await bootstrapLoad().catch(() => {})
  startSyncPoll()
  void syncNow()
}
async function doLogin() {
  loginErr.value = ''
  if (!loginUser.value.trim() || !loginPw.value) {
    loginErr.value = '请输入用户名和密码'
    return
  }
  loginBusy.value = true
  try {
    await auth.login(loginUser.value.trim(), loginPw.value, true)
    await persistSessionToConfig()
    await bootAfterLogin()
    widget.setMode('view')
  } catch (e) {
    loginErr.value = (e as Error).message || '登录失败，请检查用户名密码或网络'
  } finally {
    loginBusy.value = false
  }
}
async function doLogout() {
  stopSyncPoll()
  await auth.logout()
  projects.resetAll()
  tasks.resetAll()
  stats.resetAll()
  await persistSessionToConfig() // 清空 config.json 中的会话
  widget.setMode('settings')
}

/* ---------------- 今日视图数据 ---------------- */
const today = ref(todayKey())
let todayTimer: number | undefined

const monthDay = computed(() => {
  const d = new Date()
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getMonth() + 1}/${d.getDate()} 周${week}`
})

/** 仅今日可见的未完成任务（今日视图核心：不做完不消失，做完立即移出） */
const filtered = computed(() =>
  tasks.all.filter((t) => t.status === 'pending' && isTaskVisibleToday(t, today.value)),
)

/** 与网页端今日视图一致：注册过顺序的按顺序表排，其余按 sort/截止时间兜底，最后把已到时间的置顶 */
const sorted = computed(() => {
  const orderMap = new Map<string, number>()
  tasks.todayOrder.forEach((id, idx) => orderMap.set(id, idx))
  const byOrder = (a: Task, b: Task) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0)
  const fallback = (a: Task, b: Task) => {
    const sa = a.sort ?? Number.MAX_SAFE_INTEGER
    const sb = b.sort ?? Number.MAX_SAFE_INTEGER
    if (sa !== sb) return sa - sb
    return (a.endTime || '').localeCompare(b.endTime || '')
  }
  const registered = filtered.value.filter((t) => orderMap.has(t.id)).sort(byOrder)
  const unregistered = filtered.value.filter((t) => !orderMap.has(t.id)).sort(fallback)
  return pinOverdueFirst([...registered, ...unregistered])
})

/* ---------------- 今日视图数据 → 原生渲染窗口 ---------------- */
/** 把今日视图数据（日期/计数/任务标题列表）推给原生渲染窗口 NativeWidget。
    原生渲染器按任务数自适应高度；透明度/宽度在 Python 端 write_config 里同步。 */
function pushView() {
  const api = pvApi()
  if (!api?.update_view) return
  try {
    api.update_view({
      ready: true,
      date: monthDay.value,
      count: `${tasks.todayCount} 项未完成`,
      tasks: sorted.value.map((t) => t.name),
    })
  } catch {
    /* 浏览器调试时忽略 */
  }
}

/** 内容变化（任务增删/标题变化）时推送最新数据 */
const visibleKey = computed(() => {
  let k = ''
  for (const t of sorted.value) k += `${t.id}:${t.updatedAt}:${t.name}\n`
  return k
})
watch(visibleKey, () => pushView(), { immediate: true })
watch(today, () => pushView())
watch(
  () => widget.mode,
  (mode) => {
    if (mode === 'settings') {
      resizeWidget(widget.width, SETTINGS_H)
    } else if (mode === 'view') {
      pushView()
    }
    // hidden：原生视图由 Python 端隐藏
  },
)
watch(() => widget.width, () => pushView())
watch(
  () => auth.isLoggedIn,
  (v) => {
    if (!v) widget.setMode('settings')
  },
)

/* ---------------- 设置面板交互 ---------------- */
function toggleShow() {
  widget.setMode(widget.shown ? 'hidden' : 'view')
}
function closeSettings() {
  widget.setMode(widget.shown ? 'view' : 'hidden')
}
function persistWidget() {
  // 钳制取值范围后再落盘
  widget.opacity = Math.min(1, Math.max(0.1, Number(widget.opacity) || 0.6))
  widget.width = Math.min(520, Math.max(240, Math.round(Number(widget.width) || 360)))
  widget.fontSize = Math.min(32, Math.max(14, Math.round(Number(widget.fontSize) || 16)))
  void widget.persist()
}
async function onAutoStart(e: Event) {
  await widget.setAutoStart((e.target as HTMLInputElement).checked)
}
function onRefresh() {
  void syncNow()
}

/* ---------------- 生命周期 ---------------- */
onMounted(async () => {
  await widget.init()
  // 等 pywebview 桥就绪后再推模式，避免 on_started 之前 set_mode 被丢弃
  // （否则未登录时 settings 窗口不会出现、已登录时初始穿透/置底缺失）
  await whenBridgeReady()
  // 把当前模式同步给 Python 壳：确保 view 模式初始即开启鼠标穿透 + 置底
  widget.setMode(widget.mode)
  todayTimer = window.setInterval(() => {
    const k = todayKey()
    if (k !== today.value) today.value = k
  }, 60_000)
  window.addEventListener('mousemove', onWindowMouseMove)
  window.addEventListener('mouseup', onWindowMouseUp)
  // 未登录：直接打开设置面板（登录表单）
  if (!auth.isLoggedIn) widget.setMode('settings')
  else pushView()
})
onUnmounted(() => {
  if (todayTimer !== undefined) window.clearInterval(todayTimer)
  window.removeEventListener('mousemove', onWindowMouseMove)
  window.removeEventListener('mouseup', onWindowMouseUp)
})

/* ---------------- 背景 / 透明度 ---------------- */
// 视图内容由原生渲染窗口（NativeWidget）展示，透明度由 Python 端传给原生渲染器；
// 这里只需 settings 面板保持深色可读。
// 设置窗口 = 任务显示实时镜像：背景为半透明白色圆角矩形（透明度/字号实时联动），
// 透明度语义与原生任务显示一致：opacity 越大背景越透明（后面程序越清晰），文字保持黑色。
const settingsBgStyle = computed(() => ({
  background: `rgba(255, 255, 255, ${(1 - widget.opacity).toFixed(3)})`,
  '--fs': `${widget.fontSize}px`,
}))
</script>

<template>
  <!-- ============ 隐藏态：完全透明，只留托盘 ============ -->
  <div v-if="widget.mode === 'hidden'" class="hidden-root"></div>

  <!-- ============ 设置面板：可交互、可拖拽 ============ -->
  <div v-else-if="widget.mode === 'settings'" class="settings-root" :style="settingsBgStyle">
    <header class="settings-header" @mousedown="onTitlebarDown">
      <span class="settings-title">{{ auth.isLoggedIn ? '设置' : '登录 MeiDay 小组件' }}</span>
      <button v-if="auth.isLoggedIn" class="icon-btn" title="关闭设置" @click="closeSettings">
        <svg viewBox="0 0 16 16" width="12" height="12">
          <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
    </header>

    <div class="settings-body">
      <!-- ===== 登录表单（未登录） ===== -->
      <section v-if="!auth.isLoggedIn" class="login">
        <div class="login-sub">今日任务 · 实时同步 · 防偷窥</div>
        <form class="login-form" @submit.prevent="doLogin">
          <input v-model="loginUser" class="field-input" placeholder="用户名" autocomplete="username" />
          <input
            v-model="loginPw"
            class="field-input"
            placeholder="密码"
            type="password"
            autocomplete="current-password"
          />
          <div v-if="loginErr" class="login-err">{{ loginErr }}</div>
          <button class="primary-btn" type="submit" :disabled="loginBusy">
            {{ loginBusy ? '登录中…' : '登 录' }}
          </button>
        </form>
        <div class="login-foot">登录后自动记住并实时同步今日任务</div>
      </section>

      <!-- ===== 设置项（已登录） ===== -->
      <template v-else>
        <section class="account-row">
          <span class="account-name" :title="auth.username">已登录：{{ auth.username }}</span>
          <button class="ghost-btn" @click="doLogout">退出登录</button>
        </section>

        <section class="group">
          <div class="group-title">小组件</div>
          <div class="row">
            <span class="row-label">显示 / 隐藏</span>
            <button class="ghost-btn" @click="toggleShow">
              {{ widget.shown ? '隐藏小组件' : '显示小组件' }}
            </button>
          </div>
          <div class="row">
            <span class="row-label">立即同步</span>
            <button class="ghost-btn" @click="onRefresh">同步</button>
          </div>
        </section>

        <section class="group">
          <div class="group-title">外观</div>
          <div class="row">
            <span class="row-label">透明度</span>
            <input
              class="range"
              type="range"
              min="0.1"
              max="1"
              step="0.01"
              v-model.number="widget.opacity"
              @change="persistWidget"
            />
            <span class="row-value">{{ Math.round(widget.opacity * 100) }}%</span>
          </div>
          <div class="hint">透明度越高，背景越透明，后面程序越清晰；任务文字保持黑色。</div>
          <div class="row">
            <span class="row-label">宽度 (px)</span>
            <input
              class="num-input"
              type="number"
              min="240"
              max="520"
              step="10"
              v-model.number="widget.width"
              @input="resizeSettings"
              @change="persistWidget"
            />
          </div>
          <div class="row">
            <span class="row-label">字体大小 (px)</span>
            <input
              class="range"
              type="range"
              min="14"
              max="32"
              step="1"
              v-model.number="widget.fontSize"
              @change="persistWidget"
            />
            <span class="row-value">{{ widget.fontSize }}px</span>
          </div>
        </section>

        <section class="group">
          <div class="group-title">屏幕位置</div>
          <div class="hint">拖动上方标题栏即可自由调整小组件位置，松开后自动保存，下次启动恢复。</div>
        </section>

        <section class="group">
          <div class="group-title">启动</div>
          <div class="row">
            <span class="row-label">开机自启动</span>
            <label class="switch">
              <input type="checkbox" :checked="widget.autoStart" @change="onAutoStart" />
              <span class="slider"></span>
            </label>
          </div>
        </section>

        <section class="group">
          <button class="danger-btn" @click="quitWidget">退出小组件</button>
        </section>
      </template>
    </div>
  </div>

  <!-- ============ 视图态：内容由原生渲染窗口展示（native_widget.py），这里仅占位 ============ -->
  <div v-else class="view-root"></div>
</template>

<style scoped>
* {
  box-sizing: border-box;
  user-select: none;
  -webkit-user-select: none;
}

/* ---------- 隐藏态 ---------- */
.hidden-root {
  position: absolute;
  inset: 0;
  background: transparent;
}

/* ---------- 设置面板 ---------- */
.settings-root {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  box-shadow: 0 10px 36px rgba(0, 0, 0, 0.22);
  color: #111;
  overflow: hidden;
  font-size: var(--fs, 16px);
}
.settings-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.1);
  cursor: move;
}
.settings-title {
  font-size: calc(var(--fs, 16px) * 1.06);
  font-weight: 700;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #555;
  cursor: pointer;
}
.icon-btn:hover {
  background: rgba(0, 0, 0, 0.08);
  color: #000;
}
.settings-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.settings-body::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.05);
  border: 1px solid rgba(0, 0, 0, 0.08);
}
.group-title {
  font-size: calc(var(--fs, 16px) * 0.82);
  font-weight: 700;
  color: #555;
  letter-spacing: 1px;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.row-label {
  flex-shrink: 0;
  color: #222;
}
.row-value {
  flex-shrink: 0;
  min-width: 44px;
  text-align: right;
  color: #555;
  font-size: calc(var(--fs, 16px) * 0.9);
}
.hint {
  font-size: calc(var(--fs, 16px) * 0.82);
  color: #555;
  line-height: 1.5;
}
.range {
  flex: 1;
  min-width: 0;
  accent-color: #3b82f6;
}
.num-input {
  width: 84px;
  padding: 4px 8px;
  border: 1px solid rgba(0, 0, 0, 0.2);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.7);
  color: #111;
  font-size: var(--fs, 16px);
  outline: none;
}
.num-input:focus {
  border-color: #3b82f6;
}
/* 开关 */
.switch {
  position: relative;
  display: inline-block;
  width: 38px;
  height: 22px;
  flex-shrink: 0;
}
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.switch .slider {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.25);
  transition: background 0.15s;
  cursor: pointer;
}
.switch .slider::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  left: 3px;
  top: 3px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  transition: transform 0.15s;
}
.switch input:checked + .slider {
  background: #3b82f6;
}
.switch input:checked + .slider::before {
  transform: translateX(16px);
}
/* 按钮 */
.primary-btn,
.ghost-btn,
.danger-btn {
  border: none;
  border-radius: 8px;
  font-size: var(--fs, 16px);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s;
}
.primary-btn {
  padding: 8px;
  background: #3b82f6;
  color: #fff;
}
.primary-btn:hover:not(:disabled) {
  background: #2563eb;
}
.primary-btn:disabled {
  opacity: 0.6;
}
.ghost-btn {
  padding: 4px 10px;
  background: rgba(0, 0, 0, 0.06);
  color: #222;
}
.ghost-btn:hover {
  background: rgba(0, 0, 0, 0.12);
}
.danger-btn {
  width: 100%;
  padding: 8px;
  background: rgba(220, 38, 38, 0.8);
  color: #fff;
}
.danger-btn:hover {
  background: rgba(220, 38, 38, 0.95);
}
/* 登录 */
.login {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 4px;
}
.login-sub {
  font-size: calc(var(--fs, 16px) * 0.85);
  color: #555;
  text-align: center;
}
.login-form {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.field-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.7);
  color: #111;
  font-size: var(--fs, 16px);
  outline: none;
}
.field-input:focus {
  border-color: #3b82f6;
}
.login-err {
  font-size: calc(var(--fs, 16px) * 0.85);
  color: #dc2626;
}
.login-foot {
  font-size: calc(var(--fs, 16px) * 0.82);
  color: #555;
  text-align: center;
}
/* 账号行 */
.account-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 2px;
}
.account-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: #111;
  font-weight: 600;
}


</style>

