<script setup lang="ts">
/**
 * 时间胶囊 - 工作量趋势
 * 只统计完成任务数量（status=completed，按 updatedAt 归属）。
 * 三种粒度：周（当年 1~53 周）、月（当年 1~12 月）、年（已加载的多年度对比）。
 */
import { computed, ref } from 'vue'
import type { Task } from '@/types'
import { dateKeyOf } from '@/utils/time'
import AppIcon from '@/components/AppIcon.vue'

const props = defineProps<{
  tasks: Task[]
  year: number
  /** 已加载年份（供「年」粒度展示；缺失时按任务数据推导） */
  years?: number[]
}>()

const emit = defineEmits<{ (e: 'change-year', year: number): void }>()

type Granularity = 'week' | 'month' | 'year'
const granularity = ref<Granularity>('month')
const GRANULARITIES: { key: Granularity; label: string }[] = [
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
  { key: 'year', label: '年' },
]

const daysInYear = computed(() => {
  const next = new Date(props.year + 1, 0, 1).getTime()
  const cur = new Date(props.year, 0, 1).getTime()
  return Math.round((next - cur) / 86400000)
})

const yearCompleted = computed(() =>
  props.tasks.filter((t) => t.status === 'completed' && Number(dateKeyOf(t.updatedAt).slice(0, 4)) === props.year),
)

interface Bucket {
  label: string
  value: number
  height: number
}

const weeklyBuckets = computed<Bucket[]>(() => {
  const counts = new Map<number, number>()
  const start = new Date(props.year, 0, 1).getTime()
  for (const t of yearCompleted.value) {
    const dt = new Date(`${dateKeyOf(t.updatedAt)}T00:00:00`).getTime()
    const dayOfYear = Math.round((dt - start) / 86400000) + 1
    const week = Math.ceil(dayOfYear / 7)
    counts.set(week, (counts.get(week) ?? 0) + 1)
  }
  const max = Math.max(1, ...counts.values())
  const totalWeeks = Math.ceil(daysInYear.value / 7)
  const out: Bucket[] = []
  for (let w = 1; w <= totalWeeks; w++) {
    const value = counts.get(w) ?? 0
    out.push({ label: `${w}周`, value, height: (value / max) * 100 })
  }
  return out
})

const monthlyBuckets = computed<Bucket[]>(() => {
  const counts = new Array(12).fill(0) as number[]
  for (const t of yearCompleted.value) {
    counts[Number(dateKeyOf(t.updatedAt).slice(5, 7)) - 1] += 1
  }
  const max = Math.max(1, ...counts)
  return counts.map((v, i) => ({ label: `${i + 1}月`, value: v, height: (v / max) * 100 }))
})

const yearlyBuckets = computed<Bucket[]>(() => {
  const counts = new Map<number, number>()
  for (const t of props.tasks) {
    if (t.status !== 'completed') continue
    const y = Number(dateKeyOf(t.updatedAt).slice(0, 4))
    counts.set(y, (counts.get(y) ?? 0) + 1)
  }
  const years = props.years && props.years.length ? [...props.years].sort((a, b) => a - b) : [...counts.keys()].sort((a, b) => a - b)
  if (!years.length) return []
  const max = Math.max(1, ...counts.values())
  return years.map((y) => ({ label: `${y}`, value: counts.get(y) ?? 0, height: ((counts.get(y) ?? 0) / max) * 100 }))
})

const activeBuckets = computed<Bucket[]>(() => {
  if (granularity.value === 'week') return weeklyBuckets.value
  if (granularity.value === 'month') return monthlyBuckets.value
  return yearlyBuckets.value
})
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex gap-0.5 rounded-lg bg-slate-100 p-0.5">
        <button
          v-for="g in GRANULARITIES"
          :key="g.key"
          class="rounded-md px-3 py-1 text-xs font-medium"
          :class="granularity === g.key ? 'bg-white text-brand shadow-sm' : 'text-slate-500 hover:text-slate-700'"
          @click="granularity = g.key"
        >
          {{ g.label }}
        </button>
      </div>
      <div v-if="granularity !== 'year'" class="flex items-center gap-1 text-sm font-semibold text-slate-700">
        <button class="rounded-lg border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50" @click="emit('change-year', year - 1)">
          <AppIcon name="chevron-left" :size="14" />
        </button>
        <span class="min-w-16 text-center">{{ year }}年（{{ yearCompleted.length }} 个）</span>
        <button class="rounded-lg border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50" @click="emit('change-year', year + 1)">
          <AppIcon name="chevron-right" :size="14" />
        </button>
      </div>
      <div v-else class="text-xs text-slate-400">按年份对比已完成任务量</div>
    </div>

    <div class="mt-3 rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
      <div class="flex h-40 items-end gap-[2px] sm:gap-1">
        <div
          v-for="(b, i) in activeBuckets"
          :key="i"
          class="group flex h-full flex-1 flex-col items-center justify-end"
        >
          <div class="mb-0.5 text-[10px] leading-3 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100">{{ b.value }}</div>
          <div
            class="w-full max-w-6 rounded-t bg-brand/70 transition-colors group-hover:bg-brand"
            :style="{ height: b.height + '%' }"
            :title="`${b.label}：完成 ${b.value} 个任务`"
          ></div>
        </div>
      </div>
      <div class="mt-1.5 flex gap-[2px] sm:gap-1 border-t border-slate-100 pt-1.5">
        <div v-for="(b, i) in activeBuckets" :key="i" class="flex-1 truncate text-center text-[10px] text-slate-400">{{ b.label }}</div>
      </div>
    </div>
  </div>
</template>
