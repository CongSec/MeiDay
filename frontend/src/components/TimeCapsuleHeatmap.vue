<script setup lang="ts">
/**
 * 时间胶囊 - 年度热力图
 * GitHub 风格：以周为列、周一到周日为行，颜色深浅表示当天完成任务量
 * （只统计 status=completed，按 updatedAt 归属日期）。
 * 白色卡片固定不动，仅格子区域内部横向滚动；左侧星期标签对齐到对应行。
 */
import { computed } from 'vue'
import type { Task } from '@/types'
import { dateKeyOf } from '@/utils/time'
import AppIcon from '@/components/AppIcon.vue'

const props = defineProps<{
  tasks: Task[]
  year: number
}>()

// 按年份过滤：不再支持组件内切年（年份切换经由「扫描时间胶囊文件」按钮）

const MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
/** 左侧星期标签：7 行固定高度，与格子行严格一一对应（空串仅占位） */
const WEEK_LABELS = ['一', '', '三', '', '五', '', '日']

/** 每日完成数 */
const counts = computed(() => {
  const map = new Map<string, number>()
  for (const t of props.tasks) {
    if (t.status !== 'completed') continue
    const d = dateKeyOf(t.updatedAt)
    if (Number(d.slice(0, 4)) !== props.year) continue
    map.set(d, (map.get(d) ?? 0) + 1)
  }
  return map
})

const totalCount = computed(() => [...counts.value.values()].reduce((a, b) => a + b, 0))

const daysInYear = computed(() => {
  const next = new Date(props.year + 1, 0, 1).getTime()
  const cur = new Date(props.year, 0, 1).getTime()
  return Math.round((next - cur) / 86400000)
})
/** 1月1日在第几列（周一=0 … 周日=6） */
const startCol = computed(() => (new Date(props.year, 0, 1).getDay() + 6) % 7)
const weeks = computed(() => Math.ceil((startCol.value + daysInYear.value) / 7))

interface HeatCell {
  dateKey: string
  count: number
  inYear: boolean
}
/** weeks 列 × 7 行 */
const cells = computed<HeatCell[][]>(() => {
  const pad = (n: number) => String(n).padStart(2, '0')
  const out: HeatCell[][] = []
  for (let w = 0; w < weeks.value; w++) {
    const col: HeatCell[] = []
    for (let r = 0; r < 7; r++) {
      const dt = new Date(props.year, 0, 1 + w * 7 + r - startCol.value)
      const key = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
      const inYear = dt.getFullYear() === props.year
      col.push({ dateKey: key, count: inYear ? counts.value.get(key) ?? 0 : 0, inYear })
    }
    out.push(col)
  }
  return out
})

/** 各月在顶部标签条中的位置（所在周列） */
const monthPositions = computed(() => {
  const base = new Date(props.year, 0, 1).getTime()
  return MONTH_LABELS.map((label, m) => {
    const offset = Math.round((new Date(props.year, m, 1).getTime() - base) / 86400000)
    return { label, col: Math.floor((offset + startCol.value) / 7) }
  })
})

function colorOf(count: number): string {
  if (count <= 0) return '#EEF0F4'
  if (count === 1) return '#C3CBF0'
  if (count <= 3) return '#A3AEE6'
  if (count <= 6) return '#7C89D9'
  if (count <= 10) return '#5A6AD1'
  return '#3A49AD'
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between gap-2">
      <div class="text-sm font-semibold text-slate-700">{{ year }} 年 · 共完成 {{ totalCount }} 个任务</div>
      <div class="text-[11px] text-slate-400">切换年份请点击「扫描时间胶囊文件」</div>
    </div>

    <div class="mt-3 rounded-lg border border-slate-200 bg-white p-4">
      <div class="flex">
        <!-- 左侧星期标签：跳过月份标签行高度（pt-4），严格对齐 7 行格子 -->
        <div class="mr-1.5 flex w-4 shrink-0 flex-col gap-[3px] pt-4 text-[10px] leading-none text-slate-400">
          <div v-for="(lb, li) in WEEK_LABELS" :key="li" class="flex h-[13px] items-center justify-center">{{ lb }}</div>
        </div>
        <!-- 右侧：月份标签 + 格子，仅在格子区域内部横向滚动，白色卡片固定不动 -->
        <div class="min-w-0 flex-1 overflow-x-auto pb-1">
          <div class="min-w-[640px]">
            <div class="relative h-4 text-[10px] leading-4 text-slate-400">
              <span v-for="mp in monthPositions" :key="mp.label" class="absolute" :style="{ left: (mp.col / weeks) * 100 + '%' }">{{ mp.label }}</span>
            </div>
            <div class="flex gap-[3px]">
              <div v-for="(week, wi) in cells" :key="wi" class="flex flex-1 flex-col gap-[3px]">
                <div
                  v-for="(cell, ri) in week"
                  :key="cell.dateKey"
                  class="h-[13px] w-full shrink-0 rounded-[2px]"
                  :class="cell.inYear ? '' : 'opacity-0'"
                  :style="{ backgroundColor: colorOf(cell.count) }"
                  :title="cell.inYear ? `${cell.dateKey}：完成 ${cell.count} 个任务` : ''"
                ></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="mt-3 flex items-center justify-end gap-1 text-[10px] text-slate-400">
        少
        <span class="h-3 w-3 rounded-[2px]" style="background-color: #eef0f4"></span>
        <span class="h-3 w-3 rounded-[2px]" style="background-color: #c3cbf0"></span>
        <span class="h-3 w-3 rounded-[2px]" style="background-color: #a3aee6"></span>
        <span class="h-3 w-3 rounded-[2px]" style="background-color: #7c89d9"></span>
        <span class="h-3 w-3 rounded-[2px]" style="background-color: #5a6ad1"></span>
        <span class="h-3 w-3 rounded-[2px]" style="background-color: #3a49ad"></span>
        多
      </div>
    </div>
  </div>
</template>