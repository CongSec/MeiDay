<script setup lang="ts">
/**
 * 时间胶囊 - 日历视图
 * 以月为单位展示每天完成的任务（status=completed，按 updatedAt 归属日期）。
 * 跨天任务（开始[提醒优先]→完成横跨多天）连成一条色条，统一排在月历下方。
 */
import { computed } from 'vue'
import type { Task } from '@/types'
import { dateKeyOf } from '@/utils/time'
import AppIcon from '@/components/AppIcon.vue'

const props = withDefaults(
  defineProps<{
    /** 全部已完成胶囊任务（跨所有已加载年份，组件内按月份过滤） */
    tasks: Task[]
    /** 当前查看的月份，YYYY-MM */
    month: string
    /** 项目名查询 */
    projectName?: (pid: string) => string
  }>(),
  { projectName: (pid: string) => pid },
)

const emit = defineEmits<{
  (e: 'change-month', month: string): void
  (e: 'open-task', task: Task): void
}>()

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

const year = computed(() => Number(props.month.slice(0, 4)))
const monthIdx = computed(() => Number(props.month.slice(5, 7)) - 1)
const daysInMonth = computed(() => new Date(year.value, monthIdx.value + 1, 0).getDate())
/** 每月 1 号所在的列（周一=0 … 周日=6） */
const firstCol = computed(() => (new Date(year.value, monthIdx.value, 1).getDay() + 6) % 7)
const cellCount = computed(() => Math.ceil((firstCol.value + daysInMonth.value) / 7) * 7)

const monthFirst = computed(() => `${props.month}-01`)
const monthLast = computed(() => `${props.month}-${String(daysInMonth.value).padStart(2, '0')}`)

/** 跨天起点：有提醒时间优先，否则用开始时间 */
function taskStart(t: Task): string {
  return t.reminderTime || t.startTime || ''
}
/** 终点：完成时间（updatedAt，缺失时用 endTime 兜底） */
function taskEnd(t: Task): string {
  return t.updatedAt || t.endTime || ''
}

/** 跨天任务：起点到完成横跨多天，且与当前月份有交集（默认排在月历最底下） */
const crossDayTasks = computed<Task[]>(() => {
  const out: Task[] = []
  for (const t of props.tasks) {
    if (t.status !== 'completed') continue
    const s = taskStart(t)
    const e = taskEnd(t)
    if (!s || !e) continue
    const sd = dateKeyOf(s)
    const ed = dateKeyOf(e)
    if (sd >= ed) continue // 单天内不算跨天
    if (ed < monthFirst.value || sd > monthLast.value) continue // 与本月无交集
    out.push(t)
  }
  return out.sort((a, b) => taskStart(a).localeCompare(taskStart(b)))
})

const crossIds = computed(() => new Set(crossDayTasks.value.map((t) => t.id)))

/** 单日（非跨天）任务：按完成时间升序 */
const dayByDate = computed(() => {
  const map = new Map<string, Task[]>()
  for (const t of props.tasks) {
    if (t.status !== 'completed') continue
    if (crossIds.value.has(t.id)) continue
    const d = dateKeyOf(t.updatedAt)
    if (d.slice(0, 7) !== props.month) continue
    const arr = map.get(d) ?? []
    arr.push(t)
    map.set(d, arr)
  }
  for (const arr of map.values()) arr.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  return map
})

interface DayCell {
  key: string
  day: number
  inMonth: boolean
  tasks: Task[]
}
const grid = computed<DayCell[]>(() => {
  const cells: DayCell[] = []
  const firstDate = new Date(year.value, monthIdx.value, 1 - firstCol.value)
  const pad = (n: number) => String(n).padStart(2, '0')
  for (let i = 0; i < cellCount.value; i++) {
    const d = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate() + i)
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const inMonth = d.getMonth() === monthIdx.value
    cells.push({ key, day: d.getDate(), inMonth, tasks: inMonth ? dayByDate.value.get(key) ?? [] : [] })
  }
  return cells
})

/** 跨天条在月日条带上的位置（%），越界时裁剪到本月初/月末 */
function crossBar(t: Task): { left: number; width: number } {
  const sd = dateKeyOf(taskStart(t))
  const ed = dateKeyOf(taskEnd(t))
  const clampDay = (d: string) => (d < monthFirst.value ? 1 : d > monthLast.value ? daysInMonth.value : Number(d.slice(8, 10)))
  const startDay = clampDay(sd)
  const endDay = clampDay(ed)
  let left = ((startDay - 1) / daysInMonth.value) * 100
  let width = ((endDay - startDay + 1) / daysInMonth.value) * 100
  if (left + width > 100) width = Math.max(0, 100 - left)
  return { left, width }
}

function changeMonth(delta: number) {
  const d = new Date(year.value, monthIdx.value + delta, 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  emit('change-month', `${d.getFullYear()}-${pad(d.getMonth() + 1)}`)
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between">
      <button class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50" @click="changeMonth(-1)">
        <AppIcon name="chevron-left" :size="15" /> 上月
      </button>
      <div class="text-sm font-semibold text-slate-700">{{ year }}年{{ monthIdx + 1 }}月</div>
      <button class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50" @click="changeMonth(1)">
        下月 <AppIcon name="chevron-right" :size="15" />
      </button>
    </div>

    <div class="mt-3 rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div class="grid grid-cols-7 bg-slate-50/70 border-b border-slate-200">
        <div v-for="w in WEEK_LABELS" :key="w" class="py-1.5 text-center text-[11px] font-medium text-slate-400">周{{ w }}</div>
      </div>
      <div class="grid grid-cols-7">
        <div
          v-for="cell in grid"
          :key="cell.key"
          class="min-h-[86px] border-b border-r border-slate-100 p-1 last:border-r-0"
          :class="cell.inMonth ? 'bg-white' : 'bg-slate-50/70'"
        >
          <div class="flex items-center justify-between">
            <span class="text-[11px] leading-4" :class="cell.inMonth ? 'text-slate-600' : 'text-slate-300'">{{ cell.day }}</span>
            <span v-if="cell.tasks.length" class="rounded bg-brand/10 px-1 text-[10px] leading-4 text-brand">{{ cell.tasks.length }}</span>
          </div>
          <div class="mt-1 space-y-0.5">
            <button
              v-for="t in cell.tasks"
              :key="t.id"
              class="block w-full truncate rounded bg-brand/10 px-1 py-0.5 text-left text-[10px] leading-4 text-brand hover:bg-brand/20"
              :title="`${t.name}（${t.updatedAt.slice(11, 16)} 完成）`"
              @click="emit('open-task', t)"
            >
              {{ t.name }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="crossDayTasks.length" class="mt-4">
      <div class="mb-1.5 text-xs font-medium text-slate-500">跨天任务（开始 → 完成，默认排在最底下）</div>
      <div class="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div class="flex items-center border-b border-slate-200 bg-slate-50/70">
          <div class="w-36 sm:w-48 shrink-0 px-2 py-1 text-[11px] text-slate-400">任务</div>
          <div class="relative flex-1 h-6">
            <div
              v-for="d in daysInMonth"
              :key="d"
              class="absolute top-0 bottom-0 text-center text-[10px] leading-6 text-slate-300"
              :style="{ left: ((d - 1) / daysInMonth) * 100 + '%', width: (100 / daysInMonth) + '%' }"
            >
              {{ d }}
            </div>
          </div>
        </div>
        <div v-for="t in crossDayTasks" :key="t.id" class="flex items-center border-b border-slate-100 last:border-b-0">
          <button
            class="w-36 sm:w-48 shrink-0 px-2 py-2 text-left text-xs text-slate-600 truncate hover:bg-slate-50"
            :title="`${projectName(t.projectId)} · ${t.name}`"
            @click="emit('open-task', t)"
          >
            {{ projectName(t.projectId) }} · {{ t.name }}
          </button>
          <div class="relative flex-1 h-7">
            <div
              class="absolute top-1/2 h-4 -translate-y-1/2 rounded-md bg-amber-400/85"
              :style="{ left: crossBar(t).left + '%', width: crossBar(t).width + '%' }"
              :title="`${t.name}：${taskStart(t).slice(0, 16)} → ${taskEnd(t).slice(0, 16)}`"
            ></div>
          </div>
        </div>
      </div>
      <div class="mt-1 text-[11px] text-slate-400">
        色条从开始时间（有提醒则优先）连到完成时间，跨出本月部分已裁剪。
      </div>
    </div>
  </div>
</template>
