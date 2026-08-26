<template>
  <div ref="elRef" class="group flex items-start justify-end gap-2 px-2 py-1">
    <div class="relative max-w-[85%] min-w-0">
      <!-- 文本：微信「我」风格，品牌色气泡 + 顶部左侧删按钮 -->
      <div v-if="message.type === 'text'" class="relative">
        <div
          class="rounded-2xl rounded-tr-sm bg-brand text-white shadow px-3.5 py-2.5 pl-7 text-[15px] leading-relaxed whitespace-pre-wrap break-words"
        >
          <span
            v-if="message.appended"
            class="mr-1.5 inline-block align-middle text-[10px] font-medium text-brand bg-white/90 border border-white/40 rounded px-1 py-px"
          >追加</span>
          {{ message.text }}
        </div>
        <DiaryDeleteButton position="left" @confirm="$emit('delete', message.id)" />
      </div>

      <!-- 图片：右对齐缩略图，双击放大 -->
      <div v-else-if="message.type === 'file' && isImage">
        <div v-if="message.appended" class="mb-1 text-right">
          <span class="inline-block text-[10px] font-medium text-amber-600 border border-amber-300 bg-amber-50 rounded px-1 py-px">追加</span>
        </div>
        <div class="relative">
          <img
            :src="url || undefined"
            class="rounded-xl rounded-tr-sm shadow max-w-full max-h-72 object-contain bg-black/5 cursor-zoom-in"
            loading="lazy"
            title="双击放大"
            @dblclick.prevent="openPreview"
          />
          <DiaryDeleteButton position="left" @confirm="$emit('delete', message.id)" />
        </div>
      </div>

      <!-- 视频 -->
      <div v-else-if="message.type === 'file' && isVideo">
        <div v-if="message.appended" class="mb-1 text-right">
          <span class="inline-block text-[10px] font-medium text-amber-600 border border-amber-300 bg-amber-50 rounded px-1 py-px">追加</span>
        </div>
        <div class="relative">
          <video
            :src="url || undefined"
            controls
            class="rounded-xl rounded-tr-sm shadow w-full max-h-72 bg-black"
            preload="metadata"
          />
          <DiaryDeleteButton position="left" @confirm="$emit('delete', message.id)" />
        </div>
      </div>

      <!-- 音频 -->
      <div v-else-if="message.type === 'audio'">
        <div v-if="message.appended" class="mb-1 text-right">
          <span class="inline-block text-[10px] font-medium text-amber-600 border border-amber-300 bg-amber-50 rounded px-1 py-px">追加</span>
        </div>
        <div class="relative">
          <div class="rounded-2xl rounded-tr-sm bg-white shadow px-3 py-2.5 flex items-center gap-2">
            <span class="text-lg">🎙️</span>
            <audio :src="url || undefined" controls preload="metadata" class="h-9 w-52 max-w-[180px]" />
            <span v-if="message.file?.duration" class="text-[11px] text-slate-400 shrink-0">{{ fmtDuration(message.file.duration) }}</span>
          </div>
          <DiaryDeleteButton position="left" @confirm="$emit('delete', message.id)" />
        </div>
      </div>

      <!-- 其它文件（文档卡片） -->
      <div v-else-if="message.type === 'file'">
        <div v-if="message.appended" class="mb-1 text-right">
          <span class="inline-block text-[10px] font-medium text-amber-600 border border-amber-300 bg-amber-50 rounded px-1 py-px">追加</span>
        </div>
        <div class="relative">
          <a
            :href="url || undefined"
            :download="message.file?.name"
            target="_blank"
            rel="noopener"
            class="flex items-center gap-3 rounded-2xl rounded-tr-sm bg-white shadow px-3.5 py-3 hover:bg-slate-50"
          >
            <span class="w-9 h-9 rounded-lg bg-brand/10 flex items-center justify-center text-lg shrink-0">📄</span>
            <span class="min-w-0">
              <span class="block text-sm text-slate-800 truncate">{{ message.file?.name }}</span>
              <span class="block text-[11px] text-slate-400">{{ fmtSize(message.file?.size) }}</span>
            </span>
          </a>
          <DiaryDeleteButton position="left" @confirm="$emit('delete', message.id)" />
        </div>
      </div>
    </div>

    <!-- 双击图片放大预览 -->
    <Teleport to="body">
      <div
        v-if="previewOpen && url"
        class="fixed inset-0 z-[70] bg-slate-900/90 flex items-center justify-center p-6"
        @click.self="closePreview"
        @dblclick.self="closePreview"
      >
        <img :src="url" class="max-w-full max-h-full object-contain rounded-lg shadow-2xl select-none" />
        <button
          class="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/15 text-white text-xl hover:bg-white/30 flex items-center justify-center"
          title="关闭"
          @click="closePreview"
        >×</button>
        <div class="absolute bottom-4 text-white/60 text-xs select-none">双击或点击 × 关闭预览</div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import DiaryDeleteButton from './DiaryDeleteButton.vue'
import { useDiaryStore } from '@/stores/diary'
import type { DiaryMessage } from '@/types'

const props = defineProps<{ message: DiaryMessage }>()
const emit = defineEmits<{ delete: [id: string] }>()

const diary = useDiaryStore()
const elRef = ref<HTMLElement | null>(null)
const url = ref('')
let observer: IntersectionObserver | null = null

const isImage = computed(() => !!props.message.file?.mime.startsWith('image/'))
const isVideo = computed(() => !!props.message.file?.mime.startsWith('video/'))

function fmtSize(size?: number): string {
  if (size === undefined) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
function fmtDuration(sec?: number): string {
  if (sec === undefined) return ''
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

async function loadFileUrl(): Promise<void> {
  const file = props.message.file
  if (!file || url.value) return
  try {
    url.value = await diary.fileUrl(file.fileId, file.mime)
  } catch {
    /* 解密/下载失败：保持空，不阻塞聊天 */
  }
}

/* ---------- 双击图片放大 ---------- */
const previewOpen = ref(false)
let onKey: ((e: KeyboardEvent) => void) | null = null

function openPreview(): void {
  if (!url.value || previewOpen.value) return
  previewOpen.value = true
  onKey = (e) => {
    if (e.key === 'Escape') previewOpen.value = false
  }
  window.addEventListener('keydown', onKey)
}
function closePreview(): void {
  previewOpen.value = false
}
watch(previewOpen, (v) => {
  if (!v && onKey) {
    window.removeEventListener('keydown', onKey)
    onKey = null
  }
})

onMounted(() => {
  // 懒加载：气泡进入视口附近才下载+解密，避免某天大量附件一次性拉取
  if (typeof IntersectionObserver === 'undefined' || !elRef.value) {
    void loadFileUrl()
    return
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer?.disconnect()
        observer = null
        void loadFileUrl()
      }
    },
    { rootMargin: '300px' },
  )
  observer.observe(elRef.value)
})

onUnmounted(() => {
  observer?.disconnect()
  observer = null
  if (onKey) {
    window.removeEventListener('keydown', onKey)
    onKey = null
  }
})
</script>
