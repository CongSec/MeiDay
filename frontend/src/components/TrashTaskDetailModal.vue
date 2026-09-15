<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { downloadAttachment, formatSize, isPreviewable } from '@/utils/attachments'
import { formatRepeat } from '@/utils/repeat'
import type { AttachmentMeta, Subtask, Task } from '@/types'
import AppIcon from '@/components/AppIcon.vue'
import AttachmentPreviewModal from '@/components/AttachmentPreviewModal.vue'

const props = defineProps<{
  open: boolean
  task: Task | null
}>()
const emit = defineEmits<{
  close: []
  edit: [Task]
}>()

const auth = useAuthStore()
const projects = useProjectsStore()

const previewMeta = ref<AttachmentMeta | null>(null)
const downloadErr = ref('')

/** 任务所属项目名称：支持活跃项目与已删除项目（时间胶囊里的任务可能属于已删除项目） */
const projectName = computed(() => {
  const t = props.task
  if (!t) return ''
  if (!t.projectId) return '无分类'
  const p = projects.byId(t.projectId)
  if (p) return p.name
  const dp = (projects.deletedProjects ?? []).find((x) => x.id === t.projectId)
  return dp?.name ?? '未知项目'
})

/** 所属项目是否已被删除（展示「已删除」标记） */
const projectDeleted = computed(() => {
  const t = props.task
  return !!t?.projectId && !projects.byId(t.projectId) && (projects.deletedProjects ?? []).some((x) => x.id === t.projectId)
})

/** 完整日期时间展示（YYYY-MM-DD HH:mm），时间胶囊的历史任务跨年需要带年份 */
function fullTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const [, time] = iso.split('T')
  return `${iso.slice(0, 10)} ${time ? time.slice(0, 5) : ''}`
}

function preview(a: AttachmentMeta) {
  previewMeta.value = a
}

async function download(a: AttachmentMeta) {
  downloadErr.value = ''
  try {
    if (!auth.creds || !auth.username) throw new Error('缺少会话信息，请重新登录')
    const blob = await downloadAttachment(auth.creds, a)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = a.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  } catch (e) {
    downloadErr.value = (e as Error).message || '下载失败'
  }
}
</script>

<template>
  <div
    v-if="open && task"
    class="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center px-4"
  >
    <div class="modal-panel rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col animate-modal-pop">
      <div class="flex items-start justify-between px-4 py-3 border-b border-slate-100 shrink-0">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <h2 class="text-base font-semibold text-slate-800 truncate">{{ task.name || '未命名任务' }}</h2>
            <span
              class="text-[11px] px-1.5 py-0.5 rounded-full shrink-0"
              :class="task.status === 'deleted' ? 'bg-red-50 text-red-500' : 'bg-slate-100 text-slate-500'"
            >
              {{ task.status === 'deleted' ? '已删除' : '已完成' }}
            </span>
          </div>
          <div class="mt-0.5 text-[11px] text-slate-400">时间胶囊任务详情</div>
        </div>
        <button
          class="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
          title="关闭"
          @click="emit('close')"
        >
          <AppIcon name="close" :size="16" />
        </button>
      </div>

      <div class="px-4 py-3 overflow-y-auto flex-1 space-y-2.5 text-sm">
        <!-- 所属项目 -->
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs text-slate-400 w-16 shrink-0">所属项目</span>
          <span class="inline-flex items-center gap-1 text-slate-700">
            <AppIcon name="folder" :size="14" class="text-brand/70 shrink-0" />
            {{ projectName }}
          </span>
          <span v-if="projectDeleted" class="text-[11px] text-slate-400">（已删除）</span>
        </div>

        <!-- 完成/存入时间：不可修改 -->
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs text-slate-400 w-16 shrink-0">存入时间</span>
          <span class="inline-flex items-center gap-1 text-slate-700">
            <AppIcon name="history" :size="14" class="text-brand/70 shrink-0" />
            {{ fullTime(task.updatedAt) }}
          </span>
          <span class="text-[11px] text-slate-400">（完成/存入胶囊时间，不可修改）</span>
        </div>

        <!-- 起止时间 -->
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span class="text-xs text-slate-400 w-16 shrink-0">起止时间</span>
          <span v-if="task.startTime" class="inline-flex items-center gap-1 text-slate-700">
            <AppIcon name="calendar" :size="14" class="text-brand/70 shrink-0" />{{ fullTime(task.startTime) }}
          </span>
          <span v-if="task.endTime" class="inline-flex items-center gap-1 text-slate-700">
            <AppIcon name="clock" :size="14" class="text-brand/70 shrink-0" />{{ fullTime(task.endTime) }}
          </span>
          <span v-if="!task.startTime && !task.endTime" class="text-slate-400">未设置</span>
        </div>

        <!-- 提醒时间 -->
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs text-slate-400 w-16 shrink-0">提醒时间</span>
          <span v-if="task.reminderTime" class="inline-flex items-center gap-1 text-slate-700">
            <AppIcon name="bell" :size="14" class="text-brand/70 shrink-0" />{{ fullTime(task.reminderTime) }}
          </span>
          <span v-else class="text-slate-400">未设置</span>
        </div>

        <!-- 重复规则 -->
        <div v-if="task.repeat" class="flex flex-wrap items-center gap-2">
          <span class="text-xs text-slate-400 w-16 shrink-0">重复规则</span>
          <span class="inline-flex items-center gap-1 text-slate-700">
            <AppIcon name="repeat" :size="14" class="text-brand/70 shrink-0" />{{ formatRepeat(task.repeat) }}
          </span>
        </div>

        <!-- 描述 -->
        <div v-if="task.description" class="flex flex-wrap gap-2">
          <span class="text-xs text-slate-400 w-16 shrink-0">描述</span>
          <p class="flex-1 min-w-0 text-slate-700 whitespace-pre-wrap break-words">{{ task.description }}</p>
        </div>

        <!-- 子任务 -->
        <div v-if="(task.subtasks?.length ?? 0) > 0" class="flex flex-wrap gap-2">
          <span class="text-xs text-slate-400 w-16 shrink-0">子任务</span>
          <div class="flex-1 min-w-0 space-y-1.5">
            <div
              v-for="s in task.subtasks"
              :key="s.id"
              class="rounded-lg border border-slate-100 bg-slate-50/70 px-2.5 py-1.5"
              :class="s.completed ? 'opacity-75' : ''"
            >
              <div class="flex items-center gap-2">
                <span
                  class="shrink-0 w-4 h-4 rounded border flex items-center justify-center"
                  :class="s.completed ? 'bg-brand border-brand text-white' : 'border-slate-300 bg-white text-transparent'"
                >
                  <AppIcon name="check" :size="10" :stroke-width="2.5" />
                </span>
                <span
                  class="flex-1 min-w-0 text-[13px]"
                  :class="s.completed ? 'line-through text-slate-400' : 'text-slate-700'"
                >
                  {{ s.name || '（未命名子任务）' }}
                </span>
                <span
                  v-if="(s.attachments?.length ?? 0) > 0"
                  class="shrink-0 text-[11px] text-brand/80 inline-flex items-center gap-0.5"
                >
                  <AppIcon name="paperclip" :size="11" />{{ s.attachments.length }}
                </span>
              </div>
              <p v-if="s.description" class="mt-1 pl-6 text-[11px] text-slate-400 break-all clamp-2">
                {{ s.description }}
              </p>
              <div
                v-if="s.startTime || s.endTime || s.reminderTime"
                class="mt-1 pl-6 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400"
              >
                <span v-if="s.startTime" class="inline-flex items-center gap-1"><AppIcon name="calendar" :size="11" />{{ fullTime(s.startTime) }}</span>
                <span v-if="s.endTime" class="inline-flex items-center gap-1"><AppIcon name="clock" :size="11" />{{ fullTime(s.endTime) }}</span>
                <span v-if="s.reminderTime" class="inline-flex items-center gap-1"><AppIcon name="bell" :size="11" />{{ fullTime(s.reminderTime) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 附件 -->
        <div v-if="(task.attachments?.length ?? 0) > 0" class="flex flex-wrap gap-2">
          <span class="text-xs text-slate-400 w-16 shrink-0">附件</span>
          <div class="flex-1 min-w-0 space-y-1">
            <div
              v-for="a in task.attachments"
              :key="a.id"
              class="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 px-2.5 py-1 text-xs"
            >
              <span class="shrink-0 text-brand/70 flex items-center"><AppIcon name="paperclip" :size="13" /></span>
              <span class="flex-1 min-w-0 truncate text-slate-700" :title="a.name">{{ a.name }}</span>
              <span class="shrink-0 text-slate-400">{{ formatSize(a.size) }}</span>
              <button
                v-if="isPreviewable(a)"
                class="shrink-0 text-brand hover:underline"
                @click="preview(a)"
              >
                预览
              </button>
              <button
                class="shrink-0 text-slate-400 hover:text-brand px-1 py-0.5 rounded"
                title="下载"
                @click="download(a)"
              >
                <AppIcon name="download" :size="14" />
              </button>
            </div>
          </div>
        </div>

        <div v-if="downloadErr" class="text-xs text-red-500">{{ downloadErr }}</div>
      </div>

      <div class="px-4 py-3 border-t border-slate-100 flex justify-end gap-2 shrink-0">
        <button
          class="px-4 py-1.5 rounded-lg text-sm text-slate-600 hover:bg-slate-100"
          @click="emit('close')"
        >
          关闭
        </button>
        <button
          class="px-4 py-1.5 rounded-lg text-sm text-white bg-brand hover:bg-brand-dark font-medium"
          @click="emit('edit', task)"
        >
          编辑
        </button>
      </div>
    </div>

    <AttachmentPreviewModal :meta="previewMeta" @close="previewMeta = null" />
  </div>
</template>
