<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- 顶部：日期切换条 -->
    <div class="flex items-center justify-between px-3 py-2 border-b border-slate-200 bg-white/80 shrink-0">
      <button
        class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40"
        :disabled="navBusy"
        title="上一天（有记录的）"
        @click="goPrev"
      >
        ‹ 上一天
      </button>
      <div class="text-sm font-semibold text-slate-700 truncate px-2">{{ selectedTitle }}</div>
      <button
        class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40"
        :disabled="navBusy"
        title="下一天（有记录的）"
        @click="goNext"
      >
        下一天 ›
      </button>
    </div>

    <!-- 时间线聊天区：进入保持空白；滚动上下跨天懒加载相邻有记录日期 -->
    <div
      ref="scrollEl"
      class="flex-1 overflow-y-auto overflow-x-hidden bg-[#f0f2f5] px-2 py-3"
      @scroll.passive="onScroll"
      @touchstart.passive="onTouchStart"
      @touchend.passive="onTouchEnd"
    >
      <!-- 顶部提示：向上滚动加载上一天 -->
      <div v-if="diary.dateKeys.length" class="flex justify-center py-1 select-none">
        <span v-if="topLoading" class="text-[11px] text-slate-400">正在加载上一天…</span>
        <span v-else-if="noMoreTop" class="text-[11px] text-slate-400/70">· 已到最早记录 ·</span>
      </div>

      <!-- 进入后未加载任何天：空白（懒加载，不自动读历史） -->
      <div v-if="diary.dateKeys.length === 0 && !selectedLoading" class="text-center text-slate-400 text-sm py-14 leading-relaxed">
        <div class="text-3xl mb-2">🕊️</div>
        请点击左侧日历选择某天查看，<br />或直接输入开始记录今天。
      </div>
      <div v-else-if="diary.dateKeys.length === 0" class="text-center text-xs text-slate-400 py-8">正在加载…</div>

      <!-- 每天一段：日期间用清晰横线分割 -->
      <template v-for="dateKey in diary.dateKeys" :key="dateKey">
        <div class="flex items-center gap-3 my-3" :data-day-key="dateKey">
          <div class="flex-1 h-px bg-slate-300" />
          <div class="text-[11px] text-slate-500 bg-white rounded-full px-2.5 py-0.5 shadow-sm select-none">
            {{ dayLabel(dateKey) }}
          </div>
          <div class="flex-1 h-px bg-slate-300" />
        </div>

        <div v-if="!(diary.days[dateKey] ?? []).length" class="text-center text-xs text-slate-400 py-6">
          {{ dateKey === todayKey() ? '今天暂无记录，输入内容即可开始' : '该天暂无记录' }}
        </div>
        <DiaryMessageBubble
          v-for="m in diary.days[dateKey] ?? []"
          :key="m.id"
          :message="m"
          @delete="(id: string) => onDelete(id, dateKey)"
        />
      </template>

      <!-- 底部提示：向下滚动加载下一天 -->
      <div v-if="diary.dateKeys.length" class="flex justify-center py-1 select-none">
        <span v-if="bottomLoading" class="text-[11px] text-slate-400">正在加载下一天…</span>
        <span v-else-if="noMoreBottom" class="text-[11px] text-slate-400/70">· 已到最新记录 ·</span>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="border-t border-slate-200 bg-white px-2 py-2 space-y-1.5 shrink-0" @dragover.prevent @drop.prevent="onDrop">
      <div
        v-if="dragging"
        class="rounded-lg border-2 border-dashed border-brand/60 bg-brand/5 text-center text-sm text-brand py-2"
      >
        松开以发送文件
      </div>
      <div class="flex items-end gap-1.5">
        <button
          class="w-9 h-9 rounded-lg hover:bg-slate-100 text-xl flex items-center justify-center shrink-0"
          title="发送文件"
          @click="fileInput?.click()"
        >📎</button>
        <button
          class="w-9 h-9 rounded-lg text-xl flex items-center justify-center shrink-0"
          :class="recording ? 'text-red-500 bg-red-50 animate-pulse' : 'hover:bg-slate-100'"
          :title="recording ? '点击停止并发送' : '语音输入'"
          @click="toggleRecord"
        >
          {{ recording ? '⏹' : '🎙️' }}
        </button>
        <textarea
          ref="textInput"
          v-model="draft"
          rows="1"
          placeholder="输入日记内容，Enter 发送，Ctrl+V 可粘贴文件…"
          class="flex-1 resize-none border rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand/50 max-h-32"
          @keydown.enter.exact.prevent="onSendText"
          @keydown.enter.shift.exact="insertNewline"
          @paste="onPaste"
        />
        <button
          class="h-9 px-4 rounded-xl bg-brand text-white text-sm font-medium hover:bg-brand-dark disabled:opacity-60 shrink-0"
          :disabled="diary.sending"
          @click="onSendText"
        >
          发送
        </button>
      </div>
      <div v-if="recording" class="flex items-center gap-2 px-1 text-xs text-red-500">
        <span class="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
        正在录音 {{ recSeconds }}s，点击 🎙️ 停止并发送
      </div>
      <input ref="fileInput" type="file" multiple class="hidden" @change="onFileChange" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import DiaryMessageBubble from './DiaryMessageBubble.vue'
import { useDiaryStore } from '@/stores/diary'
import { useUiStore } from '@/stores/ui'
import { todayKey } from '@/utils/time'

const diary = useDiaryStore()
const ui = useUiStore()

const draft = ref('')
const scrollEl = ref<HTMLElement | null>(null)
const textInput = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const navBusy = ref(false)
const dragging = ref(false)

/* 跨天滚动守卫：同一时刻只允许一个方向、且只在用户继续滚动时再触发 */
const topLoading = ref(false)
const bottomLoading = ref(false)
const noMoreTop = ref(false)
const noMoreBottom = ref(false)
const MAX_DAYS = 30

const selectedLoading = computed(() => !!diary.loadingDates[diary.selectedDate])

const selectedTitle = computed(() => {
  const d = diary.selectedDate
  if (!d) return ''
  return formatTitle(d)
})

function dayLabel(dateKey: string): string {
  const [y, m, day] = dateKey.split('-')
  const week = ['日', '一', '二', '三', '四', '五', '六'][new Date(`${dateKey}T00:00:00+08:00`).getDay()]
  const prefix = dateKey === todayKey() ? '今天 · ' : ''
  return `${prefix}${y}/${Number(m)}/${Number(day)} 周${week}`
}
function formatTitle(dateKey: string): string {
  const [y, m, day] = dateKey.split('-')
  return `${y}年${Number(m)}月${Number(day)}日`
}

function insertNewline(): void {
  const el = textInput.value
  if (!el) return
  const s = el.selectionStart ?? draft.value.length
  draft.value = draft.value.slice(0, s) + '\n' + draft.value.slice(el.selectionEnd ?? s)
  void nextTick(() => {
    el.selectionStart = el.selectionEnd = s + 1
  })
}

async function onSendText(): Promise<void> {
  const text = draft.value.trim()
  if (!text) return
  draft.value = ''
  try {
    await diary.sendText(text)
    ui.toast('发送成功 · 已加密保存到云端')
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : '发送失败', 'error')
  }
}

async function sendFiles(files: FileList | File[]): Promise<void> {
  const arr = Array.from(files).filter((f) => f.size > 0)
  if (!arr.length) return
  try {
    for (const f of arr) {
      const isAudio = f.type.startsWith('audio/')
      await diary.sendFile(f, isAudio ? 'audio' : 'file')
    }
    ui.toast(`发送成功${arr.length > 1 ? `（${arr.length} 项）` : ''} · 已加密保存到云端`)
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : '发送失败', 'error')
  }
}

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement
  if (input.files?.length) void sendFiles(input.files)
  input.value = ''
}

function onPaste(e: ClipboardEvent): void {
  const files = e.clipboardData?.files
  if (files && files.length) {
    e.preventDefault()
    void sendFiles(files)
  }
}

let dragDepth = 0
function onDrop(e: DragEvent): void {
  dragDepth = 0
  dragging.value = false
  if (e.dataTransfer?.files.length) void sendFiles(e.dataTransfer.files)
}

/* ---------- 上一天 / 下一天（相邻有记录的日期，重置时间线） ---------- */
async function goToDay(dateKey: string | null): Promise<void> {
  if (!dateKey) {
    ui.toast('没有更早/更晚的日记记录了', 'error')
    return
  }
  navBusy.value = true
  try {
    await diary.selectDate(dateKey)
  } finally {
    navBusy.value = false
  }
}

async function goPrev(): Promise<void> {
  const target = await diary.findRecordedDate(diary.selectedDate, -1)
  await goToDay(target)
}
async function goNext(): Promise<void> {
  const target = await diary.findRecordedDate(diary.selectedDate, 1)
  await goToDay(target)
}

/* ---------- 横向滑动切换上/下一天 ---------- */
let touchStartX = 0
let touchStartY = 0
function onTouchStart(e: TouchEvent): void {
  touchStartX = e.touches[0].clientX
  touchStartY = e.touches[0].clientY
}
function onTouchEnd(e: TouchEvent): void {
  const dx = e.changedTouches[0].clientX - touchStartX
  const dy = e.changedTouches[0].clientY - touchStartY
  if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.2) {
    if (dx < 0) void goNext()
    else void goPrev()
  }
}

/* ---------- 滚动跨天（上下滑动加载相邻有记录日期） ---------- */
function resetScrollGuards(): void {
  topLoading.value = false
  bottomLoading.value = false
  noMoreTop.value = false
  noMoreBottom.value = false
}

function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  // 向上滚动到接近顶部 → 加载上一天（追加到时间线顶部）
  if (!topLoading.value && !noMoreTop.value && el.scrollTop <= 64) {
    void loadPrev()
  }
  // 向下滚动到接近底部 → 加载下一天（追加到时间线底部）
  if (!bottomLoading.value && !noMoreBottom.value && el.scrollHeight - el.scrollTop - el.clientHeight <= 64) {
    void loadNext()
  }
  updateActiveDay()
}

async function loadPrev(): Promise<void> {
  if (topLoading.value || noMoreTop.value) return
  const first = diary.dateKeys[0]
  if (!first) return
  topLoading.value = true
  try {
    const target = await diary.loadPrevRecorded(first)
    if (!target) {
      noMoreTop.value = true
      return
    }
    await nextTick()
    await trimTimeline(true)
    updateActiveDay()
  } finally {
    topLoading.value = false
  }
}

async function loadNext(): Promise<void> {
  if (bottomLoading.value || noMoreBottom.value) return
  const last = diary.dateKeys[diary.dateKeys.length - 1]
  if (!last) return
  bottomLoading.value = true
  try {
    const target = await diary.loadNextRecorded(last)
    if (!target) {
      noMoreBottom.value = true
      return
    }
    await nextTick()
    await trimTimeline(false)
    updateActiveDay()
  } finally {
    bottomLoading.value = false
  }
}

/** 内存保护：时间线超过上限时卸载远端的一天，避免大量历史常驻 */
async function trimTimeline(keepTop: boolean): Promise<void> {
  const keys = diary.dateKeys
  if (keys.length <= MAX_DAYS) return
  const toRemove = keepTop ? keys.slice(MAX_DAYS) : keys.slice(0, keys.length - MAX_DAYS)
  for (const k of toRemove) await diary.unloadDay(k)
}

/** 滚动时把「当前选中天」更新为视口顶部区域可见的天（决定发送目标与标题） */
function updateActiveDay(): void {
  const el = scrollEl.value
  if (!el) return
  const contRect = el.getBoundingClientRect()
  const mid = contRect.top + Math.min(140, el.clientHeight * 0.4)
  const sections = Array.from(el.querySelectorAll<HTMLElement>('[data-day-key]'))
  let active: string | null = null
  for (const s of sections) {
    if (s.getBoundingClientRect().top <= mid) active = s.dataset.dayKey ?? null
    else break
  }
  if (active && active !== diary.selectedDate) diary.setSelected(active)
}

/* ---------- 语音录音 ---------- */
let mediaRecorder: MediaRecorder | null = null
let recChunks: Blob[] = []
let recStartAt = 0
let recTimer: number | undefined
const recording = ref(false)
const recSeconds = ref(0)

async function toggleRecord(): Promise<void> {
  if (recording.value) {
    stopRecord()
    return
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    ui.toast('当前浏览器不支持录音', 'error')
    return
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mime = MediaRecorder.isTypeSupported('audio/webm')
      ? 'audio/webm'
      : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : ''
    mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    recChunks = []
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recChunks.push(e.data)
    }
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      if (recTimer !== undefined) window.clearInterval(recTimer)
      recording.value = false
      const blob = new Blob(recChunks, { type: mediaRecorder?.mimeType || 'audio/webm' })
      if (blob.size > 0) {
        const duration = Math.max(1, Math.round((Date.now() - recStartAt) / 1000))
        const ext = (mediaRecorder?.mimeType ?? '').includes('mp4') ? 'm4a' : 'webm'
        const file = new File([blob], `语音_${Date.now()}.${ext}`, { type: mediaRecorder?.mimeType || 'audio/webm' })
        try {
          await diary.sendFile(file, 'audio', { duration })
          ui.toast('发送成功 · 已加密保存到云端')
        } catch (err) {
          ui.toast(err instanceof Error ? err.message : '发送失败', 'error')
        }
      }
    }
    mediaRecorder.start()
    recStartAt = Date.now()
    recSeconds.value = 0
    recTimer = window.setInterval(() => {
      recSeconds.value = Math.round((Date.now() - recStartAt) / 1000)
    }, 1000)
    recording.value = true
  } catch {
    ui.toast('无法访问麦克风，请检查权限', 'error')
  }
}

function stopRecord(): void {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop()
  recording.value = false
}

/* ---------- 删除单条消息 ---------- */
async function onDelete(msgId: string, dateKey: string): Promise<void> {
  try {
    await diary.deleteMessage(dateKey, msgId)
    ui.toast('已删除')
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : '删除失败', 'error')
  }
}

/* ---------- 生命周期 ---------- */
onMounted(() => {
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragleave', onDragLeave)
})
onUnmounted(() => {
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragleave', onDragLeave)
  if (recTimer !== undefined) window.clearInterval(recTimer)
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop()
})

function onDragEnter(e: DragEvent): void {
  if (e.dataTransfer?.types.includes('Files')) {
    dragDepth++
    dragging.value = true
  }
}
function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

/* 时间线被重置（点击日历 / 上一天 / 下一天）：回到顶部并重置跨天守卫 */
watch(
  () => diary.timelineVersion,
  () => {
    resetScrollGuards()
    void nextTick(() => {
      if (scrollEl.value) scrollEl.value.scrollTop = 0
    })
  },
)
</script>
