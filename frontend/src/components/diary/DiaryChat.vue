<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- 顶部：当前日期标题（默认今天；仅通过日历切换日期，滑动/按钮不跨天加载） -->
    <div class="flex items-center justify-center px-3 py-2 border-b border-slate-100 bg-white shrink-0">
      <div class="text-sm font-semibold text-slate-800 truncate px-2">{{ selectedTitle }}</div>
    </div>

    <!-- 时间线聊天区：进入默认今天+空白；从日历点选某天只加载那一天 -->
    <div ref="scrollEl" class="flex-1 overflow-y-auto overflow-x-hidden bg-slate-100 px-2 py-3">
      <!-- 未加载任何天（默认今天，空白聊天框，不自动读历史） -->
      <div v-if="!dayLoaded" class="text-center text-slate-400 text-sm py-14 leading-relaxed">
        <div class="text-3xl mb-2">🕊️</div>
        点日历中的日期可查看那天/更早的历史。
      </div>

      <!-- 已加载但当天无记录 -->
      <div v-else-if="!messages.length" class="text-center text-xs text-slate-400 py-6">
        {{ selectedDate === todayKey() ? '今天暂无记录，输入内容即可开始' : '该天暂无记录' }}
      </div>

      <!-- 已加载的单天消息 -->
      <template v-else>
        <div class="flex items-center gap-3 my-3" :data-day-key="selectedDate">
          <div class="flex-1 h-px bg-slate-300" />
          <div class="text-[11px] text-slate-500 bg-white rounded-full px-2.5 py-0.5 shadow-sm select-none">
            {{ dayLabel(selectedDate) }}
          </div>
          <div class="flex-1 h-px bg-slate-300" />
        </div>

        <template v-for="row in rowsOf(messages)" :key="row.key">
          <template v-if="row.kind === 'images'">
            <DiaryImageGroup
              v-if="row.msgs.length > 1"
              :messages="row.msgs"
              @delete="(id: string) => onDelete(id, selectedDate)" />
            <DiaryMessageBubble
              v-else
              :message="row.msgs[0]"
              @delete="(id: string) => onDelete(id, selectedDate)" />
          </template>
          <DiaryMessageBubble
            v-else
            :message="row.msg"
            @delete="(id: string) => onDelete(id, selectedDate)" />
        </template>
      </template>
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
          class="flex-1 resize-none overflow-y-auto border rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand/50 max-h-32"
          @input="autoResize"
          @keydown.enter.exact.prevent="onSendText"
          @keydown.enter.shift.exact="insertNewline"
          @paste="onPaste"
        />
        <button
          class="h-9 px-4 rounded-xl bg-brand text-white text-sm font-medium hover:bg-brand-dark disabled:opacity-60 shrink-0"
          @click="onSendText"
        >
          发送
        </button>
      </div>
      <div v-if="recording" class="flex items-center gap-2 px-1 text-xs text-red-500">
        <span class="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
        正在录音 {{ recSeconds }}s，点击 🎙️ 停止并发送
      </div>
      <!-- 后台文件/语音上传进度：多文件并行，处理中显示占位，上传阶段显示百分比；不阻塞文字输入 -->
      <div v-if="diary.uploads.length" class="flex flex-col gap-1 px-1 text-xs text-brand">
        <div class="flex items-center gap-2">
          <span class="inline-block w-2 h-2 rounded-full bg-brand animate-pulse shrink-0" />
          <span class="truncate max-w-[280px]">正在后台上传 {{ diary.uploads.length }} 个文件…</span>
        </div>
        <div v-for="u in diary.uploads" :key="u.id" class="flex items-center gap-2 pl-3">
          <span class="truncate max-w-[240px] text-slate-600">{{ u.name }}</span>
          <span class="shrink-0">{{ u.percent !== null ? u.percent + '%' : '处理中' }}</span>
        </div>
      </div>
      <input ref="fileInput" type="file" multiple class="hidden" @change="onFileChange" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import DiaryMessageBubble from './DiaryMessageBubble.vue'
import DiaryImageGroup from './DiaryImageGroup.vue'
import { useDiaryStore } from '@/stores/diary'
import { useUiStore } from '@/stores/ui'
import { todayKey } from '@/utils/time'
import type { DiaryMessage } from '@/types'

const diary = useDiaryStore()
const ui = useUiStore()

const draft = ref('')
const scrollEl = ref<HTMLElement | null>(null)
const textInput = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)

/** 同一天内连续相邻的图片消息合并为一组（折叠展示）；文本/语音/其它文件作为单条渲染 */
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

const selectedDate = computed(() => diary.selectedDate)
const dayLoaded = computed(() => !!diary.loadedDates[diary.selectedDate])
const messages = computed(() => diary.days[diary.selectedDate] ?? [])

const selectedTitle = computed(() => formatTitle(diary.selectedDate))

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

/** 输入框随内容自动增高，最高 128px（max-h-32），超出后内部滚动 */
function autoResize(): void {
  const el = textInput.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 128) + 'px'
}

function insertNewline(): void {
  const el = textInput.value
  if (!el) return
  const s = el.selectionStart ?? draft.value.length
  draft.value = draft.value.slice(0, s) + '\n' + draft.value.slice(el.selectionEnd ?? s)
  void nextTick(() => {
    el.selectionStart = el.selectionEnd = s + 1
    autoResize()
  })
}

async function onSendText(): Promise<void> {
  const text = draft.value.trim()
  if (!text) return
  draft.value = ''
  void nextTick(() => {
    const el = textInput.value
    if (el) el.style.height = ''
  })
  try {
    await diary.sendText(text)
    ui.toast('发送成功 · 已加密保存到云端')
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : '发送失败', 'error')
  }
}

/** 后台上传：多文件并行，不阻塞继续输入/发送文字；全部完成后提示一次 */
function sendFiles(files: FileList | File[]): void {
  const arr = Array.from(files).filter((f) => f.size > 0)
  if (!arr.length) return
  const pending = arr.map((f) => {
    const isAudio = f.type.startsWith('audio/')
    return diary.sendFile(f, isAudio ? 'audio' : 'file').catch((e) => {
      ui.toast(e instanceof Error ? e.message : '发送失败', 'error')
    })
  })
  void Promise.all(pending).then(() => {
    ui.toast(`发送成功${arr.length > 1 ? `（${arr.length} 项）` : ''} · 已加密保存到云端`)
  })
}

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement
  if (input.files?.length) sendFiles(input.files)
  input.value = ''
}

function onPaste(e: ClipboardEvent): void {
  const files = e.clipboardData?.files
  if (files && files.length) {
    e.preventDefault()
    sendFiles(files)
  }
}

let dragDepth = 0
function onDrop(e: DragEvent): void {
  dragDepth = 0
  dragging.value = false
  if (e.dataTransfer?.files.length) sendFiles(e.dataTransfer.files)
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
  // 进入系统后光标自动落在输入框，方便直接输入
  void nextTick(() => textInput.value?.focus())
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

/* 切换日期（点击日历）：回到顶部并把光标放回输入框 */
watch(
  () => diary.timelineVersion,
  () => {
    void nextTick(() => {
      if (scrollEl.value) scrollEl.value.scrollTop = 0
      textInput.value?.focus()
    })
  },
)
</script>
