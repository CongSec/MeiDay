<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { formatTodayTitle } from '@/utils/time'
import { formatRepeat } from '@/utils/repeat'
import type { Project, Subtask, Task } from '@/types'

const props = defineProps<{ task: Task; project?: Project }>()
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

const now = ref(Date.now())
const timer = window.setInterval(() => (now.value = Date.now()), 30000)
onUnmounted(() => window.clearInterval(timer))

const overdue = computed(
  () =>
    props.task.status === 'pending' &&
    !!props.task.reminderTime &&
    new Date(props.task.reminderTime).getTime() <= now.value,
)


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
    class="task-card group bg-white rounded-xl shadow-sm border border-slate-100 p-4 transition hover:shadow-md"
    :class="[overdue ? 'border-l-4 border-l-red-500' : '', task.status === 'completed' ? 'opacity-70' : '']"
    @click="emit('edit', task)"
  >
    <div class="flex items-start gap-3">
      <label class="pt-0.5 shrink-0" @click.stop>
        <input
          type="checkbox"
          class="w-5 h-5 accent-brand cursor-pointer"
          :checked="task.status === 'completed'"
          @change="emit('toggle', task.id)"
        />
      </label>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <button
            v-if="hasSubtasks"
            class="shrink-0 w-5 h-5 rounded text-slate-400 hover:bg-slate-100 flex items-center justify-center text-xs"
            :title="expanded ? '折叠子任务' : '展开子任务'"
            @click.stop="expanded = !expanded"
          >
            {{ expanded ? '▾' : '▸' }}
          </button>
          <span
            class="font-medium text-sm"
            :class="task.status === 'completed' ? 'line-through text-slate-400' : 'text-slate-800'"
          >
            {{ task.name }}
          </span>
          <span v-if="overdue" class="text-red-500 text-sm" title="已过提醒时间">🔔</span>
        </div>
        <p v-if="task.description" class="mt-1 text-xs text-slate-500 clamp-2">{{ task.description }}</p>
        <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
          <span v-if="task.startTime">{{ dateStr(task.startTime) }}</span>
          <span v-if="task.endTime">⏳ {{ dateStr(task.endTime) }}</span>
          <span v-if="task.reminderTime">🔔 {{ timeStr(task.reminderTime) }}</span>
          <span v-if="task.repeat" class="text-brand/90" :title="`重复任务：${formatRepeat(task.repeat)}`">
            🔁 {{ formatRepeat(task.repeat) }}
          </span>
          <span
            v-if="(task.attachments?.length ?? 0) > 0"
            class="text-brand/80 cursor-pointer"
            :title="`${task.attachments.length} 个附件，点击打开查看/预览`"
            @click.stop="emit('edit', task)"
          >
            📎 {{ task.attachments.length }}
          </span>
        </div>
      </div>
      <button
        class="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg border border-brand/30 text-brand text-base leading-none hover:bg-brand/5"
        title="添加子任务"
        @click.stop="onAddSubtask"
      >
        ＋
      </button>
    </div>

    <!-- 子任务进度条：与主任务框同宽对齐 -->
    <div v-if="subProgress" class="mt-2">
      <div class="flex items-center gap-2 text-[11px] text-slate-400">
        <span>☑ 子任务 {{ subProgress.done }}/{{ subProgress.total }}</span>
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
    <div v-if="expanded && hasSubtasks" class="mt-3 border-t border-slate-100 pt-2" @click.stop>
      <div class="flex items-center justify-between mb-2">
        <span class="text-[11px] font-medium text-slate-400">子任务明细</span>
        <button
          class="text-[11px] text-brand hover:bg-brand/5 px-2 py-0.5 rounded-md font-medium"
          title="添加子任务"
          @click="onAddSubtask"
        >
          ＋ 添加子任务
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
            <label class="shrink-0 cursor-pointer" title="标记完成" @click.stop>
              <input
                type="checkbox"
                class="w-4 h-4 accent-brand cursor-pointer rounded"
                :checked="s.completed"
                @change="emit('toggleSubtask', task.id, s.id)"
              />
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
              class="shrink-0 text-[11px] text-brand/80 cursor-pointer"
              :title="`${s.attachments.length} 个附件，点击查看/预览`"
              @click="emit('editSubtask', task, s)"
            >
              📎{{ s.attachments.length }}
            </span>
            <span v-if="subOverdue(s)" class="text-xs text-red-500 shrink-0" title="已过提醒时间">🔔</span>
            <button
              class="shrink-0 text-slate-300 hover:text-brand text-sm px-1"
              title="编辑子任务"
              @click="emit('editSubtask', task, s)"
            >
              ✎
            </button>
            <button
              class="shrink-0 text-slate-300 hover:text-red-500 text-sm px-1"
              title="删除子任务"
              @click="emit('removeSubtask', task.id, s.id)"
            >
              ✕
            </button>
          </div>
          <p v-if="s.description" class="mt-1 pl-6 text-[11px] text-slate-400 break-all clamp-2">
            {{ s.description }}
          </p>
          <div
            v-if="s.startTime || s.endTime || s.reminderTime"
            class="mt-1 pl-6 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400"
          >
            <span v-if="s.startTime">📅 {{ dateStr(s.startTime) }}</span>
            <span v-if="s.endTime">⏳ {{ dateStr(s.endTime) }}</span>
            <span v-if="s.reminderTime" :class="subOverdue(s) ? 'text-red-500' : ''">
              🔔 {{ timeStr(s.reminderTime) }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
