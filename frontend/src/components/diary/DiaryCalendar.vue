<template>
  <div class="flex flex-col h-full">
    <!-- 月份/年份切换 -->
    <div class="flex items-center justify-between px-2 pb-2">
      <div class="flex items-center gap-1">
        <button class="w-7 h-7 rounded-lg hover:bg-slate-200 text-slate-500" title="上一年" @click="shiftYear(-1)">«</button>
        <button class="w-7 h-7 rounded-lg hover:bg-slate-200 text-slate-500" title="上个月" @click="shiftMonth(-1)">‹</button>
      </div>
      <span class="text-sm font-semibold text-slate-700 select-none">{{ year }} 年 {{ month }} 月</span>
      <div class="flex items-center gap-1">
        <button class="w-7 h-7 rounded-lg hover:bg-slate-200 text-slate-500" title="下个月" @click="shiftMonth(1)">›</button>
        <button class="w-7 h-7 rounded-lg hover:bg-slate-200 text-slate-500" title="下一年" @click="shiftYear(1)">»</button>
      </div>
    </div>

    <!-- 星期表头：周一为一周开始 -->
    <div class="grid grid-cols-7 text-[11px] text-slate-400 text-center mb-1">
      <span v-for="w in WEEK_LABELS" :key="w">{{ w }}</span>
    </div>

    <!-- 日期网格 -->
    <div class="grid grid-cols-7 gap-y-1 text-center">
      <template v-for="(cell, i) in cells" :key="i">
        <div v-if="!cell" class="h-9" />
        <button
          v-else
          class="relative h-9 rounded-lg text-sm transition flex items-center justify-center"
          :class="[
            cell === selectedDay ? 'bg-brand text-white font-semibold' : 'text-slate-600 hover:bg-slate-200',
            isFuture(cell) ? 'opacity-40' : '',
          ]"
          @click="onPick(cell)"
        >
          {{ cell }}
          <span
            v-if="hasRecord(cell)"
            class="absolute bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full"
            :class="cell === selectedDay ? 'bg-white' : 'bg-green-500'"
          />
        </button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDiaryStore } from '@/stores/diary'
import { addDaysKey, todayKey } from '@/utils/time'

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

const diary = useDiaryStore()
const emit = defineEmits<{ pick: [] }>()

const today = todayKey()
const [ty, tm] = today.split('-').map(Number)
const year = ref(ty)
const month = ref(tm)

/** 当前选中日的 “日” 部分（跨月时用日期键比对） */
const selectedDay = computed(() => {
  const [sy, sm, sd] = diary.selectedDate.split('-').map(Number)
  return sy === year.value && sm === month.value ? sd : null
})

const pad = (n: number) => String(n).padStart(2, '0')

const cells = computed<Array<number | null>>(() => {
  const firstWeekday = (new Date(year.value, month.value - 1, 1).getDay() + 6) % 7
  const daysInMonth = new Date(year.value, month.value, 0).getDate()
  const arr: Array<number | null> = Array(firstWeekday).fill(null)
  for (let d = 1; d <= daysInMonth; d++) arr.push(d)
  return arr
})

const keyOf = (d: number) => `${year.value}-${pad(month.value)}-${pad(d)}`

const hasRecord = (d: number) => diary.hasRecordOn(keyOf(d))

function isFuture(d: number): boolean {
  return keyOf(d) > today
}

/** 切月时刷新该月有记录日期（仅 OSS list 取 key，不解密内容） */
function loadMonth(): void {
  void diary.refreshMonth(year.value, month.value)
}

function shiftMonth(delta: number): void {
  const m = month.value + delta
  if (m < 1) {
    month.value = 12
    year.value -= 1
  } else if (m > 12) {
    month.value = 1
    year.value += 1
  } else {
    month.value = m
  }
  loadMonth()
}

function shiftYear(delta: number): void {
  year.value += delta
  loadMonth()
}

async function onPick(d: number): Promise<void> {
  if (isFuture(d)) return
  await diary.selectDate(keyOf(d))
  emit('pick')
}

watch(month, loadMonth, { immediate: true })
</script>
