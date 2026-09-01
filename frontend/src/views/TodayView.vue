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
import { dateKeyOf, nowIso, toLocalInput, todayKey } from '@/utils/time'
import { isFutureTask, isTaskVisibleToday } from '@/utils/todayFilter'
import { UNCATEGORIZED, type Subtask, type Task } from '@/types'
import { useSync } from '@/composables/useSync'

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

/** 手机端头部「新建任务」由本页注册（随路由切换） */
const mobileActions = inject<
  { newTask: (() => void) | null; title: string } | null
>('mobile-actions', null)

const MOBILE_TITLE = '今日任务'
onMounted(async () => {
  if (mobileActions) {
    mobileActions.newTask = () => openNew()
    mobileActions.title = MOBILE_TITLE
  }
  if (!projects.loaded) await projects.load()
  // 先从本地 IDB 恢复缓存（不访问 OSS）判断哪些项目今日有任务；未分类(today.json)一并纳入。
  // 本地缓存不完整（全新设备/首次进入）时，无法判断哪些项目今日有任务：必须全量加载
  // 所有项目的任务文件（渐进分批），否则今日视图首次进入为空，只有手动点开项目才拉取
  // 数据（跨设备新增的今日任务也会一直不出现）。
  // 已有完整缓存时只刷「今日相关」项目 + 未分类，避免重复进入时全量下载几百个项目的
  // tasks/trash/repeats 数据包（OSS 请求/内存风暴）。
  const allIds = [...projects.projects.map((p) => p.id), UNCATEGORIZED]
  const cachedIds = await tasks.loadFromIdb(allIds)
  const fullyCached = allIds.every((id) => cachedIds.includes(id))
  const todayIds = tasks.todayRelevantProjectIds(allIds)
  const toLoad = fullyCached ? [...new Set([UNCATEGORIZED, ...todayIds])] : allIds
  await tasks.loadAllProgressive(toLoad)
})
onUnmounted(() => {
  setDragging(false)
  if (mobileActions) {
    mobileActions.newTask = null
    if (mobileActions.title === MOBILE_TITLE) mobileActions.title = ''
  }
})

const today = todayKey()
const filtered = computed(() => {
  const list = tasks.all
  return list.filter((t) => isTaskVisibleToday(t, today))
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

/** 未来任务：开始时间在未来的待办 + 重复任务的下一次出现（不限多远都展示）。
 *  截止日期（endTime）在未来但尚未到期的任务不算未来任务。 */
const futureTasks = computed(() => {
  const out: { task: Task; date: string }[] = []
  for (const t of tasks.all) {
    if (isFutureTask(t, today)) out.push({ task: t, date: t.startTime ? dateKeyOf(t.startTime) : '' })
  }
  for (const pid of Object.keys(tasks.repeats)) {
    for (const m of tasks.repeats[pid] ?? []) {
      if (m.dueDate > today) out.push({ task: m.template, date: m.dueDate })
    }
  }
  // 同一任务只展示一次；按出现日期升序
  const seen = new Set<string>()
  return out
    .filter((x) => {
      if (seen.has(x.task.id)) return false
      seen.add(x.task.id)
      return true
    })
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
})

/** 拖拽用可变列表：初始按时间排序，拖拽后保留手动顺序，仅在任务增删时重排 */
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
    if (isTaskVisibleToday(t, today)) key += `${t.id}:${t.status}:${t.updatedAt}\n`
  }
  return key
})

watch(
  [visibleKey, () => tasks.todayOrder],
  () => {
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

/** 查找某 id 对应的重复模板 master（repeats 中 template.id 匹配）；非模板返回 undefined */
function findMasterByTemplateId(taskId: string) {
  for (const pid of Object.keys(tasks.repeats)) {
    const m = (tasks.repeats[pid] ?? []).find((x) => x.template.id === taskId)
    if (m) return m
  }
  return undefined
}

function openEdit(task: Task) {
  templateMasterId.value = findMasterByTemplateId(task.id)?.id ?? null
  editing.value = task
  // 主任务编辑：退出子任务模式，避免弹窗复用上次编辑的子任务内容
  subtaskParent.value = null
  editingSubtask.value = null
  modalOpen.value = true
}

function onSaved() {
  ui.toast('任务已保存')
}

async function onToggle(id: string) {
  const t = tasks.all.find((x) => x.id === id)
  const completing = !!t && t.status !== 'completed'
  const ok = await tasks.toggleCompleteConfirmed(id)
  if (!ok) return
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
  tasks.toggleSubtask(taskId, subId)
}

function onRemoveSubtask(taskId: string, subId: string) {
  tasks.removeSubtaskFrom(taskId, subId)
}

function onDelete(id: string) {
  const t = tasks.all.find((x) => x.id === id)
  if (t) deleteTarget.value = t
}

/** 未来任务删除：普通未来任务或重复模板未来出现，统一解析后移入回收站。
 *  未来卡片可能来自重复模板（不在 tasks.all），仅记录 id，删除逻辑由 store 内部解析。 */
function onFutureDelete(id: string) {
  deleteTarget.value = (tasks.all.find((x) => x.id === id) ?? { id }) as Task
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  const t = deleteTarget.value
  // 确认按钮前端立即生效：关弹窗；保存结果由回显后的 toast 提示
  deleteTarget.value = null
  const ok = await tasks.deleteFutureTaskConfirmed(t.id)
  if (ok) ui.toast('已移入回收站')
}
</script>

<template>
  <div class="p-4 sm:p-6 max-w-3xl mx-auto">
    <div v-if="!auth.hasCreds" class="py-16 text-center">
      <div class="text-6xl">🗄️</div>
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
      <!-- 桌面标题行：今日任务 + 日期 + 操作按钮（手机端已上移到头部显示） -->
      <div class="hidden lg:flex items-center justify-between">
        <div>
          <h1 class="text-xl font-bold text-slate-800">📅 今日任务</h1>
          <div class="text-xs text-slate-400 mt-0.5">{{ nowIso().slice(0, 10) }}</div>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="w-9 h-9 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 active:bg-slate-100 disabled:opacity-50"
            title="同步刷新"
            :disabled="syncing"
            @click="syncNow"
          >
            <span class="text-sm leading-none" :class="syncing ? 'inline-block animate-spin' : ''">⟳</span>
          </button>
          <button
            class="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-dark"
            @click="openNew"
          >
            ＋ 新建任务
          </button>
        </div>
      </div>

      <!-- 今日任务进度条：完成 / 未完成百分比 -->
      <div class="mt-2 lg:mt-3 flex items-center gap-2">
        <div class="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-300 bg-brand"
            :style="{ width: todayPct + '%' }"
          />
        </div>
        <span class="text-[11px] text-slate-400 tabular-nums shrink-0">{{ todayDone }}/{{ filtered.length }} {{ todayPct }}%</span>
      </div>

      <div class="mt-4">
        <VueDraggable v-model="dragList" v-bind="dragOptions" item-key="id" class="space-y-2" @start="onDragStart" @end="onDragEnd">
          <TaskCard
            v-for="t in dragList"
            :key="t.id"
            :task="t"
            :project="projectOf(t.projectId)"
            @edit="openEdit"
            @toggle="onToggle"
            @add-subtask="onAddSubtask"
            @edit-subtask="onEditSubtask"
            @toggle-subtask="onToggleSubtask"
            @remove-subtask="onRemoveSubtask"
            @delete="onDelete"
          />
        </VueDraggable>
        <div v-if="!dragList.length" class="py-16 text-center text-sm text-slate-400">
          今天没有任务，点右上角「＋ 新建任务」
        </div>
      </div>

      <!-- 未来任务：可折叠分组（默认收起），放在已完成下方，不限时间范围 -->
      <div v-if="futureTasks.length" class="mt-5 border-t border-slate-100 pt-3">
        <button
          class="w-full flex items-center justify-between py-1.5 text-sm font-medium text-slate-500 hover:text-slate-700"
          @click="futureOpen = !futureOpen"
        >
          <span>🗓 未来任务（{{ futureTasks.length }}）</span>
          <span class="text-xs text-slate-400">{{ futureOpen ? '收起 ▴' : '展开 ▾' }}</span>
        </button>
        <div v-if="futureOpen" class="mt-1.5 space-y-2">
          <TaskCard
            v-for="ft in futureTasks"
            :key="ft.task.id"
            :task="ft.task"
            :project="projectOf(ft.task.projectId)"
            future
            @edit="openEdit"
            @delete="onFutureDelete"
          />
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
      title="移入回收站"
      message="确定将该任务移入回收站吗？可在回收站恢复。"
      confirm-text="移入回收站"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
  </div>
</template>
