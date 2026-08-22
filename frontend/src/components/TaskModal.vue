<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import { useAuthStore } from '@/stores/auth'
import { fromLocalInput, nowIso, toLocalInput } from '@/utils/time'
import { deleteAttachments, downloadAttachment, formatSize, isPreviewable, uploadAttachment } from '@/utils/attachments'
import AttachmentPreviewModal from './AttachmentPreviewModal.vue'
import { REPEAT_TYPES } from '@/types'
import type { AttachmentMeta, RepeatRule, RepeatType, Subtask, Task } from '@/types'

const props = defineProps<{
  open: boolean
  projectId?: string
  task?: Task | null
  /** 新建时默认的开始时间（datetime-local 字符串） */
  initialStart?: string
  /** 子任务模式：复用主任务弹窗新增/编辑子任务 */
  subtaskMode?: boolean
  subtask?: Subtask | null
  parentTask?: Task | null
}>()
const emit = defineEmits<{
  'update:open': [boolean]
  saved: [Task]
  savedSubtask: [parentTaskId: string, subtask: Subtask]
  delete: [string]
}>()

const projects = useProjectsStore()
const auth = useAuthStore()

const name = ref('')
const description = ref('')
const start = ref('')
const end = ref('')
const reminder = ref('')
const projectId = ref('')
const status = ref<'pending' | 'completed'>('pending')
const err = ref('')

/** 重复任务设置（仅主任务；子任务不支持重复） */
const repeatEnabled = ref(false)
const repeatType = ref<RepeatType>('daily')
const repeatInterval = ref(1)
const repeatWeekdays = ref<number[]>([])
const repeatMonthDay = ref(1)
const repeatEndAfter = ref('')
const monthDayTouched = ref(false)
const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六']

/** 新建任务时提前生成 id，供附件 OSS 路径与最终任务共用 */
const localTaskId = ref('')
/** 附件 OSS 目录归属：子任务归父任务，主任务归任务自身 */
const taskIdForAtt = computed(() =>
  props.subtaskMode ? (props.parentTask?.id ?? '') : (props.task?.id ?? localTaskId.value),
)
const attachments = ref<AttachmentMeta[]>([])
/** 打开弹窗时已有的附件 id（保存后清空），用于“取消”时清理本次新上传的孤文件 */
const originalIds = ref<Set<string>>(new Set())
/** 本次打开弹窗中被移除的附件（仅在保存时真正删除 OSS 文件；取消保存则保留） */
const removedAttachments = ref<AttachmentMeta[]>([])
const savedFlag = ref(false)
const uploading = ref(false)
const uploadErr = ref('')
const previewMeta = ref<AttachmentMeta | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

watch(
  () => props.open,
  (v) => {
    if (!v) return
    const isSub = !!props.subtaskMode
    const t = isSub ? null : props.task
    const s = isSub ? props.subtask : null
    name.value = isSub ? (s?.name ?? '') : (t?.name ?? '')
    description.value = isSub ? (s?.description ?? '') : (t?.description ?? '')
    start.value = isSub
      ? toLocalInput(s?.startTime)
      : toLocalInput(t?.startTime) || (t ? '' : props.initialStart ?? '')
    end.value = toLocalInput(isSub ? s?.endTime : t?.endTime)
    reminder.value = toLocalInput(isSub ? s?.reminderTime : t?.reminderTime)
    projectId.value = t?.projectId ?? props.projectId ?? projects.projects[0]?.id ?? ''
    status.value = t?.status === 'completed' ? 'completed' : 'pending'
    const r = isSub ? null : (t?.repeat ?? null)
    repeatEnabled.value = !!r
    repeatType.value = r?.type === 'workday' ? 'legalWorkday' : (r?.type ?? 'daily') // 旧「每个工作日」并入「每个法定工作日」
    repeatInterval.value = Math.max(1, r?.interval || 1)
    repeatWeekdays.value = r?.weekdays ? [...r.weekdays] : []
    repeatMonthDay.value = r?.monthDay ?? (start.value ? new Date(start.value).getDate() : 1)
    monthDayTouched.value = !!r?.monthDay
    repeatEndAfter.value = r?.endAfter ?? ''
    err.value = ''
    uploadErr.value = ''
    localTaskId.value = t?.id ?? crypto.randomUUID()
    attachments.value = [...(isSub ? (s?.attachments ?? []) : (t?.attachments ?? []))]
    originalIds.value = new Set(attachments.value.map((a) => a.id))
    removedAttachments.value = []
    savedFlag.value = false
    previewMeta.value = null
  },
)

watch(repeatType, (t) => {
  // 切到“每周”且未勾选星期时，默认按开始日期所在星期；切到“每月”默认按开始日期
  if (t === 'weekly' && !repeatWeekdays.value.length) {
    const dt = start.value ? new Date(start.value) : new Date()
    repeatWeekdays.value = [dt.getDay()]
  } else if (t === 'monthly' && !monthDayTouched.value) {
    const d = start.value ? new Date(start.value).getDate() : new Date().getDate()
    repeatMonthDay.value = d
  }
})

function close() {
  // 未保存就关闭：把本次新上传（不在原附件列表中）的 OSS 文件清理掉，避免残留孤文件
  if (!savedFlag.value && auth.creds) {
    const newOnes = attachments.value.filter((a) => !originalIds.value.has(a.id))
    if (newOnes.length) void deleteAttachments(auth.creds, newOnes)
  }
  savedFlag.value = false
  emit('update:open', false)
}

/** 编辑已有主任务时移入回收站：先关弹窗，由父组件弹出确认框 */
function askDelete() {
  if (props.subtaskMode || !props.task) return
  const id = props.task.id
  close()
  emit('delete', id)
}

const MAX_ATTACH_SIZE = 50 * 1024 * 1024 // 单个附件最大 50MB
const MAX_ATTACH_COUNT = 10 // 每个任务最多 10 个附件

async function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (!files.length) return
  uploading.value = true
  uploadErr.value = ''
  try {
    if (!auth.creds || !auth.username) throw new Error('缺少会话信息，请重新登录')
    if (!taskIdForAtt.value) throw new Error('任务尚未创建，请先保存任务后再添加附件')
    // BUG-28: 限制附件大小与数量，避免大文件全量 base64 进内存导致浏览器卡死
    const oversized = files.find((f) => f.size > MAX_ATTACH_SIZE)
    if (oversized) throw new Error(`附件「${oversized.name}」超过 50MB 上限，请压缩后重试`)
    if (attachments.value.length + files.length > MAX_ATTACH_COUNT) {
      throw new Error(`单个任务最多 ${MAX_ATTACH_COUNT} 个附件`)
    }
    for (const f of files) {
      const meta = await uploadAttachment(auth.creds, auth.username, taskIdForAtt.value, f)
      attachments.value.push(meta)
    }
  } catch (err) {
    uploadErr.value = (err as Error).message || '上传失败'
  } finally {
    uploading.value = false
    input.value = ''
  }
}

function removeAttachment(a: AttachmentMeta) {
  // 先只从列表移除；真正的 OSS 删除延迟到“保存”时执行，
  // 避免“删除→取消”就把云端附件删掉（BUG-16）
  attachments.value = attachments.value.filter((x) => x.id !== a.id)
  removedAttachments.value.push(a)
}

function preview(a: AttachmentMeta) {
  previewMeta.value = a
}

async function download(a: AttachmentMeta) {
  try {
    if (!auth.creds || !auth.username) throw new Error('缺少会话信息，请重新登录')
    const blob = await downloadAttachment(auth.creds, a)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = a.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  } catch (err) {
    uploadErr.value = (err as Error).message || '下载失败'
  }
}

// 旧「每个工作日」已并入「每个法定工作日」：下拉选项不再提供，旧数据读取时 label 统一显示为「每个法定工作日」
const REPEAT_TYPE_LABELS: Record<Exclude<RepeatType, 'workday'>, string> = {
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  legalWorkday: '每个法定工作日',
}
function repeatTypeLabel(t: RepeatType) {
  if (t === 'workday') return REPEAT_TYPE_LABELS.legalWorkday
  return REPEAT_TYPE_LABELS[t as Exclude<RepeatType, 'workday'>] ?? t
}
const intervalLabel = computed(() => {
  if (repeatType.value === 'weekly') return '间隔（周）'
  if (repeatType.value === 'monthly') return '间隔（个月）'
  return '间隔（天）'
})
function toggleWeekday(wd: number) {
  const i = repeatWeekdays.value.indexOf(wd)
  if (i >= 0) repeatWeekdays.value.splice(i, 1)
  else repeatWeekdays.value.push(wd)
}

/** BUG-30: 校验开始/截止/提醒时间的先后关系，返回错误文案或 null */
function validateTimes(start: string, end: string, reminder: string): string | null {
  const s = start ? new Date(start).getTime() : 0
  const e = end ? new Date(end).getTime() : 0
  const r = reminder ? new Date(reminder).getTime() : 0
  if (s && e && s > e) return '开始时间不能晚于截止时间'
  if (r && e && r > e) return '提醒时间不能晚于截止时间'
  if (s && r && r < s) return '提醒时间不能早于开始时间'
  return null
}

function submit() {
  if (props.subtaskMode) {
    if (!name.value.trim()) {
      err.value = '请输入子任务名称'
      return
    }
    const timeErr = validateTimes(start.value, end.value, reminder.value)
    if (timeErr) {
      err.value = timeErr
      return
    }
    const now = nowIso()
    const sub: Subtask = {
      id: props.subtask?.id ?? crypto.randomUUID(),
      name: name.value.trim(),
      description: description.value,
      startTime: fromLocalInput(start.value),
      endTime: fromLocalInput(end.value),
      reminderTime: reminder.value ? fromLocalInput(reminder.value) : null,
      completed: props.subtask?.completed ?? false,
      createdAt: props.subtask?.createdAt ?? now,
      updatedAt: now,
      attachments: attachments.value,
    }
    savedFlag.value = true
    emit('savedSubtask', props.parentTask?.id ?? '', sub)
    close()
    return
  }
  if (!name.value.trim()) {
    err.value = '请输入任务名称'
    return
  }
  if (!projectId.value) {
    err.value = '请选择所属项目'
    return
  }
  const timeErr = validateTimes(start.value, end.value, reminder.value)
  if (timeErr) {
    err.value = timeErr
    return
  }
  const now = nowIso()
  const task: Task = {
    id: props.task?.id ?? localTaskId.value,
    name: name.value.trim(),
    description: description.value,
    // 直接采用输入框当前值，清空即清空（不再回退到旧值）
    startTime: fromLocalInput(start.value),
    endTime: fromLocalInput(end.value),
    reminderTime: reminder.value ? fromLocalInput(reminder.value) : null,
    projectId: projectId.value,
    status: props.task ? (status.value === 'completed' ? 'completed' : props.task.status === 'deleted' ? 'deleted' : 'pending') : status.value,
    isReminded: props.task?.isReminded ?? false,
    createdAt: props.task?.createdAt ?? now,
    updatedAt: now,
    // 编辑主任务时原样保留已有子任务，避免保存时丢失
    subtasks: props.task?.subtasks ?? [],
    attachments: attachments.value,
  }
  // BUG-16: 真正删除“本次移除”的附件 OSS 文件（取消保存时不会走到这里）
  if (removedAttachments.value.length && auth.creds) {
    void deleteAttachments(auth.creds, removedAttachments.value)
  }
  // 重复任务：生成规则写入任务（仅主任务模式；子任务不支持重复）
  let repeat: RepeatRule | undefined
  if (repeatEnabled.value) {
    const interval = Math.max(1, Math.floor(repeatInterval.value || 1))
    repeat = { type: repeatType.value, interval }
    if (repeatType.value === 'weekly') {
      let wds = [...repeatWeekdays.value].sort((a, b) => a - b)
      if (!wds.length && start.value) wds = [new Date(start.value).getDay()]
      if (wds.length) repeat.weekdays = wds
    }
    if (repeatType.value === 'monthly') {
      repeat.monthDay = Math.min(31, Math.max(1, Math.floor(repeatMonthDay.value || 1)))
    }
    if (repeatEndAfter.value) repeat.endAfter = repeatEndAfter.value
  }
  task.repeat = repeat
  savedFlag.value = true
  emit('saved', task)
  close()
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center px-3 py-3"
    title="点击空白处取消编辑"
    @click.self="close"
  >
    <div class="bg-white rounded-xl shadow-xl p-4 w-full max-w-xl max-h-[96dvh] overflow-y-auto">
      <div class="text-base font-semibold">
        {{ subtaskMode ? (subtask ? '编辑子任务' : '添加子任务') : task ? '编辑任务' : '新建任务' }}
      </div>
      <form class="mt-3 space-y-2.5" @submit.prevent="submit">
        <div>
          <label class="text-xs text-slate-500 block mb-0.5">名称 *</label>
          <input
            v-model="name"
            maxlength="200"
            class="w-full border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-brand/50"
            placeholder="任务名称"
          />
        </div>
        <div>
          <label class="text-xs text-slate-500 block mb-0.5">描述</label>
          <textarea
            v-model="description"
            rows="1"
            maxlength="5000"
            class="w-full border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-brand/50 resize-none"
            placeholder="可选"
          />
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="text-xs text-slate-500 block mb-0.5">开始时间</label>
            <input v-model="start" type="datetime-local" class="w-full min-w-0 border rounded-lg px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label class="text-xs text-slate-500 block mb-0.5">截止时间</label>
            <input v-model="end" type="datetime-local" class="w-full min-w-0 border rounded-lg px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label class="text-xs text-slate-500 block mb-0.5">提醒时间</label>
            <input v-model="reminder" type="datetime-local" class="w-full min-w-0 border rounded-lg px-2 py-1.5 text-sm" />
          </div>
          <div v-if="!subtaskMode">
            <label class="text-xs text-slate-500 block mb-0.5">所属项目</label>
            <select v-model="projectId" class="w-full border rounded-lg px-2 py-1.5 text-sm bg-white">
              <option v-for="p in projects.projects" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </div>
          <div v-else></div>
        </div>

        <!-- 重复任务（仅主任务）：完成后按周期自动生成下一任务，所有属性保持一致，仅日期顺延 -->
        <div v-if="!subtaskMode" class="rounded-lg border border-slate-100 p-2.5">
          <label class="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
            <input v-model="repeatEnabled" type="checkbox" class="accent-brand" />
            🔁 重复任务（到期当天自动显示；提醒邮件由服务器按时发送）
          </label>
          <div v-if="repeatEnabled" class="grid grid-cols-2 gap-2 pt-2">
            <div>
              <label class="text-[11px] text-slate-500 block mb-0.5">周期类型</label>
              <select v-model="repeatType" class="w-full border rounded-lg px-2 py-1.5 text-sm bg-white">
                <option v-for="r in REPEAT_TYPES" :key="r" :value="r">{{ repeatTypeLabel(r) }}</option>
              </select>
            </div>
            <div v-if="repeatType === 'daily' || repeatType === 'weekly' || repeatType === 'monthly'">
              <label class="text-[11px] text-slate-500 block mb-0.5">{{ intervalLabel }}</label>
              <input v-model.number="repeatInterval" type="number" min="1" max="365" class="w-full border rounded-lg px-2 py-1.5 text-sm" />
            </div>
            <div v-if="repeatType === 'monthly'">
              <label class="text-[11px] text-slate-500 block mb-0.5">每月第几天</label>
              <input
                v-model.number="repeatMonthDay"
                type="number"
                min="1"
                max="31"
                class="w-full border rounded-lg px-2 py-1.5 text-sm"
                @input="monthDayTouched = true"
              />
            </div>
            <div>
              <label class="text-[11px] text-slate-500 block mb-0.5">结束日期</label>
              <input v-model="repeatEndAfter" type="date" class="w-full border rounded-lg px-2 py-1.5 text-sm" />
            </div>
            <div v-if="repeatType === 'weekly'" class="col-span-2 flex flex-wrap items-center gap-1">
              <span class="text-[11px] text-slate-500 mr-1">星期</span>
              <button
                v-for="(wd, idx) in 7"
                :key="wd"
                type="button"
                class="w-7 h-7 rounded-md text-[11px] border transition"
                :class="repeatWeekdays.includes(idx) ? 'bg-brand text-white border-brand' : 'text-slate-500 border-slate-200 hover:bg-slate-100'"
                @click="toggleWeekday(idx)"
              >
                {{ WEEKDAY_SHORT[idx] }}
              </button>
            </div>
          </div>
        </div>

        <!-- 附件：任务与子任务均支持；安全位图 / PDF 在线预览，其余（含 SVG 等脚本格式）仅下载 -->
        <div>
          <div class="flex items-center justify-between">
            <label class="text-xs text-slate-500 block">附件</label>
            <button
              type="button"
              class="text-xs text-brand font-medium hover:underline disabled:opacity-50"
              :disabled="uploading"
              @click="fileInput?.click()"
            >
              {{ uploading ? '上传中…' : '＋ 添加附件' }}
            </button>
          </div>
          <input ref="fileInput" type="file" multiple class="hidden" @change="onPickFiles" />
          <div v-if="uploadErr" class="text-xs text-red-500 mb-1">{{ uploadErr }}</div>
          <div v-if="attachments.length" class="space-y-1">
            <div
              v-for="a in attachments"
              :key="a.id"
              class="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 px-2.5 py-1 text-xs"
            >
              <span class="shrink-0">📎</span>
              <span class="flex-1 min-w-0 truncate text-slate-700" :title="a.name">{{ a.name }}</span>
              <span class="shrink-0 text-slate-400">{{ formatSize(a.size) }}</span>
              <button
                v-if="isPreviewable(a)"
                type="button"
                class="shrink-0 text-brand hover:underline"
                @click="preview(a)"
              >
                预览
              </button>
              <button
                type="button"
                class="shrink-0 text-slate-400 hover:text-brand"
                title="下载"
                @click="download(a)"
              >
                ⤓
              </button>
              <button
                type="button"
                class="shrink-0 text-slate-300 hover:text-red-500"
                title="删除附件"
                @click="removeAttachment(a)"
              >
                ✕
              </button>
            </div>
          </div>
        </div>

        <div v-if="err" class="text-sm text-red-500">{{ err }}</div>
        <div class="flex justify-between items-center gap-2 pt-1">
          <button
            v-if="!subtaskMode && task"
            type="button"
            class="px-3 py-1.5 rounded-lg text-xs text-red-500 border border-red-200 hover:bg-red-50"
            @click="askDelete"
          >
            移入回收站
          </button>
          <div class="flex justify-end gap-2 ml-auto">
            <button type="button" class="px-4 py-1.5 rounded-lg text-sm text-slate-600 hover:bg-slate-100" @click="close">
              取消
            </button>
            <button type="submit" class="px-4 py-1.5 rounded-lg text-sm text-white bg-brand hover:bg-brand-dark font-medium">
              保存
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
  <AttachmentPreviewModal :meta="previewMeta" @close="previewMeta = null" />
</template>

