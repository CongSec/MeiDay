<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VueDraggable } from 'vue-draggable-plus'
import { getDragOptions, setDragging, beginSubtaskDrop, updateSubtaskDrop, endSubtaskDrop, cancelSubtaskDrop } from '@/utils/drag'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import { useNow } from '@/composables/useNow'
import TaskCard from '@/components/TaskCard.vue'
import TaskModal from '@/components/TaskModal.vue'
import ProjectModal from '@/components/ProjectModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { addMonthsKey } from '@/utils/time'
import { collectFutureVisibleTasks, isProjectTaskActiveToday } from '@/utils/todayFilter'
import AppIcon from '@/components/AppIcon.vue'
import CloudStatus from '@/components/CloudStatus.vue'
import type { Subtask, Task } from '@/types'
import { taskCompleteFeedback, vibrateSubtaskComplete } from '@/utils/taskFeedback'

const route = useRoute()
const router = useRouter()
const projects = useProjectsStore()
const tasks = useTasksStore()
const ui = useUiStore()

const taskModalOpen = ref(false)
const projectModalOpen = ref(false)
const editing = ref<Task | null>(null)
const editingSubtask = ref<Subtask | null>(null)
const subtaskParent = ref<Task | null>(null)
const deleteTarget = ref<Task | null>(null)
const trashProjectOpen = ref(false)

const projectId = computed(() => String(route.params.id))
const project = computed(() => projects.byId(projectId.value))

/** 跨天自动更新的今天日期（与今日任务页同一全局共享时钟）：午夜过后「明天才开始」的任务自动从未来分区移入主列表 */
const { today } = useNow()

/** 主列表（进行中）：未删除 + pending + 重复规则当天活跃 + 开始时间不晚于今天
 *  （明天及以后才开始的任务移入「未来任务」分区，不在项目页主列表直接显示） */
const pending = computed(() => (tasks.tasks[projectId.value] ?? []).filter((t) => t.status === 'pending' && isProjectTaskActiveToday(t, today.value)))
// BUG-13: 已完成任务保留在项目页折叠区，不再“完成即消失”
const completed = computed(() => (tasks.tasks[projectId.value] ?? []).filter((t) => t.status === 'completed'))
const showCompleted = ref(false)

/** 项目进度：已完成 / 总任务 百分比（按顶层任务状态统计；未来开始的任务已移出主列表，不参与统计） */
const totalTasks = computed(() => pending.value.length + completed.value.length)
const progressPct = computed(() =>
  totalTasks.value ? Math.round((completed.value.length / totalTasks.value) * 100) : 0,
)

/** 未来任务分组是否展开（默认收起，与今日任务页一致） */
const futureOpen = ref(false)

/** 未来任务时间窗口档位（自然月）：1 / 3 / 6 个月，默认 1 个月；每次进入页面固定从 1 个月开始，不持久化 */
const FUTURE_WINDOW_MONTHS = [1, 3, 6] as const
const FUTURE_WINDOW_LABEL: Record<number, string> = { 1: '1 个月', 3: '3 个月', 6: '6 个月' }
/** 当前选中的未来任务窗口（月） */
const futureWindowMonths = ref<number>(1)
/** 时间筛选下拉是否展开 */
const futureMenuOpen = ref(false)
const futureMenuEl = ref<HTMLElement | null>(null)
/** 正在编辑的重复模板对应的 master id（非模板编辑为 null） */
const templateMasterId = ref<string | null>(null)
/** 从「未来任务」卡打开编辑时记住对应那一天：存入时间胶囊只删除该天，不碰其它未来日 */
const editFutureDate = ref<string | null>(null)

/** 未来任务（最宽窗口 6 个月扫描）：驱动分组显隐——只要 6 个月内存在未来任务就显示分组，
 *  保证时间筛选按钮始终可点（不会因当前窗口为空而整组消失、陷入死胡同）。
 *  收集逻辑与今日任务页一致（collectFutureVisibleTasks：完整套用今日视图判定规则，
 *  排序主键 = 下次任务出现日严格升序，同日再落提醒 > 开始 > 创建时间链）；
 *  仅扫描当前项目（本项目普通任务 + 本项目重复模板的未来出现）；
 *  额外按对象引用排除主列表已显示的任务（避免同一任务两处重复展示），
 *  重复模板（repeats）的未来出现不属于主列表，不受排除影响。 */
const futureTasksWide = computed(() => {
  const pid = projectId.value
  return collectFutureVisibleTasks(tasks.tasks[pid] ?? [], { [pid]: tasks.repeats[pid] ?? [] }, today.value, 6).filter(
    (x) => !pending.value.includes(x.task),
  )
})

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

const dragList = ref<Task[]>([])

/** 统一拖拽参数（触屏 fallback 拖拽更丝滑） */
const dragOptions = getDragOptions({ wholeCard: true })

watch(
  pending,
  (list) => {
    // 同步合并可能带来「同 id 但内容已更新」的新对象；直接整体替换新数组，
    // 由 VueDraggable 的 v-model 接收（不再原地 splice 共享引用，也省去手动深比较）。
    // 手动拖拽顺序最高优先：按任务 sort 排序，过期任务不再自动置顶（避免覆盖手动顺序）。
    dragList.value = [...list]
  },
  { immediate: true },
)

/** 当前被拖任务 id（@start 记录，@end 判定落点） */
let dragSourceId: string | null = null

function onDragStart(evt?: { oldIndex?: number; item?: HTMLElement | null }) {
  setDragging(true)
  dragSourceId = evt?.oldIndex != null ? dragList.value[evt.oldIndex]?.id ?? null : null
  if (dragSourceId) beginSubtaskDrop(dragSourceId, evt?.item)
}

function onDragMove(evt: { related?: HTMLElement | null; originalEvent?: DragEvent | MouseEvent | TouchEvent | null }): boolean {
  // @move 即 Sortable onMove：永远返回 false → 关闭实时重排（列表静止，配合插入线 + 整卡落点）
  return updateSubtaskDrop(evt)
}

function onDragEnd() {
  setDragging(false)
  const { targetId, insertIndex } = endSubtaskDrop()
  const sourceId = dragSourceId
  dragSourceId = null
  // 落到另一张任务卡上 → 把被拖任务设为该任务的子任务
  if (sourceId && targetId && targetId !== sourceId) {
    const ok = tasks.convertTaskToSubtask(sourceId, targetId, projectId.value)
    if (ok) {
      ui.toast('已设为子任务', 'ok', {
        label: '撤销',
        onClick: () => {
          if (tasks.undoSubtaskConversion()) ui.toast('已撤销，任务已还原')
        },
      })
    }
    return
  }
  // 方向1：无实时重排，按插入线位置手动重排项目待办顺序（已完成任务保持在折叠区尾部）
  if (sourceId && insertIndex >= 0) {
    const srcIdx = dragList.value.findIndex((t) => t.id === sourceId)
    if (srcIdx >= 0) {
      const source = dragList.value[srcIdx]
      let at = insertIndex
      const arr = [...dragList.value]
      arr.splice(srcIdx, 1)
      if (at > srcIdx) at--
      at = Math.max(0, Math.min(at, arr.length))
      arr.splice(at, 0, source)
      const full = tasks.tasks[projectId.value] ?? []
      const done = full.filter((t) => t.status !== 'pending')
      tasks.setOrder(projectId.value, [...arr, ...done])
    }
  }
}

/** 手机端头部「新建任务」由本页注册（随路由切换） */
const mobileActions = inject<
  { newTask: (() => void) | null; title: string } | null
>('mobile-actions', null)

onMounted(async () => {
  document.addEventListener('pointerdown', onDocPointerdown)
  if (mobileActions) {
    mobileActions.newTask = () => openNew()
  }
  if (!projects.loaded) await projects.load()
  tasks.pinViewProject(projectId.value)
  await tasks.loadProject(projectId.value)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocPointerdown)
  setDragging(false)
  cancelSubtaskDrop()
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
  // 统一「编辑任务」后的重复模板同步（与今日任务页同一套逻辑）：定位既有模板走模板编辑流程
  templateMasterId.value = findMasterByTemplateId(task.id)?.id ?? null
  editing.value = task
  // 主任务编辑：退出子任务模式，避免弹窗复用上次编辑的子任务内容
  subtaskParent.value = null
  editingSubtask.value = null
  taskModalOpen.value = true
}

/** 查找某 id 对应的重复模板 master（repeats 中 template.id 匹配，墓碑除外）；非模板返回 undefined */
function findMasterByTemplateId(taskId: string) {
  for (const pid of Object.keys(tasks.repeats)) {
    const m = (tasks.repeats[pid] ?? []).find((x) => !x.deletedAt && x.template.id === taskId)
    if (m) return m
  }
  return undefined
}

/** 未来任务卡编辑：记录该卡对应的未来日期，存入时间胶囊时只处理那一天 */
function openFutureEdit(task: Task) {
  const ft = futureTasks.value.find((x) => x.task.id === task.id)
  openEdit(task)
  editFutureDate.value = ft?.date ?? null
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
  const t = tasks.all.find((x) => x.id === taskId)
  const sub = t?.subtasks?.find((s) => s.id === subId)
  const completing = !!sub && !sub.completed
  tasks.toggleSubtask(taskId, subId)
  if (completing) void vibrateSubtaskComplete()
}

function onRemoveSubtask(taskId: string, subId: string) {
  tasks.removeSubtaskFrom(taskId, subId)
}

function onPromoteSubtask(parent: Task, sub: Subtask) {
  const ok = tasks.promoteSubtaskToTask(parent.id, sub.id, projectId.value)
  if (ok) ui.toast('已提升为主任务')
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
  if (ok) ui.toast('项目已存入时间胶囊，可在时间胶囊恢复')
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  const t = deleteTarget.value
  // 确认按钮前端立即生效：关弹窗；保存结果由回显后的 toast 提示
  deleteTarget.value = null
  // 统一走「存入时间胶囊」入口：主列表任务缺省删「今天」对应那一天；
  // 未来任务卡记得对应未来日期，只把那一天存入时间胶囊（重复任务只删单日）
  const ok = await tasks.deleteFutureTaskConfirmed(t.id, editFutureDate.value ?? undefined)
  editFutureDate.value = null
  if (ok) ui.toast('已存入时间胶囊')
}
</script>

<template>
  <div class="p-4 sm:p-6 max-w-3xl mx-auto">
    <template v-if="project">
      <!-- 顶部进度条：任务完成 / 未完成百分比（替换原来的纯色横线） -->
      <div class="flex items-center gap-2">
        <div class="flex-1 h-1.5 rounded-full bg-surface-2 overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-300"
            :style="{ width: progressPct + '%', backgroundColor: project.color }"
          />
        </div>
        <span class="text-[11px] text-slate-400 tabular-nums shrink-0">{{ completed.length }}/{{ totalTasks }} {{ progressPct }}%</span>
      </div>

      <!-- 桌面标题行：项目名（颜色标识）+ 编辑/移入回收站 + 同步（新建任务在右下角悬浮按钮） -->
      <div class="mt-3 hidden lg:flex items-center justify-between">
        <div class="flex items-center gap-3">
          <span class="w-2.5 h-2.5 rounded-full shrink-0" :style="{ backgroundColor: project.color }" />
          <h1 class="text-xl font-bold text-slate-800">{{ project.name }}</h1>
          <button
            class="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-brand btn-press"
            title="编辑项目"
            @click="projectModalOpen = true"
          >
            <AppIcon name="edit" :size="13" />
          </button>
          <button
            class="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 btn-press"
            title="存入时间胶囊：项目及其任务存入其中，可恢复整个项目"
            @click="askTrashProject"
          >
            <AppIcon name="trash" :size="13" />
          </button>
        </div>
        <CloudStatus />
      </div>

      <!-- 手机端紧凑行：编辑 / 移入回收站（项目名已上移到头部显示） -->
      <div class="mt-1 flex items-center gap-2 lg:hidden">
        <button
          class="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-brand"
          title="编辑项目"
          @click="projectModalOpen = true"
        >
          <AppIcon name="edit" :size="13" />
        </button>
        <button
          class="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50"
          title="存入时间胶囊"
          @click="askTrashProject"
        >
          <AppIcon name="trash" :size="13" />
        </button>
      </div>

      <div class="mt-4">
        <VueDraggable v-model="dragList" v-bind="dragOptions" item-key="id" class="drag-list space-y-2" @start="onDragStart" @move="onDragMove" @end="onDragEnd">
          <TaskCard
            v-for="t in dragList"
            :key="t.id"
            :task="t"
            :project="project"
            @edit="openEdit"
            @toggle="onToggle"
            @edit-subtask="onEditSubtask"
            @toggle-subtask="onToggleSubtask"
            @remove-subtask="onRemoveSubtask"
            @promote-subtask="onPromoteSubtask"
            @delete="onDelete"
          />
        </VueDraggable>
        <div v-if="!pending.length" class="py-16 flex flex-col items-center text-center">
          <span class="w-14 h-14 rounded-2xl bg-white border border-line shadow-card flex items-center justify-center text-slate-300">
            <AppIcon name="check-circle" :size="26" />
          </span>
          <div class="mt-3 text-sm font-medium text-slate-500">暂无进行中的任务</div>
          <div class="mt-1 text-xs text-slate-400">点击右下角圆形按钮添加任务</div>
        </div>

        <!-- BUG-13: 已完成任务折叠区，保证“完成即消失”不再发生 -->
        <div v-if="completed.length" class="mt-6">
          <button
            class="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 btn-press"
            @click="showCompleted = !showCompleted"
          >
            <AppIcon :name="showCompleted ? 'chevron-down' : 'chevron-right'" :size="15" />
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
              @edit-subtask="onEditSubtask"
              @toggle-subtask="onToggleSubtask"
              @remove-subtask="onRemoveSubtask"
              @promote-subtask="onPromoteSubtask"
              @delete="onDelete"
            />
          </div>
        </div>

        <!-- 未来任务：可折叠分组（默认收起），放在已完成下方；分组显隐由最宽窗口（6 个月）决定，
              展开后可筛选 1 / 3 / 6 个月时间窗口（默认 1 个月）；
              头部展开/折叠样式与「已完成」折叠区一致，配色沿用项目页原有色系（不套用今日页的琥珀黄） -->
        <div v-if="showFutureGroup" class="mt-6">
          <button
            class="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 btn-press"
            @click="futureOpen = !futureOpen"
          >
            <AppIcon :name="futureOpen ? 'chevron-down' : 'chevron-right'" :size="15" />
            <span>未来任务（{{ futureTasks.length }}）</span>
          </button>
          <div v-if="futureOpen" class="mt-2">
            <!-- 时间筛选：展开后显示，点击弹出 1/3/6 个月选项，选中即时刷新列表 -->
            <div ref="futureMenuEl" class="relative mb-2 flex items-center justify-end">
              <button
                class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 bg-slate-50 border border-slate-200 hover:bg-slate-100 btn-press"
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
                  :class="m === futureWindowMonths ? 'text-slate-800 font-medium' : 'text-slate-700'"
                  @click="selectFutureWindow(m)"
                >
                  {{ FUTURE_WINDOW_LABEL[m] }}
                  <AppIcon v-if="m === futureWindowMonths" name="check" :size="14" class="text-slate-600 shrink-0" />
                </button>
              </div>
            </div>
            <div v-if="futureTasks.length" class="space-y-2">
              <TaskCard
                v-for="ft in futureTasks"
                :key="ft.task.id"
                :task="ft.task"
                :project="project"
                future
                @edit="openFutureEdit"
                @toggle="onFutureToggle"
              />
            </div>
            <div v-else class="py-6 text-center text-xs text-slate-400">
              未来 {{ FUTURE_WINDOW_LABEL[futureWindowMonths] }} 内没有未来任务
            </div>
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
      :template-master-id="templateMasterId"
      @saved="onSaved"
      @saved-subtask="onSavedSubtask"
      @delete="onDelete"
    />
    <ProjectModal v-model:open="projectModalOpen" :project-id="projectId" />
    <ConfirmDialog
      :open="!!deleteTarget"
      title="存入时间胶囊"
      message="确定将该任务存入时间胶囊吗？可在时间胶囊恢复。"
      confirm-text="存入时间胶囊"
      confirm-icon="trash"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
    <ConfirmDialog
      :open="trashProjectOpen"
      title="存入时间胶囊"
      message="项目及其下所有任务将存入时间胶囊，可在时间胶囊「恢复整个项目」。确定存入时间胶囊吗？"
      confirm-text="存入时间胶囊"
      confirm-icon="trash"
      :danger="true"
      @confirm="confirmTrashProject"
      @cancel="trashProjectOpen = false"
    />
  </div>
</template>
