<template>
  <div class="fixed inset-0 z-[65] bg-slate-100 flex flex-col">
    <!-- 回顾顶栏：返回今天 = 退出回顾 -->
    <header class="h-12 shrink-0 bg-white border-b border-slate-100 flex items-center gap-1 px-2 md:px-4 z-[60]">
      <span class="text-xl shrink-0">📚</span>
      <span class="font-bold whitespace-nowrap text-slate-800">日记回顾</span>
      <div class="flex-1" />
      <button
        class="px-2 md:px-3 py-1.5 rounded-lg text-xs md:text-sm text-slate-600 hover:bg-slate-100 whitespace-nowrap"
        @click="$emit('close')"
      >
        ← 返回今天
      </button>
    </header>

    <!-- 起止年月日选择 -->
    <div class="shrink-0 bg-white border-b border-slate-200 px-3 py-2 flex flex-wrap items-center gap-2">
      <label class="flex items-center gap-1.5 text-xs text-slate-600">
        从
        <input
          v-model="startKey"
          type="date"
          class="border rounded-lg px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-brand/50"
        />
      </label>
      <span class="text-xs text-slate-400">至</span>
      <label class="flex items-center gap-1.5 text-xs text-slate-600">
        <input
          v-model="endKey"
          type="date"
          class="border rounded-lg px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-brand/50"
        />
      </label>
      <button
        class="px-3 py-1.5 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-dark disabled:opacity-60"
        :disabled="reviewLoading"
        @click="doLoad"
      >
        {{ reviewLoading ? '加载中…' : '查询' }}
      </button>
      <span v-if="summary" class="text-[11px] text-slate-400 ml-auto">{{ summary }}</span>
    </div>

    <!-- 只读时间线：按天分组，图片可点开、音频可播放，无输入框 -->
    <div class="flex-1 overflow-y-auto overflow-x-hidden bg-[#f0f2f5] px-2 py-3">
      <div v-if="reviewLoading" class="text-center text-xs text-slate-400 py-12">正在加载回顾数据…</div>
      <div v-else-if="searched && !diary.reviewDays.length" class="text-center text-slate-400 text-sm py-14 leading-relaxed">
        <div class="text-3xl mb-2">🔍</div>
        该时间段内没有日记记录
      </div>
      <template v-else>
        <template v-for="day in diary.reviewDays" :key="day.dateKey">
          <div class="flex items-center gap-3 my-3">
            <div class="flex-1 h-px bg-slate-300" />
            <div class="text-[11px] text-slate-500 bg-white rounded-full px-2.5 py-0.5 shadow-sm select-none">
              {{ dayTitle(day.dateKey) }}
            </div>
            <div class="flex-1 h-px bg-slate-300" />
          </div>
          <template v-for="row in rowsOf(day.messages)" :key="row.key">
            <template v-if="row.kind === 'images'">
              <DiaryImageGroup v-if="row.msgs.length > 1" :messages="row.msgs" readonly />
              <DiaryMessageBubble v-else :message="row.msgs[0]" readonly />
            </template>
            <DiaryMessageBubble v-else :message="row.msg" readonly />
          </template>
        </template>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import DiaryMessageBubble from './DiaryMessageBubble.vue'
import DiaryImageGroup from './DiaryImageGroup.vue'
import { useDiaryStore } from '@/stores/diary'
import { useUiStore } from '@/stores/ui'
import { addDaysKey, todayKey } from '@/utils/time'
import type { DiaryMessage } from '@/types'

const emit = defineEmits<{ close: [] }>()

const diary = useDiaryStore()
const ui = useUiStore()

/* 默认最近 7 天 */
const endKey = ref(todayKey())
const startKey = ref(addDaysKey(todayKey(), -6))
const searched = ref(false)

const reviewLoading = computed(() => diary.reviewLoading)
const summary = computed(() => {
  if (!searched.value || reviewLoading.value) return ''
  const messages = diary.reviewDays.reduce((n, d) => n + d.messages.length, 0)
  return `共 ${diary.reviewDays.length} 天 / ${messages} 条记录`
})

/** 同一天内连续相邻的图片消息合并为一组（与聊天区观感一致） */
type ChatRow =
  | { key: string; kind: 'single'; msg: DiaryMessage }
  | { key: string; kind: 'images'; msgs: DiaryMessage[] }
function rowsOf(msgs: DiaryMessage[]): ChatRow[] {
  const rows: ChatRow[] = []
  for (const m of msgs) {
    const isImg = m.type === 'file' && !!m.file?.mime.startsWith('image/')
    const last = rows[rows.length - 1]
    if (isImg && last?.kind === 'images') {
      last.msgs.push(m)
    } else if (isImg) {
      rows.push({ key: m.id, kind: 'images', msgs: [m] })
    } else {
      rows.push({ key: m.id, kind: 'single', msg: m })
    }
  }
  return rows
}

function dayTitle(dateKey: string): string {
  const [y, m, day] = dateKey.split('-')
  const week = ['日', '一', '二', '三', '四', '五', '六'][new Date(`${dateKey}T00:00:00+08:00`).getDay()]
  const prefix = dateKey === todayKey() ? '今天 · ' : ''
  return `${prefix}${y}/${Number(m)}/${Number(day)} 周${week}`
}

async function doLoad(): Promise<void> {
  if (!startKey.value || !endKey.value) {
    ui.toast('请选择起止日期', 'error')
    return
  }
  if (startKey.value > endKey.value) {
    ui.toast('开始日期不能晚于结束日期', 'error')
    return
  }
  searched.value = true
  try {
    await diary.loadReview(startKey.value, endKey.value)
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : '回顾加载失败', 'error')
  }
}
</script>
