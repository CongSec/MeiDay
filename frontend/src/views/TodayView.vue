<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { VueDraggable } from 'vue-draggable-plus'
import { getDragOptions } from '@/utils/drag'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import TaskCard from '@/components/TaskCard.vue'
import TaskModal from '@/components/TaskModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { nowIso, sortByEndTime, toLocalInput, todayKey } from '@/utils/time'
import { isTaskVisibleToday } from '@/utils/todayFilter'
import { UNCATEGORIZED, type Subtask, type Task } from '@/types'
import { safeDetail } from '@/utils/audit'
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
  // 同时加载未分类任务文件（today.json）：无项目导入/新建的任务也应在今日视图可见
  await tasks.loadAllProgressive([...projects.projects.map((p) => p.id), UNCATEGORIZED])
})
onUnmounted(() => {
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
  const pend = filtered.value.filter((t) => t.status === 'pending')
  const done = filtered.value.filter((t) => t.status === 'completed')
  return [...sortByEndTime(pend), ...sortByEndTime(done)]
})

const todayDone = computed(() => filtered.value.filter((t) => t.status === 'completed').length)
/** 今日任务进度：已完成 / 今日可见任务 百分比 */
const todayPct = computed(() =>
  filtered.value.length ? Math.round((todayDone.value / filtered.value.length) * 100) : 0,
)

/** 拖拽用可变列表：初始按时间排序，拖拽后保留手动顺序，仅在任务增删时重排 */
const dragList = ref<Task[]>([])

/** 统一拖拽参数（触屏 fallback 拖拽更丝滑） */
const dragOptions = getDragOptions()

watch(
  filtered,
  () => {
    const next = sorted.value
    const cur = dragList.value
    // 同步合并可能带来「同 id 但内容已更新」的新对象；若仅 id/顺序相同但 updatedAt
    // 已变，也必须刷新 dragList，否则要刷新浏览器才看得到新数据。
    if (
      cur.length === next.length &&
      cur.every((t, i) => t.id === next[i].id && t.updatedAt === next[i].updatedAt)
    )
      return
    const curIds = new Set(cur.map((t) => t.id))
    // 用 next 里的新对象替换 cur 中同 id 的旧对象（保留手动拖拽顺序），新增的排到末尾
    const kept = cur
      .map((t) => next.find((n) => n.id === t.id))
      .filter((t): t is Task => !!t)
    const fresh = next.filter((n) => !curIds.has(n.id))
    const pend = kept.filter((t) => t.status === 'pending')
    const done = kept.filter((t) => t.status === 'completed')
    cur.splice(0, cur.length, ...[...pend, ...sortByEndTime(fresh.filter((t) => t.status === 'pending')), ...done, ...sortByEndTime(fresh.filter((t) => t.status === 'completed'))])
  },
  { immediate: true, deep: true },
)

function onDragEnd() {
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
}

const projectOf = (id: string) => (id ? projects.byId(id) : undefined)

async function openNew() {
  editing.value = null
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

function openEdit(task: Task) {
  editing.value = task
  modalOpen.value = true
}

function onSaved(task: Task) {
  tasks.upsert(task)
  ui.toast('任务已保存')
}

function onToggle(id: string) {
  tasks.toggleComplete(id)
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

function onSavedSubtask(parentTaskId: string, sub: Subtask) {
  const task = tasks.all.find((t) => t.id === parentTaskId)
  if (!task) return
  const idx = task.subtasks.findIndex((s) => s.id === sub.id)
  const isNewSub = idx < 0
  if (idx >= 0) task.subtasks[idx] = sub
  else task.subtasks.push(sub)
  tasks.touchTask(parentTaskId, {
    action: isNewSub ? '新增子任务' : '修改子任务',
    detail: safeDetail(`子任务ID：${sub.id}，所属任务ID：${parentTaskId}`),
  })
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

function confirmDelete() {
  if (deleteTarget.value) tasks.softDelete(deleteTarget.value.id)
  deleteTarget.value = null
  ui.toast('已移入回收站')
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
        <VueDraggable v-model="dragList" v-bind="dragOptions" handle=".task-drag-handle" item-key="id" class="space-y-2" @end="onDragEnd">
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
    </template>

    <TaskModal
      v-model:open="modalOpen"
      :task="editing"
      :initial-start="defaultStart"
      :subtask-mode="!!subtaskParent"
      :subtask="editingSubtask"
      :parent-task="subtaskParent"
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

