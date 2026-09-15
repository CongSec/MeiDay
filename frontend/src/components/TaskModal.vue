<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import { useAuthStore } from '@/stores/auth'
import { useTasksStore } from '@/stores/tasks'
import { fromLocalInput, nowIso, toLocalInput, todayKey } from '@/utils/time'
import { useUiStore } from '@/stores/ui'
import { deleteAttachments, downloadAttachment, formatSize, isPreviewable } from '@/utils/attachments'
import { cancelSessionUploads, cancelUploadByMetaId, commitUploads, enqueueUploads, getActiveUploadCount, subscribeUploads, type BackgroundUploadState } from '@/utils/backgroundUpload'
import AttachmentPreviewModal from './AttachmentPreviewModal.vue'
import { ensureLegalCalendar } from '@/utils/legalWorkday'
import { currentOrNextOccurrence, firstOccurrenceDate, isNewStyleRepeat } from '@/utils/repeat'
import { REPEAT_TYPES } from '@/types'
import type { AttachmentMeta, RepeatRule, RepeatType, Subtask, Task } from '@/types'
import AppIcon from '@/components/AppIcon.vue'

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
  /** 非空时表示正在编辑“未来任务”里的重复出现模板：保存走 saveFutureOccurrenceConfirmed（masterId = 重复任务源任务 id） */
  templateMasterId?: string | null
  /** 时间胶囊编辑模式：任务保持在胶囊内（状态不变），保存写回胶囊而不是活跃任务；保留完成/入舱时间 */
  capsuleEdit?: boolean
}>()
const emit = defineEmits<{
  'update:open': [boolean]
  saved: [Task]
  savedSubtask: [parentTaskId: string, subtask: Subtask]
  delete: [string]
}>()

const projects = useProjectsStore()
const tasks = useTasksStore()
const auth = useAuthStore()
const ui = useUiStore()
/** 记住「上次新建任务时选择的项目」：按用户记忆到 localStorage（今日视图新建任务默认用它，不再固定用第一个项目） */
const lastProjectKey = computed(() => `st_last_project:${auth.username}`)
function lastProjectId(): string {
  const id = localStorage.getItem(lastProjectKey.value)
  return id && projects.projects.some((p) => p.id === id) ? id : ''
}
function rememberProject(id: string) {
  if (id) localStorage.setItem(lastProjectKey.value, id)
}
/** 所属项目下拉选项：时间胶囊编辑时任务可能属于已删除项目，需一并提供，避免无法保留原项目 */
const projectOptions = computed(() =>
  props.capsuleEdit
    ? [...projects.projects, ...(projects.deletedProjects ?? [])]
    : projects.projects,
)

/** 弹窗标题：时间胶囊编辑模式单独命名，区分于普通任务编辑 */
const modalTitle = computed(() => {
  if (props.subtaskMode) return props.subtask ? '编辑子任务' : '添加子任务'
  if (props.capsuleEdit) return '编辑时间胶囊任务'
  return props.task ? '编辑任务' : '新建任务'
})

const name = ref('')
const description = ref('')
const start = ref('')
const end = ref('')
const reminder = ref('')
const projectId = ref('')
const status = ref<'pending' | 'completed'>('pending')
const err = ref('')

/** 时间胶囊编辑：子任务本地编辑列表（新增/勾选/编辑/删除；保存时随主任务写回胶囊，不丢子任务附件） */
const capsuleSubs = ref<Subtask[]>([])
/** 正在编辑的子任务下标：-1 = 新增，null = 未在编辑 */
const capsuleSubEditIndex = ref<number | null>(null)
/** 子任务编辑表单（名称/描述/起止/提醒，新增与编辑共用） */
const capsuleSubForm = ref({ name: '', description: '', startTime: '', endTime: '', reminderTime: '' })

/** 重复任务设置（仅主任务；子任务不支持重复） */
const repeatEnabled = ref(false)
const repeatType = ref<RepeatType>('daily')
const repeatInterval = ref(1)
const repeatWeekdays = ref<number[]>([])
const repeatMonthDay = ref(1)
const repeatEndAfter = ref('')
/** 指定日期重复：勾选的多个特定日期（YYYY-MM-DD，升序去重，每个日期各出现一次） */
const repeatDates = ref<string[]>([])
/** 月历多选器：当前查看的年月（0 基月） */
const repeatDateView = ref({ y: new Date().getFullYear(), m: new Date().getMonth() })
/** 月历多选器：本次勾选、待「添加选中」一次性提交的日期集合 */
const repeatDateSelection = ref<Set<string>>(new Set())
watch(
  () => props.open,
  (v) => {
    if (v) {
      void ensureLegalCalendar(new Date().getFullYear())
      void ensureLegalCalendar(new Date().getFullYear() + 1)
    }
  },
)
const monthDayTouched = ref(false)
const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六']

/** 是否为「新模型」重复任务：编辑时看任务规则是否带 start（老重复数据走旧逻辑）；
 *  新建时勾选重复即按新模型（提醒时间只选时分）。 */
const isNewStyleRepeatTask = computed(() => {
  if (props.subtaskMode) return false
  if (props.task?.repeat) return isNewStyleRepeat(props.task.repeat)
  return repeatEnabled.value
})

/** 重复规则的「形状」是否一致（不含 endAfter：改结束日期不重置相位） */
function sameRepeatShape(a: RepeatRule, b: RepeatRule): boolean {
  return (
    a.type === b.type &&
    a.interval === b.interval &&
    JSON.stringify(a.weekdays ?? []) === JSON.stringify(b.weekdays ?? []) &&
    (a.monthDay ?? 0) === (b.monthDay ?? 0) &&
    JSON.stringify(a.dates ?? []) === JSON.stringify(b.dates ?? [])
  )
}

/** 勾选/取消重复任务：提醒时间在「仅时分」与「完整日期时间」输入间切换 */
watch(repeatEnabled, (v) => {
  if (props.subtaskMode) return
  if (v) {
    // 切换为重复（新模型）：把完整 datetime 退化为时分，匹配 time 输入框
    if (isNewStyleRepeatTask.value && reminder.value.length > 5) {
      reminder.value = reminder.value.slice(11, 16)
    }
  } else if (isNewStyleRepeatTask.value || isNewStyleRepeat(props.task?.repeat)) {
    // 取消重复：恢复为完整 datetime（基于任务原有提醒时间，避免遗留纯时分值）
    const orig = props.task?.reminderTime
    if (orig) reminder.value = toLocalInput(orig)
  }
})


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
/** 保存已提交（后台写 OSS 中）：仅用于防重复提交，弹窗已立即关闭 */
const saving = ref(false)
const uploading = ref(false)
const activeUploadCount = ref(0)
/** 附件后台上传队列的会话标识：每次打开弹窗一个新会话（选择文件即入队上传，保存不等待） */
const sessionUid = ref('')
let unsubUploads: (() => void) | null = null
/** 新子任务在打开弹窗时生成 id（附件上传归属与最终保存共用，避免保存时才确定） */
const localSubtaskId = ref('')
const uploadErr = ref('')
const previewMeta = ref<AttachmentMeta | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
/** 描述文本框引用：内容变多时自动增高 */
const descriptionRef = ref<HTMLTextAreaElement | null>(null)
/** 名称输入框引用：新建任务/子任务时自动聚焦 */
const nameInputRef = ref<HTMLInputElement | null>(null)
/** 拖放高亮：拖文件到弹窗时提示可上传附件 */
const isDragOver = ref(false)
let dragDepth = 0

/** 描述文本框随内容自动增高（上限 200px，超出出现滚动条） */
function autoResizeDescription() {
  const el = descriptionRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`
}

watch(
  () => props.open,
  (v) => {
    if (!v) return
    // 新会话：重置后台上传队列订阅（旧会话已由保存/取消清理，这里只换订阅）
    sessionUid.value = crypto.randomUUID()
    unsubUploads?.()
    unsubUploads = subscribeUploads(sessionUid.value, onBackgroundUpload)
    uploading.value = false
    const isSub = !!props.subtaskMode
    const t = isSub ? null : props.task
    const s = isSub ? props.subtask : null
    name.value = isSub ? (s?.name ?? '') : (t?.name ?? '')
    description.value = isSub ? (s?.description ?? '') : (t?.description ?? '')
    start.value = isSub
      ? toLocalInput(s?.startTime)
      : toLocalInput(t?.startTime) || (t ? '' : props.initialStart ?? '')
    end.value = toLocalInput(isSub ? s?.endTime : t?.endTime)
    const _rt = toLocalInput(isSub ? s?.reminderTime : t?.reminderTime)
    reminder.value = !isSub && t?.repeat && isNewStyleRepeat(t.repeat) ? (_rt ? _rt.slice(11, 16) : '') : _rt
    projectId.value =
      t?.projectId ??
      props.projectId ??
      (lastProjectId() || (projects.projects[0]?.id ?? ''))
    status.value = t?.status === 'completed' ? 'completed' : 'pending'
    const r = isSub ? null : (t?.repeat ?? null)
    repeatEnabled.value = !!r
    repeatType.value = r?.type === 'workday' ? 'legalWorkday' : (r?.type ?? 'daily') // 旧「每个工作日」并入「每个法定工作日」
    repeatInterval.value = Math.max(1, r?.interval || 1)
    repeatWeekdays.value = r?.weekdays ? [...r.weekdays] : []
    repeatMonthDay.value = r?.monthDay ?? (start.value ? new Date(start.value).getDate() : 1)
    monthDayTouched.value = !!r?.monthDay
    repeatEndAfter.value = r?.endAfter ?? ''
    repeatDates.value = r?.dates ? [...r.dates].sort() : []
    repeatDateSelection.value = new Set()
    const _now = new Date()
    repeatDateView.value = { y: _now.getFullYear(), m: _now.getMonth() }
    err.value = ''
    uploadErr.value = ''
    localTaskId.value = t?.id ?? crypto.randomUUID()
    localSubtaskId.value = isSub ? (s?.id ?? crypto.randomUUID()) : ''
    attachments.value = [...(isSub ? (s?.attachments ?? []) : (t?.attachments ?? []))]
    originalIds.value = new Set(attachments.value.map((a) => a.id))
    removedAttachments.value = []
    // 时间胶囊编辑：初始化子任务本地列表（副本，避免直接改胶囊数据）
    capsuleSubs.value = props.capsuleEdit ? [...(t?.subtasks ?? [])].map((s) => ({ ...s })) : []
    capsuleSubEditIndex.value = null
    savedFlag.value = false
    previewMeta.value = null
    void nextTick(autoResizeDescription)
    // 新建任务/子任务：光标默认聚焦到名称输入框；编辑已有任务时不自动聚焦
    const isCreating = isSub ? !s : !t
    if (isCreating) void nextTick(() => nameInputRef.value?.focus())
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

/** 纯关闭弹窗（不清理附件；保存提交后立即调用） */
function close() {
  emit('update:open', false)
}

/** 用户主动取消（点取消/空白处）：关闭并清理本次新上传的孤文件（未保存的编辑不保留） */
function cancel() {
  // 正在保存时视为提交后的关闭，附件属于正在保存的任务，不清理
  if (saving.value) {
    close()
    return
  }
  // 取消：停止本次会话的后台上传并清理孤文件（未保存的编辑不保留）
  cancelSessionUploads(sessionUid.value)
  cleanupNewUploads()
  savedFlag.value = false
  close()
}

/** 清理本次打开弹窗中新上传但未保存（或保存失败）的 OSS 孤文件 */
function cleanupNewUploads() {
  if (!auth.creds) return
  const newOnes = attachments.value.filter((a) => !originalIds.value.has(a.id))
  if (newOnes.length) void deleteAttachments(auth.creds, newOnes)
}

/** 编辑已有主任务时移入回收站：先关弹窗，由父组件弹出确认框 */
function askDelete() {
  if (props.subtaskMode || !props.task) return
  const id = props.task.id
  cancel()
  emit('delete', id)
}

/** 时间胶囊编辑：开始新增（index=null）或编辑（index）子任务 */
function startCapsuleSubEdit(index: number | null) {
  if (index === null) {
    capsuleSubEditIndex.value = -1
    capsuleSubForm.value = { name: '', description: '', startTime: '', endTime: '', reminderTime: '' }
    return
  }
  const s = capsuleSubs.value[index]
  if (!s) return
  capsuleSubEditIndex.value = index
  capsuleSubForm.value = {
    name: s.name ?? '',
    description: s.description ?? '',
    startTime: toLocalInput(s.startTime),
    endTime: toLocalInput(s.endTime),
    reminderTime: toLocalInput(s.reminderTime),
  }
}

/** 取消子任务编辑 */
function cancelCapsuleSubEdit() {
  capsuleSubEditIndex.value = null
}

/** 保存子任务（新增或编辑）：写入本地列表，随主任务保存时一起写回胶囊 */
function saveCapsuleSubEdit() {
  const f = capsuleSubForm.value
  const editing = capsuleSubEditIndex.value
  if (!f.name.trim() || editing === null) return
  const existing = editing === -1 ? null : capsuleSubs.value[editing]
  const now = nowIso()
  const sub: Subtask = {
    id: existing?.id ?? crypto.randomUUID(),
    name: f.name.trim(),
    description: f.description.trim(),
    startTime: fromLocalInput(f.startTime),
    endTime: fromLocalInput(f.endTime),
    reminderTime: fromLocalInput(f.reminderTime) || null,
    completed: existing?.completed ?? false,
    // 编辑保留原创建/更新时间与附件；新增子任务用当前时间
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing?.updatedAt ?? now,
    attachments: existing ? [...(existing.attachments ?? [])] : [],
  }
  if (editing === -1) capsuleSubs.value.push(sub)
  else capsuleSubs.value[editing] = sub
  capsuleSubEditIndex.value = null
}

/** 勾选/取消子任务完成状态（时间胶囊编辑） */
function toggleCapsuleSub(index: number) {
  const s = capsuleSubs.value[index]
  if (s) s.completed = !s.completed
}

/** 删除子任务（时间胶囊编辑） */
function removeCapsuleSub(index: number) {
  capsuleSubs.value.splice(index, 1)
  if (capsuleSubEditIndex.value === index) capsuleSubEditIndex.value = null
  else if (capsuleSubEditIndex.value !== null && capsuleSubEditIndex.value > index) capsuleSubEditIndex.value -= 1
}

const MAX_ATTACH_SIZE = 50 * 1024 * 1024 // 单个附件最大 50MB
const MAX_ATTACH_COUNT = 10 // 每个任务最多 10 个附件

/** 校验并加入后台上传队列（文件选择 / 描述框粘贴图片共用）；成功入队返回 true，失败返回 false */
function uploadFiles(files: File[]): boolean {
  if (!files.length) return false
  uploadErr.value = ''
  try {
    const creds = auth.creds
    const username = auth.username
    if (!creds || !username) throw new Error('缺少会话信息，请重新登录')
    if (!taskIdForAtt.value) throw new Error('任务尚未创建，请先保存任务后再添加附件')
    // BUG-28: 限制附件大小与数量，避免大文件全量 base64 进内存导致浏览器卡死
    const oversized = files.find((f) => f.size > MAX_ATTACH_SIZE)
    if (oversized) throw new Error(`附件「${oversized.name}」超过 50MB 上限，请压缩后重试`)
    if (attachments.value.length + files.length > MAX_ATTACH_COUNT) {
      throw new Error(`单个任务最多 ${MAX_ATTACH_COUNT} 个附件`)
    }
    // 选中的文件立即进入后台队列上传（不阻塞弹窗操作）；保存任务时未传完的部分由
    // 队列继续上传，完成后写回任务 JSON 并统一提示“文件上传成功，任务保存成功”
    enqueueUploads(
      files.map((f) => ({
        id: crypto.randomUUID(),
        uid: sessionUid.value,
        creds,
        username,
        file: f,
        taskId: taskIdForAtt.value,
        subtaskId: props.subtaskMode ? (props.subtask?.id ?? localSubtaskId.value) : null,
        projectId: props.subtaskMode ? (props.parentTask?.projectId ?? '') : projectId.value,
      })),
    )
    refreshUploading()
    return true
  } catch (err) {
    uploadErr.value = (err as Error).message || '上传失败'
    return false
  }
}

function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (files.length) uploadFiles(files)
  input.value = ''
}

/** 粘贴图片到附件：名称框 / 描述框共用；剪贴板含图片时直接上传（不插入文本），否则走默认粘贴 */
function pasteImagesToAttachments(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  const imgs: File[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (f) imgs.push(f)
    }
  }
  if (!imgs.length) return
  if (uploadFiles(imgs)) {
    e.preventDefault()
    ui.toast(`已将 ${imgs.length} 张图片添加到附件`)
  }
}

/** 拖文件到弹窗：松开时把文件上传到附件（与文件选择共用校验与上传队列） */
function onDragEnter() {
  dragDepth++
  isDragOver.value = true
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) isDragOver.value = false
}
function onDropFiles(e: DragEvent) {
  dragDepth = 0
  isDragOver.value = false
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (!files.length) return
  if (uploadFiles(files)) ui.toast(`已将 ${files.length} 个文件添加到附件`)
}

/** 后台队列状态变化：把完成的上传加入附件展示列表；失败在未保存前显示行内错误 */
function onBackgroundUpload(item: BackgroundUploadState) {
  if (item.uid !== sessionUid.value) return
  if (item.state === 'done' && item.meta) {
    const meta = item.meta
    if (!attachments.value.some((a) => a.id === meta.id)) attachments.value.push(meta)
  } else if (item.state === 'failed' && !item.committed) {
    uploadErr.value = item.error || '上传失败'
  }
  refreshUploading()
}

function refreshUploading() {
  activeUploadCount.value = getActiveUploadCount(sessionUid.value)
  uploading.value = activeUploadCount.value > 0
}

function removeAttachment(a: AttachmentMeta) {
  // 先只从列表移除；真正的 OSS 删除延迟到“保存”时执行，
  // 避免“删除→取消”就把云端附件删掉（BUG-16）
  attachments.value = attachments.value.filter((x) => x.id !== a.id)
  removedAttachments.value.push(a)
  // 该附件若仍在后台队列（未保存前删除）：取消对应上传并清理孤文件
  cancelUploadByMetaId(sessionUid.value, a.id)
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
  dates: '指定日期',
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

/** 指定日期：月历 42 格（周日起始），含上月/本月/下月补位格 */
const repeatCalendarCells = computed(() => {
  const { y, m } = repeatDateView.value
  const pad = (n: number) => String(n).padStart(2, '0')
  const first = new Date(y, m, 1)
  const startOffset = first.getDay()
  const cells: string[] = []
  for (let i = 0; i < 42; i++) {
    const dt = new Date(y, m, 1 - startOffset + i)
    cells.push(`${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`)
  }
  return cells
})
/** 指定日期：当前查看的月份键（YYYY-MM） */
const repeatDateMonthKey = computed(() => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${repeatDateView.value.y}-${pad(repeatDateView.value.m + 1)}`
})
/** 指定日期：某格是否属于当前查看的月份 */
function repeatDateInMonth(d: string): boolean {
  return d.startsWith(repeatDateMonthKey.value)
}
/** 指定日期：某天是否在本次勾选集合中 */
function repeatDateIsSelected(d: string): boolean {
  return repeatDateSelection.value.has(d)
}
/** 指定日期：某天是否已确认加入列表 */
function repeatDateIsConfirmed(d: string): boolean {
  return repeatDates.value.includes(d)
}
/** 指定日期：月历格子的样式类 */
function repeatDateCellClass(d: string): string {
  if (!repeatDateInMonth(d)) return 'invisible'
  if (d < todayKey()) return 'text-slate-300 opacity-40'
  if (repeatDateIsSelected(d) || repeatDateIsConfirmed(d)) {
    return 'bg-amber-100 border-amber-300 text-amber-800 font-medium'
  }
  return 'text-slate-600 border-slate-200 hover:bg-amber-50 hover:border-amber-300'
}
/** 指定日期：勾选/取消月历中的某天（待「添加选中」一次性提交） */
function toggleRepeatDate(d: string) {
  const s = new Set(repeatDateSelection.value)
  if (s.has(d)) s.delete(d)
  else s.add(d)
  repeatDateSelection.value = s
}
/** 指定日期：把本次勾选的全部日期一次性加入列表（升序去重） */
function addRepeatDates() {
  if (!repeatDateSelection.value.size) return
  const merged = [...new Set([...repeatDates.value, ...repeatDateSelection.value])].sort()
  repeatDates.value = merged
  repeatDateSelection.value = new Set()
}
/** 指定日期：从列表移除某天 */
function removeRepeatDate(d: string) {
  repeatDates.value = repeatDates.value.filter((x) => x !== d)
}
/** 月历翻页（跨年自动进位/借位） */
function repeatDatePrevMonth() {
  const { y, m } = repeatDateView.value
  repeatDateView.value = m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }
}
function repeatDateNextMonth() {
  const { y, m } = repeatDateView.value
  repeatDateView.value = m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }
}

/** BUG-30: 校验开始/截止/提醒时间的先后关系，返回错误文案或 null */
function validateTimes(start: string, end: string, reminder: string, skipReminderDates = false): string | null {
  const s = start ? new Date(start).getTime() : 0
  const e = end ? new Date(end).getTime() : 0
  if (s && e && s > e) return '开始时间不能晚于截止时间'
  // 新模型重复任务：提醒时间只是当天时分，不与开始/截止做日期先后比较
  if (skipReminderDates) return null
  const r = reminder ? new Date(reminder).getTime() : 0
  if (r && e && r > e) return '提醒时间不能晚于截止时间'
  if (s && r && r < s) return '提醒时间不能早于开始时间'
  return null
}

async function submit() {
  // 确认式保存进行中，禁止重复提交
  if (saving.value) return
  // 快照本次保存时“已上传完成”的附件 id：尚未传完的不在保存 JSON 中，由后台队列写回
  const savedMetaIds = new Set(attachments.value.map((a) => a.id))
  if (props.subtaskMode) {
    const timeErr = validateTimes(start.value, end.value, reminder.value)
    if (timeErr) {
      err.value = timeErr
      return
    }
    const now = nowIso()
    const sub: Subtask = {
      id: props.subtask?.id ?? localSubtaskId.value,
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
    // 点保存立即关闭弹窗；提示由回显后的 toast 负责（成功才提示，失败回滚并弹错误提示）
    saving.value = true
    emit('update:open', false)
    try {
      const ok = await tasks.saveSubtaskConfirmed(props.parentTask?.id ?? '', sub)
      if (!ok) {
        // 保存失败：store 已弹错误提示，这里清理本次新上传的孤文件并停止后台上传
        cleanupNewUploads()
        cancelSessionUploads(sessionUid.value)
        return
      }
      // 保存成功：未传完的附件由后台队列继续上传，完成后写回子任务 JSON 并统一提示
      commitUploads(sessionUid.value, { projectId: props.parentTask?.projectId ?? '', savedMetaIds })
      const remainingUploads = getActiveUploadCount(sessionUid.value)
      if (remainingUploads > 0) ui.toast(`附件后台继续上传中（剩余 ${remainingUploads} 个）`)
      savedFlag.value = true
      emit('savedSubtask', props.parentTask?.id ?? '', sub)
    } finally {
      saving.value = false
    }
    return
  }
  if (!projectId.value) {
    err.value = '请选择所属项目'
    return
  }
  const oldRepeat = props.task?.repeat ?? null
  const wasNewStyle = !!oldRepeat && isNewStyleRepeat(oldRepeat)
  // 新模型：新建的重复任务 / 原本就是新模型的重复任务（老重复数据保持旧逻辑，不迁移）
  const isNewModel = repeatEnabled.value && (!oldRepeat || wasNewStyle)
  const timeErr = validateTimes(start.value, end.value, reminder.value, isNewModel)
  if (timeErr) {
    err.value = timeErr
    return
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
    if (repeatType.value === 'dates') {
      const ds = [...new Set(repeatDates.value)].sort()
      if (!ds.length) {
        err.value = '请至少选择一个重复日期'
        return
      }
      repeat.dates = ds
    }
    // 指定日期由日期列表自行界定，不叠加结束日期
    if (repeatEndAfter.value && repeatType.value !== 'dates') repeat.endAfter = repeatEndAfter.value
    if (isNewModel) {
      const today = todayKey()
      // 编辑时重复规则形状未变则保留原 start（相位锚点），避免每次保存重置周期相位
      const keepStart = wasNewStyle && !!oldRepeat?.start && sameRepeatShape(oldRepeat, repeat)
      repeat.start = keepStart ? oldRepeat!.start : firstOccurrenceDate(repeat, today)
    }
  }
  // 提醒时间：新模型只保留时分，日期取“当前/下一次重复日”（相位以 rule.start 为准）
  let reminderTime: string | null = null
  if (reminder.value) {
    if (isNewModel && repeat) {
      const occDate = currentOrNextOccurrence(repeat, repeat.start ?? todayKey(), todayKey())
      reminderTime = fromLocalInput(`${occDate}T${reminder.value}`)
    } else {
      // 兼容从重复模式切回遗留的纯时分值：补当天日期，避免存非法 ISO
      const raw = reminder.value
      reminderTime = raw.includes('T') ? fromLocalInput(raw) : fromLocalInput(`${todayKey()}T${raw}`)
    }
  }
  const now = nowIso()
  const task: Task = {
    id: props.task?.id ?? localTaskId.value,
    name: name.value.trim(),
    description: description.value,
    // 直接采用输入框当前值，清空即清空（不再回退到旧值）
    startTime: fromLocalInput(start.value),
    endTime: fromLocalInput(end.value),
    reminderTime,
    projectId: projectId.value,
    status: props.task ? (status.value === 'completed' ? 'completed' : props.task.status === 'deleted' ? 'deleted' : 'pending') : status.value,
    isReminded: props.task?.isReminded ?? false,
    createdAt: props.task?.createdAt ?? now,
    // 时间胶囊编辑：保留完成/入舱时间不变（决定所在分片与排序，不能刷新为当前时间）
    updatedAt: props.capsuleEdit ? (props.task?.updatedAt ?? now) : now,
    // 编辑主任务时原样保留已有子任务，避免保存时丢失
    subtasks: props.capsuleEdit ? capsuleSubs.value : (props.task?.subtasks ?? []),
    attachments: attachments.value,
  }
  task.repeat = repeat
  // 记住新建任务时选择的项目：下次在今日视图新建任务时默认用它
  if (!props.task) rememberProject(task.projectId)
  // 点保存立即关闭弹窗；提示由回显后的 toast 负责（成功才提示，失败回滚并弹错误提示）
  saving.value = true
  emit('update:open', false)
  try {
    const ok = props.capsuleEdit
      ? await tasks.saveTrashTaskConfirmed(task, { prevProjectId: props.task?.projectId ?? undefined })
      : props.templateMasterId
        ? await tasks.saveFutureOccurrenceConfirmed(task, props.templateMasterId)
        : await tasks.saveTaskConfirmed(task, { prevProjectId: props.task?.projectId ?? undefined })
    if (!ok) {
      // 保存失败：store 已弹错误提示，这里清理本次新上传的孤文件并停止后台上传
      cleanupNewUploads()
      cancelSessionUploads(sessionUid.value)
      return
    }
    // BUG-16: 真正删除“本次移除”的附件 OSS 文件（确认保存成功后才执行）
    if (removedAttachments.value.length && auth.creds) {
      void deleteAttachments(auth.creds, removedAttachments.value)
    }
    // 保存成功：未传完的附件由后台队列继续上传，完成后写回任务 JSON 并统一提示
    commitUploads(sessionUid.value, { projectId: task.projectId, savedMetaIds })
    const remainingUploads = getActiveUploadCount(sessionUid.value)
    if (remainingUploads > 0) ui.toast(`附件后台继续上传中（剩余 ${remainingUploads} 个）`)
    savedFlag.value = true
    emit('saved', task)
  } finally {
    saving.value = false
  }
}
onUnmounted(() => {
  unsubUploads?.()
  // 弹窗被卸载时清理尚未提交保存的上传（已提交保存的继续后台完成，不受影响）
  cancelSessionUploads(sessionUid.value)
})
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center px-3 py-3"
    title="点击空白处取消编辑"
    @click.self="cancel"
  >
    <div
      class="modal-panel rounded-2xl p-4 w-full max-w-xl max-h-[96dvh] overflow-y-auto animate-modal-pop transition-shadow"
      :class="isDragOver ? 'ring-2 ring-brand/70 shadow-xl' : ''"
      title="可将文件拖入此处添加为附件"
      @dragenter.prevent="onDragEnter"
      @dragover.prevent
      @dragleave="onDragLeave"
      @drop.prevent="onDropFiles"
    >
      <div class="text-base font-semibold">
        {{ modalTitle }}
      </div>
      <form class="mt-3 space-y-2.5" @submit.prevent="submit">
        <div>
          <label class="text-xs text-slate-500 block mb-0.5">名称 *</label>
          <input
            ref="nameInputRef"
            v-model="name"
            maxlength="200"
            class="w-full border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-brand/50"
            placeholder="任务名称"
            @paste="pasteImagesToAttachments"
          />
        </div>
        <div>
          <label class="text-xs text-slate-500 block mb-0.5">描述</label>
          <textarea
            ref="descriptionRef"
            v-model="description"
            rows="1"
            maxlength="5000"
            class="w-full border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-brand/50 resize-none max-h-[200px] overflow-y-auto"
            placeholder="可选"
            @input="autoResizeDescription"
            @paste="pasteImagesToAttachments"
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
            <input v-model="reminder" :type="isNewStyleRepeatTask ? 'time' : 'datetime-local'" class="w-full min-w-0 border rounded-lg px-2 py-1.5 text-sm" />
          </div>
          <div v-if="!subtaskMode">
            <label class="text-xs text-slate-500 block mb-0.5">所属项目</label>
            <select v-model="projectId" class="w-full border rounded-lg px-2 py-1.5 text-sm bg-white">
              <option v-for="p in projectOptions" :key="p.id" :value="p.id">{{ p.name }}{{ p.id && !projects.projects.some((x) => x.id === p.id) ? '（已删除）' : '' }}</option>
            </select>
          </div>
          <div v-else></div>
        </div>

        <!-- 重复任务（仅主任务）：完成后按周期自动生成下一任务，所有属性保持一致，仅日期顺延 -->
        <div v-if="!subtaskMode" class="rounded-lg border border-slate-100 p-2.5">
          <label class="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
            <input v-model="repeatEnabled" type="checkbox" class="accent-brand" />
            <AppIcon name="repeat" :size="14" class="text-brand shrink-0" /> 重复任务（到期当天自动显示；提醒邮件由服务器按时发送）
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
            <div v-if="repeatType !== 'dates'">
              <label class="text-[11px] text-slate-500 block mb-0.5">结束日期</label>
              <input v-model="repeatEndAfter" type="date" class="w-full border rounded-lg px-2 py-1.5 text-sm" />
            </div>
            <div v-if="repeatType === 'dates'" class="col-span-2">
              <label class="text-[11px] text-slate-500 block mb-0.5">指定日期（可勾选多个日期，点「添加选中」一次性保存）</label>
              <!-- 月历多选：勾选多个日期后一次性加入并保存 -->
              <div class="rounded-lg border border-slate-200 bg-slate-50/60 p-2">
                <div class="flex items-center justify-between mb-1.5">
                  <button type="button" class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-200 text-sm leading-none" title="上一月" @click="repeatDatePrevMonth">‹</button>
                  <span class="text-xs font-medium text-slate-700">{{ repeatDateView.y }} 年 {{ repeatDateView.m + 1 }} 月</span>
                  <button type="button" class="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-200 text-sm leading-none" title="下一月" @click="repeatDateNextMonth">›</button>
                </div>
                <div class="grid grid-cols-7 gap-0.5 text-center">
                  <span v-for="wd in WEEKDAY_SHORT" :key="wd" class="text-[10px] text-slate-400 py-0.5">{{ wd }}</span>
                  <button
                    v-for="(d, i) in repeatCalendarCells"
                    :key="i"
                    type="button"
                    class="h-7 rounded-md text-[11px] border transition disabled:cursor-not-allowed"
                    :class="repeatDateCellClass(d)"
                    :disabled="d < todayKey()"
                    :title="d"
                    @click="toggleRepeatDate(d)"
                  >
                    {{ Number(d.slice(8, 10)) }}
                  </button>
                </div>
              </div>
              <div class="mt-2 flex items-center justify-between gap-2">
                <span v-if="repeatDateSelection.size" class="text-[11px] text-amber-600 font-medium">已勾选 {{ repeatDateSelection.size }} 天</span>
                <span v-else class="text-[11px] text-slate-400">勾选多个日期后，点「添加选中」一次性保存</span>
                <button
                  type="button"
                  class="shrink-0 px-3 py-1.5 rounded-lg text-xs text-white bg-brand hover:bg-brand-dark disabled:opacity-50"
                  :disabled="!repeatDateSelection.size"
                  @click="addRepeatDates"
                >
                  添加选中{{ repeatDateSelection.size ? `（${repeatDateSelection.size}）` : '' }}
                </button>
              </div>
              <div v-if="repeatDates.length" class="mt-2 flex flex-wrap gap-1.5">
                <span
                  v-for="d in repeatDates"
                  :key="d"
                  class="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800"
                >
                  {{ d }}
                  <button type="button" class="text-amber-400 hover:text-red-500" title="移除该日期" @click="removeRepeatDate(d)">×</button>
                </span>
              </div>
              <p v-else class="mt-1 text-[11px] text-slate-400">请至少添加一个日期</p>
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

        <!-- 子任务（时间胶囊编辑）：可直接新增/勾选/编辑/删除，保存时随主任务写回胶囊 -->
        <div v-if="capsuleEdit && !subtaskMode" class="rounded-lg border border-slate-100 p-2.5">
          <div class="flex items-center justify-between">
            <label class="text-xs text-slate-500">子任务</label>
            <button
              type="button"
              class="inline-flex items-center gap-1 text-xs text-brand hover:text-brand-dark"
              @click="startCapsuleSubEdit(null)"
            >
              <AppIcon name="plus" :size="12" />添加子任务
            </button>
          </div>
          <div v-if="capsuleSubs.length" class="mt-1.5 space-y-1">
            <div
              v-for="(s, i) in capsuleSubs"
              :key="s.id"
              class="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 px-2 py-1.5"
              :class="s.completed ? 'opacity-75' : ''"
            >
              <button
                type="button"
                class="shrink-0 w-4 h-4 rounded border flex items-center justify-center"
                :class="s.completed ? 'bg-brand border-brand text-white' : 'border-slate-300 bg-white text-transparent'"
                :title="s.completed ? '标记为未完成' : '标记为已完成'"
                @click="toggleCapsuleSub(i)"
              >
                <AppIcon name="check" :size="10" :stroke-width="2.5" />
              </button>
              <button
                type="button"
                class="flex-1 min-w-0 text-left text-[13px]"
                :class="s.completed ? 'line-through text-slate-400' : 'text-slate-700'"
                :title="'点击编辑：' + (s.name || '（未命名子任务）')"
                @click="startCapsuleSubEdit(i)"
              >
                {{ s.name || '（未命名子任务）' }}
              </button>
              <span
                v-if="(s.attachments?.length ?? 0) > 0"
                class="shrink-0 text-[11px] text-brand/70 inline-flex items-center gap-0.5"
              >
                <AppIcon name="paperclip" :size="11" />{{ s.attachments.length }}
              </span>
              <button
                type="button"
                class="shrink-0 text-slate-300 hover:text-red-500"
                title="删除子任务"
                @click="removeCapsuleSub(i)"
              >
                <AppIcon name="close" :size="13" />
              </button>
            </div>
          </div>
          <div v-else class="mt-1 text-[11px] text-slate-400">暂无子任务</div>
          <!-- 新增/编辑子任务表单 -->
          <div v-if="capsuleSubEditIndex !== null" class="mt-2 space-y-1.5 rounded-lg border border-slate-100 bg-white p-2">
            <input v-model="capsuleSubForm.name" type="text" placeholder="子任务名称" class="w-full border rounded-lg px-2 py-1.5 text-sm" />
            <input v-model="capsuleSubForm.description" type="text" placeholder="描述（可选）" class="w-full border rounded-lg px-2 py-1.5 text-sm" />
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="text-[11px] text-slate-400 block mb-0.5">开始时间</label>
                <input v-model="capsuleSubForm.startTime" type="datetime-local" class="w-full border rounded-lg px-2 py-1.5 text-sm" />
              </div>
              <div>
                <label class="text-[11px] text-slate-400 block mb-0.5">结束时间</label>
                <input v-model="capsuleSubForm.endTime" type="datetime-local" class="w-full border rounded-lg px-2 py-1.5 text-sm" />
              </div>
            </div>
            <div>
              <label class="text-[11px] text-slate-400 block mb-0.5">提醒时间</label>
              <input v-model="capsuleSubForm.reminderTime" type="datetime-local" class="w-full border rounded-lg px-2 py-1.5 text-sm" />
            </div>
            <div class="flex justify-end gap-2 pt-1">
              <button type="button" class="px-3 py-1.5 rounded-lg text-xs text-slate-600 hover:bg-slate-100" @click="cancelCapsuleSubEdit">取消</button>
              <button
                type="button"
                class="px-3 py-1.5 rounded-lg text-xs text-white bg-brand hover:bg-brand-dark disabled:opacity-50"
                :disabled="!capsuleSubForm.name.trim()"
                @click="saveCapsuleSubEdit"
              >
                {{ capsuleSubEditIndex === -1 ? '添加' : '保存' }}
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
              <template v-if="uploading">上传中…（剩余 {{ activeUploadCount }}）</template>
              <template v-else><span class="inline-flex items-center gap-1"><AppIcon name="plus" :size="12" />添加附件</span></template>
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
              <span class="shrink-0 text-brand/70 flex items-center"><AppIcon name="paperclip" :size="13" /></span>
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
                class="shrink-0 text-slate-400 hover:text-brand px-1 py-0.5 rounded"
                title="下载"
                @click="download(a)"
              >
                <AppIcon name="download" :size="14" />
              </button>
              <button
                type="button"
                class="shrink-0 text-slate-300 hover:text-red-500 px-1 py-0.5 rounded hover:bg-red-50"
                title="删除附件"
                @click="removeAttachment(a)"
              >
                <AppIcon name="close" :size="14" />
              </button>
            </div>
          </div>
        </div>

        <div v-if="err" class="text-sm text-red-500">{{ err }}</div>
        <div class="flex justify-between items-center gap-2 pt-1">
          <button
            v-if="!subtaskMode && task && !capsuleEdit"
            type="button"
            class="px-3 py-1.5 rounded-lg text-xs text-red-500 border border-red-200 hover:bg-red-50"
            @click="askDelete"
          >
            存入时间胶囊
          </button>
          <div class="flex justify-end gap-2 ml-auto">
            <button type="button" class="px-4 py-1.5 rounded-lg text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50" :disabled="saving" @click="cancel">
              取消
            </button>
            <button type="submit" class="px-4 py-1.5 rounded-lg text-sm text-white bg-brand hover:bg-brand-dark font-medium disabled:opacity-60" :disabled="saving">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
  <AttachmentPreviewModal :meta="previewMeta" @close="previewMeta = null" />
</template>

