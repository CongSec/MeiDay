<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useNow } from '@/composables/useNow'
import { formatTodayTitle, todayKey } from '@/utils/time'
import { formatRepeat, isNewStyleRepeat, isRepeatDay } from '@/utils/repeat'
import type { Project, Subtask, Task } from '@/types'
import AppIcon from '@/components/AppIcon.vue'

const props = defineProps<{ task: Task; project?: Project; future?: boolean }>()
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

function timeStr(t: string) {
  return formatTodayTitle(t).slice(6)
}

function dateStr(t: string) {
  return t.slice(5, 10)
}

/** 子任务是否已过提醒时间（未完成） */
function subOverdue(s: Subtask) {
  return !s.completed && !!s.reminderTime && new Date(s.reminderTime).getTime() <= now.value
}

function onAddSubtask() {
  expanded.value = true
  emit('addSubtask', props.task)
}
</script>

<template>
  <div
    class="task-card group bg-white rounded-xl shadow-card border border-line p-4 transition hover:shadow-lift hover:border-slate-200"
    :class="[overdue ? 'border-l-4 border-l-red-500' : '', task.status === 'completed' ? 'opacity-70' : '']"
    @click="emit('edit', task)"
  >
    <div class="flex items-start gap-3">
      <label v-if="!future" class="pt-0.5 shrink-0 cursor-pointer select-none" title="标记完成 / 取消完成" @click.stop>
        <input
          type="checkbox"
          class="sr-only"
          :checked="task.status === 'completed'"
          @change="emit('toggle', task.id)"
        />
        <span
          class="w-5 h-5 rounded-md border flex items-center justify-center transition-all duration-150"
          :class="task.status === 'completed' ? 'bg-brand border-brand text-white' : 'border-slate-300 bg-white text-transparent hover:border-brand hover:bg-brand/5'"
        >
          <AppIcon name="check" :size="13" :stroke-width="2.5" />
        </span>
      </label>
      <span v-else class="pt-0.5 shrink-0 text-slate-300" title="未来任务"><AppIcon name="calendarFuture" :size="20" /></span>
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
            {{ task.name }}
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
          <span v-if="task.startTime" class="inline-flex items-center gap-1">
            <AppIcon name="calendar" :size="12" />{{ dateStr(task.startTime) }}
          </span>
          <span v-if="task.endTime" class="inline-flex items-center gap-1">
            <AppIcon name="clock" :size="12" />{{ dateStr(task.endTime) }}
          </span>
          <span v-if="task.reminderTime" class="inline-flex items-center gap-1">
            <AppIcon name="bell" :size="12" />{{ timeStr(task.reminderTime) }}
          </span>
          <span v-if="task.repeat" class="inline-flex items-center gap-1 text-brand/90" :title="`重复任务：${formatRepeat(task.repeat)}`">
            <AppIcon name="repeat" :size="12" />{{ formatRepeat(task.repeat) }}
          </span>
          <span
            v-if="(task.attachments?.length ?? 0) > 0"
            class="inline-flex items-center gap-1 text-brand/80 cursor-pointer"
            :title="`${task.attachments.length} 个附件，点击打开查看/预览`"
            @click.stop="emit('edit', task)"
          >
            <AppIcon name="paperclip" :size="12" />{{ task.attachments.length }}
          </span>
        </div>
      </div>
      <button
        v-if="!future"
        class="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg border border-brand/30 text-brand hover:bg-brand/5 hover:border-brand/50 btn-press"
        title="添加子任务"
        @click.stop="onAddSubtask"
      >
        <AppIcon name="plus" :size="15" />
      </button>
      <button
        v-else
        class="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg border border-red-200 text-red-400 hover:bg-red-50 btn-press"
        title="删除（移入回收站）"
        @click.stop="emit('delete', task.id)"
      >
        <AppIcon name="trash" :size="14" />
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
          :class="subProgress.done === subProgress.total ? 'bg-emerald-500' : 'bg-brand'"
          :style="{ width: `${(subProgress.done / subProgress.total) * 100}%` }"
        />
      </div>
    </div>

    <!-- 展开后显示子任务（全宽展示，新增/编辑走弹窗） -->
    <div v-if="expanded && hasSubtasks && !future" class="mt-3 border-t border-slate-100 pt-2" @click.stop>
      <div class="flex items-center justify-between mb-2">
        <span class="text-[11px] font-medium text-slate-400">子任务明细</span>
        <button
          class="text-[11px] text-brand hover:bg-brand/5 px-2 py-0.5 rounded-md font-medium"
          title="添加子任务"
          @click="onAddSubtask"
        >
          <span class="inline-flex items-center gap-1"><AppIcon name="plus" :size="11" />添加子任务</span>
        </button>
      </div>
      <div class="space-y-1.5">
        <div
          v-for="s in task.subtasks"
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
                :class="s.completed ? 'bg-brand border-brand text-white' : 'border-slate-300 bg-white text-transparent hover:border-brand'"
              >
                <AppIcon name="check" :size="10" :stroke-width="2.5" />
              </span>
            </label>
            <span
              class="flex-1 min-w-0 text-[13px] cursor-pointer"
              :class="s.completed ? 'line-through text-slate-400' : 'text-slate-700 hover:text-brand'"
              title="点击编辑子任务"
              @click="emit('editSubtask', task, s)"
            >
              {{ s.name || '（未命名子任务）' }}
            </span>
            <span
              v-if="(s.attachments?.length ?? 0) > 0"
              class="shrink-0 text-[11px] text-brand/80 cursor-pointer inline-flex items-center gap-0.5"
              :title="`${s.attachments.length} 个附件，点击查看/预览`"
              @click="emit('editSubtask', task, s)"
            >
              <AppIcon name="paperclip" :size="11" />{{ s.attachments.length }}
            </span>
            <span v-if="subOverdue(s)" class="text-red-500 shrink-0" title="已过提醒时间"><AppIcon name="bell" :size="13" /></span>
            <button
              class="shrink-0 text-slate-300 hover:text-brand px-1.5 py-0.5 rounded-md hover:bg-brand/5"
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
      </div>
    </div>
  </div>
</template>
