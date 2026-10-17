<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { VueDraggable } from 'vue-draggable-plus'
import { getDragOptions, setDragging } from '@/utils/drag'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import TaskCard from '@/components/TaskCard.vue'
import TaskModal from '@/components/TaskModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import AppIcon from '@/components/AppIcon.vue'
import { dateKeyOf, nowIso, toLocalInput, addMonthsKey } from '@/utils/time'
import { collectFutureVisibleTasks, isTaskVisibleToday } from '@/utils/todayFilter'
import type { Subtask, Task } from '@/types'
import { useSync } from '@/composables/useSync'
import { useNow } from '@/composables/useNow'
import { taskCompleteFeedback, vibrateSubtaskComplete } from '@/utils/taskFeedback'

const auth = useAuthStore()
const projects = useProjectsStore()
const tasks = useTasksStore()
const ui = useUiStore()
const router = useRouter()
const { syncing, syncNow } = useSync()

const modalOpen = ref(false)
const editing = ref<Task | null>(null)
const editingSubtask = ref<Subtask | null>(null)
const subtaskParent = ref<Task | null>(null)
const deleteTarget = ref<Task | null>(null)
const defaultStart = ref('')
/** 正在编辑的重复模板对应的 master id（非模板编辑为 null） */
const templateMasterId = ref<string | null>(null)
/** 从「未来任务」卡打开编辑时记住对应那一天：存入时间胶囊只删除该天，不碰其它未来日 */
const editFutureDate = ref<string | null>(null)

/** 手机端头部「新建任务」由本页注册（随路由切换） */
const mobileActions = inject<
  { newTask: (() => void) | null; title: string } | null
>('mobile-actions', null)

const MOBILE_TITLE = '今日任务'
onMounted(async () => {
  document.addEventListener('pointerdown', onDocPointerdown)
  if (mobileActions) {
    mobileActions.newTask = () => openNew()
    mobileActions.title = MOBILE_TITLE
  }
  if (!projects.loaded) await projects.load()
  // 先从本地 IDB 恢复缓存（不访问 OSS）判断哪些项目今日有任务。
  // 本地缓存不完整（全新设备/首次进入）时，无法判断哪些项目今日有任务：必须全量加载
  // 所有项目的任务文件（渐进分批），否则今日视图首次进入为空，只有手动点开项目才拉取
  // 数据（跨设备新增的今日任务也会一直不出现）。
  // 已有完整缓存时只刷「今日相关」项目，避免重复进入时全量下载几百个项目的
  // tasks/trash/repeats 数据包（OSS 请求/内存风暴）。
  const allIds = [...projects.projects.map((p) => p.id)]
  const cachedIds = await tasks.loadFromIdb(allIds)
  const fullyCached = allIds.every((id) => cachedIds.includes(id))
  const todayIds = tasks.todayRelevantProjectIds(allIds)
  const toLoad = fullyCached ? [...new Set([...todayIds])] : allIds
  await tasks.loadAllProgressive(toLoad)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocPointerdown)
  setDragging(false)
  if (mobileActions) {
    mobileActions.newTask = null
    if (mobileActions.title === MOBILE_TITLE) mobileActions.title = ''
  }
})

// 跨天自动更新的今天日期（由全局共享时钟驱动）
const { today } = useNow()
const filtered = computed(() => {
  const list = tasks.all
  return list.filter((t) => isTaskVisibleToday(t, today.value))
})

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
  const group = (list: Task[]) => {
    const registered = list.filter((t) => orderMap.has(t.id)).sort(byOrder)
    const unregistered = list.filter((t) => !orderMap.has(t.id)).sort(fallback)
    return [...registered, ...unregistered]
  }
  return [
    ...group(filtered.value.filter((t) => t.status === 'pending')),
    ...group(filtered.value.filter((t) => t.status === 'completed')),
  ]
})

const todayDone = computed(() => filtered.value.filter((t) => t.status === 'completed').length)
/** 今日任务进度：已完成 / 今日可见任务 百分比 */
const todayPct = computed(() =>
  filtered.value.length ? Math.round((todayDone.value / filtered.value.length) * 100) : 0,
)

/** 未来任务分组是否展开（默认收起） */
const futureOpen = ref(false)

/** 未来任务时间窗口档位（自然月）：1 / 3 / 6 个月，默认 1 个月；每次进入页面固定从 1 个月开始，不持久化 */
const FUTURE_WINDOW_MONTHS = [1, 3, 6] as const
const FUTURE_WINDOW_LABEL: Record<number, string> = { 1: '1 个月', 3: '3 个月', 6: '6 个月' }
/** 当前选中的未来任务窗口（月） */
const futureWindowMonths = ref<number>(1)
/** 时间筛选下拉是否展开 */
const futureMenuOpen = ref(false)
const futureMenuEl = ref<HTMLElement | null>(null)

/** 未来任务（最宽窗口 6 个月扫描）：驱动分组显隐——只要 6 个月内存在未来任务就显示分组，
 *  保证时间筛选按钮始终可点（不会因当前窗口为空而整组消失、陷入死胡同）。 */
const futureTasksWide = computed(() => collectFutureVisibleTasks(tasks.all, tasks.repeats, today.value, 6))

/** 未来任务分组是否显示：由最宽窗口决定（收起状态与筛选档位无关） */
const showFutureGroup = computed(() => futureTasksWide.value.length > 0)

/** 未来任务（当前选中窗口）：宽列表按「窗口终点」过滤，等价于直接按当前窗口扫描，
 *  避免对同一批任务做多轮逐日遍历；沿用原有排序与去重。 */
const futureTasks = computed(() => {
  const last = addMonthsKey(today.value, futureWindowMonths.value)
  return futureTasksWide.value.filter((x) => x.date <= last)
})

/** 点击筛选下拉外部时收起 */
function onDocPointerdown(e: PointerEvent): void {
  const el = futureMenuEl.value
  if (futureMenuOpen.value && el && !el.contains(e.target as Node)) {
    futureMenuOpen.value = false
  }
}

/** 切换未来任务时间窗口 */
function selectFutureWindow(months: number): void {
  futureWindowMonths.value = months
  futureMenuOpen.value = false
}

/** 拖拽用可变列表：注册过 todayOrder 的按手动顺序排，其余按 sort/截止时间兜底；手动拖拽后保留顺序，仅在任务增删时重排 */
const dragList = ref<Task[]>([])

/** 统一拖拽参数（触屏 fallback 拖拽更丝滑） */
const dragOptions = getDragOptions({ wholeCard: true })

/**
 * 今日可见任务的结构指纹（id:status:updatedAt）：
 * 只跟踪影响列表结构的字段（增删 / 完成状态 / 可见性 / 内容更新时间），
 * 避免 deep watch 在任意任务字段变化（如编辑子任务）时深遍历整个列表并全量重建；
 * 任务内容的渲染由 TaskCard 直接响应任务对象的变化，无需重建 dragList。
 */
const visibleKey = computed(() => {
  let key = ''
  for (const t of tasks.all) {
    if (isTaskVisibleToday(t, today.value)) key += `${t.id}:${t.status}:${t.updatedAt}\n`
  }
  return key
})

watch(
  [visibleKey, () => tasks.todayOrder],
  () => {
    // 手动拖拽顺序最高优先：注册过 todayOrder 的按顺序表排，未注册的按 sort/截止时间兜底，
    // 过期任务不再自动置顶（避免覆盖手动顺序）。
    dragList.value = sorted.value
  },
  { immediate: true },
)

function onDragStart() {
  setDragging(true)
}

function onDragEnd() {
  setDragging(false)
  const byProject = new Map<string, Task[]>()
  for (const t of dragList.value) {
    if (t.status !== 'pending') continue
    const arr = byProject.get(t.projectId) ?? []
    arr.push(t)
    byProject.set(t.projectId, arr)
  }
  for (const [pid, arr] of byProject) {
    const full = tasks.tasks[pid] ?? []
    // 今日视图只包含“今日可见”的任务；拖拽后把拖拽任务的“新顺序”填回其原本
    // 占据的槽位，其余任务（含今日不可见的 pending）保持原有位置与相对顺序，
    // 避免被打乱或整体挪到末尾。
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

const projectOf = (id: string) => (id ? projects.byId(id) : undefined)

async function openNew() {
  editing.value = null
  templateMasterId.value = null
  subtaskParent.value = null
  editingSubtask.value = null
  defaultStart.value = toLocalInput(nowIso())
  modalOpen.value = true
  try {
    await projects.ensureLoaded()
  } catch (e) {
    ui.toast((e as Error).message || '项目加载失败，请检查网络或 OSS 配置', 'error')
  }
}

/** 查找某 id 对应的重复模板 master（repeats 中 template.id 匹配，墓碑除外）；非模板返回 undefined */
function findMasterByTemplateId(taskId: string) {
  for (const pid of Object.keys(tasks.repeats)) {
    const m = (tasks.repeats[pid] ?? []).find((x) => !x.deletedAt && x.template.id === taskId)
    if (m) return m
  }
  return undefined
}

function openEdit(task: Task, futureDate?: string | null) {
  templateMasterId.value = findMasterByTemplateId(task.id)?.id ?? null
  editing.value = task
  // 未来任务卡：记住对应那一天，供「存入时间胶囊」单日删除（只删该天）
  editFutureDate.value = futureDate ?? null
  // 主任务编辑：退出子任务模式，避免弹窗复用上次编辑的子任务内容
  subtaskParent.value = null
  editingSubtask.value = null
  modalOpen.value = true
}

/** 未来任务卡编辑：记录该卡对应的未来日期，存入时间胶囊时只处理那一天 */
function openFutureEdit(task: Task) {
  const ft = futureTasks.value.find((x) => x.task.id === task.id)
  openEdit(task, ft?.date)
}

function onSaved() {
  ui.toast('任务已保存')
}

async function onToggle(id: string) {
  const t = tasks.all.find((x) => x.id === id)
  const completing = !!t && t.status !== 'completed'
  const ok = await tasks.toggleCompleteConfirmed(id)
  if (!ok) return
  if (completing) taskCompleteFeedback()
  ui.toast(completing ? '任务已完成，已同步到服务端' : '已取消完成，已同步到服务端')
}

function onAddSubtask(task: Task) {
  subtaskParent.value = task
  editingSubtask.value = null
  modalOpen.value = true
}

function onEditSubtask(task: Task, sub: Subtask) {
  subtaskParent.value = task
  editingSubtask.value = sub
  modalOpen.value = true
}

function onSavedSubtask() {
  ui.toast('子任务已保存')
  // 保存子任务后退出子任务模式，避免“新建任务”按钮被劫持
  subtaskParent.value = null
  editingSubtask.value = null
}

function onToggleSubtask(taskId: string, subId: string) {
  const t = tasks.all.find((x) => x.id === taskId)
  const sub = t?.subtasks?.find((s) => s.id === subId)
  const completing = !!sub && !sub.completed
  tasks.toggleSubtask(taskId, subId)
  if (completing) void vibrateSubtaskComplete()
}

function onRemoveSubtask(taskId: string, subId: string) {
  tasks.removeSubtaskFrom(taskId, subId)
}

function onDelete(id: string) {
  const t = tasks.all.find((x) => x.id === id)
  if (t) deleteTarget.value = t
  else {
    // 未来任务/重复模板未来出现（不在 tasks.all）：仅记录 id，
    // 确认后由 store 解析并按「对应那一天」单日存入时间胶囊
    deleteTarget.value = { id } as Task
  }
}

/** 未来任务提前完成：只完成对应那一天（单日处理），不触碰其它未来出现与已完成历史日 */
async function onFutureToggle(id: string) {
  const ft = futureTasks.value.find((x) => x.task.id === id)
  if (!ft) return
  const ok = await tasks.completeFutureOccurrence(ft.task.id, ft.date)
  if (ok) {
    taskCompleteFeedback()
    ui.toast('任务已完成')
  }
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  const t = deleteTarget.value
  // 确认按钮前端立即生效：关弹窗；保存结果由回显后的 toast 提示
  deleteTarget.value = null
  const ok = await tasks.deleteFutureTaskConfirmed(t.id, editFutureDate.value ?? undefined)
  editFutureDate.value = null
  if (ok) ui.toast('已存入时间胶囊')
}
</script>

<template>
  <div class="relative min-h-full p-4 sm:p-6">
    <!-- 全宽暖色渐变背景层：铺满整个内容区（含侧边留白），任务框外也自然延续，避免“截断” -->
    <div class="absolute inset-0 bg-gradient-to-b from-amber-100/70 via-amber-50/40 to-amber-50/10 pointer-events-none" aria-hidden="true"></div>
    <div class="relative max-w-3xl mx-auto">
      <div v-if="!auth.hasCreds" class="py-16 text-center">
        <div class="mx-auto w-16 h-16 rounded-2xl bg-white border border-line shadow-card flex items-center justify-center text-slate-300"><AppIcon name="box" :size="30" /></div>
        <div class="mt-4 text-base font-medium text-slate-700">还没有配置存储和邮箱</div>
        <div class="mt-1 text-sm text-slate-400">配置后即可开始使用 OSS 存储与离线邮箱提醒</div>
        <button
          class="mt-6 px-5 py-2.5 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-dark"
          @click="router.push('/settings')"
        >
          去配置
        </button>
      </div>
  
      <template v-else>
        <!-- 顶部信息带：日期标题 + 同步（桌面端，新建任务统一在右下角悬浮按钮） -->
        <div class="hidden lg:flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 shadow-card flex items-center justify-center text-white">
              <AppIcon name="calendar" :size="20" />
            </span>
            <div>
              <h1 class="text-xl font-bold text-slate-800 leading-tight">今日任务</h1>
              <div class="text-xs text-slate-400 mt-0.5">{{ today }}</div>
            </div>
          </div>
          <button
            class="w-9 h-9 flex items-center justify-center rounded-lg border border-line bg-white text-slate-500 hover:bg-surface-2 active:bg-slate-200 disabled:opacity-50 btn-press"
            title="同步刷新"
            :disabled="syncing"
            @click="syncNow"
          >
            <AppIcon name="refresh" :size="16" :class="syncing ? 'animate-spin' : ''" />
          </button>
        </div>
  
        <!-- 今日任务进度条：完成 / 未完成百分比 -->
        <div class="mt-2 lg:mt-3 flex items-center gap-2">
          <div class="flex-1 h-1.5 rounded-full bg-amber-100 overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-300 bg-gradient-to-r from-amber-400 to-orange-500"
              :style="{ width: todayPct + '%' }"
            />
          </div>
          <span class="text-[11px] text-amber-600 tabular-nums shrink-0 font-medium">{{ todayDone }}/{{ filtered.length }} {{ todayPct }}%</span>
        </div>
  
        <div class="mt-4">
          <VueDraggable v-model="dragList" v-bind="dragOptions" item-key="id" class="space-y-2" @start="onDragStart" @end="onDragEnd">
            <TaskCard
              v-for="t in dragList"
              :key="t.id"
              :task="t"
              :project="projectOf(t.projectId)"
              warm
              @edit="openEdit"
              @toggle="onToggle"
              @add-subtask="onAddSubtask"
              @edit-subtask="onEditSubtask"
              @toggle-subtask="onToggleSubtask"
              @remove-subtask="onRemoveSubtask"
              @delete="onDelete"
            />
          </VueDraggable>
          <div v-if="!dragList.length" class="py-16 flex flex-col items-center text-center">
            <span class="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-100 to-orange-100 border border-amber-200 flex items-center justify-center text-amber-500">
              <AppIcon name="calendar" :size="26" />
            </span>
            <div class="mt-3 text-sm font-medium text-slate-500">今天没有任务</div>
            <div class="mt-1 text-xs text-slate-400">点击右下角圆形按钮，开始今天的第一项任务</div>
          </div>
        </div>
  
        <!-- 未来任务：可折叠分组（默认收起），放在已完成下方；分组显隐由最宽窗口（6 个月）决定，
             展开后可筛选 1 / 3 / 6 个月时间窗口（默认 1 个月） -->
        <div v-if="showFutureGroup" class="mt-5 border-t border-amber-100 pt-3">
          <button
            class="w-full flex items-center justify-between py-1.5 text-sm font-medium text-amber-700 hover:text-amber-800 btn-press"
            @click="futureOpen = !futureOpen"
          >
            <span class="flex items-center gap-2">
              <AppIcon name="calendarFuture" :size="16" class="text-amber-500" />
              未来任务
              <span class="text-[11px] font-normal px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-600">{{ futureTasks.length }}</span>
            </span>
            <span class="text-xs text-amber-500/80 flex items-center gap-1">
              {{ futureOpen ? '收起' : '展开' }}
              <AppIcon :name="futureOpen ? 'chevron-up' : 'chevron-down'" :size="13" />
            </span>
          </button>
          <div v-if="futureOpen" class="mt-1.5">
            <!-- 时间筛选：展开后显示，点击弹出 1/3/6 个月选项，选中即时刷新列表 -->
            <div ref="futureMenuEl" class="relative mb-2 flex items-center justify-end">
              <button
                class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 btn-press"
                title="选择未来任务时间范围"
                @click="futureMenuOpen = !futureMenuOpen"
              >
                未来 {{ FUTURE_WINDOW_LABEL[futureWindowMonths] }}
                <AppIcon :name="futureMenuOpen ? 'chevron-up' : 'chevron-down'" :size="11" />
              </button>
              <div
                v-if="futureMenuOpen"
                class="absolute right-0 top-full mt-1 w-36 rounded-xl bg-white shadow-xl ring-1 ring-black/10 py-1 z-50 overflow-hidden"
              >
                <button
                  v-for="m in FUTURE_WINDOW_MONTHS"
                  :key="m"
                  class="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-100 whitespace-nowrap"
                  :class="m === futureWindowMonths ? 'text-amber-700 font-medium' : 'text-slate-700'"
                  @click="selectFutureWindow(m)"
                >
                  {{ FUTURE_WINDOW_LABEL[m] }}
                  <AppIcon v-if="m === futureWindowMonths" name="check" :size="14" class="text-amber-600 shrink-0" />
                </button>
              </div>
            </div>
            <div v-if="futureTasks.length" class="space-y-2">
              <TaskCard
                v-for="ft in futureTasks"
                :key="ft.task.id"
                :task="ft.task"
                :project="projectOf(ft.task.projectId)"
                :future-date="ft.date"
                future
                warm
                @edit="openFutureEdit"
                @toggle="onFutureToggle"
              />
            </div>
            <div v-else class="py-6 text-center text-xs text-slate-400">
              未来 {{ FUTURE_WINDOW_LABEL[futureWindowMonths] }} 内没有未来任务
            </div>
          </div>
        </div>
      </template>
  
      <TaskModal
        v-model:open="modalOpen"
        :task="editing"
        :initial-start="defaultStart"
        :subtask-mode="!!subtaskParent"
        :subtask="editingSubtask"
        :parent-task="subtaskParent"
        :template-master-id="templateMasterId"
        @saved="onSaved"
        @saved-subtask="onSavedSubtask"
        @delete="onDelete"
      />
  
      <ConfirmDialog
        :open="!!deleteTarget"
        title="存入时间胶囊"
        message="确定将该任务存入时间胶囊吗？可在时间胶囊恢复。"
        confirm-text="存入时间胶囊"
        @confirm="confirmDelete"
        @cancel="deleteTarget = null"
      />
    </div>
  </div>
</template>
