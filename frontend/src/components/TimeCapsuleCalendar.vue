<script setup lang="ts">
/**
 * 时间胶囊 - 日历视图
 * 以月为单位展示任务：
 * - 灰色：胶囊内已完成任务（status=completed，按 updatedAt 归属完成当天，按完成时间排序）
 * - 淡黄色：胶囊外未完成任务（有开始/提醒时间或重复规则；按提醒(优先)/开始时间归属当天并按该时间排序；
 *   重复任务枚举当前查看月份内所有发生日）
 * 跨天任务：任务小块显示在「归属当天」格子里（已完成=完成当天，未完成=提醒/开始当天），
 * 并保留从开始日（提醒优先）延伸到完成/截止日的横条；横条整根固定在同一行（不产生台阶），
 * 与对应小块的垂直行号对齐；同一天内普通任务小块与横条按时间排序、上下堆叠，绝不重叠。
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
    /** 可翻页的下限月份（YYYY-MM，按年份过滤时固定为所选年 1 月），缺省不限制 */
    minMonth?: string
    /** 可翻页的上限月份（YYYY-MM，按年份过滤时固定为所选年 12 月），缺省不限制 */
    maxMonth?: string
  }>(),
  { projectName: (pid: string) => pid, pending: () => [], minMonth: '', maxMonth: '' },
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

interface Chip {
  task: Task
  kind: ChipKind
  /** 归属（显示）日 YYYY-MM-DD */
  day: string
  /** 排序键：当天内的时刻（同一天可直接字典序比较） */
  sortKey: string
  /** 跨天：起点日/终点日（含当天），null=单天 */
  cross: { start: string; end: string } | null
  /** 当天内的行号（由 placedByDay 计算，绝对定位用） */
  row: number
}

/** 跨天横条：与起点/终点所在月有交集才显示 */
interface CrossBar {
  task: Task
  kind: ChipKind
  startKey: string
  endKey: string
  /** 任务小块所在（锚点）日：已完成=完成日，未完成=开始日 */
  anchorDay: string
  /** 固定行号：整根横条（从开始日到完成/截止日）始终在同一行，不随天变化（无台阶） */
  lane: number
}

/** 已完成任务（含跨天）：小块归属完成当天 */
const doneChips = computed<Chip[]>(() => {
  const out: Chip[] = []
  for (const t of props.tasks) {
    if (t.status !== 'completed') continue
    const end = taskEnd(t)
    if (!end) continue
    const endKey = dateKeyOf(end)
    if (endKey.slice(0, 7) !== props.month) continue
    const startKey = taskStart(t) ? dateKeyOf(taskStart(t)) : ''
    const cross = startKey && startKey < endKey ? { start: startKey, end: endKey } : null
    out.push({ task: t, kind: 'done', day: endKey, sortKey: end, cross, row: 0 })
  }
  return out
})

/** 已完成跨天任务的横条：起点=提醒(优先)/开始日，终点=完成日；与本月有交集即显示（归属日不在本月时只显示横条） */
const doneBars = computed<CrossBar[]>(() => {
  const out: CrossBar[] = []
  for (const t of props.tasks) {
    if (t.status !== 'completed') continue
    const startKey = taskStart(t) ? dateKeyOf(taskStart(t)) : ''
    const endKey = taskEnd(t) ? dateKeyOf(taskEnd(t)) : ''
    if (!startKey || !endKey || startKey >= endKey) continue
    if (endKey < monthFirst.value || startKey > monthLast.value) continue
    out.push({ task: t, kind: 'done', startKey, endKey, anchorDay: endKey, lane: 0 })
  }
  return out
})

/** 胶囊外未完成任务：非重复任务按提醒(优先)/开始时间归属当天；重复任务枚举本月所有发生日 */
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
        out.push({
          task: t,
          kind: 'pending',
          day: key,
          sortKey: `${key}T${time || '00:00'}`,
          cross: null,
          row: 0,
        })
      }
    } else {
      // 非重复：提醒(优先)/开始时间当天；有截止时间且跨天时连横条
      if (!start) continue
      const day = dateKeyOf(start)
      if (day.slice(0, 7) !== props.month) continue
      const endKey = t.endTime ? dateKeyOf(t.endTime) : ''
      const cross = endKey && endKey > day ? { start: day, end: endKey } : null
      out.push({ task: t, kind: 'pending', day, sortKey: start, cross, row: 0 })
    }
  }
  return out
})

/** 未完成跨天任务的横条：起点=提醒(优先)/开始日，终点=截止日 */
const pendingBars = computed<CrossBar[]>(() => {
  const out: CrossBar[] = []
  for (const chip of pendingChips.value) {
    if (!chip.cross) continue
    out.push({ task: chip.task, kind: 'pending', startKey: chip.cross.start, endKey: chip.cross.end, anchorDay: chip.day, lane: 0 })
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

const allBars = computed<CrossBar[]>(() => [...doneBars.value, ...pendingBars.value])

/** 单行任务块高度（px，含间距），横条按此行号对齐 */
const SLOT_H = 22
/** 格子顶部到第一行任务块顶部的偏移（px） */
const CELL_TOP = 26
/** 格子最小高度（px） */
const CELL_MIN_H = 104

/** 取小块当天内的时间（HH:mm），用于与横条一起排序 */
function chipTime(c: Chip): string {
  const m = /T(\d{2}:\d{2})/.exec(c.sortKey)
  return m ? m[1] : '00:00'
}

/** 横条在某一天的排序时间：已完成任务的完成日（锚点日）用完成时间，其余天用开始/提醒时间 */
function barTimeOn(b: CrossBar, day: string): string {
  if (b.kind === 'done' && day === b.endKey) return timeOfDay(taskEnd(b.task)) || '00:00'
  return timeOfDay(taskStart(b.task)) || '00:00'
}

/** 两个当天内的项（小块或横条）谁更早：先比时间，同时间按任务 id 稳定排序 */
function earlierThan(t1: string, id1: string, t2: string, id2: string): boolean {
  return t1 < t2 || (t1 === t2 && id1 < id2)
}

/** 日期键加一天（YYYY-MM-DD → 次日） */
function nextDay(key: string): string {
  const d = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)) + 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 横条在「当月可见日」的范围起点/终点（与本月交集截取） */
function visibleRange(b: CrossBar): { from: string; to: string } {
  const from = b.startKey < monthFirst.value ? monthFirst.value : b.startKey
  const to = b.endKey > monthLast.value ? monthLast.value : b.endKey
  return { from, to }
}

/**
 * 横条固定行号分配（单遍、天然收敛，绝不产生台阶/死循环顶高）：
 * 所有横条用「完成时间优先、开始/提醒时间兜底、id 再兜底」的同一把尺子定全局顺序，
 * 保证任意两天横条之间的相对顺序一致（不会因完成日切换排序依据而翻转）。
 * 每条横条的 lane = 它经过的所有可见日里，以下两者的最大值：
 *   - 当天时间早于它的普通任务小块数（保证这些小块都能排到它上方）；
 *   - 同一天经过的、全局顺序更靠前的横条的 lane + 1（保证同天横条行号严格递增、绝不重叠）。
 */
const laidOutBars = computed<CrossBar[]>(() => {
  const out = allBars.value.map((b) => ({ ...b, lane: 0 }))
  if (!out.length) return out
  // 全局一致顺序：完成时间（锚点日语义）优先，开始/提醒时间、任务 id 兜底
  const ordered = [...out].sort((a, b) => {
    const ea = taskEnd(a.task) || taskStart(a.task) || ''
    const eb = taskEnd(b.task) || taskStart(b.task) || ''
    const sa = taskStart(a.task) || ''
    const sb = taskStart(b.task) || ''
    return ea.localeCompare(eb) || sa.localeCompare(sb) || a.task.id.localeCompare(b.task.id)
  })
  const rank = new Map<CrossBar, number>(ordered.map((b, i) => [b, i]))
  // 每个可见日经过的横条（按全局顺序排列）
  const dayBars = new Map<string, CrossBar[]>()
  for (const b of out) {
    const { from, to } = visibleRange(b)
    if (from > to) continue
    let day = from
    while (day <= to) {
      const arr = dayBars.get(day) ?? []
      arr.push(b)
      dayBars.set(day, arr)
      day = nextDay(day)
    }
  }
  for (const arr of dayBars.values()) arr.sort((a, b) => rank.get(a)! - rank.get(b)!)
  // 按全局顺序单遍分配：先满足「当天早于它的小块数」，再满足「同天更早横条 lane+1」
  for (const b of ordered) {
    const { from, to } = visibleRange(b)
    if (from > to) continue
    let lane = 0
    let day = from
    while (day <= to) {
      const bt = barTimeOn(b, day)
      let chipCount = 0
      for (const c of chipsByDay.value.get(day) ?? []) {
        if (earlierThan(chipTime(c), c.task.id, bt, b.task.id)) chipCount++
      }
      lane = Math.max(lane, chipCount)
      for (const o of dayBars.get(day) ?? []) {
        if (o === b || rank.get(o)! >= rank.get(b)!) continue
        lane = Math.max(lane, o.lane + 1)
      }
      day = nextDay(day)
    }
    b.lane = lane
  }
  return out
})

/**
 * 按天给普通任务小块分配行号：
 * - 与横条同一任务的锚点小块：直接与横条同排（行号=横条 lane）；
 * - 其余小块：按时间排序填入横条未占用的行，早于横条的排上方、晚于的排下方；宁可留空也不重叠。
 */
const placedByDay = computed(() => {
  const map = new Map<string, Chip[]>()
  type Item = { kind: 'chip' | 'bar'; chip?: Chip; bar?: CrossBar; time: string; id: string }
  for (const day of chipsByDay.value.keys()) {
    const chips = chipsByDay.value.get(day) ?? []
    const bars = laidOutBars.value.filter((b) => day >= b.startKey && day <= b.endKey)
    const items: Item[] = []
    for (const c of chips) items.push({ kind: 'chip', chip: c, time: chipTime(c), id: c.task.id })
    for (const b of bars) items.push({ kind: 'bar', bar: b, time: barTimeOn(b, day), id: b.task.id })
    items.sort((a, b) => (a.time === b.time ? a.id.localeCompare(b.id) : a.time.localeCompare(b.time)))
    const occupied = new Set(bars.map((b) => b.lane))
    const placed: Chip[] = []
    for (const it of items) {
      if (it.kind === 'bar') continue
      const c = it.chip!
      // 锚点日：该横条对应的任务小块直接与横条同排对齐
      const ownBar = bars.find((b) => b.task.id === it.id)
      if (ownBar) {
        c.row = ownBar.lane
        placed.push(c)
        continue
      }
      // 早于小块的横条最大行号（小块必须在其下方）；晚于的横条最小行号（小块必须在其上方）
      let maxEarlier = -1
      let minLater = Infinity
      for (const b of bars) {
        if (b.task.id === it.id) continue
        if (earlierThan(barTimeOn(b, day), b.task.id, it.time, it.id)) maxEarlier = Math.max(maxEarlier, b.lane)
        else minLater = Math.min(minLater, b.lane)
      }
      const cap = 100
      let r = maxEarlier + 1
      while (r < cap && (occupied.has(r) || r >= minLater)) r++
      if (r >= minLater || r >= cap) {
        // 兜底：放到所有横条下方第一个空行（宁可顺序微调，绝不重叠）
        let base = -1
        for (const b of bars) base = Math.max(base, b.lane)
        r = Math.max(maxEarlier, base) + 1
        while (r < cap && occupied.has(r)) r++
      }
      c.row = r
      occupied.add(r)
      placed.push(c)
    }
    map.set(day, placed)
  }
  return map
})

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
  /** 横条所在行号（固定 lane，整根横条同一行） */
  topRow: number
}
interface WeekRow {
  cells: DayCell[]
  segments: BarSeg[]
  minH: number
}

/** 月历按周行组织；跨天横条切分到所在周行，垂直位置为固定 lane（整根直线）；小块按 placedByDay 绝对定位 */
const rows = computed<WeekRow[]>(() => {
  const rowCount = cellCount.value / 7
  const out: WeekRow[] = []
  const firstDate = new Date(year.value, monthIdx.value, 1 - firstCol.value)
  const pad = (n: number) => String(n).padStart(2, '0')
  const chipMap = placedByDay.value
  const bars = laidOutBars.value
  for (let r = 0; r < rowCount; r++) {
    const cells: DayCell[] = []
    let maxRow = -1
    for (let c = 0; c < 7; c++) {
      const d = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate() + r * 7 + c)
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      const inMonth = d.getMonth() === monthIdx.value
      const chips = inMonth ? chipMap.get(key) ?? [] : []
      let cellMax = -1
      for (const chip of chips) cellMax = Math.max(cellMax, chip.row)
      for (const b of bars) {
        if (key < b.startKey || key > b.endKey) continue
        cellMax = Math.max(cellMax, b.lane)
      }
      maxRow = Math.max(maxRow, cellMax)
      cells.push({ key, day: d.getDate(), inMonth, chips })
    }
    out.push({
      cells,
      segments: [],
      minH: Math.max(CELL_MIN_H, CELL_TOP + (maxRow + 1) * SLOT_H + 4),
    })
  }
  // 把每条跨天横条切成各周行的段（行末接行首，视觉连续）；跨月任务按「与本月交集」截取起止日
  for (const bar of bars) {
    const { from, to } = visibleRange(bar)
    if (from > to) continue
    const s = Number(from.slice(8, 10))
    const e = Number(to.slice(8, 10))
    const topRow = bar.lane
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
      out[r].segments.push({ bar, startCol, endCol, topRow })
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

/** 是否还能上月/下月（按年份过滤时在所选年 1 月/12 月禁用边界按钮） */
const canPrev = computed(() => !props.minMonth || props.month > props.minMonth)
const canNext = computed(() => !props.maxMonth || props.month < props.maxMonth)

function changeMonth(delta: number) {
  const d = new Date(year.value, monthIdx.value + delta, 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  const next = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
  // 跨年（超出所选年份）直接忽略：年份切换只经由「扫描时间胶囊文件」按钮
  if (props.minMonth && next < props.minMonth) return
  if (props.maxMonth && next > props.maxMonth) return
  emit('change-month', next)
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between">
      <button
        class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
        :disabled="!canPrev"
        @click="changeMonth(-1)"
      >
        <AppIcon name="chevron-left" :size="15" /> 上月
      </button>
      <div class="text-sm font-semibold text-slate-700">{{ year }}年{{ monthIdx + 1 }}月</div>
      <button
        class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
        :disabled="!canNext"
        @click="changeMonth(1)"
      >
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
        :style="{ minHeight: row.minH + 'px' }"
      >
        <div
          v-for="cell in row.cells"
          :key="cell.key"
          class="relative flex-1 border-r border-slate-100 p-1.5 last:border-r-0"
          :class="cell.inMonth ? 'bg-white' : 'bg-slate-50/70'"
        >
          <div class="flex items-center justify-between">
            <span class="text-[11px] leading-4" :class="cell.inMonth ? 'text-slate-600' : 'text-slate-300'">{{ cell.day }}</span>
            <span v-if="cell.chips.length" class="rounded bg-slate-100 px-1 text-[10px] leading-4 text-slate-500">{{ cell.chips.length }}</span>
          </div>
          <button
            v-for="(chip, ci) in cell.chips"
            :key="chip.task.id + '-' + chip.day + '-' + ci"
            class="absolute z-10 block h-[20px] truncate rounded px-1 text-left text-[10px] leading-[20px]"
            :class="chip.kind === 'done' ? 'bg-slate-100 text-slate-600 hover:bg-slate-200' : 'bg-amber-200/90 text-amber-800 hover:bg-amber-300/90'"
            :style="{ top: CELL_TOP + chip.row * SLOT_H + 'px', left: '6px', right: '6px' }"
            :title="chipTitle(chip)"
            @click="emit('open-task', chip.task)"
          >
            {{ chip.task.name }}
          </button>
        </div>
<!-- 跨天横条：整根固定同一行（无台阶），从开始日延伸到完成/截止日，与对应小块同排 -->
        <div
          v-for="(seg, si) in row.segments"
          :key="seg.bar.task.id + '-' + ri + '-' + si"
          class="absolute z-0 h-[20px] cursor-pointer rounded-full"
          :class="seg.bar.kind === 'done' ? 'bg-slate-100 hover:bg-slate-200' : 'bg-amber-200/90 hover:bg-amber-300/90'"
          :style="{
            left: (seg.startCol / 7) * 100 + '%',
            width: ((seg.endCol - seg.startCol + 1) / 7) * 100 + '%',
            top: CELL_TOP + seg.topRow * SLOT_H + 'px',
          }"
          :title="barTitle(seg.bar)"
          @click="emit('open-task', seg.bar.task)"
        ></div>
      </div>
    </div>
  </div>
</template>
