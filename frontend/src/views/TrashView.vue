<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import AppIcon from '@/components/AppIcon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import TaskModal from '@/components/TaskModal.vue'
import TrashTaskDetailModal from '@/components/TrashTaskDetailModal.vue'
import type JSZip from 'jszip'
import { deleteAttachments, downloadAttachment } from '@/utils/attachments'
import { createOssClient } from '@/utils/oss'
import { formatTodayTitle, nowIso, todayKey } from '@/utils/time'
import { logAudit } from '@/utils/audit'
import { UNCATEGORIZED, type AttachmentMeta, type DeletedProject, type Project, type Task } from '@/types'

const auth = useAuthStore()
const projects = useProjectsStore()
const tasks = useTasksStore()
const ui = useUiStore()

/** 扫描时「加载今年数据」的目标年份：当前自然年（2026-01 至今） */
const CURRENT_YEAR = new Date().getFullYear()

/** 回收站同时支持活跃项目与已删除项目：导出/展示时都必须能取到项目名称 */
function projectById(id: string): Project | DeletedProject | undefined {
  if (!id || id === UNCATEGORIZED) return undefined
  return projects.byId(id) ?? (projects.deletedProjects ?? []).find((x) => x.id === id)
}

const mobileActions = inject<{ title: string } | null>('mobile-actions', null)

const deleteTarget = ref<Task | null>(null)
const scanning = ref(false)
/** 恢复/永久删除等确认式保存进行中：OSS 返回前禁用确认框按钮，防重复提交 */
const busy = ref(false)
/** 扫描前回收站不显示任何内容（文件未加载，内存中的已完成任务也不展示） */
const scanned = ref(false)
/** 扫描结果：存在回收站文件的项目 id（仅元数据，未下载文件内容） */
const scanIds = ref<string[]>([])
const scanHasUncategorized = ref(false)
/** 扫描时各项目回收站文件的最新变动时间（ISO），用于项目名列表倒序排序；无 list 权限时为 {} */
const scanLatest = ref<Record<string, string>>({})

/** 项目展开状态：默认全部折叠。按用户记忆到 localStorage（登出换账号互不干扰） */
const expandedKey = () => `trash_expanded:${auth.username}`
const expanded = ref<Record<string, boolean>>({})
function loadExpanded() {
  try {
    expanded.value = JSON.parse(localStorage.getItem(expandedKey()) ?? '{}')
  } catch {
    expanded.value = {}
  }
}
function isExpanded(key: string) {
  return !!expanded.value[key]
}

/** 展开后正在按需加载回收站文件的项目 id（加载失败可再次点击项目名重试） */
const loading = ref<Record<string, boolean>>({})
const loadError = ref<Record<string, boolean>>({})

/** 每个项目默认展示的回收站记录条数（最近 100 条）；更早记录通过「加载更早」追加 */
const TRASH_VISIBLE = 100
/** 每个项目当前已展示的条数上限 */
const visibleLimit = ref<Record<string, number>>({})
/** 「加载更早」进行中（按项目） */
const loadingMore = ref<Record<string, boolean>>({})

/** 搜索关键词：按项目名 / 已加载项目的任务名与内容过滤 */
const searchQuery = ref('')
/** 是否处于搜索状态（决定空状态文案） */
const searching = computed(() => searchQuery.value.trim().length > 0)

/** 扫描完成后「是否加载今年数据」的确认弹窗 */
const scanConfirmOpen = ref(false)
/** 「加载今年数据」进行中：禁用弹窗按钮防重复点击 */
const loadingYearAll = ref(false)

/** 详情/编辑弹窗状态 */
const detailTask = ref<Task | null>(null)
const editTask = ref<Task | null>(null)
const editOpen = ref(false)

/** 展开项目时只打开当前项目的数据包：仅加载该项目回收站文件，其余保持未加载 */
async function openGroup(key: string) {
  if (tasks.trashLoaded.includes(key) || loading.value[key]) return
  loading.value = { ...loading.value, [key]: true }
  loadError.value = { ...loadError.value, [key]: false }
  try {
    await tasks.loadTrash(key)
  } catch (e) {
    loadError.value = { ...loadError.value, [key]: true }
    ui.toast((e as Error).message || '时间胶囊文件加载失败，请检查网络或 OSS 配置', 'error')
  } finally {
    loading.value = { ...loading.value, [key]: false }
  }
}

function toggleGroup(key: string) {
  const next = !isExpanded(key)
  expanded.value = { ...expanded.value, [key]: next }
  localStorage.setItem(expandedKey(), JSON.stringify(expanded.value))
  if (next) {
    // 展开时固定该项目（回收站文件常驻内存），折叠/离开时解除固定
    tasks.pinViewProject(key)
    void openGroup(key)
  } else {
    tasks.unpinViewProject(key)
  }
}

/** 「加载更早」：先把已加载但未展示的记录就地展示更多；展示完后再拉取更早分片 */
async function loadMoreGroup(key: string) {
  if (loadingMore.value[key]) return
  const arr = tasks.trash[key] ?? []
  const limit = visibleLimit.value[key] ?? TRASH_VISIBLE
  if (arr.length > limit) {
    visibleLimit.value = { ...visibleLimit.value, [key]: limit + TRASH_VISIBLE }
    return
  }
  loadingMore.value = { ...loadingMore.value, [key]: true }
  try {
    const got = await tasks.loadMoreTrash(key)
    visibleLimit.value = { ...visibleLimit.value, [key]: limit + TRASH_VISIBLE }
    if (!got) ui.toast('已加载全部时间胶囊记录')
  } catch (e) {
    ui.toast((e as Error).message || '加载更早记录失败，请检查网络或 OSS 配置', 'error')
  } finally {
    loadingMore.value = { ...loadingMore.value, [key]: false }
  }
}

/** 只读本地基础数据：档案（活跃/已删除项目），不预载任何回收站文件内容 */
async function loadTrashBase() {
  if (!projects.loaded) await projects.load()
}

const MOBILE_TITLE = '时间胶囊'
onMounted(async () => {
  if (mobileActions) mobileActions.title = MOBILE_TITLE
  loadExpanded()
  await loadTrashBase()
  logAudit('打开时间胶囊')
})
onUnmounted(() => {
  // 离开回收站：解除全部展开项目的固定，交回 LRU 逐出
  for (const k of Object.keys(expanded.value)) tasks.unpinViewProject(k)
  if (mobileActions && mobileActions.title === MOBILE_TITLE) mobileActions.title = ''
})

watch(
  () => auth.creds,
  async (c) => {
    // 切换账号/登出时清空上一账号的扫描结果，避免串数据
    scanned.value = false
    scanIds.value = []
    scanLatest.value = {}
    scanHasUncategorized.value = false
    page.value = 1
    visibleLimit.value = {}
    loadingMore.value = {}
    if (c) {
      loadExpanded()
      await loadTrashBase()
    }
  },
)

/** 用户主动点击才扫描时间胶囊：只枚举哪些项目存在回收站文件（元数据），不下载任何文件内容 */
async function scanTrash() {
  if (scanning.value) return
  scanning.value = true
  try {
    if (!projects.loaded) await projects.load()
    const res = await tasks.listTrashProjects()
    if (res.listed) {
      scanIds.value = res.ids
      scanLatest.value = res.latestByProject
      scanHasUncategorized.value = res.hasUncategorized
    } else {
      // 无 list 权限：降级为全部已知项目（展开时仍按需加载，空项目展开显示为空）
      scanIds.value = projects.projects.map((p) => p.id)
      scanLatest.value = {}
      scanHasUncategorized.value = true
    }
    scanned.value = true
    page.value = 1
    visibleLimit.value = {}
    loadingMore.value = {}
    logAudit('扫描时间胶囊', `发现 ${scanIds.value.length} 个项目的胶囊数据`)
    // 扫描完成：提示用户是否加载今年数据
    scanConfirmOpen.value = true
  } catch (e) {
    ui.toast((e as Error).message || '时间胶囊扫描失败，请检查网络或 OSS 配置', 'error')
  } finally {
    scanning.value = false
  }
}

/** 扫描确认弹窗「仅项目名称」：收起全部项目，仅展示项目名列表，点击项目后再按需加载 */
function scanOnlyNames() {
  scanConfirmOpen.value = false
  collapseAll()
  ui.toast('时间胶囊已扫描')
}

/** 扫描确认弹窗「加载今年数据」：只下载今年（2026-01 至今）各项目数据并全部展开，更早年份按需加载 */
async function loadYearAll() {
  if (loadingYearAll.value) return
  loadingYearAll.value = true
  try {
    const res = await tasks.loadTrashYearAll(CURRENT_YEAR)
    // 全部项目展开并记忆（钉住内存，避免被 LRU 逐出）；未加载的项目仍按需加载
    const next: Record<string, boolean> = {}
    for (const g of projectGroups.value) {
      next[g.key] = true
      tasks.pinViewProject(g.key)
      if (!g.loaded) void openGroup(g.key)
    }
    expanded.value = next
    localStorage.setItem(expandedKey(), JSON.stringify(next))
    ui.toast(`已加载 ${res.projects} 个项目的今年数据（${res.tasks} 条任务）`)
  } catch (e) {
    ui.toast((e as Error).message || '加载今年数据失败，请检查网络或 OSS 配置', 'error')
  } finally {
    loadingYearAll.value = false
    scanConfirmOpen.value = false
  }
}

interface TrashGroup {
  key: string
  label: string
  deleted: boolean
  /** 已删除项目元数据（供「恢复整个项目」使用） */
  deletedProject: DeletedProject | null
  tasks: Task[]
  /** 该项目的回收站文件是否已加载 */
  loaded: boolean
  /** 是否还有更早记录可加载（已加载但未展示 / OSS 上还有更早分片） */
  hasMore: boolean
  /** 排序键：回收站最新变动时间（ISO），用于项目名倒序；缺失时为空 */
  updatedAt: string
}

/** 回收站按项目分组：展开时才加载该项目文件；统一按“回收站最新变动时间”倒序（新回收的排前面） */
const projectGroups = computed<TrashGroup[]>(() => {
  if (!scanned.value) return []
  const seen = new Set<string>()
  const groups: TrashGroup[] = []
  /** 本地已加载回收站里任务的最新时间，作为扫描时间缺失时的兜底排序键 */
  const maxTaskTime = (key: string) => {
    const arr = tasks.trash[key] ?? []
    return arr.reduce((m, t) => (t.updatedAt > m ? t.updatedAt : m), '')
  }
  const push = (key: string, label: string, deleted: boolean, deletedProject: DeletedProject | null) => {
    if (seen.has(key)) return
    seen.add(key)
    const arr = (tasks.trash[key] ?? []).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    // 默认只展示最近 100 条；更早的通过「加载更早」追加
    const limit = visibleLimit.value[key] ?? TRASH_VISIBLE
    // 排序键：优先扫描到的回收站文件最新变动时间；已删除项目回退到删除时间；
    // 再回退到本地已加载任务的最新时间；全无则为空（排最后，按名称正序）
    const updatedAt =
      scanLatest.value[key] ||
      (deleted && deletedProject ? deletedProject.deletedAt : '') ||
      maxTaskTime(key)
    groups.push({
      key,
      label,
      deleted,
      deletedProject,
      tasks: arr.slice(0, limit),
      loaded: tasks.trashLoaded.includes(key),
      hasMore: arr.length > limit || !!tasks.trashHasMore[key],
      updatedAt,
    })
  }
  // 活跃项目：仅在扫描发现有回收站文件、或本地已加载过其回收站数据时展示
  for (const p of projects.projects) {
    if (scanIds.value.includes(p.id) || (tasks.trash[p.id]?.length ?? 0) > 0) {
      push(p.id, p.name, false, null)
    }
  }
  // 已删除项目：始终展示（支持整项目恢复），即使回收站文件为空
  const deletedList = [...(projects.deletedProjects ?? [])].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  for (const dp of deletedList) push(dp.id, dp.name, true, dp)
  // 未分类回收站（today_trash.json）
  if (scanHasUncategorized.value || (tasks.trash[UNCATEGORIZED]?.length ?? 0) > 0) {
    push(UNCATEGORIZED, '无分类', false, null)
  }
  // 扫描发现但不在档案中的历史项目（孤儿回收站）
  for (const pid of scanIds.value) {
    if (projects.byId(pid)) continue
    if ((projects.deletedProjects ?? []).some((x) => x.id === pid)) continue
    push(pid, `未知项目（${pid.slice(0, 8)}…）`, false, null)
  }
  // 倒序排序（新回收的排前面）；排序键缺失时按名称正序，保证顺序稳定
  groups.sort((a, b) => {
    const ta = a.updatedAt
    const tb = b.updatedAt
    if (ta && tb && ta !== tb) return ta > tb ? -1 : 1
    if (ta && !tb) return -1
    if (!ta && tb) return 1
    return a.label.localeCompare(b.label)
  })
  // 搜索过滤：项目名包含关键词，或已加载项目中任务名/内容匹配
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return groups
  const out: TrashGroup[] = []
  for (const g of groups) {
    if (g.label.toLowerCase().includes(q)) {
      out.push(g)
      continue
    }
    // 只搜已加载过的项目任务（未加载的项目内容不可搜索）
    if (!g.loaded) continue
    const matched = (tasks.trash[g.key] ?? []).filter((t) => {
      const name = (t.name || '').toLowerCase()
      const desc = (t.description || '').toLowerCase()
      return name.includes(q) || desc.includes(q)
    })
    if (!matched.length) continue
    out.push({
      ...g,
      tasks: matched.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      hasMore: false,
    })
  }
  return out
})

/** 回收站项目名列表分页：每页 20 个；进入/重新扫描回到第 1 页，翻页时收起全部项目 */
const PAGE_SIZE = 20
const page = ref(1)
const jumpPage = ref(1)
const totalPages = computed(() => Math.max(1, Math.ceil(projectGroups.value.length / PAGE_SIZE)))
const paginatedGroups = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return projectGroups.value.slice(start, start + PAGE_SIZE)
})
/** 页码条：总页数 >7 时只显示 首页/末页/当前页附近，中间用省略号折叠 */
const pageItems = computed<(number | '…')[]>(() => {
  const total = totalPages.value
  const cur = page.value
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const shown = new Set<number>()
  ;[1, total, cur - 1, cur, cur + 1].forEach((n) => {
    if (n >= 1 && n <= total) shown.add(n)
  })
  const items: (number | '…')[] = []
  let prev = 0
  for (const n of [...shown].sort((a, b) => a - b)) {
    if (n - prev > 1) items.push('…')
    items.push(n)
    prev = n
  }
  return items
})
function goToPage(p: number | '…') {
  if (typeof p !== 'number') return
  const target = Math.max(1, Math.min(Math.round(p) || 1, totalPages.value))
  if (target === page.value) return
  page.value = target
  collapseAll()
}
/** 收起全部项目（翻页/重新扫描时），并同步到 localStorage 记忆 */
function collapseAll() {
  expanded.value = {}
  localStorage.setItem(expandedKey(), JSON.stringify({}))
}
watch(totalPages, (t) => {
  if (page.value > t) {
    page.value = t
    collapseAll()
  }
})
watch(page, (v) => {
  jumpPage.value = v
})

/** 导出/清空回收站操作进行中：禁用对应按钮，防重复提交 */
const exportBusy = ref(false)
const clearBusy = ref(false)
const clearOpen = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

/** 收集全部回收站数据（含项目名）：加载所有项目的回收站文件，返回便于导出/清空的结构 */
async function collectAllTrash(): Promise<{ projectId: string; name: string; tasks: Task[]; project?: Project | DeletedProject }[]> {
  if (!projects.loaded) await projects.load()
  const res = await tasks.listTrashProjects()
  const pids = new Set<string>(res.ids)
  // 本地已加载但扫描未覆盖的项目也纳入（如无 list 权限的降级场景）
  for (const pid of Object.keys(tasks.trash)) if ((tasks.trash[pid]?.length ?? 0) > 0) pids.add(pid)
  if (!res.listed) for (const p of projects.projects) pids.add(p.id)
  pids.add(UNCATEGORIZED)
  const out: { projectId: string; name: string; tasks: Task[]; project?: Project | DeletedProject }[] = []
  for (const pid of pids) {
    if (!tasks.trashLoaded.includes(pid)) {
      try {
        await tasks.loadTrash(pid)
      } catch {
        continue
      }
    }
    // 导出/清空需要完整数据：把更早分片也全部拉进内存（防御性上限 600 个月）
    let guard = 0
    while (tasks.trashHasMore[pid] && guard < 600) {
      try {
        if (!(await tasks.loadMoreTrash(pid))) break
      } catch {
        break
      }
      guard += 1
    }
    const arr = tasks.trash[pid] ?? []
    if (!arr.length) continue
    const meta = projectById(pid)
    out.push({
      projectId: pid,
      name: pid === UNCATEGORIZED ? '无分类' : meta?.name || `未知项目（${pid.slice(0, 8)}…）`,
      tasks: arr,
      project: pid === UNCATEGORIZED || !meta ? undefined : { ...meta },
    })
  }
  return out
}

/** 收集任务及其子任务的附件元数据（按 OSS key 去重） */
function collectAttachments(list: Task[]): AttachmentMeta[] {
  const out: AttachmentMeta[] = []
  const seen = new Set<string>()
  const push = (arr?: AttachmentMeta[]) => {
    for (const a of arr ?? []) {
      if (!a?.key || seen.has(a.key)) continue
      seen.add(a.key)
      out.push(a)
    }
  }
  for (const t of list) {
    push(t.attachments)
    for (const sb of t.subtasks ?? []) push(sb.attachments)
  }
  return out
}

/** 按需加载 jszip：仅导出/导入回收站备份时才拉取压缩库，避免进入回收站页即下载 */
async function loadJSZip() {
  return (await import('jszip')).default
}

/** 一次性导出全部回收站为 ZIP 备份（任务 JSON + 附件二进制），可用来导入恢复 */
async function exportTrash() {
  if (exportBusy.value) return
  exportBusy.value = true
  try {
    const projectsData = await collectAllTrash()
    if (!projectsData.length) {
      ui.toast('时间胶囊为空，无需导出', 'error')
      return
    }
    const payload = { exportedAt: nowIso(), version: 1, projects: projectsData }
    const zip = new (await loadJSZip())()
    zip.file('data.json', JSON.stringify(payload, null, 2))
    // 附件：逐个下载原始字节写入 zip（attachments/{key}）；单附件失败不中断
    const allAtts = collectAttachments(projectsData.flatMap((p) => p.tasks))
    const attFolder = zip.folder('attachments')
    let failedAtts = 0
    if (attFolder) {
      for (const meta of allAtts) {
        try {
          if (!auth.creds) continue
          const blob = await downloadAttachment(auth.creds, meta)
          attFolder.file(meta.key, blob)
        } catch {
          failedAtts += 1
        }
      }
    }
    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `时间胶囊备份-${todayKey()}.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    const count = projectsData.reduce((n, p) => n + p.tasks.length, 0)
    ui.toast(
      failedAtts
        ? `已导出 ${count} 条时间胶囊记录（${failedAtts} 个附件下载失败）`
        : `已导出 ${count} 条时间胶囊记录及 ${allAtts.length} 个附件`,
    )
    logAudit('导出时间胶囊备份', `项目 ${projectsData.length} 个，任务 ${count} 条，附件 ${allAtts.length} 个（失败 ${failedAtts}）`)
  } catch (e) {
    ui.toast((e as Error).message || '导出失败，请检查网络或 OSS 配置', 'error')
  } finally {
    exportBusy.value = false
  }
}

function onPickImport() {
  fileInput.value?.click()
}

/** 从备份 ZIP（含附件）或旧版 JSON（无附件）导入回收站：
 *  按项目合并去重（以任务 id 为键，导入记录优先），附件按原 key 上传回 OSS，立即写盘 */
async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    let data: { projects?: unknown } = {}
    const attBlobs = new Map<string, Blob>()
    let zip: JSZip | null = null
    try {
      zip = await (await loadJSZip()).loadAsync(file)
    } catch {
      zip = null
    }
    if (zip) {
      const dataFile = zip.file('data.json')
      if (!dataFile) throw new Error('备份 ZIP 缺少 data.json')
      data = JSON.parse(await dataFile.async('string'))
      const prefix = 'attachments/'
      for (const name of Object.keys(zip.files)) {
        if (!name.startsWith(prefix)) continue
        const entry = zip.files[name]
        if (entry.dir) continue
        attBlobs.set(name.slice(prefix.length), await entry.async('blob'))
      }
    } else {
      data = JSON.parse(await file.text())
    }
    if (!data || !Array.isArray(data.projects)) throw new Error('备份文件格式不正确')
    let count = 0
    let touched = 0
    let attOk = 0
    let attFailed = 0
    let profileChanged = false
    for (const p of data.projects) {
      const pid = typeof p?.projectId === 'string' && p.projectId ? p.projectId : UNCATEGORIZED
      if (!Array.isArray(p.tasks)) continue
      const list = (p.tasks as Task[]).filter((t) => t && t.id)
      if (!list.length) continue
      // 项目名称随备份一起导入：缺失时注册为已删除项目，回收站可显示原名并支持整项目恢复
      if (pid !== UNCATEGORIZED && !projects.byId(pid)) {
        const meta = (p as { project?: Project | DeletedProject })?.project
        const exportedName = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : ''
        const useName =
          meta?.name ||
          (exportedName && !exportedName.startsWith('未知项目（') ? exportedName : '') ||
          '已删除项目'
        const existing = (projects.deletedProjects ?? []).find((x) => x.id === pid)
        if (!existing) {
          projects.deletedProjects = [
            ...(projects.deletedProjects ?? []),
            {
              id: pid,
              name: useName,
              color: meta?.color || '#3b82f6',
              icon: meta?.icon || '📁',
              deletedAt: (meta as DeletedProject | undefined)?.deletedAt || nowIso(),
            },
          ]
          profileChanged = true
        } else if (useName !== '已删除项目' && existing.name !== useName) {
          existing.name = useName
          profileChanged = true
        }
      }
      // 附件：按原 key 把 zip 中的二进制上传回用户 OSS（保持任务 JSON 无需改写）
      if (auth.creds) {
        const metas = collectAttachments(list)
        const client = await createOssClient(auth.creds)
        for (const meta of metas) {
          const blob = attBlobs.get(meta.key)
          if (!blob) {
            attFailed += 1
            continue
          }
          try {
            await client.put(meta.key, blob)
            attOk += 1
          } catch {
            attFailed += 1
          }
        }
      }
      const existing = tasks.trash[pid] ?? []
      tasks.trash[pid] = [...list, ...existing.filter((t) => !list.some((x) => x.id === t.id))]
      const ok = await tasks.saveTrashNow(pid)
      if (ok) {
        touched += 1
        count += list.length
      }
    }
    if (profileChanged && touched > 0) await projects.saveNow()
    if (count > 0) {
      ui.toast(
        attOk || attFailed
          ? `已导入 ${count} 条时间胶囊记录（附件 ${attOk} 个成功${attFailed ? `，${attFailed} 个缺失/失败` : ''}）`
          : `已导入 ${count} 条时间胶囊记录`,
      )
      logAudit('导入时间胶囊备份', `${count} 条，附件 ${attOk} 成功 ${attFailed} 失败`)
    } else {
      ui.toast('备份文件中没有可导入的任务', 'error')
    }
  } catch (err) {
    ui.toast((err as Error).message || '导入失败，请检查备份文件', 'error')
  }
}

/** 清空回收站：把所有项目的回收站置空并落盘，同时删除对应附件二进制（二次确认） */
async function clearTrash() {
  if (clearBusy.value) return
  clearBusy.value = true
  try {
    const all = await collectAllTrash()
    if (!all.length) {
      ui.toast('时间胶囊已为空')
      clearOpen.value = false
      return
    }
    let cleared = 0
    let deletedAtts = 0
    const clearedPids = new Set<string>()
    for (const p of all) {
      const atts = collectAttachments(p.tasks)
      // 删除物理分片文件（含旧版 trash.json / today_trash.json），项目名随之从扫描结果消失
      await tasks.purgeTrashFiles(p.projectId)
      cleared += p.tasks.length
      clearedPids.add(p.projectId)
      // 清空后再清理附件二进制，避免元数据指向已删除文件
      if (atts.length && auth.creds) {
        await deleteAttachments(auth.creds, atts)
        deletedAtts += atts.length
      }
    }
    // 本地扫描结果同步移除被清空的项目
    scanIds.value = scanIds.value.filter((pid) => !clearedPids.has(pid))
    for (const pid of clearedPids) delete scanLatest.value[pid]
    if (clearedPids.has(UNCATEGORIZED)) scanHasUncategorized.value = false
    ui.toast(`已清空时间胶囊（${cleared} 条，清理附件 ${deletedAtts} 个）`)
    logAudit('清空时间胶囊', `${cleared} 条，附件 ${deletedAtts} 个`)
  } catch (e) {
    ui.toast((e as Error).message || '清空失败，请检查网络或 OSS 配置', 'error')
  } finally {
    clearBusy.value = false
    clearOpen.value = false
  }
}

const projectOf = (id: string) => projectById(id)

async function restore(t: Task) {
  if (busy.value) return
  busy.value = true
  try {
    let toProjectId: string | undefined
    // 若任务的原项目已被删除（孤儿任务），恢复时必须归入现有项目，
    // 否则会写入已删除项目的 tasks.json，刷新后任何视图都读不到。
    if (t.projectId && !projects.byId(t.projectId)) {
      const fallback = projects.projects[0]
      if (fallback) {
        toProjectId = fallback.id
      } else {
        const p = projects.addProject('恢复的任务')
        // 兜底新建项目也立即落盘 profile，避免任务恢复成功但项目不在 profile 里形成孤儿数据
        await projects.saveNow()
        toProjectId = p.id
      }
    }
    // 确认式恢复：任务/回收站落盘成功才提示
    const ok = await tasks.restoreConfirmed(t.id, toProjectId)
    if (ok) ui.toast('已恢复')
    // store 失败时已弹错误提示，任务保持在回收站
  } finally {
    busy.value = false
  }
}

/** 恢复整个项目：无重名时还原为独立项目，重名时并入同名项目 */
async function restoreProjectGroup(g: TrashGroup) {
  if (!g.deletedProject) return
  const target = await projects.restoreProject(g.deletedProject.id)
  if (target) ui.toast('项目已恢复')
  else ui.toast('项目恢复失败', 'error')
}

function askDelete(t: Task) {
  deleteTarget.value = t
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  const t = deleteTarget.value
  // 确认按钮前端立即生效：关弹窗；保存结果由回显后的 toast 提示
  deleteTarget.value = null
  const ok = await tasks.permanentDeleteConfirmed(t.projectId, t.id)
  if (ok) ui.toast('已永久删除')
}

/** 打开任务详情弹窗 */
function openDetail(t: Task) {
  detailTask.value = t
}

/** 详情弹窗「编辑」：关闭详情，打开胶囊编辑弹窗 */
function openEdit(t: Task) {
  detailTask.value = null
  editTask.value = t
  editOpen.value = true
}

/** 胶囊编辑保存成功：关闭弹窗并提示 */
function onCapsuleSaved() {
  editOpen.value = false
  editTask.value = null
  detailTask.value = null
  ui.toast('已保存到时间胶囊')
}
</script>

<template>
  <div class="p-4 sm:p-6 max-w-3xl mx-auto">
    <div class="hidden lg:flex items-center gap-2.5">
      <span class="w-9 h-9 rounded-xl bg-white border border-line shadow-card text-brand flex items-center justify-center shrink-0">
        <AppIcon name="trash" :size="18" />
      </span>
      <h1 class="text-xl font-bold text-slate-800">时间胶囊</h1>
    </div>
    <div class="mt-0.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div class="text-xs text-slate-400 leading-relaxed">存入时间胶囊的任务与项目，永不自动清理。扫描只列出有时间胶囊数据的项目，展开项目时才加载对应文件</div>
      <div class="flex flex-wrap items-center gap-2">
        <button
          class="inline-flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-xs border border-slate-200 hover:bg-slate-50 disabled:opacity-60"
          :disabled="exportBusy"
          @click="exportTrash"
        >
          <AppIcon name="download" :size="13" class="text-slate-500" />
          {{ exportBusy ? '导出中…' : '导出备份' }}
        </button>
        <button
          class="inline-flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-xs border border-slate-200 hover:bg-slate-50"
          @click="onPickImport"
        >
          <AppIcon name="upload" :size="13" class="text-slate-500" />
          从备份导入
        </button>
        <button
          class="inline-flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-xs border border-red-200 text-red-500 hover:bg-red-50 disabled:opacity-60"
          :disabled="clearBusy"
          @click="clearOpen = true"
        >
          <AppIcon name="trash" :size="13" class="shrink-0" />
          {{ clearBusy ? '清空中…' : '清空时间胶囊' }}
        </button>
        <button
          class="inline-flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-xs border border-slate-200 hover:bg-slate-50 disabled:opacity-60"
          :disabled="scanning"
          @click="scanTrash"
        >
          <AppIcon name="search" :size="13" class="text-slate-500" />
          {{ scanning ? '扫描中…' : '扫描时间胶囊文件' }}
        </button>
      </div>
      <input ref="fileInput" type="file" accept=".zip,.json,application/json,application/zip" class="hidden" @change="onImportFile" />
    </div>

    <!-- 搜索：项目名 + 已加载项目的任务名/内容 -->
    <div class="mt-4">
      <div class="relative">
        <AppIcon name="search" :size="15" class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="搜索项目名 / 任务名 / 任务内容（仅已加载的项目）"
          class="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand focus:outline-none"
        />
      </div>
      <div v-if="searching" class="mt-1.5 text-[11px] text-slate-400">
        仅搜索已加载的项目与任务；未加载的项目请先展开后再搜索
      </div>
    </div>

    <div v-if="!projectGroups.length" class="mt-4 py-16 text-center text-sm text-slate-400">
      <template v-if="searching">未找到匹配的时间胶囊记录</template>
      <template v-else-if="scanned">未发现时间胶囊数据</template>
      <template v-else>时间胶囊未扫描，点击右上角「扫描时间胶囊文件」后可见历史任务</template>
    </div>
    <div v-for="g in paginatedGroups" :key="g.key" class="mt-4">
      <div class="flex items-center gap-2 mb-2">
        <button
          class="flex items-center gap-2 flex-1 min-w-0 px-0.5 py-1 rounded-lg hover:bg-slate-50 text-left"
          :title="isExpanded(g.key) ? '点击折叠' : '点击展开并加载该项目时间胶囊'"
          @click="toggleGroup(g.key)"
        >
          <span class="w-4 flex items-center justify-center text-slate-400 shrink-0">
            <AppIcon :name="isExpanded(g.key) ? 'chevron-down' : 'chevron-right'" :size="14" />
          </span>
          <span class="text-sm font-medium text-slate-600 truncate">{{ g.label }}</span>
          <span v-if="g.deleted" class="shrink-0 text-[11px] text-slate-400">已删除项目</span>
          <span class="shrink-0 text-[11px] text-slate-400">
            <template v-if="g.loaded">（{{ g.tasks.length }}）</template>
            <template v-else-if="loading[g.key]">加载中…</template>
            <template v-else>（…）</template>
          </span>
        </button>
        <button
          v-if="g.deleted"
          class="shrink-0 px-3 py-1 rounded-lg text-xs text-brand border border-brand/30 hover:bg-brand/5"
          title="恢复整个项目（重名时自动合并进同名项目）"
          @click="restoreProjectGroup(g)"
        >
          <AppIcon name="rotate-ccw" :size="12" class="shrink-0" />
          恢复整个项目
        </button>
      </div>
      <div v-if="isExpanded(g.key)" class="space-y-2">
        <div v-if="loading[g.key]" class="px-0.5 py-2 text-xs text-slate-400">正在加载该项目的时间胶囊数据…</div>
        <template v-else>
          <div v-if="loadError[g.key]" class="px-0.5 py-2 text-xs text-red-500">加载失败，点击项目名可重试</div>
          <div
            v-for="t in g.tasks"
            :key="t.id"
            class="bg-white rounded-xl border border-line shadow-card p-4 flex items-center gap-3"
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-slate-700 truncate">{{ t.name || '未命名任务' }}</span>
                <span
                  class="text-[11px] px-1.5 py-0.5 rounded-full shrink-0"
                  :class="t.status === 'deleted' ? 'bg-red-50 text-red-500' : 'bg-slate-100 text-slate-500'"
                >
                  {{ t.status === 'deleted' ? '已删除' : '已完成' }}
                </span>
              </div>
              <div class="mt-1 flex flex-wrap gap-x-4 text-[11px] text-slate-400">
                <span>{{ t.projectId ? (projectOf(t.projectId)?.name ?? '未知项目') : '无分类' }}</span>
                <span>{{ formatTodayTitle(t.updatedAt) }}</span>
              </div>
            </div>
            <button
              class="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-slate-600 border border-slate-200 hover:bg-slate-50 shrink-0"
              title="查看任务详情"
              @click="openDetail(t)"
            >
              <AppIcon name="eye" :size="13" class="shrink-0" />
              详情
            </button>
            <button
              class="px-3 py-1.5 rounded-lg text-xs text-brand border border-brand/30 hover:bg-brand/5 shrink-0"
              @click="restore(t)"
            >
              恢复
            </button>
            <button
              class="px-3 py-1.5 rounded-lg text-xs text-red-500 border border-red-200 hover:bg-red-50 shrink-0"
              @click="askDelete(t)"
            >
              永久删除
            </button>
          </div>
          <button
            v-if="g.hasMore"
            class="mt-1 w-full py-2 rounded-lg text-xs text-brand border border-brand/30 hover:bg-brand/5 disabled:opacity-60 disabled:cursor-not-allowed"
            :disabled="loadingMore[g.key]"
            @click="loadMoreGroup(g.key)"
          >
            <AppIcon name="chevron-down" :size="13" class="inline-block -mt-0.5 mr-1" />
            {{ loadingMore[g.key] ? '加载中…' : '加载更早' }}
          </button>
          <div v-if="!loadError[g.key] && !g.tasks.length && !g.hasMore" class="text-xs text-slate-400 px-0.5">
            {{ g.deleted ? '该项目没有任务' : '该项目时间胶囊为空' }}
          </div>
        </template>
      </div>
    </div>

    <div
      v-if="totalPages > 1"
      class="mt-6 flex flex-wrap items-center justify-center gap-1.5 text-xs"
    >
      <button
        class="px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="page <= 1"
        @click="goToPage(page - 1)"
      >
        上一页
      </button>
      <template v-for="(it, i) in pageItems" :key="i">
        <span v-if="it === '…'" class="px-1 text-slate-400 select-none">…</span>
        <button
          v-else
          class="w-8 py-1.5 rounded-lg border"
          :class="it === page ? 'bg-brand text-white border-brand' : 'border-slate-200 text-slate-600 hover:bg-slate-50'"
          @click="goToPage(it)"
        >
          {{ it }}
        </button>
      </template>
      <button
        class="px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="page >= totalPages"
        @click="goToPage(page + 1)"
      >
        下一页
      </button>
      <span class="ml-2 flex items-center gap-1 text-slate-400">
        共 {{ projectGroups.length }} 个项目 / {{ totalPages }} 页
        <input
          v-model.number="jumpPage"
          type="number"
          min="1"
          :max="totalPages"
          class="w-14 rounded-lg border border-slate-200 px-1.5 py-1 text-center"
          @keyup.enter="goToPage(jumpPage)"
        />
        <button
          class="px-2 py-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
          @click="goToPage(jumpPage)"
        >
          跳至
        </button>
      </span>
    </div>

    <!-- 扫描完成：是否加载全部数据 -->
    <div
      v-if="scanConfirmOpen"
      class="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center px-4"
    >
      <div class="modal-panel rounded-2xl w-full max-w-md animate-modal-pop p-5">
        <h3 class="text-base font-semibold text-slate-800">扫描完成</h3>
        <p class="mt-2 text-sm text-slate-500 leading-relaxed">
          已发现 {{ scanIds.length }} 个项目的时间胶囊数据，是否加载全部数据？
        </p>
        <p class="mt-1 text-xs text-slate-400">选择「加载今年数据」只下载 {{ CURRENT_YEAR }}-01 至今的数据，更早年份仍按需加载。</p>
        <div class="mt-4 flex flex-col gap-2">
          <button
            class="w-full py-2 rounded-lg text-sm text-white bg-brand hover:bg-brand/90 disabled:opacity-60 disabled:cursor-not-allowed"
            :disabled="loadingYearAll"
            @click="loadYearAll"
          >
            {{ loadingYearAll ? '正在加载今年数据…' : `加载今年数据（${CURRENT_YEAR}-01 至今）` }}
          </button>
          <button
            class="w-full py-2 rounded-lg text-sm text-slate-700 bg-slate-100 hover:bg-slate-200"
            @click="scanOnlyNames"
          >
            仅加载项目名称
          </button>
          <button
            class="w-full py-2 rounded-lg text-sm text-slate-500 hover:bg-slate-100"
            @click="scanConfirmOpen = false"
          >
            取消
          </button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="!!deleteTarget"
      title="永久删除"
      message="永久删除后无法恢复，确定继续吗？"
      confirm-text="永久删除"
      :danger="true"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
    <ConfirmDialog
      :open="clearOpen"
      title="清空时间胶囊"
      message="将永久删除时间胶囊中的全部任务，且无法恢复，确定清空吗？建议先导出备份。"
      confirm-text="确认清空"
      :danger="true"
      :disabled="clearBusy"
      @confirm="clearTrash"
      @cancel="clearOpen = false"
    />

    <TrashTaskDetailModal
      :open="!!detailTask"
      :task="detailTask"
      @close="detailTask = null"
      @edit="openEdit"
    />
    <TaskModal
      v-model:open="editOpen"
      :task="editTask"
      :capsule-edit="true"
      @saved="onCapsuleSaved"
    />
  </div>
</template>
