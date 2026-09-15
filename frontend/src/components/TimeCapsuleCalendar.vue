<script setup lang="ts">
/**
 * 时间胶囊 - 日历视图
 * 以月为单位展示任务：
 * - 灰色：胶囊内已完成任务（status=completed，按 updatedAt 归属完成当天，按完成时间排序）
 * - 淡黄色：胶囊外未完成任务（有开始/提醒时间或重复规则；按提醒(优先)/开始时间归属当天并按该时间排序；
 *   重复任务枚举当前查看月份内所有发生日）
 * 跨天任务：不占普通任务格，而是以连续横条显示在每周格子的下方（与普通任务上下分层，互不重叠），
 * 横条高度与普通任务小块一致、任务名直接显示在横条内；重叠的跨天条上下堆叠，每条占一行。
 */
import { computed } from 'vue'
import type { Task } from '@/types'
import { dateKeyOf } from '@/utils/time'
import { formatRepeat, isRepeatDay } from '@/utils/repeat'
import AppIcon from '@/components/AppIcon.vue'

const props = withDefaults(
  defineProps<{
    /** 全部已完成胶囊任务（跨所有已加载年份，组件内按月份过滤） */
    tasks: Task[]
    /** 胶囊外活跃待办（未完成，跨所有已加载项目；组件内筛选有时间/重复的任务并按月份过滤） */
    pending?: Task[]
    /** 当前查看的月份，YYYY-MM */
    month: string
    /** 项目名查询 */
    projectName?: (pid: string) => string
  }>(),
  { projectName: (pid: string) => pid, pending: () => [] },
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
/** 已完成任务终点：完成时间（updatedAt，缺失时用 endTime 兜底） */
function taskEnd(t: Task): string {
  return t.updatedAt || t.endTime || ''
}
/** 取 ISO 时间的 HH:mm（用于当天内排序与标题） */
function timeOfDay(iso: string): string {
  return iso ? iso.slice(11, 16) : ''
}

type ChipKind = 'done' | 'pending'

/** 普通（单日）任务小块：显示在归属当天格子里 */
interface Chip {
  task: Task
  kind: ChipKind
  /** 归属（显示）日 YYYY-MM-DD */
  day: string
  /** 排序键：当天内的时刻（同一天可直接字典序比较） */
  sortKey: string
}

/** 跨天任务横条：起点=提醒(优先)/开始日，终点=完成/截止日 */
interface CrossBar {
  task: Task
  kind: ChipKind
  startKey: string
  endKey: string
  /** 车道（上下分层行号）：在 laidOutBars 中分配 */
  lane: number
}

/** 已完成任务（仅单日）：小块归属完成当天；跨天任务不在此列（走横条） */
const doneChips = computed<Chip[]>(() => {
  const out: Chip[] = []
  for (const t of props.tasks) {
    if (t.status !== 'completed') continue
    const end = taskEnd(t)
    if (!end) continue
    const endKey = dateKeyOf(end)
    if (endKey.slice(0, 7) !== props.month) continue
    const startKey = taskStart(t) ? dateKeyOf(taskStart(t)) : ''
    if (startKey && startKey < endKey) continue // 跨天 → 横条
    out.push({ task: t, kind: 'done', day: endKey, sortKey: end })
  }
  return out
})

/** 已完成跨天任务的横条：起点=提醒(优先)/开始日，终点=完成日；与本月有交集即显示 */
const doneBars = computed<CrossBar[]>(() => {
  const out: CrossBar[] = []
  for (const t of props.tasks) {
    if (t.status !== 'completed') continue
    const startKey = taskStart(t) ? dateKeyOf(taskStart(t)) : ''
    const endKey = taskEnd(t) ? dateKeyOf(taskEnd(t)) : ''
    if (!startKey || !endKey || startKey >= endKey) continue
    if (endKey < monthFirst.value || startKey > monthLast.value) continue
    out.push({ task: t, kind: 'done', startKey, endKey, lane: 0 })
  }
  return out
})

/** 胶囊外未完成任务（仅单日）：非重复任务按提醒(优先)/开始时间归属当天；重复任务枚举本月所有发生日；跨天任务不在此列 */
const pendingChips = computed<Chip[]>(() => {
  const out: Chip[] = []
  const pad = (n: number) => String(n).padStart(2, '0')
  for (const t of props.pending) {
    if (t.status !== 'pending') continue
    const rule = t.repeat
    const start = taskStart(t)
    if (!start && !rule) continue // 无开始/提醒/重复，不纳入
    if (rule) {
      // 重复任务：相位锚点优先用新模型的 rule.start，否则用提醒/截止/开始时间所在日（老数据）
      const anchor = rule.start || dateKeyOf(t.reminderTime || t.endTime || t.startTime) || monthFirst.value
      const time = timeOfDay(t.reminderTime || t.startTime || t.endTime)
      for (let d = 1; d <= daysInMonth.value; d++) {
        const key = `${props.month}-${pad(d)}`
        if (rule.endAfter && key > rule.endAfter) continue
        if (!isRepeatDay(rule, anchor, key)) continue
        out.push({ task: t, kind: 'pending', day: key, sortKey: `${key}T${time || '00:00'}` })
      }
    } else {
      // 非重复：提醒(优先)/开始时间当天；有截止时间且跨天时连横条
      if (!start) continue
      const day = dateKeyOf(start)
      if (day.slice(0, 7) !== props.month) continue
      const endKey = t.endTime ? dateKeyOf(t.endTime) : ''
      if (endKey && endKey > day) continue // 跨天 → 横条
      out.push({ task: t, kind: 'pending', day, sortKey: start })
    }
  }
  return out
})

/** 未完成跨天任务的横条：起点=提醒(优先)/开始日，终点=截止日 */
const pendingBars = computed<CrossBar[]>(() => {
  const out: CrossBar[] = []
  for (const t of props.pending) {
    if (t.status !== 'pending' || t.repeat) continue
    const startKey = taskStart(t) ? dateKeyOf(taskStart(t)) : ''
    const endKey = t.endTime ? dateKeyOf(t.endTime) : ''
    if (!startKey || !endKey || startKey >= endKey) continue
    if (endKey < monthFirst.value || startKey > monthLast.value) continue
    out.push({ task: t, kind: 'pending', startKey, endKey, lane: 0 })
  }
  return out
})

/** 按天分组的全部任务小块（已完成 + 未完成），同一天内按时间排序 */
const chipsByDay = computed(() => {
  const map = new Map<string, Chip[]>()
  for (const c of [...doneChips.value, ...pendingChips.value]) {
    const arr = map.get(c.day) ?? []
    arr.push(c)
    map.set(c.day, arr)
  }
  for (const arr of map.values()) arr.sort((a, b) => a.sortKey.localeCompare(b.sortKey))
  return map
})

/** 全部跨天横条：按起点排序，并按与本月重叠的区间做贪心分层（每条占一行，互不重叠） */
const laidOutBars = computed<CrossBar[]>(() => {
  const bars = [...doneBars.value, ...pendingBars.value].sort(
    (a, b) => a.startKey.localeCompare(b.startKey) || a.endKey.localeCompare(b.endKey),
  )
  const laneEnds: string[] = []
  for (const bar of bars) {
    const from = bar.startKey < monthFirst.value ? monthFirst.value : bar.startKey
    const to = bar.endKey > monthLast.value ? monthLast.value : bar.endKey
    if (from > to) continue
    let lane = laneEnds.findIndex((end) => end < from)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(to)
    } else {
      laneEnds[lane] = to
    }
    bar.lane = lane
  }
  return bars
})

/** 跨天横条单行高度（px），每条占一行（含上下间距） */
const LANE_H = 24

interface DayCell {
  key: string
  day: number
  inMonth: boolean
  chips: Chip[]
}
interface BarSeg {
  bar: CrossBar
  startCol: number
  endCol: number
}
interface WeekRow {
  cells: DayCell[]
  segments: BarSeg[]
  /** 本行横条占用的最大车道（-1 = 无横条） */
  maxLane: number
}

/** 月历按周行组织；普通任务小块在上，跨天横条在下（上下分层），横条行末接行首连续显示 */
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
      cells.push({ key, day: d.getDate(), inMonth, chips: inMonth ? chipsByDay.value.get(key) ?? [] : [] })
    }
    out.push({ cells, segments: [], maxLane: -1 })
  }
  // 把每条跨天横条切成各周行的段（行末接行首，视觉连续）；跨月任务按「与本月交集」截取起止日
  for (const bar of laidOutBars.value) {
    const fromKey = bar.startKey < monthFirst.value ? monthFirst.value : bar.startKey
    const toKey = bar.endKey > monthLast.value ? monthLast.value : bar.endKey
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
      out[r].segments.push({ bar, startCol, endCol })
      out[r].maxLane = Math.max(out[r].maxLane, bar.lane)
      day = segEnd + 1
    }
  }
  return out
})

function chipTitle(c: Chip): string {
  const pid = props.projectName(c.task.projectId)
  if (c.kind === 'pending') {
    const time = timeOfDay(c.task.reminderTime || c.task.startTime)
    const rep = c.task.repeat ? formatRepeat(c.task.repeat) : ''
    const parts = [pid, c.task.name]
    const detail = [c.day.slice(5)]
    if (time) detail.push(time)
    if (rep) detail.push(rep)
    return `${parts.join(' · ')}（${detail.join(' ')}）`
  }
  return `${pid} · ${c.task.name}（${c.day.slice(5)} ${timeOfDay(c.task.updatedAt)} 完成）`
}

function barTitle(b: CrossBar): string {
  const kind = b.kind === 'done' ? '完成' : '截止'
  return `${props.projectName(b.task.projectId)} · ${b.task.name}（${b.startKey.slice(5)} → ${b.endKey.slice(5)}，${kind}）`
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
        :style="{ paddingBottom: (row.maxLane + 1) * LANE_H + 'px' }"
      >
        <div
          v-for="cell in row.cells"
          :key="cell.key"
          class="min-h-[104px] flex-1 border-r border-slate-100 p-1.5 last:border-r-0"
          :class="cell.inMonth ? 'bg-white' : 'bg-slate-50/70'"
        >
          <div class="flex items-center justify-between">
            <span class="text-[11px] leading-4" :class="cell.inMonth ? 'text-slate-600' : 'text-slate-300'">{{ cell.day }}</span>
            <span v-if="cell.chips.length" class="rounded bg-slate-100 px-1 text-[10px] leading-4 text-slate-500">{{ cell.chips.length }}</span>
          </div>
          <div class="mt-1 space-y-0.5">
            <button
              v-for="(chip, ci) in cell.chips"
              :key="chip.task.id + '-' + chip.day + '-' + ci"
              class="relative z-10 block h-[20px] w-full truncate rounded px-1 text-left text-[10px] leading-[20px]"
              :class="chip.kind === 'done' ? 'bg-slate-100 text-slate-600 hover:bg-slate-200' : 'bg-amber-200/90 text-amber-800 hover:bg-amber-300/90'"
              :title="chipTitle(chip)"
              @click="emit('open-task', chip.task)"
            >
              {{ chip.task.name }}
            </button>
          </div>
        </div>
        <!-- 跨天横条：位于普通任务下方（上下分层不重叠），名称与横条同高，重叠条上下堆叠 -->
        <button
          v-for="(seg, si) in row.segments"
          :key="seg.bar.task.id + '-' + ri + '-' + si"
          class="absolute z-10 flex h-[20px] cursor-pointer items-center overflow-hidden rounded px-1.5 text-left text-[10px]"
          :class="seg.bar.kind === 'done' ? 'bg-slate-100 text-slate-600 hover:bg-slate-200' : 'bg-amber-200/90 text-amber-800 hover:bg-amber-300/90'"
          :style="{
            left: (seg.startCol / 7) * 100 + '%',
            width: ((seg.endCol - seg.startCol + 1) / 7) * 100 + '%',
            bottom: seg.bar.lane * LANE_H + 'px',
          }"
          :title="barTitle(seg.bar)"
          @click="emit('open-task', seg.bar.task)"
        >
          <span class="min-w-0 truncate">{{ seg.bar.task.name }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
