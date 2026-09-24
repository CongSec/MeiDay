<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import AppIcon from '@/components/AppIcon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import TaskModal from '@/components/TaskModal.vue'
import TimeCapsuleCalendar from '@/components/TimeCapsuleCalendar.vue'
import TimeCapsuleHeatmap from '@/components/TimeCapsuleHeatmap.vue'
import TimeCapsuleTrend from '@/components/TimeCapsuleTrend.vue'
import type JSZip from 'jszip'
import { deleteAttachments, downloadAttachment } from '@/utils/attachments'
import { createOssClient } from '@/utils/oss'
import { dateKeyOf, formatTodayTitle, nowIso, todayKey } from '@/utils/time'
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

/** 展开的项目默认展示的月份数（最近 N 个月，最新在前）；更早月份通过「加载更早月份」追加。
 *  所选年份数据已一次性全部加载进内存，追加月份只是把内存中已有月份纳入展示，不发起网络请求 */
const MONTHS_VISIBLE = 1
/** 每个项目当前已展示的月份数（切年/翻页/重新扫描时重置） */
const visibleMonths = ref<Record<string, number>>({})

/** 搜索关键词：按项目名 / 已加载项目的任务名与内容过滤 */
const searchQuery = ref('')
/** 搜索输入（防抖后写入 searchQuery，避免大列表每敲一个字符就全量过滤） */
const searchInput = ref('')
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(searchInput, (v) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchQuery.value = v
  }, 200)
})
/** 是否处于搜索状态（决定空状态文案） */
const searching = computed(() => searchQuery.value.trim().length > 0)

/** 编辑弹窗状态（任务详情页已废弃，所有视图点击任务直接进编辑） */
const editTask = ref<Task | null>(null)
const editOpen = ref(false)
/** 重复模板 master id：非空时编辑的是「未来重复日」小块，保存走未来任务流程 */
const editTemplateMasterId = ref<string | null>(null)

/** 多视图：当前视图（默认落到日历图；数据按所选年份一次性加载进内存，切换视图不触发网络请求） */
const viewMode = ref<'list' | 'calendar' | 'heatmap' | 'trend'>('calendar')
const VIEW_TABS: { key: typeof viewMode.value; label: string; icon: string }[] = [
  { key: 'list', label: '项目图', icon: 'menu' },
  { key: 'calendar', label: '日历图', icon: 'calendar' },
  { key: 'heatmap', label: '热力图', icon: 'flame' },
  { key: 'trend', label: '趋势图', icon: 'chart' },
]
/** 多视图当前查看的年份 / 月份（默认今年 / 当月） */
const viewYear = ref(CURRENT_YEAR)
const viewMonth = ref(CURRENT_YEAR + '-' + String(new Date().getMonth() + 1).padStart(2, '0'))
/** 多视图加载进行中：显示「正在下载OSS数据并进行本地计算中......」（首次进入/切年时为 true） */
const viewLoading = ref(true)
/** 年份选择弹窗：可选年份（服务器上确有回收站数据的年份，倒序）与当前选中 */
const pickerOpen = ref(false)
const pickerYears = ref<number[]>([])
const yearPicked = ref(CURRENT_YEAR)
/** 当前月的 YYYY-MM */
function currentMonthKey(): string {
  return `${CURRENT_YEAR}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
}

/** 折叠/展开项目：所选年份数据已一次性加载进内存，折叠只收拢 UI（不再按需拉取） */
function toggleGroup(key: string) {
  const next = !isExpanded(key)
  expanded.value = { ...expanded.value, [key]: next }
  localStorage.setItem(expandedKey(), JSON.stringify(expanded.value))
}

/** 展开区展示的月份分组：默认只展示最近 N 个月，更早月份通过「加载更早月份」追加（数据已在内存，纯 UI 切片） */
function visibleMonthGroups(g: TrashGroup): { key: string; tasks: Task[] }[] {
  return g.monthGroups.slice(0, visibleMonths.value[g.key] ?? MONTHS_VISIBLE)
}

/** 「加载更早月份」：把下一个更早月份纳入展示（同步、无网络请求） */
function loadMoreGroup(key: string) {
  visibleMonths.value = { ...visibleMonths.value, [key]: (visibleMonths.value[key] ?? MONTHS_VISIBLE) + 1 }
}

/** 只读本地基础数据：档案（活跃/已删除项目），不预载任何回收站文件内容 */
async function loadTrashBase() {
  if (!projects.loaded) await projects.load()
}

const MOBILE_TITLE = '时间胶囊'
/** 首次进入 / 切换账号后：静默扫描并加载当前年份数据，直接落到日历图 */
async function loadCurrentYear() {
  viewLoading.value = true
  try {
    await scanTrashMeta()
    await tasks.switchTrashYear(CURRENT_YEAR)
    visibleMonths.value = {}
    viewYear.value = CURRENT_YEAR
    viewMonth.value = currentMonthKey()
    viewMode.value = 'calendar'
  } catch (e) {
    ui.toast((e as Error).message || '时间胶囊加载失败，请检查网络或 OSS 配置', 'error')
  } finally {
    viewLoading.value = false
  }
}

onMounted(async () => {
  if (mobileActions) mobileActions.title = MOBILE_TITLE
  loadExpanded()
  await loadTrashBase()
  await loadCurrentYear()
  logAudit('打开时间胶囊')
})
onUnmounted(() => {
  if (mobileActions && mobileActions.title === MOBILE_TITLE) mobileActions.title = ''
  // 退出时间胶囊：释放内存 + 清空 IDB 缓存（trash 数据 + etag/lm），下次进入重新下载当前年份
  void tasks.releaseTrashMemory()
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
    visibleMonths.value = {}
    pickerOpen.value = false
    if (c) {
      loadExpanded()
      await loadTrashBase()
      await loadCurrentYear()
    }
  },
)

/** 进行中的扫描 Promise：首屏 / 切年 / 手动点击扫描并发时复用，避免重复扫描/读到半成品索引 */
let scanInFlight: Promise<void> | null = null
/** 扫描时间胶囊：只枚举哪些项目存在回收站文件（元数据）与分片月份索引，不下载任何文件内容。
 *  首屏进入与「扫描时间胶囊文件」按钮共用；切年时按所选年份一次性拉取（配合 Last-Modified
 *  304 缓存，重复进入几乎零流量）。 */
async function scanTrashMeta(): Promise<void> {
  if (scanInFlight) return scanInFlight
  const p = (async () => {
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
        // 无 list 权限：降级为全部已知项目（切年时按分片缺失降级加载）
        scanIds.value = projects.projects.map((p) => p.id)
        scanLatest.value = {}
        scanHasUncategorized.value = true
      }
      scanned.value = true
      page.value = 1
      logAudit('扫描时间胶囊', `发现 ${scanIds.value.length} 个项目的胶囊数据`)
    } catch (e) {
      ui.toast((e as Error).message || '时间胶囊扫描失败，请检查网络或 OSS 配置', 'error')
    } finally {
      scanning.value = false
    }
  })()
  scanInFlight = p
  try {
    await p
  } finally {
    scanInFlight = null
  }
}

/** 点击「扫描时间胶囊文件」：先刷新元数据，再弹出一次性年份选择框（只列出服务器上确有回收站数据的年份，倒序） */
async function openYearPicker() {
  await scanTrashMeta()
  const years = new Set<number>()
  for (const months of Object.values(tasks.trashShardMonths)) {
    for (const m of months) years.add(Number(m.slice(0, 4)))
  }
  // today_trash.json 不分片，只能整体拉取后按年份过滤；无法确定历史年份，至少给出当前年
  if (scanHasUncategorized.value) years.add(CURRENT_YEAR)
  if (!years.size) {
    ui.toast('暂未发现可切换的年份数据', 'ok')
    return
  }
  pickerYears.value = [...years].sort((a, b) => b - a)
  yearPicked.value = viewYear.value
  pickerOpen.value = true
}

/** 年份选择框确认：清理上一年的内存与 IDB 缓存 → 一次性加载该年全部数据进内存 → 自动切到日历图 */
async function confirmYearPick() {
  const year = yearPicked.value
  pickerOpen.value = false
  viewLoading.value = true
  try {
    const res = await tasks.switchTrashYear(year)
    visibleMonths.value = {}
    viewYear.value = year
    viewMonth.value = year === CURRENT_YEAR ? currentMonthKey() : `${year}-01`
    viewMode.value = 'calendar'
    page.value = 1
    if (res.projects === 0 && res.tasks === 0) ui.toast('该年份暂无胶囊数据', 'ok')
  } catch (e) {
    ui.toast((e as Error).message || '切换年份失败，请检查网络或 OSS 配置', 'error')
  } finally {
    viewLoading.value = false
  }
}

/** 切换多视图：数据已按所选年份一次性加载进内存，切换视图只改展示，不触发网络请求 */
function switchView(mode: 'list' | 'calendar' | 'heatmap' | 'trend') {
  viewMode.value = mode
}

/** 日历切换月份：跨年直接忽略（年份只经由「扫描时间胶囊文件」按钮切换；日历组件已有 min/max 钳制） */
function onViewMonthChange(month: string) {
  const y = Number(month.slice(0, 4))
  if (y !== viewYear.value) return
  viewMonth.value = month
}

/** 已完成任务过滤缓存：以回收站数组引用为键（数组整体替换，引用即指纹），避免每次变化都全量 filter */
const completedCache = new WeakMap<Task[], Task[]>()
/** 多视图：已完成胶囊任务（跨所有已加载年份；只统计 status=completed，按 updatedAt 归属日期） */
const completedTrashTasks = computed(() => {
  const out: Task[] = []
  for (const arr of Object.values(tasks.trash)) {
    let cached = completedCache.get(arr)
    if (!cached) {
      cached = arr.filter((t) => t.status === 'completed')
      completedCache.set(arr, cached)
    }
    out.push(...cached)
  }
  return out
})
/** 胶囊外待办过滤缓存：同上，键为活跃任务数组引用 */
const pendingActiveCache = new WeakMap<Task[], Task[]>()
/** 日历图「胶囊外任务」：有开始/提醒时间或重复规则的活跃待办（仅已加载项目的 pending 任务；deleted 不计入） */
const pendingActiveTasks = computed(() => {
  const out: Task[] = []
  for (const arr of Object.values(tasks.tasks)) {
    let cached = pendingActiveCache.get(arr)
    if (!cached) {
      cached = arr.filter((t) => t.status === 'pending' && (!!t.startTime || !!t.reminderTime || !!t.repeat))
      pendingActiveCache.set(arr, cached)
    }
    out.push(...cached)
  }
  return out
})
/** 重复模板（已完成重复任务的后续出现）：扁平列表，供日历图补足今天之后的重复日 */
const repeatMastersForCalendar = computed(() =>
  Object.values(tasks.repeats)
    .flat()
    .map((m) => {
      // 根任务已处理日期（完成/删除）可能只写在根任务上：合并到模板，供日历图跳过已处理的未来重复日
      const rootId = m.rootTaskId ?? m.template.repeatRootId ?? m.id
      const root = tasks.all.find((x) => x.id === rootId)
      return root?.repeatProcessed
        ? { ...m, template: { ...m.template, repeatProcessed: root.repeatProcessed } }
        : m
    }),
)
/** 项目名（多视图组件展示用） */
function projectNameOf(pid: string): string {
  if (!pid || pid === UNCATEGORIZED) return '无分类'
  return projectById(pid)?.name || '未知项目（' + pid.slice(0, 8) + '…）'
}

interface TrashGroup {
  key: string
  label: string
  deleted: boolean
  /** 已删除项目元数据（供「恢复整个项目」使用） */
  deletedProject: DeletedProject | null
  /** 按月份分组（最新在前），包含该年份全部已加载月份 */
  monthGroups: { key: string; tasks: Task[] }[]
  /** 排序键：回收站最新变动时间（ISO），用于项目名倒序；缺失时为空 */
  updatedAt: string
}

/** 各项目回收站排序缓存：以数组引用为键（数组整体替换，引用即指纹），避免分组计算反复 sort */
const trashSortCache = new WeakMap<Task[], Task[]>()
function sortedTrashArr(key: string): Task[] {
  const arr = tasks.trash[key] ?? []
  let sorted = trashSortCache.get(arr)
  if (!sorted) {
    sorted = arr.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    trashSortCache.set(arr, sorted)
  }
  return sorted
}

/** 任务按月份分组（YYYY-MM 倒序，最新在前），以数组引用为键缓存，避免分组计算反复遍历 */
const monthGroupsCache = new WeakMap<Task[], { key: string; tasks: Task[] }[]>()
function toMonthGroups(list: Task[]): { key: string; tasks: Task[] }[] {
  let groups = monthGroupsCache.get(list)
  if (groups) return groups
  const map = new Map<string, Task[]>()
  for (const t of list) {
    const m = dateKeyOf(t.updatedAt || '').slice(0, 7)
    if (m.length !== 7) continue
    const arr = map.get(m) ?? []
    arr.push(t)
    map.set(m, arr)
  }
  groups = [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, tasks]) => ({ key, tasks }))
  monthGroupsCache.set(list, groups)
  return groups
}
/** 月份标签：2026-09 -> 2026年9月 */
function monthLabel(m: string): string {
  const [y, mo] = m.split('-')
  return `${y}年${Number(mo)}月`
}
/** 项目时间胶囊任务总数（所选年份数据已全部载入内存，即该年份真实总数） */
function trashTotal(g: TrashGroup): number {
  return tasks.trash[g.key]?.length ?? 0
}

/** 回收站按项目分组：所选年份数据在进入/切年时已一次性全部加载进内存，直接按内存数据分组展示；
 *  只展示该年份有胶囊任务的项目（活跃 / 已删除 / 未分类 / 孤儿），统一按“回收站最新变动时间”倒序 */
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
    const arr = sortedTrashArr(key)
    // 该年份无胶囊数据（switchTrashYear 只把所选年份数据放进内存）的项目不展示
    if (!arr.length) return
    const monthGroups = toMonthGroups(arr)
    // 排序键：优先扫描到的回收站文件最新变动时间；已删除项目回退到删除时间；
    // 再回退到本地已加载任务的最新时间；全无则为空（排最后，按名称正序）
    const updatedAt =
      scanLatest.value[key] ||
      (deleted && deletedProject ? deletedProject.deletedAt : '') ||
      maxTaskTime(key)
    groups.push({ key, label, deleted, deletedProject, monthGroups, updatedAt })
  }
  // 活跃项目：仅展示该年份内存中有数据的项目
  for (const p of projects.projects) {
    if ((tasks.trash[p.id]?.length ?? 0) > 0) push(p.id, p.name, false, null)
  }
  // 已删除项目：仅展示该年份内存中有数据的项目（仍支持整项目恢复）
  const deletedList = [...(projects.deletedProjects ?? [])].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  for (const dp of deletedList) {
    if ((tasks.trash[dp.id]?.length ?? 0) > 0) push(dp.id, dp.name, true, dp)
  }
  // 未分类回收站（today_trash.json）：切年时已按年份过滤，仅展示有数据的部分
  if ((tasks.trash[UNCATEGORIZED]?.length ?? 0) > 0) push(UNCATEGORIZED, '无分类', false, null)
  // 扫描发现但不在档案中的历史项目（孤儿回收站）
  for (const pid of scanIds.value) {
    if (projects.byId(pid)) continue
    if ((projects.deletedProjects ?? []).some((x) => x.id === pid)) continue
    if ((tasks.trash[pid]?.length ?? 0) > 0) push(pid, `未知项目（${pid.slice(0, 8)}…）`, false, null)
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
  // 搜索过滤：项目名包含关键词，或项目中任务名/内容匹配（该年数据已全部加载，直接全量搜索）
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return groups
  const out: TrashGroup[] = []
  for (const g of groups) {
    if (g.label.toLowerCase().includes(q)) {
      out.push(g)
      continue
    }
    const matched = (tasks.trash[g.key] ?? []).filter((t) => {
      const name = (t.name || '').toLowerCase()
      const desc = (t.description || '').toLowerCase()
      return name.includes(q) || desc.includes(q)
    })
    if (!matched.length) continue
    out.push({
      ...g,
      monthGroups: toMonthGroups(matched.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))),
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
  visibleMonths.value = {}
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

/** 任务开始时间：有提醒时间优先，否则用开始时间 */
function taskStartOf(t: Task): string {
  return t.reminderTime || t.startTime || ''
}

/** 已完成任务耗时：开始（提醒优先）→ 完成时间（updatedAt）；无开始时间无法计算，不显示耗时 */
function durationText(t: Task): string {
  if (t.status !== 'completed') return ''
  const s = taskStartOf(t)
  if (!s) return ''
  const diffMs = new Date(t.updatedAt).getTime() - new Date(s).getTime()
  if (!Number.isFinite(diffMs) || diffMs < 0) return ''
  const mins = Math.round(diffMs / 60000)
  if (mins < 1) return '耗时不足1分钟'
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  const parts: string[] = []
  if (d > 0) parts.push(`${d}天`)
  if (h > 0) parts.push(`${h}小时`)
  if (m > 0 || !parts.length) parts.push(`${m}分钟`)
  return `耗时${parts.join('')}`
}

/** 编辑弹窗：胶囊内任务用胶囊编辑（保留完成/入舱时间），胶囊外待办用普通编辑 */
const editCapsule = ref(true)
/** 日历图点开的待办小块归属日（YYYY-MM-DD）：用于按当天完成对应的重复出现 */
const editCalendarDay = ref<string | null>(null)
/** 日历图点开的待办小块：把「存入时间胶囊」换成「完成该任务」 */
const editCalendarComplete = ref(false)

/** 查找某 id 对应的重复模板 master（repeats 中 template.id 匹配）；非模板返回 undefined */
function findMasterByTemplateId(taskId: string) {
  for (const pid of Object.keys(tasks.repeats)) {
    const m = (tasks.repeats[pid] ?? []).find((x) => x.template.id === taskId)
    if (m) return m
  }
  return undefined
}

/** 打开任务编辑弹窗（任务详情页已废弃：列表/日历点击任务都直接进编辑） */
function openEdit(t: Task, day?: string) {
  editTask.value = t
  editCapsule.value = t.status !== 'pending'
  // 日历图点开的「未来重复日」小块（重复模板）：编辑保存走未来任务流程
  editTemplateMasterId.value = findMasterByTemplateId(t.id)?.id ?? null
  // 日历图点开的待办小块归属日：待办小块显示「完成该任务」按当天完成
  editCalendarDay.value = day ?? null
  editCalendarComplete.value = !!day && t.status === 'pending'
  editOpen.value = true
}

/** 编辑保存成功：关闭弹窗并提示 */
function onSaved(task: Task) {
  editOpen.value = false
  editTask.value = null
  editTemplateMasterId.value = null
  editCalendarDay.value = null
  editCalendarComplete.value = false
  ui.toast(task.status === 'pending' ? '任务已保存' : '已保存到时间胶囊')
}

/** 日历图「完成该任务」：按当天完成对应的重复出现（只影响该天，不动其它未来日与已完成日） */
async function onCalendarComplete(task: Task) {
  const day = editCalendarDay.value
  editOpen.value = false
  editTask.value = null
  editTemplateMasterId.value = null
  editCalendarDay.value = null
  editCalendarComplete.value = false
  if (!day) return
  const ok = await tasks.completeFutureOccurrence(task.id, day)
  if (ok) ui.toast('任务已完成')
}
</script>

<template>
  <div class="p-4 sm:p-6 max-w-3xl mx-auto">
    <div class="hidden lg:flex items-center gap-2.5">
      <span class="w-9 h-9 rounded-lg bg-white border border-slate-200 text-brand flex items-center justify-center shrink-0">
        <AppIcon name="trash" :size="18" />
      </span>
      <h1 class="text-xl font-bold text-slate-800">时间胶囊</h1>
    </div>
    <div class="mt-0.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div class="text-xs text-slate-400 leading-relaxed">把过去完成删除的时间任务存入胶囊封印起来，减少数据加载带来的性能</div>
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
          :disabled="scanning || viewLoading"
          @click="openYearPicker"
        >
          <AppIcon name="search" :size="13" class="text-slate-500" />
          {{ scanning ? '扫描中…' : '扫描时间胶囊文件' }}
        </button>
      </div>
      <input ref="fileInput" type="file" accept=".zip,.json,application/json,application/zip" class="hidden" @change="onImportFile" />
    </div>

    <!-- 多视图切换：项目（默认）/ 日历 / 热力图 / 趋势 -->
    <div class="mt-3 flex flex-wrap items-center gap-1.5">
      <button
        v-for="tab in VIEW_TABS"
        :key="tab.key"
        class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
        :class="viewMode === tab.key ? 'bg-brand text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'"
        :disabled="viewLoading"
        @click="switchView(tab.key)"
      >
        <AppIcon :name="tab.icon" :size="14" />
        {{ tab.label }}
      </button>
    </div>

    <!-- 项目视图：搜索 + 按项目分组（默认视图） -->
    <div v-if="viewMode === 'list'">
    <!-- 搜索：项目名 + 已加载项目的任务名/内容 -->
    <div class="mt-4">
      <div class="relative">
        <AppIcon name="search" :size="15" class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          v-model="searchInput"
          type="text"
          placeholder="搜索项目名 / 任务名 / 任务内容"
          class="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand focus:outline-none"
        />
      </div>
      <div v-if="searching" class="mt-1.5 text-[11px] text-slate-400">
        所选年份数据已全部加载，可直接搜索
      </div>
    </div>

    <div v-if="!projectGroups.length" class="mt-4 py-16 text-center text-sm text-slate-400">
      <template v-if="searching">未找到匹配的时间胶囊记录</template>
      <template v-else>该年份暂无胶囊数据，可点击右上角「扫描时间胶囊文件」切换年份</template>
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
          <span class="shrink-0 text-[11px] text-slate-400">（{{ trashTotal(g) }}）</span>
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
        <div v-for="mg in visibleMonthGroups(g)" :key="mg.key">
            <div class="px-0.5 pt-1 pb-0.5 text-xs font-medium text-slate-500">
              {{ monthLabel(mg.key) }} · {{ mg.tasks.length }} 条
            </div>
            <div class="space-y-2">
              <div
                v-for="t in mg.tasks"
                :key="t.id"
                v-memo="[t.id, t.name, t.status, t.updatedAt, t.projectId]"
                class="cursor-pointer bg-white rounded-lg border border-slate-200 p-4 flex items-center gap-3 hover:bg-slate-50/60"
                title="点击编辑该任务"
                @click="openEdit(t)"
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
                  <span
                    v-if="durationText(t)"
                    class="shrink-0 rounded-full border border-slate-100 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-400"
                    :title="`开始：${taskStartOf(t).slice(0, 16)} → 完成：${t.updatedAt.slice(0, 16)}`"
                  >
                    {{ durationText(t) }}
                  </span>
                </div>
                <div class="mt-1 flex flex-wrap gap-x-4 text-[11px] text-slate-400">
                  <span>{{ t.projectId ? (projectOf(t.projectId)?.name ?? '未知项目') : '无分类' }}</span>
                  <span>{{ formatTodayTitle(t.updatedAt) }}</span>
                </div>
              </div>
              <button
                class="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-slate-600 border border-slate-200 hover:bg-slate-50 shrink-0"
                title="编辑任务"
                @click.stop="openEdit(t)"
              >
                <AppIcon name="edit" :size="13" class="shrink-0" />
                编辑
              </button>
              <button
                class="px-3 py-1.5 rounded-lg text-xs text-brand border border-brand/30 hover:bg-brand/5 shrink-0"
                @click.stop="restore(t)"
              >
                恢复
              </button>
              <button
                class="px-3 py-1.5 rounded-lg text-xs text-red-500 border border-red-200 hover:bg-red-50 shrink-0"
                @click.stop="askDelete(t)"
              >
                永久删除
              </button>
            </div>
            </div>
        </div>
        <button
          v-if="(visibleMonths[g.key] ?? MONTHS_VISIBLE) < g.monthGroups.length"
          class="mt-1 w-full py-2 rounded-lg text-xs text-brand border border-brand/30 hover:bg-brand/5"
          @click="loadMoreGroup(g.key)"
        >
          <AppIcon name="chevron-down" :size="13" class="inline-block -mt-0.5 mr-1" />
          加载更早月份
        </button>
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
    </div>

    <!-- 多视图：日历 / 热力图 / 趋势（数据为当前所选年份，切换视图不触发网络请求） -->
    <div v-else class="mt-4">
      <div v-if="viewLoading" class="flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white py-16 text-sm text-slate-500">
        <AppIcon name="refresh" :size="16" class="animate-spin text-brand" />
        正在下载OSS数据并进行本地计算中......
      </div>
      <template v-else>
        <div class="mb-3 text-[11px] text-slate-400">当前展示 {{ viewYear }} 年数据；切换年份请点击「扫描时间胶囊文件」。</div>
        <TimeCapsuleCalendar
          v-if="viewMode === 'calendar'"
          :tasks="completedTrashTasks"
          :pending="pendingActiveTasks"
          :repeats="repeatMastersForCalendar"
          :month="viewMonth"
          :min-month="viewYear + '-01'"
          :max-month="viewYear + '-12'"
          :project-name="projectNameOf"
          @change-month="onViewMonthChange"
          @open-task="openEdit"
        />
        <TimeCapsuleHeatmap
          v-else-if="viewMode === 'heatmap'"
          :tasks="completedTrashTasks"
          :year="viewYear"
        />
        <TimeCapsuleTrend
          v-else-if="viewMode === 'trend'"
          :tasks="completedTrashTasks"
          :year="viewYear"
        />
      </template>
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

    <!-- 年份选择弹窗：一次性选择，确认后关闭并切年 -->
    <div
      v-if="pickerOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      @click.self="pickerOpen = false"
    >
      <div class="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <div class="text-base font-semibold text-slate-800">选择胶囊年份</div>
        <div class="mt-1 text-xs text-slate-400">切换后将只加载该年数据并自动切换到日历图</div>
        <div class="mt-4 grid grid-cols-4 gap-2">
          <button
            v-for="y in pickerYears"
            :key="y"
            class="rounded-lg border px-2 py-2 text-sm"
            :class="y === yearPicked ? 'bg-brand text-white border-brand' : 'border-slate-200 text-slate-600 hover:bg-slate-50'"
            @click="yearPicked = y"
          >
            {{ y }}
          </button>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <button class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600" @click="pickerOpen = false">取消</button>
          <button class="px-3 py-1.5 rounded-lg bg-brand text-white" :disabled="!!viewLoading" @click="confirmYearPick">确认切换</button>
        </div>
      </div>
    </div>

    <TaskModal
      v-model:open="editOpen"
      :task="editTask"
      :capsule-edit="editCapsule"
      :template-master-id="editTemplateMasterId"
      :calendar-complete="editCalendarComplete"
      @saved="onSaved"
      @complete="onCalendarComplete"
    />
  </div>
</template>
