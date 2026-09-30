<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { VueDraggable } from 'vue-draggable-plus'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import { isTaskVisibleToday } from '@/utils/todayFilter'
import { isTaskPastDue, pinOverdueFirst } from '@/utils/task'
import { todayKey } from '@/utils/time'
import { bootstrapLoad, startSyncPoll, stopSyncPoll, syncNow } from '@/composables/useSyncPoll'
import type { Task } from '@/types'

const auth = useAuthStore()
const projects = useProjectsStore()
const tasks = useTasksStore()
const ui = useUiStore()

/* ---------------- 窗口控制（pywebview 薄壳，浏览器调试时自动降级为 no-op） ---------------- */
const WIDGET_W = 360
const H_EXPANDED = 540
const H_COLLAPSED = 60

function pvApi(): any {
  return (window as any).pywebview?.api
}
function resizeWidget(h: number) {
  pvApi()?.resize(WIDGET_W, h)
}
function hideWidget() {
  pvApi()?.hide()
}

/* 标题栏 JS 拖拽：用 window.screenX + 鼠标位移计算绝对坐标，交给 Python 端 move()。
   相比 pywebview 内置拖拽区，跨 DPI（125%/150% 缩放）也精确（两端都是逻辑像素）。 */
let dragState: { sx: number; sy: number; wx: number; wy: number } | null = null
let rafPending = false
let pendingX = 0
let pendingY = 0
function onTitlebarDown(e: MouseEvent) {
  if (e.button !== 0) return
  const target = e.target as HTMLElement | null
  if (target && typeof target.closest === 'function' && target.closest('button, a, input, .no-drag')) return
  dragState = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY }
  e.preventDefault()
}
function onWindowMouseMove(e: MouseEvent) {
  if (!dragState) return
  pendingX = dragState.wx + (e.screenX - dragState.sx)
  pendingY = dragState.wy + (e.screenY - dragState.sy)
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    pvApi()?.move(pendingX, pendingY)
  })
}
function onWindowMouseUp() {
  dragState = null
}

/* ---------------- 折叠 ---------------- */
const collapsed = ref(false)
function toggleCollapsed() {
  collapsed.value = !collapsed.value
  resizeWidget(collapsed.value ? H_COLLAPSED : H_EXPANDED)
}

/* ---------------- 登录 ---------------- */
const loginUser = ref('')
const loginPw = ref('')
const loginErr = ref('')
const loginBusy = ref(false)
function fillTestAccount() {
  loginUser.value = 'congsec'
  loginPw.value = '12345678'
}
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
    await bootAfterLogin()
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
  const { useStatsStore } = await import('@/stores/stats')
  useStatsStore().resetAll()
}

/* ---------------- 今日视图数据 ---------------- */
const today = ref(todayKey())
let todayTimer: number | undefined
onMounted(() => {
  todayTimer = window.setInterval(() => {
    const k = todayKey()
    if (k !== today.value) today.value = k
  }, 60_000)
  window.addEventListener('mousedown', onTitlebarDown, true)
  window.addEventListener('mousemove', onWindowMouseMove)
  window.addEventListener('mouseup', onWindowMouseUp)
})
onUnmounted(() => {
  if (todayTimer !== undefined) window.clearInterval(todayTimer)
  window.removeEventListener('mousedown', onTitlebarDown, true)
  window.removeEventListener('mousemove', onWindowMouseMove)
  window.removeEventListener('mouseup', onWindowMouseUp)
})

const monthDay = computed(() => {
  const d = new Date()
  return `${d.getMonth() + 1}/${d.getDate()}`
})

/** 仅今日可见的未完成任务（今日视图核心：不做完不消失，做完立即移出） */
const filtered = computed(() =>
  tasks.all.filter((t) => t.status === 'pending' && isTaskVisibleToday(t, today.value)),
)

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
  return [...registered, ...unregistered]
})

const dragList = ref<Task[]>([])
let dragged = false
const visibleKey = computed(() => {
  let key = ''
  for (const t of tasks.all) {
    if (t.status === 'pending' && isTaskVisibleToday(t, today.value)) key += `${t.id}:${t.updatedAt}\n`
  }
  return key
})
watch(
  [visibleKey, () => tasks.todayOrder],
  () => {
    dragList.value = dragged ? sorted.value : pinOverdueFirst(sorted.value)
  },
  { immediate: true },
)

function onDragStart() {
  document.body.classList.add('widget-dragging')
}
function onDragEnd() {
  document.body.classList.remove('widget-dragging')
  dragged = true
  const byProject = new Map<string, Task[]>()
  for (const t of dragList.value) {
    const arr = byProject.get(t.projectId) ?? []
    arr.push(t)
    byProject.set(t.projectId, arr)
  }
  for (const [pid, arr] of byProject) {
    const full = tasks.tasks[pid] ?? []
    const draggedIds = new Set(arr.map((t) => t.id))
    const notDragged = full.filter((t) => !draggedIds.has(t.id))
    const ordered: Task[] = []
    let ni = 0
    let ai = 0
    for (const t of full) {
      if (draggedIds.has(t.id)) {
        if (ai < arr.length) ordered.push(arr[ai++])
      } else {
        ordered.push(notDragged[ni++])
      }
    }
    while (ai < arr.length) ordered.push(arr[ai++])
    tasks.setOrder(pid, ordered)
  }
  const visibleIds = dragList.value.map((t) => t.id)
  if (visibleIds.join('|') !== tasks.todayOrder.join('|')) tasks.setTodayOrder(visibleIds)
}

/* ---------------- 完成任务 / 展示辅助 ---------------- */
const toggling = new Set<string>()
async function onToggle(t: Task) {
  if (toggling.has(t.id)) return
  toggling.add(t.id)
  try {
    const ok = await tasks.toggleCompleteConfirmed(t.id)
    if (ok) ui.toast('已完成并同步')
    else ui.toast('保存失败，请检查网络后重试', 'error')
  } catch (e) {
    ui.toast(`保存失败：${(e as Error).message || '未知错误'}`, 'error')
  } finally {
    toggling.delete(t.id)
  }
}

function fmtHM(iso: string): string {
  if (!iso) return ''
  return iso.slice(11, 16)
}
function timeText(t: Task): string {
  if (t.startTime && t.endTime) return `${fmtHM(t.startTime)}~${fmtHM(t.endTime)}`
  if (t.endTime) return fmtHM(t.endTime)
  if (t.startTime) return fmtHM(t.startTime)
  let best = ''
  for (const s of t.subtasks ?? []) {
    if (s.completed) continue
    const cand = s.endTime || s.startTime || s.reminderTime || ''
    if (cand && (!best || cand < best)) best = cand
  }
  return best ? fmtHM(best) : ''
}
const projectOf = (id: string) => (id ? projects.byId(id) : undefined)
const isPastDue = (t: Task) => isTaskPastDue(t)

function onRefresh() {
  void syncNow()
}
</script>

<template>
  <div class="widget" :class="{ collapsed }">
    <!-- ============ 登录界面 ============ -->
    <div v-if="!auth.isLoggedIn" class="login">
      <div class="login-title">MeiDay 桌面小组件</div>
      <div class="login-sub">今日任务 · 实时同步 · 防偷窥</div>
      <form class="login-form" @submit.prevent="doLogin">
        <input v-model="loginUser" class="login-input" placeholder="用户名" autocomplete="username" />
        <input
          v-model="loginPw"
          class="login-input"
          placeholder="密码"
          type="password"
          autocomplete="current-password"
        />
        <div v-if="loginErr" class="login-err">{{ loginErr }}</div>
        <button class="login-btn" type="submit" :disabled="loginBusy">
          {{ loginBusy ? '登录中…' : '登 录' }}
        </button>
        <button type="button" class="login-test" @click="fillTestAccount">一键填入测试账号 congsec</button>
      </form>
      <div class="login-foot">测试号数据每小时清空；首次使用 OSS 返回 404 属正常</div>
    </div>

    <!-- ============ 主界面 ============ -->
    <template v-else>
      <!-- 标题栏：整体可拖拽（JS 拖拽），按钮区域 .no-drag 排除 -->
      <header class="titlebar">
        <div class="titlebar-main" @mousedown="onTitlebarDown">
          <span class="collapse-btn" @click="toggleCollapsed" :title="collapsed ? '展开' : '折叠'">
            <svg v-if="!collapsed" viewBox="0 0 16 16" width="11" height="11">
              <path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <svg v-else viewBox="0 0 16 16" width="11" height="11">
              <path d="M3 10l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <span class="title-date">{{ monthDay }}</span>
          <span class="title-count">{{ tasks.todayCount }} 项未完成</span>
        </div>
        <div class="titlebar-actions no-drag">
          <button class="icon-btn" title="立即同步" @click="onRefresh">
            <svg viewBox="0 0 16 16" width="12" height="12">
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <button class="icon-btn" title="隐藏到任务栏" @click="hideWidget">
            <svg viewBox="0 0 16 16" width="12" height="12">
              <path d="M3 9h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </button>
          <button class="icon-btn" title="退出登录" @click="doLogout">
            <svg viewBox="0 0 16 16" width="12" height="12">
              <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v7A1.5 1.5 0 0 0 3.5 13H6M10 5l3 3-3 3M13 8H6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </header>

      <!-- 未解锁提醒（自动登录失败时） -->
      <div v-if="!auth.userKey" class="unlock-banner no-drag">
        无法自动解锁云端数据，请退出后重新登录
      </div>

      <!-- 任务列表 -->
      <div v-if="!collapsed" class="body">
        <VueDraggable
          v-if="dragList.length"
          v-model="dragList"
          :animation="180"
          :swap-threshold="0.5"
          :filter="'.no-drag, input, button, label, a'"
          :prevent-on-filter="false"
          class="task-list"
          @start="onDragStart"
          @end="onDragEnd"
        >
          <div v-for="t in dragList" :key="t.id" class="task-item" :class="{ past: isPastDue(t) }">
            <label class="task-check no-drag" @click.prevent.stop>
              <input type="checkbox" :checked="t.status === 'completed'" @change="onToggle(t)" />
            </label>
            <div class="task-body">
              <div class="task-name" :title="t.description">{{ t.name }}</div>
              <div v-if="timeText(t) || projectOf(t.projectId)" class="task-meta">
                <span v-if="projectOf(t.projectId)?.color" class="dot" :style="{ background: projectOf(t.projectId)!.color }"></span>
                <span class="task-project">{{ projectOf(t.projectId)?.name ?? '' }}</span>
                <span v-if="timeText(t)" class="task-time">{{ timeText(t) }}</span>
                <span v-if="isPastDue(t)" class="task-overdue">已到时间</span>
              </div>
            </div>
          </div>
        </VueDraggable>
        <div v-else class="empty">
          <div class="empty-title">今日没有待办任务</div>
          <div class="empty-hint">到网页端创建今日任务后会自动同步</div>
          <a class="empty-link" href="https://task.congsec.cn" target="_blank">打开网页端 →</a>
        </div>
      </div>

      <!-- 折叠后的细条提示 -->
      <div v-if="collapsed" class="collapsed-hint no-drag">
        <span>点箭头展开今日任务</span>
      </div>
    </template>

    <!-- ============ 轻提示 ============ -->
    <div class="toast-layer" v-if="ui.toasts.length">
      <div v-for="t in ui.toasts" :key="t.id" class="toast" :class="t.type" @click="ui.dismiss(t.id)">
        {{ t.text }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.widget {
  position: absolute;
  inset: 8px;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  border-radius: 14px;
  box-shadow: 0 8px 28px rgba(15, 23, 42, 0.22), 0 2px 6px rgba(15, 23, 42, 0.1);
  border: 1px solid rgba(15, 23, 42, 0.08);
  overflow: hidden;
  font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
  color: #1e293b;
}

/* ---------- 标题栏 ---------- */
.titlebar {
  flex: 0 0 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 6px 0 10px;
  background: #ffffff;
  border-bottom: 1px solid #f1f5f9;
  user-select: none;
  -webkit-user-select: none;
}
.titlebar-main {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  flex: 1;
  min-width: 0;
  cursor: grab;
}
.titlebar-main:active {
  cursor: grabbing;
}
.collapse-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  color: #64748b;
  cursor: pointer;
  flex-shrink: 0;
}
.collapse-btn:hover {
  background: #f1f5f9;
  color: #334155;
}
.title-date {
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
}
.title-count {
  font-size: 12px;
  color: #64748b;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.titlebar-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #64748b;
  cursor: pointer;
}
.icon-btn:hover {
  background: #f1f5f9;
  color: #334155;
}

/* ---------- 未解锁提醒 ---------- */
.unlock-banner {
  flex: 0 0 auto;
  margin: 6px 8px 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: #fef3c7;
  color: #92400e;
  font-size: 11px;
  text-align: center;
}

/* ---------- 任务列表 ---------- */
.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
.body::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.task-list {
  display: flex;
  flex-direction: column;
}
.task-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 9px 12px;
  border-bottom: 1px solid #f1f5f9;
  cursor: pointer;
  transition: background 0.12s;
}
.task-item:hover {
  background: #f8fafc;
}
.task-item.past .task-name {
  color: #dc2626;
}
.task-check {
  margin-top: 1px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.task-check input {
  width: 16px;
  height: 16px;
  accent-color: #3b82f6;
  cursor: pointer;
}
.task-body {
  flex: 1;
  min-width: 0;
}
.task-name {
  font-size: 13px;
  line-height: 1.35;
  color: #1e293b;
  word-break: break-all;
}
.task-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
  font-size: 11px;
  color: #94a3b8;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.task-project {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  max-width: 120px;
}
.task-time {
  flex-shrink: 0;
}
.task-overdue {
  color: #dc2626;
  flex-shrink: 0;
}

/* ---------- 空态 ---------- */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 40px 20px;
  text-align: center;
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: #334155;
}
.empty-hint {
  font-size: 12px;
  color: #94a3b8;
}
.empty-link {
  margin-top: 4px;
  font-size: 12px;
  color: #3b82f6;
  text-decoration: none;
}
.empty-link:hover {
  text-decoration: underline;
}

/* ---------- 折叠细条 ---------- */
.collapsed-hint {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: #cbd5e1;
  user-select: none;
}

/* ---------- 登录 ---------- */
.login {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 24px;
  text-align: center;
}
.login-title {
  font-size: 18px;
  font-weight: 700;
  color: #0f172a;
}
.login-sub {
  font-size: 12px;
  color: #94a3b8;
  margin-bottom: 14px;
}
.login-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 260px;
}
.login-input {
  width: 100%;
  padding: 8px 11px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 13px;
  outline: none;
  background: #fff;
}
.login-input:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
}
.login-err {
  font-size: 12px;
  color: #dc2626;
}
.login-btn {
  width: 100%;
  padding: 8px;
  border: none;
  border-radius: 8px;
  background: #3b82f6;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.login-btn:disabled {
  opacity: 0.6;
}
.login-btn:hover:not(:disabled) {
  background: #2563eb;
}
.login-test {
  background: none;
  border: none;
  color: #64748b;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.login-foot {
  margin-top: 12px;
  font-size: 11px;
  color: #cbd5e1;
}

/* ---------- 轻提示 ---------- */
.toast-layer {
  position: absolute;
  top: 50px;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  pointer-events: none;
  z-index: 10;
}
.toast {
  pointer-events: auto;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  color: #fff;
  box-shadow: 0 3px 10px rgba(15, 23, 42, 0.2);
  cursor: pointer;
}
.toast.ok {
  background: rgba(30, 41, 59, 0.92);
}
.toast.error {
  background: rgba(220, 38, 38, 0.95);
}

/* ---------- 拖拽视觉 ---------- */
:global(.widget-dragging *) {
  user-select: none !important;
  -webkit-user-select: none !important;
}
:global(.drag-ghost) {
  opacity: 0.4;
}
:global(.drag-chosen) {
  background: #eff6ff !important;
}
</style>
