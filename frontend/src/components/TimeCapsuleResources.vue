<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useResourcesStore, type ResourceItem } from '@/stores/resources'
import { useUiStore } from '@/stores/ui'
import AppIcon from '@/components/AppIcon.vue'
import AttachmentPreviewModal from '@/components/AttachmentPreviewModal.vue'
import { formatSize, previewKind } from '@/utils/attachments'
import { getThumbnailUrl } from '@/utils/thumbCache'
import type { AttachmentMeta } from '@/types'

const props = defineProps<{ year: number }>()

const auth = useAuthStore()
const store = useResourcesStore()
const ui = useUiStore()

/** 每页渲染的卡片数（滚动增量渲染，控制缩略图下载量） */
const PAGE = 60

// ---- 筛选 / 排序状态 ----
type TypeFilter = 'all' | 'image' | 'pdf' | 'doc' | 'other'
const typeFilter = ref<TypeFilter>('all')
const onlyOrphan = ref(false)
const projectFilter = ref('all')
const timeRange = ref<'all' | '7d' | '30d' | '90d'>('all')
const sortBy = ref<'time-desc' | 'time-asc' | 'size-desc' | 'size-asc' | 'name-asc'>('time-desc')
const bigEnabled = ref(false)
const bigMb = ref(5)

const bigKey = computed(() => `resources_big_mb:${auth.username}`)
onMounted(() => {
  try {
    const v = Number(localStorage.getItem(bigKey.value))
    if (Number.isFinite(v) && v > 0) bigMb.value = v
  } catch {
    /* ignore */
  }
})
watch(bigMb, (v) => {
  try {
    localStorage.setItem(bigKey.value, String(v))
  } catch {
    /* ignore */
  }
})

// ---- 数据加载：进入视图加载当前年份；年份变化时重载 ----
onMounted(() => {
  void store.load(props.year)
})
watch(
  () => props.year,
  (y) => {
    if (store.loadedYear !== y) store.reset()
    void store.load(y)
  },
)
onUnmounted(() => {
  store.reset()
})

// ---- 缩略图（懒加载 + 并发受限 + IDB 缓存）----
const thumbUrls = reactive(new Map<string, string>())
const thumbLoading = reactive(new Set<string>())

function toMeta(item: ResourceItem): AttachmentMeta {
  return {
    id: item.fileId,
    name: item.name,
    size: item.size,
    type: item.type,
    key: item.key,
    uploadedAt: item.time,
  }
}

async function ensureThumb(item: ResourceItem) {
  if (!auth.creds || !auth.username) return
  if (thumbUrls.has(item.key) || thumbLoading.has(item.key)) return
  if (previewKind(toMeta(item)) !== 'image') return
  thumbLoading.add(item.key)
  try {
    const url = await getThumbnailUrl(auth.username, auth.creds, item)
    if (url) thumbUrls.set(item.key, url)
  } catch {
    /* 缩略图失败静默：卡片仍显示占位 */
  } finally {
    thumbLoading.delete(item.key)
  }
}

/** 卡片挂载：孤儿先嗅探类型（成功后触发缩略图），再尝试缩略图 */
function onCardMount(item: ResourceItem) {
  if (item.orphan && !item.typeSniffed) {
    void store.sniffOrphanType(item).then(() => ensureThumb(item))
  }
  void ensureThumb(item)
}

/** 卡片挂载钩子指令：网格增量渲染时逐卡片触发缩略图 / 孤儿嗅探 */
const vThumb = {
  mounted(_el: Element, binding: { value: () => void }) {
    binding.value()
  },
}

// ---- 类型 / 项目选项 ----
function matchType(item: ResourceItem): TypeFilter {
  const kind = previewKind(toMeta(item))
  if (kind === 'image') return 'image'
  if (kind === 'pdf') return 'pdf'
  const t = (item.type || '').trim().toLowerCase()
  if (!t || t === 'application/octet-stream') return 'other'
  return 'doc'
}

const projectOptions = computed(() => {
  const set = new Set<string>()
  for (const it of store.items) {
    if (it.orphan || !it.projectName) continue
    set.add(it.projectName)
  }
  return [...set].sort((a, b) => a.localeCompare(b))
})

// ---- 筛选 + 排序 ----
const filtered = computed(() => {
  const now = Date.now()
  let list = store.items
  if (onlyOrphan.value) list = list.filter((x) => x.orphan)
  if (typeFilter.value !== 'all') list = list.filter((x) => matchType(x) === typeFilter.value)
  if (bigEnabled.value) {
    const min = Math.round(bigMb.value * 1024 * 1024)
    list = list.filter((x) => x.size >= min)
  }
  if (projectFilter.value !== 'all') {
    list = list.filter((x) => !x.orphan && x.projectName === projectFilter.value)
  }
  if (timeRange.value !== 'all') {
    const days = Number(timeRange.value.slice(0, -1))
    const cutoff = now - days * 86400000
    list = list.filter((x) => {
      const t = new Date(x.time).getTime()
      return Number.isFinite(t) && t >= cutoff
    })
  }
  const arr = [...list]
  switch (sortBy.value) {
    case 'time-asc':
      arr.sort((a, b) => a.time.localeCompare(b.time))
      break
    case 'time-desc':
      arr.sort((a, b) => b.time.localeCompare(a.time))
      break
    case 'size-desc':
      arr.sort((a, b) => b.size - a.size)
      break
    case 'size-asc':
      arr.sort((a, b) => a.size - b.size)
      break
    case 'name-asc':
      arr.sort((a, b) => a.name.localeCompare(b.name))
      break
  }
  return arr
})

const visibleCount = ref(PAGE)
const pagedItems = computed(() => filtered.value.slice(0, visibleCount.value))
watch([typeFilter, onlyOrphan, projectFilter, timeRange, sortBy, bigEnabled, bigMb], () => {
  visibleCount.value = PAGE
})
watch(
  () => store.items,
  () => {
    visibleCount.value = PAGE
    selected.value = new Set()
  },
)

function loadMore() {
  visibleCount.value += PAGE
}

/** 汇总（随当前筛选实时变化） */
const summary = computed(() => {
  let count = 0
  let size = 0
  let orphan = 0
  let big = 0
  const min = Math.round(bigMb.value * 1024 * 1024)
  for (const it of filtered.value) {
    count++
    size += it.size
    if (it.orphan) orphan++
    if (it.size >= min) big++
  }
  return { count, size, orphan, big }
})

// ---- 多选 + 批量删除（无确认弹窗，点击即删）----
const selected = ref<Set<string>>(new Set())
function toggleSelect(key: string) {
  const s = new Set(selected.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  selected.value = s
}
function selectAllFiltered() {
  selected.value = new Set(filtered.value.map((x) => x.key))
}
function clearSelection() {
  selected.value = new Set()
}

const deleting = ref(false)
async function removeItems(list: ResourceItem[]) {
  if (!list.length || deleting.value) return
  deleting.value = true
  try {
    const { ok, failed } = await store.deleteItems(list)
    for (const it of list) thumbUrls.delete(it.key)
    selected.value = new Set([...selected.value].filter((k) => !list.some((x) => x.key === k)))
    if (failed) ui.toast(`已删除 ${ok} 个附件（${failed} 个失败）`, 'error')
    else ui.toast(`已删除 ${ok} 个附件`)
  } finally {
    deleting.value = false
  }
}

// ---- 预览 ----
const previewMeta = ref<AttachmentMeta | null>(null)
function openPreview(item: ResourceItem) {
  previewMeta.value = toMeta(item)
}

// ---- 其它 ----
function formatTime(iso: string): string {
  if (!iso) return '时间未知'
  return iso.slice(0, 16).replace('T', ' ')
}

function fileExtLabel(item: ResourceItem): string {
  if (item.orphan && !item.typeSniffed) return '未知'
  const kind = previewKind(toMeta(item))
  if (kind === 'image') return '图片'
  if (kind === 'pdf') return 'PDF'
  const t = (item.type || '').trim().toLowerCase()
  if (!t || t === 'application/octet-stream') return '文件'
  if (t.startsWith('audio/')) return '音频'
  if (t.startsWith('video/')) return '视频'
  if (t.startsWith('text/')) return '文档'
  if (t.startsWith('application/')) return '文档'
  return '文件'
}
</script>

<template>
  <div>
    <!-- 加载中 -->
    <div
      v-if="store.loading"
      class="flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white py-16 text-sm text-slate-500"
    >
      <AppIcon name="refresh" :size="16" class="animate-spin text-brand" />
      正在扫描 OSS 附件并比对任务引用…
    </div>

    <!-- 加载失败 -->
    <div v-else-if="store.error" class="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600">
      <div class="flex items-center gap-2">
        <AppIcon name="alert" :size="15" class="shrink-0" />
        {{ store.error }}
      </div>
      <button
        class="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs text-red-500 hover:bg-red-50"
        @click="store.load(props.year, true)"
      >
        <AppIcon name="refresh" :size="13" class="shrink-0" />
        重试
      </button>
    </div>

    <template v-else>
      <div class="mb-3 text-[11px] text-slate-400">
        当前展示 {{ props.year }} 年数据：胶囊任务附件 + 按 LastModified 归年的未引用附件；切换年份请点击「扫描时间胶囊文件」。
      </div>

      <!-- 无 list 权限降级提示 -->
      <div
        v-if="!store.listed"
        class="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-600"
      >
        <AppIcon name="warning" :size="14" class="mt-0.5 shrink-0" />
        当前存储桶无列举权限：仅展示胶囊任务引用的附件，未引用（孤儿）附件不可见。
      </div>

      <!-- 汇总条 -->
      <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-500">
        <span>共 <b class="text-slate-700">{{ summary.count }}</b> 个附件</span>
        <span>总大小 <b class="text-slate-700">{{ formatSize(summary.size) }}</b></span>
        <span v-if="summary.orphan" class="text-red-500">未引用 {{ summary.orphan }} 个</span>
        <span v-if="summary.big" class="text-amber-600">大文件（≥{{ bigMb }}MB）{{ summary.big }} 个</span>
        <button
          class="ml-auto inline-flex items-center gap-1 text-slate-400 hover:text-brand"
          title="重新扫描 OSS 附件"
          :disabled="store.loading"
          @click="store.load(props.year, true)"
        >
          <AppIcon name="refresh" :size="12" class="shrink-0" />
          刷新
        </button>
      </div>

      <!-- 筛选栏 -->
      <div class="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <select v-model="typeFilter" class="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-slate-600 focus:border-brand focus:outline-none">
          <option value="all">全部类型</option>
          <option value="image">图片</option>
          <option value="pdf">PDF</option>
          <option value="doc">文档</option>
          <option value="other">其它</option>
        </select>

        <select v-model="projectFilter" class="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-slate-600 focus:border-brand focus:outline-none">
          <option value="all">全部项目</option>
          <option v-for="p in projectOptions" :key="p" :value="p">{{ p }}</option>
        </select>

        <select v-model="timeRange" class="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-slate-600 focus:border-brand focus:outline-none">
          <option value="all">全部时间</option>
          <option value="7d">近 7 天</option>
          <option value="30d">近 30 天</option>
          <option value="90d">近 90 天</option>
        </select>

        <select v-model="sortBy" class="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-slate-600 focus:border-brand focus:outline-none">
          <option value="time-desc">时间 ↓</option>
          <option value="time-asc">时间 ↑</option>
          <option value="size-desc">大小 ↓</option>
          <option value="size-asc">大小 ↑</option>
          <option value="name-asc">名称</option>
        </select>

        <label class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-slate-600 cursor-pointer select-none">
          <input v-model="onlyOrphan" type="checkbox" class="accent-brand" />
          仅未引用
        </label>

        <label class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-slate-600 cursor-pointer select-none">
          <input v-model="bigEnabled" type="checkbox" class="accent-brand" />
          大文件 ≥
          <input
            v-model.number="bigMb"
            type="number"
            min="1"
            max="1024"
            class="w-12 rounded border border-slate-200 px-1 py-0.5 text-center focus:border-brand focus:outline-none"
          />
          MB
        </label>
      </div>

      <!-- 批量操作栏 -->
      <div v-if="selected.size" class="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-brand/30 bg-brand/5 px-3 py-2 text-xs">
        <span class="text-slate-600">已选 <b class="text-brand">{{ selected.size }}</b> 个</span>
        <button class="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-slate-600 hover:bg-slate-50" @click="selectAllFiltered">
          全选当前筛选
        </button>
        <button class="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-slate-600 hover:bg-slate-50" @click="clearSelection">
          取消选择
        </button>
        <button
          class="ml-auto inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-2.5 py-1 text-red-500 hover:bg-red-50 disabled:opacity-50"
          :disabled="deleting"
          @click="removeItems(filtered.filter((x) => selected.has(x.key)))"
        >
          <AppIcon name="trash" :size="12" class="shrink-0" />
          {{ deleting ? '删除中…' : '删除选中（仅删存储文件）' }}
        </button>
      </div>

      <!-- 空状态 -->
      <div v-if="!filtered.length" class="py-16 text-center text-sm text-slate-400">
        <template v-if="!store.items.length">该年份暂无附件数据，可点击右上角「扫描时间胶囊文件」切换年份</template>
        <template v-else>没有符合当前筛选条件的附件</template>
      </div>

      <!-- 网格 -->
      <div v-else class="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        <div
          v-for="item in pagedItems"
          :key="item.key"
          class="group relative overflow-hidden rounded-lg border border-slate-200 bg-white hover:border-brand/50 hover:shadow-sm"
        >
          <!-- 选择框 -->
          <input
            type="checkbox"
            class="absolute left-1.5 top-1.5 z-10 h-4 w-4 rounded accent-brand"
            :checked="selected.has(item.key)"
            @click.stop="toggleSelect(item.key)"
          />

          <!-- 缩略图 / 类型占位 -->
          <button
            class="flex aspect-square w-full items-center justify-center bg-slate-100"
            :title="item.name"
            @click="openPreview(item)"
          >
            <img
              v-if="thumbUrls.has(item.key)"
              :src="thumbUrls.get(item.key)"
              :alt="item.name"
              class="h-full w-full object-cover"
              loading="lazy"
            />
            <div v-else class="flex h-full w-full flex-col items-center justify-center gap-1 text-slate-400">
              <AppIcon :name="item.orphan ? 'box' : 'paperclip'" :size="26" class="shrink-0" />
              <span class="text-[10px]">{{ fileExtLabel(item) }}</span>
            </div>
          </button>

          <!-- 删除按钮（无确认，点击即删） -->
          <button
            class="absolute right-1.5 top-1.5 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-red-500 shadow-sm hover:bg-red-50"
            :title="'删除 ' + item.name + '（仅删存储文件，任务记录中该附件将无法打开）'"
            :disabled="deleting"
            @click.stop="removeItems([item])"
          >
            <AppIcon name="trash" :size="12" class="shrink-0" />
          </button>

          <!-- 信息区 -->
          <div class="px-1.5 pb-1.5 pt-1 text-[11px] leading-snug">
            <div class="flex items-center gap-1">
              <span class="truncate font-medium text-slate-700" :title="item.name">{{ item.name }}</span>
              <span
                v-if="item.orphan"
                class="shrink-0 rounded-full bg-red-50 px-1 py-px text-[10px] text-red-500"
                title="未被任何任务引用"
              >
                未引用
              </span>
            </div>
            <div class="mt-0.5 flex flex-wrap gap-x-2 text-slate-400">
              <span>{{ formatSize(item.size) }}</span>
              <span>{{ formatTime(item.time) }}</span>
            </div>
            <div class="mt-0.5 truncate text-slate-400" :title="item.orphan ? '' : `${item.taskName} · ${item.projectName}`">
              <template v-if="!item.orphan">
                {{ item.taskName }} · {{ item.projectName }}
              </template>
              <template v-else>无对应任务</template>
            </div>
          </div>

          <!-- 卡片挂载触发：缩略图 / 孤儿嗅探（增量渲染时逐卡片触发，并发受控） -->
          <span v-thumb="() => onCardMount(item)" class="hidden"></span>
        </div>
      </div>

      <!-- 加载更多 -->
      <button
        v-if="filtered.length > visibleCount"
        class="mt-3 w-full rounded-lg border border-slate-200 bg-white py-2 text-xs text-slate-500 hover:bg-slate-50"
        @click="loadMore"
      >
        <AppIcon name="chevron-down" :size="13" class="inline-block -mt-0.5 mr-1" />
        加载更多（{{ filtered.length - visibleCount }} 个）
      </button>
    </template>

    <!-- 预览 / 下载 -->
    <AttachmentPreviewModal :meta="previewMeta" @close="previewMeta = null" />
  </div>
</template>
