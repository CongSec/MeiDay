<script setup lang="ts">
/**
 * 时间胶囊 - 日历视图
 * 以月为单位展示每天完成的任务（status=completed，按 updatedAt 归属日期）。
 * 跨天任务（开始[提醒优先]→完成横跨多天）在月历格子内连成一条色条，
 * 排在当天普通任务下方；跨周时行末接行首连续显示，重叠任务上下分层堆叠。
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

/** 跨天任务：起点到完成横跨多天，且与当前月份有交集 */
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

/** 跨天横条单行高度（px），每条占一行 */
const LANE_H = 24

interface DayCell {
  key: string
  day: number
  inMonth: boolean
  tasks: Task[]
}
interface CrossSeg {
  task: Task
  startCol: number
  endCol: number
  lane: number
}
interface WeekRow {
  cells: DayCell[]
  segments: CrossSeg[]
}

/** 月历按周行组织；跨天任务切分到所在周行，同一行内重叠任务分层堆叠 */
const rows = computed<WeekRow[]>(() => {
  const rowCount = cellCount.value / 7
  const out: WeekRow[] = []
  const firstDate = new Date(year.value, monthIdx.value, 1 - firstCol.value)
  const pad = (n: number) => String(n).padStart(2, '0')
  for (let r = 0; r < rowCount; r++) {
    const cells: DayCell[] = []
    for (let c = 0; c < 7; c++) {
      const d = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate() + r * 7 + c)
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      const inMonth = d.getMonth() === monthIdx.value
      cells.push({ key, day: d.getDate(), inMonth, tasks: inMonth ? dayByDate.value.get(key) ?? [] : [] })
    }
    out.push({ cells, segments: [] })
  }
  // 把每条跨天任务切成各周行的段（行末接行首，视觉连续）；跨月任务按「与本月交集」截取起止日
  for (const t of crossDayTasks.value) {
    const sKey = taskStart(t).slice(0, 10)
    const eKey = taskEnd(t).slice(0, 10)
    const fromKey = sKey < monthFirst.value ? monthFirst.value : sKey
    const toKey = eKey > monthLast.value ? monthLast.value : eKey
    if (fromKey > toKey) continue
    const s = Number(fromKey.slice(8, 10))
    const e = Number(toKey.slice(8, 10))
    let day = s
    while (day <= e) {
      const idx = firstCol.value + (day - 1)
      const r = Math.floor(idx / 7)
      const rowStart = r * 7 - firstCol.value + 1
      const rowEnd = rowStart + 6
      const segStart = Math.max(s, rowStart)
      const segEnd = Math.min(e, rowEnd)
      const startCol = firstCol.value + (segStart - 1) - r * 7
      const endCol = firstCol.value + (segEnd - 1) - r * 7
      out[r].segments.push({ task: t, startCol, endCol, lane: 0 })
      day = segEnd + 1
    }
  }
  // 每行内按开始列贪心分配车道，重叠任务错开
  for (const row of out) {
    if (!row.segments.length) continue
    row.segments.sort((a, b) => a.startCol - b.startCol || a.endCol - b.endCol)
    const laneEnds: number[] = []
    for (const seg of row.segments) {
      let lane = laneEnds.findIndex((end) => end < seg.startCol)
      if (lane === -1) {
        lane = laneEnds.length
        laneEnds.push(seg.endCol)
      } else {
        laneEnds[lane] = seg.endCol
      }
      seg.lane = lane
    }
  }
  return out
})

/** 某周行跨天条占用的车道数（用于拉高格子，保证横条始终可见） */
function laneCount(row: WeekRow): number {
  if (!row.segments.length) return 0
  return Math.max(...row.segments.map((s) => s.lane)) + 1
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

    <div class="mt-3 rounded-lg border border-slate-200 bg-white overflow-hidden">
      <div class="grid grid-cols-7 border-b border-slate-200 bg-slate-50/70">
        <div v-for="w in WEEK_LABELS" :key="w" class="py-1.5 text-center text-[11px] font-medium text-slate-400">周{{ w }}</div>
      </div>
      <div
        v-for="(row, ri) in rows"
        :key="ri"
        class="relative flex border-b border-slate-100 last:border-b-0"
        :style="{ paddingBottom: laneCount(row) * LANE_H + 'px' }"
      >
        <div
          v-for="cell in row.cells"
          :key="cell.key"
          class="min-h-[104px] flex-1 border-r border-slate-100 p-1.5 last:border-r-0"
          :class="cell.inMonth ? 'bg-white' : 'bg-slate-50/70'"
        >
          <div class="flex items-center justify-between">
            <span class="text-[11px] leading-4" :class="cell.inMonth ? 'text-slate-600' : 'text-slate-300'">{{ cell.day }}</span>
            <span v-if="cell.tasks.length" class="rounded bg-slate-100 px-1 text-[10px] leading-4 text-slate-500">{{ cell.tasks.length }}</span>
          </div>
          <div class="mt-1 space-y-0.5">
            <button
              v-for="t in cell.tasks"
              :key="t.id"
              class="block w-full truncate rounded bg-slate-100 px-1 py-0.5 text-left text-[10px] leading-4 text-slate-600 hover:bg-slate-200"
              :title="`${t.name}（${t.updatedAt.slice(11, 16)} 完成）`"
              @click="emit('open-task', t)"
            >
              {{ t.name }}
            </button>
          </div>
        </div>
        <!-- 跨天任务横条：压在普通任务下方，跨周连续，重叠分层 -->
        <button
          v-for="seg in row.segments"
          :key="seg.task.id + '-' + ri"
          class="absolute z-10 flex h-[21px] cursor-pointer items-center overflow-hidden rounded bg-slate-100 pl-1.5 pr-1 text-left text-[11px] leading-[21px] text-slate-600 hover:bg-slate-200"
          :style="{
            left: (seg.startCol / 7) * 100 + '%',
            width: ((seg.endCol - seg.startCol + 1) / 7) * 100 + '%',
            bottom: seg.lane * LANE_H + 'px',
          }"
          :title="`${projectName(seg.task.projectId)} · ${seg.task.name}：${taskStart(seg.task).slice(0, 16)} → ${taskEnd(seg.task).slice(0, 16)}`"
          @click="emit('open-task', seg.task)"
        >
          <span class="min-w-0 truncate">{{ seg.task.name }}</span>
        </button>
      </div>
    </div>
  </div>
</template>