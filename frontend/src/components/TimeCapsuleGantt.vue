<script setup lang="ts">
/**
 * 时间胶囊 - 甘特图（按月分列）
 * 横向按月分列（默认当月）：已完成任务来自时间胶囊（status=completed），
 * 未完成任务来自胶囊外活跃待办（status=pending）；deleted 不计入。
 * 全部任务按时间排序平铺。
 */
import { computed, ref } from 'vue'
import type { Task } from '@/types'
import { dateKeyOf } from '@/utils/time'
import AppIcon from '@/components/AppIcon.vue'

const props = withDefaults(
  defineProps<{
    /** 已完成胶囊任务（跨所有已加载年份，组件内按月份过滤） */
    completed: Task[]
    /** 胶囊外活跃待办（未完成任务） */
    active: Task[]
    /** 当前查看的月份，YYYY-MM */
    month: string
    projectName?: (pid: string) => string
  }>(),
  { projectName: (pid: string) => pid },
)

const emit = defineEmits<{
  (e: 'change-month', month: string): void
  (e: 'open-task', task: Task): void
}>()

type GanttFilter = 'all' | 'completed' | 'pending'
const filter = ref<GanttFilter>('all')
const FILTERS: { key: GanttFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'completed', label: '已完成' },
  { key: 'pending', label: '未完成' },
]

const year = computed(() => Number(props.month.slice(0, 4)))
const monthIdx = computed(() => Number(props.month.slice(5, 7)) - 1)
const daysInMonth = computed(() => new Date(year.value, monthIdx.value + 1, 0).getDate())
const monthFirst = computed(() => `${props.month}-01`)
const monthLast = computed(() => `${props.month}-${String(daysInMonth.value).padStart(2, '0')}`)

/** 起点：有提醒时间优先，否则用开始时间；无则空 */
function taskStart(t: Task): string {
  return t.reminderTime || t.startTime || ''
}
/** 终点：已完成=完成时间（updatedAt）；未完成=截止时间（endTime，缺失时用创建时间兜底） */
function taskEnd(t: Task, kind: 'completed' | 'pending'): string {
  return kind === 'completed' ? t.updatedAt || t.endTime || '' : t.endTime || t.createdAt || ''
}

interface GanttBar {
  left: number
  width: number
  noStart: boolean
}
interface GanttItem {
  task: Task
  kind: 'completed' | 'pending'
  start: string
  end: string
  bar: GanttBar
}

/** 计算任务条在本月时间轴上的位置（%）；与本月无交集返回 null */
function barOf(start: string, end: string): GanttBar | null {
  if (!end) return null
  const eDate = dateKeyOf(end)
  const sDate = start ? dateKeyOf(start) : ''
  if (eDate < monthFirst.value) return null
  if (sDate && sDate > monthLast.value) return null
  if (!sDate && eDate > monthLast.value) return null
  const clampDay = (d: string) => (d < monthFirst.value ? 1 : d > monthLast.value ? daysInMonth.value : Number(d.slice(8, 10)))
  const unit = (1 / daysInMonth.value) * 100
  if (!sDate) {
    // 无开始时间：在完成/截止位置显示小条
    const day = clampDay(eDate)
    const width = Math.min(12, unit)
    const left = Math.min(((day - 1) / daysInMonth.value) * 100, Math.max(0, 100 - width))
    return { left, width, noStart: true }
  }
  const startDay = clampDay(sDate)
  const endDay = clampDay(eDate)
  const width = Math.max(((endDay - startDay + 1) / daysInMonth.value) * 100, 2)
  const left = Math.min(((startDay - 1) / daysInMonth.value) * 100, Math.max(0, 100 - width))
  return { left, width, noStart: false }
}

const items = computed<GanttItem[]>(() => {
  const out: GanttItem[] = []
  if (filter.value !== 'pending') {
    for (const t of props.completed) {
      if (t.status !== 'completed') continue
      const start = taskStart(t)
      const end = taskEnd(t, 'completed')
      const bar = barOf(start, end)
      if (bar) out.push({ task: t, kind: 'completed', start, end, bar })
    }
  }
  if (filter.value !== 'completed') {
    for (const t of props.active) {
      if (t.status !== 'pending') continue
      const start = taskStart(t)
      const end = taskEnd(t, 'pending')
      const bar = barOf(start, end)
      if (bar) out.push({ task: t, kind: 'pending', start, end, bar })
    }
  }
  // 按时间排序平铺：起点优先，无起点按终点
  out.sort((a, b) => (a.start || a.end).localeCompare(b.start || b.end))
  return out
})

function changeMonth(delta: number) {
  const d = new Date(year.value, monthIdx.value + delta, 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  emit('change-month', `${d.getFullYear()}-${pad(d.getMonth() + 1)}`)
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex gap-0.5 rounded-lg bg-slate-100 p-0.5">
        <button
          v-for="f in FILTERS"
          :key="f.key"
          class="rounded-md px-3 py-1 text-xs font-medium"
          :class="filter === f.key ? 'bg-white text-brand shadow-sm' : 'text-slate-500 hover:text-slate-700'"
          @click="filter = f.key"
        >
          {{ f.label }}
        </button>
      </div>
      <div class="flex items-center gap-1 text-sm font-semibold text-slate-700">
        <button class="rounded-lg border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50" @click="changeMonth(-1)">
          <AppIcon name="chevron-left" :size="14" />
        </button>
        <span class="min-w-16 text-center">{{ year }}年{{ monthIdx + 1 }}月</span>
        <button class="rounded-lg border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50" @click="changeMonth(1)">
          <AppIcon name="chevron-right" :size="14" />
        </button>
      </div>
    </div>

    <div class="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div class="flex items-center border-b border-slate-200 bg-slate-50/70">
        <div class="w-36 shrink-0 border-r border-slate-200 px-2 py-1.5 text-[11px] text-slate-400 sm:w-48">任务</div>
        <div class="relative h-6 flex-1">
          <div
            v-for="d in daysInMonth"
            :key="d"
            class="absolute top-0 bottom-0 text-center text-[10px] leading-6 text-slate-300"
            :style="{ left: ((d - 1) / daysInMonth) * 100 + '%', width: 100 / daysInMonth + '%' }"
          >
            {{ d }}
          </div>
        </div>
      </div>

      <div v-if="items.length" class="max-h-96 overflow-y-auto">
        <div v-for="(it, i) in items" :key="it.task.id + i" class="flex items-center border-b border-slate-100 last:border-b-0">
          <button
            class="flex w-36 shrink-0 items-center gap-1 border-r border-slate-100 px-2 py-2 text-left text-xs text-slate-600 truncate hover:bg-slate-50 sm:w-48"
            :title="`${projectName(it.task.projectId)} · ${it.task.name}`"
            @click="emit('open-task', it.task)"
          >
            <span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full" :class="it.kind === 'completed' ? 'bg-brand' : 'bg-amber-400'"></span>
            <span class="truncate">{{ it.task.name }}</span>
          </button>
          <div class="relative h-9 flex-1">
            <div
              v-for="d in daysInMonth"
              :key="d"
              class="absolute top-0 bottom-0 border-l border-slate-100 first:border-l-0"
              :style="{ left: ((d - 1) / daysInMonth) * 100 + '%', width: 100 / daysInMonth + '%' }"
            ></div>
            <div
              class="absolute top-1/2 h-4 -translate-y-1/2 cursor-pointer rounded-md"
              :class="it.kind === 'completed' ? 'bg-brand/80 hover:bg-brand' : 'bg-amber-400/90 hover:bg-amber-500'"
              :style="{ left: it.bar.left + '%', width: Math.max(it.bar.width, 1.5) + '%' }"
              :title="`${projectName(it.task.projectId)} · ${it.task.name}：${it.start ? it.start.slice(0, 16) : '无开始时间'} → ${it.end.slice(0, 16)}`"
              @click="emit('open-task', it.task)"
            ></div>
          </div>
        </div>
      </div>
      <div v-else class="py-12 text-center text-sm text-slate-400">
        {{ filter === 'all' ? '该月没有任务' : filter === 'completed' ? '该月没有已完成任务' : '该月没有未完成任务' }}
      </div>
    </div>

    <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
      <span class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded bg-brand/80"></span>已完成（时间胶囊）</span>
      <span class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded bg-amber-400/90"></span>未完成（胶囊外待办）</span>
    </div>
  </div>
</template>
