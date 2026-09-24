<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useNow } from '@/composables/useNow'
import { dateKeyOf, formatTodayTitle, todayKey } from '@/utils/time'
import { formatRepeat, isNewStyleRepeat, isRepeatDay } from '@/utils/repeat'
import type { Project, Subtask, Task } from '@/types'
import { VueDraggable } from 'vue-draggable-plus'
import { getDragOptions, setDragging } from '@/utils/drag'
import { useTasksStore } from '@/stores/tasks'
import { sortSubtasks } from '@/utils/task'
import AppIcon from '@/components/AppIcon.vue'

const props = defineProps<{ task: Task; project?: Project; future?: boolean; warm?: boolean; futureDate?: string }>()
const emit = defineEmits<{
  edit: [Task]
  toggle: [string]
  delete: [string]
  addSubtask: [Task]
  editSubtask: [Task, Subtask]
  toggleSubtask: [taskId: string, subId: string]
  removeSubtask: [taskId: string, subId: string]
}>()

const auth = useAuthStore()
const tasks = useTasksStore()

// 全局共享时钟（单一 30s 定时器，替代每个卡片各自 setInterval）
const { now } = useNow()

const overdue = computed(() => {
  if (props.task.status !== 'pending' || !props.task.reminderTime) return false
  const rule = props.task.repeat
  // 新模型重复任务：仅在「重复日」当天且已过提醒时刻才提示“已过提醒时间”；
  // 非重复日不提示，避免与“任务只在重复日当天出现/提醒”的语义冲突。
  if (rule && isNewStyleRepeat(rule) && rule.start) {
    const today = todayKey()
    if (rule.endAfter && today > rule.endAfter) return false
    if (!(today >= rule.start && isRepeatDay(rule, rule.start, today))) return false
  }
  return new Date(props.task.reminderTime).getTime() <= now.value
})


/** 今日任务视图的暖色主色调：true 时卡片使用琥珀/橙色系强调，项目页保持品牌蓝不变 */
const warm = computed(() => !!props.warm)

const hasSubtasks = computed(() => (props.task.subtasks?.length ?? 0) > 0)

/** 展开/折叠状态按 用户+任务 记忆到 localStorage（登出换账号互不干扰） */
const expandedKey = computed(() => `st_subtask_open:${auth.username}:${props.task.id}`)
const expanded = ref(localStorage.getItem(expandedKey.value) === '1')
watch(expanded, (v) => {
  if (v) localStorage.setItem(expandedKey.value, '1')
  else localStorage.removeItem(expandedKey.value)
})

/** 子任务进度：done/total（无子任务时不显示） */
const subProgress = computed(() => {
  const subs = props.task.subtasks ?? []
  if (!subs.length) return null
  return { done: subs.filter((s) => s.completed).length, total: subs.length }
})

/** 提醒时间显示：当天只显示「时:分」，非当天显示「月-日 时:分」 */
function timeStr(t: string) {
  return dateKeyOf(t) === todayKey() ? formatTodayTitle(t).slice(6) : formatTodayTitle(t)
}

function dateStr(t: string) {
  return t.slice(5, 10)
}

/** 未来任务「下一次出现」标签：MM-DD 周X（如 09-29 周二） */
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const futureDateLabel = computed(() => {
  if (!props.futureDate) return ''
  const wd = new Date(`${props.futureDate}T00:00:00+08:00`).getDay()
  return `${props.futureDate.slice(5, 10)} ${WEEKDAY_NAMES[wd]}`
})

/** 子任务是否已过提醒时间（未完成） */
function subOverdue(s: Subtask) {
  return !s.completed && !!s.reminderTime && new Date(s.reminderTime).getTime() <= now.value
}

function onAddSubtask() {
  expanded.value = true
  emit('addSubtask', props.task)
}

/** 子任务本地排序副本：进入/新增/同步合并时按「提醒 > 开始 > 更新时间」自动排序；
 *  拖拽过即写入 sort 手动顺序优先，新子任务无 sort 自动补末尾（与主任务拖拽语义一致） */
const subDragList = ref<Subtask[]>([])
watch(
  () => [props.task.subtasks, props.task.updatedAt],
  () => {
    subDragList.value = sortSubtasks(props.task.subtasks ?? [])
  },
  { immediate: true },
)
/** 子任务拖拽参数：仅手柄可拖（与整卡拖拽互不干扰） */
const subDragOptions = { ...getDragOptions({ wholeCard: false }), handle: '.sub-drag-handle' }

function onSubDragStart() {
  setDragging(true)
}

function onSubDragEnd() {
  setDragging(false)
  tasks.setSubtaskOrder(props.task.projectId, props.task.id, subDragList.value)
}
</script>

<template>
  <div
    class="task-card group bg-white rounded-xl shadow-card border border-line p-4 transition hover:shadow-lift"
    :class="[
      warm ? 'hover:border-amber-300' : 'hover:border-slate-200',
      overdue ? 'border-l-4 border-l-red-500' : '',
      task.status === 'completed' ? 'opacity-70' : '',
    ]"
    @click="emit('edit', task)"
  >
    <div class="flex items-start gap-3">
      <label class="pt-0.5 shrink-0 cursor-pointer select-none" :title="future ? '提前完成该任务' : '标记完成 / 取消完成'" @click.stop>
        <input
          type="checkbox"
          class="sr-only"
          :checked="task.status === 'completed'"
          @change="emit('toggle', task.id)"
        />
        <span
          class="w-5 h-5 rounded-md border flex items-center justify-center transition-all duration-150"
          :class="task.status === 'completed'
            ? (warm ? 'bg-amber-500 border-amber-500 text-white' : 'bg-brand border-brand text-white')
            : (warm ? 'border-slate-300 bg-white text-transparent hover:border-amber-400 hover:bg-amber-500/5' : 'border-slate-300 bg-white text-transparent hover:border-brand hover:bg-brand/5')"
        >
          <AppIcon name="check" :size="13" :stroke-width="2.5" />
        </span>
      </label>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <button
            v-if="hasSubtasks && !future"
            class="shrink-0 w-6 h-6 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 hover:text-slate-800 flex items-center justify-center text-base leading-none"
            :title="expanded ? '折叠子任务' : '展开子任务'"
            @click.stop="expanded = !expanded"
          >
            <AppIcon :name="expanded ? 'chevron-down' : 'chevron-right'" :size="14" />
          </button>
          <span
            class="font-medium text-sm"
            :class="task.status === 'completed' ? 'line-through text-slate-400' : 'text-slate-800'"
          >
            {{ task.name || '未命名任务' }}
          </span>
          <span
            v-if="future"
            class="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-600 font-medium shrink-0"
            title="开始时间在未来"
          >
            未来
          </span>
          <span v-if="overdue" class="text-red-500" title="已过提醒时间"><AppIcon name="bell" :size="15" /></span>
        </div>
        <p v-if="task.description" class="mt-1 text-xs text-slate-500 clamp-2">{{ task.description }}</p>
        <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-slate-400">
          <span v-if="futureDate" class="inline-flex items-center gap-1" :class="warm ? 'text-amber-600' : 'text-brand/90'" title="下一次出现时间">
            <AppIcon name="calendarFuture" :size="12" />下次 {{ futureDateLabel }}
          </span>
          <template v-else>
            <span v-if="task.startTime" class="inline-flex items-center gap-1">
              <AppIcon name="calendar" :size="12" />{{ dateStr(task.startTime) }}
            </span>
            <span v-if="task.endTime" class="inline-flex items-center gap-1">
              <AppIcon name="clock" :size="12" />{{ dateStr(task.endTime) }}
            </span>
          </template>
          <span v-if="task.reminderTime" class="inline-flex items-center gap-1">
            <AppIcon name="bell" :size="12" />{{ timeStr(task.reminderTime) }}
          </span>
          <span v-if="task.repeat" class="inline-flex items-center gap-1" :class="warm ? 'text-amber-600' : 'text-brand/90'" :title="`重复任务：${formatRepeat(task.repeat)}`">
            <AppIcon name="repeat" :size="12" />{{ formatRepeat(task.repeat) }}
          </span>
          <span
            v-if="(task.attachments?.length ?? 0) > 0"
            class="inline-flex items-center gap-1 cursor-pointer"
            :class="warm ? 'text-amber-600' : 'text-brand/80'"
            :title="`${task.attachments.length} 个附件，点击打开查看/预览`"
            @click.stop="emit('edit', task)"
          >
            <AppIcon name="paperclip" :size="12" />{{ task.attachments.length }}
          </span>
        </div>
      </div>
      <button
        v-if="!future"
        class="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg border btn-press"
        :class="warm ? 'border-amber-300 text-amber-600 hover:bg-amber-500/5 hover:border-amber-400' : 'border-brand/30 text-brand hover:bg-brand/5 hover:border-brand/50'"
        title="添加子任务"
        @click.stop="onAddSubtask"
      >
        <AppIcon name="plus" :size="15" />
      </button>
    </div>

    <!-- 子任务进度条：与主任务框同宽对齐 -->
    <div v-if="subProgress" class="mt-2">
      <div class="flex items-center gap-2 text-[11px] text-slate-400">
        <span class="inline-flex items-center gap-1"><AppIcon name="check-circle" :size="12" />子任务 {{ subProgress.done }}/{{ subProgress.total }}</span>
      </div>
      <div class="mt-1 h-1 rounded-full bg-slate-100 overflow-hidden">
        <div
          class="h-full rounded-full transition-all"
          :class="subProgress.done === subProgress.total ? 'bg-emerald-500' : (warm ? 'bg-amber-500' : 'bg-brand')"
          :style="{ width: `${(subProgress.done / subProgress.total) * 100}%` }"
        />
      </div>
    </div>

    <!-- 展开后显示子任务（全宽展示，新增/编辑走弹窗） -->
    <div v-if="expanded && hasSubtasks && !future" class="mt-3 border-t border-slate-100 pt-2" @click.stop>
      <div class="flex items-center justify-between mb-2">
        <span class="text-[11px] font-medium text-slate-400">子任务明细</span>
        <button
          class="text-[11px] px-2 py-0.5 rounded-md font-medium"
          :class="warm ? 'text-amber-600 hover:bg-amber-500/5' : 'text-brand hover:bg-brand/5'"
          title="添加子任务"
          @click="onAddSubtask"
        >
          <span class="inline-flex items-center gap-1"><AppIcon name="plus" :size="11" />添加子任务</span>
        </button>
      </div>
      <VueDraggable v-model="subDragList" v-bind="subDragOptions" item-key="id" class="space-y-1.5" @start="onSubDragStart" @end="onSubDragEnd">
        <div
          v-for="s in subDragList"
          :key="s.id"
          class="group/sub rounded-lg border border-slate-100 bg-slate-50/70 px-2.5 py-2 transition hover:border-slate-200"
          :class="s.completed ? 'opacity-75' : ''"
        >
          <div class="flex items-center gap-2">
            <label class="shrink-0 cursor-pointer select-none" title="标记完成" @click.stop>
              <input
                type="checkbox"
                class="sr-only"
                :checked="s.completed"
                @change="emit('toggleSubtask', task.id, s.id)"
              />
              <span
                class="w-4 h-4 rounded border flex items-center justify-center transition-all duration-150"
                :class="s.completed
                  ? (warm ? 'bg-amber-500 border-amber-500 text-white' : 'bg-brand border-brand text-white')
                  : (warm ? 'border-slate-300 bg-white text-transparent hover:border-amber-400' : 'border-slate-300 bg-white text-transparent hover:border-brand')"
              >
                <AppIcon name="check" :size="10" :stroke-width="2.5" />
              </span>
            </label>
            <span
              class="flex-1 min-w-0 text-[13px] cursor-pointer"
              :class="s.completed ? 'line-through text-slate-400' : (warm ? 'text-slate-700 hover:text-amber-600' : 'text-slate-700 hover:text-brand')"
              title="点击编辑子任务"
              @click="emit('editSubtask', task, s)"
            >
              {{ s.name || '（未命名子任务）' }}
            </span>
            <span
              v-if="(s.attachments?.length ?? 0) > 0"
              class="shrink-0 text-[11px] cursor-pointer inline-flex items-center gap-0.5"
              :class="warm ? 'text-amber-600' : 'text-brand/80'"
              :title="`${s.attachments.length} 个附件，点击查看/预览`"
              @click="emit('editSubtask', task, s)"
            >
              <AppIcon name="paperclip" :size="11" />{{ s.attachments.length }}
            </span>
            <span v-if="subOverdue(s)" class="text-red-500 shrink-0" title="已过提醒时间"><AppIcon name="bell" :size="13" /></span>
            <button
              class="shrink-0 text-slate-300 px-1.5 py-0.5 rounded-md"
              :class="warm ? 'hover:text-amber-600 hover:bg-amber-500/5' : 'hover:text-brand hover:bg-brand/5'"
              title="编辑子任务"
              @click="emit('editSubtask', task, s)"
            >
              <AppIcon name="edit" :size="14" />
            </button>
            <button
              class="shrink-0 text-slate-300 hover:text-red-500 px-1.5 py-0.5 rounded-md hover:bg-red-50"
              title="删除子任务"
              @click="emit('removeSubtask', task.id, s.id)"
            >
              <AppIcon name="close" :size="14" />
            </button>
            <span class="sub-drag-handle shrink-0 text-slate-300 cursor-grab select-none inline-flex items-center px-1" title="拖拽子任务排序"><AppIcon name="grip" :size="13" /></span>
          </div>
          <p v-if="s.description" class="mt-1 pl-6 text-[11px] text-slate-400 break-all clamp-2">
            {{ s.description }}
          </p>
          <div
            v-if="s.startTime || s.endTime || s.reminderTime"
            class="mt-1 pl-6 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400"
          >
            <span v-if="s.startTime" class="inline-flex items-center gap-1"><AppIcon name="calendar" :size="11" />{{ dateStr(s.startTime) }}</span>
            <span v-if="s.endTime" class="inline-flex items-center gap-1"><AppIcon name="clock" :size="11" />{{ dateStr(s.endTime) }}</span>
            <span v-if="s.reminderTime" :class="subOverdue(s) ? 'text-red-500' : ''" class="inline-flex items-center gap-1">
              <AppIcon name="bell" :size="11" />{{ timeStr(s.reminderTime) }}
            </span>
          </div>
        </div>
      </VueDraggable>
      </div>
  </div>
</template>
