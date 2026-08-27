<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import JSZip from 'jszip'
import { deleteAttachments, downloadAttachment } from '@/utils/attachments'
import { createOssClient } from '@/utils/oss'
import { formatTodayTitle, nowIso, todayKey } from '@/utils/time'
import { logAudit } from '@/utils/audit'
import { UNCATEGORIZED, type AttachmentMeta, type DeletedProject, type Task } from '@/types'

const auth = useAuthStore()
const projects = useProjectsStore()
const tasks = useTasksStore()
const ui = useUiStore()

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

/** 展开项目时只打开当前项目的数据包：仅加载该项目回收站文件，其余保持未加载 */
async function openGroup(key: string) {
  if (tasks.trashLoaded.includes(key) || loading.value[key]) return
  loading.value = { ...loading.value, [key]: true }
  loadError.value = { ...loadError.value, [key]: false }
  try {
    await tasks.loadTrash(key)
  } catch (e) {
    loadError.value = { ...loadError.value, [key]: true }
    ui.toast((e as Error).message || '回收站文件加载失败，请检查网络或 OSS 配置', 'error')
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

/** 只读本地基础数据：档案（活跃/已删除项目），不预载任何回收站文件内容 */
async function loadTrashBase() {
  if (!projects.loaded) await projects.load()
}

const MOBILE_TITLE = '回收站'
onMounted(async () => {
  if (mobileActions) mobileActions.title = MOBILE_TITLE
  loadExpanded()
  await loadTrashBase()
  logAudit('打开回收站')
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
    if (c) {
      loadExpanded()
      await loadTrashBase()
    }
  },
)

/** 用户主动点击才扫描回收站：只枚举哪些项目存在回收站文件（元数据），不下载任何文件内容 */
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
    collapseAll()
    ui.toast('回收站已扫描')
    logAudit('扫描回收站', `发现 ${scanIds.value.length} 个项目的回收站文件`)
  } catch (e) {
    ui.toast((e as Error).message || '回收站扫描失败，请检查网络或 OSS 配置', 'error')
  } finally {
    scanning.value = false
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
      tasks: arr,
      loaded: tasks.trashLoaded.includes(key),
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
  return groups
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
async function collectAllTrash(): Promise<{ projectId: string; name: string; tasks: Task[] }[]> {
  if (!projects.loaded) await projects.load()
  const res = await tasks.listTrashProjects()
  const pids = new Set<string>(res.ids)
  // 本地已加载但扫描未覆盖的项目也纳入（如无 list 权限的降级场景）
  for (const pid of Object.keys(tasks.trash)) if ((tasks.trash[pid]?.length ?? 0) > 0) pids.add(pid)
  if (!res.listed) for (const p of projects.projects) pids.add(p.id)
  pids.add(UNCATEGORIZED)
  const out: { projectId: string; name: string; tasks: Task[] }[] = []
  for (const pid of pids) {
    if (!tasks.trashLoaded.includes(pid)) {
      try {
        await tasks.loadTrash(pid)
      } catch {
        continue
      }
    }
    const arr = tasks.trash[pid] ?? []
    if (!arr.length) continue
    out.push({
      projectId: pid,
      name: pid === UNCATEGORIZED ? '无分类' : projects.byId(pid)?.name || `未知项目（${pid.slice(0, 8)}…）`,
      tasks: arr,
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

/** 一次性导出全部回收站为 ZIP 备份（任务 JSON + 附件二进制），可用来导入恢复 */
async function exportTrash() {
  if (exportBusy.value) return
  exportBusy.value = true
  try {
    const projectsData = await collectAllTrash()
    if (!projectsData.length) {
      ui.toast('回收站为空，无需导出', 'error')
      return
    }
    const payload = { exportedAt: nowIso(), version: 1, projects: projectsData }
    const zip = new JSZip()
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
    a.download = `回收站备份-${todayKey()}.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    const count = projectsData.reduce((n, p) => n + p.tasks.length, 0)
    ui.toast(
      failedAtts
        ? `已导出 ${count} 条回收站记录（${failedAtts} 个附件下载失败）`
        : `已导出 ${count} 条回收站记录及 ${allAtts.length} 个附件`,
    )
    logAudit('导出回收站备份', `项目 ${projectsData.length} 个，任务 ${count} 条，附件 ${allAtts.length} 个（失败 ${failedAtts}）`)
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
      zip = await JSZip.loadAsync(file)
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
    for (const p of data.projects) {
      const pid = typeof p?.projectId === 'string' && p.projectId ? p.projectId : UNCATEGORIZED
      if (!Array.isArray(p.tasks)) continue
      const list = (p.tasks as Task[]).filter((t) => t && t.id)
      if (!list.length) continue
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
    if (count > 0) {
      ui.toast(
        attOk || attFailed
          ? `已导入 ${count} 条回收站记录（附件 ${attOk} 个成功${attFailed ? `，${attFailed} 个缺失/失败` : ''}）`
          : `已导入 ${count} 条回收站记录`,
      )
      logAudit('导入回收站备份', `${count} 条，附件 ${attOk} 成功 ${attFailed} 失败`)
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
      ui.toast('回收站已为空')
      clearOpen.value = false
      return
    }
    let cleared = 0
    let deletedAtts = 0
    for (const p of all) {
      const atts = collectAttachments(p.tasks)
      tasks.trash[p.projectId] = []
      const ok = await tasks.saveTrashNow(p.projectId)
      if (ok) {
        cleared += p.tasks.length
        // 落盘成功后再清理附件二进制，避免保存失败导致元数据指向已删除文件
        if (atts.length && auth.creds) {
          await deleteAttachments(auth.creds, atts)
          deletedAtts += atts.length
        }
      }
    }
    ui.toast(`已清空回收站（${cleared} 条，清理附件 ${deletedAtts} 个）`)
    logAudit('清空回收站', `${cleared} 条，附件 ${deletedAtts} 个`)
  } catch (e) {
    ui.toast((e as Error).message || '清空失败，请检查网络或 OSS 配置', 'error')
  } finally {
    clearBusy.value = false
    clearOpen.value = false
  }
}

const projectOf = (id: string) => (id ? projects.byId(id) : undefined)

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
</script>

<template>
  <div class="p-4 sm:p-6 max-w-3xl mx-auto">
    <h1 class="hidden lg:block text-xl font-bold text-slate-800">🗑 回收站</h1>
    <div class="mt-0.5 flex items-center justify-between gap-3">
      <div class="text-xs text-slate-400">被删除的任务与项目，永不自动清理。扫描只列出有回收站文件的项目，展开项目时才加载对应文件</div>
      <div class="flex items-center gap-2">
        <button
          class="shrink-0 px-3 py-1.5 rounded-lg text-xs border border-slate-200 hover:bg-slate-50 disabled:opacity-60"
          :disabled="exportBusy"
          @click="exportTrash"
        >
          {{ exportBusy ? '导出中…' : '📤 导出备份' }}
        </button>
        <button
          class="shrink-0 px-3 py-1.5 rounded-lg text-xs border border-slate-200 hover:bg-slate-50"
          @click="onPickImport"
        >
          📥 从备份导入
        </button>
        <button
          class="shrink-0 px-3 py-1.5 rounded-lg text-xs border border-red-200 text-red-500 hover:bg-red-50 disabled:opacity-60"
          :disabled="clearBusy"
          @click="clearOpen = true"
        >
          {{ clearBusy ? '清空中…' : '🗑 清空回收站' }}
        </button>
        <button
          class="shrink-0 px-3 py-1.5 rounded-lg text-xs border border-slate-200 hover:bg-slate-50 disabled:opacity-60"
          :disabled="scanning"
          @click="scanTrash"
        >
          {{ scanning ? '扫描中…' : '📥 扫描回收站文件' }}
        </button>
      </div>
      <input ref="fileInput" type="file" accept=".zip,.json,application/json,application/zip" class="hidden" @change="onImportFile" />
    </div>

    <div v-if="!projectGroups.length" class="mt-4 py-16 text-center text-sm text-slate-400">
      {{ scanned ? '未发现回收站文件' : '回收站未扫描，点击右上角「扫描回收站文件」后可见历史任务' }}
    </div>
    <div v-for="g in paginatedGroups" :key="g.key" class="mt-4">
      <div class="flex items-center gap-2 mb-2">
        <button
          class="flex items-center gap-2 flex-1 min-w-0 px-0.5 py-1 rounded-lg hover:bg-slate-50 text-left"
          :title="isExpanded(g.key) ? '点击折叠' : '点击展开并加载该项目回收站'"
          @click="toggleGroup(g.key)"
        >
          <span class="w-4 text-center text-slate-400 text-xs shrink-0">{{ isExpanded(g.key) ? '▾' : '▸' }}</span>
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
          ↺ 恢复整个项目
        </button>
      </div>
      <div v-if="isExpanded(g.key)" class="space-y-2">
        <div v-if="loading[g.key]" class="px-0.5 py-2 text-xs text-slate-400">正在加载该项目的回收站文件…</div>
        <template v-else>
          <div v-if="loadError[g.key]" class="px-0.5 py-2 text-xs text-red-500">加载失败，点击项目名可重试</div>
          <div
            v-for="t in g.tasks"
            :key="t.id"
            class="bg-white rounded-xl shadow-sm border border-slate-100 p-4 flex items-center gap-3"
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-slate-700 truncate">{{ t.name }}</span>
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
          <div v-if="!loadError[g.key] && !g.tasks.length" class="text-xs text-slate-400 px-0.5">
            {{ g.deleted ? '该项目没有任务' : '该项目回收站为空' }}
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
      title="清空回收站"
      message="将永久删除回收站中的全部任务，且无法恢复，确定清空吗？建议先导出备份。"
      confirm-text="确认清空"
      :danger="true"
      :disabled="clearBusy"
      @confirm="clearTrash"
      @cancel="clearOpen = false"
    />
  </div>
</template>

