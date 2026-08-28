<template>
  <div class="group flex flex-col items-end gap-0.5 px-2 py-1">
    <!-- 图片组时间：组上方（当天仅时:分；非当天带日期） -->
    <div class="text-[11px] text-slate-400 select-none">{{ timeLabel }}</div>

    <div class="flex items-start justify-end gap-2 w-full min-w-0">
      <div class="relative max-w-[85%] min-w-0">
        <!-- 折叠态：缩略条 + 数量遮罩，点击展开 -->
        <button
          v-if="!expanded"
          data-testid="diary-image-group-collapsed"
          class="relative overflow-hidden rounded-xl shadow-lg flex focus:outline-none"
          :title="`共 ${messages.length} 张图片，点击展开查看`"
          @click="expanded = true"
        >
          <div
            v-for="m in previewMsgs"
            :key="m.id"
            :ref="(el) => setRef(m.id, el)"
            :data-img-id="m.id"
            class="h-20 w-20 sm:h-24 sm:w-24 shrink-0 bg-slate-200 flex items-center justify-center text-xl text-slate-400"
          >
            <img
              v-if="urlState[m.id]"
              :src="urlState[m.id]"
              class="h-full w-full object-cover"
              loading="lazy"
              draggable="false"
              alt=""
            />
            <span v-else>🖼️</span>
          </div>
          <div class="absolute inset-0 bg-slate-900/45 flex flex-col items-center justify-center gap-0.5 text-white">
            <span class="text-lg leading-none">🖼️</span>
            <span class="text-[13px] font-semibold">{{ messages.length }} 张图片</span>
            <span class="text-[11px] opacity-85">点击展开查看</span>
          </div>
        </button>

        <!-- 展开态：网格图集，双击单图放大；回顾只读时可看不可删 -->
        <div v-else class="flex flex-col items-end gap-1.5" data-testid="diary-image-group-expanded">
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            <div
              v-for="m in messages"
              :key="m.id"
              :ref="(el) => setRef(m.id, el)"
              :data-img-id="m.id"
              data-testid="diary-image-item"
              class="relative overflow-hidden rounded-xl shadow bg-slate-200"
            >
              <img
                v-if="urlState[m.id]"
                :src="urlState[m.id]"
                class="h-28 w-28 sm:h-32 sm:w-32 object-cover cursor-zoom-in"
                loading="lazy"
                :title="m.file?.name || '双击放大'"
                draggable="false"
                @dblclick.prevent="openPreview(m)"
              />
              <div v-else class="h-28 w-28 sm:h-32 sm:w-32 flex items-center justify-center text-2xl text-slate-300">🖼️</div>
              <span
                v-if="m.appended"
                class="absolute top-1 right-1 z-[5] text-[10px] font-medium text-amber-600 bg-amber-50 border border-amber-300 rounded px-1 py-px"
              >追加</span>
              <DiaryDeleteButton v-if="!readonly" position="left" @confirm="$emit('delete', m.id)" />
            </div>
          </div>
          <button
            class="text-[11px] text-slate-400 hover:text-slate-600 px-2 py-0.5 rounded hover:bg-slate-200"
            title="收起图片列表"
            @click="expanded = false"
          >− 收起（{{ messages.length }} 张）</button>
        </div>
      </div>

      <!-- 默认头像：站点 logo（仅展示，不支持修改） -->
      <img
        :src="logo"
        alt="默认头像"
        class="w-8 h-8 rounded-full object-cover shrink-0 select-none mt-0.5"
        draggable="false"
      />
    </div>

    <!-- 双击放大预览 -->
    <Teleport to="body">
      <div
        v-if="previewOpen && previewUrl"
        class="fixed inset-0 z-[70] bg-slate-900/90 flex items-center justify-center p-6"
        @click.self="closePreview"
        @dblclick.self="closePreview"
      >
        <img :src="previewUrl" class="max-w-full max-h-full object-contain rounded-lg shadow-2xl select-none" />
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
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import DiaryDeleteButton from './DiaryDeleteButton.vue'
import { useDiaryStore } from '@/stores/diary'
import { formatDiaryMsgTime } from '@/utils/time'
import type { DiaryMessage } from '@/types'
import logo from '@/assets/logo.png'

const props = defineProps<{ messages: DiaryMessage[]; readonly?: boolean }>()
const emit = defineEmits<{ delete: [id: string] }>()

const diary = useDiaryStore()
const expanded = ref(false)
const previewOpen = ref(false)
const previewUrl = ref('')

const timeLabel = computed(() =>
  props.messages.length ? formatDiaryMsgTime(props.messages[0].createdAt) : '',
)

/** 折叠态只示意前 3 张，其余图片展开后才按需加载 */
const previewMsgs = computed(() => props.messages.slice(0, 3))

/** 按消息 id 缓存已解密 Blob URL（避免重复下载解密） */
const urlState = reactive<Record<string, string>>({})
const elRefs = new Map<string, HTMLElement>()
let observer: IntersectionObserver | null = null

function setRef(id: string, el: unknown): void {
  const node = el as HTMLElement | null
  if (!node) {
    elRefs.delete(id)
    return
  }
  elRefs.set(id, node)
  if (observer) observer.observe(node)
}

async function loadUrl(m: DiaryMessage): Promise<void> {
  if (!m.file || urlState[m.id]) return
  try {
    urlState[m.id] = await diary.fileUrl(m.file.fileId, m.file.mime)
  } catch {
    /* 解密/下载失败：保留占位，不阻塞聊天 */
  }
}

/** 逐图懒加载：图片容器进入视口附近才下载+解密（含折叠缩略与展开网格） */
function ensureObserver(): void {
  if (typeof IntersectionObserver === 'undefined') {
    for (const m of props.messages) void loadUrl(m)
    return
  }
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            observer?.unobserve(e.target)
            const id = (e.target as HTMLElement).dataset.imgId
            if (id) {
              const m = props.messages.find((x) => x.id === id)
              if (m) void loadUrl(m)
            }
          }
        }
      },
      { rootMargin: '300px' },
    )
  }
  for (const el of elRefs.values()) observer.observe(el)
}

function openPreview(m: DiaryMessage): void {
  const u = urlState[m.id]
  if (!u) return
  previewUrl.value = u
  previewOpen.value = true
}
function closePreview(): void {
  previewOpen.value = false
}

let onKey: ((e: KeyboardEvent) => void) | null = null
watch(previewOpen, (v) => {
  if (v && !onKey) {
    onKey = (e) => {
      if (e.key === 'Escape') previewOpen.value = false
    }
    window.addEventListener('keydown', onKey)
  } else if (!v && onKey) {
    window.removeEventListener('keydown', onKey)
    onKey = null
  }
})

watch(
  () => expanded.value,
  async (v) => {
    if (v) {
      await nextTick()
      ensureObserver()
    }
  },
)

onMounted(() => ensureObserver())
onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  elRefs.clear()
  if (onKey) {
    window.removeEventListener('keydown', onKey)
    onKey = null
  }
})
</script>
