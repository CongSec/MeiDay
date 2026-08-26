<template>
  <div ref="elRef" class="group flex items-start gap-2 px-2 py-1">
    <div class="flex-1 min-w-0">
      <!-- 文本 -->
      <div v-if="message.type === 'text'" class="relative inline-block max-w-[85%]">
        <div
          class="rounded-2xl rounded-tl-sm bg-white shadow px-3.5 py-2.5 pr-7 text-[15px] leading-relaxed text-slate-800 whitespace-pre-wrap break-words"
        >
          <span v-if="message.appended" class="mr-1.5 inline-block align-middle text-[10px] font-medium text-amber-600 border border-amber-300 bg-amber-50 rounded px-1 py-px">追加</span>
          {{ message.text }}
        </div>
        <DiaryDeleteButton @confirm="$emit('delete', message.id)" />
      </div>

      <!-- 图片 -->
      <div v-else-if="message.type === 'file' && isImage" class="relative inline-block max-w-[260px]">
        <span v-if="message.appended" class="mb-1 inline-block text-[10px] font-medium text-amber-600 border border-amber-300 bg-amber-50 rounded px-1 py-px">追加</span>
        <div class="relative">
          <img
            :src="url || undefined"
            class="rounded-xl shadow max-w-full max-h-72 object-contain bg-black/5"
            loading="lazy"
          />
          <DiaryDeleteButton @confirm="$emit('delete', message.id)" />
        </div>
      </div>

      <!-- 视频 -->
      <div v-else-if="message.type === 'file' && isVideo" class="relative inline-block max-w-[280px]">
        <span v-if="message.appended" class="mb-1 inline-block text-[10px] font-medium text-amber-600 border border-amber-300 bg-amber-50 rounded px-1 py-px">追加</span>
        <div class="relative">
          <video :src="url || undefined" controls class="rounded-xl shadow w-full max-h-72 bg-black" preload="metadata" />
          <DiaryDeleteButton @confirm="$emit('delete', message.id)" />
        </div>
      </div>

      <!-- 音频 -->
      <div v-else-if="message.type === 'audio'" class="relative inline-block max-w-[300px]">
        <span v-if="message.appended" class="mb-1 inline-block text-[10px] font-medium text-amber-600 border border-amber-300 bg-amber-50 rounded px-1 py-px">追加</span>
        <div class="relative">
          <div class="rounded-2xl rounded-tl-sm bg-white shadow px-3 py-2.5 flex items-center gap-2">
            <span class="text-lg">🎙️</span>
            <audio :src="url || undefined" controls preload="metadata" class="h-9 w-52 max-w-[180px]" />
            <span v-if="message.file?.duration" class="text-[11px] text-slate-400 shrink-0">{{ fmtDuration(message.file.duration) }}</span>
          </div>
          <DiaryDeleteButton @confirm="$emit('delete', message.id)" />
        </div>
      </div>

      <!-- 其它文件（文档卡片） -->
      <div v-else-if="message.type === 'file'" class="relative inline-block max-w-[300px]">
        <span v-if="message.appended" class="mb-1 inline-block text-[10px] font-medium text-amber-600 border border-amber-300 bg-amber-50 rounded px-1 py-px">追加</span>
        <div class="relative">
          <a
            :href="url || undefined"
            :download="message.file?.name"
            target="_blank"
            rel="noopener"
            class="flex items-center gap-3 rounded-2xl rounded-tl-sm bg-white shadow px-3.5 py-3 hover:bg-slate-50"
          >
            <span class="w-9 h-9 rounded-lg bg-brand/10 flex items-center justify-center text-lg shrink-0">📄</span>
            <span class="min-w-0">
              <span class="block text-sm text-slate-800 truncate">{{ message.file?.name }}</span>
              <span class="block text-[11px] text-slate-400">{{ fmtSize(message.file?.size) }}</span>
            </span>
          </a>
          <DiaryDeleteButton @confirm="$emit('delete', message.id)" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
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
})
</script>
