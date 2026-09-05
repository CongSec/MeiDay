<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VueDraggable } from 'vue-draggable-plus'
import { getDragOptions, setDragging } from '@/utils/drag'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import TaskCard from '@/components/TaskCard.vue'
import TaskModal from '@/components/TaskModal.vue'
import ProjectModal from '@/components/ProjectModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import type { Subtask, Task } from '@/types'
import { useSync } from '@/composables/useSync'

const route = useRoute()
const router = useRouter()
const projects = useProjectsStore()
const tasks = useTasksStore()
const ui = useUiStore()
const { syncing, syncNow } = useSync()

const taskModalOpen = ref(false)
const projectModalOpen = ref(false)
const editing = ref<Task | null>(null)
const editingSubtask = ref<Subtask | null>(null)
const subtaskParent = ref<Task | null>(null)
const deleteTarget = ref<Task | null>(null)
const trashProjectOpen = ref(false)

const projectId = computed(() => String(route.params.id))
const project = computed(() => projects.byId(projectId.value))

const pending = computed(() => (tasks.tasks[projectId.value] ?? []).filter((t) => t.status === 'pending'))
// BUG-13: 已完成任务保留在项目页折叠区，不再“完成即消失”
const completed = computed(() => (tasks.tasks[projectId.value] ?? []).filter((t) => t.status === 'completed'))
const showCompleted = ref(false)

/** 项目进度：已完成 / 总任务 百分比（按顶层任务状态统计） */
const totalTasks = computed(() => pending.value.length + completed.value.length)
const progressPct = computed(() =>
  totalTasks.value ? Math.round((completed.value.length / totalTasks.value) * 100) : 0,
)

const dragList = ref<Task[]>([])

/** 统一拖拽参数（触屏 fallback 拖拽更丝滑） */
const dragOptions = getDragOptions({ wholeCard: true })

watch(
  pending,
  (list) => {
    // 同步合并可能带来「同 id 但内容已更新」的新对象；直接整体替换新数组，
    // 由 VueDraggable 的 v-model 接收（不再原地 splice 共享引用，也省去手动深比较）。
    dragList.value = [...list]
  },
  { immediate: true },
)

function onDragStart() {
  setDragging(true)
}

function onDragEnd() {
  setDragging(false)
  const full = tasks.tasks[projectId.value] ?? []
  const done = full.filter((t) => t.status !== 'pending')
  tasks.setOrder(projectId.value, [...dragList.value, ...done])
}

/** 手机端头部「新建任务」由本页注册（随路由切换） */
const mobileActions = inject<
  { newTask: (() => void) | null; title: string } | null
>('mobile-actions', null)

onMounted(async () => {
  if (mobileActions) {
    mobileActions.newTask = () => openNew()
  }
  if (!projects.loaded) await projects.load()
  tasks.pinViewProject(projectId.value)
  await tasks.loadProject(projectId.value)
})
onUnmounted(() => {
  setDragging(false)
  tasks.unpinViewProject(projectId.value)
  if (mobileActions) {
    mobileActions.newTask = null
    if (mobileActions.title === mobileTitle) mobileActions.title = ''
  }
})

// 同一项目页组件被复用时（项目 A -> 项目 B 直接切换），重新固定并加载新项目
watch(projectId, (id, oldId) => {
  if (oldId) tasks.unpinViewProject(oldId)
  tasks.pinViewProject(id)
  void tasks.loadProject(id)
})

/** 手机端头部标题跟随项目名（重命名后同步更新） */
/** 当前视图设置过的标题：仅当头部标题仍等于它时才清除，避免被其他视图的卸载钩子误清 */
let mobileTitle = ''
watch(
  () => project.value?.name ?? '',
  (name) => {
    mobileTitle = name
    if (mobileActions) mobileActions.title = name
  },
  { immediate: true },
)

async function openNew() {
  editing.value = null
  subtaskParent.value = null
  editingSubtask.value = null
  taskModalOpen.value = true
  try {
    await projects.ensureLoaded()
  } catch (e) {
    ui.toast((e as Error).message || '项目加载失败，请检查网络或 OSS 配置', 'error')
  }
}

function openEdit(task: Task) {
  editing.value = task
  // 主任务编辑：退出子任务模式，避免弹窗复用上次编辑的子任务内容
  subtaskParent.value = null
  editingSubtask.value = null
  taskModalOpen.value = true
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
  taskModalOpen.value = true
}

function onEditSubtask(task: Task, sub: Subtask) {
  subtaskParent.value = task
  editingSubtask.value = sub
  taskModalOpen.value = true
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

function askTrashProject() {
  trashProjectOpen.value = true
}

async function confirmTrashProject() {
  if (!project.value) return
  const p = project.value
  // 确认按钮前端立即生效：关弹窗 + 跳转；保存结果由回显后的 toast 提示
  trashProjectOpen.value = false
  router.push('/today')
  const ok = await projects.deleteProject(p.id)
  if (ok) ui.toast('项目已移入回收站，可在回收站恢复')
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  const t = deleteTarget.value
  // 确认按钮前端立即生效：关弹窗；保存结果由回显后的 toast 提示
  deleteTarget.value = null
  const ok = await tasks.softDeleteConfirmed(t.id)
  if (ok) ui.toast('已移入回收站')
}
</script>

<template>
  <div class="p-4 sm:p-6 max-w-3xl mx-auto">
    <template v-if="project">
      <!-- 顶部进度条：任务完成 / 未完成百分比（替换原来的纯色横线） -->
      <div class="flex items-center gap-2">
        <div class="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-300"
            :style="{ width: progressPct + '%', backgroundColor: project.color }"
          />
        </div>
        <span class="text-[11px] text-slate-400 tabular-nums shrink-0">{{ completed.length }}/{{ totalTasks }} {{ progressPct }}%</span>
      </div>

      <!-- 桌面标题行：项目名 + 编辑/移入回收站 + 操作按钮 -->
      <div class="mt-3 hidden lg:flex items-center justify-between">
        <div class="flex items-center gap-2">
          <h1 class="text-xl font-bold text-slate-800">{{ project.name }}</h1>
          <button class="text-xs text-slate-400 hover:text-brand" @click="projectModalOpen = true">✎ 编辑</button>
          <button
            class="text-xs text-slate-400 hover:text-red-500"
            title="移入回收站：项目及其任务进入回收站，可恢复整个项目"
            @click="askTrashProject"
          >
            🗑 移入回收站
          </button>
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

      <!-- 手机端紧凑行：编辑 / 移入回收站（项目名已上移到头部显示） -->
      <div class="mt-1 flex items-center gap-2 lg:hidden">
        <button class="text-[11px] text-slate-400 hover:text-brand" @click="projectModalOpen = true">✎ 编辑</button>
        <button
          class="text-[11px] text-slate-400 hover:text-red-500"
          title="移入回收站"
          @click="askTrashProject"
        >
          🗑 移入回收站
        </button>
      </div>

      <div class="mt-4">
        <VueDraggable v-model="dragList" v-bind="dragOptions" item-key="id" class="space-y-2" @start="onDragStart" @end="onDragEnd">
          <TaskCard
            v-for="t in dragList"
            :key="t.id"
            :task="t"
            :project="project"
            @edit="openEdit"
            @toggle="onToggle"
            @add-subtask="onAddSubtask"
            @edit-subtask="onEditSubtask"
            @toggle-subtask="onToggleSubtask"
            @remove-subtask="onRemoveSubtask"
            @delete="onDelete"
          />
        </VueDraggable>
        <div v-if="!pending.length" class="py-16 text-center text-sm text-slate-400">
          该项目暂无进行中的任务
        </div>

        <!-- BUG-13: 已完成任务折叠区，保证“完成即消失”不再发生 -->
        <div v-if="completed.length" class="mt-6">
          <button
            class="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700"
            @click="showCompleted = !showCompleted"
          >
            <span class="w-4 text-center">{{ showCompleted ? '▾' : '▸' }}</span>
            <span>已完成（{{ completed.length }}）</span>
          </button>
          <div v-if="showCompleted" class="mt-2 space-y-2">
            <TaskCard
              v-for="t in completed"
              :key="t.id"
              :task="t"
              :project="project"
              @edit="openEdit"
              @toggle="onToggle"
              @add-subtask="onAddSubtask"
              @edit-subtask="onEditSubtask"
              @toggle-subtask="onToggleSubtask"
              @remove-subtask="onRemoveSubtask"
              @delete="onDelete"
            />
          </div>
        </div>
      </div>
    </template>
    <div v-else class="py-16 text-center text-sm text-slate-400">项目不存在或已删除</div>

    <TaskModal
      v-model:open="taskModalOpen"
      :project-id="projectId"
      :task="editing"
      :subtask-mode="!!subtaskParent"
      :subtask="editingSubtask"
      :parent-task="subtaskParent"
      @saved="onSaved"
      @saved-subtask="onSavedSubtask"
      @delete="onDelete"
    />
    <ProjectModal v-model:open="projectModalOpen" :project-id="projectId" />
    <ConfirmDialog
      :open="!!deleteTarget"
      title="移入回收站"
      message="确定将该任务移入回收站吗？可在回收站恢复。"
      confirm-text="移入回收站"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
    <ConfirmDialog
      :open="trashProjectOpen"
      title="移入回收站"
      message="项目及其下所有任务将移入回收站，可在回收站「恢复整个项目」。确定移入回收站吗？"
      confirm-text="移入回收站"
      :danger="true"
      @confirm="confirmTrashProject"
      @cancel="trashProjectOpen = false"
    />
  </div>
</template>
