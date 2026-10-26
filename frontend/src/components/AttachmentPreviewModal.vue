<script setup lang="ts">
import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { downloadAttachment, formatSize, ossFileName, previewKind } from '@/utils/attachments'
import { saveBlobToDevice } from '@/utils/saveBlob'
import type { AttachmentMeta } from '@/types'
import AppIcon from '@/components/AppIcon.vue'
import ZoomableImage from '@/components/ZoomableImage.vue'

const props = defineProps<{ meta: AttachmentMeta | null }>()
const emit = defineEmits<{ close: [] }>()

const auth = useAuthStore()
const ui = useUiStore()

const loading = ref(false)
const error = ref('')
const url = ref('')
/** 已解密的原始 Blob（供「下载」在原生端落盘；仅预览时也会保留引用，关闭时随 url 一并释放） */
const blobRef = ref<Blob | null>(null)
/** 预览方式：'image'（<img> 内联）| 'pdf'（sandbox <iframe>）| null（不支持/不安全，仅下载） */
const kind = ref<'image' | 'pdf' | null>(null)

watch(
  () => props.meta,
  async (m) => {
    revokeUrl()
    blobRef.value = null
    if (!m) {
      error.value = ''
      loading.value = false
      return
    }
    loading.value = true
    error.value = ''
    kind.value = previewKind(m)
    try {
      if (!auth.creds || !auth.username) throw new Error('缺少会话信息，请重新登录')
      const blob = await downloadAttachment(auth.creds, m)
      blobRef.value = blob
      // 安全关键：PDF 预览强制使用明确的 application/pdf MIME，交给浏览器 PDF 查看器，
      // 绝不沿用用户声明的 type（可能是 application/octet-stream 或伪造类型），
      // 否则浏览器会内容嗅探，把伪装成 PDF 的 HTML/脚本当作页面渲染执行（存储型 XSS）。
      if (kind.value === 'pdf') {
        url.value = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
      } else {
        url.value = URL.createObjectURL(blob)
      }
    } catch (e) {
      error.value = (e as Error).message || '预览加载失败'
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

function revokeUrl() {
  if (url.value) URL.revokeObjectURL(url.value)
  url.value = ''
}

function download() {
  if (!blobRef.value) return
  saveBlobToDevice(blobRef.value, props.meta?.name || 'attachment', props.meta?.type)
    .then((save) => {
      // 原生端：文件已落盘到系统下载目录，明确告知路径；Web 端浏览器自带下载栏，无需提示
      if (save.mode === 'native' && save.path) ui.toast(`已保存到 ${save.path}`)
    })
    .catch((e) => {
      ui.toast((e as Error).message || '下载失败', 'error')
    })
}
</script>

<template>
  <div v-if="meta" class="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center px-4">
    <div class="modal-panel rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col animate-modal-pop">
      <div class="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold text-slate-800 truncate flex items-center gap-2" :title="meta.key || meta.name"><AppIcon name="paperclip" :size="15" class="text-brand shrink-0" />{{ ossFileName(meta.key) || meta.name }}</div>
          <div class="text-[11px] text-slate-400">{{ formatSize(meta.size) }} · {{ meta.uploadedAt }}</div>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="px-3 py-1.5 rounded-lg text-xs text-white bg-brand hover:bg-brand-dark font-medium"
            :disabled="loading || !url"
            @click="download"
          >
            下载
          </button>
          <button
            class="px-3 py-1.5 rounded-lg text-xs text-slate-600 border border-slate-200 hover:bg-slate-50"
            @click="emit('close')"
          >
            关闭
          </button>
        </div>
      </div>
      <div class="flex-1 min-h-0 bg-slate-50 flex items-center justify-center overflow-auto p-4">
        <div v-if="loading" class="text-sm text-slate-500">正在解密加载…</div>
        <div v-else-if="error" class="text-sm text-red-500">{{ error }}</div>
        <template v-else-if="url && kind">
          <!-- 图片：点击即可像教程图片一样放大查看（滚轮/双指缩放、拖动平移、双击、Esc 关闭） -->
          <ZoomableImage
            v-if="kind === 'image'"
            :src="url"
            alt="预览"
            thumbnail-class="max-w-full max-h-[70vh] rounded-lg object-contain cursor-zoom-in"
          />
          <!-- sandbox（空值=最强隔离）：阻止 iframe 内任何脚本执行与同源访问，
              即使文件内容是伪装成 PDF 的 HTML，也无法执行 XSS / 读取本应用数据 -->
          <iframe v-else :src="url" sandbox="" class="w-full h-[70vh] rounded-lg border border-slate-200 bg-white" title="PDF 预览" />
        </template>
        <div v-else-if="url" class="text-center text-sm text-slate-500">
          该格式不支持在线预览，请点击右上角「下载」查看。
        </div>
      </div>
    </div>
  </div>
</template>


