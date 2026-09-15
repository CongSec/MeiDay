<script setup lang="ts">
/**
 * 时间胶囊 - 工作量趋势图
 * 点线图（散点 + 连线），三个分类：本周 / 本月 / 本年，支持翻看历史。
 * 只统计完成任务数量（status=completed，按 updatedAt 归属）。
 * 本周=周一~周日逐日、本月=1号~月末逐日、本年=1~12月逐月。
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { Task } from '@/types'
import { addDaysKey, dateKeyOf } from '@/utils/time'
import AppIcon from '@/components/AppIcon.vue'

const props = defineProps<{
  tasks: Task[]
  year: number
}>()

const emit = defineEmits<{ (e: 'change-year', year: number): void }>()

type Mode = 'week' | 'month' | 'year'
const mode = ref<Mode>('week')
const MODES: { key: Mode; label: string }[] = [
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'year', label: '本年' },
]

const pad = (n: number) => String(n).padStart(2, '0')
function mondayOf(d: Date): string {
  const day = (d.getDay() + 6) % 7
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day)
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}
/** 当前周期状态：本周周一 / 本月（YYYY-MM）；「本年」直接用 props.year */
const now = new Date()
const weekStartKey = ref(mondayOf(now))
const monthKey = ref(`${props.year}-${pad(now.getMonth() + 1)}`)

function shortKey(key: string): string {
  return `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`
}

interface Point {
  label: string
  value: number
}

const weekPoints = computed<Point[]>(() => {
  const start = weekStartKey.value
  const end = addDaysKey(start, 6)
  const counts = new Map<string, number>()
  for (const t of props.tasks) {
    if (t.status !== 'completed') continue
    const d = dateKeyOf(t.updatedAt)
    if (d >= start && d <= end) counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  const out: Point[] = []
  for (let i = 0; i < 7; i++) {
    const key = addDaysKey(start, i)
    out.push({ label: shortKey(key), value: counts.get(key) ?? 0 })
  }
  return out
})

const monthPoints = computed<Point[]>(() => {
  const [y, m] = monthKey.value.split('-').map(Number)
  const days = new Date(y, m, 0).getDate()
  const counts = new Array(days).fill(0) as number[]
  const prefix = `${monthKey.value}-`
  for (const t of props.tasks) {
    if (t.status !== 'completed') continue
    const d = dateKeyOf(t.updatedAt)
    if (!d.startsWith(prefix)) continue
    counts[Number(d.slice(8, 10)) - 1] += 1
  }
  return counts.map((v, i) => ({ label: `${i + 1}`, value: v }))
})

const yearPoints = computed<Point[]>(() => {
  const counts = new Array(12).fill(0) as number[]
  const prefix = `${props.year}-`
  for (const t of props.tasks) {
    if (t.status !== 'completed') continue
    const d = dateKeyOf(t.updatedAt)
    if (!d.startsWith(prefix)) continue
    counts[Number(d.slice(5, 7)) - 1] += 1
  }
  return counts.map((v, i) => ({ label: `${i + 1}月`, value: v }))
})

const activePoints = computed<Point[]>(() => {
  if (mode.value === 'week') return weekPoints.value
  if (mode.value === 'month') return monthPoints.value
  return yearPoints.value
})

const periodTotal = computed(() => activePoints.value.reduce((n, p) => n + p.value, 0))

const periodTitle = computed(() => {
  if (mode.value === 'week') {
    return `${shortKey(weekStartKey.value)} ~ ${shortKey(addDaysKey(weekStartKey.value, 6))}`
  }
  if (mode.value === 'month') {
    const [y, m] = monthKey.value.split('-').map(Number)
    return `${y}年${m}月`
  }
  return `${props.year}年`
})

/** 确保某年数据已加载（未加载时通知父级按需加载） */
function ensureYear(y: number) {
  if (y === props.year) return
  const has = props.tasks.some((t) => t.status === 'completed' && Number(dateKeyOf(t.updatedAt).slice(0, 4)) === y)
  if (!has) emit('change-year', y)
}

/** 切换周期：上/下一周、上/下一月、上/下一年 */
function shift(delta: number) {
  if (mode.value === 'week') {
    weekStartKey.value = addDaysKey(weekStartKey.value, delta * 7)
    const s = weekStartKey.value
    ensureYear(Number(s.slice(0, 4)))
    ensureYear(Number(addDaysKey(s, 6).slice(0, 4)))
  } else if (mode.value === 'month') {
    const [y, m] = monthKey.value.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)
    monthKey.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
    ensureYear(d.getFullYear())
  } else {
    emit('change-year', props.year + delta)
  }
}

// 进入/切换分类时，确保当前周期所在年份已加载（例如在 2025 年视图下看「本周」需要 2026 数据）
watch(mode, (m) => {
  if (m === 'year') return
  const y = m === 'week' ? Number(weekStartKey.value.slice(0, 4)) : Number(monthKey.value.slice(0, 4))
  ensureYear(y)
})
onMounted(() => {
  if (mode.value === 'year') return
  const y = mode.value === 'week' ? Number(weekStartKey.value.slice(0, 4)) : Number(monthKey.value.slice(0, 4))
  ensureYear(y)
})

/** SVG 折线图 */
const CHART_H = 180
const PAD_X = 30
const PAD_TOP = 18
const PAD_BOTTOM = 26
const chartW = computed(() => Math.max(560, activePoints.value.length * 30))
const maxVal = computed(() => Math.max(1, ...activePoints.value.map((p) => p.value)))

interface LinePoint extends Point {
  x: number
  y: number
}
const linePoints = computed<LinePoint[]>(() => {
  const n = activePoints.value.length
  const stepX = (chartW.value - PAD_X * 2) / Math.max(1, n - 1)
  const innerH = CHART_H - PAD_TOP - PAD_BOTTOM
  return activePoints.value.map((p, i) => ({
    ...p,
    x: Math.round(PAD_X + i * stepX),
    y: Math.round(CHART_H - PAD_BOTTOM - (p.value / maxVal.value) * innerH),
  }))
})
/** 横轴标签：本月点太多时按密度抽样显示 */
const axisItems = computed(() => {
  const n = linePoints.value.length
  const step = Math.max(1, Math.ceil(n / 12))
  return linePoints.value.filter((_, i) => i % step === 0 || i === n - 1)
})
/** 横向网格线（4 等分） */
const gridLines = computed(() => {
  const innerH = CHART_H - PAD_TOP - PAD_BOTTOM
  return [0, 1, 2, 3, 4].map((i) => ({
    y: Math.round(CHART_H - PAD_BOTTOM - (i / 4) * innerH),
  }))
})
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex gap-0.5 rounded-lg bg-slate-100 p-0.5">
        <button
          v-for="m in MODES"
          :key="m.key"
          class="rounded-md px-3 py-1 text-xs font-medium"
          :class="mode === m.key ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'"
          @click="mode = m.key"
        >
          {{ m.label }}
        </button>
      </div>
      <div class="flex items-center gap-1 text-sm font-semibold text-slate-700">
        <button class="rounded-lg border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50" @click="shift(-1)">
          <AppIcon name="chevron-left" :size="14" />
        </button>
        <span class="min-w-28 text-center">{{ periodTitle }}（{{ periodTotal }} 个）</span>
        <button class="rounded-lg border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50" @click="shift(1)">
          <AppIcon name="chevron-right" :size="14" />
        </button>
      </div>
    </div>

    <div class="mt-3 rounded-lg border border-slate-200 bg-white p-3 sm:p-4">
      <div class="overflow-x-auto pb-1">
        <svg :width="chartW" :height="CHART_H" class="block">
          <line
            v-for="(g, gi) in gridLines"
            :key="gi"
            :x1="PAD_X"
            :x2="chartW - PAD_X"
            :y1="g.y"
            :y2="g.y"
            stroke="#EEF0F4"
            stroke-width="1"
          />
          <polyline
            :points="linePoints.map((p) => p.x + ',' + p.y).join(' ')"
            fill="none"
            stroke="#4557C9"
            stroke-width="2"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
          <g v-for="(p, i) in linePoints" :key="i">
            <circle :cx="p.x" :cy="p.y" r="3.5" fill="#ffffff" stroke="#4557C9" stroke-width="2">
              <title>{{ p.label }}：完成 {{ p.value }} 个任务</title>
            </circle>
          </g>
          <text
            v-for="(lb, i) in axisItems"
            :key="i"
            :x="lb.x"
            :y="CHART_H - 8"
            text-anchor="middle"
            font-size="10"
            fill="#98A1AC"
          >
            {{ lb.label }}
          </text>
        </svg>
      </div>
    </div>
  </div>
</template>